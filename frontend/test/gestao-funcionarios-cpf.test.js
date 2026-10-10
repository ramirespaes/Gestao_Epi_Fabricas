'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Revelação segura do CPF na edição (RED do frontend). O CPF começa mascarado (***.***.***-XX) e imutável; um ícone de olho,
 * só na EDIÇÃO e só com employeeHistory.editar, chama a rota dedicada POST /funcionarios/:id/cpf/revelar. O CPF completo vive
 * só em memória enquanto revelado: volta à máscara em ~30 s, ao clicar de novo (sem nova requisição), ao fechar/cancelar/salvar,
 * ao trocar de funcionário, ao sair da página, ao perder a sessão, em 401/403/429 e quando a aba fica oculta. Nunca em
 * armazenamento, URL, console, atributo, PATCH, tabela ou busca.
 */

const ARQUIVO = 'pages/funcionarios.html';
const CPF = '52998224725';
const CPF_FORMATADO = '529.982.247-25';
const ROTA = 'POST /funcionarios/1/cpf/revelar';

const GHES = [{ id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' }, { id: 20, codigo: 'GHE-020', descricao: 'Soldagem' }];
const funcionario = (extra = {}) => ({
  id: 1, empresaId: 3, matricula: 'MAT-000171', nome: 'Mauro Teste', cpfMascarado: '***.***.***-45', setor: 'Manutenção', funcao: 'Mecânico',
  telefone: '47991110001', dataNascimento: '1990-03-15', dataAdmissao: '2025-03-10', cracha: null, situacao: 'ATIVO', ativo: true,
  grupoHomogeneoId: 10, grupoHomogeneo: GHES[0], ...extra,
});
const LISTA = [funcionario(), funcionario({ id: 2, nome: 'João Pereira', matricula: 'MAT-000121', cpfMascarado: '***.***.***-56', setor: 'Produção' })];
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ c = false, e = false } = {}) => ({
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
const revelacaoOk = { status: 200, corpo: { status: 'ok', cpf: CPF } };

async function abrir({ c = false, e = true, rotas = {} } = {}) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ c, e }) },
      'GET /funcionarios': (chamada) => {
        const q = new URL(chamada.url).searchParams;
        const pagina = Number(q.get('pagina')) || 1;
        const limite = Number(q.get('limite')) || 20;
        return { status: 200, corpo: { status: 'ok', funcionarios: LISTA.slice((pagina - 1) * limite, pagina * limite), total: LISTA.length, pagina, limite } };
      },
      'GET /funcionarios/ghes': { status: 200, corpo: { status: 'ok', ghes: GHES } },
      [ROTA]: revelacaoOk,
      'PATCH /funcionarios/1': { status: 200, corpo: { status: 'ok', funcionario: funcionario({ setor: 'Produção' }) } },
      ...rotas,
    },
  });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const olho = (pg) => pg.consulta('#btnCpfOlho')[0] ?? null;
const olhoVisivel = (pg) => { const b = olho(pg); return b !== null && pg.visivelNo(b); };
const linhaDe = (pg, nome) => pg.consulta('#tbody tr').find((tr) => tr.children[0] && tr.children[0].textContent.trim() === nome);
async function editar(pg, nome = 'Mauro Teste') {
  const b = linhaDe(pg, nome).querySelectorAll('button').find((x) => x.textContent.trim().endsWith('Editar'));
  assert.ok(b, `Editar na linha de ${nome}`);
  await b.disparar('click');
  await pg.esperar();
}
async function novo(pg) {
  const b = pg.consulta('button').find((x) => x.textContent.includes('Novo colaborador'));
  assert.ok(b, 'Novo colaborador');
  await b.disparar('click');
  await pg.esperar();
}
async function clicarOlho(pg) {
  assert.ok(olho(pg), 'o ícone de olho (#btnCpfOlho) ainda não existe');
  await olho(pg).disparar('click');
  await pg.esperar();
}
const clicar = async (pg, id) => { await pg.el(id).disparar('click'); await pg.esperar(); };
const revelacoes = (pg) => pg.chamadas.filter((c) => c.chave === ROTA);
const cpfNaTela = (pg) => [CPF, CPF_FORMATADO].some((f) => pg.textoDoDom().includes(f) || String(pg.el('fCpf').value).includes(f));
const mascaradoNaTela = (pg) => pg.el('fCpf').value === '***.***.***-45' && !cpfNaTela(pg);
const temporizadorDe30s = (pg) => pg.temporizadoresPendentes().filter((t) => t.ms >= 25000 && t.ms <= 35000);
const mensagens = (pg) => [...pg.consulta('.err').map((e) => e.textContent.trim()), pg.texto('toasts').trim()].filter(Boolean).join(' | ');

