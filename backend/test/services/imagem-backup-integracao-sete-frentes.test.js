'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarEntradaOperacional, ESTADOS_BLOQUEADOS, POLITICA_DE_PRODUCAO } = require('../../src/services/imagem-backup-operacao.service');
const { criarFonteDeProvedor, criarLeitorV2, PROVEDORES_OPERACIONAIS_APROVADOS } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarChaveiro } = require('../../src/services/imagem-backup-chaveiro.service');
const { criarValidadorDeDestinos, DESTINOS_AUTORIZADOS } = require('../../src/services/imagem-backup-destinos.service');
const { criarCoordenadorCompartilhado, COORDENADORES_COMPARTILHADOS_APROVADOS } = require('../../src/services/imagem-backup-coordenacao.service');
const { criarDestinoDuravel, classificarDurabilidade, ARMAZENAMENTOS_DURAVEIS_APROVADOS } = require('../../src/services/imagem-backup-durabilidade.service');
const { CONTROLES_EXTERNOS_APROVADOS, GARANTIA_CONTRA_ESCRITORES_EXTERNOS } = require('../../src/services/imagem-backup-escritores.service');
const { identificarOrfaos, LIMPEZA_OPERACIONAL_HABILITADA } = require('../../src/services/imagem-backup-orfaos.service');
const { criarControladorDeExecucao, planejarRetencao, POLITICA_PADRAO, CONFIRMACAO_DE_ATIVACAO } = require('../../src/services/imagem-backup-agendamento.service');
const { DESTINOS_OPERACIONAIS_AUTORIZADOS } = require('../../src/services/imagem-backup-publicacao.service');
const { ambiente, spawnFalso } = require('../helpers/ambiente-backup-operacao');

/**
 * INTEGRAÇÃO DAS SETE CAPACIDADES pela ENTRADA OPERACIONAL (sem segundo pipeline), com fontes, destinos, armazenamento, coordenador e processos SIMULADOS e dados fictícios. Integração simulada não é homologação operacional:
 * nenhuma origem OPERACIONAL é produzida, nenhum pacote é publicado, nenhuma restauração é comprovada, nenhum registro operacional é preenchido.
 */

const teste = (nome, fn) => test(nome, { timeout: 60000 }, fn);
const uid = process.getuid();
const DIA = 86400000;
const EXECUCAO = Object.freeze({ fronteira: 'PROCESSO_UNICO', politica: { versao: 1, execucoesSimultaneas: 1 } });
const CONJUNTO = 'conjunto-int-0001';
const nunca = () => ({ promessa: new Promise(() => {}), cancelar() {} });
const assentar = () => new Promise((r) => setImmediate(r));
const arvore = (raiz) => {
  const acc = [];
  const andar = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const s = fs.lstatSync(p); if (s.isDirectory()) { acc.push(`${path.relative(raiz, p)}/`); andar(p); } else acc.push(`${path.relative(raiz, p)}:${s.size}`); } };
  andar(raiz);
  return acc;
};
const primeiroArquivo = (raiz) => { let achado = null; const andar = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const s = fs.lstatSync(p); if (s.isDirectory()) andar(p); else if (achado === null) achado = p; } }; andar(raiz); return achado; };

/** Provedor FALSO com estado mutável por chave (para revogar/indisponibilizar depois da criação do chaveiro). */
function provedorFalso() {
  const segredos = new Map([['hml-k1', crypto.randomBytes(32)], ['hml-k2', crypto.randomBytes(32)]]);
  const estado = new Map([['hml-k1', 'ATIVA'], ['hml-k2', 'ATIVA']]);
  const fonte = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter: (id) => (estado.get(id) === 'ATIVA' ? { situacao: 'ATIVA', segredo: segredos.get(id) } : { situacao: estado.get(id) ?? 'INDISPONIVEL' }) } });
  return { fonte, estado };
}

