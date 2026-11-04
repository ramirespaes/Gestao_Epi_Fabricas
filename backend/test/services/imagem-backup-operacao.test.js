'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarEntradaOperacional, classificarEstadosDaOperacao, ESTADOS_BLOQUEADOS, POLITICA_DE_PRODUCAO } = require('../../src/services/imagem-backup-operacao.service');
const { REGISTRO_DE_EXECUCOES } = require('../../src/services/imagem-backup-execucoes.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { ambiente, spawnFalso, novaRaiz, PRAZOS, POLITICA, temporizadorInerte } = require('../helpers/ambiente-backup-operacao');

/**
 * ENTRADA OPERACIONAL INTERNA: dependências controladas (diretórios temporários, spawn e cliente falsos, chaves em memória). Nenhum PostgreSQL, pg_dump, pg_restore, .env ou dado operacional. Nada aqui comprova backup operacional, restauração real ou recuperabilidade.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const EXECUCAO = Object.freeze({ fronteira: 'PROCESSO_UNICO', politica: { versao: 1, execucoesSimultaneas: 1 } });
const POLITICA_DE_TESTE = (a) => ({ origemDaChave: 'TESTE_CONTROLADO', destinos: [a.config.armazenamento.publicados] });
const ENTRADA = { nomeDaPreparacao: 'prep-op-1', conjuntoId: 'conjunto-op-0001' };
const montar = (a, extras = {}, politica) => criarEntradaOperacional({ composicao: a.config, execucao: EXECUCAO, ...extras }, politica);
const semRelatorio = (c) => { delete c.relatorio; return c; };
const restauracaoCfg = (a) => ({
  postgres: { pgRestore: a.config.postgres.pgRestore },
  politicaDeDestino: POLITICA,
  fonteDeChaves: a.fonteDeChaves,
  criarConexaoDoBanco: () => { throw new Error('não deveria conectar'); },
  prazos: { ...PRAZOS },
  portas: { spawn: () => { throw new Error('não deveria lançar'); }, observarGrupo: async () => false, temporizador: temporizadorInerte },
});

/** Fotografia (caminho relativo -> tamanho) de uma árvore, para provar que nada foi criado, removido ou alterado. */
function fotografia(raiz) {
  const mapa = {};
  const andar = (dir) => {
    for (const nome of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, nome);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { mapa[`${path.relative(raiz, p)}/`] = 0; andar(p); } else mapa[path.relative(raiz, p)] = st.size;
    }
  };
  andar(raiz);
  return mapa;
}
const fotografiaDasImagens = (a) => fotografia(a.dirs.imagens);

/** Ambiente com instrumento de conexão (contador na criação do cliente) e fotografia inicial das imagens. O spawn instrumentado é o `chamadas` do spawnFalso. */
async function ambienteObservado({ spawn, observarGrupo } = {}) {
  const obs = { conexoes: 0 };
  const portasExtras = {};
  if (spawn) portasExtras.spawn = spawn;
  if (observarGrupo) portasExtras.observarGrupo = observarGrupo;
  const a = await ambiente({
    relatorio: null,
    portasExtras,
    alterarConfig: (c) => { const original = c.conexao.criarConexao; c.conexao.criarConexao = (...args) => { obs.conexoes += 1; return original(...args); }; return c; },
  });
  a.imagensAntes = fotografiaDasImagens(a);
  return { a, obs };
}

