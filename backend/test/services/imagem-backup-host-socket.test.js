'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const host = require('../../src/services/imagem-backup-host-postgres');
const { criarProcessoDoDump } = require('../../src/services/imagem-backup-pgdump.service');
const { criarLancadorComSpawn } = require('../../src/services/imagem-backup-pgdump-lancador.service');
const { criarRestauradorDoBanco } = require('../../src/services/imagem-backup-restauracao-banco.service');
const { criarLancadorDeRestauracaoComSpawn } = require('../../src/services/imagem-backup-restauracao-lancador.service');

/**
 * HOST COMO SOCKET UNIX nos quatro validadores do backup (pg_dump: serviço e lançador; pg_restore: restaurador e lançador). SÓ fixtures e mocks: diretórios temporários CURTOS e privados criados e removidos pelo próprio teste, `spawn` falso,
 * nenhum PostgreSQL, nenhum processo, nenhuma conexão de rede.
 */

const teste = (nome, fn) => test(nome, { timeout: 20000 }, fn);
const BASE = fs.realpathSync(process.platform === 'darwin' ? '/private/tmp' : '/tmp');
const criados = [];
const PORTA = 5432;
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };

/** Diretório exclusivo, aleatório, curto e privado (0700), cuja propriedade é deste teste. */
function novoSocketDir(modo = 0o700) {
  const dir = fs.mkdtempSync(path.join(BASE, 'gh-'));
  fs.chmodSync(dir, modo);
  criados.push(dir);
  return dir;
}
after(() => {
  for (const alvo of [...criados].reverse()) {
    if (
      path.dirname(alvo) !== BASE ||
      !path.basename(alvo).startsWith('gh-')
    ) {
      throw new Error('LIMPEZA_FORA_DO_ESCOPO');
    }

    let estado;

    try {
      estado = fs.lstatSync(alvo);
    } catch (erro) {
      if (erro.code === 'ENOENT') continue;
      throw erro;
    }

    if (
      typeof process.getuid === 'function' &&
      estado.uid !== process.getuid()
    ) {
      throw new Error('LIMPEZA_SEM_PROPRIEDADE');
    }

    if (estado.isSymbolicLink()) {
      fs.unlinkSync(alvo);
      continue;
    }

    if (!estado.isDirectory()) {
      throw new Error('LIMPEZA_TIPO_INESPERADO');
    }

    for (const filho of fs.readdirSync(alvo)) {
      const caminho = path.join(alvo, filho);
      const tipo = fs.lstatSync(caminho);

      if (tipo.isFile() || tipo.isSymbolicLink()) {
        fs.unlinkSync(caminho);
      } else {
        throw new Error('LIMPEZA_CONTEUDO_INESPERADO');
      }
    }

    fs.chmodSync(alvo, 0o700);
    fs.rmdirSync(alvo);
  }
});

/** Diretório sintático com caminho completo do socket de exatamente `bytes` bytes (para testar o limite). */
function dirComSocketDe(bytes, porta = PORTA) {
  const sufixo = `/.s.PGSQL.${porta}`.length;
  const alvo = bytes - sufixo;
  return `/${'a'.repeat(alvo - 1)}`;
}

