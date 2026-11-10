'use strict';

const { Client } = require('pg');
const { registrarEventoSistema } = require('../src/repositories/auditoria-plataforma.repository');
const {
  PAPEL_PADRAO, criarVerificadorDePrivilegios, criarRegistradorDeAuditoria, criarAplicadorDeConcessoes,
} = require('../src/services/backup-privilegios-b1.service');

/**
 * Privilégios B-1 do papel de backup (D-ORF-6, H9-h). Três modos, um por execução; nenhum cria papel, roda migration ou toca o backup:
 *
 *   node --require dotenv/config scripts/backup-privilegios-b1.js --verificar
 *       COMO O PAPEL DE BACKUP (BACKUP_PG_HOST, BACKUP_PG_PORTA, BACKUP_PG_USUARIO, BACKUP_PG_BANCO; senha pelo PGPASSFILE do driver). Somente leitura. Registra o resultado na auditoria.
 *   node --require dotenv/config scripts/backup-privilegios-b1.js --proprietarios
 *       COMO O DONO (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, como o db:migrate). Somente leitura: lista o(s) proprietário(s) das relações de public.
 *   node --require dotenv/config scripts/backup-privilegios-b1.js --aplicar --confirmo-concessao-b1
 *       COMO O DONO. Roda os três GRANT do B-1 em uma transação, SÓ se a sessão for o único proprietário e não for o papel de backup; confere o resultado; registra na auditoria.
 *       Deve rodar logo DEPOIS do `db:migrate` do CD. Sem a frase de confirmação nada é conectado.
 *
 * O papel é BACKUP_PAPEL_BANCO (padrão safework_backup_executor). Saída: UMA linha JSON, sem valores de variáveis. Códigos: 0 ok, 1 erro de execução, 2 argumentos, 3 BLOQUEADO (pendência de privilégio ou recusa).
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1, ARGUMENTOS: 2, BLOQUEADO: 3 });
const CONFIRMACAO = '--confirmo-concessao-b1';
const MODOS = Object.freeze(['--verificar', '--proprietarios', '--aplicar']);
const USO = [
  'Uso:',
  '  node --require dotenv/config scripts/backup-privilegios-b1.js --verificar',
  '  node --require dotenv/config scripts/backup-privilegios-b1.js --proprietarios',
  `  node --require dotenv/config scripts/backup-privilegios-b1.js --aplicar ${CONFIRMACAO}`,
  'Saídas: 0 ok, 1 erro, 2 argumentos, 3 bloqueado.',
].join('\n').concat('\n');
const RE_PORTA = /^[1-9][0-9]{0,4}$/;

function configuracaoDe(modo, env) {
  const porta = modo === '--verificar' ? env.BACKUP_PG_PORTA : env.DB_PORT;
  const campos = modo === '--verificar'
    ? { host: env.BACKUP_PG_HOST, user: env.BACKUP_PG_USUARIO, database: env.BACKUP_PG_BANCO, password: undefined }
    : { host: env.DB_HOST, user: env.DB_USER, database: env.DB_NAME, password: env.DB_PASSWORD };
  if (typeof campos.host !== 'string' || campos.host === '' || typeof campos.user !== 'string' || campos.user === '' || typeof campos.database !== 'string' || campos.database === ''
    || typeof porta !== 'string' || !RE_PORTA.test(porta) || Number(porta) > 65535) return null;
  return { ...campos, port: Number(porta), connectionTimeoutMillis: 8000 };
}

/** `argv` sem node e script; `env` só process.env; `portas.criarCliente(config)` e `portas.saida(texto)` são injetáveis para teste. Devolve o código de saída. */
async function executar(argv, env, portas = {}) {
  const criarCliente = portas.criarCliente ?? ((config) => new Client(config));
  const saida = portas.saida ?? ((t) => process.stdout.write(t));
  const emitir = (objeto) => saida(`${JSON.stringify(objeto)}\n`);
  const modos = argv.filter((a) => MODOS.includes(a));
  const restantes = argv.filter((a) => !MODOS.includes(a) && a !== CONFIRMACAO);
  if (modos.length !== 1 || restantes.length > 0 || new Set(argv).size !== argv.length) { saida(USO); return SAIDAS.ARGUMENTOS; }
  const modo = modos[0];
  const confirmado = argv.includes(CONFIRMACAO);
  if ((modo === '--aplicar') !== confirmado) { saida(USO); return SAIDAS.ARGUMENTOS; }
  const papel = env.BACKUP_PAPEL_BANCO ?? PAPEL_PADRAO;
  const config = configuracaoDe(modo, env);
  if (config === null) { emitir({ ok: false, motivo: 'AMBIENTE_INCOMPLETO' }); return SAIDAS.ARGUMENTOS; }
  let cliente;
  try {
    cliente = criarCliente(config);
    cliente.on?.('error', () => {});
    await cliente.connect();
  } catch {
    emitir({ ok: false, motivo: 'CONEXAO_FALHOU' });
    return SAIDAS.ERRO;
  }
  try {
    const auditoria = criarRegistradorDeAuditoria({ executorDeAuditoria: cliente, registrarEventoSistema });
    if (modo === '--verificar') {
      const r = await criarVerificadorDePrivilegios({ executorDeBanco: cliente, papel }).verificar();
      const reg = await auditoria.registrar({ tipo: 'VERIFICACAO', resultado: r });
      emitir({ modo: 'verificar', ok: r.ok, motivos: r.motivos, papel: r.papel, identidade: r.identidade, pendentes: r.pendentes, esquemasNaoCobertos: r.esquemasNaoCobertos, avisos: r.avisos, auditoria: { gravado: reg.gravado } });
      return r.ok ? SAIDAS.OK : SAIDAS.BLOQUEADO;
    }
    const aplicador = criarAplicadorDeConcessoes({ executorDeBanco: cliente, papel, auditoria });
    if (modo === '--proprietarios') {
      const p = await aplicador.identificarProprietarios();
      emitir({ modo: 'proprietarios', executor: p.executor, sessao: p.sessao, banco: p.banco, donos: p.donos });
      return SAIDAS.OK;
    }
    const r = await aplicador.aplicar();
    emitir({ modo: 'aplicar', ok: r.ok, aplicado: r.aplicado, motivo: r.motivo, executor: r.executor ?? null, proprietario: r.proprietario ?? null, pendentes: r.verificacao?.pendentes ?? null, auditoria: r.auditoria ?? null });
    return r.ok ? SAIDAS.OK : SAIDAS.BLOQUEADO;
  } catch {
    emitir({ ok: false, motivo: 'EXECUCAO_FALHOU' });
    return SAIDAS.ERRO;
  } finally {
    try { await cliente.end(); } catch { /* encerramento tolerante */ }
  }
}

module.exports = { executar, SAIDAS, CONFIRMACAO };

if (require.main === module) {
  // Rejeição residual de `executar` (por exemplo, falha ao escrever a saída): terminal, sem detalhe da exceção e sem repetir a saída.
  executar(process.argv.slice(2), process.env)
    .then((codigo) => { process.exitCode = codigo; })
    .catch(() => { process.exitCode = SAIDAS.ERRO; });
}
