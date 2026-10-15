'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const pg = require('pg');
const request = require('supertest');
const g = require('../integracao/helpers/guarda-instancia-dedicada');

/**
 * Guarda D1 do RED integrado J2a — testes ISOLADOS, sem PostgreSQL.
 * Nunca abrem conexão com a porta 5432, com a 55432 nem com soquete Unix real:
 *  - tudo o que apontaria a esses destinos é exercitado com DUBLÊS de `pg` e de `net` (nada sai do processo);
 *  - o `pg` real e o `net` real só conversam com um servidor FALSO do protocolo, em 127.0.0.1 numa porta efêmera, que o próprio
 *    teste abre (não é PostgreSQL). O teste aborta se a porta efêmera coincidir com 5432 ou 55432.
 * O que depende do servidor real (identidade verdadeira, schemas, migrations) fica NÃO VALIDADO aqui e é reservado ao próximo marco.
 */

const UUID = 'A1B2C3D4-0000-4000-8000-0123456789AB';
const SISTEMA = '7696319697861317712';
const MARCADOR = g.marcadorEsperado(UUID, SISTEMA);
const SENHA = 'SENHA-FALSA-PARA-TESTE-DA-GUARDA-0123456789ABCDEF';
const CAMINHO_ENV = '/caminho/ficticio/ambiente-teste.env';
const ENV_OK = Object.freeze({
  DB_HOST: '127.0.0.1', DB_PORT: '55432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'gepi_teste_j2a', NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: CAMINHO_ENV, DOTENV_CONFIG_QUIET: 'true', DB_PASSWORD: SENHA, PATH: '/usr/bin:/bin', HOME: '/home/teste', LANG: 'C.UTF-8',
});
const mensagensVistas = [];
const anotar = (...textos) => { for (const t of textos) mensagensVistas.push(String(t)); };

// ───────────────────────── servidor falso do protocolo (não é PostgreSQL) ─────────────────────────
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const mensagem = (tipo, corpo) => Buffer.concat([Buffer.from(tipo, 'latin1'), int32(corpo.length + 4), corpo]);
const campo = (nome, oid) => Buffer.concat([cstr(nome), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)]);
const celula = (v) => { if (v === null) return int32(-1); const b = Buffer.from(String(v), 'utf8'); return Buffer.concat([int32(b.length), b]); };
function respostaConsulta(colunas, linhas) {
  const partes = [mensagem('T', Buffer.concat([int16(colunas.length), ...colunas.map((c) => campo(c.nome, c.oid))]))];
  for (const linha of linhas) partes.push(mensagem('D', Buffer.concat([int16(linha.length), ...linha.map(celula)])));
  partes.push(mensagem('C', cstr(`SELECT ${linhas.length}`)), mensagem('Z', Buffer.from('I')));
  return Buffer.concat(partes);
}
const COLUNAS_IDENTIDADE = [{ nome: 'banco', oid: 25 }, { nome: 'papel', oid: 25 }, { nome: 'porta', oid: 23 }, { nome: 'cluster', oid: 25 }, { nome: 'marcador', oid: 25 }];

function criarServidorFalso() {
  const registro = [];
  const sockets = new Set();
  const api = { porta: 0, registro, modo: 'normal', atrasoIdentidadeMs: 0, identidade: null };
  let contador = 0;
  const servidor = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    contador += 1;
    const id = contador;
    registro.push({ conexao: id, evento: 'conexao' });
    if (api.modo === 'fechar-na-conexao') { socket.destroy(); return; }
    let buffer = Buffer.alloc(0);
    let iniciou = false;
    const responder = (sql) => {
      if (sql !== g.SQL_IDENTIDADE) { socket.write(respostaConsulta([{ nome: 'n', oid: 23 }], [[1]])); return; }
      if (api.modo === 'fechar-na-consulta') { socket.destroy(); return; }
      if (api.modo === 'sem-resposta') return;
      const enviar = () => {
        const i = api.identidade;
        const linhas = api.modo === 'sem-linhas' ? [] : [[i.banco, i.papel, i.porta, i.cluster, i.marcador]];
        socket.write(respostaConsulta(COLUNAS_IDENTIDADE, linhas));
        registro.push({ conexao: id, evento: 'identidade-respondida' });
      };
      if (api.atrasoIdentidadeMs > 0) setTimeout(enviar, api.atrasoIdentidadeMs); else enviar();
    };
    const drenar = () => {
      for (;;) {
        if (!iniciou) {
          if (buffer.length < 4) return;
          const tamanho = buffer.readInt32BE(0);
          if (buffer.length < tamanho) return;
          buffer = buffer.subarray(tamanho);
          iniciou = true;
          socket.write(Buffer.concat([mensagem('R', int32(0)), mensagem('S', Buffer.concat([cstr('server_version'), cstr('16.15')])), mensagem('K', Buffer.concat([int32(1), int32(2)])), mensagem('Z', Buffer.from('I'))]));
          continue;
        }
        if (buffer.length < 5) return;
        const tipo = String.fromCharCode(buffer[0]);
        const tamanho = buffer.readInt32BE(1);
        if (buffer.length < tamanho + 1) return;
        const corpo = buffer.subarray(5, tamanho + 1);
        buffer = buffer.subarray(tamanho + 1);
        if (tipo === 'Q') {
          const sql = corpo.subarray(0, corpo.length - 1).toString('utf8');
          registro.push({ conexao: id, evento: 'consulta', sql });
          responder(sql);
        } else if (tipo === 'X') {
          socket.end();
        }
      }
    };
    socket.on('data', (dados) => { buffer = Buffer.concat([buffer, dados]); drenar(); });
  });
  api.iniciar = () => new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => {
      api.porta = servidor.address().port;
      assert.ok(api.porta !== 5432 && api.porta !== 55432, 'porta efêmera coincide com uma porta proibida: teste abortado');
      resolver(api);
    });
  });
  api.reiniciarEstado = () => {
    registro.length = 0; api.modo = 'normal'; api.atrasoIdentidadeMs = 0;
    api.identidade = { banco: 'gestao_epi_teste_local', papel: 'gepi_teste_j2a', porta: api.porta, cluster: 'gepi_teste_j2a', marcador: MARCADOR };
  };
  api.fechar = () => new Promise((resolver) => { for (const s of sockets) s.destroy(); servidor.close(() => resolver()); });
  return api;
}

