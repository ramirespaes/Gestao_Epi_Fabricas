'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 025 — identidade global de autenticação (Autenticação Global,
 * Subetapa 1, 23/09/2026). PostgreSQL real, schema temporário exclusivo por
 * teste, conforme o contrato da seção 11 do CLAUDE.md. Nenhuma migration
 * histórica (000-024) é tocada; nenhuma aplicação ao schema `public`.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_NOT_NULL = '23502';

const MIGRATIONS_COMPLETAS = [
  '000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025',
];

async function inserirIdentidade(cliente, email, senhaHash = 'hash-ficticio-de-teste') {
  try {
    const { rows } = await cliente.query(
      'INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id',
      [email, senhaHash],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

/**
 * `comColunaIdentidade: false` insere sem citar a coluna `identidade_id` —
 * necessário nos schemas que ainda não aplicaram a migration 025 (a coluna
 * nem existe ali), sem forçar todo teste do "estado anterior" a duplicar o
 * INSERT inteiro só por isso.
 */
async function inserirUsuario(cliente, { empresaId, nome = 'Fulano', email, senhaHash, perfil = 'USUARIO', identidadeId = null, comColunaIdentidade = true }) {
  try {
    const { rows } = comColunaIdentidade
      ? await cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [empresaId, nome, email ?? null, senhaHash ?? null, perfil, identidadeId],
      )
      : await cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [empresaId, nome, email ?? null, senhaHash ?? null, perfil],
      );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('estado anterior: migrations 000-024 (documenta o contrato antigo)', () => {
  let contexto;
  let empresaId;

  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '001', '002', '005']);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    empresaId = rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('a tabela identidades ainda não existe', async () => {
    const { rows } = await contexto.cliente.query("SELECT to_regclass('identidades') AS existe");
    assert.equal(rows[0].existe, null);
  });

  test('usuarios.email e usuarios.senha_hash ainda são obrigatórios', async () => {
    const semEmail = await inserirUsuario(contexto.cliente, { empresaId, senhaHash: 'x', email: null, comColunaIdentidade: false });
    assert.equal(semEmail.ok, false);
    assert.equal(semEmail.code, VIOLACAO_NOT_NULL);

    const semSenha = await inserirUsuario(contexto.cliente, { empresaId, email: 'a@x.com', senhaHash: null, comColunaIdentidade: false });
    assert.equal(semSenha.ok, false);
    assert.equal(semSenha.code, VIOLACAO_NOT_NULL);
  });

  test('usuarios.identidade_id ainda não existe', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'usuarios' AND column_name = 'identidade_id'",
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
  });
});

