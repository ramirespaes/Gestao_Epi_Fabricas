'use strict';

const { normalizarEmail } = require('../utils/normalizacao');
const { TEMAS, MODOS_VISUAIS } = require('../utils/preferencias-aparencia');

/**
 * Repositório de identidades globais (identidades, migration 025) —
 * primeiro código do projeto a ESCREVER nessa tabela (Pacote 3, aceite de
 * convite do MASTER). Até aqui a tabela existia só estruturalmente.
 *
 * Mesmo padrão de administrador-plataforma.repository.js e
 * usuario.repository.js: executor por parâmetro, validação de formato via
 * exigir*, nenhuma regra de negócio, SQL parametrizado, e-mail já
 * normalizado pela camada acima. `senha_hash` só sai por
 * `buscarCredencialPorEmail` — a única leitura que precisa dela (prova de
 * titularidade no aceite de convite; futuro login global do Pacote 4).
 *
 * SEM empresa_id em lugar nenhum: identidade é global por definição
 * (migration 025). O vínculo com empresas é `usuarios.identidade_id`, que
 * pertence ao repositório de usuários.
 */

const EMAIL_TAMANHO_MAXIMO = 150;

function exigirId(valor) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
}

function exigirEmailNormalizado(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_TAMANHO_MAXIMO || normalizarEmail(email) !== email) {
    throw new TypeError('e-mail deve chegar normalizado');
  }
}

function exigirSenhaHash(senhaHash) {
  if (typeof senhaHash !== 'string' || senhaHash.length === 0) {
    throw new TypeError('hash de senha inválido');
  }
}

// Configurações (migration 072): telefone e aparência da pessoa saem com a
// identidade; o domínio dos valores é o de utils/preferencias-aparencia.js.
// Senha provisória (migration 074): o estado sai com a identidade; o hash, nunca.
const PROJECAO = 'id, email, telefone, tema, modo_visual, ativo, criado_em, atualizado_em, senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em';
const TELEFONE_TAMANHO_MAXIMO = 20;

function exigirTelefoneOpcional(telefone) {
  if (telefone !== null && (typeof telefone !== 'string' || telefone.trim().length === 0 || telefone.length > TELEFONE_TAMANHO_MAXIMO)) {
    throw new TypeError('telefone deve ser string não vazia de até 20 caracteres, ou null');
  }
}

function exigirPreferencia(valor, lista, nome) {
  if (valor !== null && !lista.includes(valor)) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  email: linha.email,
  telefone: linha.telefone ?? null,
  tema: linha.tema,
  modoVisual: linha.modo_visual,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
  senhaProvisoria: linha.senha_provisoria === true,
  senhaProvisoriaDefinidaEm: linha.senha_provisoria_definida_em ?? null,
  senhaProvisoriaExpiraEm: linha.senha_provisoria_expira_em ?? null,
});

function exigirValidadeProvisoria(validade) {
  if (!validade || !(validade.definidaEm instanceof Date) || !(validade.expiraEm instanceof Date) || !(validade.expiraEm > validade.definidaEm)) {
    throw new TypeError('validade da senha provisória inválida');
  }
}

const CPF_CANONICO = /^[0-9]{11}$/;

function exigirCpfOpcional(cpf) {
  if (cpf !== null && (typeof cpf !== 'string' || !CPF_CANONICO.test(cpf))) {
    throw new TypeError('CPF deve chegar canônico (11 dígitos) ou null');
  }
}

/**
 * Cria uma identidade. `ativo` nasce true pelo DEFAULT da migration 025 e não
 * é parâmetro. Com `senhaProvisoria` ({definidaEm, expiraEm}), nasce em troca
 * obrigatória (074); sem ela, senha definitiva, como o aceite de convite.
 * `cpf` (075) só entra pela criação administrativa, sempre com senha
 * provisória; definido, nunca muda (gatilho da 075). Sai só deste RETURNING.
 */
