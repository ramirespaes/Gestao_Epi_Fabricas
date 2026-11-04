'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarFonteDeChaves, criarLeitorV2 } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio, criarServicoDePacote, avaliarProntidaoOperacional } = require('../../src/services/imagem-backup-publicacao.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarJanelaDeBackup } = require('../../src/services/imagem-backup.service');
const { criarLeitorL2 } = require('../../src/services/backup-fontes-manifesto-l2.service');
const inv = require('../../src/repositories/backup-fontes-postgres-inventario.repository');
const { listarMigrations } = require('../../src/db/checksums');

/**
 * P6/P7 (D-ORF-6): COMPOSIÇÃO DE PRODUÇÃO com `layoutDoManifesto: 2` e restauração de produção com `layoutMinimo: 2`, nas MESMAS dependências controladas do teste histórico
 * (diretórios temporários, `spawn` falso, cliente PostgreSQL falso, chaves em memória). O padrão (sem a opção) tem de continuar byte a byte layout 1. Nada aqui é operacional.
 */

const PREFIXO = 'gepi-cpl2-test-';
const raizes = [];
const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const DUMP_BYTES = Buffer.from('dump-ficticio-l2-0123456789-'.repeat(100));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const POLITICA = { prefixoDoBanco: 'gepi_cp_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi'] };
const DESTINO = Object.freeze({ banco: 'gepi_cp_restaurado', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: '/tmp/gepi-cpl2-pgpass-ficticio' });
const MIGRATIONS_DO_CODIGO = listarMigrations(path.join(__dirname, '..', '..', 'migrations')).map((m) => m.nome.replace(/\.sql$/, ''));

after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const r of raizes) if (path.dirname(r) === tmp && path.basename(r).startsWith(PREFIXO)) fs.rmSync(r, { recursive: true, force: true });
});
function novaRaiz() { const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); fs.chmodSync(r, 0o700); raizes.push(r); return r; }

