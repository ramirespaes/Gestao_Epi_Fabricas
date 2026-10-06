'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const autoridade = require('./autoridade-administrativa');
const cooldown = require('../security/cooldown');
const repo = require('../repositories/usuario-administracao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const identidadeRepo = require('../repositories/identidade.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const usuarioIpRepo = require('../repositories/usuario-ip.repository');
const copiaAcesso = require('./copia-acesso.service');
const redefinicaoRepo = require('../repositories/redefinicao-senha.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const { normalizarIp } = require('../utils/ip');
const grupoAcessoRepo = require('../repositories/grupo-acesso.repository');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');
const senhaProvisoriaUtil = require('../utils/senha-provisoria');
const { mascararCpf } = require('../utils/normalizacao');

/**
 * Administração de usuários da empresa (Bloco 9, parte F): listar,
 * consultar, alterar nome e perfil, inativar e reativar.
 *
 * AUTORIDADE (D2): o ponto único de autoridade-administrativa.js, ação
 * GERENCIAR_USUARIOS (047). MASTER ativo por perfil, ou ADMINISTRADOR
 * ativo com autorização individual própria. Nenhum atalho por perfil aqui.
 *
 * PERFIS (D3): só o MASTER gerencia MASTER e ADMINISTRADOR. O
 * ADMINISTRADOR autorizado gerencia apenas SUPERVISOR e USUARIO, tanto o
 * perfil atual do alvo quanto o perfil novo.
 *
 * ÚLTIMO MASTER: tirar a condição de MASTER ativo de alguém (inativar ou
 * mudar o perfil) exige que reste outro MASTER ativo. Duas travas, nesta
 * ordem, em toda escrita: uma trava consultiva por empresa, que põe em
 * fila as escritas de usuários da mesma empresa (sem ciclo de espera entre
 * elas), e o FOR UPDATE de todos os MASTERs ativos antes de contar.
 *
 * ISOLAMENTO: a empresa vem da sessão. Usuário de outra empresa responde
 * 404 idêntico ao inexistente. A auditoria anda na mesma transação e
 * guarda só o campo que mudou.
 */

const PERFIL_MASTER = 'MASTER';
const PERFIS_DO_MASTER = Object.freeze(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
const PERFIS_DO_ADMINISTRADOR = Object.freeze(['SUPERVISOR', 'USUARIO']);
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const ORIGEM_AUDITORIA = Object.freeze({ origem: 'administracao_usuarios' });

const ACAO = Object.freeze({
  CRIADO: 'USUARIO_CRIADO',
  ALTERADO: 'USUARIO_ALTERADO',
  PERFIL_ALTERADO: 'USUARIO_PERFIL_ALTERADO',
  INATIVADO: 'USUARIO_INATIVADO',
  REATIVADO: 'USUARIO_REATIVADO',
  DADOS_ALTERADOS: 'USUARIO_DADOS_ALTERADOS',
  EMAIL_ALTERADO: 'USUARIO_EMAIL_ALTERADO',
  DADOS_CONSULTADOS: 'USUARIO_DADOS_CONSULTADOS',
  SENHA_REDEFINIDA: 'REDEFINICAO_ADMINISTRATIVA_SENHA',
});
const MOTIVO_REDEFINICAO_ADMIN = 'REDEFINICAO_ADMINISTRATIVA';
const MOTIVO_EMAIL = 'EMAIL_ALTERADO';

const ERRO = Object.freeze({
  NAO_AUTORIZADO: ['USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', 'Sem autoridade para administrar os usuários da empresa'],
  PERFIL: ['USUARIO_PERFIL_NAO_PERMITIDO', 'Somente o MASTER gerencia usuários MASTER e ADMINISTRADOR'],
  NAO_ENCONTRADO: ['USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado'],
  JA_INATIVO: ['USUARIO_JA_INATIVO', 'O usuário já está inativo'],
  JA_ATIVO: ['USUARIO_JA_ATIVO', 'O usuário já está ativo'],
  ULTIMO_MASTER: ['USUARIO_ULTIMO_MASTER', 'A empresa precisa continuar com pelo menos um MASTER ativo'],
  EMAIL_EXISTENTE: ['IDENTIDADE_EMAIL_JA_EXISTENTE', 'Este e-mail já possui conta de acesso'],
  VINCULO_EXISTENTE: ['USUARIO_VINCULO_EXISTENTE', 'Este e-mail já tem acesso nesta empresa'],
  CPF_EXISTENTE: ['IDENTIDADE_CPF_JA_EXISTENTE', 'Este CPF já possui conta de acesso'],
  MATRICULA_EXISTENTE: ['USUARIO_MATRICULA_JA_EXISTENTE', 'Esta matrícula já está em uso nesta empresa'],
  GRUPO_NAO_ENCONTRADO: ['GRUPO_NAO_ENCONTRADO', 'Grupo de acesso não encontrado'],
  GRUPO_INATIVO: ['GRUPO_INATIVO', 'Grupo inativo não recebe novos vínculos'],
  // O mesmo código do vínculo de grupo (grupo-usuario.service.js): MASTER não tem grupo.
  SENHA_PROPRIA: ['USUARIO_SENHA_PROPRIA', 'A própria senha é alterada nas Configurações'],
  SEM_IDENTIDADE: ['USUARIO_SEM_IDENTIDADE', 'Este usuário não tem conta de acesso para redefinir'],
  SENHA_COMPARTILHADA: ['SENHA_IDENTIDADE_COMPARTILHADA', 'Esta pessoa tem acesso a outras empresas: use a recuperação de senha por e-mail'],
  MASTER_SO_PAINEL: ['MASTER_SOMENTE_PELO_PAINEL_PRIVADO', 'O Master da empresa só é criado pelo Painel Privado'],
  MASTER_PERFIL_FIXO: ['USUARIO_MASTER_PERFIL_FIXO', 'O perfil do Master não é alterado por esta tela'],
  MODELO_MASTER: ['USUARIO_MODELO_MASTER', 'O Master não pode ser usado como modelo de acesso'],
  MODELO_NAO_ENCONTRADO: ['USUARIO_MODELO_NAO_ENCONTRADO', 'Usuário modelo não encontrado'],
  IP_TRANCARIA: ['IP_TRANCARIA_O_PROPRIO_ATOR', 'A lista não inclui o endereço de onde você está acessando'],
  EMAIL_COMPARTILHADO: ['EMAIL_IDENTIDADE_COMPARTILHADA', 'Esta pessoa tem acesso a outras empresas: o e-mail de login não pode ser alterado por aqui'],
  MASTER_SEM_GRUPO: ['USUARIO_MASTER_SEM_GRUPO', 'Usuário MASTER não é vinculado a grupo de acesso'],
});
const CAMPO_SENHA_PROVISORIA = 'body.senhaProvisoria';
const ORIGEM_CRIACAO_DIRETA = 'CRIACAO_DIRETA';
const CPF_CANONICO = /^[0-9]{11}$/;
const CONSTRAINT_CPF = 'uq_identidades_cpf';
const CONSTRAINT_MATRICULA = 'uq_usuarios_empresa_matricula';
const VIOLACAO_UNICIDADE = '23505';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function cortar(valor, tamanhoMaximo) {
  if (typeof valor !== 'string') {
    return null;
  }
  return valor.length > tamanhoMaximo ? valor.slice(0, tamanhoMaximo) : valor;
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

/** Não é segredo: SHA-256 simples, como a trava de criação de convite. */
function travaDaEmpresa(empresaId) {
  const digest = crypto.createHash('sha256').update(`USUARIOS_ADMINISTRACAO\n${empresaId}`, 'utf8').digest('hex');
  return cooldown.derivarAdvisoryLock64(digest);
}

function perfisGerenciaveis(ator) {
  return ator.perfil === PERFIL_MASTER ? PERFIS_DO_MASTER : PERFIS_DO_ADMINISTRADOR;
}

function exigirPerfilGerenciavel(ator, perfil) {
  if (!perfisGerenciaveis(ator).includes(perfil)) {
    throw HttpError.forbidden(...ERRO.PERFIL);
  }
}

const apresentar = (usuario, ator) => ({
  ...usuario,
  podeGerenciar: perfisGerenciaveis(ator).includes(usuario.perfil),
  // MASTER: perfil fixo (único por empresa, só pelo Painel Privado); a tela não o oferece como destino nem como modelo.
  perfilFixo: usuario.perfil === PERFIL_MASTER,
  proprio: usuario.id === ator.id,
});

const exigirLeitura = (pool, empresaId, atorId) => autoridade.exigirAutoridadeAdministrativaLeitura(
  pool, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
);

async function listar(pool, {
  empresaId, atorId, busca = null, situacao = null, perfil = null, ordem = 'nome', pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const ator = await exigirLeitura(pool, empresaId, atorId);

  const { usuarios, total } = await repo.listar(pool, empresaId, {
    busca, situacao, perfil, ordem, pagina, limite,
  });
  const mastersAtivos = await repo.contarMastersAtivos(pool, empresaId);

  return {
    usuarios: usuarios.map((usuario) => apresentar(usuario, ator)),
    total,
    pagina,
    limite,
    paginas: Math.ceil(total / limite),
    mastersAtivos,
    perfisGerenciaveis: [...perfisGerenciaveis(ator)],
    // O que esta tela pode CADASTRAR ou atribuir: nunca MASTER (único por empresa, só pelo Painel Privado).
    perfisCadastraveis: perfisGerenciaveis(ator).filter((p) => p !== PERFIL_MASTER),
  };
}

async function buscar(pool, { empresaId, atorId, usuarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  const ator = await exigirLeitura(pool, empresaId, atorId);
  const usuario = await repo.buscarPorId(pool, empresaId, usuarioId);
  if (usuario === null) {
    throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
  }
  return apresentar(usuario, ator);
}

/**
 * Esqueleto comum das escritas: trava da empresa, autoridade (com o ator
 * travado), alvo travado e na mesma empresa, e D3 sobre o perfil atual do
 * alvo. `operacao` decide o resto dentro da mesma transação.
 */
async function escrever(pool, { empresaId, atorId, usuarioId }, operacao) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');

  return emTransacao(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [travaDaEmpresa(empresaId)]);
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    const alvo = await repo.buscarParaAtualizacao(client, empresaId, usuarioId);
    if (alvo === null) {
      throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
    }
    exigirPerfilGerenciavel(ator, alvo.perfil);
    return operacao(client, ator, alvo);
  });
}

/** Antes de o alvo deixar de ser MASTER ativo: precisa restar outro. */
async function exigirOutroMasterAtivo(client, empresaId, alvo) {
  const masters = await repo.travarMastersAtivos(client, empresaId);
  if (!masters.some((id) => id !== alvo.id)) {
    throw HttpError.conflict(...ERRO.ULTIMO_MASTER);
  }
}

const deixaDeSerMasterAtivo = (alvo) => alvo.perfil === PERFIL_MASTER && alvo.ativo === true;

async function registrar(client, { empresaId, atorId, acao, alvoId, ip, dispositivo, antes, depois }) {
  await auditoriaRepo.registrar(client, {
    empresaId,
    usuarioId: atorId,
    acao,
    referencia: String(alvoId),
    ip: cortar(ip, TAMANHO_MAXIMO_IP),
    dispositivo: cortar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO),
    contexto: { ...ORIGEM_AUDITORIA },
    dadosAnteriores: antes,
    dadosNovos: depois,
  });
}

function exigirTextoObrigatorio(valor, nome) {
  if (typeof valor !== 'string' || valor.trim().length === 0 || valor.trim() !== valor) {
    throw new TypeError(`${nome} inválida`);
  }
}

/**
 * Criação DIRETA de usuário ADMINISTRATIVO na empresa da sessão (Gestão de
 * Usuários), sem convite e sem e-mail: identidade nova com CPF (075: único
 * no sistema, imutável depois) e senha PROVISÓRIA (hash Argon2id, política
 * completa com o e-mail como contexto, validade de 48 h ou 72 h na sexta, no
 * fuso operacional); vínculo com o perfil permitido ao ator (D3), matrícula
 * (única na empresa), setor, horário informativo e grupo (existente, ativo,
 * da mesma empresa; nunca para MASTER); IPs permitidos (077) na mesma
 * transação — ou tudo, ou nada. E-mail ou CPF que já existem são 409: a
 * senha de quem já existe nunca é tocada e nenhum convite nasce daqui. A
 * senha só existe como hash; CPF e IPs nunca entram na auditoria.
 *
 * @returns {Promise<{usuario: object, senhaProvisoriaExpiraEm: Date, administrativo: object}>}
 */
async function criar(pool, {
  empresaId, atorId, nome, email, perfil, senhaProvisoria, cpf, matricula, setor,
  horarioTrabalho = null, ipsPermitidos = [], grupoAcessoId = null, usuarioModeloId = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'empresa');
  exigirId(atorId, 'ator');
  if (typeof senhaProvisoria !== 'string' || senhaProvisoria.length === 0) {
    throw new TypeError('senha provisória inválida');
  }
  if (typeof cpf !== 'string' || !CPF_CANONICO.test(cpf)) {
    throw new TypeError('CPF deve chegar canônico');
  }
  exigirTextoObrigatorio(matricula, 'matrícula');
  exigirTextoObrigatorio(setor, 'setor');
  if (!Array.isArray(ipsPermitidos)) {
    throw new TypeError('IPs permitidos inválidos');
  }
  if (grupoAcessoId !== null) {
    exigirId(grupoAcessoId, 'grupo de acesso');
  }
  const ips = [...new Set(ipsPermitidos)];

  return emTransacao(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [travaDaEmpresa(empresaId)]);
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    exigirPerfilGerenciavel(ator, perfil);
    // O MASTER é único por empresa e só nasce pelo Painel Privado: nunca por aqui (nem por duplicação).
    if (perfil === PERFIL_MASTER) {
      throw HttpError.conflict(...ERRO.MASTER_SO_PAINEL);
    }

    const politica = passwordPolicy.validarPoliticaSenha(senhaProvisoria, { email });
    if (!politica.ok) {
      throw HttpError.validacao(politica.erros.map((e) => ({ campo: CAMPO_SENHA_PROVISORIA, codigo: e.codigo, mensagem: e.mensagem })));
    }
    if ((await identidadeRepo.buscarPorEmail(client, email)) !== null) {
      throw HttpError.conflict(...ERRO.EMAIL_EXISTENTE);
    }
    if ((await repo.buscarVinculoPorEmail(client, empresaId, email)) !== null) {
      throw HttpError.conflict(...ERRO.VINCULO_EXISTENTE);
    }
    if ((await identidadeRepo.buscarPorCpf(client, cpf)) !== null) {
      throw HttpError.conflict(...ERRO.CPF_EXISTENTE);
    }
    if (await usuarioRepo.existeMatricula(client, empresaId, matricula)) {
      throw HttpError.conflict(...ERRO.MATRICULA_EXISTENTE);
    }
    if (grupoAcessoId !== null) {
      // Só da empresa da sessão: o de outra empresa é "não encontrado", como o inexistente.
      const grupo = await grupoAcessoRepo.buscarPorId(client, empresaId, grupoAcessoId);
      if (grupo === null) {
        throw HttpError.notFound(...ERRO.GRUPO_NAO_ENCONTRADO);
      }
      if (grupo.ativo !== true) {
        throw HttpError.conflict(...ERRO.GRUPO_INATIVO);
      }
    }

    const senhaHash = await password.gerarHashSenha(senhaProvisoria);
    const { rows: [{ agora }] } = await client.query('SELECT clock_timestamp() AS agora');
    const validade = senhaProvisoriaUtil.calcularValidade(agora);
    let identidade;
    try {
      identidade = await identidadeRepo.criar(client, { email, senhaHash, senhaProvisoria: validade, cpf });
    } catch (erro) {
      // Corrida entre a conferência e o INSERT: a unicidade do banco decide.
      if (erro && erro.code === VIOLACAO_UNICIDADE) {
        throw HttpError.conflict(...(erro.constraint === CONSTRAINT_CPF ? ERRO.CPF_EXISTENTE : ERRO.EMAIL_EXISTENTE));
      }
      throw erro;
    }
    let criado;
    try {
      criado = await usuarioRepo.criar(client, {
        empresaId, nome, perfil, identidadeId: identidade.id, matricula, setor, horarioTrabalho, grupoAcessoId,
      });
    } catch (erro) {
      if (erro && erro.code === VIOLACAO_UNICIDADE && erro.constraint === CONSTRAINT_MATRICULA) {
        throw HttpError.conflict(...ERRO.MATRICULA_EXISTENTE);
      }
      throw erro;
    }
    const ipsGravados = ips.length === 0 ? [] : await usuarioIpRepo.inserir(client, { empresaId, usuarioId: criado.id, ips });
    let copia = null;
    if (usuarioModeloId !== null) {
      // Só da empresa da sessão; de outra empresa é "não encontrado", como o inexistente.
      const modelo = await repo.buscarPorId(client, empresaId, usuarioModeloId);
      if (modelo === null) {
        throw HttpError.notFound(...ERRO.MODELO_NAO_ENCONTRADO);
      }
      if (modelo.perfil === PERFIL_MASTER) {
        throw HttpError.conflict(...ERRO.MODELO_MASTER);
      }
      copia = await copiaAcesso.copiarAcessoIndividual(client, {
        empresaId, ator, origemId: usuarioModeloId, destinoId: criado.id, destinoPerfil: perfil, ip, dispositivo,
      });
    }
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: criado.id, ip, dispositivo, acao: ACAO.CRIADO, antes: null,
      // A chave não pode conter o segmento "senha": o gatilho da 014 recusa a linha.
      depois: {
        nome, perfil, identidadeId: identidade.id, origem: ORIGEM_CRIACAO_DIRETA, acessoProvisorioExpiraEm: validade.expiraEm.toISOString(),
        temCpf: true, matricula, setor, horarioTrabalho: horarioTrabalho !== null, grupoAcessoId, ipsPermitidos: ipsGravados.length,
        ...(copia === null ? {} : {
          usuarioModeloId, copiaIndividual: copia.executado, copiaRecursos: copia.recursos, copiaBloqueios: copia.bloqueios, copiaAutorizacoes: copia.autorizacoes,
        }),
      },
    });
    return {
      usuario: apresentar(await repo.buscarPorId(client, empresaId, criado.id), ator),
      senhaProvisoriaExpiraEm: validade.expiraEm,
      administrativo: { cpfMascarado: mascararCpf(cpf), matricula, setor, horarioTrabalho, ipsPermitidos: ipsGravados, grupoAcessoId },
      copiaDeAcesso: copia === null ? null : {
        individual: copia.executado, motivo: copia.motivo, recursos: copia.recursos, bloqueios: copia.bloqueios, autorizacoes: copia.autorizacoes, ignoradas: copia.ignoradas,
      },
    };
  });
}

