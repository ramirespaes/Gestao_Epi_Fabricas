'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): POLÍTICA DE EXECUÇÃO AUTOMÁTICA, como lógica PASSIVA. Nenhum timer, cron, processo residente, tarefa de sistema ou agendamento de nuvem: quem quiser executar chama `tick()` (um agendador EXTERNO, ainda inexistente, fará isso). O padrão é DESATIVADO e a ativação é um ato explícito
 * (`ativar({ confirmacao })`). O módulo não conhece pg_dump, banco, disco nem rede: recebe `executar` (que será a entrada operacional), `relogio`, `prazo` e `alertar` por injeção.
 *
 * `tick()` decide, nesta ordem: desativado; bloqueado por falhas seguidas (exige `reconhecerFalhas()` humano); execução em andamento; nova tentativa ainda em espera; execução ainda não devida; só então executa. Uma execução tem identidade própria (128 bits), UMA por vez, com prazo: ao estourar, a execução é registrada como TIMEOUT e conta como falha, mas a
 * exclusão NÃO é liberada enquanto a chamada original não terminar de fato (ela não pode ser cancelada daqui): sem nova execução sobreposta. Sucesso = a entrada devolveu `estados.backupOperacionalValido === true` e, se a política exige, `estados.restauracaoComprovada === true`; qualquer outra coisa — exceção, resposta fora do formato,
 * `executado:false` — é falha. Nunca se infere recuperabilidade. Tentativas repetidas respeitam a espera da política e o limite `maxTentativas` (depois dele, BLOQUEADO + alerta, até reconhecimento humano).
 *
 * HISTÓRICO verificável: lista só de ACRÉSCIMO com encadeamento SHA-256 (`verificarHistorico`) — em memória: persistência do histórico é decisão de armazenamento pendente. ALERTAS: objeto com códigos fixos (tipo, motivo, execução, tentativa), sem texto livre, segredo ou caminho; falha ao alertar vira evento no histórico, nunca derruba a política.
 * RETENÇÃO (`planejarRetencao`): pura e SÓ planeja (nenhuma remoção); nunca expõe como candidato os últimos N pacotes, os mais novos que a idade mínima, nem o pacote mais recente com restauração comprovada.
 */

const POLITICA_PADRAO = Object.freeze({ ativa: false, intervaloMs: 24 * 3600 * 1000, timeoutMs: 2 * 3600 * 1000, maxTentativas: 3, esperaEntreTentativasMs: 15 * 60 * 1000, exigirVerificacaoDeRestauracao: true, retencao: Object.freeze({ manterUltimos: 7, idadeMinimaMs: 7 * 24 * 3600 * 1000 }) });
const CONFIRMACAO_DE_ATIVACAO = 'ATIVAR_AGENDAMENTO_DE_BACKUP';
const MOTIVOS_DE_FALHA = Object.freeze(['EXCECAO', 'TIMEOUT', 'RESPOSTA_INVALIDA', 'NAO_EXECUTADO', 'BACKUP_NAO_VALIDO', 'SEM_VERIFICACAO_DE_RESTAURACAO']);
const NOME_PACOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('política de execução inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const inteiro = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function validarPolitica(p) {
  if (!ehObjeto(p) || !chavesExatas(p, Object.keys(POLITICA_PADRAO))) throw configuracaoInvalida();
  if (typeof p.ativa !== 'boolean' || typeof p.exigirVerificacaoDeRestauracao !== 'boolean') throw configuracaoInvalida();
  if (!inteiro(p.intervaloMs, 1, 366 * 86400000) || !inteiro(p.timeoutMs, 1, 86400000) || !inteiro(p.maxTentativas, 1, 20) || !inteiro(p.esperaEntreTentativasMs, 0, 86400000)) throw configuracaoInvalida();
  if (!ehObjeto(p.retencao) || !chavesExatas(p.retencao, ['manterUltimos', 'idadeMinimaMs']) || !inteiro(p.retencao.manterUltimos, 1, 10000) || !inteiro(p.retencao.idadeMinimaMs, 0, 3650 * 86400000)) throw configuracaoInvalida();
}

