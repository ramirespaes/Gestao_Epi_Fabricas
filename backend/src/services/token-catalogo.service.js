'use strict';

const { HttpError } = require('../errors/HttpError');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const atendimentoRepo = require('../repositories/token-atendimento.repository');
const catalogoRepo = require('../repositories/token-catalogo.repository');

/**
 * Atendimento Token — catálogo de materiais físicos autorizados para o funcionário do atendimento vigente (Etapa E).
 *
 * CONSULTA PURA: uma leitura em instantâneo único (READ ONLY, REPEATABLE READ). Não escreve, não renova os 60 s, não reemite cookie e não
 * fecha o atendimento vencido (o fechamento por INATIVIDADE continua das operações da Etapa D). A validade é a da Etapa D, lida pelo
 * MESMO repositório (`buscarAbertoPorToken`): aberto, do mesmo tablet e empresa, não vencido (relógio do banco), funcionário ainda ATIVO e
 * atendimento não anterior à reativação do tablet. Qualquer falha é a resposta única 401 ATENDIMENTO_INVALIDO. A credencial do tablet,
 * a empresa ativa e a rede já foram decididas pelo middleware da Etapa C.
 *
 * Empresa, tablet, funcionário e GHE vêm SEMPRE do servidor (credencial, atendimento e cadastro do funcionário); o cliente não envia nada.
 *
 * SELEÇÃO (ver repositories/sql/catalogo-token.js): material da empresa, ativo, com `exige_tamanho` classificado, autorizado pelo GHE ATUAL
 * do funcionário (vínculo direto, ou por tipo ATIVO) e, se exige tamanho, com ao menos um tamanho cadastrado. Saldo nunca filtra nem
 * aparece. Tipo genérico nunca é item. A imagem não tem fonte real ainda: a ausência é representada explicitamente.
 */

const ESTADOS = Object.freeze({ OK: 'OK', SEM_GHE: 'SEM_GHE', GHE_INATIVO: 'GHE_INATIVO', SEM_MATERIAIS: 'SEM_MATERIAIS' });
const SEM_IMAGEM = Object.freeze({ disponivel: false });

const atendimentoInvalido = () => HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado');

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
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

const material = (m) => ({
  id: m.id,
  nome: m.nome,
  unidade: m.unidade,
  categoria: m.categoria,
  grupoProtecao: m.grupo_protecao,
  tipo: m.tipo === null ? null : { id: m.tipo_material_id, nome: m.tipo },
  exigeTamanho: m.exige_tamanho,
  tamanhos: m.exige_tamanho ? m.tamanhos : [],
  imagem: SEM_IMAGEM,
});

/**
 * ÚNICA FONTE DE VERDADE do catálogo de um funcionário (GHE atual, materiais físicos, tipos, tamanhos, filtros e estados). Extraída de
 * `obter` na Etapa H, sem mudar nenhum critério nem o contrato da rota, para a prévia administrativa mostrar exatamente o que o tablet
 * mostra. NÃO valida atendimento, tablet nem sessão: quem chama já decidiu quem pode pedir este funcionário (o atendimento vigente, na
 * rota do tablet; a sessão administrativa com a ação de prévia, na Central). Leitura pura, com um client já em transação de leitura.
 * @returns {Promise<{ estado: string, total: number, materiais: object[] }>}
 */
async function montarCatalogoDoFuncionario(client, { empresaId, funcionarioId }) {
  const ghe = await catalogoRepo.buscarGheDoFuncionario(client, { empresaId, funcionarioId });
  if (ghe === null || ghe.ghe_id === null) return { estado: ESTADOS.SEM_GHE, total: 0, materiais: [] };
  if (ghe.ghe_ativo !== true) return { estado: ESTADOS.GHE_INATIVO, total: 0, materiais: [] };

  const linhas = await catalogoRepo.listarMateriaisAutorizados(client, { empresaId, gheId: ghe.ghe_id });
  // Quem exige tamanho precisa de ao menos uma opção cadastrada; quem não exige nunca é excluído por falta de grade.
  const materiais = linhas.filter((m) => m.exige_tamanho !== true || m.tamanhos.length > 0).map(material);
  return { estado: materiais.length === 0 ? ESTADOS.SEM_MATERIAIS : ESTADOS.OK, total: materiais.length, materiais };
}

/**
 * @param {{ dispositivo: { id: number, empresaId: number }, token: string|null }} entrada token = cookie do atendimento (já separado do tablet)
 * @returns {Promise<{ estado: string, total: number, materiais: object[] }>}
 * @throws {HttpError} 401 ATENDIMENTO_INVALIDO
 */
async function obter(pool, { dispositivo, token }) {
  if (!tokenSessaoTemFormatoValido(token)) throw atendimentoInvalido();
  const tokenHash = hashTokenSessao(token);
  const resultado = await emLeitura(pool, async (client) => {
    const atendimento = await atendimentoRepo.buscarAbertoPorToken(client, { empresaId: dispositivo.empresaId, dispositivoId: dispositivo.id, tokenHash });
    if (atendimento === null || atendimento.vencido || !atendimento.funcionario_ativo || atendimento.anterior_a_reativacao) return null;
    return montarCatalogoDoFuncionario(client, { empresaId: atendimento.empresa_id, funcionarioId: atendimento.funcionario_id });
  });
  if (resultado === null) throw atendimentoInvalido();
  return { estado: resultado.estado, total: resultado.total, materiais: resultado.materiais };
}

module.exports = { ESTADOS, montarCatalogoDoFuncionario, obter };
