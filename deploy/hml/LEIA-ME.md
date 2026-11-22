# deploy/hml

Componentes locais do CD de homologação, com workflow manual e aprovação protegida.
Nenhum agente foi instalado ou aplicado em servidor por esta entrega. O contrato
atual está em `docs/sistema/publicacao-homologacao-automacao.md`; o histórico do
desenho e os contratos do instalador ficam em `publicacao-homologacao-componentes.md`.

Etapa 52: `cd/` contém o protocolo, publicador OIDC/S3, agente Linux e modelos inertes
de configuração/IAM. O job protegido está preparado e desativado. Contrato e ativação:
`docs/sistema/publicacao-homologacao-automacao.md`. O agente recusa uso antes da revisão
de raízes exclusivas da homologação, sem vínculo com o site institucional.

Etapa 53A: recusas comprovadas antes de chamar o instalador são terminais e liberam
a fila somente após registro durável. Estado crítico, registro pendente/ilegível ou
resultado incerto preservam a trava. `--pedido` é operacional e pode instalar uma
release; não é um comando de inspeção somente de leitura.

| Pasta ou arquivo | Função |
|---|---|
| `empacotar-backend.js`, `allowlist-backend.json` | pacote e release do backend |
| `cd/agente-backend.js`, `cd/agente.config.backend.exemplo.json` | agente do escopo backend, separado e inerte (`habilitado: false`); o instalador segue recusando o backend (`COORDENACAO_NAO_HOMOLOGADA`) |
| `cd/iam-confianca-backend.modelo.json`, `cd/iam-publicador-backend.modelo.json`, `cd/iam-agente-backend.modelo.json`, `cd/s3-politica-backend.modelo.json` | modelos inertes de IAM e S3 só para `hml-backend/`, com marcadores `CONTA` e `BUCKET` |
| `cd/precondicao-migrations.js` | verificador puro de pré-condições de migrations (laudo selado; nunca opera o banco nem restaura) |
| `cd/lancador-credenciais-backend.js` | Etapa 4C (D-H3): lançador do agente do backend com credenciais temporárias do IAM Roles Anywhere (`aws_signing_helper credential-process`), sem gravar nem exibir credenciais |
| `cd/safework-cd-backend.service.modelo`, `cd/safework-cd-backend.timer.modelo`, `cd/iam-confianca-rolesanywhere-backend.modelo.json`, `cd/rolesanywhere-perfil-backend.modelo.json` | Etapa 4C (D-H3): modelos inertes da unidade, do timer, da confiança do papel e do perfil do Roles Anywhere do agente do backend |
| `cd/safework-hml-91-cd-backend.conf.modelo`, `cd/gravar-identidade-do-servico.modelo`, `cd/polkit-safework-cd-backend.rules.modelo` | Etapa 4C (D-H2): modelos inertes do drop-in do serviço (link estável e identidade em `/run`), do gravador da identidade e da regra polkit restrita a `restart` de `safework-hml.service` |
| `contratos-persistentes.json` | versões de contratos de dados (vazio: nenhum homologado) |
| `instalador/` | instalador de releases (`instalar-release.js`, `nucleo.js`, `ancora.js`, `erros.js`, `compatibilidade.js`, `coordenacao.js`) e a adoção da primeira release do backend (`adotar-backend.js`, Etapa 4C D-H1); copiável sozinho para o servidor |
| `verificacao/` | verificação pós-publicação por GET |
| `csp/` | gerador de CSP por perfil |
| `nginx/` | modelos Nginx e renderizador validado |

Regras de uso do instalador: rodar como o usuário de implantação (nunca root), com
configuração própria desse usuário e sem permissão de escrita para grupo ou outros, e
informar sempre o hash aprovado do `release.json` (`--release-sha256`). O instalador exige Linux (âncoras por descritor em `/proc/self/fd`): fora dele recusa instalar, reverter e reconciliar. O backend segue bloqueado na linha de comando para `instalar` e `reverter` enquanto não houver coordenação homologada com o D-ORF-6.

Os testes ficam em `.github/scripts/hml/test/` e rodam no passo de homologação do
`ci.yml`:

```bash
node --test ".github/scripts/hml/test/*.test.js"
```
