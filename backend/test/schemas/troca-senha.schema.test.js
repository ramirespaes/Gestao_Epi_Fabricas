'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Schemas HTTP da troca de senha autenticada (Bloco 11E). Só estrutura: a
 * política da senha nova é do service, e a identidade nunca vem do corpo.
 * `strictObject` recusa qualquer campo de autoridade que o cliente tente
 * enviar. As senhas passam como vieram: sem aparar, sem trocar a caixa, sem
 * normalizar.
 */

const schemas = () => exigirModulo('src/schemas/troca-senha.schema');

const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const RECOVERY_CODE = 'ABCD-EFGH-JKMN-PQRS';

const aceita = (schema, dado) => {
  const r = schema.safeParse(dado);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  return r.data;
};
const recusa = (schema, dado, rotulo) => {
  const r = schema.safeParse(dado);
  assert.equal(r.success, false, rotulo ?? JSON.stringify(dado));
  return r.error.issues;
};

const CAMPOS_DE_AUTORIDADE = [
  { identidadeId: 7 },
  { administradorId: 7 },
  { usuarioId: 7 },
  { empresaId: 7 },
  { sessionId: '7' },
  { sessaoId: '7' },
  { email: 'outra.pessoa@example.invalid' },
  { escopo: 'PLATAFORMA' },
  { token: 'x'.repeat(43) },
  { turnstileToken: 'token-do-widget' },
  { confirmacao: SENHA_NOVA },
];

describe('troca autenticada — corpo do Portal', () => {
  test('exporta só os dois contratos, cada um com corpo e query', () => {
    const modulo = schemas();
    assert.deepEqual(Object.keys(modulo).sort(), ['trocarPlataforma', 'trocarPortal']);
    for (const nome of ['trocarPortal', 'trocarPlataforma']) {
      assert.deepEqual(Object.keys(modulo[nome]).sort(), ['body', 'query'], nome);
    }
  });

  test('senha atual e nova senha passam como vieram, sem aparar, sem trocar a caixa e sem normalizar', () => {
    const { trocarPortal } = schemas();
    for (const [senhaAtual, novaSenha] of [
      [SENHA_ATUAL, SENHA_NOVA],
      [`  ${SENHA_ATUAL}  `, `  ${SENHA_NOVA}\n`],
      ['Maiúsculas-E-minúsculas', 'AÇÃO-composta-ç'],
      ['a'.repeat(1024), 'b'.repeat(1024)],
    ]) {
      assert.deepEqual(aceita(trocarPortal.body, { senhaAtual, novaSenha }), { senhaAtual, novaSenha });
    }
  });

  test('as duas senhas são obrigatórias, em texto, não vazias e de até 1024 caracteres', () => {
    const { trocarPortal } = schemas();
    for (const campo of ['senhaAtual', 'novaSenha']) {
      const base = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA };
      const { [campo]: _omitido, ...semCampo } = base;
      recusa(trocarPortal.body, semCampo, `sem ${campo}`);
      for (const ruim of [undefined, null, 42, true, [SENHA_ATUAL], { valor: SENHA_ATUAL }, '', 'x'.repeat(1025)]) {
        recusa(trocarPortal.body, { ...base, [campo]: ruim }, `${campo} ${typeof ruim} ${String(ruim).length}`);
      }
    }
  });

  test('campo de autoridade ou estranho à troca é recusado: a identidade vem só da sessão', () => {
    const { trocarPortal } = schemas();
    const base = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA };
    for (const extra of [...CAMPOS_DE_AUTORIDADE, { codigo: '123456' }, { codigoRecuperacao: RECOVERY_CODE }]) {
      recusa(trocarPortal.body, { ...base, ...extra }, JSON.stringify(Object.keys(extra)));
    }
  });
});

