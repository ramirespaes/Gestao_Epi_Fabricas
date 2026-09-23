'use strict';

const usuarioRepo = require('../repositories/usuario.repository');
const autoridade = require('./autoridade-administrativa');

/**
 * Consulta de usuários da empresa (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3U).
 *
 * POR QUE EXISTE: a tela de vínculos precisa mostrar QUEM pode ser
 * colocado num grupo. Até aqui nenhuma das 13 rotas listava usuários —
 * `GET /grupos-acesso/:id/usuarios` (3O) lista só os já vinculados
 * àquele grupo, e quem não tem grupo nenhum, justamente o caso mais
 * comum de "adicionar ao grupo", não aparecia em consulta alguma. A
 * alternativa seria pedir o identificador numérico do usuário na tela,
 * que é o oposto do que a subetapa pede.
 *
 * SÓ LEITURA, E SÓ DISSO: uma operação, sem transação, sem escrita e sem
 * regra de negócio nova. Não cria, não altera e não inativa usuário —
 * administração de usuários é outro assunto, de outro incremento. Este
 * serviço apenas descreve quem existe.
 *
 * AUTORIDADE: exige a MESMA autoridade da administração de vínculos
 * (ADMINISTRAR_VINCULOS_GRUPO, pela variante de leitura do ponto único
 * da 3Q). A lista existe para servir aquela tela; quem não pode
 * administrar vínculos não precisa da relação de pessoas da empresa. É a
 * mesma disciplina adotada na 3M/3N/3O — onde até as CONSULTAS passaram
 * a exigir autoridade — e na 3T, com o catálogo de ações.
 *
 * ISOLAMENTO MULTIEMPRESA: `empresaId` vem da sessão e é o primeiro
 * parâmetro obrigatório do repositório, nunca opcional. Não existe
 * caminho aqui que liste usuário de outra empresa.
 *
 * O QUE NÃO SAI DAQUI: senha, hash, token — nenhum deles é sequer pedido
 * ao banco (a projeção da listagem não os inclui). Também não sai
 * `biometria_cadastrada`: é dado pessoal que não ajuda a decidir vínculo.
 */

const MSG_NAO_AUTORIZADO = 'Sem autoridade para consultar os usuários da empresa';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Lista os usuários da empresa, opcionalmente filtrados por texto e por
 * situação do vínculo, com paginação.
 *
 * @param {{query: Function}} pool
 * @param {{empresaId: number, atorId: number, busca?: string|null,
 *          vinculo?: 'todos'|'sem_grupo'|'com_grupo',
 *          pagina?: number, limite?: number}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{usuarios: Array<object>, total: number, pagina: number, limite: number}>}
 * @throws {HttpError} 403 sem autoridade administrativa de vínculos
 */
async function listar(pool, {
  empresaId, atorId, busca = null, vinculo = 'todos', pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  await autoridade.exigirAutoridadeAdministrativaLeitura(
    pool, empresaId, atorId,
    'USUARIO_CONSULTA_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO,
    autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO,
  );

  const { usuarios, total } = await usuarioRepo.listarDaEmpresa(pool, empresaId, {
    busca, vinculo, pagina, limite,
  });

  return { usuarios, total, pagina, limite };
}

module.exports = { listar };
