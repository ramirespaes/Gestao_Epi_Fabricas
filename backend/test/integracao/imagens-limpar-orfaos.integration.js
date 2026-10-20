'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { abrirAmbienteImagens, CLASSIFICACAO_OUTROS } = require('./helpers/imagem-material');
const { BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const imagemService = require('../../src/services/imagem-material.service');
const materialService = require('../../src/services/material.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { lockDaBiblioteca } = require('../../src/utils/lock-biblioteca-imagens');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED) contra POSTGRESQL REAL. Prova o que o banco falso não prova: que a trava da biblioteca é a MESMA que o envio usa
 * (serialização de verdade entre envio e limpeza), que as transações da limpeza são READ ONLY no servidor, que o registro novo é visto a tempo (READ COMMITTED), que a espera
 * pela trava é limitada e que a limpeza NUNCA altera o banco. Segue o contrato de segurança dos testes de integração: banco de testes exclusivo (gestao_epi_teste_local,
 * conferido pelo helper), schema temporário próprio com TODAS as migrations e DROP SCHEMA ... CASCADE ao fim, inclusive em falha. O armazenamento e a pasta da trava de janela
 * são diretórios temporários exclusivos. Nenhum banco persistente, nenhuma das 30 imagens reais. Contrato do serviço: ver
 * test/services/imagem-armazenamento-limpeza-politica.test.js. As corridas são DETERMINÍSTICAS: sincronizadas por ganchos e por pg_blocking_pids, sem esperar tempo.
 */

const { AGORA, DIA, h } = a;
const NOMES = ['exibicao.webp', 'mestre.png', 'miniatura.webp'];
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

/** Todo teste daqui tem prazo próprio: uma trava que nunca se solta vira FALHA com nome, não um job parado até o limite da integração contínua. */
const teste = (nome, corpo) => test(nome, { timeout: 120000 }, corpo);

const S = () => exigirModulo('src/services/imagem-armazenamento-limpeza.service');
const CLI = () => exigirModulo('scripts/imagens-limpar-orfaos');

/** Armazenamento e pasta da trava de janela exclusivos; o schema temporário só existe durante o corpo do teste. */
async function ambienteBase(corpo) {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  const amb = await abrirAmbienteImagens();
  try {
    await corpo({ amb, raiz, janela: path.join(pastaDaTrava, 'janela-imagens.lock'), outraJanela: path.join(pastaDaTrava, 'outra-janela.lock') });
  } finally {
    await amb.encerrar();
  }
}
/** O módulo é exigido ANTES de abrir banco e disco: sem implementação o teste falha sem criar nada. */
async function comAmbiente(corpo) {
  S();
  await ambienteBase(corpo);
}

const executar = (amb, c, extra = {}) => S().limparOrfaos(amb.pool, {
  diretorio: c.raiz, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, janela: { arquivo: c.janela }, ...extra,
});
const simular = (amb, c, extra = {}) => S().limparOrfaos(amb.pool, { diretorio: c.raiz, agora: () => AGORA, ...extra });
const verificar = (amb, c) => verificador.verificarArmazenamento(amb.pool, { diretorio: c.raiz, agora: () => AGORA });

let sequencia = 0;
/** Semente única por imagem: o SHA-256 de cada uma precisa ser distinto (restrições de unicidade do banco). */
const semente = (prefixo) => { sequencia += 1; return `${prefixo}-limpeza-integracao-${sequencia}`; };

/** Imagem REGISTRADA de verdade: arquivos na raiz temporária e linha real no schema temporário. */
async function registrada(amb, raiz, { empresaId, criadoPor, ...opcoes }) {
  const arq = h.criarImagemEmpresa(raiz, { id: 0, empresaId, semente: semente('r'), agora: AGORA, ...opcoes });
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

/** Linha de registro (colunas do INSERT) que cobre um conjunto órfão já gravado em disco. */
function colunasQueCobrem(orfao) {
  const { id, empresa_id: _empresa, estado, ...colunas } = a.linhaQueCobre(orfao, { id: 1 });
  return colunas;
}

/** Retrato do banco (contagem e resumo MD5 de cada tabela que a limpeza poderia, por engano, alterar). */
async function retratoDoBanco(amb) {
  const resultado = {};
  for (const tabela of ['empresas', 'imagens_empresa', 'imagens_padrao', 'materiais', 'logs_auditoria']) {
    const { rows } = await amb.q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, ',' ORDER BY id), '')) AS resumo FROM ${tabela} t`);
    resultado[tabela] = rows[0];
  }
  return resultado;
}

const INICIO_DE_TRANSACAO = /^(?:BEGIN|START TRANSACTION)\b/i;
const FIM_DE_TRANSACAO = /^(?:COMMIT|ROLLBACK|END|ABORT)\b/i;

/**
 * Pool que observa, NO SERVIDOR, o modo e o isolamento EFETIVOS de cada transação que abre — amostrados logo antes do COMMIT/ROLLBACK, então valem qualquer que seja a forma
 * de abrir (BEGIN com modificadores, START TRANSACTION, SET TRANSACTION depois) — e guarda o texto dos comandos. Terminador sem transação aberta não é amostrado, e uma amostra
 * que falha (transação abortada) nunca impede o terminador de rodar.
 */
function observar(pool) {
  const observado = [];
  const comandos = [];
  return {
    observado,
    comandos,
    pool: {
      async connect() {
        const cliente = await pool.connect();
        let aberta = false;
        return {
          async query(texto, params) {
            const sql = String(texto).replace(/\s+/g, ' ').trim();
            comandos.push(sql);
            if (aberta && FIM_DE_TRANSACAO.test(sql)) {
              aberta = false;
              try {
                const { rows } = await cliente.query("SELECT current_setting('transaction_read_only') AS somente_leitura, current_setting('transaction_isolation') AS isolamento");
                observado.push(rows[0]);
              } catch {
                observado.push({ amostra: 'indisponível' });
              }
            }
            const resposta = await cliente.query(texto, params);
            if (INICIO_DE_TRANSACAO.test(sql)) aberta = true;
            return resposta;
          },
          release: () => cliente.release(),
        };
      },
      query: (...argumentos) => pool.query(...argumentos),
    },
  };
}

/** PID da única sessão que segura, agora, uma trava advisory concedida neste banco (a do envio ou a da limpeza). */
async function pidQueSeguraATrava(amb) {
  const { rows } = await amb.q("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
  assert.equal(rows.length, 1, 'exatamente uma sessão deveria segurar a trava advisory');
  return rows[0].pid;
}

async function esperarErro(promessa, status, codigo) {
  await assert.rejects(promessa, (e) => { assert.equal(e.status, status, `${e.status} ${e.codigo}`); assert.equal(e.codigo, codigo); return true; });
}
const hashes = (lista) => lista.map((x) => x.hash).sort();

describe('[INT-LMP] o apoio em PostgreSQL real (verde desde o início): o verificador existente classifica o cenário como esperado', () => {
  teste('INT-LMP-01 — cenário nas tabelas reais: imagem ativa, inativa e vinculada a material, órfãos (antigo, recente, com o MESMO hash em outra empresa) e temporário — o verificador diz o que o cenário promete', async () => {
    await ambienteBase(async ({ amb, raiz }) => {
      const { empresaA, empresaB, atorA } = amb.d;
      const a1 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const a2 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      await imagemService.inativar(amb.pool, { empresaId: empresaA, atorId: atorA, imagemId: a2.linha.id });
      const a3 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      await materialService.criar(amb.pool, {
        empresaId: empresaA, atorId: atorA, nome: 'Material com a foto', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: a3.linha.id },
      });
      const orfaA = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('oa'), idadeMin: 3 * DIA });
      const orfaB = a.criarOrfao(raiz, { empresaId: empresaB, semente: semente('ob'), hash: a1.arq.shaEnvio, idadeMin: 3 * DIA });
      const recente = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('or'), idadeMin: 5 });
      const tmp = a.criarTemporario(raiz, { empresaId: empresaA, hash: a1.arq.shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA });
      const r = await verificar(amb, { raiz });
      assert.equal(r.veredito, 'ORFAO');
      assert.deepEqual(r.resumo.registros, { padrao: 0, empresa: 3, total: 3 });
      assert.deepEqual(r.resumo.imagens, { INTEGRO: 3, RECUPERAVEL: 0, INVESTIGAR: 0 });
      const antigos = r.armazenamento.filter((s) => !s.recente).map((s) => [s.tipo, s.empresaId, s.hash]).sort();
      assert.deepEqual(antigos, [['ORFAO_CONJUNTO', empresaA, orfaA.hash], ['ORFAO_CONJUNTO', empresaB, orfaB.hash], ['TEMPORARIO_RESIDUAL', empresaA, a1.arq.shaEnvio]].sort());
      assert.deepEqual(r.armazenamento.filter((s) => s.recente).map((s) => s.hash), [recente.hash]);
      assert.equal(tmp.nome.endsWith('.tmp'), true);
    });
  });
});

describe('[INT-LMP] execução e simulação sobre o banco real', () => {
  teste('INT-LMP-02 — execução completa: remove SÓ os órfãos antigos e o temporário (inclusive o órfão da empresa B com o MESMO hash de uma imagem da A), poupa a ativa, a inativa, a vinculada a material e o recente; o banco não muda um byte; o verificador fecha INTEGRO', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, empresaB, atorA } = amb.d;
      const a1 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const a2 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      await imagemService.inativar(amb.pool, { empresaId: empresaA, atorId: atorA, imagemId: a2.linha.id });
      const a3 = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      await materialService.criar(amb.pool, {
        empresaId: empresaA, atorId: atorA, nome: 'Material com a foto', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: a3.linha.id },
      });
      for (const imagem of [a1, a2, a3]) for (const variante of ['mestre', 'exibicao', 'miniatura']) a.envelhecer(imagem.arq.caminho(variante), 30 * DIA);
      const orfaA = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('oa'), idadeMin: 3 * DIA });
      const orfaB = a.criarOrfao(raiz, { empresaId: empresaB, semente: semente('ob'), hash: a1.arq.shaEnvio, idadeMin: 3 * DIA });
      const recente = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('or'), idadeMin: 5 });
      const tmp = a.criarTemporario(raiz, { empresaId: empresaA, hash: a1.arq.shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA });
      const preservadas = [a1, a2, a3].map((imagem) => h.retratoDaArvore(path.join(raiz, imagem.arq.pasta)));
      const bancoAntes = await retratoDoBanco(amb);

      const r = await executar(amb, c);

      assert.equal(r.recusa, null);
      assert.equal(r.veredito, 'ORFAO');
      assert.deepEqual(r.removidos.map((x) => [x.tipo, x.empresaId, x.hash]).sort(),
        [['ORFAO_CONJUNTO', empresaA, orfaA.hash], ['ORFAO_CONJUNTO', empresaB, orfaB.hash], ['TEMPORARIO_RESIDUAL', empresaA, a1.arq.shaEnvio]].sort());
      assert.deepEqual([r.falhas, r.ignorados], [[], []]);
      assert.equal(orfaA.existe() || orfaB.existe(), false);
      assert.equal(fs.existsSync(tmp.caminho), false);
      assert.equal(recente.existe(), true, 'o recente fica');
      const semOTemporario = preservadas.map((retrato) => retrato.filter((i) => !i.rel.endsWith('.tmp')));
      assert.deepEqual([a1, a2, a3].map((imagem) => h.retratoDaArvore(path.join(raiz, imagem.arq.pasta))), semOTemporario, 'as três imagens registradas ficam como estavam');
      assert.deepEqual(await retratoDoBanco(amb), bancoAntes, 'a limpeza nunca escreve no banco');
      const depois = await verificar(amb, c);
      assert.equal(depois.veredito, 'INTEGRO');
      assert.deepEqual(depois.armazenamento.filter((s) => !s.recente), []);
      assert.equal(fs.existsSync(c.janela), false);
    });
  });

  teste('INT-LMP-03 — a SIMULAÇÃO lê numa transação READ ONLY + REPEATABLE READ NO SERVIDOR, não toma trava advisory, não muda a árvore nem o banco, e o relatório lista o que a execução removeria', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('s'), idadeMin: 3 * DIA });
      const arvoreAntes = h.retratoDaArvore(raiz);
      const bancoAntes = await retratoDoBanco(amb);
      const { pool, observado, comandos } = observar(amb.pool);
      const r = await S().limparOrfaos(pool, { diretorio: raiz, agora: () => AGORA });
      assert.deepEqual(observado, [{ somente_leitura: 'on', isolamento: 'repeatable read' }]);
      assert.equal(comandos.some((sql) => /advisory/i.test(sql)), false);
      assert.deepEqual(r.candidatos.map((x) => x.hash), [orfao.hash]);
      assert.equal(r.modo, 'SIMULACAO');
      assert.deepEqual(h.retratoDaArvore(raiz), arvoreAntes);
      assert.deepEqual(await retratoDoBanco(amb), bancoAntes);
    });
  });

  teste('INT-LMP-04 — na EXECUÇÃO cada conjunto roda numa transação READ ONLY em READ COMMITTED (vê o registro que acabou de ser confirmado) e toma a trava da biblioteca da empresa; nenhuma é de escrita', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('x1'), idadeMin: 3 * DIA });
      a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('x2'), idadeMin: 3 * DIA });
      const { pool, observado, comandos } = observar(amb.pool);
      const r = await S().limparOrfaos(pool, {
        diretorio: raiz, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, janela: { arquivo: c.janela },
      });
      assert.equal(r.removidos.length, 2);
      assert.deepEqual(observado, [
        { somente_leitura: 'on', isolamento: 'repeatable read' },
        { somente_leitura: 'on', isolamento: 'read committed' },
        { somente_leitura: 'on', isolamento: 'read committed' },
      ]);
      assert.equal(comandos.filter((sql) => /advisory/i.test(sql)).length, 2, 'uma trava por conjunto');
      for (const sql of comandos) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    });
  });

  teste('INT-LMP-05 — banco que NÃO parece o certo (nenhuma imagem registrada, órfãos antigos no disco): a execução é RECUSADA e nada é apagado — a rede de proteção contra apontar a limpeza para o banco errado', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const orfao = a.criarOrfao(raiz, { empresaId: amb.d.empresaA, semente: semente('banco-errado'), idadeMin: 30 * DIA });
      const r = await executar(amb, c);
      assert.equal(r.recusa?.codigo, 'ARMAZENAMENTO_NAO_CONFIAVEL');
      assert.deepEqual(r.alertas, ['BANCO_SEM_REGISTROS_COM_ARQUIVOS']);
      assert.equal(orfao.existe(), true);
      assert.equal(fs.existsSync(c.janela), false);
    });
  });
});

describe('[INT-LMP] concorrência com o ENVIO: a mesma trava da biblioteca, nos dois sentidos', () => {
  teste('INT-LMP-06 — um envio ADOTA o conjunto órfão enquanto a limpeza o alcança: a limpeza ESPERA a trava, vê o registro confirmado e IGNORA (REGISTRO_APARECEU); os arquivos ficam e o verificador fecha INTEGRO', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('c1'), idadeMin: 3 * DIA });
      let abrirPortao;
      const portao = new Promise((resolver) => { abrirPortao = resolver; });
      let envioDentro;
      const dentro = new Promise((resolver) => { envioDentro = resolver; });
      const envio = imagemService.registrarEmpresa(amb.pool, {
        empresaId: empresaA, atorId: atorA, nome: 'Foto adotada', imagem: a.descritorQueCobre(orfao), antesDeInserir: async () => { envioDentro(); await portao; },
      });
      envio.catch(() => {});
      let limpeza = null;
      try {
        await Promise.race([dentro, envio]);
        limpeza = executar(amb, c, { tempoMaximoDaTravaMs: 30000 });
        limpeza.catch(() => {});
        await amb.esperarBloqueio(await pidQueSeguraATrava(amb));
        assert.deepEqual(orfao.nomes(), NOMES, 'enquanto espera, a limpeza não removeu nada');
      } finally {
        abrirPortao();
        await Promise.allSettled([envio, limpeza]);
      }
      const [resultadoDoEnvio, resultadoDaLimpeza] = await Promise.all([envio, limpeza]);
      assert.equal(resultadoDoEnvio.reaproveitada, false, 'o envio registrou a imagem');
      assert.deepEqual(resultadoDaLimpeza.ignorados, [{ empresaId: empresaA, hash: orfao.hash, tipo: 'ORFAO_CONJUNTO', motivo: 'REGISTRO_APARECEU' }]);
      assert.deepEqual(resultadoDaLimpeza.removidos, []);
      assert.deepEqual(orfao.nomes(), NOMES);
      assert.equal((await verificar(amb, c)).veredito, 'INTEGRO');
    });
  });

  teste('INT-LMP-07 — a LIMPEZA já segura a trava quando chega um envio do mesmo conteúdo: o envio ESPERA, a limpeza remove, e o envio então regrava os arquivos e registra — nunca sobra "registro sem arquivo"', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('c2'), idadeMin: 3 * DIA });
      const armazenamento = criarArmazenamentoImagens({ diretorio: raiz });
      const gravarVariantes = async () => {
        for (const nome of NOMES) await armazenamento.gravar(`${empresaA}/${orfao.hash}/${nome}`, orfao.conteudos[nome], { maxBytes: 1024 * 1024, sha256Esperado: h.sha(orfao.conteudos[nome]) });
      };
      let envio = null;
      const ganchos = {
        aposTravar: async () => {
          envio = imagemService.registrarEmpresa(amb.pool, { empresaId: empresaA, atorId: atorA, nome: 'Reenvio durante a limpeza', imagem: a.descritorQueCobre(orfao), antesDeInserir: gravarVariantes });
          envio.catch(() => {});
          await amb.esperarBloqueio(await pidQueSeguraATrava(amb));
          assert.deepEqual(orfao.nomes(), NOMES, 'o envio espera: nada foi regravado nem removido ainda');
        },
      };
      let resultadoDaLimpeza;
      try {
        resultadoDaLimpeza = await executar(amb, c, { ganchos });
      } finally {
        await Promise.allSettled([envio]);
      }
      const resultadoDoEnvio = await envio;
      assert.deepEqual(hashes(resultadoDaLimpeza.removidos), [orfao.hash]);
      assert.equal(resultadoDoEnvio.reaproveitada, false);
      assert.deepEqual(orfao.nomes(), NOMES, 'o envio regravou os três arquivos depois da remoção');
      const depois = await verificar(amb, c);
      assert.equal(depois.veredito, 'INTEGRO');
      assert.deepEqual(depois.resumo.imagens, { INTEGRO: 2, RECUPERAVEL: 0, INVESTIGAR: 0 });
    });
  });

  teste('INT-LMP-08 — a espera pela trava é LIMITADA: com a trava da empresa A ocupada por outra transação, a limpeza desiste do conjunto da A (TRAVA_OCUPADA, nada removido), segue com o da empresa B (trava independente) e uma nova execução remove o da A', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, empresaB, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfaA = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('c3a'), idadeMin: 3 * DIA });
      const orfaB = a.criarOrfao(raiz, { empresaId: empresaB, semente: semente('c3b'), idadeMin: 3 * DIA });
      const ocupante = await amb.pool.connect();
      await ocupante.query('BEGIN');
      await ocupante.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaA)]);
      try {
        const inicio = Date.now();
        const r = await executar(amb, c, { tempoMaximoDaTravaMs: 300 });
        assert.ok(Date.now() - inicio < 15000, 'a limpeza não pode ficar esperando para sempre');
        assert.deepEqual(r.ignorados, [{ empresaId: empresaA, hash: orfaA.hash, tipo: 'ORFAO_CONJUNTO', motivo: 'TRAVA_OCUPADA' }]);
        assert.deepEqual(hashes(r.removidos), [orfaB.hash]);
        assert.deepEqual(r.falhas, []);
        assert.deepEqual(orfaA.nomes(), NOMES);
        assert.equal(orfaB.existe(), false);
      } finally {
        await ocupante.query('ROLLBACK');
        ocupante.release();
      }
      const segunda = await executar(amb, c);
      assert.deepEqual(hashes(segunda.removidos), [orfaA.hash]);
    });
  });

  teste('INT-LMP-09 — um registro CONFIRMADO por outra conexão entre o plano e a trava é visto (READ COMMITTED): REGISTRO_APARECEU, arquivos intactos', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('c5'), idadeMin: 3 * DIA });
      const r = await executar(amb, c, { ganchos: { aposPlanejar: async () => { await amb.daEmpresa(empresaA, atorA, colunasQueCobrem(orfao)); } } });
      assert.deepEqual(r.ignorados.map((x) => [x.hash, x.motivo]), [[orfao.hash, 'REGISTRO_APARECEU']]);
      assert.deepEqual(r.removidos, []);
      assert.deepEqual(orfao.nomes(), NOMES);
    });
  });

  teste('INT-LMP-10 — duas limpezas que se atropelam (sem a trava de arquivo, só a do banco): a segunda espera, encontra o conjunto já removido e o trata como JA_REMOVIDO, sem falha e sem remover duas vezes', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('c6'), idadeMin: 3 * DIA });
      let segunda = null;
      let primeira;
      try {
        primeira = await executar(amb, c, { ganchos: {
          aposTravar: async () => {
            segunda = executar(amb, { ...c, janela: c.outraJanela }, { tempoMaximoDaTravaMs: 30000 });
            segunda.catch(() => {});
            await amb.esperarBloqueio(await pidQueSeguraATrava(amb));
          },
        } });
      } finally {
        await Promise.allSettled([segunda]);
      }
      const resultadoDaSegunda = await segunda;
      assert.deepEqual(hashes(primeira.removidos), [orfao.hash]);
      assert.deepEqual(resultadoDaSegunda.removidos, []);
      assert.deepEqual(resultadoDaSegunda.ignorados.map((x) => [x.hash, x.motivo]), [[orfao.hash, 'JA_REMOVIDO']]);
      assert.deepEqual(resultadoDaSegunda.falhas, []);
      assert.equal(orfao.existe(), false);
    });
  });
});

describe('[INT-LMP] ciclo de vida: excluir pela API deixa os arquivos; só a limpeza os remove, e nunca com a imagem em uso', () => {
  teste('INT-LMP-11 — imagem em uso: excluir é 409 IMAGEM_EM_USO e a limpeza não toca em nada; solta do material e excluída, a linha some e os arquivos FICAM; só então a limpeza (órfão antigo) os remove', async () => {
    await comAmbiente(async (c) => {
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const alvo = await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      for (const variante of ['mestre', 'exibicao', 'miniatura']) a.envelhecer(alvo.arq.caminho(variante), 5 * DIA);
      const material = await materialService.criar(amb.pool, {
        empresaId: empresaA, atorId: atorA, nome: 'Material do ciclo', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: alvo.linha.id },
      });
      const excluir = () => imagemService.excluir(amb.pool, { empresaId: empresaA, atorId: atorA, imagemId: alvo.linha.id, confirmacao: true });
      const arquivos = () => ['mestre', 'exibicao', 'miniatura'].map((v) => fs.existsSync(alvo.arq.caminho(v)));

      await esperarErro(excluir(), 409, 'IMAGEM_EM_USO');
      const emUso = await executar(amb, c);
      assert.deepEqual([emUso.candidatos, emUso.removidos], [[], []]);
      assert.deepEqual(arquivos(), [true, true, true]);

      await materialService.alterar(amb.pool, { empresaId: empresaA, atorId: atorA, materialId: material.id, imagem: null });
      assert.deepEqual(await excluir(), { excluida: true, imagemId: alvo.linha.id });
      assert.deepEqual(arquivos(), [true, true, true], 'excluir pela API remove só a linha: os arquivos ficam');
      const orfaos = await simular(amb, c);
      assert.deepEqual(orfaos.candidatos.map((x) => [x.tipo, x.hash]), [['ORFAO_CONJUNTO', alvo.arq.shaEnvio]]);

      const limpeza = await executar(amb, c);
      assert.deepEqual(hashes(limpeza.removidos), [alvo.arq.shaEnvio]);
      assert.deepEqual(arquivos(), [false, false, false]);
      assert.equal((await verificar(amb, c)).veredito, 'INTEGRO');
    });
  });
});

describe('[INT-LMP] o comando contra o banco real: o destino é conferido na conexão', () => {
  teste('INT-LMP-12 — com o banco e o OID que o PostgreSQL informa, a execução prossegue e remove; com OID errado, saída 2 (DESTINO_NAO_AUTORIZADO) e NADA é lido nem removido', async () => {
    await comAmbiente(async (c) => {
      CLI();
      const { amb, raiz } = c;
      const { empresaA, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const certo = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('d1'), idadeMin: 3 * DIA });
      const banco = await verificador.identificarBanco(amb.pool);
      assert.equal(banco.nome, BANCO_DE_TESTE);
      const opcoes = (destino) => ({ json: false, executar: true, retencaoMinutos: 1440, intervaloBackupMinutos: 60, limite: 50, destino });
      const linhas = [];
      const saida = { log: (...p) => linhas.push(p.join(' ')), error: (...p) => linhas.push(p.join(' ')) };
      const dependencias = { pool: amb.pool, diretorio: raiz, janelaArquivo: c.janela, saida, agora: () => AGORA };

      const errado = await CLI().executarComando(opcoes({ banco: banco.nome, oid: String(Number(banco.oid) + 1) }), dependencias);
      assert.equal(errado.saida, 2);
      assert.match(linhas.join('\n'), /DESTINO_NAO_AUTORIZADO/);
      assert.equal(certo.existe(), true);

      const bom = await CLI().executarComando(opcoes({ banco: banco.nome, oid: banco.oid }), dependencias);
      assert.equal(bom.saida, 0);
      assert.equal(certo.existe(), false);
      assert.equal(a.saidaLimpa(linhas.join('\n'), raiz), true);
    });
  });
});

describe('[INT-LMP] apoio da maquinaria das corridas (verde desde o início: não dependem do módulo novo)', () => {
  teste('INT-LMP-13 — o observador enxerga NO SERVIDOR o modo e o isolamento efetivos de cada transação, qualquer que seja a forma de abrir, ignora terminador sem transação e nunca impede o terminador de rodar', async () => {
    await ambienteBase(async ({ amb }) => {
      const { pool, observado, comandos } = observar(amb.pool);
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await cliente.query('SELECT 1');
        await cliente.query('COMMIT');
        await cliente.query('START TRANSACTION');
        await cliente.query('SET TRANSACTION READ ONLY');
        await cliente.query('ROLLBACK');
        await cliente.query('ROLLBACK');
        await cliente.query('BEGIN');
        await assert.rejects(cliente.query('SELECT 1 FROM tabela_que_nao_existe_na_limpeza'));
        await cliente.query('ROLLBACK');
        assert.equal((await cliente.query('SELECT 1 AS ok')).rows[0].ok, 1, 'o terminador rodou e a conexão voltou ao normal');
      } finally {
        cliente.release();
      }
      assert.deepEqual(observado, [
        { somente_leitura: 'on', isolamento: 'repeatable read' },
        { somente_leitura: 'on', isolamento: 'read committed' },
        { amostra: 'indisponível' },
      ]);
      assert.equal(comandos.filter((sql) => /^ROLLBACK/.test(sql)).length, 3);
    });
  });

  teste('INT-LMP-14 — o envio SEGURA a trava da biblioteca da empresa enquanto espera no gancho: uma só sessão a detém (e é a chave da empresa), quem tenta a mesma trava fica bloqueado por ela, a trava de OUTRA empresa fica livre e, ao abrir o portão, o envio conclui', async () => {
    await ambienteBase(async ({ amb, raiz }) => {
      const { empresaA, empresaB, atorA } = amb.d;
      await registrada(amb, raiz, { empresaId: empresaA, criadoPor: atorA });
      const orfao = a.criarOrfao(raiz, { empresaId: empresaA, semente: semente('ap14'), idadeMin: 3 * DIA });
      let abrirPortao;
      const portao = new Promise((resolver) => { abrirPortao = resolver; });
      let envioDentro;
      const dentro = new Promise((resolver) => { envioDentro = resolver; });
      const envio = imagemService.registrarEmpresa(amb.pool, {
        empresaId: empresaA, atorId: atorA, nome: 'Foto do apoio', imagem: a.descritorQueCobre(orfao), antesDeInserir: async () => { envioDentro(); await portao; },
      });
      envio.catch(() => {});
      let espera = null;
      let outro = null;
      try {
        await Promise.race([dentro, envio]);
        const detentor = await pidQueSeguraATrava(amb);
        const { rows } = await amb.q("SELECT ((classid::bigint << 32) | objid::bigint)::text AS chave FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = $1", [detentor]);
        assert.deepEqual(rows, [{ chave: lockDaBiblioteca(empresaA) }], 'a trava detida é a da biblioteca da empresa A');
        outro = await amb.pool.connect();
        await outro.query('BEGIN');
        await outro.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaB)]);
        espera = outro.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaA)]);
        espera.catch(() => {});
        await amb.esperarBloqueio(detentor);
        assert.deepEqual(orfao.nomes(), NOMES, 'enquanto o envio espera no gancho, nada foi regravado nem removido');
      } finally {
        abrirPortao();
        await Promise.allSettled([envio, espera]);
        if (outro !== null) {
          await outro.query('ROLLBACK').catch(() => {});
          outro.release();
        }
      }
      assert.equal((await envio).reaproveitada, false);
    });
  });
});
