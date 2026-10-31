'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Cadastro de Colaboradores — janela de confirmação de situação com DATA EFETIVA (RED, especificação 02, decisões D1 a D6).
 *
 * A janela existente (#confirmacaoSituacao, abrirConfirmacao/confirmarSituacao) é reaproveitada; nenhum botão ou tela novos.
 * Contrato de elementos desta janela (ids novos): #cCampoData (contêiner do campo, oculto quando não há data), #cDataRotulo
 * (rótulo), #cData (input type=date), #cDataErro (erro do campo).
 *
 *   Inativar  → "Data efetiva do desligamento", obrigatória; aviso de que deixa de solicitar e receber EPI.
 *   Afastar   → "Data efetiva do afastamento", obrigatória; nenhum outro campo.
 *   Ativar de AFASTADO → "Data efetiva do retorno", obrigatória.
 *   Ativar de INATIVO  → sem campo (operação atual preservada).
 * O campo abre vazio, sempre. Sem motivo, descrição, previsão de retorno nem confirmação de conflito. O servidor é a autoridade:
 * a tela só espelha as regras e mostra textos próprios por código (nunca o texto do servidor).
 */

const ARQUIVO = 'pages/funcionarios.html';

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true, editar: true } }, acoes: {},
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
const pessoa = (id, nome, situacao) => ({
  id, empresaId: 3, matricula: `MAT-${id}`, nome, cpfMascarado: '***.***.***-45', setor: 'Manutenção', funcao: 'Mecânico', telefone: null,
  dataNascimento: null, dataAdmissao: '2020-01-10', cracha: null, situacao, ativo: situacao === 'ATIVO', grupoHomogeneoId: 10, grupoHomogeneo: GHE,
});
const LISTA = [pessoa(1, 'Mauro Ativo', 'ATIVO'), pessoa(2, 'João Afastado', 'AFASTADO'), pessoa(3, 'Ana Inativa', 'INATIVO')];

const SEGREDO = 'TEXTO_SECRETO_DO_SERVIDOR_123';
const erro = (status, codigo, detalhes) => ({ status, corpo: { status: 'error', codigo, message: SEGREDO, ...(detalhes ? { detalhes } : {}) } });
const ok = (id, situacao) => ({ status: 200, corpo: { status: 'ok', funcionario: pessoa(id, LISTA.find((p) => p.id === id).nome, situacao), situacaoAnterior: 'ATIVO' } });

async function abrir(resposta) {
  const estado = { lista: LISTA.map((x) => ({ ...x })) };
  const rotas = {
    'GET /auth/me': { status: 200, corpo: contexto() },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes() },
    'GET /funcionarios': () => ({ status: 200, corpo: { status: 'ok', funcionarios: estado.lista, total: estado.lista.length, pagina: 1, limite: 20 } }),
    'GET /funcionarios/ghes': { status: 200, corpo: { status: 'ok', ghes: [GHE] } },
  };
  for (const alvo of [1, 2, 3]) {
    rotas[`POST /funcionarios/${alvo}/situacao`] = async (chamada) => {
      const r = typeof resposta === 'function' ? await resposta(chamada, alvo) : resposta;
      if (r && r.status === 200) estado.lista = estado.lista.map((f) => (f.id === alvo ? r.corpo.funcionario : f));
      return r ?? ok(alvo, chamada.corpo.situacao);
    };
  }
  const pg = abrirPagina(ARQUIVO, { rotas });
  await pg.esperar();
  await pg.esperar();
  return Object.assign(pg, { estado });
}