const configCliente = (alvo, extra = {}) => ({ host: alvo.host, port: alvo.port, database: alvo.database, user: alvo.user, password: SENHA, connectionTimeoutMillis: 5000, ...extra });
const consultasDe = (servidor) => servidor.registro.filter((e) => e.evento === 'consulta');
const naoIdentidade = (servidor) => consultasDe(servidor).filter((e) => e.sql !== g.SQL_IDENTIDADE);
const comTempoMaximo = (promessa, ms, rotulo) => Promise.race([promessa, new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error(`${rotulo}: tempo esgotado (possível deadlock)`)), ms).unref(); })]);

async function comGuarda(servidor, extra, corpo) {
  const falhas = [];
  const alvo = { ...g.ALVO, port: servidor.porta };
  servidor.reiniciarEstado();
  const instalada = g.instalarGuarda({ pg, net, alvo, marcador: MARCADOR, aoFalhar: (m) => falhas.push(m), ...extra });
  try {
    return await corpo({ falhas, alvo });
  } finally {
    instalada.desinstalar();
    anotar(...falhas);
  }
}

// ───────────────────────── dublês (sem rede) ─────────────────────────
function criarDoubles(linhaDeIdentidade) {
  const chamadas = { redeOriginal: [], connectOriginal: 0 };
  const rede = { Socket: { prototype: { connect(...args) { chamadas.redeOriginal.push(args); return undefined; } } } };
  class ClienteFalso extends EventEmitter {
    constructor(c) { super(); this.host = c.host; this.port = c.port; this.database = c.database; this.user = c.user; }

    _connect(callback) {
      chamadas.connectOriginal += 1;
      rede.Socket.prototype.connect(this.port, this.host);
      process.nextTick(() => callback(null, this));
    }

    query() { return Promise.resolve({ rows: linhaDeIdentidade ? [linhaDeIdentidade] : [] }); }
  }
  return { chamadas, rede, ClienteFalso, pgFalso: { Client: ClienteFalso } };
}
const aguardarConexao = (cliente) => new Promise((resolver) => { cliente._connect((erro) => resolver(erro)); });

