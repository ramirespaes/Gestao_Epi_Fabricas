'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { criarEntregaDeImagens } = require('../../src/services/imagem-material-entrega.service');
const { chaveDe } = require('../../src/storage/armazenamento-imagens');
const { criarArmazenamentoMemoriaFalso } = require('../storage/helpers/armazenamento-memoria-falso');
const { criarProcessadorFalso } = require('../helpers/processador-imagem-falso');
const { png, pngMinimo, jpegMinimo } = require('../helpers/imagens-validas');
const { sha256Hex } = require('../helpers/imagens-ficticias');

/**
 * Biblioteca de Imagens, Unidade 5C-1 (RED) — a ORQUESTRAÇÃO do envio de imagem da empresa, sem PostgreSQL, sem biblioteca de imagem e sem disco:
 *
 *   enviar(pool, { empresaId, atorId, nome, bytes: Buffer, ip, dispositivo }) -> { imagem, reaproveitada }
 *
 * O serviço (src/services/imagem-material-upload.service.js, ainda inexistente) recebe a imagem enviada, pede ao PROCESSADOR (porta injetada; aqui o falso de
 * test/helpers) o mestre e as duas derivadas, grava as três variantes no ARMAZENAMENTO (aqui o falso em memória) e registra a linha pela persistência que já
 * existe (`registrarEmpresa`: trava da biblioteca, deduplicação por SHA-256, cota, INSERT e auditoria). Os repositórios são simulados com uma "tabela" em memória
 * que obedece às mesmas regras (um conteúdo por empresa); a decisão de COMO e QUANDO cada passo acontece NÃO é fixada além do que a segurança e a integridade
 * exigem. Em particular, estes testes NÃO exigem que os arquivos sejam gravados antes, durante ou depois da trava da biblioteca, e NÃO pressupõem limpeza
 * física na requisição; exigem o que importa em qualquer desenho:
 *
 *   - a decodificação (cara) nunca roda dentro de uma transação nem com trava tomada, e a trava, quando existe, é a DA EMPRESA, nunca global;
 *   - no máximo N decodificações simultâneas por processo (configuração), independentemente de empresa;
 *   - nunca existe registro sem os três arquivos (no instante do INSERT as variantes já estão no armazenamento);
 *   - falha em qualquer passo antes do INSERT = nenhuma linha, nenhuma auditoria; sobra no máximo arquivo órfão;
 *   - o que a entrega lê e verifica é exatamente o que o envio gravou (mesmo layout de chaves, mesmos SHA-256);
 *   - um reenvio depois da exclusão do registro funciona haja ou não arquivos antigos no disco (a limpeza futura é independente).
 *
 * Verde HOJE: nenhum teste deste arquivo (o módulo ainda não existe; cada um falha com "módulo ainda não implementado"). Os dois TODO no fim registram decisões abertas.
 */

const MIB = 1024 * 1024;
const CONTEXTO = Object.freeze({ empresaId: 3, atorId: 9, ip: '203.0.113.10', dispositivo: 'Navegador de teste' });
const envioDe = (extra = {}) => ({ ...CONTEXTO, nome: 'Luva enviada', ...extra });
const VARIANTES = ['mestre', 'exibicao', 'miniatura'];

const proximosTicks = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };
/** Espera (em ticks, sem relógio) até a condição valer; se nunca vale, o teste diz o que faltou em vez de pendurar. */
async function esperarAte(condicao, mensagem, maximo = 400) {
  for (let i = 0; i < maximo && !condicao(); i += 1) await proximosTicks(1);
  assert.equal(condicao(), true, mensagem);
}
async function lerTudo(fluxo) {
  const partes = [];
  for await (const parte of fluxo) partes.push(Buffer.from(parte));
  return Buffer.concat(partes);
}
async function comAmbiente(alteracoes, fn) {
  const anteriores = Object.fromEntries(Object.keys(alteracoes).map((nome) => [nome, process.env[nome]]));
  const aplicar = (valores) => { for (const [nome, valor] of Object.entries(valores)) { if (valor === undefined) delete process.env[nome]; else process.env[nome] = valor; } };
  try { aplicar(alteracoes); return await fn(); } finally { aplicar(anteriores); }
}

