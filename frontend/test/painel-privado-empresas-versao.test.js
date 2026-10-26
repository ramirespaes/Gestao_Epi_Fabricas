'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-painel');

/**
 * F3 — Concorrência entre o Painel Privado e o Portal Empresarial na edição da empresa.
 *
 * O formulário do Painel envia TODOS os campos cadastrais. Sem a `versao` carregada, uma edição antiga do Painel regrava, com valores
 * velhos, o que o Portal acabou de gravar (sobrescrita silenciosa). O servidor simulado aqui reproduz o contrato real de
 * PATCH /empresas/:id: `versao` opcional; presente e diferente da corrente => 409 EMPRESA_DADOS_DESATUALIZADOS sem gravar; qualquer
 * gravação efetiva avança a versão (gatilho do banco).
 */

const PAGINA = 'painel-privado/empresas.html';
const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const CAMPOS_DE_TESTE = ['telefone', 'cidade', 'nomeFantasia', 'bairro'];

function servidor(inicial = {}) {
  const estado = {
    versao: 7, telefone: '(54) 1111-0000', cidade: 'Caxias do Sul', nomeFantasia: 'Alfa', bairro: 'Centro', ...inicial,
  };
  const empresa = () => ({
    id: 3,
    razaoSocial: 'Empresa Alfa Ltda',
    cnpj: '11222333000181',
    ativo: true,
    versao: estado.versao,
    nomeFantasia: estado.nomeFantasia,
    telefone: estado.telefone,
    cidade: estado.cidade,
    bairro: estado.bairro,
    representante: {},
    financeiro: {},
  });
  const patches = [];
  const rotas = {
    'GET /auth/me': ok(),
    'GET /empresas': () => ok({ empresas: [empresa()], total: 1 }),
    'GET /empresas/3': () => ok({ empresa: empresa() }),
    'GET /empresas/3/provisionamento': ok({ prontaParaMaster: true, totais: { ADEQUADA: 1, INSERIDA: 0, AUSENTE: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0 } }),
    'GET /empresas/3/convites-master': ok({ convites: [] }),
    'PATCH /empresas/3': (chamada) => {
      const corpo = chamada.corpo;
      patches.push(corpo);
      if (Object.hasOwn(corpo, 'versao') && corpo.versao !== estado.versao) {
        return erro(409, 'EMPRESA_DADOS_DESATUALIZADOS', 'Os dados da empresa foram alterados por outra pessoa. Recarregue e tente novamente.');
      }
      for (const c of CAMPOS_DE_TESTE) if (Object.hasOwn(corpo, c)) estado[c] = corpo[c];
      estado.versao += 1;
      return ok({ empresa: empresa() });
    },
    'POST /empresas': () => ({ status: 201, corpo: { status: 'ok', empresa: empresa(), provisionamento: { prontaParaMaster: true } } }),
  };
  return { estado, rotas, patches };
}

async function abrir(srv) {
  const pg = abrirPagina(PAGINA, { rotas: srv.rotas });
  await pg.esperar();
  await pg.el('lista').disparar('click', { target: { closest: () => ({ getAttribute: () => '3' }) } });
  await pg.esperar();
  return pg;
}
const doPatch = (pg) => pg.chamadas.filter((c) => c.chave === 'PATCH /empresas/3');
const getsDaEmpresa = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /empresas/3');

describe('F3 — o Painel envia a versão que carregou', () => {
  test('o PATCH leva a versão do registro carregado no formulário', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    assert.equal(pg.el('telefone').value, '(54) 1111-0000', 'o formulário deveria mostrar o registro carregado');
    await pg.digitar('telefone', '(54) 2222-0000');
    await pg.enviar('form-empresa');
    const [chamada] = doPatch(pg);
    assert.ok(chamada, 'deveria ter havido um PATCH');
    assert.equal(chamada.corpo.versao, 7, 'o PATCH do Painel precisa levar a versão carregada (sem ela não há comparação-e-troca)');
    assert.equal(Object.hasOwn(chamada.corpo, 'cnpj'), false, 'o CNPJ nunca é enviado na edição');
    assert.equal(srv.estado.telefone, '(54) 2222-0000');
  });

  test('fluxo normal: salvar, recarregar o registro e usar a versão NOVA no salvamento seguinte', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await pg.digitar('telefone', '(54) 2222-0000');
    await pg.enviar('form-empresa');
    assert.equal(pg.el('msg-form').textContent, 'Alterações salvas.');
    assert.equal(srv.estado.versao, 8);
    await pg.digitar('cidade', 'Bento Gonçalves');
    await pg.enviar('form-empresa');
    const corpos = doPatch(pg).map((c) => c.corpo);
    assert.equal(corpos.length, 2);
    assert.equal(corpos[0].versao, 7);
    assert.equal(corpos[1].versao, 8, 'depois de salvar, o formulário deve carregar a versão nova e enviá-la no próximo PATCH');
    assert.equal(pg.el('msg-form').textContent, 'Alterações salvas.');
    assert.equal(srv.estado.cidade, 'Bento Gonçalves');
  });

  test('o corpo continua com todos os campos editáveis (inclui razão social, sem CNPJ) mais a versão', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await pg.digitar('bairro', 'Panazzolo');
    await pg.enviar('form-empresa');
    const corpo = doPatch(pg)[0].corpo;
    assert.equal(corpo.razaoSocial, 'Empresa Alfa Ltda');
    assert.equal(Object.hasOwn(corpo, 'cnpj'), false);
    assert.equal(corpo.bairro, 'Panazzolo');
    assert.equal(corpo.versao, 7);
  });

  test('cadastro de empresa nova (POST) não leva versão', async () => {
    const srv = servidor();
    const pg = abrirPagina(PAGINA, { rotas: srv.rotas });
    await pg.esperar();
    await pg.el('btn-nova').disparar('click');
    pg.el('razaoSocial').value = 'Nova Empresa Ltda';
    pg.el('cnpj').value = '11444777000161';
    await pg.enviar('form-empresa');
    const post = pg.chamadas.find((c) => c.chave === 'POST /empresas');
    assert.ok(post, 'deveria ter havido um POST');
    assert.equal(Object.hasOwn(post.corpo, 'versao'), false);
  });
});

