'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const { BANCO_DE_TESTE, configuracaoDoBancoDeTeste } = require('./helpers/banco-de-teste');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const limpeza = require('../../src/services/imagem-armazenamento-limpeza.service');
const { lockDaBiblioteca } = require('../../src/utils/lock-biblioteca-imagens');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, G6 e G7): o comando REAL, em processo próprio, contra PostgreSQL real, e o que só o servidor prova (lock_timeout, 55P03 e o
 * estado da sessão depois da limpeza); na G7, SIGINT e SIGTERM contra esse mesmo comando (INT-SIG), sempre e só contra o processo filho que o próprio teste iniciou. Mesmo contrato
 * dos demais testes de integração: banco de testes exclusivo (helpers/banco-de-teste.js), schema temporário com todas as
 * migrations e DROP SCHEMA ... CASCADE ao fim, diretórios temporários exclusivos; nenhuma das 30 imagens reais. O processo filho recebe um ambiente MONTADO aqui: do ambiente do
 * teste só vão as credenciais do banco de testes (o diretório de imagens e a trava de janela são os temporários; o schema temporário chega por PGOPTIONS).
 */

const { AGORA, DIA, h } = a;
const BACKEND = path.join(__dirname, '..', '..');
const COMANDO = path.join(BACKEND, 'scripts', 'imagens-limpar-orfaos.js');
const GUARDA_DO_BANCO = path.join(BACKEND, 'test', 'integracao', 'exigir-banco-de-teste.js');
const PRAZO_DO_PROCESSO_MS = 90000;

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

/** Todo teste daqui tem prazo próprio: uma trava que nunca se solta vira FALHA com nome, não um job parado. */
const teste = (nome, corpo) => test(nome, { timeout: 180000 }, corpo);

async function comAmbiente(corpo) {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  const amb = await abrirAmbienteImagens();
  try {
    await corpo({ amb, raiz, pastaDaTrava, janela: path.join(pastaDaTrava, 'janela-imagens.lock') });
  } finally {
    await amb.encerrar();
  }
}

/**
 * Ambiente do filho, montado do zero. NODE_OPTIONS e GEPI_RASTRO_ARQUIVO só são repassados quando existem: são a instrumentação opcional de uma execução local (rastro de
 * conexões), que assim vale também para o processo filho; a guarda do banco de testes sempre é carregada nele.
 */
