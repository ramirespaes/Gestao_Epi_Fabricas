'use strict';

/**
 * Sonda somente leitura do estado das migrations aplicadas (CD do backend).
 *
 * Reutiliza inspecionarMigrations (scripts/migrate.js) com uma conexão própria: credencial dedicada de leitura, lida
 * de um arquivo local (--credencial <caminho absoluto>), nunca de variável de ambiente nem do .env da aplicação;
 * limites de conexão, de consulta e de execução; e sessão somente leitura.
 *
 * A identidade é consultada na MESMA sessão usada para ler as migrations: nome do banco, identificador único do
 * cluster (pg_control_system, que não exige privilégio administrativo e não depende de TCP, TLS ou socket) e a
 * confirmação de que o servidor não é uma réplica em recuperação. Quem confronta o cluster com o esperado é o agente,
 * pela configuração local dele.
 *
 * Falha fechada: qualquer erro, tabela de controle ausente, identidade não comprovada ou resultado fora do contrato
 * encerra com código diferente de zero e sem saída. Uma falha de leitura nunca vira "banco sem migrations". Em erro só
 * o código é escrito: nenhuma credencial, host ou mensagem do driver.
 *
 * Saída (uma linha JSON): { banco, papel, schema, sistema, migrations: [nome] }, com todas as migrations registradas,
 * inclusive as que o código instalado não tem. Quem carimba origem e horário é o agente, não a sonda.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIMITES = Object.freeze({ conexaoMs: 5000, consultaMs: 5000, execucaoMs: 15000 });
const TAMANHO_MAXIMO_DA_CREDENCIAL = 16 * 1024;
const FORMATO_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const FORMATO_NOME = /^[A-Za-z0-9_.-]+$/;
const FORMATO_SISTEMA = /^[1-9]\d{0,19}$/;
const CAMPOS_DA_CREDENCIAL = new Set(['host', 'porta', 'banco', 'usuario', 'senha', 'schema', 'sslModo', 'raizCa']);
const CONSULTA_DE_IDENTIDADE = 'SELECT current_database() AS banco, current_user AS papel, current_setting(\'transaction_read_only\') AS somente_leitura, '
  + 'pg_is_in_recovery() AS em_recuperacao, (SELECT system_identifier::text FROM pg_control_system()) AS sistema';

const recusa = (codigo) => Object.assign(new Error(codigo), { codigo });
const exigir = (ok, codigo) => { if (!ok) throw recusa(codigo); };
const texto = (v) => typeof v === 'string' && v.trim() !== '';
const opcional = (v) => v === undefined || texto(v);

function validarCredencial(d) {
  const ok = d !== null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).every((k) => CAMPOS_DA_CREDENCIAL.has(k))
    && texto(d.host) && Number.isInteger(d.porta) && d.porta >= 1 && d.porta <= 65535 && texto(d.banco) && texto(d.usuario) && texto(d.senha)
    && (d.schema === undefined || (typeof d.schema === 'string' && FORMATO_SCHEMA.test(d.schema))) && opcional(d.sslModo) && opcional(d.raizCa);
  exigir(ok, 'SONDA_CREDENCIAL');
  return { host: d.host, porta: d.porta, banco: d.banco, usuario: d.usuario, senha: d.senha, schema: d.schema === undefined ? 'public' : d.schema, tls: { modo: d.sslModo, raizCa: d.raizCa } };
}

// Arquivo regular, do próprio usuário, sem acesso de grupo ou outros, com um único nome e sem link em nenhum ponto do
// caminho. As checagens são feitas no descritor já aberto (sem seguir link), não no nome.
function lerCredencial(caminho, portas = {}) {
  const uid = portas.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : portas.uid;
  let fd;
  try {
    exigir(texto(caminho) && path.isAbsolute(caminho) && uid !== null, 'SONDA_CREDENCIAL');
    exigir(fs.realpathSync(caminho) === caminho, 'SONDA_CREDENCIAL');
    fd = fs.openSync(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    exigir(st.isFile() && st.nlink === 1 && st.uid === uid && (st.mode & 0o077) === 0 && st.size > 0 && st.size <= TAMANHO_MAXIMO_DA_CREDENCIAL, 'SONDA_CREDENCIAL');
    return validarCredencial(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } catch {
    throw recusa('SONDA_CREDENCIAL');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* o fechamento não muda o resultado */ } }
  }
}

// Um único SELECT por chamada: sem ponto e vírgula e sem CTE, que poderia carregar um comando de escrita.
const somenteSelect = (sql) => typeof sql === 'string' && /^\s*SELECT\b/i.test(sql) && !sql.includes(';');

