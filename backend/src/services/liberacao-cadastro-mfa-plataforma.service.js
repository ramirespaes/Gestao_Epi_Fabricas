'use strict';

const { authConfig } = require('../config/auth');
const { normalizarEmail } = require('../utils/normalizacao');
const codigosMfa = require('../security/codigos-mfa');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../repositories/liberacao-cadastro-mfa-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');

/**
 * Liberação de cadastro do MFA: autorização de uso único, emitida SÓ por
 * CLI (nunca por HTTP), para um administrador sem TOTP ativo cadastrar o
 * fator. É o que impede o primeiro cadastro de ser "quem chegar primeiro":
 * a senha sozinha não basta, é preciso o código entregue fora de banda.
 *
 * O código tem 80 bits aleatórios (security/codigos-mfa.js) e existe em
 * claro só no retorno, para o CLI imprimir uma vez. Ao banco vai o hash
 * contextualizado (domínio "liberacao" + administrador). Não cria sessão,
 * não ativa MFA e não dispensa o TOTP.
 *
 * Auditoria com ator OPERACAO_CLI e o administrador como alvo: o CLI não
 * sabe quem o executou, e a operação nunca é atribuída ao alvo.
 */

class ErroLiberacaoCadastro extends Error {
  constructor(motivo) {
    super('liberação de cadastro recusada');
    this.name = 'ErroLiberacaoCadastro';
    this.motivo = motivo;
  }
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

/**
 * Revoga a liberação aberta (vencida ou não) e emite outra. Pré-condição: a
 * trava do administrador já foi tomada nesta transação.
 */
async function emitirLiberacaoSobTrava(client, { administradorId, origem }) {
  await liberacaoRepo.revogarAberta(client, { administradorId, motivo: 'SUBSTITUIDA' });

  const codigo = codigosMfa.gerarCodigo();
  const codigoHash = codigosMfa.hashCodigoLiberacao({ administradorId, codigo: codigosMfa.normalizarCodigo(codigo) });
  const criada = await liberacaoRepo.criar(client, {
    administradorId, codigoHash, origem, validadeMinutos: authConfig.liberacaoMfa.expiracaoMinutos,
  });

  return { id: criada.id, codigo, expiraEm: criada.expiraEm };
}

/**
 * Operação do CLI `db:mfa:liberar-cadastro`. Recusas são explícitas, porque
 * quem executa é o operador: e-mail inválido, administrador inexistente ou
 * inativo, e administrador que já tem TOTP ativo (esse caminho é o reset).
 */
async function liberarCadastro(pool, { email }) {
  const emailNormalizado = normalizarEmail(email);
  if (emailNormalizado === null) {
    throw new ErroLiberacaoCadastro('EMAIL_INVALIDO');
  }

  return emTransacao(pool, async (client) => {
    const administrador = await administradorRepo.buscarPorEmail(client, emailNormalizado);
    if (administrador === null) {
      throw new ErroLiberacaoCadastro('ADMINISTRADOR_INEXISTENTE');
    }
    if (!administrador.ativo) {
      throw new ErroLiberacaoCadastro('ADMINISTRADOR_INATIVO');
    }

    await travaRepo.travarAdministrador(client, administrador.id);
    if ((await fatorRepo.buscarTotpAtivo(client, administrador.id)) !== null) {
      throw new ErroLiberacaoCadastro('TOTP_ATIVO');
    }

    const emitida = await emitirLiberacaoSobTrava(client, { administradorId: administrador.id, origem: 'CLI_LIBERACAO' });
    await auditoriaRepo.registrarOperacaoCli(client, {
      administradorAfetadoId: administrador.id,
      acao: 'LIBERACAO_CADASTRO_CRIADA',
      referencia: String(emitida.id),
      contexto: { origem: 'CLI_LIBERACAO' },
      dadosNovos: { expiraEm: emitida.expiraEm.toISOString() },
    });

    return { administradorId: administrador.id, codigo: emitida.codigo, expiraEm: emitida.expiraEm };
  });
}

module.exports = { emitirLiberacaoSobTrava, liberarCadastro, ErroLiberacaoCadastro };
