'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { exigirModulo } = require('../../helpers/exigir-modulo');
const totpReferencia = require('../../helpers/totp-referencia');
const { criarSessaoAdministrativa } = require('./sessao-plataforma-teste');
const loginGlobalService = require('../../../src/services/login-global.service');
const contextoEmpresarialService = require('../../../src/services/contexto-empresarial.service');
const sessaoRepo = require('../../../src/repositories/sessao.repository');
const sessaoGlobalRepo = require('../../../src/repositories/sessao-global.repository');
const sessaoPlataformaRepo = require('../../../src/repositories/sessao-plataforma.repository');
const fatorRepo = require('../../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const desafioRepo = require('../../../src/repositories/desafio-mfa-plataforma.repository');
const { ESPACO_TRAVA_ADMINISTRADOR_MFA } = require('../../../src/repositories/trava-mfa-plataforma.repository');
const mfaCripto = require('../../../src/security/mfa-cripto');
const codigosMfa = require('../../../src/security/codigos-mfa');
const cooldown = require('../../../src/security/cooldown');
const token = require('../../../src/security/token');
const { authConfig } = require('../../../src/config/auth');

/**
 * Apoio dos testes de integração da troca de senha autenticada (Bloco 11E):
 * acesso aos services, espião de pool que guarda comando e parâmetros,
 * sondas das travas consultivas e fábricas de fixtures do Portal (identidade,
 * vínculos e sessões reais, emitidas pelo login e pela seleção de empresa
 * existentes) e do Painel Privado (administrador com TOTP ativo de segredo
 * conhecido, recovery codes, sessão plena e desafios). Nada aqui escreve fora
 * do schema temporário da suíte.
 */

const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const OUTRA_SENHA = 'lanterna-cometa-ardosia-91';
const IP = '198.51.100.9';
const DISPOSITIVO = 'Navegador de Teste';
const MOTIVO = 'SENHA_ALTERADA';
const RESPOSTA = Object.freeze({ status: 'SENHA_ALTERADA' });

const servicoGlobal = () => exigirModulo('src/services/troca-senha-global.service');
const servicoPlataforma = () => exigirModulo('src/services/troca-senha-plataforma.service');

const AGORA = () => Date.now();

/**
 * Pool que registra, para cada conexão entregue ao service, o PID e os comandos
 * já concluídos nela, com os parâmetros. Compatível com os auxiliares de espera
 * do Bloco 11C (`pids`, `concluidos` com `pid` e `texto`).
 */
function poolEspiaoDetalhado(pool) {
  const pids = [];
  const concluidos = [];
  return {
    pids,
    concluidos,
    connect: async () => {
      const cliente = await pool.connect();
      const pid = cliente.processID;
      pids.push(pid);
      return {
        processID: pid,
        query: async (...argumentos) => {
          const resultado = await cliente.query(...argumentos);
          const [comando, parametros] = argumentos;
          concluidos.push({
            pid,
            texto: typeof comando === 'string' ? comando : comando?.text,
            parametros: Array.isArray(parametros) ? parametros : comando?.values,
          });
          return resultado;
        },
        release: (...argumentos) => cliente.release(...argumentos),
      };
    },
    query: (...argumentos) => pool.query(...argumentos),
  };
}

/** Comandos concluídos numa conexão, na ordem em que concluíram. */
const comandosDa = (espiao, pid) => espiao.concluidos.filter((c) => c.pid === pid);

/**
 * Confere que os padrões aparecem na ordem dada, cada um depois do anterior,
 * e devolve os índices. Outros comandos podem ficar entre eles.
 */
function exigirOrdem(comandos, padroes, rotulo) {
  let anterior = -1;
  return padroes.map((padrao) => {
    const indice = comandos.findIndex((c, i) => i > anterior && padrao.test(c.texto));
    assert.notEqual(indice, -1, `${rotulo}: ${padrao} não aparece depois do comando anterior da sequência`);
    anterior = indice;
    return indice;
  });
}

/** Tenta tomar a trava consultiva de 64 bits sem esperar, de outra conexão. true = estava livre. */
async function travaConsultivaLivre(pool, chave64) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS livre', [chave64]);
    return rows[0].livre;
  } finally {
    await cliente.query('ROLLBACK').catch(() => {});
    cliente.release();
  }
}

