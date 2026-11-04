'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-SUPERVISOR-LANCADOR-1): identidade do processo e falhas de início na fronteira
 * LANÇADOR → SUPERVISOR → COORDENADOR. Só unitário e em memória: o `spawn`, o filho, os eventos, o grupo, os sinais e os relógios são falsos; nenhum
 * processo, sinal, PostgreSQL ou relógio reais. Não há módulo novo a testar: tudo o que falha aqui é COMPORTAMENTO atual do supervisor.
 *
 * CONTRATO REAL CONFIRMADO (lido no código):
 *   - `supervisionar(opcoes)`: depois de `iniciar()`, só aceita `processo` objeto com `pgid` inteiro seguro `> 0` (e não `> 1`), `saida` e `fluxosFechados`
 *     promessas; qualquer rejeição de `iniciar()` (a exceção é DESCARTADA: o `catch` não a lê) ou retorno fora desse formato vira
 *     `{ saida: 1, liberarTravaPermitido: false, motivos: ['INICIO_FALHOU'] }`, sem consulta de grupo e sem sinal;
 *   - com `pgid` aceito, o supervisor consulta `grupo.vivos(pgid)` e envia `sinais.enviar(pgid, 'SIGTERM'|'SIGKILL'|parada repassada)`: por isso um `pgid`
 *     igual a 1 (aceito hoje) levaria a consultar e sinalizar o alvo 1; o serviço do dump e o lançador já recusam pid `<= 1`, o supervisor sozinho não;
 *   - o coordenador só lê `supervisao.liberarTravaPermitido` e `supervisao.concluido`; o resultado do executor devolve o resultado do supervisor em
 *     `resultado.supervisao` (com `motivos`), que é o único canal de diagnóstico até o operador sem mexer no coordenador;
 *   - liberar exige, JUNTOS, término confirmado (positivo e válido), fluxos fechados e grupo confirmado vazio: `exit`, `close` e grupo vazio são condições distintas.
 *
 * PROPOSTA DE EXTENSÃO MÍNIMA (NÃO imposta por estes testes; depende de decisão de Ramires/ChatGPT; ver os TODO SUP-LAN-05*):
 *   1. `pgid` aceito somente se `> 1` (corrige o PGID 1, sem mudar nenhuma saída histórica);
 *   2. em `catch (falha)` de `iniciar()`, ler o `code` UMA vez, com tratamento de getter hostil, e SÓ SE for exatamente `NAO_INICIADO` ou `INICIO_INCONCLUSIVO`
 *      acrescentar ao resultado o motivo fixo correspondente (novos valores de `MOTIVOS`), mantendo `INICIO_FALHOU`, saída 1 e `liberarTravaPermitido: false`;
 *      código ausente ou desconhecido: `motivos` continua exatamente `['INICIO_FALHOU']`; nenhuma mensagem é lida;
 *   3. o coordenador e o executor não mudam: o motivo chega ao operador em `resultado.supervisao.motivos`, a retenção da trava continua a mesma.
 *   EFEITO COLATERAL A DECIDIR: os testes do arquivo do lançador que caracterizam "o supervisor entrega o MESMO resultado nos dois casos" (CTL-01, LAN-07 e LAN-07b
 *   de imagem-backup-pgdump-lancador.test.js) passariam a divergir e teriam de ser atualizados de forma deliberada.
 *
 * COMO LER: os SUP-LAN-01a/b/c são RED COMPORTAMENTAL (falham hoje pelo PGID 1). Os demais são CONTROLES que passam hoje e fixam a política conservadora que
 * qualquer extensão precisa preservar. Reutilização de PGID e identidade real do grupo NÃO se resolvem com doubles: continuam dependendo do sistema operacional.
 */

const MODULO_SUPERVISOR = 'src/services/imagem-backup-supervisor.service';
const supervisor = () => exigirModulo(MODULO_SUPERVISOR);
const PRAZO_DO_TESTE = 10000;
const PID = 4242;
const DESCRITOR = 77;
const ID_SNAPSHOT = '0000000A-0000002B-7';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const HOST = 'db.interno.exemplo';
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const SAIDA = Object.freeze({ CONCLUIDO: 0, INICIO: 1, FALHA: 9, DESCONHECIDO: 11 });

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);
const descarga = () => new Promise((resolver) => setImmediate(resolver));

function adiado() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Relógio falso: `imediatos` vencem na hora; os demais prazos ficam registrados e só vencem quando o teste manda. */
function criarTemporizador({ imediatos = [] } = {}) {
  const prazos = [];
  return {
    prazos,
    prazo(ms) {
      const d = adiado();
      const registro = { ms, cancelado: false, vencer: () => d.resolver() };
      prazos.push(registro);
      if (imediatos.includes(ms)) d.resolver();
      return { promessa: d.promessa, cancelar() { registro.cancelado = true; } };
    },
    intervalo: () => Promise.resolve(),
  };
}

