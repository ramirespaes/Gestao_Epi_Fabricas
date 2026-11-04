'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRegistroDeOperacoes } = require('../../src/utils/registro-operacoes-pendentes');
const { criarBackupDeProducao, criarRestauracaoDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso, novaRaiz, clienteFalso, linhas, PRAZOS, POLITICA } = require('../helpers/ambiente-backup-operacao');

/**
 * PRAZO E CANCELAMENTO OPCIONAIS na restauração (restauração física das imagens e conexão/consultas da conferência lógica), sobre o registro de operações pendentes. Só diretórios descartáveis, relógio manual, spawn e cliente falsos.
 * O `pg_restore` supervisionado NÃO é tocado: os testes provam que o spec/argumentos continuam idênticos. Os números de prazo são VALORES DE TESTE.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-rop-rest-' });
after(() => { fix.remover(); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const adiado = () => { let resolver; const promessa = new Promise((r) => { resolver = r; }); return { promessa, resolver }; };
const andar = async (vezes = 10) => { for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r)); };
const ate = async (condicao, rotulo = 'condição') => { const limite = Date.now() + 10000; while (Date.now() < limite) { if (condicao()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail(`não ocorreu: ${rotulo}`); };
function relogioManual() {
  const ativos = new Set();
  return {
    prazo(ms) { const p = { ms }; p.promessa = new Promise((r) => { p.resolver = r; }); ativos.add(p); return { promessa: p.promessa, cancelar() { ativos.delete(p); } }; },
    intervalo: () => Promise.resolve(),
    disparar(ms) { for (const p of [...ativos]) if (p.ms === ms) { ativos.delete(p); p.resolver(); } },
    registrado: (ms) => [...ativos].some((p) => p.ms === ms),
    quantos: () => ativos.size,
  };
}
/** Fotografia de uma árvore: caminho -> SHA-256 (garante que o pacote de origem não foi tocado). */
function instantaneo(raiz) {
  const mapa = {};
  for (const e of fs.readdirSync(raiz, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    mapa[path.relative(raiz, p)] = e.isDirectory() ? 'DIR' : sha(fs.readFileSync(p));
  }
  return mapa;
}

const DESTINO = Object.freeze({ banco: 'gepi_cp_restaurado', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: '/tmp/senha-ficticia' });
const IMG = 7301;
const CONSULTA = 7302;
const CORTESIA = 7303;

async function pacote() {
  const a = await ambiente();
  const composto = await criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-rop-rest-01' });
  assert.equal(composto.resultado.publicacao.publicada, true);
  return a;
}
const pedido = (a, imagens = novaRaiz()) => ({ raizAutorizada: a.dirs.publicados, nome: 'prep-1', imagens: { raiz: imagens, nome: 'img' }, destino: DESTINO });

describe('[ROP-REST-COMP] composição: conferência lógica (conexão e consultas) com prazo opcional', () => {
  /** Restauração de produção com relógio manual; a 2ª conexão (a da consulta de referências) pode ser retida. */
  function montar(a, { operacoes, reter = false, spawn = spawnFalso().spawn } = {}) {
    const relogio = relogioManual();
    const portao = adiado();
    const clientes = [];
    const fim = { chamadas: 0 };
    const r = criarRestauracaoDeProducao({
      postgres: { pgRestore: a.config.postgres.pgRestore },
      politicaDeDestino: { ...POLITICA },
      fonteDeChaves: a.fonteDeChaves,
      criarConexaoDoBanco: (banco) => {
        const c = clienteFalso(banco, linhas());
        clientes.push(c);
        if (reter && clientes.length === 2) {
          c.connect = () => portao.promessa;
          const original = c.end;
          c.end = async () => { fim.chamadas += 1; return original.call(c); };
        }
        return c;
      },
      prazos: { ...PRAZOS },
      portas: { spawn, observarGrupo: async () => false, temporizador: relogio },
      ...(operacoes === undefined ? {} : { operacoes }),
    });
    return { r, relogio, portao, clientes, fim };
  }
  const todosFalsos = (out) => assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });

  teste('RO-01 — configuração: `operacoes` estrito (chaves conhecidas, inteiros seguros positivos, ao menos uma), DESLIGADO por omissão; sem ele o resultado é o histórico (nenhum registro)', async () => {
    const a = await pacote();
    for (const ruim of [{}, { imagensMs: 0 }, { consultaMs: 1.5 }, { extra: 1 }, { cortesiaMs: '5' }, null]) assert.throws(() => montar(a, { operacoes: ruim }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const m = montar(a);
    const out = await m.r.restaurar(pedido(a));
    assert.equal(out.restauracao.ok, true);
    assert.equal(out.proveniencia.operacoes, null);
    assert.deepEqual(m.relogio.quantos(), 0);
  });

  teste('RO-02 — SUCESSO com controle ligado: restauração, pendências do avaliador e estados idênticos ao histórico; as duas operações assentam; o `pg_restore` supervisionado mantém spec e argumentos EXATOS; nenhum prazo sobra', async () => {
    const a = await pacote();
    const falso = spawnFalso();
    const m = montar(a, { operacoes: { imagensMs: IMG, consultaMs: CONSULTA, cortesiaMs: CORTESIA }, spawn: falso.spawn });
    const out = await m.r.restaurar(pedido(a));
    assert.equal(out.restauracao.ok, true, out.restauracao.motivo);
    assert.deepEqual([...out.proveniencia.avaliacao.pendencias].sort(), ['CLIENTE_GENUINO', 'CONSULTAS_REAIS', 'SPAWN_GENUINO']);
    todosFalsos(out);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore']);
    assert.deepEqual(falso.chamadas[0].args, ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_cp_restaurado']);
    assert.deepEqual(out.proveniencia.operacoes.operacoes.map((o) => [o.etapa, o.estado, o.desfecho]), [['restauracao_imagens', 'ASSENTADA', 'RESOLVIDA'], ['conferencia_logica', 'ASSENTADA', 'RESOLVIDA']]);
    assert.equal(out.proveniencia.operacoes.pendentes, 0);
    assert.equal(m.relogio.quantos(), 0);
  });

  teste('RO-03 — conexão da conferência lógica que NÃO assenta (prazo + cortesia): CANCELAMENTO_NAO_CONFIRMADO; nenhuma prova; a conexão NÃO é dada como encerrada (sem SQL, sem end()); operação segue pendente; pg_restore já concluído e imagens restauradas preservadas; pacote de origem intacto', async () => {
    const a = await pacote();
    const antes = instantaneo(a.dirs.publicados);
    const falso = spawnFalso();
    const imagens = novaRaiz();
    const m = montar(a, { operacoes: { consultaMs: CONSULTA, cortesiaMs: CORTESIA }, reter: true, spawn: falso.spawn });
    const rodando = m.r.restaurar(pedido(a, imagens));
    await ate(() => m.relogio.registrado(CONSULTA), 'prazo da consulta');
    m.relogio.disparar(CONSULTA);
    await ate(() => m.relogio.registrado(CORTESIA), 'cortesia');
    m.relogio.disparar(CORTESIA);
    const out = await rodando;
    assert.deepEqual([out.restauracao.ok, out.restauracao.motivo], [false, 'CANCELAMENTO_NAO_CONFIRMADO']);
    assert.equal(out.restauracao.consistenciaLogica.contratual, false);
    todosFalsos(out);
    assert.equal(out.proveniencia.avaliacao.reconhecida, false);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore'], 'o pg_restore supervisionado seguiu o fluxo de sempre, uma vez');
    assert.deepEqual([m.fim.chamadas, m.clientes[1].sqls.length], [0, 0], 'conexão pendente: nada foi enviado e ela NÃO foi dada como encerrada');
    assert.equal(out.proveniencia.operacoes.pendentes, 1);
    assert.deepEqual(out.proveniencia.operacoes.operacoes.find((o) => o.etapa === 'conferencia_logica').estado, 'CANCELAMENTO_NAO_CONFIRMADO');
    assert.ok(fs.readdirSync(imagens, { recursive: true }).length > 0, 'imagens restauradas preservadas');
    assert.deepEqual(instantaneo(a.dirs.publicados), antes, 'pacote de origem intacto');
    m.portao.resolver();
    await andar();
  });

  teste('RO-04 — RESULTADO TARDIO observado: a conexão retida conclui depois da saída; a leitura fresca mostra operação ASSENTADA e tardia, com a conexão encerrada COM EVIDÊNCIA (ROLLBACK e end()); o resultado devolvido não é reescrito e continua sem prova', async () => {
    const a = await pacote();
    const m = montar(a, { operacoes: { consultaMs: CONSULTA, cortesiaMs: CORTESIA }, reter: true });
    const rodando = m.r.restaurar(pedido(a));
    await ate(() => m.relogio.registrado(CONSULTA));
    m.relogio.disparar(CONSULTA);
    await ate(() => m.relogio.registrado(CORTESIA));
    m.relogio.disparar(CORTESIA);
    const out = await rodando;
    assert.equal(out.proveniencia.situacaoAtual().operacoes.pendentes, 1);
    m.portao.resolver();
    await ate(() => out.proveniencia.situacaoAtual().operacoes.pendentes === 0, 'conclusão tardia');
    const op = out.proveniencia.situacaoAtual().operacoes.operacoes.find((o) => o.etapa === 'conferencia_logica');
    assert.deepEqual([op.estado, op.tardia, op.cancelamentoSolicitado], ['ASSENTADA', true, true]);
    assert.equal(m.fim.chamadas, 1, 'end() chamado só depois que a conexão realmente concluiu');
    assert.ok(m.clientes[1].sqls.includes('ROLLBACK'));
    assert.deepEqual([out.restauracao.ok, out.restauracao.motivo], [false, 'CANCELAMENTO_NAO_CONFIRMADO']);
    todosFalsos(out);
  });

  teste('RO-05 — prazo vencido mas a consulta ASSENTA dentro da cortesia (sem cancelamento cooperativo no adaptador): PRAZO_EXCEDIDO — nunca sucesso, nenhuma prova — e a operação, assentada, deixa de ser pendente com a conexão encerrada por evidência', async () => {
    const a = await pacote();
    const m = montar(a, { operacoes: { consultaMs: CONSULTA, cortesiaMs: CORTESIA }, reter: true });
    const rodando = m.r.restaurar(pedido(a));
    await ate(() => m.relogio.registrado(CONSULTA));
    m.relogio.disparar(CONSULTA);
    await ate(() => m.relogio.registrado(CORTESIA));
    m.portao.resolver();
    const out = await rodando;
    assert.deepEqual([out.restauracao.ok, out.restauracao.motivo], [false, 'PRAZO_EXCEDIDO']);
    assert.equal(out.restauracao.consistenciaLogica.contratual, false);
    todosFalsos(out);
    assert.equal(out.proveniencia.operacoes.pendentes, 0);
    assert.equal(out.proveniencia.operacoes.operacoes.find((o) => o.etapa === 'conferencia_logica').cancelamentoConfirmado, true);
    assert.equal(m.fim.chamadas, 1);
  });
});

describe('[ROP-REST-IMG] restauração física das imagens com prazo e cancelamento cooperativo opcionais', () => {
  async function cenarioDeImagens({ travarNaSegunda = false } = {}) {
    const a = await pacote();
    const relogio = relogioManual();
    const registro = criarRegistroDeOperacoes({ temporizador: relogio, cortesiaMs: CORTESIA });
    const portao = adiado();
    const lidas = [];
    const bancoChamadas = { n: 0 };
    const ops = {
      lerImagem: async (caminho, bytes) => {
        lidas.push(caminho);
        if (travarNaSegunda && lidas.length === 2) await portao.promessa;
        return fs.readFileSync(caminho);
      },
    };
    const restauradorDoBanco = { autorizarDestino: () => true, restaurar: async () => { bancoChamadas.n += 1; return { ok: true }; } };
    const r = criarRestaurador({ ops, fonteDeChaves: a.fonteDeChaves, restauradorDoBanco, controle: { registro, imagensMs: IMG } });
    return { a, relogio, registro, portao, lidas, bancoChamadas, r };
  }
  const chamar = (c, destinoImagens) => c.r.restaurarPacote({ raizAutorizada: c.a.dirs.publicados, nome: 'prep-1', imagens: { raiz: destinoImagens, nome: 'img' }, banco: { destino: DESTINO } });

  teste('RO-06 — SUCESSO dentro do prazo: imagens restauradas, operação assentada, nenhum prazo sobra e o restante do fluxo (banco) segue', async () => {
    const c = await cenarioDeImagens();
    const destino = novaRaiz();
    const out = await chamar(c, destino);
    assert.equal(out.etapas.imagens.ok, true);
    assert.equal(c.bancoChamadas.n, 1);
    assert.deepEqual(c.registro.resumo().operacoes.map((o) => [o.etapa, o.estado, o.desfecho]), [['restauracao_imagens', 'ASSENTADA', 'RESOLVIDA']]);
    assert.equal(c.relogio.quantos(), 0);
  });

  teste('RO-07 — leitura que IGNORA o cancelamento (não assenta): CANCELAMENTO_NAO_CONFIRMADO; o banco NÃO é tocado; o parcial é preservado; o pacote de origem fica intacto; a operação segue pendente', async () => {
    const c = await cenarioDeImagens({ travarNaSegunda: true });
    const antes = instantaneo(c.a.dirs.publicados);
    const destino = novaRaiz();
    const rodando = chamar(c, destino);
    await ate(() => c.relogio.registrado(IMG) && c.lidas.length === 2, 'prazo registrado e segunda leitura (a retida) em andamento');
    c.relogio.disparar(IMG);
    await ate(() => c.relogio.registrado(CORTESIA), 'cortesia');
    c.relogio.disparar(CORTESIA);
    const out = await rodando;
    assert.deepEqual([out.ok, out.motivo], [false, 'CANCELAMENTO_NAO_CONFIRMADO']);
    assert.equal(out.etapas.imagens.destino, 'PARCIAL_PRESERVADO');
    assert.equal(c.bancoChamadas.n, 0, 'nenhuma restauração do banco começou');
    assert.equal(fs.readdirSync(path.join(destino, 'img'), { recursive: true }).length > 0, true, 'o que já foi restaurado ficou');
    assert.deepEqual(instantaneo(c.a.dirs.publicados), antes);
    assert.equal(c.registro.pendentes().length, 1);
    c.portao.resolver();
    await ate(() => c.registro.pendentes().length === 0, 'conclusão tardia');
    const op = c.registro.resumo().operacoes[0];
    assert.deepEqual([op.estado, op.tardia, op.cancelamentoSolicitado], ['ASSENTADA', true, true]);
    assert.equal(c.bancoChamadas.n, 0, 'o resultado tardio não retoma o fluxo');
  });

  teste('RO-08 — leitura que RESPEITA o cancelamento (para no ponto seguro): a operação assenta dentro da cortesia, o cancelamento é CONFIRMADO, mas o prazo excedido NUNCA é sucesso (PRAZO_EXCEDIDO); parcial preservado, banco intocado', async () => {
    const c = await cenarioDeImagens({ travarNaSegunda: true });
    const antes = instantaneo(c.a.dirs.publicados);
    const destino = novaRaiz();
    const rodando = chamar(c, destino);
    await ate(() => c.relogio.registrado(IMG) && c.lidas.length === 2, 'prazo registrado e segunda leitura (a retida) em andamento');
    c.relogio.disparar(IMG);
    await ate(() => c.relogio.registrado(CORTESIA));
    c.portao.resolver();
    const out = await rodando;
    assert.deepEqual([out.ok, out.motivo], [false, 'PRAZO_EXCEDIDO']);
    assert.equal(c.bancoChamadas.n, 0);
    const op = c.registro.resumo().operacoes[0];
    assert.deepEqual([op.estado, op.cancelamentoConfirmado], ['ASSENTADA', true]);
    const restaurados = fs.readdirSync(path.join(destino, 'img'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
    assert.equal(restaurados >= 1 && restaurados < 5, true, 'a restauração parou no ponto seguro (parcial preservado, incompleto)');
    assert.deepEqual(instantaneo(c.a.dirs.publicados), antes);
  });

  teste('RO-09 — contratos estritos: `controle` inválido (registro que não é da fábrica, chave extra, prazo sem temporizador, prazo não inteiro) é recusado antes de qualquer efeito; sem `controle` o comportamento é o histórico', async () => {
    const a = await pacote();
    const comRelogio = criarRegistroDeOperacoes({ temporizador: relogioManual() });
    const semRelogio = criarRegistroDeOperacoes();
    for (const controle of [{ registro: {} }, { registro: { ...comRelogio } }, { registro: comRelogio, extra: 1 }, { registro: semRelogio, imagensMs: 5 }, { registro: comRelogio, consultaMs: 1.5 }, null, 7]) {
      assert.throws(() => criarRestaurador({ fonteDeChaves: a.fonteDeChaves, controle }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    }
    const historico = await criarRestaurador({ fonteDeChaves: a.fonteDeChaves }).restaurarPacote({ raizAutorizada: a.dirs.publicados, nome: 'prep-1', imagens: { raiz: novaRaiz(), nome: 'img' } });
    assert.equal(historico.ok, true);
  });
});