function ambienteDoFilho(amb, { raiz, janela }) {
  return {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: BANCO_DE_TESTE,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    PGOPTIONS: `-c search_path=${amb.schema}`,
    IMAGENS_ARMAZENAMENTO_DIRETORIO: raiz,
    IMAGENS_JANELA_ESCRITA_ARQUIVO: janela,
    NODE_ENV: 'test',
    GEPI_RASTRO_ARQUIVO: process.env.GEPI_RASTRO_ARQUIVO,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require "${GUARDA_DO_BANCO}"`].filter(Boolean).join(' '),
  };
}

/** Inicia um processo Node; `termino` resolve com código, sinal e saídas inteiras quando ele fecha. O prazo é só uma rede de segurança do filho que este teste iniciou (SIGTERM, nunca a outro processo). */
function iniciar(argumentosDoNode, env) {
  const filho = spawn(process.execPath, argumentosDoNode, {
    cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: PRAZO_DO_PROCESSO_MS,
  });
  let stdout = '';
  let stderr = '';
  filho.stdout.setEncoding('utf8').on('data', (pedaco) => { stdout += pedaco; });
  filho.stderr.setEncoding('utf8').on('data', (pedaco) => { stderr += pedaco; });
  const termino = new Promise((resolver, rejeitar) => {
    filho.once('error', rejeitar);
    filho.once('close', (codigo, sinal) => resolver({ codigo, sinal, stdout, stderr }));
  });
  return { filho, termino, saidas: () => ({ stdout, stderr }) };
}
const comando = (argumentos, env) => iniciar([COMANDO, ...argumentos], env);
const rodar = (argumentos, env) => comando(argumentos, env).termino;

const SONDA_DO_AMBIENTE = `
const { pool } = require(${JSON.stringify(path.join(BACKEND, 'src', 'config', 'database'))});
pool.query("SELECT current_database() AS banco, current_setting('search_path') AS caminho, current_schema() AS esquema, to_regclass('imagens_empresa')::text AS tabela")
  .then(({ rows }) => { process.stdout.write(JSON.stringify(rows[0])); return pool.end(); })
  .catch((erro) => { process.stderr.write(String(erro.code ?? 'erro')); process.exitCode = 1; return pool.end(); });
`;

const argumentosDeExecucao = (banco, { json = true, oid = banco.oid, nome = banco.nome } = {}) => [
  ...(json ? ['--json'] : []), '--executar', '--banco-autorizado', nome, '--banco-oid', String(oid), '--intervalo-backup-minutos', '60',
];

let sequencia = 0;
/** Semente única por imagem: o SHA-256 de cada uma precisa ser distinto (restrições de unicidade do banco). */
const semente = (prefixo) => { sequencia += 1; return `${prefixo}-cli-real-${sequencia}`; };

/** Imagem REGISTRADA de verdade (arquivos na raiz temporária e linha real no schema temporário), com idade medida no relógio `agora`. */
async function registrada(amb, raiz, agora, { empresaId, criadoPor }) {
  const arq = h.criarImagemEmpresa(raiz, { id: 0, empresaId, semente: semente('r'), agora, minutosAtras: 30 * DIA });
  const linha = await amb.daEmpresa(empresaId, criadoPor, {
    sha256: arq.linha.sha256,
    sha256_mestre: arq.linha.sha256_mestre,
    sha256_exibicao: arq.linha.sha256_exibicao,
    sha256_miniatura: arq.linha.sha256_miniatura,
    formato: arq.linha.formato,
    bytes_mestre: arq.linha.bytes_mestre,
    bytes_exibicao: arq.linha.bytes_exibicao,
    bytes_miniatura: arq.linha.bytes_miniatura,
  });
  return { arq, linha };
}
const orfao = (raiz, agora, empresaId, prefixo, extra = {}) => a.criarOrfao(raiz, { empresaId, semente: semente(prefixo), idadeMin: 3 * DIA, agora, ...extra });
const bytesDaPasta = (pasta) => fs.readdirSync(pasta).reduce((soma, nome) => soma + fs.statSync(path.join(pasta, nome)).size, 0);

/** Retrato do banco (contagem e resumo MD5 de cada tabela que a limpeza poderia, por engano, alterar). */
async function retratoDoBanco(amb) {
  const resultado = {};
  for (const tabela of ['empresas', 'imagens_empresa', 'imagens_padrao', 'materiais', 'logs_auditoria']) {
    const { rows } = await amb.q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, ',' ORDER BY id), '')) AS resumo FROM ${tabela} t`);
    resultado[tabela] = rows[0];
  }
  return resultado;
}

/** Espera, no próprio banco (pg_blocking_pids), uma sessão bloqueada pela transação `pidDoBloqueador`; o limite é folgado porque inclui a partida de um processo Node. */
async function esperarSessaoBloqueadaPor(amb, pidDoBloqueador, limiteMs = 30000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const { rows } = await amb.q('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pidDoBloqueador]);
    if (rows.length > 0) return rows[0].pid;
    await new Promise((resolver) => { setTimeout(resolver, 20); });
  }
  throw new Error('nenhuma sessão ficou bloqueada pela transação segurada');
}

/** A saída do comando nunca leva o caminho do armazenamento nem o da trava, caractere de controle ou a senha do banco. */
function saidaSegura(texto, { raiz, pastaDaTrava }) {
  assert.equal(a.saidaLimpa(texto, raiz), true, 'a saída não pode levar o caminho do armazenamento nem caractere de controle');
  assert.equal(texto.includes(pastaDaTrava), false, 'a saída não pode levar o caminho da trava de janela');
  const senha = process.env.DB_PASSWORD;
  if (typeof senha === 'string' && senha.length >= 8) assert.equal(texto.includes(senha), false, 'a saída não pode levar a senha do banco');
}

