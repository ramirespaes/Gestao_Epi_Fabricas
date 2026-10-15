'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

/**
 * Etapa H — os sete acessos do Atendimento Token na tela Configurar permissões (usuário e grupo).
 *
 * Os toggles vêm do servidor como os demais: a tela não tem lista própria. O que a tela faz é só (a) rotular o grupo
 * ATENDIMENTO como "Atendimento Token", na ordem do servidor, e (b) traduzir os códigos de aviso TOKEN_SEM_CONSULTAR e
 * PREVIA_SEM_HISTORICO_FUNCIONARIOS. Nada é concedido, revogado ou impedido pela tela; o servidor continua a autoridade.
 */

const ARQUIVO = 'pages/gestao-usuarios.html';
const SEM_CONSULTAR = 'TOKEN_SEM_CONSULTAR';
const PREVIA = 'PREVIA_SEM_HISTORICO_FUNCIONARIOS';
const ROTULOS = ['Consultar', 'Cadastrar dispositivo', 'Editar dispositivo', 'Revogar dispositivo', 'Gerar ativação (QR)', 'Redes autorizadas', 'Prévia do catálogo'];
const IDS = ['tokenVisualizar', 'tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao', 'tokenRedes', 'tokenPrevia'];
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'MASTER', recursos: { dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(true), permissoesGrupo: area(true), vinculosGrupo: area(true), usuarios: area(true),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const usuario = (extra = {}) => ({
  id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'USUARIO', ativo: true, criadoEm: '2026-10-05T19:17:16.762Z',
  grupo: null, podeGerenciar: true, proprio: false, cpfMascarado: null, matricula: null, setor: null, horarioTrabalho: null, acessoQualquerIp: true, ...extra,
});
const USUARIOS = [usuario({ id: 1, nome: 'Pessoa Master', perfil: 'MASTER', proprio: true, perfilFixo: true }), usuario()];
const listagem = () => ({
  status: 200,
  corpo: { status: 'ok', usuarios: USUARIOS, total: USUARIOS.length, pagina: 1, limite: 100, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: ['USUARIO'], perfisCadastraveis: ['USUARIO'] },
});
const T = (id, rotulo, grupo, ligado, fixo = false) => ({ id, rotulo, grupo, ligado, fixo });
const DO_TOKEN = (ligados = [], fixo = false, sem = []) => IDS.filter((id) => !sem.includes(id)).map((id) => T(id, ROTULOS[IDS.indexOf(id)], 'ATENDIMENTO', ligados.includes(id), fixo));
const TOGGLES = (ligadosToken = [], opcoes = {}) => [
  T('dashboard', 'Dashboard', 'GERAL', false, opcoes.fixo),
  T('analiseEstoque', 'Análise de Estoque', 'ESTOQUE', false, opcoes.fixo),
  ...DO_TOKEN(ligadosToken, opcoes.fixo === true, opcoes.sem ?? []),
  T('gestaoUsuarios', 'Gestão de Usuários', 'ADMINISTRACAO', false, opcoes.fixo),
];
const acessosDoUsuario = (toggles, { avisos, podeAlterar = true, motivo = null } = {}) => ({
  status: 200,
  corpo: {
    status: 'ok',
    acessos: { usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'USUARIO', ativo: true }, podeAlterar, motivoSomenteLeitura: motivo, toggles, pendencias: [], ...(avisos === undefined ? {} : { avisos }) },
  },
});
const G7 = { id: 7, nome: 'Almoxarifado', descricao: null, ativo: true };
const acessosDoGrupo = (toggles, avisos) => ({ status: 200, corpo: { status: 'ok', acessos: { grupo: { id: 7, nome: 'Almoxarifado', ativo: true }, toggles, ...(avisos === undefined ? {} : { avisos }) } } });

async function abrirPagina0(rotas) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /administracao/usuarios': listagem(),
      'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [G7] } },
      'GET /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: G7 } },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function clicarEmSequencia(pg, seletores) {
  for (const seletor of seletores) {
    const alvo = pg.consulta(seletor)[0];
    assert.ok(alvo, seletor);
    await alvo.disparar('click');
    await pg.esperar();
    await pg.esperar();
  }
}
const permissoesDoUsuario = async (rotas) => {
  const pg = await abrirPagina0(rotas);
  await clicarEmSequencia(pg, ['.kebab[data-menu="4"]', '#actionMenuInner [data-acao="permissoes"]']);
  return pg;
};
const permissoesDoGrupo = async (rotas) => {
  const pg = await abrirPagina0(rotas);
  await clicarEmSequencia(pg, ['[data-act="grupos"]', '[data-grupo-acao="permissoes"][data-grupo-id="7"]']);
  assert.ok(pg.texto('modal').includes('Permissões do grupo Almoxarifado'), 'o modal do grupo abriu');
  return pg;
};
const alternar = async (pg, acesso, ligado) => {
  const el = pg.consulta(`[data-acesso="${acesso}"]`)[0];
  assert.ok(el, acesso);
  el.checked = ligado;
  await el.disparar('change');
  await pg.esperar();
  await pg.esperar();
};
const avisosNaTela = (pg) => pg.consulta('#avisoDependencias [data-aviso]').map((e) => e.getAttribute('data-aviso'));
const textoAviso = (pg, codigo) => {
  const [e] = pg.consulta(`#avisoDependencias [data-aviso="${codigo}"]`);
  return e ? e.textContent.replace(/\s+/g, ' ').trim() : '';
};
const secoes = (pg) => pg.consulta('[data-grupo-acesso]').map((s) => s.getAttribute('data-grupo-acesso'));
const rotulosDe = (pg, grupo) => pg.consulta(`[data-grupo-acesso="${grupo}"] [data-linha-acesso] .lbl`).map((l) => l.textContent.trim());

