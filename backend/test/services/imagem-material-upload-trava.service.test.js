'use strict';

const { createHash } = require('node:crypto');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { criarUploadDeImagens } = require('../../src/services/imagem-material-upload.service');
const { criarArmazenamentoMemoriaFalso } = require('../storage/helpers/armazenamento-memoria-falso');
const { criarProcessadorFalso } = require('../helpers/processador-imagem-falso');
const { png } = require('../helpers/imagens-validas');

/**
 * Biblioteca de Imagens, Unidade 5C-2 — a decisão D-C2 APLICADA, fixada em teste: a decodificação roda fora de qualquer transação e trava, e a gravação
 * dos três arquivos acontece DENTRO da seção crítica da empresa (a trava que `registrarEmpresa` já toma, uma só vez), depois da deduplicação e da cota e
 * antes do INSERT. Consequências verificadas na linha do tempo de eventos: conteúdo já existente e cota esgotada não gravam arquivo nenhum (nada de órfão
 * por recusa), e uma falha na gravação desfaz a transação. Sem PostgreSQL (conexão e repositórios simulados) e sem disco (armazenamento em memória).
 * Os testes da 5C-1 (imagem-material-upload.service.test.js) deliberadamente NÃO fixavam essa ordem; estes a fixam.
 */

const CONTEXTO = Object.freeze({ empresaId: 3, atorId: 9, nome: 'Luva enviada', ip: '203.0.113.10', dispositivo: 'Navegador de teste' });

function montar(t, { consumo = { imagens: 0, bytes: 0, bytesArmazenados: 0 }, falharEm = null, processadorProprio = null } = {}) {
  const eventos = [];
  const linhas = [];
  const opcoesDeGravacao = [];
  const cliente = {
    query: async (sql) => { eventos.push(`sql:${String(sql).trim().split(/\s+/)[0].toUpperCase()}`); return { rows: [] }; },
    release: () => { eventos.push('release'); },
  };
  const pool = { connect: async () => { eventos.push('connect'); return cliente; } };
  t.mock.method(imagemEmpresaRepo, 'travarBiblioteca', async (_executor, empresaId) => { eventos.push(`travar:${empresaId}`); });
  t.mock.method(imagemEmpresaRepo, 'buscarPorSha256', async (_executor, empresaId, sha) => {
    eventos.push('buscar');
    return linhas.find((l) => l.empresaId === empresaId && l.sha256 === sha) ?? null;
  });
  t.mock.method(imagemEmpresaRepo, 'somarConsumo', async () => { eventos.push('somar'); return consumo; });
  t.mock.method(imagemEmpresaRepo, 'inserir', async (_executor, dados) => {
    eventos.push('inserir');
    const linha = { id: String(7000 + linhas.length + 1), versao: 1, estado: 'ATIVA', ...dados };
    linhas.push(linha);
    return linha;
  });
  t.mock.method(auditoriaRepo, 'registrar', async () => { eventos.push('auditar'); });

  const memoria = criarArmazenamentoMemoriaFalso();
  const armazenamento = {
    async gravar(chave, fonte, opcoes) {
      const variante = chave.split('/').pop().split('.')[0];
      eventos.push(`gravar:${variante}`);
      opcoesDeGravacao.push({ variante, conteudo: fonte, ...opcoes });
      if (falharEm === variante) throw Object.assign(new Error('falha no armazenamento de imagens'), { codigo: 'ARMAZENAMENTO_FALHOU' });
      return memoria.gravar(chave, fonte, opcoes);
    },
  };
  const processador = processadorProprio ?? criarProcessadorFalso({ eventos });
  const envio = criarUploadDeImagens({ armazenamento, processador });
  return {
    eventos, linhas, pool, memoria, envio, processador, opcoesDeGravacao,
  };
}

const gravacoes = (eventos) => eventos.filter((e) => e.startsWith('gravar:'));

