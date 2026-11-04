'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarProcessoDoDump } = require('../../src/services/imagem-backup-pgdump.service');
const { avaliarConjunto } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-EVIDENCIA-DUMP-1): OBSERVADOR/PRODUTOR de EVIDÊNCIA FÍSICA do arquivo de dump. Só `fs` e `crypto` reais sobre arquivos temporários
 * FICTÍCIOS (prefixo `gepi-evidencia-test-`); o `pg_dump` é um double que apenas escreve bytes no descritor recebido e cujos eventos (saída e fluxos) são promessas controladas pelo teste. Nenhum
 * processo é iniciado, nenhum PostgreSQL é tocado e nada aqui prova pg_dump real, integridade operacional, autenticidade, publicação ou restauração.
 *
 * CONTRATOS REAIS CONFIRMADOS (CTL-03 executa): `criarProcessoDoDump({ contexto, dump }).iniciar()` chama `dump.arquivos.criarExclusivo({ diretorio, nome, modo, semSeguirLinks })` (com `this` = `arquivos`),
 * que devolve `{ descritor, fechar }`, e depois `dump.lancador.lancar(spec)` (com `this` = `lancador`), que devolve `{ pid, saida, fluxosFechados }` (promessas); o descritor é passado ao processo em
 * `spec.opcoes.stdio[1]` e fechado pelo serviço quando os FLUXOS fecham. Ambas as dependências são INJETADAS pelo chamador, então um observador do chamador pode envolvê-las SEM alterar nenhum contrato:
 * ele vê o `diretorio`/`nome` e o `descritor` (portanto `fstat` => dev/ino) na criação exclusiva, e o `saida`/`fluxosFechados` brutos do lançador. O que ele NÃO enxerga: o veredito do supervisor
 * (`concluido`, `liberarTravaPermitido`, grupo vazio), que só existe no resultado final do executor.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nada em produção): src/services/imagem-backup-evidencia-dump.service.js exporta `criarObservadorDoDump({ arquivos, lancador })` -> congelado
 * { arquivos, lancador, evidencia }, instância POR OPERAÇÃO:
 *   - `arquivos` e `lancador` são envoltórios que DELEGAM sem alterar nada (mesmo `this` e mesmos argumentos, métodos capturados uma vez, erros repassados por identidade) e só registram o que viram;
 *   - `evidencia()` (assíncrona, NÃO espera nada: recusa se a hora ainda não chegou) devolve congelado { ok: true, bytes, sha256Calculado } ou { ok: false, motivo } com motivo FIXO:
 *     NAO_OBSERVADO | PROCESSO_EM_ANDAMENTO | FLUXOS_ABERTOS | SAIDA_NAO_ZERO | ARQUIVO_INVALIDO | IDENTIDADE_DIVERGENTE | ARQUIVO_VAZIO | ARQUIVO_INSTAVEL | LEITURA_FALHOU | JA_CONSUMIDA;
 *   - só produz resultado com: criação exclusiva e lançamento observados; `saida` resolvida com código 0 e sinal nulo; `fluxosFechados` resolvida; arquivo aberto por caminho com O_RDONLY|O_NOFOLLOW,
 *     `fstat` do descritor com dev/ino iguais aos da criação, regular e não vazio; linha de base (ino/tamanho/mtime/ctime) capturada ao fechar os fluxos e conferida de novo depois da leitura;
 *     bytes lidos DO MESMO descritor e SHA-256 calculado sobre eles; descritor próprio sempre fechado; uso único;
 *   - o resultado NÃO traz `sha256Declarado`, `sha256Recalculado` nem `concluido` (REGRA DOS DOIS HASHES): o `pg_dump` escreve direto no descritor, nada passa pelo Node, então NÃO existe fonte
 *     independente de "hash declarado"; duas leituras do mesmo arquivo seriam o mesmo dado lido duas vezes. O avaliador não distingue (CTL-02), por isso o produtor não o fabrica: sem uma fonte real
 *     (tap em pipe, D9; `pg_restore --list`; outro procedimento), o mapeamento para o `dump` do avaliador permanece impossível e o avaliador falha de forma conservadora.
 *   - nada aqui libera trava, finaliza snapshot, declara `concluido` do dump, `valido`, `recuperavel` ou publicado.
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-evidencia-dump.service';
const observadorModulo = () => exigirModulo(MODULO);
const PRAZO = 20000;
const PREFIXO = 'gepi-evidencia-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const NOME_DO_DUMP = 'dump-ficticio.custom';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BYTES = Buffer.from('conteudo-ficticio-do-dump-0123456789'.repeat(200));

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura de teste
const pastas = [];
const operacoes = [];
function deferido() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((res, rej) => { resolver = res; rejeitar = rej; });
  promessa.catch(() => {});
  return { promessa, resolver, rejeitar };
}
after(() => {
  // Nenhuma promessa fica pendente depois da suíte e nenhum descritor de teste fica aberto.
  for (const op of operacoes) {
    op.dSaida.resolver({ codigo: 0, sinal: null });
    op.dFluxos.resolver();
    try { if (op.criado) op.criado.fechar(); } catch { /* já fechado */ }
  }
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of pastas) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});