async function criar(executor, { email, senhaHash, senhaProvisoria = null, cpf = null }) {
  exigirEmailNormalizado(email);
  exigirSenhaHash(senhaHash);
  exigirCpfOpcional(cpf);

  if (senhaProvisoria !== null && cpf !== null) {
    exigirValidadeProvisoria(senhaProvisoria);
    const { rows } = await executor.query(
      `INSERT INTO identidades (email, senha_hash, senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em, cpf)
       VALUES ($1, $2, true, $3, $4, $5)
       RETURNING ${PROJECAO}, cpf`,
      [email, senhaHash, senhaProvisoria.definidaEm, senhaProvisoria.expiraEm, cpf],
    );
    return { ...mapear(rows[0]), cpf: rows[0].cpf };
  }
  if (cpf !== null) {
    throw new TypeError('CPF só entra com senha provisória (criação administrativa)');
  }

  if (senhaProvisoria !== null) {
    exigirValidadeProvisoria(senhaProvisoria);
    const { rows } = await executor.query(
      `INSERT INTO identidades (email, senha_hash, senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em)
       VALUES ($1, $2, true, $3, $4)
       RETURNING ${PROJECAO}`,
      [email, senhaHash, senhaProvisoria.definidaEm, senhaProvisoria.expiraEm],
    );
    return mapear(rows[0]);
  }

  const { rows } = await executor.query(
    `INSERT INTO identidades (email, senha_hash)
     VALUES ($1, $2)
     RETURNING ${PROJECAO}`,
    [email, senhaHash],
  );

  return mapear(rows[0]);
}

/** Busca pelo e-mail (case-insensitive, índice uq_identidades_email_lower), SEM senha_hash. */
async function buscarPorEmail(executor, email) {
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM identidades WHERE lower(email) = lower($1)`,
    [email],
  );

  return mapear(rows[0]);
}

/**
 * Só o id da identidade que tem este CPF (unicidade global, 075): serve à
 * recusa de CPF duplicado e nada mais — nem e-mail, nem situação.
 * @returns {Promise<{id:number}|null>}
 */
async function buscarPorCpf(executor, cpf) {
  if (typeof cpf !== 'string' || !CPF_CANONICO.test(cpf)) {
    throw new TypeError('CPF deve chegar canônico (11 dígitos)');
  }

  const { rows } = await executor.query('SELECT id FROM identidades WHERE cpf = $1', [cpf]);
  return rows[0] === undefined ? null : { id: rows[0].id };
}

/**
 * Única função que traz o hash da senha. Uso exclusivo de quem precisa
 * VERIFICAR a senha (aceite de convite com identidade existente; login
 * global do Pacote 4). Nunca serializar o resultado.
 *
 * @returns {Promise<{id:number, email:string, senhaHash:string, ativo:boolean}|null>}
 */
async function buscarCredencialPorEmail(executor, email) {
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    'SELECT id, email, senha_hash, ativo, senha_provisoria, senha_provisoria_expira_em FROM identidades WHERE lower(email) = lower($1)',
    [email],
  );

  const linha = rows[0];
  if (linha !== undefined) {
    return {
      id: linha.id, email: linha.email, senhaHash: linha.senha_hash, ativo: linha.ativo,
      senhaProvisoria: linha.senha_provisoria === true, senhaProvisoriaExpiraEm: linha.senha_provisoria_expira_em ?? null,
    };
  }
  return linha === undefined ? null : { id: linha.id, email: linha.email, senhaHash: linha.senha_hash, ativo: linha.ativo };
}

async function buscarPorId(executor, id) {
  exigirId(id);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM identidades WHERE id = $1`,
    [id],
  );

  return mapear(rows[0]);
}

/**
 * Trava a linha da identidade até o fim da transação e devolve a situação
 * lida sob a trava, sem o hash da senha. No ciclo de senha a conta é sempre
 * travada antes do pedido de redefinição.
 *
 * @returns {Promise<{id:number, email:string, ativo:boolean, telefone:string|null, tema:string, modoVisual:string}|null>}
 */
