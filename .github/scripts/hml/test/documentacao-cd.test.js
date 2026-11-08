'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Contratos atuais, registros históricos e barreiras da publicação preparada.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DOC = 'docs/sistema/publicacao-homologacao-componentes.md';

describe('documentação e invariantes do CD de homologação', () => {
  test('os únicos workflows são os conhecidos, incluindo deploy-hml protegido', () => {
    const permitidos = new Set(['ci.yml', 'deploy-hml.yml', 'ensaio-d12-sharp.yml']);
    for (const arquivo of fs.readdirSync(path.join(REPO, '.github', 'workflows'))) assert.ok(permitidos.has(arquivo), `workflow não previsto: ${arquivo}`);
  });

  test('deploy e workflow não contêm credenciais literais nem transportes proibidos', () => {
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

  test('a documentação mantém ausência de operação AWS nesta entrega e os interruptores do job atual', () => {
    const doc = ler(DOC);
    assert.match(doc, /Nada foi executado,\s+instalado ou configurado na AWS|Nada foi executado/);
    assert.match(doc, /HML_PUBLICACAO_HABILITADA/);
    assert.match(doc, /Etapa 52/);
    assert.match(ler('docs/sistema/publicacao-homologacao-automacao.md'), /Não ativada/);
    for (const codigo of ['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9']) assert.ok(doc.includes(`| ${codigo} |`), codigo);
  });

  test('53A diferencia comando operacional, recusa segura e bloqueio crítico sem apagar o histórico', () => {
    const auto = ler('docs/sistema/publicacao-homologacao-automacao.md');
    const evidencia = ler('docs/sistema/etapa52-validacao-local.md');
    const contrato = ler('docs/sistema/publicacao-homologacao.md');
    assert.match(auto, /--pedido <run>-<attempt>` é operacional: pode processar e instalar uma release/);
    assert.doesNotMatch(auto, /--pedido[^\n]*serve para inspeção/);
    assert.match(auto, /RECUSADO/); assert.match(auto, /mutacao=NENHUMA/);
    assert.match(auto, /Falha ao gravar o terminal impede liberar a trava/);
    assert.match(auto, /estado remoto não foi\s+verificado nem alterado/);
    assert.match(auto, /Limitações que exigem aceite explícito/);
    assert.match(evidencia, /22\/22 hashes conferidos e estado `APLICADO`/);
    assert.match(evidencia, /Registro histórico da preparação anterior/);
    assert.match(contrato, /Ações de `deploy-hml.yml` fixadas por SHA completo/);
    assert.match(contrato, /Os testes do workflow são estáticos/);
    assert.match(ler(DOC), /Histórico do desenho do job `publicar` — superado/);
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

  test('os números citados sobre a CSP vêm do gerador: Painel e Portal sem problemas (Portal desde a P-HML-02)', () => {
    const { gerarCsp } = require(path.join(REPO, 'deploy', 'hml', 'csp', 'gerar-csp.js'));
    const os = require('node:os');
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-doc-'));
    try {
      require(path.join(REPO, 'frontend', 'publicacao', 'empacotar-painel.js')).empacotar({ saida: path.join(base, 'painel') });
      require(path.join(REPO, 'frontend', 'publicacao', 'empacotar.js')).empacotar({ saida: path.join(base, 'portal') });
      const painel = gerarCsp({ raiz: path.join(base, 'painel'), perfil: 'painel' });
      assert.deepEqual([painel.paginas, painel.problemas.length, painel.hashes.script.length, painel.hashes.style.length, painel.atributosStyle], [8, 0, 1, 8, 13]);
      const portal = gerarCsp({ raiz: path.join(base, 'portal'), perfil: 'portal' });
      assert.equal(portal.problemas.length, 0, 'se voltar a haver problemas, a documentação do Portal precisa ser revista');
      assert.deepEqual([portal.paginas, portal.hashes.script.length, portal.hashes.style.length, portal.hashes.manipuladores.length, portal.atributosStyle], [37, 24, 26, 2, 1267]);
      assert.ok(ler(DOC).includes(`| Portal | ${portal.paginas} |`) || ler(DOC).includes('| Portal | 37 |'), 'a tabela da documentação cita as páginas do Portal');
      assert.ok(ler(DOC).includes('P-HML-02'), 'a documentação registra a correção que liberou a CSP do Portal');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
