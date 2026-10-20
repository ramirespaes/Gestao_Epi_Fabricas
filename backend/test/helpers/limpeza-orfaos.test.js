'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('./limpeza-orfaos');

/**
 * Autotestes do APOIO da fase RED da limpeza de órfãos (P-ORF-01). Rodam VERDES desde o início: provam que os cenários e os falsos fazem o que dizem, usando o
 * VERIFICADOR EXISTENTE como oráculo (a classificação de cada cenário é a que o verificador dá, não a que o autor do teste imagina). Se um destes falhar, os testes da
 * limpeza não valem nada.
 */

const { AGORA, DIA, h } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

/** Relatório do verificador existente sobre a árvore, com o banco falso da limpeza. */
const verificar = (raiz, bancoOpcoes, extra = {}) => verificador.verificarArmazenamento(a.criarBancoDeLimpeza(bancoOpcoes), {
  diretorio: raiz, agora: () => AGORA, idadeMinimaOrfaoMinutos: DIA, ...extra,
});
const achados = (relatorio, tipo) => relatorio.armazenamento.filter((s) => s.tipo === tipo);

describe('[APOIO-ORF] cenários de árvore, classificados pelo verificador existente', () => {
  test('APOIO-01 — órfão antigo: conjunto sem registro com 3 dias é ORFAO_CONJUNTO, fora de "recente", com os três arquivos e a idade certa', async () => {
    const raiz = novaRaiz();
    // Com o banco SEM nenhum registro o verificador desconfia do par banco/armazenamento (ver APOIO-17): por isso há uma imagem registrada e íntegra.
    const registrada = h.criarImagemEmpresa(raiz, { id: 1, empresaId: 7, agora: AGORA });
    const orfao = a.criarOrfao(raiz, { semente: 'a1', idadeMin: 3 * DIA });
    const r = await verificar(raiz, { empresas: [7], empresa: [registrada.linha] });
    const [sobra] = achados(r, 'ORFAO_CONJUNTO');
    assert.equal(r.armazenamento.length, 1);
    assert.equal(sobra.classe, 'ORFAO');
    assert.equal(sobra.recente, false);
    assert.equal(sobra.hash, orfao.hash);
    assert.equal(sobra.empresaId, 7);
    assert.deepEqual(sobra.arquivos, ['exibicao.webp', 'mestre.png', 'miniatura.webp']);
    assert.equal(sobra.idadeMinutos, 3 * DIA);
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual(orfao.nomes(), ['exibicao.webp', 'mestre.png', 'miniatura.webp']);
  });

  test('APOIO-02 — órfão recente (5 min) é listado como recente; com um arquivo antigo e outro novo a idade é a do MAIS NOVO', async () => {
    const raiz = novaRaiz();
    a.criarOrfao(raiz, { semente: 'a2-recente', idadeMin: 5 });
    const misto = a.criarOrfao(raiz, { semente: 'a2-misto', idadeMin: 3 * DIA });
    a.envelhecer(misto.caminhos['miniatura.webp'], 5);
    const r = await verificar(raiz, { empresas: [7] });
    assert.equal(r.armazenamento.length, 2);
    assert.equal(r.armazenamento.every((s) => s.recente === true), true);
    assert.equal(r.veredito, 'INTEGRO', 'o recente não entra no veredito');
    assert.equal(r.armazenamento.find((s) => s.hash === misto.hash).idadeMinutos, 5);
  });

  test('APOIO-03 — pasta de órfão vazia usa o mtime da própria pasta; temporário e variante extra têm a classe própria', async () => {
    const raiz = novaRaiz();
    const vazia = a.criarOrfao(raiz, { semente: 'a3-vazia', idadeMin: 2 * DIA, variantes: [] });
    const registrada = h.criarImagemEmpresa(raiz, { id: 1, empresaId: 7, agora: AGORA });
    const tmp = a.criarTemporario(raiz, { empresaId: 7, hash: registrada.shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA });
    const extra = path.join(raiz, registrada.pasta, 'mestre.jpg');
    fs.writeFileSync(extra, 'extra');
    a.envelhecer(extra, 3 * DIA);
    const r = await verificar(raiz, { empresas: [7], empresa: [registrada.linha] });
    const conjunto = achados(r, 'ORFAO_CONJUNTO');
    assert.equal(conjunto.length, 1);
    assert.equal(conjunto[0].hash, vazia.hash);
    assert.deepEqual(conjunto[0].arquivos, []);
    assert.equal(conjunto[0].idadeMinutos, 2 * DIA);
    assert.deepEqual(achados(r, 'TEMPORARIO_RESIDUAL').map((s) => s.arquivos), [[tmp.nome]]);
    assert.deepEqual(achados(r, 'ORFAO_VARIANTE').map((s) => s.arquivos), [['mestre.jpg']]);
    assert.equal(r.veredito, 'ORFAO');
  });

  test('APOIO-04 — biblioteca padrão órfã é ORFAO de escopo PADRAO; pasta de empresa que não existe é INVESTIGAR (nunca sobra comum)', async () => {
    const raiz = novaRaiz();
    const padrao = a.criarOrfao(raiz, { escopo: 'PADRAO', semente: 'a4-padrao' });
    const fantasma = a.criarOrfao(raiz, { empresaId: 99, semente: 'a4-fantasma' });
    const r = await verificar(raiz, { empresas: [7] });
    const doPadrao = r.armazenamento.find((s) => s.hash === padrao.hash);
    assert.deepEqual([doPadrao.escopo, doPadrao.tipo, doPadrao.classe], ['PADRAO', 'ORFAO_CONJUNTO', 'ORFAO']);
    const dele = r.armazenamento.find((s) => s.hash === fantasma.hash);
    assert.deepEqual([dele.tipo, dele.classe], ['ORFAO_EMPRESA_INEXISTENTE', 'INVESTIGAR']);
    assert.equal(r.veredito, 'INVESTIGAR');
  });

  test('APOIO-05 — linhaQueCobre faz o conjunto deixar de ser órfão (INTEGRO, sem achado), e a linha de outra empresa NÃO o cobre', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a5', idadeMin: 3 * DIA });
    const coberto = await verificar(raiz, { empresas: [7], empresa: [a.linhaQueCobre(orfao, { id: 1 })] });
    assert.equal(coberto.armazenamento.length, 0);
    assert.equal(coberto.veredito, 'INTEGRO');
    assert.deepEqual(coberto.resumo.imagens, { INTEGRO: 1, RECUPERAVEL: 0, INVESTIGAR: 0 });
    const outraEmpresa = { ...a.linhaQueCobre(orfao, { id: 2 }), empresa_id: 8 };
    const r = await verificar(raiz, { empresas: [7, 8], empresa: [outraEmpresa] });
    assert.equal(achados(r, 'ORFAO_CONJUNTO').length, 1, 'o registro de outra empresa não cobre o conjunto desta');
  });

  test('APOIO-06 — descritorQueCobre traz o SHA-256 do envio, o de cada variante e os tamanhos reais dos arquivos', () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a6' });
    const d = a.descritorQueCobre(orfao);
    assert.equal(d.sha256, orfao.hash);
    assert.equal(d.sha256Mestre, h.sha(fs.readFileSync(orfao.caminhos['mestre.png'])));
    assert.equal(d.sha256Exibicao, h.sha(fs.readFileSync(orfao.caminhos['exibicao.webp'])));
    assert.equal(d.sha256Miniatura, h.sha(fs.readFileSync(orfao.caminhos['miniatura.webp'])));
    assert.equal(d.bytesMestre, fs.statSync(orfao.caminhos['mestre.png']).size);
    assert.equal(d.formato, 'PNG');
    assert.deepEqual(Object.keys(d).sort(), ['altura', 'bytesExibicao', 'bytesMestre', 'bytesMiniatura', 'formato', 'largura', 'sha256', 'sha256Exibicao', 'sha256Mestre', 'sha256Miniatura']);
  });

  test('APOIO-07 — criarOrfao exige semente e recusa hash inválido em criarTemporario', () => {
    const raiz = novaRaiz();
    assert.throws(() => a.criarOrfao(raiz, {}), TypeError);
    assert.throws(() => a.criarTemporario(raiz, { hash: 'curto' }), TypeError);
  });

  test('APOIO-17 — banco SEM nenhum registro e armazenamento com órfão antigo: alerta BANCO_SEM_REGISTROS_COM_ARQUIVOS e veredito INVESTIGAR (a rede de proteção contra o banco errado)', async () => {
    const raiz = novaRaiz();
    a.criarOrfao(raiz, { semente: 'a17', idadeMin: 3 * DIA });
    const r = await verificar(raiz, { empresas: [7] });
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.deepEqual(r.alertas.map((alerta) => alerta.codigo), ['BANCO_SEM_REGISTROS_COM_ARQUIVOS']);
  });

  test('APOIO-18 — registros cujos arquivos NENHUM existe (armazenamento que não é o deste banco): alerta NENHUM_ARQUIVO_ESPERADO_PRESENTE e veredito INVESTIGAR', async () => {
    const raiz = novaRaiz();
    const nunca = h.criarImagemEmpresa(raiz, { id: 1, empresaId: 7, agora: AGORA, ausentes: ['mestre', 'exibicao', 'miniatura'] });
    a.criarOrfao(raiz, { semente: 'a18', idadeMin: 3 * DIA });
    const r = await verificar(raiz, { empresas: [7], empresa: [nunca.linha] });
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(r.alertas.some((alerta) => alerta.codigo === 'NENHUM_ARQUIVO_ESPERADO_PRESENTE'), true);
  });
});

