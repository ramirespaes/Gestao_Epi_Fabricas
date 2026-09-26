'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const f = require('../../src/schemas/funcionario.schema');

/** Schema de funcionários (Bloco 9, Etapa B). Nenhum campo de usuário do sistema. */

const base = { matricula: 'MAT-000171', nome: 'Marcos Silva', cpf: '529.982.247-25' };

describe('criar', () => {
  test('CPF com máscara sai normalizado (11 dígitos) e com DV conferido', () => {
    const r = f.criar.body.safeParse(base);
    assert.equal(r.success, true);
    assert.equal(r.data.cpf, '52998224725');
  });

  test('CPF com DV inválido: CPF_DV_INVALIDO; estrutura inválida: CPF_INVALIDO', () => {
    const dv = f.criar.body.safeParse({ ...base, cpf: '529.982.247-26' });
    assert.equal(dv.success, false);
    assert.equal(dv.error.issues[0].params.codigo, 'CPF_DV_INVALIDO');

    const estrutura = f.criar.body.safeParse({ ...base, cpf: '123' });
    assert.equal(estrutura.success, false);
    assert.equal(estrutura.error.issues[0].params.codigo, 'CPF_INVALIDO');
  });

  test('dataNascimento usa calendário estrito (30/fev, ano 0000 recusados; bissexto real aceito)', () => {
    assert.equal(f.criar.body.safeParse({ ...base, dataNascimento: '2024-02-29' }).success, true);
    for (const data of ['2023-02-29', '2026-02-30', '0000-01-01', '15/03/1990']) {
      const r = f.criar.body.safeParse({ ...base, dataNascimento: data });
      assert.equal(r.success, false, data);
      assert.equal(r.error.issues[0].params.codigo, 'DATA_NASCIMENTO_INVALIDA');
    }
  });

  test('grupoHomogeneoId aceita inteiro positivo ou null; recusa 0, negativo e string', () => {
    assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: 50 }).success, true);
    assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: null }).success, true);
    for (const ruim of [0, -1, '50']) {
      assert.equal(f.criar.body.safeParse({ ...base, grupoHomogeneoId: ruim }).success, false, String(ruim));
    }
  });

  test('campos de usuário do sistema e campos internos são recusados', () => {
    for (const chave of ['email', 'senha', 'perfil', 'usuarioId', 'id', 'empresaId', 'ativo']) {
      const r = f.criar.body.safeParse({ ...base, [chave]: 'x' });
      assert.equal(r.success, false, chave);
      assert.equal(r.error.issues[0].code, 'unrecognized_keys');
    }
  });
});

describe('alterar / listar', () => {
  test('alterar: todos opcionais; null limpa; conteúdo inválido devolve o código do campo', () => {
    assert.equal(f.alterar.body.safeParse({}).success, true);
    assert.deepEqual(f.alterar.body.safeParse({ grupoHomogeneoId: null, telefone: null }).data, { grupoHomogeneoId: null, telefone: null });
    const r = f.alterar.body.safeParse({ cracha: 'x'.repeat(31) });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0].params.codigo, 'CRACHA_INVALIDO');
  });

  test('alterar: cpf NÃO faz parte do contrato — igual ou diferente, é chave não reconhecida (CPF imutável após o cadastro)', () => {
    for (const corpo of [
      { cpf: '529.982.247-25' },
      { cpf: '52998224725' },
      { cpf: '111.444.777-35' },
      { nome: 'Marcos S.', cpf: '529.982.247-25' },
    ]) {
      const r = f.alterar.body.safeParse(corpo);
      assert.equal(r.success, false, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.error.issues.length, 1, 'uma única issue: a chave, não o valor');
      assert.equal(r.error.issues[0].code, 'unrecognized_keys');
      assert.deepEqual(r.error.issues[0].keys, ['cpf']);
    }
  });

  test('criar continua exigindo cpf (a imutabilidade não muda a criação)', () => {
    const r = f.criar.body.safeParse({ matricula: 'MAT-000171', nome: 'Marcos Silva' });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ['cpf']);
  });

  test('listar: grupoHomogeneoId em query chega como string decimal canônica', () => {
    const r = f.listar.query.safeParse({ grupoHomogeneoId: '50', busca: 'silva' });
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { pagina: 1, limite: 20, grupoHomogeneoId: 50, busca: 'silva' });
    assert.equal(f.listar.query.safeParse({ grupoHomogeneoId: '0' }).success, false);
  });
});

