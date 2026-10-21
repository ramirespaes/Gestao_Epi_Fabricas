'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Etapa H (frontend) — a Central Administrativa do Atendimento Token (pages/atendimento-token.html) aberta como o
 * navegador abriria, com um servidor falso que repete os contratos das rotas reais (Etapas B, C e H do backend). Cobre:
 * abertura protegida e permissões por aba, as seis abas, dispositivos (cadastro, edição, revogação), ativação (QR, prazo,
 * descarte do código), redes autorizadas (aviso da última rede), prévia somente leitura e as abas reservadas à Etapa J.
 * A validação visual por pessoas está em H-GREEN-FRONTEND/ROTEIRO-VALIDACAO-MANUAL.md.
 */

const PAGINA = 'pages/atendimento-token.html';
const SEGREDO = 'CODIGO-DE-ATIVACAO-SECRETO-0123456789abcdef';

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ recurso = {}, acoes = {}, funcionarios = false, perfil = 'ADMINISTRADOR' } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil,
  recursos: { atendimentoToken: { ...NENHUMA, ...recurso }, employeeHistory: { ...NENHUMA, visualizar: funcionarios } },
  acoes,
  administracao: { gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false), autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false } },
});
const TUDO = permissoes({
  recurso: { visualizar: true, criar: true, editar: true },
  acoes: { TOKEN_REVOGAR_DISPOSITIVO: true, TOKEN_GERAR_ATIVACAO: true, TOKEN_GERENCIAR_REDES: true, TOKEN_PREVIA_CATALOGO_REAL: true },
  funcionarios: true,
});
const SO_LEITURA = permissoes({ recurso: { visualizar: true } });

const dispositivo = (id, nome, situacao, extra = {}) => ({
  id, identificador: `ident-${id}`, nome, unidade: 'Fábrica 1', setor: 'Expedição', localInstalacao: `Portaria ${id}`, fabricante: 'Samsung', modelo: 'Tab A', numeroSerie: `SN${id}`,
  situacao, comunicacao: { registrada: false, ultimoContatoEm: null }, ativadoEm: situacao === 'PENDENTE' ? null : '2026-10-01T12:00:00.000Z',
  revogadoEm: situacao === 'REVOGADO' ? '2026-10-05T12:00:00.000Z' : null, criadoPor: 7, revogadoPor: null, criadoEm: '2026-09-30T12:00:00.000Z', atualizadoEm: '2026-10-01T12:00:00.000Z', ...extra,
});
const rede = (id, endereco, ativa, extra = {}) => ({ id, tipo: 'IP_FIXO', endereco, descricao: ativa ? `Rede ${id}` : null, ativa, criadaEm: '2026-10-01T12:00:00.000Z', desativadaEm: ativa ? null : '2026-10-03T12:00:00.000Z', ...extra });
const funcionario = (id, nome, extra = {}) => ({ id, nome, matricula: `M${id}`, cpfMascarado: '***.***.***-12', setor: 'Produção', funcao: 'Operador', situacao: 'ATIVO', ativo: true, grupoHomogeneo: { id: 2, descricao: 'GHE Produção' }, ...extra });
const NENHUMA_ATIVACAO = { estado: 'NENHUMA', geradaEm: null, expiraEm: null, usadaEm: null, canceladaEm: null };

function servidor(base = {}) {
  const s = {
    dispositivos: [dispositivo(1, 'Tablet Portaria', 'ATIVO'), dispositivo(2, 'Tablet Expedição', 'PENDENTE'), dispositivo(3, 'Tablet Antigo', 'REVOGADO')],
    redes: [rede(11, '203.0.113.10', true), rede(12, '203.0.113.11', false)],
    ativacoes: { 1: { estado: 'CONSUMIDA', geradaEm: '2026-10-01T11:50:00.000Z', expiraEm: '2026-10-01T12:00:00.000Z', usadaEm: '2026-10-01T11:55:00.000Z', canceladaEm: null } },
    funcionarios: [funcionario(31, 'Ana Silva'), funcionario(32, 'Bruno Lima', { situacao: 'INATIVO', ativo: false })],
    previas: { 31: { estado: 'OK', total: 2, materiais: [
      { id: 5, nome: 'Luva Nitrílica', unidade: 'par', categoria: 'EPI', tipo: { id: 1, nome: 'Luva' }, exigeTamanho: true, tamanhos: ['P', 'M', 'G'], imagem: { disponivel: false } },
      { id: 6, nome: 'Capacete', unidade: 'un', categoria: 'EPI', tipo: { id: 2, nome: 'Capacete' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
    ] } },
    proximoId: 100,
    expiraEmMs: 5 * 60 * 1000,
    forcar: {},
    ...base,
  };
  const ok = (corpo, status = 200) => ({ status, corpo: { status: 'ok', ...corpo } });
  const erro = (status, codigo, detalhes) => ({ status, corpo: { status: 'error', codigo, message: 'TEXTO CRU DO SERVIDOR', ...(detalhes ? { detalhes } : {}) } });
  const pagina = (itens, c) => {
    const q = new URL(c.url).searchParams;
    const p = Number(q.get('pagina') || 1); const l = Number(q.get('limite') || 20);
    return { itens: itens.slice((p - 1) * l, p * l), total: itens.length, pagina: p, limite: l };
  };
  const idDe = (chave, depois = '') => Number(new RegExp(`/(\\d+)${depois}$`).exec(chave.split(' ')[1])[1]);
  const achar = (id) => s.dispositivos.find((d) => d.id === id);
  const visao = () => {
    const d = s.dispositivos;
    const cont = (f) => d.filter(f).length;
    const cadastrados = d.length; const ativos = cont((x) => x.situacao === 'ATIVO');
    return { dispositivos: { cadastrados, ativos, pendentes: cont((x) => x.situacao === 'PENDENTE'), revogados: cont((x) => x.situacao === 'REVOGADO') }, ativacoesPendentes: Object.values(s.ativacoes).filter((a) => a.estado === 'PENDENTE').length, situacaoGeral: cadastrados === 0 ? 'SEM_DISPOSITIVOS' : (ativos === 0 ? 'SEM_DISPOSITIVO_ATIVO' : 'COM_DISPOSITIVO_ATIVO') };
  };
  const tabela = [
    [/^GET \/auth\/me$/, () => ok({ usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: s.perfil || 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } })],
    [/^GET \/auth\/global\/me$/, () => ok({ empresas: [{ id: 3 }] })],
    [/^GET \/auth\/permissoes$/, () => ({ status: 200, corpo: s.permissoes })],
    [/^GET \/atendimento-token\/visao-geral$/, () => ok({ visaoGeral: visao() })],
    [/^GET \/atendimento-token\/dispositivos$/, (c) => { const r = pagina(s.dispositivos, c); return ok({ dispositivos: r.itens, total: r.total, pagina: r.pagina, limite: r.limite }); }],
    [/^POST \/atendimento-token\/dispositivos$/, (c) => {
      if (s.dispositivos.some((d) => d.nome === c.corpo.nome)) return erro(409, 'DISPOSITIVO_NOME_EM_USO');
      const novo = dispositivo(s.proximoId, c.corpo.nome, 'PENDENTE', { unidade: c.corpo.unidade ?? null, setor: c.corpo.setor ?? null, localInstalacao: c.corpo.localInstalacao ?? null, fabricante: c.corpo.fabricante ?? null, modelo: c.corpo.modelo ?? null, numeroSerie: c.corpo.numeroSerie ?? null });
      s.proximoId += 1; s.dispositivos.push(novo);
      return ok({ dispositivo: novo }, 201);
    }],
    [/^GET \/atendimento-token\/dispositivos\/\d+$/, (c) => { const d = achar(idDe(c.chave)); return d ? ok({ dispositivo: d }) : erro(404, 'DISPOSITIVO_NAO_ENCONTRADO'); }],
    [/^PATCH \/atendimento-token\/dispositivos\/\d+$/, (c) => {
      const d = achar(idDe(c.chave));
      if (!d) return erro(404, 'DISPOSITIVO_NAO_ENCONTRADO');
      if (d.situacao === 'REVOGADO') return erro(409, 'DISPOSITIVO_REVOGADO');
      if (c.corpo.nome && s.dispositivos.some((x) => x.id !== d.id && x.nome === c.corpo.nome)) return erro(409, 'DISPOSITIVO_NOME_EM_USO');
      Object.assign(d, c.corpo);
      return ok({ dispositivo: d, alterado: true });
    }],
    [/^POST \/atendimento-token\/dispositivos\/\d+\/revogar$/, (c) => {
      const d = achar(idDe(c.chave, '/revogar'));
      if (!d) return erro(404, 'DISPOSITIVO_NAO_ENCONTRADO');
      const antes = d.situacao;
      d.situacao = 'REVOGADO'; d.revogadoEm = '2026-10-12T12:00:00.000Z';
      return ok({ dispositivo: d, alterado: antes !== 'REVOGADO' });
    }],
    [/^GET \/atendimento-token\/dispositivos\/\d+\/ativacao$/, (c) => { const id = idDe(c.chave, '/ativacao'); return achar(id) ? ok({ ativacao: s.ativacoes[id] || NENHUMA_ATIVACAO }) : erro(404, 'DISPOSITIVO_NAO_ENCONTRADO'); }],
    [/^POST \/atendimento-token\/dispositivos\/\d+\/ativacao$/, (c) => {
      const id = idDe(c.chave, '/ativacao');
      const d = achar(id);
      if (!d) return erro(404, 'DISPOSITIVO_NAO_ENCONTRADO');
      if (d.situacao === 'REVOGADO') return erro(409, 'DISPOSITIVO_REVOGADO');
      const expira = new Date(Date.now() + s.expiraEmMs).toISOString();
      s.ativacoes[id] = { estado: 'PENDENTE', geradaEm: new Date().toISOString(), expiraEm: expira, usadaEm: null, canceladaEm: null };
      return ok({ ativacao: { dispositivoId: id, codigo: SEGREDO, expiraEm: expira } }, 201);
    }],
    [/^GET \/atendimento-token\/redes$/, (c) => { const r = pagina(s.redes, c); return ok({ redes: r.itens, total: r.total, pagina: r.pagina, limite: r.limite }); }],
    [/^POST \/atendimento-token\/redes$/, (c) => {
      if (s.redes.some((r) => r.ativa && r.endereco === c.corpo.rede)) return erro(409, 'REDE_JA_AUTORIZADA');
      const nova = rede(s.proximoId, c.corpo.rede, true, { descricao: c.corpo.descricao ?? null });
      s.proximoId += 1; s.redes.unshift(nova);
      return ok({ rede: nova }, 201);
    }],
    [/^POST \/atendimento-token\/redes\/\d+\/desativar$/, (c) => {
      const r = s.redes.find((x) => x.id === idDe(c.chave, '/desativar'));
      if (!r) return erro(404, 'REDE_NAO_ENCONTRADA');
      const alterado = r.ativa; r.ativa = false; r.desativadaEm = '2026-10-12T12:00:00.000Z';
      return ok({ rede: r, alterado });
    }],
    [/^GET \/atendimento-token\/previa\/catalogo$/, (c) => {
      const id = Number(new URL(c.url).searchParams.get('funcionarioId'));
      const f = s.funcionarios.find((x) => x.id === id);
      if (!f) return erro(404, 'FUNCIONARIO_NAO_ENCONTRADO');
      if (f.situacao !== 'ATIVO') return erro(409, 'FUNCIONARIO_NAO_ELEGIVEL');
      return ok({ previa: { catalogo: s.previas[id] || { estado: 'SEM_GHE', total: 0, materiais: [] } } });
    }],
    [/^GET \/funcionarios$/, (c) => {
      const termo = (new URL(c.url).searchParams.get('busca') || '').toLowerCase();
      const achados = s.funcionarios.filter((f) => f.nome.toLowerCase().includes(termo) || f.matricula.toLowerCase().includes(termo));
      return ok({ funcionarios: achados, total: achados.length, pagina: 1, limite: 20 });
    }],
  ];
  const rotas = new Proxy({}, {
    get: (_, chave) => {
      if (typeof chave !== 'string') return undefined;
      if (Object.hasOwn(s.forcar, chave)) return s.forcar[chave];
      const achada = tabela.find(([re]) => re.test(chave));
      if (!achada) return undefined;
      return (c) => achada[1]({ ...c, chave });
    },
  });
  s.rotas = rotas;
  s.ok = ok;
  s.erro = erro;
  return s;
}

async function abrir({ perm = TUDO, base = {}, perfil, hash } = {}) {
  const s = servidor({ permissoes: perm, perfil, ...base });
  const pg = abrirPagina(PAGINA, {
    rotas: s.rotas,
    ...(hash === undefined ? {} : { hash }),
    // Só para o teste: guarda a instância da tela para conferir que o código não fica retido na memória.
    transformar: (relativo, codigo) => {
      if (relativo !== 'js/atendimento-token-tela.js') return codigo;
      const alvo = 'global.EpiAtendimentoTokenTela = { criar: criar, TEXTOS: TEXTOS };';
      assert.ok(codigo.includes(alvo), 'o ponto de exportação da tela mudou');
      return codigo.replace(alvo, 'global.EpiAtendimentoTokenTela = { criar: function (o) { var t = criar(o); global.__tela = t; return t; }, TEXTOS: TEXTOS };');
    },
  });
  await pg.esperar();
  return { pg, s };
}

const aba = async (pg, nome) => { await pg.clicar(`aba-${nome}`); };
// Gerar uma ativação: se o dispositivo já está ativo ou com ativação pendente, a tela pede confirmação antes.
const gerar = async (pg) => { await pg.clicar('botaoGerarAtivacao'); if (pg.visivel('modalConfirmar')) await pg.clicar('botaoConfirmar'); };
// A infraestrutura das páginas (tema, sessão) mexe no armazenamento ao carregar; o que interessa é que a Central não acrescente nada.
const marcaDeArmazenamento = (pg) => ({ storage: pg.storage.length, cookies: pg.cookiesEscritos.length, consoles: pg.consoleChamadas.length });
const semNovosRastros = (pg, marca) => {
  assert.deepEqual(pg.storage.slice(marca.storage), []);
  assert.equal(pg.storage.some((e) => e.operacao === 'setItem'), false, 'nenhuma escrita em armazenamento');
  assert.deepEqual(pg.cookiesEscritos.slice(marca.cookies), []);
  // O único registro permitido é o do cliente HTTP compartilhado: método, caminho e status (nunca corpo nem consulta).
  for (const c of pg.consoleChamadas.slice(marca.consoles)) assert.match(c.texto, /^%c\[HTTP\] (GET|POST|PATCH) \/[^?\s]* → \d{3} color:#[0-9A-Fa-f]{6}$/, c.texto);
};
const chamadasDe = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
const daCentral = (pg) => pg.chamadas.filter((c) => c.caminho.startsWith('/atendimento-token'));
const botoes = (pg, seletor) => pg.consulta(seletor);
const linha = (pg, corpo, id, atributo = 'data-dispositivo-id') => pg.consulta(`#${corpo} tr[${atributo}="${id}"]`)[0];
const ABAS_DA_CENTRAL = ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem'];
const visiveisAbas = (pg) => ABAS_DA_CENTRAL.filter((a) => pg.visivel(`aba-${a}`));
const painelAberto = (pg) => ABAS_DA_CENTRAL.filter((a) => pg.visivel(`painel-${a}`));
const aviso = (pg, id) => pg.el(id).textContent;

describe('abertura protegida e permissões', () => {
  test('com tudo permitido: as sete abas, a Visão Geral aberta e o menu com "Atendimento Token" como página atual', async () => {
    const { pg } = await abrir();
    assert.deepEqual(visiveisAbas(pg), ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem']);
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.el('aba-visaoGeral').getAttribute('aria-selected'), 'true');
    const item = pg.consulta('.nav a[data-pagina="atendimentoToken"]')[0];
    assert.equal(pg.visivelNo(item), true);
    assert.equal(item.textContent.includes('Atendimento Token'), true);
    assert.equal(item.classList.contains('active'), true);
  });

  test('sem nenhuma permissão da Central: acesso negado, conteúdo oculto e nenhuma chamada à Central', async () => {
    const { pg } = await abrir({ perm: permissoes() });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.match(pg.texto('estadoPagina'), /não tem permissão/);
    assert.equal(daCentral(pg).length, 0);
  });

  test('o MASTER não é presumido: perfil MASTER sem as linhas de permissão não abre a Central', async () => {
    const { pg } = await abrir({ perm: permissoes({ perfil: 'MASTER' }), perfil: 'MASTER' });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(daCentral(pg).length, 0);
  });

  test('só visualizar: Visão Geral, Dispositivos, Ativação (sem gerar e sem redes) e as abas reservadas; sem Prévia', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    assert.deepEqual(visiveisAbas(pg), ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'historico']);
    await aba(pg, 'dispositivos');
    assert.equal(pg.visivel('botaoNovoDispositivo'), false);
    assert.deepEqual(botoes(pg, '#corpoDispositivos [data-acao]').map((b) => b.getAttribute('data-acao')), ['detalhes', 'detalhes', 'detalhes']);
    await aba(pg, 'ativacao');
    assert.equal(pg.visivel('botaoGerarAtivacao'), false);
    assert.equal(pg.visivel('blocoRedes'), false);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/redes').length, 0);
  });

  test('só a prévia: abre direto na Prévia; nenhuma leitura de visão geral, dispositivos ou redes', async () => {
    const { pg } = await abrir({ perm: permissoes({ acoes: { TOKEN_PREVIA_CATALOGO_REAL: true }, funcionarios: true }) });
    assert.deepEqual(visiveisAbas(pg), ['monitoramento', 'previa', 'historico', 'visualizarTotem']);
    assert.deepEqual(painelAberto(pg), ['monitoramento']);
    assert.equal(daCentral(pg).length, 0);
  });

  test('só gerar ativação: a aba Ativação abre sem lista de dispositivos, explicando por quê, e sem chamada de leitura', async () => {
    const { pg } = await abrir({ perm: permissoes({ acoes: { TOKEN_GERAR_ATIVACAO: true } }) });
    assert.deepEqual(visiveisAbas(pg), ['ativacao', 'monitoramento', 'historico']);
    assert.deepEqual(painelAberto(pg), ['ativacao']);
    assert.match(pg.texto('ativacaoSemLista'), /permissão de visualizar dispositivos/);
    assert.equal(daCentral(pg).length, 0);
  });

  test('só gerenciar redes: a Ativação mostra apenas as redes', async () => {
    const { pg } = await abrir({ perm: permissoes({ acoes: { TOKEN_GERENCIAR_REDES: true } }) });
    assert.equal(pg.visivel('blocoRedes'), true);
    assert.equal(pg.visivel('blocoSelecaoAtivacao'), false);
    assert.deepEqual(daCentral(pg).map((c) => c.chave), ['GET /atendimento-token/redes']);
  });

  test('sessão sem as permissões (401): vai ao Portal, nada é carregado', async () => {
    const s = servidor({ permissoes: TUDO });
    s.forcar['GET /auth/permissoes'] = { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA' } };
    const pg = abrirPagina(PAGINA, { rotas: s.rotas });
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(daCentral(pg).length, 0);
  });
});

describe('Visão Geral', () => {
  test('mostra os números reais do servidor e a situação; não inventa online/offline', async () => {
    const { pg } = await abrir();
    const cartoes = Object.fromEntries(pg.consulta('#visaoGeralCartoes .stat').map((c) => [c.querySelector('span').textContent, c.querySelector('strong').textContent]));
    assert.deepEqual(cartoes, { 'Dispositivos cadastrados': '3', 'Dispositivos ativos': '1', 'Aguardando ativação': '1', 'Dispositivos revogados': '1', 'Ativações pendentes': '0' });
    assert.equal(pg.texto('visaoGeralSituacao'), 'Há ao menos um dispositivo ativo.');
    assert.equal(/online|offline/i.test(pg.el('painel-visaoGeral').textContent.replace(/Não mostra se estão online[^.]*\./, '')), false);
  });

  test('empresa sem dispositivo: zeros VERDADEIROS (o servidor respondeu), com a situação "nenhum cadastrado"', async () => {
    const { pg } = await abrir({ base: { dispositivos: [] } });
    assert.equal(pg.consulta('#visaoGeralCartoes strong').every((n) => n.textContent === '0'), true);
    assert.equal(pg.texto('visaoGeralSituacao'), 'Nenhum dispositivo cadastrado.');
  });

  test('falha do servidor NÃO vira zero: estado de erro, sem cartões', async () => {
    const s = servidor({ permissoes: TUDO });
    s.forcar['GET /atendimento-token/visao-geral'] = { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'detalhe interno' } };
    const pg = abrirPagina(PAGINA, { rotas: s.rotas });
    await pg.esperar();
    assert.equal(pg.visivel('conteudo-visaoGeral'), false);
    assert.match(pg.texto('estado-visaoGeral'), /Tente novamente/);
    assert.equal(pg.textoDoDom().includes('detalhe interno'), false);
  });

  test('resposta fora do formato: erro, nunca números inventados; "Atualizar" lê de novo', async () => {
    const s = servidor({ permissoes: TUDO });
    s.forcar['GET /atendimento-token/visao-geral'] = { status: 200, corpo: { status: 'ok', visaoGeral: { dispositivos: { cadastrados: 'x' } } } };
    const pg = abrirPagina(PAGINA, { rotas: s.rotas });
    await pg.esperar();
    assert.equal(pg.visivel('conteudo-visaoGeral'), false);
    assert.match(pg.texto('estado-visaoGeral'), /formato inesperado/);
    delete s.forcar['GET /atendimento-token/visao-geral'];
    await pg.clicar('botaoAtualizarVisaoGeral');
    assert.equal(pg.visivel('conteudo-visaoGeral'), true);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/visao-geral').length, 2);
  });

  test('403 do servidor: estado de acesso negado', async () => {
    const s = servidor({ permissoes: TUDO });
    s.forcar['GET /atendimento-token/visao-geral'] = { status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA' } };
    const pg = abrirPagina(PAGINA, { rotas: s.rotas });
    await pg.esperar();
    assert.equal(pg.el('estado-visaoGeral').querySelector('[data-estado]').getAttribute('data-estado'), 'acesso-negado');
  });
});

describe('Dispositivos', () => {
  test('lista com situação, local e ações conforme a permissão; revogado só tem "Detalhes"', async () => {
    const { pg } = await abrir();
    await aba(pg, 'dispositivos');
    assert.equal(pg.consulta('#corpoDispositivos tr').length, 3);
    const acoesDe = (id) => botoes(pg, `#corpoDispositivos tr[data-dispositivo-id="${id}"] [data-acao]`).map((b) => b.getAttribute('data-acao'));
    assert.deepEqual(acoesDe(1), ['editar', 'revogar']);
    assert.deepEqual(acoesDe(2), ['editar', 'revogar']);
    assert.deepEqual(acoesDe(3), ['detalhes']);
    const situacoes = pg.consulta('#corpoDispositivos .badge').map((b) => b.textContent);
    assert.deepEqual(situacoes, ['Ativo', 'Aguardando ativação', 'Revogado']);
    assert.match(linha(pg, 'corpoDispositivos', 1).textContent, /Portaria 1/);
    assert.equal(pg.visivel('botaoNovoDispositivo'), true);
  });

  test('sem permissão de editar/revogar, não há botões dessas ações (e o servidor decidiria de novo)', async () => {
    const { pg } = await abrir({ perm: permissoes({ recurso: { visualizar: true, criar: true } }) });
    await aba(pg, 'dispositivos');
    assert.deepEqual([...new Set(botoes(pg, '#corpoDispositivos [data-acao]').map((b) => b.getAttribute('data-acao')))], ['detalhes']);
    assert.equal(pg.visivel('botaoNovoDispositivo'), true);
  });

  test('lista vazia: estado vazio com orientação', async () => {
    const { pg } = await abrir({ base: { dispositivos: [] } });
    await aba(pg, 'dispositivos');
    assert.match(pg.texto('estado-dispositivos'), /Nenhum dispositivo cadastrado/);
    assert.equal(pg.visivel('tabelaDispositivos'), false);
  });

  test('falha de rede na lista: erro com texto conhecido; "Atualizar" tenta de novo', async () => {
    const s = servidor({ permissoes: TUDO });
    s.forcar['GET /atendimento-token/dispositivos'] = new Error('rede caiu');
    const pg = abrirPagina(PAGINA, { rotas: s.rotas });
    await pg.esperar();
    await aba(pg, 'dispositivos');
    assert.match(pg.texto('estado-dispositivos'), /Verifique sua conexão/);
    delete s.forcar['GET /atendimento-token/dispositivos'];
    await pg.clicar('botaoAtualizarDispositivos');
    assert.equal(pg.consulta('#corpoDispositivos tr').length, 3);
  });

  test('paginação: 25 dispositivos, 20 por página, Anterior/Próxima', async () => {
    const muitos = Array.from({ length: 25 }, (_, i) => dispositivo(i + 1, `Tablet ${String(i + 1).padStart(2, '0')}`, 'PENDENTE'));
    const { pg } = await abrir({ base: { dispositivos: muitos } });
    await aba(pg, 'dispositivos');
    assert.equal(pg.consulta('#corpoDispositivos tr').length, 20);
    assert.match(pg.texto('dispositivosPaginacaoTexto'), /Página 1 de 2 · 25 dispositivos/);
    assert.equal(pg.el('dispositivosAnterior').disabled, true);
    await pg.clicar('dispositivosProxima');
    assert.equal(pg.consulta('#corpoDispositivos tr').length, 5);
    assert.equal(pg.el('dispositivosProxima').disabled, true);
    assert.deepEqual(chamadasDe(pg, 'GET /atendimento-token/dispositivos').map((c) => new URL(c.url).searchParams.get('pagina')), ['1', '2']);
  });

  describe('cadastro', () => {
    test('nome obrigatório: sem nome não há POST e o erro aparece no campo', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      assert.equal(pg.visivel('modalDispositivo'), true);
      assert.equal(pg.foco(), 'nd-nome');
      await pg.enviar('formDispositivo');
      assert.match(pg.texto('nd-nome-erro'), /Informe o nome/);
      assert.equal(pg.el('nd-nome').getAttribute('aria-invalid'), 'true');
      assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos').length, 0);
    });

    test('cadastro válido: POST só com os campos preenchidos, janela fecha, lista recarrega e a visão geral fica para reler', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = '  Tablet Novo  ';
      pg.el('nd-localInstalacao').value = 'Doca 2';
      await pg.enviar('formDispositivo');
      const posts = chamadasDe(pg, 'POST /atendimento-token/dispositivos');
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].corpo, { nome: 'Tablet Novo', localInstalacao: 'Doca 2' });
      assert.equal(pg.visivel('modalDispositivo'), false);
      assert.match(aviso(pg, 'avisoDispositivos'), /Dispositivo cadastrado/);
      assert.equal(pg.consulta('#corpoDispositivos tr').length, 4);
      await aba(pg, 'visaoGeral');
      assert.equal(chamadasDe(pg, 'GET /atendimento-token/visao-geral').length, 2, 'a visão geral é relida depois da alteração');
    });

    test('nome em uso (409): o erro vai ao campo Nome, com o texto da tela, e a janela segue aberta', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = 'Tablet Portaria';
      await pg.enviar('formDispositivo');
      assert.match(pg.texto('nd-nome-erro'), /Já existe um dispositivo com este nome/);
      assert.equal(pg.visivel('modalDispositivo'), true);
      assert.equal(pg.textoDoDom().includes('TEXTO CRU DO SERVIDOR'), false);
      assert.equal(pg.el('botaoSalvarDispositivo').disabled, false);
    });

    test('400 do servidor por campo: aparece no campo certo com o texto da tela', async () => {
      const { pg, s } = await abrir();
      s.forcar['POST /atendimento-token/dispositivos'] = s.erro(400, 'VALIDACAO', [{ campo: 'body.numeroSerie', codigo: 'NUMERO_SERIE_INVALIDO', mensagem: 'cru' }]);
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = 'X';
      await pg.enviar('formDispositivo');
      assert.match(pg.texto('nd-numeroSerie-erro'), /Número de série inválido/);
    });

    test('duplo envio: dois "submit" seguidos geram um único POST', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = 'Tablet Duplo';
      const a = pg.enviarSemEsperar('formDispositivo');
      const b = pg.enviarSemEsperar('formDispositivo');
      await Promise.all([a, b]);
      await pg.esperar();
      assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos').length, 1);
    });

    test('campos acima do limite são recusados antes da rede', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = 'A';
      pg.el('nd-localInstalacao').value = 'x'.repeat(151);
      await pg.enviar('formDispositivo');
      assert.match(pg.texto('nd-localInstalacao-erro'), /até 150/);
      assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos').length, 0);
    });

    test('cancelar não grava; Escape fecha a janela', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await pg.clicar('botaoNovoDispositivo');
      pg.el('nd-nome').value = 'Rascunho';
      await pg.clicar('botaoCancelarDispositivo');
      assert.equal(pg.visivel('modalDispositivo'), false);
      await pg.clicar('botaoNovoDispositivo');
      assert.equal(pg.el('nd-nome').value, '', 'o formulário reabre vazio');
      await pg.documento.disparar?.call(pg.documento, 'keydown', { key: 'Escape' });
      const esc = pg.documento.ouvintes.keydown || [];
      for (const fn of esc) await fn({ key: 'Escape' });
      assert.equal(pg.visivel('modalDispositivo'), false);
      assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos').length, 0);
    });
  });

  describe('edição e detalhes', () => {
    test('editar relê o dispositivo e envia só o que mudou; esvaziar um opcional envia null', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="editar"]')[0].disparar('click');
      await pg.esperar();
      assert.equal(chamadasDe(pg, 'GET /atendimento-token/dispositivos/1').length, 1);
      assert.equal(pg.el('tituloModalDispositivo').textContent, 'Editar dispositivo');
      assert.equal(pg.el('nd-nome').value, 'Tablet Portaria');
      pg.el('nd-nome').value = 'Tablet Portaria Principal';
      pg.el('nd-setor').value = '';
      await pg.enviar('formDispositivo');
      const patches = chamadasDe(pg, 'PATCH /atendimento-token/dispositivos/1');
      assert.equal(patches.length, 1);
      assert.deepEqual(patches[0].corpo, { nome: 'Tablet Portaria Principal', setor: null });
      assert.match(aviso(pg, 'avisoDispositivos'), /Dispositivo atualizado/);
      assert.match(linha(pg, 'corpoDispositivos', 1).textContent, /Tablet Portaria Principal/);
    });

    test('nada alterado: não chama o servidor', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="editar"]')[0].disparar('click');
      await pg.esperar();
      await pg.enviar('formDispositivo');
      assert.match(aviso(pg, 'avisoDispositivo'), /Nada foi alterado/);
      assert.equal(chamadasDe(pg, 'PATCH /atendimento-token/dispositivos/1').length, 0);
    });

    test('detalhes (sem editar ou revogado): somente leitura, campos desabilitados, sem Salvar, com as datas', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="3"] [data-acao="detalhes"]')[0].disparar('click');
      await pg.esperar();
      assert.equal(pg.el('tituloModalDispositivo').textContent, 'Detalhes do dispositivo');
      assert.equal(pg.el('nd-nome').disabled, true);
      assert.equal(pg.visivel('botaoSalvarDispositivo'), false);
      assert.match(pg.texto('detalheDispositivo'), /Revogado em\s*05\/10\/2026/);
    });

    test('dispositivo que sumiu (404 ao abrir): aviso e a lista é relida', async () => {
      const { pg, s } = await abrir();
      await aba(pg, 'dispositivos');
      s.dispositivos = s.dispositivos.filter((d) => d.id !== 2);
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="2"] [data-acao="editar"]')[0].disparar('click');
      await pg.esperar();
      assert.match(aviso(pg, 'avisoDispositivos'), /Registro não encontrado|Dispositivo não encontrado/);
      assert.equal(pg.visivel('modalDispositivo'), false);
      assert.equal(pg.consulta('#corpoDispositivos tr').length, 2);
    });
  });

  describe('revogação', () => {
    test('pede confirmação explicando a consequência; cancelar não chama o servidor', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="revogar"]')[0].disparar('click');
      await pg.esperar();
      assert.equal(pg.visivel('modalConfirmar'), true);
      assert.match(pg.texto('tituloModalConfirmar'), /Revogar "Tablet Portaria"\?/);
      assert.match(pg.texto('corpoModalConfirmar'), /não pode ser desfeita/);
      assert.match(pg.texto('corpoModalConfirmar'), /diferente de desativar um IP/);
      assert.equal(pg.el('botaoConfirmar').classList.contains('perigo'), true);
      await pg.clicar('botaoCancelarConfirmar');
      assert.equal(pg.visivel('modalConfirmar'), false);
      assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/revogar').length, 0);
    });

    test('confirmar revoga (corpo vazio), atualiza a lista e a visão geral; um clique duplo gera um POST só', async () => {
      const { pg } = await abrir();
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="revogar"]')[0].disparar('click');
      await pg.esperar();
      const a = pg.el('botaoConfirmar').disparar('click');
      const b = pg.el('botaoConfirmar').disparar('click');
      await Promise.all([a, b]);
      await pg.esperar();
      const posts = chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/revogar');
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].corpo, {});
      assert.equal(pg.visivel('modalConfirmar'), false);
      assert.match(aviso(pg, 'avisoDispositivos'), /revogado/);
      assert.deepEqual(botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao]').map((b2) => b2.getAttribute('data-acao')), ['detalhes']);
      await aba(pg, 'visaoGeral');
      assert.equal(pg.consulta('#visaoGeralCartoes .stat')[3].querySelector('strong').textContent, '2');
    });

    test('falha ao revogar: o erro aparece na confirmação, que continua aberta e reabilitada', async () => {
      const { pg, s } = await abrir();
      s.forcar['POST /atendimento-token/dispositivos/1/revogar'] = s.erro(500, 'ERRO_INTERNO');
      await aba(pg, 'dispositivos');
      await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="revogar"]')[0].disparar('click');
      await pg.esperar();
      await pg.clicar('botaoConfirmar');
      assert.equal(pg.visivel('modalConfirmar'), true);
      assert.match(aviso(pg, 'avisoModalConfirmar'), /Tente novamente/);
      assert.equal(pg.el('botaoConfirmar').disabled, false);
    });
  });
});