/** As chaves em que a ENTREGA procura as três variantes (o mestre leva a extensão do formato; as derivadas são sempre .webp). */
function chavesDe(empresaId, sha256, formato) {
  return {
    mestre: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'mestre', formato }),
    exibicao: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'exibicao', formato: 'WEBP' }),
    miniatura: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'miniatura', formato: 'WEBP' }),
  };
}

/**
 * A "persistência" simulada: a conexão e a transação gravam eventos numa linha do tempo comum (junto com o processador e o armazenamento observados); os
 * repositórios que `registrarEmpresa` usa são simulados por uma tabela em memória com a regra de um conteúdo por empresa. NADA aqui toca PostgreSQL.
 */
function montarMundo(t, { existentes = [], consumo = null, falharEmInserir = null, aoInserir = null } = {}) {
  const eventos = [];
  const auditorias = [];
  const linhas = existentes.map((l) => ({ ...l }));
  let proximoId = 7000;
  const cliente = {
    query: async (sql) => { eventos.push(`sql:${String(sql).trim().split(/\s+/)[0].toUpperCase()}`); return { rows: [] }; },
    release: () => { eventos.push('release'); },
  };
  const pool = {
    connect: async () => { eventos.push('connect'); return cliente; },
    query: async () => { eventos.push('pool.query'); return { rows: [] }; },
  };
  t.mock.method(imagemEmpresaRepo, 'travarBiblioteca', async (_executor, empresaId) => { eventos.push(`travar:${empresaId}`); });
  t.mock.method(imagemEmpresaRepo, 'buscarPorSha256', async (_executor, empresaId, sha) => {
    eventos.push('buscar');
    return linhas.find((l) => l.empresaId === empresaId && l.sha256 === sha) ?? null;
  });
  t.mock.method(imagemEmpresaRepo, 'buscarPorId', async (_executor, empresaId, id) => linhas.find((l) => l.empresaId === empresaId && l.id === String(id)) ?? null);
  t.mock.method(imagemEmpresaRepo, 'somarConsumo', async (_executor, empresaId) => {
    eventos.push('somar');
    if (consumo !== null) return consumo;
    const daEmpresa = linhas.filter((l) => l.empresaId === empresaId);
    return { imagens: daEmpresa.length, bytes: daEmpresa.reduce((soma, l) => soma + l.bytesMestre, 0), bytesArmazenados: 0 };
  });
  t.mock.method(imagemEmpresaRepo, 'inserir', async (_executor, dados) => {
    eventos.push('inserir');
    if (aoInserir !== null) await aoInserir(dados);
    if (falharEmInserir !== null) throw falharEmInserir;
    proximoId += 1;
    const linha = {
      id: String(proximoId), versao: 1, estado: 'ATIVA', criadoEm: new Date(), atualizadoEm: new Date(), inativadaEm: null, ...dados,
    };
    linhas.push(linha);
    return linha;
  });
  t.mock.method(auditoriaRepo, 'registrar', async (_executor, dados) => { eventos.push('auditar'); auditorias.push(dados); });
  return { eventos, auditorias, linhas, pool };
}

/** Armazenamento observado: cada gravação entra na linha do tempo; `falharEm` faz a gravação daquela variante falhar como falha o armazenamento real. */
function observar(base, eventos, { falharEm = null } = {}) {
  const variante = (chave) => chave.split('/').pop().split('.')[0];
  return {
    async gravar(chave, fonte, opcoes) {
      eventos.push(`gravar:${variante(chave)}`);
      if (falharEm !== null && variante(chave) === falharEm) throw Object.assign(new Error('falha no armazenamento de imagens'), { codigo: 'ARMAZENAMENTO_FALHOU' });
      const resultado = await base.gravar(chave, fonte, opcoes);
      eventos.push(`gravado:${variante(chave)}`);
      return resultado;
    },
    abrir: base.abrir, existe: base.existe, remover: base.remover, removerVariantes: base.removerVariantes, listar: base.listar,
  };
}

