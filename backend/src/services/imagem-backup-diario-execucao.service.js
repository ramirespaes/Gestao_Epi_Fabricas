'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): REGISTRO DURÁVEL DE EXECUÇÃO (diário), TRAVAS DE TENTATIVA E DE RECURSO e RECONCILIAÇÃO. Existe para que a morte do runner (ou de uma sentinela) não destrua o que é preciso saber para recuperar uma tentativa com segurança.
 * O registro é RASTREABILIDADE e RECONCILIAÇÃO: ele NUNCA concede autoridade para sinalizar um processo (isso só pertence a quem lançou o filho e guarda o seu handle; ver imagem-backup-sentinela.service).
 *
 * Formato: um arquivo NDJSON por ESCRITOR (`runner`, `sentinela-<lancamento>`, `recuperador-…`, `humano-…`), criado de forma EXCLUSIVA (O_EXCL|O_NOFOLLOW, 0600) em `<raiz>/tentativas/<tentativa>/` (0700). Cada linha é um evento completo com sequência `n` contínua, instante `t`, encadeamento
 * `p` (hash da linha anterior) e `h` (SHA-256 do conteúdo + `p`). Um escritor só aceita o próximo evento depois de a linha inteira ter sido escrita (laço de escrita parcial) e sincronizada (fsync; fsync do diretório na criação). Qualquer falha ENVENENA o diário: nenhum outro evento é aceito.
 * A leitura rejeita: linha final sem quebra de linha (TRUNCADO), JSON inválido, sequência/encadeamento/hash contraditórios (CONTRADITORIO) e arquivo inseguro (INSEGURO: link, não regular, dono ou permissão). Um arquivo por escritor evita que dois escritores intercalem linhas.
 * Os eventos têm formato FECHADO: tipo conhecido, campos exatos e valores restritos (sem argumentos, caminhos de senha, tokens, URLs ou strings de conexão); chaves com senha/segredo/token/URL/DSN são recusadas.
 *
 * Reconciliação (`reconciliar`): somente leitura e idempotente. Estados: CONCLUIDA (nada vivo ou desconhecido), EM_ANDAMENTO (há autoridade viva, aguardar), PARCIAL (parte resolvida, pendência identificada), INCONCLUSIVA (identidade ou encerramento não demonstrado) e BLOQUEADA (registro contraditório ou inseguro). A observação de processo é uma porta: só
 * 'VIVO' e 'AUSENTE' são respostas válidas; erro, ausência ou qualquer outra resposta vale INCONCLUSIVO e nunca "morto". Só CONCLUIDA libera nova tentativa. A janela entre a intenção e a identidade do filho NÃO é eliminada: ela produz LANCAMENTO_SEM_IDENTIDADE, que bloqueia.
 * O PostgreSQL efêmero tem sentinela própria (papel `postgres`, ver imagem-backup-postmaster-sentinela): a autoridade e o desfecho vêm do lançamento, como nos clientes; o SIGQUIT de emergência (evento POSTMASTER_EMERGENCIA) é encerramento ANORMAL e nunca CONCLUIDA. Só no modo antigo (sem lançamento
 * `postgres`, o runner como dono) vale: runner morto sem encerramento comprovado da instância é POSTGRES_SEM_AUTORIDADE (INCONCLUSIVA) e exige intervenção específica.
 * CONCLUIDA fala só de PROCESSOS e RECURSOS (`escopo`): `comprovaBackupIntegro` é sempre false; selagem, verificação e publicação do backup não passam por aqui.
 *
 * Travas: `tentativa-<id>.lock` (uma tentativa, um dono) e `recurso-<tipo>-<hash>.lock` (área, PGDATA, socket, porta, destino) em `<raiz>/travas/`, criação exclusiva, tudo ou nada. Trava NUNCA é removida porque o dono sumiu: só `liberarRecursosDeTentativaConcluida`, depois de a tentativa reconciliar CONCLUIDA.
 */

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ESCRITOR = /^[a-z0-9][a-z0-9-]{0,79}$/;
const LANCAMENTO = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODIGO = /^[A-Z][A-Z0-9_]{1,63}$/;
const SINAL = /^SIG[A-Z0-9]{2,12}$/;
const PAPEL = /^[a-z][a-z0-9_]{1,31}$/;
const EXECUTAVEL = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const RESPONSAVEL = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;
const CHAVE_PROIBIDA = /senha|passw|secret|segredo|token|dsn|url|credencial|chave/i;
const TIPOS_DE_RECURSO = Object.freeze(['area', 'pgdata', 'socket', 'porta', 'destino']);
const MAX_RECURSOS = 16;
const ZEROS = '0'.repeat(64);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pid = (v) => Number.isSafeInteger(v) && v > 1;
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && !v.includes('\0') && v[0] === '/' && path.normalize(v) === v && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const boolOuNulo = (v) => typeof v === 'boolean' || v === null;
const saidaOuNulo = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 255);
const sinalOuNulo = (v) => v === null || (typeof v === 'string' && SINAL.test(v));
const textoCurto = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v);

