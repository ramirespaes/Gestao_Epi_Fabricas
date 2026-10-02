'use strict';

const { escaparHtml } = require('../escapar');
const { CID_MARCA } = require('../marca');

/**
 * Layout transacional SafeWork. HTML feito para clientes de e-mail: tabelas,
 * CSS inline, sem JavaScript, sem recurso externo; a marca vai por CID. O modo
 * escuro é só melhoria progressiva (media query), com o claro como base.
 * Quem chama passa texto já limpo; aqui tudo é escapado no HTML.
 */

const COR = Object.freeze({
  tinta: '#153333', suave: '#617471', acento: '#1f7563', cartao: '#ffffff', fundo: '#f7f8f6', linha: '#e3e9e5',
});
const FONTE = 'Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif';

const ESTILO_ESCURO = `
@media (prefers-color-scheme: dark) {
  .fundo { background-color:#151b1a !important; }
  .cartao { background-color:#1f2826 !important; border-color:#33403d !important; }
  .tinta { color:#e8f0ed !important; }
  .suave { color:#a2b3af !important; }
  .botao, .botao a { background-color:#26806b !important; }
  .link { color:#6cc9b0 !important; }
}
@media only screen and (max-width:620px) {
  .conteudo { width:100% !important; }
  .miolo { padding:26px 20px 22px 20px !important; }
}`;

function paragrafoHtml(texto) {
  return `<p class="tinta" style="margin:0 0 14px 0;font-family:${FONTE};font-size:15px;line-height:1.55;color:${COR.tinta};">${escaparHtml(texto)}</p>`;
}

function notaHtml(texto) {
  return `<p class="suave" style="margin:0 0 10px 0;font-family:${FONTE};font-size:13px;line-height:1.5;color:${COR.suave};">${escaparHtml(texto)}</p>`;
}

function botaoHtml({ rotulo, link }) {
  const href = escaparHtml(link);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px 0;"><tr>`
    + `<td class="botao" style="border-radius:11px;background-color:${COR.acento};">`
    + `<a href="${href}" style="display:inline-block;padding:14px 26px;font-family:${FONTE};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:11px;background-color:${COR.acento};">${escaparHtml(rotulo)}</a>`
    + `</td></tr></table>`
    + `<p class="suave" style="margin:0 0 18px 0;font-family:${FONTE};font-size:13px;line-height:1.5;color:${COR.suave};">Se o botão não abrir, copie e cole este endereço no navegador:<br>`
    + `<a class="link" href="${href}" style="color:${COR.acento};word-break:break-all;">${escaparHtml(link)}</a></p>`;
}

function montarHtml({ titulo, preheader, paragrafos, cta, notas, suporte }) {
  const corpo = [
    `<h1 class="tinta" style="margin:0 0 16px 0;font-family:${FONTE};font-size:21px;font-weight:700;line-height:1.25;letter-spacing:-0.02em;color:${COR.tinta};">${escaparHtml(titulo)}</h1>`,
    ...paragrafos.map(paragrafoHtml),
    cta ? botaoHtml(cta) : '',
    ...notas.map(notaHtml),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escaparHtml(titulo)}</title>
<style>${ESTILO_ESCURO}
</style>
</head>
<body class="fundo" style="margin:0;padding:0;background-color:${COR.fundo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${COR.fundo};">${escaparHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fundo" style="background-color:${COR.fundo};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="conteudo" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
<tr><td style="padding:0 0 18px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding:0 12px 0 0;"><img src="cid:${CID_MARCA}" width="48" height="48" alt="SafeWork Engenharia" style="display:block;border:0;width:48px;height:48px;"></td>
<td class="tinta" style="font-family:${FONTE};font-size:17px;font-weight:700;letter-spacing:-0.04em;color:${COR.tinta};">SafeWork <span class="suave" style="font-weight:400;color:${COR.suave};">Engenharia</span></td>
</tr></table>
</td></tr>
<tr><td class="cartao miolo" style="background-color:${COR.cartao};border:1px solid ${COR.linha};border-radius:17px;padding:32px 32px 24px 32px;">
${corpo}
</td></tr>
<tr><td style="padding:18px 8px 0 8px;">
<p class="suave" style="margin:0 0 6px 0;font-family:${FONTE};font-size:12px;line-height:1.5;color:${COR.suave};">Dúvidas? Fale com o suporte: ${escaparHtml(suporte)}</p>
<p class="suave" style="margin:0;font-family:${FONTE};font-size:12px;line-height:1.5;color:${COR.suave};">Esta é uma mensagem automática; não responda a este e-mail.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function montarTexto({ titulo, paragrafos, cta, notas, suporte }) {
  const partes = [titulo, ...paragrafos];
  if (cta) {
    partes.push(`${cta.rotulo}:\n${cta.link}`);
  }
  partes.push(...notas);
  partes.push(`Dúvidas? Fale com o suporte: ${suporte}\nEsta é uma mensagem automática; não responda a este e-mail.\n\nSafeWork Engenharia`);
  return `${partes.join('\n\n')}\n`;
}

function montar(estrutura) {
  return { texto: montarTexto(estrutura), html: montarHtml(estrutura) };
}

module.exports = { montar };
