'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verificarAmbiente } = require('../src/services/backup-ambiente-verificacao.service');
const janela = require('../src/utils/janela-escrita-imagens');
const { carregarSdkAws } = require('../src/services/backup-aws-sdk-carregador.service');
const { DESTINOS_AUTORIZADOS } = require('../src/services/imagem-backup-destinos.service');
const Pol = require('../src/services/backup-executor-politica.service');
const Ev = require('../src/services/backup-executor-evidencia.service');
const { avaliarMonitoramento } = require('../src/services/backup-executor-monitoramento.service');
const { DEDICADO } = require('../src/services/backup-executor-operacional.service');

/**
 * Executor operacional do backup (D-ORF-6). Quatro modos, um por execução; nenhum deles escreve em disco, abre conexão ou lança processo por conta própria:
 *
 *   node scripts/backup-operar.js --verificar [--json]
 *   node scripts/backup-operar.js --ensaio|--operar --acao=<backup|restauracao|verificacao-destino> --ambiente=<HOMOLOGACAO|PRODUCAO> --destino=<id da ficha> --confirmo=<frase>
 *   node scripts/backup-operar.js --monitorar --evidencias=<arquivo> --ambiente=<...> --limite-backup-horas=<n> --limite-verificacao-horas=<n> [--modo=ensaio|operacao] [--limite-falhas=<n>] [--limite-ensaio-dr-dias=<n>] [--json]
 *
 * `--verificar`: diagnóstico SOMENTE LEITURA do ambiente (diretórios, permissões, trava de janela, binários e arquivo de senha do PostgreSQL, limites e espaço) e das pendências de chaves, destinos,
 * custódia e retenção. `--ensaio`: executa a ação em HOMOLOGACAO com dados sintéticos pelo compositor do executor; `--operar`: a operação real, BLOQUEADA nesta versão (constante da política).
 * Ambos imprimem UMA linha de evidência (NDJSON) no stdout — o que o systemd/journal captura — e só executam pela ligação operacional (`portas.compor`), que NÃO existe neste processo: sem ela o
 * resultado é sempre BLOQUEADO, com a lista completa dos motivos. `--monitorar`: lê o arquivo de evidências e devolve 0 (em dia) ou 7 (alerta); não tem limiares padrão (RPO e RTO não estão fixados).
 *
 * AMBIENTE: só `process.env`. Este script NÃO carrega o `.env` da API (não usa dotenv): quem o executa fornece apenas as variáveis do executor,
 * por exemplo `node --env-file=/caminho/executor-backup.env scripts/backup-operar.js --verificar` ou pelo `EnvironmentFile` de uma unidade.
 * Variáveis do `--verificar`: IMAGENS_ARMAZENAMENTO_DIRETORIO, FISCALIZACAO_ARMAZENAMENTO_DIRETORIO, IMAGENS_JANELA_ESCRITA_ARQUIVO, BACKUP_RAIZ,
 * BACKUP_PG_BINARIOS (padrão /usr/lib/postgresql/16/bin), BACKUP_PG_HOST, BACKUP_PG_PORTA, BACKUP_PG_USUARIO, BACKUP_PG_BANCO, PGPASSFILE,
 * BACKUP_LIMITE_DUMP_BYTES, BACKUP_LIMITE_TOTAL_BYTES, BACKUP_LIMITE_LIVRE_BYTES. Valores de variáveis nunca são impressos.
 *
 * Códigos de saída: 0 = sem falhas (no `--verificar` isto NÃO é prontidão operacional: a saída diz `prontidaoOperacional: false`); 1 = falha ou erro de execução; 2 = argumentos inválidos;
 * 3 = pendência de infraestrutura (`--verificar`); 4 = BLOQUEADO por portão; 5 = RECUSADO; 6 = INCERTO (exige decisão humana); 7 = alerta do `--monitorar`.
 */