describe('CPF na edição — ícone de olho: onde existe', () => {
  test('na edição, com employeeHistory.editar: o olho existe e o CPF começa mascarado, imutável e sem o CPF completo em lugar nenhum', async () => {
    const pg = await abrir({ e: true });
    await editar(pg);
    assert.equal(olhoVisivel(pg), true);
    assert.equal(pg.el('fCpf').value, '***.***.***-45');
    assert.ok(pg.el('fCpf').disabled, 'CPF imutável');
    assert.equal(cpfNaTela(pg), false);
    assert.equal(olho(pg).getAttribute('aria-label'), 'Mostrar CPF');
    assert.equal(olho(pg).getAttribute('aria-pressed'), 'false');
    assert.equal(olho(pg).getAttribute('type'), 'button');
    assert.equal(revelacoes(pg).length, 0, 'nada é consultado só por abrir a edição');
  });

  test('no cadastro não existe revelação: o olho não aparece, nem com criar + editar', async () => {
    const pg = await abrir({ c: true, e: true });
    await novo(pg);
    assert.equal(olhoVisivel(pg), false);
    assert.equal(pg.el('fCpf').disabled, false, 'o CPF é digitável no cadastro');
    assert.equal(revelacoes(pg).length, 0);
    await clicar(pg, 'btnCancelar');
    await editar(pg);
    assert.equal(olhoVisivel(pg), true, 'e volta na edição');
  });

  test('sem employeeHistory.editar não há edição nem olho, e nenhuma revelação é pedida', async () => {
    const pg = await abrir({ c: true, e: false });
    assert.equal(linhaDe(pg, 'Mauro Teste').querySelectorAll('button').some((b) => b.textContent.trim().endsWith('Editar')), false);
    await novo(pg);
    assert.equal(olhoVisivel(pg), false);
    assert.equal(revelacoes(pg).length, 0);
  });
});

describe('CPF na edição — revelar e ocultar', () => {
  test('clique no olho: um POST à rota dedicada (corpo vazio, sem query nem CPF na URL), CPF formatado no campo e temporizador de ~30 s', async () => {
    const pg = await abrir();
    await editar(pg);
    await clicarOlho(pg);
    const chamadas = revelacoes(pg);
    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0].corpo, {});
    assert.equal(chamadas[0].temQuery, false);
    assert.equal(chamadas[0].url.includes(CPF), false);
    assert.equal(pg.el('fCpf').value, CPF_FORMATADO);
    assert.ok(pg.el('fCpf').disabled, 'continua imutável');
    assert.equal(olho(pg).getAttribute('aria-label'), 'Ocultar CPF');
    assert.equal(olho(pg).getAttribute('aria-pressed'), 'true');
    assert.equal(temporizadorDe30s(pg).length, 1, 'um único temporizador de cerca de 30 segundos');
  });

  test('passados os 30 segundos o campo volta à máscara sozinho e o temporizador some', async () => {
    const pg = await abrir();
    await editar(pg);
    await clicarOlho(pg);
    assert.equal(pg.el('fCpf').value, CPF_FORMATADO);
    await pg.avancar(35000);
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(temporizadorDe30s(pg).length, 0);
    assert.equal(olho(pg).getAttribute('aria-label'), 'Mostrar CPF');
    assert.equal(olho(pg).getAttribute('aria-pressed'), 'false');
  });

  test('clicar de novo enquanto revelado oculta na hora, cancela o temporizador e NÃO faz nova requisição; outro clique pede de novo', async () => {
    const pg = await abrir();
    await editar(pg);
    await clicarOlho(pg);
    await clicarOlho(pg);
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(temporizadorDe30s(pg).length, 0);
    assert.equal(revelacoes(pg).length, 1, 'sem nova requisição ao ocultar');
    await clicarOlho(pg);
    assert.equal(revelacoes(pg).length, 2);
    assert.equal(pg.el('fCpf').value, CPF_FORMATADO);
    assert.equal(temporizadorDe30s(pg).length, 1, 'sem temporizadores acumulados');
  });

  test('dois cliques seguidos antes da resposta não geram dois pedidos', async () => {
    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrir({ rotas: { [ROTA]: async () => { await espera; return revelacaoOk; } } });
    await editar(pg);
    assert.ok(olho(pg), 'o ícone de olho (#btnCpfOlho) ainda não existe');
    const primeiro = olho(pg).disparar('click');
    await pg.esperar();
    await olho(pg).disparar('click');
    await pg.esperar();
    assert.equal(revelacoes(pg).length, 1);
    liberar();
    await primeiro;
    await pg.esperar();
    assert.equal(revelacoes(pg).length, 1);
  });
});

