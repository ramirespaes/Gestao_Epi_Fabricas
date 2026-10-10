'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromeDisponivel, medirGeometria, CONJUNTOS } = require('./helpers/geometria-navegador');

/**
 * Coluna Ação visível e utilizável (responsividade real), medida num Chrome headless com a página REAL, em dois conjuntos
 * de conteúdo: textos típicos e textos longos (nome, setor e cargo compridos, como na validação manual).
 *
 * Critério de produto: entre 640 e 900 px (janela dividida no Mac) e no desktop largo, as sete colunas continuam, o documento
 * não rola na horizontal, e a coluna Ação com os seus três botões (Editar, Afastar/Ativar, Inativar) termina INTEIRA dentro da
 * área visível do contêiner da tabela — sem depender de rolagem horizontal para alcançar as ações. Abaixo do ponto de quebra do
 * celular (≤ 600), a rolagem restrita ao .table-wrap continua permitida; o documento nunca rola. Tolerância geométrica de 1 px,
 * só pelo arredondamento da borda de 0,5 px do contêiner.
 *
 * Roda à parte (`node --test test/funcionarios-acao-geometria.navegador.js`): precisa do Chrome local; sem ele, pula.
 * Com GEOMETRIA_SAIDA=<arquivo.json>, grava todas as medições (evidência antes/depois).
 */

const CHROME = chromeDisponivel();
const INTERMEDIARIAS = [640, 680, 700, 720, 756, 800, 850, 900];
const LARGAS = [1024, 1440];
const CELULAR = [500];
const TODAS = [...INTERMEDIARIAS, ...LARGAS, ...CELULAR];

describe('coluna Ação inteira na área visível (Chrome real)', { skip: CHROME ? false : 'Chrome não encontrado neste ambiente' }, () => {
  const por = {};
  before(async () => {
    for (const dados of Object.keys(CONJUNTOS)) {
      const medidas = await medirGeometria(TODAS, { chrome: CHROME, dados });
      por[dados] = Object.fromEntries(medidas.map((m) => [m.vw, m]));
    }
    if (process.env.GEOMETRIA_SAIDA) fs.writeFileSync(path.resolve(process.env.GEOMETRIA_SAIDA), JSON.stringify(por, null, 1));
  }, { timeout: 1200000 });

  const resumo = (m) => `vw=${m.vw} wrap=${m.tabelaWrap && m.tabelaWrap.cw}/${m.tabelaWrap && m.tabelaWrap.sw} visivelAte=${m.acao.visivelAte} ultimaCelula=${m.acao.ultimaCelulaDir} maxBotao=${m.acao.maxBotaoDir} botoes=${JSON.stringify(m.acao.botoes.map((b) => [b.texto, b.dir]))}`;

  for (const dados of Object.keys(CONJUNTOS)) {
    describe(`dados ${dados}`, () => {
      for (const vw of [...INTERMEDIARIAS, ...LARGAS]) {
        test(`${vw} px: sete colunas, documento sem rolagem, coluna Ação e os três botões inteiros dentro do contêiner da tabela`, () => {
          const m = por[dados][vw];
          assert.ok(m && !m.erro && m.linhas > 0, `medição em ${vw}: ${JSON.stringify(m)}`);
          assert.deepEqual(m.acao.colunas.map((c) => c.nome), ['Nome', 'Matrícula', 'Setor', 'Cargo', 'GHE', 'Situação', 'Ação']);
          assert.equal(m.docSW, m.docCW, `documento rola na horizontal: ${resumo(m)}`);
          assert.equal(m.acao.botoes.length, 3, resumo(m));
          assert.equal(m.acao.colunaDentro, true, `coluna Ação cortada: ${resumo(m)}`);
          assert.equal(m.acao.botoesDentro, true, `botão de ação cortado: ${resumo(m)}`);
          assert.ok(m.tabelaWrap.sw <= m.tabelaWrap.cw + 1, `rolagem interna da tabela em ${vw}: ${resumo(m)}`);
        });
      }
      for (const vw of CELULAR) {
        test(`${vw} px (celular): o documento não rola; a tabela pode rolar só dentro do próprio contêiner`, () => {
          const m = por[dados][vw];
          assert.ok(m && !m.erro && m.linhas > 0, JSON.stringify(m));
          assert.equal(m.docSW, m.docCW);
          assert.deepEqual(m.acao.colunas.map((c) => c.nome), ['Nome', 'Matrícula', 'Setor', 'Cargo', 'GHE', 'Situação', 'Ação']);
        });
      }
    });
  }
});
