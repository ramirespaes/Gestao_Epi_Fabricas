'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { inserirLote, somarDias } = require('./helpers/estoque-lotes');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');
const { criarItensDisponiveisRoutes } = require('../../src/routes/itens-disponiveis.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Entrada e baixa por lote com PostgreSQL real, de ponta a ponta, e o efeito
 * imediato nas leituras de lotes, Itens Disponíveis e dashboard. O relógio fica
 * em 23h30 de 30/09 em São Paulo (02h30 de 01/10 em UTC); a outra instância
 * da API fica em 00h30 de 01/10.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 45 }, (_, i) => String(i).padStart(3, '0'));
const HOJE = '2026-09-30';
const ONTEM = somarDias(HOJE, -1);
const AMANHA = somarDias(HOJE, 1);
const NOITE_DE_30_09 = () => new Date('2026-10-01T02:30:00Z');
const MADRUGADA_DE_01_10 = () => new Date('2026-10-01T03:30:00Z');
const SENHA = 'senha-forte-da-escrita-por-lote-2026';
const EMAILS = {
  masterA: 'master.a.operacoes@exemplo-cliente.com.br',
  usuarioA: 'usuario.a.operacoes@exemplo-cliente.com.br', // vê materiais, mas não movimenta estoque
  masterB: 'master.b.operacoes@exemplo-cliente.com.br',
};
const MOTIVOS = ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR', 'OUTRO'];
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

const novaChave = () => crypto.randomUUID();
const corpoEntrada = (extra = {}) => ({
  tamanho: '40', quantidade: 10, caNumero: '12345', caValidade: '2027-06-30', chaveIdempotencia: novaChave(), ...extra,
});
const corpoBaixa = (extra = {}) => ({ quantidade: 4, motivo: 'AVARIA', chaveIdempotencia: novaChave(), ...extra });
const semCampo = (corpo, campo) => {
  const copia = { ...corpo };
  delete copia[campo];
  return copia;
};

