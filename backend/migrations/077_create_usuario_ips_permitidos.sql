-- 077 — IPs permitidos por usuário administrativo
-- (Gestão de Usuários, Novo → Usuário; decisão de 05/10/2026)
--
-- Restrição de acesso por endereço, aplicada no SERVIDOR: sem linhas, o
-- usuário acessa de qualquer endereço; com uma ou mais linhas, a seleção da
-- empresa e toda requisição da sessão empresarial só passam quando o endereço
-- remoto resolvido pelo servidor (req.ip sob TRUST_PROXY_HOPS, nunca um
-- cabeçalho confiado cegamente) é um dos cadastrados. Estrutura normalizada,
-- uma linha por endereço, INET para IPv4 e IPv6; só endereços de host (sem
-- faixas) nesta fase.
--
-- A FK composta (empresa_id, usuario_id) -> usuarios (empresa_id, id)
-- (uq_usuarios_empresa_id, 013) impede ligar um IP a usuário de outra empresa.

CREATE TABLE usuario_ips_permitidos (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER     NOT NULL,
  usuario_id INTEGER     NOT NULL,
  ip         INET        NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_usuario_ips_permitidos_usuario
    FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_usuario_ips_permitidos UNIQUE (empresa_id, usuario_id, ip),
  CONSTRAINT chk_usuario_ips_permitidos_endereco_de_host
    CHECK (masklen(ip) = CASE family(ip) WHEN 4 THEN 32 ELSE 128 END)
);
