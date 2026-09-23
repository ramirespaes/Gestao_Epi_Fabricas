'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/catalogo.service');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const autoridade = require('../../src/services/autoridade-administrativa');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de leitura do catálogo de ações (Subetapa
 * 3T), sem PostgreSQL real.
 *
 * O que este serviço precisa garantir, e é o que se verifica aqui:
 *   1. sem autoridade administrativa de permissões de grupo, 403 — e o
 *      catálogo NÃO é lido (a recusa vem antes de qualquer consulta);
 *   2. a autoridade exigida é a de LEITURA (sem travar registros) e é
 *      exatamente ADMINISTRAR_PERMISSOES_GRUPO, não outra;
 *   3. empresa e ator chegam do chamador e são verificados;
 *   4. o catálogo devolvido é o do repositório, sem filtro nem
 *      reordenação — inclusive as ações inativas, que a tela precisa
 *      distinguir;
 *   5. nada é escrito e nada é auditado: consultar catálogo não é evento
 *      de auditoria.
 */

const EMPRESA = 42;
const ATOR = 7;

const CATALOGO = Object.freeze([
  Object.freeze({ codigo: 'ADMINISTRAR_PERMISSOES_GRUPO', nome: 'Administrar permissões de grupo', descricao: null, ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'OBRIGATORIA' }),
  Object.freeze({ codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', descricao: null, ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' }),
  Object.freeze({ codigo: 'ACAO_DESATIVADA', nome: 'Desativada', descricao: null, ativo: false, exigeSst: true, modoAutorizacaoIndividual: 'NENHUMA' }),
]);

// O pool nunca é usado de verdade: autoridade e repositório estão
// substituídos. Fica registrando o que receberia, para provar que este
// serviço não abre transação nem executa SQL por conta própria.
function criarPoolFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    connect: async () => { chamadas.push('CONNECT'); throw new Error('este serviço não deve abrir transação'); },
  };
}

function comAutoridade(t, { concede = true } = {}) {
  const recebido = [];
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativaLeitura', async (executor, empresaId, atorId, codigo, mensagem, acao) => {
    recebido.push({ executor, empresaId, atorId, codigo, mensagem, acao });
    if (!concede) throw HttpError.forbidden(codigo, mensagem);
    return { id: atorId, empresa_id: empresaId, perfil: 'ADMINISTRADOR', ativo: true };
  });
  // O caminho de escrita não pode ser usado por uma consulta: se alguém
  // o chamar aqui, o teste quebra em vez de passar silenciosamente.
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => {
    throw new Error('consulta de catálogo não deve usar o caminho de escrita da autoridade');
  });
  return recebido;
}

function comCatalogo(t, linhas = CATALOGO) {
  const chamadas = [];
  t.mock.method(permissaoRepo, 'listarAcoes', async (executor) => {
    chamadas.push(executor);
    return linhas.map((linha) => ({ ...linha }));
  });
  return chamadas;
}

describe('catalogo.service.listarAcoes — autoridade', () => {
  test('sem autoridade administrativa responde 403 CATALOGO_NAO_AUTORIZADO', async (t) => {
    comAutoridade(t, { concede: false });
    comCatalogo(t);

    await assert.rejects(
      () => servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }),
      (erro) => {
        assert.ok(erro instanceof HttpError);
        assert.equal(erro.status, 403);
        assert.equal(erro.codigo, 'CATALOGO_NAO_AUTORIZADO');
        return true;
      },
    );
  });

  test('recusa acontece ANTES de ler o catálogo', async (t) => {
    comAutoridade(t, { concede: false });
    const leituras = comCatalogo(t);

    await assert.rejects(() => servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }));

    assert.equal(leituras.length, 0);
  });

  test('exige ADMINISTRAR_PERMISSOES_GRUPO, pela variante de leitura, com empresa e ator recebidos', async (t) => {
    const recebido = comAutoridade(t);
    comCatalogo(t);
    const pool = criarPoolFalso();

    await servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: ATOR });

    assert.equal(recebido.length, 1);
    assert.equal(recebido[0].empresaId, EMPRESA);
    assert.equal(recebido[0].atorId, ATOR);
    assert.equal(recebido[0].acao, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);
    assert.equal(recebido[0].codigo, 'CATALOGO_NAO_AUTORIZADO');
    assert.equal(recebido[0].executor, pool);
  });

  test('empresa e ator inválidos são recusados antes da autoridade', async (t) => {
    const recebido = comAutoridade(t);
    comCatalogo(t);

    for (const argumentos of [
      { empresaId: 0, atorId: ATOR },
      { empresaId: -1, atorId: ATOR },
      { empresaId: 1.5, atorId: ATOR },
      { empresaId: null, atorId: ATOR },
      { empresaId: EMPRESA, atorId: 0 },
      { empresaId: EMPRESA, atorId: undefined },
      { empresaId: EMPRESA, atorId: '7' },
    ]) {
      await assert.rejects(() => servico.listarAcoes(criarPoolFalso(), argumentos), TypeError);
    }

    assert.equal(recebido.length, 0);
  });
});

describe('catalogo.service.listarAcoes — conteúdo', () => {
  test('devolve o catálogo do repositório, na mesma ordem e sem filtrar', async (t) => {
    comAutoridade(t);
    comCatalogo(t);

    const acoes = await servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(acoes.map((a) => a.codigo), CATALOGO.map((a) => a.codigo));
  });

  test('inclui ações inativas, com ativo e modo preservados', async (t) => {
    comAutoridade(t);
    comCatalogo(t);

    const acoes = await servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });
    const desativada = acoes.find((a) => a.codigo === 'ACAO_DESATIVADA');

    assert.equal(desativada.ativo, false);
    assert.equal(desativada.exigeSst, true);
    assert.equal(desativada.modoAutorizacaoIndividual, 'NENHUMA');
  });

  test('catálogo vazio devolve lista vazia', async (t) => {
    comAutoridade(t);
    comCatalogo(t, []);

    assert.deepEqual(await servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }), []);
  });

  test('não abre transação e não executa SQL próprio: só o repositório consulta', async (t) => {
    comAutoridade(t);
    const leituras = comCatalogo(t);
    const pool = criarPoolFalso();

    await servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(pool.chamadas, []);
    assert.deepEqual(leituras, [pool]);
  });

  test('erro inesperado do repositório propaga sem virar 403', async (t) => {
    comAutoridade(t);
    t.mock.method(permissaoRepo, 'listarAcoes', async () => { throw new Error('conexão perdida'); });

    await assert.rejects(
      () => servico.listarAcoes(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }),
      (erro) => {
        assert.equal(erro instanceof HttpError, false);
        assert.match(erro.message, /conexão perdida/);
        return true;
      },
    );
  });
});

describe('catalogo.service — contrato do módulo', () => {
  test('exporta somente listarAcoes: nenhuma escrita no catálogo', () => {
    assert.deepEqual(Object.keys(servico).sort(), ['listarAcoes']);
  });
});
