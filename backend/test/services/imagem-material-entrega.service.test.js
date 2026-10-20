'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const imagemPadraoRepo = require('../../src/repositories/imagem-padrao.repository');
const { chaveDe } = require('../../src/storage/armazenamento-imagens');
const { criarArmazenamentoMemoriaFalso } = require('../storage/helpers/armazenamento-memoria-falso');
const { sha256Hex, webpFicticio, pngFicticio } = require('../helpers/imagens-ficticias');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — serviço de ENTREGA de arquivos (sem banco e sem disco: repositórios e armazenamento são
 * simulados; o armazenamento é o driver falso em memória da Unidade 1, que valida as chaves com o mesmo formato).
 *
 * Módulo previsto: src/services/imagem-material-entrega.service.js, com
 *   criarEntregaDeImagens({ armazenamento, registro, limiteBytes }) -> { obter(executor, { empresaId, origem, id, variante }) }
 *   - `armazenamento`: instância do armazenamento (Unidade 1) ou null/ausente = indisponível;
 *   - `registro(etiqueta, campos)`: registro técnico (padrão do projeto: console.error), SÓ com ids e motivo;
 *   - `limiteBytes`: teto de leitura de um arquivo (padrão do serviço; aqui reduzido para provar o teto).
 *   - `obter` devolve { corpo: Buffer, tipo: 'image/webp', etag: '"<sha256 da VARIANTE>"', versao } — o conteúdo JÁ verificado — ou lança
 *     HttpError 404 IMAGEM_NAO_ENCONTRADA (uniforme) / 503 IMAGENS_INDISPONIVEL / erro genérico de servidor. Chama os repositórios pelo
 *     NAMESPACE (imagemEmpresaRepo.buscarPorId(executor, empresaId, id), imagemPadraoRepo.buscarPorId(executor, id)).
 * Ordem: 503 (sem consultar nada) -> allowlist de origem/variante -> linha (empresa da sessão; padrão é global) -> estado -> hash da variante
 * registrado -> leitura com teto -> SHA-256 -> assinatura WebP. Nada vindo do cliente entra na chave: ela sai de `chaveDe` com valores do banco.
 */

const SERVICO = () => exigirModulo('src/services/imagem-material-entrega.service');
const EXECUTOR = Object.freeze({ marca: 'executor-de-teste' });
const EMPRESA = 3;
const OUTRA = 4;
const ENVIO = sha256Hex('envio-unitario');
const ENVIO_PADRAO = sha256Hex('envio-padrao-unitario');
const MIN = webpFicticio('u-min', 40);
const EXI = webpFicticio('u-exi', 80);
const MIN_PADRAO = webpFicticio('u-pmin', 36);
const EXI_PADRAO = webpFicticio('u-pexi', 70);

const linhaEmpresa = (extra = {}) => ({
  id: '7', empresaId: EMPRESA, nome: 'Luva', sha256: ENVIO, sha256Mestre: sha256Hex('mestre-unitario'), sha256Exibicao: sha256Hex(EXI), sha256Miniatura: sha256Hex(MIN),
  formato: 'PNG', largura: 1024, altura: 1024, bytesMestre: 900, bytesExibicao: EXI.length, bytesMiniatura: MIN.length, versao: 2, estado: 'ATIVA', criadoPor: 9, ...extra,
});
const linhaPadrao = (extra = {}) => ({
  id: '12', nome: 'Luva padrão', sha256: ENVIO_PADRAO, sha256Miniatura: sha256Hex(MIN_PADRAO), sha256Exibicao: null, formato: 'PNG', largura: 1024, altura: 1024,
  versao: 1, ativo: true, ilustrativa: true, sugerida: null, ...extra,
});
const chaveEmpresa = (variante, sha = ENVIO, empresaId = EMPRESA) => chaveDe({ escopo: 'EMPRESA', empresaId, sha256: sha, variante, formato: 'WEBP' });
const chavePadrao = (variante, sha = ENVIO_PADRAO) => chaveDe({ escopo: 'PADRAO', sha256: sha, variante, formato: 'WEBP' });