describe('Ativação e QR', () => {
  const escolher = async (pg, id) => { pg.el('ativacaoDispositivo').value = String(id); await pg.el('ativacaoDispositivo').disparar('change'); await pg.esperar(); };

  test('a lista exclui dispositivo revogado; escolher consulta o estado; nada é gerado sem clique', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    const opcoes = pg.consulta('#ativacaoDispositivo option').map((o) => o.textContent);
    assert.equal(opcoes.length, 3);
    assert.equal(opcoes.some((t) => /Tablet Antigo/.test(t)), false);
    assert.equal(pg.el('botaoGerarAtivacao').disabled, true);
    await escolher(pg, 1);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/dispositivos/1/ativacao').length, 1);
    assert.equal(pg.el('botaoGerarAtivacao').disabled, false);
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/ativacao').length, 0);
  });

  test('os cinco estados aparecem com texto próprio e orientação', async () => {
    const { pg, s } = await abrir();
    const base = { geradaEm: '2026-10-12T10:00:00.000Z', expiraEm: '2026-10-12T10:10:00.000Z', usadaEm: null, canceladaEm: null };
    s.ativacoes[2] = { estado: 'NENHUMA', geradaEm: null, expiraEm: null, usadaEm: null, canceladaEm: null };
    await aba(pg, 'ativacao');
    const esperado = [
      [{ estado: 'NENHUMA', geradaEm: null, expiraEm: null, usadaEm: null, canceladaEm: null }, /Nenhuma ativação gerada/, /Gere uma ativação/],
      [{ ...base, estado: 'PENDENTE' }, /Aguardando leitura do QR/, /não pode ser exibido de novo/],
      [{ ...base, estado: 'EXPIRADA' }, /Expirada sem uso/, /expirou sem uso/],
      [{ ...base, estado: 'CONSUMIDA', usadaEm: '2026-10-12T10:05:00.000Z' }, /^Usada/, /já usou o código/],
      [{ ...base, estado: 'CANCELADA', canceladaEm: '2026-10-12T10:06:00.000Z' }, /Cancelada/, /foi cancelada/],
    ];
    for (const [ativacao, resumo, orientacao] of esperado) {
      s.ativacoes[2] = ativacao;
      await escolher(pg, 1);
      await escolher(pg, 2);
      assert.match(pg.texto('ativacaoResumo'), resumo, ativacao.estado);
      assert.match(pg.texto('ativacaoOrientacao'), orientacao, ativacao.estado);
      assert.equal(pg.el('ativacaoResumo').getAttribute('data-estado'), ativacao.estado);
    }
    assert.match(pg.texto('ativacaoDetalhe'), /Cancelada em\s*12\/10\/2026/);
  });

  test('falha ao consultar o estado: mensagem conhecida, o botão de gerar fica desabilitado', async () => {
    const { pg, s } = await abrir();
    s.forcar['GET /atendimento-token/dispositivos/2/ativacao'] = s.erro(500, 'ERRO_INTERNO');
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    assert.match(pg.texto('ativacaoResumo'), /Tente novamente/);
    assert.equal(pg.el('botaoGerarAtivacao').disabled, true);
  });

  test('gerar: POST de corpo vazio, QR desenhado a partir do código; o código NUNCA aparece como texto, atributo ou armazenamento', async () => {
    const { pg } = await abrir();
    const marca = marcaDeArmazenamento(pg);
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    const posts = chamadasDe(pg, 'POST /atendimento-token/dispositivos/2/ativacao');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].corpo, {});
    assert.equal(pg.visivel('modalQr'), true);
    const svg = pg.consulta('#qrArea svg');
    assert.equal(svg.length, 1);
    assert.match(svg[0].getAttribute('aria-label'), /QR Code de ativação/);
    assert.ok(svg[0].querySelector('path').getAttribute('d').length > 100, 'o desenho tem módulos');
    assert.match(pg.texto('qrContagem'), /Expira em 0[45]:\d\d/);
    assert.match(pg.texto('qrDispositivo'), /Tablet Expedição/);
    assert.equal(pg.janela.__tela._qrRetido(), true);
    // O código não está em lugar nenhum visível ou inspecionável do DOM, nem em armazenamento, console ou cópia.
    assert.equal(pg.textoDoDom().includes(SEGREDO), false);
    semNovosRastros(pg, marca);
    assert.equal(JSON.stringify(pg.storage).includes(SEGREDO), false);
    assert.equal(pg.consoleChamadas.map((c) => JSON.stringify(c)).join('').includes(SEGREDO), false);
    assert.equal(JSON.stringify(pg.copiados).includes(SEGREDO), false);
    assert.equal(JSON.stringify(pg.navegacoes).includes(SEGREDO), false);
    assert.equal(JSON.stringify(pg.historico).includes(SEGREDO), false);
  });

  test('depois de gerar, o estado passa a PENDENTE (releitura) e a visão geral é relida na próxima abertura', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    assert.match(pg.texto('ativacaoResumo'), /Aguardando leitura do QR/);
    await pg.clicar('botaoFecharQr');
    await aba(pg, 'visaoGeral');
    assert.equal(pg.consulta('#visaoGeralCartoes .stat')[4].querySelector('strong').textContent, '1');
  });

  test('fechar a janela descarta o QR e o código; sair da aba também; recarregar (pagehide) também', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    await pg.clicar('botaoFecharQr');
    assert.equal(pg.visivel('modalQr'), false);
    assert.equal(pg.consulta('#qrArea svg').length, 0);
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.temporizadoresPendentes().length, 0, 'sem temporizador do QR');

    await gerar(pg);
    assert.equal(pg.janela.__tela._qrRetido(), true);
    await aba(pg, 'dispositivos');
    assert.equal(pg.visivel('modalQr'), false);
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.consulta('#qrArea svg').length, 0);

    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await gerar(pg);
    assert.equal(pg.janela.__tela._qrRetido(), true);
    await pg.eventoDaJanela('pagehide');
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.consulta('#qrArea svg').length, 0);

    await pg.clicar('botaoGerarAtivacao');
    if (pg.visivel('modalConfirmar')) await pg.clicar('botaoConfirmar');
    assert.equal(pg.janela.__tela._qrRetido(), true);
    await pg.eventoDaJanela('beforeunload');
    assert.equal(pg.janela.__tela._qrRetido(), false);
  });

  test('Escape e o X do topo também descartam', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    for (const fn of pg.documento.ouvintes.keydown || []) await fn({ key: 'Escape' });
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.visivel('modalQr'), false);
    await gerar(pg);
    assert.equal(pg.janela.__tela._qrRetido(), true);
    await pg.clicar('botaoFecharQrTopo');
    assert.equal(pg.janela.__tela._qrRetido(), false);
  });

  test('o prazo termina: o QR e o código são descartados sozinhos, com aviso e opção de gerar outro; o estado é relido', async () => {
    const { pg, s } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    assert.ok(pg.temporizadoresPendentes().length >= 2);
    const leituras = chamadasDe(pg, 'GET /atendimento-token/dispositivos/2/ativacao').length;
    s.ativacoes[2] = { ...s.ativacoes[2], estado: 'EXPIRADA' };
    await pg.avancar();
    assert.equal(pg.consulta('#qrArea svg').length, 0);
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.visivel('qrMensagem'), true);
    assert.match(pg.texto('qrMensagem'), /prazo do código terminou e ele foi descartado/);
    assert.equal(pg.visivel('botaoNovaAtivacaoQr'), true);
    assert.equal(pg.temporizadoresPendentes().length, 0);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/dispositivos/2/ativacao').length, leituras + 1);
    assert.match(pg.texto('ativacaoResumo'), /Expirada sem uso/);
    assert.equal(pg.textoDoDom().includes(SEGREDO), false);
  });

  test('o prazo vencido é percebido pela contagem mesmo sem o temporizador final', async () => {
    const { pg } = await abrir({ base: { expiraEmMs: 30 } });
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    await new Promise((r) => { setTimeout(r, 60); });
    await pg.avancar(1000);
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.consulta('#qrArea svg').length, 0);
  });

  test('o prazo exibido nunca passa de 10 minutos, mesmo que o servidor devolva mais', async () => {
    const { pg } = await abrir({ base: { expiraEmMs: 60 * 60 * 1000 } });
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    assert.match(pg.texto('qrContagem'), /Expira em (09:5\d|10:00)/);
  });

  test('dispositivo ATIVO ou com ativação PENDENTE: pede confirmação antes de gerar (a anterior é cancelada / a credencial será substituída)', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 1);
    await pg.clicar('botaoGerarAtivacao');
    assert.equal(pg.visivel('modalConfirmar'), true);
    assert.match(pg.texto('corpoModalConfirmar'), /credencial atual é substituída/);
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/ativacao').length, 0);
    await pg.clicar('botaoCancelarConfirmar');
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/ativacao').length, 0);
    await pg.clicar('botaoGerarAtivacao');
    await pg.clicar('botaoConfirmar');
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/ativacao').length, 1);
    assert.equal(pg.visivel('modalQr'), true);
    assert.equal(pg.visivel('modalConfirmar'), false);
  });

  test('gerar de novo com ativação pendente avisa que a anterior será cancelada', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    await pg.clicar('botaoFecharQr');
    await pg.clicar('botaoGerarAtivacao');
    assert.equal(pg.visivel('modalConfirmar'), true);
    assert.match(pg.texto('corpoModalConfirmar'), /cancela a que está aguardando leitura/);
  });

  test('dispositivo revogado no meio do caminho (409): erro conhecido, nenhum QR, lista relida', async () => {
    const { pg, s } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    s.dispositivos.find((d) => d.id === 2).situacao = 'REVOGADO';
    await pg.clicar('botaoGerarAtivacao');
    assert.match(aviso(pg, 'avisoAtivacao'), /foi revogado/);
    assert.equal(pg.visivel('modalQr'), false);
    assert.equal(pg.consulta('#ativacaoDispositivo option').some((o) => /Tablet Expedição/.test(o.textContent)), false);
  });

  test('duplo clique em "Gerar ativação": uma só requisição', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    const a = pg.el('botaoGerarAtivacao').disparar('click');
    const b = pg.el('botaoGerarAtivacao').disparar('click');
    await Promise.all([a, b]);
    await pg.esperar();
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/2/ativacao').length, 1);
  });

  test('resposta sem código válido: erro, nenhum QR', async () => {
    const { pg, s } = await abrir();
    s.forcar['POST /atendimento-token/dispositivos/2/ativacao'] = s.ok({ ativacao: { dispositivoId: 2, expiraEm: '2030-01-01T00:00:00.000Z' } }, 201);
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    assert.match(aviso(pg, 'avisoAtivacao'), /formato inesperado/);
    assert.equal(pg.visivel('modalQr'), false);
  });

  test('sessão expirada ao gerar (401): vai ao Portal e nenhum QR é aberto', async () => {
    const { pg, s } = await abrir();
    s.forcar['POST /atendimento-token/dispositivos/2/ativacao'] = s.erro(401, 'SESSAO_INVALIDA');
    await aba(pg, 'ativacao');
    await escolher(pg, 2);
    await pg.clicar('botaoGerarAtivacao');
    assert.equal(pg.visivel('modalQr'), false);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('sem a ação de gerar, o botão não existe; com a ação mas sem escolher dispositivo, fica desabilitado', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    await aba(pg, 'ativacao');
    assert.equal(pg.visivel('botaoGerarAtivacao'), false);
  });
});

