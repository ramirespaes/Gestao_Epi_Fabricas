'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarBackupDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarEntradaOperacional } = require('../../src/services/imagem-backup-operacao.service');
const registroMod = require('../../src/services/imagem-backup-registro-publicacao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso, novaRaiz, PRAZOS, POLITICA, temporizadorInerte } = require('../helpers/ambiente-backup-operacao');

/**
 * QUARENTENA DURÁVEL DA PUBLICAÇÃO (D-ORF-6). Todas as provas verificam EFEITOS FÍSICOS em fixtures descartáveis: arquivos do registro, permissões, o pacote no destino, o arquivo da trava e o que um leitor INDEPENDENTE (restaurador novo e até um processo Node novo)
 * decide a partir do disco. Nenhum PostgreSQL, nenhum processo do banco, nenhuma AWS. Os "estados de queda" são fixtures construídos pelos próprios componentes (ou removendo, de um pacote real, exatamente o registro que a queda deixaria sem gravar).
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-qd-test-' });
after(() => { fix.remover(); });
const adiado = () => { let resolver; const promessa = new Promise((r) => { resolver = r; }); return { promessa, resolver }; };
const ate = async (condicao, rotulo = 'condição') => { const limite = Date.now() + 10000; while (Date.now() < limite) { if (condicao()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail(`não ocorreu: ${rotulo}`); };
const erroCom = (code) => Object.assign(new Error('SEGREDO-NUNCA-EXPOR'), { code });
function relogioManual() {
  const ativos = new Set();
  return {
    prazo(ms) { const p = { ms }; p.promessa = new Promise((r) => { p.resolver = r; }); ativos.add(p); return { promessa: p.promessa, cancelar() { ativos.delete(p); } }; },
    intervalo: () => Promise.resolve(),
    disparar(ms) { for (const p of [...ativos]) if (p.ms === ms) { ativos.delete(p); p.resolver(); } },
    registrado: (ms) => [...ativos].some((p) => p.ms === ms),
  };
}

const pubPath = require.resolve('../../src/services/imagem-backup-publicacao.service');
const encPath = require.resolve('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');
const prodPath = require.resolve('../../src/services/imagem-backup-composicao-producao.service');
/** Carrega a composição com `criarPublicador` trocado por uma fábrica de teste (só neste processo; tudo é restaurado ao fim). */
async function comPublicador(fabrica, fn) {
  require(pubPath);
  const original = require.cache[pubPath].exports;
  const salvos = { enc: require.cache[encPath], prod: require.cache[prodPath] };
  const marcados = new WeakSet();
  require.cache[pubPath].exports = { ...original, criarPublicador: (o) => { const f = fabrica(original, o); marcados.add(f); return f; }, ehPublicador: (v) => marcados.has(v) || original.ehPublicador(v) };
  delete require.cache[encPath];
  delete require.cache[prodPath];
  try { return await fn(require(prodPath)); } finally {
    require.cache[pubPath].exports = original;
    if (salvos.enc === undefined) delete require.cache[encPath]; else require.cache[encPath] = salvos.enc;
    if (salvos.prod === undefined) delete require.cache[prodPath]; else require.cache[prodPath] = salvos.prod;
  }
}
const fsyncReal = async (p) => { const h = await fsp.open(p, fs.constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); } };
const abrirReal = (p) => fsp.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
const registroFalhando = (...sufixos) => ({ abrirExclusivo: async (p) => { if (sufixos.some((s) => p.endsWith(s))) throw erroCom('EIO'); return abrirReal(p); } });
/** Publicação INCERTA: rename físico feito, fsync do destino falha e a reversão também. */
const opsIncerta = (opcoes) => {
  let renames = 0;
  return { rename: async (de, para) => { renames += 1; if (renames === 1) return fsp.rename(de, para); throw erroCom('EIO'); }, fsyncDiretorio: async (p) => { if (p === opcoes.raizDoDestino) throw erroCom('EIO'); return fsyncReal(p); } };
};