const SAIDAS = Object.freeze({ OK: 0, FALHA: 1, ARGUMENTOS: 2, INFRA_PENDENTE: 3, BLOQUEADO: 4, RECUSADO: 5, INCERTO: 6, ALERTA: 7 });
const USO = [
  'Uso:',
  '  node scripts/backup-operar.js --verificar [--json]',
  '  node scripts/backup-operar.js --ensaio|--operar --acao=<backup|restauracao|verificacao-destino> --ambiente=<HOMOLOGACAO|PRODUCAO> --destino=<id da ficha> --confirmo=<frase>',
  '  node scripts/backup-operar.js --monitorar --evidencias=<arquivo> --ambiente=<HOMOLOGACAO|PRODUCAO> --limite-backup-horas=<n> --limite-verificacao-horas=<n>',
  '        [--modo=ensaio|operacao] [--limite-falhas=<n>] [--limite-ensaio-dr-dias=<n>] [--json]',
  '  --verificar   diagnostica o ambiente do backup, somente leitura',
  '  --ensaio      executa a ação em HOMOLOGACAO, com dados sintéticos; --operar é a operação real (bloqueada nesta versão); ambos imprimem UMA linha de evidência',
  '  --monitorar   avalia o arquivo de evidências, somente leitura, sem limiares padrão',
  'Saídas: 0 ok, 1 falha, 2 argumentos, 3 infraestrutura pendente (--verificar), 4 bloqueado por portão, 5 recusado, 6 incerto (decisão humana), 7 alerta (--monitorar).',
].join('\n').concat('\n');

const ACOES = Object.freeze({ backup: 'BACKUP', restauracao: 'RESTAURACAO', 'verificacao-destino': 'VERIFICACAO_DESTINO' });
const MODOS_DE_EXECUCAO = Object.freeze({ '--ensaio': 'ENSAIO', '--operar': 'OPERACAO' });
const ESTADO_PARA_SAIDA = Object.freeze({ CONCLUIDO: SAIDAS.OK, BLOQUEADO: SAIDAS.BLOQUEADO, RECUSADO: SAIDAS.RECUSADO, FALHOU: SAIDAS.FALHA, INCERTO: SAIDAS.INCERTO });
const RE_DESTINO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RE_FRASE = /^[A-Z][A-Z_]{4,79}$/;
const AMBIENTES = Object.freeze(['HOMOLOGACAO', 'PRODUCAO']);
const LIMITE_DE_LEITURA = 64 * 1024 * 1024;

const caminhoCanonico = (c) => c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/') && !c.split('/').includes('..');
const inteiro = (texto, minimo, maximo) => (/^[1-9]\d{0,5}$/.test(texto) && Number(texto) >= minimo && Number(texto) <= maximo ? Number(texto) : null);
const ESPECIFICACAO = Object.freeze({
  acao: (v) => (Object.hasOwn(ACOES, v) ? ACOES[v] : null),
  ambiente: (v) => (AMBIENTES.includes(v) ? v : null),
  destino: (v) => (RE_DESTINO.test(v) ? v : null),
  confirmo: (v) => (RE_FRASE.test(v) ? v : null),
  evidencias: (v) => (caminhoCanonico(v) ? v : null),
  modo: (v) => (v === 'ensaio' ? 'ENSAIO' : v === 'operacao' ? 'OPERACAO' : null),
  'limite-backup-horas': (v) => inteiro(v, 1, 8760),
  'limite-verificacao-horas': (v) => inteiro(v, 1, 8760),
  'limite-falhas': (v) => inteiro(v, 1, 100),
  'limite-ensaio-dr-dias': (v) => inteiro(v, 1, 3650),
});
const CHAVES_POR_MODO = Object.freeze({
  ENSAIO: { obrigatorias: ['acao', 'ambiente', 'destino', 'confirmo'], opcionais: [], json: false },
  OPERACAO: { obrigatorias: ['acao', 'ambiente', 'destino', 'confirmo'], opcionais: [], json: false },
  MONITORAR: { obrigatorias: ['evidencias', 'ambiente', 'limite-backup-horas', 'limite-verificacao-horas'], opcionais: ['modo', 'limite-falhas', 'limite-ensaio-dr-dias'], json: true },
  VERIFICAR: { obrigatorias: [], opcionais: [], json: true },
});
const recusa = (erro) => ({ ok: false, erro });

