'use strict';

const fs = require('node:fs');
const { certificadoRaizSeguro, LIMITE_CERTIFICADO_BYTES } = require('../services/imagem-backup-host-postgres');

/**
 * D-F7 (TLS do banco): configuração TLS EXPLÍCITA e OPCIONAL (opt-in) para todo cliente PostgreSQL da aplicação (pool, migrations, guarda de inicialização).
 *
 *  - `DB_SSL_MODE` ausente ou vazio: NADA muda. A função devolve `{}` (nenhuma chave `ssl`), de modo que o `pg` continua lendo `PGSSLMODE` do ambiente como hoje.
 *  - `DB_SSL_MODE=verify-full`: devolve `{ ssl: { rejectUnauthorized: true, ca? } }` (cadeia e nome do servidor verificados). `DB_SSL_ROOT_CERT` (caminho absoluto canônico de um arquivo
 *    regular, próprio, 0600 ou 0644, até 64 KiB) é opcional: sem ele vale a cadeia do sistema; com ele, uma CA privada. Qualquer outro valor de `DB_SSL_MODE` (inclusive `require`, `no-verify`,
 *    `disable`) é recusado: nunca há rebaixamento.
 *  - FALHA FECHADA: configuração incoerente lança `TypeError` com código fixo e mensagem fixa (nunca o valor): modo inválido, certificado sem modo, certificado ilegível ou inseguro, host por socket
 *    Unix com TLS, ou `PGSSLMODE` no ambiente diferente de `verify-full` quando o TLS explícito está ligado.
 *  - A OBRIGATORIEDADE por ambiente (por exemplo, produção com banco remoto) NÃO está implementada aqui: depende da confirmação da topologia real e é decisão posterior.
 */

const ERROS = Object.freeze({
  TLS_MODO_INVALIDO: 'DB_SSL_MODE inválido: só é aceito verify-full',
  TLS_CERTIFICADO_SEM_MODO: 'DB_SSL_ROOT_CERT exige DB_SSL_MODE=verify-full',
  TLS_CERTIFICADO_INVALIDO: 'DB_SSL_ROOT_CERT ausente, ilegível ou inseguro',
  TLS_INCOMPATIVEL_COM_SOCKET: 'TLS explícito não vale para socket Unix',
  TLS_CONFLITO_COM_PGSSLMODE: 'PGSSLMODE do ambiente conflita com o TLS explícito',
});

function falhar(codigo) {
  const falha = new TypeError(ERROS[codigo]);
  falha.code = codigo;
  return falha;
}

const vazio = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * @param {{ modo?: string, raizCa?: string, host?: string, pgsslmode?: string }} entrada valores já lidos do ambiente pelo chamador (este módulo não lê `process.env`)
 * @param {{ lerArquivo?: (caminho: string) => Buffer, certificadoSeguro?: (caminho: string) => boolean }} [portas] injetáveis para teste
 * @returns {{} | { ssl: { rejectUnauthorized: true, ca?: Buffer } }}
 */
function opcoesDeTls(entrada, portas = {}) {
  const { modo, raizCa, host, pgsslmode } = entrada ?? {};
  const lerArquivo = portas.lerArquivo ?? fs.readFileSync;
  const certificadoSeguro = portas.certificadoSeguro ?? certificadoRaizSeguro;
  if (vazio(modo)) {
    if (!vazio(raizCa)) throw falhar('TLS_CERTIFICADO_SEM_MODO');
    return Object.freeze({});
  }
  if (typeof modo !== 'string' || modo.trim() !== 'verify-full') throw falhar('TLS_MODO_INVALIDO');
  if (typeof host === 'string' && host.trim().startsWith('/')) throw falhar('TLS_INCOMPATIVEL_COM_SOCKET');
  if (!vazio(pgsslmode) && pgsslmode.trim() !== 'verify-full') throw falhar('TLS_CONFLITO_COM_PGSSLMODE');
  if (vazio(raizCa)) return Object.freeze({ ssl: Object.freeze({ rejectUnauthorized: true }) });
  const caminho = typeof raizCa === 'string' ? raizCa.trim() : '';
  if (!certificadoSeguro(caminho)) throw falhar('TLS_CERTIFICADO_INVALIDO');
  let conteudo;
  try { conteudo = lerArquivo(caminho); } catch { throw falhar('TLS_CERTIFICADO_INVALIDO'); }
  if (!Buffer.isBuffer(conteudo) || conteudo.length < 1 || conteudo.length > LIMITE_CERTIFICADO_BYTES) throw falhar('TLS_CERTIFICADO_INVALIDO');
  return Object.freeze({ ssl: Object.freeze({ rejectUnauthorized: true, ca: conteudo }) });
}

module.exports = { opcoesDeTls, ERROS };
