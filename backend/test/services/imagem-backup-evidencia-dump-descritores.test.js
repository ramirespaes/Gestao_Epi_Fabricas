'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarProcessoDoDump } = require('../../src/services/imagem-backup-pgdump.service');
const { criarObservadorDoDump } = require('../../src/services/imagem-backup-evidencia-dump.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');

/**
 * EVD-15 (contraprova local): o observador FECHA todo descritor que ele próprio abre, em TODOS os desfechos (sucesso, divergência, falha de leitura, falha ao fechar, substituição do arquivo), e lê em blocos de no máximo 1 MiB.
 * Determinístico: espiões sobre `fsp.open`, `fs.openSync` e `fs.closeSync` registram SÓ as aberturas do observador (flags O_RDONLY|O_NOFOLLOW e o caminho do dump do próprio teste) — nenhuma contagem global de descritores do sistema.
 * `pg_dump` e processos NÃO existem: o lançador é um double e o dump é um arquivo fictício em diretório descartável.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-evd15-test-' });
const operacoes = [];
after(() => {
  for (const op of operacoes) { op.dSaida.resolver({ codigo: 0, sinal: null }); op.dFluxos.resolver(); try { if (op.criado) op.criado.fechar(); } catch { /* já fechado */ } }
  fix.remover();
});
const NOME_DO_DUMP = 'dump-ficticio.custom';
const BYTES = Buffer.from('conteudo-ficticio-do-dump-0123456789'.repeat(200));
const BLOCO_MAXIMO = 1024 * 1024;
const FLAGS_DO_OBSERVADOR = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

function deferido() {
  let resolver;
  const promessa = new Promise((res) => { resolver = res; });
  return { promessa, resolver };
}
const contexto = () => Object.freeze({ snapshotId: '00000003-0000001B-1', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros: Object.freeze({}), plano: Object.freeze([]) });

/** Operação com dump real em diretório descartável e observador REAL; `pg_dump` substituído por double; encerrada com saída 0 e fluxos fechados. */
async function operacao() {
  const diretorio = fix.criar();
  const op = { diretorio, caminho: path.join(diretorio, NOME_DO_DUMP), dSaida: deferido(), dFluxos: deferido(), criado: null, descritorDoDump: null };
  const arquivos = {
    criarExclusivo(spec) {
      const descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      op.criado = { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
      return op.criado;
    },
  };
  const lancador = { lancar(spec) { op.descritorDoDump = spec.opcoes.stdio[1]; return { pid: 4242, saida: op.dSaida.promessa, fluxosFechados: op.dFluxos.promessa }; } };
  operacoes.push(op);
  op.observador = criarObservadorDoDump({ arquivos, lancador });
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    destino: { diretorio, nome: NOME_DO_DUMP },
    lancador: op.observador.lancador,
    sistema: { grupoVivo: async () => true, enviarSinal: async () => false },
    arquivos: op.observador.arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) },
    prazos: { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 },
  };
  op.processo = criarProcessoDoDump({ contexto: contexto(), dump });
  op.iniciado = await op.processo.iniciar();
  fs.writeSync(op.descritorDoDump, BYTES);
  op.dSaida.resolver({ codigo: 0, sinal: null });
  await op.iniciado.saida;
  op.dFluxos.resolver();
  await op.iniciado.fluxosFechados;
  return op;
}

/** Espiões que registram SÓ as aberturas do observador (flags e caminho do dump deste teste). `modo` injeta falhas controladas nas leituras e no fechamento. */
function espiar(t, op, { falharLeituraNaChamada = null, falharAoFechar = false } = {}) {
  const abertosAssincronos = [];
  const abertosSincronos = [];
  const fechadosSincronos = [];
  const abrirOriginal = fsp.open;
  t.mock.method(fsp, 'open', async (caminho, flags, ...resto) => {
    const h = await abrirOriginal.call(fsp, caminho, flags, ...resto);
    if (caminho !== op.caminho || flags !== FLAGS_DO_OBSERVADOR) return h;
    const reg = { fd: h.fd, fechamentos: 0, leituras: [] };
    abertosAssincronos.push(reg);
    const fecharOriginal = h.close.bind(h);
    h.close = async () => { reg.fechamentos += 1; await fecharOriginal(); if (falharAoFechar) throw Object.assign(new Error('falha ao fechar'), { code: 'EIO' }); };
    const lerOriginal = h.read.bind(h);
    h.read = async (buffer, deslocamento, tamanho, posicao) => {
      reg.leituras.push(tamanho);
      if (falharLeituraNaChamada !== null && reg.leituras.length === falharLeituraNaChamada) throw Object.assign(new Error('falha de leitura'), { code: 'EIO' });
      return lerOriginal(buffer, deslocamento, tamanho, posicao);
    };
    return h;
  });
  const openOriginal = fs.openSync;
  t.mock.method(fs, 'openSync', (caminho, flags, ...resto) => {
    const fd = openOriginal.call(fs, caminho, flags, ...resto);
    if (caminho === op.caminho && flags === FLAGS_DO_OBSERVADOR) abertosSincronos.push(fd);
    return fd;
  });
  const closeOriginal = fs.closeSync;
  t.mock.method(fs, 'closeSync', (fd) => { fechadosSincronos.push(fd); return closeOriginal.call(fs, fd); });
  return { abertosAssincronos, abertosSincronos, fechadosSincronos };
}
const todosFechadosUmaVez = (espiao) => espiao.abertosAssincronos.every((r) => r.fechamentos === 1);
const estaFechado = (fd) => { try { fs.fstatSync(fd); return false; } catch (e) { return e.code === 'EBADF'; } };