const executar = (producao, a, nome = 'prep-1') => producao.criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: nome, conjuntoId: `conjunto-qd-${nome}` });
const identidadeDe = (composto, nome = 'prep-1') => {
  const c = composto.resultado.correlacao;
  return { nome, conjuntoId: c.manifesto.conjuntoId, sha256Manifesto: c.manifesto.sha256Manifesto, dump: { bytes: c.dump.bytes, sha256: c.dump.sha256 } };
};
const dirRegistro = (a) => registroMod.diretorioDoRegistro(a.dirs.publicados);
const arquivosDoRegistro = (a) => (fs.existsSync(dirRegistro(a)) ? fs.readdirSync(dirRegistro(a)).sort() : []);
const lerDoDisco = (a, composto, nome = 'prep-1', comChaves = true) => registroMod.lerSituacao({ raiz: a.dirs.publicados, identidade: identidadeDe(composto, nome), ...(comChaves ? { fonteDeChaves: a.fonteDeChaves } : {}) });
/** Leitor INDEPENDENTE: restaurador novo, sem nenhum estado do processo que publicou. */
const leitor = (a, nome = 'prep-1', producao = true) => criarRestaurador({ fonteDeChaves: a.fonteDeChaves, ...(producao ? { exigirRegistroDePublicacao: true } : {}) })
  .restaurarPacote({ raizAutorizada: a.dirs.publicados, nome, imagens: { raiz: novaRaiz(), nome: 'img' } });
const travaNoDisco = (a) => fs.existsSync(path.join(a.raiz, 'janela.lock'));
const ETAPA = 7501;
const CORTESIA = 7502;

