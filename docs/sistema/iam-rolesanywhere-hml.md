# IAM Roles Anywhere — agente CD da HML

## Objetivo

Registrar o desenho aprovado para autenticar o agente Linux de publicação da HML por
IAM Roles Anywhere e aplicar o perímetro IPv4 no serviço que recebe as chamadas do
agente (Amazon S3).

## Trust policy do papel do agente

O papel `safework-hml-cd-agente` confia no principal de serviço
`rolesanywhere.amazonaws.com`. A trust policy limita a emissão da sessão temporária
aos certificados cujo Subject CN seja `safework-hml-cd-agente` e ao Trust Anchor
específico da CA da HML.

O modelo versionado está em
`deploy/hml/cd/iam-rolesanywhere-agente.modelo.json`. Substituir
`TRUST_ANCHOR_ARN` pelo ARN completo do Trust Anchor da conta/região de destino
antes de qualquer aplicação.

**Não incluir `aws:SourceIp` na trust policy do IAM Roles Anywhere.** A tentativa
operacional anterior manteve `aws:SourceIp` mesmo após corrigir o endereço para o
IPv4 público da instância e continuou recebendo `AccessDenied` em
`CreateSession`. A correção validada foi retirar exclusivamente essa condição,
preservando o principal de serviço, as três ações STS, o CN X.509 e o
`aws:SourceArn` do Trust Anchor.

Esse desenho acompanha o exemplo de trust policy da documentação oficial do IAM
Roles Anywhere, que restringe a confiança por atributos X.509 e pelo ARN do Trust
Anchor:
https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html

## Restrição de origem das chamadas S3

A restrição por IP é aplicada na bucket policy, onde `aws:SourceIp` representa a
origem da chamada ao S3 feita com a sessão temporária do agente.

O modelo `deploy/hml/cd/s3-politica.modelo.json` contém o statement
`NegarAgenteForaDoIPv4`, que nega `s3:*` somente quando todas estas condições
coincidem:

- `aws:PrincipalArn` é o papel `safework-hml-cd-agente`;
- `aws:SourceIp` não corresponde ao IPv4 público autorizado;
- `aws:ViaAWSService` é `false`.

Substituir `CONTA`, `BUCKET` e `IPV4_PUBLICO_AGENTE` por valores verificados no
ambiente. Para a HML observada nesta etapa, o IPv4 público autorizado é
`107.21.230.126/32`. O IP deve permanecer estático e associado à instância.

O statement não amplia permissões Allow: ele acrescenta uma negação explícita para
o papel do agente fora do endereço aprovado. Os demais controles de TLS, escrita
condicional e SSE-S3 AES256 permanecem.

**Limite IPv4:** este modelo autoriza somente o IPv4 indicado. Se a saída S3 passar
a usar IPv6, a chamada será negada; qualquer mudança de perímetro deve ser analisada
e aprovada separadamente, sem remover o controle de origem.

## Separação de papéis

- O publicador GitHub Actions continua usando OIDC e o modelo
  `iam-confianca.modelo.json`; ele não é o papel IAM Roles Anywhere do agente.
- O agente usa o papel `safework-hml-cd-agente` e a política S3 restrita.
- A trust policy do agente não concede permissões S3; as permissões de identidade
  continuam no modelo `iam-agente.modelo.json` e na boundary aplicável.
- A política de bucket não concede permissões ao agente; somente impõe uma negação
  por perímetro de origem.

## Validação e implantação

Os testes automatizados verificam a estrutura JSON, a ausência de `aws:SourceIp`
na trust policy Roles Anywhere e a presença do Deny S3 limitado ao ARN do agente e
ao IPv4 configurado.

Os modelos são inertes. Esta documentação e os testes **não aplicam alterações na
AWS**, não substituem a leitura da trust policy/bucket policy reais e não comprovam
uma nova sessão. A implantação exige revisão dos placeholders, comparação com as
políticas atuais, autorização operacional específica e verificação posterior no
CloudTrail e no S3.
