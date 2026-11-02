# Segurança, autenticação, RBAC e privacidade

Preparado em 02/11/2026 para revisão. Base técnica local: `efea5bad7fd433f699b78831a01c69866438f2ab`.
Não comprova GitHub remoto, banco aplicado ou runtime ativo.

Isolamento por empresa em toda operação; empresa e ator vêm do contexto autenticado,
nunca de entrada controlável pelo cliente quando deriváveis. RBAC efetivo no servidor,
com validação no serviço quando o contrato exigir. Não presumir autoridade pelo nome
do perfil. MASTER nunca aprova, reprova ou encerra solicitações de EPI (K2).
Sessão opaca; SHA-256 do token no banco; Argon2id para senhas; HMAC-SHA-256 para
cooldown; secrets somente em ambiente/gestão adequada. Não expor credenciais,
hashes, dados sensíveis, SQL ou stack em resposta/log. Portal, Painel e dispositivo
possuem fronteiras próprias. Demonstração usa dados sintéticos, sem transformar
protótipos em bypass de autenticação. Preservar MFA, Turnstile e proteção de origem.

## Contratos gerais preservados

### Origem CLAUDE §14 — linha 400

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 14. Multiempresa

O sistema é multiempresa.

Preservar isolamento entre tenants em todas as operações.

Nunca confiar em `empresa_id` ou `usuario_id` fornecidos pelo cliente quando esses valores puderem ser obtidos:

- da sessão;
- do usuário autenticado;
- do contexto do servidor;
- de uma relação persistida.

Não permitir associação de registros entre empresas diferentes.

FKs compostas criadas para garantir isolamento multiempresa não devem ser removidas ou enfraquecidas.

---

### Origem CLAUDE §15 — linha 419

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 15. Autenticação

A autenticação utiliza sessões mantidas no servidor.

O navegador deve receber somente um token opaco aleatório.

O token em claro:

- não deve ser persistido no banco;
- não deve ser logado;
- não deve aparecer em auditoria;
- não deve aparecer em mensagens de erro.

No banco deve existir somente o hash do token de sessão.

---

### Origem CLAUDE §16 — linha 436

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 16. Senhas

Senhas devem utilizar:

```text
Argon2id
```

Nunca armazenar senha em texto.

Nunca logar:

- senha;
- confirmação de senha;
- hash da senha;
- parâmetros internos desnecessários relacionados à credencial.

Consultas que não precisam autenticar usuário não devem retornar `senha_hash`.

O hash deve chegar somente ao serviço responsável pela verificação da senha.

---

### Origem CLAUDE §17 — linha 459

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 17. Enumeração de usuários e empresas

Falhas de autenticação devem evitar revelar externamente se existe:

- empresa;
- usuário;
- e-mail;
- usuário inativo;
- empresa inativa.

Quando aplicável, usar resposta pública genérica.

Diferenças internas podem existir para auditoria e segurança, mas não devem permitir inferência confiável pelo cliente.

Quando usuário/e-mail não existir, utilizar hash Argon2 fictício com parâmetros equivalentes ao hash real para reduzir diferenças de timing.

---

### Origem CLAUDE §18 — linha 477

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 18. Cooldown de login

O controle persistente utiliza:

```text
chave_cooldown
```

A chave deve ser derivada utilizando:

```text
HMAC-SHA-256
```

sobre os identificadores normalizados definidos pela arquitetura.

A composição atual é conceitualmente:

```text
CNPJ normalizado
+
separador não ambíguo
+
e-mail normalizado
```

Senha, hash de senha, token ou cookie nunca participam da composição.

---

### Origem CLAUDE §19 — linha 507

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 19. Segredo do HMAC

O segredo do cooldown deve vir de:

```text
LOGIN_COOLDOWN_HMAC_SECRET
```

O segredo:

- nunca deve ser persistido;
- nunca deve ser logado;
- nunca deve aparecer no Git;
- nunca deve ser colocado com valor real em `.env.example`;
- deve possuir entropia adequada.

Em produção, utilizar mecanismo apropriado de gestão de secrets.