/** Armazenamento falso que registra toda chave pedida (abrir e existe). */
async function armazenamentoCom(arquivos) {
  const base = criarArmazenamentoMemoriaFalso();
  for (const [chave, bytes] of Object.entries(arquivos)) await base.gravar(chave, bytes, { maxBytes: 8 * 1024 * 1024 });
  const chamadas = [];
  return {
    chamadas,
    abrir: async (chave) => { chamadas.push(chave); return base.abrir(chave); },
    existe: async (chave) => { chamadas.push(chave); return base.existe(chave); },
    gravar: base.gravar,
    remover: base.remover,
    listar: base.listar,
  };
}

/** Simula os dois repositórios e monta o serviço. `empresa`/`padrao` null = não existe. */
async function cenario(t, {
  empresa = linhaEmpresa(), padrao = linhaPadrao(), arquivos = {}, armazenamento, limiteBytes, comRegistro = true,
} = {}) {
  const buscaEmpresa = t.mock.method(imagemEmpresaRepo, 'buscarPorId', async (_executor, empresaId, id) => (empresa !== null && empresa.empresaId === empresaId && empresa.id === String(id) ? empresa : null));
  const buscaPadrao = t.mock.method(imagemPadraoRepo, 'buscarPorId', async (_executor, id) => (padrao !== null && padrao.id === String(id) ? padrao : null));
  const armaz = armazenamento === undefined ? await armazenamentoCom(arquivos) : armazenamento;
  const registros = [];
  const { criarEntregaDeImagens } = SERVICO();
  assert.equal(typeof criarEntregaDeImagens, 'function', 'criarEntregaDeImagens ainda não existe (não implementado)');
  const entrega = criarEntregaDeImagens({
    armazenamento: armaz, ...(comRegistro ? { registro: (etiqueta, campos) => registros.push({ etiqueta, campos }) } : {}), ...(limiteBytes === undefined ? {} : { limiteBytes }),
  });
  return { entrega, buscaEmpresa, buscaPadrao, armaz, registros };
}

const naoEncontrada = (e) => e instanceof HttpError && e.status === 404 && e.codigo === 'IMAGEM_NAO_ENCONTRADA';
const indisponivel = (e) => e instanceof HttpError && e.status === 503 && e.codigo === 'IMAGENS_INDISPONIVEL';
const pedido = (extra = {}) => ({ empresaId: EMPRESA, origem: 'empresa', id: '7', variante: 'miniatura', ...extra });
const CAMPOS_PERMITIDOS_NO_REGISTRO = ['empresaId', 'imagemId', 'motivo', 'origem', 'variante'];

