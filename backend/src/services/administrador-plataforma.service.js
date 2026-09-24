'use strict';

const { HttpError } = require('../errors/HttpError');
const { normalizarEmail } = require('../utils/normalizacao');
const passwordPolicy = require('../security/password-policy');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const password = require('../security/password');

/**
 * Cadastro do administrador de plataforma (Autenticação Global — Pacote 2,
 * item 2: "primeiro acesso administrativo").
 *
 * PROCEDIMENTO CONTROLADO, NÃO CADASTRO PÚBLICO: esta função não é exposta
 * por nenhuma rota HTTP — o único chamador previsto é o script
 * administrativo `scripts/criar-administrador-plataforma.js`, executado
 * manualmente por um operador com acesso ao ambiente (mesma família de
 * `scripts/provisionar-permissoes-master.js`, Bloco 9). Não há, hoje, e não
 * deve haver, um endpoint `POST /api/plataforma/administradores` de
 * autocadastro.
 *
 * SEM BACKDOOR: nenhuma senha ou hash fixo existe neste arquivo, no script
 * ou em qualquer fixture de produção — a senha chega sempre por parâmetro,
 * de uma fonte externa (variável de ambiente lida só no momento da
 * execução, nunca commitada), e passa pela MESMA política de senha e pelo
 * MESMO Argon2id de qualquer outra credencial do sistema
 * (`validarPoliticaSenha`, `password.gerarHashSenha` — nenhum caminho
 * alternativo, mais fraco, foi criado para este cadastro).
 *
 * IDEMPOTÊNCIA: tentar criar um administrador para um e-mail que já existe
 * recusa com 409, sem revelar mais nada sobre a conta existente — evita
 * que rodar o script duas vezes por engano sobrescreva ou duplique uma
 * conta real.
 *
 * TRANSAÇÃO (correção final do Pacote 2, item 2 da auditoria independente):
 * a verificação de idempotência (`buscarPorEmail`) é uma leitura simples,
 * feita antes de abrir qualquer transação — não precisa de atomicidade com
 * o que vem depois, e a UNIQUE de `administradores_plataforma` (027)
 * continua sendo a garantia real contra duas execuções concorrentes. A
 * CRIAÇÃO da linha e o REGISTRO DE AUDITORIA, esses sim, agora rodam na
 * MESMA transação (`emTransacao`, mesmo helper já usado por outros
 * serviços do projeto — ex.: `provisionamento-permissoes.service.js`,
 * `material.service.js`): se a auditoria falhar por qualquer motivo
 * (inclusive a própria trigger de `logs_auditoria_plataforma` recusando
 * uma chave sensível por engano de programação), a transação inteira sofre
 * ROLLBACK e a conta NUNCA fica criada sem o registro correspondente — o
 * INSERT em `administradores_plataforma` e o INSERT em
 * `logs_auditoria_plataforma` são um único evento atômico, nunca dois.
 *
 * Como efeito direto de tornar a criação transacional, uma corrida entre
 * duas execuções do script para o MESMO e-mail (ambas passando pelo
 * pré-checagem antes de qualquer uma inserir) agora é tratada
 * explicitamente: a que perde a corrida recebe a violação UNIQUE do
 * PostgreSQL (SQLSTATE 23505) dentro da transação, que é traduzida para o
 * MESMO 409 ADMINISTRADOR_EMAIL_EM_USO da checagem antecipada — nunca um
 * erro genérico de SQL vazando para o operador do script.
 */

const MSG_EMAIL_INVALIDO = 'E-mail inválido';
const MSG_EMAIL_EM_USO = 'Já existe um administrador de plataforma com este e-mail';
const SQLSTATE_VIOLACAO_UNIQUE = '23505';

class ErroSenhaInvalida extends Error {
  constructor(erros) {
    super('senha não atende à política exigida');
    this.name = 'ErroSenhaInvalida';
    this.erros = erros;
  }
}

/** Mesmo helper de transação já usado por outros services do projeto (pool.connect + BEGIN/COMMIT/ROLLBACK). */
async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

/**
 * Cria o administrador de plataforma inicial. Nunca associa a nenhuma
 * empresa, nunca concede acesso operacional — a linha criada só existe em
 * `administradores_plataforma`, estruturalmente fora de qualquer consulta
 * a `usuarios`/`empresas` (ver migration 027).
 *
 * @param {import('pg').Pool} pool
 * @param {{email: string, senha: string}} dados
 * @returns {Promise<{id: number, email: string, ativo: boolean}>}
 */
async function criarInicial(pool, { email, senha }) {
  const emailNormalizado = normalizarEmail(email);
  if (emailNormalizado === null) {
    throw HttpError.badRequest('ADMINISTRADOR_EMAIL_INVALIDO', MSG_EMAIL_INVALIDO);
  }

  const politica = passwordPolicy.validarPoliticaSenha(senha, { email: emailNormalizado });
  if (!politica.ok) {
    throw new ErroSenhaInvalida(politica.erros);
  }

  const existente = await administradorRepo.buscarPorEmail(pool, emailNormalizado);
  if (existente !== null) {
    throw HttpError.conflict('ADMINISTRADOR_EMAIL_EM_USO', MSG_EMAIL_EM_USO);
  }

  const senhaHash = await password.gerarHashSenha(senha);

  try {
    return await emTransacao(pool, async (client) => {
      const administrador = await administradorRepo.criar(client, { email: emailNormalizado, senhaHash });

      // Auditoria da própria criação, NA MESMA TRANSAÇÃO do INSERT acima —
      // sem administrador "responsável" nesta primeira versão (o ator É o
      // administrador recém-criado, e ele mesmo não pode ter concedido a
      // si mesmo — é um procedimento de bootstrap, fora do fluxo de
      // convite entre administradores, que fica para um pacote futuro).
      // Nenhum dado sensível: só o e-mail (não é segredo) e o
      // identificador criado. Se este INSERT falhar (inclusive pela
      // trigger de dado sensível), o ROLLBACK de emTransacao desfaz também
      // o administrador acima — nunca fica um sem o outro.
      await auditoriaRepo.registrar(client, {
        administradorId: administrador.id,
        acao: 'ADMINISTRADOR_PLATAFORMA_CRIADO',
        referencia: String(administrador.id),
        contexto: { origem: 'script_administrativo_bootstrap' },
        dadosNovos: { email: administrador.email, ativo: administrador.ativo },
      });

      return administrador;
    });
  } catch (erro) {
    if (erro && erro.code === SQLSTATE_VIOLACAO_UNIQUE) {
      throw HttpError.conflict('ADMINISTRADOR_EMAIL_EM_USO', MSG_EMAIL_EM_USO);
    }
    throw erro;
  }
}

module.exports = { criarInicial, ErroSenhaInvalida };
