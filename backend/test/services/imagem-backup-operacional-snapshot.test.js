'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');
const { SAIDAS } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-OP-SNAP-BIND-1): ENTRADA OPERACIONAL que VINCULA o ciclo de vida do snapshot ao executor
 * supervisionado. Só unitário e em memória: o cliente PostgreSQL, a trava, o processo do dump, os sinais e os relógios são falsos; nenhum banco,
 * pg_dump, pg_restore, processo ou disco reais. Sincronização por promessas controladas; cada teste tem prazo próprio.
 *
 * INTERFACE PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado nesta fase):
 *   src/services/imagem-backup-operacional.service.js exporta `executarBackupOperacional(dependencias)` -> Promise<resultado>
 *   dependencias = {            (objeto ESTRITO: qualquer outra chave é recusada ANTES da trava, com saída 2)
 *     janela:          { adquirir({ tipo }) }                       a trava (o mesmo contrato do coordenador)
 *     conexao:         { criarConexao, temporizador, prazos: { finalizacaoMs }, tamanhoDaPagina?, planejar? }
 *                                                                   SÓ a infraestrutura do snapshot (também estrita); NUNCA um snapshot pronto
 *     processoDoDump:  (contexto) => opcoes do supervisor           `contexto` = o do snapshot aberto (snapshotId, banco, registros, plano)
 *     copia:           async (contexto) => ({ ok: true, ... })
 *     avaliar:         (resultados) => ({ valido, motivos })
 *     parada (opcional): { aoPedir(funcao) }
 *   }
 *   O módulo importa `criarSnapshot`, `executarBackupSupervisionado` e o supervisor REAIS; cria UMA instância de snapshot por operação (só depois de
 *   a validação passar e SÓ DEPOIS da trava: a conexão não é criada antes), e monta ele mesmo a etapa `snapshot` (= `abrir()` dessa instância) e a
 *   `finalizar` (= `finalizar()` da MESMA instância). O chamador não pode fornecer `snapshot`, `finalizar`, `criarSnapshot`, `supervisionar`, `etapas`
 *   nem `abrir`: essas chaves são recusadas (saída 2, sem efeito). A finalização é SEMPRE ligada: não existe caminho com a trava adquirida sem ela.
 *   Resultado = o do executor supervisionado; `recuperavel` é SEMPRE false.
 *   LIMITE HONESTO: o vínculo é do CICLO DE VIDA (a mesma instância abre e finaliza; nada mais pode fechar nem substituir). Quem entrega `criarConexao`
 *   ainda é o chamador (infraestrutura): este módulo não prova que a conexão é um PostgreSQL de verdade.
 *
 * DECISÕES ADOTADAS NO RED-2 (OP-SNAP-BIND-2; especificadas aqui, NADA implementado em produção):
 *   1. Pool/objeto recusado pela fábrica: resultado inválido e trava RETIDA (encerramento não comprovável); nenhuma recuperação automática.
 *   2. Posse perdida: nunca se libera trava alheia; os recursos locais só são encerrados se a supervisão do dump permitir.
 *   3. `criarConexao` segue injetada e controlada nos testes: NÃO é autenticação do banco de destino (fábrica operacional interna: pendente).
 *   4. `processoDoDump(contexto)` e `copia(contexto)` recebem o MESMO contexto validado do snapshot desta instância.
 *   5. O executor provisório não muda; a entrada operacional exige a finalização (sempre ligada).
 *   6. OPCIONAIS com `undefined` explícito (`tamanhoDaPagina`, `planejar`, `parada`): NÃO testados como inválidos nem como válidos (o criarSnapshot
 *      trata `undefined` como ausente, mas `null` como inválido; a regra da entrada operacional fica como decisão pendente).
 *   7. GETTER HOSTIL que lança: só se exige a segurança (nenhuma trava, nenhuma conexão); se o resultado é saída 2 ou rejeição é DECISÃO PENDENTE.
 *   8. O resultado público NÃO expõe códigos de erro do banco (só `motivos` fixos); expô-los seria extensão do contrato, não testada.
 *   9. Limite de página: a regra do criarSnapshot (1 a 1000) é espelhada por acoplamento consciente.
 * COMO LER ESTES TESTES NESTA FASE: o módulo operacional NÃO existe; os cenários OP-* falham TODOS pela mesma causa (módulo ausente) e, sozinhos, não
 * provam comportamento. A validade das expectativas é conferida por uma simulação em memória (fora deste arquivo), e os controles CTL-* passam hoje:
 * mostram que as fixtures são válidas (componentes reais) e caracterizam a lacuna do executor provisório que justifica a entrada operacional.
 */

const OPERACIONAL = 'src/services/imagem-backup-operacional.service';
const operacional = () => exigirModulo(OPERACIONAL);
const SNAPSHOT = 'src/services/imagem-backup-snapshot.service';
const EXECUTOR = 'src/services/imagem-backup-executor.service';
const PGID = 5150;
const PRAZO_DO_TESTE = 10000;
const ID_SNAPSHOT = '00000003-0000001B-1';
const SHA = 'a'.repeat(64);
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const SINAL_SIGINT = 130;

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);

function adiado() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((r, j) => { resolver = r; rejeitar = j; });
  return { promessa, resolver, rejeitar };
}

function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/^COMMIT\b/i.test(t)) return 'COMMIT';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}

const linhaPadrao = (id) => ({ id, sha256: SHA, sha256_miniatura: SHA, sha256_exibicao: null, formato: 'PNG', bytes_mestre: 10, bytes_miniatura: 5, bytes_exibicao: null });
const linhaEmpresa = (id) => ({ id, empresa_id: 7, sha256: SHA, sha256_mestre: SHA, sha256_exibicao: SHA, sha256_miniatura: SHA, formato: 'PNG', bytes_mestre: 10, bytes_exibicao: 8, bytes_miniatura: 5 });
const paginar = (linhas, [depoisDe, limite]) => linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);

