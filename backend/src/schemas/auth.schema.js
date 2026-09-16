'use strict';

const { z } = require('zod');
const { cnpj, email, senhaEntrada } = require('./campos.schema');

/**
 * Schemas das rotas de autenticação. Só estrutura e formato, sem contexto:
 * - não consultam banco nem distinguem empresa/usuário existente ou não;
 *   CNPJ passa apenas pela normalização estrutural (sem DV), para que uma
 *   identidade inexistente siga o mesmo caminho das existentes;
 * - a política de senha (tamanho mínimo, trivialidade, relação com
 *   e-mail/CNPJ) NÃO roda aqui: o service a aplica com
 *   validarPoliticaSenha() e o contexto da sessão.
 *
 * SENHAS: os valores de saída preservam as strings originais recebidas.
 * As comparações cruzadas usam SOMENTE valor.normalize('NFC'), como
 * password.js faz antes de hashear, para decidir igualdade. Sem trim,
 * lowercase, uppercase, NFKC ou qualquer outra transformação: diferenças de
 * caixa ou de espaços são diferenças reais.
 *
 * Mensagens fixas; nenhuma inclui senha, CNPJ ou e-mail.
 */

const login = {
  body: z.strictObject({
    cnpj,
    email,
    senha: senhaEntrada,
  }),
};

const nfc = (texto) => texto.normalize('NFC');

const trocaSenha = {
  body: z
    .strictObject({
      senhaAtual: senhaEntrada,
      novaSenha: senhaEntrada,
      confirmacaoNovaSenha: senhaEntrada,
    })
    .superRefine((corpo, ctx) => {
      const { senhaAtual, novaSenha, confirmacaoNovaSenha } = corpo;
      if ([senhaAtual, novaSenha, confirmacaoNovaSenha].some((valor) => typeof valor !== 'string')) {
        return; // algum campo já falhou no schema técnico: sem issues cruzados
      }
      if (nfc(novaSenha) !== nfc(confirmacaoNovaSenha)) {
        ctx.addIssue({
          code: 'custom',
          path: ['confirmacaoNovaSenha'],
          message: 'A confirmação não confere com a nova senha',
          params: { codigo: 'SENHAS_NAO_CONFEREM' },
        });
      }
      if (nfc(novaSenha) === nfc(senhaAtual)) {
        ctx.addIssue({
          code: 'custom',
          path: ['novaSenha'],
          message: 'A nova senha deve ser diferente da atual',
          params: { codigo: 'SENHA_IGUAL_ATUAL' },
        });
      }
    }),
};

module.exports = { login, trocaSenha };