// ------------------------------------------------------------------------------------------------------------------------ módulo comum
describe('[HS-A] validação sintática', () => {
  teste('HS-A01 — host tradicional PRESERVADO: nomes e IPs válidos continuam aceitos (com ou sem porta válida); inválidos continuam recusados', () => {
    for (const h of ['127.0.0.1', 'db.interno', 'host_1', 'a', 'A.b-c']) assert.deepEqual(host.hostSintaticamenteValido(h, PORTA), { tipo: 'NOME' }, h);
    for (const h of ['', ' ', 'a b', '-x', '.x', 'host;rm', 'ho\0st', undefined, null, 42, {}]) assert.equal(host.hostSintaticamenteValido(h, PORTA), null, String(h));
  });

  teste('HS-A02 — diretório de socket absoluto e canônico é aceito; relativo, com `..`, `.`, `//`, barra final, NUL e caracteres fora do conjunto são recusados', () => {
    assert.deepEqual(host.hostSintaticamenteValido('/private/tmp/gh-abc123', PORTA), { tipo: 'SOCKET' });
    for (const h of ['relativo/dir', './dir', '/private/../etc', '/private/tmp/../x', '/private/./tmp', '/private//tmp', '/private/tmp/', '/', '/priv ado', '/priv\0ado', '/privado/ação', '/a\nb']) {
      assert.equal(host.hostSintaticamenteValido(h, PORTA), null, JSON.stringify(h));
    }
  });

  teste('HS-A03 — o LIMITE vale para o CAMINHO COMPLETO do socket (`/.s.PGSQL.<porta>`) em bytes: no limite é aceito; um byte acima é recusado; porta mais longa consome o limite', () => {
    const limite = host.LIMITE_SUN_PATH;
    assert.equal(limite, process.platform === 'darwin' ? 103 : 107);
    const noLimite = dirComSocketDe(limite);
    assert.equal(Buffer.byteLength(host.caminhoDoSocket(noLimite, PORTA)), limite);
    assert.deepEqual(host.hostSintaticamenteValido(noLimite, PORTA), { tipo: 'SOCKET' });
    const acima = dirComSocketDe(limite + 1);
    assert.equal(host.hostSintaticamenteValido(acima, PORTA), null);
    // o diretório sozinho caberia; com porta de 5 dígitos o caminho completo estoura
    const dir4 = dirComSocketDe(limite, 543);
    assert.deepEqual(host.hostSintaticamenteValido(dir4, 543), { tipo: 'SOCKET' });
    assert.equal(host.hostSintaticamenteValido(dir4, 54321), null);
    assert.equal(host.hostAutorizavel(dir4), false, 'a lista de autorizados considera a porta mais longa');
  });

  teste('HS-A04 — socket exige porta válida; nome de host não depende dela', () => {
    for (const porta of [0, -1, 65536, 1.5, '5432', undefined, null]) assert.equal(host.hostSintaticamenteValido('/private/tmp/gh-x', porta), null, String(porta));
    assert.deepEqual(host.hostSintaticamenteValido('127.0.0.1', undefined), { tipo: 'NOME' });
  });
});