describe('Guarda D1 (J2a) — funções puras', () => {
  test('G01 — ambiente correto é aceito; cada divergência é recusada sem revelar valores nem a senha', () => {
    assert.equal(g.validarAmbiente(ENV_OK, [], CAMINHO_ENV), null);
    const divergencias = [
      ['DB_HOST', { DB_HOST: 'localhost' }], ['DB_HOST', { DB_HOST: '10.0.0.5' }], ['DB_PORT', { DB_PORT: '5432' }], ['DB_PORT', { DB_PORT: '' }],
      ['DB_NAME', { DB_NAME: 'gestao_epi_dev' }], ['DB_USER', { DB_USER: 'postgres' }], ['NODE_ENV', { NODE_ENV: 'production' }],
      ['DOTENV_CONFIG_PATH', { DOTENV_CONFIG_PATH: '/outro/arquivo.env' }], ['DB_PASSWORD', { DB_PASSWORD: 'curta' }], ['DB_PASSWORD', { DB_PASSWORD: undefined }],
    ];
    for (const [nome, troca] of divergencias) {
      const motivo = g.validarAmbiente({ ...ENV_OK, ...troca }, [], CAMINHO_ENV);
      assert.ok(typeof motivo === 'string' && motivo.includes(nome), `${nome}: ${motivo}`);
      assert.equal(String(motivo).includes(SENHA), false);
      anotar(motivo);
    }
    const semDb = { ...ENV_OK }; delete semDb.DB_HOST;
    assert.match(g.validarAmbiente(semDb, [], CAMINHO_ENV), /DB_HOST/);
  });

  test('G02 — configuração herdada inesperada é recusada (PG*, DATABASE_URL, NODE_OPTIONS, NODE_PG_FORCE_NATIVE, DOTENV_KEY/OVERRIDE, --env-file)', () => {
    for (const nome of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGPASSFILE', 'PGSERVICE', 'pghost', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_PG_FORCE_NATIVE', 'DOTENV_KEY', 'DOTENV_ENVIRONMENT', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_CONFIG_DOTENV_KEY']) {
      const motivo = g.validarAmbiente({ ...ENV_OK, [nome]: 'x' }, [], CAMINHO_ENV);
      assert.match(motivo, /variável proibida presente/, nome);
      assert.equal(motivo.includes(SENHA), false);
    }
    assert.match(g.validarAmbiente(ENV_OK, ['--env-file=.env'], CAMINHO_ENV), /--env-file/);
    assert.equal(g.validarAmbiente({ ...ENV_OK, DOTENV_CONFIG_QUIET: 'true' }, ['--test', '--require', 'x'], CAMINHO_ENV), null);
  });

  test('G03 — o marcador esperado é montado com IDENTIDADE e SYSTEM_ID válidos; formato inválido é recusado', () => {
    assert.equal(g.marcadorEsperado(UUID, SISTEMA), `GEPI_J2A_ISOLADO:${UUID}:${SISTEMA}`);
    assert.throws(() => g.marcadorEsperado('nao-e-uuid', SISTEMA), /formato inválido/);
    assert.throws(() => g.marcadorEsperado(UUID, 'abc'), /formato inválido/);
    assert.throws(() => g.marcadorEsperado(UUID, ''), /formato inválido/);
  });

  test('G04 — o destino do cliente só é aceito com host, porta, banco e papel exatos (fallbacks de host, porta e papel são recusados)', () => {
    const base = { host: '127.0.0.1', port: 55432, database: 'gestao_epi_teste_local', user: 'gepi_teste_j2a' };
    assert.equal(g.destinoDoClienteOk(base), true);
    assert.equal(g.destinoDoClienteOk({ ...base, port: '55432' }), true);
    for (const troca of [{ port: 5432 }, { port: NaN }, { port: undefined }, { host: 'localhost' }, { host: undefined }, { host: '/var/run/postgresql' }, { host: '::1' }, { database: 'gestao_epi_dev' }, { database: undefined }, { user: 'postgres' }, { user: undefined }]) {
      assert.equal(g.destinoDoClienteOk({ ...base, ...troca }), false, JSON.stringify(troca));
    }
  });

  test('G05 — a identidade só é aceita com banco, papel, porta, cluster e marcador exatos; ausência de linha é recusada', () => {
    const base = { banco: 'gestao_epi_teste_local', papel: 'gepi_teste_j2a', porta: 55432, cluster: 'gepi_teste_j2a', marcador: MARCADOR };
    assert.equal(g.identidadeOk(base, MARCADOR), true);
    assert.equal(g.identidadeOk({ ...base, porta: '55432' }, MARCADOR), true);
    for (const troca of [{ banco: 'outro' }, { papel: 'postgres' }, { porta: 5432 }, { cluster: 'compartilhado' }, { marcador: 'GEPI_J2A_ISOLADO:X:1' }, { marcador: null }, { marcador: undefined }]) {
      assert.equal(g.identidadeOk({ ...base, ...troca }, MARCADOR), false, JSON.stringify(troca));
    }
    assert.equal(g.identidadeOk(undefined, MARCADOR), false);
    assert.equal(g.identidadeOk(null, MARCADOR), false);
  });

  test('G06 — normalização e regras de rede: loopback efêmero passa; 5432, soquete Unix, host externo, 55432 fora do cliente e formas desconhecidas são recusados', () => {
    const alvo = g.ALVO;
    const permitido = (args, dentro = false) => g.recusaDeRede(g.normalizarDestino(args), dentro, alvo);
    assert.equal(permitido([50000, '127.0.0.1']), null);
    assert.equal(permitido([{ port: 50001, host: '::1' }]), null);
    assert.equal(permitido([[{ port: 50002, host: '127.0.0.1' }, () => {}]]), null);
    assert.equal(permitido([{ port: 50003, host: '127.0.0.1', path: null }]), null, 'o agente HTTP passa path nulo em conexões TCP');
    assert.equal(permitido([{ port: 50004, host: '127.0.0.1', path: '' }]), null);
    assert.match(permitido([{ port: 50005, host: '127.0.0.1', path: '/tmp/x.sock' }]), /soquete Unix/, 'path verdadeiro é IPC no Node, mesmo com porta');
    assert.equal(permitido([55432, '127.0.0.1'], true), null);
    for (const args of [[5432, '127.0.0.1'], [5432, '::1'], ['5432', '127.0.0.1'], [{ port: 5432, host: '127.0.0.1' }], [[{ port: 5432, host: '127.0.0.1' }, () => {}]], [5432]]) {
      assert.match(permitido(args, true) ?? 'ok', /5432|host de conexão/, JSON.stringify(args));
    }
    assert.match(permitido(['/tmp/.s.PGSQL.5432']), /soquete Unix/);
    assert.match(permitido([{ path: '/tmp/x.sock' }]), /soquete Unix/);
    assert.match(permitido([50000, 'localhost']), /host de conexão/);
    assert.match(permitido([50000, '10.0.0.5']), /host de conexão/);
    assert.match(permitido([50000]), /host de conexão/);
    assert.match(permitido([55432, '127.0.0.1'], false), /fora do cliente guardado/);
    assert.match(permitido([55432, '::1'], true), /fora do cliente guardado/);
    assert.match(permitido([undefined]), /não reconhecido/);
    assert.match(permitido([]), /não reconhecido/);
  });
});

