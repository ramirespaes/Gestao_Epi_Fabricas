'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Estrutura PostgreSQL da migration 023 (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3H): colunas pode_delegar/origem_id em usuario_autorizacoes, a
 * FK composta de correspondência de origem, e os dois índices únicos
 * parciais que substituem a UNIQUE antiga de 019.
 *
 * Testa exclusivamente estrutura de banco — nenhum repository, middleware
 * ou service foi alterado nesta subetapa; usuarioTemAutorizacaoIndividual
 * continua com o mesmo comportamento observável de sempre (só verifica
 * existência de linha), e nenhuma linha aqui produz efeito de autorização
 * diferente do que já produzia antes desta migration.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

const MIGRATIONS = ['000', '001', '002', '003', '005', '013', '019', '023'];

const ACAO_A = 'MOVIMENTAR_ESTOQUE';
const ACAO_B = 'REALIZAR_ENTREGA';

const inserirUsuario = async (cliente, empresaId, email, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', extra.perfil ?? 'MASTER'],
  );
  return rows[0].id;
};

/**
 * Executa um INSERT em usuario_autorizacoes e devolve { resultado, id }.
 * resultado é 'ok' ou o SQLSTATE do erro; id só existe quando resultado
 * é 'ok'.
 */
const criarAutorizacao = async (cliente, { empresaId, usuarioId, acaoCodigo, autorizadoPor, podeDelegar, origemId }) => {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por, pode_delegar, origem_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [empresaId, usuarioId, acaoCodigo, autorizadoPor, podeDelegar ?? false, origemId ?? null],
    );
    return { resultado: 'ok', id: rows[0].id };
  } catch (erro) {
    return { resultado: erro.code, id: null };
  }
};

