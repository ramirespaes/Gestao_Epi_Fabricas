'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/usuario-consulta.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const autoridade = require('../../src/services/autoridade-administrativa');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de consulta de usuários (Subetapa 3U),
 * sem PostgreSQL real.
 *
 * O que precisa ficar garantido:
 *   1. sem autoridade administrativa de VÍNCULOS, 403 — e a lista NÃO é
 *      lida (a recusa vem antes de qualquer consulta);
 *   2. a autoridade exigida é a de LEITURA (sem travar registros) e é
 *      exatamente ADMINISTRAR_VINCULOS_GRUPO, não outra;
 *   3. empresa e ator vêm do chamador e são verificados — nunca da
 *      query;
 *   4. os filtros atravessam até o repositório sem serem reinterpretados;
 *   5. nada é escrito e nada é auditado: consultar pessoas não é evento
 *      de auditoria.
 */

const EMPRESA = 42;
const ATOR = 7;

const USUARIOS = Object.freeze([
  Object.freeze({ id: 10, nome: 'Ana Souza', email: 'ana@demo.safeworkengenharia.com.br', perfil: 'USUARIO', ativo: true, grupoAcessoId: null }),
  Object.freeze({ id: 11, nome: 'Bruno Lima', email: 'bruno@demo.safeworkengenharia.com.br', perfil: 'SUPERVISOR', ativo: false, grupoAcessoId: 30 }),
]);

// O pool nunca é usado de verdade: autoridade e repositório estão
// substituídos. Registra o que receberia, para provar que este serviço
// não abre transação nem executa SQL por conta própria.
function criarPoolFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    connect: async () => { chamadas.push('CONNECT'); throw new Error('consulta não deve abrir transação'); },
  };
}

function comAutoridade(t, { concede = true } = {}) {
  const recebido = [];
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativaLeitura', async (executor, empresaId, atorId, codigo, mensagem, acao) => {
    recebido.push({ executor, empresaId, atorId, codigo, mensagem, acao });
    if (!concede) throw HttpError.forbidden(codigo, mensagem);
    return { id: atorId, empresa_id: empresaId, perfil: 'ADMINISTRADOR', ativo: true };
  });
  // O caminho de escrita não pode ser usado por uma consulta.
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => {
    throw new Error('consulta de usuários não deve usar o caminho de escrita da autoridade');
  });
  return recebido;
}

function comRepositorio(t, { usuarios = USUARIOS, total = USUARIOS.length } = {}) {
  const chamadas = [];
  t.mock.method(usuarioRepo, 'listarDaEmpresa', async (executor, empresaId, opcoes) => {
    chamadas.push({ executor, empresaId, opcoes });
    return { usuarios: usuarios.map((u) => ({ ...u })), total };
  });
  return chamadas;
}

describe('usuario-consulta.service.listar — autoridade', () => {
  test('sem autoridade responde 403 USUARIO_CONSULTA_NAO_AUTORIZADA', async (t) => {
    comAutoridade(t, { concede: false });
    comRepositorio(t);

    await assert.rejects(
      () => servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }),
      (erro) => {
        assert.ok(erro instanceof HttpError);
        assert.equal(erro.status, 403);
        assert.equal(erro.codigo, 'USUARIO_CONSULTA_NAO_AUTORIZADA');
        return true;
      },
    );
  });

  test('a recusa acontece ANTES de ler qualquer usuário', async (t) => {
    comAutoridade(t, { concede: false });
    const leituras = comRepositorio(t);

    await assert.rejects(() => servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }));

    assert.equal(leituras.length, 0, 'nenhum dado pessoal foi sequer buscado');
  });

  test('exige ADMINISTRAR_VINCULOS_GRUPO, pela variante de leitura', async (t) => {
    const recebido = comAutoridade(t);
    comRepositorio(t);
    const pool = criarPoolFalso();

    await servico.listar(pool, { empresaId: EMPRESA, atorId: ATOR });

    assert.equal(recebido.length, 1);
    assert.equal(recebido[0].acao, autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO);
    assert.equal(recebido[0].empresaId, EMPRESA);
    assert.equal(recebido[0].atorId, ATOR);
    assert.equal(recebido[0].codigo, 'USUARIO_CONSULTA_NAO_AUTORIZADA');
    assert.equal(recebido[0].executor, pool);
  });

  test('não é a autoridade de permissões nem a de grupos: são ações distintas', async (t) => {
    const recebido = comAutoridade(t);
    comRepositorio(t);

    await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.notEqual(recebido[0].acao, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);
    assert.notEqual(recebido[0].acao, autoridade.ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO);
  });

  test('empresa e ator inválidos são recusados antes da autoridade', async (t) => {
    const recebido = comAutoridade(t);
    comRepositorio(t);

    for (const argumentos of [
      { empresaId: 0, atorId: ATOR },
      { empresaId: -1, atorId: ATOR },
      { empresaId: 1.5, atorId: ATOR },
      { empresaId: null, atorId: ATOR },
      { empresaId: '42', atorId: ATOR },
      { empresaId: EMPRESA, atorId: 0 },
      { empresaId: EMPRESA, atorId: undefined },
    ]) {
      await assert.rejects(() => servico.listar(criarPoolFalso(), argumentos), TypeError);
    }

    assert.equal(recebido.length, 0);
  });
});

