# Dicionário de dados — trilhas de auditoria

Documento oficial do esquema das três trilhas de auditoria do SafeWork, derivado das migrations
versionadas em `backend/migrations/` (fonte única; o manifesto `checksums.json` fixa os bytes de
cada uma). Criado na Rodada A (R2, 07/11/2026) para registrar a PENDENCIA-SEG-TRG04 e a sua
correção (migration 097). Escopo atual: só estas tabelas e as funções/gatilhos que compartilham.
Outras tabelas devem ser acrescentadas aqui, sempre a partir da migration que as cria ou altera.

Convenções: tipos como declarados no SQL; "append-only" = gatilhos BEFORE UPDATE/DELETE/TRUNCATE
que lançam exceção; "JSONB protegido" = CHECK de objeto, CHECK de 16 KiB (`octet_length` do texto)
e gatilho BEFORE INSERT que recusa chave sensível em qualquer profundidade.

## Funções compartilhadas (schema da aplicação)

| Função | Criada em | Alterada em | Papel |
|---|---|---|---|
| `bloquear_alteracao_logs_auditoria()` (TRIGGER) | 012 | — | lança `append-only: operação % não é permitida` em UPDATE/DELETE/TRUNCATE das três trilhas |
| `logs_auditoria_chave_json_e_sensivel(chave TEXT) → BOOLEAN`, IMMUTABLE | 014 | **097** | decide pelo NOME da chave: normaliza camelCase e separadores em segmentos `[a-z0-9]+`; recusa palavra inteira, par adjacente (014) e, desde a 097, composto conhecido sem separador, sufixo e prefixo sensíveis (`PGPASSWORD`, `DBPASSWORD`, `ACCESSTOKEN`, `CLIENTSECRET`, …). `secretaria_id`, `hashtag`, `chave_primaria`, `key`/`chave` sozinhos são legítimos |
| `logs_auditoria_jsonb_possui_chave_sensivel(dado JSONB) → BOOLEAN`, IMMUTABLE | 014 | — | percorre objetos e arrays recursivamente chamando a função acima |
| `logs_auditoria_bloquear_dado_sensivel()` (TRIGGER) | 014 | — | BEFORE INSERT: recusa a linha se `contexto`, `dados_anteriores` ou `dados_novos` tiver chave sensível (`campo JSONB contém chave sensível …`) |

Primeira barreira na aplicação (mesmas listas, espelho testado): `backend/src/utils/chave-json-sensivel.js`,
chamado pelos três repositórios de auditoria antes de qualquer INSERT (TypeError do chamador).

## `logs_auditoria` — trilha empresarial (012, 014, 079)

| Coluna | Tipo | Nulo | Origem | Observação |
|---|---|---|---|---|
| `id` | BIGINT IDENTITY | não | 012 | PK; devolvido como string ao Node |
| `empresa_id` | INTEGER | não | 012 | FK `empresas(id)` ON DELETE RESTRICT |
| `usuario_id` | INTEGER | sim | 012 | FK `usuarios(id)` ON DELETE RESTRICT; nulo em evento automático |
| `acao` | VARCHAR(60) | não | 012 | código próprio da auditoria (não é FK para `acoes`) |
| `referencia` | VARCHAR(150) | sim | 012 | |
| `descricao` | TEXT | sim | 012 | |
| `ip` | VARCHAR(45) | sim | 012 | cortado pelo repositório (SEC-002) |
| `dispositivo` | VARCHAR(150) | sim | 012 | User-Agent cortado pelo repositório |
| `contexto` | JSONB | sim | 014 | protegido: `chk_logs_auditoria_contexto_objeto`, `_tamanho` |
| `dados_anteriores` | JSONB | sim | 014 | protegido: `chk_logs_auditoria_dados_anteriores_objeto`, `_tamanho` |
| `dados_novos` | JSONB | sim | 014 | protegido: `chk_logs_auditoria_dados_novos_objeto`, `_tamanho` |
| `perfil_ator` | VARCHAR(20) | sim | 079 | `chk_logs_auditoria_perfil_ator` (`^[A-Z][A-Z0-9_]{0,19}$`); perfil do ator no instante, lido pelo repositório |
| `criado_em` | TIMESTAMPTZ | não | 012 | DEFAULT now() |

Índices: `idx_logs_auditoria_empresa_id`, `idx_logs_auditoria_usuario_id`, `idx_logs_auditoria_criado_em` (012);
`idx_logs_auditoria_empresa_criado_em (empresa_id, criado_em DESC, id DESC)` (079).
Gatilhos: `trg_logs_auditoria_bloquear_update|delete|truncate` (012); `trg_logs_auditoria_bloquear_dado_sensivel` (014).
Escritor único: `backend/src/repositories/auditoria.repository.js`.

## `logs_auditoria_plataforma` — trilha da plataforma (029, 031, 048)

