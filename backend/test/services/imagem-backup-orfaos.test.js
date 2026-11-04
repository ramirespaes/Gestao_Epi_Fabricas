'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identificarOrfaos, executarLimpeza, criarFixtureDescartavel, LIMPEZA_OPERACIONAL_HABILITADA } = require('../../src/services/imagem-backup-orfaos.service');

/**
 * Órfãos de artefatos de backup: SOMENTE em fixtures descartáveis criadas pelos testes (`<tmp>/gepi-orf-fixture-*`). Nenhum diretório real, nenhum resíduo gh-*, nenhum relatório de homologação é lido ou removido.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const uid = process.getuid();
const DIA = 86400000;
const TMP = fs.realpathSync(os.tmpdir());
/**
 * TEARDOWN POR CONTROLE EXPLÍCITO: só remove os caminhos que ESTE arquivo registrou ao criá-los, e só se, na hora de remover, o caminho ainda for o MESMO diretório (dev/ino), não for link, for do usuário do processo e estiver direto em tmp.
 * O prefixo do nome não é prova de propriedade e nenhuma varredura ou glob é feita: um diretório de nome parecido que o teste não criou, ou um impostor no mesmo caminho, nunca é removido.
 */
const criadas = [];
const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = fs.constants;
/** Identidade por DESCRITOR aberto: enquanto ele vive, o inode não pode ser reutilizado (no Linux um diretório recriado herdaria o mesmo número). */
function identidade(caminho) {
  const fd = fs.openSync(caminho, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  const st = fs.fstatSync(fd);
  return { caminho, dev: st.dev, ino: st.ino, fd };
}
function registrarCriada(caminho) {
  criadas.push(identidade(caminho));
  return caminho;
}
/** Só fecha o descritor se ele ainda é o objeto registrado; um descritor já fechado (número possivelmente reaproveitado) nunca é fechado de novo. */
function fecharSeProprio(entrada) {
  let pd;
  try { pd = fs.fstatSync(entrada.fd); } catch { return false; }
  if (pd.dev !== entrada.dev || pd.ino !== entrada.ino) return false;
  fs.closeSync(entrada.fd);
  return true;
}
function removerCriadas(lista) {
  const removidas = [];
  for (const entrada of lista) {
    const { caminho, dev, ino, fd } = entrada;
    let pd;
    try { pd = fs.fstatSync(fd); } catch { continue; }
    if (!pd.isDirectory() || pd.dev !== dev || pd.ino !== ino) continue;
    let st;
    try { st = fs.lstatSync(caminho); } catch { fecharSeProprio(entrada); continue; }
    if (path.dirname(caminho) !== TMP || st.isSymbolicLink() || !st.isDirectory() || st.dev !== dev || st.ino !== ino || st.uid !== uid) { fecharSeProprio(entrada); continue; }
    fs.rmSync(caminho, { recursive: true, force: true });
    fecharSeProprio(entrada);
    removidas.push(caminho);
  }
  return removidas;
}
after(() => { removerCriadas(criadas); });
const TMPNAME = '0123456789abcdef';

function fixture(prefixo = null) {
  if (prefixo === null) { const f = criarFixtureDescartavel(); registrarCriada(f.base); return { base: f.base, raizes: { ...f.raizes } }; }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(TMP, prefixo)));
  registrarCriada(base);
  const r = {};
  for (const nome of ['preparacoes', 'dumps', 'publicados']) { r[nome] = path.join(base, nome); fs.mkdirSync(r[nome], { mode: 0o700 }); }
  return { base, raizes: r };
}
const idade = (p, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(p, t, t); };
const dir = (p, ms = 0) => { fs.mkdirSync(p, { mode: 0o700 }); if (ms) idade(p, ms); };
const arq = (p, ms = 0) => { fs.writeFileSync(p, 'x', { mode: 0o600 }); if (ms) idade(p, ms); };
const op = (id, tipo, estado, ms, artefatos) => ({ id, tipo, estado, atualizadoEm: Date.now() - ms, artefatos });
const entrada = (f, operacoes, extra = {}) => ({ raizes: f.raizes, uidsAutorizados: [uid], operacoes, janelaAtiva: false, politica: { idadeMinimaMs: 3 * DIA, retencaoMs: 30 * DIA }, agora: Date.now(), ...extra });
const porNome = (plano) => Object.fromEntries(plano.itens.map((i) => [`${i.raiz}/${i.nome}`, `${i.acao}:${i.motivo}`]));
const existe = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const codigo = (fn, c) => assert.throws(fn, (e) => e.code === c, c);

