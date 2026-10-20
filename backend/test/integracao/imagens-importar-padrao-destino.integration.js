'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { lockDaImportacaoPadrao } = require('../../src/utils/lock-importacao-padrao');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const h = require('../helpers/pacote-padrao-ficticio');
const { instantaneoDoArmazenamento, instantaneoDoBanco } = require('../helpers/instrumentacao-importacao');
const { linhaDoTempo } = require('../helpers/linha-do-tempo-importacao');
const { pacote, ZIP_INTEGRO } = require('../helpers/cenarios-importacao-padrao');

/**
 * Importação da biblioteca padrão (Biblioteca de Imagens, Unidade 5A-2): GUARDA OBRIGATÓRIA DO DESTINO com PostgreSQL REAL (schema temporário exclusivo de
 * gestao_epi_teste_local, com todas as migrations) e ARMAZENAMENTO REAL (diretório temporário exclusivo por caso). Nenhuma das 30 imagens reais: o pacote é o fictício.
 * O contrato está descrito em test/scripts/imagens-importar-padrao-destino.test.js; aqui se prova com banco de verdade que
 *   - a conferência de nome e OID usa a conexão que grava e vem ANTES de qualquer efeito (trava, estado, arquivo, escrita);
 *   - uma tentativa recusada não deixa nada: nem linha, nem sequência consumida, nem arquivo, nem diretório, nem transação aberta, nem espera pela trava consultiva;
 *   - a tentativa autorizada, com a mesma instrumentação, ENXERGA os efeitos que a recusada não tem (controle positivo).
 */

const NOME_ZIP = 'Pacote_Ficticio_30_EPIs.zip';
const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');
const RESUMO_PRIMEIRO = { total: 30, novas: 30, existentes: 0, arquivosNovos: 60, arquivosPresentes: 0, sugestoes: 0 };
const IDENTIDADE_SQL = 'SELECT current_database() AS banco, d.oid::text AS oid FROM pg_database d WHERE d.datname = current_database()';

