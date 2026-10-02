'use strict';

const path = require('node:path');
const { z } = require('zod');
const { inteiroDeAmbiente, validarAmbiente, congelarProfundo } = require('./ambiente');
const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Entrega de e-mail transacional.
 *
 * Modos (EMAIL_MODO):
 *   desativado  a mensagem é descartada (padrão fora de production);
 *   arquivo     grava a mensagem em EMAIL_ARQUIVO_DIRETORIO, caminho absoluto
 *               fora do repositório. Só desenvolvimento e teste;
 *   smtp        entrega por SMTP (SMTP_*). É o único aceito em production,
 *               com STARTTLS ou TLS e autenticação. Não existe variável que
 *               afrouxe a validação do certificado.
 *
 * Remetente e suporte têm padrões aprovados e podem ser trocados por ambiente
 * (homologação). A senha do SMTP fica fora de JSON, de inspeção e de cópia da
 * configuração: só o transporte a lê.
 */

const MODOS = Object.freeze(['desativado', 'arquivo', 'smtp']);
const SEGURANCAS = Object.freeze(['starttls', 'tls', 'nenhuma']);
const RAIZ_REPOSITORIO = path.resolve(__dirname, '..', '..', '..');

const REMETENTE_NOME_PADRAO = 'SafeWork Engenharia';
const REMETENTE_ENDERECO_PADRAO = 'no-reply@safeworkengenharia.com.br';
const SUPORTE_ENDERECO_PADRAO = 'suporte@safeworkengenharia.com.br';

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const NOME_REMETENTE = /^[\p{L}\p{N} .'-]{1,80}$/u;
const QUEBRA_DE_LINHA = /[\r\n]/;

const INTEIROS = Object.freeze({
  SMTP_PORTA: { min: 1, max: 65535, padrao: 587 },
  SMTP_TIMEOUT_MS: { min: 1000, max: 30000, padrao: 10000 },
});

const OPCOES = Object.freeze({ EMAIL_MODO: MODOS, SMTP_SEGURANCA: SEGURANCAS });

// Únicas mensagens custom que podem sair em erro de configuração (allowlist
// exigida por config/ambiente.js). Todas são literais deste módulo.
const MENSAGENS = Object.freeze({
  SO_SMTP_EM_PRODUCAO: 'em production só o modo smtp é aceito',
  DIRETORIO_OBRIGATORIO: 'obrigatória no modo arquivo',
  DIRETORIO_ABSOLUTO: 'deve ser um caminho absoluto',
  DIRETORIO_NO_REPOSITORIO: 'não pode ficar dentro do repositório',
  HOST_OBRIGATORIO: 'obrigatória no modo smtp',
  HOST_FORMATO: 'deve ser um hostname válido, sem porta, esquema ou path',
  TLS_EM_PRODUCAO: 'em production exige starttls ou tls',
  USUARIO_OBRIGATORIO_PRODUCAO: 'obrigatória em production',
  SENHA_OBRIGATORIA: 'obrigatória quando há SMTP_USUARIO',
  USUARIO_OBRIGATORIO: 'obrigatória quando há SMTP_SENHA',
  SEM_QUEBRA_DE_LINHA: 'não pode conter quebra de linha',
  NOME_FORMATO: 'deve ter até 80 letras, números, espaço, ponto, apóstrofo ou hífen',
  ENDERECO_FORMATO: 'deve ser um e-mail ASCII em minúsculas',
});

const VARIAVEIS_CONHECIDAS = [
  'EMAIL_MODO', 'EMAIL_ARQUIVO_DIRETORIO', 'EMAIL_REMETENTE_NOME', 'EMAIL_REMETENTE_ENDERECO', 'EMAIL_SUPORTE_ENDERECO',
  'SMTP_HOST', 'SMTP_PORTA', 'SMTP_SEGURANCA', 'SMTP_USUARIO', 'SMTP_SENHA', 'SMTP_TIMEOUT_MS',
];

function dentroDoRepositorio(diretorio) {
  const resolvido = path.resolve(diretorio);
  return resolvido === RAIZ_REPOSITORIO || resolvido.startsWith(`${RAIZ_REPOSITORIO}${path.sep}`);
}

const endereco = (padrao) => z.string().default(padrao);

function validarRemetenteESuporte(e, problema) {
  if (QUEBRA_DE_LINHA.test(e.EMAIL_REMETENTE_NOME) || !NOME_REMETENTE.test(e.EMAIL_REMETENTE_NOME)) {
    problema('EMAIL_REMETENTE_NOME', MENSAGENS.NOME_FORMATO);
  }
  for (const variavel of ['EMAIL_REMETENTE_ENDERECO', 'EMAIL_SUPORTE_ENDERECO']) {
    if (normalizarEmail(e[variavel]) !== e[variavel]) {
      problema(variavel, MENSAGENS.ENDERECO_FORMATO);
    }
  }
}

function validarArquivo(e, problema) {
  const diretorio = e.EMAIL_ARQUIVO_DIRETORIO;
  if (diretorio === undefined) {
    problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_OBRIGATORIO);
  } else if (!path.isAbsolute(diretorio)) {
    problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_ABSOLUTO);
  } else if (dentroDoRepositorio(diretorio)) {
    problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_NO_REPOSITORIO);
  }
}

