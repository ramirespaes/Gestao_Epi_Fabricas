'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOGGLES, PENDENCIAS, buscar } = require('../../src/rbac/toggles');
const { ACOES_COM_EFEITO, ESCOPO_PROVISIONAMENTO_MASTER, RECURSOS_COM_EFEITO } = require('../../src/rbac/recursos');
const { avisosDosAcessos, FUNCIONARIOS_SEM_VISUALIZAR } = require('../../src/rbac/avisos-acessos');

/**
 * Histórico de Funcionários — pacote J (RED): permissão "Exportar Histórico de Funcionários".
 *
 * Contrato proposto (o mesmo desenho de IMPORTAR_FUNCIONARIOS, migration 078):
 *   - ação nova EXPORTAR_HISTORICO_FUNCIONARIOS no catálogo `acoes`, modo ALTERNATIVA (perfil/grupo OU concessão
 *     individual; bloqueio individual é a última palavra), sem SST, criada por migration de DADOS que não concede a
 *     nenhum perfil, grupo ou usuário (nasce negada);
 *   - toggle `exportarHistoricoFuncionarios`, rótulo "Exportar Histórico de Funcionários", grupo COLABORADORES,
 *     INDEPENDENTE de visualizar: sem `dependencias` (ligar não liga a leitura) e sem concessão/semBloqueio;
 *   - na lista de ações com efeito e no escopo de provisionamento do MASTER (autoridade máxima pelo provisionamento,
 *     como as demais ações do MASTER);
 *   - aviso EXPORTAR_HISTORICO_SEM_VISUALIZAR quando o toggle de exportar está ligado e o de visualizar não (ligado ≠
 *     autorizado: a exportação do pacote I exige as duas).
 * Nenhuma permissão existente muda.
 */

const CODIGO = 'EXPORTAR_HISTORICO_FUNCIONARIOS';
const TOGGLE = 'exportarHistoricoFuncionarios';
const AVISO = 'EXPORTAR_HISTORICO_SEM_VISUALIZAR';

// Catálogo homologado antes do J (id, grupo, regra, dependências): não pode mudar.
const ANTERIORES = {
  dashboard: ['GERAL', { tipo: 'RECURSO', recurso: 'dashboard', operacoes: ['visualizar'] }, undefined],
  historicoFuncionarios: ['COLABORADORES', { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] }, undefined],
  cadastrarFuncionario: ['COLABORADORES', { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['criar'] }, [{ tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] }]],
  editarFuncionario: ['COLABORADORES', { tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['editar'] }, [{ tipo: 'RECURSO', recurso: 'employeeHistory', operacoes: ['visualizar'] }]],
  fichaEpi: ['EPIS', { tipo: 'RECURSO', recurso: 'epiFicha', operacoes: ['visualizar'] }, undefined],
  entregasSolicitacao: ['EPIS', { tipo: 'ACAO', codigo: 'REALIZAR_ENTREGA', semBloqueio: true }, undefined],
  gestaoGhe: ['EPIS', { tipo: 'RECURSO', recurso: 'employeeGroups', operacoes: ['visualizar'] }, undefined],
  analiseEstoque: ['ESTOQUE', { tipo: 'RECURSO', recurso: 'availableItems', operacoes: ['visualizar'] }, undefined],
  operacoesEstoque: ['ESTOQUE', { tipo: 'RECURSO', recurso: 'operations', operacoes: ['visualizar'] }, undefined],
  cadastrarProduto: ['ESTOQUE', { tipo: 'RECURSO', recurso: 'materials', operacoes: ['criar'] }, [{ tipo: 'RECURSO', recurso: 'materials', operacoes: ['visualizar'] }]],
  entradaLote: ['ESTOQUE', { tipo: 'ACAO', codigo: 'ENTRADA_ESTOQUE' }, [{ tipo: 'RECURSO', recurso: 'materials', operacoes: ['visualizar'] }]],
  registrarBaixa: ['ESTOQUE', { tipo: 'ACAO', codigo: 'BAIXA_ESTOQUE' }, [{ tipo: 'RECURSO', recurso: 'materials', operacoes: ['visualizar'] }]],
  importacaoFuncionarios: ['COLABORADORES', { tipo: 'ACAO', codigo: 'IMPORTAR_FUNCIONARIOS' }, []],
  gestaoUsuarios: ['ADMINISTRACAO', { tipo: 'ACAO', codigo: 'GERENCIAR_USUARIOS' }, undefined],
  aprovarSolicitacoes: ['ADMINISTRACAO', { tipo: 'ACAO', codigo: 'APROVAR_SOLICITACAO', concessao: true }, undefined],
  reprovarSolicitacoes: ['ADMINISTRACAO', { tipo: 'ACAO', codigo: 'REPROVAR_SOLICITACAO', concessao: true }, undefined],
  reportsAudit: ['GERAL', { tipo: 'RECURSO', recurso: 'reportsAudit', operacoes: ['visualizar'] }, undefined],
  reportsFiscal: ['GERAL', { tipo: 'RECURSO', recurso: 'reportsFiscal', operacoes: ['visualizar'] }, undefined],
};
const simples = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const sqls = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ arquivo: f, sql: fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '') }));

