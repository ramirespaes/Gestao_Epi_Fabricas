'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, ler, semComentarios, semComentariosHtml, scriptsDe } = require('./helpers/dom-pagina');

/**
 * Gestão de Usuários — tela + listagem real (primeira subetapa visível da
 * consolidação de acessos). O HTML aprovado (safe-work-usuarios.html) é o alvo
 * visual: a página o liga à sessão, à empresa e à listagem reais, dentro da
 * moldura padrão do SafeWork. Nada vem do array `users`, de `localStorage`
 * ou de empresas, grupos e nomes fictícios do protótipo.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/gestao-usuarios.html';
const G = require('../js/gestao-usuarios');
const P = require('../js/permissoes-efetivas');
const U = require('../js/usuarios');

const ATAQUE = '<img src=x onerror=alert(1)>';
const EM_INTEGRACAO = 'Funcionalidade em integração';
const LINK = '<a href="gestao-usuarios.html" data-pagina="gestaoUsuarios" style="display:none"><div class="nav-icon indigo">manage_accounts</div>Gestão de Usuários</a>';
const LINK_ATIVO = '<a class="active" href="javascript:void(0)" data-pagina="gestaoUsuarios" style="display:none"><div class="nav-icon indigo">manage_accounts</div>Gestão de Usuários</a>';
const SEIS_ANTIGAS = ['grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', 'new-user.html', 'user-admin.html'];
const COM_MENU = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && /data-pagina="userAdmin"/.test(ler(`pages/${f}`)));

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ perfil = 'MASTER', usuarios = true, sst = false } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 1, perfil, recursos: { dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(usuarios),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(sst),
    },
  };
}
const contexto = (perfil = 'MASTER') => ({
  status: 'ok',
  usuario: { id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
// Projeção real da listagem (05/10/2026): dados administrativos; vínculos anteriores às 075–077 vêm nulos e com acesso de qualquer IP.
const usuario = (extra = {}) => ({
  id: 2, nome: 'Usuário Teste Senha Provisória', email: 'usuario.teste.provisorio@validacao-epi.invalid', perfil: 'USUARIO', ativo: true,
  criadoEm: '2026-10-05T19:17:16.762Z', grupo: null, podeGerenciar: true, proprio: false,
  cpfMascarado: null, matricula: null, setor: null, horarioTrabalho: null, acessoQualquerIp: true, ...extra,
});
const USUARIOS = [
  usuario({ id: 1, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER', proprio: true, perfilFixo: true }),
  usuario(),
  usuario({ id: 3, nome: 'Ana Inativa', email: 'ana@validacao-epi.invalid', ativo: false, grupo: { nome: 'SST', ativo: true }, setor: 'SESMT' }),
  usuario({
    id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'SUPERVISOR', grupo: { nome: 'Almoxarifado', ativo: true },
    cpfMascarado: '***.***.***-25', matricula: 'ALM-004', setor: 'Almoxarifado', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, acessoQualquerIp: false,
  }),
];

/** Serve a listagem real paginada pelo backend (pagina/limite da query). */
function listagem(lista) {
  return (chamada) => {
    const q = new URL(chamada.url).searchParams;
    const pagina = Number(q.get('pagina')) || 1;
    const limite = Number(q.get('limite')) || 20;
    const usuarios = lista.slice((pagina - 1) * limite, pagina * limite);
    return { status: 200, corpo: { status: 'ok', usuarios, total: lista.length, pagina, limite, paginas: Math.max(1, Math.ceil(lista.length / limite)), mastersAtivos: 1, perfisGerenciaveis: ['USUARIO'], perfisCadastraveis: ['USUARIO'] } };
  };
}