describe('Redes autorizadas', () => {
  test('lista com situação, descrição e datas; só a rede ativa tem "Desativar"', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    assert.equal(pg.consulta('#corpoRedes tr').length, 2);
    assert.deepEqual(pg.consulta('#corpoRedes .badge').map((b) => b.textContent), ['Ativa', 'Desativada']);
    assert.deepEqual(botoes(pg, '#corpoRedes [data-acao]').map((b) => b.getAttribute('data-rede-id')), ['11']);
    assert.match(linha(pg, 'corpoRedes', 12, 'data-rede-id').textContent, /03\/10\/2026/);
  });

  test('sem nenhuma rede: estado vazio explicando a consequência', async () => {
    const { pg } = await abrir({ base: { redes: [] } });
    await aba(pg, 'ativacao');
    assert.match(pg.texto('estado-redes'), /nenhum tablet consegue usar o atendimento/);
  });

  test('cadastro válido: POST com IP exato e descrição, formulário limpo, lista relida', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    pg.el('redeEndereco').value = ' 198.51.100.7 ';
    pg.el('redeDescricao').value = 'Filial';
    await pg.enviar('formRede');
    const posts = chamadasDe(pg, 'POST /atendimento-token/redes');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].corpo, { rede: '198.51.100.7', descricao: 'Filial' });
    assert.equal(pg.el('redeEndereco').value, '');
    assert.match(aviso(pg, 'avisoRedes'), /IP autorizado/);
    assert.equal(pg.consulta('#corpoRedes tr').length, 3);
  });

  test('faixa, CIDR, intervalo, máscara, texto, vazio e 0.0.0.0 são recusados antes da rede', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    for (const ruim of ['', '10.0.0.0/24', '10.0.0.1-10.0.0.9', '10.0.0.*', '255.255.255.0/255.255.255.0', 'rede-da-matriz', '0.0.0.0', '999.1.1.1', '10.0.0.1, 10.0.0.2']) {
      pg.el('redeEndereco').value = ruim;
      await pg.enviar('formRede');
      assert.match(pg.texto('rede-endereco-erro'), /endereço IP exato/, `"${ruim}"`);
    }
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/redes').length, 0);
  });

  test('descrição longa é recusada; IP já autorizado (409) vai ao campo do IP', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    pg.el('redeEndereco').value = '203.0.113.99';
    pg.el('redeDescricao').value = 'x'.repeat(151);
    await pg.enviar('formRede');
    assert.match(pg.texto('rede-descricao-erro'), /até 150/);
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/redes').length, 0);
    pg.el('redeEndereco').value = '203.0.113.10';
    pg.el('redeDescricao').value = '';
    await pg.enviar('formRede');
    assert.match(pg.texto('rede-endereco-erro'), /já está autorizado/);
  });

  test('desativar a rede ativa quando há outra ativa: confirmação com o alerta de perda de acesso, SEM o alerta de última rede', async () => {
    const { pg } = await abrir({ base: { redes: [rede(11, '203.0.113.10', true), rede(13, '203.0.113.12', true)] } });
    await aba(pg, 'ativacao');
    await botoes(pg, '#corpoRedes button[data-rede-id="11"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(pg.visivel('modalConfirmar'), true);
    assert.match(pg.texto('tituloModalConfirmar'), /Desativar o IP 203\.0\.113\.10\?/);
    assert.match(pg.texto('corpoModalConfirmar'), /podem perder o acesso imediatamente/);
    assert.match(pg.texto('corpoModalConfirmar'), /NÃO é revogada/);
    assert.equal(pg.consulta('#corpoModalConfirmar .destaque-perigo').length, 0);
  });

  test('desativar a ÚNICA rede ativa: o alerta destacado aparece e o botão é de perigo', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await botoes(pg, '#corpoRedes button[data-rede-id="11"]')[0].disparar('click');
    await pg.esperar();
    const destaque = pg.consulta('#corpoModalConfirmar .destaque-perigo');
    assert.equal(destaque.length, 1);
    assert.match(destaque[0].textContent, /ÚNICO IP autorizado da empresa[\s\S]*TODOS os tablets perdem o acesso/);
    assert.equal(destaque[0].getAttribute('role'), 'alert');
    assert.equal(pg.el('botaoConfirmar').classList.contains('perigo'), true);
  });

  test('cancelar não desativa; confirmar desativa (corpo vazio), relê a lista e avisa', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await botoes(pg, '#corpoRedes button[data-rede-id="11"]')[0].disparar('click');
    await pg.esperar();
    await pg.clicar('botaoCancelarConfirmar');
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/redes/11/desativar').length, 0);
    await botoes(pg, '#corpoRedes button[data-rede-id="11"]')[0].disparar('click');
    await pg.esperar();
    const a = pg.el('botaoConfirmar').disparar('click');
    const b = pg.el('botaoConfirmar').disparar('click');
    await Promise.all([a, b]);
    await pg.esperar();
    const posts = chamadasDe(pg, 'POST /atendimento-token/redes/11/desativar');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].corpo, {});
    assert.match(aviso(pg, 'avisoRedes'), /IP 203\.0\.113\.10 desativado/);
    assert.equal(botoes(pg, '#corpoRedes [data-acao]').length, 0);
  });

  test('a lista de redes só traz a empresa da sessão: a tela nunca envia empresa, e mostra só o que o servidor devolveu', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    for (const c of daCentral(pg)) {
      assert.equal(/empresa/i.test(c.url), false);
      if (c.corpo) assert.equal(Object.keys(c.corpo).some((k) => /empresa|ator|perfil|usuario/i.test(k)), false);
    }
  });

  test('o IP não é revogação: o texto da confirmação separa as duas coisas', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    await botoes(pg, '#corpoRedes button[data-rede-id="11"]')[0].disparar('click');
    await pg.esperar();
    assert.match(pg.texto('corpoModalConfirmar'), /revogue o dispositivo na aba Dispositivos/);
  });
});

describe('Prévia e Testes', () => {
  const buscar = async (pg, termo) => { pg.el('previaBusca').value = termo; await pg.enviar('previaBuscaForm'); };

  test('aviso permanente de somente leitura; sem permissão de funcionários, a busca não existe e explica', async () => {
    const { pg } = await abrir({ perm: permissoes({ acoes: { TOKEN_PREVIA_CATALOGO_REAL: true } }) });
    await aba(pg, 'previa');
    assert.match(pg.texto('previaAviso'), /somente leitura[\s\S]*não é o atendimento real/);
    assert.equal(pg.visivel('previaBuscaForm'), false);
    assert.match(pg.texto('previaSemBusca'), /permissão de consultar o cadastro de funcionários/);
  });

  test('buscar lista funcionários da empresa; o inativo não pode ser usado; o CPF nunca é mostrado', async () => {
    const { pg } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, 'a');
    const itens = pg.consulta('#previaFuncionarios li');
    assert.equal(itens.length, 2);
    assert.match(itens[0].textContent, /Ana Silva[\s\S]*Matrícula M31[\s\S]*GHE GHE Produção/);
    const botaoInativo = botoes(pg, '#previaFuncionarios [data-funcionario-id="32"][data-acao="previa"]')[0];
    assert.equal(botaoInativo.disabled, true);
    assert.match(botaoInativo.getAttribute('title'), /Só funcionário ativo/);
    assert.equal(pg.textoDoDom().includes('***.***.***-12'), false);
    assert.equal(chamadasDe(pg, 'GET /funcionarios')[0].temQuery, true);
    assert.equal(/cpf/i.test(chamadasDe(pg, 'GET /funcionarios')[0].url), false);
  });

  test('busca vazia ou longa demais: recusada antes da rede', async () => {
    const { pg } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, '   ');
    assert.match(pg.texto('previa-busca-erro'), /Informe o nome ou a matrícula/);
    await buscar(pg, 'x'.repeat(101));
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length, 0);
  });

  test('prévia: mostra os materiais do catálogo (nome, tipo, unidade, "Possui tamanhos") e o aviso; é só GET', async () => {
    const { pg } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, 'ana');
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    assert.match(pg.texto('previaTitulo'), /Prévia do catálogo — Ana Silva/);
    const materiais = pg.consulta('#previaResultado li');
    assert.equal(materiais.length, 2);
    assert.match(materiais[0].textContent, /Luva Nitrílica[\s\S]*Luva · EPI · Unidade: par[\s\S]*Possui tamanhos/);
    assert.doesNotMatch(materiais[0].textContent, /P, M, G|Tamanhos:/, 'K7: a lista não enumera os tamanhos');
    assert.match(materiais[1].textContent, /Capacete[\s\S]*Sem tamanho/);
    assert.match(pg.texto('previaResultado'), /O funcionário vê estes materiais no tablet/);
    assert.match(pg.texto('previaResultado'), /2 materiais no catálogo/);
    const previa = chamadasDe(pg, 'GET /atendimento-token/previa/catalogo');
    assert.equal(previa.length, 1);
    assert.equal(new URL(previa[0].url).searchParams.get('funcionarioId'), '31');
    // Nada além de leituras: nenhuma escrita em lugar nenhum durante a prévia.
    assert.equal(pg.chamadas.filter((c) => c.metodo !== 'GET').length, 0);
    assert.equal(pg.textoDoDom().includes('Reservar'), false);
  });

  test('estados do catálogo: sem GHE e sem materiais têm explicação e nenhum item', async () => {
    const { pg, s } = await abrir({ base: { funcionarios: [funcionario(31, 'Ana Silva'), funcionario(33, 'Caio Rocha')] } });
    s.previas[33] = { estado: 'SEM_MATERIAIS', total: 0, materiais: [] };
    delete s.previas[31];
    await aba(pg, 'previa');
    await buscar(pg, 'a');
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    assert.match(pg.texto('previaResultado'), /não tem GHE/);
    assert.equal(pg.consulta('#previaResultado li').length, 0);
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="33"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    assert.match(pg.texto('previaResultado'), /não tem material físico elegível/);
  });

  test('erros da prévia (404, 409, 403) mostram texto conhecido; nunca o texto do servidor', async () => {
    const { pg, s } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, 'ana');
    for (const [status, codigo, esperado] of [[404, 'FUNCIONARIO_NAO_ENCONTRADO', /não encontrado nesta empresa/], [409, 'FUNCIONARIO_NAO_ELEGIVEL', /não está ativo/], [403, 'PERMISSAO_NEGADA', /Você não tem autorização/]]) {
      s.forcar['GET /atendimento-token/previa/catalogo'] = s.erro(status, codigo);
      await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
      await pg.esperar();
      assert.match(aviso(pg, 'avisoPrevia'), esperado);
      assert.equal(pg.consulta('#previaResultado li').length, 0);
      // S4: o botão do funcionário aberto agora fecha a prévia; para consultar de novo é preciso fechar antes.
      await pg.el('previaBotao-31').disparar('click');
      await pg.esperar();
    }
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/previa/catalogo').length, 3, 'uma consulta por abertura');
    assert.equal(pg.textoDoDom().includes('TEXTO CRU DO SERVIDOR'), false);
  });

  test('uma nova busca limpa a prévia anterior (nada de resultado de outro funcionário na tela)', async () => {
    const { pg } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, 'ana');
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(pg.consulta('#previaResultado li').length, 2);
    await buscar(pg, 'bruno');
    assert.equal(pg.consulta('#previaResultado li').length, 0);
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
  });

  test('sem a ação da prévia a aba não existe e nenhuma rota da prévia é chamada', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    assert.equal(pg.visivel('aba-previa'), false);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/previa/catalogo').length, 0);
  });
});