describe('estado corrigido: migrations 000-025 — identidades', () => {
  let contexto;
  let empresaA;
  let empresaB;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_COMPLETAS);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '44555666000162', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '11222333000181').id;
    empresaB = rows.find((e) => e.cnpj === '44555666000162').id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria identidade com sucesso', async () => {
    const r = await inserirIdentidade(contexto.cliente, 'pessoa1@safework.com.br');
    assert.equal(r.ok, true);
  });

  test('unicidade global do e-mail, sem diferenciar maiúsculas de minúsculas', async () => {
    assert.equal((await inserirIdentidade(contexto.cliente, 'unica@safework.com.br')).ok, true);
    const repetida = await inserirIdentidade(contexto.cliente, 'unica@safework.com.br');
    assert.equal(repetida.ok, false);
    assert.equal(repetida.code, VIOLACAO_UNIQUE);
    const outraCaixa = await inserirIdentidade(contexto.cliente, 'UNICA@SafeWork.com.br');
    assert.equal(outraCaixa.ok, false);
    assert.equal(outraCaixa.code, VIOLACAO_UNIQUE, 'unica@ e UNICA@ (outra caixa) contam como o mesmo e-mail');
  });

  test('vínculo de uma identidade com empresas A e B: permitido, duas contas, mesma identidade', async () => {
    const identidade = await inserirIdentidade(contexto.cliente, 'multiempresa@safework.com.br');
    assert.equal(identidade.ok, true);

    const contaA = await inserirUsuario(contexto.cliente, { empresaId: empresaA, identidadeId: identidade.id, perfil: 'MASTER' });
    const contaB = await inserirUsuario(contexto.cliente, { empresaId: empresaB, identidadeId: identidade.id, perfil: 'SUPERVISOR' });
    assert.equal(contaA.ok, true);
    assert.equal(contaB.ok, true);
    assert.notEqual(contaA.id, contaB.id);

    const { rows } = await contexto.cliente.query(
      'SELECT empresa_id, perfil FROM usuarios WHERE identidade_id = $1 ORDER BY empresa_id',
      [identidade.id],
    );
    assert.deepEqual(rows.map((l) => l.empresa_id).sort((x, y) => x - y), [empresaA, empresaB].sort((x, y) => x - y));
  });

  test('impossibilidade de vínculo duplicado na mesma empresa', async () => {
    const identidade = await inserirIdentidade(contexto.cliente, 'duplicavel@safework.com.br');
    assert.equal(identidade.ok, true);

    const primeira = await inserirUsuario(contexto.cliente, { empresaId: empresaA, identidadeId: identidade.id });
    assert.equal(primeira.ok, true);

    const segunda = await inserirUsuario(contexto.cliente, { empresaId: empresaA, identidadeId: identidade.id, nome: 'Outro Nome' });
    assert.equal(segunda.ok, false);
    assert.equal(segunda.code, VIOLACAO_UNIQUE, 'a mesma identidade não pode ter dois vínculos na mesma empresa');
  });

  test('contas do modelo novo não duplicam credencial em usuarios: email e senha_hash gravados como NULL, nunca copiados ou fictícios', async () => {
    const identidade = await inserirIdentidade(contexto.cliente, 'semduplicidade@safework.com.br', 'hash-real-da-identidade');
    assert.equal(identidade.ok, true);

    const conta = await inserirUsuario(contexto.cliente, { empresaId: empresaA, identidadeId: identidade.id, email: null, senhaHash: null });
    assert.equal(conta.ok, true);

    const { rows } = await contexto.cliente.query('SELECT email, senha_hash, identidade_id FROM usuarios WHERE id = $1', [conta.id]);
    assert.equal(rows[0].email, null, 'usuarios.email não deve ser preenchido para conta do modelo novo');
    assert.equal(rows[0].senha_hash, null, 'usuarios.senha_hash não deve ser preenchido para conta do modelo novo');
    assert.equal(rows[0].identidade_id, identidade.id);
  });

  test('contas históricas (identidade_id NULL) continuam funcionando exatamente como antes', async () => {
    const conta = await inserirUsuario(contexto.cliente, { empresaId: empresaA, email: 'legado@safework.com.br', senhaHash: 'hash-legado', identidadeId: null });
    assert.equal(conta.ok, true);
    const { rows } = await contexto.cliente.query('SELECT identidade_id, email, senha_hash FROM usuarios WHERE id = $1', [conta.id]);
    assert.deepEqual(rows[0], { identidade_id: null, email: 'legado@safework.com.br', senha_hash: 'hash-legado' });
  });

  test('sem identidade nenhuma, o índice parcial não impede duas contas legadas na mesma empresa', async () => {
    const c1 = await inserirUsuario(contexto.cliente, { empresaId: empresaA, email: 'legado1@safework.com.br', senhaHash: 'h1' });
    const c2 = await inserirUsuario(contexto.cliente, { empresaId: empresaA, email: 'legado2@safework.com.br', senhaHash: 'h2' });
    assert.equal(c1.ok, true);
    assert.equal(c2.ok, true);
  });

  test('identidade inexistente é recusada pela FK', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId: empresaA, identidadeId: 999999 });
    assert.equal(r.ok, false);
    assert.equal(r.code, '23503');
  });

  // Nota: a possibilidade de uma conta identidade_id NULO ficar sem NENHUMA
  // credencial (email e senha_hash também nulos) — algo que só a migration
  // 025 sozinha permitiria — é fechada pela CHECK da migration 026
  // (chk_usuarios_credencial_por_modelo). Os cenários dessa constraint são
  // testados em migration-026-check-credencial.integration.js, não aqui:
  // este arquivo testa exclusivamente o que a 025, isoladamente, declara.
});

