# Operação, serviços, backups e implantação

Preparado em 02/11/2026 para revisão. Base técnica local: `efea5bad7fd433f699b78831a01c69866438f2ab`.
Não comprova GitHub remoto, banco aplicado ou runtime ativo.

Prefira serviços e portas já existentes, com confirmação do worktree servido,
versão e banco autorizado. Não iniciar, reiniciar, redirecionar, parar ou enviar
sinais sem autorização aplicável. Identifique processo por PID/início/comando/cwd
e dependências; nunca sinalização ampla. PIDs/portas de relatos são fotografias.
Não usar launcher antigo preso a migrations 090 em ambiente que evoluiu até 096.
Não alterar .env, permissões, links históricos ou dados para satisfazer uma guarda.
HML e produção são independentes; CI verde não autoriza deploy. DNS, HTTPS, CORS,
cookies, proxy confiável, SMTP e storage devem ser validados na implantação.

### Backup e restauração

Backup real e restore exigem autorização própria, identidade do alvo e plano de
recuperação. Dumps e imagens potencialmente pessoais ficam fora de área sincronizada
e do Git público; não publicar dumps nas evidências. Validar origem, integridade,
consistência, catálogo e restauração isolada; hash sozinho não prova restaurabilidade.
DB+imagens: garantir efetivamente janela sem escrita sobre arquivos/linhas relevantes
(upload, exclusão, limpeza, purga, reprocessamento e alterações manuais), provar
estado antes/depois, verificar origem ANTES de copiar, capturar banco antes dos
arquivos e manifesto da cópia. Fingerprint prova, mas não bloqueia escrita.
Alternativa consistente depende de aceitação escrita anterior e ensaio apropriado.
Diferença gera captura não consistente, preservada, nunca remendada. Errata E-65-01
prevalece sobre receitas históricas “arquivos primeiro”. Restore só em banco E
diretório novos autorizados. Backup e limpeza devem se excluir mutuamente; retenção
da limpeza maior que o intervalo entre backups. Não executar limpeza real de órfãos.
D-ORF-6 é frente própria protegida: não mover, apagar, executar wrappers, reutilizar
autorização ou declarar GREEN por teste histórico. Travas/wrappers de uso único,
inclusive g3 NAO-EXECUTAR, permanecem protegidos. Finder recusou? Pare, sem contorno.

### Diagnóstico do ambiente do backup (`backup-operar --verificar`)

`node scripts/backup-operar.js --verificar [--json]` é o único modo do executor nesta versão e é somente leitura: não cria janela, arquivo, conexão
nem processo, não executa os binários do PostgreSQL e não carrega o `.env` da API (o ambiente vem só de `process.env`, por exemplo
`node --env-file=<arquivo do executor> scripts/backup-operar.js --verificar` ou o `EnvironmentFile` de uma unidade). Relata, item a item: diretórios
(reais, canônicos, do usuário do processo, sem acesso de grupo e outros), mesmo dispositivo de `preparacoes`, `dumps` e `publicados`, separação entre
backup, origens e código, trava de janela I5 (valor, validade, pasta de controle, livre ou ocupada), binários e `PGPASSFILE` do PostgreSQL (arquivo
regular, sem link, modo 0600, do usuário do processo), variáveis `PG*` conflitantes, limites e espaço livre. Variáveis lidas:
`IMAGENS_ARMAZENAMENTO_DIRETORIO`, `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO`, `IMAGENS_JANELA_ESCRITA_ARQUIVO`, `BACKUP_RAIZ`, `BACKUP_PG_BINARIOS`
(padrão `/usr/lib/postgresql/16/bin`), `BACKUP_PG_HOST`, `BACKUP_PG_PORTA`, `BACKUP_PG_USUARIO`, `BACKUP_PG_BANCO`, `PGPASSFILE`,
`BACKUP_LIMITE_DUMP_BYTES`, `BACKUP_LIMITE_TOTAL_BYTES`, `BACKUP_LIMITE_LIVRE_BYTES`. Valores de variáveis nunca são impressos.

Chaves, destinos duráveis, custódia e retenção aparecem como pendências, lidas das mesmas listas e do mesmo avaliador que o código de produção consulta;
`prontidaoOperacional` é sempre falso. A composição de produção não é instanciada: ela só se constrói com fonte de chaves reconhecida, e a de teste exige
`NODE_ENV=test` enquanto as operacionais seguem bloqueadas. Saída: 0 sem falhas e sem pendência de infraestrutura (isto não é prontidão operacional),
1 falha ou erro, 2 argumentos inválidos, 3 pendência de infraestrutura. Os modos `--ensaio`, `--operar` e `--monitorar` existem (seção do executor operacional) e continuam bloqueados ou somente leitura.

### Destino durável S3 e custódia de chaves (R-D45, D-F4 e D-F5) — implementado localmente, NÃO ativado

Estado: o código existe com clientes injetáveis e simulados. Nada contata a AWS, o AWS SDK não está instalado (gate DEP-2 pendente), as listas aprovadas
(`ARMAZENAMENTOS_DURAVEIS_APROVADOS`, `PROVEDORES_OPERACIONAIS_APROVADOS`, `PROVEDORES_DE_CIFRA_APROVADOS`, `DESTINOS_AUTORIZADOS`) continuam vazias, as fábricas
operacionais continuam bloqueadas e a limpeza continua desabilitada. Declarações como "durável" ou "restaurável" exigem evidência real (T2 e T3, abaixo).