Troca do segredo invalida na prática as chaves de cooldown existentes e deve ser considerada operação controlada.

---

### Origem CLAUDE §20 — linha 529

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 20. Concorrência do cooldown

Tentativas concorrentes para a mesma `chave_cooldown` devem ser serializadas.

A estratégia definida é utilizar transação PostgreSQL com advisory transaction lock por chave.

Preferir derivação de lock com espaço de 64 bits.

Evitar limitar a derivação a apenas 32 bits quando houver alternativa segura com 64 bits.

A operação crítica deve considerar, dentro da mesma sequência transacional:

- consulta de cooldown ativo;
- contagem de falhas;
- registro da tentativa;
- eventual ativação do cooldown.

O objetivo é impedir que requisições simultâneas burlem o limiar.

---

### Origem CLAUDE §21 — linha 550

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 21. Cooldown ativo

Durante cooldown:

- responder conforme política definida;
- não verificar senha desnecessariamente;
- não registrar uma nova linha `login_tentativas` para cada requisição;
- evitar que atacante prolongue indefinidamente o cooldown;
- evitar crescimento descontrolado da tabela.

Registrar somente eventos relevantes, como ativação do cooldown.

---

### Origem CLAUDE §22 — linha 564

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 22. Auditoria

Nunca enviar `req.body` bruto para auditoria.

Usar campos explicitamente selecionados.

A tabela `logs_auditoria` possui proteção adicional no PostgreSQL contra chaves JSON sensíveis.

Não contornar essa proteção.

Campos de auditoria devem conter somente informações necessárias para rastreabilidade.

---

### Origem CLAUDE §23 — linha 578

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 23. Dados proibidos em auditoria

Nunca colocar em `logs_auditoria`:

- senha;
- senhas;
- password;
- passwd;
- pwd;
- passphrase;
- senha_hash;
- password_hash;
- token;
- token_hash;
- access token;
- refresh token;
- JWT;
- bearer token;
- cookie;
- Authorization;
- secret;
- segredo;
- API key;
- private key;
- chave privada;
- credencial;
- OTP;
- TOTP;
- outros segredos equivalentes.

---

### Origem CLAUDE §24 — linha 610

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 24. Logs técnicos

Logs técnicos devem ser estruturados.

Não logar:

- `req.body` bruto;
- senha;
- hash de senha;
- token;
- cookie;
- cabeçalho `Authorization`;
- secrets;
- credenciais;
- conteúdo sensível desnecessário.

Para correlação de login, preferir identificador pseudônimo derivado da `chave_cooldown`.

A referência definida é utilizar os primeiros:

```text
16 caracteres hexadecimais
```

da chave quando apropriado.

Não armazenar CNPJ e e-mail em claro em logs quando não houver finalidade funcional legítima.

---

### Origem CLAUDE §25 — linha 640

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 25. Logs controláveis por atacante

Eventos que possam ser provocados em alto volume por cliente externo devem possuir:

- rate limit;
- amostragem;
- agregação;
- supressão controlada;

quando necessário.

Não transferir um problema de crescimento do banco para crescimento ilimitado de logs.

Eventos como tentativas repetidas durante cooldown não devem gerar volume ilimitado.

---

### Origem CLAUDE §26 — linha 657

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 26. Segurança HTTP

A segurança HTTP deve utilizar componentes consolidados quando apropriado.

Tecnologias previstas:

- Helmet;
- CORS controlado;
- cookies seguros;
- CSRF quando aplicável;
- express-rate-limit;
- limite de payload;
- validação Zod.

Não liberar CORS genericamente em produção.

Quando `credentials` estiver habilitado, utilizar allowlist explícita de origens.

---

### Origem CLAUDE §27 — linha 677

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 27. Cookies de sessão

O projeto utiliza `cookie` diretamente.

Não instalar `cookie-parser` sem nova justificativa.

O token de sessão é opaco e validado pelo hash persistido.

Não há necessidade de assinar o cookie apenas para substituir a validação do token.

Cookies de autenticação devem considerar:

