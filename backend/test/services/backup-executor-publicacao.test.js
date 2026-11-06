'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../src/services/backup-executor-publicacao.service');
const { prepararAmbiente } = require('../helpers/ambiente-executor');
const { limparRaizes, arvore, novaRaiz, sha } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, executor operacional [PUB]: ESTÁGIO DE PUBLICAÇÃO DURÁVEL — pacote L2 local verificado -> destino local autorizado -> cifra em envelope -> inventário -> pré-voo -> envio
 * (envelope por último) -> recibos consolidados -> confirmação -> verificação independente (opcional). Com os módulos REAIS (cifra, enviador S3, verificador) sobre S3 e chaves falsos,
 * dados sintéticos. Falha fechada em cada passo: nada é apagado, nada é repetido, o que é ambíguo vira INCERTO.
 */

after(limparRaizes);
const ETAPAS_OK = ['DESTINO_LOCAL', 'CIFRA', 'INVENTARIO', 'PRE_VOO', 'ENVIO', 'CONSOLIDACAO', 'CONFIRMACAO', 'VERIFICACAO'];
const chamadasS3 = (x, operacao) => x.a.s3.chamadas.filter((c) => c.operacao === operacao).length;
const montar = (x, extra = {}) => ({
  pacote: { dir: x.pacote.dir, lido: x.pacote.lido }, conjuntoId: x.conjuntoId, validadorDeDestinos: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz,
  nomeContainer: 'container-1', cifra: x.chaves.cifra, mac: x.chaves.mac, enviador: x.a.enviador(), verificador: x.a.verificador(), limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 }, prazoMs: 1000, ...extra,
});
const codigo = async (promessa) => { try { await promessa; } catch (e) { return e.code; } return null; };

describe('[PUB] caminho completo', () => {
  test('PUB-01 — ciclo completo: etapas na ordem, envelope enviado por ÚLTIMO, um recibo por arquivo, cada objeto no bucket com UMA versão, verificação independente conforme, origem do destino de teste', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub1' });
    const enviador = x.a.enviador();
    const marcas = [];
    const r = await P.publicarPacoteDuravel(montar(x, { enviador, marcar: (id, ok, cod) => marcas.push([id, ok, cod]) }));
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual(r.etapas.map((e) => e.id), ETAPAS_OK);
    assert.deepEqual(marcas, ETAPAS_OK.map((id) => [id, true, null]));
    const locais = arvore(path.join(x.dlContainers.raiz, 'container-1'));
    assert.equal(r.container.arquivos, locais.length);
    assert.equal(r.recibos, locais.length);
    assert.equal(r.confirmacoes, locais.length);
    assert.equal(r.verificacao, 'CONFORME');
    assert.equal(r.origemDoDestino, 'TESTE_CONTROLADO');
    assert.match(r.sha256Consolidado, /^[0-9a-f]{64}$/);
    assert.equal(r.consolidado.recibos.length, locais.length);
    const emitidos = enviador.recibos();
    assert.ok(emitidos.at(-1).chave.endsWith('/envelope.json'));
    assert.equal(emitidos.filter((rb) => rb.chave.endsWith('/envelope.json')).length, 1);
    for (const rel of locais) assert.equal(x.a.s3.versoes(`hml/conjunto-pub1/${rel}`).length, 1, rel);
    assert.deepEqual({ estado: r.estado, falha: r.falha }, { estado: 'CONCLUIDO', falha: null });
    assert.ok(Object.isFrozen(r));
  });

  test('PUB-02 — no host do backup NÃO há credencial do verificador: sem verificador a execução conclui com verificação PENDENTE e nenhuma chamada do papel verificador', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub2' });
    const r = await P.publicarPacoteDuravel(montar(x, { verificador: undefined, nomeContainer: 'container-2' }));
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.equal(r.verificacao, 'PENDENTE');
    assert.deepEqual(r.etapas.map((e) => e.id), ETAPAS_OK.slice(0, -1));
    assert.equal(x.a.s3.chamadas.some((c) => c.papel === 'verificador'), false);
  });
});

