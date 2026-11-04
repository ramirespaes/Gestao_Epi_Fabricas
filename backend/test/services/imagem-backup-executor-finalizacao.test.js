'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');
const { SAIDAS } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-SNAP-EXE-FIN, reforçado no RED-2): integração da FINALIZAÇÃO do snapshot ao executor
 * supervisionado. Só unitário e em memória: trava, processo do dump, grupo, sinais e recursos são falsos; nenhum processo, banco, disco ou relógio real.
 * Sincronização por promessas controladas (nenhuma espera arbitrária); cada teste tem prazo próprio para nunca ficar pendurado.
 *
 * CONTRATO PROPOSTO (provisório; nomes ainda NÃO aprovados; nada de produção foi alterado nesta fase):
 *   `executarBackupSupervisionado(dependencias)` passa a aceitar, além das chaves atuais, `finalizar` (função assíncrona), que o executor apenas
 *   REPASSA ao coordenador `executarBackup` (na prática, a `finalizar` de `criarSnapshot()`):
 *   - INTEIRAMENTE AUSENTE (nem a chave existe): comportamento histórico, `finalizacao === 'NAO_APLICAVEL'`;
 *   - PRESENTE (inclusive `undefined` explícito ou `null`) e não função: dependências inválidas, saída 2 antes da trava, sem efeito algum;
 *   - as regras do coordenador (GREEN-FIN-1/1A) valem pelo executor: no máximo uma vez, só com a trava adquirida, depois da última etapa e da avaliação
 *     e antes de qualquer liberação; ADIADA quando a supervisão exige retenção; não concluída retém a trava; posse perdida prevalece; posse
 *     inconclusiva depois da finalização nunca libera; o contexto recebido é imutável;
 *   - a descrição do processo do dump NÃO pode trazer nem sobrescrever `finalizar`; o supervisor real continua obrigatório;
 *   - `recuperavel` é SEMPRE false: nada aqui é prova de restauração independente.
 *   FORA deste incremento (não testado aqui): entrada operacional futura com finalização obrigatória, compondo `abrir()` e `finalizar()` da MESMA
 *   instância de `criarSnapshot()`; prazo da finalização; ligação real com o snapshot.
 */

const MODULO = 'src/services/imagem-backup-executor.service';
const executor = () => exigirModulo(MODULO);
const SAIDA_SINAL_SIGINT = 130;
const PGID = 5150;
const PRAZO_DO_TESTE = 10000;
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const VALIDO = () => ({ valido: true, motivos: [] });
const ETAPAS = Object.freeze(['snapshot', 'dump', 'copia']);

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);

function adiado() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

