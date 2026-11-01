'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

const R = require('../js/relatorios');

/**
 * Fiscalização sem armazenamento configurado: o servidor responde 503 FISCALIZACAO_INDISPONIVEL. A tela diz que o serviço está
 * temporariamente indisponível; nenhum outro erro (503 de outra origem, 500, 403, 404) pode ser classificado como esse.
 */
const ARQUIVO = 'pages/reports.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const ESC = ['FICHAS_ENTREGAS_CONFIRMADAS', 'TRILHA_AUDITORIA', 'HISTORICO_ESTOQUE_CA', 'REGRAS_GHE'];
const INDISPONIVEL = /temporariamente indispon/i;

const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'USUARIO',
  recursos: { reportsFiscal: { ...NENHUMA, visualizar: true }, reportsAudit: { ...NENHUMA } },
  acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa', email: 'p@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'Empresa Teste', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const previaOk = () => ({
  status: 200,
  corpo: {
    status: 'ok',
    previa: {
      periodo: { inicio: '2026-09-01', fim: '2026-09-30', dias: 30 }, podeGerar: true, limiteLinhasPorModulo: 100000,
      escopos: ESC.map((escopo) => ({ escopo, linhas: 5, vazio: false, excedeLimite: false })),
    },
  },
});
const erroServidor = (status, codigo) => () => ({ status, corpo: { status: 'erro', codigo, message: 'Texto interno do servidor que a tela nunca mostra.' } });

async function pronta(rotas = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /relatorios/fiscalizacao/pacotes': () => ({ status: 200, corpo: { status: 'ok', itens: [], total: 0, pagina: 1, limite: 20 } }),
      'POST /relatorios/fiscalizacao/previa': previaOk,
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function definir(pg, id, valor) {
  const campo = pg.consulta(`#${id}`)[0];
  campo.value = valor;
  await campo.disparar('input');
  await campo.disparar('change');
}
async function preencher(pg) {
  await definir(pg, 'fiscInicio', '2026-09-01');
  await definir(pg, 'fiscFim', '2026-09-30');
  await definir(pg, 'fiscFinalidade', 'AUDITORIA_INTERNA');
  for (const e of ESC) await pg.marcar(`fiscEscopo-${e}`, true);
}
const historico = (pg) => pg.consulta('#corpo-fiscalPacotes tr')[0].textContent;

describe('módulo: 503 FISCALIZACAO_INDISPONIVEL — classificação do erro', () => {
  test('503 com o código da Fiscalização diz que o serviço está temporariamente indisponível, sem usar a mensagem do servidor', () => {
    const texto = R.modelo.erro({ ok: false, status: 503, codigo: 'FISCALIZACAO_INDISPONIVEL', mensagem: 'A Fiscalização não está disponível neste ambiente.' });
    assert.match(texto, INDISPONIVEL);
    assert.notEqual(texto, R.TEXTOS.FALHA);
    assert.equal(texto, R.fiscal.mensagemDeErro('FISCALIZACAO_INDISPONIVEL'), 'a mesma frase na listagem e nas ações');
    assert.equal(/ambiente|armazen|diret[óo]rio|FISCALIZACAO_/i.test(texto), false, 'nada de detalhe interno na tela');
  });

  test('só o par 503 + código é classificado assim: 503 genérico, outros códigos e outros status mantêm o tratamento anterior', () => {
    const generico = R.modelo.erro({ status: 503, codigo: null });
    assert.equal(generico, R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 503, codigo: 'SERVICO_INDISPONIVEL' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 503, codigo: 'fiscalizacao_indisponivel' }), R.TEXTOS.FALHA, 'o código é exato');
    assert.equal(R.modelo.erro({ status: 503, codigo: '__proto__' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 503, codigo: 'constructor' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 500, codigo: 'FISCALIZACAO_INDISPONIVEL' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 502, codigo: 'FISCALIZACAO_INDISPONIVEL' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 400, codigo: 'FISCALIZACAO_INDISPONIVEL' }), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({ status: 403, codigo: 'FISCALIZACAO_INDISPONIVEL' }), R.TEXTOS.SEM_AUTORIDADE, 'permissão tem prioridade');
    assert.equal(R.modelo.erro({ status: 404, codigo: 'FISCALIZACAO_INDISPONIVEL' }), R.TEXTOS.SERVIDOR_DESATUALIZADO);
    assert.equal(R.modelo.erro({ status: 404 }), R.TEXTOS.SERVIDOR_DESATUALIZADO);
    assert.equal(R.modelo.erro({ status: 403 }), R.TEXTOS.SEM_AUTORIDADE);
    assert.equal(R.modelo.erro({ status: 400, codigo: 'PERIODO_MAXIMO_EXCEDIDO' }), R.TEXTOS.PERIODO_MAXIMO);
    assert.equal(R.modelo.erro(null), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro(undefined), R.TEXTOS.FALHA);
    assert.equal(R.modelo.erro({}), R.TEXTOS.FALHA);
  });

  test('o texto da indisponibilidade é só dela: nenhum outro código da Fiscalização o usa', () => {
    const texto = R.fiscal.mensagemDeErro('FISCALIZACAO_INDISPONIVEL');
    for (const codigo of ['LIMITE_LINHAS_EXCEDIDO', 'PACOTE_EXCEDE_TAMANHO', 'PERIODO_MAXIMO_EXCEDIDO', 'GERACAO_EM_ANDAMENTO', 'IDEMPOTENCIA_CONFLITO', 'GERACAO_ABANDONADA',
      'PACOTE_NAO_CONCLUIDO', 'PACOTE_NAO_ENCONTRADO', 'PACOTE_INTEGRIDADE', 'PACOTE_ARQUIVO_INDISPONIVEL', 'CODIGO_QUE_NAO_EXISTE', null, undefined]) {
      assert.notEqual(R.fiscal.mensagemDeErro(codigo), texto, String(codigo));
    }
  });
});