describe('[PUB] destino local e cifra', () => {
  test('PUB-03 — destino local fora do registro oficial (id desconhecido ou raiz diferente da autorizada): RECUSADO antes de criar qualquer coisa, sem chamar o S3', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub3' });
    for (const extra of [{ destinoLocalId: 'outro-destino' }, { raiz: path.join(x.dlContainers.raiz, '..') }, { raiz: `${x.dlContainers.raiz}/sub` }]) {
      const r = await P.publicarPacoteDuravel(montar(x, extra));
      assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { ok: false, estado: 'RECUSADO', etapa: 'DESTINO_LOCAL', codigo: 'DESTINO_LOCAL_NAO_AUTORIZADO' });
      assert.match(r.falha.detalhe, /^[A-Z_]{5,40}$/);
    }
    assert.deepEqual(fs.readdirSync(x.dlContainers.raiz), []);
    assert.equal(x.a.s3.chamadas.length, 0);
  });

  test('PUB-04 — nome do contêiner já em uso: RECUSADO, o existente não é tocado (nem lido), nada vai ao S3', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub4' });
    const existente = path.join(x.dlContainers.raiz, 'container-1');
    fs.mkdirSync(existente, { mode: 0o700 });
    fs.writeFileSync(path.join(existente, 'marca'), 'intacto', { mode: 0o600 });
    const r = await P.publicarPacoteDuravel(montar(x));
    assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { estado: 'RECUSADO', etapa: 'DESTINO_LOCAL', codigo: 'DESTINO_LOCAL_OCUPADO' });
    assert.equal(fs.readFileSync(path.join(existente, 'marca'), 'utf8'), 'intacto');
    assert.equal(x.a.s3.chamadas.length, 0);
  });

  test('PUB-05 — pacote adulterado: a cifra recusa (a verificação do pacote vem antes) e NADA vai ao S3; o diagnóstico traz só código fixo', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub5' });
    fs.appendFileSync(path.join(x.pacote.dir, 'dump', 'postgres.dump'), 'X');
    const r = await P.publicarPacoteDuravel(montar(x));
    assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { ok: false, estado: 'FALHOU', etapa: 'CIFRA', codigo: 'CIFRA_FALHOU' });
    assert.match(JSON.stringify(r.falha), /^[\x20-\x7E]+$/);
    assert.equal(x.a.s3.chamadas.length, 0);
    assert.deepEqual(r.etapas.map((e) => [e.id, e.ok]), [['DESTINO_LOCAL', true], ['CIFRA', false]]);
  });
});

describe('[PUB] inventário, pré-voo e envio', () => {
  test('PUB-06 — limites do contêiner (arquivos e bytes): RECUSADO antes do envio; o contêiner local é preservado', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub6' });
    const a = await P.publicarPacoteDuravel(montar(x, { limites: { arquivosMaximo: 1000, totalBytesMaximo: 10 } }));
    assert.deepEqual({ estado: a.estado, etapa: a.falha.etapa, codigo: a.falha.codigo }, { estado: 'RECUSADO', etapa: 'INVENTARIO', codigo: 'LIMITE_TOTAL_EXCEDIDO' });
    const y = await prepararAmbiente({ conjuntoId: 'conjunto-pub6b' });
    const b = await P.publicarPacoteDuravel(montar(y, { limites: { arquivosMaximo: 1, totalBytesMaximo: 2 ** 30 } }));
    assert.deepEqual({ estado: b.estado, codigo: b.falha.codigo }, { estado: 'RECUSADO', codigo: 'LIMITE_DE_ARQUIVOS_EXCEDIDO' });
    assert.ok(fs.existsSync(path.join(x.dlContainers.raiz, 'container-1', 'envelope.json')));
    assert.equal(chamadasS3(x, 'gravarObjeto') + chamadasS3(y, 'gravarObjeto'), 0);
  });

  test('PUB-07 — pré-voo reprovado (versionamento suspenso): RECUSADO com os itens reprovados (códigos fixos) e NENHUMA gravação', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub7', s3: { config: { versionamento: 'Suspended' } } });
    const r = await P.publicarPacoteDuravel(montar(x));
    assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { estado: 'RECUSADO', etapa: 'PRE_VOO', codigo: 'PRE_VOO_REPROVADO' });
    assert.deepEqual(r.falha.itensReprovados, ['VERSIONAMENTO']);
    assert.equal(chamadasS3(x, 'gravarObjeto'), 0);
  });

  test('PUB-08 — envio negado: FALHOU no primeiro arquivo, nenhum outro é tentado, sem recibo; o que já existir no bucket NÃO é apagado', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub8' });
    x.a.s3.programarGravacao('NEGAR');
    const r = await P.publicarPacoteDuravel(montar(x));
    assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo, detalhe: r.falha.detalhe, recibos: r.recibos }, { ok: false, estado: 'FALHOU', etapa: 'ENVIO', codigo: 'ENVIO_FALHOU', detalhe: 'NEGADO', recibos: 0 });
    assert.equal(chamadasS3(x, 'gravarObjeto'), 1);
  });

  test('PUB-09 — resposta perdida: INCERTO (o objeto pode existir no bucket), sem recibo e sem nova tentativa; falha no meio preserva os recibos anteriores', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub9' });
    x.a.s3.programarGravacao(null, 'PERDER_RESPOSTA');
    const r = await P.publicarPacoteDuravel(montar(x));
    assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo, recibos: r.recibos }, { estado: 'INCERTO', etapa: 'ENVIO', codigo: 'ENVIO_INCERTO', recibos: 1 });
    assert.equal(chamadasS3(x, 'gravarObjeto'), 2, 'o primeiro gravou; o segundo perdeu a resposta; nada mais foi tentado');
    assert.ok(r.falha.detalhe.length > 0 && /^[A-Z_]+$/.test(r.falha.detalhe));
  });

  test('PUB-10 — conjunto já publicado: nome repetido no bucket é RECUSADO (nunca sobrescreve); continua UMA versão por objeto', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub10' });
    const primeira = await P.publicarPacoteDuravel(montar(x));
    assert.equal(primeira.ok, true, JSON.stringify(primeira.falha));
    const segunda = await P.publicarPacoteDuravel(montar(x, { nomeContainer: 'container-2' }));
    assert.deepEqual({ estado: segunda.estado, etapa: segunda.falha.etapa, codigo: segunda.falha.codigo, detalhe: segunda.falha.detalhe }, { estado: 'RECUSADO', etapa: 'ENVIO', codigo: 'ENVIO_RECUSADO', detalhe: 'OBJETO_JA_EXISTE' });
    for (const rel of arvore(path.join(x.dlContainers.raiz, 'container-1'))) assert.equal(x.a.s3.versoes(`hml/conjunto-pub10/${rel}`).length, 1, rel);
  });
});

