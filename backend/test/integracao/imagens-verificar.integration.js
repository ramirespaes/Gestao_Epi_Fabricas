'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const { BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const h = require('../helpers/verificacao-imagens');

/**
 * Verificador de integridade das imagens armazenadas (Biblioteca de Imagens, Unidade 5C-5) contra POSTGRESQL REAL.
 *
 * Prova o que o banco falso não prova: que as consultas funcionam nas tabelas reais (imagens_padrao, imagens_empresa, empresas e materiais), que a transação é de fato
 * READ ONLY e REPEATABLE READ no servidor, que nada muda no banco, que a paginação por chave cobre tudo e que o isolamento por empresa vale (arquivo de uma empresa nunca
 * cobre o registro de outra). Segue o contrato de segurança dos testes de integração: banco de testes exclusivo (gestao_epi_teste_local, conferido pelo helper),
 * schema temporário próprio com TODAS as migrations e DROP SCHEMA ... CASCADE ao fim, inclusive em falha. O armazenamento é um diretório temporário exclusivo.
 * Nenhum banco persistente, nenhuma das 30 imagens reais.
 */

const M = () => exigirModulo('src/services/imagem-armazenamento-verificacao.service');
const AGORA = Date.parse('2026-10-18T12:00:00.000Z');
const DIA = h.DIA_EM_MINUTOS;

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

/** O módulo é exigido ANTES de abrir banco e disco: sem implementação o teste falha sem criar nada. */
async function comAmbiente(corpo) {
  M();
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  const amb = await abrirAmbienteImagens();
  try {
    await corpo({ amb, raiz });
  } finally {
    await amb.encerrar();
  }
}

let sequencia = 0;
/** Semente única por imagem: o SHA-256 de cada uma precisa ser distinto (restrições de unicidade do banco). */
const semente = (prefixo) => { sequencia += 1; return `${prefixo}-integracao-${sequencia}`; };

