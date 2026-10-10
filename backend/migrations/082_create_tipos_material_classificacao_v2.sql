-- 082 — Classificação V2 do material: Grupo → Grupo de Proteção → Tipo (decisões de 07 e 08/10/2026).
--
-- tipos_material: catálogo de tipos POR EMPRESA (grupo EPI|Vestimenta, grupo de proteção fechado, nome), com `ativo` e
-- `origem`. Unicidade lógica por empresa + grupo + nome normalizado (caixa e espaços repetidos não diferenciam); grupo,
-- proteção, nome e origem são imutáveis — só `ativo` muda. "Outros" nunca é linha física (é opção da interface do
-- material). A tabela nasce semeada com o catálogo base (26) para as empresas já existentes; a empresa criada depois
-- recebe o mesmo catálogo no cadastro (empresa-cadastro.service), nunca por mágica do banco.
--
-- materiais: modelo_classificacao ('LEGADO' para tudo o que já existe; 'V2' para cadastro novo ou convertido),
-- Grupo = Outros com descrição própria, grupo de proteção (12 fechados ou 'Outros' + descrição) e vínculo ao catálogo por
-- FK composta (empresa, id, grupo, proteção, nome): o banco impede tipo de outro grupo, de outra proteção, de outra
-- empresa ou com nome divergente. A equivalência tipo 'Outros' ⇔ descrição (071, NOT VALID) é substituída por regra que
-- vale SÓ para V2: o legado continua editável em campos não relacionados sem conversão forçada. Óculos com grau: V2 pela
-- classificação (EPI + Proteção ocular, qualquer tipo); LEGADO pelos três nomes históricos. Uniforme → Vestimenta de
-- verdade, preservando id, estoque, vínculos e histórico. entregas_epi_itens ganha o snapshot material_grupo_protecao
-- (NULL em tudo o que já existe). Sem backfill; 006, 007, 039, 058 e 071 ficam intocadas.

CREATE TABLE tipos_material (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  grupo          VARCHAR(30) NOT NULL,
  grupo_protecao VARCHAR(60) NOT NULL,
  nome           VARCHAR(100) NOT NULL,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  origem         VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tipos_material_empresa_id UNIQUE (empresa_id, id),
  -- Alvo da FK composta de materiais: o vínculo só existe com grupo, proteção e nome iguais aos do catálogo.
  CONSTRAINT uq_tipos_material_classificacao UNIQUE (empresa_id, id, grupo, grupo_protecao, nome),
  CONSTRAINT chk_tipos_material_grupo CHECK (grupo IN ('EPI', 'Vestimenta')),
  CONSTRAINT chk_tipos_material_grupo_protecao CHECK (grupo_protecao IN (
    'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas',
    'Proteção dos braços', 'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)',
    'Proteção respiratória', 'Proteção do tronco')),
  CONSTRAINT chk_tipos_material_nome CHECK (
    btrim(nome) = nome AND char_length(nome) > 0 AND nome !~ '[[:cntrl:]]' AND lower(nome) <> 'outros'),
  CONSTRAINT chk_tipos_material_origem CHECK (origem IN ('BASE', 'MANUAL'))
);

-- Unicidade lógica: mesma regra de normalização da aplicação (sequências de espaço viram um espaço; caixa não diferencia).
CREATE UNIQUE INDEX uq_tipos_material_empresa_grupo_nome
  ON tipos_material (empresa_id, grupo, lower(btrim(regexp_replace(nome, '[ \t\r\n]+', ' ', 'g'), ' ')));

-- Seletor encadeado da tela: só os ativos de um grupo + proteção.
CREATE INDEX idx_tipos_material_empresa_grupo_protecao ON tipos_material (empresa_id, grupo, grupo_protecao) WHERE ativo;

CREATE FUNCTION tipos_material_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.grupo IS DISTINCT FROM OLD.grupo
     OR NEW.grupo_protecao IS DISTINCT FROM OLD.grupo_protecao
     OR NEW.nome IS DISTINCT FROM OLD.nome
     OR NEW.origem IS DISTINCT FROM OLD.origem THEN
    RAISE EXCEPTION 'tipos_material: empresa, grupo, grupo de proteção, nome e origem são imutáveis (só ativo muda)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tipos_material_imutavel
  BEFORE UPDATE ON tipos_material
  FOR EACH ROW EXECUTE FUNCTION tipos_material_imutavel();

