# Gestão de EPIs

Sistema para gestão de Equipamentos de Proteção Individual (EPIs), com frontend web e backend separados por responsabilidade.

## Estado do projeto

O desenvolvimento é organizado em blocos. Situação em 03/10/2026:

| Bloco | Situação |
|---|---|
| 1 a 7 — migrations de sessões, auditoria e tentativas de login (`013` a `015`), dependências, fundação da autenticação, validação de entrada e segurança HTTP | Concluídos e incorporados à `main` |
| 8 — Autenticação real e RBAC | **Concluído** e incorporado à `main` (PRs #13 a #18). Encerramento formal na seção seguinte |
| Autenticação global, Painel Privado, Portal do Cliente e página institucional (planejamento próprio) | Concluídos e incorporados à `main` (PRs #20 a #23 e #26) |
| 9 — Integração das páginas ao backend real | Etapas A a F incorporadas à `main`: Etapas A e B (backend de materiais, estoque, funcionários e GHE, PR #19), Etapa C, partes C0 a C7 (PRs #24, #25, #27 e #28; as partes C4 e C5 executaram a Etapa D), rodada de segurança S1/S2/S3 (PR #29) e Etapas E e F (estoque por lote, permissões próprias das áreas de estoque e gestão de usuários, PR #32). Ver "Bloco 9, Etapas E e F" |
| Correções de segurança pós-auditoria e Cloudflare Turnstile no login do Portal do Cliente | Incorporados à `main` (PR #33) |
| MFA TOTP do Painel Privado (MFA-1 a MFA-10) | Incorporado à `main` (PRs #34, #35 e #36; merge `427102a`). Ver "Painel Privado e MFA TOTP" |
| Gate de segurança pré-Bloco 10 — CI no GitHub Actions, portabilidade dos testes de migration, logout seguro do Portal e atualização documental | Implementado no PR #37 |
| 10 — Entrega real de EPI, ficha, confirmação e baixa de estoque por lote | **Concluído** nas subetapas 10A a 10J, todas incorporadas à `main` (PRs #38, #39, #40, #41 e #42). Ver "Bloco 10" |
| 11 — Ciclo de vida da senha | **Concluído no código.** Subetapas 11A + 11B (PR #44), 11C + 11D (PR #45) e 11E + 11F (PR #46) incorporadas à `main`. Subetapas 11H (e-mail transacional real), 11I (hardening e auditoria) e 11J (documentação, regressão e fechamento) incorporadas à `main` pelo PR #47 (MERGED; commit da entrega `8e213ada90ec6390039e4a5ac2f5c1e32c6b97a0`, merge commit `1a474540290e2c80a1b4539cdf24dce491010f40`). A **configuração de produção continua pendente** (credenciais SMTP, SPF, DKIM, DMARC, URLs públicas e demais itens de deploy): ela bloqueia a produção, mas não o encerramento do código. Ver "Bloco 11" |
| 12 — Operação completa de EPI (solicitação, aprovação pela Segurança do Trabalho e entrega) | **Em andamento.** Subetapas 12A (migration `065`, repositories e trava por par de estoque) e 12B (serviços de solicitação e de vínculo SST, sem HTTP) incorporadas à `main` pela PR #49 (merge commit `0ccf59d47527b58fd656a265a74fd763109fbd45`). As subetapas 12C (migration `066`, entrega por solicitação, entrega direta e baixa pelo saldo livre, auditoria da recusa) e 12D (12D-1: migration `067`, estoque mínimo por tamanho e posição de todos os pares; 12D-2: os contratos HTTP de Itens Disponíveis, Dashboard, mínimos, histórico com `ENTREGA` e contexto da entrega direta; 12D-3: as telas existentes integradas a esses contratos) estão **concluídas no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7`** (`feat(bloco12): concluir entrega por solicitacao e posicao de estoque`). A solicitação, a aprovação e a entrega por solicitação ainda não têm frontend final. A 12E, que traz a pendência D6 (obrigatória), a 12F e a 12G **não foram iniciadas**. A migration `067` não foi aplicada a nenhum banco persistente. Ver "Bloco 12" |

### Bloco 10 — Entrega real de EPI, ficha, confirmação e baixa de estoque por lote

Fluxo **direto** de entrega: quem tem a ação `REALIZAR_ENTREGA` localiza o trabalhador, escolhe materiais e lotes, registra a confirmação de recebimento e o estoque baixa por lote na mesma transação. A ficha de EPI é o registro cumulativo do trabalhador, uma por funcionário na empresa, numerada em sequência por empresa; cada entrega guarda cópias dos dados da época (empresa, trabalhador, GHE, responsável e material), e o CPF nunca é copiado — sai mascarado das consultas.

| Subetapa | Conteúdo | Situação |
|---|---|---|
| 10A + 10B | Estrutura persistente: migrations `057` a `060` (fichas, entregas, itens, confirmação e vínculo com o estoque por lote) | `main`, PR #38 |
| 10C + 10D | Serviço transacional de entrega: concorrência e locks, idempotência por chave, baixa de estoque por lote, auditoria e confirmação com hash | `main`, PR #39 |
| 10E + 10F | APIs de entrega e ficha: contexto da entrega (trabalhador, materiais e lotes), consultas, histórico com cópias da época, proteção de dados (CPF só no corpo, nunca na URL) e permissões separadas para consultar e entregar | `main`, PR #40 |
| 10G + 10H | Frontend real da Ficha de EPI (`pages/epi-ficha.html` + `js/epi-ficha.js`): entrega operacional, assinatura desenhada e aceite presencial, retry idempotente, proteção contra confirmação obsoleta e contra resposta assíncrona antiga | `main`, PR #41 |
| 10I + 10J | Integração oficial: página `epiFicha` em `PAGINAS` e `prepararPagina`, menus, Portal, grupos de permissões, provisionamento do MASTER, allowlist e pacote publicado | `main`, PR #42 |

**Permissões da Ficha de EPI.** Duas autoridades independentes: consultar fichas e histórico é o recurso `epiFicha` (operação visualizar); realizar entrega é a ação `REALIZAR_ENTREGA` (modo `ALTERNATIVA`: grupo ou autorização individual). A página abre com qualquer uma das duas e mostra só o que cada uma dá. Desde a 10I, o escopo de provisionamento do MASTER (`backend/src/rbac/recursos.js`) inclui `epiFicha` (visualizar) e as ações `MOVIMENTAR_ESTOQUE` e `REALIZAR_ENTREGA`.

**Provisionamento do MASTER em bancos existentes (observação operacional).** Empresas novas provisionadas depois da 10I recebem o escopo novo automaticamente. Bancos e empresas já existentes só recebem `epiFicha.visualizar` e `REALIZAR_ENTREGA` para o MASTER quando o comando oficial `npm run db:provisionar:master` for executado com autorização específica para cada banco. Esse provisionamento não foi executado em nenhum banco persistente (`gestao_epi_demo`, `gestao_epi_dev`, `gestao_epi_migrado` ou `gestao_epi_revisao_e6_20260927`).

**Limites do Bloco 10 — funcionalidades futuras, não pendências do encerramento:**

- **Solicitação de EPI pelo trabalhador.** Fluxo futuro: o trabalhador solicita o EPI, a **Segurança do Trabalho** aprova (não o supervisor) e só então acontece a entrega. A entrega originada desse fluxo usará `origem = SOLICITACAO`; o Bloco 10 entrega o fluxo direto (`origem = DIRETA`). A solicitação e a aprovação passaram a existir na camada de serviço na 12A + 12B, e a entrega originada da solicitação na 12C, também só na camada de serviço (ver "Bloco 12"); nenhuma rota nem tela as expõe ainda.
- **Impressão e PDF da ficha.** A impressão oficial em duas vias continua futura; o botão "Imprimir" da página permanece desabilitado até lá.

### Bloco 11 — Ciclo de vida da senha e e-mail transacional (concluído no código)

Recuperação de senha por link enviado ao e-mail da conta, no Portal do Cliente e no Painel Privado, troca de senha autenticada e entrega real de e-mail (recuperação, aviso de senha alterada e convites). O link é de **uso único**, com validade padrão de 60 minutos e **máxima de 4 horas**; depois de usado ou expirado, é necessário solicitar outro; quem não solicitou a redefinição pode ignorar o e-mail. Suporte humano: `suporte@safeworkengenharia.com.br`.

| Subetapa | Conteúdo | Situação |
|---|---|---|
| 11A + 11B | Persistência: migrations `061` a `064` (pedidos de redefinição do Portal e do Painel Privado, contador de solicitações e auditoria da identidade global) e repositories | Concluídas, `main`, PR #44 |
| 11C + 11D | Serviços de recuperação (resposta única para qualquer desfecho, limite de 3 solicitações por hora por e-mail, redefinição com link de uso único, revogação das sessões da conta e auditoria) e integração HTTP (rotas públicas nos dois portais, Turnstile com action própria na solicitação do Portal e limite de requisições por IP separado por operação) | Concluídas, `main`, PR #45 |
| 11E + 11F | Troca de senha autenticada nos dois portais (`POST /api/auth/global/senha` e `POST /api/plataforma/auth/senha`) e frontend do ciclo de senha: "Esqueci minha senha" nos dois logins, páginas de pedido do link e de redefinição, troca de senha no Portal (`portal/trocar-senha.html`) e no Painel Privado (em "Segurança da conta") | Concluídas, `main`, PR #46 |
| 11G | Conteúdo absorvido pela 11E + 11F | Sem entrega independente |
| 11H | E-mail transacional real: infraestrutura única de envio (`backend/src/email/`), provedor SMTP configurável, remetente `no-reply@safeworkengenharia.com.br` ("SafeWork Engenharia"), templates oficiais, URLs públicas independentes do CORS, convites sem link na resposta em produção, reenvio de convite, teto de envios e encerramento ordenado do servidor | Concluída, `main`, PR #47 |
| 11I | Hardening e auditoria final do Bloco 11 (30 itens, ver "Auditoria final de segurança do Bloco 11") | Concluída, `main`, PR #47 |
| 11J | Documentação, regressão completa e fechamento | Concluída, `main`, PR #47 |

Nenhuma migration nova foi criada pela 11H, 11I e 11J: o conjunto, naquele momento, era `000` a `064` (a `065` pertence ao Bloco 12).

**O que a 11E + 11F entregam** (na `main` desde o PR #46):

- **Portal do Cliente:** "Esqueci minha senha" no login (sem alterar o login nem o Turnstile dele); solicitação pública de recuperação, com a mesma confirmação para qualquer e-mail; redefinição por link, com o token só no fragmento `#token=`; troca autenticada da senha, com a senha atual, em `portal/trocar-senha.html`. Na troca, só a sessão global atual e a sessão empresarial válida ligada a ela continuam; todos os demais acessos da identidade são revogados, em todas as empresas.
- **Painel Privado:** "Esqueci minha senha" no login; recuperação e redefinição públicas, sem Turnstile; troca autenticada com senha atual e TOTP, em "Segurança da conta" (recovery code não substitui o TOTP). Na troca, só a sessão administrativa atual continua e as demais são revogadas; o fator TOTP, o secret e os recovery codes são preservados.

#### E-mail transacional (11H)

Toda mensagem do sistema passa por **uma única infraestrutura** (`backend/src/email/`), em camadas: `servico-email.js` (entrada única) → `transporte/` (`desativado`, `arquivo` ou `smtp`) → `templates/`. Não há acoplamento a um provedor: o SMTP é configurado por variáveis de ambiente, e o transporte é o nodemailer, fixado exatamente em `10.0.13` (sem `^` nem `~`, sem scripts de instalação e sem dependências).

| Mensagem | Quando sai | Como sai |
|---|---|---|
| Recuperação de senha (Portal e Painel Privado) | depois do COMMIT da solicitação | fila em memória, em segundo plano |
| Aviso de senha alterada (redefinição e troca) | depois do COMMIT | fila em memória, em segundo plano |
| Convite de usuário, convite do primeiro MASTER e reenvio de ambos | depois de gravar o convite | enviado de forma aguardada, para a resposta informar o estado do envio |

- **Identidade:** nome "SafeWork Engenharia", remetente `no-reply@safeworkengenharia.com.br` e suporte `suporte@safeworkengenharia.com.br`. São endereços distintos: o suporte aparece só no corpo, nunca como remetente nem como Reply-To, e as mensagens não levam Reply-To, cc, bcc nem cabeçalhos extras.
- **Modos (`EMAIL_MODO`):** `desativado` (padrão fora de produção; a mensagem é descartada), `arquivo` (grava um par TXT e HTML num diretório fora do repositório; só desenvolvimento e teste) e `smtp`. **Em `production` só `smtp` é aceito**, com STARTTLS ou TLS e usuário e senha: com outro modo, SMTP incompleto ou sem TLS, o backend não sobe. Não existe variável que afrouxe a validação do certificado.
- **URLs públicas dos links:** `PORTAL_URL_PUBLICA` e `PAINEL_URL_PUBLICA`, que não dependem mais da ordem de `CORS_ORIGIN`. Em `production` são obrigatórias, `https`, e precisam ser uma das origens da allowlist do respectivo namespace. Fora de `production`, sem elas, valem a primeira origem de `CORS_ORIGIN` (Portal) e a primeira de `PLATAFORMA_CORS_ORIGIN` (Painel).
- **Links:** o token vai só no fragmento (`#token=`), nunca em query. As páginas de aceite e redefinição o retiram da barra de endereço antes de qualquer requisição e usam `referrer: no-referrer`.
- **Templates:** HTML com tabelas e CSS inline (compatível com clientes de e-mail), sem JavaScript, com variante escura, botão principal, link alternativo em texto e logo inline por CID. O texto vindo de pessoas (nome, empresa) é escapado. Validade formatada em horário de Brasília.
- **Hardening do SMTP:** STARTTLS exige TLS de verdade, sem rebaixamento; o certificado é sempre validado; o nodemailer não lê arquivo nem busca URL; logger e debug desligados; destinatário normalizado e validado antes do transporte, com envelope explícito; assunto constante, definido pelo sistema. O erro do provedor nunca sai: o registro técnico leva só evento, tipo, escopo e um código de uma lista conhecida, com amostragem para que ninguém encha o log. Nenhum e-mail, token, link ou texto do provedor vai ao log.
- **Fila em memória** (recuperação e aviso): no máximo 100 mensagens aceitas e ainda não terminadas, 2 envios simultâneos e limite de 15 segundos por envio. O excedente é descartado e contado, sem alterar a resposta pública (a mesma para qualquer desfecho, o que preserva a proteção contra enumeração). Ao receber SIGTERM ou SIGINT, o servidor para de aceitar conexões e mensagens novas, espera as já aceitas (até 10 segundos), fecha o transporte e sai. Se algo ficou para trás, sai com código 1 e registra só a quantidade.
- **Sem fila durável:** se o processo cair depois do COMMIT e antes do envio, a mensagem se perde e a pessoa precisa solicitar de novo (risco aceito, R2).

**Convites.** O token do convite só existe em claro no instante da criação (no banco fica só o SHA-256), então "reenviar" não reenvia o convite antigo: o **reenvio** cancela o convite anterior (pendente ou expirado) e cria outro, com o mesmo e-mail, nome e perfil, token novo e validade nova, **na mesma transação**; o link antigo deixa de valer. A resposta é `201` com `conviteAnteriorId` e o estado do envio, mesmo se o envio falhar (`FALHA`): o convite novo já está gravado, fica pendente e pode ser reenviado de novo. **Em produção, ou com SMTP real, a resposta nunca traz o link nem o token**; só nos modos `desativado` e `arquivo`, fora de produção, ela traz `linkAceite`, o mecanismo manual de desenvolvimento.

- **Teto de envios por (empresa, e-mail):** no mínimo 60 segundos entre dois envios e no máximo 5 convites em 24 horas, contando criações e reenvios (`429`, com `Retry-After`). Vale também na criação, para que cancelar e criar de novo não contorne o teto. É calculado nas linhas dos próprios convites, sem migration nova.
- **Limite por IP:** criar e reenviar compartilham um contador por portal, antes da sessão.
- **Concorrência:** criar, reenviar, aceitar e cancelar são serializados por trava consultiva do par (empresa, e-mail) e por `FOR UPDATE` da linha; nunca há dois convites em aberto para o mesmo par, e um link cancelado nunca é aceito.
- **Quem pode:** no Portal, MASTER, ou ADMINISTRADOR com `GERENCIAR_USUARIOS` (só SUPERVISOR e USUARIO). No Painel Privado, o administrador da plataforma. O reenvio é auditado como `USUARIO_CONVITE_REENVIADO` (trilha da empresa) ou `CONVITE_MASTER_REENVIADO` (trilha da plataforma), apontando para o convite novo e o anterior, sem e-mail, nome, token nem hash.

**Registros de DNS (SPF, DKIM e DMARC): somente documentação.** O código não os configura nem finge que estão configurados. Antes de enviar e-mail real em produção, o domínio `safeworkengenharia.com.br` precisa de SPF autorizando o provedor escolhido, DKIM com a chave do provedor e DMARC (começando em `p=none`, com endereço de relatório, e endurecendo depois de observar os relatórios). Os valores dependem do provedor e do DNS, e esta entrega não alterou DNS algum.

#### Auditoria final de segurança do Bloco 11 (11I)

Auditoria dos 30 itens do bloco, feita sobre o código, com testes unitários e de integração (PostgreSQL real, só em `gestao_epi_teste_local`) e provas por mutação. Classes: **OK**; **CORRIGIDO NESTA ENTREGA**; **RISCO ACEITO**; **BACKLOG**; **BLOQUEIA PRODUÇÃO**. Nenhum item ficou como defeito aberto do código do Bloco 11.

| # | Item | Classe |
|---:|---|---|
| 1 | Anti-enumeração (solicitação, login, convites) | OK |
| 2 | Limite de requisições HTTP | OK |
| 3 | Limite persistente (3/h por e-mail, cooldown, teto de convites) | CORRIGIDO NESTA ENTREGA |
| 4 | Concorrência (travas, ordem, ausência de deadlock) | OK |
| 5 | Replay (link, TOTP, convite) | OK |
| 6 | Redefinição de uso único | OK |
| 7 | Sessões e revogação | OK |
| 8 | Preservação da sessão atual na troca | OK |
| 9 | MFA | OK |
| 10 | Anti-replay do TOTP | OK |
| 11 | Recovery codes | OK |
| 12 | Desafios pré-MFA | OK |
| 13 | Auditoria | OK |
| 14 | IP e User-Agent | OK |
| 15 | Logs técnicos | CORRIGIDO NESTA ENTREGA |
| 16 | Tokens | OK |
| 17 | Cookies | OK |
| 18 | CORS e verificação de origem | OK |
| 19 | Turnstile | OK (Painel sem Turnstile: R5) |
| 20 | Convites | CORRIGIDO NESTA ENTREGA |
| 21 | E-mail transacional | CORRIGIDO NESTA ENTREGA (infraestrutura de produção: R8) |
| 22 | URLs públicas | CORRIGIDO NESTA ENTREGA |
| 23 | Fail-closed em produção | OK |
| 24 | Isolamento Portal × Plataforma | OK |
| 25 | Respostas sem vazamento | OK |
| 26 | Erros genéricos | OK |
| 27 | Concorrência de envio e reenvio | CORRIGIDO NESTA ENTREGA |
| 28 | Dados sensíveis (varredura de segredos) | OK |
| 29 | Dependências introduzidas | OK (achados antigos do `npm audit`: R9) |
| 30 | Frontend (token no fragmento, escape, publicação) | OK |

Resíduos registrados (nenhum é defeito de código do Bloco 11):

| Id | Resíduo | Classe |
|---|---|---|
| R1 | Diferença estatística de tempo da solicitação (conta existente × inexistente) não medida; o envio assíncrono e o limite por e-mail a reduzem | RISCO ACEITO |
| R2 | Ausência de outbox: perda entre o COMMIT e o envio | RISCO ACEITO |
| R3 | Fila de e-mail e `MemoryStore` do rate limit por instância; adequados a instância única | RISCO ACEITO |
| R4 | Teto global por empresa/administrador para abuso de convites (hoje há 20 requisições por minuto por IP e 5 convites em 24 horas por e-mail, mas não há teto por empresa) | BACKLOG DE SEGURANÇA PRÉ-PRODUÇÃO / PRÉ-LIBERAÇÃO COMERCIAL |
| R5 | Painel Privado sem Turnstile na solicitação de recuperação (decisão da 11D) | RISCO ACEITO |
| R6 | Terceiro pode consumir as 3 solicitações por hora de um e-mail | RISCO ACEITO |
| R7 | Cliente de e-mail pode transformar em link uma URL digitada no nome ou na empresa, no texto simples | RISCO ACEITO |
| R8 | Configuração de produção (ver abaixo) | **BLOQUEIA PRODUÇÃO** (não o encerramento do código): IMPLEMENTAÇÃO DO BLOCO 11 CONCLUÍDA / CONFIGURAÇÃO DE PRODUÇÃO PENDENTE |
| R9 | Dois achados antigos do `npm audit` (ver "Backlog técnico de dependências") | BACKLOG |
| R10 | Inexistência de gate de cobertura do frontend (ver "Requisito de cobertura") | BACKLOG (decisão futura, fora do PR #47) |

**Pendências de deploy (R8).** O código do Bloco 11 está completo, mas a produção depende de configuração que não é código e **bloqueia a produção**, não o encerramento do bloco: credenciais SMTP reais (`SMTP_HOST`, `SMTP_USUARIO`, `SMTP_SENHA`); SPF, DKIM e DMARC do domínio; `PORTAL_URL_PUBLICA` e `PAINEL_URL_PUBLICA` reais; `TRUST_PROXY_HOPS` conforme a topologia real (sem ele, o limite por IP e o IP gravado na auditoria ficam errados); chaves reais do Turnstile; segredos em um serviço de secrets; HTTPS; e a proteção de origem, a CSP e o hardening de publicação, que seguem com o Bloco 14.

**Backlog técnico de dependências (R9), fora do PR #47.** Não foi executado `npm audit fix` e nenhum destes pacotes foi atualizado. Os dois achados já existiam antes da 11H e não vêm do nodemailer. Recomendação: corrigir em alteração separada, só no `backend/package-lock.json` (as faixas dos pacotes que os exigem já admitem as versões corrigidas, então não há mudança de `package.json` nem de versão maior).

| Pacote | Gravidade | Instalada | Corrigida | Cadeia | Aplicabilidade observada |
|---|---|---|---|---|---|
| `brace-expansion` | alta (3 avisos de negação de serviço) | 5.0.9 | 5.0.12 | `node-pg-migrate@9.0.0` → `glob@13.0.6` → `minimatch@10.2.6` → `brace-expansion`; e `nodemon@3.1.14` → `minimatch@10.2.6` → `brace-expansion` (todas dev) | Nenhuma em runtime: `src` e `scripts` não o usam; o runner de migrations só lista o diretório de migrations do repositório (`dir`), sem padrão vindo de entrada externa |
| `ip-address` | moderada (2 avisos) | 10.7.0 | 10.7.1 (a última publicada é 10.7.3) | `express-rate-limit@8.7.0` → `ip-address` (produção) | Baixa: o `express-rate-limit` só chama `Address6` depois de `net.isIPv6` e `isInSubnet` entre objetos do mesmo tipo; o código do projeto não usa essas funções |

**Backlog de segurança pré-liberação comercial (R4).** Teto global por empresa e por administrador para o envio de convites, a decidir antes da liberação comercial. Não faz parte do Bloco 11.

**Histórico de TDD da 11H a 11J.** Houve ciclo RED→GREEN válido (falha pela ausência do comportamento esperado, e não por erro de sintaxe, importação ou ambiente) nas camadas em que o teste veio antes do código: configuração, núcleo de e-mail, transportes, serviço de e-mail, limite de envio, repositórios, serviços e controllers de reenvio, rotas, limitadores, encerramento e frontend. Alguns testes foram escritos depois da implementação e passaram na primeira execução (as integrações do reenvio e do isolamento, a bateria de falha de entrega da recuperação, os testes de convite e links e o de `.env.example`). Não são apresentados como RED: são **testes de verificação e regressão**, validados também por provas de mutação feitas em cópia fora do repositório (a integração com PostgreSQL foi provada com 11 mutações, todas detectadas). Não houve RED retroativo inventado.

#### Restante do ciclo de vida da senha

Não existem histórico de senhas, expiração periódica, senha temporária nem troca obrigatória no primeiro acesso. São funcionalidades futuras, não pendências do Bloco 11.

### Bloco 12 — Operação completa de EPI (em andamento: 12A + 12B na `main`; 12C + 12D concluídas no commit `997b7bc`; 12E, 12F e 12G não iniciadas)

Fluxo de destino: o trabalhador (ou um usuário interno) **solicita** o EPI, a **Segurança do Trabalho** aprova (nunca o supervisor) e só então acontece a entrega. A entrega direta do Bloco 10 (`origem = DIRETA`) continua funcionando, agora limitada ao saldo livre. A 12A e a 12B estão na `main` (PR #49); a 12C e a 12D estão concluídas no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7` (`feat(bloco12): concluir entrega por solicitacao e posicao de estoque`), e a 12E, a 12F e a 12G não foram iniciadas. A solicitação, a aprovação e a entrega por solicitação continuam sem rota, controller e tela finais: estão só na camada de serviço e seguem para a 12E, a 12F e a 12G, conforme o planejamento. A 12D, porém, já integrou às telas existentes o saldo livre e o comprometido na entrega direta (com a recusa `SALDO_LIVRE_INSUFICIENTE` e a releitura da posição), a mensagem correspondente na baixa, Itens Disponíveis, o Dashboard, os mínimos por tamanho e o histórico de entregas com a origem.

| Subetapa | Conteúdo | Situação |
|---|---|---|
| 12A | Migration `065` (solicitações, itens e numeração por empresa), repositories e trava por par de estoque | Incorporada à `main` (PR #49) |
| 12B | Serviços de solicitação (criar, decidir, cancelar, consultar) e de vínculo SST, com auditoria, sem HTTP | Incorporada à `main` (PR #49) |
| 12C | Entrega originada da solicitação, ligação entre o item da entrega e o item da solicitação, proteção da entrega direta pelo saldo livre, classificação da baixa e auditoria da recusa (migration `066`) | **Concluída** no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7`: 12C-1 (migration `066`, vínculo, entregue derivado, cobertura FIFO), 12C-2 (serviço da entrega por solicitação) e 12C-3 (entrega direta e baixa pelo saldo livre, auditoria da recusa) |
| 12D | Posição de estoque (físico utilizável, comprometido, livre, demanda sem cobertura, mínimo e déficit), painel pelo saldo livre, filtro de entregas no histórico e ajustes de telas | **12D-1, 12D-2 e 12D-3 concluídas** no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7`: migration `067`, repository de mínimos, definição única de "utilizável", consulta de todos os pares, os contratos HTTP (12D-2) e as telas existentes integradas a eles (12D-3) |

**Reserva lógica de estoque (modelo A).** Não existe reserva gravada, contador nem tabela de alocação. Por par (empresa, material, tamanho) o sistema deriva: **U**, o físico utilizável (lotes de material ativo, sem os de CA ausente ou vencido na data operacional); **D**, a demanda aprovada pendente (itens aprovados de solicitações aprovadas, de trabalhador e material ativos); **C = min(U, D)**, a parte coberta, atribuída por ordem de fila (`decidida_em`, solicitação, item); **L = max(0, U − D)**, o saldo livre; e **G = max(0, D − U)**, a demanda sem cobertura. A aprovação sem estoque é permitida: o item fica aguardando. A situação exibida (`AGUARDANDO_ESTOQUE`, `PARCIALMENTE_COBERTA`, `PRONTA_PARA_ENTREGA`, `PARCIALMENTE_ENTREGUE`, `ENTREGUE` ou `SUSPENSA`) é derivada na consulta; o status gravado não muda. `SUSPENSA` vale quando o trabalhador ou o material de um item está inativo, e a solicitação volta à fila quando ficam ativos.

**Migration `065`.** Cria `solicitacoes_epi_numeracao`, `solicitacoes_epi` e `solicitacoes_epi_itens`, com chaves compostas por empresa, status `PENDENTE`, `APROVADA`, `APROVADA_PARCIAL`, `REPROVADA`, `CANCELADA` e `ENTREGUE`, origem `USUARIO_INTERNO` ou `AUTOATENDIMENTO`, e a regra de que quem decide não é quem solicitou. A decisão é gravada uma vez, a quantidade de itens é selada e gatilhos adiados conferem no COMMIT que toda solicitação tem itens e que a decisão é coerente. Os índices atendem a fila de pendentes, a fila de aprovadas e a demanda por par. Está versionada, no manifesto de checksums e validada em schema temporário; **não foi aplicada a nenhum banco persistente**, e aplicá-la exige autorização separada.

**Trava por par de estoque.** Operações que decidem sobre o saldo de um par tomam um `pg_advisory_xact_lock` de 64 bits derivado de empresa, material e tamanho, um par por vez, em ordem canônica. A ordem global de travas é: idempotência, solicitação, trabalhador, materiais, pares, lotes e numeração. A decisão de aprovação, a entrega por solicitação, a entrega direta e a baixa usam a trava; a entrada de estoque (que só aumenta o físico) e o cancelamento não precisam dela. Nas travas de baixa e de entrega direta o par é achado por leitura sem trava do lote, porque material e tamanho do lote nunca mudam (042), e a posição do par é lida **depois** da trava.

**Serviços (sem rota).** `solicitacao-epi.service.js` cria a solicitação de forma idempotente (1 a 20 itens, tamanho conforme a classificação do material, marcação de item previsto ou não no GHE do trabalhador), decide todos os itens em um único ato (aprova, aprova parcialmente ou reprova, com justificativa quando reprova, reduz a quantidade ou aprova item fora do GHE), cancela (só pendente e só pelo criador) e consulta em transação somente leitura. A decisão pelo próprio solicitante é recusada. `vinculo-sst.service.js` concede e remove o vínculo com a Segurança do Trabalho, só pelo MASTER ativo da empresa. O MASTER pode administrar vínculos, mas não recebe um: a tentativa é recusada com 409 `VINCULO_SST_NAO_SE_APLICA_AO_MASTER`, e vínculo legado de MASTER não é removido automaticamente. Usuário inativo não recebe vínculo novo; o vínculo de um inativo pode ser removido. A auditoria (`SOLICITACAO_EPI_CRIADA`, `SOLICITACAO_EPI_DECIDIDA`, `SOLICITACAO_EPI_CANCELADA`, `VINCULO_SST_ADICIONADO`, `VINCULO_SST_REMOVIDO`) entra na mesma transação e guarda só identificadores e indicadores, sem texto livre. Quem cancela sem ser o criador, ou com ator inexistente, recebe o mesmo 403 `CANCELAMENTO_NAO_PERMITIDO`, sem revelar a existência da solicitação.

**Correção associada.** `exigirDataOperacional` lançava `RangeError` para mês ou dia impossível (por exemplo `2026-13-01`); passou a lançar sempre `TypeError('data operacional inválida')`.

**12C-1 (commit `997b7bc`):** migration `066`, vínculo entre o item da entrega e o item da solicitação, `origem = SOLICITACAO` aceita pelo banco, quantidade entregue derivada das entregas ligadas ao item e posição e cobertura FIFO descontando o que já foi entregue (pendente = aprovada − entregue).

**12C-2 (mesmo commit):** `backend/src/services/entrega-solicitacao.service.js` registra a entrega de itens de **uma** solicitação aprovada, sem HTTP. O chamador informa só a solicitação, a chave de idempotência, os itens (item da solicitação, lote e quantidade) e a confirmação; trabalhador, material, tamanho, motivo, justificativas, previsão no GHE e GHE vêm da solicitação e do cadastro, e a justificativa técnica da SST fora do GHE é reutilizada. A quantidade do ato, somada por item (dividir entre lotes não contorna), tem de caber no pendente e na cobertura FIFO, que é recalculada **depois** das travas (idempotência, solicitação, trabalhador, materiais, pares, lotes, ficha). A entrega é parcial por desenho: cada ato é uma entrega com chave, ficha, operação de estoque e confirmação próprias, e a solicitação só passa a `ENTREGUE`, na mesma transação, quando toda a quantidade aprovada foi entregue. Erros de domínio: `SOLICITACAO_NAO_ENTREGAVEL` (inclui trabalhador ou material inativo), `ITEM_SOLICITACAO_NAO_ENCONTRADO`, `ITEM_NAO_APROVADO`, `LOTE_DIVERGENTE_DO_ITEM`, `QUANTIDADE_ACIMA_DO_PENDENTE` e `QUANTIDADE_ACIMA_DA_COBERTURA`. A auditoria é `ENTREGA_REGISTRADA` (com origem, solicitação, pendente e cobertura antes e depois e `entregaParcial`) e `SOLICITACAO_EPI_ENTREGUE` na transição real. Os helpers comuns à entrega direta estão em `entrega-epi-comum.js`, e o hash de conteúdo da entrega `DIRETA` continua byte a byte o de antes. Na situação derivada, `SUSPENSA` prevalece sobre `PARCIALMENTE_ENTREGUE` quando tudo o que falta entregar está suspenso, e as quantidades entregues continuam visíveis.

**12C-3 (mesmo commit):** a entrega direta e a baixa passaram a respeitar o saldo livre, e a recusa é auditada. Regras (em `backend/src/services/saldo-livre.js`, `entrega-epi.service.js`, `estoque.service.js` e `auditoria-recusa-saldo-livre.js`):

- **Entrega direta pelo saldo livre.** A soma do ato **por par** (empresa, material, tamanho) tem de caber em L = max(0, U − D); dividir a quantidade entre lotes do mesmo par não contorna (com L = 3, dois itens de 2 em lotes diferentes são recusados). Excedendo, a resposta é `409 SALDO_LIVRE_INSUFICIENTE`, sem gravar nada. Ordem de travas: idempotência, trabalhador, materiais, pares, lotes, numeração; a posição é lida depois da trava do par e dos lotes, e a conferência vem depois das validações do lote (CA e saldo), de modo que a ordem dos erros que já existiam não mudou. Sem demanda pendente, todo o físico utilizável é livre. O hash da requisição, o hash histórico, a auditoria `ENTREGA_REGISTRADA`, a idempotência e o retorno público continuam os de antes, e a repetição de uma chave já registrada devolve a entrega original sem reconferir o saldo livre.
- **Classificação da baixa.** Eventos físicos (`CA_VENCIDO`, `AVARIA`, `DESCARTE`, `PERDA`, `AJUSTE_INVENTARIO`) nunca são recusados por reserva: a realidade física se registra, respeitando só o saldo do lote, e a cobertura se recalcula depois. Atos discricionários (`DEVOLUCAO_FORNECEDOR`, `OUTRO`) não podem consumir o comprometido: se a baixa reduzir o comprometido do par, é `409 SALDO_LIVRE_INSUFICIENTE`. "Utilizável" é exatamente a definição da posição de estoque (a mesma da cobertura), sem regra paralela: lote de CA ausente ou vencido, ou de material inativo, não participa de U e não é bloqueado pela reserva. Ordem de travas da baixa: idempotência, material (`FOR SHARE`), par, lote; o par é achado por leitura sem trava, e a trava do lote nunca vem antes da do par. A entrada de estoque continua sem trava de par, porque só aumenta o físico.
- **Posição na auditoria da baixa.** `ESTOQUE_BAIXA` passou a registrar `posicaoAntes`, `posicaoDepois` (físico utilizável, demanda pendente, comprometido, saldo livre e sem cobertura) e `reduziuCobertura`, que é verdadeiro quando o comprometido caiu, não quando o físico caiu (com U = 10 e D = 2, uma avaria de 1 não reduz a cobertura; com U = 2 e D = 2, reduz).
- **Auditoria da recusa.** A recusa por saldo livre (entrega direta ou baixa discricionária) é gravada em `logs_auditoria` com a ação `SALDO_LIVRE_INSUFICIENTE`, **somente depois do ROLLBACK** da operação principal, em transação própria por par. A janela de supressão é de 60 segundos por empresa, ator, tipo de operação (`ENTREGA_DIRETA` ou `BAIXA`), material e tamanho: repetições dentro da janela não geram novo registro, e vários pares insuficientes geram um registro por par. A consulta e a inserção são serializadas por um advisory lock de transação de 64 bits em namespace próprio, distinto do da trava do par de estoque, para a auditoria nunca atrasar uma operação normal. O registro leva só ids e números (operação, material, tamanho, quantidade solicitada, físico utilizável, demanda pendente, comprometido, saldo livre e, na baixa, lote e motivo); nunca confirmação, assinatura, justificativa, observação, dispositivo, corpo, token, cookie ou segredo, e o erro público é genérico, sem dado de solicitações de terceiros. Se a auditoria secundária falhar, o erro devolvido continua sendo `SALDO_LIVRE_INSUFICIENTE` e a falha vai para o log técnico estruturado (`[auditoria-recusa]`), sem mensagem original nem payload. Nenhuma migration nova foi necessária: as consultas usam os índices existentes de `logs_auditoria`.

**Pré-condição de banco: migrations até a `066`.** A baixa e a entrega direta passaram a medir a posição de estoque do par, e essa consulta lê `solicitacoes_epi` e `solicitacoes_epi_itens` (migration `065`) e `entregas_epi_itens.solicitacao_item_id` (migrations `058` e `066`). Qualquer banco persistente usado por este código precisa estar migrado até a `066`; sem isso, a baixa e a entrega direta falham com erro interno (500 genérico), porque as tabelas não existem. A pré-condição vale para o código da 12C-3 em diante, e a ordem é sempre aplicar as migrations antes de subir o código. Nenhuma migration foi aplicada a banco persistente durante a 12C, e aplicá-la exige autorização separada. Por isso as suítes de integração de baixa por HTTP (estoque por lote, validade, operações, RBAC de estoque, materiais) passaram a montar o schema com todas as migrations do repositório, em vez de parar na `045`.

**12D-1 (mesmo commit):** estoque mínimo por tamanho e posição de todos os pares, **sem HTTP, sem Dashboard e sem tela nesta subetapa** (o HTTP veio na 12D-2 e as telas, na 12D-3). A migration `067` cria `estoque_minimos`, que guarda só a **sobrescrita** do mínimo de um tamanho (`empresa_id`, `material_id`, `tamanho` não vazio e aparado, `minimo >= 0`, único por par, FK composta por empresa) e que só aceita material com `exige_tamanho = true`; o material sem tamanho nunca tem linha ali. O **mínimo padrão** continua sendo `materiais.estoque_minimo`. O **mínimo efetivo** de um par é a linha própria, inclusive com 0 (que vale como "sem mínimo neste tamanho", não como "herdar"), ou, na ausência dela, o padrão do material (origem `PROPRIO` ou `PADRAO`). A gravação do mínimo lê o material com `FOR SHARE` e não toma advisory lock de estoque; a troca de `exige_tamanho` de verdadeiro para falso ou nulo é recusada com 409 `MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS` enquanto houver sobrescrita, e nenhuma é apagada. A definição de "físico utilizável" e de demanda pendente virou um módulo de fragmentos de SQL (`repositories/sql/posicao-estoque.js`) com aliases e parâmetros explícitos, usado pela cobertura, pelo lote e pelo contexto da entrega. `posicao-estoque.repository.js` lista todos os pares (lotes, demanda pendente, sobrescrita e material ativo sem tamanho com padrão maior que zero) com U, D, C, L, G, mínimo efetivo, déficit = max(0, mínimo − L), necessidade = G + déficit e `abaixoDoMinimo` (mínimo > 0 e L < mínimo), com `total` correto mesmo para página além da última. A posição das escritas (`lerPosicoes`) não mudou de comportamento. Pré-condição: o código novo lê `estoque_minimos`, então qualquer banco persistente que o use precisa estar migrado até a `067`; **a `067` não foi aplicada a nenhum banco persistente**, e aplicá-la exige autorização separada.

**12D-2 (mesmo commit):** os contratos HTTP da posição, **sem tela nesta subetapa** (a 12D-3 integrou as telas existentes) **e sem migration nova** (continuam 000 a 067). Autorização: nenhuma ação nova de RBAC, e o provisionamento do MASTER não mudou.

- **Itens Disponíveis** (`GET /api/estoque/itens-disponiveis`, `availableItems.visualizar`): cada item é um par (material, tamanho) da posição. Os campos antigos seguem (`saldo`, `bloqueado`, `disponivel`, `estoqueMinimo`...) e `disponivel` é sempre igual a `fisicoUtilizavel`; entram `fisicoUtilizavel`, `comprometido`, `saldoLivre`, `semCobertura`, `minimoOrigem` (`PROPRIO` ou `PADRAO`), `abaixoDoMinimo`, `deficit` e `necessidade`. `estoqueMinimo` passou a ser o mínimo efetivo. Filtros novos: `busca` (nome ou código, com os coringas escapados), `situacao` (`SEM_ESTOQUE`, `ABAIXO_MINIMO`, `COM_COMPROMETIDO`, `SEM_COBERTURA`, derivadas no servidor) e `somenteComNecessidade`, que se soma à situação. A lista aparece mesmo para o par sem lote (só com demanda, só com mínimo próprio, ou material sem tamanho com padrão maior que zero), e o total é correto em página além da última.
- **Dashboard** (`GET /api/dashboard/indicadores`): `estoqueAbaixoMinimo` conta os pares com mínimo efetivo maior que zero e saldo livre menor que ele; entram `saldoLivre`, `comprometido`, `semCobertura` e `necessidadeReposicao`, sob a mesma permissão da fonte `availableItems` (sem ela, os seis indicadores de estoque saem `{ permitido: false }` e nenhum número é calculado). `itensDisponiveis` continua sendo o físico utilizável agregado. Tudo soma a mesma posição da lista.
- **Mínimos** (integrados ao recurso Material): `GET /api/materiais/:id/minimos` (`materials.visualizar`) devolve o mínimo padrão, `exigeTamanho` e as sobrescritas; `PUT` e `DELETE /api/materiais/:id/minimos/:tamanho` (`materials.editar`, como em `grupo-usuario.routes.js`) definem e removem a sobrescrita de um tamanho. O mínimo próprio 0 é válido e é diferente de remover (o `DELETE` apaga a linha, nunca grava zero). Material que não exige tamanho recebe 409 `MATERIAL_NAO_EXIGE_TAMANHO`, e o ainda não classificado, 409 `MATERIAL_TAMANHO_NAO_CLASSIFICADO`. `PUT` com o valor que já existe, ou `DELETE` do que não existe, é uma operação válida: 200 com `alterado: false` e sem auditoria (`201` só quando a sobrescrita nasce). A auditoria `ESTOQUE_MINIMO_DEFINIDO` (`materialId`, `tamanho`, `minimoAnterior`, `minimoNovo`) e `ESTOQUE_MINIMO_REMOVIDO` (`materialId`, `tamanho`, `minimoAnterior`, `minimoEfetivoDepois`) entra na mesma transação, sem corpo, cabeçalho nem texto livre. A gravação não toma advisory lock de estoque e a ordem de travas da reserva não mudou. **CORS por namespace:** o `PUT` e o `DELETE` exigem preflight cross-origin, então `criarCors` passou a receber a lista de métodos explícita (obrigatória): o Portal (`/api`) anuncia GET, HEAD, POST, PUT, PATCH e DELETE, e o Painel Privado (`/api/plataforma`) continua com só GET, HEAD, POST e PATCH (o PATCH é `PATCH /empresas/:id`; nenhuma rota dele usa PUT ou DELETE). Um teste compara essas listas com as rotas realmente montadas. O CORS não substitui a verificação de origem: `PUT` e `DELETE` continuam sendo métodos inseguros para ela. Antes dessa correção, também as rotas `PUT /grupos-acesso/:id/usuarios/:usuarioId`, `DELETE /usuarios/:usuarioId/grupo-acesso`, `DELETE /autorizacoes-individuais/:id` e `DELETE /grupos-homogeneos/:id/materiais/:materialId` só funcionavam no mesmo site.
- **Histórico de operações** (`GET /api/estoque/operacoes`, `operations.visualizar`): aceita o tipo `ENTREGA` e o filtro `origem` (`DIRETA` ou `SOLICITACAO`), que só existe nas linhas de entrega (com outro tipo o resultado é vazio, não erro). Cada linha de entrega traz `entrega.origem`; quem também tem `epiFicha.visualizar` recebe a ficha, o trabalhador (id, nome e matrícula do snapshot da entrega) e a solicitação. O CPF nunca sai. A contagem é de operações, e as junções são todas N para um pela empresa.
- **Contexto da entrega direta** (`GET /api/entregas-epi/contexto/:funcionarioId/materiais/:materialId/lotes`): a resposta ganha `posicoes`, por tamanho, com `fisicoUtilizavel`, `comprometido`, `saldoLivre`, `semCobertura` e o mínimo, só números agregados (nunca quais solicitações compõem a demanda). O erro público da recusa continua 409 `SALDO_LIVRE_INSUFICIENTE`, com o corpo mínimo.

Pré-condição: Itens Disponíveis, Dashboard e os mínimos leem `solicitacoes_epi` e `estoque_minimos`, então qualquer banco persistente que os sirva precisa estar migrado até a `067`; nenhuma migration foi aplicada a banco persistente.

**12D-3 (mesmo commit):** as telas **já existentes** passaram a usar os contratos da 12D-2, sem migration nova (continuam 000 a 067), sem rota nova e sem mudança de RBAC. Nenhuma página foi criada e o menu global não mudou.

- **Itens Disponíveis** (`available-items.html`, `js/itens-disponiveis.js`): a tabela mostra, por par (material, tamanho), físico utilizável, comprometido, saldo livre, sem cobertura, mínimo (com a origem, `Próprio` ou `Padrão`), déficit, necessidade e a situação. A situação vem do servidor (`abaixoDoMinimo`, medido pelo saldo livre, mais `semCobertura`, `comprometido` e físico zero): o frontend não recalcula livre, mínimo, déficit nem necessidade, e a dependência de `js/materiais.js` saiu da página. Filtros novos: busca (nome ou código), situação (as quatro do servidor) e "somente com necessidade", somados a categoria, tipo, tamanho e validade do CA; o CSV leva as mesmas colunas mais a origem do mínimo. Em tela pequena, as colunas secundárias (categoria, tipo, déficit e unidade) somem e a tabela rola dentro do próprio quadro.
- **Dashboard** (`dashboard.html`, `js/dashboard.js`): dez cartões. Entram saldo livre, saldo comprometido e necessidade de reposição; "Pendências sem estoque" passa a mostrar a demanda sem cobertura e "Estoque abaixo do mínimo" mede o saldo livre. Quem não tem a permissão da fonte vê "—" e "sem permissão", nunca um zero mascarado; o zero real aparece como "0". "EPIs entregues" continua em integração.
- **Histórico** (`operations.html`, `js/operacoes-estoque.js`): tipo `Entrega` e filtro de origem (Direta ou Solicitação, habilitado só sem tipo ou com `Entrega`). A origem aparece de forma discreta; ficha, trabalhador (nome e matrícula) e solicitação só aparecem quando o servidor os enviou (perfil com `epiFicha.visualizar`), sem espaço reservado nem aviso de falta de permissão quando não vieram. O CPF nunca é lido pela tela.
- **Entrega direta** (`epi-ficha.html`, `js/epi-ficha.js`): ao escolher o material, a posição por tamanho (físico utilizável, comprometido e saldo livre) aparece no passo do lote, e o resumo do item traz o saldo livre do tamanho; a tela nunca mostra quais solicitações compõem o comprometido. A recusa `409 SALDO_LIVRE_INSUFICIENTE` tem mensagem própria ("o saldo físico existe, mas parte dele está comprometida com solicitações já aprovadas..."): o fluxo relê a posição de cada material do rascunho e **não envia nova tentativa** (o botão e `confirmar()` ficam bloqueados) enquanto a releitura não termina; se ela falhar, o botão "Recarregar posição" libera. `SALDO_INSUFICIENTE` (saldo do lote) segue como antes.
- **Gestão de estoque** (`materials.html`, `js/materiais.js`, `js/estoque-minimos.js`): o campo do cadastro passou a se chamar **Mínimo padrão** ("usado para tamanhos que não possuem mínimo específico"; o campo da API continua `estoqueMinimo`). O cartão **Estoque mínimo por tamanho** lista os tamanhos com lote ou com mínimo próprio (nunca uma linha para cada tamanho possível), com mínimo próprio, mínimo efetivo e origem; "0 próprio" é diferente de "herdando padrão". Com `materials.editar`, e só para material que exige tamanho, define, altera e remove o mínimo próprio (`PUT` e `DELETE` de `/api/materiais/:id/minimos/:tamanho`); material de tamanho único ou ainda não classificado só mostra a explicação, e a tela nem envia a escrita (o servidor recusaria com 409). Trocar o controle de tamanho com mínimos configurados mostra a orientação de removê-los (`MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS`). Na baixa, devolução ao fornecedor e "Outro" ganham a explicação de que só usam o saldo livre, e a recusa `SALDO_LIVRE_INSUFICIENTE` tem mensagem própria, sem sugerir um motivo físico para passar.

**Privacidade e CORS.** Nenhuma tela busca dado que o servidor omitiu, e posição, mínimo ou resposta nunca vão para `localStorage` ou `sessionStorage`. O `PUT` e o `DELETE` dos mínimos dependem da lista de métodos do CORS do Portal (12D-2).

**Limpeza.** As funções `listarDisponiveis` e `contarDisponiveis` do repositório de lotes não tinham consumidor de produção desde a 12D-2 (a rota lê a posição) e foram removidas, com os auxiliares que ficaram órfãos. A prova de equivalência com PostgreSQL real passou a comparar a posição com a leitura por lote da Gestão de estoque (`listarPorMaterial`).

**Validação da 12D-3.** Testes de frontend por módulo e por página (DOM simulado, com a trava de `innerHTML` e a de contrato dos campos lidos), uma suíte de integração que roda os módulos reais do frontend contra o servidor HTTP e o PostgreSQL reais (`backend/test/integracao/frontend-12d3-contrato.integration.js`, em schema temporário) e mutantes de frontend, todos mortos.

**Estado da 12D.** Concluída no commit `997b7bc9bc6d04002539ec5046b19ce5da8efae7` (12D-1, 12D-2 e 12D-3). Nenhum banco persistente foi migrado: a `067` continua não aplicada, e aplicá-la exige autorização separada. A solicitação, a aprovação e a entrega por solicitação continuam sem frontend final. A **12E** (que traz a pendência obrigatória D6, abaixo), a 12F e a 12G não foram iniciadas.

**Pendência obrigatória do Bloco 12 antes do fechamento final:** encerrar o remanescente de uma solicitação `APROVADA` ou `APROVADA_PARCIAL` que não será mais entregue. Uma solicitação aprovada que nunca será entregue não pode manter demanda comprometida indefinidamente: hoje só a entrega completa a fecha, e a inativação do trabalhador ou do material apenas a suspende, de forma derivada, sem substituir essa regra. A regra futura precisará decidir quem pode encerrar (se só a Segurança do Trabalho), a justificativa obrigatória, o comportamento depois de entrega parcial, o status histórico adequado, a auditoria e o efeito imediato sobre a demanda, o comprometido, o saldo livre e a demanda sem cobertura. Não foi implementada na 12C, e os estados da migration `065` não foram alterados por causa dela.

### Próximos marcos e itens futuros

Itens ainda não concluídos:

- **Bloco 11 (concluído no código e na `main`, PR #47):** a única pendência é a configuração de produção do e-mail e do deploy (R8), que é pendência de implantação — ver "Bloco 11". Restam também o fechamento acadêmico e a documentação final do projeto.
- **Homologação e produção na AWS:** deploy, requisitos de publicação do frontend (entre eles a CSP no servidor estático), `TRUST_PROXY_HOPS` conforme a topologia real, chaves reais do Turnstile e do MFA, credenciais SMTP reais e SPF, DKIM e DMARC do domínio de e-mail (sem SMTP configurado o backend não inicia em `production`), `PORTAL_URL_PUBLICA` e `PAINEL_URL_PUBLICA` reais e aplicação autorizada das migrations em cada banco.
- **Backlog de segurança pré-liberação comercial:** teto global por empresa/administrador para o envio de convites (R4).
- **Backlog técnico de dependências:** `brace-expansion` e `ip-address` (R9), em alteração separada.
- **Decisão futura, fora do Bloco 11:** gate de cobertura do frontend (R10).
- **Hardening futuro de publicação** (junto da CSP e da implantação, Bloco 14): CSP no servidor estático, com `base-uri 'none'`; endurecer o parser do empacotador (`frontend/publicacao/empacotar.js`), que não reconhece formas anômalas de HTML, como `<script/src="...">`, nem inspeciona `<base href>`; e a proteção final no deploy. Até lá, o pacote só vale com a CSP do servidor estático — ver "Publicação do frontend do cliente".
- **Antes da produção:** limpeza e retenção das tabelas de sessões e de tentativas de login.
- **Backlog:** notificações, página "Acesso negado" com "Solicitar acesso" e reorganização de pastas.
- **Melhoria futura opcional:** Cloudflare Turnstile também no login do Painel Privado, a reconsiderar só se logs ou padrões de ataque justificarem.

### Encerramento do Bloco 8

O Bloco 8 foi planejado em 11 incrementos. Todos estão concluídos ou encerrados:

| Incremento | Situação |
|---|---|
| 1 a 4 — repositórios de empresas, usuários, sessões e tentativas de login | Concluídos (PRs #13 e #14) |
| 5 e 6 — serviço de autenticação e rota de login | Concluídos (PRs #15 e #16) |
| 7 — validação de sessão, consulta da sessão atual e logout com revogação | Concluído (PR #17) |
| 8 — RBAC: perfis, grupos de acesso, permissões, autorizações individuais e delegação | Concluído (PR #18) |
| 9 — login do frontend | Absorvido pela autenticação global e pelo Portal do Cliente. O login por CNPJ foi abandonado por decisão posterior: o acesso empresarial usa e-mail, senha e seleção de empresa |
| 10 — remoção da autenticação simulada | Encerrado pela rodada de segurança S1/S2/S3 (PR #29): as páginas legadas, `js/main.js` e `js/db-api.js` ficam fora do pacote publicado, gerado por allowlist explícita e fail-closed (ver "Publicação do frontend do cliente") |
| 11 — validação final e encerramento | Validação técnica feita no fechamento do Incremento 8 (22/09/2026); encerramento documental registrado nesta seção (26/09/2026) |

Os itens abaixo ficaram fora do Bloco 8 e têm destino formal. Não são pendências do encerramento do bloco:

| Item | Destino |
|---|---|
| Cadastro de empresas | Entregue pela autenticação global (Painel Privado, PR #22) |
| Administração de usuários da empresa | Entregue no Bloco 9, parte F: convite, edição de nome e tipo de conta, inativação e reativação |
| Troca de senha | Entregue no Bloco 11, subetapas 11E + 11F (`main`, PR #46) |
| Recuperação de senha ("Esqueci minha senha") | Entregue no Bloco 11: backend e HTTP (11C + 11D, PR #45), telas (11F, PR #46) e e-mail real (11H); a configuração de produção do e-mail é pendência de implantação |
| Integração contínua (GitHub Actions) | Criada no gate de segurança pré-Bloco 10 (PR #37): `.github/workflows/ci.yml`, ver "Integração contínua (GitHub Actions)" |
| Cobertura mínima de 25% no frontend | Referência histórica, não é requisito vigente: não existe gate de cobertura do frontend. Criar um gate é decisão futura (ver "Requisito de cobertura") |
| Limpeza e retenção das tabelas de sessões e de tentativas de login | Requisito de hardening do deploy, antes da produção |
| Página "Acesso negado", botão "Solicitar acesso" e notificações de pedidos de acesso | Backlog formal |
| Reorganização de pastas | Backlog formal |

## Estrutura do projeto

Árvore resumida às áreas principais:

```text
gestao-epi/
├── .github/workflows/ci.yml  # CI: testes, checksums e integração com PostgreSQL 16
├── backend/                  # API, banco de dados, migrations e regras de negócio
│   ├── migrations/           # 000 a 067 e o manifesto checksums.json
│   ├── scripts/              # runner de migrations e comandos administrativos (CLI)
│   ├── src/                  # app, config, routes, controllers, services, repositories,
│   │                         # middleware, schemas, security, rbac, db, email, errors e utils
│   └── test/                 # suíte padrão (*.test.js) e integração (integracao/*.integration.js)
├── frontend/                 # Interface web
│   ├── portal/               # Portal do Cliente: login, seleção de empresa, início, aceite de convite e ciclo de senha
│   ├── painel-privado/       # Painel Privado da plataforma: login com MFA, empresas, segurança da conta e ciclo de senha
│   ├── institucional/        # Página institucional
│   ├── pages/                # Páginas do sistema (integradas ao backend e protótipo)
│   ├── js/                   # Módulos compartilhados (HTTP, sessão, permissões, páginas)
│   ├── css/                  # Estilos
│   ├── publicacao/           # Allowlist e empacotador do pacote publicado do cliente
│   ├── vendor/               # Biblioteca de terceiros versionada (leitura de planilhas)
│   ├── test/                 # Testes do frontend (node:test)
│   ├── IMAGEN/               # Imagens utilizadas na documentação/interface
│   └── index.html            # Redirecionamento do protótipo (só em desenvolvimento)
├── RFC-V1                    # Especificação funcional do sistema
├── RFC-V1.md.docx
├── README.md
├── CLAUDE.md                 # Regras obrigatórias de desenvolvimento do projeto
├── .gitattributes
└── .gitignore
```

## Frontend

O frontend está localizado integralmente em `frontend/`.

A entrada dos clientes é o Portal do Cliente (`frontend/portal/`). O `frontend/index.html` é o redirecionamento do protótipo: serve só em desenvolvimento e não entra no pacote publicado.

A estrutura interna utiliza caminhos relativos entre `index.html`, `pages/`, `css/` e `js/`.

### Frontend legado

Das 22 páginas originais em `frontend/pages/`, 10 já estão ligadas ao backend real: 9 no Bloco 9 (`materials.html`, `available-items.html`, `employee-history.html`, `import-employees.html`, `dashboard.html`, `stock-validity.html`, `operations.html`, `new-user.html` e `user-admin.html`) e `epi-ficha.html` (Ficha de EPI) no Bloco 10; a página `employee-groups.html` (GHE e EPIs) foi criada no próprio Bloco 9. As outras 12 continuam no repositório como protótipo, com `frontend/js/db-api.js` (simulador de API em `localStorage`) e `frontend/js/main.js` (login e RBAC simulados), usando somente dados inequivocamente sintéticos. O teste de publicação as identifica pelo critério objetivo de carregarem script externo (a biblioteca de planilhas por CDN): elas não entram no pacote publicado (ver "Publicação do frontend do cliente") e serão integradas nos blocos seguintes.

### Bloco 10 — Ficha de EPI

`epi-ficha.html` deixou de ser protótipo na 10G e virou funcionalidade oficial na 10I + 10J. A página usa a sessão empresarial do Portal (`js/sessao-empresarial.js`), as permissões efetivas pelo fluxo central `EpiPermissoes.prepararPagina` (página `epiFicha`, que abre com `epiFicha.visualizar` **ou** `REALIZAR_ENTREGA`) e as APIs reais de ficha e entrega, sem `db-api.js`, `main.js` nem biblioteca externa. As regras ficam em `js/epi-ficha.js`, testado sem navegador: busca de fichas e consulta por CPF (só no corpo de um `POST`), histórico com as cópias da época, rascunho da entrega (até 20 itens, lote escolhido explicitamente, justificativas), confirmação por **assinatura desenhada** (traços normalizados) ou **aceite presencial**, chave de idempotência reutilizada só enquanto o conteúdo não muda, "Tentar novamente" com o mesmo corpo e a mesma chave depois de falha de rede, confirmação invalidada por qualquer mudança lógica e descarte de respostas assíncronas antigas ao trocar de trabalhador. O link "Ficha de EPI" aparece nos menus e no Portal conforme a permissão, e a página e o módulo estão em `frontend/publicacao/allowlist.json`, entrando no pacote publicado.

### Frontend administrativo HTTP (Incremento 8)

Quatro páginas novas em `frontend/pages/` consomem a API HTTP real, com autenticação por sessão e cookie `HttpOnly` (nunca `localStorage`):

| Página | Função |
|---|---|
| `grupos-acesso.html` | Cadastro, listagem, edição, inativação e reativação de grupos de acesso |
| `grupo-permissoes.html` | Configuração das permissões de cada grupo, por recurso e por ação |
| `grupo-usuarios.html` | Vinculação e desvinculação de usuários aos grupos |
| `autorizacoes-individuais.html` | Consulta, concessão, delegação e revogação de autorizações individuais |

Seis módulos JavaScript em `frontend/js/` dão suporte a essas páginas: `api-http.js` e `auth-session.js` (fundação HTTP e sessão) mais um módulo por página (`grupos-acesso.js`, `grupo-permissoes.js`, `grupo-usuarios.js`, `autorizacoes-individuais.js`).

**Desde o Bloco 9, Etapa C, Parte C0**, essas quatro páginas não têm mais login próprio (o formulário por CNPJ foi removido) nem carregam `auth-session.js`. A sessão é a do Portal do Cliente, confirmada no servidor pelo módulo comum `js/sessao-empresarial.js` (`GET /api/auth/me`). Sem sessão válida, a pessoa é levada ao Portal. "Sair" encerra as sessões global e empresarial e só leva ao Portal depois que o servidor confirma a saída; "Trocar de empresa" leva à seleção do Portal. O módulo também remove os rastros do protótipo que poderiam se passar por sessão (a chave `epi-session-user` e o parâmetro `?_s=`), sem tocar no banco simulado das páginas ainda não integradas. As páginas continuam sem `db-api.js` e `main.js`.

**Desde a Parte C1**, o menu e os botões dessas páginas (e os módulos listados no início do Portal) refletem as **permissões efetivas** do usuário na empresa selecionada, obtidas de `GET /api/auth/permissoes`. O endpoint é somente leitura e usa empresa e usuário da sessão. Ele não reinterpreta o RBAC: responde com as mesmas funções que autorizam cada operação real (a decisão por recurso e por ação do middleware de autorização, a autoridade administrativa das páginas de acesso e as regras de concessão e delegação). O módulo `js/permissoes-efetivas.js` falha fechado: se a consulta falhar, vier de outra empresa ou fora do formato, nada é exibido nem liberado. Nada é guardado no navegador, e a consulta é refeita a cada carregamento. O backend continua sendo a autoridade final: chamadas diretas proibidas recebem 403.

**Desde a Parte C2**, a página original `materials.html` (Cadastro de Materiais e EPIs) está ligada ao backend real, com a interface preservada: sessão do Portal (C0), permissões efetivas (C1: abrir exige `materials.visualizar`, salvar exige `materials.criar`) e os contratos de materiais e estoque do Bloco 9, Etapa A. O módulo `js/materiais.js` monta o corpo do `POST /api/materiais` a partir do formulário (prazo de uso convertido para dias no cliente, 1 mês = 30 e 1 ano = 365, com o valor exibido antes de salvar; tipo "Outro" usa o campo livre; campos vazios são omitidos e gravados como `NULL`). "Quantidade comprada" não é atributo do material: quando preenchida, gera a **entrada inicial de estoque em lote** (`POST /api/materiais/:id/estoque/entradas`, ação `MOVIMENTAR_ESTOQUE`, com CA e validade do lote, desde a Etapa E), só depois do cadastro e só se o perfil tiver a ação; recusa da entrada não desfaz o cadastro e é informada explicitamente. O quadro de estoque mostra o saldo real do material escolhido, lote a lote (físico, bloqueado e disponível). O anexo do documento do CA continua visível e desabilitado ("em desenvolvimento"). Os campos Categoria, Código interno e Descrição passaram a existir no banco pela migration `039` (código interno único por empresa, ignorando maiúsculas). A página usa `js/pagina-base.js` (menu móvel e aviso, copiados de `main.js`) e não carrega `db-api.js`, `main.js` nem a biblioteca de planilhas; o menu lateral mantém a estrutura visual, mas os itens ainda não integrados ficam sem link, com a etiqueta "Em integração".

### Bloco 9, Etapas E e F

Desde a Etapa E o estoque é controlado **por lote** (migrations `042` a `045`): cada entrada cria um lote com CA, validade e tamanho quando o material exige (`POST /api/materiais/:id/estoque/entradas`), a baixa é feita no lote (`POST /api/estoque/lotes/:id/baixas`) e toda operação fica registrada em `estoque_operacoes`, sem edição nem exclusão. O saldo anterior à Etapa E virou saldo inicial por lote. A rota antiga `POST /api/materiais/:id/estoque/movimentar`, usada pela Parte C2, foi removida na E10, e o CA saiu do cadastro mestre do material. As páginas Validade de estoque (`stock-validity.html`, recurso `stockValidity`) e Operações de estoque (`operations.html`, recurso `operations`) têm permissão própria, provisionada para o MASTER pelo script `npm run db:provisionar:master`. O menu segue a mesma organização em todas as páginas, e as páginas integradas acompanham o tema claro ou escuro do sistema operacional (`js/tema.js`).

A parte F tornou reais as páginas de usuários da empresa:

- **Novo Usuário** (`new-user.html`): o cadastro é um **convite** (migration `046`). Quem administra informa nome, e-mail e tipo de conta; a pessoa aceita por um link com token opaco (só o SHA-256 fica no banco), de uso único, com prazo e cooldown contra tentativas de senha. Se o e-mail já tiver conta no SafeWork, a identidade global é reaproveitada e só nasce o vínculo com esta empresa. Com o SMTP real (produção), o link só chega à pessoa por e-mail e a tela mostra o estado do envio (enviado ou falha); nos modos de desenvolvimento sem e-mail, o link volta para quem convidou, para ser repassado. Convites pendentes ou expirados têm o botão **Reenviar**, que cancela o anterior e envia um novo (ver "E-mail transacional (11H)").
- **Administração de Usuários** (`user-admin.html`): lista paginada da empresa da sessão, edição de nome e tipo de conta, inativação lógica (as sessões daquele vínculo nesta empresa são revogadas; as outras empresas da mesma pessoa não mudam) e reativação do mesmo vínculo. O e-mail não é editado aqui, porque é a identidade global da pessoa. O grupo continua em Integrantes do Grupo.
- **Autoridade**: MASTER ativo, ou ADMINISTRADOR com autorização individual `GERENCIAR_USUARIOS` (migration `047`, modo `OBRIGATORIA`). Só o MASTER gerencia contas MASTER e ADMINISTRADOR; o ADMINISTRADOR autorizado gerencia SUPERVISOR e USUARIO. A empresa nunca fica sem MASTER ativo: inativar ou rebaixar o último é recusado no servidor, também sob concorrência.

### Portal do Cliente (Autenticação Global — Pacote 4)

`frontend/portal/` é a entrada dos clientes: login por **e-mail, senha e verificação Cloudflare Turnstile** (identidade global, sem TOTP), seleção de empresa e ambiente inicial autenticado. Usa o backend real, sessões no PostgreSQL e cookies `HttpOnly`; nada de sessão é guardado no navegador.

| Página | Função |
|---|---|
| `portal/index.html` | Login (e-mail, senha, verificação Turnstile, Entrar) e o link "Esqueci minha senha" |
| `portal/empresas.html` | "Selecione sua empresa" (e troca de empresa); mensagem própria quando não há empresa ativa vinculada |
| `portal/inicio.html` | Usuário, perfil e empresa ativa; **TROCAR DE EMPRESA**, **Sair da empresa**, **Sair** e o link **Trocar senha**; módulos já integrados e módulos em integração |
| `portal/recuperar-senha.html` (11F) | "Esqueci minha senha": pede o link de redefinição, com o Turnstile (action própria) e a mesma confirmação para qualquer e-mail |
| `portal/redefinir-senha.html` (11F) | Redefinição pelo link: o token chega no fragmento (`#token=`) e sai da barra de endereço antes de qualquer rede |
| `portal/trocar-senha.html` (11F) | Troca de senha com a sessão global em uso; a sessão atual continua depois da troca |

Fluxo: uma empresa autorizada → entra direto; duas ou mais → escolhe; nenhuma → sem acesso operacional. O Portal usa dois cookies: `gepi_sessao_global` (identidade; não dá acesso operacional) e `gepi_sessao` (empresa selecionada; o mesmo que o RBAC sempre usou). Os cookies do Painel Privado são outros (ver "Origens, namespaces e cookies"). O login legado por CNPJ recusa vínculos ligados a uma identidade global — há uma única credencial válida por pessoa.

**Turnstile.** O widget da Cloudflare é carregado só no login do Portal. A página obtém a site key e a action em `GET /api/auth/global/turnstile`, e `POST /api/auth/global/login` só chega à verificação de senha com um token válido, conferido no Siteverify com action e hostname esperados. Em `production`, as duas chaves reais (`TURNSTILE_PORTAL_SITE_KEY` e `TURNSTILE_PORTAL_SECRET_KEY`) são obrigatórias e chaves de teste são recusadas; fora de `production`, sem chaves configuradas, valem as chaves oficiais de teste da Cloudflare.

**Sair.** "Sair" (`POST /api/auth/global/logout`) e "Sair da empresa" (`POST /api/auth/logout`) só são dados como concluídos com resposta 2xx do servidor, que é quem revoga a sessão e remove o cookie `HttpOnly`. Sem essa confirmação (falha de rede, 403, 429, 5xx ou resposta inválida), a página não navega nem finge que a sessão acabou: mantém o conteúdo, avisa que a saída não foi confirmada e que a sessão pode continuar ativa, e reabilita o botão para nova tentativa. Enquanto o pedido está pendente, os botões de saída ficam desabilitados. Página restaurada pelo histórico do navegador revalida a sessão no servidor antes de mostrar qualquer dado.

Módulos de `frontend/pages/` ainda baseados em `localStorage` não são apresentados como dados da empresa; a integração das páginas restantes continua nos blocos seguintes.

`portal/aceitar-convite.html` é a página pública de aceite do convite de usuário (parte F): o token chega no fragmento do link (`#token=`), nunca vai ao servidor na URL e sai da barra de endereço assim que é lido. Conta nova define a senha; conta já existente confirma a senha atual. O aceite não faz login: depois, a pessoa entra pelo `portal/index.html`.

Em desenvolvimento, sirva `frontend/` em `http://localhost:5500` (Portal: `/portal/`) e em `http://localhost:5501` (Painel Privado: `/painel-privado/`), com o backend em `http://localhost:3000` — cada portal só é aceito pela allowlist de CORS/Origin do seu próprio namespace.

### Painel Privado e MFA TOTP

`frontend/painel-privado/` é o ambiente dos administradores da plataforma: cadastro de empresas, convite (e reenvio) do primeiro MASTER de cada empresa e segurança da própria conta. O link do convite só aparece na tela em desenvolvimento; com e-mail real a tela mostra o estado do envio. Usa a API `/api/plataforma`, uma cadeia separada da API do cliente, com CORS, verificação de origem, validação de Host e rate limit próprios.

Na subetapa 11F, o login ganha "Esqueci minha senha", com `recuperar-senha.html` e `redefinir-senha.html` (sem Turnstile; o token do link chega no fragmento `#token=`), e "Segurança da conta" ganha a troca de senha (11E), que pede a senha atual e o TOTP, mantém a sessão atual e revoga as demais, sem tocar no fator TOTP nem nos recovery codes.

O acesso exige **senha e MFA TOTP**. A senha correta não cria sessão: cria um **desafio pré-MFA** (cookie `gepi_mfa_admin`), aceito apenas pelas rotas `/api/plataforma/auth/mfa/*`. A **sessão administrativa plena** (cookie `gepi_sessao_admin`, com token novo) só nasce quando o segundo fator é concluído:

| Situação do administrador | Etapa depois da senha |
|---|---|
| TOTP ativo | Código de 6 dígitos do autenticador ou, na falta dele, um recovery code |
| Sem TOTP ativo (primeiro acesso ou depois de um reset) | Código de liberação de uso único, emitido por CLI, e cadastro do autenticador |
| Entrou com recovery code | Recadastro obrigatório de um autenticador novo |

- **TOTP:** RFC 6238 (SHA-1, 6 dígitos, período de 30 s, tolerância de ±1 período), pela biblioteca `otpauth`. Anti-replay: um código só é aceito se o seu período for posterior ao do último aceito.
- **Segredo TOTP:** cifrado em repouso com AES-256-GCM, com chave versionada (`MFA_TOTP_KEY_V<n>` e `MFA_TOTP_KEY_CURRENT_VERSION`). Sem as chaves, o backend não sobe.
- **Recovery codes:** 10 por lote, exibidos uma única vez; no banco fica só o hash. Gerar um lote novo revoga o anterior.
- **Troca do autenticador, novos recovery codes e troca de senha:** exigem sessão plena e reautenticação com senha e código TOTP (recovery code não vale). As duas primeiras encerram todas as sessões; a troca de senha mantém a sessão atual e revoga as demais.
- **Operação por CLI**, sem rota HTTP: `npm run db:criar-administrador-plataforma` (cria o administrador), `npm run db:mfa:liberar-cadastro` (emite a liberação do primeiro cadastro) e `npm run db:mfa:redefinir` (reset operacional: revoga fatores, recovery codes, desafios e sessões e emite uma liberação nova). Todos exigem `--email <email> --confirmo`.
- **Banco:** a migration `055` faz o PostgreSQL recusar, no COMMIT, sessão administrativa não revogada sem MFA comprovado; a `056` encerra desafios abertos, fatores pendentes e liberações abertas quando o administrador é inativado.

"Sair" do Painel Privado segue a mesma regra do Portal: só a resposta 2xx do servidor conclui a saída.

O Painel Privado não usa Cloudflare Turnstile. Isso é melhoria futura opcional, não requisito atual.

### Origens, namespaces e cookies

| Área | Desenvolvimento | Previsto em produção | API |
|---|---|---|---|
| Página institucional | servida junto com `frontend/` | `www.safeworkengenharia.com.br` | — |
| Portal do Cliente | `http://localhost:5500/portal/` | `app.safeworkengenharia.com.br` | `/api` (em desenvolvimento, `http://localhost:3000/api`) |
| Painel Privado | `http://localhost:5501/painel-privado/` | `admin.safeworkengenharia.com.br` | `/api/plataforma` (em desenvolvimento, `http://localhost:3000/api/plataforma`) |

Cada namespace só aceita as origens da sua própria allowlist (`CORS_ORIGIN` para o cliente, `PLATAFORMA_CORS_ORIGIN` para o Painel Privado), sem curinga e com `https` obrigatório em produção. Os subdomínios de produção ainda não estão publicados.

Cookies de sessão, todos `HttpOnly`, com `Secure` obrigatório em produção. Os nomes abaixo são os padrões, configuráveis em `backend/.env`, e a configuração recusa nomes repetidos entre eles:

| Cookie | Uso |
|---|---|
| `gepi_sessao_global` | Identidade global do Portal do Cliente; sozinho não dá acesso operacional |
| `gepi_sessao` | Empresa selecionada no Portal; é o cookie que o RBAC usa |
| `gepi_mfa_admin` | Desafio pré-MFA do Painel Privado; não é sessão |
| `gepi_sessao_admin` | Sessão administrativa plena do Painel Privado, criada só depois do MFA |

O navegador recebe apenas um token opaco; o banco guarda somente o SHA-256 dele.

### Conexão futura da página institucional

`frontend/institucional/` já prevê os dois botões de acesso (`linkEmpresas`, `linkAdmin`), alimentados pelo objeto `PORTAIS` do próprio arquivo. Em ambiente local (`localhost`, `127.0.0.1` ou `[::1]`), os botões apontam para o Portal (porta 5500) e o Painel Privado (porta 5501). Em qualquer outro host valem só os destinos de `PORTAIS_PRODUCAO`, hoje vazios: a página mostra um aviso em vez de navegar. Quando os subdomínios estiverem publicados (não estão hoje), a conexão será apenas preencher `PORTAIS_PRODUCAO`, com autorização específica para alterar aquela página:

| Botão | Valor de `PORTAIS_PRODUCAO` | Destino previsto |
|---|---|---|
| Acesso Empresas | `empresas` | Portal do Cliente em `app.safeworkengenharia.com.br` (caminho final conforme a publicação, por exemplo `/portal/`) |
| Acesso Restrito | `restrito` | Painel Privado em `admin.safeworkengenharia.com.br` (por exemplo `/painel-privado/`) |

Pré-requisitos antes de preencher: API servida sob `/api` (cliente) e `/api/plataforma` (Painel) na mesma origem de cada portal; `CORS_ORIGIN` e `PLATAFORMA_CORS_ORIGIN` com as origens `https://` reais (disjuntas); `PLATAFORMA_HOST` definido; cookies `Secure`.

### Publicação do frontend do cliente

Em homologação e produção, publica-se somente o pacote gerado por `npm run publicacao:empacotar -- --saida <diretório>` (em `frontend/`), a partir da allowlist explícita `frontend/publicacao/allowlist.json`. As páginas legadas, `js/main.js`, `js/db-api.js`, o `index.html` da raiz e o Painel Privado ficam fora. O empacotador recusa o pacote inteiro diante de qualquer divergência que reconheça. A inspeção do HTML é por expressões regulares, não um parser completo: formas anômalas como `<script/src="...">` e um `<base href>` externo não são detectadas, e o que as cobre é a CSP obrigatória do servidor estático. Endurecer o empacotador é hardening futuro (ver "Próximos marcos e itens futuros"). Detalhes e requisitos obrigatórios do deploy, entre eles a CSP no servidor estático, estão em `frontend/publicacao/README.md`.

## Backend

O backend está localizado integralmente em `backend/` e concentra a API, configuração do servidor, acesso ao PostgreSQL 16, as migrations em `backend/migrations/` e as regras de negócio.

### Arquitetura em camadas

```text
route/controller
    ↓
service
    ↓
repository
    ↓
PostgreSQL
```

- **routes** (`backend/src/routes/`) conectam caminho, middlewares (sessão, validação Zod) e o controller — não decidem autorização.
- **controllers** (`backend/src/controllers/`) traduzem a requisição HTTP em chamada de serviço e o resultado em resposta; `empresaId`/`usuarioId` vêm exclusivamente da sessão autenticada, nunca do corpo da requisição.
- **services** (`backend/src/services/`) coordenam regra de negócio, autoridade e transações.
- **repositories** (`backend/src/repositories/`) só executam SQL parametrizado; recebem o executor (pool ou cliente de transação) por parâmetro, nunca importam o pool global.
- **schemas** (`backend/src/schemas/`), com Zod, validam formato de entrada antes do controller.
- **middleware de autorização** (`backend/src/middleware/autorizacao.js`) decide, a cada requisição, a cadeia perfil → grupo → exceção individual — descrita na próxima seção.

## RBAC (Incremento 8)

Controle de acesso baseado em papéis, com quatro camadas de decisão, sempre verificadas no servidor (o frontend pode ocultar controles conforme perfil, mas nunca é a autoridade final):

1. **Perfil** — `MASTER`, `ADMINISTRADOR`, `SUPERVISOR`, `USUARIO`. Relido do banco a cada requisição, nunca confiado ao cliente.
2. **Grupo de acesso** — grupos personalizados por empresa (ex.: Almoxarifado, Gerência), com permissão configurável por **recurso** (visualizar/criar/editar/excluir) e por **ação**, em três estados: conceder, negar ou herdar do perfil. Negar é sempre uma decisão explícita, nunca confundida com ausência de opinião do grupo.
3. **Exceção individual por recurso** — mesma semântica de três estados, mas por usuário, sobre um recurso específico.
4. **Autorização individual por ação** — concessão pontual de uma ação a um usuário, independente de perfil ou grupo, com:
   - **concessão direta**, restrita ao perfil `MASTER`;
   - **delegação**, para quem recebeu uma autorização própria marcada como repassável (`pode_delegar`) — repassar exige que a autorização de origem ainda esteja valendo para quem delega (concessão + vínculo com a SST quando a ação exige + ausência de bloqueio individual). **Poder executar uma ação não implica poder delegá-la**: as duas autoridades são independentes;
   - **revogação**, por quem concedeu a autorização ou pelo `MASTER`; revogar uma autorização que serviu de origem para outras remove as delegadas dela, mas nunca autorizações concedidas por outro caminho.

### Autoridade administrativa granular

Além do `MASTER`, um `ADMINISTRADOR` pode receber, por autorização individual, o direito de administrar grupos, permissões de grupo, vínculos de usuário ou, desde o Bloco 9 (parte F), os usuários da empresa (`GERENCIAR_USUARIOS`) — sem qualquer autoridade de administração concedida implicitamente por perfil.

Preservados em toda a extensão do RBAC: **isolamento multiempresa** (nenhuma consulta ou escrita alcança dado de outra empresa — o identificador de empresa vem sempre da sessão) e **auditoria transacional** (toda escrita administrativa é registrada em `logs_auditoria`, na mesma transação da alteração; consultas não geram registro de auditoria).

Ficaram fora do Incremento 8, com destino registrado em "Encerramento do Bloco 8": a página de acesso negado com indicação de quem pode conceder a autorização, o botão de solicitação de acesso e as notificações de pedidos (backlog formal). O workflow de CI, que também constava ali, já existe (ver "Integração contínua (GitHub Actions)").

## Segurança implementada

Resumo do que já está em vigor, sempre decidido no servidor:

- **Cabeçalhos HTTP:** Helmet (`backend/src/middleware/cabecalhos.js`) e `x-powered-by` desligado.
- **CORS por allowlist**, separada para o cliente (`/api`) e para o Painel Privado (`/api/plataforma`), sem curinga.
- **Verificação de `Origin`** nos métodos que alteram estado, antes de consumir cota de rate limit.
- **Rate limiting** geral e limitadores próprios para login, MFA, recuperação e troca de senha, aceite de convites e envio de convites.
- **E-mail transacional fail-closed:** em `production` só o SMTP com TLS é aceito; sem ele (ou sem as URLs públicas) o backend não sobe. O link do convite nunca volta na resposta em produção, e o envio de convites tem teto por (empresa, e-mail).
- **Payload limitado:** só JSON, até 32 KiB, validado por schemas Zod.
- **Senhas com Argon2id**, cooldown persistente de login com chave HMAC-SHA-256 e resposta pública genérica contra enumeração.
- **Sessões reais no PostgreSQL:** token opaco de 256 bits em cookie `HttpOnly`; no banco, só o SHA-256 do token.
- **Portal do Cliente:** Cloudflare Turnstile no login. **Painel Privado:** MFA TOTP obrigatório.
- **Logout** do Portal, das páginas integradas e do Painel Privado só é dado como concluído com resposta 2xx do servidor.
- **RBAC** (perfil, grupo, exceção individual e autorização individual) e **isolamento multiempresa**: a empresa vem sempre da sessão, e FKs compostas impedem associação entre empresas no banco.
- **Auditoria transacional** em `logs_auditoria` e `logs_auditoria_plataforma`, cujos gatilhos recusam chaves JSON sensíveis.
- **Publicação do frontend do cliente por allowlist**, fail-closed (`frontend/publicacao/`).
- **Migrations protegidas por checksum** SHA-256 e **CI** em todo pull request e push na `main`.

## API HTTP

A API do Incremento 8 (fotografia histórica, não o total atual da API) soma **23 endpoints**, em **20 caminhos distintos** (três caminhos aceitam dois métodos HTTP cada), distribuídos em **10 arquivos de rota** (`backend/src/routes/`), todos montados na mesma cadeia `/api` de `backend/src/app.js`, com CORS restrito, verificação de origem, rate limit e validação de conteúdo aplicados uma única vez para todas as rotas.

| Arquivo de rota | Endpoints |
|---|---|
| `health.routes.js` | Verificação de disponibilidade |
| `auth.routes.js` | Login, sessão atual, logout |
| `grupo-acesso.routes.js` | Cadastro, listagem, edição, inativação e reativação de grupos |
| `grupo-permissao.routes.js` | Consulta e configuração das permissões de um grupo, por recurso e por ação |
| `grupo-usuario.routes.js` | Consulta de vinculados, vinculação/transferência e desvinculação |
| `autorizacao-individual.routes.js` | Concessão direta, delegação e revogação de autorização individual |
| `catalogo.routes.js` | Catálogo real das ações administráveis |
| `usuario-consulta.routes.js` | Consulta administrativa de usuários da empresa |
| `autorizacao-consulta.routes.js` | Consulta das autorizações individuais de um usuário |
| `delegacao-destinatarios.routes.js` | `GET /api/delegacao/destinatarios` — a quem um usuário com autorização repassável pode delegar, sem exigir a autoridade administrativa de vínculos de grupo |

O Bloco 9 acrescentou, na mesma cadeia `/api`, as rotas de materiais, estoque por lote, itens disponíveis, GHE, funcionários, dashboard e, na parte F, `usuario-administracao.routes.js` (`/api/administracao/usuarios`) e `convite-usuario.routes.js` (`/api/administracao/convites-usuario` e as duas rotas públicas de aceite, `/api/convite-usuario/consultar` e `/api/convite-usuario/aceitar`, com limite de requisições próprio).

O Bloco 10 acrescentou `entrega-epi.routes.js`, também em `/api`: `POST /api/entregas-epi` (registrar entrega, com chave de idempotência), o contexto da entrega em `/api/entregas-epi/contexto/*` (localizar trabalhador por nome ou matrícula, consulta por CPF no corpo, contexto do trabalhador, materiais e lotes) e as consultas `GET /api/entregas-epi/:id`, `GET /api/fichas-epi`, `POST /api/fichas-epi/consulta-cpf`, `GET /api/fichas-epi/:id` e `GET /api/fichas-epi/:id/entregas`. Entrega e contexto exigem a ação `REALIZAR_ENTREGA`; ficha e histórico exigem o recurso `epiFicha` (visualizar). O CPF nunca vai na URL.

Também na cadeia `/api`, `auth-global.routes.js` atende o Portal do Cliente: `POST /api/auth/global/login` (e-mail, senha e token do Turnstile), `GET /api/auth/global/turnstile` (site key e action públicas do widget), `GET /api/auth/global/me`, `POST /api/auth/global/empresas/:id/selecionar` e `POST /api/auth/global/logout`.

A cadeia `/api/plataforma`, montada antes de `/api` e separada dela, atende o Painel Privado: login, sessão e logout da plataforma, as rotas do MFA em `/api/plataforma/auth/mfa/*`, o resumo do painel, o cadastro de empresas e o convite do MASTER (criar, listar, consultar, reenviar e cancelar, com duas rotas públicas de aceite).

A recuperação de senha (Bloco 11D, `recuperacao-senha.routes.js`, na `main` pelo PR #45) tem rotas públicas nas duas cadeias. No Portal: `POST /api/auth/global/recuperacao-senha/solicitar` (e-mail e token do Turnstile), `POST /api/auth/global/recuperacao-senha/redefinir` (token do link e nova senha) e `GET /api/auth/global/recuperacao-senha/turnstile` (site key e action do widget). No Painel Privado: `POST /api/plataforma/auth/recuperacao-senha/solicitar` e `POST /api/plataforma/auth/recuperacao-senha/redefinir`, sem Turnstile. A solicitação bem formada responde sempre `202` com `{ "status": "SOLICITACAO_RECEBIDA" }`, exista ou não a conta, esteja ela ativa ou não. A redefinição responde `200` com `{ "status": "SENHA_REDEFINIDA" }`, não cria sessão e remove os cookies de sessão do portal correspondente. O token do link só é aceito no corpo JSON: as quatro rotas POST recusam qualquer parâmetro na query string. O Turnstile da solicitação usa a action `portal_recuperacao_senha`, diferente da do login, com as mesmas chaves. Cada POST tem o próprio limite de requisições por IP, separado entre si e do login, com os mesmos parâmetros do limite de autenticação.

A troca de senha autenticada (Bloco 11E, `troca-senha.routes.js`) exige sessão em cada cadeia e não aceita parâmetro na query string. No Portal: `POST /api/auth/global/senha`, com a sessão global e o corpo `{ "senhaAtual", "novaSenha" }`. No Painel Privado: `POST /api/plataforma/auth/senha`, com a sessão administrativa plena e o corpo `{ "senhaAtual", "novaSenha", "codigo" }`, em que `codigo` é só o TOTP de 6 dígitos (recovery code não substitui). A identidade vem sempre da sessão, nunca do corpo. No Portal, a senha atual errada responde `401` com `SENHA_ATUAL_INVALIDA` e conta no cooldown do login. No Painel Privado, a senha atual errada, o TOTP errado e o TOTP repetido contam no cooldown de MFA do administrador e recebem a mesma resposta `401` com `REAUTENTICACAO_INVALIDA`, sem dizer qual fator falhou. No sucesso a resposta é `200` com `{ "status": "SENHA_ALTERADA" }`, sem cookie novo: só a sessão atual continua, as demais sessões da conta são revogadas (no Painel Privado, também os desafios de MFA abertos, sem tocar em fator, secret nem recovery codes), os pedidos de redefinição pendentes são cancelados e o aviso de senha alterada sai depois do COMMIT. Cada rota tem o próprio limite de requisições por IP, separado do login e da recuperação.

O reenvio de convite (Bloco 11H) tem uma rota em cada cadeia, ambas `POST` com corpo vazio e sem parâmetro na query: `POST /api/administracao/convites-usuario/:conviteId/reenviar` (sessão empresarial; `GERENCIAR_USUARIOS` e as regras de perfil no serviço) e `POST /api/plataforma/convites-master/:id/:conviteId/reenviar` (sessão administrativa plena; `:id` é a empresa). A empresa vem da sessão (Portal) ou da rota validada (Painel); um convite de outra empresa responde `404`, igual a um convite inexistente. Respostas: `201` com `convite`, `conviteAnteriorId` e `entrega` (`modo`, `estado` e, só em desenvolvimento, `linkAceite`); `409` com `CONVITE_NAO_REENVIAVEL` (já aceito ou cancelado), `CONVITE_JA_PENDENTE` (há outro convite em aberto para o e-mail), `USUARIO_VINCULO_EXISTENTE` (só no Portal) ou `EMPRESA_INATIVA` (só no Painel); `429` com `CONVITE_ENVIO_MUITO_RECENTE` ou `CONVITE_ENVIO_LIMITE_DIARIO` e o cabeçalho `Retry-After`. Criar e reenviar passam antes pelo mesmo limitador por IP, que vem antes da sessão.

`health` é pública, sem exigência de sessão. O login (`POST /api/auth/login`) também é público — é o próprio ponto de entrada da autenticação; o login global do Portal é público, mas exige o token do Turnstile. As rotas de recuperação de senha são públicas: não exigem sessão nem MFA. O logout aceita chamada sem sessão válida, por comportamento idempotente. As demais rotas — todas as administrativas do RBAC — exigem sessão autenticada; nenhuma decide autorização por si mesma, apenas autenticação. A autoridade administrativa é sempre resolvida na camada de serviço, relendo o estado do banco a cada chamada.

## Banco de dados e migrations

O banco do projeto é PostgreSQL 16. As migrations ficam em `backend/migrations/` e existem hoje arquivos versionados de `000` a `067` (68 no total, sem lacunas), que devem ser executados em ordem crescente de prefixo.

**Bloco 12, subetapa 12D-1 (estoque mínimo por tamanho):** a `067` acrescenta, sem alterar nenhuma migration anterior, a tabela `estoque_minimos` (sobrescrita do mínimo por empresa, material e tamanho, com FK composta, `minimo >= 0`, tamanho aparado e não vazio, unicidade por par e gatilho que só aceita material com `exige_tamanho = true`). O mínimo padrão segue em `materiais.estoque_minimo`. Está versionada, no manifesto de checksums e validada em schema temporário; não foi aplicada a banco persistente, e aplicá-la exige autorização separada. Ver "Bloco 12".

**Bloco 12, subetapa 12C-1 (entrega por solicitação, estrutura):** a `066` acrescenta, sem alterar nenhuma migration anterior, `entregas_epi_itens.solicitacao_item_id` (opcional; a entrega `DIRETA` fica sem vínculo e as linhas existentes não mudam), a origem `SOLICITACAO` e as barreiras do banco: FK composta por empresa e material, e um gatilho que recusa solicitação não aprovada ou já entregue, item não aprovado, mistura de solicitações ou de origens na mesma entrega, trabalhador ou tamanho divergente e quantidade acima da aprovada. No COMMIT, a solicitação está `ENTREGUE` se e somente se toda a quantidade aprovada foi entregue. A quantidade entregue de um item é derivada das entregas ligadas a ele; nada é contado em coluna. Está versionada, no manifesto de checksums e validada em schema temporário; não foi aplicada a banco persistente, e aplicá-la exige autorização separada. Ver "Bloco 12".

**Bloco 12, subetapa 12A (solicitação de EPI):** a `065` cria as três tabelas da solicitação (numeração por empresa, cabeçalho e itens), com FKs compostas por empresa, gatilhos de transição e de decisão gravada uma única vez e gatilhos adiados de coerência no COMMIT. Está versionada, no manifesto de checksums e validada em schema temporário; não foi aplicada a banco persistente, e aplicá-la exige autorização separada. Ver "Bloco 12".

**Bloco 11, subetapas 11A + 11B (ciclo de senha):** a `061` cria os pedidos de redefinição de senha das identidades do Portal e a `062`, os dos administradores do Painel Privado. As duas guardam só o hash do link de uso único, limitam a validade a 4 horas, aceitam um único pedido pendente por conta e, por gatilho, impedem que um pedido usado, cancelado ou expirado volte a valer. A `063` cria o contador de solicitações de recuperação por chave HMAC, sem e-mail em claro e sem ligação com conta. A `064` cria a trilha de auditoria da identidade global, que só aceita INSERT e recusa chave JSON sensível. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; nenhuma foi aplicada a banco persistente, e aplicá-las exige autorização separada.

**Bloco 10 (PR #38):** a `057` cria as chaves compostas que as FKs da entrega referenciam (`funcionarios (empresa_id, id)` e `estoque_lotes (empresa_id, id, material_id)`), para que a ficha só aponte para funcionário da mesma empresa e o item da entrega prove, sem gatilho, que o lote é daquele material e daquela empresa. A `058` cria a ficha de EPI (uma por funcionário na empresa, numerada em sequência por empresa), a entrega (evento dentro da ficha, com cópias dos dados da empresa, do trabalhador, do GHE e do responsável da época, chave de idempotência e `origem`, hoje só `DIRETA`) e os itens (cópias do material; tamanho, CA e validade vêm do lote). A `059` faz `estoque_operacoes` aceitar a operação `ENTREGA`, ligada a exatamente um item por FK composta (empresa, item, lote, quantidade). A `060` cria a confirmação de recebimento, exatamente uma por entrega, nos modos `DESENHO` (traços em JSON) e `ACEITE_PRESENCIAL`, sem biometria; a entrega sem confirmação não passa do COMMIT e, como as tabelas só aceitam INSERT, uma entrega gravada fica fechada para sempre. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; aplicá-las a qualquer banco persistente exige autorização separada.

**MFA TOTP do Painel Privado (PRs #34 a #36):** a `048` acrescenta ator e alvo à auditoria da plataforma, para registrar operações de CLI e eventos sem autor humano. A `049` cria os fatores de MFA (por ora só TOTP, com o segredo cifrado e o último período aceito para o anti-replay). A `050` e a `051` criam os lotes e os recovery codes, guardados só como hash. A `052` cria os desafios pré-MFA, separados da sessão. A `053` cria as liberações de cadastro de uso único emitidas por CLI. A `054` registra na sessão da plataforma o instante e o método do MFA. A `055` torna o MFA obrigatório em toda sessão não revogada do Painel Privado, conferido pelo PostgreSQL no COMMIT; ao ser aplicada, revoga com o motivo `MFA_OBRIGATORIO` as sessões anteriores que não comprovam o MFA. A `056` cria o gatilho que, na inativação de um administrador, encerra desafios abertos, revoga fatores pendentes (apagando o segredo cifrado) e revoga liberações de cadastro abertas. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários, inclusive no CI; aplicá-las a qualquer banco persistente exige autorização separada.

**Bloco 9, Etapas E e F (27/09/2026):** as migrations `042` a `045` criam o estoque por lote e as operações de estoque, migram o saldo anterior para saldo inicial por lote, e acrescentam a `materiais` a exigência de tamanho e a classificação de óculos com grau. A `046` cria `convites_usuario` e `convite_usuario_tentativas` (convite de usuário, mesmo desenho do convite do MASTER da `033`/`034`, com FKs compostas que impedem quem convida ou o vínculo criado de serem de outra empresa). A `047` coloca `GERENCIAR_USUARIOS` em modo `OBRIGATORIA` e recusa rodar se já existir autorização individual gravada para essa ação, para não ativar concessão que ninguém revisou. Todas estão versionadas, no manifesto de checksums e validadas em schemas temporários; aplicá-las a qualquer banco persistente exige autorização separada.

**Onde cada migration está aplicada:** o repositório define quais migrations estão versionadas; a tabela `pgmigrations` de cada banco (`npm run db:migrate:status`) é a fonte de verdade sobre o que está aplicado nele. O registro operacional de 24/09/2026 (Bloco 9, Etapa C, Parte C2) documenta que a migration `039` foi aplicada especificamente à `gestao_epi_demo`, com autorização específica e depois de backup validado, e que esse banco ficou, naquele momento, com 40 de 40 migrations aplicadas e nenhuma pendente. Esse registro não implica aplicação aos demais bancos persistentes. Qualquer aplicação futura a banco persistente exige verificar o alvo e autorização específica. As migrations `025` a `038` foram versionadas nas etapas posteriores ao Incremento 8 (autenticação global, Portal do Cliente e sessões).

**Registro histórico (Incremento 8, 22/09/2026):** naquele momento, as migrations `000` a `016` estavam incorporadas à `main` e aplicadas ao banco então tratado como principal. As migrations `017` a `024`, do Incremento 8 (estrutura de SST, autorizações individuais e delegação, grupos de acesso e suas permissões, e as ações administrativas granulares), ainda não haviam sido aplicadas a esse banco naquela fotografia; haviam sido validadas em schemas temporários pela suíte de integração (ver seção de testes). Este é um registro histórico e não representa, por si só, o estado posterior deste ou de outros bancos. O registro operacional de 24/09/2026, acima, documenta separadamente que a `gestao_epi_demo` chegou a `000` a `039` (40 de 40 aplicadas), depois de aplicação autorizada e backup validado. O estado atual de cada banco continua sendo o da sua tabela `pgmigrations`.

Versionar uma migration não significa que ela já foi aplicada. O schema `public` de um banco só passa a ter a estrutura depois de uma execução explícita e autorizada. Criar a migration e aplicá-la são decisões separadas.

Migrations já incorporadas ao histórico não são alteradas retroativamente. Quando uma estrutura precisa mudar, a correção entra em uma migration nova.

A migration `039_alter_materiais_add_categoria_codigo_interno_descricao.sql` (Bloco 9, Etapa C, Parte C2) acrescenta a `materiais` as colunas nuláveis `categoria`, `codigo_interno` e `descricao`, com CHECKs que recusam vazio e espaços nas pontas, teto de 500 caracteres na descrição e índice único parcial `(empresa_id, upper(codigo_interno))` para linhas com código. É aditiva: nenhum registro existente é alterado. Onde ela foi aplicada está no registro de 24/09/2026 acima; aplicá-la a outro banco persistente exige verificar o alvo e autorização específica.

A migration `016_alter_empresas_cnpj_alfanumerico.sql` altera a constraint estrutural de `empresas.cnpj` para aceitar 12 posições `[0-9A-Z]` seguidas de 2 dígitos numéricos. Ela substitui apenas a expressão da constraint e preserva o nome dela, o tipo `VARCHAR(14)`, o `NOT NULL` da coluna, a UNIQUE e a chave primária. A constraint verifica somente o formato. A conferência dos dígitos verificadores não é responsabilidade do banco.

### Configuração de acesso

O backend exige um servidor PostgreSQL 16 acessível e um banco de dados cujo proprietário seja o usuário informado na configuração, com permissão para criar objetos no schema `public`.

O acesso é configurado por cinco variáveis de ambiente, lidas de `backend/.env`:

| Variável | Conteúdo |
|---|---|
| `DB_HOST` | endereço do servidor |
| `DB_PORT` | porta do servidor |
| `DB_NAME` | nome do banco de dados |
| `DB_USER` | usuário de conexão, que deve ser o proprietário do banco |
| `DB_PASSWORD` | senha do usuário |

O arquivo `backend/.env.example` lista todas as variáveis do projeto e não contém valores reais. O `.env` não é versionado, e nenhuma credencial deve ser escrita em código, em documentação ou em argumento de linha de comando.

Além das cinco de banco, o `.env.example` traz, entre outras: o segredo do cooldown de login (`LOGIN_COOLDOWN_HMAC_SECRET`), as chaves do MFA (`MFA_TOTP_KEY_CURRENT_VERSION` e `MFA_TOTP_KEY_V1`, obrigatórias em qualquer ambiente), as chaves do Turnstile (`TURNSTILE_PORTAL_SITE_KEY` e `TURNSTILE_PORTAL_SECRET_KEY`, obrigatórias em `production`), as origens (`CORS_ORIGIN`, `PLATAFORMA_CORS_ORIGIN`, `PLATAFORMA_HOST`), os nomes dos cookies, o número de proxies confiáveis (`TRUST_PROXY_HOPS`) e os limites de requisição. Os valores reais vêm do ambiente ou de um serviço de secrets, nunca do repositório.

Variáveis da recuperação de senha (Bloco 11):

| Variável | Conteúdo |
|---|---|
| `RECUPERACAO_SENHA_VALIDADE_MINUTOS` | validade do link de redefinição; padrão 60, mínimo 5, máximo 240 (4 horas) |
Variáveis do e-mail transacional e dos links (Bloco 11H). Todas estão no `backend/.env.example`, sem valor secreto; senha e usuário do SMTP vêm do ambiente ou de um serviço de secrets:

| Variável | Conteúdo |
|---|---|
| `EMAIL_MODO` | `desativado` (padrão, a mensagem é descartada), `arquivo` (grava TXT e HTML em disco; só desenvolvimento e teste) ou `smtp` (único aceito em `production`) |
| `EMAIL_ARQUIVO_DIRETORIO` | obrigatória no modo `arquivo`: caminho absoluto de um diretório fora do repositório |
| `EMAIL_REMETENTE_NOME`, `EMAIL_REMETENTE_ENDERECO`, `EMAIL_SUPORTE_ENDERECO` | identidade aprovada ("SafeWork Engenharia", `no-reply@safeworkengenharia.com.br` e `suporte@safeworkengenharia.com.br`); só troque em homologação |
| `SMTP_HOST` | obrigatória no modo `smtp`: só o nome do servidor, sem esquema, porta ou caminho |
| `SMTP_PORTA` | padrão 587 |
| `SMTP_SEGURANCA` | `starttls` (padrão), `tls` ou `nenhuma` (sem TLS: só desenvolvimento, recusada em `production`) |
| `SMTP_USUARIO`, `SMTP_SENHA` | obrigatórias em `production`; uma não existe sem a outra |
| `SMTP_TIMEOUT_MS` | limite de conexão e de cada etapa do SMTP; padrão 10000, de 1000 a 30000 |
| `PORTAL_URL_PUBLICA`, `PAINEL_URL_PUBLICA` | origem pública dos links dos e-mails; obrigatórias, `https` e dentro da respectiva allowlist em `production`; fora dela, valem a primeira origem de `CORS_ORIGIN` e a de `PLATAFORMA_CORS_ORIGIN` |

Em `production` o backend recusa iniciar sem SMTP válido (modo `smtp`, TLS, usuário e senha) e sem as duas URLs públicas, e a mensagem de erro cita só o nome da variável e a regra, nunca o valor recebido. Em `smtp`, a senha nunca aparece em JSON, em inspeção da configuração nem em log.

**Operação (sem segredos).** Para provar o envio em homologação, configure as variáveis acima no ambiente (não no repositório), suba o backend e dispare uma recuperação de senha para um endereço de teste; a resposta pública é sempre a mesma, e o resultado é visto na caixa de entrada. Falha de envio não aparece na resposta: aparece no registro técnico (`[entrega-email]`, só com evento, tipo, escopo e código). No modo `arquivo`, os arquivos gravados contêm os links e ficam restritos ao dono do processo; apague-os depois de usar.

### Preparação de um ambiente novo

A sequência abaixo parte de um banco vazio e recém-criado.

```bash
cd backend
npm ci                       # instala as dependências a partir do package-lock.json
cp .env.example .env         # preencher as variáveis, inclusive as cinco de banco
npm run db:migrate:verificar # confere a integridade dos arquivos de migration
npm run db:migrate:status    # mostra o que está aplicado e o que está pendente
npm run db:migrate           # aplica as migrations pendentes
```

Em um banco vazio, a primeira execução de `npm run db:migrate:status` apresenta todas as migrations versionadas como pendentes e pode terminar com código de saída 2. Esse código sinaliza pendência, não erro de configuração, e é o resultado esperado antes da primeira aplicação. Ao final da sequência, `npm run db:migrate:status` deve relatar todas as migrations aplicadas, nenhuma pendente e código de saída 0.

O primeiro acesso ao Painel Privado também é preparado por linha de comando, dentro de `backend/`: `npm run db:criar-administrador-plataforma -- --email <email> --confirmo` cria o administrador (a senha vem da variável de ambiente `ADMINISTRADOR_PLATAFORMA_SENHA`, nunca de argumento) e `npm run db:mfa:liberar-cadastro -- --email <email> --confirmo` emite o código de liberação, exibido uma única vez, com o qual o administrador cadastra o TOTP depois de entrar com a senha.

As migrations `017` a `024`, do Incremento 8, estão na `main` desde o PR #18.

### Comandos de migration

Os três comandos têm propósitos distintos e são executados nessa ordem.

```bash
npm run db:migrate:verificar # compara os arquivos .sql com o manifesto SHA-256, sem acessar o banco
npm run db:migrate:status    # leitura apenas: aplicadas, pendentes e divergências
npm run db:migrate           # aplica as pendentes em ordem crescente de prefixo
```

A aplicação é feita pelo `node-pg-migrate`, com verificação de ordem, transação única para o lote e advisory lock que impede duas execuções simultâneas no mesmo banco. Se uma migration falhar, o lote inteiro é revertido e nenhuma das seguintes é tentada.

O histórico fica registrado na tabela `pgmigrations`, criada e mantida pela ferramenta. Ela é a fonte de verdade sobre o que já foi aplicado.

### Integridade das migrations

As migrations de `000` a `067` são protegidas por um manifesto de checksums SHA-256 em `backend/migrations/checksums.json` (68 entradas; a `067` foi registrada na 12D-1 e as 67 anteriores estão íntegras). O `npm run db:migrate:verificar` recalcula o digest de cada arquivo e o compara com o registro, detectando alteração de conteúdo, remoção e renomeação.

Uma migration já aplicada não deve ser alterada. O manifesto só aceita registro automático de migration nova, e recusa qualquer atualização que encubra mudança em arquivo histórico. Correções de estrutura entram sempre em uma migration nova.

Para manter os digests estáveis entre plataformas, o `.gitattributes` da raiz fixa os arquivos `.sql` em fim de linha LF.

### Baseline

O baseline registra migrations como aplicadas sem executar o SQL delas. Existe apenas para bancos cuja estrutura foi criada antes do controle de migrations, e não faz parte da instalação normal.

Por isso o comando exige confirmação explícita, recusa banco vazio e recusa banco que já tenha histórico registrado. Em uma instalação nova, o caminho correto é sempre `npm run db:migrate`.

O sinalizador de confirmação registra a intenção de quem executa, e não comprova que a estrutura do banco corresponde ao conjunto de migrations. Essa equivalência precisa ser verificada antes, por auditoria do catálogo do PostgreSQL, comparando tabelas, colunas, constraints, índices, funções e gatilhos com o que as migrations declaram. Sem essa auditoria, o baseline pode registrar como aplicadas migrations cujo efeito não está presente no banco.

## Testes e cobertura do backend

O backend usa o runner nativo `node:test` com `node:assert/strict`, e `supertest` para os testes HTTP. A cobertura é medida pela instrumentação nativa do Node (`--experimental-test-coverage`), sem biblioteca adicional. A versão mínima do backend é o Node 22 (`engines`: `>=22`), a mesma usada no CI.

Atualmente existem testes permanentes para a fundação da autenticação (Bloco 5: configuração, normalização, senha, política de senha, token de sessão, cooldown e erros HTTP), para a camada de validação de entrada (Bloco 6: schemas Zod, middleware de validação e tratamento de erros) e para a segurança HTTP (Bloco 7: cabeçalhos, CORS, verificação de origem, política de conteúdo, limite de payload, rate limit e cookies). O Incremento 8 acrescentou a suíte completa do RBAC — repositories, services, controllers, rotas e middleware de autorização. O Bloco 10 acrescentou as suítes da entrega de EPI (serviço transacional e idempotência, schemas, rotas de entrega e ficha, escopo e provisionamento do MASTER) e, no frontend, a do módulo `js/epi-ficha.js` e da página integrada. O Bloco 11 acrescentou as suítes da recuperação e da troca de senha e, na 11H, as do e-mail transacional (configuração, templates, transportes, serviço de e-mail, convites e reenvio, teto de envios e encerramento do servidor), mais as integrações do reenvio de convite e do isolamento Portal × Plataforma e as telas de convite do Portal e do Painel.

Além dessa suíte padrão existe uma suíte separada de integração, que valida migrations, repositórios, rotas e concorrência contra um PostgreSQL real e não roda junto com `npm test`. O Incremento 8 também criou uma suíte de testes de frontend própria (`frontend/test/`, runner nativo `node:test`), inexistente até então — ver "Estado atual" abaixo.

### Comandos oficiais

```bash
npm test                # executa a suíte padrão, sem cobertura
npm run test:cobertura  # executa a suíte padrão e imprime a cobertura por arquivo (linhas, ramos e funções)
npm run test:ci         # executa a suíte padrão com cobertura, exige no mínimo 75% de linhas e grava coverage/lcov.info
DB_NAME=gestao_epi_teste_local npm run test:integracao # executa a suíte de integração contra PostgreSQL real, fora da suíte padrão
```

Todos devem ser executados dentro de `backend/`.

Os três primeiros não precisam de banco. A suíte de integração exige um PostgreSQL acessível, as variáveis `DB_HOST`, `DB_PORT`, `DB_USER` e `DB_PASSWORD` no ambiente e o nome do banco informado explicitamente no comando, como acima: o único banco aceito é `gestao_epi_teste_local`.

O `npm run test:integracao` puro falha fechado, antes de abrir qualquer conexão, sempre que o `DB_NAME` em vigor for outro. É o que acontece enquanto o `.env` estiver apontando para `gestao_epi_homolog_local`: o comando é recusado e nenhum teste roda. O `.env` não precisa ser alterado para rodar os testes; o `DB_NAME` passado no comando vale só para aquela execução.

### Testes de integração

Os arquivos com sufixo `.integration.js`, em `backend/test/integracao/`, validam migrations, repositórios, rotas e concorrência contra um PostgreSQL real. Eles ficam fora do glob de `npm test`, que carrega somente `test/**/*.test.js`, e por isso nunca rodam junto com a suíte padrão.

Cada execução:

- cria um schema temporário exclusivo, com nome gerado aleatoriamente;
- restringe o `search_path` a esse schema;
- aplica ali apenas as migrations necessárias ao caso testado;
- remove o schema com `DROP SCHEMA ... CASCADE` ao final, inclusive quando o teste falha.

As migrations dos ensaios são aplicadas exclusivamente em schemas temporários. Os testes podem consultar o estado do schema `public` para comprovar o isolamento, comparando a estrutura antes e depois da execução, mas não modificam seus objetos nem seus dados. Um `public` vazio, como o do PostgreSQL efêmero do CI, é uma linha de base válida: o que se exige é que ela seja lida do `public` real e que nada nele mude. As credenciais vêm exclusivamente do ambiente e não aparecem no código nem na saída dos testes.

A suíte só escreve no banco `gestao_epi_teste_local`. É uma allowlist de um nome só, definida em `backend/test/integracao/helpers/banco-de-teste.js`: qualquer outro banco é recusado, seja ele de homologação, de demonstração, de desenvolvimento ou um nome qualquer. A recusa acontece em três pontos:

- o preflight do comando oficial (`pretest:integracao`) confere o nome e pergunta ao próprio PostgreSQL, com `SELECT current_database()`, em que banco a conexão caiu; se não for o banco de teste, os testes nem começam;
- cada processo de teste confere o `DB_NAME` antes de carregar qualquer arquivo de teste;
- o helper que cria o schema temporário recusa o nome antes de conectar e confirma o banco real antes do primeiro `CREATE SCHEMA`.

Quem executa um arquivo de integração isolado, fora do comando oficial, conta apenas com a conferência do helper.

Os arquivos de integração são executados em série, com `--test-concurrency=1`. O motivo é o advisory lock do runner de migrations, que tem alcance de banco inteiro e permite apenas uma execução por vez. Em paralelo, um arquivo bloquearia o outro. A serialização reflete essa restrição real da ferramenta e não contorna nenhuma falha intermitente.

### Requisito de cobertura

O único gate de cobertura vigente é o do backend: 75% de linhas.

O backend aplica o limiar de 75% em `npm run test:ci`, que termina com código de saída diferente de zero quando qualquer teste falha ou quando a cobertura de linhas fica abaixo do mínimo. O CI executa `npm ci` e `npm run test:ci` em todo pull request e em todo push na `main`, e qualquer uma dessas duas condições reprova o job (ver "Integração contínua (GitHub Actions)").

O frontend tem suíte de testes própria desde o Incremento 8 (`frontend/package.json`, runner nativo `node:test`, sem dependências externas). O frontend executa `npm test` e **atualmente não existe gate de cobertura do frontend no CI**: o CI só roda `npm test`. As referências antigas a 25% (e a 60%) em documentos e planos anteriores foram uma meta e um plano, **não são requisito vigente**. A cobertura do frontend foi medida de forma informativa, com a instrumentação nativa do Node (`node --test --experimental-test-coverage --test-coverage-exclude="test/**" "test/**/*.test.js"`, dentro de `frontend/`), e deu **89,56% de linhas** na validação do fechamento do Bloco 11 (os scripts embutidos nas páginas HTML não entram nessa conta). Criar um gate de cobertura para o frontend é uma **decisão futura, fora do Bloco 11**; nenhum código de produção nem teste foi alterado para elevar percentual.

### Escopo da cobertura

A cobertura mede `backend/src/**`. A única exclusão é `backend/src/server.js`, e ela existe apenas porque esse arquivo é o entrypoint da aplicação: carrega as variáveis de ambiente, importa `app.js` e abre a porta, sem nenhuma regra de negócio. Nenhum arquivo é excluído para aumentar artificialmente a porcentagem, e novos módulos com regra de negócio devem permanecer no escopo de cobertura. A suíte carrega todos os módulos de `src/` para que cada um apareça no relatório com seu percentual real, inclusive os que ainda não têm teste dedicado.

Os testes `.integration.js` não entram no cálculo da cobertura. A medição acontece em `npm run test:cobertura` e `npm run test:ci`, que carregam apenas `test/**/*.test.js`. A suíte de integração também exercita código de `src/` contra o banco real, mas fica fora dessa medição.

### Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` roda em todo pull request e em todo push na `main`, com permissão só de leitura do repositório (`contents: read`), Node 22 e fuso `America/Sao_Paulo`. Não usa secrets nem `.env`, e qualquer comando que falhe reprova o job. São dois jobs:

| Job | Etapas |
|---|---|
| Backend unitário, checksums e frontend | `npm ci`, `npm run test:ci` e `npm run db:migrate:verificar` em `backend/`; `npm test` em `frontend/` |
| Integração com PostgreSQL 16 efêmero | serviço `postgres:16` criado dentro do runner, com o banco `gestao_epi_teste_local`, credenciais sintéticas e health check; `npm ci` e `npm run test:integracao` em `backend/` |

O PostgreSQL do segundo job existe só durante a execução e é descartado ao fim. Os testes continuam isolados em schemas temporários, e nenhum passo do workflow aplica migrations fora deles.

### Estado atual

Validação local do fechamento do Bloco 11 (11H + 11I + 11J), em 02/10/2026, feita na branch `feature/bloco11-11h-11i-11j` antes do merge. As subetapas 11A a 11F e a 11H, 11I e 11J estão na `main` (PRs #44, #45, #46 e #47, este mesclado em 02/10/2026), e os números abaixo já as incluem. O CI do GitHub rodou no PR #47 e os dois jobs passaram: "Backend unitário, checksums e frontend" e "Integração com PostgreSQL 16 efêmero". A integração local usou exclusivamente o banco `gestao_epi_teste_local`, confirmado por `SELECT current_database()` antes e depois, e o banco ficou limpo ao final.

| Suíte | Testes | Suites | Aprovados | Falhas |
|---|---:|---:|---:|---:|
| Backend — unitário (`npm run test:ci`) | 2576 | 617 | 2576 | 0 |
| Backend — integração PostgreSQL 16 (`npm run test:integracao`) | 2113 | 503 | 2113 | 0 |
| Frontend (`npm test`, dentro de `frontend/`) | 1297 | 251 | 1297 | 0 |
| Checksums das migrations (`npm run db:migrate:verificar`) | 65 | — | 65 íntegras | — |

Cobertura do backend na mesma validação, pelo relatório de `npm run test:ci` (linha "all files"):

| `line %` | `branch %` | `funcs %` |
|---:|---:|---:|
| 89,96 | 94,62 | 82,05 |

O limiar do CI (`--test-coverage-lines=75`) vale para `line %`. Cobertura do frontend medida de forma informativa na mesma validação: 89,56% de linhas, 82,17% de ramos e 86,59% de funções; não existe gate de cobertura do frontend (ver "Requisito de cobertura"). O CI mais recente registrado é o do PR #47 (merge commit `1a474540290e2c80a1b4539cdf24dce491010f40`, 02/10/2026), com os dois jobs aprovados; resultados anteriores, como o do commit `dcca3b8` (29/09/2026), são históricos e ficam no histórico do Git.

**Validação local da 12A + 12B (02/10/2026, antes da PR #49).** Registro histórico da validação feita na branch `feature/bloco12-12a-12b`; não substitui o resultado do CI daquela PR. Só o backend foi revalidado; o frontend não foi alterado.

| Suíte | Testes | Suites | Aprovados | Falhas |
|---|---:|---:|---:|---:|
| Backend — unitário (`npm run test:ci`) | 2692 | 655 | 2692 | 0 |
| Backend — integração PostgreSQL 16 (`npm run test:integracao`) | 2290 | 528 | 2290 | 0 |
| Checksums das migrations (`npm run db:migrate:verificar`) | 66 | — | 66 íntegras | — |

Cobertura do backend no `npm run test:ci` ("all files"): 89,32% de linhas, 94,79% de ramos e 82,10% de funções. Os serviços da solicitação e do vínculo SST são exercitados sobretudo pela integração: com unitário e integração juntos, `solicitacao-epi.service.js` e `vinculo-sst.service.js` ficam com 100% de linhas. A integração usou exclusivamente `gestao_epi_teste_local`, confirmado por `SELECT current_database()`, e o banco ficou sem schemas temporários.

**Validação local da 12C (02/10/2026, branch `feature/bloco12-12c`, ainda sem commit).** Só o backend foi revalidado; o frontend não foi alterado. O CI não rodou nesta branch.

| Suíte | Testes | Suites | Aprovados | Falhas |
|---|---:|---:|---:|---:|
| Backend — unitário (`npm run test:ci`) | 2787 | 689 | 2787 | 0 |
| Backend — integração PostgreSQL 16 (`npm run test:integracao`) | 2470 | 586 | 2470 | 0 |
| Checksums das migrations (`npm run db:migrate:verificar`) | 67 | — | 67 íntegras | — |

Cobertura do backend no `npm run test:ci` ("all files"): 89,41% de linhas, 94,79% de ramos e 82,99% de funções. Com unitário e integração juntos, os arquivos da 12C-3 (`saldo-livre.js`, `auditoria-recusa-saldo-livre.js`, `supressao-auditoria.js`, `auditoria.repository.js`, `estoque.service.js` e `entrega-epi.service.js`) ficam com 97,93% de linhas; no `estoque.service.js` restam só as leituras que a 12C-3 não toca e a releitura do lote depois da trava, que não é alcançável porque lote não é apagado. A concorrência foi repetida em 25 rodadas por cenário (DIRETA × DIRETA, × aprovação, × entrega por solicitação, × baixa física e discricionária, entrada, pares diferentes, mesma chave e recusas simultâneas com supressão), sem deadlock, sem saldo negativo, sem violação da reserva e sem baixa em dobro. A prova de mutação cobriu 29 mutantes distintos (DIRETA sem trava do par, com posição lida antes da trava, sem agregação por par e ignorando o saldo livre; baixa discricionária ignorando o saldo livre, evento físico tratado como discricionário, lote não utilizável tratado como utilizável e `reduziuCobertura` calculado errado; auditoria dentro da transação revertida, supressão sem trava, janela de 60 segundos removida e chave de supressão sem ator, operação ou par; ordem das travas da baixa invertida, entre outros), e todos foram mortos. Os testes novos da 12C-3 nasceram em RED por comportamento ausente, e os RED inválidos foram descartados e refeitos. A integração usou exclusivamente `gestao_epi_teste_local`, confirmado por `SELECT current_database()`; o banco ficou sem schemas temporários e sem tabelas no `public`, e os cinco bancos persistentes de desenvolvimento e revisão não foram tocados (a conferência de leitura ficou idêntica à linha de base anterior).

### Histórico e adoção de TDD

Os testes permanentes dos Blocos 5 e 6 foram escritos depois da implementação desses módulos, convertendo as verificações utilizadas durante a revisão técnica de cada arquivo em testes automatizados. Eles não foram produzidos por TDD e não devem ser apresentados como tal.

A partir do Bloco 7 o desenvolvimento adota o ciclo: escrever o teste, observar a falha esperada, implementar o mínimo necessário, ver o teste passar e então refatorar. Testes escritos depois da implementação e que passam na primeira execução não são apresentados como RED: são testes de verificação e regressão, e, quando isso ocorre, são validados por prova de mutação (ver "Histórico de TDD da 11H a 11J", no Bloco 11).

### Segurança da suíte

- A suíte padrão não depende do `.env` real, de PostgreSQL nem de serviços externos.
- A suíte de integração depende de um PostgreSQL real e lê as credenciais exclusivamente do ambiente.
- Nos testes de integração as migrations são executadas somente em schema temporário exclusivo, removido em cascata ao final. O schema `public` não é alterado.
- O segredo HMAC e a chave do MFA usados nos testes são gerados em memória a cada execução, em `backend/test/setup.js`, e nunca são gravados em disco.
- A suíte não persiste dados sensíveis e verifica que senhas, e-mails, CNPJs, tokens, cookies e cabeçalhos de autorização não aparecem em respostas nem em logs.
- O diretório `coverage/` não é versionado.