function abrir({ perfil = 'MASTER', usuarios = true, sst = false, lista = USUARIOS, conta = { status: 200, corpo: { status: 'ok' } }, rotas = {} } = {}) {
  return abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto(perfil) },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ perfil, usuarios, sst }) },
      'GET /administracao/usuarios': listagem(lista),
      'PATCH /auth/global/conta': conta,
      ...rotas,
    },
  });
}
async function pronta(opcoes) {
  const pg = abrir(opcoes);
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const clicar = async (pg, seletor) => {
  const alvo = pg.consulta(seletor)[0];
  assert.ok(alvo, seletor);
  await alvo.disparar('click');
  await pg.esperar();
};
const listagens = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /administracao/usuarios');
const nomesDaTabela = (pg) => pg.consulta('#list tbody tr').filter((tr) => !tr.classList.contains('grp')).map((tr) => tr.children[1].textContent.replace(/Desabilitado|Bloqueado/g, '').trim());
const textoDaLista = (pg) => pg.texto('list');

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Usuários — módulo (sem DOM)', () => {
  const modelo = USUARIOS.map(G.modelo.normalizar);

  test('normalizar: só os campos reais do backend (inclusive os administrativos: CPF só mascarado, matrícula, setor, horário, acesso de qualquer IP); nada do protótipo (login, logs, bloqueado) nem CPF em claro', () => {
    assert.deepEqual(G.modelo.normalizar(USUARIOS[3]), {
      id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'SUPERVISOR', ativo: true, grupo: 'Almoxarifado', grupoAtivo: true,
      cpfMascarado: '***.***.***-25', matricula: 'ALM-004', setor: 'Almoxarifado', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, acessoQualquerIp: false, perfilFixo: false,
    });
    const simples = G.modelo.normalizar(USUARIOS[1]);
    assert.deepEqual([simples.grupo, simples.cpfMascarado, simples.matricula, simples.setor, simples.horarioTrabalho, simples.acessoQualquerIp], [null, null, null, null, null, true]);
    const estranho = G.modelo.normalizar({ id: 9, nome: 'X', email: 'x@validacao-epi.invalid', perfil: 'USUARIO', ativo: true, login: 'x', bloqueado: true, cpf: '52998224725', cpfMascarado: '52998224725', horarioTrabalho: { inicio: '8h', fim: '18:00' }, ipsPermitidos: ['203.0.113.10'] });
    assert.deepEqual(Object.keys(estranho).sort(), ['acessoQualquerIp', 'ativo', 'cpfMascarado', 'email', 'grupo', 'grupoAtivo', 'horarioTrabalho', 'id', 'matricula', 'nome', 'perfil', 'perfilFixo', 'setor']);
    assert.deepEqual([estranho.cpfMascarado, estranho.horarioTrabalho, estranho.acessoQualquerIp], [null, null, null], 'CPF em claro é descartado; horário inválido vira null; sem o booleano do servidor, desconhecido');
    assert.equal(JSON.stringify(estranho).includes('203.0.113'), false, 'a lista de IPs nunca entra no modelo');
    assert.deepEqual([G.modelo.horarioTexto(G.modelo.normalizar(USUARIOS[3])), G.modelo.horarioTexto(simples)], ['08:00 - 18:00', '—']);
    assert.deepEqual([G.modelo.acessoQualquerIpTexto(G.modelo.normalizar(USUARIOS[3])), G.modelo.acessoQualquerIpTexto(simples), G.modelo.acessoQualquerIpTexto(estranho)], ['Não', 'Sim', '—']);
    assert.equal(G.modelo.normalizar(null), null);
    assert.equal(G.modelo.normalizar({ id: 'a', nome: 'X' }), null);
  });

  test('filtrar: Habilitados/Desabilitados/Todos pelo ativo real; busca por ID, nome, e-mail (login) e grupo, sem sufixo', () => {
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'hab', q: '' }).map((u) => u.id), [1, 2, 4]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'des', q: '' }).map((u) => u.id), [3]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'todos', q: '' }).map((u) => u.id), [1, 2, 3, 4]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'todos', q: 'provis' }).map((u) => u.id), [2]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'todos', q: '4' }).map((u) => u.id), [4]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'todos', q: 'ALMOX' }).map((u) => u.id), [4]);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'todos', q: 'cobresul' }), []);
    assert.deepEqual(G.visao.filtrar(modelo, { status: 'hab', q: 'inativa' }), [], 'a busca respeita o filtro de situação');
  });

  test('ordenar: por id, nome, login (e-mail) e grupo sobre os dados reais; colunas sem fonte não reordenam', () => {
    const ids = (lista) => lista.map((u) => u.id);
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'id', dir: -1 })), [4, 3, 2, 1]);
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'nome', dir: 1 })), [3, 4, 1, 2]);
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'nome', dir: -1 })), [2, 1, 4, 3]);
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'login', dir: 1 })), [3, 4, 1, 2]);
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'grupo', dir: 1 })), [1, 2, 4, 3], 'sem grupo primeiro (vazio), depois Almoxarifado, SST');
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'setor', dir: 1 })), [1, 2, 4, 3], 'sem setor primeiro, depois Almoxarifado, SESMT');
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'de', dir: -1 })), [4, 1, 2, 3], 'quem tem horário vem antes na ordem decrescente');
    assert.deepEqual(ids(G.visao.ordenar(modelo, { col: 'qualquerIP', dir: 1 })), [4, 1, 2, 3], '"Não" antes de "Sim"');
    for (const col of ['empresas', 'cpf', 'logs']) assert.deepEqual(ids(G.visao.ordenar(modelo, { col, dir: 1 })), [1, 2, 3, 4], `${col}: sem fonte (ou mascarado) não reordena`);
    assert.deepEqual(ids(modelo), [1, 2, 3, 4], 'não muda a lista original');
  });

  test('agrupar: por grupo real ("Sem grupo") e por setor real ("Sem setor"), títulos em ordem', () => {
    assert.deepEqual(G.visao.agrupar(modelo, 'nenhum'), [[null, modelo]]);
    const blocos = G.visao.agrupar(modelo, 'grupo');
    assert.deepEqual(blocos.map(([g, us]) => [g, us.map((u) => u.id)]), [['Almoxarifado', [4]], ['Sem grupo', [1, 2]], ['SST', [3]]], 'títulos em ordem alfabética (localeCompare, como o HTML aprovado)');
    assert.deepEqual(G.visao.agrupar(modelo, 'setor').map(([g, us]) => [g, us.map((u) => u.id)]), [['Almoxarifado', [4]], ['Sem setor', [1, 2]], ['SESMT', [3]]]);
    assert.deepEqual([G.visao.agrupamentoDisponivel('grupo'), G.visao.agrupamentoDisponivel('nenhum'), G.visao.agrupamentoDisponivel('setor')], [true, true, true]);
    assert.deepEqual(G.AGRUPAMENTOS, [['nenhum', 'Nenhum'], ['grupo', 'Grupo'], ['setor', 'Setor']], 'o menu do HTML não muda');
  });

  test('render: só nós e texto (nenhum innerHTML no módulo nem na página); as colunas e os textos do HTML aprovado', () => {
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(semComentarios(ler('js/gestao-usuarios.js'))), false);
    assert.deepEqual(G.COLS.map((c) => c[1]), ['ID', 'Usuário', 'Login', 'Empresa(s)', 'Grupo', 'CPF', 'E-mail', 'Setor', 'Horário de trabalho', 'Visualiza logs', 'Acesso de qualquer IP']);
    assert.deepEqual(G.STATUS, { hab: 'Habilitados', des: 'Desabilitados', todos: 'Todos' });
  });

  test('csv: só campos reais (ID, Usuário, Login, Perfil, Grupo, E-mail, Status), separado por ponto e vírgula, com célula neutralizada contra fórmula', () => {
    const texto = G.csv.gerar(modelo);
    const linhas = texto.split('\n');
    assert.equal(linhas[0], 'ID;Usuário;Login;Perfil;Grupo;E-mail;Status');
    assert.equal(linhas[2], '2;Usuário Teste Senha Provisória;usuario.teste.provisorio@validacao-epi.invalid;Usuário;—;usuario.teste.provisorio@validacao-epi.invalid;Habilitado');
    assert.equal(linhas[3], '3;Ana Inativa;ana@validacao-epi.invalid;Usuário;SST;ana@validacao-epi.invalid;Desabilitado');
    assert.equal(linhas.length, 5);
    assert.equal(/senha|hash|token|cpf|matr|setor|hor[aá]rio|logs|IP/i.test(linhas[0]), false, 'nenhuma coluna sem fonte real');
    assert.equal(/\$argon2|hash/i.test(texto), false);
    assert.equal(G.csv.celula('=SOMA(A1)'), "'=SOMA(A1)");
    assert.equal(G.csv.celula('a;b'), '"a;b"');
    assert.equal(G.csv.celula('a"b'), '"a""b"');
  });

  test('carregarTodos: consome a paginação real do backend em segundo plano (limite 100) até o total, e para no teto sem inventar dados', async () => {
    const pedidos = [];
    const lista = Array.from({ length: 230 }, (_, i) => usuario({ id: i + 1, nome: `Pessoa ${i + 1}`, email: `p${i + 1}@validacao-epi.invalid` }));
    const listar = async (f) => {
      pedidos.push(f);
      const u = lista.slice((f.pagina - 1) * f.limite, f.pagina * f.limite);
      return { ok: true, status: 200, dados: { usuarios: u, total: lista.length, pagina: f.pagina, limite: f.limite, paginas: 3 } };
    };
    const r = await G.acoes.carregarTodos({ listar });
    assert.deepEqual([r.ok, r.usuarios.length, r.total, r.truncado], [true, 230, 230, false]);
    assert.deepEqual(pedidos.map((f) => [f.pagina, f.limite, f.ordem]), [[1, 100, 'nome'], [2, 100, 'nome'], [3, 100, 'nome']]);
    assert.equal(pedidos.every((f) => f.situacao === undefined && f.busca === undefined), true, 'situação e busca são locais, sobre o conjunto real');

    const limitado = await G.acoes.carregarTodos({ listar, maxPaginas: 2 });
    assert.deepEqual([limitado.ok, limitado.usuarios.length, limitado.truncado], [true, 200, true]);

    const falha = await G.acoes.carregarTodos({ listar: async () => ({ ok: false, status: 500, codigo: 'ERRO_INTERNO' }) });
    assert.deepEqual([falha.ok, falha.status, falha.usuarios], [false, 500, []]);
  });

  test('listar aceita o limite do backend (1–100) e volta ao padrão fora dele; a rota continua uma só', () => {
    const chamadas = [];
    const guardado = globalThis.EpiHttp;
    globalThis.EpiHttp = { requisitar: (m, c) => { chamadas.push(`${m} ${c}`); return Promise.resolve({ ok: true }); } };
    try {
      U.acoes.listar({ ordem: 'nome', pagina: 2, limite: 100 });
      U.acoes.listar({ limite: 500 });
      U.acoes.listar({ limite: '5' });
      U.acoes.listar({});
    } finally {
      if (guardado === undefined) delete globalThis.EpiHttp; else globalThis.EpiHttp = guardado;
    }
    assert.deepEqual(chamadas, [
      'GET /administracao/usuarios?ordem=nome&pagina=2&limite=100',
      'GET /administracao/usuarios?pagina=1&limite=20',
      'GET /administracao/usuarios?pagina=1&limite=20',
      'GET /administracao/usuarios?pagina=1&limite=20',
    ]);
  });

  test('o módulo não conhece localStorage, sessionStorage, dados do protótipo nem a chave safework-usuarios-v1', () => {
    const codigo = semComentarios(ler('js/gestao-usuarios.js'));
    assert.equal(/localStorage|sessionStorage|safework-usuarios|safework-tema|COBRESUL|\.cobresul|MARINA|SETORES|EMPRESAS|MODELOS|permsDoModelo/.test(codigo), false);
    assert.equal(G.TEXTOS.EM_INTEGRACAO, EM_INTEGRACAO);
    assert.equal(G.CAMINHO_CONTA, require('../js/configuracoes').CAMINHOS.conta, 'o tema é salvo pelo mesmo contrato das Configurações');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Usuários — página (DOM simulado, sessão e permissões reais)', () => {
  test('MASTER com a área usuarios: a entrada do menu aparece, o conteúdo abre e a listagem é a real (MASTER e usuário de teste), da empresa da sessão', async () => {
    const pg = await pronta();
    assert.equal(pg.visivelNo(pg.consulta('.nav a[data-pagina="gestaoUsuarios"]')[0]), true);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.visivel('telaSessao'), false);
    assert.deepEqual(listagens(pg).map((c) => c.url.replace(/^.*\/api/, '')), ['/administracao/usuarios?ordem=nome&pagina=1&limite=100']);
    assert.deepEqual(nomesDaTabela(pg), ['Pessoa Master', 'Usuário Teste Senha Provisória', 'Bruno Almoxarife'], 'Habilitados por padrão, na ordem de ID');
    assert.match(textoDaLista(pg), /usuario\.teste\.provisorio@validacao-epi\.invalid/);
    assert.equal(pg.consulta('.appbar .brand')[0].textContent, 'SafeWork Homologação Ltda', 'lado esquerdo: só a empresa real da sessão');
    assert.equal(pg.texto('whoEmpresa'), 'SafeWork Homologação Ltda');
    assert.equal(pg.consulta('.appbar .who')[0].textContent, 'Pessoa Master - Master', 'lado direito: nome e perfil reais na mesma linha');
    assert.equal(/Safe Work|Gestão de EPIs/.test(pg.consulta('.appbar')[0].textContent), false, 'a barra interna é só contexto da sessão');
    assert.equal(/COBRESUL|\.cobresul|MARINA COSTA|JOÃO PEREIRA|TOTEM PORTARIA|Administrador<\/b>/.test(pg.textoDoDom()), false, 'nada do protótipo');
    assert.equal(pg.texto('lblStatus'), 'Habilitados');
    assert.equal(pg.texto('lblGroup'), 'Nenhum');
  });

  test('sem a área usuarios (USUARIO comum, ou acesso direto pela URL): o menu não mostra a entrada, nada é listado e o aviso de acesso é o global', async () => {
    const pg = await pronta({ perfil: 'USUARIO', usuarios: false });
    assert.equal(pg.visivelNo(pg.consulta('.nav a[data-pagina="gestaoUsuarios"]')[0]), false);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.deepEqual(listagens(pg), []);
    assert.equal(pg.texto('estadoPagina'), P.MENSAGENS.SEM_ACESSO);
    assert.equal(pg.visivel('estadoPagina'), true);
    const admin = await pronta({ perfil: 'ADMINISTRADOR', usuarios: false });
    assert.deepEqual(listagens(admin), [], 'o nome do perfil não abre a página');
  });

  test('filtro de situação pelo ativo real: Desabilitados mostra só o inativo; Todos mostra os quatro', async () => {
    const pg = await pronta();
    await clicar(pg, '[data-status="des"]');
    assert.deepEqual(nomesDaTabela(pg), ['Ana Inativa']);
    assert.equal(pg.texto('lblStatus'), 'Desabilitados');
    assert.match(textoDaLista(pg), /Desabilitado/);
    await clicar(pg, '[data-status="todos"]');
    assert.deepEqual(nomesDaTabela(pg), ['Pessoa Master', 'Usuário Teste Senha Provisória', 'Ana Inativa', 'Bruno Almoxarife']);
    assert.equal(listagens(pg).length, 1, 'o filtro é local sobre o conjunto real já carregado');
  });

  test('a tabela mostra os dados administrativos reais: CPF mascarado, Setor, Horário ("08:00 - 18:00" ou "—") e Acesso de qualquer IP (Sim sem IP permitido, Não com lista); Visualiza logs continua "—"; nenhum IP e nenhum CPF em claro no DOM', async () => {
    const pg = await pronta();
    await clicar(pg, '[data-status="todos"]');
    const celulas = (id) => pg.consulta('#list tbody tr').find((tr) => tr.children[0].textContent === String(id)).children.map((td) => td.textContent.trim());
    const bruno = celulas(4);
    assert.deepEqual([bruno[5], bruno[7], bruno[8], bruno[9], bruno[10]], ['***.***.***-25', 'Almoxarifado', '08:00 - 18:00', '—', 'Não']);
    const simples = celulas(2);
    assert.deepEqual([simples[5], simples[7], simples[8], simples[9], simples[10]], ['—', '—', '—', '—', 'Sim']);
    assert.deepEqual([celulas(3)[7], celulas(3)[10]], ['SESMT', 'Sim']);
    assert.deepEqual([bruno[3], simples[3]], ['—', '—'], 'Empresa(s) continua sem fonte');
    assert.equal(/\d{3}\.\d{3}\.\d{3}-\d{2}|203\.0\.113|2001:db8|ipsPermitidos/.test(pg.textoDoDom()), false, 'nem CPF em claro nem lista de IPs');
    await clicar(pg, 'th[data-sort="setor"]');
    assert.deepEqual(nomesDaTabela(pg), ['Pessoa Master', 'Usuário Teste Senha Provisória', 'Bruno Almoxarife', 'Ana Inativa'], 'ordena pelo setor real');
    await clicar(pg, 'th[data-sort="qualquerIP"]');
    assert.equal(nomesDaTabela(pg)[0], 'Bruno Almoxarife', '"Não" primeiro');
  });

  test('busca, ordenação e agrupamento por grupo e por setor sobre os usuários reais', async () => {
    const pg = await pronta();
    await pg.digitar('q', 'almox');
    assert.deepEqual(nomesDaTabela(pg), ['Bruno Almoxarife']);
    await pg.digitar('q', '');
    await clicar(pg, 'th[data-sort="nome"]');
    assert.deepEqual(nomesDaTabela(pg), ['Bruno Almoxarife', 'Pessoa Master', 'Usuário Teste Senha Provisória']);
    await clicar(pg, 'th[data-sort="nome"]');
    assert.deepEqual(nomesDaTabela(pg), ['Usuário Teste Senha Provisória', 'Pessoa Master', 'Bruno Almoxarife']);
    await clicar(pg, '[data-agrupar="grupo"]');
    assert.equal(pg.texto('lblGroup'), 'Grupo');
    assert.deepEqual(pg.consulta('#list tr.grp').map((tr) => tr.textContent), ['Almoxarifado (1)', 'Sem grupo (2)']);
    pg.el('toast').textContent = '';
    await clicar(pg, '[data-agrupar="setor"]');
    assert.equal(pg.texto('lblGroup'), 'Setor');
    assert.equal(pg.texto('toast'), '', 'agrupa de verdade, sem aviso de integração');
    assert.deepEqual(pg.consulta('#list tr.grp').map((tr) => tr.textContent), ['Almoxarifado (1)', 'Sem setor (2)'], 'só os habilitados: Ana (SESMT) está desabilitada');
    await clicar(pg, '[data-status="todos"]');
    assert.deepEqual(pg.consulta('#list tr.grp').map((tr) => tr.textContent), ['Almoxarifado (1)', 'Sem setor (2)', 'SESMT (1)']);
  });

  test('tabela e cartões consomem o mesmo conjunto real', async () => {
    const pg = await pronta();
    await clicar(pg, '[data-status="todos"]');
    const naTabela = nomesDaTabela(pg);
    await clicar(pg, '[data-view="cards"]');
    const cartoes = pg.consulta('#list .card');
    assert.equal(cartoes.length, 4);
    assert.deepEqual(cartoes.map((c) => c.querySelector('h3').textContent.replace(/Desabilitado/g, '').trim()), naTabela);
    assert.match(textoDaLista(pg), /2 · usuario\.teste\.provisorio@validacao-epi\.invalid/);
    assert.match(textoDaLista(pg), /Horário: —/);
    assert.match(textoDaLista(pg), /Almoxarifado · Almoxarifado/, 'cartão: grupo · setor reais');
    assert.match(textoDaLista(pg), /Horário: 08:00 - 18:00/);
    await pg.digitar('q', 'master');
    assert.equal(pg.consulta('#list .card').length, 1);
    await clicar(pg, '[data-view="table"]');
    assert.deepEqual(nomesDaTabela(pg), ['Pessoa Master']);
  });

  test('a tabela segue o HTML aprovado: colunas, e-mail no Login, "—" onde não há fonte (e "Sim"/"Não" só pelo dado real do servidor), etiqueta Desabilitado só pelo ativo real, nunca Bloqueado; nome hostil vira texto', async () => {
    const pg = await pronta({ lista: [
      ...USUARIOS,
      usuario({ id: 5, nome: ATAQUE, email: 'cinco@validacao-epi.invalid', grupo: { nome: ATAQUE, ativo: true } }),
      usuario({ id: 6, nome: 'Sem Dado de IP', email: 'seis@validacao-epi.invalid', acessoQualquerIp: undefined, grupo: { nome: 'SST', ativo: true } }),
    ] });
    assert.deepEqual(pg.consulta('#list thead th').map((th) => th.textContent.replace(/[▲▼]/g, '')), [...G.COLS.map((c) => c[1]), 'Ações']);
    assert.equal(pg.consulta('#list thead th[data-sort="id"] .arr')[0].textContent, '▲');
    const celulasDe = (id) => pg.consulta('#list tbody tr').find((tr) => tr.children[0].textContent === String(id)).children.map((td) => td.textContent);
    assert.deepEqual(celulasDe(5).slice(0, 11), ['5', ATAQUE, 'cinco@validacao-epi.invalid', '—', ATAQUE, '—', 'cinco@validacao-epi.invalid', '—', '—', '—', 'Sim'], 'sem IP permitido = Sim; o resto sem dado = "—"');
    assert.equal(celulasDe(6)[10], '—', 'sem o booleano do servidor, nada é inventado');
    assert.equal(pg.consulta('#list img').length, 0, 'o nome hostil é texto, nunca marcação');
    assert.equal(pg.consulta('#list .tag.lock').length, 0, 'Bloqueado não tem fonte real');
    assert.equal(/\.cobresul/.test(textoDaLista(pg)), false, 'sem sufixo de login');
    await clicar(pg, '[data-status="des"]');
    assert.deepEqual(pg.consulta('#list .tag.off').map((t) => t.textContent), ['Desabilitado']);
    await clicar(pg, '[data-status="todos"]');
    await clicar(pg, '[data-agrupar="grupo"]');
    const grupos = pg.consulta('#list tr.grp');
    assert.deepEqual(grupos.map((tr) => [tr.children[0].getAttribute('colspan'), tr.textContent]), [['12', `${ATAQUE} (1)`], ['12', 'Almoxarifado (1)'], ['12', 'Sem grupo (2)'], ['12', 'SST (2)']]);
  });

  test('Exportar: CSV só com os campos reais da visão atual, copiado pela área de transferência', async () => {
    const pg = await pronta();
    await clicar(pg, '[data-act="exportar"]');
    assert.equal(pg.visivel('overlay'), true);
    const csv = pg.el('csv').value;
    const linhas = csv.split('\n');
    assert.equal(linhas[0], 'ID;Usuário;Login;Perfil;Grupo;E-mail;Status');
    assert.equal(linhas.length, 4, 'os três habilitados');
    assert.match(csv, /^2;Usuário Teste Senha Provisória;usuario\.teste\.provisorio@validacao-epi\.invalid;Usuário;—;usuario\.teste\.provisorio@validacao-epi\.invalid;Habilitado$/m);
    assert.equal(/Setor|Horário|Qualquer IP|senha|hash/.test(csv), false);
    await clicar(pg, '#btnCopy');
    assert.deepEqual(pg.copiados, [csv]);
    assert.equal(pg.texto('toast'), 'CSV copiado.');
  });

  test('nenhuma ação morta: o placeholder Desbloquear saiu da tela (sem contrato funcional); todas as ações da linha são reais e nada é gravado ao abrir menus', async () => {
    const pg = await pronta();
    assert.equal(pg.consulta('[data-act="desbloquear"]').length, 0, 'sem botão sem função');
    assert.equal(pg.textoDoDom().includes('Desbloquear'), false);
    await clicar(pg, '.kebab[data-menu="2"]');
    assert.equal(pg.el('actionMenu').classList.contains('open'), true);
    assert.deepEqual(pg.consulta('#actionMenuInner [data-acao]').map((b) => b.getAttribute('data-acao')), ['alterar', 'duplicar', 'permissoes', 'copiar', 'senha', 'desabilitar']);
    // Todas as ações da linha estão integradas (Alterar, Duplicar, Permissões, Copiar, Senha, Desabilitar/Reativar): só o Desbloquear segue em integração.
    assert.deepEqual(nomesDaTabela(pg), ['Pessoa Master', 'Usuário Teste Senha Provisória', 'Bruno Almoxarife'], 'ninguém foi alterado, duplicado ou desabilitado');
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo !== 'GET'), [], 'nenhuma escrita');
    assert.deepEqual(pg.storage.filter((s) => s.operacao === 'setItem' && !/^safework-aparencia$/.test(s.chave)), [], 'localStorage não é fonte nem destino');
    assert.equal(pg.storage.some((s) => /safework-usuarios|safework-tema/.test(s.chave || '')), false);
    await clicar(pg, '[data-act="guia"]');
    assert.equal(pg.visivel('overlay'), true, 'o Guia rápido é texto fixo do HTML aprovado');
  });

  test('tema: o botão usa a aparência por identidade do SafeWork (aplica e salva no servidor); falha ao salvar reverte', async () => {
    const pg = await pronta();
    assert.equal(pg.documento.documentElement.getAttribute('data-theme'), 'light');
    await clicar(pg, '[data-act="tema"]');
    assert.equal(pg.documento.documentElement.getAttribute('data-theme'), 'dark');
    const patches = pg.chamadas.filter((c) => c.chave === 'PATCH /auth/global/conta');
    assert.deepEqual(patches.map((c) => c.corpo), [{ tema: 'escuro' }]);
    assert.equal(pg.storage.some((s) => s.chave === 'safework-tema'), false);

    const falha = await pronta({ conta: { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } } });
    await clicar(falha, '[data-act="tema"]');
    assert.equal(falha.documento.documentElement.getAttribute('data-theme'), 'light', 'reverteu');
    assert.equal(falha.texto('toast'), G.TEXTOS.TEMA_FALHA);
  });

  test('falha da listagem: mensagem no lugar da lista, sem dados inventados; 401 devolve ao Portal', async () => {
    const pg = abrirPagina(ARQUIVO, {
      rotas: {
        'GET /auth/me': { status: 200, corpo: contexto() },
        'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
        'GET /auth/permissoes': { status: 200, corpo: permissoes() },
        'GET /administracao/usuarios': { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } },
      },
    });
    await pg.esperar();
    await pg.esperar();
    assert.match(textoDaLista(pg), /Não foi possível carregar os usuários/);
    assert.equal(pg.consulta('#list tbody tr').length, 0);
    const expirada = abrirPagina(ARQUIVO, {
      rotas: {
        'GET /auth/me': { status: 200, corpo: contexto() },
        'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
        'GET /auth/permissoes': { status: 200, corpo: permissoes() },
        'GET /administracao/usuarios': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } },
      },
    });
    await expirada.esperar();
    await expirada.esperar();
    assert.ok(expirada.navegacoes.some((d) => /portal\/index\.html/.test(d)), JSON.stringify(expirada.navegacoes));
  });

  test('paginação real em segundo plano: 150 usuários chegam em duas páginas de 100 e a tela mostra todos', async () => {
    const lista = Array.from({ length: 150 }, (_, i) => usuario({ id: i + 1, nome: `Pessoa ${String(i + 1).padStart(3, '0')}`, email: `p${i + 1}@validacao-epi.invalid` }));
    const pg = await pronta({ lista });
    assert.deepEqual(listagens(pg).map((c) => new URL(c.url).searchParams.get('pagina')), ['1', '2']);
    assert.equal(pg.consulta('#list tbody tr').length, 150);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Usuários — integração estática (menu, autoridade, scripts, publicação)', () => {
  const html = ler(ARQUIVO);
  const embutido = semComentarios(html.slice(html.lastIndexOf('<script>')));

  test('moldura padrão: tema no head depois do CSS, tela de sessão, menu lateral completo e scripts da fundação, sem db-api.js nem main.js', () => {
    const head = html.split('</head>')[0];
    assert.match(head, /<link rel="stylesheet" href="\.\.\/css\/main\.css">\s*<script src="\.\.\/js\/tema\.js"><\/script>/);
    assert.match(html, /<title>Gestão de Usuários — Gestão de EPIs<\/title>/);
    assert.match(html, /id="telaSessao"/);
    assert.match(html, /<a href="\.\.\/portal\/inicio\.html">/);
    assert.deepEqual(scriptsDe(html).filter((s) => s.src).map((s) => s.src), ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/grupos-acesso.js', '../js/usuarios.js', '../js/gestao-usuarios.js', '../js/permissoes-usuario.js']);
    assert.equal(/db-api\.js|main\.js|<script[^>]+src=["']https?:/.test(semComentariosHtml(semComentarios(html))), false);
    assert.ok(html.includes(LINK_ATIVO));
    assert.ok(html.includes('<a href="user-admin.html" data-pagina="userAdmin" style="display:none">'), 'as seis telas antigas continuam no menu');
  });

  test('o HTML aprovado continua: cabeçalho, toolbar, filtros, busca, Exportar, tabela/cartões, tema, foco, menu de ações, modal, permissões e toast', () => {
    for (const trecho of [
      '<h1>Gestão de usuários</h1>', 'data-act="guia"', 'data-act="grupos"', 'id="ddNovo"', 'data-act="novoUsuario"', 'data-act="novoGrupo"',
      'id="ddStatus"', 'id="lblStatus"', 'id="menuStatus"', 'id="q" type="search" placeholder="Pesquise pelo ID, nome, login ou grupo"', 'id="ddGroup"', 'id="lblGroup"', 'id="menuGroup"',
      'data-act="exportar"', 'data-view="table"', 'data-view="cards"', 'data-act="tema"', 'data-act="foco"', '<div id="list"></div>',
      '<div id="actionMenu"><div class="dd-menu" id="actionMenuInner"></div></div>', '<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>',
      '<section id="permView" aria-label="Permissões do usuário"></section>', '<div id="toast" role="status"></div>',
      // Decisão de 05/10/2026: a barra interna é contexto da sessão — empresa real à esquerda, "Nome - Perfil" reais à direita.
      '<div class="brand" id="whoEmpresa"></div>', '<div class="who"><span id="whoNome"></span> - <span id="whoPerfil"></span></div>',
    ]) assert.ok(html.includes(trecho), trecho);
    assert.equal(/Safe Work|<small>Gestão de EPIs/.test(html.slice(html.indexOf('<header class="appbar">'), html.indexOf('</header>'))), false, 'nada fixo na barra interna');
    assert.equal(/1 - COBRESUL METAIS|\.cobresul|Cobresul/.test(semComentarios(html)), false, 'a empresa vem da sessão');
  });

  test('a página não traz os dados nem a persistência do protótipo, e não escreve innerHTML', () => {
    assert.equal(/localStorage|sessionStorage|safework-usuarios-v1|safework-tema|const users|let users|EMPRESAS\s*=|SETORES\s*=|CATALOGO\s*=|MODELOS\s*=|SUFIXO|admin@exemplo|marina@|totem@/.test(embutido), false);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(embutido), false, 'o conteúdo é montado só com nós e texto');
    assert.match(embutido, /G\.render\.lista\(document,/);
  });

  test('autoridade reutilizada: a mesma área usuarios.consultar da Administração de Usuários; nenhuma permissão nova; nada decidido pelo nome do perfil', () => {
    assert.deepEqual(P.PAGINAS.gestaoUsuarios, { abrir: [['usuarios', 'consultar']], alterar: [] });
    assert.deepEqual(P.PAGINAS.gestaoUsuarios.abrir, P.PAGINAS.userAdmin.abrir);
    assert.equal(/perfil === 'MASTER'|perfil === "MASTER"|=== 'ADMINISTRADOR'/.test(embutido + semComentarios(ler('js/gestao-usuarios.js'))), false);
    assert.match(embutido, /pagina: 'gestaoUsuarios'/);
  });

  test('menu: a entrada ADMINISTRAÇÃO → Gestão de Usuários está em todas as páginas com menu, logo depois de Administração de Usuários; as seis antigas continuam', () => {
    assert.ok(COM_MENU.length >= 12, `${COM_MENU.length} páginas com menu`);
    // Configurações: autorização limitada de 05/10/2026 só para menu/nomenclatura (a baseline funcional segue congelada).
    for (const arquivo of COM_MENU) {
      const h = ler(`pages/${arquivo}`);
      const esperado = arquivo === 'gestao-usuarios.html' ? LINK_ATIVO : LINK;
      assert.ok(h.includes(esperado), `${arquivo}: Gestão de Usuários`);
      const i = h.indexOf('data-pagina="userAdmin"');
      const j = h.indexOf('data-pagina="gestaoUsuarios"');
      assert.ok(i !== -1 && j > i && j - i < 400, `${arquivo}: depois de Administração de Usuários`);
    }
    for (const antiga of SEIS_ANTIGAS) assert.ok(fs.existsSync(path.join(RAIZ, 'pages', antiga)), antiga);
    assert.equal(/Gestão de Usuários/.test(ler('portal/inicio.html')), false, 'o Início do Portal não mudou nesta subetapa');
  });

  test('publicação: página e módulo na allowlist', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['pages/gestao-usuarios.html', 'js/gestao-usuarios.js', 'js/grupos-acesso.js', 'js/permissoes-usuario.js']) assert.ok(arquivos.includes(f), f);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Novo → Usuário (usuário administrativo; decisão de 05/10/2026): CPF,
// matrícula e setor obrigatórios; horário, IPs e grupo opcionais; senha
// provisória com confirmação só na tela; POST /administracao/usuarios real.
const SENHA = 'cometa-lanterna-ardosia-77';
const CPF = '52998224725';
const VALIDO = { nome: 'Pessoa Nova', cpf: '529.982.247-25', email: 'pessoa.nova@validacao-epi.invalid', tipoConta: 'USUARIO', senhaProvisoria: SENHA, confirmacao: SENHA, setor: 'Recursos Humanos', matricula: 'ADM-001' };
const GRUPOS = { status: 200, corpo: { status: 'ok', grupos: [{ id: 7, nome: 'SST', descricao: null, ativo: true }, { id: 8, nome: 'Antigo', descricao: null, ativo: false }] } };
const criado = (chamada) => ({
  status: 201,
  corpo: {
    status: 'ok', usuario: usuario({ id: 9, nome: chamada.corpo.nome, email: chamada.corpo.email }), senhaProvisoriaExpiraEm: '2026-10-07T19:00:00.000Z',
    administrativo: { cpfMascarado: '***.***.***-25', matricula: chamada.corpo.matricula, setor: chamada.corpo.setor, horarioTrabalho: chamada.corpo.horarioTrabalho || null, ipsPermitidos: chamada.corpo.ipsPermitidos || [], grupoAcessoId: chamada.corpo.grupoAcessoId || null },
  },
});
const erro = (status, codigo, detalhes) => ({ status, corpo: { status: 'error', codigo, message: 'texto do servidor que a tela não mostra', ...(detalhes ? { detalhes } : {}) } });
const preencher = (pg, valores) => { Object.keys(valores).forEach((k) => { pg.el(`nu-${k}`).value = valores[k]; }); };
const envios = (pg) => pg.chamadas.filter((c) => c.chave === 'POST /administracao/usuarios');
const nomesDosCampos = (pg) => pg.consulta('#fUser [data-campo]').map((c) => c.getAttribute('name'));
const destacados = (pg) => pg.consulta('#fUser .bad').map((c) => c.getAttribute('name'));
const escritas = (pg) => pg.storage.filter((s) => s.operacao === 'escrita' && (s.storage === 'localStorage' || s.storage === 'sessionStorage')).length;

async function abrirNovo({ rotas = {}, lista } = {}) {
  const pg = await pronta({ lista, rotas: { 'GET /grupos-acesso': GRUPOS, 'POST /administracao/usuarios': criado, ...rotas } });
  await clicar(pg, '[data-act="novoUsuario"]');
  await pg.esperar();
  return pg;
}
async function salvar(pg) {
  await clicar(pg, '#btnSalvarUser');
  await pg.esperar();
  await pg.esperar();
}

describe('Gestão de Usuários — Novo → Usuário: formulário (sem DOM)', () => {
  const F = G.formulario;

  test('validar: o conjunto decidido passa; cada campo obrigatório ausente ou inválido falha com o texto próprio, na ordem da tela', () => {
    assert.deepEqual(F.validar(VALIDO), { ok: true, erros: {} });
    assert.deepEqual(F.validar({ ...VALIDO, horarioInicio: '08:00', horarioFim: '18:00', ipsPermitidos: '203.0.113.10, 2001:db8::1', grupoAcessoId: '7' }).ok, true);
    const tudoErrado = F.validar({ ...VALIDO, nome: ' ', cpf: '529.982.247-26', email: 'sem-arroba', tipoConta: 'GERENTE', senhaProvisoria: 'curta', setor: '', matricula: 'M'.repeat(31), horarioInicio: '08:00', ipsPermitidos: '203.0.113.0/24', grupoAcessoId: 'x' });
    assert.deepEqual(Object.keys(tudoErrado.erros), ['nome', 'cpf', 'email', 'tipoConta', 'senhaProvisoria', 'ipsPermitidos', 'grupoAcessoId', 'setor', 'matricula', 'horario']);
    assert.equal(tudoErrado.erros.cpf, F.ERROS.cpf);
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, confirmacao: 'outra-coisa-diferente' }).erros), ['confirmacao']);
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, cpf: '111.111.111-11' }).erros), ['cpf'], 'dígitos iguais');
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, horarioInicio: '', horarioFim: '18:00' }).erros), ['horario'], 'metade do horário');
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, horarioInicio: '8:00', horarioFim: '18:00' }).erros), ['horario'], 'HH:MM');
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, ipsPermitidos: Array.from({ length: 21 }, (_, i) => `203.0.113.${i + 1}`).join(', ') }).erros), ['ipsPermitidos'], 'até 20');
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, senhaProvisoria: 'x'.repeat(129), confirmacao: 'x'.repeat(129) }).erros), ['senhaProvisoria']);
  });

  test('ips: aceita IPv4 e IPv6 de host, recusa faixa, porta, zona, texto e IPv4 fora de 0–255; a lista separa por vírgula, ponto e vírgula ou espaço', () => {
    for (const ok of ['203.0.113.10', '2001:db8::1', '::1', '2001:0DB8:0000:0000:0000:0000:0000:0010', '::ffff:203.0.113.10']) assert.equal(F.ipValido(ok), true, ok);
    for (const ruim of ['', '203.0.113.0/24', '203.0.113.10:8080', 'localhost', '256.1.1.1', '1.2.3', 'fe80::1%eth0', '2001:db8::zz', '[2001:db8::1]', '203.0.113.10 '] ) assert.equal(F.ipValido(ruim), false, JSON.stringify(ruim));
    assert.deepEqual(F.ipsDe(' 203.0.113.10, 2001:db8::1;198.51.100.7\n10.0.0.1 '), ['203.0.113.10', '2001:db8::1', '198.51.100.7', '10.0.0.1']);
    assert.deepEqual(F.ipsDe(''), []);
  });

  test('corpo: o contrato do backend — CPF só dígitos, horário só com os dois lados, IPs só quando há, grupo numérico, e NUNCA a confirmação', () => {
    assert.deepEqual(F.corpo(VALIDO), { nome: 'Pessoa Nova', email: 'pessoa.nova@validacao-epi.invalid', tipoConta: 'USUARIO', senhaProvisoria: SENHA, cpf: CPF, matricula: 'ADM-001', setor: 'Recursos Humanos' });
    const completo = F.corpo({ ...VALIDO, matricula: ' ADM-001 ', horarioInicio: '08:00', horarioFim: '18:00', ipsPermitidos: '203.0.113.10, 2001:db8::1', grupoAcessoId: '7' });
    assert.deepEqual([completo.horarioTrabalho, completo.ipsPermitidos, completo.grupoAcessoId, completo.matricula], [{ inicio: '08:00', fim: '18:00' }, ['203.0.113.10', '2001:db8::1'], 7, 'ADM-001']);
    assert.equal('confirmacao' in completo, false);
    assert.equal('horarioTrabalho' in F.corpo({ ...VALIDO, horarioInicio: '08:00' }), false);
    assert.equal(F.mascaraCpf('52998224725x'), '529.982.247-25');
    assert.equal(F.mascaraCpf('5299'), '529.9');
  });

  test('erroDoServidor: 400 aponta o campo pelo caminho body.<campo> com o texto da tela; 409/404/403 pelo código; o texto do servidor nunca aparece', () => {
    const r400 = F.erroDoServidor({ ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'servidor', detalhes: [{ campo: 'body.cpf', codigo: 'CPF_DV_INVALIDO', mensagem: 'servidor' }, { campo: 'body.ipsPermitidos.1', codigo: 'IP_INVALIDO' }, { campo: 'body.horarioTrabalho.fim', codigo: 'CAMPO_OBRIGATORIO' }, { campo: 'body.senhaProvisoria', codigo: 'SENHA_SEQUENCIA' }] });
    assert.deepEqual(r400, { mensagem: '', erros: { cpf: F.ERROS.cpf, ipsPermitidos: F.ERROS.ipsPermitidos, horario: F.ERROS.horario, senhaProvisoria: F.ERROS.senhaPolitica } });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.senhaProvisoria', codigo: 'SENHA_CURTA' }] }).erros, { senhaProvisoria: F.ERROS.senhaProvisoria });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.desconhecido', codigo: 'X' }] }), { mensagem: G.TEXTOS.CAMPOS_INVALIDOS, erros: {} });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 409, codigo: 'IDENTIDADE_CPF_JA_EXISTENTE', mensagem: 'servidor' }), { mensagem: '', erros: { cpf: F.POR_CODIGO.IDENTIDADE_CPF_JA_EXISTENTE[1] } });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 409, codigo: 'USUARIO_MATRICULA_JA_EXISTENTE' }).erros, { matricula: F.POR_CODIGO.USUARIO_MATRICULA_JA_EXISTENTE[1] });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 404, codigo: 'GRUPO_NAO_ENCONTRADO' }).erros, { grupoAcessoId: F.POR_CODIGO.GRUPO_NAO_ENCONTRADO[1] });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 403, codigo: 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA' }), { mensagem: G.TEXTOS.SEM_AUTORIDADE, erros: {} });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 403, codigo: 'OUTRO' }), { mensagem: G.TEXTOS.SEM_AUTORIDADE, erros: {} });
    assert.deepEqual(F.erroDoServidor({ ok: false, status: 0, codigo: null }), { mensagem: G.TEXTOS.CRIAR_FALHA, erros: {} });
    assert.equal(JSON.stringify(Object.values(F.POR_CODIGO)).includes('servidor'), false);
  });

  test('EpiUsuarios.acoes.criar envia só o contrato, por POST na mesma rota da listagem; carregarTodos traz os perfis que o servidor diz gerenciáveis', async () => {
    const chamadas = [];
    const guardado = globalThis.EpiHttp;
    globalThis.EpiHttp = { requisitar: (m, c, o) => { chamadas.push([m, c, o.corpo]); return Promise.resolve({ ok: true }); } };
    try {
      U.acoes.criar({ ...F.corpo(VALIDO), confirmacao: SENHA, empresaIdQualquer: 1, horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: [' 203.0.113.10 '], grupoAcessoId: 7 });
      U.acoes.criar(F.corpo(VALIDO));
    } finally {
      if (guardado === undefined) delete globalThis.EpiHttp; else globalThis.EpiHttp = guardado;
    }
    assert.deepEqual(chamadas[0], ['POST', '/administracao/usuarios', { nome: 'Pessoa Nova', email: 'pessoa.nova@validacao-epi.invalid', tipoConta: 'USUARIO', senhaProvisoria: SENHA, cpf: CPF, matricula: 'ADM-001', setor: 'Recursos Humanos', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10'], grupoAcessoId: 7 }]);
    assert.deepEqual(Object.keys(chamadas[1][2]).sort(), ['cpf', 'email', 'matricula', 'nome', 'senhaProvisoria', 'setor', 'tipoConta']);
    const listar = async () => ({ ok: true, status: 200, dados: { usuarios: [], total: 0, perfisGerenciaveis: ['SUPERVISOR', 'USUARIO', 'GERENTE'] } });
    assert.deepEqual((await G.acoes.carregarTodos({ listar })).perfisGerenciaveis, ['SUPERVISOR', 'USUARIO']);
    assert.deepEqual((await G.acoes.carregarTodos({ listar: async () => ({ ok: true, status: 200, dados: { usuarios: [], total: 0 } }) })).perfisGerenciaveis, ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO'], 'sem a lista, todos: o servidor recusa o que não puder');
  });
});

// Decisão de 05/10/2026: o Grupo de acesso não se aplica ao MASTER (a autoridade dele é própria). No formulário isso é só a
// aplicabilidade do campo, discreta e dentro do próprio campo; o servidor continua recusando o vínculo (409 USUARIO_MASTER_SEM_GRUPO).
describe('Gestão de Usuários — Novo → Usuário: Grupo não se aplica ao Master', () => {
  const grupo = (pg) => pg.el('nu-grupoAcessoId');
  const vazioDoGrupo = (pg) => pg.consulta('#nu-grupoAcessoId option')[0].textContent;
  const escolherPerfil = async (pg, tipoConta) => { pg.el('nu-tipoConta').value = tipoConta; await pg.el('nu-tipoConta').disparar('change'); };

  test('módulo: grupoSeAplica é falso só para o Master; corpo e validação ignoram o grupo do Master, mesmo que haja valor escondido', () => {
    const F = G.formulario;
    assert.deepEqual(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO', '', 'GERENTE'].map(F.grupoSeAplica), [false, true, true, true, true, true]);
    assert.equal('grupoAcessoId' in F.corpo({ ...VALIDO, tipoConta: 'MASTER', grupoAcessoId: '7' }), false, 'nunca vai grupo com Master');
    assert.equal(F.corpo({ ...VALIDO, tipoConta: 'SUPERVISOR', grupoAcessoId: '7' }).grupoAcessoId, 7);
    assert.equal(F.validar({ ...VALIDO, tipoConta: 'MASTER', grupoAcessoId: 'lixo' }).ok, true, 'o grupo do Master não é validado: não se aplica');
    assert.deepEqual(Object.keys(F.validar({ ...VALIDO, tipoConta: 'SUPERVISOR', grupoAcessoId: 'lixo' }).erros), ['grupoAcessoId']);
  });

  test('perfil Master: Grupo fica vazio, desabilitado e com "Não se aplica" dentro do próprio campo; sem banner, aviso ou texto extra; o grupo escolhido antes é limpo', async () => {
    const pg = await abrirNovo();
    assert.deepEqual([grupo(pg).disabled, vazioDoGrupo(pg)], [false, 'Sem grupo'], 'antes de escolher o perfil, o Grupo é opcional e disponível');
    preencher(pg, { grupoAcessoId: '7' });
    assert.equal(grupo(pg).value, '7');
    const filhosDoRotulo = grupo(pg).parentNode.children.length;
    const textoAntes = pg.texto('modal');

    await escolherPerfil(pg, 'MASTER');

    assert.deepEqual([grupo(pg).value, grupo(pg).disabled, vazioDoGrupo(pg)], ['', true, 'Não se aplica'], 'limpo, desabilitado e discreto');
    assert.equal(pg.texto('modal'), textoAntes.replace('Sem grupo', 'Não se aplica'), 'a única mudança de texto é dentro do campo');
    assert.equal(grupo(pg).parentNode.children.length, filhosDoRotulo, 'nenhum elemento extra junto do campo');
    assert.equal(pg.texto('hintUser'), '', 'nenhum aviso');
    assert.equal(pg.consulta('#fUser [role="alert"]').filter((el) => el.textContent.trim() !== '').length, 0, 'nenhum alerta');
    assert.equal(pg.texto('toast'), '', 'nenhum toast');
  });

  test('voltar de Master para Administrador, Supervisor ou Usuário: o Grupo volta disponível e continua vazio e opcional; escolher outro grupo funciona', async () => {
    const pg = await abrirNovo();
    for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      await escolherPerfil(pg, 'MASTER');
      assert.deepEqual([grupo(pg).disabled, grupo(pg).value], [true, '']);
      await escolherPerfil(pg, perfil);
      assert.deepEqual([grupo(pg).disabled, grupo(pg).value, vazioDoGrupo(pg)], [false, '', 'Sem grupo'], perfil);
    }
    preencher(pg, { grupoAcessoId: '7' });
    assert.equal(grupo(pg).value, '7');
    await escolherPerfil(pg, 'MASTER');
    await escolherPerfil(pg, 'USUARIO');
    assert.equal(grupo(pg).value, '', 'o grupo anterior não volta sozinho: a pessoa escolhe de novo');
  });

  test('envio como Master: sem grupoAcessoId no corpo; como Supervisor sem grupo também; Supervisor com grupo envia o id', async () => {
    const pg = await abrirNovo();
    preencher(pg, { ...VALIDO, tipoConta: 'SUPERVISOR', grupoAcessoId: '7' });
    await escolherPerfil(pg, 'MASTER');
    await salvar(pg);
    const [mestre] = envios(pg);
    assert.equal(mestre.corpo.tipoConta, 'MASTER');
    assert.equal('grupoAcessoId' in mestre.corpo, false, 'Master nunca leva grupo');

    const pg2 = await abrirNovo();
    preencher(pg2, { ...VALIDO, tipoConta: 'SUPERVISOR' });
    await salvar(pg2);
    assert.equal('grupoAcessoId' in envios(pg2)[0].corpo, false, 'grupo é opcional');
    const pg3 = await abrirNovo();
    preencher(pg3, { ...VALIDO, tipoConta: 'SUPERVISOR', grupoAcessoId: '7' });
    await salvar(pg3);
    assert.equal(envios(pg3)[0].corpo.grupoAcessoId, 7);
  });

  test('o servidor continua a autoridade: 409 USUARIO_MASTER_SEM_GRUPO ainda é tratado no campo; a tela não decide autoridade pelo perfil de quem age', async () => {
    const pg = await abrirNovo({ rotas: { 'POST /administracao/usuarios': () => erro(409, 'USUARIO_MASTER_SEM_GRUPO') } });
    preencher(pg, { ...VALIDO, tipoConta: 'MASTER' });
    await salvar(pg);
    assert.deepEqual(destacados(pg), ['grupoAcessoId']);
    assert.equal(pg.texto('hintUser'), G.formulario.POR_CODIGO.USUARIO_MASTER_SEM_GRUPO[1]);
    const fonte = semComentarios(ler('js/gestao-usuarios.js')) + semComentarios(ler(ARQUIVO).slice(ler(ARQUIVO).lastIndexOf('<script>')));
    assert.equal(/perfil === 'MASTER'|perfil === "MASTER"|=== 'ADMINISTRADOR'/.test(fonte), false);
    assert.equal(/\.perfil\b[^;\n]*MASTER/.test(fonte), false, 'o perfil de quem age nunca decide nada');
  });
});

describe('Gestão de Usuários — Novo → Usuário: tela', () => {
  test('abre o formulário com os campos decididos, os grupos ATIVOS reais e os perfis que o servidor permite; sem Status, dois fatores, Permissões ou Empresas', async () => {
    const pg = await abrirNovo();
    assert.equal(pg.el('overlay').classList.contains('open'), true);
    assert.deepEqual(nomesDosCampos(pg), ['nome', 'cpf', 'email', 'tipoConta', 'senhaProvisoria', 'confirmacao', 'ipsPermitidos', 'grupoAcessoId', 'setor', 'matricula', 'horarioInicio', 'horarioFim', 'vinculoSst']);
    assert.equal(pg.consulta('#fUser .req').length, 8, 'Nome, CPF, E-mail, Perfil, Senha, Confirmar, Setor e Matrícula');
    assert.deepEqual(pg.consulta('#nu-grupoAcessoId option').map((o) => [o.getAttribute('value'), o.textContent]), [['', 'Sem grupo'], ['7', 'SST']], 'o grupo inativo não é oferecido');
    assert.deepEqual(pg.consulta('#nu-tipoConta option').map((o) => o.textContent), ['Selecione', 'Usuário'], 'perfisGerenciaveis da listagem real');
    const grupos = pg.chamadas.filter((c) => c.chave === 'GET /grupos-acesso');
    assert.equal(grupos.length, 1);
    assert.ok(grupos[0].url.endsWith('/grupos-acesso?ativo=true'));
    const modal = pg.texto('modal');
    assert.equal(/Status|dois fatores|Permissões|Empresa\(s\)|Login|Habilitado/.test(modal), false, 'nada do protótipo fora da decisão');
    for (const t of ['Nome completo', 'CPF', 'E-mail', 'Perfil / Tipo de conta', 'Senha provisória', 'Confirmar senha provisória', 'IP(s) permitido(s)', 'Grupo de acesso', 'Setor', 'Matrícula', 'Horário de trabalho de', 'até', 'Cadastrar usuário', 'Voltar sem mudar nada']) assert.ok(modal.includes(t), t);
    assert.deepEqual([pg.el('nu-senhaProvisoria').getAttribute('type'), pg.el('nu-confirmacao').getAttribute('autocomplete')], ['password', 'new-password']);
    assert.equal(pg.foco(), 'nu-nome');
  });

  test('validação local: nada é enviado com CPF inválido, confirmação diferente, horário pela metade ou IP inválido; os campos ficam destacados e o CPF ganha máscara ao digitar', async () => {
    const pg = await abrirNovo();
    preencher(pg, { ...VALIDO, cpf: '52998224726', confirmacao: 'outra-senha-diferente-77', horarioInicio: '08:00', ipsPermitidos: '203.0.113.0/24' });
    await pg.el('nu-cpf').disparar('input');
    assert.equal(pg.el('nu-cpf').value, '529.982.247-26', 'máscara progressiva');
    await salvar(pg);
    assert.equal(envios(pg).length, 0, 'nenhum POST');
    assert.deepEqual(destacados(pg), ['cpf', 'confirmacao', 'ipsPermitidos', 'horarioInicio', 'horarioFim']);
    const hint = pg.texto('hintUser');
    for (const t of [G.formulario.ERROS.cpf, G.formulario.ERROS.confirmacao, G.formulario.ERROS.ipsPermitidos, G.formulario.ERROS.horario]) assert.ok(hint.includes(t), t);
    assert.equal(pg.el('overlay').classList.contains('open'), true);
    preencher(pg, { cpf: '529.982.247-25', confirmacao: SENHA, horarioInicio: '', ipsPermitidos: '' });
    await pg.el('nu-cpf').disparar('input');
    assert.deepEqual(destacados(pg).includes('cpf'), false, 'digitar limpa o destaque do campo');
  });

  test('envio: POST com o contrato exato (CPF só dígitos, sem confirmação, opcionais só quando informados); sucesso fecha o modal, descarta os campos, avisa com o texto decidido e recarrega a listagem real', async () => {
    const lista = [...USUARIOS];
    const pg = await abrirNovo({ lista, rotas: { 'POST /administracao/usuarios': (ch) => { lista.push(usuario({ id: 9, nome: ch.corpo.nome, email: ch.corpo.email })); return criado(ch); } } });
    const antes = listagens(pg).length;
    preencher(pg, { ...VALIDO, horarioInicio: '08:00', horarioFim: '18:00', ipsPermitidos: '203.0.113.10, 2001:db8::1', grupoAcessoId: '7' });
    await salvar(pg);
    const [envio] = envios(pg);
    assert.ok(envio, 'um POST');
    assert.deepEqual(envio.corpo, { nome: 'Pessoa Nova', email: 'pessoa.nova@validacao-epi.invalid', tipoConta: 'USUARIO', senhaProvisoria: SENHA, cpf: CPF, matricula: 'ADM-001', setor: 'Recursos Humanos', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10', '2001:db8::1'], grupoAcessoId: 7 });
    assert.equal(envio.credentials, 'include');
    assert.equal(envios(pg).length, 1, 'uma vez só');
    assert.equal(pg.el('overlay').classList.contains('open'), false, 'modal fechado');
    assert.equal(pg.existe('fUser'), false, 'formulário descartado: nenhum campo preenchido sobra');
    assert.equal(pg.texto('toast'), G.TEXTOS.NOVO_USUARIO_SUCESSO);
    assert.equal(G.TEXTOS.NOVO_USUARIO_SUCESSO, 'Usuário criado com sucesso. Informe ao usuário o e-mail e a senha provisória pelos meios internos da empresa.');
    assert.equal(listagens(pg).length, antes + 1, 'a listagem real foi recarregada');
    assert.ok(nomesDaTabela(pg).includes('Pessoa Nova'), 'o usuário criado aparece na listagem recarregada');
  });

  test('erros do servidor: 409 de e-mail, CPF, matrícula e grupo, 400 por campo e 403 ficam no modal, com os textos da tela e o campo destacado; depois um envio válido fecha', async () => {
    const respostas = [
      erro(409, 'IDENTIDADE_EMAIL_JA_EXISTENTE'), erro(409, 'IDENTIDADE_CPF_JA_EXISTENTE'), erro(409, 'USUARIO_MATRICULA_JA_EXISTENTE'), erro(409, 'USUARIO_MASTER_SEM_GRUPO'),
      erro(400, 'VALIDACAO', [{ campo: 'body.senhaProvisoria', codigo: 'SENHA_COMUM', mensagem: 'servidor' }]), erro(403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA'),
    ];
    const pg = await abrirNovo({ rotas: { 'POST /administracao/usuarios': (ch) => respostas.shift() || criado(ch) } });
    preencher(pg, VALIDO);
    for (const [campo, texto] of [['email', G.formulario.POR_CODIGO.IDENTIDADE_EMAIL_JA_EXISTENTE[1]], ['cpf', G.formulario.POR_CODIGO.IDENTIDADE_CPF_JA_EXISTENTE[1]], ['matricula', G.formulario.POR_CODIGO.USUARIO_MATRICULA_JA_EXISTENTE[1]], ['grupoAcessoId', G.formulario.POR_CODIGO.USUARIO_MASTER_SEM_GRUPO[1]], ['senhaProvisoria', G.formulario.ERROS.senhaPolitica]]) {
      await salvar(pg);
      assert.equal(pg.el('overlay').classList.contains('open'), true, campo);
      assert.deepEqual(destacados(pg), [campo]);
      assert.equal(pg.texto('hintUser'), texto);
      assert.equal(pg.el('btnSalvarUser').disabled, false, 'o botão volta');
    }
    await salvar(pg);
    assert.deepEqual([pg.texto('hintUser'), destacados(pg)], [G.TEXTOS.SEM_AUTORIDADE, []]);
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false, 'o texto do servidor nunca aparece');
    await salvar(pg);
    assert.equal(pg.el('overlay').classList.contains('open'), false);
    assert.equal(envios(pg).length, 7);
  });

  test('segurança: senha, confirmação e CPF nunca vão ao armazenamento do navegador, à URL, ao console ou ficam no DOM depois do envio; o corpo viaja só no POST', async () => {
    const pg = await abrirNovo();
    const escritasAntes = escritas(pg);
    preencher(pg, VALIDO);
    await salvar(pg);
    assert.equal(escritas(pg), escritasAntes, 'nenhuma escrita nova em localStorage/sessionStorage');
    for (const c of pg.chamadas) {
      assert.equal(c.url.includes(CPF) || c.url.includes(SENHA), false, c.url);
      if (c.chave !== 'POST /administracao/usuarios') assert.equal(String(c.corpoBruto).includes(SENHA), false, c.chave);
    }
    assert.equal(pg.textoDoDom().includes(SENHA) || pg.textoDoDom().includes(CPF), false);
    assert.equal(JSON.stringify(pg.consoleChamadas).includes(SENHA), false);
    assert.equal(/localStorage|sessionStorage/.test(semComentarios(ler('js/gestao-usuarios.js'))), false);
  });

  test('cancelar: "Voltar sem mudar nada" e Esc fecham sem enviar; sem autoridade de criação o servidor é quem recusa (a tela não decide pelo perfil)', async () => {
    const pg = await abrirNovo();
    preencher(pg, VALIDO);
    await clicar(pg, '#modal [data-close]');
    assert.equal(pg.el('overlay').classList.contains('open'), false);
    assert.equal(envios(pg).length, 0);
    assert.equal(pg.existe('fUser'), false);
    await clicar(pg, '[data-act="novoUsuario"]');
    await pg.esperar();
    assert.equal(pg.existe('fUser'), true, 'reabre limpo');
    assert.equal(pg.el('nu-nome').value, '');
    assert.equal(/perfil === 'MASTER'|perfil === "MASTER"|=== 'ADMINISTRADOR'/.test(semComentarios(ler('js/gestao-usuarios.js')) + semComentarios(ler(ARQUIVO).slice(ler(ARQUIVO).lastIndexOf('<script>')))), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA A — Desabilitar / Reativar (POST /administracao/usuarios/:id/inativar|reativar)
describe('Gestão de Usuários — Desabilitar e Reativar usuário', () => {
  const estado = { 2: true, 3: false };
  const rotas = (falha) => ({
    'POST /administracao/usuarios/2/inativar': (c) => (falha ? erro(falha[0], falha[1]) : { status: 200, corpo: { status: 'ok', usuario: usuario({ id: 2, ativo: false }) } }),
    'POST /administracao/usuarios/3/reativar': { status: 200, corpo: { status: 'ok', usuario: usuario({ id: 3, ativo: true }) } },
  });
  const abrirMenu = async (pg, id) => { await clicar(pg, `.kebab[data-menu="${id}"]`); };
  void estado;

  test('o menu oferece Desabilitar para ativo e "Reativar usuário" para desabilitado', async () => {
    const pg = await pronta({ rotas: rotas() });
    await clicar(pg, '[data-status="todos"]');
    await abrirMenu(pg, 2);
    assert.equal(pg.consulta('#actionMenuInner [data-acao="desabilitar"]').length, 1);
    await abrirMenu(pg, 3);
    const botao = pg.consulta('#actionMenuInner [data-acao="habilitar"]');
    assert.deepEqual([botao.length, botao[0].textContent.includes('Reativar usuário'), pg.consulta('#actionMenuInner [data-acao="desabilitar"]').length], [1, true, 0]);
  });

  test('desabilitar pede confirmação com o texto decidido; Cancelar não envia; Confirmar envia o POST, fecha, avisa e recarrega a listagem real', async () => {
    const lista = USUARIOS.map((u) => ({ ...u }));
    const pg = await pronta({ lista, rotas: { ...rotas(), 'POST /administracao/usuarios/2/inativar': () => { lista[1].ativo = false; return { status: 200, corpo: { status: 'ok' } }; } } });
    await abrirMenu(pg, 2);
    await clicar(pg, '#actionMenuInner [data-acao="desabilitar"]');
    assert.equal(pg.visivel('overlay'), true);
    const modal = pg.texto('modal');
    for (const t of ['Desabilitar acesso de Usuário Teste Senha Provisória?', 'O usuário perderá o acesso ao SafeWork. O cadastro e o histórico serão preservados.', 'Cancelar', 'Desabilitar usuário']) assert.ok(modal.includes(t), t);
    await clicar(pg, '#modal [data-close]');
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'POST').length, 0, 'cancelar não envia');
    const antes = listagens(pg).length;
    await abrirMenu(pg, 2);
    await clicar(pg, '#actionMenuInner [data-acao="desabilitar"]');
    await clicar(pg, '#btnConfirmar');
    await pg.esperar();
    assert.equal(pg.chamadas.filter((c) => c.chave === 'POST /administracao/usuarios/2/inativar').length, 1);
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.DESABILITADO_OK);
    assert.equal(listagens(pg).length, antes + 1);
    assert.equal(nomesDaTabela(pg).includes('Usuário Teste Senha Provisória'), false, 'sai do filtro Habilitados');
    await clicar(pg, '[data-status="des"]');
    assert.ok(nomesDaTabela(pg).includes('Usuário Teste Senha Provisória'));
    await abrirMenu(pg, 2);
    assert.equal(pg.consulta('#actionMenuInner [data-acao="habilitar"]').length, 1, 'agora oferece Reativar');
  });

  test('reativar envia o POST direto e recarrega; último Master e 403 mostram texto da tela; nada em localStorage', async () => {
    const pg = await pronta({ rotas: rotas() });
    await clicar(pg, '[data-status="todos"]');
    await abrirMenu(pg, 3);
    await clicar(pg, '#actionMenuInner [data-acao="habilitar"]');
    await pg.esperar();
    assert.equal(pg.chamadas.filter((c) => c.chave === 'POST /administracao/usuarios/3/reativar').length, 1);
    assert.equal(pg.texto('toast'), G.TEXTOS.REATIVADO_OK);
    const ultimo = await pronta({ rotas: rotas([409, 'USUARIO_ULTIMO_MASTER']) });
    await abrirMenu(ultimo, 2);
    await clicar(ultimo, '#actionMenuInner [data-acao="desabilitar"]');
    await clicar(ultimo, '#btnConfirmar');
    await ultimo.esperar();
    assert.equal(ultimo.texto('toast'), G.TEXTOS.ULTIMO_MASTER);
    assert.equal(ultimo.textoDoDom().includes('texto do servidor'), false);
    assert.deepEqual(G.situacao.erro({ status: 403 }), G.TEXTOS.SEM_AUTORIDADE);
    assert.equal(escritas(pg), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA B — Novo → Grupo (POST /grupos-acesso): Grupo não é Setor; nasce vazio e sem permissão.
describe('Gestão de Usuários — Novo → Grupo', () => {
  const grupoCriado = (c) => ({ status: 201, corpo: { status: 'ok', grupo: { id: 11, nome: c.corpo.nome, descricao: c.corpo.descricao ?? null, ativo: true } } });
  const abrirGrupo = async (rotas = {}) => {
    const pg = await pronta({ rotas: { 'GET /grupos-acesso': GRUPOS, 'POST /grupos-acesso': grupoCriado, ...rotas } });
    await clicar(pg, '[data-act="novoGrupo"]');
    return pg;
  };
  const enviar = async (pg) => { await clicar(pg, '#btnSalvarGrupo'); await pg.esperar(); await pg.esperar(); };

  test('módulo: validar exige o nome (até 100) e a descrição é opcional (até 500); corpo só leva descrição quando informada', () => {
    const F = G.grupoForm;
    assert.deepEqual(Object.keys(F.validar({ nome: '  ' }).erros), ['nome']);
    assert.deepEqual(Object.keys(F.validar({ nome: 'x'.repeat(101) }).erros), ['nome']);
    assert.deepEqual(Object.keys(F.validar({ nome: 'RH', descricao: 'y'.repeat(501) }).erros), ['descricao']);
    assert.equal(F.validar({ nome: 'RH' }).ok, true);
    assert.deepEqual(F.corpo({ nome: ' RH ', descricao: '' }), { nome: 'RH' });
    assert.deepEqual(F.corpo({ nome: 'RH', descricao: ' Pessoas ' }), { nome: 'RH', descricao: 'Pessoas' });
    assert.equal(F.erroDoServidor({ ok: false, status: 409, codigo: 'GRUPO_NOME_EM_USO' }).erros.nome, F.TEXTOS.NOME_EM_USO);
    assert.equal(F.erroDoServidor({ ok: false, status: 403 }).mensagem, G.TEXTOS.SEM_AUTORIDADE);
  });

  test('abre o modal dentro da própria página (sem redirecionar) só com Nome do grupo* e Descrição, e explica que Grupo não é Setor sem banner', async () => {
    const pg = await abrirGrupo();
    assert.equal(pg.visivel('overlay'), true);
    assert.deepEqual(pg.consulta('#fGrupo [data-campo]').map((c) => c.getAttribute('name')), ['nome', 'descricao']);
    assert.equal(pg.consulta('#fGrupo .req').length, 1);
    assert.ok(pg.texto('modal').includes('Novo grupo') && pg.texto('modal').includes('Nome do grupo'));
    assert.equal(pg.navegacoes.length, 0);
  });

  test('nome obrigatório bloqueia o envio; criação válida envia só nome/descrição, fecha, limpa, avisa e recarrega listagem e grupos; o novo grupo aparece no Novo Usuário (Master segue "Não se aplica")', async () => {
    const pg = await abrirGrupo();
    await enviar(pg);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'POST').length, 0);
    assert.ok(pg.consulta('#fGrupo .bad').length === 1);
    pg.el('ng-nome').value = 'Almoxarifado';
    pg.el('ng-descricao').value = 'Estoque e entregas';
    const antes = listagens(pg).length;
    await enviar(pg);
    const [post] = pg.chamadas.filter((c) => c.chave === 'POST /grupos-acesso');
    assert.deepEqual(post.corpo, { nome: 'Almoxarifado', descricao: 'Estoque e entregas' });
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.existe('fGrupo'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.GRUPO_CRIADO_OK);
    assert.equal(listagens(pg).length, antes + 1);
    assert.equal(escritas(pg), 0);
  });

  test('erros do servidor: nome em uso fica no campo; sem autoridade vira texto da tela; nada do texto do servidor', async () => {
    const pg = await abrirGrupo({ 'POST /grupos-acesso': () => erro(409, 'GRUPO_NOME_EM_USO') });
    pg.el('ng-nome').value = 'RH';
    await enviar(pg);
    assert.equal(pg.visivel('overlay'), true);
    assert.deepEqual(pg.consulta('#fGrupo .bad').map((c) => c.getAttribute('name')), ['nome']);
    assert.equal(pg.texto('hintGrupo'), G.grupoForm.TEXTOS.NOME_EM_USO);
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA C — Alterar usuário (GET /:id/edicao + PATCH /:id), o mesmo modal em modo edição
describe('Gestão de Usuários — Alterar usuário', () => {
  const DETALHE = {
    id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'SUPERVISOR', ativo: true, cpf: '52998224725', matricula: 'ALM-004', setor: 'Almoxarifado',
    horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10', '2001:db8::1'], grupoAcessoId: 7,
  };
  const abrirEdicao = async (rotas = {}) => {
    const pg = await pronta({ rotas: { 'GET /grupos-acesso': GRUPOS, 'GET /administracao/usuarios/4/edicao': { status: 200, corpo: { status: 'ok', usuario: DETALHE } }, 'PATCH /administracao/usuarios/4': { status: 200, corpo: { status: 'ok', alterado: true } }, ...rotas } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="alterar"]');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };
  const salvarEdicao = async (pg) => { await clicar(pg, '#btnSalvarUser'); await pg.esperar(); await pg.esperar(); };

  test('abre o MESMO modal em modo edição: título, botão, dados atuais preenchidos, CPF COMPLETO formatado e só leitura, sem campos de senha', async () => {
    const pg = await abrirEdicao();
    const modal = pg.texto('modal');
    assert.ok(modal.includes('Alterar usuário') && modal.includes('Salvar alterações'));
    assert.equal(/Senha provisória|Confirmar senha/.test(modal), false);
    assert.deepEqual(pg.consulta('#fUser [data-campo]').map((c) => c.getAttribute('name')), ['nome', 'cpf', 'email', 'tipoConta', 'ipsPermitidos', 'grupoAcessoId', 'setor', 'matricula', 'horarioInicio', 'horarioFim', 'vinculoSst']);
    const v = (n) => pg.el(`nu-${n}`).value;
    assert.deepEqual([v('nome'), v('cpf'), v('email'), v('tipoConta'), v('matricula'), v('setor'), v('horarioInicio'), v('horarioFim'), v('ipsPermitidos'), v('grupoAcessoId')],
      ['Bruno Almoxarife', '529.982.247-25', 'bruno@validacao-epi.invalid', 'SUPERVISOR', 'ALM-004', 'Almoxarifado', '08:00', '18:00', '203.0.113.10, 2001:db8::1', '7']);
    assert.equal(pg.el('nu-cpf').hasAttribute('readonly'), true);
    const lista = pg.consulta('#list').map((n) => n.textContent).join('');
    assert.equal(lista.includes('529.982.247-25'), false, 'o CPF completo só existe dentro do modal autorizado');
    assert.equal(pg.chamadas.filter((c) => c.chave === 'GET /administracao/usuarios/4/edicao').length, 1);
  });

  test('salvar envia o PATCH com os campos editáveis (nunca cpf nem senha; e-mail só se mudou); sucesso fecha, avisa e recarrega a listagem real', async () => {
    const pg = await abrirEdicao();
    pg.el('nu-setor').value = 'Logística';
    pg.el('nu-ipsPermitidos').value = '';
    pg.el('nu-horarioInicio').value = '';
    pg.el('nu-horarioFim').value = '';
    pg.el('nu-grupoAcessoId').value = '';
    const antes = listagens(pg).length;
    await salvarEdicao(pg);
    const [patch] = pg.chamadas.filter((c) => c.metodo === 'PATCH' && c.caminho === '/administracao/usuarios/4');
    assert.deepEqual(patch.corpo, { nome: 'Bruno Almoxarife', matricula: 'ALM-004', setor: 'Logística', horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null });
    assert.equal('cpf' in patch.corpo || 'senhaProvisoria' in patch.corpo || 'email' in patch.corpo, false);
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.ALTERADO_OK);
    assert.equal(listagens(pg).length, antes + 1);
    const pg2 = await abrirEdicao();
    pg2.el('nu-email').value = 'novo@validacao-epi.invalid';
    await salvarEdicao(pg2);
    assert.equal(pg2.chamadas.find((c) => c.metodo === 'PATCH').corpo.email, 'novo@validacao-epi.invalid');
  });

  test('perfil Master no modo edição: Grupo limpo, desabilitado e "Não se aplica"; o PATCH não leva grupo; validação local e erros do servidor ficam no campo', async () => {
    const pg = await abrirEdicao({ 'PATCH /administracao/usuarios/4': () => erro(409, 'EMAIL_IDENTIDADE_COMPARTILHADA') });
    pg.el('nu-tipoConta').value = 'MASTER';
    await pg.el('nu-tipoConta').disparar('change');
    assert.deepEqual([pg.el('nu-grupoAcessoId').value, pg.el('nu-grupoAcessoId').disabled], ['', true]);
    pg.el('nu-setor').value = '';
    await salvarEdicao(pg);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'PATCH').length, 0, 'setor vazio é recusado antes da rede');
    pg.el('nu-setor').value = 'Almoxarifado';
    pg.el('nu-email').value = 'outro@validacao-epi.invalid';
    await salvarEdicao(pg);
    const corpo = pg.chamadas.find((c) => c.metodo === 'PATCH').corpo;
    assert.deepEqual([corpo.tipoConta, corpo.grupoAcessoId], ['MASTER', null]);
    assert.deepEqual(pg.consulta('#fUser .bad').map((c) => c.getAttribute('name')), ['email']);
    assert.equal(pg.texto('hintUser'), G.formulario.POR_CODIGO.EMAIL_IDENTIDADE_COMPARTILHADA[1]);
  });

  test('sem autoridade (403 no detalhe) nenhum modal abre e a pessoa é avisada; nada em localStorage', async () => {
    const pg = await abrirEdicao({ 'GET /administracao/usuarios/4/edicao': () => erro(403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA') });
    assert.equal(pg.existe('fUser'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.SEM_AUTORIDADE);
    assert.equal(escritas(pg), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA D — Duplicar usuário: o mesmo modal do Novo, com outro usuário como MODELO DE ACESSO
describe('Gestão de Usuários — Duplicar usuário', () => {
  const abrirDuplicar = async (rotas = {}) => {
    const pg = await pronta({ rotas: { 'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [{ id: 7, nome: 'Almoxarifado', descricao: null, ativo: true }] } }, 'POST /administracao/usuarios': criado, ...rotas } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="duplicar"]');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };

  test('módulo: valoresDeDuplicacao copia só perfil (se o ator pode) e grupo (pelo nome); nada pessoal', () => {
    const F = G.formulario;
    const grupos = [{ id: 7, nome: 'Almoxarifado', ativo: true }, { id: 8, nome: 'Antigo', ativo: false }];
    assert.deepEqual(F.valoresDeDuplicacao({ perfil: 'SUPERVISOR', grupo: 'almoxarifado', nome: 'X', email: 'x@y.z' }, grupos, ['SUPERVISOR', 'USUARIO']), { tipoConta: 'SUPERVISOR', grupoAcessoId: 7 });
    assert.deepEqual(F.valoresDeDuplicacao({ perfil: 'MASTER', grupo: 'Almoxarifado' }, grupos, ['USUARIO']), { tipoConta: '', grupoAcessoId: '' });
    assert.deepEqual(F.valoresDeDuplicacao({ perfil: 'MASTER', grupo: 'Almoxarifado' }, grupos, ['MASTER']), { tipoConta: 'MASTER', grupoAcessoId: '' }, 'Master nunca com grupo');
    assert.deepEqual(F.valoresDeDuplicacao({ perfil: 'USUARIO', grupo: 'Antigo' }, grupos, ['USUARIO']), { tipoConta: 'USUARIO', grupoAcessoId: '' }, 'grupo inativo não é oferecido');
  });

  test('abre "Duplicar usuário" com a nota discreta do modelo, dados pessoais VAZIOS e só perfil e grupo preenchidos; cria enviando usuarioModeloId', async () => {
    const pg = await abrirDuplicar();
    const modal = pg.texto('modal');
    assert.ok(modal.includes('Duplicar usuário') && modal.includes('Usando Bruno Almoxarife como modelo de acesso'));
    assert.equal(pg.consulta('#fUser [role="alert"]').filter((e) => e.textContent.trim()).length, 0, 'sem banner');
    const v = (n) => pg.el(`nu-${n}`).value;
    assert.deepEqual(['nome', 'cpf', 'email', 'matricula', 'setor', 'senhaProvisoria', 'confirmacao', 'ipsPermitidos', 'horarioInicio', 'horarioFim'].map(v), ['', '', '', '', '', '', '', '', '', '']);
    assert.deepEqual([v('tipoConta'), v('grupoAcessoId')], ['', '7'], 'o ator só cria Usuário: o perfil Supervisor do modelo não é copiado, o grupo é');
    preencher(pg, { ...VALIDO, tipoConta: 'USUARIO', grupoAcessoId: '7' });
    await salvar(pg);
    const [envio] = envios(pg);
    assert.equal(envio.corpo.usuarioModeloId, 4);
    assert.equal(envio.corpo.grupoAcessoId, 7);
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.NOVO_USUARIO_SUCESSO);
    const novo = await abrirNovo();
    assert.equal(/Usando .* como modelo/.test(novo.texto('modal')), false, 'o Novo comum não muda');
    assert.equal('usuarioModeloId' in (await (async () => { preencher(novo, VALIDO); await salvar(novo); return envios(novo)[0].corpo; })()), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA E — Alterar senha: nova SENHA PROVISÓRIA (POST /administracao/usuarios/:id/senha-provisoria)
describe('Gestão de Usuários — Alterar senha', () => {
  const NOVA = 'girassol-quartzo-bussola-58';
  const abrirSenha = async (rotas = {}) => {
    const pg = await pronta({ rotas: { 'POST /administracao/usuarios/4/senha-provisoria': { status: 200, corpo: { status: 'ok', senhaProvisoriaExpiraEm: '2026-10-08T00:00:00.000Z' } }, ...rotas } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="senha"]');
    return pg;
  };
  const redefinir = async (pg) => { await clicar(pg, '#btnRedefinirSenha'); await pg.esperar(); await pg.esperar(); };

  test('módulo: validar exige 12–128 e confirmação igual; erros do servidor viram texto da tela', () => {
    const F = G.senhaForm;
    assert.deepEqual(Object.keys(F.validar({ senhaProvisoria: 'curta', confirmacao: 'curta' }).erros), ['senhaProvisoria']);
    assert.deepEqual(Object.keys(F.validar({ senhaProvisoria: NOVA, confirmacao: 'outra' }).erros), ['confirmacao']);
    assert.equal(F.validar({ senhaProvisoria: NOVA, confirmacao: NOVA }).ok, true);
    assert.equal(F.erroDoServidor({ ok: false, status: 400, codigo: 'VALIDACAO' }).erros.senhaProvisoria, F.TEXTOS.POLITICA);
    assert.equal(F.erroDoServidor({ ok: false, status: 409, codigo: 'SENHA_IDENTIDADE_COMPARTILHADA' }).mensagem, F.TEXTOS.COMPARTILHADA);
    assert.equal(F.erroDoServidor({ ok: false, status: 409, codigo: 'USUARIO_SENHA_PROPRIA' }).mensagem, F.TEXTOS.PROPRIA);
  });

  test('abre "Alterar senha de [Nome]" com os dois campos e os botões Cancelar e Redefinir senha', async () => {
    const pg = await abrirSenha();
    const modal = pg.texto('modal');
    for (const t of ['Alterar senha de Bruno Almoxarife', 'Nova senha provisória', 'Confirmar senha provisória', 'Cancelar', 'Redefinir senha']) assert.ok(modal.includes(t), t);
    assert.deepEqual(pg.consulta('#fSenha [data-campo]').map((c) => c.getAttribute('type')), ['password', 'password']);
  });

  test('validação local não envia; sucesso envia só a senha, fecha, avisa e não guarda nada; erros ficam no modal com textos da tela', async () => {
    const pg = await abrirSenha();
    pg.el('sn-senhaProvisoria').value = NOVA;
    pg.el('sn-confirmacao').value = 'diferente-de-proposito';
    await redefinir(pg);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'POST').length, 0);
    assert.deepEqual(pg.consulta('#fSenha .bad').map((c) => c.getAttribute('name')), ['confirmacao']);
    pg.el('sn-confirmacao').value = NOVA;
    await redefinir(pg);
    const [envio] = pg.chamadas.filter((c) => c.chave === 'POST /administracao/usuarios/4/senha-provisoria');
    assert.deepEqual(envio.corpo, { senhaProvisoria: NOVA });
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.texto('toast'), G.senhaForm.TEXTOS.OK);
    assert.equal(pg.existe('fSenha'), false);
    assert.equal(escritas(pg), 0);
    assert.equal(pg.textoDoDom().includes(NOVA), false);
    assert.equal(JSON.stringify(pg.consoleChamadas).includes(NOVA), false);

    const ruim = await abrirSenha({ 'POST /administracao/usuarios/4/senha-provisoria': () => erro(409, 'SENHA_IDENTIDADE_COMPARTILHADA') });
    ruim.el('sn-senhaProvisoria').value = NOVA;
    ruim.el('sn-confirmacao').value = NOVA;
    await redefinir(ruim);
    assert.equal(ruim.visivel('overlay'), true);
    assert.equal(ruim.texto('hintSenha'), G.senhaForm.TEXTOS.COMPARTILHADA);
    assert.equal(ruim.textoDoDom().includes('texto do servidor'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA F — Configurar permissões: catálogo e camadas vêm do servidor
const PERM = {
  usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'SUPERVISOR', ativo: true },
  podeAlterar: true,
  motivoSomenteLeitura: null,
  grupo: { nome: 'Almoxarifado', ativo: true },
  recursos: [
    { recurso: 'materials', rotulo: 'Materiais', operacoes: {
      visualizar: { perfil: true, grupo: null, individual: null, efetivo: true, origem: 'PERFIL' },
      criar: { perfil: false, grupo: true, individual: null, efetivo: true, origem: 'GRUPO' },
      editar: { perfil: false, grupo: null, individual: false, efetivo: false, origem: 'INDIVIDUAL' },
    } },
    { recurso: 'dashboard', rotulo: 'Dashboard', operacoes: { visualizar: { perfil: false, grupo: null, individual: null, efetivo: false, origem: 'PERFIL' } } },
  ],
  acoes: [
    { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', ativa: true, modo: 'ALTERNATIVA', exigeSst: false, regras: [], estado: 'PADRAO', concedidaPorDelegacao: false, efetivo: false, motivoNegado: 'NAO_CONCEDIDA', estadosPermitidos: ['PADRAO', 'BLOQUEADA', 'CONCEDIDA'] },
    { codigo: 'APROVAR_SOLICITACAO', nome: 'Aprovar solicitação', ativa: true, modo: 'OBRIGATORIA', exigeSst: true, regras: ['SST', 'AUTODECISAO_PROIBIDA'], estado: 'PADRAO', concedidaPorDelegacao: false, efetivo: false, motivoNegado: 'SEM_VINCULO_SST', estadosPermitidos: ['PADRAO', 'BLOQUEADA', 'CONCEDIDA'] },
    { codigo: 'REALIZAR_ENTREGA', nome: 'Realizar entrega', ativa: true, modo: 'NENHUMA', exigeSst: false, regras: [], estado: 'PADRAO', concedidaPorDelegacao: false, efetivo: true, motivoNegado: null, estadosPermitidos: ['PADRAO', 'BLOQUEADA'] },
  ],
  resumoIndividual: { recursos: 1, autorizacoes: 0, bloqueios: 0 },
};
const comPerm = (extra = {}) => ({ status: 200, corpo: { status: 'ok', permissoes: { ...PERM, ...extra } } });

const ACESSOS = {
  usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'USUARIO', ativo: true },
  podeAlterar: true,
  motivoSomenteLeitura: null,
  toggles: [
    { id: 'dashboard', rotulo: 'Dashboard', grupo: 'GERAL', ligado: false, fixo: false },
    { id: 'gestaoGhe', rotulo: 'Gestão de GHE', grupo: 'EPIS', ligado: true, fixo: false },
    { id: 'cadastrarProduto', rotulo: 'Cadastrar Produto', grupo: 'ESTOQUE', ligado: false, fixo: false },
    { id: 'gestaoUsuarios', rotulo: 'Gestão de Usuários', grupo: 'ADMINISTRACAO', ligado: false, fixo: false },
  ],
  pendencias: [{ id: 'relatorios', rotulo: 'Relatórios', situacao: 'SEM_ENFORCEMENT', motivo: 'sem rota' }],
};
const comAcessos = (extra = {}) => ({ status: 200, corpo: { status: 'ok', acessos: { ...ACESSOS, ...extra } } });

describe('Gestão de Usuários — Configurar permissões (ON/OFF)', () => {
  const PU = require('../js/permissoes-usuario');
  const abrirPerm = async (rotas = {}) => {
    const pg = await pronta({ rotas: { 'GET /administracao/usuarios/4/acessos': comAcessos(), 'GET /administracao/usuarios/4/permissoes': comPerm(), ...rotas } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="permissoes"]');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };
  const alternar = async (pg, acesso, ligado) => { const el = pg.consulta(`[data-acesso="${acesso}"]`)[0]; assert.ok(el, acesso); el.checked = ligado; await el.disparar('change'); await pg.esperar(); await pg.esperar(); };

  test('só interruptores ON/OFF, agrupados, com o que o servidor mandou: sem seletores, sem três estados, sem tabela técnica, sem pendência decorativa', async () => {
    const pg = await abrirPerm();
    assert.deepEqual(pg.consulta('[data-linha-acesso]').map((l) => l.getAttribute('data-linha-acesso')), ['dashboard', 'gestaoGhe', 'cadastrarProduto', 'gestaoUsuarios']);
    assert.deepEqual(pg.consulta('[data-grupo-acesso]').map((l) => l.getAttribute('data-grupo-acesso')), ['GERAL', 'COLABORADORES', 'EPIS', 'ESTOQUE', 'ADMINISTRACAO'].filter((g) => g !== 'COLABORADORES'));
    assert.equal(pg.consulta('#modal select').length, 0);
    assert.equal(pg.consulta('#modal table').length, 0);
    for (const proibido of ['Herdar', 'Permitir', 'Negar', 'Bloqueada', 'Concedida', 'Padrão', 'Relatórios']) assert.equal(pg.texto('modal').includes(proibido), false, proibido);
    assert.equal(pg.consulta('[data-acesso="gestaoGhe"]')[0].checked, true);
    assert.equal(pg.consulta('[data-acesso="dashboard"]')[0].checked, false);
    assert.ok(pg.texto('modal').includes('Permissões de Bruno Almoxarife'));
    const fonte = semComentarios(ler('js/permissoes-usuario.js'));
    for (const proibido of ['materials', 'dashboard', 'MOVIMENTAR_ESTOQUE', 'GERENCIAR_USUARIOS', 'employeeGroups', 'Herdar']) assert.equal(fonte.includes(proibido), false, `${proibido} não pode estar no módulo`);
    assert.equal(/innerHTML|localStorage|sessionStorage|perfil === 'MASTER'/.test(fonte), false);
  });

  test('alternar envia o PUT binário e o interruptor passa a mostrar o resultado efetivo devolvido pelo servidor', async () => {
    const pg = await abrirPerm({
      'PUT /administracao/usuarios/4/acessos/dashboard': { status: 200, corpo: { status: 'ok', acesso: { ...ACESSOS.toggles[0], ligado: true } } },
      'PUT /administracao/usuarios/4/acessos/gestaoGhe': { status: 200, corpo: { status: 'ok', acesso: { ...ACESSOS.toggles[1], ligado: false } } },
    });
    await alternar(pg, 'dashboard', true);
    const put = pg.chamadas.find((c) => c.metodo === 'PUT');
    assert.deepEqual([put.caminho, put.corpo], ['/administracao/usuarios/4/acessos/dashboard', { ligado: true }]);
    assert.equal(pg.consulta('[data-acesso="dashboard"]')[0].checked, true);
    assert.equal(pg.texto('hintPermissoes'), PU.TEXTOS.ALTERADO);
    await alternar(pg, 'gestaoGhe', false);
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'PUT').pop().corpo, { ligado: false });
    assert.equal(pg.consulta('[data-acesso="gestaoGhe"]')[0].checked, false);
    assert.equal(escritas(pg), 0, 'nada vai ao armazenamento do navegador');
  });

  test('somente leitura e Master: interruptores travados e aviso discreto; sem autoridade nada abre', async () => {
    const leitura = await abrirPerm({ 'GET /administracao/usuarios/4/acessos': comAcessos({ podeAlterar: false, motivoSomenteLeitura: 'SOMENTE_MASTER' }) });
    assert.ok(leitura.consulta('[data-acesso]').every((e) => e.getAttribute('disabled') !== null));
    assert.equal(leitura.texto('avisoSomenteLeitura'), PU.SOMENTE_LEITURA.SOMENTE_MASTER);
    const master = await abrirPerm({ 'GET /administracao/usuarios/4/acessos': comAcessos({ usuario: { ...ACESSOS.usuario, perfil: 'MASTER' }, podeAlterar: false, motivoSomenteLeitura: 'USUARIO_MASTER', toggles: ACESSOS.toggles.map((t) => ({ ...t, ligado: true, fixo: true })) }) });
    assert.ok(master.consulta('[data-acesso]').every((e) => e.getAttribute('disabled') !== null && e.checked === true));
    assert.equal(master.texto('avisoSomenteLeitura'), PU.SOMENTE_LEITURA.USUARIO_MASTER);
    const negado = await abrirPerm({ 'GET /administracao/usuarios/4/acessos': () => erro(403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA') });
    assert.equal(negado.visivel('overlay'), false);
    assert.equal(negado.texto('toast'), PU.TEXTOS.SEM_AUTORIDADE);
  });

  test('erro do servidor ao gravar relê o estado real e mostra o texto da tela, nunca o do servidor', async () => {
    const pg = await abrirPerm({ 'PUT /administracao/usuarios/4/acessos/dashboard': () => erro(409, 'USUARIO_MASTER_PERMISSOES_FIXAS') });
    const antes = pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho.endsWith('/acessos')).length;
    await alternar(pg, 'dashboard', true);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho.endsWith('/acessos')).length, antes + 1, 'releu os acessos');
    assert.equal(pg.texto('hintPermissoes'), PU.TEXTOS.MASTER_FIXO);
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false);
    assert.equal(pg.consulta('[data-acesso="dashboard"]')[0].checked, false, 'voltou ao estado real');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ETAPA G — Copiar permissões (POST /administracao/usuarios/:id/permissoes/copiar)
describe('Gestão de Usuários — vínculo SST (Vínculos operacionais) e permissões de decisão', () => {
  const PU = require('../js/permissoes-usuario');
  const DET = {
    id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'SUPERVISOR', ativo: true, cpf: '52998224725', matricula: 'ALM-004', setor: 'Almoxarifado',
    horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null, vinculoSst: false,
  };
  const novo = async ({ sst = true, rotas = {} } = {}) => {
    const pg = await pronta({ sst, rotas: { 'GET /grupos-acesso': GRUPOS, 'POST /administracao/usuarios': criado, ...rotas } });
    await clicar(pg, '[data-act="novoUsuario"]');
    await pg.esperar();
    return pg;
  };
  const edicao = async ({ sst = true, detalhe = DET, rotas = {} } = {}) => {
    const pg = await pronta({ sst, rotas: { 'GET /grupos-acesso': GRUPOS, 'GET /administracao/usuarios/4/edicao': { status: 200, corpo: { status: 'ok', usuario: detalhe } }, 'PATCH /administracao/usuarios/4': { status: 200, corpo: { status: 'ok', alterado: true } }, ...rotas } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="alterar"]');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };
  const salvarEdicao = async (pg) => { await clicar(pg, '#btnSalvarUser'); await pg.esperar(); await pg.esperar(); };
  const interruptor = (pg) => pg.consulta('#nu-vinculoSst')[0];
  const marcar = async (pg, ligado) => { const el = interruptor(pg); el.checked = ligado; await el.disparar('change'); };

  test('Novo Usuário: seção "Vínculos operacionais" com "Segurança do Trabalho (SST)", desligada por padrão e sem inferir nada do perfil', async () => {
    const pg = await novo();
    assert.ok(pg.texto('modal').includes('Vínculos operacionais'));
    assert.ok(pg.texto('modal').includes('Segurança do Trabalho (SST)'));
    assert.equal(interruptor(pg).checked, false);
    assert.equal(interruptor(pg).getAttribute('disabled'), null, 'o Master pode alterar');
    for (const tipo of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      pg.el('nu-tipoConta').value = tipo;
      await pg.el('nu-tipoConta').disparar('change');
      assert.equal(interruptor(pg).checked, false, `${tipo} não liga o SST`);
    }
  });

  test('Novo Usuário com SST OFF não envia o campo; com SST ON envia vinculoSst: true', async () => {
    const off = await novo();
    preencher(off, VALIDO);
    await salvar(off);
    assert.equal('vinculoSst' in envios(off)[0].corpo, false, 'padrão desligado: nada enviado');
    const on = await novo();
    preencher(on, VALIDO);
    await marcar(on, true);
    await salvar(on);
    assert.equal(envios(on)[0].corpo.vinculoSst, true);
  });

  test('quem não é o Master vê o vínculo travado, com o motivo, e o formulário nunca o envia', async () => {
    const pg = await novo({ sst: false });
    assert.notEqual(interruptor(pg).getAttribute('disabled'), null);
    assert.ok(pg.texto('modal').includes('Somente o Master altera este vínculo.'));
    preencher(pg, VALIDO);
    await salvar(pg);
    assert.equal('vinculoSst' in envios(pg)[0].corpo, false);
  });

  test('403 do vínculo mostra o texto próprio da tela (e o formulário continua aberto)', async () => {
    const pg = await novo({ rotas: { 'POST /administracao/usuarios': () => erro(403, 'SEM_AUTORIDADE_VINCULO_SST') } });
    preencher(pg, VALIDO);
    await marcar(pg, true);
    await salvar(pg);
    assert.ok(pg.texto('hintUser').includes('Somente o Master altera o vínculo com a Segurança do Trabalho. Nada foi salvo.'));
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false);
    assert.equal(pg.visivel('overlay'), true);
  });

  test('Alterar usuário: mostra o estado REAL; OFF → ON envia true; ON → OFF envia false; sem mudança não envia', async () => {
    const off = await edicao();
    assert.equal(interruptor(off).checked, false);
    await salvarEdicao(off);
    assert.equal('vinculoSst' in off.chamadas.find((c) => c.metodo === 'PATCH').corpo, false, 'sem mudança, sem campo');
    const paraOn = await edicao();
    await marcar(paraOn, true);
    await salvarEdicao(paraOn);
    assert.equal(paraOn.chamadas.find((c) => c.metodo === 'PATCH').corpo.vinculoSst, true);
    const on = await edicao({ detalhe: { ...DET, vinculoSst: true } });
    assert.equal(interruptor(on).checked, true, 'o estado atual vem do servidor');
    await marcar(on, false);
    await salvarEdicao(on);
    assert.equal(on.chamadas.find((c) => c.metodo === 'PATCH').corpo.vinculoSst, false);
  });

  test('Duplicar não copia o vínculo SST (nasce desligado)', async () => {
    const pg = await pronta({ sst: true, rotas: { 'GET /grupos-acesso': GRUPOS } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="duplicar"]');
    await pg.esperar();
    await pg.esperar();
    assert.equal(interruptor(pg).checked, false);
  });

  test('Configurar permissões: "Aprovar solicitações de EPI" e "Reprovar solicitações de EPI" são interruptores ON/OFF como os demais, com o aviso do vínculo', async () => {
    const acessos = {
      usuario: { id: 4, nome: 'Bruno Almoxarife', perfil: 'SUPERVISOR', ativo: true }, podeAlterar: true, motivoSomenteLeitura: null,
      toggles: [
        { id: 'aprovarSolicitacoes', rotulo: 'Aprovar solicitações de EPI', grupo: 'ADMINISTRACAO', ligado: true, fixo: false, exigeVinculoSst: true, vinculoSst: false },
        { id: 'reprovarSolicitacoes', rotulo: 'Reprovar solicitações de EPI', grupo: 'ADMINISTRACAO', ligado: false, fixo: false, exigeVinculoSst: true, vinculoSst: true },
      ],
      pendencias: [],
    };
    const pg = await pronta({ rotas: { 'GET /administracao/usuarios/4/acessos': { status: 200, corpo: { status: 'ok', acessos } }, 'PUT /administracao/usuarios/4/acessos/reprovarSolicitacoes': { status: 200, corpo: { status: 'ok', acesso: { ...acessos.toggles[1], ligado: true } } } } });
    await clicar(pg, '.kebab[data-menu="4"]');
    await clicar(pg, '#actionMenuInner [data-acao="permissoes"]');
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.consulta('#modal select').length, 0, 'sem Herdar/Permitir/Bloquear');
    assert.deepEqual(pg.consulta('[data-acesso]').map((e) => [e.getAttribute('data-acesso'), e.checked]), [['aprovarSolicitacoes', true], ['reprovarSolicitacoes', false]]);
    const avisos = pg.consulta('[data-aviso-sst]').map((e) => e.textContent);
    assert.ok(avisos[0].includes(PU.TEXTOS.FALTA_SST), 'ligado sem vínculo: avisa que falta o vínculo');
    assert.equal(avisos[1].includes(PU.TEXTOS.FALTA_SST), false);
    const el = pg.consulta('[data-acesso="reprovarSolicitacoes"]')[0];
    el.checked = true;
    await el.disparar('change');
    await pg.esperar();
    await pg.esperar();
    const put = pg.chamadas.find((c) => c.metodo === 'PUT');
    assert.deepEqual([put.caminho, put.corpo], ['/administracao/usuarios/4/acessos/reprovarSolicitacoes', { ligado: true }]);
  });
});

describe('Gestão de Usuários — Grupos: editar, inativar/reativar e permissões do grupo (ON/OFF)', () => {
  const PU = require('../js/permissoes-usuario');
  const G7 = { id: 7, nome: 'SST', descricao: 'Segurança do trabalho', ativo: true };
  const G8 = { id: 8, nome: 'Antigo', descricao: null, ativo: false };
  const ACESSOS_G = { grupo: { id: 7, nome: 'SST', ativo: true }, toggles: [
    { id: 'dashboard', rotulo: 'Dashboard', grupo: 'GERAL', ligado: false },
    { id: 'entradaLote', rotulo: 'Entrada por Lote', grupo: 'ESTOQUE', ligado: true },
  ] };
  const rotas = (extra = {}) => ({
    'GET /grupos-acesso': { status: 200, corpo: { status: 'ok', grupos: [G7, G8] } },
    'GET /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: G7 } },
    'GET /grupos-acesso/8': { status: 200, corpo: { status: 'ok', grupo: G8 } },
    'GET /grupos-acesso/7/acessos': { status: 200, corpo: { status: 'ok', acessos: ACESSOS_G } },
    ...extra,
  });
  const abrir = async (extra = {}) => {
    const pg = await pronta({ rotas: rotas(extra) });
    await clicar(pg, '[data-act="grupos"]');
    await pg.esperar();
    return pg;
  };
  const acao = async (pg, qual, id) => { await clicar(pg, `[data-grupo-acao="${qual}"][data-grupo-id="${id}"]`); await pg.esperar(); await pg.esperar(); };

  test('o botão Grupos lista os grupos reais (ativos e inativos) com Editar, Permissões e Inativar/Reativar; nada é gravado ao abrir', async () => {
    const pg = await abrir();
    assert.equal(pg.visivel('overlay'), true);
    assert.deepEqual(pg.consulta('[data-linha-grupo]').map((l) => l.getAttribute('data-linha-grupo')), ['7', '8']);
    assert.deepEqual(pg.consulta('[data-grupo-id="7"]').map((b) => b.getAttribute('data-grupo-acao')), ['editar', 'permissoes', 'inativar']);
    assert.deepEqual(pg.consulta('[data-grupo-id="8"]').map((b) => b.getAttribute('data-grupo-acao')), ['editar', 'permissoes', 'reativar']);
    assert.ok(pg.texto('listaGrupos').includes('Inativo') && pg.texto('listaGrupos').includes('Segurança do trabalho'));
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo !== 'GET'), []);
  });

  test('editar envia só o que mudou (PATCH), recarrega a lista e volta a ela; sem mudança nada é enviado', async () => {
    const pg = await abrir({ 'PATCH /grupos-acesso/7': { status: 200, corpo: { status: 'ok', grupo: { ...G7, nome: 'SST Fábrica' } } } });
    await acao(pg, 'editar', 7);
    assert.ok(pg.texto('modal').includes('Editar grupo'));
    assert.equal(pg.consulta('#ng-nome')[0].value, 'SST');
    await clicar(pg, '#btnSalvarGrupo');
    await pg.esperar();
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'PATCH'), [], 'sem mudança, sem PATCH');
    await acao(pg, 'editar', 7);
    pg.consulta('#ng-nome')[0].value = 'SST Fábrica';
    await clicar(pg, '#btnSalvarGrupo');
    await pg.esperar();
    await pg.esperar();
    const patch = pg.chamadas.find((c) => c.metodo === 'PATCH');
    assert.deepEqual([patch.caminho, patch.corpo], ['/grupos-acesso/7', { nome: 'SST Fábrica' }]);
    assert.equal(pg.texto('toast'), G.TEXTOS.GRUPO_EDITADO_OK);
    assert.equal(pg.consulta('[data-linha-grupo]').length, 2, 'voltou à lista');
    pg.consulta('#ng-nome').length && assert.fail('o formulário foi substituído pela lista');
  });

  test('editar: nome em uso e grupo inexistente mostram o texto da tela, nunca o do servidor', async () => {
    const pg = await abrir({ 'PATCH /grupos-acesso/7': () => erro(409, 'GRUPO_NOME_EM_USO') });
    await acao(pg, 'editar', 7);
    pg.consulta('#ng-nome')[0].value = 'Outro';
    await clicar(pg, '#btnSalvarGrupo');
    await pg.esperar();
    await pg.esperar();
    assert.ok(pg.texto('modal').includes(G.grupoForm.TEXTOS.NOME_EM_USO));
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false);
  });

  test('inativar pede confirmação e envia POST sem corpo; reativar age direto; a lista é recarregada com a mensagem', async () => {
    const pg = await abrir({
      'POST /grupos-acesso/7/inativar': { status: 200, corpo: { status: 'ok', grupo: { ...G7, ativo: false } } },
      'POST /grupos-acesso/8/reativar': { status: 200, corpo: { status: 'ok', grupo: { ...G8, ativo: true } } },
    });
    await acao(pg, 'inativar', 7);
    assert.ok(pg.texto('modal').includes('Inativar o grupo SST?'));
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'POST'), [], 'nada foi enviado antes de confirmar');
    await clicar(pg, '#btnConfirmar');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/grupos-acesso/7/inativar']);
    assert.equal(pg.texto('hintGrupos'), G.TEXTOS.GRUPO_INATIVADO_OK);
    await acao(pg, 'reativar', 8);
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/grupos-acesso/7/inativar', '/grupos-acesso/8/reativar']);
    assert.equal(pg.texto('hintGrupos'), G.TEXTOS.GRUPO_REATIVADO_OK);
  });

  test('permissões do grupo: interruptores ON/OFF (sem Herdar/Permitir/Bloquear), PUT binário e o estado devolvido pelo servidor', async () => {
    const pg = await abrir({ 'PUT /grupos-acesso/7/acessos/dashboard': { status: 200, corpo: { status: 'ok', acesso: { ...ACESSOS_G.toggles[0], ligado: true } } } });
    await acao(pg, 'permissoes', 7);
    assert.ok(pg.texto('modal').includes('Permissões do grupo SST'));
    assert.equal(pg.consulta('#modal select').length, 0);
    for (const proibido of ['Herdar', 'Permitir', 'Bloquear', 'Negar']) assert.equal(pg.texto('modal').includes(proibido), false, proibido);
    assert.ok(pg.consulta('#dicaGrupo').length === 1);
    assert.deepEqual(pg.consulta('[data-acesso]').map((e) => [e.getAttribute('data-acesso'), e.checked]), [['dashboard', false], ['entradaLote', true]]);
    const el = pg.consulta('[data-acesso="dashboard"]')[0];
    el.checked = true;
    await el.disparar('change');
    await pg.esperar();
    await pg.esperar();
    const put = pg.chamadas.find((c) => c.metodo === 'PUT');
    assert.deepEqual([put.caminho, put.corpo], ['/grupos-acesso/7/acessos/dashboard', { ligado: true }]);
    assert.equal(pg.consulta('[data-acesso="dashboard"]')[0].checked, true);
    assert.equal(pg.texto('hintPermissoes'), PU.TEXTOS.ALTERADO);
    assert.equal(escritas(pg), 0, 'nada vai ao armazenamento do navegador');
  });

  test('permissões do grupo: grupo próprio e erro de gravação mostram o texto da tela e releem o estado real', async () => {
    const pg = await abrir({ 'PUT /grupos-acesso/7/acessos/dashboard': () => erro(403, 'GRUPO_PERMISSAO_PROPRIO_GRUPO') });
    await acao(pg, 'permissoes', 7);
    const antes = pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho.endsWith('/acessos')).length;
    const el = pg.consulta('[data-acesso="dashboard"]')[0];
    el.checked = true;
    await el.disparar('change');
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho.endsWith('/acessos')).length, antes + 1);
    assert.equal(pg.texto('hintPermissoes'), PU.TEXTOS.GRUPO_PROPRIO);
    assert.equal(pg.consulta('[data-acesso="dashboard"]')[0].checked, false, 'voltou ao estado real');
  });

  test('Novo grupo continua funcionando e, aberto pela lista, volta a ela', async () => {
    const pg = await abrir({ 'POST /grupos-acesso': (c) => ({ status: 201, corpo: { status: 'ok', grupo: { id: 11, nome: c.corpo.nome, descricao: null, ativo: true } } }) });
    await clicar(pg, '[data-grupo-acao="novo"]');
    assert.ok(pg.texto('modal').includes('Novo grupo'));
    pg.consulta('#ng-nome')[0].value = 'RH';
    await clicar(pg, '#btnSalvarGrupo');
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.chamadas.filter((c) => c.chave === 'POST /grupos-acesso').length, 1);
    assert.equal(pg.consulta('[data-linha-grupo]').length, 2, 'voltou à lista');
  });
});

describe('Gestão de Usuários — Copiar permissões', () => {
  const PP = require('../js/permissoes-usuario');
  const COPIA = { status: 200, corpo: { status: 'ok', copia: { origemId: 4, destinoId: 2, grupo: { copiado: true, motivo: null }, individual: { executado: true, motivo: null, recursos: 1, bloqueios: 0, autorizacoes: 1, ignoradas: 0 } } } };
  const abrirCopia = async (rotas = {}, linha = 4) => {
    const pg = await pronta({ rotas: { 'GET /administracao/usuarios/4/permissoes': comPerm({ resumoIndividual: { recursos: 2, autorizacoes: 1, bloqueios: 3 } }), 'POST /administracao/usuarios/2/permissoes/copiar': COPIA, ...rotas } });
    await clicar(pg, `.kebab[data-menu="${linha}"]`);
    await clicar(pg, '#actionMenuInner [data-acao="copiar"]');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };
  const escolher = async (pg, id) => { pg.el('cp-destino').value = String(id); await pg.el('cp-destino').disparar('change'); };

  test('módulo: mensagens do resultado dizem o que ficou de fora; erros viram texto da tela', () => {
    assert.equal(PP.modelo.mensagemCopia({ grupo: { copiado: true }, individual: { executado: true } }), PP.TEXTOS.COPIA_OK);
    assert.ok(PP.modelo.mensagemCopia({ grupo: { copiado: false, motivo: 'GRUPO_INATIVO' }, individual: { executado: false, motivo: 'SOMENTE_MASTER' } }).includes('somente o Master as copia'));
    assert.equal(PP.modelo.erroCopia({ codigo: 'USUARIO_MASTER_PERMISSOES_FIXAS' }), PP.TEXTOS.COPIA_NAO_APLICA);
    assert.equal(PP.modelo.erroCopia({ status: 500 }), PP.TEXTOS.COPIA_FALHA);
  });

  test('abre com a origem fixa e o destino escolhido na lista real da empresa (sem a origem); resumo e confirmação só depois de escolher; o botão nasce desabilitado', async () => {
    const pg = await abrirCopia();
    assert.ok(pg.texto('modal').includes('Usuário de origem:') && pg.texto('modal').includes('Bruno Almoxarife'));
    assert.deepEqual(pg.consulta('#cp-destino option').map((o) => o.textContent), ['Selecione um usuário', 'Pessoa Master', 'Usuário Teste Senha Provisória', 'Ana Inativa (desabilitado)']);
    assert.equal(pg.el('btnCopiar').disabled, true);
    await escolher(pg, 2);
    assert.equal(pg.texto('cp-pergunta'), 'Copiar permissões de Bruno Almoxarife para Usuário Teste Senha Provisória?');
    assert.ok(pg.texto('cp-resumo').includes('O perfil e os dados pessoais de Usuário Teste Senha Provisória não serão alterados.'));
    assert.ok(pg.texto('cp-conteudo').includes('exceções de página: 2') && pg.texto('cp-conteudo').includes('funções concedidas: 1') && pg.texto('cp-conteudo').includes('bloqueios: 3'));
    assert.equal(pg.el('btnCopiar').disabled, false);
    assert.equal(pg.chamadas.filter((c) => c.metodo === 'POST').length, 0, 'nada é enviado antes de confirmar');
  });

  test('confirmar envia só a origem ao destino, fecha, avisa e recarrega a listagem; nada em localStorage', async () => {
    const pg = await abrirCopia();
    await escolher(pg, 2);
    const antes = listagens(pg).length;
    await clicar(pg, '#btnCopiar');
    await pg.esperar();
    await pg.esperar();
    const [envio] = pg.chamadas.filter((c) => c.metodo === 'POST');
    assert.deepEqual([envio.caminho, envio.corpo], ['/administracao/usuarios/2/permissoes/copiar', { origemId: 4 }]);
    assert.equal(pg.visivel('overlay'), false);
    assert.equal(pg.texto('toast'), PP.TEXTOS.COPIA_OK);
    assert.equal(listagens(pg).length, antes + 1);
    assert.equal(escritas(pg), 0);
  });

  test('erros do servidor ficam no modal com texto da tela; origem Master não abre o modal; sem autoridade para o resumo não bloqueia', async () => {
    const pg = await abrirCopia({ 'POST /administracao/usuarios/2/permissoes/copiar': () => erro(409, 'USUARIO_MASTER_PERMISSOES_FIXAS') });
    await escolher(pg, 2);
    await clicar(pg, '#btnCopiar');
    await pg.esperar();
    assert.equal(pg.visivel('overlay'), true);
    assert.equal(pg.texto('hintCopia'), PP.TEXTOS.COPIA_NAO_APLICA);
    assert.equal(pg.el('btnCopiar').disabled, false);
    assert.equal(pg.textoDoDom().includes('texto do servidor'), false);
    const master = await pronta({ rotas: {} });
    await clicar(master, '.kebab[data-menu="1"]');
    await clicar(master, '#actionMenuInner [data-acao="copiar"]');
    assert.equal(master.visivel('overlay'), false);
    assert.equal(master.texto('toast'), PP.TEXTOS.COPIA_NAO_APLICA);
    const semResumo = await abrirCopia({ 'GET /administracao/usuarios/4/permissoes': () => erro(403, 'USUARIO_PERFIL_NAO_PERMITIDO') });
    await escolher(semResumo, 2);
    assert.ok(semResumo.texto('cp-pergunta').startsWith('Copiar permissões de Bruno'));
    assert.equal(semResumo.el('btnCopiar').disabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Correções pós-validação: Alterar usuário por usuarios.id e MASTER único por empresa
describe('Gestão de Usuários — correções pós-validação', () => {
  // usuarios.id (40, 41) bem diferentes de qualquer identidade_id e da posição na lista.
  const LISTA = [
    usuario({ id: 7, nome: 'Master Real', email: 'master@validacao-epi.invalid', perfil: 'MASTER', perfilFixo: true, proprio: true }),
    usuario({ id: 40, nome: 'Carla Compras', email: 'carla@validacao-epi.invalid', perfil: 'SUPERVISOR', grupo: { nome: 'Almoxarifado', ativo: true } }),
    usuario({ id: 41, nome: 'Davi Depósito', email: 'davi@validacao-epi.invalid' }),
  ];
  const DET = (id, nome, email) => ({ id, nome, email, perfil: 'SUPERVISOR', ativo: true, cpf: '52998224725', matricula: `M-${id}`, setor: 'Compras', horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: 7 });
  const rotas = (extra = {}) => ({
    'GET /grupos-acesso': GRUPOS,
    'GET /administracao/usuarios': (c) => { const r = listagem(LISTA)(c); r.corpo.perfisGerenciaveis = ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']; r.corpo.perfisCadastraveis = ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']; return r; },
    ...extra,
  });
  const abrirLinha = async (pg, id, acao) => { await clicar(pg, `.kebab[data-menu="${id}"]`); await clicar(pg, `#actionMenuInner [data-acao="${acao}"]`); await pg.esperar(); await pg.esperar(); };

  test('Alterar usuário usa usuarios.id da linha em TODO o fluxo: menu, GET /edicao e PATCH; abre o modal com os dados DAQUELE usuário, sem "Usuário não encontrado"', async () => {
    const pg = await pronta({ lista: LISTA, rotas: rotas({
      'GET /administracao/usuarios/40/edicao': { status: 200, corpo: { status: 'ok', usuario: DET(40, 'Carla Compras', 'carla@validacao-epi.invalid') } },
      'PATCH /administracao/usuarios/40': { status: 200, corpo: { status: 'ok', alterado: true } },
    }) });
    assert.deepEqual(pg.consulta('.kebab').map((k) => k.getAttribute('data-menu')), ['7', '40', '41']);
    await abrirLinha(pg, 40, 'alterar');
    assert.deepEqual(pg.chamadas.filter((c) => c.caminho.endsWith('/edicao')).map((c) => c.caminho), ['/administracao/usuarios/40/edicao']);
    assert.equal(pg.existe('fUser'), true);
    assert.ok(pg.texto('modal').includes('Alterar usuário'));
    assert.deepEqual([pg.el('nu-nome').value, pg.el('nu-email').value, pg.el('nu-cpf').value, pg.el('nu-matricula').value], ['Carla Compras', 'carla@validacao-epi.invalid', '529.982.247-25', 'M-40']);
    assert.equal(/não encontrado/i.test(pg.texto('toast') + pg.textoDoDom().slice(0, 0)), false);
    pg.el('nu-setor').value = 'Logística';
    await clicar(pg, '#btnSalvarUser');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'PATCH').map((c) => c.caminho), ['/administracao/usuarios/40']);
  });

  test('404 só é "usuário não encontrado" quando o servidor diz; rota inexistente (servidor desatualizado) tem texto próprio', async () => {
    const pg = await pronta({ lista: LISTA, rotas: rotas({ 'GET /administracao/usuarios/40/edicao': () => erro(404, 'ROTA_NAO_ENCONTRADA') }) });
    await abrirLinha(pg, 40, 'alterar');
    assert.equal(pg.existe('fUser'), false);
    assert.equal(pg.texto('toast'), G.TEXTOS.INDISPONIVEL);
    const real = await pronta({ lista: LISTA, rotas: rotas({ 'GET /administracao/usuarios/40/edicao': () => erro(404, 'USUARIO_NAO_ENCONTRADO') }) });
    await abrirLinha(real, 40, 'alterar');
    assert.equal(real.texto('toast'), G.TEXTOS.NAO_ENCONTRADO);
    assert.equal(G.situacao.erro({ status: 404, codigo: 'QUALQUER' }), G.TEXTOS.ACAO_FALHA);
  });

  test('Master único na tela: Novo e Duplicar nunca oferecem Master (nem desabilitado); Alterar um usuário comum também não; o Master existente fica com perfil travado, sem Duplicar', async () => {
    const pg = await pronta({ lista: LISTA, rotas: rotas() });
    await clicar(pg, '[data-act="novoUsuario"]');
    await pg.esperar();
    assert.deepEqual(pg.consulta('#nu-tipoConta option').map((o) => o.textContent), ['Selecione', 'Administrador', 'Supervisor', 'Usuário']);
    assert.equal(pg.consulta('#nu-tipoConta option').some((o) => o.hasAttribute('disabled')), false);
    await clicar(pg, '#modal [data-close]');

    await clicar(pg, '.kebab[data-menu="40"]');
    await clicar(pg, '#actionMenuInner [data-acao="duplicar"]');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(pg.consulta('#nu-tipoConta option').map((o) => o.textContent), ['Selecione', 'Administrador', 'Supervisor', 'Usuário']);
    assert.equal(pg.el('nu-tipoConta').value, 'SUPERVISOR');
    await clicar(pg, '#modal [data-close]');

    await clicar(pg, '.kebab[data-menu="7"]');
    assert.deepEqual(pg.consulta('#actionMenuInner [data-acao]').map((b) => b.getAttribute('data-acao')), ['alterar', 'permissoes', 'copiar', 'senha', 'desabilitar'], 'Master não é modelo: sem Duplicar');
  });

  test('Alterar o Master existente: só o perfil Master, travado; Grupo "Não se aplica"; o PATCH não envia tipoConta; um usuário comum não ganha Master', async () => {
    const master = { ...DET(7, 'Master Real', 'master@validacao-epi.invalid'), perfil: 'MASTER', grupoAcessoId: null };
    const pg = await pronta({ lista: LISTA, rotas: rotas({
      'GET /administracao/usuarios/7/edicao': { status: 200, corpo: { status: 'ok', usuario: master } },
      'PATCH /administracao/usuarios/7': { status: 200, corpo: { status: 'ok', alterado: true } },
    }) });
    await abrirLinha(pg, 7, 'alterar');
    assert.deepEqual(pg.consulta('#nu-tipoConta option').map((o) => o.textContent), ['Selecione', 'Master']);
    assert.deepEqual([pg.el('nu-tipoConta').value, pg.el('nu-tipoConta').disabled, pg.el('nu-grupoAcessoId').disabled], ['MASTER', true, true]);
    pg.el('nu-setor').value = 'Diretoria';
    await clicar(pg, '#btnSalvarUser');
    await pg.esperar();
    await pg.esperar();
    const corpo = pg.chamadas.find((c) => c.metodo === 'PATCH').corpo;
    assert.equal('tipoConta' in corpo, false);
    assert.equal(corpo.grupoAcessoId, null);

    const comum = await pronta({ lista: LISTA, rotas: rotas({ 'GET /administracao/usuarios/41/edicao': { status: 200, corpo: { status: 'ok', usuario: { ...DET(41, 'Davi Depósito', 'davi@validacao-epi.invalid'), perfil: 'USUARIO' } } } }) });
    await abrirLinha(comum, 41, 'alterar');
    assert.equal(comum.consulta('#nu-tipoConta option').some((o) => o.textContent === 'Master'), false);
    assert.equal(comum.el('nu-tipoConta').disabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Centralização dos modais na ÁREA DE CONTEÚDO (não na janela inteira com a sidebar)
describe('Gestão de Usuários — modais centralizados na área de conteúdo', () => {
  const rotasModais = {
    'GET /grupos-acesso': GRUPOS,
    'GET /administracao/usuarios/4/edicao': { status: 200, corpo: { status: 'ok', usuario: { id: 4, nome: 'Bruno Almoxarife', email: 'bruno@validacao-epi.invalid', perfil: 'SUPERVISOR', ativo: true, cpf: '52998224725', matricula: 'M', setor: 'S', horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null } } },
    'GET /administracao/usuarios/4/permissoes': { status: 200, corpo: { status: 'ok', permissoes: { ...PERM } } },
    'GET /administracao/usuarios/4/acessos': comAcessos(),
  };
  const area = (pg, left) => { pg.consulta('main.content')[0].getBoundingClientRect = () => ({ left, width: 1000, top: 0, right: left + 1000, bottom: 0 }); };
  const esquerda = (pg) => pg.el('overlay').style.left;

  test('todos os modais da página começam onde a área principal começa (260px no desktop) e se ajustam ao redimensionar; sem sidebar (responsivo) ficam em 0', async () => {
    const pg = await pronta({ rotas: rotasModais });
    area(pg, 260);
    const abrir = {
      'Novo Usuário': async () => clicar(pg, '[data-act="novoUsuario"]'),
      'Novo Grupo': async () => clicar(pg, '[data-act="novoGrupo"]'),
      'Guia rápido': async () => clicar(pg, '[data-act="guia"]'),
      Exportar: async () => clicar(pg, '[data-act="exportar"]'),
      Alterar: async () => { await clicar(pg, '.kebab[data-menu="4"]'); await clicar(pg, '#actionMenuInner [data-acao="alterar"]'); await pg.esperar(); },
      Duplicar: async () => { await clicar(pg, '.kebab[data-menu="4"]'); await clicar(pg, '#actionMenuInner [data-acao="duplicar"]'); await pg.esperar(); },
      Senha: async () => { await clicar(pg, '.kebab[data-menu="4"]'); await clicar(pg, '#actionMenuInner [data-acao="senha"]'); },
      Permissões: async () => { await clicar(pg, '.kebab[data-menu="4"]'); await clicar(pg, '#actionMenuInner [data-acao="permissoes"]'); await pg.esperar(); },
      Copiar: async () => { await clicar(pg, '.kebab[data-menu="4"]'); await clicar(pg, '#actionMenuInner [data-acao="copiar"]'); await pg.esperar(); },
      'Confirmar desabilitar': async () => { await clicar(pg, '.kebab[data-menu="2"]'); await clicar(pg, '#actionMenuInner [data-acao="desabilitar"]'); },
    };
    for (const [nome, fn] of Object.entries(abrir)) {
      pg.el('overlay').style.left = '';
      await fn();
      await pg.esperar();
      assert.equal(pg.el('overlay').classList.contains('open'), true, `${nome}: abriu`);
      assert.equal(esquerda(pg), '260px', `${nome}: centraliza na área de conteúdo`);
      await clicar(pg, '#modal [data-close]');
    }
    area(pg, 0);
    await clicar(pg, '[data-act="guia"]');
    assert.equal(esquerda(pg), '0px', 'sem sidebar fixa o modal usa a largura toda');
    assert.ok(pg.ouvintesDaJanela('resize') >= 2, 'o ajuste também roda ao redimensionar a janela');
  });

  test('não redesenha: largura (.modal, .modal.sm), formulários e a regra do overlay seguem os do HTML aprovado; só o left é ajustado', () => {
    const html = ler(ARQUIVO);
    assert.ok(html.includes('.gu .overlay{position:fixed;inset:0;'), 'overlay continua fixed inset:0 (o left vem do layout real)');
    assert.ok(html.includes('.gu .modal{') && html.includes('width:min(1100px,100%)') && html.includes('.gu .modal.sm{width:min(480px,100%)}'));
    const embutido = semComentarios(html.slice(html.lastIndexOf('<script>')));
    assert.match(embutido, /main\.content/);
    assert.equal(/\b260\b/.test(embutido), false, 'nenhum valor fixo de largura da sidebar: lê o layout real');
  });
});
