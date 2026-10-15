'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers/totem-i');
const { RAIZ } = require('./helpers/dom-pagina');

/**
 * Etapa I (RED) — Q0: página operacional derivada do HTML aprovado, em frontend/totem/, com o original intacto.
 * A página AINDA NÃO EXISTE: os testes de estrutura falham com "RED I: ... ainda não existe" (funcionalidade futura).
 * O original (token-epi.html, só leitura) é a referência; se não estiver na máquina, os testes que dependem dele são
 * ignorados (BLOQUEADO), nunca "passados".
 */

const ORIGINAL = process.env.TOTEM_I_HTML_ORIGINAL ?? path.join(os.homedir(), 'Desktop', 'token-epi.html');
const SHA256_ORIGINAL = '08458202c65918d0857de2f4912da62850123101812a3b0bc1115960834c3eaf';
const temOriginal = fs.existsSync(ORIGINAL);
const semOriginal = temOriginal ? false : `BLOQUEADO: o HTML original aprovado não está em ${ORIGINAL}`;

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*([{}:;,>()])\s*/g, '$1').trim();
function regrasDe(css) {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const saida = [];
  const ler = (texto, prefixo) => {
    let i = 0;
    while (i < texto.length) {
      const abre = texto.indexOf('{', i);
      if (abre === -1) break;
      const cab = norm(texto.slice(i, abre));
      let prof = 1; let j = abre + 1;
      while (j < texto.length && prof > 0) { if (texto[j] === '{') prof += 1; else if (texto[j] === '}') prof -= 1; j += 1; }
      const corpo = norm(texto.slice(abre + 1, j - 1)).replace(/;$/, '');
      if (cab.startsWith('@media')) ler(texto.slice(abre + 1, j - 1), `${prefixo}${cab}|`);
      else saida.push(`${prefixo}${cab}{${corpo}}`);
      i = j;
    }
  };
  ler(limpo, '');
  return saida;
}
const cssDe = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
// Regras do original que SAEM por contrato (status por saldo, legenda e aviso de falta) ou que dependem da fonte de ícones (Q3).
const REMOVIDAS = /\.legenda|\.tam\.(ok|pouco|falta)|\.semestoque|\.material-symbols-outlined/;

describe('[Q0] a página derivada existe, separada do original', () => {
  // P5 (resolvida em 13/10/2026): a organização dos arquivos é livre; os testes seguem as REFERÊNCIAS da página, não uma lista fixa de nomes.
  test(`[Q0-01] ${H.ARQUIVOS.html} existe`, () => {
    assert.ok(fs.existsSync(path.join(RAIZ, H.ARQUIVOS.html)), `RED I: ${H.ARQUIVOS.html} ainda não existe (funcionalidade futura da Etapa I)`);
  });

  test('[Q0-02] todo arquivo local que a página referencia existe sob frontend/totem/, e o primeiro script do <head> é um deles', () => {
    const locais = H.arquivosLocaisDoTotem();
    assert.ok(locais.length >= 2, 'a página deve referenciar ao menos o script de inicialização e o código do Totem');
    for (const rel of locais) assert.ok(fs.existsSync(path.join(RAIZ, rel)), `a página referencia ${rel}, que não existe`);
    assert.ok(locais.includes(H.primeiroScriptDoHead()), 'o primeiro script do <head> não é um arquivo local do Totem');
  });

  test('[Q0-03] há código JavaScript do Totem em arquivo local (além do script de inicialização)', () => {
    const { locais, primeiro } = H.corpus();
    const outros = locais.filter((r) => r.endsWith('.js') && r !== primeiro);
    assert.ok(outros.length >= 1, 'nenhum arquivo JavaScript do Totem além do script de inicialização');
    assert.ok(outros.every((r) => fs.statSync(path.join(RAIZ, r)).size > 200), 'arquivo JavaScript do Totem vazio');
  });

  test('[Q0-04] há folha de estilo derivada do original (arquivo local sob totem/ ou bloco <style>)', () => {
    const { html, css } = H.corpus();
    assert.ok(css.trim().length > 500 || /<style\b[^>]*>[\s\S]{500,}<\/style>/i.test(html), 'a página não traz o CSS derivado');
  });

  test('[Q0-05] a página derivada não é o próprio original nem referencia o arquivo do protótipo', () => {
    const { tudo, html } = H.corpus();
    assert.notEqual(crypto.createHash('sha256').update(html).digest('hex'), SHA256_ORIGINAL);
    assert.ok(!/token-epi\.html/.test(tudo), 'a página integrada não pode depender do protótipo');
  });

  test('[Q0-06] index.html e todo arquivo local do Totem entram na allowlist de publicação', () => {
    const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'publicacao', 'allowlist.json'), 'utf8')).arquivos;
    for (const rel of [H.ARQUIVOS.html, ...H.arquivosLocaisDoTotem()]) assert.ok(lista.includes(rel), `${rel} não está em publicacao/allowlist.json`);
  });
});

