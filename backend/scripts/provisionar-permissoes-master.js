'use strict';

const provisionamento = require('../src/services/provisionamento-permissoes.service');
const { ESCOPO_PROVISIONAMENTO_MASTER } = require('../src/rbac/recursos');

/**
 * Script administrativo: provisiona as permissões de perfil do MASTER de
 * UMA empresa, no escopo do Bloco 9 (src/rbac/recursos.js). Bloco 9,
 * Etapa B — correção pós-diagnóstico de 23/09/2026.
 *
 *   node --require dotenv/config scripts/provisionar-permissoes-master.js --empresa <id> [--ator <usuarioId>] [--dry-run | --executar]
 *   npm run db:provisionar:master -- --empresa <id> --dry-run
 *
 * Mesma família de scripts/migrate-cli.js: Node autônomo, versionado,
 * executado deliberadamente por um operador, credenciais só pelo ambiente
 * (dotenv/config no script npm), nada de senha em argumento, URL ou saída.
 *
 * SEGURO POR PADRÃO: sem `--executar`, o script só PLANEJA (dry-run) —
 * imprime, por recurso e ação, se a permissão está AUSENTE, ADEQUADA,
 * INSUFICIENTE ou NAO_CATALOGADA, e não escreve nada. `--dry-run` é aceito
 * explicitamente e significa o mesmo que omitir `--executar`. Os dois
 * juntos são erro de argumentos. `--empresa` é obrigatório: nunca há
 * "todas as empresas".
 *
 * O que a execução real faz e não faz está documentado no serviço
 * (provisionamento-permissoes.service.js): insere só o AUSENTE, nunca
 * sobrescreve, audita uma vez por execução com escrita, respeita o RBAC.
 *
 * Códigos de saída: OK=0, ERRO=1, ARGUMENTOS=2, EMPRESA=3 (inexistente,
 * inativa ou ator inválido), ATENCAO=4 (execução concluída, mas existem
 * linhas INSUFICIENTES ou ações NAO_CATALOGADAS que exigem decisão humana).
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  EMPRESA: 3,
  ATENCAO: 4,
});

const INTEIRO_POSITIVO = /^[1-9][0-9]{0,9}$/;

/**
 * Interpreta argv (já sem `node` e o caminho do script). Puro, sem I/O.
 * @returns {{ok: true, empresaId: number, atorId: number|null, executar: boolean}|{ok: false, erro: string}}
 */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) {
    throw new TypeError('argumentos deve ser uma lista');
  }
  let empresaId = null;
  let atorId = null;
  let executar = false;
  let dryRun = false;

  for (let i = 0; i < argumentos.length; i += 1) {
    const arg = argumentos[i];
    if (arg === '--empresa' || arg === '--ator') {
      const valor = argumentos[i + 1];
      if (typeof valor !== 'string' || !INTEIRO_POSITIVO.test(valor)) {
        return { ok: false, erro: `${arg} exige um inteiro positivo` };
      }
      if (arg === '--empresa') {
        if (empresaId !== null) return { ok: false, erro: '--empresa informado mais de uma vez' };
        empresaId = Number(valor);
      } else {
        if (atorId !== null) return { ok: false, erro: '--ator informado mais de uma vez' };
        atorId = Number(valor);
      }
      i += 1;
    } else if (arg === '--executar') {
      executar = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      return { ok: false, erro: `argumento desconhecido: ${arg}` };
    }
  }

  if (empresaId === null) {
    return { ok: false, erro: '--empresa <id> é obrigatório' };
  }
  if (executar && dryRun) {
    return { ok: false, erro: '--dry-run e --executar são mutuamente exclusivos' };
  }
  return { ok: true, empresaId, atorId, executar };
}

function uso() {
  return [
    'Uso: node --require dotenv/config scripts/provisionar-permissoes-master.js --empresa <id> [--ator <usuarioId>] [--dry-run | --executar]',
    '  --empresa   id da empresa (obrigatório; nunca "todas")',
    '  --ator      id do usuário da empresa registrado como autor na auditoria (opcional)',
    '  --dry-run   só planeja e relata; padrão quando --executar está ausente',
    '  --executar  insere as permissões AUSENTES do escopo; nunca altera linhas existentes',
  ].join('\n');
}

