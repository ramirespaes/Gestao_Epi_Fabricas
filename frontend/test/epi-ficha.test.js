'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const EpiPermissoes = require('../js/permissoes-efetivas');
const F = require('../js/epi-ficha');

/**
 * Bloco 10 (10G + 10H) — Ficha de EPI e nova entrega. Módulo
 * frontend/js/epi-ficha.js sem navegador: URLs, corpo das requisições,
 * escape de HTML, rascunho da entrega, traços, idempotência, fluxo com
 * respostas fora de ordem e a página integrada (estática).
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const CPF = '52998224725';

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
function servidor(...respostas) {
  chamadas = [];
  let i = 0;
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const r = typeof respostas[0] === 'function' ? respostas[0](chamadas[chamadas.length - 1]) : respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
/** Servidor cujas respostas o teste libera na ordem que quiser. */
function servidorControlado() {
  chamadas = [];
  const pendentes = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: (url, opcoes) => new Promise((resolve, reject) => {
      const u = new URL(url);
      const chamada = { metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined };
      chamadas.push(chamada);
      pendentes.push({ chamada, responder: (status, corpo) => resolve(resposta(status, corpo)), falhar: () => reject(new Error('rede')) });
    }),
  });
  return pendentes;
}
beforeEach(() => servidor(resposta(200, { status: 'ok' })));

const permissoesDe = ({ ficha = false, entrega = false } = {}) => ({
  empresaId: 1, usuarioId: 2, perfil: 'USUARIO',
  recursos: { epiFicha: { visualizar: ficha, criar: false, editar: false, excluir: false } },
  acoes: { REALIZAR_ENTREGA: entrega },
  administracao: {},
});

