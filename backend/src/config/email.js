'use strict';

const path = require('node:path');
const { z } = require('zod');
const { validarAmbiente, congelarProfundo } = require('./ambiente');

/**
 * Entrega de e-mail do ciclo de senha.
 *
 * Ainda não existe provedor real. Fora de production há dois modos:
 *   desativado  a mensagem é descartada (padrão);
 *   arquivo     a mensagem é gravada em EMAIL_ARQUIVO_DIRETORIO, que precisa
 *               ser um caminho absoluto fora do repositório. Só para
 *               desenvolvimento e teste.
 * Em production nenhum dos dois serve: sem um modo de provedor real a
 * configuração é recusada, para a recuperação de senha não parecer
 * operacional sem ter como entregar o link.
 *
 * O caminho é comparado depois de normalizado (path.resolve), sem seguir
 * links simbólicos.
 */

const MODOS = Object.freeze(['desativado', 'arquivo']);
const RAIZ_REPOSITORIO = path.resolve(__dirname, '..', '..', '..');

// Únicas mensagens custom que podem sair em erro de configuração (allowlist
// exigida por config/ambiente.js). Todas são literais deste módulo.
const MENSAGENS = Object.freeze({
  SEM_PROVEDOR_PRODUCAO: 'nenhum provedor de e-mail disponível para production',
  DIRETORIO_OBRIGATORIO: 'obrigatória no modo arquivo',
  DIRETORIO_ABSOLUTO: 'deve ser um caminho absoluto',
  DIRETORIO_NO_REPOSITORIO: 'não pode ficar dentro do repositório',
});

const VARIAVEIS_CONHECIDAS = ['EMAIL_MODO', 'EMAIL_ARQUIVO_DIRETORIO'];

function dentroDoRepositorio(diretorio) {
  const resolvido = path.resolve(diretorio);
  return resolvido === RAIZ_REPOSITORIO || resolvido.startsWith(`${RAIZ_REPOSITORIO}${path.sep}`);
}

function criarEsquema(producao) {
  return z.object({
    EMAIL_MODO: z.enum(MODOS).default('desativado'),
    EMAIL_ARQUIVO_DIRETORIO: z.string().optional(),
  }).superRefine((e, ctx) => {
    const problema = (variavel, message) => ctx.addIssue({ code: 'custom', path: [variavel], message });
    if (producao) {
      problema('EMAIL_MODO', MENSAGENS.SEM_PROVEDOR_PRODUCAO);
      return;
    }
    if (e.EMAIL_MODO !== 'arquivo') {
      return;
    }
    const diretorio = e.EMAIL_ARQUIVO_DIRETORIO;
    if (diretorio === undefined) {
      problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_OBRIGATORIO);
    } else if (!path.isAbsolute(diretorio)) {
      problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_ABSOLUTO);
    } else if (dentroDoRepositorio(diretorio)) {
      problema('EMAIL_ARQUIVO_DIRETORIO', MENSAGENS.DIRETORIO_NO_REPOSITORIO);
    }
  });
}

function carregarConfigEmail(origem = process.env) {
  const producao = typeof origem.NODE_ENV === 'string' && origem.NODE_ENV.trim() === 'production';
  const e = validarAmbiente({
    esquema: criarEsquema(producao),
    origem,
    titulo: 'Configuração de e-mail',
    conhecidas: VARIAVEIS_CONHECIDAS,
    opcoes: { EMAIL_MODO: MODOS },
    mensagensPermitidas: Object.values(MENSAGENS),
  });

  return congelarProfundo({
    modo: e.EMAIL_MODO,
    arquivo: e.EMAIL_MODO === 'arquivo' ? { diretorio: path.resolve(e.EMAIL_ARQUIVO_DIRETORIO) } : null,
  });
}

module.exports = {
  emailConfig: carregarConfigEmail(),
  carregarConfigEmail,
};
