'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');

/**
 * Parte F — módulo js/usuarios.js (EpiUsuarios), com fetch injetado: as
 * chamadas de Administração de usuários, Novo usuário (convites) e do
 * aceite público, os textos, o HTML escapado e as mensagens próprias. A
 * prova com PostgreSQL real está em
 * backend/test/integracao/usuarios-administracao.integration.js e
 * convites-usuario.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const modulo = () => require('../js/usuarios'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const ATAQUE = '<img src=x onerror=alert(1)>';
const ESCAPADO = '&lt;img src=x onerror=alert(1)&gt;';
const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);

let chamadas;
function servidor(responder = () => resposta(200, { status: 'ok' })) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) });
      return responder(opcoes.method, u);
    },
  });
}

const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
const nomesDeAtributo = (a) => [...a.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
const semElementoInjetado = (html) => {
  for (const m of marcacoes(html)) {
    assert.notEqual(m.nome, 'img', html);
    assert.notEqual(m.nome, 'script', html);
    assert.equal(nomesDeAtributo(m.atributos).some((n) => n.startsWith('on')), false, `atributo de evento em <${m.nome}>`);
  }
};
const celulas = (linhaHtml) => [...linhaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const linhas = (html) => html.split('</tr>').filter((l) => l.includes('<td'));

const usuario = (extra = {}) => ({
  id: 12, nome: 'Fulana de Tal', email: 'fulana@exemplo-cliente.com.br', perfil: 'USUARIO', ativo: true,
  criadoEm: '2026-09-27T13:05:00.000Z', grupo: { nome: 'Almoxarifado', ativo: true }, podeGerenciar: true, proprio: false, ...extra,
});
const convite = (extra = {}) => ({
  id: '31', emailConvite: 'nova@exemplo-cliente.com.br', nome: 'Nova Pessoa', perfil: 'SUPERVISOR', situacao: 'PENDENTE',
  criadoEm: '2026-09-27T13:05:00.000Z', expiraEm: '2026-09-30T13:05:00.000Z', criadoPor: { nome: 'Marta Master' }, podeCancelar: true, ...extra,
});

describe('consultas: só o contrato de cada rota, nunca empresa, identidade ou senha de quem administra', () => {
  test('listar leva busca aparada, situação, perfil e ordem da lista, e paginação; valor fora da lista não vai', async () => {
    servidor();
    const U = modulo();
    await U.acoes.listar({ busca: '  Ana & 50%  ', situacao: 'INATIVO', perfil: 'SUPERVISOR', ordem: 'nome_desc', pagina: 2 });
    await U.acoes.listar({ busca: '   ', situacao: 'xyz', perfil: 'ROOT', ordem: 'id; DROP TABLE usuarios', pagina: 0, empresaId: 2 });
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [
      ['GET', '/api/administracao/usuarios?busca=Ana%20%26%2050%25&situacao=INATIVO&perfil=SUPERVISOR&ordem=nome_desc&pagina=2&limite=20'],
      ['GET', '/api/administracao/usuarios?pagina=1&limite=20'],
    ]);
    assert.deepEqual(U.ORDENS.map((o) => o[0]), ['nome', 'nome_desc', 'perfil', 'situacao', 'recentes']);
    assert.deepEqual(U.SITUACOES.map((o) => o[0]), ['', 'ATIVO', 'INATIVO']);
  });

  test('alterar manda só nome e tipo de conta válidos; inativar e reativar sem corpo; id inválido nem sai do navegador', async () => {
    servidor();
    const U = modulo();
    await U.acoes.alterar(12, { nome: '  Ana  Souza ', tipoConta: 'SUPERVISOR', perfil: 'MASTER', email: 'x@y.com', ativo: false, empresaId: 2, identidadeId: 3, senha: 'segredo' });
    await U.acoes.alterar(12, { tipoConta: 'ROOT' });
    await U.acoes.inativar(12);
    await U.acoes.reativar(12);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [
      ['PATCH', '/api/administracao/usuarios/12', { nome: 'Ana  Souza', tipoConta: 'SUPERVISOR', email: 'x@y.com' }],
      ['PATCH', '/api/administracao/usuarios/12', {}],
      ['POST', '/api/administracao/usuarios/12/inativar', {}],
      ['POST', '/api/administracao/usuarios/12/reativar', {}],
    ]);
    for (const ruim of ['12', 0, -1, 1.5, '1 OR 1=1', null]) {
      assert.throws(() => U.acoes.inativar(ruim), TypeError, String(ruim));
      assert.throws(() => U.acoes.alterar(ruim, { nome: 'x' }), TypeError, String(ruim));
    }
    assert.equal(chamadas.length, 4);
  });

  test('convites: convidar leva só e-mail, nome e tipo de conta; listagem paginada; cancelar com id decimal', async () => {
    servidor();
    const U = modulo();
    await U.acoes.convidar({ email: '  Nova@Exemplo.com ', nome: ' Nova Pessoa ', tipoConta: 'USUARIO', perfil: 'MASTER', empresaId: 2, senha: 'x', ativo: true });
    await U.acoes.listarConvites({ pagina: 2 });
    await U.acoes.cancelarConvite('31');
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [
      ['POST', '/api/administracao/convites-usuario', { email: 'Nova@Exemplo.com', nome: 'Nova Pessoa', tipoConta: 'USUARIO' }],
      ['GET', '/api/administracao/convites-usuario?pagina=2&limite=20', undefined],
      ['POST', '/api/administracao/convites-usuario/31/cancelar', {}],
    ]);
    for (const ruim of [31, '0', '1 OR 1', '../31', '']) assert.throws(() => U.acoes.cancelarConvite(ruim), TypeError, String(ruim));
  });

  test('reenviar convite: POST com corpo vazio e id decimal; nada além do id vai ao servidor', async () => {
    servidor();
    const U = modulo();
    await U.acoes.reenviarConvite('31');
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [['POST', '/api/administracao/convites-usuario/31/reenviar', {}]]);
    for (const ruim of [31, '0', '1 OR 1', '../31', '', null, undefined]) assert.throws(() => U.acoes.reenviarConvite(ruim), TypeError, String(ruim));
  });

  test('aceite público: token e senha só no corpo, nunca na URL', async () => {
    servidor();
    const U = modulo();
    await U.acoes.consultarConvite(TOKEN);
    await U.acoes.aceitarConvite(TOKEN, 'Correnteza-Azul-Pedra-7319');
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [
      ['POST', '/api/convite-usuario/consultar', { token: TOKEN }],
      ['POST', '/api/convite-usuario/aceitar', { token: TOKEN, senha: 'Correnteza-Azul-Pedra-7319' }],
    ]);
    assert.equal(chamadas.some((c) => c.caminho.includes(TOKEN)), false);
  });
});

describe('textos e regras de tela', () => {
  test('perfis com os nomes da tela; iniciais; data em São Paulo; situação do convite', () => {
    const { texto: T, PERFIS } = modulo();
    assert.deepEqual(Object.keys(PERFIS), ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
    assert.deepEqual(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO', 'ROOT'].map(T.perfil), ['Master', 'Administrador', 'Supervisor', 'Usuário', '—']);
    assert.deepEqual([T.iniciais('Fulana de Tal'), T.iniciais('ana'), T.iniciais('  '), T.iniciais(null)], ['FT', 'A', '?', '?']);
    assert.deepEqual([T.data('2026-09-28T02:30:00.000Z'), T.data('ontem'), T.data(null)], ['27/09/2026', '—', '—']);
    assert.deepEqual([T.situacaoConvite('PENDENTE'), T.situacaoConvite('EXPIRADO'), T.situacaoConvite(ATAQUE)], ['Pendente', 'Expirado', '—']);
  });

  test('último MASTER ativo: só quando é MASTER, está ativo e não há outro', () => {
    const { regras: R } = modulo();
    assert.equal(R.ultimoMaster(usuario({ perfil: 'MASTER' }), 1), true);
    assert.equal(R.ultimoMaster(usuario({ perfil: 'MASTER' }), 2), false);
    assert.equal(R.ultimoMaster(usuario({ perfil: 'MASTER', ativo: false }), 1), false);
    assert.equal(R.ultimoMaster(usuario({ perfil: 'ADMINISTRADOR' }), 1), false);
  });
});

describe('HTML da administração de usuários', () => {
  test('cinco colunas do HTML original: usuário, e-mail, tipo de conta (com o grupo), status e ações', () => {
    const [linha] = linhas(modulo().render.linhasUsuarios([usuario()], { mastersAtivos: 2, podeAlterar: true }));
    assert.deepEqual(celulas(linha), ['FT Fulana de Tal Desde 27/09/2026', 'fulana@exemplo-cliente.com.br', 'Usuário Grupo Almoxarifado', 'Ativo', 'Editar Desativar']);
    assert.match(linha, /<span class="badge role-user">Usuário<\/span>/);
    assert.match(linha, /<span class="badge status-active">Ativo<\/span>/);
    assert.match(linha, /data-acao="editar" data-id="12"/);
    assert.match(linha, /data-acao="inativar" data-id="12"/);
  });

  test('inativo oferece Reativar; grupo inativo e sem grupo aparecem; MASTER é acesso pelo perfil; a própria conta tem selo', () => {
    const R = modulo().render;
    const [inativo] = linhas(R.linhasUsuarios([usuario({ ativo: false, grupo: { nome: 'Antigo', ativo: false } })], { mastersAtivos: 1, podeAlterar: true }));
    assert.match(inativo, /<span class="badge status-inactive">Inativo<\/span>/);
    assert.match(inativo, /data-acao="reativar"/);
    assert.equal(/data-acao="inativar"/.test(inativo), false);
    assert.match(celulas(inativo)[2], /Grupo Antigo \(inativo\)/);
    assert.match(celulas(linhas(R.linhasUsuarios([usuario({ grupo: null })], {}))[0])[2], /Sem grupo/);
    assert.match(celulas(linhas(R.linhasUsuarios([usuario({ perfil: 'MASTER', grupo: null })], { mastersAtivos: 2 }))[0])[2], /Acesso pelo perfil/);
    assert.match(celulas(linhas(R.linhasUsuarios([usuario({ proprio: true })], {}))[0])[0], /Você/);
  });

  test('proteção visual do último MASTER: Desativar desabilitado com o motivo; Editar continua (o nome muda)', () => {
    const [linha] = linhas(modulo().render.linhasUsuarios([usuario({ perfil: 'MASTER' })], { mastersAtivos: 1, podeAlterar: true }));
    assert.match(linha, /<button class="mini-btn" type="button" data-acao="inativar" data-id="12" disabled title="[^"]*único MASTER ativo[^"]*">Desativar<\/button>/);
    assert.match(linha, /data-acao="editar" data-id="12"/);
  });

  test('sem poder gerenciar aquele perfil (D3) ou sem poder alterar: nenhuma ação, só o motivo', () => {
    const R = modulo().render;
    const [masterParaAdmin] = linhas(R.linhasUsuarios([usuario({ perfil: 'MASTER', podeGerenciar: false })], { mastersAtivos: 2, podeAlterar: true }));
    assert.equal(/<button/.test(masterParaAdmin), false);
    assert.match(celulas(masterParaAdmin)[4], /Somente o MASTER/);
    const [soLeitura] = linhas(R.linhasUsuarios([usuario()], { mastersAtivos: 2, podeAlterar: false }));
    assert.equal(/<button/.test(soLeitura), false);
  });

  test('XSS: nome, e-mail, grupo, perfil e datas vindos do servidor são texto; id que não é número não vira botão', () => {
    const html = modulo().render.linhasUsuarios([usuario({
      id: `1" onmouseover="alert(1)`, nome: ATAQUE, email: ATAQUE, perfil: ATAQUE, criadoEm: ATAQUE, grupo: { nome: ATAQUE, ativo: true },
    })], { mastersAtivos: 2, podeAlterar: true });
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
    assert.equal(/<button/.test(html), false);
    semElementoInjetado(modulo().render.vazio(ATAQUE, 5));
  });

  test('opções de perfil só com os perfis que o servidor liberou, na ordem do HTML original', () => {
    const R = modulo().render;
    assert.equal(R.opcoesPerfil(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO'], 'SUPERVISOR'),
      '<option value="USUARIO">Usuário</option><option value="SUPERVISOR" selected>Supervisor</option><option value="ADMINISTRADOR">Administrador</option><option value="MASTER">Master</option>');
    assert.equal(R.opcoesPerfil(['SUPERVISOR', 'USUARIO', 'ROOT', ATAQUE]), '<option value="USUARIO">Usuário</option><option value="SUPERVISOR">Supervisor</option>');
    assert.equal(R.opcoesPerfil(null), '');
  });

  test('paginação e lista vazia', () => {
    const R = modulo().render;
    assert.deepEqual(R.paginacao({ total: 0, pagina: 1, limite: 20, paginas: 0 }, 0), { texto: 'Nenhum usuário', anterior: false, proxima: false });
    assert.deepEqual(R.paginacao({ total: 45, pagina: 2, limite: 20, paginas: 3 }, 20), { texto: 'Usuários 21–40 de 45 · página 2 de 3', anterior: true, proxima: true });
    assert.match(R.tabelaUsuarios([], {}, 'Nenhum usuário encontrado.'), /<td colspan="5" class="estado">Nenhum usuário encontrado\.<\/td>/);
    assert.deepEqual(R.paginacao({ total: 0, pagina: 1, limite: 20, paginas: 0 }, 0, 'convites'), { texto: 'Nenhum convite', anterior: false, proxima: false });
    assert.deepEqual(R.paginacao({ total: 3, pagina: 1, limite: 20, paginas: 1 }, 3, 'convites'), { texto: 'Convites 1–3 de 3 · página 1 de 1', anterior: false, proxima: false });
    assert.match(R.tabelaConvites([], {}), /<td colspan="7" class="estado">Nenhum convite em aberto\.<\/td>/);
  });
});

describe('HTML dos convites em aberto', () => {
  test('colunas: e-mail, nome, tipo de conta, situação, validade, quem convidou e ações', () => {
    const [linha] = linhas(modulo().render.linhasConvites([convite()], { podeAlterar: true }));
    assert.deepEqual(celulas(linha), ['nova@exemplo-cliente.com.br', 'Nova Pessoa', 'Supervisor', 'Pendente', '30/09/2026', 'Marta Master', 'Reenviar Cancelar']);
    assert.match(linha, /data-acao="cancelar-convite" data-id="31"/);
    assert.match(linha, /data-acao="reenviar-convite" data-id="31"/);
  });

  test('Reenviar só aparece para convite pendente ou expirado, com autoridade e id no formato', () => {
    const R = modulo().render;
    const reenvia = (extra, opcoes = { podeAlterar: true }) => /data-acao="reenviar-convite"/.test(R.linhasConvites([convite(extra)], opcoes));
    assert.equal(reenvia({ situacao: 'PENDENTE' }), true);
    assert.equal(reenvia({ situacao: 'EXPIRADO' }), true);
    for (const situacao of ['ACEITO', 'CANCELADO', 'OUTRA', undefined]) assert.equal(reenvia({ situacao }), false, String(situacao));
    assert.equal(reenvia({ podeCancelar: false }), false, 'sem autoridade sobre o perfil');
    assert.equal(reenvia({}, { podeAlterar: false }), false, 'sem poder alterar');
    assert.equal(reenvia({ id: '31" onclick="x' }), false, 'id fora do formato');
  });

  test('convite expirado ganha o botão Reenviar e continua sem Cancelar duplicado', () => {
    const [linha] = linhas(modulo().render.linhasConvites([convite({ situacao: 'EXPIRADO' })], { podeAlterar: true }));
    assert.match(celulas(linha).at(-1), /Reenviar/);
    assert.equal((linha.match(/data-acao="reenviar-convite"/g) || []).length, 1);
  });

  test('sem poder cancelar aquele perfil, ou sem alterar: sem botão; expirado aparece como expirado', () => {
    const R = modulo().render;
    assert.equal(/<button/.test(R.linhasConvites([convite({ podeCancelar: false })], { podeAlterar: true })), false);
    assert.equal(/<button/.test(R.linhasConvites([convite()], { podeAlterar: false })), false);
    assert.match(R.linhasConvites([convite({ situacao: 'EXPIRADO' })], { podeAlterar: true }), /Expirado/);
  });

  test('XSS nos convites e id fora do formato', () => {
    const html = modulo().render.linhasConvites([convite({
      id: '31" onclick="x', emailConvite: ATAQUE, nome: ATAQUE, perfil: ATAQUE, situacao: ATAQUE, expiraEm: ATAQUE, criadoPor: { nome: ATAQUE },
    })], { podeAlterar: true });
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
    assert.equal(/<button/.test(html), false);
  });
});

describe('mensagens próprias, sem repetir o servidor', () => {
  const segredo = (status, codigo) => ({ ok: false, status, codigo, mensagem: 'SEGREDO-INTERNO', detalhes: [{ campo: 'body.x', codigo: 'SEGREDO-9', mensagem: 'SEGREDO-10' }] });

  test('ações de administração: cada código de negócio tem texto próprio', () => {
    const M = modulo().mensagens;
    const casos = {
      USUARIO_ULTIMO_MASTER: /pelo menos um MASTER/,
      USUARIO_PERFIL_NAO_PERMITIDO: /Somente o MASTER/,
      USUARIO_JA_INATIVO: /já está inativo/,
      USUARIO_JA_ATIVO: /já está ativo/,
      USUARIO_NAO_ENCONTRADO: /não encontrado/,
      USUARIO_ADMINISTRACAO_NAO_AUTORIZADA: /autoridade/,
    };
    for (const [codigo, esperado] of Object.entries(casos)) {
      const texto = M.erroAcao(segredo(codigo === 'USUARIO_NAO_ENCONTRADO' ? 404 : 409, codigo));
      assert.match(texto, esperado, codigo);
      assert.equal(/SEGREDO/.test(texto), false, codigo);
    }
    for (const r of [segredo(400, 'VALIDACAO'), segredo(500, 'ERRO_INTERNO'), { ok: false, status: 0 }, segredo(401, 'SESSAO_INVALIDA')]) {
      assert.equal(/SEGREDO/.test(M.erroAcao(r)), false);
      assert.equal(/SEGREDO/.test(M.erroListagem(r)), false);
    }
  });

  test('convite: vínculo já existente, convite em aberto e envio indisponível', () => {
    const M = modulo().mensagens;
    assert.match(M.erroConvite(segredo(409, 'USUARIO_VINCULO_EXISTENTE')), /já tem um usuário nesta empresa/);
    assert.match(M.erroConvite(segredo(409, 'CONVITE_JA_PENDENTE')), /convite em aberto/);
    assert.match(M.erroConvite(segredo(503, 'CONVITE_ENTREGA_INDISPONIVEL')), /e-mail/);
    assert.match(M.erroConvite(segredo(403, 'USUARIO_PERFIL_NAO_PERMITIDO')), /Somente o MASTER/);
    for (const codigo of ['USUARIO_VINCULO_EXISTENTE', 'CONVITE_JA_PENDENTE', 'VALIDACAO', 'ERRO_INTERNO']) {
      assert.equal(/SEGREDO/.test(M.erroConvite(segredo(400, codigo))), false, codigo);
    }
  });

  test('convite: reenvio fora do estado, envio muito recente, limite diário e limite de requisições têm texto próprio', () => {
    const M = modulo().mensagens;
    const casos = [
      [409, 'CONVITE_NAO_REENVIAVEL', /já foi aceito ou cancelado/],
      [429, 'CONVITE_ENVIO_MUITO_RECENTE', /há poucos instantes/],
      [429, 'CONVITE_ENVIO_LIMITE_DIARIO', /Limite de convites/],
      [429, 'LIMITE_REQUISICOES_EXCEDIDO', /Muitas solicitações/],
    ];
    for (const [status, codigo, esperado] of casos) {
      const texto = M.erroConvite(segredo(status, codigo));
      assert.match(texto, esperado, codigo);
      assert.equal(/SEGREDO/.test(texto), false, codigo);
    }
    assert.match(M.erroConvite(segredo(429, 'QUALQUER')), /Muitas solicitações/);
  });

  test('erroReenvio: mesmos textos de negócio e padrão próprio, sem repetir o servidor', () => {
    const M = modulo().mensagens;
    assert.match(M.erroReenvio(segredo(409, 'CONVITE_NAO_REENVIAVEL')), /já foi aceito ou cancelado/);
    assert.match(M.erroReenvio(segredo(403, 'USUARIO_PERFIL_NAO_PERMITIDO')), /Somente o MASTER/);
    assert.match(M.erroReenvio(segredo(404, 'CONVITE_NAO_ENCONTRADO')), /não encontrado/);
    assert.match(M.erroReenvio(segredo(500, 'ERRO_INTERNO')), /reenviar o convite/);
    assert.match(M.erroReenvio({ ok: false, status: 0 }), /Falha de rede/);
    assert.match(M.erroReenvio(segredo(401, 'SESSAO_INVALIDA')), /sessão terminou/);
    for (const r of [segredo(409, 'CONVITE_NAO_REENVIAVEL'), segredo(500, 'ERRO_INTERNO'), segredo(400, 'VALIDACAO')]) assert.equal(/SEGREDO/.test(M.erroReenvio(r)), false);
  });

  test('envioConvite: com link (desenvolvimento), enviado, falha e sem envio; o link só aparece quando veio na resposta', () => {
    const M = modulo().mensagens;
    const comLink = M.envioConvite({ modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', linkAceite: 'http://localhost:5500/portal/aceitar-convite.html#token=x' });
    assert.equal(comLink.mostrarLink, true);
    assert.match(comLink.texto, /copie o link/);
    const enviado = M.envioConvite({ modo: 'EMAIL', estado: 'ENVIADO' });
    assert.equal(enviado.mostrarLink, false);
    assert.match(enviado.texto, /enviado por e-mail/);
    const falha = M.envioConvite({ modo: 'EMAIL', estado: 'FALHA' });
    assert.equal(falha.mostrarLink, false);
    assert.match(falha.texto, /não pôde ser enviado/);
    assert.match(falha.texto, /Reenviar/);
    for (const vazio of [undefined, null, {}, { estado: 'NAO_ENVIADO' }, { linkAceite: '' }, { linkAceite: 42 }]) {
      const m = M.envioConvite(vazio);
      assert.equal(m.mostrarLink, false, JSON.stringify(vazio));
      assert.match(m.texto, /não envia e-mail/);
    }
  });

  test('aceite: situações do link, senha e cooldown; política de senha pelo código, sem a frase do servidor', () => {
    const M = modulo().mensagens;
    assert.match(M.erroAceite(segredo(404, 'CONVITE_INVALIDO')), /inválido/);
    assert.match(M.erroAceite(segredo(409, 'CONVITE_EXPIRADO')), /expirou/);
    assert.match(M.erroAceite(segredo(409, 'CONVITE_CANCELADO')), /cancelado/);
    assert.match(M.erroAceite(segredo(409, 'CONVITE_JA_UTILIZADO')), /já foi usado/);
    assert.match(M.erroAceite(segredo(409, 'CONVITE_EMPRESA_INATIVA')), /empresa/);
    assert.match(M.erroAceite(segredo(401, 'CREDENCIAIS_INVALIDAS')), /Senha incorreta/);
    assert.match(M.erroAceite(segredo(429, 'CONVITE_EM_COOLDOWN')), /tentativas/);
    const politica = { ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'SEGREDO', detalhes: [{ campo: 'body.senha', codigo: 'SENHA_TRIVIAL', mensagem: 'SEGREDO' }] };
    assert.match(M.erroAceite(politica), /comum ou previsível/);
    assert.match(M.erroAceite({ ...politica, detalhes: [{ campo: 'body.senha', codigo: 'SENHA_CURTA' }] }), /12 caracteres/);
    assert.match(M.erroAceite({ ...politica, detalhes: [{ campo: 'body.senha', codigo: 'SENHA_CONTEM_EMAIL' }] }), /e-mail/);
    for (const r of [politica, segredo(500, 'X'), { ok: false, status: 0 }]) assert.equal(/SEGREDO/.test(M.erroAceite(r)), false);
  });
});
