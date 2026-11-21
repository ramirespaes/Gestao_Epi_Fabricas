'use strict';

/**
 * Guardião da exclusão do CD do backend.
 *
 * Mantém UMA sessão PostgreSQL dedicada (conexão direta, nunca um pooler em modo de transação) que segura a exclusão
 * do D-ORF-6 enquanto uma instalação acontece. A exclusão é a operação MIGRACAO do módulo de coordenação existente,
 * usado como está: quem conhece as chaves e a matriz é ele. Com ela, backup, restauração, limpeza e migrations
 * concorrentes falham na hora, e o guardião falha na hora se algum deles já estiver em curso. Não há fila nem espera.
 *
 * Os cadeados são de sessão: valem enquanto esta conexão existir e somem com ela. Por isso o processo fica vivo até
 * receber "liberar", até o canal de controle fechar (o agente terminou ou morreu), até perder a conexão ou até o prazo
 * máximo. Antes de tomar qualquer cadeado, confere na mesma sessão o banco, o identificador do cluster e que o
 * servidor não é réplica em recuperação.
 *
 * Canal de controle (uma linha por mensagem):
 *   entrada: "confirmar <id>" (32 hexadecimais minúsculos, escolhidos por quem pergunta) | "liberar"
 *   saída:   {"evento":"ADQUIRIDA","cadeados":n} | {"evento":"RECUSADA","motivo"} | {"evento":"CONFIRMADA","id"}
 *            | {"evento":"PERDIDA"} | {"evento":"LIBERADA"} | {"evento":"CANAL_FECHADO"} | {"evento":"EXPIRADA"}
 *            | {"evento":"PROTOCOLO"} | {"evento":"SESSAO_INCERTA"}
 * "SESSAO_INCERTA" substitui qualquer evento de fim quando o encerramento da conexão não foi confirmado no prazo.
 * "CONFIRMADA" só sai depois de consultar, agora, que a sessão está viva e detém todos os cadeados, e devolve o id da
 * pergunta que respondeu. A aquisição só vale se os cadeados recebidos forem exatamente os que o módulo do D-ORF-6
 * declara para a operação. Só códigos são escritos: nenhuma credencial, host ou mensagem do driver. A senha vem do
 * arquivo de credencial, nunca do ambiente.
 */

const path = require('node:path');
const readline = require('node:readline');

const LIMITES = Object.freeze({ conexaoMs: 5000, consultaMs: 5000, aquisicaoMs: 15000, encerramentoMs: 5000, vidaMaximaMs: 45 * 60 * 1000 });
const OPERACAO = 'MIGRACAO';
const FORMATO_SISTEMA = /^[1-9]\d{0,19}$/;
const FORMATO_CONFIRMAR = /^confirmar ([0-9a-f]{32})$/;
const CONSULTA_DE_IDENTIDADE = 'SELECT current_database() AS banco, pg_is_in_recovery() AS em_recuperacao, (SELECT system_identifier::text FROM pg_control_system()) AS sistema';
// Cadeados de sessão desta conexão, neste banco, com a chave de 64 bits remontada como o PostgreSQL a guarda.
const CONSULTA_DE_POSSE = 'SELECT ((classid::bigint << 32) | objid::bigint)::text AS chave FROM pg_locks '
  + "WHERE locktype = 'advisory' AND objsubid = 1 AND granted AND pid = pg_backend_pid() "
  + 'AND database = (SELECT oid FROM pg_database WHERE datname = current_database())';
const SAIDAS = Object.freeze({ LIBERADA: 0, CANAL_FECHADO: 0, RECUSADA: 4, PERDIDA: 5, EXPIRADA: 6, PROTOCOLO: 7, SESSAO_INCERTA: 8 });

const recusa = (codigo) => Object.assign(new Error(codigo), { codigo });
const codigoDe = (falha, padrao) => (falha && typeof falha.codigo === 'string' && falha.codigo.startsWith('GUARDIAO_') ? falha.codigo : padrao);

