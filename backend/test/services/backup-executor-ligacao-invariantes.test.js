'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Pol = require('../../src/services/backup-executor-politica.service');

/** D-ORF-6, L1 (Bloco A): invariantes dos módulos novos — operação real desligada e nenhum efeito colateral (escrita, remoção, processo, ambiente, rede) neles. */

const DIR = path.join(__dirname, '../../src/services');
const NOVOS = ['backup-executor-credenciais.service.js', 'backup-executor-auditoria.service.js', 'backup-executor-ligacao.service.js', 'backup-executor-compositor.service.js'];
const PROIBIDOS = [/\bwriteFile/, /\bappendFile/, /\bcreateWriteStream/, /\bunlink/, /\brmSync|\brm\(/, /\brename/, /\bmkdir/, /child_process/, /\bspawn|\bexec(?:File)?\b/, /process\.env/, /\bfetch\(/, /node:(?:http|https|net|dns)/, /\bfs\b/];

describe('[LIG-INV] invariantes', () => {
  test('LIGINV-01 — a operação real continua desligada na política', () => {
    assert.equal(Pol.OPERACAO_HABILITADA, false);
    const r = Pol.avaliarPortoes({ modo: 'OPERACAO', acao: 'BACKUP', ambiente: 'PRODUCAO', destinoId: 'prd-s3', confirmacao: null, fatos: { sdk: 'APROVADO', chavesOrigem: 'OPERACIONAL', destinoLocal: 'AUTORIZADO', uid: 501, umask: 0o077 } });
    assert.ok(r.bloqueios.includes('OPERACAO_NAO_HABILITADA'));
  });

  for (const arquivo of NOVOS) {
    test(`LIGINV-02 — ${arquivo} não escreve, remove, cria processo, lê ambiente nem usa rede`, () => {
      const fonte = fs.readFileSync(path.join(DIR, arquivo), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const padrao of PROIBIDOS) assert.doesNotMatch(fonte, padrao, `${arquivo} contém ${padrao}`);
    });
  }

});