/** Esquema FECHADO de cada evento: campo -> [validador, obrigatório]. Qualquer campo fora do esquema é recusado. */
const ESQUEMA = Object.freeze({
  TENTATIVA_INICIADA: { runnerPid: [pid, true], area: [caminhoAbsoluto, false], pgdata: [caminhoAbsoluto, false] },
  INTENCAO_LANCAMENTO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], papel: [(v) => PAPEL.test(v), true], executavel: [(v) => EXECUTAVEL.test(v), true], nArgs: [(v) => Number.isInteger(v) && v >= 0 && v <= 256, true], argsSha256: [(v) => SHA256.test(v), true] },
  LANCAMENTO_NAO_INICIADO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], codigo: [(v) => CODIGO.test(v), true] },
  SENTINELA_LANCADA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], sentinelaPid: [pid, true] },
  SENTINELA_ATIVA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], sentinelaPid: [pid, true] },
  CLIENTE_LANCADO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], clientePid: [pid, true] },
  LANCAMENTO_FALHOU: { lancamentoId: [(v) => LANCAMENTO.test(v), true], codigo: [(v) => CODIGO.test(v), true] },
  PARADA_SOLICITADA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], origem: [(v) => CODIGO.test(v), true], sinal: [(v) => SINAL.test(v), true] },
  SINAL_ENVIADO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], sinal: [(v) => SINAL.test(v), true], aceito: [(v) => typeof v === 'boolean', true] },
  ORFANDADE_DETECTADA: { lancamentoId: [(v) => LANCAMENTO.test(v), true] },
  MENSAGEM_REJEITADA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], motivo: [(v) => CODIGO.test(v), true] },
  CLIENTE_ENCERRADO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], codigo: [saidaOuNulo, true], sinal: [sinalOuNulo, true] },
  GRUPO_VERIFICADO: { lancamentoId: [(v) => LANCAMENTO.test(v), true], vazio: [boolOuNulo, true] },
  SENTINELA_FIM: { lancamentoId: [(v) => LANCAMENTO.test(v), true], resultado: [(v) => CODIGO.test(v), true] },
  POSTMASTER_ORDEM: { lancamentoId: [(v) => LANCAMENTO.test(v), true], clientes: [(v) => CODIGO.test(v), true] },
  POSTMASTER_EMERGENCIA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], sinal: [(v) => SINAL.test(v), true] },
  IDENTIDADE_NAO_COMPROVADA: { lancamentoId: [(v) => LANCAMENTO.test(v), true], fase: [(v) => CODIGO.test(v), true], motivo: [(v) => CODIGO.test(v), true] },
  POSTGRES_INTENCAO: {},
  POSTGRES_IDENTIDADE: { pid: [pid, true], area: [caminhoAbsoluto, true] },
  POSTGRES_ENCERRADO: { resultado: [(v) => CODIGO.test(v), true] },
  PARADA_DO_RUNNER: { sinal: [(v) => SINAL.test(v), true] },
  TENTATIVA_FIM: { resultado: [(v) => CODIGO.test(v), true] },
  RESOLUCAO_HUMANA: { responsavel: [(v) => typeof v === 'string' && RESPONSAVEL.test(v), true], observacao: [textoCurto, true] },
  RECURSOS_LIBERADOS: { quantidade: [(v) => Number.isInteger(v) && v >= 0 && v <= 64, true] },
});

function erro(codigo, extra = {}) {
  const falha = new Error('registro durável de execução');
  falha.code = codigo;
  return Object.assign(falha, extra);
}
const configuracaoInvalida = () => erro('CONFIGURACAO_INVALIDA');

function validarEvento(tipo, dados) {
  const esquema = typeof tipo === 'string' ? ESQUEMA[tipo] : undefined;
  if (esquema === undefined || !ehObjeto(dados)) throw erro('EVENTO_INVALIDO');
  const chaves = Reflect.ownKeys(dados);
  for (const chave of chaves) {
    if (typeof chave !== 'string' || CHAVE_PROIBIDA.test(chave) || !Object.hasOwn(esquema, chave)) throw erro('EVENTO_INVALIDO');
  }
  for (const [campo, [valida, obrigatorio]] of Object.entries(esquema)) {
    if (!Object.hasOwn(dados, campo)) { if (obrigatorio) throw erro('EVENTO_INVALIDO'); continue; }
    if (valida(dados[campo]) !== true) throw erro('EVENTO_INVALIDO');
  }
}

/** Serialização canônica (chaves ordenadas) para o hash: a mesma entrada produz sempre os mesmos bytes. */
function canonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
}
const hashDoEvento = (anterior, corpo) => crypto.createHash('sha256').update(`${anterior}|${canonico(corpo)}`).digest('hex');

