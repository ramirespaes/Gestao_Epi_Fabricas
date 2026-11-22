# Automação de publicação HML — Etapa 52

Preparação local de 07/11/2026 sobre `1b95752bdcd681199e84d05d95b2e044358fce9f`,
branch `feature/cd-componentes-publicacao-20261107`. **Não ativada.** Nada foi executado
na AWS ou alterado no GitHub. O responsável informa a release `f6f5623` homologada e o
environment `homologacao` configurado; esses fatos não foram revalidados remotamente.
Dependências: [operação](operacao.md), [componentes](publicacao-homologacao-componentes.md)
e [contrato da release](publicacao-homologacao.md).

## Fluxo e identidade

`workflow_dispatch` → validação existente de SHA, ancestralidade, cabeça da main e CI
verde no push desse SHA → empacotadores existentes → SHA-256 do `release.json` e ID do
artefato imutável → gate humano `homologacao` → conferência independente da release →
OIDC → blob no S3 privado → pedido separado → agente Linux → instalador existente →
integridade e HTTP → recibo vinculado à execução, commit e hash aprovado.

`publicar=false` é o padrão. O job exige também a variável de **repositório**
`HML_PUBLICACAO_HABILITADA=true`, repositório exato, ref `main` e disparo manual.
Essa variável não deve ficar apenas no environment: ela precisa estar disponível na
avaliação do `if` do job. Nenhuma credencial AWS existe nos jobs validar/empacotar.
O environment deve manter `ramirespaes` obrigatório, autoaprovação permitida, bypass
administrativo desabilitado e só `main`. O YAML não cria nem garante essas regras;
elas precisam ser conferidas antes da ativação. Alterar workflow ou regras remotas
é autoridade administrativa fora do modelo de ameaça do código.

O checkout do controlador em `publicar` usa `github.workflow_sha`; o pacote usa o SHA
validado. O download usa apenas o ID do artefato deste run. SHA do `release.json`
passa por output do job de empacotamento, antes da aprovação; não é aceito um hash
trazido exclusivamente no pacote. O agente recebe esse hash no pedido, separado do
blob. Os dois papéis IAM não podem modificar os objetos um do outro. A `main` avançar
durante a espera não muda pacote ou controlador. O significado de `atual` continua
sendo o instante da validação, não uma nova consulta depois do gate.

As validações de commit, CI, allowlists e SHA existentes foram preservadas. Ações do
workflow foram fixadas em SHA completo. O novo protocolo recusa componentes fora de
Portal/Painel, metadados extras, traversal, links, hardlinks, arquivos extras ou
ausentes, conteúdo divergente, contagem inválida e hash de manifesto divergente.
O transporte JSON/base64 tem limite de 64 MiB e 5.000 arquivos; não extrai tar nem
executa código do artefato. Releases maiores exigem decisão e revisão do limite.

## Agente e isolamento obrigatório

Arquivos em `deploy/hml/cd/`: `protocolo.js`, `publicar.js`, `s3.js`, `agente.js`,
configuração inerte e quatro modelos IAM/S3. São módulos CommonJS sem dependências
novas. O agente reutiliza as âncoras Linux e o instalador sem alterar seu código.
Ele não reinicia serviços, não usa root, não instala npm, não aplica migrations e não
aceita componente backend, opt-out de autenticidade ou resolução automática de crítico.

O pacote Portal continua incluindo institucional e Totem, conforme sua allowlist.
Por decisão expressa desta etapa, sua publicação é bloqueada até existir configuração
revisada de **raízes exclusivas da homologação**. O exemplo tem `habilitado=false` e
`isolamentoRevisado=PENDENTE`. O responsável deverá conferir fisicamente raízes, aliases
Nginx, origens e permissões, listar as raízes reais do institucional, backend, dados e
demais áreas protegidas em `raizesProtegidas`, e só então registrar
`RAIZES_EXCLUSIVAS_HOMOLOGACAO_SEM_INSTITUCIONAL`. O código canonicaliza caminhos e recusa
sobreposição; não consegue descobrir sozinho um alias Nginx omitido da configuração.
Portal e Painel devem ter bases diferentes e origens HTTPS distintas. O diretório de
estado do agente também precisa ser exclusivo, privado e separado das bases/protegidos.
Não alterar o site institucional para adequá-lo a esse layout.

Os dois componentes precisam já existir como releases íntegras, consistentes e
identificáveis pelo instalador. Não existe adoção automática do layout da AWS.
A baseline também precisa passar pelo verificador HTTP completo antes de qualquer
troca. Sem isso, o agente recusa e nenhuma instalação começa.

## Concorrência, falhas e rollback

O grupo global `deploy-hml` não cancela uma execução em andamento. O GitHub pode
substituir uma execução ainda pendente por outra: isso não é fila FIFO garantida.
No Linux, `.trava-cd` protege o par de componentes; as travas individuais do instalador
continuam valendo. Nenhum outro processo do mesmo usuário pode escrever nas árvores
ou executar o instalador manualmente durante a operação.

O pedido nasce após aprovação e upload, expira em oito minutos e é revalidado antes
de cada instalação. Não há ponteiro mutável `latest`. Cada run/attempt possui chaves
exclusivas `hml/blobs/<run>-<attempt>.json`, `hml/pedidos/...` e `hml/recibos/...`.
PutObject usa `If-None-Match: *`; não há overwrite, DeleteObject ou limpeza automática.
Conflito/erro de AWS, recibo divergente, ausência de recibo em dez minutos ou status
distinto de sucesso fazem o job falhar. Um timeout ou cancelamento **não prova que o
servidor não operou**: interromper novas publicações e reconciliar o estado/recibo
antes de novo disparo. Se a operação já começou, ela termina ou tenta recuperar;
cancelar o Actions não desfaz uma troca no servidor.