const funcionario = (extra = {}) => ({ id: 5, nome: 'Ana Fictícia', matricula: 'A-001', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operadora', ativo: true, ...extra });
const material = (extra = {}) => ({ id: 30, nome: 'Botina de segurança', codigoInterno: 'BOT-01', tipo: 'Calçado', unidade: 'par', prazoUsoDias: 180, exigeTamanho: true, oculosComGrau: null, exigeCa: true, previstoNoGhe: true, ...extra });
const lote = (extra = {}) => ({ loteId: 7, tamanho: '40', caNumero: '12345', caValidade: '2099-12-31', saldo: 10, situacaoCa: 'VALIDO', ...extra });
const TRACOS = [[[10, 10], [20, 12]], [[40, 40]]];
const entregaPublica = (extra = {}) => ({
  id: 10, ficha: { id: 3, numero: 12, funcionarioId: 5 }, origem: 'DIRETA', entregueEm: '2026-09-30T14:59:00.000Z', dataOperacional: '2026-09-30',
  empresa: { nome: 'Empresa <Alfa>', cnpj: '11222333000181', endereco: 'Rua', cidade: 'Cidade', uf: 'SP' },
  trabalhador: { nome: 'Ana "Fictícia" & Cia', matricula: 'A-001', funcao: 'Operadora', setor: 'Produção' },
  ghe: { id: 2, nome: 'GHE' }, responsavel: { id: 7, nome: "O'Responsável" },
  itens: [{ id: 100, materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null, material: material(), lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' }, operacaoId: '900' }],
  confirmacao: { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-ENTREGA-V1', declaracaoTexto: 'x', confirmadaEm: '2026-09-30T14:59:00.000Z', hashConteudo: 'a'.repeat(64) },
  ...extra,
});

// ───────────────────────────────────────────────────────────────────
describe('acoes — URLs, query e corpo exatos', () => {
  test('fichas: GET com filtros codificados, sem CPF na URL; consulta por CPF vai no corpo de um POST', async () => {
    await F.acoes.listarFichas({ busca: 'Ana & Cia', numero: 3, funcionarioId: 5, materialId: 7, ativo: false, de: '2026-09-01', ate: '2026-09-30', pagina: 2, limite: 10 });
    assert.deepEqual(chamadas[0], { metodo: 'GET', caminho: '/api/fichas-epi?busca=Ana%20%26%20Cia&numero=3&funcionarioId=5&materialId=7&ativo=false&de=2026-09-01&ate=2026-09-30&pagina=2&limite=10', corpo: undefined });
    await F.acoes.listarFichas({});
    assert.equal(chamadas[1].caminho, '/api/fichas-epi?pagina=1&limite=20');
    await F.acoes.consultarFichaPorCpf(' 529.982.247-25 ');
    assert.deepEqual(chamadas[2], { metodo: 'POST', caminho: '/api/fichas-epi/consulta-cpf', corpo: { cpf: '52998224725' } });
    await F.acoes.buscarFicha(3);
    await F.acoes.listarEntregasDaFicha(3, { de: '2026-09-01', pagina: 2, limite: 5 });
    await F.acoes.buscarEntrega(10);
    assert.deepEqual(chamadas.slice(3).map((c) => c.caminho), ['/api/fichas-epi/3', '/api/fichas-epi/3/entregas?de=2026-09-01&pagina=2&limite=5', '/api/entregas-epi/10']);
  });

  test('contexto: localizar trabalhadores por nome/matrícula, por CPF no corpo, contexto, materiais e lotes', async () => {
    await F.acoes.localizarTrabalhadores({ busca: 'A-0%', pagina: 1, limite: 20 });
    await F.acoes.localizarTrabalhadorPorCpf(CPF);
    await F.acoes.contexto(5);
    await F.acoes.materiais(5, { busca: 'bot', previstoNoGhe: true, pagina: 1, limite: 20 });
    await F.acoes.lotes(5, 30);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [
      ['GET', '/api/entregas-epi/contexto/funcionarios?busca=A-0%25&pagina=1&limite=20', undefined],
      ['POST', '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF }],
      ['GET', '/api/entregas-epi/contexto/5', undefined],
      ['GET', '/api/entregas-epi/contexto/5/materiais?busca=bot&previstoNoGhe=true&pagina=1&limite=20', undefined],
      ['GET', '/api/entregas-epi/contexto/5/materiais/30/lotes', undefined],
    ]);
    for (const c of chamadas) assert.doesNotMatch(c.caminho, new RegExp(CPF));
  });

  test('registrar: POST /entregas-epi com o corpo lógico e a chave; nunca empresaId, atorId, snapshots ou timestamps', async () => {
    const corpo = { funcionarioId: 5, itens: [{ materialId: 30, loteId: 7, quantidade: 1, motivo: 'ADMISSAO' }], confirmacao: { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-ENTREGA-V1', declaracaoTexto: 'x' } };
    await F.acoes.registrar(corpo, '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c');
    assert.deepEqual(chamadas[0], { metodo: 'POST', caminho: '/api/entregas-epi', corpo: { ...corpo, chaveIdempotencia: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c' } });
    assert.deepEqual(Object.keys(chamadas[0].corpo).sort(), ['chaveIdempotencia', 'confirmacao', 'funcionarioId', 'itens']);
    await assert.rejects(EpiHttp.requisitar('POST', '/entregas-epi', { corpo: { ...corpo, empresaId: 1 } }), /empresaId/);
    await assert.rejects(EpiHttp.requisitar('POST', '/entregas-epi', { corpo: { ...corpo, atorId: 1 } }), /atorId/);
  });
});

describe('permissoes — duas capacidades independentes', () => {
  test('A) só epiFicha: consulta sim, entrega não; B) só REALIZAR_ENTREGA: entrega sim, consulta não; C) ambas; D) nenhuma', () => {
    assert.deepEqual(F.permissoes.capacidades(permissoesDe({ ficha: true })), { consultar: true, entregar: false });
    assert.deepEqual(F.permissoes.capacidades(permissoesDe({ entrega: true })), { consultar: false, entregar: true });
    assert.deepEqual(F.permissoes.capacidades(permissoesDe({ ficha: true, entrega: true })), { consultar: true, entregar: true });
    assert.deepEqual(F.permissoes.capacidades(permissoesDe()), { consultar: false, entregar: false });
    assert.deepEqual(F.permissoes.capacidades(null), { consultar: false, entregar: false });
    assert.equal(EpiPermissoes.recurso(permissoesDe({ ficha: true }), 'epiFicha', 'visualizar'), true);
    assert.equal(EpiPermissoes.acao(permissoesDe({ entrega: true }), 'REALIZAR_ENTREGA'), true);
  });
});

describe('filtros da busca de fichas', () => {
  test('monta o filtro real: busca literal, número, situação, período; período invertido e número inválido recusados; CPF separado', () => {
    assert.deepEqual(F.filtros.fichas({ busca: ' Ana ', numero: ' 12 ', ativo: 'true', de: '2026-09-01', ate: '2026-09-30' }), { ok: true, filtro: { busca: 'Ana', numero: 12, ativo: true, de: '2026-09-01', ate: '2026-09-30', pagina: 1, limite: 20 } });
    assert.deepEqual(F.filtros.fichas({}), { ok: true, filtro: { pagina: 1, limite: 20 } });
    assert.equal(F.filtros.fichas({ de: '2026-09-30', ate: '2026-09-01' }).ok, false);
    assert.equal(F.filtros.fichas({ numero: 'abc' }).ok, false);
    assert.equal(F.filtros.fichas({ de: '30/09/2026' }).ok, false);
    assert.deepEqual(F.filtros.cpf(' 529.982.247-25 '), { ok: true, cpf: CPF });
    assert.equal(F.filtros.cpf('52998224726').ok, false);
    assert.equal(F.filtros.cpf('').ok, false);
  });
});

describe('rascunho da entrega — itens, motivos, justificativas, limites', () => {
  const novo = () => F.rascunho.novo(funcionario(), { id: 2, nome: 'GHE' });
  const itemDe = (extra = {}) => ({ material: material(), lote: lote(), quantidade: 1, motivo: 'ADMISSAO', ...extra });

  test('rótulos dos motivos em português e códigos exatos da API', () => {
    assert.deepEqual(F.MOTIVOS.map((m) => m.codigo), ['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']);
    assert.equal(F.rotuloMotivo('SUBSTITUICAO_PRAZO'), 'Substituição por prazo');
    assert.equal(F.rotuloMotivo('X'), 'X');
    assert.deepEqual(F.MODOS, { DESENHO: 'Assinatura desenhada', ACEITE_PRESENCIAL: 'Aceite presencial' });
  });

  test('adiciona até 20 itens; o 21º e o lote repetido são recusados; remover libera o lote', () => {
    let r = novo();
    for (let i = 0; i < 20; i += 1) {
      const res = F.rascunho.adicionarItem(r, itemDe({ lote: lote({ loteId: 100 + i }) }));
      assert.equal(res.ok, true, `item ${i}`);
      r = res.rascunho;
    }
    assert.equal(r.itens.length, 20);
    assert.deepEqual([F.rascunho.adicionarItem(r, itemDe({ lote: lote({ loteId: 999 }) })).codigo, F.rascunho.adicionarItem(r, itemDe({ lote: lote({ loteId: 100 }) })).codigo], ['LIMITE_ITENS', 'LOTE_REPETIDO']);
    r = F.rascunho.removerItem(r, 100);
    assert.equal(r.itens.length, 19);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ lote: lote({ loteId: 100 }) })).ok, true);
  });

  test('quantidade: inteiro positivo até o saldo exibido; motivo da lista; OUTRO exige justificativa; fora do GHE exige justificativaForaGhe; previsto no GHE não aceita', () => {
    const r = novo();
    for (const quantidade of [0, -1, 1.5, '2', 11, NaN]) assert.equal(F.rascunho.adicionarItem(r, itemDe({ quantidade })).codigo, 'QUANTIDADE_INVALIDA', String(quantidade));
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ quantidade: 10 })).ok, true);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ motivo: 'TROCA' })).codigo, 'MOTIVO_INVALIDO');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ motivo: 'OUTRO' })).codigo, 'JUSTIFICATIVA_OBRIGATORIA');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ motivo: 'OUTRO', justificativa: '  Reposição extra ' })).rascunho.itens[0].justificativa, 'Reposição extra');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ justificativa: 'x'.repeat(501) })).codigo, 'JUSTIFICATIVA_INVALIDA');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ material: material({ previstoNoGhe: false }) })).codigo, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA');
    const fora = F.rascunho.adicionarItem(r, itemDe({ material: material({ previstoNoGhe: false }), justificativaForaGhe: 'Visita' }));
    assert.deepEqual([fora.ok, fora.rascunho.itens[0].justificativaForaGhe, fora.rascunho.itens[0].previstoNoGhe], [true, 'Visita', false]);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ justificativaForaGhe: 'Indevida' })).codigo, 'JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA');
  });

  test('classificação incompleta bloqueia o item; CA vencido e sem CA (material que exige) bloqueiam; vence hoje e não exige CA passam', () => {
    const r = novo();
    for (const m of [material({ prazoUsoDias: null }), material({ exigeTamanho: null }), material({ tipo: 'Óculos de proteção', oculosComGrau: null })]) {
      assert.equal(F.rascunho.adicionarItem(r, itemDe({ material: m })).codigo, 'CADASTRO_INCOMPLETO', m.nome);
      assert.equal(F.rascunho.materialCompleto(m), false);
    }
    assert.equal(F.rascunho.materialCompleto(material({ tipo: 'Óculos de proteção', oculosComGrau: false })), true);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ lote: lote({ situacaoCa: 'VENCIDO' }) })).codigo, 'CA_VENCIDO');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ lote: lote({ situacaoCa: 'SEM_CA', caNumero: null, caValidade: null }) })).codigo, 'CA_AUSENTE');
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ lote: lote({ situacaoCa: 'VENCE_HOJE' }) })).ok, true);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ material: material({ exigeCa: false }), lote: lote({ situacaoCa: 'NAO_EXIGE_CA', caNumero: null, caValidade: null }) })).ok, true);
    assert.equal(F.rascunho.adicionarItem(r, itemDe({ lote: lote({ saldo: 0 }) })).codigo, 'SEM_SALDO');
    assert.deepEqual(Object.keys(F.SITUACOES_CA).sort(), ['NAO_EXIGE_CA', 'SEM_CA', 'VALIDO', 'VENCE_HOJE', 'VENCIDO']);
    assert.deepEqual([F.SITUACOES_CA.VENCIDO.permitido, F.SITUACOES_CA.VENCE_HOJE.permitido, F.SITUACOES_CA.VENCE_HOJE.aviso, F.SITUACOES_CA.SEM_CA.permitido], [false, true, true, false]);
  });

  test('corpo da requisição: só os campos lógicos, itens na ordem do rascunho; sem item ou sem confirmação não gera corpo', () => {
    let r = novo();
    r = F.rascunho.adicionarItem(r, itemDe({ quantidade: 2 })).rascunho;
    r = F.rascunho.adicionarItem(r, itemDe({ material: material({ id: 31, nome: 'Luva', previstoNoGhe: false, exigeTamanho: false }), lote: lote({ loteId: 8, tamanho: null }), motivo: 'OUTRO', justificativa: 'Extra', justificativaForaGhe: 'Visita' })).rascunho;
    const corpo = F.rascunho.corpo(r, { modo: 'DESENHO', tracos: TRACOS });
    assert.deepEqual(corpo, {
      funcionarioId: 5,
      itens: [
        { materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO' },
        { materialId: 31, loteId: 8, quantidade: 1, motivo: 'OUTRO', justificativa: 'Extra', justificativaForaGhe: 'Visita' },
      ],
      confirmacao: { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: F.DECLARACAO.versao, declaracaoTexto: F.DECLARACAO.texto },
    });
    const aceite = F.rascunho.corpo(r, { modo: 'ACEITE_PRESENCIAL' });
    assert.deepEqual(aceite.confirmacao, { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: F.DECLARACAO.versao, declaracaoTexto: F.DECLARACAO.texto });
    assert.equal(Object.hasOwn(aceite.confirmacao, 'tracos'), false);
    assert.equal(F.rascunho.corpo(novo(), { modo: 'ACEITE_PRESENCIAL' }), null, 'sem item');
    assert.equal(F.rascunho.corpo(r, { modo: 'DESENHO', tracos: [] }), null, 'desenho vazio');
    assert.equal(F.rascunho.corpo(r, null), null, 'sem confirmação');
    assert.match(F.DECLARACAO.versao, /^[A-Z0-9][A-Z0-9._-]{0,29}$/);
    assert.ok(F.DECLARACAO.texto.length > 20 && F.DECLARACAO.texto.trim() === F.DECLARACAO.texto);
  });
});

