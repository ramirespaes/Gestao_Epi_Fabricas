'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Dados da Empresa (F2) — módulo EpiDadosEmpresa, sem navegador. Contrato com a F1:
 *   GET   /empresa/dados  -> { status, dados: { razaoSocial, cnpj, nomeFantasia, ..., emailSst, emailAlmoxarifado,
 *                                               representante: {nome,cargo,email,telefone}, financeiro: {nome,email,telefone},
 *                                               versao, camposBloqueados } }
 *   PATCH /empresa/dados  -> corpo { versao, <só os campos alterados> }; razão social e CNPJ nunca vão no corpo.
 */

const MODULO = path.join(__dirname, '..', 'js', 'dados-empresa.js');
const carregar = () => {
  assert.ok(fs.existsSync(MODULO), 'js/dados-empresa.js ainda não existe');
  delete require.cache[MODULO];
  return require(MODULO);
};

const dadosDoServidor = (extra = {}) => ({
  razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181', nomeFantasia: 'Alfa', inscricaoEstadual: null, situacaoInscricaoEstadual: null,
  endereco: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', cep: '01310100',
  telefone: '1140001000', email: 'contato@alfa.com.br', emailSst: null, emailAlmoxarifado: null,
  representante: { nome: 'Rep', cargo: null, email: null, telefone: null }, financeiro: { nome: null, email: null, telefone: null },
  versao: 4, camposBloqueados: ['razaoSocial', 'cnpj'], ...extra,
});

function httpFalso(resposta) {
  const chamadas = [];
  const http = {
    requisitar: async (metodo, caminho, opcoes) => { chamadas.push({ metodo, caminho, corpo: opcoes ? opcoes.corpo : undefined }); return typeof resposta === 'function' ? resposta(metodo) : resposta; },
  };
  global.EpiHttp = http;
  return chamadas;
}

describe('acoes', () => {
  test('consultar: GET /empresa/dados, sem corpo e sem empresa no pedido', async () => {
    const M = carregar();
    const chamadas = httpFalso({ ok: true, status: 200, dados: { status: 'ok', dados: dadosDoServidor() } });
    await M.acoes.consultar();
    assert.deepEqual(chamadas, [{ metodo: 'GET', caminho: '/empresa/dados', corpo: undefined }]);
    assert.equal(M.CAMINHO, '/empresa/dados');
  });

  test('alterar: PATCH com a versão carregada e só os campos informados', async () => {
    const M = carregar();
    const chamadas = httpFalso({ ok: true, status: 200, dados: { status: 'ok' } });
    await M.acoes.alterar(4, { telefone: '1199', emailSst: null });
    assert.deepEqual(chamadas, [{ metodo: 'PATCH', caminho: '/empresa/dados', corpo: { versao: 4, telefone: '1199', emailSst: null } }]);
  });

  test('alterar recusa, antes de qualquer rede, razão social, CNPJ, chaves de autoridade, versão inválida e corpo vazio', async () => {
    const M = carregar();
    const chamadas = httpFalso({ ok: true, status: 200, dados: {} });
    for (const campos of [{ razaoSocial: 'X' }, { cnpj: '1' }, { nome: 'X' }, { empresaId: 1 }, { ativo: false }, { versao: 9 }, {}, { desconhecido: 'x' }]) {
      await assert.rejects(M.acoes.alterar(4, campos), TypeError, JSON.stringify(campos));
    }
    for (const versao of [0, -1, 1.5, '4', null, undefined]) await assert.rejects(M.acoes.alterar(versao, { telefone: '1' }), TypeError, String(versao));
    assert.equal(chamadas.length, 0);
  });
});

