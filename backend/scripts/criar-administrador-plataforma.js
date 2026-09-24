'use strict';

const administradorPlataformaService = require('../src/services/administrador-plataforma.service');
const { HttpError } = require('../src/errors/HttpError');

/**
 * Script administrativo: cria o(s) administrador(es) da PLATAFORMA
 * (Autenticação Global — Pacote 2, item 2: "primeiro acesso
 * administrativo"). Único chamador previsto do serviço `criarInicial` —
 * não existe, e não deve existir, rota HTTP de autocadastro.
 *
 *   node --require dotenv/config scripts/criar-administrador-plataforma.js --email <email> --confirmo
 *
 * SEM BACKDOOR, SEM SENHA NA LINHA DE COMANDO: a senha nunca é um argumento
 * (ficaria no histórico do shell e em `ps`) — vem exclusivamente da
 * variável de ambiente ADMINISTRADOR_PLATAFORMA_SENHA, lida uma única vez,
 * nunca logada, nunca ecoada.
 *
 * COMO DEFINIR A VARIÁVEL SEM DEIXAR A SENHA NO HISTÓRICO DO TERMINAL
 * (correção final do Pacote 2, item 6 da auditoria independente, ajustada
 * na rodada de fechamento para funcionar também no Zsh do macOS): a forma
 * `ADMINISTRADOR_PLATAFORMA_SENHA='...' node ...` numa única linha grava a
 * senha em texto claro no histórico do shell por padrão — o
 * `HISTCONTROL=ignorespace` que evitaria isso é uma configuração pessoal
 * do operador, nunca uma garantia do script.
 *
 * NÃO use `read -s -p "texto" VAR` como exemplo universal: em bash isso
 * mostra o prompt antes de ler; em Zsh, `-p` do builtin `read` tem outro
 * significado (lê de um coprocesso, não mostra prompt algum) — o comando
 * se comporta de forma diferente ou falha, dependendo da versão. O comando
 * abaixo funciona IDENTICAMENTE em bash e em Zsh (o shell padrão do
 * Terminal no macOS desde 2019), porque separa a exibição do prompt (
 * `printf`, sempre igual nos dois shells) da leitura silenciosa
 * (`read -s`, que os dois shells implementam do mesmo jeito):
 *
 *   printf 'Senha do administrador: '
 *   read -s ADMINISTRADOR_PLATAFORMA_SENHA
 *   printf '\n'
 *   export ADMINISTRADOR_PLATAFORMA_SENHA
 *   node --require dotenv/config scripts/criar-administrador-plataforma.js --email admin@safework.com.br --confirmo
 *   unset ADMINISTRADOR_PLATAFORMA_SENHA
 *
 * `read -s` não ecoa o que é digitado nem grava o valor em nenhuma linha
 * do histórico (só os comandos `printf`/`read`/`export`/`unset` em si são
 * registrados, nunca a senha). O `printf '\n'` depois do `read` só repõe a
 * quebra de linha que o terminal não mostrou por causa do `-s`. O `unset`
 * final remove a senha do ambiente do shell assim que o script termina —
 * ela não deve permanecer disponível para processos seguintes da mesma
 * sessão de terminal.
 *
 * `--confirmo` é obrigatório, mesma disciplina de `--confirmo-baseline` em
 * migrate-cli.js: sem ele, o script recusa executar e só mostra o uso — a
 * intenção precisa ser explícita, nunca o comportamento padrão de um
 * comando chamado sem argumentos.
 *
 * A senha passa pela MESMA política (`password-policy.js`) e pelo MESMO
 * Argon2id de qualquer outra credencial do sistema — nenhum caminho mais
 * fraco foi criado para este cadastro (ver administrador-plataforma.service.js).
 *
 * Este script NUNCA associa o administrador criado a nenhuma empresa, perfil
 * ou grupo de acesso: `administradores_plataforma` é estruturalmente isolada
 * de `usuarios`/`empresas` (migration 027).
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  SENHA_AUSENTE: 3,
  SENHA_INVALIDA: 4,
  EMAIL_INVALIDO: 5,
  EMAIL_EM_USO: 6,
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
    'Uso recomendado (evita a senha no histórico do terminal; funciona igual em bash e Zsh):',
    '  printf \'Senha do administrador: \'',
    '  read -s ADMINISTRADOR_PLATAFORMA_SENHA',
    '  printf \'\\n\'',
    '  export ADMINISTRADOR_PLATAFORMA_SENHA',
    '  node --require dotenv/config scripts/criar-administrador-plataforma.js --email <email> --confirmo',
    '  unset ADMINISTRADOR_PLATAFORMA_SENHA',
    '',
    '  --email      e-mail do administrador de plataforma a criar (obrigatório)',
    '  --confirmo   confirmação explícita de que a criação deve ser executada (obrigatório)',
    '',
    'A senha NUNCA deve ser passada como argumento nem numa linha do tipo',
    'ADMINISTRADOR_PLATAFORMA_SENHA=\'...\' node ... — essa forma fica gravada',
    'em texto claro no histórico do shell. Não use "read -s -p texto VAR" como',
    'exemplo universal: -p do read tem outro significado no Zsh (lê de um',
    'coprocesso, não mostra prompt). Use sempre "printf" seguido de "read -s"',
    '(ou o mecanismo equivalente do seu gestor de secrets) para digitá-la sem',
    'eco e sem deixar rastro no histórico.',
  ].join('\n');
}

/**
 * Executa o comando com um pool já configurado. Devolve o código de saída,
 * sem encerrar o pool (responsabilidade de quem chama).
 *
 * @param {{email: string, confirmo: boolean}} opcoes
 * @param {{pool: import('pg').Pool, senha: string|undefined, saida?: {log: Function, error: Function}}} dependencias
 */