function validarSmtp(e, producao, problema) {
  if (e.SMTP_HOST === undefined) {
    problema('SMTP_HOST', MENSAGENS.HOST_OBRIGATORIO);
  } else if (!HOSTNAME.test(e.SMTP_HOST)) {
    problema('SMTP_HOST', MENSAGENS.HOST_FORMATO);
  }
  if (producao && e.SMTP_SEGURANCA === 'nenhuma') {
    problema('SMTP_SEGURANCA', MENSAGENS.TLS_EM_PRODUCAO);
  }
  for (const variavel of ['SMTP_USUARIO', 'SMTP_SENHA']) {
    if (e[variavel] !== undefined && QUEBRA_DE_LINHA.test(e[variavel])) {
      problema(variavel, MENSAGENS.SEM_QUEBRA_DE_LINHA);
    }
  }
  if (producao && e.SMTP_USUARIO === undefined) {
    problema('SMTP_USUARIO', MENSAGENS.USUARIO_OBRIGATORIO_PRODUCAO);
  } else if (e.SMTP_USUARIO !== undefined && e.SMTP_SENHA === undefined) {
    problema('SMTP_SENHA', MENSAGENS.SENHA_OBRIGATORIA);
  } else if (e.SMTP_USUARIO === undefined && e.SMTP_SENHA !== undefined) {
    problema('SMTP_USUARIO', MENSAGENS.USUARIO_OBRIGATORIO);
  }
}

function criarEsquema(producao) {
  return z.object({
    EMAIL_MODO: z.enum(MODOS).default('desativado'),
    EMAIL_ARQUIVO_DIRETORIO: z.string().optional(),
    EMAIL_REMETENTE_NOME: endereco(REMETENTE_NOME_PADRAO),
    EMAIL_REMETENTE_ENDERECO: endereco(REMETENTE_ENDERECO_PADRAO),
    EMAIL_SUPORTE_ENDERECO: endereco(SUPORTE_ENDERECO_PADRAO),
    SMTP_HOST: z.string().optional(),
    SMTP_PORTA: inteiroDeAmbiente(INTEIROS.SMTP_PORTA),
    SMTP_SEGURANCA: z.enum(SEGURANCAS).default('starttls'),
    SMTP_USUARIO: z.string().optional(),
    SMTP_SENHA: z.string().optional(),
    SMTP_TIMEOUT_MS: inteiroDeAmbiente(INTEIROS.SMTP_TIMEOUT_MS),
  }).superRefine((e, ctx) => {
    const problema = (variavel, message) => ctx.addIssue({ code: 'custom', path: [variavel], message });
    validarRemetenteESuporte(e, problema);
    if (producao && e.EMAIL_MODO !== 'smtp') {
      problema('EMAIL_MODO', MENSAGENS.SO_SMTP_EM_PRODUCAO);
      return;
    }
    if (e.EMAIL_MODO === 'arquivo') {
      validarArquivo(e, problema);
    } else if (e.EMAIL_MODO === 'smtp') {
      validarSmtp(e, producao, problema);
    }
  });
}

function montarSmtp(e) {
  const smtp = {
    host: e.SMTP_HOST,
    porta: e.SMTP_PORTA,
    seguranca: e.SMTP_SEGURANCA,
    usuario: e.SMTP_USUARIO ?? null,
    timeoutMs: e.SMTP_TIMEOUT_MS,
  };
  // Não enumerável: fora de JSON.stringify, de util.inspect e de { ...smtp }.
  Object.defineProperty(smtp, 'senha', { value: e.SMTP_SENHA, enumerable: false });
  return smtp;
}

function carregarConfigEmail(origem = process.env) {
  const producao = typeof origem.NODE_ENV === 'string' && origem.NODE_ENV.trim() === 'production';
  const e = validarAmbiente({
    esquema: criarEsquema(producao),
    origem,
    titulo: 'Configuração de e-mail',
    conhecidas: VARIAVEIS_CONHECIDAS,
    inteiros: INTEIROS,
    opcoes: OPCOES,
    mensagensPermitidas: Object.values(MENSAGENS),
  });

  return congelarProfundo({
    modo: e.EMAIL_MODO,
    arquivo: e.EMAIL_MODO === 'arquivo' ? { diretorio: path.resolve(e.EMAIL_ARQUIVO_DIRETORIO) } : null,
    smtp: e.EMAIL_MODO === 'smtp' ? montarSmtp(e) : null,
    remetente: { nome: e.EMAIL_REMETENTE_NOME, endereco: e.EMAIL_REMETENTE_ENDERECO },
    suporte: e.EMAIL_SUPORTE_ENDERECO,
  });
}

module.exports = {
  emailConfig: carregarConfigEmail(),
  carregarConfigEmail,
};