describe('CPF na edição — mascarar e limpar a memória nos demais eventos', () => {
  const revelado = async (opcoes) => { const pg = await abrir(opcoes); await editar(pg); await clicarOlho(pg); assert.equal(pg.el('fCpf').value, CPF_FORMATADO); return pg; };
  const semRastro = (pg) => {
    assert.equal(cpfNaTela(pg), false, 'nenhum CPF completo na tela');
    assert.equal(temporizadorDe30s(pg).length, 0, 'sem temporizador');
  };

  test('fechar (X), cancelar, tocar no fundo e Escape: mascara e limpa; reabrir mostra a máscara', async () => {
    for (const fechar of [(pg) => clicar(pg, 'btnFechar'), (pg) => clicar(pg, 'btnCancelar'), (pg) => pg.el('overlay').disparar('click', { target: pg.el('overlay') })]) {
      const pg = await revelado();
      await fechar(pg);
      await pg.esperar();
      semRastro(pg);
      await editar(pg);
      assert.equal(mascaradoNaTela(pg), true, 'reabrir começa mascarado');
    }
    const pg = await revelado();
    for (const fn of (pg.documento.ouvintes.keydown || []).slice()) await fn({ type: 'keydown', key: 'Escape' });
    await pg.esperar();
    semRastro(pg);
  });

  test('salvar: o PATCH nunca leva o CPF (nem revelado), o modal fecha e nada do CPF fica na tela', async () => {
    const pg = await revelado();
    pg.el('fSetor').value = 'Produção';
    await pg.el('fSetor').disparar('input');
    await pg.consulta('button').find((b) => b.textContent.includes('Salvar')).disparar('click');
    await pg.esperar();
    await pg.esperar();
    const envios = pg.chamadas.filter((c) => c.chave === 'PATCH /funcionarios/1');
    assert.equal(envios.length, 1);
    assert.equal(Object.hasOwn(envios[0].corpo, 'cpf'), false);
    assert.equal(envios[0].corpoBruto.includes(CPF), false);
    assert.equal(envios[0].corpoBruto.includes('529'), false);
    semRastro(pg);
  });

  test('trocar de funcionário: abrir a edição de outro pessoa mostra a máscara dela e descarta o CPF anterior', async () => {
    const pg = await revelado();
    await editar(pg, 'João Pereira');
    assert.equal(pg.el('fCpf').value, '***.***.***-56');
    semRastro(pg);
    assert.equal(olho(pg).getAttribute('aria-pressed'), 'false');
  });

  test('aba oculta (visibilitychange) e saída da página (pagehide): mascara e limpa', async () => {
    const pg = await revelado();
    assert.ok((pg.documento.ouvintes.visibilitychange || []).length >= 1, 'a página escuta visibilitychange');
    pg.documento.visibilityState = 'hidden';
    pg.documento.hidden = true;
    for (const fn of (pg.documento.ouvintes.visibilitychange || []).slice()) await fn({ type: 'visibilitychange' });
    await pg.esperar();
    semRastro(pg);

    const saida = await revelado();
    assert.ok(saida.ouvintesDaJanela('pagehide') >= 1, 'a página escuta pagehide');
    await saida.eventoDaJanela('pagehide');
    semRastro(saida);
  });

  test('aba que volta a ficar visível não revela de novo sozinha', async () => {
    const pg = await revelado();
    pg.documento.visibilityState = 'hidden';
    pg.documento.hidden = true;
    for (const fn of (pg.documento.ouvintes.visibilitychange || []).slice()) await fn({ type: 'visibilitychange' });
    pg.documento.visibilityState = 'visible';
    pg.documento.hidden = false;
    for (const fn of (pg.documento.ouvintes.visibilitychange || []).slice()) await fn({ type: 'visibilitychange' });
    await pg.esperar();
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(revelacoes(pg).length, 1);
  });

  test('sessão encerrada durante a revelação (401 em outra chamada) mascara e limpa', async () => {
    const pg = await revelado({ rotas: { 'PATCH /funcionarios/1': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } } } });
    pg.el('fSetor').value = 'Produção';
    await pg.el('fSetor').disparar('input');
    await pg.consulta('button').find((b) => b.textContent.includes('Salvar')).disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    semRastro(pg);
  });

  test('resposta que chega depois de fechar o modal ou de trocar de funcionário é descartada (nunca revela fora de hora)', async () => {
    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrir({ rotas: { [ROTA]: async () => { await espera; return revelacaoOk; } } });
    await editar(pg);
    assert.ok(olho(pg), 'o ícone de olho (#btnCpfOlho) ainda não existe');
    const pendente = olho(pg).disparar('click');
    await pg.esperar();
    await clicar(pg, 'btnCancelar');
    liberar();
    await pendente;
    await pg.esperar();
    semRastro(pg);
    await editar(pg, 'João Pereira');
    assert.equal(pg.el('fCpf').value, '***.***.***-56');
    semRastro(pg);
  });
});