async function executarComando({ email, confirmo }, { pool, senha, saida = console }) {
  if (typeof email !== 'string' || email.length === 0) throw new TypeError('email inválido');
  if (typeof confirmo !== 'boolean') throw new TypeError('confirmo deve ser booleano');

  if (!confirmo) {
    saida.error('Confirmação ausente: repita o comando com --confirmo para executar.');
    saida.error(uso());
    return SAIDAS.ARGUMENTOS;
  }

  if (typeof senha !== 'string' || senha.length === 0) {
    saida.error('ADMINISTRADOR_PLATAFORMA_SENHA ausente ou vazia: defina a variável de ambiente antes de executar.');
    return SAIDAS.SENHA_AUSENTE;
  }

  const { rows } = await pool.query('SELECT current_database() AS banco, inet_server_addr()::text AS servidor, inet_server_port() AS porta');
  saida.log(`Banco: ${rows[0].banco} em ${rows[0].servidor ?? '(socket local)'}:${rows[0].porta}`);

  try {
    const administrador = await administradorPlataformaService.criarInicial(pool, { email, senha });
    saida.log(`Administrador de plataforma criado: id=${administrador.id} email=${administrador.email} ativo=${administrador.ativo}`);
    saida.log(`criado_em=${administrador.criadoEm.toISOString()}`);
    return SAIDAS.OK;
  } catch (erro) {
    if (erro instanceof administradorPlataformaService.ErroSenhaInvalida) {
      saida.error('Senha recusada pela política vigente:');
      for (const item of erro.erros) {
        saida.error(`  - ${item.codigo}: ${item.mensagem}`);
      }
      return SAIDAS.SENHA_INVALIDA;
    }
    if (HttpError.ehHttpError(erro) && erro.codigo === 'ADMINISTRADOR_EMAIL_INVALIDO') {
      saida.error(`Recusado: ${erro.message} (${erro.codigo})`);
      return SAIDAS.EMAIL_INVALIDO;
    }
    if (HttpError.ehHttpError(erro) && erro.codigo === 'ADMINISTRADOR_EMAIL_EM_USO') {
      saida.error(`Recusado: ${erro.message} (${erro.codigo})`);
      return SAIDAS.EMAIL_EM_USO;
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
    return await executarComando(interpretado, { pool, senha: process.env.ADMINISTRADOR_PLATAFORMA_SENHA });
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
