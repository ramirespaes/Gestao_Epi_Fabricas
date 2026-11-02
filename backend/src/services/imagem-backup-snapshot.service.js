'use strict';

const { exportarSnapshot } = require('../repositories/imagem-backup-snapshot.repository');
const { listarPadrao, listarEmpresa, identificarBanco } = require('../repositories/imagem-verificacao.repository');
const { ehRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-SNAP-CORE-1): NÚCLEO ISOLADO do snapshot PostgreSQL. Contrato PROVISÓRIO; ainda não
 * integrado ao executor e não validado contra PostgreSQL real. Não lê variável de ambiente, não importa o pool global nem o driver, não cria processo.
 *
 * `criarSnapshot({ criarConexao, temporizador, prazos: { finalizacaoMs }, tamanhoDaPagina?, planejar? })` valida as opções (TypeError) e NÃO cria
 * conexão. Devolve `{ abrir, finalizar, situacao }`:
 *   - `abrir()`, uma vez só: obtém da fábrica uma conexão DEDICADA (objeto com forma de pool ou de cliente de pool é recusado sem ser tocado), registra
 *     ouvintes de `error` e `end` antes de qualquer operação, conecta, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, exporta o snapshot como
 *     PRIMEIRA consulta, identifica o banco e lê as imagens paginadas, tudo no MESMO cliente. Devolve `{ ok: true, contexto }` congelado em profundidade
 *     ({ snapshotId, banco: { nome, oid }, registros: { padrao, empresa }, plano }) ou `{ ok: false, motivo, codigo? }`. Nunca lança, nunca devolve
 *     mensagem do banco e NUNCA encerra a transação: quem encerra é `finalizar()`.
 *   - `finalizar()`, uma vez só: ROLLBACK (se conectou e a conexão não se perdeu) e end(), em sequência, contra UM prazo. `{ concluida: true }` só com
 *     os dois comprovados (ou quando nada foi criado). Falha, prazo esgotado (o pendente não é tratado como feito e nada mais é executado), conexão
 *     perdida, objeto recusado ou segunda chamada: `{ concluida: false }`.
 *   - `situacao()`: `{ fase, conexaoPerdida, eventos }`; eventos limitados, só tipo e código de formato seguro.
 *
 * GREEN-SNAP-CORE-1A (finalização concorrente): `finalizar()` chamada com `abrir()` em andamento CANCELA a abertura, que deixa de começar qualquer
 * operação (connect, BEGIN, consulta ou página) e nunca devolve ok (motivo CANCELADO); o cliente dedicado que a fábrica entregar depois é guardado
 * só para ser encerrado. A finalização ESPERA a operação pendente terminar (dentro do mesmo prazo) antes de ROLLBACK e end(), que nunca rodam junto
 * de um connect ou SQL pendente. Prazo esgotado com a operação pendente: `{ concluida: false }` e nada mais é executado, nem depois (a conexão que
 * sobrar fica para o encerramento do processo; a trava, retida pelo coordenador). ROLLBACK só se o BEGIN foi enviado.
 *
 * P2 (prazo de abertura, OPCIONAL): `prazos.aberturaMs` (sem valor padrão) e `operacoes` (registro de operações pendentes da execução). Vencido o prazo com a abertura ainda em andamento, `abrir()` resolve `{ ok:false, motivo:'ABERTURA_EXPIRADA' }` e a fase vira
 * ABRINDO_EXPIRADA, mas isso é só INFORMAÇÃO: o cancelamento pedido é o contrato interno já existente (a abertura não começa nada novo e nunca publica ok), NADA presume que a conexão foi encerrada nem que a transação foi finalizada, e a operação CONTINUA pendente (`situacao().aberturaPendente`)
 * até a promessa dela assentar. A finalização espera essa pendência dentro do prazo e, se ela não assentar, devolve `{ concluida:false }` (a trava fica com o coordenador). O cliente que chegar tarde é guardado só para ser encerrado.
 *
 * O identificador segue o formato do PostgreSQL 16 (`%08X-%08X-%d`: dois blocos hexadecimais maiúsculos de 8 dígitos e um contador decimal >= 1).
 * O `planejar` injetado (puro e síncrono) é provisório: o planejador definitivo `{ chave, sha256 }` é do PLANO-1.
 */