describe('CPF na edição — erros da rota', () => {
  const erro = (status, codigo) => ({ [ROTA]: { status, corpo: { status: 'error', codigo, message: 'x' } } });

  test('401: sessão encerrada (conteúdo some), campo mascarado e nenhuma mensagem com CPF', async () => {
    const pg = await abrir({ rotas: erro(401, 'SESSAO_INVALIDA') });
    await editar(pg);
    await clicarOlho(pg);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(cpfNaTela(pg), false);
    assert.equal(temporizadorDe30s(pg).length, 0);
  });

  test('403: aviso de permissão, campo mascarado, sem CPF e sem temporizador', async () => {
    const pg = await abrir({ rotas: erro(403, 'PERMISSAO_NEGADA') });
    await editar(pg);
    await clicarOlho(pg);
    assert.match(mensagens(pg), /permiss/i);
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(temporizadorDe30s(pg).length, 0);
    assert.equal(olho(pg).getAttribute('aria-pressed'), 'false');
  });

  test('429: aviso de muitas tentativas, campo mascarado, sem CPF e sem temporizador', async () => {
    const pg = await abrir({ rotas: erro(429, 'LIMITE_REQUISICOES_EXCEDIDO') });
    await editar(pg);
    await clicarOlho(pg);
    assert.match(mensagens(pg), /muitas|aguarde|tente novamente/i);
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(temporizadorDe30s(pg).length, 0);
  });

  test('404 só é "colaborador não encontrado" com o código do servidor (FUNCIONARIO_NAO_ENCONTRADO): aí a lista é relida', async () => {
    const pg = await abrir({ rotas: erro(404, 'FUNCIONARIO_NAO_ENCONTRADO') });
    await editar(pg);
    const listagensAntes = pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length;
    await clicarOlho(pg);
    assert.match(mensagens(pg), /não encontrado/i);
    assert.ok(pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length > listagensAntes, 'a lista é relida');
    assert.equal(mascaradoNaTela(pg), true);
  });

  test('rota inexistente no servidor (404 ROTA_NAO_ENCONTRADA, backend desatualizado): texto próprio de indisponibilidade, sem reler a lista e sem dizer que o colaborador sumiu', async () => {
    const pg = await abrir({ rotas: erro(404, 'ROTA_NAO_ENCONTRADA') });
    await editar(pg);
    const listagensAntes = pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length;
    await clicarOlho(pg);
    assert.doesNotMatch(mensagens(pg), /não encontrado|lista foi atualizada/i);
    assert.match(mensagens(pg), /indispon[ií]vel|não está dispon/i);
    assert.equal(pg.chamadas.filter((c) => c.chave === 'GET /funcionarios').length, listagensAntes, 'a lista não é relida');
    assert.equal(pg.visivel('overlay'), true, 'a edição continua aberta');
    assert.equal(mascaradoNaTela(pg), true);
    assert.equal(temporizadorDe30s(pg).length, 0);
  });

  test('404, 500 e falha de rede: aviso genérico, campo mascarado e nenhum dado do servidor ecoado', async () => {
    for (const rotas of [erro(404, 'FUNCIONARIO_NAO_ENCONTRADO'), erro(500, 'ERRO_INTERNO'), { [ROTA]: new Error('rede') }]) {
      const pg = await abrir({ rotas });
      await editar(pg);
      await clicarOlho(pg);
      assert.equal(mascaradoNaTela(pg), true);
      assert.notEqual(mensagens(pg), '', 'o usuário é avisado');
      assert.equal(temporizadorDe30s(pg).length, 0);
    }
  });

  test('resposta fora do contrato (sem CPF de 11 dígitos) não é exibida', async () => {
    for (const corpo of [{ status: 'ok' }, { status: 'ok', cpf: '***' }, { status: 'ok', cpf: 12345 }, { status: 'ok', cpf: '1234567890123' }]) {
      const pg = await abrir({ rotas: { [ROTA]: { status: 200, corpo } } });
      await editar(pg);
      await clicarOlho(pg);
      assert.equal(mascaradoNaTela(pg), true, JSON.stringify(corpo));
      assert.equal(temporizadorDe30s(pg).length, 0);
    }
  });
});