function preparar(t, { mundo = {}, armazenamento: opcoesDoArmazenamento = {}, processador: opcoesDoProcessador = {} } = {}) {
  const { criarUploadDeImagens } = exigirModulo('src/services/imagem-material-upload.service');
  const m = montarMundo(t, mundo);
  const memoria = criarArmazenamentoMemoriaFalso();
  const armazenamento = observar(memoria, m.eventos, opcoesDoArmazenamento);
  const processador = criarProcessadorFalso({ eventos: m.eventos, ...opcoesDoProcessador });
  const envio = criarUploadDeImagens({ armazenamento, processador });
  return {
    ...m, memoria, armazenamento, processador, envio,
  };
}

const semEscritaNemPersistencia = (eventos) => eventos.filter((e) => e.startsWith('gravar') || e === 'inserir' || e === 'auditar');

describe('envio de imagem — o que é produzido e gravado', () => {
  test('ORQ-01 — envio novo: a persistência recebe o descritor derivado dos bytes ENVIADOS e do que o processador devolveu (empresa e ator do contexto); resultado { imagem, reaproveitada:false }; uma auditoria só com id, formato e bytes', async (t) => {
    const a = preparar(t);
    const bytes = png(320, 320);
    const r = await a.envio.enviar(a.pool, envioDe({ bytes }));
    const esperado = a.processador.resultadoEsperado(bytes);
    assert.deepEqual(Object.keys(r).sort(), ['imagem', 'reaproveitada']);
    assert.equal(r.reaproveitada, false);
    assert.deepEqual({ ...r.imagem, id: typeof r.imagem.id }, {
      origem: 'EMPRESA', id: 'string', nome: 'Luva enviada', formato: 'PNG', largura: 320, altura: 320, versao: 1, estado: 'ATIVA',
    });
    assert.equal(a.linhas.length, 1);
    const l = a.linhas[0];
    assert.deepEqual({
      empresaId: l.empresaId, criadoPor: l.criadoPor, nome: l.nome, sha256: l.sha256, sha256Mestre: l.sha256Mestre, sha256Exibicao: l.sha256Exibicao, sha256Miniatura: l.sha256Miniatura,
      formato: l.formato, largura: l.largura, altura: l.altura, bytesMestre: l.bytesMestre, bytesExibicao: l.bytesExibicao, bytesMiniatura: l.bytesMiniatura,
    }, {
      empresaId: 3, criadoPor: 9, nome: 'Luva enviada', sha256: sha256Hex(bytes), sha256Mestre: sha256Hex(esperado.mestre), sha256Exibicao: sha256Hex(esperado.exibicao), sha256Miniatura: sha256Hex(esperado.miniatura),
      formato: 'PNG', largura: 320, altura: 320, bytesMestre: esperado.mestre.length, bytesExibicao: esperado.exibicao.length, bytesMiniatura: esperado.miniatura.length,
    });
    assert.equal(a.auditorias.length, 1);
    assert.equal(a.auditorias[0].acao, 'IMAGEM_MATERIAL_IMPORTADA');
    assert.equal(a.auditorias[0].empresaId, 3);
    assert.equal(a.auditorias[0].usuarioId, 9);
    assert.deepEqual(Object.keys(a.auditorias[0].contexto).sort(), ['bytes', 'formato', 'imagemId']);
    const textoDaAuditoria = JSON.stringify(a.auditorias[0]);
    for (const proibido of ['Luva enviada', sha256Hex(bytes), sha256Hex(esperado.mestre)]) assert.equal(textoDaAuditoria.includes(proibido), false, 'a auditoria não leva nome nem hash');
  });

  test('ORQ-02 — as três variantes são gravadas no layout que a entrega lê (<empresa>/<SHA-256 do envio>/mestre.<ext>, exibicao.webp, miniatura.webp), com exatamente os bytes do processador, e só elas; nada na biblioteca padrão', async (t) => {
    const a = preparar(t);
    const bytes = png(320, 321);
    await a.envio.enviar(a.pool, envioDe({ bytes }));
    const sha = sha256Hex(bytes);
    const esperado = a.processador.resultadoEsperado(bytes);
    const chaves = chavesDe(3, sha, 'PNG');
    assert.deepEqual(await a.memoria.listar('3'), Object.values(chaves).sort());
    for (const v of VARIANTES) assert.equal((await lerTudo(await a.memoria.abrir(chaves[v]))).equals(esperado[v]), true, `${v}: bytes gravados = bytes do processador`);
    assert.deepEqual(await a.memoria.listar('padrao'), []);
    const jpeg = jpegMinimo('jpeg-orq02');
    await a.envio.enviar(a.pool, envioDe({ bytes: jpeg, nome: 'Foto JPEG' }));
    assert.equal(await a.memoria.existe(chavesDe(3, sha256Hex(jpeg), 'JPEG').mestre), true, 'o mestre de um JPEG leva a extensão .jpg');
  });

  test('ORQ-03 — o que o envio grava é o que a ENTREGA lê e verifica: miniatura e exibição voltam byte a byte com o ETag do SHA-256 da variante, e o mestre nunca é entregue', async (t) => {
    const a = preparar(t);
    const bytes = png(322, 320);
    const { imagem } = await a.envio.enviar(a.pool, envioDe({ bytes }));
    const esperado = a.processador.resultadoEsperado(bytes);
    const entrega = criarEntregaDeImagens({ armazenamento: a.memoria, registro: () => {} });
    for (const variante of ['miniatura', 'exibicao']) {
      const entregue = await entrega.obter(a.pool, { empresaId: 3, origem: 'empresa', id: imagem.id, variante });
      assert.equal(entregue.corpo.equals(esperado[variante]), true, `${variante}: bytes entregues = bytes do processador`);
      assert.deepEqual([entregue.tipo, entregue.etag, entregue.versao], ['image/webp', `"${sha256Hex(esperado[variante])}"`, 1]);
    }
    await assert.rejects(entrega.obter(a.pool, { empresaId: 3, origem: 'empresa', id: imagem.id, variante: 'mestre' }), (falha) => falha.status === 404 && falha.codigo === 'IMAGEM_NAO_ENCONTRADA');
  });

  test('ORQ-04 — nunca registro sem arquivo: no instante do INSERT as três variantes já estão no armazenamento', async (t) => {
    let presentes = null;
    let a = null;
    a = preparar(t, {
      mundo: {
        aoInserir: async (dados) => {
          const chaves = chavesDe(dados.empresaId, dados.sha256, dados.formato);
          presentes = await Promise.all(VARIANTES.map((v) => a.memoria.existe(chaves[v])));
        },
      },
    });
    await a.envio.enviar(a.pool, envioDe({ bytes: png(323, 320) }));
    assert.deepEqual(presentes, [true, true, true]);
  });
});