describe('J1 — o toggle novo no catálogo', () => {
  test('J1.1 "Exportar Histórico de Funcionários" existe, em Colaboradores, sobre a ação EXPORTAR_HISTORICO_FUNCIONARIOS', () => {
    const t = buscar(TOGGLE);
    assert.ok(t, `toggle ${TOGGLE} ausente`);
    assert.equal(t.rotulo, 'Exportar Histórico de Funcionários');
    assert.equal(t.grupo, 'COLABORADORES');
    assert.deepEqual(simples(t.regra), { tipo: 'ACAO', codigo: CODIGO });
  });

  test('J1.2 independente de visualizar: sem dependências (ligar exportar não liga a leitura) e sem modos especiais', () => {
    const t = buscar(TOGGLE);
    assert.ok(t, `toggle ${TOGGLE} ausente`);
    assert.deepEqual(t.dependencias ?? [], []);
    assert.equal(t.regra.concessao, undefined);
    assert.equal(t.regra.semBloqueio, undefined);
  });

  test('J1.3 um único toggle novo; nenhum dos homologados mudou (id, grupo, regra e dependências); pendências intactas', () => {
    const ids = TOGGLES.map((t) => t.id);
    // Os sete do Atendimento Token entram na Etapa H (toggles-atendimento-token.test.js); aqui conta só o que é do pacote J.
    // Catálogo completo, sem exceção por identificador: fora os homologados e o grupo ATENDIMENTO, só podem existir o do pacote J e
    // o controle único de Dados da Empresa (definição completa em empresa-dados-rbac.test.js). Qualquer outro toggle novo reprova aqui.
    assert.deepEqual(ids.filter((id) => !Object.hasOwn(ANTERIORES, id) && buscar(id).grupo !== 'ATENDIMENTO'), [TOGGLE, 'dadosEmpresa']);
    for (const [id, [grupo, regra, dependencias]] of Object.entries(ANTERIORES)) {
      const t = buscar(id);
      assert.ok(t, id);
      assert.deepEqual([t.grupo, simples(t.regra), simples(t.dependencias)], [grupo, regra, dependencias], id);
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(PENDENCIAS.some((p) => /export/i.test(`${p.id} ${p.rotulo}`)), false, 'exportar é toggle real, não pendência');
    assert.equal(PENDENCIAS.length, 8);
  });
});

describe('J2 — ação com efeito, MASTER e catálogo de recursos', () => {
  test('J2.1 a ação entra na lista de ações com efeito (a tela de permissões a mostra)', () => {
    assert.ok(ACOES_COM_EFEITO.includes(CODIGO));
  });

  test('J2.2 MASTER: a ação entra no escopo de provisionamento (autoridade pelo provisionamento, como as demais); o resto do escopo não muda', () => {
    assert.deepEqual([...ESCOPO_PROVISIONAMENTO_MASTER.acoes], ['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE', 'REALIZAR_ENTREGA', 'IMPORTAR_FUNCIONARIOS', CODIGO, 'TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL']);
    const funcionarios = ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === 'employeeHistory');
    assert.deepEqual([...funcionarios.operacoes], ['visualizar', 'criar', 'editar'], 'exportar não vira operação de recurso');
    assert.equal(RECURSOS_COM_EFEITO.some((r) => r.operacoes.includes('exportar')), false);
  });
});

