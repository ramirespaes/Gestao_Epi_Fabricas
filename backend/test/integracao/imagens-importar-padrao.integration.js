'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { CATALOGO_BASE } = require('../../src/utils/classificacao-material');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const h = require('../helpers/pacote-padrao-ficticio');
const {
  espiarPool, espiarObjeto, falharNoPool, armazenamentoQueFalha, instantaneoDoArmazenamento, instantaneoDoBanco,
} = require('../helpers/instrumentacao-importacao');
const {
  pacote, ZIP_INTEGRO, ADULTERACOES, outroPng, DECISAO, APROVADAS, MAPEAMENTOS_INVALIDOS, DIVERGENCIAS_DE_REGISTRO, ALTERACOES_ADMINISTRATIVAS,
} = require('../helpers/cenarios-importacao-padrao');

/**
 * Importação da biblioteca padrão (Biblioteca de Imagens, Unidade 5A-2, RED): PostgreSQL REAL (schema temporário exclusivo de gestao_epi_teste_local, com todas
 * as migrations) e ARMAZENAMENTO REAL (diretório temporário exclusivo por teste). Nenhuma das 30 imagens reais: o pacote é o fictício de test/helpers.
 * Contratos PAD-01 a PAD-06 dos documentos 12 e 14, mais os dois requisitos obrigatórios desta unidade: INTEGRIDADE FÍSICA dos arquivos e IDEMPOTÊNCIA COMPLETA.
 * Os contratos sem banco (hashes, ZIP hostil, formato das imagens, PAD-06) estão em test/scripts/imagens-importar-padrao.test.js; a CLI, em
 * imagens-importar-padrao-cli.test.js.
 *
 * Módulo previsto: src/services/imagem-padrao-importacao.service.js (além do que o arquivo sem banco já descreve)
 *   importarPacotePadrao(pool, { pacote, pacoteSha256Esperado, armazenamento, mapeamento = null, executar, destinoAutorizado?, limites? }) -> Promise<relatório>
 *     (com `executar: true` o destinoAutorizado { banco, oid } é obrigatório e conferido na conexão que grava; o contrato está em imagens-importar-padrao-destino.*)
 *     relatório = { modo: 'EXECUCAO'|'SIMULACAO', pacote: { nome, bytes, sha256 }, verificados: 90,
 *                   resumo: { total, novas, existentes, arquivosNovos, arquivosPresentes, sugestoes },
 *                   itens: [{ nome, situacao: 'NOVA'|'EXISTENTE', imagemId: string|null }] }    (itens na ordem do manifesto)
 *       `resumo` diz o que foi feito (EXECUCAO) ou o que SERIA feito (SIMULACAO, onde NOVA vem com imagemId null); `sugestoes` = linhas NOVAS de imagens_padrao_tipos.
 *   Fases, nesta ordem: (1) verificação pura em memória do pacote inteiro (hashes, tamanhos, estrutura, formato das imagens) e do mapeamento; (2) leitura do estado
 *   (banco e armazenamento) e comparação com o pacote; (3) escrita, só se `executar` e só se nada divergiu: primeiro os arquivos, depois as linhas (imagens e sugestões)
 *   numa ÚNICA transação, tudo ou nada. Uma recusa em (1) ou (2) acontece antes de qualquer escrita.
 *   Armazenamento: padrao/<SHA-256 do PNG>/mestre.png e padrao/<SHA-256 do PNG>/miniatura.webp, byte a byte como no pacote (sem recodificar). Nunca o original, nunca a derivada de 640.
 *   Linha de imagens_padrao: nome = nome-base NFC; arquivo_origem = "<nome>.png"; sha256 = do PNG; sha256_miniatura; sha256_exibicao NULL; sha256_original_ref = hash do original
 *   (só referência); pacote_origem = nome do ZIP; pacote_sha256; formato PNG; 1024x1024; bytes_mestre; bytes_miniatura; bytes_exibicao NULL; versao 1; ativo; ilustrativa.
 *   A chave de idempotência é o SHA-256 do PNG padronizado. "Existente" = linha com esse hash; os campos que DEFINEM o conteúdo (sha256_miniatura, formato, largura, altura,
 *   bytes_mestre, bytes_miniatura) têm de conferir com o pacote, e os arquivos guardados têm de ter os bytes do pacote; qualquer diferença é ESTADO_DIVERGENTE e NADA é
 *   alterado. Os campos administrativos (nome, ativo, ilustrativa, versao, proveniência, derivada de exibição) NUNCA são reescritos nem acusados. Nome já usado por OUTRA
 *   imagem também é ESTADO_DIVERGENTE. Segunda execução: zero instruções de escrita, zero gravações, nenhuma sequência consumida, nenhum inode, mtime ou ctime alterado.
 *   Mapeamento (CSV da proposta): só linhas com decisão APROVAR, aprovado_por e data (YYYY-MM-DD) válidos viram sugestão; nivel = PRINCIPAL para confiança ALTA e ALTERNATIVA
 *   para MÉDIA; o tipo tem de ser do catálogo BASE; a linha SEM correspondência nunca vira sugestão e aprová-la é MAPEAMENTO_INVALIDO. Nunca há vínculo com material.
 *   Erros novos: ESTADO_DIVERGENTE (detalhes [{ nome, alvo: 'REGISTRO'|'ARQUIVO', campo? }]), MAPEAMENTO_INVALIDO, MAPEAMENTO_INDISPONIVEL; nenhum leva caminho, hash nem
 *   valor recebido na mensagem.
 */

const NOME_ZIP = 'Pacote_Ficticio_30_EPIs.zip';
const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');
const num = (k) => String(k + 1).padStart(2, '0');
const RESUMO_PRIMEIRO = { total: 30, novas: 30, existentes: 0, arquivosNovos: 60, arquivosPresentes: 0, sugestoes: 0 };
const RESUMO_NADA_A_FAZER = { total: 30, novas: 0, existentes: 30, arquivosNovos: 0, arquivosPresentes: 60, sugestoes: 0 };

