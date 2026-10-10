-- logs_auditoria: snapshot do perfil do ator no momento do evento + índice da leitura por empresa e período (12K-D5).
--
-- POR QUE perfil_ator: a trilha de auditoria precisa mostrar o perfil que o usuário TINHA quando agiu, não o que tem
-- hoje (o perfil pode mudar depois, e usar o atual falsificaria o histórico). A coluna é preenchida pelo próprio INSERT
-- do repositório (auditoria.repository.registrar), a partir de usuarios.perfil na mesma instrução: um único ponto,
-- sem depender de cada serviço lembrar.
--
-- SEM FK para perfis(codigo): usuarios.perfil referencia perfis com ON UPDATE CASCADE, e uma FK aqui tentaria
-- propagar a mudança para linhas append-only (bloqueadas por trigger). O formato é conferido por CHECK.
--
-- REGISTROS ANTERIORES: ficam com perfil_ator NULL. Nada é reescrito nem inferido; a leitura mostra "—" para eles.
--
-- ÍNDICE: a leitura da trilha é por empresa, período e ordem decrescente de data (os índices de 012 são separados por
-- coluna). (empresa_id, criado_em DESC, id DESC) atende o filtro e a ordem da listagem e da exportação. Os índices
-- antigos permanecem (histórico imutável).
--
-- Só ADD COLUMN, um CHECK e um índice: as triggers append-only (UPDATE, DELETE, TRUNCATE) e a barreira de chaves JSON
-- sensíveis (014) não são tocadas.

ALTER TABLE logs_auditoria
  ADD COLUMN perfil_ator VARCHAR(20);

ALTER TABLE logs_auditoria
  ADD CONSTRAINT chk_logs_auditoria_perfil_ator
    CHECK (perfil_ator IS NULL OR perfil_ator ~ '^[A-Z][A-Z0-9_]{0,19}$');

COMMENT ON COLUMN logs_auditoria.perfil_ator IS
  'Perfil do ator (usuarios.perfil) no instante do evento, gravado pelo repositório. NULL em registros anteriores à 079 e em eventos sem usuário.';

CREATE INDEX idx_logs_auditoria_empresa_criado_em ON logs_auditoria (empresa_id, criado_em DESC, id DESC);
