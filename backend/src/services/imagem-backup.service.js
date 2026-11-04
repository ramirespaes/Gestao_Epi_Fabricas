'use strict';

const { TIPOS, ErroDeJanela, adquirirJanela, ehPosseDeJanela } = require('../utils/janela-escrita-imagens');
const { saidaDoSinal } = require('../utils/parada-por-sinal');
const { avaliarCorrelacao } = require('./imagem-backup-correlacao.service');
const { ehRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-1): COORDENAÇÃO e VALIDAÇÃO unitárias, com dependências injetadas. Este módulo não lê nem
 * escreve disco, não abre banco, não cria processo e não executa pg_dump: quem faz o trabalho são as etapas recebidas. Contrato PROVISÓRIO (RED-1A).
 *
 * `executarBackup({ janela, etapas, avaliar, parada })`, nesta ordem: (1) valida os argumentos ANTES de qualquer trava (lista de etapas diferente de
 * snapshot → dump → copia, ou dependência inválida: saída 2); (2) registra o pedido de parada, que só é anotado e NUNCA solta a trava; (3) adquire a trava de
 * janela com o tipo BACKUP (ocupada: saída 6, sem insistir e sem tocar na trava alheia); (4) confirma a posse pelo token antes da primeira etapa e depois de
 * cada uma; (5) roda as etapas em ordem: cada uma tem de resolver `{ ok: true }` (exatamente true), e falha, exceção ou resultado incompleto interrompe a
 * sequência; depois de um pedido de parada nenhuma etapa nova começa e o backup interrompido nunca é válido, mesmo que a etapa corrente termine bem
 * (GREEN-1B: o pedido vale até o fim da operação; o que chega durante a avaliação, a última conferência de posse ou a liberação também invalida);
 * (6) só com as três etapas bem-sucedidas, a posse confirmada e nenhum pedido de parada chama `avaliar`, e só `valido === true` conta; um erro da avaliação
 * vira saída 1, nunca sucesso; (7) solta a trava num ponto só, uma única vez, DEPOIS de a etapa em andamento ter terminado, e só se a posse não estiver
 * sabidamente perdida (a trava de outro dono nunca é tocada nem recriada); liberação que não confirma (`liberada !== true`) é posse perdida e liberação
 * que lança deixa a trava como NAO_LIBERADA: nos dois casos o resultado não é válido.
 *
 * Saídas: 0 válido; 1 erro inesperado (aquisição, conferência de posse, avaliação ou liberação); 2 argumentos; 6 janela ocupada; 9 inválido (etapa que
 * falhou ou veredito não válido); 10 posse perdida; 11 trava RETIDA por segurança; 128 + número do sinal quando a parada interrompeu um backup sem outra
 * falha (SIGINT 130, SIGTERM 143). Precedência: 10, depois 11, depois 1, depois 9, depois o sinal. Estado da trava: LIBERADA | PERDIDA | NAO_LIBERADA |
 * OCUPADA | NAO_ADQUIRIDA | RETIDA.
 *
 * GREEN-INT-1 (contrato PROVISÓRIO de integração com o supervisor): uma etapa marcada `supervisionada: true` devolve `supervisao` (o resultado do
 * supervisor). Só `supervisao.liberarTravaPermitido === true` permite soltar a trava; qualquer outra coisa a RETÉM: liberar() não é chamado, nenhuma
 * etapa seguinte começa, `avaliar` não roda, saída 11, estado RETIDA (só com a posse comprovada) e motivo TRAVA_RETIDA_POR_SEGURANCA. Avançar exige
 * `ok === true` E `supervisao.concluido === true`. Etapas sem a marca seguem como antes. LIMITE: a marca é opcional e o objeto vem da própria etapa;
 * o executor operacional futuro terá de impor a supervisão e obter o veredito de um componente confiável, sem aceitar objeto arbitrário como prova.
 *
 * GREEN-FIN-1 (contrato PROVISÓRIO de finalização, RED-FIN-1B): `finalizar`, opcional, é validado antes da trava (não sendo função: saída 2). Com a
 * trava adquirida, é chamado NO MÁXIMO UMA vez, depois de a última etapa iniciada e a avaliação terminarem e antes de qualquer liberação, com
 * `{ posse, etapasExecutadas, interrompido }`. EXCEÇÃO DE SEGURANÇA: se a supervisão determinou retenção (os processos podem estar vivos), ele NÃO é
 * chamado e a finalização fica ADIADA, qualquer que seja a posse. Só `{ concluida: true }` conta; qualquer outra resposta, ou exceção, é NAO_CONCLUIDA e
 * a trava não é solta (RETIDA com a posse comprovada; NAO_LIBERADA com a posse inconclusiva). A posse é conferida de novo depois da finalização. Um pedido
 * de parada durante ela só é anotado. `resultado.finalizacao`: CONCLUIDA | NAO_CONCLUIDA | ADIADA | NAO_APLICAVEL (sem `finalizar`, ou nada adquirido).
 *
 * P2/P3 (OPCIONAL, sem valor padrão): `controle` = { registro, etapaMs?, posseMs? }, com `registro` produzido por `criarRegistroDeOperacoes`. Sem `controle` nada muda. Com ele, cada etapa e a avaliação rodam COMO OPERAÇÕES RASTREADAS (`executar({ sinal })`; `avaliar({ etapas, sinal })`) e:
 * (a) parada e perda de posse (esta só com `posseMs`, conferida durante a etapa) SOLICITAM o cancelamento (sinal + contrato interno); (b) `etapaMs`, só para `copia` e `avaliacao`, apenas SOLICITA o cancelamento ao vencer; (c) a espera depois de um pedido é limitada pela cortesia do registro, que é só observação: se a promessa não
 * assentar, o estado é CANCELAMENTO_NAO_CONFIRMADO, o resultado é inválido, a trava fica RETIDA (saída 11), a finalização ADIADA e a operação continua na lista de pendentes até assentar de verdade; (d) operação que assenta depois nunca reverte a retenção; (e) com operação pendente (exceto a abertura do snapshot, que a própria finalização aguarda), a finalização
 * é ADIADA e a trava não é solta; (f) etapa que expirou mas assentou dentro da cortesia é falha (ETAPA_EXPIRADA), nunca sucesso. O prazo, o sinal e `Promise.race` nunca são tratados como término.
 *
 * LIMITES (não são garantias deste módulo): a coordenação aguarda a promessa de cada etapa, mas NÃO supervisiona processos externos: uma etapa que lança
 * um processo e resolve antes de ele (ou um descendente) terminar escapa desta coordenação; a supervisão de processos e de seus descendentes é de etapa
 * posterior. Uma etapa que nunca resolve prende a trava (falha fechada; tempo máximo é de etapa posterior). `recuperavel` é sempre false aqui: só uma
 * prova de restauração independente, avaliada por `avaliarConjunto`, pode torná-lo verdadeiro.
 *
 * `avaliarConjunto(entrada)`: função pura (nenhuma E/S) que confere o que as etapas declararam: código de saída, relatório, manifesto, lista exigida pelo
 * snapshot, verificação independente, dump do PostgreSQL e identidade do conjunto; acumula TODOS os motivos (nenhum esconde outro). `valido` = nenhum
 * motivo; `recuperavel` = válido E prova de restauração aprovada com os três identificadores DESTE conjunto (id, SHA-256 recalculado do dump e SHA-256 do
 * manifesto). LIMITE: a função compara hashes INFORMADOS; não prova que foram recalculados dos bytes reais, nem que `identidade.sha256Manifesto` é o hash
 * do manifesto recebido, e a prova em memória não substitui a restauração independente. Nenhum resultado daqui prova que um backup real é recuperável.
 */

