'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  abrirAmbiente, sha256, varrer, lerSetCookie, cookieDoTabletNaResposta, COOKIE_TABLET, CAMINHO_TABLET, ORIGEM, IP_TESTE, criarLimitador,
} = require('./helpers/token-tablet');
const { tokenSessaoTemFormatoValido, hashTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa C (RED), consumo do código de ativação pelo tablet. PostgreSQL real em schema temporário.
 *
 * Contrato proposto:
 *   POST /api/atendimento-token/tablet/ativar     sem sessão; corpo estrito { codigo }; passa pela verificação de Origin e pelo limitador
 *   200 { status:'ok', dispositivo: { nome, unidade, setor, localInstalacao } } + Set-Cookie da credencial persistente do tablet
 *   401 ATIVACAO_INVALIDA   (inexistente, malformado, usado, cancelado, expirado, tablet revogado e empresa inativa: a MESMA resposta)
 *   403 REDE_NAO_AUTORIZADA (código válido, mas a origem de rede não é autorizada para a empresa do tablet; o código NÃO é consumido)
 *   400 VALIDACAO           (corpo fora do contrato: campo extra, ausente ou de tipo errado)
 *   429 LIMITE_REQUISICOES_EXCEDIDO
 * A empresa vem SÓ da linha da ativação; a origem de rede é o req.ip resolvido pelo servidor (TRUST_PROXY_HOPS), nunca um
 * cabeçalho lido pela aplicação. IP_FIXO só vale como endereço exato (/32 ou /128). TUNEL só vale com atestação confiável da
 * fronteira de rede, que a topologia atual não oferece: sem ela, fica NEGADO (decisão proposta, ver relatório).
 */

const ATIVAR = `${CAMINHO_TABLET}/ativar`;
const GENERICO = { status: 401, codigo: 'ATIVACAO_INVALIDA' };
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('Atendimento Token — C: ativação do tablet (PostgreSQL real)', () => {
  let a;
  let app;

  before(async () => {
    a = await abrirAmbiente();
    app = a.criarApp({ hops: 0 });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  /** Tablet pendente + código pendente; a rede de teste (127.0.0.1/32) já está autorizada para a empresa A. */
  async function preparar(empresaId = a.d.empresaA) {
    const x = await a.dispositivo(empresaId);
    const codigo = await a.codigoPendente(x);
    return { x, codigo };
  }
  const mesmoEstado = async (x) => { const l = await a.linha(x.id); return JSON.stringify(l); };

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED) ─────────────
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — fixtures: tablet, código real e rede gravam e respeitam as constraints da 086', async () => {
      const { x, codigo } = await preparar();
      assert.equal(tokenSessaoTemFormatoValido(codigo), true);
      assert.equal((await a.ativacoesDe(x.id))[0].codigo_hash, hashTokenSessao(codigo));
      const redes = (await a.q('SELECT tipo, host(rede) AS ip, masklen(rede) AS m FROM token_redes_autorizadas WHERE empresa_id = $1 AND desativada_em IS NULL', [a.d.empresaA])).rows;
      assert.deepEqual(redes, [{ tipo: 'IP_FIXO', ip: IP_TESTE, m: 32 }]);
    });

    test('K2 — o ambiente reproduz a resolução de IP do Express: sem proxy confiável cabeçalhos de encaminhamento são ignorados; com 1 salto vale só a última entrada do X-Forwarded-For', async () => {
      const sem = a.criarApp({ hops: 0 });
      const um = a.criarApp({ hops: 1 });
      const ipSem = (await request(sem).get('/_sonda-ip').set('X-Forwarded-For', '203.0.113.9')).body.ip;
      assert.equal(ipSem, IP_TESTE, 'hops=0: o X-Forwarded-For forjado não conta');
      for (const cab of ['X-Real-IP', 'Forwarded', 'CF-Connecting-IP', 'True-Client-IP', 'X-Client-IP']) {
        assert.equal((await request(sem).get('/_sonda-ip').set(cab, '203.0.113.9')).body.ip, IP_TESTE, cab);
      }
      assert.equal((await request(um).get('/_sonda-ip').set('X-Forwarded-For', '198.51.100.7, 203.0.113.9')).body.ip, '203.0.113.9', 'hops=1: vale a última entrada (a do proxy)');
      assert.equal((await request(um).get('/_sonda-ip').set('X-Forwarded-For', '203.0.113.9, 198.51.100.7')).body.ip, '198.51.100.7', 'hops=1: a entrada forjada à esquerda não conta');
    });

    test('K3 — a pertinência de endereço a uma rede é decidida pelo PostgreSQL (CIDR/INET), que é a base do contrato de rede', async () => {
      const { rows } = await a.q("SELECT ('203.0.113.9'::inet <<= '203.0.113.0/24'::cidr) AS dentro, ('198.51.100.7'::inet <<= '203.0.113.0/24'::cidr) AS fora, ('127.0.0.1'::inet <<= '127.0.0.1/32'::cidr) AS exato");
      assert.deepEqual(rows[0], { dentro: true, fora: false, exato: true });
    });
  });

  // ───────────────────────── B. ativação válida, credencial e cookie ─────────────────────────
  describe('ativação válida', () => {
    test('B1 — código válido: 200, tablet vira ATIVO, código consumido, credencial emitida e guardada SÓ como hash; corpo sem credencial', async () => {
      const { x, codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['dispositivo', 'status']);
      assert.deepEqual(r.body.dispositivo, { nome: x.nome, unidade: 'Fábrica 1', setor: 'Expedição', localInstalacao: 'Portaria' });
      const cookie = cookieDoTabletNaResposta(r);
      assert.ok(cookie, 'a credencial do tablet vai em cookie');
      assert.equal(tokenSessaoTemFormatoValido(cookie.valor), true, 'credencial de 256 bits em formato canônico');
      const depois = await a.linha(x.id);
      assert.ok(depois.ativado_em instanceof Date && depois.credencial_emitida_em instanceof Date);
      assert.equal(depois.credencial_hash, hashTokenSessao(cookie.valor), 'só o SHA-256 da credencial é guardado');
      assert.equal(depois.credencial_anterior_hash, null);
      assert.equal(depois.revogado_em, null);
      const ativacao = (await a.ativacoesDe(x.id))[0];
      assert.ok(ativacao.usado_em instanceof Date && ativacao.cancelado_em === null, 'uso único consumido');
      const texto = JSON.stringify(r.body) + JSON.stringify(r.headers['x-credencial'] ?? '');
      assert.equal(texto.includes(cookie.valor) || texto.includes(codigo), false, 'nem a credencial nem o código voltam no corpo');
    });

    test('B2 — o cookie é HttpOnly, de nome próprio, restrito ao caminho do tablet, persistente e com Secure/SameSite da política de sessão; sem Domain', async () => {
      const { codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      const cookie = cookieDoTabletNaResposta(r);
      assert.ok(cookie, 'Set-Cookie do tablet ausente');
      assert.equal(cookie.nome, COOKIE_TABLET);
      assert.equal(cookie.atributos.httponly, true);
      assert.equal(cookie.atributos.path, CAMINHO_TABLET, 'o navegador só envia o cookie às rotas do tablet (nunca às administrativas)');
      assert.equal(cookie.atributos.domain, undefined);
      assert.equal(String(cookie.atributos.samesite).toLowerCase(), authConfig.sessao.cookieSameSite);
      assert.equal(cookie.atributos.secure === true, authConfig.sessao.cookieSecure, 'Secure segue a política de sessão (obrigatório em produção)');
      assert.ok(Number(cookie.atributos['max-age']) >= 30 * 24 * 3600, 'persistente: sobrevive à reinicialização do tablet (Max-Age de pelo menos 30 dias)');
      assert.equal(cookie.atributos.expires, undefined, 'Max-Age, não Expires (não depende do relógio do cliente)');
      const outros = [authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNomeGlobal];
      assert.equal(outros.includes(cookie.nome), false, 'nunca o nome de um cookie de sessão administrativa');
      assert.deepEqual(lerSetCookie(r).filter((c) => outros.includes(c.nome)), [], 'nenhum cookie de sessão administrativa é emitido');
    });

    test('B3 — cada ativação emite uma credencial diferente (aleatoriedade) e a credencial NÃO é o código de ativação', async () => {
      const cookies = new Set();
      for (let i = 0; i < 3; i += 1) {
        const { codigo } = await preparar();
        const r = await a.ativar(app, codigo);
        assert.equal(r.status, 200, aviso(r));
        const c = cookieDoTabletNaResposta(r);
        assert.ok(c);
        assert.notEqual(c.valor, codigo);
        cookies.add(c.valor);
      }
      assert.equal(cookies.size, 3);
    });

    test('B4 — auditoria TOKEN_DISPOSITIVO_ATIVADO (empresa e tablet, sem usuário) e evento ATIVACAO, sem código, credencial nem hash', async () => {
      const { x, codigo } = await preparar();
      const antes = (await a.auditorias('TOKEN_DISPOSITIVO_ATIVADO')).length;
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      const credencial = cookieDoTabletNaResposta(r).valor;
      const registros = (await a.auditorias('TOKEN_DISPOSITIVO_ATIVADO')).slice(antes);
      assert.equal(registros.length, 1);
      assert.deepEqual([registros[0].empresa_id, registros[0].referencia, registros[0].usuario_id], [a.d.empresaA, String(x.id), null]);
      assert.equal((await a.eventos(x.id, 'ATIVACAO')).length, 1);
      const segredos = [codigo, credencial, sha256(codigo), hashTokenSessao(credencial)];
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), segredos), [], 'segredo em logs_auditoria');
      assert.deepEqual(varrer(await a.todosEventos(a.d.empresaA), segredos), [], 'segredo em token_dispositivo_eventos');
    });

    test('B5 — a credencial em claro e o código em claro não existem em NENHUMA tabela do Token nem na auditoria; os hashes só aparecem onde têm de estar', async () => {
      const { x, codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      const credencial = cookieDoTabletNaResposta(r).valor;
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos', 'token_ativacoes', 'token_dispositivos', 'token_atendimentos', 'token_redes_autorizadas']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, [codigo, credencial], { hex64: false }), [], `${tabela} guarda segredo em claro`);
      }
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, [sha256(codigo), hashTokenSessao(credencial)], { hex64: false }), [], `${tabela} guarda hash de segredo`);
      }
      assert.equal((await a.linha(x.id)).credencial_hash, hashTokenSessao(credencial));
    });
  });

  // ───────────────────────── C. uso único, expiração, cancelamento, revogação ─────────────────────────
  describe('código inválido, usado, expirado, cancelado e tablet revogado', () => {
    test('C1 — o mesmo código não ativa duas vezes: a segunda é 401 genérica, sem cookie, e a credencial da primeira segue sendo a única', async () => {
      const { x, codigo } = await preparar();
      const primeira = await a.ativar(app, codigo);
      assert.equal(primeira.status, 200, aviso(primeira));
      const depois = await mesmoEstado(x);
      const segunda = await a.ativar(app, codigo);
      assert.deepEqual([segunda.status, segunda.body.codigo], [GENERICO.status, GENERICO.codigo], aviso(segunda));
      assert.equal(cookieDoTabletNaResposta(segunda), null);
      assert.equal(await mesmoEstado(x), depois, 'o tablet não muda na segunda tentativa');
    });

    test('C2 — todas as causas de código inválido respondem EXATAMENTE igual (inexistente, malformado, usado, cancelado, expirado, tablet revogado): sem enumeração', async () => {
      const respostas = [];
      respostas.push(['inexistente', await a.ativar(app, require('../../src/security/token').gerarTokenSessao())]);
      respostas.push(['malformado', await a.ativar(app, 'abc')]);
      const usado = await preparar(); await a.q('UPDATE token_ativacoes SET usado_em = now() WHERE dispositivo_id = $1', [usado.x.id]);
      respostas.push(['usado', await a.ativar(app, usado.codigo)]);
      const cancelado = await preparar(); await a.q('UPDATE token_ativacoes SET cancelado_em = now() WHERE dispositivo_id = $1', [cancelado.x.id]);
      respostas.push(['cancelado', await a.ativar(app, cancelado.codigo)]);
      const x = await a.dispositivo(a.d.empresaA);
      const expirado = await a.codigoPendente(x, { criadoHaMinutos: 30, validadeMinutos: 10 });
      respostas.push(['expirado', await a.ativar(app, expirado)]);
      const revogado = await preparar(); await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2 WHERE id = $1', [revogado.x.id, a.d.master]);
      respostas.push(['tablet revogado', await a.ativar(app, revogado.codigo)]);
      for (const [rotulo, r] of respostas) {
        assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], `${rotulo} → ${aviso(r)}`);
        assert.equal(cookieDoTabletNaResposta(r), null, `${rotulo}: nenhum cookie`);
      }
      assert.equal(new Set(respostas.map(([, r]) => JSON.stringify(r.body))).size, 1, 'corpos idênticos: o cliente não distingue a causa');
      assert.equal((await a.linha(revogado.x.id)).credencial_hash, null, 'tablet revogado não ganha credencial');
      assert.equal((await a.linha(x.id)).ativado_em, null, 'tablet com código expirado segue PENDENTE');
    });

    test('C3 — código que expira entre a emissão e o uso é recusado pelo relógio do BANCO (não do cliente) e o tablet segue pendente', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x, { criadoHaMinutos: 11, validadeMinutos: 10 });
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
      assert.equal((await a.ativacoesDe(x.id))[0].usado_em, null, 'a expirada não vira "usada"');
    });

    test('C4 — empresa INATIVA: 401 genérica, nada é emitido', async () => {
      const { x, codigo } = await preparar(a.d.empresaB);
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      await a.q('UPDATE empresas SET ativo = false WHERE id = $1', [a.d.empresaB]);
      try {
        const r = await a.ativar(app, codigo);
        assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], aviso(r));
        assert.equal((await a.linha(x.id)).credencial_hash, null);
      } finally {
        await a.q('UPDATE empresas SET ativo = true WHERE id = $1', [a.d.empresaB]);
      }
    });

    test('C5 — o código vale só para o SEU tablet e a sua empresa: ativar com o código da B pela rede da A não emite nada na A', async () => {
      const daA = await a.dispositivo(a.d.empresaA);
      const { x: daB, codigo } = await preparar(a.d.empresaB);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [] });
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 403, `a empresa B não tem rede autorizada, então nem com a rede da A ativa: ${aviso(r)}`);
      assert.equal((await a.linha(daA.id)).ativado_em, null);
      assert.equal((await a.linha(daB.id)).ativado_em, null);
    });
  });

  // ───────────────────────── D. concorrência ─────────────────────────
  describe('consumo simultâneo do mesmo código', () => {
    test('D1 — 8 requisições simultâneas com o MESMO código: exatamente UMA ativa (200 com cookie); as outras são 401 genéricas; uma única credencial, um evento, uma auditoria', async () => {
      const { x, codigo } = await preparar();
      const antesAud = (await a.auditorias('TOKEN_DISPOSITIVO_ATIVADO')).length;
      const respostas = await Promise.all(Array.from({ length: 8 }, () => a.ativar(app, codigo)));
      const ok = respostas.filter((r) => r.status === 200);
      const recusadas = respostas.filter((r) => r.status !== 200);
      assert.equal(ok.length, 1, respostas.map(aviso).join(' | '));
      assert.equal(recusadas.length, 7);
      for (const r of recusadas) assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], aviso(r));
      assert.equal(respostas.filter((r) => cookieDoTabletNaResposta(r) !== null).length, 1, 'só uma credencial foi emitida');
      const credencial = cookieDoTabletNaResposta(ok[0]).valor;
      assert.equal((await a.linha(x.id)).credencial_hash, hashTokenSessao(credencial), 'a credencial gravada é a do vencedor');
      assert.equal((await a.eventos(x.id, 'ATIVACAO')).length, 1);
      assert.equal((await a.auditorias('TOKEN_DISPOSITIVO_ATIVADO')).length - antesAud, 1);
      assert.equal((await a.ativacoesDe(x.id)).filter((l) => l.usado_em !== null).length, 1);
    });

    test('D2 — ativações simultâneas de tablets DIFERENTES não interferem entre si: cada código ativa o seu tablet com a sua credencial', async () => {
      const lote = await Promise.all(Array.from({ length: 4 }, () => preparar()));
      const respostas = await Promise.all(lote.map(({ codigo }) => a.ativar(app, codigo)));
      assert.deepEqual(respostas.map((r) => r.status), [200, 200, 200, 200], respostas.map(aviso).join(' | '));
      const hashes = new Set();
      for (let i = 0; i < lote.length; i += 1) {
        const credencial = cookieDoTabletNaResposta(respostas[i]).valor;
        assert.equal((await a.linha(lote[i].x.id)).credencial_hash, hashTokenSessao(credencial));
        hashes.add(credencial);
      }
      assert.equal(hashes.size, 4);
    });
  });

  // ───────────────────────── E. corpo, origem da requisição e limite de tentativas ─────────────────────────
  describe('corpo estrito, Origin e limite de tentativas', () => {
    test('E1 — corpo estrito: empresa, tablet, credencial e qualquer campo extra são 400; corpo sem código ou com tipo errado também; o código NÃO é consumido', async () => {
      const { x, codigo } = await preparar();
      for (const corpo of [{ codigo, empresaId: a.d.empresaB }, { codigo, dispositivoId: x.id }, { codigo, credencial: 'x' }, {}, { codigo: 123 }, { codigo: null }, { codigo: 'a'.repeat(5000) }]) {
        const r = await request(app).post(ATIVAR).set('Origin', ORIGEM).send(corpo);
        assert.equal(r.status, 400, `${JSON.stringify(Object.keys(corpo))} → ${aviso(r)}`);
        assert.equal(r.body.codigo, 'VALIDACAO');
        assert.equal(JSON.stringify(r.body).includes(codigo), false, 'a validação não devolve o valor recebido');
      }
      assert.equal((await a.ativacoesDe(x.id))[0].usado_em, null);
      assert.equal((await a.ativar(app, codigo)).status, 200, 'o código segue válido depois das recusas de formato');
    });

    test('E2 — sem Origin/Referer permitido a mutação é recusada ANTES de tocar no código (ORIGEM_AUSENTE / ORIGEM_NAO_PERMITIDA); o código não é consumido', async () => {
      const { x, codigo } = await preparar();
      const semOrigem = await request(app).post(ATIVAR).send({ codigo });
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE'], aviso(semOrigem));
      const alheia = await request(app).post(ATIVAR).set('Origin', 'https://atacante.example').send({ codigo });
      assert.deepEqual([alheia.status, alheia.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], aviso(alheia));
      assert.equal((await a.ativacoesDe(x.id))[0].usado_em, null);
      assert.equal((await a.ativar(app, codigo)).status, 200, 'com a origem permitida o mesmo código ativa');
    });

    test('E3 — limite de tentativas por origem de rede: depois de 3 tentativas a 4ª é 429 mesmo com código válido, e o código válido NÃO é consumido', async () => {
      const limitado = a.criarApp({ hops: 0, limitador: criarLimitador({ limite: 3, janelaSegundos: 60 }) });
      const { x, codigo } = await preparar();
      for (let i = 0; i < 3; i += 1) {
        const r = await a.ativar(limitado, require('../../src/security/token').gerarTokenSessao());
        assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], `tentativa ${i + 1}: ${aviso(r)}`);
      }
      const barrada = await a.ativar(limitado, codigo);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
      assert.equal((await a.ativacoesDe(x.id))[0].usado_em, null);
    });

    test('E4 — a tentativa inválida não vaza estrutura nem segredo: corpo sem stack, SQL, constraint ou o valor recebido', async () => {
      const r = await a.ativar(app, 'codigo-invalido-com-texto-reconhecivel-9f8e7d');
      assert.deepEqual([r.status, r.body.codigo], [GENERICO.status, GENERICO.codigo], aviso(r));
      assert.equal(/stack|sql|constraint|token_ativacoes|codigo-invalido/i.test(JSON.stringify(r.body)), false);
    });
  });

  // ───────────────────────── F. rede corporativa obrigatória na ativação ─────────────────────────
  describe('rede corporativa obrigatória (também na ativação)', () => {
    test('F1 — empresa SEM rede autorizada: 403 REDE_NAO_AUTORIZADA mesmo com código válido; o código não é consumido e funciona depois que uma rede é autorizada', async () => {
      await a.redes({ A: [], B: [] });
      const { x, codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal((await a.linha(x.id)).credencial_hash, null);
      assert.equal((await a.ativacoesDe(x.id))[0].usado_em, null, 'recusa por rede não queima o código');
      await a.redes(a.redeDeTeste);
      assert.equal((await a.ativar(app, codigo)).status, 200);
    });

    test('F2 — rede de OUTRA empresa não autoriza: o IP está cadastrado só para a B e o tablet é da A', async () => {
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      const { x, codigo } = await preparar(a.d.empresaA);
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('F3 — rede DESATIVADA não vale: só as ativas contam', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [] });
      await a.q('UPDATE token_redes_autorizadas SET desativada_em = now(), desativada_por = $2 WHERE empresa_id = $1', [a.d.empresaA, a.d.master]);
      const { codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
    });

    test('F4 — a origem é a que o SERVIDOR resolveu: sem proxy confiável, X-Forwarded-For, Forwarded, X-Real-IP, CF-Connecting-IP, True-Client-IP e X-Client-IP forjados não autorizam', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] });
      const semProxy = a.criarApp({ hops: 0 });
      for (const [cab, valor] of [['X-Forwarded-For', '203.0.113.9'], ['Forwarded', 'for=203.0.113.9'], ['X-Real-IP', '203.0.113.9'], ['CF-Connecting-IP', '203.0.113.9'], ['True-Client-IP', '203.0.113.9'], ['X-Client-IP', '203.0.113.9']]) {
        const { x, codigo } = await preparar();
        const r = await a.ativar(semProxy, codigo, { [cab]: valor });
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `${cab} → ${aviso(r)}`);
        assert.equal((await a.linha(x.id)).credencial_hash, null, cab);
      }
    });

    test('F5 — atrás de UM proxy confiável vale só a entrada que o proxy acrescentou (a última): entrada autorizada forjada à esquerda não passa; a do proxy passa', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] });
      const umSalto = a.criarApp({ hops: 1 });
      const forjado = await preparar();
      const r1 = await a.ativar(umSalto, forjado.codigo, { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' });
      assert.deepEqual([r1.status, r1.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r1));
      const legitimo = await preparar();
      const r2 = await a.ativar(umSalto, legitimo.codigo, { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' });
      assert.equal(r2.status, 200, aviso(r2));
    });

    test('F6 — IP_FIXO é endereço EXATO: um IP_FIXO cadastrado com faixa larga (127.0.0.0/8) NÃO autoriza (decisão proposta: faixa só como TUNEL; IP dinâmico/CGNAT não vira "rede da empresa")', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '127.0.0.0/8' }], B: [] });
      const { x, codigo } = await preparar();
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('F7 — TUNEL sem atestação confiável fica NEGADO: um endereço da sub-rede do túnel visto no X-Forwarded-For (ou um endereço privado) não prova a passagem pelo WireGuard (decisão proposta, depende da topologia)', async () => {
      await a.redes({ A: [{ tipo: 'TUNEL', rede: '10.8.0.0/24' }], B: [] });
      const umSalto = a.criarApp({ hops: 1 });
      const { x, codigo } = await preparar();
      const r = await a.ativar(umSalto, codigo, { 'X-Forwarded-For': '10.8.0.5' });
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('F8 — a recusa por rede vira evento REDE_RECUSADA, mas controlado: 5 tentativas seguidas geram UM evento (supressão), sem auditoria por tentativa e sem segredo', async () => {
      await a.redes({ A: [], B: [] });
      const { x, codigo } = await preparar();
      for (let i = 0; i < 5; i += 1) assert.equal((await a.ativar(app, codigo)).status, 403);
      const eventos = await a.eventos(x.id, 'REDE_RECUSADA');
      assert.equal(eventos.length, 1, `volume controlável pelo atacante precisa de supressão: ${eventos.length} eventos`);
      assert.deepEqual(varrer(await a.todosEventos(a.d.empresaA), [codigo, sha256(codigo)]), []);
    });

    test('F9 — a empresa do tablet vem do CÓDIGO no servidor: um cabeçalho ou campo apontando a outra empresa não muda a rede avaliada (x-empresa-id e empresa na query são ignorados ou 400, nunca obedecidos)', async () => {
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      const { x, codigo } = await preparar(a.d.empresaA);
      const r = await request(app).post(`${ATIVAR}?empresaId=${a.d.empresaB}`).set('Origin', ORIGEM).set('x-empresa-id', String(a.d.empresaB)).send({ codigo });
      assert.ok([400, 403].includes(r.status) && r.status !== 200, aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
      assert.equal(r.status === 400 ? r.body.codigo === 'VALIDACAO' : r.body.codigo === 'REDE_NAO_AUTORIZADA', true, aviso(r));
    });
  });
});
