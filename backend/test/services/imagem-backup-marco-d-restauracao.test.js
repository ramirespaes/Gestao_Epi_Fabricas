'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { abrirPacote, criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarRestauradorDoBanco } = require('../../src/services/imagem-backup-restauracao-banco.service');
const { construirPacotePublicado, limparTemporarios, novaRaiz } = require('../helpers/pacote-publicado-ficticio');

/**
 * MARCO D — RESTAURAÇÃO INDEPENDENTE de um pacote completo. Pacotes FICTÍCIOS gerados pelo pipeline real do backup em diretórios temporários exclusivos e lidos DEPOIS só pelo que está persistido em disco (o gerador não devolve
 * objeto, closure nem marca). O banco é restaurado por um EXECUTOR INJETADO e simulado: NENHUM `pg_restore`, PostgreSQL ou processo operacional é executado (o único processo filho é o `node` do teste MD-S02, para provar a
 * independência de memória). Uma restauração simulada NUNCA é restauração operacional real nem recuperabilidade.
 */

after(limparTemporarios);
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const teste = (nome, a, b) => (typeof a === "function" ? test(nome, { timeout: 30000 }, a) : test(nome, { timeout: 30000, ...a }, b));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const DESTINO_BANCO = Object.freeze({ banco: 'gepi_restauracao_temp1', host: '127.0.0.1', porta: 5432, usuario: 'gepi_restore', arquivoDeSenha: '/tmp/senha-ficticia' });