const SAIDAS = Object.freeze({
  VALIDO: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  JANELA_OCUPADA: 6,
  INVALIDO: 9,
  JANELA_PERDIDA: 10,
  TRAVA_RETIDA: 11,
});

const ETAPAS_OBRIGATORIAS = Object.freeze(['snapshot', 'dump', 'copia']);

const ESTADOS_DA_JANELA = Object.freeze({
  LIBERADA: 'LIBERADA',
  PERDIDA: 'PERDIDA',
  NAO_LIBERADA: 'NAO_LIBERADA',
  OCUPADA: 'OCUPADA',
  NAO_ADQUIRIDA: 'NAO_ADQUIRIDA',
  RETIDA: 'RETIDA',
});

const MOTIVOS = Object.freeze({
  SAIDA_NAO_ZERO: 'SAIDA_NAO_ZERO',
  RELATORIO_AUSENTE: 'RELATORIO_AUSENTE',
  VEREDITO_NAO_VALIDO: 'VEREDITO_NAO_VALIDO',
  MANIFESTO_AUSENTE: 'MANIFESTO_AUSENTE',
  MANIFESTO_INVALIDO: 'MANIFESTO_INVALIDO',
  LISTA_DO_SNAPSHOT_AUSENTE: 'LISTA_DO_SNAPSHOT_AUSENTE',
  LISTA_DO_SNAPSHOT_INVALIDA: 'LISTA_DO_SNAPSHOT_INVALIDA',
  SHA256_DIVERGENTE: 'SHA256_DIVERGENTE',
  ARQUIVO_EXIGIDO_AUSENTE: 'ARQUIVO_EXIGIDO_AUSENTE',
  VERIFICACAO_FALHOU: 'VERIFICACAO_FALHOU',
  VERIFICACAO_NAO_CONCLUIDA: 'VERIFICACAO_NAO_CONCLUIDA',
  DUMP_AUSENTE: 'DUMP_AUSENTE',
  DUMP_NAO_CONCLUIDO: 'DUMP_NAO_CONCLUIDO',
  DUMP_VAZIO: 'DUMP_VAZIO',
  DUMP_INVALIDO: 'DUMP_INVALIDO',
  DUMP_SHA256_DIVERGENTE: 'DUMP_SHA256_DIVERGENTE',
  IDENTIDADE_INVALIDA: 'IDENTIDADE_INVALIDA',
  ETAPA_FALHOU: 'ETAPA_FALHOU',
  INTERROMPIDO: 'INTERROMPIDO',
  AVALIACAO_FALHOU: 'AVALIACAO_FALHOU',
  AVALIACAO_NAO_VALIDA: 'AVALIACAO_NAO_VALIDA',
  POSSE_NAO_CONFERIDA: 'POSSE_NAO_CONFERIDA',
  TRAVA_RETIDA_POR_SEGURANCA: 'TRAVA_RETIDA_POR_SEGURANCA',
  LIBERACAO_NEGADA_PELA_SUPERVISAO: 'LIBERACAO_NEGADA_PELA_SUPERVISAO',
  SUPERVISAO_NAO_CONCLUIDA: 'SUPERVISAO_NAO_CONCLUIDA',
  FINALIZACAO_NAO_CONCLUIDA: 'FINALIZACAO_NAO_CONCLUIDA',
  CORRELACAO_NAO_SATISFEITA: 'CORRELACAO_NAO_SATISFEITA',
  RELATORIO_SEM_PROVENIENCIA: 'RELATORIO_SEM_PROVENIENCIA',
  CANCELAMENTO_NAO_CONFIRMADO: 'CANCELAMENTO_NAO_CONFIRMADO',
  ETAPA_EXPIRADA: 'ETAPA_EXPIRADA',
  OPERACAO_PENDENTE: 'OPERACAO_PENDENTE',
  QUARENTENA_NAO_REGISTRADA: 'QUARENTENA_NAO_REGISTRADA',
});