describe('[QD-A] publicação normal e estados de queda (leitura independente, a partir do disco)', () => {
  teste('QD-01 — PUBLICAÇÃO NORMAL: intenção (1) e conclusão no disco, 0600 em diretório 0700, sem segredo; a situação é ADMISSÍVEL e AUTENTICADA; o leitor de produção restaura; a trava é liberada', async () => {
    const a = await ambiente();
    const composto = await executar({ criarBackupDeProducao }, a);
    assert.equal(composto.resultado.publicacao.publicada, true);
    const arquivos = arquivosDoRegistro(a);
    assert.equal(arquivos.length, 2);
    assert.ok(arquivos.includes('prep-1.conclusao.json') && arquivos.some((n) => /^prep-1\.intencao\.[0-9a-f]{16}\.json$/.test(n)));
    assert.equal(fs.statSync(dirRegistro(a)).mode & 0o777, 0o700);
    for (const n of arquivos) assert.equal(fs.statSync(path.join(dirRegistro(a), n)).mode & 0o777, 0o600, n);
    const segredo = a.fonteDeChaves.obter('k-1').segredo;
    for (const n of arquivos) {
      const texto = fs.readFileSync(path.join(dirRegistro(a), n), 'utf8');
      assert.equal(texto.includes(segredo.toString('hex')) || texto.includes(segredo.toString('base64')), false, 'o segredo nunca é gravado');
      assert.match(texto, /"mac":"[0-9a-f]{64}"/);
    }
    const s = await lerDoDisco(a, composto);
    assert.deepEqual([s.estado, s.origem, s.autenticado], ['ADMISSIVEL', 'CONCLUSAO', true]);
    assert.equal((await leitor(a)).ok, true);
    assert.equal(travaNoDisco(a), false);
  });

  teste('QD-02 — INCERTA (rename físico feito, fsync e reversão falham): a QUARENTENA é gravada ANTES de a trava ser liberada; o pacote está no destino mas nenhum leitor o admite (produção e legado); um PROCESSO NODE NOVO lê o mesmo veredito do disco', async () => {
    const fabrica = (original, opcoes) => original.criarPublicador({ ...opcoes, ops: opsIncerta(opcoes) });
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.publicacao.estado, composto.resultado.publicacao.quarentena.registrada], ['INCERTA', true]);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1'], 'fisicamente presente');
      assert.ok(arquivosDoRegistro(a).includes('prep-1.quarentena.json'));
      assert.equal(arquivosDoRegistro(a).includes('prep-1.conclusao.json'), false);
      assert.equal(travaNoDisco(a), false, 'liberada só depois de a quarentena ser durável');
      for (const producaoModo of [true, false]) {
        const r = await leitor(a, 'prep-1', producaoModo);
        assert.deepEqual([r.ok, r.motivo], [false, 'PACOTE_EM_QUARENTENA'], `modo produção=${producaoModo}`);
      }
      const script = 'const { lerSituacao } = require(process.argv[1]); lerSituacao({ raiz: process.argv[3], identidade: JSON.parse(process.argv[2]) }).then((r) => { console.log(JSON.stringify(r)); });';
      const filho = spawnSync(process.execPath, ['-e', script, require.resolve('../../src/services/imagem-backup-registro-publicacao.service'), JSON.stringify(identidadeDe(composto)), a.dirs.publicados], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
      assert.equal(filho.status, 0, filho.stderr);
      assert.deepEqual([JSON.parse(filho.stdout).estado, JSON.parse(filho.stdout).motivo], ['EM_QUARENTENA', 'PUBLICACAO_INCERTA']);
    });
  });

  teste('QD-03 — falha ao registrar a QUARENTENA (INCERTA): a trava permanece RETIDA no disco (saída 11); e a AUSÊNCIA do marcador não é prova: sem conclusão, o leitor ainda recusa (PUBLICACAO_NAO_CONCLUIDA)', async () => {
    const fabrica = (original, opcoes) => original.criarPublicador({ ...opcoes, ops: opsIncerta(opcoes), registro: { ...opcoes.registro, ops: registroFalhando('.quarentena.json') } });
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.publicacao.estado, composto.resultado.publicacao.quarentena.registrada], ['INCERTA', false]);
      const c = composto.resultado.coordenador;
      assert.deepEqual([c.saida, c.janela, c.valido], [11, 'RETIDA', false]);
      assert.ok(c.motivos.includes('QUARENTENA_NAO_REGISTRADA') && c.motivos.includes('TRAVA_RETIDA_POR_SEGURANCA'));
      assert.equal(c.finalizacao, 'CONCLUIDA', 'os recursos são finalizados; só a trava é retida');
      assert.equal(travaNoDisco(a), true);
      assert.equal(arquivosDoRegistro(a).includes('prep-1.quarentena.json'), false);
      const r = await leitor(a);
      assert.deepEqual([r.ok, r.motivo], [false, 'PUBLICACAO_NAO_CONCLUIDA']);
      assert.equal((await lerDoDisco(a, composto)).estado, 'PUBLICACAO_NAO_CONCLUIDA');
    });
  });

  teste('QD-04 — falha ao registrar a CONCLUSÃO: publicação INCERTA (CONCLUSAO_NAO_REGISTRADA) com quarentena durável; se NEM a quarentena puder ser gravada, a trava fica RETIDA; em ambos os casos nenhum leitor admite', async () => {
    const so = (...sufixos) => (original, opcoes) => original.criarPublicador({ ...opcoes, registro: { ...opcoes.registro, ops: registroFalhando(...sufixos) } });
    await comPublicador(so('.conclusao.json'), async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.publicacao.estado, composto.resultado.publicacao.motivo, composto.resultado.publicacao.quarentena.registrada], ['INCERTA', 'CONCLUSAO_NAO_REGISTRADA', true]);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1']);
      assert.equal(travaNoDisco(a), false);
      assert.equal((await leitor(a)).motivo, 'PACOTE_EM_QUARENTENA');
    });
    await comPublicador(so('.conclusao.json', '.quarentena.json'), async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.equal(composto.resultado.publicacao.quarentena.registrada, false);
      assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela], [11, 'RETIDA']);
      assert.equal(travaNoDisco(a), true);
      assert.equal((await leitor(a)).motivo, 'PUBLICACAO_NAO_CONCLUIDA');
    });
  });

  teste('QD-05 — falha ao registrar a INTENÇÃO: NADA é publicado (destino sem pacote nem reserva), a preparação segue íntegra e o registro não ganha intenção; a trava é liberada pelo fluxo normal (nenhum efeito físico a proteger)', async () => {
    const fabrica = (original, opcoes) => original.criarPublicador({ ...opcoes, registro: { ...opcoes.registro, ops: registroFalhando('.json') } });
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.publicacao.publicada, composto.resultado.publicacao.motivo, composto.resultado.publicacao.registro], [false, 'INTENCAO_NAO_REGISTRADA', 'ABERTURA_FALHOU']);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), [], 'nenhum pacote e nenhuma reserva');
      assert.equal(fs.existsSync(path.join(a.dirs.preparacoes, 'prep-1', 'manifesto.json')), true);
      assert.deepEqual(arquivosDoRegistro(a), []);
      assert.equal(travaNoDisco(a), false);
    });
  });

  teste('QD-06 — QUEDA ANTES DA PUBLICAÇÃO (rename falha após a intenção) (intenção gravada, rename falha): o pacote NÃO está no destino e a intenção órfã sozinha não admite nada (PUBLICACAO_NAO_CONCLUIDA)', async () => {
    let falhar = true;
    const fabrica = (original, opcoes) => original.criarPublicador({ ...opcoes, ops: { rename: async (de, para) => { if (falhar) throw erroCom('EIO'); return fsp.rename(de, para); } } });
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const primeira = await executar(producao, a);
      assert.equal(primeira.resultado.publicacao.motivo, 'RENAME_FALHOU');
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), [], 'sem pacote no destino');
      assert.equal(arquivosDoRegistro(a).filter((n) => n.includes('.intencao.')).length, 1);
      const orfa = await lerDoDisco(a, primeira);
      assert.equal(orfa.estado, 'PUBLICACAO_NAO_CONCLUIDA');
      // (a nova tentativa pelo pipeline completo é coberta por MC-U12; aqui prova-se que a intenção órfã não admite nada)
      falhar = false;
    });
  });
});

