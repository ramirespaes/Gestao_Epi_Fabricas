'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const u = require('../../src/schemas/usuario.schema');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const issues = (r) => r.error.issues.map((i) => ({ code: i.code, path: i.path.join('.'), codigo: i.params && i.params.codigo, keys: i.keys }));
const unica = (r, esperado) => assert.deepEqual(issues(r), [{ keys: undefined, ...esperado }]);
const chaveDesconhecida = (r, chaves) => assert.deepEqual(issues(r), [{ code: 'unrecognized_keys', path: '', codigo: undefined, keys: chaves }]);
const SENSIVEIS = ['João', 'luis@empresa', 'MinhaSenha', 'SUPERVISOR_X'];
const semSensiveis = (r) => {
  for (const issue of r.error.issues) {
    assertSemSensiveis(issue.message, SENSIVEIS, 'mensagem');
    assert.equal('input' in issue, false);
  }
};

const nfd = 'João da Silva'.normalize('NFD');
const senhaNfd = 'Coração 2026'.normalize('NFD');
const base = { nome: '  ' + nfd + '  ', email: ' Luis@Empresa.COM ', senha: '  ' + senhaNfd + '  ', perfil: 'USUARIO' };
const INTERNOS = { id: 9, empresa_id: 1, senha_hash: '$argon2id$x', biometria_cadastrada: true, ultimo_login_em: '2026-01-01', criado_em: '2026-01-01', atualizado_em: '2026-01-01', ativo: false };

describe('exports', () => {
  test('cinco schemas de rota com as origens esperadas', () => {
    assert.deepEqual(Object.keys(u).sort(), ['acaoPorId', 'criar', 'editar', 'listar', 'porId']);
    assert.deepEqual([Object.keys(u.criar), Object.keys(u.editar), Object.keys(u.porId), Object.keys(u.acaoPorId), Object.keys(u.listar)], [['body'], ['params', 'body'], ['params'], ['params', 'body'], ['query']]);
  });
});

describe('criar', () => {
  test('somente os campos permitidos; valores normalizados; senha intacta', () => {
    assert.deepEqual(u.criar.body.parse(base), { nome: 'João da Silva', email: 'luis@empresa.com', senha: '  ' + senhaNfd + '  ', perfil: 'USUARIO' });
    assert.notEqual(u.criar.body.parse(base).senha.normalize('NFC'), u.criar.body.parse(base).senha);
    assert.equal(u.criar.body.parse({ ...base, senha: 'abc' }).senha, 'abc');
    assert.equal(u.criar.body.parse({ ...base, perfil: 'QUALQUER_COISA' }).perfil, 'QUALQUER_COISA');
    assert.equal(u.criar.body.parse({ ...base, nome: 'ç'.normalize('NFD').repeat(150) }).nome.length, 150);
  });

  test('campo ausente e campo inválido apontam só o próprio campo', () => {
    for (const campo of ['nome', 'email', 'senha', 'perfil']) {
      const { [campo]: _, ...sem } = base;
      unica(u.criar.body.safeParse(sem), { code: 'invalid_type', path: campo, codigo: undefined });
    }
    const casos = [['nome', '', 'NOME_INVALIDO'], ['nome', 'a\tb', 'NOME_INVALIDO'], ['nome', 'x'.repeat(151), 'NOME_INVALIDO'], ['email', 'josé@empresa.com', 'EMAIL_INVALIDO'], ['senha', '', 'SENHA_VAZIA'], ['perfil', 'usuario', 'PERFIL_INVALIDO'], ['perfil', 'A'.repeat(21), 'PERFIL_INVALIDO']];
    for (const [campo, valor, codigo] of casos) {
      const r = u.criar.body.safeParse({ ...base, [campo]: valor });
      unica(r, { code: 'custom', path: campo, codigo });
      semSensiveis(r);
    }
  });

  test('campos internos, inclusive empresa_id, senha_hash e ativo, são rejeitados como desconhecidos', () => {
    for (const [chave, valor] of Object.entries(INTERNOS)) {
      chaveDesconhecida(u.criar.body.safeParse({ ...base, [chave]: valor }), [chave]);
    }
    assert.deepEqual(u.criar.body.safeParse({ ...base, ...INTERNOS }).error.issues[0].keys.sort(), Object.keys(INTERNOS).sort());
  });
});

