-- Configurações (05/10/2026): telefone e preferências de aparência da PESSOA,
-- na identidade global — acompanham a pessoa em qualquer empresa, computador
-- ou navegador, como o e-mail de acesso. Nenhuma linha existente muda de
-- comportamento: tema "sistema" e modo "padrao" reproduzem o que as telas já
-- faziam (seguir o sistema operacional, sem paleta especial).
--
-- O domínio dos valores é o mesmo do backend (utils/preferencias-aparencia.js)
-- e do frontend (js/tema.js). Nada de valor de interface aqui.

ALTER TABLE identidades
  ADD COLUMN telefone    VARCHAR(20),
  ADD COLUMN tema        VARCHAR(10) NOT NULL DEFAULT 'sistema',
  ADD COLUMN modo_visual VARCHAR(20) NOT NULL DEFAULT 'padrao';

ALTER TABLE identidades
  ADD CONSTRAINT chk_identidades_telefone_formato
    CHECK (telefone IS NULL OR (btrim(telefone) <> '' AND telefone !~ '[[:cntrl:]]')),
  ADD CONSTRAINT chk_identidades_tema
    CHECK (tema IN ('sistema', 'claro', 'escuro')),
  ADD CONSTRAINT chk_identidades_modo_visual
    CHECK (modo_visual IN ('padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico'));