describe('troca autenticada — corpo do Painel Privado', () => {
  const base = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: '123456' };

  test('senha atual, nova senha e código TOTP passam como vieram, com os zeros à esquerda', () => {
    const { trocarPlataforma } = schemas();
    assert.deepEqual(aceita(trocarPlataforma.body, base), base);
    assert.deepEqual(aceita(trocarPlataforma.body, { ...base, codigo: '000123' }), { ...base, codigo: '000123' });
    assert.deepEqual(
      aceita(trocarPlataforma.body, { ...base, senhaAtual: ` ${SENHA_ATUAL} `, novaSenha: ` ${SENHA_NOVA} ` }),
      { ...base, senhaAtual: ` ${SENHA_ATUAL} `, novaSenha: ` ${SENHA_NOVA} ` },
    );
  });

  test('as duas senhas valem as mesmas regras do Portal: obrigatórias, em texto, não vazias, até 1024', () => {
    const { trocarPlataforma } = schemas();
    for (const campo of ['senhaAtual', 'novaSenha']) {
      const { [campo]: _omitido, ...semCampo } = base;
      recusa(trocarPlataforma.body, semCampo, `sem ${campo}`);
      for (const ruim of [undefined, null, 42, [SENHA_ATUAL], '', 'x'.repeat(1025)]) {
        recusa(trocarPlataforma.body, { ...base, [campo]: ruim }, `${campo} ${typeof ruim}`);
      }
    }
  });

  test('o código é só TOTP: seis dígitos exatos; recovery code, espaços, hífen, número e vazio são recusados', () => {
    const { trocarPlataforma } = schemas();
    const { codigo: _omitido, ...semCodigo } = base;
    recusa(trocarPlataforma.body, semCodigo, 'sem código');
    for (const ruim of ['12345', '1234567', 'abcdef', '12345a', ' 123456', '123456 ', '123 456', '123-456', RECOVERY_CODE, RECOVERY_CODE.replace(/-/g, ''), '', 123456, null, ['123456']]) {
      recusa(trocarPlataforma.body, { ...base, codigo: ruim }, `código ${JSON.stringify(ruim)}`);
    }
  });

  test('recovery code nunca substitui o TOTP: o campo do código de recuperação e os de autoridade são recusados', () => {
    const { trocarPlataforma } = schemas();
    const { codigo: _omitido, ...semCodigo } = base;
    recusa(trocarPlataforma.body, { ...semCodigo, codigoRecuperacao: RECOVERY_CODE }, 'recovery code no lugar do TOTP');
    recusa(trocarPlataforma.body, { ...base, codigoRecuperacao: RECOVERY_CODE }, 'recovery code junto com o TOTP');
    for (const extra of CAMPOS_DE_AUTORIDADE) {
      recusa(trocarPlataforma.body, { ...base, ...extra }, JSON.stringify(Object.keys(extra)));
    }
  });
});

describe('troca autenticada — mensagens e query', () => {
  test('nenhuma mensagem de validação traz o valor recebido', () => {
    const { trocarPortal, trocarPlataforma } = schemas();
    const valores = ['valorSecretoDaSenhaAtual', 'valorSecretoDaSenhaNova', 'valorSecretoDoCodigo'];
    const issues = [
      ...recusa(trocarPortal.body, { senhaAtual: ['valorSecretoDaSenhaAtual'], novaSenha: { v: 'valorSecretoDaSenhaNova' } }),
      ...recusa(trocarPlataforma.body, { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: 'valorSecretoDoCodigo' }),
      ...recusa(trocarPortal.body, { senhaAtual: SENHA_ATUAL, novaSenha: 'valorSecretoDaSenhaNova'.repeat(60) }),
    ];
    const texto = JSON.stringify(issues.map((i) => ({ message: i.message, params: i.params, path: i.path })));
    for (const valor of valores) assert.equal(texto.includes(valor), false, valor);
  });

  test('a query é sempre vazia nas duas rotas: qualquer parâmetro é recusado', () => {
    const { trocarPortal, trocarPlataforma } = schemas();
    for (const [nome, schema] of [['trocarPortal', trocarPortal.query], ['trocarPlataforma', trocarPlataforma.query]]) {
      assert.deepEqual(aceita(schema, {}), {}, nome);
      for (const ruim of [{ senhaAtual: SENHA_ATUAL }, { token: 'x' }, { email: 'pessoa@example.invalid' }, { qualquer: '1' }]) {
        recusa(schema, ruim, `${nome} ${Object.keys(ruim)[0]}`);
      }
    }
  });
});