describe('[INT-CLI] o comando real, em processo próprio, contra o PostgreSQL real', () => {
  teste('INT-CLI-01 — o ambiente do filho: o banco é o de testes, o schema temporário chega por PGOPTIONS e as tabelas resolvem nele', async () => {
    await comAmbiente(async ({ amb, raiz, janela }) => {
      const r = await iniciar(['-e', SONDA_DO_AMBIENTE], ambienteDoFilho(amb, { raiz, janela })).termino;
      assert.equal(r.codigo, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { banco: BANCO_DE_TESTE, caminho: amb.schema, esquema: amb.schema, tabela: 'imagens_empresa' });
    });
  });

  teste('INT-CLI-02 — caminho real de sucesso: a SIMULAÇÃO lista o que a EXECUÇÃO depois remove; o banco e as imagens registradas ficam como estavam, a trava de janela é liberada e uma segunda execução não tem o que fazer', async () => {
    await comAmbiente(async ({ amb, raiz, pastaDaTrava, janela }) => {
      const agora = Date.now();
      const { empresaA, empresaB, atorA } = amb.d;
      const a1 = await registrada(amb, raiz, agora, { empresaId: empresaA, criadoPor: atorA });
      const orfaA = orfao(raiz, agora, empresaA, 'oa');
      const orfaB = orfao(raiz, agora, empresaB, 'ob', { hash: a1.arq.shaEnvio });
      const recente = orfao(raiz, agora, empresaA, 'or', { idadeMin: 5 });
      const tmp = a.criarTemporario(raiz, { empresaId: empresaA, hash: a1.arq.shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA, agora });
      const esperados = [['ORFAO_CONJUNTO', empresaA, orfaA.hash], ['ORFAO_CONJUNTO', empresaB, orfaB.hash], ['TEMPORARIO_RESIDUAL', empresaA, a1.arq.shaEnvio]].sort();
      const bytesEsperados = bytesDaPasta(orfaA.pasta) + bytesDaPasta(orfaB.pasta) + fs.statSync(tmp.caminho).size;
      const banco = await verificador.identificarBanco(amb.pool);
      assert.equal(banco.nome, BANCO_DE_TESTE);
      const env = ambienteDoFilho(amb, { raiz, janela });
      const arvoreAntes = h.retratoDaArvore(raiz);
      const imagemAntes = h.retratoDaArvore(path.join(raiz, a1.arq.pasta)).filter((i) => !i.rel.endsWith('.tmp'));
      const bancoAntes = await retratoDoBanco(amb);

      const simulacao = await rodar(['--json', '--intervalo-backup-minutos', '60'], env);
      assert.equal(simulacao.codigo, 0, simulacao.stderr);
      assert.equal(simulacao.stderr, '');
      const plano = JSON.parse(simulacao.stdout);
      assert.deepEqual([plano.banco.nome, plano.banco.oid, plano.destinoConfere], [banco.nome, banco.oid, false]);
      assert.equal(plano.relatorio.modo, 'SIMULACAO');
      assert.equal(plano.relatorio.veredito, 'ORFAO');
      assert.deepEqual(plano.relatorio.candidatos.map((x) => [x.tipo, x.empresaId, x.hash]).sort(), esperados);
      assert.deepEqual(plano.relatorio.retidos.map((x) => x.hash), [recente.hash]);
      assert.deepEqual(h.retratoDaArvore(raiz), arvoreAntes, 'a simulação não muda a árvore');
      assert.deepEqual(await retratoDoBanco(amb), bancoAntes, 'a simulação não muda o banco');
      assert.equal(fs.existsSync(janela), false, 'a simulação não toma a trava de janela');
      saidaSegura(simulacao.stdout, { raiz, pastaDaTrava });

      const execucao = await rodar(argumentosDeExecucao(banco, { json: false }), env);
      assert.equal(execucao.codigo, 0, execucao.stderr + execucao.stdout);
      assert.equal(execucao.stderr, '');
      assert.match(execucao.stdout, /Limpeza de órfãos das imagens — EXECUÇÃO/);
      assert.match(execucao.stdout, new RegExp(`Banco conferido pela conexão: ${BANCO_DE_TESTE} \\(oid ${banco.oid}\\); destino autorizado confere`));
      assert.match(execucao.stdout, /Janela de escrita: tomada pela limpeza e liberada ao final/);
      assert.match(execucao.stdout, new RegExp(`Resumo: removidos=3 · ignorados=0 · falhas=0 · bytes liberados=${bytesEsperados} · restantes=0 · limite=50`));
      saidaSegura(execucao.stdout, { raiz, pastaDaTrava });
      assert.equal(orfaA.existe() || orfaB.existe(), false, 'os órfãos antigos foram removidos');
      assert.equal(fs.existsSync(tmp.caminho), false, 'o temporário antigo foi removido');
      assert.equal(recente.existe(), true, 'o órfão recente fica');
      assert.deepEqual(h.retratoDaArvore(path.join(raiz, a1.arq.pasta)), imagemAntes, 'a imagem registrada fica como estava');
      assert.equal(fs.existsSync(janela), false, 'a trava de janela é liberada ao fim');
      assert.deepEqual(await retratoDoBanco(amb), bancoAntes, 'a limpeza nunca escreve no banco');
      const depois = await verificador.verificarArmazenamento(amb.pool, { diretorio: raiz, agora: () => Date.now() });
      assert.equal(depois.veredito, 'INTEGRO');
      assert.deepEqual(depois.armazenamento.filter((s) => !s.recente), []);

      const segunda = await rodar(argumentosDeExecucao(banco, { json: false }), env);
      assert.equal(segunda.codigo, 0, segunda.stderr + segunda.stdout);
      assert.match(segunda.stdout, /Resumo: removidos=0 · ignorados=0 · falhas=0 · bytes liberados=0 · restantes=0/);
      assert.match(segunda.stdout, /Nada foi removido\./);
      assert.equal(fs.existsSync(janela), false);
    });
  });

  teste('INT-CLI-03 — destino que não confere (OID errado, ou nome de outro banco com o OID certo): o comando sai com 2 sem ler, remover nem tomar a trava de janela', async () => {
    await comAmbiente(async ({ amb, raiz, pastaDaTrava, janela }) => {
      const agora = Date.now();
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, agora, { empresaId: empresaA, criadoPor: atorA });
      const alvo = orfao(raiz, agora, empresaA, 'd1');
      const banco = await verificador.identificarBanco(amb.pool);
      const env = ambienteDoFilho(amb, { raiz, janela });
      const arvoreAntes = h.retratoDaArvore(raiz);
      const bancoAntes = await retratoDoBanco(amb);
      const tentativas = [
        ['OID errado', argumentosDeExecucao(banco, { oid: Number(banco.oid) + 1 })],
        ['nome de outro banco com o OID certo', argumentosDeExecucao(banco, { nome: 'gestao_epi_homolog_local' })],
      ];
      for (const [rotulo, argumentos] of tentativas) {
        const r = await rodar(argumentos, env);
        assert.equal(r.codigo, 2, `${rotulo}: ${r.stderr}`);
        assert.match(r.stderr, /Recusado \(DESTINO_NAO_AUTORIZADO\)/, rotulo);
        assert.equal(r.stdout, '', rotulo);
        saidaSegura(r.stderr, { raiz, pastaDaTrava });
        assert.equal(alvo.existe(), true, `${rotulo}: nada foi removido`);
        assert.equal(fs.existsSync(janela), false, `${rotulo}: a trava de janela não foi tomada`);
        assert.deepEqual(h.retratoDaArvore(raiz), arvoreAntes, rotulo);
        assert.deepEqual(await retratoDoBanco(amb), bancoAntes, rotulo);
      }
    });
  });

  teste('INT-CLI-04 — trava de janela de OUTRO dono (um backup em andamento, ou deixada por um processo que já morreu): o comando sai com 6, não remove nada e NUNCA mexe na trava alheia', async () => {
    await comAmbiente(async ({ amb, raiz, pastaDaTrava }) => {
      const agora = Date.now();
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, agora, { empresaId: empresaA, criadoPor: atorA });
      const alvo = orfao(raiz, agora, empresaA, 'j1');
      const banco = await verificador.identificarBanco(amb.pool);
      const arvoreAntes = h.retratoDaArvore(raiz);
      const bancoAntes = await retratoDoBanco(amb);
      for (const [rotulo, pid] of [['dono vivo', process.pid], ['dono morto', a.pidMorto()]]) {
        const trava = path.join(pastaDaTrava, `janela-${rotulo.replace(' ', '-')}.lock`);
        const documento = a.escreverTravaAlheia(trava, { tipo: 'BACKUP', pid, iniciadoEm: new Date().toISOString() });
        const antes = { conteudo: fs.readFileSync(trava, 'utf8'), ino: fs.statSync(trava).ino, mtimeMs: fs.statSync(trava).mtimeMs };

        const r = await rodar(argumentosDeExecucao(banco), ambienteDoFilho(amb, { raiz, janela: trava }));
        assert.equal(r.codigo, 6, `${rotulo}: ${r.stderr}`);
        const { recusa, removidos, janela } = JSON.parse(r.stdout).relatorio;
        assert.equal(recusa.codigo, 'JANELA_OCUPADA', rotulo);
        assert.deepEqual(recusa.dono, { tipo: 'BACKUP', pid, iniciadoEm: documento.iniciadoEm }, rotulo);
        assert.equal(janela.estado, 'OCUPADA', rotulo);
        assert.deepEqual(removidos, [], rotulo);
        assert.equal(`${r.stdout}${r.stderr}`.includes(documento.token), false, `${rotulo}: o token da trava nunca sai`);
        assert.deepEqual({ conteudo: fs.readFileSync(trava, 'utf8'), ino: fs.statSync(trava).ino, mtimeMs: fs.statSync(trava).mtimeMs }, antes, `${rotulo}: a trava alheia fica intacta`);
        assert.equal(alvo.existe(), true, `${rotulo}: nada foi removido`);
        assert.deepEqual(h.retratoDaArvore(raiz), arvoreAntes, rotulo);
        assert.deepEqual(await retratoDoBanco(amb), bancoAntes, rotulo);
      }
    });
  });

  teste('INT-CLI-05 — duas execuções simultâneas: a primeira segura a trava de janela enquanto espera a trava do banco, a segunda é recusada (6) sem tocar na da primeira, e a primeira conclui sozinha quando o banco libera', async () => {
    await comAmbiente(async ({ amb, raiz, janela }) => {
      const agora = Date.now();
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, agora, { empresaId: empresaA, criadoPor: atorA });
      const alvo = orfao(raiz, agora, empresaA, 'k1');
      const banco = await verificador.identificarBanco(amb.pool);
      const env = ambienteDoFilho(amb, { raiz, janela });
      const ocupante = await amb.pool.connect();
      let ocupando = false;
      let primeira = null;
      try {
        const { rows: [{ pid: pidDoOcupante }] } = await ocupante.query('SELECT pg_backend_pid() AS pid');
        await ocupante.query('BEGIN');
        ocupando = true;
        await ocupante.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaA)]);

        primeira = comando(argumentosDeExecucao(banco), env);
        // A primeira precisa estar bloqueada pela trava do banco, e portanto já com a trava de janela: o prazo da espera dela (5 s) cobre o início da segunda.
        await Promise.race([
          esperarSessaoBloqueadaPor(amb, pidDoOcupante),
          primeira.termino.then((r) => { throw new Error(`a primeira execução terminou antes de esperar a trava (código ${r.codigo})`); }),
        ]);
        const travaDaPrimeira = fs.readFileSync(janela, 'utf8');
        const documento = JSON.parse(travaDaPrimeira);
        assert.deepEqual([documento.tipo, documento.pid], ['LIMPEZA', primeira.filho.pid]);

        const segunda = await rodar(argumentosDeExecucao(banco), env);
        assert.equal(segunda.codigo, 6, segunda.stderr);
        const { recusa, removidos } = JSON.parse(segunda.stdout).relatorio;
        assert.equal(recusa.codigo, 'JANELA_OCUPADA');
        assert.deepEqual([recusa.dono.tipo, recusa.dono.pid], ['LIMPEZA', primeira.filho.pid]);
        assert.deepEqual(removidos, []);
        assert.equal(`${segunda.stdout}${segunda.stderr}`.includes(documento.token), false, 'o token da trava nunca sai');
        assert.equal(fs.readFileSync(janela, 'utf8'), travaDaPrimeira, 'a recusa da segunda não mexeu na trava da primeira');
        assert.equal(alvo.existe(), true, 'enquanto a primeira espera, nada foi removido');
      } finally {
        if (ocupando) await ocupante.query('ROLLBACK');
        ocupante.release();
        if (primeira !== null) await primeira.termino.catch(() => {});
      }

      const concluida = await primeira.termino;
      assert.equal(concluida.codigo, 0, concluida.stderr);
      const { relatorio } = JSON.parse(concluida.stdout);
      assert.deepEqual(relatorio.removidos.map((x) => x.hash), [alvo.hash]);
      assert.deepEqual([relatorio.ignorados, relatorio.falhas], [[], []]);
      assert.equal(relatorio.janela.estado, 'LIBERADA');
      assert.equal(alvo.existe(), false);
      assert.equal(fs.existsSync(janela), false, 'quem tomou a trava de janela foi quem a liberou');
    });
  });
});