describe('[SRV-ENT] serviço de entrega — sucesso e chave', () => {
  test('SRV-ENT-01 — a fábrica existe e devolve o serviço com `obter`', async (t) => {
    const { entrega } = await cenario(t);
    assert.equal(typeof entrega.obter, 'function');
  });

  test('SRV-ENT-02 — empresa, miniatura: devolve o conteúdo verificado; a chave sai do banco (`<empresa>/<sha256>/miniatura.webp`, sempre .webp) e o repositório recebe a empresa e o id', async (t) => {
    const { entrega, buscaEmpresa, buscaPadrao, armaz } = await cenario(t, { arquivos: { [chaveEmpresa('miniatura')]: MIN } });
    const r = await entrega.obter(EXECUTOR, pedido());
    assert.deepEqual(r.corpo, MIN);
    assert.equal(r.tipo, 'image/webp');
    assert.equal(r.etag, `"${sha256Hex(MIN)}"`, 'ETag forte (sem W/) com o SHA-256 da VARIANTE, não o do envio nem o do mestre');
    assert.equal(r.versao, 2);
    assert.equal(Object.keys(r).some((k) => /chave|caminho|diretorio|sha256/i.test(k)), false, 'nada interno no resultado');
    assert.deepEqual(buscaEmpresa.mock.calls.map((c) => c.arguments), [[EXECUTOR, EMPRESA, '7']]);
    assert.equal(buscaPadrao.mock.callCount(), 0);
    assert.deepEqual(armaz.chamadas, [chaveEmpresa('miniatura')], 'exatamente UMA chave, a derivada do banco');
  });

  test('SRV-ENT-03 — empresa, exibição: o ETag e a chave são os da exibição; o `formato` PNG do mestre NÃO vira extensão da derivada', async (t) => {
    const { entrega, armaz } = await cenario(t, { empresa: linhaEmpresa({ formato: 'JPEG' }), arquivos: { [chaveEmpresa('exibicao')]: EXI } });
    const r = await entrega.obter(EXECUTOR, pedido({ variante: 'exibicao' }));
    assert.deepEqual(r.corpo, EXI);
    assert.equal(r.etag, `"${sha256Hex(EXI)}"`);
    assert.deepEqual(armaz.chamadas, [chaveEmpresa('exibicao')]);
  });

  test('SRV-ENT-04 — padrão, miniatura: consulta só a biblioteca padrão (global), nunca a da empresa; chave `padrao/<sha256>/miniatura.webp`', async (t) => {
    const { entrega, buscaEmpresa, buscaPadrao, armaz } = await cenario(t, { arquivos: { [chavePadrao('miniatura')]: MIN_PADRAO } });
    const r = await entrega.obter(EXECUTOR, pedido({ origem: 'padrao', id: '12' }));
    assert.deepEqual(r.corpo, MIN_PADRAO);
    assert.equal(r.etag, `"${sha256Hex(MIN_PADRAO)}"`);
    assert.equal(r.versao, 1);
    assert.deepEqual(buscaPadrao.mock.calls.map((c) => c.arguments), [[EXECUTOR, '12']]);
    assert.equal(buscaEmpresa.mock.callCount(), 0);
    assert.deepEqual(armaz.chamadas, [chavePadrao('miniatura')]);
  });

  test('SRV-ENT-05 — padrão, exibição: sem hash de exibição registrado (ainda não existe no pacote) é 404 e o disco nem é consultado; com hash e arquivo, é entregue', async (t) => {
    const sem = await cenario(t, { arquivos: { [chavePadrao('miniatura')]: MIN_PADRAO } });
    await assert.rejects(sem.entrega.obter(EXECUTOR, pedido({ origem: 'padrao', id: '12', variante: 'exibicao' })), naoEncontrada);
    assert.deepEqual(sem.armaz.chamadas, []);
    const com = await cenario(t, {
      padrao: linhaPadrao({ sha256Exibicao: sha256Hex(EXI_PADRAO) }),
      arquivos: { [chavePadrao('miniatura')]: MIN_PADRAO, [chavePadrao('exibicao')]: EXI_PADRAO },
    });
    const r = await com.entrega.obter(EXECUTOR, pedido({ origem: 'padrao', id: '12', variante: 'exibicao' }));
    assert.deepEqual(r.corpo, EXI_PADRAO);
    assert.equal(r.etag, `"${sha256Hex(EXI_PADRAO)}"`);
  });

  test('SRV-ENT-06 — o teto padrão de leitura comporta uma variante de 100 KiB e recusa um arquivo do tamanho máximo de envio (2 MiB + 1): o número exato não é fixado', async (t) => {
    const grande = Buffer.concat([webpFicticio('u-100k', 100 * 1024 - 20)]);
    const enorme = webpFicticio('u-2m', 2 * 1024 * 1024 + 1);
    const ok = await cenario(t, { empresa: linhaEmpresa({ sha256Miniatura: sha256Hex(grande), bytesMiniatura: grande.length }), arquivos: { [chaveEmpresa('miniatura')]: grande } });
    assert.deepEqual((await ok.entrega.obter(EXECUTOR, pedido())).corpo, grande);
    const acima = await cenario(t, { empresa: linhaEmpresa({ sha256Miniatura: sha256Hex(enorme), bytesMiniatura: enorme.length }), arquivos: { [chaveEmpresa('miniatura')]: enorme } });
    await assert.rejects(acima.entrega.obter(EXECUTOR, pedido()), naoEncontrada);
  });
});

