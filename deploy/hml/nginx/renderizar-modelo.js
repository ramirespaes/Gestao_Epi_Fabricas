'use strict';

/**
 * Renderiza os modelos Nginx de homologação. Cada placeholder {{NOME}} tem um
 * validador próprio: valor com caractere de controle de diretiva (; { } " \ $ ou
 * quebra de linha), caminho relativo, domínio curinga ou CSP fraca é recusado.
 * Os modelos NÃO são aplicados em nenhum servidor por este código.
 */

const path = require('node:path');
const { avaliarCsp } = require('../verificacao/verificar-publicacao');

class ErroNginx extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroNginx';
    this.codigo = codigo;
  }
}

const caminhoAbsoluto = (v) => typeof v === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(v) && !v.split('/').includes('..');
const terminaEm = (sufixo) => (v) => caminhoAbsoluto(v) && v.endsWith(sufixo);
const dominio = (v) => typeof v === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v);
const csp = (v) => typeof v === 'string' && /^[A-Za-z0-9 ;'\-:/.+=_*]+$/.test(v) && avaliarCsp(v).length === 0;

// IP único ou rede estreita: IPv4 a partir de /24 (até 256 endereços) e IPv6 a partir de /64. Os endereços são
// validados de verdade (octetos, grupos hexadecimais e no máximo um "::"); 0.0.0.0, :: e máscaras que abririam a
// verificação para uma faixa grande são recusados.
const OCTETO = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTETO}(?:\\.${OCTETO}){3}$`);
const MASCARA_IPV4 = /^(?:2[4-9]|3[0-2])$/;
const MASCARA_IPV6 = /^(?:6[4-9]|[7-9]\d|1[01]\d|12[0-8])$/;
function ipv6Valido(ip) {
  if (!/^[0-9a-fA-F:]+$/.test(ip) || ip.length > 39) return false;
  const partes = ip.split('::');
  if (partes.length > 2) return false;
  const grupos = (s) => (s === '' ? [] : s.split(':'));
  const hex = (lista) => lista.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
  if (partes.length === 2) {
    const a = grupos(partes[0]);
    const b = grupos(partes[1]);
    return hex(a) && hex(b) && a.length + b.length <= 7;
  }
  const todos = ip.split(':');
  return todos.length === 8 && hex(todos);
}
function redeDeVerificacao(v) {
  if (typeof v !== 'string') return false;
  const [ip, mascara, sobra] = v.split('/');
  if (sobra !== undefined || ip === undefined) return false;
  if (IPV4.test(ip)) {
    if (ip === '0.0.0.0') return false;
    return mascara === undefined || MASCARA_IPV4.test(mascara);
  }
  if (ipv6Valido(ip)) {
    if (/^[0:]+$/.test(ip)) return false;
    return mascara === undefined || MASCARA_IPV6.test(mascara);
  }
  return false;
}

const PLACEHOLDERS = {
  RAIZ_ACME: caminhoAbsoluto,
  REDE_VERIFICACAO: redeDeVerificacao,
  DOMINIO_PORTAL: dominio,
  DOMINIO_PAINEL: dominio,
  RAIZ_PORTAL: caminhoAbsoluto,
  RAIZ_PAINEL: caminhoAbsoluto,
  ARQUIVO_VERSAO_PORTAL: terminaEm('/versao.json'),
  ARQUIVO_VERSAO_PAINEL: terminaEm('/versao.json'),
  ARQUIVO_SEGURANCA_PORTAL: terminaEm('.conf'),
  ARQUIVO_SEGURANCA_PAINEL: terminaEm('.conf'),
  PORTA_BACKEND: (v) => typeof v === 'string' && /^\d{4,5}$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535,
  LIMITE_CORPO: (v) => typeof v === 'string' && /^[1-9]\d{0,2}[km]$/i.test(v),
  // HSTS nunca é desligado nem reduzido a quase nada por parâmetro: no mínimo 5 minutos, no máximo 2 anos.
  HSTS_MAX_AGE: (v) => typeof v === 'string' && /^[1-9]\d{2,7}$/.test(v) && Number(v) >= 300 && Number(v) <= 63072000,
  CERTIFICADO_PORTAL: caminhoAbsoluto,
  CHAVE_PORTAL: caminhoAbsoluto,
  CERTIFICADO_PAINEL: caminhoAbsoluto,
  CHAVE_PAINEL: caminhoAbsoluto,
  DESTINO_RAIZ_PORTAL: (v) => typeof v === 'string' && /^\/(?!\/)[A-Za-z0-9_./-]*$/.test(v) && !v.split('/').includes('..'),
  DESTINO_RAIZ_PAINEL: (v) => typeof v === 'string' && /^\/(?!\/)[A-Za-z0-9_./-]*$/.test(v) && !v.split('/').includes('..'),
  CSP_PORTAL: csp,
  CSP_PAINEL: csp,
};

function renderizarModelo(texto, valores = {}) {
  const usados = new Set([...texto.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]));
  for (const nome of usados) if (!(nome in PLACEHOLDERS)) throw new ErroNginx('NGINX_PLACEHOLDER_DESCONHECIDO', `placeholder sem validador: ${nome}`);
  for (const [nome, valor] of Object.entries(valores)) {
    if (!(nome in PLACEHOLDERS)) throw new ErroNginx('NGINX_VALOR_DESCONHECIDO', `valor para placeholder inexistente: ${nome}`);
    if (!PLACEHOLDERS[nome](valor)) throw new ErroNginx('NGINX_VALOR_INVALIDO', `valor inválido para ${nome}`);
  }
  for (const nome of usados) if (!(nome in valores)) throw new ErroNginx('NGINX_VALOR_AUSENTE', `sem valor para ${nome}`);
  return texto.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, nome) => valores[nome]);
}

module.exports = { renderizarModelo, PLACEHOLDERS, ErroNginx, MODELOS: ['seguranca-portal.conf.modelo', 'seguranca-painel.conf.modelo', 'portal.conf.modelo', 'painel.conf.modelo'].map((n) => path.join(__dirname, n)) };