// ------------------------------------------------------------------------------------------------------------------ segurança do sistema de arquivos
function exigirRaiz(raiz, sistema) {
  if (typeof raiz !== 'string' || !caminhoAbsoluto(raiz)) throw configuracaoInvalida();
  let e;
  try { e = sistema.lstatSync(raiz); } catch { throw erro('RAIZ_INSEGURA'); }
  if (e.isSymbolicLink() || !e.isDirectory() || (typeof process.getuid === 'function' && e.uid !== process.getuid()) || (e.mode & 0o077) !== 0) throw erro('RAIZ_INSEGURA');
  if (sistema.realpathSync(raiz) !== raiz) throw erro('RAIZ_INSEGURA');
}
function exigirDiretorioProprio(dir, sistema) {
  const e = sistema.lstatSync(dir);
  if (e.isSymbolicLink() || !e.isDirectory() || (typeof process.getuid === 'function' && e.uid !== process.getuid()) || (e.mode & 0o077) !== 0) throw erro('DIRETORIO_INSEGURO');
}
function sincronizarDiretorio(dir, sistema) {
  const fd = sistema.openSync(dir, sistema.constants.O_RDONLY);
  try { sistema.fsyncSync(fd); } finally { sistema.closeSync(fd); }
}
function validarIds({ tentativaId, escritor }) {
  if (typeof tentativaId !== 'string' || !ID.test(tentativaId)) throw configuracaoInvalida();
  if (escritor !== undefined && (typeof escritor !== 'string' || !ESCRITOR.test(escritor))) throw configuracaoInvalida();
}
const dirDaTentativa = (raiz, tentativaId) => path.join(raiz, 'tentativas', tentativaId);

// ------------------------------------------------------------------------------------------------------------------ escritor
function criarEscritor({ raiz, tentativaId, escritor, sistema, relogio }) {
  const arquivo = path.join(dirDaTentativa(raiz, tentativaId), `${escritor}.ndjson`);
  const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW } = sistema.constants;
  let fd;
  try {
    fd = sistema.openSync(arquivo, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_NOFOLLOW, 0o600);
  } catch (falha) {
    throw erro(falha && falha.code === 'EEXIST' ? 'ESCRITOR_JA_EXISTE' : 'DIARIO_NAO_CRIADO');
  }
  try {
    const e = sistema.fstatSync(fd);
    if (!e.isFile() || e.nlink !== 1 || (typeof process.getuid === 'function' && e.uid !== process.getuid()) || (e.mode & 0o077) !== 0) throw erro('ARQUIVO_INSEGURO');
    sincronizarDiretorio(path.dirname(arquivo), sistema);
  } catch (falha) {
    try { sistema.closeSync(fd); } catch { /* o arquivo recém-criado fica; a leitura o classifica */ }
    throw falha.code === 'ARQUIVO_INSEGURO' ? falha : erro('DIARIO_NAO_CRIADO');
  }

  let n = 0;
  let ultimo = ZEROS;
  let envenenado = false;
  let fechado = false;

  function registrar(tipo, dados = {}) {
    if (fechado) throw erro('DIARIO_FECHADO');
    if (envenenado) throw erro('DIARIO_ENVENENADO');
    validarEvento(tipo, dados);
    const corpo = { v: 1, t: relogio().toISOString(), e: escritor, n: n + 1, k: tipo, d: dados };
    const h = hashDoEvento(ultimo, corpo);
    const linha = Buffer.from(`${JSON.stringify({ ...corpo, p: ultimo, h })}\n`, 'utf8');
    try {
      let escrito = 0;
      while (escrito < linha.length) {
        const k = sistema.writeSync(fd, linha, escrito, linha.length - escrito);
        if (!Number.isInteger(k) || k <= 0) throw new Error('escrita sem progresso');
        escrito += k;
      }
      sistema.fsyncSync(fd);
    } catch {
      envenenado = true;
      throw erro('DIARIO_NAO_DURAVEL');
    }
    n += 1;
    ultimo = h;
    return Object.freeze({ n, h });
  }
  function fechar() {
    if (fechado) return;
    fechado = true;
    try { sistema.closeSync(fd); } catch { /* já fechado */ }
  }
  return Object.freeze({ escritor, registrar, fechar, sequencia: () => n, ultimoHash: () => ultimo });
}

