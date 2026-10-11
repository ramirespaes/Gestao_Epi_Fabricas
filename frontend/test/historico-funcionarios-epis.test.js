'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote C (RED): Histórico de EPIs do funcionário.
 *
 * Fluxo: id interno do funcionário selecionado → ficha (GET /fichas-epi?funcionarioId=<id>) → entregas da ficha
 * (GET /fichas-epi/:fichaId/entregas?pagina=&limite=), na ordem do servidor (entregue_em DESC, id DESC). Nunca por nome
 * ou matrícula, nunca por GET /entregas-epi/itens. A seção de EPIs exige epiFicha.visualizar; sem ela a ficha cadastral
 * (A+B) continua e a área diz que não há permissão, sem pedir nada às rotas da ficha.
 *
 * Contrato de tela fixado por este RED:
 *   - área: #historyTimeline (a linha do tempo existente);
 *   - cada entrega: um elemento [data-entrega-id="<id>"]; cada item dentro dela: [data-item-id="<id>"];
 *   - paginação: #historyEpisAnterior, #historyEpisProxima (botões) e #historyEpisPagina (texto);
 *   - nova tentativa depois de falha da área de EPIs: #historyEpisTentar;
 *   - sem ficha ou ficha sem entregas: "Nenhuma retirada de EPI registrada para este colaborador.";
 *   - rótulos: "Validade do CA" (do lote) e "Prazo de uso" (do item, em dias) — conceitos diferentes;
 *   - origem: "Direta" e "Por solicitação" (os de js/entregas-epi-historico.js); motivo: os rótulos de js/solicitacoes-epi.js;
 *   - data da entrega em America/Sao_Paulo (dd/mm/aaaa hh:mm), data operacional dd/mm/aaaa.
 * O tamanho do lote é NOT NULL no banco (042): "item sem tamanho" não existe no contrato; o caso abaixo é só defensivo.
 */

const ARQUIVO = 'pages/employee-history.html';
const CAMPOS = { nome: 'historyEmployeeName', matricula: 'historyEmployeeMatricula', setor: 'historySector', funcao: 'historyEmployeeFuncao', ghe: 'historyEmployeeGhe', situacao: 'historyEmployeeSituacao' };
const VAZIO_EPI = 'Nenhuma retirada de EPI registrada para este colaborador.';

// ── servidor falso ─────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ v = true, epi = true } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: v }, epiFicha: { ...NENHUMA, visualizar: epi } }, acoes: {},
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
const funcionario = (id, extra = {}) => ({
  id, empresaId: 3, nome: `Pessoa ${id}`, matricula: `M-${id}`, cpfMascarado: '***.***.***-25', setor: `Setor ${id}`, funcao: `Função ${id}`,
  cracha: null, telefone: null, dataNascimento: null, dataAdmissao: null, situacao: 'ATIVO', ativo: true,
  grupoHomogeneoId: 10, grupoHomogeneo: GHE, ...extra,
});
const okLista = (itens) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total: itens.length, pagina: 1, limite: 20 } });
const okDetalhe = (f) => ({ status: 200, corpo: { status: 'ok', funcionario: f } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'x' } });

/** Ficha da lista GET /fichas-epi (com o resumo que o servidor manda: a tela NÃO o usa para indicadores). */
const ficha = (fichaId, funcionarioId, resumo = { totalEntregas: 5, totalItens: 9, ultimaEntregaEm: '2026-03-10T13:30:00.000Z' }) => ({
  id: fichaId, numero: fichaId - 500, funcionarioId, criadaEm: '2026-01-02T12:00:00.000Z',
  funcionarioAtual: { id: funcionarioId, nome: `Pessoa ${funcionarioId}`, matricula: `M-${funcionarioId}`, cpfMascarado: '***.***.***-25', setor: 'S', funcao: 'F', ativo: true },
  resumo,
});
const okFichas = (fichas) => ({ status: 200, corpo: { status: 'ok', fichas, total: fichas.length, pagina: 1, limite: 20 } });