describe('C4 (25/09/2026) — admissão, CPF exato na busca e importação em lote', () => {
  const linhaValida = (extra = {}) => ({
    linha: 2, nome: 'João Pereira', cpf: '52998224725', matricula: 'MAT-000001', dataAdmissao: '2020-06-01',
    dataNascimento: '1990-03-15', setor: 'Produção', funcao: 'Operador', telefone: null, ...extra,
  });
  const loteValido = (extra = {}) => ({
    importacaoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    lote: { numero: 1, total: 1 },
    arquivo: { nome: 'funcionarios.xlsx', formato: 'xlsx', totalLinhas: 1 },
    declaracaoLgpd: { versao: 'IMPORTACAO-FUNCIONARIOS-V1', confirmada: true },
    linhas: [linhaValida()],
    ...extra,
  });

  test('dataAdmissao: calendário estrito, opcional e nulável no cadastro e na edição; código próprio', () => {
    assert.equal(f.criar.body.safeParse({ ...base, dataAdmissao: '2020-06-01' }).success, true);
    assert.equal(f.criar.body.safeParse({ ...base, dataAdmissao: null }).success, true);
    assert.equal(f.criar.body.safeParse(base).success, true, 'retrocompatível: sem o campo');
    assert.equal(f.alterar.body.safeParse({ dataAdmissao: null }).success, true);
    for (const data of ['2023-02-29', '01/06/2020', '2020-6-1']) {
      for (const schema of [f.criar.body, f.alterar.body]) {
        const r = schema.safeParse(schema === f.criar.body ? { ...base, dataAdmissao: data } : { dataAdmissao: data });
        assert.equal(r.success, false, data);
        assert.equal(r.error.issues[0].params.codigo, 'DATA_ADMISSAO_INVALIDA');
      }
    }
  });

  test('listar: cpf só completo (11 dígitos, DV conferido), normalizado; parcial ou inválido é recusado', () => {
    assert.equal(f.listar.query.safeParse({ cpf: '529.982.247-25' }).data.cpf, '52998224725');
    assert.equal(f.listar.query.safeParse({ cpf: '52998224725' }).data.cpf, '52998224725');
    assert.equal(f.listar.query.safeParse({ cpf: '529982' }).error.issues[0].params.codigo, 'CPF_INVALIDO');
    assert.equal(f.listar.query.safeParse({ cpf: '52998224726' }).error.issues[0].params.codigo, 'CPF_DV_INVALIDO');
  });

  test('importação: envelope estrito válido; até 100 linhas; declaração confirmada; formato xlsx ou csv', () => {
    assert.equal(f.importacao.body.safeParse(loteValido()).success, true);
    const cem = Array.from({ length: 100 }, (_, i) => linhaValida({ linha: i + 2 }));
    assert.equal(f.importacao.body.safeParse(loteValido({ linhas: cem })).success, true);
    const recusas = {
      '101 linhas': loteValido({ linhas: Array.from({ length: 101 }, (_, i) => linhaValida({ linha: i + 2 })) }),
      'nenhuma linha': loteValido({ linhas: [] }),
      'declaração não confirmada': loteValido({ declaracaoLgpd: { versao: 'IMPORTACAO-FUNCIONARIOS-V1', confirmada: false } }),
      'sem declaração': (() => { const l = loteValido(); delete l.declaracaoLgpd; return l; })(),
      'formato xls': loteValido({ arquivo: { nome: 'a.xls', formato: 'xls', totalLinhas: 1 } }),
      'lote maior que o total': loteValido({ lote: { numero: 2, total: 1 } }),
      'importacaoId inválido': loteValido({ importacaoId: 'abc' }),
      'empresaId no corpo': loteValido({ empresaId: 1 }),
      'linha repetida no lote': loteValido({ linhas: [linhaValida(), linhaValida()] }),
      'chave desconhecida na linha': loteValido({ linhas: [linhaValida({ empresaId: 2 })] }),
      'número de linha fora do intervalo': loteValido({ linhas: [linhaValida({ linha: 1 })] }),
      'mais de 1.000 linhas no arquivo': loteValido({ arquivo: { nome: 'a.csv', formato: 'csv', totalLinhas: 1001 } }),
    };
    for (const [caso, corpo] of Object.entries(recusas)) {
      assert.equal(f.importacao.body.safeParse(corpo).success, false, caso);
    }
  });

  test('importação: conteúdo inválido de uma linha NÃO invalida o lote (a linha é avaliada à parte)', () => {
    const lote = loteValido({ linhas: [linhaValida({ cpf: '11111111111', nome: 'x'.repeat(200) }), linhaValida({ linha: 3, cpf: '11144477735', matricula: 'M2' })] });
    assert.equal(f.importacao.body.safeParse(lote).success, true);
  });

  test('linhaImportacao: regras do cadastro por linha; admissão, setor e função obrigatórios; campo de cada erro identificado', () => {
    const ok = f.linhaImportacao.safeParse(linhaValida({ cpf: '529.982.247-25' }));
    assert.equal(ok.success, true);
    assert.equal(ok.data.cpf, '52998224725');
    const casos = [
      [{ cpf: '52998224726' }, 'cpf'], [{ cpf: '123' }, 'cpf'], [{ nome: 'x'.repeat(151) }, 'nome'], [{ nome: '  ' }, 'nome'],
      [{ matricula: '' }, 'matricula'], [{ dataAdmissao: null }, 'dataAdmissao'], [{ dataAdmissao: '31/02/2020' }, 'dataAdmissao'],
      [{ dataNascimento: '1990-02-30' }, 'dataNascimento'], [{ setor: null }, 'setor'], [{ funcao: null }, 'funcao'],
      [{ telefone: 'x'.repeat(21) }, 'telefone'],
    ];
    for (const [extra, campo] of casos) {
      const r = f.linhaImportacao.safeParse(linhaValida(extra));
      assert.equal(r.success, false, JSON.stringify(extra));
      assert.deepEqual(r.error.issues.map((i) => i.path[0]), [campo], JSON.stringify(extra));
    }
    assert.equal(f.linhaImportacao.safeParse(linhaValida({ dataNascimento: null, telefone: null })).success, true);
  });
});

describe('ajuste de fechamento da C4 — CPF na busca (guarda do contrato existente)', () => {
  test('letras, barras, sublinhados e espaços internos são recusados, mesmo que removê-los desse um CPF válido; pontuação usual é aceita', () => {
    for (const invalido of ['529a982b247c25', '529.982.247/25', '529 982 247 25', '529_982_247_25', 'CPF52998224725']) {
      assert.equal(f.listar.query.safeParse({ cpf: invalido }).success, false, invalido);
    }
    for (const valido of ['52998224725', '529.982.247-25', ' 529.982.247-25 ']) {
      assert.equal(f.listar.query.safeParse({ cpf: valido }).data.cpf, '52998224725', valido);
    }
  });
});
