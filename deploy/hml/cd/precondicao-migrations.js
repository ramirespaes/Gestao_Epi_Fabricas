'use strict';
// Verificador PURO de pré-condições de migrations (Etapa 2B). Só lê evidências (arquivos JSON e SQL) e emite um laudo
// selado; não importa processos, rede nem driver de banco, não escreve em disco e não executa nenhuma ação corretiva.
// A obrigatoriedade desta verificação antes de `db:migrate` é procedimental nesta etapa: o executor não foi alterado.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HORA = 3600000;
const VALIDADE_BACKUP_MS = 24 * HORA;
const VALIDADE_RESTAURACAO_MS = 72 * HORA;
const VALIDADE_LAUDO_MS = 4 * HORA;
const TOLERANCIA_FUTURO_MS = 60000;
const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const ROTULO = /^hml-\d{8}T\d{6}-[0-9a-f]{7}$/;
const NOME_SQL = /^[A-Za-z0-9_.-]+\.sql$/;
const VALIDADE_ESTADO_MS = 30 * 60000;
// O executor aplica o lote numa única transação: nada disto pode constar nas migrations pendentes. As palavras são
// procuradas com os comentários removidos, tanto com literais e corpos visíveis (de propósito: um EXECUTE de texto com
// CONCURRENTLY também falharia) quanto com eles em branco (um identificador entre aspas não esconde a palavra).
// Falso positivo conservador documentado: a palavra dentro de um literal ou corpo, como num COMMENT ON.
const PALAVRAS_NAO_TRANSACIONAIS = [
  /\bCONCURRENTLY\b/i, /\bVACUUM\b/i, /\b(?:CREATE|DROP)\s+(?:DATABASE|TABLESPACE)\b/i, /\bALTER\s+SYSTEM\b/i,
  /\b(?:CREATE|ALTER|DROP)\s+SUBSCRIPTION\b/i,
];
const BRANCO = /\s/;
const ALVO_GLOBAL_DE_REINDEX = /(?:DATABASE|SYSTEM|SCHEMA)\b/iy;

// REINDEX, lista de opções opcional entre parênteses e DATABASE, SYSTEM ou SCHEMA. Feito à mão, em tempo linear: a
// expressão equivalente (\s*, grupo opcional, \s*) retrocede de forma quadrática em textos longos de espaços.
function temReindexGlobal(texto) {
  let fecha = -2; // índice do ')' já localizado; -1 quando não há mais nenhum à frente
  for (const achado of texto.matchAll(/\bREINDEX\b/gi)) {
    let k = achado.index + achado[0].length;
    while (k < texto.length && BRANCO.test(texto[k])) k += 1;
    if (texto[k] === '(') {
      if (fecha !== -1 && fecha < k) fecha = texto.indexOf(')', k);
      if (fecha === -1) continue;
      k = fecha + 1;
      while (k < texto.length && BRANCO.test(texto[k])) k += 1;
    }
    ALVO_GLOBAL_DE_REINDEX.lastIndex = k;
    if (ALVO_GLOBAL_DE_REINDEX.test(texto)) return true;
  }
  return false;
}
// Comandos reprovados pelo início, com literais, identificadores e corpos $$ em branco e o texto separado por ';':
// controle de transação em qualquer variante (com argumentos ou sem ';' final), SAVEPOINT, RELEASE e CALL (um
// procedimento pode controlar transação). O END de um bloco procedural fica dentro do corpo e não conta.
// Falsos positivos conservadores documentados: corpo SQL padrão sem aspas (BEGIN ATOMIC ... END), cujo END fica no
// nível dos comandos; todo CALL, SAVEPOINT ou RELEASE, mesmo legítimo; e PREPARE de um comando chamado "transaction".
const INICIO_DE_COMANDO_PROIBIDO = /^\s*(?:BEGIN|START|COMMIT|END|ROLLBACK|ABORT|PREPARE\s+TRANSACTION|SAVEPOINT|RELEASE|CALL)\b/i;
// Como no lexer do PostgreSQL, todo caractere não ASCII vale como letra de identificador e de marca de cifrão.
const IDENT = /[A-Za-z0-9_$]|[^\x00-\x7f]/;
// Marca $tag$ sem limite de comprimento, casada no ponto exato (flag y) para não copiar nem reler o texto.
const ABERTURA_DE_CORPO = /\$(?:(?:[A-Za-z_]|[^\x00-\x7f])(?:[A-Za-z0-9_]|[^\x00-\x7f])*)?\$/y;
const ESPACO_HORIZONTAL = /[ \t\f\v]/;
const ESPACO = /[ \t\n\r\f\v]/;
const fimDeLinha = (c) => c === '\n' || c === '\r';
// O node-pg-migrate 9.0.0 (sqlMigration.js) procura os marcadores com /^\s*--[\s-]*(up|down)\s+migration/im, sem saber
// se estão em literal ou comentário, e executa só o trecho recortado. O que ele recortaria não é o texto analisado:
// reprova. A mesma decisão é tomada aqui à mão, em tempo linear (a expressão retrocede de forma quadrática em textos
// longos de quebras de linha); um teste compara as duas em textos gerados.
const SEPARADOR_DE_LINHA = String.fromCharCode(0x2028);
const SEPARADOR_DE_PARAGRAFO = String.fromCharCode(0x2029);
const quebraDeLinha = (c) => c === '\n' || c === '\r' || c === SEPARADOR_DE_LINHA || c === SEPARADOR_DE_PARAGRAFO;
const DIRECAO_E_MIGRATION = /(?:up|down)\s+migration/iy;

