'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED/GREEN-SNAP-CORE-1): NÚCLEO ISOLADO do snapshot PostgreSQL. Só unitário: o cliente
 * PostgreSQL, o relógio e o planejador são falsos; nenhuma conexão real, nenhum processo, nenhum pg_dump. Nada aqui valida o PostgreSQL real.
 *
 * CONTRATO PROVISÓRIO: `criarSnapshot({ criarConexao, temporizador, prazos: { finalizacaoMs }, tamanhoDaPagina?, planejar? })` devolve
 * `{ abrir, finalizar, situacao }` e NÃO cria conexão. `abrir()` (uma vez só): conexão própria pela fábrica (nunca pool), ouvintes de `error`/`end`,
 * `connect()`, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SELECT pg_export_snapshot()` como PRIMEIRA consulta, identidade do banco e leituras
 * paginadas das imagens no MESMO cliente; devolve `{ ok: true, contexto }` congelado ({ snapshotId, banco, registros, plano }) ou `{ ok: false,
 * motivo, codigo? }`, sem mensagem do banco; nunca fecha a transação. `finalizar()` (uma vez só, com prazo): ROLLBACK e end(); `{ concluida: true }` só
 * com os dois comprovados; prazo esgotado, falha, conexão perdida ou segunda chamada: `{ concluida: false }`. `situacao()`: { fase, conexaoPerdida,
 * eventos } sem dados sensíveis.
 */

const SERVICO = 'src/services/imagem-backup-snapshot.service';
const REPOSITORIO = 'src/repositories/imagem-backup-snapshot.repository';

const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const SENSIVEIS = [SEGREDO, 'usuario_secreto', 'db.interno.exemplo', 'password', 'postgres://'];
const BEGIN_ESPERADO = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const ID_VALIDO = '00000003-0000001B-1';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function erroSensivel(codigo = '28P01') {
  return Object.assign(new Error(`password authentication failed for user "usuario_secreto" password=${SEGREDO} host=db.interno.exemplo postgres://u:${SEGREDO}@h/db`), {
    code: codigo, detail: `detalhe ${SEGREDO}`, hint: 'password', where: 'db.interno.exemplo',
  });
}

function semDadoSensivel(valor, rotulo = 'valor') {
  const texto = JSON.stringify(valor) ?? String(valor);
  for (const s of SENSIVEIS) assert.equal(texto.includes(s), false, `${rotulo} não pode conter "${s}"`);
}

const adiado = () => { let resolver; let rejeitar; const promessa = new Promise((r, j) => { resolver = r; rejeitar = j; }); return { promessa, resolver, rejeitar }; };
const andar = async (vezes = 10) => { for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r)); };

/** Classifica o SQL que chegou ao cliente. */
function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/^COMMIT\b/i.test(t)) return 'COMMIT';
  if (/^SET\b/i.test(t)) return 'SET';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}

const linhaPadrao = (id) => ({
  id, sha256: SHA, sha256_miniatura: SHA_B, sha256_exibicao: null, formato: 'PNG', bytes_mestre: 10, bytes_miniatura: 5, bytes_exibicao: null,
});
const linhaEmpresa = (id) => ({
  id, empresa_id: 7, sha256: SHA, sha256_mestre: SHA, sha256_exibicao: SHA_B, sha256_miniatura: SHA_B, formato: 'PNG',
  bytes_mestre: 10, bytes_exibicao: 8, bytes_miniatura: 5,
});

/**
 * Cliente PostgreSQL falso. Emite eventos como um EventEmitter (um 'error' sem ouvinte LANÇA). `respostas` permite trocar o comportamento de cada
 * tipo de SQL: uma função que recebe (sql, parametros) e devolve o resultado, lança, ou devolve uma promessa controlada pelo teste.
 */
function criarCliente({ snapshotId = ID_VALIDO, banco = { nome: 'gestao_epi', oid: '16384' }, padrao = [linhaPadrao('1'), linhaPadrao('2')], empresa = [linhaEmpresa('5')], respostas = {}, conectar, encerrar } = {}) {
  const c = {
    marca: Symbol('cliente'),
    log: [],
    consultas: [],
    ouvintes: { error: [], end: [] },
    connectionParameters: { user: 'usuario_secreto', password: SEGREDO, host: 'db.interno.exemplo', connectionString: `postgres://u:${SEGREDO}@h/db` },
    async connect() { c.log.push('connect'); if (conectar) return conectar(); return undefined; },
    async query(sql, parametros) {
      const tipo = tipoDe(sql);
      c.log.push(tipo);
      c.consultas.push({ tipo, sql, parametros, cliente: c.marca });
      if (respostas[tipo]) return respostas[tipo](sql, parametros);
      switch (tipo) {
        case 'EXPORTAR': return { rows: [{ snapshot_id: snapshotId }] };
        case 'IDENTIDADE': return { rows: [banco] };
        case 'PADRAO': return { rows: paginar(padrao, parametros) };
        case 'EMPRESA': return { rows: paginar(empresa, parametros) };
        default: return { rows: [] };
      }
    },
    async end() {
      c.log.push('end');
      if (encerrar) return encerrar();
      c.emitir('end');
      return undefined;
    },
    on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    emitir(evento, argumento) {
      const lista = c.ouvintes[evento] ?? [];
      if (evento === 'error' && lista.length === 0) throw argumento;
      for (const f of lista) f(argumento);
    },
  };
  return c;
}

function paginar(linhas, [depoisDe, limite]) {
  return linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);
}

/** Relógio falso: cada prazo só vence quando o teste manda. */
function criarTemporizador() {
  const t = { prazos: [] };
  t.prazo = (ms) => {
    const d = adiado();
    const registro = { ms, cancelado: false, vencer: () => d.resolver() };
    t.prazos.push(registro);
    return { promessa: d.promessa, cancelar: () => { registro.cancelado = true; } };
  };
  return t;
}

