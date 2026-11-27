'use strict';
// Etapa 2B: o contrato documental do backend afirma o que existe e, com a mesma clareza, o que não existe.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const DOC = 'docs/sistema/publicacao-homologacao-automacao.md';
const TITULO = '## Backend: agente, identidade e pré-condição de migrations (Etapa 2B)';
const NOVOS = [
  'deploy/hml/cd/iam-confianca-backend.modelo.json',
  'deploy/hml/cd/iam-publicador-backend.modelo.json',
  'deploy/hml/cd/iam-agente-backend.modelo.json',
  'deploy/hml/cd/s3-politica-backend.modelo.json',
  'deploy/hml/cd/agente.config.backend.exemplo.json',
  'deploy/hml/cd/agente-backend.js',
  'deploy/hml/cd/precondicao-migrations.js',
];

function secao() {
  const doc = ler(DOC);
  const i = doc.indexOf(TITULO);
  assert.ok(i >= 0, 'seção da Etapa 2B ausente');
  return doc.slice(i).split('\n## ').slice(0, 1).join('') || doc.slice(i);
}
const corpo = () => {
  const doc = ler(DOC);
  const i = doc.indexOf(TITULO);
  assert.ok(i >= 0, 'seção da Etapa 2B ausente');
  return doc.slice(i + TITULO.length).split('\n## ')[0];
};

describe('contrato do backend na documentação (Etapa 2B)', () => {
  test('a seção existe e cita todos os arquivos novos, que existem', () => {
    secao();
    const s = corpo();
    for (const rel of NOVOS) {
      assert.ok(s.includes(path.basename(rel)), `a seção deve citar ${path.basename(rel)}`);
      assert.ok(fs.existsSync(path.join(RAIZ, rel)), `${rel} deve existir`);
    }
  });

  test('diz que nada foi ativado e mantém o bloqueio de coordenação', () => {
    const s = corpo();
    assert.match(s, /Não ativado/);
    assert.match(s, /COORDENACAO_NAO_HOMOLOGADA/);
    assert.match(s, /hml-backend\//);
    assert.match(s, /homologacao-backend/);
    assert.match(s, /Nada foi executado, instalado ou configurado na AWS/);
    assert.match(s, /migrations continuam separadas do CD/i);
  });

  test('declara a pré-condição como procedimental e define o que ela exige', () => {
    const s = corpo();
    assert.match(s, /procedimental/i);
    assert.match(s, /não é\s+(?:um\s+)?controle técnico/i);
    assert.match(s, /não aceita um recibo de backup isolado/i);
    assert.match(s, /mesmo dump/i);
    assert.match(s, /instância nova/i);
    assert.match(s, /24 horas/);
    assert.match(s, /72 horas/);
  });

  test('declara que a falha interrompe e diagnostica, sem restauração nem reversão automáticas', () => {
    const s = corpo();
    assert.match(s, /não executa restauração/i);
    assert.match(s, /nenhuma reversão automática/i);
    assert.match(s, /diagnóstico/i);
  });

  test('registra a classificação do agente, a recuperação interna do instalador e que o agente não reverte', () => {
    const s = corpo();
    for (const termo of ['RESULTADO_INCERTO', 'FALHA_CRITICA_APOS_ALTERACAO', 'SUCESSO_SEM_REGISTRO_DURAVEL', 'RESULTADO_NAO_RECONHECIDO', 'ESTADO_NAO_ATUALIZADO', 'DURABILIDADE_NAO_GARANTIDA', 'OPERACAO_EM_CURSO', 'COORDENACAO_NAO_CONFIRMADA']) {
      assert.ok(s.includes(termo), `falta: ${termo}`);
    }
    assert.match(s, /mecanismo interno de recuperação/i);
    assert.match(s, /nenhuma reversão adicional/i);
    assert.match(s, /só passa a atuar depois de uma coordenação homologada/i);
  });

  test('registra o limite do selo, o carimbo do estado, os limites do scanner e o B4 pendente', () => {
    const s = corpo();
    assert.match(s, /SHA-256 sem autenticação comprova integridade, mas não origem/i);
    assert.match(s, /autodeclarad/i);
    assert.match(s, /coletadoEm/);
    assert.match(s, /30 minutos/);
    assert.match(s, /falsos positivos/i);
    assert.match(s, /standard_conforming_strings/);
    assert.match(s, /B4/);
    assert.match(s, /job_workflow_ref/);
    assert.match(s, /pendente/i);
  });

  test('descreve todas as regras do classificador de SQL, com os códigos de reprovação', () => {
    const s = corpo();
    for (const termo of ['SQL_NAO_TRANSACIONAL', 'SQL_MALFORMADO', 'SQL_RECORTAVEL', 'CONCURRENTLY', 'VACUUM', 'TABLESPACE', 'ALTER SYSTEM', 'SUBSCRIPTION', 'REINDEX', 'SCHEMA', 'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'PREPARE TRANSACTION', 'SAVEPOINT', 'RELEASE', 'CALL']) {
      assert.ok(s.includes(termo), `falta: ${termo}`);
    }
    assert.match(s, /com argumentos ou sem ponto e vírgula final/i);
  });

  test('descreve a fidelidade ao lexer e a rejeição dos arquivos que o executor recortaria', () => {
    const s = corpo();
    assert.match(s, /comentário de linha termina em `\\n` ou em `\\r`/i);
    assert.match(s, /continuação de literal/i);
    assert.match(s, /sem limite de comprimento/i);
    assert.match(s, /node-pg-migrate 9\.0\.0/);
    assert.match(s, /up migration/i);
    assert.match(s, /down migration/i);
    assert.match(s, /comentários comuns não são afetados/i);
  });

  test('lista os falsos positivos aceitos e as limitações remanescentes do classificador', () => {
    const s = corpo();
    assert.match(s, /BEGIN ATOMIC/);
    assert.match(s, /COMMENT ON/);
    assert.match(s, /todo `CALL`, `SAVEPOINT` ou `RELEASE`/);
    assert.match(s, /não foi verificad[oa] em PostgreSQL real/i);
    assert.match(s, /erro em tempo de execução/i);
    assert.match(s, /97 migrations/);
  });

  test('o LEIA-ME lista os arquivos novos', () => {
    const l = ler('deploy/hml/LEIA-ME.md');
    for (const rel of NOVOS) assert.ok(l.includes(path.basename(rel)), `LEIA-ME deve citar ${path.basename(rel)}`);
  });
});