describe('[SRV-ENT] serviço de entrega — ordem, allowlist e isolamento', () => {
  test('SRV-ENT-07 — armazenamento indisponível (null ou ausente): 503 antes de TUDO, sem consultar repositório algum (nenhum oráculo de existência), inclusive para pedidos inválidos', async (t) => {
    for (const armazenamento of [null, undefined]) {
      const { criarEntregaDeImagens } = SERVICO();
      const buscaEmpresa = t.mock.method(imagemEmpresaRepo, 'buscarPorId', async () => linhaEmpresa());
      const buscaPadrao = t.mock.method(imagemPadraoRepo, 'buscarPorId', async () => linhaPadrao());
      const entrega = criarEntregaDeImagens(armazenamento === undefined ? {} : { armazenamento });
      for (const extra of [{}, { id: '999999' }, { empresaId: OUTRA }, { origem: 'x' }, { variante: 'mestre' }, { origem: 'padrao', id: '12' }]) {
        await assert.rejects(entrega.obter(EXECUTOR, pedido(extra)), indisponivel, JSON.stringify(extra));
      }
      assert.equal(buscaEmpresa.mock.callCount() + buscaPadrao.mock.callCount(), 0, 'nenhuma consulta ao banco');
      buscaEmpresa.mock.restore();
      buscaPadrao.mock.restore();
    }
  });

  test('SRV-ENT-08 — origem e variante fora da allowlist (maiúsculas, espaços, travessia, NUL, "mestre", extensão, tipos errados) são 404 uniforme e NADA é consultado nem aberto', async (t) => {
    const { entrega, buscaEmpresa, buscaPadrao, armaz } = await cenario(t, { arquivos: { [chaveEmpresa('miniatura')]: MIN } });
    const origens = ['EMPRESA', 'Empresa', 'PADRAO', 'Padrao', 'padrao ', ' empresa', 'empresa\n', 'x', '', '..', 'empresa/..', 'padrao\0', undefined, null, 5, {}];
    const variantes = ['mestre', 'original', 'MINIATURA', 'Miniatura', 'miniatura.webp', 'exibição', 'exibicao ', '../miniatura', 'miniatura\0', 'thumb', '', undefined, null, 5, {}];
    for (const origem of origens) await assert.rejects(entrega.obter(EXECUTOR, pedido({ origem })), naoEncontrada, `origem ${JSON.stringify(origem)}`);
    for (const variante of variantes) await assert.rejects(entrega.obter(EXECUTOR, pedido({ variante })), naoEncontrada, `variante ${JSON.stringify(variante)}`);
    assert.equal(buscaEmpresa.mock.callCount() + buscaPadrao.mock.callCount(), 0);
    assert.deepEqual(armaz.chamadas, []);
  });

  test('SRV-ENT-09 — imagem inexistente: 404 uniforme e o disco nem é consultado', async (t) => {
    const { entrega, armaz } = await cenario(t, { empresa: null, padrao: null });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    await assert.rejects(entrega.obter(EXECUTOR, pedido({ origem: 'padrao', id: '12' })), naoEncontrada);
    assert.deepEqual(armaz.chamadas, []);
  });

  test('SRV-ENT-10 — imagem inativa (empresa INATIVA, padrão ativo=false): 404 uniforme e o disco nem é consultado', async (t) => {
    const { entrega, armaz } = await cenario(t, { empresa: linhaEmpresa({ estado: 'INATIVA' }), padrao: linhaPadrao({ ativo: false }), arquivos: { [chaveEmpresa('miniatura')]: MIN, [chavePadrao('miniatura')]: MIN_PADRAO } });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    await assert.rejects(entrega.obter(EXECUTOR, pedido({ origem: 'padrao', id: '12' })), naoEncontrada);
    assert.deepEqual(armaz.chamadas, []);
  });

  test('SRV-ENT-11 — isolamento: o repositório é consultado com a empresa RECEBIDA (da sessão); imagem de outra empresa é 404 uniforme', async (t) => {
    const { entrega, buscaEmpresa, armaz } = await cenario(t, { arquivos: { [chaveEmpresa('miniatura')]: MIN } });
    await entrega.obter(EXECUTOR, pedido());
    await assert.rejects(entrega.obter(EXECUTOR, pedido({ empresaId: OUTRA })), naoEncontrada);
    assert.deepEqual(buscaEmpresa.mock.calls.map((c) => c.arguments[1]), [EMPRESA, OUTRA]);
    assert.deepEqual(armaz.chamadas, [chaveEmpresa('miniatura')], 'a segunda consulta nunca chegou ao disco');
  });

  test('SRV-ENT-12 — defesa em profundidade: mesmo que o repositório devolvesse a linha de OUTRA empresa, o serviço recusa (404) e não abre arquivo', async (t) => {
    const { entrega, armaz } = await cenario(t, { arquivos: { [chaveEmpresa('miniatura', ENVIO, OUTRA)]: MIN } });
    t.mock.method(imagemEmpresaRepo, 'buscarPorId', async () => linhaEmpresa({ empresaId: OUTRA }));
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.deepEqual(armaz.chamadas, []);
  });
});

