'use strict';

const net = require('node:net');

/**
 * Endereço de escuta da API (BIND_ADDRESS), opcional.
 *
 * Ausente, nula ou vazia: nada muda, a API escuta em todas as interfaces da porta PORT (comportamento anterior).
 * Presente: só um endereço IP literal, IPv4 ou IPv6, sem porta, colchetes, nome de host nem escopo (%). Qualquer outro valor
 * impede a subida (falha fechada) e o erro nunca ecoa o valor recebido.
 *
 * Atrás de um proxy reverso local, defina 127.0.0.1: assim a API só atende o proxy e o X-Forwarded-For que um cliente enviar
 * direto à porta da API não vira o IP do cliente sob TRUST_PROXY_HOPS. Não substitui o firewall do provedor.
 */

const VARIAVEL = 'BIND_ADDRESS';

function enderecoInvalido() {
  const erro = new TypeError(`${VARIAVEL}: deve ser um endereço IP literal (IPv4 ou IPv6), sem porta, colchetes, nome de host nem escopo`);
  erro.code = 'BIND_ADDRESS_INVALIDO';
  return erro;
}

/** Função pura da origem recebida (normalmente process.env). Devolve o endereço validado ou undefined quando ausente ou vazio. */
function enderecoDeEscuta(origem) {
  if (origem === null || typeof origem !== 'object') throw new TypeError('origem inválida');
  const bruto = origem[VARIAVEL];
  if (bruto === undefined || bruto === null || bruto === '') return undefined;
  if (typeof bruto !== 'string' || bruto.includes('%') || net.isIP(bruto) === 0) throw enderecoInvalido();
  return bruto;
}

/** Inicia a escuta no servidor de aplicação (app.listen), com ou sem endereço. */
function escutar(app, porta, endereco, aoOuvir) {
  return endereco === undefined ? app.listen(porta, aoOuvir) : app.listen(porta, endereco, aoOuvir);
}

module.exports = { VARIAVEL, enderecoDeEscuta, escutar };