describe('envio de imagem — D-C2: arquivos sob a trava da empresa, depois da deduplicação e da cota e antes do INSERT', () => {
  test('TRV-01 — a linha do tempo de um envio novo: decodifica FORA de conexão e de trava, depois uma única trava da empresa, deduplicação, cota, os três arquivos, INSERT, auditoria e COMMIT', async (t) => {
    const { eventos, pool, envio } = montar(t);
    const r = await envio.enviar(pool, { ...CONTEXTO, bytes: png(320, 320) });
    assert.equal(r.reaproveitada, false);
    assert.deepEqual(eventos, [
      'processar:inicio', 'processar:fim',
      'connect', 'sql:BEGIN', 'travar:3', 'buscar', 'somar',
      'gravar:mestre', 'gravar:exibicao', 'gravar:miniatura',
      'inserir', 'auditar', 'sql:COMMIT', 'release',
    ]);
  });

  test('TRV-02 — cota esgotada: nenhum arquivo é gravado (a recusa vem antes da gravação), 409, transação desfeita', async (t) => {
    const { eventos, pool, envio, memoria } = montar(t, { consumo: { imagens: 300, bytes: 0, bytesArmazenados: 0 } });
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: png(320, 320) }), (falha) => falha.status === 409 && falha.codigo === 'IMAGEM_COTA_EXCEDIDA');
    assert.deepEqual(gravacoes(eventos), []);
    assert.deepEqual(await memoria.listar('3'), []);
    assert.deepEqual(eventos.slice(-2), ['sql:ROLLBACK', 'release']);
  });

  test('TRV-03 — o mesmo conteúdo de novo na empresa: o segundo envio não grava arquivo nenhum e devolve a existente', async (t) => {
    const { eventos, pool, envio, memoria } = montar(t);
    const bytes = png(321, 320);
    const primeiro = await envio.enviar(pool, { ...CONTEXTO, bytes });
    const antes = eventos.length;
    const segundo = await envio.enviar(pool, { ...CONTEXTO, bytes: Buffer.from(bytes) });
    assert.deepEqual([segundo.reaproveitada, segundo.imagem.id], [true, primeiro.imagem.id]);
    assert.deepEqual(gravacoes(eventos.slice(antes)), []);
    assert.equal((await memoria.listar('3')).length, 3);
  });

  test('TRV-04 — falha ao gravar a segunda variante: a transação é desfeita (sem INSERT nem auditoria), a conexão é devolvida e o erro não leva chave nem hash', async (t) => {
    const { eventos, pool, envio } = montar(t, { falharEm: 'exibicao' });
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: png(322, 320) }), (falha) => falha.status === undefined && !/[0-9a-f]{64}/.test(String(falha.message)));
    assert.deepEqual(gravacoes(eventos), ['gravar:mestre', 'gravar:exibicao']);
    assert.equal(eventos.includes('inserir'), false);
    assert.equal(eventos.includes('auditar'), false);
    assert.deepEqual(eventos.slice(-2), ['sql:ROLLBACK', 'release']);
  });

  test('TRV-05 — o envio nunca remove arquivo: depois de uma falha o que foi gravado antes dela continua no armazenamento (sem limpeza dentro da requisição)', async (t) => {
    const { pool, envio, memoria } = montar(t, { falharEm: 'miniatura' });
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: png(323, 320) }));
    assert.equal((await memoria.listar('3')).length, 2, 'mestre e exibição gravados antes da falha seguem lá; nada foi apagado');
  });

  test('TRV-06 — empresas diferentes travam cada uma a sua biblioteca; a decodificação de ambas fica fora de qualquer trava', async (t) => {
    const { eventos, pool, envio } = montar(t);
    await envio.enviar(pool, { ...CONTEXTO, empresaId: 3, bytes: png(324, 320) });
    await envio.enviar(pool, { ...CONTEXTO, empresaId: 4, atorId: 19, bytes: png(325, 320) });
    assert.deepEqual(eventos.filter((e) => e.startsWith('travar:')), ['travar:3', 'travar:4']);
    const primeiraDecodificacaoAcabou = eventos.indexOf('processar:fim');
    assert.ok(primeiraDecodificacaoAcabou < eventos.indexOf('travar:3'), 'a decodificação termina antes de qualquer trava');
  });
});