describe('[PUB] consolidação, confirmação e verificação', () => {
  test('PUB-11 — recibos que não cobrem o contêiner (sem envelope, ou faltando um arquivo): FALHOU na consolidação, com motivo fixo', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub11' });
    const real = x.a.enviador();
    const comRecibos = (filtro) => Object.freeze({ destino: real.destino, executarPreVoo: real.executarPreVoo, enviarArquivo: real.enviarArquivo, recibos: () => real.recibos().filter(filtro), adaptadorDeConfirmacao: real.adaptadorDeConfirmacao, criarDestino: real.criarDestino });
    const semEnvelope = await P.publicarPacoteDuravel(montar(x, { enviador: comRecibos((rb) => !rb.chave.endsWith('/envelope.json')) }));
    assert.deepEqual({ estado: semEnvelope.estado, etapa: semEnvelope.falha.etapa, codigo: semEnvelope.falha.codigo, detalhe: semEnvelope.falha.detalhe }, { estado: 'FALHOU', etapa: 'CONSOLIDACAO', codigo: 'CONSOLIDACAO_FALHOU', detalhe: 'ENVELOPE_AUSENTE' });
    const y = await prepararAmbiente({ conjuntoId: 'conjunto-pub11b' });
    const real2 = y.a.enviador();
    const incompleto = Object.freeze({ destino: real2.destino, executarPreVoo: real2.executarPreVoo, enviarArquivo: real2.enviarArquivo, recibos: () => real2.recibos().filter((rb, i) => i !== 0), adaptadorDeConfirmacao: real2.adaptadorDeConfirmacao, criarDestino: real2.criarDestino });
    const faltando = await P.publicarPacoteDuravel(montar(y, { enviador: incompleto }));
    assert.deepEqual({ estado: faltando.estado, codigo: faltando.falha.codigo, detalhe: faltando.falha.detalhe }, { estado: 'FALHOU', codigo: 'CONSOLIDACAO_FALHOU', detalhe: 'RECIBOS_INCOMPLETOS' });
  });

  test('PUB-12 — verificação independente que acusa versão extra: FALHOU com VERIFICACAO_DIVERGENTE e a verificação registrada como DIVERGENTE (os recibos continuam no resultado)', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub12' });
    const real = x.a.verificador();
    const adulterado = { verificar: async (consolidado) => { x.a.s3.injetarVersaoExtra(consolidado.recibos[0].chave, 'forjado'); return real.verificar(consolidado); } };
    const r = await P.publicarPacoteDuravel(montar(x, { verificador: adulterado }));
    assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo, verificacao: r.verificacao }, { ok: false, estado: 'FALHOU', etapa: 'VERIFICACAO', codigo: 'VERIFICACAO_DIVERGENTE', verificacao: 'DIVERGENTE' });
    assert.ok(r.recibos > 0 && r.consolidado !== null && r.sha256Consolidado !== null);
  });

  test('PUB-13 — exceção inesperada em qualquer porta: FALHOU com ERRO_INESPERADO na etapa certa, sem eco da mensagem do erro', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub13' });
    const real = x.a.enviador();
    const quebrado = Object.freeze({ ...real, executarPreVoo: async () => { throw new Error('SEGREDO-NA-MENSAGEM'); } });
    const r = await P.publicarPacoteDuravel(montar(x, { enviador: quebrado }));
    assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { estado: 'FALHOU', etapa: 'PRE_VOO', codigo: 'ERRO_INESPERADO' });
    assert.doesNotMatch(JSON.stringify(r), /SEGREDO/);
  });
});

