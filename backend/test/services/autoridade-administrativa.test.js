'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const autoridade = require('../../src/services/autoridade-administrativa');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const autorizacaoRepo = require('../../src/repositories/autorizacao-individual.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do ponto único de autoridade administrativa (Bloco 8,
 * Incremento 8, Etapa 5A — criado na 3K, estendido na 3Q), sem PostgreSQL
 * real: usuarioRepo e permissaoRepo substituídos por t.mock.method.
 *
 * Até a 3P este módulo só era exercitado INDIRETAMENTE, pelos testes dos
 * três serviços administrativos. A 3Q acrescentou nele o segundo caminho
 * de autoridade (ADMINISTRADOR expressamente autorizado), que é a regra
 * mais sensível do bloco — daí este arquivo próprio, focado nela.
 *
 * O que se prova aqui: MASTER continua passando por perfil; ADMINISTRADOR
 * só passa com autorização individual EFETIVA para a ação daquela
 * operação; autorização de OUTRA operação não serve; e nenhum outro
 * perfil passa por nenhum caminho.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const MASTER_ID = 1;
const ADMIN_ID = 5;
const SUPERVISOR_ID = 7;
const USUARIO_ID = 8;

const CODIGO_ERRO = 'GRUPO_NAO_AUTORIZADO';
const MENSAGEM = 'Sem autoridade para administrar grupos de acesso';

const { GRUPOS_ACESSO, PERMISSOES_GRUPO, VINCULOS_GRUPO } = autoridade.ACOES_ADMINISTRATIVAS;

const usuario = (id, perfil, extra = {}) => Object.freeze({
  id, empresa_id: EMPRESA, nome: `Usuário ${id}`, email: `u${id}@demo.safeworkengenharia.com.br`,
  perfil, ativo: true, biometria_cadastrada: false, ...extra,
});

const master = usuario(MASTER_ID, 'MASTER');
const administrador = usuario(ADMIN_ID, 'ADMINISTRADOR');
const supervisor = usuario(SUPERVISOR_ID, 'SUPERVISOR');
const comum = usuario(USUARIO_ID, 'USUARIO');

const configuracaoAdministrativa = (extra = {}) => ({
  ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'OBRIGATORIA', ...extra,
});

// Executor falso: só precisa existir, porque todas as leituras que o
// usariam estão mockadas nos repositórios.
const executorFalso = () => ({ query: async () => ({ rows: [], rowCount: 0 }) });

/**
 * @param autorizacoes conjunto de `${usuarioId}:${acaoCodigo}` com
 *   autorização individual concedida.
 * @param bloqueios conjunto no mesmo formato, para usuario_bloqueios.
 */
function mundo(t, {
  usuarios = {}, autorizacoes = [], bloqueios = [], sst = [], config = configuracaoAdministrativa(),
} = {}) {
  const porId = {
    [MASTER_ID]: master, [ADMIN_ID]: administrador, [SUPERVISOR_ID]: supervisor, [USUARIO_ID]: comum, ...usuarios,
  };
  const concedidas = new Set(autorizacoes);
  const bloqueadas = new Set(bloqueios);
  const naSst = new Set(sst);

  const localizarAtor = async (_e, empresaId, id) => (empresaId === EMPRESA && porId[id] ? porId[id] : null);

  return {
    travado: t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', localizarAtor),
    destravado: t.mock.method(usuarioRepo, 'buscarPorId', localizarAtor),
    configuracao: t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => config),
    autorizacao: t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async (_e, empresaId, id, acao) => (
      empresaId === EMPRESA && concedidas.has(`${id}:${acao}`)
    )),
    // Correção de concorrência da 3Q: o caminho de ESCRITA verifica a
    // autorização pelo repositório administrativo, com FOR UPDATE.
    autorizacaoTravada: t.mock.method(autorizacaoRepo, 'listarPorUsuarioAcaoParaAtualizacao', async (_e, empresaId, id, acao) => (
      empresaId === EMPRESA && concedidas.has(`${id}:${acao}`)
        ? [{ id: 777, empresaId, usuarioId: id, acaoCodigo: acao, podeDelegar: false, origemId: null }]
        : []
    )),
    bloqueio: t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async (_e, empresaId, id, acao) => (
      empresaId === EMPRESA && bloqueadas.has(`${id}:${acao}`)
    )),
    integraSst: t.mock.method(permissaoRepo, 'usuarioIntegraSst', async (_e, empresaId, id) => (
      empresaId === EMPRESA && naSst.has(id)
    )),
  };
}

async function esperar403(promessa) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, 403);
    assert.equal(erro.codigo, CODIGO_ERRO);
    return true;
  });
}

const exigirEscrita = (executor, atorId, acao) => autoridade.exigirAutoridadeAdministrativa(executor, EMPRESA, atorId, CODIGO_ERRO, MENSAGEM, acao);
const exigirLeitura = (executor, atorId, acao) => autoridade.exigirAutoridadeAdministrativaLeitura(executor, EMPRESA, atorId, CODIGO_ERRO, MENSAGEM, acao);