describe('Guarda D1 (J2a) — dublês de pg e de rede (nada sai do processo)', () => {
  const linhaOk = { banco: g.ALVO.database, papel: g.ALVO.user, porta: g.ALVO.port, cluster: g.ALVO.cluster, marcador: MARCADOR };

  test('G10 — destino aponta para 5432, outro host/porta/banco/papel ou fallback: recusado ANTES de qualquer conexão', async () => {
    const base = { host: '127.0.0.1', port: 55432, database: 'gestao_epi_teste_local', user: 'gepi_teste_j2a' };
    for (const troca of [{ port: 5432 }, { port: NaN }, { host: 'localhost' }, { host: undefined }, { host: '/var/run/postgresql' }, { host: '10.0.0.5' }, { database: 'gestao_epi_homolog_local' }, { user: 'postgres' }]) {
      const d = criarDoubles(linhaOk);
      const falhas = [];
      const instalada = g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar: (m) => falhas.push(m) });
      try {
        const erro = await aguardarConexao(new d.ClienteFalso({ ...base, ...troca }));
        assert.match(String(erro?.message), /GUARDA J2a/, JSON.stringify(troca));
        assert.equal(d.chamadas.connectOriginal, 0, `${JSON.stringify(troca)}: _connect original não pode ser chamado`);
        assert.equal(d.chamadas.redeOriginal.length, 0, 'nenhum pacote/conexão de rede');
        assert.equal(falhas.length, 1);
        anotar(erro.message, ...falhas);
      } finally { instalada.desinstalar(); }
    }
  });

  test('G11 — destino e identidade corretos: conexão entregue e consultas liberadas; o dublê de rede só recebe o destino dedicado', async () => {
    const d = criarDoubles(linhaOk);
    const falhas = [];
    const instalada = g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar: (m) => falhas.push(m) });
    try {
      const cliente = new d.ClienteFalso({ host: '127.0.0.1', port: 55432, database: 'gestao_epi_teste_local', user: 'gepi_teste_j2a' });
      assert.throws(() => cliente.query('SELECT 1'), /antes da verificação/);
      const erro = await aguardarConexao(cliente);
      assert.equal(erro, null);
      assert.deepEqual(d.chamadas.redeOriginal, [[55432, '127.0.0.1']]);
      assert.deepEqual(await cliente.query('SELECT 1'), { rows: [linhaOk] });
      assert.equal(falhas.length, 1, 'só a consulta indevida anterior à verificação foi registrada');
    } finally { instalada.desinstalar(); }
  });

  test('G12 — identidade divergente ou ausente no dublê: conexão NUNCA entregue e erro seguro', async () => {
    for (const linha of [{ ...linhaOk, banco: 'outro' }, { ...linhaOk, papel: 'postgres' }, { ...linhaOk, porta: 5432 }, { ...linhaOk, cluster: 'compartilhado' }, { ...linhaOk, marcador: 'GEPI_J2A_ISOLADO:X:1' }, null]) {
      const d = criarDoubles(linha);
      const falhas = [];
      const instalada = g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar: (m) => falhas.push(m) });
      try {
        const cliente = new d.ClienteFalso({ host: '127.0.0.1', port: 55432, database: 'gestao_epi_teste_local', user: 'gepi_teste_j2a' });
        const erro = await aguardarConexao(cliente);
        assert.match(String(erro?.message), /identidade da instância divergente|GUARDA J2a/, JSON.stringify(linha));
        assert.ok(falhas.length >= 1);
        assert.throws(() => cliente.query('SELECT 1'), /antes da verificação/);
        anotar(erro.message, ...falhas);
      } finally { instalada.desinstalar(); }
    }
  });

  test('G13 — a rede guardada recusa 5432, soquete Unix, host externo e formas desconhecidas SEM chamar o connect original; aceita loopback efêmero', () => {
    const d = criarDoubles(linhaOk);
    const falhas = [];
    const instalada = g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar: (m) => falhas.push(m) });
    try {
      const conectar = (...args) => d.rede.Socket.prototype.connect(...args);
      for (const args of [[5432, '127.0.0.1'], [5432, '::1'], [5432], [{ port: 5432, host: '127.0.0.1' }], [[{ port: 5432, host: '127.0.0.1' }, () => {}]], ['/tmp/.s.PGSQL.5432'], [{ path: '/tmp/.s.PGSQL.5432' }], [50000, 'localhost'], [50000, '10.0.0.5'], [55432, '127.0.0.1'], [undefined]]) {
        assert.throws(() => conectar(...args), /GUARDA J2a/, JSON.stringify(args));
      }
      assert.equal(d.chamadas.redeOriginal.length, 0, 'nenhuma conexão chegou à rede');
      conectar(50000, '127.0.0.1');
      conectar({ port: 50001, host: '::1' });
      assert.equal(d.chamadas.redeOriginal.length, 2);
      assert.ok(falhas.length >= 11);
      anotar(...falhas);
    } finally { instalada.desinstalar(); }
  });

  test('G14 — a guarda não é instalada se a API interna do driver ou da rede estiver ausente, sem marcador ou instalada duas vezes', () => {
    const falhas = [];
    const aoFalhar = (m) => falhas.push(m);
    const d = criarDoubles(linhaOk);
    assert.throws(() => g.instalarGuarda({ pg: { Client: class {} }, net: d.rede, marcador: MARCADOR, aoFalhar }), /GUARDA J2a/);
    assert.throws(() => g.instalarGuarda({ pg: d.pgFalso, net: { Socket: { prototype: {} } }, marcador: MARCADOR, aoFalhar }), /GUARDA J2a/);
    assert.throws(() => g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: '', aoFalhar }), /GUARDA J2a/);
    const instalada = g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar });
    try {
      assert.throws(() => g.instalarGuarda({ pg: d.pgFalso, net: d.rede, marcador: MARCADOR, aoFalhar }), /já instalada/);
    } finally { instalada.desinstalar(); }
    assert.equal(falhas.length, 4);
  });
});