/** Coordenador compartilhado FALSO (referência em memória do teste). */
function coordenadorFalso() {
  const m = new Map();
  const impl = {
    async emitir() { const id = crypto.randomBytes(16).toString('hex'); m.set(id, 'ATIVA'); return { id }; },
    async consumir(id) { const e = m.get(id); if (e === undefined) return { consumido: false, motivo: 'DESCONHECIDA' }; if (e === 'CONSUMIDA') return { consumido: false, motivo: 'JA_CONSUMIDA' }; m.set(id, 'CONSUMIDA'); return { consumido: true }; },
    async estado(id) { return m.get(id) ?? null; },
    async adquirirExclusao() { return { posse: 'p' }; }, async liberarExclusao() { return { liberada: true }; }, async recuperar() { return { ok: true }; },
  };
  return criarCoordenadorCompartilhado({ id: 'coord-teste', implementacao: impl, prazoMs: 200 });
}

async function montar({ spawn, observarGrupo, fronteira = 'PROCESSO_UNICO', extrasOperacao = {}, historico = [{ id: 'hml-k1', estado: 'ATIVA' }], chaveId = 'hml-k1', provedor = provedorFalso() } = {}) {
  const chaveiro = criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: provedor.fonte, historico });
  const obs = { conexoes: 0 };
  const portasExtras = {};
  if (spawn) portasExtras.spawn = spawn;
  if (observarGrupo) portasExtras.observarGrupo = observarGrupo;
  let validador = null;
  const a = await ambiente({
    relatorio: null,
    portasExtras,
    alterarConfig: (c) => {
      const original = c.conexao.criarConexao;
      c.conexao.criarConexao = (...x) => { obs.conexoes += 1; return original(...x); };
      c.chaves = { fonteDeChaves: chaveiro.fonteParaAssinar(), chaveId };
      const st = fs.lstatSync(c.armazenamento.publicados);
      validador = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: 'hml-dest-1', raiz: c.armazenamento.publicados, identidade: { dev: st.dev, ino: st.ino } }], PRODUCAO: [] } });
      return c;
    },
  });
  const operacao = { ambiente: 'HOMOLOGACAO', chaveiro, destino: { validador, destinoId: 'hml-dest-1' }, protecao: { uidsAutorizados: [uid] }, ...extrasOperacao };
  const politicaDeTeste = { origemDaChave: 'TESTE_CONTROLADO', destinos: [a.config.armazenamento.publicados] };
  const entrada = (politica = politicaDeTeste, execucao = { ...EXECUCAO, fronteira }) => criarEntradaOperacional({ composicao: a.config, execucao, operacao }, politica);
  return { a, chaveiro, provedor, operacao, obs, entrada, politicaDeTeste, validador };
}

const semEfeitos = async (m, falso, pendencia, op = m.entrada()) => {
  const antes = arvore(m.a.raiz);
  const pre = await op.avaliarPrerequisitos();
  assert.deepEqual([...pre.pendencias], [pendencia]);
  const r = await op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
  assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
  assert.equal(falso.chamadas.length, 0, 'nenhum processo');
  assert.equal(m.obs.conexoes, 0, 'nenhuma conexão');
  assert.equal(fs.existsSync(path.join(m.a.raiz, 'janela.lock')), false, 'janela não adquirida');
  assert.deepEqual(arvore(m.a.raiz), antes, 'árvore idêntica');
};

