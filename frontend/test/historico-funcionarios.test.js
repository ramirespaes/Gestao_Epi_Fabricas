'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote A+B (RED).
 *
 * A — seleção pelo ID interno real: a busca (nome, matrícula, CPF completo por POST) continua como está; escolher um
 *     resultado, ou o resultado único, consulta GET /funcionarios/:id com o id real; trocar rápido de funcionário, limpar
 *     ou perder a sessão invalida a resposta pendente da seleção anterior.
 * B — ficha cadastral real: a identificação vem do DETALHE (não do objeto resumido da busca) e mostra nome, matrícula,
 *     setor, cargo/função, GHE atual (código e descrição) e situação (Ativo/Afastado/Inativo); ausente vira "—"; nunca
 *     crachá, CPF, telefone, nascimento nem admissão. Estados: nenhum selecionado, carregando, encontrado, 404 (o mesmo
 *     para inexistente e para outra empresa), 403, erro, 401.
 * Visual — o botão Exportar fica oculto (fora do escopo) e a dica da busca sai da linha dos controles para alinhar
 *     Filtrar por, Valor da busca, Limpar e Consultar.
 *
 * Contrato de tela fixado por este RED (ids): historyEmployeeName, historyEmployeeMatricula, historySector (mantidos),
 * historyEmployeeFuncao, historyEmployeeGhe, historyEmployeeSituacao (novos); historyEmployeeBadge deixa de existir.
 * A escolha de um resultado é feita como o usuário faz: clique no botão "Selecionar" com data-id do resultado.
 */

const ARQUIVO = 'pages/employee-history.html';
const CAMPOS = { nome: 'historyEmployeeName', matricula: 'historyEmployeeMatricula', setor: 'historySector', funcao: 'historyEmployeeFuncao', ghe: 'historyEmployeeGhe', situacao: 'historyEmployeeSituacao' };

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = (v = true) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: v } }, acoes: {},
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
const GHE = { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' };
// Resumo da busca (o que GET /funcionarios devolve) e detalhe (GET /funcionarios/:id): valores diferentes de propósito,
// para provar que a ficha vem do detalhe.
const resumo = (extra = {}) => ({
  id: 11, empresaId: 3, nome: 'Ana Souza', matricula: 'M-11', cpfMascarado: '***.***.***-25', setor: 'Setor do resumo', funcao: 'Função do resumo',
  cracha: 'CR-11', telefone: '47999990011', dataNascimento: '1990-03-15', dataAdmissao: '2025-02-01', situacao: 'ATIVO', ativo: true,
  grupoHomogeneoId: 10, grupoHomogeneo: GHE, ...extra,
});
const detalhe = (extra = {}) => resumo({ setor: 'Qualidade', funcao: 'Analista de Qualidade', situacao: 'AFASTADO', ativo: false, ...extra });
const okLista = (itens, total = itens.length) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total, pagina: 1, limite: 20 } });
const okDetalhe = (f) => ({ status: 200, corpo: { status: 'ok', funcionario: f } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });

async function abrir({ v = true, rotas = {} } = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(v) },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const existe = (pg, id) => pg.consulta(`#${id}`).length > 0;
/** Valor exibido de um campo da identificação (input somente leitura ou texto). */
function valor(pg, id) {
  assert.ok(existe(pg, id), `a identificação não tem o campo #${id}`);
  const el = pg.el(id);
  const v = el.localName === 'input' ? el.value : el.textContent;
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}
const identificacao = (pg) => Object.fromEntries(Object.entries(CAMPOS).map(([k, id]) => [k, valor(pg, id)]));
/** Texto visível de um elemento; se ele foi preenchido por innerHTML (que o DOM simulado não interpreta), o último HTML gravado, sem tags. */
function textoDe(pg, id) {
  const dom = existe(pg, id) ? pg.el(id).textContent.replace(/\s+/g, ' ').trim() : '';
  if (dom) return dom;
  const usos = pg.documento.usosDeInnerHTML.filter((u) => u.id === id);
  return usos.length ? usos[usos.length - 1].valor.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
const telaInteira = (pg) => `${pg.textoDoDom()} ${pg.documento.usosDeInnerHTML.map((u) => u.valor).join(' ')}`;
const detalhesPedidos = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+$/.test(c.caminho)).map((c) => Number(c.caminho.split('/').pop()));

