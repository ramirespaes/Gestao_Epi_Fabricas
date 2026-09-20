'use strict';

const path = require('node:path');

const {
  listarMigrations,
  lerManifesto,
  compararComManifesto,
  temDivergencia,
} = require('../src/db/checksums');
const { aplicarMigrations, inspecionarMigrations, identificadorDe } = require('./migrate');

/**
 * Comandos operacionais de migration: status, aplicar e baseline.
 *
 * Integração apenas. Quem aplica e registra é o node-pg-migrate, por meio de
 * scripts/migrate.js. Quem valida a integridade dos arquivos é
 * src/db/checksums.js. Aqui só ficam a ordem das checagens, as guardas e os
 * códigos de saída.
 *
 * As credenciais vêm do ambiente, carregado pelos scripts npm com
 * dotenv/config. Nenhuma senha é passada por argumento, entra em URL ou é
 * impressa.
 *
 * O baseline registra migrations sem executar o SQL delas, então tem guardas
 * próprias: exige confirmação explícita, recusa schema vazio e recusa schema
 * que já tenha histórico registrado. Ter tabelas não autoriza nada sozinho.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  DIVERGENCIA: 2,
  ESTRUTURA_SEM_CONTROLE: 3,
  BASELINE_NAO_CONFIRMADO: 4,
  BASELINE_INDEVIDO: 5,
});

const MODOS = ['status', 'aplicar', 'baseline'];
const CONFIRMACAO = '--confirmo-baseline';
const DIRETORIO_PADRAO = path.join(__dirname, '..', 'migrations');
const SCHEMA_PADRAO = 'public';
const MANIFESTO = 'checksums.json';

/** Compara os arquivos do diretório com o manifesto que vive ao lado deles. */
function verificarIntegridade(diretorio) {
  const migrations = listarMigrations(diretorio);
  const manifesto = lerManifesto(path.join(diretorio, MANIFESTO));
  const relatorio = compararComManifesto(migrations, manifesto);
  return { relatorio, integro: !temDivergencia(relatorio) };
}

function relatarIntegridade(relatorio) {
  for (const item of relatorio.alteradas) {
    console.error(`  ALTERADA: ${item.nome}`);
  }
  for (const item of relatorio.renomeadas) {
    console.error(`  RENOMEADA: ${item.de} para ${item.para}`);
  }
  for (const item of relatorio.ausentes) {
    console.error(`  AUSENTE: ${item.nome}`);
  }
  for (const item of relatorio.novas) {
    console.error(`  NOVA, fora do manifesto: ${item.nome}`);
  }
}

function relatarEstado(estado) {
  console.log(`  tabela de controle: ${estado.controleExiste ? 'presente' : 'ausente'}`);
  console.log(`  schema com objetos: ${estado.schemaTemObjetos ? 'sim' : 'não'}`);
  console.log(`  aplicadas: ${estado.aplicadas.length}`);
  for (const nome of estado.aplicadas) console.log(`    ${nome}`);
  console.log(`  pendentes: ${estado.pendentes.length}`);
  for (const nome of estado.pendentes) console.log(`    ${nome}`);
  if (estado.semArquivo.length > 0) {
    console.error(`  registradas sem arquivo: ${estado.semArquivo.length}`);
    for (const nome of estado.semArquivo) console.error(`    ${nome}`);
  }
}

async function comandoStatus({ schema, diretorio }) {
  const { relatorio, integro } = verificarIntegridade(diretorio);
  const estado = await inspecionarMigrations({ schema, diretorio });

  console.log(`Schema ${schema}`);
  relatarEstado(estado);
  if (!integro) relatarIntegridade(relatorio);

  const limpo = integro && estado.pendentes.length === 0 && estado.semArquivo.length === 0;
  if (!limpo && !estado.controleExiste && estado.schemaTemObjetos) {
    console.error('  estrutura presente sem tabela de controle: use o baseline autorizado');
  }

  return { saida: limpo ? SAIDAS.OK : SAIDAS.DIVERGENCIA, relatorio: estado, integridade: relatorio };
}