describe('envio de imagem — falhas antes do registro (nenhuma linha, nenhuma auditoria)', () => {
  for (const variante of VARIANTES) {
    test(`ORQ-05 (${variante}) — falha ao gravar a variante "${variante}" no armazenamento: o envio falha como erro interno, o INSERT e a auditoria nunca acontecem, e a mensagem não leva chave nem hash`, async (t) => {
      const a = preparar(t, { armazenamento: { falharEm: variante } });
      const bytes = png(320, 320);
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes })), (falha) => {
        assert.equal(falha.status === undefined || falha.status >= 500, true, `não pode ser sucesso nem erro do cliente: ${falha.status}`);
        assert.equal(String(falha.message).includes(sha256Hex(bytes)), false);
        assert.equal(/\d+\/[0-9a-f]{64}\//.test(String(falha.message)), false, 'sem chave de armazenamento na mensagem');
        return true;
      });
      assert.equal(a.eventos.includes('inserir'), false);
      assert.equal(a.eventos.includes('auditar'), false);
      assert.equal(a.linhas.length, 0);
    });
  }

  const RECUSAS = [
    ['IMAGEM_FORMATO_NAO_SUPORTADO', 415], ['IMAGEM_ANIMADA_NAO_SUPORTADA', 415], ['IMAGEM_INVALIDA', 400], ['IMAGEM_DIMENSOES_INVALIDAS', 400],
  ];
  for (const [codigo, status] of RECUSAS) {
    test(`ORQ-06 (${codigo}) — o processador recusa: ${status} ${codigo} público e genérico (sem a mensagem do processador); nada é gravado, registrado nem auditado`, async (t) => {
      const a = preparar(t);
      a.processador.falharCom(codigo, 'ISCA-DE-VAZAMENTO nome-do-arquivo.png');
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes: png(320, 320) })), (falha) => {
        assert.equal(falha instanceof HttpError, true, 'recusa pública é HttpError');
        assert.deepEqual([falha.status, falha.codigo], [status, codigo]);
        assert.equal(JSON.stringify([falha.message, falha.detalhes ?? null]).includes('ISCA-DE-VAZAMENTO'), false);
        return true;
      });
      assert.deepEqual(semEscritaNemPersistencia(a.eventos), []);
      assert.equal(a.eventos.includes('connect'), false, 'nem conexão com o banco é aberta para uma imagem recusada');
    });
  }

  test('ORQ-06 (inesperado) — uma falha do processador fora do conjunto conhecido não vira sucesso: o envio falha e nada é gravado, registrado nem auditado', async (t) => {
    const a = preparar(t);
    a.processador.falharCom('FALHA_NAO_CATALOGADA', 'ISCA-INTERNA');
    await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes: png(320, 320) })), (falha) => falha.status === undefined || falha.status >= 500);
    assert.deepEqual(semEscritaNemPersistencia(a.eventos), []);
  });

  test('ORQ-07 — bytes vazios ou de formato não suportado (GIF) são 415 IMAGEM_FORMATO_NAO_SUPORTADO e nada é gravado nem registrado', async (t) => {
    const a = preparar(t);
    for (const bytes of [Buffer.alloc(0), Buffer.from(`GIF89a${'\0'.repeat(40)}`, 'latin1')]) {
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes })), (falha) => falha.status === 415 && falha.codigo === 'IMAGEM_FORMATO_NAO_SUPORTADO');
    }
    assert.deepEqual(semEscritaNemPersistencia(a.eventos), []);
  });
});