/**
 * Altera o nome e/ou o perfil do vínculo. E-mail, empresa, situação e
 * grupo não passam por aqui. Valor igual ao atual não muda nada nem audita.
 * @returns {Promise<{usuario: object, alterado: boolean}>}
 */
async function alterar(pool, {
  empresaId, atorId, usuarioId, nome, email, perfil, matricula, setor, horarioTrabalho, ipsPermitidos, grupoAcessoId, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (perfil !== undefined) {
      exigirPerfilGerenciavel(ator, perfil);
      // MASTER único: ninguém é promovido a MASTER e o MASTER não é rebaixado por esta tela.
      if (perfil === PERFIL_MASTER && alvo.perfil !== PERFIL_MASTER) {
        throw HttpError.conflict(...ERRO.MASTER_SO_PAINEL);
      }
      if (alvo.perfil === PERFIL_MASTER && perfil !== PERFIL_MASTER) {
        throw HttpError.conflict(...ERRO.MASTER_PERFIL_FIXO);
      }
    }
    const dados = await repo.buscarDadosParaEdicao(client, empresaId, alvo.id);
    const perfilFinal = perfil ?? alvo.perfil;
    const mudaNome = nome !== undefined && nome !== alvo.nome;
    const mudaPerfil = perfil !== undefined && perfil !== alvo.perfil;
    const base = { empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo };

    // MASTER não usa grupo: informar grupo para MASTER é conflito; virar MASTER limpa o grupo.
    const informouGrupo = grupoAcessoId !== undefined;
    if (informouGrupo && grupoAcessoId !== null && perfilFinal === PERFIL_MASTER) {
      throw HttpError.conflict(...ERRO.MASTER_SEM_GRUPO);
    }
    const mudaGrupo = perfilFinal === PERFIL_MASTER
      ? dados.grupoAcessoId !== null
      : informouGrupo && grupoAcessoId !== dados.grupoAcessoId;
    const grupoNovo = perfilFinal === PERFIL_MASTER ? null : grupoAcessoId;
    if (mudaGrupo && grupoNovo !== null) {
      const grupo = await grupoAcessoRepo.buscarPorId(client, empresaId, grupoNovo);
      if (grupo === null) {
        throw HttpError.notFound(...ERRO.GRUPO_NAO_ENCONTRADO);
      }
      if (grupo.ativo !== true) {
        throw HttpError.conflict(...ERRO.GRUPO_INATIVO);
      }
    }

    const mudaMatricula = matricula !== undefined && matricula !== dados.matricula;
    if (mudaMatricula && await usuarioRepo.existeMatricula(client, empresaId, matricula)) {
      throw HttpError.conflict(...ERRO.MATRICULA_EXISTENTE);
    }
    const mudaSetor = setor !== undefined && setor !== dados.setor;
    const mudaHorario = horarioTrabalho !== undefined
      && JSON.stringify(horarioTrabalho) !== JSON.stringify(dados.horarioTrabalho);
    const ipsAtuais = (await usuarioIpRepo.listar(client, empresaId, alvo.id)).sort();
    const ipsNovos = ipsPermitidos === undefined ? null : [...new Set(ipsPermitidos)].sort();
    const mudaIps = ipsNovos !== null && JSON.stringify(ipsNovos) !== JSON.stringify(ipsAtuais);
    if (mudaIps && alvo.id === ator.id && ipsNovos.length > 0 && !ipsNovos.includes(normalizarIp(ip))) {
      throw HttpError.conflict(...ERRO.IP_TRANCARIA);
    }

    const mudaEmail = email !== undefined && email !== String(dados.email).toLowerCase();
    let sessoesRevogadas = 0;
    if (mudaEmail) {
      if (dados.identidadeId === null || (await repo.contarVinculosDaIdentidade(client, dados.identidadeId)) !== 1) {
        throw HttpError.conflict(...ERRO.EMAIL_COMPARTILHADO);
      }
      await identidadeRepo.buscarPorIdParaAtualizacao(client, dados.identidadeId);
      if ((await identidadeRepo.buscarPorEmail(client, email)) !== null) {
        throw HttpError.conflict(...ERRO.EMAIL_EXISTENTE);
      }
    }

    if (mudaPerfil && deixaDeSerMasterAtivo(alvo)) {
      await exigirOutroMasterAtivo(client, empresaId, alvo);
    }
    if (mudaNome) {
      await repo.atualizarNome(client, empresaId, alvo.id, nome);
      await registrar(client, { ...base, acao: ACAO.ALTERADO, antes: { nome: alvo.nome }, depois: { nome } });
    }
    if (mudaPerfil) {
      await repo.atualizarPerfil(client, empresaId, alvo.id, perfil);
      await registrar(client, { ...base, acao: ACAO.PERFIL_ALTERADO, antes: { perfil: alvo.perfil }, depois: { perfil } });
    }

    if (mudaMatricula || mudaSetor || mudaHorario || mudaGrupo) {
      const campos = {};
      if (mudaMatricula) campos.matricula = matricula;
      if (mudaSetor) campos.setor = setor;
      if (mudaHorario) campos.horarioTrabalho = horarioTrabalho;
      if (mudaGrupo) campos.grupoAcessoId = grupoNovo;
      try {
        await repo.atualizarAdministrativo(client, empresaId, alvo.id, campos);
      } catch (erro) {
        if (erro && erro.code === VIOLACAO_UNICIDADE && erro.constraint === CONSTRAINT_MATRICULA) {
          throw HttpError.conflict(...ERRO.MATRICULA_EXISTENTE);
        }
        throw erro;
      }
    }
    if (mudaIps) {
      await usuarioIpRepo.substituir(client, { empresaId, usuarioId: alvo.id, ips: ipsNovos });
    }
    if (mudaMatricula || mudaSetor || mudaHorario || mudaGrupo || mudaIps) {
      const antes = {};
      const depois = {};
      if (mudaMatricula) { antes.matricula = dados.matricula; depois.matricula = matricula; }
      if (mudaSetor) { antes.setor = dados.setor; depois.setor = setor; }
      if (mudaGrupo) { antes.grupoAcessoId = dados.grupoAcessoId; depois.grupoAcessoId = grupoNovo; }
      if (mudaHorario) { depois.horarioTrabalho = horarioTrabalho !== null; }
      if (mudaIps) { antes.ipsPermitidos = ipsAtuais.length; depois.ipsPermitidos = ipsNovos.length; }
      await registrar(client, { ...base, acao: ACAO.DADOS_ALTERADOS, antes, depois });
    }
    if (mudaEmail) {
      try {
        await identidadeRepo.atualizarEmail(client, dados.identidadeId, email);
      } catch (erro) {
        if (erro && erro.code === VIOLACAO_UNICIDADE) {
          throw HttpError.conflict(...ERRO.EMAIL_EXISTENTE);
        }
        throw erro;
      }
      await redefinicaoRepo.cancelarPendentes(client, dados.identidadeId, MOTIVO_EMAIL);
      sessoesRevogadas = await sessaoGlobalRepo.revogarTodasDaIdentidade(client, dados.identidadeId, MOTIVO_EMAIL);
      sessoesRevogadas += await sessaoRepo.revogarTodasDaIdentidade(client, dados.identidadeId, MOTIVO_EMAIL);
      await registrar(client, { ...base, acao: ACAO.EMAIL_ALTERADO, antes: null, depois: { emailAlterado: true, sessoesRevogadas } });
    }

    const usuario = await repo.buscarPorId(client, empresaId, alvo.id);
    const alterado = mudaNome || mudaPerfil || mudaMatricula || mudaSetor || mudaHorario || mudaGrupo || mudaIps || mudaEmail;
    return { usuario: apresentar(usuario, ator), alterado };
  });
}