- `HttpOnly`;
- `Secure` em produção;
- `SameSite` adequado;
- escopo de path;
- expiração apropriada.

---

### Origem CLAUDE §28 — linha 697

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 28. Validação de entrada

Utilizar Zod para validação centralizada.

Erros de validação enviados ao cliente não devem incluir valores sensíveis recebidos.

Preferir informar:

- campo;
- caminho;
- regra violada;
- mensagem segura.

Não devolver payload bruto do usuário em erro.

---

### Origem CLAUDE §29 — linha 714

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 29. Tratamento de erros

Erros HTTP devem utilizar estrutura consistente.

Não expor ao cliente:

- stack trace;
- SQL;
- estrutura interna;
- caminhos locais;
- secrets;
- informações que facilitem enumeração.

Erros inesperados devem ser registrados internamente de forma segura e retornar mensagem pública genérica apropriada.

---

### Origem CLAUDE §30 — linha 731

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 30. Variáveis de ambiente

Secrets devem vir de variáveis de ambiente ou serviço de secrets.

`.env.example` pode conter apenas:

- nome da variável;
- valor fictício seguro;
- orientação de geração;
- descrição.

Nunca inserir segredo real em `.env.example`.

Nunca commitar `.env` real.

---

### Origem CLAUDE §40 — linha 913

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 40. Seeds

Seeds de desenvolvimento não devem conter secrets reais.

Senhas iniciais devem seguir política explícita e segura.

Não colocar credencial de produção em:

- seed;
- código;
- documentação;
- teste;
- fixture;
- commit.

---

### Origem CLAUDE §41 — linha 930

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 41. RBAC

Permissões devem ser verificadas no servidor.

Nunca confiar apenas no frontend para restringir ação.

O frontend pode ocultar controles conforme perfil, mas o backend deve validar autorização novamente.

Manter clara distinção entre:

- autenticação;
- autorização;
- perfil;
- ação;
- recurso.

---

### Origem CLAUDE §42 — linha 948

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 42. Usuários inativos

Usuário inativo não deve conseguir autenticar ou continuar utilizando sessão conforme política definida.

A resposta pública de falha deve permanecer genérica quando necessário para evitar enumeração.

A distinção detalhada pode existir apenas em auditoria e controles internos seguros.

---

### Origem CLAUDE §43 — linha 958

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 43. Sessões

Uma sessão válida deve respeitar simultaneamente as regras estabelecidas pela arquitetura, incluindo:

- não estar revogada;
- não estar expirada;
- respeitar expiração por inatividade;
- usuário continuar ativo;
- empresa continuar ativa.

Logout e eventos de segurança devem revogar sessão conforme necessário.

Troca de senha deve considerar revogação das sessões existentes conforme política definida.

---

### Origem CLAUDE §44 — linha 974

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 44. Dados pessoais

Minimizar armazenamento de dados pessoais.

Não armazenar informação em claro quando uma representação pseudônima atender à finalidade técnica.

Aplicar retenção limitada a dados operacionais de segurança quando apropriado.

Exemplo:

```text
login_tentativas
```

possui retenção prevista e não deve virar histórico permanente desnecessário.

---

### Origem CLAUDE §48 — linha 1034

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 48. Código de segurança

Para funcionalidades criptográficas:

- utilizar bibliotecas consolidadas;
- não implementar criptografia caseira;
- utilizar APIs seguras do Node;
- utilizar comparação apropriada quando necessário;
- utilizar geração criptograficamente segura de tokens;
- documentar parâmetros relevantes.

---

### Origem CLAUDE §49 — linha 1047

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 49. Token de sessão

Token de sessão deve ser gerado com fonte criptograficamente segura.

A arquitetura prevê token opaco de alta entropia.

O banco recebe apenas:

```text
SHA-256(token)
```

em formato hexadecimal conforme contrato da migration.

O token original existe apenas onde for estritamente necessário durante a autenticação/sessão.

---

### Origem CLAUDE §50 — linha 1065

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 50. Normalização

Normalizações usadas para identidade e segurança devem ser centralizadas.

