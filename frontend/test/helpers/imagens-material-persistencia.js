'use strict';

const assert = require('node:assert/strict');
const { abrirPagina } = require('./dom-pagina');
const H = require('./imagens-material');

/**
 * Apoio dos testes da Unidade 5B-3 (persistência da imagem do material). Constrói, sobre o servidor simulado da 5B, uma API de materiais COM ESTADO que
 * segue o contrato lido no backend local (schemas/material.schema.js e services/material.service.js):
 *   - `imagem` ausente = não mexe; `null` = remove; `{ origem, id }` = associa, com exatamente essas duas chaves e o id em texto decimal canônico;
 *   - imagem que não existe na biblioteca = 404 IMAGEM_NAO_ENCONTRADA ("Imagem não encontrada"), diferente do 404 MATERIAL_NAO_ENCONTRADO;
 *   - forma inválida = 400 VALIDACAO com detalhe em `body.imagem`;
 *   - POST, PATCH e GET devolvem `imagem: null | { origem, id, versao, nome }`.
 * O corpo gerado pela página também é conferido contra o schema REAL do backend (Zod), sem PostgreSQL.
 */

const schemasDoBackend = require('../../../backend/src/schemas/material.schema');

const IMAGENS = H.imagensPadrao();
const registro = (imagem) => ({ origem: imagem.origem, id: imagem.id, versao: imagem.versao, nome: imagem.nome });
const ID_CANONICO = /^[1-9][0-9]*$/;

const erro400 = (campo, codigo, mensagem) => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'Dados inválidos', detalhes: [{ campo, codigo, mensagem }] } });
const erroDe = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const ERRO_IMAGEM_NAO_ENCONTRADA = () => erroDe(404, 'IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada');
const ERRO_MATERIAL_NAO_ENCONTRADO = () => erroDe(404, 'MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');

/** Mesma decisão do servidor sobre o campo `imagem` do corpo. */
function lerImagemDoCorpo(corpo, imagens) {
  if (!Object.hasOwn(corpo, 'imagem')) return { imagem: undefined };
  const v = corpo.imagem;
  if (v === null) return { imagem: null };
  const recusa = () => ({ resposta: erro400('body.imagem', 'IMAGEM_INVALIDA', 'Imagem do material inválida') });
  if (typeof v !== 'object' || Array.isArray(v)) return recusa();
  if (Object.keys(v).sort().join(',') !== 'id,origem') return recusa();
  if (!['PADRAO', 'EMPRESA'].includes(v.origem) || typeof v.id !== 'string' || !ID_CANONICO.test(v.id)) return recusa();
  const achada = v.origem === 'PADRAO' ? imagens.find((i) => i.id === v.id) : undefined;
  if (!achada) return { resposta: ERRO_IMAGEM_NAO_ENCONTRADA() };
  return { imagem: registro(achada) };
}

/**
 * `imagemInicial`: imagem gravada no material 501 (registro { origem, id, versao, nome }) ou null. `outros`: materiais extras (ex.: o 502).
 * `respostas`: 'METODO /caminho' -> resposta | função(chamada, regraPadrao) | Error, que vence a regra padrão (a função pode delegar à `regraPadrao`).
 */
function servidorDeMateriais({ imagens = IMAGENS, imagemInicial = null, p = H.permissoes(), outros = [], respostas = {} } = {}) {
  const estado = { materiais: new Map(), proximoId: 999 };
  estado.materiais.set(501, { ...H.MATERIAL, imagem: imagemInicial });
  for (const m of outros) estado.materiais.set(m.id, { ...m });
  const { rotas } = H.servidor({ p, imagens });
  const lista = () => [...estado.materiais.values()];
  const material = (m) => ({ status: 200, corpo: { status: 'ok', material: m } });
  const padrao = {
    'GET /materiais': () => ({ status: 200, corpo: { status: 'ok', materiais: lista(), total: lista().length, pagina: 1, limite: 100 } }),
    'POST /materiais': (c) => {
      const lida = lerImagemDoCorpo(c.corpo, imagens);
      if (lida.resposta) return lida.resposta;
      const { imagem: _fora, tamanhos, ...demais } = c.corpo;
      const criado = { ...H.MATERIAL, ...demais, id: estado.proximoId, tamanhos: tamanhos ?? [], imagem: lida.imagem ?? null };
      estado.proximoId += 1;
      estado.materiais.set(criado.id, criado);
      return { status: 201, corpo: { status: 'ok', material: criado } };
    },
  };
  // Ids de materiais que a página pode pedir: os fixos (501 a 510) e os que o POST cria (a partir de 999).
  const idsDeMateriais = [...Array(10).keys()].map((k) => 501 + k).concat([...Array(7).keys()].map((k) => 999 + k));
  for (const id of idsDeMateriais) {
    padrao[`GET /materiais/${id}`] = () => (estado.materiais.has(id) ? material(estado.materiais.get(id)) : ERRO_MATERIAL_NAO_ENCONTRADO());
    padrao[`PATCH /materiais/${id}`] = (c) => {
      if (!estado.materiais.has(id)) return ERRO_MATERIAL_NAO_ENCONTRADO();
      if (Object.keys(c.corpo).length === 0) return erroDe(400, 'MATERIAL_SEM_ALTERACAO', 'Nenhum campo informado');
      const lida = lerImagemDoCorpo(c.corpo, imagens);
      if (lida.resposta) return lida.resposta;
      const { imagem: _fora, ...demais } = c.corpo;
      const atualizado = { ...estado.materiais.get(id), ...demais, ...(lida.imagem === undefined ? {} : { imagem: lida.imagem }) };
      estado.materiais.set(id, atualizado);
      return material(atualizado);
    };
    padrao[`GET /materiais/${id}/estoque/lotes`] = () => ({ status: 200, corpo: { status: 'ok', material: estado.materiais.get(id) ?? H.MATERIAL, saldos: [], lotes: [], totais: {} } });
    padrao[`GET /materiais/${id}/minimos`] = () => ({ status: 200, corpo: { status: 'ok', material: H.MATERIAL, minimos: [], padrao: 0 } });
  }
  const base = { ...rotas, ...padrao };
  Object.assign(rotas, base);
  for (const [chave, r] of Object.entries(respostas)) rotas[chave] = typeof r === 'function' ? (c) => r(c, base[chave]) : r;
  return { rotas, estado, padrao: base };
}

