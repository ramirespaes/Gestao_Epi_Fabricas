'use strict';

const path = require('node:path');

const { listarMigrations, lerManifesto, compararComManifesto, temDivergencia } = require('./checksums');

/**
 * Guarda de inicialização (P1, 15/10/2026).
 *
 * Antes de subir a API, confere por LEITURA que o processo está ligado ao
 * banco esperado e que a estrutura desse banco é compatível com o código que
 * vai rodar. Motivo: o backend sobe o pool sem olhar o banco, então um banco
 * atrasado só falha no primeiro uso (coluna inexistente → "Erro interno").
 *
 * Contrato: nunca executa migration, nunca escreve. Toda consulta roda numa
 * transação READ ONLY encerrada com ROLLBACK. Falha fechada: qualquer
 * problema impede a inicialização, com mensagem que diz o quê e como corrigir
 * pelo caminho oficial (sem executá-lo).
 *
 * Banco permitido: só os nomeados, por igualdade exata, em
 * GUARDA_BANCOS_PERMITIDOS (separados por vírgula). Não há banco padrão, curinga
 * nem opção de desligar a guarda: sem a variável (ausente, vazia ou só
 * espaços) a guarda reprova antes de qualquer conexão.
 */

const VARIAVEL_BANCOS_PERMITIDOS = 'GUARDA_BANCOS_PERMITIDOS';
const DIRETORIO_PADRAO = path.join(__dirname, '..', '..', 'migrations');
const SCHEMA_PADRAO = 'public';
const MANIFESTO = 'checksums.json';

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1, REPROVADA: 3 });

// Defesa em profundidade além de "0 pendentes": objetos que o código mais
// recente usa e que faltam num banco atrasado. coluna null = basta a tabela.
const SENTINELAS = Object.freeze([
  { migration: '079_alter_logs_auditoria_add_perfil_ator', tabela: 'logs_auditoria', coluna: 'perfil_ator' },
  { migration: '080_create_fiscalizacao_pacotes', tabela: 'fiscalizacao_pacotes', coluna: null },
  { migration: '082_create_tipos_material_classificacao_v2', tabela: 'tipos_material', coluna: null },
  { migration: '084_alter_funcionarios_add_situacao', tabela: 'funcionarios', coluna: 'situacao' },
  { migration: '086_create_atendimento_token', tabela: 'token_dispositivos', coluna: null },
  { migration: '089_token_dispositivos_queda_suspeita', tabela: 'token_dispositivos', coluna: 'queda_suspeita_desde' },
  { migration: '091_alter_empresas_add_emails_sst_almoxarifado_versao', tabela: 'empresas', coluna: 'versao' },
]);

function bancosPermitidos(env) {
  return typeof env[VARIAVEL_BANCOS_PERMITIDOS] === 'string'
    ? env[VARIAVEL_BANCOS_PERMITIDOS].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
}

const PROBLEMA_LISTA_NAO_CONFIGURADA = Object.freeze({
  codigo: 'BANCOS_PERMITIDOS_NAO_CONFIGURADOS',
  mensagem: `${VARIAVEL_BANCOS_PERMITIDOS} não está configurada (ausente, vazia ou só com espaços); informe o nome exato do banco deste ambiente, ou vários separados por vírgula`,
});