**Ficha de destino e lista única.** Cada entrada de `ARMAZENAMENTOS_DURAVEIS_APROVADOS` é uma ficha literal e congelada (`backup-armazenamento-duravel-fichas.service`):
`id`, `ambiente`, `tipo` S3, `regiao`, `contaId` (proprietária do bucket), `bucket` (`safework-<hml|prod>-backup-<conta>`), `prefixo` (`hml/` ou `prod/`), `chaveMac` e
`chaveCifra` (ARN completo de chave KMS, nunca alias), `retencao` (GOVERNANCE ou COMPLIANCE, 1 a 3650 dias; produção exige COMPLIANCE) e `identidades` (publicador,
verificador e restauração). O registro é validado ao carregar: ids, buckets, ARNs e principais nunca se repetem; HML e PROD não compartilham conta; formato antigo (texto
simples) é recusado. A criação do destino (`criarDestinoDuravel`) e a autorização de envio (`autorizarEnvioDuravel`, agora também por ambiente) consultam a lista SÓ por
`localizarArmazenamentoDuravel`. Nada vem de variável de ambiente, argumento ou `src/config`; bucket, conta e chaves aparecem apenas nas fichas. Preencher a lista real é
decisão de Ramires, depois da AWS isolada, e exige alterar de propósito os testes que afirmam lista vazia.

**Dono do bucket x identidade que opera.** `contaId` é o dono esperado em todo pedido (a AWS recusa se o dono real for outro). Cada papel tem uma identidade fixada na ficha,
que pode estar em outra conta (autorização entre contas): o pré-voo consulta a identidade em uso e exige conta e principal exatos (usuário por ARN, papel por prefixo de sessão).
A credencial do dono do bucket ou de outro papel é recusada. Entre contas, a política do bucket e a do KMS precisam conceder o acesso: o publicador não pode ler a política,
então isso é comprovado em T2 (item `ENTRE_CONTAS_A_COMPROVAR`).

**Portas mínimas por papel** (o cliente real só pode oferecer estas operações):

| Papel | Operações | Nunca |
|---|---|---|
| Publicador | `identidade`, `lerConfiguracaoDoBucket`, `descreverChave`, `gravarObjeto` (uma gravação, SHA-256 informado, objeto novo) | apagar, listar, ler objeto, retenção, política, ciclo de vida |
| Verificador (fora do host) | `identidade`, `listarVersoes`, `lerMetadadosDaVersao` | gravar, ler conteúdo, KMS |
| Restauração | `identidade`, `lerVersao` (versão explícita) | gravar, listar |

**Pré-voo obrigatório** (vale por tempo limitado; reprovado, invalida o anterior): identidade do publicador, dono do bucket, região, versionamento, Object Lock, retenção
padrão (modo da ficha e dias iguais ou maiores), criptografia padrão AES256, propriedade do objeto `BucketOwnerEnforced`, chaves KMS habilitadas e simétricas. Falha ao consultar
é reprovação (`FALHA_AO_CONSULTAR`). O resultado sempre traz `comprovacoesPendentes`.

**Estados do envio.** GRAVADO (com recibo e VERSÃO), RECUSADO (nada chamado, ou objeto já existente: nunca sobrescreve), FALHOU (falha definitiva: negado, dono divergente,
checksum rejeitado; pode tentar de novo) e INCERTO (resposta perdida, queda, prazo, resposta fora do contrato, reenvio interno do cliente que encontrou o objeto: nunca durável,
sem recibo, chave bloqueada na execução; a verificação independente decide). Sem retentativa automática. A confirmação do contrato existente (`confirmar`) vem do recibo; hash ou
bytes diferentes não confirmam; a origem de teste nunca é operacional.

**Contra sobrescrita (camadas e limites).** (1) chave nova por conjunto e arquivo; (2) escrita condicional de objeto novo (suporte e política a comprovar em T2); (3) política do
bucket que nega gravação sem a condição (T2); (4) versionamento: sobrescrita preserva a anterior, mas NÃO impede uma versão nova forjada; (5) Object Lock com retenção padrão em cada
versão, que também NÃO impede versão nova; (6) permissões: o publicador só grava, com negações explícitas; (7) pré-voo e dono esperado; (8) recibo com a versão e a restauração SEMPRE
pela versão do recibo; (9) verificação independente, que acusa versão extra, objeto sem recibo, marcador de exclusão, retenção ausente ou expirada, hash ou bytes diferentes.
A seleção por versão NÃO substitui (2), (3) e (5): continuam obrigatórios e são comprovados em T2.