describe('traços — normalização e limites', () => {
  test('converte coordenadas visuais para inteiros 0..10000 conforme o tamanho do canvas, com recorte nas bordas', () => {
    assert.deepEqual(F.tracos.normalizar(0, 0, 320, 160), [0, 0]);
    assert.deepEqual(F.tracos.normalizar(320, 160, 320, 160), [10000, 10000]);
    assert.deepEqual(F.tracos.normalizar(160, 40, 320, 160), [5000, 2500]);
    assert.deepEqual(F.tracos.normalizar(-5, 500, 320, 160), [0, 10000]);
    assert.deepEqual(F.tracos.normalizar(100.7, 33.3, 320, 160), [3147, 2081]);
    assert.equal(F.tracos.normalizar(1, 1, 0, 0), null);
  });

  test('coletor: traços e pontos dentro dos limites, sem coletar além deles; limpar; vazio', () => {
    const c = F.tracos.criarColetor();
    assert.equal(c.vazio(), true);
    c.iniciar(); c.ponto(1, 1, 100, 100); c.ponto(2, 2, 100, 100); c.encerrar();
    c.iniciar(); c.ponto(50, 50, 100, 100); c.encerrar();
    assert.deepEqual(c.valores(), [[[100, 100], [200, 200]], [[5000, 5000]]]);
    assert.equal(c.vazio(), false);
    c.iniciar(); c.encerrar();
    assert.equal(c.valores().length, 2, 'traço sem ponto não conta');
    for (let t = 0; t < 70; t += 1) { c.iniciar(); c.ponto(1, 1, 100, 100); c.encerrar(); }
    assert.equal(c.valores().length, F.LIMITES.tracos);
    const d = F.tracos.criarColetor();
    d.iniciar();
    for (let p = 0; p < 2000; p += 1) d.ponto(p % 100, p % 100, 100, 100);
    d.encerrar();
    assert.equal(d.valores()[0].length, F.LIMITES.pontos);
    assert.deepEqual([F.LIMITES.tracos, F.LIMITES.pontos, F.LIMITES.coordenada], [64, 1500, 10000]);
    d.limpar();
    assert.deepEqual([d.vazio(), d.valores()], [true, []]);
  });

  test('instalar no canvas é idempotente: várias aberturas do modal não duplicam ouvintes; um gesto físico gera um traço', () => {
    const ouvintes = {};
    const canvas = {
      width: 300, height: 150,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 150 }),
      addEventListener: (tipo, fn) => { (ouvintes[tipo] = ouvintes[tipo] || []).push(fn); },
      setPointerCapture: () => {}, releasePointerCapture: () => {},
      getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} }),
    };
    const coletor = F.tracos.criarColetor();
    const primeira = F.assinatura.instalar(canvas, coletor);
    const segunda = F.assinatura.instalar(canvas, coletor);
    const terceira = F.assinatura.instalar(canvas, coletor);
    assert.equal(primeira, segunda);
    assert.equal(segunda, terceira);
    for (const tipo of Object.keys(ouvintes)) assert.equal(ouvintes[tipo].length, 1, tipo);
    const evento = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, preventDefault() {}, isPrimary: true });
    ouvintes.pointerdown[0](evento(10, 20));
    ouvintes.pointermove[0](evento(160, 95));
    ouvintes.pointerup[0](evento(160, 95));
    assert.deepEqual(coletor.valores(), [[[0, 0], [5000, 5000]]]);
    ouvintes.pointermove[0](evento(300, 100));
    assert.equal(coletor.valores().length, 1, 'movimento sem pressionar não desenha');
  });
});