describe('preservação de usuarios.id, empresa_id, perfil, grupo_acesso_id e das FKs existentes', () => {
  let contexto;
  let empresaId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_COMPLETAS);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    empresaId = rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('usuarios.id, empresa_id, perfil e grupo_acesso_id preservados na mesma forma', async () => {
    const colunas = await contexto.cliente.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'usuarios'
          AND column_name IN ('id', 'empresa_id', 'perfil', 'grupo_acesso_id')
        ORDER BY column_name`,
      [contexto.schema],
    );
    const porNome = Object.fromEntries(colunas.rows.map((l) => [l.column_name, l]));
    assert.equal(porNome.id.is_nullable, 'NO');
    assert.equal(porNome.empresa_id.is_nullable, 'NO');
    assert.equal(porNome.perfil.is_nullable, 'NO');
    assert.equal(porNome.grupo_acesso_id.is_nullable, 'YES', 'grupo_acesso_id já era opcional desde a migration 020 — não mudou');
  });

  test('FKs de usuarios preservadas: PK, perfil->perfis, grupo_acesso composta, e a nova identidade_id somada, não substituída', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.usuarios')::regclass ORDER BY conname",
      [contexto.schema],
    );
    const nomes = rows.map((l) => l.conname);
    assert.ok(nomes.includes('usuarios_pkey'), 'chave primária preservada');
    assert.ok(nomes.includes('usuarios_perfil_fkey') || nomes.some((n) => n.includes('perfil')), 'FK de perfil preservada');
    assert.ok(nomes.includes('fk_usuarios_grupo_mesma_empresa'), 'FK composta de grupo_acesso_id (020) preservada, intocada');
    assert.ok(nomes.includes('usuarios_identidade_id_fkey') || nomes.some((n) => n.includes('identidade')), 'FK nova de identidade_id presente, somada às demais');
  });

  test('RBAC continua funcionando sem nenhuma dependência de identidade_id: usuario_bloqueios aceita o mesmo usuario de sempre', async () => {
    const usuario = await inserirUsuario(contexto.cliente, { empresaId, email: 'rbac@safework.com.br', senhaHash: 'h' });
    assert.equal(usuario.ok, true);
    await contexto.cliente.query('INSERT INTO acoes (codigo, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['ACAO_TESTE_025', 'Ação de teste']);
    const { rows } = await contexto.cliente.query(
      'INSERT INTO usuario_bloqueios (usuario_id, acao_codigo) VALUES ($1, $2) RETURNING id',
      [usuario.id, 'ACAO_TESTE_025'],
    );
    assert.equal(rows.length, 1);
  });

  test('sessão empresarial (013) continua com a mesma FK composta (empresa_id, usuario_id): mistura de empresas é recusada', async () => {
    const outra = await inserirEmpresa(contexto.cliente, '77888999000110', 'Empresa C');
    assert.equal(outra, 'ok');
    const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas ORDER BY id');
    const empresaC = empresas[empresas.length - 1].id;

    const usuario = await inserirUsuario(contexto.cliente, { empresaId, email: 'sessao@safework.com.br', senhaHash: 'h' });
    assert.equal(usuario.ok, true);

    await assert.rejects(
      () => contexto.cliente.query(
        `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via)
         VALUES ($1, $2, $3, now() + interval '1 hour', 'SENHA')`,
        [empresaC, usuario.id, 'a'.repeat(64)],
      ),
      (erro) => erro.code === '23503',
      'usuario pertence à empresa A, não à C — a FK composta (013) deve continuar recusando',
    );

    const { rows } = await contexto.cliente.query(
      `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via)
       VALUES ($1, $2, $3, now() + interval '1 hour', 'SENHA') RETURNING id`,
      [empresaId, usuario.id, 'b'.repeat(64)],
    );
    assert.equal(rows.length, 1, 'a combinação correta continua sendo aceita, exatamente como antes');
  });
});

describe('transição de um banco já populado (contas históricas sobrevivem)', () => {
  test('linha de usuarios criada antes da migration 025 sobrevive intacta, e ganha identidade_id NULL', async () => {
    const contexto = await abrirSchemaTemporario(['000', '001', '002', '005']);
    try {
      assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa Preexistente'), 'ok');
      const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
      const empresaId = empresas[0].id;

      const antiga = await inserirUsuario(contexto.cliente, { empresaId, email: 'preexistente@safework.com.br', senhaHash: 'hash-preexistente', perfil: 'MASTER', comColunaIdentidade: false });
      assert.equal(antiga.ok, true);

      // Falha aqui aborta o teste com o erro real do PostgreSQL: executar sem
      // lançar já é a confirmação de que a migration roda sobre dados vivos.
      await contexto.cliente.query(conteudoDaMigration('025'));

      const { rows } = await contexto.cliente.query(
        'SELECT id, empresa_id, email, senha_hash, perfil, identidade_id FROM usuarios WHERE id = $1',
        [antiga.id],
      );
      assert.equal(rows.length, 1, 'a linha continua existindo depois da migration');
      assert.equal(rows[0].empresa_id, empresaId);
      assert.equal(rows[0].email, 'preexistente@safework.com.br', 'e-mail histórico não foi apagado nem alterado');
      assert.equal(rows[0].senha_hash, 'hash-preexistente', 'hash histórico não foi apagado nem alterado');
      assert.equal(rows[0].perfil, 'MASTER');
      assert.equal(rows[0].identidade_id, null, 'nenhuma migração automática por e-mail: identidade_id nasce NULL');
    } finally {
      await contexto.encerrar();
    }
  });
});

describe('estrutura declarada na migration 025 (sem banco)', () => {
  test('a migration 025 existe e declara exatamente o que foi pedido', () => {
    assert.equal(migrationExiste('025'), true, 'migrations/025_*.sql deve existir');
    const sql = conteudoDaMigration('025');
    assert.match(sql, /CREATE TABLE identidades/i);
    assert.match(sql, /CREATE UNIQUE INDEX uq_identidades_email_lower ON identidades \(lower\(email\)\)/i);
    assert.match(sql, /ALTER TABLE usuarios ADD COLUMN identidade_id/i);
    assert.match(sql, /REFERENCES identidades\(id\)/i);
    assert.match(sql, /ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL/i);
    assert.match(sql, /ALTER TABLE usuarios ALTER COLUMN senha_hash DROP NOT NULL/i);
    assert.match(sql, /CREATE UNIQUE INDEX uq_usuarios_empresa_identidade[\s\S]*WHERE identidade_id IS NOT NULL/i);
    assert.doesNotMatch(sql, /UPDATE usuarios/i, 'nenhuma migração automática de contas históricas por esta migration');
  });
});
