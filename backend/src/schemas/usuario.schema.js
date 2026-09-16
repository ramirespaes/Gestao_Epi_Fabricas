'use strict';

const { z } = require('zod');
const {
  email,
  senhaEntrada,
  idParametro,
  paginacaoQuery,
  booleanoQuery,
  textoCurto,
  codigoCatalogo,
} = require('./campos.schema');

/**
 * Schemas das rotas de usuários (tabela usuarios, migration 005).
 *
 * O cliente só fornece nome, email, senha (na criação) e perfil. Tudo o mais
 * é do servidor e é REJEITADO como campo desconhecido pelo modo estrito:
 * id, empresa_id (vem da sessão), senha_hash, biometria_cadastrada,
 * ultimo_login_em, criado_em, atualizado_em e ativo (muda só pelas rotas de
 * inativar/reativar, que exigem corpo vazio).
 *
 * EDIÇÃO VAZIA: NENHUM_CAMPO aparece somente quando o body válido não traz
 * nenhum campo editável ({}). Se um campo foi enviado e é inválido, aparece
 * apenas o erro desse campo.
 *
 * PERFIL: o formato em maiúsculas de codigoCatalogo é contrato da API; o
 * schema verifica só formato. Existência, atividade e autorização para
 * atribuir/reatribuir o perfil ficam no service. Sem enum JavaScript do
 * catálogo perfis.
 *
 * EXCLUSÃO: não há schema de DELETE. Usuário é inativado, nunca apagado
 * (FKs ON DELETE RESTRICT em logs_auditoria e login_tentativas). Proteções
 * como o próprio usuário e o último MASTER são RBAC do service.
 *
 * Também ficam no service: política de senha com contexto, hash Argon2id,
 * unicidade de e-mail por empresa (uq_usuarios_empresa_email_lower) e
 * isolamento por empresa. Nada aqui consulta banco ou loga.
 */

const NOME_TAMANHO_MAXIMO = 150; // usuarios.nome VARCHAR(150)
const PERFIL_TAMANHO_MAXIMO = 20; // perfis.codigo VARCHAR(20)
const BUSCA_TAMANHO_MAXIMO = 100;

const nome = textoCurto(NOME_TAMANHO_MAXIMO, 'NOME_INVALIDO', 'Nome inválido');
const perfil = codigoCatalogo(PERFIL_TAMANHO_MAXIMO, 'PERFIL_INVALIDO', 'Perfil inválido');
const busca = textoCurto(BUSCA_TAMANHO_MAXIMO, 'BUSCA_INVALIDA', 'Termo de busca inválido');

const params = z.strictObject({ id: idParametro });
const semCorpo = z.strictObject({});

const criar = {
  body: z.strictObject({
    nome,
    email,
    senha: senhaEntrada,
    perfil,
  }),
};

// Campos editáveis declarados um a um (nunca .partial() do schema de criação):
// senha e campos internos não entram por derivação.
const editar = {
  params,
  body: z
    .strictObject({
      nome: nome.optional(),
      email: email.optional(),
      perfil: perfil.optional(),
    })
    .superRefine((corpo, ctx) => {
      // Só com body válido (sem chave desconhecida nem campo inválido): o Zod
      // executa este refinamento mesmo após unrecognized_keys.
      if (ctx.issues.length > 0) {
        return;
      }
      if ([corpo.nome, corpo.email, corpo.perfil].every((valor) => valor === undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Informe ao menos um campo para atualizar',
          params: { codigo: 'NENHUM_CAMPO' },
        });
      }
    }),
};

const porId = { params };

// Inativar/reativar: identificação só pela rota; qualquer corpo é rejeitado.
const acaoPorId = { params, body: semCorpo };

const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    ativo: booleanoQuery.optional(),
    perfil: perfil.optional(),
    busca: busca.optional(),
  }),
};

module.exports = { criar, editar, porId, acaoPorId, listar };