const ESTADOS_DA_FINALIZACAO = Object.freeze({
  CONCLUIDA: 'CONCLUIDA',
  NAO_CONCLUIDA: 'NAO_CONCLUIDA',
  ADIADA: 'ADIADA',
  NAO_APLICAVEL: 'NAO_APLICAVEL',
});

const SHA256 = /^[0-9a-f]{64}$/;
const CONTROLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LIMITE_DO_IDENTIFICADOR = 200;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';

// ------------------------------------------------------------------------------------------------------------------------------- coordenação
/** `controle` (P2/P3), opcional: só `registro` (obrigatório, produzido pelo módulo do registro), `etapaMs` e `posseMs` (inteiros positivos que exigem registro com temporizador). */
function controleValido(controle) {
  if (!ehObjeto(controle) || !Reflect.ownKeys(controle).every((k) => k === 'registro' || k === 'etapaMs' || k === 'posseMs')) return false;
  if (!ehRegistroDeOperacoes(controle.registro)) return false;
  for (const k of ['etapaMs', 'posseMs']) {
    if (Object.hasOwn(controle, k) && !(Number.isSafeInteger(controle[k]) && controle[k] > 0 && controle.registro.temTemporizador === true)) return false;
  }
  return true;
}

function argumentosValidos({ janela, etapas, avaliar, parada, finalizar, controle }) {
  if (controle !== undefined && !controleValido(controle)) return false;
  if (!ehObjeto(janela) || !ehFuncao(janela.adquirir) || !ehFuncao(avaliar)) return false;
  if (finalizar !== undefined && !ehFuncao(finalizar)) return false;
  if (parada !== undefined && parada !== null && !(ehObjeto(parada) && ehFuncao(parada.aoPedir))) return false;
  if (!Array.isArray(etapas) || etapas.length !== ETAPAS_OBRIGATORIAS.length) return false;
  // `supervisionada`, quando presente, só pode ser booleana: um valor ambíguo nunca vira "não supervisionada" por omissão.
  return etapas.every((etapa, i) => ehObjeto(etapa) && etapa.nome === ETAPAS_OBRIGATORIAS[i] && ehFuncao(etapa.executar)
    && (etapa.supervisionada === undefined || typeof etapa.supervisionada === 'boolean'));
}

const manipuladorValido = (manipulador) => ehObjeto(manipulador) && ehFuncao(manipulador.confirmarPosse) && ehFuncao(manipulador.liberar);

function resultado({ saida, janela, etapasExecutadas = [], motivos = [], sinal = null, finalizacao = ESTADOS_DA_FINALIZACAO.NAO_APLICAVEL, operacoes }) {
  return Object.freeze({
    ...(operacoes === undefined ? {} : { operacoes }),
    saida,
    valido: saida === SAIDAS.VALIDO,
    recuperavel: false,
    janela,
    etapasExecutadas: Object.freeze([...etapasExecutadas]),
    motivos: Object.freeze([...new Set(motivos)]),
    sinal,
    finalizacao,
  });
}

const rotuloDaPosse = (posse) => (posse === true ? 'CONFIRMADA' : posse === false ? 'PERDIDA' : 'DESCONHECIDA');

/** 128 + número do sinal; um sinal que o sistema não conhece nunca vira 0: vale como backup inválido. */
function saidaDaParada(sinal) {
  try {
    return saidaDoSinal(sinal);
  } catch {
    return SAIDAS.INVALIDO;
  }
}