function comLimite(promessa, ms, codigo) {
  let relogio;
  const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(recusa(codigo)), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

// A lista esperada vem do módulo do D-ORF-6; aqui só se compara. Lista vazia, repetida, a mais ou a menos não vale.
function posseCompativel(cadeados, esperados) {
  if (!Array.isArray(cadeados) || !Array.isArray(esperados) || esperados.length === 0) return false;
  const previstos = new Set(esperados.map(String));
  return cadeados.length === previstos.size && new Set(cadeados).size === previstos.size
    && cadeados.every((chave) => typeof chave === 'string' && previstos.has(chave));
}

function criarGuardiao({ conf, sistema, Client, adquirirExclusao, cadeadosDe, limites = LIMITES, opcoesTls = {} }) {
  let cliente = null;
  let posse = null;
  let viva = false;
  let iniciado = false;
  let encerrado = false;
  let sessaoEncerrada = true;
  const ouvintes = [];

  const perder = () => {
    if (!viva) return;
    viva = false;
    if (!encerrado) for (const cb of ouvintes.splice(0)) cb();
  };
  // O encerramento tem prazo. Vencido o prazo (ou com erro), o soquete é destruído e a sessão fica como NÃO confirmada:
  // o fim do processo derruba a conexão, mas daqui não se afirma que o servidor já soltou os cadeados.
  const fechar = async () => {
    const c = cliente;
    cliente = null;
    viva = false;
    if (!c) return;
    try {
      await comLimite(Promise.resolve().then(() => c.end()), limites.encerramentoMs, 'GUARDIAO_TIMEOUT');
    } catch {
      sessaoEncerrada = false;
      try { c.connection.stream.destroy(); } catch { /* sem soquete acessível: resta o fim do processo */ }
    }
  };
  const consultar = async (sql) => {
    try { return await cliente.query(sql); } catch { throw recusa('GUARDIAO_CONSULTA'); }
  };

  async function conectarEAdquirir() {
    cliente = new Client({
      host: conf.host, port: conf.porta, database: conf.banco, user: conf.usuario, password: conf.senha,
      connectionTimeoutMillis: limites.conexaoMs, query_timeout: limites.consultaMs, statement_timeout: limites.consultaMs,
      keepAlive: true, application_name: 'safework-guardiao-cd', ...opcoesTls,
    });
    if (typeof cliente.on === 'function') { cliente.on('error', perder); cliente.on('end', perder); }
    try { await cliente.connect(); } catch { throw recusa('GUARDIAO_CONEXAO'); }
    viva = true;
    const linha = (await consultar(CONSULTA_DE_IDENTIDADE)).rows[0];
    if (!linha || linha.banco !== conf.banco || linha.em_recuperacao !== false || linha.sistema !== sistema) throw recusa('GUARDIAO_IDENTIDADE_DIVERGENTE');
    const r = await adquirirExclusao({ query: (sql) => cliente.query(sql) }, { operacao: OPERACAO });
    if (r.ok !== true) return { ok: false, motivo: typeof r.motivo === 'string' ? r.motivo : 'GUARDIAO_CONSULTA' };
    let esperados = null;
    try { esperados = cadeadosDe(OPERACAO); } catch { esperados = null; }
    // A recusa encerra a sessão logo abaixo, e com ela cai qualquer cadeado que tenha sido tomado.
    if (!posseCompativel(r.cadeados, esperados)) throw recusa('GUARDIAO_CADEADOS');
    posse = r;
    return { ok: true, cadeados: r.cadeados };
  }

  async function adquirir() {
    if (iniciado) return { ok: false, motivo: 'GUARDIAO_JA_INICIADO' };
    iniciado = true;
    const prazoDeEncerramento = Number.isInteger(limites.encerramentoMs) && limites.encerramentoMs > 0;
    if (typeof sistema !== 'string' || !FORMATO_SISTEMA.test(sistema) || typeof cadeadosDe !== 'function' || !prazoDeEncerramento) return { ok: false, motivo: 'GUARDIAO_CONFIG' };
    let resultado;
    try {
      resultado = await comLimite(conectarEAdquirir(), limites.aquisicaoMs, 'GUARDIAO_TIMEOUT');
    } catch (falha) {
      resultado = { ok: false, motivo: codigoDe(falha, 'GUARDIAO_CONSULTA') };
    }
    if (!resultado.ok) { encerrado = true; posse = null; await fechar(); }
    return resultado;
  }

  // Verdadeiro só com a sessão viva E todos os cadeados da aquisição ainda concedidos a ela, consultado agora.
  async function confirmar() {
    if (!posse || !viva || encerrado) return false;
    try {
      const { rows } = await comLimite(consultar(CONSULTA_DE_POSSE), limites.consultaMs, 'GUARDIAO_TIMEOUT');
      const meus = new Set(rows.map((l) => l.chave));
      return viva && posse.cadeados.length > 0 && posse.cadeados.every((chave) => meus.has(chave));
    } catch {
      return false;
    }
  }

  async function liberar() {
    if (encerrado) return { liberados: 0, sessaoEncerrada };
    encerrado = true;
    let liberados = 0;
    if (posse && viva) { try { liberados = (await comLimite(posse.liberar(), limites.consultaMs, 'GUARDIAO_TIMEOUT')).liberados; } catch { /* a sessão encerrada abaixo solta o que restar */ } }
    posse = null;
    await fechar();
    return { liberados, sessaoEncerrada };
  }

  return { adquirir, confirmar, liberar, aoPerder: (cb) => { ouvintes.push(cb); } };
}

// O driver, o módulo do D-ORF-6 e a leitura da credencial só são carregados na execução real.
function dependenciasReais(conf) {
  const { Client } = require('pg');
  const { adquirirExclusao, cadeadosDe } = require('../src/services/backup-fontes-coordenacao-operacoes.service');
  const { opcoesDeTls } = require('../src/config/database-tls');
  return { Client, adquirirExclusao, cadeadosDe, opcoesTls: opcoesDeTls({ modo: conf.tls.modo, raizCa: conf.tls.raizCa, host: conf.host }) };
}

function lerArgumentos(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== '--credencial' || argv[2] !== '--sistema' || !path.isAbsolute(argv[1]) || !FORMATO_SISTEMA.test(argv[3])) throw recusa('GUARDIAO_USO');
  return { credencial: argv[1], sistema: argv[3] };
}