/** Monta o cenário completo da matriz de classificação. */
function cenario() {
  const f = fixture();
  const { preparacoes: P, dumps: D, publicados: B } = f.raizes;
  dir(path.join(P, 'p-ativa'), 10 * DIA); arq(path.join(P, 'p-ativa', `x.${TMPNAME}.tmp`), 10 * DIA); idade(path.join(P, 'p-ativa'), 10 * DIA);
  dir(path.join(P, 'p-inter'), 0); arq(path.join(P, 'p-inter', `y.${TMPNAME}.tmp`), 10 * DIA); arq(path.join(P, 'p-inter', 'dump'), 10 * DIA); idade(path.join(P, 'p-inter'), 10 * DIA);
  dir(path.join(P, 'p-nova'), 3600000);
  dir(path.join(P, 'p-desconhecida'), 40 * DIA);
  arq(path.join(D, `solto.${TMPNAME}.tmp`), 40 * DIA);
  arq(path.join(D, 'd-conc'), 1 * DIA);
  dir(path.join(D, 'rest-1'), 10 * DIA);
  dir(path.join(D, 'rest-2'), 40 * DIA);
  dir(path.join(B, 'pub-ok'), 40 * DIA);
  dir(path.join(B, 'pub-sem'), 40 * DIA);
  fs.symlinkSync(path.join(f.base, 'preparacoes'), path.join(P, 'ln'));
  const operacoes = [
    op('o1', 'BACKUP', 'ATIVA', 10 * DIA, [{ raiz: 'preparacoes', nome: 'p-ativa' }]),
    op('o2', 'BACKUP', 'INTERROMPIDA', 10 * DIA, [{ raiz: 'preparacoes', nome: 'p-inter' }]),
    op('o3', 'BACKUP', 'INTERROMPIDA', 3600000, [{ raiz: 'preparacoes', nome: 'p-nova' }]),
    op('o4', 'BACKUP', 'CONCLUIDA', 1 * DIA, [{ raiz: 'dumps', nome: 'd-conc' }]),
    op('o5', 'RESTAURACAO', 'FALHA', 10 * DIA, [{ raiz: 'dumps', nome: 'rest-1' }]),
    op('o6', 'RESTAURACAO', 'CONCLUIDA', 40 * DIA, [{ raiz: 'dumps', nome: 'rest-2' }]),
    op('o7', 'BACKUP', 'CONCLUIDA', 40 * DIA, [{ raiz: 'publicados', nome: 'pub-ok' }]),
  ];
  return { f, operacoes };
}

