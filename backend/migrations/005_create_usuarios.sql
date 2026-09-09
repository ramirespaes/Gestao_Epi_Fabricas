-- usuarios: contas de acesso ao sistema (perfis administrativos/operacionais,
-- distintos de "funcionarios", que são os colaboradores que recebem EPI).
CREATE TABLE usuarios (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome                  VARCHAR(150) NOT NULL,
  email                 VARCHAR(150) NOT NULL,
  senha_hash            VARCHAR(255) NOT NULL,
  perfil                VARCHAR(20) NOT NULL REFERENCES perfis(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  ativo                 BOOLEAN NOT NULL DEFAULT true,
  biometria_cadastrada  BOOLEAN NOT NULL DEFAULT false,
  ultimo_login_em       TIMESTAMPTZ,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade de e-mail *case-insensitive* dentro da empresa: 'Luis@x.com' e
-- 'luis@x.com' contam como o mesmo e-mail. Este índice funcional substitui
-- (e cobre sozinho) uma UNIQUE comum em (empresa_id, email) — não criamos as
-- duas, seria redundante.
CREATE UNIQUE INDEX uq_usuarios_empresa_email_lower
  ON usuarios (empresa_id, lower(email));

CREATE TRIGGER trg_usuarios_atualizado_em
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