const MOTIVOS = Object.freeze({
  JA_ABERTO: 'JA_ABERTO',
  CONEXAO_INDISPONIVEL: 'CONEXAO_INDISPONIVEL',
  CONEXAO_INVALIDA: 'CONEXAO_INVALIDA',
  CONEXAO_FALHOU: 'CONEXAO_FALHOU',
  CONEXAO_PERDIDA: 'CONEXAO_PERDIDA',
  BEGIN_FALHOU: 'BEGIN_FALHOU',
  EXPORTACAO_FALHOU: 'EXPORTACAO_FALHOU',
  SNAPSHOT_INVALIDO: 'SNAPSHOT_INVALIDO',
  IDENTIDADE_FALHOU: 'IDENTIDADE_FALHOU',
  IDENTIDADE_INVALIDA: 'IDENTIDADE_INVALIDA',
  CONSULTA_FALHOU: 'CONSULTA_FALHOU',
  CONSULTA_INVALIDA: 'CONSULTA_INVALIDA',
  PLANO_INVALIDO: 'PLANO_INVALIDO',
  CANCELADO: 'CANCELADO',
  ABERTURA_EXPIRADA: 'ABERTURA_EXPIRADA',
});

const FASES = Object.freeze({
  NOVO: 'NOVO', ABRINDO: 'ABRINDO', ABRINDO_EXPIRADA: 'ABRINDO_EXPIRADA', ABERTO: 'ABERTO', FALHOU: 'FALHOU', FINALIZANDO: 'FINALIZANDO', FINALIZADO: 'FINALIZADO',
});

const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const FORMATO_SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const OID_MAXIMO = 4294967295n;
const NOME_MAXIMO_BYTES = 63;
const CONTROLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const ID_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODIGO_SEGURO = /^[A-Za-z0-9_.]{1,40}$/;
const PAGINA_PADRAO = 500;
const PAGINA_MAXIMA = 1000;
const EVENTOS_MAXIMOS = 10;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const inteiroPositivo = (valor) => Number.isSafeInteger(valor) && valor > 0;

function validarOpcoes(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções do snapshot inválidas');
  const { criarConexao, temporizador, prazos, tamanhoDaPagina = PAGINA_PADRAO, planejar, operacoes } = opcoes;
  if (!ehFuncao(criarConexao)) throw new TypeError('fábrica de conexão inválida');
  if (!ehObjeto(temporizador) || !ehFuncao(temporizador.prazo)) throw new TypeError('temporizador inválido');
  if (!ehObjeto(prazos) || !inteiroPositivo(prazos.finalizacaoMs)) throw new TypeError('prazo de finalização inválido');
  if (prazos.aberturaMs !== undefined && !inteiroPositivo(prazos.aberturaMs)) throw new TypeError('prazo de abertura inválido');
  if (!inteiroPositivo(tamanhoDaPagina) || tamanhoDaPagina > PAGINA_MAXIMA) throw new TypeError('tamanho de página inválido');
  if (planejar !== undefined && !ehFuncao(planejar)) throw new TypeError('planejador inválido');
  if (operacoes !== undefined && !ehRegistroDeOperacoes(operacoes)) throw new TypeError('registro de operações inválido');
  return { criarConexao, temporizador, finalizacaoMs: prazos.finalizacaoMs, aberturaMs: prazos.aberturaMs, tamanhoDaPagina, planejar, operacoes: operacoes ?? null };
}

/** Só o código, e só se tiver formato seguro (SQLSTATE ou código do Node); a mensagem e os demais campos nunca saem. */
function codigoSeguro(falha) {
  return falha !== null && typeof falha === 'object' && typeof falha.code === 'string' && CODIGO_SEGURO.test(falha.code) ? falha.code : null;
}

/** Cliente dedicado: precisa das quatro operações e NÃO pode ter a forma de pool nem de cliente emprestado de pool. */
function clienteDedicado(c) {
  if (c === null || typeof c !== 'object') return false;
  if (!ehFuncao(c.connect) || !ehFuncao(c.query) || !ehFuncao(c.end) || !ehFuncao(c.on)) return false;
  return !('release' in c) && !('totalCount' in c) && !('idleCount' in c) && !('waitingCount' in c);
}