describe('[INT-A] fluxo integrado controlado (as sete capacidades pela entrada)', () => {
  teste('INT-A01 — política de execução + coordenação + chaveiro + destino + captura/autenticação + janela + escritores + durabilidade + registro + retenção + órfãos (dry-run), sem origem OPERACIONAL e sem recuperabilidade', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    const coord = coordenadorFalso();
    const op = m.entrada();
    assert.equal((await op.avaliarPrerequisitos()).aptos, true);

    const alertas = [];
    let agora = Date.now();
    const execucoes = [];
    const ctl = criarControladorDeExecucao({
      politica: { ...POLITICA_PADRAO, retencao: { ...POLITICA_PADRAO.retencao } },
      relogio: () => agora,
      prazo: nunca,
      alertar: async (a) => { alertas.push(a); },
      executar: async ({ execucaoId }) => {
        const emitida = await coord.emitir();
        const consumo = await coord.consumir(emitida.id);
        if (consumo.consumido !== true) return { executado: false, motivo: 'IDENTIDADE_NAO_AUTORIZADA' };
        const r = await op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
        execucoes.push({ execucaoId, coordenadorId: emitida.id, r });
        return r;
      },
    });
    assert.equal((await ctl.tick()).motivo, 'AGENDAMENTO_DESATIVADO', 'padrão desativado');
    assert.equal(falso.chamadas.length, 0);
    ctl.ativar({ confirmacao: CONFIRMACAO_DE_ATIVACAO });
    const tick = await ctl.tick();
    // a execução ocorre, mas NADA é operacional: o agendador registra falha (fail-closed), alerta e não conta sucesso
    assert.deepEqual([tick.acao, tick.motivo], ['FALHOU', 'BACKUP_NAO_VALIDO']);
    assert.deepEqual(alertas.map((x) => [x.tipo, x.motivo]), [['FALHA_DE_BACKUP', 'BACKUP_NAO_VALIDO']]);
    assert.deepEqual({ ...ctl.verificarHistorico() }, { integro: true, primeiraFalha: null });
    assert.deepEqual(ctl.historico().map((h) => h.evento), ['ATIVADO', 'INICIADA', 'FALHA']);

    const { r } = execucoes[0];
    assert.equal(r.executado, true);
    // captura + autenticação do pacote selado (manifesto V2 autenticado com chave de TESTE), janela reconhecida e liberada
    assert.equal(r.composto.prontidao.itens.MANIFESTO_V2_AUTENTICADO, true);
    assert.equal(r.composto.prontidao.itens.SUPERVISAO_E_DUMP_T1_T2, true);
    assert.deepEqual([r.composto.proveniencia.chaves.origem, r.composto.proveniencia.hashDoDump.correspondem], ['TESTE_CONTROLADO', true]);
    assert.equal(fs.existsSync(path.join(m.a.raiz, 'janela.lock')), false);
    // escritores externos observados; durabilidade separada; nada publicado
    assert.deepEqual([r.consistenciaDasImagens.consistente, r.escritoresExternos.garantia], [true, 'NAO_COMPROVADA']);
    assert.deepEqual([r.durabilidade.arquivoGravado, r.durabilidade.pacotePublicado, r.durabilidade.duravelmenteArmazenado], [true, false, false]);
    assert.deepEqual([r.autorizacaoReconhecidaPelaProducao, r.estados.publicacaoOperacionalAutorizada, r.estados.backupOperacionalValido, r.estados.restauracaoComprovada, r.estados.recuperabilidadeEmProducao], [false, false, false, false, false]);
    assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), []);

    // retenção: planeja e protege (sem remover nada)
    const pacote = { nome: 'prep-int-1', criadoEm: agora, restauracaoComprovada: false };
    const plano = planejarRetencao({ pacotes: [pacote], agora, retencao: { ...POLITICA_PADRAO.retencao } });
    assert.deepEqual([...plano.candidatosAExpurgo], []);
    // órfãos (dry-run) sobre a árvore real do ambiente: nada é candidato e nada é removido
    const antes = arvore(m.a.raiz);
    const operacoes = [{ id: 'o1', tipo: 'BACKUP', estado: 'CONCLUIDA', atualizadoEm: agora, artefatos: [{ raiz: 'preparacoes', nome: 'prep-int-1' }] }];
    const orfaos = identificarOrfaos({ raizes: { preparacoes: m.a.dirs.preparacoes, dumps: m.a.dirs.dumps, publicados: m.a.dirs.publicados }, uidsAutorizados: [uid], operacoes, janelaAtiva: false, politica: { idadeMinimaMs: DIA, retencaoMs: 30 * DIA }, agora });
    assert.equal(orfaos.resumo.candidatos, 0);
    assert.deepEqual(arvore(m.a.raiz), antes);

    // rotação preservando a chave histórica: o pacote assinado com hml-k1 continua verificável por VERIFICAR, nunca por ASSINAR, e deixa de ser verificável se a chave for revogada
    const bytes = fs.readFileSync(path.join(m.a.dirs.preparacoes, 'prep-int-1', 'manifesto.json'));
    const sha256 = r.composto.resultado.correlacao.manifesto.sha256Manifesto;
    const rotacionado = m.chaveiro.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] });
    const lido = criarLeitorV2({ fonteDeChaves: rotacionado.fonteParaVerificar() })({ bytes, sha256 });
    assert.deepEqual([lido.autenticacao.autenticado, lido.autenticacao.chaveId], [true, 'hml-k1']);
    assert.throws(() => criarLeitorV2({ fonteDeChaves: rotacionado.fonteParaAssinar() })({ bytes, sha256 }), (e) => e.motivo === 'CHAVE_INDISPONIVEL');
    const { chaveiro: revogado, pacotesNaoVerificaveis } = rotacionado.revogar({ chaveId: 'hml-k1', pacotes: [{ pacote: 'prep-int-1', chaveId: 'hml-k1' }] });
    assert.deepEqual([...pacotesNaoVerificaveis], ['prep-int-1']);
    assert.throws(() => criarLeitorV2({ fonteDeChaves: revogado.fonteParaVerificar() })({ bytes, sha256 }), (e) => e.motivo === 'CHAVE_REVOGADA');
  });

  teste('INT-A02 — os bloqueios operacionais estão todos fechados no código: nenhuma lista foi preenchida e o agendamento padrão é desativado', () => {
    assert.deepEqual([[...PROVEDORES_OPERACIONAIS_APROVADOS], [...DESTINOS_AUTORIZADOS.HOMOLOGACAO], [...DESTINOS_AUTORIZADOS.PRODUCAO], [...DESTINOS_OPERACIONAIS_AUTORIZADOS], [...ARMAZENAMENTOS_DURAVEIS_APROVADOS], [...COORDENADORES_COMPARTILHADOS_APROVADOS], [...CONTROLES_EXTERNOS_APROVADOS], [...POLITICA_DE_PRODUCAO.destinos]], [[], [], [], [], [], [], [], []]);
    assert.deepEqual([LIMPEZA_OPERACIONAL_HABILITADA, POLITICA_PADRAO.ativa, GARANTIA_CONTRA_ESCRITORES_EXTERNOS], [false, false, 'NAO_COMPROVADA']);
  });

  teste('INT-A03 — POLÍTICA DE PRODUÇÃO com o bloco completo: nunca apta (fonte, destino e controle externo), zero efeitos', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    const antes = arvore(m.a.raiz);
    const op = m.entrada(POLITICA_DE_PRODUCAO);
    const pre = await op.avaliarPrerequisitos();
    assert.deepEqual([...pre.pendencias].sort(), ['DESTINO_OPERACIONAL_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES', 'REQUISITO_EXTERNO_DE_EXCLUSAO']);
    assert.equal((await op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO })).motivo, 'PRE_REQUISITOS_AUSENTES');
    assert.deepEqual([falso.chamadas.length, m.obs.conexoes], [0, 0]);
    assert.deepEqual(arvore(m.a.raiz), antes);
  });
});

