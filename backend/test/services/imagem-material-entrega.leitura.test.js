'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { HttpError } = require('../../src/errors/HttpError');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const { criarEntregaDeImagens } = require('../../src/services/imagem-material-entrega.service');
const { sha256Hex, webpFicticio } = require('../helpers/imagens-ficticias');

/**
 * Leitura do arquivo no serviço de entrega: a fronteira do teto de leitura e a falha que acontece DURANTE a leitura (depois de o arquivo ser
 * aberto). Sem banco e sem disco: repositório e armazenamento são simulados.
 */

const EXECUTOR = Object.freeze({ marca: 'executor-de-teste' });
const EMPRESA = 3;
const PEDIDO = Object.freeze({ empresaId: EMPRESA, origem: 'empresa', id: '7', variante: 'miniatura' });
const naoEncontrada = (e) => e instanceof HttpError && e.status === 404 && e.codigo === 'IMAGEM_NAO_ENCONTRADA';

/** Serviço sobre um armazenamento cujo `abrir` devolve o fluxo de `novoFluxo()`; `arquivo` define o SHA-256 registrado da miniatura. */
function montar(t, { arquivo, novoFluxo, limiteBytes }) {
  t.mock.method(imagemEmpresaRepo, 'buscarPorId', async () => ({
    id: '7', empresaId: EMPRESA, nome: 'Luva', sha256: sha256Hex('envio-leitura'), sha256Miniatura: sha256Hex(arquivo), sha256Exibicao: null, versao: 2, estado: 'ATIVA',
  }));
  const registros = [];
  const abertos = [];
  const armazenamento = { abrir: async () => { const fluxo = novoFluxo(); abertos.push(fluxo); return fluxo; }, existe: async () => true };
  const entrega = criarEntregaDeImagens({ armazenamento, registro: (etiqueta, campos) => registros.push({ etiqueta, campos }), limiteBytes });
  return { entrega, registros, abertos };
}

describe('[SRV-ENT] serviço de entrega — fronteira do teto e falha durante a leitura (ajuste da Unidade 5A-1)', () => {
  test('SRV-ENT-21 — o teto de leitura é INCLUSIVO: um arquivo com exatamente `limiteBytes` é entregue (em um bloco ou em vários); um byte acima é recusado como TAMANHO_EXCEDIDO', async (t) => {
    const arquivo = webpFicticio('fronteira', 60);
    const emBlocos = (n) => {
      const tamanho = Math.ceil(arquivo.length / n);
      return Array.from({ length: n }, (_, i) => arquivo.subarray(i * tamanho, (i + 1) * tamanho)).filter((bloco) => bloco.length > 0);
    };
    for (const blocos of [emBlocos(1), emBlocos(3)]) {
      const noTeto = montar(t, { arquivo, novoFluxo: () => Readable.from(blocos), limiteBytes: arquivo.length });
      assert.deepEqual((await noTeto.entrega.obter(EXECUTOR, PEDIDO)).corpo, arquivo, `${blocos.length} bloco(s), exatamente no teto`);
      assert.deepEqual(noTeto.registros, [], 'nada a registrar quando o arquivo cabe no teto');

      const acima = montar(t, { arquivo, novoFluxo: () => Readable.from(blocos), limiteBytes: arquivo.length - 1 });
      await assert.rejects(acima.entrega.obter(EXECUTOR, PEDIDO), naoEncontrada, `${blocos.length} bloco(s), um byte acima do teto`);
      assert.deepEqual(acima.registros.map((r) => r.campos.motivo), ['TAMANHO_EXCEDIDO']);
    }
  });

  test('SRV-ENT-22 — falha durante a LEITURA (o erro vem depois de o arquivo ser aberto) é erro de servidor genérico: nunca 404, nunca com o texto do erro; o fluxo é destruído e o registro leva só FALHA_ARMAZENAMENTO', async (t) => {
    const arquivo = webpFicticio('leitura', 60);
    const falha = Object.assign(new Error("EIO: i/o error, read '/var/segredo/imagens/3/abc/miniatura.webp'"), { code: 'EIO' });
    const cenarios = {
      'logo na primeira leitura': () => new Readable({ read() { this.destroy(falha); } }),
      'depois de um bloco entregue': () => {
        let leituras = 0;
        return new Readable({ highWaterMark: 16, read() { leituras += 1; if (leituras === 1) this.push(arquivo.subarray(0, 16)); else this.destroy(falha); } });
      },
    };
    for (const [quando, novoFluxo] of Object.entries(cenarios)) {
      const { entrega, registros, abertos } = montar(t, { arquivo, novoFluxo, limiteBytes: 1024 * 1024 });
      await assert.rejects(
        entrega.obter(EXECUTOR, PEDIDO),
        (e) => e instanceof HttpError && e.status === 500 && e.codigo === 'ERRO_INTERNO' && !/segredo|\/var\/|miniatura\.webp|EIO/.test(`${e.message} ${e.codigo}`),
        quando,
      );
      assert.deepEqual(registros.map((r) => r.campos.motivo), ['FALHA_ARMAZENAMENTO'], quando);
      assert.equal(abertos[0].destroyed, true, `${quando}: o fluxo foi destruído`);
    }
  });
});
