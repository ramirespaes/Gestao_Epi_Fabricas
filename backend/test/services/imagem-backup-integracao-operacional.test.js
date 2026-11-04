'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { abrirPacote, criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarRestauradorDoBanco } = require('../../src/services/imagem-backup-restauracao-banco.service');
const { criarLancadorDeRestauracaoComSpawn } = require('../../src/services/imagem-backup-restauracao-lancador.service');
const { criarAdaptadorDeReferencias, sqlPermitido } = require('../../src/services/imagem-backup-consistencia-banco.service');
const { criarFonteDeChaves, criarFonteDeProvedor, criarFonteOperacionalDeChaves, PROVEDORES_OPERACIONAIS_APROVADOS, criarLeitorV2, ehAutenticacaoReconhecida } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { avaliarProntidaoOperacional, criarProdutorOperacional, criarProdutorDeRelatorio, criarPublicador, DESTINOS_OPERACIONAIS_AUTORIZADOS } = require('../../src/services/imagem-backup-publicacao.service');
const { construirPacotePublicado, limparTemporarios, novaRaiz } = require('../helpers/pacote-publicado-ficticio');

/**
 * INTEGRAÇÃO OPERACIONAL (preparação, NÃO homologação): fonte de chaves por provedor, produtor operacional (bloqueado), adaptador de consistência lógica sobre conexão INJETADA e fluxo completo C -> D. Tudo FICTÍCIO e SIMULADO: chaves aleatórias em memória,
 * `spawn` e cliente PostgreSQL falsos, nenhum processo operacional, nenhum banco, nenhuma imagem real. Nada aqui comprova restauração real, publicação operacional ou recuperabilidade.
 */

after(limparTemporarios);
const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const POLITICA = { prefixoDoBanco: 'gepi_restauracao_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi', 'gestao_epi_producao'] };
const DESTINO_BANCO = Object.freeze({ banco: 'gepi_restauracao_temp1', host: '127.0.0.1', porta: 5432, usuario: 'gepi_restore', arquivoDeSenha: '/tmp/senha-ficticia' });

function provedorFicticio(estado) {
  return { obter(id) { if (estado.lanca) throw new Error('SEGREDO /Users/privado'); return estado.chaves[id] ?? { situacao: 'INDISPONIVEL' }; } };
}
async function pacoteV2ComProvedor(estado, chaveId) {
  const fonteDeChaves = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: provedorFicticio(estado) });
  const p = await construirPacotePublicado({ autenticado: { fonteDeChaves, chaveId } });
  return { ...p, fonteDeChaves };
}
const novoEstado = () => ({ chaves: { 'k-1': { situacao: 'ATIVA', segredo: crypto.randomBytes(32) } }, lanca: false });
function reescrever(p, mutador) {
  const alvo = path.join(p.caminho, 'manifesto.json');
  const objeto = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  mutador(objeto);
  const bytes = Buffer.from(JSON.stringify(objeto), 'utf8');
  fs.writeFileSync(alvo, bytes);
  fs.writeFileSync(path.join(p.caminho, 'manifesto.sha256'), `${sha(bytes)}  manifesto.json\n`);
}