describe('modelo', () => {
  test('deResposta: valores planos como texto (null vira vazio), versão e campos protegidos à parte', () => {
    const M = carregar();
    const m = M.modelo.deResposta({ ok: true, status: 200, dados: { status: 'ok', dados: dadosDoServidor() } });
    assert.equal(m.versao, 4);
    assert.equal(m.razaoSocial, 'Empresa Alfa Ltda');
    assert.equal(m.cnpj, '11222333000181');
    assert.equal(m.valores.nomeFantasia, 'Alfa');
    assert.equal(m.valores.complemento, '');
    assert.equal(m.valores.representanteNome, 'Rep');
    assert.equal(m.valores.representanteCargo, '');
    assert.equal(m.valores.financeiroEmail, '');
    assert.equal(m.valores.emailSst, '');
    for (const chave of ['razaoSocial', 'cnpj', 'versao']) assert.equal(Object.hasOwn(m.valores, chave), false, chave);
  });

  test('deResposta: resposta inválida, sem versão ou com tipos errados é rejeitada (null), nunca preenchida pela metade', () => {
    const M = carregar();
    for (const r of [null, { ok: false, status: 500 }, { ok: true, dados: null }, { ok: true, dados: { dados: null } }, { ok: true, dados: { dados: dadosDoServidor({ versao: 0 }) } },
      { ok: true, dados: { dados: dadosDoServidor({ versao: '4' }) } }, { ok: true, dados: { dados: dadosDoServidor({ razaoSocial: 5 }) } }, { ok: true, dados: { dados: dadosDoServidor({ representante: null }) } }]) {
      assert.equal(M.modelo.deResposta(r), null, JSON.stringify(r));
    }
  });

  test('os campos editáveis são exatamente os 21 do contrato e nenhum é razão social ou CNPJ', () => {
    const M = carregar();
    assert.deepEqual([...M.CAMPOS].sort(), [
      'bairro', 'cep', 'cidade', 'complemento', 'email', 'emailAlmoxarifado', 'emailSst', 'endereco', 'financeiroEmail', 'financeiroNome', 'financeiroTelefone',
      'inscricaoEstadual', 'nomeFantasia', 'numero', 'representanteCargo', 'representanteEmail', 'representanteNome', 'representanteTelefone',
      'situacaoInscricaoEstadual', 'telefone', 'uf',
    ].sort());
  });
});

describe('formulario', () => {
  const base = () => carregar().modelo.deResposta({ ok: true, status: 200, dados: { status: 'ok', dados: dadosDoServidor() } });

  test('diff: só o que mudou; vazio vira null (limpar); e-mail em minúsculas, UF em maiúsculas, CEP só dígitos', () => {
    const M = carregar();
    const m = base();
    const atuais = { ...m.valores, telefone: ' (11) 4000-2000 ', complemento: '', bairro: '', emailSst: ' SST@Alfa.com.br ', uf: 'rj', cep: '20000-000' };
    assert.deepEqual(M.formulario.diff(m.valores, atuais), { telefone: '(11) 4000-2000', bairro: null, emailSst: 'sst@alfa.com.br', uf: 'RJ', cep: '20000000' });
  });

  test('diff: sem mudança real devolve objeto vazio (nada é enviado); espaços e caixa equivalentes não contam como mudança', () => {
    const M = carregar();
    const m = base();
    assert.deepEqual(M.formulario.diff(m.valores, { ...m.valores }), {});
    assert.deepEqual(M.formulario.diff(m.valores, { ...m.valores, nomeFantasia: ' Alfa ', email: 'CONTATO@alfa.com.br', cep: '01310-100' }), {});
  });

  test('diff nunca inclui razão social, CNPJ nem chave desconhecida, mesmo que venham nos valores atuais', () => {
    const M = carregar();
    const m = base();
    const d = M.formulario.diff(m.valores, { ...m.valores, razaoSocial: 'Outra', cnpj: '1', qualquer: 'x', telefone: '1' });
    assert.deepEqual(Object.keys(d), ['telefone']);
  });

  test('validar: e-mail, UF, CEP, tamanhos e inscrição estadual (CONTRIBUINTE exige o número), com texto por campo', () => {
    const M = carregar();
    const m = base();
    const ok = M.formulario.validar(m.valores);
    assert.deepEqual(ok, {});
    const ruim = M.formulario.validar({
      ...m.valores, email: 'sem-arroba', emailSst: 'a@b', uf: 'SPP', cep: '123', telefone: '1'.repeat(21), nomeFantasia: 'x'.repeat(151),
      situacaoInscricaoEstadual: 'CONTRIBUINTE', inscricaoEstadual: '',
    });
    for (const campo of ['email', 'emailSst', 'uf', 'cep', 'telefone', 'nomeFantasia', 'inscricaoEstadual']) {
      assert.equal(typeof ruim[campo], 'string', campo);
      assert.ok(ruim[campo].length > 0, campo);
    }
    assert.equal(Object.hasOwn(ruim, 'bairro'), false);
  });

  test('validar: campo vazio é permitido (opcional) e situação fora da lista é recusada', () => {
    const M = carregar();
    const m = base();
    assert.deepEqual(M.formulario.validar({ ...m.valores, emailSst: '', emailAlmoxarifado: '', representanteCargo: '' }), {});
    assert.equal(typeof M.formulario.validar({ ...m.valores, situacaoInscricaoEstadual: 'INVENTADA' }).situacaoInscricaoEstadual, 'string');
  });
});

