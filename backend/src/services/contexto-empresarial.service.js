'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const identidadeRepo = require('../repositories/identidade.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const token = require('../security/token');

/**
 * Contexto empresarial a partir da sessão global (Autenticação Global —
 * Pacote 4): listar as empresas autorizadas de uma identidade, SELECIONAR
 * (ou TROCAR) a empresa criando a sessão empresarial, e encerrar tudo.
 *
 * A REGRA CENTRAL: a sessão global identifica a pessoa; o acesso a uma
 * empresa só existe depois que ESTE serviço revalida, no servidor e dentro
 * de uma transação, que (1) a identidade continua ativa, (2) existe um
 * vínculo ATIVO dessa identidade NA empresa pedida e (3) a empresa está
 * ativa. O `empresaId` vindo do navegador é só uma escolha entre as opções
 * que o servidor já conhece — nunca uma autoridade
 * (`usuarioRepo.buscarVinculoAtivoDaIdentidade` devolve null para qualquer
 * coisa fora disso, e a resposta é sempre a mesma: 403 genérico).
 *
 * A SESSÃO EMPRESARIAL É A DE SEMPRE: `sessoes` (013), o mesmo contrato
 * empresa_id + usuario_id que exigirSessao, o RBAC e todos os módulos já
 * leem — nenhum mecanismo paralelo. Só duas marcas a mais na linha:
 * autenticado_via = 'SESSAO_GLOBAL' (formato já previsto pela 013) e
 * sessao_global_id (037), que diz de qual login global ela nasceu.
 *
 * TROCA DE EMPRESA = seleção com uma sessão empresarial anterior em mãos:
 * a anterior é revogada (TROCA_EMPRESA) na MESMA transação que cria a nova
 * — nunca duas sessões empresariais vivas nascidas do mesmo login global.
 * Nada do contexto anterior é transportado: a nova sessão é criada do zero
 * a partir do vínculo revalidado.
 *
 * SAIR: "sair da empresa" é o POST /api/auth/logout já existente (revoga
 * só `sessoes`, mantém a global — permite reselecionar sem senha). "Sair
 * completamente" é `encerrarTudo`: revoga a global E as sessões
 * empresariais que nasceram dela (LOGOUT_GLOBAL), na mesma transação.
 *
 * Não há aqui autorização por perfil, nem RBAC: MASTER, ADMINISTRADOR,
 * SUPERVISOR e USUARIO passam pelo mesmo caminho; o que muda entre eles são
 * as permissões decididas depois, por requisição, pelo middleware de
 * autorização já existente.
 */

const MINUTOS_PARA_MS = 60_000;
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const AUTENTICADO_VIA = 'SESSAO_GLOBAL';
const MOTIVO = Object.freeze({
  TROCA_EMPRESA: 'TROCA_EMPRESA',
  LOGOUT_GLOBAL: 'LOGOUT_GLOBAL',
  LOGOUT: 'LOGOUT',
  NOVO_LOGIN: 'NOVO_LOGIN_GLOBAL',
  LOGIN_INCOMPLETO: 'LOGIN_INCOMPLETO',
});
const MSG = Object.freeze({
  SESSAO_INVALIDA: 'Sessão inválida ou expirada',
  EMPRESA_NAO_AUTORIZADA: 'Empresa não autorizada para esta identidade',
});