// ------------------------------------------------------------------------------------------------------------------- 1. fonte de chaves
describe('[OP-F] fonte de chaves por provedor externo; caminho OPERACIONAL bloqueado', () => {
  teste('OP-F01 — a fonte OPERACIONAL está BLOQUEADA (nenhum provedor aprovado) e a origem OPERACIONAL não é declarável pelo chamador por nenhuma fábrica', () => {
    assert.deepEqual([...PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.equal(Object.isFrozen(PROVEDORES_OPERACIONAIS_APROVADOS), true);
    const adaptador = provedorFicticio(novoEstado());
    for (const provedor of ['cofre-x', 'TESTE_CONTROLADO', 'OPERACIONAL', '']) {
      assert.throws(() => criarFonteOperacionalDeChaves({ provedor, adaptador }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    }
    assert.throws(() => criarFonteOperacionalDeChaves({}), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    assert.throws(() => criarFonteDeChaves({ origem: 'OPERACIONAL', chaves: [{ id: 'a', segredo: crypto.randomBytes(32) }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeProvedor({ origem: 'OPERACIONAL', provedor: adaptador }), (e) => e.code === 'FONTE_INVALIDA');
    // a lista aprovada é código, não configuração: mutá-la é impossível
    assert.throws(() => { 'use strict'; PROVEDORES_OPERACIONAIS_APROVADOS.push('cofre-x'); }, TypeError);
  });

  teste('OP-F02 — a fonte por provedor funciona em TESTE com id, rotação e revogação; o pacote V2 abre e a origem da chave fica registrada como TESTE_CONTROLADO', async () => {
    const estado = novoEstado();
    const p = await pacoteV2ComProvedor(estado, 'k-1');
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: p.fonteDeChaves });
    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.autenticacao.origemDaChave, 'TESTE_CONTROLADO');
    // rotação: chave nova entra; a antiga continua autenticando enquanto o provedor a mantém ativa
    estado.chaves['k-2'] = { situacao: 'ATIVA', segredo: crypto.randomBytes(32) };
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: p.fonteDeChaves })).ok, true);
    // revogação
    estado.chaves['k-1'] = { situacao: 'REVOGADA' };
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: p.fonteDeChaves })).motivo, 'CHAVE_REVOGADA');
  });

  teste('OP-F03 — FALHA FECHADA: provedor que lança, indisponibilidade, resposta fora do contrato, segredo curto e situação desconhecida nunca autenticam; a falha não vaza', async () => {
    const estado = novoEstado();
    const p = await pacoteV2ComProvedor(estado, 'k-1');
    const original = estado.chaves['k-1'];
    const motivo = async () => (await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: p.fonteDeChaves }));
    estado.lanca = true;
    const a = await motivo();
    assert.deepEqual([a.ok, a.motivo], [false, 'CHAVE_INDISPONIVEL']);
    assert.equal(JSON.stringify(a).includes('privado'), false);
    estado.lanca = false;
    for (const ruim of [{ situacao: 'ATIVA', segredo: crypto.randomBytes(8) }, { situacao: 'ATIVA' }, { situacao: 'TALVEZ', segredo: original.segredo }, null, 'texto', { situacao: 'INDISPONIVEL', segredo: original.segredo }]) {
      estado.chaves['k-1'] = ruim;
      const r = await motivo();
      assert.deepEqual([r.ok, r.motivo], [false, 'CHAVE_INDISPONIVEL'], JSON.stringify(ruim));
    }
    estado.chaves['k-1'] = original; // disponibilidade restabelecida pelo provedor
    assert.equal((await motivo()).ok, true);
    assert.equal(JSON.stringify(p.fonteDeChaves).includes(original.segredo.toString('hex')), false);
  });

  teste('OP-F04 — o segredo nunca é persistido no pacote publicado (nenhum arquivo contém a chave em hex, base64 ou binário)', async () => {
    const estado = novoEstado();
    const p = await pacoteV2ComProvedor(estado, 'k-1');
    const segredo = estado.chaves['k-1'].segredo;
    const andar = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? andar(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const arq of andar(p.caminho)) {
      const dados = fs.readFileSync(arq);
      assert.equal(dados.includes(segredo), false);
      assert.equal(dados.includes(Buffer.from(segredo.toString('hex'))), false);
      assert.equal(dados.includes(Buffer.from(segredo.toString('base64'))), false);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------- 2. produtor operacional
describe('[OP-R] produtor operacional: contrato ligado às evidências reconhecidas; publicação operacional BLOQUEADA', () => {
  async function comEvidencias() {
    const estado = novoEstado();
    const fonteDeChaves = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: provedorFicticio(estado) });
    const p = await construirPacotePublicado({ autenticado: { fonteDeChaves, chaveId: 'k-1' }, devolverEvidencias: true, produtor: criarProdutorOperacional(), origensAceitas: ['OPERACIONAL'] });
    const lido = criarLeitorV2({ fonteDeChaves })({ bytes: fs.readFileSync(path.join(p.preparacao, 'manifesto.json')), sha256: p.evidencias.correlacao.manifesto.sha256Manifesto });
    return { p, autenticacao: lido.autenticacao, fonteDeChaves };
  }
  const evid = ({ p, autenticacao }, extras = {}) => ({
    correlacao: p.evidencias.correlacao,
    pacote: p.evidencias.pacote.verificacao,
    consistencia: p.evidencias.pacote.consistencia,
    autenticacao,
    destino: { raizDoDestino: p.publicados, nomeFinal: p.nome },
    ...extras,
  });

  teste('OP-R01 — com evidências REAIS do pipeline a prontidão satisfaz tudo, EXCETO a fonte operacional de chaves e o destino autorizado: continua bloqueada', async () => {
    const e = await comEvidencias();
    const r = avaliarProntidaoOperacional(evid(e));
    assert.equal(r.pronta, false);
    assert.deepEqual([...r.pendencias].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    for (const item of ['IDENTIDADE_DA_OPERACAO', 'SNAPSHOT_E_CORRELACAO', 'SUPERVISAO_E_DUMP_T1_T2', 'VERIFICACAO_ESTRUTURAL', 'CONSISTENCIA_EXIGIDA', 'PACOTE_VERIFICADO', 'MANIFESTO_V2_AUTENTICADO']) assert.equal(r.itens[item], true, item);
    assert.deepEqual([...DESTINOS_OPERACIONAIS_AUTORIZADOS], []);
  });

  teste('OP-R01b — autenticação da abertura independente é reconhecida; prontidão continua bloqueada', async () => {
    const e = await comEvidencias();

    assert.ok(e.fonteDeChaves, 'fonte fictícia ausente');

    const pub = await construirPacotePublicado({
      autenticado: {
        fonteDeChaves: e.fonteDeChaves,
        chaveId: 'k-1'
      },
      devolverEvidencias: true
    });

    assert.ok(pub.evidencias, 'helper não devolveu evidências');
    assert.ok(pub.evidencias.correlacao);
    assert.ok(pub.evidencias.pacote);

    const lido = await abrirPacote({
      raizAutorizada: pub.publicados,
      nome: pub.nome,
      fonteDeChaves: e.fonteDeChaves
    });

    assert.equal(lido.ok, true);
    assert.equal(
      ehAutenticacaoReconhecida(lido.autenticacao),
      true
    );

    const resultado = avaliarProntidaoOperacional({
      correlacao: pub.evidencias.correlacao,
      pacote: pub.evidencias.pacote.verificacao,
      consistencia: pub.evidencias.pacote.consistencia,
      autenticacao: lido.autenticacao,
      destino: { raizDoDestino: pub.publicados }
    });

    assert.equal(resultado.pronta, false);

    assert.deepEqual(
      [...resultado.pendencias].sort(),
      [
        'DESTINO_AUTORIZADO',
        'FONTE_OPERACIONAL_DE_CHAVES'
      ].sort()
    );

    assert.equal(
      ehAutenticacaoReconhecida({ ...lido.autenticacao }),
      false,
      'uma cópia não deve herdar a proveniência'
    );
  });

  teste('OP-R02 — a publicação com o produtor operacional NÃO ocorre: RELATORIO_SEM_PROVENIENCIA com as pendências; nada é publicado e a preparação permanece', async () => {
    const e = await comEvidencias();
    const pub = e.p.evidencias.publicacao;
    assert.equal(pub.publicada, false);
    assert.equal(pub.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    assert.deepEqual([...pub.pendencias].sort(), ['DESTINO_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    assert.deepEqual(fs.readdirSync(e.p.publicados), []);
    assert.equal(fs.existsSync(e.p.preparacao), true);
  });

  teste('OP-R03 — evidência CLONADA, literal ou fabricada não é reconhecida: cada item correspondente falha', async () => {
    const e = await comEvidencias();
    const base = evid(e);
    const clonada = avaliarProntidaoOperacional({ ...base, correlacao: { ...base.correlacao }, pacote: { ...base.pacote }, consistencia: { ...base.consistencia }, autenticacao: { ...base.autenticacao } });
    for (const item of ['SNAPSHOT_E_CORRELACAO', 'SUPERVISAO_E_DUMP_T1_T2', 'VERIFICACAO_ESTRUTURAL', 'PACOTE_VERIFICADO', 'CONSISTENCIA_EXIGIDA', 'MANIFESTO_V2_AUTENTICADO']) assert.equal(clonada.itens[item], false, item);
    const fabricada = avaliarProntidaoOperacional({ ...base, autenticacao: { versao: 2, autenticado: true, origemDaChave: 'OPERACIONAL' }, destino: { raizDoDestino: e.p.publicados } });
    assert.equal(fabricada.itens.FONTE_OPERACIONAL_DE_CHAVES, false);
    assert.equal(fabricada.itens.MANIFESTO_V2_AUTENTICADO, false);
    assert.equal(ehAutenticacaoReconhecida(fabricada.autenticacao ?? { versao: 2 }), false);
    assert.equal(avaliarProntidaoOperacional(undefined).pronta, false);
    assert.equal(avaliarProntidaoOperacional({ ...base, consistencia: { ...base.consistencia, operacaoId: 'outra' } }).itens.IDENTIDADE_DA_OPERACAO, false);
  });

  teste('OP-R04 — relatório literal / objeto de teste / NODE_ENV NÃO autorizam publicação operacional', async () => {
    const p = await construirPacotePublicado({ devolverEvidencias: true });
    // o produtor de teste publica, mas a publicação é marcada NÃO operacional e a origem aceita é a de teste
    assert.equal(p.evidencias.publicacao.publicada, true);
    assert.equal(p.evidencias.publicacao.publicacaoOperacional, false);
    assert.equal(p.evidencias.publicacao.origemDoRelatorio, 'TESTE_CONTROLADO');
    // produtor literal e origem OPERACIONAL não podem ser fabricados
    assert.throws(() => criarPublicador({ raizDoDestino: novaRaiz(), produtorDeRelatorio: async () => ({ ok: true, origem: 'OPERACIONAL' }) }));
    assert.throws(() => criarProdutorDeRelatorio({ origem: 'OPERACIONAL', decidir: () => ({ ok: true }) }));
    // produtor de teste com origem aceita OPERACIONAL: a decisão de teste não é aceita como operacional
    const q = await construirPacotePublicado({ devolverEvidencias: true, origensAceitas: ['OPERACIONAL'] });
    assert.equal(q.evidencias.publicacao.publicada, false);
    assert.equal(q.evidencias.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    // a prontidão não consulta o ambiente
    assert.equal(/process\.env/.test(avaliarProntidaoOperacional.toString()), false);
    assert.equal(/process\.env/.test(criarProdutorOperacional.toString()), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------- 3. adaptador de consistência lógica
function registrosDoBanco() {
  const pm = Buffer.from('padrao-mestre-conteudo');
  const pn = Buffer.from('padrao-miniatura-conteudo');
  const em = Buffer.from('empresa7-mestre');
  const ee = Buffer.from('empresa7-exibicao');
  const en = Buffer.from('empresa7-miniatura');
  return {
    padrao: [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }],
    empresa: [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }],
  };
}
const tipoDe = (sql) => {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK$/i.test(t)) return 'ROLLBACK';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
};
function clienteSimulado({ banco = 'gepi_restauracao_temp1', linhas = registrosDoBanco(), falhaEm = null, perdeEm = null, rollbackFalha = false, endFalha = false, paginaMaior = false, cursorParado = false } = {}) {
  const sqls = [];
  const c = {
    sqls,
    ouvintes: { error: [], end: [] },
    encerrado: false,
    async connect() {},
    async query(sql, parametros) {
      const tipo = tipoDe(sql);
      sqls.push({ tipo, sql });
      if (falhaEm === tipo) throw Object.assign(new Error('SEGREDO /Users/privado SELECT * FROM x'), { code: '57014' });
      if (perdeEm === tipo) for (const f of c.ouvintes.error) f(new Error('conexão perdida'));
      if (tipo === 'ROLLBACK' && rollbackFalha) throw new Error('rollback');
      switch (tipo) {
        case 'IDENTIDADE': return { rows: [{ nome: banco, oid: '16384' }] };
        case 'PADRAO': case 'EMPRESA': {
          const todas = tipo === 'PADRAO' ? linhas.padrao : linhas.empresa;
          const [depoisDe, limite] = parametros;
          let pagina = todas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);
          if (paginaMaior) pagina = [...pagina, ...pagina, ...pagina];
          if (cursorParado && pagina.length === limite) pagina = pagina.map((l) => ({ ...l, id: '1' }));
          return { rows: pagina };
        }
        case 'BEGIN': case 'ROLLBACK': return { rows: [] };
        default: throw new Error(`SQL inesperado: ${tipo}`);
      }
    },
    async end() { c.encerrado = true; if (endFalha) throw new Error('end'); for (const f of c.ouvintes.end) f(); },
    on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
  };
  return c;
}
const consulta = (adaptador, extra = {}) => adaptador.consultar({ banco: 'gepi_restauracao_temp1', conjuntoId: 'conjunto-md-0001', sha256Manifesto: H('a'), ...extra });

describe('[OP-A] adaptador de consistência lógica (conexão injetada, banco SIMULADO)', () => {
  teste('OP-A01 — construção estrita e sem efeito: não conecta; exige criarConexao; recusa chaves desconhecidas, página inválida e consulta fora do formato', async () => {
    let conexoes = 0;
    const a = criarAdaptadorDeReferencias({ criarConexao: () => { conexoes += 1; return clienteSimulado(); } });
    assert.equal(conexoes, 0);
    assert.throws(() => criarAdaptadorDeReferencias({}), TypeError);
    assert.throws(() => criarAdaptadorDeReferencias({ criarConexao: 1 }), TypeError);
    assert.throws(() => criarAdaptadorDeReferencias({ criarConexao: () => {}, extra: 1 }), TypeError);
    assert.throws(() => criarAdaptadorDeReferencias({ criarConexao: () => {}, tamanhoDaPagina: 0 }), TypeError);
    assert.throws(() => criarAdaptadorDeReferencias({ criarConexao: () => {}, tamanhoDaPagina: 5000 }), TypeError);
    await assert.rejects(() => a.consultar({ banco: 'x' }), TypeError);
    await assert.rejects(() => consulta(a, { banco: 'GESTAO;DROP' }), TypeError);
    await assert.rejects(() => consulta(a, { sha256Manifesto: 'zz' }), TypeError);
    await assert.rejects(() => consulta(a, { extra: 1 }), TypeError);
    assert.equal(conexoes, 0);
  });

  teste('OP-A02 — POSITIVO: lê as duas tabelas pelos contratos reais, em transação READ ONLY encerrada em ROLLBACK; só BEGIN READ ONLY, SELECT e ROLLBACK chegam ao cliente; ecoa a operação', async () => {
    const cliente = clienteSimulado();
    const r = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => cliente }));
    assert.equal(r.ok, true);
    assert.equal(r.completa, true);
    assert.deepEqual([r.banco, r.conjuntoId, r.sha256Manifesto], ['gepi_restauracao_temp1', 'conjunto-md-0001', H('a')]);
    assert.equal(r.registros.padrao.length, 1);
    assert.equal(r.registros.empresa.length, 1);
    assert.equal(r.registros.padrao[0].sha256Miniatura, registrosDoBanco().padrao[0].sha256_miniatura);
    assert.deepEqual(cliente.sqls.map((s) => s.tipo), ['BEGIN', 'IDENTIDADE', 'PADRAO', 'EMPRESA', 'ROLLBACK']);
    for (const { sql } of cliente.sqls) assert.equal(sqlPermitido(sql), true);
    assert.equal(cliente.encerrado, true);
    assert.equal(Object.isFrozen(r), true);
  });

  teste('OP-A03 — a porta de leitura recusa escrita, DDL, comandos múltiplos e CTE gravável', () => {
    for (const ruim of ['INSERT INTO imagens_padrao VALUES (1)', 'UPDATE imagens_padrao SET sha256 = 1', 'DELETE FROM imagens_padrao', 'DROP TABLE imagens_padrao', 'TRUNCATE imagens_padrao', 'COPY imagens_padrao TO PROGRAM \'x\'', 'SELECT 1; DROP TABLE x', 'WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x', 'BEGIN', 'BEGIN READ WRITE', 'COMMIT', 'SET ROLE postgres', '', 42]) assert.equal(sqlPermitido(ruim), false, String(ruim));
    for (const bom of ['SELECT 1', 'SELECT id FROM imagens_padrao WHERE id > $1::bigint ORDER BY id LIMIT $2', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']) assert.equal(sqlPermitido(bom), true, bom);
  });

  teste('OP-A04 — paginação real: com página de 1 linha as duas tabelas são lidas até o fim e continuam completas', async () => {
    const linhas = registrosDoBanco();
    linhas.padrao.push({ ...linhas.padrao[0], id: '3', sha256: H('1'), sha256_miniatura: H('2') });
    linhas.empresa.push({ ...linhas.empresa[0], id: '4', sha256: H('3'), sha256_mestre: H('4'), sha256_exibicao: H('5'), sha256_miniatura: H('6') });
    const cliente = clienteSimulado({ linhas });
    const r = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => cliente, tamanhoDaPagina: 1 }));
    assert.deepEqual([r.ok, r.registros.padrao.length, r.registros.empresa.length], [true, 2, 2]);
    assert.ok(cliente.sqls.filter((s) => s.tipo === 'PADRAO').length >= 2);
  });

  teste('OP-A05 — BANCO DIFERENTE do pedido: nada é lido, ROLLBACK e end; resultado de outra operação nunca é entregue', async () => {
    const cliente = clienteSimulado({ banco: 'gestao_epi' });
    const r = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => cliente }));
    assert.deepEqual([r.ok, r.motivo], [false, 'BANCO_DIFERENTE']);
    assert.equal(cliente.sqls.some((s) => s.tipo === 'PADRAO' || s.tipo === 'EMPRESA'), false);
    assert.equal(cliente.sqls.at(-1).tipo, 'ROLLBACK');
    assert.equal(cliente.encerrado, true);
  });

  const falhas = [
    ['consulta de padrão falha', { falhaEm: 'PADRAO' }, 'CONSULTA_FALHOU'],
    ['consulta de empresa falha', { falhaEm: 'EMPRESA' }, 'CONSULTA_FALHOU'],
    ['identidade falha', { falhaEm: 'IDENTIDADE' }, 'IDENTIDADE_FALHOU'],
    ['BEGIN falha', { falhaEm: 'BEGIN' }, 'BEGIN_FALHOU'],
    ['página maior que o limite (consulta INCOMPLETA/inválida)', { paginaMaior: true }, 'CONSULTA_INVALIDA'],
    ['cursor que não avança', { cursorParado: true }, 'CONSULTA_INVALIDA'],
    ['conexão perdida durante a leitura', { perdeEm: 'EMPRESA' }, 'CONEXAO_PERDIDA'],
    ['ROLLBACK falha', { rollbackFalha: true }, 'ENCERRAMENTO_FALHOU'],
    ['end falha', { endFalha: true }, 'ENCERRAMENTO_FALHOU'],
  ];
  for (const [rotulo, opcoes, motivo] of falhas) {
    teste(`OP-A06 (${rotulo}) — falha fechada: ${motivo}; sem resposta parcial, sem mensagem do banco, conexão encerrada`, async () => {
      const cliente = clienteSimulado(opcoes);
      const r = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => cliente, tamanhoDaPagina: opcoes.cursorParado || opcoes.paginaMaior ? 1 : 500 }));
      assert.equal(r.ok, false);
      assert.equal(r.motivo, motivo);
      assert.equal(Object.hasOwn(r, 'registros'), false);
      assert.equal(JSON.stringify(r).includes('privado'), false);
      assert.equal(cliente.encerrado, true);
    });
  }

  teste('OP-A07 — conexão: fábrica que lança, objeto com forma de pool e cliente sem as operações são recusados sem uso', async () => {
    const lanca = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => { throw new Error('SEGREDO'); } }));
    assert.deepEqual([lanca.ok, lanca.motivo], [false, 'CONEXAO_INDISPONIVEL']);
    let tocado = 0;
    const pool = { connect: () => { tocado += 1; }, query: () => { tocado += 1; }, end: () => { tocado += 1; }, on: () => { tocado += 1; }, totalCount: 0 };
    const p = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => pool }));
    assert.deepEqual([p.ok, p.motivo, tocado], [false, 'CONEXAO_INVALIDA', 0]);
    const v = await consulta(criarAdaptadorDeReferencias({ criarConexao: () => ({}) }));
    assert.deepEqual([v.ok, v.motivo], [false, 'CONEXAO_INVALIDA']);
  });
});

