'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, P2/P3): REGISTRO DE OPERAÇÕES PENDENTES de UMA execução. Módulo puro (sem E/S própria, sem ambiente, sem processo); o único relógio é o `temporizador` injetado (`prazo(ms) -> { promessa, cancelar }`).
 *
 * PRINCÍPIO: prazo vencido, `AbortSignal` e `Promise.race` NÃO provam cancelamento nem término. Uma operação só deixa de ser pendente quando a PRÓPRIA promessa dela assenta (resolve ou rejeita), observada por este registro. Um pedido de cancelamento é só um pedido; o estado
 * `CANCELAMENTO_NAO_CONFIRMADO` significa "o pedido foi feito, a cortesia de observação passou e a promessa continua sem assentar": a operação CONTINUA na lista de pendentes até assentar de verdade. O assentamento tardio atualiza o registro (`tardia: true`) e nunca reverte uma decisão de retenção.
 *
 * `criarRegistroDeOperacoes({ temporizador?, cortesiaMs? })` (ESTRITO; TypeError genérico). `cortesiaMs` exige `temporizador`; sem eles nada é limitado por tempo (o comportamento é o de esperar a promessa, fail-closed). Nenhum valor padrão é inventado.
 *   - `rastrear({ etapa, recursos, aoCancelar? }, executar)`: chama `executar(sinal)` AGORA (início real) e observa a promessa com os DOIS ramos (resolução e rejeição), então uma rejeição tardia nunca é rejeição não observada. Cada etapa é registrada UMA vez por registro (identidade não reutilizável). `aoCancelar` é o contrato interno de
 *     cancelamento da operação (se existir), chamado uma vez por pedido. Devolve `{ id, assentada }`; `assentada` nunca rejeita e resolve com `{ desfecho: 'RESOLVIDA' | 'REJEITADA', valor }` só quando a operação de fato assenta.
 *   - `solicitarCancelamento(motivo, { id? })`: marca `CANCELAMENTO_SOLICITADO`, aborta o sinal da operação (ou de todas as em execução) e chama `aoCancelar`. Operação iniciada DEPOIS de um pedido geral já nasce com o sinal abortado.
 *   - `aguardar(id, { limiteMs? })`: espera o assentamento. Com `limiteMs`, o vencimento só SOLICITA o cancelamento (`ETAPA_EXPIRADA`). Com `cortesiaMs`, depois de qualquer pedido de cancelamento a espera é limitada: se a promessa não assentar, devolve `estado: 'CANCELAMENTO_NAO_CONFIRMADO'` (a operação segue pendente).
 *   - `pendentes()`, `resumo()`, `reivindicar(chave)` (uma vez só por chave fechada: impede finalização duplicada), `prazo(ms)`.
 * Tudo que sai daqui são códigos fixos e contadores: nunca texto de dependência, caminho, valor ou segredo.
 */

const ESTADOS = Object.freeze({ EM_EXECUCAO: 'EM_EXECUCAO', CANCELAMENTO_SOLICITADO: 'CANCELAMENTO_SOLICITADO', ASSENTADA: 'ASSENTADA', CANCELAMENTO_NAO_CONFIRMADO: 'CANCELAMENTO_NAO_CONFIRMADO' });
const MOTIVOS_DE_CANCELAMENTO = Object.freeze(['PARADA', 'POSSE_PERDIDA', 'ETAPA_EXPIRADA', 'ABERTURA_EXPIRADA', 'ERRO_INESPERADO']);
const ETAPAS = Object.freeze(['ABERTURA_SNAPSHOT', 'snapshot', 'dump', 'copia', 'avaliacao', 'restauracao_imagens', 'conferencia_logica']);
const RECURSOS = Object.freeze(['SNAPSHOT', 'CONEXAO', 'PROCESSO', 'DESCRITOR', 'ARQUIVO_PARCIAL', 'ARMAZENAMENTO']);
const CHAVES_DE_REIVINDICACAO = Object.freeze(['FINALIZACAO_SNAPSHOT']);

const registros = new WeakSet();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;