**Restauração.** `backup-baixador-duravel` baixa por versão explícita, conferindo bytes e SHA-256 de cada objeto contra o recibo antes de publicar o arquivo, e só grava num destino local
AUTORIZADO: o pedido informa `destinoLocalId`, `raiz` e `nome`; o validador oficial de destinos locais (`criarValidadorDeDestinos`, registro `DESTINOS_AUTORIZADOS`, hoje vazio) confere que a raiz
é exatamente a autorizada para o ambiente (caminho canônico, sem link, mesma identidade dev/ino, dono e modo 0700) e o módulo cria apenas `raiz/nome`, filho NOVO e direto. Áreas protegidas
informadas não podem coincidir com a raiz, contê-la nem estar dentro dela. A raiz é revalidada, e cada pasta criada tem identidade, tipo, dono e caminho real conferidos, antes de criar o
destino, de cada subpasta, de abrir cada temporário e de publicar cada arquivo; depois do `link` o arquivo tem de ser o mesmo i-node do temporário. Antes de qualquer criação: soma dos recibos
dentro de `limites.totalBytesMaximo` (obrigatório), número de arquivos dentro do máximo (padrão 400000), e espaço livre maior ou igual ao necessário mais margem (o maior entre 10% e 64 MiB) e
inodes livres suficientes; a reserva da decifra dobra a necessidade; falha ao medir é recusa. `backup-restauracao-duravel` encadeia o baixador, a autorização do SEGUNDO destino novo (irmão do
primeiro, no mesmo registro) e `decifrarContainer`, que confere o MAC do envelope em tempo constante ANTES de confiar em qualquer campo ou decifrar qualquer arquivo. A verificação do pacote
reconstruído (`verificarPacoteL2`) é do chamador. O baixador é o único módulo novo que escreve em disco (entrada 48 da guarda P2, abaixo). A escrita da decifra é a do módulo de cifra em envelope
(entrada 47), agora com uma GUARDA DE CONTENÇÃO opcional (`backup-contencao-destino`, somente leitura): o orquestrador a constrói com o mesmo validador oficial e `decifrarContainer` a consulta antes de criar
uma subpasta, de abrir cada temporário e de ligar cada arquivo, e a avisa depois de criar cada pasta (a identidade dev/ino fica registrada). Raiz trocada, pasta trocada por link ou por outra pasta, destino
trocado ou modo da raiz aberto interrompem a decifra com `DESTINO_ALTERADO`, sem escrever fora da raiz autorizada. Sem a opção, `decifrarContainer` se comporta como antes (compatibilidade com os testes e com o ensaio de DR), mas o teste estático B2
(`test/services/backup-decifra-chamadores.test.js`, condição B2 da aprovação da entrada 48) reprova qualquer chamador de produção que não seja o orquestrador, exige `contencao` na chamada dele,
impede que um script importe o módulo da cifra e enumera os usos de teste autorizados (um teste novo que cite a decifra precisa entrar na lista de propósito).
ENOSPC durante a gravação (baixador e decifra) falha fechado: o arquivo final não é publicado, só o temporário próprio é removido e arquivos alheios ou já publicados não são tocados; na decifra o código
de falha continua `ARQUIVO_ADULTERADO` (rótulo herdado, a corrigir em etapa própria). Limite honesto: o Node não tem operações relativas a descritor de diretório, então resta uma janela mínima entre
conferência e uso, explorável só por quem já escreve na raiz 0700 do mesmo usuário (ou o administrador); um temporário pode ficar numa pasta trocada. O compositor do executor (seção seguinte) passa a lista de áreas
protegidas, o teto de bytes e o destino local dedicado ao baixador; a ligação ao processo real continua pendente.

**Chaves (D-F5).** MAC e KEK são segredos independentes de 32 bytes ou mais, em famílias, ids e objetos distintos (RC-4). Caminho de operação: `backup-fontes-kms-pre-resolvido`
decifra UMA vez, antes de começar, cada blob (chave KMS fixada pelo ARN da ficha e contexto de criptografia com ambiente, finalidade e id; valor de verificação conferido) e entrega
as famílias pelo contrato síncrono já existente; o host nunca cifra nem gera chave; tudo ou nada; zerar é melhor esforço. Caminho de recuperação:
`backup-fontes-recuperacao-offline` monta as mesmas famílias a partir das partes de custódia, sem KMS e sem rede. Os identificadores propostos para as listas de provedores
(`aws-kms-pre-resolvido-v1`, `recuperacao-offline-v1`) NÃO foram incluídos em nenhuma lista.

**Custódia XOR 2 de 3 (`backup-custodia-xor`).** Seja S o segredo; a e b aleatórios independentes; c = S xor a xor b. Os custodiantes 1, 2 e 3 recebem (a,b), (b,c) e (c,a).
Reconstrução: quaisquer dois custodiantes juntos têm as três partes e S = a xor b xor c. Limite de conhecimento: para cada segredo, os pares (a,b), (a,c) e (b,c) percorrem
exatamente uma vez todos os pares possíveis, logo o que um custodiante vê não depende de S (sigilo perfeito); dado qualquer par visível, todos os segredos são compatíveis, cada um
com uma terceira parte. Não é Shamir: cada custodiante guarda 2/3 do volume. A propriedade é testada por enumeração (todas as 65536 visões de 1 byte, nas três formas). Cada parte
traz verificação própria contra erro de transcrição e cada pacote traz o valor de verificação do segredo (SHA-256 de domínio, id e segredo; não é segredo).

**Procedimento verificável de recuperação off-line (ensaio periódico, RC-6).** (1) máquina limpa e sem rede, código do commit fixado e hash conferido; (2) dois custodiantes
apresentam seus pacotes; (3) reconstruir MAC e KEK e conferir os valores de verificação contra o registro de custódia; (4) com as chaves reconstruídas, verificar o MAC do envelope,
decifrar um contêiner sintético e comparar hashes; (5) registrar resultado, tempo e identificadores, sem segredo. A geração das partes e a leitura pelo terminal (cerimônia) NÃO estão
implementadas: tratam segredo real e dependem de autorização própria. Nenhum blob operacional deve ser criado antes de este ensaio ser provado.

**Três cenários de perda.** Chave KMS perdida ou desabilitada com bucket intacto: partes off-line e restauração por versão. Host perdido: blobs no bucket e restauração em host novo.
Conta AWS perdida: somente uma réplica de contêineres cifrados FORA da conta, mais as partes off-line (exigência de produção; em homologação o risco precisa de aceite escrito).

**Critérios T2 (AWS isolada, dados sintéticos, feito pela equipe AWS):** segunda gravação do mesmo nome recusada; gravação sem a condição recusada pela política (ou a regra de
versão do recibo adotada por decisão); operações proibidas ao publicador negadas (apagar objeto e versão, retenção e bypass, política, ciclo de vida, versionamento do bucket,
exclusão e desabilitação de chave); outro IP e outra conta negados; contexto de criptografia trocado negado; retenção presente e correta em cada versão; versão extra injetada pelo
administrador acusada pelo verificador; tentativas negadas registradas no CloudTrail; formato real do identificador de versão conferido. **T3 (ambiente novo, credenciais só de
leitura):** chave KMS desabilitada com restauração off-line por dois de três custodiantes; host perdido; conta perdida com réplica; negativos (objeto adulterado, parte errada, chave
revogada, versão ausente com resultado parcial); rotação v1 para v2 com restauração de backup antigo. Aceite comum: resultado recuperado, hashes e contagens iguais, evidência com RPO
e RTO. Os limites de RPO e RTO NÃO estão fixados (decisão pendente).