describe('[DST-DB] destino da importação com PostgreSQL e armazenamento reais', () => {
  let amb = null;
  let identidade = null;
  let raizes = [];
  const limparRaizes = () => { for (const raiz of raizes) removerTemporarioSeguro(raiz); raizes = []; };
  before(async () => {
    amb = await abrirAmbienteImagens();
    identidade = (await amb.q(IDENTIDADE_SQL)).rows[0];
    assert.equal(identidade.banco, 'gestao_epi_teste_local', 'o ambiente é o banco de teste');
    assert.match(identidade.oid, /^[1-9][0-9]{0,9}$/);
  });
  after(async () => { limparRaizes(); if (amb) await amb.encerrar(); });

  // ------------------------------------------------------------------------------------------------------------------------------ apoio
  async function cenario() {
    limparRaizes();
    await amb.q('DELETE FROM imagens_padrao');
    const base = criarRaizTemporaria();
    raizes.push(base);
    const dirZip = path.join(base, 'pacote');
    fs.mkdirSync(dirZip);
    const dirArm = path.join(base, 'armazenamento');
    const armazenamento = criarArmazenamentoImagens({ diretorio: dirArm });
    return { base, dirArm, zip: h.gravarArquivo(dirZip, NOME_ZIP, ZIP_INTEGRO), sha: h.sha256(ZIP_INTEGRO), armazenamento };
  }
  const importar = (c, { pool = amb.pool, armazenamento = c.armazenamento, ...extra } = {}) => SERVICO().importarPacotePadrao(pool, {
    pacote: c.zip, pacoteSha256Esperado: c.sha, armazenamento, mapeamento: null, executar: true, ...extra,
  });
  const estado = async (c) => ({ banco: await instantaneoDoBanco(amb.q), disco: instantaneoDoArmazenamento(c.dirArm) });
  const sessoesAbertas = async () => (await amb.q(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
  )).rows[0].n;
  const forma = (tempo) => tempo.eventos.map((e) => (tempo.ehIdentidade(e) ? `${e.conexao}:IDENTIDADE` : (e.tipo === 'SQL' ? `${e.conexao}:${e.texto}` : `${e.tipo}${e.conexao ? `:${e.conexao}` : ''}`)));
  const COM_OID_ERRADO = () => ({ banco: identidade.banco, oid: String(Number(identidade.oid) + 1) });

  async function recusa(promessa, codigo) {
    let erro = null;
    try { await promessa; } catch (e) { erro = e; }
    assert.notEqual(erro, null, 'a operação deveria ser recusada');
    assert.equal(erro.codigo, codigo, `${erro.codigo ?? erro.code}: ${erro.message}`);
    return erro;
  }

  /** Recusa SEM nenhum efeito: só abrir a transação, conferir a identidade e desfazer; o estado do banco e do disco fica idêntico e nenhuma transação sobra aberta. */
  async function recusadaSemEfeito(c, destinoAutorizado, { executar = true } = {}) {
    const antes = await estado(c);
    const sessoes = await sessoesAbertas();
    const tempo = linhaDoTempo();
    const erro = await recusa(importar(c, { pool: tempo.pool(amb.pool), armazenamento: tempo.armazenamento(c.armazenamento), executar, destinoAutorizado }), 'DESTINO_NAO_AUTORIZADO');
    assert.deepEqual(forma(tempo), ['CONNECT:1', `1:${executar ? 'BEGIN' : 'BEGIN READ ONLY'}`, '1:IDENTIDADE', '1:ROLLBACK', 'LIBERA:1']);
    assert.equal(tempo.eventos.some((e) => e.tipo === 'ARM'), false, 'o armazenamento não foi tocado');
    assert.deepEqual(await estado(c), antes, 'banco (linhas, xmin, ctid, sequências) e disco (inode, mtime, ctime, bytes) idênticos');
    assert.equal(await sessoesAbertas(), sessoes, 'nenhuma transação ficou aberta');
    return erro;
  }

  const comPrazo = (promessa, ms) => new Promise((resolver, rejeitar) => {
    const relogio = setTimeout(() => resolver('PRAZO'), ms);
    promessa.then((v) => { clearTimeout(relogio); resolver(v); }, (e) => { clearTimeout(relogio); rejeitar(e); });
  });

  // --------------------------------------------------------------------------------------------------------------------------- autorizada
  describe('[DST-DB] destino autorizado (controle positivo da instrumentação)', () => {
    test('DST-DB-01 — destino igual ao da conexão: a identidade é a primeira instrução depois do BEGIN, na conexão que faz TODA a transação; só depois vêm ajuste de espera, trava, leitura do estado, gravação de arquivos e escrita; o relatório devolve o destino lido', async () => {
      const c = await cenario();
      const tempo = linhaDoTempo();
      const relatorio = await importar(c, { pool: tempo.pool(amb.pool), armazenamento: tempo.armazenamento(c.armazenamento), destinoAutorizado: identidade });
      assert.equal(relatorio.modo, 'EXECUCAO');
      assert.deepEqual(relatorio.destino, identidade);
      assert.deepEqual(relatorio.resumo, RESUMO_PRIMEIRO);

      const e = tempo.eventos;
      assert.deepEqual([e[0].tipo, e[1].texto], ['CONNECT', 'BEGIN']);
      assert.equal(tempo.ehIdentidade(e[2]), true);
      assert.equal(e.filter(tempo.ehIdentidade).length, 1);
      for (const [rotulo, teste] of [
        ['ajuste de espera', (x) => /lock_timeout/i.test(x.texto)], ['trava consultiva', (x) => /pg_advisory_xact_lock/i.test(x.texto)], ['leitura do estado', (x) => /FROM imagens_padrao\b/i.test(x.texto)],
        ['armazenamento', (x) => x.tipo === 'ARM'], ['escrita', (x) => /^INSERT\b/i.test(x.texto)],
      ]) assert.ok(e.findIndex(teste) > 2, `${rotulo} vem depois da identidade`);
      assert.deepEqual([...new Set(e.filter((x) => x.tipo === 'SQL').map((x) => x.conexao))], [1], 'identidade, trava, escrita e COMMIT na mesma conexão');
      assert.equal(e.filter((x) => x.tipo === 'ARM' && x.texto === 'gravar').length, 60);
      assert.equal(e.filter((x) => /^INSERT\b/i.test(x.texto)).length, 30);
      assert.equal(e[e.length - 2].texto, 'COMMIT');
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 30);
      assert.equal(arquivosSob(c.dirArm).length, 60);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------- recusadas
  describe('[DST-DB] destino recusado: nada acontece', () => {
    test('DST-DB-02 — nome do banco divergente (e também o mesmo nome em maiúsculas): DESTINO_NAO_AUTORIZADO com campo, esperado e calculado; nenhuma linha, sequência, arquivo ou transação', async () => {
      const c = await cenario();
      const erro = await recusadaSemEfeito(c, { banco: 'outro_banco_que_nao_e_este', oid: identidade.oid });
      assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.motivo, d.esperado, d.calculado]), [['banco', 'DIFERENTE_DO_AUTORIZADO', 'outro_banco_que_nao_e_este', identidade.banco]]);
      await recusadaSemEfeito(c, { banco: identidade.banco.toUpperCase(), oid: identidade.oid });
      assert.equal(erro.message.includes(identidade.banco), false, 'a mensagem fixa não leva o nome');
    });

    test('DST-DB-03 — OID divergente (o do banco +1, "1", o de outro banco real do cluster e um com dígito a menos): DESTINO_NAO_AUTORIZADO, nada escrito; o OID certo com o nome certo é o único que passa', async () => {
      const c = await cenario();
      const outro = (await amb.q("SELECT oid::text AS oid FROM pg_database WHERE datname = 'template1'")).rows[0].oid;
      assert.notEqual(outro, identidade.oid, 'controle: template1 é outro banco');
      for (const oid of [String(Number(identidade.oid) + 1), '1', outro, identidade.oid.slice(0, -1)]) {
        const erro = await recusadaSemEfeito(c, { banco: identidade.banco, oid });
        assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.motivo, d.esperado, d.calculado]), [['oid', 'DIFERENTE_DO_AUTORIZADO', oid, identidade.oid]]);
      }
      const ambos = await recusadaSemEfeito(c, { banco: 'outro_banco_que_nao_e_este', oid: '1' });
      assert.deepEqual(ambos.detalhes.map((d) => d.campo), ['banco', 'oid']);
      const ok = await importar(c, { destinoAutorizado: identidade });
      assert.equal(ok.modo, 'EXECUCAO', 'controle: nome e OID certos passam');
    });

    test('DST-DB-04 — sem autorização (ausente ou null): DESTINO_NAO_AUTORIZADO antes de QUALQUER conexão ao banco e de qualquer chamada ao armazenamento; nada muda', async () => {
      const c = await cenario();
      const antes = await estado(c);
      for (const extra of [{}, { destinoAutorizado: null }, { destinoAutorizado: { banco: identidade.banco } }, { destinoAutorizado: { oid: identidade.oid } }]) {
        const tempo = linhaDoTempo();
        await recusa(importar(c, { pool: tempo.pool(amb.pool), armazenamento: tempo.armazenamento(c.armazenamento), ...extra }), 'DESTINO_NAO_AUTORIZADO');
        assert.deepEqual(tempo.eventos, [], `${JSON.stringify(extra)}: nem conexão, nem SQL, nem armazenamento`);
      }
      assert.deepEqual(await estado(c), antes);
    });

    test('DST-DB-05 — a recusada nunca toma nem espera a trava consultiva da importação (volta mesmo com outra sessão segurando a trava), e a autorizada, sim, fica esperando (visível no banco) e termina quando a trava é solta', async () => {
      const c = await cenario();
      const chave = lockDaImportacaoPadrao();
      const segurador = await amb.pool.connect();
      try {
        const pidDoSegurador = (await segurador.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await segurador.query('SELECT pg_advisory_lock($1::bigint)', [chave]);

        const recusada = importar(c, { destinoAutorizado: COM_OID_ERRADO() });
        const desfecho = await comPrazo(recusada.then(() => 'VOLTOU', (erro) => erro.codigo), 5000);
        assert.equal(desfecho, 'DESTINO_NAO_AUTORIZADO', 'a recusada não esperou os 120 s da trava');

        const autorizada = importar(c, { destinoAutorizado: identidade });
        const bloqueada = await amb.esperarBloqueio(pidDoSegurador);
        assert.ok(Number.isInteger(bloqueada), 'controle: a autorizada ficou esperando a trava');
        await segurador.query('SELECT pg_advisory_unlock($1::bigint)', [chave]);
        const relatorio = await autorizada;
        assert.equal(relatorio.modo, 'EXECUCAO');
      } finally {
        await segurador.query('SELECT pg_advisory_unlock_all()');
        segurador.release();
      }
    });
  });

  // ----------------------------------------------------------------------------------------------------------------------------- simulação
  describe('[DST-DB] simulação (--dry-run) segue sem escrever, com ou sem destino', () => {
    test('DST-DB-06 — sem destino: como antes (relatório sem destino, nenhuma consulta de identidade); com destino válido: identidade lida dentro de BEGIN READ ONLY, relatório com destino; divergente: recusada sem efeito', async () => {
      const c = await cenario();
      const antes = await estado(c);

      const semDestino = linhaDoTempo();
      const a = await importar(c, { pool: semDestino.pool(amb.pool), armazenamento: semDestino.armazenamento(c.armazenamento), executar: false });
      assert.equal(a.modo, 'SIMULACAO');
      assert.equal(Object.hasOwn(a, 'destino'), false);
      assert.equal(semDestino.eventos.filter(semDestino.ehIdentidade).length, 0);

      const comDestino = linhaDoTempo();
      const b = await importar(c, { pool: comDestino.pool(amb.pool), armazenamento: comDestino.armazenamento(c.armazenamento), executar: false, destinoAutorizado: identidade });
      assert.equal(b.modo, 'SIMULACAO');
      assert.deepEqual(b.destino, identidade);
      assert.deepEqual(b.resumo, RESUMO_PRIMEIRO);
      assert.equal(comDestino.eventos[1].texto, 'BEGIN READ ONLY');
      assert.equal(comDestino.ehIdentidade(comDestino.eventos[2]), true);
      for (const tempo of [semDestino, comDestino]) {
        assert.deepEqual(tempo.sql().map((x) => x.texto).filter((t) => /^(INSERT|UPDATE|DELETE|SET LOCAL)|advisory/i.test(t)), []);
        assert.equal(tempo.eventos.filter((x) => x.tipo === 'ARM' && x.texto === 'gravar').length, 0);
      }
      assert.deepEqual(await estado(c), antes, 'a simulação não escreveu nada');

      await recusadaSemEfeito(c, COM_OID_ERRADO(), { executar: false });
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------- CLI
  describe('[DST-DB] executarComando e criação do diretório de imagens', () => {
    const SEM_CONTROLE = /(?!\n)\p{Cc}/u;
    async function comando(c, modo, extra = {}, armazenamento = c.armazenamento) {
      const linhas = [];
      const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
      const r = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo, ...extra }, { pool: amb.pool, armazenamento, saida: { log: guardar, error: guardar } });
      const texto = linhas.join('\n');
      assert.equal(texto.includes(c.base), false, 'a saída vaza caminho');
      assert.doesNotMatch(texto, SEM_CONTROLE);
      return { saida: r.saida, texto };
    }

    test('DST-DB-07 — pela CLI: destino certo grava (saída 0, com a linha "Destino conferido pela conexão"); OID errado, destino ausente e simulação com OID errado saem com 2, dizem o motivo e não mudam nada', async () => {
      const recusados = await cenario();
      const antes = await estado(recusados);
      const erradoOid = await comando(recusados, 'EXECUTAR', { destino: COM_OID_ERRADO() });
      assert.equal(erradoOid.saida, 2);
      assert.ok(erradoOid.texto.includes('DESTINO_NAO_AUTORIZADO'), erradoOid.texto);
      assert.match(erradoOid.texto, new RegExp(`campo=oid motivo=DIFERENTE_DO_AUTORIZADO esperado=${Number(identidade.oid) + 1} calculado=${identidade.oid}`));
      const ausente = await comando(recusados, 'EXECUTAR');
      assert.equal(ausente.saida, 2);
      assert.ok(ausente.texto.includes('--banco-autorizado') && ausente.texto.includes('--banco-oid'), ausente.texto);
      const simulada = await comando(recusados, 'SIMULAR', { destino: COM_OID_ERRADO() });
      assert.equal(simulada.saida, 2);
      assert.deepEqual(await estado(recusados), antes);

      const c = await cenario();
      const ok = await comando(c, 'EXECUTAR', { destino: identidade });
      assert.equal(ok.saida, 0, ok.texto);
      assert.ok(ok.texto.includes(`Destino conferido pela conexão: banco ${identidade.banco} (oid ${identidade.oid})`), ok.texto);
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 30);
      assert.equal(arquivosSob(c.dirArm).length, 60);
    });

    test('DST-DB-08 — o diretório de imagens só é criado depois da conferência: destino recusado deixa o caminho inexistente; destino certo cria (0700) e grava os 60 arquivos', async () => {
      const c = await cenario();
      const raiz = criarRaizTemporaria();
      raizes.push(raiz);
      const diretorio = path.join(raiz, 'imagens-ainda-nao-criadas');
      const armazenamento = CLI().criarArmazenamento('EXECUTAR', { IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio });
      assert.equal(fs.existsSync(diretorio), false);

      const recusada = await comando(c, 'EXECUTAR', { destino: COM_OID_ERRADO() }, armazenamento);
      assert.equal(recusada.saida, 2);
      assert.equal(fs.existsSync(diretorio), false, 'o destino recusado não criou nem o diretório');
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 0);

      const aceita = await comando(c, 'EXECUTAR', { destino: identidade }, armazenamento);
      assert.equal(aceita.saida, 0, aceita.texto);
      assert.equal(fs.statSync(diretorio).mode & 0o777, 0o700);
      assert.equal(arquivosSob(diretorio).length, 60);
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 30);
      assert.equal(pacote.itens.length, 30);
    });
  });
});