/** Cria a tentativa (diretório 0700, exclusivo) e o escritor `runner`, com TENTATIVA_INICIADA já sincronizado. */
function iniciarTentativa({ raiz, tentativaId, runnerPid, area, pgdata, sistema = fs, relogio = () => new Date() } = {}) {
  validarIds({ tentativaId });
  exigirRaiz(raiz, sistema);
  const pai = path.join(raiz, 'tentativas');
  try { sistema.mkdirSync(pai, { mode: 0o700 }); sincronizarDiretorio(raiz, sistema); } catch (falha) { if (!falha || falha.code !== 'EEXIST') throw erro('DIARIO_NAO_CRIADO'); }
  exigirDiretorioProprio(pai, sistema);
  const dir = dirDaTentativa(raiz, tentativaId);
  try { sistema.mkdirSync(dir, { mode: 0o700 }); } catch (falha) { throw erro(falha && falha.code === 'EEXIST' ? 'TENTATIVA_JA_EXISTE' : 'DIARIO_NAO_CRIADO'); }
  sincronizarDiretorio(pai, sistema);
  const diario = criarEscritor({ raiz, tentativaId, escritor: 'runner', sistema, relogio });
  diario.registrar('TENTATIVA_INICIADA', { runnerPid, ...(area === undefined ? {} : { area }), ...(pgdata === undefined ? {} : { pgdata }) });
  return diario;
}

/** Abre o escritor de OUTRO componente da mesma tentativa (sentinela, recuperador, humano): arquivo próprio, criação exclusiva. */
function abrirEscritor({ raiz, tentativaId, escritor, sistema = fs, relogio = () => new Date() } = {}) {
  validarIds({ tentativaId, escritor });
  if (escritor === undefined) throw configuracaoInvalida();
  exigirRaiz(raiz, sistema);
  try { exigirDiretorioProprio(dirDaTentativa(raiz, tentativaId), sistema); } catch { throw erro('TENTATIVA_INEXISTENTE'); }
  return criarEscritor({ raiz, tentativaId, escritor, sistema, relogio });
}

// ------------------------------------------------------------------------------------------------------------------ leitura
function lerArquivo(arquivo, nome, sistema) {
  const base = { estado: 'INTEGRO', eventos: [] };
  let e;
  try { e = sistema.lstatSync(arquivo); } catch { return { ...base, estado: 'INSEGURO' }; }
  if (e.isSymbolicLink() || !e.isFile() || (typeof process.getuid === 'function' && e.uid !== process.getuid()) || (e.mode & 0o077) !== 0) return { ...base, estado: 'INSEGURO' };
  let texto;
  try { texto = sistema.readFileSync(arquivo, 'utf8'); } catch { return { ...base, estado: 'INSEGURO' }; }
  const partes = texto.split('\n');
  const incompleta = partes.pop(); // vazia quando o arquivo termina em quebra de linha
  let anterior = ZEROS;
  let esperado = 1;
  const eventos = [];
  for (const linha of partes) {
    let o;
    try { o = JSON.parse(linha); } catch { return { estado: 'CONTRADITORIO', eventos }; }
    const { p, h, ...corpo } = ehObjeto(o) ? o : {};
    const ok = ehObjeto(o) && o.v === 1 && o.e === nome && o.n === esperado && p === anterior && typeof h === 'string' && SHA256.test(h) && typeof o.t === 'string' && Number.isFinite(Date.parse(o.t))
      && typeof o.k === 'string' && ehObjeto(o.d) && hashDoEvento(anterior, corpo) === h;
    if (!ok) return { estado: 'CONTRADITORIO', eventos };
    try { validarEvento(o.k, o.d); } catch { return { estado: 'CONTRADITORIO', eventos }; }
    eventos.push(Object.freeze({ n: o.n, t: o.t, e: o.e, k: o.k, d: Object.freeze(o.d) }));
    anterior = h;
    esperado += 1;
  }
  return { estado: incompleta === '' ? (eventos.length === 0 ? 'TRUNCADO' : 'INTEGRO') : 'TRUNCADO', eventos };
}

/** Lê todos os escritores da tentativa. Nunca aceita linha parcial, contraditória ou de arquivo inseguro como íntegra. */
function lerTentativa({ raiz, tentativaId, sistema = fs } = {}) {
  validarIds({ tentativaId });
  exigirRaiz(raiz, sistema);
  const dir = dirDaTentativa(raiz, tentativaId);
  try { exigirDiretorioProprio(dir, sistema); } catch { throw erro('TENTATIVA_INEXISTENTE'); }
  const escritores = {};
  const problemas = [];
  for (const arquivo of sistema.readdirSync(dir).sort()) {
    const nome = arquivo.endsWith('.ndjson') ? arquivo.slice(0, -'.ndjson'.length) : null;
    if (nome === null || !ESCRITOR.test(nome)) { problemas.push('ARQUIVO_DESCONHECIDO'); continue; }
    escritores[nome] = lerArquivo(path.join(dir, arquivo), nome, sistema);
  }
  return Object.freeze({ tentativaId, escritores: Object.freeze(escritores), problemas: Object.freeze(problemas) });
}

// ------------------------------------------------------------------------------------------------------------------ reconciliação
async function observar(observarProcesso, alvo) {
  if (typeof observarProcesso !== 'function') return 'INCONCLUSIVO';
  try {
    const r = await observarProcesso(alvo);
    return r === 'VIVO' || r === 'AUSENTE' ? r : 'INCONCLUSIVO';
  } catch {
    return 'INCONCLUSIVO';
  }
}