const linha = (pg, nome) => pg.consulta('#tbody tr').find((tr) => tr.children[0] && tr.children[0].textContent.trim() === nome);
async function acionar(pg, nome, texto) {
  const tr = linha(pg, nome);
  assert.ok(tr, `linha de ${nome}`);
  const botao = tr.querySelectorAll('button').find((b) => b.textContent.trim().endsWith(texto));
  assert.ok(botao, `botão ${texto} na linha de ${nome}`);
  await botao.disparar('click');
  await pg.esperar();
}
const janelaAberta = (pg) => pg.visivel('confirmacaoSituacao');
const campoVisivel = (pg) => pg.existe('cCampoData') && pg.visivel('cCampoData');
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const erroDoCampo = (pg) => (pg.existe('cDataErro') ? limpo(pg.texto('cDataErro')) : '');
async function informar(pg, valor) {
  assert.ok(pg.existe('cData'), 'a janela precisa do campo #cData');
  pg.el('cData').value = valor;
  await pg.el('cData').disparar('input');
  await pg.el('cData').disparar('change');
}
async function confirmar(pg) {
  await pg.el('cConfirmar').disparar('click');
  await pg.esperar();
}
const envios = (pg, id) => pg.chamadas.filter((c) => c.chave === `POST /funcionarios/${id}/situacao`);
const camposDaJanela = (pg) => ({
  inputs: pg.consulta('#confirmacaoSituacao input').length,
  selects: pg.consulta('#confirmacaoSituacao select').length,
  textareas: pg.consulta('#confirmacaoSituacao textarea').length,
  caixas: pg.consulta('#confirmacaoSituacao input').filter((i) => ['checkbox', 'radio'].includes(i.getAttribute('type'))).length,
});

describe('janela de situação — campos por operação', () => {
  test('Inativar: campo "Data efetiva do desligamento" obrigatório, vazio, e aviso de que deixa de solicitar e receber EPI', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    assert.equal(janelaAberta(pg), true);
    assert.equal(campoVisivel(pg), true, 'o campo de data deve aparecer');
    assert.match(limpo(pg.texto('cDataRotulo')), /Data efetiva do desligamento/i);
    assert.equal(pg.el('cData').getAttribute('type'), 'date');
    assert.equal(pg.el('cData').value, '', 'abre vazio (D5)');
    assert.match(limpo(pg.texto('cTexto')), /deixa(r[áa])? de solicitar e (de )?receber EPI/i);
    assert.deepEqual(camposDaJanela(pg), { inputs: 1, selects: 0, textareas: 0, caixas: 0 }, 'só a data: sem motivo, descrição nem ciência');
  });

  test('Afastar: campo "Data efetiva do afastamento" obrigatório, vazio, e nenhum outro campo', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Afastar');
    assert.equal(campoVisivel(pg), true);
    assert.match(limpo(pg.texto('cDataRotulo')), /Data efetiva do afastamento/i);
    assert.equal(pg.el('cData').value, '');
    assert.deepEqual(camposDaJanela(pg), { inputs: 1, selects: 0, textareas: 0, caixas: 0 }, 'sem motivo, diagnóstico, INSS, acidente, descrição nem previsão de retorno');
  });

  test('Ativar de quem está AFASTADO: campo "Data efetiva do retorno" obrigatório e vazio', async () => {
    const pg = await abrir();
    await acionar(pg, 'João Afastado', 'Ativar');
    assert.equal(campoVisivel(pg), true);
    assert.match(limpo(pg.texto('cDataRotulo')), /Data efetiva do retorno/i);
    assert.equal(pg.el('cData').value, '');
  });

  test('Inativar quem está AFASTADO também pede a data do desligamento', async () => {
    const pg = await abrir();
    await acionar(pg, 'João Afastado', 'Inativar');
    assert.match(limpo(pg.texto('cDataRotulo')), /Data efetiva do desligamento/i);
  });

  test('Ativar de quem está INATIVO: sem campo de data (operação atual preservada)', async () => {
    const pg = await abrir();
    await acionar(pg, 'Ana Inativa', 'Ativar');
    assert.equal(janelaAberta(pg), true);
    assert.equal(campoVisivel(pg), false, 'reativação não é retorno de afastamento nem nova contratação');
    assert.equal(camposDaJanela(pg).selects + camposDaJanela(pg).textareas, 0);
  });

  test('o campo abre vazio em toda abertura: não guarda o valor da operação anterior nem de um cancelamento', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-09-01');
    await pg.el('cCancelar').disparar('click');
    await pg.esperar();
    assert.equal(janelaAberta(pg), false);
    await acionar(pg, 'Mauro Ativo', 'Afastar');
    assert.equal(pg.el('cData').value, '', 'reabertura sem resquício');
    await pg.el('cCancelar').disparar('click');
    await pg.esperar();
    await acionar(pg, 'João Afastado', 'Ativar');
    assert.equal(pg.el('cData').value, '');
  });
});