describe('idempotência do frontend', () => {
  test('gera UUID v4 válido e reutiliza a chave enquanto o corpo lógico for o mesmo; corpo diferente gera chave nova', () => {
    const chave = F.idempotencia.gerar();
    assert.match(chave, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(chave, F.idempotencia.gerar());
    const estado = F.idempotencia.novoEstado();
    const corpoA = { funcionarioId: 5, itens: [{ materialId: 30, loteId: 7, quantidade: 1, motivo: 'ADMISSAO' }], confirmacao: { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'V1', declaracaoTexto: 'x' } };
    const k1 = F.idempotencia.chavePara(estado, corpoA);
    const k2 = F.idempotencia.chavePara(estado, JSON.parse(JSON.stringify(corpoA)));
    assert.equal(k1, k2, 'mesmo conteúdo, mesma chave (inclusive após falha de rede)');
    const k3 = F.idempotencia.chavePara(estado, { ...corpoA, itens: [{ ...corpoA.itens[0], quantidade: 2 }] });
    assert.notEqual(k3, k1, 'conteúdo diferente, chave nova');
    const k4 = F.idempotencia.chavePara(estado, corpoA);
    assert.notEqual(k4, k1, 'voltar ao conteúdo anterior é nova tentativa lógica');
  });
});

describe('mensagens', () => {
  test('sessão encerrada em 401; códigos estáveis do serviço viram mensagens amigáveis; falha de rede é incerta; nada técnico vaza', () => {
    assert.equal(F.mensagens.exigeNovoLogin({ ok: false, status: 401, codigo: 'SESSAO_INVALIDA' }), true);
    assert.equal(F.mensagens.exigeNovoLogin({ ok: false, status: 403 }), false);
    const codigos = ['IDEMPOTENCIA_CONFLITO', 'FUNCIONARIO_INATIVO', 'MATERIAL_INATIVO', 'MATERIAL_PRAZO_NAO_CLASSIFICADO', 'MATERIAL_TAMANHO_NAO_CLASSIFICADO', 'MATERIAL_OCULOS_NAO_CLASSIFICADO', 'LOTE_NAO_ENCONTRADO', 'LOTE_MATERIAL_DIVERGENTE', 'LOTE_SEM_TAMANHO', 'CA_AUSENTE', 'CA_VENCIDO', 'SALDO_INSUFICIENTE', 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', 'JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA', 'FUNCIONARIO_NAO_ENCONTRADO', 'FICHA_NAO_ENCONTRADA', 'ENTREGA_NAO_ENCONTRADA', 'PERMISSAO_NEGADA', 'VALIDACAO'];
    const textos = new Set();
    for (const codigo of codigos) {
      const texto = F.mensagens.erro({ ok: false, status: 409, codigo, mensagem: 'detalhe técnico interno' });
      assert.ok(typeof texto === 'string' && texto.length > 10, codigo);
      assert.doesNotMatch(texto, /técnico|SQL|constraint|stack/i);
      textos.add(texto);
    }
    assert.ok(textos.size >= 12, 'mensagens distintas por situação');
    assert.equal(F.mensagens.erro({ ok: false, status: 0, codigo: 'FALHA_DE_REDE' }), F.mensagens.MSG.INCERTA);
    assert.match(F.mensagens.MSG.INCERTA, /Não foi possível confirmar/);
    assert.match(F.mensagens.MSG.REPLAY, /já havia sido registrada/);
    assert.match(F.mensagens.erro({ ok: false, status: 500, codigo: 'ERRO_INTERNO', mensagem: 'x' }), /Tente novamente/);
  });
});

describe('render — HTML escapado', () => {
  test('escaparHtml cobre < > & " \' e valores nulos', () => {
    assert.equal(F.render.escaparHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(F.render.escaparHtml(null), '');
  });

  test('linhas da busca de fichas: número, trabalhador, matrícula, situação, totais, última entrega e ação Abrir; nomes perigosos escapados', () => {
    const html = F.render.linhasFichas([{
      id: 3, numero: 12, criadaEm: '2026-09-30T12:00:00.000Z',
      funcionarioAtual: { id: 5, nome: '<img src=x onerror=alert(1)>', matricula: 'A"001', cpfMascarado: '***.***.***-25', setor: 'P', funcao: 'O', ativo: false },
      resumo: { totalEntregas: 3, totalItens: 7, ultimaEntregaEm: '2026-09-30T14:59:00.000Z' },
    }]);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /A&quot;001/);
    assert.match(html, /data-abrir="3"/);
    assert.match(html, /Inativo/);
    assert.match(html, />3<\/td>[\s\S]*>7<\/td>/);
    assert.match(html, /30\/09\/2026/);
    assert.doesNotMatch(html, /Pendente|Assinado|Aceite digital/);
  });

  test('linhas do histórico: uma linha por item, agrupadas por entrega, com data, material histórico, tamanho, CA, validade, quantidade, motivo, GHE, responsável e modo; sem saldo, IP, dispositivo ou hash da requisição', () => {
    const e = entregaPublica({ itens: [
      { id: 100, materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null, material: material({ nome: 'Botina <b>' }), lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' }, operacaoId: '900' },
      { id: 101, materialId: 31, loteId: 8, quantidade: 1, motivo: 'OUTRO', justificativa: 'Extra', previstoNoGhe: false, justificativaForaGhe: 'Visita', material: material({ nome: 'Luva', exigeCa: false }), lote: { tamanho: null, caNumero: null, caValidade: null }, operacaoId: '901' },
    ] });
    const html = F.render.linhasHistorico([e]);
    assert.equal((html.match(/<tr/g) || []).length, 2);
    assert.match(html, /data-entrega="10"/);
    assert.match(html, /Botina &lt;b&gt;/);
    assert.match(html, /Assinatura desenhada/);
    assert.match(html, /Admissão/);
    assert.match(html, /Outro/);
    assert.match(html, /O&#39;Responsável/);
    assert.match(html, /31\/12\/2099/);
    assert.match(html, /Fora do GHE/);
    assert.doesNotMatch(html, /saldo|requisicaoHash|dispositivo|203\.0\.113|Pendente|biometri|impressão digital/i);
    const aceite = F.render.linhasHistorico([entregaPublica({ id: 11, confirmacao: { ...entregaPublica().confirmacao, modo: 'ACEITE_PRESENCIAL', tracos: null } })]);
    assert.match(aceite, /Aceite presencial/);
    assert.equal(F.render.linhasHistorico([]), '');
  });

  test('cabeçalho da ficha: cadastro atual separado do histórico; lotes e materiais do contexto com situação e cadastro incompleto; trabalhadores com CPF mascarado', () => {
    const cab = F.render.cabecalhoFicha({ ficha: { id: 3, numero: 12, criadaEm: '2026-09-30T12:00:00.000Z' }, funcionarioAtual: { ...funcionario({ nome: 'Ana & Cia' }), ghe: { id: 2, nome: 'GHE <1>' } }, resumo: { totalEntregas: 2, totalItens: 3, ultimaEntregaEm: null } });
    assert.match(cab.nome, /Ana &amp; Cia/);
    assert.match(cab.ghe, /GHE &lt;1&gt;/);
    assert.equal(cab.numero, 'Ficha nº 12');
    const lotes = F.render.linhasLotes([lote(), lote({ loteId: 8, situacaoCa: 'VENCIDO', caValidade: '2020-01-01' }), lote({ loteId: 9, situacaoCa: 'VENCE_HOJE' })], material());
    assert.match(lotes, /data-lote="7"/);
    assert.match(lotes, /CA vencido/);
    assert.match(lotes, /disabled/);
    assert.match(lotes, /vence hoje/i);
    const materiais = F.render.linhasMateriais([material(), material({ id: 31, nome: 'Capacete', prazoUsoDias: null, previstoNoGhe: false })]);
    assert.match(materiais, /Cadastro incompleto/);
    assert.match(materiais, /Fora do GHE/);
    assert.match(materiais, /Previsto no GHE/);
    const trabalhadores = F.render.linhasTrabalhadores([{ ...funcionario({ nome: 'X <y>' }), ghe: null }]);
    assert.match(trabalhadores, /X &lt;y&gt;/);
    assert.match(trabalhadores, /\*\*\*\.\*\*\*\.\*\*\*-25/);
    assert.match(trabalhadores, /data-funcionario="5"/);
  });
});

describe('fluxo da nova entrega — respostas fora de ordem, duplo clique, 201, replay, erros', () => {
  const corpoBase = () => {
    let r = F.rascunho.novo(funcionario(), null);
    r = F.rascunho.adicionarItem(r, { material: material(), lote: lote(), quantidade: 1, motivo: 'ADMISSAO' }).rascunho;
    return r;
  };

  test('selecionar trabalhador A e depois B: a resposta atrasada de A não substitui B', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    const pA = fluxo.selecionarTrabalhador(5);
    const pB = fluxo.selecionarTrabalhador(6);
    assert.equal(pendentes.length, 2);
    pendentes[1].responder(200, { status: 'ok', funcionario: funcionario({ id: 6, nome: 'Bruno' }), ghe: null, ficha: null });
    await pB;
    pendentes[0].responder(200, { status: 'ok', funcionario: funcionario({ id: 5 }), ghe: { id: 2, nome: 'GHE' }, ficha: { id: 3, numero: 1 } });
    const rA = await pA;
    assert.deepEqual([rA.descartada, fluxo.estado().trabalhador.id, fluxo.estado().trabalhador.nome], [true, 6, 'Bruno']);
  });

  test('trocar material enquanto os lotes carregam: só os lotes do material atual entram no estado', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    const p30 = fluxo.selecionarMaterial(material());
    const p31 = fluxo.selecionarMaterial(material({ id: 31, nome: 'Luva' }));
    pendentes[1].responder(200, { status: 'ok', material: { id: 31 }, lotes: [lote({ loteId: 8 })] });
    await p31;
    pendentes[0].responder(200, { status: 'ok', material: { id: 30 }, lotes: [lote({ loteId: 7 })] });
    await p30;
    assert.deepEqual([fluxo.estado().material.id, fluxo.estado().lotes.map((l) => l.loteId)], [31, [8]]);
  });

  test('trabalhador inativo não pode continuar; 404 vira mensagem amigável', async () => {
    servidor(resposta(409, { status: 'error', codigo: 'FUNCIONARIO_INATIVO', message: 'x' }));
    const fluxo = F.fluxo.criar();
    const r = await fluxo.selecionarTrabalhador(5);
    assert.deepEqual([r.ok, r.codigo, fluxo.estado().trabalhador], [false, 'FUNCIONARIO_INATIVO', null]);
    assert.match(r.mensagem, /inativo/i);
  });

  test('confirmar: um clique só envia um POST enquanto o anterior está pendente; 201 limpa o rascunho e devolve a entrega; a chave é a mesma na repetição do mesmo conteúdo', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    fluxo.substituirRascunho(corpoBase());
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    const p1 = fluxo.confirmar();
    const p2 = fluxo.confirmar();
    assert.equal(pendentes.length, 1, 'segundo clique não envia');
    assert.equal(fluxo.estado().enviando, true);
    const r2 = await p2;
    assert.deepEqual([r2.ok, r2.codigo], [false, 'ENVIO_EM_ANDAMENTO']);
    assert.equal(fluxo.adicionarItem({ material: material({ id: 31 }), lote: lote({ loteId: 8 }), quantidade: 1, motivo: 'ADMISSAO' }).codigo, 'ENVIO_EM_ANDAMENTO', 'conteúdo congelado enquanto o POST está em voo');
    const chave = pendentes[0].chamada.corpo.chaveIdempotencia;
    pendentes[0].responder(201, { status: 'ok', repetida: false, entrega: entregaPublica() });
    const r1 = await p1;
    assert.deepEqual([r1.ok, r1.repetida, r1.entrega.id, fluxo.estado().rascunho.itens.length, fluxo.estado().enviando], [true, false, 10, 0, false]);
    assert.match(chave, /^[0-9a-f-]{36}$/);
  });

  test('falha de rede mantém corpo e chave; tentar novamente reenvia o MESMO corpo com a MESMA chave; mudar o conteúdo troca a chave', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    fluxo.substituirRascunho(corpoBase());
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    const p1 = fluxo.confirmar();
    pendentes[0].falhar();
    const r1 = await p1;
    assert.deepEqual([r1.ok, r1.incerta, r1.mensagem], [false, true, F.mensagens.MSG.INCERTA]);
    assert.equal(fluxo.estado().rascunho.itens.length, 1, 'rascunho preservado');
    const p2 = fluxo.tentarNovamente();
    assert.deepEqual(pendentes[1].chamada.corpo, pendentes[0].chamada.corpo, 'mesmo corpo e mesma chave');
    pendentes[1].responder(200, { status: 'ok', repetida: true, entrega: entregaPublica() });
    const r2 = await p2;
    assert.deepEqual([r2.ok, r2.repetida, r2.mensagem], [true, true, F.mensagens.MSG.REPLAY]);
    fluxo.substituirRascunho(corpoBase());
    fluxo.alterarQuantidade(7, 3);
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    const p3 = fluxo.confirmar();
    assert.notEqual(pendentes[2].chamada.corpo.chaveIdempotencia, pendentes[0].chamada.corpo.chaveIdempotencia);
    pendentes[2].responder(201, { status: 'ok', repetida: false, entrega: entregaPublica() });
    await p3;
  });

  test('409 SALDO_INSUFICIENTE pede recarga dos lotes; 400/401/403/404 chegam com código e mensagem; 401 é sessão encerrada', async () => {
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    for (const [status, codigo, esperado] of [
      [409, 'SALDO_INSUFICIENTE', /saldo/i], [400, 'VALIDACAO', /dados/i], [403, 'PERMISSAO_NEGADA', /permiss/i], [404, 'FUNCIONARIO_NAO_ENCONTRADO', /encontrado/i], [409, 'IDEMPOTENCIA_CONFLITO', /chave|tentativa/i],
    ]) {
      servidor(resposta(status, { status: 'error', codigo, message: 'x', detalhes: [] }));
      fluxo.substituirRascunho(corpoBase());
      fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
      const r = await fluxo.confirmar();
      assert.deepEqual([r.ok, r.codigo, r.status], [false, codigo, status]);
      assert.match(r.mensagem, esperado, codigo);
      assert.equal(r.recarregarLotes, codigo === 'SALDO_INSUFICIENTE');
      assert.equal(fluxo.estado().rascunho.itens.length, 1, 'rascunho preservado em erro');
    }
    servidor(resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' }));
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    const r = await fluxo.confirmar();
    assert.deepEqual([r.ok, r.sessaoEncerrada], [false, true]);
  });

  test('consulta da ficha: abrir A e depois B — só B toca o estado; listagem paginada usa os filtros', async () => {
    const pendentes = servidorControlado();
    const consulta = F.consulta.criar();
    const pA = consulta.abrir(3);
    const pB = consulta.abrir(4);
    assert.deepEqual(pendentes.map((p) => p.chamada.caminho), ['/api/fichas-epi/3', '/api/fichas-epi/4']);
    pendentes[1].responder(200, { status: 'ok', ficha: { id: 4, numero: 2, criadaEm: 'x' }, funcionarioAtual: funcionario({ id: 6 }), resumo: { totalEntregas: 1, totalItens: 1, ultimaEntregaEm: null } });
    await pB;
    assert.equal(pendentes[2].chamada.caminho, '/api/fichas-epi/4/entregas?pagina=1&limite=20');
    pendentes[2].responder(200, { status: 'ok', ficha: { id: 4, numero: 2 }, entregas: [entregaPublica({ id: 20, ficha: { id: 4, numero: 2, funcionarioId: 6 } })], total: 1, pagina: 1, limite: 20 });
    await consulta.pendente();
    pendentes[0].responder(200, { status: 'ok', ficha: { id: 3, numero: 1, criadaEm: 'x' }, funcionarioAtual: funcionario(), resumo: { totalEntregas: 0, totalItens: 0, ultimaEntregaEm: null } });
    const rA = await pA;
    assert.deepEqual([rA.descartada, consulta.estado().ficha.id, consulta.estado().entregas.map((e) => e.id)], [true, 4, [20]]);
  });
});

// ───────────────────────────────────────────────────────────────────
// Correções: confirmação presa ao conteúdo, tentativa incerta congela o
// corpo, troca de trabalhador invalida consultas pendentes
// ───────────────────────────────────────────────────────────────────
const rascunhoComItem = (func, extraItem = {}) => F.rascunho.adicionarItem(
  F.rascunho.novo(func, null), { material: material(), lote: lote(), quantidade: 1, motivo: 'ADMISSAO', ...extraItem },
).rascunho;
const contextoDe = (func) => ({ status: 'ok', funcionario: func, ghe: null, ficha: null });
const fluxoComItem = () => {
  const fluxo = F.fluxo.criar();
  fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
  fluxo.substituirRascunho(rascunhoComItem(funcionario()));
  return fluxo;
};
const segundoItem = () => ({ material: material({ id: 31, nome: 'Luva' }), lote: lote({ loteId: 8 }), quantidade: 1, motivo: 'ADMISSAO' });

describe('confirmação vinculada ao conteúdo lógico da entrega', () => {
  test('DESENHO capturado para o trabalhador A é invalidado ao trocar para B; registrar exige nova confirmação e os traços antigos nunca saem', async () => {
    const fluxo = fluxoComItem();
    assert.equal(fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: TRACOS }).ok, true);
    assert.deepEqual([fluxo.estado().confirmacao.modo, fluxo.estado().confirmacao.tracos], ['DESENHO', TRACOS]);
    fluxo.definirTrabalhador({ funcionario: funcionario({ id: 6, nome: 'Bruno' }), ghe: null, ficha: null });
    assert.equal(fluxo.estado().confirmacao, null, 'trocar trabalhador invalida a confirmação');
    fluxo.substituirRascunho(rascunhoComItem(funcionario({ id: 6, nome: 'Bruno' })));
    const r = await fluxo.confirmar();
    assert.deepEqual([r.ok, r.codigo, chamadas.length], [false, 'CONFIRMACAO_AUSENTE', 0]);
  });

  test('ACEITE_PRESENCIAL é invalidado ao trocar de trabalhador pela seleção real', async () => {
    servidor(resposta(200, contextoDe(funcionario({ id: 6, nome: 'Bruno' }))));
    const fluxo = fluxoComItem();
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    assert.equal(fluxo.estado().confirmacao.modo, 'ACEITE_PRESENCIAL');
    await fluxo.selecionarTrabalhador(6);
    assert.deepEqual([fluxo.estado().trabalhador.id, fluxo.estado().confirmacao], [6, null]);
  });

  test('adicionar item depois da confirmação invalida a confirmação', () => {
    const fluxo = fluxoComItem();
    fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: TRACOS });
    assert.equal(fluxo.adicionarItem(segundoItem()).ok, true);
    assert.deepEqual([fluxo.estado().rascunho.itens.length, fluxo.estado().confirmacao], [2, null]);
  });

  test('remover item depois da confirmação invalida a confirmação', () => {
    const fluxo = fluxoComItem();
    fluxo.adicionarItem(segundoItem());
    fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' });
    fluxo.removerItem(8);
    assert.deepEqual([fluxo.estado().rascunho.itens.length, fluxo.estado().confirmacao], [1, null]);
  });

  test('alterar a quantidade de um item já adicionado invalida a confirmação', () => {
    const fluxo = fluxoComItem();
    fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: TRACOS });
    fluxo.alterarQuantidade(7, 3);
    assert.deepEqual([fluxo.estado().rascunho.itens[0].quantidade, fluxo.estado().confirmacao], [3, null]);
  });

  test('depois da invalidação, registrar exige nova confirmação; a nova confirmação é a única que vai no POST', async () => {
    const pendentes = servidorControlado();
    const fluxo = fluxoComItem();
    fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: TRACOS });
    fluxo.adicionarItem(segundoItem());
    const recusa = await fluxo.confirmar();
    assert.deepEqual([recusa.ok, recusa.codigo, pendentes.length], [false, 'CONFIRMACAO_AUSENTE', 0]);
    const novos = [[[1, 1], [2, 2]]];
    assert.equal(fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: novos }).ok, true);
    const p = fluxo.confirmar();
    assert.equal(pendentes.length, 1);
    assert.deepEqual(pendentes[0].chamada.corpo.confirmacao.tracos, novos);
    assert.equal(pendentes[0].chamada.corpo.itens.length, 2);
    pendentes[0].responder(201, { status: 'ok', repetida: false, entrega: entregaPublica() });
    const r = await p;
    assert.deepEqual([r.ok, fluxo.estado().confirmacao], [true, null]);
  });

  test('confirmação só existe no estado: confirmar() não aceita traços passados por fora, e sem item ou sem trabalhador não há confirmação', async () => {
    const fluxo = fluxoComItem();
    fluxo.definirTrabalhador({ funcionario: funcionario({ id: 6, nome: 'Bruno' }), ghe: null, ficha: null });
    fluxo.substituirRascunho(rascunhoComItem(funcionario({ id: 6, nome: 'Bruno' })));
    const r = await fluxo.confirmar({ modo: 'DESENHO', tracos: TRACOS });
    assert.deepEqual([r.ok, chamadas.length], [false, 0], 'traços de A não podem ir para B por fora do estado');
    const vazio = F.fluxo.criar();
    assert.equal(vazio.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' }).ok, false);
    vazio.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    assert.equal(vazio.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' }).ok, false, 'sem item não há o que confirmar');
    assert.equal(vazio.definirConfirmacao({ modo: 'DESENHO', tracos: [] }).ok, false);
  });
});