describe('envio de imagem — deduplicação, cota e isolamento entre empresas', () => {
  test('ORQ-08 — o mesmo conteúdo na mesma empresa: segundo envio é { reaproveitada:true } com o MESMO id e o nome original; uma linha, uma auditoria e só três arquivos', async (t) => {
    const a = preparar(t);
    const bytes = png(320, 324);
    const primeiro = await a.envio.enviar(a.pool, envioDe({ bytes, nome: 'Nome original' }));
    const segundo = await a.envio.enviar(a.pool, envioDe({ bytes: Buffer.from(bytes), nome: 'Outro nome' }));
    assert.equal(primeiro.reaproveitada, false);
    assert.deepEqual([segundo.reaproveitada, segundo.imagem.id, segundo.imagem.nome], [true, primeiro.imagem.id, 'Nome original']);
    assert.equal(a.linhas.length, 1);
    assert.equal(a.auditorias.length, 1);
    assert.equal((await a.memoria.listar('3')).length, 3);
  });

  test('ORQ-09 — conteúdo já existente mas INATIVO: devolve a existente com o estado dela (INATIVA), sem reativar, sem nova linha e sem nova auditoria', async (t) => {
    const bytes = png(320, 325);
    const a = preparar(t, {
      mundo: {
        existentes: [{
          id: '41', empresaId: 3, nome: 'Antiga', sha256: sha256Hex(bytes), sha256Mestre: 'a'.repeat(64), sha256Exibicao: 'b'.repeat(64), sha256Miniatura: 'c'.repeat(64), formato: 'PNG',
          largura: 320, altura: 325, bytesMestre: 100, bytesExibicao: 100, bytesMiniatura: 100, versao: 1, estado: 'INATIVA', criadoPor: 9,
        }],
      },
    });
    const r = await a.envio.enviar(a.pool, envioDe({ bytes }));
    assert.deepEqual([r.reaproveitada, r.imagem.id, r.imagem.estado], [true, '41', 'INATIVA']);
    assert.equal(a.eventos.includes('inserir'), false);
    assert.equal(a.eventos.includes('auditar'), false);
  });

  test('ORQ-10 — cota de imagens esgotada: 409 IMAGEM_COTA_EXCEDIDA, sem linha e sem auditoria', async (t) => {
    await comAmbiente({ IMAGENS_COTA_IMAGENS: '10' }, async () => {
      const a = preparar(t, { mundo: { consumo: { imagens: 10, bytes: 0, bytesArmazenados: 0 } } });
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes: png(320, 326) })), (falha) => falha.status === 409 && falha.codigo === 'IMAGEM_COTA_EXCEDIDA');
      assert.equal(a.eventos.includes('inserir'), false);
      assert.equal(a.eventos.includes('auditar'), false);
    });
  });

  test('ORQ-11 — a cota em bytes soma o MESTRE recodificado, não o arquivo enviado: um envio pequeno cujo mestre não cabe na cota é 409 IMAGEM_COTA_EXCEDIDA', async (t) => {
    await comAmbiente({ IMAGENS_COTA_MIB: '10' }, async () => {
      const a = preparar(t, { mundo: { consumo: { imagens: 1, bytes: 10 * MIB - 1000, bytesArmazenados: 0 } }, processador: { extraDoMestre: 5000 } });
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes: pngMinimo(320, 320) })), (falha) => falha.status === 409 && falha.codigo === 'IMAGEM_COTA_EXCEDIDA');
      assert.equal(a.eventos.includes('inserir'), false);
    });
  });

  test('ORQ-11 (controle) — com o mesmo envio pequeno e um mestre que cabe na cota, o envio passa (prova que o 409 anterior é do tamanho do mestre)', async (t) => {
    await comAmbiente({ IMAGENS_COTA_MIB: '10' }, async () => {
      const a = preparar(t, { mundo: { consumo: { imagens: 1, bytes: 10 * MIB - 1000, bytesArmazenados: 0 } }, processador: { extraDoMestre: 100 } });
      const r = await a.envio.enviar(a.pool, envioDe({ bytes: pngMinimo(320, 320) }));
      assert.equal(r.reaproveitada, false);
    });
  });

  test('ORQ-12 — isolamento: os mesmos bytes em duas empresas são duas imagens com dois conjuntos de arquivos (3/<sha>/… e 4/<sha>/…), cada um com a sua linha; nada em padrao/', async (t) => {
    const a = preparar(t);
    const bytes = png(320, 327);
    const daTres = await a.envio.enviar(a.pool, envioDe({ bytes, empresaId: 3, atorId: 9 }));
    const daQuatro = await a.envio.enviar(a.pool, envioDe({ bytes, empresaId: 4, atorId: 19 }));
    assert.deepEqual([daTres.reaproveitada, daQuatro.reaproveitada], [false, false], 'a deduplicação é por empresa, nunca entre empresas');
    assert.notEqual(daTres.imagem.id, daQuatro.imagem.id);
    assert.deepEqual(a.linhas.map((l) => [l.empresaId, l.criadoPor]), [[3, 9], [4, 19]]);
    const sha = sha256Hex(bytes);
    assert.deepEqual(await a.memoria.listar('3'), Object.values(chavesDe(3, sha, 'PNG')).sort());
    assert.deepEqual(await a.memoria.listar('4'), Object.values(chavesDe(4, sha, 'PNG')).sort());
    assert.deepEqual(await a.memoria.listar('padrao'), []);
  });
});