describe('[QD-B] cancelamento durante a publicação (portão controlado dentro de `publicar`)', () => {
  async function comPortao(fabricaExtra) {
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
  const fabricaReal = (original, opcoes) => original.criarPublicador(opcoes);

  teste('QD-07 — cancelamento pedido DURANTE `publicar` e a publicação conclui dentro da cortesia: nenhuma CONCLUSÃO é gravada, a QUARENTENA (PUBLICADO_SOB_CANCELAMENTO) é durável e nenhum leitor admite o pacote, que está fisicamente no destino', async () => {
    await comPublicador(fabricaReal, async (producao) => {
      const m = await comPortao();
      const rodando = executar(producao, m.a);
      await ate(() => m.estado.entrou);
      m.relogio.disparar(ETAPA);
      await ate(() => m.relogio.registrado(CORTESIA));
      m.portao.resolver();
      const composto = await rodando;
      assert.deepEqual([composto.resultado.publicacao.publicada, composto.resultado.publicacao.quarentena.registrada], [true, true]);
      assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), ['prep-1']);
      const arquivos = arquivosDoRegistro(m.a);
      assert.ok(arquivos.includes('prep-1.quarentena.json'));
      assert.equal(arquivos.includes('prep-1.conclusao.json'), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dirRegistro(m.a), 'prep-1.quarentena.json'), 'utf8')).motivo, 'PUBLICADO_SOB_CANCELAMENTO');
      assert.equal((await leitor(m.a)).motivo, 'PACOTE_EM_QUARENTENA');
      assert.equal(composto.resultado.coordenador.valido, false);
    });
  });

  teste('QD-08 — a publicação NÃO assenta na cortesia (trava RETIDA) e conclui TARDE: ao concluir, o pedido de cancelamento já estava registrado, então a quarentena durável aparece depois; a trava segue retida e nenhum leitor admite o pacote publicado tardiamente', async () => {
    await comPublicador(fabricaReal, async (producao) => {
      const m = await comPortao();
      const rodando = executar(producao, m.a);
      await ate(() => m.estado.entrou);
      m.relogio.disparar(ETAPA);
      await ate(() => m.relogio.registrado(CORTESIA));
      m.relogio.disparar(CORTESIA);
      const composto = await rodando;
      assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela], [11, 'RETIDA']);
      assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), []);
      m.portao.resolver();
      await ate(() => fs.existsSync(path.join(dirRegistro(m.a), 'prep-1.quarentena.json')), 'quarentena tardia gravada');
      assert.deepEqual(fs.readdirSync(m.a.dirs.publicados), ['prep-1']);
      assert.equal(arquivosDoRegistro(m.a).includes('prep-1.conclusao.json'), false);
      assert.equal(travaNoDisco(m.a), true);
      assert.equal((await leitor(m.a)).motivo, 'PACOTE_EM_QUARENTENA');
    });
  });

  teste('QD-09 — EXCEÇÃO durante `publicar` (invólucro do publicador real que lança depois da publicação física): a quarentena é gravada pelo encadeamento; sem registro disponível a trava fica RETIDA; o leitor recusa nos dois casos', async () => {
    const lancando = (semRegistro) => (original, opcoes) => {
      const real = original.criarPublicador(opcoes);
      return Object.freeze({ servico: real.servico, ...(semRegistro ? {} : { registro: real.registro, identidadeDe: real.identidadeDe }), async publicar(entrada) { await real.publicar(entrada); throw erroCom('EIO'); } });
    };
    await comPublicador(lancando(false), async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.equal(composto.resultado.publicacao, null);
      assert.ok(arquivosDoRegistro(a).includes('prep-1.quarentena.json'));
      assert.equal(travaNoDisco(a), false);
      assert.equal((await leitor(a)).motivo, 'PACOTE_EM_QUARENTENA');
    });
    await comPublicador(lancando(true), async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela], [11, 'RETIDA']);
      assert.equal(travaNoDisco(a), true);
    });
  });
});

