'use strict';

const { SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('./imagem-backup.service');
const { criarSnapshot } = require('./imagem-backup-snapshot.service');
const { executarBackupSupervisionado } = require('./imagem-backup-executor.service');
const { ehObservadorDoDump, ID_DA_OPERACAO } = require('./imagem-backup-evidencia-dump.service');
const { ehVerificadorEstrutural } = require('./imagem-backup-estrutura.service');
const { ehRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-OP-SNAP-BIND-1): ENTRADA OPERACIONAL que VINCULA o ciclo de vida do snapshot ao executor
 * supervisionado. Contrato PROVISÓRIO; não executa pg_dump, restauração nem cópia reais, e nada aqui prova que um backup é recuperável.
 *
 * `executarBackupOperacional(dependencias)`: `dependencias` é ESTRITO (janela, conexao, processoDoDump, copia, avaliar e, opcional, parada); qualquer
 * outra chave (inclusive símbolos), dependência ausente ou valor inválido é recusado ANTES da trava e de qualquer conexão (saída 2, sem efeito).
 * `conexao` é só a infraestrutura do snapshot ({ criarConexao, temporizador, prazos: { finalizacaoMs }, tamanhoDaPagina?, planejar? }): o chamador não
 * fornece `snapshot`, `finalizar`, `abrir` nem `criarSnapshot`.
 *
 * Vínculo: UMA instância de `criarSnapshot` por operação; a etapa `snapshot` é o `abrir()` dela e a finalização é o `finalizar()` DELA, ligados ao
 * executor supervisionado, que a repassa ao coordenador (quando, se e quantas vezes rodar, e o que isso significa para a trava, são regras dele). Não
 * existe caminho com a trava adquirida sem a finalização ligada. `processoDoDump(contexto)` e `copia(contexto)` recebem o MESMO contexto validado do
 * snapshot aberto.
 *
 * TOCTOU: cada propriedade do chamador é lida UMA vez, numa captura única e síncrona, antes de qualquer await; depois disso só se usam os valores
 * capturados (nunca o objeto do chamador, que também não é alterado). Leitura que lança (por exemplo, um getter) é dependência inválida.
 *
 * Sigilo: o resultado é o do executor (só códigos fixos); uma exceção inesperada vira um resultado genérico, nunca a mensagem. Este módulo não registra
 * log. `recuperavel` é SEMPRE false.
 *
 * LIMITES: `criarConexao` continua injetada pelo chamador (infraestrutura): este módulo não prova que ela abre um PostgreSQL de verdade nem autentica o
 * banco de destino. O limite de página (1 a 1000) espelha o de `criarSnapshot`.
 */

const TOPO = new Set(['janela', 'conexao', 'processoDoDump', 'copia', 'avaliar', 'parada', 'integracao', 'controle']);
const CONEXAO = new Set(['criarConexao', 'temporizador', 'prazos', 'tamanhoDaPagina', 'planejar']);
const PAGINA_MAXIMA = 1000;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const inteiroPositivo = (valor) => Number.isSafeInteger(valor) && valor > 0;
const chavesConhecidas = (objeto, permitidas) => Reflect.ownKeys(objeto).every((chave) => typeof chave === 'string' && permitidas.has(chave));

function recusa() {
  return Object.freeze({
    saida: SAIDAS.ARGUMENTOS,
    valido: false,
    recuperavel: false,
    janela: ESTADOS_DA_JANELA.NAO_ADQUIRIDA,
    etapasExecutadas: Object.freeze([]),
    motivos: Object.freeze([]),
    sinal: null,
    finalizacao: ESTADOS_DA_FINALIZACAO.NAO_APLICAVEL,
    supervisao: null,
  });
}

/** Resultado genérico de uma exceção inesperada: o estado da trava é desconhecido, então nunca se declara liberada. */
function falhaInesperada() {
  return Object.freeze({
    saida: SAIDAS.ERRO,
    valido: false,
    recuperavel: false,
    janela: ESTADOS_DA_JANELA.NAO_LIBERADA,
    etapasExecutadas: Object.freeze([]),
    motivos: Object.freeze(['ERRO_INTERNO']),
    sinal: null,
    finalizacao: ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA,
    supervisao: null,
  });
}

/**
 * Valida e captura as dependências numa passada só: cada propriedade do chamador é lida uma vez e daqui em diante só os valores capturados valem.
 * Devolve null se qualquer coisa for inválida (inclusive leitura que lance).
 */
function capturar(dependencias) {
  try {
    if (!ehObjeto(dependencias) || !chavesConhecidas(dependencias, TOPO)) return null;
    const janela = dependencias.janela;
    const conexao = dependencias.conexao;
    const processoDoDump = dependencias.processoDoDump;
    const copia = dependencias.copia;
    const avaliar = dependencias.avaliar;
    const parada = Object.hasOwn(dependencias, 'parada') ? dependencias.parada : undefined;
    // E1/E3': identidade da operação + observador do dump PRODUZIDO por `criarObservadorDoDump` (a validação final é do executor; aqui só se captura uma vez).
    let integracao = null;
    if (Object.hasOwn(dependencias, 'integracao')) {
      const bruta = dependencias.integracao;
      if (!ehObjeto(bruta)) return null;
      const operacaoId = bruta.operacaoId;
      const observador = bruta.observador;
      if (typeof operacaoId !== 'string' || !ID_DA_OPERACAO.test(operacaoId) || !ehObservadorDoDump(observador)) return null;
      integracao = { operacaoId, observador };
      if (Object.hasOwn(bruta, 'verificadorEstrutural')) {
        const verificadorEstrutural = bruta.verificadorEstrutural;
        if (!ehVerificadorEstrutural(verificadorEstrutural)) return null;
        integracao.verificadorEstrutural = verificadorEstrutural;
      }
    }

    if (!ehObjeto(janela)) return null;
    const adquirir = janela.adquirir;
    if (!ehFuncao(adquirir)) return null;
    if (!ehFuncao(processoDoDump) || !ehFuncao(copia) || !ehFuncao(avaliar)) return null;

    let aoPedir = null;
    if (parada !== undefined && parada !== null) {
      if (!ehObjeto(parada)) return null;
      aoPedir = parada.aoPedir;
      if (!ehFuncao(aoPedir)) return null;
    }

    // P2/P3 (opcional): `controle` = { registro, etapaMs?, posseMs? }; a forma é conferida de novo pelo coordenador, antes da trava. Aqui só se captura UMA vez e se confere o registro (que também liga o snapshot ao mesmo registro).
    let controle = null;
    if (Object.hasOwn(dependencias, 'controle')) {
      const bruto = dependencias.controle;
      if (!ehObjeto(bruto) || !ehRegistroDeOperacoes(bruto.registro)) return null;
      controle = { registro: bruto.registro };
      for (const k of ['etapaMs', 'posseMs']) if (Object.hasOwn(bruto, k)) controle[k] = bruto[k];
      Object.freeze(controle);
    }
    if (!ehObjeto(conexao) || !chavesConhecidas(conexao, CONEXAO)) return null;
    const criarConexao = conexao.criarConexao;
    const temporizador = conexao.temporizador;
    const prazos = conexao.prazos;
    const tamanhoDaPagina = Object.hasOwn(conexao, 'tamanhoDaPagina') ? conexao.tamanhoDaPagina : undefined;
    const planejar = Object.hasOwn(conexao, 'planejar') ? conexao.planejar : undefined;
    if (!ehFuncao(criarConexao)) return null;
    if (!ehObjeto(temporizador)) return null;
    const prazo = temporizador.prazo;
    if (!ehFuncao(prazo)) return null;
    if (!ehObjeto(prazos)) return null;
    const finalizacaoMs = prazos.finalizacaoMs;
    if (!inteiroPositivo(finalizacaoMs)) return null;
    const aberturaMs = Object.hasOwn(prazos, 'aberturaMs') ? prazos.aberturaMs : undefined;
    if (aberturaMs !== undefined && !inteiroPositivo(aberturaMs)) return null;
    if (tamanhoDaPagina !== undefined && !(inteiroPositivo(tamanhoDaPagina) && tamanhoDaPagina <= PAGINA_MAXIMA)) return null;
    if (planejar !== undefined && !ehFuncao(planejar)) return null;

    return {
      janela: Object.freeze({ adquirir: (...argumentos) => adquirir.apply(janela, argumentos) }),
      processoDoDump,
      copia,
      avaliar,
      integracao,
      controle,
      parada: aoPedir === null ? null : Object.freeze({ aoPedir: (...argumentos) => aoPedir.apply(parada, argumentos) }),
      snapshot: {
        criarConexao,
        temporizador: Object.freeze({ prazo: (...argumentos) => prazo.apply(temporizador, argumentos) }),
        prazos: Object.freeze({ finalizacaoMs, ...(aberturaMs === undefined ? {} : { aberturaMs }) }),
        ...(tamanhoDaPagina === undefined ? {} : { tamanhoDaPagina }),
        ...(planejar === undefined ? {} : { planejar }),
        ...(controle === null ? {} : { operacoes: controle.registro }),
      },
    };
  } catch {
    return null;
  }
}

async function executarBackupOperacional(dependencias) {
  const capturadas = capturar(dependencias);
  if (capturadas === null) return recusa();

  let instancia;
  try {
    instancia = criarSnapshot(capturadas.snapshot);
  } catch {
    return recusa();
  }

  let contexto = null;
  // P1: PROVAS observadas pela própria entrada para decidir, numa exceção inesperada, se a finalização do snapshot é segura. Cada flag só passa de falso a verdadeiro por uma invocação real e `abrindo` só volta a falso quando a promessa de `abrir()` ASSENTA.
  const provas = { dumpIniciado: false, abrindo: false, copiaIniciada: false, finalizacaoPedida: false };
  try {
    const resultado = await executarBackupSupervisionado({
      janela: capturadas.janela,
      // A etapa snapshot é o abrir() da instância; só o sucesso e o contexto saem dela (motivo e código de falha não são repassados).
      async snapshot() {
        provas.abrindo = true;
        try {
          const aberto = await instancia.abrir();
          if (aberto !== null && typeof aberto === 'object' && aberto.ok === true) {
            contexto = aberto.contexto;
            return { ok: true };
          }
          return { ok: false };
        } finally {
          provas.abrindo = false;
        }
      },
      processoDoDump: () => { provas.dumpIniciado = true; return capturadas.processoDoDump(contexto); },
      // Com integração, o executor entrega a informação da operação; a cópia recebe o contexto do snapshot ENRIQUECIDO (as chaves originais permanecem).
      copia: (informacao) => { provas.copiaIniciada = true; return informacao === undefined ? capturadas.copia(contexto) : capturadas.copia(Object.freeze({ ...contexto, ...informacao })); },
      avaliar: capturadas.avaliar,
      ...(capturadas.integracao === null ? {} : { integracao: Object.freeze({ ...capturadas.integracao, snapshotId: () => (contexto === null ? null : contexto.snapshotId) }) }),
      // A finalização é SEMPRE a da MESMA instância que abriu a transação; o chamador não pode trocá-la.
      // Com registro de operações, a finalização é reivindicada UMA vez (a segunda tentativa, de qualquer caminho, não finaliza nada) e só roda sem operação pendente além da abertura do snapshot, que a PRÓPRIA finalização aguarda.
      finalizar: () => {
        if (capturadas.controle !== null) {
          if (capturadas.controle.registro.pendentes().some((p) => p.etapa !== 'ABERTURA_SNAPSHOT')) return { concluida: false };
          if (!capturadas.controle.registro.reivindicar('FINALIZACAO_SNAPSHOT')) return { concluida: false };
        }
        provas.finalizacaoPedida = true;
        return instancia.finalizar();
      },
      ...(capturadas.parada === null ? {} : { parada: capturadas.parada }),
      ...(capturadas.controle === null ? {} : { controle: capturadas.controle }),
    });
    return Object.freeze({ ...resultado, recuperavel: false });
  } catch {
    return falhaInesperadaComFinalizacaoSegura(instancia, provas, capturadas.controle === null ? null : capturadas.controle.registro);
  }
}

/**
 * P1 — exceção inesperada do executor. O snapshot só é finalizado quando HÁ PROVA de que isso não invalida nada ativo: o dump NUNCA foi iniciado, nenhuma abertura do snapshot está pendente (a promessa de `abrir()` já assentou), a cópia nunca começou, a finalização não foi pedida antes (a
 * instância só finaliza uma vez) e a instância está numa fase conhecida (NOVO, ABERTO ou FALHOU). Qualquer dúvida — dump possivelmente ativo, abertura pendente, fase desconhecida ou `situacao()` que lance — deixa o snapshot como está (INCONCLUSIVO) e a trava RETIDA. Esta função NUNCA solta a
 * trava (ela pertence ao coordenador); `finalizacao` só vira CONCLUIDA com `{ concluida: true }` da própria instância. Uma Promise que rejeitou ou expirou NÃO é prova de nada: o que vale são as flags acima.
 */
async function falhaInesperadaComFinalizacaoSegura(instancia, provas, registro = null) {
  const base = falhaInesperada();
  let fase = null;
  let aberturaPendente = false;
  try {
    const situacao = instancia.situacao();
    fase = situacao.fase;
    // P2: a promessa de `abrir()` pode ter resolvido por prazo (ABERTURA_EXPIRADA) com a abertura REAL ainda pendente; só o assentamento real conta
    aberturaPendente = situacao.aberturaPendente === true;
  } catch { fase = null; }
  // P3: operação rastreada pendente (ou registro ilegível) significa recurso possivelmente em uso: não finaliza
  let semPendencia = true;
  if (registro !== null) { try { semPendencia = registro.pendentes().length === 0; } catch { semPendencia = false; } }
  const seguro = provas.dumpIniciado === false && provas.abrindo === false && aberturaPendente === false && semPendencia && provas.copiaIniciada === false && provas.finalizacaoPedida === false && (fase === 'NOVO' || fase === 'ABERTO' || fase === 'FALHOU');
  if (!seguro) return base;
  // reivindicação única: um caminho que já finalizou não finaliza de novo
  if (registro !== null && !registro.reivindicar('FINALIZACAO_SNAPSHOT')) return base;
  let concluida = false;
  try {
    const f = await instancia.finalizar();
    concluida = f !== null && typeof f === 'object' && f.concluida === true;
  } catch {
    concluida = false;
  }
  return concluida ? Object.freeze({ ...base, finalizacao: ESTADOS_DA_FINALIZACAO.CONCLUIDA }) : base;
}

module.exports = { executarBackupOperacional };