Evitar duplicar regras de normalização em controllers diferentes.

Normalizações relevantes incluem:

- CNPJ;
- e-mail;
- identificadores utilizados no cooldown.

A mesma entrada deve gerar a mesma representação normalizada em qualquer ponto do sistema.

O CNPJ canônico possui 14 posições. As 12 primeiras aceitam `0-9` e `A-Z`. As duas últimas são numéricas.

A aplicação normaliza letras para maiúsculas antes de qualquer comparação ou persistência. O banco persiste somente a representação canônica e recusa minúsculas, de modo que exista uma única forma armazenada.

A migration `016_alter_empresas_cnpj_alfanumerico.sql` implementa a restrição estrutural correspondente em `empresas.cnpj`. Ela verifica apenas o formato. A conferência dos dígitos verificadores é responsabilidade da aplicação, não da constraint.

---

### Origem CLAUDE §52 — linha 1111

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 52. SQL

Queries devem ser parametrizadas.

Nunca concatenar entrada do usuário diretamente em SQL.

Utilizar parâmetros do driver `pg`:

```text
$1
$2
$3
```

Não criar SQL dinâmico inseguro.

---

### Origem CLAUDE §53 — linha 1129

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 53. Limites

Entradas devem possuir limites explícitos quando apropriado:

- tamanho do body;
- tamanho de strings;
- número de itens;
- tamanho de JSON;
- frequência de requisições.

Não confiar somente no limite do banco.

Aplicação e banco podem possuir camadas complementares de proteção.

---

### Origem CLAUDE §54 — linha 1145

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 54. Respostas HTTP

Utilizar códigos HTTP coerentes.

Exemplos:

```text
200 / 201 — sucesso
400 — entrada inválida
401 — autenticação inválida ou ausente
403 — autenticado sem autorização, quando apropriado
404 — recurso não encontrado
409 — conflito
429 — limite/cooldown
500 — erro interno
503 — indisponibilidade temporária
```

Evitar códigos que revelem existência de usuário/empresa durante autenticação quando isso comprometer proteção contra enumeração.

---


## S63-054 — origem CLAUDE.md:1478–1478

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

Anti-enumeração: a solicitação que não pertence ao solicitante autenticado é "não encontrada" no cancelamento, inclusive dentro da mesma empresa: exatamente o mesmo 404 `SOLICITACAO_NAO_ENCONTRADA` (status e corpo) da inexistente e da de outra empresa, sem revelar que o id existe nem quem a criou. A própria solicitação fora de `PENDENTE` continua 409, e sem `request.editar` a autorização central responde 403 antes do domínio. Nas demais operações, a solicitação ou o usuário de outra empresa dá o mesmo 404 do inexistente.


## S63-055 — origem CLAUDE.md:1480–1480

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

Auditoria da solicitação e do vínculo: identificadores, status e indicadores booleanos, sem texto livre, na mesma transação do ato. A observação da criação, a justificativa do cancelamento, a do encerramento e o motivo do vínculo ficam só no registro de negócio; a auditoria registra só se foram informados (`temObservacao`, `comJustificativa`, `comMotivo`), nunca o conteúdo, nem em `descricao`, nem em `contexto`, nem em `dados_anteriores` ou `dados_novos`.


## S63-083 — origem CLAUDE.md:1601–1601

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

Segurança do Atendimento Token (síntese das Etapas B a G e J2a; nada aqui é regra nova):