// Busca única: `tipo` só registra a intenção do teste; a página reconhece nome, matrícula ou CPF pelo valor.
async function buscar(pg, tipo, texto) {
  pg.el('historySearchValue').value = texto;
  await pg.el('botaoConsultar').disparar('click');
  await pg.esperar();
}
/** Ids oferecidos na lista de resultados (botões "Selecionar" com data-id), pelo DOM ou pelo HTML gravado. */
function idsDosResultados(pg) {
  const dom = pg.consulta('#historyResultados [data-id]').map((b) => b.getAttribute('data-id'));
  if (dom.length) return dom;
  const usos = pg.documento.usosDeInnerHTML.filter((u) => u.id === 'historyResultados');
  const ultimo = usos.length ? usos[usos.length - 1].valor : '';
  return [...ultimo.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
}
/** Clica em "Selecionar" do resultado com o id dado: o botão real, se existir, ou o clique delegado na lista. Não espera a resposta. */
function clicarSelecionar(pg, id) {
  assert.ok(idsDosResultados(pg).includes(String(id)), `o resultado ${id} não está na lista (${idsDosResultados(pg)})`);
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  if (botao) return botao.disparar('click');
  const alvo = { getAttribute: (n) => (n === 'data-id' ? String(id) : null) };
  return pg.el('historyResultados').disparar('click', { target: { closest: () => alvo } });
}
async function selecionar(pg, id) { await clicarSelecionar(pg, id); await pg.esperar(); await pg.esperar(); }

// ═══════════════════════════════════════════════════════════════════
describe('A — seleção pelo ID interno real', () => {
  test('A1 busca por nome continua: GET /funcionarios?busca=<nome>&pagina=1&limite=20', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo(), resumo({ id: 12, nome: 'Ana Lima', matricula: 'M-12' })]) } });
    await buscar(pg, 'nome', 'Ana');
    const lista = pg.chamadas.filter((c) => c.chave === 'GET /funcionarios');
    assert.equal(lista.length, 1);
    assert.match(lista[0].url, /\/funcionarios\?busca=Ana&pagina=1&limite=20$/);
  });

  test('A2 busca por matrícula continua no mesmo caminho', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo(), resumo({ id: 12, nome: 'Ana Lima', matricula: 'M-12' })]) } });
    await buscar(pg, 'matricula', 'M-1');
    assert.match(pg.chamadas.find((c) => c.chave === 'GET /funcionarios').url, /busca=M-1&pagina=1&limite=20$/);
  });

  test('A3 CPF completo continua por POST /funcionarios/consulta-cpf, com o CPF só no corpo (nunca na URL)', async () => {
    const pg = await abrir({ rotas: { 'POST /funcionarios/consulta-cpf': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe()) } });
    await buscar(pg, 'cpf', '529.982.247-25');
    const post = pg.chamadas.find((c) => c.chave === 'POST /funcionarios/consulta-cpf');
    assert.ok(post, 'consulta por CPF');
    assert.deepEqual(post.corpo, { cpf: '52998224725' });
    assert.equal(pg.chamadas.some((c) => /52998224725|529\.982/.test(c.url)), false, 'CPF nunca na URL');
  });

  test('A4 os resultados oferecem a escolha pelo id interno real de cada funcionário', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo({ id: 101 }), resumo({ id: 202, nome: 'Ana Lima' })]) } });
    await buscar(pg, 'nome', 'Ana');
    assert.deepEqual(idsDosResultados(pg), ['101', '202']);
  });

  test('A5 homônimos: escolher o segundo "Ana Souza" consulta o id dele e mostra a ficha dele, não a do primeiro', async () => {
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': okLista([resumo({ id: 11, matricula: 'M-11' }), resumo({ id: 12, matricula: 'M-12' })]),
        'GET /funcionarios/11': okDetalhe(detalhe({ id: 11, matricula: 'M-11', setor: 'Qualidade' })),
        'GET /funcionarios/12': okDetalhe(detalhe({ id: 12, matricula: 'M-12', setor: 'Manutenção' })),
      },
    });
    await buscar(pg, 'nome', 'Ana Souza');
    await selecionar(pg, 12);
    assert.deepEqual(detalhesPedidos(pg), [12]);
    assert.equal(valor(pg, CAMPOS.matricula), 'M-12');
    assert.equal(valor(pg, CAMPOS.setor), 'Manutenção');
  });

  test('A6 escolher um resultado consulta GET /funcionarios/:id com o id real; resultado único também é consultado pelo id', async () => {
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': (c) => (new URL(c.url).searchParams.get('busca') === 'Única' ? okLista([resumo({ id: 77 })]) : okLista([resumo({ id: 11 }), resumo({ id: 12, nome: 'Ana Lima' })])),
        'GET /funcionarios/11': okDetalhe(detalhe({ id: 11 })),
        'GET /funcionarios/77': okDetalhe(detalhe({ id: 77 })),
      },
    });
    await buscar(pg, 'nome', 'Ana');
    await selecionar(pg, 11);
    assert.deepEqual(detalhesPedidos(pg), [11]);
    await buscar(pg, 'nome', 'Única');
    await pg.esperar();
    assert.deepEqual(detalhesPedidos(pg), [11, 77], 'o resultado único também vem do detalhe');
  });

  test('A7/A8 troca rápida A → B: a resposta atrasada de A é descartada e não sobrescreve B', async () => {
    let liberarA;
    const lentaA = new Promise((r) => { liberarA = r; });
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': okLista([resumo({ id: 11, nome: 'Ana Souza' }), resumo({ id: 12, nome: 'Bruno Lima', matricula: 'M-12' })]),
        'GET /funcionarios/11': async () => { await lentaA; return okDetalhe(detalhe({ id: 11, nome: 'Ana Souza', setor: 'Setor de A' })); },
        'GET /funcionarios/12': okDetalhe(detalhe({ id: 12, nome: 'Bruno Lima', matricula: 'M-12', setor: 'Setor de B' })),
      },
    });
    await buscar(pg, 'nome', 'a');
    const pendenteA = clicarSelecionar(pg, 11);
    await pg.esperar();
    await selecionar(pg, 12);
    assert.deepEqual(detalhesPedidos(pg), [11, 12]);
    assert.equal(valor(pg, CAMPOS.nome), 'Bruno Lima');
    liberarA();
    await pendenteA;
    await pg.esperar();
    assert.equal(valor(pg, CAMPOS.nome), 'Bruno Lima', 'A chegou depois e não pode sobrescrever B');
    assert.equal(valor(pg, CAMPOS.setor), 'Setor de B');
    assert.equal(telaInteira(pg).includes('Setor de A'), false);
  });

  test('A9 limpar a seleção invalida a consulta pendente: a resposta que chega depois não preenche nada', async () => {
    let liberar;
    const lenta = new Promise((r) => { liberar = r; });
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': okLista([resumo({ id: 11 }), resumo({ id: 12, nome: 'Ana Lima' })]),
        'GET /funcionarios/11': async () => { await lenta; return okDetalhe(detalhe({ id: 11, setor: 'Não deve aparecer' })); },
      },
    });
    await buscar(pg, 'nome', 'Ana');
    const pendente = clicarSelecionar(pg, 11);
    await pg.esperar();
    assert.deepEqual(detalhesPedidos(pg), [11], 'a seleção consulta o detalhe');
    await pg.el('botaoLimparHistorico').disparar('click');
    await pg.esperar();
    liberar();
    await pendente;
    await pg.esperar();
    for (const id of Object.values(CAMPOS)) assert.match(valor(pg, id), /^(—)?$/, `#${id} vazio depois de limpar`);
    assert.equal(telaInteira(pg).includes('Não deve aparecer'), false);
  });

  test('A10 sessão expirada durante a seleção: nada mais atualiza a tela e a pessoa vai ao Portal', async () => {
    let liberar;
    const lenta = new Promise((r) => { liberar = r; });
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': okLista([resumo({ id: 11 }), resumo({ id: 12, nome: 'Bruno Lima' })]),
        'GET /funcionarios/11': async () => { await lenta; return okDetalhe(detalhe({ id: 11, setor: 'Não deve aparecer' })); },
        'GET /funcionarios/12': erro(401, 'SESSAO_INVALIDA'),
      },
    });
    await buscar(pg, 'nome', 'a');
    const pendente = clicarSelecionar(pg, 11);
    await pg.esperar();
    await selecionar(pg, 12);
    assert.deepEqual(detalhesPedidos(pg), [11, 12]);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), `sessão encerrada leva ao Portal: ${pg.navegacoes}`);
    liberar();
    await pendente;
    await pg.esperar();
    assert.equal(telaInteira(pg).includes('Não deve aparecer'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('B — ficha cadastral real (GET /funcionarios/:id)', () => {
  test('B1 a identificação vem do DETALHE: nome, matrícula, setor, cargo, GHE (código e descrição) e situação', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe()) } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.deepEqual(identificacao(pg), {
      nome: 'Ana Souza', matricula: 'M-11', setor: 'Qualidade', funcao: 'Analista de Qualidade', ghe: 'GHE-010 — Caldeiraria', situacao: 'Afastado',
    });
    assert.equal(telaInteira(pg).includes('Setor do resumo'), false, 'nada do objeto resumido da busca');
  });

  test('B2 situação atual: ATIVO → Ativo, AFASTADO → Afastado, INATIVO → Inativo (do campo situacao do detalhe)', async () => {
    for (const [situacao, rotulo] of [['ATIVO', 'Ativo'], ['AFASTADO', 'Afastado'], ['INATIVO', 'Inativo']]) {
      const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe({ situacao, ativo: situacao === 'ATIVO' })) } });
      await buscar(pg, 'nome', 'Ana');
      await pg.esperar();
      assert.equal(valor(pg, CAMPOS.situacao), rotulo, situacao);
    }
  });

  test('B3 ausências neutras: sem matrícula e sem GHE viram "—"; GHE sem código mostra só a descrição; nada é inventado', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe({ matricula: null, grupoHomogeneoId: null, grupoHomogeneo: null, funcao: null })) } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.equal(valor(pg, CAMPOS.matricula), '—');
    assert.equal(valor(pg, CAMPOS.ghe), '—');
    assert.equal(valor(pg, CAMPOS.funcao), '—');
    const semCodigo = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe({ grupoHomogeneo: { id: 30, codigo: null, descricao: 'Legado sem código' }, grupoHomogeneoId: 30 })) } });
    await buscar(semCodigo, 'nome', 'Ana');
    await semCodigo.esperar();
    assert.equal(valor(semCodigo, CAMPOS.ghe), 'Legado sem código');
  });

  test('B4 a identificação nunca mostra crachá, CPF, telefone, nascimento nem admissão; o campo de crachá deixa de existir', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe()) } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.equal(existe(pg, 'historyEmployeeBadge'), false, 'sem campo de crachá');
    const tela = telaInteira(pg);
    for (const proibido of ['CR-11', '***.***.***-25', '52998224725', '47999990011', '1990-03-15', '15/03/1990', '2025-02-01', '01/02/2025']) {
      assert.equal(tela.includes(proibido), false, `a tela mostra ${proibido}`);
    }
  });

  test('B5 nenhum funcionário selecionado: identificação vazia e nenhuma consulta de detalhe', async () => {
    const pg = await abrir();
    for (const id of Object.values(CAMPOS)) assert.match(valor(pg, id), /^(—)?$/, `#${id}`);
    assert.deepEqual(detalhesPedidos(pg), []);
  });

  test('B6 carregando: enquanto o detalhe não chega a tela avisa e não mostra dados do resumo nem de seleção anterior', async () => {
    let liberar;
    const lenta = new Promise((r) => { liberar = r; });
    const pg = await abrir({
      rotas: {
        'GET /funcionarios': okLista([resumo({ id: 11 }), resumo({ id: 12, nome: 'Bruno Lima' })]),
        'GET /funcionarios/11': okDetalhe(detalhe({ id: 11, setor: 'Setor anterior' })),
        'GET /funcionarios/12': async () => { await lenta; return okDetalhe(detalhe({ id: 12, nome: 'Bruno Lima' })); },
      },
    });
    await buscar(pg, 'nome', 'a');
    await selecionar(pg, 11);
    assert.equal(valor(pg, CAMPOS.setor), 'Setor anterior');
    const pendente = clicarSelecionar(pg, 12);
    await pg.esperar();
    assert.match(telaInteira(pg), /carregando/i);
    assert.equal(valor(pg, CAMPOS.setor) === 'Setor anterior', false, 'a ficha anterior não fica como se fosse do novo');
    assert.equal(valor(pg, CAMPOS.nome) === 'Ana Souza', false);
    liberar();
    await pendente;
    await pg.esperar();
    assert.equal(valor(pg, CAMPOS.nome), 'Bruno Lima');
  });

  test('B7 404 do detalhe (inexistente ou de outra empresa, a mesma resposta): "não encontrado" e nenhuma ficha', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': erro(404, 'FUNCIONARIO_NAO_ENCONTRADO') } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.deepEqual(detalhesPedidos(pg), [11]);
    assert.match(textoDe(pg, 'aviso'), /não encontrado/i);
    for (const id of Object.values(CAMPOS)) assert.match(valor(pg, id), /^(—)?$/, `#${id}`);
  });

  test('B8 403 do detalhe: aviso de permissão, ficha vazia', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': erro(403, 'SEM_PERMISSAO') } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.deepEqual(detalhesPedidos(pg), [11]);
    assert.match(textoDe(pg, 'aviso'), /permiss|não pode/i);
    for (const id of Object.values(CAMPOS)) assert.match(valor(pg, id), /^(—)?$/, `#${id}`);
  });

  test('B9 erro do servidor ou da rede no detalhe: aviso de falha, ficha vazia (nada do resumo)', async () => {
    for (const rota of [erro(500, 'ERRO_INTERNO'), new Error('rede')]) {
      const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': rota } });
      await buscar(pg, 'nome', 'Ana');
      await pg.esperar();
      assert.deepEqual(detalhesPedidos(pg), [11]);
      assert.match(textoDe(pg, 'aviso'), /não foi possível|falha/i);
      for (const id of Object.values(CAMPOS)) assert.match(valor(pg, id), /^(—)?$/, `#${id}`);
    }
  });

  test('B10 401 no detalhe: sessão encerrada, ida ao Portal e nenhuma ficha', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': erro(401, 'SESSAO_INVALIDA') } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.deepEqual(detalhesPedidos(pg), [11]);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });

  test('B11 a página só consulta: nenhuma escrita no cadastro (PATCH, POST de situação ou de revelação)', async () => {
    const pg = await abrir({ rotas: { 'GET /funcionarios': okLista([resumo()]), 'GET /funcionarios/11': okDetalhe(detalhe()) } });
    await buscar(pg, 'nome', 'Ana');
    await pg.esperar();
    assert.equal(pg.chamadas.some((c) => c.metodo === 'PATCH' || /\/situacao$|\/cpf\/revelar$|\/inativar$|\/reativar$/.test(c.caminho)), false);
  });

  test('B12 sem employeeHistory.visualizar: aviso de acesso, nenhuma consulta', async () => {
    const pg = await abrir({ v: false, rotas: { 'GET /funcionarios': okLista([resumo()]) } });
    await buscar(pg, 'nome', 'Ana');
    assert.equal(pg.chamadas.some((c) => /^\/funcionarios/.test(c.caminho)), false);
    assert.match(textoDe(pg, 'aviso'), /permiss/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Visual do pacote A+B', () => {
  test('V1 o botão Exportar fica oculto nesta entrega (a exportação está fora do escopo)', async () => {
    const pg = await abrir();
    const botao = pg.consulta('#botaoExportarHistorico')[0];
    assert.ok(!botao || !pg.visivelNo(botao), 'Exportar não aparece como pronto');
  });

  test('V2 alinhamento: a dica da busca fica fora da linha dos controles, para Filtrar por, Valor da busca, Limpar e Consultar alinharem', async () => {
    // Pela árvore do documento (a expressão regular sobre o HTML não delimitava a linha de filtros com segurança).
    const pg = await abrir();
    const linhas = pg.consulta('.filters-grid');
    assert.equal(linhas.length, 1, 'uma linha de filtros');
    for (const id of ['historySearchValue', 'botaoLimparHistorico', 'botaoConsultar']) {
      assert.equal(pg.consulta(`.filters-grid #${id}`).length, 1, `#${id} na linha dos controles`);
    }
    assert.equal(pg.consulta('.filters-grid .helper').length, 0, 'nenhuma dica dentro da linha dos controles');
  });

  test('V3 a identificação tem os seis campos do contrato e nenhum campo de crachá', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    for (const id of Object.values(CAMPOS)) assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
    assert.equal(/id="historyEmployeeBadge"/.test(html), false);
    assert.equal(/crach[aá]/i.test(html), false, 'sem rótulo de crachá na página');
  });
});