/**
 * "Alterar senha": contingência para quem não consegue usar a recuperação por
 * e-mail. O administrador NÃO define senha definitiva: define uma NOVA SENHA
 * PROVISÓRIA (ciclo da 074: Argon2id, 48 h/72 h na sexta, troca obrigatória no
 * próximo login). As sessões do usuário (globais e empresariais) e os pedidos
 * de redefinição pendentes são encerrados. Nenhum e-mail é enviado; a senha só
 * existe como hash e nunca volta. Recusado para a própria conta (a pessoa usa
 * as Configurações) e para identidade com acesso a OUTRAS empresas (a senha é
 * global: só a recuperação por e-mail ou a própria pessoa a muda).
 */
async function redefinirSenhaProvisoria(pool, {
  empresaId, atorId, usuarioId, senhaProvisoria, ip = null, dispositivo = null,
}) {
  if (typeof senhaProvisoria !== 'string' || senhaProvisoria.length === 0) {
    throw new TypeError('senha provisória inválida');
  }
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (alvo.id === ator.id) {
      throw HttpError.conflict(...ERRO.SENHA_PROPRIA);
    }
    const dados = await repo.buscarDadosParaEdicao(client, empresaId, alvo.id);
    if (dados.identidadeId === null) {
      throw HttpError.conflict(...ERRO.SEM_IDENTIDADE);
    }
    if ((await repo.contarVinculosDaIdentidade(client, dados.identidadeId)) !== 1) {
      throw HttpError.conflict(...ERRO.SENHA_COMPARTILHADA);
    }
    const politica = passwordPolicy.validarPoliticaSenha(senhaProvisoria, { email: dados.email });
    if (!politica.ok) {
      throw HttpError.validacao(politica.erros.map((e) => ({ campo: CAMPO_SENHA_PROVISORIA, codigo: e.codigo, mensagem: e.mensagem })));
    }
    await identidadeRepo.buscarPorIdParaAtualizacao(client, dados.identidadeId);
    const senhaHash = await password.gerarHashSenha(senhaProvisoria);
    const { rows: [{ agora }] } = await client.query('SELECT clock_timestamp() AS agora');
    const validade = senhaProvisoriaUtil.calcularValidade(agora);
    await identidadeRepo.definirSenhaProvisoria(client, dados.identidadeId, senhaHash, validade);
    await redefinicaoRepo.cancelarPendentes(client, dados.identidadeId, MOTIVO_REDEFINICAO_ADMIN);
    let revogadas = await sessaoGlobalRepo.revogarTodasDaIdentidade(client, dados.identidadeId, MOTIVO_REDEFINICAO_ADMIN);
    revogadas += await sessaoRepo.revogarTodasDaIdentidade(client, dados.identidadeId, MOTIVO_REDEFINICAO_ADMIN);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo, acao: ACAO.SENHA_REDEFINIDA, antes: null,
      depois: { acessoProvisorioExpiraEm: validade.expiraEm.toISOString(), sessoesRevogadas: revogadas },
    });
    return { senhaProvisoriaExpiraEm: validade.expiraEm };
  });
}