describe('erros', () => {
  test('401: sessão; 403: sem permissão; 409 EMPRESA_DADOS_DESATUALIZADOS: conflito (nunca sobrescreve); 429: limite; rede e 5xx: genérico', () => {
    const M = carregar();
    const e = M.erros.daEscrita;
    assert.deepEqual(e({ ok: false, status: 401 }), { sessao: true });
    assert.equal(e({ ok: false, status: 403 }).aviso, M.TEXTOS.SEM_PERMISSAO);
    const c = e({ ok: false, status: 409, codigo: 'EMPRESA_DADOS_DESATUALIZADOS' });
    assert.equal(c.conflito, true);
    assert.equal(c.aviso, M.TEXTOS.CONFLITO);
    assert.equal(e({ ok: false, status: 429 }).aviso, M.TEXTOS.LIMITE);
    assert.equal(e({ ok: false, status: 0 }).aviso, M.TEXTOS.REDE);
    assert.equal(e({ ok: false, status: 500 }).aviso, M.TEXTOS.GENERICO);
    assert.equal(e({ ok: false, status: 409, codigo: 'OUTRO' }).conflito, undefined);
  });

  test('400 VALIDACAO: campos pelo caminho body.<campo>; razão social/CNPJ recusados pelo servidor viram aviso; nunca o texto do servidor', () => {
    const M = carregar();
    const e = M.erros.daEscrita;
    const r = e({ ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'texto do servidor', detalhes: [
      { campo: 'body.emailSst', codigo: 'EMAIL_INVALIDO', mensagem: 'ECO <b>servidor</b>' }, { campo: 'body.representanteEmail', mensagem: 'x' }, { campo: 'body.desconhecido', mensagem: 'y' },
    ] });
    assert.deepEqual(Object.keys(r.campos).sort(), ['emailSst', 'representanteEmail']);
    assert.equal(JSON.stringify(r).includes('servidor'), false, 'nada do servidor é ecoado');
    assert.equal(e({ ok: false, status: 400, codigo: 'EMPRESA_IE_EXIGIDA' }).campos.inscricaoEstadual.length > 0, true);
    assert.equal(e({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.razaoSocial' }] }).aviso, M.TEXTOS.CAMPO_PROTEGIDO);
    assert.equal(e({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [] }).aviso, M.TEXTOS.CORRIJA);
  });
});

describe('capacidades', () => {
  const area = (v) => ({ consultar: v, alterar: v });
  const perm = (v, ed) => ({
    status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR',
    recursos: { companyData: { visualizar: v, criar: false, editar: ed, excluir: false } }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
    },
  });

  test('editar exige as DUAS permissões (visualizar e editar); só editar não basta — decidido pelo mecanismo central (EpiPermissoes.PAGINAS.companyData)', () => {
    global.EpiPermissoes = require('../js/permissoes-efetivas');
    const M = carregar();
    assert.deepEqual(M.capacidades(perm(true, true)), { visualizar: true, editar: true });
    assert.deepEqual(M.capacidades(perm(true, false)), { visualizar: true, editar: false });
    assert.deepEqual(M.capacidades(perm(false, true)), { visualizar: false, editar: false });
    assert.deepEqual(M.capacidades(perm(false, false)), { visualizar: false, editar: false });
    assert.deepEqual(M.capacidades(null), { visualizar: false, editar: false });
  });
});
