'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { gerarTokenSessao, hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const credencialRepo = require('../repositories/token-credencial.repository');
const ativacaoRepo = require('../repositories/token-ativacao.repository');
const redeRepo = require('../repositories/token-rede.repository');
const controleRepo = require('../repositories/token-evento-controle.repository');
const eventoRepo = require('../repositories/token-dispositivo-evento.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — ativação e autenticação do TABLET (Etapa C). A credencial do tablet não é sessão administrativa e não
 * identifica funcionário: ela só prova "este equipamento cadastrado, desta empresa, nesta rede".
 *
 * ATIVAR: o código de uso único é validado em UMA transação, com a linha do tablet travada primeiro (a mesma ordem da geração) e
 * a ativação travada depois: pendente, não expirada (relógio do banco), tablet não revogado, empresa ativa e rede autorizada.
 * Qualquer falha do código é a MESMA resposta (ATIVACAO_INVALIDA); a falha de rede só aparece para quem tem um código válido e
 * NÃO consome o código. No sucesso a credencial é emitida (256 bits, só o hash no banco), a anterior — se havia — deixa de
 * existir na mesma escrita (recuperação) e o código é marcado como usado.
 *
 * AUTENTICAR (a cada requisição protegida): formato → credencial (atual ou anterior) → tablet e empresa ativos → expiração
 * absoluta no servidor → carência da anterior → rede → rotação. A rede é decidida ANTES da rotação: nunca se emite credencial a
 * uma origem não autorizada. A rotação é um UPDATE condicionado (uma requisição ganha; as simultâneas passam pela carência).
 * A credencial anterior só vale na carência e NUNCA renova nem rotaciona; fora dela é recusada com REUSO_CREDENCIAL, sem
 * revogar o tablet. Cookie de 180 dias não é autorização: revogado, substituído ou expirado no servidor é 401.
 *
 * Origem de rede: SÓ o req.ip resolvido pelo servidor (o chamador passa `ip`); TUNEL negado (D-C1) e IP_FIXO exato (D-C6).
 * Nada daqui confia em User-Agent, tamanho de tela ou sistema operacional para decidir autorização.
 */

const JANELA_SUPRESSAO_EVENTOS_SEGUNDOS = 60;
const ACAO_ATIVADO = 'TOKEN_DISPOSITIVO_ATIVADO';
const ACAO_REATIVADO = 'TOKEN_DISPOSITIVO_REATIVADO';

const ativacaoInvalida = () => HttpError.unauthorized('ATIVACAO_INVALIDA', 'Código de ativação inválido ou expirado');
const naoAutorizado = () => HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado');
const redeNaoAutorizada = () => HttpError.forbidden('REDE_NAO_AUTORIZADA', 'Acesso não permitido a partir desta rede');

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

const publico = (linha) => ({ nome: linha.nome, unidade: linha.unidade, setor: linha.setor, localInstalacao: linha.local_instalacao });

async function recusarPorRede(pool, empresaId, dispositivoId) {
  await controleRepo.registrarSuprimido(pool, { empresaId, dispositivoId, tipo: 'REDE_RECUSADA', janelaSegundos: JANELA_SUPRESSAO_EVENTOS_SEGUNDOS });
  return redeNaoAutorizada();
}

/** Consome o código e emite a credencial. Devolve { credencial, dispositivo } ou lança a recusa genérica. */
async function ativar(pool, { codigo, ip = null, agente = null }) {
  if (!tokenSessaoTemFormatoValido(codigo)) throw ativacaoInvalida();
  const codigoHash = hashTokenSessao(codigo);

  const resultado = await emTransacao(pool, async (client) => {
    const previa = await ativacaoRepo.buscarPorHash(client, codigoHash);
    if (previa === null) return { negado: 'CODIGO' };
    const tablet = await credencialRepo.travarDispositivo(client, previa.empresa_id, previa.dispositivo_id);
    const ativacao = await ativacaoRepo.buscarPorHashTravando(client, codigoHash);
    if (tablet === null || ativacao === null || ativacao.valida !== true || tablet.revogado_em !== null || tablet.empresa_ativa !== true) {
      return { negado: 'CODIGO' };
    }
    if (!(await redeRepo.ipFixoAutorizado(client, tablet.empresa_id, ip))) {
      return { negado: 'REDE', empresaId: tablet.empresa_id, dispositivoId: tablet.id };
    }

    const credencial = gerarTokenSessao();
    const reativacao = tablet.credencial_hash !== null;
    await credencialRepo.emitirNaAtivacao(client, { empresaId: tablet.empresa_id, id: tablet.id, credencialHash: hashTokenSessao(credencial) });
    if (!(await ativacaoRepo.marcarUsada(client, ativacao.id))) throw new Error('ativação deixou de ser pendente sob trava');
    await eventoRepo.registrar(client, { empresaId: tablet.empresa_id, dispositivoId: tablet.id, tipo: 'ATIVACAO' });
    await auditoriaRepo.registrar(client, {
      empresaId: tablet.empresa_id,
      usuarioId: null,
      acao: reativacao ? ACAO_REATIVADO : ACAO_ATIVADO,
      referencia: String(tablet.id),
      ip,
      dispositivo: agente,
      contexto: { reativacao },
    });
    return { credencial, dispositivo: publico(tablet) };
  });

  if (resultado.negado === 'CODIGO') throw ativacaoInvalida();
  if (resultado.negado === 'REDE') throw await recusarPorRede(pool, resultado.empresaId, resultado.dispositivoId);
  return resultado;
}

/**
 * Autentica a credencial apresentada. Devolve { dispositivo: { id, empresaId, nome, unidade, setor, localInstalacao },
 * novaCredencial } (novaCredencial só quando esta requisição rotacionou). Com `rotacionar: false` a credencial é autenticada pelas mesmas regras
 * (credencial, empresa, expiração, carência, rede e eventos), mas nunca é rotacionada e `novaCredencial` é sempre null; o padrão é rotacionar.
 */
async function autenticar(pool, { credencial, ip = null, rotacionar = true }) {
  if (!tokenSessaoTemFormatoValido(credencial)) throw naoAutorizado();
  const credencialHash = hashTokenSessao(credencial);
  const criterios = {
    carenciaSegundos: authConfig.dispositivo.carenciaSegundos,
    rotacaoHoras: authConfig.dispositivo.rotacaoHoras,
    cookieDias: authConfig.dispositivo.cookieDias,
  };

  let linha = await credencialRepo.buscarPorCredencial(pool, credencialHash, criterios);
  if (linha === null || linha.revogado_em !== null || linha.empresa_ativa !== true || linha.expirada === true) throw naoAutorizado();
  if (linha.atual !== true && linha.na_carencia !== true) {
    await controleRepo.registrarSuprimido(pool, { empresaId: linha.empresa_id, dispositivoId: linha.id, tipo: 'REUSO_CREDENCIAL', janelaSegundos: JANELA_SUPRESSAO_EVENTOS_SEGUNDOS });
    throw naoAutorizado();
  }
  if (!(await redeRepo.ipFixoAutorizado(pool, linha.empresa_id, ip))) throw await recusarPorRede(pool, linha.empresa_id, linha.id);

  let novaCredencial = null;
  if (rotacionar !== false && linha.atual === true && linha.rotacao_devida === true) {
    const candidata = gerarTokenSessao();
    const ganhou = await emTransacao(pool, async (client) => {
      const rotacionou = await credencialRepo.rotacionar(client, {
        id: linha.id, credencialAtualHash: credencialHash, novaCredencialHash: hashTokenSessao(candidata), rotacaoHoras: criterios.rotacaoHoras,
      });
      if (rotacionou) await eventoRepo.registrar(client, { empresaId: linha.empresa_id, dispositivoId: linha.id, tipo: 'CREDENCIAL_RENOVADA' });
      return rotacionou;
    });
    if (ganhou) {
      novaCredencial = candidata;
    } else {
      // Outra requisição rotacionou (ou o tablet foi revogado/recuperado): reavalia a credencial apresentada, sem rotacionar de novo.
      linha = await credencialRepo.buscarPorCredencial(pool, credencialHash, criterios);
      if (linha === null || linha.revogado_em !== null || linha.empresa_ativa !== true || linha.expirada === true) throw naoAutorizado();
      if (linha.atual !== true && linha.na_carencia !== true) throw naoAutorizado();
    }
  }
  return { dispositivo: { id: linha.id, empresaId: linha.empresa_id, ...publico(linha) }, novaCredencial };
}

module.exports = { JANELA_SUPRESSAO_EVENTOS_SEGUNDOS, ACAO_ATIVADO, ACAO_REATIVADO, ativar, autenticar };