let seqItem = 9000;
const item = (extra = {}) => {
  const { material = {}, lote = {}, ...resto } = extra;
  seqItem += 1;
  return {
    id: seqItem, materialId: 40, loteId: 70, quantidade: 1, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
    material: { nome: 'Luva Nitrílica', tipo: 'Luva', codigoInterno: 'LUV-001', unidade: 'PAR', prazoUsoDias: 30, oculosComGrau: false, exigeCa: true, ...material },
    lote: { tamanho: 'M', caNumero: '45678', caValidade: '2028-01-31', ...lote },
    operacaoId: 800, ...resto,
  };
};
const entrega = (id, fichaId, funcionarioId, extra = {}) => ({
  id, ficha: { id: fichaId, numero: fichaId - 500, funcionarioId }, origem: 'DIRETA',
  entregueEm: '2026-03-10T13:30:00.000Z', dataOperacional: '2026-03-10',
  empresa: { nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181', endereco: null, cidade: null, uf: null },
  trabalhador: { nome: `Pessoa ${funcionarioId}`, matricula: `M-${funcionarioId}`, funcao: 'F', setor: 'S' },
  ghe: { id: 10, nome: 'Caldeiraria' }, responsavel: { id: 7, nome: 'Responsável Almoxarifado' },
  itens: [item()], confirmacao: null, ...extra,
});
const okEntregas = (fichaId, funcionarioId, entregas, { total = entregas.length, pagina = 1, limite = 20 } = {}) => ({
  status: 200, corpo: { status: 'ok', ficha: { id: fichaId, numero: fichaId - 500, funcionarioId }, entregas, total, pagina, limite },
});

/**
 * Rotas de um ou mais funcionários. Cada funcionário: { id, ficha (id da ficha ou null), entregas (array ou função da
 * página), total, fichas (resposta crua de GET /fichas-epi), paginas (resposta crua por página) }.
 */
function rotasDe(lista, extra = {}) {
  const porId = new Map(lista.map((f) => [String(f.id), f]));
  const rotas = {
    'GET /funcionarios': okLista(lista.map((f) => funcionario(f.id, f.cadastro))),
    'GET /fichas-epi': (c) => {
      const f = porId.get(new URL(c.url).searchParams.get('funcionarioId'));
      if (!f) return okFichas([]);
      if (f.fichas) return typeof f.fichas === 'function' ? f.fichas(c) : f.fichas;
      return okFichas(f.ficha ? [ficha(f.ficha, f.id, f.resumo)] : []);
    },
  };
  for (const f of lista) {
    rotas[`GET /funcionarios/${f.id}`] = f.detalhe || okDetalhe(funcionario(f.id, f.cadastro));
    if (f.ficha) {
      rotas[`GET /fichas-epi/${f.ficha}/entregas`] = (c) => {
        const pagina = Number(new URL(c.url).searchParams.get('pagina') || 1);
        if (f.paginas) return typeof f.paginas === 'function' ? f.paginas(pagina, c) : f.paginas;
        return okEntregas(f.ficha, f.id, typeof f.entregas === 'function' ? f.entregas(pagina) : (f.entregas || []), { total: f.total, pagina });
      };
    }
  }
  return { ...rotas, ...extra };
}

async function abrir({ v = true, epi = true, rotas = {} } = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ v, epi }) },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}

// ── helpers de tela ────────────────────────────────────────────────
const existe = (pg, id) => pg.consulta(`#${id}`).length > 0;
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function valor(pg, id) {
  assert.ok(existe(pg, id), `a identificação não tem o campo #${id}`);
  const el = pg.el(id);
  return limpo(el.localName === 'input' ? el.value : el.textContent);
}
const identificacao = (pg) => Object.fromEntries(Object.entries(CAMPOS).map(([k, id]) => [k, valor(pg, id)]));
const linhaDoTempo = (pg) => (existe(pg, 'historyTimeline') ? limpo(pg.el('historyTimeline').textContent) : '');
const aviso = (pg) => (existe(pg, 'aviso') ? limpo(pg.el('aviso').textContent) : '');
const telaInteira = (pg) => `${pg.textoDoDom()} ${pg.documento.usosDeInnerHTML.map((u) => u.valor).join(' ')}`;
const entregasNaTela = (pg) => pg.consulta('#historyTimeline [data-entrega-id]');
const idsEntregas = (pg) => entregasNaTela(pg).map((e) => e.getAttribute('data-entrega-id'));
const blocoEntrega = (pg, id) => {
  const e = pg.consulta(`#historyTimeline [data-entrega-id="${id}"]`)[0];
  assert.ok(e, `a entrega ${id} não está na linha do tempo (${idsEntregas(pg)})`);
  return e;
};
const textoEntrega = (pg, id) => limpo(blocoEntrega(pg, id).textContent);
const itensDe = (pg, id) => blocoEntrega(pg, id).querySelectorAll('[data-item-id]');
const textoItem = (pg, entregaId, itemId) => {
  const i = blocoEntrega(pg, entregaId).querySelectorAll(`[data-item-id="${itemId}"]`)[0];
  assert.ok(i, `o item ${itemId} não está na entrega ${entregaId}`);
  return limpo(i.textContent);
};
const chamadasFichas = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && c.caminho === '/fichas-epi');
const chamadasEntregas = (pg) => pg.chamadas.filter((c) => c.metodo === 'GET' && /^\/fichas-epi\/\d+\/entregas$/.test(c.caminho));
const rotasDaFicha = (pg) => pg.chamadas.filter((c) => /^\/fichas-epi/.test(c.caminho));
const param = (c, nome) => new URL(c.url).searchParams.get(nome);
/** Botão utilizável: existe, está visível e não está desabilitado. */
const usavel = (pg, id) => existe(pg, id) && pg.visivel(id) && !pg.el(id).disabled;
const SUJEIRA = /\bnull\b|\bundefined\b|NaN|Invalid Date|\[object Object\]/;

