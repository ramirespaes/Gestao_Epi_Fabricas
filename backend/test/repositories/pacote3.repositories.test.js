'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const identidadeRepo = require('../../src/repositories/identidade.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const empresaRepo = require('../../src/repositories/empresa.repository');
const conviteRepo = require('../../src/repositories/convite-master.repository');
const tentativaRepo = require('../../src/repositories/convite-master-tentativa.repository');

/**
 * Contratos dos repositórios novos/ampliados do Pacote 3, sem PostgreSQL:
 * validação antes de consultar, SQL parametrizado, projeções sem
 * credencial, condições de estado dentro das próprias consultas. O
 * comportamento real está em empresa-cadastro-convite-master.integration.js.
 */

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: rowCount ?? linhas.length }; } };
};
const HASH = 'a'.repeat(64);

describe('identidade.repository', () => {
  test('criar grava e-mail e hash parametrizados; buscarPorEmail não projeta senha_hash; buscarCredencialPorEmail é a única que projeta', async () => {
    const linha = { id: 1, email: 'p@x.com', ativo: true, criado_em: new Date(), atualizado_em: new Date(), senha_hash: 'h' };
    const ex = executorFalso([linha]);
    const criada = await identidadeRepo.criar(ex, { email: 'p@x.com', senhaHash: 'h' });
    assert.equal(Object.hasOwn(criada, 'senhaHash'), false);
    assert.deepEqual(ex.chamadas[0].valores, ['p@x.com', 'h']);

    await identidadeRepo.buscarPorEmail(ex, 'p@x.com');
    assert.equal(/senha_hash/i.test(ex.chamadas[1].texto), false);
    const cred = await identidadeRepo.buscarCredencialPorEmail(ex, 'p@x.com');
    assert.equal(cred.senhaHash, 'h');
    assert.match(ex.chamadas[2].texto, /lower\(email\)\s*=\s*lower\(\$1\)/i);
  });

  test('recusa e-mail não normalizado ou hash vazio antes de consultar', async () => {
    const ex = executorFalso([]);
    await assert.rejects(() => identidadeRepo.criar(ex, { email: 'P@x.com', senhaHash: 'h' }), /normalizado/);
    await assert.rejects(() => identidadeRepo.criar(ex, { email: 'p@x.com', senhaHash: '' }), /hash/);
    await assert.rejects(() => identidadeRepo.buscarPorId(ex, 0), /inválido/);
    assert.equal(ex.chamadas.length, 0);
  });
});

describe('usuario.repository.criar (vínculo por identidade)', () => {
  test('grava email e senha_hash como NULL, identidade_id e perfil parametrizados', async () => {
    const ex = executorFalso([{ id: 5, empresa_id: 3, nome: 'P', email: null, perfil: 'MASTER', ativo: true, biometria_cadastrada: false, identidade_id: 9 }]);
    const u = await usuarioRepo.criar(ex, { empresaId: 3, nome: 'P', perfil: 'MASTER', identidadeId: 9 });
    assert.equal(u.identidadeId, 9);
    assert.match(ex.chamadas[0].texto, /VALUES \(\$1, \$2, NULL, NULL, \$3, \$4\)/);
    assert.deepEqual(ex.chamadas[0].valores, [3, 'P', 'MASTER', 9]);
  });

  test('recusa perfil desconhecido, nome vazio e identidade inválida antes de consultar', async () => {
    const ex = executorFalso([]);
    await assert.rejects(() => usuarioRepo.criar(ex, { empresaId: 3, nome: 'P', perfil: 'ROOT', identidadeId: 9 }), /perfil/);
    await assert.rejects(() => usuarioRepo.criar(ex, { empresaId: 3, nome: '', perfil: 'MASTER', identidadeId: 9 }), /nome/);
    await assert.rejects(() => usuarioRepo.criar(ex, { empresaId: 3, nome: 'P', perfil: 'MASTER', identidadeId: 0 }), /identidade/);
    assert.equal(ex.chamadas.length, 0);
  });
});