describe('contrato do módulo', () => {
  test('exporta as três ações administrativas do catálogo (migration 024), congeladas', () => {
    assert.deepEqual(autoridade.ACOES_ADMINISTRATIVAS, {
      GRUPOS_ACESSO: 'ADMINISTRAR_GRUPOS_ACESSO',
      PERMISSOES_GRUPO: 'ADMINISTRAR_PERMISSOES_GRUPO',
      VINCULOS_GRUPO: 'ADMINISTRAR_VINCULOS_GRUPO',
    });
    assert.equal(Object.isFrozen(autoridade.ACOES_ADMINISTRATIVAS), true);
    assert.equal(autoridade.PERFIL_MASTER, 'MASTER');
    assert.deepEqual(Object.keys(autoridade).sort(), [
      'ACOES_ADMINISTRATIVAS', 'PERFIL_MASTER', 'exigirAutoridadeAdministrativa', 'exigirAutoridadeAdministrativaLeitura',
    ].sort());
  });

  test('ação administrativa ausente ou desconhecida é TypeError, nunca 403 — é erro de programação, não falta de autoridade', async (t) => {
    mundo(t);

    for (const acaoInvalida of [undefined, null, '', 'ADMINISTRAR_QUALQUER_COISA', 'MOVIMENTAR_ESTOQUE', 123]) {
      await assert.rejects(exigirEscrita(executorFalso(), MASTER_ID, acaoInvalida), TypeError);
      await assert.rejects(exigirLeitura(executorFalso(), MASTER_ID, acaoInvalida), TypeError);
    }
  });
});

describe('caminho 1 — MASTER por perfil', () => {
  test('MASTER ativo passa nas três ações, sem consultar autorização individual nenhuma', async (t) => {
    const mocks = mundo(t);

    for (const acao of [GRUPOS_ACESSO, PERMISSOES_GRUPO, VINCULOS_GRUPO]) {
      assert.equal((await exigirEscrita(executorFalso(), MASTER_ID, acao)).id, MASTER_ID);
      assert.equal((await exigirLeitura(executorFalso(), MASTER_ID, acao)).id, MASTER_ID);
    }

    assert.equal(mocks.autorizacao.mock.calls.length, 0, 'o MASTER não depende de usuario_autorizacoes');
    assert.equal(mocks.configuracao.mock.calls.length, 0, 'nem do catálogo');
  });

  test('MASTER inativo é recusado, e a escrita usa FOR UPDATE enquanto a leitura não', async (t) => {
    const mocks = mundo(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, 'MASTER', { ativo: false }) } });

    await esperar403(exigirEscrita(executorFalso(), MASTER_ID, GRUPOS_ACESSO));
    await esperar403(exigirLeitura(executorFalso(), MASTER_ID, GRUPOS_ACESSO));

    assert.equal(mocks.travado.mock.calls.length, 1, 'escrita lê o ator travado');
    assert.equal(mocks.destravado.mock.calls.length, 1, 'leitura lê sem lock');
  });

  test('MASTER de outra empresa não é encontrado nesta: 403', async (t) => {
    mundo(t);

    await assert.rejects(
      autoridade.exigirAutoridadeAdministrativa(executorFalso(), EMPRESA_OUTRA, MASTER_ID, CODIGO_ERRO, MENSAGEM, GRUPOS_ACESSO),
      (erro) => erro.status === 403,
    );
  });
});