describe('Prévia logo abaixo do funcionário (melhoria S4)', () => {
  const PREVIA = 'GET /atendimento-token/previa/catalogo';
  const OCULOS = { id: 7, nome: 'Óculos', unidade: 'un', categoria: 'EPI', tipo: { id: 3, nome: 'Óculos de Proteção Incolor' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } };
  const buscar = async (pg, termo) => { pg.el('previaBusca').value = termo; await pg.enviar('previaBuscaForm'); };
  const item = (pg, id) => pg.consulta(`#previaFuncionarios li[data-funcionario-id="${id}"]`)[0];
  const botaoDe = (pg, id) => pg.el(`previaBotao-${id}`);
  const abrirPrevia = async (pg, id) => { await botaoDe(pg, id).disparar('click'); await pg.esperar(); };
  // Um só botão por funcionário: o mesmo alterna entre "Ver prévia" e "Fechar prévia".
  const fecharDo = async (pg, id) => { await botaoDe(pg, id).disparar('click'); await pg.esperar(); };
  const preparar = async (opcoes = {}) => {
    const r = await abrir({ base: { funcionarios: [funcionario(31, 'Ana Silva'), funcionario(33, 'Caio Rocha', { funcao: 'Eletricista', setor: 'Manutenção' }), funcionario(32, 'Bruno Lima', { situacao: 'INATIVO', ativo: false })], ...opcoes } });
    r.s.previas[33] = { estado: 'OK', total: 1, materiais: [OCULOS] };
    await aba(r.pg, 'previa');
    await buscar(r.pg, 'a');
    return r;
  };
  const consultas = (pg) => chamadasDe(pg, PREVIA).length;

  test('a prévia abre dentro do item do funcionário escolhido, logo abaixo do cabeçalho dele', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    const caixa = pg.el('previaResultadoCaixa');
    const li = item(pg, 31);
    assert.equal(pg.visivel('previaResultadoCaixa'), true);
    assert.equal(li.contains(caixa), true);
    assert.equal(caixa.closest('li'), li);
    assert.equal(item(pg, 33).contains(caixa), false);
    // O cabeçalho do funcionário vem antes da caixa dentro do mesmo item.
    const filhos = li.children;
    assert.ok(filhos.indexOf(caixa) > filhos.findIndex((f) => /Ana Silva/.test(f.textContent)), 'a caixa vem depois do cabeçalho');
    assert.equal(pg.consulta('[id="previaResultadoCaixa"]').length, 1, 'uma só caixa na página (reaproveitada)');
    assert.equal(pg.consulta('#previaResultado li').length, 2);
    assert.equal(consultas(pg), 1);
  });

  test('nome, matrícula, cargo, setor e GHE continuam visíveis no cabeçalho, com a prévia fechada e aberta', async () => {
    const { pg } = await preparar();
    const cabecalho = (id) => item(pg, id).children.find((f) => f !== pg.el('previaResultadoCaixa') && /Matrícula/.test(f.textContent)).textContent;
    assert.match(cabecalho(33), /Caio Rocha[\s\S]*Matrícula M33[\s\S]*Cargo Eletricista[\s\S]*Setor Manutenção[\s\S]*GHE GHE Produção/);
    await abrirPrevia(pg, 33);
    assert.match(cabecalho(33), /Caio Rocha[\s\S]*Matrícula M33[\s\S]*Cargo Eletricista[\s\S]*Setor Manutenção[\s\S]*GHE GHE Produção/);
    assert.match(cabecalho(31), /Ana Silva[\s\S]*Matrícula M31[\s\S]*Cargo Operador[\s\S]*Setor Produção/);
    assert.equal(pg.textoDoDom().includes('***.***.***-12'), false, 'o CPF nunca aparece');
  });

  test('sem cargo cadastrado (nulo, vazio ou ausente) a linha não mostra "Cargo" vazio', async () => {
    for (const funcao of [null, '', undefined]) {
      const { pg } = await preparar({ funcionarios: [funcionario(31, 'Ana Silva', { funcao })] });
      assert.equal(/Cargo/.test(item(pg, 31).textContent), false, String(funcao));
      assert.match(item(pg, 31).textContent, /Ana Silva[\s\S]*Matrícula M31[\s\S]*Setor Produção[\s\S]*GHE GHE Produção/);
    }
  });

  test('escolher outro funcionário fecha a prévia anterior e abre a nova logo abaixo dele', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    await abrirPrevia(pg, 33);
    const caixa = pg.el('previaResultadoCaixa');
    assert.equal(item(pg, 33).contains(caixa), true);
    assert.equal(item(pg, 31).contains(caixa), false);
    assert.equal(/Luva Nitrílica/.test(item(pg, 31).textContent), false, 'nada do catálogo anterior no item anterior');
    assert.match(pg.texto('previaResultado'), /Óculos/);
    assert.equal(pg.consulta('[id="previaResultadoCaixa"]').length, 1);
    assert.equal(botaoDe(pg, 31).textContent.trim(), 'Ver prévia');
    assert.equal(botaoDe(pg, 31).getAttribute('aria-expanded'), 'false');
    assert.equal(botaoDe(pg, 33).textContent.trim(), 'Fechar prévia');
    assert.equal(botaoDe(pg, 33).getAttribute('aria-expanded'), 'true');
    assert.equal(consultas(pg), 2, 'uma consulta por prévia realmente aberta');
  });

  test('ao escolher outro funcionário, nada da prévia anterior (catálogo ou erro) fica na tela enquanto a nova consulta está em curso', async () => {
    const { pg, s } = await preparar();
    const segurar = () => { const g = {}; s.forcar[PREVIA] = () => new Promise((resolver) => { g.liberar = () => resolver(s.ok({ previa: { catalogo: s.previas[33] } })); }); return g; };
    // 1) catálogo carregado de 31; ao escolher 33, o catálogo de 31 some na hora, antes de a resposta de 33 chegar.
    await abrirPrevia(pg, 31);
    assert.equal(pg.consulta('#previaResultado li').length, 2);
    const g1 = segurar();
    await botaoDe(pg, 33).disparar('click');
    await pg.esperar();
    assert.equal(item(pg, 33).contains(pg.el('previaResultadoCaixa')), true);
    assert.equal(pg.consulta('#previaResultado li').length, 0, 'nenhum material do funcionário anterior durante o carregamento');
    assert.match(pg.texto('estado-previaResultado'), /Consultando o catálogo/);
    g1.liberar();
    await pg.esperar();
    assert.match(pg.texto('previaResultado'), /Óculos/);
    // 2) erro aberto sob 31; ao escolher 33, o erro não aparece sob o novo funcionário.
    delete s.forcar[PREVIA];
    s.forcar[PREVIA] = s.erro(404, 'FUNCIONARIO_NAO_ENCONTRADO');
    await abrirPrevia(pg, 31);
    assert.match(aviso(pg, 'avisoPrevia'), /não encontrado nesta empresa/);
    assert.equal(item(pg, 31).contains(pg.el('previaResultadoCaixa')), true);
    const g2 = segurar();
    await botaoDe(pg, 33).disparar('click');
    await pg.esperar();
    assert.equal(aviso(pg, 'avisoPrevia'), '', 'o erro do funcionário anterior não aparece sob o novo');
    g2.liberar();
    await pg.esperar();
    assert.match(pg.texto('previaResultado'), /Óculos/);
  });

  test('o botão do funcionário aberto ("Fechar prévia") fecha sem nova consulta, mantém a lista, devolve a caixa ao ponto neutro e o foco ao botão do funcionário', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    await fecharDo(pg, 31);
    const caixa = pg.el('previaResultadoCaixa');
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
    assert.equal(pg.el('previaFuncionarios').contains(caixa), false, 'a caixa saiu da lista');
    assert.equal(caixa.closest('li'), null);
    assert.equal(pg.consulta('#previaFuncionarios li[data-funcionario-id]').length, 3, 'a lista continua inteira');
    assert.equal(consultas(pg), 1, 'fechar não consulta');
    assert.equal(pg.foco(), 'previaBotao-31');
    assert.equal(botaoDe(pg, 31).textContent.trim(), 'Ver prévia');
    assert.equal(botaoDe(pg, 31).getAttribute('aria-expanded'), 'false');
    assert.equal(pg.consulta('#previaResultado li').length, 0, 'sem materiais soltos na tela');
  });

  test('existe um único botão de abrir/fechar por funcionário, ao lado do nome; a caixa do catálogo não tem botão de fechar', async () => {
    const { pg } = await preparar();
    const rotulos = () => pg.consulta('#previaFuncionarios button').map((b) => b.textContent.trim());
    assert.deepEqual(rotulos(), ['Ver prévia', 'Ver prévia', 'Ver prévia']);
    assert.equal(pg.existe('botaoFecharPrevia'), false, 'o botão duplicado dentro da caixa não existe mais');
    await abrirPrevia(pg, 31);
    assert.deepEqual(rotulos().filter((r) => r === 'Fechar prévia'), ['Fechar prévia'], 'um só "Fechar prévia" na tela');
    const caixa = pg.el('previaResultadoCaixa');
    assert.equal(caixa.querySelectorAll('button').length, 0, 'a caixa não tem botões');
    const filhos = item(pg, 31).children;
    const posicaoBotao = filhos.indexOf(botaoDe(pg, 31));
    assert.ok(posicaoBotao >= 0 && posicaoBotao < filhos.indexOf(caixa), 'o botão fica no cabeçalho do item, antes da caixa');
    assert.equal(pg.texto('previaTitulo').includes('Fechar'), false);
    await fecharDo(pg, 31);
    assert.deepEqual(rotulos(), ['Ver prévia', 'Ver prévia', 'Ver prévia']);
  });

  test('o botão do funcionário aberto também fecha a prévia, sem consultar', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    await abrirPrevia(pg, 31);
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
    assert.equal(consultas(pg), 1);
    assert.equal(botaoDe(pg, 31).getAttribute('aria-expanded'), 'false');
  });

  test('abrir de novo depois de fechar consulta de novo: uma consulta por abertura, nunca uma a mais', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    await fecharDo(pg, 31);
    await abrirPrevia(pg, 31);
    assert.equal(consultas(pg), 2);
    assert.equal(item(pg, 31).contains(pg.el('previaResultadoCaixa')), true);
    assert.equal(pg.consulta('#previaResultado li').length, 2);
  });

  test('durante a consulta os outros botões ficam desabilitados e nenhum clique gera segunda consulta; fechar com a consulta em curso descarta a resposta', async () => {
    const { pg, s } = await preparar();
    let liberar;
    s.forcar[PREVIA] = () => new Promise((resolver) => { liberar = () => resolver(s.ok({ previa: { catalogo: s.previas[31] } })); });
    await botaoDe(pg, 31).disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg), 1);
    assert.match(pg.texto('estado-previaResultado'), /Consultando o catálogo/);
    assert.equal(botaoDe(pg, 33).disabled, true, 'o outro funcionário fica indisponível enquanto consulta');
    assert.equal(botaoDe(pg, 31).disabled, false, 'o aberto continua podendo fechar');
    await botaoDe(pg, 33).disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg), 1, 'clique em outro funcionário durante a consulta não envia nada');
    // Defesa em profundidade: mesmo chamando o ouvinte direto (sem o botão desabilitado), a segunda consulta não sai.
    for (const ouvinte of pg.el('previaFuncionarios').ouvintes.click.slice()) await ouvinte({ target: botaoDe(pg, 33), preventDefault() {} });
    await pg.esperar();
    assert.equal(consultas(pg), 1, 'a trava vale também sem o botão desabilitado');
    await fecharDo(pg, 31);
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
    assert.equal(botaoDe(pg, 33).disabled, true, 'ainda há uma consulta em curso');
    liberar();
    await pg.esperar();
    assert.equal(pg.visivel('previaResultadoCaixa'), false, 'a resposta de uma prévia já fechada não reabre nada');
    assert.equal(pg.consulta('#previaResultado li').length, 0);
    assert.equal(botaoDe(pg, 33).disabled, false, 'terminada a consulta, o botão volta');
    assert.equal(botaoDe(pg, 32).disabled, true, 'o funcionário inativo continua indisponível');
  });

  test('uma nova busca fecha a prévia aberta sem destruir a caixa: abrir depois funciona', async () => {
    const { pg } = await preparar();
    await abrirPrevia(pg, 31);
    await buscar(pg, 'a');
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
    assert.equal(pg.existe('previaResultadoCaixa'), true, 'a caixa continua no documento');
    assert.equal(pg.el('previaFuncionarios').contains(pg.el('previaResultadoCaixa')), false);
    await abrirPrevia(pg, 33);
    assert.equal(item(pg, 33).contains(pg.el('previaResultadoCaixa')), true);
    assert.equal(consultas(pg), 2);
  });

  test('as mensagens do catálogo aparecem dentro do item: sem GHE, sem materiais e erros com texto conhecido', async () => {
    const { pg, s } = await preparar({ funcionarios: [funcionario(31, 'Ana Silva'), funcionario(33, 'Caio Rocha')] });
    delete s.previas[31];
    await abrirPrevia(pg, 31);
    assert.match(item(pg, 31).textContent, /não tem GHE/);
    s.previas[33] = { estado: 'SEM_MATERIAIS', total: 0, materiais: [] };
    await abrirPrevia(pg, 33);
    assert.match(item(pg, 33).textContent, /não tem material físico elegível/);
    assert.equal(/não tem GHE/.test(item(pg, 31).textContent), false);
    s.forcar[PREVIA] = s.erro(404, 'FUNCIONARIO_NAO_ENCONTRADO');
    await abrirPrevia(pg, 31);
    assert.match(item(pg, 31).textContent, /não encontrado nesta empresa/);
    assert.equal(item(pg, 31).textContent.includes('TEXTO CRU DO SERVIDOR'), false);
    assert.equal(botaoDe(pg, 31).textContent.trim(), 'Fechar prévia', 'o erro também pode ser fechado pelo botão do funcionário');
    await fecharDo(pg, 31);
    assert.equal(pg.visivel('previaResultadoCaixa'), false);
  });

  test('acessibilidade: a caixa é uma região rotulada pelo título; os botões informam aberto/fechado e o que controlam', async () => {
    const { pg } = await preparar();
    const caixa = pg.el('previaResultadoCaixa');
    assert.equal(caixa.getAttribute('role'), 'region');
    assert.equal(caixa.getAttribute('aria-labelledby'), 'previaTitulo');
    assert.equal(botaoDe(pg, 31).getAttribute('aria-controls'), 'previaResultadoCaixa');
    assert.equal(botaoDe(pg, 31).getAttribute('aria-expanded'), 'false');
    await abrirPrevia(pg, 31);
    assert.equal(botaoDe(pg, 31).getAttribute('aria-expanded'), 'true');
    assert.equal(botaoDe(pg, 33).getAttribute('aria-expanded'), 'false');
    assert.equal(botaoDe(pg, 31).getAttribute('type'), 'button');
  });

  test('é só leitura: nenhuma escrita, nada em armazenamento, e a sessão encerrada com a prévia aberta não quebra', async () => {
    const { pg, s } = await preparar();
    const marca = marcaDeArmazenamento(pg);
    await abrirPrevia(pg, 31);
    await abrirPrevia(pg, 33);
    await fecharDo(pg, 33);
    assert.equal(pg.chamadas.filter((c) => c.metodo !== 'GET').length, 0);
    semNovosRastros(pg, marca);
    await abrirPrevia(pg, 31);
    s.forcar['GET /atendimento-token/dispositivos'] = s.erro(401, 'SESSAO_INVALIDA');
    await aba(pg, 'dispositivos');
    assert.equal(pg.visivel('conteudoProtegido'), false);
    // Ao encerrar, a caixa volta ao lugar de origem antes de a lista ser esvaziada (não é destruída com o item).
    assert.equal(pg.existe('previaResultadoCaixa'), true);
    assert.equal(pg.el('previaFuncionarios').contains(pg.el('previaResultadoCaixa')), false);
  });

  test('responsivo: o item quebra a linha e a caixa ocupa a largura toda; as regras da lista não atingem os materiais', async () => {
    const { pg } = await preparar();
    const html = pg.html;
    assert.match(html, /\.lista-funcionarios > li\{[^}]*flex-wrap:wrap/);
    assert.match(html, /\.lista-funcionarios > li > \.previa-caixa\{[^}]*flex:1 1 100%/);
    assert.equal(/\.lista-funcionarios li\s*[{,]/.test(html), false, 'nenhuma regra solta em "li" descendente: ela atingiria os materiais da prévia');
    assert.match(html, /@media \(max-width: 560px\)\{[^@]*\.lista-funcionarios > li\{flex-direction:column/);
  });
});

describe('Monitoramento e Histórico (Etapa J)', () => {
  test('só a estrutura: aviso de "em integração", nenhum dado e nenhuma chamada', async () => {
    const { pg } = await abrir({ perm: permissoes({ acoes: { TOKEN_PREVIA_CATALOGO_REAL: true } }) });
    for (const [nome, texto] of [['monitoramento', /Etapa J[\s\S]*nenhum dado é exibido/], ['historico', /Etapa J[\s\S]*nenhum dado é exibido/]]) {
      await aba(pg, nome);
      assert.equal(pg.visivel(`painel-${nome}`), true);
      assert.equal(pg.el(`estado-${nome}`).querySelector('[data-estado]').getAttribute('data-estado'), 'em-integracao');
      assert.match(pg.texto(`estado-${nome}`), texto);
      assert.equal(pg.consulta(`#painel-${nome} table, #painel-${nome} li, #painel-${nome} .stat, #painel-${nome} button`).length, 0);
    }
    assert.equal(daCentral(pg).length, 0);
    assert.equal(pg.temporizadoresPendentes().length, 0, 'sem polling');
  });

  test('com todas as permissões, abrir as abas reservadas também não faz chamada nem cria temporizador', async () => {
    const { pg } = await abrir();
    const antes = pg.chamadas.length;
    await aba(pg, 'monitoramento');
    await aba(pg, 'historico');
    assert.equal(pg.chamadas.length, antes);
    assert.equal(/online|offline|heartbeat|alerta/i.test(pg.el('painel-monitoramento').textContent.replace(/sinal de vida/g, '')), true, 'o texto descreve o que virá');
    assert.equal(pg.temporizadoresPendentes().length, 0);
  });
});

describe('abas: navegação, acessibilidade e carregamento sob demanda', () => {
  test('papéis ARIA, uma aba selecionada por vez e painéis ligados às abas', async () => {
    const { pg } = await abrir();
    assert.equal(pg.el('abas').getAttribute('role'), 'tablist');
    for (const a of ABAS_DA_CENTRAL) {
      assert.equal(pg.el(`aba-${a}`).getAttribute('role'), 'tab');
      assert.equal(pg.el(`aba-${a}`).getAttribute('aria-controls'), `painel-${a}`);
      assert.equal(pg.el(`painel-${a}`).getAttribute('role'), 'tabpanel');
      assert.equal(pg.el(`painel-${a}`).getAttribute('aria-labelledby'), `aba-${a}`);
    }
    await aba(pg, 'dispositivos');
    assert.deepEqual(['visaoGeral', 'dispositivos', 'ativacao'].map((a) => pg.el(`aba-${a}`).getAttribute('aria-selected')), ['false', 'true', 'false']);
    assert.deepEqual(['visaoGeral', 'dispositivos', 'ativacao'].map((a) => pg.el(`aba-${a}`).getAttribute('tabindex')), ['-1', '0', '-1']);
  });

  test('setas, Home e End movem entre as abas permitidas e levam o foco', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    const teclar = async (key) => { for (const fn of pg.el('abas').ouvintes.keydown || []) await fn({ key, preventDefault() {} }); await pg.esperar(); };
    await teclar('ArrowRight');
    assert.deepEqual(painelAberto(pg), ['dispositivos']);
    assert.equal(pg.foco(), 'aba-dispositivos');
    await teclar('End');
    assert.deepEqual(painelAberto(pg), ['historico']);
    await teclar('ArrowRight');
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
    await teclar('ArrowLeft');
    assert.deepEqual(painelAberto(pg), ['historico']);
    await teclar('Home');
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
  });

  test('cada aba só carrega quando é aberta, uma vez', async () => {
    const { pg } = await abrir();
    assert.deepEqual(daCentral(pg).map((c) => c.chave), ['GET /atendimento-token/visao-geral']);
    await aba(pg, 'dispositivos');
    await aba(pg, 'visaoGeral');
    await aba(pg, 'dispositivos');
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/dispositivos').length, 1);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/visao-geral').length, 1);
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/redes').length, 0);
  });
});

describe('segurança e isolamento', () => {
  test('nada vai para armazenamento, cookie, console, histórico ou rede externa em todo o uso', async () => {
    const { pg } = await abrir();
    const marca = marcaDeArmazenamento(pg);
    await aba(pg, 'dispositivos');
    await aba(pg, 'ativacao');
    pg.el('ativacaoDispositivo').value = '2';
    await pg.el('ativacaoDispositivo').disparar('change');
    await pg.esperar();
    await pg.clicar('botaoGerarAtivacao');
    await pg.clicar('botaoFecharQr');
    await aba(pg, 'previa');
    semNovosRastros(pg, marca);
    assert.deepEqual(pg.externas, []);
    assert.deepEqual(pg.alertas, []);
  });

  test('toda chamada vai à API com a sessão do cookie; nenhuma carrega empresa, ator ou perfil, na URL ou no corpo', async () => {
    const { pg } = await abrir();
    await aba(pg, 'dispositivos');
    await aba(pg, 'ativacao');
    await pg.clicar('botaoNovoDispositivo').catch(() => {});
    for (const c of pg.chamadas.filter((x) => x.caminho.startsWith('/atendimento-token'))) {
      assert.equal(c.credentials, 'include');
      assert.equal(/empresa|ator|perfil|usuario/i.test(c.url), false, c.url);
      if (c.corpo) assert.equal(Object.keys(c.corpo).some((k) => /empresa|ator|perfil|usuario|criadoPor|revogadoPor/i.test(k)), false);
    }
  });

  test('a tela não usa o protótipo do funcionário, a API simulada nem a Etapa I: nenhuma referência a token-epi, self-service, db-api ou main.js', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const raiz = path.join(__dirname, '..');
    for (const f of ['pages/atendimento-token.html', 'js/atendimento-token.js', 'js/atendimento-token-tela.js']) {
      const codigo = fs.readFileSync(path.join(raiz, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(/token-epi|self-service|db-api|js\/main\.js|localStorage|sessionStorage|document\.cookie|console\.|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(codigo), false, f);
    }
  });

  test('sessão que termina durante o uso (401 em qualquer ação): o conteúdo some e o QR aberto é descartado', async () => {
    const { pg, s } = await abrir();
    await aba(pg, 'ativacao');
    pg.el('ativacaoDispositivo').value = '2';
    await pg.el('ativacaoDispositivo').disparar('change');
    await pg.esperar();
    await pg.clicar('botaoGerarAtivacao');
    assert.equal(pg.janela.__tela._qrRetido(), true);
    s.forcar['GET /atendimento-token/dispositivos/2/ativacao'] = s.erro(401, 'SESSAO_INVALIDA');
    await pg.clicar('botaoAtualizarEstadoAtivacao');
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.janela.__tela._qrRetido(), false);
    assert.equal(pg.consulta('#qrArea svg').length, 0);
    assert.equal(pg.consulta('#corpoDispositivos tr').length, 0);
  });

  test('as travas contra duplo envio valem mesmo sem o botão desabilitado: duas chamadas diretas do mesmo ouvinte geram uma só requisição', async () => {
    const { pg } = await abrir();
    await aba(pg, 'dispositivos');
    await botoes(pg, '#corpoDispositivos tr[data-dispositivo-id="1"] [data-acao="revogar"]')[0].disparar('click');
    await pg.esperar();
    const confirmar = pg.el('botaoConfirmar').ouvintes.click[0];
    await Promise.all([confirmar({}), confirmar({})]);
    await pg.esperar();
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/1/revogar').length, 1);

    await aba(pg, 'ativacao');
    pg.el('ativacaoDispositivo').value = '2';
    await pg.el('ativacaoDispositivo').disparar('change');
    await pg.esperar();
    const gerarAtivacao = pg.el('botaoGerarAtivacao').ouvintes.click[0];
    await Promise.all([gerarAtivacao({}), gerarAtivacao({})]);
    await pg.esperar();
    assert.equal(chamadasDe(pg, 'POST /atendimento-token/dispositivos/2/ativacao').length, 1);
  });

  test('o servidor decide: um 403 numa escrita aparece como "sem autorização" (a tela não presume nada)', async () => {
    const { pg, s } = await abrir();
    s.forcar['POST /atendimento-token/dispositivos'] = s.erro(403, 'PERMISSAO_NEGADA');
    await aba(pg, 'dispositivos');
    await pg.clicar('botaoNovoDispositivo');
    pg.el('nd-nome').value = 'Qualquer';
    await pg.enviar('formDispositivo');
    assert.match(aviso(pg, 'avisoDispositivo'), /Você não tem autorização/);
  });

  test('o texto vindo do servidor entra como texto: nome com marcação não vira elemento', async () => {
    const nome = '<img src=x onerror=alert(1)>';
    const { pg } = await abrir({ base: { dispositivos: [dispositivo(1, nome, 'ATIVO')] } });
    await aba(pg, 'dispositivos');
    assert.equal(pg.consulta('#corpoDispositivos img').length, 0);
    assert.match(linha(pg, 'corpoDispositivos', 1).textContent, /<img src=x onerror=alert\(1\)>/);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });
});