/** Mesma sonda para a trava do MFA do administrador (duas chaves int4). */
async function travaMfaLivre(pool, administradorId) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query('SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS livre', [ESPACO_TRAVA_ADMINISTRADOR_MFA, administradorId]);
    return rows[0].livre;
  } finally {
    await cliente.query('ROLLBACK').catch(() => {});
    cliente.release();
  }
}

/** Segura a trava do MFA do administrador numa transação própria, até o teste soltar. */
async function segurarTravaMfa(pool, administradorId) {
  const cliente = await pool.connect();
  await cliente.query('BEGIN');
  await cliente.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [ESPACO_TRAVA_ADMINISTRADOR_MFA, administradorId]);
  let solto = false;
  return {
    soltar: async () => {
      if (solto) return;
      solto = true;
      try { await cliente.query('COMMIT'); } finally { cliente.release(); }
    },
  };
}

/** Todas as linhas de uma tabela, em texto, para varrer segredos. `tabela` e `filtro` são constantes dos testes. */
async function despejo(pool, tabela, filtro, parametros) {
  assert.match(tabela, /^[a-z_]+$/);
  const { rows } = await pool.query(`SELECT row_to_json(t)::text AS linha FROM ${tabela} t WHERE ${filtro}`, parametros);
  return rows.map((r) => r.linha).join('\n');
}

/**
 * Fixtures do Portal. Sessões globais e empresariais são as que o login global
 * e a seleção de empresa existentes criam, com token real.
 */