function prepararCampoOpcional(valor, tamanhoMaximo, nomeCampo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${nomeCampo} deve ser string ou ausente`);
  }
  return valor.length > tamanhoMaximo ? valor.slice(0, tamanhoMaximo) : valor;
}

function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirIdSessao(valor, nome) {
  if (typeof valor !== 'string' || !/^[1-9][0-9]*$/.test(valor)) {
    throw new TypeError(`${nome} inválido`);
  }
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

async function buscarInstanteReal(client) {
  const { rows } = await client.query('SELECT clock_timestamp() AS agora');
  return rows[0].agora;
}

const resumoEmpresaAutorizada = (v) => ({
  id: v.empresa.id,
  nome: v.empresa.nome,
  cnpj: v.empresa.cnpj,
  perfil: v.perfil,
});

/**
 * Empresas em que a identidade tem vínculo ativo (e que estão ativas).
 * Somente essas podem ser selecionadas; a lista é o que a tela "Selecione
 * sua empresa" mostra.
 */
async function listarEmpresas(pool, { identidadeId }) {
  exigirInteiroPositivo(identidadeId, 'identificador de identidade');
  const vinculos = await usuarioRepo.listarVinculosAtivosDaIdentidade(pool, identidadeId);
  return vinculos.map(resumoEmpresaAutorizada);
}

/**
 * Seleciona (ou troca para) a empresa `empresaId`, criando a sessão
 * empresarial. `sessaoEmpresarialAnterior` ({empresaId, sessaoId}|null) é
 * a sessão do cookie empresarial que a requisição já trazia, resolvida
 * pelo controller via buscarContextoSessao — revogada aqui, na mesma
 * transação, seja qual for a identidade dona dela (posse do cookie é
 * autoridade para encerrá-lo, exatamente como no logout).
 *
 * @returns {Promise<{usuario: object, empresa: object, sessao: {id:string, expiraEm:Date}, token: string}>}
 */
async function selecionar(pool, {
  identidadeId, sessaoGlobalId, empresaId, sessaoEmpresarialAnterior = null, ip = null, dispositivo = null,
}) {
  exigirInteiroPositivo(identidadeId, 'identificador de identidade');
  exigirIdSessao(sessaoGlobalId, 'identificador de sessão global');
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  const ipP = prepararCampoOpcional(ip, TAMANHO_MAXIMO_IP, 'ip');
  const dispositivoP = prepararCampoOpcional(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO, 'dispositivo');

  return emTransacao(pool, async (client) => {
    // (1) identidade continua ativa — reconfirmado dentro da transação,
    // mesmo que o middleware já tenha validado a sessão global há instantes.
    const identidade = await identidadeRepo.buscarPorId(client, identidadeId);
    if (identidade === null || identidade.ativo !== true) {
      throw HttpError.unauthorized('SESSAO_INVALIDA', MSG.SESSAO_INVALIDA);
    }

    // Serializa seleções concorrentes do MESMO login global (duas abas) e
    // confirma que a sessão global não foi revogada/expirada desde o
    // middleware. Com o lock, "uma única sessão empresarial viva por
    // sessão global" vale mesmo sob concorrência.
    if (!(await sessaoGlobalRepo.bloquearValida(client, sessaoGlobalId))) {
      throw HttpError.unauthorized('SESSAO_INVALIDA', MSG.SESSAO_INVALIDA);
    }

    // (2)+(3) vínculo ativo desta identidade nesta empresa ativa — ou nada.
    const vinculo = await usuarioRepo.buscarVinculoAtivoDaIdentidade(client, identidadeId, empresaId);
    if (vinculo === null) {
      throw HttpError.forbidden('EMPRESA_NAO_AUTORIZADA', MSG.EMPRESA_NAO_AUTORIZADA);
    }

    // Troca: TODA sessão empresarial ainda viva nascida deste login global
    // é revogada (não só a do cookie desta aba), e também a do cookie, se
    // ela veio de outro login. Mesma transação da criação da nova.
    await sessaoRepo.revogarDaSessaoGlobal(client, sessaoGlobalId, MOTIVO.TROCA_EMPRESA);
    if (sessaoEmpresarialAnterior !== null) {
      await sessaoRepo.revogar(client, sessaoEmpresarialAnterior.empresaId, sessaoEmpresarialAnterior.sessaoId, MOTIVO.TROCA_EMPRESA);
    }

    const agora = await buscarInstanteReal(client);
    const expiraEm = new Date(agora.getTime() + authConfig.sessao.expiracaoMinutos * MINUTOS_PARA_MS);
    const tokenClaro = token.gerarTokenSessao();
    const tokenHash = token.hashTokenSessao(tokenClaro);

    const sessaoId = await sessaoRepo.criar(client, {
      empresaId: vinculo.empresa.id,
      usuarioId: vinculo.usuarioId,
      tokenHash,
      expiraEm,
      autenticadoVia: AUTENTICADO_VIA,
      ip: ipP,
      dispositivo: dispositivoP,
      sessaoGlobalId,
    });

    return {
      usuario: { id: vinculo.usuarioId, nome: vinculo.nome, email: identidade.email, perfil: vinculo.perfil },
      empresa: { id: vinculo.empresa.id, nome: vinculo.empresa.nome, cnpj: vinculo.empresa.cnpj },
      sessao: { id: sessaoId, expiraEm },
      token: tokenClaro,
    };
  });
}

/**
 * Depois do login global: lista as empresas e, se houver EXATAMENTE uma,
 * seleciona-a automaticamente (cenário A). Zero (C) ou várias (B) devolvem
 * `contexto: null` — a tela decide o que mostrar; nada é selecionado por
 * conta própria.
 */
async function resolverAposLogin(pool, { identidadeId, sessaoGlobalId, ip = null, dispositivo = null }) {
  const empresas = await listarEmpresas(pool, { identidadeId });
  if (empresas.length !== 1) {
    return { empresas, contexto: null };
  }
  const contexto = await selecionar(pool, {
    identidadeId, sessaoGlobalId, empresaId: empresas[0].id, sessaoEmpresarialAnterior: null, ip, dispositivo,
  });
  return { empresas, contexto };
}

/**
 * Encerra sessões que a requisição já trazia ANTES de um novo login global
 * (uma sessão global anterior e/ou uma sessão empresarial anterior, de
 * qualquer identidade): um login novo nunca deixa cookies de outra pessoa
 * — ou de um login antigo — utilizáveis no mesmo navegador. Idempotente.
 */
async function encerrarAnteriores(pool, { sessaoGlobalAnterior = null, sessaoEmpresarialAnterior = null }) {
  if (sessaoGlobalAnterior === null && sessaoEmpresarialAnterior === null) {
    return;
  }
  await emTransacao(pool, async (client) => {
    if (sessaoGlobalAnterior !== null) {
      await sessaoRepo.revogarDaSessaoGlobal(client, sessaoGlobalAnterior.sessaoId, MOTIVO.NOVO_LOGIN);
      await sessaoGlobalRepo.revogar(client, sessaoGlobalAnterior.sessaoId, MOTIVO.NOVO_LOGIN);
    }
    if (sessaoEmpresarialAnterior !== null) {
      await sessaoRepo.revogar(client, sessaoEmpresarialAnterior.empresaId, sessaoEmpresarialAnterior.sessaoId, MOTIVO.NOVO_LOGIN);
    }
  });
}

/**
 * "Sair completamente": revoga a sessão global e todas as sessões
 * empresariais nascidas dela, numa única transação. Uma sessão
 * empresarial que a requisição traga e que NÃO tenha nascido desta global
 * (cookie de outro login) também é revogada, se informada — posse do
 * cookie é autoridade para encerrá-lo.
 */
async function encerrarTudo(pool, { sessaoGlobalId, sessaoEmpresarialAtual = null }) {
  exigirIdSessao(sessaoGlobalId, 'identificador de sessão global');
  return emTransacao(pool, async (client) => {
    const empresariais = await sessaoRepo.revogarDaSessaoGlobal(client, sessaoGlobalId, MOTIVO.LOGOUT_GLOBAL);
    if (sessaoEmpresarialAtual !== null) {
      await sessaoRepo.revogar(client, sessaoEmpresarialAtual.empresaId, sessaoEmpresarialAtual.sessaoId, MOTIVO.LOGOUT);
    }
    const global = await sessaoGlobalRepo.revogar(client, sessaoGlobalId, MOTIVO.LOGOUT);
    return { global, empresariais };
  });
}

/**
 * COMPENSAÇÃO do login global (correção pós-auditoria do Pacote 4, item 2):
 * a autenticação já criou e COMMITOU a sessão global, mas algo depois dela
 * (seleção automática, substituição das sessões anteriores) falhou antes de
 * o cookie ser entregue. Revoga a sessão global nova e toda sessão
 * empresarial nascida dela (motivo LOGIN_INCOMPLETO), numa transação — uma
 * sessão válida sem cookie no navegador nunca sobrevive.
 *
 * Nunca mascara o erro original: se a própria compensação falhar (banco
 * indisponível, por exemplo), registra um log técnico mínimo — só o
 * identificador interno da sessão e o código, nunca token — e retorna; o
 * chamador relança o erro ORIGINAL. Nesse cenário extremo a sessão órfã
 * continua sem cookie algum (o token só existiu na memória desta
 * requisição) e expira pela inatividade configurada.
 */
async function compensarLoginIncompleto(pool, { sessaoGlobalId }) {
  exigirIdSessao(sessaoGlobalId, 'identificador de sessão global');
  try {
    await emTransacao(pool, async (client) => {
      await sessaoRepo.revogarDaSessaoGlobal(client, sessaoGlobalId, MOTIVO.LOGIN_INCOMPLETO);
      await sessaoGlobalRepo.revogar(client, sessaoGlobalId, MOTIVO.LOGIN_INCOMPLETO);
    });
    return true;
  } catch (erro) {
    console.error('[login-global] compensação de login incompleto falhou', {
      sessaoGlobalId,
      codigo: typeof erro?.code === 'string' ? erro.code : 'DESCONHECIDO',
    });
    return false;
  }
}

module.exports = {
  compensarLoginIncompleto,
  listarEmpresas,
  selecionar,
  resolverAposLogin,
  encerrarAnteriores,
  encerrarTudo,
  AUTENTICADO_VIA,
  MOTIVO,
};