describe('envio de imagem — reenvio depois de excluir o registro (independe de quando haverá limpeza física)', () => {
  async function excluirERenviar(t, { removerArquivosAntigos }) {
    const a = preparar(t);
    const bytes = png(320, 328);
    const primeiro = await a.envio.enviar(a.pool, envioDe({ bytes }));
    a.linhas.length = 0; // a exclusão remove só a linha (serviço excluir); os arquivos ficam
    if (removerArquivosAntigos) await a.memoria.removerVariantes({ escopo: 'EMPRESA', empresaId: 3, sha256: sha256Hex(bytes) });
    const segundo = await a.envio.enviar(a.pool, envioDe({ bytes }));
    assert.equal(segundo.reaproveitada, false, 'sem registro, é uma imagem nova');
    assert.notEqual(segundo.imagem.id, primeiro.imagem.id);
    const entrega = criarEntregaDeImagens({ armazenamento: a.memoria, registro: () => {} });
    const esperado = a.processador.resultadoEsperado(bytes);
    for (const variante of ['miniatura', 'exibicao']) {
      const entregue = await entrega.obter(a.pool, { empresaId: 3, origem: 'empresa', id: segundo.imagem.id, variante });
      assert.equal(entregue.corpo.equals(esperado[variante]), true, `${variante}: a imagem reenviada é entregue com os bytes verificados`);
    }
  }

  test('ORQ-13a — os arquivos antigos AINDA estão no disco: o reenvio reaproveita os arquivos, registra a nova linha e a imagem é entregue', async (t) => {
    await excluirERenviar(t, { removerArquivosAntigos: false });
  });

  test('ORQ-13b — os arquivos antigos JÁ foram removidos: o reenvio regrava os três arquivos, registra a nova linha e a imagem é entregue', async (t) => {
    await excluirERenviar(t, { removerArquivosAntigos: true });
  });
});

