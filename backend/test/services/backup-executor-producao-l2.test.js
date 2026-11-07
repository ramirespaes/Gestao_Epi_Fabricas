'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarProducaoL2 } = require('../../src/services/backup-executor-producao-l2.service');

/** D-ORF-6, L1 (Bloco B): adaptador `producao` L2. Composição falsa; o caminho positivo com a composição REAL está em imagem-backup-composicao-producao.test.js ([CP-G]). */

const OP = 'b'.repeat(32);
const RAIZ = '/var/safework/publicados';
const LIDO = { identidade: { sha256Manifesto: 'c'.repeat(64) } };
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const mk = (extra = {}) => criarProducaoL2({ composicao: { executar: async () => ({}) }, raizPublicados: RAIZ, lerPacote: async () => LIDO, ...extra });

describe('[PROD-L2] adaptador producao', () => {
  test('PL2-01 — configuração estrita', () => {
    assert.equal(codigo(() => mk({ extra: 1 })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ composicao: {} })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ raizPublicados: 'relativo' })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ raizPublicados: `${RAIZ}/` })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ raizPublicados: '/a/../b' })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ lerPacote: null })), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => criarProducaoL2(undefined)), 'PRODUCAO_L2_CONFIGURACAO_INVALIDA');
  });

  test('PL2-02 — pedido inválido é recusado sem chamar a composição', async () => {
    let n = 0;
    const p = mk({ composicao: { executar: async () => { n += 1; return {}; } } });
    for (const ruim of [undefined, null, {}, { operacaoId: OP }, { operacaoId: 'x', conjuntoId: 'c' }, { operacaoId: OP, conjuntoId: '' }, { operacaoId: OP, conjuntoId: 'c', extra: 1 }]) {
      assert.deepEqual({ ...(await p.produzir(ruim)) }, { ok: false, codigo: 'PRODUCAO_PEDIDO_INVALIDO' });
    }
    assert.equal(n, 0);
  });

  test('PL2-03 — composição que lança, ou resultado forjado (não produzido pela composição), é recusado com código fixo', async () => {
    const lanca = mk({ composicao: { executar: async () => { throw new Error('SEGREDO-NO-ERRO'); } } });
    const r1 = await lanca.produzir({ operacaoId: OP, conjuntoId: 'c' });
    assert.deepEqual({ ...r1 }, { ok: false, codigo: 'PRODUCAO_COMPOSICAO_FALHOU' });
    assert.ok(!JSON.stringify(r1).includes('SEGREDO'));
    const forjado = mk({ composicao: { executar: async () => ({ resultado: { publicacao: { publicada: true } }, prontidao: { pronta: true }, proveniencia: {} }) } });
    assert.deepEqual({ ...(await forjado.produzir({ operacaoId: OP, conjuntoId: 'c' })) }, { ok: false, codigo: 'PRODUCAO_RESULTADO_NAO_RECONHECIDO' });
  });

  test('PL2-04 — o nome da preparação deriva só do operacaoId e a composição recebe exatamente as duas chaves', async () => {
    let visto;
    const p = mk({ composicao: { executar: async (e) => { visto = e; return {}; } } });
    await p.produzir({ operacaoId: OP, conjuntoId: 'conj-1' });
    assert.deepEqual(visto, { nomeDaPreparacao: `l2-${OP}`, conjuntoId: 'conj-1' });
  });

  test('PL2-05 — o módulo não cria processo, não escreve nem remove, não lê ambiente nem rede', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/backup-executor-producao-l2.service.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const padrao of [/\bwriteFile/, /\bappendFile/, /createWriteStream/, /\bunlink/, /\brmSync|\brm\(/, /\brename/, /\bmkdir/, /child_process/, /\bspawn|\bexec(?:File)?\b/, /process\.env/, /\bfetch\(/, /node:(?:http|https|net|dns)/, /require\('node:fs'\)/, /OPERACAO_HABILITADA/]) assert.doesNotMatch(fonte, padrao, String(padrao));
  });
});