describe('tentativa incerta congela o corpo até a resposta do retry', () => {
  const enviarComAceite = (fluxo) => {
    assert.equal(fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' }).ok, true);
    return fluxo.confirmar();
  };

  test('falha de rede marca a tentativa como incerta; nada muda o rascunho, o trabalhador ou envia outro corpo até o retry responder', async () => {
    const pendentes = servidorControlado();
    const fluxo = fluxoComItem();
    const p1 = enviarComAceite(fluxo);
    pendentes[0].falhar();
    const r1 = await p1;
    assert.deepEqual([r1.ok, r1.incerta, r1.mensagem], [false, true, F.mensagens.MSG.INCERTA]);
    assert.ok(fluxo.estado().tentativaIncerta, 'tentativa marcada como incerta');
    const antes = JSON.stringify([fluxo.estado().rascunho, fluxo.estado().trabalhador]);

    const rAdd = fluxo.adicionarItem(segundoItem());
    const rRem = fluxo.removerItem(7);
    const rQtd = fluxo.alterarQuantidade(7, 3);
    const rDef = fluxo.definirTrabalhador({ funcionario: funcionario({ id: 6 }), ghe: null, ficha: null });
    const rSel = await fluxo.selecionarTrabalhador(6);
    const rConf = fluxo.definirConfirmacao({ modo: 'DESENHO', tracos: TRACOS });
    const rEnv = await fluxo.confirmar();
    const rLimpar = fluxo.limpar();
    for (const [nome, r] of Object.entries({ rAdd, rRem, rQtd, rDef, rSel, rConf, rEnv, rLimpar })) {
      assert.deepEqual([r.ok, r.codigo], [false, 'TENTATIVA_INCERTA_PENDENTE'], nome);
    }
    assert.equal(JSON.stringify([fluxo.estado().rascunho, fluxo.estado().trabalhador]), antes, 'rascunho e trabalhador intactos');
    assert.equal(pendentes.length, 1, 'nenhuma requisição além da tentativa original (nem contexto de B)');

    const p2 = fluxo.tentarNovamente();
    assert.equal(pendentes.length, 2);
    assert.deepEqual(pendentes[1].chamada.corpo, pendentes[0].chamada.corpo, 'retry: exatamente o mesmo corpo e a mesma chave');
    pendentes[1].responder(200, { status: 'ok', repetida: true, entrega: entregaPublica() });
    const r2 = await p2;
    assert.deepEqual([r2.ok, r2.repetida, fluxo.estado().tentativaIncerta], [true, true, null]);

    fluxo.substituirRascunho(rascunhoComItem(funcionario()));
    const p3 = enviarComAceite(fluxo);
    assert.notEqual(pendentes[2].chamada.corpo.chaveIdempotencia, pendentes[0].chamada.corpo.chaveIdempotencia, 'entrega posterior: chave nova');
    pendentes[2].responder(201, { status: 'ok', repetida: false, entrega: entregaPublica() });
    assert.equal((await p3).ok, true);
  });

  test('resposta definitiva do retry (409) também encerra a incerteza: o rascunho fica editável para correção', async () => {
    const pendentes = servidorControlado();
    const fluxo = fluxoComItem();
    const p1 = enviarComAceite(fluxo);
    pendentes[0].falhar();
    await p1;
    assert.deepEqual([fluxo.adicionarItem(segundoItem()).ok, fluxo.estado().rascunho.itens.length], [false, 1]);
    const p2 = fluxo.tentarNovamente();
    pendentes[1].responder(409, { status: 'error', codigo: 'SALDO_INSUFICIENTE', message: 'x' });
    const r2 = await p2;
    assert.deepEqual([r2.ok, r2.codigo, r2.recarregarLotes, fluxo.estado().tentativaIncerta], [false, 'SALDO_INSUFICIENTE', true, null]);
    assert.deepEqual([fluxo.adicionarItem(segundoItem()).ok, fluxo.estado().rascunho.itens.length], [true, 2]);
  });

  test('erro definitivo na primeira tentativa não cria incerteza; tentar novamente sem tentativa incerta é recusado', async () => {
    servidor(resposta(409, { status: 'error', codigo: 'IDEMPOTENCIA_CONFLITO', message: 'x' }));
    const fluxo = fluxoComItem();
    const r1 = await enviarComAceite(fluxo);
    assert.deepEqual([r1.ok, r1.incerta, fluxo.estado().tentativaIncerta], [false, false, null]);
    const r2 = await fluxo.tentarNovamente();
    assert.deepEqual([r2.ok, r2.codigo, chamadas.length], [false, 'SEM_TENTATIVA', 1]);
  });

  test('limpar durante tentativa incerta só com descarte explícito (encerramento da sessão)', async () => {
    const pendentes = servidorControlado();
    const fluxo = fluxoComItem();
    const p1 = enviarComAceite(fluxo);
    pendentes[0].falhar();
    await p1;
    assert.equal(fluxo.limpar().codigo, 'TENTATIVA_INCERTA_PENDENTE');
    assert.equal(fluxo.estado().rascunho.itens.length, 1);
    assert.equal(fluxo.limpar({ descartarTentativaIncerta: true }).ok, true);
    assert.deepEqual([fluxo.estado().rascunho, fluxo.estado().tentativaIncerta, fluxo.estado().trabalhador], [null, null, null]);
  });
});

describe('troca de trabalhador invalida materiais e lotes pendentes', () => {
  test('lotes e materiais de A pendentes chegam depois do contexto de B: descartados; material, lotes, materiais e totalMateriais de B ficam limpos', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    const pMateriais = fluxo.carregarMateriais({ pagina: 1, limite: 20 });
    const pLotes = fluxo.selecionarMaterial(material());
    const pB = fluxo.selecionarTrabalhador(6);
    assert.deepEqual(pendentes.map((p) => p.chamada.caminho), [
      '/api/entregas-epi/contexto/5/materiais?pagina=1&limite=20', '/api/entregas-epi/contexto/5/materiais/30/lotes', '/api/entregas-epi/contexto/6',
    ]);
    pendentes[2].responder(200, contextoDe(funcionario({ id: 6, nome: 'Bruno' })));
    await pB;
    pendentes[1].responder(200, { status: 'ok', material: { id: 30 }, lotes: [lote()] });
    pendentes[0].responder(200, { status: 'ok', materiais: [material()], total: 5, pagina: 1, limite: 20 });
    const [rM, rL] = await Promise.all([pMateriais, pLotes]);
    assert.deepEqual([rM.descartada, rL.descartada], [true, true]);
    const e = fluxo.estado();
    assert.deepEqual([e.trabalhador.id, e.material, e.lotes, e.materiais, e.totalMateriais], [6, null, [], [], 0]);
  });

  test('a seleção de B já invalida as consultas de A, mesmo antes de o contexto de B responder', async () => {
    const pendentes = servidorControlado();
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    const pLotes = fluxo.selecionarMaterial(material());
    const pB = fluxo.selecionarTrabalhador(6);
    pendentes[0].responder(200, { status: 'ok', material: { id: 30 }, lotes: [lote()] });
    const rL = await pLotes;
    assert.deepEqual([rL.descartada, fluxo.estado().lotes], [true, []]);
    pendentes[1].responder(200, contextoDe(funcionario({ id: 6, nome: 'Bruno' })));
    await pB;
    assert.deepEqual([fluxo.estado().trabalhador.id, fluxo.estado().material, fluxo.estado().lotes], [6, null, []]);
  });

  test('materiais já carregados de A (total 5) não permanecem depois de definir B', async () => {
    servidor(resposta(200, { status: 'ok', materiais: [material()], total: 5, pagina: 1, limite: 20 }));
    const fluxo = F.fluxo.criar();
    fluxo.definirTrabalhador({ funcionario: funcionario(), ghe: null, ficha: null });
    await fluxo.carregarMateriais({ pagina: 1, limite: 20 });
    assert.deepEqual([fluxo.estado().materiais.length, fluxo.estado().totalMateriais], [1, 5]);
    fluxo.definirTrabalhador({ funcionario: funcionario({ id: 6 }), ghe: null, ficha: null });
    assert.deepEqual([fluxo.estado().materiais, fluxo.estado().totalMateriais, fluxo.estado().material, fluxo.estado().lotes], [[], 0, null, []]);
  });
});