describe('[OP-A] configuração estrita e pré-requisitos (falha fechada antes de qualquer efeito)', () => {
  teste('OP-A01 — configuração inválida: forma, fronteira, política de execução e chaves extras recusadas sem eco', async () => {
    const a = await ambiente({ relatorio: null });
    const ruins = [
      {}, { composicao: a.config }, { composicao: a.config, execucao: null },
      { composicao: a.config, execucao: { fronteira: 'QUALQUER', politica: EXECUCAO.politica } },
      { composicao: a.config, execucao: { fronteira: 'PROCESSO_UNICO' } },
      { composicao: a.config, execucao: { fronteira: 'PROCESSO_UNICO', politica: { versao: 2, execucoesSimultaneas: 1 } } },
      { composicao: a.config, execucao: { fronteira: 'PROCESSO_UNICO', politica: { versao: 1, execucoesSimultaneas: 4 } } },
      { composicao: a.config, execucao: EXECUCAO, extra: 1 },
      { composicao: { ...a.config, extra: 1 }, execucao: EXECUCAO },
      null, 'x',
    ];
    for (const ruim of ruins) assert.throws(() => criarEntradaOperacional(ruim), (e) => e instanceof TypeError && e.code === 'CONFIGURACAO_INVALIDA' && !/gepi-cp-test/.test(e.message), JSON.stringify(Object.keys(ruim ?? {})));
    assert.throws(() => criarEntradaOperacional({ composicao: a.config, execucao: EXECUCAO }, { origemDaChave: 'X' }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('OP-A02 — POLÍTICA DE PRODUÇÃO: fonte operacional e destino operacional inexistentes => PRE_REQUISITOS_AUSENTES, efeitos NENHUM, nenhum processo e nenhum arquivo', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ relatorio: null, portasExtras: { spawn: falso.spawn } });
    const op = montar(a);
    const pre = await op.avaliarPrerequisitos();
    assert.equal(pre.aptos, false);
    assert.deepEqual([...pre.pendencias].sort(), ['DESTINO_OPERACIONAL_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES']);
    assert.equal(pre.itens.JANELA_GENUINA, true);
    assert.equal(pre.itens.GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO, true);
    assert.equal(pre.itens.DEPENDENCIAS_DA_COMPOSICAO, true);
    const r = await op.executarBackup(ENTRADA);
    assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
    assert.deepEqual(r.estados, ESTADOS_BLOQUEADOS);
    assert.equal(falso.chamadas.length, 0);
    assert.deepEqual(fs.readdirSync(a.dirs.dumps), []);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.deepEqual(fs.readdirSync(a.dirs.preparacoes), []);
  });

  teste('OP-A03 — a política padrão é a de produção, congelada e VAZIA; nenhuma variável de ambiente (NODE_ENV) a altera', async () => {
    assert.deepEqual([POLITICA_DE_PRODUCAO.origemDaChave, [...POLITICA_DE_PRODUCAO.destinos]], ['OPERACIONAL', []]);
    assert.equal(Object.isFrozen(POLITICA_DE_PRODUCAO), true);
    const antes = process.env.NODE_ENV;
    try {
      for (const valor of ['production', 'test', 'OPERACIONAL']) {
        process.env.NODE_ENV = 'test';
        const a = await ambiente({ relatorio: null });
        process.env.NODE_ENV = valor;
        const pre = await montar(a).avaliarPrerequisitos();
        assert.equal(pre.aptos, false, valor);
      }
    } finally {
      if (antes === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = antes;
    }
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-operacao.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
    assert.equal(/process\.env|NODE_ENV|require\('(pg|node:child_process|dotenv)'\)/.test(codigo), false);
  });

  teste('OP-A04 — fonte de chaves de TESTE declarada pelo chamador não vira operacional; destino fora da lista e produtor injetado também seguem pendentes', async () => {
    const a = await ambiente({ relatorio: null });
    const pre = await montar(a, {}, { origemDaChave: 'OPERACIONAL', destinos: [a.config.armazenamento.publicados] }).avaliarPrerequisitos();
    assert.deepEqual([...pre.pendencias], ['FONTE_OPERACIONAL_DE_CHAVES'], 'a fonte do chamador tem origem TESTE_CONTROLADO');
    const b = await ambiente({ relatorio: null });
    const pre2 = await montar(b, {}, { origemDaChave: 'TESTE_CONTROLADO', destinos: ['/outro/destino'] }).avaliarPrerequisitos();
    assert.deepEqual([...pre2.pendencias], ['DESTINO_OPERACIONAL_AUTORIZADO']);
    const c = await ambiente({ relatorio: 'teste' });
    const pre3 = await montar(c, {}, POLITICA_DE_TESTE(c)).avaliarPrerequisitos();
    assert.deepEqual([...pre3.pendencias], ['PRODUTOR_OPERACIONAL_PADRAO'], 'produtor de teste injetado não é o produtor operacional padrão');
    assert.equal(typeof criarProdutorDeRelatorio, 'function');
  });

  teste('OP-A05 — FRONTEIRA MULTIPROCESSO exige registro compartilhado e durável que NÃO existe: falha fechada mesmo com política de teste', async () => {
    const a = await ambiente({ relatorio: null });
    const op = criarEntradaOperacional({ composicao: a.config, execucao: { fronteira: 'MULTIPROCESSO', politica: EXECUCAO.politica } }, POLITICA_DE_TESTE(a));
    const pre = await op.avaliarPrerequisitos();
    assert.deepEqual([...pre.pendencias], ['GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO']);
    const r = await op.executarBackup(ENTRADA);
    assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
    assert.deepEqual([REGISTRO_DE_EXECUCOES.escopo, REGISTRO_DE_EXECUCOES.duravel, REGISTRO_DE_EXECUCOES.compartilhado], ['PROCESSO_UNICO_VOLATIL', false, false]);
  });

  teste('OP-A06 — dependência ausente ANTES da execução: pendência nomeada, nenhum processo lançado', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ relatorio: null, portasExtras: { spawn: falso.spawn } });
    const op = montar(a, {}, POLITICA_DE_TESTE(a));
    fs.unlinkSync(a.config.postgres.pgDump);
    const r = await op.executarBackup(ENTRADA);
    assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
    assert.deepEqual([...r.pendencias], ['DEPENDENCIAS_DA_COMPOSICAO']);
    assert.equal(falso.chamadas.length, 0);
  });
});