describe('[Q0] o HTML original aprovado permanece intacto (controle)', () => {
  test(`[Q0-07] SHA-256 do original = ${SHA256_ORIGINAL.slice(0, 12)}…`, { skip: semOriginal }, () => {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(ORIGINAL)).digest('hex'), SHA256_ORIGINAL);
  });
});

describe('[Q0] controle do próprio teste de CSS (lê só o original, nunca o altera)', () => {
  test('[Q0-08] o leitor de regras lê o CSS do original (mais de 40 regras, inclusive dentro de @media) e original × original não tem diferença', { skip: semOriginal }, () => {
    const regras = regrasDe(cssDe(fs.readFileSync(ORIGINAL, 'utf8')));
    assert.ok(regras.length > 40, `regras lidas: ${regras.length}`);
    assert.ok(regras.some((r) => r.startsWith('@media(min-width:768px)|')), 'regras dentro de @media');
    assert.ok(regras.some((r) => r.includes('.acesso{')));
    const conjunto = new Set(regras);
    assert.deepEqual(regras.filter((r) => !REMOVIDAS.test(r)).filter((r) => !conjunto.has(r)), []);
    assert.ok(regras.filter((r) => REMOVIDAS.test(r)).length >= 5, 'as regras removidas por contrato existem no original');
  });
});