/** Puro, sem I/O; o erro nunca ecoa o argumento recebido. */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  let modo = null;
  let json = false;
  const valores = new Map();
  for (const argumento of argumentos) {
    if (typeof argumento !== 'string') return recusa('argumento inválido');
    if (argumento === '--verificar' || argumento === '--monitorar' || Object.hasOwn(MODOS_DE_EXECUCAO, argumento)) {
      if (modo !== null) return recusa('informe um único modo, uma única vez');
      modo = argumento === '--verificar' ? 'VERIFICAR' : argumento === '--monitorar' ? 'MONITORAR' : MODOS_DE_EXECUCAO[argumento];
    } else if (argumento === '--json') {
      if (json) return recusa('--json informado mais de uma vez');
      json = true;
    } else {
      const m = argumento.match(/^--([a-z-]{3,30})=(.*)$/s);
      if (m === null || !Object.hasOwn(ESPECIFICACAO, m[1])) return recusa('argumento desconhecido');
      if (valores.has(m[1])) return recusa('argumento repetido');
      valores.set(m[1], m[2]);
    }
  }
  if (modo === null) return recusa('informe um modo: --verificar, --ensaio, --operar ou --monitorar');
  const regra = CHAVES_POR_MODO[modo];
  if (json && !regra.json) return recusa('--json não é aceito neste modo');
  for (const chave of valores.keys()) if (!regra.obrigatorias.includes(chave) && !regra.opcionais.includes(chave)) return recusa('argumento não permitido neste modo');
  for (const chave of regra.obrigatorias) if (!valores.has(chave)) return recusa('argumento obrigatório ausente');
  const lidos = {};
  for (const [chave, texto] of valores) {
    const valor = ESPECIFICACAO[chave](texto);
    if (valor === null) return recusa('valor fora do formato');
    lidos[chave] = valor;
  }
  if (modo === 'VERIFICAR') return { ok: true, modo, json };
  if (modo === 'MONITORAR') {
    return {
      ok: true, modo, evidencias: lidos.evidencias, ambiente: lidos.ambiente, modoMonitorado: lidos.modo ?? 'OPERACAO', limiteBackupHoras: lidos['limite-backup-horas'], limiteVerificacaoHoras: lidos['limite-verificacao-horas'],
      limiteFalhas: lidos['limite-falhas'] ?? null, limiteEnsaioDrDias: lidos['limite-ensaio-dr-dias'] ?? null, json,
    };
  }
  return { ok: true, modo, acao: lidos.acao, ambiente: lidos.ambiente, destino: lidos.destino, confirmo: lidos.confirmo };
}

function codigoDeSaida(relatorio) {
  if (relatorio.veredito === 'FALHA') return SAIDAS.FALHA;
  if (relatorio.veredito === 'INFRA_PENDENTE') return SAIDAS.INFRA_PENDENTE;
  return SAIDAS.OK;
}

const limpar = (texto) => String(texto).replace(/[^\x20-\x7E]/g, '?');
const formatarDetalhe = (detalhe) => (detalhe === undefined ? '' : ` ${Object.entries(detalhe).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).map(limpar).join(' ')}`);

function formatarTexto(relatorio) {
  const linhas = ['backup-operar --verificar (somente leitura)'];
  for (const i of relatorio.itens) linhas.push(`[${i.estado.padEnd(8)}] ${i.id.padEnd(30)} ${i.codigo}${formatarDetalhe(i.detalhe)}`);
  linhas.push(`RESUMO infraestrutura: ok=${relatorio.infraestrutura.ok} pendente=${relatorio.infraestrutura.pendente} falha=${relatorio.infraestrutura.falha} | operacional pendente=${relatorio.operacional.pendente}`);
  linhas.push(`VEREDITO: ${relatorio.veredito}`);
  for (const o of relatorio.observacoes) linhas.push(`NOTA: ${o}`);
  linhas.push('PRONTIDAO_OPERACIONAL=NAO');
  return `${linhas.join('\n')}\n`;
}