describe('[SRV-ENT] serviço de entrega — integridade, tamanho e falhas (nada de bytes antes de verificar)', () => {
  test('SRV-ENT-13 — SHA-256 diferente do registrado (mesmo tamanho, um byte trocado): 404 uniforme, sem corpo, com registro técnico SHA256_DIVERGENTE', async (t) => {
    const adulterado = Buffer.from(MIN);
    adulterado[adulterado.length - 1] ^= 0xff;
    const { entrega, registros } = await cenario(t, { arquivos: { [chaveEmpresa('miniatura')]: adulterado } });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.deepEqual(registros.map((r) => r.campos.motivo), ['SHA256_DIVERGENTE']);
  });

  test('SRV-ENT-14 — arquivo ausente (ARQUIVO_AUSENTE): 404 uniforme, indistinguível da inexistente, com registro ARQUIVO_AUSENTE', async (t) => {
    const { entrega, registros } = await cenario(t, { arquivos: {} });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.deepEqual(registros.map((r) => r.campos.motivo), ['ARQUIVO_AUSENTE']);
  });

  test('SRV-ENT-15 — teto de tamanho: o fluxo é lido só até o teto, destruído, e nada é entregue (TAMANHO_EXCEDIDO)', async (t) => {
    let gerados = 0;
    let fluxo = null;
    const armazenamento = {
      // Fluxo sob demanda (highWaterMark de um bloco): só gera o próximo bloco quando alguém lê, para medir quanto foi lido.
      abrir: async () => {
        fluxo = new Readable({ highWaterMark: 64, read() { gerados += 1; this.push(gerados > 20 ? null : Buffer.alloc(64, 1)); } });
        return fluxo;
      },
      existe: async () => true,
    };
    const { entrega, registros } = await cenario(t, { armazenamento, limiteBytes: 100 });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.equal(gerados >= 1 && gerados <= 5, true, `leu ${gerados} blocos de 64 bytes com teto de 100 (de 20 possíveis)`);
    assert.equal(fluxo.destroyed, true, 'o fluxo foi destruído');
    assert.deepEqual(registros.map((r) => r.campos.motivo), ['TAMANHO_EXCEDIDO']);
  });

  test('SRV-ENT-16 — conteúdo que NÃO é WebP, ainda que o SHA-256 registrado coincida, não é entregue como image/webp (ASSINATURA_INVALIDA)', async (t) => {
    const naoWebp = pngFicticio('u-nao-webp', 60);
    const { entrega, registros } = await cenario(t, { empresa: linhaEmpresa({ sha256Miniatura: sha256Hex(naoWebp), bytesMiniatura: naoWebp.length }), arquivos: { [chaveEmpresa('miniatura')]: naoWebp } });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.deepEqual(registros.map((r) => r.campos.motivo), ['ASSINATURA_INVALIDA']);
  });

  test('SRV-ENT-17 — chave recusada pelo armazenamento (CHAVE_INVALIDA: link simbólico, tipo errado): 404 uniforme, registro CHAVE_RECUSADA', async (t) => {
    const armazenamento = { abrir: async () => { throw Object.assign(new Error('chave de armazenamento inválida'), { codigo: 'CHAVE_INVALIDA' }); }, existe: async () => false };
    const { entrega, registros } = await cenario(t, { armazenamento });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.deepEqual(registros.map((r) => r.campos.motivo), ['CHAVE_RECUSADA']);
  });

  test('SRV-ENT-18 — falha de E/S do armazenamento (ARMAZENAMENTO_FALHOU ou erro cru com caminho na mensagem): erro de servidor GENÉRICO, sem 404 e sem caminho', async (t) => {
    for (const falha of [
      Object.assign(new Error('falha no armazenamento de imagens'), { codigo: 'ARMAZENAMENTO_FALHOU' }),
      Object.assign(new Error("EACCES: permission denied, open '/var/segredo/imagens/3/abc/miniatura.webp'"), { code: 'EACCES' }),
    ]) {
      const armazenamento = { abrir: async () => { throw falha; }, existe: async () => false };
      const { entrega, registros } = await cenario(t, { armazenamento });
      await assert.rejects(entrega.obter(EXECUTOR, pedido()), (e) => e instanceof HttpError && e.status === 500 && !/segredo|\/var\/|miniatura\.webp/.test(`${e.message} ${e.codigo}`));
      assert.deepEqual(registros.map((r) => r.campos.motivo), ['FALHA_ARMAZENAMENTO']);
    }
  });
});