function criarControladorDeExecucao(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['politica', 'relogio', 'executar', 'prazo', 'alertar'])) throw configuracaoInvalida();
  const { relogio, executar, prazo, alertar } = opcoes;
  if (typeof relogio !== 'function' || typeof executar !== 'function' || typeof prazo !== 'function' || typeof alertar !== 'function') throw configuracaoInvalida();
  validarPolitica(opcoes.politica);
  const politica = { ...opcoes.politica, retencao: { ...opcoes.politica.retencao } };

  const historico = [];
  let ultimoHash = '0'.repeat(64);
  let emAndamento = false;
  let execucaoAtual = null;
  let falhasSeguidas = 0;
  let bloqueado = false;
  let ultimaTentativaEm = null;
  let ultimoSucessoEm = null;

  function registrar(evento, extra = {}) {
    const entrada = { seq: historico.length + 1, quando: relogio(), evento, execucaoId: extra.execucaoId ?? null, motivo: extra.motivo ?? null, tentativa: extra.tentativa ?? null };
    const hash = crypto.createHash('sha256').update(`${ultimoHash}\n${JSON.stringify(entrada)}`).digest('hex');
    historico.push(Object.freeze({ ...entrada, hashAnterior: ultimoHash, hash }));
    ultimoHash = hash;
  }

  async function avisar(tipo, execucaoId, motivo, tentativa) {
    try { await alertar(Object.freeze({ tipo, execucaoId, motivo, tentativa })); } catch { registrar('ALERTA_FALHOU', { execucaoId, motivo: tipo }); }
  }

  async function falhar(execucaoId, motivo) {
    falhasSeguidas += 1;
    registrar('FALHA', { execucaoId, motivo, tentativa: falhasSeguidas });
    await avisar('FALHA_DE_BACKUP', execucaoId, motivo, falhasSeguidas);
    if (falhasSeguidas >= politica.maxTentativas) {
      bloqueado = true;
      registrar('BLOQUEADO', { execucaoId, motivo: 'LIMITE_DE_TENTATIVAS', tentativa: falhasSeguidas });
      await avisar('AGENDAMENTO_BLOQUEADO', execucaoId, 'LIMITE_DE_TENTATIVAS', falhasSeguidas);
    }
    return Object.freeze({ acao: 'FALHOU', motivo, execucaoId });
  }

  function avaliarResposta(r) {
    if (!ehObjeto(r) || r.executado !== true || !ehObjeto(r.estados)) return ehObjeto(r) && r.executado === false ? 'NAO_EXECUTADO' : 'RESPOSTA_INVALIDA';
    if (r.estados.backupOperacionalValido !== true) return 'BACKUP_NAO_VALIDO';
    if (politica.exigirVerificacaoDeRestauracao && r.estados.restauracaoComprovada !== true) return 'SEM_VERIFICACAO_DE_RESTAURACAO';
    return null;
  }

  async function tick() {
    if (!politica.ativa) return Object.freeze({ acao: 'NAO_EXECUTADA', motivo: 'AGENDAMENTO_DESATIVADO' });
    if (bloqueado) return Object.freeze({ acao: 'NAO_EXECUTADA', motivo: 'BLOQUEADO_POR_FALHAS' });
    if (emAndamento) return Object.freeze({ acao: 'NAO_EXECUTADA', motivo: 'EM_ANDAMENTO' });
    const agora = relogio();
    if (falhasSeguidas > 0 && ultimaTentativaEm !== null && agora - ultimaTentativaEm < politica.esperaEntreTentativasMs) return Object.freeze({ acao: 'NAO_EXECUTADA', motivo: 'AGUARDANDO_NOVA_TENTATIVA' });
    if (falhasSeguidas === 0 && ultimoSucessoEm !== null && agora - ultimoSucessoEm < politica.intervaloMs) return Object.freeze({ acao: 'NAO_EXECUTADA', motivo: 'NAO_DEVIDA' });

    const execucaoId = crypto.randomBytes(16).toString('hex');
    emAndamento = true;
    execucaoAtual = execucaoId;
    ultimaTentativaEm = agora;
    registrar('INICIADA', { execucaoId, tentativa: falhasSeguidas + 1 });
    const chamada = Promise.resolve().then(() => executar({ execucaoId })).then((valor) => ({ valor }), () => ({ excecao: true }));
    chamada.then(() => { emAndamento = false; execucaoAtual = null; });
    const limite = prazo(politica.timeoutMs);
    const primeiro = await Promise.race([chamada, limite.promessa.then(() => ({ timeout: true }))]);
    limite.cancelar();
    if (primeiro.timeout === true) {
      // a chamada original segue; a exclusão só cai quando ela terminar (tratada acima)
      chamada.then(() => registrar('ENCERRADA_APOS_TIMEOUT', { execucaoId }));
      return falhar(execucaoId, 'TIMEOUT');
    }
    if (primeiro.excecao === true) return falhar(execucaoId, 'EXCECAO');
    const motivo = avaliarResposta(primeiro.valor);
    if (motivo !== null) return falhar(execucaoId, motivo);
    falhasSeguidas = 0;
    ultimoSucessoEm = relogio();
    registrar('SUCESSO', { execucaoId });
    return Object.freeze({ acao: 'EXECUTADA', motivo: null, execucaoId });
  }

  function ativar(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['confirmacao']) || pedido.confirmacao !== CONFIRMACAO_DE_ATIVACAO) throw configuracaoInvalida();
    politica.ativa = true;
    registrar('ATIVADO');
    return true;
  }
  /** Desativação segura: nenhuma nova execução; a que está em andamento NÃO é interrompida. */
  function desativar() {
    politica.ativa = false;
    registrar('DESATIVADO', { execucaoId: execucaoAtual });
    return Object.freeze({ desativada: true, execucaoEmAndamento: emAndamento });
  }
  function reconhecerFalhas() {
    if (emAndamento) return false;
    falhasSeguidas = 0;
    bloqueado = false;
    registrar('FALHAS_RECONHECIDAS');
    return true;
  }
  function verificarHistorico() {
    let anterior = '0'.repeat(64);
    for (const [i, h] of historico.entries()) {
      const { hashAnterior, hash, ...corpo } = h;
      const esperado = crypto.createHash('sha256').update(`${anterior}\n${JSON.stringify(corpo)}`).digest('hex');
      if (h.seq !== i + 1 || hashAnterior !== anterior || hash !== esperado) return Object.freeze({ integro: false, primeiraFalha: i + 1 });
      anterior = hash;
    }
    return Object.freeze({ integro: true, primeiraFalha: null });
  }

  return Object.freeze({
    tick,
    ativar,
    desativar,
    reconhecerFalhas,
    verificarHistorico,
    historico: () => Object.freeze([...historico]),
    estado: () => Object.freeze({ ativa: politica.ativa, emAndamento, bloqueado, falhasSeguidas, ultimoSucessoEm }),
  });
}