function formatarMonitoramento(r) {
  const linhas = ['backup-operar --monitorar (somente leitura)', `VEREDITO: ${r.veredito}`];
  for (const a of r.alertas) linhas.push(`ALERTA ${a.severidade} ${a.codigo}${a.quantidade === undefined ? '' : ` quantidade=${a.quantidade}`}${a.idadeMs === undefined ? '' : ` idadeMs=${a.idadeMs}`}`);
  const s = r.resumo;
  linhas.push(`RESUMO linhas=${s.linhasLidas} ilegiveis=${s.linhasIlegiveis} avaliadas=${s.avaliadas} ultimoBackup=${s.ultimoBackupConcluidoEm ?? 'NENHUM'} ultimaVerificacao=${s.ultimaVerificacaoConformeEm ?? 'NENHUMA'} falhasConsecutivas=${s.falhasConsecutivas}`);
  return `${linhas.join('\n')}\n`;
}

/** Umask do processo, lida do /proc (Linux); `null` quando não dá para saber (a política trata como permissiva). */
function lerUmaskDoProcesso() {
  try {
    const m = fs.readFileSync('/proc/self/status', 'utf8').match(/^Umask:\s*([0-7]{3,4})\s*$/m);
    return m === null ? null : parseInt(m[1], 8) & 0o777;
  } catch { return null; }
}

function fatosDoProcesso() {
  let sdk = 'NAO_APROVADO';
  try { carregarSdkAws({ requerer: require }); sdk = 'APROVADO'; } catch { sdk = 'NAO_APROVADO'; }
  return { sdk, chavesOrigem: 'AUSENTE', uid: typeof process.getuid === 'function' ? process.getuid() : null, umask: lerUmaskDoProcesso() };
}

/** Sem a ligação operacional este processo nunca executa: devolve a linha de evidência BLOQUEADO com TODOS os motivos. */
function linhaDeBloqueio(i, relogio) {
  const destinoLocal = i.acao === 'VERIFICACAO_DESTINO' ? 'NAO_APLICA' : DESTINOS_AUTORIZADOS[i.ambiente].some((d) => DEDICADO[i.acao].test(d.id)) ? 'AUTORIZADO' : 'NAO_AUTORIZADO';
  const politica = Pol.avaliarPortoes({ modo: i.modo, acao: i.acao, ambiente: i.ambiente, destinoId: i.destino, confirmacao: i.confirmo, fatos: { ...fatosDoProcesso(), destinoLocal } });
  const bloqueios = [...new Set([...politica.bloqueios, 'LIGACAO_OPERACIONAL_AUSENTE'])].sort();
  const ev = Ev.criarEvidencia({ modo: i.modo, acao: i.acao, ambiente: i.ambiente, destinoId: i.destino, relogio });
  return ev.encerrar({ estado: 'BLOQUEADO', codigo: bloqueios[0], falhouEm: 'GATE', bloqueios }).linha;
}

async function executarExecucao(i, { escrever, erro, portas }) {
  const relogio = portas !== undefined && typeof portas.relogio === 'function' ? portas.relogio : () => Date.now();
  let linha;
  let registrada = true;
  if (portas === undefined || typeof portas.compor !== 'function') {
    linha = linhaDeBloqueio(i, relogio);
  } else {
    const execucao = await portas.compor({ modo: i.modo, acao: i.acao, ambiente: i.ambiente, destino: i.destino, confirmacao: i.confirmo });
    const resultado = await execucao.executar();
    linha = resultado === null || typeof resultado !== 'object' ? undefined : resultado.linha;
    registrada = resultado !== null && typeof resultado === 'object' && resultado.evidenciaRegistrada === true;
  }
  const lida = Ev.lerLinhaDeEvidencia(typeof linha === 'string' ? linha : '');
  if (!lida.ok) { erro('EVIDENCIA_INVALIDA\n'); return SAIDAS.FALHA; }
  escrever(linha);
  if (!registrada) { erro('EVIDENCIA_NAO_REGISTRADA\n'); return SAIDAS.FALHA; }
  return ESTADO_PARA_SAIDA[lida.evidencia.estado];
}

