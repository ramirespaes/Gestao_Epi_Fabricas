'use strict';
// Etapa 3B-2A: provedor de coordenação que fala com o guardião por um canal de controle. Isolado: não está ligado ao
// agente nem ao instalador e NÃO é um provedor homologado. Sem banco real: o processo é falso ou é um Node de verdade
// com um PostgreSQL simulado dentro dele.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const RAIZ = path.resolve(__dirname, '../../../..');
const ARQ = path.join(RAIZ, 'deploy/hml/cd/coordenacao-por-guardiao.js');
const M = require(ARQ);
const C = require(path.join(RAIZ, 'deploy/hml/instalador/coordenacao'));

const SISTEMA = '7412345678901234567';
const PRAZOS = { adquirirMs: 150, confirmarMs: 150, liberarMs: 150, encerrarMs: 150 };
const PERGUNTA = /^confirmar ([0-9a-f]{32})\n$/;
const LIBERACAO = (situacao, forcada = false) => ({ situacao, processoEncerrado: situacao !== 'INDETERMINADA', forcada, comprovadaNoBanco: false });
const BASE = { comando: [process.execPath, '/baseline/scripts/guardiao-de-coordenacao.js'], dir: '/baseline', credencial: '/etc/safework/credencial.json', sistema: SISTEMA, prazos: PRAZOS };

function processoFalso() {
  const p = { escritos: [], iniciado: null, morto: false, entradaFechada: false, matou: 0, linhaCb: () => {}, sairCb: () => {} };
  p.iniciar = (comando, args, opcoes) => {
    p.iniciado = { comando, args, opcoes };
    return {
      escrever: (t) => { p.escritos.push(t); if (p.aoEscrever) p.aoEscrever(t); },
      fecharEntrada: () => { p.entradaFechada = true; },
      aoReceberLinha: (cb) => { p.linhaCb = cb; },
      aoSair: (cb) => { p.sairCb = cb; },
      matar: () => {
        p.matou += 1;
        if (p.falhaAoSinalizar) throw new Error('EPERM');
        if (p.naoMorre) return true;
        if (p.morreDepoisMs) { setTimeout(() => p.sair(null), p.morreDepoisMs); return true; }
        if (!p.morto) { p.morto = true; p.sairCb(null); }
        return true;
      },
    };
  };
  p.perguntas = () => p.escritos.filter((t) => PERGUNTA.test(t)).map((t) => PERGUNTA.exec(t)[1]);
  p.emitir = (obj) => p.linhaCb(typeof obj === 'string' ? obj : JSON.stringify(obj));
  p.sair = (codigo = 0) => { if (!p.morto) { p.morto = true; p.sairCb(codigo); } };
  return p;
}
const criar = (p, extra = {}) => M.criarCoordenacaoPorGuardiao({ ...BASE, iniciarProcesso: p.iniciar, ...extra });
async function adquirida(p, extra) {
  const coord = criar(p, extra);
  const espera = coord.adquirir();
  p.emitir({ evento: 'ADQUIRIDA', cadeados: 4 });
  assert.deepEqual(await espera, { ok: true });
  return coord;
}
const respondendo = (p) => {
  p.aoEscrever = (t) => {
    const m = PERGUNTA.exec(t);
    if (m) setImmediate(() => p.emitir({ evento: 'CONFIRMADA', id: m[1] }));
    if (t === 'liberar\n') setImmediate(() => { p.emitir({ evento: 'LIBERADA' }); p.sair(0); });
  };
};