describe('FT1 — seção Atendimento Token no usuário', () => {
  test('FT1.1 a seção aparece com o título "Atendimento Token", entre Estoque e Administração, com os sete rótulos na ordem do servidor', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(), { avisos: [] }) });
    assert.deepEqual(secoes(pg), ['GERAL', 'ESTOQUE', 'ATENDIMENTO', 'ADMINISTRACAO']);
    assert.equal(pg.consulta('[data-grupo-acesso="ATENDIMENTO"] h3')[0].textContent.trim(), 'Atendimento Token');
    assert.deepEqual(rotulosDe(pg, 'ATENDIMENTO'), ROTULOS);
    for (const id of IDS) {
      const el = pg.consulta(`[data-acesso="${id}"]`)[0];
      assert.ok(el, id);
      assert.equal(el.checked, false, id);
      assert.equal(el.disabled, false, `${id} editável para quem pode alterar`);
    }
  });

  test('FT1.2 refletem o estado do servidor (ligados) e o PUT envia só { ligado } para o acesso certo', async () => {
    const chamadas = [];
    const pg = await permissoesDoUsuario({
      'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenVisualizar', 'tokenPrevia']), { avisos: [] }),
      'PUT /administracao/usuarios/4/acessos/tokenRedes': (c) => { chamadas.push(c.corpo); return { status: 200, corpo: { status: 'ok', acesso: T('tokenRedes', 'Redes autorizadas', 'ATENDIMENTO', c.corpo.ligado), avisos: [] } }; },
    });
    assert.deepEqual(IDS.filter((id) => pg.consulta(`[data-acesso="${id}"]`)[0].checked), ['tokenVisualizar', 'tokenPrevia']);
    await alternar(pg, 'tokenRedes', true);
    assert.deepEqual(chamadas, [{ ligado: true }]);
    assert.equal(pg.consulta('[data-acesso="tokenRedes"]')[0].checked, true);
  });

  test('FT1.3 destinatário MASTER (fixo): os sete aparecem ligados e travados, sem poder alterar', async () => {
    const pg = await permissoesDoUsuario({
      'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(IDS, { fixo: true }), { avisos: [], podeAlterar: false, motivo: 'USUARIO_MASTER' }),
    });
    for (const id of IDS) {
      const el = pg.consulta(`[data-acesso="${id}"]`)[0];
      assert.equal(el.checked, true, id);
      assert.equal(el.disabled, true, `${id} travado`);
    }
    assert.match(pg.texto('modal'), /Master tem autoridade/);
  });

  test('FT1.4 quem só consulta (sem poder alterar) vê os sete desabilitados, com o motivo', async () => {
    const pg = await permissoesDoUsuario({
      'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenEditar']), { avisos: [], podeAlterar: false, motivo: 'SOMENTE_MASTER' }),
    });
    for (const id of IDS) assert.equal(pg.consulta(`[data-acesso="${id}"]`)[0].disabled, true, id);
    assert.match(pg.texto('modal'), /Somente o Master altera/);
  });
});

