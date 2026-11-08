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

O agente captura identidades anteriores e verifica API `/api/health`, versão HTTP,
hash de todos os arquivos, CSP, cache, `nosniff` e isolamento nas duas origens. Repete
as provas depois de cada troca e no final. `/api/health` prova vivacidade, não prontidão
do banco nem versão do backend. Não há escrita ou autenticação de usuários nos testes
HTTP. `/versao.json` precisa ser acessível ao agente pela restrição já homologada.

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