function criarRegistroDeOperacoes(opcoes = {}) {
  let temporizador = null;
  let cortesiaMs = null;
  try {
    if (!ehObjeto(opcoes)) throw new TypeError('x');
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => k === 'temporizador' || k === 'cortesiaMs')) throw new TypeError('x');
    if (opcoes.temporizador !== undefined) {
      if (!ehObjeto(opcoes.temporizador) || !ehFuncao(opcoes.temporizador.prazo)) throw new TypeError('x');
      temporizador = opcoes.temporizador;
    }
    if (opcoes.cortesiaMs !== undefined) {
      if (!inteiroPositivo(opcoes.cortesiaMs) || temporizador === null) throw new TypeError('x');
      cortesiaMs = opcoes.cortesiaMs;
    }
  } catch {
    throw new TypeError('opções do registro de operações inválidas');
  }

  const execucaoId = crypto.randomUUID();
  const operacoes = new Map();
  const etapasUsadas = new Set();
  const reivindicadas = new Set();
  let sequencia = 0;
  let cancelamentoGeral = null;

  function notificar(op) {
    for (const ouvinte of [...op.ouvintes]) { try { ouvinte(); } catch { /* um ouvinte nunca derruba o registro */ } }
  }

  function assentar(op, desfecho, valor) {
    if (op.estado === ESTADOS.ASSENTADA) return;
    op.tardia = op.estado === ESTADOS.CANCELAMENTO_NAO_CONFIRMADO || op.abandonada === true;
    op.cancelamentoConfirmado = op.cancelamentoSolicitado === true;
    op.estado = ESTADOS.ASSENTADA;
    op.desfecho = desfecho;
    op.resolverAssentada(Object.freeze({ desfecho, valor }));
    notificar(op);
  }

  function rastrear(spec, executar) {
    if (!ehObjeto(spec) || !ETAPAS.includes(spec.etapa) || !Array.isArray(spec.recursos) || !spec.recursos.every((r) => RECURSOS.includes(r)) || new Set(spec.recursos).size !== spec.recursos.length
      || (spec.aoCancelar !== undefined && !ehFuncao(spec.aoCancelar)) || !Reflect.ownKeys(spec).every((k) => k === 'etapa' || k === 'recursos' || k === 'aoCancelar') || !ehFuncao(executar)) {
      throw new TypeError('operação inválida');
    }
    if (etapasUsadas.has(spec.etapa)) throw new TypeError('operação já registrada nesta execução');
    etapasUsadas.add(spec.etapa);
    sequencia += 1;
    const controlador = new AbortController();
    let resolverAssentada;
    const assentada = new Promise((resolver) => { resolverAssentada = resolver; });
    const op = {
      id: `${execucaoId}:${sequencia}`,
      etapa: spec.etapa,
      recursos: Object.freeze([...spec.recursos]),
      estado: ESTADOS.EM_EXECUCAO,
      cancelamentoSolicitado: false,
      motivoDoCancelamento: null,
      cancelamentoConfirmado: false,
      desfecho: null,
      tardia: false,
      abandonada: false,
      aoCancelar: spec.aoCancelar ?? null,
      controlador,
      ouvintes: new Set(),
      resolverAssentada,
    };
    operacoes.set(op.id, op);
    if (cancelamentoGeral !== null) {
      op.cancelamentoSolicitado = true;
      op.motivoDoCancelamento = cancelamentoGeral;
      op.estado = ESTADOS.CANCELAMENTO_SOLICITADO;
      controlador.abort();
    }
    let promessa;
    try {
      promessa = Promise.resolve(executar(controlador.signal));
    } catch (falha) {
      promessa = Promise.reject(falha);
    }
    // os dois ramos são observados aqui: nenhuma rejeição, nem a tardia, fica sem tratamento
    promessa.then((valor) => assentar(op, 'RESOLVIDA', valor), () => assentar(op, 'REJEITADA', undefined));
    return Object.freeze({ id: op.id, assentada });
  }

  function pedir(op, motivo) {
    if (op.estado !== ESTADOS.EM_EXECUCAO) return false;
    op.estado = ESTADOS.CANCELAMENTO_SOLICITADO;
    op.cancelamentoSolicitado = true;
    op.motivoDoCancelamento = motivo;
    try { op.controlador.abort(); } catch { /* o sinal é só um pedido */ }
    if (op.aoCancelar !== null) { try { op.aoCancelar(motivo); } catch { /* o contrato interno de cancelamento nunca derruba o registro */ } }
    notificar(op);
    return true;
  }

  function solicitarCancelamento(motivo, alvo = {}) {
    if (!MOTIVOS_DE_CANCELAMENTO.includes(motivo) || !ehObjeto(alvo)) throw new TypeError('motivo de cancelamento inválido');
    let pedidos = 0;
    if (alvo.id !== undefined) {
      const op = operacoes.get(alvo.id);
      if (op !== undefined && pedir(op, motivo)) pedidos += 1;
      return pedidos;
    }
    if (cancelamentoGeral === null) cancelamentoGeral = motivo;
    for (const op of operacoes.values()) if (pedir(op, motivo)) pedidos += 1;
    return pedidos;
  }

  function aguardar(id, espera = {}) {
    const op = operacoes.get(id);
    if (op === undefined) throw new TypeError('operação desconhecida');
    const limiteMs = ehObjeto(espera) ? espera.limiteMs : undefined;
    if (limiteMs !== undefined && (!inteiroPositivo(limiteMs) || temporizador === null)) throw new TypeError('limite inválido');
    return new Promise((resolver) => {
      const prazos = [];
      let fechado = false;
      const terminar = (r) => {
        if (fechado) return;
        fechado = true;
        op.ouvintes.delete(ouvir);
        for (const p of prazos) { try { p.cancelar(); } catch { /* higiene */ } }
        resolver(Object.freeze(r));
      };
      const relatorio = (extra = {}) => ({ estado: op.estado, desfecho: op.desfecho, expirou: expirou, ...extra });
      let expirou = false;
      let cortesiaIniciada = false;
      const iniciarCortesia = () => {
        if (cortesiaIniciada || cortesiaMs === null || !op.cancelamentoSolicitado || op.estado === ESTADOS.ASSENTADA) return;
        cortesiaIniciada = true;
        const prazo = temporizador.prazo(cortesiaMs);
        prazos.push(prazo);
        Promise.resolve(prazo.promessa).then(() => {
          if (fechado || op.estado === ESTADOS.ASSENTADA) return;
          op.estado = ESTADOS.CANCELAMENTO_NAO_CONFIRMADO;
          op.abandonada = true;
          terminar(relatorio());
        }, () => {});
      };
      function ouvir() {
        if (op.estado === ESTADOS.ASSENTADA) { terminar(relatorio()); return; }
        iniciarCortesia();
      }
      op.ouvintes.add(ouvir);
      if (op.estado === ESTADOS.ASSENTADA) { terminar(relatorio()); return; }
      if (limiteMs !== undefined) {
        const prazo = temporizador.prazo(limiteMs);
        prazos.push(prazo);
        Promise.resolve(prazo.promessa).then(() => {
          if (fechado || op.estado === ESTADOS.ASSENTADA) return;
          expirou = true;
          // o vencimento do prazo é só um PEDIDO: não é término
          pedir(op, 'ETAPA_EXPIRADA');
          iniciarCortesia();
        }, () => {});
      }
      iniciarCortesia();
    });
  }

  /**
   * Atalho de `rastrear` + `aguardar` (+ leitura do assentamento): devolve `{ estado, desfecho, valor, expirou }`. `estado` só é ASSENTADA quando a promessa realmente assentou; CANCELAMENTO_NAO_CONFIRMADO deixa `desfecho: null` e a operação SEGUE na lista de pendentes.
   * Prazo (`limiteMs`) só pede cancelamento; `expirou: true` com `valor` presente NÃO significa sucesso (quem chama trata como falha).
   */
  async function executar(spec, fn, espera = {}) {
    const r = rastrear(spec, fn);
    const e = await aguardar(r.id, espera);
    if (e.estado !== ESTADOS.ASSENTADA) return Object.freeze({ estado: e.estado, desfecho: null, valor: undefined, expirou: e.expirou === true });
    const a = await r.assentada;
    return Object.freeze({ estado: ESTADOS.ASSENTADA, desfecho: a.desfecho, valor: a.valor, expirou: e.expirou === true });
  }

  function pendentes() {
    const lista = [];
    for (const op of operacoes.values()) if (op.estado !== ESTADOS.ASSENTADA) lista.push(Object.freeze({ id: op.id, etapa: op.etapa, recursos: op.recursos, estado: op.estado }));
    return Object.freeze(lista);
  }

  function resumo() {
    const itens = [];
    for (const op of operacoes.values()) {
      itens.push(Object.freeze({
        etapa: op.etapa,
        estado: op.estado,
        desfecho: op.desfecho,
        tardia: op.tardia,
        cancelamentoSolicitado: op.cancelamentoSolicitado,
        motivoDoCancelamento: op.motivoDoCancelamento,
        cancelamentoConfirmado: op.cancelamentoConfirmado,
        recursos: op.recursos,
      }));
    }
    return Object.freeze({ total: itens.length, pendentes: itens.filter((i) => i.estado !== ESTADOS.ASSENTADA).length, operacoes: Object.freeze(itens) });
  }

  function reivindicar(chave) {
    if (!CHAVES_DE_REIVINDICACAO.includes(chave)) throw new TypeError('chave inválida');
    if (reivindicadas.has(chave)) return false;
    reivindicadas.add(chave);
    return true;
  }

  function prazo(ms) {
    if (temporizador === null || !inteiroPositivo(ms)) throw new TypeError('temporizador indisponível');
    return temporizador.prazo(ms);
  }

  const registro = Object.freeze({
    rastrear,
    executar,
    solicitarCancelamento,
    aguardar,
    pendentes,
    resumo,
    reivindicar,
    prazo,
    temTemporizador: temporizador !== null,
    temCortesia: cortesiaMs !== null,
  });
  registros.add(registro);
  return registro;
}

const ehRegistroDeOperacoes = (v) => v !== null && typeof v === 'object' && registros.has(v);

module.exports = { criarRegistroDeOperacoes, ehRegistroDeOperacoes, ESTADOS_DA_OPERACAO: ESTADOS, MOTIVOS_DE_CANCELAMENTO, ETAPAS_RASTREAVEIS: ETAPAS, RECURSOS_RASTREAVEIS: RECURSOS };