/** Posse pelo token: só `{ confirmada: true }` conta. Falha ao conferir é `null` (desconhecida), nunca posse. */
async function conferirPosse(manipulador) {
  try {
    const resposta = await manipulador.confirmarPosse();
    return ehObjeto(resposta) && resposta.confirmada === true;
  } catch {
    return null;
  }
}

async function rodarEtapa(etapa) {
  try {
    const devolvido = await etapa.executar();
    return { ok: ehObjeto(devolvido) && devolvido.ok === true, devolvido };
  } catch {
    return { ok: false, devolvido: undefined };
  }
}

const RECURSOS_DA_ETAPA = Object.freeze({
  snapshot: ['SNAPSHOT', 'CONEXAO'],
  dump: ['PROCESSO', 'DESCRITOR', 'ARQUIVO_PARCIAL'],
  copia: ['ARMAZENAMENTO', 'ARQUIVO_PARCIAL', 'DESCRITOR'],
  avaliacao: ['ARMAZENAMENTO', 'ARQUIVO_PARCIAL', 'DESCRITOR'],
});
/** O prazo de etapa (`etapaMs`) só vale para estas; o dump tem os prazos do supervisor e o snapshot tem `aberturaMs`. */
const ETAPAS_COM_PRAZO = new Set(['copia', 'avaliacao']);

/**
 * P3: vigia de posse DURANTE uma operação. A cada `posseMs` confere a posse; só `false` (perda comprovada) SOLICITA o cancelamento (`POSSE_PERDIDA`); inconclusiva (null) não cancela nada. Nunca solta nem toca a trava: quem decide a liberação continua sendo o laço principal.
 * Devolve `parar()`.
 */
function vigiarPosse(manipulador, registro, posseMs) {
  let parado = false;
  let prazoAtual = null;
  (async () => {
    for (;;) {
      prazoAtual = registro.prazo(posseMs);
      await prazoAtual.promessa;
      if (parado) return;
      const posse = await conferirPosse(manipulador);
      if (parado) return;
      if (posse === false) { registro.solicitarCancelamento('POSSE_PERDIDA'); return; }
    }
  })().catch(() => {});
  return () => {
    parado = true;
    if (prazoAtual !== null) { try { prazoAtual.cancelar(); } catch { /* higiene */ } }
  };
}

/**
 * P2/P3: roda uma operação como PENDÊNCIA RASTREADA. O resultado nunca trata prazo, sinal ou corrida como término: `naoConfirmada` só é verdadeiro quando houve pedido de cancelamento, a cortesia passou e a promessa continua sem assentar (a operação segue pendente no registro).
 */
async function rodarOperacaoRastreada(nome, fn, controle, manipulador) {
  const { registro } = controle;
  let rastreada;
  try {
    rastreada = registro.rastrear({ etapa: nome, recursos: RECURSOS_DA_ETAPA[nome] }, (sinalDaOperacao) => fn(sinalDaOperacao));
  } catch {
    return { ok: false, devolvido: undefined, naoConfirmada: false, expirou: false, rejeitada: true };
  }
  const pararVigia = controle.posseMs === undefined ? null : vigiarPosse(manipulador, registro, controle.posseMs);
  let esperado;
  try {
    esperado = await registro.aguardar(rastreada.id, ETAPAS_COM_PRAZO.has(nome) && controle.etapaMs !== undefined ? { limiteMs: controle.etapaMs } : {});
  } finally {
    if (pararVigia !== null) pararVigia();
  }
  if (esperado.estado !== 'ASSENTADA') return { ok: false, devolvido: undefined, naoConfirmada: true, expirou: esperado.expirou === true, rejeitada: false };
  const assentado = await rastreada.assentada;
  if (assentado.desfecho !== 'RESOLVIDA') return { ok: false, devolvido: undefined, naoConfirmada: false, expirou: esperado.expirou === true, rejeitada: true };
  const ok = esperado.expirou !== true && ehObjeto(assentado.valor) && assentado.valor.ok === true;
  return { ok, devolvido: assentado.valor, naoConfirmada: false, expirou: esperado.expirou === true, rejeitada: false };
}

/**
 * GREEN-INT-1: o que uma etapa SUPERVISIONADA diz sobre a trava. Só `supervisao.liberarTravaPermitido === true` permite soltá-la; qualquer outra coisa
 * (exceção, resultado ausente ou incompleto, supervisão ausente, valor estranho, liberação negada) a RETÉM. O avanço exige ainda `ok === true` E
 * `supervisao.concluido === true`; sem isso a etapa falhou, nunca é sucesso.
 */
function lerSupervisao(feito) {
  const supervisao = ehObjeto(feito.devolvido) ? feito.devolvido.supervisao : undefined;
  const liberacaoPermitida = ehObjeto(supervisao) && supervisao.liberarTravaPermitido === true;
  return { reter: !liberacaoPermitida, concluida: liberacaoPermitida && feito.ok && supervisao.concluido === true };
}

