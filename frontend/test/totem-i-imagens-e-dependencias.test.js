'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * Etapa I (RED) — imagens (placeholder aprovado, sem upload nem URL improvisada), ícones locais (Q3) e dependências futuras.
 * A biblioteca de imagens da Gestão de Estoque NÃO existe: o contrato atual devolve `imagem: { disponivel: false }` e o E15
 * segue pendente. Nada aqui cria imagem, upload ou armazenamento.
 */

describe('[IMG] uso seguro do placeholder atual', () => {
  test('[IMG-01] cada cartão de produto usa o placeholder quadriculado aprovado (.vazio) e nenhuma <img>', async () => {
    const t = await H.abrirNoCatalogo();
    const cartoes = t.consulta('#grade .prod');
    assert.equal(cartoes.length, H.CATALOGO.length);
    for (const c of cartoes) assert.ok(c.querySelector('.vazio'), 'placeholder ausente');
    assert.equal(t.consulta('#grade img').length, 0);
    await t.abrirProduto('Botina de Segurança');
    assert.equal(t.consulta('#detImg img').length, 0);
    assert.ok(t.consulta('#detImg .vazio').length >= 1);
  });

  test('[IMG-02] uma imagem "disponível" com URL externa (contrato futuro, ainda inexistente) NÃO é usada: sem <img>, sem requisição externa', async () => {
    const materiais = H.CATALOGO.map((m) => ({ ...m, imagem: { disponivel: true, url: 'https://externo.invalido/foto.png' } }));
    const t = await H.abrirNoCatalogo({ servidor: H.criarServidor({ materiais }) });
    assert.equal(t.consulta('img').length, 0);
    assert.deepEqual(t.externas, []);
  });

  test('[IMG-03] nada de upload, fotos embutidas, URLs de imagem ou armazenamento paralelo de fotografias', () => {
    const { semComentarios, html } = H.corpus();
    assert.ok(!/type="file"|FormData|<canvas/i.test(`${semComentarios}\n${html}`), 'upload ou captura de imagem');
    // 11/2026 (HML): a CSP do Portal admite só 'self' e data: em img-src, então `blob:` é BLOQUEADO. A fotografia recebida da API (Blob da resposta do fetch)
    // passa a ser apresentada como `data:image/webp;base64,`, e `createObjectURL` volta a ser proibido em qualquer ponto. O `FileReader` só existe para essa
    // conversão: uma única instância, só `readAsDataURL`, só sobre o Blob da resposta já validado e tipado como image/webp. O comportamento (validação, aborto,
    // falhas) é coberto por totem-imagens.test.js ([IMG-G*]); aqui só a presença de texto.
    assert.ok(!/createObjectURL|revokeObjectURL|['"`]blob:/i.test(`${semComentarios}\n${html}`), 'blob:/createObjectURL é bloqueado pela CSP da HML e não pode voltar');
    assert.equal((semComentarios.match(/\bFileReader\b/g) || []).length, 1, 'uma única referência a FileReader');
    assert.equal((semComentarios.match(/new FileReader\(\)/g) || []).length, 1);
    assert.deepEqual(semComentarios.match(/\.read[A-Za-z]+\(/g).filter((m) => /^\.read(AsDataURL|AsText|AsArrayBuffer|AsBinaryString)\($/.test(m)), ['.readAsDataURL('], 'só readAsDataURL');
    assert.equal((semComentarios.match(/readAsDataURL\(blob\.slice\(0, blob\.size, 'image\/webp'\)\)/g) || []).length, 1, 'a leitura é do Blob validado, com tipo fixado');
    const conversao = /function lerComoDataUrl\([\s\S]*?\n  \}\n/.exec(semComentarios);
    assert.ok(conversao, 'função de conversão encontrada');
    assert.equal((semComentarios.match(/data:image\//gi) || []).length, (conversao[0].match(/data:image\//gi) || []).length, 'o prefixo data:image/ só aparece na função de conversão');
    assert.ok(!/data:image\//i.test(html), 'imagem embutida no HTML');
    assert.ok(!/https?:\/\/[^\s"')]+\.(png|jpe?g|webp|gif)/i.test(`${semComentarios}\n${html}`), 'URL de imagem fixa');
  });

  test('[IMG-04] o corpo do catálogo consumido pela página é o contrato atual: a imagem é sempre { disponivel: false }', async () => {
    const servidor = H.criarServidor();
    await H.abrirNoCatalogo({ servidor });
    for (const m of servidor.materiais) assert.deepEqual(H.plano(m.imagem), { disponivel: false });
  });
});

describe('[Q3] ícones locais, sem fonte externa', () => {
  test('[IMG-10] os ícones vêm de SVG local ou de fonte local: nenhuma fonte de ícones do Google, nenhum ícone escrito como texto de ligadura sem fonte', () => {
    const { html, css, semComentarios } = H.corpus();
    const todo = `${html}\n${css}`;
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(todo), 'fonte externa');
    const svgs = (html.match(/<svg\b/g) ?? []).length + (semComentarios.match(/createElementNS/g) ?? []).length;
    const fonteLocal = /@font-face[^}]*url\(\s*["']?(?!https?:|\/\/|data:)[^)"']+/.test(todo.replace(/\s+/g, ' '));
    assert.ok(svgs >= 9 || fonteLocal, `ícones: ${svgs} SVG e fonte local = ${fonteLocal}`);
  });
});

describe('[DEP] dependências futuras (registradas, sem teste executável agora)', () => {
  test.todo('[DEP-01] E15 — imagem associada ao material físico correto e à empresa correta, nunca só pelo nome — BLOQUEADO: a biblioteca de imagens da Gestão de Estoque não existe (K4 afirma a ausência); depende de decisão de estrutura e armazenamento');
  test.todo('[DEP-02] foto real no cartão do produto servida pela própria API ao tablet autenticado, mesma origem, sem URL externa — BLOQUEADO: depende da biblioteca de imagens');
  test.todo('[DEP-03] leitura e consumo reais do QR com a câmera nativa de um tablet Android em modo quiosque — BLOQUEADO: tablet real');
  test.todo('[DEP-04] histórico do navegador e do aplicativo de câmera não guardam o código do fragmento — BLOQUEADO: tablet real');
  test.todo('[DEP-05] modo quiosque gerenciado: recarga, "voltar" e troca de aplicativo bloqueados — BLOQUEADO: tablet real');
  test.todo('[DEP-06] rede corporativa autorizada, IP de saída estável e TRUST_PROXY_HOPS com a topologia real — BLOQUEADO: ambiente real (Etapa K)');
  test.todo('[DEP-07] HTTPS, cookies Secure e a mesma origem app.safeworkengenharia.com.br em produção — BLOQUEADO: publicação AWS (Etapa K)');
  test.todo('[DEP-08] 60 s reais e toques rápidos em tablet; perda e retomada da conexão; rotação de tela e modo escuro — BLOQUEADO: tablet real');
});
