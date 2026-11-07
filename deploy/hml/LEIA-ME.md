# deploy/hml

Componentes locais do CD de homologação. Nada aqui é executado automaticamente e
nada foi instalado ou aplicado em servidor. A explicação completa, o desenho do futuro
job e as pendências estão em `docs/sistema/publicacao-homologacao-componentes.md`.

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