describe('provedor: aquisição', () => {
  test('inicia o guardião com o comando, o diretório e só o caminho da credencial; sem aquisição não há processo', async () => {
    const p = processoFalso();
    const coord = criar(p);
    assert.equal(p.iniciado, null);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.iniciado, null, 'consultar não inicia nada');
    const espera = coord.adquirir();
    assert.deepEqual(p.iniciado, { comando: process.execPath, args: ['/baseline/scripts/guardiao-de-coordenacao.js', '--credencial', '/etc/safework/credencial.json', '--sistema', SISTEMA], opcoes: { cwd: '/baseline' } });
    p.emitir({ evento: 'ADQUIRIDA', cadeados: 4 });
    assert.deepEqual(await espera, { ok: true });
  });

  for (const motivo of ['EM_USO', 'MIGRACAO_EM_CURSO']) {
    test(`operação concorrente (${motivo}): recusa imediata e o estado informado é OCUPADO`, async () => {
      const p = processoFalso();
      const coord = criar(p);
      const espera = coord.adquirir();
      p.emitir({ evento: 'RECUSADA', motivo }); p.sair(4);
      assert.deepEqual(await espera, { ok: false, motivo });
      const estado = await coord.consultar();
      assert.equal(estado.situacao, 'OCUPADO');
      assert.equal(estado.detalhe, motivo);
      assert.equal(C.avaliarCoordenacao({ tipo: 'backend', estado }).bloqueio.codigo, 'OPERACAO_EM_CURSO');
    });
  }

  test('outras recusas (identidade, credencial, conexão) deixam o estado DESCONHECIDO, nunca LIVRE', async () => {
    for (const motivo of ['GUARDIAO_IDENTIDADE_DIVERGENTE', 'GUARDIAO_CREDENCIAL', 'GUARDIAO_CONEXAO', 'CONSULTA_FALHOU', 'qualquer']) {
      const p = processoFalso();
      const coord = criar(p);
      const espera = coord.adquirir();
      p.emitir({ evento: 'RECUSADA', motivo }); p.sair(4);
      assert.equal((await espera).ok, false);
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO', motivo);
    }
  });

  test('guardião que não responde, morre antes de responder ou fala fora do protocolo: indisponível e encerrado', async () => {
    const mudo = processoFalso();
    const c1 = criar(mudo);
    assert.deepEqual(await c1.adquirir(), { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' });
    assert.equal(mudo.matou, 1);
    assert.equal((await c1.consultar()).situacao, 'DESCONHECIDO');

    const morto = processoFalso();
    const c2 = criar(morto);
    const e2 = c2.adquirir(); morto.sair(1);
    assert.deepEqual(await e2, { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' });

    for (const lixo of ['não é json', '{"evento":"CONFIRMADA"}', '{"evento":"OUTRO"}', '[]', '{"evento":"ADQUIRIDA"} lixo']) {
      const p = processoFalso();
      const c = criar(p);
      const e = c.adquirir(); p.emitir(lixo);
      assert.deepEqual(await e, { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' }, lixo);
      assert.equal(p.matou, 1);
      assert.equal((await c.consultar()).situacao, 'DESCONHECIDO');
    }
  });

  test('aquisição sem cadeados ou com contagem inválida nunca é aceita', async () => {
    for (const cadeados of [0, undefined, null, '4', -1, 1.5, [], true]) {
      const p = processoFalso();
      const coord = criar(p);
      const espera = coord.adquirir();
      p.emitir({ evento: 'ADQUIRIDA', cadeados });
      assert.deepEqual(await espera, { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' }, JSON.stringify(cadeados));
      assert.equal(p.matou, 1);
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      assert.deepEqual(p.perguntas(), []);
    }
  });

  test('a aquisição acontece uma vez só', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    assert.deepEqual(await coord.adquirir(), { ok: false, motivo: 'GUARDIAO_JA_INICIADO' });
  });

  test('configuração inválida é recusada na criação', () => {
    const semEncerrar = { adquirirMs: 150, confirmarMs: 150, liberarMs: 150 };
    for (const ruim of [{ comando: ['node', 'x.js'] }, { comando: [process.execPath] }, { comando: 'x' }, { dir: 'relativo' }, { credencial: 'relativa.json' }, { sistema: 'abc' }, { sistema: 123 }, { iniciarProcesso: 'x' }, { prazos: semEncerrar }]) {
      assert.throws(() => M.criarCoordenacaoPorGuardiao({ ...BASE, iniciarProcesso: processoFalso().iniciar, ...ruim }), (e) => e.codigo === 'COORDENACAO_CONFIG', JSON.stringify(ruim));
    }
  });
});

describe('provedor: LIVRE só com confirmação atual', () => {
  test('cada consulta pergunta ao guardião e só responde LIVRE com a resposta desta pergunta', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    const antes = Date.now();
    const espera = coord.consultar();
    await new Promise((r) => setImmediate(r));
    assert.equal(p.escritos.length, 1);
    assert.match(p.escritos[0], PERGUNTA);
    p.emitir({ evento: 'CONFIRMADA', id: p.perguntas()[0] });
    const estado = await espera;
    assert.equal(estado.situacao, 'LIVRE');
    assert.equal(estado.origem, 'guardiao-postgresql');
    assert.ok(Date.parse(estado.consultadoEm) >= antes - 5);
    assert.deepEqual(Object.keys(estado).sort(), ['consultadoEm', 'origem', 'situacao']);
    assert.equal(C.avaliarCoordenacao({ tipo: 'backend', estado }).ok, true, 'o formato atende ao contrato do instalador');
  });

  test('uma confirmação antiga ou não pedida não vale para a consulta seguinte', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    p.emitir({ evento: 'CONFIRMADA' });
    p.emitir({ evento: 'CONFIRMADA' });
    const estado = await coord.consultar();
    assert.equal(estado.situacao, 'DESCONHECIDO', 'ninguém respondeu a ESTA pergunta');
    assert.equal(p.matou, 1);
  });

  test('cada pergunta leva um identificador novo, de 32 hexadecimais', async () => {
    const p = processoFalso();
    respondendo(p);
    const coord = await adquirida(p);
    for (let i = 0; i < 5; i += 1) assert.equal((await coord.consultar()).situacao, 'LIVRE');
    assert.equal(p.perguntas().length, 5);
    assert.equal(new Set(p.perguntas()).size, 5);
  });

  for (const [nome, resposta] of [
    ['sem identificador', () => ({ evento: 'CONFIRMADA' })],
    ['identificador de formato inválido', () => ({ evento: 'CONFIRMADA', id: 'abc' })],
    ['identificador que não é texto', () => ({ evento: 'CONFIRMADA', id: 7 })],
    ['identificador desconhecido (fora de ordem)', () => ({ evento: 'CONFIRMADA', id: 'f'.repeat(32) })],
    ['identificador da pergunta em maiúsculas', (id) => ({ evento: 'CONFIRMADA', id: id.toUpperCase().replace(/^\d*$/, 'A'.repeat(32)) })],
  ]) {
    test(`CONFIRMADA com ${nome}: DESCONHECIDO e guardião encerrado`, async () => {
      const p = processoFalso();
      const coord = await adquirida(p);
      p.aoEscrever = (t) => { const m = PERGUNTA.exec(t); if (m) setImmediate(() => p.emitir(resposta(m[1]))); };
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      assert.equal(p.matou, 1);
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      assert.equal(p.perguntas().length, 1, 'depois da perda não pergunta de novo');
    });
  }

  test('resposta antiga (identificador da consulta anterior) não confirma a consulta atual', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    const ids = [];
    p.aoEscrever = (t) => { const m = PERGUNTA.exec(t); if (m) { ids.push(m[1]); setImmediate(() => p.emitir({ evento: 'CONFIRMADA', id: ids[0] })); } };
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO', 'a segunda pergunta recebeu o identificador da primeira');
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(p.matou, 1);
  });

  test('resposta repetida depois de já atendida encerra a garantia', async () => {
    const p = processoFalso();
    respondendo(p);
    const coord = await adquirida(p);
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    p.emitir({ evento: 'CONFIRMADA', id: p.perguntas()[0] });
    assert.equal(p.matou, 1);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.perguntas().length, 1);
  });

  test('resposta em duplicidade no mesmo instante: nem a própria consulta é dada como LIVRE', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    p.aoEscrever = (t) => { const m = PERGUNTA.exec(t); if (m) setImmediate(() => { p.emitir({ evento: 'CONFIRMADA', id: m[1] }); p.emitir({ evento: 'CONFIRMADA', id: m[1] }); }); };
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.matou, 1);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.perguntas().length, 1);
  });

  test('sem resposta no prazo: DESCONHECIDO, guardião encerrado e nenhuma consulta posterior volta a LIVRE', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.matou, 1);
    p.emitir({ evento: 'CONFIRMADA' });
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.perguntas().length, 1, 'depois da perda não pergunta de novo');
  });

  for (const evento of ['PERDIDA', 'EXPIRADA', 'CANAL_FECHADO', 'PROTOCOLO', 'LIBERADA']) {
    test(`aviso ${evento} vindo do guardião: a garantia acabou, DESCONHECIDO sem perguntar`, async () => {
      const p = processoFalso();
      const coord = await adquirida(p);
      p.emitir({ evento });
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      assert.deepEqual(p.escritos, []);
    });
  }

  test('processo do guardião morreu, linha fora do protocolo ou resposta errada à pergunta: DESCONHECIDO', async () => {
    const morto = processoFalso();
    const c1 = await adquirida(morto);
    morto.sair(137);
    assert.equal((await c1.consultar()).situacao, 'DESCONHECIDO');

    for (const resposta of ['lixo', '{"evento":"ADQUIRIDA"}', '{"evento":"ADQUIRIDA","cadeados":4}', '{"evento":"RECUSADA","motivo":"x"}']) {
      const p = processoFalso();
      const c = await adquirida(p);
      p.aoEscrever = () => setImmediate(() => p.emitir(resposta));
      assert.equal((await c.consultar()).situacao, 'DESCONHECIDO', resposta);
      assert.equal(p.matou, 1);
    }
  });

  test('consultas simultâneas são feitas uma de cada vez, cada uma com a própria resposta', async () => {
    const p = processoFalso();
    respondendo(p);
    const coord = await adquirida(p);
    const estados = await Promise.all([coord.consultar(), coord.consultar(), coord.consultar()]);
    assert.deepEqual(estados.map((e) => e.situacao), ['LIVRE', 'LIVRE', 'LIVRE']);
    assert.equal(p.perguntas().length, 3);
  });
});