/** Tudo o que o executor operacional toca, numa linha do tempo comum a trava, ao cliente, ao processo e às etapas. */
function criarMundo({
  termino = { codigo: 0, sinal: null }, vivos = false, terminoControlado = false, ocupada = false, iniciarFalha = null,
  respostas = {}, conectar = null, encerrar = null, fabrica = null,
} = {}) {
  const linha = [];
  const estado = { documento: ocupada ? { tipo: TIPOS.LIMPEZA, token: 'token-alheio' } : null, liberacoes: 0, aquisicoes: 0 };
  const saida = adiado();
  if (!terminoControlado) saida.resolver(termino);
  const dumpIniciado = adiado();
  const copiaIniciada = adiado();
  const paradaPronta = adiado();
  const ouvintes = [];
  const clientes = [];
  const contagem = { criarConexao: 0, processoDoDump: 0, copia: 0, avaliar: 0 };
  const recebidos = { dump: [], copia: [] };
  let proximoToken = 0;

  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push('adquirir');
      if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      proximoToken += 1;
      const token = `token-${proximoToken}`;
      estado.documento = { tipo: argumentos.tipo, token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { linha.push('confirmarPosse'); return { confirmada: estado.documento !== null && estado.documento.token === token }; },
        async liberar() {
          estado.liberacoes += 1;
          linha.push('liberar');
          if (estado.documento === null || estado.documento.token !== token) return { liberada: false };
          estado.documento = null;
          return { liberada: true };
        },
      });
    },
  };

  function criarCliente() {
    const indiceDoCliente = clientes.length;
    const c = {
      indice: indiceDoCliente,
      log: [],
      ouvintes: { error: [], end: [] },
      async connect() { c.log.push('connect'); linha.push('sql:connect'); if (conectar) return conectar(c); return undefined; },
      async query(sql, parametros) {
        const tipo = tipoDe(sql);
        c.log.push(tipo);
        linha.push(`sql:${tipo}`);
        if (respostas[tipo]) return respostas[tipo](sql, parametros, c);
        switch (tipo) {
          case 'EXPORTAR': return { rows: [{ snapshot_id: ID_SNAPSHOT }] };
          case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
          case 'PADRAO': return { rows: paginar([linhaPadrao('1')], parametros) };
          case 'EMPRESA': return { rows: paginar([linhaEmpresa('5')], parametros) };
          default: return { rows: [] };
        }
      },
      async end() {
        c.log.push('end');
        linha.push('sql:end');
        if (encerrar) return encerrar(c);
        for (const f of c.ouvintes.end) f();
        return undefined;
      },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    clientes.push(c);
    return c;
  }

  const temporizadorDoSnapshot = {
    prazos: [],
    prazo(ms) {
      const d = adiado();
      const registro = { ms, cancelado: false, vencer: () => d.resolver() };
      temporizadorDoSnapshot.prazos.push(registro);
      return { promessa: d.promessa, cancelar: () => { registro.cancelado = true; } };
    },
  };

  const parada = {
    aoPedir(f) { ouvintes.push(f); if (ouvintes.length >= 2) paradaPronta.resolver(); },
  };
  const pedirParada = (sinal) => { for (const f of ouvintes) f(sinal); };

  const opcoesDoProcesso = () => ({
    async iniciar() {
      linha.push('dump:iniciar');
      dumpIniciado.resolver();
      if (iniciarFalha) throw iniciarFalha;
      return { pgid: PGID, saida: saida.promessa, fluxosFechados: saida.promessa.then(() => undefined) };
    },
    grupo: { async vivos() { linha.push('dump:grupo.vivos'); return vivos; } },
    sinais: { async enviar(pgid, sinal) { linha.push(`dump:sinal:${sinal}`); return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
  });

  const dependencias = {
    janela,
    conexao: {
      criarConexao: fabrica ?? (() => { contagem.criarConexao += 1; linha.push('criarConexao'); return criarCliente(); }),
      temporizador: temporizadorDoSnapshot,
      prazos: { finalizacaoMs: 5000 },
    },
    processoDoDump(contexto) { contagem.processoDoDump += 1; recebidos.dump.push(contexto); linha.push('processoDoDump'); return opcoesDoProcesso(); },
    async copia(contexto) { contagem.copia += 1; recebidos.copia.push(contexto); linha.push('copia'); copiaIniciada.resolver(); return { ok: true }; },
    avaliar() { contagem.avaliar += 1; linha.push('avaliar'); return { valido: true, motivos: [] }; },
  };

  return {
    linha, estado, clientes, contagem, recebidos, dependencias, parada, pedirParada, ouvintes, paradaPronta, dumpIniciado, copiaIniciada,
    temporizadorDoSnapshot, opcoesDoProcesso, criarCliente,
    terminar: (t) => { linha.push('dump:termino'); saida.resolver(t); },
  };
}

const indice = (linha, evento) => linha.indexOf(evento);
const antes = (linha, a, b) => indice(linha, a) !== -1 && indice(linha, b) !== -1 && indice(linha, a) < indice(linha, b);
const contar = (lista, item) => lista.filter((x) => x === item).length;
const executar = (m) => operacional().executarBackupOperacional(m.dependencias);

async function ate(evento, pendente, rotulo) {
  const quem = await Promise.race([evento.then(() => 'evento'), pendente.then(() => 'terminou', () => 'terminou')]);
  assert.equal(quem, 'evento', `a execução terminou antes de: ${rotulo}`);
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: fixtures válidas e a lacuna do executor provisório', () => {
  const montarManual = (m, { finalizarDe = null } = {}) => {
    const { criarSnapshot } = exigirModulo(SNAPSHOT);
    const instancia = criarSnapshot({ criarConexao: m.dependencias.conexao.criarConexao, temporizador: m.temporizadorDoSnapshot, prazos: { finalizacaoMs: 5000 } });
    let contexto = null;
    const dependencias = {
      janela: m.dependencias.janela,
      async snapshot() { const r = await instancia.abrir(); if (r.ok) contexto = r.contexto; return { ok: r.ok === true }; },
      processoDoDump: () => m.dependencias.processoDoDump(contexto),
      copia: () => m.dependencias.copia(contexto),
      avaliar: m.dependencias.avaliar,
    };
    if (finalizarDe !== 'nenhuma') dependencias.finalizar = (finalizarDe ?? instancia).finalizar;
    return { instancia, dependencias };
  };

  teste('CTL-01 — composição MANUAL correta (mesma instância): a fixture é válida com os componentes reais e o ciclo fecha na ordem esperada', async () => {
    const m = criarMundo();
    const { dependencias } = montarManual(m);
    const r = await exigirModulo(EXECUTOR).executarBackupSupervisionado(dependencias);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(m.clientes.length, 1);
    assert.deepEqual(m.clientes[0].log.filter((x) => ['connect', 'BEGIN', 'EXPORTAR', 'ROLLBACK', 'end'].includes(x)), ['connect', 'BEGIN', 'EXPORTAR', 'ROLLBACK', 'end']);
    assert.ok(antes(m.linha, 'dump:iniciar', 'sql:ROLLBACK'));
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(m.recebidos.dump[0].snapshotId, ID_SNAPSHOT);
  });

  teste('CTL-02 — LACUNA do executor provisório: sem `finalizar` ele conclui com saída 0 e a transação do snapshot NUNCA é encerrada (nenhum ROLLBACK, nenhum end)', async () => {
    const m = criarMundo();
    const { dependencias } = montarManual(m, { finalizarDe: 'nenhuma' });
    const r = await exigirModulo(EXECUTOR).executarBackupSupervisionado(dependencias);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0);
    assert.equal(contar(m.clientes[0].log, 'end'), 0);
    assert.equal(m.estado.liberacoes, 1, 'e a trava é solta com a transação ainda aberta');
  });

  teste('CTL-03 — LACUNA do executor provisório: uma `finalizar` de OUTRA instância é aceita; a transação aberta fica sem ROLLBACK e o resultado é saída 0', async () => {
    const m = criarMundo();
    const { criarSnapshot } = exigirModulo(SNAPSHOT);
    const outra = criarSnapshot({ criarConexao: () => m.criarCliente(), temporizador: m.temporizadorDoSnapshot, prazos: { finalizacaoMs: 5000 } });
    const { dependencias } = montarManual(m, { finalizarDe: outra });
    const r = await exigirModulo(EXECUTOR).executarBackupSupervisionado(dependencias);
    assert.equal(r.saida, SAIDAS.VALIDO, 'o executor provisório não percebe a incompatibilidade');
    assert.equal(r.finalizacao, 'CONCLUIDA', 'a outra instância (nada criado) "conclui"');
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0, 'a transação do snapshot que o dump usou nunca foi encerrada');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-01
describe('[OP-SNAP-01] identidade única: a mesma instância abre e finaliza', () => {
  teste('OP-SNAP-01 — uma só conexão por operação; o MESMO cliente recebe connect, BEGIN, exportação, ROLLBACK e end; dump e cópia recebem o contexto desse snapshot', async () => {
    const m = criarMundo();
    const r = await executar(m);
    assert.equal(m.contagem.criarConexao, 1, 'exatamente uma instância/conexão');
    assert.equal(m.clientes.length, 1);
    const log = m.clientes[0].log;
    assert.deepEqual(log.filter((x) => ['connect', 'BEGIN', 'EXPORTAR', 'ROLLBACK', 'end'].includes(x)), ['connect', 'BEGIN', 'EXPORTAR', 'ROLLBACK', 'end']);
    assert.equal(contar(log, 'ROLLBACK'), 1);
    assert.equal(contar(log, 'end'), 1);
    assert.equal(m.recebidos.dump.length, 1);
    assert.equal(m.recebidos.dump[0].snapshotId, ID_SNAPSHOT);
    assert.equal(m.recebidos.dump[0].banco.nome, 'gestao_epi');
    assert.equal(m.recebidos.copia[0], m.recebidos.dump[0], 'cópia e dump recebem o MESMO contexto do snapshot aberto');
    assert.equal(Object.isFrozen(m.recebidos.dump[0]), true);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.janela, 'LIBERADA');
  });

  teste('OP-SNAP-01b — duas operações em sequência usam instâncias DISTINTAS: cada uma encerra a sua própria transação, nenhuma reaproveita a anterior', async () => {
    const m = criarMundo();
    const a = await executar(m);
    const b = await executar(m);
    assert.equal(a.saida, SAIDAS.VALIDO);
    assert.equal(b.saida, SAIDAS.VALIDO);
    assert.equal(m.clientes.length, 2);
    for (const c of m.clientes) {
      assert.equal(contar(c.log, 'BEGIN'), 1);
      assert.equal(contar(c.log, 'ROLLBACK'), 1);
      assert.equal(contar(c.log, 'end'), 1);
    }
  });

  teste('OP-SNAP-01c — a conexão só é criada DEPOIS de a trava ser adquirida e a posse confirmada', async () => {
    const m = criarMundo();
    await executar(m);
    assert.ok(antes(m.linha, 'adquirir', 'criarConexao'));
    assert.ok(antes(m.linha, 'confirmarPosse', 'criarConexao'));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-02
describe('[OP-SNAP-02] finalização obrigatória: sem trava adquirida, nada; com trava, SEMPRE finalizada antes de liberar', () => {
  const caminhos = [
    ['sucesso', () => ({ }), SAIDAS.VALIDO],
    ['abertura falha (BEGIN)', () => ({ respostas: { BEGIN: async () => { throw Object.assign(new Error('x'), { code: '40001' }); } } }), SAIDAS.INVALIDO],
    ['dump termina com falha comprovada', () => ({ termino: { codigo: 1, sinal: null } }), SAIDAS.INVALIDO],
  ];
  for (const [rotulo, opcoes, saidaEsperada] of caminhos) {
    teste(`OP-SNAP-02 (${rotulo}) — ROLLBACK e end exatamente uma vez no cliente da operação, antes de liberar; finalizacao CONCLUIDA`, async () => {
      const m = criarMundo(opcoes());
      const r = await executar(m);
      assert.equal(m.clientes.length, 1);
      assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
      assert.equal(contar(m.clientes[0].log, 'end'), 1);
      assert.ok(antes(m.linha, 'sql:ROLLBACK', 'sql:end'));
      assert.ok(antes(m.linha, 'sql:end', 'liberar'));
      assert.equal(r.finalizacao, 'CONCLUIDA');
      assert.equal(r.saida, saidaEsperada);
      assert.equal(r.recuperavel, false);
    });
  }

  teste('OP-SNAP-02b — cópia que falha e avaliação que lança também finalizam antes de liberar', async () => {
    for (const [rotulo, ajustar] of [
      ['cópia falha', (m) => { m.dependencias.copia = async () => ({ ok: false }); }],
      ['avaliação lança', (m) => { m.dependencias.avaliar = () => { throw new Error('avaliação simulada'); }; }],
    ]) {
      const m = criarMundo();
      ajustar(m);
      const r = await executar(m);
      assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1, rotulo);
      assert.equal(contar(m.clientes[0].log, 'end'), 1, rotulo);
      assert.ok(antes(m.linha, 'sql:end', 'liberar'), rotulo);
      assert.equal(r.finalizacao, 'CONCLUIDA', rotulo);
      assert.equal(r.valido, false, rotulo);
    }
  });

  teste('OP-SNAP-02c — trava OCUPADA: nenhuma conexão é criada, nada é aberto nem finalizado, finalizacao NAO_APLICAVEL, saída 6', async () => {
    const m = criarMundo({ ocupada: true });
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.JANELA_OCUPADA);
    assert.equal(m.contagem.criarConexao, 0);
    assert.equal(m.clientes.length, 0);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(m.contagem.processoDoDump + m.contagem.copia, 0);
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('OP-SNAP-02d — erro na aquisição da trava: nenhuma conexão criada, finalizacao NAO_APLICAVEL, saída ERRO', async () => {
    const m = criarMundo();
    m.dependencias.janela = { async adquirir() { throw new Error('falha simulada'); } };
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.ERRO);
    assert.equal(m.contagem.criarConexao, 0);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-03
describe('[OP-SNAP-03] o chamador não substitui o ciclo de vida confiável', () => {
  const alheia = () => async () => ({ concluida: true });
  const extras = [
    ['snapshot no topo', { snapshot: async () => ({ ok: true }) }],
    ['finalizar no topo', { finalizar: alheia() }],
    ['finalizar undefined no topo', { finalizar: undefined }],
    ['abrir no topo', { abrir: async () => ({ ok: true }) }],
    ['criarSnapshot no topo', { criarSnapshot: () => ({}) }],
    ['supervisionar no topo', { supervisionar: async () => ({ concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] }) }],
    ['etapas no topo', { etapas: [] }],
  ];
  for (const [rotulo, extra] of extras) {
    teste(`OP-SNAP-03 (${rotulo}) — saída 2 antes da trava: nada adquirido, nenhuma conexão, nenhum efeito`, async () => {
      const m = criarMundo();
      const r = await operacional().executarBackupOperacional({ ...m.dependencias, ...extra });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.criarConexao, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  const dentro = [
    ['snapshot dentro de conexao', { snapshot: async () => ({ ok: true }) }],
    ['finalizar dentro de conexao', { finalizar: alheia() }],
    ['abrir dentro de conexao', { abrir: async () => ({ ok: true }) }],
    ['criarSnapshot dentro de conexao', { criarSnapshot: () => ({}) }],
    ['chave desconhecida em conexao', { qualquerCoisa: 1 }],
  ];
  for (const [rotulo, extra] of dentro) {
    teste(`OP-SNAP-03b (${rotulo}) — saída 2 antes da trava, sem efeito`, async () => {
      const m = criarMundo();
      const r = await operacional().executarBackupOperacional({ ...m.dependencias, conexao: { ...m.dependencias.conexao, ...extra } });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  const invalidas = [
    ['conexao ausente', (d) => { delete d.conexao; }],
    ['conexao nula', (d) => { d.conexao = null; }],
    ['criarConexao não é função', (d) => { d.conexao = { ...d.conexao, criarConexao: 'x' }; }],
    ['temporizador inválido', (d) => { d.conexao = { ...d.conexao, temporizador: {} }; }],
    ['prazo de finalização inválido', (d) => { d.conexao = { ...d.conexao, prazos: { finalizacaoMs: 0 } }; }],
    ['janela inválida', (d) => { d.janela = {}; }],
    ['processoDoDump não é função', (d) => { d.processoDoDump = null; }],
    ['copia não é função', (d) => { d.copia = null; }],
    ['avaliar não é função', (d) => { d.avaliar = null; }],
  ];
  for (const [rotulo, ajustar] of invalidas) {
    teste(`OP-SNAP-03c (${rotulo}) — dependência inválida: saída 2 antes da trava (nenhum TypeError escapa), sem efeito`, async () => {
      const m = criarMundo();
      const d = { ...m.dependencias };
      ajustar(d);
      const r = await operacional().executarBackupOperacional(d);
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.linha.length, 0);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-04
describe('[OP-SNAP-04] ordem: aberto antes do dump, vivo enquanto o dump e a cópia precisam dele, finalizado só no momento permitido', () => {
  teste('OP-SNAP-04 — no início do dump a transação está aberta e a snapshot exportada; durante o dump e a cópia NÃO há ROLLBACK nem end; só depois da avaliação', async () => {
    const m = criarMundo({ terminoControlado: true });
    const copia = adiado();
    m.dependencias.copia = async (contexto) => { m.contagem.copia += 1; m.recebidos.copia.push(contexto); m.linha.push('copia'); m.copiaIniciada.resolver(); await copia.promessa; m.linha.push('copia:fim'); return { ok: true }; };
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    assert.ok(antes(m.linha, 'sql:BEGIN', 'sql:EXPORTAR'));
    assert.ok(antes(m.linha, 'sql:EXPORTAR', 'processoDoDump'));
    assert.ok(antes(m.linha, 'processoDoDump', 'dump:iniciar'));
    assert.equal(m.linha.includes('sql:ROLLBACK') || m.linha.includes('sql:end'), false, 'dump em andamento: a transação segue aberta');
    m.terminar({ codigo: 0, sinal: null });
    await ate(m.copiaIniciada.promessa, pendente, 'a cópia iniciar');
    assert.equal(m.linha.includes('sql:ROLLBACK') || m.linha.includes('sql:end'), false, 'cópia em andamento: a transação segue aberta');
    copia.resolver();
    const r = await pendente;
    for (const [a, b] of [['dump:termino', 'copia'], ['copia:fim', 'avaliar'], ['avaliar', 'sql:ROLLBACK'], ['sql:ROLLBACK', 'sql:end'], ['sql:end', 'liberar']]) {
      assert.ok(antes(m.linha, a, b), `${a} antes de ${b}`);
    }
    assert.equal(r.saida, SAIDAS.VALIDO);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-05
describe('[OP-SNAP-05] falha de abertura: dump e cópia nunca iniciam, os recursos adquiridos são finalizados', () => {
  const erro = (codigo) => Object.assign(new Error('falha simulada'), { code: codigo });
  const casos = [
    { rotulo: 'connect falha', opcoes: () => ({ conectar: async () => { throw erro('ECONNREFUSED'); } }), rollback: 0, end: 1 },
    { rotulo: 'BEGIN falha', opcoes: () => ({ respostas: { BEGIN: async () => { throw erro('40001'); } } }), rollback: 1, end: 1 },
    { rotulo: 'exportação da snapshot falha', opcoes: () => ({ respostas: { EXPORTAR: async () => { throw erro('XX000'); } } }), rollback: 1, end: 1 },
    { rotulo: 'snapshot com formato inválido', opcoes: () => ({ respostas: { EXPORTAR: async () => ({ rows: [{ snapshot_id: 'invalido' }] }) } }), rollback: 1, end: 1 },
  ];
  for (const caso of casos) {
    teste(`OP-SNAP-05 (${caso.rotulo}) — nenhum processo do dump, nenhuma cópia, nenhuma avaliação; ROLLBACK ${caso.rollback}× e end 1× antes de liberar; saída 9`, async () => {
      const m = criarMundo(caso.opcoes());
      const r = await executar(m);
      assert.equal(m.contagem.processoDoDump, 0);
      assert.equal(m.linha.includes('dump:iniciar'), false);
      assert.equal(m.contagem.copia, 0);
      assert.equal(m.contagem.avaliar, 0);
      assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), caso.rollback);
      assert.equal(contar(m.clientes[0].log, 'end'), caso.end);
      assert.ok(antes(m.linha, 'sql:end', 'liberar'));
      assert.deepEqual([...r.etapasExecutadas], ['snapshot']);
      assert.equal(r.finalizacao, 'CONCLUIDA');
      assert.equal(r.saida, SAIDAS.INVALIDO);
      assert.equal(r.valido, false);
      assert.equal(r.janela, 'LIBERADA');
      assert.equal(r.recuperavel, false);
    });
  }

  teste('OP-SNAP-05b — a fábrica de conexão lança: nada a encerrar, finalização concluída, dump e cópia não iniciam, saída 9', async () => {
    const m = criarMundo({ fabrica: () => { throw new Error('fábrica indisponível'); } });
    const r = await executar(m);
    assert.equal(m.contagem.processoDoDump + m.contagem.copia, 0);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.saida, SAIDAS.INVALIDO);
    assert.equal(r.janela, 'LIBERADA');
  });

  teste('OP-SNAP-05c — a fábrica devolve um objeto com forma de POOL: ele é recusado sem ser tocado; como o encerramento não pode ser comprovado, a trava fica RETIDA (11) e dump e cópia não iniciam', async () => {
    const pool = { tocado: 0, connect() { pool.tocado += 1; }, query() { pool.tocado += 1; }, end() { pool.tocado += 1; }, on() { pool.tocado += 1; }, release() {}, totalCount: 1 };
    const m = criarMundo({ fabrica: () => pool });
    const r = await executar(m);
    assert.equal(pool.tocado, 0, 'o pool não é tocado');
    assert.equal(m.contagem.processoDoDump + m.contagem.copia, 0);
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(r.valido, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-06 / 07
describe('[OP-SNAP-06/07] dump: encerramento seguro finaliza; processo possivelmente ativo adia', () => {
  teste('OP-SNAP-06 — dump termina com falha COMPROVADA (código 1): cópia não roda; a finalização acontece depois do término do dump; nunca vira sucesso', async () => {
    const m = criarMundo({ termino: { codigo: 1, sinal: null } });
    const r = await executar(m);
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.avaliar, 0);
    assert.ok(antes(m.linha, 'dump:iniciar', 'sql:ROLLBACK'));
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.saida, SAIDAS.INVALIDO);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(r.janela, 'LIBERADA');
  });

  teste('OP-SNAP-07 — grupo do dump possivelmente VIVO: a transação do snapshot NÃO é encerrada (nenhum ROLLBACK nem end), finalização ADIADA, trava RETIDA (11), cópia não roda', async () => {
    const m = criarMundo({ vivos: true });
    const r = await executar(m);
    assert.ok(m.linha.includes('dump:grupo.vivos'), 'quem decidiu foi o supervisor real');
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0, 'o dump vivo ainda pode depender da snapshot exportada');
    assert.equal(contar(m.clientes[0].log, 'end'), 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('OP-SNAP-07b — o processo do dump não pôde ser iniciado: supervisão não autoriza liberar, nenhuma finalização, trava RETIDA', async () => {
    const m = criarMundo({ iniciarFalha: Object.assign(new Error('spawn falhou'), { code: 'ENOENT' }) });
    const r = await executar(m);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0);
    assert.equal(contar(m.clientes[0].log, 'end'), 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.copia, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-08
describe('[OP-SNAP-08] finalização que falha, lança ou não se comprova: nunca sucesso, nunca liberar', () => {
  const erro = (codigo) => Object.assign(new Error('falha simulada'), { code: codigo });
  const casos = [
    ['ROLLBACK lança', { respostas: { ROLLBACK: async () => { throw erro('08006'); } } }],
    ['end lança', { encerrar: async () => { throw erro('ECONNRESET'); } }],
  ];
  for (const [rotulo, opcoes] of casos) {
    teste(`OP-SNAP-08 (${rotulo}) — NAO_CONCLUIDA, trava RETIDA (11), liberar nunca chamado, backup nunca válido`, async () => {
      const m = criarMundo(opcoes);
      const r = await executar(m);
      assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
      assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'));
      assert.equal(r.valido, false);
      assert.notEqual(r.saida, SAIDAS.VALIDO);
      assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
      assert.equal(r.janela, 'RETIDA');
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(m.linha.includes('liberar'), false);
      assert.equal(r.recuperavel, false);
    });
  }

  teste('OP-SNAP-08b — conexão PERDIDA durante a operação (evento end inesperado): a finalização não é comprovada, trava RETIDA, nunca válido', async () => {
    const m = criarMundo();
    m.dependencias.copia = async (contexto) => {
      m.contagem.copia += 1; m.recebidos.copia.push(contexto); m.linha.push('copia');
      for (const f of m.clientes[0].ouvintes.end) f();
      return { ok: true };
    };
    const r = await executar(m);
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
    assert.equal(r.valido, false);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('OP-SNAP-08c — prazo da finalização ESGOTADO com o ROLLBACK pendente: end() nunca é chamado, NAO_CONCLUIDA, trava RETIDA; o pendente não é tratado como feito', async () => {
    const rollback = adiado();
    const rollbackIniciado = adiado();
    const m = criarMundo({ respostas: { ROLLBACK: () => { rollbackIniciado.resolver(); return rollback.promessa; } } });
    const pendente = executar(m);
    await ate(rollbackIniciado.promessa, pendente, 'o ROLLBACK começar');
    const prazo = m.temporizadorDoSnapshot.prazos.at(-1);
    assert.equal(prazo.ms, 5000);
    prazo.vencer();
    const r = await pendente;
    rollback.resolver({ rows: [] });
    assert.equal(prazo.cancelado, true, 'o prazo criado é cancelado ao fim da finalização');
    assert.equal(contar(m.clientes[0].log, 'end'), 0, 'nada novo depois do prazo');
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(r.valido, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-09
describe('[OP-SNAP-09] parada, perda de posse e interrupções preservam as regras do coordenador', () => {
  teste('OP-SNAP-09a — SIGINT DURANTE A ABERTURA do snapshot: nenhum dump, a transação é encerrada antes de liberar, saída 130', async () => {
    const m = criarMundo({ respostas: { EXPORTAR: async () => ({ rows: [{ snapshot_id: ID_SNAPSHOT }] }) } });
    m.dependencias.parada = m.parada;
    const original = m.dependencias.conexao.criarConexao;
    m.dependencias.conexao = { ...m.dependencias.conexao, criarConexao: () => { const c = original(); const q = c.query; c.query = async (sql, p) => { const r = await q(sql, p); if (tipoDe(sql) === 'EXPORTAR') m.pedirParada('SIGINT'); return r; }; return c; } };
    const r = await executar(m);
    assert.equal(m.contagem.processoDoDump, 0);
    assert.equal(m.contagem.copia, 0);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.notEqual(r.saida, SAIDAS.VALIDO);
    assert.equal(r.saida, SINAL_SIGINT, 'SIGINT é a causa determinante: nenhuma etapa falhou');
  });

  teste('OP-SNAP-09b — SIGINT durante o dump com grupo VIVO: o supervisor recebe a parada; a transação NÃO é encerrada; finalização ADIADA; trava RETIDA', async () => {
    const m = criarMundo({ vivos: true, terminoControlado: true });
    m.dependencias.parada = m.parada;
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    await ate(m.paradaPronta.promessa, pendente, 'os ouvintes de parada');
    m.pedirParada('SIGINT');
    m.terminar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.supervisao.parada, 'SIGINT');
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0);
    assert.equal(contar(m.clientes[0].log, 'end'), 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.copia, 0);
  });

  teste('OP-SNAP-09c — SIGINT durante o dump com o grupo comprovadamente ENCERRADO: a transação é encerrada e só então a trava é solta; cópia não roda; nunca válido', async () => {
    const m = criarMundo({ vivos: false, terminoControlado: true });
    m.dependencias.parada = m.parada;
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    await ate(m.paradaPronta.promessa, pendente, 'os ouvintes de parada');
    m.pedirParada('SIGINT');
    m.terminar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(m.contagem.copia, 0);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('OP-SNAP-09d — SIGINT DURANTE a finalização (no ROLLBACK): é só anotado; a finalização não é repetida, nenhuma etapa nova, a trava só é solta depois; saída 130', async () => {
    const m = criarMundo();
    m.dependencias.parada = m.parada;
    const rollbackOriginal = { chamado: 0 };
    const base = m.dependencias.conexao.criarConexao;
    m.dependencias.conexao = { ...m.dependencias.conexao, criarConexao: () => { const c = base(); const q = c.query; c.query = async (sql, p) => { const r = await q(sql, p); if (tipoDe(sql) === 'ROLLBACK') { rollbackOriginal.chamado += 1; m.pedirParada('SIGINT'); } return r; }; return c; } };
    const r = await executar(m);
    assert.equal(rollbackOriginal.chamado, 1);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
    assert.deepEqual([...r.etapasExecutadas], ['snapshot', 'dump', 'copia']);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.valido, false);
    assert.equal(r.saida, SINAL_SIGINT);
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });

  teste('OP-SNAP-09e — posse da trava PERDIDA durante o dump: a avaliação não roda, liberar NUNCA é chamado (a trava é de outro), saída 10; a transação do snapshot ainda é encerrada pelo ciclo', async () => {
    const m = criarMundo({ terminoControlado: true });
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    m.estado.documento = { tipo: TIPOS.BACKUP, token: 'token-alheio' };
    m.terminar({ codigo: 0, sinal: null });
    const r = await pendente;
    assert.equal(m.contagem.avaliar, 0);
    assert.equal(m.estado.liberacoes, 0);
    assert.deepEqual(m.estado.documento, { tipo: TIPOS.BACKUP, token: 'token-alheio' });
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(r.saida, SAIDAS.JANELA_PERDIDA);
    assert.equal(r.valido, false);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-10
describe('[OP-SNAP-10] recuperabilidade', () => {
  teste('OP-SNAP-10 — `recuperavel` é false em TODOS os caminhos (sucesso, falha, retenção, ocupada, recusa), mesmo quando a avaliação devolve `recuperavel: true`', async () => {
    const cenarios = [
      ['sucesso', {}],
      ['dump falha', { termino: { codigo: 1, sinal: null } }],
      ['grupo vivo', { vivos: true }],
      ['trava ocupada', { ocupada: true }],
      ['abertura falha', { respostas: { BEGIN: async () => { throw new Error('x'); } } }],
      ['ROLLBACK falha', { respostas: { ROLLBACK: async () => { throw new Error('x'); } } }],
    ];
    for (const [rotulo, opcoes] of cenarios) {
      const m = criarMundo(opcoes);
      m.dependencias.avaliar = () => { m.contagem.avaliar += 1; return { valido: true, recuperavel: true, motivos: [] }; };
      const r = await executar(m);
      assert.equal(r.recuperavel, false, rotulo);
    }
    const recusa = await operacional().executarBackupOperacional({});
    assert.equal(recusa.recuperavel, false, 'recusa de argumentos');
    assert.equal(recusa.saida, SAIDAS.ARGUMENTOS);
  });
});

// =============================================================================================================================== RED-2
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const MARCADORES = [SEGREDO, 'usuario_secreto', 'db.interno.exemplo', 'postgres://', 'password'];

function erroSensivel(codigo = '28P01') {
  return Object.assign(new Error(`password authentication failed for user "usuario_secreto" password=${SEGREDO} host=db.interno.exemplo postgres://u:${SEGREDO}@h/db`), {
    code: codigo, detail: `detalhe ${SEGREDO}`, hint: 'password', where: 'db.interno.exemplo',
  });
}

function semMarcadores(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : (JSON.stringify(valor) ?? String(valor));
  for (const marcador of MARCADORES) assert.equal(texto.includes(marcador), false, `${rotulo}: não pode conter "${marcador}"`);
}

/** Espia SÓ os métodos de `console` (a saída do próprio executor de testes não passa por eles). */
async function comConsoleEspiado(fn) {
  const util = require('node:util');
  const metodos = ['log', 'error', 'warn', 'info', 'debug', 'trace'];
  const originais = {};
  const chamadas = [];
  for (const nome of metodos) {
    originais[nome] = console[nome];
    console[nome] = (...argumentos) => { chamadas.push(`${nome}: ${argumentos.map((a) => util.inspect(a, { depth: 4 })).join(' ')}`); };
  }
  try {
    return { resultado: await fn(), chamadas };
  } finally {
    for (const nome of metodos) console[nome] = originais[nome];
  }
}

const aoAdquirir = (m, acao) => {
  const original = m.dependencias.janela;
  m.dependencias.janela = { async adquirir(a) { acao(); return original.adquirir(a); } };
};

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-11
describe('[OP-SNAP-11] validação integral ANTES da trava: o que o criarSnapshot recusaria nunca chega a adquirir a trava', () => {
  const invalidosDaConexao = [
    ['tamanhoDaPagina zero', { tamanhoDaPagina: 0 }],
    ['tamanhoDaPagina negativo', { tamanhoDaPagina: -1 }],
    ['tamanhoDaPagina fracionário', { tamanhoDaPagina: 1.5 }],
    ['tamanhoDaPagina texto', { tamanhoDaPagina: '10' }],
    ['tamanhoDaPagina acima do máximo (1001)', { tamanhoDaPagina: 1001 }],
    ['tamanhoDaPagina NaN', { tamanhoDaPagina: Number.NaN }],
    ['tamanhoDaPagina nulo', { tamanhoDaPagina: null }],
    ['planejar nulo', { planejar: null }],
    ['planejar texto', { planejar: 'x' }],
    ['planejar objeto', { planejar: {} }],
    ['finalizacaoMs fracionário', { prazos: { finalizacaoMs: 1.5 } }],
    ['finalizacaoMs negativo', { prazos: { finalizacaoMs: -1 } }],
    ['finalizacaoMs texto', { prazos: { finalizacaoMs: '5000' } }],
    ['finalizacaoMs NaN', { prazos: { finalizacaoMs: Number.NaN } }],
    ['finalizacaoMs infinito', { prazos: { finalizacaoMs: Infinity } }],
    ['finalizacaoMs nulo', { prazos: { finalizacaoMs: null } }],
    ['prazos sem finalizacaoMs', { prazos: {} }],
    ['prazos lista', { prazos: [] }],
    ['prazos nulo', { prazos: null }],
    ['prazos texto', { prazos: '5000' }],
    ['temporizador.prazo não é função', { temporizador: { prazo: 'x' } }],
    ['temporizador nulo', { temporizador: null }],
    ['temporizador lista', { temporizador: [] }],
    ['conexao é lista', null],
  ];
  for (const [rotulo, extra] of invalidosDaConexao) {
    teste(`OP-SNAP-11 (${rotulo}) — saída 2 antes da trava: nenhuma aquisição, nenhuma conexão, nenhum efeito; nenhuma exceção escapa`, async () => {
      const m = criarMundo();
      const conexao = extra === null ? [] : { ...m.dependencias.conexao, ...extra };
      const r = await operacional().executarBackupOperacional({ ...m.dependencias, conexao });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.criarConexao, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  for (const [rotulo, parada] of [['texto', 'x'], ['objeto sem aoPedir', {}], ['aoPedir não é função', { aoPedir: 'x' }], ['lista', []], ['número', 1]]) {
    teste(`OP-SNAP-11b (parada ${rotulo}) — saída 2 antes da trava, sem efeito`, async () => {
      const m = criarMundo();
      const r = await operacional().executarBackupOperacional({ ...m.dependencias, parada });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.criarConexao, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  teste('OP-SNAP-11c — CONTROLE contra rigor excessivo: valores-limite VÁLIDOS (página 1 e 1000, planejar função, parada válida) são aceitos e a operação conclui com saída 0', async () => {
    for (const tamanhoDaPagina of [1, 1000]) {
      const m = criarMundo();
      const planejar = () => [];
      const r = await operacional().executarBackupOperacional({
        ...m.dependencias, parada: m.parada, conexao: { ...m.dependencias.conexao, tamanhoDaPagina, planejar },
      });
      assert.equal(r.saida, SAIDAS.VALIDO, `página ${tamanhoDaPagina}`);
      assert.equal(r.finalizacao, 'CONCLUIDA');
      assert.equal(m.contagem.criarConexao, 1);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-12
describe('[OP-SNAP-12] TOCTOU: a configuração validada é capturada; mudanças posteriores do chamador não a substituem', () => {
  const evilConexao = (m, contador) => () => { contador.n += 1; return m.criarCliente(); };
  const evilTemporizador = (contador) => ({ prazo() { contador.n += 1; return { promessa: new Promise(() => {}), cancelar() {} }; } });

  teste('OP-SNAP-12a — `criarConexao` trocada no próprio objeto depois da chamada: a original é a usada, a substituta nunca', async () => {
    const m = criarMundo();
    const evil = { n: 0 };
    aoAdquirir(m, () => { m.dependencias.conexao.criarConexao = evilConexao(m, evil); });
    const r = await executar(m);
    assert.equal(evil.n, 0);
    assert.equal(m.contagem.criarConexao, 1);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });

  teste('OP-SNAP-12b — o objeto `conexao` inteiro é trocado (fábrica, temporizador e prazos): nada do novo é usado', async () => {
    const m = criarMundo();
    const evil = { n: 0 };
    const evilT = { n: 0 };
    aoAdquirir(m, () => { m.dependencias.conexao = { criarConexao: evilConexao(m, evil), temporizador: evilTemporizador(evilT), prazos: { finalizacaoMs: 1 } }; });
    const r = await executar(m);
    assert.equal(evil.n, 0);
    assert.equal(evilT.n, 0);
    assert.equal(m.contagem.criarConexao, 1);
    assert.equal(m.temporizadorDoSnapshot.prazos.length, 1);
    assert.equal(m.temporizadorDoSnapshot.prazos[0].ms, 5000);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12c — `prazos.finalizacaoMs` alterado no lugar: a finalização usa o valor validado (5000)', async () => {
    const m = criarMundo();
    aoAdquirir(m, () => { m.dependencias.conexao.prazos.finalizacaoMs = 1; });
    const r = await executar(m);
    assert.equal(m.temporizadorDoSnapshot.prazos.at(-1).ms, 5000);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12d — o objeto `prazos` é substituído por outro (inclusive inválido): o validado continua valendo', async () => {
    const m = criarMundo();
    aoAdquirir(m, () => { m.dependencias.conexao.prazos = { finalizacaoMs: 'invalido' }; });
    const r = await executar(m);
    assert.equal(m.temporizadorDoSnapshot.prazos.at(-1).ms, 5000);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12e — o `temporizador` é trocado: o original é o usado na finalização, o novo nunca', async () => {
    const m = criarMundo();
    const evilT = { n: 0 };
    aoAdquirir(m, () => { m.dependencias.conexao.temporizador = evilTemporizador(evilT); });
    const r = await executar(m);
    assert.equal(evilT.n, 0);
    assert.equal(m.temporizadorDoSnapshot.prazos.length, 1);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12f — `processoDoDump`, `copia` e `avaliar` trocados depois da chamada: só as originais rodam, uma vez cada', async () => {
    const m = criarMundo();
    const evil = { dump: 0, copia: 0, avaliar: 0 };
    aoAdquirir(m, () => {
      m.dependencias.processoDoDump = () => { evil.dump += 1; return m.opcoesDoProcesso(); };
      m.dependencias.copia = async () => { evil.copia += 1; return { ok: true }; };
      m.dependencias.avaliar = () => { evil.avaliar += 1; return { valido: true, motivos: [] }; };
    });
    const r = await executar(m);
    assert.deepEqual(evil, { dump: 0, copia: 0, avaliar: 0 });
    assert.deepEqual([m.contagem.processoDoDump, m.contagem.copia, m.contagem.avaliar], [1, 1, 1]);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12g — `planejar` opcional trocado depois da chamada: o original produz o plano do contexto, o novo nunca é chamado', async () => {
    const m = criarMundo();
    const chamadas = { original: 0, evil: 0 };
    const plano = [{ chave: 'padrao/1.png', sha256: SHA }];
    m.dependencias.conexao.planejar = () => { chamadas.original += 1; return plano; };
    aoAdquirir(m, () => { m.dependencias.conexao.planejar = () => { chamadas.evil += 1; return []; }; });
    const r = await executar(m);
    assert.deepEqual(chamadas, { original: 1, evil: 0 });
    assert.deepEqual(m.recebidos.dump[0].plano, plano);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12h — `parada` opcional trocada depois da chamada: coordenador e supervisor usam a original; a nova nunca é consultada', async () => {
    const m = criarMundo();
    m.dependencias.parada = m.parada;
    const evil = { n: 0 };
    aoAdquirir(m, () => { m.dependencias.parada = { aoPedir() { evil.n += 1; } }; });
    const r = await executar(m);
    assert.equal(evil.n, 0);
    assert.ok(m.ouvintes.length >= 2, 'coordenador e supervisor registraram na parada original');
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12i — GETTER com efeito colateral em `criarConexao`: a propriedade é lida UMA vez; a segunda leitura (hostil) nunca é usada', async () => {
    const m = criarMundo();
    const evil = { n: 0 };
    const original = m.dependencias.conexao.criarConexao;
    let leituras = 0;
    const conexao = { temporizador: m.dependencias.conexao.temporizador, prazos: m.dependencias.conexao.prazos };
    Object.defineProperty(conexao, 'criarConexao', { enumerable: true, configurable: true, get() { leituras += 1; return leituras === 1 ? original : evilConexao(m, evil); } });
    const r = await operacional().executarBackupOperacional({ ...m.dependencias, conexao });
    assert.equal(leituras, 1, 'validar e usar leituras diferentes é exatamente o TOCTOU');
    assert.equal(evil.n, 0);
    assert.equal(m.contagem.criarConexao, 1);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12j — GETTER em `prazos`: só a primeira leitura (válida) vale; a segunda (inválida) não afeta a finalização', async () => {
    const m = criarMundo();
    let leituras = 0;
    const conexao = { criarConexao: m.dependencias.conexao.criarConexao, temporizador: m.dependencias.conexao.temporizador };
    Object.defineProperty(conexao, 'prazos', { enumerable: true, configurable: true, get() { leituras += 1; return leituras === 1 ? { finalizacaoMs: 5000 } : { finalizacaoMs: 'invalido' }; } });
    const r = await operacional().executarBackupOperacional({ ...m.dependencias, conexao });
    assert.equal(leituras, 1);
    assert.equal(m.temporizadorDoSnapshot.prazos.at(-1).ms, 5000);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('OP-SNAP-12k — GETTER que LANÇA (DECISÃO PENDENTE: saída 2 ou rejeição): em qualquer caso nenhuma trava, nenhuma conexão, nenhum efeito', async () => {
    const m = criarMundo();
    const conexao = { temporizador: m.dependencias.conexao.temporizador, prazos: m.dependencias.conexao.prazos };
    Object.defineProperty(conexao, 'criarConexao', { enumerable: true, configurable: true, get() { throw new Error('getter hostil'); } });
    const [resultado] = await Promise.allSettled([operacional().executarBackupOperacional({ ...m.dependencias, conexao })]);
    if (resultado.status === 'fulfilled') assert.equal(resultado.value.saida, SAIDAS.ARGUMENTOS);
    assert.equal(m.estado.aquisicoes, 0);
    assert.equal(m.contagem.criarConexao, 0);
    assert.equal(m.linha.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-13
describe('[OP-SNAP-13] sigilo: nenhuma mensagem, host ou credencial do banco chega ao resultado público nem aos logs do módulo', () => {
  const cenarios = [
    ['connect falha', () => ({ conectar: async () => { throw erroSensivel('ECONNREFUSED'); } })],
    ['BEGIN falha', () => ({ respostas: { BEGIN: async () => { throw erroSensivel(); } } })],
    ['exportação da snapshot falha', () => ({ respostas: { EXPORTAR: async () => { throw erroSensivel(); } } })],
    ['ROLLBACK falha', () => ({ respostas: { ROLLBACK: async () => { throw erroSensivel('08006'); } } })],
    ['end falha', () => ({ encerrar: async () => { throw erroSensivel('ECONNRESET'); } })],
    ['a fábrica de conexão lança', () => ({ fabrica: () => { throw erroSensivel('ECONNREFUSED'); } })],
    ['a cópia lança', null, (m) => { m.dependencias.copia = async () => { throw erroSensivel(); }; }],
    ['a avaliação lança', null, (m) => { m.dependencias.avaliar = () => { throw erroSensivel(); }; }],
    ['a descrição do processo do dump lança', null, (m) => { m.dependencias.processoDoDump = () => { throw erroSensivel(); }; }],
    ['a aquisição da trava lança', null, (m) => { m.dependencias.janela = { async adquirir() { throw erroSensivel(); } }; }],
    ['evento `error` do cliente durante a cópia', null, (m) => {
      m.dependencias.copia = async () => { m.contagem.copia += 1; for (const f of m.clientes[0].ouvintes.error ?? []) f(erroSensivel()); return { ok: true }; };
    }],
  ];
  for (const [rotulo, opcoes, ajustar] of cenarios) {
    teste(`OP-SNAP-13 (${rotulo}) — resultado e logs sem marcadores; os motivos são só códigos fixos; recuperavel false; nunca válido`, async () => {
      const m = criarMundo(opcoes ? opcoes() : {});
      if (ajustar) ajustar(m);
      const { resultado: r, chamadas } = await comConsoleEspiado(() => executar(m));
      semMarcadores(r, 'resultado serializado');
      for (const motivo of r.motivos) assert.match(motivo, /^[A-Z][A-Z_]*$/, 'motivo é um código fixo, nunca texto livre');
      semMarcadores(chamadas.join('\n'), 'logs do módulo (console)');
      assert.equal(r.recuperavel, false);
      assert.equal(r.valido, false);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-14
describe('[OP-SNAP-14] exceção na descrição do dump DEPOIS de o snapshot ser aberto', () => {
  for (const [rotulo, descricao] of [
    ['lança', () => { throw new Error('descrição do processo quebrou'); }],
    ['devolve nulo', () => null],
    ['devolve texto', () => 'nao-e-objeto'],
  ]) {
    teste(`OP-SNAP-14 (${rotulo}) — snapshot aberto e mantido: sem dump, sem cópia, sem avaliação, ROLLBACK 0 e end 0, finalização ADIADA, trava RETIDA (11)`, async () => {
      const m = criarMundo();
      m.dependencias.processoDoDump = (contexto) => { m.contagem.processoDoDump += 1; m.recebidos.dump.push(contexto); m.linha.push('processoDoDump'); return descricao(); };
      const r = await executar(m);
      assert.equal(m.contagem.processoDoDump, 1);
      assert.equal(m.recebidos.dump[0].snapshotId, ID_SNAPSHOT, 'a descrição recebeu o contexto do snapshot aberto');
      assert.ok(antes(m.linha, 'sql:EXPORTAR', 'processoDoDump'));
      assert.equal(m.linha.includes('dump:iniciar'), false);
      assert.equal(m.contagem.copia, 0);
      assert.equal(m.contagem.avaliar, 0);
      assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0, 'um processo inconclusivo ainda pode depender da snapshot');
      assert.equal(contar(m.clientes[0].log, 'end'), 0);
      assert.equal(r.finalizacao, 'ADIADA');
      assert.equal(r.janela, 'RETIDA');
      assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
      assert.equal(m.estado.liberacoes, 0);
      assert.ok(r.motivos.includes('LIBERACAO_NEGADA_PELA_SUPERVISAO'));
      assert.equal(r.supervisao, null, 'o supervisor nunca chegou a rodar');
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-09 (reforço)
describe('[OP-SNAP-09 reforço] precedência do coordenador com sinal e com posse perdida', () => {
  teste('OP-SNAP-09f — SIGINT durante a abertura e a abertura FALHA: a falha tem precedência (saída 9), o sinal fica registrado, a transação é encerrada', async () => {
    const m = criarMundo({ respostas: { BEGIN: async () => { m.pedirParada('SIGINT'); throw Object.assign(new Error('x'), { code: '40001' }); } } });
    m.dependencias.parada = m.parada;
    const r = await executar(m);
    assert.equal(r.sinal, 'SIGINT');
    assert.ok(r.motivos.includes('INTERROMPIDO'));
    assert.equal(r.saida, SAIDAS.INVALIDO, 'falha de etapa tem precedência sobre o sinal (regra existente)');
    assert.equal(m.contagem.processoDoDump + m.contagem.copia, 0);
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 1);
    assert.equal(contar(m.clientes[0].log, 'end'), 1);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('OP-SNAP-09g — posse PERDIDA durante o dump e o grupo ainda possivelmente VIVO: a supervisão manda reter; nenhum ROLLBACK nem end; trava alheia intacta; saída 10', async () => {
    const m = criarMundo({ vivos: true, terminoControlado: true });
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    m.estado.documento = { tipo: TIPOS.BACKUP, token: 'token-alheio' };
    m.terminar({ codigo: 0, sinal: null });
    const r = await pendente;
    assert.equal(contar(m.clientes[0].log, 'ROLLBACK'), 0);
    assert.equal(contar(m.clientes[0].log, 'end'), 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(m.estado.liberacoes, 0);
    assert.deepEqual(m.estado.documento, { tipo: TIPOS.BACKUP, token: 'token-alheio' });
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(r.saida, SAIDAS.JANELA_PERDIDA);
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-15
describe('[OP-SNAP-15] invariante transversal: sucesso só com finalização comprovada; liberar só depois dela', () => {
  const alheio = (m) => { m.estado.documento = { tipo: TIPOS.BACKUP, token: 'token-alheio' }; };
  const cenarios = [
    ['sucesso', {}, null],
    ['dump falha', { termino: { codigo: 1, sinal: null } }, null],
    ['connect falha', { conectar: async () => { throw new Error('x'); } }, null],
    ['BEGIN falha', { respostas: { BEGIN: async () => { throw new Error('x'); } } }, null],
    ['ROLLBACK lança', { respostas: { ROLLBACK: async () => { throw new Error('x'); } } }, null],
    ['end lança', { encerrar: async () => { throw new Error('x'); } }, null],
    ['grupo vivo', { vivos: true }, null],
    ['dump não inicia', { iniciarFalha: Object.assign(new Error('x'), { code: 'ENOENT' }) }, null],
    ['trava ocupada', { ocupada: true }, null],
    ['cópia falha', {}, (m) => { m.dependencias.copia = async () => ({ ok: false }); }],
    ['avaliação lança', {}, (m) => { m.dependencias.avaliar = () => { throw new Error('x'); }; }],
    ['avaliação diz recuperável', {}, (m) => { m.dependencias.avaliar = () => ({ valido: true, recuperavel: true, motivos: [] }); }],
    ['posse perdida na cópia', {}, (m) => { m.dependencias.copia = async () => { m.contagem.copia += 1; alheio(m); return { ok: true }; }; }],
  ];

  teste('OP-SNAP-15 — em TODOS os cenários: valido ⇒ saída 0, finalização CONCLUIDA, ROLLBACK e end em cada cliente, nesta ordem, antes da única liberação; liberou ⇒ todo cliente foi encerrado e a finalização não ficou pendente; retido/adiado ⇒ nenhuma liberação; recuperavel sempre false', async () => {
    let validos = 0;
    let invalidos = 0;
    for (const [rotulo, opcoes, ajustar] of cenarios) {
      const m = criarMundo(opcoes);
      if (ajustar) ajustar(m);
      const r = await executar(m);
      assert.equal(r.recuperavel, false, rotulo);
      if (r.valido === true) {
        validos += 1;
        assert.equal(r.saida, SAIDAS.VALIDO, rotulo);
        assert.equal(r.finalizacao, 'CONCLUIDA', rotulo);
        assert.ok(m.clientes.length >= 1, rotulo);
        for (const c of m.clientes) {
          assert.equal(contar(c.log, 'ROLLBACK'), 1, rotulo);
          assert.equal(contar(c.log, 'end'), 1, rotulo);
        }
        assert.ok(antes(m.linha, 'sql:ROLLBACK', 'sql:end'), rotulo);
        assert.ok(antes(m.linha, 'sql:end', 'liberar'), rotulo);
        assert.equal(m.estado.liberacoes, 1, rotulo);
        assert.equal(r.janela, 'LIBERADA', rotulo);
      } else {
        invalidos += 1;
      }
      if (m.estado.liberacoes > 0) {
        for (const c of m.clientes) assert.ok(contar(c.log, 'end') >= 1, `${rotulo}: liberou com cliente aberto`);
        assert.notEqual(r.finalizacao, 'NAO_CONCLUIDA', rotulo);
        assert.notEqual(r.finalizacao, 'ADIADA', rotulo);
      }
      if (r.finalizacao === 'NAO_CONCLUIDA' || r.finalizacao === 'ADIADA') assert.equal(m.estado.liberacoes, 0, `${rotulo}: retido/adiado nunca libera`);
    }
    assert.equal(validos, 2, 'só o sucesso e o caso em que a avaliação alega `recuperavel` (o veredito pode ser válido, mas nunca recuperável)');
    assert.equal(invalidos, cenarios.length - validos);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- OP-SNAP-16
describe('[OP-SNAP-16] prazo da finalização: cancelado ao fim; `end()` pendente não vira concluído', () => {
  teste('OP-SNAP-16a — `end()` PENDENTE até o prazo esgotar: não é concluída, trava RETIDA, nenhuma operação posterior no cliente, prazo cancelado, nenhuma liberação mesmo se o end resolver depois', async () => {
    const fim = adiado();
    const fimIniciado = adiado();
    const m = criarMundo({ encerrar: () => { fimIniciado.resolver(); return fim.promessa; } });
    const pendente = executar(m);
    await ate(fimIniciado.promessa, pendente, 'o end() começar');
    const prazo = m.temporizadorDoSnapshot.prazos.at(-1);
    assert.equal(prazo.ms, 5000);
    assert.equal(m.estado.liberacoes, 0, 'enquanto o end() não termina, a trava não é solta');
    prazo.vencer();
    const r = await pendente;
    const depoisDoPrazo = [...m.clientes[0].log];
    const linhaDepois = [...m.linha];
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
    assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'));
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(prazo.cancelado, true);
    assert.equal(depoisDoPrazo.at(-1), 'end', 'o end() foi a última operação do cliente');
    assert.equal(contar(depoisDoPrazo, 'ROLLBACK'), 1);
    fim.resolver();
    await new Promise((resolver) => setImmediate(resolver));
    assert.deepEqual(m.clientes[0].log, depoisDoPrazo, 'nada novo no cliente depois do prazo, nem quando o end() resolve tarde');
    assert.deepEqual(m.linha, linhaDepois);
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('OP-SNAP-16b — finalização bem-sucedida: o ÚNICO prazo criado é cancelado (sem temporizador vazando)', async () => {
    const m = criarMundo();
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(m.temporizadorDoSnapshot.prazos.length, 1);
    assert.equal(m.temporizadorDoSnapshot.prazos[0].ms, 5000);
    assert.equal(m.temporizadorDoSnapshot.prazos[0].cancelado, true);
  });
});
