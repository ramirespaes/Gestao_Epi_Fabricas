'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Kc = require('../helpers/p4b-caracterizacao');
const K = require('../../src/services/backup-fontes-coordenacao-operacoes.service');

/**
 * CD do backend, Etapa 3B-2B-2 — guardião de coordenação contra PostgreSQL 16 EFÊMERO. Fora do GitHub Actions a suíte
 * real é pulada; dentro dele, as condições do job de integração e o marcador `GEPI_CI_EFEMERO` são obrigatórios e a
 * ausência de qualquer um é FALHA, nunca pulo. O guardião e o provedor rodam como processos reais: o provedor
 * (deploy/hml/cd/coordenacao-por-guardiao.js) inicia `backend/scripts/guardiao-de-coordenacao.js` com ambiente vazio,
 * e o guardião se conecta com um papel descartável de privilégio mínimo, lido de um arquivo de credencial.
 *
 * As outras operações do D-ORF-6 rodam em sessões independentes, pelo próprio `adquirirExclusao` do D-ORF-6, usado
 * como está. Persistente, só o papel descartável (removido ao fim, com a lista de papéis conferida) e um schema
 * temporário para a migração recusada. Nada é aplicado no public; nenhum banco existente é alterado. A limpeza só
 * toca o que esta execução criou e registrou, e cada etapa dela é independente e tem prazo.
 */

const RAIZ_BACKEND = path.resolve(__dirname, '..', '..');
const GUARDIAO = path.join(RAIZ_BACKEND, 'scripts', 'guardiao-de-coordenacao.js');
const PROVEDOR = path.join(RAIZ_BACKEND, '..', 'deploy', 'hml', 'cd', 'coordenacao-por-guardiao.js');
const APLICACAO = 'safework-guardiao-cd';
const OPERACOES = ['BACKUP', 'RESTAURACAO', 'LIMPEZA', 'MIGRACAO'];
const PRAZOS = Object.freeze({ adquirirMs: 20000, confirmarMs: 10000, liberarMs: 10000, encerrarMs: 5000 });
const PRAZO_DE_LIMPEZA_MS = 10000;

// Par (classid, objid) de um advisory lock de chave bigint, calculado aqui em JS: independente da fórmula SQL do guardião.
const par = (chave) => { const v = BigInt.asUintN(64, BigInt(chave)); return `${v >> 32n}:${v & 0xffffffffn}`; };
const ESPERADOS = K.cadeadosDe('MIGRACAO').map(par).sort();
const dormir = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });
async function aguardar(condicao, { prazoMs = 15000, intervaloMs = 100, descricao = 'condição' } = {}) {
  const limite = Date.now() + prazoMs;
  for (;;) {
    if (await condicao()) return;
    if (Date.now() >= limite) throw new Error(`${descricao}: não ocorreu em ${prazoMs} ms`);
    await dormir(intervaloMs);
  }
}

// ---------------------------------------------------------------- controles do ensaio (testados sem banco, abaixo)

// Fora do GitHub Actions: pular. Dentro dele, este arquivo só roda no job de integração; condição inválida é falha.
function decidirExecucao(env) {
  if (env.GITHUB_ACTIONS !== 'true') return { modo: 'PULAR', motivo: 'fora do GitHub Actions' };
  const motivo = Kc.motivoDeRecusaCi(env);
  return motivo === null ? { modo: 'EXECUTAR', motivo: null } : { modo: 'FALHAR', motivo };
}

function comPrazo(promessa, ms, descricao) {
  let relogio;
  const prazo = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(Object.assign(new Error(`${descricao}: prazo de ${ms} ms vencido`), { prazoVencido: true })), ms);
    relogio.unref();
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

// Cada etapa é tentada, na ordem, mesmo que as anteriores falhem ou travem; devolve uma linha por falha.
async function limparEtapas(etapas) {
  const falhas = [];
  for (const etapa of etapas) {
    try {
      await comPrazo(Promise.resolve().then(() => etapa.executar()), etapa.prazoMs || PRAZO_DE_LIMPEZA_MS, etapa.nome);
    } catch (erro) {
      falhas.push(`${etapa.nome}: ${erro && erro.message ? erro.message : 'falha'}`);
    }
  }
  return falhas;
}

// Executa o corpo e depois a limpeza dele. O erro do corpo é sempre o que sai; falhas de limpeza que o acompanham vão
// para o registro do ensaio (o after as propaga). Sem erro no corpo, falha de limpeza reprova o teste.
async function comLimpeza(corpo, etapas, registro) {
  let resultado;
  let erro;
  let falhou = false;
  try { resultado = await corpo(); } catch (e) { erro = e; falhou = true; }
  const falhas = await limparEtapas(etapas);
  if (falhou) { registro.push(...falhas); throw erro; }
  if (falhas.length > 0) throw new Error(`limpeza do teste falhou: ${falhas.join('; ')}`);
  return resultado;
}

