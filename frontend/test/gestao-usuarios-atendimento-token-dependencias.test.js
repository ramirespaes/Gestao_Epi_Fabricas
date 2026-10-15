'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

/**
 * Etapa H — sincronização visual das dependências dos toggles (usuário e grupo), sem alterar pages/gestao-usuarios.html.
 *
 * O servidor devolve `alterados` (aditivo) e o aviso `DEPENDENCIA_REABILITADA`. O módulo js/permissoes-usuario.js redesenha as
 * linhas dos acessos alterados por dependência (a linha clicada continua sendo redesenhada pela página) e traduz o aviso.
 * A regra de autorização não muda e a tela não decide nada: só mostra o que o servidor devolveu.
 */
const ARQUIVO = 'pages/gestao-usuarios.html';
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
const USUARIOS = [usuario({ id: 1, nome: 'Pessoa Master', perfil: 'MASTER', proprio: true, perfilFixo: true }), usuario(), usuario({ id: 5, nome: 'Carla Estoque', email: 'carla@validacao-epi.invalid' })];
const listagem = () => ({
  status: 200,
  corpo: { status: 'ok', usuarios: USUARIOS, total: USUARIOS.length, pagina: 1, limite: 100, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: ['USUARIO'], perfisCadastraveis: ['USUARIO'] },
});
const ROTULOS = { tokenVisualizar: 'Consultar', tokenCadastrar: 'Cadastrar dispositivo' };
const T = (id, ligado) => ({ id, rotulo: ROTULOS[id], grupo: 'ATENDIMENTO', ligado, fixo: false });
const REABILITADA = { codigo: 'DEPENDENCIA_REABILITADA', acessos: ['Atendimento Token: Consultar'] };

/** Servidor falso com estado, para um alvo: ligar Cadastrar liga também Consultar (a dependência), como o servidor real. */
function servidor(alvo, caminhoLeitura, caminhoPut, opcoes = {}) {
  const estado = { tokenVisualizar: false, tokenCadastrar: false };
  const corpoLeitura = () => {
    const toggles = [T('tokenVisualizar', estado.tokenVisualizar), T('tokenCadastrar', estado.tokenCadastrar)];
    const base = alvo === 'grupo'
      ? { grupo: { id: 7, nome: 'Almoxarifado', ativo: true }, toggles, avisos: [] }
      : { usuario: { id: alvo, nome: 'Bruno Almoxarife', perfil: 'USUARIO', ativo: true }, podeAlterar: true, motivoSomenteLeitura: null, toggles, pendencias: [], avisos: [] };
    return { status: 200, corpo: { status: 'ok', acessos: base } };
  };
  return {
    estado,
    [`GET ${caminhoLeitura}`]: corpoLeitura,
    [`PUT ${caminhoPut}`]: opcoes.put ?? ((c) => {
      const antes = { ...estado };
      estado.tokenCadastrar = c.corpo.ligado;
      if (c.corpo.ligado) estado.tokenVisualizar = true;
      const alterados = ['tokenVisualizar', 'tokenCadastrar'].filter((id) => antes[id] !== estado[id]).map((id) => T(id, estado[id]));
      const corpo = { status: 'ok', acesso: T('tokenCadastrar', estado.tokenCadastrar), avisos: opcoes.avisos ?? [] };
      if (opcoes.semAlterados !== true) corpo.alterados = alterados;
      return { status: 200, corpo };
    }),
  };
}

async function abrir(rotas) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /administracao/usuarios': listagem(),
      'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [{ id: 7, nome: 'Almoxarifado', descricao: null, ativo: true }] } },
      'GET /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: { id: 7, nome: 'Almoxarifado', descricao: null, ativo: true } } },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function clicar(pg, seletores) {
  for (const seletor of seletores) {
    const alvo = pg.consulta(seletor)[0];
    assert.ok(alvo, seletor);
    await alvo.disparar('click');
    await pg.esperar();
    await pg.esperar();
  }
}
const abrirPermissoes = (pg, id = 4) => clicar(pg, [`.kebab[data-menu="${id}"]`, '#actionMenuInner [data-acao="permissoes"]']);
const abrirPermissoesDoGrupo = (pg) => clicar(pg, ['[data-act="grupos"]', '[data-grupo-acao="permissoes"][data-grupo-id="7"]']);
const marcado = (pg, id) => pg.consulta(`[data-acesso="${id}"]`)[0].checked;
const alternar = async (pg, id, ligado) => {
  const el = pg.consulta(`[data-acesso="${id}"]`)[0];
  el.checked = ligado;
  await el.disparar('change');
  await pg.esperar();
  await pg.esperar();
};
const leituras = (pg, expressao) => pg.chamadas.filter((c) => c.metodo === 'GET' && expressao.test(c.url)).length;
const avisosNaTela = (pg) => pg.consulta('#avisoDependencias [data-aviso]').map((e) => e.getAttribute('data-aviso'));