| Coluna | Tipo | Nulo | Origem | Observação |
|---|---|---|---|---|
| `id` | BIGINT IDENTITY | não | 029 | PK |
| `administrador_id` | INTEGER | sim (desde 048) | 029/048 | FK `administradores_plataforma(id)` ON DELETE RESTRICT; obrigatório quando `ator_tipo = 'ADMINISTRADOR'` |
| `empresa_afetada_id` | INTEGER | sim | 029 | FK `empresas(id)` ON DELETE RESTRICT |
| `acao` | VARCHAR(60) | não | 029 | |
| `referencia` | VARCHAR(150) | sim | 029 | |
| `descricao` | TEXT | sim | 029 | |
| `ip` | VARCHAR(45) | sim | 029 | |
| `dispositivo` | VARCHAR(150) | sim | 029 | |
| `contexto` | JSONB | sim | 029 | protegido (CHECKs da 031: `chk_logs_auditoria_plataforma_contexto_objeto`, `_tamanho`) |
| `dados_anteriores` | JSONB | sim | 029 | protegido (031) |
| `dados_novos` | JSONB | sim | 029 | protegido (031) |
| `ator_tipo` | VARCHAR(20) | não | 048 | DEFAULT `'ADMINISTRADOR'`; `chk_logs_auditoria_plataforma_ator_tipo` IN (`ADMINISTRADOR`, `OPERACAO_CLI`, `SISTEMA`); `chk_…_ator_coerente` (administrador presente só com ADMINISTRADOR) |
| `administrador_afetado_id` | INTEGER | sim | 048 | FK `administradores_plataforma(id)` ON DELETE RESTRICT; `chk_…_alvo_distinto_do_ator` |
| `criado_em` | TIMESTAMPTZ | não | 029 | DEFAULT now() |

Índices: `idx_logs_auditoria_plataforma_administrador_id`, `_empresa_afetada_id`, `_criado_em` (029); `_administrador_afetado_id` (048).
Gatilhos: `trg_logs_auditoria_plataforma_bloquear_update|delete|truncate` e `trg_logs_auditoria_plataforma_bloquear_dado_sensivel` (029, reutilizando as funções de 012/014).
Escritor único: `backend/src/repositories/auditoria-plataforma.repository.js` (`registrar`, `registrarOperacaoCli`, `registrarEventoSistema`; o executor de backup grava eventos `SISTEMA` por `registrarEventoSistema`, D-F13).

## `logs_auditoria_identidade` — trilha da identidade global (064)

| Coluna | Tipo | Nulo | Origem | Observação |
|---|---|---|---|---|
| `id` | BIGINT IDENTITY | não | 064 | PK |
| `identidade_id` | INTEGER | não | 064 | FK `identidades(id)` ON DELETE RESTRICT |
| `ator_tipo` | VARCHAR(20) | não | 064 | `chk_logs_auditoria_identidade_ator_tipo` IN (`IDENTIDADE`, `SISTEMA`) |
| `acao` | VARCHAR(60) | não | 064 | |
| `referencia` | VARCHAR(150) | sim | 064 | |
| `descricao` | TEXT | sim | 064 | |
| `ip` | VARCHAR(45) | sim | 064 | |
| `dispositivo` | VARCHAR(150) | sim | 064 | |
| `contexto`, `dados_anteriores`, `dados_novos` | JSONB | sim | 064 | protegidos (`chk_logs_auditoria_identidade_*_objeto`, `_tamanho`) |
| `criado_em` | TIMESTAMPTZ | não | 064 | DEFAULT now() |

Gatilhos: `trg_logs_auditoria_identidade_bloquear_update|delete|truncate` e `trg_logs_auditoria_identidade_bloquear_dado_sensivel` (064).
Escritor único: `backend/src/repositories/auditoria-identidade.repository.js` (`registrarDaIdentidade`, `registrarEventoSistema`).

## Migration 097 — PENDENCIA-SEG-TRG04

`097_alter_logs_auditoria_chave_sensivel_sem_separador.sql`: um único `CREATE OR REPLACE FUNCTION logs_auditoria_chave_json_e_sensivel`.
Não toca tabela, gatilho, outra função nem migration histórica; por ser chamada pelo nome, a regra nova vale nas três trilhas ao
mesmo tempo. Provas: `test/db/migration-097-estatico.test.js` (sem banco: forma, manifesto, listas idênticas ao espelho JS),
`test/utils/chave-json-sensivel.test.js` (espelho), `test/integracao/migration-097-chave-sensivel-sem-separador.integration.js`
(PostgreSQL real em schema temporário, inclusive banco × JS sobre corpus gerado). Aplicação em banco persistente: só pelo gate de
migrations autorizado; a 014 continua histórica e imutável.

## Como manter

Toda migration que crie ou altere tabela, coluna, restrição, índice, função ou gatilho destas trilhas acrescenta aqui a linha
correspondente com o número da migration. Palavras das listas sensíveis mudam SEMPRE em dupla: SQL (nova migration) e
`chave-json-sensivel.js`; o teste estático da migration mais recente exige igualdade.
