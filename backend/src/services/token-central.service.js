'use strict';

const { HttpError } = require('../errors/HttpError');
const centralRepo = require('../repositories/token-central.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { montarCatalogoDoFuncionario } = require('./token-catalogo.service');

/**
 * Atendimento Token — Central Administrativa (Etapa H): três LEITURAS. A autorização (recurso `atendimentoToken` e a ação da prévia) mora
 * nas rotas; empresa e ator vêm SEMPRE da sessão administrativa. Nenhuma delas usa a credencial do tablet, abre atendimento, renova
 * sessão do Totem, cria pedido, reserva ou ficha, nem toca estoque; a única escrita é a linha de auditoria da prévia.
 *
 *  - Visão geral: contagens reais da empresa, numa leitura em instantâneo. Sem indicador online/offline (Etapa J).
 *  - Estado da ativação: DERIVADO da ativação mais recente do dispositivo, sem estado persistente. Precedência: CONSUMIDA (`usado_em`),
 *    CANCELADA (`cancelado_em`), EXPIRADA (vencida pelo relógio do banco), PENDENTE; NENHUMA se nunca houve. Nunca o código nem o autor.
 *  - Prévia do catálogo: a MESMA função da Etapa E (`montarCatalogoDoFuncionario`) para um funcionário da empresa da sessão, mais a
 *    auditoria `TOKEN_PREVIA_CONSULTADA` na mesma transação (sem auditoria não há prévia). Funcionário inelegível para o tablet é 409.
 */

const ACAO_PREVIA = 'TOKEN_PREVIA_CATALOGO_REAL';
const ACAO_AUDITORIA_PREVIA = 'TOKEN_PREVIA_CONSULTADA';
const ESTADOS_ATIVACAO = Object.freeze(['NENHUMA', 'PENDENTE', 'EXPIRADA', 'CONSUMIDA', 'CANCELADA']);
const SITUACOES_GERAIS = Object.freeze(['SEM_DISPOSITIVOS', 'SEM_DISPOSITIVO_ATIVO', 'COM_DISPOSITIVO_ATIVO']);

const dispositivoNaoEncontrado = () => HttpError.notFound('DISPOSITIVO_NAO_ENCONTRADO', 'Dispositivo não encontrado');
const funcionarioNaoEncontrado = () => HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Funcionário não encontrado');
const funcionarioNaoElegivel = () => HttpError.conflict('FUNCIONARIO_NAO_ELEGIVEL', 'Funcionário não elegível para o atendimento');

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

async function emTransacao(pool, abertura, operacao) {
  const client = await pool.connect();
  try {
    await client.query(abertura);
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

const EM_LEITURA = 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ';
const EM_ESCRITA_CONSISTENTE = 'BEGIN ISOLATION LEVEL REPEATABLE READ';

/** Situação geral ADMINISTRATIVA (sem comunicação): só diz se existe ao menos um dispositivo ativo. */
function situacaoGeralDe(dispositivos) {
  if (dispositivos.cadastrados === 0) return 'SEM_DISPOSITIVOS';
  if (dispositivos.ativos === 0) return 'SEM_DISPOSITIVO_ATIVO';
  return 'COM_DISPOSITIVO_ATIVO';
}

async function visaoGeral(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  return emTransacao(pool, EM_LEITURA, async (client) => {
    const dispositivos = await centralRepo.contarDispositivos(client, empresaId);
    const ativacoesPendentes = await centralRepo.contarAtivacoesPendentes(client, empresaId);
    return { dispositivos, ativacoesPendentes, situacaoGeral: situacaoGeralDe(dispositivos) };
  });
}

/** Estado derivado de uma ativação (ou NENHUMA). Função pura sobre os carimbos reais. */
function estadoDaAtivacao(a) {
  if (a === null) return 'NENHUMA';
  if (a.usadaEm !== null) return 'CONSUMIDA';
  if (a.canceladaEm !== null) return 'CANCELADA';
  if (a.vencida) return 'EXPIRADA';
  return 'PENDENTE';
}

async function estadoAtivacao(pool, { empresaId, dispositivoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  return emTransacao(pool, EM_LEITURA, async (client) => {
    if (!(await centralRepo.dispositivoExiste(client, empresaId, dispositivoId))) throw dispositivoNaoEncontrado();
    const a = await centralRepo.ativacaoMaisRecente(client, empresaId, dispositivoId);
    return {
      estado: estadoDaAtivacao(a),
      geradaEm: a === null ? null : a.geradaEm,
      expiraEm: a === null ? null : a.expiraEm,
      usadaEm: a === null ? null : a.usadaEm,
      canceladaEm: a === null ? null : a.canceladaEm,
    };
  });
}

async function previaCatalogo(pool, { empresaId, atorId, funcionarioId, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  return emTransacao(pool, EM_ESCRITA_CONSISTENTE, async (client) => {
    const funcionario = await centralRepo.funcionarioDaEmpresa(client, empresaId, funcionarioId);
    if (funcionario === null) throw funcionarioNaoEncontrado();
    if (!funcionario.ativo) throw funcionarioNaoElegivel();
    const catalogo = await montarCatalogoDoFuncionario(client, { empresaId, funcionarioId });
    // Auditoria mínima na mesma transação: ator, empresa e o id do funcionário consultado; só a contagem do resultado, nunca nome,
    // CPF, matrícula, materiais ou quantidades. Se a auditoria falhar, a prévia também falha.
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_PREVIA, referencia: String(funcionarioId), ip, dispositivo, contexto: { total: catalogo.total },
    });
    return { catalogo };
  });
}

module.exports = {
  ACAO_PREVIA, ACAO_AUDITORIA_PREVIA, ESTADOS_ATIVACAO, SITUACOES_GERAIS, estadoDaAtivacao, situacaoGeralDe, visaoGeral, estadoAtivacao, previaCatalogo,
};