const contextoFicticio = () => Object.freeze({ snapshotId: '00000003-0000001B-1', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros: Object.freeze({}), plano: Object.freeze([]) });

/** Double do `arquivos.criarExclusivo` do sistema: cria o arquivo de forma exclusiva e sem seguir link e devolve { descritor, fechar }, como o contrato real. */
function criarArquivosReais(op) {
  const objeto = {
    criarExclusivo(spec) {
      objeto.ultimoThis = this;
      objeto.ultimoSpec = spec;
      const descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      const criado = { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
      op.criado = criado;
      return criado;
    },
  };
  return objeto;
}

/** Double do lançador: NÃO executa processo algum; devolve promessas controladas e guarda o descritor para o teste "escrever como o pg_dump". */
function criarLancadorFalso(op) {
  const objeto = {
    lancar(spec) {
      objeto.ultimoThis = this;
      op.descritorDoDump = spec.opcoes.stdio[1];
      return { pid: 4242, saida: op.dSaida.promessa, fluxosFechados: op.dFluxos.promessa };
    },
  };
  return objeto;
}

function configuracaoDoDump(diretorio, arquivos, lancador) {
  return {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    destino: { diretorio, nome: NOME_DO_DUMP },
    lancador,
    sistema: { grupoVivo: async () => true, enviarSinal: async () => false },
    arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) },
    prazos: { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 },
  };
}

/** Operação fictícia: diretório próprio, dump dirigido por `criarProcessoDoDump` REAL, `pg_dump` substituído por double. `observar:false` monta a mesma operação sem o observador (controles). */
async function operacao({ observar = true } = {}) {
  const diretorio = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(diretorio, 0o700);
  pastas.push(diretorio);
  const op = { diretorio, caminho: path.join(diretorio, NOME_DO_DUMP), dSaida: deferido(), dFluxos: deferido(), criado: null, descritorDoDump: null };
  op.arquivos = criarArquivosReais(op);
  op.lancador = criarLancadorFalso(op);
  operacoes.push(op);
  op.observador = observar ? observadorModulo().criarObservadorDoDump({ arquivos: op.arquivos, lancador: op.lancador }) : null;
  const dump = configuracaoDoDump(diretorio, observar ? op.observador.arquivos : op.arquivos, observar ? op.observador.lancador : op.lancador);
  op.processo = criarProcessoDoDump({ contexto: contextoFicticio(), dump });
  op.iniciado = await op.processo.iniciar();
  op.escreverComoODump = (bytes) => fs.writeSync(op.descritorDoDump, bytes);
  op.encerrarSaida = async ({ codigo = 0, sinal = null } = {}) => { op.dSaida.resolver({ codigo, sinal }); await op.iniciado.saida; };
  op.fecharFluxos = async () => { op.dFluxos.resolver(); await op.iniciado.fluxosFechados; };
  op.encerrar = async (termino) => { await op.encerrarSaida(termino); await op.fecharFluxos(); };
  return op;
}

