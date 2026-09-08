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

pool.on('error', (err) => {
  console.error('[db] erro inesperado em cliente ocioso do pool', err);
});

module.exports = { pool };
