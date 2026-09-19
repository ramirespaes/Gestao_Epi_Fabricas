'use strict';

const { Client } = require('pg');

const { listarMigrations } = require('../src/db/checksums');

/**
 * Adaptador do node-pg-migrate.
 *
 * Integração e configuração apenas: quem aplica, ordena, trava e registra é a
 * biblioteca. Aqui só montamos a conexão a partir das variáveis já existentes
 * do projeto, fixamos as opções que o projeto decidiu e devolvemos o
 * resultado. Nenhuma lógica de migration é reimplementada.
 *
 * A conexão é montada em memória com pg.Client, a partir de DB_HOST, DB_PORT,
 * DB_NAME, DB_USER e DB_PASSWORD. Não existe DATABASE_URL: além de duplicar
 * credencial, uma URL passada por linha de comando ficaria visível na
 * listagem de processos da máquina. A senha nunca é impressa e nunca entra em
 * mensagem de erro daqui.
 *
 * Antes de qualquer conexão, o diretório passa pelo preflight de nomenclatura
 * de src/db/checksums.js, que é a mesma regra usada pelo verificador de
 * checksums. Assim a convenção existe em um lugar só.
 *
 * O runner recebe o cliente já conectado pela opção dbClient e, nesse modo,
 * não encerra a conexão, então o encerramento é responsabilidade deste módulo
 * e acontece sempre, inclusive em falha.
 *
 * baseline: true registra as migrations pendentes sem executar o SQL delas.
 * Serve para um banco cuja estrutura já existe de antes do controle de
 * migrations. A opção equivalente da biblioteca não é exposta na nossa API,
 * para que o uso seja sempre deliberado e com nome próprio.
 */

// Identificador PostgreSQL simples, o suficiente para test_migration_<hex> e
// para os schemas do projeto. O nome nunca é concatenado em SQL por nós: quem
// o interpola, com aspas, é a biblioteca. Esta validação é defesa adicional.
const FORMATO_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const TABELA_CONTROLE = 'pgmigrations';

// A biblioteca lista todo o conteúdo do diretório e exige prefixo numérico em
// cada arquivo, então o manifesto migrations/checksums.json a faria falhar.
// O padrão abaixo é entregue à opção ignorePattern, que ancora entre ^ e $ e
// ignora o que casa: aqui, exatamente o que não é um arquivo .sql.
//
// Ele não decide quais .sql são migrations válidas. Essa decisão é do
// preflight, porque um .sql com nome fora da convenção precisa causar erro
// explícito, e não ser descartado em silêncio como se não existisse.
const IGNORAR_NAO_SQL = '(?!.*\\.sql$).*';

const identificadorDe = (nomeDeArquivo) => nomeDeArquivo.replace(/\.sql$/, '');

function criarCliente() {
  return new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

/**
 * Aplica as migrations pendentes do diretório no schema informado.
 *
 * @param {object} opcoes
 * @param {string} opcoes.schema schema de trabalho e da tabela de controle
 * @param {string} opcoes.diretorio diretório dos arquivos .sql
 * @param {boolean} [opcoes.baseline] registra sem executar o SQL
 * @returns {Promise<Array<{name: string, path: string}>>} o que foi aplicado
 */
async function aplicarMigrations({ schema, diretorio, baseline = false }) {
  if (typeof schema !== 'string' || !FORMATO_SCHEMA.test(schema)) {
    throw new TypeError('nome de schema inválido');
  }
  if (typeof diretorio !== 'string' || diretorio.length === 0) {
    throw new TypeError('diretório de migrations inválido');
  }
  // Sem coerção de propósito. baseline liga o registro sem execução, então um
  // valor apenas truthy marcaria as migrations como aplicadas sem que o SQL
  // rodasse. Só o booleano literal é aceito.
  if (typeof baseline !== 'boolean') {
    throw new TypeError('baseline deve ser booleano');
  }

  // Preflight antes de abrir conexão: a mesma regra de nomenclatura usada pelo
  // verificador de checksums, em src/db/checksums.js. Ela recusa nome fora do
  // padrão NNN_descricao.sql, prefixo com largura diferente de três dígitos e
  // prefixo duplicado. Um arquivo .sql inválido falha aqui, sem tocar no banco.
  listarMigrations(diretorio);

  const cliente = criarCliente();
  await cliente.connect();

  try {
    const { runner } = await import('node-pg-migrate');

    return await runner({
      dbClient: cliente,
      dir: diretorio,
      ignorePattern: IGNORAR_NAO_SQL,
      direction: 'up',
      schema,
      migrationsSchema: schema,
      createSchema: false,
      createMigrationsSchema: false,
      migrationsTable: TABELA_CONTROLE,
      checkOrder: true,
      singleTransaction: true,
      noLock: false,
      advisoryLockMode: 'fail',
      fake: baseline,
      verbose: false,
    });
  } finally {
    await cliente.end();
  }
}

/**
 * Lê o estado das migrations de um schema, sem alterar nada.
 *
 * Somente SELECT: não cria a tabela de controle, não aplica migration e não
 * escreve em lugar algum. A ausência da tabela de controle é informação, não
 * motivo para criá-la.
 *
 * Um schema que já tem tabelas e não tem a tabela de controle é um banco
 * migrado antes do controle existir. Isso é reportado em schemaTemObjetos, e
 * quem decide o que fazer com essa informação é quem chama. A presença de
 * tabelas nunca prova que todas as migrations foram aplicadas.
 *
 * @param {object} opcoes
 * @param {string} opcoes.schema
 * @param {string} opcoes.diretorio
 * @returns {Promise<{controleExiste: boolean, schemaTemObjetos: boolean,
 *   aplicadas: string[], pendentes: string[], semArquivo: string[]}>}
 */
async function inspecionarMigrations({ schema, diretorio }) {
  if (typeof schema !== 'string' || !FORMATO_SCHEMA.test(schema)) {
    throw new TypeError('nome de schema inválido');
  }
  if (typeof diretorio !== 'string' || diretorio.length === 0) {
    throw new TypeError('diretório de migrations inválido');
  }

  const arquivos = listarMigrations(diretorio).map((migration) => identificadorDe(migration.nome));
  const cliente = criarCliente();
  await cliente.connect();

  try {
    const controle = await cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [
      `${schema}.${TABELA_CONTROLE}`,
    ]);
    const controleExiste = controle.rows[0].existe;

    const objetos = await cliente.query(
      'SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = $1 AND tablename <> $2',
      [schema, TABELA_CONTROLE],
    );
    const schemaTemObjetos = objetos.rows[0].total > 0;

    let registradas = [];
    if (controleExiste) {
      const { rows } = await cliente.query(
        `SELECT name FROM "${schema}"."${TABELA_CONTROLE}" ORDER BY id`,
      );
      registradas = rows.map((linha) => linha.name);
    }

    const conjuntoArquivos = new Set(arquivos);
    const conjuntoRegistradas = new Set(registradas);

    return {
      controleExiste,
      schemaTemObjetos,
      aplicadas: registradas.filter((nome) => conjuntoArquivos.has(nome)),
      semArquivo: registradas.filter((nome) => !conjuntoArquivos.has(nome)),
      pendentes: arquivos.filter((nome) => !conjuntoRegistradas.has(nome)),
    };
  } finally {
    await cliente.end();
  }
}

module.exports = { aplicarMigrations, inspecionarMigrations, identificadorDe };