const eventosDe = (leitura) => Object.values(leitura.escritores).flatMap((e) => e.eventos);
const ultimo = (lista) => (lista.length === 0 ? undefined : lista[lista.length - 1]);

async function reconciliar({ raiz, tentativaId, observarProcesso, sistema = fs } = {}) {
  const leitura = lerTentativa({ raiz, tentativaId, sistema });
  const motivos = new Set();
  let bloqueada = false;
  let inconclusiva = false;
  let andamento = false;
  let identidadeDesconhecida = false;

  for (const e of Object.values(leitura.escritores)) {
    if (e.estado === 'TRUNCADO') { inconclusiva = true; identidadeDesconhecida = true; motivos.add('REGISTRO_TRUNCADO'); }
    if (e.estado === 'CONTRADITORIO') { bloqueada = true; motivos.add('REGISTRO_CONTRADITORIO'); }
    if (e.estado === 'INSEGURO') { bloqueada = true; motivos.add('REGISTRO_INSEGURO'); }
  }
  if (leitura.problemas.length > 0) { bloqueada = true; motivos.add('ARQUIVO_DESCONHECIDO'); }

  const eventos = eventosDe(leitura);
  const doTipo = (tipo, filtro = () => true) => eventos.filter((e) => e.k === tipo && filtro(e.d));
  const inicio = doTipo('TENTATIVA_INICIADA')[0];
  if (inicio === undefined) { bloqueada = true; motivos.add('TENTATIVA_SEM_INICIO'); }
  const fim = ultimo(doTipo('TENTATIVA_FIM'));
  const humano = doTipo('RESOLUCAO_HUMANA').length > 0;

  const lancamentos = [];
  const ids = [...new Set(eventos.filter((e) => e.d.lancamentoId !== undefined).map((e) => e.d.lancamentoId))].sort();
  for (const id of ids) {
    const de = (tipo) => doTipo(tipo, (d) => d.lancamentoId === id);
    const intencao = de('INTENCAO_LANCAMENTO')[0];
    const papel = intencao === undefined ? null : intencao.d.papel;
    const sentinelaPid = (ultimo(de('SENTINELA_ATIVA')) ?? ultimo(de('SENTINELA_LANCADA')) ?? { d: {} }).d.sentinelaPid;
    const registro = (estado, motivo = null) => lancamentos.push(Object.freeze({ lancamentoId: id, papel, estado, ...(motivo === null ? {} : { motivo }) }));
    if (intencao === undefined) { bloqueada = true; motivos.add('LANCAMENTO_SEM_INTENCAO'); registro('PENDENTE', 'LANCAMENTO_SEM_INTENCAO'); continue; }
    if (de('LANCAMENTO_NAO_INICIADO').length > 0) { registro('NAO_INICIADO'); continue; }
    if (de('LANCAMENTO_FALHOU').length > 0) { registro('FALHA_DE_INICIO_COMPROVADA'); continue; }
    const cliente = de('CLIENTE_LANCADO')[0];
    const encerrado = de('CLIENTE_ENCERRADO')[0];
    const grupo = ultimo(de('GRUPO_VERIFICADO'));
    if (encerrado !== undefined && grupo !== undefined && grupo.d.vazio === true) { registro('CONFIRMADO'); continue; }
    const viva = sentinelaPid === undefined ? 'INCONCLUSIVO' : await observar(observarProcesso, sentinelaPid);
    if (viva === 'VIVO') { andamento = true; registro('EM_ANDAMENTO', 'SENTINELA_VIVA'); continue; }
    let motivo;
    if (encerrado !== undefined) motivo = grupo !== undefined && grupo.d.vazio === false ? 'DESCENDENTES_ATIVOS' : 'GRUPO_NAO_CONFIRMADO';
    // postmaster: a sentinela terminou com um desfecho NÃO comprovado (identidade incerta, processo resistente, falha de sinalização): o PostgreSQL pode ainda existir
    else if (papel === 'postgres' && de('SENTINELA_FIM').length > 0) motivo = 'POSTGRES_ENCERRAMENTO_NAO_COMPROVADO';
    else if (cliente !== undefined) motivo = viva === 'AUSENTE' ? 'AUTORIDADE_PERDIDA' : 'OBSERVACAO_INCONCLUSIVA';
    else if (de('SENTINELA_ATIVA').length > 0) { motivo = 'CLIENTE_SEM_IDENTIDADE'; identidadeDesconhecida = true; } else { motivo = 'LANCAMENTO_SEM_IDENTIDADE'; identidadeDesconhecida = true; }
    inconclusiva = true;
    motivos.add(motivo);
    registro('PENDENTE', motivo);
  }

  // PostgreSQL efêmero: pertence ao runner; sem sentinela, runner morto sem encerramento comprovado é falta de autoridade
  const pgIntencao = doTipo('POSTGRES_INTENCAO').length > 0;
  const pgEncerrado = ultimo(doTipo('POSTGRES_ENCERRADO'));
  const runnerPid = inicio === undefined ? undefined : inicio.d.runnerPid;
  let runnerVivo = null;
  const runnerObservado = async () => {
    if (runnerVivo === null) runnerVivo = runnerPid === undefined ? 'INCONCLUSIVO' : await observar(observarProcesso, runnerPid);
    return runnerVivo;
  };
  const pgSupervisionado = lancamentos.some((l) => l.papel === 'postgres');
  if (pgSupervisionado) {
    // o postmaster tem sentinela: a autoridade e o desfecho vêm do lançamento (acima); aqui só se distingue o encerramento ANORMAL (SIGQUIT de emergência), comprovado mas nunca "limpo"
    if (doTipo('POSTMASTER_EMERGENCIA').length > 0 || (pgEncerrado !== undefined && pgEncerrado.d.resultado === 'ENCERRADA_ANORMAL')) { inconclusiva = true; motivos.add('POSTGRES_ENCERRAMENTO_ANORMAL'); }
    if (pgEncerrado !== undefined && !['ENCERRADA', 'ENCERRADA_ANORMAL'].includes(pgEncerrado.d.resultado)) { inconclusiva = true; motivos.add('POSTGRES_ENCERRAMENTO_NAO_COMPROVADO'); }
  } else if (pgIntencao && !(pgEncerrado !== undefined && pgEncerrado.d.resultado === 'ENCERRADA')) {
    if (pgEncerrado !== undefined) { inconclusiva = true; motivos.add('POSTGRES_ENCERRAMENTO_NAO_COMPROVADO'); } else if ((await runnerObservado()) === 'VIVO') andamento = true;
    else { inconclusiva = true; motivos.add('POSTGRES_SEM_AUTORIDADE'); }
  }
  if (fim === undefined && inicio !== undefined) {
    const r = await runnerObservado();
    if (r === 'VIVO') andamento = true;
    else if (r === 'AUSENTE') motivos.add('RUNNER_MORTO_SEM_FIM');
    else { inconclusiva = true; motivos.add('RUNNER_NAO_OBSERVAVEL'); }
  }

  const integridadeComprometida = Object.values(leitura.escritores).some((e) => e.estado === 'CONTRADITORIO' || e.estado === 'INSEGURO') || leitura.problemas.length > 0 || inicio === undefined;
  const resolvidos = lancamentos.filter((l) => ['CONFIRMADO', 'NAO_INICIADO', 'FALHA_DE_INICIO_COMPROVADA'].includes(l.estado)).length;
  const pendentes = lancamentos.filter((l) => l.estado === 'PENDENTE').length;

  let estado;
  if (integridadeComprometida) estado = 'BLOQUEADA';
  else if (humano) { estado = 'CONCLUIDA'; motivos.add('RESOLVIDA_POR_HUMANO'); } else if (bloqueada) estado = 'BLOQUEADA';
  else if (inconclusiva) estado = resolvidos > 0 && pendentes > 0 && !identidadeDesconhecida ? 'PARCIAL' : 'INCONCLUSIVA';
  else if (andamento) estado = 'EM_ANDAMENTO';
  else estado = 'CONCLUIDA';
  // O ESCOPO é só de processos e recursos: CONCLUIDA diz que nada ficou vivo ou desconhecido, NUNCA que o backup está íntegro, selado, verificado ou publicável (isso é de outros módulos, com critérios próprios)
  return Object.freeze({ tentativaId, estado, escopo: 'PROCESSOS_E_RECURSOS', comprovaBackupIntegro: false, liberaNovaTentativa: estado === 'CONCLUIDA', motivos: Object.freeze([...motivos].sort()), lancamentos: Object.freeze(lancamentos) });
}