describe('[PADRAO-DB] importação da biblioteca padrão com PostgreSQL e armazenamento reais', () => {
  let amb = null;
  let identidade = null;
  let raizes = [];
  const limparRaizes = () => { for (const raiz of raizes) removerTemporarioSeguro(raiz); raizes = []; };
  before(async () => {
    amb = await abrirAmbienteImagens();
    identidade = (await amb.q('SELECT current_database() AS banco, d.oid::text AS oid FROM pg_database d WHERE d.datname = current_database()')).rows[0];
  });
  after(async () => { limparRaizes(); if (amb) await amb.encerrar(); });

  // ------------------------------------------------------------------------------------------------------------------------------ apoio
  /** Um caso: ZIP numa pasta própria, armazenamento real numa pasta própria e imagens_padrao VAZIA. */
  async function cenario(zip = ZIP_INTEGRO, { nomeZip = NOME_ZIP } = {}) {
    limparRaizes();
    await amb.q('DELETE FROM imagens_padrao');
    const base = criarRaizTemporaria();
    raizes.push(base);
    const dirZip = path.join(base, 'pacote');
    fs.mkdirSync(dirZip);
    const dirArm = path.join(base, 'armazenamento');
    const armazenamento = criarArmazenamentoImagens({ diretorio: dirArm });
    assert.deepEqual(arquivosSob(dirArm), [], 'o armazenamento do caso começa vazio');
    return { base, dirZip, dirArm, nomeZip, zip: h.gravarArquivo(dirZip, nomeZip, zip), sha: h.sha256(zip), armazenamento };
  }

  const importar = (c, { pool = amb.pool, armazenamento = c.armazenamento, ...opcoes } = {}) => SERVICO().importarPacotePadrao(pool, {
    pacote: c.zip, pacoteSha256Esperado: c.sha, armazenamento, mapeamento: null, executar: true, ...(opcoes.executar === false ? {} : { destinoAutorizado: identidade }), ...opcoes,
  });
  const espioes = (c) => ({ banco: espiarPool(amb.pool), disco: espiarObjeto(c.armazenamento) });
  const importarCom = (c, e, opcoes = {}) => importar(c, { pool: e.banco.espiao, armazenamento: e.disco.espiao, ...opcoes });
  async function importarEspiado(c, opcoes = {}) {
    const e = espioes(c);
    const relatorio = await importarCom(c, e, opcoes);
    return { relatorio, escritasSql: e.banco.escritas(), armazenamento: e.disco.registros };
  }
  const chamadas = (registros, metodo) => registros.filter((r) => r.metodo === metodo);
  const semEscrever = (e) => {
    assert.deepEqual(e.banco.escritas(), [], 'nenhuma instrução de escrita');
    for (const metodo of ['gravar', 'remover', 'removerVariantes']) assert.deepEqual(chamadas(e.disco.registros, metodo), [], `armazenamento.${metodo}`);
  };

  async function recusa(promessa, codigo) {
    let erro = null;
    try { await promessa; } catch (e) { erro = e; }
    assert.notEqual(erro, null, 'a operação deveria ser recusada');
    assert.equal(erro.codigo, codigo, `${erro.codigo ?? erro.code}: ${erro.message}`);
    assert.equal(/[0-9a-f]{64}/.test(erro.message), false, 'a mensagem vaza um hash');
    return erro;
  }
  async function rejeitada(promessa) {
    let erro = null;
    try { await promessa; } catch (e) { erro = e; }
    assert.notEqual(erro, null, 'a operação deveria falhar');
    assert.equal(/[0-9a-f]{64}/.test(erro.message), false, 'a mensagem vaza um hash');
    return erro;
  }

  const estado = async (c) => ({ banco: await instantaneoDoBanco(amb.q), disco: instantaneoDoArmazenamento(c.dirArm) });
  const contar = async (tabela) => (await amb.q(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n;
  const sessoesAbertas = async () => (await amb.q(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
  )).rows[0].n;

  const caminhoPng = (i) => `padrao/${i.sha256Padronizado}/mestre.png`;
  const caminhoWebp = (i) => `padrao/${i.sha256Padronizado}/miniatura.webp`;
  const arquivosEsperados = (itens = pacote.itens) => itens.flatMap((i) => [[caminhoPng(i), i.padronizado], [caminhoWebp(i), i.miniatura]]);
  const COLUNAS = 'nome, arquivo_origem, sha256, sha256_miniatura, sha256_exibicao, sha256_original_ref, pacote_origem, pacote_sha256, formato, largura, altura, bytes_mestre, bytes_miniatura, bytes_exibicao, versao, ativo, ilustrativa';
  const linhasDoBanco = async () => (await amb.q(`SELECT ${COLUNAS} FROM imagens_padrao ORDER BY nome`)).rows;
  const linhaEsperada = (i, c) => ({
    nome: i.nome, arquivo_origem: i.arquivoOrigem, sha256: i.sha256Padronizado, sha256_miniatura: i.sha256Miniatura, sha256_exibicao: null, sha256_original_ref: i.sha256Original,
    pacote_origem: c.nomeZip, pacote_sha256: c.sha, formato: 'PNG', largura: 1024, altura: 1024, bytes_mestre: i.bytesPadronizado, bytes_miniatura: i.bytesMiniatura,
    bytes_exibicao: null, versao: 1, ativo: true, ilustrativa: true,
  });
  async function conferirLinhas(c, itens = pacote.itens) {
    const lidas = new Map((await linhasDoBanco()).map((l) => [l.nome, l]));
    assert.equal(lidas.size, itens.length, 'quantidade de linhas');
    for (const i of itens) assert.deepEqual(lidas.get(i.nome), linhaEsperada(i, c), i.nome);
  }
  function conferirArquivos(c, itens = pacote.itens) {
    const esperados = arquivosEsperados(itens);
    assert.deepEqual(arquivosSob(c.dirArm), esperados.map(([rel]) => rel).sort(), 'exatamente os arquivos esperados, sem sobra nem temporário');
    for (const [rel, bytes] of esperados) assert.ok(fs.readFileSync(path.join(c.dirArm, rel)).equals(bytes), `bytes de ${rel}`);
  }
  const naoReescritos = (antes, depois, escolhidos = null) => {
    for (const x of antes.filter((e) => e.tipo === 'arq' && (escolhidos === null || escolhidos(e)))) {
      assert.deepEqual(depois.find((e) => e.caminho === x.caminho), x, `arquivo reescrito ou recriado: ${x.caminho}`);
    }
  };

  // mapeamento
  const escreverMapa = (c, decisoes = {}, nome = 'mapeamento.csv') => h.gravarArquivo(c.dirZip, nome, Buffer.from(h.mapeamentoCsv(h.linhasDeMapeamento(pacote, decisoes)), 'utf8'));
  const escreverMapaDeLinhas = (c, linhas, nome = 'mapeamento.csv') => h.gravarArquivo(c.dirZip, nome, Buffer.from(h.mapeamentoCsv(linhas), 'utf8'));
  const sugestoesDoBanco = async () => (await amb.q(
    `SELECT i.nome AS imagem, t.tipo_nome, t.nivel, t.aprovado_por, to_char(t.aprovado_em, 'YYYY-MM-DD') AS aprovado_em
       FROM imagens_padrao_tipos t JOIN imagens_padrao i ON i.id = t.imagem_padrao_id ORDER BY i.nome, t.tipo_nome`,
  )).rows;

  const INSERT_LINHA = `INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura)
                        VALUES ($1, $2, $3, $4, 'PNG', 1024, 1024, $5, $6)`;
  const inserirLinhaDoPacote = (i) => amb.q(INSERT_LINHA, [i.nome, i.arquivoOrigem, i.sha256Padronizado, i.sha256Miniatura, i.bytesPadronizado, i.bytesMiniatura]);

  // -------------------------------------------------------------------------------------------------------------------------- controles
  describe('[CTRL-PAD-DB] controles do ambiente real (passam antes de o importador existir)', () => {
    test('CTRL-PAD-DB-01 — o ambiente é o banco de teste, num schema temporário exclusivo com as tabelas da biblioteca padrão vazias, e o armazenamento do caso é novo, vazio e exclusivo', async () => {
      const c = await cenario();
      const { banco, esquema } = (await amb.q('SELECT current_database() AS banco, current_schema() AS esquema')).rows[0];
      assert.equal(banco, 'gestao_epi_teste_local');
      assert.match(esquema, /^test_migration_[0-9a-f]{12}$/);
      assert.equal(esquema, amb.schema);
      assert.equal(await contar('imagens_padrao'), 0);
      assert.equal(await contar('imagens_padrao_tipos'), 0);
      assert.deepEqual(arquivosSob(c.dirArm), []);
      assert.deepEqual(fs.readdirSync(c.dirZip), [NOME_ZIP]);
    });

    test('CTRL-PAD-DB-02 — as 30 linhas e as sugestões esperadas pelos contratos são aceitas pelas restrições da migration 090; o SHA-256 duplicado é recusado', async () => {
      const c = await cenario();
      for (const i of pacote.itens) await inserirLinhaDoPacote(i);
      assert.equal(await contar('imagens_padrao'), 30);
      await assert.rejects(inserirLinhaDoPacote(pacote.itens[0]), (falha) => falha.code === '23505');
      await amb.q(
        "UPDATE imagens_padrao SET sha256_original_ref = $2, pacote_origem = $3, pacote_sha256 = $4 WHERE sha256 = $1",
        [pacote.itens[0].sha256Padronizado, pacote.itens[0].sha256Original, c.nomeZip, c.sha],
      );
      const id = (await amb.q('SELECT id FROM imagens_padrao WHERE sha256 = $1', [pacote.itens[0].sha256Padronizado])).rows[0].id;
      await amb.q("INSERT INTO imagens_padrao_tipos (imagem_padrao_id, tipo_nome, nivel, aprovado_por, aprovado_em) VALUES ($1, 'Avental de Segurança', 'PRINCIPAL', 'Ramires', '2026-10-17')", [id]);
      assert.equal(await contar('imagens_padrao_tipos'), 1);
      assert.deepEqual(await sugestoesDoBanco(), [{ imagem: pacote.itens[0].nome, tipo_nome: 'Avental de Segurança', nivel: 'PRINCIPAL', aprovado_por: 'Ramires', aprovado_em: '2026-10-17' }], 'a leitura das sugestões usada pelos contratos funciona');
    });

    test('CTRL-PAD-DB-03 — o instantâneo do banco enxerga UPDATE sem mudança de valor e identidade consumida por INSERT que não grava, e NÃO acusa leitura', async () => {
      await cenario();
      await inserirLinhaDoPacote(pacote.itens[0]);
      const base = await instantaneoDoBanco(amb.q);
      await amb.q('SELECT * FROM imagens_padrao');
      await amb.q('SELECT * FROM imagens_padrao_tipos');
      assert.deepEqual(await instantaneoDoBanco(amb.q), base, 'leitura não muda o instantâneo');

      await amb.q('UPDATE imagens_padrao SET nome = nome');
      const atualizado = await instantaneoDoBanco(amb.q);
      assert.equal(atualizado.padrao[0].linha.nome, base.padrao[0].linha.nome, 'o valor é o mesmo');
      assert.notEqual(atualizado.padrao[0].xmin, base.padrao[0].xmin);
      assert.notEqual(atualizado.padrao[0].ctid, base.padrao[0].ctid);
      assert.notEqual(atualizado.padrao[0].linha.atualizado_em, base.padrao[0].linha.atualizado_em);

      const i = pacote.itens[0];
      await amb.q(`${INSERT_LINHA} ON CONFLICT (sha256) DO NOTHING`, [i.nome, i.arquivoOrigem, i.sha256Padronizado, i.sha256Miniatura, i.bytesPadronizado, i.bytesMiniatura]);
      const conflito = await instantaneoDoBanco(amb.q);
      assert.deepEqual(conflito.padrao, atualizado.padrao, 'o INSERT que conflita não grava linha');
      assert.notDeepEqual(conflito.sequencias, atualizado.sequencias, 'mas consome a sequência de identidade: o instantâneo também enxerga isso');
    });

    test('CTRL-PAD-DB-04 — o detector de transação aberta enxerga uma conexão em BEGIN e volta a zero ao desfazê-la', async () => {
      const antes = await sessoesAbertas();
      const cliente = await amb.pool.connect();
      try {
        await cliente.query('BEGIN');
        assert.equal(await sessoesAbertas(), antes + 1);
        await cliente.query('ROLLBACK');
      } finally { cliente.release(); }
      assert.equal(await sessoesAbertas(), antes);
    });

    test('CTRL-PAD-DB-05 — o armazenamento real usa o layout previsto e uma gravação de bytes IDÊNTICOS (reaproveitada) já aparece no instantâneo do disco e no espião: é o que a segunda importação não pode fazer', async () => {
      const c = await cenario();
      const i = pacote.itens[0];
      const chave = c.armazenamento.chaveDe({ escopo: 'PADRAO', sha256: i.sha256Padronizado, variante: 'mestre', formato: 'PNG' });
      assert.equal(chave, caminhoPng(i));
      assert.equal(c.armazenamento.chaveDe({ escopo: 'PADRAO', sha256: i.sha256Padronizado, variante: 'miniatura', formato: 'WEBP' }), caminhoWebp(i));
      const limite = { maxBytes: 5 * 1024 * 1024 };
      assert.equal((await c.armazenamento.gravar(chave, i.padronizado, limite)).reaproveitado, false);
      fs.utimesSync(path.join(c.dirArm, 'padrao', i.sha256Padronizado), 1000000, 1000000);
      const antes = instantaneoDoArmazenamento(c.dirArm);
      const espiado = espiarObjeto(c.armazenamento);
      assert.equal((await espiado.espiao.gravar(chave, i.padronizado, limite)).reaproveitado, true);
      assert.equal(chamadas(espiado.registros, 'gravar').length, 1, 'o espião enxerga a chamada');
      const depois = instantaneoDoArmazenamento(c.dirArm);
      assert.notDeepEqual(depois, antes, 'mesmo reaproveitada, a gravação muda a pasta');
      const doArquivo = (instantaneo) => instantaneo.find((x) => x.caminho.endsWith('mestre.png'));
      assert.deepEqual(doArquivo(depois), doArquivo(antes), 'o arquivo em si não foi tocado: é a pasta que denuncia');
    });

    test('CTRL-PAD-DB-06 — o estado final ESPERADO, montado à mão (SQL e armazenamento real, sem importador), é aceito por todas as verificações de estado dos contratos, e o instantâneo dele não muda quando nada é feito', async () => {
      const c = await cenario();
      for (const i of pacote.itens) {
        await inserirLinhaDoPacote(i);
        await amb.q('UPDATE imagens_padrao SET sha256_original_ref = $2, pacote_origem = $3, pacote_sha256 = $4 WHERE sha256 = $1', [i.sha256Padronizado, i.sha256Original, c.nomeZip, c.sha]);
        await c.armazenamento.gravar(caminhoPng(i), i.padronizado, { maxBytes: 5 * 1024 * 1024, sha256Esperado: i.sha256Padronizado });
        await c.armazenamento.gravar(caminhoWebp(i), i.miniatura, { maxBytes: 65536, sha256Esperado: i.sha256Miniatura });
      }
      await conferirLinhas(c);
      conferirArquivos(c);
      assert.equal(arquivosSob(c.dirArm).length, 60);
      const antes = await estado(c);
      await amb.q('SELECT count(*) FROM imagens_padrao');
      assert.deepEqual(await estado(c), antes);
      assert.throws(() => conferirArquivos(c, pacote.itens.slice(0, 12)), 'o verificador de arquivos recusa um conjunto diferente do esperado');
      naoReescritos(antes.disco, instantaneoDoArmazenamento(c.dirArm));
    });

    test('CTRL-PAD-DB-07 — as alterações dos contratos de divergência e de campos administrativos são SQL válido e respeitam as restrições da migration 090 (desfeitas em seguida), e o estado volta a ser o montado', async () => {
      await cenario();
      for (const i of pacote.itens) await inserirLinhaDoPacote(i);
      const antes = await instantaneoDoBanco(amb.q);
      const cliente = await amb.pool.connect();
      try {
        await cliente.query('BEGIN');
        for (const [campo, atribuicao] of DIVERGENCIAS_DE_REGISTRO) {
          const r = await cliente.query(`UPDATE imagens_padrao SET ${atribuicao} WHERE sha256 = $1`, [pacote.itens[11].sha256Padronizado]);
          assert.equal(r.rowCount, 1, campo);
        }
        for (const [descricao, montar] of ALTERACOES_ADMINISTRATIVAS) {
          const [sql, parametros] = montar(pacote.itens);
          assert.equal((await cliente.query(sql, parametros)).rowCount, 1, descricao);
        }
        const alteradas = await cliente.query("SELECT count(*)::int AS n FROM imagens_padrao WHERE nome = 'Nome Administrativo' OR ativo = false OR ilustrativa = false OR versao = 2");
        assert.equal(alteradas.rows[0].n, 4, 'as alterações chegaram às linhas');
        await cliente.query('ROLLBACK');
      } finally { cliente.release(); }
      const depois = await instantaneoDoBanco(amb.q);
      assert.deepEqual(depois.padrao, antes.padrao, 'nada vazou da transação desfeita');
    });

    test('CTRL-PAD-DB-08 — o espião e o injetor de falha funcionam sobre o POOL REAL: enxergam as instruções de uma transação de verdade, o COMMIT que falha deixa a transação aberta (o detector de sessão acusa) e o ROLLBACK a desfaz', async () => {
      await cenario();
      const [a, b] = pacote.itens;
      const valores = (i) => [i.nome, i.arquivoOrigem, i.sha256Padronizado, i.sha256Miniatura, i.bytesPadronizado, i.bytesMiniatura];
      const espiado = espiarPool(amb.pool);
      const c1 = await espiado.espiao.connect();
      await c1.query('BEGIN');
      await c1.query(INSERT_LINHA, valores(a));
      await c1.query('COMMIT');
      c1.release();
      assert.deepEqual(espiado.escritas().map((r) => r.sql.trim().split(/\s+/)[0]), ['INSERT']);
      assert.equal(await contar('imagens_padrao'), 1);
      const sessoes = await sessoesAbertas();
      const falha = falharNoPool(amb.pool, { padrao: /^\s*COMMIT\b/i, numero: 1 });
      const c2 = await falha.espiao.connect();
      await c2.query('BEGIN');
      await c2.query(INSERT_LINHA, valores(b));
      await assert.rejects(() => c2.query('COMMIT'), (erro) => erro.injetada === true);
      assert.equal(await sessoesAbertas(), sessoes + 1, 'sem ROLLBACK a conexão fica com a transação aberta: é o que o detector acusa');
      assert.equal(await contar('imagens_padrao'), 1, 'a linha não confirmada não aparece para as outras conexões');
      await c2.query('ROLLBACK');
      c2.release();
      assert.equal(await sessoesAbertas(), sessoes);
      assert.equal(await contar('imagens_padrao'), 1);
    });
  });

  // --------------------------------------------------------------------------------------------------------------------------- PAD-01
  describe('[PAD-01] primeira importação: só o PNG padronizado e a miniatura entram', () => {
    test('PAD-01.01 — cadastra as 30 imagens com os metadados do pacote e grava os 60 arquivos byte a byte; o relatório diz o mesmo; o serviço não escreve no console e não vaza caminho', async (t) => {
      const c = await cenario();
      const consoles = ['log', 'error', 'warn', 'info', 'debug'].map((metodo) => t.mock.method(console, metodo, () => {}));
      const { relatorio, escritasSql, armazenamento } = await importarEspiado(c);
      assert.equal(relatorio.modo, 'EXECUCAO');
      assert.deepEqual(relatorio.pacote, { nome: NOME_ZIP, bytes: ZIP_INTEGRO.length, sha256: c.sha });
      assert.equal(relatorio.verificados, 90);
      assert.deepEqual(relatorio.resumo, RESUMO_PRIMEIRO);
      assert.deepEqual(relatorio.itens.map((i) => [i.nome, i.situacao]), pacote.itens.map((i) => [i.nome, 'NOVA']), 'a ordem é a do manifesto');
      const ids = (await amb.q('SELECT id::text AS id, nome FROM imagens_padrao')).rows;
      assert.deepEqual(new Map(relatorio.itens.map((i) => [i.nome, i.imagemId])), new Map(ids.map((r) => [r.nome, r.id])), 'o id do relatório é o do banco, como texto');
      await conferirLinhas(c);
      conferirArquivos(c);
      assert.ok(escritasSql.length > 0, 'controle: o espião de SQL enxerga as escritas do importador');
      assert.equal(chamadas(armazenamento, 'gravar').length, 60, 'controle: o espião de armazenamento enxerga as 60 gravações');
      const hashesEsperados = new Map(arquivosEsperados().map(([rel, bytes]) => [rel, h.sha256(bytes)]));
      const limiteDe = (chave) => (chave.endsWith('/miniatura.webp') ? 65536 : 5 * 1024 * 1024);
      assert.deepEqual(new Set(chamadas(armazenamento, 'gravar').map((g) => g.args[0])), new Set(hashesEsperados.keys()), 'as 60 chaves previstas, nenhuma outra');
      for (const { args: [chave, , opcoes] } of chamadas(armazenamento, 'gravar')) {
        assert.equal(opcoes?.sha256Esperado, hashesEsperados.get(chave), `a gravação confere o SHA-256 do manifesto na fronteira da escrita: ${chave}`);
        assert.ok(Number.isSafeInteger(opcoes?.maxBytes) && opcoes.maxBytes > 0 && opcoes.maxBytes <= limiteDe(chave), `limite de bytes da gravação: ${chave}`);
      }
      for (const metodo of ['remover', 'removerVariantes']) assert.equal(chamadas(armazenamento, metodo).length, 0, `o importador nunca chama ${metodo}`);
      assert.equal(JSON.stringify(relatorio).includes(c.base), false, 'o relatório não leva caminho');
      assert.deepEqual(consoles.map((m) => m.mock.callCount()), [0, 0, 0, 0, 0], 'só a CLI imprime');
    });

    test('PAD-01.02 — os 30 originais (com C2PA) NUNCA são importados: nenhum arquivo guardado tem o hash de um original nem o marcador C2PA; no banco o hash do original é só referência', async () => {
      const c = await cenario();
      await importar(c);
      const originais = new Set(pacote.itens.map((i) => i.sha256Original));
      for (const rel of arquivosSob(c.dirArm)) {
        const bytes = fs.readFileSync(path.join(c.dirArm, rel));
        assert.equal(originais.has(h.sha256(bytes)), false, rel);
        assert.equal(bytes.includes(Buffer.from('caBX')), false, rel);
        assert.equal(rel.split('/').some((parte) => originais.has(parte)), false, `nenhum caminho leva o hash de um original: ${rel}`);
      }
      const linhas = await linhasDoBanco();
      assert.deepEqual(new Set(linhas.map((l) => l.sha256_original_ref)), originais, 'a referência é gravada');
      assert.equal(linhas.some((l) => originais.has(l.sha256) || originais.has(l.sha256_miniatura)), false, 'mas nunca como o hash da imagem importada');
    });

    test('PAD-01.03 — nenhuma derivada de 640 nem de exibição é gerada: só mestre.png e miniatura.webp existem, e sha256_exibicao e bytes_exibicao ficam nulos', async () => {
      const c = await cenario();
      await importar(c);
      assert.deepEqual([...new Set(arquivosSob(c.dirArm).map((rel) => path.basename(rel)))].sort(), ['mestre.png', 'miniatura.webp']);
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao WHERE sha256_exibicao IS NOT NULL OR bytes_exibicao IS NOT NULL')).rows[0].n, 0);
    });

    test('PAD-01.04 — a importação só mexe em imagens_padrao e no armazenamento: nada é extraído ao lado do ZIP, as demais tabelas ficam como estavam e nenhum temporário sobra', async () => {
      const c = await cenario();
      await amb.material(amb.d.empresaA, 'Luva de Segurança');
      const antes = await instantaneoDoBanco(amb.q);
      await importar(c);
      const depois = await instantaneoDoBanco(amb.q);
      assert.deepEqual(depois.materiais, antes.materiais);
      assert.deepEqual(depois.contagens, antes.contagens);
      assert.deepEqual(fs.readdirSync(c.dirZip), [NOME_ZIP]);
      assert.equal(arquivosSob(c.dirArm).some((rel) => rel.endsWith('.tmp')), false);
    });
  });

  // --------------------------------------------------------------------------------------------------------------------------- PAD-02
  describe('[PAD-02] integridade não comprovada, com banco e armazenamento REAIS: o estado fica exatamente como estava', () => {
    const num2 = (k) => num(k);
    const ULTIMO = pacote.itens[29];
    const CENARIOS = [
      { descricao: 'PNG padronizado com um byte invertido', construir: () => h.zipDoPacote(pacote, ADULTERACOES[1][1]), codigo: 'PACOTE_HASH_DIVERGENTE' },
      { descricao: 'a ÚLTIMA miniatura do pacote adulterada (os 29 itens anteriores estavam íntegros)', construir: () => h.zipDoPacote(pacote, ADULTERACOES[9][1]), codigo: 'PACOTE_HASH_DIVERGENTE' },
      { descricao: 'original adulterado (não é importado, mas é conferido)', construir: () => h.zipDoPacote(pacote, ADULTERACOES[4][1]), codigo: 'PACOTE_HASH_DIVERGENTE' },
      { descricao: 'hash do PNG alterado no manifesto, arquivo intacto', construir: () => h.zipDoPacote(pacote, ADULTERACOES[5][1]), codigo: 'PACOTE_HASH_DIVERGENTE' },
      { descricao: 'miniatura ausente do ZIP', construir: () => h.zipDoPacote(pacote, { remover: [pacote.itens[17].entradaMiniatura] }), codigo: 'PACOTE_ARQUIVO_AUSENTE' },
      {
        descricao: 'metadados na miniatura do ÚLTIMO item, com hash coerente com o manifesto',
        construir: () => h.zipDoPacote(h.pacoteComItem(pacote, 29, { miniatura: h.webpFicticio({ semente: ULTIMO.nome, extras: [{ tipo: 'EXIF', dados: Buffer.from('Exif\0\0') }] }) })),
        codigo: 'IMAGEM_PADRAO_INVALIDA',
      },
      { descricao: 'caminho perigoso dentro do ZIP', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '../fora.png', dados: Buffer.from('x') }] }), codigo: 'PACOTE_INVALIDO' },
      {
        descricao: 'adulteração COORDENADA (arquivo e manifesto trocados juntos): só o hash aprovado do ZIP, de fora, denuncia',
        construir: () => h.zipDoPacote(h.pacoteComItem(pacote, 9, { padronizado: outroPng })),
        codigo: 'PACOTE_SHA256_DIVERGENTE',
        contraAprovado: true,
      },
    ];
    CENARIOS.forEach(({ descricao, construir, codigo, contraAprovado }, k) => {
      test(`PAD-02.${num2(k)} — ${descricao}: ${codigo} e NADA muda (linhas, sequências, arquivos), sem transação aberta`, async () => {
        const c = await cenario(construir());
        const alvo = contraAprovado ? { ...c, sha: h.sha256(ZIP_INTEGRO) } : c;
        const antes = await estado(c);
        const sessoes = await sessoesAbertas();
        const e = espioes(c);
        await recusa(importarCom(alvo, e), codigo);
        assert.deepEqual(await estado(c), antes);
        assert.deepEqual(arquivosSob(c.dirArm), []);
        assert.equal(await sessoesAbertas(), sessoes);
        semEscrever(e);
      });
    });

    test('PAD-02.99 — com o pacote íntegro já importado, um pacote adulterado é recusado sem "atualizar" nada: o estado fica idêntico, inclusive inodes e carimbos', async () => {
      const c = await cenario();
      await importar(c);
      const zip = h.zipDoPacote(pacote, ADULTERACOES[1][1]);
      const adulterado = { ...c, zip: h.gravarArquivo(c.dirZip, 'Adulterado.zip', zip), sha: h.sha256(zip) };
      const antes = await estado(c);
      const e = espioes(c);
      await recusa(importarCom(adulterado, e), 'PACOTE_HASH_DIVERGENTE');
      assert.deepEqual(await estado(c), antes);
      semEscrever(e);
    });
  });

  // --------------------------------------------------------------------------------------------------------------------------- PAD-03
  describe('[PAD-03] idempotência completa: a segunda importação não escreve, não recria e não renumera nada', () => {
    test('IDEM-01 — duas importações seguidas (e uma terceira): a segunda NÃO emite escrita nem gravação, não consome sequência e deixa o estado idêntico linha a linha, byte a byte e inode a inode; o relatório se repete', async () => {
      const c = await cenario();
      const primeira = await importarEspiado(c);
      assert.deepEqual(primeira.relatorio.resumo, RESUMO_PRIMEIRO);
      const antes = await estado(c);
      const segunda = await importarEspiado(c);
      assert.deepEqual(segunda.escritasSql, [], `escritas na segunda importação: ${JSON.stringify(segunda.escritasSql.map((r) => r.sql.trim().slice(0, 60)))}`);
      for (const metodo of ['gravar', 'remover', 'removerVariantes']) assert.deepEqual(chamadas(segunda.armazenamento, metodo), [], `armazenamento.${metodo} na segunda importação`);
      assert.deepEqual(await estado(c), antes, 'banco (xmin, ctid, carimbos, sequências) e disco (inode, mtime, ctime, bytes) idênticos');
      assert.equal(segunda.relatorio.modo, 'EXECUCAO');
      assert.deepEqual(segunda.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.deepEqual(segunda.relatorio.itens, primeira.relatorio.itens.map((i) => ({ ...i, situacao: 'EXISTENTE' })), 'mesmos nomes, mesma ordem, mesmos ids');
      assert.deepEqual([segunda.relatorio.pacote, segunda.relatorio.verificados], [primeira.relatorio.pacote, 90]);
      const terceira = await importarEspiado(c);
      assert.deepEqual(terceira.relatorio, segunda.relatorio, 'determinístico');
      assert.deepEqual(terceira.escritasSql, []);
      assert.deepEqual(await estado(c), antes);
      await conferirLinhas(c);
      conferirArquivos(c);
    });

    test('IDEM-02 — o mesmo pacote por outro caminho e com outro nome de arquivo é o MESMO pacote (a chave é o SHA-256): nenhuma linha muda, nem a proveniência gravada na primeira vez', async () => {
      const c = await cenario();
      await importar(c);
      const antes = await estado(c);
      const copiaDir = path.join(c.base, 'copia');
      fs.mkdirSync(copiaDir);
      const copia = h.gravarArquivo(copiaDir, 'Outro_Nome_Do_Mesmo_Pacote.zip', ZIP_INTEGRO);
      const r = await importar({ ...c, zip: copia });
      assert.deepEqual(r.resumo, RESUMO_NADA_A_FAZER);
      assert.equal(r.pacote.nome, 'Outro_Nome_Do_Mesmo_Pacote.zip', 'o relatório descreve ESTA execução');
      assert.deepEqual(await estado(c), antes);
      assert.deepEqual((await amb.q('SELECT DISTINCT pacote_origem FROM imagens_padrao')).rows, [{ pacote_origem: NOME_ZIP }], 'a proveniência da primeira importação fica');
    });

    test('IDEM-03 — a simulação (executar:false) não escreve nada, nem no banco nem no armazenamento, e diz o que seria feito; depois da execução, diz que não há mais nada a fazer', async () => {
      const c = await cenario();
      const antes = await estado(c);
      const simulada = await importarEspiado(c, { executar: false });
      assert.equal(simulada.relatorio.modo, 'SIMULACAO');
      assert.equal(simulada.relatorio.verificados, 90);
      assert.deepEqual(simulada.relatorio.resumo, RESUMO_PRIMEIRO);
      assert.ok(simulada.relatorio.itens.every((i) => i.situacao === 'NOVA' && i.imagemId === null));
      assert.deepEqual(simulada.escritasSql, []);
      for (const metodo of ['gravar', 'remover', 'removerVariantes']) assert.deepEqual(chamadas(simulada.armazenamento, metodo), [], `armazenamento.${metodo}`);
      assert.deepEqual(await estado(c), antes);
      await importar(c);
      const depois = await estado(c);
      const outra = await importarEspiado(c, { executar: false });
      assert.deepEqual(outra.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.ok(outra.relatorio.itens.every((i) => i.situacao === 'EXISTENTE' && typeof i.imagemId === 'string'));
      assert.deepEqual(outra.escritasSql, []);
      assert.deepEqual(await estado(c), depois);
    });

    test('IDEM-04 — duas importações SIMULTÂNEAS nunca duplicam nem corrompem: o estado final é o de uma execução só, e qualquer recusa é controlada (código próprio, nunca o erro cru do banco)', async () => {
      const c = await cenario();
      const resultados = await Promise.allSettled([importar(c), importar(c)]);
      assert.ok(resultados.some((r) => r.status === 'fulfilled'), 'ao menos uma importação conclui');
      for (const r of resultados.filter((x) => x.status === 'rejected')) assert.equal(typeof r.reason.codigo, 'string', `recusa sem código próprio: ${r.reason.code ?? r.reason.message}`);
      await conferirLinhas(c);
      conferirArquivos(c);
      assert.equal((await amb.q('SELECT count(DISTINCT sha256)::int AS n FROM imagens_padrao')).rows[0].n, 30);
      const antes = await estado(c);
      const outra = await importarEspiado(c);
      assert.deepEqual(outra.escritasSql, []);
      assert.deepEqual(await estado(c), antes);
    });

    test('IDEM-05 — estado parcial (18 das 30 imagens faltam no banco e no armazenamento): a repetição completa SÓ o que falta e não toca no que existe (mesmas linhas, mesmos inodes)', async () => {
      const c = await cenario();
      await importar(c);
      const mantidos = pacote.itens.slice(0, 12);
      const faltam = pacote.itens.slice(12);
      await amb.q('DELETE FROM imagens_padrao WHERE nome = ANY($1::text[])', [faltam.map((i) => i.nome)]);
      for (const i of faltam) fs.rmSync(path.join(c.dirArm, 'padrao', i.sha256Padronizado), { recursive: true });
      const antes = await estado(c);
      const r = await importarEspiado(c);
      assert.deepEqual(r.relatorio.resumo, { total: 30, novas: 18, existentes: 12, arquivosNovos: 36, arquivosPresentes: 24, sugestoes: 0 });
      assert.equal(chamadas(r.armazenamento, 'gravar').length, 36);
      const depois = await estado(c);
      const doBanco = (e) => e.banco.padrao.filter((l) => mantidos.some((i) => i.nome === l.linha.nome));
      assert.deepEqual(doBanco(depois), doBanco(antes), 'as 12 linhas que existiam não foram tocadas');
      const doDisco = (e) => e.disco.filter((x) => mantidos.some((i) => x.caminho.startsWith(`padrao/${i.sha256Padronizado}`)));
      assert.deepEqual(doDisco(depois), doDisco(antes), 'os 24 arquivos que existiam não foram tocados');
      await conferirLinhas(c);
      conferirArquivos(c);
    });

    test('IDEM-06 — estado parcial invertido (os 60 arquivos gravados e NENHUMA linha, como numa queda entre as duas fases): a repetição cria as 30 linhas e não regrava nenhum arquivo', async () => {
      const c = await cenario();
      await importar(c);
      await amb.q('DELETE FROM imagens_padrao');
      const antes = await estado(c);
      const r = await importarEspiado(c);
      assert.deepEqual(r.relatorio.resumo, { total: 30, novas: 30, existentes: 0, arquivosNovos: 0, arquivosPresentes: 60, sugestoes: 0 });
      assert.deepEqual(chamadas(r.armazenamento, 'gravar'), []);
      assert.deepEqual((await estado(c)).disco, antes.disco, 'o disco não mudou em nada');
      await conferirLinhas(c);
      conferirArquivos(c);
    });

    test('IDEM-07 — queda antes do COMMIT: nenhuma linha fica (tudo ou nada), nenhuma conexão fica com transação aberta, nenhum temporário sobra, e a repetição completa sem reescrever os arquivos que já estavam gravados', async () => {
      const c = await cenario();
      const sessoes = await sessoesAbertas();
      const falha = falharNoPool(amb.pool, { padrao: /^\s*COMMIT\b/i, numero: 1 });
      const erro = await rejeitada(importar(c, { pool: falha.espiao }));
      assert.equal(falha.disparos.length, 1, 'a gravação das linhas é transacional: o COMMIT foi emitido e falhou');
      assert.equal(erro.message.includes(c.base), false);
      assert.equal(await contar('imagens_padrao'), 0, 'tudo ou nada');
      assert.equal(await contar('imagens_padrao_tipos'), 0);
      assert.equal(await sessoesAbertas(), sessoes, 'a transação foi desfeita e a conexão devolvida');
      const aposFalha = arquivosSob(c.dirArm);
      assert.equal(aposFalha.some((rel) => rel.endsWith('.tmp')), false, 'nenhum temporário sobra');
      const esperados = new Map(arquivosEsperados());
      for (const rel of aposFalha) assert.ok(fs.readFileSync(path.join(c.dirArm, rel)).equals(esperados.get(rel)), `arquivo parcial ou diferente: ${rel}`);
      const discoApos = instantaneoDoArmazenamento(c.dirArm);
      const r = await importarEspiado(c);
      await conferirLinhas(c);
      conferirArquivos(c);
      naoReescritos(discoApos, instantaneoDoArmazenamento(c.dirArm));
      assert.equal(chamadas(r.armazenamento, 'gravar').length, 60 - aposFalha.length, 'só o que faltava é gravado');
      assert.equal(r.relatorio.resumo.novas, 30);
    });

    test('IDEM-08 — falha do armazenamento no meio (25ª gravação): nenhuma linha é criada, nada fica em voo nem pela metade, e a repetição completa o que faltava sem reescrever os arquivos já gravados', async () => {
      const c = await cenario();
      const falha = armazenamentoQueFalha(c.armazenamento, { metodo: 'gravar', numero: 25 });
      const erro = await rejeitada(importar(c, { armazenamento: falha.armazenamento }));
      assert.equal(falha.disparos.length, 1);
      assert.equal(erro.message.includes(c.base), false);
      assert.equal(await contar('imagens_padrao'), 0, 'as linhas só existem depois de TODOS os arquivos');
      const aposFalha = instantaneoDoArmazenamento(c.dirArm);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      assert.deepEqual(instantaneoDoArmazenamento(c.dirArm), aposFalha, 'nenhuma gravação ficou em voo depois da recusa');
      const arquivos = arquivosSob(c.dirArm);
      assert.equal(arquivos.some((rel) => rel.endsWith('.tmp')), false);
      assert.ok(arquivos.length < 60);
      const esperados = new Map(arquivosEsperados());
      for (const rel of arquivos) assert.ok(fs.readFileSync(path.join(c.dirArm, rel)).equals(esperados.get(rel)), `arquivo parcial ou diferente: ${rel}`);
      const r = await importarEspiado(c);
      await conferirLinhas(c);
      conferirArquivos(c);
      naoReescritos(aposFalha, instantaneoDoArmazenamento(c.dirArm));
      assert.equal(chamadas(r.armazenamento, 'gravar').length, 60 - arquivos.length);
    });

    test('IDEM-09 — com mapeamento aprovado, queda na gravação das sugestões: as imagens TAMBÉM não ficam (uma unidade só), e a repetição completa tudo', async () => {
      const c = await cenario();
      const mapa = escreverMapa(c, APROVADAS);
      const sessoes = await sessoesAbertas();
      const falha = falharNoPool(amb.pool, { padrao: /\bINSERT\s+INTO\s+imagens_padrao_tipos\b/i, numero: 1 });
      await rejeitada(importar(c, { pool: falha.espiao, mapeamento: mapa }));
      assert.equal(falha.disparos.length, 1, 'controle: a gravação das sugestões foi tentada');
      assert.equal(await contar('imagens_padrao'), 0);
      assert.equal(await contar('imagens_padrao_tipos'), 0);
      assert.equal(await sessoesAbertas(), sessoes);
      const r = await importar(c, { mapeamento: mapa });
      assert.deepEqual(r.resumo, { ...RESUMO_PRIMEIRO, arquivosNovos: r.resumo.arquivosNovos, arquivosPresentes: r.resumo.arquivosPresentes, sugestoes: 2 });
      assert.equal(r.resumo.arquivosNovos + r.resumo.arquivosPresentes, 60);
      await conferirLinhas(c);
      assert.equal((await sugestoesDoBanco()).length, 2);
    });

    test('IDEM-10 — arquivos guardados com OUTROS bytes (um PNG e uma miniatura, de itens diferentes): ESTADO_DIVERGENTE nos dois itens, nada é sobrescrito, apagado ou alterado', async () => {
      const c = await cenario();
      await importar(c);
      const [a, b] = [pacote.itens[3], pacote.itens[5]];
      fs.writeFileSync(path.join(c.dirArm, caminhoPng(a)), outroPng);
      fs.writeFileSync(path.join(c.dirArm, caminhoWebp(b)), h.comByteInvertido(b.miniatura));
      const antes = await estado(c);
      const e = espioes(c);
      const erro = await recusa(importarCom(c, e), 'ESTADO_DIVERGENTE');
      assert.deepEqual(erro.detalhes.map((d) => [d.nome, d.alvo]).sort(), [[a.nome, 'ARQUIVO'], [b.nome, 'ARQUIVO']].sort(), 'relatório completo, sem falso positivo');
      assert.equal(JSON.stringify(erro.detalhes).includes(c.base), false);
      semEscrever(e);
      assert.deepEqual(await estado(c), antes);
    });

    DIVERGENCIAS_DE_REGISTRO.forEach(([campo, atribuicao], k) => {
      test(`IDEM-11.${num(k)} — linha existente com ${campo} diferente do pacote: ESTADO_DIVERGENTE no registro daquele item, nada é alterado, nenhuma imagem é criada`, async () => {
        const c = await cenario();
        await importar(c);
        const alvo = pacote.itens[11];
        await amb.q(`UPDATE imagens_padrao SET ${atribuicao} WHERE sha256 = $1`, [alvo.sha256Padronizado]);
        const antes = await estado(c);
        const e = espioes(c);
        const erro = await recusa(importarCom(c, e), 'ESTADO_DIVERGENTE');
        assert.deepEqual(erro.detalhes.map((d) => [d.nome, d.alvo]), [[alvo.nome, 'REGISTRO']]);
        semEscrever(e);
        assert.deepEqual(await estado(c), antes);
      });
    });

    test('IDEM-12 — o nome de uma imagem do pacote já pertence a OUTRA imagem (outro SHA-256): ESTADO_DIVERGENTE no registro, nada é criado nem alterado', async () => {
      const c = await cenario();
      const alvo = pacote.itens[7];
      await amb.q(INSERT_LINHA, [alvo.nome, 'antiga.png', h.sha256('imagem antiga'), h.sha256('miniatura antiga'), 100, 100]);
      const antes = await estado(c);
      const e = espioes(c);
      const erro = await recusa(importarCom(c, e), 'ESTADO_DIVERGENTE');
      assert.ok(erro.detalhes.some((d) => d.nome === alvo.nome && d.alvo === 'REGISTRO'));
      semEscrever(e);
      assert.deepEqual(await estado(c), antes);
      assert.deepEqual(arquivosSob(c.dirArm), []);
    });

    test('IDEM-13 — alterações ADMINISTRATIVAS depois da importação (renomear, inativar, marcar como não ilustrativa, outra proveniência, derivada de exibição gravada, outra versão, outra referência de original) não são divergência: a repetição não altera nem reativa nada', async () => {
      const c = await cenario();
      await importar(c);
      for (const [, montar] of ALTERACOES_ADMINISTRATIVAS) {
        const [sql, parametros] = montar(pacote.itens);
        await amb.q(sql, parametros);
      }
      const antes = await estado(c);
      const r = await importarEspiado(c);
      assert.deepEqual(r.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.deepEqual(r.escritasSql, []);
      assert.deepEqual(chamadas(r.armazenamento, 'gravar'), []);
      assert.deepEqual(await estado(c), antes);
      assert.equal((await amb.q('SELECT ativo FROM imagens_padrao WHERE sha256 = $1', [pacote.itens[1].sha256Padronizado])).rows[0].ativo, false, 'a imagem inativada continua inativa');
    });

    test('IDEM-14 — o resultado é determinístico: duas importações em ambientes novos e separados dão as mesmas linhas (sem ids nem carimbos), os mesmos arquivos e o mesmo relatório (sem ids)', async () => {
      const semIds = (relatorio) => ({ ...relatorio, itens: relatorio.itens.map(({ imagemId, ...resto }) => resto) });
      const lerDisco = (c) => arquivosSob(c.dirArm).map((rel) => [rel, h.sha256(fs.readFileSync(path.join(c.dirArm, rel)))]);
      const c1 = await cenario();
      const r1 = await importar(c1);
      const linhas1 = await linhasDoBanco();
      const disco1 = lerDisco(c1);
      const c2 = await cenario();
      const r2 = await importar(c2);
      assert.deepEqual(semIds(r2), semIds(r1));
      assert.deepEqual(await linhasDoBanco(), linhas1);
      assert.deepEqual(lerDisco(c2), disco1);
      assert.equal(disco1.length, 60);
    });

    test('IDEM-15 — arquivo já presente com OUTROS bytes e nenhuma linha (resíduo de uma queda): ESTADO_DIVERGENTE no arquivo, nada é sobrescrito e nada é criado', async () => {
      const c = await cenario();
      const alvo = pacote.itens[20];
      const pasta = path.join(c.dirArm, 'padrao', alvo.sha256Padronizado);
      fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(path.join(pasta, 'miniatura.webp'), h.comByteInvertido(alvo.miniatura));
      const antes = await estado(c);
      const e = espioes(c);
      const erro = await recusa(importarCom(c, e), 'ESTADO_DIVERGENTE');
      assert.deepEqual(erro.detalhes.map((d) => [d.nome, d.alvo]), [[alvo.nome, 'ARQUIVO']]);
      semEscrever(e);
      assert.deepEqual(await estado(c), antes);
      assert.equal(await contar('imagens_padrao'), 0);
    });

    test('IDEM-16 — D5: registro existente com arquivo AUSENTE (a miniatura de um item, a pasta inteira de outro): ESTADO_DIVERGENTE nos dois, sem reparação automática — nada é gravado e o que faltava continua faltando', async () => {
      const c = await cenario();
      await importar(c);
      const [a, b] = [pacote.itens[8], pacote.itens[9]];
      fs.rmSync(path.join(c.dirArm, caminhoWebp(a)));
      fs.rmSync(path.join(c.dirArm, 'padrao', b.sha256Padronizado), { recursive: true });
      const antes = await estado(c);
      const e = espioes(c);
      const erro = await recusa(importarCom(c, e), 'ESTADO_DIVERGENTE');
      assert.deepEqual(erro.detalhes.map((d) => [d.nome, d.alvo, d.motivo]).sort(), [[a.nome, 'ARQUIVO', 'AUSENTE'], [b.nome, 'ARQUIVO', 'AUSENTE']].sort());
      semEscrever(e);
      assert.deepEqual(await estado(c), antes);
      assert.equal(fs.existsSync(path.join(c.dirArm, caminhoWebp(a))), false, 'o arquivo ausente não foi recriado');
      assert.equal(fs.existsSync(path.join(c.dirArm, 'padrao', b.sha256Padronizado)), false);
    });
  });

  // --------------------------------------------------------------------------------------------------------------------------- PAD-04
  describe('[PAD-04] sugestões de tipo: só as linhas APROVADAS do mapeamento viram sugestão', () => {
    test('PAD-04.01 — sem mapeamento: zero sugestões', async () => {
      const c = await cenario();
      const r = await importar(c);
      assert.equal(r.resumo.sugestoes, 0);
      assert.deepEqual(await sugestoesDoBanco(), []);
    });

    test('PAD-04.02 — mapeamento no estado de PROPOSTA (30 linhas, nenhuma decisão): zero sugestões; o tipo sugerido e a confiança, sozinhos, não bastam', async () => {
      const c = await cenario();
      const r = await importar(c, { mapeamento: escreverMapa(c) });
      assert.equal(r.resumo.sugestoes, 0);
      assert.deepEqual(await sugestoesDoBanco(), []);
      await conferirLinhas(c);
      conferirArquivos(c);
    });

    test('PAD-04.03 — só as linhas APROVADAS viram sugestão (tipo do CSV, nível pela confiança, aprovador e data do CSV); REJEITAR, AJUSTAR e sem decisão não entram', async () => {
      const c = await cenario();
      const decisoes = { ...APROVADAS, 'Capacete de Segurança': { ...DECISAO, decisao: 'REJEITAR' }, 'Respirador PFF2': { ...DECISAO, decisao: 'AJUSTAR' } };
      const r = await importar(c, { mapeamento: escreverMapa(c, decisoes) });
      assert.equal(r.resumo.sugestoes, 2);
      assert.deepEqual(await sugestoesDoBanco(), [
        { imagem: 'Botina de Segurança - Couro', tipo_nome: 'Sapato de Segurança', nivel: 'ALTERNATIVA', aprovado_por: 'Ramires', aprovado_em: '2026-10-17' },
        { imagem: 'Luva de Segurança', tipo_nome: 'Luva de Segurança', nivel: 'PRINCIPAL', aprovado_por: 'Ramires', aprovado_em: '2026-10-17' },
      ]);
      await conferirLinhas(c);
      conferirArquivos(c);
    });

    test('PAD-04.04 — com TODAS as linhas aprováveis aprovadas: 29 sugestões (26 PRINCIPAL e as 3 MÉDIA como ALTERNATIVA: Botina, Calça e Camisa de Eletricista); a Camiseta Azul entra SEM sugestão; todo tipo é do catálogo BASE', async () => {
      const c = await cenario();
      const decisoes = Object.fromEntries(pacote.itens.filter((i) => i.nome !== 'Camiseta Azul').map((i) => [i.nome, DECISAO]));
      const r = await importar(c, { mapeamento: escreverMapa(c, decisoes) });
      assert.equal(r.resumo.sugestoes, 29);
      const sugestoes = await sugestoesDoBanco();
      assert.equal(sugestoes.length, 29);
      assert.deepEqual(sugestoes.filter((s) => s.nivel === 'ALTERNATIVA').map((s) => s.imagem).sort(), ['Botina de Segurança - Couro', 'Calça de Segurança - Eletricista', 'Vestimenta para Proteção do Tronco - Camisa de Eletricista']);
      assert.equal(sugestoes.filter((s) => s.nivel === 'PRINCIPAL').length, 26);
      assert.equal(sugestoes.some((s) => s.imagem === 'Camiseta Azul'), false);
      assert.equal((await linhasDoBanco()).some((l) => l.nome === 'Camiseta Azul'), true, 'a imagem existe na biblioteca, sem sugestão');
      const tiposBase = new Set(CATALOGO_BASE.map((t) => t.nome));
      assert.ok(sugestoes.every((s) => tiposBase.has(s.tipo_nome)));
    });

    MAPEAMENTOS_INVALIDOS.forEach(([descricao, alterar, sonda], k) => {
      test(`PAD-04.${num(4 + k)} — mapeamento inválido (${descricao}): MAPEAMENTO_INVALIDO, nada é escrito e a mensagem não ecoa o valor`, async () => {
        const c = await cenario();
        const resultado = alterar(h.linhasDeMapeamento(pacote));
        const texto = typeof resultado === 'string' ? resultado : h.mapeamentoCsv(resultado);
        const mapa = h.gravarArquivo(c.dirZip, 'mapeamento.csv', Buffer.from(texto, 'utf8'));
        const antes = await estado(c);
        const e = espioes(c);
        const erro = await recusa(importarCom(c, e, { mapeamento: mapa }), 'MAPEAMENTO_INVALIDO');
        assert.deepEqual(await estado(c), antes);
        semEscrever(e);
        assert.equal(erro.message.includes(c.base), false);
        if (sonda !== null) assert.equal(erro.message.includes(sonda), false, 'a mensagem ecoa um valor do arquivo');
      });
    });

    test('PAD-04.90 — mapeamento inexistente ou que é uma pasta: MAPEAMENTO_INDISPONIVEL e nada é escrito', async () => {
      const c = await cenario();
      const antes = await estado(c);
      for (const alvo of [path.join(c.dirZip, 'nao-existe.csv'), c.dirZip]) {
        const e = espioes(c);
        await recusa(importarCom(c, e, { mapeamento: alvo }), 'MAPEAMENTO_INDISPONIVEL');
        semEscrever(e);
      }
      assert.deepEqual(await estado(c), antes);
    });

    test('PAD-04.91 — repetir a importação com o MESMO mapeamento não duplica nem altera sugestão: nenhuma escrita, nenhuma sequência consumida', async () => {
      const c = await cenario();
      const mapa = escreverMapa(c, APROVADAS);
      await importar(c, { mapeamento: mapa });
      const antes = await estado(c);
      const segunda = await importarEspiado(c, { mapeamento: mapa });
      assert.deepEqual(segunda.escritasSql, []);
      assert.deepEqual(chamadas(segunda.armazenamento, 'gravar'), []);
      assert.deepEqual(segunda.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.deepEqual(await estado(c), antes);
      assert.equal((await sugestoesDoBanco()).length, 2);
    });

    test('PAD-04.92 — D6: aprovações NOVAS depois da primeira importação não são inseridas, e as sugestões existentes ficam como estavam (nenhuma escrita, nenhuma sequência consumida)', async () => {
      const c = await cenario();
      await importar(c, { mapeamento: escreverMapa(c, APROVADAS, 'mapeamento-a.csv') });
      const antes = await estado(c);
      const sugestoesAntes = await sugestoesDoBanco();
      assert.equal(sugestoesAntes.length, 2);
      const maisAprovacoes = { ...APROVADAS, 'Capacete de Segurança': DECISAO, 'Respirador PFF2': DECISAO };
      const r = await importarEspiado(c, { mapeamento: escreverMapa(c, maisAprovacoes, 'mapeamento-b.csv') });
      assert.deepEqual(r.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.deepEqual(r.escritasSql, []);
      assert.deepEqual(await estado(c), antes);
      assert.deepEqual(await sugestoesDoBanco(), sugestoesAntes);
    });

    test('PAD-04.93 — D6: importada sem mapeamento, a imagem não ganha sugestão por uma aprovação posterior (nenhuma escrita)', async () => {
      const c = await cenario();
      await importar(c);
      const antes = await estado(c);
      const r = await importarEspiado(c, { mapeamento: escreverMapa(c, APROVADAS) });
      assert.deepEqual(r.relatorio.resumo, RESUMO_NADA_A_FAZER);
      assert.deepEqual(r.escritasSql, []);
      assert.deepEqual(await estado(c), antes);
      assert.deepEqual(await sugestoesDoBanco(), []);
    });

    test('PAD-04.94 — D6: numa retomada parcial, a imagem NOVA recebe a sugestão aprovada e as que já existiam não recebem nenhuma', async () => {
      const c = await cenario();
      await importar(c);
      const nova = pacote.itens.find((i) => i.nome === 'Capacete de Segurança');
      await amb.q('DELETE FROM imagens_padrao WHERE sha256 = $1', [nova.sha256Padronizado]);
      fs.rmSync(path.join(c.dirArm, 'padrao', nova.sha256Padronizado), { recursive: true });
      const r = await importar(c, { mapeamento: escreverMapa(c, { 'Capacete de Segurança': DECISAO, 'Luva de Segurança': DECISAO }) });
      assert.deepEqual(r.resumo, { total: 30, novas: 1, existentes: 29, arquivosNovos: 2, arquivosPresentes: 58, sugestoes: 1 });
      assert.deepEqual(await sugestoesDoBanco(), [{ imagem: 'Capacete de Segurança', tipo_nome: 'Capacete de Segurança', nivel: 'PRINCIPAL', aprovado_por: 'Ramires', aprovado_em: '2026-10-17' }]);
    });
  });

  // --------------------------------------------------------------------------------------------------------------------------- PAD-05
  describe('[PAD-05] nenhum vínculo automático com tipo ou material', () => {
    test('PAD-05.01 — mesmo com sugestões aprovadas e materiais de nomes IGUAIS aos das imagens e dos tipos, nenhum material recebe imagem, nenhum material ou tipo é criado ou alterado, e nenhuma imagem de empresa aparece', async () => {
      const c = await cenario();
      await amb.material(amb.d.empresaA, 'Luva de Segurança');
      await amb.material(amb.d.empresaB, 'Sapato de Segurança');
      await amb.material(amb.d.empresaA, 'Camiseta Azul');
      const antes = await instantaneoDoBanco(amb.q);
      await importar(c, { mapeamento: escreverMapa(c, APROVADAS) });
      const depois = await instantaneoDoBanco(amb.q);
      assert.deepEqual(depois.materiais, antes.materiais, 'nenhum material mudou (xmin, ctid e linha inteira)');
      assert.deepEqual(depois.contagens, antes.contagens);
      assert.equal((await amb.q('SELECT count(*)::int AS n FROM materiais WHERE imagem_padrao_id IS NOT NULL OR imagem_empresa_id IS NOT NULL')).rows[0].n, 0);
      assert.equal((await sugestoesDoBanco()).length, 2, 'controle: as sugestões foram criadas');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------- CLI-DB
  describe('[CLI-DB] executarComando com banco e armazenamento reais', () => {
    const SEM_CONTROLE = /(?!\n)\p{Cc}/u;
    async function comando(c, modo, extra = {}) {
      const linhas = [];
      const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
      const r = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo, ...(modo === 'EXECUTAR' ? { destino: identidade } : {}), ...extra }, { pool: amb.pool, armazenamento: c.armazenamento, saida: { log: guardar, error: guardar } });
      const texto = linhas.join('\n');
      assert.equal(texto.includes(c.base), false, 'a saída vaza caminho');
      assert.doesNotMatch(texto, SEM_CONTROLE);
      return { saida: r.saida, texto };
    }

    test('CLI-DB-01 — o modo SIMULAR (o padrão) sai com 0, diz o que seria feito (30 imagens) e NÃO escreve nada', async () => {
      const c = await cenario();
      const antes = await estado(c);
      const r = await comando(c, 'SIMULAR');
      assert.equal(r.saida, 0);
      assert.match(r.texto, /\b30\b/);
      assert.match(r.texto, /simula/i);
      assert.deepEqual(await estado(c), antes);
    });

    test('CLI-DB-02 — EXECUTAR grava e sai com 0; repetir sai com 0, diz que as 30 já existem e não muda nada', async () => {
      const c = await cenario();
      const primeira = await comando(c, 'EXECUTAR');
      assert.equal(primeira.saida, 0);
      await conferirLinhas(c);
      conferirArquivos(c);
      const antes = await estado(c);
      const segunda = await comando(c, 'EXECUTAR');
      assert.equal(segunda.saida, 0);
      assert.match(segunda.texto, /\b30\b/);
      assert.match(segunda.texto, /exist(em|ente)/i);
      assert.deepEqual(await estado(c), antes);
    });

    test('CLI-DB-03 — estado divergente: saída 4 (DIVERGENCIA), o código na saída, nada alterado', async () => {
      const c = await cenario();
      await importar(c);
      fs.writeFileSync(path.join(c.dirArm, caminhoPng(pacote.itens[3])), outroPng);
      const antes = await estado(c);
      const r = await comando(c, 'EXECUTAR');
      assert.equal(r.saida, 4);
      assert.ok(r.texto.includes('ESTADO_DIVERGENTE'));
      assert.deepEqual(await estado(c), antes);
    });

    test('CLI-DB-04 — integridade do pacote não comprovada, mesmo em EXECUTAR: saída 3 (INTEGRIDADE), o código na saída, nada escrito', async () => {
      const c = await cenario(h.zipDoPacote(pacote, ADULTERACOES[1][1]));
      const antes = await estado(c);
      const r = await comando(c, 'EXECUTAR');
      assert.equal(r.saida, 3);
      assert.ok(r.texto.includes('PACOTE_HASH_DIVERGENTE'));
      assert.deepEqual(await estado(c), antes);
    });

    test('CLI-DB-05 — com --mapeamento: as linhas aprovadas viram sugestão (saída 0); um mapeamento inválido sai com 2 (ARGUMENTOS) sem escrever nada', async () => {
      const c = await cenario();
      const ok = await comando(c, 'EXECUTAR', { mapeamento: escreverMapa(c, APROVADAS) });
      assert.equal(ok.saida, 0);
      assert.equal((await sugestoesDoBanco()).length, 2);

      const d = await cenario();
      const linhas = h.linhasDeMapeamento(pacote);
      linhas[0] = { ...linhas[0], decisao: 'APROVAR', por: '', data: '2026-10-17' };
      const antes = await estado(d);
      const ruim = await comando(d, 'EXECUTAR', { mapeamento: escreverMapaDeLinhas(d, linhas) });
      assert.equal(ruim.saida, 2);
      assert.ok(ruim.texto.includes('MAPEAMENTO_INVALIDO'));
      assert.deepEqual(await estado(d), antes);
    });
  });
});
