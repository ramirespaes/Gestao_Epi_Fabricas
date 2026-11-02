'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { abrirPacote, criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarRestauradorDoBanco } = require('../../src/services/imagem-backup-restauracao-banco.service');
const { criarLancadorDeRestauracaoComSpawn, criarLancadorDeRestauracaoReal } = require('../../src/services/imagem-backup-restauracao-lancador.service');
const { criarFonteDeChaves, criarLeitorV2, criarAutenticador } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { construirPacotePublicado, limparTemporarios, novaRaiz, criarFonteFicticia } = require('../helpers/pacote-publicado-ficticio');

/**
 * MANIFESTO V2 AUTENTICADO + lançador de restauração + consistência lógica contratual + integração Marco C -> D. Tudo FICTÍCIO: chaves aleatórias geradas em memória, pacotes gerados pelo pipeline real em temporários do próprio teste,
 * banco/pg_dump/pg_restore SIMULADOS (nenhum processo operacional, nenhum PostgreSQL). Nada aqui comprova restauração real, publicação operacional ou recuperabilidade.
 */

after(limparTemporarios);
const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const DESTINO_BANCO = Object.freeze({ banco: 'gepi_restauracao_temp1', host: '127.0.0.1', porta: 5432, usuario: 'gepi_restore', arquivoDeSenha: '/tmp/senha-ficticia' });
const POLITICA = { prefixoDoBanco: 'gepi_restauracao_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi', 'gestao_epi_producao'] };

async function pacoteV2(extra = {}) {
  const f = criarFonteFicticia(extra.chavesExtras ?? []);
  const p = await construirPacotePublicado({ autenticado: { fonteDeChaves: f.fonteDeChaves, chaveId: f.chaveId } });
  return { ...p, ...f };
}
const abrirV2 = (p, fonteDeChaves = p.fonteDeChaves) => abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves });

/** Regrava manifesto e selo de forma COERENTE (como faria um atacante sem a chave). */
function reescrever(p, mutador) {
  const alvo = path.join(p.caminho, 'manifesto.json');
  const objeto = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  mutador(objeto);
  const bytes = Buffer.from(JSON.stringify(objeto), 'utf8');
  fs.writeFileSync(alvo, bytes);
  fs.writeFileSync(path.join(p.caminho, 'manifesto.sha256'), `${sha(bytes)}  manifesto.json\n`);
}

// ----------------------------------------------------------------------------------------------------------------------- fonte de chaves
describe('[V2-F] fonte de chaves', () => {
  teste('V2-F01 — só a origem TESTE_CONTROLADO é produzível; origem operacional, segredo curto, id inválido, duplicado e chave extra são recusados', () => {
    const seg = crypto.randomBytes(32);
    assert.throws(() => criarFonteDeChaves({ origem: 'OPERACIONAL', chaves: [{ id: 'a', segredo: seg }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a', segredo: crypto.randomBytes(16) }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a b', segredo: seg }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a', segredo: seg }, { id: 'a', segredo: seg }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a', segredo: seg, extra: 1 }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [] }), (e) => e.code === 'FONTE_INVALIDA');
  });

  teste('V2-F02 — o segredo não sai por serialização nem por propriedade; a fonte é imutável; leitores só aceitam fontes produzidas pela fábrica', () => {
    const f = criarFonteFicticia();
    const texto = JSON.stringify(f.fonteDeChaves);
    assert.equal(texto.includes(f.segredo.toString('hex')), false);
    assert.equal(texto.includes(f.segredo.toString('base64')), false);
    assert.equal(Object.isFrozen(f.fonteDeChaves), true);
    const falsa = { origem: 'TESTE_CONTROLADO', obter: () => ({ situacao: 'ATIVA', segredo: f.segredo }) };
    assert.throws(() => criarLeitorV2({ fonteDeChaves: falsa }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => criarAutenticador({ fonteDeChaves: falsa, chaveId: 'chave-teste-1' }), (e) => e.code === 'FONTE_INVALIDA');
    const copia = f.fonteDeChaves.obter('chave-teste-1').segredo;
    copia.fill(0);
    assert.equal(f.fonteDeChaves.obter('chave-teste-1').segredo.equals(f.segredo), true, 'alterar a cópia não altera a chave guardada');
  });

  teste('V2-F03 — fora de NODE_ENV=test a fábrica recusa até a origem de teste (processo novo, sem ambiente)', () => {
    const modulo = path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-manifesto-autenticado.service.js');
    const script = `const m = require(${JSON.stringify(modulo)}); try { m.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a', segredo: Buffer.alloc(32, 1) }] }); process.stdout.write('ACEITOU'); } catch (e) { process.stdout.write(e.code); }`;
    const filho = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 20000 });
    assert.equal(filho.stdout, 'FONTE_INVALIDA');
  });
});