async function comandoAplicar({ schema, diretorio }) {
  const { relatorio, integro } = verificarIntegridade(diretorio);
  if (!integro) {
    console.error('Integridade das migrations comprometida. Nada foi aplicado.');
    relatarIntegridade(relatorio);
    return { saida: SAIDAS.DIVERGENCIA, aplicadas: [] };
  }

  const estado = await inspecionarMigrations({ schema, diretorio });
  if (!estado.controleExiste && estado.schemaTemObjetos) {
    console.error(`Schema ${schema} já tem estrutura e não tem tabela de controle.`);
    console.error('Aplicar agora tentaria recriar objetos existentes. Use o baseline autorizado.');
    return { saida: SAIDAS.ESTRUTURA_SEM_CONTROLE, aplicadas: [] };
  }

  const resultado = await aplicarMigrations({ schema, diretorio, baseline: false });
  const aplicadas = resultado.map((migration) => migration.name);
  console.log(`Aplicadas: ${aplicadas.length}`);
  for (const nome of aplicadas) console.log(`  ${nome}`);

  return { saida: SAIDAS.OK, aplicadas };
}

async function comandoBaseline({ schema, diretorio, confirmado }) {
  if (!confirmado) {
    console.error('O baseline registra migrations sem executar o SQL delas.');
    console.error(`Nada foi feito. Para confirmar, repita o comando com ${CONFIRMACAO}.`);
    return { saida: SAIDAS.BASELINE_NAO_CONFIRMADO, registradas: [] };
  }

  const { relatorio, integro } = verificarIntegridade(diretorio);
  if (!integro) {
    console.error('Integridade das migrations comprometida. Nada foi registrado.');
    relatarIntegridade(relatorio);
    return { saida: SAIDAS.DIVERGENCIA, registradas: [] };
  }

  const estado = await inspecionarMigrations({ schema, diretorio });
  if (estado.aplicadas.length > 0 || estado.semArquivo.length > 0) {
    console.error(`Schema ${schema} já tem histórico registrado. O baseline não se aplica.`);
    return { saida: SAIDAS.BASELINE_INDEVIDO, registradas: [] };
  }
  if (!estado.schemaTemObjetos) {
    console.error(`Schema ${schema} está vazio. Não há estrutura anterior a reconhecer.`);
    console.error('Use a aplicação normal, que executa o SQL das migrations.');
    return { saida: SAIDAS.BASELINE_INDEVIDO, registradas: [] };
  }

  console.log(`Registrando sem executar, no schema ${schema}:`);
  for (const nome of estado.pendentes) console.log(`  ${nome}`);

  const resultado = await aplicarMigrations({ schema, diretorio, baseline: true });
  const registradas = resultado.map((migration) => migration.name);

  return { saida: SAIDAS.OK, registradas };
}

/**
 * @param {object} opcoes
 * @param {'status'|'aplicar'|'baseline'} opcoes.modo
 * @param {string} opcoes.schema
 * @param {string} opcoes.diretorio
 * @param {boolean} [opcoes.confirmado] exigido apenas pelo baseline
 */
async function executarComando({ modo, schema, diretorio, confirmado = false }) {
  if (!MODOS.includes(modo)) {
    throw new TypeError(`modo inválido: use ${MODOS.join(', ')}`);
  }
  if (typeof confirmado !== 'boolean') {
    throw new TypeError('confirmado deve ser booleano');
  }

  if (modo === 'status') return comandoStatus({ schema, diretorio });
  if (modo === 'aplicar') return comandoAplicar({ schema, diretorio });
  return comandoBaseline({ schema, diretorio, confirmado });
}

async function principal() {
  const [modo] = process.argv.slice(2);
  const confirmado = process.argv.includes(CONFIRMACAO);

  const { saida } = await executarComando({
    modo,
    schema: SCHEMA_PADRAO,
    diretorio: DIRETORIO_PADRAO,
    confirmado,
  });
  return saida;
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${erro.message}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { executarComando, SAIDAS, identificadorDe };