/** Avaliação pura: recebe o que foi observado e devolve problemas e resumo. */
function avaliar({ env, observado }) {
  const problemas = [];
  const permitidos = bancosPermitidos(env);
  const m = observado.migrations;

  if (permitidos.length === 0) {
    problemas.push({ ...PROBLEMA_LISTA_NAO_CONFIGURADA });
  } else if (!permitidos.includes(observado.banco)) {
    problemas.push({ codigo: 'BANCO_NAO_PERMITIDO', mensagem: `banco conectado "${observado.banco}" não é um banco permitido (${permitidos.join(', ')})` });
  }
  if (env.DB_NAME && observado.banco !== env.DB_NAME) {
    problemas.push({ codigo: 'BANCO_DIFERENTE_DO_PEDIDO', mensagem: `DB_NAME pede "${env.DB_NAME}" mas a conexão está em "${observado.banco}"` });
  }
  if (env.DB_USER && observado.papel !== env.DB_USER) {
    problemas.push({ codigo: 'PAPEL_INESPERADO', mensagem: `papel da sessão "${observado.papel}" difere de DB_USER "${env.DB_USER}"` });
  }
  if (!m.controleExiste) {
    problemas.push({ codigo: 'CONTROLE_AUSENTE', mensagem: 'a tabela de controle de migrations não existe neste banco' });
  }
  if (m.pendentes.length > 0) {
    problemas.push({ codigo: 'MIGRATIONS_PENDENTES', mensagem: `${m.pendentes.length} migration(s) pendente(s): ${m.pendentes.join(', ')} — aplique pelo caminho oficial (backup antes; depois "npm run db:migrate" com DB_NAME explícito); a guarda não aplica nada` });
  }
  if (m.semArquivo.length > 0) {
    problemas.push({ codigo: 'MIGRATIONS_SEM_ARQUIVO', mensagem: `o banco registra migration(s) que este código não tem: ${m.semArquivo.join(', ')} (banco à frente do código)` });
  }
  if (m.controleExiste && !m.ordemConfere) {
    problemas.push({ codigo: 'ORDEM_DIVERGENTE', mensagem: 'a ordem das migrations registradas (run_on, id) não corresponde à ordem dos arquivos' });
  }
  for (const s of observado.sentinelasAusentes) {
    const objeto = s.coluna ? `${s.tabela}.${s.coluna}` : `tabela ${s.tabela}`;
    problemas.push({ codigo: 'ESTRUTURA_INCOMPATIVEL', mensagem: `${objeto} ausente (criada pela migration ${s.migration})` });
  }
  if (!observado.integridade.integro) {
    const r = observado.integridade.relatorio;
    const itens = [...(r.alteradas || []).map((x) => `alterada ${x.nome}`), ...(r.renomeadas || []).map((x) => `renomeada ${x.de}`), ...(r.ausentes || []).map((x) => `ausente ${x.nome}`), ...(r.novas || []).map((x) => `nova ${x.nome}`)];
    problemas.push({ codigo: 'MANIFESTO_DIVERGENTE', mensagem: `arquivos de migration divergem do manifesto checksums.json: ${itens.join('; ')}` });
  }

  const resumo = `banco=${observado.banco} papel=${observado.papel} porta=${observado.porta} | ${m.aplicadas.length} migrations aplicadas, última ${m.ultima || '—'}, pendentes ${m.pendentes.length} | sentinelas ausentes ${observado.sentinelasAusentes.length} | manifesto ${observado.integridade.integro ? 'íntegro' : 'divergente'}`;
  return { aprovado: problemas.length === 0, problemas, resumo };
}

function arquivosDe(diretorio) {
  return listarMigrations(diretorio).map((migration) => migration.nome.replace(/\.sql$/, ''));
}

function integridadeDe(diretorio) {
  const migrations = listarMigrations(diretorio);
  const manifesto = lerManifesto(path.join(diretorio, MANIFESTO));
  const relatorio = compararComManifesto(migrations, manifesto);
  return { integro: !temDivergencia(relatorio), relatorio };
}

/**
 * Coleta somente leitura. `client` já conectado; `inspecionar` é o
 * inspecionarMigrations de scripts/migrate.js (abre a própria conexão, só
 * SELECT). Tudo o que esta função emite no `client` fica entre BEGIN READ
 * ONLY e ROLLBACK, inclusive em erro.
 */
