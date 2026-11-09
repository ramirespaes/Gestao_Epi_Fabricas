'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lerConfiguracaoOperacional, VARIAVEL } = require('../../src/services/backup-executor-configuracao.service');

/**
 * D-ORF-6, Rodada B (B2) [MOD]: modelos operacionais INERTES do executor: o modelo da configuração v2 e o modelo SQL do papel de banco (H9-h). Leitura estática; nada é executado, nenhum banco é aberto.
 * O modelo só serve de roteiro: enquanto houver o marcador A_PREENCHER o leitor o recusa e o SQL falha de propósito.
 */

const RAIZ = path.join(__dirname, '..', '..');
const CONFIG = 'ops/executor/configuracao-ensaio.json.modelo';
const SQL = 'ops/sql/papel-executor-backup.sql.modelo';
const ler = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
const semComentariosSql = (texto) => texto.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const comandos = (texto) => semComentariosSql(texto).split(';').map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
const arvore = (dir) => fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arvore(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const lerComo = (texto) => lerConfiguracaoOperacional({ ambiente: { [VARIAVEL]: '/etc/safework/ensaio/config.json' }, lerArquivo: () => ({ ok: true, texto }) });
const preenchido = () => ler(CONFIG).replace('"regiao": "A_PREENCHER"', '"regiao": "sa-east-1"').replaceAll('/A_PREENCHER', '/srv/safework-teste');

describe('[MOD] modelo da configuração v2', () => {
  test('MOD-01 — o modelo é JSON, declara a v2 e é RECUSADO como está, porque ainda tem o marcador A_PREENCHER', () => {
    const objeto = JSON.parse(ler(CONFIG));
    assert.equal(objeto.versao, 2);
    assert.equal(objeto.finalidade, 'ENSAIO_ISOLADO');
    assert.equal(objeto.ambiente, 'HOMOLOGACAO');
    assert.deepEqual(lerComo(ler(CONFIG)), { ok: false, codigo: 'CONFIGURACAO_FORMA_INVALIDA' });
  });

  test('MOD-02 — com os marcadores trocados por valores sintéticos o leitor o aceita, com os limites do executor e ids DEDICADO', () => {
    const r = lerComo(preenchido());
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = r.configuracao;
    assert.equal(c.versao, 2);
    assert.deepEqual({ BACKUP: c.destinosLocais.BACKUP.id, RESTAURACAO: c.destinosLocais.RESTAURACAO.id }, { BACKUP: 'containers-hml', RESTAURACAO: 'restauracao-hml' });
    assert.deepEqual({ ...c.limites }, { arquivosMaximo: 100000, totalBytesMaximo: 2147483648 });
    assert.equal(c.prazoMs, 600000);
    assert.deepEqual(Object.keys(c.protegidos).sort(), ['dumps', 'fiscalizacao', 'imagens', 'preparacoes', 'publicados']);
  });

  test('MOD-03 — o marcador fica só nos valores que dependem do host (região, credenciais, raízes e áreas); ids, limites e prazo são sintéticos', () => {
    const objeto = JSON.parse(ler(CONFIG));
    const achados = [];
    const andar = (valor, caminho) => {
      if (typeof valor === 'string') { if (valor.includes('A_PREENCHER')) achados.push(caminho); return; }
      if (valor !== null && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) andar(v, caminho === '' ? k : `${caminho}.${k}`);
    };
    andar(objeto, '');
    assert.deepEqual(achados.sort(), [
      'destinosLocais.BACKUP.raiz', 'destinosLocais.RESTAURACAO.raiz', 'papeis.PUBLICADOR', 'papeis.RESTAURACAO', 'papeis.VERIFICADOR',
      'protegidos.dumps', 'protegidos.fiscalizacao', 'protegidos.imagens', 'protegidos.preparacoes', 'protegidos.publicados', 'regiao',
    ]);
    assert.ok(!/A_PREENCHER/.test(JSON.stringify({ limites: objeto.limites, prazoMs: objeto.prazoMs })));
  });

  test('MOD-04 — o modelo preenchido não vira configuração utilizável por engano: sobreposição, duplicidade ou limite fora do executor ainda reprovam', () => {
    const base = JSON.parse(preenchido());
    const comAlteracao = (alterar) => { const o = JSON.parse(JSON.stringify(base)); alterar(o); return lerComo(JSON.stringify(o)); };
    assert.equal(comAlteracao((o) => { o.destinosLocais.BACKUP.raiz = o.protegidos.dumps; }).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
    assert.equal(comAlteracao((o) => { o.protegidos.dumps = o.protegidos.publicados; }).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
    assert.equal(comAlteracao((o) => { o.limites.arquivosMaximo = 400001; }).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
    assert.equal(comAlteracao((o) => { o.prazoMs = 600001; }).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
    assert.equal(comAlteracao((o) => { o.destinosLocais.BACKUP.id = 'qualquer-coisa'; }).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
  });
});

describe('[MOD] modelo SQL do papel de banco (H9-h)', () => {
  test('MOD-05 — contém EXATAMENTE os comandos previstos, em transação, e nada além', () => {
    assert.deepEqual(comandos(ler(SQL)), [
      'BEGIN',
      'CREATE ROLE safework_backup_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2',
      'GRANT CONNECT ON DATABASE A_PREENCHER TO safework_backup_executor',
      'GRANT USAGE ON SCHEMA public TO safework_backup_executor',
      'GRANT INSERT ON TABLE logs_auditoria_plataforma TO safework_backup_executor',
      'GRANT SELECT (id, criado_em) ON TABLE logs_auditoria_plataforma TO safework_backup_executor',
      'COMMIT',
    ]);
  });

  test('MOD-06 — sem senha, sem privilégio amplo, sem papel predefinido e sem DDL nos comandos ativos', () => {
    const ativo = semComentariosSql(ler(SQL));
    const semNegacoes = ativo.replace(/\bNO(?:SUPERUSER|CREATEDB|CREATEROLE|REPLICATION|BYPASSRLS)\b/g, '');
    for (const proibido of [/PASSWORD/i, /\bSUPERUSER\b/, /\bCREATEDB\b/, /\bCREATEROLE\b/, /\bREPLICATION\b/, /\bBYPASSRLS\b/, /\bALTER\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/i, /\bUPDATE\b/i,
      /pg_read_all_data|pg_read_all_settings|pg_write_all_data|pg_execute_server_program|pg_monitor|pg_signal_backend/i, /ALL PRIVILEGES/i, /WITH GRANT OPTION/i, /\bPUBLIC\b/, /ALL TABLES|ALL SEQUENCES/i]) {
      assert.ok(!proibido.test(semNegacoes), `comando ativo contém ${proibido}`);
    }
    assert.equal((ativo.match(/GRANT\b/g) ?? []).length, 4);
  });

  test('MOD-07 — documenta o que NÃO foi concedido e o que fica pendente no B3; o papel predefinido de leitura só aparece em comentário', () => {
    const texto = ler(SQL);
    const comentarios = texto.split('\n').filter((l) => /^\s*--/.test(l)).join('\n');
    assert.match(comentarios, /NAO CONCEDIDO/);
    assert.match(comentarios, /PENDENTE DE VALIDACAO NO B3/);
    assert.match(comentarios, /pg_read_all_data/);
    assert.match(comentarios, /NAO EXECUTAR/);
    assert.ok(!/pg_read_all_data/.test(semComentariosSql(texto)));
  });

  test('MOD-08 — falha de propósito enquanto incompleto: o único valor local é o banco A_PREENCHER, dentro da transação', () => {
    const ativo = semComentariosSql(ler(SQL));
    assert.equal((ativo.match(/A_PREENCHER/g) ?? []).length, 1);
    assert.ok(ativo.indexOf('BEGIN') < ativo.indexOf('A_PREENCHER') && ativo.indexOf('A_PREENCHER') < ativo.indexOf('COMMIT'));
  });
});

describe('[MOD] inércia dos modelos', () => {
  test('MOD-09 — nenhum código de src ou scripts referencia os modelos, e os arquivos não são executáveis', () => {
    const referencias = arvore('src').concat(arvore('scripts')).filter((a) => a.endsWith('.js'))
      .filter((a) => /papel-executor-backup|configuracao-ensaio\.json|ops\/sql|ops\/executor/.test(ler(a)));
    assert.deepEqual(referencias, []);
    for (const modelo of [CONFIG, SQL]) {
      const estado = fs.statSync(path.join(RAIZ, modelo));
      assert.equal(estado.mode & 0o111, 0, `${modelo} não pode ser executável`);
      assert.ok(ler(modelo).endsWith('\n'));
    }
  });
});