async function executarBackup(opcoes = {}) {
  const argumentos = ehObjeto(opcoes) ? opcoes : {};
  if (!argumentosValidos(argumentos)) return resultado({ saida: SAIDAS.ARGUMENTOS, janela: ESTADOS_DA_JANELA.NAO_ADQUIRIDA });
  const { janela, etapas, avaliar, parada, finalizar, controle } = argumentos;
  const registro = controle === undefined ? null : controle.registro;

  // O pedido de parada é só anotado (o primeiro vale): quem para é o laço abaixo, entre uma etapa e outra; a liberação nunca sai daqui.
  // Com `controle`, a parada também SOLICITA o cancelamento das operações em andamento (apenas um pedido: não é término nem libera nada).
  let sinal = null;
  if (parada) {
    parada.aoPedir((recebido) => {
      if (sinal === null) sinal = typeof recebido === 'string' ? recebido : 'DESCONHECIDO';
      if (registro !== null) { try { registro.solicitarCancelamento('PARADA'); } catch { /* o pedido nunca derruba a coordenação */ } }
    });
  }

  let manipulador;
  try {
    manipulador = await janela.adquirir({ tipo: TIPOS.BACKUP });
  } catch (falha) {
    if (falha instanceof ErroDeJanela && falha.codigo === 'JANELA_OCUPADA') return resultado({ saida: SAIDAS.JANELA_OCUPADA, janela: ESTADOS_DA_JANELA.OCUPADA });
    return resultado({ saida: SAIDAS.ERRO, janela: ESTADOS_DA_JANELA.NAO_ADQUIRIDA });
  }
  // Uma aquisição que não devolve o manipulador deixa a trava em estado desconhecido: não há como provar a posse nem soltá-la pelo token.
  if (!manipuladorValido(manipulador)) return resultado({ saida: SAIDAS.ERRO, janela: ESTADOS_DA_JANELA.NAO_LIBERADA });

  const executadas = [];
  const motivos = [];
  let posse = await conferirPosse(manipulador);
  let falhou = false;
  let interrompido = false;
  let avaliacaoComErro = false;
  let reter = false;

  if (posse === true) {
    for (const etapa of etapas) {
      if (sinal !== null) { interrompido = true; break; }
      executadas.push(etapa.nome);
      const feito = registro === null ? await rodarEtapa(etapa) : await rodarOperacaoRastreada(etapa.nome, (sinalDaOperacao) => etapa.executar({ sinal: sinalDaOperacao }), controle, manipulador);
      posse = await conferirPosse(manipulador);
      if (feito.naoConfirmada === true) {
        // cancelamento pedido e NÃO confirmado: a operação segue em execução e pode estar usando recursos; nada é finalizado nem liberado
        reter = true; falhou = true; motivos.push(MOTIVOS.CANCELAMENTO_NAO_CONFIRMADO);
        if (feito.expirou === true) motivos.push(MOTIVOS.ETAPA_EXPIRADA);
        break;
      }
      if (feito.expirou === true) { falhou = true; motivos.push(MOTIVOS.ETAPA_FALHOU, MOTIVOS.ETAPA_EXPIRADA); break; }
      if (etapa.supervisionada === true) {
        const lido = lerSupervisao(feito);
        if (lido.reter) { reter = true; falhou = true; motivos.push(MOTIVOS.LIBERACAO_NEGADA_PELA_SUPERVISAO); break; }
        if (!lido.concluida) { falhou = true; motivos.push(MOTIVOS.ETAPA_FALHOU, MOTIVOS.SUPERVISAO_NAO_CONCLUIDA); break; }
      } else if (!feito.ok) { falhou = true; motivos.push(MOTIVOS.ETAPA_FALHOU); break; }
      if (posse !== true) break;
    }
    if (posse === true && !falhou && sinal !== null) interrompido = true;
  }

  // A avaliação pode declarar `reterTrava: true` (quarentena necessária e NÃO registrada de forma durável): a trava não é liberada, mas a finalização dos recursos segue normalmente.
  let quarentenaPendente = false;
  if (posse === true && !falhou && !interrompido && !reter) {
    if (registro === null) {
      try {
        const avaliacao = await avaliar(Object.freeze({ etapas: Object.freeze([...executadas]) }));
        if (ehObjeto(avaliacao) && avaliacao.reterTrava === true) { quarentenaPendente = true; motivos.push(MOTIVOS.QUARENTENA_NAO_REGISTRADA); }
        if (!(ehObjeto(avaliacao) && avaliacao.valido === true)) { falhou = true; motivos.push(MOTIVOS.AVALIACAO_NAO_VALIDA); }
      } catch {
        avaliacaoComErro = true;
        motivos.push(MOTIVOS.AVALIACAO_FALHOU);
      }
    } else {
      const entrada = (sinalDaOperacao) => avaliar(Object.freeze({ etapas: Object.freeze([...executadas]), sinal: sinalDaOperacao }));
      const feita = await rodarOperacaoRastreada('avaliacao', entrada, controle, manipulador);
      if (feita.naoConfirmada) {
        reter = true; falhou = true; motivos.push(MOTIVOS.CANCELAMENTO_NAO_CONFIRMADO);
        if (feita.expirou) motivos.push(MOTIVOS.ETAPA_EXPIRADA);
      } else if (feita.rejeitada) {
        avaliacaoComErro = true;
        motivos.push(MOTIVOS.AVALIACAO_FALHOU);
      } else if (feita.expirou) {
        falhou = true; motivos.push(MOTIVOS.AVALIACAO_NAO_VALIDA, MOTIVOS.ETAPA_EXPIRADA);
      } else if (!(ehObjeto(feita.devolvido) && feita.devolvido.valido === true)) {
        falhou = true; motivos.push(MOTIVOS.AVALIACAO_NAO_VALIDA);
      }
      if (!feita.naoConfirmada && !feita.rejeitada && ehObjeto(feita.devolvido) && feita.devolvido.reterTrava === true) { quarentenaPendente = true; motivos.push(MOTIVOS.QUARENTENA_NAO_REGISTRADA); }
    }
    // A avaliação pode demorar: a posse é conferida de novo antes de soltar.
    posse = await conferirPosse(manipulador);
  }

  // P3: operação pendente (exceto a abertura do snapshot, que a PRÓPRIA finalização aguarda) significa que ainda há recurso em uso: nada é finalizado nem liberado.
  if (registro !== null && !reter && registro.pendentes().some((p) => p.etapa !== 'ABERTURA_SNAPSHOT')) { reter = true; motivos.push(MOTIVOS.OPERACAO_PENDENTE); }

  // GREEN-FIN-1: finalização dos recursos, uma vez só, sem etapa em andamento e antes de qualquer liberação. Com retenção exigida pela supervisão ela
  // fica ADIADA: os processos podem estar vivos e depender desses recursos. Ela nunca decide liberar: não concluída, a trava não é solta.
  let finalizacao = ESTADOS_DA_FINALIZACAO.NAO_APLICAVEL;
  let finalizacaoRetem = false;
  // GREEN-FIN-1A: com `finalizar` fornecido, posse inconclusiva depois da finalização nunca permite liberar(), mesmo com a finalização concluída.
  let posseInconclusivaAposFinalizar = false;
  if (finalizar !== undefined) {
    if (reter) {
      finalizacao = ESTADOS_DA_FINALIZACAO.ADIADA;
    } else {
      let concluida = false;
      try {
        const resposta = await finalizar(Object.freeze({
          posse: rotuloDaPosse(posse),
          etapasExecutadas: Object.freeze([...executadas]),
          interrompido: interrompido || sinal !== null,
        }));
        concluida = ehObjeto(resposta) && resposta.concluida === true;
      } catch {
        concluida = false;
      }
      // P3: uma finalização "concluída" com operação ainda pendente no registro não conta (nada declara fechado o que ainda está em uso)
      if (concluida && registro !== null && registro.pendentes().length > 0) concluida = false;
      finalizacao = concluida ? ESTADOS_DA_FINALIZACAO.CONCLUIDA : ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA;
      if (!concluida) { finalizacaoRetem = true; motivos.push(MOTIVOS.FINALIZACAO_NAO_CONCLUIDA); }
      // A finalização pode demorar: a posse é conferida de novo antes de soltar. Posse sabidamente perdida continua perdida.
      if (posse !== false) posse = await conferirPosse(manipulador);
      if (posse === null) posseInconclusivaAposFinalizar = true;
    }
  }

  // Liberação: um ponto só, uma vez, sem etapa em andamento. Com a posse sabidamente perdida a trava é de outro (ou sumiu): não se toca nela.
  let estado;
  let erroNaLiberacao = false;
  // P3: última barreira — qualquer operação ainda pendente (inclusive a abertura do snapshot, se a finalização não a viu assentar) impede soltar a trava.
  const pendenciaAntesDeLiberar = registro !== null && registro.pendentes().length > 0;
  if (pendenciaAntesDeLiberar && !reter) motivos.push(MOTIVOS.OPERACAO_PENDENTE);
  if (posse === false) {
    estado = ESTADOS_DA_JANELA.PERDIDA;
  } else if (reter || finalizacaoRetem || posseInconclusivaAposFinalizar || pendenciaAntesDeLiberar || quarentenaPendente) {
    // GREEN-INT-1: a supervisão não permitiu soltar: liberar() NÃO é chamado. RETIDA só com a posse comprovada; posse inconclusiva nunca é declarada
    // retenção comprovada (fica NAO_LIBERADA, saída 1). Nada aqui ou depois solta essa trava: a recuperação é só pelo procedimento controlado.
    if (posse === true) {
      estado = ESTADOS_DA_JANELA.RETIDA;
      motivos.push(MOTIVOS.TRAVA_RETIDA_POR_SEGURANCA);
    } else {
      estado = ESTADOS_DA_JANELA.NAO_LIBERADA;
      motivos.push(MOTIVOS.POSSE_NAO_CONFERIDA);
    }
  } else {
    if (posse === null) motivos.push(MOTIVOS.POSSE_NAO_CONFERIDA);
    try {
      const solta = await manipulador.liberar();
      estado = ehObjeto(solta) && solta.liberada === true ? ESTADOS_DA_JANELA.LIBERADA : ESTADOS_DA_JANELA.PERDIDA;
    } catch {
      estado = ESTADOS_DA_JANELA.NAO_LIBERADA;
      erroNaLiberacao = true;
    }
  }

  // O pedido de parada vale até o FIM da operação: o que chegou durante a avaliação, a última conferência de posse ou a liberação também interrompeu
  // o backup, que então nunca é válido. Só é lido aqui, depois da liberação, que continua única e fora do ouvinte.
  if (sinal !== null) {
    interrompido = true;
    motivos.push(MOTIVOS.INTERROMPIDO);
  }

  let saida;
  if (estado === ESTADOS_DA_JANELA.PERDIDA) saida = SAIDAS.JANELA_PERDIDA;
  else if (estado === ESTADOS_DA_JANELA.RETIDA) saida = SAIDAS.TRAVA_RETIDA;
  else if (erroNaLiberacao || avaliacaoComErro || posse === null) saida = SAIDAS.ERRO;
  else if (falhou) saida = SAIDAS.INVALIDO;
  else if (interrompido) saida = saidaDaParada(sinal);
  else saida = SAIDAS.VALIDO;

  return resultado({ saida, janela: estado, etapasExecutadas: executadas, motivos, sinal, finalizacao, ...(registro === null ? {} : { operacoes: registro.resumo() }) });
}