describe('caminho 2 — ADMINISTRADOR expressamente autorizado (Subetapa 3Q)', () => {
  test('ADMINISTRADOR com autorização individual para a ação daquela operação passa, na escrita e na leitura', async (t) => {
    mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`] });

    assert.equal((await exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO)).id, ADMIN_ID);
    assert.equal((await exigirLeitura(executorFalso(), ADMIN_ID, GRUPOS_ACESSO)).id, ADMIN_ID);
  });

  test('ADMINISTRADOR sem autorização nenhuma é recusado: ter o perfil não concede nada', async (t) => {
    mundo(t);

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
    await esperar403(exigirLeitura(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
  });

  test('GRANULARIDADE: autorização de uma operação não serve para as outras duas', async (t) => {
    mundo(t, { autorizacoes: [`${ADMIN_ID}:${PERMISSOES_GRUPO}`] });

    assert.equal((await exigirEscrita(executorFalso(), ADMIN_ID, PERMISSOES_GRUPO)).id, ADMIN_ID);
    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, VINCULOS_GRUPO));
  });

  test('a autorização é sempre consultada para a ação EXATA da operação, e na empresa da sessão', async (t) => {
    const mocks = mundo(t, { autorizacoes: [`${ADMIN_ID}:${VINCULOS_GRUPO}`] });

    await exigirEscrita(executorFalso(), ADMIN_ID, VINCULOS_GRUPO);

    const [, empresaConsultada, idConsultado, acaoConsultada] = mocks.autorizacaoTravada.mock.calls[0].arguments;
    assert.deepEqual([empresaConsultada, idConsultado, acaoConsultada], [EMPRESA, ADMIN_ID, VINCULOS_GRUPO]);
  });

  // Correção pós-auditoria da 3Q: sem o FOR UPDATE aqui, uma revogação
  // concorrente podia commitar no meio de uma operação já autorizada.
  test('CONCORRÊNCIA: a ESCRITA verifica a autorização com FOR UPDATE, pelo repositório administrativo', async (t) => {
    const mocks = mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`] });

    await exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO);

    assert.equal(mocks.autorizacaoTravada.mock.calls.length, 1, 'a escrita trava a linha da autorização');
    assert.equal(mocks.autorizacao.mock.calls.length, 0, 'e não usa a consulta sem lock');
  });

  test('CONCORRÊNCIA: a LEITURA não trava nada — nem o ator, nem a autorização', async (t) => {
    const mocks = mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`] });

    await exigirLeitura(executorFalso(), ADMIN_ID, GRUPOS_ACESSO);

    assert.equal(mocks.autorizacaoTravada.mock.calls.length, 0, 'consulta HTTP não põe lock de linha');
    assert.equal(mocks.autorizacao.mock.calls.length, 1, 'usa a leitura comum de permissao.repository');
    assert.equal(mocks.travado.mock.calls.length, 0, 'nem o ator é travado na leitura');
    assert.equal(mocks.destravado.mock.calls.length, 1);
  });

  test('a autorização revogada entre a verificação e a operação não autoriza: lista vazia é 403 nos dois caminhos', async (t) => {
    mundo(t, { autorizacoes: [] });

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
    await esperar403(exigirLeitura(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
  });

  test('ADMINISTRADOR inativo é recusado mesmo com autorização concedida', async (t) => {
    mundo(t, {
      usuarios: { [ADMIN_ID]: usuario(ADMIN_ID, 'ADMINISTRADOR', { ativo: false }) },
      autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`],
    });

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
    await esperar403(exigirLeitura(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
  });

  test('bloqueio individual prevalece sobre a autorização administrativa', async (t) => {
    mundo(t, {
      autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`],
      bloqueios: [`${ADMIN_ID}:${GRUPOS_ACESSO}`],
    });

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
  });

  test('ação administrativa inativada no catálogo deixa de autorizar quem já tinha a concessão', async (t) => {
    mundo(t, {
      autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`],
      config: configuracaoAdministrativa({ ativo: false }),
    });

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
  });

  test('ação inexistente no catálogo (configuração null) recusa antes de consultar autorização', async (t) => {
    const mocks = mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`], config: null });

    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));

    assert.equal(mocks.autorizacao.mock.calls.length, 0);
    assert.equal(mocks.autorizacaoTravada.mock.calls.length, 0);
  });

  test('configuração irreconhecível ou em modo NENHUMA não autoriza — mesma proteção do middleware e da 3I', async (t) => {
    for (const config of [
      configuracaoAdministrativa({ modoAutorizacaoIndividual: 'NENHUMA' }),
      configuracaoAdministrativa({ modoAutorizacaoIndividual: 'VALOR_INESPERADO' }),
      configuracaoAdministrativa({ exigeSst: 'false' }),
    ]) {
      mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`], config });
      await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));
    }
  });

  test('se a ação exigir SST, o ADMINISTRADOR fora do vinculo_sst é recusado; dentro dele, passa', async (t) => {
    const config = configuracaoAdministrativa({ exigeSst: true });

    mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`], config });
    await esperar403(exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO));

    mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`], sst: [ADMIN_ID], config });
    assert.equal((await exigirEscrita(executorFalso(), ADMIN_ID, GRUPOS_ACESSO)).id, ADMIN_ID);
  });

  test('a autorização da empresa A não vale numa sessão da empresa B', async (t) => {
    mundo(t, { autorizacoes: [`${ADMIN_ID}:${GRUPOS_ACESSO}`] });

    await assert.rejects(
      autoridade.exigirAutoridadeAdministrativa(executorFalso(), EMPRESA_OUTRA, ADMIN_ID, CODIGO_ERRO, MENSAGEM, GRUPOS_ACESSO),
      (erro) => erro.status === 403,
    );
  });
});

describe('nenhum outro perfil tem caminho', () => {
  test('SUPERVISOR e USUARIO são recusados mesmo com autorização individual da ação administrativa', async (t) => {
    mundo(t, {
      autorizacoes: [`${SUPERVISOR_ID}:${GRUPOS_ACESSO}`, `${USUARIO_ID}:${GRUPOS_ACESSO}`],
    });

    for (const id of [SUPERVISOR_ID, USUARIO_ID]) {
      await esperar403(exigirEscrita(executorFalso(), id, GRUPOS_ACESSO));
      await esperar403(exigirLeitura(executorFalso(), id, GRUPOS_ACESSO));
    }
  });

  test('ator inexistente é recusado sem consultar catálogo nem autorização', async (t) => {
    const mocks = mundo(t);

    await esperar403(exigirEscrita(executorFalso(), 4242, GRUPOS_ACESSO));

    assert.equal(mocks.configuracao.mock.calls.length, 0);
    assert.equal(mocks.autorizacao.mock.calls.length, 0);
    assert.equal(mocks.autorizacaoTravada.mock.calls.length, 0);
  });
});