// ------------------------------------------------------------------------------------------------------------------- 4 e 5. restauração supervisionada e fluxo completo C -> D
function spawnSimulado({ modo = 'ok' } = {}) {
  const chamadas = [];
  const filhos = [];
  const spawn = (exe, args, opcoes) => {
    chamadas.push({ exe, args, opcoes });
    const dados = Buffer.alloc(fs.fstatSync(opcoes.stdio[0]).size);
    fs.readSync(opcoes.stdio[0], dados, 0, dados.length, 0);
    chamadas.at(-1).entradaSha = sha(dados);
    const filho = new EventEmitter();
    filho.pid = 9100 + chamadas.length;
    filhos.push(filho);
    setImmediate(() => {
      filho.emit('spawn');
      if (modo === 'trava') return;
      if (modo === 'saida1') filho.emit('exit', 1, null); else if (modo === 'sinal') filho.emit('exit', null, 'SIGKILL'); else filho.emit('exit', 0, null);
      filho.emit('close', 0, null);
    });
    return filho;
  };
  return { chamadas, spawn, filhos };
}
function restauradorSupervisionado(falso, { politicaDoLancador = POLITICA, modo = 'ok', sinais = [] } = {}) {
  const lancador = criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: politicaDoLancador });
  return criarRestauradorDoBanco({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador,
    sistema: { async grupoVivo() { return false; }, async enviarSinal(pgid, sinal) { sinais.push(sinal); return true; } },
    temporizador: {
      prazo: (ms) => (modo === 'trava' && (ms === PRAZOS.totalMs || ms === PRAZOS.cortesiaMs) ? { promessa: Promise.resolve(), cancelar() {} } : { promessa: new Promise(() => {}), cancelar() {} }),
      intervalo: () => Promise.resolve(),
    },
    prazos: { ...PRAZOS },
    politicaDeDestino: POLITICA,
  });
}
async function fluxo(p, { falso = spawnSimulado(), banco = clienteSimulado(), modo = 'ok', sinais = [], politicaDoLancador, destino = DESTINO_BANCO, chaveFonte = p.fonteDeChaves, consultaDeReferencias } = {}) {
  const adaptador = consultaDeReferencias ?? criarAdaptadorDeReferencias({ criarConexao: () => banco });
  const rest = criarRestaurador({ fonteDeChaves: chaveFonte, restauradorDoBanco: restauradorSupervisionado(falso, { modo, sinais, politicaDoLancador }), consultaDeReferencias: adaptador });
  const imagens = { raiz: novaRaiz(), nome: 'img' };
  const r = await rest.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens, banco: { destino } });
  return { r, falso, banco, imagens };
}

