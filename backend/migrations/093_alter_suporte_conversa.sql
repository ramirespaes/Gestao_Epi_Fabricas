-- 093: Suporte — a resposta do chamado vira CONVERSA nos dois sentidos, vinculada ao protocolo.
--
-- Estritamente aditiva sobre a 092 (que não foi aplicada a nenhum banco persistente): nenhuma tabela nova.
--
--  * suporte_chamado_respostas passa a guardar as mensagens dos DOIS lados: `autor_tipo` SAFEWORK (administrador da
--    plataforma, como antes) ou SOLICITANTE (o próprio usuário do chamado, por FK composta com a empresa; o gatilho
--    exige que seja exatamente o solicitante do chamado). As linhas existentes continuam SAFEWORK (DEFAULT).
--    `chave_idempotencia` (UUID do navegador, única por chamado) impede a mensagem duplicada no reenvio.
--    A tabela continua append-only (gatilhos da 092).
--  * suporte_chamados ganha os carimbos da conversa: última mensagem de cada lado e último "visto" de cada lado.
--    "Não lida" é derivada (última mensagem do outro lado depois do meu último visto); nenhuma flag por mensagem.
--
-- Fluxo de situação (regra do serviço, não do banco): mensagem do SOLICITANTE num chamado RESPONDIDO ou EM_ATENDIMENTO
-- o devolve a ABERTO (exige atendimento), com histórico; ENCERRADO não recebe mensagem de ninguém até a reabertura,
-- que só o administrador faz (ENCERRADO → ABERTO, auditada). Nada é apagado.

ALTER TABLE suporte_chamado_respostas
  ADD COLUMN autor_tipo          VARCHAR(12) NOT NULL DEFAULT 'SAFEWORK',
  ADD COLUMN usuario_empresa_id  INTEGER,
  ADD COLUMN usuario_id          INTEGER,
  ADD COLUMN chave_idempotencia  VARCHAR(64),
  ALTER COLUMN administrador_id DROP NOT NULL,
  ADD CONSTRAINT chk_suporte_respostas_autor CHECK (autor_tipo IN ('SAFEWORK', 'SOLICITANTE')),
  ADD CONSTRAINT chk_suporte_respostas_autor_coerente CHECK (
    (autor_tipo = 'SAFEWORK' AND administrador_id IS NOT NULL AND usuario_id IS NULL AND usuario_empresa_id IS NULL)
    OR (autor_tipo = 'SOLICITANTE' AND administrador_id IS NULL AND usuario_id IS NOT NULL AND usuario_empresa_id IS NOT NULL)
  ),
  ADD CONSTRAINT fk_suporte_respostas_usuario_mesma_empresa
    FOREIGN KEY (usuario_empresa_id, usuario_id) REFERENCES usuarios (empresa_id, id);

CREATE UNIQUE INDEX uq_suporte_respostas_chave
  ON suporte_chamado_respostas (chamado_id, chave_idempotencia) WHERE chave_idempotencia IS NOT NULL;

-- O solicitante de uma mensagem é SEMPRE o solicitante do próprio chamado (mesma empresa, mesmo usuário).
CREATE FUNCTION suporte_mensagem_do_solicitante() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dono suporte_chamados%ROWTYPE;
BEGIN
  IF NEW.autor_tipo = 'SOLICITANTE' THEN
    SELECT * INTO dono FROM suporte_chamados WHERE id = NEW.chamado_id;
    IF dono.id IS NULL OR dono.empresa_id <> NEW.usuario_empresa_id OR dono.usuario_id <> NEW.usuario_id THEN
      RAISE EXCEPTION 'mensagem do solicitante precisa ser do solicitante do chamado' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_suporte_respostas_solicitante BEFORE INSERT ON suporte_chamado_respostas
  FOR EACH ROW EXECUTE FUNCTION suporte_mensagem_do_solicitante();

ALTER TABLE suporte_chamados
  ADD COLUMN ultima_mensagem_solicitante_em TIMESTAMPTZ,
  ADD COLUMN ultima_mensagem_suporte_em     TIMESTAMPTZ,
  ADD COLUMN solicitante_visto_em           TIMESTAMPTZ,
  ADD COLUMN suporte_visto_em               TIMESTAMPTZ;

-- Fila do Painel por "exige atendimento" e mensagens não lidas; a lista do solicitante já tem índice por usuário.
CREATE INDEX idx_suporte_chamados_nao_lidas_suporte
  ON suporte_chamados (ultima_mensagem_solicitante_em DESC) WHERE ultima_mensagem_solicitante_em IS NOT NULL;