/** Linhas de relatório do plano — só identificadores e situações, nada sensível. */
function formatarPlano(plano) {
  const linhas = [];
  linhas.push(`Empresa ${plano.empresa.id} — ${plano.empresa.nome} (${plano.empresa.ativo ? 'ativa' : 'inativa'}), perfil ${plano.perfil}`);
  linhas.push('Recursos:');
  for (const r of plano.recursos) {
    const detalhe = r.situacao === provisionamento.SITUACAO.INSUFICIENTE ? ` — faltam: ${r.faltantes.join(', ')}` : '';
    linhas.push(`  ${r.situacao.padEnd(14)} ${r.recurso} [${r.operacoes.join(', ')}]${detalhe}`);
  }
  linhas.push('Ações:');
  for (const a of plano.acoes) {
    const detalhe = a.situacao === provisionamento.SITUACAO.NAO_CATALOGADA ? ` — catálogo: ${a.catalogo}` : '';
    linhas.push(`  ${a.situacao.padEnd(14)} ${a.acaoCodigo}${detalhe}`);
  }
  return linhas;
}

/**
 * Executa o comando com um pool já configurado. Devolve o código de saída
 * e o resultado, sem encerrar o pool (responsabilidade de quem chama).
 *
 * @param {{empresaId: number, atorId: number|null, executar: boolean}} opcoes
 * @param {{pool: import('pg').Pool, saida?: {log: Function, error: Function}}} dependencias
 */
async function executarComando({ empresaId, atorId, executar }, { pool, saida = console }) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('empresaId inválido');
  if (atorId !== null && (!Number.isInteger(atorId) || atorId <= 0)) throw new TypeError('atorId inválido');
  if (typeof executar !== 'boolean') throw new TypeError('executar deve ser booleano');

  const { rows } = await pool.query('SELECT current_database() AS banco, inet_server_addr()::text AS servidor, inet_server_port() AS porta');
  saida.log(`Banco: ${rows[0].banco} em ${rows[0].servidor ?? '(socket local)'}:${rows[0].porta}`);
  saida.log(`Modo: ${executar ? 'EXECUTAR (insere só o que está AUSENTE)' : 'DRY-RUN (nada é gravado)'}`);
  saida.log(`Escopo: ${ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => r.recurso).join(', ')} | ações: ${ESCOPO_PROVISIONAMENTO_MASTER.acoes.join(', ')}`);

  let resultado;
  try {
    resultado = await provisionamento.provisionar(pool, { empresaId, atorId, dryRun: !executar });
  } catch (erro) {
    if (erro instanceof provisionamento.ErroProvisionamento) {
      saida.error(`Recusado: ${erro.message} (${erro.codigo})`);
      return { saida: SAIDAS.EMPRESA, resultado: null };
    }
    throw erro;
  }

  for (const linha of formatarPlano(resultado.plano)) saida.log(linha);
  // `resultado.plano` já é o plano FINAL (ver provisionamento-permissoes.
  // service.js): num --executar que insere com sucesso, o item deixa de
  // contar como "ausente" e passa a contar como "inseridas" — os totais
  // abaixo refletem sempre o estado que cada palavra declara, nunca o
  // planejamento anterior à escrita.
  const totais = provisionamento.resumir(resultado.plano);
  saida.log(`Totais: ausentes=${totais.AUSENTE} inseridas=${totais.INSERIDA} adequadas=${totais.ADEQUADA} insuficientes=${totais.INSUFICIENTE} naoCatalogadas=${totais.NAO_CATALOGADA}`);

  if (executar) {
    saida.log(`Inseridos: recursos=[${resultado.inseridos.recursos.join(', ')}] acoes=[${resultado.inseridos.acoes.join(', ')}]`);
    saida.log(resultado.auditoriaId === null ? 'Auditoria: nada a registrar (nenhuma inserção)' : `Auditoria: logs_auditoria id ${resultado.auditoriaId}`);
  } else {
    saida.log('Nada foi gravado (dry-run). Para inserir o que está AUSENTE, repita com --executar.');
  }

  const atencao = totais.INSUFICIENTE + totais.NAO_CATALOGADA > 0;
  if (atencao) {
    saida.error('ATENÇÃO: há permissões existentes INSUFICIENTES ou ações NAO_CATALOGADAS. Elas NÃO foram alteradas; decida e corrija pelas telas de RBAC ou por ato administrativo próprio.');
  }
  return { saida: atencao ? SAIDAS.ATENCAO : SAIDAS.OK, resultado };
}

async function principal() {
  const interpretado = interpretarArgumentos(process.argv.slice(2));
  if (!interpretado.ok) {
    console.error(`Argumentos inválidos: ${interpretado.erro}`);
    console.error(uso());
    return SAIDAS.ARGUMENTOS;
  }

  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído.
  const { pool } = require('../src/config/database');
  try {
    const { saida } = await executarComando(interpretado, { pool });
    return saida;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${erro.message}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { interpretarArgumentos, executarComando, formatarPlano, uso, SAIDAS };