/**
 * Dados do modal "Alterar usuário", com o CPF COMPLETO (canônico): só quem
 * administra usuários (a mesma autoridade de escrita) e só de quem pode
 * gerenciar (D3). A consulta é auditada, sem o CPF.
 */
async function detalharEdicao(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  return emTransacao(pool, async (client) => {
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    const d = await repo.buscarDadosParaEdicao(client, empresaId, usuarioId);
    if (d === null) {
      throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
    }
    exigirPerfilGerenciavel(ator, d.perfil);
    const ips = await usuarioIpRepo.listar(client, empresaId, usuarioId);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: usuarioId, ip, dispositivo, acao: ACAO.DADOS_CONSULTADOS, antes: null, depois: { finalidade: 'EDICAO' },
    });
    return {
      id: d.id, nome: d.nome, email: d.email, perfil: d.perfil, ativo: d.ativo, cpf: d.cpf, matricula: d.matricula, setor: d.setor,
      horarioTrabalho: d.horarioTrabalho, ipsPermitidos: ips, grupoAcessoId: d.grupoAcessoId,
    };
  });
}

/**
 * Inativação lógica: o vínculo e o histórico ficam. O trigger da 038
 * revoga as sessões deste vínculo nesta empresa; a identidade e os
 * vínculos em outras empresas não mudam.
 */