async function encerrarCliente(cliente, ms) {
  try {
    await comPrazo(Promise.resolve().then(() => cliente.end()), ms, 'client.end()');
  } catch (erro) {
    try { cliente.connection.stream.destroy(); } catch { /* sem soquete acessível */ }
    throw new Error(erro && erro.prazoVencido ? `client.end() não terminou em ${ms} ms; soquete destruído` : 'client.end() falhou; soquete destruído');
  }
}

const filhoVivo = (f) => f.exitCode === null && f.signalCode === null;
// Sinal só pela alça de um processo que este ensaio criou e registrou, e só enquanto ele está vivo.
function sinalizarFilho(filho, sinal, criados) {
  if (!criados.includes(filho)) throw new Error('processo não foi criado por este ensaio: nenhum sinal enviado');
  if (!filhoVivo(filho)) throw new Error('processo já encerrado: nenhum sinal enviado');
  if (filho.kill(sinal) !== true) throw new Error(`sinal ${sinal} não entregue`);
}
function aguardarSaida(filho, ms) {
  return new Promise((r) => {
    if (!filhoVivo(filho)) { r(true); return; }
    const relogio = setTimeout(() => r(false), ms);
    relogio.unref();
    filho.once('close', () => { clearTimeout(relogio); r(true); });
  });
}
// Derruba os que ainda vivem e espera, com prazo. Só declara concluído quando nenhum continua vivo.
async function encerrarFilhos(lista, ms) {
  const vivos = lista.filter(filhoVivo);
  for (const f of vivos) { try { f.kill('SIGKILL'); } catch { /* conferido abaixo */ } }
  await Promise.all(vivos.map((f) => aguardarSaida(f, ms)));
  return lista.filter(filhoVivo).map((f) => `processo ${f.pid} ainda vivo depois de ${ms} ms`);
}

// A sessão do guardião: exatamente uma, do papel e da aplicação, com o instante de início guardado como texto exato.
async function identificarSessaoUnica(admin, usuario, aplicacao) {
  const { rows } = await admin.query(
    'SELECT pid, usename AS usuario, application_name AS aplicacao, backend_start::text AS inicio FROM pg_stat_activity WHERE usename = $1 AND application_name = $2',
    [usuario, aplicacao],
  );
  if (rows.length !== 1) throw new Error(`esperava exatamente uma sessão do guardião, havia ${rows.length}`);
  const [s] = rows;
  return { pid: s.pid, usuario: s.usuario, aplicacao: s.aplicacao, inicio: s.inicio };
}
// Seleção e encerramento na MESMA instrução, presos à identidade completa: um PID reutilizado por outra sessão não
// confere com o início e o papel, e nada é encerrado.
async function encerrarSessaoIdentificada(admin, id) {
  const completa = id !== null && typeof id === 'object' && Number.isInteger(id.pid) && [id.usuario, id.aplicacao, id.inicio].every((t) => typeof t === 'string' && t !== '');
  if (!completa) throw new Error('identidade incompleta: nada encerrado');
  const { rows } = await admin.query(
    'SELECT pg_terminate_backend(pid) AS encerrada FROM pg_stat_activity WHERE pid = $1 AND usename = $2 AND application_name = $3 AND backend_start = $4::timestamptz',
    [id.pid, id.usuario, id.aplicacao, id.inicio],
  );
  if (rows.length !== 1) throw new Error('a identidade da sessão não confere mais: nada encerrado');
  if (rows[0].encerrada !== true) throw new Error('a sessão identificada não foi encerrada');
}

// ---------------------------------------------------------------- PostgreSQL 16 real

const decisao = decidirExecucao(process.env);