function identidadeValida(banco) {
  if (!ehObjeto(banco)) return false;
  const { nome, oid } = banco;
  if (typeof nome !== 'string' || nome === '' || Buffer.byteLength(nome, 'utf8') > NOME_MAXIMO_BYTES || CONTROLE.test(nome)) return false;
  return typeof oid === 'string' && OID.test(oid) && BigInt(oid) <= OID_MAXIMO;
}

class FalhaDaAbertura extends Error {
  constructor(motivo, falha) {
    super(motivo);
    this.motivo = motivo;
    this.codigo = falha === undefined ? null : codigoSeguro(falha);
  }
}

/** Executa um passo; qualquer exceção vira o motivo do passo (com o código seguro, nunca a mensagem). */
async function passo(motivo, fn) {
  try {
    return await fn();
  } catch (falha) {
    if (falha instanceof FalhaDaAbertura) throw falha;
    throw new FalhaDaAbertura(motivo, falha);
  }
}

async function paginar(ler, tamanho, verificar) {
  const todos = [];
  let depoisDe = '0';
  for (;;) {
    verificar();
    const pagina = await passo(MOTIVOS.CONSULTA_FALHOU, () => ler(depoisDe));
    verificar();
    if (!Array.isArray(pagina) || pagina.length > tamanho) throw new FalhaDaAbertura(MOTIVOS.CONSULTA_INVALIDA);
    for (const linha of pagina) {
      if (!ehObjeto(linha) || typeof linha.id !== 'string' || !ID_DECIMAL.test(linha.id)) throw new FalhaDaAbertura(MOTIVOS.CONSULTA_INVALIDA);
      todos.push(Object.freeze({ ...linha }));
    }
    if (pagina.length < tamanho) return Object.freeze(todos);
    const ultimo = pagina[pagina.length - 1].id;
    if (BigInt(ultimo) <= BigInt(depoisDe)) throw new FalhaDaAbertura(MOTIVOS.CONSULTA_INVALIDA);
    depoisDe = ultimo;
  }
}

function montarPlano(planejar, registros) {
  if (planejar === undefined) return null;
  let plano;
  try {
    plano = planejar(registros);
  } catch {
    throw new FalhaDaAbertura(MOTIVOS.PLANO_INVALIDO);
  }
  if (!Array.isArray(plano)) throw new FalhaDaAbertura(MOTIVOS.PLANO_INVALIDO);
  return Object.freeze(plano.map((item) => {
    if (!ehObjeto(item) || typeof item.chave !== 'string' || item.chave === '' || CONTROLE.test(item.chave)
      || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) throw new FalhaDaAbertura(MOTIVOS.PLANO_INVALIDO);
    return Object.freeze({ chave: item.chave, sha256: item.sha256 });
  }));
}

