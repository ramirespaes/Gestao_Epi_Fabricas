'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarEntradaOperacional, ESTADOS_BLOQUEADOS } = require('../../src/services/imagem-backup-operacao.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarChaveiro } = require('../../src/services/imagem-backup-chaveiro.service');
const { criarValidadorDeDestinos } = require('../../src/services/imagem-backup-destinos.service');
const { criarCoordenadorCompartilhado } = require('../../src/services/imagem-backup-coordenacao.service');
const { criarDestinoDuravel } = require('../../src/services/imagem-backup-durabilidade.service');
const { ambiente, spawnFalso } = require('../helpers/ambiente-backup-operacao');

/**
 * ENTRADA OPERACIONAL com o bloco `operacao` (chaveiro, destinos, proteção do armazenamento, coordenação, durabilidade): dependências controladas, fábricas de TESTE. Nada aqui autoriza publicação operacional.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const uid = process.getuid();
const EXECUCAO = Object.freeze({ fronteira: 'PROCESSO_UNICO', politica: { versao: 1, execucoesSimultaneas: 1 } });
const ENTRADA = { nomeDaPreparacao: 'prep-sg-1', conjuntoId: 'conjunto-sg-0001' };
const codigo = (fn, c) => assert.throws(fn, (e) => e.code === c, c);
const fotografiaDeArquivos = (raiz) => {
  const acc = [];
  const andar = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const s = fs.lstatSync(p); if (s.isDirectory()) { acc.push(`${path.relative(raiz, p)}/`); andar(p); } else acc.push(`${path.relative(raiz, p)}:${s.size}`); } };
  andar(raiz);
  return acc;
};
const primeiroArquivo = (raiz) => { let achado = null; const andar = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const s = fs.lstatSync(p); if (s.isDirectory()) andar(p); else if (achado === null) achado = p; } }; andar(raiz); return achado; };

/** Ambiente com chaveiro de HOMOLOGAÇÃO (ids hml-*), fonte de assinatura derivada e destino validado por lista de TESTE. */
async function montar({ spawn, observarGrupo, ajustar = () => {}, fronteira = 'PROCESSO_UNICO', extrasOperacao = {} } = {}) {
  const base = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'hml-k1', segredo: crypto.randomBytes(32) }, { id: 'hml-k2', segredo: crypto.randomBytes(32) }] });
  const chaveiro = criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: base, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] });
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
      c.chaves = { fonteDeChaves: chaveiro.fonteParaAssinar(), chaveId: 'hml-k1' };
      const st = fs.lstatSync(c.armazenamento.publicados);
      validador = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: 'hml-dest-1', raiz: c.armazenamento.publicados, identidade: { dev: st.dev, ino: st.ino } }], PRODUCAO: [] } });
      return c;
    },
  });
  const operacao = { ambiente: 'HOMOLOGACAO', chaveiro, destino: { validador, destinoId: 'hml-dest-1' }, protecao: { uidsAutorizados: [uid] }, ...extrasOperacao };
  ajustar(a, operacao);
  const entrada = (politica, execucao = { ...EXECUCAO, fronteira }) => criarEntradaOperacional({ composicao: a.config, execucao, operacao }, politica);
  const politicaDeTeste = { origemDaChave: 'TESTE_CONTROLADO', destinos: [a.config.armazenamento.publicados] };
  return { a, chaveiro, validador, operacao, obs, entrada, politicaDeTeste, base };
}