describe('CPF na edição — privacidade', () => {
  test('revelado: nada em armazenamento, cookie, console, URL, atributo HTML/dataset, tabela ou busca', async () => {
    const pg = await abrir();
    await editar(pg);
    await clicarOlho(pg);
    assert.equal(pg.el('fCpf').value, CPF_FORMATADO);
    const INFRA = ['safework-aparencia', 'epi-session-user'];
    assert.deepEqual(pg.storage.filter((x) => x.storage !== 'cookie' && !INFRA.includes(x.chave)), []);
    const gravado = JSON.stringify([pg.storage, pg.cookiesEscritos]);
    assert.equal(gravado.includes(CPF) || gravado.includes(CPF_FORMATADO), false, 'nada em storage nem cookie');
    assert.equal(JSON.stringify(pg.consoleChamadas).includes('529'), false, 'nada no console');
    assert.equal(pg.chamadas.some((c) => c.url.includes(CPF) || c.url.includes('529.982')), false, 'nada em URL');
    const atributos = pg.consulta('*').flatMap((el) => Object.entries(el.atributos || {})).filter(([nome]) => nome !== 'value').map(([, valor]) => String(valor));
    assert.equal(atributos.some((v) => v.includes(CPF) || v.includes(CPF_FORMATADO)), false, 'nenhum atributo, inclusive data-*, guarda o CPF');
    const tabela = pg.consulta('#tbody').map((t) => t.textContent).join(' ');
    assert.equal(tabela.includes('529'), false, 'a tabela nunca mostra CPF');
    await pg.el('q').disparar('input');
    pg.el('q').value = '529.982';
    await pg.el('q').disparar('input');
    assert.match(pg.texto('count').trim(), /^0 de 2/, 'a busca não ganha CPF parcial');
    pg.el('q').value = CPF;
    await pg.el('q').disparar('input');
    assert.match(pg.texto('count').trim(), /^0 de 2/, 'nem CPF completo');
    assert.deepEqual(pg.externas, []);
  });

  test('as chamadas comuns da página continuam sem CPF: a única que o devolve é a rota dedicada, e só POST', async () => {
    const pg = await abrir();
    await editar(pg);
    await clicarOlho(pg);
    const comCpf = pg.chamadas.filter((c) => c.chave.includes('/cpf/'));
    assert.deepEqual(comCpf.map((c) => c.chave), [ROTA]);
    assert.equal(pg.chamadas.some((c) => c.metodo === 'GET' && /cpf/i.test(c.caminho)), false);
  });
});