describe('[INT-B] falhas combinadas na fronteira da entrada (efeitos físicos medidos)', () => {
  teste('INT-B01 — chave disponível + DESTINO inválido', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    assert.equal(m.chaveiro.avaliar('hml-k1', 'ASSINAR').permitido, true);
    fs.chmodSync(m.a.dirs.publicados, 0o755);
    await semEfeitos(m, falso, 'DESTINO_VALIDADO');
  });

  teste('INT-B02 — DESTINO válido + chave REVOGADA no provedor depois da criação do chaveiro', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    m.provedor.estado.set('hml-k1', 'REVOGADA');
    assert.equal(m.validador.validar({ destinoId: 'hml-dest-1', raiz: m.a.dirs.publicados }).autorizado, true);
    await semEfeitos(m, falso, 'CHAVEIRO_COMPATIVEL');
  });

  teste('INT-B03 — chave que passou a ser APOSENTADA pela rotação, mas a composição continua assinando com ela', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    m.operacao.chaveiro = m.chaveiro.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] });
    await semEfeitos(m, falso, 'CHAVEIRO_COMPATIVEL');
  });

  teste('INT-B04 — coordenação multiprocesso insuficiente (coordenador de teste cumprindo o contrato) e fronteira sem coordenador', async () => {
    const f1 = spawnFalso();
    const m1 = await montar({ spawn: f1.spawn, fronteira: 'MULTIPROCESSO', extrasOperacao: { coordenador: coordenadorFalso() } });
    await semEfeitos(m1, f1, 'GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO');
    const f2 = spawnFalso();
    const m2 = await montar({ spawn: f2.spawn, fronteira: 'MULTIPROCESSO' });
    await semEfeitos(m2, f2, 'GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO');
  });

  teste('INT-B05 — ESCRITOR EXTERNO durante a captura: backup invalidado, imagem removida NÃO é reposta, nada publicado e o agendador registra falha', async () => {
    let a = null;
    let feito = false;
    const falso = spawnFalso({ aposDump: () => { if (!feito && a !== null) { feito = true; fs.unlinkSync(primeiroArquivo(a.dirs.imagens)); } } });
    const m = await montar({ spawn: falso.spawn });
    a = m.a;
    const antesImagens = arvore(a.dirs.imagens);
    const op = m.entrada();
    const ctl = criarControladorDeExecucao({ politica: { ...POLITICA_PADRAO, ativa: true, retencao: { ...POLITICA_PADRAO.retencao } }, relogio: () => Date.now(), prazo: nunca, alertar: async () => {}, executar: () => op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO }) });
    const t = await ctl.tick();
    assert.equal(feito, true);
    assert.deepEqual([t.acao, t.motivo], ['FALHOU', 'BACKUP_NAO_VALIDO']);
    const depois = arvore(a.dirs.imagens);
    assert.equal(depois.length, antesImagens.length - 1, 'a remoção externa permanece (o backup não "conserta" o armazenamento)');
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
  });

  teste('INT-B06 — pacote íntegro SEM durabilidade e FALHA de confirmação do armazenamento: nada é durável nem restaurável, com a evidência real da captura', async () => {
    const m = await montar();
    const r = await m.entrada().executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
    assert.equal(r.estados.backupTecnicamenteProduzido, true);
    assert.equal(r.durabilidade.duravelmenteArmazenado, false);
    const captura = { ...r.composto.proveniencia.captura, fsyncConcluido: r.composto.proveniencia.hashDoDump.fsyncConcluido === true };
    const publicadoSimulado = { publicada: true, estado: 'PUBLICADA' };
    const correl = r.composto.resultado.correlacao;
    for (const confirmar of [async () => { throw new Error('armazenamento fora do ar'); }, async (p) => ({ confirmado: true, ...p, bytes: p.bytes + 1 }), () => new Promise(() => {})]) {
      const destino = criarDestinoDuravel({ id: 'teste-duravel', adaptador: { confirmar }, prazoMs: 30 });
      const confirmacao = await destino.confirmarGravacao({ chave: 'prep-int-1/dump/postgres.dump', sha256: correl.dump.sha256, bytes: correl.dump.bytes });
      const c = classificarDurabilidade({ captura, publicacao: publicadoSimulado, confirmacao, restauravelComprovado: true });
      assert.deepEqual([c.arquivoGravado, c.sincronizadoLocalmente, c.duravelmenteArmazenado, c.restauravelComprovado], [true, true, false, false]);
    }
    const ok = await criarDestinoDuravel({ id: 'teste-duravel', adaptador: { confirmar: async (p) => ({ confirmado: true, ...p }) }, prazoMs: 100 }).confirmarGravacao({ chave: 'prep-int-1/dump/postgres.dump', sha256: correl.dump.sha256, bytes: correl.dump.bytes });
    assert.deepEqual([ok.confirmado, ok.operacional, classificarDurabilidade({ captura, publicacao: publicadoSimulado, confirmacao: ok, restauravelComprovado: true }).duravelmenteArmazenado], [true, false, false], 'confirmação de TESTE nunca é durabilidade operacional');
  });

  teste('INT-B07 — FALHA APÓS PREPARAÇÃO PARCIAL (pg_dump falha): trava RETIDA, nada publicado, a próxima execução NÃO lança processo, e os órfãos ficam protegidos enquanto a janela existir', async () => {
    const falso = spawnFalso({ dump: 'falha' });
    const m = await montar({ spawn: falso.spawn });
    const op = m.entrada();
    const r = await op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
    assert.deepEqual([r.composto.resultado.coordenador.saida, r.composto.resultado.coordenador.janela], [11, 'RETIDA']);
    const lock = path.join(m.a.raiz, 'janela.lock');
    assert.equal(fs.existsSync(lock), true);
    assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), []);
    assert.ok(fs.readdirSync(m.a.dirs.preparacoes).length + fs.readdirSync(m.a.dirs.dumps).length > 0, 'há resíduo parcial da preparação');
    const chamadas = falso.chamadas.length;
    const segunda = await op.executarBackup({ nomeDaPreparacao: 'prep-int-2', conjuntoId: CONJUNTO });
    assert.equal(segunda.composto.resultado.coordenador.janela, 'OCUPADA');
    assert.equal(falso.chamadas.length, chamadas, 'nenhum processo sem a posse da janela');
    // órfãos: com a janela retida tudo correlacionado fica protegido; só depois da liberação HUMANA aparece como candidato — e mesmo assim só em dry-run
    const artefatos = [...fs.readdirSync(m.a.dirs.preparacoes).map((nome) => ({ raiz: 'preparacoes', nome })), ...fs.readdirSync(m.a.dirs.dumps).map((nome) => ({ raiz: 'dumps', nome }))];
    assert.ok(artefatos.length > 0);
    const operacoes = [{ id: 'o1', tipo: 'BACKUP', estado: 'INTERROMPIDA', atualizadoEm: Date.now() - 5 * DIA, artefatos }];
    const entradaOrfaos = (janelaAtiva) => ({ raizes: { preparacoes: m.a.dirs.preparacoes, dumps: m.a.dirs.dumps, publicados: m.a.dirs.publicados }, uidsAutorizados: [uid], operacoes, janelaAtiva, politica: { idadeMinimaMs: 1, retencaoMs: 2 }, agora: Date.now() + 1000 });
    assert.equal(identificarOrfaos(entradaOrfaos(fs.existsSync(lock))).resumo.candidatos, 0);
    fs.unlinkSync(lock); // decisão humana simulada
    const antes = arvore(m.a.raiz);
    const livre = identificarOrfaos(entradaOrfaos(fs.existsSync(lock)));
    assert.ok(livre.resumo.candidatos >= 1);
    assert.deepEqual(arvore(m.a.raiz), antes, 'dry-run não remove');
  });
});

