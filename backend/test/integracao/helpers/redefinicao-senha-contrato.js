'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./schema-temporario');
const {
  VIOLACAO_FK, VIOLACAO_UNIQUE, VIOLACAO_CHECK, todasAsMigrations, erroDe, hashDeToken, inserirPedido,
  constraintsDe, indicesDe, gatilhosDe, colunasDe, tabelaExiste,
} = require('./recuperacao-senha');

/**
 * Contrato comum das duas tabelas de pedidos de redefinição de senha (061,
 * identidades; 062, administradores da plataforma). As duas têm o mesmo
 * desenho e precisam dar as mesmas garantias no banco: só o hash do token,
 * validade de no máximo 4 horas a partir de agora, uso único, um pedido
 * pendente por conta e linha encerrada ou expirada que nunca volta a valer.
 * PostgreSQL real, schema temporário com todas as migrations do diretório.
 */
function descreverTabelaDeRedefinicao({ titulo, prefixo, tabela, coluna, rotuloConta, tabelaConta, criarConta }) {
  describe(titulo, () => {
    let contexto;
    let c;
    let sequencia = 0;
    const alvo = { tabela, coluna };
    const GATILHO = `trg_${tabela}_proteger_linha`;
    const novaConta = () => criarConta(c, `pessoa${sequencia += 1}@example.invalid`);
    const pedido = async (opcoes) => inserirPedido(c, alvo, await novaConta(), opcoes);
    const atualizar = (id, atribuicoes, params = []) => erroDe(c.query(`UPDATE ${tabela} SET ${atribuicoes} WHERE id = $1`, [id, ...params]));
    const linha = async (id) => (await c.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0];
    const recusaDoGatilho = (erro, mensagem) => {
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, GATILHO], mensagem);
    };

    before(async () => {
      contexto = await abrirSchemaTemporario(todasAsMigrations());
      c = contexto.cliente;
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    test('a migration existe e cria a tabela com colunas, constraints, índices e gatilho esperados; nenhum token em claro', async () => {
      assert.equal(migrationExiste(prefixo), true, `arquivo da migration ${prefixo}`);
      assert.equal(await tabelaExiste(c, tabela), true, `tabela ${tabela}`);
      assert.deepEqual(await colunasDe(c, contexto.schema, tabela), [
        'id', coluna, 'token_hash', 'criado_em', 'expira_em', 'usado_em', 'cancelado_em', 'motivo_cancelamento', 'ip', 'dispositivo',
      ]);
      assert.deepEqual((await constraintsDe(c, contexto.schema, tabela)).sort(), [
        `chk_${tabela}_cancelamento_coerente`,
        `chk_${tabela}_desfecho_apos_criacao`,
        `chk_${tabela}_desfecho_unico`,
        `chk_${tabela}_motivo_formato`,
        `chk_${tabela}_token_hash_formato`,
        `chk_${tabela}_uso_dentro_da_validade`,
        `chk_${tabela}_validade`,
        `${tabela}_${coluna}_fkey`,
        `${tabela}_pkey`,
        `uq_${tabela}_token_hash`,
      ].sort());
      assert.deepEqual((await indicesDe(c, contexto.schema, tabela)).sort(), [
        `idx_${tabela}_${coluna}`,
        `idx_${tabela}_expira_em`,
        `${tabela}_pkey`,
        `uq_${tabela}_${rotuloConta}_pendente`,
        `uq_${tabela}_token_hash`,
      ].sort());
      assert.deepEqual(await gatilhosDe(c, contexto.schema, tabela), [GATILHO]);
      const sql = conteudoDaMigration(prefixo).replace(/--.*$/gm, '');
      assert.doesNotMatch(sql, /\btoken\b(?!_hash)/i, 'só token_hash: o token em claro nunca é coluna');
    });

    test('pedido nasce pendente; validade de 60 minutos e o teto exato de 4 horas são aceitos', async () => {
      const padrao = await pedido({ validadeMinutos: 60 });
      assert.deepEqual([padrao.usado_em, padrao.cancelado_em, padrao.motivo_cancelamento], [null, null, null]);
      assert.equal(padrao.expira_em.getTime() - padrao.criado_em.getTime(), 60 * 60 * 1000);
      const noTeto = await pedido({ validadeMinutos: 240 });
      assert.equal(noTeto.expira_em.getTime() - noTeto.criado_em.getTime(), 4 * 60 * 60 * 1000);
    });

    test('validade acima de 4 horas, nula ou negativa é recusada pelo banco', async () => {
      const acima = await erroDe(pedido({ validadeMinutos: 241 }));
      assert.deepEqual([acima?.code, acima?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_validade`]);
      const umSegundoAcima = await erroDe(c.query(
        `INSERT INTO ${tabela} (${coluna}, token_hash, expira_em) VALUES ($1, $2, now() + interval '4 hours 1 second')`,
        [await novaConta(), hashDeToken()],
      ));
      assert.deepEqual([umSegundoAcima?.code, umSegundoAcima?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_validade`]);
      for (const validadeMinutos of [0, -5]) {
        const erro = await erroDe(pedido({ validadeMinutos }));
        assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_validade`], String(validadeMinutos));
      }
    });

    test('o teto vale a partir de agora: criado_em no futuro é recusado; pedido não nasce usado nem cancelado', async () => {
      const futuro = await erroDe(c.query(
        `INSERT INTO ${tabela} (${coluna}, token_hash, criado_em, expira_em) VALUES ($1, $2, now() + interval '1 year', now() + interval '1 year 1 hour')`,
        [await novaConta(), hashDeToken()],
      ));
      recusaDoGatilho(futuro, 'criado_em futuro esticaria a validade real para além de 4 horas');
      const nasceUsado = await erroDe(pedido({ extra: { usado_em: new Date() } }));
      recusaDoGatilho(nasceUsado, 'nasce usado');
      const nasceCancelado = await erroDe(pedido({ extra: { cancelado_em: new Date(), motivo_cancelamento: 'SUBSTITUIDA' } }));
      recusaDoGatilho(nasceCancelado, 'nasce cancelado');
    });

    test('token_hash: só SHA-256 em hexadecimal minúsculo, obrigatório e único', async () => {
      for (const tokenHash of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, 'x'.repeat(64)]) {
        const erro = await erroDe(pedido({ tokenHash }));
        assert.equal(erro?.code === VIOLACAO_CHECK || erro?.code === '22001', true, tokenHash);
      }
      const formato = await erroDe(pedido({ tokenHash: 'A'.repeat(64) }));
      assert.deepEqual([formato?.code, formato?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_token_hash_formato`]);
      const tokenHash = hashDeToken();
      await pedido({ tokenHash });
      const repetido = await erroDe(pedido({ tokenHash }));
      assert.deepEqual([repetido?.code, repetido?.constraint], [VIOLACAO_UNIQUE, `uq_${tabela}_token_hash`]);
    });

    test('um pedido pendente por conta: o segundo é recusado; cancelar ou usar o anterior libera o próximo', async () => {
      const conta = await novaConta();
      const primeiro = await inserirPedido(c, alvo, conta);
      const segundo = await erroDe(inserirPedido(c, alvo, conta));
      assert.deepEqual([segundo?.code, segundo?.constraint], [VIOLACAO_UNIQUE, `uq_${tabela}_${rotuloConta}_pendente`]);

      assert.equal(await atualizar(primeiro.id, "cancelado_em = now(), motivo_cancelamento = 'SUBSTITUIDA'"), null);
      const terceiro = await inserirPedido(c, alvo, conta);
      assert.equal(await atualizar(terceiro.id, 'usado_em = now()'), null);
      const quarto = await inserirPedido(c, alvo, conta);
      assert.equal((await linha(quarto.id)).usado_em, null);

      const outraConta = await inserirPedido(c, alvo, await novaConta());
      assert.notEqual(outraConta.id, quarto.id, 'o limite é por conta, não global');
    });

    test('desfecho único e coerente: nunca usado e cancelado ao mesmo tempo; cancelamento sempre com motivo no formato', async () => {
      const p = await pedido();
      const osDois = await atualizar(p.id, "usado_em = now(), cancelado_em = now(), motivo_cancelamento = 'SUBSTITUIDA'");
      assert.deepEqual([osDois?.code, osDois?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_desfecho_unico`]);
      const semMotivo = await atualizar(p.id, 'cancelado_em = now()');
      assert.deepEqual([semMotivo?.code, semMotivo?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_cancelamento_coerente`]);
      const soMotivo = await atualizar(p.id, "motivo_cancelamento = 'SUBSTITUIDA'");
      assert.deepEqual([soMotivo?.code, soMotivo?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_cancelamento_coerente`]);
      const motivoRuim = await atualizar(p.id, "cancelado_em = now(), motivo_cancelamento = 'substituida'");
      assert.deepEqual([motivoRuim?.code, motivoRuim?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_motivo_formato`]);
      const antesDeCriar = await atualizar(p.id, "usado_em = criado_em - interval '1 second'");
      assert.deepEqual([antesDeCriar?.code, antesDeCriar?.constraint], [VIOLACAO_CHECK, `chk_${tabela}_desfecho_apos_criacao`]);
      const p2 = await linha(p.id);
      assert.deepEqual([p2.usado_em, p2.cancelado_em], [null, null], 'nenhuma tentativa recusada alterou a linha');
    });

    test('uso único: pedido usado não volta a pendente, não é cancelado nem usado de novo', async () => {
      const p = await pedido();
      assert.equal(await atualizar(p.id, 'usado_em = now()'), null);
      const usado = await linha(p.id);
      recusaDoGatilho(await atualizar(p.id, 'usado_em = NULL'), 'voltar a pendente');
      recusaDoGatilho(await atualizar(p.id, 'usado_em = now()'), 'usar de novo');
      recusaDoGatilho(await atualizar(p.id, "cancelado_em = now(), motivo_cancelamento = 'SUBSTITUIDA', usado_em = NULL"), 'trocar o desfecho');
      assert.deepEqual(await linha(p.id), usado, 'linha usada permanece idêntica');
    });

    test('pedido cancelado não pode ser usado nem reaberto', async () => {
      const p = await pedido();
      assert.equal(await atualizar(p.id, "cancelado_em = now(), motivo_cancelamento = 'SUBSTITUIDA'"), null);
      const cancelado = await linha(p.id);
      recusaDoGatilho(await atualizar(p.id, 'usado_em = now()'), 'usar cancelado');
      recusaDoGatilho(await atualizar(p.id, 'cancelado_em = NULL, motivo_cancelamento = NULL'), 'reabrir');
      recusaDoGatilho(await atualizar(p.id, "motivo_cancelamento = 'OUTRO_MOTIVO'"), 'reescrever o motivo');
      assert.deepEqual(await linha(p.id), cancelado);
    });

    test('pedido expirado não pode ser usado nem estendido; cancelar continua possível', async () => {
      const p = await pedido({ criadoHaMinutos: 120, validadeMinutos: 60 });
      const usar = await atualizar(p.id, 'usado_em = now()');
      recusaDoGatilho(usar, 'usar expirado');
      assert.match(usar.message, /expirad/i);
      recusaDoGatilho(await atualizar(p.id, "usado_em = expira_em - interval '1 minute'"), 'retrodatar o uso de um pedido expirado');
      recusaDoGatilho(await atualizar(p.id, "expira_em = now() + interval '1 hour'"), 'estender');
      assert.equal(await atualizar(p.id, "cancelado_em = now(), motivo_cancelamento = 'EXPIRADA'"), null);
    });

    test('só o desfecho muda: token_hash, validade, conta, criação e origem do pedido são imutáveis', async () => {
      const p = await pedido();
      const outraConta = await novaConta();
      recusaDoGatilho(await atualizar(p.id, 'token_hash = $2', [hashDeToken()]), 'token_hash');
      recusaDoGatilho(await atualizar(p.id, "expira_em = expira_em + interval '1 minute'"), 'expira_em');
      recusaDoGatilho(await atualizar(p.id, "criado_em = criado_em - interval '1 minute'"), 'criado_em');
      recusaDoGatilho(await atualizar(p.id, `${coluna} = $2`, [outraConta]), 'conta');
      recusaDoGatilho(await atualizar(p.id, "ip = '203.0.113.9'"), 'ip');
      assert.deepEqual(await linha(p.id), p);
    });

    test('conta inexistente é recusada pela FK; conta com pedido não pode ser apagada', async () => {
      const inexistente = await erroDe(inserirPedido(c, alvo, 999999));
      assert.deepEqual([inexistente?.code, inexistente?.constraint], [VIOLACAO_FK, `${tabela}_${coluna}_fkey`]);
      const conta = await novaConta();
      await inserirPedido(c, alvo, conta);
      const apagar = await erroDe(c.query(`DELETE FROM ${tabelaConta} WHERE id = $1`, [conta]));
      assert.deepEqual([apagar?.code, apagar?.constraint], [VIOLACAO_FK, `${tabela}_${coluna}_fkey`]);
    });
  });
}

module.exports = { descreverTabelaDeRedefinicao };