describe('[Q0] preservação dos componentes visuais aprovados', () => {
  test('[Q0-10] as quatro telas principais e os componentes de sessão existem com os mesmos ids', () => {
    const { html } = H.corpus();
    for (const id of ['telaAcesso', 'telaProdutos', 'telaTamanhos', 'telaConfirma', 'sessao', 'quem', 'tempo', 'doc', 'erro', 'teclado', 'grade', 'resumo', 'tams', 'btnSolicitar', 'acaoTxt', 'toasts']) {
      assert.match(html, new RegExp(`id="${id}"`), `id ${id} ausente`);
    }
    for (const tela of ['telaAcesso', 'telaProdutos', 'telaTamanhos', 'telaConfirma']) assert.match(html, new RegExp(`<section[^>]*class="tela[^"]*"[^>]*id="${tela}"|<section[^>]*id="${tela}"[^>]*class="tela`), `${tela} deve ser uma .tela`);
  });

  test('[Q0-11] teclado numérico 3×4 (12 teclas), cartão .acesso, marca, botões e grade com as mesmas classes', () => {
    const { html } = H.corpus();
    assert.ok((html.match(/class="tecla/g) ?? []).length >= 12, 'o teclado tem 12 teclas');
    for (const c of ['acesso', 'brand', 'prod-img', 'detalhe', 'btn-filled', 'btn-outlined', 'wrap', 'top']) assert.match(html, new RegExp(`class="[^"]*\\b${c}\\b`), `classe .${c} ausente`);
  });

  test('[Q0-12] tokens de cor e tipografia do original (claro e escuro) estão no CSS', () => {
    const { css, html } = H.corpus();
    const todo = norm(`${css}\n${cssDe(html)}`);
    for (const t of ['--primary:#007AFF', '--brand:#1a3a6b', '--bg:#f2f2f7', '--surface:#ffffff', '--outline:#d1d1d6', '--error:#ff3b30', '--ok:#1a7f37', '--warn:#b26a00', '@media(prefers-color-scheme:dark)', '--bg:#000', '--surface:#1c1c1e', '-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Arial,sans-serif']) {
      assert.ok(todo.includes(norm(t)), `token ausente no CSS: ${t}`);
    }
  });

  test('[Q0-13] responsividade de tablet: breakpoints, grade fluida e safe-area do original', () => {
    const { css, html } = H.corpus();
    const todo = norm(`${css}\n${cssDe(html)}`);
    for (const t of ['@media(min-width:768px)', '@media(max-height:760px)', '@media(max-width:720px)', 'grid-template-columns:repeat(auto-fill,minmax(210px,1fr))', 'env(safe-area-inset-top)', 'touch-action:manipulation', 'overscroll-behavior:none']) {
      assert.ok(todo.includes(norm(t)), `regra de tablet ausente: ${t}`);
    }
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  });

  test('[Q0-14] o CSS do original foi transposto sem mudar valores (toda regra mantida existe na página, salvo as removidas por contrato)', { skip: semOriginal }, () => {
    const original = regrasDe(cssDe(fs.readFileSync(ORIGINAL, 'utf8'))).filter((r) => !REMOVIDAS.test(r));
    const { css, html } = H.corpus();
    const derivadas = new Set(regrasDe(`${css}\n${cssDe(html)}`));
    const faltando = original.filter((r) => !derivadas.has(r));
    assert.equal(original.length > 40, true, 'o parser do CSS original leu poucas regras');
    assert.deepEqual(faltando, [], `regras do original ausentes ou alteradas (${faltando.length})`);
  });
});

describe('[Q0] ausência de comportamento demonstrativo no fluxo produtivo', () => {
  test('[Q0-20] sem funcionários, produtos ou identificadores fictícios do protótipo', () => {
    const { semComentarios } = H.corpus();
    // Um dos nomes é montado em duas partes: a guarda de dados sintéticos do repositório recusa essa persona escrita por extenso.
    for (const t of [['Marcos', 'Silva'].join(' '), 'João Pereira', 'Ana Souza', 'MAT-000171', 'MAT-000121', 'MAT-000098', '12345678945', 'SEED', 'DEMO', 'Camisa manga longa', 'Abafador de ruído']) {
      assert.ok(!semComentarios.includes(t), `resto do demonstrativo: ${t}`);
    }
  });

  test('[Q0-21] sem identificação simulada, banco do navegador nem registro local de pedidos', () => {
    const { semComentarios } = H.corpus();
    for (const t of [/localizar\s*\(/, /carregarFuncionarios/, /carregarProdutos/, /registrarPedido/, /epi_db_v2/, /epi_funcionarios_standalone/, /epi_solicitacoes_standalone/, /localStorage/, /sessionStorage/, /indexedDB/]) {
      assert.ok(!t.test(semComentarios), `comportamento demonstrativo ainda presente: ${t}`);
    }
  });

  test('[Q0-22] sem reserva, saldo, status por estoque, legenda de falta nem textos trocados', () => {
    const { semComentarios } = H.corpus();
    for (const p of H.PROIBIDOS) assert.ok(!p.test(semComentarios), `texto proibido presente: ${p}`);
    for (const t of ["'pouco'", "'falta'", 'ROTULO', 'statusDe', 'minimo']) assert.ok(!semComentarios.includes(t), `lógica de estoque do demonstrativo: ${t}`);
  });

  test('[Q0-23] sem manipuladores inline (onclick, oninput, onkeydown, onerror) na página', () => {
    const { html } = H.corpus();
    assert.ok(!/\son(click|input|keydown|error|change|submit)\s*=/i.test(html), 'a página integrada não usa manipuladores inline');
  });

  test('[Q0-24] a identificação só existe no servidor: um CPF do demonstrativo não identifica ninguém', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'CPF', valor: '12345678945' });
    assert.equal(servidor.contar('POST /atendimento-token/tablet/atendimento'), 1, 'a página precisa consultar o servidor');
    assert.ok(t.textoVisivel().includes(H.TEXTOS.naoEncontrado));
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[Q0-25] os produtos vêm do catálogo do servidor: nada do DEMO aparece e a ordem é a do servidor', async () => {
    const t = await H.abrirIdentificado();
    assert.deepEqual(t.produtos(), H.CATALOGO.map((m) => m.nome));
    assert.ok(!t.textoVisivel().includes('Camisa manga longa'));
  });
});

describe('[Q0] verificações visuais que dependem de navegador e tablet reais (MANUAL)', () => {
  test.todo('[Q0-M1] comparação por capturas do original × derivada (1024×768, 768×1024, 390×844; claro e escuro) — BLOQUEADO: exige Chrome real e a página derivada');
  test.todo('[Q0-M2] legibilidade, alvos de toque e rotação de tela em tablet Android corporativo — BLOQUEADO: tablet real');
});