/** Retenção: só PLANEJA. `pacotes`: [{ nome, criadoEm (ms), restauracaoComprovada (boolean) }]. */
function planejarRetencao({ pacotes, agora, retencao }) {
  if (!Array.isArray(pacotes) || pacotes.length > 100000 || !Number.isSafeInteger(agora) || !ehObjeto(retencao) || !chavesExatas(retencao, ['manterUltimos', 'idadeMinimaMs']) || !inteiro(retencao.manterUltimos, 1, 10000) || !inteiro(retencao.idadeMinimaMs, 0, 3650 * 86400000)) throw configuracaoInvalida();
  const nomes = new Set();
  for (const p of pacotes) {
    if (!ehObjeto(p) || !chavesExatas(p, ['nome', 'criadoEm', 'restauracaoComprovada']) || typeof p.nome !== 'string' || !NOME_PACOTE.test(p.nome) || nomes.has(p.nome) || !Number.isSafeInteger(p.criadoEm) || p.criadoEm < 0 || typeof p.restauracaoComprovada !== 'boolean') throw configuracaoInvalida();
    nomes.add(p.nome);
  }
  const ordenados = [...pacotes].sort((a, b) => b.criadoEm - a.criadoEm || (a.nome < b.nome ? -1 : 1));
  const ultimaComprovada = ordenados.find((p) => p.restauracaoComprovada)?.nome ?? null;
  const manter = [];
  const candidatos = [];
  ordenados.forEach((p, i) => {
    const motivo = i < retencao.manterUltimos ? 'ULTIMOS_N' : p.criadoEm > agora ? 'RELOGIO_INCONSISTENTE' : agora - p.criadoEm < retencao.idadeMinimaMs ? 'IDADE_MINIMA' : p.nome === ultimaComprovada ? 'ULTIMA_RESTAURACAO_COMPROVADA' : null;
    if (motivo === null) candidatos.push(p.nome); else manter.push({ nome: p.nome, motivo });
  });
  return Object.freeze({ modo: 'PLANO', manter: Object.freeze(manter), candidatosAExpurgo: Object.freeze(candidatos) });
}

module.exports = { criarControladorDeExecucao, planejarRetencao, POLITICA_PADRAO, CONFIRMACAO_DE_ATIVACAO, MOTIVOS_DE_FALHA };