// ----------------------------------------------------------------------------------------------------------------------- prova integrada positiva
describe('[V2-P] pacote V2: produção -> autenticação -> selagem -> publicação -> abertura independente', () => {
  teste('V2-P01 — POSITIVO: o pacote publicado é aberto só pelos arquivos e devolve ok:true com autenticação V2; o manifesto declara layout, dump.arquivo e MAC, sem nenhum segredo', async () => {
    const p = await pacoteV2();
    const r = await abrirV2(p);
    assert.equal(r.ok, true, `abertura V2 falhou: ${r.motivo}`);
    assert.deepEqual({ ...r.autenticacao }, { versao: 2, autenticado: true, algoritmo: 'HMAC-SHA256', chaveId: 'chave-teste-1', origemDaChave: 'TESTE_CONTROLADO' });
    assert.deepEqual(Object.keys(r.manifesto).sort(), ['arquivos', 'autenticacao', 'banco', 'conjuntoId', 'dump', 'layout', 'versao']);
    assert.equal(r.manifesto.versao, 2);
    assert.equal(r.manifesto.layout, 1);
    assert.equal(r.manifesto.dump.arquivo, 'dump/postgres.dump');
    assert.match(r.manifesto.autenticacao.mac, /^[0-9a-f]{64}$/);
    for (const arq of ['manifesto.json', 'manifesto.sha256']) {
      const conteudo = fs.readFileSync(path.join(p.caminho, arq), 'utf8');
      assert.equal(conteudo.includes(p.segredo.toString('hex')), false);
      assert.equal(conteudo.includes(p.segredo.toString('base64')), false);
    }
    assert.equal(r.arquivos, 8);
  });

  teste('V2-P02 — INDEPENDÊNCIA: um processo Node NOVO, com a chave entregue só em memória pelo script do teste, autentica e abre o pacote', async () => {
    const p = await pacoteV2();
    const modulo = path.join(__dirname, '..', '..', 'src', 'services');
    const script = `const { abrirPacote } = require(${JSON.stringify(path.join(modulo, 'imagem-backup-restauracao.service.js'))});
      const { criarFonteDeChaves } = require(${JSON.stringify(path.join(modulo, 'imagem-backup-manifesto-autenticado.service.js'))});
      const fonteDeChaves = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-teste-1', segredo: Buffer.from(${JSON.stringify(p.segredo.toString('hex'))}, 'hex') }] });
      abrirPacote({ raizAutorizada: ${JSON.stringify(p.publicados)}, nome: ${JSON.stringify(p.nome)}, fonteDeChaves }).then((r) => { process.stdout.write(JSON.stringify({ ok: r.ok, motivo: r.motivo ?? null, aut: r.autenticacao ?? null })); });`;
    const filho = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: { NODE_ENV: 'test' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(filho.status, 0, filho.stderr);
    const saida = JSON.parse(filho.stdout);
    assert.equal(saida.ok, true);
    assert.equal(saida.aut.autenticado, true);
  });

  teste('V2-P03 — o mesmo processo com uma chave DIFERENTE (mesmo id) não autentica o pacote publicado', async () => {
    const p = await pacoteV2();
    const outra = criarFonteFicticia();
    const r = await abrirV2(p, outra.fonteDeChaves);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'AUTENTICACAO_INVALIDA');
  });
});