describe('página integrada — epi-ficha.html (estático)', () => {
  const html = ler('pages/epi-ficha.html');

  test('carrega os módulos reais na ordem e não carrega db-api.js, main.js nem xlsx de CDN', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/epi-ficha.js']);
    for (const proibido of [/db-api\.js/, /main\.js/, /xlsx/i, /cdn\.jsdelivr/]) assert.doesNotMatch(html, proibido);
  });

  test('sem login próprio, quiosque, dados fictícios, EPI_RECORDS, biometria/impressão digital, localStorage da empresa ou onclick para funções antigas', () => {
    for (const proibido of [
      /loginScreen/, /doLogin/, /loginPanel/, /recoverPanel/, /biometric/i, /fingerprint/, /impress[ãa]o digital/i, /biometri/i, /kiosk/i, /Cobresul/i,
      /EPI_RECORDS/, /EPI_NEXT/, /CURRENT_USER/, /epi_db_v2/, /EpiAPI/, /loadFichaFromAPI/, /buscarFichasAPI/, /assinarEntregaAPI/,
      /Tício de Tal/, /Fulano de Tal/, /Beltrana/, /MAT-000171/, /\*\*\*\.\*\*\*\.789-45/, /RAMIRES \/ COBRESUL/, /Joinville/,
      /localStorage/, /sessionStorage/, /document\.cookie/, /epi-ficha-empresa/, /Editar empresa/, /openFichaEmpresaModal/, /epiFichaGeneratePDF/,
      /onclick="openSignatureModal/, /onclick="setModoAssinatura/, /onmousedown="startDigitalPress/, /onclick="renderFichaSearch/, /onclick="addNovoEpiNaFicha/,
      /showView\(/, /setActiveNav/, /data-page=/, /Status de assinatura/, />Pendente</, /Aceite digital/, /Não sabe assinar — usar digital/,
    ]) {
      assert.doesNotMatch(html, proibido, String(proibido));
    }
  });

  test('sessão real (telaSessao + EpiSessaoEmpresarial), permissões avaliadas diretamente (epiFicha.visualizar e REALIZAR_ENTREGA), menu com data-pagina e as duas confirmações com os nomes corretos', () => {
    for (const exigido of [
      /id="telaSessao"/, /EpiSessaoEmpresarial\.montar/, /EpiPermissoes\.carregar|EpiPermissoes\.recurso/, /'epiFicha'/, /REALIZAR_ENTREGA/,
      /EpiHttp\.configurar\(\{ baseUrl: window\.SAFEWORK_PORTAL_API_BASE_URL \}\)/, /data-pagina="employeeHistory"/, /\.\.\/portal\/inicio\.html/,
      /Assinatura desenhada/, /Aceite presencial/, /id="btnNovaEntrega"/, /<canvas id="assinaturaCanvas"/, /id="fichaSearchBody"/, /id="fichaEpiTableBody"/,
    ]) {
      assert.match(html, exigido, String(exigido));
    }
    assert.doesNotMatch(html, /\bfetch\(/);
  });

  test('a confirmação vive no estado do fluxo: a página captura com definirConfirmacao, registra com confirmar() sem argumento e não guarda traços em variável própria', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.match(script, /fluxo\.definirConfirmacao\(\{ modo: 'DESENHO', tracos: coletor\.valores\(\) \}\)/);
    assert.match(script, /fluxo\.definirConfirmacao\(\{ modo: 'ACEITE_PRESENCIAL' \}\)/);
    assert.match(script, /fluxo\.limparConfirmacao\(\)/);
    assert.match(script, /fluxo\.confirmar\(\)/);
    assert.doesNotMatch(script, /fluxo\.confirmar\([^)]/, 'confirmar nunca recebe traços da página');
    assert.doesNotMatch(script, /tracosConfirmados|confirmacaoDaTela/);
    assert.match(script, /fluxo\.limpar\(\{ descartarTentativaIncerta: true \}\)/, 'só o encerramento da sessão descarta uma tentativa incerta');
    assert.equal((script.match(/descartarTentativaIncerta/g) || []).length, 1);
  });
});