## S63-084 — origem CLAUDE.md:1603–1610

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **Duas credenciais, nunca misturadas:** a do TABLET (cookie `gepi_tablet`, persistente, emitida pela ativação, rotacionada a cada 24 h, com a anterior válida só na carência de 120 s; `credencial_hash` e `credencial_anterior_hash`, nunca o valor em claro no banco; fora da carência a anterior é recusada com `REUSO_CREDENCIAL`, sem revogar) e a do ATENDIMENTO (cookie `gepi_atendimento`, temporário, 60 s deslizantes). A credencial do tablet não é sessão administrativa, não identifica funcionário e não concede privilégio: popula `req.dispositivo`, nunca `req.usuario`/`req.sessao`; o middleware lê SÓ o cookie do tablet (ausente ou duplicado = ausente), nunca `Authorization`, cabeçalhos `X-*` ou query. A Central usa sessão administrativa e RBAC; nenhuma credencial de dispositivo no admin.
- **Rede:** a origem é só o `req.ip` resolvido pelo servidor (`TRUST_PROXY_HOPS`); IP_FIXO exato; TUNEL negado sem atestação; a rede é decidida ANTES da rotação (nunca se emite credencial a origem não autorizada); desativar a rede bloqueia o tablet (403) sem revogar. Nada confia em User-Agent, tamanho de tela ou sistema operacional.
- **Isolamento por empresa:** toda tabela da 086 referencia por FK composta `(empresa_id, …)`; empresa, tablet, funcionário e GHE vêm sempre do servidor (credencial, atendimento e cadastro); respostas únicas 401 `ATENDIMENTO_INVALIDO` e 404 `FUNCIONARIO_NAO_IDENTIFICADO` não revelam existência, dono nem causa; na Central, id de outra empresa recebe o mesmo 404.
- **Travas e transações:** ordem idempotência → tablet → atendimento → trabalhador → materiais → numeração (compatível com C, D e 12G); a credencial apresentada é reconferida sob a trava do tablet (a antiga nunca abre nem opera atendimento); consultas E e G em `READ ONLY REPEATABLE READ`, sem renovar nem escrever.
- **Pedidos:** um pedido por atendimento; sem estoque, reserva, baixa ou ficha até a entrega; motivos restritos; 1 a 20 itens com `ITEM_REPETIDO`; duplicidade por item só no Totem (409 `ITEM_JA_SOLICITADO`); a chave de idempotência vai no caminho de `GET /pedidos/:chave` (risco de log de proxy registrado, mitigado no cliente pelo `TotemHttp`); recuperação só na vida do cookie (D-F6).
- **Limites (D-C8):** por IP folgados (`LIMITE_ATIVACAO_POR_IP` 30 por 60 s; `LIMITE_ESTADO_POR_IP`) e finos por tablet com chave do servidor; identificação 10 por 60 s por tablet; tudo em memória do processo (limitador distribuído é pendência).
- **Eventos e auditoria:** `token_dispositivo_eventos` append-only (`REDE_RECUSADA` e `REUSO_CREDENCIAL` com supressão em `token-evento-controle.repository.js`; o heartbeat não grava evento por batida); credencial, código e chave nunca aparecem em auditoria, eventos ou logs (reforço S1–S3 da B; gatilho da 014).
- **Implantação (pendente):** D-C9 SameSite=Strict para `gepi_tablet`; manter o prefixo `/api` no caminho público (Path do cookie); mesmo site para UI e API; HTTPS; MDM/atestação; `TRUST_PROXY_HOPS` exato.


