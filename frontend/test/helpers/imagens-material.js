'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, semComentarios } = require('./dom-pagina');

/**
 * Apoio dos testes da Unidade 5B (campo "Imagem do material" no cadastro de materiais). Sem PostgreSQL e sem a API 3300: a página real
 * `pages/materials.html` roda no harness de DOM (`helpers/dom-pagina.js`) com o `fetch` simulado por rota; as imagens são fictícias.
 *
 * CONTRATO DE DOM que a integração precisa cumprir (os testes não dependem de classes CSS nem de textos além dos aprovados no protótipo V6):
 *   campo no formulário .. #campoImagemMaterial (field full) com <label>Imagem do material</label>, #imagemMaterialPrevia (miniatura ou quadro
 *                          vazio), #imagemMaterialEstado (role=status), #botaoEscolherImagem e #botaoRemoverImagem
 *   seletor (pop-up) ..... #modalImagemMaterial (overlay), [role=dialog][aria-modal=true][aria-labelledby], #imagemBusca, #imagemContagem,
 *                          #imagemModalEstado (role=status), #imagemLista (role=listbox) com itens [role=option][data-imagem-origem]
 *                          [data-imagem-id][aria-selected], #botaoImagemConfirmar, #botaoImagemCancelar e #botaoImagemFechar
 */

const RAIZ = path.join(__dirname, '..', '..');
const API = 'http://localhost:3000/api';
const PAGINA = 'pages/materials.html';
const MODULO = 'js/imagens-material.js';

const IDS = Object.freeze({
  campo: 'campoImagemMaterial',
  previa: 'imagemMaterialPrevia',
  estado: 'imagemMaterialEstado',
  escolher: 'botaoEscolherImagem',
  remover: 'botaoRemoverImagem',
  modal: 'modalImagemMaterial',
  busca: 'imagemBusca',
  contagem: 'imagemContagem',
  estadoModal: 'imagemModalEstado',
  lista: 'imagemLista',
  confirmar: 'botaoImagemConfirmar',
  cancelar: 'botaoImagemCancelar',
  fechar: 'botaoImagemFechar',
});

// Estado atual do formulário (caracterização, nascida verde): ordem dos blocos de `.form-grid` e assinatura do seu HTML sem o campo novo.
const ORDEM_ATUAL_DO_FORMULARIO = Object.freeze([
  'materialNome', 'materialCategoria', 'campoCategoriaCustom', 'campoGrupoProtecao', 'campoGrupoProtecaoCustom', 'materialTipo', 'customMaterialTypeField',
  'materialClassificacaoAviso', 'campoOculosComGrau', 'materialControleTamanho', 'campoGradeTamanhos', 'materialFabricante', 'materialCodigo', 'materialRegistrarEntrada',
  'blocoEntradaInicial', 'materialUnidade', 'materialEstoqueMinimo', 'validityFields', 'materialDocumentoValidade', 'materialDesc',
]);
const ASSINATURA_ATUAL_DO_FORMULARIO = 'e61148b69de3d7485c0951da03f5c8f56029787fdcb3ee1493cf8f7843e2456b';
const INNER_HTML_ATUAIS_NO_SCRIPT_DA_PAGINA = 22;

const existeModulo = () => fs.existsSync(path.join(RAIZ, MODULO));
const exigirModulo = (para) => assert.ok(existeModulo(), `comportamento ausente: ${MODULO} não existe (${para})`);
const exigirCampo = (pg) => assert.ok(pg.existe(IDS.campo), 'comportamento ausente: o campo "Imagem do material" (#campoImagemMaterial) ainda não está em pages/materials.html');
const exigirSeletor = (pg) => assert.ok(pg.existe(IDS.modal), 'comportamento ausente: o seletor de imagens (#modalImagemMaterial) ainda não existe em pages/materials.html');

// ───────────────────────── imagens fictícias da Biblioteca Padrão ─────────────────────────

const NOMES = [
  'Abafador de Ruído Tipo Concha', 'Avental de Raspa', 'Bota de Borracha', 'Botina de Segurança', 'Calça de Brim', 'Capa de Chuva',
  'Capacete de Segurança', 'Capuz Balaclava', 'Cinto Paraquedista', 'Colete Refletivo', 'Cotoveleira', 'Creme de Proteção',
  'Jaleco', 'Joelheira', 'Luva de Raspa', 'Luva de Vaqueta', 'Luva Nitrílica', 'Mangote de Raspa', 'Máscara de Solda',
  'Óculos de Proteção Ampla Visão', 'Óculos de Proteção Incolor', 'Perneira de Raspa', 'Protetor Auricular Plug', 'Protetor Facial',
  'Respirador PFF2', 'Sapato de Segurança', 'Talabarte em Y', 'Touca Árabe', 'Uniforme Camisa', 'Viseira de Policarbonato',
];
const NOME_HOSTIL = '<img src=x onerror=alert(1)> "aspas" & <b>negrito</b>';
const ID_GRANDE = '9007199254740993'; // 2^53 + 1: perde precisão se passar por Number

