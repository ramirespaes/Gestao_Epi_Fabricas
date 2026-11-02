'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarOrcamentoDeBytes } = require('../../src/utils/orcamento-de-bytes');
const { criarServicoDePacote, criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso, novaRaiz, clienteFalso, linhas, DUMP_BYTES, PRAZOS, POLITICA } = require('../helpers/ambiente-backup-operacao');

/**
 * Consolidação P1 a P5: (1) cancelamento durante a verificação/publicação, (2) orçamento da SEGUNDA cópia do dump, (3) equivalência da supervisão da restauração e (4) compatibilidade das cinco proteções.
 * Só diretórios descartáveis, relógio manual, spawn e cliente falsos: nenhum processo, nenhum PostgreSQL, nenhuma AWS. Os números de prazo e de bytes são VALORES DE TESTE.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-cons-test-' });
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
  };
}

const somaDasImagens = () => {
  const l = linhas();
  return [...l.padrao, ...l.empresa].reduce((acc, r) => acc + [r.bytes_mestre, r.bytes_exibicao, r.bytes_miniatura].filter((n) => Number.isSafeInteger(n)).reduce((x, y) => x + y, 0), 0);
};
const executar = (a, nome = 'prep-1') => criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: nome, conjuntoId: 'conjunto-cons-0001' });
const erroCom = (code) => Object.assign(new Error('SEGREDO-NUNCA-EXPOR'), { code });

// ------------------------------------------------------------------------------------------------------------------------------- 1. cancelamento durante a publicação
describe('[CONS-1] cancelamento enquanto a verificação/publicação já está em andamento', () => {
  const ETAPA = 7101;
  const CORTESIA = 7102;
  /** Ambiente cujo relatório (porta 5 da publicação, DENTRO de `publicar`) fica retido num portão controlado pelo teste. */
  async function comPublicacaoRetida() {
    const relogio = relogioManual();
    const portao = adiado();
    const estado = { entrou: false };
    const a = await ambiente({
      portasExtras: { temporizador: relogio },
      alterarConfig: (c) => {
        c.operacoes = { etapaMs: ETAPA, cortesiaMs: CORTESIA };
        c.relatorio = { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: async () => { estado.entrou = true; await portao.promessa; return { ok: true }; } }), origensAceitas: ['TESTE_CONTROLADO'] };
        return c;
      },
    });
    return { a, relogio, portao, estado };
  }
  const publicados = (a) => fs.readdirSync(a.dirs.publicados);

  teste('CONS-1a — pedido de cancelamento DURANTE a publicação, que conclui dentro da cortesia: o pacote é publicado fisicamente (o contrato não interrompe), mas o veredito NUNCA é favorável, a avaliação do estado é conservadora (quarentena recomendada) e o resultado não vira backup válido', async () => {
    const m = await comPublicacaoRetida();
    const rodando = executar(m.a);
    await ate(() => m.estado.entrou, 'publicação em andamento');
    m.relogio.disparar(ETAPA);
    await ate(() => m.relogio.registrado(CORTESIA), 'cortesia iniciada');
    assert.deepEqual(publicados(m.a), [], 'a publicação física ainda não terminou');
    m.portao.resolver();
    const composto = await rodando;
    const c = composto.resultado.coordenador;
    assert.deepEqual([c.saida, c.valido], [9, false]);
    assert.ok(c.motivos.includes('ETAPA_EXPIRADA'));
    assert.deepEqual(publicados(m.a), ['prep-1'], 'a publicação já iniciada terminou (não é interrompível por este contrato)');
    assert.equal(composto.resultado.publicacao.publicada, true);
    const e = classificarEstadoDoBackup(composto);
    assert.deepEqual([e.backupOperacionalValido, e.recuperabilidadeComprovada, e.publicacaoOperacional, e.prontidaoOperacional], [false, false, false, false]);
    assert.equal(e.pacotePublicado, true);
    assert.deepEqual([e.quarentena.recomendada, [...e.quarentena.motivos]], [true, ['PUBLICADO_SOB_CANCELAMENTO_OU_PENDENCIA']]);
    assert.equal(composto.proveniencia.operacoes.pendentes, 0, 'a operação assentou: não foi dada como encerrada antes');
    assert.equal(composto.resultado.coordenador.janela, 'LIBERADA');
  });

  teste('CONS-1b — pedido de cancelamento e a publicação NÃO assenta na cortesia: CANCELAMENTO_NAO_CONFIRMADO, trava RETIDA no disco, preparação com o dump parcialmente empacotado PRESERVADA, nada publicado na saída e quarentena + recuperação autorizada exigidas', async () => {
    const m = await comPublicacaoRetida();
    const rodando = executar(m.a);
    await ate(() => m.estado.entrou, 'publicação em andamento');
    m.relogio.disparar(ETAPA);
    await ate(() => m.relogio.registrado(CORTESIA), 'cortesia iniciada');
    m.relogio.disparar(CORTESIA);
    const composto = await rodando;
    const c = composto.resultado.coordenador;
    assert.deepEqual([c.saida, c.janela, c.finalizacao, c.valido], [11, 'RETIDA', 'ADIADA', false]);
    for (const motivo of ['CANCELAMENTO_NAO_CONFIRMADO', 'ETAPA_EXPIRADA']) assert.ok(c.motivos.includes(motivo), motivo);
    assert.equal(fs.existsSync(path.join(m.a.raiz, 'janela.lock')), true);
    assert.deepEqual(publicados(m.a), []);
    assert.equal(fs.existsSync(path.join(m.a.dirs.preparacoes, 'prep-1', 'dump', 'postgres.dump')), true, 'o parcial (dump já incorporado) foi preservado, nada removido');
    assert.equal(composto.resultado.publicacao, null);
    assert.equal(composto.proveniencia.publicacao.faseNaSaida, 'PUBLICANDO');
    assert.equal(composto.proveniencia.operacoes.pendentes, 1);
    const e = classificarEstadoDoBackup(composto);
    assert.deepEqual([e.backupOperacionalValido, e.pacotePublicado, e.recuperabilidadeComprovada], [false, false, false]);
    assert.deepEqual([e.quarentena.recomendada, [...e.quarentena.motivos], e.recuperacaoAutorizadaDaTravaNecessaria], [true, ['PUBLICACAO_SEM_CONCLUSAO_CONHECIDA', 'OPERACAO_AINDA_PENDENTE'], true]);
    m.portao.resolver();
    await andar();
  });

  teste('CONS-1c — a CONCLUSÃO TARDIA é observada: a publicação termina depois da saída, o registro marca a operação como tardia e a leitura fresca mostra a fase CONCLUIDA; o resultado devolvido continua inválido, a trava continua retida e a classificação feita na saída segue conservadora', async () => {
    const m = await comPublicacaoRetida();
    const rodando = executar(m.a);
    await ate(() => m.estado.entrou);
    m.relogio.disparar(ETAPA);
    await ate(() => m.relogio.registrado(CORTESIA));
    m.relogio.disparar(CORTESIA);
    const composto = await rodando;
    assert.equal(composto.proveniencia.situacaoAtual().fasePublicacao, 'PUBLICANDO');
    m.portao.resolver();
    await ate(() => composto.proveniencia.situacaoAtual().fasePublicacao === 'CONCLUIDA', 'conclusão tardia observada');
    const agora = composto.proveniencia.situacaoAtual();
    assert.deepEqual([agora.publicada, agora.operacoes.pendentes], [true, 0]);
    const avaliacao = agora.operacoes.operacoes.find((o) => o.etapa === 'avaliacao');
    assert.deepEqual([avaliacao.estado, avaliacao.tardia, avaliacao.cancelamentoSolicitado], ['ASSENTADA', true, true]);
    assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), ['prep-1'], 'fisicamente publicado, mas sob retenção e sem veredito favorável');
    assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela, composto.resultado.coordenador.valido], [11, 'RETIDA', false]);
    assert.equal(composto.resultado.publicacao, null, 'o resultado devolvido não é reescrito depois da saída');
    assert.equal(fs.existsSync(path.join(m.a.raiz, 'janela.lock')), true, 'a trava só sai por recuperação autorizada');
    assert.equal(classificarEstadoDoBackup(composto).quarentena.recomendada, true);
    assert.equal(classificarEstadoDoBackup(composto).backupOperacionalValido, false);
  });

  teste('CONS-1d — contraprova sem cancelamento: a mesma publicação retida e liberada produz o fluxo conhecido (publicada, sem quarentena); o veredito válido continua impossível (publicação operacional bloqueada), então nada inconclusivo é promovido', async () => {
    const m = await comPublicacaoRetida();
    const rodando = executar(m.a);
    await ate(() => m.estado.entrou);
    m.portao.resolver();
    const composto = await rodando;
    const e = classificarEstadoDoBackup(composto);
    assert.deepEqual([composto.resultado.publicacao.publicada, e.quarentena.recomendada], [true, false]);
    assert.deepEqual([e.backupOperacionalValido, e.recuperabilidadeComprovada], [false, false]);
  });

  teste('CONS-1e — cancelamento ANTES da publicação continua impedindo a incorporação do dump e a publicação (contraprova dos pontos seguros), sem quarentena porque nada físico foi iniciado', async () => {
    const relogio = relogioManual();
    let chamadas = 0;
    const original = relogio.prazo.bind(relogio);
    relogio.prazo = (ms) => { if (ms === ETAPA) { chamadas += 1; if (chamadas === 2) return { promessa: Promise.resolve(), cancelar() {} }; } return original(ms); };
    const a = await ambiente({ portasExtras: { temporizador: relogio }, alterarConfig: (c) => { c.operacoes = { etapaMs: ETAPA, cortesiaMs: CORTESIA }; return c; } });
    const composto = await executar(a);
    assert.equal(composto.resultado.pacote.motivo, 'CANCELADO');
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    const e = classificarEstadoDoBackup(composto);
    assert.deepEqual([e.quarentena.recomendada, e.backupOperacionalValido], [false, false]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- 2. orçamento da segunda cópia
describe('[CONS-2] orçamento compartilhado: a SEGUNDA cópia física do dump é reservada antes da incorporação', () => {
  /** Preparação descartável + artefato aberto, no formato que `incorporarDump` recebe. */
  function cenario(bytes = 300) {
    const preparacao = fix.criar();
    const conteudo = Buffer.alloc(bytes, 9);
    const arquivo = path.join(fix.criar(), 'dump.custom');
    fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
    const descritor = fs.openSync(arquivo, fs.constants.O_RDONLY);
    const artefato = { ok: true, descritor, bytes, sha256: sha(conteudo) };
    const manifesto = { dump: { bytes, sha256: sha(conteudo) } };
    return { preparacao, artefato, manifesto, alvo: path.join(preparacao, 'dump', 'postgres.dump'), fechar: () => { try { fs.closeSync(descritor); } catch { /* já fechado */ } } };
  }

  teste('CONS-2a — SALDO EXATO: a reserva cabe, o dump é incorporado, `usado` = bytes e o saldo fecha em zero', async () => {
    const c = cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 300 });
    try {
      const v = await criarServicoDePacote().incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto, orcamento: o });
      assert.equal(v.ok, true);
    } finally { c.fechar(); }
    assert.deepEqual([o.usado(), o.restante()], [300, 0]);
    assert.equal(fs.statSync(c.alvo).size, 300);
  });

  teste('CONS-2b — SALDO INSUFICIENTE (um byte a menos): recusa ANTES de qualquer efeito — nenhuma pasta, nenhum arquivo — e a recusa não consome saldo', async () => {
    const c = cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 299 });
    try {
      const v = await criarServicoDePacote().incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto, orcamento: o });
      assert.deepEqual([v.ok, v.motivo], [false, 'LIMITE_TOTAL_EXCEDIDO']);
    } finally { c.fechar(); }
    assert.deepEqual(fs.readdirSync(c.preparacao), [], 'nada foi criado na preparação');
    assert.deepEqual([o.usado(), o.restante()], [0, 299]);
  });

  teste('CONS-2c — aritmética SEGURA (BigInt): com o total no limite dos inteiros seguros e quase todo reservado, a reserva que não cabe é recusada sem estouro nem arredondamento', async () => {
    const c = cenario(10);
    const o = criarOrcamentoDeBytes({ totalBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(o.reservar(Number.MAX_SAFE_INTEGER - 5).ok, true);
    try {
      const v = await criarServicoDePacote().incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto, orcamento: o });
      assert.deepEqual([v.ok, v.motivo], [false, 'LIMITE_TOTAL_EXCEDIDO']);
    } finally { c.fechar(); }
    assert.equal(o.usado(), Number.MAX_SAFE_INTEGER - 5);
    assert.deepEqual(fs.readdirSync(c.preparacao), []);
  });

  teste('CONS-2d — FALHA DEPOIS DA RESERVA (ENOSPC na escrita): ESPACO_ESGOTADO, a reserva é MANTIDA (o parcial continua ocupando espaço), o arquivo parcial é PRESERVADO e nada é removido nem publicado; a causa não vaza', async () => {
    const c = cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 1000 });
    try {
      const v = await criarServicoDePacote({ ops: { escrever: async () => { throw erroCom('ENOSPC'); } } }).incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto, orcamento: o });
      assert.deepEqual([v.ok, v.motivo], [false, 'ESPACO_ESGOTADO']);
      assert.equal(JSON.stringify(v).includes('SEGREDO'), false);
    } finally { c.fechar(); }
    assert.equal(o.usado(), 300);
    assert.equal(fs.existsSync(c.alvo), true, 'o parcial foi preservado');
  });

  teste('CONS-2e — entradas inválidas: `orcamento` que não é da fábrica é recusado antes de qualquer efeito; sem `orcamento` o comportamento é o histórico (nada reservado)', async () => {
    const c = cenario();
    try {
      await assert.rejects(criarServicoDePacote().incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto, orcamento: { reservar: () => ({ ok: true }), restante: () => 1e9 } }), TypeError);
      assert.deepEqual(fs.readdirSync(c.preparacao), []);
      const v = await criarServicoDePacote().incorporarDump({ preparacao: c.preparacao, artefato: c.artefato, manifesto: c.manifesto });
      assert.equal(v.ok, true);
    } finally { c.fechar(); }
  });

  teste('CONS-2f — NA COMPOSIÇÃO: total = dump + imagens + SEGUNDA cópia do dump fecha exato e publica, sem dupla contagem (as releituras T1/T2 e a verificação do pacote não reservam nada); um byte a menos recusa a incorporação, preserva a preparação e não publica', async () => {
    const total = (2 * DUMP_BYTES.length) + somaDasImagens();
    const exato = await ambiente({ alterarConfig: (c) => { c.limites = { totalBytes: total }; return c; } });
    const ok = await executar(exato);
    assert.equal(ok.resultado.publicacao.publicada, true);
    assert.deepEqual([ok.proveniencia.limites.usadoDoOrcamento, ok.proveniencia.limites.totalBytes], [total, total]);
    assert.deepEqual([ok.proveniencia.limites.cobreSegundaCopiaDoDump, ok.proveniencia.limites.ocupacaoFisicaTotal], [true, false]);

    const curto = await ambiente({ alterarConfig: (c) => { c.limites = { totalBytes: total - 1 }; return c; } });
    const r = await executar(curto);
    assert.equal(r.resultado.pacote.motivo, 'LIMITE_TOTAL_EXCEDIDO');
    assert.equal(r.proveniencia.limites.usadoDoOrcamento, DUMP_BYTES.length + somaDasImagens(), 'a recusa não reservou nada');
    assert.equal(fs.existsSync(path.join(curto.dirs.preparacoes, 'prep-1', 'dump')), false, 'recusa antes de efeitos');
    assert.equal(fs.existsSync(path.join(curto.dirs.preparacoes, 'prep-1', 'manifesto.json')), true, 'a preparação foi preservada');
    assert.deepEqual(fs.readdirSync(curto.dirs.publicados), []);
    assert.equal(r.resultado.publicacao, null);
    assert.equal(r.resultado.coordenador.valido, false);
    assert.equal(classificarEstadoDoBackup(r).backupOperacionalValido, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- 3. restauração
describe('[CONS-3] a supervisão EXISTENTE da restauração é equivalente em falha fechada (sem estender o registro novo)', () => {
  const DESTINO = Object.freeze({ banco: 'gepi_cp_restaurado', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: '/tmp/senha-ficticia' });
  const expira = { prazo: (ms) => (ms === PRAZOS.totalMs || ms === PRAZOS.cortesiaMs ? { promessa: Promise.resolve(), cancelar() {} } : { promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() };
  const inerte = { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() };

  async function pacote() {
    const a = await ambiente();
    const composto = await executar(a);
    assert.equal(composto.resultado.publicacao.publicada, true);
    return a;
  }
  const arvoreDe = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  function restauracao(a, { spawn, temporizador = inerte, observarGrupo = async () => false } = {}) {
    const clientes = [];
    const r = criarRestauracaoDeProducao({
      postgres: { pgRestore: a.config.postgres.pgRestore },
      politicaDeDestino: { ...POLITICA },
      fonteDeChaves: a.fonteDeChaves,
      criarConexaoDoBanco: (banco) => { const c = clienteFalso(banco, linhas()); clientes.push(c); return c; },
      prazos: { ...PRAZOS },
      portas: { spawn, observarGrupo, temporizador },
    });
    return { r, clientes };
  }
  const pedido = (a, extras = {}) => ({ raizAutorizada: a.dirs.publicados, nome: 'prep-1', imagens: { raiz: novaRaiz(), nome: 'img' }, destino: DESTINO, ...extras });
  const estadosFalsos = (out) => assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });

  teste('CONS-3a — IDENTIDADE da execução: nasce na composição (32 hex), é a mesma no controle, no resultado e na proveniência, e duas restaurações nunca a compartilham', async () => {
    const a = await pacote();
    const um = await restauracao(a, { spawn: spawnFalso().spawn }).r.restaurar(pedido(a));
    const dois = await restauracao(a, { spawn: spawnFalso().spawn }).r.restaurar(pedido(a));
    assert.match(um.proveniencia.execucaoId, /^[0-9a-f]{32}$/);
    assert.equal(um.restauracao.execucaoId, um.proveniencia.execucaoId);
    assert.notEqual(um.proveniencia.execucaoId, dois.proveniencia.execucaoId);
  });

  teste('CONS-3b — pg_restore que NÃO termina (prazos vencidos): falha fechada, nenhuma prova de restauração, nenhuma consulta lógica, o pacote de origem intacto e as imagens já restauradas PRESERVADAS', async () => {
    const a = await pacote();
    const antes = arvoreDe(a.dirs.publicados);
    const falso = spawnFalso({ restore: 'trava' });
    const imagens = novaRaiz();
    const { r, clientes } = restauracao(a, { spawn: falso.spawn, temporizador: expira });
    const out = await r.restaurar(pedido(a, { imagens: { raiz: imagens, nome: 'img' } }));
    assert.equal(out.restauracao.ok, false);
    assert.ok(['ENCERRAMENTO_FORCADO', 'ESTADO_INCERTO', 'SINAL', 'SAIDA_NAO_ZERO'].includes(out.restauracao.motivo), out.restauracao.motivo);
    estadosFalsos(out);
    assert.equal(out.proveniencia.avaliacao.reconhecida, false);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore']);
    assert.equal(clientes.filter((c) => c.sqls.includes('PADRAO')).length, 0, 'nenhuma consulta lógica depois de uma restauração inconclusiva');
    assert.deepEqual(arvoreDe(a.dirs.publicados), antes, 'o pacote de origem ficou intacto');
    assert.ok(arvoreDe(imagens).length > 0, 'as imagens já restauradas foram preservadas (nada removido)');
  });

  teste('CONS-3c — pg_restore que termina com FALHA (código não zero): falha fechada, sem prova, sem consulta lógica; nada apagado', async () => {
    const a = await pacote();
    const falso = spawnFalso({ restore: 'falha' });
    const { r, clientes } = restauracao(a, { spawn: falso.spawn });
    const out = await r.restaurar(pedido(a));
    assert.equal(out.restauracao.ok, false);
    estadosFalsos(out);
    assert.equal(out.proveniencia.avaliacao.reconhecida, false);
    assert.equal(clientes.filter((c) => c.sqls.includes('PADRAO')).length, 0);
  });

  teste('CONS-3d — grupo de processos ainda VIVO depois do prazo (sobrevivente): o supervisor não confirma o término, a restauração é ESTADO_INCERTO/forçada e nenhuma prova de restauração é emitida', async () => {
    const a = await pacote();
    const falso = spawnFalso({ restore: 'trava' });
    const { r } = restauracao(a, { spawn: falso.spawn, temporizador: expira, observarGrupo: async () => true });
    const out = await r.restaurar(pedido(a));
    assert.equal(out.restauracao.ok, false);
    assert.ok(['ENCERRAMENTO_FORCADO', 'ESTADO_INCERTO', 'SINAL'].includes(out.restauracao.motivo), out.restauracao.motivo);
    estadosFalsos(out);
    assert.equal(out.proveniencia.avaliacao.reconhecida, false);
    assert.ok(out.proveniencia.avaliacao.pendencias.length > 0);
  });

  teste('CONS-3e — o executor LANÇA exceção: nada é promovido, nada é apagado e a causa não vaza', async () => {
    const a = await pacote();
    const antes = arvoreDe(a.dirs.publicados);
    const { r } = restauracao(a, { spawn: () => { throw new Error('SEGREDO-NUNCA-EXPOR'); } });
    const out = await r.restaurar(pedido(a));
    assert.equal(out.restauracao.ok, false);
    estadosFalsos(out);
    assert.equal(JSON.stringify(out).includes('SEGREDO'), false);
    assert.deepEqual(arvoreDe(a.dirs.publicados), antes);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- 4. compatibilidade P1 a P5
describe('[CONS-4] P1 a P5 juntos, no fluxo completo', () => {
  teste('CONS-4a — com limites, controle de operações e stderr ruidoso ao mesmo tempo: o fluxo conclui; orçamento exato; diagnóstico só com códigos; operações assentadas; trava liberada; manifesto V2 autenticado no pacote publicado; nada operacional é promovido', async () => {
    const SEGREDOS = ['SenhaSuperSecreta!42', '10.20.30.40', 'usuario_admin'];
    const total = (2 * DUMP_BYTES.length) + somaDasImagens();
    const falso = spawnFalso({ stderrTexto: `pg_dump: error: connection to server at "10.20.30.40" failed: FATAL: password authentication failed for user "usuario_admin" SenhaSuperSecreta!42\n` });
    const a = await ambiente({ portasExtras: { spawn: falso.spawn }, alterarConfig: (c) => { c.limites = { totalBytes: total, maxBytesDoDump: DUMP_BYTES.length }; c.operacoes = { etapaMs: 9001, cortesiaMs: 9002 }; return c; } });
    const composto = await executar(a);
    assert.equal(composto.resultado.publicacao.publicada, true);
    assert.deepEqual([composto.proveniencia.limites.usadoDoOrcamento, composto.proveniencia.operacoes.pendentes], [total, 0]);
    const d = composto.proveniencia.captura.diagnosticoDoStderr;
    assert.ok(d.codigos.some((x) => x.codigo === 'AUTENTICACAO_FALHOU'));
    const texto = JSON.stringify(composto.proveniencia);
    for (const s of SEGREDOS) assert.equal(texto.includes(s), false, s);
    assert.equal(composto.resultado.coordenador.janela, 'LIBERADA');
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false);
    const manifesto = JSON.parse(fs.readFileSync(path.join(a.dirs.publicados, 'prep-1', 'manifesto.json'), 'utf8'));
    assert.match(manifesto.autenticacao.mac, /^[0-9a-f]{64}$/, 'manifesto V2 autenticado (HMAC)');
    const e = classificarEstadoDoBackup(composto);
    assert.deepEqual([e.backupOperacionalValido, e.recuperabilidadeComprovada, e.publicacaoOperacional, e.quarentena.recomendada], [false, false, false, false]);
    assert.equal(e.correlacaoContratual, true);
  });

  teste('CONS-4b — limite do dump atingido com controle de operações ligado: o parcial aceito fica preservado, a trava fica RETIDA e nenhuma operação rastreada fica pendente nem finalizada indevidamente', async () => {
    const falso = spawnFalso({ pedacos: 4 });
    const a = await ambiente({ portasExtras: { spawn: falso.spawn }, alterarConfig: (c) => { c.limites = { maxBytesDoDump: 1000 }; c.operacoes = { etapaMs: 9001, cortesiaMs: 9002 }; return c; } });
    const composto = await executar(a);
    assert.equal(composto.proveniencia.captura.motivo, 'LIMITE_EXCEDIDO');
    assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela], [11, 'RETIDA']);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.equal(fs.statSync(path.join(a.dirs.dumps, fs.readdirSync(a.dirs.dumps)[0])).size, 900);
  });
});
