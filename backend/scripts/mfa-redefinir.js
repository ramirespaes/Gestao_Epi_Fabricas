'use strict';

const resetService = require('../src/services/reset-mfa-plataforma.service');

/**
 * Reset operacional do MFA de um administrador de plataforma:
 *
 *   npm run db:mfa:redefinir -- --email <email> --confirmo
 *
 * Revoga fatores, recovery codes, desafios e sessões e emite uma liberação
 * nova de cadastro, impressa uma única vez. Não cria sessão nem fator: o
 * administrador volta a entrar pela senha e cadastra um TOTP novo.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  EMAIL_INVALIDO: 5,
  ADMINISTRADOR_INEXISTENTE: 7,
  ADMINISTRADOR_INATIVO: 8,
});

const RECUSAS = Object.freeze({
  EMAIL_INVALIDO: [SAIDAS.EMAIL_INVALIDO, 'e-mail inválido'],
  ADMINISTRADOR_INEXISTENTE: [SAIDAS.ADMINISTRADOR_INEXISTENTE, 'não existe administrador de plataforma com este e-mail'],
  ADMINISTRADOR_INATIVO: [SAIDAS.ADMINISTRADOR_INATIVO, 'o administrador está inativo; reative a conta antes do reset'],
});

function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) {
    throw new TypeError('argumentos deve ser uma lista');
  }
  let email = null;
  let confirmo = false;

  for (let i = 0; i < argumentos.length; i += 1) {
    const arg = argumentos[i];
    if (arg === '--email') {
      const valor = argumentos[i + 1];
      if (typeof valor !== 'string' || valor.length === 0) {
        return { ok: false, erro: '--email exige um valor' };
      }
      if (email !== null) return { ok: false, erro: '--email informado mais de uma vez' };
      email = valor;
      i += 1;
    } else if (arg === '--confirmo') {
      confirmo = true;
    } else {
      return { ok: false, erro: `argumento desconhecido: ${arg}` };
    }
  }

  if (email === null) {
    return { ok: false, erro: '--email <email> é obrigatório' };
  }
  return { ok: true, email, confirmo };
}

function uso() {
  return [
    'Uso:',
    '  npm run db:mfa:redefinir -- --email <email> --confirmo',
    '',
    '  --email      e-mail do administrador de plataforma (obrigatório)',
    '  --confirmo   confirmação explícita do reset (obrigatório)',
    '',
    'Revoga o TOTP, os recovery codes, os desafios e as sessões do administrador.',
    'A nova liberação aparece uma única vez; entregue-a por um canal separado.',
  ].join('\n');
}

/** Executa com um pool já configurado e devolve o código de saída, sem encerrar o pool. */
async function executarComando({ email, confirmo }, { pool, saida = console }) {
  if (typeof email !== 'string' || email.length === 0) throw new TypeError('email inválido');
  if (typeof confirmo !== 'boolean') throw new TypeError('confirmo deve ser booleano');

  if (!confirmo) {
    saida.error('Confirmação ausente: repita o comando com --confirmo para executar.');
    saida.error(uso());
    return SAIDAS.ARGUMENTOS;
  }

  const { rows } = await pool.query('SELECT current_database() AS banco, inet_server_addr()::text AS servidor, inet_server_port() AS porta');
  saida.log(`Banco: ${rows[0].banco} em ${rows[0].servidor ?? '(socket local)'}:${rows[0].porta}`);

  try {
    const reset = await resetService.redefinirMfa(pool, { email });
    saida.log(`MFA redefinido para o administrador id=${reset.administradorId}: TOTP, recovery codes, desafios e sessões revogados.`);
    saida.log('Nova liberação do cadastro do MFA (uso único; entregue fora de banda; não será exibida de novo):');
    saida.log(`  código: ${reset.codigo}`);
    saida.log(`  válida até: ${reset.expiraEm.toISOString()}`);
    return SAIDAS.OK;
  } catch (erro) {
    if (erro instanceof resetService.ErroResetMfa && RECUSAS[erro.motivo]) {
      const [codigo, mensagem] = RECUSAS[erro.motivo];
      saida.error(`Recusado: ${mensagem} (${erro.motivo}).`);
      return codigo;
    }
    throw erro;
  }
}

async function principal() {
  const interpretado = interpretarArgumentos(process.argv.slice(2));
  if (!interpretado.ok) {
    console.error(`Argumentos inválidos: ${interpretado.erro}`);
    console.error(uso());
    return SAIDAS.ARGUMENTOS;
  }

  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído.
  const { pool } = require('../src/config/database');
  try {
    return await executarComando(interpretado, { pool });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${erro.message}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { interpretarArgumentos, executarComando, uso, SAIDAS };
