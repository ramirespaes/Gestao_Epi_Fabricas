'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ALGORITMO,
  listarMigrations,
  lerManifesto,
  compararComManifesto,
  temDivergencia,
  atualizarManifesto,
} = require('../src/db/checksums');

/**
 * Verifica a integridade das migrations históricas contra o manifesto.
 *
 * Ferramenta operacional: toda a lógica vive em src/db/checksums.js. Aqui só
 * há leitura de argumentos, escrita do manifesto e código de saída. Não toca
 * no banco e não aplica migration alguma.
 *
 * Uso:
 *   node scripts/verificar-checksums.js              verifica
 *   node scripts/verificar-checksums.js --atualizar  registra migrations novas
 *
 * Códigos de saída: 0 íntegro, 1 erro, 2 divergência.
 */

const DIRETORIO = path.join(__dirname, '..', 'migrations');
const CAMINHO_MANIFESTO = path.join(DIRETORIO, 'checksums.json');

const SAIDA_OK = 0;
const SAIDA_ERRO = 1;
const SAIDA_DIVERGENCIA = 2;

const manifestoVazio = () => ({ algoritmo: ALGORITMO, migrations: {} });

function relatar(relatorio) {
  console.log(`  íntegras: ${relatorio.ok.length}`);
  for (const item of relatorio.alteradas) {
    console.error(`  ALTERADA: ${item.nome}`);
    console.error(`    registrado: ${item.checksumRegistrado}`);
    console.error(`    atual:      ${item.checksumAtual}`);
  }
  for (const item of relatorio.renomeadas) {
    console.error(`  RENOMEADA: ${item.de} para ${item.para}`);
  }
  for (const item of relatorio.ausentes) {
    console.error(`  AUSENTE: ${item.nome}`);
  }
  for (const item of relatorio.novas) {
    console.error(`  NOVA, ainda não registrada: ${item.nome}`);
  }
}

function main() {
  const atualizar = process.argv.includes('--atualizar');
  const migrations = listarMigrations(DIRETORIO);

  const existe = fs.existsSync(CAMINHO_MANIFESTO);
  if (!existe && !atualizar) {
    throw new Error(`manifesto não encontrado: ${CAMINHO_MANIFESTO}. Gere com --atualizar.`);
  }
  const manifesto = existe ? lerManifesto(CAMINHO_MANIFESTO) : manifestoVazio();

  const relatorio = compararComManifesto(migrations, manifesto);
  console.log(`Migrations em ${DIRETORIO}: ${migrations.length}`);
  relatar(relatorio);

  if (!temDivergencia(relatorio)) {
    console.log('Manifesto íntegro.');
    return SAIDA_OK;
  }

  if (!atualizar) {
    console.error('Divergência encontrada. Use --atualizar apenas para registrar migrations novas.');
    return SAIDA_DIVERGENCIA;
  }

  const atualizado = atualizarManifesto(manifesto, relatorio);
  fs.writeFileSync(CAMINHO_MANIFESTO, `${JSON.stringify(atualizado, null, 2)}\n`);
  console.log(`Manifesto atualizado com ${relatorio.novas.length} migration(s) nova(s).`);
  return SAIDA_OK;
}

try {
  process.exitCode = main();
} catch (erro) {
  console.error(`Falha: ${erro.message}`);
  process.exitCode = SAIDA_ERRO;
}
