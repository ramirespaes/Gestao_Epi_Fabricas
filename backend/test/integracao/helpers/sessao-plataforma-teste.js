'use strict';

const sessaoPlataformaRepo = require('../../../src/repositories/sessao-plataforma.repository');
const desafioRepo = require('../../../src/repositories/desafio-mfa-plataforma.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../../src/security/token');
const { authConfig } = require('../../../src/config/auth');

/**
 * Sessão administrativa já existente, como o login com TOTP a deixa no
 * banco: desafio VERIFICACAO concluído, sessão com o registro do MFA e o
 * vínculo entre os dois, tudo numa transação. É assim que as suítes
 * exercitam as rotas que exigem sessão plena sem repetir o login inteiro.
 * Só o hash vai ao banco; o token volta pronto para o cookie.
 *
 * O schema da suíte precisa das migrations 049, 052 e 054.
 */
async function criarSessaoAdministrativa(pool, administradorId, { validadeMinutos = 60 } = {}) {
  const token = gerarTokenSessao();
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // O desafio nasce 2 s antes e o MFA é verificado 1 s antes: a ordem real dos instantes.
    const { rows: [desafio] } = await cliente.query(
      `INSERT INTO desafios_mfa_plataforma (administrador_id, token_hash, tipo, criado_em, expira_em, encerrado_em, motivo_encerramento)
       VALUES ($1, $2, 'VERIFICACAO', clock_timestamp() - interval '2 seconds', clock_timestamp() + interval '5 minutes', clock_timestamp(), 'CONCLUIDO')
       RETURNING id, encerrado_em - interval '1 second' AS verificado_em`,
      [administradorId, hashTokenSessao(gerarTokenSessao())],
    );
    const id = await sessaoPlataformaRepo.criar(cliente, {
      administradorId,
      tokenHash: hashTokenSessao(token),
      expiraEm: new Date(Date.now() + validadeMinutos * 60_000),
      mfa: { verificadoEm: desafio.verificado_em, metodo: 'TOTP' },
    });
    if (!(await desafioRepo.ligarSessaoCriada(cliente, { desafioId: desafio.id, sessaoId: id }))) {
      throw new Error('a sessão de teste não ficou ligada ao desafio');
    }
    await cliente.query('COMMIT');
    return { id, token, cookie: `${authConfig.sessao.cookieNomeAdmin}=${token}` };
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

module.exports = { criarSessaoAdministrativa };