describe('[SG-A] caminho com o bloco `operacao` (política de TESTE)', () => {
  teste('SG-A01 — pré-requisitos satisfeitos; imagens consistentes; durabilidade separada (gravado/sincronização local não são durável); garantia contra escritores externos NÃO comprovada; nada publicado', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    const op = m.entrada(m.politicaDeTeste);
    const pre = await op.avaliarPrerequisitos();
    assert.deepEqual([pre.aptos, pre.itens.CHAVEIRO_COMPATIVEL, pre.itens.DESTINO_VALIDADO, pre.itens.PROTECAO_LOCAL_DO_ARMAZENAMENTO], [true, true, true, true]);
    assert.equal('REQUISITO_EXTERNO_DE_EXCLUSAO' in pre.itens, false, 'só exigido na política de produção');
    const r = await op.executarBackup(ENTRADA);
    assert.equal(r.executado, true);
    assert.deepEqual({ consistente: r.consistenciaDasImagens.consistente, motivo: r.consistenciaDasImagens.motivo }, { consistente: true, motivo: null });
    assert.deepEqual({ ...r.escritoresExternos }, { garantia: 'NAO_COMPROVADA', detectadoDuranteAExecucao: false });
    assert.deepEqual([r.durabilidade.arquivoGravado, r.durabilidade.pacotePublicado, r.durabilidade.sincronizadoLocalmente, r.durabilidade.duravelmenteArmazenado, r.durabilidade.restauravelComprovado], [true, false, false, false, false]);
    assert.equal(r.estados.backupTecnicamenteProduzido, true);
    assert.deepEqual([r.estados.publicacaoOperacionalAutorizada, r.estados.backupOperacionalValido, r.estados.recuperabilidadeEmProducao], [false, false, false]);
    assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), []);
  });

  teste('SG-A02 — POLÍTICA DE PRODUÇÃO com o bloco: além da fonte e do destino operacionais, falta o controle externo contra escritores; nunca apto; zero spawn e zero conexão', async () => {
    const falso = spawnFalso();
    const m = await montar({ spawn: falso.spawn });
    const antes = fotografiaDeArquivos(m.a.raiz);
    const op = m.entrada(undefined);
    const pre = await op.avaliarPrerequisitos();
    assert.equal(pre.aptos, false);
    assert.deepEqual([...pre.pendencias].sort(), ['DESTINO_OPERACIONAL_AUTORIZADO', 'FONTE_OPERACIONAL_DE_CHAVES', 'REQUISITO_EXTERNO_DE_EXCLUSAO']);
    const r = await op.executarBackup(ENTRADA);
    assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
    assert.equal(falso.chamadas.length, 0);
    assert.equal(m.obs.conexoes, 0);
    assert.deepEqual(fotografiaDeArquivos(m.a.raiz), antes);
  });
});

describe('[SG-B] escritor externo durante o backup', () => {
  const comEscritor = async (mexer) => {
    let a = null;
    let feito = false;
    const m = await montar({ observarGrupo: async () => { if (!feito && a !== null) { feito = true; mexer(a); } return false; } });
    a = m.a;
    const op = m.entrada(m.politicaDeTeste);
    const r = await op.executarBackup(ENTRADA);
    assert.equal(feito, true, 'o escritor externo agiu durante a execução');
    return { m, op, r };
  };

  teste('SG-B01 — REMOÇÃO concorrente de uma imagem invalida o backup: todos os estados falsos, prova de restauração negada por BACKUP_INCONSISTENTE sem spawn/conexão de restauração', async () => {
    const { r, op } = await comEscritor((a) => fs.unlinkSync(primeiroArquivo(a.dirs.imagens)));
    assert.equal(r.executado, true);
    assert.deepEqual([r.consistenciaDasImagens.consistente, r.consistenciaDasImagens.motivo, r.consistenciaDasImagens.removidos], [false, 'ALTERACAO_CONCORRENTE', 1]);
    assert.equal(r.escritoresExternos.detectadoDuranteAExecucao, true);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
    const prova = await op.provarRestauracao({ resultado: r, imagens: { raiz: '/tmp', nome: 'x' }, destino: {} }).catch((e) => ({ erro: e.code }));
    assert.ok(prova.erro === 'CONFIGURACAO_INVALIDA' || prova.motivo === 'RESTAURACAO_NAO_CONFIGURADA' || prova.motivo === 'BACKUP_INCONSISTENTE');
  });

  teste('SG-B02 — MODIFICAÇÃO concorrente de uma imagem também invalida', async () => {
    const { r } = await comEscritor((a) => fs.appendFileSync(primeiroArquivo(a.dirs.imagens), 'x'));
    assert.deepEqual([r.consistenciaDasImagens.consistente, r.consistenciaDasImagens.modificados], [false, 1]);
    assert.deepEqual({ ...r.estados }, { ...ESTADOS_BLOQUEADOS, homologacaoTecnicaConcluida: null });
  });

  teste('SG-B03 — ADIÇÃO concorrente é tolerada e sinalizada (SOMENTE_ADICOES); os estados seguem a avaliação normal', async () => {
    const { r } = await comEscritor((a) => fs.writeFileSync(path.join(a.dirs.imagens, 'novo-arquivo'), 'novo', { mode: 0o600 }));
    assert.deepEqual([r.consistenciaDasImagens.consistente, r.consistenciaDasImagens.motivo, r.consistenciaDasImagens.adicionados], [true, 'SOMENTE_ADICOES', 1]);
    assert.equal(r.estados.backupTecnicamenteProduzido, true);
    assert.equal(r.estados.backupOperacionalValido, false);
  });
});