describe('[QD-C] estados de queda, adulteração e ausência do registro', () => {
  teste('QD-10 — QUEDA após o rename e antes da conclusão (fixture: pacote real sem o registro de conclusão): recusado (PUBLICACAO_NAO_CONCLUIDA) por TODOS os leitores; sem NENHUM registro: o leitor legado aceita (compatibilidade), o de PRODUÇÃO recusa (PUBLICACAO_SEM_REGISTRO) — ausência não é prova', async () => {
    const a = await ambiente();
    const composto = await executar({ criarBackupDeProducao }, a);
    fs.rmSync(path.join(dirRegistro(a), 'prep-1.conclusao.json'));
    for (const modo of [true, false]) assert.equal((await leitor(a, 'prep-1', modo)).motivo, 'PUBLICACAO_NAO_CONCLUIDA');
    assert.equal((await lerDoDisco(a, composto)).estado, 'PUBLICACAO_NAO_CONCLUIDA');
    for (const n of arquivosDoRegistro(a)) fs.rmSync(path.join(dirRegistro(a), n));
    assert.equal((await lerDoDisco(a, composto)).estado, 'SEM_REGISTRO');
    assert.equal((await leitor(a, 'prep-1', false)).ok, true, 'legado: pacote sem registro algum continua legível');
    assert.equal((await leitor(a, 'prep-1', true)).motivo, 'PUBLICACAO_SEM_REGISTRO');
  });

  teste('QD-11 — marcador ADULTERADO ou FORJADO: conteúdo alterado, conclusão forjada com integridade recalculada mas sem HMAC válido, conclusão de OUTRO pacote, arquivo substituído por link simbólico e permissão frouxa — todos recusam (REGISTRO_DE_PUBLICACAO_INVALIDO) e nunca promovem', async () => {
    const a = await ambiente();
    const composto = await executar({ criarBackupDeProducao }, a);
    const alvo = path.join(dirRegistro(a), 'prep-1.conclusao.json');
    const original = fs.readFileSync(alvo);
    const motivo = async () => (await leitor(a)).motivo;
    // 1) conteúdo alterado
    fs.writeFileSync(alvo, original.toString('utf8').replace('"nome":"prep-1"', '"nome":"prep-X"'));
    fs.chmodSync(alvo, 0o600);
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    // 2) forjada: integridade recalculada, MAC trocado por outro valor hexadecimal válido
    const forjado = JSON.parse(original.toString('utf8'));
    forjado.mac = (forjado.mac[0] === '0' ? '1' : '0') + forjado.mac.slice(1);
    fs.writeFileSync(alvo, `${JSON.stringify(forjado)}\n`);
    fs.chmodSync(alvo, 0o600);
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    // 2b) sem MAC nenhum (só integridade): produção recusa; o leitor sem exigência de registro ainda aceita a integridade
    const semMac = JSON.parse(original.toString('utf8'));
    delete semMac.mac;
    fs.writeFileSync(alvo, `${JSON.stringify(semMac)}\n`);
    fs.chmodSync(alvo, 0o600);
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    // 3) permissão frouxa
    fs.writeFileSync(alvo, original);
    fs.chmodSync(alvo, 0o644);
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    // 4) link simbólico
    fs.chmodSync(alvo, 0o600);
    const fora = path.join(a.raiz, 'copia-conclusao.json');
    fs.writeFileSync(fora, original, { mode: 0o600 });
    fs.rmSync(alvo);
    fs.symlinkSync(fora, alvo);
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    // controle: restaurado, volta a ser admissível
    fs.rmSync(alvo);
    fs.writeFileSync(alvo, original, { mode: 0o600 });
    assert.equal((await lerDoDisco(a, composto)).estado, 'ADMISSIVEL');
    // 5) registro de OUTRO pacote
    const b = await executar({ criarBackupDeProducao }, a, 'prep-2');
    assert.equal(b.resultado.publicacao.publicada, true);
    const deB = fs.readFileSync(path.join(dirRegistro(a), 'prep-2.conclusao.json'));
    fs.rmSync(alvo);
    fs.writeFileSync(alvo, deB, { mode: 0o600 });
    assert.equal(await motivo(), 'REGISTRO_DE_PUBLICACAO_INVALIDO');
  });

  teste('QD-12 — o diretório do registro é verificado: diretório permissivo (0755) ou substituído por link simbólico => REGISTRO_INVALIDO na leitura e recusa na escrita (falha fechada); nada é gravado', async () => {
    const a = await ambiente();
    const composto = await executar({ criarBackupDeProducao }, a);
    const dir = dirRegistro(a);
    fs.chmodSync(dir, 0o755);
    assert.deepEqual([(await lerDoDisco(a, composto)).estado, (await lerDoDisco(a, composto)).motivo], ['REGISTRO_INVALIDO', 'DIRETORIO_PERMISSIVO']);
    const reg = registroMod.criarRegistroDePublicacao({ raiz: a.dirs.publicados });
    const escrita = await reg.registrarQuarentena({ ...identidadeDe(composto), operacaoId: composto.resultado.correlacao.snapshot.operacaoId }, 'PUBLICACAO_INCERTA');
    assert.deepEqual([escrita.ok, escrita.motivo], [false, 'DIRETORIO_PERMISSIVO']);
    assert.equal(arquivosDoRegistro(a).includes('prep-1.quarentena.json'), false);
    fs.chmodSync(dir, 0o700);
    const movido = `${dir}-real`;
    fs.renameSync(dir, movido);
    fs.symlinkSync(movido, dir);
    assert.equal((await lerDoDisco(a, composto)).motivo, 'DIRETORIO_INVALIDO');
  });
});