O agente captura identidades anteriores e verifica, por componente e em cada origem,
versão HTTP, hash de todos os arquivos, CSP, cache, `nosniff` e isolamento. A API
(`/api/health`) é conferida **uma vez por fase**, na origem do Portal ou na URL `apiSaude`
da configuração (origem HTTPS ou `http://127.0.0.1:<porta>`, sem caminho nem credenciais),
nunca na origem do Painel: o modelo Nginx homologado do Painel devolve 404 em `/api/` fora
de `/api/plataforma/`, e o backend não expõe `/api/plataforma/health` (correção da Etapa 55;
antes dela o agente recusaria toda publicação com `PRE_DEPLOY_HTTP`). Repete as provas
depois de cada troca e no final; a recuperação é comprovada pelas páginas, que são o que o
agente altera. `/api/health` prova vivacidade, não prontidão do banco nem versão do backend.
Não há escrita ou autenticação de usuários nos testes HTTP. `/versao.json` precisa ser
acessível ao agente pela restrição já homologada.

Se uma troca ou prova falhar, só componentes realmente alterados são revertidos,
em ordem inversa. O atual precisa ser exatamente a release desse pedido e o ponteiro
anterior precisa ser a baseline capturada. A reversão usa o instalador, exige
durabilidade e é confirmada por integridade e HTTP. Nenhum terceiro commit é revertido.
Sucesso da recuperação produz `FALHOU` com `recuperacaoComprovada=true`, nunca sucesso
de deploy; recuperação insegura ou não comprovada produz `CRITICO` e mantém a trava global. Os dois ponteiros não são
trocados atomicamente entre si: existe uma janela de versões mistas. Por isso este
fluxo só atende releases frontend compatíveis com a API em execução e entre si.

### Correção 53A: recusa, fila e prova de liberação

O ciclo de `processar` grava `INICIO` antes de buscar o pedido e um terminal durável
antes de liberar a trava. Um pedido expirado, falha de transporte ou integridade
inválida detectados antes de chamar o instalador resultam em `RECUSADO`,
`verificado=false` e `mutacao=NENHUMA`: essa afirmação trata das releases, não dos
arquivos locais de diagnóstico/entrada. Se o pedido não pôde sequer ser identificado,
fica apenas o terminal local; não se inventa um recibo remoto com SHA ou identidade
ausentes. O publicador falha por erro ou ausência de recibo, nunca trata recusa como
sucesso. Nova tentativa de publicação exige nova execução/aprovação.

A fila continua após uma recusa segura ou recuperação comprovada, mas a execução
do scanner retorna falha agregada se processou alguma delas. Antes de cada chamada
do instalador, grava `INSTALACAO_INICIADA`, preservando a baseline no registro. Erro
sem resultado demonstrável depois desse ponto é crítico. Registro anterior pendente,
ilegível ou de formato antigo não é reinterpretado como recusa sem mutação. Entrada
preexistente de origem incerta e recibo remoto conflitante também mantêm o bloqueio.
Falha ao gravar o terminal impede liberar a trava, mesmo sem instalação.

Um terminal seguro já gravado permite reenviar o mesmo recibo sem reinstalar.
Esse reenvio confirma o resultado histórico registrado; não executa uma nova prova
HTTP nem declara que nenhuma release posterior possa ter sido instalada.
Falha de entrega conserva o resultado local e informa `reciboPendente`; após uma
instalação ou recuperação, o scanner interrompe a passagem até concluir esse reenvio.
Um resultado crítico ou incerto exige inspeção e decisão próprias: a correção não
remove travas de operações anteriores nem faz recuperação forçada.

Estado e transições do par são escritos com `fsync`/rename pelas âncoras existentes.
Uma queda deixa trava e registro pendentes: nunca se remove trava por idade nem se
retoma uma operação incompleta automaticamente. Registro terminal durável permite
reenviar somente o recibo, sem reinstalar. Entradas baixadas, registros e diário são
preservados para inspeção; retenção/limpeza precisa de procedimento futuro autorizado.
Em estado crítico: identificar processo e ponteiros, preservar evidência, conferir
diários individuais e registro do par, decidir recuperação manual com autorização,
verificar as duas origens e só então liberar trava/registro. Não usar `rm` automático.

## Autenticação e configurações futuras

Modelos JSON são inertes, com `CONTA` e `BUCKET` a substituir e revisar; não aplicar
diretamente. A confiança OIDC exige audience `sts.amazonaws.com` e subject exato
`repo:ramirespaes/Gestao_Epi_Fabricas:environment:homologacao`. Nesse subject o GitHub
representa o environment; a restrição de branch é garantida pelas regras do environment
e pelo workflow, não por inventar um claim IAM `ref` adicional.

O publicador só escreve blobs/pedidos e lista/lê recibos. O agente só lê blobs/pedidos/recibos,
lista os prefixos restritos de pedidos/recibos e escreve recibos. Sem permissões de EC2, Lightsail, SSM,
IAM, banco, ACL, exclusão ou alteração de bucket. Exigir bucket privado dedicado a HML,
Block Public Access completo, Object Ownership sem ACL, versionamento, TLS, AES256 e
política que imponha criação condicional. Não habilitar lifecycle que exclua pedidos
antes dos recibos nem remover pedidos automaticamente; fila acima de 1.000 exige
arquivamento autorizado. Modelos assumem SSE-S3; SSE-KMS exigiria política própria.

As credenciais do runner vêm somente do OIDC, duram 1.800 segundos e ficam restritas
ao job protegido. A conta é validada antes da entrega e o bucket usa expected owner.
O adaptador ignora profiles, arquivos locais de credenciais/configuração, endpoints
alternativos e metadata; só aceita credencial com session token. Não grava nem exibe
credenciais; erros de CLI são substituídos por códigos sem stderr sensível.

**Dependência de ativação:** o Linux precisa receber credenciais temporárias do papel
do agente por mecanismo seguro homologado. Não presumir instance profile em Lightsail;
escolher e autorizar um broker de credenciais temporárias antes de instalar o agente.
Não usar chaves permanentes no GitHub, no arquivo de configuração, no serviço ou no Git.
O broker/scheduler deverá renovar a sessão e chamar o agente por usuário dedicado,
sem outros escritores nas árvores. Não foi criado, instalado ou iniciado nesta etapa.
AWS CLI v2 com suporte a `put-object --if-none-match` e Node >=22 precisam já existir;
instalar ferramentas ou criar timers exige autorização própria.