// ----------------------------------------------------------------------------------------------------------------------- contraprovas
describe('[V2-C] contraprovas de autenticação', () => {
  teste('V2-C01 — imagem + manifesto + selo adulterados em conjunto, SEM a chave: nunca há validação positiva (o limite do V1 não vale para o V2)', async () => {
    const p = await pacoteV2();
    const lido = await abrirV2(p);
    const alvo = lido.manifesto.arquivos[0];
    const novo = Buffer.from('conteudo-forjado-por-quem-reescreve-tudo');
    fs.writeFileSync(path.join(p.caminho, 'imagens', ...alvo.chave.split('/')), novo);
    reescrever(p, (m) => { const item = m.arquivos.find((a) => a.chave === alvo.chave); item.bytes = novo.length; item.sha256 = sha(novo); });
    const r = await abrirV2(p);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'AUTENTICACAO_INVALIDA');
  });

  teste('V2-C02 — HMAC adulterado (um dígito) com selo coerente é recusado', async () => {
    const p = await pacoteV2();
    reescrever(p, (m) => { const mac = m.autenticacao.mac; m.autenticacao.mac = (mac[0] === '0' ? '1' : '0') + mac.slice(1); });
    const r = await abrirV2(p);
    assert.deepEqual([r.ok, r.motivo], [false, 'AUTENTICACAO_INVALIDA']);
  });

  teste('V2-C03 — caminho do dump e layout forjados (com selo coerente) são recusados pelo MAC ANTES de serem confiados', async () => {
    const p = await pacoteV2();
    reescrever(p, (m) => { m.dump.arquivo = '../fora/postgres.dump'; m.layout = 99; });
    const r = await abrirV2(p);
    assert.deepEqual([r.ok, r.motivo], [false, 'AUTENTICACAO_INVALIDA']);
  });

  teste('V2-C04 — metadados de autenticação ausentes, algoritmo trocado e chave desconhecida são recusados com motivo próprio', async () => {
    const a = await pacoteV2();
    reescrever(a, (m) => { delete m.autenticacao; });
    assert.equal((await abrirV2(a)).motivo, 'AUTENTICACAO_AUSENTE');
    const b = await pacoteV2();
    reescrever(b, (m) => { m.autenticacao.algoritmo = 'none'; });
    assert.equal((await abrirV2(b)).motivo, 'AUTENTICACAO_INVALIDA');
    const c = await pacoteV2();
    reescrever(c, (m) => { m.autenticacao.chaveId = 'chave-inexistente'; });
    assert.equal((await abrirV2(c)).motivo, 'CHAVE_INDISPONIVEL');
    const d = await pacoteV2();
    reescrever(d, (m) => { m.autenticacao.mac = 'zz'; });
    assert.equal((await abrirV2(d)).motivo, 'AUTENTICACAO_AUSENTE');
  });

  teste('V2-C05 — manifesto alterado SEM refazer o selo: SELO/MANIFESTO divergente, sem aprovação', async () => {
    const p = await pacoteV2();
    const alvo = path.join(p.caminho, 'manifesto.json');
    fs.writeFileSync(alvo, Buffer.concat([fs.readFileSync(alvo), Buffer.from(' ')]));
    const r = await abrirV2(p);
    assert.equal(r.ok, false);
  });

  teste('V2-C06 — ROTAÇÃO: chave revogada é recusada; pacote assinado pela chave antiga ainda autentica enquanto ela está ativa na fonte; chave nova não autentica o antigo', async () => {
    const velha = { id: 'chave-velha', segredo: crypto.randomBytes(32) };
    const f1 = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [velha] });
    const p = await construirPacotePublicado({ autenticado: { fonteDeChaves: f1, chaveId: 'chave-velha' } });
    const nova = { id: 'chave-nova', segredo: crypto.randomBytes(32) };
    const ativas = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [velha, nova] });
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: ativas })).ok, true);
    const revogada = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ ...velha, revogada: true }, nova] });
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: revogada })).motivo, 'CHAVE_REVOGADA');
    const soNova = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [nova] });
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: soNova })).motivo, 'CHAVE_INDISPONIVEL');
  });

  teste('V2-C07 — evidência de autenticação FABRICADA não é aceita: entradas com `autenticacao`, `pacote`, `correlacao`, `recuperavel` ou fonte falsa são recusadas na fronteira', async () => {
    const p = await pacoteV2();
    const falsa = { origem: 'TESTE_CONTROLADO', obter: () => ({ situacao: 'ATIVA', segredo: p.segredo }) };
    await assert.rejects(() => abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: falsa }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    await assert.rejects(() => abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, autenticacao: { autenticado: true } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    const rest = criarRestaurador({ fonteDeChaves: p.fonteDeChaves });
    await assert.rejects(() => rest.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'i' }, autenticacao: { autenticado: true } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => criarRestaurador({ fonteDeChaves: falsa }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => criarRestaurador({ fonteDeChaves: { origem: 'TESTE_CONTROLADO' } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
  });

  teste('V2-C08 — a comparação do MAC usa `timingSafeEqual` e nenhum módulo novo lê ambiente, disco ou rede', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    const aut = fs.readFileSync(path.join(base, 'imagem-backup-manifesto-autenticado.service.js'), 'utf8');
    assert.match(aut, /timingSafeEqual/);
    assert.equal(/require\('node:(?:fs|child_process|net|http|https)/.test(aut), false);
    assert.equal(/process\.env\.(?!NODE_ENV)/.test(aut), false);
    const lan = fs.readFileSync(path.join(base, 'imagem-backup-restauracao-lancador.service.js'), 'utf8');
    assert.equal(/shell:\s*true|\bexec(?:Sync)?\(|execFile/.test(lan), false);
    const codigo = lan.split('\n').filter((l) => !l.trimStart().startsWith('*')).join('\n');
    assert.equal((codigo.match(/require\('node:child_process'\)/g) ?? []).length, 1, 'o child_process só é carregado dentro da fábrica real');
    assert.match(lan, /function criarLancadorDeRestauracaoReal[\s\S]*require\('node:child_process'\)/);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- V1 x V2
describe('[V2-V1] compatibilidade e downgrade', () => {
  teste('V2-V101 — pacote V1 continua legível no modo LEGADO (sem chave) e diz que NÃO é autenticado; nada do formato V1 mudou', async () => {
    const p = await construirPacotePublicado();
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    assert.equal(r.ok, true);
    assert.deepEqual({ ...r.autenticacao }, { versao: 1, autenticado: false });
    assert.deepEqual(Object.keys(r.manifesto).sort(), ['arquivos', 'banco', 'conjuntoId', 'dump', 'versao']);
  });

  teste('V2-V102 — pacote V1 apresentado como V2 (com fonte de chaves) é recusado como downgrade: MANIFESTO_NAO_AUTENTICADO, também pela restauração', async () => {
    const p = await construirPacotePublicado();
    const f = criarFonteFicticia();
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: f.fonteDeChaves });
    assert.deepEqual([r.ok, r.motivo], [false, 'MANIFESTO_NAO_AUTENTICADO']);
    const destino = novaRaiz();
    const rest = await criarRestaurador({ fonteDeChaves: f.fonteDeChaves }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: destino, nome: 'img' } });
    assert.deepEqual([rest.ok, rest.motivo], [false, 'MANIFESTO_NAO_AUTENTICADO']);
    assert.equal(fs.existsSync(path.join(destino, 'img')), false, 'nada foi restaurado');
    assert.equal(rest.aptidaoOperacional.apta, false);
  });

  teste('V2-V103 — a restauração LEGADA de pacote V1 nunca é apta à operação real (manifesto não autenticado)', async () => {
    const p = await construirPacotePublicado();
    const rest = await criarRestaurador().restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' } });
    assert.equal(rest.ok, true);
    assert.equal(rest.aptidaoOperacional.apta, false);
    assert.ok(rest.aptidaoOperacional.motivos.includes('MANIFESTO_NAO_AUTENTICADO'));
    assert.deepEqual([rest.restauracaoReal, rest.recuperavel, rest.consistenciaLogica.verificada], [false, false, false]);
    assert.ok(rest.limites.includes('SEM_AUTENTICACAO_DO_MANIFESTO'));
  });

  teste('V2-V104 — pacote V2 lido no modo LEGADO (sem chave) é recusado; não há leitura não autenticada de V2', async () => {
    const p = await pacoteV2();
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'SELAGEM_INVALIDA');
  });

  teste('V2-V105 — um V1 reescrito para parecer V2 (versao 2, sem autenticação) com selo coerente é recusado', async () => {
    const p = await construirPacotePublicado();
    reescrever(p, (m) => { m.versao = 2; m.layout = 1; m.dump.arquivo = 'dump/postgres.dump'; });
    const f = criarFonteFicticia();
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, fonteDeChaves: f.fonteDeChaves });
    assert.deepEqual([r.ok, r.motivo], [false, 'AUTENTICACAO_AUSENTE']);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- restauração, banco e consistência
function executorSimulado(modo = 'ok') {
  const chamadas = [];
  const lancador = {
    lancar(spec) {
      chamadas.push(spec);
      const termino = modo === 'saida1' ? { codigo: 1, sinal: null } : { codigo: 0, sinal: null };
      return { pid: 7001, saida: Promise.resolve(termino), fluxosFechados: Promise.resolve() };
    },
  };
  const restaurador = criarRestauradorDoBanco({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador,
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    politicaDeDestino: POLITICA,
  });
  return { chamadas, restaurador };
}

/** As MESMAS linhas que o helper grava no banco fictício do snapshot. */
function registrosDoBanco() {
  const pm = Buffer.from('padrao-mestre-conteudo');
  const pn = Buffer.from('padrao-miniatura-conteudo');
  const em = Buffer.from('empresa7-mestre');
  const ee = Buffer.from('empresa7-exibicao');
  const en = Buffer.from('empresa7-miniatura');
  return {
    padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }],
    empresa: [{ id: '2', empresaId: 7, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(em), sha256Exibicao: sha(ee), sha256Miniatura: sha(en), bytesMestre: em.length, bytesExibicao: ee.length, bytesMiniatura: en.length }],
  };
}
function consultaSimulada(ajusta = (r) => r) {
  const chamadas = [];
  return {
    chamadas,
    async consultar(contexto) {
      chamadas.push(contexto);
      return ajusta({ ok: true, completa: true, banco: contexto.banco, conjuntoId: contexto.conjuntoId, sha256Manifesto: contexto.sha256Manifesto, registros: registrosDoBanco() });
    },
  };
}
async function restaurarComConsulta(p, consulta, { fonte = true, executor = executorSimulado('ok') } = {}) {
  const rest = criarRestaurador({ restauradorDoBanco: executor.restaurador, consultaDeReferencias: consulta, ...(fonte ? { fonteDeChaves: p.fonteDeChaves } : {}) });
  const r = await rest.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO_BANCO } });
  return { r, executor };
}

