'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * LGPD-1 — card DPO da página pages/lgpd.html: consulta pelo resumo (qualquer lgpd.visualizar) e gestão (designar, substituir,
 * corrigir contato, encerrar) só com lgpdEncarregado visualizar+editar efetivas. Corpo exato do contrato, textos da tela (nunca do
 * servidor), falha fechada, nada em armazenamento do navegador, visual do card preservado.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/lgpd.html';

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ perfil = 'MASTER', gestao = true } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil,
  recursos: { lgpd: { ...NENHUMA, visualizar: true }, lgpdEncarregado: { ...NENHUMA, visualizar: gestao, editar: gestao } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});
const contexto = (perfil = 'MASTER') => ({
  status: 'ok', usuario: { id: 7, nome: 'Eva Teste', email: 'eva@example.invalid', perfil }, empresa: { id: 3, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const principal = (extra = {}) => ({ id: 41, versao: 1, funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Ana Encarregada Teste', razaoSocial: null, vinculo: 'INTERNO', cargo: 'Analista', email: 'dpo.ana@example.invalid', telefone: '(11) 4000-1000', inicioEm: '2026-10-01', ...extra });
const CNPJ_TESTE = '12345678000195'; // fictício, dígitos verificadores válidos
const substituto = (extra = {}) => ({ id: 42, versao: 1, funcao: 'SUBSTITUTO', tipoPessoa: 'PJ', nome: 'Bruno Responsavel', razaoSocial: 'Consultoria Teste Ltda', cnpj: CNPJ_TESTE, vinculo: 'EXTERNO', cargo: null, email: 'dpo.bruno@example.invalid', telefone: null, inicioEm: '2026-10-05', ...extra });
const contato = (e) => (e === null ? null : { tipoPessoa: e.tipoPessoa, nome: e.nome, razaoSocial: e.razaoSocial, cnpj: e.cnpj ?? null, vinculo: e.vinculo, cargo: e.cargo, email: e.email, telefone: e.telefone, inicioEm: e.inicioEm });
const resumo = (enc) => ({ status: 'ok', resumo: { controladora: { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181' }, titulares: { funcionarios: { total: 2, ativos: 2, afastados: 0, inativos: 0 }, usuarios: { total: 1, ativos: 1 } }, encarregado: { principal: contato(enc.principal), substituto: contato(enc.substituto) } } });

function mundo({ perfil = 'MASTER', gestao = true, enc = { principal: null, substituto: null }, rotas = {} } = {}) {
  const estado = { enc };
  return {
    estado,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto(perfil) },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ perfil, gestao }) },
      'GET /lgpd/resumo': () => ({ status: 200, corpo: resumo(estado.enc) }),
      'GET /lgpd/encarregados': () => ({ status: 200, corpo: { status: 'ok', encarregados: estado.enc } }),
      ...rotas,
    },
  };
}
async function pronta(opcoes = {}) {
  const m = mundo(opcoes);
  const pg = abrirPagina(ARQUIVO, { rotas: m.rotas, hash: opcoes.hash || '' });
  for (let i = 0; i < 4; i += 1) await pg.esperar(); // eslint-disable-line no-await-in-loop
  return Object.assign(pg, { estado: m.estado, rotas: m.rotas });
}
const posts = (pg) => pg.chamadas.filter((c) => c.metodo === 'POST');
async function preencher(pg, valores) {
  for (const [campo, valor] of Object.entries(valores)) {
    pg.el(`dpo-${campo}`).value = valor;
    await pg.el(`dpo-${campo}`).disparar('change'); // eslint-disable-line no-await-in-loop
  }
}

describe('consulta (lgpd.visualizar): card DPO alimentado pelo resumo', () => {
  test('sem designação: "Não cadastrado" no principal e no substituto; botão desabilitado com explicação; GET /lgpd/encarregados não é chamado sem a capacidade', async () => {
    const pg = await pronta({ perfil: 'ADMINISTRADOR', gestao: false });
    for (const id of ['dpoNome', 'dpoEmail', 'dpoTel', 'dpoSubNome', 'dpoSubEmail']) assert.equal(pg.texto(id), 'Não cadastrado', id);
    assert.equal(pg.el('dpoEditar').hasAttribute('disabled'), true);
    assert.match(pg.texto('dpoIndisponivel'), /administrada pelo perfil Master/);
    assert.equal(pg.chamadas.some((c) => c.caminho === '/lgpd/encarregados'), false);
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
  });

  test('com designações: principal (nome — cargo, e-mail, telefone) e substituto PJ (razão social · responsável); só texto', async () => {
    const pg = await pronta({ perfil: 'ADMINISTRADOR', gestao: false, enc: { principal: principal({ nome: '<b id="x">Ana</b>' }), substituto: substituto() } });
    assert.equal(pg.texto('dpoNome'), '<b id="x">Ana</b> — Analista');
    assert.equal(pg.existe('x'), false);
    assert.equal(pg.texto('dpoEmail'), 'dpo.ana@example.invalid');
    assert.equal(pg.texto('dpoTel'), '(11) 4000-1000');
    assert.equal(pg.texto('dpoSubNome'), 'Consultoria Teste Ltda (CNPJ 12.345.678/0001-95) · Bruno Responsavel');
    assert.equal(pg.texto('dpoSubEmail'), 'dpo.bruno@example.invalid');
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });

  test('substituto PJ legado (sem CNPJ) e resposta de backend anterior à 095 (sem a chave cnpj): "CNPJ não informado", sem falha', async () => {
    const semCnpj = await pronta({ perfil: 'ADMINISTRADOR', gestao: false, enc: { principal: null, substituto: substituto({ cnpj: null }) } });
    assert.equal(semCnpj.texto('dpoSubNome'), 'Consultoria Teste Ltda (CNPJ não informado) · Bruno Responsavel');
    const semChave = substituto(); delete semChave.cnpj;
    const antigo = await pronta({ perfil: 'ADMINISTRADOR', gestao: false, rotas: { 'GET /lgpd/resumo': { status: 200, corpo: { status: 'ok', resumo: { controladora: { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181' }, titulares: { funcionarios: { total: 1, ativos: 1, afastados: 0, inativos: 0 }, usuarios: { total: 1, ativos: 1 } }, encarregado: { principal: null, substituto: (({ cnpj, ...r }) => r)(contato(semChave)) } } } } } });
    assert.equal(antigo.texto('dpoSubNome'), 'Consultoria Teste Ltda (CNPJ não informado) · Bruno Responsavel');
  });

  test('resumo sem a chave encarregado (contrato do A1) continua aceito: "Não cadastrado"', async () => {
    const pg = await pronta({ perfil: 'ADMINISTRADOR', gestao: false, rotas: { 'GET /lgpd/resumo': { status: 200, corpo: { status: 'ok', resumo: { controladora: { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181' }, titulares: { funcionarios: { total: 1, ativos: 1, afastados: 0, inativos: 0 }, usuarios: { total: 1, ativos: 1 } } } } } } });
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '1');
    assert.equal(pg.texto('dpoNome'), 'Não cadastrado');
  });
});

describe('gestão (lgpdEncarregado visualizar+editar efetivas)', () => {
  test('capacidade vem das permissões efetivas, nunca do perfil: MASTER sem a linha fica só em consulta; com as duas operações o botão abre o modal', async () => {
    const sem = await pronta({ perfil: 'MASTER', gestao: false });
    assert.equal(sem.el('dpoEditar').hasAttribute('disabled'), true);
    assert.equal(sem.chamadas.some((c) => c.caminho === '/lgpd/encarregados'), false);

    const com = await pronta({ perfil: 'MASTER', gestao: true });
    assert.equal(com.chamadas.filter((c) => c.caminho === '/lgpd/encarregados' && c.metodo === 'GET').length, 1);
    assert.equal(com.el('dpoEditar').hasAttribute('disabled'), false);
    assert.match(com.texto('dpoIndisponivel'), /histórico e auditoria/);
    await com.clicar('dpoEditar');
    assert.equal(com.el('dpoModal').classList.contains('open'), true);
    assert.equal(com.el('dpo-acao').value, 'DESIGNAR');
    assert.equal(com.visivel('dpo-razaoSocial'), false, 'PF: razão social escondida');
  });

  test('GET /lgpd/encarregados 403 (permissão retirada): o card segue em consulta e a gestão fica fechada, sem erro na tela', async () => {
    const pg = await pronta({ rotas: { 'GET /lgpd/encarregados': { status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'x' } } } });
    assert.equal(pg.el('dpoEditar').hasAttribute('disabled'), true);
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '2');
    assert.equal(pg.texto('dpoStatus'), '');
  });

  test('designar PF: corpo exato do contrato (sem chaves vazias, sem empresa), 201 → modal fecha, card e status atualizados', async () => {
    const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': (c) => { pg.estado.enc = { principal: principal({ nome: c.corpo.nome, email: c.corpo.email, cargo: null, telefone: null }), substituto: null }; return { status: 201, corpo: { status: 'ok', encarregado: pg.estado.enc.principal } }; } } });
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'DESIGNAR', tipoPessoa: 'PF', vinculo: 'INTERNO', conflito: 'SEM_CONFLITO' });
    pg.el('dpo-nome').value = '  Ana Encarregada Teste ';
    pg.el('dpo-email').value = 'dpo.ana@example.invalid';
    pg.el('dpo-inicioEm').value = '2026-10-01';
    pg.el('dpo-atoReferencia').value = 'Portaria 7/2026';
    await pg.clicar('dpoModalSalvar');
    const p = posts(pg);
    assert.equal(p.length, 1);
    assert.equal(p[0].caminho, '/lgpd/encarregados');
    assert.deepEqual(p[0].corpo, { funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Ana Encarregada Teste', vinculo: 'INTERNO', email: 'dpo.ana@example.invalid', inicioEm: '2026-10-01', conflitoInteresses: 'SEM_CONFLITO', atoReferencia: 'Portaria 7/2026' });
    assert.equal(/empresa|perfil|usuario|cpf/i.test(p[0].corpoBruto), false);
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
    assert.match(pg.texto('dpoStatus'), /designado/i);
    assert.equal(pg.texto('dpoNome'), 'Ana Encarregada Teste');
  });

  test('designar PJ: razão social e CNPJ obrigatórios (validação local, nada enviado); CNPJ com máscara vai normalizado; nome = pessoa natural responsável', async () => {
    const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': { status: 201, corpo: { status: 'ok', encarregado: substituto() } } } });
    await pg.clicar('dpoEditar');
    assert.equal(pg.visivel('dpo-cnpj'), false, 'PF: CNPJ escondido');
    await preencher(pg, { funcao: 'SUBSTITUTO', acao: 'DESIGNAR', tipoPessoa: 'PJ', vinculo: 'EXTERNO' });
    assert.equal(pg.visivel('dpo-razaoSocial'), true);
    assert.equal(pg.visivel('dpo-cnpj'), true, 'PJ: CNPJ visível');
    assert.match(pg.texto('dpo-nome-rotulo'), /Pessoa natural responsável/);
    pg.el('dpo-nome').value = 'Bruno Responsavel';
    pg.el('dpo-email').value = 'dpo.bruno@example.invalid';
    pg.el('dpo-inicioEm').value = '2026-10-05';
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, 0);
    assert.match(pg.texto('dpoModalMsg'), /razão social/i);
    assert.match(pg.texto('dpoModalMsg'), /CNPJ/);
    pg.el('dpo-razaoSocial').value = 'Consultoria Teste Ltda';
    pg.el('dpo-cnpj').value = '1234';
    await pg.el('dpo-cnpj').disparar('input');
    assert.equal(pg.el('dpo-cnpj').value, '12.34', 'máscara progressiva');
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, 0, 'CNPJ curto é recusado localmente');
    pg.el('dpo-cnpj').value = '12345678000195';
    await pg.el('dpo-cnpj').disparar('input');
    assert.equal(pg.el('dpo-cnpj').value, '12.345.678/0001-95');
    await pg.clicar('dpoModalSalvar');
    assert.deepEqual(posts(pg)[0].corpo, { funcao: 'SUBSTITUTO', tipoPessoa: 'PJ', nome: 'Bruno Responsavel', vinculo: 'EXTERNO', email: 'dpo.bruno@example.invalid', inicioEm: '2026-10-05', conflitoInteresses: 'NAO_AVALIADO', razaoSocial: 'Consultoria Teste Ltda', cnpj: CNPJ_TESTE });
  });

  test('CNPJ em "corrigir contato": só aparece para vigente PJ sem CNPJ (legado) e vai normalizado; com CNPJ gravado o campo some e nunca é enviado; PF nunca mostra; 400 do servidor aponta o campo', async () => {
    const chamadas = [];
    const legado = substituto({ cnpj: null });
    const m = { estado: null };
    const pg = await pronta({ enc: { principal: principal(), substituto: legado }, rotas: { 'POST /lgpd/encarregados/42/contato': (c) => { chamadas.push(c); m.estado.enc = { principal: principal(), substituto: substituto() }; return { status: 201, corpo: { status: 'ok', encarregado: substituto() } }; } } });
    m.estado = pg.estado; // o POST "grava" o CNPJ: as releituras seguintes já o trazem
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'SUBSTITUTO', acao: 'CONTATO' });
    assert.equal(pg.visivel('dpo-cnpj'), true, 'legado PJ sem CNPJ: campo oferecido');
    assert.equal(pg.el('dpo-cnpj').value, '');
    pg.el('dpo-cnpj').value = '12.345.678/0001-95';
    await pg.clicar('dpoModalSalvar');
    assert.deepEqual(chamadas[0].corpo, { versao: 1, cnpj: CNPJ_TESTE }, 'só o CNPJ, normalizado');
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho === '/lgpd/encarregados').length, 2, 'os vigentes foram relidos depois de salvar (o clique aguarda a releitura)');
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'SUBSTITUTO', acao: 'CONTATO' });
    assert.equal(pg.visivel('dpo-cnpj'), false, 'CNPJ já gravado: não é corrigível por aqui');
    pg.el('dpo-telefone').value = '(11) 5000-2000';
    await pg.clicar('dpoModalSalvar');
    assert.deepEqual(chamadas[1].corpo, { versao: 1, telefone: '(11) 5000-2000' }, 'o CNPJ nunca entra');
    for (let i = 0; i < 3; i += 1) await pg.esperar(); // eslint-disable-line no-await-in-loop
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'CONTATO' });
    assert.equal(pg.visivel('dpo-cnpj'), false, 'PF: nunca');
    await pg.clicar('dpoModalCancelar');
    // 400 do servidor em body.cnpj → mensagem do campo, modal aberto
    const pg2 = await pronta({ rotas: { 'POST /lgpd/encarregados': { status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', detalhes: [{ campo: 'body.cnpj', codigo: 'CNPJ_DV_INVALIDO' }] } } } });
    await pg2.clicar('dpoEditar');
    await preencher(pg2, { funcao: 'PRINCIPAL', acao: 'DESIGNAR', tipoPessoa: 'PJ', nome: 'Bruno', razaoSocial: 'X Ltda', cnpj: '12345678000196', email: 'b@example.invalid', inicioEm: '05/10/2026' });
    await pg2.clicar('dpoModalSalvar');
    assert.match(pg2.texto('dpoModalMsg'), /CNPJ/);
    assert.equal(pg2.el('dpoModal').classList.contains('open'), true);
  });

  test('com vigente: Designar fica bloqueado (aviso), Substituir envia versão e fimAnteriorEm, Corrigir contato envia só o que mudou, Encerrar envia versão e data', async () => {
    const chamadas = [];
    const pg = await pronta({ enc: { principal: principal(), substituto: null }, rotas: {
      'POST /lgpd/encarregados/41/substituir': (c) => { chamadas.push(c); return { status: 201, corpo: { status: 'ok', encarregado: principal({ id: 50 }) } }; },
      'POST /lgpd/encarregados/41/contato': (c) => { chamadas.push(c); return { status: 201, corpo: { status: 'ok', encarregado: principal({ id: 51 }) } }; },
      'POST /lgpd/encarregados/41/encerrar': (c) => { chamadas.push(c); return { status: 200, corpo: { status: 'ok', encarregado: principal({ situacao: 'ENCERRADA' }) } }; },
    } });
    await pg.clicar('dpoEditar');
    assert.deepEqual([pg.el('dpo-funcao').value, pg.el('dpo-acao').value], ['SUBSTITUTO', 'DESIGNAR'], 'o modal sugere a função ainda vaga');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'DESIGNAR' });
    assert.match(pg.texto('dpoModalMsg'), /Já existe uma designação vigente/);
    assert.equal(pg.el('dpoModalSalvar').hasAttribute('disabled'), true);

    await preencher(pg, { acao: 'SUBSTITUIR', tipoPessoa: 'PF', vinculo: 'INTERNO' });
    pg.el('dpo-nome').value = 'Carla Nova';
    pg.el('dpo-email').value = 'dpo.carla@example.invalid';
    pg.el('dpo-inicioEm').value = '2026-10-20';
    pg.el('dpo-fimEm').value = '2026-10-19';
    await pg.clicar('dpoModalSalvar');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].caminho, '/lgpd/encarregados/41/substituir');
    assert.deepEqual(chamadas[0].corpo, { funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Carla Nova', vinculo: 'INTERNO', email: 'dpo.carla@example.invalid', inicioEm: '2026-10-20', conflitoInteresses: 'NAO_AVALIADO', versao: 1, fimAnteriorEm: '2026-10-19' });
    assert.match(pg.texto('dpoStatus'), /substituído/i);

    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'CONTATO' });
    assert.equal(pg.el('dpo-email').value, 'dpo.ana@example.invalid', 'preenchido com o contato vigente');
    assert.equal(pg.visivel('dpo-nome'), false, 'nome não é corrigível por aqui');
    await pg.clicar('dpoModalSalvar');
    assert.equal(chamadas.length, 1, 'sem alteração nada é enviado');
    assert.match(pg.texto('dpoModalMsg'), /Nenhum contato/);
    pg.el('dpo-telefone').value = '(11) 5000-2000';
    pg.el('dpo-cargo').value = '';
    await pg.clicar('dpoModalSalvar');
    assert.deepEqual(chamadas[1].corpo, { versao: 1, telefone: '(11) 5000-2000', cargo: null });

    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'ENCERRAR' });
    pg.el('dpo-fimEm').value = '2026-10-27';
    await pg.clicar('dpoModalSalvar');
    assert.deepEqual(chamadas[2].corpo, { versao: 1, fimEm: '2026-10-27' });
    assert.match(pg.texto('dpoStatus'), /encerrada/i);
  });

  test('erros do servidor com textos da tela (nunca o texto do servidor): 409 versão relê os vigentes; 400 aponta o campo; 403 avisa; rede avisa', async () => {
    const casos = [
      [{ status: 409, corpo: { status: 'error', codigo: 'LGPD_DPO_VERSAO_DESATUALIZADA', message: 'ECO-SERVIDOR' } }, /alterada por outra pessoa/],
      [{ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'ECO-SERVIDOR', detalhes: [{ campo: 'body.email', codigo: 'EMAIL_INVALIDO', mensagem: 'ECO-SERVIDOR' }] } }, /e-mail profissional/],
      [{ status: 403, corpo: { status: 'error', codigo: 'LGPD_DPO_SOMENTE_MASTER', message: 'ECO-SERVIDOR' } }, /não tem autorização/],
      [new Error('rede'), /servidor|conexão/],
    ];
    for (const [resposta, esperado] of casos) {
      const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': resposta } });
      await pg.clicar('dpoEditar');
      pg.el('dpo-nome').value = 'Ana';
      pg.el('dpo-email').value = 'a@b.invalid';
      pg.el('dpo-inicioEm').value = '2026-10-01';
      await pg.clicar('dpoModalSalvar');
      assert.match(pg.texto('dpoModalMsg'), esperado);
      assert.equal(pg.textoDoDom().includes('ECO-SERVIDOR'), false);
      assert.equal(pg.el('dpoModal').classList.contains('open'), true, 'o modal fica aberto para corrigir');
    }
  });

  test('401 ao salvar: conteúdo protegido some e a pessoa vai ao Portal; nada em localStorage/sessionStorage além do cache do tema', async () => {
    const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } });
    await pg.clicar('dpoEditar');
    pg.el('dpo-nome').value = 'Ana';
    pg.el('dpo-email').value = 'a@b.invalid';
    pg.el('dpo-inicioEm').value = '2026-10-01';
    await pg.clicar('dpoModalSalvar');
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.ok(pg.navegacoes.some((n) => /portal\/index\.html/.test(n)));
    assert.deepEqual(pg.storage.filter((s) => s.operacao === 'setItem').map((s) => s.chave), ['safework-aparencia']);
  });

  test('toque duplo: um único POST enquanto o primeiro está em andamento', async () => {
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': async () => { await espera; return { status: 201, corpo: { status: 'ok', encarregado: principal() } }; } } });
    await pg.clicar('dpoEditar');
    pg.el('dpo-nome').value = 'Ana';
    pg.el('dpo-email').value = 'a@b.invalid';
    pg.el('dpo-inicioEm').value = '2026-10-01';
    pg.el('dpoModalSalvar').disparar('click');
    pg.el('dpoModalSalvar').disparar('click');
    await pg.esperar();
    liberar();
    await pg.esperar(); await pg.esperar();
    assert.equal(posts(pg).length, 1);
  });
});

