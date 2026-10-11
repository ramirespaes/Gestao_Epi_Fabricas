'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — Busca Única (RED, Opção A aprovada).
 *
 * Um campo só, "Buscar colaborador" (placeholder "Nome, CPF ou matrícula"), com Consultar e Limpar; o tipo é
 * classificado automaticamente:
 *   1. só dígitos e pontuação de CPF (. - espaço), 11 dígitos, CPF válido → POST /funcionarios/consulta-cpf, CPF só no
 *      corpo; nunca GET.
 *   2. o mesmo, 11 dígitos, CPF inválido → "CPF inválido", nenhuma requisição.
 *   3. formato característico de CPF (prefixo da máscara 000.000.000-00) com menos de 11 dígitos → "CPF incompleto",
 *      nenhuma requisição.
 *   4. só dígitos, sem máscara, quantidade diferente de 11 → busca textual existente (GET ?busca=).
 *   5. alfanumérico → busca textual existente (nome ou matrícula).
 *   6. vazio → nenhuma consulta, aviso de validação.
 *   Sem fallback de CPF para matrícula; nunca GET e POST juntos. Matrícula só numérica de 11 dígitos não é buscável pelo
 *   número inteiro (limitação aceita).
 * Contrato de tela: #historySearchValue (o campo único), #botaoConsultar, #botaoLimparHistorico; #historyFilterType
 * deixa de existir. Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const CPF_VALIDO = '52998224725';
const CPF_VALIDO_2 = '12345678909';

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: true } }, acoes: {},
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
const funcionario = (id, extra = {}) => ({
  id, empresaId: 3, nome: `Pessoa ${id}`, matricula: `M-${id}`, cpfMascarado: '***.***.***-25', setor: `Setor ${id}`, funcao: `Função ${id}`,
  situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' }, ...extra,
});
const okLista = (itens) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total: itens.length, pagina: 1, limite: 20 } });
const okDetalhe = (f) => ({ status: 200, corpo: { status: 'ok', funcionario: f } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });
const resumo = { totalEntregas: 2, totalItens: 2, ultimaEntregaEm: '2026-03-11T01:30:00.000Z', episDistintos: 1, episDentroPrazoUso: 1 };
const okFichas = (fichaId, funcionarioId) => ({
  status: 200,
  corpo: { status: 'ok', fichas: [{ id: fichaId, numero: 1, funcionarioId, criadaEm: '2026-01-02T12:00:00.000Z', funcionarioAtual: { id: funcionarioId }, resumo }], total: 1, pagina: 1, limite: 1 },
});
const okEntregas = (fichaId, funcionarioId) => ({
  status: 200,
  corpo: {
    status: 'ok', ficha: { id: fichaId, numero: 1, funcionarioId }, total: 1, pagina: 1, limite: 20,
    entregas: [{
      id: 30, ficha: { id: fichaId, numero: 1, funcionarioId }, origem: 'DIRETA', entregueEm: '2026-03-10T13:30:00.000Z', dataOperacional: '2026-03-10',
      empresa: { nome: 'E', cnpj: '11222333000181', endereco: null, cidade: null, uf: null }, trabalhador: { nome: 'T', matricula: null, funcao: null, setor: null },
      ghe: null, responsavel: { id: 7, nome: 'Responsável Fictício' }, confirmacao: null,
      itens: [{ id: 300, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
        material: { nome: 'Luva Fictícia', tipo: 'Luva', codigoInterno: 'LUV-1', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true },
        lote: { tamanho: 'M', caNumero: '1', caValidade: '2030-01-01' }, operacaoId: 1 }],
    }],
  },
});

/** Rotas padrão: busca textual devolve o que `lista` diz; CPF devolve `porCpf`; detalhe, ficha e entregas de cada id. */
function rotas({ lista = [funcionario(11)], porCpf = [funcionario(11)], extra = {} } = {}) {
  const r = {
    'GET /funcionarios': Array.isArray(lista) ? okLista(lista) : lista,
    'POST /funcionarios/consulta-cpf': Array.isArray(porCpf) ? okLista(porCpf) : porCpf,
    'GET /fichas-epi': (c) => {
      const id = Number(new URL(c.url).searchParams.get('funcionarioId'));
      return okFichas(500 + id, id);
    },
  };
  for (const id of [11, 12, 13]) {
    r[`GET /funcionarios/${id}`] = okDetalhe(funcionario(id));
    r[`GET /fichas-epi/${500 + id}/entregas`] = okEntregas(500 + id, id);
  }
  return { ...r, ...extra };
}