**Riscos residuais.** Host comprometido expõe as chaves em uso e as credenciais do publicador (o Object Lock protege o que já existe, não impede objetos novos forjados, daí a
verificação independente); zerar buffers em JavaScript é melhor esforço; a política condicional e o formato real da versão dependem da AWS (T2); um destino local parcial da
restauração permanece para análise; a cadeia do SDK será revisada no gate DEP-2; o procedimento de partes depende de pessoas. Pendências de decisão: D-F6 (retenção e DPO), D-F7 (TLS),
D-F13, RPO e RTO, cerimônia de custódia, preenchimento real das listas, ligação do executor ao processo real (produção do pacote e restaurador do banco), estratégia de credenciais da AWS e custódia dos recibos consolidados.

**Guarda P2.** Em 05/11/2026 Ramires aprovou documentalmente a entrada 47 (adendo, ref. `GATE-P2-2026-11-05-F1`: contenção opcional em `decifrarContainer`; o texto e o mapa de sinais da entrada 47 não
mudam; módulo de SHA-256 `50f1bdafb80eb6652b45eaca1ed35a27c21ab806eb30be7a6992479a1fe4f48c`) e a entrada 48 (ref. `GATE-P2-2026-11-05-G`, `src/services/backup-baixador-duravel.service.js`, SHA-256
`111da4773726e94c9cbb7ae06187151c0c184d5814c4e37ef4d7e7fdf7f13e98`: mkdir 1, link 1, O_CREAT 1, O_WRONLY 1; remoção: rm 1). As duas estão registradas em `APROVACOES` com o SHA-256 do documento
(`test/backup-guarda/aprovacoes/`); a aprovação histórica F e as propostas anteriores ficam intactas. A aprovação vale só para esses arquivos e esses mapas de sinais: qualquer alteração exige nova decisão.
As condições B1 (a restauração usa só `restaurarContainerDoDestinoDuravel`), B2 (bloqueio estático acima) e B3 (áreas protegidas, teto de bytes e destino local dedicado) são impostas pelo compositor do
executor e pelos testes da seção seguinte. Os demais módulos novos não têm sinais de escrita ou remoção. A guarda é validação léxica do repositório: passar nela não prova isolamento operacional efetivo.

### Executor operacional do backup (D-ORF-6, rodada consolidada 1/3) — implementado localmente, NÃO ativado

Estado: o executor existe como biblioteca com portas injetáveis, modos, portões, coordenação, evidência e monitoramento. Nada contata a AWS, o SDK não está instalado (DEP-2), as listas reais continuam vazias,
`OPERACAO_HABILITADA` (constante única em `backup-executor-politica`) é falsa e nenhuma unidade systemd foi instalada. A ligação ao processo real (produção do pacote por `criarBackupDeProducao`, restaurador do
banco novo, clientes AWS e fontes de chaves) NÃO existe: sem ela o CLI devolve BLOQUEADO com o motivo `LIGACAO_OPERACIONAL_AUSENTE`.

**Módulos.** `backup-executor-politica` (portões, puro), `backup-executor-evidencia` (linha NDJSON canônica com SHA-256, puro), `backup-executor-publicacao` (estágio: destino local, cifra, inventário, pré-voo, envio,
consolidação, confirmação, verificação), `backup-executor-recuperacao` (estágio: destino local, baixar e decifrar pelo orquestrador existente — B1 —, verificar o pacote L2, restaurar as fontes, avaliar o DR),
`backup-executor-operacional` (compositor), `backup-executor-monitoramento` (puro), `backup-aws-sdk-carregador` e `backup-aws-portas` (adaptadores do SDK da AWS por injeção) e `scripts/backup-operar.js` (quatro
modos). Os modelos de unidade estão em `backend/ops/systemd/*.modelo`, inertes. Testes: `backup-executor-*`, `backup-aws-*`, `backup-operar-execucao-cli`, `systemd-modelos` e
`proxy-addr-condicao-de-explorabilidade`.

**Portões** (`avaliarPortoes`, todos os motivos de uma vez, só códigos fixos): modo, ação e ambiente válidos; frase de confirmação exata por modo e ação; `OPERACAO_NAO_HABILITADA`; ensaio só em HOMOLOGACAO;
usuário diferente de root e identificado; umask com todos os bits de grupo e outros mascarados; destino durável na lista (`DESTINO_DURAVEL_NAO_APROVADO`); fonte de chaves aprovada (de teste só em NODE_ENV=test e nunca
na operação); SDK aprovado (`SDK_NAO_APROVADO`) ou simulado só em teste; destino local DEDICADO (`containers...` para o contêiner cifrado, `restauracao...` para restaurar) e autorizado pelo validador oficial;
cinco áreas protegidas distintas (imagens, fiscalização, preparações, dumps e publicados) fora do destino local (`DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA`); portas fora do papel (`PORTAS_FORA_DO_PAPEL`).

**Papéis (privilégio mínimo).** BACKUP: produção do pacote, publicador S3 e chaves de operação (o verificador só é aceito no ensaio); RESTAURACAO: restauração S3, restaurador das fontes e chaves; VERIFICACAO_DESTINO:
somente o verificador, fora do host do backup, com arquivo de ambiente e usuário próprios. Qualquer porta a mais bloqueia. Sem credencial do verificador no host do backup a verificação independente fica PENDENTE.

