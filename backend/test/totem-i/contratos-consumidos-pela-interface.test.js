'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { gerarTokenSessao, tokenSessaoTemFormatoValido } = require('../../src/security/token');
const tablet = require('../../src/schemas/token-tablet.schema');
const pedido = require('../../src/schemas/token-pedido.schema');
const { authConfig } = require('../../src/config/auth');
const { errorHandler } = require('../../src/middleware/errorHandler');

/**
 * Etapa I (RED) — CONTROLES: contratos já homologados nas Etapas C–G de que a futura interface do Totem depende.
 * Todos devem PASSAR hoje (classe PASS "contrato existente já atendido"): servem de base factual aos testes RED da
 * interface (frontend/test/totem-i-*.test.js) e provam que o vermelho deles não vem de um contrato mal entendido.
 * Nada aqui toca banco, serviço, rede ou configuração real; só módulos puros e o texto-fonte (como nas Etapas anteriores).
 */

const SRC = path.join(__dirname, '..', '..', 'src');
const fonte = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const listar = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listar(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const item = (extra = {}) => ({ materialId: 11, tamanho: '40', quantidade: 1, motivo: 'DESGASTE_DANO', ...extra });
const corpo = (itens, chave = crypto.randomUUID()) => ({ chaveIdempotencia: chave, itens });
const aceita = (c) => pedido.finalizar.body.safeParse(c).success;

describe('[BE] Q1 — o código de ativação é compatível com um fragmento de URL e com o endpoint da Etapa C', () => {
  test('[BE-01] 200 códigos gerados: 43 caracteres base64url canônicos, seguros em fragmento sem codificação', () => {
    for (let i = 0; i < 200; i += 1) {
      const codigo = gerarTokenSessao();
      assert.equal(tokenSessaoTemFormatoValido(codigo), true);
      assert.match(codigo, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(encodeURIComponent(codigo), codigo, 'não precisa de escape em URL');
      const m = /^#ativar=([A-Za-z0-9_-]{43})$/.exec(`#ativar=${codigo}`);
      assert.equal(m !== null && m[1] === codigo, true);
    }
  });

  test('[BE-02] POST /tablet/ativar aceita só { codigo } (1 a 128), sem campo extra', () => {
    const ok = tablet.ativar.body;
    assert.equal(ok.safeParse({ codigo: gerarTokenSessao() }).success, true);
    assert.equal(ok.safeParse({ codigo: '' }).success, false);
    assert.equal(ok.safeParse({ codigo: 'x'.repeat(129) }).success, false);
    assert.equal(ok.safeParse({ codigo: gerarTokenSessao(), empresaId: 1 }).success, false);
    assert.equal(ok.safeParse({}).success, false);
    assert.equal(tablet.estado.query.safeParse({ credencial: 'x' }).success, false, 'a credencial nunca vem em query');
  });

  test('[BE-03] o código só vale se canônico: texto malformado dentro do limite é recusado sem revelar a causa', () => {
    assert.equal(tokenSessaoTemFormatoValido('curto'), false);
    assert.equal(tokenSessaoTemFormatoValido(`${gerarTokenSessao()}x`), false);
    assert.equal(tokenSessaoTemFormatoValido(gerarTokenSessao().replace(/.$/, '!')), false);
  });
});

describe('[BE] Q5 e Q8 — o pedido real da Etapa F (multi-item, motivo por item, quantidade, idempotência)', () => {
  test('[BE-10] quantidade 1 por item é aceita; o backend não impõe teto de negócio (quantidade fixa é regra do cliente)', () => {
    assert.equal(aceita(corpo([item({ quantidade: 1 })])), true);
    assert.equal(aceita(corpo([item({ quantidade: 5 })])), true, 'o contrato aceita mais; a UI do Totem é que fixa 1');
    assert.equal(aceita(corpo([item({ quantidade: 0 })])), false);
    assert.equal(aceita(corpo([item({ quantidade: 1.5 })])), false);
  });

  test('[BE-11] vários itens: de 1 a 20; o 21º é recusado', () => {
    const itens = (n) => Array.from({ length: n }, (_, i) => item({ materialId: 100 + i }));
    assert.equal(aceita(corpo(itens(1))), true);
    assert.equal(aceita(corpo(itens(20))), true);
    assert.equal(aceita(corpo(itens(21))), false);
    assert.equal(aceita(corpo([])), false);
  });

  test('[BE-12] motivo é POR ITEM e só SUBSTITUICAO_PRAZO, DESGASTE_DANO, PERDA_EXTRAVIO', () => {
    assert.deepEqual([...pedido.MOTIVOS_DO_TOTEM], ['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO']);
    for (const m of pedido.MOTIVOS_DO_TOTEM) assert.equal(aceita(corpo([item({ motivo: m })])), true);
    for (const m of ['ADMISSAO', 'OUTRO', 'substituicao_prazo', '', null]) assert.equal(aceita(corpo([item({ motivo: m })])), false, String(m));
    assert.equal(aceita({ chaveIdempotencia: crypto.randomUUID(), motivo: 'DESGASTE_DANO', itens: [item()] }), false, 'não existe motivo do pedido inteiro');
    const semMotivo = item(); delete semMotivo.motivo;
    assert.equal(aceita(corpo([semMotivo])), false);
  });

  test('[BE-13] tamanho: null ou ausente é aceito pelo formato (o serviço decide); campo extra, texto livre e autoridade são recusados', () => {
    assert.equal(aceita(corpo([item({ tamanho: null })])), true);
    const semTamanho = item(); delete semTamanho.tamanho;
    assert.equal(aceita(corpo([semTamanho])), true);
    assert.equal(aceita(corpo([item({ tamanho: 'x'.repeat(21) })])), false);
    for (const extra of [{ observacao: 'x' }, { justificativa: 'x' }, { empresaId: 1 }, { funcionarioId: 1 }, { status: 'APROVADA' }, { reserva: true }]) {
      assert.equal(aceita(corpo([item(extra)])), false, JSON.stringify(extra));
      assert.equal(aceita({ ...corpo([item()]), ...extra }), false, JSON.stringify(extra));
    }
  });

  test('[BE-14] a chave de idempotência é um UUID no CORPO e também no CAMINHO de GET /pedidos/:chave (risco de exposição em logs de proxy)', () => {
    assert.equal(aceita({ chaveIdempotencia: 'nao-e-uuid', itens: [item()] }), false);
    assert.equal(aceita({ itens: [item()] }), false);
    assert.equal(pedido.resultado.params.safeParse({ chave: crypto.randomUUID() }).success, true);
    assert.equal(pedido.resultado.params.safeParse({ chave: 'nao-e-uuid' }).success, false);
    assert.match(fonte('routes/token-pedido.routes.js'), /\/pedidos\/:chave/, 'a chave viaja no caminho da URL');
  });
});

describe('[BE] Q7 — a sessão do atendimento (Etapa D) e os limites de frequência', () => {
  test('[BE-20] 60 s de inatividade fixos, no servidor, sem configuração por ambiente', () => {
    assert.equal(authConfig.atendimento.inatividadeSegundos, 60);
    assert.equal(authConfig.atendimento.cookieNome, 'gepi_atendimento');
    assert.match(fonte('config/auth.js'), /sem teto absoluto/);
  });

  test('[BE-21] só POST /atividade renova: atendimentoRepo.renovar tem um único chamador', () => {
    const chamadores = listar(SRC).filter((f) => f.endsWith('.js') && /\.renovar\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    assert.deepEqual(chamadores, ['services/token-atendimento.service.js']);
    assert.match(fonte('routes/token-atendimento.routes.js'), /post\(`\$\{RAIZ\}\/atividade`/);
  });

  test('[BE-22] 120 por 60 s por tablet (compartilhado por GET /atendimento, /atividade e /encerrar) e 10 por 60 s na identificação são limites de FREQUÊNCIA', () => {
    assert.match(fonte('routes/token-tablet.routes.js'), /LIMITE_POR_DISPOSITIVO = Object\.freeze\(\{ limite: 120, janelaSegundos: 60 \}\)/);
    assert.match(fonte('routes/token-atendimento.routes.js'), /LIMITE_IDENTIFICACAO_POR_DISPOSITIVO = Object\.freeze\(\{ limite: 10, janelaSegundos: 60 \}\)/);
    const rotas = fonte('routes/token-atendimento.routes.js');
    assert.equal((rotas.match(/porTablet,/g) ?? []).length >= 3, true, 'GET, atividade e encerrar usam o mesmo limitador porTablet');
    assert.match(fonte('middleware/rate-limit.js'), /windowMs: janelaSegundos \* 1000/, 'janela fixa em memória, não regra de sessão');
  });
});

describe('[BE] Q8 — o que o servidor registra em log não carrega a URL (nem a chave de idempotência do caminho)', () => {
  test('[BE-30] o log de erro interno registra o PADRÃO da rota, nunca a URL concreta com a chave', () => {
    const chave = crypto.randomUUID();
    const req = {
      method: 'GET',
      originalUrl: `/api/atendimento-token/tablet/atendimento/pedidos/${chave}`,
      url: `/atendimento-token/tablet/atendimento/pedidos/${chave}`,
      path: `/atendimento-token/tablet/atendimento/pedidos/${chave}`,
      route: { path: '/atendimento-token/tablet/atendimento/pedidos/:chave' },
      headers: { cookie: `gepi_atendimento=${gerarTokenSessao()}` },
    };
    const res = { headersSent: false, status() { return this; }, json() { return this; }, set() { return this; } };
    const chamadas = [];
    const original = console.error;
    console.error = (...args) => { chamadas.push(args); };
    try { errorHandler(new Error('falha interna simulada'), req, res, () => {}); } finally { console.error = original; }
    const saida = JSON.stringify(chamadas);
    assert.equal(chamadas.length, 1);
    assert.ok(saida.includes('pedidos/:chave'), saida);
    assert.ok(!saida.includes(chave), 'a chave não pode aparecer no log do servidor');
    assert.ok(!saida.includes('gepi_atendimento'), 'nem o cookie');
  });

  test('[BE-31] a aplicação não tem logger de acesso (morgan) e só o errorHandler escreve log em middleware', () => {
    assert.equal(/morgan/.test(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')), false);
    const comLog = listar(path.join(SRC, 'middleware')).filter((f) => /console\.(log|info|warn|error|debug)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    assert.deepEqual(comLog, ['errorHandler.js']);
  });
});

describe('[BE] Imagens — o contrato atual do catálogo', () => {
  // Adequação autorizada pela V7 (Unidade 4, 16/10/2026): a Biblioteca de Imagens criou rotas ADMINISTRATIVAS de imagem (sessão + RBAC `materials`),
  // então a proibição de "nenhuma rota de imagem ou upload" passou a valer onde ela protege de verdade — o namespace do TABLET (Atendimento Token) —
  // e, fora dele, só duas rotas administrativas podem falar de imagem. Não é inócuo: um arquivo `token-*.routes.js` com imagem/upload, ou qualquer
  // OUTRO arquivo de rota com imagem/upload/multer, reprova o teste; o controle positivo prova que a expressão enxerga a rota de imagem.
  test('[BE-40] o catálogo do tablet mantém o estado explícito SEM_IMAGEM e o namespace do TABLET (Atendimento Token) não tem rota de imagem nem upload; fora dele só as rotas administrativas autorizadas falam de imagem', () => {
    assert.match(fonte('services/token-catalogo.service.js'), /SEM_IMAGEM = Object\.freeze\(\{ disponivel: false \}\)/);
    const arquivos = listar(path.join(SRC, 'routes')).filter((f) => f.endsWith('.routes.js'));
    const menciona = (f) => /imagem|upload|multer/i.test(fs.readFileSync(f, 'utf8'));
    const nome = (f) => path.basename(f);
    const doTablet = arquivos.filter((f) => /token-[a-z-]+\.routes\.js$/.test(f));
    assert.ok(doTablet.length >= 9, `leu as rotas do Atendimento Token (${doTablet.length})`);
    assert.deepEqual(doTablet.filter(menciona).map(nome), [], 'nenhuma rota de imagem ou upload sob o Atendimento Token');
    const AUTORIZADAS = ['imagem-material.routes.js', 'material.routes.js'];
    const mencionam = arquivos.filter(menciona).map(nome);
    assert.deepEqual(mencionam.filter((n) => !AUTORIZADAS.includes(n)), [], 'só as rotas administrativas autorizadas (biblioteca e materiais) falam de imagem, upload ou multer');
    assert.ok(mencionam.includes('imagem-material.routes.js'), 'controle positivo: a expressão enxerga a rota administrativa de imagem');
  });
});
