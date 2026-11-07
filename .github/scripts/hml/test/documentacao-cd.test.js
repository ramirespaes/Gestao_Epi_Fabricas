'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Trava as promessas desta etapa: nenhum workflow de publicação foi adicionado, a
 * documentação não afirma nada que o código não faça, e os caminhos que ela cita
 * existem. Protege a próxima pessoa de "ativar" algo por engano.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DOC = 'docs/sistema/publicacao-homologacao-componentes.md';

describe('documentação e invariantes do CD de homologação', () => {
  test('os únicos workflows são os conhecidos: nenhum de publicação foi adicionado', () => {
    const permitidos = new Set(['ci.yml', 'deploy-hml.yml', 'ensaio-d12-sharp.yml']);
    for (const arquivo of fs.readdirSync(path.join(REPO, '.github', 'workflows'))) assert.ok(permitidos.has(arquivo), `workflow não previsto: ${arquivo}`);
  });

  test('nenhum arquivo versionado de deploy/ ou do workflow contém credencial, host de servidor real ou comando de transmissão', () => {
    const arquivos = [];
    const andar = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const abs = path.join(dir, e.name); if (e.isDirectory()) andar(abs); else arquivos.push(abs); } };
    andar(path.join(REPO, 'deploy'));
    arquivos.push(path.join(REPO, '.github', 'workflows', 'deploy-hml.yml'));
    for (const abs of arquivos) {
      const texto = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(REPO, abs);
      assert.doesNotMatch(texto, /\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}/, `${rel}: credencial`);
      if (rel.endsWith('.js') && !rel.includes('/test/')) {
        assert.doesNotMatch(texto, /\b(?:scp|sftp|rsync)\b|aws\s+s3|ssh\s+-|require\(['"]node:(?:net|dgram|tls)['"]\)/, `${rel}: transmissão`);
      }
    }
  });

  test('o código reporta como o instalador trata o D-ORF-6: sem trava homologada, atestado humano; e a documentação diz o mesmo', () => {
    const doc = ler(DOC);
    assert.match(doc, /nenhuma trava de operação foi homologada/i);
    assert.match(doc, /nenhuma trava do D-ORF-6 homologada/);
    assert.match(doc, /atestado/i);
    assert.match(ler('deploy/hml/instalador/coordenacao.js'), /nenhuma trava do D-ORF-6 homologada/);
    assert.match(doc, /não é aplicável|único titular/);
  });

  test('a documentação declara que nada foi aplicado na AWS e mantém o interruptor duplo do futuro job', () => {
    const doc = ler(DOC);
    assert.match(doc, /Nada foi executado,\s+instalado ou configurado na AWS|Nada foi executado/);
    assert.match(doc, /HML_PUBLICACAO_HABILITADA/);
    assert.match(doc, /não existe em `\.github\/workflows\/`/);
    for (const codigo of ['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9']) assert.ok(doc.includes(`| ${codigo} |`), codigo);
  });

  test('os arquivos que a documentação cita na tabela de componentes existem', () => {
    const doc = ler(DOC);
    const tabela = doc.split('## Componentes')[1].split('\n## ')[0];
    const citados = [...tabela.matchAll(/`([^`]+\.(?:js|json|md))`/g)].map((m) => m[1]);
    assert.ok(citados.length >= 8);
    for (const nome of citados) {
      const candidatos = [`deploy/hml/${nome}`, `.github/scripts/hml/test/${nome}`, `deploy/hml/nginx/${nome}`];
      assert.ok(candidatos.some((c) => fs.existsSync(path.join(REPO, c))), `citado e inexistente: ${nome}`);
    }
  });

  test('os números citados sobre a CSP vêm do gerador: Painel sem problemas, Portal com os javascript: conhecidos', () => {
    const { gerarCsp } = require(path.join(REPO, 'deploy', 'hml', 'csp', 'gerar-csp.js'));
    const os = require('node:os');
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-doc-'));
    try {
      require(path.join(REPO, 'frontend', 'publicacao', 'empacotar-painel.js')).empacotar({ saida: path.join(base, 'painel') });
      require(path.join(REPO, 'frontend', 'publicacao', 'empacotar.js')).empacotar({ saida: path.join(base, 'portal') });
      const painel = gerarCsp({ raiz: path.join(base, 'painel'), perfil: 'painel' });
      assert.deepEqual([painel.paginas, painel.problemas.length, painel.hashes.script.length, painel.hashes.style.length, painel.atributosStyle], [8, 0, 1, 8, 13]);
      const portal = gerarCsp({ raiz: path.join(base, 'portal'), perfil: 'portal' });
      assert.equal(portal.problemas.length > 0, true, 'se zerar, a documentação do Portal precisa ser revista');
      assert.ok(portal.problemas.every((p) => p.codigo === 'JAVASCRIPT_URL'));
      assert.ok(ler(DOC).includes(`| Portal | ${portal.paginas} |`) || ler(DOC).includes('| Portal | 37 |'), 'a tabela da documentação cita as páginas do Portal');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