describe('[OP-B] execução com política de TESTE: a lógica corre, mas nada vira autorização reconhecida', () => {
  teste('OP-B01 — pré-requisitos satisfeitos só pela política de teste: o backup é produzido e o pacote íntegro, mas publicação, validade operacional, restauração e recuperabilidade continuam falsas; coordenador 9 / inválido', async () => {
    const falso = spawnFalso();
    const a = await ambiente({ relatorio: null, portasExtras: { spawn: falso.spawn } });
    const op = montar(a, {}, POLITICA_DE_TESTE(a));
    assert.equal((await op.avaliarPrerequisitos()).aptos, true);
    const r = await op.executarBackup(ENTRADA);
    assert.equal(r.executado, true);
    assert.equal(r.exportavel, false);
    assert.equal(r.autorizacaoReconhecidaPelaProducao, false);
    assert.deepEqual([r.composto.resultado.coordenador.saida, r.composto.resultado.coordenador.valido], [9, false]);
    assert.equal(r.estados.backupTecnicamenteProduzido, true);
    assert.equal(r.estados.homologacaoTecnicaConcluida, null);
    assert.equal(r.estados.publicacaoOperacionalAutorizada, false);
    assert.equal(r.estados.backupOperacionalValido, false);
    assert.equal(r.estados.restauracaoComprovada, false);
    assert.equal(r.estados.recuperabilidadeEmProducao, false);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), [], 'o produtor operacional global (listas vazias) bloqueia a publicação');
  });

  teste('OP-B02 — uma operação por vez: segunda chamada durante a primeira é recusada sem efeito; depois de concluir, volta a aceitar', async () => {
    const a = await ambiente({ relatorio: null });
    const op = montar(a, {}, POLITICA_DE_TESTE(a));
    const [p1, p2] = [op.executarBackup(ENTRADA), op.executarBackup({ ...ENTRADA, nomeDaPreparacao: 'prep-op-2' })];
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1.executado, r2.executado, r2.motivo, r2.efeitos], [true, false, 'OPERACAO_EM_ANDAMENTO', 'NENHUM']);
    const r3 = await op.executarBackup({ ...ENTRADA, nomeDaPreparacao: 'prep-op-3' });
    assert.equal(r3.executado, true);
  });

  teste('OP-B03 — falha DEPOIS dos pré-requisitos (entrada inválida): FALHA_NA_EXECUCAO, sem estado promovido e sem sobras de publicação', async () => {
    const a = await ambiente({ relatorio: null });
    const op = montar(a, {}, POLITICA_DE_TESTE(a));
    const r = await op.executarBackup({ nomeDaPreparacao: '../x', conjuntoId: 'c' });
    assert.deepEqual([r.executado, r.motivo], [false, 'FALHA_NA_EXECUCAO']);
    assert.deepEqual(r.estados, ESTADOS_BLOQUEADOS);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });

  teste('OP-B04 — pg_dump que falha (saída 1): o pg_dump FOI lançado (instrumento vivo), nada foi publicado, a janela foi liberada, o coordenador reprova e TODOS os estados favoráveis ficam falsos', async () => {
    const falso = spawnFalso({ dump: 'falha' });
    const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.executado, true);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_dump'], 'pg_dump lançado; nenhuma listagem nem pg_restore depois da falha');
    assert.ok(obs.conexoes >= 1, 'o instrumento de conexão está ligado');
    // contrato histórico (CP-J01): dump que falha com fluxos sem confirmação => trava RETIDA por segurança, para decisão humana
    assert.deepEqual([r.composto.resultado.coordenador.saida, r.composto.resultado.coordenador.janela, r.composto.resultado.coordenador.valido], [11, 'RETIDA', false]);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a janela é retida (proteção preservada), nunca liberada às cegas');
    assert.notEqual(r.composto.resultado.publicacao && r.composto.resultado.publicacao.publicada, true);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.deepEqual(fotografiaDasImagens(a), a.imagensAntes, 'as imagens não foram alteradas');
  });

  teste('OP-B05 — T1/T2 DIVERGENTES (arquivo alterado entre as observações): rejeitado na fronteira da entrada, sem publicação, janela liberada e estados falsos', async () => {
    let dumps = null;
    let alterou = false;
    const falso = spawnFalso({ aoListar: () => { const l = fs.readdirSync(dumps); alterou = l.length > 0; if (alterou) fs.appendFileSync(path.join(dumps, l[0]), 'y'); } });
    const { a } = await ambienteObservado({ spawn: falso.spawn });
    dumps = a.dirs.dumps;
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(alterou, true, 'a divergência foi realmente provocada');
    assert.equal(r.executado, true);
    assert.equal(r.composto.resultado.coordenador.valido, false);
    assert.notEqual(r.composto.resultado.publicacao && r.composto.resultado.publicacao.publicada, true);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false);
  });

  teste('OP-B06 — hash do fluxo diferente do arquivo persistido (divergência na captura): hashDoDump.correspondem=false e nada é favorável', async () => {
    let dumps = null;
    let alterou = false;
    const observarGrupo = async () => { if (!alterou && dumps !== null) { const l = fs.readdirSync(dumps); if (l.length > 0) { alterou = true; fs.appendFileSync(path.join(dumps, l[0]), 'x'); } } return false; };
    const { a } = await ambienteObservado({ observarGrupo });
    dumps = a.dirs.dumps;
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(alterou, true);
    assert.equal(r.composto.proveniencia.hashDoDump.correspondem, false);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });

  teste('OP-B07 — pacote inválido na fronteira da entrada: a verificação estrutural falha (pg_restore --list com saída 1) e o pacote NÃO é íntegro nem autenticado; sem pg_restore real de restauração', async () => {
    const falso = spawnFalso({ lista: 'falha' });
    const { a } = await ambienteObservado({ spawn: falso.spawn });
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.estados.pacoteIntegroEAutenticado, false);
    assert.equal(r.estados.backupTecnicamenteProduzido, false);
    assert.deepEqual(falso.chamadas.map((c) => [c.nome, c.args.includes('--list')]), [['pg_dump', false], ['pg_restore', true]], 'só a listagem estrutural; nenhuma restauração');
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });

  teste('OP-B08 — MANIFESTO/HMAC: sem publicação não existe pacote autenticado a abrir; a entrada nunca reconhece autenticação (a rejeição de HMAC/chave incorreta sobre pacote publicado é a do CP-D02, inalcançável pela entrada enquanto não houver destino operacional)', async () => {
    const { a } = await ambienteObservado({});
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.composto.resultado.publicacao.publicada, false);
    assert.equal(r.composto.resultado.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    assert.equal(r.estados.pacoteIntegroEAutenticado, false);
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });
});