describe('responsividade e acessibilidade da marcação', () => {
  test('o HTML traz viewport, tema, rótulos nos campos e papéis de alerta nos erros', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '..', PAGINA), 'utf8');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/css\/main\.css">\s*<script src="\.\.\/js\/tema\.js"><\/script>/);
    for (const id of ['nd-nome', 'nd-unidade', 'nd-setor', 'nd-localInstalacao', 'nd-fabricante', 'nd-modelo', 'nd-numeroSerie', 'redeEndereco', 'redeDescricao', 'previaBusca', 'ativacaoDispositivo']) {
      assert.match(html, new RegExp(`<label for="${id}">`), id);
    }
    assert.equal((html.match(/class="campo-erro" role="alert"/g) || []).length >= 10, true);
    for (const modal of ['modalDispositivo', 'modalConfirmar', 'modalQr']) assert.match(html, new RegExp(`id="${modal}" role="(alert)?dialog" aria-modal="true" aria-hidden="true" aria-labelledby=`), modal);
    assert.match(html, /@media \(max-width: 560px\)/);
    assert.match(html, /@media \(max-width: 900px\)/);
  });
});

// ───────────────────────── K7 — aba "Visualizar Totem" (prévia visual, modalidade 1) ─────────────────────────

const quadroDaPrevia = (pg) => pg.consulta('#totemPreviaQuadro iframe');

describe('K7 — aba Visualizar Totem', () => {
  test('K7-D1 — fica depois de Histórico no HTML e na lista, com o rótulo Visualizar Totem e os papéis ARIA das outras abas', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '..', PAGINA), 'utf8');
    assert.ok(html.indexOf('id="aba-historico"') > 0 && html.indexOf('id="aba-visualizarTotem"') > html.indexOf('id="aba-historico"'));
    assert.ok(html.indexOf('id="painel-visualizarTotem"') > html.indexOf('id="painel-historico"'));
    const { pg } = await abrir();
    assert.equal(pg.el('aba-visualizarTotem').textContent.trim(), 'Visualizar Totem');
    assert.equal(pg.el('aba-visualizarTotem').getAttribute('aria-controls'), 'painel-visualizarTotem');
  });

  test('K7-D2 — reutiliza a permissão TOKEN_PREVIA_CATALOGO_REAL: sem ela a aba não aparece nem abre', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    assert.equal(pg.visivel('aba-visualizarTotem'), false);
    assert.equal(pg.visivel('painel-visualizarTotem'), false);
    const so = await abrir({ perm: permissoes({ acoes: { TOKEN_PREVIA_CATALOGO_REAL: true } }) });
    assert.equal(so.pg.visivel('aba-visualizarTotem'), true);
  });

  test('K7-D3 — o iframe só existe depois de abrir a aba, com sandbox mínimo (scripts, sem mesma origem) e caminho da prévia', async () => {
    const { pg } = await abrir();
    assert.equal(quadroDaPrevia(pg).length, 0, 'nada carregado ao abrir a página');
    await aba(pg, 'visualizarTotem');
    const quadros = quadroDaPrevia(pg);
    assert.equal(quadros.length, 1);
    const q = quadros[0];
    assert.equal(q.getAttribute('src'), '../totem/previa.html');
    assert.equal(q.getAttribute('sandbox'), 'allow-scripts', 'só scripts: origem opaca, sem cookies, sem storage e sem acesso à Central');
    assert.equal(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/.test(q.getAttribute('sandbox')), false);
    assert.equal(q.getAttribute('referrerpolicy'), 'no-referrer');
    assert.ok((q.getAttribute('title') || '').length > 5, 'título acessível');
    assert.ok(q.getAttribute('allow') == null, 'nenhuma permissão de recurso do navegador');
  });

  test('K7-D4 — ao sair da aba o iframe é descarregado; ao voltar nasce de novo; "Reiniciar prévia" também recria', async () => {
    const { pg } = await abrir();
    await aba(pg, 'visualizarTotem');
    const primeiro = quadroDaPrevia(pg)[0];
    await aba(pg, 'historico');
    assert.equal(quadroDaPrevia(pg).length, 0, 'descarregado ao sair');
    await aba(pg, 'visualizarTotem');
    const segundo = quadroDaPrevia(pg)[0];
    assert.ok(segundo && segundo !== primeiro, 'um iframe novo');
    await pg.clicar('botaoReiniciarPrevia');
    const terceiro = quadroDaPrevia(pg);
    assert.equal(terceiro.length, 1);
    assert.notEqual(terceiro[0], segundo);
  });

  test('K7-D5 — a Central não faz nenhuma chamada ao abrir a aba, e a nota mostra as matrículas fictícias e o aviso de dados fictícios', async () => {
    const { pg } = await abrir();
    const antes = pg.chamadas.length;
    await aba(pg, 'visualizarTotem');
    assert.equal(pg.chamadas.length, antes, 'abrir a prévia visual não consulta a API');
    const texto = pg.el('painel-visualizarTotem').textContent.replace(/\s+/g, ' ');
    for (const m of ['1001', '1002', '1003']) assert.match(texto, new RegExp(m));
    assert.match(texto, /fictíci/i);
    assert.match(texto, /Nada é gravado/i);
    assert.match(texto, /Matrícula/);
    assert.match(texto, /CPF não é aceito/i);
  });

  test('K7-D6 — encerrar a tela (sessão acabou) remove o iframe', async () => {
    const { pg } = await abrir();
    await aba(pg, 'visualizarTotem');
    assert.equal(quadroDaPrevia(pg).length, 1);
    pg.janela.__tela.encerrar();
    assert.equal(quadroDaPrevia(pg).length, 0);
  });

  test('K7-D7b — a demonstração é o modo padrão e o iframe dela continua com o caminho sem parâmetros', async () => {
    const { pg } = await abrir();
    await aba(pg, 'visualizarTotem');
    assert.equal(pg.el('modoPreviaDemo').checked, true);
    assert.equal(pg.el('modoPreviaReal').checked, false);
    assert.equal(quadroDaPrevia(pg)[0].getAttribute('src'), '../totem/previa.html');
    assert.equal(pg.visivel('cartaoConsultaReal'), false);
    assert.equal(pg.visivel('avisoPreviaReal'), false);
    assert.equal(pg.visivel('avisoPreviaDemo'), true);
    assert.equal(pg.ouvintesDaJanela('message'), 0, 'sem ouvinte de mensagem na demonstração');
  });

  test('K7-D7 — Monitoramento e Histórico continuam só como estrutura "em integração"', async () => {
    const { pg } = await abrir();
    await aba(pg, 'historico');
    assert.match(pg.el('painel-historico').textContent, /Etapa J[\s\S]*nenhum dado é exibido/);
    await aba(pg, 'monitoramento');
    assert.match(pg.el('painel-monitoramento').textContent, /Etapa J[\s\S]*nenhum dado é exibido/);
    assert.equal(quadroDaPrevia(pg).length, 0);
  });
});

// ───────────────────────── K7 — Consulta real: seletor de modo, cartão do GHE e ponte postMessage ─────────────────────────

describe('K7 — consulta real na Central', () => {
  const CANAL = 'safework-previa-totem';
  const ROTA = 'POST /atendimento-token/previa/identificar';
  const CPF_FICTICIO = '12345678901';
  const MATERIAL = (id, nome, extra = {}) => ({ id, nome, unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 1, nome: 'Botina' }, exigeTamanho: true, tamanhos: ['40', '41'], imagem: { disponivel: false }, ...extra });
  const RESPOSTA_OK = (extra = {}) => ({
    status: 'ok',
    previa: {
      funcionario: { primeiroNome: 'Dora' },
      ghe: { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true },
      catalogo: { estado: 'OK', total: 2, materiais: [MATERIAL(31, 'Botina Teste'), MATERIAL(32, 'Capacete Teste', { exigeTamanho: false, tamanhos: [] })] },
    },
    ...extra,
  });
  const exigirRecurso = (pg) => assert.ok(pg.consulta('#modoPreviaReal').length === 1, 'RED K7: o seletor de modo ainda não existe (comportamento ausente)');

  const janelaFalsa = () => { const enviadas = []; return { enviadas, postMessage: (m, alvo) => enviadas.push({ m: JSON.parse(JSON.stringify(m)), alvo }) }; };
  const identificarMsg = (extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: 'consulta-0001', tipoId: 'MATRICULA', valor: 'MX-4242', ...extra });
  const doQuadro = (pg, janela, data, extra = {}) => pg.eventoDaJanela('message', { data, source: janela, origin: 'null', ...extra });
  const chamadasIdentificar = (pg) => pg.chamadas.filter((c) => c.chave === ROTA);

  async function abrirReal({ perm = TUDO, resposta = () => ({ status: 200, corpo: RESPOSTA_OK() }) } = {}) {
    const r = await abrir({ perm, base: { forcar: { [ROTA]: resposta } } });
    await aba(r.pg, 'visualizarTotem');
    exigirRecurso(r.pg);
    await r.pg.marcar('modoPreviaReal');
    const quadro = quadroDaPrevia(r.pg)[0];
    const filha = janelaFalsa();
    quadro.contentWindow = filha;
    return { ...r, quadro, filha };
  }

  test('K7-F1 — "Consulta real" só aparece com a ação da prévia E employeeHistory.visualizar; a demonstração continua para quem tem só a prévia', async () => {
    const so = await abrir({ perm: permissoes({ acoes: { TOKEN_PREVIA_CATALOGO_REAL: true } }) });
    await aba(so.pg, 'visualizarTotem');
    exigirRecurso(so.pg);
    assert.equal(so.pg.visivel('opcaoModoReal'), false, 'sem employeeHistory.visualizar a consulta real não é oferecida');
    assert.equal(so.pg.visivel('modoPreviaDemo'), true);
    const todos = await abrir();
    await aba(todos.pg, 'visualizarTotem');
    assert.equal(todos.pg.visivel('opcaoModoReal'), true);
  });

  test('K7-F2 — escolher "Consulta real" recria o iframe com modo e origem da Central no endereço, sem relaxar o sandbox, e mostra o aviso e o cartão', async () => {
    const { pg, quadro } = await abrirReal();
    const q = quadroDaPrevia(pg);
    assert.equal(q.length, 1);
    assert.equal(quadro, q[0]);
    assert.equal(q[0].getAttribute('src'), `../totem/previa.html?modo=real&pai=${encodeURIComponent(pg.janela.location.origin)}`);
    assert.equal(q[0].getAttribute('sandbox'), 'allow-scripts');
    assert.ok(q[0].getAttribute('allow') == null);
    assert.equal(pg.visivel('avisoPreviaReal'), true);
    assert.equal(pg.visivel('avisoPreviaDemo'), false);
    assert.equal(pg.visivel('previaTotemCodigos'), false);
    assert.equal(pg.visivel('cartaoConsultaReal'), true);
    assert.equal(pg.ouvintesDaJanela('message'), 1);
    assert.equal(pg.chamadas.filter((c) => c.caminho.includes('previa')).length, 0, 'nenhuma consulta antes de o colaborador ser digitado');
  });

  test('K7-F3 — a identificação vira UM POST com o identificador só no corpo; o cartão mostra colaborador, GHE (código e descrição), situação e materiais; o iframe recebe só nome e catálogo', async () => {
    const { pg, filha } = await abrirReal();
    await doQuadro(pg, filha, identificarMsg());
    const chamadas = chamadasIdentificar(pg);
    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0].corpo, { tipo: 'MATRICULA', valor: 'MX-4242' });
    assert.equal(chamadas[0].url.includes('MX-4242'), false, 'nunca na URL');
    const cartao = pg.el('cartaoConsultaReal').textContent.replace(/\s+/g, ' ');
    for (const esperado of ['Dora', 'GHE-102', 'Soldagem', 'Ativo', 'Botina Teste', 'Capacete Teste']) assert.match(cartao, new RegExp(esperado));
    assert.equal(pg.el('crTotal').textContent.trim(), '2');
    assert.equal(filha.enviadas.length, 1);
    assert.equal(filha.enviadas[0].alvo, '*', 'a origem do iframe é opaca: o destino é a janela exata, não uma origem');
    const msg = filha.enviadas[0].m;
    assert.deepEqual(Object.keys(msg).sort(), ['canal', 'catalogo', 'id', 'primeiroNome', 'resultado', 'tipo', 'versao']);
    assert.deepEqual([msg.canal, msg.versao, msg.tipo, msg.id, msg.resultado, msg.primeiroNome], [CANAL, 1, 'RESULTADO', 'consulta-0001', 'OK', 'Dora']);
    assert.equal(msg.catalogo.materiais.length, 2);
    const texto = JSON.stringify(msg);
    for (const proibido of ['GHE-102', 'Soldagem', 'MX-4242']) assert.equal(texto.includes(proibido), false, `o iframe não recebe ${proibido}`);
  });

  test('K7-F4 — mensagem de fonte, origem, formato, canal, versão, tipo, id ou valor inválidos é ignorada: nenhuma consulta e nenhuma resposta', async () => {
    const { pg, filha } = await abrirReal();
    const casos = [
      ['outra fonte', identificarMsg(), { source: janelaFalsa() }],
      ['sem fonte', identificarMsg(), { source: undefined }],
      ['origem que não é nula', identificarMsg(), { origin: pg.janela.location.origin }],
      ['campo extra', identificarMsg({ cpf: CPF_FICTICIO }), {}],
      ['campo a menos', (() => { const m = identificarMsg(); delete m.id; return m; })(), {}],
      ['canal errado', identificarMsg({ canal: 'outro' }), {}],
      ['versão errada', identificarMsg({ versao: 2 }), {}],
      ['tipo errado', identificarMsg({ tipo: 'RESULTADO' }), {}],
      ['id curto', identificarMsg({ id: 'abc' }), {}],
      ['id com caractere inválido', identificarMsg({ id: 'consulta 0001 <x>' }), {}],
      ['tipoId desconhecido', identificarMsg({ tipoId: 'NOME' }), {}],
      ['valor vazio', identificarMsg({ valor: '' }), {}],
      ['valor longo', identificarMsg({ valor: 'x'.repeat(31) }), {}],
      ['valor com controle', identificarMsg({ valor: 'ab\ncd' }), {}],
      ['valor que não é texto', identificarMsg({ valor: 4242 }), {}],
      ['dados não objeto', 'texto', {}],
      ['dados nulos', null, {}],
      ['dados lista', [identificarMsg()], {}],
    ];
    for (const [rotulo, data, extra] of casos) {
      await doQuadro(pg, filha, data, extra);
      assert.equal(chamadasIdentificar(pg).length, 0, `${rotulo}: não pode consultar`);
      assert.equal(filha.enviadas.length, 0, `${rotulo}: não pode responder`);
    }
  });

  test('K7-F5 — os resultados do servidor viram respostas fixas ao iframe: não identificado, limite e indisponível; 401 encerra a sessão e não responde nada', async () => {
    const mapa = [
      [{ status: 404, corpo: { status: 'error', codigo: 'FUNCIONARIO_NAO_IDENTIFICADO', message: 'x' } }, 'NAO_IDENTIFICADO'],
      [{ status: 429, corpo: { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO', message: 'x' } }, 'LIMITE'],
      [{ status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'x' } }, 'INDISPONIVEL'],
      [{ status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } }, 'INDISPONIVEL'],
      [{ status: 200, corpo: { status: 'ok', previa: { funcionario: { primeiroNome: '' } } } }, 'INDISPONIVEL'],
    ];
    for (const [servidor, esperado] of mapa) {
      const { pg, filha } = await abrirReal({ resposta: () => servidor });
      await doQuadro(pg, filha, identificarMsg());
      assert.equal(filha.enviadas.length, 1, esperado);
      assert.deepEqual(Object.keys(filha.enviadas[0].m).sort(), ['canal', 'id', 'resultado', 'tipo', 'versao']);
      assert.equal(filha.enviadas[0].m.resultado, esperado);
    }
    const { pg, filha } = await abrirReal({ resposta: () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } }) });
    await doQuadro(pg, filha, identificarMsg());
    assert.equal(filha.enviadas.length, 0, 'sessão perdida: nada é liberado ao iframe');
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('K7-F6 — o identificador (CPF ou matrícula) não aparece em armazenamento, cookie, histórico, console, URL, cartão nem na resposta ao iframe', async () => {
    const { pg, filha } = await abrirReal({ resposta: () => ({ status: 404, corpo: { status: 'error', codigo: 'FUNCIONARIO_NAO_IDENTIFICADO', message: 'x' } }) });
    await doQuadro(pg, filha, identificarMsg({ tipoId: 'CPF', valor: CPF_FICTICIO }));
    const lugares = JSON.stringify({ s: pg.storage, c: pg.cookiesEscritos, h: pg.historico, n: pg.navegacoes, k: pg.consoleChamadas, card: pg.el('cartaoConsultaReal').textContent, resp: filha.enviadas, urls: pg.chamadas.map((c) => c.url) });
    assert.equal(lugares.includes(CPF_FICTICIO), false);
    assert.equal(chamadasIdentificar(pg)[0].corpoBruto.includes(CPF_FICTICIO), true, 'só o corpo do POST leva o valor');
  });

  test('K7-F7 — NÃO identificado: o cartão avisa sem repetir o valor, e identificado limpa o aviso anterior', async () => {
    let n = 0;
    const { pg, filha } = await abrirReal({ resposta: () => (n++ === 0 ? { status: 404, corpo: { status: 'error', codigo: 'FUNCIONARIO_NAO_IDENTIFICADO', message: 'x' } } : { status: 200, corpo: RESPOSTA_OK() }) });
    await doQuadro(pg, filha, identificarMsg());
    assert.match(pg.el('crMensagem').textContent, /não identificado|não encontrado/i);
    assert.equal(pg.el('crMensagem').textContent.includes('MX-4242'), false);
    await doQuadro(pg, filha, identificarMsg({ id: 'consulta-0002' }));
    assert.equal(pg.el('crMensagem').textContent.trim(), '');
    assert.match(pg.el('crColaborador').textContent, /Dora/);
  });

  test('K7-F8 — uma consulta por vez: a segunda mensagem enquanto a primeira está em andamento é ignorada', async () => {
    let liberar;
    const { pg, filha } = await abrirReal({ resposta: () => new Promise((resolver) => { liberar = () => resolver({ status: 200, corpo: RESPOSTA_OK() }); }) });
    const primeira = doQuadro(pg, filha, identificarMsg());
    await pg.esperar();
    await doQuadro(pg, filha, identificarMsg({ id: 'consulta-0002' }));
    assert.equal(chamadasIdentificar(pg).length, 1);
    liberar();
    await primeira;
    await pg.esperar();
    assert.equal(filha.enviadas.length, 1);
    assert.equal(filha.enviadas[0].m.id, 'consulta-0001');
  });

  test('K7-F9 — sair da aba, trocar de modo ou encerrar a sessão descarta iframe, ouvinte, cartão e consulta em andamento: resposta tardia nunca chega ao iframe', async () => {
    for (const acao of ['sair', 'demonstracao', 'reiniciar', 'encerrar']) {
      let liberar;
      const { pg, filha } = await abrirReal({ resposta: () => new Promise((resolver) => { liberar = () => resolver({ status: 200, corpo: RESPOSTA_OK() }); }) });
      const andamento = doQuadro(pg, filha, identificarMsg());
      await pg.esperar();
      if (acao === 'sair') await aba(pg, 'historico');
      if (acao === 'demonstracao') await pg.marcar('modoPreviaDemo');
      if (acao === 'reiniciar') await pg.clicar('botaoReiniciarPrevia');
      if (acao === 'encerrar') pg.janela.__tela.encerrar();
      liberar();
      await andamento;
      await pg.esperar();
      assert.equal(filha.enviadas.length, 0, `${acao}: nada pode ser entregue ao iframe descartado`);
      assert.equal(pg.el('crColaborador').textContent.includes('Dora'), false, `${acao}: o cartão não recebe o resultado tardio`);
      if (acao !== 'reiniciar') assert.equal(pg.ouvintesDaJanela('message'), acao === 'sair' || acao === 'demonstracao' || acao === 'encerrar' ? 0 : 1, acao);
      await doQuadro(pg, filha, identificarMsg({ id: 'consulta-0003' }));
      assert.equal(chamadasIdentificar(pg).length, 1, `${acao}: mensagem de iframe descartado é ignorada`);
    }
  });

  test('K7-F10 — ao voltar à aba o modo é sempre a demonstração; o cartão e o estado anterior não voltam', async () => {
    const { pg, filha } = await abrirReal();
    await doQuadro(pg, filha, identificarMsg());
    assert.match(pg.el('crColaborador').textContent, /Dora/);
    await aba(pg, 'historico');
    await aba(pg, 'visualizarTotem');
    assert.equal(pg.el('modoPreviaDemo').checked, true);
    assert.equal(quadroDaPrevia(pg)[0].getAttribute('src'), '../totem/previa.html');
    assert.equal(pg.el('crColaborador').textContent.includes('Dora'), false);
    assert.equal(pg.visivel('cartaoConsultaReal'), false);
  });

  test('K7-F11 — só os campos da lista chegam ao iframe e ao cartão, mesmo que o servidor mande mais', async () => {
    const resposta = RESPOSTA_OK();
    resposta.previa.funcionario = { primeiroNome: 'Dora', nome: 'Dora Souza Fictícia', cpf: CPF_FICTICIO, matricula: 'MX-4242', id: 77 };
    resposta.previa.ghe.setor = 'Soldagem industrial';
    resposta.previa.catalogo.materiais[0].saldo = 99;
    const { pg, filha } = await abrirReal({ resposta: () => ({ status: 200, corpo: resposta }) });
    await doQuadro(pg, filha, identificarMsg());
    const tudo = JSON.stringify(filha.enviadas) + pg.el('cartaoConsultaReal').textContent;
    for (const proibido of ['Souza', CPF_FICTICIO, 'industrial', '"saldo"', '"id":77']) assert.equal(tudo.includes(proibido), false, proibido);
  });

  test('K7-F12 — a demonstração não foi tocada: com o modo real e de volta à demonstração, o iframe da demo nasce sem parâmetros e sem ouvinte', async () => {
    const { pg } = await abrirReal();
    await pg.marcar('modoPreviaDemo');
    assert.equal(quadroDaPrevia(pg).length, 1);
    assert.equal(quadroDaPrevia(pg)[0].getAttribute('src'), '../totem/previa.html');
    assert.equal(pg.ouvintesDaJanela('message'), 0);
    assert.equal(pg.visivel('cartaoConsultaReal'), false);
  });
});

