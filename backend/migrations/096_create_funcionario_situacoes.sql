-- 096: Gestão de Funcionários — histórico das mudanças de situação com DATA EFETIVA (inativação, afastamento e retorno).
--
-- Estritamente aditiva: uma tabela nova, vazia, com índice e gatilhos próprios. Nenhuma tabela, coluna, linha, ação ou permissão
-- existente muda, e nada é copiado do passado (sem backfill): o funcionário legado em INATIVO ou AFASTADO continua sem linha de
-- histórico, e a leitura tolera essa ausência. A fonte da verdade da situação atual continua sendo `funcionarios.situacao` (084).
--
--  * Uma linha por mudança de situação, gravada pelo serviço na MESMA transação do UPDATE de `funcionarios.situacao`.
--  * `data_efetiva` é a data civil informada pelo operador (o dia em que o fato vale); `registrado_em` é o instante do servidor.
--    As duas coisas nunca se confundem. A data é obrigatória em ATIVO→INATIVO, ATIVO→AFASTADO, AFASTADO→INATIVO e AFASTADO→ATIVO
--    (retorno) e NULA em INATIVO→ATIVO (reativação não é retorno nem nova contratação), por CHECK do par.
--  * Pares permitidos: os mesmos de TRANSICOES em utils/situacao-funcionario.js. A cronologia entre linhas (data não anterior à
--    última, retorno não anterior ao início, nenhuma entrega posterior) depende de outras linhas e fica no serviço, sob a trava do
--    funcionário; o banco garante só o que enxerga na própria linha.
--  * A data efetiva não pode ser posterior ao dia do registro em São Paulo (defesa em profundidade, o serviço já recusa antes).
--  * Histórico imutável: UPDATE, DELETE e TRUNCATE são recusados por gatilho. Funcionário com histórico não pode ser apagado.
--  * Isolamento multiempresa: o funcionário e o ator são FKs COMPOSTAS com a empresa; nunca uma referência de outra empresa.

CREATE TABLE funcionario_situacoes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id         INTEGER      NOT NULL,
  funcionario_id     INTEGER      NOT NULL,
  situacao_anterior  VARCHAR(10)  NOT NULL,
  situacao_nova      VARCHAR(10)  NOT NULL,
  data_efetiva       DATE,
  registrado_por     INTEGER      NOT NULL,
  registrado_em      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_funcionario_situacoes_funcionario
    FOREIGN KEY (empresa_id, funcionario_id) REFERENCES funcionarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_funcionario_situacoes_registrado_por
    FOREIGN KEY (empresa_id, registrado_por) REFERENCES usuarios (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_funcionario_situacoes_par CHECK (
    (situacao_anterior, situacao_nova) IN (
      ('ATIVO', 'AFASTADO'), ('ATIVO', 'INATIVO'), ('AFASTADO', 'ATIVO'), ('AFASTADO', 'INATIVO'), ('INATIVO', 'ATIVO')
    )
  ),
  CONSTRAINT chk_funcionario_situacoes_data_do_par CHECK (
    (situacao_anterior = 'INATIVO' AND data_efetiva IS NULL)
    OR (situacao_anterior <> 'INATIVO' AND data_efetiva IS NOT NULL)
  ),
  CONSTRAINT chk_funcionario_situacoes_data_nao_futura CHECK (
    data_efetiva IS NULL OR data_efetiva <= (registrado_em AT TIME ZONE 'America/Sao_Paulo')::date
  )
);

-- Leitura por funcionário: a última data efetiva (cronologia) e o histórico, do mais recente ao mais antigo.
CREATE INDEX idx_funcionario_situacoes_funcionario
  ON funcionario_situacoes (empresa_id, funcionario_id, registrado_em DESC, id DESC);

CREATE FUNCTION proteger_funcionario_situacoes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'funcionario_situacoes: o histórico de situação é imutável (% não é permitido)', TG_OP;
END;
$$;

CREATE FUNCTION bloquear_truncate_funcionario_situacoes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'funcionario_situacoes: o histórico de situação é imutável (TRUNCATE não é permitido)';
END;
$$;

CREATE TRIGGER trg_funcionario_situacoes_imutavel
  BEFORE UPDATE OR DELETE ON funcionario_situacoes
  FOR EACH ROW EXECUTE FUNCTION proteger_funcionario_situacoes();

CREATE TRIGGER trg_funcionario_situacoes_bloquear_truncate
  BEFORE TRUNCATE ON funcionario_situacoes
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_truncate_funcionario_situacoes();

COMMENT ON TABLE funcionario_situacoes IS
  'Histórico imutável das mudanças de situação do funcionário (ATIVO, AFASTADO, INATIVO) com a data efetiva informada pelo operador, separada do instante do servidor.';