function montar({ cliente = criarCliente(), fabrica, planejar, tamanhoDaPagina, finalizacaoMs = 5000 } = {}) {
  const { criarSnapshot } = exigirModulo(SERVICO);
  const temporizador = criarTemporizador();
  const fabricas = { chamadas: 0 };
  const criarConexao = fabrica ?? (() => { fabricas.chamadas += 1; return cliente; });
  const opcoes = { criarConexao, temporizador, prazos: { finalizacaoMs } };
  if (planejar !== undefined) opcoes.planejar = planejar;
  if (tamanhoDaPagina !== undefined) opcoes.tamanhoDaPagina = tamanhoDaPagina;
  const recurso = criarSnapshot(opcoes);
  return { recurso, cliente, temporizador, fabricas };
}

let consoleOriginal;
let chamadasDeConsole;
beforeEach(() => {
  chamadasDeConsole = [];
  consoleOriginal = {};
  for (const nome of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleOriginal[nome] = console[nome];
    console[nome] = (...a) => { chamadasDeConsole.push([nome, a]); };
  }
});
afterEach(() => {
  for (const [nome, f] of Object.entries(consoleOriginal)) console[nome] = f;
  assert.deepEqual(chamadasDeConsole, [], 'o núcleo do snapshot não escreve no console');
});