CREATE TRIGGER trg_tipos_material_atualizado_em
  BEFORE UPDATE ON tipos_material
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- Catálogo base aprovado (26), uma vez por empresa existente; idempotente pela unicidade lógica.
INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, origem)
SELECT e.id, c.grupo, c.grupo_protecao, c.nome, 'BASE'
  FROM empresas e
 CROSS JOIN (VALUES
    ('EPI', 'Proteção auditiva', 'Protetor Auricular Concha'),
    ('EPI', 'Proteção auditiva', 'Protetor Auricular Plug'),
    ('EPI', 'Proteção contra quedas', 'Cinturão de Segurança com Talabarte/Trava-Quedas'),
    ('EPI', 'Proteção da cabeça', 'Capacete de Segurança'),
    ('EPI', 'Proteção da cabeça', 'Capuz de Segurança'),
    ('EPI', 'Proteção das mãos', 'Luva Isolante de Borracha'),
    ('EPI', 'Proteção das mãos', 'Luva de Segurança'),
    ('EPI', 'Proteção das mãos', 'Luva de Segurança Nitrila'),
    ('EPI', 'Proteção das mãos', 'Luva para Proteção contra Agentes Térmicos'),
    ('EPI', 'Proteção das pernas', 'Perneira de Proteção Aluminizada'),
    ('EPI', 'Proteção dos braços', 'Manga de Segurança'),
    ('EPI', 'Proteção dos braços', 'Manga de Segurança para Corte'),
    ('EPI', 'Proteção dos braços', 'Mangote de Segurança'),
    ('EPI', 'Proteção dos pés', 'Sapato de Segurança'),
    ('EPI', 'Proteção facial', 'Protetor Facial'),
    ('EPI', 'Proteção ocular', 'Óculos de Proteção Fumê'),
    ('EPI', 'Proteção ocular', 'Óculos de Proteção Incolor'),
    ('EPI', 'Proteção ocular', 'Óculos de Proteção Sobrepor'),
    ('EPI', 'Proteção da pele (membros superiores)', 'Creme Protetor de Segurança'),
    ('EPI', 'Proteção respiratória', 'Respirador PFF2'),
    ('Vestimenta', 'Proteção das pernas', 'Calça de Segurança'),
    ('Vestimenta', 'Proteção do tronco', 'Avental de Segurança'),
    ('Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Agente Térmico'),
    ('Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Camisa'),
    ('Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Raspa'),
    ('Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco Aluminizada')
 ) AS c (grupo, grupo_protecao, nome)
    ON CONFLICT DO NOTHING;

-- Materiais: o que já existe é LEGADO e fica exatamente como está nas colunas novas (todas nulas).
ALTER TABLE materiais
  ADD COLUMN modelo_classificacao     VARCHAR(10) NOT NULL DEFAULT 'LEGADO',
  ADD COLUMN categoria_descricao      VARCHAR(100),
  ADD COLUMN grupo_protecao           VARCHAR(60),
  ADD COLUMN grupo_protecao_descricao VARCHAR(100),
  ADD COLUMN tipo_material_id         INTEGER;

ALTER TABLE materiais
  ADD CONSTRAINT fk_materiais_tipo_material_coerente
    FOREIGN KEY (empresa_id, tipo_material_id, categoria, grupo_protecao, tipo)
    REFERENCES tipos_material (empresa_id, id, grupo, grupo_protecao, nome)
    ON DELETE RESTRICT;