async function buscar(pg, texto) {
  pg.el('historySearchValue').value = texto;
  await pg.el('botaoConsultar').disparar('click');
  await pg.esperar();
}
function clicarSelecionar(pg, id) {
  const botao = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(botao, `o resultado ${id} não está na lista`);
  return botao.disparar('click');
}
async function selecionar(pg, id) { await clicarSelecionar(pg, id); for (let i = 0; i < 4; i += 1) await pg.esperar(); }
async function assentar(pg) { for (let i = 0; i < 4; i += 1) await pg.esperar(); }
/** Abre a página e seleciona o único funcionário da lista (resultado único é consultado pelo id). */
async function abrirCom(lista, opcoes = {}) {
  const pg = await abrir({ ...opcoes, rotas: rotasDe(lista, opcoes.rotas) });
  await buscar(pg, 'Pessoa');
  await assentar(pg);
  return pg;
}
async function clicar(pg, id) { await pg.el(id).disparar('click'); await assentar(pg); }

// ═══════════════════════════════════════════════════════════════════
describe('C1 — fluxo: funcionário → ficha → entregas', () => {
  test('C1.1 a ficha é procurada pelo id interno do funcionário selecionado (funcionarioId), nunca por nome ou matrícula', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    const fichas = chamadasFichas(pg);
    assert.equal(fichas.length, 1, `uma consulta da ficha: ${pg.chamadas.map((c) => c.url)}`);
    assert.equal(param(fichas[0], 'funcionarioId'), '11');
    for (const proibido of ['busca', 'numero']) assert.equal(param(fichas[0], proibido), null, `sem ${proibido}`);
  });

  test('C1.2 as entregas vêm da ficha do funcionário (id da ficha, não o do funcionário), página 1, com limite explícito', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    const lista = chamadasEntregas(pg);
    assert.equal(lista.length, 1, 'uma página de entregas');
    assert.equal(lista[0].caminho, '/fichas-epi/511/entregas');
    assert.equal(param(lista[0], 'pagina'), '1');
    const limite = Number(param(lista[0], 'limite'));
    assert.ok(Number.isInteger(limite) && limite >= 1 && limite <= 100, `limite entre 1 e 100: ${limite}`);
    assert.equal(param(lista[0], 'de'), null, 'sem filtro de período nesta entrega');
    assert.equal(param(lista[0], 'ate'), null);
  });

  test('C1.3 nunca usa GET /entregas-epi/itens nem /entregas-epi/:id como fonte da linha do tempo', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.equal(pg.chamadas.some((c) => /^\/entregas-epi/.test(c.caminho)), false, String(pg.chamadas.map((c) => c.url)));
    assert.deepEqual(idsEntregas(pg), ['30']);
  });

  test('C1.4 ficha de OUTRO funcionário na resposta não é usada: nenhuma entrega é pedida nem mostrada', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, fichas: okFichas([ficha(599, 99)]), entregas: [entrega(30, 511, 11)] }],
      { rotas: { 'GET /fichas-epi/599/entregas': okEntregas(599, 99, [entrega(77, 599, 99)]) } });
    assert.equal(chamadasFichas(pg).length, 1, 'a ficha foi procurada');
    assert.equal(chamadasEntregas(pg).length, 0, 'a ficha 599 é do funcionário 99');
    assert.deepEqual(idsEntregas(pg), []);
  });

  test('C1.5 a linha do tempo deixa de dizer que o histórico "ainda não está disponível"', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.equal(/ainda não está disponível/i.test(linhaDoTempo(pg)), false, linhaDoTempo(pg));
  });

  test('C1.6 a lógica da seção de EPIs fica em js/historico-funcionarios.js, não em js/funcionarios.js', () => {
    assert.match(ler('js/historico-funcionarios.js'), /\/fichas-epi/);
    assert.equal(/\/fichas-epi/.test(ler('js/funcionarios.js')), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C2 — permissão da seção de EPIs (epiFicha.visualizar)', () => {
  test('C2.1 sem epiFicha.visualizar: a ficha cadastral aparece, a área diz "sem permissão" e nenhuma rota da ficha é chamada', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }], { epi: false });
    assert.equal(valor(pg, CAMPOS.nome), 'Pessoa 11', 'A+B continua');
    assert.equal(rotasDaFicha(pg).length, 0, 'nenhuma chamada às rotas da ficha');
    assert.match(linhaDoTempo(pg), /permiss/i);
    assert.equal(linhaDoTempo(pg).includes(VAZIO_EPI), false, 'sem permissão não é "nenhuma retirada"');
    assert.equal(/\b0\b/.test(linhaDoTempo(pg)), false, 'nunca "0 entregas"');
    assert.equal(/ainda não está disponível/i.test(linhaDoTempo(pg)), false);
  });

  test('C2.2 403 da ficha (permissão retirada no servidor): "sem permissão", nunca "nenhuma retirada"; a ficha cadastral fica', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, fichas: erro(403, 'SEM_PERMISSAO') }]);
    assert.equal(chamadasFichas(pg).length, 1);
    assert.match(linhaDoTempo(pg), /permiss/i);
    assert.equal(linhaDoTempo(pg).includes(VAZIO_EPI), false);
    assert.equal(valor(pg, CAMPOS.nome), 'Pessoa 11');
  });

  test('C2.3 403 das entregas: "sem permissão", nunca "nenhuma retirada"; a ficha cadastral fica', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, paginas: erro(403, 'SEM_PERMISSAO') }]);
    assert.equal(chamadasEntregas(pg).length, 1);
    assert.match(linhaDoTempo(pg), /permiss/i);
    assert.equal(linhaDoTempo(pg).includes(VAZIO_EPI), false);
    assert.equal(valor(pg, CAMPOS.nome), 'Pessoa 11');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C3 — sem ficha ou sem entregas', () => {
  test('C3.1 funcionário sem ficha: mensagem neutra, sem erro e sem pedir entregas', async () => {
    const pg = await abrirCom([{ id: 11, ficha: null }]);
    assert.equal(chamadasFichas(pg).length, 1);
    assert.equal(chamadasEntregas(pg).length, 0);
    assert.ok(linhaDoTempo(pg).includes(VAZIO_EPI), linhaDoTempo(pg));
    assert.equal(aviso(pg), '', 'não é erro');
    assert.equal(valor(pg, CAMPOS.nome), 'Pessoa 11');
  });

  test('C3.2 ficha sem entregas: a mesma mensagem neutra, sem paginação', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [], total: 0 }]);
    assert.equal(chamadasEntregas(pg).length, 1);
    assert.ok(linhaDoTempo(pg).includes(VAZIO_EPI), linhaDoTempo(pg));
    assert.equal(aviso(pg), '');
    assert.equal(usavel(pg, 'historyEpisProxima'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C4 — dados de cada entrega e de cada item', () => {
  test('C4.1 uma entrega, um item: data da entrega (São Paulo), data operacional, origem, responsável e GHE da entrega', async () => {
    // 01:30 UTC de 11/03 = 22:30 de 10/03 em São Paulo: a data é a operacional, nunca a de UTC.
    const e = entrega(30, 511, 11, { entregueEm: '2026-03-11T01:30:00.000Z', dataOperacional: '2026-03-10', ghe: { id: 10, nome: 'Caldeiraria congelada' } });
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [e] }]);
    const t = textoEntrega(pg, 30);
    assert.match(t, /10\/03\/2026/);
    assert.match(t, /22:30/);
    assert.equal(/11\/03\/2026/.test(t), false, 'a data não é a de UTC');
    assert.match(t, /Direta/);
    assert.match(t, /Responsável Almoxarifado/);
    assert.match(t, /Caldeiraria congelada/);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('C4.2 item: material, código interno, quantidade com unidade, tamanho, CA e validade do CA, prazo de uso, motivo', async () => {
    const i = item({ id: 9101, quantidade: 3, motivo: 'SUBSTITUICAO_PRAZO', material: { nome: 'Botina de Segurança', codigoInterno: 'BOT-042', unidade: 'PAR', prazoUsoDias: 180 }, lote: { tamanho: '42', caNumero: '12345', caValidade: '2027-05-31' } });
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens: [i] })] }]);
    const t = textoItem(pg, 30, 9101);
    assert.match(t, /Botina de Segurança/);
    assert.match(t, /BOT-042/);
    assert.match(t, /\b3\b/);
    assert.match(t, /PAR/);
    assert.match(t, /\b42\b/);
    assert.match(t, /12345/);
    assert.match(t, /Validade do CA[^0-9]*31\/05\/2027/i, 'validade do CA (do lote)');
    assert.match(t, /Prazo de uso[^0-9]*180 dias/i, 'prazo de uso (do item), em dias');
    assert.match(t, /Substituição por prazo/);
    assert.equal(SUJEIRA.test(t), false, t);
  });

  test('C4.3 validade do CA e prazo de uso não se confundem: a data do CA não aparece como prazo nem o prazo como validade', async () => {
    const i = item({ id: 9102, material: { prazoUsoDias: 90 }, lote: { caValidade: '2029-12-31' } });
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens: [i] })] }]);
    const t = textoItem(pg, 30, 9102);
    assert.equal(/Prazo de uso[^0-9]*31\/12\/2029/i.test(t), false);
    assert.equal(/Validade do CA[^0-9]*90 dias/i.test(t), false);
    assert.match(t, /Prazo de uso[^0-9]*90 dias/i);
    assert.match(t, /Validade do CA[^0-9]*31\/12\/2029/i);
  });

  test('C4.4 item sem CA (lote sem CA): nada inventado, nem "null" nem data inválida', async () => {
    const i = item({ id: 9103, material: { exigeCa: false, nome: 'Creme de Proteção' }, lote: { caNumero: null, caValidade: null } });
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens: [i] })] }]);
    const t = textoItem(pg, 30, 9103);
    assert.match(t, /Creme de Proteção/);
    assert.equal(SUJEIRA.test(t), false, t);
    assert.equal(/45678|2028/.test(t), false, 'nenhum CA de outro item');
  });

  test('C4.5 item com tamanho e item sem tamanho (defensivo: o contrato exige tamanho, a tela não quebra)', async () => {
    const comTamanho = item({ id: 9104, lote: { tamanho: 'GG' } });
    const semTamanho = item({ id: 9105, lote: { tamanho: null } });
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens: [comTamanho, semTamanho] })] }]);
    assert.match(textoItem(pg, 30, 9104), /\bGG\b/);
    assert.equal(SUJEIRA.test(textoItem(pg, 30, 9105)), false, textoItem(pg, 30, 9105));
  });

  test('C4.6 motivos diferentes com os rótulos do sistema; justificativa aparece quando existe', async () => {
    const itens = [
      item({ id: 9201, motivo: 'ADMISSAO' }),
      item({ id: 9202, motivo: 'DESGASTE_DANO' }),
      item({ id: 9203, motivo: 'PERDA_EXTRAVIO' }),
      item({ id: 9204, motivo: 'OUTRO', justificativa: 'Troca solicitada pela supervisão' }),
    ];
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens })] }]);
    assert.match(textoItem(pg, 30, 9201), /Admissão/);
    assert.match(textoItem(pg, 30, 9202), /Desgaste ou dano/);
    assert.match(textoItem(pg, 30, 9203), /Perda ou extravio/);
    assert.match(textoItem(pg, 30, 9204), /Outro/);
    assert.match(textoItem(pg, 30, 9204), /Troca solicitada pela supervisão/);
    for (const id of [9201, 9202, 9203, 9204]) assert.equal(/ADMISSAO|DESGASTE_DANO|PERDA_EXTRAVIO|\bOUTRO\b/.test(textoItem(pg, 30, id)), false, 'nunca o código cru');
  });

  test('C4.7 origem DIRETA e SOLICITACAO com os rótulos do sistema', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(31, 511, 11, { origem: 'SOLICITACAO' }), entrega(30, 511, 11, { origem: 'DIRETA' })] }]);
    assert.match(textoEntrega(pg, 31), /Por solicitação/);
    assert.match(textoEntrega(pg, 30), /Direta/);
    assert.equal(/SOLICITACAO|DIRETA/.test(linhaDoTempo(pg)), false, 'nunca o código cru');
  });

  test('C4.8 entrega sem GHE congelado: nada inventado', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { ghe: null })] }]);
    const t = textoEntrega(pg, 30);
    assert.equal(SUJEIRA.test(t), false, t);
    assert.equal(t.includes('Caldeiraria'), false, 'o GHE atual do cadastro não vira o GHE da entrega');
  });

  test('C4.9 não inventa devolução, baixa, encerramento, "em uso" nem substituição', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    assert.equal(/devolu|baixa|encerrad|em uso|substitu[ií]d/i.test(linhaDoTempo(pg)), false, linhaDoTempo(pg));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C5 — cada ato separado, na ordem do servidor', () => {
  test('C5.1 uma entrega com vários itens: todos dentro da mesma entrega', async () => {
    const itens = [item({ id: 9301, material: { nome: 'Capacete' } }), item({ id: 9302, material: { nome: 'Óculos de Proteção Incolor' } }), item({ id: 9303, material: { nome: 'Protetor Auricular' } })];
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11, { itens })] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    assert.deepEqual(itensDe(pg, 30).map((i) => i.getAttribute('data-item-id')), ['9301', '9302', '9303']);
  });

  test('C5.2 várias entregas na ordem do servidor (mais recente primeiro), sem reordenar', async () => {
    const entregas = [
      entrega(40, 511, 11, { entregueEm: '2026-03-10T18:00:00.000Z', dataOperacional: '2026-03-10' }),
      entrega(39, 511, 11, { entregueEm: '2026-03-10T12:00:00.000Z', dataOperacional: '2026-03-10' }),
      entrega(12, 511, 11, { entregueEm: '2026-01-05T12:00:00.000Z', dataOperacional: '2026-01-05' }),
    ];
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas }]);
    assert.deepEqual(idsEntregas(pg), ['40', '39', '12']);
  });

  test('C5.3 o mesmo material em entregas diferentes e quantidade > 1: cada ato fica separado, nada é somado', async () => {
    const entregas = [
      entrega(41, 511, 11, { itens: [item({ id: 9401, quantidade: 2 })] }),
      entrega(40, 511, 11, { itens: [item({ id: 9402, quantidade: 1 })] }),
    ];
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas }]);
    assert.deepEqual(idsEntregas(pg), ['41', '40']);
    assert.match(textoItem(pg, 41, 9401), /\b2\b/);
    assert.match(textoItem(pg, 40, 9402), /\b1\b/);
    assert.equal(/\b3\b/.test(textoItem(pg, 41, 9401)), false, 'nada somado');
  });

  // Adaptação autorizada no GREEN D: antes os cards ficavam "—" (o C não podia antecipar o D); agora vêm do resumo real
  // da ficha, e a linha do tempo continua sem fabricar indicadores.
  test('C5.4 os indicadores vêm do resumo da ficha, não da linha do tempo: a página com 1 entrega não muda os valores do resumo', async () => {
    const resumoReal = { totalEntregas: 5, totalItens: 9, ultimaEntregaEm: '2026-03-10T13:30:00.000Z', episDistintos: 3, episDentroPrazoUso: 2 };
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 45, resumo: resumoReal, entregas: [entrega(30, 511, 11)] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    const cards = ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((id) => limpo(pg.el(id).textContent));
    assert.deepEqual(cards, ['5', '3', '10/03/2026', '2'], 'os valores do resumo, não os da página exibida (1 entrega, 1 item)');
    assert.equal(chamadasEntregas(pg).length, 1, 'nenhuma página além da primeira é lida para calcular os cards');
    assert.equal(entregasNaTela(pg).length, 1, 'a linha do tempo não ganha entregas para os indicadores');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C6 — paginação real', () => {
  const pagina = (fichaId, funcionarioId, base) => (p) => Array.from({ length: p < 3 ? 20 : 5 }, (_, k) => entrega(base - ((p - 1) * 20) - k, fichaId, funcionarioId));

  test('C6.1 carrega só a primeira página; com total maior, oferece a próxima sem carregar as demais em silêncio', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 45, entregas: pagina(511, 11, 1000) }]);
    assert.equal(chamadasEntregas(pg).length, 1, 'uma página só');
    assert.equal(entregasNaTela(pg).length, 20);
    assert.ok(usavel(pg, 'historyEpisProxima'), 'próxima disponível');
    assert.equal(usavel(pg, 'historyEpisAnterior'), false, 'na primeira página não há anterior');
    assert.match(limpo(pg.el('historyEpisPagina').textContent), /1\D+3/);
  });

  test('C6.2 próxima página pede pagina=2 da MESMA ficha e troca o conteúdo', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 45, entregas: pagina(511, 11, 1000) }]);
    await clicar(pg, 'historyEpisProxima');
    const ultima = chamadasEntregas(pg).at(-1);
    assert.equal(ultima.caminho, '/fichas-epi/511/entregas');
    assert.equal(param(ultima, 'pagina'), '2');
    assert.equal(idsEntregas(pg)[0], '980');
    assert.equal(idsEntregas(pg).includes('1000'), false, 'a página 1 sai da tela');
    assert.ok(usavel(pg, 'historyEpisAnterior'));
  });

  test('C6.3 na última página não há "próxima" falsa', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 45, entregas: pagina(511, 11, 1000) }]);
    await clicar(pg, 'historyEpisProxima');
    await clicar(pg, 'historyEpisProxima');
    assert.equal(param(chamadasEntregas(pg).at(-1), 'pagina'), '3');
    assert.equal(entregasNaTela(pg).length, 5);
    assert.equal(usavel(pg, 'historyEpisProxima'), false);
  });

  test('C6.4 total exatamente igual a uma página: nenhuma próxima página', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, total: 20, entregas: () => Array.from({ length: 20 }, (_, k) => entrega(500 - k, 511, 11)) }]);
    assert.equal(entregasNaTela(pg).length, 20);
    assert.equal(usavel(pg, 'historyEpisProxima'), false);
  });

  test('C6.5 trocar de funcionário volta à página 1 do novo, pela ficha do novo', async () => {
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, total: 45, entregas: pagina(511, 11, 1000) },
      { id: 12, ficha: 512, total: 45, entregas: pagina(512, 12, 2000) },
    ]) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    await clicar(pg, 'historyEpisProxima');
    await selecionar(pg, 12);
    const ultima = chamadasEntregas(pg).at(-1);
    assert.equal(ultima.caminho, '/fichas-epi/512/entregas');
    assert.equal(param(ultima, 'pagina'), '1');
    assert.equal(idsEntregas(pg)[0], '2000');
    assert.equal(idsEntregas(pg).some((id) => Number(id) < 1100), false, 'nada do funcionário anterior');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C7 — respostas atrasadas (anti-stale)', () => {
  const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: () => liberar() }; };

  test('C7.1 ficha de A atrasada: B selecionado mostra só B; a ficha de A que chega depois não pede nem mostra nada de A', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, fichas: async () => { await a.p; return okFichas([ficha(511, 11)]); }, entregas: [entrega(30, 511, 11)] },
      { id: 12, ficha: 512, entregas: [entrega(60, 512, 12)] },
    ]) });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await selecionar(pg, 12);
    assert.deepEqual(idsEntregas(pg), ['60']);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), ['60'], 'nada de A depois de B');
    assert.equal(chamadasEntregas(pg).some((c) => c.caminho === '/fichas-epi/511/entregas'), false, 'a ficha atrasada de A não dispara a busca das entregas de A');
  });

  test('C7.2 entregas de A atrasadas: B selecionado mostra só B; as entregas de A que chegam depois são descartadas', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, paginas: async () => { await a.p; return okEntregas(511, 11, [entrega(30, 511, 11)]); } },
      { id: 12, ficha: 512, entregas: [entrega(60, 512, 12)] },
    ]) });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    assert.equal(chamadasEntregas(pg).length, 1, 'as entregas de A foram pedidas');
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), ['60']);
    assert.equal(valor(pg, CAMPOS.nome), 'Pessoa 12');
  });

  test('C7.3 página 2 de A atrasada: trocar para B descarta a página de A', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, paginas: async (p) => { if (p === 2) await a.p; return okEntregas(511, 11, [entrega(p === 2 ? 29 : 30, 511, 11)], { total: 25, pagina: p }); } },
      { id: 12, ficha: 512, entregas: [entrega(60, 512, 12)] },
    ]) });
    await buscar(pg, 'Pessoa');
    await selecionar(pg, 11);
    assert.deepEqual(idsEntregas(pg), ['30']);
    const pendente = pg.el('historyEpisProxima').disparar('click');
    await assentar(pg);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), ['60']);
  });

  test('C7.4 Limpar invalida as entregas pendentes: a resposta que chega depois não aparece', async () => {
    const a = adiada();
    const pg = await abrirCom([{ id: 11, ficha: 511, paginas: async () => { await a.p; return okEntregas(511, 11, [entrega(30, 511, 11)]); } }]);
    assert.equal(chamadasEntregas(pg).length, 1);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    a.liberar();
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), []);
  });

  test('C7.5 nova busca invalida as entregas pendentes', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe(
      [{ id: 11, ficha: 511, paginas: async () => { await a.p; return okEntregas(511, 11, [entrega(30, 511, 11)]); } }],
      { 'GET /funcionarios': (c) => (new URL(c.url).searchParams.get('busca') === 'Pessoa' ? okLista([funcionario(11)]) : okLista([])) },
    ) });
    await buscar(pg, 'Pessoa');
    await assentar(pg);
    assert.equal(chamadasEntregas(pg).length, 1);
    await buscar(pg, 'Outra');
    a.liberar();
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), []);
  });

  test('C7.6 sessão encerrada (401 em outra consulta): as entregas pendentes não aparecem depois', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, paginas: async () => { await a.p; return okEntregas(511, 11, [entrega(30, 511, 11)]); } },
      { id: 12, ficha: 512, detalhe: erro(401, 'SESSAO_INVALIDA') },
    ]) });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    assert.equal(chamadasEntregas(pg).length, 1);
    await selecionar(pg, 12);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), []);
  });

  test('C7.7 erro atrasado de A não aparece para B', async () => {
    const a = adiada();
    const pg = await abrir({ rotas: rotasDe([
      { id: 11, ficha: 511, paginas: async () => { await a.p; return erro(500, 'ERRO_INTERNO'); } },
      { id: 12, ficha: 512, entregas: [entrega(60, 512, 12)] },
    ]) });
    await buscar(pg, 'Pessoa');
    const pendente = clicarSelecionar(pg, 11);
    await assentar(pg);
    await selecionar(pg, 12);
    a.liberar();
    await pendente;
    await assentar(pg);
    assert.deepEqual(idsEntregas(pg), ['60']);
    assert.equal(/não foi possível|falha/i.test(linhaDoTempo(pg)), false, linhaDoTempo(pg));
    assert.equal(existe(pg, 'historyEpisTentar') && pg.visivel('historyEpisTentar'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C8 — erros da área de EPIs', () => {
  const casos = [
    ['500 da ficha', { fichas: erro(500, 'ERRO_INTERNO') }],
    ['rede na ficha', { fichas: new Error('rede') }],
    ['500 das entregas', { paginas: erro(500, 'ERRO_INTERNO') }],
    ['rede nas entregas', { paginas: new Error('rede') }],
    ['resposta vazia das entregas', { paginas: { status: 200, corpo: {} } }],
    ['resposta vazia da ficha', { fichas: { status: 200, corpo: {} } }],
  ];
  for (const [nome, falha] of casos) {
    test(`C8 ${nome}: falha na área de EPIs, nunca "nenhuma retirada"; a ficha cadastral continua`, async () => {
      const pg = await abrirCom([{ id: 11, ficha: 511, ...falha }]);
      assert.match(linhaDoTempo(pg), /não foi possível|falha/i, linhaDoTempo(pg));
      assert.equal(linhaDoTempo(pg).includes(VAZIO_EPI), false);
      assert.deepEqual(identificacao(pg), { nome: 'Pessoa 11', matricula: 'M-11', setor: 'Setor 11', funcao: 'Função 11', ghe: 'GHE-010 — Caldeiraria', situacao: 'Ativo' });
      assert.ok(usavel(pg, 'historyEpisTentar'), 'é possível tentar de novo');
    });
  }

  test('C8.1 tentar de novo recarrega a área de EPIs do MESMO funcionário e mostra as entregas', async () => {
    let falhar = true;
    const pg = await abrirCom([{ id: 11, ficha: 511, paginas: () => (falhar ? erro(500, 'ERRO_INTERNO') : okEntregas(511, 11, [entrega(30, 511, 11)])) }]);
    assert.ok(usavel(pg, 'historyEpisTentar'));
    const detalhesAntes = pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length;
    falhar = false;
    await clicar(pg, 'historyEpisTentar');
    assert.deepEqual(idsEntregas(pg), ['30']);
    assert.equal(chamadasEntregas(pg).at(-1).caminho, '/fichas-epi/511/entregas');
    assert.equal(pg.chamadas.filter((c) => c.caminho === '/funcionarios/11').length, detalhesAntes, 'a ficha cadastral não é recarregada');
  });

  test('C8.2 401 nas entregas: sessão encerrada e ida ao Portal', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, paginas: erro(401, 'SESSAO_INVALIDA') }]);
    assert.equal(chamadasEntregas(pg).length, 1);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });

  test('C8.3 401 na ficha: sessão encerrada e ida ao Portal', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, fichas: erro(401, 'SESSAO_INVALIDA') }]);
    assert.equal(chamadasFichas(pg).length, 1);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('C9 — limites visuais e de escopo', () => {
  test('C9.1 a área é montada com nós e texto (sem innerHTML) e sem dados sujos', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => u.id === 'historyTimeline'), false);
    assert.equal(SUJEIRA.test(linhaDoTempo(pg)), false, linhaDoTempo(pg));
  });

  test('C9.2 sem exportação, sem filtro de período e sem escrita: Exportar segue oculto e nenhuma chamada além de GET', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    const exportar = pg.consulta('#botaoExportarHistorico')[0];
    assert.ok(!exportar || !pg.visivelNo(exportar));
    assert.equal(pg.chamadas.some((c) => !['GET', 'POST'].includes(c.metodo) || (c.metodo === 'POST' && c.caminho !== '/funcionarios/consulta-cpf')), false);
  });

  test('C9.3 o CPF do funcionário (cadastro atual na ficha) nunca aparece na área de EPIs', async () => {
    const pg = await abrirCom([{ id: 11, ficha: 511, entregas: [entrega(30, 511, 11)] }]);
    assert.deepEqual(idsEntregas(pg), ['30']);
    assert.equal(/\*\*\*\.\*\*\*/.test(telaInteira(pg)), false);
  });
});