describe('[OP-C] integração completa C -> D (pacote V2, lançador do pg_restore, adaptador, consistência) — SIMULADA', () => {
  teste('OP-C01 — fluxo completo positivo: preparação -> dump e imagens -> manifesto V2 -> selagem -> publicação -> abertura independente -> imagens -> banco (spawn simulado) -> conferência lógica (banco simulado); nada é real', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    const { r, falso, banco, imagens } = await fluxo(p);
    assert.equal(r.ok, true, `motivo: ${r.motivo}`);
    assert.equal(falso.chamadas.length, 1, 'um único pg_restore (simulado)');
    assert.deepEqual(falso.chamadas[0].args, ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_temp1']);
    assert.equal(falso.chamadas[0].entradaSha, sha(p.dumpBytes), 'entrada padrão = dump conferido do pacote');
    assert.deepEqual(banco.sqls.map((s) => s.tipo), ['BEGIN', 'IDENTIDADE', 'PADRAO', 'EMPRESA', 'ROLLBACK']);
    assert.equal(r.etapas.imagens.arquivos, 5);
    assert.equal(fs.readdirSync(path.join(imagens.raiz, imagens.nome)).length > 0, true);
    assert.equal(r.autenticacao.autenticado, true);
    assert.equal(r.consistenciaLogica.contratual, true);
    assert.equal(r.consistenciaLogica.verificada, false, 'banco SIMULADO não verifica consistência lógica');
    assert.deepEqual([r.restauracaoReal, r.recuperavel, r.aptidaoOperacional.apta], [false, false, false]);
    assert.ok(r.aptidaoOperacional.motivos.includes('CHAVE_DE_TESTE'));
  });

  teste('OP-C02 — ADULTERAÇÃO do pacote (manifesto + selo coerentes, sem a chave): AUTENTICACAO_INVALIDA; nenhum pg_restore, nenhuma consulta, nenhuma imagem restaurada', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    reescrever(p, (m) => { m.arquivos[0].sha256 = H('f'); });
    const { r, falso, banco, imagens } = await fluxo(p);
    assert.deepEqual([r.ok, r.motivo], [false, 'AUTENTICACAO_INVALIDA']);
    assert.deepEqual([falso.chamadas.length, banco.sqls.length], [0, 0]);
    assert.equal(fs.existsSync(path.join(imagens.raiz, imagens.nome)), false);
  });

  teste('OP-C03 — FALHA DE AUTENTICAÇÃO: chave de outra fonte, chave revogada e provedor indisponível interrompem antes de qualquer efeito', async () => {
    const estado = novoEstado();
    const p = await pacoteV2ComProvedor(estado, 'k-1');
    const outra = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-1', segredo: crypto.randomBytes(32) }] });
    assert.equal((await fluxo(p, { chaveFonte: outra })).r.motivo, 'AUTENTICACAO_INVALIDA');
    estado.chaves['k-1'] = { situacao: 'REVOGADA' };
    assert.equal((await fluxo(p)).r.motivo, 'CHAVE_REVOGADA');
    estado.lanca = true;
    const f = await fluxo(p);
    assert.equal(f.r.motivo, 'CHAVE_INDISPONIVEL');
    assert.equal(f.falso.chamadas.length, 0);
  });

  teste('OP-C04 — DIVERGÊNCIA DE IMAGENS: banco restaurado (simulado) com referência de hash diferente, referência sem imagem ou imagem sem referência falha na conferência lógica, mesmo com pacote e pg_restore ok', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    const diverge = registrosDoBanco();
    diverge.padrao[0].sha256_miniatura = H('7');
    assert.equal((await fluxo(p, { banco: clienteSimulado({ linhas: diverge }) })).r.motivo, 'IMAGEM_DIVERGENTE_DA_REFERENCIA');
    const semImagem = registrosDoBanco();
    semImagem.padrao.push({ ...semImagem.padrao[0], id: '9', sha256: H('9'), sha256_miniatura: H('8') });
    assert.equal((await fluxo(p, { banco: clienteSimulado({ linhas: semImagem }) })).r.motivo, 'REFERENCIA_SEM_IMAGEM');
    const semReferencia = registrosDoBanco();
    semReferencia.empresa = [];
    const f = await fluxo(p, { banco: clienteSimulado({ linhas: semReferencia }) });
    assert.equal(f.r.motivo, 'IMAGEM_SEM_REFERENCIA');
    assert.deepEqual([f.r.restauracaoReal, f.r.recuperavel, f.r.consistenciaLogica.contratual], [false, false, false]);
  });

  teste('OP-C05 — consulta incompleta, banco errado e conexão que cai falham fechado', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    const banco = clienteSimulado({ paginaMaior: true });
    assert.equal((await fluxo(p, { banco, consultaDeReferencias: criarAdaptadorDeReferencias({ criarConexao: () => banco, tamanhoDaPagina: 1 }) })).r.motivo, 'CONSULTA_DE_REFERENCIAS_FALHOU');
    assert.equal((await fluxo(p, { banco: clienteSimulado({ banco: 'gestao_epi' }) })).r.motivo, 'CONSULTA_DE_REFERENCIAS_FALHOU');
    assert.equal((await fluxo(p, { banco: clienteSimulado({ perdeEm: 'EMPRESA' }) })).r.motivo, 'CONSULTA_DE_REFERENCIAS_FALHOU');
  });

  teste('OP-C06 — FALHA DE SUPERVISÃO: saída não zero, morte por sinal e processo que não termina (prazos vencidos, com sinais registrados) nunca dão ok; a consulta lógica não é feita; descritor do dump fechado', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    for (const [modo, esperado] of [['saida1', ['SAIDA_NAO_ZERO']], ['sinal', ['SINAL']], ['trava', ['ENCERRAMENTO_FORCADO', 'ESTADO_INCERTO', 'SINAL', 'SAIDA_NAO_ZERO']]]) {
      const sinais = [];
      const falso = spawnSimulado({ modo });
      const banco = clienteSimulado();
      const { r } = await fluxo(p, { falso, banco, modo, sinais });
      assert.equal(r.ok, false, modo);
      assert.ok(esperado.includes(r.motivo), `${modo}: ${r.motivo}`);
      assert.equal(banco.sqls.length, 0, 'sem consulta lógica depois de falha de restauração');
      assert.throws(() => fs.fstatSync(falso.chamadas[0].opcoes.stdio[0]), (e) => e.code === 'EBADF');
      assert.ok(sinais.every((s) => ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(s)), 'só sinais permitidos');
      assert.deepEqual([r.restauracaoReal, r.recuperavel], [false, false]);
    }
  });

  teste('OP-C07 — DESTINO NÃO AUTORIZADO: banco de produção, prefixo errado, host fora da lista e política mais estrita do lançador recusam sem spawn, sem imagens e sem consulta', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    for (const destino of [{ ...DESTINO_BANCO, banco: 'gestao_epi' }, { ...DESTINO_BANCO, banco: 'gestao_epi_producao' }, { ...DESTINO_BANCO, banco: 'meu_banco' }, { ...DESTINO_BANCO, host: '10.0.0.5' }]) {
      const f = await fluxo(p, { destino });
      assert.deepEqual([f.r.ok, f.r.motivo], [false, 'DESTINO_NAO_AUTORIZADO'], destino.banco);
      assert.deepEqual([f.falso.chamadas.length, f.banco.sqls.length], [0, 0]);
      assert.equal(fs.existsSync(path.join(f.imagens.raiz, f.imagens.nome)), false);
    }
    const estrito = await fluxo(p, { politicaDoLancador: { ...POLITICA, hostsAutorizados: ['127.0.0.2'] } });
    assert.equal(estrito.r.ok, false);
    assert.equal(estrito.falso.chamadas.length, 0);
    assert.equal(estrito.banco.sqls.length, 0);
  });

  teste('OP-C08 — DUMP adulterado entre a abertura e a restauração: DUMP_DIVERGENTE e nenhum pg_restore (lançador intocado)', async () => {
    const p = await pacoteV2ComProvedor(novoEstado(), 'k-1');
    const falso = spawnSimulado();
    let n = 0;
    const rest = criarRestaurador({
      fonteDeChaves: p.fonteDeChaves,
      restauradorDoBanco: restauradorSupervisionado(falso),
      ops: { gravarImagem: async (a, c, b, o) => { n += 1; const res = await a.gravar(c, b, o); if (n === 5) { const f = path.join(p.caminho, 'dump', 'postgres.dump'); const d = fs.readFileSync(f); d[0] ^= 0xff; fs.writeFileSync(f, d); } return res; } },
    });
    const r = await rest.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO_BANCO } });
    assert.deepEqual([r.ok, r.motivo], [false, 'DUMP_DIVERGENTE']);
    assert.equal(falso.chamadas.length, 0);
  });

  teste('OP-C09 — o resultado do fluxo nunca contém segredo, caminho temporário ou texto do banco, e todos os bloqueios operacionais permanecem', async () => {
    const estado = novoEstado();
    const p = await pacoteV2ComProvedor(estado, 'k-1');
    const { r } = await fluxo(p, { banco: clienteSimulado({ falhaEm: 'EMPRESA' }) });
    const texto = JSON.stringify(r);
    for (const proibido of [estado.chaves['k-1'].segredo.toString('hex'), os.tmpdir(), 'gepi-md-test-', 'SEGREDO', '/Users/privado']) assert.equal(texto.includes(proibido), false, proibido);
    assert.ok(r.limites.includes('SEM_FONTE_OPERACIONAL_DE_CHAVES'));
    assert.ok(r.limites.includes('SEM_RESTAURACAO_OPERACIONAL_REAL'));
  });
});

