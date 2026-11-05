'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Rb = require('../../src/services/backup-recibo-duravel.service');
const { ambienteS3 } = require('../helpers/ambiente-s3-falso');

/** R-D45 [VER]: verificador INDEPENDENTE e somente leitura — compara o bucket com os recibos, com credencial própria e fora do host. Cliente S3 falso; dados sintéticos. */

const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-ver-'));
fs.chmodSync(raiz, 0o700);
after(() => fs.rmSync(raiz, { recursive: true, force: true }));
const ARQUIVOS = [
  { chave: 'envelope.json', conteudo: Buffer.from('{"envelope":true}') },
  { chave: 'dados/a.enc', conteudo: crypto.randomBytes(500) },
  { chave: 'dados/b.enc', conteudo: crypto.randomBytes(40) },
];
async function preparar(opcoes) {
  const a = ambienteS3(opcoes);
  const c = await a.publicar({ arquivos: ARQUIVOS, raiz });
  assert.equal(c.ok, true);
  return { a, c };
}
const porChave = (r, chave) => r.itens.find((i) => i.chave === chave);
const CH = (arq) => `hml/c1/${arq}`;

describe('[VER] conferência do bucket contra os recibos', () => {
  test('VER-01 — conjunto íntegro: tudo CONFORME; o cliente do verificador só tem três operações de leitura e é o único usado', async () => {
    const { a, c } = await preparar();
    const antes = a.s3.chamadas.length;
    const r = await a.verificador().verificar(c.consolidado);
    assert.equal(r.conforme, true, JSON.stringify(r));
    assert.equal(r.motivo, null);
    assert.deepEqual(r.resumo, { conformes: 3, ausentes: 0, divergentes: 0, extras: 0 });
    assert.equal(r.comprovacoesPendentes.length, 5, 'conforme com os recibos NÃO dispensa a comprovação em T2 e T3');
    assert.ok(r.comprovacoesPendentes.includes('RESTAURACAO_COMPLETA_A_COMPROVAR_EM_T3'));
    assert.deepEqual(r.itens.map((i) => i.estado), ['CONFORME', 'CONFORME', 'CONFORME']);
    assert.ok(r.itens.every((i) => i.codigos.length === 0));
    assert.deepEqual(Object.keys(a.s3.clientes.verificador).sort(), ['identidade', 'lerMetadadosDaVersao', 'listarVersoes']);
    const novas = a.s3.chamadas.slice(antes);
    assert.ok(novas.every((x) => x.papel === 'verificador'));
    assert.deepEqual([...new Set(novas.map((x) => x.operacao))].sort(), ['identidade', 'lerMetadadosDaVersao', 'listarVersoes']);
  });

  test('VER-02 — versão EXTRA forjada sob o mesmo nome: a conferência acusa a extra e que a versão do recibo deixou de ser a atual', async () => {
    const { a, c } = await preparar();
    const extra = a.s3.injetarVersaoExtra(CH('dados/a.enc'), Buffer.from('conteudo forjado'));
    const r = await a.verificador().verificar(c.consolidado);
    assert.equal(r.conforme, false);
    assert.deepEqual(r.extras, [{ chave: CH('dados/a.enc'), versaoId: extra, codigo: 'VERSAO_EXTRA' }]);
    assert.deepEqual(porChave(r, CH('dados/a.enc')).codigos, ['VERSAO_DO_RECIBO_NAO_E_A_ATUAL']);
    assert.equal(porChave(r, CH('dados/a.enc')).estado, 'DIVERGENTE');
    assert.equal(porChave(r, CH('dados/b.enc')).estado, 'CONFORME');
    assert.deepEqual(r.resumo, { conformes: 2, ausentes: 0, divergentes: 1, extras: 1 });
  });

  test('VER-03 — conteúdo diferente do recibo: SHA-256 e bytes divergentes; versão ausente; objeto sem recibo; marcador de exclusão', async () => {
    const { a, c } = await preparar();
    const idA = a.s3.versoes(CH('dados/a.enc'))[0].versaoId;
    a.s3.corromper(CH('dados/a.enc'), idA, crypto.randomBytes(501));
    const idB = a.s3.versoes(CH('dados/b.enc'))[0].versaoId;
    a.s3.corromper(CH('dados/b.enc'), idB, crypto.randomBytes(40));
    a.s3.injetarVersaoExtra('hml/c1/dados/orfao.enc', Buffer.from('sem recibo'));
    a.s3.adicionarMarcadorDeExclusao(CH('envelope.json'));
    const r = await a.verificador().verificar(c.consolidado);
    assert.equal(r.conforme, false);
    assert.deepEqual([...porChave(r, CH('dados/a.enc')).codigos].sort(), ['BYTES_DIVERGENTES', 'SHA256_DIVERGENTE']);
    assert.deepEqual(porChave(r, CH('dados/b.enc')).codigos, ['SHA256_DIVERGENTE']);
    assert.ok(r.extras.some((e) => e.chave === 'hml/c1/dados/orfao.enc' && e.codigo === 'OBJETO_SEM_RECIBO'));
    assert.ok(r.extras.some((e) => e.chave === CH('envelope.json') && e.codigo === 'MARCADOR_DE_EXCLUSAO'));

    const outro = await preparar();
    const falso = JSON.parse(outro.c.bytes.toString('utf8'));
    falso.recibos[0].versaoId = 'versao-inexistente';
    const consolidado = Rb.consolidarRecibos({ destinoId: falso.destinoId, ambiente: falso.ambiente, conjuntoId: falso.conjuntoId, recibos: falso.recibos });
    const ausente = await outro.a.verificador().verificar(consolidado.consolidado);
    assert.equal(ausente.conforme, false);
    assert.deepEqual(ausente.itens.find((i) => i.versaoId === 'versao-inexistente').codigos, ['VERSAO_AUSENTE']);
    assert.equal(ausente.itens.find((i) => i.versaoId === 'versao-inexistente').estado, 'AUSENTE');
    assert.equal(ausente.resumo.ausentes, 1);
  });

  test('VER-04 — retenção do Object Lock: ausente ou expirada na versão do recibo reprova', async () => {
    const { a, c } = await preparar();
    a.s3.semRetencao(CH('dados/b.enc'), a.s3.versoes(CH('dados/b.enc'))[0].versaoId);
    const r1 = await a.verificador().verificar(c.consolidado);
    assert.deepEqual(porChave(r1, CH('dados/b.enc')).codigos, ['RETENCAO_AUSENTE']);
    const { a: a2, c: c2 } = await preparar();
    a2.avancar(8 * 86400000);
    const r2 = await a2.verificador().verificar(c2.consolidado);
    assert.equal(r2.conforme, false);
    assert.ok(r2.itens.every((i) => i.codigos.includes('RETENCAO_EXPIRADA')));
  });

  test('VER-05 — a credencial tem de ser a do verificador: a do publicador ou da restauração não é independente; conta errada diverge; falha ao consultar não ecoa', async () => {
    const { a, c } = await preparar();
    const quem = (papel) => ({ ...a.s3.clientes.verificador, identidade: a.s3.clientes[papel].identidade });
    for (const [papel, motivo] of [['publicador', 'IDENTIDADE_NAO_INDEPENDENTE'], ['restauracao', 'IDENTIDADE_NAO_INDEPENDENTE']]) {
      const antes = a.s3.chamadas.length;
      const r = await a.verificador({ cliente: quem(papel) }).verificar(c.consolidado);
      assert.deepEqual([r.conforme, r.motivo, r.itens.length], [false, motivo, 0], papel);
      assert.deepEqual(a.s3.chamadas.slice(antes).map((x) => x.operacao), ['identidade'], 'nada é lido do bucket com a credencial errada');
    }
    const outraConta = { ...a.s3.clientes.verificador, identidade: async () => ({ contaId: '999999999999', arn: 'arn:aws:iam::999999999999:user/qualquer' }) };
    assert.equal((await a.verificador({ cliente: outraConta }).verificar(c.consolidado)).motivo, 'IDENTIDADE_DIVERGENTE');
    const quebrada = { ...a.s3.clientes.verificador, identidade: async () => { throw new Error('detalhe-interno-secreto'); } };
    const r = await a.verificador({ cliente: quebrada }).verificar(c.consolidado);
    assert.equal(r.motivo, 'FALHA_AO_CONSULTAR');
    assert.equal(JSON.stringify(r).includes('secreto'), false);
  });

  test('VER-06 — consolidado de outro destino ou ambiente, ou inválido, é recusado sem consultar o bucket', async () => {
    const hml = await preparar();
    const prod = await preparar({ ambiente: 'PRODUCAO' });
    const antes = hml.a.s3.chamadas.length;
    assert.equal((await hml.a.verificador().verificar(prod.c.consolidado)).motivo, 'DESTINO_DIVERGENTE');
    assert.equal((await hml.a.verificador().verificar({ ...hml.c.consolidado, recibos: [] })).motivo, 'CONSOLIDADO_INVALIDO');
    assert.equal((await hml.a.verificador().verificar(null)).motivo, 'CONSOLIDADO_INVALIDO');
    assert.equal(hml.a.s3.chamadas.length, antes);
  });

  test('VER-07 — listagem ou metadados com falha, fora do contrato ou lentos não viram conformidade e não ecoam o erro', async () => {
    const { a, c } = await preparar();
    const base = a.s3.clientes.verificador;
    const defeitos = [
      { ...base, listarVersoes: async () => { throw new Error('detalhe-interno-secreto'); } },
      { ...base, listarVersoes: async () => 'nao-e-lista' },
      { ...base, listarVersoes: async () => [{ chave: 'x' }] },
      { ...base, listarVersoes: async () => new Promise(() => {}) },
    ];
    for (const cliente of defeitos) {
      const r = await a.verificador({ cliente, prazoMs: 40 }).verificar(c.consolidado);
      assert.deepEqual([r.conforme, r.motivo], [false, 'FALHA_AO_CONSULTAR']);
      assert.equal(JSON.stringify(r).includes('secreto'), false);
    }
    for (const lerMetadadosDaVersao of [async () => { throw new Error('x'); }, async () => ({ bytes: 1 }), async () => null]) {
      const r = await a.verificador({ cliente: { ...base, lerMetadadosDaVersao } }).verificar(c.consolidado);
      assert.equal(r.conforme, false);
      assert.ok(r.itens.every((i) => i.estado === 'DIVERGENTE' && i.codigos.includes('FALHA_AO_CONSULTAR')));
    }
  });

  test('VER-08 — destino só pela ficha e opções estritas; o módulo é somente leitura e não usa ambiente, SDK, rede, escrita nem remoção', () => {
    const a = ambienteS3();
    const V = require('../../src/services/backup-verificador-duravel.service');
    const base = { destinoId: a.ficha.id, ambiente: 'HOMOLOGACAO', cliente: a.s3.clientes.verificador };
    assert.throws(() => V.criarVerificadorIndependente(base), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    assert.throws(() => V.criarVerificadorIndependente({ ...base, ambiente: 'PRODUCAO', registro: a.reg }), (e) => e.motivo === 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE');
    for (const ruim of [null, {}, { ...base, extra: 1 }, { ...base, cliente: {}, registro: a.reg }, { ...base, prazoMs: 0, registro: a.reg }, { ...base, relogio: 1, registro: a.reg }]) assert.throws(() => V.criarVerificadorIndependente(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA' || e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-verificador-duravel.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.equal(/process\.env|@aws-sdk|require\(['"]node:(?:fs|net|http|https|child_process|dns|tls)|gravarObjeto|lerVersao|\.delete\(|DeleteObject/.test(fonte), false);
    assert.equal(/\b(?:createWriteStream|writeFile|writeFileSync|appendFile|copyFile|link|symlink|rename|mkdir|truncate|unlink|rm|rmdir)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/.test(fonte), false);
    assert.equal(/\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/.test(fonte), false);
  });
});