/** Fotografia de uma árvore: arquivo -> SHA-256 ou "LINK:<alvo>"; diretórios vazios constam. */
function instantaneo(raiz) {
  const mapa = {};
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(raiz, p);
      if (e.isSymbolicLink()) mapa[rel] = `LINK:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) { mapa[`${rel}/`] = 'DIR'; andar(p); } else mapa[rel] = sha(fs.readFileSync(p));
    }
  };
  andar(raiz);
  return mapa;
}
const vazamento = (valor) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), 'gepi-md-test-']) assert.equal(t.includes(proibido), false, `vazou ${proibido}`);
};

/** Executor INJETADO do banco (simulado): registra o spec e o conteúdo REAL da entrada padrão (lido por leitura posicional). */
function executorDoBanco(modo = 'ok', politica = {}) {
  const chamadas = [];
  const lancador = {
    lancar(spec) {
      const fd = spec.opcoes.stdio[0];
      const tamanho = fs.fstatSync(fd).size;
      const dados = Buffer.alloc(tamanho);
      fs.readSync(fd, dados, 0, tamanho, 0);
      chamadas.push({ spec, entradaSha: sha(dados), fd });
      if (modo === 'lanca') throw new Error(`${SEGREDO} /Users/privado`);
      const termino = modo === 'saida1' ? { codigo: 1, sinal: null } : modo === 'sinal' ? { codigo: null, sinal: 'SIGKILL' } : { codigo: 0, sinal: null };
      return { pid: 7001, saida: modo === 'trava' ? new Promise(() => {}) : Promise.resolve(termino), fluxosFechados: modo === 'trava' ? new Promise(() => {}) : Promise.resolve() };
    },
  };
  const restaurador = criarRestauradorDoBanco({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador,
    sistema: { async grupoVivo() { return modo === 'vivo'; }, async enviarSinal() { return true; } },
    temporizador: {
      prazo: (ms) => (modo === 'trava' && (ms === PRAZOS.totalMs || ms === PRAZOS.cortesiaMs) ? { promessa: Promise.resolve(), cancelar() {} } : { promessa: new Promise(() => {}), cancelar() {} }),
      intervalo: () => Promise.resolve(),
    },
    prazos: { ...PRAZOS },
    politicaDeDestino: { prefixoDoBanco: 'gepi_restauracao_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: ['gestao_epi', 'gestao_epi_producao', 'gepi_restauracao_protegido'], ...politica },
  });
  return { chamadas, restaurador };
}
const destinoDeImagens = (nome = 'imagens-restauradas') => ({ raiz: novaRaiz(), nome });
const entrada = (p, extras = {}) => ({ raizAutorizada: p.publicados, nome: p.nome, imagens: destinoDeImagens(), ...extras });

// ------------------------------------------------------------------------------------------------------------------------------- MD-S
describe('[MD-S] segurança de carregamento e independência de memória', () => {
  teste('MD-S01 — os módulos de restauração só têm declarações no nível de módulo e não importam processo, banco nem rede', () => {
    const base = path.join(__dirname, '..', '..', 'src', 'services');
    for (const nome of ['imagem-backup-restauracao', 'imagem-backup-restauracao-banco']) {
      const linhas = fs.readFileSync(path.join(base, `${nome}.service.js`), 'utf8').split('\n');
      let emBloco = false;
      for (const [i, l] of linhas.entries()) {
        if (emBloco) { if (l.includes('*/')) emBloco = false; continue; }
        if (l.startsWith('/*')) { if (!l.includes('*/')) emBloco = true; continue; }
        if (l === '' || l.startsWith(' ') || l.startsWith('//') || l.startsWith('}') || l.startsWith(')') || l.startsWith(']') || l === "'use strict';") continue;
        assert.match(l, /^(const|let|function|async function|module\.exports)\b/, `${nome}:${i + 1}`);
      }
      assert.equal(/child_process|require\('pg'\)|node:net|node:http|\.listen\(|setInterval\(|process\.on\(/.test(linhas.join('\n').replace(/\/\*[\s\S]*?\*\//g, '')), false, nome);
    }
  });

  teste('MD-S02 — INDEPENDÊNCIA: um processo NOVO (sem nenhuma closure, objeto ou marca da criação do backup, nem o setup dos testes) lê, valida e aprova o pacote só pelos arquivos persistidos', async () => {
    const p = await construirPacotePublicado();
    const modulo = path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-restauracao.service.js');
    const script = `const { abrirPacote } = require(${JSON.stringify(modulo)});
      abrirPacote({ raizAutorizada: ${JSON.stringify(p.publicados)}, nome: ${JSON.stringify(p.nome)} }).then((r) => { process.stdout.write(JSON.stringify({ ok: r.ok, motivo: r.motivo ?? null, arquivos: r.arquivos ?? null, origem: r.origem ?? null })); });`;
    const filho = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: {}, encoding: 'utf8', timeout: 20000 });
    assert.equal(filho.status, 0, filho.stderr);
    assert.deepEqual(JSON.parse(filho.stdout), { ok: true, motivo: null, arquivos: 8, origem: 'PACOTE_LIDO_DO_DISCO' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MD-A
describe('[MD-A] leitura e validação independentes do pacote persistido', () => {
  teste('MD-A01 — pacote íntegro: selagem relida, conjunto EXATO (5 imagens + manifesto + selo + dump), manifesto e dump do disco; resultado sem marcas em memória', async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    assert.equal(r.ok, true);
    assert.equal(r.origem, 'PACOTE_LIDO_DO_DISCO');
    assert.equal(r.arquivos, 8);
    assert.equal(r.manifesto.arquivos.length, 5);
    assert.deepEqual(r.dump, { bytes: p.dumpBytes.length, sha256: sha(p.dumpBytes) });
    assert.equal(r.identidade.sha256Manifesto, sha(fs.readFileSync(path.join(p.caminho, 'manifesto.json'))));
    assert.equal(Object.isFrozen(r), true);
    assert.deepEqual(instantaneo(p.publicados), antes, 'ler não altera o pacote');
  });

  teste('MD-A02 — NÃO aceita evidência pronta: correlação, pacote, consistência, manifesto, identidade, `recuperavel` e `restauracaoReal` são chaves recusadas (PARAMETROS_INVALIDOS), em `abrirPacote` e em `restaurarPacote`', async () => {
    const p = await construirPacotePublicado();
    for (const chave of ['correlacao', 'pacote', 'consistencia', 'manifesto', 'identidade', 'recuperavel', 'restauracaoReal', 'veredito']) {
      await assert.rejects(abrirPacote({ raizAutorizada: p.publicados, nome: p.nome, [chave]: { ok: true } }), (e) => e.code === 'PARAMETROS_INVALIDOS', chave);
      await assert.rejects(criarRestaurador().restaurarPacote(entrada(p, { [chave]: chave === 'recuperavel' || chave === 'restauracaoReal' ? true : { ok: true } })), (e) => e.code === 'PARAMETROS_INVALIDOS', chave);
    }
    await assert.rejects(criarRestaurador().restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome }), (e) => e.code === 'PARAMETROS_INVALIDOS', 'sem destino das imagens');
  });

  teste('MD-A03 — origem e nome autorizados: raiz relativa, não canônica, inexistente ou link; nome com `..`, barra, caminho absoluto, vazio ou fora do formato; pacote ausente', async () => {
    const p = await construirPacotePublicado();
    const ligacao = path.join(p.raiz, 'ligacao-para-publicados');
    fs.symlinkSync(p.publicados, ligacao);
    const raizes = ['publicados', '/a/../b', path.join(p.raiz, 'nao-existe'), ligacao, '/'];
    for (const raizAutorizada of raizes) {
      const r = await abrirPacote({ raizAutorizada, nome: p.nome });
      assert.equal(r.ok, false, raizAutorizada);
      assert.equal(r.motivo, 'ORIGEM_NAO_AUTORIZADA', raizAutorizada);
    }
    for (const nome of ['..', '../prep-1', 'a/b', `/${p.nome}`, '', 'a b', '.oculto', 'x'.repeat(101)]) {
      const r = await abrirPacote({ raizAutorizada: p.publicados, nome });
      assert.equal(r.ok, false, nome);
      assert.equal(r.motivo, 'ORIGEM_NAO_AUTORIZADA', nome);
    }
    const ausente = await abrirPacote({ raizAutorizada: p.publicados, nome: 'nao-existe' });
    assert.equal(ausente.motivo, 'PACOTE_AUSENTE');
    vazamento(ausente);
  });

  teste('MD-A04 — o próprio pacote como LINK SIMBÓLICO (mesmo apontando para um pacote íntegro fora da origem) é recusado: LINK_SIMBOLICO', async () => {
    const p = await construirPacotePublicado();
    const fora = path.join(p.raiz, 'fora');
    fs.mkdirSync(fora, { mode: 0o700 });
    fs.renameSync(p.caminho, path.join(fora, 'real'));
    fs.symlinkSync(path.join(fora, 'real'), p.caminho);
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'LINK_SIMBOLICO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MD-B
describe('[MD-B] contraprovas de integridade: cada adulteração do pacote persistido é recusada e nada é alterado', () => {
  const adulteracoes = [
    ['manifesto adulterado', (c) => fs.appendFileSync(path.join(c, 'manifesto.json'), ' '), 'SELAGEM_INVALIDA'],
    ['manifesto ausente', (c) => fs.unlinkSync(path.join(c, 'manifesto.json')), 'SELAGEM_INVALIDA'],
    ['selo ausente', (c) => fs.unlinkSync(path.join(c, 'manifesto.sha256')), 'SELAGEM_INVALIDA'],
    ['selo malformado', (c) => fs.writeFileSync(path.join(c, 'manifesto.sha256'), 'qualquer-coisa\n'), 'SELAGEM_INVALIDA'],
    ['selo com outro digest', (c) => fs.writeFileSync(path.join(c, 'manifesto.sha256'), `${'e'.repeat(64)}  manifesto.json\n`), 'SELAGEM_INVALIDA'],
    ['dump ausente', (c) => fs.unlinkSync(path.join(c, 'dump', 'postgres.dump')), 'ARQUIVO_AUSENTE'],
    ['dump divergente (mesmo tamanho)', (c) => { const f = path.join(c, 'dump', 'postgres.dump'); const b = fs.readFileSync(f); b[0] ^= 0xff; fs.writeFileSync(f, b); }, 'ARQUIVO_DIVERGENTE'],
    ['dump truncado', (c) => fs.truncateSync(path.join(c, 'dump', 'postgres.dump'), 10), 'ARQUIVO_DIVERGENTE'],
    ['pasta do dump ausente (pacote incompleto)', (c) => fs.rmSync(path.join(c, 'dump'), { recursive: true }), 'ARQUIVO_AUSENTE'],
    ['pasta de imagens ausente (pacote incompleto)', (c) => fs.rmSync(path.join(c, 'imagens'), { recursive: true }), 'ARQUIVO_AUSENTE'],
    ['arquivo inesperado na raiz', (c) => fs.writeFileSync(path.join(c, 'extra.bin'), 'x'), 'ARQUIVO_EXTRA'],
    ['arquivo inesperado em dump/', (c) => fs.writeFileSync(path.join(c, 'dump', 'outro.dump'), 'x'), 'ARQUIVO_EXTRA'],
    ['arquivo inesperado em imagens/', (c) => fs.writeFileSync(path.join(c, 'imagens', 'padrao', 'sobra.bin'), 'x'), 'ARQUIVO_EXTRA'],
    ['link simbólico para arquivo', (c) => fs.symlinkSync('/etc/hosts', path.join(c, 'ligacao')), 'ENTRADA_INVALIDA'],
    ['link simbólico para diretório', (c) => fs.symlinkSync('/', path.join(c, 'dump', 'raiz')), 'ENTRADA_INVALIDA'],
    ['dump trocado por link simbólico', (c) => { const f = path.join(c, 'dump', 'postgres.dump'); const b = fs.readFileSync(f); fs.unlinkSync(f); const real = path.join(c, '..', 'dump-real.bin'); fs.writeFileSync(real, b); fs.symlinkSync(real, f); }, 'ENTRADA_INVALIDA'],
  ];
  for (const [rotulo, adulterar, motivo] of adulteracoes) {
    teste(`MD-B (${rotulo}) — recusado com ${motivo}; sem vazar caminho; a leitura não altera mais nada`, async () => {
      const p = await construirPacotePublicado();
      adulterar(p.caminho);
      const antes = instantaneo(p.publicados);
      const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, motivo, rotulo);
      vazamento(r);
      assert.deepEqual(instantaneo(p.publicados), antes);
      // e a restauração completa também recusa, sem criar o destino
      const destino = destinoDeImagens();
      const rest = await criarRestaurador().restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino });
      assert.equal(rest.ok, false);
      assert.equal(rest.motivo, motivo);
      assert.equal(fs.existsSync(path.join(destino.raiz, destino.nome)), false, 'nada foi criado no destino');
      assert.equal(rest.restauracaoReal, false);
      assert.equal(rest.recuperavel, false);
    });
  }

  teste('MD-B (imagem ausente / imagem adulterada) — cada imagem referenciada pelo manifesto é exigida e conferida (tamanho e SHA-256): ARQUIVO_AUSENTE e ARQUIVO_DIVERGENTE', async () => {
    const p = await construirPacotePublicado();
    const lido = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    const imagem = (item) => path.join(p.caminho, 'imagens', ...item.chave.split('/'));
    const [a, b] = lido.manifesto.arquivos;
    fs.appendFileSync(imagem(a), 'x');
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome })).motivo, 'ARQUIVO_DIVERGENTE');
    fs.writeFileSync(imagem(a), fs.readFileSync(imagem(a)).subarray(0, a.bytes)); // desfaz
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome })).ok, true);
    fs.unlinkSync(imagem(b));
    assert.equal((await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome })).motivo, 'ARQUIVO_AUSENTE');
  });

  teste('MD-B (ADAPTADO pela quarentena durável) — SHA-256 sem assinatura NÃO autentica o pacote em si, mas a CONCLUSÃO da publicação (autenticada e ligada ao SHA-256 do manifesto) recusa a forja coerente: a regravação de imagem, manifesto e selo muda o manifesto e é recusada (REGISTRO_DE_PUBLICACAO_INVALIDO); sem registro algum o leitor legado ainda só verifica integridade', async () => {
    const p = await construirPacotePublicado();
    const lido = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    const ordenar = (v) => (Array.isArray(v) ? v.map(ordenar) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])])) : v);
    const alvo = lido.manifesto.arquivos[0];
    const novo = Buffer.from('conteudo-forjado-por-quem-reescreve-tudo');
    fs.writeFileSync(path.join(p.caminho, 'imagens', ...alvo.chave.split('/')), novo);
    const manifesto = ordenar({ ...lido.manifesto, arquivos: lido.manifesto.arquivos.map((i) => (i.chave === alvo.chave ? { ...i, bytes: novo.length, sha256: sha(novo) } : i)) });
    const bytes = Buffer.from(JSON.stringify(manifesto), 'utf8');
    fs.writeFileSync(path.join(p.caminho, 'manifesto.json'), bytes);
    fs.writeFileSync(path.join(p.caminho, 'manifesto.sha256'), `${sha(bytes)}  manifesto.json\n`);
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    // o pacote foi publicado pelo pipeline real (tem conclusão ligada ao SHA-256 do manifesto original): a forja coerente é recusada
    assert.deepEqual([r.ok, r.motivo], [false, 'REGISTRO_DE_PUBLICACAO_INVALIDO']);
  });

  teste('MD-B (formato atual) — CARACTERIZAÇÃO dos campos AUSENTES: o manifesto persistido só tem arquivos, banco, conjuntoId, dump{bytes,sha256} e versao; o caminho do dump e o layout do pacote são CONVENÇÃO fixa (não estão no manifesto)', async () => {
    const p = await construirPacotePublicado();
    const r = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    assert.deepEqual(Object.keys(r.manifesto).sort(), ['arquivos', 'banco', 'conjuntoId', 'dump', 'versao']);
    assert.deepEqual(Object.keys(r.manifesto.dump).sort(), ['bytes', 'sha256']);
    assert.equal(Object.hasOwn(r.manifesto.dump, 'arquivo'), false);
    assert.equal(Object.hasOwn(r.manifesto, 'layout'), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MD-C
describe('[MD-C] restauração física das imagens em destino temporário independente', () => {
  teste('MD-C01 — restaura as 5 imagens: conjunto EXATO, mesmas chaves (identidade lógica), mesmos bytes e SHA-256, permissões 0700/0600, destino NOVO; o pacote de origem fica byte a byte igual; sem `restauracaoReal` nem `recuperavel`', async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const destino = destinoDeImagens();
    const r = await criarRestaurador().restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino });
    assert.equal(r.ok, true);
    assert.equal(r.etapas.imagens.arquivos, 5);
    assert.equal(r.etapas.banco, null);
    assert.equal(r.restauracaoReal, false);
    assert.equal(r.recuperavel, false);
    assert.deepEqual({ ...r.consistenciaLogica }, { verificada: false, motivo: 'NAO_VERIFICADA' });
    assert.ok(r.limites.includes('SEM_CONSISTENCIA_LOGICA_BANCO_IMAGENS'));
    const raizRestaurada = path.join(destino.raiz, destino.nome);
    const pacote = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    const arvore = instantaneo(raizRestaurada);
    const esperado = {};
    for (const item of pacote.manifesto.arquivos) {
      esperado[item.chave] = item.sha256;
      const arquivo = path.join(raizRestaurada, ...item.chave.split('/'));
      assert.equal(fs.statSync(arquivo).size, item.bytes);
      assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(arvore).filter(([, v]) => v !== 'DIR')), esperado, 'conjunto exato, sem sobra nem falta');
    assert.equal(fs.statSync(raizRestaurada).mode & 0o777, 0o700);
    assert.deepEqual(instantaneo(p.publicados), antes, 'a origem não foi tocada');
    vazamento(r);
  });

  teste('MD-C02 — sem sobrescrita: destino já existente (vazio ou com conteúdo) é recusado com DESTINO_EXISTENTE e fica intacto; a segunda restauração com o MESMO nome também é recusada', async () => {
    const p = await construirPacotePublicado();
    const restaurador = criarRestaurador();
    const preexistente = destinoDeImagens('ja-existe');
    fs.mkdirSync(path.join(preexistente.raiz, 'ja-existe'), { mode: 0o700 });
    fs.writeFileSync(path.join(preexistente.raiz, 'ja-existe', 'anterior.txt'), 'conteudo-anterior');
    const fotoAntes = instantaneo(preexistente.raiz);
    const r1 = await restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: preexistente });
    assert.equal(r1.ok, false);
    assert.equal(r1.motivo, 'DESTINO_EXISTENTE');
    assert.deepEqual(instantaneo(preexistente.raiz), fotoAntes);
    const destino = destinoDeImagens();
    assert.equal((await restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino })).ok, true);
    const fotoRestaurada = instantaneo(destino.raiz);
    const repetida = await restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino });
    assert.equal(repetida.motivo, 'DESTINO_EXISTENTE');
    assert.deepEqual(instantaneo(destino.raiz), fotoRestaurada, 'a restauração anterior não foi tocada');
  });

  teste('MD-C03 — isolamento do destino: raiz dentro da origem, igual à origem, contendo a origem, link simbólico, inexistente, com permissão aberta ou não canônica são recusadas sem criar nada', async () => {
    const p = await construirPacotePublicado();
    const restaurador = criarRestaurador();
    const aberta = novaRaiz();
    fs.chmodSync(aberta, 0o755);
    const real = novaRaiz();
    const ligacao = path.join(novaRaiz(), 'ligacao');
    fs.symlinkSync(real, ligacao);
    const casos = [
      ['dentro da origem', { raiz: p.publicados, nome: 'restaurado' }, 'DESTINO_NAO_ISOLADO'],
      ['igual à origem', { raiz: p.raiz, nome: 'publicados' }, 'DESTINO_NAO_ISOLADO'],
      ['dentro do pacote', { raiz: p.caminho, nome: 'restaurado' }, 'DESTINO_NAO_ISOLADO'],
      ['permissão aberta', { raiz: aberta, nome: 'restaurado' }, 'DESTINO_NAO_AUTORIZADO'],
      ['raiz é link', { raiz: ligacao, nome: 'restaurado' }, 'DESTINO_NAO_AUTORIZADO'],
      ['raiz inexistente', { raiz: path.join(p.raiz, 'nao-existe'), nome: 'restaurado' }, 'DESTINO_NAO_AUTORIZADO'],
    ];
    const foto = instantaneo(p.raiz);
    for (const [rotulo, imagens, motivo] of casos) {
      const r = await restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens });
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, motivo, rotulo);
    }
    assert.deepEqual(instantaneo(p.raiz), foto, 'a origem nada ganhou');
    assert.deepEqual(fs.readdirSync(real), [], 'nada foi criado atrás do link');
    for (const imagens of [{ raiz: 'relativo', nome: 'x' }, { raiz: real, nome: '../x' }, { raiz: real, nome: 'a/b' }, { raiz: real, nome: '' }, { raiz: real }, { raiz: real, nome: 'x', extra: 1 }]) {
      await assert.rejects(restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens }), (e) => e.code === 'PARAMETROS_INVALIDOS', JSON.stringify(imagens));
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MD-D
describe('[MD-D] falhas intermediárias na restauração das imagens: falha fechada, nada apagado, banco intocado', () => {
  async function comBancoEspiao(p, ops, destino = destinoDeImagens()) {
    const banco = executorDoBanco('ok');
    const restaurador = criarRestaurador({ ops, restauradorDoBanco: banco.restaurador });
    const r = await restaurador.restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    return { r, banco, destino };
  }

  teste('MD-D01 — erro de ESCRITA no 3º arquivo: ESCRITA_FALHOU, 2 restaurados e PRESERVADOS (nenhuma limpeza), o banco NÃO é tocado, o pacote de origem fica igual', async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    let n = 0;
    const { r, banco, destino } = await comBancoEspiao(p, { gravarImagem: async (a, c, b, o) => { n += 1; if (n === 3) throw new Error(SEGREDO); return a.gravar(c, b, o); } });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ESCRITA_FALHOU');
    assert.equal(r.etapas.imagens.restaurados, 2);
    assert.equal(r.etapas.imagens.destino, 'PARCIAL_PRESERVADO');
    assert.equal(r.etapas.banco, null);
    assert.equal(banco.chamadas.length, 0, 'o banco nunca é tocado depois de uma falha nas imagens');
    assert.equal(Object.keys(instantaneo(path.join(destino.raiz, destino.nome))).filter((k) => !k.endsWith('/')).length, 2);
    assert.deepEqual(instantaneo(p.publicados), antes);
    vazamento(r);
  });

  teste('MD-D02 — imagem ADULTERADA no pacote depois da validação e antes da leitura: INTEGRIDADE_DIVERGENTE, destino parcial preservado, banco intocado', async () => {
    const p = await construirPacotePublicado();
    const lido = await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome });
    let n = 0;
    const { r, banco } = await comBancoEspiao(p, {
      lerImagem: async (caminho, bytes) => {
        n += 1;
        if (n === 2) fs.writeFileSync(caminho, Buffer.alloc(bytes, 0x41));
        const leitor = fs.readFileSync(caminho);
        return leitor.length === bytes ? leitor : null;
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'INTEGRIDADE_DIVERGENTE');
    assert.equal(r.etapas.imagens.restaurados, 1);
    assert.equal(banco.chamadas.length, 0);
    assert.ok(lido.ok);
  });

  teste('MD-D03 — erro de LEITURA de uma imagem do pacote: LEITURA_FALHOU, sem vazar a causa; conteúdo gravado com SHA-256 errado é recusado pelo armazenamento (ESCRITA_FALHOU)', async () => {
    const p = await construirPacotePublicado();
    const a = await comBancoEspiao(p, { lerImagem: async () => { throw new Error(SEGREDO); } });
    assert.equal(a.r.motivo, 'LEITURA_FALHOU');
    vazamento(a.r);
    const q = await construirPacotePublicado();
    const b = await comBancoEspiao(q, { gravarImagem: async (arm, chave, bytes, opcoes) => arm.gravar(chave, Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from('Z')]), opcoes) });
    assert.equal(b.r.motivo, 'ESCRITA_FALHOU');
    assert.equal(b.banco.chamadas.length, 0);
  });

  teste('MD-D04 — o pacote de origem é ALTERADO durante a restauração (o dump muda no meio): a restauração termina sem sucesso (PACOTE_ALTERADO_DURANTE_A_RESTAURACAO ou DUMP_DIVERGENTE) e o resultado nunca é ok', async () => {
    const p = await construirPacotePublicado();
    let n = 0;
    const { r } = await comBancoEspiao(p, { gravarImagem: async (a, c, b, o) => { n += 1; const res = await a.gravar(c, b, o); if (n === 5) fs.appendFileSync(path.join(p.caminho, 'dump', 'postgres.dump'), 'x'); return res; } });
    assert.equal(r.ok, false);
    assert.ok(['DUMP_DIVERGENTE', 'PACOTE_ALTERADO_DURANTE_A_RESTAURACAO'].includes(r.motivo), r.motivo);
    assert.equal(r.restauracaoReal, false);
    assert.equal(r.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MD-E
describe('[MD-X] contraprovas: destino sem escrita, releitura final do destino e restaurador do banco que lança — falha fechada, parciais preservados', () => {
  const ehRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const totalDeImagens = async (p) => (await abrirPacote({ raizAutorizada: p.publicados, nome: p.nome })).manifesto.arquivos.length;

  teste('MD-X01 — destino das imagens SEM permissão de escrita (diretório do próprio teste, restringido por descritor): ESCRITA_FALHOU, nada restaurado, banco intocado, pacote de origem inalterado e sem vazar a causa', { skip: ehRoot }, async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const destino = destinoDeImagens();
    const banco = executorDoBanco('ok');
    const fd = fs.openSync(destino.raiz, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let r;
    try {
      fs.fchmodSync(fd, 0o500);
      r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    } finally { fs.fchmodSync(fd, 0o700); fs.closeSync(fd); }
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ESCRITA_FALHOU');
    assert.equal(r.etapas.imagens.ok, false);
    assert.equal(Object.hasOwn(r.etapas.imagens, 'restaurados'), false, 'falhou antes de gravar qualquer imagem');
    assert.equal(r.etapas.banco, null);
    assert.equal(banco.chamadas.length, 0);
    assert.deepEqual(fs.readdirSync(destino.raiz), []);
    assert.deepEqual(instantaneo(p.publicados), antes);
    vazamento(r);
  });

  teste('MD-X02b — releitura final do destino NÃO consegue ABRIR uma imagem restaurada (ficou ilegível): LEITURA_FALHOU com destino PARCIAL_PRESERVADO, todas as imagens contadas, banco intocado, pacote de origem inalterado', { skip: ehRoot }, async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const total = await totalDeImagens(p);
    const destino = destinoDeImagens();
    let n = 0;
    const ops = {
      gravarImagem: async (armazenamento, chave, bytes, opcoes) => {
        await armazenamento.gravar(chave, bytes, opcoes);
        n += 1;
        if (n === total) fs.chmodSync(path.join(destino.raiz, destino.nome, ...chave.split('/')), 0o000); // arquivo criado agora pelo restaurador, dentro da fixture do teste
      },
    };
    const banco = executorDoBanco('ok');
    const r = await criarRestaurador({ ops, restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'LEITURA_FALHOU');
    assert.equal(r.etapas.imagens.destino, 'PARCIAL_PRESERVADO');
    assert.equal(r.etapas.imagens.restaurados, total);
    assert.equal(banco.chamadas.length, 0);
    assert.equal(fs.existsSync(path.join(destino.raiz, destino.nome)), true, 'o destino parcial foi preservado');
    assert.deepEqual(instantaneo(p.publicados), antes);
    vazamento(r);
  });

  teste('MD-X02 — uma imagem restaurada TROCADA por link simbólico antes da releitura final: DESTINO_DIVERGENTE (o link não é aceito como arquivo restaurado) com destino PARCIAL_PRESERVADO, todas as imagens contadas, banco intocado, pacote de origem inalterado', async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const total = await totalDeImagens(p);
    const destino = destinoDeImagens();
    let n = 0;
    const ops = {
      gravarImagem: async (armazenamento, chave, bytes, opcoes) => {
        await armazenamento.gravar(chave, bytes, opcoes);
        n += 1;
        if (n === total) {
          const arquivo = path.join(destino.raiz, destino.nome, ...chave.split('/'));
          fs.unlinkSync(arquivo);
          fs.symlinkSync(__filename, arquivo);
        }
      },
    };
    const banco = executorDoBanco('ok');
    const r = await criarRestaurador({ ops, restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'DESTINO_DIVERGENTE');
    assert.equal(r.etapas.imagens.destino, 'PARCIAL_PRESERVADO');
    assert.equal(r.etapas.imagens.restaurados, total);
    assert.equal(banco.chamadas.length, 0);
    assert.equal(fs.existsSync(path.join(destino.raiz, destino.nome)), true, 'o destino parcial foi preservado');
    assert.deepEqual(instantaneo(p.publicados), antes);
    vazamento(r);
  });

  teste('MD-X04 — FALTA DE ESPAÇO ao criar o destino das imagens (ENOSPC / EDQUOT no mkdir): ESPACO_ESGOTADO, nada restaurado, banco intocado, pacote de origem inalterado e sem vazar a causa', async (t) => {
    for (const code of ['ENOSPC', 'EDQUOT']) {
      const p = await construirPacotePublicado();
      const antes = instantaneo(p.publicados);
      const destino = destinoDeImagens();
      const original = fsp.mkdir;
      const alvo = path.join(destino.raiz, destino.nome);
      t.mock.method(fsp, 'mkdir', async (caminho, ...resto) => {
        if (caminho === alvo) throw Object.assign(new Error(SEGREDO), { code });
        return original.call(fsp, caminho, ...resto);
      });
      const banco = executorDoBanco('ok');
      const r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
      t.mock.restoreAll();
      assert.deepEqual([r.ok, r.motivo], [false, 'ESPACO_ESGOTADO'], code);
      assert.equal(r.etapas.banco, null);
      assert.equal(banco.chamadas.length, 0);
      assert.deepEqual(fs.readdirSync(destino.raiz), []);
      assert.deepEqual(instantaneo(p.publicados), antes);
      vazamento(r);
    }
  });

  teste('MD-X03 — o restaurador do banco LANÇA exceção: RESTAURADOR_FALHOU (sem vazar a causa), as imagens já restauradas permanecem, o dump aberto é fechado e o pacote de origem fica inalterado', async () => {
    const p = await construirPacotePublicado();
    const antes = instantaneo(p.publicados);
    const destino = destinoDeImagens();
    const chamadas = [];
    const restauradorQueLanca = { autorizarDestino: () => true, restaurar: async ({ dump }) => { chamadas.push(dump); throw new Error(`${SEGREDO} /Users/privado`); } };
    const r = await criarRestaurador({ restauradorDoBanco: restauradorQueLanca }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'RESTAURADOR_FALHOU');
    assert.equal(r.etapas.imagens.ok, true);
    assert.equal(r.etapas.banco.ok, false);
    assert.equal(chamadas.length, 1);
    assert.throws(() => fs.fstatSync(chamadas[0].descritor), 'o descritor do dump foi fechado depois da falha');
    assert.equal(Object.keys(instantaneo(path.join(destino.raiz, destino.nome))).length > 0, true, 'imagens restauradas preservadas');
    assert.deepEqual(instantaneo(p.publicados), antes);
    vazamento(r);
  });
});

describe('[MD-E] restauração do banco por executor INJETADO e supervisionado (nenhum pg_restore real)', () => {
  teste('MD-E01 — caminho positivo SIMULADO: spec exato, ambiente exato, entrada padrão = o dump conferido do pacote (SHA-256 do manifesto), descritor fechado depois; resultado diz executor injetado, sem restauração real nem recuperabilidade nem consistência lógica', async () => {
    const p = await construirPacotePublicado();
    const banco = executorDoBanco('ok');
    const destino = destinoDeImagens();
    const r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
    assert.equal(r.ok, true);
    assert.equal(banco.chamadas.length, 1);
    const { spec, entradaSha, fd } = banco.chamadas[0];
    assert.equal(spec.executavel, '/usr/bin/pg_restore');
    assert.deepEqual([...spec.argumentos], ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', '--dbname=gepi_restauracao_temp1']);
    assert.deepEqual({ ...spec.ambiente }, { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'gepi_restore' });
    assert.deepEqual([spec.opcoes.shell, spec.opcoes.detached, spec.opcoes.stdio[1], spec.opcoes.stdio[2]], [false, true, 'ignore', 'ignore']);
    assert.equal(entradaSha, sha(p.dumpBytes), 'a entrada padrão é o dump íntegro do pacote');
    assert.throws(() => fs.fstatSync(fd), (e) => e.code === 'EBADF', 'o descritor foi fechado');
    assert.deepEqual({ ok: r.etapas.banco.ok, origem: r.etapas.banco.origem, restauracaoReal: r.etapas.banco.restauracaoReal }, { ok: true, origem: 'EXECUTOR_INJETADO', restauracaoReal: false });
    assert.equal(r.restauracaoReal, false);
    assert.equal(r.recuperavel, false);
    assert.equal(r.consistenciaLogica.verificada, false);
    assert.equal(JSON.stringify(spec.argumentos).includes(os.tmpdir()), false, 'o caminho do dump nunca é passado ao processo');
    vazamento(r);
  });

  teste('MD-E02 — POLÍTICA DE DESTINO: banco de produção, banco protegido, prefixo errado, só o prefixo, maiúsculas, injeção, host não autorizado, porta/usuário inválidos e chaves extras são recusados ANTES de qualquer imagem ou processo (nada é criado nem lançado)', async () => {
    const p = await construirPacotePublicado();
    const casos = [
      ['produção', { ...DESTINO_BANCO, banco: 'gestao_epi' }],
      ['produção nomeada', { ...DESTINO_BANCO, banco: 'gestao_epi_producao' }],
      ['protegido com o prefixo certo', { ...DESTINO_BANCO, banco: 'gepi_restauracao_protegido' }],
      ['prefixo errado', { ...DESTINO_BANCO, banco: 'meu_banco' }],
      ['só o prefixo', { ...DESTINO_BANCO, banco: 'gepi_restauracao_' }],
      ['maiúsculas', { ...DESTINO_BANCO, banco: 'GEPI_RESTAURACAO_X' }],
      ['injeção', { ...DESTINO_BANCO, banco: 'gepi_restauracao_x;drop' }],
      ['host não autorizado', { ...DESTINO_BANCO, host: '10.0.0.5' }],
      ['porta inválida', { ...DESTINO_BANCO, porta: 70000 }],
      ['usuário inválido', { ...DESTINO_BANCO, usuario: 'a b' }],
      ['arquivo de senha relativo', { ...DESTINO_BANCO, arquivoDeSenha: 'senha' }],
      ['chave extra', { ...DESTINO_BANCO, senha: SEGREDO }],
      ['ausente', undefined],
    ];
    for (const [rotulo, destinoBanco] of casos) {
      const banco = executorDoBanco('ok');
      const destino = destinoDeImagens();
      const r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: destinoBanco } });
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'DESTINO_NAO_AUTORIZADO', rotulo);
      assert.equal(banco.chamadas.length, 0, rotulo);
      assert.equal(fs.existsSync(path.join(destino.raiz, destino.nome)), false, `${rotulo}: nenhuma imagem restaurada`);
      vazamento(r);
    }
    const vazia = executorDoBanco('ok', { hostsAutorizados: [] });
    const r = await criarRestaurador({ restauradorDoBanco: vazia.restaurador }).restaurarPacote(entrada(p, { banco: { destino: DESTINO_BANCO } }));
    assert.equal(r.motivo, 'DESTINO_NAO_AUTORIZADO', 'sem hosts autorizados nenhum destino é aceito');
  });

  const falhas = [['saida1', 'SAIDA_NAO_ZERO'], ['sinal', 'SINAL'], ['vivo', 'ESTADO_INCERTO'], ['lanca', 'NAO_INICIADA']];
  for (const [modo, motivo] of falhas) {
    teste(`MD-E03 (${modo}) — falha durante a restauração do banco: ${motivo}; as imagens restauradas e o pacote ficam como estão (nada apagado), o resultado nunca é ok nem restauração real`, async () => {
      const p = await construirPacotePublicado();
      const antes = instantaneo(p.publicados);
      const banco = executorDoBanco(modo);
      const destino = destinoDeImagens();
      const r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote({ raizAutorizada: p.publicados, nome: p.nome, imagens: destino, banco: { destino: DESTINO_BANCO } });
      assert.equal(r.ok, false);
      assert.equal(r.motivo, motivo);
      assert.equal(r.etapas.imagens.ok, true);
      assert.equal(r.etapas.banco.ok, false);
      assert.equal(r.restauracaoReal, false);
      assert.equal(r.recuperavel, false);
      assert.equal(Object.keys(instantaneo(path.join(destino.raiz, destino.nome))).filter((k) => !k.endsWith('/')).length, 5, 'imagens preservadas');
      assert.deepEqual(instantaneo(p.publicados), antes);
      vazamento(r);
    });
  }

  teste('MD-E04 — processo que NÃO termina (prazos vencidos): encerramento forçado/incerto, nunca ok; o descritor do dump é fechado', async () => {
    const p = await construirPacotePublicado();
    const banco = executorDoBanco('trava');
    const r = await criarRestaurador({ restauradorDoBanco: banco.restaurador }).restaurarPacote(entrada(p, { banco: { destino: DESTINO_BANCO } }));
    assert.equal(r.ok, false);
    assert.ok(['ENCERRAMENTO_FORCADO', 'ESTADO_INCERTO', 'SINAL', 'SAIDA_NAO_ZERO'].includes(r.motivo), r.motivo);
    assert.throws(() => fs.fstatSync(banco.chamadas[0].fd), (e) => e.code === 'EBADF');
  });

  teste('MD-E05 — dump ADULTERADO entre a validação do pacote e a restauração do banco: o dump é conferido de novo imediatamente antes, DUMP_DIVERGENTE, e o processo NÃO é lançado', async () => {
    const p = await construirPacotePublicado();
    const banco = executorDoBanco('ok');
    let n = 0;
    const ops = { gravarImagem: async (a, c, b, o) => { n += 1; const res = await a.gravar(c, b, o); if (n === 5) { const f = path.join(p.caminho, 'dump', 'postgres.dump'); const d = fs.readFileSync(f); d[0] ^= 0xff; fs.writeFileSync(f, d); } return res; } };
    const r = await criarRestaurador({ ops, restauradorDoBanco: banco.restaurador }).restaurarPacote(entrada(p, { banco: { destino: DESTINO_BANCO } }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'DUMP_DIVERGENTE');
    assert.equal(banco.chamadas.length, 0);
  });

  teste('MD-E06 — contratos estritos: banco solicitado sem restaurador configurado é PARAMETROS_INVALIDOS; fábricas recusam opções desconhecidas, executável que não é pg_restore, prefixo inválido, prazos inválidos e lançador ausente; nada executa na construção', async () => {
    const p = await construirPacotePublicado();
    await assert.rejects(criarRestaurador().restaurarPacote(entrada(p, { banco: { destino: DESTINO_BANCO } })), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => criarRestaurador({ restauradorDoBanco: { restaurar() {} } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => criarRestaurador({ intruso: 1 }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    assert.throws(() => criarRestaurador({ ops: { lerImagem: 1 } }), (e) => e.code === 'PARAMETROS_INVALIDOS');
    const base = { alvo: { executavel: '/usr/bin/pg_restore' }, lancador: { lancar() {} }, sistema: { grupoVivo() {}, enviarSinal() {} }, temporizador: { prazo() {}, intervalo() {} }, prazos: { ...PRAZOS }, politicaDeDestino: { prefixoDoBanco: 'gepi_restauracao_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: [] } };
    assert.equal(typeof criarRestauradorDoBanco(base).restaurar, 'function');
    for (const ruim of [{ ...base, extra: 1 }, { ...base, alvo: { executavel: '/usr/bin/pg_dump' } }, { ...base, alvo: { executavel: 'pg_restore' } }, { ...base, lancador: {} }, { ...base, prazos: { ...PRAZOS, totalMs: 0 } },
      { ...base, politicaDeDestino: { ...base.politicaDeDestino, prefixoDoBanco: 'x' } }, { ...base, politicaDeDestino: { ...base.politicaDeDestino, hostsAutorizados: 'localhost' } }]) {
      assert.throws(() => criarRestauradorDoBanco(ruim), TypeError);
    }
    let lancamentos = 0;
    criarRestauradorDoBanco({ ...base, lancador: { lancar() { lancamentos += 1; } } });
    assert.equal(lancamentos, 0);
  });
});