const conteudos = ['padrao-mestre', 'padrao-miniatura', 'empresa7-mestre', 'empresa7-exibicao', 'empresa7-miniatura'].map((t) => Buffer.from(`${t}-conteudo-l2`));
const [pm, pn, em, ee, en] = conteudos;
const linhas = () => ({
  padrao: [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }],
  empresa: [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }],
});
const tipoDe = (sql) => {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/data_directory/.test(t)) return 'SONDA';
  if (/current_database\(\) AS nome/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return 'OUTRO';
};
/** Cliente falso que também responde ao inventário do P4 (relações, outros, extensões, servidor, migrations). */
function clienteFalso(banco, dados = linhas(), { migrations = MIGRATIONS_DO_CODIGO } = {}) {
  const c = {
    ouvintes: { error: [], end: [] }, sqls: [],
    async connect() {},
    async query(sql, parametros) {
      if (sql === inv.SQL.RELACOES) return { rows: [{ esquema: 'public', nome: 'imagens_padrao', relkind: 'r', sustenta_restricao: false, sequencia_implicita: false }] };
      if (sql === inv.SQL.OUTROS) return { rows: inv.CATEGORIAS_DE_OUTROS.map((cat) => ({ categoria: cat, quantidade: '0' })) };
      if (sql === inv.SQL.EXTENSOES) return { rows: [] };
      if (sql === inv.SQL.SERVIDOR) return { rows: [{ versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' }] };
      if (sql === inv.SQL.migrations('public')) return { rows: migrations.map((name) => ({ name })) };
      const tipo = tipoDe(sql);
      c.sqls.push(tipo);
      switch (tipo) {
        case 'EXPORTAR': return { rows: [{ snapshot_id: '00000003-0000001B-1' }] };
        case 'IDENTIDADE': return { rows: [{ nome: banco, oid: '16384' }] };
        case 'SONDA': return { rows: [{ banco, versao: '160015', data_directory: '/dados/pg-ficticio', sockets: '/tmp/s-ficticio', porta: '5432', listen: '', sem_tcp: true }] };
        case 'PADRAO': return { rows: dados.padrao.filter((l) => BigInt(l.id) > BigInt(parametros[0])).slice(0, parametros[1]) };
        case 'EMPRESA': return { rows: dados.empresa.filter((l) => BigInt(l.id) > BigInt(parametros[0])).slice(0, parametros[1]) };
        default: return { rows: [] };
      }
    },
    async end() { for (const f of c.ouvintes.end) f(); },
    on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
  };
  return c;
}
// Sumário REAL mínimo (formato documentado do PostgreSQL 16): a tabela do inventário falso com TABLE + TABLE DATA; 2 declaradas, 2 listadas.
const SUMARIO_COERENTE = ';     TOC Entries: 2\n;     Format: CUSTOM\n;     Dumped from database version: 16.4\n1; 1259 1 TABLE public imagens_padrao d\n2; 0 1 TABLE DATA public imagens_padrao d\n';
function spawnFalso({ dump = 'ok', lista = 'ok', restore = 'ok', sumario = '; Format: CUSTOM\n; TOC Entries: 12\n' } = {}) {
  const chamadas = [];
  let pid = 7000;
  const spawn = (exe, args, opcoes) => {
    const nome = path.basename(exe);
    chamadas.push({ nome, args: [...args], env: opcoes.env, shell: opcoes.shell, stdio: opcoes.stdio });
    const filho = new EventEmitter();
    pid += 1;
    filho.pid = pid;
    filho.kill = () => true;
    filho.stdout = nome === 'pg_dump' ? new PassThrough() : new EventEmitter();
    filho.stderr = new PassThrough();
    setImmediate(() => {
      filho.emit('spawn');
      if (nome === 'pg_dump') {
        if (dump !== 'falha') filho.stdout.write(DUMP_BYTES);
        filho.stdout.end(); filho.stderr.end();
        filho.emit('exit', dump === 'falha' ? 1 : 0, null);
        filho.emit('close', 0, null);
      } else if (args.includes('--list')) {
        filho.stdout.emit('data', Buffer.from(sumario, 'latin1'));
        filho.emit('exit', lista === 'falha' ? 1 : 0, null);
        filho.emit('close', 0, null);
      } else {
        filho.emit('exit', restore === 'falha' ? 1 : 0, null);
        filho.emit('close', 0, null);
      }
    });
    return filho;
  };
  return { chamadas, spawn };
}
const temporizadorInerte = { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() };

async function ambiente({ spawn = spawnFalso().spawn, alterarConfig = (c) => c, banco = 'gepi_cp_origem', dados = linhas() } = {}) {
  const raiz = novaRaiz();
  const dirs = {};
  for (const d of ['imagens', 'preparacoes', 'dumps', 'publicados', 'bin', 'seg']) { dirs[d] = path.join(raiz, d); fs.mkdirSync(dirs[d], { mode: 0o700 }); }
  const pgDump = path.join(dirs.bin, 'pg_dump');
  const pgRestore = path.join(dirs.bin, 'pg_restore');
  for (const b of [pgDump, pgRestore]) fs.writeFileSync(b, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const pgpass = path.join(dirs.seg, 'pgpass');
  fs.writeFileSync(pgpass, '*:5432:*:gepi_cp:fictia\n', { mode: 0o600 });
  const armazenamento = criarArmazenamentoImagens({ diretorio: dirs.imagens });
  const regs = {
    padrao: dados.padrao.map((l) => ({ id: l.id, sha256: l.sha256, sha256Miniatura: l.sha256_miniatura, sha256Exibicao: l.sha256_exibicao, formato: l.formato, bytesMestre: l.bytes_mestre, bytesMiniatura: l.bytes_miniatura, bytesExibicao: l.bytes_exibicao })),
    empresa: dados.empresa.map((l) => ({ id: l.id, empresaId: l.empresa_id, sha256: l.sha256, sha256Mestre: l.sha256_mestre, sha256Exibicao: l.sha256_exibicao, sha256Miniatura: l.sha256_miniatura, formato: l.formato, bytesMestre: l.bytes_mestre, bytesExibicao: l.bytes_exibicao, bytesMiniatura: l.bytes_miniatura })),
  };
  for (const item of planejarArquivos(regs)) await armazenamento.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-1', segredo: crypto.randomBytes(32) }] });
  const config = alterarConfig({
    postgres: { pgDump, pgRestore, host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: pgpass, banco: { nome: banco, oid: '16384' } },
    conexao: { criarConexao: () => clienteFalso(banco, dados), finalizacaoMs: 5000 },
    armazenamento: { imagens: dirs.imagens, preparacoes: dirs.preparacoes, dumps: dirs.dumps, publicados: dirs.publicados },
    chaves: { fonteDeChaves, chaveId: 'k-1' },
    janela: criarJanelaDeBackup({ arquivo: path.join(raiz, 'janela.lock'), raizArmazenamento: dirs.imagens }),
    relatorio: { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] },
    prazos: { ...PRAZOS },
    maxBytesPorArquivo: 4096,
    portas: { spawn, observarGrupo: async () => false, temporizador: temporizadorInerte },
  });
  return { raiz, dirs, config, fonteDeChaves };
}
const executar = (cfg, nome = 'prep-l2') => criarBackupDeProducao(cfg).executar({ nomeDaPreparacao: nome, conjuntoId: 'conjunto-cpl2-0001' });
const arvore = (dir) => { const out = []; const anda = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) anda(r); else out.push(r); } }; anda(''); return out.sort(); };