Variável de repositório: `HML_PUBLICACAO_HABILITADA`. Seu estado remoto não foi
verificado nem alterado nesta entrega; deve permanecer desligada até autorização.
Variáveis do environment: `HML_AWS_ROLE_ARN`, `HML_AWS_ACCOUNT_ID`, `HML_AWS_REGION`,
`HML_RELEASE_BUCKET`. Nenhum Secret novo é necessário. Nomes de recursos e caminhos
reais ficam na configuração privada; os artefatos públicos contêm só o frontend.

## Procedimento de ativação — somente após revisão e nova autorização

1. Revisar diff, testes e riscos; realizar gates separados de staging/commit/push/merge.
   Manter o interruptor desligado. Exigir CI verde do commit da main a publicar.
2. Em etapa remota autorizada, conferir environment, IAM/OIDC, bucket e identidades;
   aplicar modelos revisados e variáveis, mantendo `HML_PUBLICACAO_HABILITADA=false`.
3. Inspecionar layout real, raízes protegidas e Nginx; confirmar ausência de vínculo com
   institucional e dados. Se incompatível, interromper: não converter layout ao vivo
   nesta etapa. Adotar baseline manualmente só com plano e autorização próprios.
4. Homologar broker/scheduler, instalar cópia revisada dos módulos `cd`, `instalador`
   e `verificacao` fora das releases, configuração privada e usuário dedicado. O comando
   futuro de consulta da fila é `node agente.js --config /config/privada.json --pendentes`;
   **`--pedido <run>-<attempt>` é operacional: pode processar e instalar uma release.**
   Com terminal seguro anterior, tenta apenas reenviar o recibo. Não é inspeção somente
   de leitura. Não executar nenhum desses comandos no servidor antes dessa autorização.
5. Executar ensaio Linux sintético do agente completo e do adaptador, sem dados reais;
   depois validar IAM e entrega real em janela autorizada. A prova histórica do
   instalador não homologa o novo agente nem substitui esse ensaio.
6. Só depois habilitar configuração local revisada e o interruptor do repositório.
   Disparar com SHA completo, `HOMOLOGACAO`, `publicar=true`; conferir commit, rótulo,
   hash e avisos retroativos no resumo; aprovar pessoalmente o gate `homologacao`.
7. Exigir recibo SUCESSO, integridade/HTTP dos dois alvos e auditoria da sessão AWS.
   Desligar o interruptor em incidente, sem presumir cancelamento remoto da operação.

## Verificação local e limites

### Disparo automático após o CI (preparado, não ativado, sem comprovação em fluxo real)

`deploy-hml.yml` também escuta `workflow_run` do workflow `CI` (`types: [completed]`, `branches: [main]`).
O job `validar` só começa para CI de `push` na `main`, do repositório oficial, concluído com sucesso;
PR, falha, cancelamento e outra branch nem iniciam o job. O script `validar-automatico.js` é a
autoridade e recusa (fail-closed):

- payload do evento e consulta à API da mesma execução do CI divergentes em qualquer campo;
- CI que não seja `ci.yml` de `push` na `main`, concluído e `success`;
- `head_sha` do CI diferente da cabeça atual da `main` (commit substituído);
- outra execução do CD, para o mesmo SHA, em andamento, aguardando aprovação ou já bem-sucedida
  (identificada pelo título `HML automatico <sha>`; execuções falhas ou canceladas não bloqueiam);
- nova tentativa da mesma execução do CD (`run_attempt` diferente de 1): usar o disparo manual.

O commit é o `head_sha` do CI. `publicar=true` e a confirmação literal não se aplicam ao fluxo
automático; o CI verde de `push` e o gate `homologacao` os substituem. O job `publicar` mantém o
interruptor `HML_PUBLICACAO_HABILITADA`, o environment `homologacao` (aprovação humana), o OIDC, o S3,
o agente e o rollback. Depois da aprovação e antes de qualquer credencial, `--atualidade` consulta a
cabeça da `main` e recusa se ela avançou durante a espera. `publicar.js` aceita `workflow_run` apenas na
tentativa 1, sem `permitir_commit_anterior` e sem release retroativa.

O disparo manual (`workflow_dispatch`) permanece como contingência, com SHA completo,
`HOMOLOGACAO`, `publicar=true` e `permitir_commit_anterior` inalterados.

Limites: os testes são locais e estáticos. A avaliação dos filtros, do gate e da execução do
`workflow_run` pelo GitHub só se comprova no fluxo real CI → CD → aprovação → AWS HML. Uma execução
aguardando aprovação mantém o grupo de concorrência `deploy-hml`: um commit mais novo espera até a
anterior ser aprovada ou rejeitada, e a anterior, se aprovada tarde, é recusada pela reconferência.

Os novos testes ficam em `.github/scripts/hml/test/publicacao-aprovada.test.js`,
`s3-isolado.test.js`, `workflow-publicar.test.js` e, na 53A, `processar-ciclo.test.js`;
o glob existente do CI os incorpora sem mudar `ci.yml`.
Validam o protocolo, recusa de adulteração, ordem de autorização, baseline, falha do
segundo componente, rollback e configurações inseguras usando diretórios e dependências
sintéticos. O teste do YAML é estático: não prova a avaliação do gate pelo GitHub.
Não houve validação de credenciais reais, S3, scheduler, servidor, banco ou browser.
Não se repete a homologação histórica do instalador; seus limites A-11 permanecem.

Os testes da 53A exercitam a função real `processar`, os registros, fsync, diretórios
de trava e recibos locais em áreas sintéticas, com transporte, instalador e HTTP
simulados. No macOS a âncora por caminho é usada somente sob `NODE_ENV=test`; no
Linux a mesma suíte usa a âncora real por `/proc`. Não foi criado opt-out operacional
nem uma nova porta de injeção no agente para viabilizar esses testes.

