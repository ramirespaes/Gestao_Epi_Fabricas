'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Integridade das migrations históricas.
 *
 * O node-pg-migrate identifica uma migration apenas pelo nome do arquivo e não
 * guarda checksum, então alterar o conteúdo de uma migration já aplicada passa
 * despercebido e renomear o arquivo a faz parecer nova. Este módulo cobre essa
 * lacuna comparando o SHA-256 dos bytes de cada arquivo com um manifesto
 * versionado, e é puro: lê arquivos, não toca no banco e não aplica nada.
 *
 * A atualização automática do manifesto aceita apenas migration nova. Alteração,
 * remoção e renomeação de migration histórica são recusadas de propósito: o
 * manifesto nunca deve ser regravado só para a verificação voltar a passar.
 * Correção de estrutura já aplicada se faz com migration nova.
 *
 * A convenção de nome é NNN_descricao.sql com exatamente três dígitos, e o
 * prefixo é único. A regra vale igualmente para os arquivos do diretório e
 * para as chaves do manifesto, e vive em um único lugar.
 *
 * O digest é dos bytes crus, sem normalização de conteúdo. O .gitattributes da
 * raiz fixa os arquivos .sql em LF para que esses bytes não mudem por
 * conversão automática de fim de linha em outra plataforma.
 */

const ALGORITMO = 'sha256';
const FORMATO_NOME = /^([0-9]{3})_[a-z0-9_]+\.sql$/;
const FORMATO_CHECKSUM = /^[0-9a-f]{64}$/;
const EXTENSAO = '.sql';

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);