describe('[SRV-ENT] serviço de entrega — registro técnico sem vazamento', () => {
  test('SRV-ENT-19 — o registro leva SÓ ids e motivo: nenhuma chave, caminho, hash, bytes ou nome de arquivo', async (t) => {
    const adulterado = Buffer.from(MIN);
    adulterado[3] ^= 0xff;
    const casos = [
      { arquivos: {}, extra: {} },
      { arquivos: { [chaveEmpresa('miniatura')]: adulterado }, extra: {} },
      { arquivos: { [chavePadrao('miniatura')]: Buffer.from(MIN_PADRAO) }, extra: { origem: 'padrao', id: '12' }, padrao: linhaPadrao({ sha256Miniatura: sha256Hex('outro') }) },
    ];
    for (const caso of casos) {
      const { entrega, registros } = await cenario(t, { arquivos: caso.arquivos, ...(caso.padrao === undefined ? {} : { padrao: caso.padrao }) });
      await assert.rejects(entrega.obter(EXECUTOR, pedido(caso.extra)), naoEncontrada);
      assert.equal(registros.length >= 1, true, 'houve registro técnico');
      for (const { campos } of registros) {
        assert.deepEqual(Object.keys(campos).filter((k) => !CAMPOS_PERMITIDOS_NO_REGISTRO.includes(k)), [], 'só campos da lista permitida');
        const texto = JSON.stringify(campos);
        for (const proibido of [ENVIO, ENVIO_PADRAO, sha256Hex(MIN), '.webp', 'miniatura.webp', '/']) assert.equal(texto.includes(proibido), false, `o registro vazou ${proibido}`);
      }
    }
  });

  test('SRV-ENT-20 — sem `registro` injetado, o registro padrão do projeto é o console.error estruturado (etiqueta + campos)', async (t) => {
    const espiao = t.mock.method(console, 'error', () => {});
    const { entrega } = await cenario(t, { arquivos: {}, comRegistro: false });
    await assert.rejects(entrega.obter(EXECUTOR, pedido()), naoEncontrada);
    assert.equal(espiao.mock.callCount() >= 1, true);
    const [etiqueta, campos] = espiao.mock.calls[0].arguments;
    assert.equal(typeof etiqueta, 'string');
    assert.equal(campos.motivo, 'ARQUIVO_AUSENTE');
  });
});