describe('[HS-B] validação física do diretório do socket', () => {
  teste('HS-B01 — diretório real, próprio e privado (0700) é aceito; nome de host dispensa disco', () => {
    assert.equal(host.socketFisicoSeguro(novoSocketDir(), PORTA), true);
    assert.equal(host.socketFisicoSeguro('127.0.0.1', PORTA), true);
  });

  teste('HS-B02 — inexistente, arquivo comum, grupo/outros com acesso (0750, 0755, 0770, 0701) são recusados', () => {
    assert.equal(host.socketFisicoSeguro(path.join(BASE, 'gh-inexistente-zzzzzz'), PORTA), false);
    const dir = novoSocketDir();
    const arquivo = path.join(dir, 'f');
    fs.writeFileSync(arquivo, 'x');
    assert.equal(host.socketFisicoSeguro(arquivo, PORTA), false);
    for (const modo of [0o750, 0o755, 0o770, 0o701, 0o707]) assert.equal(host.socketFisicoSeguro(novoSocketDir(modo), PORTA), false, modo.toString(8));
  });

  teste('HS-B03 — LINK SIMBÓLICO inseguro é recusado: o próprio diretório sendo link, e um antecessor sendo link', () => {
    const real = novoSocketDir();
    const link = path.join(BASE, `gh-lnk-${Math.random().toString(36).slice(2, 8)}`);
    fs.symlinkSync(real, link);
    criados.push(link);
    assert.equal(host.socketFisicoSeguro(link, PORTA), false, 'o diretório é um link');
    const sub = path.join(real, 'sub');
    fs.mkdirSync(sub, { mode: 0o700 });
    const viaLink = path.join(link, 'sub');
    assert.equal(host.socketFisicoSeguro(viaLink, PORTA), false, 'um antecessor é link (o caminho não é o resolvido)');
    assert.equal(host.socketFisicoSeguro(sub, PORTA), true);
    fs.rmdirSync(sub);
    fs.unlinkSync(link);
  });

  teste('HS-B04 — nada abre conexão: a validação não cria socket nem arquivo no diretório', () => {
    const dir = novoSocketDir();
    host.socketFisicoSeguro(dir, PORTA);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ lançador do pg_dump
function spawnFalso() {
  const chamadas = [];
  const spawn = (exe, args, opcoes) => {
    chamadas.push({ exe, args, opcoes });
    const filho = new EventEmitter();
    filho.pid = 8301;
    setImmediate(() => filho.emit('spawn'));
    return filho;
  };
  return { chamadas, spawn };
}
const specDump = (hostVal, porta = PORTA, extra = {}) => ({
  executavel: '/usr/bin/pg_dump',
  argumentos: ['--format=custom', '--no-password', '--snapshot=00000003-0000001B-1', '--dbname=gepi_hom'],
  ambiente: { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: hostVal, PGPORT: String(porta), PGUSER: 'gepi_hom', ...extra },
  opcoes: { shell: false, detached: true, stdio: ['ignore', 9, 'ignore'] },
});

describe('[HS-C] lançador do pg_dump', () => {
  teste('HS-C01 — socket válido: PGHOST explícito é PRESERVADO no spawn, ambiente com exatamente as quatro variáveis (nenhum PGHOSTADDR, nenhum fallback)', async () => {
    const dir = novoSocketDir();
    const falso = spawnFalso();
    await criarLancadorComSpawn({ spawn: falso.spawn }).lancar(specDump(dir));
    assert.equal(falso.chamadas.length, 1);
    assert.deepEqual(falso.chamadas[0].opcoes.env, { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: dir, PGPORT: String(PORTA), PGUSER: 'gepi_hom' });
    assert.equal(Object.hasOwn(falso.chamadas[0].opcoes.env, 'PGHOSTADDR'), false);
    assert.equal(falso.chamadas[0].opcoes.env.PGHOST.startsWith('/'), true, 'socket Unix, nunca TCP');
  });

  teste('HS-C02 — host tradicional continua aceito', async () => {
    const falso = spawnFalso();
    await criarLancadorComSpawn({ spawn: falso.spawn }).lancar(specDump('127.0.0.1'));
    assert.equal(falso.chamadas[0].opcoes.env.PGHOST, '127.0.0.1');
  });

  teste('HS-C03 — recusados SEM spawn: relativo, `..`, longo demais (caminho completo), 0755, inexistente, link, host vazio e implícito', async () => {
    const real = novoSocketDir();
    const link = path.join(BASE, `gh-lnk-${Math.random().toString(36).slice(2, 8)}`);
    fs.symlinkSync(real, link);
    criados.push(link);
    const casos = {
      relativo: 'relativo/dir',
      pontos: `${real}/../${path.basename(real)}`,
      longo: dirComSocketDe(host.LIMITE_SUN_PATH + 1),
      aberto: novoSocketDir(0o755),
      inexistente: path.join(BASE, 'gh-nao-existe-zzzz'),
      link,
      vazio: '',
    };
    for (const [rotulo, h] of Object.entries(casos)) {
      const falso = spawnFalso();
      await assert.rejects(() => criarLancadorComSpawn({ spawn: falso.spawn }).lancar(specDump(h)), (e) => e.code === 'SPEC_INVALIDO', rotulo);
      assert.equal(falso.chamadas.length, 0, rotulo);
    }
    const semHost = spawnFalso();
    const ambiente = specDump(real).ambiente;
    delete ambiente.PGHOST;
    await assert.rejects(() => criarLancadorComSpawn({ spawn: semHost.spawn }).lancar({ ...specDump(real), ambiente }), (e) => e.code === 'SPEC_INVALIDO');
    assert.equal(semHost.chamadas.length, 0);
    fs.unlinkSync(link);
  });

  teste('HS-C04 — o limite considera a PORTA: o mesmo diretório passa com porta curta e é recusado com porta de 5 dígitos', async () => {
    const dir = dirComSocketDe(host.LIMITE_SUN_PATH, 543);
    // o diretório sintético não existe no disco: a sintaxe passa, a validação física recusa; o caso é decidido pelo limite quando o diretório é real
    const falso = spawnFalso();
    await assert.rejects(() => criarLancadorComSpawn({ spawn: falso.spawn }).lancar(specDump(dir, 54321)), (e) => e.code === 'SPEC_INVALIDO');
    assert.equal(falso.chamadas.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ serviço do pg_dump
function dumpConfig(hostVal, extras = {}) {
  const chamadas = { criarExclusivo: 0, lancar: 0 };
  const contexto = Object.freeze({ snapshotId: '00000003-0000001B-1', banco: Object.freeze({ nome: 'gepi_hom', oid: '16384' }), registros: Object.freeze({ padrao: Object.freeze([]), empresa: Object.freeze([]) }), plano: null });
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: hostVal, porta: PORTA, usuario: 'gepi_hom', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gepi_hom', oid: '16384' } },
    destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump.pgdump' },
    lancador: { async lancar() { chamadas.lancar += 1; return { pid: 8401, saida: new Promise(() => {}), fluxosFechados: new Promise(() => {}) }; } },
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
    arquivos: { async criarExclusivo() { chamadas.criarExclusivo += 1; return { descritor: 9, fechar() {} }; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    ...extras,
  };
  return { contexto, dump, chamadas };
}

describe('[HS-D] serviço do pg_dump', () => {
  teste('HS-D01 — socket válido e host tradicional são aceitos na construção; PGHOST do spec é o host informado', async () => {
    const dir = novoSocketDir();
    for (const h of [dir, '127.0.0.1']) {
      const { contexto, dump, chamadas } = dumpConfig(h);
      const descricao = criarProcessoDoDump({ contexto, dump });
      assert.equal(typeof descricao.iniciar, 'function');
      assert.equal(chamadas.criarExclusivo + chamadas.lancar, 0, 'construir não tem efeito');
    }
  });

  teste('HS-D02 — configuração recusada na construção: relativo, `..`, caminho completo longo demais, socket com porta fora do intervalo, host ausente ou implícito', () => {
    const real = novoSocketDir();
    for (const h of ['relativo/dir', `${real}/../x`, dirComSocketDe(host.LIMITE_SUN_PATH + 1), '', undefined, null, '//dir']) {
      const { contexto, dump } = dumpConfig(h);
      assert.throws(() => criarProcessoDoDump({ contexto, dump }), TypeError, String(h));
    }
    const { contexto, dump } = dumpConfig(real);
    dump.alvo.porta = 70000;
    assert.throws(() => criarProcessoDoDump({ contexto, dump }), TypeError);
  });

  teste('HS-D03 — diretório do socket inseguro (0755, inexistente) é recusado em `iniciar()` ANTES de criar o arquivo do dump ou lançar o processo', async () => {
    for (const h of [novoSocketDir(0o755), path.join(BASE, 'gh-nao-existe-yyyy')]) {
      const { contexto, dump, chamadas } = dumpConfig(h);
      const descricao = criarProcessoDoDump({ contexto, dump });
      await assert.rejects(() => descricao.iniciar());
      assert.deepEqual([chamadas.criarExclusivo, chamadas.lancar], [0, 0]);
    }
  });

  teste('HS-D04 — com socket seguro o `iniciar()` cria o arquivo e lança com PGHOST = o diretório informado', async () => {
    const dir = novoSocketDir();
    const vistos = [];
    const { contexto, dump, chamadas } = dumpConfig(dir);
    dump.lancador = { async lancar(spec) { chamadas.lancar += 1; vistos.push(spec.ambiente.PGHOST); return { pid: 8402, saida: new Promise(() => {}), fluxosFechados: new Promise(() => {}) }; } };
    await criarProcessoDoDump({ contexto, dump }).iniciar();
    assert.deepEqual(vistos, [dir]);
    assert.deepEqual([chamadas.criarExclusivo, chamadas.lancar], [1, 1]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ restauração
const specRestore = (hostVal, banco = 'gepi_hom_dest', porta = PORTA) => ({
  executavel: '/usr/bin/pg_restore',
  argumentos: ['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${banco}`],
  ambiente: { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: hostVal, PGPORT: String(porta), PGUSER: 'gepi_hom' },
  opcoes: { shell: false, detached: true, stdio: [9, 'ignore', 'ignore'] },
});
const politica = (hosts) => ({ prefixoDoBanco: 'gepi_hom_', hostsAutorizados: hosts, bancosProtegidos: ['gestao_epi'] });

describe('[HS-E] lançador do pg_restore', () => {
  teste('HS-E01 — socket autorizado e seguro: PGHOST preservado; sem fallback; host tradicional autorizado preservado', async () => {
    const dir = novoSocketDir();
    const falso = spawnFalso();
    await criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: politica([dir, '127.0.0.1']) }).lancar(specRestore(dir));
    assert.deepEqual(falso.chamadas[0].opcoes.env, { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: dir, PGPORT: String(PORTA), PGUSER: 'gepi_hom' });
    const f2 = spawnFalso();
    await criarLancadorDeRestauracaoComSpawn({ spawn: f2.spawn, politicaDeDestino: politica([dir, '127.0.0.1']) }).lancar(specRestore('127.0.0.1'));
    assert.equal(f2.chamadas[0].opcoes.env.PGHOST, '127.0.0.1');
  });

  teste('HS-E02 — socket FORA da lista, TCP não listado quando a lista só tem o socket e o implícito são recusados sem spawn', async () => {
    const dir = novoSocketDir();
    const outro = novoSocketDir();
    const casos = [[outro, 'DESTINO_NAO_AUTORIZADO'], ['127.0.0.1', 'DESTINO_NAO_AUTORIZADO'], ['localhost', 'DESTINO_NAO_AUTORIZADO']];
    for (const [h, codigo] of casos) {
      const falso = spawnFalso();
      await assert.rejects(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: politica([dir]) }).lancar(specRestore(h)), (e) => e.code === codigo, h);
      assert.equal(falso.chamadas.length, 0);
    }
    const implicito = spawnFalso();
    const spec = specRestore(dir);
    delete spec.ambiente.PGHOST;
    await assert.rejects(() => criarLancadorDeRestauracaoComSpawn({ spawn: implicito.spawn, politicaDeDestino: politica([dir]) }).lancar(spec), (e) => e.code === 'SPEC_INVALIDO');
    assert.equal(implicito.chamadas.length, 0);
  });

  teste('HS-E03 — inseguros mesmo estando na lista: 0755, link, inexistente, relativo, `..` e caminho completo longo demais; a lista rejeita itens que não cabem ou não são canônicos', async () => {
    const aberto = novoSocketDir(0o755);
    const real = novoSocketDir();
    const link = path.join(BASE, `gh-lnk-${Math.random().toString(36).slice(2, 8)}`);
    fs.symlinkSync(real, link);
    criados.push(link);
    for (const h of [aberto, link, path.join(BASE, 'gh-nao-existe-wwww')]) {
      const falso = spawnFalso();
      await assert.rejects(() => criarLancadorDeRestauracaoComSpawn({ spawn: falso.spawn, politicaDeDestino: politica([h]) }).lancar(specRestore(h)), (e) => e.code === 'SPEC_INVALIDO', h);
      assert.equal(falso.chamadas.length, 0);
    }
    for (const ruim of ['relativo/dir', `${real}/../x`, dirComSocketDe(host.LIMITE_SUN_PATH + 1), '/dir/', '']) {
      assert.throws(() => criarLancadorDeRestauracaoComSpawn({ spawn: () => {}, politicaDeDestino: politica([ruim]) }), TypeError, ruim);
    }
    fs.unlinkSync(link);
  });
});

function restauradorBanco(hosts, lancador) {
  return criarRestauradorDoBanco({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador,
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    politicaDeDestino: politica(hosts),
  });
}
const destinoBanco = (hostVal, extra = {}) => ({ banco: 'gepi_hom_dest', host: hostVal, porta: PORTA, usuario: 'gepi_hom', arquivoDeSenha: '/tmp/senha-ficticia', ...extra });

describe('[HS-F] política de destino do restaurador do banco', () => {
  teste('HS-F01 — destino por socket autorizado e seguro; host tradicional preservado; qualquer outro é recusado (autorizarDestino, sem lançar nada)', () => {
    const dir = novoSocketDir();
    const r = restauradorBanco([dir, '127.0.0.1'], { lancar() { throw new Error('não deve lançar'); } });
    assert.equal(r.autorizarDestino(destinoBanco(dir)), true);
    assert.equal(r.autorizarDestino(destinoBanco('127.0.0.1')), true);
    assert.equal(r.autorizarDestino(destinoBanco(novoSocketDir())), false, 'socket fora da lista');
    assert.equal(r.autorizarDestino(destinoBanco('localhost')), false, 'host não listado');
    assert.equal(r.autorizarDestino(destinoBanco(undefined)), false, 'host ausente/implícito');
    assert.equal(r.autorizarDestino(destinoBanco('')), false);
    assert.equal(r.autorizarDestino(destinoBanco(dir, { banco: 'gestao_epi' })), false, 'banco protegido');
    assert.equal(r.autorizarDestino(destinoBanco(dir, { porta: 70000 })), false);
  });

  teste('HS-F02 — socket listado mas INSEGURO (0755, removido depois, link) é recusado na hora da autorização', () => {
    const dir = novoSocketDir();
    const r = restauradorBanco([dir], { lancar() {} });
    assert.equal(r.autorizarDestino(destinoBanco(dir)), true);
    fs.chmodSync(dir, 0o755);
    assert.equal(r.autorizarDestino(destinoBanco(dir)), false, 'o disco é conferido de novo a cada autorização');
    fs.chmodSync(dir, 0o700);
    assert.equal(r.autorizarDestino(destinoBanco(dir)), true);
  });

  teste('HS-F03 — política inválida na construção: item não canônico ou longo demais; lista vazia continua recusando tudo', () => {
    for (const ruim of ['relativo/dir', '/dir/../x', dirComSocketDe(host.LIMITE_SUN_PATH + 1)]) assert.throws(() => restauradorBanco([ruim], { lancar() {} }), TypeError, ruim);
    assert.equal(restauradorBanco([], { lancar() {} }).autorizarDestino(destinoBanco('127.0.0.1')), false);
  });

  teste('HS-F04 — INTEGRAÇÃO restaurador + lançador por socket: restaura (spawn falso) com PGHOST explícito; destino de outro socket não lança nada', async () => {
    const dir = novoSocketDir();
    const falso = spawnFalso();
    const lancador = criarLancadorDeRestauracaoComSpawn({ spawn: (...a) => { const f = falso.spawn(...a); setImmediate(() => { f.emit('exit', 0, null); f.emit('close', 0, null); }); return f; }, politicaDeDestino: politica([dir]) });
    const r = restauradorBanco([dir], lancador);
    const fd = fs.openSync(__filename, 'r');
    try {
      const ok = await r.restaurar({ destino: destinoBanco(dir), dump: { descritor: fd, bytes: 10, sha256: 'a'.repeat(64) } });
      assert.equal(ok.ok, true, ok.motivo);
      assert.equal(ok.restauracaoReal, false);
      assert.equal(falso.chamadas.length, 1);
      assert.equal(falso.chamadas[0].opcoes.env.PGHOST, dir);
      const negado = await r.restaurar({ destino: destinoBanco(novoSocketDir()), dump: { descritor: fd, bytes: 10, sha256: 'a'.repeat(64) } });
      assert.deepEqual([negado.ok, negado.motivo], [false, 'DESTINO_NAO_AUTORIZADO']);
      assert.equal(falso.chamadas.length, 1);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe('[HOST-TLS] D-F7: auxiliares de TLS do host (opt-in)', () => {
  const os = require('node:os');
  const pasta = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'host-tls-'));
  after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const cert = path.join(pasta, 'ca.pem');
  fs.writeFileSync(cert, 'sintetico', { mode: 0o600 });
  const BASE_CHAVES = ['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGUSER'];
  const amb = (extra = {}) => ({ PGPASSFILE: '/x/pgpass', PGHOST: 'db.exemplo', PGPORT: '5432', PGUSER: 'u', ...extra });

  test('HTLS-01 — certificadoRaizSeguro: arquivo próprio 0600/0644 canônico passa; frouxo, elo, relativo, inexistente e vazio não', () => {
    assert.equal(host.certificadoRaizSeguro(cert), true);
    const frouxo = path.join(pasta, 'frouxo.pem'); fs.writeFileSync(frouxo, 'x'); fs.chmodSync(frouxo, 0o666);
    const elo = path.join(pasta, 'elo.pem'); fs.symlinkSync(cert, elo);
    const vazio = path.join(pasta, 'vazio.pem'); fs.writeFileSync(vazio, '', { mode: 0o600 });
    for (const ruim of [frouxo, elo, 'ca.pem', path.join(pasta, 'nao.pem'), vazio, pasta, undefined]) assert.equal(host.certificadoRaizSeguro(ruim), false, String(ruim));
  });

  test('HTLS-02 — formaDoAmbiente: BASE, TLS (par completo) ou null', () => {
    assert.equal(host.formaDoAmbiente(amb(), BASE_CHAVES), 'BASE');
    assert.equal(host.formaDoAmbiente(amb({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert }), BASE_CHAVES), 'TLS');
    assert.equal(host.formaDoAmbiente(amb({ PGSSLMODE: 'verify-full' }), BASE_CHAVES), null);
    assert.equal(host.formaDoAmbiente(amb({ PGSSLROOTCERT: cert }), BASE_CHAVES), null);
    assert.equal(host.formaDoAmbiente(amb({ OUTRA: 'x' }), BASE_CHAVES), null);
    assert.equal(host.formaDoAmbiente(null, BASE_CHAVES), null);
    assert.equal(host.formaDoAmbiente([], BASE_CHAVES), null);
  });

  test('HTLS-03 — tlsDoAmbienteValido exige verify-full, host por nome e CA segura', () => {
    assert.equal(host.tlsDoAmbienteValido({ modo: 'verify-full', raiz: cert, host: 'db.exemplo', porta: 5432 }), true);
    assert.equal(host.tlsDoAmbienteValido({ modo: 'require', raiz: cert, host: 'db.exemplo', porta: 5432 }), false);
    assert.equal(host.tlsDoAmbienteValido({ modo: 'verify-full', raiz: cert, host: '127.0.0.1', porta: 5432 }), true, 'IP é host por NOME (TCP)');
    assert.equal(host.tlsDoAmbienteValido({ modo: 'verify-full', raiz: cert, host: pasta, porta: 5432 }), false);
    assert.equal(host.tlsDoAmbienteValido({ modo: 'verify-full', raiz: path.join(pasta, 'nao.pem'), host: 'db.exemplo', porta: 5432 }), false);
  });
});