describe('FD — usuário: a tela mostra tudo o que o servidor alterou', () => {
  test('FD1 o interruptor clicado mostra o resultado efetivo que o servidor devolveu, e o PUT leva só { ligado }', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar');
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(marcado(pg, 'tokenCadastrar'), true);
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'PUT').map((c) => c.corpo), [{ ligado: true }]);
  });

  test('FD2 a dependência que o servidor ligou também aparece ligada, sem reler a lista, e continua editável', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar');
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    const antes = leituras(pg, /\/acessos$/);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(s.estado.tokenVisualizar, true);
    assert.equal(marcado(pg, 'tokenVisualizar'), true, 'Consultar aparece ligado na hora');
    assert.equal(pg.consulta('[data-acesso="tokenVisualizar"]')[0].disabled, false, 'continua editável');
    assert.equal(leituras(pg, /\/acessos$/), antes, 'sem nova leitura');
    assert.equal(pg.consulta('[data-linha-acesso="tokenVisualizar"]').length, 1, 'uma única linha por acesso');
  });

  test('FD3 depois de fechar e reabrir, a tela concorda com o que foi mostrado ao salvar', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar');
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    await alternar(pg, 'tokenCadastrar', true);
    const mostrado = [marcado(pg, 'tokenVisualizar'), marcado(pg, 'tokenCadastrar')];
    await clicar(pg, ['[data-close]']);
    await abrirPermissoes(pg);
    assert.deepEqual([marcado(pg, 'tokenVisualizar'), marcado(pg, 'tokenCadastrar')], mostrado);
  });

  test('FD4 se o PUT falhar, a tela relê tudo do servidor (não deixa estado inventado)', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar', {
      put: () => ({ status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } }),
    });
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    const antes = leituras(pg, /\/acessos$/);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(leituras(pg, /\/acessos$/), antes + 1, 'releu a lista');
    assert.equal(marcado(pg, 'tokenCadastrar'), false);
  });

  test('FD5 aviso de reabilitação: nomeia o que foi reabilitado, em texto puro, e some no PUT seguinte', async () => {
    const opcoes = { avisos: [REABILITADA] };
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar', opcoes);
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    await alternar(pg, 'tokenCadastrar', true);
    assert.deepEqual(avisosNaTela(pg), ['DEPENDENCIA_REABILITADA']);
    assert.ok(pg.visivel('avisoDependencias'));
    const texto = pg.consulta('#avisoDependencias [data-aviso]')[0].textContent.replace(/\s+/g, ' ').trim();
    assert.match(texto, /Atendimento Token: Consultar/);
    assert.match(texto, /bloqueado/i);
    assert.equal(/confirm|deseja|continuar\?/i.test(texto), false, 'só informa: sem confirmação obrigatória');
    opcoes.avisos = [];
    await alternar(pg, 'tokenCadastrar', false);
    assert.deepEqual(avisosNaTela(pg), []);
  });

  test('FD6 servidor sem `alterados` (versão anterior): nada quebra e a linha clicada continua correta', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar', { semAlterados: true });
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(marcado(pg, 'tokenCadastrar'), true);
    assert.equal(marcado(pg, 'tokenVisualizar'), false, 'sem a informação do servidor a tela não inventa');
  });

  test('FD7 `alterados` malformado ou de acesso desconhecido é ignorado (a tela só redesenha o que existe e é válido)', async () => {
    const s = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar', {
      put: (c) => ({ status: 200, corpo: { status: 'ok', acesso: T('tokenCadastrar', c.corpo.ligado), avisos: [], alterados: [null, 7, { id: 'naoExiste', rotulo: 'X', grupo: 'ATENDIMENTO', ligado: true }, { id: 'tokenVisualizar' }, T('tokenCadastrar', c.corpo.ligado)] } }),
    });
    const pg = await abrir(s);
    await abrirPermissoes(pg);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(pg.consulta('[data-linha-acesso]').length, 2);
    assert.equal(marcado(pg, 'tokenVisualizar'), false);
  });

  test('FD8 resposta que chega depois de o modal ser trocado por OUTRO usuário não redesenha as linhas do outro', async () => {
    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const s4 = servidor(4, '/administracao/usuarios/4/acessos', '/administracao/usuarios/4/acessos/tokenCadastrar', {
      put: async (c) => { await espera; return { status: 200, corpo: { status: 'ok', acesso: T('tokenCadastrar', c.corpo.ligado), avisos: [], alterados: [T('tokenVisualizar', true), T('tokenCadastrar', c.corpo.ligado)] } }; },
    });
    const s5 = servidor(5, '/administracao/usuarios/5/acessos', '/administracao/usuarios/5/acessos/tokenCadastrar');
    const pg = await abrir({ ...s4, ...s5 });
    await abrirPermissoes(pg, 4);
    const el = pg.consulta('[data-acesso="tokenCadastrar"]')[0];
    el.checked = true;
    const pendente = el.disparar('change');
    await pg.esperar();
    await clicar(pg, ['[data-close]']);
    await abrirPermissoes(pg, 5);
    assert.equal(marcado(pg, 'tokenVisualizar'), false);
    liberar();
    await pendente;
    await pg.esperar();
    assert.equal(marcado(pg, 'tokenVisualizar'), false, 'o modal do outro usuário não foi tocado');
    assert.equal(marcado(pg, 'tokenCadastrar'), false);
  });
});

