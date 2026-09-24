'use strict';

const { httpConfig } = require('../config/http');
const { HttpError } = require('../errors/HttpError');

/**
 * Entrega do convite do MASTER — MECANISMO DE DESENVOLVIMENTO (Pacote 3,
 * item 6 da instrução: "se ainda não existir infraestrutura de envio real
 * de e-mails, não inventar um serviço de produção nem inserir credenciais
 * SMTP; implementar e testar um mecanismo controlado de entrega para
 * desenvolvimento, documentando a dependência de envio real").
 *
 * O QUE FAZ: monta o link de aceite (página pública do Painel Privado +
 * token em claro) e o DEVOLVE ao chamador — o controller o inclui na
 * resposta da rota administrativa de criação do convite, que só um
 * administrador autenticado da plataforma alcança. Assim, em ambiente de
 * desenvolvimento/teste, a pessoa que opera o Painel Privado obtém o link
 * e o repassa (ou o teste automatizado o consome) sem nenhum e-mail real.
 *
 * O QUE NÃO FAZ, de propósito: não envia e-mail, não conhece SMTP, não tem
 * credencial, não LOGA o token (CLAUDE.md §24: token nunca em log — a linha
 * de log abaixo registra só que um convite foi gerado, para quem e até
 * quando). NENHUM e-mail real sai deste pacote.
 *
 * DEPENDÊNCIA DE IMPLANTAÇÃO (pendência explícita, ver relatório): antes
 * de produção, esta função deve ser substituída/complementada por um
 * provedor real de e-mail, e a resposta HTTP deve DEIXAR de carregar o
 * link — em produção o token só pode chegar à pessoa convidada pelo
 * canal de e-mail, nunca pela resposta do painel. `modo` na resposta
 * anuncia explicitamente que se trata do mecanismo de desenvolvimento,
 * para que nenhuma tela ou operador o confunda com envio real.
 *
 * O caminho da página é fixo aqui (frontend/painel-privado/aceitar-convite.html,
 * servida sob a origem do Painel Privado — httpConfig.plataforma.corsOrigens[0]).
 */

const MODO = 'DESENVOLVIMENTO_SEM_EMAIL';
const CAMINHO_PAGINA_ACEITE = '/painel-privado/aceitar-convite.html';
const MSG_INDISPONIVEL = 'Entrega de convites indisponível: nenhum provedor de e-mail configurado';

/**
 * SIGILO DO TOKEN (correção pós-auditoria do Pacote 3, item 1): o token
 * vai no FRAGMENTO do link (`#token=...`), nunca na query. O fragmento
 * não é enviado ao servidor (não entra em log de acesso do servidor
 * estático nem em Referer) e o frontend o remove da barra de endereço
 * antes de qualquer requisição, enviando-o ao backend só em corpo JSON
 * (POST) — o cliente HTTP registra método e caminho, nunca o corpo.
 */
function montarLinkAceite(token) {
  const origem = httpConfig.plataforma.corsOrigens[0];
  return `${origem}${CAMINHO_PAGINA_ACEITE}#token=${encodeURIComponent(token)}`;
}

/**
 * BLOQUEIO EM PRODUÇÃO (correção pós-auditoria do Pacote 3, item 3):
 * enquanto não houver provedor real de e-mail, criar convites em
 * production é RECUSADO de forma controlada (503, código estável), ANTES
 * de qualquer gravação — o serviço de convite chama esta função antes de
 * abrir a transação, e `entregar()` a chama de novo (defesa em
 * profundidade: nem uma chamada direta consegue montar o link em
 * produção). `ambiente` é injetável só para teste, mesmo padrão dos
 * carregadores de configuração.
 */
function exigirDisponivel(ambiente = httpConfig.ambiente) {
  if (ambiente === 'production') {
    throw new HttpError(503, 'CONVITE_ENTREGA_INDISPONIVEL', MSG_INDISPONIVEL);
  }
}

/**
 * @param {{emailConvite: string, token: string, expiraEm: Date, empresa: {id: number, razaoSocial: string}}} dados
 * @returns {Promise<{modo: string, linkAceite: string, expiraEm: Date}>}
 */
async function entregar({ emailConvite, token, expiraEm, empresa }) {
  exigirDisponivel();
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token de convite inválido');
  }
  const linkAceite = montarLinkAceite(token);

  // Sem o token, sem o link: só o fato, para rastreabilidade operacional.
  console.log('[convite-master] convite gerado (modo desenvolvimento, sem envio de e-mail)', {
    empresaId: empresa.id, emailConvite, expiraEm: expiraEm.toISOString(),
  });

  return { modo: MODO, linkAceite, expiraEm };
}

module.exports = { entregar, exigirDisponivel, montarLinkAceite, MODO, CAMINHO_PAGINA_ACEITE };