/** Tentativas conhecidas da raiz; entrada que não é diretório próprio com nome válido vira ilegível (bloqueante). */
function listarTentativas({ raiz, sistema = fs } = {}) {
  exigirRaiz(raiz, sistema);
  const pai = path.join(raiz, 'tentativas');
  let nomes;
  try { nomes = sistema.readdirSync(pai).sort(); } catch (falha) { if (falha && falha.code === 'ENOENT') return []; throw erro('DIARIO_ILEGIVEL'); }
  return nomes;
}

async function avaliarNovaTentativa({ raiz, observarProcesso, sistema = fs } = {}) {
  const pendentes = [];
  for (const nome of listarTentativas({ raiz, sistema })) {
    let r;
    try { r = await reconciliar({ raiz, tentativaId: nome, observarProcesso, sistema }); } catch { r = { tentativaId: nome, estado: 'BLOQUEADA', liberaNovaTentativa: false }; }
    if (r.liberaNovaTentativa !== true) pendentes.push(Object.freeze({ tentativaId: nome, estado: r.estado }));
  }
  return Object.freeze({ liberada: pendentes.length === 0, motivos: Object.freeze(pendentes.length === 0 ? [] : ['TENTATIVA_ANTERIOR_NAO_RESOLVIDA']), tentativas: Object.freeze(pendentes) });
}