**Sequência e falha fechada.** BACKUP: COORDENACAO, PRODUCAO, DESTINO_LOCAL, CIFRA, INVENTARIO, PRE_VOO, ENVIO (um objeto por vez, envelope por último), CONSOLIDACAO, CONFIRMACAO, VERIFICACAO, REGISTRO_DOS_RECIBOS.
RESTAURACAO: COORDENACAO, DESTINO_LOCAL, RESTAURAR_CONTAINER, VERIFICAR_PACOTE, RESTAURAR_FONTES, AVALIAR_DR. A coordenação exclusiva (cadeados de sessão do P10) é tomada depois dos portões e liberada sempre. Estados:
CONCLUIDO, BLOQUEADO (portão), RECUSADO (nada foi feito), FALHOU e INCERTO (pode ter gravado: decisão humana). Nada é apagado nem repetido; o contêiner local e o que já estiver no bucket permanecem. Sem alvos de RPO e
RTO o ensaio de DR fica NAO_AVALIADO e a pendência `RPO_E_RTO_NAO_FIXADOS` é registrada; com alvos só RECUPERADO conta, e nunca se promove `recuperavelEmProducao`.

**Evidência.** Uma linha NDJSON por execução, chaves ordenadas, com SHA-256 próprio: tipo, operação, modo, ação, ambiente, destino, instantes, estado, código, etapa que falhou, bloqueios, etapas com duração,
conjunto, SHA-256 do manifesto e do consolidado, contagens, origens das chaves e do destino, verificação independente e pendências T2/T3. Nunca leva caminho, URL, texto de erro ou segredo; `duravelmenteArmazenado` e
`recuperavelEmProducao` são sempre falsos e `operacional` só existe numa operação concluída com chaves e destino operacionais. A evidência é entregue a uma porta (`evidencia.registrar`), inclusive nos bloqueios; o
destino durável do histórico depende de D-F13. Os recibos consolidados (bytes canônicos e SHA-256) vão a outra porta (`recibos.registrar`) e são o documento que a restauração e a verificação exigem: sua custódia fora do host é
decisão pendente.

**CLI.** `--verificar`, `--ensaio`, `--operar --acao=<backup|restauracao|verificacao-destino> --ambiente --destino --confirmo` e `--monitorar --evidencias --ambiente --limite-backup-horas --limite-verificacao-horas`
(opcionais: `--modo`, `--limite-falhas`, `--limite-ensaio-dr-dias`, `--json`). Ensaio e operação imprimem UMA linha de evidência no stdout. Saídas: 0 ok, 1 falha, 2 argumentos, 3 infraestrutura pendente, 4 bloqueado,
5 recusado, 6 incerto, 7 alerta. O monitoramento só lê (O_NOFOLLOW, limite de tamanho), recusa limites ausentes e alerta para linha ilegível, backup ausente ou atrasado, verificação independente ausente ou divergente,
execução incerta, falhas consecutivas, relógio inconsistente, bloqueio e ensaio de DR atrasado.

**Adaptadores AWS (sem chamada real).** `backup-aws-portas` implementa, sobre o SDK injetado, as portas do publicador (STS GetCallerIdentity, HeadBucket, GetBucketVersioning, GetObjectLockConfiguration,
GetBucketEncryption, GetBucketOwnershipControls, KMS DescribeKey e PutObject com `IfNoneMatch: '*'`, SHA-256 informado, tamanho e dono esperado), do verificador (ListObjectVersions e HeadObject por versão), da
restauração (GetObject por versão) e do KMS pré-resolvido (Decrypt com a chave fixada, contexto e `SYMMETRIC_DEFAULT`, zerando o buffer do SDK). Sem endpoint configurável; credencial é um provedor injetado por papel; o cliente de
gravação não faz retentativa; erros do SDK viram erro com nome do serviço e mensagem fixa. `backup-aws-sdk-carregador` só carrega o SDK depois de `VERSOES_APROVADAS` (hoje vazia) listar a versão exata dos três
clientes. Os testes usam um SDK falso em memória e provam o pedido montado, não a AWS.

**DEP-2 (gate).** Candidatos: `@aws-sdk/client-s3`, `@aws-sdk/client-kms` e `@aws-sdk/client-sts` em versão exata, sem scripts de instalação, licença Apache-2.0, Node >= 20 (compatível com Node 22), CommonJS (`main` em
`dist-cjs`), 24 pacotes transitivos. O dossiê com versões, integridade, mudança prevista no lockfile, riscos e critérios de aprovação está em `documentos/` (rodada consolidada 1/3). Instalar exige entradas de dependência na
guarda P2 (regra G6: `@aws-sdk/*` precisa de classificação `ARMAZENAMENTO_REVISADO` aprovada) e a aprovação das versões no carregador. Nada foi instalado nem alterado em `package.json` ou no lockfile.

**Retenção e agendamento.** A retenção mínima do destino está na ficha (Object Lock, modo e dias); a expiração por ciclo de vida é configurada pela equipe AWS em T2, com prazo não inferior ao bloqueio, e depende de D-F6.
Localmente a limpeza continua desabilitada e `planejarRetencao` só planeja. Agendamento e monitoramento têm modelos inertes de systemd (backup, verificação independente fora do host e monitoramento sem rede), com
condição de arquivo-chave, usuário próprio, umask 077 e sistema de arquivos somente leitura; o teste confere que cada ExecStart preenchido é aceito pelo CLI.

**Vulnerabilidades de dependências.** O alerta crítico do `proxy-addr` (falsificação de IP com `trust proxy` em sub-rede) não é explorável: o SafeWork só aceita `false` ou um número de saltos, e os testes
`proxy-addr-condicao-de-explorabilidade` impedem abrir essa configuração. A correção definitiva (atualização do lockfile) e os demais alertas (altos: body-parser, brace-expansion, zod; moderados) ficam para o gate de
dependências, sem `npm audit fix`.