describe('[OP-C] evidência fabricada, clonada ou de outra execução nunca promove estado', () => {
  teste('OP-C01 — resultado literal, clone e resultado de execução bloqueada não são reconhecidos', async () => {
    const a = await ambiente({ relatorio: null });
    const op = montar(a, { restauracao: restauracaoCfg(a) }, POLITICA_DE_TESTE(a));
    const real = await op.executarBackup(ENTRADA);
    const bloqueado = await montar(await ambiente({ relatorio: null })).executarBackup(ENTRADA);
    const literal = { executado: true, composto: { prontidao: { pronta: true, pendencias: [] }, resultado: { publicacao: { publicada: true, publicacaoOperacional: true } } } };
    for (const falso of [literal, { ...real }, structuredClone({ executado: true }), bloqueado, null, undefined, 7]) {
      assert.deepEqual(classificarEstadosDaOperacao(falso), ESTADOS_BLOQUEADOS);
      const pedido = { resultado: falso, imagens: { raiz: novaRaiz(), nome: 'img' }, destino: { banco: 'gepi_cp_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' } };
      const prova = await op.provarRestauracao(pedido);
      assert.deepEqual([prova.comprovada, prova.prova], [false, null]);
      assert.ok(['BACKUP_NAO_RECONHECIDO'].includes(prova.motivo), String(prova.motivo));
    }
    assert.throws(() => { 'use strict'; real.estados.restauracaoComprovada = true; }, TypeError);
  });

  teste('OP-C02 — restauração simulada nunca vira prova: sem pacote publicado (publicação bloqueada) ou sem restauração configurada a prova é negada, sem lançar processo', async () => {
    const a = await ambiente({ relatorio: null });
    const semRest = montar(a, {}, POLITICA_DE_TESTE(a));
    const r = await semRest.executarBackup(ENTRADA);
    const destino = { banco: 'gepi_cp_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' };
    const p1 = await semRest.provarRestauracao({ resultado: r, imagens: { raiz: novaRaiz(), nome: 'img' }, destino });
    assert.deepEqual([p1.comprovada, p1.motivo], [false, 'RESTAURACAO_NAO_CONFIGURADA']);
    const b = await ambiente({ relatorio: null });
    const comRest = montar(b, { restauracao: restauracaoCfg(b) }, POLITICA_DE_TESTE(b));
    const r2 = await comRest.executarBackup(ENTRADA);
    const p2 = await comRest.provarRestauracao({ resultado: r2, imagens: { raiz: novaRaiz(), nome: 'img' }, destino });
    assert.deepEqual([p2.comprovada, p2.motivo, p2.prova], [false, 'PACOTE_NAO_PUBLICADO', null]);
    await assert.rejects(() => comRest.provarRestauracao({ resultado: r2 }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('OP-C03 — resultado GENUÍNO de outra entrada é recusado com motivo próprio (RESULTADO_DE_OUTRA_ENTRADA), sem spawn nem conexão; a entrada emissora o reconhece (controle)', async () => {
    const a = await ambiente({ relatorio: null });
    const b = await ambiente({ relatorio: null });
    const efeitosB = { spawns: 0, conexoes: 0 };
    const cfgB = restauracaoCfg(b);
    cfgB.criarConexaoDoBanco = () => { efeitosB.conexoes += 1; throw new Error('não deveria conectar'); };
    cfgB.portas = { ...cfgB.portas, spawn: () => { efeitosB.spawns += 1; throw new Error('não deveria lançar'); } };
    const opA = montar(a, { restauracao: restauracaoCfg(a) }, POLITICA_DE_TESTE(a));
    const opB = montar(b, { restauracao: cfgB }, POLITICA_DE_TESTE(b));
    const rA = await opA.executarBackup(ENTRADA);
    assert.equal(rA.executado, true);
    const pedido = (resultado) => ({ resultado, imagens: { raiz: novaRaiz(), nome: 'img' }, destino: { banco: 'gepi_cp_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' } });
    const p = await opB.provarRestauracao(pedido(rA));
    assert.deepEqual([p.comprovada, p.motivo, p.prova], [false, 'RESULTADO_DE_OUTRA_ENTRADA', null]);
    assert.deepEqual(efeitosB, { spawns: 0, conexoes: 0 });
    const controle = await opA.provarRestauracao(pedido(rA));
    assert.equal(controle.motivo, 'PACOTE_NAO_PUBLICADO', 'a emissora o reconhece e para no passo seguinte (publicação bloqueada)');
    assert.deepEqual(classificarEstadosDaOperacao(rA), rA.estados, 'a classificação do resultado reconhecido é estável');
  });
});

describe('[OP-E] ausência de efeitos MEDIDA por instrumentos (não pelo campo textual) e janela na fronteira da entrada', () => {
  const casosDePrerequisito = [
    ['política de produção (fonte e destino operacionais ausentes)', undefined, (c) => c],
    ['fronteira multiprocesso', 'MULTI', (c) => c],
    ['dependência ausente (pg_dump removido)', 'TESTE', (c) => { fs.unlinkSync(c.postgres.pgDump); return c; }],
    ['produtor fabricado injetado', 'TESTE', (c) => { c.relatorio = { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] }; return c; }],
  ];
  for (const [rotulo, modo, mutar] of casosDePrerequisito) {
    teste(`OP-E01 (${rotulo}) — falha de pré-requisito: zero spawn, zero conexão, árvore inteira idêntica (sem dump, preparação, publicação, trava de janela ou alteração de imagens)`, async () => {
      const falso = spawnFalso();
      const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
      mutar(a.config);
      const antes = fotografia(a.raiz);
      const execucao = modo === 'MULTI' ? { fronteira: 'MULTIPROCESSO', politica: EXECUCAO.politica } : EXECUCAO;
      const politica = modo === undefined ? undefined : POLITICA_DE_TESTE(a);
      const op = criarEntradaOperacional({ composicao: a.config, execucao }, politica);
      const r = await op.executarBackup(ENTRADA);
      assert.deepEqual([r.executado, r.motivo], [false, 'PRE_REQUISITOS_AUSENTES']);
      assert.equal(falso.chamadas.length, 0, 'nenhum processo lançado');
      assert.equal(obs.conexoes, 0, 'nenhuma conexão PostgreSQL');
      assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false, 'a janela não foi adquirida');
      assert.deepEqual(fotografia(a.raiz), antes, 'nada criado, removido ou alterado em disco');
    });
  }

  teste('OP-E02 — controle positivo dos instrumentos: uma execução real da lógica DÁ spawn, conexão e cria/limpa arquivos (os contadores não estão mortos)', async () => {
    const falso = spawnFalso();
    const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
    const antes = fotografia(a.raiz);
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.executado, true);
    assert.ok(falso.chamadas.length >= 1 && obs.conexoes >= 1);
    assert.notDeepEqual(fotografia(a.raiz), antes, 'a preparação deixou rastro no diretório de preparações/dumps');
    assert.deepEqual(fotografiaDasImagens(a), a.imagensAntes, 'as imagens (dados) seguem intactas');
  });

  teste('OP-E03 — falha DEPOIS do início da preparação (entrada recusada pela composição): FALHA_NA_EXECUCAO, zero spawn, zero conexão, árvore idêntica e janela não retida', async () => {
    const falso = spawnFalso();
    const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
    const antes = fotografia(a.raiz);
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup({ nomeDaPreparacao: '../x', conjuntoId: 'c' });
    assert.deepEqual([r.executado, r.motivo, r.codigo], [false, 'FALHA_NA_EXECUCAO', 'CONFIGURACAO_INVALIDA']);
    assert.equal(r.efeitos, 'PODEM_EXISTIR_PRESERVADOS');
    assert.equal(falso.chamadas.length, 0);
    assert.equal(obs.conexoes, 0);
    assert.deepEqual(fotografia(a.raiz), antes);
  });

  teste('OP-E04 — JANELA AUSENTE, FALSA ou CLONADA: a entrada recusa na construção (CONFIGURACAO_INVALIDA) sem spawn, conexão ou arquivo', async () => {
    const literal = { async adquirir() { return Object.freeze({ tipo: 'BACKUP', async confirmarPosse() { return { confirmada: true }; }, async liberar() { return { liberada: true }; } }); } };
    const variantes = [['ausente', (c) => { delete c.janela; return c; }], ['literal', (c) => { c.janela = literal; return c; }], ['clone', (c) => { c.janela = { ...c.janela }; return c; }], ['função', (c) => { c.janela = async () => literal; return c; }]];
    for (const [rotulo, mutar] of variantes) {
      const falso = spawnFalso();
      const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
      mutar(a.config);
      const antes = fotografia(a.raiz);
      assert.throws(() => criarEntradaOperacional({ composicao: a.config, execucao: EXECUCAO }, POLITICA_DE_TESTE(a)), (e) => e instanceof TypeError && e.code === 'CONFIGURACAO_INVALIDA', rotulo);
      assert.equal(falso.chamadas.length, 0, rotulo);
      assert.equal(obs.conexoes, 0, rotulo);
      assert.deepEqual(fotografia(a.raiz), antes, rotulo);
    }
  });

  teste('OP-E05 — JANELA REVOGADA no meio da operação (trava removida após o dump): o coordenador reporta janela PERDIDA e inválido, nada é publicado e todos os estados favoráveis ficam falsos', async () => {
    let trava = null;
    const falso = spawnFalso({ aposDump: () => { fs.unlinkSync(trava); } });
    const { a } = await ambienteObservado({ spawn: falso.spawn });
    trava = path.join(a.raiz, 'janela.lock');
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.executado, true);
    assert.equal(r.composto.resultado.coordenador.janela, 'PERDIDA');
    assert.equal(r.composto.resultado.coordenador.valido, false);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });

  teste('OP-E07 — janela OCUPADA por outro dono: a entrada executa sem posse nada (zero spawn, zero conexão), a trava do outro dono permanece e os estados ficam falsos', async () => {
    const falso = spawnFalso();
    const { a, obs } = await ambienteObservado({ spawn: falso.spawn });
    const dono = await a.config.janela.adquirir({ tipo: 'BACKUP' });
    const r = await montar(a, {}, POLITICA_DE_TESTE(a)).executarBackup(ENTRADA);
    assert.equal(r.composto.resultado.coordenador.janela, 'OCUPADA');
    assert.equal(falso.chamadas.length, 0);
    assert.equal(obs.conexoes, 0);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a trava do outro dono permanece');
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    assert.deepEqual(fs.readdirSync(a.dirs.dumps), []);
    await dono.liberar();
  });

  teste('OP-E08 — HMAC do manifesto V2 adulterado na preparação selada (caminho legítimo: TESTE_CONTROLADO, sem publicação): a autenticação NÃO é reconhecida pela entrada, o backup não é válido e a prova de restauração é negada sem pg_restore nem conexão; o controle sem adulteração autentica', async () => {
    const executarComAdulteracao = async (adulterar) => {
      const falso = spawnFalso();
      let a = null;
      let feita = false;
      const manifesto = () => path.join(a.dirs.preparacoes, ENTRADA.nomeDaPreparacao, 'manifesto.json');
      // a SEGUNDA observação do grupo acontece depois da selagem (manifesto presente) e antes da leitura final da autenticação
      const observarGrupo = async () => { if (adulterar && !feita && a !== null && fs.existsSync(manifesto())) { feita = true; const m = JSON.parse(fs.readFileSync(manifesto(), 'utf8')); m.autenticacao.mac = (m.autenticacao.mac[0] === '0' ? '1' : '0') + m.autenticacao.mac.slice(1); fs.chmodSync(manifesto(), 0o600); fs.writeFileSync(manifesto(), JSON.stringify(m)); } return false; };
      const ambienteAtual = await ambienteObservado({ spawn: falso.spawn, observarGrupo });
      a = ambienteAtual.a;
      const efeitos = { spawns: 0, conexoes: 0 };
      const cfg = restauracaoCfg(a);
      cfg.criarConexaoDoBanco = () => { efeitos.conexoes += 1; throw new Error('x'); };
      cfg.portas = { ...cfg.portas, spawn: () => { efeitos.spawns += 1; throw new Error('x'); } };
      const op = montar(a, { restauracao: cfg }, POLITICA_DE_TESTE(a));
      const r = await op.executarBackup(ENTRADA);
      assert.equal(feita, adulterar, 'a adulteração ocorreu exatamente quando pedida');
      const prova = await op.provarRestauracao({ resultado: r, imagens: { raiz: novaRaiz(), nome: 'img' }, destino: { banco: 'gepi_cp_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' } });
      return { r, prova, efeitos, a };
    };

    const controle = await executarComAdulteracao(false);
    assert.equal(controle.r.composto.prontidao.itens.MANIFESTO_V2_AUTENTICADO, true, 'controle: o manifesto selado autentica');

    const adulterado = await executarComAdulteracao(true);
    assert.equal(adulterado.r.composto.prontidao.itens.MANIFESTO_V2_AUTENTICADO, false, 'manifesto com HMAC adulterado não autentica');
    assert.equal(adulterado.r.estados.pacoteIntegroEAutenticado, false);
    assert.equal(adulterado.r.estados.publicacaoOperacionalAutorizada, false);
    assert.equal(adulterado.r.estados.backupOperacionalValido, false);
    assert.equal(adulterado.r.estados.restauracaoComprovada, false);
    assert.deepEqual([adulterado.prova.comprovada, adulterado.prova.motivo, adulterado.prova.prova], [false, 'PACOTE_NAO_PUBLICADO', null]);
    assert.deepEqual(adulterado.efeitos, { spawns: 0, conexoes: 0 });
    assert.deepEqual(fs.readdirSync(adulterado.a.dirs.publicados), []);
  });

  teste('OP-E06 — prova de restauração recusada NÃO lança pg_restore nem conecta: resultado fabricado, sem restauração configurada e pacote não publicado', async () => {
    const a = await ambiente({ relatorio: null });
    const efeitos = { spawns: 0, conexoes: 0 };
    const cfg = restauracaoCfg(a);
    cfg.criarConexaoDoBanco = () => { efeitos.conexoes += 1; throw new Error('x'); };
    cfg.portas = { ...cfg.portas, spawn: () => { efeitos.spawns += 1; throw new Error('x'); } };
    const op = montar(a, { restauracao: cfg }, POLITICA_DE_TESTE(a));
    const real = await op.executarBackup(ENTRADA);
    const destino = { banco: 'gepi_cp_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' };
    const imagens = { raiz: novaRaiz(), nome: 'img' };
    const antes = fotografia(imagens.raiz);
    const fabricado = { executado: true, composto: real.composto, conjuntoId: ENTRADA.conjuntoId, nome: ENTRADA.nomeDaPreparacao };
    const motivos = [];
    for (const resultado of [fabricado, { ...real }, real]) motivos.push((await op.provarRestauracao({ resultado, imagens, destino })).motivo);
    assert.deepEqual(motivos, ['BACKUP_NAO_RECONHECIDO', 'BACKUP_NAO_RECONHECIDO', 'PACOTE_NAO_PUBLICADO']);
    assert.deepEqual(efeitos, { spawns: 0, conexoes: 0 });
    assert.deepEqual(fotografia(imagens.raiz), antes, 'nenhuma imagem foi restaurada');
  });
});