/**
 * Resolução humana FORMAL: só registra (nada é sinalizado) e só quando o registro está íntegro e NENHUMA identidade registrada (runner, sentinela, cliente, postgres) é observada como viva ou inconclusiva.
 */
async function registrarResolucaoHumana({ raiz, tentativaId, responsavel, observacao, observarProcesso, sistema = fs, relogio = () => new Date() } = {}) {
  validarIds({ tentativaId });
  try { validarEvento('RESOLUCAO_HUMANA', { responsavel, observacao }); } catch { throw configuracaoInvalida(); }
  const leitura = lerTentativa({ raiz, tentativaId, sistema });
  if (Object.values(leitura.escritores).some((e) => e.estado !== 'INTEGRO') || leitura.problemas.length > 0) throw erro('REGISTRO_NAO_INTEGRO');
  const registrados = new Set();
  for (const e of eventosDe(leitura)) for (const campo of ['runnerPid', 'sentinelaPid', 'clientePid', 'pid']) if (pid(e.d[campo])) registrados.add(e.d[campo]);
  for (const alvo of registrados) {
    if ((await observar(observarProcesso, alvo)) !== 'AUSENTE') throw erro('PROCESSO_REGISTRADO_AINDA_PRESENTE');
  }
  const escritor = `humano-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const diario = abrirEscritor({ raiz, tentativaId, escritor, sistema, relogio });
  try { diario.registrar('RESOLUCAO_HUMANA', { responsavel, observacao }); } finally { diario.fechar(); }
  return Object.freeze({ registrado: true, escritor });
}

// ------------------------------------------------------------------------------------------------------------------ travas
function dirDeTravas(raiz, sistema, { criar }) {
  const dir = path.join(raiz, 'travas');
  if (criar) {
    try { sistema.mkdirSync(dir, { mode: 0o700 }); sincronizarDiretorio(raiz, sistema); } catch (falha) { if (!falha || falha.code !== 'EEXIST') throw erro('TRAVA_NAO_CRIADA'); }
  }
  exigirDiretorioProprio(dir, sistema);
  return dir;
}

function criarTrava(dir, nome, conteudo, sistema) {
  const arquivo = path.join(dir, nome);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = sistema.constants;
  let fd;
  try { fd = sistema.openSync(arquivo, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600); } catch (falha) {
    if (falha && falha.code === 'EEXIST') return null;
    throw erro('TRAVA_NAO_CRIADA');
  }
  try {
    sistema.writeSync(fd, `${JSON.stringify(conteudo)}\n`);
    sistema.fsyncSync(fd);
  } catch {
    try { sistema.closeSync(fd); } catch { /* segue */ }
    try { sistema.unlinkSync(arquivo); } catch { /* a leitura classifica */ }
    throw erro('TRAVA_NAO_CRIADA');
  } finally { try { sistema.closeSync(fd); } catch { /* já fechado */ } }
  sincronizarDiretorio(dir, sistema);
  return arquivo;
}
function lerTrava(arquivo, sistema) {
  try { return JSON.parse(sistema.readFileSync(arquivo, 'utf8')); } catch { return null; }
}
function removerTrava(arquivo, sistema) {
  try { sistema.unlinkSync(arquivo); return true; } catch { return false; }
}

/** Uma tentativa, um dono: criação exclusiva. A trava não é removida por ninguém além de `liberar()` do dono ou da liberação de tentativa concluída. */
function adquirirTentativa({ raiz, tentativaId, sistema = fs, relogio = () => new Date() } = {}) {
  validarIds({ tentativaId });
  exigirRaiz(raiz, sistema);
  const dir = dirDeTravas(raiz, sistema, { criar: true });
  const arquivo = criarTrava(dir, `tentativa-${tentativaId}.lock`, { v: 1, tipo: 'tentativa', tentativaId, dono: process.pid, criadoEm: relogio().toISOString() }, sistema);
  if (arquivo === null) throw erro('TENTATIVA_EM_USO');
  let liberada = false;
  return Object.freeze({ liberar() { if (liberada) return false; liberada = true; const r = removerTrava(arquivo, sistema); if (r) sincronizarDiretorio(dir, sistema); return r; } });
}

function validarRecursos(recursos) {
  if (!Array.isArray(recursos) || recursos.length === 0 || recursos.length > MAX_RECURSOS) throw configuracaoInvalida();
  const vistos = new Set();
  const saida = recursos.map((r) => {
    if (!ehObjeto(r) || !TIPOS_DE_RECURSO.includes(r.tipo) || typeof r.id !== 'string') throw configuracaoInvalida();
    const valido = r.tipo === 'porta' ? (/^[0-9]{1,5}$/.test(r.id) && Number(r.id) >= 1 && Number(r.id) <= 65535 && String(Number(r.id)) === r.id) : caminhoAbsoluto(r.id);
    if (!valido) throw configuracaoInvalida();
    const chave = `${r.tipo}\0${r.id}`;
    if (vistos.has(chave)) throw configuracaoInvalida();
    vistos.add(chave);
    return { tipo: r.tipo, id: r.id, nome: `recurso-${r.tipo}-${crypto.createHash('sha256').update(r.id).digest('hex').slice(0, 24)}.lock` };
  });
  return saida.sort((a, b) => (a.nome < b.nome ? -1 : 1));
}

/** Recursos de exclusividade necessária (área, PGDATA, socket, porta, destino): TUDO OU NADA, em ordem canônica. Conflito: RECURSO_EM_USO e o que já havia sido obtido é devolvido. */
function adquirirRecursos({ raiz, tentativaId, recursos, sistema = fs, relogio = () => new Date() } = {}) {
  validarIds({ tentativaId });
  const lista = validarRecursos(recursos);
  exigirRaiz(raiz, sistema);
  const dir = dirDeTravas(raiz, sistema, { criar: true });
  const obtidas = [];
  for (const r of lista) {
    const arquivo = criarTrava(dir, r.nome, { v: 1, tipo: 'recurso', recurso: r.tipo, id: r.id, tentativaId, dono: process.pid, criadoEm: relogio().toISOString() }, sistema);
    if (arquivo === null) {
      const titular = lerTrava(path.join(dir, r.nome), sistema);
      for (const a of obtidas) removerTrava(a, sistema);
      if (obtidas.length > 0) sincronizarDiretorio(dir, sistema);
      throw erro('RECURSO_EM_USO', { recurso: r.tipo, titular: titular !== null && typeof titular.tentativaId === 'string' ? titular.tentativaId : null });
    }
    obtidas.push(arquivo);
  }
  let liberada = false;
  return Object.freeze({ quantidade: obtidas.length, liberar() { if (liberada) return 0; liberada = true; let n = 0; for (const a of obtidas) if (removerTrava(a, sistema)) n += 1; if (n > 0) sincronizarDiretorio(dir, sistema); return n; } });
}

/** Libera as travas de uma tentativa SÓ depois de ela reconciliar CONCLUIDA (nunca porque o dono sumiu), registrando RECURSOS_LIBERADOS em escritor próprio. */
async function liberarRecursosDeTentativaConcluida({ raiz, tentativaId, observarProcesso, sistema = fs, relogio = () => new Date() } = {}) {
  const r = await reconciliar({ raiz, tentativaId, observarProcesso, sistema });
  if (r.estado !== 'CONCLUIDA') throw erro('TENTATIVA_NAO_CONCLUIDA');
  let dir;
  try { dir = dirDeTravas(raiz, sistema, { criar: false }); } catch { return Object.freeze({ liberados: 0 }); }
  let liberados = 0;
  for (const nome of sistema.readdirSync(dir).sort()) {
    if (!/^(tentativa|recurso)-.+\.lock$/.test(nome)) continue;
    const conteudo = lerTrava(path.join(dir, nome), sistema);
    if (conteudo === null || conteudo.tentativaId !== tentativaId) continue;
    if (removerTrava(path.join(dir, nome), sistema)) liberados += 1;
  }
  if (liberados === 0) return Object.freeze({ liberados });
  sincronizarDiretorio(dir, sistema);
  const diario = abrirEscritor({ raiz, tentativaId, escritor: `recuperador-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, sistema, relogio });
  try { diario.registrar('RECURSOS_LIBERADOS', { quantidade: liberados }); } finally { diario.fechar(); }
  return Object.freeze({ liberados });
}

/** Porta real de observação: sinal 0 (sonda, nunca entrega sinal). ESRCH = AUSENTE; EPERM = existe (VIVO); qualquer outra coisa = INCONCLUSIVO. */
async function observarProcessoReal(alvo) {
  if (!pid(alvo)) return 'INCONCLUSIVO';
  try {
    process.kill(alvo, 0);
    return 'VIVO';
  } catch (falha) {
    if (falha && falha.code === 'ESRCH') return 'AUSENTE';
    if (falha && falha.code === 'EPERM') return 'VIVO';
    return 'INCONCLUSIVO';
  }
}

module.exports = {
  iniciarTentativa,
  abrirEscritor,
  lerTentativa,
  reconciliar,
  listarTentativas,
  avaliarNovaTentativa,
  registrarResolucaoHumana,
  adquirirTentativa,
  adquirirRecursos,
  liberarRecursosDeTentativaConcluida,
  observarProcessoReal,
  EVENTOS: Object.freeze(Object.keys(ESQUEMA)),
};
