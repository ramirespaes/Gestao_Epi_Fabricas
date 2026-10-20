'use strict';

const crypto = require('node:crypto');
const { abrirPoolTemporario } = require('./schema-temporario');
const {
  todasAsMigrations, inserir, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial,
} = require('./entrega-epi');
const { cpfFicticio } = require('../../helpers/cpf-ficticio');

/**
 * Ambiente dos testes de integração da Biblioteca de Imagens (Unidade 3, RED): PostgreSQL real, banco de teste exclusivo
 * (gestao_epi_teste_local, conferido por helpers/banco-de-teste.js), schema temporário exclusivo com TODAS as migrations (090 inclusive) e
 * DROP SCHEMA ... CASCADE ao fim, inclusive em falha. Nada de public, nada de banco persistente, nenhuma das 30 imagens reais: as linhas de
 * `imagens_padrao` são sintéticas e existem só no schema temporário.
 */

const hex = (semente) => crypto.createHash('sha256').update(String(semente)).digest('hex');
let sequencia = 0;
const proximo = () => { sequencia += 1; return sequencia; };

/** Descritor de uma imagem JÁ PROCESSADA (o processamento é de outra unidade): é o que o serviço de registro recebe. */
function descritor(extra = {}) {
  const n = proximo();
  return {
    sha256: hex(`envio-${n}`), sha256Mestre: hex(`mestre-${n}`), sha256Exibicao: hex(`exibicao-${n}`), sha256Miniatura: hex(`miniatura-${n}`),
    formato: 'PNG', largura: 1024, altura: 1024, bytesMestre: 90000, bytesExibicao: 40000, bytesMiniatura: 9000, ...extra,
  };
}

async function abrirAmbienteImagens() {
  const ctx = await abrirPoolTemporario(todasAsMigrations());
  const { pool } = ctx;
  const q = (sql, params) => pool.query(sql, params);
  const d = {};
  try {
    d.empresaA = await criarEmpresa(pool, '11222333000181', 'Empresa A Fictícia');
    d.empresaB = await criarEmpresa(pool, '44555666000162', 'Empresa B Fictícia');
    d.atorA = await criarUsuario(pool, d.empresaA, 'ator-a@example.invalid');
    d.atorA2 = await criarUsuario(pool, d.empresaA, 'ator-a2@example.invalid');
    d.atorB = await criarUsuario(pool, d.empresaB, 'ator-b@example.invalid');
  } catch (erro) {
    await ctx.encerrar();
    throw erro;
  }

  /** Imagem padrão sintética (global). Não cria sugestão nem vínculo algum. */
  // O id das imagens é BIGINT: o driver o devolve como texto decimal, e é assim que ele circula nos contratos (decisão da V7: nunca Number).
  const comIdNumerico = (linha) => linha;
  const padrao = async (extra = {}) => {
    const n = proximo();
    return comIdNumerico(await inserir(pool, 'imagens_padrao', {
      nome: `Imagem padrão ${n}`, arquivo_origem: `padrao-${n}.png`, sha256: hex(`p${n}`), sha256_miniatura: hex(`pn${n}`), formato: 'PNG',
      largura: 1024, altura: 1024, bytes_mestre: 80000, bytes_miniatura: 8000, ...extra,
    }));
  };
  const sugestao = (imagemPadraoId, tipoNome, nivel = 'PRINCIPAL') => inserir(pool, 'imagens_padrao_tipos', {
    imagem_padrao_id: imagemPadraoId, tipo_nome: tipoNome, nivel, aprovado_por: 'V7', aprovado_em: '2026-10-16',
  });
  /** Imagem da empresa inserida DIRETO (sem passar pelo serviço), para montar cenários. */
  const daEmpresa = async (empresaId, criadoPor, extra = {}) => {
    const n = proximo();
    return comIdNumerico(await inserir(pool, 'imagens_empresa', {
      empresa_id: empresaId, nome: `Imagem da empresa ${n}`, sha256: hex(`e${n}`), sha256_mestre: hex(`em${n}`), sha256_exibicao: hex(`ex${n}`),
      sha256_miniatura: hex(`en${n}`), formato: 'PNG', largura: 1024, altura: 1024, bytes_mestre: 90000, bytes_exibicao: 40000, bytes_miniatura: 9000,
      criado_por: criadoPor, ...extra,
    }));
  };
  /** Material com classificação V2 "Outros" (não depende do catálogo de tipos), criado DIRETO no banco. */
  const material = async (empresaId, nome, extra = {}) => criarMaterial(pool, empresaId, `${nome} ${proximo()}`, { exigeCa: true, exigeTamanho: false, ...extra });
  const imagemDoMaterial = async (materialId) => {
    return (await q('SELECT imagem_padrao_id, imagem_empresa_id FROM materiais WHERE id = $1', [materialId])).rows[0];
  };
  const linhaDoMaterial = async (materialId) => (await q('SELECT to_jsonb(m) AS j FROM materiais m WHERE id = $1', [materialId])).rows[0].j;
  const auditoria = async (acao, empresaId) => (await q(
    'SELECT * FROM logs_auditoria WHERE acao = $1 AND empresa_id = $2 ORDER BY id', [acao, empresaId],
  )).rows;
  const todasAuditorias = async () => (await q('SELECT acao, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria ORDER BY id')).rows;
  const contagem = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;
  /** GHE ativo + funcionário ativo vinculado + material previsto por vínculo DIRETO (a regra existente do catálogo do Totem). */
  async function funcionarioComMaterial(empresaId, materiaisIds) {
    const gheId = await criarGhe(pool, empresaId, `GHE ${proximo()}`);
    const funcionarioId = await criarFuncionario(pool, empresaId, { matricula: `M-${proximo()}`, cpf: cpfFicticio(proximo()), gheId });
    for (const materialId of materiaisIds) {
      await inserir(pool, 'ghe_materiais', { empresa_id: empresaId, grupo_homogeneo_id: gheId, material_id: materialId });
    }
    return { gheId, funcionarioId };
  }

  /** Espera, no próprio banco (pg_blocking_pids), até alguma sessão aparecer bloqueada pela transação `bloqueadorPid`. Devolve o pid bloqueado. */
  async function esperarBloqueio(bloqueadorPid) {
    for (let i = 0; i < 300; i += 1) {
      const { rows } = await q('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [bloqueadorPid]);
      if (rows.length > 0) return rows[0].pid;
      await new Promise((r) => { setTimeout(r, 10); });
    }
    throw new Error('nenhuma sessão ficou bloqueada pela transação segurada');
  }

  return { ...ctx, d, q, hex, descritor, padrao, sugestao, daEmpresa, material, imagemDoMaterial, linhaDoMaterial, auditoria, todasAuditorias, contagem, funcionarioComMaterial, esperarBloqueio };
}

/** Classificação V2 mínima que não consulta o catálogo (grupo "Outros" com especificação), para chamar material.service.criar de verdade. */
const CLASSIFICACAO_OUTROS = Object.freeze({
  categoria: 'Outros', categoriaDescricao: 'Item de teste', tipo: 'Outros', tipoDescricao: 'Item de teste',
});

module.exports = { hex, descritor, abrirAmbienteImagens, CLASSIFICACAO_OUTROS };