// ───────────────────────────────────────────────────────────────────
// 10I + 10J — Ficha de EPI oficial: fluxo central de páginas, menus,
// Portal, editor de permissões, escopo do MASTER e publicação
// ───────────────────────────────────────────────────────────────────
const vm = require('node:vm');
const G = require('../js/grupo-permissoes');
const { ESCOPO_PROVISIONAMENTO_MASTER, RECURSOS_CONHECIDOS } = require('../../backend/src/rbac/recursos');

const NENHUMA_OP = { visualizar: false, criar: false, editar: false, excluir: false };
function permissoesDaEmpresa({ ficha = false, entrega = false, perfil = 'USUARIO' } = {}) {
  const recursos = {};
  for (const r of RECURSOS_CONHECIDOS) recursos[r] = { ...NENHUMA_OP };
  recursos.epiFicha = { ...NENHUMA_OP, visualizar: ficha };
  const area = { consultar: false, alterar: false };
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos, acoes: { MOVIMENTAR_ESTOQUE: false, REALIZAR_ENTREGA: entrega },
    administracao: { gruposAcesso: area, permissoesGrupo: area, vinculosGrupo: area, usuarios: area, autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false } },
  };
}

/** Roda o script real da página com DOM mínimo; devolve elementos, links do menu e chamadas HTTP. */
function abrirPaginaDaFicha(permissoes, perfil = 'USUARIO') {
  const html = ler('pages/epi-ficha.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const chamadasHttp = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadasHttp.push(`${opcoes.method} ${u.pathname}`);
      if (u.pathname === '/api/auth/permissoes') return resposta(200, permissoes);
      return resposta(200, { status: 'ok', fichas: [], total: 0, pagina: 1, limite: 20 });
    },
  });
  const ocultos = new Set([...html.matchAll(/<[^>]*\sid="([^"]+)"[^>]*display:none[^>]*>/g)].map((m) => m[1]));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', textContent: '', innerHTML: '', disabled: false, checked: false, style: { display: ocultos.has(id) ? 'none' : '' },
    classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, scrollIntoView() {},
    getContext: () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }),
  });
  const links = ['dashboard', 'materials', 'epiFicha', 'employeeHistory'].map((p) => ({ style: { display: 'none' }, getAttribute: (k) => (k === 'data-pagina' ? p : null) }));
  const contexto = { empresa: { id: 3, nome: 'Empresa', cnpj: '11222333000181' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo.invalid', perfil } };
  const sessao = { montar: async () => contexto, sessaoEncerrada() { chamadasHttp.push('sessaoEncerrada'); } };
  const sandbox = {
    document: { getElementById: el, createElement: () => ({ value: '', textContent: '' }), querySelectorAll: () => links },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiPermissoes, EpiFicha: F, EpiSessaoEmpresarial: sessao,
    console, Promise, String, Number, Array, Object, JSON, Math, crypto: globalThis.crypto,
  };
  // No navegador os módulos e a página compartilham o window; aqui os módulos vivem no realm do teste.
  globalThis.EpiSessaoEmpresarial = sessao;
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const visivel = (id) => el(id).style.display !== 'none';
  return { el, links, chamadasHttp, esperar, visivel };
}

describe('10I — Ficha de EPI no fluxo oficial de páginas', () => {
  const html = ler('pages/epi-ficha.html');

  test('a página usa EpiPermissoes.prepararPagina com pagina epiFicha, mantém as duas capacidades separadas e tem o próprio link com data-pagina', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.match(script, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'epiFicha'/);
    assert.match(script, /EpiPermissoes\.recurso\([^)]*'epiFicha', 'visualizar'\)/);
    assert.match(script, /EpiPermissoes\.acao\([^)]*'REALIZAR_ENTREGA'\)/);
    assert.doesNotMatch(script, /EpiPermissoes\.carregar\(/, 'a consulta é do fluxo central');
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="epiFicha" style="display:none"><div class="nav-icon brown">description<\/div>Ficha de EPI<\/a>/);
    assert.doesNotMatch(html, /Ficha de EPI<span class="nav-etiqueta">/);
  });

  test('URL direta: sem nenhuma das duas autoridades a página avisa e não consulta; A/B/C abrem só o que a autoridade dá; MASTER com ambas usa tudo', async () => {
    const casos = [
      ['D) nenhuma', permissoesDaEmpresa(), 'USUARIO', { busca: false, entrega: false, negado: true, link: 'none' }],
      ['A) só consulta', permissoesDaEmpresa({ ficha: true }), 'USUARIO', { busca: true, entrega: false, negado: false, link: '' }],
      ['B) só entrega', permissoesDaEmpresa({ entrega: true }), 'USUARIO', { busca: false, entrega: true, negado: false, link: '' }],
      ['C) ambas', permissoesDaEmpresa({ ficha: true, entrega: true }), 'USUARIO', { busca: true, entrega: true, negado: false, link: '' }],
      ['MASTER', permissoesDaEmpresa({ ficha: true, entrega: true, perfil: 'MASTER' }), 'MASTER', { busca: true, entrega: true, negado: false, link: '' }],
    ];
    for (const [nome, permissoes, perfil, esperado] of casos) {
      const pg = abrirPaginaDaFicha(permissoes, perfil);
      await pg.esperar();
      assert.deepEqual(
        { busca: pg.visivel('fichaBuscaCard'), entrega: pg.visivel('btnNovaEntrega'), negado: pg.visivel('acessoNegado'), link: pg.links[2].style.display },
        esperado, nome,
      );
      assert.deepEqual(pg.chamadasHttp.filter((c) => c !== 'GET /api/auth/permissoes'), [], `${nome}: nada além das permissões é consultado ao abrir`);
      assert.equal(pg.links[3].style.display, 'none', `${nome}: o Histórico segue a própria permissão`);
    }
  });

  test('sessão sem permissões (401) devolve ao Portal; consulta falha fecha tudo', async () => {
    const fechada = abrirPaginaDaFicha(null);
    EpiHttp.configurar({ baseUrl: BASE, fetch: async () => resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA' }) });
    await fechada.esperar();
    assert.ok(fechada.chamadasHttp.includes('sessaoEncerrada'));
    assert.deepEqual([fechada.visivel('fichaBuscaCard'), fechada.visivel('btnNovaEntrega')], [false, false]);
  });
});

