'use strict';

const { z } = require('zod');
const { inteiroDeAmbiente, validarAmbiente, congelarProfundo } = require('./ambiente');

/**
 * Configuração de segurança HTTP, lida e validada UMA vez na subida do
 * processo. Falha cedo citando só o nome da variável, nunca o valor.
 *
 * CORS_ORIGIN: lista separada por vírgula de origens canônicas
 * scheme://host[:port], sem credenciais, path, query ou fragmento. Curinga
 * é rejeitado, então nunca há "*" com credentials. Obrigatória em
 * production, onde toda origem exige https, inclusive localhost e loopback;
 * em development/test o padrão é http://localhost:5500.
 *
 * TRUST_PROXY_HOPS: número de saltos de proxy confiáveis (0 a 10, padrão 0).
 * Só é correto quando corresponde à topologia real e fixa do deploy; a
 * configuração de produção será definida quando o reverse proxy/load
 * balancer for conhecido, e topologias com caminhos de comprimentos
 * diferentes podem exigir configuração por IP/sub-rede em vez de saltos.
 *
 * JSON_LIMITE é contrato da API (não variável): 32 KiB cobre três senhas de
 * 1024 unidades UTF-16 mesmo com escapes Unicode no JSON.
 *
 * NAMESPACE DA PLATAFORMA (Autenticação Global — Pacote 2): PLATAFORMA_CORS_ORIGIN
 * é uma allowlist SEPARADA de CORS_ORIGIN, exclusiva das rotas /api/plataforma —
 * nunca compartilhada com a allowlist do cliente, mesma disciplina de
 * isolamento do adendo v2.1 (seção 3): um script rodando na origem do
 * cliente nunca é uma origem aceita para o Painel Privado, e vice-versa.
 * Mesma validação de CORS_ORIGIN (canônica, sem curinga, https em produção),
 * função reaproveitada (campoCorsOrigin), não reescrita. Em dev/test, o
 * padrão é uma origem DIFERENTE da do cliente (5501, não 5500) — mesmo sem
 * subdomínio real ainda configurado, os dois portais já são tratados como
 * origens distintas desde o desenvolvimento.
 *
 * PLATAFORMA_HOST é OPCIONAL: quando ausente (padrão em dev/test), a
 * validação de Host das rotas de plataforma não recusa nada — não há
 * subdomínio real ainda. Quando definido (produção, quando admin.<domínio>
 * existir), só esse host exato passa a ser aceito por essas rotas — ver
 * src/middleware/host-plataforma.js.
 */

const JSON_LIMITE = '32kb';
const ORIGEM_PADRAO_DEV = 'http://localhost:5500';
const ORIGEM_PADRAO_DEV_PLATAFORMA = 'http://localhost:5501';
const HOSTNAME_FORMATO = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const INTEIROS = Object.freeze({
  TRUST_PROXY_HOPS: { min: 0, max: 10, padrao: 0 },
  RATE_LIMIT_GERAL_LIMITE: { min: 1, max: 100000, padrao: 120 },
  RATE_LIMIT_GERAL_JANELA_SEGUNDOS: { min: 1, max: 86400, padrao: 60 },
  RATE_LIMIT_AUTH_LIMITE: { min: 1, max: 100000, padrao: 20 },
  RATE_LIMIT_AUTH_JANELA_SEGUNDOS: { min: 1, max: 86400, padrao: 60 },
});

const OPCOES = Object.freeze({
  NODE_ENV: ['development', 'test', 'production'],
});

// Únicas mensagens custom que podem sair em erro de configuração (allowlist
// exigida por config/ambiente.js). Todas são literais deste módulo.
const MENSAGENS = Object.freeze({
  OBRIGATORIA_PRODUCAO: 'obrigatória em production',
  CURINGA: 'curinga * não é permitido',
  ORIGEM_CANONICA: 'cada item deve ser uma origem canônica scheme://host[:port]',
  HTTPS_PRODUCAO: 'em production toda origem exige https',
  HOST_FORMATO: 'deve ser um hostname válido, sem porta, esquema ou path',
  // Correção final do Pacote 2 (rodada de ajustes pontuais, item 2):
  // CORS_ORIGIN (cliente) e PLATAFORMA_CORS_ORIGIN (Painel Privado) são
  // allowlists que precisam permanecer disjuntas por construção — uma
  // origem presente nas duas anularia o isolamento entre os dois portais
  // (a mesma origem passaria no CORS/Origin de ambos os namespaces).
  SOBREPOSICAO_ORIGENS: 'não pode compartilhar nenhuma origem com CORS_ORIGIN',
});

// Devolve a origem canônica ou null. Nunca inclui o valor em mensagens.
function origemCanonica(texto) {
  let url;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  const semPath = url.pathname === '/' && !texto.endsWith('/');
  // Porta explícita precisa ser TCP válida (1..65535). Acima de 65535 a URL
  // não é analisável; 0 é aceito pela URL e rejeitado aqui.
  const portaValida = url.port === '' || (/^[1-9][0-9]{0,4}$/.test(url.port) && Number(url.port) <= 65535);
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || !semPath || url.search !== '' || url.hash !== '' || url.origin === 'null' || !portaValida) {
    return null;
  }
  return url.origin;
}

