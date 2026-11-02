'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lerConfiguracao } = require('../../src/config/imagens');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { criarInicializacaoConfiavel, executarBackupEncadeado } = require('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');
const { criarVerificadorEstrutural, ehEvidenciaEstrutural } = require('../../src/services/imagem-backup-estrutura.service');
const { criarObservadorDoDump } = require('../../src/services/imagem-backup-evidencia-dump.service');
const { criarPublicador, criarProdutorDeRelatorio, criarServicoDePacote, ehEvidenciaDoPacote } = require('../../src/services/imagem-backup-publicacao.service');
const { avaliarConjunto } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, MARCO C): testes FUNCIONAIS do pacote completo, da verificação estrutural supervisionada (CONS-03), da consistência plano x cópia (CONS-02) e da publicação atômica e durável.
 * Só dados FICTÍCIOS em diretórios temporários exclusivos (prefixo `gepi-mc-test-`). Simulados e identificados: PostgreSQL, `pg_dump`, `pg_restore --list` (lançador simulado), trava e declaração do dump. Reais: encadeamento, coordenador,
 * supervisor, observador T1/T2, correlação, aquisição, montagem, composição, selagem, pacote, persistência (fsync reais em arquivos temporários) e publicação (mkdir/rename reais no temporário). NADA aqui executa `pg_dump`/`pg_restore`,
 * acessa PostgreSQL, publica backup operacional ou comprova durabilidade de mídia, restauração ou recuperabilidade. `TESTE_CONTROLADO` NÃO é origem operacional (MC-R).
 */

const PRAZO = 30000;
const PREFIXO = 'gepi-mc-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-mc-0001';
const ID_SNAPSHOT = '00000003-0000001B-1';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_BYTES = Buffer.from('dump-ficticio-0123456789-'.repeat(120));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura SIMULADA
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});
const novaRaiz = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); fs.chmodSync(p, 0o700); raizes.push(p); return p; };
function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}
const paginar = (linhas, [depoisDe, limite]) => linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);

async function mundo(opc = {}) {
  const raiz = novaRaiz();
  const linha = [];
  const buf = (t) => Buffer.from(t, 'utf8');
  const pm = buf('padrao-mestre-conteudo');
  const pn = buf('padrao-miniatura-conteudo');
  const em = buf('empresa7-mestre');
  const ee = buf('empresa7-exibicao');
  const en = buf('empresa7-miniatura');
  const registros = {
    padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }],
    empresa: [{ id: '2', empresaId: 7, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(em), sha256Exibicao: sha(ee), sha256Miniatura: sha(en), bytesMestre: em.length, bytesExibicao: ee.length, bytesMiniatura: en.length }],
  };
  const linhasPadrao = [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }];
  const linhasEmpresa = [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }];
  const plano = planejarArquivos(registros);
  const dirOrigem = path.join(raiz, 'origem');
  const origem = criarArmazenamentoImagens({ diretorio: dirOrigem });
  for (const item of plano) await origem.gravar(item.chave, [pm, pn, em, ee, en].find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const pai = path.join(raiz, 'preparacoes');
  const dumps = path.join(raiz, 'dumps');
  const destino = path.join(raiz, 'publicados');
  for (const d of [pai, dumps, destino]) fs.mkdirSync(d, { mode: 0o700 });

  const estadoDaTrava = { documento: null, liberacoes: 0 };
  const janela = {
    async adquirir(argumentos) {
      linha.push('janela:adquirir');
      const token = `token-${linha.length}`;
      estadoDaTrava.documento = { token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { return { confirmada: estadoDaTrava.documento !== null && estadoDaTrava.documento.token === token }; },
        async liberar() { linha.push('janela:liberar'); estadoDaTrava.liberacoes += 1; estadoDaTrava.documento = null; return { liberada: true }; },
      });
    },
  };
  const criarCliente = () => {
    const c = {
      ouvintes: { error: [], end: [] },
      async connect() { linha.push('sql:connect'); },
      async query(sql, parametros) {
        const tipo = tipoDe(sql);
        linha.push(`sql:${tipo}`);
        switch (tipo) {
          case 'EXPORTAR': return { rows: [{ snapshot_id: ID_SNAPSHOT }] };
          case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
          case 'PADRAO': return { rows: paginar(linhasPadrao, parametros) };
          case 'EMPRESA': return { rows: paginar(linhasEmpresa, parametros) };
          default: return { rows: [] };
        }
      },
      async end() { linha.push('sql:end'); for (const f of c.ouvintes.end) f(); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    return c;
  };
  let caminhoDoDump = null;
  const arquivos = {
    criarExclusivo(spec) {
      caminhoDoDump = path.join(spec.diretorio, spec.nome);
      const descritor = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      return { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
    },
  };
  const lancador = {
    lancar(spec) {
      linha.push('dump:lancado');
      fs.writeSync(spec.opcoes.stdio[1], DUMP_BYTES);
      return { pid: 4242, saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() };
    },
  };
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    lancador, sistema: { async grupoVivo() { return false; }, async enviarSinal() { return false; } }, arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() }, prazos: { ...PRAZOS },
  };
  // A declaração (fonte simulada) é chamada DEPOIS de T1 e ANTES da composição: o gancho `aoDeclarar` altera o artefato nessa janela.
  const declaracaoDoDump = { async sha256() { linha.push('declaracao'); if (opc.aoDeclarar) opc.aoDeclarar(caminhoDoDump); return sha(DUMP_BYTES); } };
  const selagemReal = criarSelagem();
  const selagem = { selar: (e) => selagemReal.selar(e), verificar: (e) => selagemReal.verificar(e) };
  const ambiente = { IMAGENS_ARMAZENAMENTO_DIRETORIO: dirOrigem };
  const parametros = () => ({
    configuracaoDeImagens: lerConfiguracao(ambiente), diretorioPai: pai, diretorioDoDump: dumps, janela,
    conexao: { criarConexao: () => { linha.push('criarConexao'); return criarCliente(); }, temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) }, prazos: { finalizacaoMs: 5000 } },
    dump, selagem, maxBytesPorArquivo: 4096, declaracaoDoDump,
  });
  const estrutural = { specs: [], mesmoArquivo: [] };
  /** Verificador estrutural com o `pg_restore --list` SIMULADO pelo lançador (modo: ok | saida1 | sinal | vivo | lanca | muda | trava). */
  const verificador = (modo = 'ok') => criarVerificadorEstrutural({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador: {
      lancar(spec) {
        estrutural.specs.push(spec);
        try {
          const a = fs.fstatSync(spec.opcoes.stdio[0]);
          const b = fs.statSync(caminhoDoDump);
          estrutural.mesmoArquivo.push(a.dev === b.dev && a.ino === b.ino);
        } catch { estrutural.mesmoArquivo.push(false); }
        if (modo === 'lanca') throw new Error(`${SEGREDO} /Users/privado`);
        if (modo === 'muda') fs.appendFileSync(caminhoDoDump, 'x');
        const termino = modo === 'saida1' ? { codigo: 1, sinal: null } : modo === 'sinal' ? { codigo: null, sinal: 'SIGKILL' } : { codigo: 0, sinal: null };
        const sumarios = { semSumario: undefined, sumarioInvalido: { formato: 'TAR', entradas: 3, truncado: false }, sumarioVazio: { formato: 'CUSTOM', entradas: 0, truncado: false } };
        const sumario = Object.hasOwn(sumarios, modo) ? sumarios[modo] : { formato: 'CUSTOM', entradas: 12, truncado: false };
        return {
          pid: 5151,
          saida: modo === 'trava' ? new Promise(() => {}) : Promise.resolve(termino),
          fluxosFechados: modo === 'trava' ? new Promise(() => {}) : Promise.resolve(),
          ...(sumario === undefined ? {} : { resultado: Promise.resolve(sumario) }),
        };
      },
    },
    sistema: { async grupoVivo() { return modo === 'vivo'; }, async enviarSinal() { return true; } },
    temporizador: {
      prazo: (ms) => (modo === 'trava' && (ms === PRAZOS.totalMs || ms === PRAZOS.cortesiaMs) ? { promessa: Promise.resolve(), cancelar() {} } : { promessa: new Promise(() => {}), cancelar() {} }),
      intervalo: () => Promise.resolve(),
    },
    prazos: { ...PRAZOS },
  });
  const eventos = [];
  /** Operações de FS espiãs (delegam às reais) com falhas injetáveis. */
  const ops = (falhas = {}) => ({
    escrever: async (h, b, o, t, p) => { if (falhas.escrever) throw new Error(SEGREDO); return h.write(b, o, t, p); },
    fsyncArquivo: async (h) => { eventos.push('fsync:arquivo'); if (falhas.fsyncArquivo) throw new Error(SEGREDO); return h.sync(); },
    fsyncDiretorio: async (p) => {
      eventos.push(`fsync:dir:${path.relative(raiz, p)}`);
      if (falhas.fsyncDiretorio && falhas.fsyncDiretorio(p)) throw new Error(SEGREDO);
      const h = await fs.promises.open(p, fs.constants.O_RDONLY);
      try { await h.sync(); } finally { await h.close(); }
    },
    rename: async (de, para) => { eventos.push('rename'); if (falhas.rename && falhas.rename(de, para)) throw new Error(SEGREDO); return fs.promises.rename(de, para); },
  });
  const produtor = (decidir = () => ({ ok: true })) => criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir });
  const publicador = (extras = {}) => criarPublicador({ raizDoDestino: destino, produtorDeRelatorio: produtor(), origensAceitas: ['TESTE_CONTROLADO'], ...extras });
  const inicializacao = (extras = {}) => criarInicializacaoConfiavel({ ...parametros(), ...extras });
  const executar = async (extras = {}, inic = {}) => executarBackupEncadeado({ inicializacao: inicializacao(inic), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO, ...extras });
  return { raiz, linha, estadoDaTrava, pai, dumps, destino, plano, dirOrigem, origem, inicializacao, parametros, executar, verificador, publicador, produtor, ops, eventos, estrutural, caminhoDoDump: () => caminhoDoDump };
}
const semVazamento = (valor, m) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(m ? [m.raiz] : [])]) assert.equal(t.includes(proibido), false, proibido);
};
const hashDe = (caminho) => sha(fs.readFileSync(caminho));
function instantaneo(raiz) {
  const mapa = {};
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) andar(p); else mapa[path.relative(raiz, p)] = hashDe(p);
    }
  };
  andar(raiz);
  return mapa;
}
/**
 * Execução completa com estrutura OK. Por padrão o publicador configurado RECUSA o relatório (a preparação fica em `preparacoes/` para inspeção); `publicar: true` usa o publicador de TESTE_CONTROLADO que aceita.
 */