describe('FT2 — avisos do Atendimento Token', () => {
  test('FT2.1 TOKEN_SEM_CONSULTAR no usuário: explica que há acessos dependentes ligados sem Consultar, sem afirmar perda de acesso', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenCadastrar']), { avisos: [{ codigo: SEM_CONSULTAR }] }) });
    assert.deepEqual(avisosNaTela(pg), [SEM_CONSULTAR]);
    assert.ok(pg.visivel('avisoDependencias'));
    const t = textoAviso(pg, SEM_CONSULTAR);
    assert.match(t, /Consultar/);
    assert.match(t, /desligado/i);
    assert.equal(/perde|perderam|perdem|revogad/i.test(t), false);
  });

  test('FT2.2 PREVIA_SEM_HISTORICO_FUNCIONARIOS no usuário: Prévia ligada sem o Histórico de Funcionários; a tela não liga nada sozinha', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenPrevia']), { avisos: [{ codigo: PREVIA }] }) });
    assert.deepEqual(avisosNaTela(pg), [PREVIA]);
    const t = textoAviso(pg, PREVIA);
    assert.match(t, /Prévia do catálogo/);
    assert.match(t, /Histórico de Funcionários/);
    assert.match(t, /duas permiss/i);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'PUT').length, 0, 'abrir a tela não escreve nada');
  });

  test('FT2.3 os avisos acompanham o PUT: aparecem ao ligar a Prévia e somem quando o servidor devolve a lista vazia', async () => {
    let historico = false;
    const pg = await permissoesDoUsuario({
      'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(), { avisos: [] }),
      'PUT /administracao/usuarios/4/acessos/tokenPrevia': (c) => ({ status: 200, corpo: { status: 'ok', acesso: T('tokenPrevia', 'Prévia do catálogo', 'ATENDIMENTO', c.corpo.ligado), avisos: c.corpo.ligado && !historico ? [{ codigo: PREVIA }] : [] } }),
      'PUT /administracao/usuarios/4/acessos/historicoFuncionarios': (c) => { historico = c.corpo.ligado; return { status: 200, corpo: { status: 'ok', acesso: T('historicoFuncionarios', 'Histórico de Funcionários', 'COLABORADORES', c.corpo.ligado), avisos: [] } }; },
    });
    await alternar(pg, 'tokenPrevia', true);
    assert.deepEqual(avisosNaTela(pg), [PREVIA]);
    await alternar(pg, 'tokenPrevia', false);
    assert.deepEqual(avisosNaTela(pg), []);
  });

  test('FT2.4 os dois avisos podem aparecer juntos, cada um com seu texto', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenRevogar', 'tokenPrevia']), { avisos: [{ codigo: SEM_CONSULTAR }, { codigo: PREVIA }] }) });
    assert.deepEqual(avisosNaTela(pg).sort(), [PREVIA, SEM_CONSULTAR].sort());
    assert.notEqual(textoAviso(pg, SEM_CONSULTAR), textoAviso(pg, PREVIA));
  });

  test('FT2.5 código de aviso desconhecido é ignorado (a tela só traduz o que conhece)', async () => {
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(), { avisos: [{ codigo: 'CODIGO_NOVO' }] }) });
    assert.deepEqual(avisosNaTela(pg), []);
  });
});

describe('FT3 — Atendimento Token no grupo', () => {
  test('FT3.1 o grupo mostra exatamente o que o servidor oferece: seis acessos, sem Redes (só concessão individual)', async () => {
    const pg = await permissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES([], { sem: ['tokenRedes'] }), []) });
    assert.deepEqual(rotulosDe(pg, 'ATENDIMENTO'), ROTULOS.filter((r) => r !== 'Redes autorizadas'));
    assert.equal(pg.consulta('[data-acesso="tokenRedes"]').length, 0);
  });

  test('FT3.2 avisos do grupo falam da configuração do grupo e diferem dos do usuário', async () => {
    const pg = await permissoesDoGrupo({ 'GET /grupos-acesso/7/acessos': acessosDoGrupo(TOGGLES(['tokenCadastrar', 'tokenPrevia'], { sem: ['tokenRedes'] }), [{ codigo: SEM_CONSULTAR }, { codigo: PREVIA }]) });
    assert.deepEqual(avisosNaTela(pg).sort(), [PREVIA, SEM_CONSULTAR].sort());
    for (const codigo of [SEM_CONSULTAR, PREVIA]) {
      const t = textoAviso(pg, codigo);
      assert.match(t, /grupo/i, codigo);
      assert.equal(/perde|perderam|perdem|revogad/i.test(t), false, codigo);
    }
    const individual = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(TOGGLES(['tokenCadastrar', 'tokenPrevia']), { avisos: [{ codigo: SEM_CONSULTAR }, { codigo: PREVIA }] }) });
    assert.notEqual(textoAviso(individual, SEM_CONSULTAR), textoAviso(pg, SEM_CONSULTAR));
    assert.notEqual(textoAviso(individual, PREVIA), textoAviso(pg, PREVIA));
  });
});

describe('FT4 — limites: a tela não decide permissão', () => {
  test('FT4.1 o módulo não conhece ids de acesso, ações nem recursos do Token: só o rótulo do grupo e os códigos de aviso', () => {
    const fonte = semComentarios(ler('js/permissoes-usuario.js'));
    for (const proibido of [...IDS, 'TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL', 'atendimentoToken', 'employeeHistory', "perfil === 'MASTER'"]) {
      assert.equal(fonte.includes(proibido), false, `${proibido} não pode estar no módulo`);
    }
    assert.match(fonte, /ATENDIMENTO: 'Atendimento Token'/);
    assert.match(fonte, /TOKEN_SEM_CONSULTAR/);
    assert.match(fonte, /PREVIA_SEM_HISTORICO_FUNCIONARIOS/);
  });

  test('FT4.2 o rótulo de grupo desconhecido continua aparecendo como veio do servidor (nenhuma seção some)', async () => {
    const toggles = [...TOGGLES(), T('futuro', 'Acesso futuro', 'NOVO_GRUPO', false)];
    const pg = await permissoesDoUsuario({ 'GET /administracao/usuarios/4/acessos': acessosDoUsuario(toggles, { avisos: [] }) });
    assert.ok(secoes(pg).includes('NOVO_GRUPO'));
    assert.ok(secoes(pg).includes('ATENDIMENTO'));
  });
});