/** Opções do supervisor com um processo qualquer (identidade controlada pelo teste) e sinais/grupo contados. */
function montarSupervisao(opcoesDoMundo = {}) {
  // `pgid` ausente = pid padrão; `pgid: undefined` explícito é PRESERVADO (um valor padrão de parâmetro o substituiria).
  const pgid = Object.hasOwn(opcoesDoMundo, 'pgid') ? opcoesDoMundo.pgid : PID;
  const { iniciar = null, vivos = false, imediatos = [], aoSigkill = null, parada = null, repassarParada = false } = opcoesDoMundo;
  const saida = adiado();
  const fluxos = adiado();
  const contagem = { grupo: [], sinais: [] };
  const temporizador = criarTemporizador({ imediatos });
  const opcoes = {
    async iniciar() {
      if (iniciar) return iniciar();
      return { pgid, saida: saida.promessa, fluxosFechados: fluxos.promessa };
    },
    grupo: { async vivos(alvo) { contagem.grupo.push(alvo); return vivos; } },
    sinais: {
      async enviar(alvo, sinal) {
        contagem.sinais.push([alvo, sinal]);
        if (sinal === 'SIGKILL' && aoSigkill) aoSigkill({ saida, fluxos });
        return true;
      },
    },
    temporizador,
    prazos: { ...PRAZOS },
  };
  if (parada) opcoes.parada = parada;
  if (repassarParada) opcoes.repassarParada = true;
  return { opcoes, contagem, saida, fluxos, temporizador };
}

