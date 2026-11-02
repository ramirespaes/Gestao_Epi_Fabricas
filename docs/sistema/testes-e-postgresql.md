# Testes, PostgreSQL e migrations

Preparado em 02/11/2026 para revisão. Base técnica local: `efea5bad7fd433f699b78831a01c69866438f2ab`.
Não comprova GitHub remoto, banco aplicado ou runtime ativo.

Toda mudança de segurança/autenticação exige positivos, negativos, autorização,
tenant, expiração/revogação, limites e concorrência pertinentes. Migrations usam
PostgreSQL real, schema temporário exclusivo criado pela suíte, search_path
restrito e DROP SCHEMA CASCADE no cleanup inclusive em falha; nunca aplicar no
public. Credenciais vêm do ambiente. Banco persistente não é laboratório.
O banco de teste configurado é gestao_epi_teste_local; nome sozinho não comprova
instância segura. J2a local exige guarda dedicada; CI tem alternativa específica
de prova de instância efêmera por execução, sem liberar bancos arbitrários.
Backend: test:ci tem gate de linhas 75%; frontend não tem gate de cobertura
equivalente na referência examinada. Integração é separada e serializada.
Comandos oficiais são os scripts versionados; não executá-los por constarem aqui.
TDD não deve ser alegado retroativamente. Scanner com resultado zero precisa ter
lido o escopo e um controle positivo; erro de leitura não significa ausência.
No harness DOM, evitar asserção que inspeciona grafo circular de nós; comparar
identidade por predicado com mensagem segura. Validar compatibilidade da receita
com Node e shell efetivos, sem repetir contagens antigas como resultados atuais.

## Contratos gerais preservados

### Origem CLAUDE §11 — linha 316

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 11. Banco de dados

Banco utilizado:

```text
PostgreSQL 16
```

As migrations ficam em:

```text
backend/migrations/
```

Antes de propor SQL, considerar:

- constraints;
- chaves estrangeiras;
- índices;
- concorrência;
- transações;
- locks;
- crescimento de tabelas;
- retenção;
- integridade referencial;
- isolamento multiempresa;
- impacto em dados existentes;
- comportamento em produção.

Não executar migration no banco real sem autorização explícita.

Testes de migration devem observar o seguinte contrato:

- utilizar PostgreSQL real, nunca simulação ou dublê do banco;
- operar, a cada execução, em schema temporário exclusivo criado pela própria suíte;
- manter o `search_path` restrito a esse schema temporário;
- garantir o cleanup com `DROP SCHEMA ... CASCADE`, inclusive quando o teste falha;
- nunca aplicar migrations de teste no schema `public`;
- obter credenciais exclusivamente do ambiente.

Esse contrato não depende de qual instância é usada e deve valer tanto no ambiente local quanto em integração contínua.

Aplicar uma migration ao schema `public` de qualquer banco continua exigindo autorização explícita, separada da autorização para criá-la.

---

### Origem CLAUDE §12 — linha 362

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 12. Migrations históricas

Migrations já incorporadas à `main` devem ser tratadas como histórico imutável.

Não alterar migrations antigas somente para:

- melhorar comentário;
- corrigir estética;
- reorganizar texto;
- atualizar referência de caminho;
- refatorar SQL já aplicado.

Se uma estrutura já aplicada precisar mudar, criar nova migration, salvo decisão explícita em contrário.

**SUPERADO como inventário atual — R05; registro de origem:** existem migrations versionadas de `000` a `077`, que devem ser executadas em ordem crescente de prefixo.