describe('FD — grupo: mesma sincronização', () => {
  test('FDG1 a dependência ligada no grupo aparece ligada na hora, e o aviso do grupo fala da configuração do grupo', async () => {
    const s = servidor('grupo', '/grupos-acesso/7/acessos', '/grupos-acesso/7/acessos/tokenCadastrar', { avisos: [REABILITADA] });
    const pg = await abrir(s);
    await abrirPermissoesDoGrupo(pg);
    await alternar(pg, 'tokenCadastrar', true);
    assert.equal(marcado(pg, 'tokenVisualizar'), true);
    assert.deepEqual(avisosNaTela(pg), ['DEPENDENCIA_REABILITADA']);
    const texto = pg.consulta('#avisoDependencias [data-aviso]')[0].textContent;
    assert.match(texto, /grupo/i);
    assert.match(texto, /Atendimento Token: Consultar/);
  });

  test('FDG2 um PUT de USUÁRIO nunca redesenha um modal de GRUPO (e vice-versa): o alvo é conferido', async () => {
    const pg = await abrir({
      ...servidor('grupo', '/grupos-acesso/7/acessos', '/grupos-acesso/7/acessos/tokenCadastrar'),
    });
    await abrirPermissoesDoGrupo(pg);
    const modulo = pg.janela.EpiPermissoesUsuario;
    assert.ok(modulo, 'módulo exposto');
    const linhaAntes = marcado(pg, 'tokenVisualizar');
    modulo.render.sincronizar(pg.documento, 'usuario', 7, [{ id: 'tokenVisualizar', rotulo: 'Consultar', grupo: 'ATENDIMENTO', ligado: true, fixo: false }], 'tokenCadastrar');
    assert.equal(marcado(pg, 'tokenVisualizar'), linhaAntes, 'tipo de alvo diferente: nada muda');
  });
});

describe('FD — limites', () => {
  test('FD9 a página aprovada não foi alterada para isto, e o módulo continua sem conhecer ids de acesso, ações ou recursos', () => {
    const html = semComentarios(ler(ARQUIVO));
    assert.equal(/alterados|sincronizar/.test(html), false, 'gestao-usuarios.html continua sem saber de `alterados`');
    const fonte = semComentarios(ler('js/permissoes-usuario.js'));
    for (const proibido of ['tokenVisualizar', 'tokenCadastrar', 'TOKEN_GERAR_ATIVACAO', 'atendimentoToken', 'employeeHistory', "perfil === 'MASTER'"]) {
      assert.equal(fonte.includes(proibido), false, `${proibido} não pode estar no módulo`);
    }
    assert.equal(/innerHTML/.test(fonte), false, 'só nós e texto');
  });
});