## Reavaliação de riscos da Etapa 53A

Impedimentos obrigatórios antes da ativação: revisão das regras reais do environment,
IAM/OIDC/S3 privado e broker, comprovação do papel exato entregue ao agente, raízes e
aliases Nginx exclusivos, baseline válida e ensaio completo Node 22/Linux. O código
atual confere conta AWS, não o ARN do papel do agente; a identidade exata precisa ser
demonstrada na integração do broker e suas permissões revisadas, ou receber guarda
de código em etapa autorizada. Nenhuma credencial de papel administrativo deve ser
usada como substituição de conveniência. Configurar auditoria das operações reais
também é parte da ativação, não uma evidência fornecida pelos mocks.

Limitações que exigem aceite explícito antes de ativar: (1) o limite de 64 MiB do
GET S3 é conferido depois de gravar o objeto temporário; os uploads deste publicador
são limitados antes do envio, mas um objeto de outro escritor autorizado pode
consumir disco antes da recusa. Exigir origem restrita, recursos monitorados e aceite
desse limite ou implementar download limitado antes de ativar; (2) janela de versões
mistas e compatibilidade funcional com a API, que não são provadas por health; (3)
health como vivacidade, sem prova de banco/versão do backend; (4) resultado remoto
indeterminado após timeout/cancelamento; (5) exclusividade operacional do usuário de
implantação. Esses limites não autorizam remover gates, usar outro papel ou publicar.
Crítico/incerto e registro durável indisponível são bloqueios efetivos, sem opção
de aceite que force a fila. Recusas comprovadas antes do instalador têm terminal
seguro e não mantêm a fila bloqueada por mera expiração do pedido.