describe('Guarda D1 (J2a) — pg e net REAIS contra um servidor FALSO em loopback (não é PostgreSQL)', { timeout: 60000 }, () => {
  let servidor;
  before(async () => { servidor = await criarServidorFalso().iniciar(); });
  after(async () => { await servidor.fechar(); });

  test('G20 — Client (Promise): destino e identidade corretos; a primeira consulta da conexão é a de identidade e só depois a do chamador', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      const cliente = new pg.Client(configCliente(alvo));
      await cliente.connect();
      const resultado = await cliente.query('SELECT 1 AS n');
      assert.equal(resultado.rows[0].n, 1);
      await cliente.end();
      assert.deepEqual(falhas, []);
      const consultas = consultasDe(servidor);
      assert.equal(consultas[0].sql, g.SQL_IDENTIDADE);
      assert.equal(consultas[1].sql, 'SELECT 1 AS n');
      assert.equal(consultas.length, 2);
    });
  });

  test('G21 — Client (callback): mesma proteção', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      const cliente = new pg.Client(configCliente(alvo));
      await new Promise((resolver, rejeitar) => { cliente.connect((erro) => (erro ? rejeitar(erro) : resolver())); });
      assert.equal((await cliente.query('SELECT 1 AS n')).rows[0].n, 1);
      await cliente.end();
      assert.deepEqual(falhas, []);
      assert.equal(consultasDe(servidor)[0].sql, g.SQL_IDENTIDADE);
    });
  });

  test('G22 — a conexão só é liberada DEPOIS de a identidade ser respondida (resposta atrasada em 150 ms)', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      servidor.atrasoIdentidadeMs = 150;
      const cliente = new pg.Client(configCliente(alvo));
      const inicio = Date.now();
      await cliente.connect();
      const demora = Date.now() - inicio;
      assert.ok(demora >= 140, `connect() resolveu em ${demora} ms, antes da resposta de identidade`);
      assert.deepEqual(servidor.registro.map((e) => e.evento), ['conexao', 'consulta', 'identidade-respondida']);
      await cliente.query('SELECT 1 AS n');
      assert.deepEqual(servidor.registro.map((e) => e.evento), ['conexao', 'consulta', 'identidade-respondida', 'consulta']);
      await cliente.end();
      assert.deepEqual(falhas, []);
    });
  });

  test('G23 — Pool: toda conexão física nasce verificada (6 consultas simultâneas, até 3 conexões); a primeira consulta de cada conexão é a de identidade', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      const pool = new pg.Pool({ ...configCliente(alvo), max: 3 });
      try {
        assert.equal(pool.Client, pg.Client, 'o Pool usa a mesma classe Client protegida');
        const resultados = await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT 1 AS n')));
        assert.ok(resultados.every((r) => r.rows[0].n === 1));
      } finally { await pool.end(); }
      assert.deepEqual(falhas, []);
      const conexoes = new Set(servidor.registro.map((e) => e.conexao));
      assert.ok(conexoes.size >= 1 && conexoes.size <= 3);
      for (const id of conexoes) {
        const delas = servidor.registro.filter((e) => e.conexao === id && e.evento === 'consulta');
        assert.equal(delas[0].sql, g.SQL_IDENTIDADE, `conexão ${id}: a primeira consulta deve ser a de identidade`);
        assert.equal(delas.filter((e) => e.sql === g.SQL_IDENTIDADE).length, 1);
      }
    });
  });

  test('G24 — Pool com uma só conexão e consultas concorrentes não entra em deadlock nem recursão', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      const pool = new pg.Pool({ ...configCliente(alvo), max: 1 });
      try {
        const resultados = await comTempoMaximo(Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT 1 AS n'))), 5000, 'pool max=1');
        assert.equal(resultados.length, 5);
      } finally { await pool.end(); }
      assert.deepEqual(falhas, []);
      assert.equal(servidor.registro.filter((e) => e.evento === 'conexao').length, 1);
    });
  });

  test('G25 — identidade divergente (banco, papel, porta, cluster, marcador) ou ausente: Client recusado, nada além da consulta de identidade chega ao servidor', async () => {
    const variantes = [
      ['banco', { banco: 'gestao_epi_dev' }], ['papel', { papel: 'postgres' }], ['porta', { porta: 5432 }], ['cluster', { cluster: 'compartilhado' }],
      ['marcador', { marcador: 'GEPI_J2A_ISOLADO:00000000-0000-4000-8000-000000000000:1234567890' }], ['marcador ausente', { marcador: null }],
    ];
    for (const [rotulo, troca] of variantes) {
      await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
        servidor.identidade = { ...servidor.identidade, ...troca };
        const cliente = new pg.Client(configCliente(alvo));
        await assert.rejects(() => cliente.connect(), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); }, rotulo);
        assert.ok(falhas.some((m) => /identidade da instância divergente/.test(m)), rotulo);
        assert.throws(() => cliente.query('SELECT 1 AS n'), /GUARDA J2a/);
        assert.deepEqual(naoIdentidade(servidor), [], `${rotulo}: nenhuma consulta de teste pode chegar ao servidor`);
      });
    }
  });

  test('G26 — ausência de linha de identidade: recusada', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      servidor.modo = 'sem-linhas';
      const cliente = new pg.Client(configCliente(alvo));
      await assert.rejects(() => cliente.connect(), /GUARDA J2a/);
      assert.ok(falhas.some((m) => /identidade da instância divergente/.test(m)));
      assert.deepEqual(naoIdentidade(servidor), []);
    });
  });

  test('G27 — Pool com identidade divergente: nenhuma consulta de teste chega ao servidor e o erro é seguro', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      servidor.identidade = { ...servidor.identidade, cluster: 'compartilhado' };
      const pool = new pg.Pool({ ...configCliente(alvo), max: 2 });
      try {
        await assert.rejects(() => pool.query('SELECT 1 AS n'), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); });
        await assert.rejects(() => pool.query('SELECT 2 AS n'), /GUARDA J2a/);
      } finally { await comTempoMaximo(pool.end(), 5000, 'pool.end'); }
      assert.ok(falhas.length >= 2);
      assert.deepEqual(naoIdentidade(servidor), []);
    });
  });

  test('G28 — destino do cliente incorreto (banco, papel ou host por nome): recusado antes de qualquer conexão ao servidor', async () => {
    for (const troca of [{ database: 'gestao_epi_homolog_local' }, { user: 'postgres' }, { host: 'localhost' }]) {
      await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
        const cliente = new pg.Client(configCliente(alvo, troca));
        await assert.rejects(() => cliente.connect(), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); }, JSON.stringify(troca));
        assert.equal(servidor.registro.length, 0, `${JSON.stringify(troca)}: nenhuma conexão pode chegar ao servidor`);
        assert.equal(falhas.length, 1);
      });
    }
  });

  test('G29 — falha de conexão: o servidor derruba a conexão antes da autenticação; erro propagado sem travar e sem registrar falha de identidade', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      servidor.modo = 'fechar-na-conexao';
      const cliente = new pg.Client(configCliente(alvo));
      await comTempoMaximo(assert.rejects(() => cliente.connect(), /terminated|ECONNRESET|closed/i), 5000, 'conexão derrubada');
      assert.deepEqual(falhas, []);
    });
  });

  test('G30 — o servidor derruba a conexão durante a verificação de identidade: encerrado com segurança (sem exceção não tratada)', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      servidor.modo = 'fechar-na-consulta';
      const cliente = new pg.Client(configCliente(alvo));
      await comTempoMaximo(assert.rejects(() => cliente.connect(), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); }), 5000, 'queda durante identidade');
      assert.ok(falhas.length >= 1);
      assert.deepEqual(naoIdentidade(servidor), []);
    });
  });

  test('G31 — o servidor não responde à identidade: encerra por tempo (250 ms configurados), sem entregar a conexão', async () => {
    await comGuarda(servidor, { tempoMaxIdentidadeMs: 250 }, async ({ falhas, alvo }) => {
      servidor.modo = 'sem-resposta';
      const cliente = new pg.Client(configCliente(alvo));
      const inicio = Date.now();
      await comTempoMaximo(assert.rejects(() => cliente.connect(), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); }), 5000, 'identidade sem resposta');
      assert.ok(Date.now() - inicio < 3000);
      assert.ok(falhas.some((m) => /tempo esgotado/.test(m)));
    });
  });

  test('G32 — consulta emitida antes da verificação (uso do evento connect ou de connect() sem await) é recusada, e a conexão legítima segue', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      const cliente = new pg.Client(configCliente(alvo));
      const conectando = cliente.connect();
      assert.throws(() => cliente.query('SELECT 99 AS n'), (erro) => { anotar(erro.message); return /GUARDA J2a/.test(erro.message); });
      await conectando;
      assert.equal((await cliente.query('SELECT 1 AS n')).rows[0].n, 1);
      await cliente.end();
      assert.ok(falhas.some((m) => /antes da verificação/.test(m)));
      assert.equal(consultasDe(servidor).some((e) => e.sql === 'SELECT 99 AS n'), false);
    });
  });

  test('G33 — conexão direta fora do cliente guardado (net.connect ao servidor, objeto, soquete Unix) é recusada sem chegar à rede', async () => {
    await comGuarda(servidor, {}, async ({ falhas, alvo }) => {
      assert.throws(() => net.connect(alvo.port, '127.0.0.1'), /GUARDA J2a/);
      assert.throws(() => net.connect({ port: alvo.port, host: '127.0.0.1' }), /GUARDA J2a/);
      assert.throws(() => net.connect('/tmp/gepi-guarda-d1-soquete-inexistente.sock'), /GUARDA J2a/);
      assert.equal(servidor.registro.length, 0);
      assert.equal(falhas.length, 3);
    });
  });

  test('G34 — compatibilidade: o Supertest (cliente HTTP em 127.0.0.1) continua funcionando com a guarda instalada', async () => {
    await comGuarda(servidor, {}, async ({ falhas }) => {
      const servidorHttp = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); });
      const resposta = await request(servidorHttp).get('/');
      assert.equal(resposta.status, 200);
      assert.equal(resposta.text, 'ok');
      assert.deepEqual(falhas, []);
    });
  });

  test('G35 — desinstalar restaura exatamente as funções originais de pg e net', async () => {
    const antes = { rede: net.Socket.prototype.connect, conectar: pg.Client.prototype._connect, consultar: pg.Client.prototype.query };
    await comGuarda(servidor, {}, async () => {
      assert.notEqual(net.Socket.prototype.connect, antes.rede);
      assert.notEqual(pg.Client.prototype._connect, antes.conectar);
      assert.notEqual(pg.Client.prototype.query, antes.consultar);
    });
    assert.equal(net.Socket.prototype.connect, antes.rede);
    assert.equal(pg.Client.prototype._connect, antes.conectar);
    assert.equal(pg.Client.prototype.query, antes.consultar);
    assert.equal(pg.Client.prototype.__guardaJ2a, undefined);
  });

  test('G36 — nenhuma mensagem de erro ou de falha de todos os cenários contém a senha ou o identificador do marcador', () => {
    assert.ok(mensagensVistas.length > 20, `poucas mensagens coletadas: ${mensagensVistas.length}`);
    for (const texto of mensagensVistas) {
      assert.equal(texto.includes(SENHA), false);
      assert.equal(texto.includes(UUID), false);
      assert.equal(texto.includes(SISTEMA), false);
    }
  });
});