describe('empresa.repository — cadastro centralizado', () => {
  const linha = {
    id: 1, nome: 'R', nome_fantasia: 'F', cnpj: '12345678000195', inscricao_estadual: null, situacao_inscricao_estadual: null,
    endereco: null, numero: null, complemento: null, bairro: null, cidade: null, uf: 'RS', cep: null, telefone: null, email: null,
    representante_nome: null, representante_cargo: null, representante_email: null, representante_telefone: null,
    financeiro_nome: null, financeiro_email: null, financeiro_telefone: null, ativo: true, criado_em: new Date(), atualizado_em: new Date(),
  };

  test('as funções de login (buscarPorCnpj/buscarPorId/existeAtiva) permanecem com a projeção estreita de antes', async () => {
    const ex = executorFalso([{ id: 1, nome: 'R', cnpj: '12345678000195', ativo: true }]);
    const e = await empresaRepo.buscarPorId(ex, 1);
    assert.deepEqual(Object.keys(e).sort(), ['ativo', 'cnpj', 'id', 'nome']);
    assert.equal(/representante|financeiro|inscricao/i.test(ex.chamadas[0].texto), false);
  });

  test('criar: razão social vai para a coluna nome; opcionais entram parametrizados; UF e situação de IE validadas', async () => {
    const ex = executorFalso([linha]);
    const e = await empresaRepo.criar(ex, { razaoSocial: 'R', cnpj: '12345678000195', nomeFantasia: 'F', uf: 'RS' });
    assert.equal(e.razaoSocial, 'R');
    assert.match(ex.chamadas[0].texto, /INSERT INTO empresas \(nome, cnpj, nome_fantasia/);
    assert.equal(ex.chamadas[0].valores[0], 'R');
    await assert.rejects(() => empresaRepo.criar(ex, { razaoSocial: 'R', cnpj: '12345678000195', uf: 'rs' }), /uf/);
    await assert.rejects(() => empresaRepo.criar(ex, { razaoSocial: 'R', cnpj: '12345678000195', situacaoInscricaoEstadual: 'isento' }), /situação/);
    await assert.rejects(() => empresaRepo.criar(ex, { razaoSocial: 'R', cnpj: '123' }), /normalizado/);
  });

  test('atualizar: recusa cnpj e ativo; *Informado distingue não mexer de limpar; SET só nas colunas informadas', async () => {
    const ex = executorFalso([linha]);
    await assert.rejects(() => empresaRepo.atualizar(ex, 1, { cnpj: 'x' }), /cnpj/);
    await assert.rejects(() => empresaRepo.atualizar(ex, 1, { ativo: false }), /ativo/);
    assert.equal(ex.chamadas.length, 0);
    await empresaRepo.atualizar(ex, 1, { nomeFantasia: null, nomeFantasiaInformado: true, bairro: 'B', bairroInformado: true });
    const { texto, valores } = ex.chamadas[0];
    assert.match(texto, /nome_fantasia = CASE WHEN \$3::boolean THEN \$4 ELSE nome_fantasia END/);
    assert.equal(valores[2], true); assert.equal(valores[3], null);
    assert.equal(valores.filter((v) => v === true).length, 2, 'só dois campos informados');
  });

  test('listar/contar: busca por nome, nome fantasia ou CNPJ com coringas escapados; atualizarEstado é a única a mexer em ativo', async () => {
    const ex = executorFalso([linha]);
    await empresaRepo.listar(ex, { busca: '100%' });
    assert.match(ex.chamadas[0].texto, /nome ILIKE .* OR nome_fantasia ILIKE .* OR cnpj ILIKE/);
    assert.equal(ex.chamadas[0].valores[1], '100\\%');
    await empresaRepo.atualizarEstado(ex, 1, false);
    assert.match(ex.chamadas[1].texto, /UPDATE empresas SET ativo = \$2 WHERE id = \$1/);
    await assert.rejects(() => empresaRepo.atualizarEstado(ex, 1, 'false'), /booleano/);
  });
});

describe('convite-master.repository', () => {
  const agora = new Date();
  const base = { id: '7', empresa_id: 3, email_convite: 'p@x.com', criado_por: 1, criado_em: agora, expira_em: new Date(agora.getTime() + 3600e3), cancelado_em: null, aceito_em: null, identidade_id: null, usuario_id: null, vigente: true };

  test('situação derivada dos timestamps: PENDENTE, ACEITO, CANCELADO, EXPIRADO', async () => {
    const casos = [
      [{}, 'PENDENTE'],
      [{ aceito_em: agora, identidade_id: 1, usuario_id: 2 }, 'ACEITO'],
      [{ cancelado_em: agora }, 'CANCELADO'],
      [{ vigente: false }, 'EXPIRADO'],
    ];
    for (const [extra, esperado] of casos) {
      const c = await conviteRepo.buscarPorHash(executorFalso([{ ...base, ...extra }]), HASH);
      assert.equal(c.situacao, esperado);
      assert.equal('tokenHash' in c || 'token_hash' in c, false, 'hash nunca sai do repositório');
    }
  });

  test('marcarAceito e cancelar levam a condição de estado no WHERE (uso único) e devolvem null quando nada muda', async () => {
    const ex = executorFalso([]);
    assert.equal(await conviteRepo.marcarAceito(ex, '7', { identidadeId: 1, usuarioId: 2 }), null);
    assert.match(ex.chamadas[0].texto, /aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp\(\)/);
    assert.equal(await conviteRepo.cancelar(ex, 3, '7'), null);
    assert.match(ex.chamadas[1].texto, /aceito_em IS NULL AND cancelado_em IS NULL/);
    assert.deepEqual(ex.chamadas[1].valores, [3, '7']);
  });

  test('buscarPendentePorEmailParaAtualizacao trava com FOR UPDATE e só vê pendentes vigentes; ids BIGINT são strings', async () => {
    const ex = executorFalso([]);
    await conviteRepo.buscarPendentePorEmailParaAtualizacao(ex, 3, 'p@x.com');
    assert.match(ex.chamadas[0].texto, /expira_em > clock_timestamp\(\)[\s\S]*FOR UPDATE/);
    await assert.rejects(() => conviteRepo.buscarPorId(ex, 3, 7), /convite/);
    await assert.rejects(() => conviteRepo.criar(ex, { empresaId: 3, emailConvite: 'P@x.com', tokenHash: HASH, criadoPor: 1, expiraEm: agora }), /normalizado/);
  });
});

describe('convite-master-tentativa.repository', () => {
  test('mesmo contrato de login-tentativa: sucesso exige convite; COOLDOWN_ATIVADO só por registrarAtivacaoCooldown; clock_timestamp', async () => {
    const ex = executorFalso([{ id: '1' }]);
    await tentativaRepo.registrarTentativa(ex, { chaveCooldown: HASH, sucesso: false, motivo: 'CONVITE_INEXISTENTE' });
    assert.deepEqual(ex.chamadas[0].valores, [HASH, null, false, 'CONVITE_INEXISTENTE', null, null]);
    assert.match(ex.chamadas[0].texto, /clock_timestamp\(\)/);
    await assert.rejects(() => tentativaRepo.registrarTentativa(ex, { chaveCooldown: HASH, sucesso: true }), /identificado/);
    await assert.rejects(() => tentativaRepo.registrarTentativa(ex, { chaveCooldown: HASH, sucesso: false, motivo: 'COOLDOWN_ATIVADO' }), /registrarAtivacaoCooldown/);
    await assert.rejects(() => tentativaRepo.registrarTentativa(ex, { chaveCooldown: HASH, conviteId: 7, sucesso: true }), /convite/);
    await tentativaRepo.buscarCooldownVigente(ex, HASH);
    assert.match(ex.chamadas[1].texto, /cooldown_ate > clock_timestamp\(\)/);
    await tentativaRepo.contarFalhasRecentes(ex, HASH, new Date());
    assert.match(ex.chamadas[2].texto, /id > COALESCE/);
  });
});
