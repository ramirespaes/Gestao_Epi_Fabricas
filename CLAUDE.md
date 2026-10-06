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

**BASELINE CONGELADA (validação manual final aprovada em 06/10/2026): Gestão de Usuários; não reabrir sem regressão real.** Gestão de Usuários — fechamento e aposentadoria das seis telas legadas (06/10/2026; sem migration): a Gestão de Usuários passou a cobrir também **Grupos** (botão "Grupos": lista de ativos e inativos, Editar nome/descrição por `PATCH /grupos-acesso/:id`, Inativar com confirmação e Reativar pelas rotas existentes, e **Permissões do grupo** como interruptores ON/OFF). As permissões do grupo usam `GET /grupos-acesso/:id/acessos` e `PUT /grupos-acesso/:id/acessos/:toggle` `{ ligado }` (`grupo-acessos.service.js`, uma visão binária sobre `grupo_permissoes_*` e o serviço de permissões de grupo existente: autoridade, trava, auditoria `GRUPO_PERMISSAO_*`, isolamento por empresa e a regra de não alterar o próprio grupo são os dele). ON = o grupo concede; OFF = retira a opinião (`null`, nunca `false`, que bloquearia o que o perfil permite); só os acessos de `toggles.js` que o grupo consegue conceder (ação em modo ALTERNATIVA; Gestão de Usuários, OBRIGATORIA, não entra); ligar também concede a leitura de que o acesso depende. Integrantes: vincular, trocar e desvincular continuam por Alterar usuário › Grupo. Autorizações individuais: Configurar permissões ON/OFF; a interface de delegação foi APOSENTADA (dados, histórico e backend de autorizações ficam). Convite de usuário interno: APOSENTADO na interface (o convite do primeiro MASTER é do Painel Privado e não foi tocado; o backend `/administracao/convites-usuario` e a página pública `portal/aceitar-convite.html` ficam para convites já enviados). Desbloquear (placeholder sem contrato) foi removido da tela e segue como pendência separada (cooldown automático, Reativar e Alterar senha existem). As seis páginas (`grupos-acesso`, `grupo-permissoes`, `grupo-usuarios`, `autorizacoes-individuais`, `new-user`, `user-admin`) viraram páginas de REDIRECIONAMENTO (só o tema, nenhum módulo, nenhuma API, nenhum controle; `meta refresh` + `location.replace` para `gestao-usuarios.html`, preservando a query); os módulos `js/grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js` e `usuarios.js` e seus testes ficam (reutilizados ou preservados). Compras / Entradas, Regras Função / Setor e Validade de Estoque seguem só adiados.

Liberação visual controlada (05/10/2026, TEMPORÁRIA; não é implementação funcional): o MASTER abre os seis protótipos ainda "Em integração" (`reports`, `delivered-items`, `self-service`, `support`, `emails-gestao`, `lgpd`; `config` saiu da lista em 05/10/2026 ao virar a tela integrada de Configurações; `purchases` e `eligibility-rules` saíram em 05/10/2026 como MÓDULOS TEMPORARIAMENTE DESATIVADOS / ADIADOS: fora de `INSPECAO_PROTOTIPOS` e de `PROTOTIPOS`, em `DESATIVADOS` de `js/inspecao-visual.js` — o link nunca recebe o marcador, dentro da inspeção fica `aria-disabled` e o clique só avisa, e a própria página recusa `?inspecao=1`; HTML, JS, testes e histórico preservados para retomada) só para inspeção. Regras: (1) `liberarInspecao` em `js/permissoes-efetivas.js` dá `href` com `?inspecao=1` aos `a.nav-pendente` pelo rótulo (`INSPECAO_PROTOTIPOS`) quando `permissoes.perfil === 'MASTER'` — a ÚNICA decisão do frontend pelo nome do perfil, explícita e provisória; não é autorização, não inferir permissões definitivas dela, e a matriz de ADMINISTRADOR, SUPERVISOR e USUÁRIO é da 12J; (2) o HTML das páginas integradas não mudou: `nav-pendente`, `aria-disabled` e a etiqueta "Em integração" continuam estáticos, e o link some para outro perfil, na revalidação e na falha da consulta; (3) `js/inspecao-visual.js` é carregado só pelos oito protótipos (seis em inspeção e os dois adiados, nos quais recusa ativar), está em `NUNCA_PUBLICAR` e fora da allowlist, age só com `?inspecao=1`, esconde a tela de login simulada, mostra a faixa fixa e recusa toda escrita na API simulada e todo submit — nunca liga protótipo a backend, nunca usa `db-api.js`, `main.js`, `localStorage` ou seed como fonte de verdade; (4) nada foi reorganizado, redesenhado ou corrigido nos protótipos; (5) quando uma dessas telas for integrada de verdade (12K em diante), ela deixa de ser `nav-pendente` e sai de `INSPECAO_PROTOTIPOS` (feito para `config` nas Configurações); (6) o marcador não pode se perder no segundo salto: dentro do protótipo aberto em inspeção, o `fileMap` inline da página e o `appendSessionToNavLinks` do `main.js` reescrevem a barra lateral para `reports.html`, `purchases.html` etc. sem o marcador (era assim que o login fictício com "Cobresul" aparecia no fluxo do MASTER), então `inspecao-visual.js` propaga `inspecao=1` aos links que levam a um dos oito protótipos, na carga e no clique em fase de captura, preservando `?_s=` e sem repetir o marcador, nunca a links de páginas integradas (Configurações inclusive), e esconde a tela de login simulada também por regra de estilo `!important`; o `href` do menu integrado é montado por `hrefDeInspecao` (uma vez só, parâmetros preservados); ao fim da revisão, remover a liberação é decisão do responsável.

Entrega Git do Bloco 12 (decisão de 04/10/2026): todo o restante do Bloco 12 — 12G-6 a 12G-9, 12H, 12I, 12J e as etapas seguintes — fica no mesmo working tree da branch `feature/bloco12-fechamento`, sem staging, commit, push, PR ou merge entre as subetapas. Cada subetapa é implementada, testada, validada tecnicamente, validada manualmente quando autorizado, documentada, e o trabalho continua no mesmo working tree. Só com todo o Bloco 12 concluído, auditado e aprovado é preparada uma entrega Git consolidada, feita pelo usuário; Claude não executa nenhum comando Git, nem de leitura.

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

---

# 64. Regra final

Não ampliar o escopo sem autorização.

Não executar ações Git de publicação sem autorização.

Não alterar histórico sem autorização.

Não incluir atribuição de IA.

Não comprometer segurança para simplificar implementação.

Quando houver dúvida arquitetural relevante, parar, explicar e pedir decisão antes de continuar.