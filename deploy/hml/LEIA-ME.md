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
| `contratos-persistentes.json` | versões de contratos de dados (vazio: nenhum homologado) |
| `instalador/` | instalador de releases (`instalar-release.js`, `nucleo.js`, `ancora.js`, `erros.js`, `compatibilidade.js`, `coordenacao.js`); copiável sozinho para o servidor |
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