// ───────────────────────── K7 — rodada de melhorias visuais e de navegação (cinco requisitos) ─────────────────────────

describe('K7 melhorias — 1. cartões da Visão Geral', () => {
  const ESPERADO = [
    ['Dispositivos cadastrados', 'azul', 'tablet_android', '3'],
    ['Dispositivos ativos', 'verde', 'check_circle', '1'],
    ['Aguardando ativação', 'laranja', 'hourglass_top', '1'],
    ['Dispositivos revogados', 'vermelho', 'block', '1'],
    ['Ativações pendentes', 'roxo', 'qr_code_2', '0'],
  ];

  test('M1-1 — os cinco cartões têm o tom, o ícone, o título e o valor real; o valor e o cálculo não mudaram', async () => {
    const { pg } = await abrir();
    const cartoes = pg.consulta('#visaoGeralCartoes .stat');
    assert.equal(cartoes.length, 5);
    cartoes.forEach((c, i) => {
      const [titulo, tom, icone, valor] = ESPERADO[i];
      assert.equal(c.getAttribute('data-cartao'), titulo);
      assert.equal(c.getAttribute('data-tom'), tom);
      assert.equal(c.querySelector('i').getAttribute('data-icone'), icone);
      assert.equal(c.querySelector('span').textContent, titulo);
      assert.equal(c.querySelector('strong').textContent, valor);
    });
  });

  test('M1-2 — a cor nunca é o único indicador: cada cartão tem título em texto e ícone próprio; o ícone é decorativo e não entra no texto', async () => {
    const { pg } = await abrir();
    const cartoes = pg.consulta('#visaoGeralCartoes .stat');
    assert.equal(new Set(cartoes.map((c) => c.querySelector('i').getAttribute('data-icone'))).size, 5, 'cinco ícones distintos');
    assert.equal(new Set(cartoes.map((c) => c.getAttribute('data-tom'))).size, 5, 'cinco tons distintos');
    for (const c of cartoes) {
      assert.equal(c.querySelector('i').getAttribute('aria-hidden'), 'true');
      assert.equal(c.textContent, `${c.getAttribute('data-cartao')}${c.querySelector('strong').textContent}`, 'o nome do ícone não vaza para o texto');
    }
  });

  test('M1-3 — a folha da página define fundo suave, tom, ícone e destaque do número para os cinco tons, no claro e no escuro', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '..', PAGINA), 'utf8');
    for (const tom of ['azul', 'verde', 'laranja', 'vermelho', 'roxo']) {
      const re = tom === 'azul' ? /\.stat-token\{--tom:#007AFF/ : new RegExp(`\\.stat-token\\[data-tom="${tom}"\\]\\{--tom:#`);
      assert.match(html, re, `tom ${tom}`);
      if (tom !== 'azul') assert.match(html, new RegExp(`html\\[data-theme="dark"\\] \\.stat-token\\[data-tom="${tom}"\\]`), `escuro ${tom}`);
    }
    assert.match(html, /\.stat-token\{[^}]*border-radius:14px[^}]*background:var\(--tom-fundo\)/);
    assert.match(html, /\.stat-token strong\{[^}]*font-size:34px/);
    assert.match(html, /\.stat-token-icone::before\{font-size:20px\}/);
  });

  test('M1-4 — o painel continua lendo só a rota da visão geral (nenhuma fonte de dados nova)', async () => {
    const { pg } = await abrir();
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/visao-geral').length, 1);
    assert.equal(pg.chamadas.filter((c) => c.metodo !== 'GET').length, 0);
  });
});

describe('K7 melhorias — 2. botões e ícones', () => {
  const lerPagina = () => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', PAGINA), 'utf8');

  test('M2-1 — "Reiniciar prévia" e os "Atualizar" ganham ícone; o texto dos botões não mudou', async () => {
    const { pg } = await abrir();
    const esperado = { botaoReiniciarPrevia: ['restart_alt', 'Reiniciar prévia'], botaoAtualizarVisaoGeral: ['refresh', 'Atualizar'], botaoAtualizarDispositivos: ['refresh', 'Atualizar'],
      botaoAtualizarRedes: ['refresh', 'Atualizar'], botaoAtualizarEstadoAtivacao: ['refresh', 'Atualizar estado'], dispositivosAnterior: ['chevron_left', 'Anterior'],
      dispositivosProxima: ['chevron_right', 'Próxima'], botaoCancelarDispositivo: ['close', 'Cancelar'], botaoCancelarConfirmar: ['close', 'Cancelar'], botaoNovaAtivacaoQr: ['qr_code_2', 'Gerar nova ativação'] };
    for (const [id, [icone, texto]] of Object.entries(esperado)) {
      assert.equal(pg.el(id).getAttribute('data-icone'), icone, id);
      assert.equal(pg.el(id).textContent.trim(), texto, `${id}: o texto não inclui o nome do ícone`);
    }
  });

  test('M2-2 — botões de linha criados pela tela também têm ícone, e a ação perigosa continua distinta (perigo-texto) e confirmada como antes', async () => {
    const { pg } = await abrir();
    await aba(pg, 'dispositivos');
    const editar = botoes(pg, '#corpoDispositivos [data-acao="editar"]')[0];
    const revogar = botoes(pg, '#corpoDispositivos [data-acao="revogar"]')[0];
    assert.equal(editar.getAttribute('data-icone'), 'edit');
    assert.equal(revogar.getAttribute('data-icone'), 'block');
    assert.equal(revogar.classList.contains('perigo-texto'), true);
    assert.equal(editar.classList.contains('perigo-texto'), false);
    assert.equal(revogar.textContent, 'Revogar');
    await aba(pg, 'ativacao');
    assert.equal(botoes(pg, '#corpoRedes [data-acao="desativar-rede"]')[0].getAttribute('data-icone'), 'wifi_off');
  });

  test('M2-3 — a hierarquia é preservada: abas continuam abas (sem virar botões azuis), ações primárias continuam sólidas, secundárias tonais e perigosas vermelhas', async () => {
    const { pg } = await abrir();
    for (const a of ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem']) {
      const classes = pg.el(`aba-${a}`).getAttribute('class');
      assert.match(classes, /\breport-tab\b/);
      assert.doesNotMatch(classes, /filled-btn|outlined-btn|tonal-btn/, `a aba ${a} não vira botão`);
      assert.equal(pg.el(`aba-${a}`).getAttribute('data-icone'), null, 'abas sem ícone de botão');
    }
    assert.match(pg.el('botaoNovoDispositivo').getAttribute('class'), /\bfilled-btn\b/);
    assert.match(pg.el('botaoConfirmar').getAttribute('class'), /\bfilled-btn\b/);
    const html = lerPagina();
    assert.match(html, /#conteudoProtegido \.outlined-btn\.perigo-texto[^{]*\{[^}]*var\(--error\)/);
    assert.doesNotMatch(html, /\.report-tab\.active\{[^}]*background:var\(--primary\)/, 'aba ativa não ganha o azul sólido dos botões');
  });

  test('M2-4 — hover, foco visível e desabilitado estão definidos; o desabilitado continua cinza e sem hover', () => {
    const html = lerPagina();
    assert.match(html, /\.outlined-btn:hover:not\(:disabled\)/);
    assert.match(html, /\.outlined-btn:active:not\(:disabled\)/);
    assert.match(html, /\.filled-btn:hover:not\(:disabled\)/);
    assert.match(html, /\.report-tab:focus-visible,\.outlined-btn:focus-visible,\.filled-btn:focus-visible/);
    assert.match(html, /#conteudoProtegido button:disabled\{[^}]*filter:grayscale\(1\)/);
    assert.match(html, /\[data-icone\]::before\{content:attr\(data-icone\)/);
  });
});

describe('K7 melhorias — 4. a aba escolhida sobrevive à atualização da página', () => {
  const ABAS_TODAS = ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem'];
  const hashDe = (pg) => pg.location.hash;
  const gravacoesDeAba = (pg) => pg.historico.filter((h) => typeof h.url === 'string' && h.url.includes('#aba='));

  test('M4-1 — sem fragmento: abre a Visão Geral e não escreve nada no endereço', async () => {
    const { pg } = await abrir();
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
    assert.equal(hashDe(pg), '');
    assert.equal(gravacoesDeAba(pg).length, 0);
  });

  test('M4-2 — clicar numa aba grava #aba=<nome> (um registro de histórico por troca) e repetir a mesma aba não duplica', async () => {
    const { pg } = await abrir();
    await aba(pg, 'dispositivos');
    assert.equal(hashDe(pg), '#aba=dispositivos');
    await aba(pg, 'dispositivos');
    await aba(pg, 'previa');
    assert.equal(hashDe(pg), '#aba=previa');
    assert.deepEqual(gravacoesDeAba(pg).map((h) => [h.metodo, h.url]), [['pushState', '#aba=dispositivos'], ['pushState', '#aba=previa']]);
  });

  for (const nome of ABAS_TODAS) {
    test(`M4-3 (${nome}) — F5/Cmd+R: reabrir com #aba=${nome} volta exatamente para essa aba e só ela`, async () => {
      const { pg } = await abrir({ hash: `#aba=${nome}` });
      assert.deepEqual(painelAberto(pg), [nome]);
      assert.equal(pg.el(`aba-${nome}`).getAttribute('aria-selected'), 'true');
      assert.equal(hashDe(pg), `#aba=${nome}`);
    });
  }

  test('M4-4 — a atualização completa: clicar, "recarregar" com o endereço atual e continuar na mesma aba', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    const recarregada = await abrir({ hash: hashDe(pg) });
    assert.deepEqual(painelAberto(recarregada.pg), ['ativacao']);
  });

  test('M4-5 — fragmento desconhecido ou de outro uso (nome inventado, token, lixo) é ignorado: Visão Geral, sem reescrever o endereço', async () => {
    for (const hash of ['#aba=inexistente', '#token=ABC', '#aba=', '#aba=visaoGeral&x=1', '#ABA=previa', '#aba=__proto__', '#qualquer']) {
      const { pg } = await abrir({ hash });
      assert.deepEqual(painelAberto(pg), ['visaoGeral'], hash);
      assert.equal(gravacoesDeAba(pg).length, 0, hash);
    }
  });

  test('M4-6 — aba salva sem permissão: cai numa aba permitida, corrige o endereço e NUNCA monta nem consulta o conteúdo restrito', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA, hash: '#aba=previa' });
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
    assert.equal(pg.visivel('painel-previa'), false);
    assert.equal(hashDe(pg), '#aba=visaoGeral');
    assert.equal(chamadasDe(pg, 'GET /atendimento-token/previa/catalogo').length, 0);
    assert.equal(chamadasDe(pg, 'GET /funcionarios').length, 0);
    const outra = await abrir({ perm: SO_LEITURA, hash: '#aba=visualizarTotem' });
    assert.equal(outra.pg.visivel('painel-visualizarTotem'), false);
    assert.equal(quadroDaPrevia(outra.pg).length, 0, 'sem iframe da prévia');
  });

  test('M4-7 — o Visualizar Totem sem a ação da prévia não abre pelo endereço; com permissão, abre', async () => {
    const semAcao = permissoes({ recurso: { visualizar: true }, acoes: { TOKEN_GERAR_ATIVACAO: true } });
    const negado = await abrir({ perm: semAcao, hash: '#aba=visualizarTotem' });
    assert.equal(negado.pg.visivel('painel-visualizarTotem'), false);
    assert.deepEqual(painelAberto(negado.pg), ['visaoGeral']);
    const ok = await abrir({ hash: '#aba=visualizarTotem' });
    assert.deepEqual(painelAberto(ok.pg), ['visualizarTotem']);
    assert.equal(quadroDaPrevia(ok.pg).length, 1);
  });

  test('M4-8 — voltar/avançar do navegador (hashchange) troca a aba; fragmento vazio volta à Visão Geral; fragmento sem permissão é corrigido', async () => {
    const { pg } = await abrir({ perm: SO_LEITURA });
    pg.location.hash = '#aba=ativacao';
    await pg.eventoDaJanela('hashchange');
    assert.deepEqual(painelAberto(pg), ['ativacao']);
    pg.location.hash = '';
    await pg.eventoDaJanela('hashchange');
    assert.deepEqual(painelAberto(pg), ['visaoGeral']);
    pg.location.hash = '#aba=previa';
    await pg.eventoDaJanela('hashchange');
    assert.deepEqual(painelAberto(pg), ['visaoGeral'], 'sem permissão: não abre');
    assert.equal(hashDe(pg), '#aba=visaoGeral', 'e o endereço é corrigido');
  });

  test('M4-9 — pelo teclado (setas/Home/End) a aba também é gravada; o foco e o aria-selected seguem corretos', async () => {
    const { pg } = await abrir();
    await pg.el('abas').disparar('keydown', { key: 'ArrowRight', preventDefault() {} });
    assert.equal(hashDe(pg), '#aba=dispositivos');
    await pg.el('abas').disparar('keydown', { key: 'End', preventDefault() {} });
    assert.equal(hashDe(pg), '#aba=visualizarTotem');
    assert.equal(pg.el('aba-visualizarTotem').getAttribute('aria-selected'), 'true');
  });

  test('M4-10 — nada pessoal vai para o endereço nem para o armazenamento: o fragmento só tem o nome da aba, mesmo com busca, CPF e prévia', async () => {
    const { pg } = await abrir();
    const marca = marcaDeArmazenamento(pg);
    await aba(pg, 'previa');
    await pg.digitar('previaBusca', 'ana');
    await pg.enviar('previaBuscaForm');
    assert.match(hashDe(pg), /^#aba=previa$/);
    await aba(pg, 'visualizarTotem');
    assert.match(hashDe(pg), /^#aba=visualizarTotem$/);
    assert.equal(pg.location.search, '');
    assert.equal(pg.location.href.includes('ana'), false);
    semNovosRastros(pg, marca);
  });

  test('M4-11 — sessão encerrada: a tela solta o endereço (não reage mais ao histórico) e não monta mais nada', async () => {
    const { pg } = await abrir();
    pg.janela.__tela.encerrar();
    pg.location.hash = '#aba=dispositivos';
    await pg.eventoDaJanela('hashchange');
    assert.equal(pg.visivel('painel-dispositivos'), false);
    assert.equal(pg.ouvintesDaJanela('hashchange'), 0);
  });

  test('M4-12 — sair de Ativação por F5 não retém o código; o endereço guardado não traz código nem token', async () => {
    const { pg } = await abrir();
    await aba(pg, 'ativacao');
    assert.equal(hashDe(pg).includes(SEGREDO), false);
    assert.equal(pg.janela.__tela._qrRetido(), false);
  });
});

describe('K7 melhorias — 5. produtos com tamanhos', () => {
  const CANAL = 'safework-previa-totem';
  const ROTA = 'POST /atendimento-token/previa/identificar';
  const MATERIAL = (id, nome, extra = {}) => ({ id, nome, unidade: 'par', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 14, nome: 'Sapato de Segurança' }, exigeTamanho: true, tamanhos: ['33', '34', '35', '44', '46'], imagem: { disponivel: false }, ...extra });
  const RESPOSTA = () => ({ status: 'ok', previa: { funcionario: { primeiroNome: 'Dora' }, ghe: { codigo: 'GHE-029', descricao: 'Portaria', ativo: true },
    catalogo: { estado: 'OK', total: 4, materiais: [
      MATERIAL(31, 'Sapato de Segurança - Homologação'),
      MATERIAL(32, 'Camiseta Operacional', { categoria: 'Vestimenta', tipo: { id: 30, nome: 'Camiseta' }, tamanhos: ['P', 'M', 'G', 'GG'] }),
      MATERIAL(33, 'Calça de Segurança', { categoria: 'Vestimenta', tipo: { id: 21, nome: 'Calça de Segurança' }, tamanhos: ['38', '40', '42'] }),
      MATERIAL(34, 'Capacete de Segurança', { tipo: { id: 4, nome: 'Capacete de Segurança' }, exigeTamanho: false, tamanhos: [] }),
    ] } } });
  const janelaFalsa = () => { const enviadas = []; return { enviadas, postMessage: (m, alvo) => enviadas.push({ m: JSON.parse(JSON.stringify(m)), alvo }) }; };

  async function abrirComResultado() {
    const r = await abrir({ base: { forcar: { [ROTA]: () => ({ status: 200, corpo: RESPOSTA() }) } } });
    await aba(r.pg, 'visualizarTotem');
    await r.pg.marcar('modoPreviaReal');
    const filha = janelaFalsa();
    quadroDaPrevia(r.pg)[0].contentWindow = filha;
    await r.pg.eventoDaJanela('message', { data: { canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: 'consulta-0001', tipoId: 'MATRICULA', valor: 'MX-4242' }, source: filha, origin: 'null' });
    return { ...r, filha };
  }

  test('M5-1 — Conferência da consulta real: "Possui tamanhos" para qualquer produto com grade (calçado, camiseta, calça) e "Sem tamanho" para os demais; nunca as numerações', async () => {
    const { pg } = await abrirComResultado();
    const itens = pg.consulta('#crMateriais li').map((li) => li.textContent);
    assert.deepEqual(itens, [
      'Sapato de Segurança - Homologação · Sapato de Segurança · Possui tamanhos',
      'Camiseta Operacional · Camiseta · Possui tamanhos',
      'Calça de Segurança · Calça de Segurança · Possui tamanhos',
      'Capacete de Segurança · Capacete de Segurança · Sem tamanho',
    ]);
    const lista = pg.el('crMateriais').textContent;
    for (const proibido of ['33', '34', '44', '46', 'GG', 'Tamanhos:']) assert.equal(lista.includes(proibido), false, `a lista não mostra ${proibido}`);
  });

  test('M5-2 — dentro do Totem os tamanhos reais continuam chegando ao iframe para a escolha, depois da identificação', async () => {
    const { filha } = await abrirComResultado();
    assert.equal(filha.enviadas.length, 1);
    const mats = filha.enviadas[0].m.catalogo.materiais;
    assert.deepEqual(mats[0].tamanhos, ['33', '34', '35', '44', '46']);
    assert.deepEqual(mats[1].tamanhos, ['P', 'M', 'G', 'GG']);
    assert.deepEqual(mats[3].tamanhos, []);
    assert.equal(mats[0].exigeTamanho, true);
  });

  test('M5-3 — a Prévia do catálogo (lista por funcionário) segue a mesma regra', async () => {
    const { pg } = await abrir({ base: { previas: { 31: { estado: 'OK', total: 2, materiais: [MATERIAL(31, 'Sapato de Segurança - Homologação'), MATERIAL(34, 'Capacete', { exigeTamanho: false, tamanhos: [], tipo: { id: 4, nome: 'Capacete' } })] } } } });
    await aba(pg, 'previa');
    await pg.digitar('previaBusca', 'ana');
    await pg.enviar('previaBuscaForm');
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    const itens = pg.consulta('#previaResultado li').map((li) => li.textContent);
    assert.match(itens[0], /Sapato de Segurança - Homologação.*Possui tamanhos/);
    assert.match(itens[1], /Capacete.*Sem tamanho/);
    assert.doesNotMatch(itens.join(' '), /\b33\b|\b44\b|Tamanhos:/);
  });

  test('M5-4 — o código da tela não enumera mais os tamanhos nessas duas listas', () => {
    const codigo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js/atendimento-token-tela.js'), 'utf8');
    assert.doesNotMatch(codigo, /'Tamanhos: '/);
    assert.doesNotMatch(codigo, /m\.tamanhos\.join/);
    assert.match(codigo, /POSSUI_TAMANHOS: 'Possui tamanhos'/);
  });
});

