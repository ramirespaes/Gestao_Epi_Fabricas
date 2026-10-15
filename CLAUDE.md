# CLAUDE.md — Gestão de EPIs

Este arquivo contém regras obrigatórias para qualquer trabalho realizado neste repositório.

As instruções deste documento devem ser consideradas antes de propor, criar, alterar, excluir, mover, instalar, versionar ou publicar qualquer arquivo do projeto.

---

# 1. Projeto

Sistema web para Gestão de Equipamentos de Proteção Individual — EPIs.

O projeto possui frontend e backend separados por responsabilidade.

Estrutura principal:

```text
gestao-epi/
├── backend/
├── frontend/
├── README.md
├── RFC-V1
├── RFC-V1.md.docx
├── CLAUDE.md
└── .gitignore
```

---

# 2. Backend

O backend está localizado integralmente em:

```text
backend/
```

Tecnologias principais:

- Node.js
- CommonJS
- Express 5
- PostgreSQL 16
- `pg`
- Argon2
- Zod
- Helmet
- express-rate-limit
- cookie
- `otpauth` — MFA TOTP
- `nodemailer` 10.0.13 — transporte SMTP do e-mail transacional
- Supertest para testes HTTP

Nota complementar (15/10/2026): desde 07–11/10/2026 o backend também depende de `yazl` 3.3.1 (ZIP em streaming do Relatório de Fiscalização, 12K-D6), `pdfkit` 0.20.2 e `write-excel-file` 4.1.1 (exportação PDF/XLSX do Histórico de Funcionários, pacote I), instaladas com a análise da seção 31; o `npm audit` ficou igual antes e depois dessas instalações (6 vulnerabilidades anteriores, uma crítica em `proxy-addr` via Express — pendência registrada em `Projetos Bloco/Bloco 12/Historico-funcionarios/I-green/PENDENCIA-SEGURANCA-NPM.txt`; a aplicação não é declarada apta à produção enquanto ela não for avaliada; nunca `npm audit fix` sem autorização). `node-pg-migrate` 9.0.0 consta em `devDependencies` sem uso localizado no código (a confirmar). A lista acima descreve o estado de 06/10/2026 e não foi reescrita.

O arquivo `backend/package.json` utiliza:

```json
"type": "commonjs"
```

Portanto, preservar CommonJS enquanto não houver decisão arquitetural explícita para migração.

Não converter silenciosamente o backend para ESM.

---

# 3. Frontend

O frontend está localizado integralmente em:

```text
frontend/
```

Estrutura principal:

```text
frontend/
├── IMAGEN/
├── css/
│   └── main.css
├── js/
│   ├── db-api.js
│   └── main.js
├── pages/
└── index.html
```

Preservar os caminhos relativos existentes entre:

- `index.html`
- `pages/`
- `css/`
- `js/`

Antes de mover qualquer arquivo ou diretório do frontend, verificar todas as referências de caminho.

Não reorganizar diretórios silenciosamente.

---

# 4. Regra principal de desenvolvimento

Trabalhar sempre em blocos pequenos, independentes e fáceis de revisar.

Não acumular várias funcionalidades diferentes em um único commit.

Cada commit deve representar uma alteração lógica específica.

Separar, sempre que tecnicamente possível:

- migrations;
- dependências;
- configuração;
- autenticação;
- sessão;
- validação;
- segurança HTTP;
- auditoria;
- RBAC;
- usuários;
- manutenção;
- seeds;
- testes;
- documentação;
- reorganização estrutural.

Não transformar uma tarefa pequena em uma grande refatoração sem autorização.

Não ampliar o escopo silenciosamente.

---

# 5. Fluxo obrigatório para alterações

Para cada bloco de trabalho, seguir esta ordem:

1. analisar o estado atual;
2. identificar arquivos envolvidos;
3. explicar a alteração proposta;
4. informar riscos e impactos;
5. mostrar os comandos pretendidos;
6. aguardar autorização;
7. executar somente a alteração aprovada;
8. mostrar `git status`;
9. mostrar o diff relevante;
10. aguardar autorização para staging;
11. executar `git add` somente dos arquivos aprovados;
12. mostrar `git diff --cached`;
13. aguardar autorização para commit;
14. executar somente o commit aprovado;
15. mostrar o resultado do commit;
16. aguardar autorização separada para push;
17. executar o push somente após autorização.

Nunca considerar autorização de uma etapa como autorização automática das etapas seguintes.

---

# 6. Git

Antes de iniciar qualquer bloco relevante, verificar:

```bash
git branch --show-current
git status --short
```

Quando necessário, verificar também:

```bash
git log --oneline --decorate
git diff
git diff --cached
```

Nunca executar automaticamente:

```text
git add .
git add -A
git commit
git push
git commit --amend
git rebase
git reset --hard
git clean -fd
git push --force
git push --force-with-lease
```

Também não excluir branches sem autorização explícita.

Preferir sempre staging específico:

```bash
git add caminho/do/arquivo
```

ou:

```bash
git add arquivo1 arquivo2
```

Antes de cada commit, mostrar exatamente quais arquivos estão staged.

---

# 7. Branches

Nunca desenvolver diretamente na `main`.

Antes de criar uma nova branch:

1. confirmar que o working tree está limpo;
2. trocar para `main`;
3. atualizar:

```bash
git pull --ff-only origin main
```

4. somente então criar a nova branch.

Branches devem ter escopo claro.

Exemplos:

```text
feature/backend-auth
feature/backend-auth-fundacao
feature/frontend-estrutura
chore/claude-instructions
```

Não usar `rebase` em branch já publicada sem autorização explícita.

Não reescrever histórico Git silenciosamente.

---

# 8. Commits

Commits devem ser pequenos e semanticamente claros.

Mensagens devem ser objetivas.

Exemplos:

```text
Cria migration de sessões de autenticação
Cria proteção JSONB dos logs de auditoria
Cria controle persistente de tentativas de login
Adiciona dependências da autenticação
Organiza frontend em diretório próprio
Adiciona diretrizes de desenvolvimento do projeto
```

Evitar mensagens gigantes ou que misturem várias funcionalidades.

Não criar commit sem autorização explícita.

---

# 9. Pull Requests

Pull Requests devem ter escopo pequeno e claro.

Antes de criar uma PR, conferir:

- branch correta;
- working tree limpo;
- commits esperados;
- ausência de arquivos não relacionados;
- ausência de secrets;
- ausência de alterações acidentais.

Não misturar alterações estruturais com funcionalidades quando puderem ser separadas.

---

# 10. Atribuição de IA

Não adicionar atribuição automática de Claude, Anthropic ou qualquer IA em commits, Pull Requests ou documentação.

Nunca adicionar:

```text
Co-Authored-By: Claude
Generated with Claude Code
Claude-Session
```

Também não adicionar:

- links de sessão;
- assinatura automática da Anthropic;
- referências automáticas à ferramenta utilizada;
- qualquer trailer de coautoria gerado por IA.

O autor do Git deve continuar sendo exclusivamente o usuário configurado no repositório.

Não alterar:

```text
git config user.name
git config user.email
```

sem autorização explícita.

---

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

# 12. Migrations históricas

Migrations já incorporadas à `main` devem ser tratadas como histórico imutável.

Não alterar migrations antigas somente para:

- melhorar comentário;
- corrigir estética;
- reorganizar texto;
- atualizar referência de caminho;
- refatorar SQL já aplicado.

Se uma estrutura já aplicada precisar mudar, criar nova migration, salvo decisão explícita em contrário.

Atualmente existem migrations versionadas de `000` a `077`, que devem ser executadas em ordem crescente de prefixo.