function lerEvidencias(caminho) {
  const fd = fs.openSync(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LIMITE_DE_LEITURA) throw new Error('arquivo fora dos limites');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function executarMonitoramento(i, { escrever, erro, portas }) {
  let texto;
  try { texto = lerEvidencias(i.evidencias); } catch { erro('EVIDENCIAS_INDISPONIVEIS\n'); return SAIDAS.FALHA; }
  const relogio = portas !== undefined && typeof portas.relogio === 'function' ? portas.relogio : () => Date.now();
  const limites = { backupMs: i.limiteBackupHoras * 3600000, verificacaoMs: i.limiteVerificacaoHoras * 3600000 };
  if (i.limiteFalhas !== null) limites.falhasConsecutivas = i.limiteFalhas;
  if (i.limiteEnsaioDrDias !== null) limites.ensaioDeDrMs = i.limiteEnsaioDrDias * 86400000;
  const relatorio = avaliarMonitoramento({ linhas: texto.split('\n'), agora: relogio(), modo: i.modoMonitorado, ambiente: i.ambiente, limites });
  escrever(i.json ? `${JSON.stringify(relatorio, null, 2)}\n` : formatarMonitoramento(relatorio));
  return relatorio.veredito === 'OK' ? SAIDAS.OK : SAIDAS.ALERTA;
}

/** Injetável para teste. Devolve o código de saída; escreve só no que receber em `escrever`/`erro`. */
async function executarComando({ argv, ambiente, raizDoCodigo, escrever, erro, portas }) {
  const interpretado = interpretarArgumentos(argv);
  if (!interpretado.ok) {
    erro(`${interpretado.erro}\n${USO}`);
    return SAIDAS.ARGUMENTOS;
  }
  if (interpretado.modo === 'MONITORAR') {
    try { return executarMonitoramento(interpretado, { escrever, erro, portas }); } catch { erro('ERRO_INESPERADO: o monitoramento não pôde ser concluído\n'); return SAIDAS.FALHA; }
  }
  if (interpretado.modo !== 'VERIFICAR') {
    try { return await executarExecucao(interpretado, { escrever, erro, portas }); } catch { erro('ERRO_INESPERADO: a execução não pôde ser concluída\n'); return SAIDAS.FALHA; }
  }
  try {
    const relatorio = await verificarAmbiente({
      ambiente,
      raizDoCodigo,
      ...(portas === undefined ? {} : { portas }),
      janela: { lerArquivo: janela.lerArquivoDaJanela, validar: janela.validarArquivoDaJanela, ler: janela.lerJanela },
    });
    escrever(interpretado.json ? `${JSON.stringify(relatorio, null, 2)}\n` : formatarTexto(relatorio));
    return codigoDeSaida(relatorio);
  } catch {
    erro('ERRO_INESPERADO: o diagnóstico não pôde ser concluído\n');
    return SAIDAS.FALHA;
  }
}

if (require.main === module) {
  executarComando({
    argv: process.argv.slice(2),
    ambiente: process.env,
    raizDoCodigo: fs.realpathSync(path.resolve(__dirname, '..')),
    escrever: (texto) => process.stdout.write(texto),
    erro: (texto) => process.stderr.write(texto),
  }).then((saida) => { process.exitCode = saida; });
}

module.exports = { interpretarArgumentos, executarComando, formatarTexto, formatarMonitoramento, codigoDeSaida, SAIDAS, USO };
