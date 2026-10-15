'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * K2 — autoridade obrigatória dentro do serviço da solicitação de EPI, sem PostgreSQL. A política REAL (avaliarPermissaoAcao, a mesma
 * do middleware) roda dentro da transação do serviço; só os repositórios (dados) são simulados, com o estado de autoridade de cada
 * cenário: perfil, vínculo SST, concessão individual, bloqueio, linha de perfil. Nada aqui concede autoridade por atalho.
 *
 * Regras provadas: o MASTER nunca aprova, reprova nem encerra (nem com a linha de perfil, a concessão e o vínculo); quem não é MASTER
 * precisa do vínculo SST, da concessão da ação (cada ação que a decisão usa) e de nenhum bloqueio; a autodecisão é conferida ANTES; o
 * perfil vem da linha do ator no banco, nunca de argumento; a recusa é o mesmo 403 PERMISSAO_NEGADA e não grava nada.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const solicitacaoRepo = () => require('../../src/repositories/solicitacao-epi.repository');
const itemRepo = () => require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = () => require('../../src/repositories/solicitacao-epi-cobertura.repository');
const parRepo = () => require('../../src/repositories/estoque-par.repository');
const usuarioRepo = () => require('../../src/repositories/usuario.repository');
const funcionarioRepo = () => require('../../src/repositories/funcionario.repository');
const materialRepo = () => require('../../src/repositories/material.repository');
const auditoriaRepo = () => require('../../src/repositories/auditoria.repository');
const permissaoRepo = () => require('../../src/repositories/permissao.repository');

const APROVAR = 'APROVAR_SOLICITACAO';
const REPROVAR = 'REPROVAR_SOLICITACAO';
const ENCERRAR = 'ENCERRAR_SOLICITACAO';
const TRES_ACOES = [APROVAR, REPROVAR, ENCERRAR];
const MENSAGEM = 'Sem permissão para esta operação';
const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const MOMENTO = new Date('2026-10-02T13:00:00Z');
const ATOR = 8;
const EMPRESA = 42;

const cabecalho = (extra = {}) => ({
  id: 17, empresaId: EMPRESA, numero: 5, funcionarioId: 30, gheId: 9, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 7, status: 'PENDENTE',
  quantidadeItens: 1, observacao: null, chaveIdempotencia: CHAVE, requisicaoHash: 'a'.repeat(64), criadaEm: MOMENTO, decididaPor: null,
  decididaEm: null, canceladaPor: null, canceladaEm: null, justificativaCancelamento: null, entregueEm: null, encerradaPor: null, encerradaEm: null,
  justificativaEncerramento: null, ...extra,
});
const itemGravado = (extra = {}) => ({
  id: 1, empresaId: EMPRESA, solicitacaoId: 17, materialId: 30, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true,
  decisao: null, quantidadeAprovada: null, justificativaDecisao: null, quantidadeEntregue: 0, ...extra,
});
const posicao = (par) => ({
  materialId: par.materialId, tamanho: par.tamanho, fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0, semCobertura: 0,
});

/** Estado de autoridade do ator, lido pelos repositórios de permissão simulados. */
const estadoPadrao = (extra = {}) => ({
  perfil: 'ADMINISTRADOR', vinculoSst: true, concessoes: new Set(TRES_ACOES), bloqueios: new Set(), linhaDePerfil: new Set(), acaoAtiva: true, ...extra,
});

/**
 * Monta o mundo simulado de uma operação (decidir ou encerrar) e devolve o pool, a ordem das chamadas e o estado.
 * `aoLerAtor` roda quando o serviço lê o ator dentro da transação: é onde um teste revoga a autoridade DEPOIS da rota e ANTES da avaliação.
 */