/** Abre a página real de materiais sobre a API com estado. */
async function abrir(opcoes = {}) {
  const sv = servidorDeMateriais(opcoes);
  const pg = abrirPagina(H.PAGINA, { rotas: sv.rotas });
  await pg.esperar();
  return { pg, ...sv };
}

/** Como `H.entrarNaEdicao`, para o material de id `id` (o 501 é o dela). */
async function entrarNaEdicaoDe(pg, id) {
  pg.el('gradeMaterial').value = String(id);
  await pg.el('gradeMaterial').disparar('change');
  await pg.esperar();
  await pg.clicar('botaoEditarMaterial');
  await pg.esperar();
  assert.match(pg.texto('modoEdicao'), /Editando:/, `a edição do material ${id} não abriu`);
}

const posts = (pg) => pg.chamadas.filter((c) => c.metodo === 'POST');
const patches = (pg) => pg.chamadas.filter((c) => c.metodo === 'PATCH');
const escritas = (pg) => pg.chamadas.filter((c) => c.metodo !== 'GET');

/** Abre o seletor, marca a imagem de índice `indice` da biblioteca e confirma (a escolha ainda vale só no formulário). */
async function escolherImagem(pg, indice) {
  await H.abrirSeletor(pg);
  await H.marcar(pg, indice);
  await H.confirmar(pg);
}

/** Sem imagem no campo: estado vazio, nenhuma miniatura e sem "Remover seleção". */
function semImagem(pg) {
  assert.match(pg.texto(H.IDS.estado), /Nenhuma imagem selecionada/);
  assert.equal(pg.consulta(`#${H.IDS.previa} img`).length, 0, 'sem miniatura no campo');
  assert.equal(pg.visivel(H.IDS.remover), false, '"Remover seleção" oculto');
}

/** Com a imagem no campo: nome, miniatura pela rota autenticada (com a versão) e "Remover seleção". */
function comImagem(pg, imagem) {
  const estado = pg.texto(H.IDS.estado);
  assert.ok(estado.includes(imagem.nome), `o campo mostra "${imagem.nome}" (mostrou: ${estado})`);
  const miniaturas = pg.consulta(`#${H.IDS.previa} img`);
  assert.equal(miniaturas.length, 1, 'uma miniatura no campo');
  assert.equal(miniaturas[0].getAttribute('src'), H.urlMiniatura(imagem));
  assert.equal(pg.visivel(H.IDS.remover), true, '"Remover seleção" visível');
}

/** O corpo é aceito pelo schema REAL do backend: `que` = 'criar' | 'alterar'. */
function aceitoPeloBackend(que, corpo) {
  const r = schemasDoBackend[que].body.safeParse(corpo);
  assert.equal(r.success, true, `o schema do backend (${que}) recusou o corpo: ${r.success ? '' : JSON.stringify(r.error.issues.map((i) => `${i.path.join('.')}:${i.params?.codigo ?? i.code}`))}`);
  return r.data;
}

const CORPO_TAMANHO_UNICO = (nome) => ({
  nome, categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Fita isolante', fabricante: 'Fab X', unidade: 'unidade', prazoUsoDias: 180, exigeTamanho: false,
});

module.exports = {
  IMAGENS, registro, erro400, erroDe, ERRO_IMAGEM_NAO_ENCONTRADA, ERRO_MATERIAL_NAO_ENCONTRADO, lerImagemDoCorpo, servidorDeMateriais, abrir,
  posts, patches, escritas, entrarNaEdicaoDe, escolherImagem, semImagem, comImagem, aceitoPeloBackend, CORPO_TAMANHO_UNICO,
};
