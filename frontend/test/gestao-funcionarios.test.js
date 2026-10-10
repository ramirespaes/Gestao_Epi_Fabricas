'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

/**
 * Gestão de Funcionários — frontend operacional (RED).
 *
 * Alvo visual: o protótipo aprovado `funcionarios.html` (Desktop/Downloads; 4 cópias idênticas, SHA-256 d052e4569a76…). A página
 * nova mantém a mesma estrutura (cabeçalho, busca, tabela, modal, toasts) e os mesmos ids (#q, #tbody, #count, #overlay, #fNome,
 * #fCpf, #fMatricula, #fSetor, #fCargo, #fGhe, #fTelefone, #fNascimento, #fContratacao, #e<Campo>) e textos ("Novo colaborador",
 * "Editar", "Salvar", "Cancelar"). Onde o CONTRATO APROVADO difere do protótipo, o contrato vale:
 *   tabela Nome | Matrícula | Setor | Cargo | GHE | Situação | Ação (sem Telefone); busca sem CPF; obrigatórios nome, CPF, setor,
 *   cargo, GHE e data de contratação (matrícula, telefone e nascimento opcionais); CPF mascarado e imutável na edição; GHE da API
 *   (/funcionarios/ghes); situação só pelas rotas específicas; dados da API (nada de localStorage nem SEED).
 *
 * Decisões do responsável aplicadas (revisão do RED): GHE é um SELECT alimentado por /funcionarios/ghes que envia o id; as mudanças de
 * situação pedem confirmação (padrão visual existente: caixa de confirmação com o nome da pessoa); a busca é local sobre o conjunto
 * carregado pela paginação real da API; o PATCH é validado pelo que PODE e NÃO PODE ir no corpo (não por "só o campo alterado");
 * erros do servidor aparecem pelo mecanismo existente (campo quando a identificação é inequívoca, toast nos demais) e não se exige
 * campo específico; sem menu nem barra lateral neste incremento. Os botões de linha são achados pelo TEXTO (Editar, Afastar, Ativar,
 * Inativar). Toda falha daqui é de comportamento ausente: a página ainda não existe.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/funcionarios.html';
const MODULO = path.join(RAIZ, 'js', 'gestao-funcionarios.js');
const PROTOTIPO_SHA = 'd052e4569a76';

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ v = true, c = false, e = false } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
    recursos: { employeeHistory: { ...NENHUMA, visualizar: v, criar: c, editar: e } }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const GHES = [{ id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' }, { id: 20, codigo: 'GHE-020', descricao: 'Soldagem' }];
const funcionario = (extra = {}) => ({
  id: 1, empresaId: 3, matricula: 'MAT-000171', nome: 'Mauro Teste', cpfMascarado: '***.***.***-45', setor: 'Manutenção', funcao: 'Mecânico',
  telefone: '47991110001', dataNascimento: '1990-03-15', dataAdmissao: '2025-03-10', cracha: null, situacao: 'ATIVO', ativo: true,
  grupoHomogeneoId: 10, grupoHomogeneo: GHES[0], ...extra,
});
const FUNCIONARIOS = [
  funcionario({ id: 3, matricula: 'MAT-000098', nome: 'Ana Souza', cpfMascarado: '***.***.***-67', setor: 'Produção', funcao: 'Operadora', telefone: null, dataNascimento: null, dataAdmissao: '2024-08-05', situacao: 'INATIVO', ativo: false, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }),
  funcionario({ id: 2, matricula: 'MAT-000121', nome: 'João Pereira', cpfMascarado: '***.***.***-56', setor: 'Produção', funcao: 'Operador', telefone: '47991110002', dataNascimento: '1988-07-22', dataAdmissao: '2025-03-11', situacao: 'AFASTADO', ativo: false, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }),
  funcionario(),
  funcionario({ id: 4, matricula: null, nome: 'Zeca Legado', cpfMascarado: '***.***.***-78', setor: 'Almoxarifado', funcao: 'Auxiliar', telefone: null, dataNascimento: null, dataAdmissao: null, grupoHomogeneoId: null, grupoHomogeneo: null }),
];

function listagem(lista) {
  return (chamada) => {
    const q = new URL(chamada.url).searchParams;
    const pagina = Number(q.get('pagina')) || 1;
    const limite = Number(q.get('limite')) || 20;
    const itens = lista().slice((pagina - 1) * limite, pagina * limite);
    return { status: 200, corpo: { status: 'ok', funcionarios: itens, total: lista().length, pagina, limite } };
  };
}
function mundo({ v = true, c = false, e = false, lista = FUNCIONARIOS, rotas = {} } = {}) {
  const estado = { lista: lista.map((x) => ({ ...x })) };
  return {
    estado,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ v, c, e }) },
      'GET /funcionarios': listagem(() => estado.lista),
      'GET /funcionarios/ghes': { status: 200, corpo: { status: 'ok', ghes: GHES } },
      ...rotas,
    },
  };
}
async function pronta(opcoes = {}) {
  const m = mundo(opcoes);
  const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
  await pg.esperar();
  await pg.esperar();
  return Object.assign(pg, { estado: m.estado });
}

// ── helpers de tela ────────────────────────────────────────────────
const botoes = (pg) => pg.consulta('button');
const botaoPorTexto = (pg, texto, dentro) => (dentro ?? pg.documento).querySelectorAll('button').find((b) => b.textContent.includes(texto)) ?? null;
const linhas = (pg) => pg.consulta('#tbody tr');
const celulas = (tr) => tr.children.map((td) => td.textContent.replace(/\s+/g, ' ').trim());
const tabela = (pg) => linhas(pg).map(celulas);
const linhaDe = (pg, nome) => linhas(pg).find((tr) => tr.children[0] && tr.children[0].textContent.trim() === nome) ?? null;
const acoesDaLinha = (pg, nome) => {
  const tr = linhaDe(pg, nome);
  assert.ok(tr, `linha de ${nome} não encontrada`);
  const textos = tr.querySelectorAll('button').map((b) => b.textContent.trim());
  return ['Editar', 'Afastar', 'Ativar', 'Inativar'].filter((acao) => textos.some((x) => x.endsWith(acao)));
};
async function clicarBotao(pg, texto, dentro) {
  const b = botaoPorTexto(pg, texto, dentro);
  assert.ok(b, `botão "${texto}" não encontrado`);
  await b.disparar('click');
  await pg.esperar();
}
async function acionarNaLinha(pg, nome, texto) {
  const tr = linhaDe(pg, nome);
  assert.ok(tr, `linha de ${nome}`);
  const b = tr.querySelectorAll('button').find((x) => x.textContent.trim().endsWith(texto));
  assert.ok(b, `botão ${texto} na linha de ${nome}`);
  await b.disparar('click');
  await pg.esperar();
  if (texto === 'Editar') return;
  const caixa = confirmacaoVisivel(pg);
  assert.ok(caixa, `a ação "${texto}" deveria pedir confirmação`);
  const { confirmar } = botoesDaConfirmacao(caixa);
  assert.ok(confirmar, 'a confirmação precisa de um botão para confirmar');
  await confirmar.disparar('click');
  await pg.esperar();
}
async function digitarEm(pg, id, valor) {
  const campo = pg.el(id);
  campo.value = String(valor);
  await campo.disparar('input');
  await campo.disparar('change');
}
// GHE é um <select> com os GHEs da API: o valor de cada opção é o id; o texto traz código e descrição.
async function escolherGhe(pg, ghe) {
  const campo = pg.el('fGhe');
  assert.equal(campo.localName, 'select', 'o GHE é um seletor, sem texto livre');
  const op = pg.consulta('#fGhe option').find((o) => o.getAttribute('value') === String(ghe.id));
  assert.ok(op, `GHE ${ghe.id} não está entre as opções do seletor`);
  campo.value = String(ghe.id);
  await campo.disparar('change');
}
function gheMostrado(pg) {
  const campo = pg.el('fGhe');
  assert.equal(campo.localName, 'select', 'o GHE é um seletor');
  const op = pg.consulta('#fGhe option').find((o) => o.getAttribute('value') === campo.value);
  return op ? op.textContent : '';
}
async function abrirNovo(pg) {
  await clicarBotao(pg, 'Novo colaborador');
  assert.equal(pg.visivel('overlay'), true, 'o modal de cadastro deveria abrir');
}
async function abrirEdicao(pg, nome) {
  await acionarNaLinha(pg, nome, 'Editar');
  assert.equal(pg.visivel('overlay'), true, 'o modal de edição deveria abrir');
}
async function preencherCadastro(pg, extra = {}) {
  const v = {
    fNome: 'Fulano de Tal', fCpf: '529.982.247-25', fSetor: 'Manutenção', fCargo: 'Mecânico', fContratacao: '2026-01-15', ...extra,
  };
  for (const [id, valor] of Object.entries(v)) if (id !== 'ghe') await digitarEm(pg, id, valor);
  await escolherGhe(pg, extra.ghe ?? GHES[0]);
}
const salvar = (pg) => clicarBotao(pg, 'Salvar');
const chamadasDe = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
const erros = (pg) => pg.consulta('.err').map((e) => e.textContent.trim()).filter(Boolean);
// Mensagens que a tela mostra ao usuário (erros de campo + avisos/toasts): sem rótulos nem textos fixos da página.
const mensagens = (pg) => [...erros(pg), pg.texto('toasts').trim()].filter(Boolean).join(' | ');
const PATCH_PERMITIDOS = ['nome', 'matricula', 'setor', 'funcao', 'grupoHomogeneoId', 'dataAdmissao', 'dataNascimento', 'telefone'];
const PATCH_PROIBIDOS = ['cpf', 'situacao', 'ativo', 'empresaId', 'id', 'usuarioId', 'cracha'];
// Contrato do PATCH: só campos editáveis aceitos pela API; nunca CPF, situação, ativo nem identificadores; GHE nunca nulo.
function payloadPatchValido(corpo) {
  assert.ok(corpo && typeof corpo === 'object', 'PATCH sem corpo');
  for (const chave of Object.keys(corpo)) {
    assert.equal(PATCH_PROIBIDOS.includes(chave), false, `campo proibido no PATCH: ${chave}`);
    assert.ok(PATCH_PERMITIDOS.includes(chave), `campo fora do contrato no PATCH: ${chave}`);
  }
  if (Object.hasOwn(corpo, 'grupoHomogeneoId')) assert.ok(Number.isInteger(corpo.grupoHomogeneoId) && corpo.grupoHomogeneoId > 0, 'GHE nunca nulo: só o id de um GHE da API');
  return corpo;
}
const confirmacaoVisivel = (pg) => pg.consulta('*').find((n) => n.nodeType === 1 && ((n.id && /confirma/i.test(n.id)) || ['dialog', 'alertdialog'].includes(n.getAttribute('role'))) && pg.visivelNo(n)) ?? null;
const botoesDaConfirmacao = (caixa) => {
  const todos = caixa.querySelectorAll('button');
  return {
    cancelar: todos.find((b) => /cancelar|voltar|n[aã]o/i.test(b.textContent)) ?? null,
    confirmar: todos.find((b) => !/cancelar|voltar|n[aã]o/i.test(b.textContent)) ?? null,
  };
};
const PROTOTIPO = (nome) => path.join(process.env.HOME ?? '', 'Desktop', nome);
function lerPagina() {
  assert.ok(fs.existsSync(path.join(RAIZ, ARQUIVO)), 'pages/funcionarios.html ainda não existe');
  return ler(ARQUIVO);
}

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — página e visual aprovado', () => {
  test('a página e o módulo existem; o módulo legado de importação/histórico não é carregado nem substituído', () => {
    assert.ok(fs.existsSync(path.join(RAIZ, ARQUIVO)), 'pages/funcionarios.html ainda não existe');
    assert.ok(fs.existsSync(MODULO), 'js/gestao-funcionarios.js ainda não existe');
    const html = lerPagina();
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.includes('../js/gestao-funcionarios.js'), JSON.stringify(scripts));
    assert.equal(scripts.at(-1), '../js/gestao-funcionarios.js', 'o módulo da página é o último');
    for (const proibido of ['../js/funcionarios.js', '../js/db-api.js', '../js/main.js', '../js/importacao-ghe.js']) assert.equal(scripts.includes(proibido), false, proibido);
    for (const exigido of ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js']) assert.ok(scripts.includes(exigido), exigido);
  });

  test('o protótipo aprovado usado como referência é o mesmo arquivo identificado (4 cópias idênticas, SHA-256 d052e4569a76…)', () => {
    const crypto = require('node:crypto');
    const alvo = PROTOTIPO('funcionarios.html');
    if (!fs.existsSync(alvo)) return; // referência local do responsável; sem ela este teste só documenta
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(alvo)).digest('hex').slice(0, 12), PROTOTIPO_SHA);
    assert.ok(fs.existsSync(path.join(RAIZ, ARQUIVO)), 'pages/funcionarios.html ainda não existe');
  });

  test('estrutura e ids do protótipo preservados: título, busca, tabela, contagem, modal com os nove campos, toasts e tema por data-theme', () => {
    const html = semComentarios(lerPagina());
    assert.match(html, /<h1>Cadastro de Colaboradores<\/h1>/);
    for (const id of ['q', 'tbody', 'count', 'overlay', 'fNome', 'fCpf', 'fMatricula', 'fSetor', 'fCargo', 'fGhe', 'fTelefone', 'fNascimento', 'fContratacao', 'toasts']) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
    }
    for (const campo of ['Nome', 'Cpf', 'Matricula', 'Setor', 'Cargo', 'Telefone', 'Nascimento', 'Contratacao']) assert.match(html, new RegExp(`id="e${campo}"`), `#e${campo}`);
    assert.match(html, /Novo colaborador/);
    assert.match(html, /<select id="fGhe"/, 'o GHE é um seletor alimentado pela API, não texto livre');
    assert.equal(/id="dlGhe"|list="dlGhe"/.test(html), false, 'sem lista de sugestões de GHE (texto livre)');
    assert.match(html, /html\[data-theme=/, 'tema pelo data-theme que js/tema.js liga no <html>');
    assert.equal(/prefers-color-scheme/.test(html), false, 'o tema não depende mais da preferência do sistema, e sim do data-theme');
  });

  test('tabela exatamente Nome | Matrícula | Setor | Cargo | GHE | Situação | Ação; busca sem CPF; nada de CPF, telefone, nascimento ou contratação na tabela', () => {
    const html = lerPagina();
    const cabecalho = /<thead>([\s\S]*?)<\/thead>/.exec(html);
    assert.ok(cabecalho, 'sem <thead>');
    const colunas = [...cabecalho[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
    assert.deepEqual(colunas, ['Nome', 'Matrícula', 'Setor', 'Cargo', 'GHE', 'Situação', 'Ação']);
    const busca = /<input id="q"[^>]*placeholder="([^"]*)"/.exec(html);
    assert.ok(busca, 'campo de busca com placeholder');
    assert.equal(/cpf/i.test(busca[1]), false, 'a busca não menciona nem faz pesquisa por CPF');
    for (const termo of ['nome', 'matrícula', 'setor', 'cargo', 'GHE']) assert.match(busca[1], new RegExp(termo, 'i'));
  });

  test('obrigatórios marcados com * conforme o contrato (nome, CPF, setor, cargo, GHE, contratação); matrícula, telefone e nascimento sem *', () => {
    const html = lerPagina();
    const marcado = (id) => new RegExp(`<label for="${id}">[^<]*<b>\\*</b></label>`).test(html);
    for (const id of ['fNome', 'fCpf', 'fSetor', 'fCargo', 'fGhe', 'fContratacao']) assert.equal(marcado(id), true, id);
    for (const id of ['fMatricula', 'fTelefone', 'fNascimento']) assert.equal(marcado(id), false, id);
  });

  test('sem armazenamento do navegador, banco do protótipo, dados semente nem manipuladores inline (a página usa a sessão e a API)', () => {
    const codigo = semComentarios(lerPagina());
    for (const proibido of [/localStorage/, /sessionStorage/, /epi_db_v2/, /epi_funcionarios_standalone/, /\bSEED\b/, /onclick=/, /oninput=/]) {
      assert.equal(proibido.test(codigo), false, String(proibido));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — listagem e busca', () => {
  test('lista a empresa da sessão pela API: uma linha por funcionário com as sete colunas; matrícula e GHE ausentes viram "—"; contagem do protótipo', async () => {
    const pg = await pronta();
    const t = tabela(pg);
    assert.equal(t.length, 4);
    assert.deepEqual(t[0].slice(0, 6), ['Ana Souza', 'MAT-000098', 'Produção', 'Operadora', t[0][4], 'Inativo']);
    assert.equal(t[0][4], 'GHE-020', 'na tabela, só o código do GHE');
    assert.deepEqual(t[1].slice(0, 4), ['João Pereira', 'MAT-000121', 'Produção', 'Operador']);
    assert.equal(t[1][5], 'Afastado');
    assert.deepEqual(t[2].slice(0, 4), ['Mauro Teste', 'MAT-000171', 'Manutenção', 'Mecânico']);
    assert.equal(t[2][4], 'GHE-010', 'na tabela, só o código do GHE');
    assert.equal(t[2][5], 'Ativo');
    assert.deepEqual([t[3][0], t[3][1], t[3][4], t[3][5]], ['Zeca Legado', '—', '—', 'Ativo']);
    assert.ok(t.every((linha) => linha.length === 7));
    assert.equal(pg.texto('count').trim(), '4 de 4 colaboradores');
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length >= 1, true);
  });

  test('a tabela nunca mostra CPF, telefone, nascimento nem contratação; o CPF não aparece em lugar nenhum da lista', async () => {
    const pg = await pronta();
    const texto = pg.consulta('#tbody').map((n) => n.textContent).join('\n');
    for (const proibido of ['***.***', '47991110001', '1990-03-15', '15/03/1990', '2025-03-10', '10/03/2025']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('lista vazia: mensagem do protótipo e contagem zerada', async () => {
    const pg = await pronta({ lista: [] });
    assert.equal(linhas(pg).length, 1);
    assert.match(pg.texto('tbody'), /Nenhum colaborador encontrado\./);
    assert.equal(pg.texto('count').trim(), '0 de 0 colaboradores');
  });

  test('carregamento: enquanto a API não responde há um estado de carregando (sem dados inventados); depois a lista aparece', async () => {
    let liberar;
    const pendente = new Promise((resolve) => { liberar = resolve; });
    const m = mundo({ rotas: {} });
    m.rotas['GET /funcionarios'] = async (chamada) => { await pendente; return listagem(() => m.estado.lista)(chamada); };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar();
    assert.match(pg.textoDoDom(), /carregando/i);
    assert.equal(linhas(pg).filter((tr) => tr.children.length === 7).length, 0, 'nenhum dado antes da resposta');
    liberar();
    await pg.esperar();
    await pg.esperar();
    assert.equal(tabela(pg).length, 4);
  });

  test('conjunto grande: a tela usa a paginação REAL da API (nunca acima do limite máximo dela), junta todas as páginas e a busca local alcança os últimos', async () => {
    let limiteMaximo = 100;
    try { limiteMaximo = require('../../backend/src/schemas/campos.schema').LIMITES.LIMITE_MAXIMO; } catch { /* sem o backend ao lado: o padrão do servidor */ }
    const todos = Array.from({ length: 230 }, (_, i) => funcionario({ id: 100 + i, nome: `Pessoa ${String(i).padStart(3, '0')}`, matricula: `P-${i}`, cpfMascarado: '***.***.***-00' }));
    const m = mundo({ lista: todos, rotas: {} });
    m.rotas['GET /funcionarios'] = (chamada) => {
      const q = new URL(chamada.url).searchParams;
      const pagina = Number(q.get('pagina')) || 1;
      const limite = Number(q.get('limite')) || 20;
      if (limite > limiteMaximo || limite < 1) return { status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'query.limite', codigo: 'VALOR_NAO_PERMITIDO' }] } };
      return { status: 200, corpo: { status: 'ok', funcionarios: todos.slice((pagina - 1) * limite, pagina * limite), total: todos.length, pagina, limite } };
    };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    for (let i = 0; i < 6; i += 1) await pg.esperar();
    // Comportamento observável: o servidor falso recusa limite acima do máximo da API; se a tela pedisse demais, a lista falharia.
    const lista = chamadasDe(pg, 'GET /funcionarios');
    assert.ok(lista.length >= 2, 'mais de uma página foi pedida');
    assert.ok(lista.every((c) => Number(new URL(c.url).searchParams.get('limite')) <= limiteMaximo), 'nunca acima do limite da API');
    const paginasPedidas = lista.map((c) => Number(new URL(c.url).searchParams.get('pagina') || 1)).sort((a, b) => a - b);
    assert.deepEqual(paginasPedidas, Array.from({ length: paginasPedidas.length }, (_, i) => i + 1), 'páginas consecutivas, sem repetir nem pular');
    assert.equal(tabela(pg).filter((l) => l.length === 7).length, 230);
    assert.doesNotMatch(mensagens(pg), /\S/, 'nenhum erro de carregamento');
    assert.equal(pg.texto('count').trim(), '230 de 230 colaboradores');
    await digitarEm(pg, 'q', 'P-229');
    assert.deepEqual(tabela(pg).filter((l) => l.length === 7).map((l) => l[0]), ['Pessoa 229']);
  });

  async function esperarAte(pg, condicao, maximo = 400) {
    for (let i = 0; i < maximo && !condicao(); i += 1) await pg.esperar();
  }
  const servir = (todos, resposta) => (chamada) => {
    const q = new URL(chamada.url).searchParams;
    const pagina = Number(q.get('pagina')) || 1;
    const limite = Number(q.get('limite')) || 20;
    return { status: 200, corpo: { status: 'ok', ...resposta({ todos, pagina, limite }), pagina, limite } };
  };

  test('empresa grande: sem teto artificial de páginas; mais de 50 páginas chegam inteiras, sem aviso de lista incompleta', async () => {
    const todos = Array.from({ length: 5050 }, (_, i) => funcionario({ id: 1000 + i, nome: `Pessoa ${String(i).padStart(4, '0')}`, matricula: `Q-${i}`, cpfMascarado: '***.***.***-00' }));
    const m = mundo({ lista: todos, rotas: {} });
    m.rotas['GET /funcionarios'] = servir(todos, ({ pagina, limite }) => ({ funcionarios: todos.slice((pagina - 1) * limite, pagina * limite), total: todos.length }));
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await esperarAte(pg, () => /5050 de 5050/.test(pg.texto('count')));
    assert.ok(chamadasDe(pg, 'GET /funcionarios').length > 50, 'passou de 50 páginas');
    assert.equal(pg.texto('count').trim(), '5050 de 5050 colaboradores');
    assert.doesNotMatch(pg.textoDoDom(), /incompleta|não consegue carregar/i);
    await digitarEm(pg, 'q', 'Q-5049');
    assert.deepEqual(tabela(pg).filter((l) => l.length === 7).map((l) => l[0]), ['Pessoa 5049']);
  });

  test('metadados inconsistentes: página sem progresso (repetida ou vazia com total maior) para a carga com erro, sem lista parcial e sem laço', async () => {
    const todos = Array.from({ length: 300 }, (_, i) => funcionario({ id: 2000 + i, nome: `Pessoa ${i}`, matricula: `R-${i}`, cpfMascarado: '***.***.***-00' }));
    const casos = {
      'página repetida': ({ limite }) => ({ funcionarios: todos.slice(0, limite), total: todos.length }),
      'página vazia com total maior': ({ pagina, limite }) => ({ funcionarios: pagina === 1 ? todos.slice(0, limite) : [], total: todos.length }),
    };
    for (const [caso, resposta] of Object.entries(casos)) {
      const m = mundo({ lista: todos, rotas: {} });
      m.rotas['GET /funcionarios'] = servir(todos, resposta);
      const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
      await esperarAte(pg, () => /não foi possível carregar/i.test(pg.textoDoDom()), 60);
      assert.match(pg.textoDoDom(), /não foi possível carregar/i, caso);
      assert.equal(tabela(pg).filter((l) => l.length === 7).length, 0, `${caso}: nenhuma lista parcial`);
      assert.ok(chamadasDe(pg, 'GET /funcionarios').length <= 5, `${caso}: não ficou em laço`);
    }
  });

  test('erro da consulta: mensagem no lugar da lista, sem dados inventados; 401 devolve ao Portal', async () => {
    const falha = abrirPagina(ARQUIVO, { rotas: mundo({ rotas: { 'GET /funcionarios': { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } } } }).rotas });
    await falha.esperar();
    await falha.esperar();
    assert.match(falha.textoDoDom(), /não foi possível carregar/i);
    assert.equal(tabela(falha).filter((l) => l.length === 7).length, 0);
    const expirada = abrirPagina(ARQUIVO, { rotas: mundo({ rotas: { 'GET /funcionarios': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } } } }).rotas });
    await expirada.esperar();
    await expirada.esperar();
    assert.ok(expirada.navegacoes.some((d) => /portal\/index\.html/.test(d)), JSON.stringify(expirada.navegacoes));
  });

  test('sem employeeHistory.visualizar a página não consulta funcionários e mostra o acesso negado padrão (o conteúdo não aparece)', async () => {
    const pg = await pronta({ v: false });
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length, 0);
    assert.equal(chamadasDe(pg, 'GET /funcionarios/ghes').length, 0);
    assert.equal(linhas(pg).filter((tr) => tr.children.length === 7).length, 0);
    assert.match(pg.textoDoDom(), /não tem permissão para acessar este módulo/i);
  });

  test('busca local por nome, matrícula, setor, cargo e GHE (código ou descrição), sem diferenciar maiúsculas; a contagem acompanha', async () => {
    const pg = await pronta();
    const buscar = async (q) => { await digitarEm(pg, 'q', q); return tabela(pg).filter((l) => l.length === 7).map((l) => l[0]); };
    assert.deepEqual(await buscar('mauro'), ['Mauro Teste']);
    assert.deepEqual(await buscar('MAT-000121'), ['João Pereira']);
    assert.deepEqual(await buscar('almoxarifado'), ['Zeca Legado']);
    assert.deepEqual(await buscar('operadora'), ['Ana Souza']);
    assert.deepEqual(await buscar('caldeiraria'), ['Mauro Teste']);
    assert.deepEqual(await buscar('GHE-020'), ['Ana Souza', 'João Pereira']);
    assert.equal(pg.texto('count').trim(), '2 de 4 colaboradores');
    assert.deepEqual(await buscar(''), ['Ana Souza', 'João Pereira', 'Mauro Teste', 'Zeca Legado']);
  });

  test('não há pesquisa por CPF: o CPF mascarado ou parcial não encontra ninguém e nenhuma chamada leva CPF', async () => {
    const pg = await pronta();
    await digitarEm(pg, 'q', '***.***.***-45');
    assert.equal(tabela(pg).filter((l) => l.length === 7).length, 0);
    await digitarEm(pg, 'q', '12345678945');
    assert.equal(tabela(pg).filter((l) => l.length === 7).length, 0);
    assert.equal(pg.chamadas.some((c) => /cpf/i.test(c.url) || /consulta-cpf/.test(c.caminho)), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — permissões na interface (UX; o backend segue a autoridade)', () => {
  test('só visualizar: consulta e busca; sem "Novo colaborador" e sem nenhuma ação nas linhas', async () => {
    const pg = await pronta({ v: true });
    assert.equal(tabela(pg).filter((l) => l.length === 7).length, 4);
    const novo = botaoPorTexto(pg, 'Novo colaborador');
    assert.ok(novo === null || !pg.visivelNo(novo) || novo.disabled, 'sem criar não há inclusão');
    for (const nome of ['Mauro Teste', 'João Pereira', 'Ana Souza']) assert.deepEqual(acoesDaLinha(pg, nome), [], nome);
  });

  test('visualizar + criar: "Novo colaborador" disponível; sem edição nem situação', async () => {
    const pg = await pronta({ v: true, c: true });
    const novo = botaoPorTexto(pg, 'Novo colaborador');
    assert.ok(novo && pg.visivelNo(novo) && !novo.disabled);
    assert.deepEqual(acoesDaLinha(pg, 'Mauro Teste'), []);
  });

  test('visualizar + editar: sem inclusão; ações por situação — ATIVO: editar, afastar, inativar; AFASTADO: editar, ativar, inativar; INATIVO: editar, ativar', async () => {
    const pg = await pronta({ v: true, e: true });
    const novo = botaoPorTexto(pg, 'Novo colaborador');
    assert.ok(novo === null || !pg.visivelNo(novo) || novo.disabled);
    assert.deepEqual(acoesDaLinha(pg, 'Mauro Teste'), ['Editar', 'Afastar', 'Inativar']);
    assert.deepEqual(acoesDaLinha(pg, 'João Pereira'), ['Editar', 'Ativar', 'Inativar']);
    assert.deepEqual(acoesDaLinha(pg, 'Ana Souza'), ['Editar', 'Ativar']);
  });

  test('visualizar + criar + editar: tudo disponível', async () => {
    const pg = await pronta({ v: true, c: true, e: true });
    assert.ok(botaoPorTexto(pg, 'Novo colaborador'));
    assert.deepEqual(acoesDaLinha(pg, 'Mauro Teste'), ['Editar', 'Afastar', 'Inativar']);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — cadastro individual', () => {
  const CRIADO = funcionario({ id: 9, matricula: null, nome: 'Fulano de Tal', cpfMascarado: '***.***.***-25', setor: 'Manutenção', funcao: 'Mecânico', telefone: null, dataNascimento: null, dataAdmissao: '2026-01-15' });
  const abrirComCriacao = async (resposta) => {
    const m = mundo({ c: true, rotas: {} });
    m.rotas['POST /funcionarios'] = (chamada) => {
      const r = typeof resposta === 'function' ? resposta(chamada) : resposta;
      if (r.status === 201) m.estado.lista.push(r.corpo.funcionario);
      return r;
    };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar();
    await pg.esperar();
    return Object.assign(pg, { estado: m.estado });
  };

  test('abrir: modal "Novo colaborador", campos vazios, sem controle de situação; o seletor de GHE oferece os GHEs de /funcionarios/ghes (valor = id; texto com código e descrição)', async () => {
    const pg = await abrirComCriacao({ status: 201, corpo: { status: 'ok', funcionario: CRIADO } });
    await abrirNovo(pg);
    assert.match(pg.texto('mTitle'), /Novo colaborador/);
    for (const id of ['fNome', 'fCpf', 'fMatricula', 'fSetor', 'fCargo', 'fTelefone', 'fNascimento', 'fContratacao']) assert.equal(pg.el(id).value, '', id);
    assert.equal(pg.el('fCpf').disabled, false);
    const modal = pg.el('overlay').textContent;
    assert.equal(/situa[cç][aã]o|afastado|inativo/i.test(modal), false, 'o cadastro não oferece situação: nasce ATIVO');
    assert.ok(chamadasDe(pg, 'GET /funcionarios/ghes').length >= 1);
    assert.equal(pg.el('fGhe').localName, 'select');
    const opcoes = pg.consulta('#fGhe option');
    assert.deepEqual(opcoes.map((o) => o.getAttribute('value')), ['', '10', '20'], 'uma opção vazia e uma por GHE da API, valor = id');
    assert.ok(opcoes[1].textContent.includes('GHE-010') && opcoes[1].textContent.includes('Caldeiraria'));
    assert.ok(opcoes[2].textContent.includes('GHE-020') && opcoes[2].textContent.includes('Soldagem'));
    assert.equal(pg.el('fGhe').value, '', 'nada selecionado por padrão');
  });

  test('cadastro com os obrigatórios: POST /funcionarios com SÓ os campos da API (sem opcionais vazios, sem matrícula inventada, sem situacao/ativo); fecha, avisa e recarrega a lista', async () => {
    const pg = await abrirComCriacao({ status: 201, corpo: { status: 'ok', funcionario: CRIADO } });
    await abrirNovo(pg);
    await preencherCadastro(pg);
    await salvar(pg);
    const envios = chamadasDe(pg, 'POST /funcionarios');
    assert.equal(envios.length, 1);
    assert.deepEqual(envios[0].corpo, { nome: 'Fulano de Tal', cpf: '52998224725', setor: 'Manutenção', funcao: 'Mecânico', grupoHomogeneoId: 10, dataAdmissao: '2026-01-15' });
    assert.equal(pg.visivel('overlay'), false, 'o modal fecha no sucesso');
    assert.match(pg.textoDoDom(), /Colaborador cadastrado!/);
    assert.ok(tabela(pg).some((l) => l[0] === 'Fulano de Tal'), 'a lista é relida e mostra o novo funcionário');
    assert.ok(chamadasDe(pg, 'GET /funcionarios').length >= 2);
  });

  test('com os opcionais (matrícula, telefone, nascimento): vão no corpo com os nomes da API; o telefone segue só com dígitos ou como digitado', async () => {
    const pg = await abrirComCriacao({ status: 201, corpo: { status: 'ok', funcionario: CRIADO } });
    await abrirNovo(pg);
    await preencherCadastro(pg, { fMatricula: 'MAT-900', fTelefone: '(47) 99999-9999', fNascimento: '1995-05-15', ghe: GHES[1] });
    await salvar(pg);
    const [envio] = chamadasDe(pg, 'POST /funcionarios');
    assert.ok(envio, 'nenhum POST');
    assert.equal(envio.corpo.matricula, 'MAT-900');
    assert.equal(String(envio.corpo.telefone).replace(/\D/g, ''), '47999999999');
    assert.equal(envio.corpo.dataNascimento, '1995-05-15');
    assert.equal(envio.corpo.grupoHomogeneoId, 20);
    assert.deepEqual(Object.keys(envio.corpo).sort(), ['cpf', 'dataAdmissao', 'dataNascimento', 'grupoHomogeneoId', 'matricula', 'nome', 'setor', 'funcao', 'telefone'].sort());
  });

  test('validação local antes da rede: obrigatórios vazios, CPF curto e inválido, datas fora da regra — nenhum POST, campos marcados, modal aberto', async () => {
    const pg = await abrirComCriacao({ status: 201, corpo: { status: 'ok', funcionario: CRIADO } });
    await abrirNovo(pg);
    await salvar(pg);
    assert.equal(chamadasDe(pg, 'POST /funcionarios').length, 0);
    assert.equal(pg.visivel('overlay'), true);
    const todas = erros(pg).join(' | ');
    assert.match(todas, /Informe o nome\./);
    assert.match(todas, /O CPF deve ter 11 dígitos\./);
    assert.match(todas, /Informe o setor\./);
    assert.match(todas, /Informe o cargo\./);
    assert.match(todas, /Informe a data de contratação\./);
    assert.match(todas, /ghe/i, 'o GHE é obrigatório');
    assert.equal(/matr[ií]cula|nascimento|telefone/i.test(todas), false, 'matrícula, nascimento e telefone são opcionais');
    for (const id of ['fNome', 'fCpf', 'fSetor', 'fCargo', 'fContratacao']) assert.ok(pg.el(id).classList.contains('invalid'), id);

    await digitarEm(pg, 'fNome', 'Fulano');
    await digitarEm(pg, 'fCpf', '111.111.111-11');
    await digitarEm(pg, 'fSetor', 'S');
    await digitarEm(pg, 'fCargo', 'C');
    await digitarEm(pg, 'fContratacao', '2999-01-01');
    await digitarEm(pg, 'fNascimento', '1899-12-31');
    await digitarEm(pg, 'fTelefone', '(47) 9');
    await salvar(pg);
    assert.equal(chamadasDe(pg, 'POST /funcionarios').length, 0);
    const depois = erros(pg).join(' | ');
    assert.match(depois, /CPF inválido\./);
    assert.match(depois, /A data não pode ser futura\./);
    assert.match(depois, /Telefone incompleto\./);
    assert.match(pg.texto('eNascimento'), /\S/, 'nascimento antes de 1900 é recusado');
    await digitarEm(pg, 'fNascimento', '2999-01-01');
    await salvar(pg);
    assert.match(pg.texto('eNascimento'), /A data deve estar no passado\./);
    await digitarEm(pg, 'fNascimento', '2026-01-15');
    await digitarEm(pg, 'fContratacao', '2026-01-15');
    await salvar(pg);
    assert.match(pg.texto('eContratacao'), /Deve ser posterior ao nascimento\./);
    assert.equal(chamadasDe(pg, 'POST /funcionarios').length, 0);
  });

  test('erros do servidor: a mensagem chega ao usuário pelo mecanismo existente (campo quando inequívoco, aviso nos demais), o modal fica aberto com o digitado e nada do pedido vaza', async () => {
    const cenarios = [
      [{ status: 409, corpo: { status: 'error', codigo: 'FUNCIONARIO_CPF_EM_USO', message: 'Já existe um funcionário com este CPF nesta empresa' } }, /cpf/i],
      [{ status: 409, corpo: { status: 'error', codigo: 'FUNCIONARIO_MATRICULA_EM_USO', message: 'Já existe um funcionário com esta matrícula nesta empresa' } }, /matr[ií]cula/i],
      [{ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'body.dataAdmissao', codigo: 'DATA_ADMISSAO_INVALIDA', mensagem: 'Data de admissão inválida' }] } }, /\S/],
      [{ status: 400, corpo: { status: 'error', codigo: 'FUNCIONARIO_DATA_NASCIMENTO_INVALIDA', message: 'Data de nascimento inválida' } }, /\S/],
      [{ status: 400, corpo: { status: 'error', codigo: 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA', message: 'Data de admissão inválida' } }, /\S/],
    ];
    for (const [resposta, padrao] of cenarios) {
      // eslint-disable-next-line no-await-in-loop
      const pg = await abrirComCriacao(resposta);
      // eslint-disable-next-line no-await-in-loop
      await abrirNovo(pg);
      // eslint-disable-next-line no-await-in-loop
      await preencherCadastro(pg, { fMatricula: 'MAT-900' });
      // eslint-disable-next-line no-await-in-loop
      await salvar(pg);
      assert.equal(chamadasDe(pg, 'POST /funcionarios').length, 1, resposta.corpo.codigo);
      assert.equal(pg.visivel('overlay'), true, 'o modal continua aberto');
      assert.match(mensagens(pg), padrao, `${resposta.corpo.codigo}: mensagem ao usuário`);
      assert.equal(pg.el('fNome').value, 'Fulano de Tal', 'o digitado é preservado');
      assert.equal(pg.textoDoDom().includes('52998224725'), false, 'o CPF só dígitos nunca vira texto nem fica no DOM fora do campo mascarado');
      assert.equal(mensagens(pg).includes('"cpf"'), false, 'o corpo do pedido não é exibido');
    }
    const ghe = await abrirComCriacao({ status: 409, corpo: { status: 'error', codigo: 'FUNCIONARIO_GHE_INATIVO', message: 'GHE inativo não aceita novos vínculos' } });
    await abrirNovo(ghe);
    await preencherCadastro(ghe);
    await salvar(ghe);
    assert.match(mensagens(ghe), /ghe/i);
    assert.equal(chamadasDe(ghe, 'GET /funcionarios/ghes').length >= 2, true, 'a lista de GHE é relida (o GHE pode ter sido inativado)');
  });

  test('falhas gerais: 403 avisa sem mudar nada; 500 mantém o modal e os dados; 401 devolve ao Portal; segundo clique durante o envio não duplica', async () => {
    const proibido = await abrirComCriacao({ status: 403, corpo: { status: 'error', codigo: 'SEM_PERMISSAO', message: 'x' } });
    await abrirNovo(proibido);
    await preencherCadastro(proibido);
    await salvar(proibido);
    assert.equal(proibido.visivel('overlay'), true);
    assert.match(mensagens(proibido), /permiss/i);
    const interno = await abrirComCriacao({ status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } });
    await abrirNovo(interno);
    await preencherCadastro(interno);
    await salvar(interno);
    assert.equal(interno.visivel('overlay'), true);
    assert.equal(interno.el('fSetor').value, 'Manutenção');
    const expirada = await abrirComCriacao({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } });
    await abrirNovo(expirada);
    await preencherCadastro(expirada);
    await salvar(expirada);
    assert.ok(expirada.navegacoes.some((d) => /portal\/index\.html/.test(d)), JSON.stringify(expirada.navegacoes));

    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const duplo = await abrirComCriacao(async () => { await espera; return { status: 201, corpo: { status: 'ok', funcionario: CRIADO } }; });
    await abrirNovo(duplo);
    await preencherCadastro(duplo);
    const botao = botaoPorTexto(duplo, 'Salvar');
    // disparar() espera os ouvintes assíncronos: o primeiro clique só termina quando a resposta chegar, então não é aguardado aqui.
    const primeiro = botao.disparar('click');
    await duplo.esperar();
    await botao.disparar('click');
    await duplo.esperar();
    assert.equal(chamadasDe(duplo, 'POST /funcionarios').length, 1, 'um envio só');
    liberar();
    await primeiro;
    await duplo.esperar();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — edição', () => {
  const abrirComEdicao = async (id, resposta) => {
    const m = mundo({ e: true, rotas: {} });
    m.rotas[`PATCH /funcionarios/${id}`] = (chamada) => {
      const r = typeof resposta === 'function' ? resposta(chamada) : resposta;
      if (r.status === 200) m.estado.lista = m.estado.lista.map((f) => (f.id === id ? r.corpo.funcionario : f));
      return r;
    };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar();
    await pg.esperar();
    return Object.assign(pg, { estado: m.estado });
  };
  const atualizado = (extra) => ({ status: 200, corpo: { status: 'ok', funcionario: funcionario(extra) } });

  test('abrir: dados atuais nos campos; CPF mascarado e bloqueado (nunca o completo); GHE atual mostrado; datas e telefone da API', async () => {
    const pg = await abrirComEdicao(1, atualizado({}));
    await abrirEdicao(pg, 'Mauro Teste');
    assert.match(pg.texto('mTitle'), /Editar colaborador/);
    assert.deepEqual(['fNome', 'fMatricula', 'fSetor', 'fCargo', 'fNascimento', 'fContratacao'].map((id) => pg.el(id).value), ['Mauro Teste', 'MAT-000171', 'Manutenção', 'Mecânico', '1990-03-15', '2025-03-10']);
    assert.equal(String(pg.el('fTelefone').value).replace(/\D/g, ''), '47991110001');
    assert.equal(pg.el('fCpf').value, '***.***.***-45');
    assert.ok(pg.el('fCpf').disabled || pg.el('fCpf').hasAttribute('readonly'), 'CPF imutável');
    assert.match(gheMostrado(pg), /Caldeiraria/);
    assert.equal(pg.textoDoDom().includes('12345678945'), false);
  });

  test('PATCH: só campos editáveis da API, nunca CPF, situacao nem ativo; o campo alterado vai com o novo valor; salva, avisa e relê a lista', async () => {
    const pg = await abrirComEdicao(1, atualizado({ setor: 'Produção' }));
    await abrirEdicao(pg, 'Mauro Teste');
    await digitarEm(pg, 'fSetor', 'Produção');
    await salvar(pg);
    const envios = chamadasDe(pg, 'PATCH /funcionarios/1');
    assert.equal(envios.length, 1);
    const corpo = payloadPatchValido(envios[0].corpo);
    assert.equal(corpo.setor, 'Produção');
    assert.equal(pg.visivel('overlay'), false);
    assert.match(pg.textoDoDom(), /Alterações salvas!/);
    assert.ok(tabela(pg).some((l) => l[0] === 'Mauro Teste' && l[2] === 'Produção'), 'a lista é relida');
  });

  test('troca de GHE e de datas: o corpo leva o id do GHE novo e as datas com os nomes da API, dentro do contrato do PATCH', async () => {
    const troca = await abrirComEdicao(1, atualizado({ grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }));
    await abrirEdicao(troca, 'Mauro Teste');
    await escolherGhe(troca, GHES[1]);
    await salvar(troca);
    const corpoGhe = payloadPatchValido(chamadasDe(troca, 'PATCH /funcionarios/1')[0]?.corpo);
    assert.equal(corpoGhe.grupoHomogeneoId, 20);

    const varios = await abrirComEdicao(1, atualizado({ dataNascimento: '1991-01-01', dataAdmissao: '2025-04-01' }));
    await abrirEdicao(varios, 'Mauro Teste');
    await digitarEm(varios, 'fNascimento', '1991-01-01');
    await digitarEm(varios, 'fContratacao', '2025-04-01');
    await salvar(varios);
    const corpoDatas = payloadPatchValido(chamadasDe(varios, 'PATCH /funcionarios/1')[0]?.corpo);
    assert.equal(corpoDatas.dataNascimento, '1991-01-01');
    assert.equal(corpoDatas.dataAdmissao, '2025-04-01');
  });

  test('quem já tem GHE não pode ficar sem: com o GHE removido na tela, nenhum PATCH leva GHE nulo e a tela explica; se o servidor recusar (FUNCIONARIO_GHE_OBRIGATORIO), a mensagem chega ao usuário', async () => {
    const pg = await abrirComEdicao(1, atualizado({}));
    await abrirEdicao(pg, 'Mauro Teste');
    const campo = pg.el('fGhe');
    campo.value = '';
    await campo.disparar('change');
    await digitarEm(pg, 'fSetor', 'Outro setor');
    await salvar(pg);
    for (const envio of chamadasDe(pg, 'PATCH /funcionarios/1')) payloadPatchValido(envio.corpo);
    assert.equal(chamadasDe(pg, 'PATCH /funcionarios/1').filter((c) => Object.hasOwn(c.corpo, 'grupoHomogeneoId')).length, 0, 'nunca envia o GHE vazio');
    assert.match(mensagens(pg), /ghe/i);
    assert.equal(pg.visivel('overlay'), true);

    const servidor = await abrirComEdicao(1, { status: 400, corpo: { status: 'error', codigo: 'FUNCIONARIO_GHE_OBRIGATORIO', message: 'x' } });
    await abrirEdicao(servidor, 'Mauro Teste');
    await digitarEm(servidor, 'fSetor', 'Outro setor');
    await salvar(servidor);
    assert.match(mensagens(servidor), /ghe/i);
    assert.equal(servidor.visivel('overlay'), true);
  });

  test('legado sem GHE e sem admissão: editar outro campo não força regularização nem exige contratação; escolher um GHE o regulariza (null → GHE)', async () => {
    const outro = await abrirComEdicao(4, atualizado({ id: 4, nome: 'Zeca Legado 2', matricula: null, grupoHomogeneoId: null, grupoHomogeneo: null }));
    await abrirEdicao(outro, 'Zeca Legado');
    assert.equal(outro.el('fMatricula').value, '');
    assert.equal(outro.el('fContratacao').value, '', 'sem admissão gravada: não preenche retroativamente');
    assert.equal(outro.el('fGhe').value, '', 'sem GHE: nada selecionado');
    await digitarEm(outro, 'fNome', 'Zeca Legado 2');
    await salvar(outro);
    const corpo = payloadPatchValido(chamadasDe(outro, 'PATCH /funcionarios/4')[0]?.corpo);
    assert.equal(corpo.nome, 'Zeca Legado 2');
    assert.equal(corpo.grupoHomogeneoId ?? null, null, 'nenhum GHE inventado');
    assert.equal(outro.visivel('overlay'), false, 'a edição não é bloqueada por GHE/contratação ausentes');

    const regulariza = await abrirComEdicao(4, atualizado({ id: 4, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1], matricula: null }));
    await abrirEdicao(regulariza, 'Zeca Legado');
    await escolherGhe(regulariza, GHES[1]);
    await salvar(regulariza);
    assert.equal(payloadPatchValido(chamadasDe(regulariza, 'PATCH /funcionarios/4')[0]?.corpo).grupoHomogeneoId, 20);
  });

  test('erros do servidor na edição: matrícula em uso, 404 (relê a lista) e 403 chegam ao usuário pelo mecanismo existente; nunca se mostra o corpo do pedido', async () => {
    const mat = await abrirComEdicao(1, { status: 409, corpo: { status: 'error', codigo: 'FUNCIONARIO_MATRICULA_EM_USO', message: 'x' } });
    await abrirEdicao(mat, 'Mauro Teste');
    await digitarEm(mat, 'fMatricula', 'MAT-000121');
    await salvar(mat);
    assert.match(mensagens(mat), /matr[ií]cula/i);
    assert.equal(mat.visivel('overlay'), true);

    const sumiu = await abrirComEdicao(1, { status: 404, corpo: { status: 'error', codigo: 'FUNCIONARIO_NAO_ENCONTRADO', message: 'x' } });
    const antesDaLeitura = chamadasDe(sumiu, 'GET /funcionarios').length;
    await abrirEdicao(sumiu, 'Mauro Teste');
    await digitarEm(sumiu, 'fSetor', 'Outro');
    await salvar(sumiu);
    assert.match(mensagens(sumiu), /n[aã]o encontrado|n[aã]o existe/i);
    assert.ok(chamadasDe(sumiu, 'GET /funcionarios').length > antesDaLeitura, 'a lista é relida');

    const proibido = await abrirComEdicao(1, { status: 403, corpo: { status: 'error', codigo: 'SEM_PERMISSAO', message: 'x' } });
    await abrirEdicao(proibido, 'Mauro Teste');
    await digitarEm(proibido, 'fSetor', 'Outro');
    await salvar(proibido);
    assert.match(mensagens(proibido), /permiss/i);
    assert.equal(mensagens(proibido).includes('"setor"'), false);
  });

  test('as mesmas regras de data da API na edição: nascimento no futuro e contratação anterior ao nascimento são recusados na tela, sem PATCH', async () => {
    const pg = await abrirComEdicao(1, atualizado({}));
    await abrirEdicao(pg, 'Mauro Teste');
    await digitarEm(pg, 'fNascimento', '2999-01-01');
    await salvar(pg);
    assert.match(pg.texto('eNascimento'), /A data deve estar no passado\./);
    await digitarEm(pg, 'fNascimento', '2030-01-01');
    await digitarEm(pg, 'fNascimento', '1990-03-15');
    await digitarEm(pg, 'fContratacao', '1980-01-01');
    await salvar(pg);
    assert.match(pg.texto('eContratacao'), /Deve ser posterior ao nascimento\./);
    assert.equal(chamadasDe(pg, 'PATCH /funcionarios/1').length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — situação (só pelas rotas específicas)', () => {
  const comSituacao = async (id, resposta) => {
    const m = mundo({ e: true, rotas: {} });
    m.rotas[`POST /funcionarios/${id}/situacao`] = (chamada) => {
      const r = typeof resposta === 'function' ? resposta(chamada) : resposta;
      if (r.status === 200) m.estado.lista = m.estado.lista.map((f) => (f.id === id ? r.corpo.funcionario : f));
      return r;
    };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar();
    await pg.esperar();
    return Object.assign(pg, { estado: m.estado });
  };
  const ok = (extra) => ({ status: 200, corpo: { status: 'ok', funcionario: funcionario(extra), situacaoAnterior: 'ATIVO' } });
  const CASOS = [
    [1, 'Mauro Teste', 'Afastar', 'AFASTADO', { situacao: 'AFASTADO', ativo: false }, 'Afastado'],
    [1, 'Mauro Teste', 'Inativar', 'INATIVO', { situacao: 'INATIVO', ativo: false }, 'Inativo'],
    [2, 'João Pereira', 'Ativar', 'ATIVO', { id: 2, nome: 'João Pereira', situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }, 'Ativo'],
    [2, 'João Pereira', 'Inativar', 'INATIVO', { id: 2, nome: 'João Pereira', situacao: 'INATIVO', ativo: false, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }, 'Inativo'],
    [3, 'Ana Souza', 'Ativar', 'ATIVO', { id: 3, nome: 'Ana Souza', situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 20, grupoHomogeneo: GHES[1] }, 'Ativo'],
  ];
  for (const [id, nome, acao, destino, resultado, rotulo] of CASOS) {
    test(`${nome}: "${acao}" → POST /funcionarios/${id}/situacao { situacao: "${destino}" } (e só isso); a lista é relida e mostra ${rotulo}`, async () => {
      const pg = await comSituacao(id, ok(resultado));
      await acionarNaLinha(pg, nome, acao);
      const envios = chamadasDe(pg, `POST /funcionarios/${id}/situacao`);
      assert.equal(envios.length, 1);
      assert.deepEqual(envios[0].corpo, { situacao: destino });
      assert.equal(pg.chamadas.some((c) => c.metodo === 'PATCH'), false, 'situação nunca vai pelo PATCH genérico');
      const linha = tabela(pg).find((l) => l[0] === nome);
      assert.equal(linha?.[5], rotulo);
      assert.ok(chamadasDe(pg, 'GET /funcionarios').length >= 2);
    });
  }

  test('toda mudança de situação pede confirmação com o nome da pessoa: clicar na ação não envia nada; Cancelar descarta; só confirmar envia', async () => {
    const pg = await comSituacao(1, ok({ situacao: 'AFASTADO', ativo: false }));
    const tr = linhaDe(pg, 'Mauro Teste');
    assert.ok(tr, 'linha de Mauro Teste não encontrada');
    const afastar = tr.querySelectorAll('button').find((b) => b.textContent.trim().endsWith('Afastar'));
    assert.ok(afastar);
    await afastar.disparar('click');
    await pg.esperar();
    const caixa = confirmacaoVisivel(pg);
    assert.ok(caixa, 'uma confirmação deveria aparecer');
    assert.match(caixa.textContent, /Mauro Teste/);
    assert.match(caixa.textContent, /afast/i);
    assert.equal(chamadasDe(pg, 'POST /funcionarios/1/situacao').length, 0, 'nada é enviado antes de confirmar');
    const { cancelar, confirmar } = botoesDaConfirmacao(caixa);
    assert.ok(cancelar && confirmar, 'a confirmação tem Cancelar e confirmar');
    await cancelar.disparar('click');
    await pg.esperar();
    assert.equal(confirmacaoVisivel(pg), null, 'cancelar fecha a confirmação');
    assert.equal(chamadasDe(pg, 'POST /funcionarios/1/situacao').length, 0);
    assert.equal(tabela(pg).find((l) => l[0] === 'Mauro Teste')?.[5], 'Ativo');
    await acionarNaLinha(pg, 'Mauro Teste', 'Afastar');
    assert.equal(chamadasDe(pg, 'POST /funcionarios/1/situacao').length, 1);
  });

  test('conflitos e falhas: transição inválida ou situação já igual relê a lista e avisa; 403 e 404 avisam; nada é alterado localmente', async () => {
    for (const codigo of ['FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA', 'FUNCIONARIO_SITUACAO_IGUAL']) {
      // eslint-disable-next-line no-await-in-loop
      const pg = await comSituacao(1, { status: 409, corpo: { status: 'error', codigo, message: 'x' } });
      const antes = chamadasDe(pg, 'GET /funcionarios').length;
      // eslint-disable-next-line no-await-in-loop
      await acionarNaLinha(pg, 'Mauro Teste', 'Afastar');
      assert.ok(chamadasDe(pg, 'GET /funcionarios').length > antes, `${codigo}: a lista é relida`);
      assert.match(mensagens(pg), /\S/, `${codigo}: o usuário é avisado`);
      assert.equal(tabela(pg).find((l) => l[0] === 'Mauro Teste')?.[5], 'Ativo');
    }
    const proibido = await comSituacao(1, { status: 403, corpo: { status: 'error', codigo: 'SEM_PERMISSAO', message: 'x' } });
    await acionarNaLinha(proibido, 'Mauro Teste', 'Inativar');
    assert.match(mensagens(proibido), /permiss/i);
    assert.equal(tabela(proibido).find((l) => l[0] === 'Mauro Teste')?.[5], 'Ativo');
    const sumiu = await comSituacao(1, { status: 404, corpo: { status: 'error', codigo: 'FUNCIONARIO_NAO_ENCONTRADO', message: 'x' } });
    await acionarNaLinha(sumiu, 'Mauro Teste', 'Afastar');
    assert.match(mensagens(sumiu), /n[aã]o encontrado|n[aã]o existe/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Gestão de Funcionários — privacidade e armazenamento', () => {
  test('nada em localStorage/sessionStorage/cookie, nenhum log com dados, nenhum CPF em URL e nenhuma rede externa', async () => {
    const m = mundo({ c: true, e: true, rotas: {} });
    m.rotas['POST /funcionarios'] = { status: 201, corpo: { status: 'ok', funcionario: funcionario({ id: 9, nome: 'Fulano de Tal' }) } };
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar();
    await pg.esperar();
    await abrirNovo(pg);
    await preencherCadastro(pg);
    await salvar(pg);
    // A infraestrutura comum (tema e sessão) usa só estas chaves; a página nunca grava dado de funcionário em armazenamento nenhum.
    const CHAVES_DA_INFRAESTRUTURA = ['safework-aparencia', 'epi-session-user'];
    for (const s of pg.storage.filter((x) => x.storage !== 'cookie')) {
      assert.ok(CHAVES_DA_INFRAESTRUTURA.includes(s.chave), `armazenamento fora da infraestrutura: ${JSON.stringify(s)}`);
    }
    const gravado = JSON.stringify([pg.storage, pg.cookiesEscritos]);
    for (const proibido of ['Fulano', '52998224725', '529.982.247-25', 'Manutenção', 'GHE-010']) assert.equal(gravado.includes(proibido), false, `${proibido} não vai para armazenamento nem cookie`);
    // O cliente HTTP comum registra só método, caminho e status ("[HTTP] POST /funcionarios → 201"); nenhuma outra linha, e nada de dado.
    const fora = pg.consoleChamadas.filter((c) => !/^%c\[HTTP\] (GET|POST|PATCH|PUT|DELETE) \/[^?\s]* → \d{3} color:#[0-9A-Fa-f]{6}$/.test(c.texto));
    assert.deepEqual(fora, [], 'a página não escreve no console');
    assert.equal(JSON.stringify(pg.consoleChamadas).match(/Fulano|52998224725|529\.982|Manuten/) , null, 'nenhum dado nos logs');
    assert.deepEqual(pg.externas, []);
    assert.equal(pg.chamadas.some((c) => /5299|529\.982/.test(c.url)), false, 'CPF nunca na URL');
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => /529/.test(String(u))), false);
  });
});

describe('Gestão de Funcionários — moldura de navegação (comportamento)', () => {
  const entrada = (pg) => pg.consulta('.nav a[data-pagina="funcionarios"]')[0];

  test('com employeeHistory.visualizar: o item Funcionários aparece como página atual, o conteúdo abre e o Histórico segue como link', async () => {
    const pg = await pronta();
    assert.ok(entrada(pg), 'item do menu');
    assert.equal(entrada(pg).getAttribute('class'), 'active');
    assert.equal(pg.visivelNo(entrada(pg)), true);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.consulta('.nav a[data-pagina="employeeHistory"]')[0].getAttribute('href'), 'employee-history.html');
    assert.equal(pg.consulta('.nav a.active').length, 1);
  });

  test('sem visualizar: o item do menu e o conteúdo ficam ocultos e nada é consultado', async () => {
    const pg = await pronta({ v: false });
    assert.ok(entrada(pg), 'item do menu');
    assert.equal(pg.visivelNo(entrada(pg)), false);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length, 0);
  });

  test('o botão do menu no celular abre e fecha a barra lateral; tocar no fundo fecha', async () => {
    const pg = await pronta();
    const corpo = pg.documento.body;
    const botao = pg.consulta('.mobile-global-menu')[0];
    assert.ok(botao, 'botão do menu no celular');
    await botao.disparar('click');
    assert.equal(corpo.classList.contains('mobile-menu-open'), true);
    await pg.consulta('.mobile-overlay')[0].disparar('click');
    assert.equal(corpo.classList.contains('mobile-menu-open'), false);
    await botao.disparar('click');
    await botao.disparar('click');
    assert.equal(corpo.classList.contains('mobile-menu-open'), false);
  });

  test('criar e editar continuam sendo só ações dentro da página: o menu não muda com elas', async () => {
    for (const ops of [{ c: true }, { e: true }, { c: true, e: true }]) {
      const pg = await pronta(ops);
      assert.equal(pg.consulta('.nav a[data-pagina="funcionarios"]').length, 1);
      assert.equal(pg.consulta('.nav a').filter((a) => /Cadastrar|Editar|Novo Funcion/.test(a.textContent)).length, 0);
    }
  });
});

describe('Gestão de Funcionários — filtro de Situação (local, junto da busca)', () => {
  const CONTROLE = 'fSituacaoFiltro';
  const nomes = (pg) => tabela(pg).filter((l) => l.length === 7).map((l) => l[0]);
  const filtrar = async (pg, valor) => { pg.el(CONTROLE).value = valor; await pg.el(CONTROLE).disparar('change'); };
  const buscar = async (pg, q) => digitarEm(pg, 'q', q);

  test('é um seletor próprio na área de filtros, ao lado da busca: Todos (inicial), Ativo, Afastado e Inativo, com os valores da API', async () => {
    const pg = await pronta();
    const campo = pg.el(CONTROLE);
    assert.equal(campo.localName, 'select');
    assert.ok(pg.consulta('.toolbar select').includes(campo), 'dentro da .toolbar, junto da busca');
    assert.deepEqual(pg.consulta(`#${CONTROLE} option`).map((o) => [o.getAttribute('value'), o.textContent.trim()]),
      [['', 'Todos'], ['ATIVO', 'Ativo'], ['AFASTADO', 'Afastado'], ['INATIVO', 'Inativo']]);
    assert.equal(campo.value, '', 'valor inicial: Todos');
    assert.deepEqual(nomes(pg), ['Ana Souza', 'João Pereira', 'Mauro Teste', 'Zeca Legado']);
    assert.ok(campo.getAttribute('aria-label') || pg.consulta(`label[for="${CONTROLE}"]`).length, 'identificado para leitores de tela');
  });

  test('Situação não vira texto da busca: a caixa de busca continua sem filtrar por "ativo" ou "afastado" e o placeholder não muda', async () => {
    const pg = await pronta();
    assert.equal(pg.el('q').getAttribute('placeholder'), 'Buscar por nome, matrícula, setor, cargo ou GHE');
    await buscar(pg, 'afastado');
    assert.deepEqual(nomes(pg), []);
    await buscar(pg, 'inativo');
    assert.deepEqual(nomes(pg), []);
  });

  test('cada opção mostra só a sua situação, e a contagem acompanha (mostrados de carregados)', async () => {
    const pg = await pronta();
    await filtrar(pg, 'ATIVO');
    assert.deepEqual(nomes(pg), ['Mauro Teste', 'Zeca Legado']);
    assert.equal(pg.texto('count').trim(), '2 de 4 colaboradores');
    await filtrar(pg, 'AFASTADO');
    assert.deepEqual(nomes(pg), ['João Pereira']);
    assert.equal(pg.texto('count').trim(), '1 de 4 colaboradores');
    await filtrar(pg, 'INATIVO');
    assert.deepEqual(nomes(pg), ['Ana Souza']);
    await filtrar(pg, '');
    assert.deepEqual(nomes(pg), ['Ana Souza', 'João Pereira', 'Mauro Teste', 'Zeca Legado']);
    assert.equal(pg.texto('count').trim(), '4 de 4 colaboradores');
  });

  test('em conjunto com a busca: "produção" + Afastado mostra só quem é afastado E corresponde à busca; limpar um dos dois mantém o outro', async () => {
    const pg = await pronta();
    await buscar(pg, 'produção');
    assert.deepEqual(nomes(pg), ['Ana Souza', 'João Pereira']);
    await filtrar(pg, 'AFASTADO');
    assert.deepEqual(nomes(pg), ['João Pereira']);
    await filtrar(pg, 'INATIVO');
    assert.deepEqual(nomes(pg), ['Ana Souza']);
    await filtrar(pg, 'ATIVO');
    assert.deepEqual(nomes(pg), [], 'ninguém ativo em Produção');
    assert.match(pg.textoDoDom(), /nenhum colaborador encontrado/i);
    await buscar(pg, '');
    assert.deepEqual(nomes(pg), ['Mauro Teste', 'Zeca Legado'], 'limpar a busca mantém a situação');
    await buscar(pg, 'manutenção');
    await filtrar(pg, '');
    assert.deepEqual(nomes(pg), ['Mauro Teste'], 'voltar a Todos mantém a busca');
  });

  test('é só local: nenhuma nova consulta ao servidor, nenhum parâmetro de situação na URL e nada em armazenamento', async () => {
    const pg = await pronta();
    const antes = chamadasDe(pg, 'GET /funcionarios').length;
    await filtrar(pg, 'AFASTADO');
    await filtrar(pg, 'INATIVO');
    await filtrar(pg, '');
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length, antes);
    assert.equal(pg.chamadas.some((c) => /situacao|ativo=/i.test(c.url)), false);
    const CHAVES_DA_INFRAESTRUTURA = ['safework-aparencia', 'epi-session-user'];
    assert.deepEqual(pg.storage.filter((x) => x.storage !== 'cookie' && !CHAVES_DA_INFRAESTRUTURA.includes(x.chave)), []);
  });

  test('o filtro não altera cadastro, edição nem as ações por situação (a ação continua decidida pela situação da linha)', async () => {
    const pg = await pronta({ c: true, e: true });
    await filtrar(pg, 'AFASTADO');
    assert.deepEqual(acoesDaLinha(pg, 'João Pereira'), ['Editar', 'Ativar', 'Inativar']);
    await filtrar(pg, 'INATIVO');
    assert.deepEqual(acoesDaLinha(pg, 'Ana Souza'), ['Editar', 'Ativar']);
    assert.ok(botaoPorTexto(pg, 'Novo colaborador'), 'cadastro disponível');
  });
});