// Conexão entregue ao inspetor: ao conectar comprova a identidade na própria sessão e depois só deixa passar SELECT.
function criarFabrica({ conf, Client, limites, opcoesTls }) {
  const estado = { identidade: null };
  const fabrica = () => {
    const cliente = new Client({
      host: conf.host, port: conf.porta, database: conf.banco, user: conf.usuario, password: conf.senha,
      connectionTimeoutMillis: limites.conexaoMs, query_timeout: limites.consultaMs, statement_timeout: limites.consultaMs,
      application_name: 'safework-sonda-estado', options: '-c default_transaction_read_only=on', ...opcoesTls,
    });
    const consultar = async (sql, valores) => {
      try { return await cliente.query(sql, valores); } catch { throw recusa('SONDA_CONSULTA'); }
    };
    return {
      connect: async () => {
        try { await cliente.connect(); } catch { throw recusa('SONDA_CONEXAO'); }
        try {
          const { rows } = await consultar(CONSULTA_DE_IDENTIDADE);
          const linha = rows && rows[0];
          exigir(linha && linha.banco === conf.banco, 'SONDA_BANCO_DIVERGENTE');
          exigir(linha.somente_leitura === 'on', 'SONDA_SESSAO_COM_ESCRITA');
          exigir(linha.em_recuperacao === false, 'SONDA_SERVIDOR_EM_RECUPERACAO');
          exigir(typeof linha.sistema === 'string' && FORMATO_SISTEMA.test(linha.sistema), 'SONDA_IDENTIDADE_NAO_COMPROVADA');
          estado.identidade = { banco: linha.banco, papel: linha.papel, sistema: linha.sistema };
        } catch (falha) {
          // O inspetor só encerra a conexão depois de um connect bem-sucedido: aqui ela é encerrada pela sonda.
          try { await cliente.end(); } catch { /* o encerramento não muda o resultado */ }
          throw falha;
        }
      },
      query: async (sql, valores) => {
        exigir(somenteSelect(sql), 'SONDA_ESCRITA_RECUSADA');
        return consultar(sql, valores);
      },
      end: async () => { try { await cliente.end(); } catch { /* o encerramento não muda o resultado */ } },
    };
  };
  return { fabrica, estado };
}

function comLimite(promessa, ms) {
  let relogio;
  const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(recusa('SONDA_TIMEOUT')), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

async function observar({ conf, Client, inspecionar, diretorio, limites = LIMITES, opcoesTls = {} }) {
  const { fabrica, estado } = criarFabrica({ conf, Client, limites, opcoesTls });
  let resultado;
  try {
    resultado = await comLimite(inspecionar({ schema: conf.schema, diretorio, criarCliente: fabrica }), limites.execucaoMs);
  } catch (falha) {
    throw recusa(falha && typeof falha.codigo === 'string' && falha.codigo.startsWith('SONDA_') ? falha.codigo : 'SONDA_CONSULTA');
  }
  exigir(estado.identidade !== null, 'SONDA_IDENTIDADE_NAO_COMPROVADA');
  exigir(resultado !== null && typeof resultado === 'object' && Array.isArray(resultado.aplicadas) && Array.isArray(resultado.semArquivo), 'SONDA_RESULTADO_INVALIDO');
  exigir(resultado.controleExiste === true, 'SONDA_TABELA_DE_CONTROLE_AUSENTE');
  const migrations = [...resultado.aplicadas, ...resultado.semArquivo];
  exigir(migrations.length > 0 && migrations.every((n) => typeof n === 'string' && FORMATO_NOME.test(n)) && new Set(migrations).size === migrations.length, 'SONDA_RESULTADO_INVALIDO');
  return { banco: estado.identidade.banco, papel: estado.identidade.papel, schema: conf.schema, sistema: estado.identidade.sistema, migrations };
}

// O driver e o inspetor só são carregados aqui, na execução real: os testes do núcleo não dependem deles.
function dependenciasReais(conf) {
  const { Client } = require('pg');
  const { inspecionarMigrations } = require('./migrate');
  const { opcoesDeTls } = require('../src/config/database-tls');
  return { Client, inspecionar: inspecionarMigrations, diretorio: path.join(__dirname, '..', 'migrations'), opcoesTls: opcoesDeTls({ modo: conf.tls.modo, raizCa: conf.tls.raizCa, host: conf.host }) };
}

async function principal({ argv = process.argv.slice(2), saida = (t) => process.stdout.write(t), erro = (t) => process.stderr.write(t), ...injetadas } = {}) {
  try {
    exigir(argv.length === 2 && argv[0] === '--credencial', 'SONDA_USO');
    const conf = lerCredencial(argv[1]);
    const deps = injetadas.Client ? injetadas : { ...dependenciasReais(conf), ...injetadas };
    const estado = await observar({ ...deps, conf });
    saida(`${JSON.stringify(estado)}\n`);
    return 0;
  } catch (falha) {
    erro(`sonda recusou: ${falha && typeof falha.codigo === 'string' && falha.codigo.startsWith('SONDA_') ? falha.codigo : 'SONDA_ERRO'}\n`);
    return 3;
  }
}

if (require.main === module) {
  // Encerra mesmo que uma conexão presa mantenha o processo vivo depois do limite de execução.
  principal().then((codigo) => process.exit(codigo));
}

module.exports = { observar, principal, validarCredencial, lerCredencial, LIMITES };