describe('migration 023 — delegação em usuario_autorizacoes', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    masterA = await inserirUsuario(contexto.cliente, empresaA, 'master-a@demo.safeworkengenharia.com.br');
    masterB = await inserirUsuario(contexto.cliente, empresaB, 'master-b@demo.safeworkengenharia.com.br');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('pode_delegar nasce false quando não informado explicitamente', async () => {
    const usuario = await inserirUsuario(contexto.cliente, empresaA, 'nasce-false@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

    const { rows } = await contexto.cliente.query(
      `INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por)
       VALUES ($1, $2, $3, $4) RETURNING pode_delegar, origem_id`,
      [empresaA, usuario, ACAO_A, masterA],
    );

    assert.equal(rows[0].pode_delegar, false);
    assert.equal(rows[0].origem_id, null, 'origem_id também nasce NULL quando não informado');
  });

  test('autorização direta válida: origem_id NULL, com pode_delegar explícito true', async () => {
    const usuario = await inserirUsuario(contexto.cliente, empresaA, 'direta-valida@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

    const { resultado } = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuario, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });

    assert.equal(resultado, 'ok');
  });

  test('delegação com origem válida: beneficiário da origem == concedente da delegada, mesma empresa e ação', async () => {
    const carlos = await inserirUsuario(contexto.cliente, empresaA, 'carlos-delegador@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const joana = await inserirUsuario(contexto.cliente, empresaA, 'joana-delegada@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

    // Carlos recebe autorização direta do MASTER, com direito de delegar.
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: carlos, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem.resultado, 'ok');

    // Carlos delega para Joana: autorizado_por = Carlos (o beneficiário da origem).
    const delegada = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: joana, acaoCodigo: ACAO_A, autorizadoPor: carlos, origemId: origem.id,
    });

    assert.equal(delegada.resultado, 'ok');
  });

  test('rejeita origem inexistente', async () => {
    const usuario = await inserirUsuario(contexto.cliente, empresaA, 'origem-inexistente@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

    const { resultado } = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuario, acaoCodigo: ACAO_A, autorizadoPor: masterA, origemId: 9999999,
    });

    assert.equal(resultado, VIOLACAO_FK);
  });

  test('rejeita origem de outra empresa, mesmo com ação e correspondência de beneficiário/concedente corretas', async () => {
    const delegadorB = await inserirUsuario(contexto.cliente, empresaB, 'delegador-b@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origemB = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaB, usuarioId: delegadorB, acaoCodigo: ACAO_A, autorizadoPor: masterB, podeDelegar: true,
    });
    assert.equal(origemB.resultado, 'ok');

    // Tenta usar a origem de B para delegar dentro de A, forjando
    // autorizado_por = delegadorB mesmo ele sendo de outra empresa —
    // a FK composta exige empresa_id igual em ambos os lados.
    const usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'vitima-origem-outra-empresa@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const { resultado } = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, acaoCodigo: ACAO_A, autorizadoPor: delegadorB, origemId: origemB.id,
    });

    assert.equal(resultado, VIOLACAO_FK, 'origem de outra empresa deve ser rejeitada pela FK composta');
  });

  test('rejeita origem de outra ação', async () => {
    const delegador = await inserirUsuario(contexto.cliente, empresaA, 'delegador-acao-errada@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem.resultado, 'ok');

    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-acao-errada@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const { resultado } = await criarAutorizacao(contexto.cliente, {
      // origem concedeu ACAO_A; a linha delegada tenta usar ACAO_B com a mesma origem.
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_B, autorizadoPor: delegador, origemId: origem.id,
    });

    assert.equal(resultado, VIOLACAO_FK, 'origem concedida para uma ação não pode fundamentar delegação de outra ação');
  });

  test('rejeita origem cujo beneficiário não corresponde ao concedente da delegada', async () => {
    const beneficiarioOrigem = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-origem-real@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const outraPessoa = await inserirUsuario(contexto.cliente, empresaA, 'outra-pessoa-nao-e-a-origem@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiarioOrigem, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem.resultado, 'ok');

    const beneficiarioFinal = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-final-forjado@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const { resultado } = await criarAutorizacao(contexto.cliente, {
      // autorizado_por é outraPessoa, que NÃO é quem recebeu a origem.
      empresaId: empresaA, usuarioId: beneficiarioFinal, acaoCodigo: ACAO_A, autorizadoPor: outraPessoa, origemId: origem.id,
    });

    assert.equal(resultado, VIOLACAO_FK, 'só quem recebeu a autorização de origem pode aparecer como concedente da delegação dela');
  });

  test('rejeita duplicidade de autorização direta (mesmo usuário e ação, origem_id NULL nas duas)', async () => {
    const usuario = await inserirUsuario(contexto.cliente, empresaA, 'duplicidade-direta@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const primeira = await criarAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuario, acaoCodigo: ACAO_A, autorizadoPor: masterA });
    assert.equal(primeira.resultado, 'ok');

    const segunda = await criarAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuario, acaoCodigo: ACAO_A, autorizadoPor: masterA });

    assert.equal(segunda.resultado, VIOLACAO_UNIQUE, 'duas autorizações diretas para o mesmo usuário e ação são duplicidade indevida');
  });

  test('rejeita duplicidade de autorização delegada da MESMA origem para o mesmo usuário e ação', async () => {
    const delegador = await inserirUsuario(contexto.cliente, empresaA, 'delegador-dup@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem.resultado, 'ok');

    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-dup@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const primeira = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador, origemId: origem.id,
    });
    assert.equal(primeira.resultado, 'ok');

    const segunda = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador, origemId: origem.id,
    });

    assert.equal(segunda.resultado, VIOLACAO_UNIQUE, 'a mesma origem não pode delegar duas vezes para o mesmo usuário e ação');
  });

  test('origens independentes permitidas: duas delegações distintas para o mesmo usuário e ação coexistem', async () => {
    const delegador1 = await inserirUsuario(contexto.cliente, empresaA, 'delegador1-independente@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const delegador2 = await inserirUsuario(contexto.cliente, empresaA, 'delegador2-independente@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem1 = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador1, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    const origem2 = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador2, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem1.resultado, 'ok');
    assert.equal(origem2.resultado, 'ok');

    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-duas-origens@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const daOrigem1 = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador1, origemId: origem1.id,
    });
    const daOrigem2 = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador2, origemId: origem2.id,
    });

    assert.equal(daOrigem1.resultado, 'ok');
    assert.equal(daOrigem2.resultado, 'ok', 'origens independentes para o mesmo usuário e ação devem coexistir');

    const { rows } = await contexto.cliente.query(
      'SELECT count(*)::int AS total FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2',
      [beneficiario, ACAO_A],
    );
    assert.equal(rows[0].total, 2);
  });

  test('autorização direta coexiste com autorização delegada, para o mesmo usuário e ação', async () => {
    const delegador = await inserirUsuario(contexto.cliente, empresaA, 'delegador-coexiste@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    assert.equal(origem.resultado, 'ok');

    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-coexiste@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const direta = await criarAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: masterA });
    const delegada = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador, origemId: origem.id,
    });

    assert.equal(direta.resultado, 'ok');
    assert.equal(delegada.resultado, 'ok', 'uma autorização direta não pode impedir uma delegada para o mesmo usuário e ação, nem vice-versa');
  });

  test('excluir a origem revoga em cascata suas delegações descendentes, transitivamente', async () => {
    const raiz = await inserirUsuario(contexto.cliente, empresaA, 'raiz-cascata@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const filho = await inserirUsuario(contexto.cliente, empresaA, 'filho-cascata@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const neto = await inserirUsuario(contexto.cliente, empresaA, 'neto-cascata@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

    const origemRaiz = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: raiz, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    const delegadaFilho = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: filho, acaoCodigo: ACAO_A, autorizadoPor: raiz, origemId: origemRaiz.id, podeDelegar: true,
    });
    const delegadaNeto = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: neto, acaoCodigo: ACAO_A, autorizadoPor: filho, origemId: delegadaFilho.id,
    });
    assert.equal(origemRaiz.resultado, 'ok');
    assert.equal(delegadaFilho.resultado, 'ok');
    assert.equal(delegadaNeto.resultado, 'ok');

    await contexto.cliente.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [origemRaiz.id]);

    const { rows } = await contexto.cliente.query(
      'SELECT id FROM usuario_autorizacoes WHERE id = ANY($1::int[])',
      [[origemRaiz.id, delegadaFilho.id, delegadaNeto.id]],
    );
    assert.equal(rows.length, 0, 'excluir a raiz deve remover em cascata o filho e, transitivamente, o neto');
  });

  test('autorização independente permanece intacta quando uma origem não relacionada é excluída', async () => {
    const delegadorX = await inserirUsuario(contexto.cliente, empresaA, 'delegador-x-independente@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const delegadorY = await inserirUsuario(contexto.cliente, empresaA, 'delegador-y-independente@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origemX = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegadorX, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    const origemY = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegadorY, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });

    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-independente@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const direta = await criarAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: masterA });
    const daX = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegadorX, origemId: origemX.id,
    });
    const daY = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegadorY, origemId: origemY.id,
    });

    // Exclui só a origem X — a direta, e a delegação vinda de Y, precisam sobreviver.
    await contexto.cliente.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [origemX.id]);

    const { rows } = await contexto.cliente.query(
      'SELECT id FROM usuario_autorizacoes WHERE id = ANY($1::int[]) ORDER BY id',
      [[direta.id, daX.id, daY.id]],
    );
    assert.deepEqual(rows.map((r) => r.id).sort((a, b) => a - b), [direta.id, daY.id].sort((a, b) => a - b), 'só a linha vinda da origem excluída deve desaparecer');
  });

  test('alterar pode_delegar de true para false não apaga nem revoga delegações já concedidas', async () => {
    const delegador = await inserirUsuario(contexto.cliente, empresaA, 'delegador-toggle@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origem = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegador, acaoCodigo: ACAO_A, autorizadoPor: masterA, podeDelegar: true,
    });
    const beneficiario = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-toggle@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const delegada = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiario, acaoCodigo: ACAO_A, autorizadoPor: delegador, origemId: origem.id,
    });
    assert.equal(delegada.resultado, 'ok');

    await contexto.cliente.query('UPDATE usuario_autorizacoes SET pode_delegar = false WHERE id = $1', [origem.id]);

    const { rows } = await contexto.cliente.query('SELECT id, pode_delegar FROM usuario_autorizacoes WHERE id = $1', [delegada.id]);
    assert.equal(rows.length, 1, 'a delegação já concedida continua existindo depois de revogar o direito de delegar novas');
    assert.equal(rows[0].id, delegada.id);
  });

  test('isolamento multiempresa: origens e delegações de A não interferem com B, mesmo reaproveitando o mesmo código de ação', async () => {
    const delegadorA = await inserirUsuario(contexto.cliente, empresaA, 'delegador-isolamento-a@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const delegadorB = await inserirUsuario(contexto.cliente, empresaB, 'delegador-isolamento-b@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });
    const origemA = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: delegadorA, acaoCodigo: ACAO_B, autorizadoPor: masterA, podeDelegar: true,
    });
    const origemB = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaB, usuarioId: delegadorB, acaoCodigo: ACAO_B, autorizadoPor: masterB, podeDelegar: true,
    });
    assert.equal(origemA.resultado, 'ok');
    assert.equal(origemB.resultado, 'ok');

    const beneficiarioA = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-isolamento-a@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const beneficiarioB = await inserirUsuario(contexto.cliente, empresaB, 'beneficiario-isolamento-b@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    const delegadaA = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaA, usuarioId: beneficiarioA, acaoCodigo: ACAO_B, autorizadoPor: delegadorA, origemId: origemA.id,
    });
    const delegadaB = await criarAutorizacao(contexto.cliente, {
      empresaId: empresaB, usuarioId: beneficiarioB, acaoCodigo: ACAO_B, autorizadoPor: delegadorB, origemId: origemB.id,
    });
    assert.equal(delegadaA.resultado, 'ok');
    assert.equal(delegadaB.resultado, 'ok');

    // Excluir a origem de A não pode afetar a delegação de B.
    await contexto.cliente.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [origemA.id]);

    const { rows: deA } = await contexto.cliente.query('SELECT id FROM usuario_autorizacoes WHERE id = $1', [delegadaA.id]);
    const { rows: deB } = await contexto.cliente.query('SELECT id FROM usuario_autorizacoes WHERE id = $1', [delegadaB.id]);
    assert.equal(deA.length, 0, 'a delegação de A caiu em cascata com a exclusão da própria origem de A');
    assert.equal(deB.length, 1, 'a exclusão de uma origem em A não pode afetar nenhuma linha da empresa B');
  });
});