describe('módulo e página', () => {
  test('formulario.corpoDesignacao/corpoContato/corpoEncerramento são puros e produzem o contrato exato; erroDoServidor nunca ecoa o servidor', () => {
    const EpiPermissoes = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    const sandbox = { EpiHttp: { requisitar: async () => ({}), ehNaoAutenticado: () => false, ehSemAutorizacao: () => false, ehFalhaDeRede: (r) => r.status === 0 }, EpiPermissoes, console, Promise, String, Object, Array, Number, Math, TypeError, Error, JSON };
    sandbox.window = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8'), sandbox);
    const F = sandbox.EpiLgpd.formulario;
    const r = F.corpoDesignacao({ funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: ' Ana ', razaoSocial: '', vinculo: 'INTERNO', cargo: '', email: 'a@b.invalid', telefone: '', inicioEm: '2026-10-01', atoReferencia: '', atoData: '', conflitoInteresses: 'NAO_AVALIADO', conflitoNota: '' });
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, corpo: { funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Ana', vinculo: 'INTERNO', email: 'a@b.invalid', inicioEm: '2026-10-01', conflitoInteresses: 'NAO_AVALIADO' } });
    // Validação local só de formato e coerência; o calendário (2026-13-01) é do servidor (400 com o campo apontado).
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoDesignacao({ funcao: 'PRINCIPAL', tipoPessoa: 'PJ', nome: 'B', razaoSocial: '', vinculo: 'EXTERNO', email: 'x', inicioEm: '2026-10-01', atoData: '2026-10-01', atoReferencia: '', conflitoInteresses: 'NAO_AVALIADO' }))).campos, ['razaoSocial', 'cnpj', 'email', 'atoData']);
    const vigente = { versao: 3, email: 'a@b.invalid', telefone: null, cargo: 'X' };
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato(vigente, { email: 'a@b.invalid', telefone: '', cargo: 'X' }))), { ok: false, campos: [], semAlteracao: true });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato(vigente, { email: 'n@b.invalid', telefone: '11 4000-1000', cargo: '' }))), { ok: true, corpo: { versao: 3, email: 'n@b.invalid', telefone: '11 4000-1000', cargo: null } });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento(vigente, { fimEm: '' }))), { ok: true, corpo: { versao: 3 } });
    assert.equal(F.erroDoServidor({ ok: false, status: 500, codigo: 'ERRO_INTERNO', mensagem: 'ECO' }).includes('ECO'), false);
    assert.equal(sandbox.EpiLgpd.capacidades({ recursos: { lgpdEncarregado: { visualizar: true, criar: false, editar: true, excluir: false } } }).editarEncarregado, true);
    assert.equal(sandbox.EpiLgpd.capacidades({ recursos: { lgpdEncarregado: { visualizar: true, criar: false, editar: false, excluir: false } } }).editarEncarregado, false);
    assert.equal(sandbox.EpiLgpd.capacidades({ perfil: 'MASTER', recursos: {} }).editarEncarregado, false, 'o perfil não decide');
  });

  test('visual do card preservado: mesmos ids e classes do card DPO; modal fora do conteúdo protegido; sem manipulador inline; sem innerHTML/armazenamento no módulo', () => {
    const html = fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8');
    for (const trecho of ['class="card lgpd-dpo"', 'id="dpoEditar"', 'id="dpoNome"', 'id="dpoEmail"', 'id="dpoTel"', 'id="dpoEmpresa"', 'class="notice" id="dpoIndisponivel"', 'id="dpoSubNome"', 'id="dpoSubEmail"']) assert.ok(html.includes(trecho), trecho);
    assert.doesNotMatch(html, /\son(click|keydown|change|submit|load|input)\s*=/i);
    const posConteudo = html.indexOf('id="dpoModal"') > html.indexOf('</main>');
    assert.equal(posConteudo, true, 'o modal fica fora do conteúdo protegido');
    const js = fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie|perfil === 'MASTER'/);
  });
});