/** Imagem da empresa com arquivos reais na raiz temporária e linha real no schema temporário. */
async function imagemDaEmpresa(amb, raiz, { empresaId, criadoPor, ...opcoes }) {
  const arq = h.criarImagemEmpresa(raiz, { id: 0, empresaId, semente: semente('e'), agora: AGORA, ...opcoes });
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

async function imagemPadrao(amb, raiz, opcoes = {}) {
  const arq = h.criarImagemPadrao(raiz, { id: 0, semente: semente('p'), agora: AGORA, ...opcoes });
  const linha = await amb.padrao({
    sha256: arq.linha.sha256,
    sha256_miniatura: arq.linha.sha256_miniatura,
    sha256_exibicao: arq.linha.sha256_exibicao,
    formato: arq.linha.formato,
    bytes_mestre: arq.linha.bytes_mestre,
    bytes_miniatura: arq.linha.bytes_miniatura,
    bytes_exibicao: arq.linha.bytes_exibicao,
  });
  return { arq, linha };
}

const verificar = (amb, raiz, extra = {}) => M().verificarArmazenamento(amb.pool, { diretorio: raiz, agora: () => AGORA, ...extra });
const achado = (relatorio, imagemId, escopo) => relatorio.imagens.find((i) => i.imagemId === String(imagemId) && i.escopo === escopo);

describe('[INT-VER] verificador contra PostgreSQL real (schema temporário)', () => {
  test('INT-VER-01 — cenário completo nas tabelas reais: íntegras, ausente, corrompida, órfã e estranha são classificadas, e o veredito é o pior', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      const integraA = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const ausenteA = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA, ausentes: ['miniatura'] });
      const corrompidaA = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const alterado = Buffer.from(corrompidaA.arq.conteudos.exibicao);
      alterado[64] ^= 0x01;
      fs.writeFileSync(corrompidaA.arq.caminho('exibicao'), alterado);
      const padraoOk = await imagemPadrao(amb, raiz, { comExibicao: true });
      const padraoSemMestre = await imagemPadrao(amb, raiz, { ausentes: ['mestre'] });
      const hashOrfao = h.hex64('orfao-integracao');
      h.gravarNaRaiz(raiz, `${empresaA}/${hashOrfao}/mestre.png`, h.conteudoDe('PNG', 'orfao-i'), { agora: AGORA, minutosAtras: 5 * DIA });
      fs.writeFileSync(path.join(raiz, 'LEIAME.txt'), 'estranho');

      const r = await verificar(amb, raiz);

      assert.equal(r.veredito, 'INVESTIGAR');
      assert.deepEqual(r.resumo.registros, { padrao: 2, empresa: 3, total: 5 });
      assert.deepEqual(r.resumo.imagens, { INTEGRO: 2, RECUPERAVEL: 2, INVESTIGAR: 1 });
      assert.equal(r.resumo.arquivos.esperados, 3 + 3 + 3 + 3 + 2);
      assert.equal(achado(r, integraA.linha.id, 'EMPRESA'), undefined);
      assert.equal(achado(r, padraoOk.linha.id, 'PADRAO'), undefined);
      assert.deepEqual(achado(r, ausenteA.linha.id, 'EMPRESA').achados.map((a) => [a.variante, a.tipo]), [['miniatura', 'ARQUIVO_AUSENTE']]);
      assert.deepEqual(achado(r, corrompidaA.linha.id, 'EMPRESA').achados.map((a) => [a.variante, a.tipo]), [['exibicao', 'SHA256_DIVERGENTE']]);
      assert.deepEqual(achado(r, padraoSemMestre.linha.id, 'PADRAO').achados.map((a) => [a.variante, a.tipo]), [['mestre', 'ARQUIVO_AUSENTE']]);
      assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.classe]).sort(), [['ENTRADA_INESPERADA', 'INVESTIGAR'], ['ORFAO_CONJUNTO', 'ORFAO']]);
      assert.equal(r.armazenamento.find((a) => a.tipo === 'ORFAO_CONJUNTO').hash, hashOrfao);
      assert.deepEqual(r.alertas, []);
    });
  });

  test('INT-VER-02 — a transação do verificador é READ ONLY e REPEATABLE READ NO SERVIDOR; um INSERT nessa modalidade seria recusado (25006)', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const observado = [];
      const poolObservado = {
        async connect() {
          const cliente = await amb.pool.connect();
          return {
            async query(texto, params) {
              const resposta = await cliente.query(texto, params);
              if (/^\s*BEGIN/i.test(texto)) {
                const { rows } = await cliente.query("SELECT current_setting('transaction_read_only') AS somente_leitura, current_setting('transaction_isolation') AS isolamento");
                observado.push(rows[0]);
              }
              return resposta;
            },
            release: () => cliente.release(),
          };
        },
        query: (...argumentos) => amb.pool.query(...argumentos),
      };
      await M().verificarArmazenamento(poolObservado, { diretorio: raiz, agora: () => AGORA });
      assert.deepEqual(observado, [{ somente_leitura: 'on', isolamento: 'repeatable read' }]);

      const cliente = await amb.pool.connect();
      try {
        await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await assert.rejects(() => cliente.query("INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ('x', 'x', repeat('a', 64), repeat('b', 64), 'PNG', 256, 256, 1, 1)"), (erro) => erro.code === '25006');
      } finally {
        await cliente.query('ROLLBACK');
        cliente.release();
      }
    });
  });

  test('INT-VER-03 — depois da verificação o banco e o disco estão IDÊNTICOS (linhas, contagens, auditoria, árvore de arquivos)', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA, ausentes: ['mestre'] });
      await imagemPadrao(amb, raiz);
      h.gravarNaRaiz(raiz, `${empresaA}/${h.hex64('sobra-int3')}/mestre.png`, h.conteudoDe('PNG', 'int3'), { agora: AGORA, minutosAtras: 3 * DIA });
      const retrato = async () => {
        const linhas = {};
        for (const tabela of ['imagens_padrao', 'imagens_empresa', 'materiais', 'empresas']) {
          linhas[tabela] = (await amb.q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) AS resumo FROM ${tabela} t`)).rows[0];
        }
        linhas.auditoria = (await amb.q('SELECT count(*)::int AS n FROM logs_auditoria')).rows[0].n;
        return linhas;
      };
      const antesBanco = await retrato();
      const antesDisco = h.retratoDaArvore(raiz);
      await verificar(amb, raiz);
      assert.deepEqual(await retrato(), antesBanco);
      assert.deepEqual(h.retratoDaArvore(raiz), antesDisco);
    });
  });

  test('INT-VER-04 — isolamento por empresa: o arquivo de uma empresa nunca cobre o registro de outra, mesmo com o mesmo SHA-256 de envio', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, empresaB, atorA, atorB } = amb.d;
      const daA = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA, semente: 'compartilhada' });
      const arquivosDeB = h.criarImagemEmpresa(novaRaizSemCriar(), { id: 0, empresaId: empresaB, agora: AGORA, semente: 'compartilhada', ausentes: ['mestre', 'exibicao', 'miniatura'] });
      assert.equal(arquivosDeB.shaEnvio, daA.arq.shaEnvio, 'mesmo SHA-256 de envio nas duas empresas');
      const linhaB = await amb.daEmpresa(empresaB, atorB, {
        sha256: arquivosDeB.linha.sha256, sha256_mestre: arquivosDeB.linha.sha256_mestre, sha256_exibicao: arquivosDeB.linha.sha256_exibicao, sha256_miniatura: arquivosDeB.linha.sha256_miniatura,
        formato: 'PNG', bytes_mestre: arquivosDeB.linha.bytes_mestre, bytes_exibicao: arquivosDeB.linha.bytes_exibicao, bytes_miniatura: arquivosDeB.linha.bytes_miniatura,
      });
      const r = await verificar(amb, raiz);
      assert.equal(achado(r, daA.linha.id, 'EMPRESA'), undefined, 'a imagem da empresa A está íntegra');
      const deB = achado(r, linhaB.id, 'EMPRESA');
      assert.equal(deB.empresaId, empresaB);
      assert.deepEqual(deB.achados.map((a) => [a.variante, a.tipo]), [['mestre', 'ARQUIVO_AUSENTE'], ['exibicao', 'ARQUIVO_AUSENTE'], ['miniatura', 'ARQUIVO_AUSENTE']]);
      assert.ok(deB.achados.every((a) => a.chave.startsWith(`${empresaB}/`)), 'a chave de B nunca aponta para a pasta de A');
    });
  });

  test('INT-VER-05 — a paginação por chave cobre todos os registros reais (página de 2), sem repetir nem pular', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      for (let i = 0; i < 5; i += 1) await imagemPadrao(amb, raiz);
      for (let i = 0; i < 7; i += 1) await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const r = await verificar(amb, raiz, { tamanhoDaPagina: 2 });
      assert.equal(r.veredito, 'INTEGRO');
      assert.deepEqual(r.resumo.registros, { padrao: 5, empresa: 7, total: 12 });
      assert.equal(r.resumo.arquivos.integros, 5 * 2 + 7 * 3);
    });
  });

  test('INT-VER-06 — a imagem não íntegra informa quantos materiais a usam (vínculo real em materiais)', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      const quebradaEmpresa = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA, ausentes: ['miniatura'] });
      const quebradaPadrao = await imagemPadrao(amb, raiz, { ausentes: ['mestre'] });
      const integra = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const m1 = await amb.material(empresaA, 'Material 1');
      const m2 = await amb.material(empresaA, 'Material 2');
      const m3 = await amb.material(empresaA, 'Material 3');
      const m4 = await amb.material(empresaA, 'Material 4');
      await amb.q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [quebradaEmpresa.linha.id, m1]);
      await amb.q('UPDATE materiais SET imagem_padrao_id = $1 WHERE id = ANY($2::int[])', [quebradaPadrao.linha.id, [m2, m3]]);
      await amb.q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [integra.linha.id, m4]);
      const r = await verificar(amb, raiz);
      assert.equal(achado(r, quebradaPadrao.linha.id, 'PADRAO').materiaisEmUso, 2);
      assert.equal(achado(r, quebradaEmpresa.linha.id, 'EMPRESA').materiaisEmUso, 1);
      assert.equal(achado(r, integra.linha.id, 'EMPRESA'), undefined, 'a íntegra, mesmo em uso, não é listada');
    });
  });

  test('INT-VER-07 — arquivos de uma empresa que não existe na tabela real `empresas` são INVESTIGAR; os de empresa existente são só sobra', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, empresaB, atorA } = amb.d;
      await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      h.gravarNaRaiz(raiz, `${empresaB}/${h.hex64('empresa-b-sem-registro')}/mestre.png`, h.conteudoDe('PNG', 'b'), { agora: AGORA, minutosAtras: 3 * DIA });
      h.gravarNaRaiz(raiz, `987654/${h.hex64('empresa-fantasma-int')}/mestre.png`, h.conteudoDe('PNG', 'f'), { agora: AGORA, minutosAtras: 3 * DIA });
      const r = await verificar(amb, raiz);
      assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.classe, a.empresaId]).sort(), [['ORFAO_CONJUNTO', 'ORFAO', empresaB], ['ORFAO_EMPRESA_INEXISTENTE', 'INVESTIGAR', 987654]].sort());
      assert.equal(r.veredito, 'INVESTIGAR');
    });
  });

  test('INT-VER-08 — o COMANDO real (processo Node, pool e saída de verdade) no banco de testes: 4 com arquivo ausente, 0 depois de restaurado; destino conferido pelo OID do servidor', async () => {
    await comAmbiente(async ({ amb, raiz }) => {
      const { empresaA, atorA } = amb.d;
      await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const ausente = await imagemDaEmpresa(amb, raiz, { empresaId: empresaA, criadoPor: atorA, ausentes: ['miniatura'] });
      const { rows } = await amb.q('SELECT (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid');
      const oid = rows[0].oid;
      const script = path.join(__dirname, '..', '..', 'scripts', 'imagens-verificar.js');
      const ambiente = {
        PATH: process.env.PATH,
        DB_HOST: process.env.DB_HOST,
        DB_PORT: process.env.DB_PORT,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_NAME: BANCO_DE_TESTE,
        PGOPTIONS: `-c search_path=${amb.schema}`,
        IMAGENS_ARMAZENAMENTO_DIRETORIO: raiz,
      };
      const executar = (...argumentos) => spawnSync(process.execPath, [script, ...argumentos], { encoding: 'utf8', timeout: 60000, env: ambiente });
      const limpo = (r) => {
        const texto = `${r.stdout}${r.stderr}`;
        assert.equal(texto.includes(raiz), false, 'a saída leva caminho absoluto');
        if (process.env.DB_PASSWORD) assert.equal(texto.includes(process.env.DB_PASSWORD), false, 'a saída leva a senha do banco');
      };

      const semDestino = executar();
      assert.equal(semDestino.status, 4, semDestino.stderr);
      assert.match(semDestino.stdout, new RegExp(`Banco conferido pela conexão: ${BANCO_DE_TESTE} \\(oid ${oid}\\); destino NÃO confirmado`));
      assert.match(semDestino.stdout, /PODE SER RECUPERADO \(1\)/);
      assert.match(semDestino.stdout, new RegExp(`empresa ${empresaA} · imagem ${ausente.linha.id} · miniatura: ARQUIVO_AUSENTE`));
      limpo(semDestino);

      const comDestino = executar('--banco-autorizado', BANCO_DE_TESTE, '--banco-oid', oid);
      assert.equal(comDestino.status, 4, comDestino.stderr);
      assert.match(comDestino.stdout, /destino autorizado confere/);

      const destinoErrado = executar('--banco-autorizado', BANCO_DE_TESTE, '--banco-oid', '1');
      assert.equal(destinoErrado.status, 2);
      assert.match(destinoErrado.stderr, /DESTINO_NAO_AUTORIZADO/);
      assert.equal(destinoErrado.stdout, '', 'nada foi verificado');
      limpo(destinoErrado);

      const emJson = executar('--json');
      assert.equal(emJson.status, 4);
      const documento = JSON.parse(emJson.stdout);
      assert.equal(documento.relatorio.veredito, 'RECUPERAVEL');
      assert.deepEqual(documento.banco, { nome: BANCO_DE_TESTE, oid });

      // Restaurar o arquivo ausente (no diretório temporário do teste) leva o comando a 0: é assim que se confere a correspondência registro × arquivo depois de uma recuperação.
      h.gravarNaRaiz(raiz, ausente.arq.chaves.miniatura, ausente.arq.conteudos.miniatura, { agora: AGORA });
      const restaurado = executar();
      assert.equal(restaurado.status, 0, restaurado.stdout);
      assert.match(restaurado.stdout, /Veredito: INTEGRO/);
      limpo(restaurado);
    });
  });

  test('INT-VER-09 — identificarBanco devolve o banco de testes e o OID que o próprio PostgreSQL informa', async () => {
    await comAmbiente(async ({ amb }) => {
      const identificado = await M().identificarBanco(amb.pool);
      const { rows } = await amb.q('SELECT current_database() AS nome, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid');
      assert.deepEqual(identificado, { nome: rows[0].nome, oid: rows[0].oid });
      assert.equal(identificado.nome, 'gestao_epi_teste_local');
      assert.match(identificado.oid, /^[1-9][0-9]*$/);
    });
  });
});

/** Raiz auxiliar (só para montar os bytes de uma imagem sem gravá-los na raiz verificada). */
function novaRaizSemCriar() {
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  return raiz;
}