/** Como `GET /api/imagens-material?origem=PADRAO` devolve (ids BIGINT em texto). A de índice 4 está na versão 2 e a última tem id acima de 2^53. */
function imagensPadrao({ hostil = false } = {}) {
  return NOMES.map((nome, i) => ({
    origem: 'PADRAO',
    id: i === 29 ? ID_GRANDE : String(1001 + i),
    nome: hostil && i === 2 ? NOME_HOSTIL : nome,
    largura: 1024,
    altura: 1024,
    versao: i === 29 ? 3 : (i === 4 ? 2 : 1),
    ilustrativa: true,
    sugerida: null,
    emUso: 0,
  }));
}

const urlMiniatura = (imagem) => `${API}/imagens-material/padrao/${imagem.id}/miniatura?v=${imagem.versao}`;

// ───────────────────────── servidor simulado da página de materiais ─────────────────────────

const area = (v) => ({ consultar: v, alterar: v });
const TUDO = Object.freeze({ visualizar: true, criar: true, editar: true, excluir: false });
function permissoes({ materials = TUDO, acoes = { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true } } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'MASTER', recursos: { materials }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}

/** Material do cadastro (V2, "Outros", tamanho único, sem imagem). */
const MATERIAL = Object.freeze({
  id: 501, empresaId: 3, nome: 'Fita isolante preta', categoria: 'Outros', categoriaDescricao: 'Ferramenta', grupoProtecao: null, grupoProtecaoDescricao: null,
  tipoMaterialId: null, tipo: 'Outros', tipoDescricao: 'Fita isolante', modeloClassificacao: 'V2', tipoMaterialAtivo: null, fabricante: 'Fab', caNumero: null,
  caValidade: null, prazoUsoDias: 180, unidade: 'unidade', estoqueMinimo: 0, codigoInterno: null, descricao: null, exigeTamanho: false, oculosComGrau: null,
  ativo: true, tamanhos: [], imagem: null,
});

const TEXTO_DO_SERVIDOR = 'relation "imagens_padrao" does not exist (texto interno do servidor)';
const listaOk = (imagens) => ({ status: 200, corpo: { status: 'ok', imagens, total: imagens.length, pagina: 1, limite: 100 } });
const erroApi = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: TEXTO_DO_SERVIDOR } });

/**
 * `lista`: função (chamada) => resposta | Promise | Error, no lugar da lista padrão. As chamadas ficam em `pg.chamadas`.
 */
