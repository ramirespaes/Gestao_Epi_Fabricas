'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * P2 — guarda estática sobre a ÁRVORE REAL do backend (somente leitura). Dois níveis, de propósito separados:
 *  1. "nenhuma ocorrência desconhecida": toda escrita, remoção, raiz, migration, dependência e rota tem entrada na linha de base;
 *  2. "GATE HUMANO": a linha de base foi aprovada ocorrência por ocorrência pela autoridade do projeto. Fica VERMELHO até lá.
 * A guarda impede declarar protegido o que não foi registrado; não prova ausência de armazenamento fora do que analisa (limites no núcleo).
 */

const G = () => require('../helpers/backup-guarda-analise');
const RAIZ = path.join(__dirname, '..', '..');
let resultado = null;
const analisar = () => {
  if (resultado === null) {
    const listas = require('./escritores-conhecidos');
    const { obterCatalogo } = exigirModulo('src/services/backup-fontes-catalogo.service');
    resultado = G().analisarArvore(G().provedorDeDisco(RAIZ), obterCatalogo(), listas);
  }
  return resultado;
};
const codigos = (r) => r.violacoes.map((v) => v.codigo);
// Pendências que só a revisão humana (ou uma comprovação dinâmica futura) resolve; tudo o mais é defeito de linha de base.
const PENDENCIAS_HUMANAS = ['EXCECAO_NAO_REVISADA', 'EXCECAO_PENDENTE_DE_COMPROVACAO'];
const semGateHumano = (r) => r.violacoes.filter((v) => !PENDENCIAS_HUMANAS.includes(v.codigo));