// Campo CORS_ORIGIN validado de forma independente das demais variáveis,
// para que todos os problemas sejam listados juntos. O esquema é montado por
// chamada porque a regra depende de NODE_ENV. `padraoDev` parametriza o
// default fora de produção — CORS_ORIGIN e PLATAFORMA_CORS_ORIGIN usam a
// mesma função, com defaults DIFERENTES, para que os dois portais já
// nasçam como origens distintas mesmo em desenvolvimento.
function campoCorsOrigin(producao, padraoDev) {
  return z.string().optional().transform((entrada, ctx) => {
    const problema = (message) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    if (entrada === undefined) {
      return producao ? problema(MENSAGENS.OBRIGATORIA_PRODUCAO) : [padraoDev];
    }
    const origens = [];
    for (const item of entrada.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
      if (item === '*') {
        return problema(MENSAGENS.CURINGA);
      }
      const origem = origemCanonica(item);
      if (origem === null) {
        return problema(MENSAGENS.ORIGEM_CANONICA);
      }
      if (producao && !origem.startsWith('https://')) {
        return problema(MENSAGENS.HTTPS_PRODUCAO);
      }
      if (!origens.includes(origem)) {
        origens.push(origem);
      }
    }
    return origens.length > 0 ? origens : problema(MENSAGENS.ORIGEM_CANONICA);
  });
}

// PLATAFORMA_HOST: OBRIGATÓRIO em production (correção final do Pacote 2,
// rodada de ajustes pontuais, item 3) — em produção, o Painel Privado
// SEMPRE tem um subdomínio próprio (admin.<domínio>, adendo v2.1), e a
// validação de Host é a defesa em profundidade que depende dele existir;
// deixá-la sem efeito em produção por uma variável esquecida seria
// silencioso. Em development/test continua opcional: sem subdomínio real
// ainda, não há o que validar. Quando presente (em qualquer ambiente),
// precisa ser um hostname sintaticamente válido, sem porta, esquema, path
// ou credenciais (é comparado contra req.hostname, que o Express já
// entrega sem porta).
function campoPlataformaHost(producao) {
  return z.string().optional().transform((entrada, ctx) => {
    if (entrada === undefined) {
      if (producao) {
        ctx.addIssue({ code: 'custom', message: MENSAGENS.OBRIGATORIA_PRODUCAO });
        return z.NEVER;
      }
      return null;
    }
    if (!HOSTNAME_FORMATO.test(entrada)) {
      ctx.addIssue({ code: 'custom', message: MENSAGENS.HOST_FORMATO });
      return z.NEVER;
    }
    return entrada;
  });
}

function criarEsquema(producao) {
  return z.object({
    NODE_ENV: z.enum(OPCOES.NODE_ENV).default('development'),
    CORS_ORIGIN: campoCorsOrigin(producao, ORIGEM_PADRAO_DEV),
    PLATAFORMA_CORS_ORIGIN: campoCorsOrigin(producao, ORIGEM_PADRAO_DEV_PLATAFORMA),
    PLATAFORMA_HOST: campoPlataformaHost(producao),
    TRUST_PROXY_HOPS: inteiroDeAmbiente(INTEIROS.TRUST_PROXY_HOPS),
    RATE_LIMIT_GERAL_LIMITE: inteiroDeAmbiente(INTEIROS.RATE_LIMIT_GERAL_LIMITE),
    RATE_LIMIT_GERAL_JANELA_SEGUNDOS: inteiroDeAmbiente(INTEIROS.RATE_LIMIT_GERAL_JANELA_SEGUNDOS),
    RATE_LIMIT_AUTH_LIMITE: inteiroDeAmbiente(INTEIROS.RATE_LIMIT_AUTH_LIMITE),
    RATE_LIMIT_AUTH_JANELA_SEGUNDOS: inteiroDeAmbiente(INTEIROS.RATE_LIMIT_AUTH_JANELA_SEGUNDOS),
  })
    // Correção final do Pacote 2, item 2: as duas allowlists de origem
    // precisam permanecer disjuntas — uma sobreposição anularia o
    // isolamento entre o namespace do cliente e o do Painel Privado.
    // Comparação feita depois que campoCorsOrigin já canonizou e
    // deduplicou cada lista, então a igualdade é sempre entre origens
    // exatas (scheme://host[:port]), nunca strings brutas.
    .superRefine((e, ctx) => {
      const origensDoCliente = new Set(e.CORS_ORIGIN);
      if (e.PLATAFORMA_CORS_ORIGIN.some((origem) => origensDoCliente.has(origem))) {
        ctx.addIssue({ code: 'custom', path: ['PLATAFORMA_CORS_ORIGIN'], message: MENSAGENS.SOBREPOSICAO_ORIGENS });
      }
    });
}

const VARIAVEIS_CONHECIDAS = Object.keys(criarEsquema(false).shape);

function carregarConfigHttp(origem = process.env) {
  const producao = typeof origem.NODE_ENV === 'string' && origem.NODE_ENV.trim() === 'production';
  const e = validarAmbiente({
    esquema: criarEsquema(producao),
    origem,
    titulo: 'Configuração HTTP',
    conhecidas: VARIAVEIS_CONHECIDAS,
    inteiros: INTEIROS,
    opcoes: OPCOES,
    mensagensPermitidas: Object.values(MENSAGENS),
  });
  return congelarProfundo({
    ambiente: e.NODE_ENV,
    cors: { origens: e.CORS_ORIGIN },
    plataforma: { corsOrigens: e.PLATAFORMA_CORS_ORIGIN, host: e.PLATAFORMA_HOST },
    proxy: { hops: e.TRUST_PROXY_HOPS },
    rateLimit: {
      geral: { limite: e.RATE_LIMIT_GERAL_LIMITE, janelaSegundos: e.RATE_LIMIT_GERAL_JANELA_SEGUNDOS },
      autenticacao: { limite: e.RATE_LIMIT_AUTH_LIMITE, janelaSegundos: e.RATE_LIMIT_AUTH_JANELA_SEGUNDOS },
    },
    hstsAtivo: e.NODE_ENV === 'production',
    jsonLimite: JSON_LIMITE,
  });
}

module.exports = {
  httpConfig: carregarConfigHttp(),
  carregarConfigHttp,
  JSON_LIMITE,
};
