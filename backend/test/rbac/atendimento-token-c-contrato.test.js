'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recursos = require('../../src/rbac/recursos');
const { authConfig } = require('../../src/config/auth');
const { gerarTokenSessao, tokenSessaoTemFormatoValido } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa C (RED): contratos sem banco. O recurso `atendimentoToken` e a ação TOKEN_REVOGAR_DISPOSITIVO
 * são da Etapa B (congelada); a Etapa C acrescenta SÓ a ação TOKEN_GERAR_ATIVACAO (a ativação não tem recurso próprio).
 * As ações TOKEN_GERENCIAR_REDES, TOKEN_PREVIA_CATALOGO_REAL, TOKEN_VISUALIZAR_MONITORAMENTO e TOKEN_VISUALIZAR_HISTORICO só
 * entram com as suas rotas (catalogo-com-efeito.test.js exige uso real no código).
 *
 * Quando a Etapa C chegar ao GREEN, os testes ESTÁTICOS que fixam a lista exata de ações do escopo do MASTER (recursos.test.js,
 * toggles-exportar-historico.test.js, provisionamento-permissoes.service.test.js e integrações irmãs, já adaptados na Etapa B)
 * precisarão de mais uma linha com TOKEN_GERAR_ATIVACAO. Isso é previsto e pedirá autorização própria no GREEN C.
 */

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}

describe('C — RBAC da ativação (catálogo e escopo do MASTER)', () => {
  test('C-U1 — TOKEN_GERAR_ATIVACAO entra no escopo de provisionamento do MASTER (única forma de o MASTER, que decide só pelo perfil, a exercer)', () => {
    assert.ok(recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes('TOKEN_GERAR_ATIVACAO'));
  });

  test('C-U2 — é uma ação com efeito real (a rota de geração a aplica), então aparece na lista da tela de permissões', () => {
    assert.ok(recursos.ACOES_COM_EFEITO.includes('TOKEN_GERAR_ATIVACAO'));
  });

  test('C-U3 — só as ações com rota entram: as de Monitoramento e Histórico (Etapa J) seguem fora do escopo do MASTER e fora das ações com efeito; a Etapa H acrescentou apenas redes e prévia, com as suas rotas', () => {
    const tokens = recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes.filter((acao) => acao.startsWith('TOKEN_')).sort();
    assert.deepEqual(tokens, ['TOKEN_GERAR_ATIVACAO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL', 'TOKEN_REVOGAR_DISPOSITIVO']);
    for (const acao of ['TOKEN_VISUALIZAR_MONITORAMENTO', 'TOKEN_VISUALIZAR_HISTORICO']) {
      assert.equal(recursos.ACOES_COM_EFEITO.includes(acao), false, acao);
    }
  });

  test('C-U4 — a ativação NÃO ganha recurso novo: o escopo do MASTER mantém exatamente o recurso atendimentoToken (visualizar, criar, editar) da Etapa B', () => {
    const escopo = recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'atendimentoToken');
    assert.deepEqual([...escopo.operacoes], ['visualizar', 'criar', 'editar']);
    assert.equal(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.filter((r) => /token|tablet|ativacao/i.test(r.recurso)).length, 1);
  });
});

describe('C — módulos e constantes do contrato', () => {
  test('C-U5 — a rota administrativa de ativação existe e exige a ação TOKEN_GERAR_ATIVACAO', () => {
    const rotas = carregar('../../src/routes/token-ativacao.routes');
    assert.ok(rotas, 'src/routes/token-ativacao.routes.js ainda não existe');
    assert.equal(rotas.ACAO_GERAR_ATIVACAO, 'TOKEN_GERAR_ATIVACAO');
    assert.equal(typeof rotas.criarTokenAtivacaoRoutes, 'function');
    assert.ok(carregar('../../src/controllers/token-ativacao.controller'), 'controller de ativação ausente');
  });

  test('C-U6 — as rotas do tablet (ativar e estado) existem como módulo próprio, separado das rotas administrativas congeladas da Etapa B', () => {
    const rotas = carregar('../../src/routes/token-tablet.routes');
    assert.ok(rotas, 'src/routes/token-tablet.routes.js ainda não existe');
    assert.equal(typeof rotas.criarTokenTabletRoutes, 'function');
    assert.ok(carregar('../../src/controllers/token-tablet.controller'), 'controller do tablet ausente');
    const dispositivo = require('../../src/routes/token-dispositivo.routes');
    assert.deepEqual(Object.keys(dispositivo).sort(), ['ACAO_REVOGAR_DISPOSITIVO', 'RECURSO', 'criarTokenDispositivoRoutes', 'tokenDispositivoRoutes'], 'o contrato da Etapa B não mudou');
  });
});

describe('C — configuração do cookie e da rotação do tablet', () => {
  test('C-U7 — existe configuração própria do dispositivo: cookie de nome próprio (padrão gepi_tablet) distinto dos três cookies de sessão, e rotação de referência de 24 horas', () => {
    assert.ok(authConfig.dispositivo, 'authConfig.dispositivo ainda não existe');
    assert.equal(authConfig.dispositivo.cookieNome, 'gepi_tablet');
    const sessao = [authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNomeGlobal];
    assert.equal(sessao.includes(authConfig.dispositivo.cookieNome), false);
    assert.equal(authConfig.dispositivo.rotacaoHoras, 24);
  });

  test('C-U8 — a credencial do tablet usa a MESMA fonte criptográfica e o mesmo formato canônico das sessões (controle: já existe)', () => {
    const vistos = new Set();
    for (let i = 0; i < 50; i += 1) {
      const t = gerarTokenSessao();
      assert.equal(tokenSessaoTemFormatoValido(t), true);
      vistos.add(t);
    }
    assert.equal(vistos.size, 50);
  });
});