describe('provedor: liberação', () => {
  test('pede a liberação, espera o guardião encerrar e é idempotente; depois disso o estado é DESCONHECIDO', async () => {
    const p = processoFalso();
    respondendo(p);
    const coord = await adquirida(p);
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    const [a, b] = await Promise.all([coord.liberar(), coord.liberar()]);
    assert.deepEqual(a, LIBERACAO('LIBERACAO_INFORMADA'));
    assert.deepEqual(b, a);
    assert.deepEqual(await coord.liberar(), a);
    assert.equal(p.escritos.filter((t) => t === 'liberar\n').length, 1);
    assert.equal(p.entradaFechada, true);
    assert.equal(p.matou, 0);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal(p.perguntas().length, 1);
  });

  test('processo que encerra sem informar a liberação: encerrado, mas a liberação não é dada como informada', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    p.aoEscrever = (t) => { if (t === 'liberar\n') setImmediate(() => p.sair(0)); };
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO'));
    assert.equal(p.matou, 0);
  });

  test('guardião que não encerra no prazo é derrubado; só a saída confirmada conta, e nunca como liberação comprovada', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
    assert.equal(p.matou, 1);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
    assert.equal(p.matou, 1);
  });

  test('saída atrasada depois do encerramento forçado, ainda dentro do prazo: encerrado', async () => {
    const p = processoFalso();
    p.morreDepoisMs = 40;
    const coord = await adquirida(p);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
  });

  test('processo que não encerra nem depois do sinal: INDETERMINADA, nunca sucesso; nova chamada tenta de novo', async () => {
    const p = processoFalso();
    p.naoMorre = true;
    const coord = await adquirida(p);
    const r1 = await coord.liberar();
    assert.deepEqual(r1, LIBERACAO('INDETERMINADA', true));
    assert.equal(r1.processoEncerrado, false);
    assert.equal('liberada' in r1, false);
    assert.equal(p.matou, 1);
    assert.deepEqual(await coord.liberar(), LIBERACAO('INDETERMINADA', true));
    assert.equal(p.matou, 2, 'a nova chamada sinaliza outra vez');
    assert.equal(p.escritos.filter((t) => t === 'liberar\n').length, 1);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    p.sair(null);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true), 'a saída que chegou depois passa a contar');
    assert.equal(p.matou, 2);
  });

  test('falha ao sinalizar o processo: sem exceção e INDETERMINADA', async () => {
    const p = processoFalso();
    p.falhaAoSinalizar = true;
    const coord = await adquirida(p);
    assert.deepEqual(await coord.liberar(), LIBERACAO('INDETERMINADA', true));
    assert.equal(p.matou, 1);
  });

  test('falha ao sinalizar depois de uma consulta sem resposta: DESCONHECIDO sem exceção', async () => {
    const p = processoFalso();
    p.falhaAoSinalizar = true;
    const coord = await adquirida(p);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
  });

  test('liberar sem ter adquirido ou depois de perda não falha nem inicia processo', async () => {
    const novo = processoFalso();
    assert.deepEqual(await criar(novo).liberar(), LIBERACAO('SEM_PROCESSO'));
    assert.equal(novo.iniciado, null);
    const p = processoFalso();
    const coord = await adquirida(p);
    p.sair(1);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO'));
    assert.deepEqual(p.escritos, []);
  });
});