function temMarcadorDeSecao(sql) {
  const n = sql.length;
  let i = 0;
  while (i < n) {
    if (sql[i] !== '-' && !BRANCO.test(sql[i])) { i += 1; continue; }
    // Trecho máximo de hifens e espaços: o [\s-]* da expressão vai até o fim dele, onde a direção precisa começar.
    let soEspacosDesdeOInicioDaLinha = i === 0;
    let candidato = false;
    while (i < n && (sql[i] === '-' || BRANCO.test(sql[i]))) {
      if (sql[i] === '-') {
        if (soEspacosDesdeOInicioDaLinha && sql[i + 1] === '-') candidato = true;
        soEspacosDesdeOInicioDaLinha = false;
      } else if (quebraDeLinha(sql[i])) soEspacosDesdeOInicioDaLinha = true;
      i += 1;
    }
    if (candidato) {
      DIRECAO_E_MIGRATION.lastIndex = i;
      if (DIRECAO_E_MIGRATION.test(sql)) return true;
    }
  }
  return false;
}

// Depois da aspa que fecha um literal: se vier quebra de linha e, só com espaços e comentários de linha no meio, outra
// aspa, o PostgreSQL continua o MESMO literal no mesmo modo (scan.l, quotecontinue). Devolve o índice dessa aspa ou -1.
function continuacaoDeLiteral(sql, inicio) {
  const n = sql.length;
  let k = inicio;
  while (k < n && ESPACO_HORIZONTAL.test(sql[k])) k += 1;
  if (k >= n || !fimDeLinha(sql[k])) return -1;
  k += 1;
  for (;;) {
    while (k < n && ESPACO.test(sql[k])) k += 1;
    if (sql[k] !== '-' || sql[k + 1] !== '-') return sql[k] === "'" ? k : -1;
    while (k < n && !fimDeLinha(sql[k])) k += 1;
    if (k >= n) return -1;
    k += 1;
  }
}

// Casa a marca no índice dado; em caso de sucesso, ABERTURA_DE_CORPO.lastIndex fica logo depois dela.
function abreCorpo(sql, i) {
  ABERTURA_DE_CORPO.lastIndex = i;
  return ABERTURA_DE_CORPO.test(sql);
}