// ------------------------------------------------------------------------------------------------------------------------------- validação
const sha256Valido = (valor) => typeof valor === 'string' && SHA256.test(valor);
const chaveValida = (valor) => typeof valor === 'string' && valor !== '' && !CONTROLE.test(valor) && !valor.startsWith('/')
  && valor.split('/').every((parte) => parte !== '' && parte !== '.' && parte !== '..');

/** Lista de { chave, sha256 } sem chave repetida; null se fora do formato. */
function indexarArquivos(arquivos) {
  if (!Array.isArray(arquivos)) return null;
  const indice = new Map();
  for (const item of arquivos) {
    if (!ehObjeto(item) || !chaveValida(item.chave) || !sha256Valido(item.sha256) || indice.has(item.chave)) return null;
    indice.set(item.chave, item.sha256);
  }
  return indice;
}

function identidadeValida(identidade) {
  return ehObjeto(identidade)
    && typeof identidade.conjuntoId === 'string' && identidade.conjuntoId.trim() !== '' && identidade.conjuntoId.length <= LIMITE_DO_IDENTIFICADOR
    && !CONTROLE.test(identidade.conjuntoId)
    && sha256Valido(identidade.sha256Manifesto);
}

function motivosDoDump(dump) {
  if (!ehObjeto(dump)) return [MOTIVOS.DUMP_AUSENTE];
  const motivos = [];
  if (dump.concluido !== true) motivos.push(MOTIVOS.DUMP_NAO_CONCLUIDO);
  if (!(Number.isSafeInteger(dump.bytes) && dump.bytes > 0)) motivos.push(MOTIVOS.DUMP_VAZIO);
  if (!sha256Valido(dump.sha256Declarado) || !sha256Valido(dump.sha256Recalculado)) motivos.push(MOTIVOS.DUMP_INVALIDO);
  else if (dump.sha256Declarado !== dump.sha256Recalculado) motivos.push(MOTIVOS.DUMP_SHA256_DIVERGENTE);
  return motivos;
}

