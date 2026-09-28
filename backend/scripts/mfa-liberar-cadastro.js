'use strict';

const liberacaoService = require('../src/services/liberacao-cadastro-mfa-plataforma.service');

/**
 * Script administrativo: emite a liberação de cadastro do MFA para um
 * administrador de plataforma que ainda não tem TOTP ativo.
 *
 *   npm run db:mfa:liberar-cadastro -- --email <email> --confirmo
 *
 * A liberação é um código de uso único, com prazo curto, entregue ao
 * administrador fora de banda. Com ele, depois de validar a senha, o
 * administrador cadastra o TOTP. Não cria sessão, não ativa MFA e não
 * dispensa o TOTP. Emitir outra revoga a anterior ainda aberta.
 *
 * O código aparece UMA vez, nesta saída; ao banco vai só o hash. Nada mais
 * sensível é impresso (secret, URI, token, recovery codes não existem aqui).
 *
 * Recusa: e-mail inválido, administrador inexistente ou inativo, e
 * administrador que já tem TOTP ativo (esse caso é de reset, não de
 * liberação). `--confirmo` é obrigatório, como nos demais scripts.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  EMAIL_INVALIDO: 5,
  ADMINISTRADOR_INEXISTENTE: 7,
  ADMINISTRADOR_INATIVO: 8,
  TOTP_ATIVO: 9,
});

const RECUSAS = Object.freeze({
  EMAIL_INVALIDO: [SAIDAS.EMAIL_INVALIDO, 'e-mail inválido'],
  ADMINISTRADOR_INEXISTENTE: [SAIDAS.ADMINISTRADOR_INEXISTENTE, 'não existe administrador de plataforma com este e-mail'],
  ADMINISTRADOR_INATIVO: [SAIDAS.ADMINISTRADOR_INATIVO, 'o administrador está inativo'],
  TOTP_ATIVO: [SAIDAS.TOTP_ATIVO, 'o administrador já tem TOTP ativo; liberação não se aplica'],
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
    '  npm run db:mfa:liberar-cadastro -- --email <email> --confirmo',
    '',
    '  --email      e-mail do administrador de plataforma (obrigatório)',
    '  --confirmo   confirmação explícita de que a liberação deve ser emitida (obrigatório)',
    '',
    'O código de liberação aparece uma única vez. Entregue-o ao administrador',
    'por um canal separado; ele serve só para cadastrar o TOTP, uma vez.',
  ].join('\n');
}

/**
 * Executa o comando com um pool já configurado. Devolve o código de saída,
 * sem encerrar o pool (responsabilidade de quem chama).
 */
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
    const liberacao = await liberacaoService.liberarCadastro(pool, { email });
    saida.log(`Liberação do cadastro do MFA emitida para o administrador id=${liberacao.administradorId}.`);
    saida.log('Uso único; entregue fora de banda; não será exibida de novo:');
    saida.log(`  código: ${liberacao.codigo}`);
    saida.log(`  válida até: ${liberacao.expiraEm.toISOString()}`);
    return SAIDAS.OK;
  } catch (erro) {
    if (erro instanceof liberacaoService.ErroLiberacaoCadastro && RECUSAS[erro.motivo]) {
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