describe('[OR-T] teardown das fixtures do próprio teste', () => {
  teste('OR-T01 — o teardown remove SÓ o que o teste registrou e que continua sendo o mesmo diretório: homônimo não criado pelo teste, impostor no caminho registrado, link e diretório de outro usuário (simulado por identidade) permanecem', () => {
    const meu = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'gepi-orf-t01-')));
    const homonimo = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'gepi-orf-t01-')));
    const impostor = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'gepi-orf-t01-')));
    const alvoDoLink = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'gepi-orf-t01-')));
    const ligacao = path.join(TMP, `gepi-orf-t01-ln-${process.pid}`);
    fs.symlinkSync(alvoDoLink, ligacao);
    const ident = identidade;
    const doHomonimo = ident(homonimo);
    const lista = [ident(meu), ident(impostor), { ...ident(alvoDoLink), caminho: ligacao }, { ...doHomonimo, ino: 1 }];
    // o "impostor" é trocado depois do registro (mesmo caminho, outro inode: o descritor aberto impede que o número seja reutilizado)
    fs.rmdirSync(impostor);
    fs.mkdirSync(impostor, { mode: 0o700 });
    try {
      const removidas = removerCriadas(lista);
      assert.deepEqual(removidas, [meu]);
      assert.equal(existe(meu), false);
      for (const ficou of [homonimo, impostor, alvoDoLink, ligacao]) assert.equal(existe(ficou), true, ficou);
      assert.equal(removerCriadas([ident(homonimo)]).length, 1, 'registrado corretamente, o mesmo homônimo seria removido: a identidade, e não o nome, decide');
      // a entrada de identidade falsa (ino: 1) não foi fechada pelo teardown; o descritor real ainda está aberto e é fechado UMA vez; a segunda tentativa não fecha nada
      assert.equal(fecharSeProprio(doHomonimo), true, 'descritor próprio ainda aberto é fechado uma única vez');
      assert.equal(fecharSeProprio(doHomonimo), false, 'descritor já fechado nunca é fechado em dobro');
    } finally {
      for (const p of [impostor, alvoDoLink]) fs.rmSync(p, { recursive: true, force: true });
      fs.unlinkSync(ligacao);
    }
  });
});