describe('janela de situação — validação local (o servidor continua a autoridade)', () => {
  test('confirmar sem data não envia nada, mantém a janela aberta e explica no próprio campo', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await confirmar(pg);
    assert.equal(envios(pg, 1).length, 0);
    assert.equal(janelaAberta(pg), true);
    assert.match(erroDoCampo(pg), /\S/);
  });

  test('data futura não é enviada: erro no campo e janela aberta', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Afastar');
    await informar(pg, '2999-01-01');
    await confirmar(pg);
    assert.equal(envios(pg, 1).length, 0);
    assert.equal(janelaAberta(pg), true);
    assert.match(erroDoCampo(pg), /\S/);
  });

  test('data fora do formato AAAA-MM-DD não é enviada', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Afastar');
    for (const ruim of ['2026-02-30', '01/10/2026', 'abc']) {
      await informar(pg, ruim);
      await confirmar(pg);
      assert.equal(envios(pg, 1).length, 0, ruim);
    }
  });

  test('cancelar não envia nada e fecha a janela; clicar no fundo também', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-10-01');
    await pg.el('cCancelar').disparar('click');
    await pg.esperar();
    assert.equal(janelaAberta(pg), false);
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await pg.el('confirmacaoSituacao').disparar('click');
    await pg.esperar();
    assert.equal(janelaAberta(pg), false);
    assert.equal(envios(pg, 1).length, 0);
  });
});

describe('janela de situação — corpo enviado', () => {
  const CASOS = [
    [1, 'Mauro Ativo', 'Inativar', 'INATIVO', '2026-10-01'],
    [1, 'Mauro Ativo', 'Afastar', 'AFASTADO', '2026-10-02'],
    [2, 'João Afastado', 'Ativar', 'ATIVO', '2026-10-03'],
    [2, 'João Afastado', 'Inativar', 'INATIVO', '2026-10-04'],
  ];
  for (const [id, nome, acao, destino, data] of CASOS) {
    test(`${nome}: "${acao}" envia exatamente { situacao: "${destino}", dataEfetiva } e nada mais; depois relê a lista e fecha a janela`, async () => {
      const pg = await abrir();
      const antes = pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length;
      await acionar(pg, nome, acao);
      await informar(pg, data);
      await confirmar(pg);
      const e = envios(pg, id);
      assert.equal(e.length, 1);
      assert.deepEqual(e[0].corpo, { situacao: destino, dataEfetiva: data });
      assert.equal(janelaAberta(pg), false);
      assert.ok(pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length > antes, 'a lista é relida');
      assert.equal(pg.chamadas.some((c) => c.metodo === 'PATCH'), false);
    });
  }

  test('Ativar de INATIVO envia exatamente { situacao: "ATIVO" }, sem dataEfetiva', async () => {
    const pg = await abrir();
    await acionar(pg, 'Ana Inativa', 'Ativar');
    await confirmar(pg);
    const e = envios(pg, 3);
    assert.equal(e.length, 1);
    assert.deepEqual(e[0].corpo, { situacao: 'ATIVO' });
  });
});