describe('[V2-D] restauração simulada do banco e consistência lógica contratual', () => {
  teste('V2-D01 — INTEGRAÇÃO C -> D completa e fictícia: pacote V2 publicado, aberto, imagens restauradas, banco restaurado por executor simulado e consistência contratual satisfeita; NUNCA real nem recuperável nem apta', async () => {
    const p = await pacoteV2();
    assert.deepEqual(planejarArquivos(registrosDoBanco()).map((i) => i.chave), (await abrirV2(p)).manifesto.arquivos.map((a) => a.chave), 'sanidade: o banco fictício espelha o plano do backup');
    const consulta = consultaSimulada();
    const { r, executor } = await restaurarComConsulta(p, consulta);
    assert.equal(r.ok, true, `motivo: ${r.motivo}`);
    assert.equal(executor.chamadas.length, 1);
    assert.equal(consulta.chamadas.length, 1);
    assert.deepEqual(Object.keys(consulta.chamadas[0]).sort(), ['banco', 'conjuntoId', 'sha256Manifesto']);
    assert.equal(r.autenticacao.autenticado, true);
    assert.equal(r.consistenciaLogica.contratual, true);
    assert.equal(r.consistenciaLogica.verificada, false, 'sem banco restaurado de verdade a consistência não é "verificada"');
    assert.equal(r.consistenciaLogica.referencias, 5);
    assert.deepEqual([r.restauracaoReal, r.recuperavel, r.aptidaoOperacional.apta], [false, false, false]);
    assert.ok(r.aptidaoOperacional.motivos.includes('CHAVE_DE_TESTE'));
    assert.ok(r.aptidaoOperacional.motivos.includes('SEM_PRODUTOR_OPERACIONAL'));
    assert.ok(r.limites.includes('CHAVE_DE_TESTE_NAO_OPERACIONAL'));
    assert.equal(JSON.stringify(r).includes(p.segredo.toString('hex')), false);
  });

  const falhas = [
    ['referência SEM imagem', (res) => { res.registros.padrao.push({ id: '9', sha256: H('9'), sha256Miniatura: H('8'), sha256Exibicao: null, formato: 'PNG', bytesMestre: 5, bytesMiniatura: 5, bytesExibicao: null }); return res; }, 'REFERENCIA_SEM_IMAGEM'],
    ['imagem DIVERGENTE da referência', (res) => { res.registros.padrao[0].sha256Miniatura = H('7'); return res; }, 'IMAGEM_DIVERGENTE_DA_REFERENCIA'],
    ['imagem sem referência', (res) => { res.registros.empresa = []; return res; }, 'IMAGEM_SEM_REFERENCIA'],
    ['consulta INCOMPLETA', (res) => ({ ...res, completa: false }), 'CONSULTA_DE_REFERENCIAS_INCOMPLETA'],
    ['consulta com ok:false', (res) => ({ ok: false }), 'CONSULTA_DE_REFERENCIAS_FALHOU'],
    ['resultado de OUTRO banco', (res) => ({ ...res, banco: 'gepi_restauracao_outro' }), 'CONSULTA_DE_OUTRA_OPERACAO'],
    ['resultado de OUTRO conjunto', (res) => ({ ...res, conjuntoId: 'conjunto-alheio' }), 'CONSULTA_DE_OUTRA_OPERACAO'],
    ['resultado de OUTRO manifesto', (res) => ({ ...res, sha256Manifesto: H('d') }), 'CONSULTA_DE_OUTRA_OPERACAO'],
    ['registros em formato inválido', (res) => ({ ...res, registros: { padrao: 'x', empresa: [] } }), 'CONSULTA_DE_REFERENCIAS_INVALIDA'],
    ['sem registros', (res) => ({ ...res, registros: undefined }), 'CONSULTA_DE_REFERENCIAS_INVALIDA'],
  ];
  for (const [rotulo, ajusta, motivo] of falhas) {
    teste(`V2-D02 (${rotulo}) — falha fechada com ${motivo}; consistência não é contratual e nada é declarado real`, async () => {
      const p = await pacoteV2();
      const { r } = await restaurarComConsulta(p, consultaSimulada(ajusta));
      assert.equal(r.ok, false);
      assert.equal(r.motivo, motivo);
      assert.equal(r.consistenciaLogica.contratual, false);
      assert.equal(r.consistenciaLogica.verificada, false);
      assert.deepEqual([r.restauracaoReal, r.recuperavel], [false, false]);
    });
  }

  teste('V2-D03 — a consulta que LANÇA (com segredo na mensagem) falha fechada sem vazar; consulta não configurada mantém o resultado padrão NAO_VERIFICADA', async () => {
    const p = await pacoteV2();
    const lanca = { async consultar() { throw new Error(`SEGREDO ${p.segredo.toString('hex')} /Users/privado`); } };
    const { r } = await restaurarComConsulta(p, lanca);
    assert.deepEqual([r.ok, r.motivo], [false, 'CONSULTA_DE_REFERENCIAS_FALHOU']);
    assert.equal(JSON.stringify(r).includes(p.segredo.toString('hex')), false);
    const semConsulta = criarRestaurador({ fonteDeChaves: p.fonteDeChaves, restauradorDoBanco: executorSimulado('ok').restaurador });
    const s = await semConsulta.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO_BANCO } });
    assert.equal(s.ok, true);
    assert.deepEqual({ ...s.consistenciaLogica }, { verificada: false, motivo: 'NAO_VERIFICADA' });
  });

  teste('V2-D04 — se a restauração do banco falha, a consulta NÃO é feita; sem banco solicitado, também não', async () => {
    const p = await pacoteV2();
    const consulta = consultaSimulada();
    const { r } = await restaurarComConsulta(p, consulta, { executor: executorSimulado('saida1') });
    assert.equal(r.ok, false);
    assert.equal(consulta.chamadas.length, 0);
    const rest = criarRestaurador({ fonteDeChaves: p.fonteDeChaves, consultaDeReferencias: consulta });
    const s = await rest.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img2' } });
    assert.equal(s.ok, true);
    assert.equal(consulta.chamadas.length, 0);
  });

  teste('V2-D05 — pacote V2 adulterado nunca chega ao executor nem à consulta; banco de destino não autorizado também não', async () => {
    const p = await pacoteV2();
    reescrever(p, (m) => { m.conjuntoId = 'forjado'; });
    const consulta = consultaSimulada();
    const { r, executor } = await restaurarComConsulta(p, consulta);
    assert.deepEqual([r.ok, r.motivo], [false, 'AUTENTICACAO_INVALIDA']);
    assert.deepEqual([executor.chamadas.length, consulta.chamadas.length], [0, 0]);

    const q = await pacoteV2();
    const c2 = consultaSimulada();
    const e2 = executorSimulado('ok');
    const rest = criarRestaurador({ fonteDeChaves: q.fonteDeChaves, restauradorDoBanco: e2.restaurador, consultaDeReferencias: c2 });
    const out = await rest.restaurarPacote({ raizAutorizada: q.publicados, nome: q.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: { ...DESTINO_BANCO, banco: 'gestao_epi' } } });
    assert.deepEqual([out.ok, out.motivo], [false, 'DESTINO_NAO_AUTORIZADO']);
    assert.deepEqual([e2.chamadas.length, c2.chamadas.length], [0, 0]);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- lançador de restauração
function spawnFalso({ lanca = false, eventos = 'spawn' } = {}) {
  const chamadas = [];
  const spawn = (exe, args, opcoes) => {
    chamadas.push({ exe, args, opcoes });
    if (lanca) throw Object.assign(new Error('boom /Users/privado'), { code: 'EACCES' });
    const filho = new EventEmitter();
    filho.pid = eventos === 'sem-pid' ? undefined : 8123;
    if (eventos === 'spawn') setImmediate(() => filho.emit('spawn'));
    if (eventos === 'erro-sem-pid') { filho.pid = undefined; setImmediate(() => filho.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); }
    return filho;
  };
  return { chamadas, spawn };
}
const specValido = (extra = {}) => ({
  executavel: '/usr/bin/pg_restore',
  argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_temp1'],
  ambiente: { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'gepi_restore' },
  opcoes: { shell: false, detached: true, stdio: [9, 'ignore', 'ignore'] },
  ...extra,
});
const criarLancador = (falso) => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: POLITICA });

