'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

/**
 * Fixtures da entrega de EPI direto no banco, para os testes das migrations
 * 057 a 060. Cada função recebe um executor (Client ou Pool do pg): com um
 * Pool, o que precisa de transação pega uma conexão só para ela. Os testes
 * montam o schema com todas as migrations do diretório, então sem as
 * migrations da entrega eles falham pelo motivo certo. Só dados fictícios;
 * o IP é de faixa reservada para documentação.
 */

const DIRETORIO = path.join(__dirname, '..', '..', '..', 'migrations');
const HASH = 'b'.repeat(64);

// O mesmo SQL que o serviço da ficha vai usar (10C/10D): o ROLLBACK desfaz o
// incremento, então não sobra lacuna.
const SQL_PROXIMO_NUMERO_DA_FICHA = `
  INSERT INTO fichas_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, 1)
  ON CONFLICT (empresa_id) DO UPDATE SET ultimo_numero = fichas_epi_numeracao.ultimo_numero + 1
  RETURNING ultimo_numero`;

function todasAsMigrations() {
  return fs.readdirSync(DIRETORIO)
    .map((nome) => nome.match(/^(\d{3})_.*\.sql$/)?.[1])
    .filter((prefixo) => prefixo !== undefined)
    .sort();
}

async function erroDe(promessa) {
  try {
    await promessa;
    return null;
  } catch (erro) {
    return { code: erro.code, constraint: erro.constraint, message: erro.message };
  }
}

async function comCliente(executor, fn) {
  if (!(executor instanceof Pool)) return fn(executor);
  const cliente = await executor.connect();
  try {
    return await fn(cliente);
  } finally {
    cliente.release();
  }
}

async function transacao(executor, fn) {
  return comCliente(executor, async (cliente) => {
    await cliente.query('BEGIN');
    try {
      const resultado = await fn(cliente);
      await cliente.query('COMMIT');
      return resultado;
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    }
  });
}

// Tabela e colunas vêm sempre do próprio teste; os valores vão por parâmetro.
async function inserir(executor, tabela, valores) {
  const colunas = Object.keys(valores);
  const marcadores = colunas.map((_, i) => `$${i + 1}`);
  const { rows } = await executor.query(
    `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcadores.join(', ')}) RETURNING *`,
    Object.values(valores),
  );
  return rows[0];
}

async function criarEmpresa(executor, cnpj, nome) {
  const empresa = await inserir(executor, 'empresas', {
    nome, cnpj, endereco: 'Rua Fictícia, 100', cidade: 'Cidade Fictícia', uf: 'SP',
  });
  return empresa.id;
}

async function criarUsuario(executor, empresaId, email) {
  const usuario = await inserir(executor, 'usuarios', {
    empresa_id: empresaId, nome: 'Responsável Fictício', email, senha_hash: 'hash-de-teste', perfil: 'MASTER',
  });
  return usuario.id;
}

async function criarGhe(executor, empresaId, nome) {
  return (await inserir(executor, 'grupos_homogeneos_exposicao', { empresa_id: empresaId, nome })).id;
}

async function criarFuncionario(executor, empresaId, {
  matricula, cpf, gheId = null, ativo = true, setor = null, funcao = null,
}) {
  const funcionario = await inserir(executor, 'funcionarios', {
    empresa_id: empresaId, matricula, nome: `Trabalhador ${matricula}`, cpf, grupo_homogeneo_id: gheId, ativo, setor, funcao,
  });
  return funcionario.id;
}

async function criarMaterial(executor, empresaId, nome, {
  exigeCa = true, exigeTamanho = true, prazo = 180, tipo = null, oculosComGrau = null, codigoInterno = null, unidade = 'unidade', ativo = true,
} = {}) {
  const material = await inserir(executor, 'materiais', {
    empresa_id: empresaId, nome, exige_ca: exigeCa, exige_tamanho: exigeTamanho, prazo_uso_dias: prazo,
    tipo, oculos_com_grau: oculosComGrau, codigo_interno: codigoInterno, unidade, ativo,
  });
  return material.id;
}

