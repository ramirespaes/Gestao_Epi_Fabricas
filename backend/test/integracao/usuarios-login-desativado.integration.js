'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');

/** Etapa A do fechamento: login de usuário desativado x credencial incorreta (anti-enumeração preservada). */
const GENERICO = { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' };

describe('login — usuário desativado (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => { g = await montar(); master = await g.contaDaEmpresa(g.empresas.A); });
  after(async () => { if (g) await g.encerrar(); });
  const acao = (id, nome) => g.request(g.app).post(`/api/administracao/usuarios/${id}/${nome}`).set('Cookie', g.cookie(master)).send({});

  test('credencial errada é SEMPRE a mesma resposta (e-mail inexistente, senha errada, desativado com senha errada); credencial certa de desativado diz USUARIO_DESATIVADO; reativar volta a entrar; senha provisória segue valendo', async () => {
    const u = await g.usuarioPronto(master, {}, { definitiva: false });
    const inexistente = await g.login('ninguem.existe@example.invalid', 'senha-qualquer-77-xyz');
    const errada = await g.login(u.email, 'senha-errada-qualquer-77');
    assert.deepEqual([inexistente.status, inexistente.body], [401, GENERICO]);
    assert.deepEqual([errada.status, errada.body], [401, GENERICO]);

    const ativo = await g.login(u.email, g.SENHA_PROVISORIA);
    assert.deepEqual([ativo.status, ativo.body.identidade.trocaSenhaObrigatoria], [200, true], 'provisória continua: login normal com troca obrigatória');

    assert.equal((await acao(u.id, 'inativar')).status, 200);
    const desativadoErrada = await g.login(u.email, 'senha-errada-qualquer-77');
    assert.deepEqual([desativadoErrada.status, desativadoErrada.body], [401, GENERICO], 'desativado + senha errada: nada é revelado');
    const desativado = await g.login(u.email, g.SENHA_PROVISORIA);
    assert.deepEqual([desativado.status, desativado.body.codigo, desativado.body.message], [401, 'USUARIO_DESATIVADO', 'Usuário desativado. Procure o administrador da empresa.']);
    assert.equal('set-cookie' in desativado.headers, false);

    assert.equal((await acao(u.id, 'reativar')).status, 200);
    const volta = await g.login(u.email, g.SENHA_PROVISORIA);
    assert.deepEqual([volta.status, volta.body.identidade.trocaSenhaObrigatoria], [200, true]);
  });
});
