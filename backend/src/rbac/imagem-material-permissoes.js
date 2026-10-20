'use strict';

/**
 * Matriz de permissões da Biblioteca de Imagens (doc. 03, alternativa A): SEM recurso, ação, toggle ou migration de RBAC novos. Tudo reutiliza
 * o recurso `materials` e as operações que já têm efeito real. É o contrato que as rotas (unidade própria) aplicarão pelo middleware do recurso;
 * o serviço não decide autorização. A biblioteca padrão não tem entrada aqui de propósito: nenhuma permissão de cliente a escreve.
 */

const exige = (operacao) => Object.freeze({ recurso: 'materials', operacao });

const PERMISSOES_IMAGEM_MATERIAL = Object.freeze({
  listar: exige('visualizar'),
  visualizarArquivo: exige('visualizar'),
  importar: exige('criar'),
  associarAoCriarMaterial: exige('criar'),
  associarAoEditarMaterial: exige('editar'),
  renomear: exige('editar'),
  inativar: exige('editar'),
  reativar: exige('editar'),
  excluir: exige('editar'),
});

module.exports = { PERMISSOES_IMAGEM_MATERIAL };