describe('envio de imagem — decodificação sem trava, trava da empresa e processamento limitado', () => {
  test('ORQ-14 — enquanto a imagem é decodificada não há transação aberta nem trava tomada; a trava da biblioteca é a da empresa do contexto, nunca uma trava global', async (t) => {
    const a = preparar(t);
    await a.envio.enviar(a.pool, envioDe({ bytes: png(320, 329), empresaId: 3, atorId: 9 }));
    const inicio = a.eventos.indexOf('processar:inicio');
    const fim = a.eventos.indexOf('processar:fim');
    assert.equal(inicio >= 0 && fim > inicio, true, 'o processador foi chamado uma vez');
    const durante = a.eventos.slice(inicio + 1, fim).filter((e) => e === 'connect' || e === 'sql:BEGIN' || e.startsWith('travar:'));
    assert.deepEqual(durante, [], 'nenhuma conexão, transação ou trava durante a decodificação');
    assert.deepEqual(a.eventos.filter((e) => e.startsWith('travar:')), ['travar:3']);
    await a.envio.enviar(a.pool, envioDe({ bytes: png(321, 329), empresaId: 4, atorId: 19 }));
    assert.deepEqual(a.eventos.filter((e) => e.startsWith('travar:')), ['travar:3', 'travar:4'], 'cada empresa trava a sua própria biblioteca');
    assert.equal(a.processador.chamadas.length, 2, 'um processamento por envio');
  });

  test('ORQ-15 — decodificações simultâneas: no máximo 2 por processo (padrão da configuração), vindas de empresas diferentes e da mesma; as seis terminam e nada as serializa por trava', async (t) => {
    const liberar = [];
    const a = preparar(t, { processador: { aguardar: () => new Promise((resolve) => { liberar.push(resolve); }) } });
    const envios = Array.from({ length: 6 }, (_, i) => a.envio.enviar(a.pool, envioDe({
      empresaId: 3 + (i % 2), atorId: 9 + (i % 2), nome: `Simultâneo ${i}`, bytes: png(320 + i, 330),
    })));
    await esperarAte(() => a.processador.emAndamento >= 2, 'dois processamentos deveriam ter começado');
    await proximosTicks(10);
    assert.equal(a.processador.emAndamento, 2, 'dois decodificam ao mesmo tempo; os outros esperam a vez');
    for (let restantes = 6; restantes > 0; restantes -= 1) {
      await esperarAte(() => liberar.length > 0, 'o processamento seguinte deveria ter sido admitido quando uma vaga abriu');
      liberar.shift()();
      await proximosTicks(5);
      assert.equal(a.processador.emAndamento <= 2, true);
    }
    const resultados = await Promise.all(envios);
    assert.deepEqual(resultados.map((r) => r.reaproveitada), [false, false, false, false, false, false]);
    assert.equal(a.processador.maximoSimultaneo, 2);
  });
});