describe('[OP-H] pendente de homologação genuína (registro; não é cobertura nem aprovação)', () => {
  test('OP-H01 — caminho POSITIVO de `provarRestauracao` (prova ligada ao pacote e à execução que a originaram) e confirmação do destino durável: só é alcançado com pacote publicado e avaliação reconhecida pela produção, que exige spawn e cliente PostgreSQL genuínos; nenhum bloqueio foi alterado nem função extraída para simular', { todo: 'pendente de homologação genuína (documento 75)' }, () => {});
});

describe('[OP-D] limite do registro de identidades: processo único, volátil, sem replay entre processos', () => {
  teste('OP-D01 — identidade emitida neste processo é DESCONHECIDA em um processo novo (reinício): não autoriza, não conclui, não aparece como nova', () => {
    const { id } = REGISTRO_DE_EXECUCOES.emitir();
    assert.equal(REGISTRO_DE_EXECUCOES.estado(id), 'ATIVA');
    const filho = spawnSync(process.execPath, [path.join(__dirname, '..', 'helpers', 'consulta-execucao-filho.js'), id], { encoding: 'utf8', env: {}, timeout: 20000 });
    assert.equal(filho.status, 0, filho.stderr);
    const saida = JSON.parse(filho.stdout);
    assert.deepEqual(saida, { estado: null, resultado: null, concluiu: false, tamanho: 0 });
    assert.equal(REGISTRO_DE_EXECUCOES.estado(id), 'ATIVA', 'o processo original segue como estava');
  });

  teste('OP-D02 — o resultado da entrada não é exportável: serializar e reconstruir não gera resultado reconhecido', async () => {
    const a = await ambiente({ relatorio: null });
    const op = montar(a, {}, POLITICA_DE_TESTE(a));
    const r = await op.executarBackup(ENTRADA);
    const reconstruido = JSON.parse(JSON.stringify({ ...r, composto: undefined }));
    assert.deepEqual(classificarEstadosDaOperacao(reconstruido), ESTADOS_BLOQUEADOS);
    assert.equal(r.exportavel, false);
    assert.equal(r.fronteira, 'PROCESSO_UNICO');
  });
});