**Critérios de homologação adicionados.** T1.5 (depois do DEP-2): instanciar os clientes reais com um manipulador de requisição sem rede e conferir o pedido serializado de cada porta (cabeçalhos de condição,
checksum, dono, versão); T2/T3 como acima, executados pelo CLI em ensaio (HOMOLOGACAO, dados sintéticos); aceite do monitoramento: alerta disparado com backup atrasado, sem verificação, divergência e linha adulterada.

### Ligação local do executor (D-ORF-6, L1, Blocos A e B) — implementado localmente, NÃO ativado

Estado (06/11/2026, PR #91): a ligação local do executor existe como contratos e adaptadores por injeção. Continua valendo tudo da seção anterior: `OPERACAO_HABILITADA` é falsa e única na política,
nada contata a AWS, o SDK não está instalado (DEP-2) e nenhuma unidade systemd foi instalada. O que mudou: a ligação ao processo real deixou de ser inexistente e passou a ter adaptadores locais
provados com composições falsas e reais em teste, sem execução operacional. Arquivos: `backend/src/config/database-tls.js`, `backend/src/services/backup-executor-{credenciais,auditoria,ligacao,producao-l2,restaurador-l2}.service.js`
e ajustes em `imagem-backup-host-postgres`, nos dois lançadores (`pgdump-lancador`, `restauracao-lancador`), na composição de produção, em `config/database.js`, `scripts/migrate.js` e `db/guarda-inicializacao.js`.

**D-F7 (TLS do banco), implementado como opt-in.** `DB_SSL_MODE=verify-full` (e `DB_SSL_ROOT_CERT` opcional) liga TLS com verificação de cadeia e nome no pool da API, no `migrate` e na guarda de
inicialização; ausente, nada muda (o driver segue lendo `PGSSLMODE`). Só `verify-full` é aceito; modo fraco, certificado inseguro, socket Unix ou `PGSSLMODE` conflitante reprovam com código fixo e a guarda
não sobe a API. Para `pg_dump` e `pg_restore` o par `PGSSLMODE=verify-full`/`PGSSLROOTCERT` é aceito inteiro ou nunca, só com host TCP e certificado seguro; a composição o injeta pelo wrapper `comTls`
(provisório: os serviços `imagem-backup-pgdump` e `imagem-backup-restauracao-banco`, que montam o ambiente, não foram alterados). A obrigatoriedade de TLS em produção NÃO está implementada: depende da topologia.

**D-F13 (auditoria), implementado sem migration.** O registro primário continua sendo a linha de evidência no stdout do CLI. `backup-executor-auditoria` relê e confere a linha e grava UM evento `SISTEMA`
em `logs_auditoria_plataforma` pelo `registrarEventoSistema` existente, com contexto de 15 chaves fixas e não sensíveis (identificadores, estado, códigos, contagens e o SHA-256 da evidência). Nunca lança: falha de
auditoria não mascara o desfecho. Provado em PostgreSQL 16 efêmero local (06/11/2026, 16/16): eventos aceitos, as 15 chaves aceitas, dez recusas de chave sensível, append-only e schema `public` intocado. No CI a
suíte `d-orf-6-l1-auditoria-trigger.integration.js` é ignorada (`TRG_SO_NA_INSTANCIA_EFEMERA_LOCAL`); só roda com `SWB_PGDATA` declarado.

**Credenciais e ligação.** `backup-executor-credenciais` entrega, por papel (PUBLICADOR, VERIFICADOR, RESTAURACAO), o que um fornecedor injetado devolve, com segredo e token não enumeráveis, recusa de papel
trocado, expiração e formato, e separação de `accessKeyId` entre papéis; a fonte real (arquivo, STS, Roles Anywhere) e o papel da porta KMS são decisão H9-a. `backup-executor-ligacao` monta as portas AWS por
papel, o KMS e a auditoria, sem processo, ambiente ou rede. `backup-executor-producao-l2` e `backup-executor-restaurador-l2` ligam as portas `producao` e `restaurador` às composições aprovadas
(`criarBackupDeProducao`, `criarRestauracaoDeProducao`), reutilizando a supervisão existente (D-LIG-1) sem escritor nem processo novo; a guarda P2 continua verde sem entrada nova. A leitura autenticada do
manifesto (`lerPacote`) é injetada e a versão real não existe.

**PENDENCIA-SEG-TRG04 (segurança; bloqueia a produção, não a integração).** A função `logs_auditoria_chave_json_e_sensivel` (migration 014, compartilhada pelas três trilhas de auditoria) reconhece chaves por
segmentos do nome, não por substring: nomes compostos SEM separador e sem fronteira camelCase não são bloqueados (`PGPASSWORD`, `DBPASSWORD`, `ACCESSTOKEN`, `CLIENTSECRET` confirmados aceitos em banco real). Não é
comportamento seguro e NÃO foi corrigido: o trigger e a migration 014 permanecem intactos; o teste `TRG-04L` só caracteriza a limitação e deve ser invertido quando ela for tratada. Tratamento, em etapa própria e antes
da produção: nova migration com `CREATE OR REPLACE FUNCTION` (regra adicional por sufixo de segmento, preservando `secretaria_id`, `hashtag`, `hash_arquivo`), testes RED→GREEN em schema temporário, varredura dos
escritores, `migrations/checksums.json`, contagens de migrations e dicionário de dados (`docs/sistema/dicionario-de-dados.md` ainda não existe). A defesa primária continua sendo gravar só campos explícitos.

**O que continua bloqueando a produção.** DEP-2 (SDK real e `VERSOES_APROVADAS`), fonte real de credenciais e papel do KMS (H9-a), TLS obrigatório por ambiente, `lerPacote` real, dump e restauração reais
pelo executor, ajuste definitivo do `comTls`, PENDENCIA-SEG-TRG04, RPO e RTO, cerimônia de custódia e listas reais. Evidências locais (PostgreSQL efêmero, 14 arquivos com SHA-256) ficam fora do Git, em
`~/SafeWorkDados/d-orf-6-l1-bloco-b-evidencias-20261106`.

### Documentos especializados existentes — fonte única

Consultar [os caminhos das fontes únicas](fontes-especializadas.md), sem cópias paralelas. A
publicação utiliza somente pacote aprovado/allowlist, com CSP do servidor estático,
origens separadas, cache e requisitos da versão. A Biblioteca Padrão de Imagens
tem procedimento próprio de provisionamento, verificação e recuperação. Não
substituir esses procedimentos por resumo. Fontes originais permanecem no projeto.

## Contratos gerais preservados

### Origem CLAUDE §57 — linha 1193

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 57. Banco de produção

Nunca presumir que existe autorização para executar alteração no banco de produção.

Criar migration e executar migration são autorizações diferentes.

Testar SQL localmente não autoriza aplicação em produção.

---


## S63-086 — origem CLAUDE.md:1614–1620

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **Código (J2a):** `config/token-monitoramento.js` (heartbeat 60 s ±10 %; OFFLINE a partir de 180 s de silêncio, limiar inclusivo; confirmação 90 s; janela mínima de escrita 45 s; prazo máximo da suspeita 300 s), `services/token-monitoramento.service.js` (`derivarEstado` pura: `REVOGADO | NAO_ATIVADO | SEM_COMUNICACAO | ONLINE | OFFLINE`; `registrarContato` pela batida; `verificarComunicacao` = passagem única do job, com relógio e sonda injetados), `repositories/token-monitoramento.repository.js` e `token-dispositivo-evento.repository.js`, `routes/token-heartbeat.routes.js` + controller + schema (`POST /api/atendimento-token/tablet/heartbeat`, cookie do tablet, corpo e query vazios; **[SUPERADO — R06] Registro anterior: montagem superada pelo Ciclo 2 (S63-092); situação do runtime atual não verificada. NÃO montada em `app.js`** — montagem é etapa própria, X2/P-01), `security/autoridade-job-interno.js`, `utils/sonda-publica.js`, `scripts/verificar-comunicacao-token.js` (`npm run token:verificar-comunicacao`; saídas 0 passagem concluída, 1 configuração/autoridade inválida ou falha, 2 sonda reprovada ou inconclusiva, 3 banco indisponível; `TOKEN_JOB_DB_SCHEMA` opcional, padrão `public`, [SUPERADO — R06: P-06 resolvido no Ciclo 2] ainda ausente do `.env.example`, P-06). A QUEDA é confirmada só pelo job, numa passagem posterior à primeira observação (`queda_suspeita_desde`, `089`); o RESTABELECIMENTO é feito pela batida; nunca timer na API.
- **Autoridade mínima do job:** o job atravessa empresas, então o limite real é a CREDENCIAL DO BANCO: credencial própria (`TOKEN_JOB_DB_USER`/`TOKEN_JOB_DB_PASSWORD`, nunca a da API), lida só pelo script; só opera depois de o próprio banco confirmar quem está conectado e os privilégios EFETIVOS contra a lista positiva por coluna `OBJETOS_PERMITIDOS` (`empresas(id, ativo)` leitura; `token_dispositivos` leitura de 7 colunas e UPDATE só de `comunicacao_registrada` e `queda_suspeita_desde`; `token_dispositivo_eventos` INSERT de 5 colunas e SELECT de `id`), recusando papel privilegiado, pertencimento a outros papéis, CREATE no banco ou em schema do caminho de busca, objeto fora do schema, privilégio faltando ou sobrando, relação temporária na sessão ou objeto resolvido para tabela temporária (`SQL_CAMINHO` corrigido na Fase B para excluir `pg_my_temp_schema()`; teste `token-j/job-monitoramento-sql-caminho.test.js`); mensagens só com nomes, nunca valores. `TOKEN_SONDA_URL_PUBLICA` sem valor (P-03).
- **Infraestrutura de teste:** cluster PostgreSQL DEDICADO criado pelo responsável (`[FONTE_PRIVADA]`, `[ENDERECO_LOCAL_DOCUMENTADO]`, papel `[IDENTIDADE_LOCAL_PRIVADA]`; não é serviço, morre no reinício do Mac); guarda D1 (`test/integracao/helpers/guarda-instancia-dedicada.js`, `test/integracao/exigir-instancia-dedicada.js`, `test/token-j/guarda-d1.test.js`: as suítes J2a só rodam contra a instância dedicada); Marcos 1, 2 (Camada B), 3A e 3B ("RED INTEGRADO VÁLIDO", documento 19); 16 testes de contagem ajustados 88→89 (`J-REGISTRO-TESTES-CONGELADOS.md`, R3-001); suíte `test/token-j` com 132 testes (130 PASS, 2 TODO: DEP-U01 e DEP-U02).
- **Homologação real da role mínima (Fase 4B):** rodada `a741c814064460f9` REPROVADA (D1: 42P08 em `INSERT … CASE WHEN $6 THEN $3 END` sem tipo; D2: `$2` indefinido sob `set -u` no `rodada.sh`) e recuperação R3; D1 provada em PostgreSQL 16 temporário; aplicação D1/D2 (G1 ensaio em réplica, G2 real); guarda do wrapper (trava `mkdir` atômica de execução única); rodada `957fad794d3a5b36` REPROVADA só em "testar sombreamento" (a autoridade devolvia `SCHEMA_COM_CREATE` em vez de `OBJETO_TEMPORARIO`), contraprova C1–C4 e Fase B (autoridade `afff8311…` → `184c8bcb…`, backup `[FONTE_PRIVADA]`, wrapper g3 com 8 pinos); **rodada `697af3a405965adc` (wrapper g3, 14/10/2026) APROVADA: 38 PASS, 0 FAIL, 0 SKIP, 2 INFORMATIVOS** (não contados como PASS: `faltando-usage-schema` e `sequencia-evento-usage-select` — a autoridade tolera `USAGE`/`SELECT` na sequência do evento; decisão pendente do responsável), limpeza com código 0 (role e schema ausentes, fotografia antes = depois `fc7c0c3a…`), instância compartilhada intacta, trava g3 criada (nova rodada exige novo wrapper e decisão). Dos 38 PASS, 13 são portões de restauração; 25 são verificações substantivas.
- **Auditoria independente:** workflow `wf_b2bfa75a-117` (14/10/2026, 22:29–22:56, só leitura, cinco agentes, sem conexão ao PostgreSQL): **CONCLUÍDA, APROVADA com observações**, sem divergência bloqueante; resultado incorporado ao termo (§9), ao manifesto (I-01/I-02) e ao checkpoint (§8). O manifesto lista as evidências com SHA-256 (classe P, persistentes, e classe C, cópias preservadas em `evidencias-preservadas/01…08`), reverificável por `verificar-manifesto-bloco-i.sh` (só leitura).
- **Status documental em 15/10/2026:** resultado técnico **GREEN J2a (Fase 4B) APROVADO**; auditoria concluída; encerramento documental **PREPARADO e reconciliado**, aguardando (a) a revisão da V7 e (b) a decisão do responsável nas caixas do termo §10 (aceite; desvios procedurais dos auditores; tolerância `USAGE`/`SELECT`; ajustes). **A aprovação é restrita ao ambiente dedicado e NÃO é liberação para produção.** Não fazem parte do encerramento: Git, congelamento de baseline, Etapa I, Etapa J inteira e Etapa K. Divergência registrada: o manifesto (gerado em 14/10 às 22:48) pina `helpers/token-j.js` em `2131e49f…` (D-21), mas a correção da CI `18e7296` (15/10) alterou esse arquivo (`cbea6c81…`); os demais pinos conferidos (autoridade `184c8bcb…`, guarda D1, `exigir-instancia-dedicada.js`, teste novo `49d350b4…`) estão íntegros — regenerar o manifesto só com autorização. O termo registra um `git status --short` de leitura executado por engano em 14/10 às 21:40, já comunicado.
- **PR #57 e CI (15/10/2026):** a integração à `main` e a correção `18e7296` estão na nota de 15/10/2026 em "Entrega Git do Bloco 12": três suítes J2a exigiam o sentinela da guarda D1; a prova alternativa de instância efêmera do GitHub Actions (marcador por execução + nonce no comentário do banco, variáveis `PG*`/`DATABASE_URL`/`NODE_OPTIONS` proibidas, só runner `github-hosted`) vale só na CI; fora dela a guarda D1 continua obrigatória. **Testes aprovados ≠ implantação em produção:** o job não tem role real, agendador, valor de sonda nem rota montada (P-01 a P-04).


## Aplicação e dependências

Consulte [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md).
Não executar procedimentos por constarem nesta proposta.

## MEM-26 — decisão histórica de hospedagem Lightsail

Registro de decisão de hospedagem: AWS, com Amazon Lightsail como opção inicial;
outros provedores haviam sido descartados. API prevista em /api na origem da
aplicação. Orçamento histórico desejado de US$30/mês, margem avaliável até US$40;
exceder limite depende de decisão. Não reduzir segurança/backup para economizar;
avaliar custo recorrente após créditos e criptografia antes de contratação.
Preços, regras promocionais, plano de banco, prazo de deploy e topologia são
informações históricas não revalidadas, não estados atuais. Domínio real e custódia
local não são publicados. Decisão não autoriza DNS, contratar, migrar, reiniciar
ou implantar; frente/equipe AWS mantém responsabilidade e autorização próprias.
Mudança de provedor ou arquitetura não ocorre por iniciativa do agente documental.

## Endereço de escuta da API (`BIND_ADDRESS`)

`BIND_ADDRESS` é opcional e aceita somente um endereço IP literal (IPv4 ou IPv6), sem porta, colchetes, nome de host nem escopo (`%`). Ausente ou vazia, a
API mantém o comportamento anterior e escuta em todas as interfaces da porta `PORT`. Valor inválido impede a subida, sem eco do valor. Atrás de um proxy
reverso local (Nginx) a API deve escutar só em `127.0.0.1`: sem isso, quem alcançar a porta da API fala direto com ela e o `X-Forwarded-For` que enviar
passa a valer como IP do cliente sob `TRUST_PROXY_HOPS=1`, anulando o limitador por IP e contaminando a auditoria. A variável é defesa em profundidade e
não substitui o firewall do provedor.

Publicação, só com autorização própria: publicar a versão do backend que contém `BIND_ADDRESS`; conferir que o `proxy_pass` do Nginx usa
`http://127.0.0.1:<porta>` (e não um nome que possa resolver para `::1`); definir `BIND_ADDRESS=127.0.0.1` no ambiente do serviço da API; reiniciar a API;
conferir a escuta em `127.0.0.1:<porta>` (`ss -ltn`), a resposta normal pelo Nginx e a recusa ou o timeout a partir de fora. Rollback: remover a variável e
reiniciar a API, ou voltar o deploy anterior; o comportamento anterior volta sem outra mudança.

## Referência operacional atual

R06 comprova documentalmente a montagem do heartbeat no Ciclo 2 e resolução de
P-06 na referência histórica correspondente. Não prova serviço hoje ativo nem
homologação. A coluna de 089 é pré-condição do contato; aplicação em banco requer
autorização própria. Não executar receita J2a só porque está descrita.