## S63-088 — origem CLAUDE.md:1624–1627

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **Matriz efetiva (estado de 15/10/2026 antes do K2; a rota e o avaliador genérico não mudaram; reconstruída em toda a cadeia: frontend, rota, middleware, controller, serviço, repositório e banco):** `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO` e `ENCERRAR_SOLICITACAO` exigem SST (`exige_sst = true`) e são OBRIGATORIA (migration 017 para aprovar e reprovar; 068 para encerrar). Para ADMINISTRADOR, SUPERVISOR e USUARIO a rota exigia vínculo SST (linha em `vinculo_sst`), concessão individual da ação (o grupo nunca é consultado nesse modo e não pode gravá-la) e nenhum bloqueio individual. O MASTER era decidido pela linha do perfil, ainda sujeito a bloqueio individual: o avaliador genérico dispensa dele o vínculo SST e a concessão individual (`exigeSst && !ehMaster`; o ramo do MASTER vem antes do modo OBRIGATORIA) e ignora o grupo. Ele não decidia apenas porque o provisionamento (`ESCOPO_PROVISIONAMENTO_MASTER`) não grava a linha das três ações.
- **Constatações:** não havia contorno: a decisão e o encerramento têm um único ponto de escrita, o serviço (`decidirSolicitacao` e `encerrarSolicitacao`), chamado só pelo controller, e o Token só cria pedidos `PENDENTE` de origem `AUTOATENDIMENTO`. Mas a autoridade vivia só na rota: o serviço não conhecia o perfil nem revalidava vínculo SST, concessão ou bloqueio (a RED do K2, com 27 de 33 falhas sem a proteção, corrobora). O banco confere a autodecisão (`chk_solicitacoes_epi_decisor_diferente_do_solicitante`, só para a origem `USUARIO_INTERNO`) e o isolamento por empresa (FK composta), mas não o perfil nem o vínculo SST.
- **Divergência:** a regra permanente de negócio (o MASTER nunca aprova, reprova nem encerra) estava protegida só pela ausência de dado no provisionamento, e não por regra no código: uma linha de perfil MASTER × ação o faria passar sem vínculo SST nem concessão (o teste existente `autorizacao-routes.integration.js` afirma esse contrato do avaliador genérico, que por isso não foi tocado). É a fragilidade latente que a Central (Etapa H) transferiu à K, com a regra do avaliador mantida (termo da H, 13/10/2026: avaliar na K, sem alterar a regra); por decisão do responsável de 15/10/2026 o K2 a trata no serviço, e o avaliador genérico permaneceu intacto. O K2 está pendente de validação com PostgreSQL e de homologação, e o item P-13 de "Pendências transversais remanescentes" continua registrado até lá.
- **Decisão aprovada pelo responsável (15/10/2026):** os cinco pontos estão nos bullets do K2 abaixo: (1) a regra permanente do MASTER e (2) a autoridade exigida de quem não é MASTER ("Regra permanente" e "Revalidação obrigatória"); (3) o que permanece, inclusive `AUTODECISAO_PROIBIDA`, e (4) o fluxo do Totem ("Preservado", e ainda: o trabalhador não cancela no Totem e a criação do pedido não muda); (5) o avaliador RBAC genérico não é alterado. Diretriz de arquitetura da V7, **Opção 2**: autorização obrigatória dentro do serviço, sem parâmetro opcional que permita omitir a proteção, reutilizando `avaliarPermissaoAcao` sobre o `client` da transação.