describe('provedor: só o evento close comprova o encerramento de um processo iniciado', () => {
  // Filho simulado entregue ao iniciador REAL do módulo: mesmos eventos de um ChildProcess, sob controle do teste.
  function filhoFalso({ iniciado = true } = {}) {
    const f = new EventEmitter();
    if (iniciado) f.pid = 4321; // sem pid, como o Node deixa o processo que não chegou a existir
    f.stdin = new PassThrough();
    f.stdout = new PassThrough();
    f.sinais = 0;
    f.kill = () => { f.sinais += 1; if (f.aoSinalizar) return f.aoSinalizar(); return true; };
    f.fechar = (codigo = null) => { f.stdout.end(); setImmediate(() => f.emit('close', codigo)); };
    return f;
  }
  const comFilho = (f, extra = {}) => M.criarCoordenacaoPorGuardiao({ ...BASE, ...extra, iniciarProcesso: (c, a, o) => M.iniciarProcessoReal(c, a, { ...o, criarFilho: () => f }) });
  async function adquiridaCom(f, extra) {
    const coord = comFilho(f, extra);
    const espera = coord.adquirir();
    f.stdout.write('{"evento":"ADQUIRIDA","cadeados":4}\n');
    assert.deepEqual(await espera, { ok: true });
    return coord;
  }

  test('o iniciador real distingue falha ao iniciar, erro de sinal e encerramento', () => {
    const naoIniciou = filhoFalso({ iniciado: false });
    const p1 = M.iniciarProcessoReal('/x', [], { cwd: '/', criarFilho: () => naoIniciou });
    const saidas1 = [];
    p1.aoSair((codigo, motivo) => saidas1.push(motivo));
    naoIniciou.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    assert.deepEqual(saidas1, ['FALHA_AO_INICIAR']);

    const iniciado = filhoFalso();
    const p2 = M.iniciarProcessoReal('/x', [], { cwd: '/', criarFilho: () => iniciado });
    const saidas2 = [];
    p2.aoSair((codigo, motivo) => saidas2.push(motivo));
    iniciado.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    assert.deepEqual(saidas2, [], 'erro num processo iniciado não é encerramento');
    iniciado.aoSinalizar = () => { throw new Error('kill EPERM'); };
    assert.equal(p2.matar(), false);
    assert.deepEqual(saidas2, []);
    iniciado.emit('close', 0);
    assert.deepEqual(saidas2, ['ENCERRADO']);
    iniciado.emit('close', 0);
    iniciado.emit('error', new Error('x'));
    assert.deepEqual(saidas2, ['ENCERRADO'], 'uma única vez');
  });

  test('erro ao sinalizar sem close: INDETERMINADA, nunca PROCESSO_ENCERRADO; o close tardio é que passa a comprovar', async () => {
    const f = filhoFalso();
    // Como no Node: o sinal não entregue devolve false e ainda emite error no processo.
    f.aoSinalizar = () => { setImmediate(() => f.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))); return false; };
    const coord = await adquiridaCom(f);
    const r1 = await coord.liberar();
    assert.deepEqual(r1, LIBERACAO('INDETERMINADA', true));
    assert.equal(f.sinais, 1);
    assert.deepEqual(await coord.liberar(), LIBERACAO('INDETERMINADA', true));
    assert.equal(f.sinais, 2);
    f.fechar(null);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
    assert.equal(f.sinais, 2);
  });

  test('erro de sinal durante uma consulta sem resposta: DESCONHECIDO e, sem close, a liberação fica INDETERMINADA', async () => {
    const f = filhoFalso();
    f.aoSinalizar = () => { setImmediate(() => f.emit('error', new Error('kill EPERM'))); return false; };
    const coord = await adquiridaCom(f);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    await new Promise((r) => setImmediate(r));
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.equal((await coord.liberar()).situacao, 'INDETERMINADA');
  });

  test('encerramento tardio, depois do sinal e dentro do prazo: PROCESSO_ENCERRADO com encerramento forçado', async () => {
    const f = filhoFalso();
    f.aoSinalizar = () => { setTimeout(() => f.fechar(null), 40); return true; };
    const coord = await adquiridaCom(f);
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
  });

  test('falha ao iniciar (filho simulado): indisponível, DESCONHECIDO e liberação SEM_PROCESSO, sem sinal', async () => {
    const f = filhoFalso({ iniciado: false });
    const coord = comFilho(f);
    const espera = coord.adquirir();
    f.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    assert.deepEqual(await espera, { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' });
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.deepEqual(await coord.liberar(), LIBERACAO('SEM_PROCESSO'));
    assert.equal(f.sinais, 0);
  });

  test('falha ao iniciar de verdade (executável inexistente): indisponível e liberação SEM_PROCESSO', async () => {
    const coord = M.criarCoordenacaoPorGuardiao({ ...BASE, comando: ['/nao/existe/executavel-do-guardiao', '/x.js'], dir: os.tmpdir(), prazos: { adquirirMs: 5000, confirmarMs: 150, liberarMs: 150, encerrarMs: 150 } });
    assert.deepEqual(await coord.adquirir(), { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' });
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.deepEqual(await coord.liberar(), LIBERACAO('SEM_PROCESSO'));
  });
});

describe('provedor: isolado e não homologado', () => {
  const fonte = fs.readFileSync(ARQ, 'utf8');
  test('o provedor não está na lista de homologados do instalador', async () => {
    const p = processoFalso();
    const coord = await adquirida(p);
    assert.equal(C.provedorHomologado(coord.consultar), false);
  });
  test('o módulo não importa o instalador, o agente nem a coordenação, e não homologa nada', () => {
    assert.doesNotMatch(fonte, /require\([^)]*(?:instalador|agente|coordenacao['"])/);
    assert.doesNotMatch(fonte, /homologar|PROVEDORES_HOMOLOGADOS/);
  });
  test('não lê ambiente, não conhece senha e não repassa mensagem do guardião além dos códigos previstos', () => {
    assert.doesNotMatch(fonte, /process\.env|senha|PASSWORD/);
  });
  // 3B-2B-1: o agente do backend passa a usar o provedor. O instalador, a coordenação e o agente do frontend, não.
  test('só o agente do backend usa o provedor; instalador, coordenação e agente do frontend continuam sem conhecê-lo', () => {
    assert.match(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente-backend.js'), 'utf8'), /require\('\.\/coordenacao-por-guardiao'\)/);
    for (const rel of ['deploy/hml/cd/agente.js', 'deploy/hml/instalador/instalar-release.js', 'deploy/hml/instalador/coordenacao.js', 'deploy/hml/instalador/nucleo.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, rel), 'utf8'), /coordenacao-por-guardiao|guardiao-de-coordenacao/, rel);
    }
  });
});

describe('provedor com processos reais (sem banco)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'coord-guardiao-')); });
  const iniciados = [];
  // Um teste que falha no meio não pode deixar processo filho vivo segurando o processo de teste.
  afterEach(() => {
    for (const processo of iniciados.splice(0)) processo.matar();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const REAIS = { adquirirMs: 20000, confirmarMs: 20000, liberarMs: 20000, encerrarMs: 20000 };
  const SINTETICAS = {
    AWS_ACCESS_KEY_ID: 'AKIASINTETICA0000000', AWS_SECRET_ACCESS_KEY: 'segredo-aws-sintetico', AWS_SESSION_TOKEN: 'token-aws-sintetico',
    NODE_OPTIONS: '--max-old-space-size=256', NODE_PATH: '/caminho/sintetico/node_modules', PGPASSWORD: 'senha-pg-sintetica',
    DATABASE_URL: 'postgres://u:senha-sintetica@h/b', GITHUB_TOKEN: 'token-gh-sintetico', SAFEWORK_SEGREDO_SINTETICO: 'valor-sintetico',
  };
  // Guardião de verdade (backend/scripts) com um PostgreSQL simulado dentro do processo filho. O cenário vem por arquivo.
  function guardiaoReal(cenario = {}) {
    const credencial = path.join(dir, 'credencial.json');
    fs.writeFileSync(credencial, JSON.stringify({ host: '127.0.0.1', porta: 5432, banco: 'hml', usuario: 'guardiao', senha: 'segredo-do-guardiao' }), { mode: 0o600 });
    const registro = path.join(dir, 'registro.json');
    const roteiro = path.join(dir, 'guardiao-com-banco-simulado.js');
    fs.writeFileSync(roteiro, `'use strict';
const fs = require('node:fs');
const G = require(${JSON.stringify(path.join(RAIZ, 'backend/scripts/guardiao-de-coordenacao.js'))});
const D = require(${JSON.stringify(path.join(RAIZ, 'backend/src/services/backup-fontes-coordenacao-operacoes.service.js'))});
const cenario = ${JSON.stringify(cenario)};
const locks = new Map(Object.entries(cenario.ocupadas || {}));
let proxima = 1;
const marcas = {};
const gravar = (marca = {}) => fs.writeFileSync(${JSON.stringify(registro)}, JSON.stringify({ ...Object.assign(marcas, marca), locks: [...locks.keys()], ambiente: Object.keys(process.env), valores: Object.values(process.env).join('|'), execArgv: process.execArgv, argv: process.argv.slice(2) }));
class Client {
  constructor() {
    this.id = 'sessao-' + proxima++; this.ouvintes = {};
    this.connection = { stream: { destroy: () => { clearInterval(this.soquete); for (const [k, d] of [...locks]) if (d === this.id) locks.delete(k); gravar({ destruido: true }); } } };
  }
  on(e, cb) { (this.ouvintes[e] = this.ouvintes[e] || []).push(cb); }
  async connect() { this.aberta = true; }
  async query(sql) {
    if (/pg_control_system/.test(sql)) return { rows: [{ banco: 'hml', em_recuperacao: false, sistema: cenario.sistema || ${JSON.stringify(SISTEMA)} }] };
    let m = /pg_try_advisory_lock\\((\\d+)\\)/.exec(sql);
    if (m) { const dono = locks.get(m[1]); if (dono !== undefined && dono !== this.id) return { rows: [{ tomado: false }] }; locks.set(m[1], this.id); gravar(); return { rows: [{ tomado: true }] }; }
    m = /pg_advisory_unlock\\((\\d+)\\)/.exec(sql);
    if (m) { const meu = locks.get(m[1]) === this.id; if (meu) locks.delete(m[1]); gravar(); return { rows: [{ liberado: meu }] }; }
    if (/FROM pg_locks/.test(sql)) return { rows: [...locks].filter(([, d]) => d === this.id).map(([chave]) => ({ chave })) };
    throw new Error('consulta inesperada');
  }
  async end() {
    // Encerramento preso: como um soquete aberto, mantém o processo vivo até ser destruído.
    if (cenario.travarEncerramento) { this.soquete = setInterval(() => {}, 1000); await new Promise(() => {}); }
    for (const [k, d] of [...locks]) if (d === this.id) locks.delete(k); gravar();
  }
}
gravar();
G.comoComando({ rodar: () => G.executar({ Client, adquirirExclusao: D.adquirirExclusao, cadeadosDe: D.cadeadosDe, limites: cenario.limites ? { ...G.LIMITES, ...cenario.limites } : undefined }) });
`);
    // O processo é iniciado pelo iniciador real do módulo; o teste só guarda a alça para poder derrubá-lo.
    const alca = {};
    const iniciarProcesso = (...a) => { alca.processo = M.iniciarProcessoReal(...a); iniciados.push(alca.processo); return alca.processo; };
    const coord = M.criarCoordenacaoPorGuardiao({ comando: [process.execPath, roteiro], dir, credencial, sistema: SISTEMA, prazos: { ...REAIS, ...(cenario.prazos || {}) }, iniciarProcesso });
    return { coord, alca, lerRegistro: () => JSON.parse(fs.readFileSync(registro, 'utf8')) };
  }

  test('guardião real cujo encerramento do cliente nunca responde: termina sozinho no prazo, sem ser derrubado e sem informar liberação', async () => {
    const { coord, lerRegistro } = guardiaoReal({ travarEncerramento: true, limites: { encerramentoMs: 300 }, prazos: { liberarMs: 6000 } });
    assert.deepEqual(await coord.adquirir(), { ok: true });
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO'), 'saiu por conta própria (não forçado) e sem aviso de liberação');
    assert.equal(lerRegistro().destruido, true);
  });

  test('guardião real que perde o canal de controle com o encerramento preso não fica vivo', async () => {
    const { coord, alca } = guardiaoReal({ travarEncerramento: true, limites: { encerramentoMs: 300 } });
    assert.deepEqual(await coord.adquirir(), { ok: true });
    const saiu = new Promise((r) => alca.processo.aoSair(() => r(true)));
    alca.processo.fecharEntrada();
    let relogio;
    const resultado = await Promise.race([saiu, new Promise((r) => { relogio = setTimeout(() => r(false), 6000); })]);
    clearTimeout(relogio);
    assert.equal(resultado, true, 'o processo terminou sozinho');
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
  });

  test('adquire, confirma mais de uma vez e libera com o guardião real: os quatro cadeados são tomados e soltos', async () => {
    const { coord, lerRegistro } = guardiaoReal();
    assert.deepEqual(await coord.adquirir(), { ok: true });
    assert.equal(lerRegistro().locks.length, 4);
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    assert.deepEqual(await coord.liberar(), LIBERACAO('LIBERACAO_INFORMADA'));
    assert.deepEqual(lerRegistro().locks, []);
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    const reg = lerRegistro();
    assert.deepEqual(reg.argv.filter((a) => /segredo/.test(a)), [], 'a senha não vai em argumento');
    assert.equal(reg.ambiente.some((k) => /SONDA|GUARDIAO|PGPASSWORD|DB_PASSWORD/.test(k)), false);
  });

  test('o guardião não herda o ambiente do agente: credenciais AWS, NODE_OPTIONS, NODE_PATH e demais variáveis ficam de fora', async () => {
    const antes = {};
    for (const [k, v] of Object.entries(SINTETICAS)) { antes[k] = process.env[k]; process.env[k] = v; }
    try {
      const { coord, lerRegistro } = guardiaoReal();
      assert.deepEqual(await coord.adquirir(), { ok: true });
      assert.equal((await coord.consultar()).situacao, 'LIVRE');
      const reg = lerRegistro();
      for (const k of Object.keys(SINTETICAS)) assert.equal(reg.ambiente.includes(k), false, `${k} foi herdada`);
      assert.doesNotMatch(reg.valores, /sintetic|AKIASINTETICA/i);
      assert.deepEqual(reg.execArgv, []);
      // O macOS acrescenta por conta própria uma variável de codificação a todo processo; nada além dela é admitido.
      assert.deepEqual(reg.ambiente.filter((k) => k !== '__CF_USER_TEXT_ENCODING'), []);
      assert.deepEqual(reg.argv.filter((a) => /sintetic|AKIASINTETICA/i.test(a)), []);
      assert.deepEqual(await coord.liberar(), LIBERACAO('LIBERACAO_INFORMADA'));
    } finally {
      for (const k of Object.keys(SINTETICAS)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
    }
  });

  test('processo real que ignora o pedido de liberação: é derrubado e só então dado como encerrado, com encerramento forçado', async () => {
    const surdo = path.join(dir, 'surdo.js');
    fs.writeFileSync(surdo, "'use strict';\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {});\nsetInterval(() => {}, 1000);\nprocess.stdout.write('{\"evento\":\"ADQUIRIDA\",\"cadeados\":4}\\n');\n");
    const alca = {};
    const iniciarProcesso = (...a) => { alca.processo = M.iniciarProcessoReal(...a); iniciados.push(alca.processo); return alca.processo; };
    const coord = M.criarCoordenacaoPorGuardiao({ comando: [process.execPath, surdo], dir, credencial: path.join(dir, 'c.json'), sistema: SISTEMA, prazos: { ...REAIS, liberarMs: 300 }, iniciarProcesso });
    assert.deepEqual(await coord.adquirir(), { ok: true });
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO', true));
    assert.equal(alca.processo.matar(), false, 'sinalizar um processo já encerrado informa que não entregou');
  });

  test('backup em curso (cadeado de migração ocupado por outra sessão): recusa e informa OCUPADO, sem tomar nada', async () => {
    const D = require(path.join(RAIZ, 'backend/src/services/backup-fontes-coordenacao-operacoes.service.js'));
    const ocupadas = Object.fromEntries(D.cadeadosDe('BACKUP').map((c) => [String(c), 'sessao-do-backup']));
    const { coord, lerRegistro } = guardiaoReal({ ocupadas });
    assert.deepEqual(await coord.adquirir(), { ok: false, motivo: 'MIGRACAO_EM_CURSO' });
    assert.equal((await coord.consultar()).situacao, 'OCUPADO');
    assert.deepEqual(lerRegistro().locks.sort(), Object.keys(ocupadas).sort(), 'só os cadeados do backup continuam');
  });

  test('cluster diferente do esperado: recusa e fica DESCONHECIDO', async () => {
    const { coord, lerRegistro } = guardiaoReal({ sistema: '7499999999999999999' });
    assert.deepEqual(await coord.adquirir(), { ok: false, motivo: 'GUARDIAO_IDENTIDADE_DIVERGENTE' });
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.deepEqual(lerRegistro().locks, []);
  });

  test('guardião real derrubado no meio: a consulta seguinte é DESCONHECIDO', async () => {
    const { coord, alca } = guardiaoReal();
    assert.deepEqual(await coord.adquirir(), { ok: true });
    assert.equal((await coord.consultar()).situacao, 'LIVRE');
    alca.processo.matar();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
    assert.deepEqual(await coord.liberar(), LIBERACAO('PROCESSO_ENCERRADO'));
  });
});