describe('envio de imagem — recurso indisponível e contexto inválido', () => {
  test('ORQ-16 — sem armazenamento configurado ou sem processador, o envio é 503 IMAGENS_INDISPONIVEL antes de processar, gravar ou abrir conexão (falha fechada)', async (t) => {
    const { criarUploadDeImagens } = exigirModulo('src/services/imagem-material-upload.service');
    const m = montarMundo(t);
    const processador = criarProcessadorFalso({ eventos: m.eventos });
    const memoria = criarArmazenamentoMemoriaFalso();
    for (const dependencias of [{ armazenamento: null, processador }, { armazenamento: memoria, processador: null }]) {
      const envio = criarUploadDeImagens(dependencias);
      await assert.rejects(envio.enviar(m.pool, envioDe({ bytes: png(320, 320) })), (falha) => falha.status === 503 && falha.codigo === 'IMAGENS_INDISPONIVEL');
    }
    assert.equal(processador.chamadas.length, 0);
    assert.deepEqual(m.eventos, []);
    assert.deepEqual(await memoria.listar('3'), []);
  });

  test('ORQ-17 — empresa e ator inválidos são erro de programação (TypeError), como nos demais serviços: nada é processado, gravado nem registrado', async (t) => {
    const a = preparar(t);
    for (const contexto of [{ empresaId: 0 }, { empresaId: '3' }, { atorId: -1 }, { atorId: 1.5 }]) {
      await assert.rejects(a.envio.enviar(a.pool, envioDe({ bytes: png(320, 320), ...contexto })), TypeError);
    }
    assert.deepEqual(semEscritaNemPersistencia(a.eventos), []);
    assert.equal(a.processador.chamadas.length, 0, 'o contexto inválido é recusado antes de qualquer decodificação');
  });
});

describe('decisões abertas da 5C (registradas como TODO: nem RED nem verde)', () => {
  test('DEC-D-C2 — arquivos de um envio recusado por cota ou por duplicidade: gravar antes da conferência ou só depois dela?', {
    todo: 'depende da ordem de gravação (antes ou sob a trava); decisão da 5C-2. Requisito de fundo: o envio recusado não pode acumular arquivos sem limite.',
  }, () => {});

  test('DEC-D-C3 — requisitos da limpeza física futura: nunca remover arquivo referenciado por registro, nem durante um envio em andamento; acontece fora da requisição HTTP', {
    todo: 'a rotina de limpeza e o seu contrato são decisão posterior (5C-5); estes requisitos de integridade valem para qualquer desenho.',
  }, () => {});
});