async function completo(m, { estrutural = 'ok', ops, publicadorExtras = {}, nome = 'prep-1', pub, publicar = false } = {}) {
  const recusante = { produtorDeRelatorio: m.produtor(() => ({ ok: false })) };
  const publicador = pub ?? m.publicador({ ...(ops ? { ops } : {}), ...(publicar ? publicadorExtras : recusante) });
  const r = await m.executar({ nomeDaPreparacao: nome }, { verificadorEstrutural: m.verificador(estrutural), publicador });
  return { r, publicador };
}

// ------------------------------------------------------------------------------------------------------------------------------- MC-S: segurança estática / carregamento
describe('[MC-S] módulos novos: sem efeito operacional ao carregar e contratos estritos', () => {
  teste('MC-S01 — o carregamento dos módulos do Marco C não toca disco, rede, processo nem ambiente (inspeção do fonte): só declarações no nível de módulo', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    for (const nome of ['imagem-backup-publicacao', 'imagem-backup-estrutura', 'imagem-backup-correlacao']) {
      const linhas = fs.readFileSync(path.join(base, `${nome}.service.js`), 'utf8').split('\n');
      let emBloco = false;
      for (const [i, l] of linhas.entries()) {
        if (emBloco) { if (l.includes('*/')) emBloco = false; continue; }
        if (l.startsWith('/*')) { if (!l.includes('*/')) emBloco = true; continue; }
        if (l === '' || l.startsWith(' ') || l.startsWith('//') || l.startsWith('}') || l.startsWith(')') || l.startsWith(']') || l === "'use strict';") continue;
        assert.match(l, /^(const|let|function|async function|module\.exports)\b/, `${nome}:${i + 1} nível de módulo inesperado`);
      }
      const fonte = linhas.join('\n');
      assert.equal(/process\.on\(|setInterval\(|child_process|require\('pg'\)|\.listen\(/.test(fonte), false, nome);
    }
  });

  teste('MC-S02 — fábricas ESTRITAS: opções desconhecidas, caminhos relativos/não canônicos, produtor/verificador não reconhecidos e dependências ausentes são recusados', async () => {
    const m = await mundo();
    assert.throws(() => criarPublicador({ raizDoDestino: m.destino, produtorDeRelatorio: m.produtor(), extra: 1 }), TypeError);
    assert.throws(() => criarPublicador({ raizDoDestino: 'relativo', produtorDeRelatorio: m.produtor() }), TypeError);
    assert.throws(() => criarPublicador({ raizDoDestino: '/a/../b', produtorDeRelatorio: m.produtor() }), TypeError);
    assert.throws(() => criarPublicador({ raizDoDestino: m.destino }), TypeError);
    assert.throws(() => criarPublicador({ raizDoDestino: m.destino, produtorDeRelatorio: () => ({ ok: true, origem: 'OPERACIONAL' }) }), TypeError, 'produtor literal não reconhecido');
    assert.throws(() => criarPublicador({ raizDoDestino: m.destino, produtorDeRelatorio: m.produtor(), ops: { rename: 1 } }), TypeError);
    assert.throws(() => criarVerificadorEstrutural({ alvo: { executavel: 'pg_restore' }, lancador: {}, sistema: {}, temporizador: {}, prazos: {} }), TypeError);
    assert.throws(() => criarVerificadorEstrutural({ alvo: { executavel: '/usr/bin/pg_restore' }, lancador: { lancar() {} }, sistema: { grupoVivo() {}, enviarSinal() {} }, temporizador: { prazo() {}, intervalo() {} }, prazos: { ...PRAZOS }, intruso: 1 }), TypeError);
    assert.throws(() => m.inicializacao({ publicador: { publicar() {} } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => m.inicializacao({ verificadorEstrutural: { verificar() {} } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    await assert.rejects(Promise.resolve().then(() => m.verificador().verificar({ operacaoId: 'op-1', observador: { abrirArtefato: () => ({ ok: true, descritor: 3 }) } })), TypeError, 'observador forjado');
    const real = criarObservadorDoDump({ arquivos: { criarExclusivo() {} }, lancador: { lancar() {} } });
    const semT1 = await m.verificador().verificar({ operacaoId: 'op-1', observador: real });
    assert.equal(semT1.ok, false);
    assert.equal(semT1.motivo, 'ARTEFATO_SEM_OBSERVACAO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MC-E: estrutura (CONS-03)
describe('[MC-E] verificação estrutural supervisionada (CONS-03): contrato, vínculo ao artefato de T1/T2 e falha fechada — NÃO é execução real de pg_restore', () => {
  teste('MC-E01 — caminho positivo: `--list` lançado UMA vez com o MESMO arquivo de T1 como entrada padrão (sem caminho), supervisão concluída, evidência reconhecida e vinculada à operação, identidade, tamanho e SHA-256 de T1; a correlação a carrega', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    assert.equal(m.estrutural.specs.length, 1);
    const spec = m.estrutural.specs[0];
    assert.equal(spec.executavel, '/usr/bin/pg_restore');
    assert.deepEqual([...spec.argumentos], ['--list']);
    assert.equal(spec.opcoes.shell, false);
    assert.equal(spec.opcoes.detached, true);
    assert.equal(Number.isSafeInteger(spec.opcoes.stdio[0]), true);
    assert.deepEqual(spec.opcoes.stdio.slice(1), ['pipe', 'ignore']);
    assert.deepEqual({ ...spec.ambiente }, {}, 'nenhuma variável de conexão ao banco');
    assert.equal(JSON.stringify(spec).includes(m.dumps), false, 'o caminho do dump nunca é passado ao processo');
    assert.deepEqual(m.estrutural.mesmoArquivo, [true], 'a entrada padrão é o MESMO arquivo (dev/ino) observado em T1');
    const e = r.correlacao.estrutura;
    assert.equal(ehEvidenciaEstrutural(e), true);
    assert.deepEqual({ ok: e.ok, origem: e.origem, escopo: e.escopo, concluida: e.concluida, formato: e.formato, entradas: e.entradas }, { ok: true, origem: 'PG_RESTORE_LIST_SUPERVISIONADO', escopo: 'LISTAGEM_DO_SUMARIO', concluida: true, formato: 'CUSTOM', entradas: 12 });
    assert.equal(e.operacaoId, r.correlacao.snapshot.operacaoId);
    assert.equal(e.sha256, sha(DUMP_BYTES));
    assert.equal(e.bytes, DUMP_BYTES.length);
    assert.deepEqual(e.identidade, r.correlacao.dump.identidade);
    assert.equal(r.coordenador.supervisao.concluido, true);
    semVazamento(r.correlacao, m);
  });

  teste('MC-E02 — falha fechada: saída não zero, sinal, grupo vivo (estado incerto), lançamento que falha e processo que não termina nunca produzem estrutura ok; o pacote é montado mas a publicação é RECUSADA', async () => {
    const cenarios = [['saida1', 'SAIDA_NAO_ZERO'], ['sinal', 'SINAL'], ['vivo', 'ESTADO_INCERTO'], ['lanca', 'NAO_INICIADA'], ['trava', null], ['semSumario', 'SUMARIO_INVALIDO'], ['sumarioInvalido', 'SUMARIO_INVALIDO'], ['sumarioVazio', 'SUMARIO_INVALIDO']];
    for (const [modo, motivo] of cenarios) {
      const m = await mundo();
      const { r } = await completo(m, { estrutural: modo });
      const e = r.correlacao.estrutura;
      assert.equal(e.ok, false, modo);
      assert.equal(e.concluida, true, modo);
      if (motivo !== null) assert.equal(e.motivo, motivo, modo);
      assert.equal(r.publicacao.publicada, false, modo);
      assert.equal(r.publicacao.motivo, 'ESTRUTURA_NAO_VERIFICADA', modo);
      assert.equal(fs.readdirSync(m.destino).length, 0, `${modo}: nada publicado`);
      assert.equal(fs.existsSync(path.join(m.pai, 'prep-1')), true, `${modo}: preparação preservada`);
      semVazamento(r, m);
    }
  });

  teste('MC-E03 — sem verificador configurado a estrutura consta NAO_EXECUTADA e a publicação é recusada; a execução do restante continua', async () => {
    const m = await mundo();
    const publicador = m.publicador();
    const r = await m.executar({}, { publicador });
    assert.deepEqual({ ok: r.correlacao.estrutura.ok, concluida: r.correlacao.estrutura.concluida, origem: r.correlacao.estrutura.origem }, { ok: false, concluida: false, origem: 'NAO_EXECUTADA' });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.motivo, 'ESTRUTURA_NAO_VERIFICADA');
    assert.equal(r.pacote.ok, true, 'o pacote físico pode estar íntegro sem estrutura verificada');
  });

  teste('MC-E04 — artefato SUBSTITUÍDO entre T1 e a verificação: o `--list` nem é lançado (identidade diferente), a estrutura falha por ARTEFATO_SUBSTITUIDO e T2 também recusa', async () => {
    const m = await mundo({
      aoDeclarar: (caminho) => { const t = `${caminho}.substituto`; fs.writeFileSync(t, DUMP_BYTES, { mode: 0o600 }); fs.renameSync(t, caminho); },
    });
    const { r } = await completo(m);
    assert.equal(m.estrutural.specs.length, 0, 'processo não lançado sobre artefato de outra identidade');
    assert.equal(r.correlacao.estrutura.ok, false);
    assert.equal(r.correlacao.estrutura.motivo, 'ARTEFATO_SUBSTITUIDO');
    assert.equal(r.correlacao.dump.t2.ok, false);
    assert.equal(r.pacote, null, 'com T2 recusado a correlação não é satisfeita e o pacote não é montado');
    assert.equal(r.publicacao, null);
  });

  teste('MC-E05 — artefato ALTERADO durante a verificação estrutural: o `--list` pode sair com 0, mas T2 (posterior) recusa e nada é montado nem publicado', async () => {
    const m = await mundo();
    const { r } = await completo(m, { estrutural: 'muda' });
    assert.equal(r.correlacao.estrutura.ok, true, 'a listagem em si foi concluída');
    assert.equal(r.correlacao.dump.t2.ok, false);
    assert.equal(r.correlacao.dump.t2.motivo, 'DIVERGENTE');
    assert.equal(r.pacote, null);
    assert.equal(r.publicacao, null);
    assert.equal(fs.readdirSync(m.destino).length, 0);
  });

  teste('MC-E06 — a evidência estrutural não é forjável: literal/clone não é reconhecido e não satisfaz a publicação; uma correlação com estrutura de OUTRA operação/artefato é divergente', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const e = r.correlacao.estrutura;
    assert.equal(ehEvidenciaEstrutural({ ...e }), false);
    assert.equal(ehEvidenciaEstrutural(JSON.parse(JSON.stringify(e))), false);
    const outro = await mundo();
    const { r: ro } = await completo(outro);
    assert.notEqual(ro.correlacao.estrutura.operacaoId, e.operacaoId);
    const av = avaliarConjunto({ saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true }, dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') }, identidade: { conjuntoId: 'x', sha256Manifesto: H('b') }, relatorio: { veredito: 'VALIDO' }, correlacao: { ...r.correlacao, estrutura: ro.correlacao.estrutura } });
    assert.equal(av.correlacaoContratual.satisfeita, false, 'correlação adulterada não tem origem reconhecida');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MC-P: pacote completo
describe('[MC-P] pacote completo: dump incorporado e reverificado, imagens preservadas, manifesto e selagem coerentes', () => {
  teste('MC-P01 — o pacote tem exatamente imagens + manifesto + selo + dump; o dump incorporado é OUTRO arquivo (outro inode), regular, com os mesmos bytes e SHA-256 de T1 e do manifesto; as imagens conferem com o manifesto', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    assert.equal(r.pacote.ok, true);
    assert.deepEqual(fs.readdirSync(prep).sort(), ['dump', 'imagens', 'manifesto.json', 'manifesto.sha256']);
    assert.deepEqual(fs.readdirSync(path.join(prep, 'dump')), ['postgres.dump']);
    const incorporado = path.join(prep, 'dump', 'postgres.dump');
    const original = m.caminhoDoDump();
    assert.equal(fs.lstatSync(incorporado).isFile(), true);
    assert.notEqual(fs.statSync(incorporado).ino, fs.statSync(original).ino);
    assert.equal(hashDe(incorporado), sha(DUMP_BYTES));
    assert.equal(fs.statSync(incorporado).size, DUMP_BYTES.length);
    assert.equal(r.composicao.manifesto.dump.sha256, sha(DUMP_BYTES));
    assert.equal(r.pacote.dump.sha256, sha(DUMP_BYTES));
    for (const item of r.composicao.manifesto.arquivos) assert.equal(hashDe(path.join(prep, 'imagens', ...item.chave.split('/'))), item.sha256);
    assert.equal(r.pacote.verificacao.arquivos, r.composicao.manifesto.arquivos.length + 3);
    assert.equal(ehEvidenciaDoPacote(r.pacote.verificacao), true);
    assert.equal(r.pacote.consistencia.demonstrada, true);
    assert.equal(fs.statSync(incorporado).mode & 0o777, 0o600);
    semVazamento(r, m);
  });

  teste('MC-P02 — `verificarPacote` recusa, com motivo fixo: imagem adulterada, dump incorporado adulterado, manifesto adulterado, selo divergente, arquivo extra, arquivo ausente e link simbólico', async () => {
    const casos = [
      ['imagem adulterada', (p, r) => fs.appendFileSync(path.join(p, 'imagens', ...r.composicao.manifesto.arquivos[0].chave.split('/')), 'x'), 'ARQUIVO_DIVERGENTE'],
      ['dump adulterado', (p) => fs.appendFileSync(path.join(p, 'dump', 'postgres.dump'), 'x'), 'ARQUIVO_DIVERGENTE'],
      ['manifesto adulterado', (p) => fs.appendFileSync(path.join(p, 'manifesto.json'), ' '), 'MANIFESTO_ADULTERADO'],
      ['selo divergente', (p) => fs.writeFileSync(path.join(p, 'manifesto.sha256'), `${H('e')}  manifesto.json\n`), 'SELO_DIVERGENTE'],
      ['arquivo extra', (p) => fs.writeFileSync(path.join(p, 'extra.bin'), 'x'), 'ARQUIVO_EXTRA'],
      ['arquivo ausente', (p) => fs.unlinkSync(path.join(p, 'dump', 'postgres.dump')), 'ARQUIVO_AUSENTE'],
      ['link simbólico', (p) => fs.symlinkSync('/etc/hosts', path.join(p, 'ligacao')), 'ENTRADA_INVALIDA'],
    ];
    for (const [rotulo, adulterar, motivo] of casos) {
      const m = await mundo();
      const { r } = await completo(m);
      const prep = path.join(m.pai, 'prep-1');
      adulterar(prep, r);
      const v = await criarServicoDePacote().verificarPacote({ preparacao: prep, manifesto: r.composicao.manifesto, identidade: r.composicao.identidade });
      assert.equal(v.ok, false, rotulo);
      assert.equal(v.motivo, motivo, rotulo);
      semVazamento(v, m);
    }
  });

  teste('MC-P03 — falha de ESCRITA ao incorporar o dump: pacote recusado (ESCRITA_FALHOU), nada publicado, preparação preservada e nenhuma remoção automática', async () => {
    const m = await mundo();
    const { r } = await completo(m, { ops: m.ops({ escrever: true }) });
    assert.equal(r.pacote.ok, false);
    assert.equal(r.pacote.motivo, 'ESCRITA_FALHOU');
    assert.equal(r.publicacao, null);
    assert.equal(fs.readdirSync(m.destino).length, 0);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'manifesto.json')), true);
    semVazamento(r, m);
  });

  teste('MC-P04 — falha de FSYNC do arquivo ao incorporar: pacote recusado (FSYNC_FALHOU), nada publicado', async () => {
    const m = await mundo();
    const { r } = await completo(m, { ops: m.ops({ fsyncArquivo: true }) });
    assert.equal(r.pacote.ok, false);
    assert.equal(r.pacote.motivo, 'FSYNC_FALHOU');
    assert.equal(r.publicacao, null);
    assert.equal(fs.readdirSync(m.destino).length, 0);
  });

  teste('MC-P05 — colisão com `dump/` já existente na preparação: DESTINO_EXISTENTE, sem sobrescrever', async () => {
    const m = await mundo();
    const base = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const antes = hashDe(path.join(prep, 'dump', 'postgres.dump'));
    const artefato = { ok: true, descritor: fs.openSync(m.caminhoDoDump(), 'r'), bytes: DUMP_BYTES.length, sha256: sha(DUMP_BYTES) };
    try {
      const v = await criarServicoDePacote().incorporarDump({ preparacao: prep, artefato, manifesto: base.r.composicao.manifesto });
      assert.equal(v.ok, false);
      assert.equal(v.motivo, 'DESTINO_EXISTENTE');
    } finally { fs.closeSync(artefato.descritor); }
    assert.equal(hashDe(path.join(prep, 'dump', 'postgres.dump')), antes);
  });

  teste('MC-P06 — o dump do manifesto precisa coincidir com o artefato observado: manifesto com outro SHA-256 é recusado (MANIFESTO_DIVERGE_DO_DUMP) antes de qualquer escrita', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    fs.rmSync(path.join(prep, 'dump'), { recursive: true });
    const artefato = { ok: true, descritor: fs.openSync(m.caminhoDoDump(), 'r'), bytes: DUMP_BYTES.length, sha256: sha(DUMP_BYTES) };
    try {
      const v = await criarServicoDePacote().incorporarDump({ preparacao: prep, artefato, manifesto: { ...r.composicao.manifesto, dump: { bytes: DUMP_BYTES.length, sha256: H('7') } } });
      assert.equal(v.motivo, 'MANIFESTO_DIVERGE_DO_DUMP');
    } finally { fs.closeSync(artefato.descritor); }
    assert.equal(fs.existsSync(path.join(prep, 'dump')), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MC-C: consistência (CONS-02)
describe('[MC-X] falhas de escrita, releitura e leitura do pacote e corrida pelo nome final: falha fechada, artefatos parciais preservados, nada publicado', () => {
  const erroCom = (code) => Object.assign(new Error(SEGREDO), { code });
  const artefatoDe = (m) => ({ ok: true, descritor: fs.openSync(m.caminhoDoDump(), 'r'), bytes: DUMP_BYTES.length, sha256: sha(DUMP_BYTES) });

  teste('MC-X01 — criação do `dump` recusada: EEXIST real do arquivo existente => DESTINO_EXISTENTE; abrir recusado (EACCES) => ESCRITA_FALHOU; o dump existente NUNCA é sobrescrito e a causa não vaza', async () => {
    const m = await mundo();
    const base = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const alvo = path.join(prep, 'dump', 'postgres.dump');
    const antes = hashDe(alvo);
    const casos = [
      ['EEXIST real', { mkdir: async () => {} }, 'DESTINO_EXISTENTE'],
      ['abrir recusado', { mkdir: async () => {}, abrir: async () => { throw erroCom('EACCES'); } }, 'ESCRITA_FALHOU'],
    ];
    for (const [rotulo, ops, motivo] of casos) {
      const artefato = artefatoDe(m);
      try {
        const v = await criarServicoDePacote({ ops }).incorporarDump({ preparacao: prep, artefato, manifesto: base.r.composicao.manifesto });
        assert.deepEqual([v.ok, v.motivo], [false, motivo], rotulo);
        semVazamento(v, m);
      } finally { fs.closeSync(artefato.descritor); }
      assert.equal(hashDe(alvo), antes, `${rotulo}: dump existente intacto`);
    }
  });

  teste('MC-X02 — falha na RELEITURA do dump incorporado: RELEITURA_FALHOU, e o arquivo já gravado é PRESERVADO para inspeção (nenhuma remoção automática); nada publicado', async () => {
    const m = await mundo();
    const base = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    fs.rmSync(path.join(prep, 'dump'), { recursive: true }); // abre espaço, na fixture do teste, para uma nova incorporação
    const ops = { abrir: async (p, flags, modo) => { if ((flags & fs.constants.O_EXCL) === 0) throw erroCom('EIO'); return fs.promises.open(p, flags, modo); } };
    const artefato = artefatoDe(m);
    try {
      const v = await criarServicoDePacote({ ops }).incorporarDump({ preparacao: prep, artefato, manifesto: base.r.composicao.manifesto });
      assert.deepEqual([v.ok, v.motivo], [false, 'RELEITURA_FALHOU']);
      semVazamento(v, m);
    } finally { fs.closeSync(artefato.descritor); }
    assert.equal(hashDe(path.join(prep, 'dump', 'postgres.dump')), sha(DUMP_BYTES), 'o parcial gravado foi preservado, íntegro');
    assert.equal(fs.readdirSync(m.destino).length, 0);
  });

  teste('MC-X03 — falha de LEITURA ao verificar o pacote (abrir ou readdir recusados): LEITURA_FALHOU, preparação inalterada', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const foto = instantaneo(prep);
    for (const [rotulo, ops] of [['abrir', { abrir: async () => { throw erroCom('EIO'); } }], ['readdir', { readdir: async () => { throw erroCom('EIO'); } }]]) {
      const v = await criarServicoDePacote({ ops }).verificarPacote({ preparacao: prep, manifesto: r.composicao.manifesto, identidade: r.composicao.identidade });
      assert.deepEqual([v.ok, v.motivo], [false, 'LEITURA_FALHOU'], rotulo);
      semVazamento(v, m);
      assert.deepEqual(instantaneo(prep), foto, `${rotulo}: preparação inalterada`);
    }
  });

  teste('MC-X05 — FALTA DE ESPAÇO (ENOSPC / EDQUOT) ao incorporar o dump: ESPACO_ESGOTADO (distinto de ESCRITA_FALHOU / FSYNC_FALHOU) no mkdir, na escrita e no fsync; o arquivo parcial é PRESERVADO (nenhuma remoção automática), nada publicado e a causa não vaza', async () => {
    const m = await mundo();
    const base = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const alvo = path.join(prep, 'dump', 'postgres.dump');
    const casos = [
      ['mkdir (ENOSPC)', { mkdir: async () => { throw erroCom('ENOSPC'); } }, null],
      ['escrita (EDQUOT)', { escrever: async () => { throw erroCom('EDQUOT'); } }, 0],
      ['fsync (ENOSPC)', { fsyncArquivo: async () => { throw erroCom('ENOSPC'); } }, DUMP_BYTES.length],
    ];
    for (const [rotulo, ops, tamanhoPreservado] of casos) {
      fs.rmSync(path.join(prep, 'dump'), { recursive: true, force: true }); // a fixture libera o espaço para uma nova tentativa
      const artefato = artefatoDe(m);
      try {
        const v = await criarServicoDePacote({ ops }).incorporarDump({ preparacao: prep, artefato, manifesto: base.r.composicao.manifesto });
        assert.deepEqual([v.ok, v.motivo], [false, 'ESPACO_ESGOTADO'], rotulo);
        semVazamento(v, m);
      } finally { fs.closeSync(artefato.descritor); }
      if (tamanhoPreservado === null) assert.equal(fs.existsSync(alvo), false, `${rotulo}: nada foi criado`);
      else assert.equal(fs.statSync(alvo).size, tamanhoPreservado, `${rotulo}: o arquivo parcial foi preservado`);
    }
    assert.deepEqual(fs.readdirSync(m.destino), []);
  });

  teste('MC-X04 — CORRIDA pelo nome final: `mkdir` da reserva recusado com EEXIST => COLISAO_DO_DESTINO; com outro erro => DESTINO_INVALIDO; nenhum rename, destino vazio, preparação intacta e uma publicação normal depois ainda funciona', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const base = { preparacao: prep, nomeFinal: 'prep-1', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia };
    const final = path.join(m.destino, 'prep-1');
    const foto = instantaneo(prep);
    for (const [code, motivo] of [['EEXIST', 'COLISAO_DO_DESTINO'], ['EACCES', 'DESTINO_INVALIDO']]) {
      const antesEventos = m.eventos.length;
      const ops = { ...m.ops(), mkdir: async (p, modo) => { if (p === final) throw erroCom(code); return fs.promises.mkdir(p, { mode: modo }); } };
      const res = await m.publicador({ ops }).publicar(base);
      assert.deepEqual([res.publicada, res.motivo], [false, motivo], code);
      semVazamento(res, m);
      assert.equal(m.eventos.slice(antesEventos).includes('rename'), false, `${code}: nenhum rename`);
      assert.deepEqual(fs.readdirSync(m.destino), [], `${code}: destino vazio`);
      assert.deepEqual(instantaneo(prep), foto, `${code}: preparação intacta`);
    }
    const final2 = await m.publicador({ ops: m.ops() }).publicar(base);
    assert.equal(final2.publicada, true);
  });
});

describe('[MC-C] consistência plano do snapshot x cópia preservada (CONS-02) e guard estático dos caminhos de remoção física', () => {
  teste('MC-C01 — arquivo referenciado pelo snapshot REMOVIDO da origem antes da cópia: a cópia falha fechada, nenhuma correlação do conjunto, nenhum pacote, nada publicado (nenhuma invalidação silenciosa)', async () => {
    const m = await mundo();
    // REMOÇÃO EXTERNA explícita (o armazenamento recusa remover sem a posse da janela de LIMPEZA): o arquivo some da origem por fora da aplicação.
    fs.unlinkSync(path.join(m.dirOrigem, ...m.plano[0].chave.split('/')));
    const { r } = await completo(m);
    assert.equal(r.composicao === null || r.composicao.ok === false, true);
    assert.notEqual(r.correlacao?.escopo, 'CONJUNTO');
    assert.equal(r.pacote, null);
    assert.equal(r.publicacao, null);
    assert.equal(r.coordenador.valido, false);
    assert.equal(fs.readdirSync(m.destino).length, 0);
  });

  teste('MC-C02 — `avaliarConsistencia` só demonstra com plano e manifesto de MESMA contagem e cópia INTEGRA; diverge, não demonstra; os limites constam e não há afirmação de consistência temporal', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const s = criarServicoDePacote();
    const ok = s.avaliarConsistencia({ operacaoId: 'op-1', itensDoPlano: r.composicao.arquivos, composicao: r.composicao, verificacao: r.verificacao });
    assert.equal(ok.demonstrada, true);
    assert.ok(ok.limites.includes('NAO_PROVA_AUSENCIA_DE_ESCRITORES_EXTERNOS'));
    assert.ok(ok.limites.includes('NAO_PROVA_REMOCAO_FISICA_FORA_DA_TRAVA'));
    assert.ok(ok.limites.includes('NAO_PROVA_CONSISTENCIA_TEMPORAL_ALEM_DO_SNAPSHOT'));
    for (const variacao of [{ itensDoPlano: r.composicao.arquivos + 1 }, { itensDoPlano: null }, { verificacao: { classe: 'DIVERGENCIA_COMPROVADA' } }, { verificacao: null }, { composicao: { ...r.composicao, ok: false } }]) {
      assert.equal(s.avaliarConsistencia({ operacaoId: 'op-1', itensDoPlano: r.composicao.arquivos, composicao: r.composicao, verificacao: r.verificacao, ...variacao }).demonstrada, false, JSON.stringify(Object.keys(variacao)));
    }
  });

  teste('MC-C03 — GUARD ESTÁTICO (inspeção, não prova dinâmica): só os arquivos conhecidos podem remover arquivos do disco; ninguém chama `removerVariantes` nem `remover` do armazenamento de imagens; a limpeza de órfãos — único remover físico de imagens — adquire a janela de LIMPEZA que o backup também usa', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const lista = [];
    const andar = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.name.includes(' 2')) continue;
        if (e.isDirectory()) andar(p); else if (e.name.endsWith('.js')) lista.push(p);
      }
    };
    andar(src);
    const REMOCAO = /\b(unlink|unlinkSync|rmSync|rmdirSync|rmdir)\(|\bfsp\.rm\(|\.rm\(/;
    const PERMITIDOS = new Map([
      ['utils/janela-escrita-imagens.js', 'arquivo da própria janela (trava)'],
      ['storage/armazenamento-imagens.js', 'definição do armazenamento de imagens (remover/removerVariantes SEM chamadores de produção, ver abaixo)'],
      ['storage/armazenamento-local.js', 'armazenamento dos pacotes de FISCALIZAÇÃO (outro subsistema)'],
      ['services/imagem-armazenamento-limpeza.service.js', 'limpeza de órfãos: ÚNICO remover físico de imagens, sob a janela LIMPEZA'],
      ['services/imagem-backup-selagem.service.js', 'área de selagem do próprio backup'],
      ['services/imagem-backup-publicacao.service.js', 'rmdir da reserva VAZIA criada pelo publicador'],
      // acréscimo autorizado (D-ORF-6, P-ORF-01 dos artefatos de backup): remoção por nome explícito, desativada operacionalmente por constante; ver as três travas adicionais abaixo
      ['services/imagem-backup-orfaos.service.js', 'limpeza de ARTEFATOS DE BACKUP (não de imagens): modo operacional desativado, remoção só em fixtures descartáveis'],
      // acréscimo autorizado (D-ORF-6, supervisão/recuperação): remove SÓ arquivos de TRAVA (`tentativa-*.lock`, `recurso-*.lock`) do diretório de estado da supervisão, e só por `removerTrava`; ver as travas adicionais abaixo
      ['services/imagem-backup-diario-execucao.service.js', 'arquivos de TRAVA da supervisão (tentativa e recurso): nunca imagem, dump, pacote, registro ou diário'],
      // acréscimo (D-ORF-6, D-12, 02/11/2026; inventário técnico, pendente de revisão humana na guarda P2): rmSync SÓ do diretório temporário exclusivo que o próprio módulo criou (0700, nome aleatório sob os.tmpdir()), após conferir tipo/dev/ino/dono e sem seguir links; nunca imagem, dump, pacote nem registro
      ['services/imagem-processador-area.service.js', 'área temporária exclusiva do processador de imagens (TMPDIR e pasta atual do filho sharp)'],
    ]);
    const donos = lista.filter((p) => REMOCAO.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(src, p).split(path.sep).join('/'));
    for (const dono of donos) assert.equal(PERMITIDOS.has(dono), true, `caminho de remoção física não previsto: ${dono}`);
    // o módulo de órfãos de backup: nunca importado por outro módulo de produção, nunca toca o armazenamento de imagens e a limpeza operacional segue desativada no código
    const orfaos = fs.readFileSync(path.join(src, 'services', 'imagem-backup-orfaos.service.js'), 'utf8');
    assert.match(orfaos, /const LIMPEZA_OPERACIONAL_HABILITADA = false;/);
    assert.equal(/armazenamento-imagens|janela-escrita-imagens/.test(orfaos.replace(/\/\*[\s\S]*?\*\//g, '')), false);
    for (const p of lista) if (!p.endsWith('imagem-backup-orfaos.service.js')) assert.equal(/imagem-backup-orfaos\.service/.test(fs.readFileSync(p, 'utf8')), false, `${path.relative(src, p)} importa a limpeza de artefatos de backup`);
    // o diário da supervisão: só DUAS remoções, ambas `sistema.unlinkSync(arquivo)` de arquivos .lock (a trava que falhou ao ser gravada, em `criarTrava`, e a liberação, em `removerTrava`); sem rm/rmdir e sem tocar o armazenamento de imagens nem a janela de escrita
    const diarioFonte = fs.readFileSync(path.join(src, 'services', 'imagem-backup-diario-execucao.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((diarioFonte.match(/\b(unlink|unlinkSync|rmSync|rmdirSync|rmdir)\(|\bfsp\.rm\(|\.rm\(/g) ?? []).length, 2, 'duas remoções no diário, ambas de trava');
    assert.equal((diarioFonte.match(/sistema\.unlinkSync\(arquivo\)/g) ?? []).length, 2);
    assert.match(diarioFonte, /function removerTrava\(arquivo, sistema\) \{\s*try \{ sistema\.unlinkSync\(arquivo\);/);
    assert.equal(/armazenamento-imagens|janela-escrita-imagens/.test(diarioFonte), false);
    // a área exclusiva do processador: UMA remoção, de `area.caminho` (o diretório que o próprio módulo criou), depois da conferência por lstat; sem tocar o armazenamento de imagens nem a janela
    const areaFonte = fs.readFileSync(path.join(src, 'services', 'imagem-processador-area.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal((areaFonte.match(/\b(unlink|unlinkSync|rmSync|rmdirSync|rmdir)\(|\bfsp\.rm\(|\.rm\(/g) ?? []).length, 1, 'uma única remoção na área exclusiva');
    assert.match(areaFonte, /fs\.rmSync\(area\.caminho, \{ recursive: true, force: true/);
    assert.ok(areaFonte.indexOf('fs.lstatSync(area.caminho)') < areaFonte.indexOf('fs.rmSync(area.caminho'), 'a conferência de identidade vem antes da remoção');
    assert.match(areaFonte, /!== area\.dev \|\| [^\n]*!== area\.ino \|\| [^\n]*!== area\.uid\) return resultado\(false, 'TROCADA'\)/);
    assert.equal(/armazenamento-imagens|janela-escrita-imagens|imagem-backup/.test(areaFonte), false);
    for (const p of lista) if (!p.endsWith('imagem-processador.service.js') && !p.endsWith('imagem-processador-area.service.js')) assert.equal(/imagem-processador-area\.service/.test(fs.readFileSync(p, 'utf8')), false, `${path.relative(src, p)} importa a área exclusiva`);

    const usam = lista.filter((p) => /require\([^)]*storage\/armazenamento-imagens'\)/.test(fs.readFileSync(p, 'utf8')) && !p.endsWith('storage/armazenamento-imagens.js'));
    for (const p of usam) {
      const fonte = fs.readFileSync(p, 'utf8');
      const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(/\.(remover|removerVariantes)\(/.test(semComentarios), false, `${path.relative(src, p)} chama remoção do armazenamento de imagens por método`);
      assert.equal(/\{[^}]*\bremover(Variantes)?\b[^}]*\}\s*=\s*require\([^)]*armazenamento-imagens/.test(semComentarios), false, `${path.relative(src, p)} importa a remoção do armazenamento de imagens`);
    }
    for (const p of lista) {
      if (p.endsWith('storage/armazenamento-imagens.js')) continue;
      assert.equal(/\.removerVariantes\(/.test(fs.readFileSync(p, 'utf8')), false, `${path.relative(src, p)} chama removerVariantes`);
    }
    const limpeza = fs.readFileSync(path.join(src, 'services', 'imagem-armazenamento-limpeza.service.js'), 'utf8');
    assert.match(limpeza, /janelaDeEscrita\.adquirirJanela\(/);
    assert.match(limpeza, /janelaDeEscrita\.TIPOS\.LIMPEZA/);
    const coordenador = fs.readFileSync(path.join(src, 'services', 'imagem-backup.service.js'), 'utf8');
    assert.match(coordenador, /TIPOS\.BACKUP/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MC-R: relatório operacional e proveniência
describe('[MC-R] relatório operacional: sem proveniência não há publicação operacional; TESTE_CONTROLADO não libera publicação operacional', () => {
  teste('MC-R01 — produtor de TESTE_CONTROLADO: a publicação de teste ocorre e é marcada `publicacaoOperacional:false`; com um publicador que só aceita OPERACIONAL (padrão) a MESMA decisão é recusada', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true });
    assert.equal(r.publicacao.publicada, true);
    assert.equal(r.publicacao.origemDoRelatorio, 'TESTE_CONTROLADO');
    assert.equal(r.publicacao.publicacaoOperacional, false);

    const n = await mundo();
    const padrao = criarPublicador({ raizDoDestino: n.destino, produtorDeRelatorio: n.produtor() });
    const { r: rn } = await completo(n, { pub: padrao });
    assert.equal(rn.publicacao.publicada, false);
    assert.equal(rn.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    assert.equal(fs.readdirSync(n.destino).length, 0);
    assert.equal(fs.existsSync(path.join(n.pai, 'prep-1')), true);
  });

  teste('MC-R02 — OPERACIONAL não é aceita porque o chamador informou o texto: a fábrica de produtor recusa a origem OPERACIONAL e qualquer outra; produtor literal e decisão literal não são reconhecidos', async () => {
    const m = await mundo();
    assert.equal(process.env.NODE_ENV, 'test', 'estas recusas valem COM NODE_ENV=test: o ambiente de teste não relaxa nem libera a origem OPERACIONAL');
    for (const origem of ['OPERACIONAL', 'PRODUCAO', '', undefined, 1]) assert.throws(() => criarProdutorDeRelatorio({ origem, decidir: () => ({ ok: true }) }), TypeError, String(origem));
    assert.throws(() => criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: 1 }), TypeError);
    assert.throws(() => criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({}), extra: 1 }), TypeError);
    assert.throws(() => criarPublicador({ raizDoDestino: m.destino, produtorDeRelatorio: async () => ({ ok: true, origem: 'OPERACIONAL' }), origensAceitas: ['OPERACIONAL'] }), TypeError);
    // decisão literal devolvida por um produtor reconhecido que viola o contrato: o produtor reconhecido sempre devolve a PRÓPRIA decisão (a literal do `decidir` é só insumo)
    const { r, publicador } = await completo(m, { publicar: true, publicadorExtras: { origensAceitas: ['OPERACIONAL'] } });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    assert.ok(publicador);
  });

  teste('MC-R03 — `TESTE_CONTROLADO` só pode ser criada com NODE_ENV=test (lido na chamada): fora dele a fábrica recusa', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), TypeError);
      process.env.NODE_ENV = 'development';
      assert.throws(() => criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), TypeError);
    } finally { process.env.NODE_ENV = original; }
    assert.equal(typeof criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), 'function');
  });

  teste('MC-R04 — um `relatorio.veredito` literal não libera nada: o publicador não tem parâmetro para relatório (chave extra é recusada) e o avaliador, com correlação, nunca é válido', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true, publicadorExtras: { produtorDeRelatorio: m.produtor(() => ({ ok: false })) } });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.motivo, 'RELATORIO_SEM_PROVENIENCIA');
    const publicador = m.publicador();
    await assert.rejects(Promise.resolve().then(() => publicador.publicar({ preparacao: path.join(m.pai, 'prep-1'), nomeFinal: 'x', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia, relatorio: { veredito: 'VALIDO' } })), TypeError);
    const av = avaliarConjunto({ saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true }, dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') }, identidade: { conjuntoId: 'x', sha256Manifesto: H('b') }, relatorio: { veredito: 'VALIDO' }, correlacao: r.correlacao });
    assert.equal(av.valido, false);
    assert.equal(av.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MC-U: publicação atômica e durável
describe('[MC-U] publicação atômica e durável (preparação técnica; nenhuma publicação operacional)', () => {
  teste('MC-U01 — caminho positivo (TESTE_CONTROLADO): o pacote é movido por rename atômico para o destino; a preparação deixa de existir; o destino é íntegro e idêntico ao verificado; fsync de arquivos e diretórios ANTES do rename e do diretório de destino DEPOIS', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true, ops: m.ops() });
    assert.equal(r.publicacao.publicada, true);
    assert.equal(r.publicacao.estado, 'PUBLICADA');
    assert.equal(r.publicacao.nome, 'prep-1');
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1')), false, 'a preparação foi movida (rename), não copiada');
    assert.deepEqual(fs.readdirSync(m.destino), ['prep-1']);
    const final = path.join(m.destino, 'prep-1');
    assert.deepEqual(fs.readdirSync(final).sort(), ['dump', 'imagens', 'manifesto.json', 'manifesto.sha256']);
    const v = await criarServicoDePacote().verificarPacote({ preparacao: final, manifesto: r.composicao.manifesto, identidade: r.composicao.identidade });
    assert.equal(v.ok, true, 'o pacote publicado é íntegro');
    assert.equal(hashDe(path.join(final, 'dump', 'postgres.dump')), sha(DUMP_BYTES));
    const e = m.eventos;
    const iRename = e.indexOf('rename');
    assert.ok(iRename > 0);
    const dirsDoPacote = e.map((x, i) => [x, i]).filter(([x]) => x.startsWith('fsync:dir:preparacoes/prep-1'));
    assert.ok(dirsDoPacote.length >= 3, 'imagens, dump e a raiz do pacote');
    for (const [, i] of dirsDoPacote) assert.ok(i < iRename, 'fsync dos diretórios do pacote antes do rename');
    assert.ok(e.slice(0, iRename).includes('fsync:arquivo'));
    assert.equal(e[e.length - 1], 'fsync:dir:publicados', 'fsync do diretório de destino depois do rename');
    assert.ok(e.lastIndexOf('fsync:dir:publicados') > iRename);
    assert.equal(r.publicacao.publicacaoOperacional, false);
    assert.equal(r.coordenador.valido, false, 'publicar não torna o backup operacionalmente válido');
    assert.equal(r.coordenador.recuperavel, false);
    semVazamento(r.publicacao, m);
  });

  teste('MC-U02 — portas: cada ausência/divergência impede a publicação sem alterar nada (T2 divergente, estrutura não verificada, consistência de outra operação, pacote de outro conjunto, evidências literais)', async () => {
    const m = await mundo();
    const { r } = await completo(m, { pub: m.publicador({ produtorDeRelatorio: m.produtor(() => ({ ok: false })) }) }); // prepara evidências sem publicar
    const prep = path.join(m.pai, 'prep-1');
    const pub = m.publicador();
    const base = { preparacao: prep, nomeFinal: 'prep-1', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia };
    const antes = instantaneo(m.raiz);
    const recusas = [
      ['correlação literal', { correlacao: { ...r.correlacao } }, 'CORRELACAO_NAO_RECONHECIDA'],
      ['pacote literal', { pacote: { ...r.pacote.verificacao } }, 'PACOTE_NAO_VERIFICADO'],
      ['consistência literal', { consistencia: { ...r.pacote.consistencia } }, 'CONSISTENCIA_NAO_DEMONSTRADA'],
      ['consistência não demonstrada', { consistencia: criarServicoDePacote().avaliarConsistencia({ operacaoId: r.correlacao.snapshot.operacaoId, itensDoPlano: 99, composicao: r.composicao, verificacao: r.verificacao }) }, 'CONSISTENCIA_NAO_DEMONSTRADA'],
      ['consistência de OUTRA operação', { consistencia: criarServicoDePacote().avaliarConsistencia({ operacaoId: 'outra-operacao', itensDoPlano: r.composicao.arquivos, composicao: r.composicao, verificacao: r.verificacao }) }, 'CONSISTENCIA_NAO_DEMONSTRADA'],
    ];
    for (const [rotulo, extra, motivo] of recusas) {
      const res = await pub.publicar({ ...base, ...extra });
      assert.equal(res.publicada, false, rotulo);
      assert.equal(res.estado, 'NADA_PUBLICADO', rotulo);
      assert.equal(res.motivo, motivo, rotulo);
    }
    // correlação sem estrutura verificada
    const n = await mundo();
    const { r: rn } = await completo(n, { estrutural: 'saida1', pub: n.publicador({ produtorDeRelatorio: n.produtor(() => ({ ok: false })) }) });
    const semEstrutura = await n.publicador().publicar({ preparacao: path.join(n.pai, 'prep-1'), nomeFinal: 'prep-1', correlacao: rn.correlacao, pacote: rn.pacote.verificacao, consistencia: rn.pacote.consistencia });
    assert.equal(semEstrutura.motivo, 'ESTRUTURA_NAO_VERIFICADA');
    // correlação com T2 divergente
    const t = await mundo({ aoDeclarar: (c) => fs.appendFileSync(c, 'x') });
    const { r: rt } = await completo(t);
    assert.equal(rt.correlacao.dump.t2.ok, false);
    const divergente = await t.publicador().publicar({ preparacao: path.join(t.pai, 'prep-1'), nomeFinal: 'prep-1', correlacao: rt.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia });
    assert.equal(divergente.motivo, 'CORRELACAO_NAO_SATISFEITA');
    assert.deepEqual(instantaneo(m.raiz), antes, 'nada mudou em disco');
    assert.equal(fs.readdirSync(m.destino).length, 0);
  });

  teste('MC-U03 — adulteração DEPOIS da primeira verificação (imagem, dump, manifesto, selo ou arquivo extra) é pega pela nova verificação do que foi persistido: nada é publicado', async () => {
    const adulteracoes = [
      ['imagem', (p, r) => fs.appendFileSync(path.join(p, 'imagens', ...r.composicao.manifesto.arquivos[0].chave.split('/')), 'x')],
      ['dump', (p) => fs.appendFileSync(path.join(p, 'dump', 'postgres.dump'), 'x')],
      ['manifesto', (p) => fs.appendFileSync(path.join(p, 'manifesto.json'), ' ')],
      ['selo', (p) => fs.writeFileSync(path.join(p, 'manifesto.sha256'), `${H('e')}  manifesto.json\n`)],
      ['arquivo extra', (p) => fs.writeFileSync(path.join(p, 'extra.bin'), 'x')],
    ];
    for (const [rotulo, adulterar] of adulteracoes) {
      const m = await mundo();
      const { r } = await completo(m, { pub: m.publicador({ produtorDeRelatorio: m.produtor(() => ({ ok: false })) }) });
      const prep = path.join(m.pai, 'prep-1');
      adulterar(prep, r);
      const res = await m.publicador().publicar({ preparacao: prep, nomeFinal: 'prep-1', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia });
      assert.equal(res.publicada, false, rotulo);
      assert.match(res.motivo, /^(MANIFESTO_ADULTERADO|PACOTE_)/, rotulo);
      assert.equal(fs.readdirSync(m.destino).length, 0, rotulo);
      assert.equal(fs.existsSync(prep), true, `${rotulo}: preparação preservada`);
    }
  });

  teste('MC-U04 — colisão do destino: nome final já existente (arquivo, diretório vazio ou com conteúdo) é recusado; o que existia fica intacto e a preparação é preservada', async () => {
    for (const [rotulo, preparar] of [['diretório com conteúdo', (d) => { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'anterior.txt'), 'conteudo-anterior'); }], ['diretório vazio', (d) => fs.mkdirSync(d)], ['arquivo', (d) => fs.writeFileSync(d, 'arquivo-anterior')]]) {
      const m = await mundo();
      const final = path.join(m.destino, 'prep-1');
      preparar(final);
      const antes = instantaneo(m.destino);
      const { r } = await completo(m, { publicar: true, ops: m.ops() });
      assert.equal(r.publicacao.publicada, false, rotulo);
      assert.equal(r.publicacao.motivo, 'COLISAO_DO_DESTINO', rotulo);
      assert.deepEqual(instantaneo(m.destino), antes, `${rotulo}: destino intacto`);
      assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'manifesto.json')), true, `${rotulo}: preparação preservada`);
      assert.equal(m.eventos.includes('rename'), false, `${rotulo}: nenhum rename tentado`);
    }
  });

  teste('MC-U05 — falha de FSYNC de arquivo ao persistir: nada publicado, destino sem entrada, preparação preservada', async () => {
    const m = await mundo();
    let chamadas = 0;
    const falhas = { fsyncArquivo: false };
    const base = m.ops(falhas);
    // as primeiras chamadas de fsync de arquivo pertencem à incorporação do dump; a falha é armada depois dela
    const ops = { ...base, fsyncArquivo: async (h) => { chamadas += 1; if (chamadas > 1) throw new Error(SEGREDO); return h.sync(); } };
    const { r } = await completo(m, { publicar: true, ops });
    assert.equal(r.pacote.ok, true);
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.motivo, 'PERSISTENCIA_FSYNC_FALHOU');
    assert.equal(fs.readdirSync(m.destino).length, 0);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1')), true);
    semVazamento(r, m);
  });

  teste('MC-U06 — falha de FSYNC de DIRETÓRIO do pacote ao persistir: nada publicado', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true, ops: m.ops({ fsyncDiretorio: (p) => p.includes('/preparacoes/prep-1') }) });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.motivo, 'PERSISTENCIA_FSYNC_FALHOU');
    assert.equal(fs.readdirSync(m.destino).length, 0);
    assert.equal(m.eventos.includes('rename'), false);
  });

  teste('MC-U07 — falha de RENAME: nada publicado; a reserva VAZIA criada pelo publicador é removida; a preparação e qualquer pacote anterior ficam intactos', async () => {
    const m = await mundo();
    const anterior = await completo(m, { publicar: true, nome: 'prep-anterior', ops: m.ops() });
    assert.equal(anterior.r.publicacao.publicada, true);
    const fotografia = instantaneo(path.join(m.destino, 'prep-anterior'));
    const { r } = await completo(m, { publicar: true, nome: 'prep-2', ops: m.ops({ rename: () => true }) });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.estado, 'NADA_PUBLICADO');
    assert.equal(r.publicacao.motivo, 'RENAME_FALHOU');
    assert.equal(r.publicacao.reserva, 'REMOVIDA');
    assert.deepEqual(fs.readdirSync(m.destino), ['prep-anterior'], 'nenhuma entrada parcial do pacote novo');
    assert.deepEqual(instantaneo(path.join(m.destino, 'prep-anterior')), fotografia, 'pacote anterior preservado byte a byte');
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-2', 'manifesto.json')), true);
    semVazamento(r, m);
  });

  teste('MC-U08 — falha de FSYNC do diretório de destino DEPOIS do rename: a publicação NÃO é declarada; o rename é revertido (REVERTIDA) e o destino volta a não ter o pacote; se a reversão também falhar, o estado é INCERTA e nada é apagado', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true, ops: m.ops({ fsyncDiretorio: (p) => p === m.destino }) });
    assert.equal(r.publicacao.publicada, false);
    assert.equal(r.publicacao.estado, 'REVERTIDA');
    assert.equal(r.publicacao.motivo, 'FSYNC_DO_DESTINO_FALHOU');
    assert.equal(fs.existsSync(path.join(m.destino, 'prep-1')), false);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'manifesto.json')), true, 'preparação de volta');

    const n = await mundo();
    let renames = 0;
    const { r: rn } = await completo(n, { publicar: true, ops: n.ops({ fsyncDiretorio: (p) => p === n.destino, rename: () => { renames += 1; return renames > 1; } }) });
    assert.equal(rn.publicacao.publicada, false);
    assert.equal(rn.publicacao.estado, 'INCERTA');
    assert.equal(fs.existsSync(path.join(n.destino, 'prep-1', 'manifesto.json')), true, 'nada foi apagado: o pacote segue no destino, estado incerto declarado');
  });

  teste('MC-U09 — destino inválido ou não isolado: raiz inexistente, raiz igual ao pai da preparação e raiz dentro da preparação são recusadas antes de qualquer fsync/rename', async () => {
    const m = await mundo();
    const prepararEvidencias = await completo(m, { pub: m.publicador({ produtorDeRelatorio: m.produtor(() => ({ ok: false })) }) });
    const { r } = prepararEvidencias;
    const base = { preparacao: path.join(m.pai, 'prep-1'), nomeFinal: 'prep-1', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia };
    const casos = [
      ['raiz inexistente', path.join(m.raiz, 'nao-existe'), 'DESTINO_INVALIDO'],
      ['raiz igual ao pai da preparação', m.pai, 'DESTINO_NAO_ISOLADO'],
      ['raiz dentro da preparação', path.join(m.pai, 'prep-1', 'imagens'), 'DESTINO_NAO_ISOLADO'],
    ];
    for (const [rotulo, raizDoDestino, motivo] of casos) {
      const eventos = [];
      const pub = criarPublicador({ raizDoDestino, produtorDeRelatorio: m.produtor(), origensAceitas: ['TESTE_CONTROLADO'], ops: { rename: async () => { eventos.push('rename'); }, fsyncDiretorio: async () => { eventos.push('fsync'); } } });
      const res = await pub.publicar(base);
      assert.equal(res.publicada, false, rotulo);
      assert.equal(res.motivo, motivo, rotulo);
      assert.deepEqual(eventos, [], `${rotulo}: nenhum efeito`);
    }
    await assert.rejects(Promise.resolve().then(() => m.publicador().publicar({ ...base, nomeFinal: '../fora' })), TypeError);
    await assert.rejects(Promise.resolve().then(() => m.publicador().publicar({ ...base, preparacao: 'relativo' })), TypeError);
  });

  teste('MC-U10 — o pacote anterior nunca é tocado por uma publicação nova bem-sucedida de OUTRO nome, e a segunda tentativa com o MESMO nome é colisão', async () => {
    const m = await mundo();
    const a = await completo(m, { publicar: true, nome: 'prep-a', ops: m.ops() });
    assert.equal(a.r.publicacao.publicada, true);
    const fotografiaA = instantaneo(path.join(m.destino, 'prep-a'));
    const b = await completo(m, { publicar: true, nome: 'prep-b', ops: m.ops() });
    assert.equal(b.r.publicacao.publicada, true);
    assert.deepEqual(fs.readdirSync(m.destino).sort(), ['prep-a', 'prep-b']);
    assert.deepEqual(instantaneo(path.join(m.destino, 'prep-a')), fotografiaA, 'o pacote anterior segue byte a byte igual');
    // O pacote anterior também sobrevive a uma publicação posterior que FALHA (rename recusado).
    const c = await completo(m, { publicar: true, nome: 'prep-c', ops: m.ops({ rename: () => true }) });
    assert.equal(c.r.publicacao.publicada, false);
    assert.deepEqual(fs.readdirSync(m.destino).sort(), ['prep-a', 'prep-b']);
    assert.deepEqual(instantaneo(path.join(m.destino, 'prep-a')), fotografiaA);
  });

  teste('MC-U11 — FÍSICO: a preparação e o destino ficam no MESMO sistema de arquivos; o fsync cobre CADA arquivo do pacote; `rename` entre sistemas de arquivos (EXDEV) é recusado sem publicar e sem apagar', async () => {
    const m = await mundo();
    const { r } = await completo(m, { publicar: true, ops: m.ops() });
    assert.equal(r.publicacao.publicada, true);
    const arquivosDoPacote = r.pacote.verificacao.arquivos;
    assert.ok(m.eventos.filter((e) => e === 'fsync:arquivo').length >= arquivosDoPacote, `fsync de todos os ${arquivosDoPacote} arquivos do pacote`);

    const n = await mundo();
    const { r: rn } = await completo(n, {});
    const prep = path.join(n.pai, 'prep-1');
    assert.equal(fs.statSync(prep).dev, fs.statSync(n.destino).dev, 'mesmo sistema de arquivos');
    const foto = instantaneo(prep);
    const exdev = n.publicador({ ops: { rename: async () => { throw Object.assign(new Error(SEGREDO), { code: 'EXDEV' }); } } });
    const res = await exdev.publicar({ preparacao: prep, nomeFinal: 'prep-1', correlacao: rn.correlacao, pacote: rn.pacote.verificacao, consistencia: rn.pacote.consistencia });
    assert.equal(res.publicada, false);
    assert.equal(res.motivo, 'RENAME_FALHOU');
    assert.equal(res.reserva, 'REMOVIDA');
    assert.deepEqual(instantaneo(prep), foto, 'nada foi apagado nem alterado');
    assert.equal(fs.readdirSync(n.destino).length, 0);
    semVazamento(res, n);
  });

  teste('MC-U12 — FÍSICO: nenhuma falha de fsync, de rename ou de fsync do destino APAGA ou ALTERA o pacote preparado, o dump original ou a origem das imagens (sem limpeza destrutiva automática)', async () => {
    const m = await mundo();
    const { r } = await completo(m);
    const prep = path.join(m.pai, 'prep-1');
    const base = { preparacao: prep, nomeFinal: 'prep-1', correlacao: r.correlacao, pacote: r.pacote.verificacao, consistencia: r.pacote.consistencia };
    const fotos = { prep: instantaneo(prep), origem: instantaneo(m.dirOrigem), dumps: instantaneo(m.dumps) };
    const variacoes = [
      ['fsync de arquivo', { fsyncArquivo: true }, { publicada: false, motivo: 'PERSISTENCIA_FSYNC_FALHOU' }],
      ['fsync de diretório do pacote', { fsyncDiretorio: (p) => p.includes('/preparacoes/prep-1') }, { publicada: false, motivo: 'PERSISTENCIA_FSYNC_FALHOU' }],
      ['rename', { rename: () => true }, { publicada: false, motivo: 'RENAME_FALHOU' }],
      ['fsync do destino (rename revertido)', { fsyncDiretorio: (p) => p === m.destino }, { publicada: false, estado: 'REVERTIDA' }],
    ];
    for (const [rotulo, falhas, esperado] of variacoes) {
      const res = await m.publicador({ ops: m.ops(falhas) }).publicar(base);
      for (const [campo, valor] of Object.entries(esperado)) assert.equal(res[campo], valor, `${rotulo}: ${campo}`);
      assert.deepEqual(instantaneo(prep), fotos.prep, `${rotulo}: pacote preparado intacto`);
      assert.deepEqual(instantaneo(m.dirOrigem), fotos.origem, `${rotulo}: origem intacta`);
      assert.deepEqual(instantaneo(m.dumps), fotos.dumps, `${rotulo}: dump original intacto`);
      assert.deepEqual(fs.readdirSync(m.destino), [], `${rotulo}: nenhuma entrada parcial no destino`);
    }
    // e a mesma preparação, depois de todas as falhas, ainda pode ser publicada normalmente (nada ficou preso nem foi consumido)
    const final = await m.publicador({ ops: m.ops() }).publicar(base);
    assert.equal(final.publicada, true);
    assert.deepEqual(fs.readdirSync(m.destino), ['prep-1']);
  });
});