async function abrir(opcoes = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      ...rotas(opcoes),
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const aviso = (pg) => (pg.consulta('#aviso').length ? limpo(pg.el('aviso').textContent) : '');
const daBusca = (pg) => pg.chamadas.filter((c) => !c.caminho.startsWith('/auth/'));
const listagens = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho === '/funcionarios');
const porCpf = (pg) => pg.chamadas.filter((c) => c.metodo === 'POST' && c.caminho === '/funcionarios/consulta-cpf');
const detalhes = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/funcionarios\/\d+$/.test(c.caminho)).map((c) => Number(c.caminho.split('/').pop()));
const cards = (pg) => ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((id) => limpo(pg.el(id).textContent));
async function assentar(pg) { for (let i = 0; i < 4; i += 1) await pg.esperar(); }
/** Digita no campo único e clica em Consultar, como a pessoa faz. */
async function buscar(pg, valor) {
  pg.el('historySearchValue').value = valor;
  await pg.el('botaoConsultar').disparar('click');
  await assentar(pg);
}
function buscarSemEsperar(pg, valor) {
  pg.el('historySearchValue').value = valor;
  return pg.el('botaoConsultar').disparar('click');
}
async function selecionar(pg, id) {
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(botao, `o resultado ${id} não está na lista`);
  await botao.disparar('click');
  await assentar(pg);
}
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };
/** Nenhuma URL pede o CPF (com ou sem máscara, inteiro ou em pedaço de 6+ dígitos). */
function semCpfNaUrl(pg, cpf) {
  const pedacos = [cpf, cpf.slice(0, 9), cpf.slice(0, 6), `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}`];
  for (const c of pg.chamadas) {
    const url = decodeURIComponent(c.url);
    for (const p of pedacos) assert.equal(url.includes(p), false, `"${p}" na URL ${c.url}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
describe('U1 — um campo só', () => {
  test('U1.1 a linha de filtros tem um único campo de pesquisa e nenhum seletor "Filtrar por"', async () => {
    const pg = await abrir();
    assert.equal(pg.consulta('#historyFilterType').length, 0, 'sem o seletor de tipo');
    assert.equal(pg.consulta('.filters-grid select').length, 0, 'nenhum select na linha de filtros');
    assert.equal(pg.consulta('.filters-grid input').length, 1, 'um único campo');
    assert.equal(pg.consulta('.filters-grid #historySearchValue').length, 1);
    for (const id of ['botaoConsultar', 'botaoLimparHistorico']) assert.equal(pg.consulta(`.filters-grid #${id}`).length, 1, id);
  });

  test('U1.2 rótulo "Buscar colaborador" ligado ao campo e placeholder "Nome, CPF ou matrícula"', () => {
    const html = semComentariosHtml(ler(ARQUIVO));
    assert.match(html, /<label[^>]*for="historySearchValue"[^>]*>\s*Buscar colaborador\s*<\/label>/);
    assert.match(html, /id="historySearchValue"[^>]*placeholder="Nome, CPF ou matrícula"|placeholder="Nome, CPF ou matrícula"[^>]*id="historySearchValue"/);
    assert.equal(/Filtrar por/.test(html), false, 'sem o rótulo antigo');
    assert.equal(/Valor da busca/.test(html), false, 'sem o rótulo antigo');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U2 — nome e matrícula pela busca textual existente', () => {
  for (const [nome, valor] of [['primeiro nome', 'Adalberto'], ['sobrenome', 'Quintana'], ['fragmento', 'Quint'], ['nome completo', 'Adalberto Quintana']]) {
    test(`U2 ${nome}: GET /funcionarios?busca=<valor>&pagina=1&limite=20, sem consulta por CPF`, async () => {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.equal(porCpf(pg).length, 0);
      assert.equal(listagens(pg).length, 1);
      assert.equal(new URL(listagens(pg)[0].url).searchParams.get('busca'), valor);
    });
  }

  test('U2.1 matrícula alfanumérica: busca textual', async () => {
    const pg = await abrir();
    await buscar(pg, 'MAT-0042');
    assert.equal(porCpf(pg).length, 0);
    assert.equal(new URL(listagens(pg)[0].url).searchParams.get('busca'), 'MAT-0042');
  });

  test('U2.2 matrícula só numérica com quantidade diferente de 11 dígitos (5 e 12): busca textual', async () => {
    for (const valor of ['12345', '123456789012']) {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.equal(porCpf(pg).length, 0, valor);
      assert.equal(new URL(listagens(pg)[0].url).searchParams.get('busca'), valor, valor);
    }
  });

  test('U2.3 matrícula com hífen fora do formato de CPF (2024-001): busca textual, não "CPF incompleto"', async () => {
    const pg = await abrir();
    await buscar(pg, '2024-001');
    assert.equal(porCpf(pg).length, 0);
    assert.equal(new URL(listagens(pg)[0].url).searchParams.get('busca'), '2024-001');
    assert.equal(/CPF/i.test(aviso(pg)), false, aviso(pg));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U3 — CPF completo: só POST, CPF só no corpo', () => {
  for (const [nome, valor] of [['com máscara', '529.982.247-25'], ['sem máscara', CPF_VALIDO], ['com espaços', ' 529 982 247 25 ']]) {
    test(`U3 CPF válido ${nome}: POST /funcionarios/consulta-cpf { cpf } e nenhuma busca textual`, async () => {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.equal(porCpf(pg).length, 1, `uma consulta por CPF: ${daBusca(pg).map((c) => c.chave)}`);
      assert.deepEqual(porCpf(pg)[0].corpo, { cpf: CPF_VALIDO });
      assert.equal(listagens(pg).length, 0, 'nunca GET com o CPF');
      semCpfNaUrl(pg, CPF_VALIDO);
    });
  }

  test('U3.1 CPF válido não encontrado (404): aviso de não encontrado e NENHUM fallback para a busca por matrícula', async () => {
    const pg = await abrir({ porCpf: erro(404, 'FUNCIONARIO_NAO_ENCONTRADO') });
    await buscar(pg, CPF_VALIDO_2);
    assert.equal(porCpf(pg).length, 1);
    assert.deepEqual(porCpf(pg)[0].corpo, { cpf: CPF_VALIDO_2 });
    assert.equal(listagens(pg).length, 0, 'sem fallback CPF → matrícula');
    assert.match(aviso(pg), /não encontrado|nenhum/i);
    semCpfNaUrl(pg, CPF_VALIDO_2);
  });

  test('U3.2 CPF válido sem resultado (lista vazia): aviso e nenhuma busca textual', async () => {
    const pg = await abrir({ porCpf: [] });
    await buscar(pg, CPF_VALIDO);
    assert.equal(listagens(pg).length, 0);
    assert.match(aviso(pg), /nenhum|não encontrado/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U4 — CPF inválido ou incompleto: nenhuma requisição', () => {
  for (const valor of ['529.982.247-26', '52998224726', '11111111111']) {
    test(`U4 "${valor}" (11 dígitos, CPF inválido): "CPF inválido" e nada é enviado`, async () => {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.deepEqual(daBusca(pg), [], `nenhuma requisição: ${daBusca(pg).map((c) => c.url)}`);
      assert.match(aviso(pg), /CPF inválido/);
    });
  }

  test('U4.1 matrícula só numérica de 11 dígitos que não é CPF válido: tratada como CPF ("CPF inválido"), sem GET (limitação aceita)', async () => {
    const pg = await abrir();
    await buscar(pg, '12345678901');
    assert.deepEqual(daBusca(pg), []);
    assert.match(aviso(pg), /CPF inválido/);
  });

  for (const valor of ['529.982.247', '529.982', '529.982.247-2']) {
    test(`U4 "${valor}" (formato de CPF incompleto): "CPF incompleto", nada é enviado, nada na URL`, async () => {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.deepEqual(daBusca(pg), [], `nenhuma requisição: ${daBusca(pg).map((c) => c.url)}`);
      assert.match(aviso(pg), /CPF incompleto/);
    });
  }

  test('U4.3 11 dígitos misturados com letras, sem espaços (529a982b247c25): "CPF inválido", nada enviado, nada na URL', async () => {
    for (const valor of ['529a982b247c25', 'A52998224725']) {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.deepEqual(daBusca(pg), [], `${valor}: nenhuma requisição (${daBusca(pg).map((c) => c.url)})`);
      assert.match(aviso(pg), /CPF inválido/, valor);
    }
  });

  test('U4.4 alfanumérico com quantidade de dígitos diferente de 11 continua na busca textual (controle da regra G)', async () => {
    for (const valor of ['A1B2C3', 'MAT2024001']) {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.equal(porCpf(pg).length, 0, valor);
      assert.equal(new URL(listagens(pg)[0].url).searchParams.get('busca'), valor, valor);
    }
  });

  test('U4.2 vazio ou só espaços: nenhuma consulta e um aviso de validação', async () => {
    for (const valor of ['', '   ']) {
      const pg = await abrir();
      await buscar(pg, valor);
      assert.deepEqual(daBusca(pg), []);
      assert.notEqual(aviso(pg), '', `aviso para "${valor}"`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U5 — resultados e seleção pelo id interno', () => {
  test('U5.1 resultado único por CPF: ficha pelo detalhe do id, histórico de EPIs e indicadores preservados', async () => {
    const pg = await abrir({ porCpf: [funcionario(12)] });
    await buscar(pg, '529.982.247-25');
    assert.deepEqual(detalhes(pg), [12]);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 12');
    assert.deepEqual(pg.consulta('#historyTimeline [data-entrega-id]').map((e) => e.getAttribute('data-entrega-id')), ['30'], 'histórico C');
    assert.deepEqual(cards(pg), ['2', '1', '10/03/2026', '1'], 'indicadores D');
    semCpfNaUrl(pg, CPF_VALIDO);
  });

  test('U5.2 resultado único por nome: abre direto pelo id', async () => {
    const pg = await abrir({ lista: [funcionario(13)] });
    await buscar(pg, 'Pessoa');
    assert.deepEqual(detalhes(pg), [13]);
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 13');
  });

  test('U5.3 vários resultados e homônimos: lista com "Selecionar"; escolher o segundo homônimo consulta o id dele', async () => {
    const pg = await abrir({ lista: [funcionario(11, { nome: 'Rui Homônimo' }), funcionario(12, { nome: 'Rui Homônimo' })] });
    await buscar(pg, 'Rui');
    assert.deepEqual(pg.consulta('#historyResultados [data-id]').map((b) => b.getAttribute('data-id')), ['11', '12']);
    assert.deepEqual(detalhes(pg), []);
    await selecionar(pg, 12);
    assert.deepEqual(detalhes(pg), [12]);
    assert.equal(pg.el('historyEmployeeMatricula').value, 'M-12');
  });

  test('U5.4 nenhum resultado na busca textual: aviso, nenhuma ficha', async () => {
    const pg = await abrir({ lista: [] });
    await buscar(pg, 'Inexistente');
    assert.match(aviso(pg), /nenhum/i);
    assert.deepEqual(detalhes(pg), []);
  });

  test('U5.5 Enter no campo único também consulta, com a mesma classificação (CPF → POST)', async () => {
    const pg = await abrir();
    pg.el('historySearchValue').value = '529.982.247-25';
    await pg.el('historySearchValue').disparar('keydown', { key: 'Enter' });
    await assentar(pg);
    assert.equal(porCpf(pg).length, 1);
    assert.equal(listagens(pg).length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U6 — Limpar, respostas atrasadas e sessão', () => {
  test('U6.1 Limpar esvazia o campo único, a lista, a ficha e os indicadores', async () => {
    const pg = await abrir({ lista: [funcionario(11), funcionario(12)] });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.equal(cards(pg)[0], '2');
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.equal(pg.el('historySearchValue').value, '');
    assert.equal(pg.consulta('#historyResultados [data-id]').length, 0);
    assert.equal(pg.el('historyEmployeeName').value, '');
    assert.deepEqual(cards(pg), ['—', '—', '—', '—']);
  });

  test('U6.2 consulta por CPF atrasada e Limpar: a resposta que chega depois não preenche nada', async () => {
    const a = adiada();
    const pg = await abrir({ porCpf: async () => { await a.p; return okLista([funcionario(11)]); } });
    const pendente = buscarSemEsperar(pg, CPF_VALIDO);
    await assentar(pg);
    assert.equal(porCpf(pg).length, 1);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(detalhes(pg), []);
    assert.equal(pg.el('historyEmployeeName').value, '');
  });

  test('U6.3 busca por CPF atrasada e nova busca por nome: só o resultado da busca mais recente aparece', async () => {
    const a = adiada();
    const pg = await abrir({ porCpf: async () => { await a.p; return okLista([funcionario(11)]); }, lista: [funcionario(13)] });
    const pendente = buscarSemEsperar(pg, CPF_VALIDO);
    await assentar(pg);
    await buscar(pg, 'Pessoa');
    assert.deepEqual(detalhes(pg), [13]);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(detalhes(pg), [13], 'a resposta do CPF chegou depois e foi descartada');
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 13');
  });

  test('U6.4 sessão encerrada (401) na consulta por CPF: ida ao Portal e nada preenchido', async () => {
    const pg = await abrir({ porCpf: erro(401, 'SESSAO_INVALIDA') });
    await buscar(pg, CPF_VALIDO);
    assert.equal(porCpf(pg).length, 1);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    assert.deepEqual(detalhes(pg), []);
  });

  test('U6.5 sessão encerrada (401) na busca textual: ida ao Portal', async () => {
    const pg = await abrir({ lista: () => erro(401, 'SESSAO_INVALIDA') });
    await buscar(pg, 'Pessoa');
    assert.equal(listagens(pg).length, 1);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U7 — erros 403 e rede', () => {
  test('U7.1 403 na consulta por CPF: aviso de permissão, sem fallback e sem ficha', async () => {
    const pg = await abrir({ porCpf: erro(403, 'SEM_PERMISSAO') });
    await buscar(pg, '529.982.247-25');
    assert.equal(porCpf(pg).length, 1);
    assert.equal(listagens(pg).length, 0);
    assert.match(aviso(pg), /permiss|não pode/i);
    assert.deepEqual(detalhes(pg), []);
  });

  test('U7.2 falha de rede na consulta por CPF: aviso de falha, sem fallback', async () => {
    const pg = await abrir({ porCpf: () => new Error('rede') });
    await buscar(pg, CPF_VALIDO);
    assert.equal(listagens(pg).length, 0);
    assert.match(aviso(pg), /falha|não foi possível/i);
  });

  test('U7.3 403 e falha de rede na busca textual: aviso, nenhuma ficha', async () => {
    for (const falha of [erro(403, 'SEM_PERMISSAO'), new Error('rede')]) {
      const pg = await abrir({ lista: () => falha });
      await buscar(pg, 'Pessoa');
      assert.equal(listagens(pg).length, 1);
      assert.match(aviso(pg), /permiss|não pode|falha|não foi possível/i);
      assert.deepEqual(detalhes(pg), []);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('U8 — escopo da mudança', () => {
  test('U8.1 a regra de CPF do tipo explícito em js/funcionarios.js continua igual para quem a usa', () => {
    const F = require('../js/funcionarios');
    assert.deepEqual(F.historico.consulta('cpf', '529.982.247-25'), { ok: true, filtro: { cpf: CPF_VALIDO } });
    assert.deepEqual(F.historico.consulta('nome', '  Silva '), { ok: true, filtro: { busca: 'Silva' } });
    assert.equal(F.historico.consulta('cpf', '529.982').ok, false);
  });

  test('U8.2 a página não guarda o valor buscado no navegador', async () => {
    const pg = await abrir();
    await buscar(pg, '529.982.247-25');
    const js = ler('js/historico-funcionarios.js');
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(js), false);
    assert.equal(porCpf(pg).length, 1, 'a consulta por CPF aconteceu');
  });
});