describe('[APOIO-ORF] banco falso e fachada de arquivos', () => {
  test('APOIO-08 — o banco falso acha o registro por (empresa, SHA-256) com isolamento por empresa e vê alterações da lista mutável', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a8' });
    const banco = a.criarBancoDeLimpeza({ empresas: [7, 8] });
    const cliente = await banco.connect();
    const buscar = (empresaId) => cliente.query('SELECT id, empresa_id, sha256 FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2', [empresaId, orfao.hash]);
    assert.deepEqual((await buscar(7)).rows, []);
    banco.registro.push(a.linhaQueCobre(orfao, { id: 5 }));
    assert.equal((await buscar(7)).rows.length, 1);
    assert.equal((await buscar(7)).rows[0].id, '5');
    assert.deepEqual((await buscar(8)).rows, [], 'o registro de uma empresa não aparece para outra');
    cliente.release();
    assert.deepEqual(banco.contadores, { conexoes: 1, liberacoes: 1 });
  });

  test('APOIO-09 — a linha do tempo registra BEGIN, TRAVA (qualquer SQL "advisory"), REGISTRO, CONFIG, COMMIT, ROLLBACK e RELEASE, em ordem', async () => {
    const banco = a.criarBancoDeLimpeza({ empresas: [7] });
    const cliente = await banco.connect();
    await cliente.query('BEGIN READ ONLY');
    await cliente.query("SET LOCAL lock_timeout = '5s'");
    await cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', ['123']);
    await cliente.query('SELECT * FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2', [7, h.hex64('x')]);
    await cliente.query('COMMIT');
    await cliente.query('BEGIN');
    await cliente.query('ROLLBACK');
    cliente.release();
    assert.deepEqual(banco.eventos.map((e) => e.tipo), ['BEGIN', 'CONFIG', 'TRAVA', 'REGISTRO', 'COMMIT', 'BEGIN', 'ROLLBACK', 'RELEASE']);
    assert.equal(banco.eventos.find((e) => e.tipo === 'TRAVA').params[0], '123');
  });

  test('APOIO-10 — aoConsultar enxerga cada comando antes de ele ser atendido', async () => {
    const vistos = [];
    const banco = a.criarBancoDeLimpeza({ empresas: [7], aoConsultar: (sql) => { vistos.push(sql.split(' ')[0]); } });
    const cliente = await banco.connect();
    await cliente.query('BEGIN');
    await cliente.query('COMMIT');
    cliente.release();
    assert.deepEqual(vistos, ['BEGIN', 'COMMIT']);
  });

  test('APOIO-11 — a fachada de limpeza tem EXATAMENTE as sete operações permitidas, congelada, e registra unlink e rmdir reais (também na linha do tempo)', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a11', variantes: ['mestre.png'] });
    const eventos = [];
    const f = a.fachadaDeLimpeza(raiz, { eventos });
    assert.deepEqual(Object.keys(f.fs).sort(), ['constants', 'lstat', 'open', 'readdir', 'realpath', 'rmdir', 'unlink']);
    assert.equal(Object.isFrozen(f.fs), true);
    await f.fs.unlink(orfao.caminhos['mestre.png']);
    await f.fs.rmdir(orfao.pasta);
    assert.equal(orfao.existe(), false);
    assert.deepEqual(f.destrutivas().map((c) => [c.metodo, c.rel]), [['unlink', `${orfao.relPasta}/mestre.png`], ['rmdir', orfao.relPasta]]);
    assert.deepEqual(eventos.map((e) => [e.tipo, e.metodo]), [['FS', 'unlink'], ['FS', 'rmdir']]);
  });

  test('APOIO-12 — a fachada injeta falha em unlink e rmdir pelo caminho relativo, sem executar a operação', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a12', variantes: ['mestre.png'] });
    const f = a.fachadaDeLimpeza(raiz, { falhas: [{ metodo: 'unlink', ondeTermina: 'mestre.png', codigo: 'EACCES' }, { metodo: 'rmdir', ondeContem: orfao.hash, codigo: 'EBUSY' }] });
    await assert.rejects(f.fs.unlink(orfao.caminhos['mestre.png']), (e) => e.code === 'EACCES');
    await assert.rejects(f.fs.rmdir(orfao.pasta), (e) => e.code === 'EBUSY');
    assert.equal(fs.existsSync(orfao.caminhos['mestre.png']), true, 'a operação com falha não é executada');
  });
});