async function executar({ argv = process.argv.slice(2), entrada = process.stdin, saida = (t) => process.stdout.write(t), limites = LIMITES, ...injetadas } = {}) {
  const emitir = (mensagem) => { try { saida(`${JSON.stringify(mensagem)}\n`); } catch { /* sem canal de saída: resta o código de saída */ } };
  let guardiao;
  let aquisicao;
  try {
    const args = lerArgumentos(argv);
    let conf;
    try { conf = require('./sonda-estado-observado').lerCredencial(args.credencial); } catch { throw recusa('GUARDIAO_CREDENCIAL'); }
    const deps = injetadas.Client ? injetadas : { ...dependenciasReais(conf), ...injetadas };
    guardiao = criarGuardiao({ ...deps, conf, sistema: args.sistema, limites });
    aquisicao = await guardiao.adquirir();
  } catch (falha) {
    aquisicao = { ok: false, motivo: codigoDe(falha, 'GUARDIAO_ERRO') };
  }
  if (!aquisicao.ok) { emitir({ evento: 'RECUSADA', motivo: aquisicao.motivo }); return SAIDAS.RECUSADA; }

  return new Promise((resolver) => {
    let terminou = false;
    let fila = Promise.resolve();
    const linhas = readline.createInterface({ input: entrada });
    // Em todo fim os cadeados são soltos ANTES de avisar: quem lê o evento pode contar com a liberação. Se o encerramento
    // da sessão não foi confirmado, o evento previsto não sai: sai SESSAO_INCERTA e o processo termina do mesmo jeito.
    const fim = (evento) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(relogio);
      linhas.close();
      const concluir = (final) => { emitir({ evento: final }); resolver(SAIDAS[final]); };
      guardiao.liberar().then((r) => concluir(r && r.sessaoEncerrada === true ? evento : 'SESSAO_INCERTA'), () => concluir('SESSAO_INCERTA'));
    };
    const relogio = setTimeout(() => fim('EXPIRADA'), limites.vidaMaximaMs);
    guardiao.aoPerder(() => fim('PERDIDA'));
    linhas.on('line', (linha) => {
      fila = fila.then(async () => {
        if (terminou) return;
        if (linha === 'liberar') { fim('LIBERADA'); return; }
        const pergunta = FORMATO_CONFIRMAR.exec(linha);
        if (!pergunta) { fim('PROTOCOLO'); return; }
        if (await guardiao.confirmar()) { if (!terminou) emitir({ evento: 'CONFIRMADA', id: pergunta[1] }); } else fim('PERDIDA');
      });
    });
    linhas.on('close', () => fim('CANAL_FECHADO'));
    emitir({ evento: 'ADQUIRIDA', cadeados: aquisicao.cadeados.length });
  });
}

function comoComando({ rodar = executar, encerrar = (codigo) => process.exit(codigo) } = {}) {
  rodar().then(encerrar).catch(() => { encerrar(9); });
}

if (require.main === module) comoComando();

module.exports = { criarGuardiao, executar, comoComando, LIMITES, SAIDAS };