describe('F3 — edição antiga do Painel x alteração mais recente do Portal', () => {
  async function conflito() {
    const srv = servidor();
    const pg = await abrir(srv);
    // O operador do Painel abriu o registro na versão 7. Depois disso o Portal grava telefone e cidade (versão 8).
    srv.estado.versao = 8;
    srv.estado.telefone = '(54) 9999-0000';
    srv.estado.cidade = 'Cidade do Portal';
    // O operador altera só o nome fantasia no formulário antigo.
    await pg.digitar('nomeFantasia', 'Alfa Painel');
    await pg.enviar('form-empresa');
    return { srv, pg };
  }

  test('os dados recentes do Portal NÃO são sobrescritos: o servidor recusa com 409 e nada é gravado', async () => {
    const { srv, pg } = await conflito();
    const [chamada] = doPatch(pg);
    assert.equal(chamada.corpo.versao, 7, 'o PATCH levou a versão antiga que o formulário tinha carregado');
    assert.equal(srv.estado.telefone, '(54) 9999-0000', 'o telefone gravado pelo Portal foi sobrescrito em silêncio');
    assert.equal(srv.estado.cidade, 'Cidade do Portal', 'a cidade gravada pelo Portal foi sobrescrita em silêncio');
    assert.equal(srv.estado.nomeFantasia, 'Alfa', 'nada do formulário antigo deveria ter sido gravado');
    assert.equal(srv.estado.versao, 8);
  });

  test('o conflito é explicado ao operador e o formulário passa a mostrar o registro atual (sem salvar nem repetir sozinho)', async () => {
    const { srv, pg } = await conflito();
    const texto = pg.el('msg-form').textContent;
    assert.match(texto, /alterados depois que você os abriu/, 'a tela deveria explicar o conflito');
    assert.match(texto, /Nada foi salvo/);
    assert.equal(pg.el('telefone').value, '(54) 9999-0000', 'o formulário deveria mostrar o telefone atual (do Portal)');
    assert.equal(pg.el('cidade').value, 'Cidade do Portal');
    assert.ok(getsDaEmpresa(pg).length >= 2, 'o registro deveria ter sido relido depois do 409');
    await pg.esperar();
    await pg.esperar();
    assert.equal(doPatch(pg).length, 1, 'não pode haver repetição automática do PATCH');
    assert.equal(srv.estado.versao, 8, 'nenhum salvamento automático');
    assert.equal(pg.el('btn-salvar').disabled, false, 'o operador pode tentar de novo, por ato próprio');
  });

  test('depois do conflito, um novo salvamento do operador usa a versão atual e é aceito', async () => {
    const { srv, pg } = await conflito();
    await pg.digitar('nomeFantasia', 'Alfa Painel');
    await pg.enviar('form-empresa');
    const corpos = doPatch(pg).map((c) => c.corpo);
    assert.equal(corpos.length, 2);
    assert.equal(corpos[1].versao, 8, 'o segundo PATCH deve levar a versão relida');
    assert.equal(srv.estado.nomeFantasia, 'Alfa Painel');
    assert.equal(srv.estado.telefone, '(54) 9999-0000', 'o telefone do Portal foi preservado porque o formulário foi recarregado antes');
    assert.equal(srv.estado.versao, 9);
  });

  test('outros erros (400) mantêm o comportamento de sempre: mensagem do servidor, sem recarregar', async () => {
    const srv = servidor();
    srv.rotas['PATCH /empresas/3'] = () => erro(400, 'VALIDACAO', 'Dados inválidos');
    const pg = await abrir(srv);
    const antes = getsDaEmpresa(pg).length;
    await pg.digitar('telefone', '1');
    await pg.enviar('form-empresa');
    assert.match(pg.el('msg-form').textContent, /Dados inválidos/);
    assert.equal(getsDaEmpresa(pg).length, antes, 'erro de validação não recarrega o registro');
    assert.equal(doPatch(pg).length, 1);
  });
});