const FIM_DE_TRANSACAO = /^(?:COMMIT|ROLLBACK|END|ABORT)\b/i;
const INICIO_DE_TRANSACAO = /^(?:BEGIN|START TRANSACTION)\b/i;

/**
 * Pool que observa, NO SERVIDOR, o estado de cada transação logo antes do COMMIT/ROLLBACK (modo, isolamento, lock_timeout e quantas travas advisory a sessão detém), o PID
 * da conexão física de cada `connect` e o código SQLSTATE de cada consulta que falha. A amostra de uma transação abortada fica "indisponível".
 */
function observarServidor(pool) {
  const transacoes = [];
  const erros = [];
  const pids = [];
  return {
    transacoes,
    erros,
    pids,
    pool: {
      async connect() {
        const cliente = await pool.connect();
        pids.push((await cliente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        let aberta = false;
        return {
          async query(texto, params) {
            const sql = String(texto).replace(/\s+/g, ' ').trim();
            if (aberta && FIM_DE_TRANSACAO.test(sql)) {
              aberta = false;
              try {
                const { rows } = await cliente.query(`SELECT current_setting('transaction_read_only') AS somente_leitura, current_setting('transaction_isolation') AS isolamento,
                  current_setting('lock_timeout') AS lock_timeout,
                  (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()) AS travas_advisory`);
                transacoes.push(rows[0]);
              } catch {
                transacoes.push({ amostra: 'indisponível' });
              }
            }
            try {
              const resposta = await cliente.query(texto, params);
              if (INICIO_DE_TRANSACAO.test(sql)) aberta = true;
              return resposta;
            } catch (erro) {
              erros.push(erro.code);
              throw erro;
            }
          },
          release: () => cliente.release(),
        };
      },
      query: (...argumentos) => pool.query(...argumentos),
    },
  };
}

const estadoDaSessao = async (pool) => (await pool.query(`SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('transaction_read_only') AS somente_leitura,
  current_setting('transaction_isolation') AS isolamento, current_setting('default_transaction_read_only') AS padrao_somente_leitura`)).rows[0];

describe('[INT-SRV] o que só o servidor prova', () => {
  teste('INT-SRV-01 — a espera pela trava termina pelo lock_timeout DO SERVIDOR (SQLSTATE 55P03) e a transação do conjunto roda com lock_timeout próprio, READ ONLY, READ COMMITTED e uma trava advisory; a mesma conexão física volta ao estado inicial depois', async () => {
    await comAmbiente(async ({ amb, raiz, janela }) => {
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, AGORA, { empresaId: empresaA, criadoPor: atorA });
      const alvo = orfao(raiz, AGORA, empresaA, 's1');
      const executar = (pool) => limpeza.limparOrfaos(pool, {
        diretorio: raiz, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, janela: { arquivo: janela }, tempoMaximoDaTravaMs: 300,
      });
      const unica = new Pool({ ...configuracaoDoBancoDeTeste(), options: `-c search_path=${amb.schema}`, max: 1 });
      const ocupante = await amb.pool.connect();
      let ocupando = false;
      try {
        const inicial = await estadoDaSessao(unica);
        assert.deepEqual([inicial.lock_timeout, inicial.somente_leitura, inicial.isolamento, inicial.padrao_somente_leitura], ['0', 'off', 'read committed', 'off']);
        await ocupante.query('BEGIN');
        ocupando = true;
        await ocupante.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaA)]);

        const ocupada = observarServidor(unica);
        const r1 = await executar(ocupada.pool);
        assert.deepEqual(r1.ignorados, [{ empresaId: empresaA, hash: alvo.hash, tipo: 'ORFAO_CONJUNTO', motivo: 'TRAVA_OCUPADA' }]);
        assert.deepEqual(r1.removidos, []);
        assert.deepEqual(ocupada.erros, ['55P03'], 'o prazo esgotado é o lock_timeout do servidor, e é a única falha');
        assert.deepEqual(ocupada.transacoes.at(-1), { amostra: 'indisponível' }, 'a transação do conjunto foi abortada pelo servidor antes do ROLLBACK');
        assert.deepEqual(await estadoDaSessao(unica), inicial, 'depois da espera esgotada a conexão volta ao estado inicial');
        assert.equal(alvo.existe(), true);

        await ocupante.query('ROLLBACK');
        ocupando = false;
        const livre = observarServidor(unica);
        const r2 = await executar(livre.pool);
        assert.deepEqual(r2.removidos.map((x) => x.hash), [alvo.hash]);
        assert.deepEqual(livre.erros, []);
        assert.deepEqual(livre.transacoes, [
          { somente_leitura: 'on', isolamento: 'repeatable read', lock_timeout: '0', travas_advisory: 0 },
          { somente_leitura: 'on', isolamento: 'read committed', lock_timeout: '300ms', travas_advisory: 1 },
        ]);
        assert.deepEqual(await estadoDaSessao(unica), inicial, 'depois do COMMIT a conexão volta ao estado inicial');
        assert.deepEqual([...new Set([...ocupada.pids, ...livre.pids, inicial.pid])], [inicial.pid], 'toda a limpeza usou a mesma conexão física');
        assert.equal(alvo.existe(), false);
      } finally {
        if (ocupando) await ocupante.query('ROLLBACK');
        ocupante.release();
        await unica.end();
      }
    });
  });
});