CREATE INDEX idx_materiais_tipo_material_id ON materiais (tipo_material_id);

ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_modelo_classificacao CHECK (modelo_classificacao IN ('LEGADO', 'V2')),
  ADD CONSTRAINT chk_materiais_v2_grupo CHECK (
    modelo_classificacao <> 'V2' OR (categoria IS NOT NULL AND categoria IN ('EPI', 'Vestimenta', 'Outros'))),
  ADD CONSTRAINT chk_materiais_categoria_descricao_formato CHECK (
    categoria_descricao IS NULL OR (btrim(categoria_descricao) = categoria_descricao AND char_length(categoria_descricao) > 0)),
  ADD CONSTRAINT chk_materiais_v2_categoria_outros CHECK (
    modelo_classificacao <> 'V2' OR (COALESCE(categoria = 'Outros', false) = (categoria_descricao IS NOT NULL))),
  ADD CONSTRAINT chk_materiais_v2_grupo_protecao_presenca CHECK (
    modelo_classificacao <> 'V2'
    OR (categoria = 'Outros' AND grupo_protecao IS NULL)
    OR (categoria IN ('EPI', 'Vestimenta') AND grupo_protecao IS NOT NULL)),
  ADD CONSTRAINT chk_materiais_grupo_protecao_valores CHECK (grupo_protecao IS NULL OR grupo_protecao IN (
    'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas',
    'Proteção dos braços', 'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)',
    'Proteção respiratória', 'Proteção do tronco', 'Outros')),
  ADD CONSTRAINT chk_materiais_grupo_protecao_descricao_formato CHECK (
    grupo_protecao_descricao IS NULL
    OR (btrim(grupo_protecao_descricao) = grupo_protecao_descricao AND char_length(grupo_protecao_descricao) > 0)),
  ADD CONSTRAINT chk_materiais_grupo_protecao_outros CHECK (
    (grupo_protecao IS NOT DISTINCT FROM 'Outros') = (grupo_protecao_descricao IS NOT NULL)),
  -- Grupo Outros ou Proteção Outros ⇒ o tipo é "Outros", nunca do catálogo.
  ADD CONSTRAINT chk_materiais_v2_outros_tipo CHECK (
    modelo_classificacao <> 'V2'
    OR NOT (COALESCE(categoria = 'Outros', false) OR COALESCE(grupo_protecao = 'Outros', false))
    OR (tipo = 'Outros' AND tipo_material_id IS NULL)),
  ADD CONSTRAINT chk_materiais_v2_tipo_presente CHECK (modelo_classificacao <> 'V2' OR tipo IS NOT NULL),
  -- Em V2 o tipo é do catálogo (id) ou "Outros" com descrição; nunca texto livre.
  ADD CONSTRAINT chk_materiais_v2_tipo_catalogo_ou_outros CHECK (
    modelo_classificacao <> 'V2' OR tipo_material_id IS NOT NULL OR tipo = 'Outros'),
  ADD CONSTRAINT chk_materiais_tipo_material_coerente CHECK (
    tipo_material_id IS NULL
    OR (modelo_classificacao = 'V2' AND tipo IS NOT NULL AND tipo <> 'Outros' AND tipo_descricao IS NULL)),
  ADD CONSTRAINT chk_materiais_legado_sem_v2 CHECK (
    modelo_classificacao <> 'LEGADO'
    OR (categoria_descricao IS NULL AND grupo_protecao IS NULL AND grupo_protecao_descricao IS NULL AND tipo_material_id IS NULL));

-- Substituição consciente da constraint da 071: a equivalência tipo 'Outros' ⇔ descrição passa a valer só para V2.
-- O legado anterior à 071 (tipo 'Outros' sem descrição) continua editável em campos não relacionados.
ALTER TABLE materiais DROP CONSTRAINT chk_materiais_tipo_descricao_so_outros;
ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_v2_tipo_descricao CHECK (
    modelo_classificacao <> 'V2' OR ((tipo IS NOT DISTINCT FROM 'Outros') = (tipo_descricao IS NOT NULL)));

-- Óculos com grau: V2 pela classificação (qualquer tipo de EPI + Proteção ocular); LEGADO pelos nomes históricos.
ALTER TABLE materiais DROP CONSTRAINT chk_materiais_oculos_com_grau_so_oculos;
ALTER TABLE materiais
  ADD CONSTRAINT chk_materiais_oculos_com_grau_so_oculos CHECK (
    oculos_com_grau IS NULL
    OR (modelo_classificacao = 'V2' AND categoria IS NOT DISTINCT FROM 'EPI' AND grupo_protecao IS NOT DISTINCT FROM 'Proteção ocular')
    OR (modelo_classificacao = 'LEGADO' AND tipo IS NOT NULL
        AND tipo IN ('Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão')));

-- Snapshot do grupo de proteção no item da entrega (NULL em tudo o que já existe; nada é reescrito).
ALTER TABLE entregas_epi_itens
  ADD COLUMN material_grupo_protecao VARCHAR(60);

ALTER TABLE entregas_epi_itens
  ADD CONSTRAINT chk_entregas_epi_itens_material_grupo_protecao CHECK (
    material_grupo_protecao IS NULL
    OR (btrim(material_grupo_protecao) = material_grupo_protecao AND char_length(material_grupo_protecao) > 0));

ALTER TABLE entregas_epi_itens DROP CONSTRAINT chk_entregas_epi_itens_material_oculos;
ALTER TABLE entregas_epi_itens
  ADD CONSTRAINT chk_entregas_epi_itens_material_oculos CHECK (
    material_oculos_com_grau IS NULL
    OR material_grupo_protecao IS NOT DISTINCT FROM 'Proteção ocular'
    OR (material_tipo IS NOT NULL
        AND material_tipo IN ('Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão')));

-- Uniforme → Vestimenta de verdade (categoria é mutável e não tem snapshot): id, lotes, vínculos e histórico ficam.
UPDATE materiais SET categoria = 'Vestimenta' WHERE categoria = 'Uniforme';