describe('[EVD-15] o observador fecha o que abre e lê em blocos limitados', () => {
  teste('EVD-15a — T1 (`observar`) e T2 (`conferir`) com sucesso: cada abertura do observador é fechada EXATAMENTE uma vez e nenhuma leitura excede 1 MiB', async (t) => {
    const op = await operacao();
    const e = espiar(t, op);
    const t1 = await op.observador.observar();
    assert.equal(t1.ok, true);
    assert.equal(e.abertosAssincronos.length, 1);
    const t2 = await op.observador.conferir();
    assert.equal(t2.ok, true);
    assert.equal(e.abertosAssincronos.length, 2);
    assert.equal(todosFechadosUmaVez(e), true);
    for (const r of e.abertosAssincronos) {
      assert.ok(r.leituras.length >= 1);
      assert.ok(r.leituras.every((n) => n <= BLOCO_MAXIMO), `leitura de ${Math.max(...r.leituras)} bytes excede o bloco`);
      assert.ok(estaFechado(r.fd), 'o descritor deixou de existir');
    }
  });

  teste('EVD-15b — DIVERGÊNCIA entre T1 e T2 (arquivo mudou): conferir recusa com DIVERGENTE e o descritor aberto para a conferência é fechado', async (t) => {
    const op = await operacao();
    const e = espiar(t, op);
    assert.equal((await op.observador.observar()).ok, true);
    fs.appendFileSync(op.caminho, 'x');
    const t2 = await op.observador.conferir();
    assert.equal(t2.ok, false);
    assert.equal(t2.motivo, 'DIVERGENTE');
    assert.equal(e.abertosAssincronos.length, 2);
    assert.equal(todosFechadosUmaVez(e), true);
  });

  teste('EVD-15c — FALHA DE LEITURA no meio da leitura física: LEITURA_FALHOU sem vazar a causa, e o descritor é fechado exatamente uma vez', async (t) => {
    const op = await operacao();
    const e = espiar(t, op, { falharLeituraNaChamada: 1 });
    const r = await op.observador.evidencia();
    assert.deepEqual([r.ok, r.motivo], [false, 'LEITURA_FALHOU']);
    assert.equal(e.abertosAssincronos.length, 1);
    assert.equal(todosFechadosUmaVez(e), true);
    assert.equal(JSON.stringify(r).includes('falha de leitura'), false);
  });

  teste('EVD-15d — FALHA AO FECHAR o descritor (CON-09, parte injetável): a leitura NÃO é aceita (LEITURA_FALHOU) mesmo com bytes lidos, e o fechamento foi tentado exatamente uma vez', async (t) => {
    const op = await operacao();
    const e = espiar(t, op, { falharAoFechar: true });
    const r = await op.observador.evidencia();
    assert.deepEqual([r.ok, r.motivo], [false, 'LEITURA_FALHOU']);
    assert.equal(e.abertosAssincronos.length, 1);
    assert.equal(e.abertosAssincronos[0].fechamentos, 1);
    assert.equal(r.sha256Calculado, undefined, 'nenhum hash é entregue quando o fechamento falha');
  });

  teste('EVD-15e — ARQUIVO SUBSTITUÍDO antes da leitura (outro inode): IDENTIDADE_DIVERGENTE e o descritor aberto é fechado; a evidência é consumida (não há segunda tentativa)', async (t) => {
    const op = await operacao();
    const e = espiar(t, op);
    const novo = `${op.caminho}.novo`;
    fs.writeFileSync(novo, BYTES);
    fs.renameSync(novo, op.caminho);
    const r = await op.observador.evidencia();
    assert.deepEqual([r.ok, r.motivo], [false, 'IDENTIDADE_DIVERGENTE']);
    assert.equal(todosFechadosUmaVez(e), true);
    assert.equal((await op.observador.evidencia()).motivo, 'JA_CONSUMIDA');
    assert.equal(e.abertosAssincronos.length, 1, 'a segunda chamada não abriu nada');
  });

  teste('EVD-15f — `abrirArtefato`: devolve um descritor de leitura que `fechar()` fecha uma única vez (idempotente); arquivo trocado => SUBSTITUIDO e o descritor recém-aberto é fechado na hora', async (t) => {
    const op = await operacao();
    assert.equal((await op.observador.observar()).ok, true);
    const e = espiar(t, op);
    const artefato = op.observador.abrirArtefato();
    assert.equal(artefato.ok, true);
    assert.equal(e.abertosSincronos.length, 1);
    assert.equal(estaFechado(artefato.descritor), false);
    artefato.fechar();
    artefato.fechar();
    assert.equal(e.fechadosSincronos.filter((fd) => fd === artefato.descritor).length, 1, 'fechar é idempotente');
    assert.equal(estaFechado(artefato.descritor), true);

    const novo = `${op.caminho}.novo`;
    fs.writeFileSync(novo, BYTES);
    fs.renameSync(novo, op.caminho);
    const antes = e.abertosSincronos.length;
    const fechadosAntes = e.fechadosSincronos.length; // o sistema pode reutilizar o número do descritor: conta-se só o que ocorre DEPOIS deste ponto
    const trocado = op.observador.abrirArtefato();
    assert.deepEqual([trocado.ok, trocado.motivo], [false, 'SUBSTITUIDO']);
    assert.equal(e.abertosSincronos.length, antes + 1);
    const fdAberto = e.abertosSincronos[antes];
    assert.equal(estaFechado(fdAberto), true, 'o descritor aberto para a conferência foi fechado');
    assert.equal(e.fechadosSincronos.slice(fechadosAntes).filter((fd) => fd === fdAberto).length, 1);
  });

  teste('EVD-15g — LIMITE DE TAMANHO: não há teto próprio no observador (memória limitada pelo bloco de 1 MiB); um arquivo de 2,5 MiB é lido em blocos <= 1 MiB com 4 leituras no máximo e o hash confere. O teto do conjunto é a proposta COP-11f', async (t) => {
    const diretorio = fix.criar();
    const grande = Buffer.alloc(2.5 * 1024 * 1024, 0x61);
    const op = { diretorio, caminho: path.join(diretorio, NOME_DO_DUMP), dSaida: deferido(), dFluxos: deferido(), criado: null, descritorDoDump: null };
    operacoes.push(op);
    const arquivos = { criarExclusivo(spec) { const descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo); let f = false; op.criado = { descritor, fechar() { if (!f) { f = true; fs.closeSync(descritor); } } }; return op.criado; } };
    const lancador = { lancar(spec) { op.descritorDoDump = spec.opcoes.stdio[1]; return { pid: 4242, saida: op.dSaida.promessa, fluxosFechados: op.dFluxos.promessa }; } };
    op.observador = criarObservadorDoDump({ arquivos, lancador });
    const dump = {
      alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio, nome: NOME_DO_DUMP }, lancador: op.observador.lancador, sistema: { grupoVivo: async () => true, enviarSinal: async () => false }, arquivos: op.observador.arquivos,
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) },
      prazos: { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 },
    };
    const iniciado = await criarProcessoDoDump({ contexto: contexto(), dump }).iniciar();
    fs.writeSync(op.descritorDoDump, grande);
    op.dSaida.resolver({ codigo: 0, sinal: null });
    await iniciado.saida;
    op.dFluxos.resolver();
    await iniciado.fluxosFechados;
    const e = espiar(t, op);
    const r = await op.observador.evidencia();
    assert.equal(r.ok, true);
    assert.equal(r.sha256Calculado, crypto.createHash('sha256').update(grande).digest('hex'));
    const leituras = e.abertosAssincronos[0].leituras;
    assert.ok(leituras.length <= 4 && leituras.every((n) => n <= BLOCO_MAXIMO), JSON.stringify(leituras));
    assert.equal(todosFechadosUmaVez(e), true);
  });
});