// ------------------------------------------------------------------------------------------------------------------- isolamento
describe('[OP-S] isolamento estático dos módulos novos', () => {
  teste('OP-S01 — nenhum módulo novo carrega pg/dotenv/child_process no topo, lê .env, abre conexão ou usa o pool global', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    for (const nome of ['imagem-backup-consistencia-banco.service.js', 'imagem-backup-manifesto-autenticado.service.js', 'imagem-backup-restauracao-lancador.service.js']) {
      const codigo = fs.readFileSync(path.join(base, nome), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
      assert.equal(/require\('dotenv'\)|config\/database|['"]\.env['"]|process\.env\.(?!NODE_ENV)/.test(codigo), false, nome);
      // o driver `pg` nunca é carregado no topo; só o módulo de consistência o carrega, ADIADO e SÓ para `instanceof` (identidade do cliente), sem criar cliente nem pool
      assert.equal(/^(?:const|let|var)\s.*require\('pg'\)/m.test(codigo), false, `${nome}: pg não pode ser carregado no topo`);
      if (nome === 'imagem-backup-consistencia-banco.service.js') assert.equal(/new\s+(?:pg\.)?(?:Client|Pool)\s*\(|require\('pg'\)\.Pool/.test(codigo), false, 'o módulo nunca cria cliente nem pool');
      else assert.equal(/require\('pg'\)/.test(codigo), false, nome);
      assert.equal(/^const .*require\('node:child_process'\)/m.test(codigo), false, `${nome}: child_process só dentro de função`);
    }
  });

  teste('OP-S02 — o carregamento dos módulos novos em um processo limpo não abre sockets, processos nem lê o ambiente do banco', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    const lista = ['imagem-backup-consistencia-banco.service.js', 'imagem-backup-manifesto-autenticado.service.js', 'imagem-backup-restauracao-lancador.service.js', 'imagem-backup-restauracao.service.js'].map((n) => path.join(base, n));
    const script = `${lista.map((m) => `require(${JSON.stringify(m)});`).join(' ')} process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()));`;
    const filho = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 20000 });
    assert.equal(filho.status, 0, filho.stderr);
    // referência: o MESMO processo sem carregar nada (o PipeWrap do stdout capturado pelo teste existe nos dois)
    const referencia = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()))'], { cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 20000 });
    assert.deepEqual(JSON.parse(filho.stdout), JSON.parse(referencia.stdout), 'carregar os módulos não cria recurso ativo algum');
  });
});