/** Espera o texto aparecer em stdout ou stderr do comando; falha cedo se o comando terminar antes. */
async function esperarTexto(processo, fluxo, regex, limiteMs = 15000) {
  let terminou = false;
  processo.termino.then(() => { terminou = true; }, () => { terminou = true; });
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (regex.test(processo.saidas()[fluxo])) return;
    if (terminou) throw new Error(`o comando terminou antes de aparecer ${regex} em ${fluxo}`);
    await new Promise((resolver) => { setTimeout(resolver, 10); });
  }
  throw new Error(`prazo esgotado esperando ${regex} em ${fluxo}`);
}

/**
 * Cenário dos sinais: dois órfãos antigos da empresa A e uma trava do banco SEGURADA pelo teste, de modo que o comando fique ESPERANDO a trava do primeiro conjunto (a operação em
 * andamento) enquanto o teste o sinaliza. O corpo recebe `liberar()`, que solta a trava do banco. O comando é um processo descartável deste teste.
 */
async function comEsperaDeTrava(c, prefixo, corpo) {
  const { amb, raiz, janela } = c;
  const agora = Date.now();
  const { empresaA, atorA } = amb.d;
  await registrada(amb, raiz, agora, { empresaId: empresaA, criadoPor: atorA });
  const orfaos = [orfao(raiz, agora, empresaA, `${prefixo}a`), orfao(raiz, agora, empresaA, `${prefixo}b`)];
  const banco = await verificador.identificarBanco(amb.pool);
  const bancoAntes = await retratoDoBanco(amb);
  const env = ambienteDoFilho(amb, { raiz, janela });
  const ocupante = await amb.pool.connect();
  let ocupando = false;
  let proc = null;
  try {
    const { rows: [{ pid: pidDoOcupante }] } = await ocupante.query('SELECT pg_backend_pid() AS pid');
    await ocupante.query('BEGIN');
    ocupando = true;
    await ocupante.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaA)]);
    proc = comando(argumentosDeExecucao(banco), env);
    await Promise.race([
      esperarSessaoBloqueadaPor(amb, pidDoOcupante),
      proc.termino.then((r) => { throw new Error(`o comando terminou antes de esperar a trava (código ${r.codigo}, sinal ${r.sinal})`); }),
    ]);
    const liberar = async () => { await ocupante.query('ROLLBACK'); ocupando = false; };
    await corpo({ proc, orfaos, banco, bancoAntes, env, pidDoOcupante, liberar });
  } finally {
    if (ocupando) await ocupante.query('ROLLBACK');
    ocupante.release();
    if (proc !== null) await proc.termino.catch(() => {});
  }
}