describe('janela de situação — respostas do servidor', () => {
  const abrirInativando = async (resposta) => {
    const pg = await abrir(resposta);
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-10-01');
    await confirmar(pg);
    return pg;
  };

  test('400 de data (futura, anterior à admissão, inválida): mensagem própria no campo, janela aberta, data mantida, texto do servidor nunca exibido', async () => {
    for (const codigo of ['DATA_EFETIVA_FUTURA', 'DATA_EFETIVA_ANTERIOR_A_ADMISSAO', 'DATA_EFETIVA_INVALIDA']) {
      const pg = await abrirInativando(erro(400, codigo));
      assert.equal(janelaAberta(pg), true, codigo);
      assert.equal(pg.el('cData').value, '2026-10-01', `${codigo}: o operador não perde o que digitou`);
      assert.match(erroDoCampo(pg), /\S/, codigo);
      assert.equal(pg.textoDoDom().includes(SEGREDO), false, `${codigo}: o texto do servidor não pode aparecer`);
    }
  });

  test('409 de cronologia: orienta com a data mínima aceita, formatada dd/mm/aaaa', async () => {
    const pg = await abrirInativando(erro(409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA', { limite: '2026-09-10' }));
    assert.equal(janelaAberta(pg), true);
    assert.match(erroDoCampo(pg), /10\/09\/2026/);
    assert.equal(pg.el('cData').value, '2026-10-01');
    assert.equal(pg.textoDoDom().includes(SEGREDO), false);
  });

  test('409 de entrega no desligamento: mostra quantas entregas e as datas (dd/mm/aaaa), sem pedir ciência e sem enviar de novo', async () => {
    const pg = await abrirInativando(erro(409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA', { entregasPosteriores: 2, primeiraEntregaEm: '2026-10-05', ultimaEntregaEm: '2026-10-08' }));
    assert.equal(janelaAberta(pg), true);
    const texto = erroDoCampo(pg);
    assert.match(texto, /05\/10\/2026/);
    assert.match(texto, /08\/10\/2026/);
    assert.match(texto, /\b2\b/);
    assert.equal(camposDaJanela(pg).caixas, 0, 'não existe confirmação de conflito');
    assert.equal(envios(pg, 1).length, 1, 'nenhum reenvio automático');
    assert.equal(pg.textoDoDom().includes(SEGREDO), false);
  });

  test('409 de entrega no afastamento: mesmo tratamento, sem caixa de ciência', async () => {
    const pg = await abrir(erro(409, 'AFASTAMENTO_ANTERIOR_A_ENTREGA', { entregasPosteriores: 1, primeiraEntregaEm: '2026-10-05', ultimaEntregaEm: '2026-10-05' }));
    await acionar(pg, 'Mauro Ativo', 'Afastar');
    await informar(pg, '2026-10-01');
    await confirmar(pg);
    assert.equal(janelaAberta(pg), true);
    assert.match(erroDoCampo(pg), /05\/10\/2026/);
    assert.equal(camposDaJanela(pg).caixas, 0);
    assert.equal(envios(pg, 1).length, 1);
  });

  test('estado desatualizado (situação já mudou, data exigida ou não aplicável): fecha, relê a lista e avisa', async () => {
    const codigos = [[409, 'FUNCIONARIO_SITUACAO_IGUAL'], [409, 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA'], [400, 'DATA_EFETIVA_NAO_SE_APLICA'], [400, 'DATA_EFETIVA_OBRIGATORIA']];
    for (const [status, codigo] of codigos) {
      const pg = await abrir(erro(status, codigo));
      const antes = pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length;
      await acionar(pg, 'Mauro Ativo', 'Inativar');
      await informar(pg, '2026-10-01');
      await confirmar(pg);
      assert.equal(janelaAberta(pg), false, codigo);
      assert.ok(pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length > antes, `${codigo}: a lista é relida`);
      assert.match(limpo(pg.texto('toasts')), /\S/, `${codigo}: o operador é avisado`);
      assert.equal(pg.textoDoDom().includes(SEGREDO), false);
    }
  });

  test('403 e 404 avisam com texto próprio e não alteram a lista localmente', async () => {
    const proibido = await abrirInativando(erro(403, 'SEM_PERMISSAO'));
    assert.match(limpo(proibido.texto('toasts')), /permiss/i);
    assert.equal(linha(proibido, 'Mauro Ativo').children[5].textContent.trim(), 'Ativo');
    const sumiu = await abrirInativando(erro(404, 'FUNCIONARIO_NAO_ENCONTRADO'));
    assert.match(limpo(sumiu.texto('toasts')), /n[aã]o encontrado|n[aã]o existe/i);
    assert.equal(proibido.textoDoDom().includes(SEGREDO) || sumiu.textoDoDom().includes(SEGREDO), false);
  });

  test('falha de rede mantém a janela aberta com a data digitada, avisa e permite tentar de novo', async () => {
    const pg = await abrir(() => new Error('queda de rede'));
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-10-01');
    await confirmar(pg);
    assert.equal(janelaAberta(pg), true);
    assert.equal(pg.el('cData').value, '2026-10-01');
    assert.match(`${limpo(pg.texto('toasts'))} ${erroDoCampo(pg)}`, /conex|rede|servidor|tente/i);
    assert.equal(pg.el('cConfirmar').disabled, false, 'o botão volta a funcionar');
  });

  test('duplo clique em Confirmar envia uma única requisição', async () => {
    let liberar;
    const pendente = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrir(async () => { await pendente; return ok(1, 'INATIVO'); });
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-10-01');
    pg.el('cConfirmar').disparar('click');
    pg.el('cConfirmar').disparar('click');
    await pg.esperar();
    assert.equal(envios(pg, 1).length, 1);
    liberar();
    await pg.esperar();
    assert.equal(envios(pg, 1).length, 1);
  });
});

describe('janela de situação — privacidade e preservação', () => {
  test('a data efetiva não vai para localStorage, sessionStorage, cookie, console, URL nem innerHTML', async () => {
    const pg = await abrir();
    await acionar(pg, 'Mauro Ativo', 'Inativar');
    await informar(pg, '2026-10-01');
    await confirmar(pg);
    const CHAVES_DA_INFRAESTRUTURA = ['safework-aparencia', 'epi-session-user'];
    for (const s of pg.storage.filter((x) => x.storage !== 'cookie')) assert.ok(CHAVES_DA_INFRAESTRUTURA.includes(s.chave), JSON.stringify(s));
    assert.equal(JSON.stringify([pg.storage, pg.cookiesEscritos, pg.consoleChamadas]).includes('2026-10-01'), false);
    assert.equal(pg.chamadas.some((c) => c.url.includes('2026-10-01')), false, 'data nunca na URL');
    assert.equal(pg.documento.usosDeInnerHTML.some((u) => /2026-10-01/.test(String(u.valor))), false);
    assert.deepEqual(pg.externas, []);
  });

  test('as ações por situação continuam as mesmas (sem botão novo)', async () => {
    const pg = await abrir();
    const acoes = (nome) => linha(pg, nome).querySelectorAll('button').map((b) => b.textContent.trim()).filter((t) => /(Afastar|Ativar|Inativar)$/.test(t)).map((t) => t.replace(/^.*?(Afastar|Ativar|Inativar)$/, '$1'));
    assert.deepEqual(acoes('Mauro Ativo'), ['Afastar', 'Inativar']);
    assert.deepEqual(acoes('João Afastado'), ['Ativar', 'Inativar']);
    assert.deepEqual(acoes('Ana Inativa'), ['Ativar']);
  });

  test('nenhuma palavra de motivo, diagnóstico, INSS ou acidente aparece na janela de situação', async () => {
    const pg = await abrir();
    for (const [nome, acao] of [['Mauro Ativo', 'Inativar'], ['Mauro Ativo', 'Afastar'], ['João Afastado', 'Ativar']]) {
      await acionar(pg, nome, acao);
      assert.doesNotMatch(limpo(pg.el('confirmacaoSituacao').textContent), /motivo|diagn[oó]stico|\bCID\b|INSS|acidente|descri[cç][aã]o|previs[aã]o de retorno|observa[cç][aã]o/i);
      await pg.el('cCancelar').disparar('click');
      await pg.esperar();
    }
  });
});