function criarMundo({ termino = { codigo: 0, sinal: null }, vivos = false, terminoControlado = false, ocupada = false, iniciarFalha = null } = {}) {
  const linha = [];
  const estado = { documento: ocupada ? { tipo: TIPOS.LIMPEZA, token: 'token-alheio' } : null, liberacoes: 0, aquisicoes: 0, posseLanca: false };
  const saida = adiado();
  if (!terminoControlado) saida.resolver(termino);
  const dumpIniciado = adiado();
  const copiaIniciada = adiado();
  const paradaPronta = adiado(); // resolvida quando coordenador E supervisor registraram o ouvinte de parada
  const ouvintes = [];
  let proximo = 0;
  const contextos = [];
  const contagem = { snapshot: 0, copia: 0, avaliar: 0, finalizar: 0, processoDoDump: 0 };

  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push('adquirir');
      if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      proximo += 1;
      const token = `token-${proximo}`;
      estado.documento = { tipo: argumentos.tipo, token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() {
          linha.push('confirmarPosse');
          if (estado.posseLanca) throw new Error('conferência de posse simulada falhou');
          return { confirmada: estado.documento !== null && estado.documento.token === token };
        },
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

  const parada = {
    aoPedir(f) {
      ouvintes.push(f);
      if (ouvintes.length >= 2) paradaPronta.resolver();
    },
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
    async snapshot() { contagem.snapshot += 1; linha.push('snapshot'); return { ok: true }; },
    processoDoDump() { contagem.processoDoDump += 1; linha.push('processoDoDump'); return opcoesDoProcesso(); },
    async copia() { contagem.copia += 1; linha.push('copia'); copiaIniciada.resolver(); return { ok: true }; },
    avaliar() { contagem.avaliar += 1; linha.push('avaliar'); return VALIDO(); },
    async finalizar(contexto) { contagem.finalizar += 1; linha.push('finalizar'); contextos.push(contexto); return { concluida: true }; },
  };
  return {
    linha, estado, contagem, contextos, dependencias, opcoesDoProcesso, parada, pedirParada, ouvintes, paradaPronta, dumpIniciado, copiaIniciada,
    terminar: (t) => { linha.push('dump:termino'); saida.resolver(t); },
  };
}

const indice = (linha, evento) => linha.indexOf(evento);
const antes = (linha, a, b) => indice(linha, a) !== -1 && indice(linha, b) !== -1 && indice(linha, a) < indice(linha, b);
const executar = (m) => executor().executarBackupSupervisionado(m.dependencias);
/** Espera um evento do mundo SEM pendurar o teste: se a execução terminar antes dele, falha com a causa em vez de esperar o prazo. */
async function ate(evento, pendente, rotulo) {
  const quem = await Promise.race([evento.then(() => 'evento'), pendente.then(() => 'terminou', () => 'terminou')]);
  assert.equal(quem, 'evento', `a execução terminou antes de: ${rotulo}`);
}

describe('[EXE-FIN] a finalização do snapshot passa pelo executor', () => {
  teste('FIN-01 — caminho feliz: finalizar roda UMA vez, depois do dump supervisionado, da cópia e da avaliação e antes de liberar; contexto exato; saída 0', async () => {
    const m = criarMundo();
    const r = await executar(m);
    assert.equal(m.contagem.finalizar, 1, 'exatamente uma vez');
    assert.ok(antes(m.linha, 'dump:grupo.vivos', 'copia'), 'o dump passou pelo supervisor antes da cópia');
    assert.ok(antes(m.linha, 'copia', 'avaliar'));
    assert.ok(antes(m.linha, 'avaliar', 'finalizar'));
    assert.ok(antes(m.linha, 'finalizar', 'liberar'), 'a finalização segura vem antes de soltar a trava');
    assert.deepEqual(m.contextos[0], { posse: 'CONFIRMADA', etapasExecutadas: ['snapshot', 'dump', 'copia'], interrompido: false });
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.recuperavel, false, 'nada aqui é prova de restauração');
    assert.equal(r.supervisao.concluido, true);
    assert.equal(m.estado.liberacoes, 1);
  });

  teste('FIN-02 — a finalização só começa depois que a última etapa INICIADA terminou: dump pendente e cópia pendente seguram a finalização', async () => {
    const m = criarMundo({ terminoControlado: true });
    const copia = adiado();
    m.dependencias.copia = async () => { m.contagem.copia += 1; m.linha.push('copia'); m.copiaIniciada.resolver(); await copia.promessa; m.linha.push('copia:fim'); return { ok: true }; };
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    assert.equal(m.linha.includes('finalizar'), false, 'dump em andamento: nada de finalizar');
    m.terminar({ codigo: 0, sinal: null });
    await ate(m.copiaIniciada.promessa, pendente, 'a cópia iniciar');
    assert.equal(m.linha.includes('finalizar'), false, 'cópia em andamento: nada de finalizar');
    copia.resolver();
    const r = await pendente;
    assert.ok(antes(m.linha, 'dump:termino', 'finalizar'));
    assert.ok(antes(m.linha, 'copia:fim', 'finalizar'));
    assert.ok(antes(m.linha, 'finalizar', 'liberar'));
    assert.equal(m.contagem.finalizar, 1);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });
});