describe('[OR-A] identificação (simulação)', () => {
  teste('OR-A01 — matriz de classificação: só é CANDIDATO o que soma correlação, operação inativa, dono, idade e retenção; nome de temporário sozinho não basta', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes));
    const m = porNome(plano);
    assert.deepEqual(m, {
      'preparacoes/ln': 'PROTEGER:LINK_SIMBOLICO',
      'preparacoes/p-ativa': 'PROTEGER:OPERACAO_ATIVA',
      'preparacoes/p-ativa/x.0123456789abcdef.tmp': 'PROTEGER:OPERACAO_ATIVA',
      'preparacoes/p-desconhecida': 'PROTEGER:ORIGEM_DESCONHECIDA',
      'preparacoes/p-inter': 'CANDIDATO:OPERACAO_INTERROMPIDA_E_ANTIGA',
      'preparacoes/p-inter/y.0123456789abcdef.tmp': 'CANDIDATO:TEMPORARIO_CORRELACIONADO_E_ANTIGO',
      'preparacoes/p-nova': 'PROTEGER:IDADE_INSUFICIENTE',
      'dumps/d-conc': 'PROTEGER:RETENCAO_EM_CURSO',
      'dumps/rest-1': 'PROTEGER:RETENCAO_EM_CURSO',
      'dumps/rest-2': 'CANDIDATO:RETENCAO_CUMPRIDA',
      'dumps/solto.0123456789abcdef.tmp': 'PROTEGER:PARECE_TEMPORARIO_SEM_CORRELACAO',
      'publicados/pub-ok': 'PROTEGER:PACOTE_PUBLICADO_REFERENCIADO',
      'publicados/pub-sem': 'PROTEGER:ORIGEM_DESCONHECIDA',
    });
    assert.deepEqual({ ...plano.resumo }, { candidatos: 3, protegidos: 10, total: 13 });
    assert.equal(plano.modo, 'SIMULACAO');
    assert.ok(Object.isFrozen(plano) && Object.isFrozen(plano.itens[0]));
    assert.match(plano.id, /^[0-9a-f]{64}$/);
  });

  teste('OR-A02 — a simulação NÃO altera o sistema de arquivos e é determinística', () => {
    const { f, operacoes } = cenario();
    const lista = () => ['preparacoes', 'dumps', 'publicados'].flatMap((r) => fs.readdirSync(f.raizes[r]).map((n) => `${r}/${n}`)).sort();
    const antes = lista();
    const e = entrada(f, operacoes);
    const a = identificarOrfaos(e);
    const b = identificarOrfaos(e);
    assert.equal(a.id, b.id);
    assert.deepEqual(lista(), antes);
  });

  teste('OR-A03 — JANELA ATIVA protege tudo o que está correlacionado (nada vira candidato durante um backup)', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes, { janelaAtiva: true }));
    assert.equal(plano.resumo.candidatos, 0);
    assert.equal(porNome(plano)['preparacoes/p-inter'], 'PROTEGER:JANELA_ATIVA');
    assert.equal(porNome(plano)['dumps/rest-2'], 'PROTEGER:JANELA_ATIVA');
  });

  teste('OR-A04 — relógio inconsistente (operação ou arquivo no futuro) protege; item sem registro de operação nunca é candidato, por mais antigo que seja', () => {
    const { f, operacoes } = cenario();
    const futuro = operacoes.map((o) => (o.id === 'o2' ? { ...o, atualizadoEm: Date.now() + DIA } : o));
    assert.equal(porNome(identificarOrfaos(entrada(f, futuro)))['preparacoes/p-inter'], 'PROTEGER:RELOGIO_INCONSISTENTE');
    const semRegistro = identificarOrfaos(entrada(f, []));
    assert.equal(semRegistro.resumo.candidatos, 0);
    assert.ok(semRegistro.itens.every((i) => i.classe === 'DESCONHECIDO' || i.classe === 'INSEGURO'));
  });

  teste('OR-A05 — raiz não autorizada (dono fora da lista, escrita para grupo, link, inexistente) e entrada malformada são recusadas', () => {
    const { f, operacoes } = cenario();
    codigo(() => identificarOrfaos(entrada(f, operacoes, { uidsAutorizados: [uid + 100000] })), 'RAIZ_NAO_AUTORIZADA');
    fs.chmodSync(f.raizes.dumps, 0o770);
    codigo(() => identificarOrfaos(entrada(f, operacoes)), 'RAIZ_NAO_AUTORIZADA');
    fs.chmodSync(f.raizes.dumps, 0o700);
    const g = fixture();
    fs.rmdirSync(g.raizes.dumps);
    fs.symlinkSync(f.raizes.dumps, g.raizes.dumps);
    codigo(() => identificarOrfaos(entrada(g, [])), 'RAIZ_NAO_AUTORIZADA');
    const ruins = [null, {}, entrada(f, operacoes, { agora: -1 }), entrada(f, operacoes, { janelaAtiva: 'nao' }), entrada(f, operacoes, { politica: { idadeMinimaMs: 5, retencaoMs: 1 } }), entrada(f, [{ id: 'x' }]), entrada(f, [op('a', 'BACKUP', 'ATIVA', 0, [{ raiz: '../x', nome: 'n' }])]), { ...entrada(f, operacoes), extra: 1 }];
    for (const ruim of ruins) codigo(() => identificarOrfaos(ruim), 'CONFIGURACAO_INVALIDA');
  });
});