async function buscarPorIdParaAtualizacao(executor, id) {
  exigirId(id);

  const { rows } = await executor.query(
    `SELECT id, email, ativo, telefone, tema, modo_visual
       FROM identidades
      WHERE id = $1
        FOR UPDATE`,
    [id],
  );

  const linha = rows[0];
  return linha === undefined ? null : {
    id: linha.id, email: linha.email, ativo: linha.ativo, telefone: linha.telefone ?? null, tema: linha.tema, modoVisual: linha.modo_visual,
  };
}

/**
 * Configurações: telefone (quando informado; null limpa) e preferências de
 * aparência (null mantém). Devolve o que ficou gravado, ou null para
 * identidade inexistente. Valores já conferidos pelo schema; aqui só o formato.
 */
async function atualizarConta(executor, id, { telefone = null, telefoneInformado = false, tema = null, modoVisual = null }) {
  exigirId(id);
  exigirTelefoneOpcional(telefone);
  exigirPreferencia(tema, TEMAS, 'tema');
  exigirPreferencia(modoVisual, MODOS_VISUAIS, 'modo visual');

  const { rows } = await executor.query(
    `UPDATE identidades
        SET telefone = CASE WHEN $2::boolean THEN $3 ELSE telefone END,
            tema = COALESCE($4, tema),
            modo_visual = COALESCE($5, modo_visual)
      WHERE id = $1
      RETURNING telefone, tema, modo_visual`,
    [id, telefoneInformado === true, telefone, tema, modoVisual],
  );

  const linha = rows[0];
  return linha === undefined ? null : { telefone: linha.telefone ?? null, tema: linha.tema, modoVisual: linha.modo_visual };
}

/**
 * Configurações: grava o e-mail de acesso novo, já normalizado. A violação
 * de uq_identidades_email_lower sobe como veio (o serviço traduz).
 */
async function atualizarEmail(executor, id, email) {
  exigirId(id);
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    `UPDATE identidades
        SET email = $2
      WHERE id = $1
      RETURNING id, email`,
    [id, email],
  );

  const linha = rows[0];
  return linha === undefined ? null : { id: linha.id, email: linha.email };
}

/**
 * Redefinição ADMINISTRATIVA: grava o hash novo e coloca a identidade em senha
 * PROVISÓRIA (074) com a validade já calculada ({definidaEm, expiraEm}); a
 * troca obrigatória no próximo login é do ciclo existente.
 */
async function definirSenhaProvisoria(executor, id, senhaHash, validade) {
  exigirId(id);
  exigirSenhaHash(senhaHash);
  exigirValidadeProvisoria(validade);
  const { rows } = await executor.query(
    `UPDATE identidades
        SET senha_hash = $2, senha_provisoria = true, senha_provisoria_definida_em = $3, senha_provisoria_expira_em = $4
      WHERE id = $1
      RETURNING id`,
    [id, senhaHash, validade.definidaEm, validade.expiraEm],
  );
  return rows[0] !== undefined;
}

/**
 * Grava o hash novo da senha, que chega pronto do serviço, e encerra a senha
 * provisória (074): troca autenticada e redefinição por link passam por aqui,
 * então a troca obrigatória termina nos dois caminhos. Devolve null para
 * identidade inexistente. atualizado_em fica por conta do gatilho.
 */
async function atualizarSenhaHash(executor, id, senhaHash) {
  exigirId(id);
  exigirSenhaHash(senhaHash);

  const { rows } = await executor.query(
    `UPDATE identidades
        SET senha_hash = $2,
            senha_provisoria = false,
            senha_provisoria_definida_em = NULL,
            senha_provisoria_expira_em = NULL
      WHERE id = $1
      RETURNING id, atualizado_em`,
    [id, senhaHash],
  );

  const linha = rows[0];
  return linha === undefined ? null : { id: linha.id, atualizadoEm: linha.atualizado_em };
}

module.exports = {
  criar, buscarPorEmail, buscarPorCpf, buscarCredencialPorEmail, buscarPorId, buscarPorIdParaAtualizacao, atualizarSenhaHash, definirSenhaProvisoria, atualizarConta, atualizarEmail,
};