const ordenarPorNome = (migrations) =>
  Object.fromEntries(Object.entries(migrations).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Regra única de nomenclatura, usada tanto na leitura do diretório quanto na
 * leitura do manifesto. Valida o padrão NNN_descricao.sql com exatamente três
 * dígitos e garante que nenhum prefixo se repita. A origem entra na mensagem
 * para que o erro diga onde o problema está.
 */
function validarNomes(nomes, origem) {
  const porVersao = new Map();
  const validados = [];

  for (const nome of nomes) {
    const encontrado = FORMATO_NOME.exec(nome);
    if (encontrado === null) {
      throw new Error(`${origem}: nome fora do padrão NNN_descricao.sql, com três dígitos: ${nome}`);
    }
    const versao = encontrado[1];
    if (porVersao.has(versao)) {
      throw new Error(`${origem}: prefixo duplicado ${versao} em ${porVersao.get(versao)} e ${nome}`);
    }
    porVersao.set(versao, nome);
    validados.push({ nome, versao });
  }

  return validados;
}

/** SHA-256 hexadecimal dos bytes recebidos. */
function calcularChecksum(conteudo) {
  return crypto.createHash(ALGORITMO).update(conteudo).digest('hex');
}

/**
 * Lê o diretório de migrations e devolve nome, versão e checksum de cada
 * arquivo .sql, em ordem numérica de prefixo. Arquivos de outras extensões,
 * como o próprio manifesto, são ignorados.
 */
function listarMigrations(diretorio) {
  const nomes = fs.readdirSync(diretorio).filter((nome) => nome.endsWith(EXTENSAO)).sort();

  return validarNomes(nomes, `diretório ${diretorio}`)
    .map(({ nome, versao }) => ({
      nome,
      versao,
      checksum: calcularChecksum(fs.readFileSync(path.join(diretorio, nome))),
    }))
    .sort((a, b) => Number(a.versao) - Number(b.versao));
}

/** Lê e valida o manifesto. Falha com mensagem explícita em qualquer desvio. */
function lerManifesto(caminho) {
  let bruto;
  try {
    bruto = fs.readFileSync(caminho, 'utf8');
  } catch {
    throw new Error(`manifesto não encontrado: ${caminho}`);
  }

  let conteudo;
  try {
    conteudo = JSON.parse(bruto);
  } catch {
    throw new Error(`manifesto não é JSON válido: ${caminho}`);
  }

  if (!ehObjeto(conteudo)) {
    throw new Error(`manifesto deve ser um objeto: ${caminho}`);
  }
  if (conteudo.algoritmo !== ALGORITMO) {
    throw new Error(`manifesto deve declarar algoritmo "${ALGORITMO}": ${caminho}`);
  }
  if (!ehObjeto(conteudo.migrations)) {
    throw new Error(`manifesto deve conter o objeto migrations: ${caminho}`);
  }
  for (const [nome, checksum] of Object.entries(conteudo.migrations)) {
    if (typeof checksum !== 'string' || !FORMATO_CHECKSUM.test(checksum)) {
      throw new Error(`checksum inválido no manifesto para ${nome}`);
    }
  }
  // Depois dos checksums, para que um digest malformado seja reportado como
  // tal mesmo quando a chave também estiver fora da convenção.
  validarNomes(Object.keys(conteudo.migrations), `manifesto ${caminho}`);

  return { algoritmo: conteudo.algoritmo, migrations: { ...conteudo.migrations } };
}

/**
 * Classifica cada arquivo em ok, alterada, ausente, nova ou renomeada. Uma
 * ausência somada a uma nova com o mesmo checksum vira uma renomeação, que é
 * mais informativa do que duas divergências soltas.
 */
function compararComManifesto(migrations, manifesto) {
  const registrados = new Map(Object.entries(manifesto.migrations));
  const presentes = new Set(migrations.map((migration) => migration.nome));

  const ok = [];
  const alteradas = [];
  const ausentes = [];
  const novas = [];

  for (const { nome, checksum } of migrations) {
    if (!registrados.has(nome)) {
      novas.push({ nome, checksumAtual: checksum });
    } else if (registrados.get(nome) === checksum) {
      ok.push(nome);
    } else {
      alteradas.push({ nome, checksumRegistrado: registrados.get(nome), checksumAtual: checksum });
    }
  }

  for (const [nome, checksum] of registrados) {
    if (!presentes.has(nome)) {
      ausentes.push({ nome, checksumRegistrado: checksum });
    }
  }

  const renomeadas = [];
  for (const ausente of [...ausentes]) {
    const par = novas.find((nova) => nova.checksumAtual === ausente.checksumRegistrado);
    if (par === undefined) {
      continue;
    }
    renomeadas.push({ de: ausente.nome, para: par.nome, checksum: par.checksumAtual });
    ausentes.splice(ausentes.indexOf(ausente), 1);
    novas.splice(novas.indexOf(par), 1);
  }

  return { ok, alteradas, ausentes, novas, renomeadas };
}

const temDivergencia = (relatorio) =>
  relatorio.alteradas.length > 0
  || relatorio.ausentes.length > 0
  || relatorio.novas.length > 0
  || relatorio.renomeadas.length > 0;

/**
 * Devolve um manifesto novo com as migrations novas acrescentadas. Recusa
 * qualquer mexida em migration histórica. Não muta o manifesto recebido.
 */
function atualizarManifesto(manifesto, relatorio) {
  if (relatorio.alteradas.length > 0) {
    const nomes = relatorio.alteradas.map((item) => item.nome).join(', ');
    throw new Error(`migration histórica alterada: ${nomes}. Corrija com uma migration nova.`);
  }
  if (relatorio.renomeadas.length > 0) {
    const pares = relatorio.renomeadas.map((item) => `${item.de} para ${item.para}`).join(', ');
    throw new Error(`migration histórica renomeada: ${pares}. Restaure o nome original.`);
  }
  if (relatorio.ausentes.length > 0) {
    const nomes = relatorio.ausentes.map((item) => item.nome).join(', ');
    throw new Error(`migration histórica ausente: ${nomes}. Restaure o arquivo.`);
  }

  const migrations = { ...manifesto.migrations };
  for (const nova of relatorio.novas) {
    migrations[nova.nome] = nova.checksumAtual;
  }

  return { algoritmo: ALGORITMO, migrations: ordenarPorNome(migrations) };
}

module.exports = {
  ALGORITMO,
  calcularChecksum,
  listarMigrations,
  lerManifesto,
  compararComManifesto,
  temDivergencia,
  atualizarManifesto,
};