describe('[OR-B] remoção controlada (somente fixtures descartáveis)', () => {
  const executar = (f, operacoes, extra = {}) => {
    const registros = [];
    const e = () => entrada(f, operacoes, extra.entrada ?? {});
    const plano = identificarOrfaos(e());
    const r = executarLimpeza({ modo: extra.modo ?? 'FIXTURE_DESCARTAVEL', entrada: extra.reler ?? e, plano: extra.plano ?? plano, registrar: (d) => registros.push(d) });
    return { r, registros, plano };
  };

  teste('OR-B01 — a limpeza OPERACIONAL está desativada por constante e a SIMULAÇÃO nunca remove (mesmo com candidatos)', () => {
    assert.equal(LIMPEZA_OPERACIONAL_HABILITADA, false);
    const { f, operacoes } = cenario();
    const antes = fs.readdirSync(f.raizes.preparacoes).sort();
    for (const modo of ['OPERACIONAL', 'SIMULACAO']) {
      const { r } = executar(f, operacoes, { modo });
      assert.equal(r.executado, false);
      assert.equal(r.motivo, modo === 'OPERACIONAL' ? 'LIMPEZA_OPERACIONAL_DESATIVADA' : 'SIMULACAO');
    }
    assert.deepEqual(fs.readdirSync(f.raizes.preparacoes).sort(), antes);
  });

  teste('OR-B02 — FIXTURE_DESCARTAVEL remove SÓ os candidatos (arquivo e diretório por nome explícito) e registra cada decisão; todo o resto fica', () => {
    const { f, operacoes } = cenario();
    const { r, registros } = executar(f, operacoes);
    assert.deepEqual([r.executado, r.removidos], [true, 2]);
    const { preparacoes: P, dumps: D, publicados: B } = f.raizes;
    assert.equal(existe(path.join(P, 'p-inter')), false, 'o diretório interrompido saiu (com o temporário dentro)');
    assert.equal(existe(path.join(D, 'rest-2')), false);
    for (const ficou of [path.join(P, 'p-ativa'), path.join(P, 'p-ativa', `x.${TMPNAME}.tmp`), path.join(P, 'p-nova'), path.join(P, 'p-desconhecida'), path.join(P, 'ln'), path.join(D, 'd-conc'), path.join(D, 'rest-1'), path.join(D, `solto.${TMPNAME}.tmp`), path.join(B, 'pub-ok'), path.join(B, 'pub-sem')]) assert.equal(existe(ficou), true, ficou);
    assert.equal(registros.filter((d) => d.resultado === 'REMOVIDO').length, 2);
    assert.ok(registros.some((d) => d.resultado === 'PULADO' && d.motivo === 'JA_REMOVIDO'), 'o temporário dentro do diretório já removido');
    assert.equal(JSON.stringify(registros).includes(f.base), false, 'o registro não leva caminho');
    assert.equal(existe(path.join(f.base, '.limpeza.lock')), false, 'a trava foi liberada');
  });

  teste('OR-B03 — só roda em fixture: raízes fora de `gepi-orf-fixture-*` direto em tmp são recusadas (nada removido); fora de NODE_ENV=test a modalidade é recusada', () => {
    const { f, operacoes } = cenario();
    const outra = fixture('gepi-orf-outro-');
    const op2 = [op('o2', 'BACKUP', 'INTERROMPIDA', 10 * DIA, [{ raiz: 'preparacoes', nome: 'p-inter' }])];
    dir(path.join(outra.raizes.preparacoes, 'p-inter'), 10 * DIA);
    codigo(() => executar(outra, op2), 'RAIZ_NAO_E_FIXTURE_DESCARTAVEL');
    assert.equal(existe(path.join(outra.raizes.preparacoes, 'p-inter')), true);
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      codigo(() => executar(f, operacoes), 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), true);
  });

  teste('OR-B04 — FALSO POSITIVO por mudança: a operação voltou a ficar ATIVA depois do plano => o item é PULADO e permanece', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes));
    const agoraAtiva = operacoes.map((o) => (o.id === 'o2' ? { ...o, estado: 'ATIVA', atualizadoEm: Date.now() } : o));
    const registros = [];
    const r = executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(f, agoraAtiva), plano, registrar: (d) => registros.push(d) });
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), true);
    assert.equal(existe(path.join(f.raizes.dumps, 'rest-2')), false, 'o outro candidato continua válido');
    assert.ok(registros.some((d) => d.nome === 'p-inter' && d.resultado === 'PULADO' && d.motivo === 'MUDOU_DESDE_O_PLANO'));
    assert.equal(r.removidos, 1);
  });

  teste('OR-B05 — janela que ficou ATIVA depois do plano bloqueia toda a remoção', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes));
    const r = executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(f, operacoes, { janelaAtiva: true }), plano });
    assert.equal(r.removidos, 0);
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), true);
    assert.equal(existe(path.join(f.raizes.dumps, 'rest-2')), true);
  });

  teste('OR-B06 — IDENTIDADE FÍSICA: diretório trocado por outro de mesmo nome depois do plano NÃO é removido', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes));
    const alvo = path.join(f.raizes.dumps, 'rest-2');
    fs.renameSync(alvo, `${alvo}-original`);
    dir(alvo, 40 * DIA);
    const r = executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(f, operacoes), plano });
    assert.equal(existe(alvo), true, 'o substituto permanece');
    assert.equal(existe(`${alvo}-original`), true, 'o original (agora sem nome correlacionado) também');
    assert.equal(r.removidos, 1);
  });

  teste('OR-B07 — LIMPEZA CONCORRENTE: com a trava presente a segunda é recusada, nada é removido e a trava alheia NÃO é apagada', () => {
    const { f, operacoes } = cenario();
    fs.mkdirSync(path.join(f.base, '.limpeza.lock'), { mode: 0o700 });
    const { r } = executar(f, operacoes);
    assert.deepEqual([r.executado, r.motivo, r.removidos], [false, 'LIMPEZA_CONCORRENTE', 0]);
    assert.equal(existe(path.join(f.base, '.limpeza.lock')), true);
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), true);
  });

  teste('OR-B08 — link simbólico NO INTERIOR de um candidato: a remoção aborta (FALHA), o alvo do link permanece e nada fora da fixture é tocado', () => {
    const { f, operacoes } = cenario();
    const fora = path.join(f.base, 'alvo-externo');
    arq(fora);
    fs.symlinkSync(fora, path.join(f.raizes.preparacoes, 'p-inter', 'zz-link'));
    idade(path.join(f.raizes.preparacoes, 'p-inter'), 10 * DIA);
    const { registros } = executar(f, operacoes);
    assert.equal(existe(fora), true);
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), true);
    assert.ok(registros.some((d) => d.nome === 'p-inter' && d.resultado === 'FALHA' && d.motivo === 'ITEM_INSEGURO_NO_INTERIOR'));
  });

  teste('OR-B10 — RAIZ FABRICADA não autoriza remoção: diretório à mão com o prefixo certo, com marcador COPIADO de uma fixture real, fixture substituída, marcador adulterado, raiz em outra fixture e raiz trocada por link — nada é removido em nenhum caso', () => {
    const tentar = (f, operacoes, quando) => {
      const plano = identificarOrfaos(entrada(f, operacoes));
      assert.ok(plano.resumo.candidatos >= 2, 'há candidatos reais a proteger');
      codigo(() => executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(f, operacoes), plano }), 'RAIZ_NAO_E_FIXTURE_DESCARTAVEL');
      return quando;
    };
    const intactos = (f) => [path.join(f.raizes.preparacoes, 'p-inter'), path.join(f.raizes.dumps, 'rest-2')].every(existe);
    const real = cenario();
    const token = fs.readFileSync(path.join(real.f.base, '.fixture-descartavel'), 'utf8');

    // 1) diretório fabricado: prefixo certo, dono certo, 0700, dentro de tmp e até com o token copiado do disco
    const forjada = fixture('gepi-orf-fixture-');
    for (const r of ['preparacoes', 'dumps']) dir(path.join(forjada.raizes[r], r === 'preparacoes' ? 'p-inter' : 'rest-2'), 40 * DIA);
    fs.writeFileSync(path.join(forjada.base, '.fixture-descartavel'), token, { mode: 0o600 });
    tentar(forjada, real.operacoes);
    assert.equal(intactos(forjada), true, 'fabricada');

    // 2) fixture REAL substituída por outra de mesmo caminho (dev/ino diferentes), com o token copiado
    const trocada = cenario();
    const tokenTrocada = fs.readFileSync(path.join(trocada.f.base, '.fixture-descartavel'), 'utf8');
    fs.renameSync(trocada.f.base, `${trocada.f.base}-original`);
    registrarCriada(`${trocada.f.base}-original`);
    for (const r of ['preparacoes', 'dumps', 'publicados']) fs.mkdirSync(path.join(trocada.f.base, r), { recursive: true, mode: 0o700 });
    registrarCriada(trocada.f.base); // o impostor também foi criado por este teste: o teardown o remove pela NOVA identidade
    dir(path.join(trocada.f.raizes.preparacoes, 'p-inter'), 40 * DIA);
    dir(path.join(trocada.f.raizes.dumps, 'rest-2'), 40 * DIA);
    fs.writeFileSync(path.join(trocada.f.base, '.fixture-descartavel'), tokenTrocada, { mode: 0o600 });
    tentar(trocada.f, trocada.operacoes);
    assert.equal(intactos(trocada.f), true, 'substituída');

    // 3) marcador adulterado numa fixture real
    const adulterada = cenario();
    fs.writeFileSync(path.join(adulterada.f.base, '.fixture-descartavel'), 'outro-token', { mode: 0o600 });
    tentar(adulterada.f, adulterada.operacoes);
    assert.equal(intactos(adulterada.f), true, 'marcador adulterado');

    // 4) raízes espalhadas por duas fixtures reais
    const a = cenario();
    const b = cenario();
    const mista = { base: a.f.base, raizes: { preparacoes: a.f.raizes.preparacoes, dumps: b.f.raizes.dumps, publicados: a.f.raizes.publicados } };
    const planoMista = identificarOrfaos(entrada(mista, a.operacoes));
    codigo(() => executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(mista, a.operacoes), plano: planoMista }), 'RAIZ_NAO_E_FIXTURE_DESCARTAVEL');
    assert.equal(existe(path.join(a.f.raizes.preparacoes, 'p-inter')), true);

    // 5) raiz da fixture real trocada por link para fora
    const ln = cenario();
    const plano = identificarOrfaos(entrada(ln.f, ln.operacoes));
    fs.renameSync(ln.f.raizes.dumps, `${ln.f.raizes.dumps}-x`);
    fs.symlinkSync(`${ln.f.raizes.dumps}-x`, ln.f.raizes.dumps);
    codigo(() => executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(ln.f, ln.operacoes), plano }), 'RAIZ_NAO_E_FIXTURE_DESCARTAVEL');
    assert.equal(existe(path.join(`${ln.f.raizes.dumps}-x`, 'rest-2')), true);
  });

  teste('OR-B11 — `criarFixtureDescartavel` só existe em NODE_ENV=test e entrega raízes 0700 sob tmp com marcador secreto', () => {
    const f = criarFixtureDescartavel();
    registrarCriada(f.base);
    assert.equal(path.dirname(f.base), TMP);
    assert.equal((fs.statSync(f.base).mode & 0o077), 0);
    assert.equal(fs.readFileSync(path.join(f.base, '.fixture-descartavel'), 'utf8').length, 32);
    assert.ok(Object.isFrozen(f) && Object.isFrozen(f.raizes));
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      codigo(() => criarFixtureDescartavel(), 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
  });

  teste('OR-B09 — plano ADULTERADO pelo chamador (item inventado, protegido promovido a candidato) não remove nada além do que o plano refeito confirma', () => {
    const { f, operacoes } = cenario();
    const plano = identificarOrfaos(entrada(f, operacoes));
    const forjado = { ...plano, itens: plano.itens.map((i) => (i.nome === 'p-desconhecida' || i.nome === 'pub-ok' || i.nome === 'p-ativa' ? { ...i, acao: 'CANDIDATO' } : i)) };
    const r = executarLimpeza({ modo: 'FIXTURE_DESCARTAVEL', entrada: () => entrada(f, operacoes), plano: forjado });
    for (const intacto of [path.join(f.raizes.preparacoes, 'p-desconhecida'), path.join(f.raizes.publicados, 'pub-ok'), path.join(f.raizes.preparacoes, 'p-ativa')]) assert.equal(existe(intacto), true, intacto);
    assert.equal(r.removidos, 2, 'só o interrompido e o de restauração, confirmados pelo plano refeito');
    assert.equal(existe(path.join(f.raizes.preparacoes, 'p-inter')), false);
  });
});