describe('J3 — a ação nasce negada (migration só de dados)', () => {
  test('J3.1 uma migration insere a ação em `acoes`, modo ALTERNATIVA e sem SST', () => {
    const insercoes = sqls().filter(({ sql }) => /INSERT\s+INTO\s+acoes\b[\s\S]*?;/i.test(sql)
      && [...sql.matchAll(/INSERT\s+INTO\s+acoes\b[\s\S]*?;/gi)].some((m) => m[0].includes(`'${CODIGO}'`)));
    assert.equal(insercoes.length, 1, `migrations que inserem ${CODIGO}: ${insercoes.map((x) => x.arquivo)}`);
    const comando = [...insercoes[0].sql.matchAll(/INSERT\s+INTO\s+acoes\b[\s\S]*?;/gi)].find((m) => m[0].includes(`'${CODIGO}'`))[0];
    assert.match(comando, /'ALTERNATIVA'/);
    assert.equal(/exige_sst[\s\S]*\btrue\b/i.test(comando), false, 'sem SST');
  });

  test('J3.2 nenhuma migration concede a ação a perfil, grupo ou usuário (nem copia de visualizar, editar ou importar)', () => {
    for (const { arquivo, sql } of sqls()) {
      if (!sql.includes(CODIGO)) continue;
      for (const tabela of ['permissoes_acao', 'grupo_permissoes_acao', 'usuario_autorizacoes', 'permissoes_recurso', 'grupo_permissoes_recurso', 'usuario_permissoes_recurso']) {
        assert.equal(new RegExp(`INSERT\\s+INTO\\s+${tabela}\\b`, 'i').test(sql), false, `${arquivo} grava em ${tabela}`);
      }
      assert.equal(/UPDATE\s+(permissoes|grupo_permissoes|usuario_)/i.test(sql), false, `${arquivo} altera permissões existentes`);
    }
  });
});

describe('J4 — aviso: exportar ligado sem visualizar', () => {
  const acessos = (mapa) => TOGGLES.map((t) => ({ id: t.id, ligado: mapa[t.id] === true }));
  const codigos = (mapa) => avisosDosAcessos(acessos(mapa)).map((a) => a.codigo);

  test('J4.1 exportar ligado e Histórico desligado: aviso EXPORTAR_HISTORICO_SEM_VISUALIZAR (ligado não é autorizado)', () => {
    assert.deepEqual(codigos({ [TOGGLE]: true }), [AVISO]);
  });

  test('J4.2 sem inconsistência: os dois ligados, ou exportar desligado — nenhum aviso de exportação', () => {
    assert.deepEqual(codigos({ [TOGGLE]: true, historicoFuncionarios: true }), []);
    assert.deepEqual(codigos({ historicoFuncionarios: true }), []);
    assert.deepEqual(codigos({}), []);
  });

  test('J4.3 o aviso de Funcionários continua com a mesma regra; os dois podem aparecer juntos', () => {
    assert.deepEqual(codigos({ cadastrarFuncionario: true }), [FUNCIONARIOS_SEM_VISUALIZAR]);
    assert.deepEqual(codigos({ cadastrarFuncionario: true, [TOGGLE]: true }).sort(), [AVISO, FUNCIONARIOS_SEM_VISUALIZAR].sort());
    assert.deepEqual(codigos({ editarFuncionario: true, historicoFuncionarios: true, [TOGGLE]: true }), []);
  });
});