function erroSensivel(codigo = 'EPIPE') {
  return Object.assign(new Error(`falha ${HOST} password=${SEGREDO}`), { code: codigo });
}

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-01
describe('[SUP-LAN-01] identidade inválida: nenhum identificador inválido é usado para consultar grupo ou enviar sinais', () => {
  teste('SUP-LAN-01a — RED: `pgid` 1 com término limpo e grupo "vazio" NÃO pode ser aceito como identidade: INICIO_FALHOU, saída 1, trava não liberável, o alvo 1 nunca é consultado', async () => {
    const m = montarSupervisao({ pgid: 1 });
    m.saida.resolver({ codigo: 0, sinal: null });
    m.fluxos.resolver();
    const r = await supervisor().supervisionar(m.opcoes);
    assert.equal(r.saida, SAIDA.INICIO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.equal(r.concluido, false);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
    assert.deepEqual(m.contagem.grupo, []);
    assert.deepEqual(m.contagem.sinais, []);
  });

  teste('SUP-LAN-01b — RED: `pgid` 1 com o processo VIVO e prazos esgotados: nenhum SIGTERM/SIGKILL pode ser enviado ao alvo 1', async () => {
    const m = montarSupervisao({ pgid: 1, imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); } });
    const r = await supervisor().supervisionar(m.opcoes);
    assert.deepEqual(m.contagem.sinais, [], 'nenhum sinal para o alvo 1');
    assert.deepEqual(m.contagem.grupo, []);
    assert.equal(r.saida, SAIDA.INICIO);
    assert.equal(r.liberarTravaPermitido, false);
  });

  teste('SUP-LAN-01c — RED: `pgid` 1 com pedido de parada repassado (SIGINT): o sinal nunca vai ao alvo 1', async () => {
    const ouvintes = [];
    const m = montarSupervisao({ pgid: 1, parada: { aoPedir(f) { ouvintes.push(f); } }, repassarParada: true });
    m.saida.resolver({ codigo: null, sinal: 'SIGINT' });
    m.fluxos.resolver();
    const pendente = supervisor().supervisionar(m.opcoes);
    for (const f of ouvintes) f('SIGINT');
    const r = await pendente;
    assert.deepEqual(m.contagem.sinais, []);
    assert.deepEqual(m.contagem.grupo, []);
    assert.equal(r.liberarTravaPermitido, false);
    assert.equal(r.saida, SAIDA.INICIO);
  });

  const invalidos = [['0', 0], ['negativo', -1], ['negativo grande', -4321], ['fracionário', 1.5], ['undefined', undefined], ['null', null], ['texto', '4242'], ['NaN', Number.NaN], ['infinito', Infinity], ['acima do seguro', Number.MAX_SAFE_INTEGER + 2]];
  for (const [rotulo, pgid] of invalidos) {
    teste(`SUP-LAN-01d (pgid ${rotulo}) — CONTROLE: identidade inválida é INICIO_FALHOU (saída 1, trava não liberável), sem consulta de grupo e sem sinal, mesmo com prazos vencidos`, async () => {
      const m = montarSupervisao({ pgid, imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs] });
      m.saida.resolver({ codigo: 0, sinal: null });
      m.fluxos.resolver();
      const r = await supervisor().supervisionar(m.opcoes);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
      assert.deepEqual(m.contagem.grupo, []);
      assert.deepEqual(m.contagem.sinais, []);
    });
  }

  for (const pgid of [2, PID, 99999]) {
    teste(`SUP-LAN-01e (pgid ${pgid}) — CONTROLE contra rigor excessivo: um pgid inteiro seguro maior que 1 continua sendo aceito e conclui com saída 0`, async () => {
      const m = montarSupervisao({ pgid });
      m.saida.resolver({ codigo: 0, sinal: null });
      m.fluxos.resolver();
      const r = await supervisor().supervisionar(m.opcoes);
      assert.equal(r.saida, SAIDA.CONCLUIDO);
      assert.equal(r.liberarTravaPermitido, true);
      assert.deepEqual(m.contagem.grupo, [pgid]);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-02 / 03
describe('[SUP-LAN-02/03] falha de início (comprovada ou inconclusiva): retenção conservadora, snapshot e trava intactos no coordenador', () => {
  function mundoDoExecutor(falha) {
    const linha = [];
    const estado = { documento: null, liberacoes: 0 };
    const contagem = { snapshot: 0, copia: 0, avaliar: 0, finalizar: 0, iniciar: 0 };
    const janela = {
      async adquirir(argumentos) {
        linha.push('adquirir');
        if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
        estado.documento = { tipo: argumentos.tipo, token: 'token-1' };
        return Object.freeze({
          tipo: argumentos.tipo,
          async confirmarPosse() { return { confirmada: estado.documento !== null && estado.documento.token === 'token-1' }; },
          async liberar() { estado.liberacoes += 1; linha.push('liberar'); estado.documento = null; return { liberada: true }; },
        });
      },
    };
    const dependencias = {
      janela,
      async snapshot() { contagem.snapshot += 1; linha.push('snapshot'); return { ok: true }; },
      processoDoDump() {
        return {
          async iniciar() { contagem.iniciar += 1; throw falha; },
          grupo: { async vivos() { linha.push('grupo'); return false; } },
          sinais: { async enviar() { linha.push('sinal'); return true; } },
          temporizador: criarTemporizador(),
          prazos: { ...PRAZOS },
        };
      },
      async copia() { contagem.copia += 1; return { ok: true }; },
      avaliar() { contagem.avaliar += 1; return { valido: true, motivos: [] }; },
      async finalizar() { contagem.finalizar += 1; linha.push('finalizar'); return { concluida: true }; },
    };
    return { linha, estado, contagem, dependencias };
  }

  for (const [rotulo, codigo] of [
    ['SUP-LAN-02 — falha COMPROVADA antes do início (NAO_INICIADO)', 'NAO_INICIADO'],
    ['SUP-LAN-03 — lançamento INCONCLUSIVO (INICIO_INCONCLUSIVO): ausência de PID NÃO é ausência de processo', 'INICIO_INCONCLUSIVO'],
  ]) {
    teste(`${rotulo} — CONTROLE pelo executor real: trava RETIDA (11), finalização ADIADA (o snapshot NÃO é encerrado), liberar nunca, cópia e avaliação não rodam, nenhuma consulta de grupo nem sinal`, async () => {
      const { executarBackupSupervisionado } = exigirModulo('src/services/imagem-backup-executor.service');
      const m = mundoDoExecutor(Object.assign(new Error('x'), { code: codigo }));
      const r = await executarBackupSupervisionado(m.dependencias);
      assert.equal(m.contagem.iniciar, 1);
      assert.equal(r.saida, SAIDA.DESCONHECIDO);
      assert.equal(r.janela, 'RETIDA');
      assert.equal(r.finalizacao, 'ADIADA');
      assert.equal(m.contagem.finalizar, 0);
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(m.contagem.copia + m.contagem.avaliar, 0);
      assert.equal(m.linha.includes('grupo') || m.linha.includes('sinal'), false);
      assert.ok(r.motivos.includes('LIBERACAO_NEGADA_PELA_SUPERVISAO'));
      assert.equal(r.supervisao.liberarTravaPermitido, false);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
    });
  }

  teste('SUP-LAN-05z — CONTROLE: o diagnóstico chega ao operador por `resultado.supervisao.motivos` (INICIO_FALHOU + o motivo informativo do código reconhecido), sem mudar a retenção da trava', async () => {
    const { executarBackupSupervisionado } = exigirModulo('src/services/imagem-backup-executor.service');
    const motivos = [];
    for (const codigo of ['NAO_INICIADO', 'INICIO_INCONCLUSIVO']) {
      const m = mundoDoExecutor(Object.assign(new Error('x'), { code: codigo }));
      motivos.push([...(await executarBackupSupervisionado(m.dependencias)).supervisao.motivos]);
    }
    assert.deepEqual(motivos, [['INICIO_FALHOU', 'NAO_INICIADO'], ['INICIO_FALHOU', 'INICIO_INCONCLUSIVO']]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- lançador real + supervisor real
function criarFilho(opcoes = {}) {
  const pid = Object.hasOwn(opcoes, 'pid') ? opcoes.pid : PID;
  const ouvintes = {};
  const filho = {
    killChamadas: 0,
    on(evento, f) { (ouvintes[evento] ??= []).push(f); return filho; },
    emitir(evento, ...argumentos) { for (const f of [...(ouvintes[evento] ?? [])]) f(...argumentos); },
    kill() { filho.killChamadas += 1; return true; },
  };
  Object.defineProperty(filho, 'pid', { enumerable: true, get: () => pid });
  return filho;
}

const SPEC = () => ({
  executavel: '/usr/lib/postgresql/16/bin/pg_dump',
  argumentos: ['--format=custom', '--no-password', `--snapshot=${ID_SNAPSHOT}`, '--dbname=gestao_epi'],
  ambiente: { PGPASSFILE: '/etc/safework/pgpass', PGHOST: HOST, PGPORT: '5432', PGUSER: 'u' },
  opcoes: { shell: false, detached: true, stdio: ['ignore', DESCRITOR, 'ignore'] },
});

/** Supervisor REAL sobre o lançador REAL (com `spawn` e filho falsos). O filho tem os ouvintes registrados já na chamada síncrona de `supervisionar`. */
function supervisaoComLancadorReal({ filho = criarFilho(), vivos = false, imediatos = [], aoSigkill = null } = {}) {
  const { criarLancadorComSpawn } = exigirModulo('src/services/imagem-backup-pgdump-lancador.service');
  const lancador = criarLancadorComSpawn({ spawn: () => filho });
  const contagem = { grupo: [], sinais: [] };
  const temporizador = criarTemporizador({ imediatos });
  const opcoes = {
    async iniciar() {
      const processo = await lancador.lancar(SPEC());
      return { pgid: processo.pid, saida: processo.saida, fluxosFechados: processo.fluxosFechados };
    },
    grupo: { async vivos(alvo) { contagem.grupo.push(alvo); return vivos; } },
    sinais: {
      async enviar(alvo, sinal) {
        contagem.sinais.push([alvo, sinal]);
        if (sinal === 'SIGKILL' && aoSigkill) aoSigkill(filho);
        return true;
      },
    },
    temporizador,
    prazos: { ...PRAZOS },
  };
  return { opcoes, lancador, filho, contagem, temporizador };
}

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-04
describe('[SUP-LAN-04] erro DEPOIS do início: a identidade já adquirida não se perde', () => {
  teste('SUP-LAN-04 — CONTROLE: `error` do filho depois do `spawn` não vira NAO_INICIADO nem INICIO_FALHOU; o supervisor segue com o MESMO pgid e só sinaliza esse pgid quando o prazo vence; o lançador continua INICIADO', async () => {
    const m = supervisaoComLancadorReal({ aoSigkill: (filho) => { filho.emitir('exit', null, 'SIGKILL'); filho.emitir('close', null, 'SIGKILL'); }, imediatos: [PRAZOS.cortesiaMs] });
    const pendente = supervisor().supervisionar(m.opcoes);
    m.filho.emitir('spawn');
    await descarga();
    m.filho.emitir('error', erroSensivel('EPIPE'));
    await descarga();
    assert.deepEqual(m.contagem.sinais, [], 'o erro, sozinho, não dispara sinais nem encerra a espera');
    m.temporizador.prazos.find((p) => p.ms === PRAZOS.totalMs).vencer();
    const r = await pendente;
    assert.equal(r.motivos.includes('INICIO_FALHOU'), false);
    assert.deepEqual(m.contagem.sinais, [[PID, 'SIGTERM'], [PID, 'SIGKILL']]);
    assert.deepEqual(m.contagem.grupo, [PID]);
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.liberarTravaPermitido, true, 'término (SIGKILL) e fluxos confirmados e grupo vazio');
    const [registro] = m.lancador.situacao();
    assert.equal(registro.estado, 'INICIADO');
    assert.equal(registro.pid, PID);
    assert.equal(registro.causa, 'EPIPE');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-06
describe('[SUP-LAN-06] término, fechamento de fluxos e ausência do grupo são condições DISTINTAS (supervisor e lançador reais)', () => {
  teste('SUP-LAN-06a — CONTROLE: `exit` sozinho (fluxos nunca fecham) não libera: saída 11, nenhum sinal (o término foi confirmado), motivo FLUXOS_PENDENTES', async () => {
    const m = supervisaoComLancadorReal({ imediatos: [PRAZOS.totalMs] });
    const pendente = supervisor().supervisionar(m.opcoes);
    m.filho.emitir('spawn');
    m.filho.emitir('exit', 0, null);
    const r = await pendente;
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('FLUXOS_PENDENTES'));
    assert.deepEqual(m.contagem.sinais, []);
  });

  teste('SUP-LAN-06b — CONTROLE: `close` sozinho (o término nunca é informado) não libera: SIGTERM e SIGKILL ao pgid, saída 11, motivo SAIDA_INDEFINIDA', async () => {
    const m = supervisaoComLancadorReal({ imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs] });
    const pendente = supervisor().supervisionar(m.opcoes);
    m.filho.emitir('spawn');
    m.filho.emitir('close', 0, null);
    const r = await pendente;
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('SAIDA_INDEFINIDA'));
    assert.deepEqual(m.contagem.sinais, [[PID, 'SIGTERM'], [PID, 'SIGKILL']]);
  });

  teste('SUP-LAN-06c — CONTROLE: `exit` e `close` com o grupo ainda povoado não liberam: saída 11, DESCENDENTES_ATIVOS, nenhum descendente é sinalizado', async () => {
    const m = supervisaoComLancadorReal({ vivos: true });
    const pendente = supervisor().supervisionar(m.opcoes);
    m.filho.emitir('spawn');
    m.filho.emitir('exit', 0, null);
    m.filho.emitir('close', 0, null);
    const r = await pendente;
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('DESCENDENTES_ATIVOS'));
    assert.deepEqual(m.contagem.sinais, []);
  });

  teste('SUP-LAN-06d — CONTROLE: só as TRÊS confirmações juntas (término válido, fluxos fechados, grupo vazio) liberam: saída 0, nenhum sinal', async () => {
    const m = supervisaoComLancadorReal();
    const pendente = supervisor().supervisionar(m.opcoes);
    m.filho.emitir('spawn');
    m.filho.emitir('exit', 0, null);
    m.filho.emitir('close', 0, null);
    const r = await pendente;
    assert.equal(r.saida, SAIDA.CONCLUIDO);
    assert.equal(r.liberarTravaPermitido, true);
    assert.deepEqual(m.contagem.sinais, []);
    assert.deepEqual(m.contagem.grupo, [PID]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-07
describe('[SUP-LAN-07] compatibilidade: qualquer extensão precisa ser ADITIVA e nunca transformar um estado inseguro em sucesso', () => {
  const falhas = [
    ['Error comum', () => new Error('x')],
    ['Error com código de sistema', () => Object.assign(new Error('x'), { code: 'ENOENT' })],
    ['Error com código desconhecido', () => Object.assign(new Error('x'), { code: 'CODIGO_QUE_NAO_EXISTE' })],
    ['valor lançado que não é Error', () => 'texto'],
    ['rejeição com mensagem sensível', () => erroSensivel('EACCES')],
  ];
  for (const [rotulo, criar] of falhas) {
    teste(`SUP-LAN-07 (${rotulo}) — CONTROLE: rejeição sem código reconhecido continua EXATAMENTE \`['INICIO_FALHOU']\`, saída 1, trava não liberável, nada vaza no resultado`, async () => {
      const m = montarSupervisao({ iniciar: async () => { throw criar(); } });
      const r = await supervisor().supervisionar(m.opcoes);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
      const texto = JSON.stringify(r);
      for (const marcador of [SEGREDO, HOST, 'password']) assert.equal(texto.includes(marcador), false, marcador);
    });
  }

  teste('SUP-LAN-07b — CONTROLE: retorno de `iniciar()` fora do formato (sem promessas, ou não objeto) continua INICIO_FALHOU, sem consulta de grupo nem sinal', async () => {
    for (const retorno of [undefined, null, 7, { pgid: PID }, { pgid: PID, saida: 1, fluxosFechados: 2 }]) {
      const m = montarSupervisao({ iniciar: async () => retorno });
      const r = await supervisor().supervisionar(m.opcoes);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
      assert.deepEqual(m.contagem.grupo, []);
      assert.deepEqual(m.contagem.sinais, []);
    }
  });

  teste('SUP-LAN-07c — CONTROLE: processo vivo com pgid válido e prazos vencidos continua recebendo SIGTERM e depois SIGKILL ao MESMO pgid, e o resultado forçado continua sendo falha (9)', async () => {
    const m = montarSupervisao({ pgid: PID, imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); } });
    const r = await supervisor().supervisionar(m.opcoes);
    assert.deepEqual(m.contagem.sinais, [[PID, 'SIGTERM'], [PID, 'SIGKILL']]);
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.encerramentoForcado, true);
  });

  teste('SUP-LAN-07d — CONTROLE: nenhuma condição insegura vira sucesso: processo vivo, grupo povoado e SIGKILL ignorado mantêm saída 11 e trava não liberável', async () => {
    const m = montarSupervisao({ pgid: PID, vivos: true, imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs] });
    const r = await supervisor().supervisionar(m.opcoes);
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.equal(r.concluido, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SUP-LAN-05 / pendências
describe('[SUP-LAN-05] extensão de diagnóstico e pendências: registradas, NÃO executadas (dependem de decisão)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  // SUP-LAN-05a, 05b e 05c foram CONVERTIDOS em testes ativos (DIA-01 a DIA-09, no bloco [DIA] abaixo).
  // SUP-LAN-05d (atualizar CTL-01, LAN-07 e LAN-07b) foi CONCLUÍDO no GREEN-SUPERVISOR-DIAGNOSTICO-1; SUP-LAN-05e (pgid > 1) está coberto pelos testes ativos
  // SUP-LAN-01a, 01b e 01c (e pelos controles 01d/01e): ambos os registros TODO foram retirados por estarem obsoletos.
  todo('SUP-LAN-08a — reutilização de PGID e identidade real do grupo (par pgid/horário de início ou handle estável) antes de qualquer consulta ou sinal', 'depende de sistema operacional real');
  todo('SUP-LAN-08b — filho órfão de um lançamento inconclusivo: política operacional (alerta, retenção permanente, procedimento de recuperação); o supervisor não tem como assumi-lo sem identidade', 'decisão operacional');
  todo('SUP-LAN-08c — semântica real de `spawn`/`exit`/`close`/`error` e do grupo de processos no Node e no sistema operacional', 'depende de processo real');
});

// =============================================================================================================================== RED-SUPERVISOR-DIAGNOSTICO-1
const MOTIVO_NAO_INICIADO = 'NAO_INICIADO';
const MOTIVO_INCONCLUSIVO = 'INICIO_INCONCLUSIVO';
const MOTIVOS_FIXOS = /^[A-Z][A-Z_]*$/;
const CHAVES_DO_RESULTADO = ['saida', 'concluido', 'liberarTravaPermitido', 'encerramentoForcado', 'parada', 'codigoDoProcesso', 'sinalDoProcesso', 'motivos'].sort();
const comGetter = (objeto, chave, get) => Object.defineProperty(objeto, chave, { enumerable: true, configurable: true, get });

function semMarcadores(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : (JSON.stringify(valor) ?? String(valor));
  for (const marcador of [SEGREDO, HOST, 'password']) assert.equal(texto.includes(marcador), false, `${rotulo}: não pode conter "${marcador}"`);
}

/** Supervisor real com um `iniciar()` que rejeita com o valor dado; devolve também o que foi consultado ou sinalizado. */
async function rejeitandoCom(valor, extras = {}) {
  const m = montarSupervisao({ iniciar: async () => { throw valor; }, ...extras });
  const r = await supervisor().supervisionar(m.opcoes);
  return { r, m };
}

function erroComCodigo(codigo, mensagem = 'x') {
  return Object.assign(new Error(mensagem), { code: codigo });
}

// ------------------------------------------------------------------------------------------------------------------------------- DIA-01 / 02
describe('[DIA-01/02] falha comprovada e lançamento inconclusivo: o diagnóstico é ADITIVO e a política de retenção não muda', () => {
  for (const [rotulo, codigo] of [['DIA-01 — NAO_INICIADO (falha comprovada informada pelo lançador)', MOTIVO_NAO_INICIADO], ['DIA-02 — INICIO_INCONCLUSIVO (o processo pode ter iniciado, sem identidade supervisionável)', MOTIVO_INCONCLUSIVO]]) {
    teste(`${rotulo}: preserva INICIO_FALHOU e acrescenta o motivo fixo, nessa ordem; saída 1, trava não liberável, não concluído; nenhuma consulta de grupo nem sinal`, async () => {
      const { r, m } = await rejeitandoCom(erroComCodigo(codigo));
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU', codigo]);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.equal(r.concluido, false);
      assert.deepEqual(m.contagem.grupo, []);
      assert.deepEqual(m.contagem.sinais, []);
    });
  }

  teste('DIA-02b — com o lançamento inconclusivo, um pedido de parada repassado e prazos vencidos NÃO geram sinal: sem identidade segura nada é sinalizado, e a trava continua não liberável', async () => {
    const ouvintes = [];
    const { r, m } = await rejeitandoCom(erroComCodigo(MOTIVO_INCONCLUSIVO), { parada: { aoPedir(f) { ouvintes.push(f); } }, repassarParada: true, imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs] });
    for (const f of ouvintes) f('SIGINT');
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU', MOTIVO_INCONCLUSIVO]);
    assert.deepEqual(m.contagem.sinais, []);
    assert.deepEqual(m.contagem.grupo, []);
    assert.equal(r.liberarTravaPermitido, false);
  });

  teste('DIA-08 — os dois motivos novos são valores fixos de MOTIVOS (o enum público é estendido de forma aditiva; os antigos continuam)', () => {
    const { MOTIVOS } = supervisor();
    assert.equal(MOTIVOS.NAO_INICIADO, MOTIVO_NAO_INICIADO);
    assert.equal(MOTIVOS.INICIO_INCONCLUSIVO, MOTIVO_INCONCLUSIVO);
    assert.equal(MOTIVOS.INICIO_FALHOU, 'INICIO_FALHOU');
    assert.equal(MOTIVOS.FLUXOS_PENDENTES, 'FLUXOS_PENDENTES');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- DIA-03
describe('[DIA-03] código desconhecido, ausente ou inválido: comportamento histórico EXATO (`[INICIO_FALHOU]`) — controles que o GREEN não pode quebrar', () => {
  const casos = [
    ['sem código', () => new Error('x')],
    ['código de sistema (ENOENT)', () => erroComCodigo('ENOENT')],
    ['código desconhecido', () => erroComCodigo('CODIGO_QUE_NAO_EXISTE')],
    ['minúsculas', () => erroComCodigo('nao_iniciado')],
    ['espaço no fim', () => erroComCodigo('NAO_INICIADO ')],
    ['espaço no começo', () => erroComCodigo(' INICIO_INCONCLUSIVO')],
    ['prefixo extra', () => erroComCodigo('X_NAO_INICIADO')],
    ['número', () => erroComCodigo(7)],
    ['nulo', () => erroComCodigo(null)],
    ['lista com o texto', () => erroComCodigo(['NAO_INICIADO'])],
    ['objeto cujo toString devolve o texto', () => erroComCodigo({ toString: () => 'NAO_INICIADO', valueOf: () => 'NAO_INICIADO' })],
    ['a MENSAGEM igual ao código, sem código', () => new Error('NAO_INICIADO')],
    ['a MENSAGEM igual ao código, com outro código', () => erroComCodigo('EACCES', 'INICIO_INCONCLUSIVO')],
    ['texto lançado (não é Error)', () => 'NAO_INICIADO'],
    ['número lançado', () => 42],
    ['undefined lançado', () => undefined],
    ['nulo lançado', () => null],
  ];
  for (const [rotulo, criar] of casos) {
    teste(`DIA-03 (${rotulo}) — motivos continua exatamente [INICIO_FALHOU]; saída 1; trava não liberável; sem consulta nem sinal`, async () => {
      const { r, m } = await rejeitandoCom(criar());
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.deepEqual(m.contagem.grupo, []);
      assert.deepEqual(m.contagem.sinais, []);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- DIA-04
describe('[DIA-04] sigilo e leitura segura: só códigos fixos, `code` lido no máximo uma vez, nada de mensagem, objetos hostis nunca viram sucesso', () => {
  teste('DIA-04 — a MENSAGEM sensível nunca participa: com código reconhecido, os motivos são só os fixos e o resultado serializado não contém o marcador', async () => {
    const { r } = await rejeitandoCom(erroComCodigo(MOTIVO_NAO_INICIADO, `falha ${HOST} password=${SEGREDO}`));
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU', MOTIVO_NAO_INICIADO]);
    for (const motivo of r.motivos) assert.match(motivo, MOTIVOS_FIXOS);
    semMarcadores(r, 'resultado');
  });

  teste('DIA-04b — `code` lido NO MÁXIMO UMA vez: um getter que devolve NAO_INICIADO na primeira leitura e INICIO_INCONCLUSIVO depois vale pela PRIMEIRA leitura', async () => {
    let leituras = 0;
    const falha = new Error('x');
    comGetter(falha, 'code', () => { leituras += 1; return leituras === 1 ? MOTIVO_NAO_INICIADO : MOTIVO_INCONCLUSIVO; });
    const { r } = await rejeitandoCom(falha);
    assert.ok(leituras <= 1, `lido ${leituras} vezes`);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU', MOTIVO_NAO_INICIADO]);
  });

  teste('DIA-04c — CONTROLE: um getter de `code` que LANÇA com mensagem sensível: o supervisor não propaga a exceção, não vaza, e o resultado é o histórico [INICIO_FALHOU]', async () => {
    const falha = new Error('x');
    comGetter(falha, 'code', () => { throw new Error(`${SEGREDO} ${HOST}`); });
    const { r } = await rejeitandoCom(falha);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
    assert.equal(r.saida, SAIDA.INICIO);
    assert.equal(r.liberarTravaPermitido, false);
    semMarcadores(r, 'resultado');
  });

  teste('DIA-04d — CONTROLE: um objeto hostil (Proxy cujo `get` lança) como rejeição não converte a falha em sucesso nem vaza', async () => {
    const hostil = new Proxy(new Error('x'), { get() { throw new Error(`${SEGREDO} ${HOST}`); } });
    const { r, m } = await rejeitandoCom(hostil);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
    assert.equal(r.saida, SAIDA.INICIO);
    assert.equal(r.concluido, false);
    assert.equal(r.liberarTravaPermitido, false);
    assert.deepEqual(m.contagem.sinais, []);
    semMarcadores(r, 'resultado');
  });

  teste('DIA-04e — todos os motivos públicos são códigos fixos (em todos os casos, reconhecidos ou não)', async () => {
    for (const valor of [erroComCodigo(MOTIVO_NAO_INICIADO), erroComCodigo(MOTIVO_INCONCLUSIVO), erroComCodigo('ENOENT'), new Error(`${SEGREDO}`)]) {
      const { r } = await rejeitandoCom(valor);
      for (const motivo of r.motivos) assert.match(motivo, MOTIVOS_FIXOS);
      semMarcadores(r, 'resultado');
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- DIA-05
describe('[DIA-05] compatibilidade: a extensão não cria campos novos nem muda resultados de sucesso, sinais, prazos ou PGID', () => {
  teste('DIA-05 — CONTROLE: o resultado de uma falha de início com código reconhecido tem EXATAMENTE as mesmas chaves públicas do resultado histórico (nenhum campo novo)', async () => {
    const { r: historico } = await rejeitandoCom(new Error('x'));
    const { r: reconhecido } = await rejeitandoCom(erroComCodigo(MOTIVO_NAO_INICIADO));
    assert.deepEqual(Object.keys(historico).sort(), CHAVES_DO_RESULTADO);
    assert.deepEqual(Object.keys(reconhecido).sort(), CHAVES_DO_RESULTADO);
  });

  teste('DIA-05b — CONTROLE: o resultado de SUCESSO continua sem motivo algum (nenhum diagnóstico de início aparece em quem iniciou)', async () => {
    const m = montarSupervisao({ pgid: PID });
    m.saida.resolver({ codigo: 0, sinal: null });
    m.fluxos.resolver();
    const r = await supervisor().supervisionar(m.opcoes);
    assert.equal(r.saida, SAIDA.CONCLUIDO);
    assert.deepEqual([...r.motivos], []);
    assert.equal(r.liberarTravaPermitido, true);
  });

  teste('DIA-05c — CONTROLE: PGID inválido sem rejeição (retorno com pgid 1) continua `[INICIO_FALHOU]` puro: o diagnóstico novo só existe com a rejeição e o código reconhecido', async () => {
    const m = montarSupervisao({ pgid: 1 });
    const r = await supervisor().supervisionar(m.opcoes);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- DIA-06
describe('[DIA-06] procedência: o código é INFORMATIVO, nunca prova nem dá privilégio', () => {
  teste('DIA-06 — um código `NAO_INICIADO` FALSIFICADO por uma função qualquer produz o mesmo diagnóstico informativo e NÃO muda nada de segurança: saída 1, trava não liberável, sem consulta de grupo, sem sinal (o código não é prova de que o processo não iniciou)', async () => {
    const { r, m } = await rejeitandoCom(Object.assign(new Error('forjado por um chamador arbitrário'), { code: MOTIVO_NAO_INICIADO }));
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU', MOTIVO_NAO_INICIADO]);
    assert.equal(r.saida, SAIDA.INICIO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.equal(r.concluido, false);
    assert.deepEqual(m.contagem.grupo, []);
    assert.deepEqual(m.contagem.sinais, []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- DIA-07 / 09
describe('[DIA-07/09] o diagnóstico chega ao operador sem mudar o coordenador, e funciona de ponta a ponta com o lançador e o serviço do dump reais', () => {
  teste('DIA-07 — pelo executor real: `resultado.supervisao.motivos` carrega o diagnóstico; trava RETIDA (11), finalização ADIADA, finalizar nunca chamada, liberar nunca, cópia e avaliação não rodam', async () => {
    const { executarBackupSupervisionado } = exigirModulo('src/services/imagem-backup-executor.service');
    for (const codigo of [MOTIVO_NAO_INICIADO, MOTIVO_INCONCLUSIVO]) {
      const estado = { documento: null, liberacoes: 0 };
      const contagem = { copia: 0, avaliar: 0, finalizar: 0 };
      const janela = {
        async adquirir(argumentos) {
          if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
          estado.documento = { tipo: argumentos.tipo, token: 'token-1' };
          return Object.freeze({
            tipo: argumentos.tipo,
            async confirmarPosse() { return { confirmada: estado.documento !== null }; },
            async liberar() { estado.liberacoes += 1; estado.documento = null; return { liberada: true }; },
          });
        },
      };
      const r = await executarBackupSupervisionado({
        janela,
        async snapshot() { return { ok: true }; },
        processoDoDump: () => ({
          async iniciar() { throw erroComCodigo(codigo); },
          grupo: { async vivos() { return false; } },
          sinais: { async enviar() { return true; } },
          temporizador: criarTemporizador(),
          prazos: { ...PRAZOS },
        }),
        async copia() { contagem.copia += 1; return { ok: true }; },
        avaliar() { contagem.avaliar += 1; return { valido: true, motivos: [] }; },
        async finalizar() { contagem.finalizar += 1; return { concluida: true }; },
      });
      assert.deepEqual([...r.supervisao.motivos], ['INICIO_FALHOU', codigo], codigo);
      assert.equal(r.saida, SAIDA.DESCONHECIDO, codigo);
      assert.equal(r.janela, 'RETIDA', codigo);
      assert.equal(r.finalizacao, 'ADIADA', codigo);
      assert.deepEqual(contagem, { copia: 0, avaliar: 0, finalizar: 0 }, codigo);
      assert.equal(estado.liberacoes, 0, codigo);
      assert.equal(r.supervisao.liberarTravaPermitido, false, codigo);
      assert.equal(r.recuperavel, false, codigo);
    }
  });

  async function descricaoDoServico(lancador, contagem) {
    const { criarProcessoDoDump } = exigirModulo('src/services/imagem-backup-pgdump.service');
    const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };
    const contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null });
    const dump = {
      alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: 'u', arquivoDeSenha: '/etc/safework/pgpass', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
      lancador,
      sistema: { async grupoVivo() { contagem.grupo += 1; return false; }, async enviarSinal() { contagem.sinal += 1; return true; } },
      arquivos: { async criarExclusivo() { return { descritor: DESCRITOR, fechar() { contagem.fechar += 1; } }; } },
      temporizador: criarTemporizador(),
      prazos: { ...PRAZOS },
    };
    return criarProcessoDoDump({ contexto, dump });
  }

  for (const [rotulo, montar, esperado] of [
    ['o `spawn` lança (falha comprovada)', () => ({ spawn: () => { throw erroComCodigo('ENOENT', `${SEGREDO} ${HOST}`); } }), MOTIVO_NAO_INICIADO],
    ['`spawn` com pid inválido (lançamento inconclusivo)', () => { const filho = criarFilho({ pid: 0 }); return { spawn: () => { queueMicrotask(() => filho.emitir('spawn')); return filho; }, filho }; }, MOTIVO_INCONCLUSIVO],
  ]) {
    teste(`DIA-09 (${rotulo}) — de ponta a ponta (lançador + serviço do dump + supervisor reais): motivos [INICIO_FALHOU, ${esperado}], trava não liberável, sem consulta de grupo nem sinal, o filho nunca é sinalizado, nada vaza`, async () => {
      const { criarLancadorComSpawn } = exigirModulo('src/services/imagem-backup-pgdump-lancador.service');
      const s = montar();
      const contagem = { grupo: 0, sinal: 0, fechar: 0 };
      const descricao = await descricaoDoServico(criarLancadorComSpawn({ spawn: s.spawn }), contagem);
      const r = await supervisor().supervisionar(descricao);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU', esperado]);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.equal(contagem.grupo + contagem.sinal, 0);
      if (s.filho) assert.equal(s.filho.killChamadas, 0);
      semMarcadores(r, 'resultado');
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências do diagnóstico
describe('[DIA-10] decisões e pendências do diagnóstico (registradas, NÃO executadas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('DIA-10a — PROCEDÊNCIA CONFIÁVEL: `error.code` pode ser falsificado por qualquer função que rejeite uma promessa; uma afirmação mais forte que "informativo" exige um mecanismo de procedência do erro do lançador (marca privada compartilhada, ou canal estruturado no retorno), o que altera o contrato arquitetural e não é imposto nestes testes', 'decisão arquitetural pendente');
  todo('DIA-10b — nenhum dos dois códigos autoriza liberar a trava, finalizar o snapshot ou sinalizar PID presumido; qualquer futura política de "não iniciado comprovado" precisa de procedência comprovada + decisão operacional (D1)', 'decisão operacional');
  // DIA-10c (atualização deliberada de SUP-LAN-05z, CTL-01, LAN-07 e LAN-07b) foi CONCLUÍDO; DIA-10d foi DECIDIDO (só instâncias de Error) e virou o teste DIA-03b.
});

describe('[DIA-03b] decisão: só instâncias de Error são reconhecidas (delimita o contrato; NÃO autentica o erro)', () => {
  teste('DIA-03b — objetos arbitrários, números e textos com `code` falsificado permanecem no diagnóstico genérico [INICIO_FALHOU]; nenhum motivo novo, nenhuma mudança de segurança', async () => {
    const arbitrarios = [
      { code: MOTIVO_NAO_INICIADO },
      { code: MOTIVO_INCONCLUSIVO, message: 'x' },
      Object.assign(Object.create(null), { code: MOTIVO_NAO_INICIADO }),
      Object.assign(() => {}, { code: MOTIVO_INCONCLUSIVO }),
      Object.assign(new String('x'), { code: MOTIVO_NAO_INICIADO }),
      MOTIVO_NAO_INICIADO,
      7,
    ];
    for (const valor of arbitrarios) {
      const { r, m } = await rejeitandoCom(valor);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU']);
      assert.equal(r.saida, SAIDA.INICIO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.deepEqual(m.contagem.grupo, []);
      assert.deepEqual(m.contagem.sinais, []);
    }
  });
});