function simular(t, { estado = estadoPadrao(), solicitacao = cabecalho(), aoLerAtor = null } = {}) {
  const ordem = [];
  const consultasDePermissao = [];
  const client = { query: async (texto) => { ordem.push(texto); return { rows: [] }; }, release: () => {} };
  const pool = { connect: async () => client };
  const marcar = (nome, fn) => async (...args) => { ordem.push(nome); return fn(...args); };
  const auditorias = [];
  const aprovada = (extra = {}) => cabecalho({ status: 'APROVADA', decididaPor: ATOR, decididaEm: MOMENTO, ...extra });

  t.mock.method(solicitacaoRepo(), 'travarPorId', marcar('travarPorId', async () => solicitacao));
  t.mock.method(usuarioRepo(), 'buscarPorId', marcar('ator', async (_c, empresaId, id) => {
    if (aoLerAtor) aoLerAtor(estado);
    return { id, empresaId, perfil: estado.perfil, ativo: true };
  }));
  t.mock.method(itemRepo(), 'listarPorSolicitacao', marcar('itens', async () => [itemGravado()]));
  t.mock.method(funcionarioRepo(), 'buscarPorIdParaEntrega', marcar('funcionario', async () => ({ id: 30, situacao: 'ATIVO', ativo: true })));
  t.mock.method(materialRepo(), 'listarPorIdsParaVinculo', marcar('materiais', async () => [{ id: 30, ativo: true }]));
  t.mock.method(parRepo(), 'travarPares', marcar('travarPares', async (_c, _e, pares) => pares));
  t.mock.method(itemRepo(), 'decidirTodos', marcar('decidirTodos', async (_c, _e, _s, itens) => itens.map((i) => ({ id: i.itemId }))));
  t.mock.method(solicitacaoRepo(), 'registrarDecisao', marcar('registrarDecisao', async (_c, _e, _s, { status }) => aprovada({ status })));
  t.mock.method(itemRepo(), 'listarPorSolicitacaoComEntregue', marcar('itensComEntregue', async () => [itemGravado({ decisao: 'APROVADO', quantidadeAprovada: 2 })]));
  t.mock.method(coberturaRepo(), 'listarCobertura', marcar('listarCobertura', async () => []));
  t.mock.method(coberturaRepo(), 'lerPosicoes', marcar('lerPosicoes', async (_c, _e, pares) => pares.map(posicao)));
  t.mock.method(solicitacaoRepo(), 'encerrar', marcar('encerrar', async () => aprovada({
    status: 'ENCERRADA', encerradaPor: ATOR, encerradaEm: MOMENTO, justificativaEncerramento: 'Trabalhador desligado',
  })));
  t.mock.method(auditoriaRepo(), 'registrar', marcar('auditoria', async (_c, registro) => { auditorias.push(registro); }));

  // Repositório de permissões: só dados. A decisão é da política real (middleware/autorizacao.avaliarPermissaoAcao).
  t.mock.method(permissaoRepo(), 'buscarConfiguracaoAcao', async (_c, codigo) => {
    ordem.push('autoridade');
    consultasDePermissao.push(codigo);
    return TRES_ACOES.includes(codigo) ? { ativo: estado.acaoAtiva, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' } : null;
  });
  t.mock.method(permissaoRepo(), 'buscarPermissaoAcao', async (_c, _e, _perfil, codigo) => (estado.linhaDePerfil.has(codigo) ? { permitido: true } : null));
  t.mock.method(permissaoRepo(), 'usuarioTemAutorizacaoIndividual', async (_c, _e, _u, codigo) => estado.concessoes.has(codigo));
  t.mock.method(permissaoRepo(), 'usuarioIntegraSst', async () => estado.vinculoSst);
  t.mock.method(permissaoRepo(), 'usuarioTemBloqueio', async (_c, _e, _u, codigo) => estado.bloqueios.has(codigo));
  t.mock.method(permissaoRepo(), 'buscarGrupoAcessoDoUsuario', async () => null);

  return { pool, ordem, auditorias, consultasDePermissao, estado };
}

const aprovarItem = (extra = {}) => ({ itemId: 1, decisao: 'APROVADO', ...extra });
const reprovarItem = (extra = {}) => ({ itemId: 1, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada', ...extra });
const dadosDeDecisao = (decisoes, extra = {}) => ({ empresaId: EMPRESA, atorId: ATOR, solicitacaoId: 17, decisoes, hoje: '2026-10-03', ...extra });
const dadosDeEncerramento = (extra = {}) => ({ empresaId: EMPRESA, atorId: ATOR, solicitacaoId: 17, justificativa: 'Trabalhador desligado', hoje: '2026-10-03', ...extra });

// Cada operação, com o estado em que a solicitação precisa estar e a(s) ação(ões) que ela exige.
const OPERACOES = {
  aprovar: {
    acoes: [APROVAR],
    solicitacao: (extra = {}) => cabecalho({ status: 'PENDENTE', ...extra }),
    executar: (pool, extra) => servico().decidirSolicitacao(pool, dadosDeDecisao([aprovarItem()], extra)),
  },
  reprovar: {
    acoes: [REPROVAR],
    solicitacao: (extra = {}) => cabecalho({ status: 'PENDENTE', ...extra }),
    executar: (pool, extra) => servico().decidirSolicitacao(pool, dadosDeDecisao([reprovarItem()], extra)),
  },
  encerrar: {
    acoes: [ENCERRAR],
    solicitacao: (extra = {}) => cabecalho({ status: 'APROVADA', decididaPor: 9, decididaEm: MOMENTO, ...extra }),
    executar: (pool, extra) => servico().encerrarSolicitacao(pool, dadosDeEncerramento(extra)),
  },
};
const GRAVADORAS = ['decidirTodos', 'registrarDecisao', 'encerrar', 'auditoria', 'travarPares'];
const dois = () => [itemGravado({ id: 1 }), itemGravado({ id: 2, materialId: 31 })];

async function esperarNegado(promessa) {
  await assert.rejects(promessa, (erro) => {
    assert.deepEqual([erro.status, erro.codigo, erro.message], [403, 'PERMISSAO_NEGADA', MENSAGEM]);
    return true;
  });
}

function semGravacao({ ordem, auditorias }, rotulo) {
  for (const gravadora of GRAVADORAS) assert.equal(ordem.includes(gravadora), false, `${rotulo}: não pode chamar ${gravadora}`);
  assert.equal(auditorias.length, 0, `${rotulo}: não audita`);
  assert.equal(ordem[ordem.length - 1], 'ROLLBACK', `${rotulo}: a transação é desfeita`);
}

describe('K2 — controles que já valem e devem continuar (SST com vínculo, concessão e sem bloqueio)', () => {
  test('a SST autorizada aprova, reprova e encerra', async (t) => {
    for (const [nome, op] of Object.entries(OPERACOES)) {
      const mundo = simular(t, { solicitacao: op.solicitacao() });
      await op.executar(mundo.pool);
      assert.equal(mundo.ordem[mundo.ordem.length - 1], 'COMMIT', nome);
      t.mock.restoreAll();
    }
  });

  test('a decisão mista (um item aprovado, outro reprovado) exige as duas ações e a SST com as duas a executa', async (t) => {
    const mundo = simular(t);
    itemRepo().listarPorSolicitacao.mock.mockImplementation(async () => dois());
    await servico().decidirSolicitacao(mundo.pool, dadosDeDecisao([aprovarItem({ itemId: 1 }), reprovarItem({ itemId: 2 })]));
    assert.equal(mundo.ordem[mundo.ordem.length - 1], 'COMMIT');
  });

  test('o pedido do Totem (origem AUTOATENDIMENTO, sem solicitante) é aprovado e reprovado normalmente pela SST autorizada', async (t) => {
    for (const op of [OPERACOES.aprovar, OPERACOES.reprovar]) {
      const mundo = simular(t, { solicitacao: op.solicitacao({ origemSolicitacao: 'AUTOATENDIMENTO', solicitanteUsuarioId: null }) });
      await op.executar(mundo.pool);
      assert.equal(mundo.ordem[mundo.ordem.length - 1], 'COMMIT');
      t.mock.restoreAll();
    }
  });

  test('o autoencerramento continua permitido à SST autorizada', async (t) => {
    const mundo = simular(t, { solicitacao: OPERACOES.encerrar.solicitacao({ solicitanteUsuarioId: ATOR }) });
    await OPERACOES.encerrar.executar(mundo.pool);
    assert.equal(mundo.auditorias[0].contexto.autoencerramento, true);
  });
});

describe('K2 — AUTODECISAO_PROIBIDA vem ANTES da nova checagem e vale para todo perfil', () => {
  test('quem criou não aprova nem reprova a própria, mesmo sem nenhuma autoridade e mesmo sendo MASTER: 403 AUTODECISAO_PROIBIDA', async (t) => {
    const estados = [
      estadoPadrao({ vinculoSst: false, concessoes: new Set() }),
      estadoPadrao({ perfil: 'MASTER', linhaDePerfil: new Set(TRES_ACOES) }),
      estadoPadrao(),
    ];
    for (const estado of estados) {
      for (const op of [OPERACOES.aprovar, OPERACOES.reprovar]) {
        const mundo = simular(t, { estado, solicitacao: op.solicitacao({ solicitanteUsuarioId: ATOR }) });
        await assert.rejects(op.executar(mundo.pool), (erro) => {
          assert.deepEqual([erro.status, erro.codigo], [403, 'AUTODECISAO_PROIBIDA']);
          return true;
        });
        semGravacao(mundo, 'autodecisão');
        assert.deepEqual(mundo.consultasDePermissao, [], 'a autodecisão é recusada antes de consultar a autoridade');
        t.mock.restoreAll();
      }
    }
  });
});

describe('K2 — o MASTER nunca aprova, reprova nem encerra, ainda que receba tudo indevidamente', () => {
  const comTudo = () => estadoPadrao({
    perfil: 'MASTER', linhaDePerfil: new Set(TRES_ACOES), concessoes: new Set(TRES_ACOES), vinculoSst: true,
  });

  for (const [nome, op] of Object.entries(OPERACOES)) {
    test(`MASTER com a linha de perfil, a concessão individual e o vínculo SST: ${nome} é 403 PERMISSAO_NEGADA, sem gravar nada`, async (t) => {
      const mundo = simular(t, { estado: comTudo(), solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });

    test(`MASTER só com a linha de perfil (a forma de o avaliador genérico o deixaria passar): ${nome} é 403 PERMISSAO_NEGADA`, async (t) => {
      const estado = estadoPadrao({ perfil: 'MASTER', linhaDePerfil: new Set(op.acoes), concessoes: new Set(), vinculoSst: false });
      const mundo = simular(t, { estado, solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });
  }

  test('a decisão mista também é negada ao MASTER', async (t) => {
    const mundo = simular(t, { estado: comTudo() });
    itemRepo().listarPorSolicitacao.mock.mockImplementation(async () => dois());
    await esperarNegado(servico().decidirSolicitacao(mundo.pool, dadosDeDecisao([aprovarItem({ itemId: 1 }), reprovarItem({ itemId: 2 })])));
    semGravacao(mundo, 'mista');
  });

  test('o perfil vem da linha do ator no banco, nunca de argumento: perfil ADMINISTRADOR informado pelo chamador não esconde o MASTER', async (t) => {
    const mundo = simular(t, { estado: comTudo() });
    await esperarNegado(OPERACOES.aprovar.executar(mundo.pool, { perfil: 'ADMINISTRADOR', ator: { perfil: 'ADMINISTRADOR' } }));
    semGravacao(mundo, 'perfil de argumento');
  });
});

describe('K2 — quem não é MASTER precisa de vínculo SST, concessão efetiva da ação e nenhum bloqueio', () => {
  for (const [nome, op] of Object.entries(OPERACOES)) {
    test(`${nome}: sem vínculo SST (mesmo com a concessão e com a linha de perfil) é 403 PERMISSAO_NEGADA`, async (t) => {
      const mundo = simular(t, { estado: estadoPadrao({ vinculoSst: false, linhaDePerfil: new Set(TRES_ACOES) }), solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });

    test(`${nome}: sem a concessão da ação (mesmo com o vínculo e com a linha de perfil; em modo OBRIGATORIA o perfil não basta) é 403 PERMISSAO_NEGADA`, async (t) => {
      const estado = estadoPadrao({ concessoes: new Set(TRES_ACOES.filter((a) => !op.acoes.includes(a))), linhaDePerfil: new Set(TRES_ACOES) });
      const mundo = simular(t, { estado, solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });

    test(`${nome}: bloqueio individual da ação prevalece sobre a concessão e o vínculo: 403 PERMISSAO_NEGADA`, async (t) => {
      const mundo = simular(t, { estado: estadoPadrao({ bloqueios: new Set(op.acoes) }), solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });

    test(`${nome}: ação inativa no catálogo nega (a política real fecha)`, async (t) => {
      const mundo = simular(t, { estado: estadoPadrao({ acaoAtiva: false }), solicitacao: op.solicitacao() });
      await esperarNegado(op.executar(mundo.pool));
      semGravacao(mundo, nome);
    });

    test(`${nome}: a autoridade é reavaliada DENTRO da transação; revogada depois da rota e antes da avaliação (vínculo, concessão ou bloqueio novo), é negada`, async (t) => {
      const revogacoes = [
        (estado) => { estado.vinculoSst = false; },
        (estado) => { estado.concessoes = new Set(); },
        (estado) => { estado.bloqueios = new Set(op.acoes); },
      ];
      for (const revogar of revogacoes) {
        const mundo = simular(t, { aoLerAtor: revogar, solicitacao: op.solicitacao() });
        await esperarNegado(op.executar(mundo.pool));
        semGravacao(mundo, nome);
        t.mock.restoreAll();
      }
    });
  }

  test('a decisão mista exige AS DUAS ações: só com APROVAR (ou só com REPROVAR) é 403 PERMISSAO_NEGADA', async (t) => {
    for (const concedida of [APROVAR, REPROVAR]) {
      const mundo = simular(t, { estado: estadoPadrao({ concessoes: new Set([concedida]) }) });
      itemRepo().listarPorSolicitacao.mock.mockImplementation(async () => dois());
      await esperarNegado(servico().decidirSolicitacao(mundo.pool, dadosDeDecisao([aprovarItem({ itemId: 1 }), reprovarItem({ itemId: 2 })])));
      semGravacao(mundo, `mista só com ${concedida}`);
      t.mock.restoreAll();
    }
  });

  test('a ação exigida é a do que a decisão faz: aprovar não pede REPROVAR e reprovar não pede APROVAR', async (t) => {
    const soAprovar = simular(t, { estado: estadoPadrao({ concessoes: new Set([APROVAR]) }) });
    await OPERACOES.aprovar.executar(soAprovar.pool);
    assert.deepEqual([...new Set(soAprovar.consultasDePermissao)], [APROVAR]);
    t.mock.restoreAll();
    const soReprovar = simular(t, { estado: estadoPadrao({ concessoes: new Set([REPROVAR]) }) });
    await OPERACOES.reprovar.executar(soReprovar.pool);
    assert.deepEqual([...new Set(soReprovar.consultasDePermissao)], [REPROVAR]);
  });
});

describe('K2 — a ordem preserva os erros existentes e a proteção não é opcional', () => {
  test('a recusa usa o código e a mensagem que a rota já usa (contrato HTTP preservado)', () => {
    const { MENSAGEM_PERMISSAO_NEGADA } = require('../../src/middleware/autorizacao');
    assert.equal(MENSAGEM_PERMISSAO_NEGADA, MENSAGEM);
  });

  test('solicitação inexistente e ator inativo continuam recusados antes da autoridade (mesmos códigos)', async (t) => {
    const semSolicitacao = simular(t);
    solicitacaoRepo().travarPorId.mock.mockImplementation(async () => null);
    await assert.rejects(OPERACOES.aprovar.executar(semSolicitacao.pool), (erro) => [erro.status, erro.codigo].join() === '404,SOLICITACAO_NAO_ENCONTRADA');
    assert.deepEqual(semSolicitacao.consultasDePermissao, []);
    t.mock.restoreAll();
    const inativo = simular(t);
    usuarioRepo().buscarPorId.mock.mockImplementation(async (_c, empresaId, id) => ({ id, empresaId, perfil: 'ADMINISTRADOR', ativo: false }));
    await assert.rejects(OPERACOES.aprovar.executar(inativo.pool), (erro) => [erro.status, erro.codigo].join() === '403,USUARIO_INATIVO');
    assert.deepEqual(inativo.consultasDePermissao, []);
  });

  test('a autoridade é avaliada depois de ler o ator e antes de ler os itens e de gravar', async (t) => {
    const mundo = simular(t);
    await OPERACOES.aprovar.executar(mundo.pool);
    const passos = mundo.ordem.filter((x) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(x));
    assert.deepEqual(passos.slice(0, 4), ['travarPorId', 'ator', 'autoridade', 'itens']);
  });

  test('estática: não há como omitir a proteção — nenhum parâmetro de autorização, o avaliador é o do middleware e as duas operações a exigem', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'solicitacao-epi.service.js'), 'utf8');
    assert.ok(/require\('\.\.\/middleware\/autorizacao'\)/.test(fonte), 'usa o avaliador central');
    assert.equal((fonte.match(/exigirAutoridadeDaSolicitacao\(/g) ?? []).length >= 3, true, 'definição e uso em decidir e encerrar');
    for (const funcao of ['decidirSolicitacao', 'encerrarSolicitacao']) {
      const corpo = fonte.slice(fonte.indexOf(`async function ${funcao}(`));
      const assinatura = corpo.slice(0, corpo.indexOf('}) {'));
      assert.equal(/autoriz|permiss|autoridade|perfil/i.test(assinatura), false, `${funcao}: a assinatura não aceita autorização nem perfil do chamador`);
      assert.ok(corpo.slice(0, corpo.indexOf('\n}\n')).includes('exigirAutoridadeDaSolicitacao('), `${funcao} exige a autoridade`);
    }
  });
});