async function inativar(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (alvo.ativo !== true) {
      throw HttpError.conflict(...ERRO.JA_INATIVO);
    }
    if (deixaDeSerMasterAtivo(alvo)) {
      await exigirOutroMasterAtivo(client, empresaId, alvo);
    }
    await repo.definirAtivo(client, empresaId, alvo.id, false);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo, acao: ACAO.INATIVADO, antes: { ativo: true }, depois: { ativo: false },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, alvo.id), ator);
  });
}

/** Reativa o MESMO vínculo: nenhum vínculo novo nasce. */
async function reativar(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (alvo.ativo === true) {
      throw HttpError.conflict(...ERRO.JA_ATIVO);
    }
    await repo.definirAtivo(client, empresaId, alvo.id, true);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo, acao: ACAO.REATIVADO, antes: { ativo: false }, depois: { ativo: true },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, alvo.id), ator);
  });
}

module.exports = {
  listar,
  buscar,
  criar,
  alterar,
  detalharEdicao,
  redefinirSenhaProvisoria,
  inativar,
  reativar,
  perfisGerenciaveis,
  exigirPerfilGerenciavel,
  travaDaEmpresa,
  emTransacao,
  ACAO,
  PERFIS_DO_MASTER,
  PERFIS_DO_ADMINISTRADOR,
};
