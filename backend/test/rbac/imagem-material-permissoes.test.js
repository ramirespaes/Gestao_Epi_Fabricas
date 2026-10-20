'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO, RECURSOS_CONHECIDOS } = require('../../src/rbac/recursos');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — PERMISSÕES, no nível do contrato de serviço (as rotas e o middleware vêm numa unidade própria). Matriz do
 * doc. 03 (alternativa A, recomendada, SEM RBAC novo): tudo reutiliza o recurso `materials` e seus toggles já existentes — ver, escolher e consultar =
 * `materials.visualizar`; importar e associar ao CRIAR o material = `materials.criar`; renomear, inativar, reativar e associar ao EDITAR = `materials.editar`.
 * A biblioteca padrão não é gravável por nenhuma permissão de cliente. O serviço não decide autorização (provado em imagem-material.service.test.js); aqui
 * se prova que a matriz existe, é a do doc. 03, aponta só para o que tem efeito real e NÃO criou recurso, ação, toggle nem migration de RBAC.
 */

const matriz = () => exigirModulo('src/rbac/imagem-material-permissoes').PERMISSOES_IMAGEM_MATERIAL;

const ESPERADA = {
  listar: ['materials', 'visualizar'],
  visualizarArquivo: ['materials', 'visualizar'],
  importar: ['materials', 'criar'],
  associarAoCriarMaterial: ['materials', 'criar'],
  associarAoEditarMaterial: ['materials', 'editar'],
  renomear: ['materials', 'editar'],
  inativar: ['materials', 'editar'],
  reativar: ['materials', 'editar'],
  // Exclusão de imagem PRIVADA da empresa (V7, seção 2): operação destrutiva da biblioteca, só de quem edita materiais; nunca da biblioteca padrão.
  excluir: ['materials', 'editar'],
};

describe('matriz de permissões da Biblioteca de Imagens (doc. 03, alternativa A)', () => {
  test('é congelada e é exatamente a matriz aprovada: cada capacidade exige a operação do recurso `materials` indicada', () => {
    const m = matriz();
    assert.equal(Object.isFrozen(m), true);
    assert.deepEqual(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [v.recurso, v.operacao]])), ESPERADA);
  });

  test('toda capacidade aponta para recurso e operação que existem e TÊM efeito real (RECURSOS_COM_EFEITO) — nenhuma permissão decorativa', () => {
    for (const [capacidade, { recurso, operacao }] of Object.entries(matriz())) {
      const r = RECURSOS_COM_EFEITO.find((x) => x.recurso === recurso);
      assert.ok(r, `${capacidade}: recurso ${recurso} sem efeito`);
      assert.ok(r.operacoes.includes(operacao), `${capacidade}: operação ${operacao} sem efeito em ${recurso}`);
    }
  });

  test('não há capacidade de escrever na biblioteca padrão (ela é global e administrada só pelo operador da plataforma)', () => {
    for (const nome of Object.keys(matriz())) assert.equal(/padrao/i.test(nome), false, nome);
  });

  test('SEM RBAC novo: nenhum recurso, ação ou toggle de imagem foi criado; os conjuntos existentes não ganharam nada com "imagem"', () => {
    assert.equal(RECURSOS_CONHECIDOS.some((r) => /imag/i.test(String(r.recurso ?? r))), false, 'recurso novo de imagem');
    assert.equal(ACOES_COM_EFEITO.some((a) => /IMAG/i.test(a)), false, 'ação nova de imagem');
    const toggles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'rbac', 'toggles.js'), 'utf8');
    assert.equal(/imag/i.test(toggles), false, 'toggle novo de imagem');
  });

  test('a migration 090 não semeia permissão (nenhum INSERT em acoes, perfis_permissoes ou semelhantes)', () => {
    const dir = path.join(__dirname, '..', '..', 'migrations');
    const arquivo = fs.readdirSync(dir).find((n) => n.startsWith('090_'));
    assert.ok(arquivo, 'migration 090 existe');
    const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8').replace(/--.*$/gm, '');
    assert.equal(/\bINSERT\s+INTO\b/i.test(sql), false);
  });
});
