-- usuario_bloqueios: exceção pontual por usuário individual — bloqueia uma
-- ação específica para ESTE usuário, mesmo que o perfil dele libere essa
-- ação em permissoes_acao. Substitui o array usuarios.bloqueios do mock por
-- uma tabela relacional própria (nada de JSON/array em usuarios).
--
-- Sem empresa_id: já é coberto por usuario_id -> usuarios.empresa_id, mesma
-- lógica aplicada em estoque_tamanhos.
-- Sem atualizado_em: um bloqueio não é "editado" — pra desfazer, remove-se a
-- linha (DELETE); pra mudar o motivo, é um novo bloqueio.
CREATE TABLE usuario_bloqueios (
  id             SERIAL PRIMARY KEY,
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  acao_codigo    VARCHAR(60) NOT NULL REFERENCES acoes(codigo) ON DELETE RESTRICT ON UPDATE CASCADE,
  motivo         TEXT,
  bloqueado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_usuario_bloqueios_usuario_acao UNIQUE (usuario_id, acao_codigo)
);

CREATE INDEX idx_usuario_bloqueios_bloqueado_por ON usuario_bloqueios (bloqueado_por);