function servidor({ p = permissoes(), imagens = imagensPadrao(), lista = null, materiais = [MATERIAL] } = {}) {
  const s = { p, imagens, lista, materiais };
  const material = (m) => ({ status: 200, corpo: { status: 'ok', material: m } });
  const rotas = {
    'GET /auth/me': () => ({ status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@example.invalid', perfil: 'MASTER' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } } }),
    'GET /auth/global/me': () => ({ status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } }),
    'GET /auth/permissoes': () => ({ status: 200, corpo: s.p }),
    'GET /materiais': () => ({ status: 200, corpo: { status: 'ok', materiais: s.materiais, total: s.materiais.length, pagina: 1, limite: 100 } }),
    'GET /tipos-material': () => ({ status: 200, corpo: { status: 'ok', tipos: [], total: 0, pagina: 1, limite: 100, vocabulario: { grupos: ['EPI', 'Vestimenta'], gruposProtecao: [] } } }),
    'POST /materiais': (c) => ({ status: 201, corpo: { status: 'ok', material: { ...MATERIAL, ...c.corpo, id: 999 } } }),
    'GET /materiais/501': () => material(MATERIAL),
    'PATCH /materiais/501': (c) => material({ ...MATERIAL, ...c.corpo }),
    'GET /imagens-material': (c) => (s.lista ? s.lista(c) : listaOk(s.imagens)),
  };
  for (const id of [501, 999]) {
    rotas[`GET /materiais/${id}/estoque/lotes`] = () => ({ status: 200, corpo: { status: 'ok', material: MATERIAL, saldos: [], lotes: [], totais: {} } });
    rotas[`GET /materiais/${id}/minimos`] = () => ({ status: 200, corpo: { status: 'ok', material: MATERIAL, minimos: [], padrao: 0 } });
  }
  return { s, rotas };
}

/** Abre a página real de materiais já com a sessão confirmada. */
async function abrir(opcoes = {}) {
  const { s, rotas } = servidor(opcoes);
  const pg = abrirPagina(PAGINA, { rotas });
  await pg.esperar();
  return { pg, s };
}

// ───────────────────────── leitura do estado da tela ─────────────────────────

/** Último texto escrito no aviso da página (a página escreve o aviso por innerHTML, que o harness só registra). */
const avisoDaPagina = (pg) => {
  const uso = [...pg.documento.usosDeInnerHTML].reverse().find((u) => u.id === 'aviso');
  return uso ? uso.valor.replace(/<[^>]+>/g, '').trim() : '';
};

const chamadasLista = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /imagens-material');
const itens = (pg) => pg.consulta(`#${IDS.lista} [data-imagem-id]`);
const marcados = (pg) => pg.consulta(`#${IDS.lista} [aria-selected="true"]`);
const ids = (lista) => lista.map((e) => e.getAttribute('data-imagem-id'));

const CAMPOS_DO_FORMULARIO = Object.freeze(['materialNome', 'materialCategoria', 'materialCategoriaCustom', 'materialGrupoProtecao', 'materialGrupoProtecaoCustom', 'materialTipo',
  'materialTipoCustom', 'materialFabricante', 'materialCodigo', 'materialControleTamanho', 'materialGrade', 'materialUnidade', 'materialEstoqueMinimo', 'materialValidadeTipo',
  'materialPrazo', 'materialDesc', 'materialRegistrarEntrada']);

/** Valores e visibilidades do formulário que o novo campo não pode alterar. */
function estadoDoFormulario(pg) {
  const valores = {};
  for (const id of CAMPOS_DO_FORMULARIO) valores[id] = pg.el(id).value;
  return {
    valores,
    oculos: pg.el('materialOculosComGrau').checked,
    grade: pg.visivel('campoGradeTamanhos'),
    entradaInicial: pg.visivel('blocoEntradaInicial'),
    salvar: pg.visivel('botaoSalvar'),
    limpar: pg.visivel('botaoLimpar'),
    titulo: pg.texto('tituloFormulario'),
    edicao: pg.visivel('modoEdicao'),
  };
}

async function digitarNoFormulario(pg, id, valor, evento = 'input') {
  pg.el(id).value = valor;
  await pg.el(id).disparar(evento);
}

/** Preenche o menor cadastro válido ("Outros"); `controle`: 'unico' ou 'grade'. */
async function preencherCadastro(pg, { nome = 'Fita nova', controle = 'unico', grade = '' } = {}) {
  await digitarNoFormulario(pg, 'materialNome', nome);
  await digitarNoFormulario(pg, 'materialCategoria', 'Outros', 'change');
  await digitarNoFormulario(pg, 'materialCategoriaCustom', 'Ferramenta');
  await digitarNoFormulario(pg, 'materialTipoCustom', 'Fita isolante');
  await digitarNoFormulario(pg, 'materialControleTamanho', controle, 'change');
  if (grade) await digitarNoFormulario(pg, 'materialGrade', grade);
  await digitarNoFormulario(pg, 'materialValidadeTipo', 'meses', 'change');
  await digitarNoFormulario(pg, 'materialUnidade', 'Unidade', 'change');
  await digitarNoFormulario(pg, 'materialPrazo', '6');
  await digitarNoFormulario(pg, 'materialFabricante', 'Fab X');
}

/** Escolhe o material 501 no seletor do estoque e abre a edição dele. */
async function entrarNaEdicao(pg) {
  pg.el('gradeMaterial').value = '501';
  await pg.el('gradeMaterial').disparar('change');
  await pg.esperar();
  await pg.clicar('botaoEditarMaterial');
  await pg.esperar();
  assert.match(pg.texto('modoEdicao'), /Editando:/, 'a edição do material 501 não abriu');
}

// ───────────────────────── interação com o seletor ─────────────────────────

async function abrirSeletor(pg) {
  await pg.clicar(IDS.escolher);
  await pg.esperar();
  exigirSeletor(pg);
}

async function marcar(pg, indice) {
  await itens(pg)[indice].disparar('click');
}

async function confirmar(pg) {
  await pg.clicar(IDS.confirmar);
}

const pressionar = (elemento, key) => elemento.disparar('keydown', { key });

/** Falha de carregamento da imagem: o navegador dispara `error`; aceita tanto ouvinte quanto `onerror`. */
async function falharImagem(img) {
  if (typeof img.onerror === 'function') img.onerror({ type: 'error', target: img });
  await img.disparar('error');
}

/** Resposta que só sai quando `liberar()` for chamada (estado "carregando"). */
function segurar(resposta) {
  let liberar;
  const espera = new Promise((resolve) => { liberar = () => resolve(resposta); });
  return { espera, liberar };
}

// ───────────────────────── HTML estático do formulário (sem executar scripts) ─────────────────────────

const lerPagina = () => fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');

/** `pages/materials.html` como árvore, sem rodar nenhum script: só o que está escrito no HTML. */
function arvoreEstatica() {
  const semScripts = lerPagina().replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return abrirPagina(PAGINA, { html: semScripts }).documento;
}

const primeiroId = (no) => {
  if (no.id) return no.id;
  for (const filho of no.children) {
    const achado = primeiroId(filho);
    if (achado) return achado;
  }
  return null;
};

/** O `.form-grid` do cadastro (o primeiro de `#materialsView`). */
const formGridEstatico = () => arvoreEstatica().querySelector('#materialsView .form-grid');

/** Ordem dos blocos de primeiro nível do `.form-grid`, pelo primeiro id de cada um. */
const ordemDoFormulario = () => formGridEstatico().children.map(primeiroId);

function canonico(no, ignorar) {
  if (no.nodeType === 3) {
    const t = no.textContent.replace(/\s+/g, ' ').trim();
    return t === '' ? '' : JSON.stringify(t);
  }
  if (ignorar.includes(no.id)) return '';
  const atributos = Object.keys(no.atributos).sort().map((k) => `${k}=${JSON.stringify(no.atributos[k])}`).join(' ');
  return `<${no.localName}${atributos ? ` ${atributos}` : ''}>${no.filhos.map((f) => canonico(f, ignorar)).join('')}</${no.localName}>`;
}

/** SHA-256 do HTML do `.form-grid` (atributos ordenados, texto normalizado), sem o bloco do campo de imagem. */
const assinaturaDoFormulario = (ignorar = [IDS.campo]) => crypto.createHash('sha256').update(canonico(formGridEstatico(), ignorar)).digest('hex');

/** Quantas atribuições a `.innerHTML` há no último `<script>` da página (mesma contagem do teste de segurança da interface). */
const contarInnerHtmlDoScript = () => {
  const html = lerPagina();
  return [...html.slice(html.lastIndexOf('<script>')).matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].length;
};

/** Padrões que o módulo novo não pode usar: montagem de HTML por texto, código dinâmico, armazenamento do navegador e transporte próprio. */
const PROIBIDOS_DE_DOM = Object.freeze([/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew\s+Function\b/]);
const PROIBIDOS_DE_ARMAZENAMENTO = Object.freeze([/\blocalStorage\b/, /\bsessionStorage\b/, /\bdocument\.cookie\b/, /\bindexedDB\b/]);
const PROIBIDOS_DE_TRANSPORTE = Object.freeze([/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/]);

const lerModuloSemComentarios = () => semComentarios(fs.readFileSync(path.join(RAIZ, MODULO), 'utf8'));

module.exports = {
  RAIZ, API, PAGINA, MODULO, IDS, NOMES, NOME_HOSTIL, ID_GRANDE, TEXTO_DO_SERVIDOR, MATERIAL, TUDO,
  ORDEM_ATUAL_DO_FORMULARIO, ASSINATURA_ATUAL_DO_FORMULARIO, INNER_HTML_ATUAIS_NO_SCRIPT_DA_PAGINA, CAMPOS_DO_FORMULARIO,
  existeModulo, exigirModulo, exigirCampo, exigirSeletor,
  imagensPadrao, urlMiniatura, permissoes, listaOk, erroApi, servidor, abrir,
  avisoDaPagina, chamadasLista, itens, marcados, ids, estadoDoFormulario, digitarNoFormulario, preencherCadastro, entrarNaEdicao,
  abrirSeletor, marcar, confirmar, pressionar, falharImagem, segurar,
  arvoreEstatica, formGridEstatico, ordemDoFormulario, assinaturaDoFormulario, contarInnerHtmlDoScript, lerModuloSemComentarios,
  PROIBIDOS_DE_DOM, PROIBIDOS_DE_ARMAZENAMENTO, PROIBIDOS_DE_TRANSPORTE,
};