describe('envio de imagem — o que o serviço confere antes de tocar o banco ou o armazenamento', () => {
  const saida = (extra = {}) => ({
    formato: 'PNG', largura: 320, altura: 320, mestre: Buffer.alloc(100, 1), exibicao: Buffer.alloc(50, 2), miniatura: Buffer.alloc(20, 3), ...extra,
  });
  const DEFEITOS = [
    ['formato fora do catálogo', saida({ formato: 'GIF' })],
    ['largura abaixo do mínimo', saida({ largura: 100 })],
    ['altura acima do máximo', saida({ altura: 5000 })],
    ['mais de 8 megapixels', saida({ largura: 4096, altura: 3000 })],
    ['mestre vazio', saida({ mestre: Buffer.alloc(0) })],
    ['mestre que não é Buffer', saida({ mestre: 'texto' })],
    ['mestre acima do teto', saida({ mestre: Buffer.alloc(4 * 1024 * 1024 + 1, 1) })],
    ['exibição acima de 1 MiB', saida({ exibicao: Buffer.alloc(1024 * 1024 + 1, 1) })],
    ['miniatura acima do teto da configuração', saida({ miniatura: Buffer.alloc(65536 + 1, 1) })],
    ['saída nula', null],
  ];

  for (const [rotulo, devolvida] of DEFEITOS) {
    test(`TRV-07 (${rotulo}) — saída defeituosa do processador é erro interno 500: nada é gravado, o banco nem é aberto, e o erro não leva chave nem hash`, async (t) => {
      const { eventos, pool, envio } = montar(t, { processadorProprio: { processar: async () => devolvida } });
      await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: png(320, 320) }), (falha) => {
        assert.equal(falha.status, 500);
        assert.equal(falha.codigo, 'ERRO_INTERNO');
        assert.equal(/[0-9a-f]{64}/.test(String(falha.message)), false);
        return true;
      });
      assert.deepEqual(eventos, []);
    });
  }

  test('TRV-07b — bytes ausentes, vazios ou que não são Buffer são 415 IMAGEM_FORMATO_NAO_SUPORTADO ANTES do processador (mesmo que o processador aceitasse), sem tocar o banco nem gravar', async (t) => {
    const aceitaTudo = { chamadas: 0, processar: async () => { aceitaTudo.chamadas += 1; return saida(); } };
    const { eventos, pool, envio } = montar(t, { processadorProprio: aceitaTudo });
    for (const bytes of [Buffer.alloc(0), undefined, null, 'texto', new Uint8Array([1, 2, 3]), {}]) {
      await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes }), (falha) => falha.status === 415 && falha.codigo === 'IMAGEM_FORMATO_NAO_SUPORTADO', String(typeof bytes));
    }
    assert.equal(aceitaTudo.chamadas, 0);
    assert.deepEqual(eventos, []);
  });

  test('TRV-08 — corpo acima de 2 MiB que chegue ao serviço é 413 PAYLOAD_MUITO_GRANDE, sem decodificar (defesa em profundidade; o parser da rota já barra antes)', async (t) => {
    const { eventos, pool, envio, processador } = montar(t);
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: Buffer.alloc(2 * 1024 * 1024 + 1, 7) }), (falha) => falha.status === 413 && falha.codigo === 'PAYLOAD_MUITO_GRANDE');
    assert.equal(processador.chamadas.length, 0);
    assert.deepEqual(eventos, []);
  });

  test('TRV-09 — cada gravação leva as garantias do armazenamento: limite de bytes, SHA-256 esperado do conteúdo e um sinal de tempo máximo ainda não abortado', async (t) => {
    const { pool, envio, processador, opcoesDeGravacao } = montar(t);
    const bytes = png(326, 320);
    await envio.enviar(pool, { ...CONTEXTO, bytes });
    const esperado = processador.resultadoEsperado(bytes);
    assert.deepEqual(opcoesDeGravacao.map((o) => o.variante), ['mestre', 'exibicao', 'miniatura']);
    for (const o of opcoesDeGravacao) {
      assert.equal(Number.isSafeInteger(o.maxBytes) && o.maxBytes >= esperado[o.variante].length, true, `${o.variante}: limite de bytes`);
      assert.equal(o.sha256Esperado, createHash('sha256').update(esperado[o.variante]).digest('hex'), `${o.variante}: SHA-256 esperado`);
      assert.equal(o.signal instanceof AbortSignal && o.signal.aborted === false, true, `${o.variante}: sinal de tempo máximo`);
      assert.equal(Buffer.compare(o.conteudo, esperado[o.variante]), 0, `${o.variante}: conteúdo gravado = saída do processador`);
    }
  });
});