describe('10I — editor de permissões e escopo do MASTER', () => {
  test('Ficha de EPI é concedível a grupos só em Visualizar; realizar entrega continua a ação REALIZAR_ENTREGA (tabela de ações, modo ALTERNATIVA)', () => {
    const recurso = G.RECURSOS.find((r) => r.id === 'epiFicha');
    assert.deepEqual(recurso, { id: 'epiFicha', nome: 'Ficha de EPI', operacoes: ['podeVisualizar'] });
    const linha = G.render.linhaRecurso(recurso, null);
    assert.equal((linha.match(/<select/g) || []).length, 1);
    assert.match(linha, /data-campo="podeVisualizar"/);
    assert.equal((linha.match(/class="nao-se-aplica"/g) || []).length, 3);
    assert.match(linha, /data-acao="salvar-recurso"/);
    const acao = G.render.linhaAcao({ codigo: 'REALIZAR_ENTREGA', nome: 'Realizar entrega de EPI', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' }, null);
    assert.match(acao, /data-acao="salvar-acao"|<select/);
  });

  test('o escopo oficial do MASTER cobre a ficha (visualizar) e a entrega (REALIZAR_ENTREGA), coerente com o editor', () => {
    const escopo = Object.fromEntries(ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => [r.recurso, [...r.operacoes]]));
    assert.deepEqual(escopo.epiFicha, ['visualizar']);
    assert.deepEqual([...ESCOPO_PROVISIONAMENTO_MASTER.acoes], ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA']);
  });
});

describe('10J — publicação da Ficha de EPI', () => {
  test('allowlist traz a página e o módulo, uma vez cada, em ordem', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    assert.ok(arquivos.includes('pages/epi-ficha.html'));
    assert.ok(arquivos.includes('js/epi-ficha.js'));
    assert.equal(new Set(arquivos).size, arquivos.length);
    assert.deepEqual(arquivos, [...arquivos].sort());
    for (const src of [...ler('pages/epi-ficha.html').matchAll(/<script src="\.\.\/([^"]+)"><\/script>/g)].map((m) => m[1])) {
      assert.ok(arquivos.includes(src), `${src} carregado pela página precisa estar na allowlist`);
    }
  });
});