/** Sinaliza o comando que espera a trava, confere que o conjunto em andamento NÃO foi abandonado, libera o banco e confere o desfecho (parada limpa) e a execução seguinte. */
async function verificarParada(c, prefixo, { sinal, codigo, segundo = null }) {
  await comEsperaDeTrava(c, prefixo, async ({ proc, orfaos, banco, bancoAntes, env, pidDoOcupante, liberar }) => {
    const travaAntes = fs.readFileSync(c.janela, 'utf8');
    assert.equal(JSON.parse(travaAntes).pid, proc.filho.pid, 'a trava de janela é deste comando');
    proc.filho.kill(sinal);
    await esperarTexto(proc, 'stderr', new RegExp(`^Sinal ${sinal} recebido: `, 'm'));
    if (segundo !== null) {
      proc.filho.kill(segundo);
      await esperarTexto(proc, 'stderr', new RegExp(`^Novo sinal \\(${segundo}\\) ignorado: `, 'm'));
    }
    await esperarSessaoBloqueadaPor(c.amb, pidDoOcupante);
    assert.deepEqual([proc.filho.exitCode, proc.filho.signalCode], [null, null], 'o comando continua vivo: o conjunto em andamento não foi abandonado');
    assert.equal(fs.readFileSync(c.janela, 'utf8'), travaAntes, 'a trava de janela fica a mesma até o conjunto terminar');
    assert.deepEqual(orfaos.map((o) => o.existe()), [true, true]);

    await liberar();
    const r = await proc.termino;
    assert.deepEqual([r.codigo, r.sinal], [codigo, null], `o comando termina sozinho com ${codigo}, não morto pelo sinal`);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout leva só o documento JSON');
    const { relatorio, ...documento } = JSON.parse(r.stdout);
    assert.equal(documento.sinal, sinal);
    assert.equal(relatorio.paradaSolicitada, true);
    assert.deepEqual([relatorio.removidos.length, relatorio.restantes], [1, 1]);
    assert.deepEqual([relatorio.falhas, relatorio.ignorados], [[], []]);
    assert.equal(relatorio.janela.estado, 'LIBERADA');
    const feito = orfaos.find((o) => o.hash === relatorio.removidos[0].hash);
    const intacto = orfaos.find((o) => o !== feito);
    assert.deepEqual([feito.existe(), intacto.existe()], [false, true], 'o conjunto em andamento saiu por inteiro e o seguinte não começou');
    assert.equal(fs.existsSync(c.janela), false, 'quem tomou a trava de janela foi quem a soltou');
    const avisos = r.stderr.trim().split('\n').map((linha) => linha.split(':')[0]);
    assert.deepEqual(avisos, segundo === null ? [`Sinal ${sinal} recebido`] : [`Sinal ${sinal} recebido`, `Novo sinal (${segundo}) ignorado`]);
    saidaSegura(`${r.stdout}${r.stderr}`, c);
    assert.deepEqual(await retratoDoBanco(c.amb), bancoAntes, 'a parada nunca escreve no banco');

    const seguinte = await rodar(argumentosDeExecucao(banco), env);
    assert.equal(seguinte.codigo, 0, seguinte.stderr);
    const proximo = JSON.parse(seguinte.stdout);
    assert.deepEqual(proximo.relatorio.removidos.map((x) => x.hash), [intacto.hash], 'a execução seguinte termina o trabalho');
    assert.equal('sinal' in proximo, false);
    assert.equal(intacto.existe(), false);
    assert.equal(fs.existsSync(c.janela), false);
  });
}

