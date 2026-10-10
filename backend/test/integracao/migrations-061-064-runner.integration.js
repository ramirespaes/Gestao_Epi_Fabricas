'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { aplicarMigrations } = require('../../scripts/migrate');
const { criarIdentidade, criarAdministrador, inserirPedido, hashDeToken, tabelaExiste } = require('./helpers/recuperacao-senha');

/**
 * 061 a 068 pelo runner real, sobre um banco que já está na 060 com
 * identidade, administrador e sessões gravados. É o caminho de todo banco
 * existente: as pendentes entram numa transação só e não tocam em senha,
 * sessão nem MFA. Monto a estrutura até a 060 pelo mesmo runner, a partir de
 * um diretório temporário com cópias dos arquivos reais. PostgreSQL real,
 * schema temporário; nenhum banco persistente é tocado.
 */

const DIRETORIO_REAL = path.join(__dirname, '..', '..', 'migrations');
const ATE_A_060 = /^0(?:[0-5]\d|60)_.+\.sql$/;
const PENDENTES = [
  '061_create_redefinicoes_senha',
  '062_create_redefinicoes_senha_plataforma',
  '063_create_recuperacao_senha_solicitacoes',
  '064_create_logs_auditoria_identidade',
  '065_create_solicitacoes_epi',
  '066_alter_entregas_epi_origem_solicitacao',
  '067_create_estoque_minimos',
  '068_alter_solicitacoes_epi_add_encerramento',
  '069_create_alertas_estoque',
  '070_create_material_tamanhos',
  '071_alter_materiais_add_tipo_descricao_e_tipos_oculos',
  '072_alter_identidades_add_telefone_tema_modo_visual',
  '073_alter_usuarios_add_funcionario_id',
  '074_alter_identidades_add_senha_provisoria',
  '075_alter_identidades_add_cpf',
  '076_alter_usuarios_add_matricula_setor_horario',
  '077_create_usuario_ips_permitidos',
  '078_insert_acoes_estoque_entrada_baixa',
  '079_alter_logs_auditoria_add_perfil_ator',
  '080_create_fiscalizacao_pacotes',
  '081_alter_matricula_opcional',
  '082_create_tipos_material_classificacao_v2',
  '083_alter_ghe_add_codigo_create_ghe_tipos_material',
  '084_alter_funcionarios_add_situacao',
];
const TABELAS_NOVAS = ['redefinicoes_senha', 'redefinicoes_senha_plataforma', 'recuperacao_senha_solicitacoes', 'logs_auditoria_identidade'];
const TOTAL = 85;

describe('runner real: 061 a 074 numa transação, sobre a 060 com contas e sessões existentes', () => {
  let contexto;
  let c;
  let diretorioAteA060;
  const d = {};
  let antes;

  const q = (sql, params) => c.query(sql, params);
  const registradas = async () => (await q('SELECT name, run_on FROM pgmigrations ORDER BY id')).rows;
  const fotografia = async () => ({
    identidades: (await q('SELECT id, email, senha_hash, ativo, atualizado_em FROM identidades ORDER BY id')).rows,
    administradores: (await q('SELECT id, email, senha_hash, ativo, atualizado_em FROM administradores_plataforma ORDER BY id')).rows,
    sessoesGlobais: (await q('SELECT id, identidade_id, token_hash, revogada_em, motivo_revogacao FROM sessoes_globais ORDER BY id')).rows,
  });

  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    c = contexto.cliente;
    diretorioAteA060 = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-migrations-'));
    for (const nome of fs.readdirSync(DIRETORIO_REAL).filter((arquivo) => ATE_A_060.test(arquivo))) {
      fs.copyFileSync(path.join(DIRETORIO_REAL, nome), path.join(diretorioAteA060, nome));
    }
    await aplicarMigrations({ schema: contexto.schema, diretorio: diretorioAteA060 });

    d.identidade = await criarIdentidade(c, 'pessoa@example.invalid');
    d.administrador = await criarAdministrador(c, 'admin@example.invalid');
    await q(
      "INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '1 hour')",
      [d.identidade, hashDeToken()],
    );
    antes = await fotografia();
  });

  after(async () => {
    if (diretorioAteA060) fs.rmSync(diretorioAteA060, { recursive: true, force: true });
    if (contexto) await contexto.encerrar();
  });

  test('ponto de partida: 000 a 060 aplicadas e nenhuma tabela do ciclo de senha ainda', async () => {
    const nomes = (await registradas()).map((linha) => linha.name);
    assert.equal(nomes.length, 61);
    assert.equal(nomes.at(-1), '060_create_entregas_epi_confirmacoes');
    for (const tabela of TABELAS_NOVAS) assert.equal(await tabelaExiste(c, tabela), false, tabela);
  });

  test('o runner aplica 061 a 084 juntas, em ordem, e registra as 85', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.deepEqual(aplicadas.map((migration) => migration.name), PENDENTES);
    const linhas = await registradas();
    assert.equal(linhas.length, TOTAL);
    assert.deepEqual(linhas.slice(-PENDENTES.length).map((linha) => linha.name), PENDENTES);
    for (const tabela of TABELAS_NOVAS) assert.equal(await tabelaExiste(c, tabela), true, tabela);
  });

  // run_on é o NOW() da transação. Comparo no banco, em microssegundos.
  test('as pendentes entraram numa transação só, separada da que aplicou até a 060', async () => {
    const { rows } = await q(
      `SELECT count(DISTINCT run_on) FILTER (WHERE name = ANY($1))::int AS instantes,
              count(*) FILTER (WHERE name = ANY($1))::int AS pendentes,
              bool_and(run_on <> (SELECT run_on FROM pgmigrations WHERE name LIKE '060\\_%'))
                FILTER (WHERE name = ANY($1)) AS depois_da_060
         FROM pgmigrations`,
      [PENDENTES],
    );
    assert.deepEqual(rows[0], { instantes: 1, pendentes: PENDENTES.length, depois_da_060: true });
  });

  test('contas e sessões existentes não mudaram: nenhuma senha, sessão ou linha de MFA foi tocada', async () => {
    assert.deepEqual(await fotografia(), antes);
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM fatores_mfa_plataforma');
    assert.equal(n, 0);
  });

  test('o banco migrado aceita o primeiro pedido de cada namespace, a solicitação e a trilha da identidade', async () => {
    const pedido = await inserirPedido(c, { tabela: 'redefinicoes_senha', coluna: 'identidade_id' }, d.identidade);
    const pedidoAdmin = await inserirPedido(c, { tabela: 'redefinicoes_senha_plataforma', coluna: 'administrador_id' }, d.administrador);
    assert.deepEqual([pedido.usado_em, pedidoAdmin.usado_em], [null, null]);
    await q("INSERT INTO recuperacao_senha_solicitacoes (escopo, chave) VALUES ('PORTAL', $1)", [hashDeToken()]);
    await q("INSERT INTO logs_auditoria_identidade (identidade_id, ator_tipo, acao) VALUES ($1, 'SISTEMA', 'REDEFINICAO_SOLICITADA')", [d.identidade]);
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM logs_auditoria_identidade');
    assert.equal(n, 1);
  });

  test('manifesto: as entradas pendentes conferem com os arquivos e o total é 85', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO_REAL, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO_REAL).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, TOTAL);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of PENDENTES) {
      const arquivo = `${nome}.sql`;
      assert.equal(fs.existsSync(path.join(DIRETORIO_REAL, arquivo)), true, arquivo);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO_REAL, arquivo))).digest('hex');
      assert.equal(manifesto.migrations[arquivo], sha, arquivo);
    }
  });
});