describe('Guarda D1 (J2a) — inspeção estática', () => {
  const RAIZ = path.join(__dirname, '..', '..');
  const ler = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
  const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('G40 — o carregador real é fino: lê só IDENTIDADE e SYSTEM_ID, encerra com código 1, não imprime ambiente nem segredos e marca o sentinela', () => {
    const codigo = semComentarios(ler('test/integracao/exigir-instancia-dedicada.js'));
    assert.deepEqual([...codigo.matchAll(/lerArquivo\('([A-Z_]+)'\)/g)].map((m) => m[1]).sort(), ['IDENTIDADE', 'SYSTEM_ID']);
    assert.equal((codigo.match(/process\.exit\(/g) ?? []).length, 1);
    assert.ok(codigo.includes('process.exit(1)'));
    assert.equal(/console\.|DB_PASSWORD|senha-teste|pgpass|process\.env\b(?!,)/.test(codigo.replace('validarAmbiente(process.env', '')), false);
    assert.ok(codigo.includes('instalarGuarda({ pg, net, alvo: guarda.ALVO'));
    assert.ok(codigo.includes('globalThis.__GEPI_GUARDA_J2A__'));
    assert.ok(codigo.indexOf('validarAmbiente') < codigo.indexOf("require('pg')"), 'o ambiente é validado antes de carregar o driver');
  });

  test('G41 — o módulo da guarda não tem efeitos ao carregar e não registra segredos', () => {
    const codigo = semComentarios(ler('test/integracao/helpers/guarda-instancia-dedicada.js'));
    assert.equal(/console\.|process\.exit|child_process|require\('node:fs'\)|require\('fs'\)/.test(codigo), false);
    assert.equal(/`[^`]*\$\{[^}]*(env|senha|password|DB_PASSWORD)[^}]*\}/i.test(codigo), false, 'nenhuma mensagem interpola ambiente ou senha');
    assert.equal(/\.password\b/.test(codigo), false);
  });

  test('G42 — a versão instalada do pg é a validada (8.23.0) e expõe a API interna usada; o Pool usa a mesma classe Client', async () => {
    const versao = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('pg')), '..', 'package.json'), 'utf8')).version;
    assert.equal(versao, '8.23.0');
    assert.ok(ler('test/integracao/exigir-instancia-dedicada.js').includes(`'${versao}'`), 'a versão fixada no carregador deve ser a instalada');
    assert.equal(typeof pg.Client.prototype._connect, 'function');
    assert.equal(pg.Client.prototype._connect.length, 1);
    assert.equal(typeof pg.Client.prototype.query, 'function');
    const pool = new pg.Pool({});
    try { assert.equal(pool.Client, pg.Client); } finally { await pool.end(); }
  });

  test('G43 — caminhos de criação de conexão dos três testes J2a: só os helpers de schema temporário e o pool global têm `new Client`/`new Pool`', () => {
    const permitidos = new Map([['test/integracao/helpers/schema-temporario.js', 2], ['src/config/database.js', 1]]);
    const arquivos = [
      'test/integracao/token-j-heartbeat.integration.js', 'test/integracao/token-j-d17-rotacao.integration.js', 'test/integracao/token-j-verificacao.integration.js',
      'test/integracao/helpers/token-j.js', 'test/integracao/helpers/token-tablet.js', 'test/integracao/helpers/token-atendimento.js', 'test/integracao/helpers/token-catalogo.js',
      'test/integracao/helpers/token-pedido.js', 'test/integracao/helpers/entrega-epi.js', 'test/integracao/helpers/solicitacao-epi-servico.js',
      'test/integracao/helpers/ambiente-http-12d2.js', 'test/integracao/helpers/schema-temporario.js', 'test/integracao/helpers/banco-de-teste.js', 'src/config/database.js',
    ];
    for (const relativo of arquivos) {
      const encontrados = (semComentarios(ler(relativo)).match(/new\s+(Pool|Client)\s*\(/g) ?? []).length;
      assert.equal(encontrados, permitidos.get(relativo) ?? 0, `${relativo}: ocorrências de new Pool/Client`);
    }
  });

  test('G44 — este teste e a guarda não abrem conexão real: nenhum uso das portas 5432/55432 como destino, nem de soquete Unix, fora de dublês e de recusas', () => {
    const codigo = semComentarios(ler('test/token-j/guarda-d1.test.js'));
    assert.equal(/connect\(\s*55432|port:\s*55432[^,}]*\bnet\./.test(codigo), false);
    assert.equal(/createServer\([^)]*\)\.listen\(\s*(5432|55432)/.test(codigo), false);
  });
});