describe('modal responsivo e acessível (correção de 27/10/2026)', () => {
  test('CSS: só #dpoModal recebe altura máxima pela janela, rolagem interna no formulário, cabeçalho/rodapé fixos e colunas por espaço; lgpd.css e os modais vizinhos intocados', () => {
    const css = fs.readFileSync(path.join(RAIZ, 'css', 'integracao-visual.css'), 'utf8');
    const bloco = css.slice(css.indexOf('#dpoModal'));
    assert.ok(bloco.length > 0, 'regra do #dpoModal presente em integracao-visual.css');
    assert.match(css, /body\.integracao-visual #dpoModal \.modal-card\{[^}]*display:flex;flex-direction:column;min-height:0;[^}]*max-height:calc\(100vh - 40px\);max-height:calc\(100dvh - 40px\)/);
    assert.match(css, /body\.integracao-visual #dpoModal \.form-grid\{[^}]*flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;[^}]*grid-template-columns:repeat\(auto-fit,minmax\(260px,1fr\)\)/);
    assert.match(css, /body\.integracao-visual #dpoModal \.modal-header\{flex:none;/);
    assert.match(css, /body\.integracao-visual #dpoModal \.footer-actions\{flex:none;/);
    assert.match(css, /@media\(max-width:560px\)\{\s*body\.integracao-visual #dpoModal\{padding:0;align-items:flex-end\}[\s\S]*?#dpoModal \.form-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
    // Nenhuma regra nova sem o id: os outros modais (#destinatarioModal, #titularModal) continuam só com as regras anteriores.
    const regrasDpo = css.match(/^[^@\n{]*#dpoModal[^{]*\{/gm) || [];
    assert.ok(regrasDpo.length >= 10);
    for (const r of regrasDpo) {
      assert.match(r.trim(), /^body\.integracao-visual #dpoModal(\s|\.|\{)/, `cada regra nova é escopada ao #dpoModal: ${r.trim()}`);
      assert.doesNotMatch(r, /#destinatarioModal|#titularModal/);
    }
    assert.equal(/body\.integracao-visual :is\(#destinatarioModal,#titularModal\) \.modal-card\{border-radius:32px;padding:20px;max-height:calc\(100vh - 40px\)/.test(css), true, 'regra dos modais vizinhos preservada');
    assert.equal(/modal|overlay|dialog/i.test(fs.readFileSync(path.join(RAIZ, 'css', 'lgpd.css'), 'utf8')), false, 'lgpd.css continua sem regra de modal');
    const fimDoBloco = bloco.indexOf('#dpoModal .form-grid{grid-template-columns:minmax(0,1fr)}');
    assert.ok(fimDoBloco > 0, 'bloco do #dpoModal termina na regra de uma coluna');
    assert.doesNotMatch(bloco.slice(0, fimDoBloco), /!important/, 'nenhum !important no bloco novo');
  });

  test('teclado: abre com foco no primeiro campo; Escape fecha como Cancelar (sem POST) e devolve o foco ao botão Editar; Tab e Shift+Tab ficam dentro do modal, pulando campos ocultos pela operação', async () => {
    const pg = await pronta();
    pg.el('dpoEditar').focus();
    await pg.clicar('dpoEditar');
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    assert.equal(pg.foco(), 'dpo-funcao', 'foco inicial no primeiro campo');
    // Tab a partir do último focável volta ao primeiro; Shift+Tab a partir do primeiro vai ao último.
    pg.el('dpoModalSalvar').focus();
    const ev1 = await pg.el('dpoModalSalvar').disparar('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(ev1.defaultPrevented, true);
    assert.equal(pg.foco(), 'dpoModalFechar', 'o primeiro focável é o botão fechar do cabeçalho');
    const ev2 = await pg.el('dpoModalFechar').disparar('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(ev2.defaultPrevented, true);
    assert.equal(pg.foco(), 'dpoModalSalvar');
    // Tab no meio do formulário não é interceptado (o navegador segue a ordem natural).
    pg.el('dpo-nome').focus();
    const ev3 = await pg.el('dpo-nome').disparar('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(ev3.defaultPrevented, false);
    // Operação Encerrar esconde os campos da designação: o último focável antes do rodapé muda, e o ciclo os ignora.
    await preencher(pg, { acao: 'ENCERRAR' });
    pg.el('dpoModalSalvar').disabled = false;
    pg.el('dpoModalSalvar').focus();
    await pg.el('dpoModalSalvar').disparar('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(pg.foco(), 'dpoModalFechar');
    await pg.el('dpoModalFechar').disparar('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(pg.foco(), 'dpoModalSalvar');
    // Escape = cancelar: fecha, limpa a mensagem, nada enviado, foco de volta ao botão Editar.
    const antes = posts(pg).length;
    const esc = await pg.el('dpo-funcao').disparar('keydown', { key: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
    assert.equal(posts(pg).length, antes, 'Escape nunca envia');
    assert.equal(pg.foco(), 'dpoEditar', 'foco devolvido a quem abriu');
    // Com o modal fechado, Escape e Tab não fazem nada.
    const fechado = await pg.el('dpoModal').disparar('keydown', { key: 'Escape' });
    assert.equal(fechado.defaultPrevented, false);
    assert.equal(pg.foco(), 'dpoEditar');
    // Clique no fundo não fecha (decisão: evitar perda do digitado).
    await pg.clicar('dpoEditar');
    await pg.el('dpoModal').disparar('click');
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
  });
});

describe('modal após F5: estado mínimo no fragmento da URL (correção de 28/10/2026)', () => {
  const FRAG = '#dpo=SUBSTITUIR.PRINCIPAL.e3';
  const replaces = (pg) => pg.historico.filter((h) => h.metodo === 'replaceState');

  test('fragmento: só operação, função e id da empresa; qualquer outro formato é rejeitado', () => {
    const EpiPermissoes = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    const sandbox = { EpiHttp: {}, EpiPermissoes, console, Promise, String, Object, Array, Number, Math, TypeError, Error, JSON, RegExp, Boolean };
    sandbox.window = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8'), sandbox);
    const F = sandbox.EpiLgpd.fragmento;
    assert.deepEqual(JSON.parse(JSON.stringify(F.ler(FRAG))), { operacao: 'SUBSTITUIR', funcao: 'PRINCIPAL', empresaId: 3 });
    assert.equal(F.montar('CONTATO', 'SUBSTITUTO', 12), '#dpo=CONTATO.SUBSTITUTO.e12');
    for (const ruim of ['#dpo=', '#dpo=DROP.PRINCIPAL.e3', '#dpo=DESIGNAR.X.e3', '#dpo=DESIGNAR.PRINCIPAL.e0', '#dpo=DESIGNAR.PRINCIPAL.e3.nome=Ana', '#dpo=DESIGNAR.PRINCIPAL', '#ativar=abc', '', null, undefined]) assert.equal(F.ler(ruim), null, String(ruim));
    assert.equal(F.montar('DESIGNAR', 'PRINCIPAL', null), null);
    assert.equal(F.montar('APAGAR', 'PRINCIPAL', 3), null);
    assert.equal(F.ehDoDpo('#dpo=lixo'), true);
    assert.equal(F.ehDoDpo('#outro'), false);
  });

  test('abrir grava o fragmento por replaceState (sem pushState); trocar operação ou função atualiza; Cancelar, X, Escape apagam', async () => {
    const pg = await pronta({ enc: { principal: principal(), substituto: null } });
    assert.equal(pg.location.hash, '');
    await pg.clicar('dpoEditar');
    assert.equal(pg.location.hash, '#dpo=DESIGNAR.SUBSTITUTO.e3', 'sugere a função vaga: SUBSTITUTO/Designar');
    assert.equal(pg.historico.some((h) => h.metodo === 'pushState'), false);
    await preencher(pg, { funcao: 'PRINCIPAL' });
    assert.equal(pg.location.hash, '#dpo=DESIGNAR.PRINCIPAL.e3');
    await preencher(pg, { acao: 'CONTATO' });
    assert.equal(pg.location.hash, '#dpo=CONTATO.PRINCIPAL.e3');
    await pg.clicar('dpoModalCancelar');
    assert.equal(pg.location.hash, '');
    await pg.clicar('dpoEditar');
    await pg.clicar('dpoModalFechar');
    assert.equal(pg.location.hash, '');
    await pg.clicar('dpoEditar');
    await pg.el('dpo-funcao').disparar('keydown', { key: 'Escape' });
    assert.equal(pg.location.hash, '');
    assert.ok(replaces(pg).length >= 6);
    for (const h of replaces(pg)) assert.doesNotMatch(String(h.url), /@|Ana|4000|Encarregada/, 'nunca dado pessoal na URL');
  });

  test('F5 com permissão: reabre na operação e função gravadas, depois das cargas; contato do vigente preenchido; foco em Função; Escape devolve ao botão Editar', async () => {
    const pg = await pronta({ enc: { principal: principal(), substituto: null }, hash: '#dpo=CONTATO.PRINCIPAL.e3' });
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    assert.deepEqual([pg.el('dpo-funcao').value, pg.el('dpo-acao').value], ['PRINCIPAL', 'CONTATO']);
    assert.equal(pg.el('dpo-email').value, 'dpo.ana@example.invalid');
    assert.equal(pg.foco(), 'dpo-funcao');
    assert.equal(pg.location.hash, '#dpo=CONTATO.PRINCIPAL.e3');
    await pg.el('dpo-funcao').disparar('keydown', { key: 'Escape' });
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
    assert.equal(pg.foco(), 'dpoEditar');
    assert.equal(pg.location.hash, '');
  });

  test('F5 sem a permissão efetiva: nada abre e o fragmento é apagado; sem sessão: vai ao Portal sem restaurar', async () => {
    const semPermissao = await pronta({ perfil: 'ADMINISTRADOR', gestao: false, hash: FRAG });
    assert.equal(semPermissao.el('dpoModal').classList.contains('open'), false);
    assert.equal(semPermissao.location.hash, '');
    assert.equal(semPermissao.chamadas.some((c) => c.caminho === '/lgpd/encarregados'), false);
    const semSessao = await pronta({ hash: FRAG, rotas: { 'GET /auth/me': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA' } } } });
    assert.equal(semSessao.el('dpoModal').classList.contains('open'), false);
    assert.equal(semSessao.chamadas.some((c) => c.caminho === '/lgpd/encarregados'), false);
  });

  test('F5 com fragmento de outra empresa ou malformado: modal fechado e fragmento apagado, sem exceção', async () => {
    for (const hash of ['#dpo=SUBSTITUIR.PRINCIPAL.e9', '#dpo=DROP.X.e3', '#dpo=', '#dpo=DESIGNAR.PRINCIPAL.e3.extra']) {
      const pg = await pronta({ enc: { principal: principal(), substituto: null }, hash }); // eslint-disable-line no-await-in-loop
      assert.equal(pg.el('dpoModal').classList.contains('open'), false, hash);
      assert.equal(pg.location.hash, '', hash);
      assert.equal(pg.consoleChamadas.filter((l) => l.nivel === 'error').length, 0, hash);
    }
    const alheio = await pronta({ enc: { principal: principal(), substituto: null }, hash: '#outra=coisa' });
    assert.equal(alheio.location.hash, '#outra=coisa', 'fragmento que não é do DPO não é tocado');
  });

  test('Salvar com sucesso apaga o fragmento; 400 e 409 mantêm modal e fragmento; 401 apaga e encerra; reler vigentes após 409 não reinicia o formulário', async () => {
    const respostas = [];
    const pg = await pronta({ enc: { principal: principal(), substituto: null }, rotas: { 'POST /lgpd/encarregados/41/encerrar': () => respostas.shift() } });
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'ENCERRAR' });
    assert.equal(pg.location.hash, '#dpo=ENCERRAR.PRINCIPAL.e3');
    respostas.push({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', detalhes: [{ caminho: 'body.fimEm' }] } });
    await pg.clicar('dpoModalSalvar');
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    assert.equal(pg.location.hash, '#dpo=ENCERRAR.PRINCIPAL.e3');
    respostas.push({ status: 409, corpo: { status: 'error', codigo: 'LGPD_DPO_VERSAO_DESATUALIZADA' } });
    await pg.clicar('dpoModalSalvar');
    for (let i = 0; i < 3; i += 1) await pg.esperar(); // eslint-disable-line no-await-in-loop
    assert.equal(pg.el('dpoModal').classList.contains('open'), true, '409 relê os vigentes e mantém o modal');
    assert.equal(pg.el('dpo-acao').value, 'ENCERRAR', 'a releitura não reinicia a operação');
    assert.equal(pg.location.hash, '#dpo=ENCERRAR.PRINCIPAL.e3');
    pg.estado.enc = { principal: null, substituto: null };
    respostas.push({ status: 200, corpo: { status: 'ok', encarregado: { ...principal(), situacao: 'ENCERRADA' } } });
    await pg.clicar('dpoModalSalvar');
    for (let i = 0; i < 3; i += 1) await pg.esperar(); // eslint-disable-line no-await-in-loop
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
    assert.equal(pg.location.hash, '');
    // 401 ao salvar: fragmento apagado, página encerrada.
    const pg2 = await pronta({ enc: { principal: principal(), substituto: null }, rotas: { 'POST /lgpd/encarregados/41/encerrar': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA' } } } });
    await pg2.clicar('dpoEditar');
    await preencher(pg2, { funcao: 'PRINCIPAL', acao: 'ENCERRAR' });
    await pg2.clicar('dpoModalSalvar');
    for (let i = 0; i < 3; i += 1) await pg2.esperar(); // eslint-disable-line no-await-in-loop
    assert.equal(pg2.location.hash, '');
    assert.equal(pg2.el('dpoModal').classList.contains('open'), false);
  });

  test('beforeunload: só com o modal aberto e algo digitado; o preenchimento automático do contato não conta; desligado ao fechar', async () => {
    const pg = await pronta({ enc: { principal: principal(), substituto: null } });
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 0, 'nada registrado com o modal fechado');
    await pg.clicar('dpoEditar');
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 1);
    // O manipulador devolve '' (e chama preventDefault / define returnValue) só quando há algo digitado; senão devolve undefined.
    const avisa = async () => {
      const marcas = { chamado: false };
      const ev = { preventDefault() { marcas.chamado = true; } };
      const [retorno] = await pg.eventoDaJanela('beforeunload', ev);
      return { retorno, preventDefault: marcas.chamado };
    };
    assert.deepEqual(await avisa(), { retorno: undefined, preventDefault: false }, 'formulário vazio: sem aviso');
    pg.el('dpo-nome').value = 'HOMOLOGAÇÃO LGPD-1';
    assert.deepEqual(await avisa(), { retorno: '', preventDefault: true }, 'com texto digitado: aviso');
    // Corrigir contato: os valores preenchidos pela tela não são "digitados".
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'CONTATO' });
    assert.deepEqual(await avisa(), { retorno: undefined, preventDefault: false }, 'contato igual ao vigente: sem aviso');
    pg.el('dpo-telefone').value = '(11) 4000-2000';
    assert.deepEqual(await avisa(), { retorno: '', preventDefault: true });
    // Campo digitado mas escondido pela operação não conta.
    await preencher(pg, { acao: 'ENCERRAR' });
    assert.deepEqual(await avisa(), { retorno: undefined, preventDefault: false }, 'telefone oculto em Encerrar: sem aviso');
    await pg.clicar('dpoModalCancelar');
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 0, 'Cancelar desliga o aviso');
  });

  test('restauração incoerente (fragmento SUBSTITUIR sem vigente): abre com a proteção existente, Salvar desabilitado', async () => {
    const pg = await pronta({ hash: FRAG });
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    assert.equal(pg.el('dpoModalSalvar').hasAttribute('disabled'), true);
    assert.match(pg.texto('dpoModalMsg'), /vigente/i);
  });

  test('regra preservada: nenhum localStorage/sessionStorage/cookie no módulo; o fragmento nunca leva o que foi digitado', async () => {
    const js = fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8');
    assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|pushState/);
    const pg = await pronta();
    await pg.clicar('dpoEditar');
    await preencher(pg, { nome: 'Pessoa Digitada', email: 'digitado@example.invalid', telefone: '(11) 4000-9999' });
    await preencher(pg, { tipoPessoa: 'PJ' });
    assert.equal(pg.location.hash, '#dpo=DESIGNAR.PRINCIPAL.e3');
    assert.deepEqual(pg.storage.filter((s) => s.operacao === 'setItem').map((s) => s.chave), ['safework-aparencia'], 'só o cache de pintura do tema');
    assert.deepEqual(pg.storage.filter((s) => s.storage === 'sessionStorage' && s.operacao === 'setItem'), [], 'nada gravado em sessionStorage (a limpeza do cache legado é da infraestrutura compartilhada)');
  });
});

describe('datas: digitação, colagem e calendário nativo (correção de 28/10/2026)', () => {
  const carregarModulo = () => {
    const EpiPermissoes = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    const sandbox = { EpiHttp: { ehFalhaDeRede: () => false }, EpiPermissoes, console, Promise, String, Object, Array, Number, Math, TypeError, Error, JSON, RegExp, Boolean };
    sandbox.window = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8'), sandbox);
    return sandbox.EpiLgpd.formulario;
  };

  test('normalizarCnpj/mascaraCnpj: 14 posições canônicas (alfanumérico maiúsculo), máscara 00.000.000/0000-00, formato errado é null; corpoDesignacao PJ exige e normaliza; corpoContato só completa legado', () => {
    const F = carregarModulo();
    assert.equal(F.normalizarCnpj('12.345.678/0001-95'), '12345678000195');
    assert.equal(F.normalizarCnpj(' ab.cde.fgh/0001-95 '), 'ABCDEFGH000195', 'alfanumérico: letras nas 12 primeiras posições, maiúsculas');
    assert.equal(F.normalizarCnpj(''), '');
    for (const ruim of ['1234', '12345678000195X', '1234567800019A', '12.345.678/0001-9']) assert.equal(F.normalizarCnpj(ruim), null, ruim);
    assert.deepEqual(['1', '12', '123', '12345', '123456789', '1234567800019', '12345678000195', '12345678000195999', 'ab.cd'].map(F.mascaraCnpj), ['1', '12', '12.3', '12.345', '12.345.678/9', '12.345.678/0001-9', '12.345.678/0001-95', '12.345.678/0001-95', 'AB.CD']);
    const base = { funcao: 'SUBSTITUTO', tipoPessoa: 'PJ', nome: 'B', razaoSocial: 'X Ltda', vinculo: 'EXTERNO', cargo: '', email: 'b@b.invalid', telefone: '', inicioEm: '05/10/2026', atoReferencia: '', atoData: '', conflitoInteresses: 'NAO_AVALIADO', conflitoNota: '' };
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoDesignacao({ ...base, cnpj: '' }).campos)), ['cnpj']);
    assert.equal(F.corpoDesignacao({ ...base, cnpj: '12.345.678/0001-95' }).corpo.cnpj, '12345678000195');
    assert.equal('cnpj' in F.corpoDesignacao({ ...base, tipoPessoa: 'PF', razaoSocial: '', cnpj: '12345678000195' }).corpo, false, 'PF nunca envia CNPJ');
    const legado = { versao: 2, tipoPessoa: 'PJ', cnpj: null, email: 'a@b.invalid', telefone: null, cargo: null };
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato(legado, { email: 'a@b.invalid', telefone: '', cargo: '', cnpj: '12.345.678/0001-95' }))), { ok: true, corpo: { versao: 2, cnpj: '12345678000195' } });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato(legado, { email: 'a@b.invalid', telefone: '', cargo: '', cnpj: '12' }))), { ok: false, campos: ['cnpj'] });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato({ ...legado, cnpj: '12345678000195' }, { email: 'a@b.invalid', telefone: '', cargo: '', cnpj: '98765432000198' }))), { ok: false, campos: [], semAlteracao: true }, 'CNPJ gravado: ignorado, nunca enviado');
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoContato({ ...legado, tipoPessoa: 'PF' }, { email: 'a@b.invalid', telefone: '', cargo: '', cnpj: '12345678000195' }))), { ok: false, campos: [], semAlteracao: true }, 'PF: ignorado');
  });

  test('normalizarData: DD/MM/AAAA, D/M/AAAA, DD/MM/AA (26 → 2026) e AAAA-MM-DD viram ISO; calendário inválido é null; vazio é ""', () => {
    const F = carregarModulo();
    assert.equal(F.normalizarData('27/10/2026'), '2026-10-27');
    assert.equal(F.normalizarData('1/2/2026'), '2026-02-01');
    assert.equal(F.normalizarData('27/10/26'), '2026-10-27', 'dois dígitos: sempre 20AA');
    assert.equal(F.normalizarData('01/01/00'), '2000-01-01');
    assert.equal(F.normalizarData('2026-10-27'), '2026-10-27');
    assert.equal(F.normalizarData('  29/02/2028 '), '2028-02-29', 'bissexto');
    assert.equal(F.normalizarData(''), '');
    assert.equal(F.normalizarData('   '), '');
    for (const ruim of ['31/02/2026', '29/02/2025', '29/02/2100', '00/01/2026', '32/01/2026', '10/13/2026', '27/10/1899', '27/10/2101', 'aa/bb/cccc', '2026-02-30', '27-10-2026', '27/10/202', '271026']) assert.equal(F.normalizarData(ruim), null, String(ruim));
    for (const naoTexto of [27, null, undefined]) assert.equal(F.normalizarData(naoTexto), '', `${String(naoTexto)}: não-texto é tratado como vazio, como em limpar()`);
    assert.equal(F.dataParaBr('2026-10-27'), '27/10/2026');
    assert.equal(F.dataParaBr('lixo'), 'lixo');
    assert.equal(F.dataParaBr(null), '');
    // Dígitos corridos ganham barras; texto com barras ou hífen (digitado ou colado) é preservado para a validação.
    assert.deepEqual(['2', '27', '271', '2710', '27102', '27102026', '27102026999', 'ab27cd10'].map(F.mascaraData), ['2', '27', '27/1', '27/10', '27/10/2', '27/10/2026', '27/10/2026', '27/10']);
    assert.deepEqual(['27/10/2026', '1/10/26', '1/2/2026', '2026-10-27', ' 27/10/2026 ', '27/10/2026x', '31/02'].map(F.mascaraData), ['27/10/2026', '1/10/26', '1/2/2026', '2026-10-27', '27/10/2026', '27/10/2026', '31/02']);
    // Corpos: o contrato continua ISO.
    const base = { funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Ana', razaoSocial: '', vinculo: 'INTERNO', cargo: '', email: 'a@b.invalid', telefone: '', atoReferencia: 'Portaria 1', conflitoInteresses: 'NAO_AVALIADO', conflitoNota: '' };
    const r = F.corpoDesignacao({ ...base, inicioEm: '27/10/26', atoData: '1/10/2026' });
    assert.deepEqual([r.corpo.inicioEm, r.corpo.atoData], ['2026-10-27', '2026-10-01']);
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoDesignacao({ ...base, inicioEm: '31/02/2026', atoData: '' }).campos)), ['inicioEm']);
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoDesignacao({ ...base, inicioEm: '27/10/2026', atoData: '27/10/2026', atoReferencia: '' }).campos)), ['atoData'], 'data do ato exige a referência');
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento({ versao: 2 }, { fimEm: '28/10/2026' }))), { ok: true, corpo: { versao: 2, fimEm: '2026-10-28' } });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento({ versao: 2 }, { fimEm: '' }))), { ok: true, corpo: { versao: 2 } });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento({ versao: 2 }, { fimEm: '30/02/2026' }))), { ok: false, campos: ['fimEm'] });
  });

  test('página: os três campos são de texto com placeholder DD/MM/AAAA; colar 27/10/2026 envia ISO; máscara ao digitar; data inválida é recusada com a mensagem do campo', async () => {
    const pg = await pronta({ rotas: { 'POST /lgpd/encarregados': (req) => ({ status: 201, corpo: { status: 'ok', encarregado: { ...principal(), ...req.corpo, id: 50 }, encarregados: { principal: principal(), substituto: null } } }) } });
    for (const id of ['dpo-inicioEm', 'dpo-atoData', 'dpo-fimEm']) {
      assert.equal(pg.el(id).getAttribute('type'), 'text', id);
      assert.equal(pg.el(id).getAttribute('placeholder'), 'DD/MM/AAAA', id);
      assert.equal(pg.el(id).getAttribute('maxlength'), '10', id);
      assert.ok(pg.existe(`${id}-seletor`) && pg.existe(`${id}-abrir`), `${id}: calendário e botão presentes`);
    }
    await pg.clicar('dpoEditar');
    await preencher(pg, { nome: 'HOMOLOGAÇÃO LGPD-1', email: 'h@homologacao.invalid', atoReferencia: 'Portaria 1' });
    // Colagem de DD/MM/AAAA e de DD/MM/AA
    pg.el('dpo-inicioEm').value = '27/10/2026';
    await pg.el('dpo-inicioEm').disparar('input');
    assert.equal(pg.el('dpo-inicioEm').value, '27/10/2026');
    pg.el('dpo-atoData').value = '1/10/26';
    await pg.el('dpo-atoData').disparar('input');
    // Máscara progressiva ao digitar
    pg.el('dpo-fimEm').value = '3102';
    await pg.el('dpo-fimEm').disparar('input');
    assert.equal(pg.el('dpo-fimEm').value, '31/02');
    await pg.clicar('dpoModalSalvar');
    const [post] = posts(pg);
    assert.deepEqual([post.corpo.inicioEm, post.corpo.atoData], ['2026-10-27', '2026-10-01'], 'contrato ISO preservado');
    assert.equal('fimEm' in post.corpo, false, 'Designar não envia fimEm');
    // Data inválida: recusa local com o nome do campo, sem POST
    for (let i = 0; i < 3; i += 1) await pg.esperar(); // eslint-disable-line no-await-in-loop
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'SUBSTITUTO', nome: 'X', email: 'x@homologacao.invalid' });
    pg.el('dpo-inicioEm').value = '31/02/2026';
    await pg.el('dpo-inicioEm').disparar('input');
    const antes = posts(pg).length;
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, antes);
    assert.match(pg.texto('dpoModalMsg'), /data de início/);
  });

  test('calendário nativo: sem showPicker o seletor fica visível e o botão some; com showPicker o botão abre o seletor na data digitada e a escolha volta como DD/MM/AAAA', async () => {
    const pg = await pronta();
    await pg.clicar('dpoEditar');
    // O harness não tem showPicker: comportamento de navegador antigo.
    const seletor = pg.el('dpo-inicioEm-seletor');
    assert.equal(pg.visivel('dpo-inicioEm-seletor'), true, 'seletor visível como alternativa');
    assert.equal(pg.visivel('dpo-inicioEm-abrir'), false, 'botão escondido');
    assert.equal(seletor.hasAttribute('tabindex'), false, 'entra no Tab');
    seletor.value = '2026-10-28';
    await seletor.disparar('change');
    assert.equal(pg.el('dpo-inicioEm').value, '28/10/2026');
    // Navegador com showPicker (simulado): o botão chama showPicker com o seletor já na data digitada.
    const chamadas = [];
    const seletorAto = pg.el('dpo-atoData-seletor');
    seletorAto.showPicker = function () { chamadas.push(this.value); };
    pg.el('dpo-atoData').value = '05/10/2026';
    await pg.el('dpo-atoData').disparar('input');
    await pg.clicar('dpo-atoData-abrir');
    assert.deepEqual(chamadas, ['2026-10-05']);
    // showPicker que lança (por exemplo, sem gesto): cai para o seletor visível e focado.
    seletorAto.showPicker = function () { throw new Error('NotAllowedError'); };
    seletorAto.style.display = 'none';
    await pg.clicar('dpo-atoData-abrir');
    assert.equal(pg.visivel('dpo-atoData-seletor'), true);
    assert.equal(pg.foco(), 'dpo-atoData-seletor');
  });

  test('período: o rótulo mostra o início do vigente em Substituir/Encerrar; encerrar antes do início (informado ou "hoje" vazio) é recusado localmente com a data; 400 LGPD_DPO_PERIODO_INVALIDO e FUNCAO_DIVERGENTE têm mensagem própria', async () => {
    const F = carregarModulo();
    const vig = { versao: 1, inicioEm: '2026-11-28' };
    assert.equal(F.periodoInvalido(vig, '', '2026-10-28').fimEfetivo, '2026-10-28', 'vazio usa hoje; antes do início');
    assert.deepEqual(JSON.parse(JSON.stringify(F.periodoInvalido(vig, '2026-11-27', '2026-10-28'))), { fimEfetivo: '2026-11-27', inicio: '2026-11-28' });
    assert.equal(F.periodoInvalido(vig, '2026-11-28', '2026-10-28'), null, 'mesmo dia é aceito (fim = início)');
    assert.equal(F.periodoInvalido(vig, '', '2026-12-01'), null, 'hoje depois do início');
    assert.equal(F.periodoInvalido({ versao: 1 }, '', '2026-10-28'), null, 'sem início conhecido: deixa o servidor decidir');
    assert.match(F.hojeSaoPaulo(), /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento(vig, { fimEm: '' }, '2026-10-28'))), { ok: false, campos: ['fimEm'], periodo: { fimEfetivo: '2026-10-28', inicio: '2026-11-28' } });
    assert.deepEqual(JSON.parse(JSON.stringify(F.corpoEncerramento(vig, { fimEm: '28/11/2026' }, '2026-10-28'))), { ok: true, corpo: { versao: 1, fimEm: '2026-11-28' } });
    // Página: vigente com início futuro (o caso real da homologação).
    const futuro = principal({ inicioEm: '2026-11-28' });
    const pg = await pronta({ enc: { principal: futuro, substituto: null } });
    await pg.clicar('dpoEditar');
    await preencher(pg, { funcao: 'PRINCIPAL', acao: 'SUBSTITUIR' });
    assert.match(pg.texto('dpo-fimEm-rotulo'), /início registrado do vigente: 28\/11\/2026/);
    await preencher(pg, { nome: 'HOMOLOGAÇÃO LGPD-1 Principal B', email: 'b@homologacao.invalid', inicioEm: '28/10/2026' });
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, 0, 'não envia: hoje é anterior ao início do vigente');
    assert.match(pg.texto('dpoModalMsg'), /não pode ser anterior ao início da designação dele \(28\/11\/2026\)/);
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    pg.el('dpo-fimEm').value = '27/11/2026';
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, 0, 'véspera do início também é recusada');
    await preencher(pg, { acao: 'ENCERRAR' });
    assert.match(pg.texto('dpo-fimEm-rotulo'), /início registrado do vigente: 28\/11\/2026/);
    pg.el('dpo-fimEm').value = '';
    await pg.clicar('dpoModalSalvar');
    assert.equal(posts(pg).length, 0, 'encerrar hoje (vazio) antes do início: recusado localmente');
    assert.match(pg.texto('dpoModalMsg'), /28\/11\/2026/);
    await preencher(pg, { acao: 'DESIGNAR' });
    assert.equal(pg.texto('dpo-fimEm-rotulo'), 'Data de encerramento do vigente (opcional; padrão: hoje)', 'rótulo padrão fora de Substituir/Encerrar');
    await pg.clicar('dpoModalCancelar');
    // Mensagens próprias para os dois códigos do servidor (defesa em profundidade: o servidor continua decidindo).
    for (const [codigo, esperado] of [['LGPD_DPO_PERIODO_INVALIDO', /não pode ser anterior ao início/], ['LGPD_DPO_FUNCAO_DIVERGENTE', /mantém a função/]]) {
      assert.match(F.erroDoServidor({ ok: false, status: 400, codigo, mensagem: 'ECO' }), esperado, codigo);
      assert.equal(F.erroDoServidor({ ok: false, status: 400, codigo, mensagem: 'ECO' }).includes('ECO'), false);
    }
  });

  test('F5, aviso de saída, teclado e foco continuam valendo para os campos de data', async () => {
    const pg = await pronta({ enc: { principal: principal(), substituto: null }, hash: '#dpo=SUBSTITUIR.PRINCIPAL.e3' });
    assert.equal(pg.el('dpoModal').classList.contains('open'), true);
    const marcas = { chamado: false };
    await pg.eventoDaJanela('beforeunload', { preventDefault() { marcas.chamado = true; } });
    assert.equal(marcas.chamado, false, 'formulário vazio');
    pg.el('dpo-fimEm').value = '28/10/2026';
    await pg.el('dpo-fimEm').disparar('input');
    await pg.eventoDaJanela('beforeunload', { preventDefault() { marcas.chamado = true; } });
    assert.equal(marcas.chamado, true, 'data digitada conta como alteração');
    pg.el('dpoModalSalvar').focus();
    await pg.el('dpoModalSalvar').disparar('keydown', { key: 'Tab' });
    assert.equal(pg.foco(), 'dpoModalFechar');
    await pg.el('dpo-fimEm').disparar('keydown', { key: 'Escape' });
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
    assert.equal(pg.location.hash, '');
  });
});