// ------------------------------------------------------------------------------------------------------------------------------ criação e pool
describe('[SNAP] criação preguiçosa e conexão dedicada', () => {
  test('SNAP-01 — criarSnapshot não cria conexão: a fábrica só é chamada por abrir(), uma vez', async () => {
    const { recurso, fabricas } = montar();
    assert.equal(fabricas.chamadas, 0);
    await recurso.abrir();
    assert.equal(fabricas.chamadas, 1);
  });

  test('SNAP-02 — opções inválidas são recusadas na criação (TypeError), sem chamar a fábrica', () => {
    const { criarSnapshot } = exigirModulo(SERVICO);
    let chamadas = 0;
    const fabrica = () => { chamadas += 1; return criarCliente(); };
    const temporizador = criarTemporizador();
    for (const opcoes of [
      undefined, null, {}, { criarConexao: 'x', temporizador, prazos: { finalizacaoMs: 10 } },
      { criarConexao: fabrica, prazos: { finalizacaoMs: 10 } },
      { criarConexao: fabrica, temporizador, prazos: { finalizacaoMs: 0 } },
      { criarConexao: fabrica, temporizador, prazos: { finalizacaoMs: 1.5 } },
      { criarConexao: fabrica, temporizador, prazos: {} },
      { criarConexao: fabrica, temporizador, prazos: { finalizacaoMs: 10 }, planejar: 'x' },
      { criarConexao: fabrica, temporizador, prazos: { finalizacaoMs: 10 }, tamanhoDaPagina: 0 },
      { criarConexao: fabrica, temporizador, prazos: { finalizacaoMs: 10 }, tamanhoDaPagina: 1001 },
    ]) assert.throws(() => criarSnapshot(opcoes), TypeError);
    assert.equal(chamadas, 0);
  });

  test('SNAP-03 — nenhuma utilização do Pool global: os novos módulos não importam config/database nem o driver pg', () => {
    for (const relativo of [`${SERVICO}.js`, `${REPOSITORIO}.js`]) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', '..', relativo), 'utf8');
      assert.equal(/config\/database/.test(fonte), false, `${relativo} não importa o pool global`);
      assert.equal(/require\(\s*['"]pg['"]\s*\)/.test(fonte), false, `${relativo} não cria cliente por conta própria`);
    }
  });

  test('SNAP-04 — a fábrica que devolve um POOL (ou cliente de pool) é recusada: nenhuma operação nele, nem connect, nem query, nem end', async () => {
    for (const [rotulo, extra] of [['pool', { totalCount: 0, idleCount: 0, waitingCount: 0 }], ['cliente de pool', { release() {} }]]) {
      const cliente = Object.assign(criarCliente(), extra);
      const { recurso } = montar({ cliente });
      const r = await recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'CONEXAO_INVALIDA', rotulo);
      assert.deepEqual(cliente.log, [], `${rotulo}: nada é executado nele`);
      const f = await recurso.finalizar();
      assert.equal(f.concluida, false, `${rotulo}: não se pode comprovar encerramento de um objeto que não é nosso`);
      assert.deepEqual(cliente.log, [], `${rotulo}: finalizar não toca nele`);
    }
  });

  test('SNAP-05 — fábrica que lança ou devolve algo sem connect/query/end/on: ok false, sem vazamento', async () => {
    for (const [rotulo, fabrica, motivo] of [
      ['lança', () => { throw erroSensivel(); }, 'CONEXAO_INDISPONIVEL'],
      ['rejeita', async () => { throw erroSensivel(); }, 'CONEXAO_INDISPONIVEL'],
      ['sem query', () => ({ connect() {}, end() {}, on() {} }), 'CONEXAO_INVALIDA'],
      ['nulo', () => null, 'CONEXAO_INVALIDA'],
    ]) {
      const { recurso } = montar({ fabrica });
      const r = await recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, motivo, rotulo);
      semDadoSensivel(r, rotulo);
      semDadoSensivel(recurso.situacao(), rotulo);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ abertura
describe('[SNAP] abertura: ordem, mesma conexão e mesma transação', () => {
  test('SNAP-06 — ordem exata: ouvintes, connect, BEGIN REPEATABLE READ READ ONLY, pg_export_snapshot como PRIMEIRA consulta, identidade, padrão, empresa; sem SET, sem COMMIT, sem ROLLBACK, sem end', async () => {
    const { recurso, cliente } = montar();
    const r = await recurso.abrir();
    assert.equal(r.ok, true);
    assert.deepEqual(cliente.log, ['connect', 'BEGIN', 'EXPORTAR', 'IDENTIDADE', 'PADRAO', 'EMPRESA']);
    assert.equal(cliente.consultas[0].sql, BEGIN_ESPERADO);
    assert.ok(cliente.ouvintes.error.length >= 1, 'ouvinte de error registrado');
    assert.ok(cliente.ouvintes.end.length >= 1, 'ouvinte de end registrado');
  });

  test('SNAP-07 — exportação e leituras no MESMO cliente; o identificador vem de pg_export_snapshot()', async () => {
    const { recurso, cliente } = montar();
    const r = await recurso.abrir();
    assert.ok(cliente.consultas.every((q) => q.cliente === cliente.marca));
    assert.equal(r.contexto.snapshotId, ID_VALIDO);
    const exportar = cliente.consultas.find((q) => q.tipo === 'EXPORTAR');
    assert.ok(exportar.parametros === undefined || exportar.parametros.length === 0, 'a exportação não leva parâmetros');
  });

  test('SNAP-08 — a transação continua ABERTA depois de abrir(): nenhum ROLLBACK, COMMIT ou end; fase ABERTO', async () => {
    const { recurso, cliente } = montar();
    await recurso.abrir();
    await andar();
    assert.equal(cliente.log.includes('ROLLBACK'), false);
    assert.equal(cliente.log.includes('COMMIT'), false);
    assert.equal(cliente.log.includes('end'), false);
    assert.equal(recurso.situacao().fase, 'ABERTO');
    assert.equal(recurso.situacao().conexaoPerdida, false);
  });

  test('SNAP-09 — leituras paginadas por chave no mesmo cliente, até a página incompleta', async () => {
    const padrao = ['1', '2', '3', '4', '5'].map(linhaPadrao);
    const cliente = criarCliente({ padrao });
    const { recurso } = montar({ cliente, tamanhoDaPagina: 2 });
    const r = await recurso.abrir();
    assert.equal(r.ok, true);
    const paginas = cliente.consultas.filter((q) => q.tipo === 'PADRAO').map((q) => q.parametros);
    assert.deepEqual(paginas, [['0', 2], ['2', 2], ['4', 2]]);
    assert.deepEqual(r.contexto.registros.padrao.map((l) => l.id), ['1', '2', '3', '4', '5']);
  });

  test('SNAP-10 — abrir() só uma vez: a segunda chamada é recusada sem nova conexão', async () => {
    const { recurso, fabricas } = montar();
    await recurso.abrir();
    const r2 = await recurso.abrir();
    assert.equal(r2.ok, false);
    assert.equal(r2.motivo, 'JA_ABERTO');
    assert.equal(fabricas.chamadas, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ falhas na abertura
describe('[SNAP] falhas na abertura nunca dão ok', () => {
  const casos = [
    ['connect', { conectar: () => { throw erroSensivel('ECONNREFUSED'); } }, 'CONEXAO_FALHOU', ['connect']],
    ['BEGIN', { respostas: { BEGIN: () => { throw erroSensivel('25001'); } } }, 'BEGIN_FALHOU', ['connect', 'BEGIN']],
    ['exportação', { respostas: { EXPORTAR: () => { throw erroSensivel('0A000'); } } }, 'EXPORTACAO_FALHOU', ['connect', 'BEGIN', 'EXPORTAR']],
    ['identidade', { respostas: { IDENTIDADE: () => { throw erroSensivel('XX000'); } } }, 'IDENTIDADE_FALHOU', ['connect', 'BEGIN', 'EXPORTAR', 'IDENTIDADE']],
    ['consulta padrão', { respostas: { PADRAO: () => { throw erroSensivel('42501'); } } }, 'CONSULTA_FALHOU', ['connect', 'BEGIN', 'EXPORTAR', 'IDENTIDADE', 'PADRAO']],
    ['consulta empresa', { respostas: { EMPRESA: () => { throw erroSensivel('42P01'); } } }, 'CONSULTA_FALHOU', ['connect', 'BEGIN', 'EXPORTAR', 'IDENTIDADE', 'PADRAO', 'EMPRESA']],
  ];
  for (const [rotulo, opcoes, motivo, log] of casos) {
    test(`SNAP-11 (${rotulo}) — falha: ok false, motivo ${motivo}, nada depois, transação não fechada por abrir(), sem vazamento`, async () => {
      const cliente = criarCliente(opcoes);
      const { recurso } = montar({ cliente });
      const r = await recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, motivo, rotulo);
      assert.deepEqual(cliente.log, log, `${rotulo}: nenhuma operação depois da falha`);
      assert.equal(Object.isFrozen(r), true);
      assert.equal('contexto' in r, false, `${rotulo}: falha não traz contexto`);
      semDadoSensivel(r, rotulo);
      semDadoSensivel(recurso.situacao(), rotulo);
      assert.equal(recurso.situacao().fase, 'FALHOU', rotulo);
    });
  }

  test('SNAP-12 — o código do erro só sai se tiver formato seguro (SQLSTATE ou código do Node); nunca a mensagem', async () => {
    const seguro = await montar({ cliente: criarCliente({ respostas: { BEGIN: () => { throw erroSensivel('25001'); } } }) }).recurso.abrir();
    assert.equal(seguro.codigo, '25001');
    const inseguro = await montar({ cliente: criarCliente({ respostas: { BEGIN: () => { throw erroSensivel(`password=${SEGREDO}`); } } }) }).recurso.abrir();
    assert.equal('codigo' in inseguro, false);
    semDadoSensivel(inseguro);
  });

  for (const [rotulo, id] of [
    ['minúsculas', '00000003-0000001b-1'], ['contador zero', '00000003-0000001B-0'], ['parte curta', '0000003-0000001B-1'],
    ['sem contador', '00000003-0000001B'], ['separador extra', '00000003-0000001B-1-2'], ['espaço', ' 00000003-0000001B-1'],
    ['injeção', "00000003-0000001B-1'; DROP TABLE x; --"], ['vazio', ''], ['nulo', null], ['número', 3], ['longo demais', `00000003-0000001B-${'9'.repeat(11)}`],
    ['quebra de linha', '00000003-0000001B-1\n'], ['linha ausente', undefined],
  ]) {
    test(`SNAP-13 (${rotulo}) — identificador de snapshot fora do formato do PostgreSQL 16 (%08X-%08X-%d): SNAPSHOT_INVALIDO, nada lido depois`, async () => {
      const respostas = id === undefined ? { EXPORTAR: () => ({ rows: [] }) } : {};
      const cliente = criarCliente({ snapshotId: id, respostas });
      const r = await montar({ cliente }).recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'SNAPSHOT_INVALIDO', rotulo);
      assert.deepEqual(cliente.log, ['connect', 'BEGIN', 'EXPORTAR'], rotulo);
    });
  }

  test('SNAP-14 — identificadores válidos do formato são aceitos', async () => {
    for (const id of ['00000003-0000001B-1', '0000000A-00000F2C-12', 'FFFFFFFF-FFFFFFFF-2147483647']) {
      const r = await montar({ cliente: criarCliente({ snapshotId: id }) }).recurso.abrir();
      assert.equal(r.ok, true, id);
      assert.equal(r.contexto.snapshotId, id);
    }
  });

  for (const [rotulo, banco] of [
    ['nome vazio', { nome: '', oid: '16384' }], ['nome longo', { nome: 'a'.repeat(64), oid: '16384' }], ['nome com controle', { nome: 'gestao\nepi', oid: '16384' }],
    ['nome não texto', { nome: 5, oid: '16384' }], ['oid zero', { nome: 'gestao_epi', oid: '0' }], ['oid texto', { nome: 'gestao_epi', oid: 'abc' }],
    ['oid acima de 32 bits', { nome: 'gestao_epi', oid: '4294967296' }], ['oid número', { nome: 'gestao_epi', oid: 16384 }], ['oid nulo', { nome: 'gestao_epi', oid: null }],
  ]) {
    test(`SNAP-15 (${rotulo}) — identidade do banco inválida: IDENTIDADE_INVALIDA, nenhuma leitura de imagens`, async () => {
      const cliente = criarCliente({ banco });
      const r = await montar({ cliente }).recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'IDENTIDADE_INVALIDA', rotulo);
      assert.equal(cliente.log.includes('PADRAO'), false, rotulo);
    });
  }

  test('SNAP-16 — página que não avança, maior que o limite, ou com linha sem id decimal: CONSULTA_INVALIDA', async () => {
    const parada = criarCliente({ respostas: { PADRAO: () => ({ rows: [linhaPadrao('1'), linhaPadrao('2')] }) } });
    const r1 = await montar({ cliente: parada, tamanhoDaPagina: 2 }).recurso.abrir();
    assert.equal(r1.ok, false);
    assert.equal(r1.motivo, 'CONSULTA_INVALIDA');

    const grande = criarCliente({ respostas: { PADRAO: () => ({ rows: ['1', '2', '3'].map(linhaPadrao) }) } });
    const r2 = await montar({ cliente: grande, tamanhoDaPagina: 2 }).recurso.abrir();
    assert.equal(r2.motivo, 'CONSULTA_INVALIDA');

    const semId = criarCliente({ respostas: { EMPRESA: () => ({ rows: [{ ...linhaEmpresa('1'), id: null }] }) } });
    const r3 = await montar({ cliente: semId }).recurso.abrir();
    assert.equal(r3.motivo, 'CONSULTA_INVALIDA');
  });

  test('SNAP-17 — encerramento inesperado DURANTE a abertura (evento end ou error): CONEXAO_PERDIDA, nunca ok', async () => {
    for (const evento of ['end', 'error']) {
      const cliente = criarCliente({
        respostas: {
          IDENTIDADE: () => { cliente.emitir(evento, erroSensivel('57P01')); return { rows: [{ nome: 'gestao_epi', oid: '16384' }] }; },
        },
      });
      const { recurso } = montar({ cliente });
      const r = await recurso.abrir();
      assert.equal(r.ok, false, evento);
      assert.equal(r.motivo, 'CONEXAO_PERDIDA', evento);
      assert.equal(recurso.situacao().conexaoPerdida, true, evento);
      semDadoSensivel(recurso.situacao(), evento);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ contexto e planejador
describe('[SNAP] contexto imutável, sem credenciais, e planejador injetado', () => {
  test('SNAP-18 — contexto congelado em profundidade, com identidade, id e registros; sem credenciais nem parâmetros de conexão', async () => {
    const { recurso } = montar();
    const r = await recurso.abrir();
    const { contexto } = r;
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(contexto), true);
    assert.equal(Object.isFrozen(contexto.banco), true);
    assert.equal(Object.isFrozen(contexto.registros), true);
    assert.equal(Object.isFrozen(contexto.registros.padrao), true);
    assert.equal(Object.isFrozen(contexto.registros.padrao[0]), true);
    assert.equal(Object.isFrozen(contexto.registros.empresa[0]), true);
    assert.deepEqual(Object.keys(contexto).sort(), ['banco', 'plano', 'registros', 'snapshotId']);
    assert.deepEqual(contexto.banco, { nome: 'gestao_epi', oid: '16384' });
    assert.equal(contexto.plano, null, 'sem planejador injetado não há plano');
    assert.equal(contexto.registros.empresa[0].empresaId, 7);
    semDadoSensivel(contexto, 'contexto');
    assert.throws(() => { 'use strict'; contexto.registros.padrao.push({}); }, TypeError);
  });

  test('SNAP-19 — planejador puro injetado: recebe os registros congelados, roda uma vez depois das leituras; plano congelado { chave, sha256 }', async () => {
    const vistos = [];
    const planejar = (registros) => {
      vistos.push(registros);
      return registros.padrao.map((l) => ({ chave: `padrao/${l.sha256}/mestre.png`, sha256: l.sha256 }));
    };
    const { recurso, cliente } = montar({ planejar });
    const r = await recurso.abrir();
    assert.equal(r.ok, true);
    assert.equal(vistos.length, 1);
    assert.equal(Object.isFrozen(vistos[0]), true);
    assert.equal(Object.isFrozen(vistos[0].padrao), true);
    assert.equal(cliente.log.at(-1), 'EMPRESA', 'o planejador não consulta o banco');
    assert.deepEqual(r.contexto.plano, [{ chave: `padrao/${SHA}/mestre.png`, sha256: SHA }, { chave: `padrao/${SHA}/mestre.png`, sha256: SHA }]);
    assert.equal(Object.isFrozen(r.contexto.plano), true);
    assert.equal(Object.isFrozen(r.contexto.plano[0]), true);
  });

  for (const [rotulo, planejar] of [
    ['lança', () => { throw erroSensivel(); }],
    ['não devolve lista', () => ({})],
    ['assíncrono', async () => []],
    ['item sem chave', () => [{ sha256: SHA }]],
    ['sha256 inválido', () => [{ chave: 'padrao/x/mestre.png', sha256: 'XYZ' }]],
    ['item que não é objeto', () => ['padrao/x']],
  ]) {
    test(`SNAP-20 (${rotulo}) — plano inválido: PLANO_INVALIDO, nunca ok, sem vazamento`, async () => {
      const r = await montar({ planejar }).recurso.abrir();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'PLANO_INVALIDO', rotulo);
      semDadoSensivel(r, rotulo);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------ finalização
describe('[SNAP] finalização comprovada', () => {
  test('SNAP-21 — sucesso: ROLLBACK e depois end(); concluida true; prazo criado com finalizacaoMs e cancelado; o end() próprio não é "perda"', async () => {
    const { recurso, cliente, temporizador } = montar({ finalizacaoMs: 7000 });
    await recurso.abrir();
    const f = await recurso.finalizar();
    assert.deepEqual(f, { concluida: true });
    assert.equal(Object.isFrozen(f), true);
    assert.deepEqual(cliente.log.slice(-2), ['ROLLBACK', 'end']);
    assert.equal(cliente.consultas.at(-1).sql, 'ROLLBACK');
    assert.equal(temporizador.prazos.length, 1);
    assert.equal(temporizador.prazos[0].ms, 7000);
    assert.equal(temporizador.prazos[0].cancelado, true);
    assert.equal(recurso.situacao().conexaoPerdida, false);
    assert.equal(recurso.situacao().fase, 'FINALIZADO');
  });

  test('SNAP-22 — finalização depois de abertura com falha (BEGIN, exportação, consulta): ROLLBACK e end(); concluida só com os dois comprovados', async () => {
    for (const tipo of ['BEGIN', 'EXPORTAR', 'PADRAO']) {
      const cliente = criarCliente({ respostas: { [tipo]: () => { throw erroSensivel(); } } });
      const { recurso } = montar({ cliente });
      await recurso.abrir();
      const f = await recurso.finalizar();
      assert.equal(f.concluida, true, tipo);
      assert.deepEqual(cliente.log.slice(-2), ['ROLLBACK', 'end'], tipo);
    }
  });

  test('SNAP-23 — connect() falhou: sem ROLLBACK; end() para soltar o cliente; concluida só com end() comprovado', async () => {
    const cliente = criarCliente({ conectar: () => { throw erroSensivel('ECONNREFUSED'); } });
    const { recurso } = montar({ cliente });
    await recurso.abrir();
    const f = await recurso.finalizar();
    assert.equal(f.concluida, true);
    assert.deepEqual(cliente.log, ['connect', 'end']);
  });

  test('SNAP-24 — nada foi criado (abrir não chamado, ou a fábrica falhou): nada a encerrar; e abrir() depois de finalizar é recusado sem conexão', async () => {
    const { recurso, fabricas } = montar();
    assert.deepEqual(await recurso.finalizar(), { concluida: true });
    const r = await recurso.abrir();
    assert.equal(r.ok, false);
    assert.equal(fabricas.chamadas, 0);

    const falhou = montar({ fabrica: () => { throw erroSensivel(); } });
    await falhou.recurso.abrir();
    assert.equal((await falhou.recurso.finalizar()).concluida, true);
  });

  test('SNAP-25 — ROLLBACK falha: concluida false (o end() ainda é tentado, mas não comprova nada); sem vazamento', async () => {
    const cliente = criarCliente({ respostas: { ROLLBACK: () => { throw erroSensivel('08006'); } } });
    const { recurso } = montar({ cliente });
    await recurso.abrir();
    const f = await recurso.finalizar();
    assert.deepEqual(f, { concluida: false });
    assert.equal(cliente.log.at(-1), 'end');
    semDadoSensivel(f);
    semDadoSensivel(recurso.situacao());
  });

  test('SNAP-26 — end() falha: concluida false', async () => {
    const cliente = criarCliente({ encerrar: () => { throw erroSensivel('ECONNRESET'); } });
    const { recurso } = montar({ cliente });
    await recurso.abrir();
    assert.deepEqual(await recurso.finalizar(), { concluida: false });
  });

  test('SNAP-27 — ROLLBACK PENDENTE e prazo esgotado: concluida false; o pendente não é tratado como concluído; nada mais é feito depois; resposta tardia não muda nada', async () => {
    const rollback = adiado();
    const cliente = criarCliente({ respostas: { ROLLBACK: () => rollback.promessa } });
    const { recurso, temporizador } = montar({ cliente });
    await recurso.abrir();
    let resolvido = null;
    const promessa = recurso.finalizar().then((f) => { resolvido = f; return f; });
    await andar();
    assert.equal(resolvido, null, 'sem prazo nem resposta, a finalização segue pendente');
    temporizador.prazos[0].vencer();
    const f = await promessa;
    assert.deepEqual(f, { concluida: false });
    assert.equal(cliente.log.includes('end'), false, 'nenhuma operação depois do prazo');
    rollback.resolver({ rows: [] });
    await andar();
    assert.equal(cliente.log.includes('end'), false);
    assert.deepEqual(await recurso.finalizar(), { concluida: false });
  });

  test('SNAP-28 — end() PENDENTE e prazo esgotado: concluida false', async () => {
    const fim = adiado();
    const cliente = criarCliente({ encerrar: () => fim.promessa });
    const { recurso, temporizador } = montar({ cliente });
    await recurso.abrir();
    const promessa = recurso.finalizar();
    await andar();
    temporizador.prazos[0].vencer();
    assert.deepEqual(await promessa, { concluida: false });
    fim.resolver();
    await andar();
  });

  test('SNAP-29 — segunda finalização: nunca repete ROLLBACK/end nem dá nova confirmação de sucesso (depois de sucesso, de falha, ou concorrente)', async () => {
    const ok = montar();
    await ok.recurso.abrir();
    assert.equal((await ok.recurso.finalizar()).concluida, true);
    const antes = ok.cliente.log.length;
    assert.deepEqual(await ok.recurso.finalizar(), { concluida: false });
    assert.equal(ok.cliente.log.length, antes);

    const ruim = montar({ cliente: criarCliente({ respostas: { ROLLBACK: () => { throw erroSensivel(); } } }) });
    await ruim.recurso.abrir();
    await ruim.recurso.finalizar();
    const antesRuim = ruim.cliente.log.length;
    assert.deepEqual(await ruim.recurso.finalizar(), { concluida: false });
    assert.equal(ruim.cliente.log.length, antesRuim);

    const conc = montar();
    await conc.recurso.abrir();
    const [a, b] = await Promise.all([conc.recurso.finalizar(), conc.recurso.finalizar()]);
    assert.deepEqual([a.concluida, b.concluida].sort(), [false, true]);
    assert.equal(conc.cliente.log.filter((x) => x === 'ROLLBACK').length, 1);
    assert.equal(conc.cliente.log.filter((x) => x === 'end').length, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ perda da conexão
describe('[SNAP] encerramento inesperado da conexão', () => {
  for (const evento of ['error', 'end']) {
    test(`SNAP-30 (${evento}) — depois de abrir(): o processo não cai, a perda é registrada sem dados sensíveis, e a finalização não é concluída (sem ROLLBACK)`, async () => {
      const { recurso, cliente } = montar();
      await recurso.abrir();
      assert.doesNotThrow(() => cliente.emitir(evento, erroSensivel('57P01')));
      const s = recurso.situacao();
      assert.equal(s.conexaoPerdida, true);
      assert.equal(Object.isFrozen(s), true);
      assert.ok(s.eventos.length >= 1);
      assert.equal(s.eventos[0].tipo, evento === 'error' ? 'ERRO' : 'ENCERRAMENTO');
      if (evento === 'error') assert.equal(s.eventos[0].codigo, '57P01');
      semDadoSensivel(s, 'situação');
      const f = await recurso.finalizar();
      assert.deepEqual(f, { concluida: false });
      assert.equal(cliente.log.includes('ROLLBACK'), false, 'a conexão perdida não recebe ROLLBACK');
    });
  }

  test('SNAP-31 — eventos registrados são limitados e sem mensagem; códigos inseguros são descartados', async () => {
    const { recurso, cliente } = montar();
    await recurso.abrir();
    for (let i = 0; i < 50; i += 1) cliente.emitir('error', erroSensivel(`password=${SEGREDO}`));
    const s = recurso.situacao();
    assert.ok(s.eventos.length <= 10, 'número de eventos limitado');
    assert.ok(s.eventos.every((e) => !('codigo' in e)));
    semDadoSensivel(s);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ finalização concorrente
/**
 * RED-SNAP-CORE-1A (contraprova da V9): finalizar() chamada com abrir() ainda em andamento. A finalização nunca é concluída enquanto a abertura
 * puder criar ou manter recursos; a abertura cancelada nunca dá ok; nenhuma consulta nova começa depois do cancelamento; end() nunca roda junto de
 * connect() ou de SQL pendente; prazo esgotado é concluida false e nada mais é executado depois dele.
 */
async function ate(condicao, rotulo = 'condição') {
  for (let i = 0; i < 500; i += 1) { if (condicao()) return; await new Promise((r) => setImmediate(r)); }
  assert.fail(`não alcançado: ${rotulo}`);
}

function acompanhar(promessa) {
  const estado = { resolvido: false, valor: undefined };
  estado.promessa = promessa.then((v) => { estado.resolvido = true; estado.valor = v; return v; });
  return estado;
}

describe('[SNAP] finalização durante a abertura (condição de corrida)', () => {
  test('SNAP-33 (A, D) — finalizar() com a FÁBRICA pendente: não conclui antes de a fábrica responder; o cliente que chega depois não é conectado nem consultado, só encerrado; abrir() nunca dá ok', async () => {
    const fabrica = adiado();
    const cliente = criarCliente();
    const { recurso } = montar({ fabrica: () => fabrica.promessa });
    const abertura = acompanhar(recurso.abrir());
    await andar();
    const fim = acompanhar(recurso.finalizar());
    await andar();
    assert.equal(fim.resolvido, false, 'nunca conclui com a abertura ainda capaz de criar recurso');
    fabrica.resolver(cliente);
    const r = await abertura.promessa;
    const f = await fim.promessa;
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'CANCELADO');
    assert.equal('contexto' in r, false);
    assert.deepEqual(cliente.log, ['end'], 'nenhum connect nem consulta depois do cancelamento; o cliente recebido é encerrado');
    assert.deepEqual(f, { concluida: true });
  });

  test('SNAP-34 (B, D) — finalizar() com connect() pendente: não conclui antes; depois do connect nenhuma consulta (nem BEGIN); end() só depois do connect terminar', async () => {
    const conexao = adiado();
    const cliente = criarCliente({ conectar: () => conexao.promessa });
    const { recurso } = montar({ cliente });
    const abertura = acompanhar(recurso.abrir());
    await ate(() => cliente.log.includes('connect'), 'connect iniciado');
    const fim = acompanhar(recurso.finalizar());
    await andar();
    assert.equal(fim.resolvido, false);
    assert.equal(cliente.log.includes('end'), false, 'end() não roda junto do connect pendente');
    conexao.resolver();
    const r = await abertura.promessa;
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'CANCELADO');
    assert.deepEqual(await fim.promessa, { concluida: true });
    assert.deepEqual(cliente.log, ['connect', 'end']);
  });

  test('SNAP-35 (B, D) — connect() pendente que FALHA depois da finalização: abrir() não dá ok; o cliente é encerrado', async () => {
    const conexao = adiado();
    const cliente = criarCliente({ conectar: () => conexao.promessa });
    const { recurso } = montar({ cliente });
    const abertura = acompanhar(recurso.abrir());
    await ate(() => cliente.log.includes('connect'));
    const fim = acompanhar(recurso.finalizar());
    conexao.rejeitar(erroSensivel('ECONNREFUSED'));
    const r = await abertura.promessa;
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'CANCELADO', 'a falha tardia não substitui o cancelamento');
    semDadoSensivel(r);
    assert.deepEqual(await fim.promessa, { concluida: true });
    assert.deepEqual(cliente.log, ['connect', 'end']);
  });

  for (const [rotulo, tipo, opcoes, depois, resposta] of [
    ['exportação', 'EXPORTAR', {}, ['IDENTIDADE', 'PADRAO', 'EMPRESA'], { rows: [{ snapshot_id: ID_VALIDO }] }],
    ['leitura da lista', 'PADRAO', { padrao: ['1', '2', '3'].map(linhaPadrao), tamanhoDaPagina: 2 }, ['EMPRESA'], { rows: [linhaPadrao('1'), linhaPadrao('2')] }],
  ]) {
    test(`SNAP-36 (C, D: ${rotulo}) — finalizar() com SQL pendente: não conclui antes; a resposta tardia não publica snapshot; nenhuma consulta nova; ROLLBACK e end() só depois`, async () => {
      const pendente = adiado();
      const { tamanhoDaPagina, ...doCliente } = opcoes;
      const cliente = criarCliente({ ...doCliente, respostas: { [tipo]: () => pendente.promessa } });
      const { recurso } = montar({ cliente, tamanhoDaPagina });
      const abertura = acompanhar(recurso.abrir());
      await ate(() => cliente.log.includes(tipo), `${tipo} iniciado`);
      const fim = acompanhar(recurso.finalizar());
      await andar();
      assert.equal(fim.resolvido, false, rotulo);
      assert.equal(cliente.log.includes('ROLLBACK'), false, `${rotulo}: nada de ROLLBACK junto do SQL pendente`);
      assert.equal(cliente.log.includes('end'), false, `${rotulo}: nada de end() junto do SQL pendente`);
      pendente.resolver(resposta);
      const r = await abertura.promessa;
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'CANCELADO', rotulo);
      assert.equal('contexto' in r, false, rotulo);
      assert.deepEqual(await fim.promessa, { concluida: true }, rotulo);
      for (const proibido of depois) assert.equal(cliente.log.includes(proibido), false, `${rotulo}: ${proibido} não começa depois do cancelamento`);
      assert.equal(cliente.log.filter((x) => x === tipo).length, 1, `${rotulo}: nenhuma página ou consulta nova`);
      assert.deepEqual(cliente.log.slice(-2), ['ROLLBACK', 'end'], rotulo);
    });
  }

  test('SNAP-37 (C, D) — SQL pendente que FALHA depois da finalização: abrir() não dá ok; ROLLBACK e end() depois; sem vazamento', async () => {
    const pendente = adiado();
    const cliente = criarCliente({ respostas: { EXPORTAR: () => pendente.promessa } });
    const { recurso } = montar({ cliente });
    const abertura = acompanhar(recurso.abrir());
    await ate(() => cliente.log.includes('EXPORTAR'));
    const fim = acompanhar(recurso.finalizar());
    pendente.rejeitar(erroSensivel('57014'));
    const r = await abertura.promessa;
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'CANCELADO', 'a falha tardia não substitui o cancelamento');
    semDadoSensivel(r);
    assert.deepEqual(await fim.promessa, { concluida: true });
    assert.deepEqual(cliente.log.slice(-2), ['ROLLBACK', 'end']);
  });

  for (const [rotulo, montarCaso, logAntes] of [
    ['fábrica', () => { const p = adiado(); const cliente = criarCliente(); return { p, cliente, fabrica: () => p.promessa, entregar: () => p.resolver(cliente) }; }, []],
    ['connect', () => { const p = adiado(); const cliente = criarCliente({ conectar: () => p.promessa }); return { p, cliente, entregar: () => p.resolver() }; }, ['connect']],
    ['exportação', () => { const p = adiado(); const cliente = criarCliente({ respostas: { EXPORTAR: () => p.promessa } }); return { p, cliente, entregar: () => p.resolver({ rows: [{ snapshot_id: ID_VALIDO }] }) }; }, ['connect', 'BEGIN', 'EXPORTAR']],
    ['leitura da lista', () => { const p = adiado(); const cliente = criarCliente({ respostas: { EMPRESA: () => p.promessa } }); return { p, cliente, entregar: () => p.resolver({ rows: [linhaEmpresa('5')] }) }; }, ['connect', 'BEGIN', 'EXPORTAR', 'IDENTIDADE', 'PADRAO', 'EMPRESA']],
  ]) {
    test(`SNAP-38 (E: ${rotulo}) — operação pendente que não termina e o prazo se esgota: concluida false, nenhum end()/ROLLBACK junto dela; a resposta tardia nunca vira ok nem gera operação nova`, async () => {
      const caso = montarCaso();
      const { recurso, temporizador } = montar({ cliente: caso.cliente, fabrica: caso.fabrica });
      const abertura = acompanhar(recurso.abrir());
      await ate(() => logAntes.every((x) => caso.cliente.log.includes(x)) && (rotulo !== 'fábrica' || true), 'operação pendente');
      await andar();
      const fim = acompanhar(recurso.finalizar());
      await ate(() => temporizador.prazos.length === 1, 'prazo da finalização criado');
      await andar();
      assert.equal(fim.resolvido, false, rotulo);
      temporizador.prazos[0].vencer();
      assert.deepEqual(await fim.promessa, { concluida: false }, rotulo);
      assert.deepEqual(caso.cliente.log, logAntes, `${rotulo}: nada executado junto da operação pendente nem depois do prazo`);
      caso.entregar();
      const r = await abertura.promessa;
      await andar();
      assert.equal(r.ok, false, rotulo);
      assert.equal(r.motivo, 'CANCELADO', rotulo);
      assert.deepEqual(caso.cliente.log, logAntes, `${rotulo}: a resposta tardia não gera consulta, ROLLBACK nem end`);
      assert.deepEqual(await recurso.finalizar(), { concluida: false }, `${rotulo}: nenhuma nova confirmação`);
      assert.equal(temporizador.prazos[0].cancelado, true, rotulo);
      semDadoSensivel(recurso.situacao(), rotulo);
    });
  }

  test('SNAP-39 (F) — abrir() depois de iniciada a finalização (com a primeira abertura ainda pendente): recusado, sem nova conexão', async () => {
    const fabrica = adiado();
    let chamadas = 0;
    const { recurso } = montar({ fabrica: () => { chamadas += 1; return fabrica.promessa; } });
    const abertura = acompanhar(recurso.abrir());
    await andar();
    const fim = acompanhar(recurso.finalizar());
    const outra = await recurso.abrir();
    assert.equal(outra.ok, false);
    assert.equal(chamadas, 1);
    fabrica.resolver(criarCliente());
    await abertura.promessa;
    await fim.promessa;
    const depois = await recurso.abrir();
    assert.equal(depois.ok, false);
    assert.equal(chamadas, 1);
  });

  test('SNAP-40 (G) — duas finalizações concorrentes durante a abertura: uma só espera e encerra; a outra é false de imediato; um ROLLBACK e um end()', async () => {
    const pendente = adiado();
    const cliente = criarCliente({ respostas: { IDENTIDADE: () => pendente.promessa } });
    const { recurso } = montar({ cliente });
    const abertura = acompanhar(recurso.abrir());
    await ate(() => cliente.log.includes('IDENTIDADE'));
    const a = acompanhar(recurso.finalizar());
    const b = acompanhar(recurso.finalizar());
    await andar();
    assert.equal(a.resolvido, false, 'a primeira espera a abertura');
    assert.equal(b.resolvido, true, 'a segunda não espera nem confirma');
    assert.deepEqual(b.valor, { concluida: false });
    pendente.resolver({ rows: [{ nome: 'gestao_epi', oid: '16384' }] });
    assert.equal((await abertura.promessa).ok, false);
    assert.deepEqual(await a.promessa, { concluida: true });
    assert.equal(cliente.log.filter((x) => x === 'ROLLBACK').length, 1);
    assert.equal(cliente.log.filter((x) => x === 'end').length, 1);
  });

  test('SNAP-41 — a abertura que TERMINOU antes da finalização segue o caminho normal (controle): ok true, depois ROLLBACK e end()', async () => {
    const { recurso, cliente } = montar();
    const r = await recurso.abrir();
    assert.equal(r.ok, true);
    assert.deepEqual(await recurso.finalizar(), { concluida: true });
    assert.deepEqual(cliente.log.slice(-2), ['ROLLBACK', 'end']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ repositório
describe('[SNAP] repositório da exportação', () => {
  test('SNAP-32 — exportarSnapshot(executor): uma consulta só, sem parâmetros, devolve o valor da coluna sem validar', async () => {
    const { exportarSnapshot } = exigirModulo(REPOSITORIO);
    const chamadas = [];
    const executor = { async query(sql, parametros) { chamadas.push({ sql, parametros }); return { rows: [{ snapshot_id: 'qualquer' }] }; } };
    assert.equal(await exportarSnapshot(executor), 'qualquer');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].sql, 'SELECT pg_export_snapshot() AS snapshot_id');
    assert.equal(chamadas[0].parametros, undefined);
  });
});