function criarSnapshot(opcoes) {
  const { criarConexao, temporizador, finalizacaoMs, aberturaMs, tamanhoDaPagina, planejar, operacoes } = validarOpcoes(opcoes);

  let fase = FASES.NOVO;
  let cliente = null; // só o cliente dedicado aceito; um objeto recusado nunca é guardado aqui
  let recusado = false; // a fábrica devolveu algo que não é nosso: não há como comprovar o encerramento
  let conectado = false;
  let transacaoIniciada = false; // o BEGIN foi enviado (mesmo que tenha falhado): a finalização manda ROLLBACK
  let encerrando = false;
  let cancelado = false; // GREEN-SNAP-CORE-1A: a finalização foi pedida; a abertura não começa nada novo e nunca publica ok
  let aberturaPendente = null; // a promessa da abertura em andamento (nunca rejeita): a finalização espera por ela, dentro do prazo
  let aberturaAssentada = false; // só vira true quando a promessa REAL da abertura assenta (nunca por prazo): é o que `situacao().aberturaPendente` informa
  let aberturaExpirada = false;
  let idDaAbertura = null;
  let conexaoPerdida = false;
  let finalizacaoChamada = false;
  const eventos = [];

  function anotar(tipo, falha) {
    if (encerrando) return;
    conexaoPerdida = true;
    if (eventos.length >= EVENTOS_MAXIMOS) return;
    const codigo = tipo === 'ERRO' ? codigoSeguro(falha) : null;
    eventos.push(Object.freeze(codigo === null ? { tipo } : { tipo, codigo }));
  }

  const falhar = (motivo, codigo = null) => {
    if (!finalizacaoChamada) fase = FASES.FALHOU;
    return Object.freeze(codigo === null ? { ok: false, motivo } : { ok: false, motivo, codigo });
  };

  /** Antes e depois de cada operação da abertura: pedida a finalização, nada novo começa e nada é publicado. */
  function verificar() {
    if (cancelado) throw new FalhaDaAbertura(MOTIVOS.CANCELADO);
  }

  function abrir() {
    if (fase !== FASES.NOVO || finalizacaoChamada) return Promise.resolve(Object.freeze({ ok: false, motivo: MOTIVOS.JA_ABERTO }));
    fase = FASES.ABRINDO;
    if (operacoes === null) {
      aberturaPendente = executarAbertura();
    } else {
      // a abertura é registrada como operação pendente; o contrato interno de cancelamento é o `cancelado` (nada novo começa, nunca publica ok)
      const rastreada = operacoes.rastrear({ etapa: 'ABERTURA_SNAPSHOT', recursos: ['SNAPSHOT', 'CONEXAO'], aoCancelar: () => { cancelado = true; } }, () => executarAbertura());
      idDaAbertura = rastreada.id;
      aberturaPendente = rastreada.assentada.then((r) => (r.desfecho === 'RESOLVIDA' ? r.valor : falhar(MOTIVOS.CONSULTA_FALHOU)));
    }
    const real = aberturaPendente;
    real.then(() => { aberturaAssentada = true; });
    if (aberturaMs === undefined) return real;
    // P2: o vencimento do prazo NÃO encerra nada; informa ABERTURA_EXPIRADA e pede o cancelamento pelo contrato interno. A promessa real segue sendo a pendência.
    return new Promise((resolver) => {
      const prazo = temporizador.prazo(aberturaMs);
      let decidido = false;
      real.then((r) => {
        if (decidido) return;
        decidido = true;
        try { prazo.cancelar(); } catch { /* higiene */ }
        resolver(r);
      });
      Promise.resolve(prazo.promessa).then(() => {
        if (decidido || fase !== FASES.ABRINDO || cancelado) return;
        decidido = true;
        aberturaExpirada = true;
        fase = FASES.ABRINDO_EXPIRADA;
        if (operacoes !== null) operacoes.solicitarCancelamento('ABERTURA_EXPIRADA', { id: idDaAbertura });
        else cancelado = true;
        resolver(Object.freeze({ ok: false, motivo: MOTIVOS.ABERTURA_EXPIRADA }));
      }, () => {});
    });
  }

  async function executarAbertura() {
    let candidato;
    try {
      candidato = await criarConexao();
    } catch (falha) {
      return falhar(cancelado ? MOTIVOS.CANCELADO : MOTIVOS.CONEXAO_INDISPONIVEL, cancelado ? null : codigoSeguro(falha));
    }
    if (!clienteDedicado(candidato)) {
      recusado = candidato !== null && candidato !== undefined;
      return falhar(cancelado ? MOTIVOS.CANCELADO : MOTIVOS.CONEXAO_INVALIDA);
    }
    // O cliente dedicado é guardado mesmo se a finalização já foi pedida: é ela que o encerra (sem conectar nem consultar).
    cliente = candidato;
    // Antes de qualquer operação: um 'error' sem ouvinte derrubaria o processo, e um encerramento inesperado invalida o recurso.
    cliente.on('error', (falha) => anotar('ERRO', falha));
    cliente.on('end', () => anotar('ENCERRAMENTO'));

    try {
      verificar();
      await passo(MOTIVOS.CONEXAO_FALHOU, () => cliente.connect());
      conectado = true;
      verificar();
      transacaoIniciada = true;
      await passo(MOTIVOS.BEGIN_FALHOU, () => cliente.query(BEGIN));
      verificar();
      const snapshotId = await passo(MOTIVOS.EXPORTACAO_FALHOU, () => exportarSnapshot(cliente));
      verificar();
      if (typeof snapshotId !== 'string' || !FORMATO_SNAPSHOT.test(snapshotId)) throw new FalhaDaAbertura(MOTIVOS.SNAPSHOT_INVALIDO);
      const banco = await passo(MOTIVOS.IDENTIDADE_FALHOU, () => identificarBanco(cliente));
      verificar();
      if (!identidadeValida(banco)) throw new FalhaDaAbertura(MOTIVOS.IDENTIDADE_INVALIDA);
      const padrao = await paginar((depoisDe) => listarPadrao(cliente, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina, verificar);
      const empresa = await paginar((depoisDe) => listarEmpresa(cliente, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina, verificar);
      const registros = Object.freeze({ padrao, empresa });
      const plano = montarPlano(planejar, registros);
      // Do último teste até o return não há await: a finalização pedida antes deste ponto nunca vê um ok publicado.
      verificar();
      if (conexaoPerdida) return falhar(MOTIVOS.CONEXAO_PERDIDA);
      fase = FASES.ABERTO;
      const contexto = Object.freeze({
        snapshotId, banco: Object.freeze({ nome: banco.nome, oid: banco.oid }), registros, plano,
      });
      return Object.freeze({ ok: true, contexto });
    } catch (falha) {
      if (cancelado) return falhar(MOTIVOS.CANCELADO);
      if (conexaoPerdida) return falhar(MOTIVOS.CONEXAO_PERDIDA);
      if (falha instanceof FalhaDaAbertura) return falhar(falha.motivo, falha.codigo);
      return falhar(MOTIVOS.CONSULTA_FALHOU);
    }
  }

  /**
   * Contra UM prazo, em sequência e sem nada simultâneo: (1) espera a abertura em andamento terminar (ela já não começa nada novo); (2) ROLLBACK, se
   * o BEGIN foi enviado; (3) end(). O que não terminar dentro do prazo não é tratado como feito, e depois do prazo nada mais é executado (nem end()
   * junto de um connect ou de um SQL ainda pendentes).
   */
  async function encerrar() {
    const prazo = temporizador.prazo(finalizacaoMs);
    const venceu = Symbol('prazo');
    const vencido = Promise.resolve(prazo.promessa).then(() => venceu);
    const dentroDoPrazo = (operacao) => Promise.race([
      Promise.resolve().then(operacao).then(() => true, () => false),
      vencido,
    ]);
    try {
      if (aberturaPendente !== null && (await dentroDoPrazo(() => aberturaPendente)) !== true) return false;
      if (cliente === null) return !recusado;
      let comprovado = true;
      if (conectado && transacaoIniciada && !conexaoPerdida) {
        const rollback = await dentroDoPrazo(() => cliente.query('ROLLBACK'));
        if (rollback === venceu) return false;
        if (rollback !== true) comprovado = false;
      }
      if (conexaoPerdida) comprovado = false;
      encerrando = true;
      const fim = await dentroDoPrazo(() => cliente.end());
      if (fim !== true) return false;
      return comprovado;
    } finally {
      try { prazo.cancelar(); } catch { /* cancelar o prazo é só higiene */ }
    }
  }

  async function finalizar() {
    if (finalizacaoChamada) return Object.freeze({ concluida: false });
    finalizacaoChamada = true;
    cancelado = true;
    fase = FASES.FINALIZANDO;
    let concluida;
    if (cliente === null && aberturaPendente === null) {
      concluida = !recusado; // nada foi criado nem está sendo criado: nada a encerrar
    } else {
      try {
        concluida = await encerrar();
      } catch {
        concluida = false;
      }
    }
    fase = FASES.FINALIZADO;
    return Object.freeze({ concluida: concluida === true });
  }

  function situacao() {
    return Object.freeze({ fase, conexaoPerdida, eventos: Object.freeze([...eventos]), aberturaPendente: aberturaPendente !== null && !aberturaAssentada, aberturaExpirada });
  }

  return Object.freeze({ abrir, finalizar, situacao });
}

module.exports = { criarSnapshot, MOTIVOS, FASES, FORMATO_SNAPSHOT };