describe('[INT-C] concorrência, identidade, retenção e órfãos durante a operação', () => {
  teste('INT-C01 — OPERAÇÃO ATIVA nunca é classificada como órfã: durante a execução (janela e operação registrada ativas) o plano protege a preparação, e nada é removido', async () => {
    let m = null;
    const planos = [];
    let dentro = false;
    const m1 = await montar({
      observarGrupo: async () => {
        if (m === null || dentro || !fs.existsSync(path.join(m.a.dirs.preparacoes, 'prep-int-1', 'manifesto.json'))) return false;
        dentro = true;
        const operacoes = [{ id: 'o1', tipo: 'BACKUP', estado: 'ATIVA', atualizadoEm: Date.now() - 10 * DIA, artefatos: [{ raiz: 'preparacoes', nome: 'prep-int-1' }] }];
        const base = { raizes: { preparacoes: m.a.dirs.preparacoes, dumps: m.a.dirs.dumps, publicados: m.a.dirs.publicados }, uidsAutorizados: [uid], operacoes, politica: { idadeMinimaMs: 1, retencaoMs: 2 }, agora: Date.now() + 1000 };
        planos.push(identificarOrfaos({ ...base, janelaAtiva: fs.existsSync(path.join(m.a.raiz, 'janela.lock')) }), identificarOrfaos({ ...base, janelaAtiva: false }));
        return false;
      },
    });
    m = m1;
    const r = await m.entrada().executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
    assert.equal(r.executado, true);
    assert.equal(dentro, true);
    const [comJanela, semJanela] = planos;
    assert.equal(comJanela.itens.find((i) => i.nome === 'prep-int-1').motivo, 'JANELA_ATIVA');
    assert.equal(semJanela.itens.find((i) => i.nome === 'prep-int-1').motivo, 'OPERACAO_ATIVA');
    assert.deepEqual([comJanela.resumo.candidatos, semJanela.resumo.candidatos], [0, 0]);
    assert.equal(fs.existsSync(path.join(m.a.dirs.preparacoes, 'prep-int-1')), true);
  });

  teste('INT-C02 — AGENDAMENTO CONCORRENTE e execução direta simultânea: uma só preparação, um só pg_dump', async () => {
    let liberar;
    let entradaPronta;
    const travado = new Promise((r) => { liberar = r; });
    let falso = null;
    const m = await montar({ spawn: (...args) => falso.spawn(...args), observarGrupo: async () => { await travado; return false; } });
    falso = spawnFalso();
    const op = m.entrada();
    const ctl = criarControladorDeExecucao({ politica: { ...POLITICA_PADRAO, ativa: true, retencao: { ...POLITICA_PADRAO.retencao } }, relogio: () => Date.now(), prazo: nunca, alertar: async () => {}, executar: () => { entradaPronta = op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO }); return entradaPronta; } });
    const t1 = ctl.tick();
    for (let i = 0; i < 20 && falso.chamadas.length === 0; i += 1) await assentar();
    assert.equal((await ctl.tick()).motivo, 'EM_ANDAMENTO');
    const direta = await op.executarBackup({ nomeDaPreparacao: 'prep-int-9', conjuntoId: CONJUNTO });
    assert.deepEqual([direta.executado, direta.motivo, direta.efeitos], [false, 'OPERACAO_EM_ANDAMENTO', 'NENHUM']);
    liberar();
    await t1;
    assert.equal(falso.chamadas.filter((c) => c.nome === 'pg_dump').length, 1);
    assert.equal(fs.readdirSync(m.a.dirs.preparacoes).includes('prep-int-9'), false);
  });

  teste('INT-C03 — IDENTIDADE desconhecida ou reapresentada: a execução com identidade que o coordenador nunca emitiu, ou já consumida, não chega à entrada (zero efeitos)', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    const coord = coordenadorFalso();
    const op = m.entrada();
    const antes = arvore(m.a.raiz);
    const executarCom = async (id) => {
      const consumo = await coord.consumir(id);
      if (consumo.consumido !== true) return { executado: false, motivo: `IDENTIDADE_${consumo.motivo}` };
      return op.executarBackup({ nomeDaPreparacao: 'prep-int-1', conjuntoId: CONJUNTO });
    };
    assert.equal((await executarCom('a'.repeat(32))).motivo, 'IDENTIDADE_DESCONHECIDA');
    const { id } = await coord.emitir();
    assert.equal((await executarCom(id)).executado, true);
    const reapresentada = await executarCom(id);
    assert.equal(reapresentada.motivo, 'IDENTIDADE_JA_CONSUMIDA');
    assert.equal(falso.chamadas.filter((c) => c.nome === 'pg_dump').length, 1, 'só a execução autorizada lançou pg_dump');
    assert.notDeepEqual(arvore(m.a.raiz), antes);
  });

  teste('INT-C04 — RETENÇÃO nunca atinge o pacote ainda necessário à restauração (única restauração comprovada, mais nova que a idade mínima, últimos N)', () => {
    const agora = 1_000_000_000_000;
    const p = (nome, dias, comprovada = false) => ({ nome, criadoEm: agora - dias * DIA, restauracaoComprovada: comprovada });
    const plano = planejarRetencao({ pacotes: [p('novo', 1), p('base-de-restauracao', 120, true), p('velho-1', 100), p('velho-2', 110)], agora, retencao: { manterUltimos: 1, idadeMinimaMs: 7 * DIA } });
    assert.deepEqual([...plano.candidatosAExpurgo].sort(), ['velho-1', 'velho-2']);
    assert.ok(plano.manter.some((x) => x.nome === 'base-de-restauracao' && x.motivo === 'ULTIMA_RESTAURACAO_COMPROVADA'));
    assert.equal(plano.modo, 'PLANO');
  });
});
