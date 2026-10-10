'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiMateriais = require('../js/materiais');
const P = require('../js/permissoes-efetivas');
const { GRUPOS_PROTECAO } = require('../../backend/test/integracao/helpers/classificacao-v2');

/**
 * RED — classificação V2 do material na tela de Materiais (Grupo → Grupo de Proteção → Tipo), decisões de 07/10/2026.
 * Módulo js/materiais.js e página pages/materials.html, sem navegador. O catálogo de tipos vem do servidor
 * (GET /api/tipos-material, só ativos, da empresa da sessão); "Outros" é opção da interface e nunca linha do catálogo;
 * campo escondido NUNCA é enviado; nenhuma seleção automática; LEGADO edita campos não relacionados sem conversão.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const F = EpiMateriais.formulario;
const OUTROS = 'Outros';

const CATALOGO = [
  { id: 11, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Auricular Concha', ativo: true, origem: 'BASE' },
  { id: 12, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Auricular Plug', ativo: true, origem: 'BASE' },
  { id: 13, grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Óculos de Proteção Incolor', ativo: true, origem: 'BASE' },
  { id: 14, grupo: 'EPI', grupoProtecao: 'Proteção ocular', nome: 'Visor Panorâmico', ativo: true, origem: 'MANUAL' },
  { id: 15, grupo: 'EPI', grupoProtecao: 'Proteção auditiva', nome: 'Protetor Antigo', ativo: false, origem: 'MANUAL' },
  { id: 21, grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', nome: 'Avental de Segurança', ativo: true, origem: 'BASE' },
];
const BASE_CAMPOS = {
  nome: 'Material de teste', fabricante: '', codigoInterno: '', controleTamanho: 'grade', grade: '', quantidadeComprada: '', tamanhoEntrada: '', caEntrada: '', caValidadeEntrada: '',
  unidade: 'Par', estoqueMinimo: '5', prazoUnidade: 'meses', prazo: '6', descricao: '', registrarEntrada: 'nao', oculosComGrau: false, oculosComGrauTocado: false,
  categoria: '', categoriaCustom: '', grupoProtecao: '', grupoProtecaoCustom: '', tipo: '', tipoCustom: '', catalogo: CATALOGO,
};
const campos = (extra) => ({ ...BASE_CAMPOS, ...extra });
const classificacaoDe = (corpo) => Object.fromEntries(Object.entries(corpo).filter(([k]) => ['categoria', 'categoriaDescricao', 'grupoProtecao', 'grupoProtecaoDescricao', 'tipoMaterialId', 'tipo', 'tipoDescricao', 'oculosComGrau'].includes(k)));
const errosDe = (m) => (m.ok ? [] : m.erros.map((e) => e.campo));

describe('V2 — vocabulário do módulo', () => {
  test('GRUPOS para cadastro novo são só EPI, Vestimenta e Outros; os 12 grupos de proteção vêm do contrato aprovado; "Outros" é opção especial', () => {
    assert.deepEqual(F.GRUPOS, ['EPI', 'Vestimenta', OUTROS]);
    assert.deepEqual(F.GRUPOS_PROTECAO, [...GRUPOS_PROTECAO]);
    assert.equal(F.GRUPOS_PROTECAO.includes(OUTROS), false, '"Outros" não é um grupo de proteção do vocabulário');
    assert.equal(F.OUTROS, OUTROS);
  });

  test('tiposDoCatalogo filtra por grupo e grupo de proteção e só devolve ATIVOS, em ordem de nome; Outros em qualquer nível devolve lista vazia', () => {
    assert.equal(typeof F.tiposDoCatalogo, 'function', 'formulario.tiposDoCatalogo ainda não existe');
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, 'EPI', 'Proteção auditiva').map((t) => t.id), [11, 12], 'sem o inativo 15');
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, 'EPI', 'Proteção ocular').map((t) => t.nome), ['Óculos de Proteção Incolor', 'Visor Panorâmico']);
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, 'Vestimenta', 'Proteção do tronco').map((t) => t.id), [21]);
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, 'Vestimenta', 'Proteção auditiva'), []);
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, OUTROS, ''), []);
    assert.deepEqual(F.tiposDoCatalogo(CATALOGO, 'EPI', OUTROS), []);
    assert.deepEqual(F.tiposDoCatalogo(null, 'EPI', 'Proteção auditiva'), []);
  });

  test('estadoClassificacao decide o que aparece: proteção só em EPI/Vestimenta; "Especifique…" só com Outros; tipo forçado a Outros quando grupo ou proteção são Outros', () => {
    assert.equal(typeof F.estadoClassificacao, 'function', 'formulario.estadoClassificacao ainda não existe');
    assert.deepEqual(F.estadoClassificacao({ categoria: '', grupoProtecao: '', tipo: '' }), {
      mostrarProtecao: false, mostrarCategoriaCustom: false, mostrarProtecaoCustom: false, mostrarTipoCustom: false, tipoForcadoOutros: false, mostrarOculos: false,
    });
    assert.deepEqual(F.estadoClassificacao({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: '11' }), {
      mostrarProtecao: true, mostrarCategoriaCustom: false, mostrarProtecaoCustom: false, mostrarTipoCustom: false, tipoForcadoOutros: false, mostrarOculos: false,
    });
    assert.deepEqual(F.estadoClassificacao({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: OUTROS }), {
      mostrarProtecao: true, mostrarCategoriaCustom: false, mostrarProtecaoCustom: false, mostrarTipoCustom: true, tipoForcadoOutros: false, mostrarOculos: false,
    });
    assert.deepEqual(F.estadoClassificacao({ categoria: 'Vestimenta', grupoProtecao: OUTROS, tipo: '' }), {
      mostrarProtecao: true, mostrarCategoriaCustom: false, mostrarProtecaoCustom: true, mostrarTipoCustom: true, tipoForcadoOutros: true, mostrarOculos: false,
    });
    assert.deepEqual(F.estadoClassificacao({ categoria: OUTROS, grupoProtecao: 'Proteção ocular', tipo: '13' }), {
      mostrarProtecao: false, mostrarCategoriaCustom: true, mostrarProtecaoCustom: false, mostrarTipoCustom: true, tipoForcadoOutros: true, mostrarOculos: false,
    }, 'Grupo Outros esconde a proteção mesmo que havia valor');
    assert.deepEqual(F.estadoClassificacao({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: '14' }).mostrarOculos, true, 'qualquer tipo de Proteção ocular');
    assert.deepEqual(F.estadoClassificacao({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: OUTROS }).mostrarOculos, true, 'inclusive Outros');
    assert.deepEqual(F.estadoClassificacao({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipo: '13' }).mostrarOculos, false, 'não é pelo nome');
    assert.deepEqual(F.estadoClassificacao({ categoria: 'Vestimenta', grupoProtecao: 'Proteção ocular', tipo: OUTROS }).mostrarOculos, false, 'só EPI');
  });
});

describe('V2 — montarCorpo: corpo exato do POST, sem campo escondido', () => {
  test('EPI + proteção + tipo do catálogo: envia tipoMaterialId; nunca o nome do tipo nem descrições', () => {
    const m = F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: '11', tipoCustom: 'texto esquecido', grupoProtecaoCustom: 'esquecido', categoriaCustom: 'esquecido' }));
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(classificacaoDe(m.corpo), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11 });
  });

  test('Vestimenta + proteção + tipo do catálogo', () => {
    const m = F.montarCorpo(campos({ categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipo: '21' }));
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(classificacaoDe(m.corpo), { categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipoMaterialId: 21 });
  });

  test('Grupo Outros: categoriaDescricao e tipoDescricao obrigatórias; proteção nunca vai, mesmo se estava preenchida', () => {
    const m = F.montarCorpo(campos({ categoria: OUTROS, categoriaCustom: ' Ferramenta ', grupoProtecao: 'Proteção ocular', grupoProtecaoCustom: 'x', tipo: OUTROS, tipoCustom: 'Chave isolada 1000 V' }));
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(classificacaoDe(m.corpo), { categoria: OUTROS, categoriaDescricao: 'Ferramenta', tipo: OUTROS, tipoDescricao: 'Chave isolada 1000 V' });
  });

  test('EPI + Proteção Outros: grupoProtecaoDescricao e tipoDescricao obrigatórias; tipo é Outros mesmo que o select trouxesse um id', () => {
    const m = F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: OUTROS, grupoProtecaoCustom: 'Proteção contra arco elétrico', tipo: '11', tipoCustom: 'Balaclava para arco elétrico' }));
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(classificacaoDe(m.corpo), { categoria: 'EPI', grupoProtecao: OUTROS, grupoProtecaoDescricao: 'Proteção contra arco elétrico', tipo: OUTROS, tipoDescricao: 'Balaclava para arco elétrico' });
  });

  test('EPI + proteção conhecida + Tipo Outros: só tipoDescricao', () => {
    const m = F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: OUTROS, tipoCustom: 'Protetor auricular eletrônico', grupoProtecaoCustom: 'residual' }));
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(classificacaoDe(m.corpo), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: OUTROS, tipoDescricao: 'Protetor auricular eletrônico' });
  });

  test('obrigatórios: grupo; proteção e tipo em EPI/Vestimenta; cada "Especifique…" com o seu Outros (vazio e só espaços recusados)', () => {
    assert.deepEqual(errosDe(F.montarCorpo(campos({}))), ['categoria']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI' }))), ['grupoProtecao']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva' }))), ['tipo']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: OUTROS, categoriaCustom: '   ', tipo: OUTROS, tipoCustom: 'x' }))), ['categoriaDescricao']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: OUTROS, grupoProtecaoCustom: '', tipo: OUTROS, tipoCustom: 'x' }))), ['grupoProtecaoDescricao']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: OUTROS, tipoCustom: ' ' }))), ['tipoDescricao']);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: OUTROS, categoriaCustom: 'x'.repeat(101), tipo: OUTROS, tipoCustom: 'x' }))), ['categoriaDescricao']);
  });

  test('grupos antigos e tipo fora do catálogo carregado são recusados localmente (o servidor confere de novo)', () => {
    for (const g of ['Ferramenta', 'Material de consumo', 'Uniforme']) assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: g, tipo: OUTROS, tipoCustom: 'x' }))), ['categoria'], g);
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: '15' }))), ['tipo'], 'inativo não é opção');
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: '13' }))), ['tipo'], 'de outra proteção');
    assert.deepEqual(errosDe(F.montarCorpo(campos({ categoria: 'EPI', grupoProtecao: 'Proteção inexistente', tipo: OUTROS, tipoCustom: 'x' }))), ['grupoProtecao']);
  });

  test('óculos com grau: enviado (true/false) para QUALQUER tipo de EPI + Proteção ocular; nunca fora disso', () => {
    const montado = (c) => { const m = F.montarCorpo(campos(c)); assert.equal(m.ok, true, JSON.stringify(m.erros)); return m.corpo; };
    assert.equal(montado({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: '14', oculosComGrau: false }).oculosComGrau, false);
    assert.equal(montado({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: OUTROS, tipoCustom: 'Lupa', oculosComGrau: true }).oculosComGrau, true);
    assert.equal(Object.hasOwn(montado({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipo: OUTROS, tipoCustom: 'x', oculosComGrau: true }), 'oculosComGrau'), false);
    assert.equal(Object.hasOwn(montado({ categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipo: '21', oculosComGrau: true }), 'oculosComGrau'), false);
  });
});

const LEGADO_FERRAMENTA = {
  id: 77, empresaId: 3, nome: 'Chave de fenda', categoria: 'Ferramenta', categoriaDescricao: null, grupoProtecao: null, grupoProtecaoDescricao: null, tipoMaterialId: null,
  tipo: OUTROS, tipoDescricao: 'Chave', modeloClassificacao: 'LEGADO', fabricante: 'Fab', caNumero: null, caValidade: null, prazoUsoDias: 180, unidade: 'unidade', estoqueMinimo: 0,
  codigoInterno: null, descricao: null, exigeTamanho: false, oculosComGrau: null, ativo: true,
};
const V2_CONCHA = {
  ...LEGADO_FERRAMENTA, id: 78, nome: 'Concha azul', categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11, tipo: 'Protetor Auricular Concha', tipoDescricao: null,
  modeloClassificacao: 'V2', tipoMaterialAtivo: true,
};
const V2_INATIVO = { ...V2_CONCHA, id: 79, nome: 'Protetor antigo em uso', tipoMaterialId: 15, tipo: 'Protetor Antigo', tipoMaterialAtivo: false };

describe('V2 — edição: legado, conversão e tipo inativo (módulo)', () => {
  test('camposDoMaterial: LEGADO vem com o grupo antigo como opção extra e a marca de legado; V2 vem com proteção e o id do tipo', () => {
    const l = F.camposDoMaterial(LEGADO_FERRAMENTA);
    assert.deepEqual([l.campos.categoria, l.campos.grupoProtecao, l.campos.tipo, l.campos.tipoCustom, l.legado], ['Ferramenta', '', OUTROS, 'Chave', true]);
    assert.deepEqual(l.opcoesExtras.categoria, { valor: 'Ferramenta', rotulo: 'Ferramenta (legado)' });
    const v = F.camposDoMaterial(V2_CONCHA);
    assert.deepEqual([v.campos.categoria, v.campos.grupoProtecao, v.campos.tipo, v.legado], ['EPI', 'Proteção auditiva', '11', false]);
    const i = F.camposDoMaterial(V2_INATIVO);
    assert.deepEqual(i.opcoesExtras.tipo, { valor: '15', rotulo: 'Protetor Antigo (inativo)' });
  });

  test('rotuloClassificacao: LEGADO, TIPO_INATIVO ou vazio', () => {
    assert.equal(typeof F.rotuloClassificacao, 'function', 'formulario.rotuloClassificacao ainda não existe');
    assert.equal(F.rotuloClassificacao(LEGADO_FERRAMENTA), 'LEGADO');
    assert.equal(F.rotuloClassificacao(V2_INATIVO), 'TIPO_INATIVO');
    assert.equal(F.rotuloClassificacao(V2_CONCHA), '');
  });

  test('LEGADO: alterar só nome/fabricante gera PATCH sem nenhum campo de classificação (sem conversão forçada)', () => {
    const c = F.camposDoMaterial(LEGADO_FERRAMENTA).campos;
    const m = F.montarEdicao({ ...BASE_CAMPOS, ...c, nome: 'Chave nova', fabricante: 'Outra' }, LEGADO_FERRAMENTA);
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(m.corpo, { nome: 'Chave nova', fabricante: 'Outra' });
  });

  test('LEGADO com tipo Outros SEM descrição (anterior à 071): editar o nome continua possível e não inventa descrição', () => {
    const antigo = { ...LEGADO_FERRAMENTA, tipoDescricao: null };
    const c = F.camposDoMaterial(antigo).campos;
    const m = F.montarEdicao({ ...BASE_CAMPOS, ...c, nome: 'Renomeado' }, antigo);
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(m.corpo, { nome: 'Renomeado' });
  });

  test('LEGADO: mudar o grupo exige o bloco completo (proteção e tipo); bloco completo converte e envia tudo', () => {
    const c = F.camposDoMaterial(LEGADO_FERRAMENTA).campos;
    const parcial = F.montarEdicao({ ...BASE_CAMPOS, ...c, categoria: 'EPI', grupoProtecao: '', tipo: '' }, LEGADO_FERRAMENTA);
    assert.deepEqual(errosDe(parcial), ['grupoProtecao']);
    const completo = F.montarEdicao({ ...BASE_CAMPOS, ...c, categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: '11', tipoCustom: 'Chave' }, LEGADO_FERRAMENTA);
    assert.equal(completo.ok, true, JSON.stringify(completo.erros));
    assert.deepEqual(classificacaoDe(completo.corpo), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11 });
    assert.equal(Object.hasOwn(completo.corpo, 'tipoDescricao'), false, 'a descrição antiga não vai escondida');
  });

  test('V2: trocar Outros por tipo do catálogo envia o bloco novo e nada das descrições; sem mudança, nenhum campo de classificação', () => {
    const outros = { ...V2_CONCHA, grupoProtecao: OUTROS, grupoProtecaoDescricao: 'Arco elétrico', tipoMaterialId: null, tipo: OUTROS, tipoDescricao: 'Balaclava' };
    const c = F.camposDoMaterial(outros).campos;
    const igual = F.montarEdicao({ ...BASE_CAMPOS, ...c }, outros);
    assert.deepEqual([igual.ok, igual.alterado, igual.corpo], [true, false, {}]);
    const troca = F.montarEdicao({ ...BASE_CAMPOS, ...c, grupoProtecao: 'Proteção auditiva', tipo: '11' }, outros);
    assert.equal(troca.ok, true, JSON.stringify(troca.erros));
    assert.deepEqual(classificacaoDe(troca.corpo), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11 });
  });

  test('V2 com tipo inativo: editar outro campo mantém o tipo e não o envia; escolher outro tipo exige ativo', () => {
    const c = F.camposDoMaterial(V2_INATIVO).campos;
    const m = F.montarEdicao({ ...BASE_CAMPOS, ...c, nome: 'Novo nome' }, V2_INATIVO);
    assert.equal(m.ok, true, JSON.stringify(m.erros));
    assert.deepEqual(m.corpo, { nome: 'Novo nome' });
  });
});

describe('V2 — valor efetivo de exibição (helper central, igual ao do servidor)', () => {
  const servidor = require('../../backend/src/utils/classificacao-material'); // eslint-disable-line global-require
  const CASOS = [
    [{ categoria: 'Ferramenta', modeloClassificacao: 'LEGADO' }, 'Ferramenta'],
    [{ categoria: OUTROS, categoriaDescricao: 'Ferramenta', modeloClassificacao: 'V2' }, 'Ferramenta'],
    [{ categoria: 'EPI', modeloClassificacao: 'V2' }, 'EPI'],
    [{ categoria: 'Vestimenta' }, 'Vestimenta'],
    [{ categoria: null }, null],
    [{}, null],
  ];
  test('grupoEfetivo, grupoProtecaoEfetivo e tipoEfetivo existem no navegador e no servidor e dão o mesmo resultado', () => {
    for (const fn of ['grupoEfetivo', 'grupoProtecaoEfetivo', 'tipoEfetivo']) {
      assert.equal(typeof F[fn], 'function', `frontend ${fn}`);
      assert.equal(typeof servidor[fn], 'function', `backend ${fn}`);
    }
    for (const [m, esperado] of CASOS) {
      assert.equal(F.grupoEfetivo(m), esperado, JSON.stringify(m));
      assert.equal(servidor.grupoEfetivo(m), esperado, JSON.stringify(m));
    }
    assert.equal(F.grupoProtecaoEfetivo({ grupoProtecao: OUTROS, grupoProtecaoDescricao: 'Arco' }), 'Arco');
    assert.equal(F.grupoProtecaoEfetivo({ grupoProtecao: 'Proteção ocular' }), 'Proteção ocular');
    assert.equal(F.tipoEfetivo({ tipo: OUTROS, tipoDescricao: 'Chave' }), 'Chave');
    assert.equal(F.tipoEfetivo({ tipo: 'Capacete' }), 'Capacete');
    assert.equal(servidor.tipoEfetivo({ tipo: OUTROS, tipoDescricao: 'Chave' }), 'Chave');
  });
});

// ── página ──
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const PERMISSOES = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
function servidorV2({ materiais = [], catalogo = CATALOGO } = {}) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const p = u.pathname;
      if (p === '/api/tipos-material' && opcoes.method === 'GET') {
        const g = u.searchParams.get('grupo'); const gp = u.searchParams.get('grupoProtecao'); const ativo = u.searchParams.get('ativo');
        const tipos = catalogo.filter((t) => (!g || t.grupo === g) && (!gp || t.grupoProtecao === gp) && (ativo === null || String(t.ativo) === ativo));
        return resposta(200, { status: 'ok', tipos, total: tipos.length, pagina: 1, limite: 100, vocabulario: { grupos: ['EPI', 'Vestimenta'], gruposProtecao: [...GRUPOS_PROTECAO] } });
      }
      if (p === '/api/materiais' && opcoes.method === 'GET') return resposta(200, { status: 'ok', materiais, total: materiais.length, pagina: 1, limite: 100 });
      if (p === '/api/materiais' && opcoes.method === 'POST') return resposta(201, { status: 'ok', material: { ...V2_CONCHA, ...corpo, id: 999 } });
      const m = p.match(/^\/api\/materiais\/(\d+)$/);
      if (m && opcoes.method === 'GET') { const mat = materiais.find((x) => x.id === Number(m[1])); return mat ? resposta(200, { status: 'ok', material: mat }) : resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' }); }
      if (m && opcoes.method === 'PATCH') { const mat = materiais.find((x) => x.id === Number(m[1])) || {}; return resposta(200, { status: 'ok', material: { ...mat, ...corpo } }); }
      if (/^\/api\/materiais\/\d+\/estoque(\/lotes)?$/.test(p)) return resposta(200, { status: 'ok', material: materiais[0] || V2_CONCHA, saldos: [], lotes: [], totais: {} });
      return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
    },
  });
}

function montarPagina(opcoes = {}) {
  servidorV2(opcoes);
  const html = ler('pages/materials.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['materialCategoria', 'materialGrupoProtecao', 'materialTipo', 'materialUnidade', 'materialValidade', 'materialValidadeTipo', 'materialTamanhoEntrada', 'gradeMaterial',
    'materialRegistrarEntrada', 'entradaTamanho', 'materialControleTamanho', 'baixaLote', 'baixaMotivo']);
  const mapa = {};
  const elemento = (id) => {
    const listeners = {};
    return {
      id, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, selectedIndex: 0, style: {}, atributos: {}, listeners,
      tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT', hidden: false, filhos: [], replaceChildren(...nos) { this.filhos = nos; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
      querySelector() { return elemento('form-grid'); }, querySelectorAll() { return []; },
    };
  };
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const noSvg = (ns, tag) => ({ namespaceURI: ns, tagName: tag, atributos: {}, filhos: [], setAttribute(k, v) { this.atributos[k] = String(v); }, appendChild(n) { this.filhos.push(n); return n; } });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElementNS: noSvg },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiMateriais, EpiEstoqueMinimos: require('../js/estoque-minimos'), EpiCatalogoVisual: require('../js/catalogo-visual'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => ({ permissoes: PERMISSOES, podeAlterar: true }), acao: P.acao, recurso: P.recurso, somenteLeitura() {} },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    showToast() {}, console, setTimeout, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn(); await esperar(); };
  const preencher = (c) => { for (const [id, v] of Object.entries(c)) el(id).value = v; };
  const visivel = (id) => el(id).style.display !== 'none';
  const opcoesDe = (id) => [...el(id).innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  return { el, esperar, disparar, preencher, visivel, opcoes: opcoesDe };
}
const CAMPOS_FIXOS = { materialNome: 'Material novo', materialControleTamanho: 'grade', materialUnidade: 'Par', materialEstoqueMinimo: '5', materialValidadeTipo: 'meses', materialPrazo: '6', materialRegistrarEntrada: 'nao' };
const posts = () => chamadas.filter((c) => c.metodo === 'POST' && c.caminho === '/api/materiais').map((c) => c.corpo);
const consultasCatalogo = () => chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/tipos-material'));
async function escolher(pg, categoria, protecao, tipo) {
  pg.el('materialCategoria').value = categoria; await pg.disparar('materialCategoria', 'change');
  if (protecao !== undefined) { pg.el('materialGrupoProtecao').value = protecao; await pg.disparar('materialGrupoProtecao', 'change'); }
  if (tipo !== undefined) { pg.el('materialTipo').value = tipo; await pg.disparar('materialTipo', 'change'); }
}
async function abrirEdicao(pg, id) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
  await pg.disparar('botaoEditarMaterial');
}

describe('V2 — página: inspeção estática', () => {
  test('o select de Grupo oferece só EPI, Vestimenta e Outros; existem os campos de proteção e "Especifique…"; os rótulos são Grupo e Grupo de Proteção', () => {
    const html = ler('pages/materials.html');
    const bloco = /<select id="materialCategoria"[^>]*>([\s\S]*?)<\/select>/.exec(html)[1];
    const opcoes = [...bloco.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1].trim()).filter(Boolean);
    assert.deepEqual(opcoes, ['EPI', 'Vestimenta', OUTROS]);
    assert.match(html, /<label for="materialCategoria">Grupo<\/label>/);
    assert.match(html, /<label for="materialGrupoProtecao">Grupo de Proteção<\/label>/);
    for (const id of ['campoGrupoProtecao', 'materialGrupoProtecao', 'campoGrupoProtecaoCustom', 'materialGrupoProtecaoCustom', 'campoCategoriaCustom', 'materialCategoriaCustom', 'materialClassificacaoAviso']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.doesNotMatch(html, /<option[^>]*>\s*(Uniforme|Ferramenta|Material de consumo)\s*<\/option>/, 'grupos antigos não são opção de cadastro');
  });
});

describe('V2 — página: selects encadeados e campos "Especifique…"', () => {
  test('ao abrir: proteção e os três "Especifique…" escondidos; nada selecionado; nenhuma consulta ao catálogo', async () => {
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.visivel('campoGrupoProtecao'), false);
    for (const id of ['campoCategoriaCustom', 'campoGrupoProtecaoCustom', 'customMaterialTypeField', 'campoOculosComGrau']) assert.equal(pg.visivel(id), false, id);
    assert.equal(consultasCatalogo().length, 0);
  });

  test('EPI → proteção visível com os 12 grupos + Outros, sem seleção; escolher a proteção consulta o catálogo (só ativos) e monta os tipos + Outros, sem pré-seleção', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI');
    assert.equal(pg.visivel('campoGrupoProtecao'), true);
    assert.deepEqual(pg.opcoes('materialGrupoProtecao').map(([v]) => v), ['', ...GRUPOS_PROTECAO, OUTROS]);
    assert.equal(pg.el('materialGrupoProtecao').value, '');
    assert.deepEqual(pg.opcoes('materialTipo').map(([v]) => v), [''], 'sem proteção, sem tipos');
    await escolher(pg, 'EPI', 'Proteção auditiva');
    const consulta = consultasCatalogo().at(-1);
    assert.ok(consulta, 'consultou o catálogo');
    const q = new URL(`http://x${consulta.caminho}`).searchParams;
    assert.deepEqual([q.get('grupo'), q.get('grupoProtecao'), q.get('ativo')], ['EPI', 'Proteção auditiva', 'true']);
    assert.deepEqual(pg.opcoes('materialTipo'), [['', 'Selecione'], ['11', 'Protetor Auricular Concha'], ['12', 'Protetor Auricular Plug'], [OUTROS, OUTROS]]);
    assert.equal(pg.el('materialTipo').value, '', 'nenhuma seleção automática');
    assert.doesNotMatch(pg.el('materialTipo').innerHTML, /Protetor Antigo/, 'inativo não é opção');
  });

  test('Grupo Outros: proteção escondida, "Especifique o grupo" e "Especifique o tipo" visíveis, tipo travado em Outros; o POST leva só o que se aplica', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção ocular', '13');
    await escolher(pg, OUTROS);
    assert.equal(pg.visivel('campoGrupoProtecao'), false);
    assert.equal(pg.visivel('campoCategoriaCustom'), true);
    assert.equal(pg.visivel('customMaterialTypeField'), true);
    assert.equal(pg.el('materialTipo').value, OUTROS);
    assert.equal(pg.el('materialTipo').disabled, true, 'tipo forçado a Outros');
    assert.equal(pg.visivel('campoOculosComGrau'), false);
    pg.preencher({ ...CAMPOS_FIXOS, materialCategoriaCustom: 'Ferramenta', materialTipoCustom: 'Chave isolada 1000 V' });
    await pg.disparar('botaoSalvar');
    assert.equal(posts().length, 1, 'um POST');
    assert.deepEqual(classificacaoDe(posts()[0]), { categoria: OUTROS, categoriaDescricao: 'Ferramenta', tipo: OUTROS, tipoDescricao: 'Chave isolada 1000 V' });
  });

  test('EPI + Proteção Outros: "Especifique o grupo de proteção" e tipo travado em Outros; POST sem tipoMaterialId', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', OUTROS);
    assert.equal(pg.visivel('campoGrupoProtecaoCustom'), true);
    assert.equal(pg.el('materialTipo').value, OUTROS);
    assert.equal(pg.visivel('customMaterialTypeField'), true);
    pg.preencher({ ...CAMPOS_FIXOS, materialGrupoProtecaoCustom: 'Proteção contra arco elétrico', materialTipoCustom: 'Balaclava para arco elétrico' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(classificacaoDe(posts()[0]), { categoria: 'EPI', grupoProtecao: OUTROS, grupoProtecaoDescricao: 'Proteção contra arco elétrico', tipo: OUTROS, tipoDescricao: 'Balaclava para arco elétrico' });
  });

  test('EPI + proteção conhecida + Tipo Outros: só "Especifique o tipo"; POST com grupoProtecao e tipoDescricao', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', OUTROS);
    assert.equal(pg.visivel('campoGrupoProtecaoCustom'), false);
    assert.equal(pg.visivel('customMaterialTypeField'), true);
    pg.preencher({ ...CAMPOS_FIXOS, materialTipoCustom: 'Protetor auricular eletrônico' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(classificacaoDe(posts()[0]), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: OUTROS, tipoDescricao: 'Protetor auricular eletrônico' });
  });

  test('trocar Outros por opção normal esconde e LIMPA a especificação; o texto digitado não vai no POST', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', OUTROS);
    pg.preencher({ materialGrupoProtecaoCustom: 'Arco elétrico', materialTipoCustom: 'Balaclava' });
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    assert.equal(pg.visivel('campoGrupoProtecaoCustom'), false);
    assert.equal(pg.el('materialGrupoProtecaoCustom').value, '');
    assert.equal(pg.visivel('customMaterialTypeField'), false);
    assert.equal(pg.el('materialTipoCustom').value, '');
    pg.preencher(CAMPOS_FIXOS);
    await pg.disparar('botaoSalvar');
    assert.deepEqual(classificacaoDe(posts()[0]), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11 });
    assert.doesNotMatch(JSON.stringify(posts()[0]), /Arco elétrico|Balaclava/);
  });

  test('trocar o grupo limpa proteção e tipo e exige escolher de novo; sem escolha, nenhum POST', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    await escolher(pg, 'Vestimenta');
    assert.equal(pg.el('materialGrupoProtecao').value, '');
    assert.equal(pg.el('materialTipo').value, '');
    pg.preencher(CAMPOS_FIXOS);
    await pg.disparar('botaoSalvar');
    assert.equal(posts().length, 0);
    assert.match(pg.el('aviso').innerHTML, /proteção/i);
  });

  test('Proteção ocular: a caixa de óculos com grau aparece para qualquer tipo (Visor Panorâmico e Outros) e some fora dela; vai no POST só quando visível', async () => {
    const pg = montarPagina();
    await pg.esperar();
    await escolher(pg, 'EPI', 'Proteção ocular', '14');
    assert.equal(pg.visivel('campoOculosComGrau'), true, 'Visor Panorâmico');
    await escolher(pg, 'EPI', 'Proteção ocular', OUTROS);
    assert.equal(pg.visivel('campoOculosComGrau'), true, 'Outros em Proteção ocular');
    pg.el('materialOculosComGrau').checked = true;
    await pg.disparar('materialOculosComGrau', 'change');
    pg.preencher({ ...CAMPOS_FIXOS, materialTipoCustom: 'Lupa de proteção' });
    await pg.disparar('botaoSalvar');
    assert.equal(posts()[0].oculosComGrau, true);
    await escolher(pg, 'EPI', 'Proteção facial', OUTROS);
    assert.equal(pg.visivel('campoOculosComGrau'), false, 'fora de Proteção ocular');
    pg.preencher({ ...CAMPOS_FIXOS, materialNome: 'Outro', materialTipoCustom: 'Viseira' });
    await pg.disparar('botaoSalvar');
    assert.equal(Object.hasOwn(posts()[1], 'oculosComGrau'), false);
  });
});

describe('V2 — página: legado e tipo inativo na edição', () => {
  test('LEGADO: o grupo antigo entra como opção "(legado)", o aviso de legado aparece e alterar só o nome manda PATCH sem classificação', async () => {
    const pg = montarPagina({ materiais: [LEGADO_FERRAMENTA] });
    await pg.esperar();
    await abrirEdicao(pg, 77);
    assert.equal(pg.el('materialCategoria').value, 'Ferramenta');
    assert.match(pg.el('materialCategoria').innerHTML, /Ferramenta \(legado\)/);
    assert.equal(pg.visivel('materialClassificacaoAviso'), true);
    assert.match(pg.el('materialClassificacaoAviso').textContent, /legado/i);
    assert.equal(pg.visivel('campoGrupoProtecao'), false);
    pg.preencher({ materialNome: 'Chave de fenda nova' });
    await pg.disparar('botaoSalvar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH' && c.caminho === '/api/materiais/77');
    assert.ok(patch, 'houve PATCH');
    assert.deepEqual(patch.corpo, { nome: 'Chave de fenda nova' });
  });

  test('LEGADO: ao mudar o grupo para EPI, proteção e tipo passam a ser exigidos; sem eles, nenhum PATCH', async () => {
    const pg = montarPagina({ materiais: [LEGADO_FERRAMENTA] });
    await pg.esperar();
    await abrirEdicao(pg, 77);
    await escolher(pg, 'EPI');
    assert.equal(pg.visivel('campoGrupoProtecao'), true);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH'), false);
    await escolher(pg, 'EPI', 'Proteção auditiva', '11');
    await pg.disparar('botaoSalvar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.ok(patch);
    assert.deepEqual(classificacaoDe(patch.corpo), { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: 11 });
  });

  test('V2 com tipo inativo: a opção aparece marcada "(inativo)", o aviso informa, e editar outro campo não envia classificação', async () => {
    const pg = montarPagina({ materiais: [V2_INATIVO] });
    await pg.esperar();
    await abrirEdicao(pg, 79);
    assert.equal(pg.el('materialTipo').value, '15');
    assert.match(pg.el('materialTipo').innerHTML, /Protetor Antigo \(inativo\)/);
    assert.equal(pg.visivel('materialClassificacaoAviso'), true);
    assert.match(pg.el('materialClassificacaoAviso').textContent, /inativo/i);
    pg.preencher({ materialFabricante: 'Fabricante novo' });
    await pg.disparar('botaoSalvar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH' && c.caminho === '/api/materiais/79');
    assert.ok(patch);
    assert.deepEqual(patch.corpo, { fabricante: 'Fabricante novo' });
  });

  test('V2 normal: a edição reabre com grupo, proteção e tipo (do catálogo) sem consulta extra de conversão; nada muda sem alteração', async () => {
    const pg = montarPagina({ materiais: [V2_CONCHA] });
    await pg.esperar();
    await abrirEdicao(pg, 78);
    assert.deepEqual([pg.el('materialCategoria').value, pg.el('materialGrupoProtecao').value, pg.el('materialTipo').value], ['EPI', 'Proteção auditiva', '11']);
    assert.equal(pg.visivel('materialClassificacaoAviso'), false);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH'), false, 'sem mudança, nenhuma requisição');
  });
});
