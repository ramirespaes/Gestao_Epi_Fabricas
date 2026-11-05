'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verificarAmbiente } = require('../src/services/backup-ambiente-verificacao.service');
const janela = require('../src/utils/janela-escrita-imagens');

/**
 * Executor operacional do backup (D-ORF-6). NESTA VERSÃO EXISTE UM ÚNICO MODO, `--verificar`, SOMENTE LEITURA:
 *
 *   node scripts/backup-operar.js --verificar [--json]
 *
 * Diagnostica, item a item, o ambiente do backup (diretórios, permissões, dispositivo, trava de janela I5, binários e arquivo de senha do
 * PostgreSQL, limites e espaço) e REPORTA, sem simular, as pendências de chaves, destinos duráveis, custódia e retenção. Não cria janela,
 * arquivo, conexão nem processo; não executa os binários do PostgreSQL; não grava nada. Os modos de ensaio e operacional NÃO existem: qualquer
 * outro argumento é recusado (exit 2).
 *
 * AMBIENTE: só `process.env`. Este script NÃO carrega o `.env` da API (não usa dotenv): quem o executa fornece apenas as variáveis do executor,
 * por exemplo `node --env-file=/caminho/executor-backup.env scripts/backup-operar.js --verificar` ou pelo `EnvironmentFile` de uma unidade.
 * Variáveis lidas: IMAGENS_ARMAZENAMENTO_DIRETORIO, FISCALIZACAO_ARMAZENAMENTO_DIRETORIO, IMAGENS_JANELA_ESCRITA_ARQUIVO, BACKUP_RAIZ,
 * BACKUP_PG_BINARIOS (padrão /usr/lib/postgresql/16/bin), BACKUP_PG_HOST, BACKUP_PG_PORTA, BACKUP_PG_USUARIO, BACKUP_PG_BANCO, PGPASSFILE,
 * BACKUP_LIMITE_DUMP_BYTES, BACKUP_LIMITE_TOTAL_BYTES, BACKUP_LIMITE_LIVRE_BYTES. Valores de variáveis nunca são impressos.
 *
 * Códigos de saída: 0 = sem falhas e sem pendências de infraestrutura (NÃO é prontidão operacional: a saída diz `prontidaoOperacional: false` e
 * lista as pendências operacionais); 1 = falha em algum item, ou erro de execução; 2 = argumentos inválidos; 3 = há pendência de infraestrutura.
 */

const SAIDAS = Object.freeze({ OK: 0, FALHA: 1, ARGUMENTOS: 2, INFRA_PENDENTE: 3 });
const USO = 'Uso: node scripts/backup-operar.js --verificar [--json]\n'
  + '  --verificar   diagnostica o ambiente do backup, somente leitura (único modo desta versão)\n'
  + '  --json        imprime um único documento JSON em vez do texto\n'
  + 'Os modos de ensaio e operacional não existem nesta versão.\n';

/** Puro, sem I/O; o erro nunca ecoa o argumento recebido. */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  let verificar = false;
  let json = false;
  for (const argumento of argumentos) {
    if (argumento === '--verificar') {
      if (verificar) return { ok: false, erro: '--verificar informado mais de uma vez' };
      verificar = true;
    } else if (argumento === '--json') {
      if (json) return { ok: false, erro: '--json informado mais de uma vez' };
      json = true;
    } else {
      return { ok: false, erro: 'argumento desconhecido (nesta versão só existe --verificar [--json])' };
    }
  }
  if (!verificar) return { ok: false, erro: 'informe --verificar (único modo desta versão)' };
  return { ok: true, json };
}

function codigoDeSaida(relatorio) {
  if (relatorio.veredito === 'FALHA') return SAIDAS.FALHA;
  if (relatorio.veredito === 'INFRA_PENDENTE') return SAIDAS.INFRA_PENDENTE;
  return SAIDAS.OK;
}

const limpar = (texto) => String(texto).replace(/[^\x20-\x7E]/g, '?');
const formatarDetalhe = (detalhe) => (detalhe === undefined ? '' : ` ${Object.entries(detalhe).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).map(limpar).join(' ')}`);

function formatarTexto(relatorio) {
  const linhas = ['backup-operar --verificar (somente leitura)'];
  for (const i of relatorio.itens) linhas.push(`[${i.estado.padEnd(8)}] ${i.id.padEnd(30)} ${i.codigo}${formatarDetalhe(i.detalhe)}`);
  linhas.push(`RESUMO infraestrutura: ok=${relatorio.infraestrutura.ok} pendente=${relatorio.infraestrutura.pendente} falha=${relatorio.infraestrutura.falha} | operacional pendente=${relatorio.operacional.pendente}`);
  linhas.push(`VEREDITO: ${relatorio.veredito}`);
  for (const o of relatorio.observacoes) linhas.push(`NOTA: ${o}`);
  linhas.push('PRONTIDAO_OPERACIONAL=NAO');
  return `${linhas.join('\n')}\n`;
}

/** Injetável para teste. Devolve o código de saída; escreve só no que receber em `escrever`/`erro`. */
async function executarComando({ argv, ambiente, raizDoCodigo, escrever, erro, portas }) {
  const interpretado = interpretarArgumentos(argv);
  if (!interpretado.ok) {
    erro(`${interpretado.erro}\n${USO}`);
    return SAIDAS.ARGUMENTOS;
  }
  try {
    const relatorio = await verificarAmbiente({
      ambiente,
      raizDoCodigo,
      ...(portas === undefined ? {} : { portas }),
      janela: { lerArquivo: janela.lerArquivoDaJanela, validar: janela.validarArquivoDaJanela, ler: janela.lerJanela },
    });
    escrever(interpretado.json ? `${JSON.stringify(relatorio, null, 2)}\n` : formatarTexto(relatorio));
    return codigoDeSaida(relatorio);
  } catch {
    erro('ERRO_INESPERADO: o diagnóstico não pôde ser concluído\n');
    return SAIDAS.FALHA;
  }
}

if (require.main === module) {
  executarComando({
    argv: process.argv.slice(2),
    ambiente: process.env,
    raizDoCodigo: fs.realpathSync(path.resolve(__dirname, '..')),
    escrever: (texto) => process.stdout.write(texto),
    erro: (texto) => process.stderr.write(texto),
  }).then((saida) => { process.exitCode = saida; });
}

module.exports = { interpretarArgumentos, executarComando, formatarTexto, codigoDeSaida, SAIDAS, USO };