const falhaCom = async (op, motivo) => {
  const r = await op.observador.evidencia();
  assert.equal(r.ok, false);
  assert.equal(r.motivo, motivo);
  assert.deepEqual(Object.keys(r).sort(), ['motivo', 'ok']);
  assert.equal(Object.isFrozen(r), true);
  const texto = JSON.stringify(r);
  for (const proibido of [op.diretorio, os.tmpdir(), PREFIXO, NOME_DO_DUMP, SEGREDO]) assert.equal(texto.includes(proibido), false, proibido);
  return r;
};

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o que os contratos e o sistema de arquivos realmente garantem', () => {
  teste('CTL-01 — identidade (dev/ino) é do INODE, não do caminho: substituir o arquivo por outro com o MESMO conteúdo muda o ino; o `fstat` do descritor aberto continua apontando para o original; e a identidade não prova imutabilidade do conteúdo (escrever no mesmo inode mantém o ino)', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
    pastas.push(dir);
    const alvo = path.join(dir, 'a');
    fs.writeFileSync(alvo, BYTES);
    const fd = fs.openSync(alvo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const original = fs.fstatSync(fd);
    const novo = path.join(dir, 'novo');
    fs.writeFileSync(novo, BYTES);
    fs.renameSync(novo, alvo);
    const porCaminho = fs.statSync(alvo);
    assert.notEqual(porCaminho.ino, original.ino);
    assert.equal(fs.fstatSync(fd).ino, original.ino);
    fs.closeSync(fd);
    const fdEscrita = fs.openSync(alvo, fs.constants.O_WRONLY);
    const antes = fs.fstatSync(fdEscrita).ino;
    fs.writeSync(fdEscrita, Buffer.from('X'), 0, 1, 0);
    assert.equal(fs.fstatSync(fdEscrita).ino, antes, 'o mesmo inode pode ter o conteúdo alterado: identidade != imutabilidade');
    fs.closeSync(fdEscrita);
    assert.throws(() => { const l = path.join(dir, 'link'); fs.symlinkSync(alvo, l); fs.openSync(l, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }, (e) => e.code === 'ELOOP');
  });

  teste('CTL-02 — o avaliador NÃO distingue um "hash declarado" copiado do calculado: com declarado igual ao recalculado ele aceita o dump (não é prova de nada); com declarado ausente ele falha de forma conservadora (DUMP_INVALIDO). Por isso o produtor não fabrica o campo', () => {
    const calculado = sha(BYTES);
    const base = { saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true }, identidade: { conjuntoId: 'conjunto-x', sha256Manifesto: sha('m') } };
    const autoDeclarado = avaliarConjunto({ ...base, dump: { concluido: true, bytes: BYTES.length, sha256Declarado: calculado, sha256Recalculado: calculado } });
    assert.equal(autoDeclarado.motivos.some((m) => m.startsWith('DUMP_')), false, 'o avaliador aceita a auto-declaração: ela não prova independência');
    const semDeclarado = avaliarConjunto({ ...base, dump: { concluido: true, bytes: BYTES.length, sha256Declarado: null, sha256Recalculado: calculado } });
    assert.equal(semDeclarado.valido, false);
    assert.ok(semDeclarado.motivos.includes('DUMP_INVALIDO'));
  });

  teste('CTL-03 — contrato real do dump com doubles (sem o observador): `iniciar()` cria o arquivo por `criarExclusivo` (this = arquivos, spec com diretório e nome), passa o descritor em `stdio[1]`, lança com this = lançador e devolve { pgid, saida, fluxosFechados }; o serviço fecha o descritor só quando os FLUXOS fecham', async () => {
    const op = await operacao({ observar: false });
    assert.equal(op.arquivos.ultimoThis, op.arquivos);
    assert.equal(op.arquivos.ultimoSpec.diretorio, op.diretorio);
    assert.equal(op.arquivos.ultimoSpec.nome, NOME_DO_DUMP);
    assert.equal(op.lancador.ultimoThis, op.lancador);
    assert.equal(op.iniciado.pgid, 4242);
    assert.equal(Number.isSafeInteger(op.descritorDoDump), true);
    assert.equal(op.escreverComoODump(BYTES), BYTES.length);
    await op.encerrarSaida();
    assert.doesNotThrow(() => fs.fstatSync(op.descritorDoDump), 'o descritor continua aberto depois da saída: só os fluxos o fecham');
    await op.fecharFluxos();
    assert.throws(() => fs.fstatSync(op.descritorDoDump), (e) => e.code === 'EBADF');
    assert.deepEqual(fs.readFileSync(op.caminho), BYTES);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- compatibilidade do observador
describe('[OBS] o observador envolve as dependências SEM alterar os contratos existentes', () => {
  teste('OBS-01 — o `criarProcessoDoDump` real aceita os envoltórios; o `this` e a `spec` chegam intactos aos originais; o resultado de `iniciar()` é o mesmo do controle; mudar o método original depois da criação não muda a delegação', async () => {
    const op = await operacao();
    assert.equal(op.arquivos.ultimoThis, op.arquivos);
    assert.equal(op.arquivos.ultimoSpec.nome, NOME_DO_DUMP);
    assert.equal(op.arquivos.ultimoSpec.semSeguirLinks, true);
    assert.equal(op.lancador.ultimoThis, op.lancador);
    assert.equal(op.iniciado.pgid, 4242);
    // Interface estendida de forma ADITIVA pelo E3' (`observar` = T1 enriquecida; `conferir` = T2): ainda nenhuma capacidade de liberar trava, finalizar snapshot ou declarar o dump concluído.
    assert.deepEqual(Object.keys(op.observador).sort(), ['abrirArtefato', 'arquivos', 'conferir', 'evidencia', 'lancador', 'observar']);
    assert.equal(Object.isFrozen(op.observador), true);
  });

  teste('OBS-02 — erros e retornos são repassados SEM alteração: o erro do original é rejeitado pela mesma identidade; o objeto criado volta idêntico; o observador não consome nem fecha o descritor do chamador', async () => {
    const erroOriginal = new TypeError(`${SEGREDO} /Users/privado`);
    const arquivos = { criarExclusivo: async () => { throw erroOriginal; } };
    const lancador = { lancar: async () => { throw erroOriginal; } };
    const obs = observadorModulo().criarObservadorDoDump({ arquivos, lancador });
    await assert.rejects(obs.arquivos.criarExclusivo({ diretorio: '/x', nome: 'y', modo: 0o600, semSeguirLinks: true }), (e) => e === erroOriginal);
    await assert.rejects(obs.lancador.lancar({ opcoes: { stdio: ['ignore', 3, 'ignore'] } }), (e) => e === erroOriginal);
    const r = await obs.evidencia();
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'NAO_OBSERVADO');
    assert.equal(JSON.stringify(r).includes(SEGREDO), false);
  });

  teste('OBS-03 — a criação do observador é ESTRITA e captura os métodos UMA vez: chaves desconhecidas, dependências sem função ou métodos trocados depois não mudam o comportamento', () => {
    const { criarObservadorDoDump } = observadorModulo();
    const ok = { arquivos: { criarExclusivo: () => ({}) }, lancador: { lancar: () => ({}) } };
    for (const ruim of [null, 'x', [], { arquivos: ok.arquivos }, { ...ok, extra: 1 }, { arquivos: {}, lancador: ok.lancador }, { arquivos: ok.arquivos, lancador: { lancar: 'x' } }]) {
      assert.throws(() => criarObservadorDoDump(ruim), TypeError);
    }
    let chamadas = 0;
    const arquivos = { criarExclusivo: () => { chamadas += 1; return { descritor: 3, fechar() {} }; } };
    const obs = criarObservadorDoDump({ arquivos, lancador: ok.lancador });
    arquivos.criarExclusivo = () => { throw new Error('trocado depois'); };
    obs.arquivos.criarExclusivo({ diretorio: '/x', nome: 'y' });
    assert.equal(chamadas, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- evidência física
describe('[EVD] evidência física: só depois da conclusão observada, sempre vinculada ao arquivo criado por ESTA operação', () => {
  teste('EVD-01 — operação completa: bytes e SHA-256 CALCULADOS sobre o arquivo real conferem com um cálculo independente do teste; o resultado não traz declarado, recalculado, concluído, caminho, validade nem recuperabilidade', async () => {
    const op = await operacao();
    op.escreverComoODump(BYTES);
    await op.encerrar();
    const r = await op.observador.evidencia();
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'ok', 'sha256Calculado']);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, BYTES.length);
    assert.equal(r.sha256Calculado, sha(BYTES));
    assert.equal(Object.isFrozen(r), true);
    const texto = JSON.stringify(r).toLowerCase();
    for (const proibido of [op.diretorio.toLowerCase(), NOME_DO_DUMP, 'declarado', 'recalculado', 'concluido', 'valido', 'recuper', 'publicad', 'restaur']) assert.equal(texto.includes(proibido), false, proibido);
  });

  teste('EVD-02 — MOMENTO: com o arquivo já completo, a evidência é recusada enquanto a saída não resolveu (PROCESSO_EM_ANDAMENTO) e enquanto os fluxos estão abertos (FLUXOS_ABERTOS); a recusa NÃO consome a evidência, que sai depois que as duas condições valem', async () => {
    const op = await operacao();
    op.escreverComoODump(BYTES);
    await falhaCom(op, 'PROCESSO_EM_ANDAMENTO');
    await op.encerrarSaida();
    await falhaCom(op, 'FLUXOS_ABERTOS');
    await op.fecharFluxos();
    const r = await op.observador.evidencia();
    assert.equal(r.ok, true);
    assert.equal(r.sha256Calculado, sha(BYTES));
  });

  teste('EVD-03 — código de saída diferente de zero, saída por sinal ou saída que REJEITA: SAIDA_NAO_ZERO, mesmo com o arquivo completo e os fluxos fechados', async () => {
    for (const termino of [{ codigo: 1, sinal: null }, { codigo: null, sinal: 'SIGKILL' }]) {
      const op = await operacao();
      op.escreverComoODump(BYTES);
      await op.encerrar(termino);
      await falhaCom(op, 'SAIDA_NAO_ZERO');
    }
    const op = await operacao();
    op.escreverComoODump(BYTES);
    op.dSaida.rejeitar(new Error(`${SEGREDO} /Users/privado`));
    await op.iniciado.saida.catch(() => {});
    await op.fecharFluxos();
    await falhaCom(op, 'SAIDA_NAO_ZERO');
  });

  teste('EVD-04 — arquivo VAZIO: ARQUIVO_VAZIO (bytes zero nunca viram evidência)', async () => {
    const op = await operacao();
    await op.encerrar();
    await falhaCom(op, 'ARQUIVO_VAZIO');
  });

  teste('EVD-05 — SUBSTITUIÇÃO por caminho: outro arquivo com o MESMO conteúdo e outro inode (rename por cima) é IDENTIDADE_DIVERGENTE; link simbólico no lugar é ARQUIVO_INVALIDO; o conteúdo do substituto nunca é aceito', async () => {
    const trocado = await operacao();
    trocado.escreverComoODump(BYTES);
    await trocado.encerrar();
    const novo = path.join(trocado.diretorio, 'substituto');
    fs.writeFileSync(novo, BYTES);
    fs.renameSync(novo, trocado.caminho);
    await falhaCom(trocado, 'IDENTIDADE_DIVERGENTE');

    const comLink = await operacao();
    comLink.escreverComoODump(BYTES);
    await comLink.encerrar();
    const alvo = path.join(comLink.diretorio, 'alvo-externo');
    fs.writeFileSync(alvo, BYTES);
    const link = path.join(comLink.diretorio, 'link');
    fs.symlinkSync(alvo, link);
    fs.renameSync(link, comLink.caminho);
    await falhaCom(comLink, 'ARQUIVO_INVALIDO');
  });

  teste('EVD-05b — a troca ANTES do fim dos fluxos (durante o dump) também é detectada: a identidade é comparada com a da CRIAÇÃO, não com a do que estiver no caminho na hora da leitura', async () => {
    const op = await operacao();
    op.escreverComoODump(BYTES);
    const novo = path.join(op.diretorio, 'substituto');
    fs.writeFileSync(novo, Buffer.from('outro-conteudo'));
    fs.renameSync(novo, op.caminho);
    await op.encerrar();
    await falhaCom(op, 'IDENTIDADE_DIVERGENTE');
  });

  teste('EVD-06 — MUDANÇA depois do fechamento dos fluxos (linha de base): arquivo que CRESCEU entre o fim do dump e a leitura é ARQUIVO_INSTAVEL; nenhum hash é entregue', async () => {
    const op = await operacao();
    op.escreverComoODump(BYTES);
    await op.encerrar();
    fs.appendFileSync(op.caminho, Buffer.from('bytes-extras'));
    await falhaCom(op, 'ARQUIVO_INSTAVEL');
  });

  teste('EVD-07 — OPERAÇÃO ERRADA: um observador que não viu criação nem lançamento é NAO_OBSERVADO; duas operações com arquivos diferentes dão evidências diferentes e cada observador só enxerga o próprio arquivo', async () => {
    const solto = observadorModulo().criarObservadorDoDump({ arquivos: { criarExclusivo: () => ({}) }, lancador: { lancar: () => ({}) } });
    const r = await solto.evidencia();
    assert.deepEqual({ ok: r.ok, motivo: r.motivo }, { ok: false, motivo: 'NAO_OBSERVADO' });

    const a = await operacao();
    const b = await operacao();
    a.escreverComoODump(Buffer.from('operacao-A'.repeat(50)));
    b.escreverComoODump(Buffer.from('operacao-B'.repeat(60)));
    await a.encerrar();
    await falhaCom(b, 'PROCESSO_EM_ANDAMENTO');
    await b.encerrar();
    const ra = await a.observador.evidencia();
    const rb = await b.observador.evidencia();
    assert.equal(ra.sha256Calculado, sha(Buffer.from('operacao-A'.repeat(50))));
    assert.equal(rb.sha256Calculado, sha(Buffer.from('operacao-B'.repeat(60))));
    assert.notEqual(ra.sha256Calculado, rb.sha256Calculado);
    assert.equal(ra.bytes, 500);
    assert.equal(rb.bytes, 600);
  });

  teste('EVD-08 — USO ÚNICO: depois de entregue, a evidência não é entregue de novo (JA_CONSUMIDA), nem para o mesmo arquivo inalterado', async () => {
    const op = await operacao();
    op.escreverComoODump(BYTES);
    await op.encerrar();
    assert.equal((await op.observador.evidencia()).ok, true);
    await falhaCom(op, 'JA_CONSUMIDA');
    await falhaCom(op, 'JA_CONSUMIDA');
  });

  teste('EVD-09 — dependências HOSTIS: descritor inválido devolvido por `criarExclusivo`, saída/fluxos que rejeitam e getters que lançam nunca fazem `evidencia()` lançar nem vazar mensagem; a falha é um motivo fixo', async () => {
    const hostil = () => new TypeError(`${SEGREDO} /Users/privado`);
    // descritor que não existe
    const dSaida = deferido();
    const dFluxos = deferido();
    const obs = observadorModulo().criarObservadorDoDump({
      arquivos: { criarExclusivo: () => ({ descritor: 987654, fechar() {} }) },
      lancador: { lancar: () => ({ pid: 4242, saida: dSaida.promessa, fluxosFechados: dFluxos.promessa }) },
    });
    await obs.arquivos.criarExclusivo({ diretorio: '/inexistente', nome: NOME_DO_DUMP, modo: 0o600, semSeguirLinks: true });
    await obs.lancador.lancar({ opcoes: { stdio: ['ignore', 987654, 'ignore'] } });
    dSaida.resolver({ codigo: 0, sinal: null });
    dFluxos.resolver();
    await dFluxos.promessa;
    const r1 = await obs.evidencia();
    assert.equal(r1.ok, false);
    assert.ok(['NAO_OBSERVADO', 'LEITURA_FALHOU', 'ARQUIVO_INVALIDO'].includes(r1.motivo));
    assert.equal(JSON.stringify(r1).includes(SEGREDO), false);

    // getter que lança no objeto criado e fluxos que rejeitam
    const criadoHostil = {};
    Object.defineProperty(criadoHostil, 'descritor', { get() { throw hostil(); } });
    const dSaida2 = deferido();
    const dFluxos2 = deferido();
    const obs2 = observadorModulo().criarObservadorDoDump({
      arquivos: { criarExclusivo: () => criadoHostil },
      lancador: { lancar: () => ({ pid: 4242, saida: dSaida2.promessa, fluxosFechados: dFluxos2.promessa }) },
    });
    assert.equal(await obs2.arquivos.criarExclusivo({ diretorio: '/x', nome: 'y' }), criadoHostil);
    await obs2.lancador.lancar({});
    dSaida2.resolver({ codigo: 0, sinal: null });
    dFluxos2.rejeitar(hostil());
    await dFluxos2.promessa.catch(() => {});
    const r2 = await obs2.evidencia();
    assert.equal(r2.ok, false);
    assert.equal(JSON.stringify(r2).includes(SEGREDO), false);
  });

  teste('EVD-10 — o produtor de evidência NÃO tem como liberar trava, finalizar snapshot ou declarar o dump concluído: a interface é só { arquivos, lancador, evidencia }, e uma falha nunca devolve `ok` verdadeiro nem campos do avaliador', async () => {
    const op = await operacao();
    const antes = await op.observador.evidencia();
    assert.equal(antes.ok, false);
    // Interface estendida de forma ADITIVA pelo E3' (`observar` = T1 enriquecida; `conferir` = T2): ainda nenhuma capacidade de liberar trava, finalizar snapshot ou declarar o dump concluído.
    assert.deepEqual(Object.keys(op.observador).sort(), ['abrirArtefato', 'arquivos', 'conferir', 'evidencia', 'lancador', 'observar']);
    for (const nome of ['liberar', 'finalizar', 'concluir', 'avaliar']) assert.equal(Object.hasOwn(op.observador, nome), false, nome);
    await op.encerrar();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] garantias que dependem de contrato ou produtor ainda INEXISTENTE (registradas, NÃO especificadas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('EVD-11 — FONTE INDEPENDENTE do hash declarado do dump: tap em pipe durante a escrita (D9, hoje por descritor), `pg_restore --list` ou outro procedimento; sem ela `sha256Declarado` do avaliador não pode ser preenchido e o dump nunca fica "concluído" para o avaliador', 'produtor inexistente');
  todo('EVD-12 — o veredito do SUPERVISOR (término confirmado, fluxos fechados, GRUPO VAZIO, `liberarTravaPermitido`) não chega ao observador: ele só vê `saida` e `fluxosFechados` brutos do lançador; hoje a garantia vem de o coordenador só entrar na etapa `copia` depois da supervisão concluída; um canal confiável do veredito exige contrato novo', 'contrato inexistente');
  todo('EVD-13 — mudança do conteúdo DURANTE a leitura e reescrita de mesmo tamanho dentro da granularidade do relógio do sistema de arquivos: exige ponto de injeção determinístico na leitura e/ou imutabilidade do arquivo (somente leitura, dono, sistema de arquivos)', 'limite da plataforma');
  todo('EVD-14 — TOCTOU entre abrir por caminho e a troca de diretórios intermediários (sem `openat`), reutilização de PID/PGID e descendentes que escapem do grupo', 'limite da plataforma');
  todo('EVD-15 — verificação de vazamento de descritores pelo observador (contagem de descritores abertos antes/depois) e limite de tamanho do arquivo lido', 'incremento próprio');
  todo('EVD-16 — autenticidade da evidência (assinatura/HMAC), associação a `snapshotId` e `conjuntoId` por identificador de operação (inexistente nos contratos) e publicação/restauração independente', 'decisão de arquitetura');
});