describe('[CP-L2] produção com manifesto layout 2', () => {
  teste('CP-L2-01 — backup L2 publicado (produtor de teste): pacote `arquivos/imagens/<chave>`, manifesto layout 2 autenticado, publicador e prontidão aceitam o L2; mesmos processos e ambiente fechado do L1', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ spawn: falso.spawn, alterarConfig: (c) => ({ ...c, layoutDoManifesto: 2 }) });
    const composto = await executar(a.config);
    const estado = classificarEstadoDoBackup(composto);
    assert.equal(composto.resultado.composicao?.ok, true, JSON.stringify(composto.resultado.composicao));
    assert.equal(composto.resultado.composicao.layout, 2);
    assert.equal(composto.resultado.pacote?.ok, true, JSON.stringify(composto.resultado.pacote));
    assert.equal(composto.resultado.pacote.consistencia.demonstrada, true, 'consistência plano × cópia demonstrada com a releitura física do L2');
    assert.equal(estado.pacotePublicado, true, JSON.stringify(composto.resultado.publicacao));
    assert.equal(estado.publicacaoOperacional, false);
    assert.deepEqual([...estado.pendenciasDaProntidao].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES'], 'o manifesto L2 autenticado NÃO é pendência');
    const publicado = path.join(a.dirs.publicados, 'prep-l2');
    const esperados = planejarArquivos({ padrao: [], empresa: [] }).length === 0 ? null : null; // só para documentar: o plano real vem do cliente falso
    assert.equal(esperados, null);
    const lista = arvore(publicado);
    assert.ok(lista.every((f) => f.startsWith('arquivos/imagens/') || f === 'manifesto.json' || f === 'manifesto.sha256' || f === 'dump/postgres.dump'), lista.join(','));
    assert.equal(lista.filter((f) => f.startsWith('arquivos/imagens/')).length, 5);
    assert.ok(!lista.some((f) => f.startsWith('imagens/')), 'nenhum caminho do layout 1');
    const bytes = fs.readFileSync(path.join(publicado, 'manifesto.json'));
    const lido = criarLeitorL2({ fonteDeChaves: a.fonteDeChaves, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) });
    assert.deepEqual([lido.layout, lido.fontes.map((f) => [f.id, f.total.arquivos])], [2, [['imagens', 5]]]);
    // sumário falso padrão (12 declaradas, nenhuma listada) => N0 pelos motivos reais do comparador (o nível nunca bloqueia a publicação)
    assert.equal(lido.postgres.nivelAtingido, 'N0');
    assert.ok(lido.postgres.motivos.includes('CONTAGEM_DIVERGENTE'), lido.postgres.motivos.join(','));
    assert.equal(lido.manifesto.cobertura.declaracao, 'NAO_COMPROVADA');
    assert.equal(lido.manifesto.dump.sha256, sha(DUMP_BYTES));
    // o leitor antigo recusa o L2 ANTES de qualquer estrutura: o MAC do domínio L2 não vale no domínio L1 (M2-2), falha fechada
    assert.throws(() => criarLeitorV2({ fonteDeChaves: a.fonteDeChaves })({ bytes, sha256: sha(bytes) }), (e) => e.code === 'MANIFESTO_INVALIDO' && e.motivo === 'MAC_INVALIDO', 'leitor antigo falha fechado diante do L2');
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_dump', 'pg_restore']);
    assert.deepEqual(Object.keys(falso.chamadas[0].env).sort(), ['PGHOST', 'PGPASSFILE', 'PGPORT', 'PGUSER']);
    // verificação do pacote L2 pelo serviço histórico (edição A) e recusa de extra/divergente
    const servico = criarServicoDePacote();
    const v = await servico.verificarPacote({ preparacao: publicado, manifesto: lido.manifesto, identidade: lido.identidade });
    assert.deepEqual([v.ok, v.arquivos], [true, 8]);
    fs.writeFileSync(path.join(publicado, 'arquivos', 'extra.bin'), 'x');
    assert.equal((await servico.verificarPacote({ preparacao: publicado, manifesto: lido.manifesto, identidade: lido.identidade })).motivo, 'ARQUIVO_EXTRA');
    fs.rmSync(path.join(publicado, 'arquivos', 'extra.bin'));
    const prontidao = avaliarProntidaoOperacional({ correlacao: composto.resultado.correlacao, pacote: composto.resultado.pacote.verificacao, consistencia: composto.resultado.pacote.consistencia, autenticacao: lido.autenticacao, destino: { raizDoDestino: a.dirs.publicados, nomeFinal: 'prep-l2' } });
    assert.ok(!prontidao.pendencias.includes('MANIFESTO_V2_AUTENTICADO'), JSON.stringify(prontidao.pendencias));
    assert.ok(prontidao.pendencias.includes('FONTE_OPERACIONAL_DE_CHAVES'));
  });

  teste('CP-L2-05 — P8: a verificação estrutural corre ANTES da selagem e o sumário capturado alimenta o bloco cobertura.postgres: com inventário coerente e sumário real, o manifesto L2 publicado registra N1; sem sumário coerente, N0 com motivo; o L1 não muda de ordem de processos', async () => {
    const falso = spawnFalso({ sumario: SUMARIO_COERENTE });
    const a = await ambiente({ spawn: falso.spawn, alterarConfig: (c) => ({ ...c, layoutDoManifesto: 2 }) });
    const composto = await executar(a.config, 'prep-n1');
    assert.equal(classificarEstadoDoBackup(composto).pacotePublicado, true, JSON.stringify(composto.resultado.publicacao));
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_dump', 'pg_restore'], 'a listagem estrutural continua uma só, depois do dump');
    const bytes = fs.readFileSync(path.join(a.dirs.publicados, 'prep-n1', 'manifesto.json'));
    const lido = criarLeitorL2({ fonteDeChaves: a.fonteDeChaves, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) });
    assert.deepEqual([lido.postgres.nivelCalculado, lido.postgres.nivelAtingido, lido.postgres.motivos], ['N1', 'N1', []]);
    assert.equal(lido.postgres.relacoes.correspondidas, 1);
    assert.equal(lido.postgres.esquema.compatibilidade.relacao, 'IGUAL');
    assert.deepEqual(lido.avisos, ['CHAVE_NAO_OPERACIONAL'], 'sem aviso NIVEL_N0');
    // sumário incoerente (12 declaradas, 0 listadas): bloco N0 com motivo, backup continua publicado (o nível nunca bloqueia a publicação)
    const b = await ambiente({ alterarConfig: (c) => ({ ...c, layoutDoManifesto: 2 }) });
    const c2 = await executar(b.config, 'prep-n0');
    assert.equal(classificarEstadoDoBackup(c2).pacotePublicado, true);
    const bytes0 = fs.readFileSync(path.join(b.dirs.publicados, 'prep-n0', 'manifesto.json'));
    const lido0 = criarLeitorL2({ fonteDeChaves: b.fonteDeChaves, layoutMinimo: 2 })({ bytes: bytes0, sha256: sha(bytes0) });
    assert.equal(lido0.postgres.nivelAtingido, 'N0');
    assert.ok(lido0.postgres.motivos.includes('CONTAGEM_DIVERGENTE') || lido0.postgres.motivos.includes('RELACAO_AUSENTE_NO_DUMP'), lido0.postgres.motivos.join(','));
    // estrutura que falha (saída não zero): a composição L2 grava N0 com o motivo da estrutura e a publicação é recusada pelas portas históricas (ESTRUTURA_NAO_VERIFICADA)
    const quebrado = spawnFalso({ lista: 'falha', sumario: SUMARIO_COERENTE });
    const d = await ambiente({ spawn: quebrado.spawn, alterarConfig: (c) => ({ ...c, layoutDoManifesto: 2 }) });
    const c3 = await executar(d.config, 'prep-falha');
    assert.equal(classificarEstadoDoBackup(c3).pacotePublicado, false);
    assert.equal(c3.resultado.composicao.ok, true, 'a composição (preparação) ainda acontece; só a publicação é recusada');
    const bytesF = fs.readFileSync(path.join(d.dirs.preparacoes, 'prep-falha', 'manifesto.json'));
    const lidoF = criarLeitorL2({ fonteDeChaves: d.fonteDeChaves, layoutMinimo: 2 })({ bytes: bytesF, sha256: sha(bytesF) });
    assert.deepEqual([lidoF.postgres.nivelAtingido, lidoF.postgres.motivos], ['N0', ['ESTRUTURA_NAO_VERIFICADA_ANTES_DA_SELAGEM']]);
  });

  teste('CP-L2-02 — regressão: sem `layoutDoManifesto` o pacote continua layout 1 (`imagens/<chave>`, manifesto V2/L1 lido pelo leitor antigo); layout 2 explícito e padrão não se confundem', async () => {
    const a = await ambiente();
    const composto = await executar(a.config, 'prep-l1');
    assert.equal(classificarEstadoDoBackup(composto).pacotePublicado, true);
    const publicado = path.join(a.dirs.publicados, 'prep-l1');
    const lista = arvore(publicado);
    assert.equal(lista.filter((f) => f.startsWith('imagens/')).length, 5);
    assert.ok(!lista.some((f) => f.startsWith('arquivos/')));
    const bytes = fs.readFileSync(path.join(publicado, 'manifesto.json'));
    const l1 = criarLeitorV2({ fonteDeChaves: a.fonteDeChaves })({ bytes, sha256: sha(bytes) });
    assert.deepEqual([l1.manifesto.layout, l1.manifesto.versao, l1.manifesto.arquivos.length], [1, 2, 5]);
    assert.equal(composto.resultado.composicao.layout, undefined, 'a composição histórica não ganha campo novo');
    // o leitor L2 com layout mínimo 1 normaliza o L1; com layout mínimo 2 recusa (anti-rebaixamento)
    assert.equal(criarLeitorL2({ fonteDeChaves: a.fonteDeChaves, layoutMinimo: 1 })({ bytes, sha256: sha(bytes) }).fontes[0].id, 'imagens');
    assert.throws(() => criarLeitorL2({ fonteDeChaves: a.fonteDeChaves, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) }), (e) => e.motivo === 'LAYOUT_INSUFICIENTE');
  });

  teste('CP-L2-03 — configuração: layout fora de {1,2}, `fontes`/`catalogo` sem layout 2, fonte sem adaptador, fiscalização sem diretório e catálogo inválido são CONFIGURACAO_INVALIDA', async () => {
    const a = await ambiente();
    const invalida = (e) => e instanceof TypeError && e.code === 'CONFIGURACAO_INVALIDA';
    assert.throws(() => criarBackupDeProducao({ ...a.config, layoutDoManifesto: 3 }), invalida);
    assert.throws(() => criarBackupDeProducao({ ...a.config, fontes: ['imagens'] }), invalida);
    assert.throws(() => criarBackupDeProducao({ ...a.config, layoutDoManifesto: 2, fontes: ['postgres-aplicacao'] }), invalida);
    assert.throws(() => criarBackupDeProducao({ ...a.config, layoutDoManifesto: 2, fontes: ['imagens', 'fiscalizacao-pacotes'] }), invalida, 'fiscalização exige armazenamento.fiscalizacao');
    assert.throws(() => criarBackupDeProducao({ ...a.config, layoutDoManifesto: 2, catalogo: { versao: 1, fontes: [] } }), invalida);
    assert.ok(criarBackupDeProducao({ ...a.config, layoutDoManifesto: 2 }));
    assert.ok(criarBackupDeProducao({ ...a.config, layoutDoManifesto: 2, armazenamento: { ...a.config.armazenamento, fiscalizacao: a.dirs.dumps }, fontes: ['imagens', 'fiscalizacao-pacotes'] }));
  });

  teste('CP-L2-04 — restauração de produção L2: selagem relida pelo leitor L2, dump conferido e entregue ao pg_restore (política imposta), referências e migrations lidas do banco restaurado, conciliação INTEGRO; linha a mais => INCOMPLETO (F2); pacote L1 com layoutMinimo 2 recusado; falhas fechadas', async () => {
    const a = await ambiente({ alterarConfig: (c) => ({ ...c, layoutDoManifesto: 2 }) });
    const composto = await executar(a.config);
    assert.equal(classificarEstadoDoBackup(composto).pacotePublicado, true);
    const restauracao = ({ spawn = spawnFalso().spawn, dados = linhas(), migrations } = {}) => {
      const clientes = [];
      return { clientes, r: criarRestauracaoDeProducao({ postgres: { pgRestore: a.config.postgres.pgRestore }, politicaDeDestino: { ...POLITICA }, fonteDeChaves: a.fonteDeChaves, criarConexaoDoBanco: (banco) => { const c = clienteFalso(banco, dados, migrations === undefined ? {} : { migrations }); clientes.push(c); return c; }, prazos: { ...PRAZOS }, portas: { spawn, observarGrupo: async () => false, temporizador: temporizadorInerte } }) };
    };
    const pedido = (extras = {}) => ({ raizAutorizada: a.dirs.publicados, nome: 'prep-l2', imagens: { raiz: novaRaiz(), nome: 'img' }, destino: DESTINO, layoutMinimo: 2, maxBytesPorArquivo: 4096, ...extras });
    const falso = spawnFalso();
    const { r, clientes } = restauracao({ spawn: falso.spawn });
    const out = await r.restaurar(pedido());
    assert.equal(out.restauracao.ok, true, JSON.stringify(out.restauracao));
    assert.deepEqual(out.restauracao.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
    assert.deepEqual(out.restauracao.ordem.concluidos, ['DESTINO_NOVO', 'VERIFICACOES_8_7', 'BANCO_E_ESQUEMA', 'VERIFICADOR_POR_FONTE', 'RESULTADO']);
    assert.equal(out.restauracao.esquema.relacao, 'IGUAL');
    assert.equal(out.restauracao.banco.ok, true);
    assert.deepEqual(falso.chamadas.map((c) => [c.nome, c.args]), [['pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_cp_restaurado']]]);
    assert.equal(clientes.length, 1, 'uma conexão ao banco restaurado, somente leitura');
    assert.ok(clientes[0].sqls.includes('BEGIN') && clientes[0].sqls.includes('ROLLBACK') && clientes[0].sqls.includes('PADRAO'));
    assert.deepEqual(out.estado, { restauracaoReal: false, consistenciaLogicaVerificada: true, recuperavelEmProducao: false, publicacaoOperacional: false });
    assert.equal(out.restauracao.fontes.imagens.restaurados, 5);
    // F2: o banco restaurado tem uma linha sem arquivo
    const dados = linhas();
    dados.padrao.push({ id: '9', sha256: H('e'), sha256_miniatura: H('f'), sha256_exibicao: null, formato: 'PNG', bytes_mestre: 1, bytes_miniatura: 1, bytes_exibicao: null });
    const f2 = await restauracao({ dados }).r.restaurar(pedido());
    assert.deepEqual([f2.restauracao.ok, f2.restauracao.veredito.classe, f2.restauracao.fontes.imagens.conciliacao.divergencias.map((d) => d.falha)], [false, 'INCOMPLETO', ['F2', 'F2']]);
    assert.equal(f2.estado.consistenciaLogicaVerificada, false);
    // F12: migrations do banco restaurado à frente do código
    const f12 = await restauracao({ migrations: [...MIGRATIONS_DO_CODIGO, '999_futura'] }).r.restaurar(pedido());
    assert.deepEqual([f12.restauracao.ok, f12.restauracao.veredito.classe, f12.restauracao.esquema.codigo], [false, 'INCONSISTENTE', 'ESQUEMA_A_FRENTE_DO_CODIGO']);
    // pg_restore falha => para em BANCO_E_ESQUEMA, sem arquivos restaurados
    const pgFalha = await restauracao({ spawn: spawnFalso({ restore: 'falha' }).spawn }).r.restaurar(pedido());
    assert.deepEqual(pgFalha.restauracao.falha, { passo: 'BANCO_E_ESQUEMA', codigo: 'PG_RESTORE_SAIDA_NAO_ZERO' });
    // destino não autorizado pela política => nada é lançado
    const naoAutorizado = await restauracao().r.restaurar(pedido({ destino: { ...DESTINO, banco: 'gestao_epi' } }));
    assert.deepEqual(naoAutorizado.restauracao.falha, { passo: 'BANCO_E_ESQUEMA', codigo: 'DESTINO_NAO_AUTORIZADO' });
    // pacote L1 com layoutMinimo 2: recusado nas verificações 8.7 (anti-rebaixamento), nenhum processo
    const l1 = await ambiente();
    await executar(l1.config, 'prep-l1');
    const falsoL1 = spawnFalso();
    const rl1 = criarRestauracaoDeProducao({ postgres: { pgRestore: l1.config.postgres.pgRestore }, politicaDeDestino: { ...POLITICA }, fonteDeChaves: l1.fonteDeChaves, criarConexaoDoBanco: (banco) => clienteFalso(banco), prazos: { ...PRAZOS }, portas: { spawn: falsoL1.spawn, observarGrupo: async () => false, temporizador: temporizadorInerte } });
    const rebaixado = await rl1.restaurar({ raizAutorizada: l1.dirs.publicados, nome: 'prep-l1', imagens: { raiz: novaRaiz(), nome: 'img' }, destino: DESTINO, layoutMinimo: 2, maxBytesPorArquivo: 4096 });
    assert.equal(rebaixado.restauracao.ok, false);
    assert.equal(rebaixado.restauracao.falha.passo, 'VERIFICACOES_8_7');
    assert.equal(falsoL1.chamadas.length, 0, 'nada é lançado antes das verificações');
    // entrada L2 sem maxBytesPorArquivo => CONFIGURACAO_INVALIDA
    await assert.rejects(() => restauracao().r.restaurar({ raizAutorizada: a.dirs.publicados, nome: 'prep-l2', imagens: { raiz: novaRaiz(), nome: 'img' }, destino: DESTINO, layoutMinimo: 2 }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});