// ───────────────────────── K7 — A1 (monocromático) e A2 (alto contraste) ─────────────────────────
// Os modos vêm de js/tema.js: monocromatico → html[data-a11y="monochrome"]; alto_contraste → html[data-display="contrast"].
// Os testes leem as regras reais do <style> da página (nada é recalculado por fora) e conferem cores, contraste e escopo.

describe('K7 A1/A2 — modos monocromático e alto contraste da Central', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const LER = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const estilo = () => /<style>([\s\S]*?)<\/style>/.exec(LER(PAGINA))[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const regras = () => [...estilo().matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim(), decl: m[2] }));
  const doModo = (prefixo) => regras().filter((r) => r.sel.split(',').some((s) => s.trim().startsWith(prefixo)));
  const MONO = 'html[data-a11y="monochrome"]';
  const CONTRASTE = 'html[data-display="contrast"]';
  const regra = (seletor) => { const r = regras().find((x) => x.sel === seletor); assert.ok(r, `regra não encontrada: ${seletor}`); return r; };
  const propriedade = (r, nome) => { const m = new RegExp(`(?:^|;)\\s*${nome.replace(/-/g, '\\-')}:([^;]+)`).exec(r.decl); return m ? m[1].trim() : null; };
  const semImportante = (v) => v.replace(/\s*!important/, '').trim();

  // Cores: #RRGGBB e rgba(r,g,b,a); rgba é composta sobre a cor de base (superfície do cartão).
  const rgb = (v, base = [255, 255, 255]) => {
    const t = semImportante(v);
    let m = /^#([0-9a-f]{6})$/i.exec(t);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(t);
    assert.ok(m, `cor não reconhecida: ${v}`);
    const a = Number(m[4]);
    return [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + base[k] * (1 - a)));
  };
  const luz = ([r, g, b]) => { const c = [r, g, b].map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const razao = (a, b) => { const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const acromatica = (v) => { const [r, g, b] = rgb(v); return r === g && g === b; };
  const CORES_NA_DECL = (decl) => [...decl.matchAll(/(#[0-9a-fA-F]{6}\b|rgba\([^)]*\))/g)].map((m) => m[1]);

  test('A1-1 — os seletores dos modos são os que o tema.js realmente aplica', () => {
    const tema = LER('js/tema.js');
    assert.match(tema, /alto_contraste:\s*\{\s*atributo:\s*'data-display',\s*valor:\s*'contrast'\s*\}/);
    assert.match(tema, /monocromatico:\s*\{\s*atributo:\s*'data-a11y',\s*valor:\s*'monochrome'\s*\}/);
    assert.ok(LER('css/main.css').includes(`${MONO} {`) || LER('css/main.css').includes(`${MONO}{`), 'o main.css define o monocromático com este seletor');
    assert.ok(LER('css/main.css').includes(`${CONTRASTE} .card`), 'o main.css define o alto contraste com este seletor');
  });

  test('A1-2 — monocromático: os cartões usam só tons neutros (cinza), nos temas claro e escuro, e a regra vale para os cinco tons', () => {
    for (const sel of [`${MONO} .stat-token`, `${MONO}[data-theme="dark"] .stat-token`]) {
      const r = regra(sel);
      for (const v of ['--tom', '--tom-texto', '--tom-fundo', '--tom-borda']) {
        const valor = propriedade(r, v);
        assert.ok(valor, `${sel} define ${v}`);
        assert.match(valor, /!important$/, `${v} com !important (vence os tons e o tema escuro, de maior especificidade)`);
        assert.equal(acromatica(valor), true, `${sel}: ${v}=${valor} é neutro`);
      }
    }
    assert.doesNotMatch(regra(`${MONO} .stat-token`).sel, /data-tom/, 'sem data-tom: cobre os cinco tons de uma vez');
    assert.ok(luz(rgb(propriedade(regra(`${MONO}[data-theme="dark"] .stat-token`), '--tom-texto'))) > 0.8, 'no escuro o número é claro');
    assert.ok(luz(rgb(propriedade(regra(`${MONO} .stat-token`), '--tom-texto'))) < 0.05, 'no claro o número é escuro');
  });

  test('A1-3 — monocromático: título do cartão, borda e realce dos botões também ficam neutros; a ação perigosa segue o --error do próprio modo', () => {
    assert.match(regra(`${MONO} .stat-token-topo span`).decl, /color:var\(--tom-texto\) !important/);
    for (const r of doModo(MONO).filter((x) => /outlined-btn|filled-btn/.test(x.sel))) {
      for (const cor of CORES_NA_DECL(r.decl)) assert.equal(acromatica(cor), true, `${r.sel}: ${cor}`);
      assert.doesNotMatch(r.sel, /perigo-texto(?!\))/, 'a regra neutra exclui o botão perigoso');
    }
    assert.ok(doModo(MONO).filter((x) => /outlined-btn/.test(x.sel)).length >= 4, 'borda e hover, no claro e no escuro');
  });

  test('A1-4 — os temas claro e escuro aprovados não mudaram: os valores dos cinco tons e do escuro continuam os mesmos', () => {
    const esperado = {
      '.stat-token': '--tom:#007AFF;--tom-texto:#0062CC;--tom-fundo:rgba(0,122,255,0.10);--tom-borda:rgba(0,122,255,0.18)',
      '.stat-token[data-tom="verde"]': '--tom:#34C759;--tom-texto:#1A7A35;--tom-fundo:rgba(52,199,89,0.10);--tom-borda:rgba(52,199,89,0.22)',
      '.stat-token[data-tom="laranja"]': '--tom:#FF9500;--tom-texto:#B26A00;--tom-fundo:rgba(255,149,0,0.10);--tom-borda:rgba(255,149,0,0.22)',
      '.stat-token[data-tom="vermelho"]': '--tom:#FF3B30;--tom-texto:#C4170D;--tom-fundo:rgba(255,59,48,0.10);--tom-borda:rgba(255,59,48,0.22)',
      '.stat-token[data-tom="roxo"]': '--tom:#AF52DE;--tom-texto:#8639B3;--tom-fundo:rgba(175,82,222,0.10);--tom-borda:rgba(175,82,222,0.22)',
      'html[data-theme="dark"] .stat-token': '--tom-texto:#64A8FF',
      'html[data-theme="dark"] .stat-token[data-tom="verde"]': '--tom-texto:#5FDB80',
      'html[data-theme="dark"] .stat-token[data-tom="laranja"]': '--tom-texto:#FFB340',
      'html[data-theme="dark"] .stat-token[data-tom="vermelho"]': '--tom-texto:#FF7A72',
      'html[data-theme="dark"] .stat-token[data-tom="roxo"]': '--tom-texto:#C98BEA',
    };
    const soVariaveis = (d) => [...d.matchAll(/--tom[a-z-]*:[^;]+/g)].map((m) => m[0]).join(';');
    for (const [sel, decl] of Object.entries(esperado)) {
      const r = regras().find((x) => x.sel === sel && x.decl.includes('--tom-texto'));
      assert.ok(r, sel);
      assert.equal(soVariaveis(r.decl), decl, sel);
    }
    const botao = regra('#conteudoProtegido .outlined-btn, .modal-card .outlined-btn').decl;
    assert.match(botao, /border:0\.5px solid rgba\(0,122,255,0\.18\);background:var\(--primary-container\);color:var\(--primary\)/);
  });

  test('A2-1 — alto contraste: cartões e botões secundários ganham borda de 1,5 px; o desabilitado também', () => {
    assert.match(regra(`${CONTRASTE} .stat-token`).decl, /border-width:1\.5px !important/);
    const botoes = regra(`${CONTRASTE} #conteudoProtegido .outlined-btn, ${CONTRASTE} .modal-card .outlined-btn`).decl;
    assert.match(botoes, /border-width:1\.5px !important/);
    assert.match(regra(`${CONTRASTE} #conteudoProtegido button:disabled`).decl, /border:1\.5px solid/);
  });

  test('A2-2 — alto contraste: texto dos cartões com contraste WCAG AA (≥ 4,5:1 o número; ≥ 7:1 o título) e borda ≥ 3:1, nos cinco tons', () => {
    const tons = ['azul', 'verde', 'laranja', 'vermelho', 'roxo'];
    for (const tom of tons) {
      const r = regra(`${CONTRASTE} .stat-token[data-tom="${tom}"]`);
      const texto = rgb(propriedade(r, '--tom-texto')); const fundo = rgb(propriedade(r, '--tom-fundo')); const borda = rgb(propriedade(r, '--tom-borda'));
      assert.ok(razao(texto, fundo) >= 4.5, `${tom}: número ${razao(texto, fundo).toFixed(2)}`);
      assert.ok(razao([0, 0, 0], fundo) >= 7, `${tom}: título ${razao([0, 0, 0], fundo).toFixed(2)}`);
      assert.ok(razao(borda, fundo) >= 3, `${tom}: borda ${razao(borda, fundo).toFixed(2)}`);
    }
    assert.match(regra(`${CONTRASTE} .stat-token-topo span`).decl, /color:#000000 !important/, 'o título não depende do tema escuro');
    assert.equal(new Set(tons.map((t) => propriedade(regra(`${CONTRASTE} .stat-token[data-tom="${t}"]`), '--tom-fundo'))).size, 5, 'cinco fundos distintos');
  });

  test('A2-3 — alto contraste: botão secundário e botão perigoso legíveis (≥ 4,5:1) e diferentes entre si por cor E por borda; o ícone do cartão é desenhado em contorno', () => {
    const normal = regra(`${CONTRASTE} #conteudoProtegido .outlined-btn, ${CONTRASTE} .modal-card .outlined-btn`).decl;
    const perigo = regra(`${CONTRASTE} #conteudoProtegido .outlined-btn.perigo-texto, ${CONTRASTE} .modal-card .outlined-btn.perigo-texto`).decl;
    const dados = (d) => ({ cor: propriedade({ decl: d }, 'color'), fundo: propriedade({ decl: d }, 'background'), borda: propriedade({ decl: d }, 'border-color') });
    const n = dados(normal); const p = dados(perigo);
    assert.ok(razao(rgb(n.cor), rgb(n.fundo)) >= 4.5, `secundário ${razao(rgb(n.cor), rgb(n.fundo)).toFixed(2)}`);
    assert.ok(razao(rgb(p.cor), rgb(p.fundo)) >= 4.5, `perigoso ${razao(rgb(p.cor), rgb(p.fundo)).toFixed(2)}`);
    assert.notEqual(semImportante(n.cor), semImportante(p.cor));
    assert.notEqual(semImportante(n.borda), semImportante(p.borda));
    assert.ok(razao(rgb(n.borda), rgb(n.fundo)) >= 3 && razao(rgb(p.borda), rgb(p.fundo)) >= 3, 'borda perceptível');
    assert.match(regra(`${CONTRASTE} .stat-token-icone`).decl, /background:#FFFFFF !important;border:1\.5px solid var\(--tom-borda\)/);
    assert.match(regra(`${CONTRASTE} #conteudoProtegido .outlined-btn.perigo-texto:hover:not(:disabled), ${CONTRASTE} .modal-card .outlined-btn.perigo-texto:hover:not(:disabled)`).decl, /background:#FFD6D6 !important/);
  });

  test('A2-4 — alto contraste: foco visível de 3 px nas abas e nos botões', () => {
    const r = regra(`${CONTRASTE} .report-tab:focus-visible, ${CONTRASTE} .outlined-btn:focus-visible, ${CONTRASTE} .filled-btn:focus-visible`);
    assert.match(r.decl, /outline:3px solid #000 !important/);
    assert.match(r.decl, /outline-offset:2px/);
  });

  test('A1/A2 — escopo: as regras dos dois modos só mexem em cor, borda, sombra e contorno (nada de display, tamanho ou conteúdo), e o DOM e os valores seguem iguais', async () => {
    const proibidas = /(?:^|;)\s*(?:display|visibility|content|font-size|width|height|padding|margin|opacity):/;
    const doisModos = [...doModo(MONO), ...doModo(CONTRASTE)].filter((r) => /stat-token|outlined-btn|filled-btn|report-tab|button:disabled/.test(r.sel));
    assert.ok(doisModos.length >= 18, `regras dos modos: ${doisModos.length}`);
    for (const r of doisModos) assert.doesNotMatch(r.decl, proibidas, r.sel);
    const { pg } = await abrir();
    const cartoes = pg.consulta('#visaoGeralCartoes .stat');
    assert.deepEqual(cartoes.map((c) => [c.getAttribute('data-cartao'), c.querySelector('strong').textContent]),
      [['Dispositivos cadastrados', '3'], ['Dispositivos ativos', '1'], ['Aguardando ativação', '1'], ['Dispositivos revogados', '1'], ['Ativações pendentes', '0']]);
    assert.equal(new Set(cartoes.map((c) => c.querySelector('i').getAttribute('data-icone'))).size, 5, 'o significado continua nos ícones e nos títulos');
  });
});

// ───────────────────────── IMG-PRÉVIA-01 — fotografias na Consulta Real (ponte autenticada da Central) ─────────────────────────
// A Central usa a sessão empresarial e a rota existente GET /imagens-material/:origem/:id/:variante?v=; o iframe (origem opaca) só recebe bytes
// pela ponte. Estes testes trocam o fetch DA PÁGINA por um que intercepta só a rota de imagens (o resto segue para o servidor falso).

describe('IMG-PRÉVIA — fotografias na Consulta Real da Central', () => {
  const CANAL = 'safework-previa-totem';
  const ROTA = 'POST /atendimento-token/previa/identificar';
  const IMG = (origem, id, versao) => ({ disponivel: true, origem, id, versao });
  const MAT = (id, nome, imagem) => ({ id, nome, unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 1, nome: 'Botina' }, exigeTamanho: false, tamanhos: [], imagem });
  const CATALOGO_A = [
    MAT(41, 'Com foto padrão', IMG('PADRAO', '9007199254740993', 3)),
    MAT(42, 'Com foto empresa', IMG('EMPRESA', '7', 1)),
    MAT(43, 'Sem foto', { disponivel: false }),
    MAT(44, 'Foto inválida', { disponivel: true, origem: 'OUTRA', id: '5', versao: 1 }),
  ];
  const CATALOGO_B = [MAT(51, 'Só do outro funcionário', IMG('PADRAO', '99', 1))];
  const respostaDe = (materiais, nome = 'Dora') => ({
    status: 'ok',
    previa: { funcionario: { primeiroNome: nome }, ghe: { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true }, catalogo: { estado: 'OK', total: materiais.length, materiais } },
  });
  const identificarMsg = (extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: 'consulta-0001', tipoId: 'MATRICULA', valor: 'MX-4242', ...extra });
  const pedidoImg = (extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'IMAGEM', id: 'img-00000001', origem: 'PADRAO', imagemId: '9007199254740993', versaoImagem: 3, variante: 'miniatura', ...extra });
  const cancelarImg = (id) => ({ canal: CANAL, versao: 1, tipo: 'IMAGEM_CANCELAR', id });
  const filhaBruta = () => { const enviadas = []; return { enviadas, postMessage(m, alvo) { enviadas.push({ m, alvo }); } }; };
  const doQuadro = (pg, filha, data, extra = {}) => pg.eventoDaJanela('message', { data, source: filha, origin: 'null', ...extra });
  const resultados = (filha) => filha.enviadas.map((e) => e.m).filter((m) => m.tipo === 'IMAGEM_RESULTADO');
  const ultimo = (filha) => resultados(filha).at(-1);
  const CHAVES_BASE = ['canal', 'id', 'resultado', 'tipo', 'versao'];

  // fetch da página: intercepta só /imagens-material/. `E.modo(chamada)` decide a resposta (padrão: 200 WebP de 8 bytes).
  function instalarFetch(pg) {
    const original = pg.janela.fetch;
    const E = { chamadas: [], emVoo: 0, maxEmVoo: 0, segurados: [], modo: null };
    const resposta = (status, cabecalhos, corpoJson, tamanho = 8) => ({
      status, ok: status >= 200 && status < 300,
      headers: { get: (n) => { const k = Object.keys(cabecalhos).find((x) => x.toLowerCase() === String(n).toLowerCase()); return k === undefined ? null : String(cabecalhos[k]); } },
      blob: async () => ({ size: tamanho, type: 'image/webp', tag: `T${E.chamadas.length}` }),
      text: async () => (corpoJson === null ? '' : JSON.stringify(corpoJson)),
    });
    pg.janela.fetch = function (destino, opcoes) {
      const alvo = String(destino);
      if (!alvo.includes('/imagens-material/')) return original.call(pg.janela, destino, opcoes);
      const m = /\/imagens-material\/(empresa|padrao)\/([^/?#]+)\/(miniatura|exibicao)(?:\?(.*))?$/.exec(alvo);
      const c = { url: alvo, origem: m && m[1], id: m && m[2], variante: m && m[3], consulta: m && m[4], metodo: opcoes && opcoes.method, credentials: opcoes && opcoes.credentials,
        cabecalhos: { ...((opcoes && opcoes.headers) || {}) }, corpo: opcoes && opcoes.body, abortada: false };
      E.chamadas.push(c);
      E.emVoo += 1; E.maxEmVoo = Math.max(E.maxEmVoo, E.emVoo);
      const sinal = opcoes && opcoes.signal;
      return new Promise((resolver, rejeitar) => {
        let fim = false;
        const terminar = (fn) => { if (fim) return; fim = true; E.emVoo -= 1; fn(); };
        if (sinal && sinal.addEventListener) sinal.addEventListener('abort', () => { c.abortada = true; terminar(() => rejeitar(Object.assign(new Error('abortado'), { name: 'AbortError' }))); });
        const r = E.modo ? E.modo(c) : {};
        const entregar = () => {
          if (r.rede) return terminar(() => rejeitar(new Error('falha de rede simulada')));
          const status = r.status || 200;
          const cab = status === 200 ? { 'Content-Type': r.tipo || 'image/webp', ...(r.cabecalhos || {}) } : { ...(r.cabecalhos || {}) };
          return terminar(() => resolver(resposta(status, cab, status === 200 ? null : { status: 'error', codigo: r.codigo || 'ERRO', message: 'x' }, r.tamanho === undefined ? 8 : r.tamanho)));
        };
        if (r.segurar) E.segurados.push(() => { if (!fim) entregar(); });
        else Promise.resolve().then(entregar);
      });
    };
    E.liberarTodos = () => E.segurados.splice(0).forEach((f) => f());
    return E;
  }

  async function abrirImg({ materiais = CATALOGO_A, depois = null, perm = TUDO } = {}) {
    let n = 0;
    const r = await abrir({ perm, base: { forcar: { [ROTA]: () => { n += 1; return { status: 200, corpo: respostaDe(n === 1 ? materiais : (depois || CATALOGO_B), n === 1 ? 'Dora' : 'Eva') }; } } } });
    r.pg.janela.AbortController = globalThis.AbortController;
    const E = instalarFetch(r.pg);
    await aba(r.pg, 'visualizarTotem');
    await r.pg.marcar('modoPreviaReal');
    const filha = filhaBruta();
    quadroDaPrevia(r.pg)[0].contentWindow = filha;
    return { ...r, E, filha };
  }
  async function consultar(ctx, extra = {}) { await doQuadro(ctx.pg, ctx.filha, identificarMsg(extra)); await ctx.pg.esperar(); }
  async function pedir(ctx, extra = {}) { await doQuadro(ctx.pg, ctx.filha, pedidoImg(extra)); await ctx.pg.esperar(); }

  test('IMG-P1 — o catálogo entregue ao iframe preserva as referências válidas (id BIGINT como texto) e troca as inválidas por { disponivel: false }', async () => {
    const ctx = await abrirImg();
    await consultar(ctx);
    const msg = ctx.filha.enviadas[0].m;
    assert.equal(msg.resultado, 'OK');
    // A mensagem nasce no contexto da página: a cópia JSON traz os mesmos valores para este contexto (prototypes diferentes quebram o deepStrictEqual).
    assert.deepEqual(JSON.parse(JSON.stringify(msg.catalogo.materiais.map((m) => m.imagem))), [IMG('PADRAO', '9007199254740993', 3), IMG('EMPRESA', '7', 1), { disponivel: false }, { disponivel: false }]);
  });

  test('IMG-P2 — miniatura e exibição de uma imagem do catálogo: um GET pela rota existente, com a sessão, e o iframe recebe só o resultado e o blob', async () => {
    const ctx = await abrirImg();
    await consultar(ctx);
    await pedir(ctx);
    assert.equal(ctx.E.chamadas.length, 1);
    const c = ctx.E.chamadas[0];
    assert.ok(c.url.endsWith('/imagens-material/padrao/9007199254740993/miniatura?v=3'), c.url);
    assert.deepEqual([c.metodo, c.credentials, c.corpo], ['GET', 'include', undefined]);
    assert.deepEqual(Object.keys(c.cabecalhos), ['Accept']);
    assert.equal(c.cabecalhos.Accept, 'image/webp');
    const r = ultimo(ctx.filha);
    assert.deepEqual(Object.keys(r).sort(), ['blob', ...CHAVES_BASE]);
    assert.deepEqual([r.canal, r.versao, r.tipo, r.id, r.resultado, r.blob.size], [CANAL, 1, 'IMAGEM_RESULTADO', 'img-00000001', 'OK', 8]);
    assert.equal(ctx.filha.enviadas.at(-1).alvo, '*');
    await pedir(ctx, { id: 'img-00000002', origem: 'EMPRESA', imagemId: '7', versaoImagem: 1, variante: 'exibicao' });
    assert.ok(ctx.E.chamadas[1].url.endsWith('/imagens-material/empresa/7/exibicao?v=1'), ctx.E.chamadas[1].url);
    assert.equal(ultimo(ctx.filha).resultado, 'OK');
  });

  test('IMG-P3 — imagem que não está no catálogo da consulta atual é recusada SEM chamar a API: id, origem, versão e antes de qualquer consulta', async () => {
    const ctx = await abrirImg();
    await pedir(ctx, { id: 'img-00000009' });
    assert.equal(ctx.E.chamadas.length, 0, 'antes de identificar não há catálogo autorizado');
    assert.equal(ultimo(ctx.filha).resultado, 'NAO_ENCONTRADA');
    await consultar(ctx);
    const negados = [
      { imagemId: '999' }, { origem: 'EMPRESA' }, { imagemId: '7' }, { versaoImagem: 4 }, { versaoImagem: 2 },
      { origem: 'EMPRESA', imagemId: '7', versaoImagem: 2 }, { imagemId: '9007199254740992' }, { imagemId: '5', origem: 'EMPRESA', versaoImagem: 1 },
    ];
    for (const [i, extra] of negados.entries()) {
      await pedir(ctx, { id: `img-1000000${i}`, ...extra });
      const r = ultimo(ctx.filha);
      assert.equal(r.resultado, 'NAO_ENCONTRADA', JSON.stringify(extra));
      assert.deepEqual(Object.keys(r).sort(), CHAVES_BASE);
    }
    assert.equal(ctx.E.chamadas.length, 0, 'nenhuma chamada para imagem fora do catálogo');
  });

  test('IMG-P4 — mensagem malformada, de outra fonte ou origem, ou com variante inválida é IGNORADA: nenhuma chamada e nenhuma resposta', async () => {
    const ctx = await abrirImg();
    await consultar(ctx);
    const antes = ctx.filha.enviadas.length;
    const casos = [
      ['variante original', pedidoImg({ variante: 'original' })], ['variante maiúscula', pedidoImg({ variante: 'MINIATURA' })], ['chave extra', { ...pedidoImg(), url: 'https://x.invalido/a.png' }],
      ['chave ausente', (() => { const m = pedidoImg(); delete m.variante; return m; })()], ['id curto', pedidoImg({ id: 'x' })], ['id com barra', pedidoImg({ id: 'img/0000001' })],
      ['versaoImagem texto', pedidoImg({ versaoImagem: '3' })], ['imagemId número', pedidoImg({ imagemId: 9007199254740993 })], ['origem minúscula', pedidoImg({ origem: 'padrao' })],
      ['canal errado', pedidoImg({ canal: 'outro' })], ['versão do protocolo', pedidoImg({ versao: 2 })], ['tipo desconhecido', pedidoImg({ tipo: 'BUSCAR' })],
      ['não é objeto', 'texto'], ['array', []], ['nulo', null],
    ];
    for (const [nome, data] of casos) { await doQuadro(ctx.pg, ctx.filha, data); await ctx.pg.esperar(); assert.equal(ctx.E.chamadas.length, 0, nome); }
    await doQuadro(ctx.pg, filhaBruta(), pedidoImg());
    await doQuadro(ctx.pg, ctx.filha, pedidoImg(), { origin: 'https://outra.origem' });
    await doQuadro(ctx.pg, ctx.filha, pedidoImg(), { source: undefined });
    await ctx.pg.esperar();
    assert.equal(ctx.E.chamadas.length, 0);
    assert.equal(ctx.filha.enviadas.length, antes, 'nenhuma resposta a mensagem inválida');
  });

  test('IMG-P5 — pedido duplicado enquanto o primeiro está em andamento (mesmo id) é ignorado: uma só chamada', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ segurar: true });
    await consultar(ctx);
    await pedir(ctx); await pedir(ctx);
    assert.equal(ctx.E.chamadas.length, 1);
    ctx.E.liberarTodos(); await ctx.pg.esperar();
    assert.equal(resultados(ctx.filha).length, 1);
  });

  test('IMG-P6 — trocar de funcionário invalida a lista autorizada, aborta o que estava em voo e descarta a resposta atrasada; nada da consulta anterior vaza', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ segurar: true });
    await consultar(ctx);
    await pedir(ctx);
    assert.equal(ctx.E.emVoo, 1);
    await consultar(ctx, { id: 'consulta-0002' });
    assert.equal(ctx.E.chamadas[0].abortada, true, 'a chamada pendente da consulta anterior foi abortada');
    assert.equal(ctx.E.emVoo, 0);
    ctx.E.liberarTodos(); await ctx.pg.esperar();
    assert.equal(resultados(ctx.filha).length, 0, 'resposta atrasada nunca é entregue');
    ctx.E.modo = null;
    await pedir(ctx, { id: 'img-20000001' });
    assert.equal(ultimo(ctx.filha).resultado, 'NAO_ENCONTRADA', 'a imagem do funcionário anterior não está no novo catálogo');
    assert.equal(ctx.E.chamadas.length, 1);
    await pedir(ctx, { id: 'img-20000002', imagemId: '99', versaoImagem: 1 });
    assert.equal(ultimo(ctx.filha).resultado, 'OK', 'a imagem do catálogo novo é atendida');
  });

  test('IMG-P7 — durante a identificação do próximo funcionário a lista antiga já está invalidada (a nova só vale depois da resposta)', async () => {
    const ctx = await abrirImg();
    await consultar(ctx);
    ctx.s.forcar[ROTA] = () => new Promise(() => {});
    const novo = doQuadro(ctx.pg, ctx.filha, identificarMsg({ id: 'consulta-0002' }));
    void novo;
    await ctx.pg.esperar();
    await pedir(ctx);
    assert.equal(ctx.E.chamadas.length, 0);
    assert.equal(ultimo(ctx.filha).resultado, 'NAO_ENCONTRADA');
  });

  test('IMG-P8 — cancelar pelo iframe aborta a chamada e nada chega depois; cancelar id desconhecido não faz nada', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ segurar: true });
    await consultar(ctx);
    await pedir(ctx);
    await doQuadro(ctx.pg, ctx.filha, cancelarImg('img-99999999')); await ctx.pg.esperar();
    assert.equal(ctx.E.chamadas[0].abortada, false);
    await doQuadro(ctx.pg, ctx.filha, cancelarImg('img-00000001')); await ctx.pg.esperar();
    assert.equal(ctx.E.chamadas[0].abortada, true);
    ctx.E.liberarTodos(); await ctx.pg.esperar();
    assert.equal(resultados(ctx.filha).length, 0);
  });

  test('IMG-P9 — sair da aba, voltar à demonstração ou encerrar a sessão aborta as chamadas e descarta as respostas atrasadas', async () => {
    for (const acao of ['sair', 'demonstracao', 'reiniciar', 'encerrar']) {
      const ctx = await abrirImg();
      ctx.E.modo = () => ({ segurar: true });
      await consultar(ctx);
      await pedir(ctx);
      assert.equal(ctx.E.emVoo, 1, acao);
      if (acao === 'sair') await aba(ctx.pg, 'historico');
      if (acao === 'demonstracao') await ctx.pg.marcar('modoPreviaDemo');
      if (acao === 'reiniciar') await ctx.pg.clicar('botaoReiniciarPrevia');
      if (acao === 'encerrar') ctx.pg.janela.__tela.encerrar();
      assert.equal(ctx.E.chamadas[0].abortada, true, `${acao}: abortada`);
      ctx.E.liberarTodos(); await ctx.pg.esperar();
      assert.equal(resultados(ctx.filha).length, 0, `${acao}: nada entregue ao iframe descartado`);
      await pedir(ctx, { id: 'img-30000001' });
      assert.equal(ctx.E.chamadas.length, 1, `${acao}: mensagem de iframe descartado é ignorada`);
    }
  });

  test('IMG-P10 — sessão empresarial expirada (401): a Central usa o mecanismo existente e nada é liberado ao iframe', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ status: 401, codigo: 'SESSAO_INVALIDA' });
    await consultar(ctx);
    await pedir(ctx);
    assert.equal(ctx.pg.visivel('conteudoProtegido'), false);
    assert.equal(resultados(ctx.filha).length, 0);
  });

  test('IMG-P11 — sem permissão de leitura da Biblioteca (403): SEM_ACESSO, nunca um erro de tablet; as demais imagens da consulta nem chegam à API', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ status: 403, codigo: 'PERMISSAO_NEGADA' });
    await consultar(ctx);
    await pedir(ctx);
    assert.equal(ultimo(ctx.filha).resultado, 'SEM_ACESSO');
    assert.deepEqual(Object.keys(ultimo(ctx.filha)).sort(), CHAVES_BASE);
    await pedir(ctx, { id: 'img-00000002', origem: 'EMPRESA', imagemId: '7', versaoImagem: 1 });
    assert.equal(ultimo(ctx.filha).resultado, 'SEM_ACESSO');
    assert.equal(ctx.E.chamadas.length, 1, 'depois do primeiro 403 não se insiste na API');
    assert.equal(ctx.pg.visivel('conteudoProtegido'), true, 'a página não é derrubada');
    await consultar(ctx, { id: 'consulta-0002' });
    ctx.E.modo = null;
    await pedir(ctx, { id: 'img-00000003', imagemId: '99', versaoImagem: 1 });
    assert.equal(ultimo(ctx.filha).resultado, 'OK', 'uma nova consulta tenta de novo');
  });

  test('IMG-P12 — 404, 5xx, falha de rede, tipo diferente de WebP e tamanho inválido: mapeamento seguro e sem derrubar a página', async () => {
    const mapa = [
      [{ status: 404, codigo: 'IMAGEM_NAO_ENCONTRADA' }, 'NAO_ENCONTRADA'], [{ status: 500, codigo: 'ERRO_INTERNO' }, 'INDISPONIVEL'], [{ status: 503, codigo: 'IMAGENS_INDISPONIVEL' }, 'INDISPONIVEL'],
      [{ rede: true }, 'INDISPONIVEL'], [{ tipo: 'image/png' }, 'INDISPONIVEL'], [{ tipo: 'text/html' }, 'INDISPONIVEL'], [{ tamanho: 0 }, 'INDISPONIVEL'], [{ tamanho: 4 * 1024 * 1024 + 1 }, 'INDISPONIVEL'],
      [{ status: 400, codigo: 'VALIDACAO' }, 'INDISPONIVEL'],
    ];
    for (const [regra, esperado] of mapa) {
      const ctx = await abrirImg();
      ctx.E.modo = () => regra;
      await consultar(ctx);
      await pedir(ctx);
      const r = ultimo(ctx.filha);
      assert.equal(r.resultado, esperado, JSON.stringify(regra));
      assert.deepEqual(Object.keys(r).sort(), CHAVES_BASE, JSON.stringify(regra));
      assert.equal(ctx.pg.visivel('conteudoProtegido'), true);
    }
    const ok = await abrirImg();
    ok.E.modo = () => ({ tamanho: 4 * 1024 * 1024 });
    await consultar(ok); await pedir(ok);
    assert.equal(ultimo(ok.filha).resultado, 'OK', 'exatamente no limite ainda vale');
  });

  test('IMG-P13 — 429 respeita o Retry-After (padrão 30 s, máximo 120 s): LIMITE com a espera, nada novo sai durante a pausa e depois ela termina', async () => {
    for (const [cab, esperado] of [['7', 7], [undefined, 30], ['999', 120], ['abc', 30], ['0', 1]]) {
      const ctx = await abrirImg();
      ctx.E.modo = () => ({ status: 429, codigo: 'LIMITE_REQUISICOES_EXCEDIDO', cabecalhos: cab === undefined ? {} : { 'Retry-After': cab } });
      await consultar(ctx);
      await pedir(ctx);
      assert.deepEqual([ultimo(ctx.filha).resultado, ultimo(ctx.filha).espera], ['LIMITE', esperado], String(cab));
      assert.deepEqual(Object.keys(ultimo(ctx.filha)).sort(), [...CHAVES_BASE, 'espera'].sort());
      await pedir(ctx, { id: 'img-00000002', origem: 'EMPRESA', imagemId: '7', versaoImagem: 1 });
      assert.equal(ultimo(ctx.filha).resultado, 'LIMITE', 'durante a pausa nada sai');
      assert.equal(ctx.E.chamadas.length, 1);
      ctx.E.modo = null;
      await ctx.pg.avancar(esperado * 1000);
      await pedir(ctx, { id: 'img-00000003', origem: 'EMPRESA', imagemId: '7', versaoImagem: 1 });
      assert.equal(ultimo(ctx.filha).resultado, 'OK', 'depois do prazo volta a atender');
      assert.equal(ctx.pg.visivel('conteudoProtegido'), true);
    }
  });

  test('IMG-P14 — no máximo 4 chamadas simultâneas: as excedentes recebem LIMITE (espera 1 s) sem chegar à API', async () => {
    const materiais = Array.from({ length: 6 }, (_, i) => MAT(60 + i, `Item ${i}`, IMG('PADRAO', String(500 + i), 1)));
    const ctx = await abrirImg({ materiais });
    ctx.E.modo = () => ({ segurar: true });
    await consultar(ctx);
    for (let i = 0; i < 6; i += 1) await pedir(ctx, { id: `img-4000000${i}`, imagemId: String(500 + i), versaoImagem: 1 });
    assert.equal(ctx.E.chamadas.length, 4);
    assert.ok(ctx.E.maxEmVoo <= 4);
    const limites = resultados(ctx.filha).filter((r) => r.resultado === 'LIMITE');
    assert.equal(limites.length, 2);
    assert.ok(limites.every((r) => r.espera === 1));
    ctx.E.liberarTodos(); await ctx.pg.esperar();
    assert.equal(resultados(ctx.filha).filter((r) => r.resultado === 'OK').length, 4);
  });

  test('IMG-P15 — chamada sem resposta é abortada no tempo limite (15 s) e vira INDISPONIVEL', async () => {
    const ctx = await abrirImg();
    ctx.E.modo = () => ({ segurar: true });
    await consultar(ctx);
    await pedir(ctx);
    await ctx.pg.avancar(14000);
    assert.equal(ctx.E.chamadas[0].abortada, false);
    await ctx.pg.avancar(15000);
    assert.equal(ctx.E.chamadas[0].abortada, true);
    assert.equal(ultimo(ctx.filha).resultado, 'INDISPONIVEL');
  });

  test('IMG-P16 — a demonstração não tem ponte: pedido de imagem do iframe é ignorado, não há ouvinte nem chamada à Biblioteca', async () => {
    const r = await abrir();
    r.pg.janela.AbortController = globalThis.AbortController;
    const E = instalarFetch(r.pg);
    await aba(r.pg, 'visualizarTotem');
    const filha = filhaBruta();
    quadroDaPrevia(r.pg)[0].contentWindow = filha;
    assert.equal(r.pg.ouvintesDaJanela('message'), 0);
    await doQuadro(r.pg, filha, pedidoImg()); await r.pg.esperar();
    assert.equal(E.chamadas.length, 0);
    assert.equal(filha.enviadas.length, 0);
  });

  test('IMG-P17 — o isolamento do iframe e a ponte única continuam: sandbox só com scripts, sem allow-same-origin, um único ouvinte, nenhuma credencial na mensagem', async () => {
    const ctx = await abrirImg();
    const q = quadroDaPrevia(ctx.pg)[0];
    assert.equal(q.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(q.getAttribute('allow'), null);
    assert.equal(ctx.pg.ouvintesDaJanela('message'), 1);
    await consultar(ctx);
    // A página já grava sua preferência de tema e limpa a sessão antiga: o que importa é que o pedido de foto não acrescenta nada.
    const antes = JSON.stringify([ctx.pg.storage, ctx.pg.cookiesEscritos, ctx.pg.consoleChamadas, ctx.pg.historico, ctx.pg.navegacoes]);
    await pedir(ctx);
    await pedir(ctx, { id: 'img-00000002', variante: 'exibicao' });
    assert.equal(ctx.E.chamadas.length, 2);
    const texto = JSON.stringify(ctx.filha.enviadas.map((e) => ({ ...e.m, blob: undefined })));
    assert.doesNotMatch(texto, /cookie|authorization|token|gepi_sessao|set-cookie/i);
    assert.equal(JSON.stringify([ctx.pg.storage, ctx.pg.cookiesEscritos, ctx.pg.consoleChamadas, ctx.pg.historico, ctx.pg.navegacoes]), antes);
  });

  test('IMG-P18 — a identificação, o GHE, o cartão e o catálogo da Consulta Real continuam como antes', async () => {
    const ctx = await abrirImg();
    await consultar(ctx);
    const cartao = ctx.pg.el('cartaoConsultaReal').textContent.replace(/\s+/g, ' ');
    for (const esperado of ['Dora', 'GHE-102', 'Soldagem', 'Ativo', 'Com foto padrão', 'Sem foto']) assert.match(cartao, new RegExp(esperado));
    assert.equal(ctx.pg.el('crTotal').textContent.trim(), '4');
    assert.deepEqual(Object.keys(ctx.filha.enviadas[0].m).sort(), ['canal', 'catalogo', 'id', 'primeiroNome', 'resultado', 'tipo', 'versao']);
    assert.equal(ctx.filha.enviadas[0].m.primeiroNome, 'Dora');
  });
});