describe('[EXE-FIN] falha de etapa com encerramento seguro: a sequência para, a finalização roda, a falha não vira sucesso', () => {
  const casos = [
    {
      rotulo: 'snapshot falha',
      ajustar: (m) => { m.dependencias.snapshot = async () => { m.contagem.snapshot += 1; m.linha.push('snapshot'); return { ok: false }; }; },
      etapas: ['snapshot'], dump: false, copia: 0,
    },
    {
      rotulo: 'dump termina com falha comprovada (código 1)',
      ajustar: (m) => m.terminar({ codigo: 1, sinal: null }),
      etapas: ['snapshot', 'dump'], dump: true, copia: 0, terminoControlado: true,
    },
    {
      rotulo: 'cópia devolve falha',
      ajustar: (m) => { m.dependencias.copia = async () => { m.contagem.copia += 1; m.linha.push('copia'); return { ok: false }; }; },
      etapas: ETAPAS, dump: true, copia: 1,
    },
    {
      rotulo: 'cópia lança',
      ajustar: (m) => { m.dependencias.copia = async () => { m.contagem.copia += 1; m.linha.push('copia'); throw new Error('falha simulada'); }; },
      etapas: ETAPAS, dump: true, copia: 1,
    },
  ];
  for (const caso of casos) {
    teste(`FIN-03 (${caso.rotulo})`, async () => {
      const m = criarMundo({ terminoControlado: caso.terminoControlado === true });
      caso.ajustar(m);
      const r = await executar(m);
      assert.equal(m.contagem.finalizar, 1);
      assert.ok(antes(m.linha, 'finalizar', 'liberar'));
      assert.deepEqual(m.contextos[0].etapasExecutadas, caso.etapas);
      assert.deepEqual([...r.etapasExecutadas], caso.etapas);
      assert.equal(m.contagem.snapshot, 1);
      assert.equal(m.linha.includes('dump:iniciar'), caso.dump, 'o dump só inicia se o snapshot deu certo');
      assert.equal(m.contagem.copia, caso.copia, 'a cópia só roda se snapshot e dump deram certo (e nunca é repetida)');
      assert.equal(m.contagem.avaliar, 0, 'a avaliação não roda sobre sequência falha');
      assert.equal(r.finalizacao, 'CONCLUIDA');
      assert.equal(r.valido, false);
      assert.equal(r.saida, SAIDAS.INVALIDO);
      assert.equal(r.recuperavel, false);
      assert.equal(r.janela, 'LIBERADA');
      assert.equal(m.estado.liberacoes, 1);
    });
  }

  teste('FIN-03b — avaliação que lança: a finalização ainda roda uma vez, antes de liberar; saída ERRO; inválido e não recuperável', async () => {
    const m = criarMundo();
    m.dependencias.avaliar = () => { m.contagem.avaliar += 1; m.linha.push('avaliar'); throw new Error('avaliação simulada'); };
    const r = await executar(m);
    assert.equal(m.contagem.finalizar, 1);
    assert.ok(antes(m.linha, 'avaliar', 'finalizar'));
    assert.ok(antes(m.linha, 'finalizar', 'liberar'));
    assert.equal(r.saida, SAIDAS.ERRO);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.ok(r.motivos.includes('AVALIACAO_FALHOU'));
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });
});