describe('entrada e baixa por lote (PostgreSQL real, data operacional controlada)', () => {
  let contexto;
  let pool;
  let app;
  let appMadrugada;
  const empresa = {};
  const u = {};
  const cookie = {};
  let sequencia = 0;

  const postEntrada = (quem, materialId, corpo, alvo = app) =>
    request(alvo).post(`/api/materiais/${materialId}/estoque/entradas`).set('Cookie', cookie[quem] || '').send(corpo);
  const postBaixa = (quem, loteId, corpo, alvo = app) =>
    request(alvo).post(`/api/estoque/lotes/${loteId}/baixas`).set('Cookie', cookie[quem] || '').send(corpo);
  const get = (quem, rota) => request(app).get(rota).set('Cookie', cookie[quem]);

  // Cada teste usa materiais próprios; o tipo é único para filtrar Itens Disponíveis.
  async function novoMaterial(empresaId, {
    minimo = 0, ativo = true, exigeCa = true, exigeTamanho = true,
  } = {}) {
    sequencia += 1;
    const nome = `Material ${sequencia}`;
    const { rows } = await pool.query(
      'INSERT INTO materiais (empresa_id, nome, tipo, estoque_minimo, ativo, exige_ca, exige_tamanho, prazo_uso_dias) VALUES ($1, $2, $2, $3, $4, $5, $6, 180) RETURNING id',
      [empresaId, nome, minimo, ativo, exigeCa, exigeTamanho],
    );
    return { id: rows[0].id, tipo: nome };
  }

  async function entradaCriada(quem, materialId, extra = {}) {
    const r = await postEntrada(quem, materialId, corpoEntrada(extra));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  }

  async function retrato(empresaId) {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM estoque_lotes WHERE empresa_id = $1)::int AS lotes,
              (SELECT count(*) FROM estoque_operacoes WHERE empresa_id = $1)::int AS operacoes,
              (SELECT COALESCE(sum(quantidade_baixada), 0) FROM estoque_lotes WHERE empresa_id = $1)::int AS baixado,
              (SELECT count(*) FROM logs_auditoria WHERE empresa_id = $1 AND acao IN ('ESTOQUE_ENTRADA', 'ESTOQUE_BAIXA'))::int AS auditorias,
              (SELECT count(*) FROM estoque_tamanhos)::int AS legado`,
      [empresaId],
    );
    return rows[0];
  }

  const loteNoBanco = async (loteId) => (await pool.query(
    `SELECT empresa_id, material_id, tamanho, ca_numero, ca_validade::text, origem,
            quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo, criado_em
       FROM estoque_lotes WHERE id = $1`,
    [loteId],
  )).rows[0];

  const operacoesDoLote = async (loteId) => (await pool.query(
    `SELECT id, empresa_id, tipo, quantidade, motivo, justificativa, usuario_id, chave_idempotencia, requisicao_hash, criado_em
       FROM estoque_operacoes WHERE lote_id = $1 ORDER BY id`,
    [loteId],
  )).rows;

  const auditoriasDoLote = async (loteId, acao) => (await pool.query(
    `SELECT empresa_id, usuario_id, referencia, dispositivo, contexto, dados_anteriores, dados_novos, criado_em
       FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id`,
    [acao, String(loteId)],
  )).rows;

  async function lotesDe(quem, materialId) {
    const r = await get(quem, `/api/materiais/${materialId}/estoque/lotes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }

  async function itemDe(quem, material, tamanho) {
    const r = await get(quem, `/api/estoque/itens-disponiveis?tipo=${encodeURIComponent(material.tipo)}&limite=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const item = r.body.itens.find((i) => i.tamanho === tamanho);
    return item ? [item.saldo, item.bloqueado, item.disponivel] : null;
  }

  async function indicadores(quem) {
    const r = await get(quem, '/api/dashboard/indicadores');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const i = r.body.indicadores;
    return { disponivel: i.itensDisponiveis.valor, abaixo: i.estoqueAbaixoMinimo.valor, vencido: i.caVencido.valor, aVencer: i.caVencido.aVencer };
  }

  const diferenca = (antes, depois) => Object.fromEntries(Object.keys(antes).map((k) => [k, depois[k] - antes[k]]));

  // Só conto quem espera no advisory lock da chave ou numa linha travada com
  // FOR UPDATE; a atualização da sessão também pode esperar por um instante.
  async function esperarNaTrava(quantas) {
    for (let i = 0; i < 500; i += 1) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
            AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%FOR UPDATE')`,
      );
      if (rows[0].n >= quantas) return;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error('as requisições não chegaram a disputar a trava');
  }

  // Seguro a linha numa transação minha, disparo as requisições e só solto
  // quando todas estão esperando no banco: a disputa acontece de verdade.
  async function disputar(sqlTrava, parametros, disparos) {
    const trava = await pool.connect();
    let respostas;
    try {
      await trava.query('BEGIN');
      await trava.query(sqlTrava, parametros);
      respostas = Promise.all(disparos.map((disparo) => disparo()));
      respostas.catch(() => {});
      await esperarNaTrava(disparos.length);
    } finally {
      await trava.query('ROLLBACK');
      trava.release();
    }
    return respostas;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const q = (sql, params) => pool.query(sql, params);
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Operações', '11222333000181'], ['B', 'Empresa Beta Operações', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, chave, perfil, id],
      )).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('usuarioA', empresa.A, EMAILS.usuarioA, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await q(
      "INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'materials', true, $3)",
      [empresa.A, u.usuarioA, u.masterA],
    );

    const montar = (relogio) => {
      const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
      const exigirSessao = criarExigirSessao({ pool });
      return criarAppTeste((a) => {
        a.use(
          '/api',
          criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
          criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao, pool }),
          criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio }), exigirSessao, pool }),
          criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio }), exigirSessao, pool }),
        );
      });
    };
    app = montar(NOITE_DE_30_09);
    appMadrugada = montar(MADRUGADA_DE_01_10);
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('entrada', () => {
    test('entrada válida: 201 com a operação e o lote; o banco guarda lote ENTRADA com CA e validade, e a operação com responsável, chave e hash', async () => {
      const m = await novoMaterial(empresa.A);
      const antes = await retrato(empresa.A);
      const corpo = corpoEntrada({ tamanho: ' 40 ', caNumero: ' CA 12345 ' });
      const r = await postEntrada('masterA', m.id, corpo);
      assert.equal(r.status, 201, JSON.stringify(r.body));

      const { operacao, lote } = r.body;
      assert.deepEqual([r.body.status, r.body.repetida], ['ok', false]);
      assert.deepEqual(lote, {
        loteId: lote.loteId, materialId: m.id, tamanho: '40', caNumero: 'CA 12345', caValidade: '2027-06-30', origem: 'ENTRADA',
        quantidadeEntrada: 10, quantidadeBaixada: 0, quantidadeEntregue: 0, saldo: 10,
      });
      assert.deepEqual({ ...operacao, id: undefined, criadoEm: undefined }, {
        id: undefined, tipo: 'ENTRADA', loteId: lote.loteId, quantidade: 10, motivo: null, justificativa: null, usuarioId: u.masterA, criadoEm: undefined,
      });
      assert.match(operacao.id, /^\d+$/);

      const noBanco = await loteNoBanco(lote.loteId);
      assert.deepEqual({ ...noBanco, criado_em: undefined }, {
        empresa_id: empresa.A, material_id: m.id, tamanho: '40', ca_numero: 'CA 12345', ca_validade: '2027-06-30', origem: 'ENTRADA',
        quantidade_entrada: 10, quantidade_baixada: 0, quantidade_entregue: 0, saldo: 10, criado_em: undefined,
      });
      const [op] = await operacoesDoLote(lote.loteId);
      assert.deepEqual([op.id, op.empresa_id, op.tipo, op.quantidade, op.motivo, op.justificativa, op.usuario_id, op.chave_idempotencia],
        [operacao.id, empresa.A, 'ENTRADA', 10, null, null, u.masterA, corpo.chaveIdempotencia]);
      assert.match(op.requisicao_hash, /^[0-9a-f]{64}$/);

      assert.deepEqual(diferenca(antes, await retrato(empresa.A)), { lotes: 1, operacoes: 1, baixado: 0, auditorias: 1, legado: 0 });
    });

    test('auditoria ESTOQUE_ENTRADA: empresa, usuário, material, lote, tamanho, CA, quantidade e horário; nada de chave, hash ou corpo bruto', async () => {
      const m = await novoMaterial(empresa.A);
      const r = await postEntrada('masterA', m.id, corpoEntrada({ quantidade: 7 })).set('User-Agent', 'x'.repeat(300));
      assert.equal(r.status, 201);
      const [linha, ...outras] = await auditoriasDoLote(r.body.lote.loteId, 'ESTOQUE_ENTRADA');
      assert.equal(outras.length, 0);
      assert.deepEqual([linha.empresa_id, linha.usuario_id, linha.referencia], [empresa.A, u.masterA, String(r.body.lote.loteId)]);
      assert.deepEqual(linha.contexto, {
        operacaoId: r.body.operacao.id, materialId: m.id, loteId: r.body.lote.loteId, tamanho: '40', caNumero: '12345', caValidade: '2027-06-30', quantidade: 7,
      });
      assert.deepEqual([linha.dados_anteriores, linha.dados_novos], [null, { saldo: 7 }]);
      assert.ok(linha.criado_em instanceof Date);
      assert.equal(linha.dispositivo.length, 150, 'o User-Agent longo é cortado no tamanho da coluna');
    });

    test('CA e validade são obrigatórios em toda entrada, inclusive em material que dispensa CA; não existe campo para dispensar', async () => {
      const normal = await novoMaterial(empresa.A);
      const dispensado = await novoMaterial(empresa.A, { exigeCa: false });
      const antes = await retrato(empresa.A);
      for (const m of [normal, dispensado]) {
        for (const [corpo, campo, codigo] of [
          [semCampo(corpoEntrada(), 'caNumero'), 'body.caNumero', 'CAMPO_OBRIGATORIO'],
          [corpoEntrada({ caNumero: null }), 'body.caNumero', 'TIPO_INVALIDO'],
          [corpoEntrada({ caNumero: '   ' }), 'body.caNumero', 'CA_NUMERO_INVALIDO'],
          [corpoEntrada({ caNumero: 'x'.repeat(21) }), 'body.caNumero', 'CA_NUMERO_INVALIDO'],
          [semCampo(corpoEntrada(), 'caValidade'), 'body.caValidade', 'CAMPO_OBRIGATORIO'],
          [corpoEntrada({ caValidade: '2026-02-30' }), 'body.caValidade', 'CA_VALIDADE_INVALIDA'],
          [corpoEntrada({ exigeCa: false }), 'body.exigeCa', 'CAMPO_NAO_PERMITIDO'],
        ]) {
          const r = await postEntrada('masterA', m.id, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [[campo, codigo]]);
        }
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('validade em São Paulo: vence hoje, amanhã, em 30 dias ou mais tarde é aceita; venceu ontem é 400 CA_VENCIDO', async () => {
      const m = await novoMaterial(empresa.A);
      for (const caValidade of [HOJE, AMANHA, somarDias(HOJE, 30), '2030-01-31']) {
        const r = await postEntrada('masterA', m.id, corpoEntrada({ caValidade }));
        assert.equal(r.status, 201, `${caValidade}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.lote.caValidade, caValidade);
      }
      const antes = await retrato(empresa.A);
      const vencido = await postEntrada('masterA', m.id, corpoEntrada({ caValidade: ONTEM }));
      assert.deepEqual([vencido.status, vencido.body.codigo], [400, 'VALIDACAO']);
      assert.deepEqual(vencido.body.detalhes, [{ campo: 'body.caValidade', codigo: 'CA_VENCIDO', mensagem: 'A validade do CA precisa ser hoje ou uma data futura' }]);
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('à 00h30 de 01/10 em São Paulo o CA que venceu em 30/09 já é recusado, e o de 01/10 é aceito', async () => {
      const m = await novoMaterial(empresa.A);
      const vencido = await postEntrada('masterA', m.id, corpoEntrada({ caValidade: HOJE }), appMadrugada);
      assert.equal(vencido.status, 400);
      assert.equal(vencido.body.detalhes[0].codigo, 'CA_VENCIDO');
      const valido = await postEntrada('masterA', m.id, corpoEntrada({ caValidade: '2026-10-01' }), appMadrugada);
      assert.equal(valido.status, 201);
    });

    test('quantidade zero, negativa, fracionária ou em texto; tamanho ausente, vazio ou longo; chave que não é UUID: 400 sem gravar', async () => {
      const m = await novoMaterial(empresa.A);
      const antes = await retrato(empresa.A);
      for (const [corpo, campo] of [
        [corpoEntrada({ quantidade: 0 }), 'body.quantidade'],
        [corpoEntrada({ quantidade: -5 }), 'body.quantidade'],
        [corpoEntrada({ quantidade: 2.5 }), 'body.quantidade'],
        [corpoEntrada({ quantidade: '5' }), 'body.quantidade'],
        [semCampo(corpoEntrada(), 'tamanho'), 'body.tamanho'],
        [corpoEntrada({ tamanho: '   ' }), 'body.tamanho'],
        [corpoEntrada({ tamanho: 'x'.repeat(21) }), 'body.tamanho'],
        [corpoEntrada({ chaveIdempotencia: 'nao-e-uuid' }), 'body.chaveIdempotencia'],
        [semCampo(corpoEntrada(), 'chaveIdempotencia'), 'body.chaveIdempotencia'],
      ]) {
        const r = await postEntrada('masterA', m.id, corpo);
        assert.deepEqual([r.status, r.body.codigo, r.body.detalhes.map((d) => d.campo)], [400, 'VALIDACAO', [campo]], JSON.stringify(corpo));
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('material inexistente ou de outra empresa: o mesmo 404; material inativo: 409 MATERIAL_INATIVO; nada gravado', async () => {
      const deB = await novoMaterial(empresa.B);
      const inativo = await novoMaterial(empresa.A, { ativo: false });
      const [antesA, antesB] = [await retrato(empresa.A), await retrato(empresa.B)];

      const cruzado = await postEntrada('masterA', deB.id, corpoEntrada());
      const inexistente = await postEntrada('masterA', 999999, corpoEntrada());
      assert.deepEqual([cruzado.status, cruzado.body], [404, { status: 'error', codigo: 'MATERIAL_NAO_ENCONTRADO', message: 'Material não encontrado' }]);
      assert.deepEqual([inexistente.status, inexistente.body], [cruzado.status, cruzado.body]);

      const r = await postEntrada('masterA', inativo.id, corpoEntrada());
      assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_INATIVO']);

      assert.deepEqual([await retrato(empresa.A), await retrato(empresa.B)], [antesA, antesB]);
    });

    test('sem sessão: 401; sem MOVIMENTAR_ESTOQUE: 403 PERMISSAO_NEGADA; nada gravado', async () => {
      const m = await novoMaterial(empresa.A);
      const antes = await retrato(empresa.A);
      assert.equal((await postEntrada('ninguem', m.id, corpoEntrada())).status, 401);
      const negado = await postEntrada('usuarioA', m.id, corpoEntrada());
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.deepEqual(await retrato(empresa.A), antes);
    });
  });

  describe('idempotência da entrada', () => {
    test('mesma chave e mesma requisição lógica: 200 repetida com a entrada original; espaços e caixa da chave não mudam a requisição', async () => {
      const m = await novoMaterial(empresa.A);
      const corpo = corpoEntrada();
      const primeira = await postEntrada('masterA', m.id, corpo);
      assert.equal(primeira.status, 201);
      const antes = await retrato(empresa.A);

      for (const repeticao of [corpo, { ...corpo, tamanho: ' 40 ', caNumero: '12345  ', chaveIdempotencia: corpo.chaveIdempotencia.toUpperCase() }]) {
        const r = await postEntrada('masterA', m.id, repeticao);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body, { ...primeira.body, repetida: true });
      }
      assert.deepEqual(await retrato(empresa.A), antes, 'nenhum lote, operação ou auditoria nova');
    });

    test('mesma chave com outra requisição: 409 IDEMPOTENCIA_CONFLITO sem gravar; a chave de uma entrada também não serve para baixa', async () => {
      const m = await novoMaterial(empresa.A);
      const outro = await novoMaterial(empresa.A);
      const corpo = corpoEntrada();
      const primeira = await postEntrada('masterA', m.id, corpo);
      assert.equal(primeira.status, 201);
      const antes = await retrato(empresa.A);

      const tentativas = [
        () => postEntrada('masterA', m.id, { ...corpo, quantidade: 11 }),
        () => postEntrada('masterA', m.id, { ...corpo, tamanho: '41' }),
        () => postEntrada('masterA', m.id, { ...corpo, caNumero: '54321' }),
        () => postEntrada('masterA', m.id, { ...corpo, caValidade: '2027-07-01' }),
        () => postEntrada('masterA', outro.id, corpo),
        () => postBaixa('masterA', primeira.body.lote.loteId, corpoBaixa({ chaveIdempotencia: corpo.chaveIdempotencia })),
      ];
      for (const tentar of tentativas) {
        const r = await tentar();
        assert.deepEqual([r.status, r.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO']);
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('a mesma chave em outra empresa é outra operação', async () => {
      const mA = await novoMaterial(empresa.A);
      const mB = await novoMaterial(empresa.B);
      const corpo = corpoEntrada();
      const a = await postEntrada('masterA', mA.id, corpo);
      const b = await postEntrada('masterB', mB.id, corpo);
      assert.deepEqual([a.status, b.status], [201, 201]);
      assert.notEqual(a.body.lote.loteId, b.body.lote.loteId);
    });

    test('a repetição devolve a entrada original mesmo depois de o material ser inativado e de a data virar', async () => {
      const m = await novoMaterial(empresa.A);
      const corpo = corpoEntrada({ caValidade: HOJE });
      const primeira = await postEntrada('masterA', m.id, corpo);
      assert.equal(primeira.status, 201);
      await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [m.id]);

      const repetida = await postEntrada('masterA', m.id, corpo, appMadrugada);
      assert.equal(repetida.status, 200, JSON.stringify(repetida.body));
      assert.equal(repetida.body.operacao.id, primeira.body.operacao.id);
      const nova = await postEntrada('masterA', m.id, corpoEntrada(), appMadrugada);
      assert.deepEqual([nova.status, nova.body.codigo], [409, 'MATERIAL_INATIVO']);
    });

    test('duas requisições simultâneas com a mesma chave: uma entrada só, e as duas respostas trazem a mesma operação', async () => {
      const m = await novoMaterial(empresa.A);
      const corpo = corpoEntrada();
      const antes = await retrato(empresa.A);
      const respostas = await disputar('SELECT 1 FROM materiais WHERE id = $1 FOR UPDATE', [m.id], [
        () => postEntrada('masterA', m.id, corpo),
        () => postEntrada('masterA', m.id, corpo),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 201], JSON.stringify(respostas.map((r) => r.body)));
      assert.equal(respostas[0].body.operacao.id, respostas[1].body.operacao.id);
      assert.deepEqual(diferenca(antes, await retrato(empresa.A)), { lotes: 1, operacoes: 1, baixado: 0, auditorias: 1, legado: 0 });
    });

    test('duas requisições simultâneas com a mesma chave e conteúdo diferente: uma entra, a outra recebe 409', async () => {
      const m = await novoMaterial(empresa.A);
      const corpo = corpoEntrada();
      const antes = await retrato(empresa.A);
      const respostas = await disputar('SELECT 1 FROM materiais WHERE id = $1 FOR UPDATE', [m.id], [
        () => postEntrada('masterA', m.id, corpo),
        () => postEntrada('masterA', m.id, { ...corpo, quantidade: 99 }),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409]);
      assert.equal(respostas.find((r) => r.status === 409).body.codigo, 'IDEMPOTENCIA_CONFLITO');
      assert.deepEqual(diferenca(antes, await retrato(empresa.A)), { lotes: 1, operacoes: 1, baixado: 0, auditorias: 1, legado: 0 });
    });
  });

  describe('baixa', () => {
    test('baixa válida: 201 com a operação BAIXA e o lote atualizado; CA, validade, origem e entrada do lote não mudam', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const loteAntes = await loteNoBanco(lote.loteId);
      const corpo = corpoBaixa();
      const r = await postBaixa('masterA', lote.loteId, corpo);
      assert.equal(r.status, 201, JSON.stringify(r.body));

      assert.deepEqual([r.body.status, r.body.repetida], ['ok', false]);
      assert.deepEqual({ ...r.body.operacao, id: undefined, criadoEm: undefined }, {
        id: undefined, tipo: 'BAIXA', loteId: lote.loteId, quantidade: 4, motivo: 'AVARIA', justificativa: null, usuarioId: u.masterA, criadoEm: undefined,
      });
      assert.deepEqual(r.body.lote, { ...lote, quantidadeBaixada: 4, saldo: 6 });

      const loteDepois = await loteNoBanco(lote.loteId);
      assert.deepEqual(loteDepois, { ...loteAntes, quantidade_baixada: 4, saldo: 6 });
      const operacoes = await operacoesDoLote(lote.loteId);
      assert.deepEqual(operacoes.map((o) => [o.tipo, o.quantidade, o.motivo, o.usuario_id]), [['ENTRADA', 10, null, u.masterA], ['BAIXA', 4, 'AVARIA', u.masterA]]);
      assert.equal(operacoes[1].chave_idempotencia, corpo.chaveIdempotencia);
      assert.match(operacoes[1].requisicao_hash, /^[0-9a-f]{64}$/);
    });

    test('os sete motivos da 042 são aceitos; justificativa é opcional fora do OUTRO e sai aparada', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id, { quantidade: 20 });
      for (const motivo of MOTIVOS) {
        const justificativa = motivo === 'OUTRO' || motivo === 'PERDA' ? `  Registro de ${motivo}  ` : undefined;
        const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 1, motivo, justificativa }));
        assert.equal(r.status, 201, `${motivo}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.operacao.justificativa, justificativa ? `Registro de ${motivo}` : null);
      }
      const baixas = (await operacoesDoLote(lote.loteId)).filter((o) => o.tipo === 'BAIXA');
      assert.deepEqual(baixas.map((o) => o.motivo), MOTIVOS);
      assert.equal((await loteNoBanco(lote.loteId)).saldo, 13);
    });

    test('OUTRO sem justificativa é 400; motivo fora da lista, quantidade inválida ou chave que não é UUID também; nada gravado', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const antes = await retrato(empresa.A);
      for (const [corpo, campo, codigo] of [
        [corpoBaixa({ motivo: 'OUTRO' }), 'body.justificativa', 'JUSTIFICATIVA_OBRIGATORIA'],
        [corpoBaixa({ motivo: 'OUTRO', justificativa: null }), 'body.justificativa', 'JUSTIFICATIVA_OBRIGATORIA'],
        [corpoBaixa({ motivo: 'OUTRO', justificativa: '   ' }), 'body.justificativa', 'JUSTIFICATIVA_INVALIDA'],
        [corpoBaixa({ justificativa: 'x'.repeat(501) }), 'body.justificativa', 'JUSTIFICATIVA_INVALIDA'],
        [corpoBaixa({ motivo: 'ROUBO' }), 'body.motivo', 'VALOR_NAO_PERMITIDO'],
        [semCampo(corpoBaixa(), 'motivo'), 'body.motivo', 'VALOR_NAO_PERMITIDO'],
        [corpoBaixa({ quantidade: 0 }), 'body.quantidade', 'TAMANHO_MINIMO'],
        [corpoBaixa({ quantidade: -1 }), 'body.quantidade', 'TAMANHO_MINIMO'],
        [corpoBaixa({ chaveIdempotencia: 'nao-e-uuid' }), 'body.chaveIdempotencia', 'FORMATO_INVALIDO'],
      ]) {
        const r = await postBaixa('masterA', lote.loteId, corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [[campo, codigo]]);
      }
      const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ motivo: 'OUTRO', justificativa: ' Doação para treinamento ' }));
      assert.equal(r.status, 201);
      assert.equal(r.body.operacao.justificativa, 'Doação para treinamento');
      assert.deepEqual(diferenca(antes, await retrato(empresa.A)), { lotes: 0, operacoes: 1, baixado: 4, auditorias: 1, legado: 0 });
    });

    test('quantidade acima do saldo: 409 SALDO_LOTE_INSUFICIENTE e o lote não muda', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 7 }));
      const antes = [await loteNoBanco(lote.loteId), await retrato(empresa.A)];
      const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 4 }));
      assert.deepEqual([r.status, r.body], [409, { status: 'error', codigo: 'SALDO_LOTE_INSUFICIENTE', message: 'Quantidade maior que o saldo do lote' }]);
      assert.deepEqual([await loteNoBanco(lote.loteId), await retrato(empresa.A)], antes);
    });

    test('lote inexistente ou de outra empresa: o mesmo 404 LOTE_NAO_ENCONTRADO, e o lote da outra empresa não muda', async () => {
      const mB = await novoMaterial(empresa.B);
      const { lote: loteB } = await entradaCriada('masterB', mB.id);
      const antes = [await loteNoBanco(loteB.loteId), await retrato(empresa.A), await retrato(empresa.B)];
      const cruzado = await postBaixa('masterA', loteB.loteId, corpoBaixa());
      const inexistente = await postBaixa('masterA', 999999, corpoBaixa());
      assert.deepEqual([cruzado.status, cruzado.body], [404, { status: 'error', codigo: 'LOTE_NAO_ENCONTRADO', message: 'Lote não encontrado' }]);
      assert.deepEqual([inexistente.status, inexistente.body], [cruzado.status, cruzado.body]);
      assert.deepEqual([await loteNoBanco(loteB.loteId), await retrato(empresa.A), await retrato(empresa.B)], antes);
    });

    test('material inativo: a baixa é permitida, inclusive em saldo legado sem CA', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const legado = await inserirLote(pool, { empresaId: empresa.A, materialId: m.id, tamanho: '40', quantidade: 3 });
      await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [m.id]);

      const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ motivo: 'DESCARTE' }));
      assert.deepEqual([r.status, r.body.lote.saldo], [201, 6]);
      const semCa = await postBaixa('masterA', legado, corpoBaixa({ quantidade: 3, motivo: 'AJUSTE_INVENTARIO' }));
      assert.deepEqual([semCa.status, semCa.body.lote.origem, semCa.body.lote.caNumero, semCa.body.lote.saldo], [201, 'SALDO_INICIAL', null, 0]);
    });

    test('baixa total: o lote zerado continua existindo, sai da consulta de lotes e segue com a entrada original', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote, operacao: entrada } = await entradaCriada('masterA', m.id, { tamanho: 'G', quantidade: 5 });
      const [opEntradaAntes] = await operacoesDoLote(lote.loteId);
      const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 5, motivo: 'PERDA' }));
      assert.deepEqual([r.status, r.body.lote.saldo], [201, 0]);

      const noBanco = await loteNoBanco(lote.loteId);
      assert.deepEqual([noBanco.quantidade_entrada, noBanco.quantidade_baixada, noBanco.saldo, noBanco.ca_numero, noBanco.origem], [5, 5, 0, '12345', 'ENTRADA']);
      const operacoes = await operacoesDoLote(lote.loteId);
      assert.deepEqual(operacoes[0], opEntradaAntes, 'a operação de entrada continua igual');
      assert.equal(operacoes[0].id, entrada.id);
      assert.deepEqual((await lotesDe('masterA', m.id)).lotes, [], 'lote zerado não é saldo atual');
      assert.deepEqual(await itemDe('masterA', m, 'G'), [0, 0, 0], 'o tamanho continua listado, esgotado');
      const semSaldo = await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 1 }));
      assert.deepEqual([semSaldo.status, semSaldo.body.codigo], [409, 'SALDO_LOTE_INSUFICIENTE']);
    });

    test('histórico append-only: as operações anteriores ficam intactas e o banco recusa apagar ou alterar', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 1 }));
      const historico = await operacoesDoLote(lote.loteId);
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 2, motivo: 'DESCARTE' }));
      const depois = await operacoesDoLote(lote.loteId);
      assert.deepEqual(depois.slice(0, historico.length), historico);
      assert.equal(depois.length, historico.length + 1);

      await assert.rejects(pool.query('DELETE FROM estoque_operacoes WHERE id = $1', [historico[1].id]), /append-only/);
      await assert.rejects(pool.query('UPDATE estoque_operacoes SET quantidade = 9 WHERE id = $1', [historico[1].id]), /append-only/);
      await assert.rejects(pool.query('DELETE FROM estoque_lotes WHERE id = $1', [lote.loteId]), /histórico/);
      assert.deepEqual(await operacoesDoLote(lote.loteId), depois);
    });

    test('auditoria ESTOQUE_BAIXA: material, lote, tamanho, CA, quantidade, motivo, justificativa e saldo antes e depois', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id, { tamanho: 'M', caNumero: '777' });
      const r = await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 3, motivo: 'OUTRO', justificativa: 'Amostra para ensaio' }));
      assert.equal(r.status, 201);
      const [linha, ...outras] = await auditoriasDoLote(lote.loteId, 'ESTOQUE_BAIXA');
      assert.equal(outras.length, 0);
      assert.deepEqual([linha.empresa_id, linha.usuario_id, linha.referencia], [empresa.A, u.masterA, String(lote.loteId)]);
      assert.deepEqual(linha.contexto, {
        operacaoId: r.body.operacao.id, materialId: m.id, loteId: lote.loteId, tamanho: 'M', caNumero: '777',
        quantidade: 3, motivo: 'OUTRO', justificativa: 'Amostra para ensaio',
      });
      assert.deepEqual([linha.dados_anteriores, linha.dados_novos], [{ saldo: 10 }, { saldo: 7 }]);
      assert.ok(linha.criado_em instanceof Date);
    });

    test('sem sessão: 401; sem MOVIMENTAR_ESTOQUE: 403 PERMISSAO_NEGADA; nada gravado', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const antes = await retrato(empresa.A);
      assert.equal((await postBaixa('ninguem', lote.loteId, corpoBaixa())).status, 401);
      const negado = await postBaixa('usuarioA', lote.loteId, corpoBaixa());
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.deepEqual(await retrato(empresa.A), antes);
    });
  });

  describe('idempotência e concorrência da baixa', () => {
    test('mesma chave e mesma baixa: 200 repetida com a baixa original; o saldo cai uma vez só', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const corpo = corpoBaixa({ motivo: 'OUTRO', justificativa: 'Doação' });
      const primeira = await postBaixa('masterA', lote.loteId, corpo);
      assert.equal(primeira.status, 201);
      const antes = await retrato(empresa.A);
      const repetida = await postBaixa('masterA', lote.loteId, { ...corpo, justificativa: '  Doação ' });
      assert.equal(repetida.status, 200, JSON.stringify(repetida.body));
      assert.deepEqual(repetida.body, { ...primeira.body, repetida: true });
      assert.deepEqual(await retrato(empresa.A), antes);
      assert.equal((await loteNoBanco(lote.loteId)).saldo, 6);
    });

    test('mesma chave com outra baixa: 409 IDEMPOTENCIA_CONFLITO sem gravar', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const { lote: outroLote } = await entradaCriada('masterA', m.id);
      const corpo = corpoBaixa({ motivo: 'OUTRO', justificativa: 'Doação' });
      assert.equal((await postBaixa('masterA', lote.loteId, corpo)).status, 201);
      const antes = await retrato(empresa.A);
      for (const [loteId, variacao] of [
        [lote.loteId, { quantidade: 5 }],
        [lote.loteId, { motivo: 'PERDA' }],
        [lote.loteId, { justificativa: 'Treinamento' }],
        [outroLote.loteId, {}],
      ]) {
        const r = await postBaixa('masterA', loteId, { ...corpo, ...variacao });
        assert.deepEqual([r.status, r.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO'], JSON.stringify(variacao));
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('duas baixas simultâneas com a mesma chave: uma baixa só', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const corpo = corpoBaixa({ quantidade: 3 });
      const respostas = await disputar('SELECT 1 FROM estoque_lotes WHERE id = $1 FOR UPDATE', [lote.loteId], [
        () => postBaixa('masterA', lote.loteId, corpo),
        () => postBaixa('masterA', lote.loteId, corpo),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 201], JSON.stringify(respostas.map((r) => r.body)));
      assert.equal(respostas[0].body.operacao.id, respostas[1].body.operacao.id);
      assert.equal((await loteNoBanco(lote.loteId)).saldo, 7);
      assert.equal((await auditoriasDoLote(lote.loteId, 'ESTOQUE_BAIXA')).length, 1);
    });

    test('três baixas simultâneas de 4 num lote de 10: duas passam, uma recebe 409, e o saldo termina em 2, nunca negativo', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id);
      const respostas = await disputar('SELECT 1 FROM estoque_lotes WHERE id = $1 FOR UPDATE', [lote.loteId], [
        () => postBaixa('masterA', lote.loteId, corpoBaixa()),
        () => postBaixa('masterA', lote.loteId, corpoBaixa()),
        () => postBaixa('masterA', lote.loteId, corpoBaixa()),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 201, 409]);
      assert.equal(respostas.find((r) => r.status === 409).body.codigo, 'SALDO_LOTE_INSUFICIENTE');
      const noBanco = await loteNoBanco(lote.loteId);
      assert.deepEqual([noBanco.quantidade_baixada, noBanco.saldo], [8, 2]);
      assert.equal((await operacoesDoLote(lote.loteId)).filter((o) => o.tipo === 'BAIXA').length, 2);
    });
  });

  describe('leituras de lotes, Itens Disponíveis e dashboard depois das operações', () => {
    test('entrada: físico 10, bloqueado 0, disponível 10; +5 com CA válido; físico 15, bloqueado 0, disponível 15', async () => {
      const m = await novoMaterial(empresa.A);
      await entradaCriada('masterA', m.id, { quantidade: 10 });
      const antes = await indicadores('masterA');
      assert.deepEqual((await lotesDe('masterA', m.id)).porTamanho, [{ tamanho: '40', fisico: 10, bloqueado: 0, disponivel: 10 }]);
      assert.deepEqual(await itemDe('masterA', m, '40'), [10, 0, 10]);

      const { lote } = await entradaCriada('masterA', m.id, { quantidade: 5, caNumero: '99999', caValidade: '2028-01-31' });
      const lotes = await lotesDe('masterA', m.id);
      assert.deepEqual(lotes.porTamanho, [{ tamanho: '40', fisico: 15, bloqueado: 0, disponivel: 15 }]);
      assert.deepEqual(lotes.totais, { fisico: 15, bloqueado: 0, disponivel: 15 });
      const novo = lotes.lotes.find((l) => l.loteId === lote.loteId);
      assert.deepEqual([novo.origem, novo.caNumero, novo.situacaoCa, novo.fisico, novo.disponivel], ['ENTRADA', '99999', 'VALIDO', 5, 5]);
      assert.deepEqual(await itemDe('masterA', m, '40'), [15, 0, 15]);
      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: 5, abaixo: 0, vencido: 0, aVencer: 0 });
    });

    test('entrada com CA a vencer em 30 dias entra disponível e aparece como alerta, não como bloqueio', async () => {
      const m = await novoMaterial(empresa.A);
      const antes = await indicadores('masterA');
      await entradaCriada('masterA', m.id, { quantidade: 4, caValidade: somarDias(HOJE, 30) });
      assert.deepEqual((await lotesDe('masterA', m.id)).lotes.map((l) => [l.situacaoCa, l.fisico, l.bloqueado, l.disponivel]), [['A_VENCER', 4, 0, 4]]);
      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: 4, abaixo: 0, vencido: 0, aVencer: 1 });
    });

    test('baixa em lote disponível: físico 10 e disponível 10; -4; físico 6 e disponível 6', async () => {
      const m = await novoMaterial(empresa.A);
      const { lote } = await entradaCriada('masterA', m.id, { tamanho: 'U' });
      const antes = await indicadores('masterA');
      assert.equal((await postBaixa('masterA', lote.loteId, corpoBaixa())).status, 201);
      assert.deepEqual((await lotesDe('masterA', m.id)).lotes.map((l) => [l.fisico, l.bloqueado, l.disponivel]), [[6, 0, 6]]);
      assert.deepEqual(await itemDe('masterA', m, 'U'), [6, 0, 6]);
      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: -4, abaixo: 0, vencido: 0, aVencer: 0 });
    });

    test('baixa em lote com CA vencido: físico 10, bloqueado 10, disponível 0; -4 por CA_VENCIDO; físico 6, bloqueado 6, disponível 0', async () => {
      const m = await novoMaterial(empresa.A);
      const vencido = await inserirLote(pool, { empresaId: empresa.A, materialId: m.id, tamanho: '42', quantidade: 10, ca: '55555', validade: ONTEM });
      assert.deepEqual((await lotesDe('masterA', m.id)).lotes.map((l) => [l.situacaoCa, l.fisico, l.bloqueado, l.disponivel]), [['VENCIDO', 10, 10, 0]]);
      const antes = await indicadores('masterA');

      const r = await postBaixa('masterA', vencido, corpoBaixa({ motivo: 'CA_VENCIDO' }));
      assert.deepEqual([r.status, r.body.lote.caNumero, r.body.lote.caValidade, r.body.lote.saldo], [201, '55555', ONTEM, 6]);
      assert.deepEqual((await lotesDe('masterA', m.id)).lotes.map((l) => [l.situacaoCa, l.fisico, l.bloqueado, l.disponivel]), [['VENCIDO', 6, 6, 0]]);
      assert.deepEqual(await itemDe('masterA', m, '42'), [6, 6, 0]);
      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: 0, abaixo: 0, vencido: 0, aVencer: 0 }, 'ainda há saldo vencido');

      assert.equal((await postBaixa('masterA', vencido, corpoBaixa({ quantidade: 6, motivo: 'CA_VENCIDO' }))).status, 201);
      assert.deepEqual(await itemDe('masterA', m, '42'), [0, 0, 0]);
      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: 0, abaixo: 0, vencido: -1, aVencer: 0 }, 'lote zerado sai do CA vencido');
    });

    test('estoque mínimo continua pela regra da E3: só com mínimo configurado e disponível abaixo dele', async () => {
      const comMinimo = await novoMaterial(empresa.A, { minimo: 10 });
      const semMinimo = await novoMaterial(empresa.A);
      const base = await indicadores('masterA');
      const abaixo = async () => (await indicadores('masterA')).abaixo - base.abaixo;

      const { lote } = await entradaCriada('masterA', comMinimo.id, { quantidade: 5 });
      assert.equal(await abaixo(), 1, 'mínimo 10, disponível 5');
      await entradaCriada('masterA', comMinimo.id, { quantidade: 5 });
      assert.equal(await abaixo(), 0, 'mínimo 10, disponível 10');
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 1 }));
      assert.equal(await abaixo(), 1, 'mínimo 10, disponível 9');

      const { lote: loteSemMinimo } = await entradaCriada('masterA', semMinimo.id, { quantidade: 3 });
      await postBaixa('masterA', loteSemMinimo.loteId, corpoBaixa({ quantidade: 3 }));
      assert.equal(await abaixo(), 1, 'mínimo 0 com disponível 0 não é abaixo do mínimo');
    });

    test('isolamento: entrada e baixa da empresa A não mudam nada do que a empresa B lê', async () => {
      const mB = await novoMaterial(empresa.B, { minimo: 5 });
      await entradaCriada('masterB', mB.id, { quantidade: 8 });
      const antesB = [await indicadores('masterB'), await lotesDe('masterB', mB.id), await itemDe('masterB', mB, '40')];

      const mA = await novoMaterial(empresa.A, { minimo: 5 });
      const { lote } = await entradaCriada('masterA', mA.id, { quantidade: 8 });
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 6 }));

      assert.deepEqual([await indicadores('masterB'), await lotesDe('masterB', mB.id), await itemDe('masterB', mB, '40')], antesB);
      assert.equal((await get('masterB', `/api/materiais/${mA.id}/estoque/lotes`)).status, 404);
      assert.equal(await itemDe('masterB', mA, '40'), null);
    });
  });

  describe('tamanho conforme o material', () => {
    test('material que exige tamanho: sem tamanho é 400 TAMANHO_OBRIGATORIO; com tamanho, a entrada passa', async () => {
      const m = await novoMaterial(empresa.A);
      const antes = await retrato(empresa.A);
      for (const corpo of [semCampo(corpoEntrada(), 'tamanho'), corpoEntrada({ tamanho: null })]) {
        const r = await postEntrada('masterA', m.id, corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.tamanho', 'TAMANHO_OBRIGATORIO']]);
      }
      assert.deepEqual(await retrato(empresa.A), antes);
      const r = await postEntrada('masterA', m.id, corpoEntrada({ tamanho: '42' }));
      assert.deepEqual([r.status, r.body.lote.tamanho], [201, '42']);
    });

    test('material sem tamanho: a entrada sem tamanho grava lote com tamanho NULL, e a auditoria registra null', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false });
      const r = await postEntrada('masterA', m.id, semCampo(corpoEntrada({ quantidade: 6 }), 'tamanho'));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.lote.tamanho, null);
      assert.equal((await loteNoBanco(r.body.lote.loteId)).tamanho, null);
      const [op] = await operacoesDoLote(r.body.lote.loteId);
      assert.deepEqual([op.tipo, op.quantidade], ['ENTRADA', 6]);
      const [auditoria] = await auditoriasDoLote(r.body.lote.loteId, 'ESTOQUE_ENTRADA');
      assert.equal(auditoria.contexto.tamanho, null);
    });

    test('material sem tamanho: tamanho informado é 400 TAMANHO_NAO_SE_APLICA; vazio é 400 TAMANHO_INVALIDO; nada gravado', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false });
      const antes = await retrato(empresa.A);
      for (const [tamanho, codigo] of [['Único', 'TAMANHO_NAO_SE_APLICA'], ['U', 'TAMANHO_NAO_SE_APLICA'], ['', 'TAMANHO_INVALIDO'], ['   ', 'TAMANHO_INVALIDO']]) {
        const r = await postEntrada('masterA', m.id, corpoEntrada({ tamanho }));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(tamanho));
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.tamanho', codigo]]);
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('material não classificado: 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO, com ou sem tamanho; nada gravado', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: null });
      const antes = await retrato(empresa.A);
      for (const corpo of [corpoEntrada(), semCampo(corpoEntrada(), 'tamanho')]) {
        const r = await postEntrada('masterA', m.id, corpo);
        assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
      }
      assert.deepEqual(await retrato(empresa.A), antes);
    });

    test('sem tamanho, CA e validade continuam obrigatórios e o CA vencido continua recusado', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false });
      const antes = await retrato(empresa.A);
      const base = semCampo(corpoEntrada(), 'tamanho');
      for (const [corpo, campo, codigo] of [
        [semCampo(base, 'caNumero'), 'body.caNumero', 'CAMPO_OBRIGATORIO'],
        [semCampo(base, 'caValidade'), 'body.caValidade', 'CAMPO_OBRIGATORIO'],
        [{ ...base, caValidade: ONTEM }, 'body.caValidade', 'CA_VENCIDO'],
      ]) {
        const r = await postEntrada('masterA', m.id, corpo);
        assert.deepEqual([r.status, r.body.detalhes.map((d) => [d.campo, d.codigo])], [400, [[campo, codigo]]]);
      }
      assert.deepEqual(await retrato(empresa.A), antes);
      assert.equal((await postEntrada('masterA', m.id, { ...base, caValidade: HOJE })).status, 201, 'CA que vence hoje continua aceito');
    });

    test('idempotência sem tamanho: ausente e null são a mesma entrada; com tamanho é outra; simultâneas geram uma só', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false });
      const corpo = semCampo(corpoEntrada(), 'tamanho');
      const primeira = await postEntrada('masterA', m.id, corpo);
      assert.equal(primeira.status, 201);
      const repetida = await postEntrada('masterA', m.id, { ...corpo, tamanho: null });
      assert.deepEqual([repetida.status, repetida.body.operacao.id], [200, primeira.body.operacao.id]);
      const outra = await postEntrada('masterA', m.id, { ...corpo, tamanho: 'U' });
      assert.deepEqual([outra.status, outra.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO']);

      const simultanea = semCampo(corpoEntrada(), 'tamanho');
      const antes = await retrato(empresa.A);
      const respostas = await disputar('SELECT 1 FROM materiais WHERE id = $1 FOR UPDATE', [m.id], [
        () => postEntrada('masterA', m.id, simultanea),
        () => postEntrada('masterA', m.id, simultanea),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 201]);
      assert.deepEqual(diferenca(antes, await retrato(empresa.A)), { lotes: 1, operacoes: 1, baixado: 0, auditorias: 1, legado: 0 });
    });

    test('isolamento: a empresa B não registra entrada em material sem tamanho da empresa A', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false });
      const antes = [await retrato(empresa.A), await retrato(empresa.B)];
      const r = await postEntrada('masterB', m.id, semCampo(corpoEntrada(), 'tamanho'));
      assert.deepEqual([r.status, r.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      assert.deepEqual([await retrato(empresa.A), await retrato(empresa.B)], antes);
    });
  });

  describe('leituras de material sem tamanho', () => {
    test('lotes, Itens Disponíveis e dashboard mostram tamanho null, com físico, bloqueado e disponível corretos', async () => {
      const m = await novoMaterial(empresa.A, { exigeTamanho: false, minimo: 10 });
      const antes = await indicadores('masterA');
      const { lote } = await entradaCriada('masterA', m.id, { tamanho: undefined, quantidade: 5 });
      await inserirLote(pool, { empresaId: empresa.A, materialId: m.id, tamanho: null, quantidade: 3 });

      const lotes = await lotesDe('masterA', m.id);
      assert.deepEqual(lotes.lotes.map((l) => [l.tamanho, l.situacaoCa, l.fisico, l.bloqueado, l.disponivel]), [
        [null, 'VALIDO', 5, 0, 5],
        [null, 'SEM_CA', 3, 3, 0],
      ]);
      assert.equal(lotes.lotes[0].loteId, lote.loteId);
      assert.deepEqual(lotes.porTamanho, [{ tamanho: null, fisico: 8, bloqueado: 3, disponivel: 5 }]);
      assert.deepEqual(lotes.totais, { fisico: 8, bloqueado: 3, disponivel: 5 });

      assert.deepEqual(await itemDe('masterA', m, null), [8, 3, 5]);
      const filtros = (await get('masterA', '/api/estoque/itens-disponiveis?limite=100')).body.filtros;
      assert.equal(filtros.tamanhos.includes(null), false, 'tamanho nulo não vira opção de filtro');

      assert.deepEqual(diferenca(antes, await indicadores('masterA')), { disponivel: 5, abaixo: 1, vencido: 0, aVencer: 0 });
      await postBaixa('masterA', lote.loteId, corpoBaixa({ quantidade: 5 }));
      assert.deepEqual(await itemDe('masterA', m, null), [3, 3, 0]);
    });

    test('material com tamanhos e material sem tamanho convivem nas mesmas leituras', async () => {
      const comTamanho = await novoMaterial(empresa.A);
      const semTamanho = await novoMaterial(empresa.A, { exigeTamanho: false });
      const antes = await indicadores('masterA');
      await entradaCriada('masterA', comTamanho.id, { tamanho: 'M', quantidade: 4 });
      await entradaCriada('masterA', comTamanho.id, { tamanho: 'G', quantidade: 2 });
      await entradaCriada('masterA', semTamanho.id, { tamanho: undefined, quantidade: 7 });
      assert.deepEqual((await lotesDe('masterA', comTamanho.id)).porTamanho.map((p) => [p.tamanho, p.disponivel]), [['G', 2], ['M', 4]]);
      assert.deepEqual([await itemDe('masterA', comTamanho, 'M'), await itemDe('masterA', semTamanho, null)], [[4, 0, 4], [7, 0, 7]]);
      assert.equal((await indicadores('masterA')).disponivel - antes.disponivel, 13);
    });
  });
});