describe('[QD-D] retirada explícita, prova de restauração e escrita segura', () => {
  teste('QD-13 — a retirada exige procedimento EXPLÍCITO e autorizado: nada retira sozinho (nem um pacote íntegro); autorização forjada, de outro pacote ou com confirmação errada é recusada; a retirada grava um registro autenticado (nada é apagado) e só então o pacote é admitido', async () => {
    const fabrica = (original, opcoes) => original.criarPublicador({ ...opcoes, ops: opsIncerta(opcoes) });
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      const identidade = identidadeDe(composto);
      const reg = registroMod.criarRegistroDePublicacao({ raiz: a.dirs.publicados, fonteDeChaves: a.fonteDeChaves, chaveId: 'k-1' });
      assert.equal((await reg.lerSituacao(identidade)).estado, 'EM_QUARENTENA');
      assert.equal((await leitor(a)).motivo, 'PACOTE_EM_QUARENTENA', 'o pacote é íntegro e mesmo assim continua em quarentena');
      assert.throws(() => registroMod.criarAutorizacaoDeRetirada({ responsavel: 'Fulano', justificativa: 'verificado fora do código', confirmacao: 'qualquer coisa', identidade }), TypeError);
      assert.throws(() => registroMod.criarAutorizacaoDeRetirada({ responsavel: '', justificativa: 'x', confirmacao: registroMod.textoDeConfirmacao(identidade), identidade }), TypeError);
      const falsa = { responsavel: 'Fulano', justificativa: 'x', nome: identidade.nome, sha256Manifesto: identidade.sha256Manifesto };
      assert.deepEqual([(await reg.retirarQuarentena(identidade, falsa)).ok, (await reg.retirarQuarentena(identidade, falsa)).motivo], [false, 'AUTORIZACAO_INVALIDA']);
      const semChave = registroMod.criarRegistroDePublicacao({ raiz: a.dirs.publicados });
      const autorizacao = registroMod.criarAutorizacaoDeRetirada({ responsavel: 'Fulano de Tal', justificativa: 'conferido manualmente pelo responsável', confirmacao: registroMod.textoDeConfirmacao(identidade), identidade });
      assert.equal((await semChave.retirarQuarentena(identidade, autorizacao)).motivo, 'SEM_FONTE_DE_CHAVES');
      const antes = arquivosDoRegistro(a);
      assert.equal((await reg.retirarQuarentena(identidade, autorizacao)).ok, true);
      assert.deepEqual(arquivosDoRegistro(a), [...antes, 'prep-1.retirada.json'].sort(), 'nada foi apagado');
      assert.deepEqual([(await lerDoDisco(a, composto)).estado, (await lerDoDisco(a, composto)).origem], ['ADMISSIVEL', 'RETIRADA_AUTORIZADA']);
      assert.equal((await leitor(a)).ok, true);
      assert.equal((await reg.retirarQuarentena(identidade, autorizacao)).motivo, 'NADA_A_RETIRAR');
    });
  });

  teste('QD-14 — nenhum caminho do pipeline retira a quarentena: `retirarQuarentena` só é referenciada no próprio módulo do registro', () => {
    const raiz = path.join(__dirname, '..', '..', 'src');
    const achados = [];
    const andar = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) andar(p);
        else if (e.name.endsWith('.js') && !e.name.includes(' 2') && fs.readFileSync(p, 'utf8').includes('retirarQuarentena')) achados.push(path.basename(p));
      }
    };
    andar(raiz);
    assert.deepEqual(achados, ['imagem-backup-registro-publicacao.service.js']);
  });

  teste('QD-15 — LIMITE DECLARADO: o gate de `provarRestauracao` (volátil + durável) só é alcançado com pacote publicado e avaliação reconhecida pela produção (spawn/PostgreSQL genuínos; ver OP-H01), então aqui se prova apenas a ORDEM no código — o gate precede qualquer spawn, conexão ou leitura de dump — e que lê o registro do DISCO com a identidade do manifesto e a fonte de chaves da composição; a recusa durável em si é provada em QD-02/QD-10 pelo mesmo `lerSituacao`', () => {
    const fonte = fs.readFileSync(require.resolve('../../src/services/imagem-backup-operacao.service'), 'utf8');
    const corpo = fonte.slice(fonte.indexOf('provarRestauracao'));
    const gate = corpo.indexOf("negada('PACOTE_EM_QUARENTENA')");
    const durável = corpo.indexOf('await lerSituacao(');
    assert.ok(gate > 0 && durável > gate, 'o gate volátil precede o durável');
    for (const efeito of ['criarRestaurador(', 'restaurarPacote(', 'spawn(', 'criarConexaoDoBanco(']) {
      const pos = corpo.indexOf(efeito);
      assert.ok(pos === -1 || pos > durável, `${efeito} só depois do gate`);
    }
    assert.match(corpo.slice(durável, durável + 400), /sha256Manifesto/);
    assert.match(corpo.slice(durável, durável + 400), /fonteDeChaves/);
  });

  test('QD-15b — gate de `provarRestauracao` ponta a ponta com pacote em quarentena: depende de publicação genuína', { todo: 'pendente de homologação genuína (documento 75, OP-H01)' }, () => {});

  teste('QD-16 — ESCRITA SEGURA do registro (operações instrumentadas): criação exclusiva sem sobrescrita, escrita completa, fsync do ARQUIVO antes do fsync do DIRETÓRIO, e um segundo registro do mesmo tipo e da mesma tentativa não altera o primeiro', async () => {
    const raiz = path.join(fix.criar(), 'publicados');
    fs.mkdirSync(raiz, { mode: 0o700 });
    const eventos = [];
    const ops = {
      abrirExclusivo: async (p) => { eventos.push(`abrir:${path.basename(p)}`); return abrirReal(p); },
      escrever: async (h, b) => { eventos.push('escrever'); return h.writeFile(b); },
      fsyncArquivo: async (h) => { eventos.push('fsync-arquivo'); return h.sync(); },
      fsyncDiretorio: async (p) => { eventos.push(`fsync-dir:${path.basename(p)}`); return fsyncReal(p); },
    };
    const identidade = { nome: 'pk-1', operacaoId: 'op-0123456789abcdef0123456789abcdef', conjuntoId: 'conjunto-x', sha256Manifesto: 'a'.repeat(64), dump: { bytes: 10, sha256: 'b'.repeat(64) } };
    const reg = registroMod.criarRegistroDePublicacao({ raiz, ops });
    const i = await reg.registrarIntencao(identidade);
    assert.equal(i.ok, true, JSON.stringify(i));
    const dirRegistroNome = path.basename(reg.diretorio);
    const idx = (alvo) => eventos.findIndex((e) => e.replace(/intencao\.[0-9a-f]{16}/, 'intencao.T') === alvo);
    const seq = ['abrir:pk-1.intencao.T.json', 'escrever', 'fsync-arquivo', `fsync-dir:${dirRegistroNome}`].map(idx);
    assert.ok(seq.every((n) => n >= 0), JSON.stringify(eventos));
    assert.deepEqual(seq, [...seq].sort((x, y) => x - y), 'abrir < escrever < fsync do arquivo < fsync do diretório');
    const c = await reg.registrarConclusao(identidade, i.tentativa);
    assert.equal(c.ok, true);
    const arquivo = path.join(reg.diretorio, 'pk-1.conclusao.json');
    const antes = fs.readFileSync(arquivo);
    const repetida = await reg.registrarConclusao(identidade, i.tentativa);
    assert.deepEqual([repetida.ok, repetida.motivo], [false, 'JA_EXISTE']);
    assert.deepEqual(fs.readFileSync(arquivo), antes, 'nenhuma sobrescrita');
    const q1 = await reg.registrarQuarentena(identidade, 'PUBLICACAO_INCERTA');
    const conteudo = fs.readFileSync(path.join(reg.diretorio, 'pk-1.quarentena.json'));
    const q2 = await reg.registrarQuarentena(identidade, 'PUBLICADO_SOB_CANCELAMENTO');
    assert.deepEqual([q1.ok, q2.ok, q2.jaExistia], [true, true, true]);
    assert.deepEqual(fs.readFileSync(path.join(reg.diretorio, 'pk-1.quarentena.json')), conteudo, 'a quarentena original não é substituída');
    assert.equal((await reg.registrarQuarentena(identidade, 'MOTIVO_QUALQUER')).motivo, 'MOTIVO_INVALIDO');
    assert.equal((await reg.registrarIntencao({ ...identidade, nome: '../fuga' })).motivo, 'IDENTIDADE_INVALIDA');
  });
});
