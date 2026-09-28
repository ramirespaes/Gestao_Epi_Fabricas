-- logs_auditoria_plataforma: ator e alvo. Até aqui toda linha tinha um
-- administrador como autor, mas operações de CLI e eventos da própria
-- aplicação não têm autor humano identificado. Atribuí-las ao administrador
-- afetado registraria um fato falso.
--
-- ator_tipo diz quem agiu:
--   ADMINISTRADOR  administrador_id obrigatório: quem agiu
--   OPERACAO_CLI   administrador_id nulo: o CLI não sabe quem o executou
--   SISTEMA        administrador_id nulo: evento da infraestrutura
-- administrador_afetado_id diz sobre quem, como empresa_afetada_id, e nunca
-- repete o ator.
--
-- Linhas existentes: default constante é só metadado, então nenhuma linha é
-- reescrita nem atualizada e os gatilhos de append-only não disparam. Todas
-- passam a ler ADMINISTRADOR. As de ADMINISTRADOR_PLATAFORMA_CRIADO já
-- gravadas trazem o próprio alvo como autor; append-only, ficam como estão.
--
-- Os dois gatilhos da 029 (append-only e chave JSON sensível) valem para
-- qualquer ator, sem mudança.
ALTER TABLE logs_auditoria_plataforma
  ADD COLUMN ator_tipo VARCHAR(20) NOT NULL DEFAULT 'ADMINISTRADOR',
  ADD COLUMN administrador_afetado_id INTEGER REFERENCES administradores_plataforma(id) ON DELETE RESTRICT,
  ALTER COLUMN administrador_id DROP NOT NULL,
  ADD CONSTRAINT chk_logs_auditoria_plataforma_ator_tipo
    CHECK (ator_tipo IN ('ADMINISTRADOR', 'OPERACAO_CLI', 'SISTEMA')),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_ator_coerente
    CHECK (
      (ator_tipo = 'ADMINISTRADOR' AND administrador_id IS NOT NULL)
      OR (ator_tipo IN ('OPERACAO_CLI', 'SISTEMA') AND administrador_id IS NULL)
    ),
  ADD CONSTRAINT chk_logs_auditoria_plataforma_alvo_distinto_do_ator
    CHECK (administrador_afetado_id IS NULL OR administrador_afetado_id IS DISTINCT FROM administrador_id);

-- "Eventos que afetaram o administrador X" e a checagem da FK RESTRICT.
CREATE INDEX idx_logs_auditoria_plataforma_administrador_afetado_id
  ON logs_auditoria_plataforma (administrador_afetado_id);
