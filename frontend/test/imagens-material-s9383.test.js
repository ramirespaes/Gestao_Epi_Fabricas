'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('./helpers/imagens-material-empresa');
const { FALHA, rejeitar, rejeicoesEscapadas } = require('./helpers/rejeicoes');

/**
 * Sonar S9383 (lote 04) — imagens do material: operações e releituras do gerenciamento iniciadas sem espera.
 * Uma rejeição inesperada não escapa: vira o aviso genérico da gestão, a falha da lista da gestão ou o estado da lista do seletor,
 * e a trava da operação é liberada. Fixtures sintéticas.
 */

const { H } = E;
const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }];
const abrirCom = () => E.abrir({ biblioteca: E.criarBiblioteca({ empresa: EMPRESA, proximoId: 6001 }) });
const GES = { lista: 'imagemGestaoLista', aviso: 'imagemGestaoAviso', estado: 'imagemGestaoEstado' };
const linhaDaGestao = (pg, nome) => pg.el(GES.lista).children.find((li) => E.normalizarTexto(E.textoVisivel(li)).includes(nome)) ?? null;
const botaoDaLinha = (linha, verbo) => linha.querySelectorAll('button').find((b) => E.nomeAcessivel(b).startsWith(verbo)) ?? null;
const M = (pg) => pg.janela.EpiImagensMaterial;

async function entrarNoGerenciar(pg) {
  await H.abrirSeletor(pg);
  await E.irParaAba(pg, 'Minha Empresa');
  await E.botaoPorNome(E.modal(pg), /^Gerenciar imagens$/).disparar('click');
  await E.aguardar(pg);
}
// Resposta cuja leitura falha: a única forma de a operação rejeitar, já que a chamada ao servidor tem try/catch próprio.
const respostaQueFalha = () => Promise.resolve({ get ok() { throw new Error(FALHA); } });

describe('S9383 (lote 04) — imagens do material', () => {
  test('S9383-I01 — inativar com falha inesperada: aviso genérico da gestão, trava liberada, nada escapa', async () => {
    const { pg } = await abrirCom();
    await entrarNoGerenciar(pg);
    M(pg).acoes.inativar = respostaQueFalha;
    const escapadas = await rejeicoesEscapadas(pg, async () => {
      await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Inativar').disparar('click');
      await E.aguardar(pg);
    });
    assert.deepEqual(escapadas, []);
    assert.match(E.normalizarTexto(pg.texto(GES.aviso)), new RegExp(M(pg).mensagens.TEXTOS.GESTAO_GENERICO));
    assert.equal(botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Inativar').disabled, false, 'a trava da operação foi liberada');
    assert.equal(pg.textoDoDom().includes(FALHA), false);
  });

  test('S9383-I02 — releitura depois de um conflito, com falha inesperada: a lista da gestão mostra a falha', async () => {
    const { pg } = await abrirCom();
    await entrarNoGerenciar(pg);
    M(pg).acoes.inativar = () => Promise.resolve({ ok: false, status: 409, codigo: 'CONFLITO_SINTETICO', dados: null });
    M(pg).acoes.listarTodas = rejeitar;
    const escapadas = await rejeicoesEscapadas(pg, async () => {
      await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Inativar').disparar('click');
      await E.aguardar(pg);
    });
    assert.deepEqual(escapadas, []);
    assert.match(E.normalizarTexto(pg.texto(GES.estado)), new RegExp(M(pg).mensagens.TEXTOS.GENERICO));
  });

  test('S9383-I03 — habilitar() volta das vistas com o tratamento da releitura (a página do material é referência visual fixada)', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', 'js/imagens-material.js'), 'utf8');
    const habilitar = codigo.slice(codigo.indexOf('function habilitar('), codigo.indexOf('function reiniciar('));
    assert.match(habilitar, /Promise\.resolve\(voltarBiblioteca\(\)\)\.catch\(aoFalharLista\(\)\)/);
    assert.match(habilitar, /Promise\.resolve\(voltarDaGestao\(\)\)\.catch\(aoFalharLista\(\)\)/);
  });
});