Nota complementar (15/10/2026): a frase acima descreve o estado de 06/10/2026. Em 15/10/2026 o repositório tem **89 migrations, de `000` a `089`, sem `088`**: a numeração `088` foi reservada e **suspensa** por decisão de 11/10/2026 (Atendimento Token, Etapa D: os motivos extras de encerramento do atendimento não foram criados, pela regra "recusar não é encerrar") e não deve ser reutilizada nem preenchida sem decisão explícita. O manifesto `backend/migrations/checksums.json` tem 89 entradas (SHA-256), conferidas por `npm run db:migrate:verificar` na CI (verde na PR #57, 15/10/2026). A finalidade e a situação de aplicação de cada uma das migrations `079` a `089` estão no bloco "Inventário de migrations `079`–`089`" da seção 63; toda migration nova continua exigindo ajuste autorizado das suítes com lista fixa de migrations e do manifesto.

Estar versionada não significa estar aplicada: o conjunto descreve o histórico do repositório, não o estado de nenhum banco. Depois de incorporadas ao histórico, essas migrations devem ser preservadas.

---

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

# 21. Cooldown ativo

Durante cooldown:

- responder conforme política definida;
- não verificar senha desnecessariamente;
- não registrar uma nova linha `login_tentativas` para cada requisição;
- evitar que atacante prolongue indefinidamente o cooldown;
- evitar crescimento descontrolado da tabela.

Registrar somente eventos relevantes, como ativação do cooldown.

---

# 22. Auditoria

Nunca enviar `req.body` bruto para auditoria.

Usar campos explicitamente selecionados.

A tabela `logs_auditoria` possui proteção adicional no PostgreSQL contra chaves JSON sensíveis.

Não contornar essa proteção.

Campos de auditoria devem conter somente informações necessárias para rastreabilidade.

---

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

# 31. Dependências

Antes de instalar nova dependência:

1. justificar por que ela é necessária;
2. verificar se funcionalidade equivalente já existe no projeto;
3. verificar compatibilidade com Node;
4. verificar compatibilidade com CommonJS;
5. informar versão proposta;
6. verificar `engines`;
7. verificar peer dependencies;
8. verificar dependências transitivas relevantes;
9. informar arquivos que serão alterados;
10. aguardar autorização.

Não instalar automaticamente `latest` sem análise de compatibilidade.

---

# 32. npm audit

Nunca executar automaticamente:

```bash
npm audit fix
npm audit fix --force
```

Se `npm audit` encontrar vulnerabilidade:

1. mostrar o resultado;
2. explicar impacto;
3. identificar dependência direta ou transitiva;
4. propor solução;
5. aguardar autorização.

Nunca usar `--force` silenciosamente.

---

# 33. Scripts de instalação npm

Pacotes com install scripts devem ser avaliados antes de aprovação explícita.

Não executar comandos adicionais apenas para silenciar warnings.

Se um pacote já funciona corretamente com binário pré-compilado, não aprovar ou executar scripts extras sem necessidade técnica.

---

# 34. Node.js

O ambiente atual de desenvolvimento utiliza Node moderno.

Ao definir `engines`, preferir compatibilidade mínima coerente com o projeto e suas dependências.

Não alterar a versão mínima suportada sem explicar impacto.

A versão mínima aprovada para o backend é Node.js 22 ou superior, declarada em `backend/package.json`:

```json
{
  "engines": {
    "node": ">=22"
  }
}
```

Essa decisão se refere ao backend.

Não adicionar essa configuração silenciosamente.

---

# 35. Alterações de arquivos existentes

Antes de alterar arquivo existente:

- ler seu conteúdo;
- compreender sua função;
- procurar referências;
- verificar dependências;
- verificar efeitos colaterais.

Evitar substituições cegas.

Não alterar arquivo inteiro quando poucas linhas resolvem o problema, salvo quando o arquivo precisa legitimamente ser reestruturado.

---

# 36. Movimentação de arquivos

Antes de mover diretórios ou arquivos:

1. localizar referências;
2. verificar imports;
3. verificar links;
4. verificar scripts;
5. verificar documentação;
6. verificar deploy;
7. verificar GitHub Actions ou CI/CD;
8. verificar caminhos relativos.

Quando apropriado, utilizar `git mv` para preservar claramente o histórico.

---

# 37. Documentação

Atualizar documentação quando uma alteração estrutural tornar instruções antigas incorretas.

Não atualizar documentos históricos apenas por estética.

README deve representar o estado atual do projeto.

RFC deve ser alterado somente quando a mudança for pertinente ao conteúdo ou aos caminhos referenciados.

---

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

# 39. Testes de concorrência

Funcionalidades dependentes de contagem ou cooldown devem possuir testes concorrentes quando apropriado.

Em especial, verificar que múltiplas requisições simultâneas para a mesma chave não conseguem ultrapassar o limiar antes da ativação do cooldown.

---

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

# 42. Usuários inativos

Usuário inativo não deve conseguir autenticar ou continuar utilizando sessão conforme política definida.

A resposta pública de falha deve permanecer genérica quando necessário para evitar enumeração.

A distinção detalhada pode existir apenas em auditoria e controles internos seguros.

---

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

# 45. Retenção e manutenção

Tabelas de alto crescimento devem possuir estratégia de retenção e purga.

Rotinas de manutenção devem:

- operar em lotes;
- utilizar índices adequados;
- evitar locks prolongados;
- evitar exclusões gigantes em uma única transação.

Não criar timer obrigatório dentro do processo principal de produção quando cron/EventBridge ou mecanismo operacional externo for mais adequado.

---

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

# 47. Transações

Operações que dependem de estado consistente devem ser transacionais.

Não separar em múltiplas operações independentes uma sequência cuja atomicidade seja necessária para segurança ou integridade.

Quando houver concorrência relevante, explicar o modelo utilizado.

---

# 48. Código de segurança

Para funcionalidades criptográficas:

- utilizar bibliotecas consolidadas;
- não implementar criptografia caseira;
- utilizar APIs seguras do Node;
- utilizar comparação apropriada quando necessário;
- utilizar geração criptograficamente segura de tokens;
- documentar parâmetros relevantes.

---

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

# 51. Controllers, services e repositories

Preservar separação de responsabilidades.

Preferência arquitetural:

```text
route/controller
    ↓
service
    ↓
repository
    ↓
PostgreSQL
```

Controllers não devem concentrar SQL ou regras complexas de segurança.

Repositories não devem decidir regra de negócio.

Services devem coordenar regras de negócio e segurança.

---

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

# 55. Mudanças arquiteturais

Se uma decisão nova conflitar com arquitetura existente:

1. identificar o conflito;
2. não decidir silenciosamente;
3. explicar alternativas;
4. apontar impacto;
5. recomendar uma opção;
6. aguardar autorização.

---

# 56. Comandos destrutivos

Antes de qualquer comando potencialmente destrutivo, explicar exatamente:

- o que será apagado;
- o que poderá ser perdido;
- se existe backup;
- como reverter.

Nunca executar automaticamente comandos destrutivos.

---

# 57. Banco de produção

Nunca presumir que existe autorização para executar alteração no banco de produção.

Criar migration e executar migration são autorizações diferentes.

Testar SQL localmente não autoriza aplicação em produção.

---

# 58. Secrets e Git

Antes de commit relevante, verificar se arquivos staged contêm acidentalmente:

- `.env`;
- passwords;
- tokens;
- secrets;
- API keys;
- cookies;
- strings de conexão;
- certificados privados;
- chaves privadas.

Se houver suspeita de secret, parar antes do commit.

---

# 59. Working tree

Ao terminar cada bloco, preferir deixar:

```text
nothing to commit, working tree clean
```

Não deixar alterações esquecidas de outro bloco misturadas no working tree.

---

# 60. Comunicação

Antes de qualquer alteração relevante, informar de forma objetiva:

- objetivo;
- situação atual;
- arquivos que serão criados;
- arquivos que serão alterados;
- comandos que serão executados;
- riscos;
- impacto;
- como será validado.

Após executar:

- mostrar resultado;
- indicar arquivos modificados;
- mostrar testes executados;
- mostrar Git status;
- parar antes do próximo passo que exige autorização.

---

# 61. Não executar trabalho futuro automaticamente

Quando um bloco terminar, não iniciar o próximo automaticamente.

Exemplo:

Se o usuário autorizou criar um arquivo:

- criar o arquivo;
- mostrar resultado;
- parar.

Não assumir que isso também autoriza:

- staging;
- commit;
- push;
- criação de PR;
- merge;
- próxima funcionalidade.

---

# 62. Prioridades do projeto

Em caso de conflito entre conveniência e qualidade técnica, priorizar nesta ordem:

1. segurança;
2. integridade dos dados;
3. isolamento multiempresa;
4. prevenção de vazamento de credenciais;
5. rastreabilidade;
6. clareza arquitetural;
7. testabilidade;
8. manutenibilidade;
9. performance;
10. simplicidade operacional.

---

# 63. Solicitação de EPI e reserva lógica de estoque

Decisões do Bloco 12 que valem para as próximas subetapas. A 12A e a 12B estão na `main` (PR #49, merge `0ccf59d47527b58fd656a265a74fd763109fbd45`); a 12C e a 12D (12D-1, 12D-2 e 12D-3) estão concluídas no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7` (`feat(bloco12): concluir entrega por solicitacao e posicao de estoque`); a 12E (consultas, encerramento D6 e migration `068`) e a 12F (camada HTTP) estão na `main` pela PR #51 (merge `cb6b0ccc31005ba0c652fa0c47f1bf40213e79e5`); a 12G está concluída (12G-0 a 12G-9; próxima etapa operacional: 12K): a 12G-0 (lacunas do backend para as telas), a 12G-1 (fundação do frontend), a 12G-2 (Pedido de EPI funcional), a 12G-3 (Aprovação da Segurança do Trabalho funcional, validada com um segundo usuário da SST distinto do solicitante) e a 12G-4 (Entregas por solicitação funcional) estão concluídas, a 12G-1 a 12G-4 com a validação visual aprovada, entregues juntas no commit `b6c85b1a67cecea6fc8d6cc01337d70ec4ba882a` e incorporadas à `main` pelo PR #52 (merge `23d6050bcd494c6f4d7cdc5404572feabe720781`); a 12G-5 (links e navegação SST) está na `main` pelo PR #53 (merge `363f8b30fc927873f5c2cc7bf26d53fa23ef9851`); a 12G-6 (disponibilidade após entrada de estoque, Dashboard, "Gerar alerta" e e-mail consolidado, migration `069`) está concluída na branch `feature/bloco12-fechamento` (validação manual aprovada em 04/10/2026), sem commit (a entrega Git do Bloco 12 é única, no fim, e feita pelo usuário); a 12G-7 (catálogo visual de pictogramas dos materiais, só frontend) está concluída na mesma branch (validação manual aprovada em 04/10/2026 em Materiais, Itens Disponíveis e Validade do Estoque), sem commit; a 12G-8 (grade de tamanhos do material, migration `070`; Categoria → Tipo, "Outros" com descrição própria e tipos de óculos, migration `071`, por rescopo de 04/10/2026) está concluída na mesma branch (validação manual aprovada em 04/10/2026), sem commit; a 12G-9 (importação de funcionários com GHE e importação parcial controlada; escopo fechado em 04/10/2026 só para `import-employees.html` e o backend estritamente necessário) está concluída na mesma branch (validação manual aprovada em 05/10/2026), sem commit; com ela a 12G está concluída e a próxima etapa operacional é a 12K. Planejamento aprovado e congelado: 12G-5, links e navegação SST (completar o que faltar, sem reimplementar o vínculo SST sem antes analisar o estado atual); 12G-6, disponibilidade após entrada de estoque, Dashboard, notificações internas e e-mail consolidado, com o "Gerar alerta"; 12G-7, catálogo visual de ícones e imagens de EPI; 12G-8, cadastro de EPI na Gestão de Estoque (seleção, envio e prévia do ícone e grade de tamanhos); 12G-9, importação de funcionários com GHE e importação parcial controlada (escopo fechado em 04/10/2026; a gestão e edição de funcionários — pesquisa e localização, visualização, alteração autorizada de setor e de função, GHE alterado explicitamente, telefone, situação, inativação e reativação, com histórico obrigatório e sem troca automática de GHE ao mudar setor ou função — é da 12K-E). O encerramento da solicitação já faz parte da 12G-4. A 12J (administração centralizada de usuários e acessos, precedida de diagnóstico completo do RBAC) é futura e não deve ser implementada sem autorização. A 12D integrou às telas existentes o saldo livre na entrega direta, os mínimos, Itens Disponíveis, o Dashboard e o histórico de entregas.

Fluxo: a solicitação é decidida pela **Segurança do Trabalho**, nunca pelo supervisor. Quem decide não pode ser quem solicitou (`AUTODECISAO_PROIBIDA`). A entrega direta do Bloco 10 (`origem = DIRETA`) não pode ser quebrada.

Reserva lógica, derivada:

- não persistir reserva, alocação, contador de saldo, `quantidade_entregue` nem tabela de alocação; a cobertura de cada par (empresa, material, tamanho) é calculada a partir dos lotes e da demanda aprovada pendente;
- o físico utilizável desconsidera lotes de material inativo e de CA ausente ou vencido na data operacional;
- a cobertura segue a ordem de fila `decidida_em`, solicitação, item;
- a aprovação sem estoque é permitida, e a situação exibida da solicitação é derivada (inclusive `SUSPENSA`, quando o trabalhador ou o material do item está inativo); o status gravado não muda por derivação.

Entrega por solicitação (12C): o vínculo fica no item da entrega (`entregas_epi_itens.solicitacao_item_id`, migration 066); a quantidade entregue de um item da solicitação é a soma das entregas ligadas a ele e o pendente é a aprovada menos essa soma, nunca gravados em coluna. A solicitação só passa a `ENTREGUE` quando toda a quantidade aprovada dos itens aprovados foi entregue (itens reprovados não contam), na mesma transação da última entrega, e o banco confere isso no COMMIT nos dois sentidos. Uma entrega atende uma solicitação só, e entrega `DIRETA` e `SOLICITACAO` não se misturam. O gatilho do item da entrega trava a solicitação (`FOR NO KEY UPDATE`) depois dos lotes: nenhum caminho pode segurar a solicitação e esperar um lote.

Serviço da entrega por solicitação (`entrega-solicitacao.service.js`): o chamador informa só solicitação, chave, itens (item da solicitação, lote, quantidade) e confirmação; tudo o que o servidor deriva (trabalhador, material, tamanho, motivo, justificativas, GHE) vem da solicitação e do cadastro, e o item que o traz é recusado. A quantidade do ato é somada por item da solicitação e tem de caber no pendente e na cobertura FIFO, recalculada depois das travas na ordem aprovada; a cobertura é conferida antes do saldo do lote. A justificativa técnica da SST fora do GHE é reutilizada, nunca pedida de novo. Trabalhador ou material inativo torna a solicitação não entregável sem mudar o status histórico. O hash de conteúdo da entrega `DIRETA` não pode mudar byte a byte; o vínculo entra no hash só na entrega `SOLICITACAO`.

Encerramento (D6, 12E-2, migration `068`): a solicitação `APROVADA` ou `APROVADA_PARCIAL` que não será mais entregue é encerrada com justificativa obrigatória (1 a 500, sem só espaços nem controle), e `ENCERRADA` é final. Nada é apagado nem desfeito: entregas, ficha, lotes e operações ficam, a entregue continua derivada, e só a aprovada ainda não entregue sai de D, porque a posição só conta `APROVADA` e `APROVADA_PARCIAL` (sem contador, reserva ou alocação). `ENTREGUE`, `PENDENTE`, `REPROVADA` e `CANCELADA` não são encerradas (409 `SOLICITACAO_NAO_ENCERRAVEL`), e a `ENCERRADA` não recebe entrega (409 `SOLICITACAO_NAO_ENTREGAVEL`). A autoridade é a ação `ENCERRAR_SOLICITACAO` (`exige_sst = true`, OBRIGATORIA), sem concessão automática a ninguém. O autoencerramento é permitido com autoridade válida; `AUTODECISAO_PROIBIDA` vale só para aprovar e reprovar. Travas: solicitação, depois os pares com pendente. A justificativa aparece só no detalhe, para quem pode vê-lo; nunca em lista nem na auditoria. Inativar trabalhador ou material continua só suspendendo, sem encerrar.

Consultas e HTTP (12E-1, 12F): "minhas" (recurso `request`, visualizar; só as do próprio), fila (ação `APROVAR_SOLICITACAO`), entregáveis (ação `REALIZAR_ENTREGA`) e detalhe (quem tem `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO`, `ENCERRAR_SOLICITACAO` ou `REALIZAR_ENTREGA` vê qualquer uma da empresa, com cobertura e posição; quem só tem `request.visualizar` vê só as próprias, sem os números de estoque). Escrita: criar com `request.criar`; cancelar com `request.editar` (nunca `excluir`; o cancelamento não apaga o registro; não existe ação `CANCELAR_SOLICITACAO`); decidir exige `APROVAR_SOLICITACAO` se aprova algum item e `REPROVAR_SOLICITACAO` se reprova algum (a mista exige as duas, compostas a partir da fábrica central, nunca autorização manual); encerrar com `ENCERRAR_SOLICITACAO`; entregar por solicitação com `REALIZAR_ENTREGA`; conceder e remover vínculo SST só pelo MASTER ativo, no serviço. Empresa e ator vêm só da sessão; schemas estritos recusam empresa, solicitante, decisor, encerrador, responsável, status, instantes e hashes vindos do cliente; quem só pede não vê cobertura nem posição. Desde 05/10/2026 (decisão que supera a do 12E/12F: o MASTER tem autoridade máxima na empresa) o recurso `request` (visualizar, criar, editar) entra em `ESCOPO_PROVISIONAMENTO_MASTER` e chega ao MASTER pelo provisionamento normal (cadastro da empresa no Painel Privado e `db:provisionar:master`); as ações `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO` e `ENCERRAR_SOLICITACAO` continuam fora do escopo (exigem vínculo SST, que não se aplica ao MASTER). Para ADMINISTRADOR, SUPERVISOR e USUARIO, `request.*` continua concedido explicitamente por grupo ou exceção individual, nunca pelo nome do perfil. Qualquer banco persistente que sirva essas rotas precisa estar migrado até a `068`.

Para a 12G: menu e botões da solicitação obedecem `visualizar`, `criar` e `editar` e as ações da SST e da entrega; o backend continua validando tudo.

Fundação da 12G-1 (frontend, sem migration, sem rota nova): as três páginas (`request.html`, `supervisor-approval.html` e `stock-requests.html`; ids `request`, `supervisorApproval` e `stockRequests`, sem renomear arquivo) abrem só por `EpiEstadoPagina.montarPaginaProtegida` — o conteúdo protegido nasce oculto (`#conteudoProtegido`), aparece só depois da sessão e das permissões confirmadas e some quando a sessão termina ou muda — e mostram os estados de `js/estado-pagina.js` só como texto (nada de `innerHTML`). Quem abre: Pedido com `request.visualizar` OU `request.criar`; Aprovação com `APROVAR_SOLICITACAO` (a fila exige essa ação no servidor); Entregas com `REALIZAR_ENTREGA` OU `ENCERRAR_SOLICITACAO`; cada escrita é decidida por `EpiSolicitacoesEpi.capacidades`, nunca por um "alterar" geral nem pelo nome do perfil (o MASTER só abre o que as permissões reais dão, e a `REALIZAR_ENTREGA` provisionada abre as Entregas). `js/solicitacoes-epi.js` é a única fonte dos caminhos e da consulta das rotas da solicitação: filtro desconhecido, id, página, limite, status ou previsto inválidos são TypeError antes da rede, busca acima de 100 vira validação local, e toda solicitação não encontrada tem o mesmo texto. `js/permissoes-efetivas.js` exige a área `vinculosSst` (sem ela, nenhuma permissão). Na tela de Permissões do Grupo, `request` oferece Visualizar, Criar e Editar (fora do escopo do MASTER); Aprovação e Entregas mostram que valem as ações.

Pedido de EPI da 12G-2 (`js/pedido-epi.js`, sem migration, sem rota nova): os EPIs oferecidos são só os do contexto com `previstoNoGhe=true` (todas as páginas), copiados campo a campo, sem nenhum número de estoque; o do GHE ainda não classificado (`exigeTamanho` nulo) nunca é opção nem corpo de envio, aparece num aviso que manda definir o tamanho em Materiais, e o GHE só com esses não é chamado de vazio; o tamanho só existe para `exigeTamanho === true`; motivos e limites vêm de `EpiSolicitacoesEpi.MOTIVOS` e `LIMITES_PEDIDO`, iguais aos do backend (conferido por teste), e a justificativa só vai no `OUTRO`. O envio usa `EpiFicha.idempotencia.chavePara` (a mesma chave enquanto o corpo não muda), uma guarda própria contra o segundo POST além do botão desabilitado, e os erros 400 vão para o campo do item pelo caminho `body.itens[i].campo`, sempre com os textos de `POR_CODIGO`, nunca o do servidor. Formulário por `request.criar`, "Meus pedidos" e detalhe por `request.visualizar`, cancelamento por `request.editar` e status `PENDENTE`, com confirmação. Nada vai para armazenamento do navegador.

Aprovação da SST da 12G-3 (`js/aprovacao-sst.js`, sem migration, sem rota nova, sem mudança no backend): fila e detalhe da 12F e uma decisão de TODOS os itens num POST só (`{decisoes: [{itemId, decisao, quantidadeAprovada?, justificativa}]}` na ordem dos itens; o índice do 400 `body.decisoes[i].campo` aponta o item). `rascunho.validar` e `rascunho.resultadoPrevisto` repetem as regras do servidor, sem divergir: aprovar de 1 até a quantidade solicitada; justificativa só quando ele a exige (reprovação, redução, aprovação fora do GHE) e nunca escondida no envio; resultado APROVADA, APROVADA_PARCIAL ou REPROVADA como `resultadoDaDecisao`; se o servidor exigir uma justificativa que a tela não previa, o campo aparece. `rascunho.criadaPor` é a mesma condição de `AUTODECISAO_PROIBIDA` (origem `USUARIO_INTERNO` e solicitante igual ao usuário da sessão): a tela avisa e bloqueia antes, e trata o 403 do servidor; nunca exceção para MASTER. Aprovar exige `APROVAR_SOLICITACAO` e reprovar `REPROVAR_SOLICITACAO`, pelas permissões efetivas (opção sem autorização indisponível). Nenhum número de estoque na tela (o detalhe da SST traz cobertura e posição, que não são exibidas). Os textos dos códigos da decisão ficam em `EpiAprovacaoSst.TEXTOS` (o `SOLICITACAO_NAO_PENDENTE` do Pedido fala de cancelamento). 409 de concorrência fecha a análise e relê a fila; botão desabilitado em cinza pela regra `#conteudoProtegido button:disabled` da página. `AUTODECISAO_PROIBIDA` é absoluta (decisão de 04/10/2026): nenhuma exceção para SUPERVISOR, ADMINISTRADOR ou MASTER, nenhum desvio para teste ou validação e nenhuma permissão de autodecisão; só a 12J pode reavaliar.

Entregas por solicitação da 12G-4 (`js/entregas-solicitacao.js`, sem migration, sem rota nova, sem mudança no backend): a lista vem de `/entregaveis` para quem tem `REALIZAR_ENTREGA` e de `/encerraveis` para quem só tem `ENCERRAR_SOLICITACAO`, nunca das duas por uma ação só. O "disponível agora" de um item é `min(pendente, cobertura.coberta)` do servidor (`rascunho.disponivelAgora`), nunca recalculado do estoque; sem cobertura (suspensa ou reprovada) é zero. Os lotes vêm de `GET /entregas-epi/contexto/:funcionarioId/materiais/:materialId/lotes` só para os itens com algo disponível, filtrados pelo tamanho do item, saldo e `EpiFicha.SITUACOES_CA[...].permitido`, na ordem do servidor (validade do CA); a sugestão FIFO para no disponível agora. O corpo é `{itens: [{solicitacaoItemId, loteId, quantidade}], confirmacao, chaveIdempotencia}`, com a confirmação e a declaração da Ficha; a chave vem de `EpiFicha.idempotencia.chavePara` sobre itens e confirmação. Mudar a entrega ou o modo descarta a confirmação. Falha de rede trava a entrega como incerta (nada se altera, nem se troca de pedido) até "Tentar novamente" (mesmo corpo e chave) ou "Descartar" (relê do servidor). 409 de cobertura, pendente, saldo, lote ou CA relê o detalhe e os lotes e descarta a confirmação. O encerramento repete a validação do servidor (aparar, NFC, 1 a 500 por ponto de código, sem `\p{Cc}`). Nenhuma solicitação é decidida nesta tela; alerta, SMS e compra vinculada seguem "Em integração", com a regra futura em comentário da página.

Navegação da 12G-5 (sem tela nova, sem rota nova, sem mudança no backend e sem migration): os três itens de "Solicitações" e os links do Início do Portal seguem só `EpiPermissoes.PAGINAS` e as permissões efetivas; não criar atalho entre Pedido, Aprovação e Entregas sem decisão. Textos de acesso nunca atribuem o acesso só ao perfil: a mensagem global de acesso negado é a mesma em `EpiPermissoes.MENSAGENS.SEM_ACESSO` e no estado "acesso negado" de `js/estado-pagina.js` (o estado é reconhecido comparando os dois). Só "Aprovar solicitação" abre a Aprovação; "Reprovar solicitação" sozinha não abre. As três telas têm teste próprio da volta pelo histórico: troca de empresa ou de pessoa e permissão retirada recarregam com os dados limpos; sessão encerrada leva ao Portal. **Vínculo SST:** o vínculo SST possui backend e permissões implementados, porém a interface administrativa será tratada dentro da 12J — Administração de Usuários e Acessos, evitando criação de tela transitória na 12G-5; até lá, nada de página, item de menu ou link de vínculo SST, e a configuração para desenvolvimento e revisão continua pela rota `POST /api/vinculos-sst` usada pelo MASTER ativo. **Prova de autoria** é pendência futura obrigatória, ainda sem escopo definido.

Nota complementar (15/10/2026): a frase acima sobre o vínculo SST foi superada em 06/10/2026 (evidências em `Projetos Bloco/Bloco 12/Gestao-Usuarios-SST-aprovacao`, 17:28): o vínculo SST passou a ser ligado e desligado em Novo/Alterar usuário da Gestão de Usuários (`vinculo-sst.service.js`; padrão desligado; só o MASTER ativo; auditado), junto dos toggles `aprovarSolicitacoes` e `reprovarSolicitacoes` (grupo ADMINISTRACAO, modo concessão). O acesso efetivo à aprovação continua exigindo o vínculo SST E a permissão, `AUTODECISAO_PROIBIDA` não mudou e o MASTER não é configurável. Status: testes GREEN (integração 3216, frontend 1873); validação manual específica sem documento localizado. A 12J continua responsável pela matriz por perfil; detalhe no bloco "Toggles e avisos" (Lote 2). A **Prova de autoria** continua pendência obrigatória da fase final.

Avisos e alertas da 12G-6 (migration `069`, sem ação nova de RBAC):

- **Disponibilidade derivada:** "Disponível para entrega" continua calculado do estado real a cada leitura. Proibido gravar flag `DISPONIVEL_PARA_ENTREGA`, cobertura, situação, reserva ou qualquer registro item a item (candidato, "já comunicado", COMUNICADO/IGNORADO por item). A `069` cria só `alertas_estoque_agendamentos` (scheduler/outbox), nunca a verdade operacional; não criar tabela de candidatos com outro nome.
- **Agendamento:** debounce por empresa + tipo (`DISPONIBILIDADE_ESTOQUE_ENTREGA`); o índice único parcial cobre SÓ o `PENDENTE`, para `ENVIANDO`, `AGUARDANDO_RETRY` e `FALHA` conviverem com um `PENDENTE` novo (nunca pôr esses estados na restrição única). A entrada relevante estende o `PENDENTE` (preserva a primeira entrada, atualiza a última e `enviar_apos` ≈ última + `ALERTA_ESTOQUE_JANELA_MINUTOS`, padrão 10); o que já foi reivindicado nunca muda de janela. Estados finais imutáveis; erro só como código técnico.
- **Entrada relevante:** só a ENTRADA de estoque dispara. A entrada é relevante quando algum item do par passa de cobertura 0 para > 0, medida antes e depois numa leitura só (antes = físico menos a quantidade da entrada); aí abre ou estende o `PENDENTE`, sem gravar o item. Entrada não relevante não cria nem estende lote.
- **Travas:** a entrada continua sem trava de par: chave, material (`FOR UPDATE`) e, por último, a linha do agendamento `PENDENTE`. O processador usa `FOR UPDATE SKIP LOCKED` sob uma advisory lock curta só da reivindicação (espaço próprio), um lote por empresa + tipo de cada vez, e conclui só com a marca `reivindicado_em`. Nada disso muda a ordem global de travas.
- **Processamento:** script para cron externo (`npm run alertas:processar`), nunca timer no processo da API. No envio, medir de novo a situação ATUAL da empresa (`resumirCoberturaPorPar`) e resolver os destinatários de novo a cada tentativa. Sem nada disponível: `DESCARTADO` `SEM_DISPONIBILIDADE`; sem destinatário: `DESCARTADO` `SEM_DESTINATARIO`, sem retry; e-mail desativado: `DESCARTADO` `EMAIL_DESATIVADO`. **At-least-once:** `ENVIADO` só quando TODOS os destinatários da tentativa receberam; qualquer falha, inclusive parcial, vai a `AGUARDANDO_RETRY` (2, 5, 15 e 30 minutos) e a `FALHA` na 5ª tentativa, e reenviar a quem já recebeu é aceito (sem tabela por destinatário); `ENVIANDO` abandonado (15 minutos) é retomado. Nunca exatamente uma vez.
- **Destinatários:** automático = ativo + empresa ativa + e-mail de conta utilizável + vínculo SST + `REALIZAR_ENTREGA` efetiva; manual ("Gerar alerta") = ativo + empresa ativa + e-mail + `MOVIMENTAR_ESTOQUE` efetiva, sem vínculo SST. Sempre pela avaliação efetiva das rotas, nunca pelo nome do perfil.
- **Conteúdo:** automático = resumo operacional consolidado por empresa e janela, uma linha por EPI + tamanho com a quantidade disponível agora e quantos pedidos; NUNCA trabalhador, matrícula, CPF, dado médico ou número de pedido (o template recusa campos fora do contrato; o detalhe é da tela Entregas por solicitação). O que segue disponível pode reaparecer no resumo de uma janela seguinte: aceito, porque o aviso é a situação atual e não um histórico por item; não reintroduzir persistência item a item para evitar isso. Manual = pedido, EPI, tamanho, pendente e sem cobertura, sem trabalhador. Texto escapado; link só da URL pública configurada.
- **"Gerar alerta":** rota própria `POST /api/alertas-estoque/falta` `{ solicitacaoId }` (`REALIZAR_ENTREGA`), fora das rotas da solicitação para `js/solicitacoes-epi.js` continuar a fonte única dos caminhos delas; supressão de 30 minutos por ator e pedido pela auditoria `ALERTA_FALTA_ESTOQUE` (só ids e números) sob advisory lock próprio, gravada só quando alguém recebeu. Na tela, `js/alerta-falta-estoque.js` acompanha o detalhe aberto pelo `aoMudarDetalhe` de `js/entregas-solicitacao.js`; o botão só aparece com `REALIZAR_ENTREGA`, só habilita com item aguardando estoque e, desabilitado, fica cinza.
- **Dashboard:** `solicitacoesAguardandoSst` (PENDENTE; `APROVAR_SOLICITACAO`), `solicitacoesAguardandoEstoque` (aprovadas com pendente na fila e NENHUM item coberto agora; `REALIZAR_ENTREGA` ou `ENCERRAR_SOLICITACAO`) e `disponiveisParaEntrega` (aprovadas com ALGUM item coberto agora; `REALIZAR_ENTREGA`). As duas últimas são exclusivas e saem de uma contagem só da fila (`contarSolicitacoesPorCobertura`); o pedido todo suspenso não entra em nenhuma. Sem a ação, `{ permitido: false }`, nunca zero. "Pendências sem estoque" não muda. Os cartões ficam sem atalho até a 12I. Decisões aprovadas em 04/10/2026, fechadas sem mudar o comportamento: **D1** — o pedido com todos os itens pendentes suspensos (trabalhador ou material inativo) fica fora de "aguardando estoque" e de "disponíveis", porque não é falta de estoque nem disponibilidade operacional; acompanhá-lo, se um dia for preciso, será por indicador ou visão própria de bloqueados/suspensos, nunca misturado aos de estoque. **D2** — "aguardando estoque" é de quem tem `REALIZAR_ENTREGA` ou `ENCERRAR_SOLICITACAO` efetiva; sem nenhuma, `{ permitido: false }` e "—" / "sem permissão"; nunca `MOVIMENTAR_ESTOQUE` nem o nome do perfil.
- **Notificação interna** = só os indicadores derivados do Dashboard: nada de sino, inbox, tabela genérica de notificações, lida/não lida, preferências ou popup sem decisão.
- **Pré-condição:** a entrada de estoque lê a fila da solicitação e grava o agendamento: banco persistente usado por este código precisa estar migrado até a `069` (a `069` não foi aplicada a nenhum banco de homologação ou produção; foi aplicada somente ao banco descartável `gestao_epi_validacao_12g6_20261004`, criado exclusivamente para a validação manual da 12G-6); suíte que exercita a entrada monta o schema com `todasAsMigrations()`.

Catálogo visual da 12G-7 (`js/catalogo-visual.js`, só frontend; sem migration, rota, contrato ou campo novo). Validação manual aprovada em 04/10/2026 nas três telas; **baseline congelada**: mudar resolução, pictogramas ou telas exige decisão explícita.

- **Resolução:** tipo conhecido → pictograma do tipo; tipo desconhecido ou "Outro" → o da categoria; categoria desconhecida ou ausente → o genérico. Caixa, acentos e espaços normalizados; o nome nunca escolhe.
- **Segurança:** os onze SVGs são fixos e locais, definidos no módulo, que recusa carregar com elemento, atributo ou valor fora do catálogo. Dado do sistema só escolhe a chave e nunca entra no SVG. Nada de `<img>`, URL, biblioteca remota nem `innerHTML` para o pictograma.
- **Acessibilidade:** decorativo (`aria-hidden`, `focusable="false"`); o nome segue em texto.
- **Onde:** só Análise de estoque e Validade (mesma célula, antes do nome, sem coluna nova) e Materiais (ao lado do seletor do estoque por lote, criado pelo DOM). Não levar a outras telas sem decisão.
- **Escopo:** a direção antiga (imagem personalizada → ícone manual → automático por tipo) foi substituída de propósito. Imagem personalizada, upload e escolha gravada por material são decisão explícita da 12G-8, não pendência da 12G-7.
- **Acoplamento com as listas:** mudar as listas de tipos ou categorias exige atualizar só a tabela de mapeamento do catálogo (feito na 12G-8 para os nomes oficiais com desenho adequado, sem SVG novo); o teste compara as listas de `js/materiais.js`.

Grade de tamanhos da 12G-8 (migration `070`, `material_tamanhos`):

- **Conceito:** GHE = quais produtos o trabalhador pode usar; GRADE = quais tamanhos são válidos para o produto; ESTOQUE = o que pode ser entregue agora. A grade é explícita no cadastro do material e **nunca** é deduzida nem preenchida a partir dos lotes.
- **Transição:** material com grade usa a grade como fonte de verdade; material antigo sem grade mantém o comportamento legado.
- **Tamanho único:** não tem grade (400 `GRADE_NAO_SE_APLICA`). Sair de "possui tamanhos" exige apagar a grade na mesma alteração (409 `MATERIAL_TAMANHO_GRADE_INCOMPATIVEL`).
- **Tamanho em uso:** um tamanho com saldo, mínimo próprio ou solicitação em aberto (`PENDENTE`, `APROVADA`, `APROVADA_PARCIAL`, item não reprovado) não sai da grade (409 `MATERIAL_GRADE_TAMANHO_EM_USO`); lote zerado não conta.
- **Formato:** o mesmo do tamanho do lote, comparado exatamente; não se repete sem diferenciar maiúsculas; até 50 por material.
- **Onde vale a grade:**
  - entrada de estoque: só tamanho da grade (400 `TAMANHO_FORA_DA_GRADE`);
  - criação da solicitação: o backend recusa tamanho fora da grade;
  - Pedido: `tamanhosSugeridos` vem da grade (inclusive tamanho sem estoque), o legado segue com os lotes;
  - o `GET` de lotes e o `GET` do material trazem `tamanhos`.
- **Travas:** a troca da grade fica na transação da edição do material, depois do `FOR UPDATE` do material. Entrada (`FOR UPDATE`), solicitação (`FOR SHARE`) e o gatilho da 070 (`FOR SHARE`) se serializam com ela pela mesma trava; a ordem global de travas não mudou e não há segunda lógica de saldo.
- **Tela de Materiais:** o quadro estático "Exemplos de tipos" foi removido em 04/10/2026 (só visual; a orientação de tipos é a relação Categoria → Tipo desta 12G-8). Não recriar.
- **Fora da 12G-8:** pictograma por material, imagem, upload e prévia (decisão: só o automático da 12G-7), listagem nova de materiais, inativar e reativar na tela, endpoint combinado de cadastro com entrada e grade automática por tipo (12H).
- **Pré-condição:** qualquer banco persistente que sirva este código precisa estar migrado até a `071`, porque o cadastro, a entrada e a solicitação leem a grade (`070`) e o cadastro lê e grava a descrição do tipo (`071`). A `070` e a `071` não foram aplicadas a nenhum banco persistente.

Categoria → Tipo da 12G-8 (rescopo aprovado em 04/10/2026; migration `071`):

- **Listas:** o Tipo depende da Categoria. EPI (14, em ordem alfabética): Botina de Segurança, Capacete, Creme de Proteção, Luva, Mangote, Óculos de Proteção Ampla Visão, Óculos de Proteção Incolor, Outros, Palmilha, Proteção Auricular Concha, Proteção Auricular Descartável, Respirador PFF2, Sapato de Segurança, Viseira Película Ouro. Uniforme (8): Calça, Calça de Forneiro, Calça Eletricista, Camisa, Camisa de Forneiro, Camisa Eletricista, Camiseta, Outros. Material de consumo, Ferramenta, material sem categoria e categoria desconhecida: só "Outros" (decisão de 04/10/2026; não inventar lista para Ferramenta). Fonte: `backend/src/utils/classificacao-material.js` e `frontend/js/materiais.js` (`TIPOS_POR_CATEGORIA`, `tiposDe`), iguais por teste. O nome das categorias gravadas não mudou (`Material de consumo`).
- **Autoridade:** o backend confere a lista no cadastro e, na edição, sempre que tipo ou categoria vêm na requisição (400 `TIPO_FORA_DA_CATEGORIA` em `body.tipo`); o legado intocado não é reconferido. O tipo continua opcional (`null`), nunca adivinhado; o nome do perfil não entra em nenhuma regra.
- **"Outros":** `tipo = 'Outros'` e a descrição em `materiais.tipo_descricao` (VARCHAR(100), aparada, não vazia, texto puro, nunca HTML ou SVG): obrigatória com "Outros" (400 `TIPO_DESCRICAO_OBRIGATORIA`), proibida com outro tipo (400 `TIPO_DESCRICAO_NAO_SE_APLICA`), `TIPO_DESCRICAO_INVALIDA` pelo schema, limpa pelo serviço quando o tipo deixa de ser "Outros" (nunca descrição escondida). A descrição nunca age como tipo: não ativa a regra de óculos nem sugestão de tamanho. Entra na auditoria como os demais campos do cadastro.
- **Legado:** tipo fora das listas continua legível e editável nos outros campos, sem conversão automática; a tela o mostra na edição como "Outros" + descrição e, ao salvar, converte. Trocar a categoria sem tipo compatível é 400. O CHECK "Outros" ⇔ descrição da `071` é `NOT VALID`: a migration não converte nem apaga linha; a linha antiga que viole a regra passa a cumpri-la quando for alterada.
- **Óculos:** "Óculos de Proteção Incolor" e "Óculos de Proteção Ampla Visão" são tipos distintos no dado gravado; `ehOculos` reconhece os dois e o histórico "Óculos de proteção", que vale só para o legado (editável, convertível a um dos dois sem informar o grau de novo; nunca aceito em cadastro novo nem como valor novo no PATCH). A regra de óculos com grau, a entrega e a ficha usam o mesmo predicado. A `071` substitui os CHECKs da 045 e da 058 pelos três nomes; 045 e 058 continuam intocadas.
- **Tela:** lista de tipos montada por categoria (`render.opcoesTipos`, escapado, origem conhecida da trava de `innerHTML`); trocar a categoria SEMPRE limpa o tipo e a descrição, no cadastro e na edição, mesmo quando o tipo era "Outros" (decisão de 04/10/2026: nunca preservar "Outros" nem a descrição anterior; a pessoa escolhe e descreve de novo); campo "Descrição do tipo" (`materialTipoCustom`); óculos legado como opção temporária "(legado)" só na edição; "Limpar" não escolhe tipo.
- **Catálogo 12G-7:** só a tabela de mapeamento ganhou os nomes oficiais com desenho adequado (Botina de Segurança → botina; os dois óculos → oculos; Proteção Auricular Concha → protetor-auricular; Respirador PFF2 → respirador); Creme, Mangote, Palmilha, Sapato, Viseira, Descartável e uniformes caem na categoria. Nenhum SVG novo.

Nota complementar (15/10/2026): a Classificação V2 do material (migration `082`, decisões de 07 e 08/10/2026) substituiu o modelo Categoria → Tipo acima para cadastros novos: Grupo (`categoria`: `EPI` | `Vestimenta` | `Outros`) → Grupo de Proteção (12 fechados | `Outros`) → Tipo do catálogo por empresa (`tipos_material`) | `Outros`, com "Especifique…" obrigatório em cada nível "Outros"; a própria migration converteu `Uniforme` em `Vestimenta`. As listas `TIPOS_POR_CATEGORIA`, `tiposDe` e o predicado `ehOculos` por nome continuam SÓ em `backend/src/utils/classificacao-material.js`, para o material LEGADO (`modelo_classificacao = 'LEGADO'`, tudo o que existia antes da `082`, editável nos campos não relacionados sem conversão); `frontend/js/materiais.js` deixou de ter as listas e usa o catálogo por `js/tipos-material.js`, então a afirmação "iguais por teste" acima vale para o estado de 06/10/2026. A regra "tipo `Outros` ⇔ descrição" da `071` passou a valer só para V2 (CHECK substituído pela `082`); óculos com grau em V2 é pela classificação (EPI + Proteção ocular), não pelo nome. Status: implementada, testes GREEN; **registro de homologação manual não localizado** nas evidências de `Projetos Bloco/Bloco 12`. Detalhe no bloco "Classificação V2" (Lote 2).

Importação de funcionários da 12G-9 (`frontend/pages/import-employees.html`, `js/funcionarios.js`, `funcionario.service.js`, `funcionario.schema.js`, `grupo-homogeneo-exposicao.repository.js`; sem migration, sem rota nova, sem RBAC novo; `employee-history.html` intocado; concluída em 05/10/2026 com a validação manual aprovada, sem commit):

- **Coluna GHE obrigatória** na planilha, com o nome exato do GHE da empresa. Coluna ausente = erro estrutural antes da prévia (caso A, `COLUNAS_AUSENTES`); célula vazia = só aquela linha (caso B). Nunca GHE padrão, aproximado (`buscarPorNome` é igualdade exata, a de `uq_ghe_empresa_nome`), de outra empresa ou criado pela importação; inativo recusa a linha. Códigos: `FUNCIONARIO_GHE_NAO_INFORMADO`, `FUNCIONARIO_GHE_INEXISTENTE`, `FUNCIONARIO_GHE_INATIVO`, sempre com `campos: ['ghe']` e sem ecoar o nome informado; decididos antes de abrir transação. O vínculo grava o id resolvido e relê o GHE `FOR SHARE` na transação da linha.
- **Existente = CPF na empresa** (`buscarPorCpf`; regra oficial `uq_funcionarios_empresa_cpf`), comparado antes de gravar: `JA_CADASTRADO` com `FUNCIONARIO_JA_CADASTRADO` (sem alterações) ou `FUNCIONARIO_JA_CADASTRADO_DIVERGENTE` + `divergencias: [{ campo, atual }]` na ordem matrícula, nome, setor, função, admissão, nascimento, telefone, GHE (pelo nome). NUNCA alterar, reativar, completar nem registrar auditoria de alteração; `atualizar` não é chamado pela importação. `atual` só dos campos do instantâneo de auditoria; `dataNascimento` e `telefone` vêm só como `{ campo }`; CPF nunca; o valor da planilha nunca é ecoado; opcional vazio na planilha não diverge; a resposta traz `funcionarioId` e `ativo`. Matrícula de outro CPF segue `DUPLICADO`; corrida no INSERT segue `FUNCIONARIO_CPF_EM_USO` (aceito `DUPLICADO` ou `JA_CADASTRADO`, sempre uma linha só no banco).
- **Resumo e auditoria:** `resumo` = cadastrados, jaCadastrados, divergentes, duplicados, recusados, erros; `FUNCIONARIOS_IMPORTACAO_LOTE` guarda os contadores e `linhas: [{ linha, situacao, codigo, funcionarioId, campos }]` (nomes de campos, nunca valores). Nenhum evento novo de auditoria.
- **Tela:** `CABECALHOS.ghe`, `OBRIGATORIAS` com GHE, `LIMITES.ghe = 150`, modelo CSV com GHE, prévia com a coluna GHE entre Cargo e Status; `fluxo.consolidar` devolve `nome`, `ativo`, `divergencias` (com `rotulo`, `atual`, `planilha` da própria prévia e `oculto`), `resumo` com `total` e `naoImportados`, e `porMotivo`; `fluxo.rotulo` dá o texto por pessoa; `render.relatorio` lista todas as linhas (Linha, Nome, Matrícula, Resultado, Detalhes) com a tabela Campo / Sistema atual / Planilha e "Nenhuma alteração realizada". O valor atual de `cpf`, `dataNascimento` e `telefone` nunca é exibido, mesmo que venha do servidor; tudo escapado. A prévia continua local: GHE inexistente ou inativo e funcionário existente só na confirmação (a conferência prévia de GHE por nome exigiria rota nova; melhoria futura, não criar sem decisão).
- **Fora do escopo** (decisão de 04/10/2026): nova tela de funcionários, filtro ou busca por GHE no Histórico, atualização em lote, merge, criação automática de GHE. Nenhum número de estoque, CPF ou dado de outra empresa na tela.
- **Regra definitiva do funcionário já cadastrado (congelada em 05/10/2026):** a importação serve SOMENTE para cadastrar funcionários novos. Existente (CPF na empresa) → identificar, comparar quando aplicável, informar "JÁ CADASTRADO" e NÃO alterar: nenhum UPDATE, nenhuma sobrescrita, nenhuma troca de GHE, setor, função, telefone ou situação, nenhuma reativação, nenhum completamento ou correção automática; divergência é informativa e NUNCA autoriza alteração. Confrontada com o código em 05/10/2026: o único caminho de escrita da importação é `gravarCadastro` → `funcionarioRepo.criar` (INSERT puro, sem `ON CONFLICT`); `atualizar` só é chamado por `alterar` e `alterarEstado`, que a importação não invoca; a corrida de CPF termina em violação de unicidade e ROLLBACK. Qualquer alteração de funcionário existente (setor, função, GHE, telefone, situação) é da etapa futura **12K-E — Gestão / Edição de Funcionários**, com histórico (valor anterior, valor novo, data/hora, responsável, motivo); mudar setor ou função não troca o GHE automaticamente, o GHE é alterado explicitamente; o histórico anterior nunca é apagado. Não iniciar a 12K-E sem autorização.

Configurações (`frontend/pages/config.html`, `js/configuracoes.js`, `js/tema.js`; migration `072`; implementação funcional de 05/10/2026, concluída tecnicamente, aguardando validação manual): a página deixou de ser protótipo (sem `db-api.js`, `main.js` legado, seed ou login fictício), abre para qualquer sessão empresarial válida (`PAGINAS.config = { abrir: [], alterar: [] }`), mostra só a própria conta e saiu de `INSPECAO_PROTOTIPOS`. **Minha Conta** = nome, e-mail de login, telefone, perfil · situação (`Master · Ativo`, com `ativo` real de `usuarios` lido pelo `me`), CPF, matrícula e último acesso (`criado_em` da sessão global anterior; sem fonte real, "—"). Editáveis: e-mail, telefone e senha; somente leitura: nome, perfil, situação, CPF, matrícula e último acesso. **Vínculo usuário ↔ funcionário (decisão corrigida em 05/10/2026; migration `073`):** usuário e funcionário continuam entidades distintas; CPF e matrícula ficam SÓ em `funcionarios` e chegam à tela pelo vínculo EXPLÍCITO `usuarios.funcionario_id` (nulo por padrão; FK composta `(empresa_id, funcionario_id) → funcionarios(empresa_id, id)` sobre a unicidade da 057, `ON DELETE RESTRICT`; unicidade `(empresa_id, funcionario_id)`, NULL livre; sem gatilho; nenhuma linha vinculada pela migration). A identidade (global) nunca recebe `funcionario_id`, e nada é copiado para `usuarios` ou `identidades`. Nenhuma inferência por nome, e-mail, CPF, matrícula, empresa ou perfil: `usuarioRepo.buscarContaOperacional` liga só por `u.funcionario_id` e filtra só por empresa e id da sessão; sem vínculo, `GET /auth/global/me` devolve `contexto.usuario.funcionario = { vinculado: false, matricula: null, cpfMascarado: null }` e a tela mostra "Não vinculado". O CPF sai SÓ mascarado (`mascararCpf`, `***.***.***-XX`, o padrão da aplicação); não existe regra de revelação do CPF no sistema e nenhuma foi criada; a matrícula sai integral. Quem administra o vínculo é fluxo administrativo futuro (12J ou 12K-E); até lá o vínculo é gravado só por ato explícito autorizado. **Decisão de domínio (05/10/2026): existem dois tipos de pessoa — o funcionário da fábrica (`funcionarios`, que recebe EPI) e a pessoa administrativa, que hoje existe só como conta (`usuarios` + `identidades`), sem cadastro próprio e sem CPF ou matrícula em lugar nenhum.** Solução provisória adotada (opção C): a 073 fica como está e serve só a quem também for, explicitamente, um registro de `funcionarios`; conta administrativa sem vínculo mostra "CPF: Não vinculado" e "Matrícula: Não vinculado", com os campos visíveis; a conta MASTER do responsável NÃO é vinculada a nenhum funcionário da fábrica; `funcionarios` não vira cadastro genérico de pessoa e não se cria tabela de pessoa administrativa nem migration para isso. **DECISÃO FUTURA (não bloqueia Configurações):** a forma definitiva do cadastro da pessoa administrativa (pessoa que terá acesso, tipo de perfil, CPF, matrícula, demais dados e a relação com usuário, identidade e empresa) será analisada na tela de Administração de Usuários / Configurações de Acessos, sobre o fluxo já desenhado; não antecipar essa arquitetura. **Modelo:** telefone, tema e modo visual ficam em `identidades` (`072`: `telefone VARCHAR(20)` nulo, `tema` em sistema|claro|escuro, `modo_visual` em padrao|alto_contraste|deuteranopia|protanopia|tritanopia|baixa_visao|monocromatico, com CHECKs; sem tabela 1:1); `src/utils/preferencias-aparencia.js` é a única lista. **Leitura:** `GET /auth/global/me` traz `identidade` (id, e-mail, telefone, tema, modoVisual, ultimoAcessoEm) e `GET /auth/me` traz `preferencias` (padrão para o usuário legado sem identidade); nenhuma rota de leitura nova. **Escrita:** `PATCH /api/auth/global/conta` (telefone nulo ou 1–20, tema e modoVisual, pelo menos um campo; `conta.service.js` lê a identidade `FOR UPDATE`, audita `CONTA_ATUALIZADA` só com os nomes dos campos alterados e não audita o que não mudou) e `PATCH /api/auth/global/email` (`troca-email-global.service.js`: senha atual obrigatória, com o mesmo cooldown, trava e tratamento de falha do login global; e-mail normalizado e validado; igual ao atual é 400 `EMAIL_IGUAL_AO_ATUAL`; em uso, ou corrida 23505, é 409 `EMAIL_INDISPONIVEL` genérico, sem revelar o dono; altera só a identidade da sessão; cancela redefinições pendentes; revoga TODAS as outras sessões globais e empresariais e preserva a atual; audita `EMAIL_ALTERADO` só com contagens; o aviso `EMAIL_ALTERADO` vai ao e-mail antigo pela infraestrutura existente, depois do COMMIT, informativo, sem senha nem token, e a falha do aviso não desfaz nada; não há verificação do novo e-mail, que vale no próximo login); os dois restritos à identidade da sessão (o cliente nunca envia identidade ou usuário) e o de e-mail com `limitadorTrocaEmail`. Senha: só `POST /api/auth/global/senha` por `portal/trocar-senha.html`, sem segundo fluxo. **Aparência:** por identidade, persistida no backend, aplicada em todas as páginas integradas (`sessao-empresarial.js` chama `EpiTema.aplicarPreferencias` com a resposta de `/auth/me`), auto-salva (selecionar → aplicar → persistir → confirmar discretamente, sem botão "Salvar aparência"; reverte se o PATCH falhar); `localStorage` só como cache da primeira pintura, numa chave única (`safework-aparencia`, só tema e modo visual), lido por `iniciar` sem gravar, reescrito a cada resposta do servidor, que sempre vence, e apagado no logout. Modo Quiosque e Resumo de Permissões foram removidos da tela (o Quiosque é da 12L; a matriz é da 12J). Responsividade: `css/main.css` empilha `.account-summary` na largura de celular. **Pré-condição:** qualquer banco persistente que sirva este código precisa estar migrado até a `073` (o `me` lê `usuarios.funcionario_id`); a `072` e a `073` não foram aplicadas a nenhum banco persistente protegido, só a schemas temporários do banco de teste `gestao_epi_teste_local` e ao banco descartável de validação `gestao_epi_validacao_config_20261005` (cópia da homologação criada em 05/10/2026 para a validação manual; a homologação segue na `060`). As suítes antigas com lista fixa de migrations que leem `identidades` ou o `me` passaram a incluir a `072` e a `073`.

Gestão de Usuários — criação direta e senha provisória (05/10/2026; migration `074`; concluída tecnicamente, aguardando validação manual; grupos, permissões, integrantes, autorizações e o restante de `safe-work-usuarios.html`, o alvo visual congelado, NÃO iniciados):

- **Arquitetura:** o Painel Privado provisiona a empresa e o primeiro MASTER (convite da `033`/`034`, intocado); os demais usuários nascem dentro da empresa por `POST /api/administracao/usuarios` `{ nome, email, tipoConta, senhaProvisoria }` (`schemas.criar`, estrito), empresa só da sessão, `GERENCIAR_USUARIOS` pela autoridade administrativa central e `exigirPerfilGerenciavel` (ADMINISTRADOR só SUPERVISOR e USUARIO), política real de senha (400 `VALIDACAO` em `body.senhaProvisoria`), Argon2id, transação sob `travaDaEmpresa`, auditoria `USUARIO_CRIADO` só com ids, perfil, origem e `acessoProvisorioExpiraEm` (nunca chave com o segmento "senha": o gatilho da `014` recusa a linha com P0001). **ZERO e-mail** na criação; o serviço não importa nada de e-mail, entrega ou convite (teste de fonte). E-mail já com identidade: 409 `IDENTIDADE_EMAIL_JA_EXISTENTE`, sem sobrescrever, sem vínculo, sem convite. `convites_usuario` (`046`) fica, fora do fluxo normal. (A redefinição administrativa de senha, antes fora do escopo, foi SUPERADA em 05/10/2026: ver "Alterar senha" no bloco das funções principais.) CPF/matrícula do usuário administrativo continua em aberto.
- **Estado (074):** `identidades.senha_provisoria` (NOT NULL DEFAULT false), `senha_provisoria_definida_em`, `senha_provisoria_expira_em`, CHECK `chk_identidades_senha_provisoria` (true ⇒ as duas datas e expiração > definição; false ⇒ ambas nulas). Nunca flag em `usuarios`. `identidadeRepo.criar` recebe `senhaProvisoria: { definidaEm, expiraEm }`; `atualizarSenhaHash` (troca e redefinição) grava a senha e limpa os três campos no mesmo UPDATE. A projeção da identidade e `buscarCredencialPorEmail` expõem `senhaProvisoria` e `senhaProvisoriaExpiraEm`; as duas sessões devolvem `senhaProvisoria` no topo do contexto (nunca dentro de `usuario`).
- **Validade (`utils/senha-provisoria.js`):** 48 horas; 72 quando `definidaEm` cai numa sexta-feira em `America/Sao_Paulo` (`FUSO` de `data-operacional.js`); sábado e domingo 48; sem renovação; `expirada` é verdadeira no instante exato. O instante vem de `clock_timestamp()` do banco.
- **Login e bloqueio:** senha correta + provisória válida → sessão normal e `identidade.trocaSenhaObrigatoria: true` (login e `GET /auth/global/me`); expirada → 401 `SENHA_PROVISORIA_EXPIRADA`, sem sessão, sem registrar falha nem cooldown; caminho "Esqueci minha senha". `criarExigirSessaoGlobal({ permitirSenhaProvisoria })` e `criarExigirSessao({ permitirSenhaProvisoria })`: sem a opção, 403 `TROCA_SENHA_OBRIGATORIA` ("Defina uma nova senha para continuar") depois de `registrarUso`. Só `GET /auth/global/me` e `POST /auth/global/senha` usam `exigirSessaoGlobalComSenhaProvisoria`; selecionar empresa, conta, Portal e tudo o mais ficam bloqueados; logout não passa pelo middleware. Rota nova que precise aceitar a sessão em troca obrigatória é decisão explícita.
- **Frontend:** `portal-cliente.js` (`decisao.destino` → `trocarSenha` antes de qualquer outro destino), `sessao-empresarial.js` (403 `TROCA_SENHA_OBRIGATORIA` → `portal/trocar-senha.html`), `portal/trocar-senha.js` (aviso da provisória). Nada vai para armazenamento do navegador; o servidor continua a autoridade.
- **Banco:** a `074` existe só em schemas temporários de `gestao_epi_teste_local`; NÃO foi aplicada ao descartável `gestao_epi_validacao_config_20261005` (exige autorização específica) nem a banco protegido. Suítes de integração com lista fixa de migrations que passam pela sessão empresarial ou global precisam incluir `'074'`.

Gestão de Usuários — tela e listagem real (05/10/2026; `pages/gestao-usuarios.html`, `js/gestao-usuarios.js`; só frontend, sem migration, sem rota, sem RBAC novo; concluída tecnicamente, aguardando validação manual; o ciclo de senha provisória está congelado e a validação manual dele foi aprovada em 05/10/2026, com a `074` aplicada só no descartável `gestao_epi_validacao_config_20261005`):

- **Alvo visual:** `safe-work-usuarios.html` (anexo do responsável, cópia em `~/Downloads`) é a referência congelada. A única adaptação autorizada é a moldura padrão do SafeWork; dentro da área de conteúdo o HTML aprovado fica intocado (cabeçalho, toolbar, filtros, busca, Exportar, tabela/cartões, tema, foco, menu de ações, modal, `#permView`, toast). A folha do protótipo foi transcrita sem mudar valores e restrita a `.gu` (tokens no contêiner; escuro por `html[data-theme="dark"] .gu`), com só os neutralizadores necessários contra `main.css` (`.brand`, `.grid`, `.switch`, margem de `p`). A barra do sistema do protótipo ficou dentro do conteúdo como contexto da sessão (decisão final de 05/10/2026, visual aprovado): esquerda = só o nome real da empresa (`whoEmpresa`, na `.brand`); direita = "Nome - Perfil" reais na mesma linha (`whoNome`, `whoPerfil`, pelos elementos `empresa` e `usuario` de `EpiSessaoEmpresarial.montar`); nada de "Safe Work" ou "Gestão de EPIs" nessa barra, nada hardcoded. O título "Gestão de usuários" da página continua. O ícone sanduíche e sua responsividade não foram tocados (análise futura). Qualquer outra mudança visual exige decisão do responsável; o espaçamento da moldura somado ao da página continua como está.
- **Autoridade:** `PAGINAS.gestaoUsuarios = { abrir: [['usuarios', 'consultar']], alterar: [] }`, a mesma da Administração de Usuários; nenhuma permissão nova; nada pelo nome do perfil; o menu oculto não é segurança. Menu: entrada `data-pagina="gestaoUsuarios"` logo depois de `userAdmin` em todas as páginas com menu, inclusive `config.html` (autorização limitada de 05/10/2026); as seis telas antigas continuam até autorização para retirá-las; Início do Portal e `RECURSOS` da Permissões do Grupo não mudaram.
- **Dados:** só `GET /administracao/usuarios` por `EpiUsuarios.acoes.listar` (agora com `limite` 1–100); `carregarTodos` consome a paginação real em segundo plano (100 por página, teto de 50 páginas com aviso `LISTA_INCOMPLETA`), sem `situacao` nem `busca` na consulta: situação (`ativo` real), busca (id, nome, e-mail, grupo), ordenação e agrupamento por grupo são locais sobre o conjunto real; tabela e cartões usam o mesmo conjunto; CSV só com ID, Usuário, Login (e-mail), Perfil, Grupo, E-mail e Status, célula neutralizada contra fórmula. "Login" = e-mail da identidade, sem sufixo. Desde 05/10/2026 (075–077) a projeção traz `cpfMascarado` (só o mascarado, validado pelo formato na tela), `matricula`, `setor`, `horarioTrabalho` ("08:00 - 18:00" ou "—") e `acessoQualquerIp` (derivado no servidor; ausente = "—", nunca inventado); Setor, Horário e Acesso de qualquer IP ordenam, CPF mascarado não ordena; "Agrupar por Setor" agrupa pelo setor real ("Sem setor"). Empresa(s) e Visualiza logs continuam "—" (sem fonte consolidada); "Bloqueado" nunca aparece. Nada de `users`, `EMPRESAS`, `SETORES`, `MODELOS`, `localStorage` (`safework-usuarios-v1`, `safework-tema`); o conteúdo é montado só com nós e texto (`render(document, …)`), sem `innerHTML` (o harness de páginas não interpreta `innerHTML`).
- **Controles não integrados:** Novo › Grupo (Novo › Usuário é real desde 05/10/2026: bloco próprio abaixo), Desbloquear, e as ações da linha (Alterar, Duplicar, Configurar permissões, Copiar permissões, Alterar senha, Desabilitar/Habilitar) ficam visíveis e só mostram `TEXTOS.EM_INTEGRACAO` pelo toast do HTML; nenhum modal falso, nenhuma escrita, nenhum armazenamento. Guia rápido = texto fixo. Tema = aparência por identidade (`EpiTema.aplicarPreferencias` + `PATCH /auth/global/conta`, `CAMINHO_CONTA` igual ao das Configurações; falha reverte). Foco = classe no contêiner.
- **Nomenclatura (05/10/2026):** "GHE e EPIs" passou a "Gestão de GHE" só na apresentação (menu de todas as páginas, título e `<h2>` de `employee-groups.html`, Início do Portal e o nome em `RECURSOS` da Permissões do Grupo); arquivo, id `employeeGroups`, rota e recurso não mudaram. `config.html` recebeu só as duas linhas de menu (o nome novo e a entrada Gestão de Usuários) por autorização limitada de 05/10/2026; formulário, conta, senha, e-mail, telefone, aparência, APIs e comportamento das Configurações continuam congelados.
- **Pedido de EPI para o MASTER (diagnóstico e decisão de 05/10/2026):** `pages/request.html` e as rotas `/api/solicitacoes-epi` nunca saíram; a página abre com `request.visualizar` OU `request.criar` e o menu segue a mesma regra. O MASTER não via o Pedido porque a regra do 12E/12F excluía `request` do escopo de provisionamento (no descartável, o perfil MASTER tinha só os oito recursos do escopo e nenhuma linha de `request`). Decisão final: a regra estrutural foi corrigida em `ESCOPO_PROVISIONAMENTO_MASTER` (`request`: visualizar, criar, editar), o ponto único que o Painel Privado usa ao cadastrar a empresa e que `db:provisionar:master` reaplica (só o AUSENTE); nenhum outro perfil recebe `request.*` por isso; nada no frontend decide pelo nome do perfil. O descartável `gestao_epi_validacao_config_20261005` foi reprovisionado pelo próprio responsável em 05/10/2026 (`db:provisionar:master -- --empresa 1 --executar`: uma linha `request` inserida para o perfil MASTER da empresa 1, nada apagado nem recriado), e a validação manual do Pedido de EPI com o MASTER foi APROVADA em 05/10/2026. Nenhuma pendência restante nesse ponto.
- **Navegação oculta (05/10/2026; só ocultação; validação manual APROVADA em 05/10/2026):** `NAVEGACAO_OCULTA` em `js/permissoes-efetivas.js` (`stockValidity`, `grupos-acesso`, `grupo-permissoes`, `grupo-usuarios`, `autorizacoes-individuais`, `newUser`, `userAdmin`) nunca aparece em `aplicarMenu`, com ou sem permissão — vale para o menu lateral de todas as páginas integradas e para o Início do Portal, que usam a mesma função; `NAVEGACAO_OCULTA_PENDENTES` ("Compras / Entradas", "Regras Função / Setor") recebe `display:none` em `liberarInspecao`; na barra legada dos protótipos em inspeção, `js/inspecao-visual.js` injeta a regra `!important` para `NAVEGACAO_OCULTA_LEGADA` (o `main.js` reexibe os itens com `display:flex`). Sem item cinza, placeholder ou etiqueta: os itens somem. Nada foi apagado: páginas, módulos, rotas, permissões, testes e o acesso direto legado continuam (`podeAbrir` não muda). **Pendência obrigatória:** quando a Gestão de Usuários estiver 100% funcional, testada e validada, revisar e DESATIVAR DEFINITIVAMENTE as seis telas legadas que ela substitui (Grupos de Acesso, Permissões do Grupo, Integrantes do Grupo, Autorizações Individuais, Novo Usuário, Administração de Usuários), antes do Git consolidado da Gestão de Usuários. Validade de estoque, Compras / Entradas e Regras Função / Setor ficam só adiados, preservados para retomada.
- **Próximas subetapas (não iniciar sem autorização; Novo › Usuário foi feito em 05/10/2026, bloco abaixo):** grupos; permissões; integrantes; autorizações individuais; vínculo SST; desbloqueio/cooldown; CPF/matrícula administrativa; toggles dinâmicos; retirada das seis telas antigas.

Gestão de Usuários — Novo → Usuário administrativo (05/10/2026; migrations `075`, `076` e `077`; backend e frontend; concluído tecnicamente; as três migrations foram aplicadas ao descartável `gestao_epi_validacao_config_20261005` em 05/10/2026 por autorização específica (pelo `db:migrate` com `DB_NAME` explícito; agora 78 migrations, `000` a `077`; dados existentes intactos, nenhum usuário criado) e ambiente pronto, AGUARDANDO A VALIDAÇÃO MANUAL; fora de `gestao_epi_teste_local` e do descartável NÃO foram aplicadas a nenhum banco; aplicá-las a qualquer outro banco persistente exige autorização separada):

- **Domínio:** usuário administrativo ≠ funcionário operacional (`funcionarios` continua só de quem recebe EPI; `usuarios.funcionario_id` da 073 não entra aqui). `identidades.cpf` (075: CHAR(11) canônico, CHECK de formato, índice único parcial `uq_identidades_cpf` — único no SISTEMA inteiro —, nulo nas identidades anteriores, SEM backfill, e gatilho `trg_identidades_cpf_imutavel`: definido, nunca é trocado nem removido, nem por MASTER, nem por UPDATE direto; nenhuma rota aceita `cpf` em alteração — `PATCH /administracao/usuarios/:id` e `PATCH /auth/global/conta` o recusam como campo extra). `usuarios.matricula` (VARCHAR(30), aparada, única por empresa por `uq_usuarios_empresa_matricula`), `usuarios.setor` (VARCHAR(100)), `horario_trabalho_inicio/fim` (TIME, os dois ou nenhum; turno noturno aceito) — 076. `usuario_ips_permitidos` (077: INET de host, CHECK de máscara 32/128, UNIQUE por empresa+usuário+ip, FK composta `(empresa_id, usuario_id) → usuarios(empresa_id, id)`): sem linha = qualquer endereço; com linha = só os cadastrados.
- **Contrato:** `POST /api/administracao/usuarios` estendido (nenhum endpoint concorrente): `{ nome, email, tipoConta, senhaProvisoria, cpf*, matricula*, setor*, horarioTrabalho?, ipsPermitidos?, grupoAcessoId? }`, estrito (confirmação da senha, empresa, perfil, permissões, `funcionarioId` → 400). `cpf` = `cpfComDigitosVerificadores`; `horarioTrabalho` = `{ inicio, fim }` HH:MM (`HORARIO_INVALIDO`); `ipsPermitidos` até 20, cada um por `utils/ip.normalizarIp` (`IP_INVALIDO`); `grupoAcessoId` = `idCorpo`. Serviço `usuario-administracao.service.criar`, UMA transação sob a trava da empresa, nesta ordem: autoridade → perfil gerenciável → MASTER com grupo (409 `USUARIO_MASTER_SEM_GRUPO`, o mesmo código do vínculo) → política de senha → e-mail (409 `IDENTIDADE_EMAIL_JA_EXISTENTE` / `USUARIO_VINCULO_EXISTENTE`) → CPF (409 `IDENTIDADE_CPF_JA_EXISTENTE`) → matrícula (409 `USUARIO_MATRICULA_JA_EXISTENTE`) → grupo (`grupoAcessoRepo.buscarPorId` da empresa da sessão: 404 `GRUPO_NAO_ENCONTRADO` para inexistente OU de outra empresa, 409 `GRUPO_INATIVO`) → hash → `identidadeRepo.criar` com `cpf` (23505 traduzido pela constraint: CPF ou e-mail) → `usuarioRepo.criar` com matrícula, setor, horário e grupo (23505 `uq_usuarios_empresa_matricula` → 409) → `usuarioIpRepo.inserir` (dedup) → auditoria `USUARIO_CRIADO` com `temCpf`, `matricula`, `setor`, `horarioTrabalho` booleano, `grupoAcessoId`, `ipsPermitidos` (contagem) — NUNCA o CPF, os IPs ou a senha. Falha em qualquer passo = ROLLBACK, sem auditoria. Resposta 201: `usuario` (projeção da listagem, sem CPF), `senhaProvisoriaExpiraEm`, `administrativo` (`cpfMascarado` `***.***.***-XX`, matrícula, setor, horário, IPs gravados, grupo). A listagem `GET` e o detalhe (`usuario-administracao.repository`, mesma PROJECAO) projetam `cpfMascarado` (via `mascararCpf`; o CPF em claro não sai do mapeamento), `matricula`, `setor`, `horarioTrabalho` (`{inicio, fim}` HH:MM ou null) e `acessoQualquerIp` (NOT EXISTS na 077); a lista de IPs nunca sai pela listagem (futuro Alterar Usuário). **Grupo é OPCIONAL para os quatro perfis** (decisão de 05/10/2026; teste prova cada um nascendo sem grupo); a recusa de grupo PARA MASTER (409 `USUARIO_MASTER_SEM_GRUPO`) não é obrigação, é a proibição da 3L (`grupo-usuario.service.js`: o middleware não consulta grupo para MASTER, o vínculo seria sem efeito e enganoso), **mantida por decisão de 05/10/2026**: a autoridade do MASTER é própria e máxima, ele não usa grupo, nenhum grupo automático para MASTER, a 3L não muda. Painel Privado inalterado: o primeiro MASTER nasce automaticamente no aceite do convite (`convite-master.service`, perfil fixo `MASTER`, sem seletor de perfil nem de grupo; schemas do Painel não têm `perfil` nem `grupo`). **Formulário:** `formulario.grupoSeAplica(tipoConta)` (falso só para `MASTER`, o tipo escolhido no formulário para quem está sendo criado — NUNCA o perfil de quem age, e nunca autorização: o servidor continua a autoridade) e `formulario.ajustarGrupo(document)` (chamado no `change` do select de tipo de conta): com Master, o select Grupo fica vazio, desabilitado e a primeira opção vira "Não se aplica" (`TEXTOS.GRUPO_NAO_SE_APLICA`) dentro do próprio campo, sem banner, aviso ou elemento extra (só a regra `.gu .in:disabled`, opacidade); trocar o perfil limpa o grupo, e voltar a ADMINISTRADOR/SUPERVISOR/USUARIO reabre o campo vazio ("Sem grupo"), opcional; `corpo` e `validar` ignoram o grupo quando o tipo é Master (a tela nunca envia grupo com Master).
- **Restrição por IP (servidor):** `sessao.repository.buscarValidaPorHash` devolve `restricaoIp` (EXISTS na 077, fora de `usuario`); `criarExigirSessao` compara `ipDaRequisicao(req)` (= `req.ip` sob `TRUST_PROXY_HOPS`, normalizado; nunca cabeçalho lido pela aplicação) com `usuarioIpRepo.acessoPermitido` ANTES de `registrarUso` e ANTES do gate da senha provisória → 403 `ACESSO_IP_NAO_PERMITIDO`, sem renovar nem revogar (de endereço permitido a sessão segue). `contexto-empresarial.service.selecionar` faz a mesma conferência depois do vínculo (a seleção automática do login falha com 403 e a sessão global é compensada; com duas empresas, só a restrita recusa). A sessão GLOBAL não é restrita: a lista é do vínculo na empresa. Horário de trabalho NÃO entra em middleware nenhum (teste prova). `TRUST_PROXY_HOPS` errado anula ou bloqueia a restrição (`.env.example`). Frontend: `sessao-empresarial.js` mostra `MENSAGENS.IP_NAO_PERMITIDO` (motivo `FALHA` + `mensagem`) e `portal-cliente.js` tem texto próprio para o código.
- **Tela:** `render.modalNovoUsuario(doc, { grupos, perfis })` (nós e texto; classes `g-user1`/`g-user2`/`g-est` do HTML aprovado; ids `nu-<campo>`; `data-campo`): Nome completo\*, CPF\* (máscara por `formulario.mascaraCpf`), E-mail\*, Perfil / Tipo de conta\* (só `perfisGerenciaveis` da listagem real, que `carregarTodos` passou a devolver), Senha provisória\*, Confirmar senha provisória\* (só na tela), IP(s) permitido(s), Grupo de acesso (ativos reais por `EpiGrupos.acoes.listar({ ativo: true })` — `js/grupos-acesso.js` carregado pela página, fonte única do caminho), Setor\*, Matrícula\*, Horário de/até; sem Status, dois fatores, caixas de perfil, Permissões ou Empresa(s) (decisão: não reorganizar o modal além disso). `formulario.validar` (regras do servidor), `formulario.corpo` (contrato exato; CPF só dígitos; nunca a confirmação), `formulario.erroDoServidor` (400 por `body.<campo>`, 409/404/403 por código → `POR_CODIGO`/`ERROS`, nunca o texto do servidor), `EpiUsuarios.acoes.criar`. Sucesso: `f.reset()`, fecha e descarta o modal, toast `TEXTOS.NOVO_USUARIO_SUCESSO` ("Usuário criado com sucesso. Informe ao usuário o e-mail e a senha provisória pelos meios internos da empresa."), recarrega a listagem real. Nada em `localStorage`/`sessionStorage`; nenhuma decisão pelo nome do perfil (MASTER sem grupo é recusa do servidor mostrada no campo).
- **Suítes com lista fixa de migrations** que passam pela sessão empresarial ou global precisam de `'075', '076', '077'` (feito nas 30 existentes); contagens do manifesto: 78 migrations, `000` a `077`. `test/helpers/cpf-ficticio.js` gera CPFs válidos para fixtures. Fora do escopo desta subetapa (as funções da linha foram feitas depois, bloco seguinte): MFA.

Gestão de Usuários — funções principais da linha (05/10/2026; Novo → Usuário validado e CONGELADO; sem migration nova; concluídas tecnicamente, AGUARDANDO VALIDAÇÃO MANUAL INTEGRADA; o descartável `gestao_epi_validacao_config_20261005` segue na `077` e o backend dele precisa ser reiniciado para carregar o código novo; ZERO migration, nova tabela ou alteração de baseline):

- **A — Desabilitar/Reativar:** `POST /administracao/usuarios/:id/inativar|reativar` (já existiam: ativo=false, gatilho da 038 revoga as sessões do vínculo, último MASTER protegido, auditoria `USUARIO_INATIVADO/REATIVADO`). Novo: login com credenciais certas e nenhuma empresa utilizável com vínculo desabilitado responde 401 `USUARIO_DESATIVADO` "Usuário desativado. Procure o administrador da empresa." (`usuarioRepo.contarVinculosInativosDaIdentidade`; só DEPOIS de a senha conferir, a sessão global nasce e é compensada; senha errada continua genérica). Tela: "Desabilitar usuário" pede confirmação ("Desabilitar acesso de [Nome]?"), "Reativar usuário" age direto; ambos recarregam a listagem real. Nada é apagado.
- **B — Novo → Grupo:** modal na própria página sobre `POST /grupos-acesso` (infraestrutura da 3M: MASTER, unicidade por empresa `GRUPO_NOME_EM_USO`, auditoria); campos Nome* e Descrição; o grupo nasce sem integrantes e SEM permissão (nenhuma pelo nome); aparece no seletor do Novo Usuário (a lista é relida ao abrir). Grupo não é setor.
- **C — Alterar usuário:** o MESMO modal em modo edição (`render.modalNovoUsuario` com `modo`); `GET /administracao/usuarios/:id/edicao` (autoridade de escrita + perfil gerenciável; CPF COMPLETO canônico só aqui, auditado `USUARIO_DADOS_CONSULTADOS` sem o CPF; a listagem segue mascarada) e `PATCH /administracao/usuarios/:id` estendido: nome, e-mail, tipoConta, matrícula, setor, horarioTrabalho (null limpa), ipsPermitidos (substitui; [] limpa; valem na hora), grupoAcessoId (null retira). `cpf` e senha NUNCA entram (strictObject). Regras: matrícula única (409), grupo existente/ativo/da empresa, MASTER com grupo 409 e virar MASTER limpa o grupo, último MASTER protegido, ADMINISTRADOR não promove MASTER, e-mail só se a identidade tem UM vínculo (senão 409 `EMAIL_IDENTIDADE_COMPARTILHADA`: a identidade é global), e-mail em uso 409, troca de e-mail preserva a senha, cancela redefinições e revoga as sessões do afetado (`USUARIO_EMAIL_ALTERADO` sem o e-mail), o ator não se tranca fora (409 `IP_TRANCARIA_O_PROPRIO_ATOR`). Auditoria `USUARIO_DADOS_ALTERADOS` (antes/depois sem CPF e sem IPs: só contagens).
- **D — Duplicar usuário:** modo `duplicar` do mesmo modal: dados pessoais vazios; só perfil (se o ator o cria) e grupo (achado pelo nome entre os ativos) vêm do modelo; nota discreta "Usando [Nome] como modelo de acesso". `POST /administracao/usuarios` aceita `usuarioModeloId` (da empresa; senão 404 `USUARIO_MODELO_NAO_ENCONTRADO`): na MESMA transação, `copia-acesso.service.copiarAcessoIndividual` copia as camadas individuais (exceções de recurso, bloqueios e concessões diretas) SÓ quando o ator é MASTER e o destino não é MASTER; senão informa (`copiaDeAcesso.motivo` `SOMENTE_MASTER`/`DESTINO_MASTER`). Falha = rollback total.
- **E — Alterar senha (SUPERA a regra antiga de reset administrativo fora do escopo):** `POST /administracao/usuarios/:id/senha-provisoria` `{ senhaProvisoria }`: NUNCA senha definitiva; reutiliza o ciclo da `074` (Argon2id, 48 h/72 h, troca obrigatória), revoga todas as sessões, cancela pedidos de redefinição, sem e-mail; auditoria `REDEFINICAO_ADMINISTRATIVA_SENHA` (ator, alvo, empresa, validade; nunca senha/hash). Recusa: a própria conta (409 `USUARIO_SENHA_PROPRIA`, vai às Configurações) e identidade com vínculo em outra empresa (409 `SENHA_IDENTIDADE_COMPARTILHADA`: senha é global). Autoridade `GERENCIAR_USUARIOS` e perfil gerenciável (D3).
- **F — Configurar permissões:** `GET /administracao/usuarios/:id/permissoes` devolve o catálogo REAL em camadas: recursos/operações com efeito (`rbac/recursos.js` `RECURSOS_COM_EFEITO` + `ROTULOS_RECURSOS`, do backend) e todas as linhas de `acoes`; por célula: `perfil`, `grupo`, `individual`, `efetivo` (= `autorizacao.avaliarPermissaoRecurso/Acao`, as funções do middleware, perguntadas para o alvo) e `origem` (por `opiniaoIndividual/opiniaoDoGrupo`, agora exportadas); ações trazem `estado` (PADRAO/CONCEDIDA/BLOQUEADA), `estadosPermitidos`, `motivoNegado`, `regras` (SST, AUTODECISAO_PROIBIDA). Escrita (SÓ MASTER ativo, nunca no MASTER, que é fixo): `PATCH .../permissoes/recursos/:recurso` (tri-state por operação, só operações com efeito; tudo null apaga a linha de `usuario_permissoes_recurso`) e `PUT .../permissoes/acoes/:codigo` `{ estado }` (CONCEDIDA = `concederDireta` da 3I, só ação ativa em modo ALTERNATIVA/OBRIGATORIA; BLOQUEADA = `usuario_bloqueios` e retira a concessão direta; transacional); novo `permissao-individual.repository.js` e `permissao-usuario.service.js`; auditoria `USUARIO_PERMISSAO_RECURSO_ALTERADA/ACAO_ALTERADA`. ADMINISTRADOR autorizado CONSULTA (SUPERVISOR/USUARIO) mas não altera (sem escalada); a delegação (3I) e o vínculo SST não mudam. Tela: `js/permissoes-usuario.js` monta tudo do que a API devolve (nenhuma lista de páginas/ações no navegador; teste prova), controles com efeito real (Herdar/Permitir/Negar; Padrão/Concedida/Bloqueada), fixos como "Fixo", linha recalculada com a resposta. O menu e o acesso direto refletem pelo `/auth/permissoes` do alvo na próxima avaliação.
- **G — Copiar permissões:** `POST /administracao/usuarios/:id/permissoes/copiar` `{ origemId }` (destino = :id): numa transação, grupo da origem (se ativo) e, só para ator MASTER, as camadas individuais SUBSTITUEM as do destino; perfil e dados pessoais do destino nunca mudam; MASTER não é origem nem destino (409 `USUARIO_MASTER_PERMISSOES_FIXAS`); outra empresa 404; resposta diz o que ficou de fora (`GRUPO_INATIVO`, `SOMENTE_MASTER`); auditoria `USUARIO_PERMISSOES_COPIADAS`. Tela: origem fixa, destino da lista real, resumo e "Copiar permissões de [Origem] para [Destino]?" antes de confirmar.
- **Testes:** integrações `usuarios-desabilitar`, `gestao-usuarios-grupo`, `usuarios-alterar`, `usuarios-duplicar`, `usuarios-redefinir-senha`, `usuarios-permissoes`, `usuarios-copiar-permissoes` (helper `integracao/helpers/gestao-usuarios-app.js`), unitários de schemas e do adaptador `poolSobre`, frontend do módulo e da página. A lista PUT do teste de CORS ganhou `PUT /administracao/usuarios/:id/permissoes/acoes/:codigo`. O teste antigo de mass assignment deixou de recusar `email`/`grupoAcessoId` (agora válidos). As seis telas legadas seguem ATIVAS: a desativação definitiva continua pendente para o fechamento da Gestão de Usuários.
- **Correções pós-validação manual (06/10/2026):** (1) "Usuário não encontrado" ao Alterar: causa raiz = o backend na porta 3000 (iniciado antes do código das funções) devolvia 404 `ROTA_NAO_ENCONTRADA` para `/edicao` e `/permissoes`, e a tela mostrava QUALQUER 404 como "Usuário não encontrado"; os IDs estavam certos (`usuarios.id` da listagem no menu, no GET e no PATCH). Correção: 404 só vira "não encontrado" com o código do servidor (`USUARIO_NAO_ENCONTRADO`/`USUARIO_ORIGEM_NAO_ENCONTRADO`); rota inexistente tem texto próprio (`INDISPONIVEL`); teste com `usuarios.id` ≠ `identidade_id` cobre listagem, GET e PATCH. (2) Modais: o overlay é `fixed; inset:0`; passa a começar no `left` real de `main.content` (medido ao abrir e no resize: 260px no desktop, 0 no responsivo), sem valor fixo e sem mexer em largura/visual. (3) **MASTER único por empresa (DECISÃO DEFINITIVA de 06/10/2026, supera a possibilidade anterior de cadastrar MASTER pela tela):** só o Painel Privado cria o MASTER. Backend: `POST /administracao/usuarios` e o convite de usuário recusam `tipoConta` MASTER (409 `MASTER_SOMENTE_PELO_PAINEL_PRIVADO`), `PATCH` não promove (mesmo código) nem rebaixa o MASTER (409 `USUARIO_MASTER_PERFIL_FIXO`; MASTER→MASTER é no-op), duplicar com modelo MASTER é 409 `USUARIO_MODELO_MASTER`; a listagem devolve `perfisCadastraveis` (gerenciáveis sem MASTER) e `perfilFixo` por linha. Tela: Novo/Duplicar/Alterar nunca oferecem Master (nem desabilitado); editar o Master mostra só "Master", travado, e não envia `tipoConta`; o Master não tem "Duplicar usuário". Painel Privado intocado. O descartável tem dois MASTERs (ids 1 e 3) por dado criado na validação sob a regra antiga: NÃO foi apagado nem migrado. **Matriz de toggles NÃO definida:** a regra de autoridade das camadas individuais (só MASTER grava) é a atual e será revista no checklist posterior; registrado para a etapa futura: MASTER único, autoridade máxima, sem grupo, acessos estruturais fixos, não configurado por toggles; ADMINISTRADOR/SUPERVISOR/USUARIO terão configuração-base e ajustes individuais. Token/Totem intocados.
- **Fechamento de permissões (06/10/2026):** (A) login de usuário desativado: o backend já devolvia 401 `USUARIO_DESATIVADO` (só após a senha conferir); o defeito era `portal/login.js` mapear QUALQUER 401 para "E-mail ou senha inválidos"; agora `Portal.mensagens.deLogin` usa o código (`USUARIO_DESATIVADO` → "Usuário desativado. Procure o administrador da empresa."; `SENHA_PROVISORIA_EXPIRADA` → orientação de recuperação; demais 401 genéricos; senha errada de desativado segue genérica). (B) Catálogo da tela de permissões só com o que tem EFEITO REAL: recursos/operações = exatamente o que as rotas exigem (teste `catalogo-com-efeito` varre `src`), ações = `ACOES_COM_EFEITO` em `rbac/recursos.js` (as 9 aplicadas pelo backend; `ALTERAR_CONFIGURACOES`, `IMPORTAR_FUNCIONARIOS` e `REDEFINIR_SENHA` existem na tabela `acoes` mas NÃO têm uso no código e por isso não aparecem nem aceitam configuração — 404); testes de efeito real com o middleware de produção (URL direta, `/auth/permissoes` do menu, persistência, SST não contornável). (C) Copiar com efeito real (mesmo acesso efetivo, URL direta e menu, idempotente, terceiro intocado). A matriz definitiva por perfil e a autoridade de quem administra os toggles NÃO foram alteradas (comportamento atual: só MASTER grava as camadas individuais).

Configurar permissões binário (06/10/2026; sem migration; AGUARDANDO CHECKLIST DE PERFIS): a tela mostra só interruptores ON/OFF do resultado EFETIVO, sem Herdar/Permitir/Bloquear nem tabela técnica. Catálogo em `backend/src/rbac/toggles.js`: `TOGGLES` (só os com enforcement real: dashboard, histórico de funcionários, ficha de EPI, Gestão de GHE somente consulta, análise de estoque, operações de estoque, cadastrar produto, Gestão de Usuários = ação `GERENCIAR_USUARIOS`) e `PENDENCIAS` (os outros 11 dos 19 aprovados, com motivo; nenhum toggle decorativo). API: `GET /administracao/usuarios/:id/acessos` e `PUT .../acessos/:toggle` `{ ligado }` (só MASTER grava; MASTER é fixo; auditoria `USUARIO_ACESSO_ALTERADO` só do que mudou). O serviço volta a camada individual ao padrão e só grava concessão ou bloqueio individual se o efeito real ainda diferir do pedido, então não sobra exceção redundante. **BASELINE CONGELADA (validação manual aprovada em 06/10/2026 no descartável): migration `078` e toggles de Estoque e Importação; não reabrir sem regressão real.** Atualização de 06/10/2026 (migration `078`, autorizada só para isso): `MOVIMENTAR_ESTOQUE` foi separada em `ENTRADA_ESTOQUE` (POST entradas) e `BAIXA_ESTOQUE` (POST baixas), ambas ALTERNATIVA; a 078 espelha para as duas novas o que já existia de `MOVIMENTAR_ESTOQUE` por perfil, grupo, bloqueio e concessão individual (direta e delegada); `MOVIMENTAR_ESTOQUE` continua no catálogo, sem uso nas rotas. Cadastrar Produto, Entrada por Lote e Registrar Baixa são três toggles independentes (ligar também garante a leitura de `materials`, desligar mexe só na regra própria) e a página Gestão de Estoque abre com qualquer um dos três (`PAGINAS.materials`, `abrirComQualquer`); com os três OFF fica fechada. A rota de importação de funcionários exige a ação `IMPORTAR_FUNCIONARIOS` (não mais `employeeHistory.criar`), que entrou no escopo do MASTER e na página de importação. A própria 078 (ainda não aplicada a nenhum banco real, complementada com autorização de 06/10/2026) também passa `IMPORTAR_FUNCIONARIOS` de NENHUMA para ALTERNATIVA, então o toggle de Importação de Funcionários existe (ON = concessão individual, OFF = bloqueio individual, independente de `employeeHistory.criar`); a 078 recusa rodar se houver autorização individual gravada para essa ação, e copia para ENTRADA/BAIXA as concessões de `MOVIMENTAR_ESTOQUE` diretas e delegadas (refazendo a cadeia de `origem_id` com os ids novos). O alerta manual de falta de estoque agora usa `ENTRADA_ESTOQUE`. Bancos já migrados precisam da 078 e de `db:provisionar:master` (MASTER recebe `IMPORTAR_FUNCIONARIOS`). Pendências restantes: Relatórios, EPIs Entregues, Gestão de Colaboradores, Configurações, Suporte, Gestão de E-mail, LGPD e Token sem rota ou página com enforcement. A matriz por perfil NÃO foi definida. A página de Gestão de Estoque derivada dos três toggles fica para depois da separação da ação.

Nota complementar (15/10/2026): as contagens deste bloco e as do bloco "Novo → Usuário administrativo" acima ("78 migrations, `000` a `077`"; `TOGGLES` com 8 itens e `PENDENCIAS` com "os outros 11 dos 19") descrevem o estado de 06/10/2026. Em 15/10/2026 há 89 migrations (`000`–`089`, sem `088`; ver seção 12 e o inventário na seção 63) e `backend/src/rbac/toggles.js` tem **26 toggles em 6 grupos** (`GERAL`, `COLABORADORES`, `EPIS`, `ESTOQUE`, `ATENDIMENTO`, `ADMINISTRACAO`) e **8 pendências** `SEM_ENFORCEMENT` (`relatorios`, `episEntregues`, `gestaoColaboradores`, `configuracoes`, `suporte`, `gestaoEmail`, `privacidadeLgpd`, `tokenMonitoramentoHistorico`). Das "pendências restantes" listadas acima, Relatórios ganhou enforcement próprio pelos recursos `reportsAudit` e `reportsFiscal` (blocos 12K-D5 e 12K-D6 nesta seção) e Token ganhou sete toggles (`tokenVisualizar`, `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao`, `tokenRedes`, `tokenPrevia`; Atendimento Token, Etapa H). Os demais toggles criados entre 06 e 13/10/2026 (SST e aprovar/reprovar, entregas por solicitação com `semBloqueio`, cadastrar/editar funcionário, exportar histórico), as dependências entre toggles, os avisos de `rbac/avisos-acessos.js` e o aviso `DEPENDENCIA_REABILITADA` ficam para o bloco "Toggles e avisos" (Lote 2 da atualização documental). A matriz por perfil continua NÃO definida; o estudo `Projetos Bloco/Bloco 12/Estudo-Toggles-Permissoes` (13/10/2026) aguarda revisão do responsável.

**BASELINE CONGELADA (validação manual final aprovada em 06/10/2026): Gestão de Usuários; não reabrir sem regressão real.** Gestão de Usuários — fechamento e aposentadoria das seis telas legadas (06/10/2026; sem migration): a Gestão de Usuários passou a cobrir também **Grupos** (botão "Grupos": lista de ativos e inativos, Editar nome/descrição por `PATCH /grupos-acesso/:id`, Inativar com confirmação e Reativar pelas rotas existentes, e **Permissões do grupo** como interruptores ON/OFF). As permissões do grupo usam `GET /grupos-acesso/:id/acessos` e `PUT /grupos-acesso/:id/acessos/:toggle` `{ ligado }` (`grupo-acessos.service.js`, uma visão binária sobre `grupo_permissoes_*` e o serviço de permissões de grupo existente: autoridade, trava, auditoria `GRUPO_PERMISSAO_*`, isolamento por empresa e a regra de não alterar o próprio grupo são os dele). ON = o grupo concede; OFF = retira a opinião (`null`, nunca `false`, que bloquearia o que o perfil permite); só os acessos de `toggles.js` que o grupo consegue conceder (ação em modo ALTERNATIVA; Gestão de Usuários, OBRIGATORIA, não entra); ligar também concede a leitura de que o acesso depende. Integrantes: vincular, trocar e desvincular continuam por Alterar usuário › Grupo. Autorizações individuais: Configurar permissões ON/OFF; a interface de delegação foi APOSENTADA (dados, histórico e backend de autorizações ficam). Convite de usuário interno: APOSENTADO na interface (o convite do primeiro MASTER é do Painel Privado e não foi tocado; o backend `/administracao/convites-usuario` e a página pública `portal/aceitar-convite.html` ficam para convites já enviados). Desbloquear (placeholder sem contrato) foi removido da tela e segue como pendência separada (cooldown automático, Reativar e Alterar senha existem). As seis páginas (`grupos-acesso`, `grupo-permissoes`, `grupo-usuarios`, `autorizacoes-individuais`, `new-user`, `user-admin`) viraram páginas de REDIRECIONAMENTO (só o tema, nenhum módulo, nenhuma API, nenhum controle; `meta refresh` + `location.replace` para `gestao-usuarios.html`, preservando a query); os módulos `js/grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js` e `usuarios.js` e seus testes ficam (reutilizados ou preservados). Compras / Entradas, Regras Função / Setor e Validade de Estoque seguem só adiados.

Liberação visual controlada (05/10/2026, TEMPORÁRIA; não é implementação funcional): o MASTER abre os seis protótipos ainda "Em integração" (`reports`, `delivered-items`, `self-service`, `support`, `emails-gestao`, `lgpd`; `config` saiu da lista em 05/10/2026 ao virar a tela integrada de Configurações; `purchases` e `eligibility-rules` saíram em 05/10/2026 como MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS: fora de `INSPECAO_PROTOTIPOS` e de `PROTOTIPOS`, em `DESATIVADOS` de `js/inspecao-visual.js` — o link nunca recebe o marcador, dentro da inspeção fica `aria-disabled` e o clique só avisa, e a própria página recusa `?inspecao=1`; HTML, JS, testes e histórico preservados para retomada) só para inspeção. Regras: (1) `liberarInspecao` em `js/permissoes-efetivas.js` dá `href` com `?inspecao=1` aos `a.nav-pendente` pelo rótulo (`INSPECAO_PROTOTIPOS`) quando `permissoes.perfil === 'MASTER'` — a ÚNICA decisão do frontend pelo nome do perfil, explícita e provisória; não é autorização, não inferir permissões definitivas dela, e a matriz de ADMINISTRADOR, SUPERVISOR e USUÁRIO é da 12J; (2) o HTML das páginas integradas não mudou: `nav-pendente`, `aria-disabled` e a etiqueta "Em integração" continuam estáticos, e o link some para outro perfil, na revalidação e na falha da consulta; (3) `js/inspecao-visual.js` é carregado só pelos oito protótipos (seis em inspeção e os dois adiados, nos quais recusa ativar), está em `NUNCA_PUBLICAR` e fora da allowlist, age só com `?inspecao=1`, esconde a tela de login simulada, mostra a faixa fixa e recusa toda escrita na API simulada e todo submit — nunca liga protótipo a backend, nunca usa `db-api.js`, `main.js`, `localStorage` ou seed como fonte de verdade; (4) nada foi reorganizado, redesenhado ou corrigido nos protótipos; (5) quando uma dessas telas for integrada de verdade (12K em diante), ela deixa de ser `nav-pendente` e sai de `INSPECAO_PROTOTIPOS` (feito para `config` nas Configurações); (6) o marcador não pode se perder no segundo salto: dentro do protótipo aberto em inspeção, o `fileMap` inline da página e o `appendSessionToNavLinks` do `main.js` reescrevem a barra lateral para `reports.html`, `purchases.html` etc. sem o marcador (era assim que o login fictício com "Cobresul" aparecia no fluxo do MASTER), então `inspecao-visual.js` propaga `inspecao=1` aos links que levam a um dos oito protótipos, na carga e no clique em fase de captura, preservando `?_s=` e sem repetir o marcador, nunca a links de páginas integradas (Configurações inclusive), e esconde a tela de login simulada também por regra de estilo `!important`; o `href` do menu integrado é montado por `hrefDeInspecao` (uma vez só, parâmetros preservados); ao fim da revisão, remover a liberação é decisão do responsável.

Nota complementar (15/10/2026): dos seis protótipos acima, `reports` (12K-D, 06/10/2026) e `delivered-items` (12K-C, 06/10/2026) viraram telas integradas e saíram de `INSPECAO_PROTOTIPOS` e de `PROTOTIPOS`, como prevê a regra (5): em 15/10/2026 as duas listas têm quatro entradas (`self-service`, `support`, `emails-gestao`, `lgpd`), `DESATIVADOS` continua com `purchases` e `eligibility-rules`, e `js/inspecao-visual.js` é carregado só pelos protótipos restantes. No roadmap registrado dois parágrafos abaixo, 12K-C, 12K-D e 12K-E deixaram de ser futuros (12K-C, 12K-D, 12K-D5 e 12K-D6 têm bloco próprio nesta seção; 12K-E, GHE, Histórico de Funcionários e as frentes seguintes entram nos Lotes 2 e 3 da atualização documental), e o Totem avançou como Atendimento Token (Etapas A a J na `main` pela PR #57; Etapa I do Totem com homologação bloqueada e não congelada; Etapa K não iniciada). `self-service.html` continua protótipo, intocado e em inspeção; `config` continua integrado.

Entrega Git do Bloco 12 (decisão de 04/10/2026): todo o restante do Bloco 12 — 12G-6 a 12G-9, 12H, 12I, 12J e as etapas seguintes — fica no mesmo working tree da branch `feature/bloco12-fechamento`, sem staging, commit, push, PR ou merge entre as subetapas. Cada subetapa é implementada, testada, validada tecnicamente, validada manualmente quando autorizado, documentada, e o trabalho continua no mesmo working tree. Só com todo o Bloco 12 concluído, auditado e aprovado é preparada uma entrega Git consolidada, feita pelo usuário; Claude não executa nenhum comando Git, nem de leitura.

Nota complementar (15/10/2026): a entrega Git foi feita pelo responsável em partes, não numa única entrega ao fim do Bloco 12: PR #54 (merge `cdd17d6`), PR #55 (commits `de438e5` "concluir entregas, relatorios e ajustes de usuarios" e `9144073` "concluir auditoria, fiscalizacao, GHE e cadastro de colaboradores"; merge `c5ceacc`), commit `b114d6a` (Histórico de Funcionários, período, permissão e exportação PDF/XLSX) e PR #57 (merge `a6003a358176ec14a90702bdc53db13486515e18`, 15/10/2026, com as frentes de 11 a 14/10/2026, Atendimento Token incluído). A CI da PR #57 falhou na primeira execução porque três suítes J2a exigiam o sentinela da guarda D1 do PostgreSQL dedicado do Mac; a correção `18e7296dac34df2d976c6194623f103f7912d3ac` ficou restrita a `.github/workflows/ci.yml`, `backend/test/integracao/helpers/token-j.js` e `backend/test/token-j/guarda-ci-efemera.test.js` (prova de instância efêmera do GitHub Actions: marcador `GEPI_CI_EFEMERO:<run>:<tentativa>:<nonce>` gravado como comentário do banco pelo workflow e reconferido pelo helper antes de qualquer operação J2a; a guarda D1 e `src/security/autoridade-job-interno.js` não mudaram, conferido por SHA-256 contra os pinos do termo do Bloco I); a nova execução passou nos dois jobs. **CI verde não é autorização de implantação em produção.** Em 15/10/2026 `main`, `origin/main` e `origin/HEAD` apontam para `a6003a3`, a branch de trabalho é `feature/bloco12-etapa-k` (criada a partir de `a6003a3`), e `AGENTS.md` e as cópias locais com sufixo "2" permanecem não rastreadas de propósito (pendência de organização: não tocar e não incluir no Git). A regra de que só o responsável executa Git, nem de leitura pelo Claude, permanece integral.

Roadmap registrado, sem implementar antes da autorização. **Ordem oficial do Bloco 12 a partir da 12G-9 (decisão de 05/10/2026):** 12G-9 → 12K → 12L → 12M → 12I → 12J → 12N → 12O → 12P (primeiro todas as telas operacionais; depois o Dashboard; depois a Administração de Usuários e Acessos; depois revisar, validar e fechar o frontend completo). **12K — telas operacionais:** 12K-A Compras / Entradas e 12K-B Regras Função / Setor (ambos MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS em 05/10/2026: fora da navegação operacional e da inspeção, arquivos preservados, retomada por decisão explícita); 12K-C EPIs Entregues; 12K-D Relatórios; 12K-E Gestão / Edição de Funcionários (localização e pesquisa, visualização do cadastro, alteração autorizada de setor e de função, alteração EXPLÍCITA de GHE, telefone, situação, inativação e reativação quando aplicável, histórico obrigatório com valor anterior, valor novo, data/hora, responsável e motivo/observação quando aplicável; mudar setor ou função NÃO troca o GHE automaticamente; o histórico anterior nunca é apagado ou substituído; quando o GHE mudar de forma controlada, os fluxos futuros, inclusive o Totem, passam a considerar o GHE atual). **12L — Totem:** funcionário identificado por CPF ou matrícula → GHE atual → EPIs permitidos pelo GHE → solicitação; os ícones do Totem já estão desenhados pelo responsável: ao iniciar a 12L, NÃO criar ícones novos antes de pedir a ele os arquivos prontos para importação. **12H — Complementação da Gestão de Estoque / Cadastro de Materiais — ADIADA, não bloqueante (decisão de 05/10/2026): não executar agora; só retomar se surgir necessidade real futura** (a relação Categoria → Tipo, as listas por categoria, a limpeza do tipo ao trocar a categoria e "Outros" com descrição no material de consumo foram entregues na 12G-8 por rescopo de 04/10/2026; ficam: filtros na mesma relação; grade conforme o tipo, como P/M/G/GG/XGG para uniforme e numeração para calçado; categoria do material distinta da classificação técnica como EPI, sem exigir CA de uniforme comum; listas configuráveis em vez de `if`/`else` espalhados) e **12I — Dashboard Operacional e Navegação** (cartões com destino operacional clicáveis com a autoridade efetiva, deep link que respeita a autorização, filtros coerentes, multiempresa, estado sem permissão, responsividade; o backend continua a autoridade final). **PROVA DE AUTORIA — PENDENTE PARA FASE FINAL:** manual técnico completo, dossiê de autoria por decisão técnica, guia de estudo simplificado e simulação de banca com correção e repetição, só na fase final; todo checkpoint ou documento de transferência continua registrando a pendência.

Contratos da 12G-0 (sem migration, sem mudar o provisionamento do MASTER): `GET /auth/permissoes` expõe `administracao.vinculosSst` com a MESMA autoridade dos endpoints de vínculo (predicado exportado do serviço; a tela nunca infere pelo perfil); o contexto da criação (`GET /solicitacoes-epi/contexto/funcionarios` e `/contexto/:funcionarioId/materiais`, ambos `request.criar`) devolve trabalhador sem CPF e material ativo com `previstoNoGhe` e `tamanhosSugeridos` (tamanhos de lotes já existentes, sem quantidade), nunca número de estoque; o ainda não classificado (`exigeTamanho: null`, como a 044 deixou os antigos) também vem, para a tela explicar, e a criação continua recusando com 409 `MATERIAL_TAMANHO_NAO_CLASSIFICADO` (esconder o não classificado fazia um GHE com EPIs parecer vazio); o detalhe traz trabalhador, material de cada item e só id e nome de solicitante, decisor e encerrador, lidos depois da autorização e do 404, sem CPF nem e-mail; `GET /solicitacoes-epi/encerraveis` (`ENCERRAR_SOLICITACAO`) é a lista mínima de quem encerra, sem nada de estoque, e não amplia `/entregaveis` (menor privilégio: uma ação não abre a lista da outra).

Trava por par: operações que decidem sobre o saldo de um par usam `pg_advisory_xact_lock` de 64 bits (`backend/src/utils/lock-par-estoque.js`), um par por vez, em ordem canônica. Ordem global de travas: idempotência, solicitação, trabalhador, materiais, pares, lotes, numeração. Não inverter essa ordem.

Entrega direta e baixa (12C-3, feitas): por par (empresa, material, tamanho), U é o físico utilizável, D a demanda aprovada pendente, C = min(U, D), L = max(0, U − D) e G = max(0, D − U), sempre derivados da posição da cobertura (`solicitacao-epi-cobertura.repository.js`); desde a 12D-1 a única definição de "utilizável" e de demanda pendente são os fragmentos de `backend/src/repositories/sql/posicao-estoque.js` (aliases e parâmetros explícitos, sem `$1`/`$2`/`$3` fixos), usados também pela consulta de todos os pares (`posicao-estoque.repository.js`); não criar regra paralela, contador, reserva nem alocação persistida.

Estoque mínimo (12D-1, migration `067`): `materiais.estoque_minimo` é o mínimo **padrão**; `estoque_minimos` guarda só a **sobrescrita** por (empresa, material, tamanho), apenas para material com `exige_tamanho = true` (material sem tamanho nunca tem linha ali). Mínimo efetivo = linha própria, inclusive 0 (zero próprio não herda), senão o padrão. Déficit = max(0, mínimo − L); necessidade = G + déficit; `abaixoDoMinimo` = mínimo > 0 e L < mínimo. A gravação do mínimo não toma advisory lock de estoque e lê o material `FOR SHARE`; trocar `exige_tamanho` de verdadeiro para falso ou nulo com sobrescrita existente é 409 `MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS`, e nunca se apaga sobrescrita sozinho. A `067` não foi aplicada a banco de homologação ou produção: estava aplicada no banco local de revisão `gestao_epi_revisao_12g1_20261003` e, por cópia desse banco, também está presente no descartável `gestao_epi_validacao_12g6_20261004`. Aplicá-la a outro banco exige autorização separada.

Contratos HTTP da posição (12D-2, sem migration nova e sem ação de RBAC nova): Itens Disponíveis (`availableItems.visualizar`) lista os pares da posição, com `disponivel` sempre igual a `fisicoUtilizavel`, e filtra por `situacao` (derivada no servidor), `somenteComNecessidade` e `busca`; o Dashboard soma a MESMA posição (`estoqueAbaixoMinimo` compara o mínimo efetivo com o saldo livre) e só devolve cada número se o usuário vê a fonte; os mínimos ficam no recurso Material (`GET /materiais/:id/minimos` com `materials.visualizar`, `PUT` e `DELETE /materiais/:id/minimos/:tamanho` com `materials.editar`), com auditoria `ESTOQUE_MINIMO_DEFINIDO` e `ESTOQUE_MINIMO_REMOVIDO` na mesma transação e sem auditar o que não mudou; o histórico de operações aceita `ENTREGA` e `origem`, e o trabalhador, a ficha e a solicitação só saem para quem também vê `epiFicha`, nunca o CPF; o contexto da entrega direta traz a posição agregada por tamanho, nunca as solicitações que compõem a demanda. Qualquer banco persistente que sirva essas rotas precisa estar migrado até a `067`. CORS: os métodos são explícitos e obrigatórios por namespace em `criarCors` (menor privilégio); o Portal (`/api`) anuncia GET, HEAD, POST, PUT, PATCH e DELETE, e o Painel Privado (`/api/plataforma`) só GET, HEAD, POST e PATCH, e o teste `cors-metodos-das-rotas` compara as listas com as rotas montadas; uma rota nova com um verbo novo exige atualizar a lista do namespace dela. PUT e DELETE continuam métodos inseguros para a verificação de origem (CSRF), que é outra camada.

Telas da 12D-3 (frontend, sem migration, sem rota nova e sem RBAC novo; só as páginas existentes, sem mexer no menu global):

- A tela só mostra o que o servidor mediu: físico utilizável, comprometido, saldo livre, sem cobertura, mínimo efetivo com a origem (`PROPRIO` ou `PADRAO`), déficit, necessidade e a situação (`abaixoDoMinimo` é a medida pelo saldo livre). Nunca recalcular essas grandezas no navegador nem reinterpretar `disponivel`. O Dashboard mostra "—" e "sem permissão" quando o indicador vem `{ permitido: false }`, nunca um zero mascarado.
- Detalhe omitido pelo servidor não é buscado por outro caminho nem ganha espaço reservado ou aviso de permissão: o histórico de `ENTREGA` mostra ficha, trabalhador (nome e matrícula) e solicitação só se vieram na linha, e o CPF nunca é lido. A entrega direta nunca mostra quais solicitações compõem o comprometido. Nada disso vai para `localStorage` ou `sessionStorage`.
- Mínimo por tamanho: o mínimo do cadastro é o **Mínimo padrão**; a sobrescrita só existe para material com `exigeTamanho === true`, e a tela nem envia `PUT` ou `DELETE` para material de tamanho único ou não classificado (o servidor continua recusando com 409). Mínimo próprio 0 é válido e é diferente de herdar o padrão; remover é `DELETE`, nunca gravar zero. O painel lista só tamanhos com lote ou com sobrescrita, nunca uma linha para cada tamanho possível.
- Entrega direta: depois de `409 SALDO_LIVRE_INSUFICIENTE` a tela relê a posição de cada material do rascunho e **não envia nova tentativa** (botão e `confirmar()` bloqueados) até a releitura dar certo; `SALDO_INSUFICIENTE` (saldo do lote) continua um caso à parte. Na baixa, só devolução ao fornecedor e `OUTRO` dependem do saldo livre, e a mensagem de recusa nunca sugere um motivo físico para passar.
- Toda tela nova ou alterada que passe a usar módulo novo precisa do módulo no sandbox dos testes de página, na lista de scripts e em `frontend/publicacao/allowlist.json`; a trava de `innerHTML` do `interface-e6.test.js` só aceita origens escapadas conhecidas.
- A listagem de lotes `listarDisponiveis`/`contarDisponiveis` do repositório de lotes foi removida na 12D-3 (sem consumidor de produção); os itens de Itens Disponíveis saem só da posição por par, e o teste de equivalência compara a posição com `listarPorMaterial`.

- A entrega direta só usa o saldo livre: a soma do ato **por par** (nunca item a item) tem de caber em L, senão `409 SALDO_LIVRE_INSUFICIENTE`. Ordem de travas: idempotência, trabalhador, materiais, pares, lotes, numeração. O par é achado por leitura sem trava do lote (material e tamanho do lote são imutáveis pela 042) e a posição é lida **depois** da trava do par; a conferência vem depois das validações do lote, para não mudar a ordem dos erros do Bloco 10. O hash da requisição e o hash histórico da `DIRETA` não mudam.
- Eventos físicos (`CA_VENCIDO`, `AVARIA`, `DESCARTE`, `PERDA`, `AJUSTE_INVENTARIO`) nunca são recusados por reserva, só pelo saldo do lote. Atos discricionários (`DEVOLUCAO_FORNECEDOR`, `OUTRO`) são recusados se a baixa reduzir o comprometido do par; lote que não participa de U (CA ausente ou vencido, material inativo) não é bloqueado. Ordem de travas da baixa: idempotência, material, par, lote; nunca lote antes do par. A entrada não toma a trava do par.
- `ESTOQUE_BAIXA` registra a posição antes e depois e `reduziuCobertura` (o comprometido caiu, não o físico).
- Pré-condição de banco: a baixa e a entrega direta leem a posição do par, que depende das migrations `058`, `065` e `066`. Qualquer banco persistente usado por este código precisa estar migrado até a `066`; sem isso a baixa e a DIRETA devolvem 500. Aplicar migration em banco persistente continua exigindo autorização explícita e separada, e as suítes de integração que exercitam a baixa devem montar o schema com todas as migrations (`todasAsMigrations()`), nunca com um prefixo antigo.
- A recusa por saldo livre é auditada (`SALDO_LIVRE_INSUFICIENTE`) somente depois do ROLLBACK da operação principal, em transação própria por par, com supressão de 60 segundos por empresa, ator, tipo de operação, material e tamanho, serializada por advisory lock em namespace próprio (nunca o da trava do par). Só ids e números entram no registro; nunca confirmação, assinatura, justificativa, observação, dispositivo, corpo, token, cookie ou segredo. A falha dessa auditoria não troca o erro do domínio e vai para o log técnico sanitizado. Não criar migration para isso sem decisão explícita.

Vínculo SST: concedido e removido só pelo MASTER ativo da empresa. O MASTER administra vínculos, mas não é alvo de um novo vínculo (`VINCULO_SST_NAO_SE_APLICA_AO_MASTER`); vínculo legado de MASTER não é removido automaticamente. Usuário inativo não recebe vínculo novo, e o vínculo de um inativo pode ser removido.

Anti-enumeração: a solicitação que não pertence ao solicitante autenticado é "não encontrada" no cancelamento, inclusive dentro da mesma empresa: exatamente o mesmo 404 `SOLICITACAO_NAO_ENCONTRADA` (status e corpo) da inexistente e da de outra empresa, sem revelar que o id existe nem quem a criou. A própria solicitação fora de `PENDENTE` continua 409, e sem `request.editar` a autorização central responde 403 antes do domínio. Nas demais operações, a solicitação ou o usuário de outra empresa dá o mesmo 404 do inexistente.

Auditoria da solicitação e do vínculo: identificadores, status e indicadores booleanos, sem texto livre, na mesma transação do ato. A observação da criação, a justificativa do cancelamento, a do encerramento e o motivo do vínculo ficam só no registro de negócio; a auditoria registra só se foram informados (`temObservacao`, `comJustificativa`, `comMotivo`), nunca o conteúdo, nem em `descricao`, nem em `contexto`, nem em `dados_anteriores` ou `dados_novos`.

Inventário de migrations `079`–`089` (registro documental de 15/10/2026; nenhuma migration foi criada, alterada ou aplicada por este registro): o repositório tem 89 arquivos em `backend/migrations/`, de `000` a `089`, **sem `088`** (suspensa; ver seção 12), e `checksums.json` com 89 entradas íntegras (conferido por `db:migrate:verificar`, verde na CI da PR #57). Finalidade e situação de aplicação de cada uma, pelo texto do próprio SQL e pelas evidências de `Projetos Bloco/Bloco 12`:

- **`079_alter_logs_auditoria_add_perfil_ator`** (12K-D5, 07/10/2026): `logs_auditoria.perfil_ator VARCHAR(20)`, snapshot do perfil que o ator TINHA no instante do evento, gravado pelo próprio INSERT de `auditoria.repository.registrar` (um ponto só); NULL nos registros anteriores (a leitura mostra "—"); CHECK de formato; sem FK para `perfis` (a FK propagaria `ON UPDATE CASCADE` a linhas append-only); índice `(empresa_id, criado_em DESC, id DESC)` para a trilha por empresa e período. Só ADD COLUMN, CHECK e índice: gatilhos append-only e barreira JSON da 014 intocados. Aplicada a schemas temporários de `gestao_epi_teste_local` e ao descartável `gestao_epi_validacao_config_20261005`. Suítes com lista fixa só a incluem se a lista tiver a `012`.
- **`080_create_fiscalizacao_pacotes`** (12K-D6, 07/10/2026): tabela imutável de metadados dos pacotes de fiscalização (o ZIP fica no armazenamento, nunca no banco): `GERANDO → CONCLUIDO | FALHA`, estados finais imutáveis (gatilhos bloqueiam DELETE, TRUNCATE e qualquer UPDATE fora de `heartbeat_em` enquanto GERANDO; a identidade do pedido nunca muda), UNIQUE `(empresa_id, chave_idempotencia)` com `requisicao_hash` (mesma chave com outro pedido = 409; FALHA nunca reiniciada com a mesma chave), índice único parcial = um GERANDO por empresa, `escopos` JSONB validado por `fiscalizacao_escopos_validos` (1 a 20 códigos distintos; a lista permitida é do serviço, sem migration por módulo novo), finalidade em CHECK (`OUTRA` exige observação), `perfil_ator` snapshot como na 079, `chave_armazenamento` `<empresa>/pacote-<id>.zip` gerada pelo servidor, `sha256` e `tamanho_bytes` do ZIP. Sem registro, nas evidências lidas, de aplicação a banco persistente protegido.
- **`081_alter_matricula_opcional`** (12K-E): `funcionarios.matricula` e `entregas_epi.trabalhador_matricula` passam a aceitar NULL (CPF continua obrigatório); a UNIQUE `(empresa_id, matricula)` da 006 continua (NULL não colide); CHECK de formato `NOT VALID` em `funcionarios` (vale para toda escrita nova, sem varrer a tabela); o CHECK do snapshot da entrega é substituído pela mesma regra, com a matrícula validada só quando existe; sem backfill; 006 e 058 intocadas. **Sem pasta própria de evidência em `Projetos Bloco/Bloco 12` e sem registro localizado de homologação manual**; o contrato está nos testes `funcionario-matricula-opcional-{banco,entregas,http}.integration.js` (na importação, a Situação passa a ser obrigatória, "Ativo").
- **`082_create_tipos_material_classificacao_v2`** (decisões de 07 e 08/10/2026): catálogo `tipos_material` por empresa (grupo `EPI | Vestimenta`, 12 grupos de proteção fechados, nome diferente de "outros", `ativo`, `origem BASE | MANUAL`; imutável salvo `ativo`; unicidade lógica por nome normalizado; seed de 26 tipos BASE para cada empresa existente, e a empresa nova recebe o mesmo catálogo no cadastro, pelo serviço, nunca pelo banco); `materiais` ganha `modelo_classificacao` (`LEGADO` para tudo o que existia, `V2` para o novo ou convertido), `categoria_descricao`, `grupo_protecao`, `grupo_protecao_descricao` e `tipo_material_id` com FK composta coerente (empresa, id, grupo, proteção, nome: o banco impede tipo de outro grupo, proteção, empresa ou nome) e CHECKs de V2 e de legado; substitui o CHECK "Outros ⇔ descrição" da 071 (passa a valer só para V2) e o de óculos com grau (V2 = EPI + Proteção ocular; LEGADO pelos três nomes históricos); `entregas_epi_itens.material_grupo_protecao` (snapshot, NULL no existente); **UPDATE `categoria 'Uniforme' → 'Vestimenta'`** (único dado alterado; id, estoque, vínculos e histórico preservados). **Sem pasta própria de evidência e sem registro localizado de homologação manual**; contrato em `migration-082-classificacao-v2.integration.js` e `material-classificacao-v2.integration.js`.
- **`083_alter_ghe_add_codigo_create_ghe_tipos_material`** (GHE, Incremento 1, 09/10/2026): estritamente aditiva, sem backfill: `grupos_homogeneos_exposicao.codigo VARCHAR(30)` canônico (aparado, maiúsculo, único por empresa quando existe; legado NULL; o formato `GHE-` + 3 a 6 dígitos é regra do serviço) e tabela `ghe_tipos_material` (GHE × tipo do catálogo, `OBRIGATORIO | NAO_OBRIGATORIO`, FKs compostas `RESTRICT`, nasce vazia; `ghe_materiais` continua como exceção e legado). Evidência em `GHE-codigo-tipos/I1-green-083`. O descartável `gestao_epi_validacao_ghe_20261009` estava nela em 12/10/2026.
- **`084_alter_funcionarios_add_situacao`** (Gestão de Funcionários S1, 10/10/2026): `funcionarios.situacao` `ATIVO | AFASTADO | INATIVO` NOT NULL DEFAULT `ATIVO` (backfill `ativo` true → ATIVO, false → INATIVO; ninguém nasce AFASTADO); `ativo` vira coluna GERADA `(situacao = 'ATIVO') STORED`: escrever `ativo` direto é erro 428C9, as duas nunca divergem e quem lê `ativo` (entrega, solicitação, posição de estoque) continua correto; `atualizado_em` preservado (gatilho desligado só durante o backfill, na mesma transação). Evidência `Funcionarios-situacao/S1-green/green-084.txt` (14/14). Aplicada aos descartáveis `gestao_epi_validacao_ghe_20261009` (12/10/2026, junto com 085–087) e `gestao_epi_validacao_funcionarios_20261010`.
- **`085_insert_acao_exportar_historico_funcionarios`** (Histórico de Funcionários, pacote J, 11/10/2026): só dados: ação `EXPORTAR_HISTORICO_FUNCIONARIOS` (ALTERNATIVA, sem SST, nasce negada; o MASTER a recebe pelo escopo de provisionamento, então bancos existentes precisam de `db:provisionar:master`); a exportação exige esta ação E `employeeHistory.visualizar`. Aplicada, com autorização e backup `pg_dump` prévio, SÓ ao descartável `gestao_epi_validacao_funcionarios_20261010` (`db:provisionar:master --empresa 1`, auditoria id 885); `gestao_epi_homolog_local` sem ela.
- **`086_create_atendimento_token`** (Atendimento Token, Etapa A, 11/10/2026): só estrutura nova (nenhuma tabela existente muda; o pedido do tablet usa a origem `AUTOATENDIMENTO` já prevista na 065): `token_dispositivos` (situação derivada dos carimbos, sem coluna de status; credencial só como SHA-256 mais o hash anterior, para detectar reuso; número de série é inventário, nunca autenticação), `token_ativacoes` (código do QR só como hash, uso único, validade ≤ 10 minutos, um pendente por tablet), `token_atendimentos` (sessão curta do trabalhador, um aberto por tablet; motivos `PEDIDO_ENVIADO | SAIDA | INATIVIDADE | SUBSTITUIDO | DISPOSITIVO_REVOGADO`), `token_redes_autorizadas` (`IP_FIXO | TUNEL`, CIDR; EXCLUDE gist: sub-rede de túnel ativa nunca se sobrepõe a outra), `token_dispositivo_eventos` (append-only, 10 tipos; duração só em `RESTABELECIMENTO`; o heartbeat não grava evento por batida) e `solicitacoes_autoatendimento` (1:1 imutável com a solicitação; gatilho exige origem `AUTOATENDIMENTO` e o mesmo funcionário do atendimento). Toda referência é FK composta `(empresa_id, …)`.
- **`087_insert_acoes_atendimento_token`** (Etapa A): seis ações, nenhuma com SST, todas nascem negadas: `TOKEN_GERAR_ATIVACAO`, `TOKEN_REVOGAR_DISPOSITIVO`, `TOKEN_GERENCIAR_REDES` (**OBRIGATORIA**, como `GERENCIAR_USUARIOS`), `TOKEN_PREVIA_CATALOGO_REAL`, `TOKEN_VISUALIZAR_MONITORAMENTO` e `TOKEN_VISUALIZAR_HISTORICO` (ALTERNATIVA). O recurso `atendimentoToken` (visualizar, criar, editar) não tem linha no banco. A entrada no escopo do MASTER e o enforcement vieram nas Etapas B, C e H; as duas ações de visualização ainda estão fora de `ACOES_COM_EFEITO` (Etapa J). 086 e 087 aplicadas ao descartável `gestao_epi_validacao_ghe_20261009` em 12/10/2026 (homologação da Central) e a schemas temporários.
- **`088`**: não existe; suspensa (seção 12).
- **`089_token_dispositivos_queda_suspeita`** (Etapa J, J2a, 13–14/10/2026): só `ADD COLUMN token_dispositivos.queda_suspeita_desde TIMESTAMPTZ` (anulável, sem DEFAULT, backfill, índice, CHECK ou gatilho): primeira observação de silêncio do tablet pelo job de monitoramento, que a lê e a limpa; não é estado visual, não é evento e não confirma queda. Aplicada só a schemas temporários (cluster dedicado `127.0.0.1:55432` e `gestao_epi_teste_local`); aplicá-la a banco persistente é pendência (P-07 do checkpoint do Bloco I) e exige autorização própria.

Pré-condições de banco por funcionalidade, acumuladas sobre a `078`: Relatório de Auditoria ≥ `079`; Fiscalização ≥ `080`; Gestão de Funcionários e Histórico ≥ `084` (`081` para matrícula opcional; `085` para exportar); cadastro de materiais V2 e GHE × tipo ≥ `083` (`082` para o catálogo); Atendimento Token ≥ `087`; job de monitoramento ≥ `089`. Registro de 12/10/2026: `gestao_epi_homolog_local` seguia na `060`. Nenhuma das migrations `079` a `089` foi aplicada a banco de homologação ou produção; aplicar qualquer uma delas continua exigindo autorização separada por banco. Cada migration nova continua exigindo ajuste autorizado das suítes com lista fixa de migrations e do manifesto (`verificar-checksums.js --atualizar`).

12K-C — EPIs Entregues (06/10/2026; sem migration, sem RBAC novo; `pages/delivered-items.html` deixou de ser protótipo): rota `GET /entregas-epi/itens` (`epiFicha.visualizar`), repositório `entrega-epi-historico.repository.js`, módulo `frontend/js/entregas-epi-historico.js` (`EpiEntregasHistorico`), `PAGINAS.deliveredItems` abre com `epiFicha.visualizar`. Uma linha por item entregue, lida dos snapshots congelados da entrega, nunca do cadastro atual; validade = data operacional + prazo congelado; status Válido / Próximo (0 a 30 dias) / Vencido; origem Direta / Por solicitação; busca sem caixa e sem acento; CPF nunca aceito nem devolvido; 401/403 antes de qualquer consulta; isolamento por empresa. **Status:** implementado; testes GREEN (integração 3209, unitário 3232, frontend 1866; evidências em `Projetos Bloco/Bloco 12/12K-C-epis-entregues/evidencias`); validação manual sem documento na pasta. Na `main` (commit `de438e5`, incorporado pela PR #55).

12K-D — Relatórios D1–D4 (06/10/2026; sem migration, sem RBAC novo; `pages/reports.html` deixou de ser protótipo; **BASELINE CONGELADA: validação manual aprovada em 06/10/2026; não reabrir sem regressão real**): `GET /api/relatorios/{estoque,proximo-vencimento,vencidos,epis-entregues}` (`relatorio.routes.js`, `relatorio.controller.js`, `relatorio.service.js`, `relatorio-{estoque,entregas}.repository.js`, `relatorio.schema.js`; consulta estrita: filtro desconhecido = 400; busca sem acento), módulo `frontend/js/relatorios.js` (`EpiRelatorios`). Estoque exige `materials.visualizar`; as três abas de entregas exigem `epiFicha.visualizar`; `PAGINAS.reports` abre com qualquer uma (`abrirComQualquer`). Regras: saldo "disponível" = `fisicoUtilizavel` oficial (CA ausente ou vencido zera e tem alerta próprio `CA_AUSENTE`); situação `SEM_ESTOQUE | EM_ALERTA | DISPONIVEL`; CA próximo do vencimento = regra oficial de 60 dias da Validade de estoque, em faixas 0–10 / 11–20 / 21–30 dias (`TROCAR_URGENTE | ATENCAO | PROXIMO`); cada lote é uma linha; exportação CSV em páginas de 100, até 100 páginas. Limitações aceitas pelo responsável: item vencido já substituído não é removido (não há vínculo autoritativo de substituição); o alerta de estoque compara o saldo utilizável com o mínimo padrão, sem descontar a demanda aprovada pendente. **Status:** GREEN (integração 3242, frontend 1892; `Projetos Bloco/Bloco 12/12K-D/evidencias`); validação manual aprovada e baseline congelada em 06/10/2026 (registro da sessão principal). Na `main` (commit `de438e5`, PR #55).

12K-D5 — Relatório: Auditoria (07/10/2026; migration `079`; recurso novo `reportsAudit`): `GET /api/relatorios/auditoria/{indicadores,solicitacoes-nao-atendidas,solicitacoes-reprovadas,ca-vencidos,log}` com permissão própria **`reportsAudit.visualizar`** (`RECURSOS_RELATORIOS` em `rbac/recursos.js`; rótulo "Relatório — Auditoria"; toggle `reportsAudit`, grupo GERAL; entra em `ESCOPO_PROVISIONAMENTO_MASTER`, então bancos existentes precisam de `db:provisionar:master`); a rota `fichas-sem-assinatura` foi removida (404). Arquivos: `relatorio-auditoria.{repository,service,schema}.js`, `auditoria.repository.js` (grava `perfil_ator`), `relatorio.controller.js` e `relatorio.routes.js`, `relatorios.js`, `reports.html`, `permissoes-efetivas.js`, `grupo-permissoes.js`; 56 testes com lista fixa de migrations ajustados. Conteúdo: quatro cartões (Entregas pendentes; CA vencidos em estoque, com prévia de 5 itens e link `stock-validity.html?situacao=VENCIDO`; Logs de 30 dias; Itens reprovados); solicitações aprovadas não atendidas só como "Aguardando entrega" / "Parcialmente atendida" (sem "Atrasado": não há SLA); o indicador "Fichas sem assinatura" foi REMOVIDO no pacote final (card, tabela, rota, repositório, serviço e testes; `ACEITE_PRESENCIAL` e `DESENHO` seguem modalidades válidas de confirmação da entrega — correção documental de 15/10/2026 autorizada pela V7, conferida em `RELATORIO-TECNICO-12K-D5.md`); trilha de auditoria com janela padrão de 30 dias e teto de 92 (`PERIODO_MAXIMO_EXCEDIDO`), `PERIODO_INVERTIDO`, perfil "—" para eventos anteriores à 079. A consulta à trilha é auditada (`AUDITORIA_LOG_CONSULTADA`, supressão de 5 minutos por usuário, só booleanos de filtro). "Notificar" desabilitado e "Em integração" (sem canal). CSV: BOM, `;`, CRLF, neutralização de fórmula, teto de 10.000 linhas. **Status:** implementado; GREEN (integração 3273, unitário 3238, frontend 1918). Validação manual: `Projetos Bloco/Bloco 12/12K-D5/pacote-final-validado/RELATORIO-TECNICO-12K-D5.md` (07/10/2026 13:19) registra "validação manual final APROVADA … Código congelado", enquanto a transferência V7 de 13/10/2026 (`Token-autoatendimento/J-PLANEJAMENTO/SAFEWORK-TRANSFERENCIA-V7-PREPARACAO-ETAPA-K.md`, §3.1) diz "validação manual pendente": contradição registrada, a resolver pelo responsável; até lá, não tratar como validado. A `079` não foi aplicada a banco persistente protegido. Na `main` (commit `9144073`, PR #55).

12K-D6 — Relatório: Fiscalização (07/10/2026; migration `080`; recurso novo `reportsFiscal`; diretório novo `backend/src/storage/`): pacote de documentação em ZIP para fiscalização e auditoria externa. Rotas `POST /api/relatorios/fiscalizacao/previa`, `POST /api/relatorios/fiscalizacao/pacotes` e `GET /api/relatorios/fiscalizacao/pacotes[/:id[/download]]`, todas com **`reportsFiscal.visualizar`** (rótulo "Relatório — Fiscalização"; toggle `reportsFiscal`, GERAL; escopo do MASTER). Arquivos: `config/fiscalizacao.js` (100.000 linhas por módulo, 100 MiB por ZIP, 366 dias, heartbeat 15 s, abandono 120 s), `schemas/fiscalizacao.schema.js`, `services/fiscalizacao-pacote.service.js` e `fiscalizacao-pacote.ambiente.js`, `repositories/fiscalizacao-{modulos,pacote}.repository.js`, `storage/armazenamento-local.js`, `utils/zip-limitado.js` (yazl), `utils/periodo-fiscal.js`, `scripts/fiscalizacao-recuperar-abandonados.js` (`npm run fiscalizacao:recuperar`), aba Fiscalização em `relatorios.js` e `reports.html`. Regras: 5 finalidades (`FISCALIZACAO_TRABALHO`, `AUDITORIA_CLIENTE`, `AUDITORIA_INTERNA`, `SOLICITACAO_JURIDICA_DOCUMENTAL`, `OUTRA`, esta com observação obrigatória, até 500); 4 escopos (`FICHAS_ENTREGAS_CONFIRMADAS`, `TRILHA_AUDITORIA`, `HISTORICO_ESTOQUE_CA`, `REGRAS_GHE`; colunas explícitas: nunca CPF, hashes, tokens ou traço de assinatura); período por data civil, inclusivo, ≤ 366 dias; snapshot `REPEATABLE READ`; ZIP em streaming com o teto aplicado durante a escrita (manifesto, LEIAME, CSV e JSON por módulo, posição de lotes); `VERSAO_FORMATO = 1`; idempotência por empresa (mesma chave e mesmo pedido devolvem a tentativa existente em qualquer estado; outro pedido = 409; FALHA nunca reiniciada); um GERANDO por empresa; geração abandonada (sem heartbeat por `FISCALIZACAO_ABANDONO_SEGUNDOS`) é recuperada SÓ pelo cron externo, nunca por timer na API: remove temporário e ZIP órfão e marca `FALHA` `GERACAO_ABANDONADA`, nunca promove a CONCLUIDO; download reconfere o SHA-256; outra empresa recebe o mesmo 404. Armazenamento: interface que um driver S3 também implementaria (`iniciar`, `abrir`, `existe`, `remover`, `removerResiduos`); chave só com inteiros do servidor; o caminho resolvido tem de ficar dentro da raiz; escrita em temporário publicada por link que nunca sobrescreve; pastas 0700 e arquivos 0600; `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO` ausente ⇒ serviço indisponível e rotas 503 `FISCALIZACAO_INDISPONIVEL`. Variáveis novas em `.env.example`: `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO`, `FISCALIZACAO_HEARTBEAT_SEGUNDOS`, `FISCALIZACAO_ABANDONO_SEGUNDOS`. Dependência nova: `yazl` 3.3.1. **Status:** implementado; GREEN (`Projetos Bloco/Bloco 12/12K-D6/green`: integração D6 61/61; integração 3334, unitário 3266, frontend 1938); pacote de validação manual gerado em 07/10/2026 (`12K-D6/validacao-manual/`); **aprovação manual sem documento comprobatório** na pasta; a lista `GHE-codigo-tipos/I0-baseline/lista-congelados-fiscalizacao.txt` (09/10/2026) já trata os arquivos da Fiscalização como congelados, e a transferência V7 de 13/10/2026 o dá como "não iniciado": divergência registrada, a resolver pelo responsável; até lá, não tratar como validado nem como congelado. A `080` não foi aplicada a banco persistente protegido. Na `main` (commit `9144073`, PR #55). Pendência anotada pelo responsável durante o D6 (07/10/2026), só para os ajustes finais do frontend: no bloco superior esquerdo do menu, remover "v1.0", mostrar "by SafeWork" e tornar o bloco clicável para o Dashboard, preservando o layout.

Toggles e avisos (06–13/10/2026; sem migration; continuação de "Configurar permissões binário" e da nota complementar de 15/10/2026 acima): o catálogo `backend/src/rbac/toggles.js` passou de 8 para **26 toggles**, em `GRUPOS` `GERAL` (`dashboard`, `reportsAudit`, `reportsFiscal`), `COLABORADORES` (`historicoFuncionarios`, `cadastrarFuncionario`, `editarFuncionario`, `importacaoFuncionarios`, `exportarHistoricoFuncionarios`), `EPIS` (`fichaEpi`, `entregasSolicitacao`, `gestaoGhe`), `ESTOQUE` (`analiseEstoque`, `operacoesEstoque`, `cadastrarProduto`, `entradaLote`, `registrarBaixa`), `ATENDIMENTO` (`tokenVisualizar`, `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao`, `tokenRedes`, `tokenPrevia`) e `ADMINISTRACAO` (`gestaoUsuarios`, `aprovarSolicitacoes`, `reprovarSolicitacoes`); cada toggle é um recurso + operação ou uma ação com enforcement real, e as 8 `PENDENCIAS` seguem `SEM_ENFORCEMENT` com motivo (`gestaoColaboradores` com texto novo desde 10/10/2026: coberto por Cadastrar/Editar Funcionário; `tokenMonitoramentoHistorico`: Etapa J).

- **Dependências:** 9 toggles dependem de uma leitura (cadastrar/editar funcionário → `employeeHistory.visualizar`; cadastrar produto, entrada por lote e registrar baixa → `materials.visualizar`; `tokenCadastrar`, `tokenEditar`, `tokenRevogar`, `tokenGerarAtivacao` → `atendimentoToken.visualizar`), aplicadas só ao LIGAR (ligar concede também a leitura; desligar mexe só na regra própria); `rbac/dependencias-acessos.js` dá rótulo e chave da dependência para a auditoria e os avisos. Decisão de 13/10/2026: ligar um dependente reabilita uma leitura bloqueada sem 409 — a auditoria registra `contexto.causa = 'dependencia'` e o PUT devolve o aviso `DEPENDENCIA_REABILITADA` (conferência manual não executada, conforme o termo de congelamento da Etapa H do Token).
- **Flags:** `entregasSolicitacao` (ação `REALIZAR_ENTREGA`; `Projetos Bloco/Bloco 12/Gestao-Usuarios-entregas-solicitacao`, 06/10/2026 17:49) tem `semBloqueio`: desligar só retira a concessão individual e nunca cria bloqueio; `aprovarSolicitacoes` e `reprovarSolicitacoes` (06/10/2026 17:28) têm `concessao` e só produzem efeito com o vínculo SST (nota de 15/10/2026 em "Navegação da 12G-5"); `importacaoFuncionarios` e `exportarHistoricoFuncionarios` não têm dependência.
- **Grupo × individual:** 22 toggles podem ser concedidos por grupo (ON = o grupo concede; OFF = `null`, nunca `false`); 4 são só individuais (`gestaoUsuarios`, `aprovarSolicitacoes`, `reprovarSolicitacoes`, `tokenRedes`: ações OBRIGATORIA ou de concessão).
- **Avisos (`rbac/avisos-acessos.js`; "Correções do MASTER", 10/10/2026, `Projetos Bloco/Bloco 12/Gestao-usuarios-correcoes`):** regra única pelas dependências do catálogo; `GET` e `PUT` de `/administracao/usuarios/:id/acessos` e de `/grupos-acesso/:id/acessos` devolvem `{ acesso, avisos }` com os códigos `FUNCIONARIOS_SEM_VISUALIZAR`, `EXPORTAR_HISTORICO_SEM_VISUALIZAR`, `TOKEN_SEM_CONSULTAR` e `PREVIA_SEM_HISTORICO_FUNCIONARIOS`; o aviso só informa, nunca revoga (decisão do responsável: não revogar criar/editar ao desligar visualizar); no grupo é calculado sobre a CONFIGURAÇÃO do grupo (ligado = o grupo concede) e o texto nunca diz que integrantes perderam acesso. MASTER ativo: "Gestão de Usuários" aparece ligado e fixo pela autoridade administrativa de leitura (`temAutoridadeAdministrativaLeitura`, só na leitura), SEM gravar `GERENCIAR_USUARIOS` no perfil; Aprovar/Reprovar seguem desligados para ele. `js/permissoes-usuario.js` não conhece recursos nem toggles (monta tudo do que a API devolve); `gestao-usuarios.html` ganhou `avisoDependencias`. `RECURSOS_COM_LEITURA_NA_ATRIBUICAO_DIRETA = ['employeeHistory']` (`operacoesGarantidasNaAtribuicaoDireta`).
- **Sem toggle, com efeito real:** `request.*`, `ENCERRAR_SOLICITACAO`, `materials.editar`, `employeeGroups.criar|editar`, `stockValidity.visualizar` e `ADMINISTRAR_GRUPOS_ACESSO|ADMINISTRAR_PERMISSOES_GRUPO|ADMINISTRAR_VINCULOS_GRUPO`. **Em banco e sem uso no código:** `MOVIMENTAR_ESTOQUE`, `ALTERAR_CONFIGURACOES`, `REDEFINIR_SENHA`, `TOKEN_VISUALIZAR_MONITORAMENTO`, `TOKEN_VISUALIZAR_HISTORICO`. `ACOES_COM_EFEITO` em `rbac/recursos.js` tem 16 ações: `ENTRADA_ESTOQUE`, `BAIXA_ESTOQUE`, `IMPORTAR_FUNCIONARIOS`, `EXPORTAR_HISTORICO_FUNCIONARIOS`, `REALIZAR_ENTREGA`, `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO`, `ENCERRAR_SOLICITACAO`, `GERENCIAR_USUARIOS`, as três `ADMINISTRAR_*` e `TOKEN_REVOGAR_DISPOSITIVO`, `TOKEN_GERAR_ATIVACAO`, `TOKEN_GERENCIAR_REDES`, `TOKEN_PREVIA_CATALOGO_REAL`.
- **Status:** SST e aprovar/reprovar GREEN (integração 3216, frontend 1873); `entregasSolicitacao` GREEN (integração 3221); Correções do MASTER GREEN (unitário 3354, integração 3814, frontend 2462), cuja validação manual está em contradição documental (transferência V7 de 13/10/2026: "pendente"; `Historico-funcionarios/Auditoria-pre-git/19-RECOMENDACOES-E-SEQUENCIA-GIT.txt`, 11/10/2026: "já validadas") — a resolver pelo responsável. O `Estudo-Toggles-Permissoes` (13/10/2026; sete documentos: catálogo integral, histórico de construção, manual técnico, matriz de evidências com inconsistências I1–I14 e validações abertas V1–V13, exemplos ponta a ponta, tela cinza, procedimento reutilizável) é só documentação, nada executado, com revisão do responsável pendente. A matriz definitiva por perfil continua NÃO definida; "Desbloquear" continua pendência separada.

Classificação V2 do material (decisões de 07 e 08/10/2026; migration `082`, descrita no inventário acima; nota complementar de 15/10/2026 em "Categoria → Tipo da 12G-8"):

- **Modelo:** Grupo (`categoria`: `EPI` | `Vestimenta` | `Outros`) → Grupo de Proteção (12 fechados: Proteção auditiva, contra quedas, da cabeça, das mãos, das pernas, dos braços, dos pés, facial, ocular, da pele (membros superiores), respiratória e do tronco | `Outros`) → Tipo (`tipoMaterialId` do catálogo da empresa | `Outros`). "Outros" em qualquer nível exige o "Especifique…" correspondente (`categoriaDescricao`, `grupoProtecaoDescricao`, `tipoDescricao`) e nunca é linha do catálogo; campo que não se aplica NUNCA é aceito (nada escondido chega ao banco). O material anterior é `LEGADO`: edita campos não relacionados sem conversão (`classificacaoIntocada`); alterar a classificação exige o bloco completo e o converte a V2. Óculos com grau: em V2, `oculosComGrau` (Sim/Não) é obrigatório para EPI + Proteção ocular, pelo grupo de proteção e não pelo nome; o LEGADO continua pelos três nomes históricos (`ehOculos`). Valor efetivo de exibição por UMA regra, em JS e em SQL, reutilizada por filtros, telas e relatórios, nunca `COALESCE` solto por consulta (decisão 1 de 07/10/2026; a mesma função existe em `frontend/js/materiais.js`, conferida por teste).
- **Catálogo de tipos:** `tipos_material` por empresa; `CATALOGO_BASE` (26) em `backend/src/utils/classificacao-material.js` é a fonte única do seed da `082` e do provisionamento da empresa nova (`empresa-cadastro.service`). Rotas `GET /tipos-material` (`materials.visualizar`), `POST /tipos-material` (`materials.criar`; 409 `TIPO_MATERIAL_JA_EXISTE`) e `POST /tipos-material/:id/{inativar,reativar}` (`materials.editar`) — reutilizam o recurso `materials` por decisão de 08/10/2026, sem recurso novo; `tipo-material.{routes,controller,service,repository,schema}.js`; auditoria `TIPO_MATERIAL_CRIADO`, `TIPO_MATERIAL_INATIVADO`, `TIPO_MATERIAL_REATIVADO`. Tipo inativado continua ligado ao material e ao GHE e aparece como "(inativo)". A importação CSV/XLSX de tipos ficou de fora (decisão de 08/10/2026).
- **Frontend:** `js/tipos-material.js` (`EpiTiposMaterial`, fonte única dos caminhos do catálogo), `js/materiais.js` e `pages/materials.html` (seletor encadeado Grupo → Proteção → Tipo só com tipos ativos; estados `LEGADO` / `CATALOGO` / `TIPO_INATIVO` / `TIPO_INDISPONIVEL` / `OUTROS`); `js/catalogo-visual.js` (12G-7) passou a resolver também pelos nomes do catálogo V2 e pelo grupo efetivo (`Vestimenta` usa o desenho de uniforme; teste `catalogo-visual-v2.test.js`). A entrega grava o snapshot `material_grupo_protecao` do item (`entrega-classificacao-v2.integration.js`).
- **Achado não corrigido (decisão do responsável, 11/10/2026):** `EpiTiposMaterial.mensagens.codigoDe` lê `codigo` e `detalhes` em `r.dados`, mas o envelope de erro do `EpiHttp` os traz no topo, então em `materials.html` um 400 do catálogo aparece como "Dados inválidos."; a página de GHE usa adaptador local.
- **Status:** implementada; testes GREEN (`migration-082-classificacao-v2`, `material-classificacao-v2`, `entrega-classificacao-v2`, `tipos-material-catalogo`, `utils/classificacao-v2`, `frontend/test/materiais-classificacao-v2`); **sem pasta própria de evidência em `Projetos Bloco/Bloco 12` e sem registro localizado de homologação manual**. As complementações de tela de 11/10/2026 (A2 e A3) estão no bloco "Pedido de EPI × GHEs importados" abaixo. Na `main` desde antes da PR #57 (histórico recente; o commit específico não foi conferido por Git).

Gestão de Funcionários — 12K-E, S1 a S4, RBAC e CPF (09–10/10/2026; migrations `081` e `084`, descritas no inventário acima; evidências em `Projetos Bloco/Bloco 12/Funcionarios-situacao`: 413 arquivos, só logs RED/GREEN, mais `S4-integridade/relatorio-conferencia-integridade.md` e `RBAC-ajuste-final/reconciliacao-resumo.md`):

- **S1 — situação (`084`):** `funcionarios.situacao` `ATIVO | AFASTADO | INATIVO` é a fonte da verdade e `ativo` é gerada; `utils/situacao-funcionario.js` concentra as transições permitidas e a elegibilidade a EPI (só ATIVO recebe, pede e é atendido).
- **S2 — `POST /funcionarios/:id/situacao`** (`employeeHistory.editar`): auditoria `FUNCIONARIO_SITUACAO_ALTERADA`; o AFASTADO não recebe nem solicita EPI (`FUNCIONARIO_AFASTADO`), mas a decisão da SST sobre um pedido já existente não depende da situação; as rotas legadas `inativar`/`reativar` mapeiam para INATIVO/ATIVO.
- **S3 — GHE:** `GET /funcionarios/ghes` (`employeeHistory.visualizar`) devolve os GHEs do formulário; `grupoHomogeneo { id, codigo, descricao }` nas respostas; a troca de GHE é auditada como `FUNCIONARIO_GHE_ALTERADO`. Mudar setor ou função NÃO troca o GHE; o GHE é alterado explicitamente, como previa o roadmap da 12K-E.
- **S4 — cadastro e edição individuais:** `POST /funcionarios` (`employeeHistory.criar`) e `PATCH /funcionarios/:id` (`employeeHistory.editar`): CPF imutável; `situacao` e `ativo` nunca vêm do cliente; setor, função, GHE e data de admissão obrigatórios; datas pela data civil de São Paulo com `relogio` injetado no controller; `FUNCIONARIO_DATA_NASCIMENTO_INVALIDA`; `FUNCIONARIO_GHE_OBRIGATORIO` ao tentar GHE → null. Matrícula opcional (`081`); na importação em lote (`POST /funcionarios/importacao` e `GET /funcionarios/importacao/ghes`, ambas pela ação `IMPORTAR_FUNCIONARIOS`) a Situação passa a ser obrigatória, "Ativo", e a regra "existente nunca é alterado" da 12G-9 não mudou.
- **RBAC:** toggles `cadastrarFuncionario` (`employeeHistory.criar`) e `editarFuncionario` (`employeeHistory.editar`), dependentes de `visualizar`; `null` explícito em `visualizar` com criar/editar verdadeiros → 400 `VALOR_NAO_PERMITIDO`; a importação segue com permissão própria. `PAGINAS.funcionarios = { abrir: employeeHistory.visualizar, alterar: employeeHistory.editar }`; `PAGINAS.importEmployees` passou a abrir pela ação `IMPORTAR_FUNCIONARIOS`.
- **CPF — `POST /funcionarios/:id/cpf/revelar`** (`employeeHistory.editar`): `Cache-Control: no-store`; limite de 10 por minuto por ator e empresa, aplicado DEPOIS da autorização e ANTES da validação (429 com `Retry-After`); uma linha de auditoria por revelação (finalidade EDICAO), nunca o CPF; auditoria falha ⇒ 500 e nenhum CPF. A tela mostra o CPF completo por cerca de 30 s; listagens e buscas nunca aceitam nem devolvem CPF.
- **Frontend:** `pages/funcionarios.html` (título "Cadastro de Colaboradores"; item de menu `data-pagina="funcionarios"` entre Ficha de EPI e Histórico de Funcionários nas páginas integradas e no Início do Portal) e `js/gestao-funcionarios.js` (`EpiGestaoFuncionarios`: listar, cadastrar, editar, trocar GHE, alterar situação — INATIVO não vai direto a AFASTADO —, filtro de situação, paginação, busca local por nome/matrícula/setor/cargo/GHE, moldura e responsividade padrão). **Pendência confirmada em 15/10/2026:** `pages/funcionarios.html` e `js/gestao-funcionarios.js` NÃO estão em `frontend/publicacao/allowlist.json`, contrariando a regra da 12D-3 (correção só com autorização; não é alteração documental).
- **Status:** cada incremento com RED e GREEN registrados em logs (reconciliação: unitário 3327, frontend 2162; baseline final: unitário 3322, integração 3696); "fechados e congelados em 10/10/2026" conforme registro da sessão principal, **sem termo de congelamento na pasta**; os nove arquivos protegidos (`AGENTS.md` e oito `… 2.js`) conferidos como preservados (`S4-integridade`, classe A, 9 de 9). Na `main` (`9144073`, PR #55, conforme a mensagem do commit).

GHE — código, vínculo por tipo e importação GHE/EPI (Incrementos I1 a I6C, 09/10/2026; migration `083`, descrita no inventário acima; evidências em `Projetos Bloco/Bloco 12/GHE-codigo-tipos`, só logs RED/GREEN):

- **I0 — baseline:** `lista-congelados-funcionarios.txt` e `lista-congelados-fiscalizacao.txt` definem o que não podia mudar; nove arquivos protegidos 9 de 9.
- **I2 — código do GHE:** obrigatório para GHE novo, formato `GHE-` + 3 a 6 dígitos (`utils/codigo-ghe.js`; regra do serviço e da interface), único por empresa, editável; o GHE legado continua com `codigo` NULL. Exceções autorizadas em testes congelados de funcionários (`excecao-congelados/*.diff`, com justificativa: só a infraestrutura de schema das suítes passou a incluir a `083`).
- **I3 — GHE × tipo:** `GET /grupos-homogeneos/:id/tipos-material` (`employeeGroups.visualizar`), `PUT` e `DELETE /grupos-homogeneos/:id/tipos-material/:tipoId` (`employeeGroups.editar`; classificação `OBRIGATORIO | NAO_OBRIGATORIO`; reutiliza o recurso, sem recurso novo); `ghe-tipo-material.{routes,controller,service,repository,schema}.js`. O vínculo direto `ghe_materiais` continua como exceção e legado.
- **I4 — "previsto no GHE" híbrido:** `repositories/sql/previsto-ghe.js` é a definição única: vínculo direto OU vínculo por tipo (`ghe_tipos_material` × `materiais.tipo_material_id`); os dois contam como previsto; os snapshots históricos (`previsto_no_ghe`, `ghe_nome`) não são recalculados. Pedido, entrega e o catálogo do Token usam a mesma definição.
- **I5 e I5C — importação GHE/EPI:** `POST /grupos-homogeneos/importacao/preview` (só leitura) e `POST /grupos-homogeneos/importacao/confirmar` (exige `employeeGroups.criar` E `editar`; corpo até 512 KiB; transação única com trava por empresa; revalida; idempotente; seguro sob concorrência; auditoria com origem `IMPORTACAO_GHE_EPI`); `ghe-importacao.{routes,controller,service,repository,schema}.js` e `utils/ghe-importacao.js`. A importação nunca cria tipo (complemento A1 no bloco "Pedido de EPI × GHEs importados" abaixo).
- **I6A, I6B e I6C — frontend:** `pages/employee-groups.html` mostra Código / Descrição / Situação (Setor, Função e `descricao` saíram da tela), GHE × tipo como gestão principal e os vínculos diretos a materiais como bloco secundário (`js/grupos-homogeneos.js`); `js/importacao-ghe.js` lê `.xlsx` no navegador por `vendor/read-excel-file-9.3.10.min.js` (até 1000 linhas, 10 MB) e chama prévia e confirmação; `publicacao/allowlist.json` atualizada; correção de UX de rolagem (`I6C-ux-scroll`). A nomenclatura "Gestão de GHE" (05/10/2026) não mudou.
- **Status:** RED e GREEN registrados por incremento; **validação manual e congelamento não documentados na pasta**. O banco descartável `gestao_epi_validacao_ghe_20261009` (criado em 09/10/2026) estava na `083` em 12/10/2026, quando recebeu `084`–`087` para a homologação da Central do Token; não foi localizado registro de homologação manual dos incrementos do GHE. Na `main` (`9144073`, PR #55, conforme a mensagem do commit).

Histórico de Funcionários — pacotes A a J (10–11/10/2026; branch `feature/historico-funcionarios` sobre `c5ceacc`; migration `085`, descrita no inventário acima; evidências em `Projetos Bloco/Bloco 12/Historico-funcionarios/{AB,C,D,Busca-unica,Exibicao-condicional,E,F,G,H,J,I}-red|green`, `J-homologacao` e `Auditoria-pre-git`): `pages/employee-history.html` (a frase "`employee-history.html` intocado" do bloco 12G-9 vale para 05/10/2026) e `js/historico-funcionarios.js`, sem mexer em `js/funcionarios.js` (importação).

- **A e B — busca única e ficha:** um campo só; nome ou matrícula vão por GET (`GET /funcionarios`); CPF completo (11 dígitos) vai SÓ no corpo de `POST /funcionarios/consulta-cpf` (Opção A: inválido, incompleto ou com letras é recusado localmente sem requisição; sem fallback; matrícula numérica de 11 dígitos não é buscável); selecionar carrega `GET /funcionarios/:id` (nome, matrícula, setor, cargo, GHE atual, situação); CPF e telefone não aparecem. Exibição condicional: ficha, indicadores e linhas do tempo ficam ocultos até o detalhe real; CPF recusado localmente mantém a ficha aberta.
- **C — EPIs:** `GET /fichas-epi?funcionarioId=` → `GET /fichas-epi/:id/entregas` (exige `epiFicha.visualizar`; sem ela, "Sem permissão para ver o histórico de EPIs."); corpo 200 inválido = falha; ficha de outro funcionário = falha genérica com nova tentativa; `previstoNoGhe` e confirmação ficam fora da tela.
- **D — indicadores:** quatro cartões a partir do `resumo` da ficha devolvido pelo servidor (`ficha-epi.repository.js` ampliado; "hoje" = dia de São Paulo do banco, `HOJE` exportado de `entrega-epi-historico.repository.js`); nunca recalculados no navegador.
- **E, F e G — eventos:** `GET /funcionarios/:id/eventos?tipo=GHE|SITUACAO|CADASTRAL[&de&ate]` (`employeeHistory.visualizar`; `funcionario-eventos.{service,repository}.js`), reconstruídos de `logs_auditoria`, sem migration: GHE com dedupe do par `FUNCIONARIO_ALTERADO` + `FUNCIONARIO_GHE_ALTERADO` da mesma transação e `atual` só do GHE gravado pelo id, da empresa da sessão (o legado só tem o id; código e descrição nulos); SITUACAO de `FUNCIONARIO_SITUACAO_ALTERADA`, `INATIVADO`/`REATIVADO` (legado, com dedupe) e `CRIADO` (chave `ativo`); CADASTRAL com um evento por operação e `alteracoes: [{ campo, anterior, novo }]` só quando antes ≠ depois (nome, matrícula, setor, função, data de admissão como texto `YYYY-MM-DD`; telefone e nascimento nunca, só "informado"; crachá não).
- **H — período:** `de`/`ate` pelo dia de São Paulo de `criado_em` (`PERIODO_INVERTIDO`; parcial aceito no backend, como nas entregas; a tela exige as duas datas), aplicado aos quatro históricos; o período persiste na troca de pessoa e "Limpar" o desfaz; `GET /fichas-epi` nunca leva período; o cartão do período não usa `.filters-grid`.
- **J — permissão de exportar:** ação `EXPORTAR_HISTORICO_FUNCIONARIOS` (`085`), toggle `exportarHistoricoFuncionarios` (COLABORADORES, sem dependência, independente de visualizar), aviso `EXPORTAR_HISTORICO_SEM_VISUALIZAR`, MASTER pelo escopo de provisionamento; `services/exportacao-historico-autorizacao.service.js` `avaliar()` → `{ visualizar, exportar, permitido }` (exportar exige os dois).
- **I — exportação:** `POST /funcionarios/:id/historico/exportacao { formato: pdf | xlsx, de?, ate? }` (autorização no serviço, antes de qualquer leitura; `PERIODO_INCOMPLETO`, `PERIODO_INVERTIDO`, `DATA_INVALIDA`; 403 `EXPORTACAO_NAO_AUTORIZADA`; 404 `FUNCIONARIO_NAO_ENCONTRADO`; 422 `EXPORTACAO_GRANDE_DEMAIS` acima de 5.000 registros por seção, nunca truncar; 429 `EXPORTACAO_LIMITE_EXCEDIDO` com 10 por minuto contados pela auditoria sob advisory lock, válido entre instâncias; 500 `EXPORTACAO_FALHOU`); `funcionario-historico-exportacao.service.js`, `exportacao-historico/{formatos,formatacao,pdf,xlsx}.js` (modelo neutro de documento; `pdfkit` A4 paisagem; `write-excel-file` com uma planilha por seção e proteção contra injeção de fórmula), `repositories/exportacao-historico.repository.js`; sem `epiFicha.visualizar`, entregas e indicadores saem `null`; auditoria `FUNCIONARIO_HISTORICO_EXPORTADO` (formato, período, seções, contagens, bytes, sha256 do arquivo). Decisões D1–D8 em `I-red/DIAGNOSTICO-FORMATOS-E-DECISOES.txt`.
- **Status:** A+B, C, D, Busca Única, Exibição condicional, E, F, G e H homologados pelo responsável em 10–11/10/2026; J GREEN e com homologação controlada (`085` só no descartável `gestao_epi_validacao_funcionarios_20261010`, com backup; MASTER 1 e 3 exportam, ADMINISTRADOR negado); I GREEN (backend 17/17, complemento de formatos 8/8; unitário 3364, integração 3903, frontend 2553) e homologado em 11/10/2026 — conforme `*-green/RELATORIO-*.txt`, `J-homologacao`, o registro da sessão principal e a transferência V7 de 13/10/2026 ("homologados"). `Auditoria-pre-git` (11/10/2026): 96 entradas, 87 aptas, recomendação de commit único, feito pelo responsável em `b114d6a`; a pendência `proxy-addr` foi registrada ali (nota de 15/10/2026 na seção 2).

Pedido de EPI × GHEs importados (11/10/2026; branch `fix/pedido-epi-funcionarios-importados` sobre `b114d6a`, incorporada à `main` pela PR #57; sem migration; evidências em `Projetos Bloco/Bloco 12/Pedido-epi-importados`, só logs e diagnósticos):

- **Causa (diagnóstico aprovado em 11/10/2026):** os GHEs criados pela importação GHE/EPI só têm vínculo por TIPO (`ghe_tipos_material`) e os materiais legados não têm `tipo_material_id`, então o Pedido não oferecia nada; `previsto-ghe.js` está correto. Decisão: NÃO converter os quatro materiais legados do banco de validação. `B1-DIAGNOSTICO` (só leitura em `gestao_epi_validacao_funcionarios_20261010`): 184 trabalhadores em 32 GHEs com vínculo por tipo e nenhum material ofertável.
- **Plano aprovado:** A1 tipos não encontrados na prévia + cadastrar o tipo pela rota existente → A2 materiais compatíveis por tipo → A3 cadastro de material com tipo pré-selecionado → A5 aviso no Pedido → A6 pedido manual de "Outros" (o backend já aceita fora do GHE; falta a tela; todo material exige CA, e `exige_ca` sem API é tema da 12H) → A4 legado (baixa prioridade). "Outros" preservado.
- **A1:** `resumo.tiposNaoEncontrados: [{ nome, variantes, linhas, ghes, reservado, nomeExcedeLimite }]` DENTRO de `resumo` (o nível principal tem asserção homologada de chaves); a prévia lista os tipos ausentes e a tela (`js/importacao-ghe.js`, `employee-groups.html`) permite cadastrá-los por `POST /tipos-material` (409 `TIPO_MATERIAL_JA_EXISTE`); a importação nunca cria tipo; três listas de scripts de página ajustadas com `tipos-material.js`. GREEN 38/38 (unitário 3376, integração 3912, frontend 2570); `A1-HOMOLOGACAO` preparou planilha fictícia.
- **A3 (renomeada pelo responsável):** estado do catálogo junto ao Tipo (`#materialTipoEstado`, estados E1–E5, só `textContent`) e sugestão de nome só no cadastro novo (`formulario.sugestaoNome`, que não sobrescreve nome digitado); D2 óculos e D3 "Outros" sem mudança; só `materiais.js` e `materials.html`. O travamento "Verificando sua sessão…" visto na homologação foi cache do servidor estático da 5500 sem `Cache-Control` (HTML novo com `materiais.js` antigo → `TypeError` em `sugestaoNome` antes de montar), não defeito de código. Complemento "proteções por Grupo" (`protecoesDoCatalogo`; D1 catálogo ativo do grupo + Outros; D2 falha = lista completa com aviso `#materialProtecaoEstado`), com 8 ajustes de teste autorizados; frontend 2604.
- **A2:** situação da classificação do material escolhido em Estoque por lote (`#materialClassificacaoAtual`, abaixo de `#gradeMaterialHelper`, só `textContent`): `CATALOGO | TIPO_INATIVO | TIPO_INDISPONIVEL | OUTROS | LEGADO` (`situacaoClassificacao` S1–S6, `textoClassificacao` T1–T5); só `materiais.js` e `materials.html`; frontend 2621.
- **Status (transferência V7 de 13/10/2026):** A1 GREEN técnico (a homologação manual no banco de validação aguardava a reinicialização autorizada da API); **A3 homologada em 11/10/2026**; A2 GREEN técnico aguardando homologação; A4, A5 e A6 não iniciadas. A validação final está prevista num banco novo, criado só com autorização.

Atendimento Token — Etapas A a J (11–14/10/2026; migrations `086`, `087` e `089`, descritas no inventário acima; evidências em `Projetos Bloco/Bloco 12/Token-autoatendimento/{A..J}-*`, com `00-REGISTRO-DE-CONGELAMENTO.md` em cada `*-CONGELADO`; tudo na `main` pela PR #57, ver a nota de 15/10/2026 em "Entrega Git do Bloco 12"). Quatro coisas distintas, que nunca se confundem: implementação (código escrito), testes (RED/GREEN/regressão), homologação (validação manual do responsável) e congelamento (baseline documental com SHA-256).

- **Arquitetura e decisões do responsável (11/10/2026):** tablet COMPARTILHADO da empresa, ativado por QR de uso único (10 min) que emite uma credencial persistente e revogável do dispositivo; atendimento curto por trabalhador identificado por CPF (11 dígitos) OU matrícula exata, **sem segundo fator** (decisão encerrada: data de nascimento, crachá, PIN e senha descartados); pedidos com origem `AUTOATENDIMENTO` (já prevista na 065) no fluxo normal da SST, sem fluxo paralelo; regra B1: material físico cadastrado, sem exigir saldo; **nenhum indicador de estoque e nenhum "Reservar"** no tablet; rede corporativa OBRIGATÓRIA (IP fixo ou túnel; sem rede = bloqueado); heartbeat ~60 s e offline após ~3 min; tabela lateral `solicitacoes_autoatendimento`; RBAC por toggles; administração na entrada de menu existente "Autoatendimento (Totem)" renomeada "Atendimento Token" (sem item novo); `self-service.html` preservado e intocado; referência visual oficial do tablet `~/Desktop/token-epi.html` (35 466 B; protótipo com `localStorage`, saldos e "Reserve"; **intocável**); os ícones do Totem já foram desenhados pelo responsável. A correção da `AUTODECISAO_PROIBIDA` pelo vínculo `usuarios.funcionario_id` (073) é requisito registrado e **não implementado**.
- **A — banco e RBAC (11/10; CONGELADA; n/a para homologação, é estrutura):** `086`/`087`; 9 permissões = recurso `atendimentoToken` (visualizar, criar, editar) + 6 ações; 21/21 e mutação 35/35; 16 suítes de contagem de migrations ajustadas 86→88.
- **B — administração dos dispositivos (11/10; validação final aprovada; CONGELADA, 16 arquivos):** `GET/POST /api/atendimento-token/dispositivos`, `GET/PATCH /:id`, `POST /:id/revogar`; `token-dispositivo.*`; recurso `atendimentoToken` + `TOKEN_REVOGAR_DISPOSITIVO` no escopo do MASTER e em `ACOES_COM_EFEITO`; decisões DB-1..DB-5: tablet revogado é somente leitura (409 `DISPOSITIVO_REVOGADO`), revogação repetida 200 `alterado:false`, revogar zera `credencial_hash` e a anterior, cancela a ativação pendente e encerra o atendimento aberto; só o nome é obrigatório; texto em branco vira `null`; histórico de localização por `logs_auditoria` (`dados_anteriores`/`dados_novos`, evento `ALTERACAO`), sem migration, porque o gatilho da 014 recusa chave JSONB com "token"/"credencial". O reforço S1–S3 provou ausência de vazamento de credencial em qualquer coluna da auditoria e dos eventos (12 de 12 vazamentos simulados mortos). Mutação 51/52 (1 equivalente).
- **C — ativação e autenticação do tablet (11/10; validação final aprovada; CONGELADA, 28 arquivos):** `POST /dispositivos/:id/ativacao` (`TOKEN_GERAR_ATIVACAO`; código de 256 bits, só o hash no banco, uso único, ≤ 10 min, um pendente por tablet), `POST /tablet/ativar`, `GET /tablet/estado`; `token-ativacao.*`, `token-tablet.*`, `token-credencial.repository.js`, `middleware/autenticacao-dispositivo.js`; decisões D-C1..D-C8: TUNEL negado sem atestação, IP_FIXO só host exato, recuperação de tablet ATIVO por nova ativação que substitui a credencial atomicamente e sem anterior, carência 120 s, rotação 24 h, cookie `gepi_tablet` (`SESSAO_DISPOSITIVO_COOKIE_NOME`) com `Path=/api/atendimento-token/tablet` e 180 dias com expiração absoluta no servidor (`DISPOSITIVO_ROTACAO_HORAS`, `DISPOSITIVO_CARENCIA_SEGUNDOS`, `DISPOSITIVO_COOKIE_DIAS` no `.env.example`); limites por IP folgados (NAT) e finos por tablet; `/atendimento-token/tablet*` fora do limitador geral da API (`limitadorGeralSalvoTablet`); CSRF: `POST ativar` exige Origin/Referer da allowlist e JSON (415 para `text/plain` e formulário). Corridas S0–S5 determinísticas (`token-tablet-corridas.integration.js`, sincronização por `pg_blocking_pids`, sem sleeps). Quatro arquivos receberam acréscimos legítimos da D (aceitos pelo responsável e documentados, sem reescrever a baseline C). Pendências de implantação: **D-C9** (SameSite=Strict só para `gepi_tablet`; não alterar agora), `GET /estado` rotaciona a credencial (efeito em GET, avaliar cross-site), `TRUST_PROXY_HOPS` exato na AWS (valor maior que o real permite forjar IP), fronteira de rede do TUNEL, MDM/atestação do tipo de equipamento (User-Agent não prova), HTTPS/CORS/Origin/Path.
- **D — atendimento do trabalhador (11/10; validação final aprovada; CONGELADA, 17 arquivos; sem migration, `088` suspensa):** `POST/GET /tablet/atendimento`, `POST /atividade`, `POST /encerrar`; cookie `gepi_atendimento` SameSite=Strict; identificação por CPF ou MATRICULA com tipo explícito (CPF só estrutura; matrícula por igualdade exata do cadastro, sensível a caixa, zeros preservados, sem fallback); só o primeiro nome na resposta; **60 s de inatividade DESLIZANTES, sem teto**, só `POST atividade` renova (polling, GET e heartbeat nunca); 10 tentativas/min por tablet (em memória: com várias instâncias o limite efetivo se multiplica); 404 único `FUNCIONARIO_NAO_IDENTIFICADO` e 401 único `ATENDIMENTO_INVALIDO`; motivos de encerramento só os da 086; **"recusar não é encerrar"**: funcionário não ATIVO ou atendimento anterior à reativação do tablet → 401 sem fechar o registro e sem motivo falso; reativação detectada por `token_ativacoes.usado_em` (consumo do código, `clock_timestamp()` sob a trava do tablet) e reconferência da credencial sob a trava (correção determinística da janela de reativação, `D-JANELA-REATIVACAO` e `D-CORRECAO-JANELA`). 91/91; mutação 62 mortos de 67 (5 equivalentes).
- **E — catálogo (12/10; validação técnica aprovada; CONGELADA, 12 arquivos):** `GET /tablet/atendimento/catalogo` (`token-catalogo.*`, `repositories/sql/catalogo-token.js`); leitura pura `READ ONLY REPEATABLE READ`, não renova os 60 s nem reemite cookie; seleção = material da empresa, ativo, `exige_tamanho` classificado (nulo excluído), previsto no GHE ATUAL por vínculo direto ou por tipo ATIVO (tipo inativo não concede; decisões D-E1..D-E11), com ao menos um tamanho quando exige; saldo nunca filtra nem aparece; tipo genérico nunca é item; `imagem: { disponivel: false }` (**E15 bloqueado**: não existe estrutura de imagens no sistema; a biblioteca de imagens na Gestão de Estoque — upload, MIME/tamanho, isolamento por empresa, storage compatível com AWS, fallback — é obrigatória antes da homologação final do Totem). Dois testes de frontend atualizados por expectativa obsoleta do escopo do MASTER (`E-GREEN-FRONTEND`).
- **F — pedido (12/10; validação técnica aprovada; CONGELADA documental, 14 arquivos):** `POST /tablet/atendimento/pedido` e `GET /pedidos/:chave` (`token-pedido.*`); cria a solicitação REAL `AUTOATENDIMENTO` pelas mesmas peças da 12G-6 (numeração, idempotência, auditoria), sem solicitante, `PENDENTE`, sem ler nem gravar estoque; aceite e persistência numa só transação (idempotência → tablet com credencial reconferida → atendimento `FOR UPDATE` = PONTO DE ACEITE → trabalhador `FOR NO KEY UPDATE` → materiais `FOR SHARE` → numeração), sucesso só depois do COMMIT, 202 `EM_PROCESSAMENTO` por try-lock, um pedido por atendimento (encerrado `PEDIDO_ENVIADO` na mesma transação), repetição idempotente devolve o original, 409 `ITEM_NAO_AUTORIZADO` pelo catálogo da E, 1 a 20 itens com `ITEM_REPETIDO`; D-F2: motivos só `SUBSTITUICAO_PRAZO`, `DESGASTE_DANO`, `PERDA_EXTRAVIO` (sem `ADMISSAO`, `OUTRO` ou observação); **D-F6 = Alternativa A do responsável**: a recuperação do resultado vale só pelo atendimento original enquanto o cookie vale (~60 s); a consulta posterior é da G e é outra operação. 58/58.
- **G — solicitações em aberto e duplicidade (12/10; validação técnica aprovada; CONGELADA documental, 10 arquivos):** `GET /tablet/atendimento/solicitacoes` (`token-solicitacoes.*`; `{ temDisponiveis, itens: [{ materialId, nome, tamanho, situacao, quantidade, retiradaParcial }] }`; situações `DISPONIVEL_PARA_RETIRADA` — só `coberta` > 0 pela fila FIFO; aprovar NÃO é disponibilidade —, `AGUARDANDO_ESTOQUE`, `AGUARDANDO_APROVACAO`, `INDISPONIVEL`, derivadas da 12G-6; estados fechados não aparecem; sem número de pedido, CPF, matrícula ou saldo); duplicidade por item **só no Totem** (409 `ITEM_JA_SOLICITADO` em `token-pedido.service.js`, após a trava do trabalhador; única alteração autorizada na F); o canal interno não é bloqueado por desenho (G16c: característica aceita, não unicidade global). 47/47 + 5.
- **H — Central Administrativa (12–13/10; CONGELADA COM RESSALVAS, aprovação do responsável em 13/10/2026):** bloco "Central de Atendimento Token" abaixo.
- **I — Totem (13/10; I-G1 a I-G5 executados; BLOQUEIO DE HOMOLOGAÇÃO; NÃO CONGELADA):** bloco "Totem" abaixo.
- **J — monitoramento, alertas, histórico, destinatários, Dashboard (13–14/10):** **J1 só documentação** (`J-PLANEJAMENTO/00`–`07`; decisões D1–D30 em `02-MATRIZ-DECISOES.md`, a maioria PENDENTE — aprovadas: destinatários SST/TI por empresa com CRUD, canais Dashboard/Central/e-mail da mesma fonte, carrinhos abandonados só como contagem derivada, princípio de sem timer na API; exceções X1–X15; o `07` prevalece); **J2a implementado e homologado no dedicado** (bloco "Bloco I / J2a" abaixo); J2b, J3a, J3b, J4a, J4b, J4c, J5 e J6 **não iniciados**; as abas Monitoramento e Histórico da Central seguem "em integração" e `TOKEN_VISUALIZAR_MONITORAMENTO`/`TOKEN_VISUALIZAR_HISTORICO` seguem sem enforcement.
- **K — NÃO INICIADA** conforme o checkpoint de 14/10/2026 (sem pasta, contrato ou RED; só escopo de alto nível nos mestres de 11 e 12/10/2026: segurança, quiosque, redes, allowlist, homologação integrada em tablet real, AWS; o mestre de 11/10 também enumera subincrementos técnicos K1–K11 — K1 estrutura … K8b prévia … K11 hardening — que **não se confundem** com as etapas de gestão A–K). Em 15/10/2026 a V7 informou que outra sessão implementa o K2 na branch `feature/bloco12-etapa-k`; este registro não documenta a Etapa K (nenhuma evidência lida) e a ordem J × K segue sem decisão escrita (P-15). **Nota de atualização (15/10/2026):** o texto acima descreve o estado do checkpoint de 14/10/2026 e fica preservado como registro histórico. O **K2 foi iniciado e implementado em 15/10/2026**, na branch `feature/bloco12-etapa-k`, mas ainda depende da validação de integração com PostgreSQL e da homologação (bloco "Etapa K — K2" abaixo). O K3 e os demais incrementos da Etapa K não foram iniciados.
- **K — atualização de 15/10/2026 (ciclo K1+K2):** a situação "NÃO INICIADA" acima é a do checkpoint de 14/10/2026 e da primeira documentação de 15/10/2026 (inclusive a frase "este registro não documenta a Etapa K", já superada) e fica preservada como registro histórico, assim como a menção "Etapa K não iniciada" na nota de 15/10/2026 de "Liberação visual controlada". Em 15/10/2026 a Etapa K foi efetivamente iniciada, na branch `feature/bloco12-etapa-k`, pelo ciclo **K1+K2**: o K1 (diagnóstico de autoridade, somente leitura) está concluído e o K2 (proteção da autoridade no serviço) está implementado, com testes sem banco aprovados; a integração com PostgreSQL e a homologação do K2 seguem pendentes (blocos "Etapa K — K1" e "Etapa K — K2" abaixo). Por decisão do responsável, comunicada pela V7 em 15/10/2026 como instrução de trabalho (sem documento próprio), a Etapa K é desenvolvida e entregue de dois em dois incrementos (K1+K2, K3+K4, K5+K6 e assim sucessivamente); cada par exige autorização expressa (seções 5 e 61) e a entrega Git segue só do responsável. O "Bloco K" dessas instruções é tratado aqui como a Etapa K do plano A–K (equivalência ainda a confirmar pelo responsável: item 1 da seção 9 do checkpoint de 14/10/2026), e a numeração K1/K2 deste ciclo, adotada nas instruções da V7 de 15/10/2026, não corresponde à lista K1–K11 do mestre de 11/10/2026 (nela, K1 é estrutura e K2 é backend). O K3, o K4 e os demais incrementos não foram iniciados. P-14 (planejamento próprio da etapa) e P-15 (ordem J × K) continuam pendentes, sem decisão escrita do responsável: a cadência de dois em dois incrementos não é planejamento da etapa nem decisão sobre J × K.

Central de Atendimento Token — Etapa H (12–13/10/2026; `pages/atendimento-token.html`, `js/atendimento-token.js`, `js/atendimento-token-tela.js`, `vendor/qrcode-generator-2.0.4.js`; backend `token-central.*` e `token-rede-admin.*`; termo `H-HOMOLOGACAO/fase-18-termo-congelamento/TERMO-CONGELAMENTO-ETAPA-H-2026-10-13.md`):

- **Backend (decisões D1–D7 em `H-PRE-GREEN/15-MATRIZ-DECISOES-D1-D7.md`):** `GET /atendimento-token/visao-geral`, `GET /dispositivos/:id/ativacao` (estado derivado `NENHUMA | PENDENTE | EXPIRADA | CONSUMIDA | CANCELADA`, sem estado persistido), `GET /previa/catalogo?funcionarioId=` (`TOKEN_PREVIA_CATALOGO_REAL`; reusa `montarCatalogoDoFuncionario`, extraído de `token-catalogo.service.js` por D6; grava **uma auditoria `TOKEN_PREVIA_CONSULTADA` por consulta**, só o id: a prévia não é só leitura no sentido de auditoria), `GET/POST /redes` e `POST /redes/:id/desativar` (`TOKEN_GERENCIAR_REDES`; D5: só IP exato, sem TUNEL, sem exclusão, com auditoria; desativar um IP deixa o tablet 403 `REDE_NAO_AUTORIZADA` sem revogar a credencial); o MASTER ganhou as duas ações (7 → 9) e 24 testes estáticos foram atualizados.
- **Tela, seis abas:** Visão Geral (indicadores); Dispositivos (cadastro, consulta, detalhes, edição, revogação); Ativação (QR gerado com a biblioteca local, código só em memória e descartado em sete situações, contagem, descarte e substituição — "Fechar e descartar" só apaga o QR do navegador, a ativação continua pendente até vencer ou ser substituída —, e as redes autorizadas); Monitoramento e Histórico (**só a estrutura, "em integração", Etapa J**); Prévia e Testes (**hoje = "Prévia do catálogo"**: busca do funcionário por nome ou matrícula via `GET /funcionarios`, que exige `employeeHistory.visualizar` — **não** concedido automaticamente —, só funcionário ATIVO, resultado dentro do item do funcionário com um só botão "Ver prévia"/"Fechar prévia" (S4, homologada em 13/10/2026) e aviso fixo "Prévia administrativa, somente leitura: mostra o que o tablet exibiria para o funcionário escolhido. Não abre atendimento, não cria pedido, reserva nem entrega e não é o atendimento real."). Menu: `ajustarMenuAtendimentoToken` em `permissoes-efetivas.js` troca o rótulo "Autoatendimento (Totem)" por "Atendimento Token" (`atendimento-token.html`, `data-pagina="atendimentoToken"`) só para quem abre a Central (`PAGINAS.atendimentoToken`: `atendimentoToken.visualizar` OU `TOKEN_GERAR_ATIVACAO` OU `TOKEN_GERENCIAR_REDES` OU `TOKEN_PREVIA_CATALOGO_REAL`, `abrirComQualquer`); o HTML das 23 páginas não foi editado (a troca em massa é decisão pendente). Conteúdo do QR (`conteudoQr`, alterado pela Etapa I com derrogação documentada): `<origem>/totem/#ativar=<código>`.
- **Toggles:** os sete `token*` do bloco "Toggles e avisos"; sem toggle, só o MASTER e quem recebeu pelas APIs diretas usa a Central.
- **Homologação manual (12–13/10; banco descartável `gestao_epi_validacao_ghe_20261009`, backup `pg_dump -Fc` antes, migrations 084–087 aplicadas por autorização; backend isolado em 127.0.0.1:3100 e proxy em 5600, `http://homolog.localhost:5600`; 25 produtos `HOM-EPI-001…025` e 58 entradas fictícias com CA `HOM-FICTICIO-NNN`, só nesse banco):** T1 cadastro, T2/T2b consulta e edição e T6 revogação **aprovados**; T3 redes, T4/T5 QR e expiração e T7 prévia **aprovados com ressalvas** (P0/P1/P4/P5a/P7/P8 e os formatos inválidos de IP não conferidos um a um; estado "Aguardando leitura" e Visão Geral não relatados; sem inativos e sem permissão não testados); S4 homologada; correção da "tela cinza" (`gestao-usuarios.html` linha 157, única alteração autorizada na baseline da Gestão de Usuários) confirmada pelo responsável. **Não executado:** aceite manual de `DEPENDENCIA_REABILITADA`, roteiros manuais 1–2 da Rodada 3, conferência visual da auditoria de dependências; a integração completa não foi reexecutada depois da fase 10 (unitário 3450, integração 4396 com 1 skip E15 e 1 todo, frontend 2787). **S1–S3 pendentes, não implementadas** (nome do dispositivo no título da edição; aviso de sucesso com os campos alterados; confirmação ao esvaziar um campo). **Fragilidade latente transferida à K, sem mudar a regra:** o avaliador dispensa o vínculo SST do MASTER (`exigeSst && !ehMaster`); uma linha `MASTER × APROVAR/REPROVAR/ENCERRAR` gravada no perfil o faria passar sem vínculo nem concessão. Limitações registradas: listas até 10 páginas; Google Fonts externo; `epi-ficha.html` fora do harness de DOM. Os dados fictícios da homologação ficaram no banco (limpeza futura).

Pré-visualização visual do tablet na Central (REQUISITO REGISTRADO; **NÃO IMPLEMENTADO**; registro de 15/10/2026 a pedido da V7):

- **O que existe:** a aba "Prévia e Testes" mostra a **lista do catálogo real** do funcionário/GHE (`GET /atendimento-token/previa/catalogo`, mesma regra de seleção do tablet, somente leitura, auditada), descrita acima. `js/atendimento-token-tela.js` e `pages/atendimento-token.html` **não** carregam `frontend/totem/`, não usam `iframe` e não reproduzem as telas do tablet (conferido no código em 15/10/2026). Não declarar a simulação visual como implementada.
- **O requisito do responsável:** mestre `~/Downloads/SafeWork_MD_MESTRE_TRANSFERENCIA_TOTAL_2026-10-11.md` (11/10/2026), aba 5: "Prévia e Testes — mesma interface visual do HTML real, com catálogo real do funcionário/GHE via endpoint administrativo somente leitura; simular fluxo/carrinho sem escrever pedidos, estoque ou entregas. Provar por testes que não usa rotas de escrita; sem credencial de dispositivo no admin." (na tabela A–K, atribuída à Etapa J "read-only, sem pedidos reais na prévia"; na lista técnica, ao subincremento K8b "prévia"); reafirmado em `~/Downloads/SafeWork_MD_Diretrizes_Mestre_Consolidado_2026-10-12.md` §4.3: "(5) Prévia e Testes somente leitura/sem pedido real".
- **Por que ficou de fora:** a decisão D2 da H (`H-PRE-GREEN/15`) aprovou "começar só com o catálogo" para tocar menos baselines; o termo da H §1 lista a "integração do HTML aprovado do Totem" como fora do escopo da H; nenhum documento posterior (Etapa I, J, checkpoint do Bloco I, transferência V7 de 13/10) decidiu em que incremento a simulação visual será feita.
- **Regras já fixadas para quando for feita:** reaproveitar obrigatoriamente a interface já aprovada do Totem (`frontend/totem/`, derivada de `token-epi.html`), sem redesenho; sessão administrativa e RBAC, nunca credencial de dispositivo no admin; nenhum pedido real, nenhuma movimentação de estoque, nenhuma entrega e nenhuma rota de escrita, provado por teste; nenhum dado pessoal além do necessário. A alocação a um incremento (J ou K) é decisão do responsável, não deste registro.

Totem — Etapa I (13/10/2026; `frontend/totem/{index.html, boot.js, totem.js, totem.css}`, 13 suítes `frontend/test/totem-i-*.test.js` e `backend/test/totem-i/contratos-consumidos-pela-interface.test.js`; evidências `I-DIAGNOSTICO`, `I-CONTRATO`, `I-DECISOES-Q0-Q8`, `I-GOVERNANCA-Q0-Q8`, `I-RED`, `I-GREEN-PLANO`, `I-GREEN-G1`…`I-GREEN-G5`):

- **Origem e adaptação (Q0, aprovada):** página DERIVADA do HTML aprovado pelo responsável (`~/Desktop/token-epi.html`, 35 466 B, SHA-256 `08458202…3eaf`, intocado): as quatro telas preservadas (Identifique-se com teclado numérico 3×4, Produtos "Olá, {primeiro nome}", Tamanhos, Confirmação), CSS transposto sem mudar valores, identidade visual mantida; removido o demonstrativo (`localStorage`, produtos falsos, quantidades, "Reservar"/"Reservado"/reserva, chip "Demonstração", chips de função/setor/GHE/matrícula); nenhum saldo, estoque, lote ou reserva na tela. `I-DIAGNOSTICO/00` classificou cada elemento como A (preservar), B (substituir), C (já atendido pelo backend) ou D (dependência).
- **Decisões Q0–Q8 (`I-DECISOES-Q0-Q8/00-MATRIZ-DEFINITIVA-Q0-Q8.md`, 13/10):** Q1 QR `https://<origem>/totem/#ativar=<código>`; `boot.js` é o primeiro script, lê o fragmento, o remove com `replaceState` antes de qualquer rede e o entrega uma vez por `tomar()` (nunca storage, DOM, console, histórico); consumo só por toque em `POST /tablet/ativar`. Q2 textos integrais (confirmação neutra sem produto nem tamanho; texto único para "não ativado" e "revogado", porque o backend não os distingue). Q3 ícones locais, sem recurso externo. Q4 tablet dedicado em modo quiosque (recomendação; decisão operacional pendente). Q5 quantidade 1 por item, 1 a 20 itens. Q6 limpeza imediata ao fim/expiração; 20 s só na confirmação neutra; 30 s só para digitação abandonada. Q7 renovação só por ação explícita (nunca `mousemove`, `scroll`, temporizador, polling ou GET), uma em voo, intervalo mínimo e teto. Q8 transporte próprio `TotemHttp` (sem `console`, sem registrar caminho com a chave de idempotência, tempo limite, `Retry-After`); API resolvida pela regra de `portal/config.js`; publicação pela allowlist (os quatro arquivos estão nela).
- **Incrementos:** I-G1 estrutura e interface derivada (73 RED); I-G2 ativação e identificação CPF/matrícula com seletor explícito (41; exceção autorizada à baseline H: só `conteudoQr` e seu teste); I-G3 sessão de 60 s alimentada pelo servidor, consulta G com a marca "✓ Solicitado", catálogo E com placeholder de imagem (46); I-G4 carrinho em memória, motivo por item (3 autorizados), revisão, envio real idempotente com chave UUID só em memória, confirmação neutra, resultado incerto com "Enviar novamente" (mesma chave) e 409 de duplicidade (45); I-G5 validação integrada (`.motivos` em 3 colunas; 12 testes de chaves de idempotência; 60 capturas em Chrome headless com `fetch` simulado, em harness fora do repositório). Isolamento entre funcionários em duas camadas: geração de estado da página (resposta de geração antiga é descartada) e barreira sobre o cookie do atendimento (nenhuma identificação nova com uma pendente; só o recarregamento encerra o bloqueio). A interface nunca lê nem remove a credencial do tablet.
- **Status (decisão da V5 em 13/10/2026, `I-GREEN-G5/00-REGISTROS-I-G5.md`): "I-G5 EXECUTADO COM BLOQUEIO DE HOMOLOGAÇÃO — ETAPA I NÃO CONGELADA. O Totem não está pronto para produção. Nenhuma nova implementação está autorizada."** Pendências de usabilidade (controles parcialmente fora da área visível; confirmar em tablet real; nada foi alterado): a 500 px, "Enviar pedido" na revisão com 2 itens e "Revisar e enviar pedido" no carrinho ficam abaixo da área visível; a 1024×768, o "Continuar" da identificação fica abaixo (como no protótipo original); a revisão com até 20 itens depende de rolagem. Pendências de homologação: cookies tardios e recarregamento, integração real, tablet corporativo, HTTPS, rede autorizada, modo quiosque, biblioteca de imagens (E15), Etapa K. Não capturados: aviso 202, estados de carregamento, retorno automático de 20 s, tema claro em retrato e estreito, tablet físico.

Segurança do Atendimento Token (síntese das Etapas B a G e J2a; nada aqui é regra nova):

- **Duas credenciais, nunca misturadas:** a do TABLET (cookie `gepi_tablet`, persistente, emitida pela ativação, rotacionada a cada 24 h, com a anterior válida só na carência de 120 s; `credencial_hash` e `credencial_anterior_hash`, nunca o valor em claro no banco; fora da carência a anterior é recusada com `REUSO_CREDENCIAL`, sem revogar) e a do ATENDIMENTO (cookie `gepi_atendimento`, temporário, 60 s deslizantes). A credencial do tablet não é sessão administrativa, não identifica funcionário e não concede privilégio: popula `req.dispositivo`, nunca `req.usuario`/`req.sessao`; o middleware lê SÓ o cookie do tablet (ausente ou duplicado = ausente), nunca `Authorization`, cabeçalhos `X-*` ou query. A Central usa sessão administrativa e RBAC; nenhuma credencial de dispositivo no admin.
- **Rede:** a origem é só o `req.ip` resolvido pelo servidor (`TRUST_PROXY_HOPS`); IP_FIXO exato; TUNEL negado sem atestação; a rede é decidida ANTES da rotação (nunca se emite credencial a origem não autorizada); desativar a rede bloqueia o tablet (403) sem revogar. Nada confia em User-Agent, tamanho de tela ou sistema operacional.
- **Isolamento por empresa:** toda tabela da 086 referencia por FK composta `(empresa_id, …)`; empresa, tablet, funcionário e GHE vêm sempre do servidor (credencial, atendimento e cadastro); respostas únicas 401 `ATENDIMENTO_INVALIDO` e 404 `FUNCIONARIO_NAO_IDENTIFICADO` não revelam existência, dono nem causa; na Central, id de outra empresa recebe o mesmo 404.
- **Travas e transações:** ordem idempotência → tablet → atendimento → trabalhador → materiais → numeração (compatível com C, D e 12G); a credencial apresentada é reconferida sob a trava do tablet (a antiga nunca abre nem opera atendimento); consultas E e G em `READ ONLY REPEATABLE READ`, sem renovar nem escrever.
- **Pedidos:** um pedido por atendimento; sem estoque, reserva, baixa ou ficha até a entrega; motivos restritos; 1 a 20 itens com `ITEM_REPETIDO`; duplicidade por item só no Totem (409 `ITEM_JA_SOLICITADO`); a chave de idempotência vai no caminho de `GET /pedidos/:chave` (risco de log de proxy registrado, mitigado no cliente pelo `TotemHttp`); recuperação só na vida do cookie (D-F6).
- **Limites (D-C8):** por IP folgados (`LIMITE_ATIVACAO_POR_IP` 30 por 60 s; `LIMITE_ESTADO_POR_IP`) e finos por tablet com chave do servidor; identificação 10 por 60 s por tablet; tudo em memória do processo (limitador distribuído é pendência).
- **Eventos e auditoria:** `token_dispositivo_eventos` append-only (`REDE_RECUSADA` e `REUSO_CREDENCIAL` com supressão em `token-evento-controle.repository.js`; o heartbeat não grava evento por batida); credencial, código e chave nunca aparecem em auditoria, eventos ou logs (reforço S1–S3 da B; gatilho da 014).
- **Implantação (pendente):** D-C9 SameSite=Strict para `gepi_tablet`; manter o prefixo `/api` no caminho público (Path do cookie); mesmo site para UI e API; HTTPS; MDM/atestação; `TRUST_PROXY_HOPS` exato.

Bloco I — J2a: monitoramento, job com credencial própria e homologação no PostgreSQL dedicado (13–15/10/2026; migration `089`; `J-PLANEJAMENTO/08`–`37`; `BLOCO-I-ENCERRAMENTO/{TERMO-ENCERRAMENTO-BLOCO-I.md, MANIFESTO-EVIDENCIAS-BLOCO-I.md, CHECKPOINT-TRANSFERENCIA-BLOCO-K.md, verificar-manifesto-bloco-i.sh}`; "Bloco I" aqui é o nome dado pela V7 ao GREEN J2a, Fase 4B, e **não** a Etapa I do Totem):

- **Código (J2a):** `config/token-monitoramento.js` (heartbeat 60 s ±10 %; OFFLINE a partir de 180 s de silêncio, limiar inclusivo; confirmação 90 s; janela mínima de escrita 45 s; prazo máximo da suspeita 300 s), `services/token-monitoramento.service.js` (`derivarEstado` pura: `REVOGADO | NAO_ATIVADO | SEM_COMUNICACAO | ONLINE | OFFLINE`; `registrarContato` pela batida; `verificarComunicacao` = passagem única do job, com relógio e sonda injetados), `repositories/token-monitoramento.repository.js` e `token-dispositivo-evento.repository.js`, `routes/token-heartbeat.routes.js` + controller + schema (`POST /api/atendimento-token/tablet/heartbeat`, cookie do tablet, corpo e query vazios; **NÃO montada em `app.js`** — montagem é etapa própria, X2/P-01), `security/autoridade-job-interno.js`, `utils/sonda-publica.js`, `scripts/verificar-comunicacao-token.js` (`npm run token:verificar-comunicacao`; saídas 0 passagem concluída, 1 configuração/autoridade inválida ou falha, 2 sonda reprovada ou inconclusiva, 3 banco indisponível; `TOKEN_JOB_DB_SCHEMA` opcional, padrão `public`, ainda ausente do `.env.example`, P-06). A QUEDA é confirmada só pelo job, numa passagem posterior à primeira observação (`queda_suspeita_desde`, `089`); o RESTABELECIMENTO é feito pela batida; nunca timer na API.
- **Autoridade mínima do job:** o job atravessa empresas, então o limite real é a CREDENCIAL DO BANCO: credencial própria (`TOKEN_JOB_DB_USER`/`TOKEN_JOB_DB_PASSWORD`, nunca a da API), lida só pelo script; só opera depois de o próprio banco confirmar quem está conectado e os privilégios EFETIVOS contra a lista positiva por coluna `OBJETOS_PERMITIDOS` (`empresas(id, ativo)` leitura; `token_dispositivos` leitura de 7 colunas e UPDATE só de `comunicacao_registrada` e `queda_suspeita_desde`; `token_dispositivo_eventos` INSERT de 5 colunas e SELECT de `id`), recusando papel privilegiado, pertencimento a outros papéis, CREATE no banco ou em schema do caminho de busca, objeto fora do schema, privilégio faltando ou sobrando, relação temporária na sessão ou objeto resolvido para tabela temporária (`SQL_CAMINHO` corrigido na Fase B para excluir `pg_my_temp_schema()`; teste `token-j/job-monitoramento-sql-caminho.test.js`); mensagens só com nomes, nunca valores. `TOKEN_SONDA_URL_PUBLICA` sem valor (P-03).
- **Infraestrutura de teste:** cluster PostgreSQL DEDICADO criado pelo responsável (`~/PostgresTeste/j2a`, `127.0.0.1:55432`, papel `gepi_teste_j2a`; não é serviço, morre no reinício do Mac); guarda D1 (`test/integracao/helpers/guarda-instancia-dedicada.js`, `test/integracao/exigir-instancia-dedicada.js`, `test/token-j/guarda-d1.test.js`: as suítes J2a só rodam contra a instância dedicada); Marcos 1, 2 (Camada B), 3A e 3B ("RED INTEGRADO VÁLIDO", documento 19); 16 testes de contagem ajustados 88→89 (`J-REGISTRO-TESTES-CONGELADOS.md`, R3-001); suíte `test/token-j` com 132 testes (130 PASS, 2 TODO: DEP-U01 e DEP-U02).
- **Homologação real da role mínima (Fase 4B):** rodada `a741c814064460f9` REPROVADA (D1: 42P08 em `INSERT … CASE WHEN $6 THEN $3 END` sem tipo; D2: `$2` indefinido sob `set -u` no `rodada.sh`) e recuperação R3; D1 provada em PostgreSQL 16 temporário; aplicação D1/D2 (G1 ensaio em réplica, G2 real); guarda do wrapper (trava `mkdir` atômica de execução única); rodada `957fad794d3a5b36` REPROVADA só em "testar sombreamento" (a autoridade devolvia `SCHEMA_COM_CREATE` em vez de `OBJETO_TEMPORARIO`), contraprova C1–C4 e Fase B (autoridade `afff8311…` → `184c8bcb…`, backup `versoes-anteriores/v6`, wrapper g3 com 8 pinos); **rodada `697af3a405965adc` (wrapper g3, 14/10/2026) APROVADA: 38 PASS, 0 FAIL, 0 SKIP, 2 INFORMATIVOS** (não contados como PASS: `faltando-usage-schema` e `sequencia-evento-usage-select` — a autoridade tolera `USAGE`/`SELECT` na sequência do evento; decisão pendente do responsável), limpeza com código 0 (role e schema ausentes, fotografia antes = depois `fc7c0c3a…`), instância compartilhada intacta, trava g3 criada (nova rodada exige novo wrapper e decisão). Dos 38 PASS, 13 são portões de restauração; 25 são verificações substantivas.
- **Auditoria independente:** workflow `wf_b2bfa75a-117` (14/10/2026, 22:29–22:56, só leitura, cinco agentes, sem conexão ao PostgreSQL): **CONCLUÍDA, APROVADA com observações**, sem divergência bloqueante; resultado incorporado ao termo (§9), ao manifesto (I-01/I-02) e ao checkpoint (§8). O manifesto lista as evidências com SHA-256 (classe P, persistentes, e classe C, cópias preservadas em `evidencias-preservadas/01…08`), reverificável por `verificar-manifesto-bloco-i.sh` (só leitura).
- **Status documental em 15/10/2026:** resultado técnico **GREEN J2a (Fase 4B) APROVADO**; auditoria concluída; encerramento documental **PREPARADO e reconciliado**, aguardando (a) a revisão da V7 e (b) a decisão do responsável nas caixas do termo §10 (aceite; desvios procedurais dos auditores; tolerância `USAGE`/`SELECT`; ajustes). **A aprovação é restrita ao ambiente dedicado e NÃO é liberação para produção.** Não fazem parte do encerramento: Git, congelamento de baseline, Etapa I, Etapa J inteira e Etapa K. Divergência registrada: o manifesto (gerado em 14/10 às 22:48) pina `helpers/token-j.js` em `2131e49f…` (D-21), mas a correção da CI `18e7296` (15/10) alterou esse arquivo (`cbea6c81…`); os demais pinos conferidos (autoridade `184c8bcb…`, guarda D1, `exigir-instancia-dedicada.js`, teste novo `49d350b4…`) estão íntegros — regenerar o manifesto só com autorização. O termo registra um `git status --short` de leitura executado por engano em 14/10 às 21:40, já comunicado.
- **PR #57 e CI (15/10/2026):** a integração à `main` e a correção `18e7296` estão na nota de 15/10/2026 em "Entrega Git do Bloco 12": três suítes J2a exigiam o sentinela da guarda D1; a prova alternativa de instância efêmera do GitHub Actions (marcador por execução + nonce no comentário do banco, variáveis `PG*`/`DATABASE_URL`/`NODE_OPTIONS` proibidas, só runner `github-hosted`) vale só na CI; fora dela a guarda D1 continua obrigatória. **Testes aprovados ≠ implantação em produção:** o job não tem role real, agendador, valor de sonda nem rota montada (P-01 a P-04).

Etapa K — K1: diagnóstico de autoridade nas solicitações de EPI (15/10/2026; ciclo K1+K2; branch `feature/bloco12-etapa-k`; somente leitura, concluído, sem alteração de código, banco ou testes; sem arquivo próprio: consolidado na seção 1 do relatório `K2-01-RELATORIO-TECNICO.md`, em `Projetos Bloco/Bloco 12/Token-autoatendimento/K-IMPLEMENTACAO/`, que não se duplica aqui):

- **Matriz efetiva (estado de 15/10/2026 antes do K2; a rota e o avaliador genérico não mudaram; reconstruída em toda a cadeia: frontend, rota, middleware, controller, serviço, repositório e banco):** `APROVAR_SOLICITACAO`, `REPROVAR_SOLICITACAO` e `ENCERRAR_SOLICITACAO` exigem SST (`exige_sst = true`) e são OBRIGATORIA (migration 017 para aprovar e reprovar; 068 para encerrar). Para ADMINISTRADOR, SUPERVISOR e USUARIO a rota exigia vínculo SST (linha em `vinculo_sst`), concessão individual da ação (o grupo nunca é consultado nesse modo e não pode gravá-la) e nenhum bloqueio individual. O MASTER era decidido pela linha do perfil, ainda sujeito a bloqueio individual: o avaliador genérico dispensa dele o vínculo SST e a concessão individual (`exigeSst && !ehMaster`; o ramo do MASTER vem antes do modo OBRIGATORIA) e ignora o grupo. Ele não decidia apenas porque o provisionamento (`ESCOPO_PROVISIONAMENTO_MASTER`) não grava a linha das três ações.
- **Constatações:** não havia contorno: a decisão e o encerramento têm um único ponto de escrita, o serviço (`decidirSolicitacao` e `encerrarSolicitacao`), chamado só pelo controller, e o Token só cria pedidos `PENDENTE` de origem `AUTOATENDIMENTO`. Mas a autoridade vivia só na rota: o serviço não conhecia o perfil nem revalidava vínculo SST, concessão ou bloqueio (a RED do K2, com 27 de 33 falhas sem a proteção, corrobora). O banco confere a autodecisão (`chk_solicitacoes_epi_decisor_diferente_do_solicitante`, só para a origem `USUARIO_INTERNO`) e o isolamento por empresa (FK composta), mas não o perfil nem o vínculo SST.
- **Divergência:** a regra permanente de negócio (o MASTER nunca aprova, reprova nem encerra) estava protegida só pela ausência de dado no provisionamento, e não por regra no código: uma linha de perfil MASTER × ação o faria passar sem vínculo SST nem concessão (o teste existente `autorizacao-routes.integration.js` afirma esse contrato do avaliador genérico, que por isso não foi tocado). É a fragilidade latente que a Central (Etapa H) transferiu à K, com a regra do avaliador mantida (termo da H, 13/10/2026: avaliar na K, sem alterar a regra); por decisão do responsável de 15/10/2026 o K2 a trata no serviço, e o avaliador genérico permaneceu intacto. O K2 está pendente de validação com PostgreSQL e de homologação, e o item P-13 de "Pendências transversais remanescentes" continua registrado até lá.
- **Decisão aprovada pelo responsável (15/10/2026):** os cinco pontos estão nos bullets do K2 abaixo: (1) a regra permanente do MASTER e (2) a autoridade exigida de quem não é MASTER ("Regra permanente" e "Revalidação obrigatória"); (3) o que permanece, inclusive `AUTODECISAO_PROIBIDA`, e (4) o fluxo do Totem ("Preservado", e ainda: o trabalhador não cancela no Totem e a criação do pedido não muda); (5) o avaliador RBAC genérico não é alterado. Diretriz de arquitetura da V7, **Opção 2**: autorização obrigatória dentro do serviço, sem parâmetro opcional que permita omitir a proteção, reutilizando `avaliarPermissaoAcao` sobre o `client` da transação.

Etapa K — K2: autoridade obrigatória nas solicitações de EPI (15/10/2026; branch `feature/bloco12-etapa-k`; **sem migration** e **sem mudança de contrato HTTP**; relatório, adendo, checkpoint e evidências em `Projetos Bloco/Bloco 12/Token-autoatendimento/K-IMPLEMENTACAO/{K2-01-RELATORIO-TECNICO.md, K2-02-ADENDO-REVISAO-BASELINES-F-G.md, K2-03-CHECKPOINT.md, K2-evidencias/}`, que não se duplicam aqui):

- **Regra permanente (decisão do responsável, 15/10/2026):** o MASTER administra o sistema, os usuários e as permissões, mas **nunca aprova, reprova nem encerra** solicitações de EPI, mesmo que receba permissão indevida (linha de perfil, concessão individual e vínculo SST). A proibição está no código do serviço, e não só na ausência de concessão no provisionamento (o K1 constatou que antes era só proteção de dado: o avaliador genérico dispensa o vínculo SST do MASTER).
- **Revalidação obrigatória no serviço:** `decidirSolicitacao` e `encerrarSolicitacao` (`services/solicitacao-epi.service.js`) revalidam a autoridade dentro da transação, depois da trava da solicitação, pela política EFETIVA já existente (`avaliarPermissaoAcao` do middleware, sobre o `client` da transação). Quem não é MASTER precisa do vínculo SST ativo, da concessão efetiva de cada ação que o ato usa (aprovar = `APROVAR_SOLICITACAO`, reprovar = `REPROVAR_SOLICITACAO`, decisão mista = as duas, encerrar = `ENCERRAR_SOLICITACAO`) e de nenhum bloqueio individual. O perfil vem da linha do ator no banco, nunca de argumento, e não existe parâmetro que permita omitir a proteção. A recusa é o mesmo 403 `PERMISSAO_NEGADA`, sem gravar nada. O avaliador RBAC genérico, o controller, o provisionamento do MASTER, as rotas, o frontend e o Totem não mudaram.
- **Preservado:** `AUTODECISAO_PROIBIDA` é conferida ANTES da nova checagem e vale para todo perfil, MASTER inclusive; o autoencerramento continua permitido a quem tem a autoridade; isolamento por empresa, estados, auditoria e travas; a SST aprova e reprova normalmente os pedidos originados no Totem (origem `AUTOATENDIMENTO`, sem solicitante). O Totem não ganha autoridade e nenhum cancelamento novo foi criado.
- **Testes e fixtures:** teste unitário novo `test/services/solicitacao-epi-autoridade.service.test.js` (34 testes; a política real roda e só os dados dos repositórios são simulados): RED com 27 de 33 falhas sem a proteção, GREEN 34 de 34; o teste unitário existente do serviço foi ajustado (ator da SST simulado e etapa de autoridade na ordem do encerramento); unitários relacionados 119 de 119; suíte unitária completa com 3644 testes e 7 falhas, todas por arquivos duplicados com sufixo "2" do working tree local. A suíte de integração `test/integracao/solicitacao-epi-autoridade-k2.integration.js` (30 testes, pela rota e pelo serviço) foi escrita e **NÃO foi executada**. Fixtures: `montarMundoDoServico` passou a conceder o vínculo SST e as três ações a `sst1`, `sst2` e `sstB`; três suítes de vínculo e a de autorização do encerramento limpam essa autoridade quando testam o próprio vínculo; três suítes que encerravam como MASTER passaram a usar a SST. Quinze arquivos no total (um de produção); a conferência pré-Git de 15/10/2026 achou, por leitura, três cenários em `solicitacao-epi-decisao.integration.js` e `solicitacao-epi-encerramento.integration.js` que decidiam ou encerravam com ator sem autoridade, corrigidos com autorização da V7 para usar SST autorizada sem mudar a finalidade (K2-01, seção 9): **17 arquivos técnicos no total**, ainda sem execução em PostgreSQL.
- **Ressalvas das baselines F e G:** três fixtures do Token (`token-pedido.integration.js`, `token-solicitacoes.integration.js` e `helpers/token-solicitacoes.js`) tiveram, em revisão controlada, só o ator MASTER das chamadas de decisão e encerramento trocado por SST autorizado; nenhuma asserção mudou e os termos F e G ficam intactos (hashes anteriores e atuais no adendo K2-02). **Divergência preexistente:** o termo F registra `cff2ed90…` para `token-pedido.integration.js`, mas o arquivo já estava em `1d4c47a8…` antes do K2 (atual `ba6202cf…`), sem explicação nos registros; não bloqueia, isoladamente, a CI. As baselines F e G **não estão re-homologadas**.
- **Estado em 15/10/2026: IMPLEMENTADO — TESTES SEM BANCO APROVADOS — INTEGRAÇÃO POSTGRESQL PENDENTE — NÃO HOMOLOGADO.** Pendências: CI do GitHub (PostgreSQL 16 efêmero) ou execução autorizada no cluster dedicado para a suíte nova, as cerca de 25 suítes que decidem ou encerram pelo serviço e as baselines revistas; aprovação da V7; Git somente do responsável. Riscos residuais: a política não trava as linhas de vínculo e concessão (revogação confirmada depois da avaliação não é impedida); cerca de cinco consultas a mais por ato; possível ator esquecido nos fixtures. O K3 e os demais incrementos da Etapa K não foram iniciados.

Pendências transversais remanescentes (15/10/2026; registro, não autorização):

1. **Token e Bloco I:** P-01 montar a rota do heartbeat; P-02 role real do job e segredos; P-03 `TOKEN_SONDA_URL_PUBLICA`; P-04 agendador externo (cadência nominal 60 s, D25); P-05 alerta para saídas 2 e 3 repetidas; P-06 `TOKEN_JOB_DB_SCHEMA` no `.env.example`; P-07 aplicar `089` a bancos persistentes e decidir o destino da `088` (suspensa); P-08 regressão integrada completa B a H + J2a; P-09 dois TODO do RED; P-10 decisões do J pendentes (limiar e prazos da suspeita, supressão e consolidação, `TOKEN_GERENCIAR_ALERTAS` e `exige_sst`, tetos de destinatários, texto do e-mail, posição na Central, forma no Dashboard, numeração após a 088); P-11 J3a–J6 e J2b; P-12 Etapa I bloqueada e não congelada; P-13 ressalvas da H (`DEPENDENCIA_REABILITADA`, roteiros manuais, S1–S3, fragilidade MASTER × linha de perfil); P-14 Etapa K sem planejamento próprio; P-15 ordem J × K; P-20 decisão do responsável no termo do Bloco I; P-21 ensaio de 229 verificações da guarda g3 (opcional); P-22 resíduos de trabalho (sandboxes, scratchpad, `/tmp`); P-23 informativos; P-24 nome `…NAO-EXECUTAR.sh` do wrapper g3 (não editar); P-25/P-26 para uma futura geração de wrapper (caminhos do job nunca exercitados com a role mínima em PostgreSQL real); E15 imagens dos materiais; D-C9 SameSite; `TRUST_PROXY_HOPS` real; limitador distribuído; MDM/quiosque; TUNEL; simulação visual do tablet na Central (bloco próprio acima); `TOKEN_VISUALIZAR_MONITORAMENTO`/`TOKEN_VISUALIZAR_HISTORICO` sem enforcement; `self-service.html` segue protótipo; troca em massa do rótulo do menu.
2. **Documentais:** `README.md` (06/10/2026) com três contagens de migrations incompatíveis ("`000` a `071` / 72 entradas", "`000` a `074`", "até a `077`") e 12K/12L como "não iniciadas"; `AGENTS.md` (26/09/2026, não rastreado) é cópia anterior destas regras ("`000` a `016`"), lista a si mesmo em vez do `CLAUDE.md` e não tem as seções 63 e 64 — duas fontes de regras divergentes (decisão do responsável; não alterar sem autorização); homologação manual sem documento para `081`, `082`, 12K-C, 12K-D6, GHE e S1–S4; contradições V7 × documentos (12K-D5, 12K-D6, Correções do MASTER); manuais técnicos definitivos do Token e dos toggles só depois de I, J e K; **Prova de Autoria** obrigatória na fase final (manual técnico completo, dossiê de autoria por decisão, guia de estudo, simulação de banca com correção e repetição).
3. **Código e organização (nenhuma correção executada):** `funcionarios.html` e `gestao-funcionarios.js` fora da allowlist; os 428 arquivos não rastreados (`AGENTS.md` + 427 cópias com sufixo "2", entre elas os oito `… 2.js` protegidos e cópias em `frontend/totem/` e `frontend/test/`) são pendência de organização — não tocar e não incluir no Git; `proxy-addr` crítico (produção não apta); Desbloquear na Gestão de Usuários; cabeçalho "by SafeWork" clicável para o Dashboard; dados fictícios da homologação da H em `gestao_epi_validacao_ghe_20261009`; `gestao_epi_homolog_local` na `060`; `node-pg-migrate` sem uso localizado; matriz definitiva de toggles por perfil; estudo de toggles aguardando revisão.

---

# 64. Regra final

Não ampliar o escopo sem autorização.

Não executar ações Git de publicação sem autorização.

Não alterar histórico sem autorização.

Não incluir atribuição de IA.

Não comprometer segurança para simplificar implementação.

Quando houver dúvida arquitetural relevante, parar, explicar e pedir decisão antes de continuar.