describe('[V2-L] lançador do pg_restore (NENHUM processo real)', () => {
  teste('V2-L01 — construção estrita e sem efeito: não chama spawn; exige spawn e política; rejeita chaves extras', () => {
    const falso = spawnFalso();
    criarLancador(falso);
    assert.equal(falso.chamadas.length, 0);
    assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn }), TypeError);
    assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: 1, politicaDeDestino: POLITICA }), TypeError);
    assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: POLITICA, extra: 1 }), TypeError);
    assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: { ...POLITICA, prefixoDoBanco: 'x_' } }), TypeError);
    assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: { ...POLITICA, hostsAutorizados: 'todos' } }), TypeError);
    assert.throws(() => criarLancadorDeRestauracaoReal({}), TypeError);
    assert.equal(typeof criarLancadorDeRestauracaoReal({ politicaDeDestino: POLITICA }).lancar, 'function', 'construir o lançador real não lança processo');
  });

  teste('V2-L02 — spec válido: UM spawn com argumentos e ambiente REMONTADOS, shell:false, ambiente mínimo (sem herdar PATH nem senha), stdout/stderr ignorados; resolve com pid, saída e fluxos separados', async () => {
    process.env.PGPASSWORD = 'nao-deve-vazar-no-teste';
    try {
      const falso = spawnFalso();
      const l = criarLancador(falso);
      const proc = await l.lancar(specValido());
      assert.equal(falso.chamadas.length, 1);
      const { exe, args, opcoes } = falso.chamadas[0];
      assert.equal(exe, '/usr/bin/pg_restore');
      assert.deepEqual(args, ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_temp1']);
      assert.deepEqual(opcoes.env, { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'gepi_restore' });
      assert.deepEqual([opcoes.shell, opcoes.detached, opcoes.stdio], [false, true, [9, 'ignore', 'ignore']]);
      assert.equal(JSON.stringify(opcoes).includes('nao-deve-vazar'), false);
      assert.equal(proc.pid, 8123);
      assert.equal(typeof proc.saida.then, 'function');
      assert.equal(typeof proc.fluxosFechados.then, 'function');
      assert.equal(l.situacao()[0].estado, 'INICIADO');
    } finally {
      delete process.env.PGPASSWORD;
    }
  });

  const invalidos = [
    ['argumento extra (--clean)', specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--clean', '--dbname=gepi_restauracao_temp1'] })],
    ['argumento faltando', specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname=gepi_restauracao_temp1'] })],
    ['ordem trocada', specValido({ argumentos: ['--no-owner', '--exit-on-error', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_temp1'] })],
    ['-d em vez de --dbname', specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '-dgepi_restauracao_temp1'] })],
    ['--create', specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--create'] })],
    ['dbname com injeção', specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_x;drop'] })],
    ['PGPASSWORD no ambiente', specValido({ ambiente: { PGPASSFILE: '/tmp/s', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'u', PGPASSWORD: 'x' } })],
    ['PGDATABASE no ambiente', specValido({ ambiente: { PGPASSFILE: '/tmp/s', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'u', PGDATABASE: 'gestao_epi' } })],
    ['ambiente incompleto', specValido({ ambiente: { PGPASSFILE: '/tmp/s', PGHOST: '127.0.0.1', PGPORT: '5432' } })],
    ['porta fora do limite', specValido({ ambiente: { PGPASSFILE: '/tmp/s', PGHOST: '127.0.0.1', PGPORT: '70000', PGUSER: 'u' } })],
    ['arquivo de senha relativo', specValido({ ambiente: { PGPASSFILE: 'senha', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'u' } })],
    ['executável relativo', specValido({ executavel: 'pg_restore' })],
    ['executável com outro nome', specValido({ executavel: '/usr/bin/psql' })],
    ['shell:true', specValido({ opcoes: { shell: true, detached: true, stdio: [9, 'ignore', 'ignore'] } })],
    ['detached:false', specValido({ opcoes: { shell: false, detached: false, stdio: [9, 'ignore', 'ignore'] } })],
    ['stdout capturado', specValido({ opcoes: { shell: false, detached: true, stdio: [9, 'pipe', 'ignore'] } })],
    ['entrada padrão herdada (0)', specValido({ opcoes: { shell: false, detached: true, stdio: [0, 'ignore', 'ignore'] } })],
    ['opção extra', specValido({ opcoes: { shell: false, detached: true, stdio: [9, 'ignore', 'ignore'], cwd: '/' } })],
    ['chave extra no spec', specValido({ env: { PATH: '/bin' } })],
    ['spec ausente', undefined],
  ];
  for (const [rotulo, spec] of invalidos) {
    teste(`V2-L03 (${rotulo}) — SPEC_INVALIDO sem nenhum spawn`, async () => {
      const falso = spawnFalso();
      const l = criarLancador(falso);
      await assert.rejects(() => l.lancar(spec), (e) => e.code === 'SPEC_INVALIDO');
      assert.equal(falso.chamadas.length, 0);
    });
  }

  teste('V2-L04 — POLÍTICA DE DESTINO imposta pelo lançador: produção, protegido, prefixo errado, só o prefixo e host não autorizado são recusados sem spawn', async () => {
    const casos = [
      ['gestao_epi', '127.0.0.1'],
      ['gestao_epi_producao', '127.0.0.1'],
      ['meu_banco', '127.0.0.1'],
      ['gepi_restauracao_', '127.0.0.1'],
      ['gepi_restauracao_x', '10.0.0.5'],
    ];
    for (const [banco, host] of casos) {
      const falso = spawnFalso();
      const l = criarLancador(falso);
      await assert.rejects(() => l.lancar(specValido({
        argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${banco}`],
        ambiente: { PGPASSFILE: '/tmp/s', PGHOST: host, PGPORT: '5432', PGUSER: 'u' },
      })), (e) => ['DESTINO_NAO_AUTORIZADO', 'SPEC_INVALIDO'].includes(e.code), `${banco}@${host}`);
      assert.equal(falso.chamadas.length, 0);
    }
  });

  teste('V2-L05 — a política é imutável: alterar as listas do chamador depois da construção não amplia o destino', async () => {
    const hosts = ['127.0.0.1'];
    const protegidos = ['gestao_epi'];
    const falso = spawnFalso();
    const l = criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: { prefixoDoBanco: 'gepi_restauracao_', hostsAutorizados: hosts, bancosProtegidos: protegidos } });
    hosts.push('10.0.0.5');
    protegidos.length = 0;
    await assert.rejects(() => l.lancar(specValido({ ambiente: { PGPASSFILE: '/tmp/s', PGHOST: '10.0.0.5', PGPORT: '5432', PGUSER: 'u' } })), (e) => e.code === 'DESTINO_NAO_AUTORIZADO');
    await assert.rejects(() => l.lancar(specValido({ argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gestao_epi'] })), (e) => ['DESTINO_NAO_AUTORIZADO', 'SPEC_INVALIDO'].includes(e.code));
    assert.equal(falso.chamadas.length, 0);
  });

  teste('V2-L06 — spec com leitura que lança (getter hostil) é inválido, não executa e não vaza', async () => {
    const falso = spawnFalso();
    const l = criarLancador(falso);
    const hostil = specValido();
    Object.defineProperty(hostil, 'executavel', { enumerable: true, get() { throw new Error('SEGREDO'); } });
    await assert.rejects(() => l.lancar(hostil), (e) => e.code === 'SPEC_INVALIDO' && !String(e.message).includes('SEGREDO'));
    assert.equal(falso.chamadas.length, 0);
  });

  teste('V2-L07 — falhas do spawn: exceção síncrona = NAO_INICIADO (causa segura); erro sem pid = NAO_INICIADO; sem pid = INICIO_INCONCLUSIVO; mensagens fixas sem eco', async () => {
    const a = spawnFalso({ lanca: true });
    const la = criarLancador(a);
    await assert.rejects(() => la.lancar(specValido()), (e) => e.code === 'NAO_INICIADO' && !String(e.message).includes('privado'));
    assert.equal(la.situacao()[0].estado, 'NAO_INICIADO');
    assert.equal(la.situacao()[0].causa, 'EACCES');
    const b = spawnFalso({ eventos: 'erro-sem-pid' });
    await assert.rejects(() => criarLancador(b).lancar(specValido()), (e) => e.code === 'NAO_INICIADO');
    const c = spawnFalso({ eventos: 'sem-pid' });
    const spawnSemPid = (...a2) => { const f = c.spawn(...a2); setImmediate(() => f.emit('spawn')); return f; };
    await assert.rejects(() => criarLancadorDeRestauracaoComSpawn({ spawn: spawnSemPid, politicaDeDestino: POLITICA }).lancar(specValido()), (e) => e.code === 'INICIO_INCONCLUSIVO');
  });

  teste('V2-L08 — término e fluxos são promessas SEPARADAS: exit(0) resolve a saída, sinal é registrado, close fecha os fluxos; exit inválido rejeita', async () => {
    let filhoCriado;
    const spawn = () => { filhoCriado = new EventEmitter(); filhoCriado.pid = 8200; setImmediate(() => filhoCriado.emit('spawn')); return filhoCriado; };
    const l = criarLancadorDeRestauracaoComSpawn({ spawn, politicaDeDestino: POLITICA });
    const proc = await l.lancar(specValido());
    let fluxosFechados = false;
    proc.fluxosFechados.then(() => { fluxosFechados = true; });
    filhoCriado.emit('exit', 0, null);
    assert.deepEqual({ ...(await proc.saida) }, { codigo: 0, sinal: null });
    await new Promise((r) => setImmediate(r));
    assert.equal(fluxosFechados, false, 'o exit não prova o fechamento dos fluxos');
    filhoCriado.emit('close', 0, null);
    await proc.fluxosFechados;
    assert.equal(l.situacao()[0].fluxosFechados, true);

    const spawn2 = () => { const f = new EventEmitter(); f.pid = 8201; setImmediate(() => { f.emit('spawn'); f.emit('exit', null, null); }); return f; };
    const proc2 = await criarLancadorDeRestauracaoComSpawn({ spawn: spawn2, politicaDeDestino: POLITICA }).lancar(specValido());
    await assert.rejects(() => proc2.saida, (e) => e.code === 'TERMINO_INVALIDO');
  });

  teste('V2-L09 — integrado ao restaurador do banco: caminho positivo SIMULADO fecha ok sem restauração real; política divergente do lançador falha fechada', async () => {
    const p = await pacoteV2();
    const falso = spawnFalso();
    let filho;
    const spawn = (...a) => { filho = falso.spawn(...a); setImmediate(() => filho.emit('exit', 0, null)); setImmediate(() => filho.emit('close', 0, null)); return filho; };
    const restauradorDoBanco = (lanc) => criarRestauradorDoBanco({
      alvo: { executavel: '/usr/bin/pg_restore' },
      lancador: lanc,
      sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
      prazos: { ...PRAZOS },
      politicaDeDestino: POLITICA,
    });
    const rest = (lanc) => criarRestaurador({ fonteDeChaves: p.fonteDeChaves, restauradorDoBanco: restauradorDoBanco(lanc) });
    const ok = await rest(criarLancadorDeRestauracaoComSpawn({ spawn, politicaDeDestino: POLITICA })).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO_BANCO } });
    assert.equal(ok.ok, true, `motivo: ${ok.motivo}`);
    assert.equal(falso.chamadas.length, 1);
    assert.deepEqual([ok.restauracaoReal, ok.recuperavel, ok.etapas.banco.restauracaoReal], [false, false, false]);

    const estrito = { ...POLITICA, hostsAutorizados: ['127.0.0.2'] };
    const falso2 = spawnFalso();
    const bloqueado = await rest(criarLancadorDeRestauracaoComSpawn({ spawn: falso2.spawn, politicaDeDestino: estrito })).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: { raiz: novaRaiz(), nome: 'img' }, banco: { destino: DESTINO_BANCO } });
    assert.equal(bloqueado.ok, false);
    assert.equal(falso2.chamadas.length, 0);
  });
});