describe('P2 — guarda sobre a árvore real', () => {
  test('a árvore é lida por completo, todas as regras executam e nenhum detector falha internamente', () => {
    const r = analisar();
    assert.ok(r.varridos >= 1000, `varridos=${r.varridos}`);
    assert.deepEqual(r.regrasExecutadas, G().REGRAS);
    assert.deepEqual(codigos(r).filter((c) => ['ERRO_INTERNO_DO_DETECTOR', 'FALHA_DE_LEITURA', 'PROVEDOR_INVALIDO', 'LISTAS_INVALIDAS', 'CATALOGO_INVALIDO', 'ARVORE_VAZIA', 'ARVORE_INSUFICIENTE'].includes(c)), []);
  });

  test('nenhuma ocorrência desconhecida: toda escrita, remoção, raiz, migration, dependência e rota está na linha de base, sinal a sinal', () => {
    const r = analisar();
    assert.deepEqual(semGateHumano(r), [], JSON.stringify(semGateHumano(r), null, 1));
    assert.ok(r.ocorrencias.length >= 100, `ocorrencias=${r.ocorrencias.length}`);
    assert.deepEqual(r.ocorrencias.filter((o) => o.classificacao === 'NAO_CLASSIFICADA'), []);
    assert.equal(r.links, 0, 'nenhum link simbólico na árvore analisada');
    // Os mapas da linha de base são exatamente os reconciliados pelo núcleo (nenhum sinal a mais, a menos ou trocado).
    const mapas = G().mapasDeSinais(r);
    const listas = require('./escritores-conhecidos');
    for (const [arquivo, m] of Object.entries(mapas.ESCRITORES)) assert.deepEqual(listas.ESCRITORES_CONHECIDOS[arquivo].ocorrencias, m, arquivo);
    for (const [arquivo, m] of Object.entries(mapas.MIGRATIONS)) assert.deepEqual(listas.MIGRATIONS_CONHECIDAS[arquivo].ocorrencias, m, arquivo);
    for (const [arquivo, m] of Object.entries(mapas.ROTAS)) assert.deepEqual(listas.ROTAS_BINARIAS_CONHECIDAS[arquivo].ocorrencias, m, arquivo);
    assert.deepEqual(listas.NOMES_QUE_NAO_SAO_RAIZ, mapas.EXCECOES_G1);
  });

  test('a aprovação humana é rastreável entrada por entrada: cada uma aponta para um registro de APROVACOES cujo documento existe na árvore com o SHA-256 declarado; sharp deixou de ser pendência de comprovação', () => {
    const r = analisar();
    const listas = require('./escritores-conhecidos');
    assert.equal(listas.DEPENDENCIAS_REVISADAS.sharp.classificacao, 'PROCESSAMENTO_SEM_PERSISTENCIA');
    assert.ok(!r.violacoes.some((v) => v.codigo === 'EXCECAO_PENDENTE_DE_COMPROVACAO'));
    assert.ok(listas.APROVACOES.length >= 1, 'existe registro de aprovação');
    const refs = new Set(listas.APROVACOES.map((a) => a.ref));
    for (const a of listas.APROVACOES) {
      assert.match(a.ref, G().RE_APROVACAO_REF);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!r.violacoes.some((v) => v.codigo === 'REGISTRO_DE_APROVACAO_INVALIDO' && v.arquivo === a.documento), `documento de ${a.ref} presente e íntegro`);
    }
    // Cada entrada está em UM de dois estados rastreáveis: APROVADA com data e referência declarada, ou PENDENTE sem nenhum dado de aprovação
    // (entrada nova desde o gate de 2026-11-02, aguardando decisão humana; é o GATE HUMANO abaixo que a deixa vermelha, não este teste).
    const aprovadas = [];
    const pendentes = [];
    for (const lista of ['ESCRITORES_CONHECIDOS', 'ROTAS_BINARIAS_CONHECIDAS', 'MIGRATIONS_CONHECIDAS', 'DEPENDENCIAS_REVISADAS']) {
      for (const [chave, e] of Object.entries(listas[lista])) {
        if (e.revisaoHumana === 'APROVADA') {
          assert.match(e.aprovadoEm, /^\d{4}-\d{2}-\d{2}$/, `${lista}:${chave}`);
          assert.ok(refs.has(e.aprovacaoRef), `${lista}:${chave} aponta para registro declarado`);
          aprovadas.push(chave);
        } else {
          assert.equal(e.revisaoHumana, 'PENDENTE', `${lista}:${chave}`);
          assert.deepEqual([e.aprovadoEm, e.aprovacaoRef], [null, null], `${lista}:${chave}: pendente não carrega dados de aprovação`);
          pendentes.push(chave);
        }
      }
    }
    assert.ok(aprovadas.length >= 44, `as 44 entradas do gate de 2026-11-02 seguem aprovadas (${aprovadas.length})`);
    assert.ok(pendentes.every((c) => !['sharp'].includes(c)), 'sharp não volta a pendente');
  });

  test('o inventário nunca carrega conteúdo de linha, caminho absoluto ou segredo', () => {
    const texto = JSON.stringify(analisar());
    assert.doesNotMatch(texto, /\/Users\/|\/home\/|\/var\/|\/tmp\//);
    assert.doesNotMatch(texto, /require\(|await |function |=>/);
    assert.doesNotMatch(texto, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|password=|senha=/i);
  });

  test('os limites da guarda estão declarados no próprio núcleo', () => {
    const fs = require('node:fs');
    const nucleo = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'backup-guarda-analise.js'), 'utf8');
    for (const limite of ['processo filho', 'dependência transitiva', 'caminho construído dinamicamente', 'serviço externo', 'COPY/lo_export', 'rotinas operacionais', 'não são cobertura comprovada', 'não é seguido', 'validação operacional de raízes', 'não a identidade de quem o assinou']) {
      assert.ok(nucleo.includes(limite), `limite não declarado: ${limite}`);
    }
  });

  test('GATE HUMANO — a linha de base foi aprovada ocorrência por ocorrência (fica vermelho até a aprovação de Ramires)', () => {
    const r = analisar();
    const pendentes = r.violacoes.filter((v) => PENDENCIAS_HUMANAS.includes(v.codigo)).map((v) => `${v.codigo}:${v.detalhe}:${v.arquivo}`);
    assert.deepEqual(pendentes, [], `entradas aguardando revisão humana ou comprovação (${pendentes.length}): ${pendentes.join(' | ')}`);
    assert.equal(r.aprovado, true);
  });
});
