'use strict';

const { executarBackup, SAIDAS, ESTADOS_DA_JANELA } = require('./imagem-backup.service');
const { supervisionar } = require('./imagem-backup-supervisor.service');
const { ehObservadorDoDump, ID_DA_OPERACAO } = require('./imagem-backup-evidencia-dump.service');
const { formarCorrelacao } = require('./imagem-backup-correlacao.service');
const { ehVerificadorEstrutural, ESTRUTURA_NAO_EXECUTADA } = require('./imagem-backup-estrutura.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-EXE-1): EXECUTOR com SUPERVISÃO OBRIGATÓRIA do dump. Contrato PROVISÓRIO (RED-EXE-1),
 * válido só para os testes simulados: dependências arbitrárias do chamador NÃO são presumidas confiáveis numa execução operacional futura.
 *
 * `executarBackupSupervisionado(dependencias)`: `dependencias` é ESTRITO (janela, snapshot, processoDoDump, copia, avaliar e, opcional, parada);
 * qualquer outra chave (etapas, supervisionada, supervisionar, dump, supervisao...) ou dependência ausente/inválida é recusada ANTES da trava (saída 2),
 * sem rodar nada. O executor monta SEMPRE as três etapas fixas e chama o coordenador real (`executarBackup`, GREEN-INT-1), que adquire a trava,
 * confirma a posse e decide a liberação. A etapa dump é SEMPRE `supervisionada: true` e roda o `supervisionar` REAL (GREEN-SUP-1C), importado aqui e
 * nunca substituível pelo chamador; `processoDoDump()` só DESCREVE o processo, e dela só se aproveitam iniciar, grupo, sinais, temporizador e prazos
 * (qualquer outra chave que ela devolva, como um veredito, uma marca ou um `executar` próprio, é ignorada). O resultado da etapa dump é montado SÓ
 * com o retorno desse supervisor: `{ ok: supervisao.concluido === true, supervisao }`; uma descrição que lance, ou que não seja um objeto, faz a etapa
 * lançar, e o coordenador então RETÉM a trava (nunca libera por omissão). A parada recebida vai ao coordenador e ao supervisor.
 *
 * Resultado: o do coordenador, mais `supervisao` (o retorno do supervisor efetivamente chamado, ou null se o dump não chegou a rodar); `recuperavel` é
 * SEMPRE false: nada aqui é prova de restauração independente nem de backup real recuperável.
 *
 * LIMITES: snapshot e cópia são etapas EM PROCESSO neste desenho; se qualquer uma delas (ou a verificação dentro de `avaliar`, por exemplo um
 * `pg_restore --list`) passar a iniciar processo externo, precisará da MESMA supervisão obrigatória. Grupo real isolado com proteção contra reutilização
 * do PGID, envio de sinais com conclusão ou cancelamento seguro e o procedimento de recuperação da trava retida continuam pendentes.
 */

const OBRIGATORIAS = Object.freeze(['janela', 'snapshot', 'processoDoDump', 'copia', 'avaliar']);
const PERMITIDAS = new Set([...OBRIGATORIAS, 'parada', 'finalizar', 'integracao', 'controle']);
const DO_PROCESSO = Object.freeze(['iniciar', 'grupo', 'sinais', 'temporizador', 'prazos']);

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';

function dependenciasValidas(d) {
  if (!ehObjeto(d)) return false;
  // Estrito: todas as chaves próprias (inclusive símbolos e não enumeráveis) precisam ser conhecidas.
  if (!Reflect.ownKeys(d).every((chave) => typeof chave === 'string' && PERMITIDAS.has(chave))) return false;
  if (!ehObjeto(d.janela) || !ehFuncao(d.janela.adquirir)) return false;
  if (!ehFuncao(d.snapshot) || !ehFuncao(d.processoDoDump) || !ehFuncao(d.copia) || !ehFuncao(d.avaliar)) return false;
  if (d.parada !== undefined && d.parada !== null && !(ehObjeto(d.parada) && ehFuncao(d.parada.aoPedir))) return false;
  // `finalizar`: ausente = comportamento histórico; presente (inclusive undefined ou null) precisa ser função.
  if (Object.hasOwn(d, 'finalizar') && !ehFuncao(d.finalizar)) return false;
  // `integracao` (E1–E4), opcional: identidade da operação + observador do dump PRODUZIDO por `criarObservadorDoDump` + leitor do snapshot aberto. Sem ela, o comportamento é o histórico.
  if (Object.hasOwn(d, 'integracao')) {
    const i = d.integracao;
    if (!ehObjeto(i) || typeof i.operacaoId !== 'string' || !ID_DA_OPERACAO.test(i.operacaoId) || !ehObservadorDoDump(i.observador) || !ehFuncao(i.snapshotId)) return false;
    if (Object.hasOwn(i, 'verificadorEstrutural') && !ehVerificadorEstrutural(i.verificadorEstrutural)) return false;
  }
  return true;
}

/** Cópia congelada do terminal do supervisor, vinculada à operação; só códigos fixos e números (nenhum caminho, comando ou texto livre). */
function terminalDaOperacao(operacaoId, s) {
  return Object.freeze({
    operacaoId,
    saida: s.saida,
    concluido: s.concluido === true,
    liberarTravaPermitido: s.liberarTravaPermitido === true,
    encerramentoForcado: s.encerramentoForcado === true,
    codigoDoProcesso: s.codigoDoProcesso ?? null,
    sinalDoProcesso: s.sinalDoProcesso ?? null,
  });
}

function recusa() {
  return Object.freeze({
    saida: SAIDAS.ARGUMENTOS,
    valido: false,
    recuperavel: false,
    janela: ESTADOS_DA_JANELA.NAO_ADQUIRIDA,
    etapasExecutadas: Object.freeze([]),
    motivos: Object.freeze([]),
    sinal: null,
    supervisao: null,
  });
}

/** Só as peças do processo que o supervisor usa; tudo o mais que a descrição trouxer é descartado. */
function opcoesDoSupervisor(descricao, parada) {
  if (!ehObjeto(descricao)) throw new TypeError('descrição do processo do dump inválida');
  const opcoes = {};
  for (const chave of DO_PROCESSO) opcoes[chave] = descricao[chave];
  if (parada) opcoes.parada = parada;
  return opcoes;
}

async function executarBackupSupervisionado(dependencias) {
  if (!dependenciasValidas(dependencias)) return recusa();
  const { janela, snapshot, processoDoDump, copia, avaliar } = dependencias;
  const parada = dependencias.parada ?? undefined;

  const integracao = Object.hasOwn(dependencias, 'integracao') ? dependencias.integracao : null;
  const operacaoId = integracao === null ? null : integracao.operacaoId;
  const observador = integracao === null ? null : integracao.observador;
  const lerSnapshotId = integracao === null ? null : integracao.snapshotId;
  const verificadorEstrutural = integracao === null || !Object.hasOwn(integracao, 'verificadorEstrutural') ? null : integracao.verificadorEstrutural;

  let supervisao = null;
  let terminal = null; // E2: terminal do supervisor desta operação (congelado)
  let observacao = null; // E3': T1 aceita desta operação
  const etapas = [
    { nome: 'snapshot', executar: () => snapshot() },
    {
      nome: 'dump',
      supervisionada: true,
      async executar() {
        const resultado = await supervisionar(opcoesDoSupervisor(processoDoDump(), parada));
        supervisao = resultado;
        if (integracao !== null) terminal = terminalDaOperacao(operacaoId, resultado);
        return { ok: resultado.concluido === true, supervisao: resultado };
      },
    },
    {
      nome: 'copia',
      async executar(operacao) {
        // P3: com `controle`, o coordenador entrega o sinal da operação; ele segue à cópia (junto da informação da operação) e nunca altera uma decisão: é só um pedido de cancelamento cooperativo.
        const sinalDaOperacao = ehObjeto(operacao) ? operacao.sinal : undefined;
        if (integracao === null) return sinalDaOperacao === undefined ? copia() : copia(Object.freeze({ sinal: sinalDaOperacao }));
        if (terminal === null || terminal.concluido !== true) return { ok: false };
        // E3': T1 é obtida UMA vez, só depois da conclusão supervisionada. O consumidor é avisado do resultado de T1 (para registrar o diagnóstico), mas o retorno dele NUNCA transforma uma T1 recusada em sucesso.
        const t1 = await observador.observar();
        const informacao = Object.freeze({ operacaoId, supervisao: terminal, dump: Object.freeze({ observacao: t1, conferir: () => observador.conferir() }), ...(sinalDaOperacao === undefined ? {} : { sinal: sinalDaOperacao }) });
        const resposta = await copia(informacao);
        if (t1.ok !== true) return { ok: false };
        observacao = t1;
        return resposta;
      },
    },
  ];

  // E4: o coordenador chama `avaliar({ etapas })`; aqui T2 é executada ANTES de a correlação ser formada, e o avaliador do consumidor recebe a correlação já contendo T2.
  const avaliarDaOperacao = integracao === null ? avaliar : async (entrada) => {
    if (terminal === null || observacao === null) return { valido: false }; // evidência obrigatória ausente: falha fechada, sem chamar o avaliador do consumidor
    // Marco C: a verificação estrutural (supervisionada, sobre o MESMO artefato de T1) vem ANTES de T2, para que T2 confirme que o artefato não mudou durante ela. Sem verificador configurado, ou em qualquer falha
    // inesperada, a estrutura consta como NÃO EXECUTADA (falha fechada para a publicação).
    let estrutura = ESTRUTURA_NAO_EXECUTADA;
    if (verificadorEstrutural !== null) {
      try { estrutura = await verificadorEstrutural.verificar({ operacaoId, observador }); } catch { estrutura = ESTRUTURA_NAO_EXECUTADA; }
    }
    const t2 = await observador.conferir();
    const snapshotId = lerSnapshotId();
    let correlacao;
    try {
      correlacao = formarCorrelacao({ operacaoId, snapshotId, supervisao: terminal, observacao, t2, estrutura });
    } catch {
      return { valido: false };
    }
    return avaliar(Object.freeze({
      ...entrada,
      operacaoId,
      snapshotId,
      supervisao: terminal,
      dump: Object.freeze({ observacao, t2, conferir: () => observador.conferir(), abrirArtefato: () => observador.abrirArtefato() }),
      estrutura,
      correlacao,
    }));
  };

  // A MESMA função recebida segue ao coordenador, que decide quando, se e quantas vezes ela roda e o que isso significa para a trava.
  const finalizar = Object.hasOwn(dependencias, 'finalizar') ? dependencias.finalizar : undefined;
  const resultado = await executarBackup({ janela, etapas, avaliar: avaliarDaOperacao, ...(parada ? { parada } : {}), ...(finalizar ? { finalizar } : {}), ...(Object.hasOwn(dependencias, 'controle') ? { controle: dependencias.controle } : {}) });
  return Object.freeze({ ...resultado, recuperavel: false, supervisao });
}

module.exports = { executarBackupSupervisionado };