function fabricaPortal({ pool, hashSenha, senha = SENHA_ATUAL }) {
  let sequencia = 0;
  const um = async (sql, parametros) => (await pool.query(sql, parametros)).rows[0];
  const todos = async (sql, parametros) => (await pool.query(sql, parametros)).rows;
  const inatividade = authConfig.sessao.inatividadeMinutos;

  async function novaIdentidade({ ativo = true } = {}) {
    sequencia += 1;
    const email = `pessoa-troca-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO identidades (email, senha_hash, ativo) VALUES ($1, $2, $3) RETURNING id', [email, hashSenha, ativo]);
    return { id, email, chaveLogin: cooldown.gerarChaveCooldownGlobal(email) };
  }

  async function vincular(identidade, empresaId, perfil = 'USUARIO') {
    const { id } = await um(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Pessoa de Teste', NULL, NULL, $2, $3) RETURNING id",
      [empresaId, perfil, identidade.id],
    );
    return id;
  }

  async function entrar(identidade, { senhaDeEntrada = senha } = {}) {
    const resultado = await loginGlobalService.autenticar(pool, { email: identidade.email, senha: senhaDeEntrada, ip: IP, dispositivo: DISPOSITIVO });
    return { id: resultado.sessao.id, token: resultado.token };
  }

  async function selecionar(identidade, sessaoGlobal, empresaId) {
    const resultado = await contextoEmpresarialService.selecionar(pool, {
      identidadeId: identidade.id, sessaoGlobalId: sessaoGlobal.id, empresaId, ip: IP, dispositivo: DISPOSITIVO,
    });
    return { id: resultado.sessao.id, token: resultado.token };
  }

  /** Sessão empresarial da identidade sem sessão global de origem (como as anteriores à migration 037). */
  async function empresarialSemGlobal(usuarioId, empresaId) {
    const tokenClaro = token.gerarTokenSessao();
    const id = await sessaoRepo.criar(pool, {
      empresaId, usuarioId, tokenHash: token.hashTokenSessao(tokenClaro), expiraEm: new Date(AGORA() + 3_600_000), sessaoGlobalId: null,
    });
    return { id, token: tokenClaro };
  }

  const hashDaSenha = async (identidadeId) => (await um('SELECT senha_hash FROM identidades WHERE id = $1', [identidadeId])).senha_hash;
  const globais = (ids) => todos('SELECT id, revogada_em, motivo_revogacao FROM sessoes_globais WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  const empresariais = (ids) => todos('SELECT id, revogada_em, motivo_revogacao FROM sessoes WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  const motivosGlobais = async (ids) => (await globais(ids)).map((s) => s.motivo_revogacao);
  const motivosEmpresariais = async (ids) => (await empresariais(ids)).map((s) => s.motivo_revogacao);
  const globalVale = async (sessao) => (await sessaoGlobalRepo.buscarValidaPorHash(pool, token.hashTokenSessao(sessao.token), inatividade)) !== null;
  const empresarialVale = async (sessao) => (await sessaoRepo.buscarValidaPorHash(pool, token.hashTokenSessao(sessao.token), inatividade)) !== null;
  const totalDeSessoes = async () => (await um('SELECT (SELECT count(*) FROM sessoes_globais)::int + (SELECT count(*) FROM sessoes)::int AS n')).n;
  const globaisNaoRevogadasDe = async (identidadeId) => (await todos('SELECT id FROM sessoes_globais WHERE identidade_id = $1 AND revogada_em IS NULL ORDER BY id', [identidadeId])).map((s) => s.id);
  const pedidosDe = (identidadeId) => todos('SELECT * FROM redefinicoes_senha WHERE identidade_id = $1 ORDER BY id', [identidadeId]);
  const tentativasDe = (identidadeId) => todos('SELECT * FROM login_tentativas_globais WHERE identidade_id = $1 ORDER BY id', [identidadeId]);
  const chavesDeTentativa = async (identidadeId) => (await todos('SELECT DISTINCT chave_cooldown FROM login_tentativas_globais WHERE identidade_id = $1', [identidadeId])).map((l) => l.chave_cooldown);
  const auditoriaDe = (identidadeId) => todos('SELECT * FROM logs_auditoria_identidade WHERE identidade_id = $1 ORDER BY id', [identidadeId]);

  return {
    novaIdentidade, vincular, entrar, selecionar, empresarialSemGlobal, hashDaSenha, globais, empresariais, motivosGlobais, motivosEmpresariais,
    globalVale, empresarialVale, totalDeSessoes, globaisNaoRevogadasDe, pedidosDe, tentativasDe, chavesDeTentativa, auditoriaDe, um, todos,
  };
}

/** Fixtures do Painel Privado: administrador com TOTP ativo de segredo conhecido, recovery codes, sessão plena e desafios. */
function fabricaPainel({ pool, hashSenha }) {
  let sequencia = 0;
  const um = async (sql, parametros) => (await pool.query(sql, parametros)).rows[0];
  const todos = async (sql, parametros) => (await pool.query(sql, parametros)).rows;

  async function novoAdministrador({ ativo = true, comMfa = true } = {}) {
    sequencia += 1;
    const email = `admin-troca-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha]);
    const admin = {
      id, email, chaveLogin: cooldown.gerarChaveCooldownPlataforma(email), chaveMfa: cooldown.gerarChaveCooldownMfaPlataforma(id),
    };
    if (comMfa) {
      const segredo = crypto.randomBytes(20);
      const fatorUid = crypto.randomUUID();
      const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: id, fatorUid });
      const fator = await fatorRepo.criarPendenteTotp(pool, { administradorId: id, fatorUid, envelope, validadeMinutos: 15 });
      assert.equal(await fatorRepo.ativarTotp(pool, { administradorId: id, fatorId: fator.id, step: 1 }), true);
      const lote = await loteRepo.criar(pool, id);
      const codigos = Array.from({ length: 10 }, () => codigosMfa.gerarCodigo());
      const hashes = codigos.map((codigo) => codigosMfa.hashCodigoRecuperacao({ administradorId: id, codigo: codigosMfa.normalizarCodigo(codigo) }));
      assert.equal(await codigoRepo.inserirHashes(pool, { administradorId: id, loteId: lote.id, hashes }), 10);
      Object.assign(admin, {
        segredo, fatorId: fator.id, codigosRecuperacao: codigos, codigoTotp: (step) => totpReferencia.codigoDoStep(segredo, step),
      });
    }
    if (!ativo) await pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [id]);
    return admin;
  }

  const sessao = (admin) => criarSessaoAdministrativa(pool, admin.id);

  async function desafioAberto(admin, tipo = 'VERIFICACAO') {
    const criado = await desafioRepo.criar(pool, {
      administradorId: admin.id, tokenHash: token.hashTokenSessao(token.gerarTokenSessao()), tipo, validadeMinutos: 5,
    });
    return criado.id;
  }

  /** Step atual do TOTP com pelo menos 4 s de folga na janela de 30 s, pelo relógio do banco. */
  async function stepEstavel() {
    const instante = async () => (await um('SELECT clock_timestamp() AS t')).t.getTime();
    const agora = await instante();
    const restante = 30_000 - (agora % 30_000);
    if (restante > 4_000) return totpReferencia.stepDe(agora);
    await new Promise((resolve) => { setTimeout(resolve, restante + 100); });
    return totpReferencia.stepDe(await instante());
  }

  /** Um código que não vale em nenhuma das três janelas ao redor de `step`. */
  const codigoErrado = (admin, step) => {
    const naJanela = new Set([-1, 0, 1].map((d) => admin.codigoTotp(step + d)));
    return ['000000', '111111', '222222', '333333'].find((c) => !naJanela.has(c));
  };

  const hashDaSenha = async (administradorId) => (await um('SELECT senha_hash FROM administradores_plataforma WHERE id = $1', [administradorId])).senha_hash;
  const ultimoStep = async (administradorId) => {
    const linha = await um("SELECT totp_ultimo_step_aceito AS s FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [administradorId]);
    return linha === undefined ? null : Number(linha.s);
  };
  const sessoesDe = (administradorId) => todos('SELECT id, revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  const sessaoVale = async (s) => (await sessaoPlataformaRepo.buscarValidaPorHash(pool, token.hashTokenSessao(s.token), authConfig.sessao.inatividadeMinutos)) !== null;
  const desafiosDe = (administradorId) => todos('SELECT id, encerrado_em, motivo_encerramento FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  const pedidosDe = (administradorId) => todos('SELECT * FROM redefinicoes_senha_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  const tentativasDe = (administradorId) => todos('SELECT * FROM login_tentativas_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  // Evento do próprio administrador: ele é o ator e o alvo fica nulo (a trilha recusa alvo igual ao ator). Evento do sistema o tem como alvo.
  const auditoriaDe = (administradorId) => todos(
    'SELECT * FROM logs_auditoria_plataforma WHERE administrador_id = $1 OR administrador_afetado_id = $1 ORDER BY id', [administradorId],
  );

  /**
   * Fator, lotes, códigos e liberações do administrador. O step aceito e o carimbo de atualização do fator ficam de fora:
   * o anti-replay move o primeiro e o gatilho do banco move o segundo a cada UPDATE da linha.
   */
  async function estadoDoMfa(administradorId) {
    const fatores = (await todos('SELECT * FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]))
      .map(({ totp_ultimo_step_aceito: _step, atualizado_em: _atualizado, ...resto }) => resto);
    return {
      fatores,
      lotes: await todos('SELECT * FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
      codigos: await todos('SELECT * FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
      liberacoes: await todos('SELECT * FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
    };
  }

  const totalDeSessoes = async () => (await um('SELECT count(*)::int AS n FROM sessoes_plataforma')).n;

  return {
    novoAdministrador, sessao, desafioAberto, stepEstavel, codigoErrado, hashDaSenha, ultimoStep, sessoesDe, sessaoVale, desafiosDe, pedidosDe,
    tentativasDe, auditoriaDe, estadoDoMfa, totalDeSessoes, um, todos,
  };
}

module.exports = {
  SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, IP, DISPOSITIVO, MOTIVO, RESPOSTA,
  servicoGlobal, servicoPlataforma, poolEspiaoDetalhado, comandosDa, exigirOrdem, travaConsultivaLivre, travaMfaLivre, segurarTravaMfa,
  despejo, fabricaPortal, fabricaPainel,
};