describe('[SG-C] pré-requisitos do bloco falham ANTES de qualquer efeito (medido)', () => {
  const semEfeitos = async (m, falso, pendencia) => {
    const antes = fotografiaDeArquivos(m.a.raiz);
    const op = m.entrada(m.politicaDeTeste);
    const pre = await op.avaliarPrerequisitos();
    assert.deepEqual([...pre.pendencias], [pendencia]);
    const r = await op.executarBackup(ENTRADA);
    assert.deepEqual([r.executado, r.motivo, r.efeitos], [false, 'PRE_REQUISITOS_AUSENTES', 'NENHUM']);
    assert.equal(falso.chamadas.length, 0);
    assert.equal(m.obs.conexoes, 0);
    assert.equal(fs.existsSync(path.join(m.a.raiz, 'janela.lock')), false);
    assert.deepEqual(fotografiaDeArquivos(m.a.raiz), antes);
  };

  teste('SG-C01 — CHAVEIRO incompatível: fonte da composição que não é derivada do chaveiro, chave aposentada em uso e chaveiro rotacionado sem atualizar a composição', async () => {
    const f1 = spawnFalso();
    const m1 = await montar({ spawn: f1.spawn, ajustar: (a) => { a.config.chaves = { fonteDeChaves: criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'hml-k1', segredo: crypto.randomBytes(32) }] }), chaveId: 'hml-k1' }; } });
    await semEfeitos(m1, f1, 'CHAVEIRO_COMPATIVEL');
    const f2 = spawnFalso();
    const m2 = await montar({ spawn: f2.spawn });
    const rotacionado = m2.chaveiro.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] });
    m2.operacao.chaveiro = rotacionado;
    await semEfeitos(m2, f2, 'CHAVEIRO_COMPATIVEL');
  });

  teste('SG-C02 — DESTINO: permissão excessiva, identidade trocada e id desconhecido', async () => {
    const f1 = spawnFalso();
    const m1 = await montar({ spawn: f1.spawn });
    fs.chmodSync(m1.a.config.armazenamento.publicados, 0o755);
    await semEfeitos(m1, f1, 'DESTINO_VALIDADO');
    const f2 = spawnFalso();
    const m2 = await montar({ spawn: f2.spawn });
    const pub = m2.a.config.armazenamento.publicados;
    fs.renameSync(pub, `${pub}-antigo`);
    fs.mkdirSync(pub, { mode: 0o700 });
    await semEfeitos(m2, f2, 'DESTINO_VALIDADO');
    const f3 = spawnFalso();
    const m3 = await montar({ spawn: f3.spawn });
    m3.operacao.destino = { validador: m3.validador, destinoId: 'hml-nao-existe' };
    await semEfeitos(m3, f3, 'DESTINO_VALIDADO');
  });

  teste('SG-C03 — PROTEÇÃO local do armazenamento: imagem com escrita para terceiros, ou dono fora da lista', async () => {
    const f1 = spawnFalso();
    const m1 = await montar({ spawn: f1.spawn });
    fs.chmodSync(primeiroArquivo(m1.a.dirs.imagens), 0o666);
    await semEfeitos(m1, f1, 'PROTECAO_LOCAL_DO_ARMAZENAMENTO');
    const f2 = spawnFalso();
    const m2 = await montar({ spawn: f2.spawn });
    m2.operacao.protecao = { uidsAutorizados: [uid + 100000] };
    await semEfeitos(m2, f2, 'PROTECAO_LOCAL_DO_ARMAZENAMENTO');
  });

  teste('SG-C04 — fronteira MULTIPROCESSO continua FECHADA mesmo com coordenador compartilhado de teste que cumpre o contrato', async () => {
    const f = spawnFalso();
    const impl = {
      async emitir() { return { id: crypto.randomBytes(16).toString('hex') }; }, async consumir() { return { consumido: true }; }, async estado() { return 'ATIVA'; },
      async adquirirExclusao() { return { posse: 'p' }; }, async liberarExclusao() { return { liberada: true }; }, async recuperar() { return { ok: true }; },
    };
    const coordenador = criarCoordenadorCompartilhado({ id: 'coord-teste', implementacao: impl, prazoMs: 50 });
    const m = await montar({ spawn: f.spawn, fronteira: 'MULTIPROCESSO', extrasOperacao: { coordenador } });
    await semEfeitos(m, f, 'GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO');
  });
});

