'use strict';

const { verificarComunicacao, bancoIndisponivel } = require('../src/services/token-monitoramento.service');
const { criarSondaPublica } = require('../src/utils/sonda-publica');
const { ErroDoJob, lerConfiguracaoDoJob, exigirIdentidadeDoJob } = require('../src/security/autoridade-job-interno');

/**
 * Verificação de comunicação dos tablets do Atendimento Token (Etapa J, J2a), para um agendador EXTERNO: uma passagem e termina.
 * Nunca um timer dentro do processo da API, nunca um servidor, nunca uma rota.
 *
 *   npm run token:verificar-comunicacao
 *
 * Sequência: configuração do job (sem ela, não opera) → pool com a credencial PRÓPRIA do job → consulta trivial ao banco →
 * identidade e privilégios do papel conferidos no banco → passagem de verificarComunicacao com a sonda pública. Duas execuções
 * sobrepostas ou um reinício depois de interrupção são seguros: o estado está no banco e as transições são atômicas. A saída é só
 * contagem e códigos: nenhum tablet, empresa, URL ou segredo.
 *
 * Códigos de saída: 0 passagem concluída; 1 configuração/autoridade inválida ou falha inesperada; 2 passagem abortada pela sonda
 * (reprovada ou inconclusiva); 3 banco indisponível.
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1, SONDA: 2, BANCO: 3 });
const TAG = '[token-monitoramento]';

// A classificação de "banco indisponível" é do serviço (definição única, importada acima); o executor só traduz para código de saída.
// Falta de privilégio, SQL inválido, autoridade recusada e defeito NÃO são indisponibilidade: saem com o código 1.

const descrever = (erro) => ({ nome: typeof erro?.name === 'string' ? erro.name.slice(0, 64) : 'Erro', ...(typeof erro?.code === 'string' ? { codigo: erro.code.slice(0, 40) } : {}) });

// Schema das operações do job: origem confiável (variável de ambiente do operador, nunca tablet, HTTP ou banco), identificador simples
// validado, padrão `public` (o schema efetivo da API, que não configura search_path). Um schema temporário de teste é informado aqui.
const SCHEMA_PADRAO = 'public';
const FORMATO_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

function schemaDoJob(env) {
  const valor = env.TOKEN_JOB_DB_SCHEMA === undefined ? SCHEMA_PADRAO : env.TOKEN_JOB_DB_SCHEMA;
  if (typeof valor !== 'string' || !FORMATO_SCHEMA.test(valor) || valor.startsWith('pg_') || valor === 'information_schema') {
    throw new ErroDoJob('CONFIGURACAO_INVALIDA', ['TOKEN_JOB_DB_SCHEMA']);
  }
  return valor;
}

// Cada sessão do pool nasce com o caminho de busca no schema autorizado e `pg_temp` EXPLICITAMENTE depois dele (relações são
// pesquisadas em pg_temp primeiro quando ele não é citado). `pg_catalog` segue implícito e antes de tudo. O parâmetro de partida
// sobrepõe PGOPTIONS e configurações de papel ou banco; o job não emite SET search_path (teste estático).
const searchPathDoJob = (schema) => `-c search_path=${schema},pg_temp`;

function criarPoolDoJob({ host, port, database, user, password, schema }, { Pool = require('pg').Pool } = {}) {
  return new Pool({
    host, port, database, user, password, options: searchPathDoJob(schema),
    max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000, statement_timeout: 30000, application_name: 'safework-job-token',
  });
}

async function executar({ pool, sonda, relogio, saida, papelEsperado, bancoEsperado, schemaEsperado }) {
  try {
    await pool.query('SELECT 1');
  } catch (erro) {
    if (bancoIndisponivel(erro)) {
      saida.error(TAG, { evento: 'banco_indisponivel', etapa: 'consulta_trivial' });
      return SAIDAS.BANCO;
    }
    throw erro;
  }
  try {
    await exigirIdentidadeDoJob(pool, { papelEsperado, bancoEsperado, schemaEsperado });
  } catch (erro) {
    if (erro instanceof ErroDoJob) {
      saida.error(TAG, { evento: 'autoridade_invalida', codigo: erro.codigo, campos: erro.campos });
      return SAIDAS.ERRO;
    }
    throw erro;
  }
  const resultado = await verificarComunicacao(pool, { relogio, sonda });
  if (!resultado.abortada) {
    saida.log(TAG, { evento: 'passagem_concluida', quedas: resultado.quedas, suspeitasFuturas: resultado.suspeitasFuturas });
    return SAIDAS.OK;
  }
  saida.error(TAG, { evento: 'passagem_abortada', motivo: resultado.motivo, suspeitasInvalidadas: resultado.suspeitasInvalidadas });
  return resultado.motivo === 'BANCO_INDISPONIVEL' ? SAIDAS.BANCO : SAIDAS.SONDA;
}

/** Composição completa com fábricas injetáveis (testes usam fábricas falsas; a produção usa o pool real e a sonda real). */
async function executarJob({
  env = process.env, criarPool = criarPoolDoJob, criarSonda = criarSondaPublica, relogio = () => new Date(), saida = console,
} = {}) {
  let config;
  let schema;
  try {
    config = lerConfiguracaoDoJob(env);
    schema = schemaDoJob(env);
  } catch (erro) {
    saida.error(TAG, { evento: 'configuracao_invalida', codigo: erro instanceof ErroDoJob ? erro.codigo : 'DESCONHECIDO', campos: erro instanceof ErroDoJob ? erro.campos : [] });
    return SAIDAS.ERRO;
  }
  let pool;
  try {
    pool = criarPool({ ...config.banco, schema });
    if (typeof pool.on === 'function') pool.on('error', (erro) => saida.error(TAG, { evento: 'erro_em_cliente_ocioso', ...descrever(erro) }));
    const sonda = criarSonda({ origem: config.sondaOrigem });
    return await executar({ pool, sonda, relogio, saida, papelEsperado: config.papelEsperado, bancoEsperado: config.banco.database, schemaEsperado: schema });
  } catch (erro) {
    if (bancoIndisponivel(erro)) {
      saida.error(TAG, { evento: 'banco_indisponivel' });
      return SAIDAS.BANCO;
    }
    saida.error(TAG, { evento: 'falha_inesperada', ...descrever(erro) });
    return SAIDAS.ERRO;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch (erro) {
        saida.error(TAG, { evento: 'falha_ao_encerrar_pool', ...descrever(erro) });
      }
    }
  }
}

if (require.main === module) {
  executarJob()
    .then((codigo) => { process.exitCode = codigo; })
    .catch(() => { process.exitCode = SAIDAS.ERRO; });
}

module.exports = { executar, executarJob, criarPoolDoJob, schemaDoJob, searchPathDoJob, SAIDAS };