function provaDesteConjunto(prova, identidade, dump) {
  return ehObjeto(prova) && prova.aprovada === true
    && prova.conjuntoId === identidade.conjuntoId
    && prova.sha256Dump === dump.sha256Recalculado
    && prova.sha256Manifesto === identidade.sha256Manifesto;
}

function avaliarConjunto(entrada) {
  const e = ehObjeto(entrada) ? entrada : {};
  const motivos = [];

  if (!(Number.isInteger(e.saidaDoProcedimento) && e.saidaDoProcedimento === 0)) motivos.push(MOTIVOS.SAIDA_NAO_ZERO);

  if (!ehObjeto(e.relatorio)) motivos.push(MOTIVOS.RELATORIO_AUSENTE);
  else if (e.relatorio.veredito !== 'VALIDO') motivos.push(MOTIVOS.VEREDITO_NAO_VALIDO);

  let copiados = null;
  if (e.manifesto === null || e.manifesto === undefined) motivos.push(MOTIVOS.MANIFESTO_AUSENTE);
  else if (!ehObjeto(e.manifesto) || (copiados = indexarArquivos(e.manifesto.arquivos)) === null) motivos.push(MOTIVOS.MANIFESTO_INVALIDO);

  let exigidos = null;
  if (!Array.isArray(e.listaDoSnapshot)) motivos.push(MOTIVOS.LISTA_DO_SNAPSHOT_AUSENTE);
  else if ((exigidos = indexarArquivos(e.listaDoSnapshot)) === null) motivos.push(MOTIVOS.LISTA_DO_SNAPSHOT_INVALIDA);

  if (copiados !== null && exigidos !== null) {
    for (const [chave, sha256] of exigidos) {
      if (!copiados.has(chave)) motivos.push(MOTIVOS.ARQUIVO_EXIGIDO_AUSENTE);
      else if (copiados.get(chave) !== sha256) motivos.push(MOTIVOS.SHA256_DIVERGENTE);
    }
  }

  if (!ehObjeto(e.verificacao) || e.verificacao.concluida !== true) motivos.push(MOTIVOS.VERIFICACAO_NAO_CONCLUIDA);
  else if (e.verificacao.ok !== true) motivos.push(MOTIVOS.VERIFICACAO_FALHOU);

  motivos.push(...motivosDoDump(e.dump));

  if (!identidadeValida(e.identidade)) motivos.push(MOTIVOS.IDENTIDADE_INVALIDA);

  // E4: correlação contratual das evidências da operação. Aditiva: sem `correlacao` (comparador legado) o veredito não muda e a correlação consta como NÃO satisfeita (CORRELACAO_AUSENTE).
  // Com `correlacao` (caminho integrado), ela precisa ter origem reconhecida e estar satisfeita, e um `relatorio.veredito` literal NUNCA basta: não existe produtor reconhecido do relatório operacional,
  // então o caminho integrado nunca é declarado válido. Correlação contratual satisfeita não é backup operacionalmente válido.
  const correlacaoContratual = avaliarCorrelacao(e.correlacao);
  if (e.correlacao !== undefined) {
    if (!correlacaoContratual.satisfeita) motivos.push(MOTIVOS.CORRELACAO_NAO_SATISFEITA);
    motivos.push(MOTIVOS.RELATORIO_SEM_PROVENIENCIA);
  }

  const unicos = [...new Set(motivos)];
  const valido = unicos.length === 0;
  return Object.freeze({
    valido,
    recuperavel: valido && provaDesteConjunto(e.provaDeRestauracao, e.identidade, e.dump),
    saida: valido ? SAIDAS.VALIDO : SAIDAS.INVALIDO,
    motivos: Object.freeze(unicos),
    correlacaoContratual,
  });
}

