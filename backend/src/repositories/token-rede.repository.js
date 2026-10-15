'use strict';

/**
 * Redes autorizadas do Atendimento Token (token_redes_autorizadas, migration 086). A origem é SEMPRE o endereço que o servidor
 * resolveu (req.ip sob TRUST_PROXY_HOPS, canônico por utils/ip.js); nenhum cabeçalho do cliente é lido aqui.
 *
 * IP_FIXO: só vale como endereço EXATO (máscara /32 ou /128 igual ao endereço de saída). Uma faixa cadastrada como IP_FIXO não
 * autoriza ninguém: a permissão não é ampliada automaticamente (IP dinâmico e CGNAT não identificam a empresa).
 *
 * TUNEL: NEGADO enquanto não existir fronteira de rede confiável e verificável que ateste a passagem pelo túnel. Um endereço
 * privado, a sub-rede do túnel vista no X-Forwarded-For ou qualquer cabeçalho NÃO provam o WireGuard. Por isso este repositório
 * nem consulta as redes TUNEL: quando a topologia existir, a atestação entra aqui (decisão D-C1).
 */

const TUNEL_ATESTACAO_DISPONIVEL = false;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

/** true somente se `ip` (canônico) for exatamente uma rede IP_FIXO ATIVA da empresa. ip null (indisponível) nunca autoriza. */
async function ipFixoAutorizado(executor, empresaId, ip) {
  exigirId(empresaId, 'identificador de empresa');
  if (typeof ip !== 'string' || ip.length === 0) return false;
  const { rows } = await executor.query(
    `SELECT 1
       FROM token_redes_autorizadas
      WHERE empresa_id = $1 AND tipo = 'IP_FIXO' AND desativada_em IS NULL
        AND rede = set_masklen($2::inet, CASE family($2::inet) WHEN 4 THEN 32 ELSE 128 END)::cidr
      LIMIT 1`,
    [empresaId, ip],
  );
  return rows.length > 0;
}

module.exports = { TUNEL_ATESTACAO_DISPONIVEL, ipFixoAutorizado };