describe('[APOIO-ORF] trava de janela alheia, PID morto e saída limpa', () => {
  test('APOIO-13 — a trava alheia é criada de forma EXCLUSIVA (modo 600), com o documento do protocolo, e a segunda criação falha', () => {
    const raiz = novaRaiz();
    const arquivo = path.join(raiz, 'janela.lock');
    const doc = a.escreverTravaAlheia(arquivo, { tipo: 'BACKUP', pid: 4321 });
    assert.deepEqual(Object.keys(doc).sort(), ['hospedeiro', 'iniciadoEm', 'pid', 'tipo', 'token', 'versao']);
    assert.equal(doc.versao, 1);
    assert.match(doc.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')), doc);
    assert.equal((fs.statSync(arquivo).mode & 0o777).toString(8), '600');
    assert.throws(() => a.escreverTravaAlheia(arquivo), (e) => e.code === 'EEXIST');
  });

  test('APOIO-14 — pidMorto devolve o PID de um processo que já terminou', () => {
    const pid = a.pidMorto();
    assert.equal(Number.isInteger(pid) && pid > 0, true);
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH');
  });

  test('APOIO-15 — saidaLimpa recusa caminho absoluto e caractere de controle, e aceita quebra de linha', () => {
    const raiz = '/tmp/gepi-img-teste-x';
    assert.equal(a.saidaLimpa('linha 1\nlinha 2', raiz), true);
    assert.equal(a.saidaLimpa(`veja ${raiz}/7/abc`, raiz), false);
    assert.equal(a.saidaLimpa('esc\u001b[2J', raiz), false);
  });

  test('APOIO-16 — primeiro e ultimo localizam eventos da linha do tempo', () => {
    const ev = [{ t: 'a' }, { t: 'b' }, { t: 'a' }];
    assert.equal(a.primeiro(ev, (e) => e.t === 'a'), 0);
    assert.equal(a.ultimo(ev, (e) => e.t === 'a'), 2);
    assert.equal(a.primeiro(ev, (e) => e.t === 'z'), -1);
  });
});

describe('[APOIO-ORF] o "mundo" padrão dos testes de serviço', () => {
  test('APOIO-19 — criarMundo monta registrada íntegra + órfãos + banco e fachada na MESMA linha do tempo + pasta da trava separada, e o verificador existente concorda', async () => {
    const m = a.criarMundo(novaRaiz, { orfaos: [{ semente: 'm1', idadeMin: 3 * DIA }, { semente: 'm2', idadeMin: 5 }], registradas: 2 });
    assert.equal(m.registradas.length, 2);
    assert.equal(m.orfaos.length, 2);
    assert.notEqual(m.raiz, m.pastaDaTrava);
    assert.equal(path.dirname(m.arquivoDaJanela), m.pastaDaTrava);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a trava não é criada pelo mundo');
    const r = await verificador.verificarArmazenamento(m.banco, { diretorio: m.raiz, agora: () => AGORA, fs: m.fs, idadeMinimaOrfaoMinutos: DIA });
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual(r.armazenamento.map((s) => [s.hash === m.orfaos[0].hash ? 'antigo' : 'recente', s.recente]).sort(), [['antigo', false], ['recente', true]]);
    assert.deepEqual(m.destrutivas(), [], 'o verificador não destrói nada');
    assert.equal(m.banco.eventos.some((e) => e.tipo === 'BEGIN' && /READ ONLY/.test(e.sql)), true);
    assert.equal(m.banco.contadores.conexoes, 1);
    assert.equal(m.retrato().length > 0, true);
  });

  test('APOIO-20 — criarMundo com várias empresas só registra imagem na primeira, mas todas existem para o banco (a pasta das outras não é "empresa inexistente")', async () => {
    const m = a.criarMundo(novaRaiz, { empresas: [7, 8], orfaos: [{ semente: 'm3', idadeMin: 3 * DIA, empresaId: 8 }] });
    const r = await verificador.verificarArmazenamento(m.banco, { diretorio: m.raiz, agora: () => AGORA, fs: m.fs, idadeMinimaOrfaoMinutos: DIA });
    assert.deepEqual(r.armazenamento.map((s) => [s.empresaId, s.tipo, s.classe]), [[8, 'ORFAO_CONJUNTO', 'ORFAO']]);
    assert.equal(m.registradas[0].linha.empresa_id, 7);
  });
});

describe('[APOIO-ORF] fakes que não restringem a forma de uma implementação razoável', () => {
  test('APOIO-21 — o arquivo aberto pela fachada de limpeza delega ao FileHandle real: stat, read, readFile e createReadStream funcionam, tudo é registrado, e a falha de leitura injetada vale para `read`', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a21', variantes: ['mestre.png'] });
    const f = a.fachadaDeLimpeza(raiz);
    const arquivo = await f.fs.open(orfao.caminhos['mestre.png'], f.fs.constants.O_RDONLY | f.fs.constants.O_NOFOLLOW);
    try {
      assert.equal((await arquivo.stat()).isFile(), true);
      assert.deepEqual(await arquivo.readFile(), orfao.conteudos['mestre.png']);
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await arquivo.read(buffer, 0, 8, 0);
      assert.equal(bytesRead, 8);
      const blocos = [];
      for await (const bloco of arquivo.createReadStream({ autoClose: false, start: 0 })) blocos.push(bloco);
      assert.deepEqual(Buffer.concat(blocos), orfao.conteudos['mestre.png']);
    } finally {
      await arquivo.close();
    }
    assert.deepEqual([...new Set(f.chamadas.filter((c) => c.rel.endsWith('mestre.png')).map((c) => c.metodo))].sort(), ['close', 'createReadStream', 'open', 'read', 'readFile', 'stat']);

    const quebrada = a.fachadaDeLimpeza(raiz, { falhas: [{ metodo: 'read', ondeTermina: 'mestre.png', codigo: 'EIO' }] });
    const aberto = await quebrada.fs.open(orfao.caminhos['mestre.png'], quebrada.fs.constants.O_RDONLY);
    try {
      await assert.rejects(aberto.read(Buffer.alloc(4), 0, 4, 0), (e) => e.code === 'EIO');
    } finally {
      await aberto.close();
    }
  });

  test('APOIO-22 — o banco falso entende as formas equivalentes de SQL: START TRANSACTION, set_config, try-lock com alias qualquer, EXISTS e count; devolve rowCount e conta o que for lido', async () => {
    const raiz = novaRaiz();
    const orfao = a.criarOrfao(raiz, { semente: 'a22' });
    const banco = a.criarBancoDeLimpeza({ empresas: [7], empresa: [a.linhaQueCobre(orfao, { id: 3 })] });
    const c = await banco.connect();
    await c.query('START TRANSACTION READ ONLY');
    assert.deepEqual((await c.query("SELECT set_config('lock_timeout', $1, true)", ['5000'])).rowCount, 1);
    const trava = await c.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS travou', ['99']);
    assert.equal(trava.rows[0].travou, true);
    assert.equal(trava.rows[0].qualquer_alias, true);
    const achada = await c.query('SELECT id FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2', [7, orfao.hash]);
    assert.deepEqual([achada.rows.length, achada.rowCount], [1, 1]);
    assert.equal((await c.query('SELECT EXISTS (SELECT 1 FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2) AS existe', [7, orfao.hash])).rows[0].existe, true);
    assert.equal((await c.query('SELECT EXISTS (SELECT 1 FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2)', [8, orfao.hash])).rows[0].exists, false);
    assert.equal((await c.query('SELECT count(*) FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2', [7, orfao.hash])).rows[0].count, '1');
    await c.query('COMMIT');
    c.release();
    assert.deepEqual(banco.eventos.map((e) => e.tipo), ['BEGIN', 'CONFIG', 'TRAVA', 'REGISTRO', 'REGISTRO', 'REGISTRO', 'REGISTRO', 'COMMIT', 'RELEASE']);
    assert.equal(JSON.stringify(trava.rows[0]), '{}', 'a linha do try-lock não vira JSON com campos inventados');
  });
});
