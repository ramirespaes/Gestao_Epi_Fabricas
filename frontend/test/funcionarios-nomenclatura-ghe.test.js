'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Incremento final da página (RED): (1) na TABELA a coluna GHE mostra só o código devolvido pela API (os seletores de
 * cadastro e edição continuam com código + descrição, e a busca continua alcançando a descrição); (2) nomenclatura VISUAL
 * "Cadastro de Colaboradores" nos pontos integrados (menu lateral das páginas, Início do Portal, título e cabeçalho da
 * página, textos da entidade), sem renomear nenhum identificador interno.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const ARQUIVO = 'pages/funcionarios.html';
const P = require('../js/permissoes-efetivas');
const G = require('../js/gestao-funcionarios');

const GHES = [
  { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' },
  { id: 20, codigo: 'GHE 29', descricao: 'Soldagem' },
  { id: 30, codigo: null, descricao: 'Legado sem código' },
];
const funcionario = (extra = {}) => ({
  id: 1, empresaId: 3, matricula: 'MAT-000171', nome: 'Mauro Teste', cpfMascarado: '***.***.***-45', setor: 'Manutenção', funcao: 'Mecânico',
  telefone: '47991110001', dataNascimento: '1990-03-15', dataAdmissao: '2025-03-10', cracha: null, situacao: 'ATIVO', ativo: true,
  grupoHomogeneoId: 10, grupoHomogeneo: GHES[0], ...extra,
});
const LISTA = [
  funcionario(),
  funcionario({ id: 2, nome: 'Ana Souza', matricula: 'MAT-000098', cpfMascarado: '***.***.***-67', grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }),
  funcionario({ id: 3, nome: 'Zeca Legado', matricula: null, cpfMascarado: '***.***.***-78', grupoHomogeneoId: null, grupoHomogeneo: null }),
  funcionario({ id: 4, nome: 'Rita Antiga', matricula: 'MAT-000004', cpfMascarado: '***.***.***-11', grupoHomogeneoId: 30, grupoHomogeneo: GHES[2] }),
];
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ c = true, e = true } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true, criar: c, editar: e } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
async function abrir(opcoes = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(opcoes) },
      'GET /funcionarios': (chamada) => {
        const q = new URL(chamada.url).searchParams;
        const pagina = Number(q.get('pagina')) || 1;
        const limite = Number(q.get('limite')) || 20;
        return { status: 200, corpo: { status: 'ok', funcionarios: LISTA.slice((pagina - 1) * limite, pagina * limite), total: LISTA.length, pagina, limite } };
      },
      'GET /funcionarios/ghes': { status: 200, corpo: { status: 'ok', ghes: GHES.filter((g) => g.codigo !== null) } },
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const linhas = (pg) => pg.consulta('#tbody tr').filter((tr) => tr.children.length === 7).map((tr) => tr.children.map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
const linha = (pg, nome) => linhas(pg).find((l) => l[0] === nome);
const botao = (pg, texto) => pg.consulta('button').find((b) => b.textContent.includes(texto)) ?? null;
async function clicar(pg, b) { assert.ok(b, 'botão não encontrado'); await b.disparar('click'); await pg.esperar(); }
const opcoesDoGhe = (pg) => pg.consulta('#fGhe option').map((o) => [o.getAttribute('value'), o.textContent.trim()]);
async function digitar(pg, id, valor) { pg.el(id).value = valor; await pg.el(id).disparar('input'); await pg.el(id).disparar('change'); }
const conteudo = (pg) => pg.consulta('main.content')[0].textContent;

describe('tabela: coluna GHE mostra só o código da API', () => {
  test('o código vem exatamente como a API devolveu (GHE-010, GHE 29), sem descrição; sem GHE continua "—"', async () => {
    const pg = await abrir();
    assert.equal(linha(pg, 'Mauro Teste')[4], 'GHE-010');
    assert.equal(linha(pg, 'Ana Souza')[4], 'GHE 29');
    assert.equal(linha(pg, 'Zeca Legado')[4], '—');
    const celulasGhe = pg.consulta('#tbody tr').map((tr) => tr.children[4]?.textContent ?? '');
    assert.equal(celulasGhe.some((t) => /Caldeiraria|Soldagem/.test(t)), false, 'a descrição não aparece na célula');
  });

  test('a pílula do GHE contém só o código (sem travessão nem descrição), para não quebrar em duas linhas', async () => {
    const pg = await abrir();
    const pilulas = pg.consulta('#tbody .badge').filter((b) => !/situacao-/.test(b.getAttribute('class') || ''));
    assert.ok(pilulas.length >= 2);
    // GHE com código: só o código; o travessão "código — descrição" nunca aparece na tabela (o legado sem código é o caso seguinte).
    for (const p of pilulas) assert.doesNotMatch(p.textContent, /—|Caldeiraria|Soldagem/);
    // Linhas em ordem alfabética (Ana Souza antes de Mauro Teste).
    assert.deepEqual(pilulas.map((p) => p.textContent.trim()).filter((t) => /^GHE/.test(t)), ['GHE 29', 'GHE-010']);
  });

  test('GHE legado sem código (decisão de produto): a célula mostra "—", nunca a descrição nem um código inventado', async () => {
    const pg = await abrir();
    assert.equal(linha(pg, 'Rita Antiga')[4], '—');
    assert.equal(/Legado sem código/.test(pg.consulta('#tbody')[0].textContent), false, 'a descrição não vai para a tabela');
    assert.equal(/GHE-?0*30|GHE 30/.test(conteudo(pg)), false, 'nenhum código reconstruído a partir do id');
    assert.equal(pg.consulta('#tbody .badge').filter((b) => !/situacao-/.test(b.getAttribute('class') || '')).length, 2, 'só os GHEs com código viram pílula');
  });

  test('os seletores de cadastro e de edição continuam com código + descrição', async () => {
    const pg = await abrir();
    await clicar(pg, botao(pg, 'Novo colaborador'));
    assert.deepEqual(opcoesDoGhe(pg).slice(1), [['10', 'GHE-010 — Caldeiraria'], ['20', 'GHE 29 — Soldagem']]);
    await clicar(pg, pg.el('btnCancelar'));
    const editar = pg.consulta('#tbody tr').find((tr) => tr.children[0].textContent.trim() === 'Rita Antiga').querySelectorAll('button').find((b) => /Editar/.test(b.textContent));
    await clicar(pg, editar);
    const opcoes = opcoesDoGhe(pg);
    assert.ok(opcoes.some(([v, t]) => v === '10' && t === 'GHE-010 — Caldeiraria'));
    assert.ok(opcoes.some(([v, t]) => v === '30' && t === 'Legado sem código'), 'o GHE atual sem código continua selecionável, pela descrição');
    assert.equal(pg.el('fGhe').value, '30');
  });

  test('a busca continua alcançando código e descrição do GHE, mesmo com a tabela mostrando só o código', async () => {
    const pg = await abrir();
    await digitar(pg, 'q', 'caldeiraria');
    assert.deepEqual(linhas(pg).map((l) => l[0]), ['Mauro Teste']);
    await digitar(pg, 'q', 'soldagem');
    assert.deepEqual(linhas(pg).map((l) => l[0]), ['Ana Souza']);
    await digitar(pg, 'q', 'GHE 29');
    assert.deepEqual(linhas(pg).map((l) => l[0]), ['Ana Souza']);
    await digitar(pg, 'q', 'legado sem');
    assert.deepEqual(linhas(pg).map((l) => l[0]), ['Rita Antiga']);
  });
});

describe('nomenclatura visual: Cadastro de Colaboradores', () => {
  const COM_MENU = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && /data-pagina="userAdmin"/.test(ler(`pages/${f}`))).sort();
  const LINK = '<a href="funcionarios.html" data-pagina="funcionarios" style="display:none"><div class="nav-icon teal">people</div>Cadastro de Colaboradores</a>';
  const LINK_ATIVO = '<a class="active" href="javascript:void(0)" data-pagina="funcionarios" style="display:none"><div class="nav-icon teal">people</div>Cadastro de Colaboradores</a>';

  test('menu lateral de todas as páginas integradas (inclusive o menu do celular, que é a mesma barra): o item chama "Cadastro de Colaboradores"', () => {
    assert.equal(COM_MENU.length, 17);
    for (const arquivo of COM_MENU) {
      const html = ler(`pages/${arquivo}`);
      assert.ok(html.includes(arquivo === 'funcionarios.html' ? LINK_ATIVO : LINK), arquivo);
      assert.equal(/people<\/div>Funcionários<\/a>/.test(html), false, `${arquivo}: rótulo antigo`);
      assert.match(html, /history<\/div>Histórico de Funcionários<\/a>/, `${arquivo}: o Histórico não muda`);
      assert.match(html, /upload_file<\/div>Importar Funcionários<\/a>/, `${arquivo}: a Importação não muda`);
    }
  });

  test('Início do Portal: a entrada chama "Cadastro de Colaboradores" e aponta para a mesma página', () => {
    const inicio = ler('portal/inicio.html');
    assert.ok(inicio.includes('<a href="../pages/funcionarios.html" data-pagina="funcionarios" style="display:none">Cadastro de Colaboradores</a>'));
    assert.equal(inicio.split('data-pagina="funcionarios"').length - 1, 1);
    assert.ok(inicio.includes('data-pagina="employeeHistory" style="display:none">Histórico de funcionários</a>'));
  });

  test('título, cabeçalho, botão e modais da página usam a nomenclatura nova', async () => {
    const html = semComentarios(ler(ARQUIVO));
    assert.match(html, /<title>Cadastro de Colaboradores — Gestão de EPIs<\/title>/);
    assert.match(html, /<h1>Cadastro de Colaboradores<\/h1>/);
    assert.match(html, /colaboradores/i);
    const pg = await abrir();
    assert.ok(botao(pg, 'Novo colaborador'));
    assert.equal(botao(pg, 'Novo funcionário'), null);
    assert.equal(pg.texto('count').trim(), '4 de 4 colaboradores');
    await clicar(pg, botao(pg, 'Novo colaborador'));
    assert.equal(pg.texto('mTitle').trim(), 'Novo colaborador');
    await clicar(pg, pg.el('btnCancelar'));
    const tr = pg.consulta('#tbody tr').find((x) => x.children[0].textContent.trim() === 'Mauro Teste');
    await clicar(pg, tr.querySelectorAll('button').find((b) => /Editar/.test(b.textContent)));
    assert.equal(pg.texto('mTitle').trim(), 'Editar colaborador');
    await clicar(pg, pg.el('btnCancelar'));
    await clicar(pg, tr.querySelectorAll('button').find((b) => /Afastar/.test(b.textContent)));
    assert.equal(pg.texto('cConfirmar').trim(), 'Afastar colaborador');
    assert.equal(/funcion[aá]ri/i.test(conteudo(pg)), false, 'nenhum "funcionário" visível na área da página (o menu lateral fica fora)');
  });

  test('textos do módulo (vazio, carregando, contagem, erros) falam de colaborador; nenhuma string visível do módulo diz "funcionário"', () => {
    assert.equal(G.TEXTOS.VAZIO, 'Nenhum colaborador encontrado.');
    assert.equal(G.visao.contagem(1, 1), '1 de 1 colaborador');
    assert.equal(G.visao.contagem(0, 2), '0 de 2 colaboradores');
    // Só literais de texto (entre aspas simples): identificadores como '/funcionarios' e 'gestao-funcionarios.js' não são texto visível.
    assert.doesNotMatch(ler('js/gestao-funcionarios.js'), /'[^'\n]*funcionári[^'\n]*'/i);
  });

  test('só nomenclatura: arquivos, chave da página, permissões, rotas e recursos continuam os mesmos; gestaoColaboradores não é tocado', () => {
    assert.ok(fs.existsSync(path.join(RAIZ, 'pages/funcionarios.html')));
    assert.ok(fs.existsSync(path.join(RAIZ, 'js/gestao-funcionarios.js')));
    assert.deepEqual(P.PAGINAS.funcionarios, { abrir: [{ recurso: 'employeeHistory', operacao: 'visualizar' }], alterar: [{ recurso: 'employeeHistory', operacao: 'editar' }] });
    const modulo = semComentarios(ler('js/gestao-funcionarios.js'));
    assert.match(modulo, /var CAMINHO = '\/funcionarios';/);
    assert.match(modulo, /'employeeHistory'/);
    assert.equal(/gestaoColaboradores/.test(modulo + ler(ARQUIVO) + ler('portal/inicio.html')), false);
    assert.match(ler(ARQUIVO), /pagina: 'funcionarios'/);
    assert.match(ler(ARQUIVO), /<script src="\.\.\/js\/gestao-funcionarios\.js"><\/script>/);
  });
});
