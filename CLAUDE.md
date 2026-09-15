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

Testes de migration podem ser realizados em instância PostgreSQL descartável claramente isolada do banco do projeto.

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

A versão mínima proposta para discussão é:

```json
{
  "engines": {
    "node": ">=20"
  }
}
```

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
- limites de payload.

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

# 63. Regra final

Não ampliar o escopo sem autorização.

Não executar ações Git de publicação sem autorização.

Não alterar histórico sem autorização.

Não incluir atribuição de IA.

Não comprometer segurança para simplificar implementação.

Quando houver dúvida arquitetural relevante, parar, explicar e pedir decisão antes de continuar.