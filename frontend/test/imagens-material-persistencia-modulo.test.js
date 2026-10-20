'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/imagens-material');
const EpiMateriais = require('../js/materiais');

/**
 * Unidade 5B-3 — texto próprio da recusa da imagem na gravação do material (módulo, sem DOM). Contrato lido no backend local: a imagem inexistente,
 * inativa ou de outra empresa é 404 `IMAGEM_NAO_ENCONTRADA` (diferente do 404 `MATERIAL_NAO_ENCONTRADO`), e a forma inválida é 400 com detalhe em
 * `body.imagem` (ou `body.imagem.id`, `body.imagem.origem`). Só esses dois casos são da imagem: nenhum outro 404 ou 400 é interpretado como tal.
 */

const deGravacao = () => {
  H.exigirModulo('mensagens.deGravacao');
  const f = require('../js/imagens-material').mensagens.deGravacao;
  assert.equal(typeof f, 'function', 'comportamento ausente: EpiImagensMaterial.mensagens.deGravacao (texto próprio da recusa da imagem ao gravar o material)');
  return f;
};

const resposta = (status, codigo, detalhes = null, mensagem = 'texto do servidor') => ({ ok: false, status, dados: null, codigo, mensagem, detalhes });
const detalhe = (campo, codigo = 'ID_INVALIDO') => ({ campo, codigo, mensagem: 'Identificador inválido' });

describe('5B-3 — mensagens.deGravacao: a recusa da imagem tem texto próprio e só ela', () => {
  test('404 IMAGEM_NAO_ENCONTRADA: texto da imagem, que não é o do material inexistente; os outros 404 não são da imagem', () => {
    const f = deGravacao();
    const texto = f(resposta(404, 'IMAGEM_NAO_ENCONTRADA'));
    assert.equal(typeof texto, 'string');
    assert.match(texto, /A imagem escolhida não está mais disponível/);
    assert.match(texto, /outra imagem/);
    assert.notEqual(texto, EpiMateriais.mensagens.MSG.NAO_ENCONTRADO);
    assert.doesNotMatch(texto, /Material não encontrado/i);
    for (const codigo of ['MATERIAL_NAO_ENCONTRADO', 'ROTA_NAO_ENCONTRADA', 'NAO_ENCONTRADO', 'IMAGEM_EM_USO', 'IMAGEM_QUALQUER', null, undefined]) {
      assert.equal(f(resposta(404, codigo)), null, `404 ${String(codigo)} não é da imagem`);
    }
    for (const status of [400, 403, 409, 500]) assert.equal(f(resposta(status, 'IMAGEM_NAO_ENCONTRADA')), null, `o código com status ${status} não é a recusa da imagem`);
  });

  test('400 com detalhe em body.imagem, body.imagem.id ou body.imagem.origem: texto da imagem; sem esse detalhe, ou com outro status, não', () => {
    const f = deGravacao();
    for (const campo of ['body.imagem', 'body.imagem.id', 'body.imagem.origem']) {
      const texto = f(resposta(400, 'VALIDACAO', [detalhe('body.nome', 'TAMANHO_MAXIMO'), detalhe(campo)]));
      assert.match(texto, /O servidor não aceitou a imagem escolhida/, campo);
      assert.match(texto, /outra imagem/, campo);
    }
    const semDetalheDaImagem = [null, undefined, [], [detalhe('body.nome', 'TAMANHO_MAXIMO')], [detalhe('body.imagemX')], [detalhe('body.imagens.id')], [detalhe('query.imagem')], [null], ['body.imagem']];
    for (const detalhes of semDetalheDaImagem) assert.equal(f(resposta(400, 'VALIDACAO', detalhes)), null, JSON.stringify(detalhes));
    assert.equal(f(resposta(409, 'VALIDACAO', [detalhe('body.imagem')])), null);
  });

  test('nunca devolve o texto do servidor e não quebra com respostas estranhas (rede, sessão, permissão, 5xx, JSON ilegível, sucesso)', () => {
    const f = deGravacao();
    const sujo = 'relation "imagens_padrao" does not exist';
    assert.doesNotMatch(f(resposta(404, 'IMAGEM_NAO_ENCONTRADA', null, sujo)), /relation|imagens_padrao/);
    assert.doesNotMatch(f(resposta(400, 'VALIDACAO', [{ campo: 'body.imagem', codigo: 'IMAGEM_INVALIDA', mensagem: sujo }], sujo)), /relation|imagens_padrao/);
    const outras = [undefined, null, {}, 'texto', 42, { ok: true, status: 200, dados: {} }, resposta(0, 'FALHA_DE_REDE'), resposta(401, 'NAO_AUTENTICADO'),
      resposta(403, 'PERMISSAO_NEGADA'), resposta(500, 'ERRO_INTERNO'), resposta(200, 'RESPOSTA_INVALIDA')];
    for (const r of outras) assert.equal(f(r), null, JSON.stringify(r));
  });
});