describe('[EXE-FIN] supervisão que não comprova o encerramento: trava retida, finalização adiada', () => {
  teste('FIN-04 — grupo do dump ainda VIVO: o supervisor real foi consultado, finalizar NÃO é chamada, ADIADA, trava RETIDA (11), liberar nunca chamado, cópia não roda', async () => {
    const m = criarMundo({ vivos: true });
    const r = await executar(m);
    assert.ok(m.linha.includes('dump:grupo.vivos'), 'quem decidiu foi o supervisor real');
    assert.equal(m.contagem.finalizar, 0, 'nenhum recurso é encerrado com processo possivelmente vivo');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.supervisao.liberarTravaPermitido, false);
  });

  teste('FIN-04b — a descrição do processo traz `finalizar` próprio: com grupo VIVO ela nunca é chamada', async () => {
    const m = criarMundo({ vivos: true });
    let extra = 0;
    m.dependencias.processoDoDump = () => ({ ...m.opcoesDoProcesso(), finalizar: async () => { extra += 1; return { concluida: true }; } });
    const r = await executar(m);
    assert.equal(extra, 0);
    assert.equal(m.contagem.finalizar, 0);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('FIN-04c — término SEGURO do supervisor: a `finalizar` da descrição do processo nunca é chamada; só a da dependência, exatamente uma vez; o supervisor real roda', async () => {
    const m = criarMundo();
    let extra = 0;
    m.dependencias.processoDoDump = () => ({ ...m.opcoesDoProcesso(), finalizar: async () => { extra += 1; return { concluida: true }; }, finalizacao: async () => { extra += 1; return { concluida: true }; } });
    const r = await executar(m);
    assert.equal(extra, 0, 'nada vindo da descrição do processo é usado como finalização');
    assert.equal(m.contagem.finalizar, 1, 'só a dependência legítima, uma vez');
    assert.ok(m.linha.includes('dump:iniciar') && m.linha.includes('dump:grupo.vivos'), 'o supervisor real continua obrigatório');
    assert.equal(r.supervisao.concluido, true);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  for (const [rotulo, ajustar] of [
    ['o processo não pôde ser iniciado', () => {}],
    ['a descrição do processo lança', (m) => { m.dependencias.processoDoDump = () => { m.contagem.processoDoDump += 1; throw new Error('descrição do processo quebrou'); }; }],
  ]) {
    teste(`FIN-09 (${rotulo}) — a supervisão não autoriza liberar: finalizar NÃO é chamada (ADIADA), trava RETIDA (11), liberar nunca chamado, cópia não roda`, async () => {
      const m = criarMundo({ iniciarFalha: rotulo.startsWith('o processo') ? Object.assign(new Error('spawn falhou'), { code: 'ENOENT' }) : null });
      ajustar(m);
      const r = await executar(m);
      assert.equal(m.contagem.finalizar, 0);
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(r.finalizacao, 'ADIADA');
      assert.equal(r.janela, 'RETIDA');
      assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(m.contagem.copia, 0);
      assert.ok(r.motivos.includes('LIBERACAO_NEGADA_PELA_SUPERVISAO'));
    });
  }
});

describe('[EXE-FIN] finalização incompleta, falha ou exceção impede o sucesso', () => {
  for (const [rotulo, resposta] of [
    ['resposta vazia', async () => ({})],
    ['concluida:false', async () => ({ concluida: false })],
    ['concluida truthy mas não true', async () => ({ concluida: 'true' })],
    ['sem resposta', async () => undefined],
    ['resposta nula', async () => null],
    ['lança', async () => { throw new Error('falha simulada'); }],
  ]) {
    teste(`FIN-05 (${rotulo}) — backup NÃO é válido, NAO_CONCLUIDA, trava RETIDA (11), liberar nunca chamado, sem nova tentativa`, async () => {
      const m = criarMundo();
      m.dependencias.finalizar = async (contexto) => { m.contagem.finalizar += 1; m.linha.push('finalizar'); return resposta(contexto); };
      const r = await executar(m);
      assert.equal(m.contagem.finalizar, 1);
      assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
      assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'));
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
      assert.equal(r.janela, 'RETIDA');
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(m.linha.includes('liberar'), false);
    });
  }

  teste('FIN-05b — a posse é conferida de novo DEPOIS da finalização (a finalização pode demorar)', async () => {
    const m = criarMundo();
    await executar(m);
    const i = indice(m.linha, 'finalizar');
    assert.ok(m.linha.slice(i + 1).includes('confirmarPosse'), 'conferência de posse depois de finalizar');
    assert.ok(indice(m.linha, 'liberar') > i + m.linha.slice(i + 1).indexOf('confirmarPosse'));
  });
});

describe('[EXE-FIN] perda e incerteza da posse da trava', () => {
  teste('FIN-06 — posse perdida durante a cópia: a avaliação NÃO roda, finalizar recebe PERDIDA e as etapas executadas, liberar NUNCA é chamado, saída 10', async () => {
    const m = criarMundo();
    m.dependencias.copia = async () => { m.contagem.copia += 1; m.linha.push('copia'); m.estado.documento = { tipo: TIPOS.BACKUP, token: 'token-alheio' }; return { ok: true }; };
    const r = await executar(m);
    assert.equal(m.contagem.avaliar, 0, 'nunca avalia com a posse perdida');
    assert.equal(m.contagem.finalizar, 1);
    assert.deepEqual(m.contextos[0], { posse: 'PERDIDA', etapasExecutadas: ['snapshot', 'dump', 'copia'], interrompido: false });
    assert.equal(m.estado.liberacoes, 0, 'a trava é de outro: não se toca nela');
    assert.deepEqual(m.estado.documento, { tipo: TIPOS.BACKUP, token: 'token-alheio' });
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(r.saida, SAIDAS.JANELA_PERDIDA);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('FIN-06b — posse perdida DURANTE a finalização: finalizar roda uma vez, mesmo concluída liberar nunca é chamado, saída 10', async () => {
    const m = criarMundo();
    m.dependencias.finalizar = async (contexto) => {
      m.contagem.finalizar += 1; m.linha.push('finalizar'); m.contextos.push(contexto);
      m.estado.documento = { tipo: TIPOS.BACKUP, token: 'token-alheio' };
      return { concluida: true };
    };
    const r = await executar(m);
    assert.equal(m.contagem.finalizar, 1);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(r.saida, SAIDAS.JANELA_PERDIDA);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(m.estado.documento.token, 'token-alheio');
  });

  teste('FIN-10 — posse INCONCLUSIVA depois da finalização (a conferência lança): liberar nunca é chamado, janela NAO_LIBERADA, nunca válido', async () => {
    const m = criarMundo();
    m.dependencias.finalizar = async (contexto) => {
      m.contagem.finalizar += 1; m.linha.push('finalizar'); m.contextos.push(contexto);
      m.estado.posseLanca = true;
      return { concluida: true };
    };
    const r = await executar(m);
    assert.equal(m.contagem.finalizar, 1);
    assert.equal(m.estado.liberacoes, 0, 'sem posse comprovada a trava não é solta');
    assert.equal(r.janela, 'NAO_LIBERADA');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(r.saida, SAIDAS.ERRO);
    assert.ok(r.motivos.includes('POSSE_NAO_CONFERIDA'));
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });
});

describe('[EXE-FIN] interrupção por sinal', () => {
  teste('FIN-07 — SIGINT durante o snapshot: saída 130, trava LIBERADA, nenhuma etapa nova, finalizar roda uma vez com interrompido=true antes de liberar', async () => {
    const m = criarMundo();
    m.dependencias.parada = m.parada;
    m.dependencias.snapshot = async () => { m.contagem.snapshot += 1; m.linha.push('snapshot'); m.pedirParada('SIGINT'); return { ok: true }; };
    const r = await executar(m);
    assert.equal(m.linha.includes('dump:iniciar'), false, 'nenhuma etapa nova depois do sinal');
    assert.equal(m.contagem.processoDoDump, 0);
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.avaliar, 0);
    assert.equal(m.contagem.finalizar, 1);
    assert.deepEqual(m.contextos[0], { posse: 'CONFIRMADA', etapasExecutadas: ['snapshot'], interrompido: true });
    assert.ok(antes(m.linha, 'finalizar', 'liberar'));
    assert.equal(r.sinal, 'SIGINT');
    assert.ok(r.motivos.includes('INTERROMPIDO'));
    assert.equal(r.saida, SAIDA_SINAL_SIGINT);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.deepEqual([...r.etapasExecutadas], ['snapshot']);
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });

  teste('FIN-07b — SIGINT durante o dump com grupo VIVO: parada registrada pelos dois ouvintes e recebida pelo supervisor; trava RETIDA; finalização ADIADA (0 chamadas); nenhuma liberação', async () => {
    const m = criarMundo({ vivos: true, terminoControlado: true });
    m.dependencias.parada = m.parada;
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    await ate(m.paradaPronta.promessa, pendente, 'os ouvintes de parada serem registrados');
    assert.ok(m.ouvintes.length >= 2, 'coordenador e supervisor registraram o ouvinte de parada');
    assert.ok(m.linha.includes('dump:iniciar'), 'o dump efetivamente iniciou');
    m.pedirParada('SIGINT');
    m.terminar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.supervisao.parada, 'SIGINT', 'o supervisor recebeu a parada');
    assert.ok(m.linha.includes('dump:grupo.vivos'));
    assert.equal(r.supervisao.liberarTravaPermitido, false);
    assert.equal(m.contagem.finalizar, 0, 'a interrupção não antecipa o encerramento dos recursos');
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(m.estado.liberacoes, 0, 'sem prova de encerramento a trava não é solta');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('FIN-11 — SIGINT durante o dump com o grupo comprovadamente ENCERRADO: o supervisor recebe a parada, finalizar roda uma vez com interrompido=true, a trava é solta depois, a cópia não roda', async () => {
    const m = criarMundo({ vivos: false, terminoControlado: true });
    m.dependencias.parada = m.parada;
    const pendente = executar(m);
    await ate(m.dumpIniciado.promessa, pendente, 'o dump iniciar');
    await ate(m.paradaPronta.promessa, pendente, 'os ouvintes de parada serem registrados');
    m.pedirParada('SIGINT');
    m.terminar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(r.supervisao.parada, 'SIGINT');
    assert.equal(r.supervisao.liberarTravaPermitido, true);
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.finalizar, 1);
    assert.equal(m.contextos[0].interrompido, true);
    assert.equal(m.contextos[0].posse, 'CONFIRMADA');
    assert.ok(antes(m.linha, 'finalizar', 'liberar'));
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(m.estado.liberacoes, 1);
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDAS.VALIDO);
    assert.equal(r.recuperavel, false);
  });

  teste('FIN-12 — SIGINT DURANTE a finalização: é só anotado; nenhuma etapa nova, a finalização não é repetida, a trava só é solta depois dela; nunca válido', async () => {
    const m = criarMundo();
    m.dependencias.parada = m.parada;
    m.dependencias.finalizar = async (contexto) => {
      m.contagem.finalizar += 1; m.linha.push('finalizar:inicio'); m.contextos.push(contexto);
      m.pedirParada('SIGINT');
      m.linha.push('finalizar:fim');
      return { concluida: true };
    };
    const r = await executar(m);
    assert.equal(m.contagem.finalizar, 1, 'o sinal não repete nem reinicia a finalização');
    assert.deepEqual([...r.etapasExecutadas], ETAPAS, 'nenhuma etapa nova');
    assert.equal(m.contagem.snapshot + m.contagem.copia, 2);
    assert.ok(antes(m.linha, 'finalizar:fim', 'liberar'), 'não libera prematuramente');
    assert.equal(r.sinal, 'SIGINT');
    assert.ok(r.motivos.includes('INTERROMPIDO'));
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
    assert.equal(r.saida, SAIDA_SINAL_SIGINT);
    assert.equal(r.recuperavel, false);
  });
});

describe('[EXE-FIN] a finalização nunca é chamada sem trava adquirida', () => {
  teste('FIN-13 — janela OCUPADA: saída 6, nada roda, finalizar 0 vezes, NAO_APLICAVEL, a trava alheia fica como estava', async () => {
    const m = criarMundo({ ocupada: true });
    const alheio = structuredClone(m.estado.documento);
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.JANELA_OCUPADA);
    assert.equal(r.janela, 'OCUPADA');
    assert.equal(m.contagem.finalizar, 0);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(m.contagem.snapshot + m.contagem.copia + m.contagem.processoDoDump, 0);
    assert.equal(m.estado.liberacoes, 0);
    assert.deepEqual(m.estado.documento, alheio);
    assert.equal(r.recuperavel, false);
  });

  teste('FIN-14 — erro na aquisição da trava: saída ERRO, finalizar 0 vezes, NAO_APLICAVEL, nada roda', async () => {
    const m = criarMundo();
    m.dependencias.janela = { async adquirir() { m.estado.aquisicoes += 1; throw new Error('falha simulada na aquisição'); } };
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.ERRO);
    assert.equal(r.janela, 'NAO_ADQUIRIDA');
    assert.equal(m.contagem.finalizar, 0);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(m.contagem.snapshot + m.contagem.copia + m.contagem.processoDoDump, 0);
    assert.equal(r.recuperavel, false);
  });

  teste('FIN-14b — aquisição que não devolve o manipulador: saída ERRO, janela NAO_LIBERADA, finalizar 0 vezes, nada roda', async () => {
    const m = criarMundo();
    m.dependencias.janela = { async adquirir() { m.estado.aquisicoes += 1; return {}; } };
    const r = await executar(m);
    assert.equal(r.saida, SAIDAS.ERRO);
    assert.equal(r.janela, 'NAO_LIBERADA');
    assert.equal(m.contagem.finalizar, 0);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(m.contagem.snapshot + m.contagem.copia + m.contagem.processoDoDump, 0);
    assert.equal(r.recuperavel, false);
  });
});

describe('[EXE-FIN] o contexto da finalização é imutável', () => {
  teste('FIN-15 — o callback não consegue alterar `etapasExecutadas` nem o contexto: o resultado do executor continua exato', async () => {
    const m = criarMundo();
    const tentativas = [];
    m.dependencias.finalizar = async (contexto) => {
      m.contagem.finalizar += 1; m.linha.push('finalizar');
      assert.equal(Object.isFrozen(contexto), true);
      assert.equal(Object.isFrozen(contexto.etapasExecutadas), true);
      for (const tentativa of [
        () => { contexto.etapasExecutadas.push('intruso'); },
        () => { contexto.etapasExecutadas.length = 0; },
        () => { contexto.posse = 'PERDIDA'; },
        () => { contexto.interrompido = true; },
        () => { contexto.extra = 1; },
      ]) {
        try { tentativa(); tentativas.push('aceita'); } catch { tentativas.push('recusada'); }
      }
      return { concluida: true };
    };
    const r = await executar(m);
    assert.deepEqual(tentativas, ['recusada', 'recusada', 'recusada', 'recusada', 'recusada']);
    assert.deepEqual([...r.etapasExecutadas], ETAPAS);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.saida, SAIDAS.VALIDO);
  });
});