describe('[SG-D] blocos forjados ou malformados são recusados na construção', () => {
  teste('SG-D01 — chaveiro literal/clonado, validador que devolve objeto fabricado, coordenador literal, ambiente trocado e chaves extras ou ausentes', async () => {
    const m = await montar();
    const cfg = (operacao) => ({ composicao: m.a.config, execucao: EXECUCAO, operacao });
    const bom = m.operacao;
    codigo(() => criarEntradaOperacional(cfg({ ...bom, chaveiro: { ...bom.chaveiro } })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ...bom, chaveiro: { ambiente: 'HOMOLOGACAO', chaveAtivaId: () => 'hml-k1' } })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ...bom, ambiente: 'PRODUCAO' })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ...bom, coordenador: { operacional: true, compartilhado: true } })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ...bom, extra: 1 })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ambiente: 'HOMOLOGACAO', chaveiro: bom.chaveiro })), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarEntradaOperacional(cfg({ ...bom, protecao: { uidsAutorizados: [] } })), 'CONFIGURACAO_INVALIDA');
    // o validador fabricado passa pela forma, mas NUNCA satisfaz DESTINO_VALIDADO (a validação precisa ser reconhecida)
    const op = criarEntradaOperacional(cfg({ ...bom, destino: { validador: { ambiente: 'HOMOLOGACAO', validar: () => ({ autorizado: true, origem: 'OPERACIONAL' }) }, destinoId: 'hml-dest-1' } }), m.politicaDeTeste);
    assert.ok((await op.avaliarPrerequisitos()).pendencias.includes('DESTINO_VALIDADO'));
  });

  teste('SG-D02 — destino durável de teste nunca é chamado sem pacote publicado e não torna nada durável', async () => {
    let chamadas = 0;
    const destinoDuravel = criarDestinoDuravel({ id: 'teste-duravel', adaptador: { confirmar: async (p) => { chamadas += 1; return { confirmado: true, ...p }; } }, prazoMs: 100 });
    const m = await montar({ extrasOperacao: { destinoDuravel } });
    const r = await m.entrada(m.politicaDeTeste).executarBackup(ENTRADA);
    assert.equal(chamadas, 0);
    assert.deepEqual([r.durabilidade.duravelmenteArmazenado, r.durabilidade.restauravelComprovado], [false, false]);
  });
});