describe('página: 503 FISCALIZACAO_INDISPONIVEL — histórico, prévia e geração', () => {
  const GET_PACOTES = 'GET /relatorios/fiscalizacao/pacotes';

  test('histórico com 503 FISCALIZACAO_INDISPONIVEL mostra a indisponibilidade no corpo e no aviso, não o erro genérico', async () => {
    const pg = await pronta({ [GET_PACOTES]: erroServidor(503, 'FISCALIZACAO_INDISPONIVEL') });
    assert.match(historico(pg), INDISPONIVEL);
    assert.match(pg.texto('aviso'), INDISPONIVEL);
    assert.equal(historico(pg).includes(R.TEXTOS.FALHA), false);
    assert.equal(pg.textoDoDom().includes('Texto interno do servidor'), false);
  });

  test('histórico com 503 de outra origem, 500, 403 e 404 mantém o texto próprio de cada um', async () => {
    const casos = [
      [erroServidor(503, 'SERVICO_INDISPONIVEL'), R.TEXTOS.FALHA],
      [erroServidor(503, undefined), R.TEXTOS.FALHA],
      [erroServidor(500, 'FISCALIZACAO_INDISPONIVEL'), R.TEXTOS.FALHA],
      [erroServidor(500, 'ERRO_INTERNO'), R.TEXTOS.FALHA],
      [erroServidor(403, 'SEM_PERMISSAO'), R.TEXTOS.SEM_AUTORIDADE],
      [erroServidor(404, 'ROTA_NAO_ENCONTRADA'), R.TEXTOS.SERVIDOR_DESATUALIZADO],
    ];
    for (const [rota, esperado] of casos) {
      // eslint-disable-next-line no-await-in-loop
      const pg = await pronta({ [GET_PACOTES]: rota });
      assert.match(historico(pg), new RegExp(esperado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(INDISPONIVEL.test(historico(pg)), false, esperado);
    }
  });

  test('pré-visualização com 503 FISCALIZACAO_INDISPONIVEL avisa a indisponibilidade e não habilita Gerar', async () => {
    const pg = await pronta({ 'POST /relatorios/fiscalizacao/previa': erroServidor(503, 'FISCALIZACAO_INDISPONIVEL') });
    await preencher(pg);
    await pg.clicar('fiscPrevia');
    assert.match(pg.texto('aviso'), INDISPONIVEL);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
  });

  test('geração com 503 FISCALIZACAO_INDISPONIVEL avisa a indisponibilidade; 503 sem código usa o texto genérico da Fiscalização', async () => {
    const indisponivel = await pronta({ 'POST /relatorios/fiscalizacao/pacotes': erroServidor(503, 'FISCALIZACAO_INDISPONIVEL') });
    await preencher(indisponivel);
    await indisponivel.clicar('fiscPrevia');
    await indisponivel.clicar('fiscGerar');
    assert.match(indisponivel.texto('aviso'), INDISPONIVEL);

    const outro = await pronta({ 'POST /relatorios/fiscalizacao/pacotes': erroServidor(503, 'SERVICO_INDISPONIVEL') });
    await preencher(outro);
    await outro.clicar('fiscPrevia');
    await outro.clicar('fiscGerar');
    assert.equal(INDISPONIVEL.test(outro.texto('aviso')), false);
    assert.match(outro.texto('aviso'), new RegExp(R.fiscal.mensagemDeErro(null).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
