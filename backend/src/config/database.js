const { Pool } = require('pg');

// Pool de conexões com o PostgreSQL. O driver `pg` conecta sob demanda
// (na primeira query) — instanciar o Pool aqui não abre conexão nem
// exige que o banco já exista, então o servidor sobe normalmente mesmo
// sem Postgres disponível ainda.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// SEC-007: o objeto de erro do pg carrega mensagem, detail, hint, where,
// query interna e, em falha de rede, endereço e porta do servidor. O log
// leva só o nome do erro e o código (SQLSTATE ou código do Node), com o
// mesmo formato controlado do errorHandler; o resto é descartado.
const NOME_ERRO_FORMATO = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO_FORMATO = /^[A-Za-z0-9_.]{1,40}$/;

function descreverErroDoPool(err) {
  if (!(err instanceof Error)) {
    return { nome: 'NaoErro' };
  }
  const nome = err.constructor && err.constructor.name;
  const descricao = { nome: typeof nome === 'string' && NOME_ERRO_FORMATO.test(nome) ? nome : 'Error' };
  if (typeof err.code === 'string' && CODIGO_FORMATO.test(err.code)) {
    descricao.codigo = err.code;
  }
  return descricao;
}

pool.on('error', (err) => {
  console.error('[db] erro inesperado em cliente ocioso do pool', descreverErroDoPool(err));
});

module.exports = { pool };