describe('[EXE-FIN] dependências inválidas e desconhecidas continuam recusadas sem efeito', () => {
  for (const [rotulo, valor] of [
    ['null', null],
    ['undefined explícito', undefined],
    ['texto', 'finalizar'],
    ['objeto', { concluida: true }],
    ['número', 1],
    ['lista', [async () => ({ concluida: true })]],
    ['booleano', true],
  ]) {
    teste(`FIN-08 (finalizar ${rotulo}) — saída 2 antes da trava: nada adquirido, nenhuma etapa, nenhum processo, nenhuma finalização`, async () => {
      const m = criarMundo();
      const r = await executor().executarBackupSupervisionado({ ...m.dependencias, finalizar: valor });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.snapshot + m.contagem.copia + m.contagem.finalizar + m.contagem.processoDoDump + m.contagem.avaliar, 0);
      assert.equal(m.linha.length, 0, 'nenhum efeito colateral');
    });
  }

  for (const [rotulo, extra] of [
    ['finalizacao (nome parecido)', { finalizacao: async () => ({ concluida: true }) }],
    ['snapshotFinalizar', { snapshotFinalizar: async () => ({ concluida: true }) }],
    ['etapas próprias', { etapas: [] }],
    ['supervisor substituto', { supervisionar: async () => ({ concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] }) }],
  ]) {
    teste(`FIN-08c (${rotulo}) — controle: chave desconhecida continua recusada (saída 2), sem trava e sem finalizar, mesmo com \`finalizar\` válida`, async () => {
      const m = criarMundo();
      const r = await executor().executarBackupSupervisionado({ ...m.dependencias, ...extra });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.finalizar, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  teste('FIN-08d — controle do comportamento histórico: com a chave `finalizar` INTEIRAMENTE ausente o executor segue válido e informa NAO_APLICAVEL (a entrada operacional com finalização obrigatória é outro incremento)', async () => {
    const m = criarMundo();
    const semFinalizar = { ...m.dependencias };
    delete semFinalizar.finalizar;
    assert.equal(Object.hasOwn(semFinalizar, 'finalizar'), false);
    const r = await executor().executarBackupSupervisionado(semFinalizar);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    assert.equal(r.recuperavel, false);
    assert.equal(m.contagem.finalizar, 0);
  });
});
