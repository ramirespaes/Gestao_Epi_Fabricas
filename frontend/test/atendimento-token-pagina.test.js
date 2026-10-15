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

async function abrir({ perm = TUDO, base = {}, perfil } = {}) {
  const s = servidor({ permissoes: perm, perfil, ...base });
  const pg = abrirPagina(PAGINA, {
    rotas: s.rotas,
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
const visiveisAbas = (pg) => ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico'].filter((a) => pg.visivel(`aba-${a}`));
const painelAberto = (pg) => ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico'].filter((a) => pg.visivel(`painel-${a}`));
const aviso = (pg, id) => pg.el(id).textContent;

describe('abertura protegida e permissões', () => {
  test('com tudo permitido: as seis abas, a Visão Geral aberta e o menu com "Atendimento Token" como página atual', async () => {
    const { pg } = await abrir();
    assert.deepEqual(visiveisAbas(pg), ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico']);
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
    assert.deepEqual(visiveisAbas(pg), ['monitoramento', 'previa', 'historico']);
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

  test('prévia: mostra os materiais do catálogo (nome, tipo, unidade, tamanhos) e o aviso; é só GET', async () => {
    const { pg } = await abrir();
    await aba(pg, 'previa');
    await buscar(pg, 'ana');
    await botoes(pg, '#previaFuncionarios [data-funcionario-id="31"][data-acao="previa"]')[0].disparar('click');
    await pg.esperar();
    assert.match(pg.texto('previaTitulo'), /Prévia do catálogo — Ana Silva/);
    const materiais = pg.consulta('#previaResultado li');
    assert.equal(materiais.length, 2);
    assert.match(materiais[0].textContent, /Luva Nitrílica[\s\S]*Luva · EPI · Unidade: par[\s\S]*Tamanhos: P, M, G/);
    assert.match(materiais[1].textContent, /Capacete[\s\S]*Sem escolha de tamanho/);
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
    for (const a of ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico']) {
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