// Varre o SQL sem interpretá-lo: remove comentários (-- até \n ou \r, e /* */ aninhado) respeitando literais (com
// continuação entre linhas), identificadores entre aspas e corpos $tag$. Devolve null se algum literal, comentário ou
// corpo ficar sem fechamento (fail-closed).
function varrerSql(sql) {
  let limpo = '';
  let semCorpos = '';
  const emitir = (visivel, branco = visivel) => { limpo += visivel; semCorpos += branco; };
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && !fimDeLinha(sql[i])) i += 1;
    } else if (c === '/' && d === '*') {
      let nivel = 1;
      i += 2;
      while (i < n && nivel > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { nivel += 1; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { nivel -= 1; i += 2; } else i += 1;
      }
      if (nivel > 0) return null;
      emitir(' ');
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !(i > 1 && IDENT.test(sql[i - 2]));
      let j = i + 1;
      let fechou = false;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          const continua = continuacaoDeLiteral(sql, j + 1);
          if (continua < 0) { fechou = true; break; }
          j = continua + 1;
          continue;
        }
        j += 1;
      }
      if (!fechou) return null;
      emitir(sql.slice(i, j + 1), "''");
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let fechou = false;
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } fechou = true; break; }
        j += 1;
      }
      if (!fechou) return null;
      emitir(sql.slice(i, j + 1), '""');
      i = j + 1;
    } else if (c === '$' && !(i > 0 && IDENT.test(sql[i - 1])) && abreCorpo(sql, i)) {
      const marca = sql.slice(i, ABERTURA_DE_CORPO.lastIndex);
      const fim = sql.indexOf(marca, i + marca.length);
      if (fim < 0) return null;
      emitir(sql.slice(i, fim + marca.length), '$$$$');
      i = fim + marca.length;
    } else {
      emitir(c);
      i += 1;
    }
  }
  return { limpo, semCorpos };
}

function classificarSql(sql) {
  if (temMarcadorDeSecao(sql)) return 'SQL_RECORTAVEL';
  const v = varrerSql(sql);
  if (v === null) return 'SQL_MALFORMADO';
  const palavra = [v.limpo, v.semCorpos].some((t) => PALAVRAS_NAO_TRANSACIONAIS.some((r) => r.test(t)) || temReindexGlobal(t));
  const inicio = v.semCorpos.split(';').some((comando) => INICIO_DE_COMANDO_PROIBIDO.test(comando));
  return palavra || inicio ? 'SQL_NAO_TRANSACIONAL' : 'OK';
}

const objeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texto = (v) => typeof v === 'string' && v.length > 0;
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const instante = (v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
// Chaves do laudo em ordem alfabética explícita, com locale fixo para não depender do ambiente do processo.
const porChave = (a, b) => a.localeCompare(b, 'en');
// Nomes de migrations em ordem de código de caractere: é a mesma relação (<) usada na checagem de ordem das pendentes.
function porCodigoDeCaractere(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
const iso = (ms) => new Date(ms).toISOString();

function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (objeto(v)) return `{${Object.keys(v).sort(porChave).map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function selo(laudo) {
  const { laudoSha256, ...resto } = laudo;
  return sha256(canonico(resto));
}
const ultimaDe = (aplicadas) => (aplicadas.length ? aplicadas.map((m) => m.nome).sort(porCodigoDeCaractere).at(-1) : null);

function verificar(entrada) {
  const e = objeto(entrada) ? entrada : {};
  const agora = Number.isFinite(e.agora) ? e.agora : Date.now();
  const problemas = Array.isArray(e.leitura) ? e.leitura.map((p) => ({ codigo: p.codigo, detalhe: p.detalhe })) : [];
  const falha = (codigo, detalhe) => problemas.push({ codigo, detalhe });
  const vinculos = { commit: null, rotulo: null, releaseSha256: null, dumpSha256: null };
  let validoAteEstado = Infinity;

  const rel = e.release;
  const declaradas = objeto(rel) && objeto(rel.backend) && Array.isArray(rel.backend.migrations) ? rel.backend.migrations : null;
  const releaseOk = objeto(rel) && SHA40.test(rel.commit || '') && ROTULO.test(rel.rotulo || '') && HEX64.test(e.releaseSha256 || '')
    && declaradas !== null && declaradas.every((m) => objeto(m) && NOME_SQL.test(m.nome || '') && HEX64.test(m.sha256 || ''))
    && new Set(declaradas.map((m) => m.nome)).size === declaradas.length;
  if (!releaseOk) falha('RELEASE_INVALIDO', 'release.json ou hash da release ausente ou fora do formato esperado');
  else Object.assign(vinculos, { commit: rel.commit, rotulo: rel.rotulo, releaseSha256: e.releaseSha256 });

  const estado = e.estado;
  const estadoOk = objeto(estado) && texto(estado.banco) && Array.isArray(estado.aplicadas) && Number.isFinite(instante(estado.coletadoEm))
    && estado.aplicadas.every((m) => objeto(m) && NOME_SQL.test(m.nome || '') && HEX64.test(m.sha256 || ''));
  if (!estadoOk) falha('ESTADO_INVALIDO', 'estado do banco ausente, sem carimbo coletadoEm válido ou fora do formato esperado');
  else {
    const coleta = instante(estado.coletadoEm);
    if (coleta > agora + TOLERANCIA_FUTURO_MS) falha('CRONOLOGIA_INVALIDA', 'estado do banco com data de coleta no futuro');
    else if (agora - coleta > VALIDADE_ESTADO_MS) falha('ESTADO_VENCIDO', 'estado do banco coletado há mais de 30 minutos');
    validoAteEstado = coleta + VALIDADE_ESTADO_MS;
  }

  let pendentes = [];
  if (releaseOk && estadoOk) {
    const doRelease = new Map(declaradas.map((m) => [m.nome, m.sha256]));
    const aplicadas = new Map(estado.aplicadas.map((m) => [m.nome, m.sha256]));
    for (const [nome, hash] of aplicadas) {
      if (!doRelease.has(nome)) falha('BANCO_A_FRENTE_DO_RELEASE', `${nome} está aplicada e não consta no release`);
      else if (doRelease.get(nome) !== hash) falha('APLICADA_DIVERGENTE', `${nome} foi aplicada com hash diferente do release`);
    }
    pendentes = [...doRelease.keys()].filter((n) => !aplicadas.has(n)).sort(porCodigoDeCaractere);
    const maiorAplicada = ultimaDe(estado.aplicadas);
    if (pendentes.some((n) => maiorAplicada !== null && n < maiorAplicada)) falha('PENDENTES_FORA_DE_ORDEM', 'há migration pendente anterior a uma já aplicada');
    for (const nome of pendentes) {
      const sql = objeto(e.sqlPendentes) ? e.sqlPendentes[nome] : undefined;
      if (typeof sql !== 'string') falha('SQL_NAO_FORNECIDO', `${nome}: o SQL não foi fornecido, então não dá para provar o conteúdo`);
      else if (sha256(sql) !== doRelease.get(nome)) falha('SQL_DIVERGENTE', `${nome}: o SQL difere do hash declarado no release`);
      else {
        const classe = classificarSql(sql);
        if (classe === 'SQL_RECORTAVEL') falha('SQL_RECORTAVEL', `${nome}: contém marcador de seção (up ou down migration) pelo qual o executor recortaria o arquivo, então o texto executado não seria o analisado`);
        else if (classe === 'SQL_MALFORMADO') falha('SQL_MALFORMADO', `${nome}: literal, comentário ou corpo $$ sem fechamento, então o SQL não pôde ser varrido`);
        else if (classe === 'SQL_NAO_TRANSACIONAL') falha('SQL_NAO_TRANSACIONAL', `${nome}: contém comando que não roda na transação única do executor`);
      }
    }
  }

  let validoAte = Math.min(agora + VALIDADE_LAUDO_MS, validoAteEstado);
  if (pendentes.length > 0 && estadoOk) {
    const ultima = ultimaDe(estado.aplicadas);
    const total = estado.aplicadas.length;
    const b = e.backup;
    const r = e.restauracao;
    const backupOk = objeto(b) && b.tipo === 'backup' && HEX64.test(b.dumpSha256 || '') && texto(b.banco) && Number.isFinite(instante(b.criadoEm)) && Number.isInteger(b.migrationsAplicadas);
    const restOk = objeto(r) && r.tipo === 'restauracao' && HEX64.test(r.dumpSha256 || '') && texto(r.bancoOrigem) && texto(r.bancoRestaurado) && Number.isFinite(instante(r.restauradoEm))
      && Number.isInteger(r.migrationsAplicadas) && typeof r.instanciaNova === 'boolean' && typeof r.integridadeDump === 'boolean' && objeto(r.sentinelas);
    if (b === undefined || b === null) falha('BACKUP_AUSENTE', 'sem recibo de backup');
    else if (!backupOk) falha('BACKUP_INVALIDO', 'recibo de backup fora do formato esperado');
    if (r === undefined || r === null) falha('RESTAURACAO_AUSENTE', 'um recibo de backup sozinho não prova recuperabilidade: falta o recibo de restauração do mesmo dump');
    else if (!restOk) falha('RESTAURACAO_INVALIDA', 'recibo de restauração fora do formato esperado');

    if (backupOk) {
      vinculos.dumpSha256 = b.dumpSha256;
      const criado = instante(b.criadoEm);
      if (criado > agora + TOLERANCIA_FUTURO_MS) falha('CRONOLOGIA_INVALIDA', 'backup com data no futuro');
      else if (agora - criado > VALIDADE_BACKUP_MS) falha('BACKUP_VENCIDO', 'backup com mais de 24 horas');
      if (b.banco !== estado.banco) falha('BACKUP_DE_OUTRO_BANCO', 'o backup não é do banco atual');
      if ((b.ultimaMigration ?? null) !== ultima || b.migrationsAplicadas !== total) falha('BACKUP_DEFASADO', 'o backup não corresponde ao estado atual das migrations');
      validoAte = Math.min(validoAte, criado + VALIDADE_BACKUP_MS);
    }
    if (restOk) {
      const feita = instante(r.restauradoEm);
      if (backupOk && r.dumpSha256 !== b.dumpSha256) falha('DUMP_DIVERGENTE', 'a restauração é de outro dump, não do mesmo do backup');
      if (r.instanciaNova !== true || r.bancoRestaurado === r.bancoOrigem || r.bancoRestaurado === estado.banco) falha('RESTAURACAO_SOBRE_ORIGEM', 'a restauração precisa ser feita em instância nova, nunca sobre o banco de origem');
      if (r.bancoOrigem !== estado.banco) falha('RESTAURACAO_DE_OUTRO_BANCO', 'a restauração não é do banco atual');
      if (r.integridadeDump !== true || r.sentinelas.ok !== true || !(r.sentinelas.verificadas >= 1)) falha('INTEGRIDADE_NAO_COMPROVADA', 'dump sem integridade verificada ou sentinelas não aprovadas');
      if ((r.ultimaMigration ?? null) !== ultima || r.migrationsAplicadas !== total) falha('RESTAURACAO_DEFASADA', 'a restauração não reproduz o estado atual das migrations');
      if (feita > agora + TOLERANCIA_FUTURO_MS || (backupOk && feita < instante(b.criadoEm))) falha('CRONOLOGIA_INVALIDA', 'restauração anterior ao backup ou com data no futuro');
      else if (agora - feita > VALIDADE_RESTAURACAO_MS) falha('RESTAURACAO_VENCIDA', 'restauração com mais de 72 horas');
      validoAte = Math.min(validoAte, feita + VALIDADE_RESTAURACAO_MS);
    }
  }

  const aprovado = problemas.length === 0;
  const laudo = { versao: 1, resultado: aprovado ? 'APROVADO' : 'REPROVADO', problemas, pendentes, vinculos, geradoEm: iso(agora), validoAte: aprovado ? iso(validoAte) : null };
  return { ...laudo, laudoSha256: selo(laudo) };
}

// ---------------------------------------------------------------- linha de comando (somente leitura)
const COM_VALOR = ['--release', '--release-sha256', '--estado', '--migrations', '--backup', '--restauracao'];
const USO = 'uso: node precondicao-migrations.js --release <release.json> --release-sha256 <hash> --estado <estado.json> --migrations <dir> [--backup <recibo.json>] [--restauracao <recibo.json>]';

function lerArgumentos(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!COM_VALOR.includes(argv[i]) || argv[i + 1] === undefined || Object.hasOwn(a, argv[i])) return null;
    a[argv[i]] = argv[i + 1];
  }
  return ['--release', '--release-sha256', '--estado', '--migrations'].every((k) => Object.hasOwn(a, k)) ? a : null;
}

function principal(argv, io = {}) {
  const saida = io.saida || ((t) => process.stdout.write(t));
  const erro = io.erro || ((t) => process.stderr.write(t));
  const args = lerArgumentos(argv);
  if (!args) { erro(`${USO}\n`); return 64; }
  const leitura = [];
  const json = (arquivo, rotulo) => {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { leitura.push({ codigo: 'ARQUIVO_ILEGIVEL', detalhe: `${rotulo}: arquivo ausente ou JSON inválido` }); return undefined; }
  };
  let release;
  const brutoRelease = (() => { try { return fs.readFileSync(args['--release']); } catch { return null; } })();
  if (brutoRelease === null) leitura.push({ codigo: 'ARQUIVO_ILEGIVEL', detalhe: 'release.json: arquivo ausente' });
  else if (sha256(brutoRelease) !== args['--release-sha256']) leitura.push({ codigo: 'RELEASE_INVALIDO', detalhe: 'o hash do release.json difere do hash aprovado informado' });
  else { try { release = JSON.parse(brutoRelease.toString('utf8')); } catch { leitura.push({ codigo: 'RELEASE_INVALIDO', detalhe: 'release.json com JSON inválido' }); } }
  const estado = json(args['--estado'], 'estado do banco');
  const backup = args['--backup'] ? json(args['--backup'], 'recibo de backup') : undefined;
  const restauracao = args['--restauracao'] ? json(args['--restauracao'], 'recibo de restauração') : undefined;
  const sqlPendentes = {};
  const declaradas = objeto(release) && objeto(release.backend) && Array.isArray(release.backend.migrations) ? release.backend.migrations : [];
  for (const m of declaradas) {
    if (!objeto(m) || !NOME_SQL.test(m.nome || '')) continue;
    try { sqlPendentes[m.nome] = fs.readFileSync(path.join(args['--migrations'], m.nome), 'utf8'); } catch { /* ausência vira SQL_NAO_FORNECIDO */ }
  }
  const laudo = verificar({ release, releaseSha256: args['--release-sha256'], estado, backup, restauracao, sqlPendentes, leitura, agora: io.agora ? io.agora() : Date.now() });
  saida(`${JSON.stringify(laudo, null, 2)}\n`);
  if (laudo.resultado === 'APROVADO') return 0;
  erro(`REPROVADO\n${laudo.problemas.map((p) => `- ${p.codigo}: ${p.detalhe}`).join('\n')}\nDiagnóstico apenas: nenhuma restauração foi executada, nenhuma reversão e nenhuma alteração no banco. Corrija a causa e gere um novo laudo.\n`);
  return 2;
}

if (require.main === module) process.exitCode = principal(process.argv.slice(2));
module.exports = { verificar, selo, principal, classificarSql, VALIDADE_BACKUP_MS, VALIDADE_RESTAURACAO_MS, VALIDADE_LAUDO_MS, VALIDADE_ESTADO_MS };