// Lote de saldo inicial, com a sua operação, numa transação própria. CA e
// tamanho podem ser null: o saldo inicial aceita os dois.
async function criarLote(executor, {
  empresaId, materialId, quantidade, tamanho = '40', caNumero = '12345', caValidade = '2099-12-31',
}) {
  return transacao(executor, async (c) => {
    const lote = await inserir(c, 'estoque_lotes', {
      empresa_id: empresaId, material_id: materialId, tamanho, ca_numero: caNumero, ca_validade: caValidade,
      origem: 'SALDO_INICIAL', quantidade_entrada: quantidade,
    });
    await inserir(c, 'estoque_operacoes', {
      empresa_id: empresaId, lote_id: lote.id, tipo: 'SALDO_INICIAL', quantidade,
    });
    return lote.id;
  });
}

async function proximoNumeroDaFicha(executor, empresaId) {
  return (await executor.query(SQL_PROXIMO_NUMERO_DA_FICHA, [empresaId])).rows[0].ultimo_numero;
}

async function criarFicha(executor, empresaId, funcionarioId) {
  return transacao(executor, async (c) => {
    const numero = await proximoNumeroDaFicha(c, empresaId);
    return inserir(c, 'fichas_epi', { empresa_id: empresaId, numero, funcionario_id: funcionarioId });
  });
}

function inserirEntrega(executor, valores) {
  return inserir(executor, 'entregas_epi', {
    origem: 'DIRETA',
    chave_idempotencia: crypto.randomUUID(),
    requisicao_hash: HASH,
    empresa_nome: 'Empresa Fictícia',
    empresa_cnpj: '11222333000181',
    trabalhador_nome: 'Trabalhador Fictício',
    trabalhador_matricula: 'MAT-001',
    responsavel_nome: 'Responsável Fictício',
    ...valores,
  });
}

function inserirItem(executor, valores) {
  return inserir(executor, 'entregas_epi_itens', {
    quantidade: 1,
    motivo: 'ADMISSAO',
    previsto_no_ghe: true,
    material_nome: 'Botina de segurança',
    material_unidade: 'par',
    material_prazo_uso_dias: 180,
    material_exige_ca: true,
    ...valores,
  });
}

function inserirOperacaoEntrega(executor, valores) {
  return inserir(executor, 'estoque_operacoes', { tipo: 'ENTREGA', ...valores });
}

function inserirConfirmacao(executor, valores) {
  return inserir(executor, 'entregas_epi_confirmacoes', {
    modo: 'ACEITE_PRESENCIAL',
    declaracao_versao: 'NR6-2026-09',
    declaracao_texto: 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício de teste).',
    hash_conteudo: 'c'.repeat(64),
    ip: '203.0.113.10',
    dispositivo: 'Navegador de teste',
    ...valores,
  });
}

/**
 * Entrega completa numa transação: cabeçalho, itens, uma operação ENTREGA
 * por item e a confirmação, na ordem que o serviço vai seguir.
 */
async function registrarEntrega(executor, { entrega, itens, usuarioId, confirmacao = {} }) {
  return transacao(executor, async (c) => {
    const cabecalho = await inserirEntrega(c, entrega);
    const criados = [];
    for (const item of itens) {
      const linha = await inserirItem(c, { ...item, empresa_id: cabecalho.empresa_id, entrega_id: cabecalho.id });
      await inserirOperacaoEntrega(c, {
        empresa_id: linha.empresa_id, lote_id: linha.lote_id, quantidade: linha.quantidade,
        usuario_id: usuarioId, entrega_item_id: linha.id,
      });
      criados.push(linha);
    }
    await inserirConfirmacao(c, { empresa_id: cabecalho.empresa_id, entrega_id: cabecalho.id, ...confirmacao });
    return { entrega: cabecalho, itens: criados };
  });
}

module.exports = {
  HASH,
  SQL_PROXIMO_NUMERO_DA_FICHA,
  todasAsMigrations,
  erroDe,
  transacao,
  inserir,
  criarEmpresa,
  criarUsuario,
  criarGhe,
  criarFuncionario,
  criarMaterial,
  criarLote,
  proximoNumeroDaFicha,
  criarFicha,
  inserirEntrega,
  inserirItem,
  inserirOperacaoEntrega,
  inserirConfirmacao,
  registrarEntrega,
};