describe('CD 3B-2B-2 — guardião de coordenação com PostgreSQL 16 real (só na CI efêmera)', { skip: decisao.modo === 'PULAR' ? `CD_GUARDIAO_SO_EM_CI_EFEMERA: ${decisao.motivo}` : false }, () => {
  let Client;
  let P;
  let admin = null;
  let outra = null;
  let sistema;
  let papel = null;
  let papelCriado = false;
  let papeisAntes = null;
  let dir = null;
  let credencial;
  const filhos = [];
  const provedores = new Set();
  const contextos = new Set();
  const falhasDeLimpeza = [];
  const observacao = {};

  // Provedor real. O processo do guardião é registrado no instante em que nasce, e o provedor, até ser liberado.
  function novoProvedor({ prazos = PRAZOS, sinalNaoEntregue = false } = {}) {
    const alca = { filho: null };
    const iniciarProcesso = (comando, args, opcoes) => {
      const h = P.iniciarProcessoReal(comando, args, { ...opcoes, criarFilho: (c, a, o) => { const f = spawn(c, a, o); filhos.push(f); alca.filho = f; return f; } });
      return sinalNaoEntregue ? { ...h, matar: () => false } : h;
    };
    const coord = P.criarCoordenacaoPorGuardiao({ comando: [process.execPath, GUARDIAO], dir: RAIZ_BACKEND, credencial, sistema, prazos, iniciarProcesso });
    provedores.add(coord);
    return { coord, alca };
  }
  const liberarProvedor = (coord) => ({ nome: 'liberar o provedor', prazoMs: 30000, executar: async () => { await coord.liberar(); provedores.delete(coord); } });
  const encerrarContexto = (contexto) => ({ nome: `remover o schema ${contexto.schema}`, executar: async () => { await contexto.encerrar(); contextos.delete(contexto); } });
  const removerDiretorio = (caminho) => ({ nome: 'remover diretório temporário', executar: () => fs.rmSync(caminho, { recursive: true, force: true }) });
  const derrubarFilho = (alca) => ({ nome: 'encerrar o processo do guardião', executar: async () => { if (alca.filho) { const f = await encerrarFilhos([alca.filho], 5000); if (f.length) throw new Error(f.join('; ')); } } });

  const sessoesDoGuardiao = async () => (await admin.query('SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = $2', [papel, APLICACAO])).rows.map((l) => l.pid);
  const paresDoGuardiao = async () => (await admin.query(
    "SELECT l.classid::bigint::text AS alto, l.objid::bigint::text AS baixo, l.objsubid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.usename = $1",
    [papel],
  )).rows.map((l) => { assert.equal(l.objsubid, 1, 'chave bigint: objsubid 1'); return `${l.alto}:${l.baixo}`; }).sort();
  const cadeadosLivresParaOutraSessao = async () => {
    const livres = [];
    for (const chave of K.cadeadosDe('MIGRACAO')) {
      const { rows: [{ tomado }] } = await outra.query(`SELECT pg_try_advisory_lock(${chave}) AS tomado`);
      if (tomado) await outra.query(`SELECT pg_advisory_unlock(${chave})`);
      livres.push(tomado);
    }
    return livres;
  };
  const semRestos = async (descricao) => {
    await aguardar(async () => (await sessoesDoGuardiao()).length === 0, { descricao: `${descricao}: sessão do guardião encerrada no servidor` });
    assert.deepEqual(await paresDoGuardiao(), [], `${descricao}: nenhum cadeado do guardião`);
    assert.deepEqual(await cadeadosLivresParaOutraSessao(), [true, true, true, true], `${descricao}: as quatro chaves livres para outra sessão`);
  };

  before(async () => {
    if (decisao.modo === 'FALHAR') throw new Error(`CD_GUARDIAO_CI_INVALIDO: no GitHub Actions, mas ${decisao.motivo}; o ensaio é obrigatório e não é pulado`);
    ({ Client } = require('pg'));
    P = require(PROVEDOR);
    const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste, BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
    const configuracao = configuracaoDoBancoDeTeste();
    admin = new Client(configuracao);
    await admin.connect();
    outra = new Client(configuracao);
    await outra.connect();
    await confirmarBancoDeTeste(admin);
    const { rows: [m] } = await admin.query(Kc.SQL_MARCADOR_DO_BANCO);
    assert.ok(Kc.marcadorDoBancoConfere(m && m.marcador, Kc.marcadorEsperadoCi(process.env)), 'instância efêmera de CI não comprovada');
    sistema = (await admin.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
    papeisAntes = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname);
    assert.equal(papeisAntes.some((n) => n.startsWith('gepi_cd_guardiao_')), false, 'nenhum papel de ensaio anterior');
    const candidato = `gepi_cd_guardiao_${crypto.randomBytes(6).toString('hex')}`;
    const senha = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${candidato} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 8 PASSWORD '${senha}'`);
    papel = candidato;
    papelCriado = true;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-cd-guardiao-')));
    credencial = path.join(dir, 'credencial-do-guardiao.json');
    fs.writeFileSync(credencial, JSON.stringify({ host: configuracao.host, porta: configuracao.port, banco: BANCO_DE_TESTE, usuario: papel, senha }), { mode: 0o600 });
  });

  // Última linha de defesa: tudo o que esta execução criou e registrou, em etapas independentes e com prazo. Só se
  // declara a limpeza concluída sem falha, sem processo vivo e sem sessão do papel.
  after(async () => {
    const etapas = [];
    for (const coord of provedores) etapas.push(liberarProvedor(coord));
    for (const contexto of contextos) etapas.push(encerrarContexto(contexto));
    for (const contexto of [...contextos]) etapas.push({ nome: `conferir a remoção do schema ${contexto.schema}`, executar: async () => { const { rows } = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [contexto.schema]); if (rows.length > 0) throw new Error('o schema continua existindo'); } });
    etapas.push({ nome: 'encerrar os processos do guardião', executar: async () => { const f = await encerrarFilhos(filhos, 5000); if (f.length) throw new Error(f.join('; ')); } });
    if (papelCriado) etapas.push({ nome: 'encerrar as sessões do papel do ensaio', prazoMs: 20000, executar: async () => { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [papel]); await aguardar(async () => (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [papel])).rows[0].n === 0, { prazoMs: 15000, descricao: 'sessões do papel encerradas' }); } });
    if (papelCriado) etapas.push({ nome: 'remover o papel do ensaio', executar: async () => { await admin.query(`DROP ROLE IF EXISTS ${papel}`); papelCriado = false; } });
    if (papeisAntes !== null) etapas.push({ nome: 'conferir a lista de papéis', executar: async () => { const depois = (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map((r) => r.rolname); if (JSON.stringify(depois) !== JSON.stringify(papeisAntes)) throw new Error('a lista de papéis mudou'); } });
    if (dir !== null) etapas.push(removerDiretorio(dir));
    if (outra !== null) etapas.push({ nome: 'encerrar a conexão auxiliar', executar: () => encerrarCliente(outra, 5000) });
    if (admin !== null) etapas.push({ nome: 'encerrar a conexão administrativa', executar: () => encerrarCliente(admin, 5000) });
    const falhas = [...falhasDeLimpeza, ...await limparEtapas(etapas)];
    const vivos = filhos.filter(filhoVivo).length;
    observacao.limpeza = { concluida: falhas.length === 0 && vivos === 0, falhas: falhas.length, processosDoGuardiao: filhos.length, processosVivos: vivos };
    process.stdout.write(`CD_GUARDIAO_OBSERVACAO_JSON ${JSON.stringify({ ci: { run: process.env.GITHUB_RUN_ID, tentativa: process.env.GITHUB_RUN_ATTEMPT }, ...observacao })}\n`);
    if (falhas.length > 0 || vivos > 0) throw new Error(`limpeza incompleta: ${[...falhas, ...(vivos ? [`${vivos} processo(s) do guardião vivo(s)`] : [])].join('; ')}`);
  });

  test('papel de privilégio mínimo: sem superusuário, sem papéis herdados, e ainda assim lê a identidade do banco e do cluster', { timeout: 30000 }, async () => {
    const { rows: [r] } = await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1', [papel]);
    assert.deepEqual(r, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false });
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [papel])).rows[0].n, 0, 'membro de nenhum papel');
    const c = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: 'gestao_epi_teste_local', user: papel, password: JSON.parse(fs.readFileSync(credencial, 'utf8')).senha, connectionTimeoutMillis: 8000 });
    await comLimpeza(async () => {
      await c.connect();
      let identidade = null;
      let codigo = null;
      try {
        identidade = (await c.query('SELECT current_database() AS banco, pg_is_in_recovery() AS em_recuperacao, (SELECT system_identifier::text FROM pg_control_system()) AS sistema')).rows[0];
      } catch (e) { codigo = e.code || 'sem código'; }
      observacao.privilegioMinimo = { identidadeLida: identidade !== null, codigoDeErro: codigo };
      assert.equal(codigo, null, `o papel mínimo não lê a identidade (SQLSTATE ${codigo}): pg_control_system exige concessão`);
      assert.deepEqual(identidade, { banco: 'gestao_epi_teste_local', em_recuperacao: false, sistema });
    }, [{ nome: 'encerrar a conexão do papel mínimo', executar: () => encerrarCliente(c, 5000) }], falhasDeLimpeza);
  });

  test('aquisição: as quatro chaves do D-ORF-6 numa única sessão do guardião, confirmadas pela consulta de posse e bloqueadas para outra sessão', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      assert.equal((await sessoesDoGuardiao()).length, 1, 'uma única sessão dedicada');
      assert.deepEqual(await paresDoGuardiao(), ESPERADOS, 'as chaves de 64 bits, remontadas em JS, são exatamente as quatro de MIGRACAO');
      assert.deepEqual(await cadeadosLivresParaOutraSessao(), [false, false, false, false], 'nenhuma das quatro disponível para outra sessão');
      for (let i = 0; i < 3; i += 1) assert.equal((await coord.consultar()).situacao, 'LIVRE', `consulta ${i + 1}: a consulta de posse do guardião reconhece as quatro chaves`);
      observacao.aquisicao = { sessoes: 1, chaves: ESPERADOS.length, consultasLivres: 3 };
    }, [liberarProvedor(coord), derrubarFilho(alca)], falhasDeLimpeza);
    await semRestos('depois da aquisição');
  });

  test('exclusão mútua: com o guardião de posse, BACKUP, RESTAURACAO, LIMPEZA e MIGRACAO são recusadas sem espera, e a migração real falha rápido', { timeout: 90000 }, async () => {
    const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
    const { aplicarMigrations } = require('../../scripts/migrate');
    const { coord, alca } = novoProvedor();
    const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-cd-guardiao-mig-'));
    const etapas = [liberarProvedor(coord), derrubarFilho(alca), removerDiretorio(diretorio)];
    await comLimpeza(async () => {
      fs.writeFileSync(path.join(diretorio, '001_alfa.sql'), 'CREATE TABLE alfa_cd_guardiao (id INTEGER PRIMARY KEY);\n');
      assert.deepEqual(await coord.adquirir(), { ok: true });
      const recusas = {};
      for (const operacao of OPERACOES) {
        const inicio = Date.now();
        const r = await K.adquirirExclusao(outra, { operacao });
        recusas[operacao] = { ok: r.ok, motivo: r.motivo, ms: Date.now() - inicio };
        assert.deepEqual([r.ok, r.motivo], [false, 'MIGRACAO_EM_CURSO'], operacao);
      }
      const { rows: [{ n }] } = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1", [outra.processID]);
      assert.equal(n, 0, 'a sessão recusada não ficou com nenhum cadeado');
      const contexto = await abrirSchemaTemporario([]);
      contextos.add(contexto);
      etapas.push(encerrarContexto(contexto));
      const inicio = Date.now();
      await assert.rejects(() => aplicarMigrations({ schema: contexto.schema, diretorio }), 'a migração precisa falhar com o cadeado tomado pelo guardião');
      const msMigracao = Date.now() - inicio;
      const { rows: [{ existe }] } = await contexto.cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`${contexto.schema}.alfa_cd_guardiao`]);
      assert.equal(existe, false, 'nada aplicado');
      assert.equal((await coord.consultar()).situacao, 'LIVRE', 'o guardião continua de posse');
      observacao.exclusaoMutua = { recusas, migracaoRecusadaEmMs: msMigracao };
    }, etapas, falhasDeLimpeza);
    await semRestos('depois da exclusão mútua');
  });

  test('recusa do guardião: com BACKUP em curso em outra sessão, ou só a chave própria de outra operação, ele recusa, fica OCUPADO e não deixa sessão', { timeout: 60000 }, async () => {
    const backup = await K.adquirirExclusao(outra, { operacao: 'BACKUP' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const primeiro = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await primeiro.coord.adquirir(), { ok: false, motivo: 'MIGRACAO_EM_CURSO' });
      const estado = await primeiro.coord.consultar();
      assert.deepEqual([estado.situacao, estado.detalhe], ['OCUPADO', 'MIGRACAO_EM_CURSO']);
      assert.equal(await aguardarSaida(primeiro.alca.filho, 15000), true, 'o guardião recusado termina');
      assert.equal((await primeiro.coord.liberar()).processoEncerrado, true);
      await aguardar(async () => (await sessoesDoGuardiao()).length === 0, { descricao: 'sessão do guardião recusado encerrada' });
      assert.deepEqual(await paresDoGuardiao(), []);
    }, [liberarProvedor(primeiro.coord), derrubarFilho(primeiro.alca), { nome: 'soltar a exclusão do BACKUP', executar: () => backup.liberar() }], falhasDeLimpeza);
    await outra.query(`SELECT pg_advisory_lock(${K.CHAVE_DORF6.BACKUP})`);
    const segundo = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await segundo.coord.adquirir(), { ok: false, motivo: 'EM_USO' });
      assert.equal(await aguardarSaida(segundo.alca.filho, 15000), true);
    }, [liberarProvedor(segundo.coord), derrubarFilho(segundo.alca), { nome: 'soltar a chave do BACKUP', executar: () => outra.query(`SELECT pg_advisory_unlock(${K.CHAVE_DORF6.BACKUP})`) }], falhasDeLimpeza);
    await semRestos('depois das recusas');
    observacao.recusaDoGuardiao = { comBackup: 'MIGRACAO_EM_CURSO', soChaveDoBackup: 'EM_USO' };
  });

  test('liberação normal: o guardião informa a liberação, o processo termina, a sessão cai e as quatro chaves voltam a ficar livres', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      const lib = await coord.liberar();
      assert.deepEqual(lib, { situacao: 'LIBERACAO_INFORMADA', processoEncerrado: true, forcada: false, comprovadaNoBanco: false });
      assert.equal(alca.filho.exitCode, 0);
      await semRestos('depois da liberação normal');
      assert.deepEqual(await coord.liberar(), lib, 'idempotente');
      const depois = await K.adquirirExclusao(outra, { operacao: 'MIGRACAO' });
      assert.equal(depois.ok, true, 'a exclusão fica disponível para o D-ORF-6');
      await depois.liberar();
      observacao.liberacaoNormal = lib;
    }, [liberarProvedor(coord), derrubarFilho(alca)], falhasDeLimpeza);
  });

  test('perda da sessão PostgreSQL: encerrada pela identidade completa, o guardião avisa, termina e nada fica preso', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      const identidade = await identificarSessaoUnica(admin, papel, APLICACAO);
      await encerrarSessaoIdentificada(admin, identidade);
      assert.equal(await aguardarSaida(alca.filho, 15000), true, 'o processo do guardião terminou');
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      const lib = await coord.liberar();
      assert.equal(lib.processoEncerrado, true);
      await semRestos('depois da perda da sessão');
      observacao.perdaDaSessao = { saida: alca.filho.exitCode, sinal: alca.filho.signalCode, liberacao: lib.situacao };
    }, [liberarProvedor(coord), derrubarFilho(alca)], falhasDeLimpeza);
  });

  test('encerramento forçado do processo: com o guardião morto por SIGKILL, o servidor derruba a sessão e solta as quatro chaves', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor();
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      sinalizarFilho(alca.filho, 'SIGKILL', filhos);
      assert.equal(await aguardarSaida(alca.filho, 15000), true);
      assert.equal((await coord.consultar()).situacao, 'DESCONHECIDO');
      const lib = await coord.liberar();
      assert.deepEqual([lib.situacao, lib.processoEncerrado], ['PROCESSO_ENCERRADO', true]);
      await semRestos('depois do SIGKILL');
      observacao.encerramentoForcado = lib.situacao;
    }, [liberarProvedor(coord), derrubarFilho(alca)], falhasDeLimpeza);
  });

  test('encerramento tardio: guardião parado não responde à liberação; o provedor o derruba e só então informa o encerramento, forçado', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor({ prazos: { ...PRAZOS, liberarMs: 1500, encerrarMs: 8000 } });
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      sinalizarFilho(alca.filho, 'SIGSTOP', filhos);
      assert.deepEqual(await paresDoGuardiao(), ESPERADOS, 'parado, o guardião ainda segura as quatro chaves');
      const lib = await coord.liberar();
      assert.deepEqual([lib.situacao, lib.processoEncerrado, lib.forcada], ['PROCESSO_ENCERRADO', true, true]);
      await semRestos('depois do encerramento tardio');
      observacao.encerramentoTardio = lib;
    }, [liberarProvedor(coord), derrubarFilho(alca)], falhasDeLimpeza);
  });

  test('liberação indeterminada: sem o sinal entregue, o provedor responde INDETERMINADA e o PostgreSQL confirma que as chaves continuam presas', { timeout: 60000 }, async () => {
    const { coord, alca } = novoProvedor({ prazos: { ...PRAZOS, liberarMs: 1000, encerrarMs: 1000 }, sinalNaoEntregue: true });
    await comLimpeza(async () => {
      assert.deepEqual(await coord.adquirir(), { ok: true });
      sinalizarFilho(alca.filho, 'SIGSTOP', filhos);
      const lib = await coord.liberar();
      assert.deepEqual([lib.situacao, lib.processoEncerrado, lib.comprovadaNoBanco], ['INDETERMINADA', false, false]);
      assert.equal((await sessoesDoGuardiao()).length, 1, 'a sessão continua viva no servidor');
      assert.deepEqual(await paresDoGuardiao(), ESPERADOS, 'e as quatro chaves continuam presas: INDETERMINADA não é liberação');
      assert.deepEqual(await cadeadosLivresParaOutraSessao(), [false, false, false, false]);
      sinalizarFilho(alca.filho, 'SIGKILL', filhos);
      assert.equal(await aguardarSaida(alca.filho, 15000), true);
      const depois = await coord.liberar();
      assert.deepEqual([depois.situacao, depois.processoEncerrado], ['PROCESSO_ENCERRADO', true], 'o encerramento que chegou depois passa a contar');
      await semRestos('depois do encerramento tardio da liberação indeterminada');
      observacao.liberacaoIndeterminada = { primeira: lib.situacao, depoisDoEncerramento: depois.situacao };
    }, [derrubarFilho(alca), liberarProvedor(coord)], falhasDeLimpeza);
  });

  test('ao fim: nenhum processo do guardião vivo, nenhuma sessão do papel e nenhum cadeado do D-ORF-6 preso', { timeout: 30000 }, async () => {
    assert.ok(filhos.length >= 9);
    assert.deepEqual(filhos.filter(filhoVivo).map((f) => f.pid), []);
    await semRestos('ao fim');
    const { rows: [{ n }] } = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    assert.equal(n, 0, 'nenhum advisory lock no banco de teste');
  });
});

// Controles do próprio ensaio, sem banco e em qualquer ambiente: cliente PostgreSQL falso e processos Node descartáveis.
describe('CD 3B-2B-2 — controles do ensaio (simulação local, sem banco)', () => {
  const IDENTIDADE = Object.freeze({ pid: 4242, usuario: 'gepi_cd_guardiao_abcdef012345', aplicacao: 'safework-guardiao-cd', inicio: '2026-11-21 20:00:00.123456+00' });
  const adminFalso = (respostas) => {
    const consultas = [];
    return { consultas, query: async (sql, params) => { consultas.push({ sql, params }); const r = respostas.shift(); if (r instanceof Error) throw r; return r; } };
  };
  // Todo processo da simulação é registrado no instante em que é criado; cada teste o encerra no finally e o after da
  // suíte encerra o que restar. Essa proteção não usa as funções sob teste: vale mesmo quando elas falham ou faltam.
  const criados = [];
  const vivo = (f) => f.exitCode === null && f.signalCode === null;
  const nodeOcioso = () => { const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); criados.push(f); return f; };
  const esperarFim = (f, ms) => new Promise((r) => {
    if (!vivo(f)) { r(); return; }
    const t = setTimeout(r, ms);
    t.unref();
    f.once('close', () => { clearTimeout(t); r(); });
  });
  const derrubar = async (...lista) => {
    for (const f of lista) if (vivo(f)) { try { f.kill('SIGKILL'); } catch { /* já encerrado */ } }
    await Promise.all(lista.map((f) => esperarFim(f, 5000)));
  };
  after(async () => {
    await derrubar(...criados);
    const restantes = criados.filter(vivo).map((f) => f.pid);
    if (restantes.length > 0) throw new Error(`processos da simulação ainda vivos: ${restantes.join(', ')}`);
  });

  test('P2: fora do GitHub Actions o ensaio é pulado; dentro dele, condição inválida é falha explícita, nunca pulo', () => {
    assert.deepEqual(decidirExecucao({}), { modo: 'PULAR', motivo: 'fora do GitHub Actions' });
    assert.deepEqual(decidirExecucao({ GITHUB_ACTIONS: 'false' }), { modo: 'PULAR', motivo: 'fora do GitHub Actions' });
    const invalido = decidirExecucao({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
    assert.equal(invalido.modo, 'FALHAR');
    assert.match(invalido.motivo, /divergente|inválidos/);
    const valido = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'postgres', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GEPI_CI_NONCE: 'a'.repeat(32) };
    assert.deepEqual(decidirExecucao(valido), { modo: 'EXECUTAR', motivo: null });
    assert.equal(decidirExecucao({ ...valido, PGPASSWORD: 'x' }).modo, 'FALHAR', 'variável proibida no CI também é falha');
  });

  test('P1: identificação da sessão exige exatamente uma sessão do papel e da aplicação, com PID e início', async () => {
    const um = adminFalso([{ rows: [{ pid: 4242, usuario: IDENTIDADE.usuario, aplicacao: IDENTIDADE.aplicacao, inicio: IDENTIDADE.inicio }] }]);
    assert.deepEqual(await identificarSessaoUnica(um, IDENTIDADE.usuario, IDENTIDADE.aplicacao), IDENTIDADE);
    assert.match(um.consultas[0].sql, /backend_start::text/);
    for (const rows of [[], [{ pid: 1, usuario: 'a', aplicacao: 'b', inicio: 'c' }, { pid: 2, usuario: 'a', aplicacao: 'b', inicio: 'c' }]]) {
      await assert.rejects(identificarSessaoUnica(adminFalso([{ rows }]), IDENTIDADE.usuario, IDENTIDADE.aplicacao), /exatamente uma sessão/);
    }
  });

  test('P1: o encerramento seleciona e encerra na MESMA instrução, condicionado a PID, papel, aplicação e início da sessão', async () => {
    const a = adminFalso([{ rows: [{ encerrada: true }] }]);
    await encerrarSessaoIdentificada(a, IDENTIDADE);
    assert.equal(a.consultas.length, 1, 'uma única instrução');
    const { sql, params } = a.consultas[0];
    assert.doesNotMatch(sql, /;/);
    assert.match(sql, /^SELECT pg_terminate_backend\(pid\) AS encerrada FROM pg_stat_activity WHERE /);
    for (const condicao of ['pid = $1', 'usename = $2', 'application_name = $3', 'backend_start = $4::timestamptz']) assert.ok(sql.includes(condicao), condicao);
    assert.deepEqual(params, [IDENTIDADE.pid, IDENTIDADE.usuario, IDENTIDADE.aplicacao, IDENTIDADE.inicio]);
  });

  test('P1: se a identidade não confere mais (PID reutilizado, outra sessão), nada é encerrado e o teste falha', async () => {
    await assert.rejects(encerrarSessaoIdentificada(adminFalso([{ rows: [] }]), IDENTIDADE), /identidade da sessão não confere/);
    await assert.rejects(encerrarSessaoIdentificada(adminFalso([{ rows: [{ encerrada: false }] }]), IDENTIDADE), /não foi encerrada/);
    for (const falta of ['pid', 'usuario', 'aplicacao', 'inicio']) {
      const a = adminFalso([]);
      await assert.rejects(encerrarSessaoIdentificada(a, { ...IDENTIDADE, [falta]: undefined }), /identidade incompleta/, falta);
      assert.equal(a.consultas.length, 0, `${falta}: nada enviado ao banco`);
    }
  });

  test('P1: a limpeza tenta todas as etapas, independentes, com prazo próprio, e devolve cada falha pelo nome', async () => {
    const feitas = [];
    const inicio = Date.now();
    const falhas = await limparEtapas([
      { nome: 'lança', executar: async () => { feitas.push('lança'); throw new Error('x'); } },
      { nome: 'trava', prazoMs: 80, executar: () => { feitas.push('trava'); return new Promise(() => {}); } },
      { nome: 'ok', executar: async () => { feitas.push('ok'); } },
      { nome: 'síncrona que lança', executar: () => { feitas.push('síncrona'); throw new Error('y'); } },
    ]);
    assert.deepEqual(feitas, ['lança', 'trava', 'ok', 'síncrona']);
    assert.deepEqual(falhas.map((f) => f.split(':')[0]), ['lança', 'trava', 'síncrona que lança']);
    assert.match(falhas[1], /prazo de 80 ms/);
    assert.ok(Date.now() - inicio < 2000, 'a etapa travada não prende a limpeza');
  });

  test('P1: o erro original do teste nunca é encoberto pela limpeza; a falha de limpeza vai para o registro do ensaio', async () => {
    const registro = [];
    const original = new Error('asserção original');
    await assert.rejects(comLimpeza(async () => { throw original; }, [{ nome: 'liberar', executar: async () => { throw new Error('falhou'); } }], registro), (e) => e === original);
    assert.deepEqual(registro.map((f) => f.split(':')[0]), ['liberar']);
    const r2 = [];
    await assert.rejects(comLimpeza(async () => 'ok', [{ nome: 'schema', executar: async () => { throw new Error('ficou'); } }], r2), /limpeza do teste falhou: schema/);
    assert.equal(await comLimpeza(async () => 'valor', [{ nome: 'ok', executar: async () => {} }], []), 'valor');
  });

  test('P2: encerrar um cliente que não responde tem prazo; vencido, o soquete é destruído e a falha registrada', async () => {
    let destruido = false;
    const travado = { end: () => new Promise(() => {}), connection: { stream: { destroy: () => { destruido = true; } } } };
    const inicio = Date.now();
    await assert.rejects(encerrarCliente(travado, 80), /client\.end\(\) não terminou em 80 ms/);
    assert.equal(destruido, true);
    assert.ok(Date.now() - inicio < 2000);
    await encerrarCliente({ end: async () => {} }, 80);
  });

  test('P2: sinais só pela alça do processo criado pelo ensaio; processo alheio ou já encerrado é recusado', async () => {
    const meus = [];
    const filho = nodeOcioso();
    meus.push(filho);
    const outro = nodeOcioso();
    try {
      assert.throws(() => sinalizarFilho(outro, 'SIGKILL', meus), /não foi criado por este ensaio/);
      assert.equal(outro.exitCode, null, 'o processo alheio não recebeu sinal');
      sinalizarFilho(filho, 'SIGKILL', meus);
      assert.equal(await aguardarSaida(filho, 5000), true);
      assert.throws(() => sinalizarFilho(filho, 'SIGKILL', meus), /já encerrado/);
    } finally {
      await derrubar(filho, outro);
    }
  });

  test('P2: confirmar o encerramento dos filhos: espera com prazo, derruba os que restam e só declara concluído sem processo vivo', async () => {
    const parado = nodeOcioso();
    try {
      assert.equal(await aguardarSaida(parado, 100), false, 'vivo: a espera vence o prazo e diz que não saiu');
      const falhas = await encerrarFilhos([parado], 5000);
      assert.deepEqual(falhas, []);
      assert.ok(parado.exitCode !== null || parado.signalCode !== null);
    } finally {
      await derrubar(parado);
    }
    // Alça falsa que nunca sai: nenhum processo real recebe sinal, e o encerramento é declarado como não concluído.
    const imortal = { pid: 1, exitCode: null, signalCode: null, kill: () => true, once: () => {} };
    const f2 = await encerrarFilhos([imortal], 100);
    assert.match(f2[0], /processo 1 ainda vivo/);
  });

  test('P1/P2: invariantes do arquivo: nenhum sinal por PID, encerramento de sessão só pela identidade ou pelo papel do ensaio, e o papel só é removido se foi criado aqui', () => {
    const fonte = fs.readFileSync(__filename, 'utf8');
    assert.doesNotMatch(fonte, /process\.kill\(/);
    const usos = [...fonte.matchAll(/pg_terminate_backend\(pid\)[^`'"]*/g)].map((m) => m[0]);
    assert.equal(usos.length, 2, 'dois usos: por identidade completa e, na limpeza, pelo papel criado pela execução');
    assert.match(fonte, /if \(papelCriado\) .*DROP ROLE IF EXISTS/);
    assert.doesNotMatch(fonte, /WHERE usename = \$1['"`], \[papel\]\);\n\s*await dormir/);
  });
});