Referências técnicas consultadas para a implementação: [OIDC GitHub](https://docs.github.com/en/actions/reference/security/oidc),
[criação condicional S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
e [ação oficial de credenciais fixada](https://github.com/aws-actions/configure-aws-credentials/tree/b47578312673ae6fa5b5096b330d9fbac3d116df).

## Backend: agente, identidade e pré-condição de migrations (Etapa 2B)

Estado: **Não ativado.** Esta etapa entrega só código, modelos e testes locais.
Nada foi executado, instalado ou configurado na AWS nem no GitHub: o environment `homologacao-backend`, a role, as variáveis, o agente no servidor e a
publicação do backend continuam inexistentes ou desabilitados. O `agente.js` do frontend, o instalador, a coordenação e
os workflows não foram alterados (hashes conferidos por `frontend-inalterado.test.js`).

**Identidade e prefixo.** Os modelos `iam-confianca-backend.modelo.json`, `iam-publicador-backend.modelo.json`,
`iam-agente-backend.modelo.json` e `s3-politica-backend.modelo.json` são inertes (só marcadores `CONTA` e `BUCKET`) e usam o
prefixo `hml-backend/` do bucket existente. A confiança aceita só o `sub` do environment `homologacao-backend`; o publicador
escreve só blobs e pedidos e lê só recibos; o agente lê pedidos e blobs e escreve só recibos. Nenhum modelo do backend
alcança `hml/`, e nenhum do frontend alcança `hml-backend/` (`iam-backend-modelos.test.js`).

**Agente do backend.** `agente-backend.js` é um módulo separado, com `agente.config.backend.exemplo.json` nascendo
`habilitado: false`. Ele só entrega o pedido ao instalador, que recusa o backend com `COORDENACAO_NAO_HOMOLOGADA` enquanto
não houver provedor homologado com o D-ORF-6. O agente não declara coordenação, não aceita atestado e não pula a prova de
versão (que é a do processo efetivamente executado, configurada em `processo`).

**Classificação do resultado (conservadora).** Só é `RECUSADO` com `mutacao=NENHUMA`, e libera a trava, a recusa que sai das guardas iniciais do instalador, antes de abrir contexto, trava ou diário: `COORDENACAO_NAO_HOMOLOGADA`, `SAUDE_NAO_CONFIGURADA`, `REINICIO_NAO_CONFIGURADO` e `VERSAO_NAO_COMPROVAVEL` (cada um tem um único ponto de lançamento, fixado por teste), além das recusas do próprio agente antes de chamar o instalador (pedido, escopo, blob, expiração). `OPERACAO_EM_CURSO` e `COORDENACAO_NAO_CONFIRMADA` também são lançadas depois de preparar a release e depois de trocar o link; por isso, depois de iniciada a instalação, resultam em `CRITICO` com `motivo=RESULTADO_INCERTO`. Falha que o instalador declara crítica (`FALHA_POS_TROCA`, `FALHA_POS_REINICIO`, `ESTADO_CRITICO` ou `detalhes.critico`) resulta em `CRITICO` com `motivo=FALHA_CRITICA_APOS_ALTERACAO`. O recibo leva só o código no campo `diagnostico`. Em todo `CRITICO` a trava é preservada, novos processamentos ficam bloqueados e nenhuma reversão automática é executada: o operador recebe o diagnóstico e decide.

**Sucesso exige o resultado do instalador.** `SUCESSO` só com resultado `INSTALADA`, `JA_INSTALADA` ou `CONFIRMADA`, sem aviso `ESTADO_NAO_ATUALIZADO` ou `DURABILIDADE_NAO_GARANTIDA` e com a identidade instalada igual à da release aprovada. Resultado não reconhecido vira `CRITICO` com `motivo=RESULTADO_NAO_RECONHECIDO`; aviso de registro não durável vira `CRITICO` com `motivo=SUCESSO_SEM_REGISTRO_DURAVEL`. `RETENCAO_FALHOU` é só aviso, porque a release já foi comprovada.

**Recuperação interna do instalador.** O instalador possui mecanismo interno de recuperação: depois de falha pós-troca ou pós-reinício ele tenta voltar à release anterior, com reinício e prova, ou fica crítico. O agente não pode desligá-lo e não executa nenhuma reversão adicional nem restauração. Esse mecanismo só passa a atuar depois de uma coordenação homologada com o D-ORF-6, que hoje não existe, e deve entrar na decisão de homologação.

**Dependências entregues ao instalador e estado observado do banco.** O agente entrega ao instalador o que o próprio `depsDoConfig` monta da configuração (instalação de dependências, reinício, health e prova de processo) e a leitura do estado das migrations aplicadas (`lerObservado`). Esse estado vem de `backend/scripts/sonda-estado-observado.js`, executado da release já instalada pelo comando `sonda` da configuração local do agente; nunca vem do pedido nem do pacote. A sonda reutiliza `inspecionarMigrations` com conexão própria: credencial dedicada de leitura lida de um arquivo local (`sonda.credencial`, passado como `--credencial <caminho>`; arquivo regular, do próprio usuário, sem acesso de grupo ou outros, sem link no caminho), nunca de variável de ambiente nem do `.env` da aplicação, de modo que a senha não é herdada por `npm ci`, reinício, PID ou health nem passa pelo agente; limites de conexão, de consulta e de execução; sessão somente leitura; só `SELECT`. A identidade é consultada na mesma sessão: nome do banco, identificador único do cluster (`pg_control_system`, sem privilégio administrativo e independente de TCP, TLS ou socket) e a confirmação de que o servidor não é réplica em recuperação. O agente confronta banco e cluster com `sonda.banco` e `sonda.sistema` da configuração local. Antes de executar a sonda, o agente exige a release instalada íntegra, pela identificação do instalador, e prende a sonda a essa baseline física (`.releases/<nome>/<rótulo>`, nunca pelo link corrente): todas as coletas da operação executam o roteiro dessa baseline, mesmo depois de o instalador trocar o link, de modo que a sonda da release candidata nunca decide a própria compatibilidade; não há substituta se a baseline ficar indisponível, e o vínculo não é reaproveitado entre operações. Formato exigido de `sonda.comando`: o executável (caminho absoluto, fora da árvore de releases) na primeira posição e o roteiro da sonda na segunda, imediatamente depois dele, relativo à baseline ou absoluto dentro dela; o que vier depois só pode ser opção simples, sem caminho. Configuração fora desse formato (opção antes do roteiro, roteiro pelo link corrente ou fora da baseline, argumento com caminho) é recusada com `ESTADO_OBSERVADO_INDISPONIVEL`. Falha fechada: erro, timeout, banco ou cluster diferente do configurado, tabela de controle ausente ou vazia e saída fora do contrato são recusa, e em erro só o código é escrito. O agente coleta antes de baixar o pacote (falha aqui é `RECUSADO` com `mutacao=NENHUMA`, sem trava e sem diretório de entrada) e o instalador coleta de novo em cada pré-condição, com a validade de 15 minutos inalterada; origem e horário são carimbados pelo agente. Limite da identidade: um clone físico do cluster promovido a primário mantém o mesmo identificador. Não ativado: o papel de leitura no PostgreSQL e o arquivo de credencial não foram criados, e a sonda não foi executada contra banco real. Ela não fornece hash das migrations aplicadas (o banco não o guarda), então não alimenta o `estado.json` do verificador de migrations.

**Migrations continuam separadas do CD.** O CD do backend não aplica migrations. O caminho oficial segue sendo
`npm run db:migrate` com `DB_NAME` explícito, e o executor não foi alterado (transação única, trava consultiva em modo
`fail`, ordem verificada, sem `down`).

**Pré-condição obrigatória antes de qualquer migration futura.** `precondicao-migrations.js` é um verificador puro: lê o
`release.json` (com o hash aprovado), o estado do banco, o recibo de backup, o recibo de restauração e o SQL das
migrations pendentes, e emite um laudo selado por SHA-256, vinculado a commit, release e dump.
Ele não aceita um recibo de backup isolado: exige, juntos, (1) backup do banco atual com no máximo 24 horas, (2) restauração do mesmo dump em
instância nova, nunca sobre o banco de origem, com no máximo 72 horas, integridade do dump e sentinelas aprovadas, e
reproduzindo a última migration e a contagem do banco, (3) migrations pendentes iguais às do release, em ordem e com o SQL
conferido por hash e aprovado pelo classificador de SQL descrito abaixo, e (4) estado do banco com carimbo `estado.coletadoEm` de no máximo 30 minutos, sem data futura
(ausente ou inválido: `ESTADO_INVALIDO`; vencido: `ESTADO_VENCIDO`). O laudo vale no máximo 4 horas e nunca além do vencimento do backup, da
restauração ou de 30 minutos da coleta do estado.

Nesta etapa a obrigatoriedade é **procedimental**: `db:migrate` só roda com laudo `APROVADO` e válido, e isso não é
controle técnico, porque o executor não consulta o laudo. Um gate técnico (no workflow, no agente ou no executor) exige
etapa e autorização próprias.

**Falha.** O verificador sai com código 2, escreve o diagnóstico legível e para. Ele não executa restauração, não
reverte nada e não altera o banco; só lê arquivos. Backup real, restauração real e ensaio de recuperação seguem
dependendo do D-ORF-6 e de autorização própria.

**Limites conhecidos do verificador.** O SHA-256 sem autenticação comprova integridade, mas não origem: quem altera o laudo recalcula o hash, e os recibos de backup e de restauração, o `estado.json` e o `coletadoEm` são autodeclarados, porque o verificador não lê o banco nem o dump; o carimbo evita erro por arquivo antigo, não fraude.

**Classificador de SQL das migrations pendentes.** O executor aplica o lote numa única transação, então cada migration pendente é classificada antes, pelo texto do arquivo, em `OK` ou numa de três reprovações:

- `SQL_RECORTAVEL`: o arquivo contém um marcador de seção. O node-pg-migrate 9.0.0 (`sqlMigration.js`) procura, com a expressão `^\s*--[\s-]*(up|down)\s+migration` (por linha, sem distinguir maiúsculas), os marcadores `-- up migration` e `-- down migration`, sem saber se estão dentro de literal, corpo ou comentário de bloco, e executa só o trecho recortado. Como o texto executado não seria o analisado, o arquivo é reprovado com a mesma expressão do executor. Comentários comuns não são afetados: só reprova a linha que começa pelo marcador.
- `SQL_MALFORMADO`: literal, identificador entre aspas, comentário de bloco ou corpo `$tag$` sem fechamento. O texto não pôde ser varrido com segurança.
- `SQL_NAO_TRANSACIONAL`, em dois grupos de regras:
  - palavras procuradas com os comentários removidos, com literais e corpos visíveis e também em branco: `CONCURRENTLY`, `VACUUM`, `CREATE|DROP DATABASE`, `CREATE|DROP TABLESPACE`, `ALTER SYSTEM`, `CREATE|ALTER|DROP SUBSCRIPTION` e `REINDEX` de `DATABASE`, `SYSTEM` ou `SCHEMA` (inclusive com lista de opções entre parênteses);
  - comandos reprovados pelo início, com literais, identificadores e corpos em branco e o texto separado por ponto e vírgula: `BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `PREPARE TRANSACTION`, `SAVEPOINT`, `RELEASE` e `CALL`, em qualquer variante, com argumentos ou sem ponto e vírgula final.

A varredura segue o lexer do PostgreSQL 16: o comentário de linha termina em `\n` ou em `\r`; o comentário de bloco aninha; a continuação de literal em outra linha (quebra de linha, espaços e comentários de linha, e nova aspa) pertence ao mesmo literal e mantém o modo, de forma que um `E'…'` continua com escapes de barra invertida; a marca `$tag$` é reconhecida sem limite de comprimento; e todo caractere não ASCII vale como letra de identificador e de marca. O END de um bloco procedural fica dentro do corpo e não conta como fim de transação.

Falsos positivos conservadores aceitos, que exigem reescrever a migration nova: palavra proibida dentro de literal ou corpo (um `COMMENT ON` que contenha `concurrently`, por exemplo); função ou procedimento com corpo SQL padrão sem aspas (`BEGIN ATOMIC … END`), cujo `END` fica no nível dos comandos; todo `CALL`, `SAVEPOINT` ou `RELEASE`, mesmo legítimo; `PREPARE` de um comando preparado chamado `transaction`; e qualquer arquivo com marcador de seção, mesmo no uso normal do node-pg-migrate.

Limitações remanescentes do classificador: ele não interpreta o SQL nem consulta o banco, e o comportamento do PostgreSQL foi tomado das regras do lexer e da documentação, ou seja, não foi verificado em PostgreSQL real; assume `standard_conforming_strings` ligado (o padrão); não reconhece comandos que só falham dentro da transação e não estão na lista (formas de `CLUSTER`, `DISCARD ALL`, `ALTER DATABASE … SET TABLESPACE` e outros), que geram erro em tempo de execução e desfazem o lote inteiro (falha segura); um corpo de `DO` ou de função que tente controlar a transação passa pelo classificador e falha do mesmo modo; um cifrão logo depois de um número é tratado como parte de identificador, o que só ocorre em SQL sintaticamente inválido; e efeitos que um `ROLLBACK` não desfaz (sequences, `NOTIFY`, funções com efeito externo) não são avaliados. As 97 migrations atuais são classificadas `OK` (testado).

**B4, pendente para a etapa de IAM.** A confiança OIDC do backend se limita ao `sub` do environment `homologacao-backend`; a restrição à `main` depende da política de branch desse environment, que ainda não existe. Avaliar na etapa de IAM uma condição em `job_workflow_ref` e `repository_id`, somente depois de comprovar a compatibilidade com a AWS em execução real. Nada disso foi aplicado nesta etapa.

## Conjunto do mesmo commit: backend preparado, não publicado (Etapas 3B-3 e 3B-4)

O `deploy-hml.yml` ganhou um quarto job, `conjunto`, depois de `publicar`. Os gatilhos, os jobs `validar`, `empacotar` e `publicar`, o environment `homologacao` e os controles de autorização não mudaram: o texto do arquivo anterior ao job novo é o mesmo de antes, byte a byte (provado em `workflow-unificado.test.js`).

O job `conjunto` roda só para a cabeça atual da main (`atual == 'true'`); release retroativa, que é rollback do frontend, não prepara backend. O `if` dele repete, literalmente, a guarda de origem do job `validar` (disparo manual, ou `workflow_run` de push na `main` do próprio repositório com CI verde), além de depender do sucesso do `validar`: a redundância é deliberada, porque a análise estática do SonarCloud (regra S7631) avalia cada job isoladamente. Ele:

1. faz o checkout da `main` do próprio repositório (nunca de um ref vindo do evento, regra S7631 do SonarCloud) e confere que o `HEAD` é exatamente o commit validado, com a árvore limpa; se a `main` avançou depois da validação, o job falha nesse passo, antes de executar qualquer script, e registra `PREPARACAO_CONJUNTO_FALHOU`;
2. gera a release do backend com `deploy/hml/empacotar-backend.js`, com o mesmo commit e o mesmo rótulo do frontend;
3. baixa, pelo identificador, o artefato do frontend desta execução;
4. roda `.github/scripts/hml/conferir-conjunto.js`, que valida cada release com o validador oficial do seu escopo e exige o mesmo commit, o mesmo rótulo, nenhuma retroativa e a lista de migrations do `release.json` do backend igual à do pacote;
5. guarda a release do backend e o `conjunto.json` como artefato de 14 dias.

O identificador do conjunto é o SHA-256 de `safework-hml-conjunto-v1`, commit, rótulo e os SHA-256 dos dois `release.json`, um por linha. O hash do frontend usado é o fixado pelo job `empacotar` antes da aprovação.

Limites desta etapa:

- **O backend não é publicado.** O job não tem environment, OIDC, variáveis de repositório nem credenciais, e não chama `publicar.js`; nenhum pedido chega a `hml-backend/`.
- **O `conjunto.json` identifica releases preparadas, e só isso.** Traz `tipo: RELEASES_PREPARADAS`, `comprovaPublicacao: false` e `comprovaInstalacao: false`, válidos para os três componentes. Publicação e instalação só são comprovadas pelo recibo de cada publicação; o resumo da execução diz o mesmo.
- **O frontend não depende do job novo, e o job novo não reprova a execução.** `publicar` continua com `needs: [validar, empacotar]`, sem alteração. O job `conjunto` é o único do arquivo com `continue-on-error: true`, no nível do job: se a preparação ou a conferência do backend falhar, o job aparece como falho, o log e o resumo trazem `PREPARACAO_CONJUNTO_FALHOU`, e a conclusão da execução continua sendo a de `validar`, `empacotar` e `publicar`. Nenhum passo, de nenhum job, tolera falha; uma falha no próprio `publicar` continua reprovando a execução. `PREPARACAO_CONJUNTO_CONFERIDA` no resumo significa só que a conferência terminou; o armazenamento do artefato é o passo seguinte e, se falhar, o resumo traz também `PREPARACAO_CONJUNTO_FALHOU`, que prevalece.
- **A aprovação não espera o job `conjunto`.** Ele costuma terminar antes, mas quem aprova deve olhar o resultado dele; uma divergência entre as releases não impede a publicação de Portal e Painel.
- **Migrations seguem no gate existente.** O CI não enxerga o banco. A compatibilidade com o estado observado continua decidida no servidor, pelo instalador, e nenhuma migration é executada pelo CD.
- **Nada foi ativado.** O agente do backend, o provedor de coordenação e o instalador seguem como estavam, com `COORDENACAO_NAO_HOMOLOGADA`. A entrega do backend pelo fluxo unificado, a aprovação única dos três componentes e a confiança OIDC correspondente ficam para etapa própria, depois da 3B-2B.

## Guardião de coordenação no agente do backend (Etapa 3B-2B-1)

O agente do backend (`agente-backend.js`) passa a usar o provedor `coordenacao-por-guardiao.js`, que inicia o guardião `backend/scripts/guardiao-de-coordenacao.js` e mantém, numa sessão PostgreSQL dedicada, a exclusão `MIGRACAO` do D-ORF-6 (as quatro chaves de backup, restauração, limpeza e migração).

Configuração (`agente.config.backend.exemplo.json`): seção `guardiao` com `comando` de exatamente dois itens (executável absoluto, fora da árvore de releases, e o roteiro relativo à release) e `credencial` com caminho absoluto, diferente da credencial da sonda. O cluster esperado é o `sistema` da sonda. Sem essa seção, a configuração é recusada com `GUARDIAO_NAO_CONFIGURADO`.

Ciclo de uma operação:

1. Na pré-checagem, o roteiro do guardião é vinculado à mesma baseline física da sonda (`.releases/<nome>/<rótulo>`), pelas mesmas regras; vínculo impossível recusa antes de baixar o pacote (`GUARDIAO_NAO_VINCULADO`).
2. Depois de o pacote ser extraído e antes de `INSTALACAO_INICIADA`, o agente cria o provedor e adquire a exclusão. Outra operação do D-ORF-6 em curso recusa sem mutação com `COORDENACAO_OCUPADA`; qualquer aquisição sem garantia (indisponível, identidade divergente, resposta fora do formato, exceção) recusa com `COORDENACAO_NAO_ADQUIRIDA`.
3. O instalador recebe como `consultarCoordenacao` somente o `consultar` desse provedor; nenhuma dependência extra o substitui. Ele continua consultando antes do preparo, antes da troca e antes do reinício. Se a coordenação deixa de ser confirmada antes do reinício, nada é reiniciado, o link volta e o resultado é `CRITICO`, com a trava preservada.
4. O guardião é liberado antes do registro final, em qualquer resultado (sucesso, recusa ou `CRITICO`), e de novo no `finally` se algo lançar antes. O resultado da liberação fica no registro local (`liberacaoDaCoordenacao`), sempre com `comprovadaNoBanco: false`; o recibo publicado não muda de formato. Só `LIBERACAO_INFORMADA`, `PROCESSO_ENCERRADO` ou `SEM_PROCESSO`, com `processoEncerrado: true`, comprovam o encerramento do guardião. Sem essa comprovação (liberação `INDETERMINADA`, exceção em `liberar()` ou resposta fora do contrato), nenhum resultado seguro se mantém: sucesso ou recusa viram `CRITICO` com motivo `LIBERACAO_DA_COORDENACAO_INCERTA`, sem recibo de sucesso e com a trava local preservada; o resultado anterior fica no registro (`resultadoAntesDaLiberacao`). Um `CRITICO` anterior mantém o próprio motivo. A liberação é pedida uma única vez por operação.

O que continua bloqueado:

- O provedor do guardião **não é homologado**: em produção, o instalador recusa a troca do backend com `COORDENACAO_NAO_HOMOLOGADA`, mesmo com o guardião adquirido. A linha de comando do instalador segue bloqueada para o backend.
- O agente do backend segue desabilitado no modelo de configuração.
- Nenhum teste desta etapa usa PostgreSQL real: o guardião é exercitado como processo Node real, com o protocolo do canal de controle e sem banco. A prova em PostgreSQL 16 é a Etapa 3B-2B-2, e a homologação, a 3B-2B-3.

## Garantia contínua da coordenação (Etapa 3B-2B-3A)

A 3B-2B-3A corrige dois pontos antes de qualquer homologação: a identidade da instância de coordenação e a perda da garantia no meio da instalação. O provedor continua **não homologado** e o agente continua desabilitado; o instalador, o D-ORF-6, os workflows e as migrations não mudam.

**Mesma sessão e os quatro cadeados.** O guardião lê, numa única consulta, `pg_backend_pid()`, o início da sessão (`backend_start`, em segundos desde a época) e as chaves de advisory lock concedidas a ela.
- A aquisição só vale se a sessão mostrar exatamente as quatro chaves de `MIGRACAO`.
- A **impressão da sessão** é o SHA-256 de sistema, pid, início e chaves. Ela sai na aquisição e em cada confirmação, e o provedor exige que seja sempre a mesma.
- Cada confirmação também exige quatro cadeados. O **contador de comandos** (comandos SQL da sessão desde a aquisição, inclusive os do D-ORF-6) tem de bater com as perguntas feitas.
- Divergência em qualquer um desses itens é perda. O contador é só controle complementar: correto, ele não prova continuidade sozinho.

Por que isso demonstra a continuidade:
- **Mesma sessão.** Locks de sessão só somem quando a sessão termina ou quando ela mesma os solta. Pid e início iguais nas duas pontas de um intervalo mostram que a sessão não terminou.
- **Nenhuma soltura antes da hora.** O guardião só solta os cadeados em `liberar`. Isso é coberto pela sequência de SQL fixada em teste e pela guarda estática, que é só léxica.
- **Limite.** Em produção, a continuidade é demonstrada por mesma sessão mais código conferido, e não por histórico do banco, que o PostgreSQL não guarda.

**Reconhecimento da instância.** Cada instância do provedor guarda, numa ficha interna do módulo, se foi iniciada pelo iniciador real, a baseline (`rótulo`, `commit`), o hash esperado do roteiro, a impressão e a **primeira** causa de perda.
- O agente tira o hash esperado do manifesto que o instalador gravou para a release da baseline (`meta/<rótulo>.json`). O provedor confere esse hash no arquivo imediatamente antes de iniciar o processo; se for diferente, nada é iniciado (`ROTEIRO_DIVERGENTE`).
- `garantiaVigente(consultar, { baseline, sha256DoRoteiro })` só é verdadeiro para uma instância real, com roteiro conferido, adquirida, sem perda e criada para essa baseline e esse roteiro.
- Uma função qualquer ou uma fábrica com `iniciarProcesso` injetado nunca são reconhecidas.
- Reconhecer não libera nada: o instalador continua recusando com `COORDENACAO_NAO_HOMOLOGADA`.

**Ações protegidas.** Durante a instalação, cada ação que o agente entrega ao instalador passa por uma guarda antes de começar. As ações são `executar` (npm ci), `reiniciar`, `identificarProcesso` e `verificarSaude`. A guarda exige, nesta ordem:
- operação ainda não encerrada;
- nenhuma perda registrada;
- o prazo da ação cabendo no que resta;
- garantia local do provedor (`garantiaVigente()`, que cai no instante de um aviso de perda, expiração ou saída do processo);
- uma confirmação nova ao guardião (`confirmar()`).

Uma ação já iniciada não é interrompida: um reinício pela metade não tem desfazer seguro. A perda é vista na próxima conferência, e a partir dela nada mais começa, nem o reinício de recuperação. A volta para a release anterior também exige coordenação, então o instalador registra `ROLLBACK_BLOQUEADO`. O resultado é `CRITICO` com motivo `COORDENACAO_PERDIDA_DURANTE_INSTALACAO`. O registro local guarda a primeira causa, a última ação iniciada (e se terminou) e o número de confirmações.

**Prazos efetivos.**
- Da aquisição à confirmação final, a instalação cabe em **30 min**, com **5 min** de margem de encerramento e **10 min** de reserva.
- O guardião precisa informar na aquisição uma vida máxima de pelo menos 45 min. Senão, a operação é recusada sem mutação (`PRAZO_DA_COORDENACAO_INSUFICIENTE`) e o guardião é liberado.
- Cada ação tem prazo próprio: dependências 15 min, reinício 2 min, PID 30 s, saúde 30 s. Ela só começa se o prazo couber no que resta; senão, ou se o limite tiver passado, o resultado é `CRITICO` (`PRAZO_DA_INSTALACAO_EXCEDIDO`).
- O tempo é medido por relógio monotônico.
- As ações com processo usam `deploy/hml/cd/executor-com-prazo.js`, que roda cada comando sem shell, num grupo de processos próprio. No prazo, encerra o grupo inteiro (SIGTERM, depois SIGKILL) e **confere** o fim.
- Fim que não pode ser conferido (`ENCERRAMENTO_DA_ACAO_INCERTO`), prazo vencido ou descendentes deixados para trás impedem as ações seguintes e dão `CRITICO` com esse motivo.
- Só o grupo do próprio filho é sinalizado.

**Janela final.** Depois da última ação, o agente segue esta ordem:
1. confirmação final;
2. operação encerrada (nenhuma ação começa daqui em diante);
3. pedido de liberação;
4. registro `TERMINAL`;
5. recibo.

O tempo entre a confirmação final e o pedido de liberação fica registrado (`janelaFinalMs`). O resultado depende do que sai dessa sequência:
- **`SUCESSO`** exige a confirmação final aprovada e a liberação `LIBERACAO_INFORMADA` com a soltura dos quatro cadeados conferida pelo guardião na mesma sessão. Conferida quer dizer: impressão igual à da aquisição, quatro soltos e nenhum restante, sem perda antes do pedido.
- **Encerramento comprovado sem essa conferência** (`PROCESSO_ENCERRADO`, `SEM_PROCESSO` ou aviso incompleto) mostra que nada ficou preso, mas não a continuidade: o resultado vira `CRITICO` com motivo `CONTINUIDADE_NAO_DEMONSTRADA`.
- **`JA_INSTALADA` com perda** também é `CRITICO`.
- **Sessão encerrada** é só declaração do guardião (`sessaoEncerradaDeclarada`). O agente nunca afirma comprovação no banco (`comprovadaNoBanco: false`).

**Ensaio com PostgreSQL 16.** O ensaio provedor → instalador real → resultado do agente está preparado em `backend/test/integracao/cd-guardiao-coordenacao.integration.js` e roda só na CI efêmera. Ele cobre:
- **posse contínua:** dá `SUCESSO`, e no meio do reinício a mesma sessão aparece com as quatro chaves de `MIGRACAO`, bloqueadas para outra sessão, e com a impressão calculada por fora;
- **sessão do guardião derrubada no reinício:** dá `CRITICO`, sem ação nova e sem reversão.

A mesma montagem roda localmente com uma coordenação simulada. O resultado com o guardião real fica **não verificado** até a execução na CI.