## S63-090 — origem CLAUDE.md:1631–1636

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **Regra permanente (decisão do responsável, 15/10/2026):** o MASTER administra o sistema, os usuários e as permissões, mas **nunca aprova, reprova nem encerra** solicitações de EPI, mesmo que receba permissão indevida (linha de perfil, concessão individual e vínculo SST). A proibição está no código do serviço, e não só na ausência de concessão no provisionamento (o K1 constatou que antes era só proteção de dado: o avaliador genérico dispensa o vínculo SST do MASTER).
- **Revalidação obrigatória no serviço:** `decidirSolicitacao` e `encerrarSolicitacao` (`services/solicitacao-epi.service.js`) revalidam a autoridade dentro da transação, depois da trava da solicitação, pela política EFETIVA já existente (`avaliarPermissaoAcao` do middleware, sobre o `client` da transação). Quem não é MASTER precisa do vínculo SST ativo, da concessão efetiva de cada ação que o ato usa (aprovar = `APROVAR_SOLICITACAO`, reprovar = `REPROVAR_SOLICITACAO`, decisão mista = as duas, encerrar = `ENCERRAR_SOLICITACAO`) e de nenhum bloqueio individual. O perfil vem da linha do ator no banco, nunca de argumento, e não existe parâmetro que permita omitir a proteção. A recusa é o mesmo 403 `PERMISSAO_NEGADA`, sem gravar nada. O avaliador RBAC genérico, o controller, o provisionamento do MASTER, as rotas, o frontend e o Totem não mudaram.
- **Preservado:** `AUTODECISAO_PROIBIDA` é conferida ANTES da nova checagem e vale para todo perfil, MASTER inclusive; o autoencerramento continua permitido a quem tem a autoridade; isolamento por empresa, estados, auditoria e travas; a SST aprova e reprova normalmente os pedidos originados no Totem (origem `AUTOATENDIMENTO`, sem solicitante). O Totem não ganha autoridade e nenhum cancelamento novo foi criado.
- **Testes e fixtures:** teste unitário novo `test/services/solicitacao-epi-autoridade.service.test.js` (34 testes; a política real roda e só os dados dos repositórios são simulados): RED com 27 de 33 falhas sem a proteção, GREEN 34 de 34; o teste unitário existente do serviço foi ajustado (ator da SST simulado e etapa de autoridade na ordem do encerramento); unitários relacionados 119 de 119; suíte unitária completa com 3644 testes e 7 falhas, todas por arquivos duplicados com sufixo "2" do working tree local. A suíte de integração `test/integracao/solicitacao-epi-autoridade-k2.integration.js` (30 testes, pela rota e pelo serviço) foi escrita e **NÃO foi executada**. Fixtures: `montarMundoDoServico` passou a conceder o vínculo SST e as três ações a `sst1`, `sst2` e `sstB`; três suítes de vínculo e a de autorização do encerramento limpam essa autoridade quando testam o próprio vínculo; três suítes que encerravam como MASTER passaram a usar a SST. Quinze arquivos no total (um de produção); a conferência pré-Git de 15/10/2026 achou, por leitura, três cenários em `solicitacao-epi-decisao.integration.js` e `solicitacao-epi-encerramento.integration.js` que decidiam ou encerravam com ator sem autoridade, corrigidos com autorização da V7 para usar SST autorizada sem mudar a finalidade (K2-01, seção 9): **17 arquivos técnicos no total**, ainda sem execução em PostgreSQL.
- **Ressalvas das baselines F e G:** três fixtures do Token (`token-pedido.integration.js`, `token-solicitacoes.integration.js` e `helpers/token-solicitacoes.js`) tiveram, em revisão controlada, só o ator MASTER das chamadas de decisão e encerramento trocado por SST autorizado; nenhuma asserção mudou e os termos F e G ficam intactos (hashes anteriores e atuais no adendo K2-02). **Divergência preexistente:** o termo F registra `cff2ed90…` para `token-pedido.integration.js`, mas o arquivo já estava em `1d4c47a8…` antes do K2 (atual `ba6202cf…`), sem explicação nos registros; não bloqueia, isoladamente, a CI. As baselines F e G **não estão re-homologadas**.
- **Estado em 15/10/2026: IMPLEMENTADO — TESTES SEM BANCO APROVADOS — INTEGRAÇÃO POSTGRESQL PENDENTE — NÃO HOMOLOGADO.** Pendências: CI do GitHub (PostgreSQL 16 efêmero) ou execução autorizada no cluster dedicado para a suíte nova, as cerca de 25 suítes que decidem ou encerram pelo serviço e as baselines revistas; aprovação da V7; Git somente do responsável. Riscos residuais: a política não trava as linhas de vínculo e concessão (revogação confirmada depois da avaliação não é impedida); cerca de cinco consultas a mais por ato; possível ator esquecido nos fixtures. O K3 e os demais incrementos da Etapa K não foram iniciados.


## Aplicação e dependências

Consulte [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md).
Não executar procedimentos por constarem nesta proposta.

## Demonstração e custódia pública

O repositório é público conforme informado por Ramires. Não mudar visibilidade
sem aprovação. Demonstração só com dados sintéticos sem vínculo com trabalhadores
ou clientes; contas usam domínio reservado e não pressupõem caixa real. Nenhuma
senha em código/log; não reutilizar credenciais de exemplos históricos públicos.
Entrega de credencial usa canal distinto do endereço do sistema. APP_ENV e
NODE_ENV têm responsabilidades diferentes; configuração proposta historicamente
deve ser conferida no código antes de presumir implementação. Auth, RBAC e tenant
são obrigatórios mesmo em demo. Dados reais exigem auditoria, proteção de backup
e autorização própria. Nunca publicar memória privada, dumps ou chaves.