// ------------------------------------------------------------------------------------------------------------------------------- janela de backup reconhecida
/**
 * PONTO DE INTEGRAÇÃO AUTORIZADO da trava de janela de escrita para o lado do BACKUP (o único módulo do backup que pode conhecê-la, guarda PRT-07). `criarJanelaDeBackup({ arquivo, raizArmazenamento })` devolve uma capacidade RECONHECIDA
 * (`ehJanelaDeBackup`) cujo `adquirir({ tipo })`: (1) só aceita `{ tipo: BACKUP }` (nunca LIMPEZA nem chaves extras); (2) delega à trava real, de aquisição exclusiva (arquivo `O_EXCL`: a segunda aquisição, do backup ou da limpeza, é JANELA_OCUPADA) e devolve a POSSE
 * GENUÍNA da trava (`confirmarPosse` compara o token do arquivo; posse revogada/trocada não é confirmada; `liberar` só remove o que a posse criou); (3) recusa qualquer posse que a trava não reconheça como sua ou que não seja de BACKUP (a posse é liberada se foi obtida).
 * Quem consome (a composição de produção) exige esta capacidade reconhecida: função arbitrária, objeto literal, clone ou posse simulada NÃO valem como prova de posse operacional.
 */
const janelasDeBackup = new WeakSet();
function criarJanelaDeBackup(opcoes) {
  if (!ehObjeto(opcoes) || Reflect.ownKeys(opcoes).length !== 2 || typeof opcoes.arquivo !== 'string' || typeof opcoes.raizArmazenamento !== 'string') throw new TypeError('janela de backup inválida');
  const { arquivo, raizArmazenamento } = opcoes;
  const janela = Object.freeze({
    async adquirir(entrada) {
      if (!ehObjeto(entrada) || Reflect.ownKeys(entrada).length !== 1 || entrada.tipo !== TIPOS.BACKUP) throw new ErroDeJanela('JANELA_TIPO_INVALIDO');
      const posse = await adquirirJanela({ arquivo, tipo: TIPOS.BACKUP, raizArmazenamento });
      if (!ehPosseDeJanela(posse) || posse.tipo !== TIPOS.BACKUP) {
        try { if (ehObjeto(posse) && ehFuncao(posse.liberar)) await posse.liberar(); } catch { /* a recusa abaixo é o resultado */ }
        throw new ErroDeJanela('JANELA_DOCUMENTO_INVALIDO');
      }
      return posse;
    },
  });
  janelasDeBackup.add(janela);
  return janela;
}
const ehJanelaDeBackup = (valor) => valor !== null && typeof valor === 'object' && janelasDeBackup.has(valor);

module.exports = { criarJanelaDeBackup, ehJanelaDeBackup, executarBackup, avaliarConjunto, SAIDAS, ETAPAS_OBRIGATORIAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO, MOTIVOS };