describe('editar', () => {
  test('atualização parcial com os campos editáveis', () => {
    assert.deepEqual(u.editar.body.parse({ nome: '  Ana  ' }), { nome: 'Ana' });
    assert.deepEqual(u.editar.body.parse({ email: 'A@B.CO' }), { email: 'a@b.co' });
    assert.deepEqual(u.editar.body.parse({ perfil: 'SUPERVISOR' }), { perfil: 'SUPERVISOR' });
    assert.deepEqual(u.editar.body.parse({ nome: 'Ana', email: 'a@b.co', perfil: 'SUPERVISOR' }), { nome: 'Ana', email: 'a@b.co', perfil: 'SUPERVISOR' });
  });

  test('NENHUM_CAMPO somente para corpo válido e vazio', () => {
    unica(u.editar.body.safeParse({}), { code: 'custom', path: '', codigo: 'NENHUM_CAMPO' });
    unica(u.editar.body.safeParse({ email: 'x' }), { code: 'custom', path: 'email', codigo: 'EMAIL_INVALIDO' });
    assert.deepEqual(issues(u.editar.body.safeParse({ nome: '', perfil: 'x' })).map((i) => i.codigo), ['NOME_INVALIDO', 'PERFIL_INVALIDO']);
    unica(u.editar.body.safeParse({ nome: null }), { code: 'invalid_type', path: 'nome', codigo: undefined });
  });

  test('empresa_id, senha_hash, ativo, senha e id são rejeitados como desconhecidos', () => {
    chaveDesconhecida(u.editar.body.safeParse({ empresa_id: 1 }), ['empresa_id']);
    chaveDesconhecida(u.editar.body.safeParse({ senha_hash: '$argon2id$abc' }), ['senha_hash']);
    chaveDesconhecida(u.editar.body.safeParse({ ativo: false }), ['ativo']);
    chaveDesconhecida(u.editar.body.safeParse({ senha: 'NovaSenha#2026' }), ['senha']);
    chaveDesconhecida(u.editar.body.safeParse({ nome: 'Ana', id: 3 }), ['id']);
    unica(u.editar.body.safeParse('texto'), { code: 'invalid_type', path: '', codigo: undefined });
  });

  test('params por id: decimal canônico positivo, estrito', () => {
    assert.deepEqual(u.editar.params.parse({ id: '42' }), { id: 42 });
    for (const ruim of ['0', '007', '1e3', '-1', 'abc', '2147483648']) {
      unica(u.editar.params.safeParse({ id: ruim }), { code: 'custom', path: 'id', codigo: 'ID_INVALIDO' });
    }
    chaveDesconhecida(u.editar.params.safeParse({ id: '1', extra: 'x' }), ['extra']);
    unica(u.editar.params.safeParse({}), { code: 'invalid_type', path: 'id', codigo: undefined });
  });
});

describe('porId e acaoPorId', () => {
  test('params compartilhados e corpo estritamente vazio nas ações', () => {
    assert.deepEqual(u.porId.params.parse({ id: '42' }), { id: 42 });
    assert.equal(u.porId.params, u.editar.params);
    assert.deepEqual(u.acaoPorId.params.parse({ id: '7' }), { id: 7 });
    assert.deepEqual(u.acaoPorId.body.parse({}), {});
    chaveDesconhecida(u.acaoPorId.body.safeParse({ ativo: false }), ['ativo']);
    chaveDesconhecida(u.acaoPorId.body.safeParse({ motivo: 'x' }), ['motivo']);
    unica(u.acaoPorId.body.safeParse([]), { code: 'invalid_type', path: '', codigo: undefined });
  });
});

describe('listar', () => {
  test('padrões, filtros e busca normalizada', () => {
    assert.deepEqual(u.listar.query.parse({}), { pagina: 1, limite: 20 });
    assert.deepEqual(u.listar.query.parse({ pagina: '3', limite: '100', ativo: 'true', perfil: 'SUPERVISOR', busca: '  ' + nfd + '  ' }), { pagina: 3, limite: 100, ativo: true, perfil: 'SUPERVISOR', busca: 'João da Silva' });
    assert.equal(u.listar.query.parse({ ativo: 'false' }).ativo, false);
  });

  test('query estrita: desconhecidas, valores inválidos e parâmetros repetidos', () => {
    const casos = [
      [{ limte: '20' }, 'unrecognized_keys'], [{ ordem: 'nome' }, 'unrecognized_keys'], [{ ativo: 'sim' }, 'invalid_value'],
      [{ perfil: 'master' }, 'PERFIL_INVALIDO'], [{ busca: 'x'.repeat(101) }, 'BUSCA_INVALIDA'], [{ busca: '' }, 'BUSCA_INVALIDA'],
      [{ pagina: '0' }, 'FORA_DO_INTERVALO'], [{ limite: '101' }, 'FORA_DO_INTERVALO'], [{ pagina: '' }, 'INTEIRO_INVALIDO'],
      [{ limite: '1e1' }, 'INTEIRO_INVALIDO'], [{ ativo: ['true', 'false'] }, 'invalid_value'], [{ pagina: ['1', '2'] }, 'invalid_type'],
    ];
    for (const [query, codigo] of casos) {
      const r = u.listar.query.safeParse(query);
      assert.equal(r.success, false, JSON.stringify(query));
      const issue = r.error.issues[0];
      assert.equal(issue.code === 'custom' ? issue.params.codigo : issue.code, codigo, JSON.stringify(query));
    }
    assert.deepEqual(u.listar.query.safeParse({ limte: '20', ordem: 'x' }).error.issues[0].keys.sort(), ['limte', 'ordem']);
  });
});