Nota complementar (15/10/2026): a frase acima descreve o estado de 06/10/2026. Em 15/10/2026 **SUPERADO como inventário atual — R05; fotografia daquela data:** o repositório tem **89 migrations, de `000` a `089`, sem `088`**: a numeração `088` foi reservada e **suspensa** por decisão de 11/10/2026 (Atendimento Token, Etapa D: os motivos extras de encerramento do atendimento não foram criados, pela regra "recusar não é encerrar") e não deve ser reutilizada nem preenchida sem decisão explícita. O manifesto `backend/migrations/checksums.json` tem 89 entradas (SHA-256; inventário histórico, R05), conferidas por `npm run db:migrate:verificar` na CI (verde na PR #57, 15/10/2026). A finalidade e a situação de aplicação de cada uma das migrations `079` a `089` estão no bloco "Inventário de migrations `079`–`089`" da seção 63; toda migration nova continua exigindo ajuste autorizado das suítes com lista fixa de migrations e do manifesto.

Estar versionada não significa estar aplicada: o conjunto descreve o histórico do repositório, não o estado de nenhum banco. Depois de incorporadas ao histórico, essas migrations devem ser preservadas.

---

### Origem CLAUDE §13 — linha 384

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 13. Migrations atuais de autenticação

As migrations abaixo fazem parte do contrato atual da autenticação:

```text
013_create_sessoes.sql
014_alter_logs_auditoria_add_dados.sql
015_create_login_tentativas.sql
```

Respeitar as decisões arquiteturais estabelecidas por essas migrations.

Não enfraquecer suas constraints ou garantias sem discussão e autorização explícita.

---

### Origem CLAUDE §38 — linha 867

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 38. Testes

Toda funcionalidade de segurança ou autenticação deve possuir testes adequados.

Testar conforme aplicável:

- caminho de sucesso;
- payload inválido;
- senha inválida;
- usuário inexistente;
- usuário inativo;
- empresa inexistente;
- empresa inativa;
- cross-tenant;
- cooldown;
- rate limit;
- concorrência;
- sessão inexistente;
- sessão expirada;
- sessão revogada;
- usuário inativado após criação da sessão;
- empresa inativada;
- alteração de senha;
- logout;
- logout global;
- RBAC;
- tentativa de acesso sem permissão;
- CSRF;
- CORS;
- limites de payload;
- migrations.

Testes de migration devem rodar contra PostgreSQL real, sempre isolados em schema temporário exclusivo, conforme o contrato da seção 11. Nunca aplicar migrations de teste no schema `public`.

Não adaptar a implementação apenas para fazer teste passar se isso enfraquecer segurança ou arquitetura.

---

### Origem CLAUDE §39 — linha 905

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 39. Testes de concorrência

Funcionalidades dependentes de contagem ou cooldown devem possuir testes concorrentes quando apropriado.

Em especial, verificar que múltiplas requisições simultâneas para a mesma chave não conseguem ultrapassar o limiar antes da ativação do cooldown.

---

### Origem CLAUDE §45 — linha 992

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 45. Retenção e manutenção

Tabelas de alto crescimento devem possuir estratégia de retenção e purga.

Rotinas de manutenção devem:

- operar em lotes;
- utilizar índices adequados;
- evitar locks prolongados;
- evitar exclusões gigantes em uma única transação.

Não criar timer obrigatório dentro do processo principal de produção quando cron/EventBridge ou mecanismo operacional externo for mais adequado.

---

### Origem CLAUDE §46 — linha 1007

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 46. Performance

Ao adicionar índice, justificar a consulta que ele atende.

Evitar índices redundantes.

Ao criar funcionalidade de alta frequência, avaliar:

- custo por requisição;
- número de queries;
- número de índices atualizados;
- locks;
- contenção;
- crescimento do banco.

---

### Origem CLAUDE §47 — linha 1024

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 47. Transações

Operações que dependem de estado consistente devem ser transacionais.

Não separar em múltiplas operações independentes uma sequência cuja atomicidade seja necessária para segurança ou integridade.

Quando houver concorrência relevante, explicar o modelo utilizado.

---


## S63-057 — origem CLAUDE.md:1484–1494

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **`079_alter_logs_auditoria_add_perfil_ator`** (12K-D5, 07/10/2026): `logs_auditoria.perfil_ator VARCHAR(20)`, snapshot do perfil que o ator TINHA no instante do evento, gravado pelo próprio INSERT de `auditoria.repository.registrar` (um ponto só); NULL nos registros anteriores (a leitura mostra "—"); CHECK de formato; sem FK para `perfis` (a FK propagaria `ON UPDATE CASCADE` a linhas append-only); índice `(empresa_id, criado_em DESC, id DESC)` para a trilha por empresa e período. Só ADD COLUMN, CHECK e índice: gatilhos append-only e barreira JSON da 014 intocados. Aplicada a schemas temporários de `gestao_epi_teste_local` e ao descartável `BANCO_PROTEGIDO_93B95A0C`. Suítes com lista fixa só a incluem se a lista tiver a `012`.
- **`080_create_fiscalizacao_pacotes`** (12K-D6, 07/10/2026): tabela imutável de metadados dos pacotes de fiscalização (o ZIP fica no armazenamento, nunca no banco): `GERANDO → CONCLUIDO | FALHA`, estados finais imutáveis (gatilhos bloqueiam DELETE, TRUNCATE e qualquer UPDATE fora de `heartbeat_em` enquanto GERANDO; a identidade do pedido nunca muda), UNIQUE `(empresa_id, chave_idempotencia)` com `requisicao_hash` (mesma chave com outro pedido = 409; FALHA nunca reiniciada com a mesma chave), índice único parcial = um GERANDO por empresa, `escopos` JSONB validado por `fiscalizacao_escopos_validos` (1 a 20 códigos distintos; a lista permitida é do serviço, sem migration por módulo novo), finalidade em CHECK (`OUTRA` exige observação), `perfil_ator` snapshot como na 079, `chave_armazenamento` `<empresa>/pacote-<id>.zip` gerada pelo servidor, `sha256` e `tamanho_bytes` do ZIP. Sem registro, nas evidências lidas, de aplicação a banco persistente protegido.
- **`081_alter_matricula_opcional`** (12K-E): `funcionarios.matricula` e `entregas_epi.trabalhador_matricula` passam a aceitar NULL (CPF continua obrigatório); a UNIQUE `(empresa_id, matricula)` da 006 continua (NULL não colide); CHECK de formato `NOT VALID` em `funcionarios` (vale para toda escrita nova, sem varrer a tabela); o CHECK do snapshot da entrega é substituído pela mesma regra, com a matrícula validada só quando existe; sem backfill; 006 e 058 intocadas. **Sem pasta própria de evidência em `[FONTE_PRIVADA]` e sem registro localizado de homologação manual**; o contrato está nos testes `funcionario-matricula-opcional-{banco,entregas,http}.integration.js` (na importação, a Situação passa a ser obrigatória, "Ativo").
- **`082_create_tipos_material_classificacao_v2`** (decisões de 07 e 08/10/2026): catálogo `tipos_material` por empresa (grupo `EPI | Vestimenta`, 12 grupos de proteção fechados, nome diferente de "outros", `ativo`, `origem BASE | MANUAL`; imutável salvo `ativo`; unicidade lógica por nome normalizado; seed de 26 tipos BASE para cada empresa existente, e a empresa nova recebe o mesmo catálogo no cadastro, pelo serviço, nunca pelo banco); `materiais` ganha `modelo_classificacao` (`LEGADO` para tudo o que existia, `V2` para o novo ou convertido), `categoria_descricao`, `grupo_protecao`, `grupo_protecao_descricao` e `tipo_material_id` com FK composta coerente (empresa, id, grupo, proteção, nome: o banco impede tipo de outro grupo, proteção, empresa ou nome) e CHECKs de V2 e de legado; substitui o CHECK "Outros ⇔ descrição" da 071 (passa a valer só para V2) e o de óculos com grau (V2 = EPI + Proteção ocular; LEGADO pelos três nomes históricos); `entregas_epi_itens.material_grupo_protecao` (snapshot, NULL no existente); **UPDATE `categoria 'Uniforme' → 'Vestimenta'`** (único dado alterado; id, estoque, vínculos e histórico preservados). **Sem pasta própria de evidência e sem registro localizado de homologação manual**; contrato em `migration-082-classificacao-v2.integration.js` e `material-classificacao-v2.integration.js`.
- **`083_alter_ghe_add_codigo_create_ghe_tipos_material`** (GHE, Incremento 1, 09/10/2026): estritamente aditiva, sem backfill: `grupos_homogeneos_exposicao.codigo VARCHAR(30)` canônico (aparado, maiúsculo, único por empresa quando existe; legado NULL; o formato `GHE-` + 3 a 6 dígitos é regra do serviço) e tabela `ghe_tipos_material` (GHE × tipo do catálogo, `OBRIGATORIO | NAO_OBRIGATORIO`, FKs compostas `RESTRICT`, nasce vazia; `ghe_materiais` continua como exceção e legado). Evidência em `[REFERENCIA_HISTORICA_PRIVADA]`. O descartável `BANCO_PROTEGIDO_B4F469D1` estava nela em 12/10/2026.
- **`084_alter_funcionarios_add_situacao`** (Gestão de Funcionários S1, 10/10/2026): `funcionarios.situacao` `ATIVO | AFASTADO | INATIVO` NOT NULL DEFAULT `ATIVO` (backfill `ativo` true → ATIVO, false → INATIVO; ninguém nasce AFASTADO); `ativo` vira coluna GERADA `(situacao = 'ATIVO') STORED`: escrever `ativo` direto é erro 428C9, as duas nunca divergem e quem lê `ativo` (entrega, solicitação, posição de estoque) continua correto; `atualizado_em` preservado (gatilho desligado só durante o backfill, na mesma transação). Evidência `[REFERENCIA_HISTORICA_PRIVADA]` (14/14). Aplicada aos descartáveis `BANCO_PROTEGIDO_B4F469D1` (12/10/2026, junto com 085–087) e `BANCO_PROTEGIDO_8EA96C0A`.
- **`085_insert_acao_exportar_historico_funcionarios`** (Histórico de Funcionários, pacote J, 11/10/2026): só dados: ação `EXPORTAR_HISTORICO_FUNCIONARIOS` (ALTERNATIVA, sem SST, nasce negada; o MASTER a recebe pelo escopo de provisionamento, então bancos existentes precisam de `db:provisionar:master`); a exportação exige esta ação E `employeeHistory.visualizar`. Aplicada, com autorização e backup `pg_dump` prévio, SÓ ao descartável `BANCO_PROTEGIDO_8EA96C0A` (`db:provisionar:master --empresa 1`, auditoria id 885); `BANCO_PROTEGIDO_C4F0400D` sem ela.
- **`086_create_atendimento_token`** (Atendimento Token, Etapa A, 11/10/2026): só estrutura nova (nenhuma tabela existente muda; o pedido do tablet usa a origem `AUTOATENDIMENTO` já prevista na 065): `token_dispositivos` (situação derivada dos carimbos, sem coluna de status; credencial só como SHA-256 mais o hash anterior, para detectar reuso; número de série é inventário, nunca autenticação), `token_ativacoes` (código do QR só como hash, uso único, validade ≤ 10 minutos, um pendente por tablet), `token_atendimentos` (sessão curta do trabalhador, um aberto por tablet; motivos `PEDIDO_ENVIADO | SAIDA | INATIVIDADE | SUBSTITUIDO | DISPOSITIVO_REVOGADO`), `token_redes_autorizadas` (`IP_FIXO | TUNEL`, CIDR; EXCLUDE gist: sub-rede de túnel ativa nunca se sobrepõe a outra), `token_dispositivo_eventos` (append-only, 10 tipos; duração só em `RESTABELECIMENTO`; o heartbeat não grava evento por batida) e `solicitacoes_autoatendimento` (1:1 imutável com a solicitação; gatilho exige origem `AUTOATENDIMENTO` e o mesmo funcionário do atendimento). Toda referência é FK composta `(empresa_id, …)`.
- **`087_insert_acoes_atendimento_token`** (Etapa A): seis ações, nenhuma com SST, todas nascem negadas: `TOKEN_GERAR_ATIVACAO`, `TOKEN_REVOGAR_DISPOSITIVO`, `TOKEN_GERENCIAR_REDES` (**OBRIGATORIA**, como `GERENCIAR_USUARIOS`), `TOKEN_PREVIA_CATALOGO_REAL`, `TOKEN_VISUALIZAR_MONITORAMENTO` e `TOKEN_VISUALIZAR_HISTORICO` (ALTERNATIVA). O recurso `atendimentoToken` (visualizar, criar, editar) não tem linha no banco. A entrada no escopo do MASTER e o enforcement vieram nas Etapas B, C e H; as duas ações de visualização ainda estão fora de `ACOES_COM_EFEITO` (Etapa J). 086 e 087 aplicadas ao descartável `BANCO_PROTEGIDO_B4F469D1` em 12/10/2026 (homologação da Central) e a schemas temporários.
- **`088`**: não existe; suspensa (seção 12).
- **`089_token_dispositivos_queda_suspeita`** (Etapa J, J2a, 13–14/10/2026): só `ADD COLUMN token_dispositivos.queda_suspeita_desde TIMESTAMPTZ` (anulável, sem DEFAULT, backfill, índice, CHECK ou gatilho): primeira observação de silêncio do tablet pelo job de monitoramento, que a lê e a limpa; não é estado visual, não é evento e não confirma queda. Aplicada só a schemas temporários (cluster dedicado `[ENDERECO_LOCAL_DOCUMENTADO]` e `gestao_epi_teste_local`); aplicá-la a banco persistente é pendência (P-07 do checkpoint do Bloco I) e exige autorização própria.


## S63-058 — origem CLAUDE.md:1496–1496

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

Pré-condições de banco por funcionalidade, acumuladas sobre a `078`: Relatório de Auditoria ≥ `079`; Fiscalização ≥ `080`; Gestão de Funcionários e Histórico ≥ `084` (`081` para matrícula opcional; `085` para exportar); cadastro de materiais V2 e GHE × tipo ≥ `083` (`082` para o catálogo); Atendimento Token ≥ `087`; job de monitoramento ≥ `089`. Registro de 12/10/2026: `BANCO_PROTEGIDO_C4F0400D` seguia na `060`. Nenhuma das migrations `079` a `089` foi aplicada a banco de homologação ou produção; aplicar qualquer uma delas continua exigindo autorização separada por banco. Cada migration nova continua exigindo ajuste autorizado das suítes com lista fixa de migrations e do manifesto (`verificar-checksums.js --atualizar`).


## Aplicação e dependências

Consulte [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md).
Não executar procedimentos por constarem nesta proposta.

**R05 — referência da revisão:** a main local identificada em estado-atual.md contém 96 SQL até 096, sem 088 (AD-02). Não prova GitHub atualizado nem banco aplicado. A suspensão da 088 e imutabilidade histórica permanecem.