describe('[INT-SIG] SIGINT e SIGTERM contra o comando real (só no processo descartável que o teste iniciou)', () => {
  teste('INT-SIG-01 — SIGTERM com o primeiro conjunto em andamento (esperando a trava do banco): ele termina, o segundo não começa, a trava de janela é solta pelo dono, a saída é 143 e um SEGUNDO sinal não interrompe nada; a execução seguinte termina o trabalho', async () => {
    await comAmbiente((c) => verificarParada(c, 'sg1', { sinal: 'SIGTERM', codigo: 143, segundo: 'SIGINT' }));
  });

  teste('INT-SIG-02 — SIGINT: o mesmo, com saída 130', async () => {
    await comAmbiente((c) => verificarParada(c, 'sg2', { sinal: 'SIGINT', codigo: 130 }));
  });

  teste('INT-SIG-03 — a trava de janela é TROCADA por outra de outro dono enquanto o comando espera e então chega SIGTERM: o comando NUNCA a apaga nem a altera, nada é removido e ele sai com 1 (janela perdida)', async () => {
    await comAmbiente(async (c) => {
      await comEsperaDeTrava(c, 'sg3', async ({ proc, orfaos, bancoAntes, liberar }) => {
        const alheia = a.documentoDaTrava({ tipo: 'BACKUP', pid: process.pid, iniciadoEm: new Date().toISOString() });
        fs.writeFileSync(c.janela, `${JSON.stringify(alheia)}\n`);
        const conteudoAlheio = fs.readFileSync(c.janela, 'utf8');
        proc.filho.kill('SIGTERM');
        await esperarTexto(proc, 'stderr', /^Sinal SIGTERM recebido: /m);
        await liberar();
        const r = await proc.termino;
        assert.deepEqual([r.codigo, r.sinal], [1, null]);
        assert.match(r.stderr, /Falha: JANELA_PERDIDA/);
        assert.equal(fs.readFileSync(c.janela, 'utf8'), conteudoAlheio, 'a trava do outro dono fica intacta');
        assert.deepEqual(orfaos.map((o) => o.existe()), [true, true], 'sem a posse da trava nada é removido');
        assert.equal(`${r.stdout}${r.stderr}`.includes(alheia.token), false, 'o token da trava alheia nunca sai');
        const documento = JSON.parse(r.stdout);
        assert.deepEqual([documento.interrompido, documento.erro, documento.relatorio.janela.estado], [true, 'JANELA_PERDIDA', 'PERDIDA']);
        assert.deepEqual(documento.relatorio.removidos, []);
        assert.deepEqual(await retratoDoBanco(c.amb), bancoAntes);
      });
    });
  });
});