async function coletar({ client, inspecionar, arquivos, sentinelas = SENTINELAS, integridade, schema = SCHEMA_PADRAO, diretorio = DIRETORIO_PADRAO }) {
  const listaArquivos = arquivos || arquivosDe(diretorio);
  const inspecao = await inspecionar({ schema, diretorio });
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const identidade = (await client.query(
      'SELECT current_database() AS banco, current_user AS papel, pg_get_userbyid(d.datdba) AS dono, inet_server_port() AS porta FROM pg_database d WHERE d.datname = current_database()',
    )).rows[0];
    let porRunOn = [];
    if (inspecao.controleExiste) {
      porRunOn = (await client.query(`SELECT name FROM "${schema}"."pgmigrations" ORDER BY run_on, id`)).rows.map((r) => r.name);
    }
    const sentinelasAusentes = [];
    for (const s of sentinelas) {
      const existe = s.coluna === null
        ? (await client.query('SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [schema, s.tabela])).rows.length > 0
        : (await client.query('SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, s.tabela, s.coluna])).rows.length > 0;
      if (!existe) sentinelasAusentes.push(s);
    }
    const ordemConfere = porRunOn.every((nome, i) => nome === listaArquivos[i]);
    return {
      banco: identidade.banco,
      papel: identidade.papel,
      dono: identidade.dono,
      porta: Number(identidade.porta),
      migrations: { controleExiste: inspecao.controleExiste, aplicadas: inspecao.aplicadas, pendentes: inspecao.pendentes, semArquivo: inspecao.semArquivo, ordemConfere, ultima: porRunOn.length > 0 ? porRunOn[porRunOn.length - 1] : null },
      integridade: (integridade || integridadeDe)(diretorio),
      sentinelasAusentes,
    };
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* conexão já perdida: nada a desfazer, nada foi escrito */ }
  }
}

function criarClientePadrao(env) {
  const { Client } = require('pg');
  return new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 5432,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
}

/** Execução completa (CLI). Devolve o código de saída; nunca lança. */
async function executar({ env = process.env, saida = console, criarCliente = criarClientePadrao, coletar: coletarInjetado, inspecionar, diretorio = DIRETORIO_PADRAO } = {}) {
  // Sem lista de bancos permitidos não há o que conferir: reprova antes de criar
  // o cliente, portanto sem nenhuma conexão com o banco.
  if (bancosPermitidos(env).length === 0) {
    saida.error('[guarda] GUARDA REPROVADA — o backend NÃO foi iniciado:');
    saida.error(`[guarda]   - ${PROBLEMA_LISTA_NAO_CONFIGURADA.codigo}: ${PROBLEMA_LISTA_NAO_CONFIGURADA.mensagem}`);
    return SAIDAS.REPROVADA;
  }
  // A pasta de migrations passa pelo mesmo pré-voo de nomenclatura do runner e
  // do verificador de checksums; um arquivo fora do padrão (por exemplo uma
  // cópia com sufixo " 2") reprova antes de qualquer conexão.
  try {
    listarMigrations(diretorio);
  } catch (erro) {
    saida.error('[guarda] GUARDA REPROVADA — o backend NÃO foi iniciado:');
    saida.error(`[guarda]   - MIGRATIONS_DIRETORIO_INVALIDO: ${erro.message} — remova ou mova o arquivo fora do padrão antes de iniciar`);
    return SAIDAS.REPROVADA;
  }
  const client = criarCliente(env);
  try {
    await client.connect();
    const observado = coletarInjetado
      ? await coletarInjetado({ client, env })
      : await coletar({ client, inspecionar: inspecionar || require('../../scripts/migrate').inspecionarMigrations, diretorio });
    const resultado = avaliar({ env, observado });
    saida.log(`[guarda] ${resultado.resumo}`);
    if (resultado.aprovado) {
      saida.log('[guarda] GUARDA APROVADA: banco e estrutura compatíveis com o código');
      return SAIDAS.OK;
    }
    saida.error('[guarda] GUARDA REPROVADA — o backend NÃO foi iniciado:');
    for (const p of resultado.problemas) saida.error(`[guarda]   - ${p.codigo}: ${p.mensagem}`);
    return SAIDAS.REPROVADA;
  } catch (erro) {
    // Só código e mensagem do driver: nunca a configuração de conexão.
    saida.error(`[guarda] erro ao verificar o banco (${erro.code || erro.name}): ${erro.message} — o backend NÃO foi iniciado`);
    return SAIDAS.ERRO;
  } finally {
    try { await client.end(); } catch { /* já encerrada */ }
  }
}

module.exports = { VARIAVEL_BANCOS_PERMITIDOS, SENTINELAS, SAIDAS, bancosPermitidos, avaliar, coletar, executar };