describe('[PUB] entrada e inventário', () => {
  test('PUB-14 — entrada fora do contrato é erro de programação (ENTRADA_INVALIDA) e não toca o disco nem o S3', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-pub14' });
    const base = montar(x);
    const ruins = [undefined, null, { ...base, extra: 1 }, { ...base, enviador: {} }, { ...base, verificador: {} }, { ...base, marcar: 'x' }, { ...base, prazoMs: 0 }, { ...base, prazoMs: 700000 }, { ...base, nomeContainer: '../x' },
      { ...base, nomeContainer: 'a/b' }, { ...base, conjuntoId: 'a b' }, { ...base, limites: {} }, { ...base, limites: { totalBytesMaximo: 0, arquivosMaximo: 1 } }, { ...base, limites: { totalBytesMaximo: 10, arquivosMaximo: 400001 } },
      { ...base, pacote: { dir: 'relativo', lido: x.pacote.lido } }, { ...base, pacote: { dir: x.pacote.dir } }, { ...base, validadorDeDestinos: {} }, { ...base, cifra: null }];
    for (const ruim of ruins) assert.equal(await codigo(P.publicarPacoteDuravel(ruim)), 'ENTRADA_INVALIDA', JSON.stringify(ruim)?.slice(0, 60));
    assert.equal(x.a.s3.chamadas.length, 0);
    assert.deepEqual(fs.readdirSync(x.dlContainers.raiz), []);
    const { verificador: _omitido, ...semVerificador } = base;
    assert.equal(await codigo(P.publicarPacoteDuravel(semVerificador)), null, 'o verificador é opcional');
  });

  test('PUB-15 — inventário do contêiner: só arquivos regulares; link simbólico, envelope ausente, excesso de arquivos ou de bytes e diretório inexistente são recusados; ordem estável com o envelope por último', async () => {
    const dir = path.join(novaRaiz(), 'cont');
    fs.mkdirSync(path.join(dir, 'dados', 'a'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'envelope.json'), '{"e":1}', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'dados', 'z.enc'), 'zzz', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'dados', 'a', 'b.enc'), 'bbbb', { mode: 0o600 });
    const ok = await P.inventariarContainer(dir, { arquivosMaximo: 10, totalBytesMaximo: 1000 });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.arquivos.map((a) => a.rel), ['dados/a/b.enc', 'dados/z.enc', 'envelope.json']);
    assert.deepEqual(ok.arquivos.map((a) => a.bytes), [4, 3, 7]);
    assert.equal(ok.arquivos[1].sha256, sha(Buffer.from('zzz')));
    assert.equal(ok.totalBytes, 14);
    assert.equal((await P.inventariarContainer(dir, { arquivosMaximo: 2, totalBytesMaximo: 1000 })).codigo, 'LIMITE_DE_ARQUIVOS_EXCEDIDO');
    assert.equal((await P.inventariarContainer(dir, { arquivosMaximo: 10, totalBytesMaximo: 13 })).codigo, 'LIMITE_TOTAL_EXCEDIDO');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'dados', 'ln.enc'));
    assert.equal((await P.inventariarContainer(dir, { arquivosMaximo: 10, totalBytesMaximo: 1000 })).codigo, 'CONTAINER_INVALIDO');
    fs.unlinkSync(path.join(dir, 'dados', 'ln.enc'));
    fs.unlinkSync(path.join(dir, 'envelope.json'));
    assert.equal((await P.inventariarContainer(dir, { arquivosMaximo: 10, totalBytesMaximo: 1000 })).codigo, 'ENVELOPE_AUSENTE');
    assert.equal((await P.inventariarContainer(path.join(dir, 'inexistente'), { arquivosMaximo: 10, totalBytesMaximo: 1000 })).codigo, 'CONTAINER_INVALIDO');
  });
});