describe('usuario-consulta.service.listar — filtros e isolamento', () => {
  test('a empresa repassada ao repositório é a da sessão', async (t) => {
    comAutoridade(t);
    const chamadas = comRepositorio(t);

    await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.equal(chamadas[0].empresaId, EMPRESA);
  });

  test('os filtros atravessam intactos até o repositório', async (t) => {
    comAutoridade(t);
    const chamadas = comRepositorio(t);

    await servico.listar(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ATOR, busca: 'ana', vinculo: 'sem_grupo', pagina: 2, limite: 50,
    });

    assert.deepEqual(chamadas[0].opcoes, { busca: 'ana', vinculo: 'sem_grupo', pagina: 2, limite: 50 });
  });

  test('sem filtros, os padrões são busca null, vínculo todos, página 1 e limite 20', async (t) => {
    comAutoridade(t);
    const chamadas = comRepositorio(t);

    await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(chamadas[0].opcoes, { busca: null, vinculo: 'todos', pagina: 1, limite: 20 });
  });

  test('devolve usuários, total e a paginação efetivamente aplicada', async (t) => {
    comAutoridade(t);
    comRepositorio(t, { total: 137 });

    const resultado = await servico.listar(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ATOR, pagina: 3, limite: 25,
    });

    assert.deepEqual(Object.keys(resultado).sort(), ['limite', 'pagina', 'total', 'usuarios']);
    assert.equal(resultado.total, 137);
    assert.equal(resultado.pagina, 3);
    assert.equal(resultado.limite, 25);
    assert.equal(resultado.usuarios.length, 2);
  });

  test('preserva grupoAcessoId null e ativo false, sem reinterpretar', async (t) => {
    comAutoridade(t);
    comRepositorio(t);

    const { usuarios } = await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.equal(usuarios[0].grupoAcessoId, null, 'sem grupo continua sem grupo');
    assert.equal(usuarios[1].ativo, false, 'inativo continua aparecendo, marcado');
  });

  test('lista vazia devolve total zero, não erro', async (t) => {
    comAutoridade(t);
    comRepositorio(t, { usuarios: [], total: 0 });

    const resultado = await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(resultado.usuarios, []);
    assert.equal(resultado.total, 0);
  });

  test('não abre transação e não executa SQL próprio', async (t) => {
    comAutoridade(t);
    const chamadas = comRepositorio(t);
    const pool = criarPoolFalso();

    await servico.listar(pool, { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(pool.chamadas, []);
    assert.equal(chamadas[0].executor, pool);
  });

  test('nenhum campo de credencial sai do serviço', async (t) => {
    comAutoridade(t);
    comRepositorio(t);

    const { usuarios } = await servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR });

    for (const usuario of usuarios) {
      for (const proibido of ['senha', 'senha_hash', 'token', 'biometria_cadastrada']) {
        assert.equal(proibido in usuario, false, `${proibido} não deveria sair`);
      }
    }
  });

  test('erro inesperado do repositório propaga sem virar 403', async (t) => {
    comAutoridade(t);
    t.mock.method(usuarioRepo, 'listarDaEmpresa', async () => { throw new Error('conexão perdida'); });

    await assert.rejects(
      () => servico.listar(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR }),
      (erro) => {
        assert.equal(erro instanceof HttpError, false);
        assert.match(erro.message, /conexão perdida/);
        return true;
      },
    );
  });
});

describe('usuario-consulta.service — contrato do módulo', () => {
  test('exporta somente listar: nenhuma escrita sobre usuários', () => {
    assert.deepEqual(Object.keys(servico).sort(), ['listar']);
  });
});
