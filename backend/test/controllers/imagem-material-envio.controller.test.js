'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { criarImagemMaterialController } = require('../../src/controllers/imagem-material.controller');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Biblioteca de Imagens, Unidade 5C-2 — o `enviar` do controller, sem HTTP e sem banco: traduz a requisição em chamada ao serviço de envio e o resultado em
 * resposta. Empresa e ator saem SÓ de req.empresa e req.usuario (a sessão); o nome, só de req.validado.query; o corpo chega como Buffer (o que não for Buffer
 * vira um Buffer vazio, nunca um objeto); 201 para imagem nova, 200 para reaproveitada. Os erros do serviço sobem como estão (o errorHandler responde).
 */

const pool = Object.freeze({ marca: 'pool-de-teste' });
const IMAGEM = Object.freeze({
  origem: 'EMPRESA', id: '9007199254740993', nome: 'Luva', formato: 'PNG', largura: 320, altura: 320, versao: 1, estado: 'ATIVA',
});

function criarEnvioFalso(resultado = { imagem: IMAGEM, reaproveitada: false }) {
  const chamadas = [];
  return {
    chamadas,
    async enviar(executor, dados) {
      chamadas.push({ executor, dados });
      if (resultado instanceof Error) throw resultado;
      return resultado;
    },
  };
}

function criarResposta() {
  return {
    codigo: null,
    corpo: null,
    status(codigo) { this.codigo = codigo; return this; },
    json(corpo) { this.corpo = corpo; return this; },
  };
}

const requisicao = (extra = {}) => ({
  empresa: { id: 3 },
  usuario: { id: 9 },
  ip: '203.0.113.5',
  headers: { 'user-agent': 'Navegador X', 'x-empresa-id': '999', 'x-usuario-id': '888' },
  validado: { query: { nome: 'Luva' } },
  query: { nome: 'NAO-USAR', empresaId: '999' },
  body: Buffer.from('conteúdo da imagem'),
  ...extra,
});

const controllerCom = (envio) => criarImagemMaterialController({ pool, envio, entrega: null });

describe('controller — enviar (Unidade 5C-2)', () => {
  test('CTL-01 — chama o serviço com o executor, a empresa e o ator da sessão, o nome validado, os MESMOS bytes, o IP e o dispositivo', async () => {
    const envio = criarEnvioFalso();
    const req = requisicao();
    await controllerCom(envio).enviar(req, criarResposta());
    assert.equal(envio.chamadas.length, 1);
    const { executor, dados } = envio.chamadas[0];
    assert.equal(executor, pool);
    assert.deepEqual(Object.keys(dados).sort(), ['atorId', 'bytes', 'dispositivo', 'empresaId', 'ip', 'nome']);
    assert.deepEqual([dados.empresaId, dados.atorId, dados.nome, dados.ip, dados.dispositivo], [3, 9, 'Luva', '203.0.113.5', 'Navegador X']);
    assert.equal(dados.bytes, req.body, 'os bytes são os recebidos, sem cópia nem alteração');
  });

  test('CTL-02 — empresa, ator e nome NUNCA vêm de cabeçalho, de consulta não validada nem do que o cliente enviar', async () => {
    const envio = criarEnvioFalso();
    await controllerCom(envio).enviar(requisicao({ query: { nome: 'OUTRO', empresaId: '999', criadoPor: '888' } }), criarResposta());
    const { dados } = envio.chamadas[0];
    assert.deepEqual([dados.empresaId, dados.atorId, dados.nome], [3, 9, 'Luva']);
  });

  test('CTL-03 — o que não é Buffer (ausente, objeto, texto, Uint8Array) vira um Buffer VAZIO: o serviço nunca recebe outra coisa', async () => {
    for (const corpo of [undefined, null, {}, 'texto', new Uint8Array([1, 2, 3]), 42]) {
      const envio = criarEnvioFalso();
      await controllerCom(envio).enviar(requisicao({ body: corpo }), criarResposta());
      const { bytes } = envio.chamadas[0].dados;
      assert.equal(Buffer.isBuffer(bytes) && bytes.length === 0, true, `corpo ${typeof corpo}: ${JSON.stringify(corpo)}`);
    }
  });

  test('CTL-04 — 201 para imagem nova e 200 para reaproveitada; o corpo da resposta é só { status, imagem, reaproveitada }', async () => {
    const nova = criarResposta();
    await controllerCom(criarEnvioFalso({ imagem: IMAGEM, reaproveitada: false })).enviar(requisicao(), nova);
    assert.equal(nova.codigo, 201);
    assert.deepEqual(nova.corpo, { status: 'ok', imagem: IMAGEM, reaproveitada: false });
    const repetida = criarResposta();
    await controllerCom(criarEnvioFalso({ imagem: IMAGEM, reaproveitada: true })).enviar(requisicao(), repetida);
    assert.equal(repetida.codigo, 200);
    assert.deepEqual(repetida.corpo, { status: 'ok', imagem: IMAGEM, reaproveitada: true });
  });

  test('CTL-05 — erro do serviço sobe como está e o controller não escreve resposta nenhuma', async () => {
    const falha = new HttpError(409, 'IMAGEM_COTA_EXCEDIDA', 'A cota de imagens da empresa foi atingida');
    const resposta = criarResposta();
    await assert.rejects(controllerCom(criarEnvioFalso(falha)).enviar(requisicao(), resposta), (erro) => erro === falha);
    assert.deepEqual([resposta.codigo, resposta.corpo], [null, null]);
  });

  test('CTL-06 — envio: null (serviço indisponível) responde 503 IMAGENS_INDISPONIVEL pelo próprio serviço, sem processar nada', async () => {
    await assert.rejects(
      criarImagemMaterialController({ pool, envio: null, entrega: null }).enviar(requisicao(), criarResposta()),
      (erro) => erro.status === 503 && erro.codigo === 'IMAGENS_INDISPONIVEL',
    );
  });

  test('CTL-07 — o controller continua com as demais operações (nada foi perdido ao acrescentar o envio)', () => {
    const controller = controllerCom(criarEnvioFalso());
    for (const operacao of ['listar', 'renomear', 'inativar', 'reativar', 'excluir', 'entregar', 'enviar']) assert.equal(typeof controller[operacao], 'function', operacao);
  });
});