/**
 * Prova de compatibilidade explícita: autorizações individuais já
 * cadastradas com o formato de 019 (sem pode_delegar/origem_id) sobrevivem
 * intactas à aplicação da 023 — as duas colunas novas chegam com os
 * valores padrão (false/NULL), nunca reescrevendo nem reinterpretando o
 * que já existia. Mesmo padrão de robustez já provado para 020/022 em
 * grupos-acesso-schema.integration.js e
 * usuario-permissoes-recurso-schema.integration.js.
 */
describe('transição de um banco já populado antes da migration 023', () => {
  test('autorização individual inserida com as migrations anteriores sobrevive intacta à aplicação da 023, com pode_delegar=false e origem_id=NULL', async () => {
    // 1) Schema temporário só com as migrations anteriores a 023.
    const contexto = await abrirSchemaTemporario(['000', '001', '002', '003', '005', '013', '019']);
    try {
      // 2) Insere empresa, usuários e uma autorização individual no
      // formato que já existia antes de pode_delegar/origem_id serem
      // sequer cogitadas.
      assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa Preexistente'), 'ok');
      const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas WHERE cnpj = $1', ['11222333000181']);
      const empresaId = empresas[0].id;

      const masterId = await inserirUsuario(contexto.cliente, empresaId, 'master-preexistente@demo.safeworkengenharia.com.br');
      const beneficiarioId = await inserirUsuario(contexto.cliente, empresaId, 'joao-preexistente@demo.safeworkengenharia.com.br', { perfil: 'SUPERVISOR' });

      const { rows: autorizacaoInserida } = await contexto.cliente.query(
        `INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, motivo, autorizado_por)
         VALUES ($1, $2, $3, 'Motivo histórico preexistente', $4)
         RETURNING id, usuario_id, acao_codigo, motivo, autorizado_por, criado_em`,
        [empresaId, beneficiarioId, ACAO_A, masterId],
      );
      const autorizacaoId = autorizacaoInserida[0].id;

      // 3) Aplica o SQL real da migration 023 sobre esse schema já
      // populado. Falha aqui aborta o teste com o erro real do PostgreSQL.
      await contexto.cliente.query(conteudoDaMigration('023'));

      // 4) Consulta a mesma autorização depois da migration.
      const { rows: autorizacaoDepois } = await contexto.cliente.query(
        'SELECT id, usuario_id, acao_codigo, motivo, autorizado_por, criado_em, pode_delegar, origem_id FROM usuario_autorizacoes WHERE id = $1',
        [autorizacaoId],
      );

      // 5) Todos os dados anteriores preservados, e as colunas novas com
      // seus valores padrão.
      assert.equal(autorizacaoDepois.length, 1, 'a autorização preexistente deve continuar existindo após a migration');
      assert.equal(autorizacaoDepois[0].usuario_id, beneficiarioId);
      assert.equal(autorizacaoDepois[0].acao_codigo, ACAO_A);
      assert.equal(autorizacaoDepois[0].motivo, 'Motivo histórico preexistente');
      assert.equal(autorizacaoDepois[0].autorizado_por, masterId);
      assert.deepEqual(autorizacaoDepois[0].criado_em, autorizacaoInserida[0].criado_em, 'criado_em não pode ter sido alterado pela migration');
      assert.equal(autorizacaoDepois[0].pode_delegar, false, 'autorização preexistente nasce sem o direito de delegar');
      assert.equal(autorizacaoDepois[0].origem_id, null, 'autorização preexistente nasce sem nenhuma origem — sempre foi direta');

      // 6) A UNIQUE antiga de 019 não existe mais; o índice parcial novo
      // para autorizações diretas continua impedindo duplicidade — ON
      // CONFLICT DO NOTHING sem alvo captura qualquer unique/exclusion
      // violation da tabela, inclusive um índice único parcial, e
      // simplesmente devolve zero linhas em vez de lançar.
      const { rows: duplicidade } = await contexto.cliente.query(
        `INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [empresaId, beneficiarioId, ACAO_A, masterId],
      );
      assert.equal(duplicidade.length, 0, 'duplicidade direta continua rejeitada após a migration');
    } finally {
      await contexto.encerrar();
    }
  });
});
