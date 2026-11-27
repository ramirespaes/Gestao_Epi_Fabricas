# Backup simplificado — E2-R: referências derivadas do dump

Gera as referências banco↔arquivos (NDJSON) **somente a partir do `banco.dump`** de uma execução do E1 e as vincula, por SHA-256, ao dump e ao manifesto do E2.
Não abre conexão com nenhum banco: `pg_restore --data-only --schema=public --table=<t> --file=- banco.dump` lê o arquivo e escreve o COPY da tabela em stdout, com ambiente mínimo (sem variáveis `PG*`).
Assim as referências refletem exatamente o estado lógico capturado pelo `pg_dump`, e não o banco ativo.

Complementa o E1 e o E2 (que seguem válidos); não altera o D-ORF-6 nem serviços do backend.

## Uso

```bash
# 1) Referências a partir do dump (execução do E1 íntegra)
BACKUP_REFS_DESTINO=<dir 0700> BACKUP_DB_EXEC=<execução do backup-db.sh> BACKUP_PG_BIN=<dir do pg_restore 16> \
  bash ops/backup/gerar-referencias.sh --fonte imagens --fonte fiscalizacao-pacotes

# 2) Cópia dos arquivos com as referências vinculadas ao mesmo dump
BACKUP_DESTINO=<dir 0700> BACKUP_DB_EXEC=<a MESMA execução do E1> \
  bash ops/backup/backup-arquivos.sh --fonte imagens=/abs/imagens --fonte fiscalizacao-pacotes=/abs/fiscalizacao \
  --referencias-dir <diretório gerado no passo 1>
```

Saída do gerador: `<destino>/<run_id>/` com `refs-<fonte>.ndjson`, `REFERENCIAS-META.json` (+ `.sha256`) e `registro.log`; em falha, `FALHA-<run_id>/falha.json`. A pasta `.em-andamento-<run_id>` só permanece depois do fim do script nas situações de "Exceções de publicação" ou numa interrupção abrupta.
Códigos: 0 ok; 2 configuração, banco ou fonte; 3 destino (inexistente, fora de 0700, sincronizado ou `run_id` já existente: `E_RUN_ID_EXISTENTE`); 4 ferramenta; 5 extração, tabela ausente ou dados inválidos, ou `E_PUBLICACAO_LOCAL` (falha operacional ao publicar o pacote já gerado).
`node ops/backup/lib/referencias.js verificar <dir> [--banco-exec <execução do E1>]` revalida o pacote.

### Exceções de publicação

`gerar-referencias.sh` publica como descrito em `README.md` ("Publicação da execução"): reserva o nome final com `mkdir` e o troca por `rename`, sem sobrescrever nem aninhar. Distingo a **falha original** (por exemplo `E_TABELA_AUSENTE`, `E_EXTRACAO_FALHOU`) da **falha de publicação**, que acontece depois, ao dar nome à pasta.

- **Colisão real, `E_RUN_ID_EXISTENTE`, código 3.** Já existe `<run_id>`, `FALHA-<run_id>`, `NAOPUBLICAVEL-<run_id>` ou `.em-andamento-<run_id>`. No início, nada é criado. Ao publicar o pacote gerado, o que existia fica intacto e o pacote permanece em `.em-andamento-<run_id>`; o código de saída é 3.
- **Falha operacional, `E_PUBLICACAO_LOCAL`, código 5.** Sem espaço, sem permissão ou falha do `rename`, com o nome inexistente. O pacote gerado (`refs-*.ndjson`, `REFERENCIAS-META.json` e `.sha256`) permanece em `.em-andamento-<run_id>` e nenhum dado dele é apagado.
- **Falha original seguida de falha ao publicar a falha.** O tratamento da falha já removeu `refs-*.ndjson` e a meta e gravou `falha.json`. Se a pasta não puder ser publicada como `FALHA-<run_id>` por causa operacional, imprimo `ERRO E_PUBLICACAO_LOCAL` antes e deixo `ERRO <erro original>` por último, com o código de saída original. Se a causa for colisão real, o código de saída passa a 3 e a falha original fica em `falha.json`, dentro de `.em-andamento-<run_id>`.

Uma pasta `.em-andamento-<run_id>` nunca é pacote publicado. Mesmo com os arquivos completos, não a uso como referências nem a considero válida sem rodar `referencias.js verificar` contra a execução do E1. O `registro.log` dessa pasta pode dizer `concluido`, porque a linha é escrita antes da tentativa de publicar.

## Mapeamento

| Fonte | Tabelas lidas do dump | Referência (`chave`, `sha256` do conteúdo, `tamanho_bytes`) |
|---|---|---|
| `imagens` | `imagens_padrao`, `imagens_empresa` | `padrao/<sha256>/mestre.<ext>`, `exibicao.webp` (se houver), `miniatura.webp`; `<empresa_id>/<sha256 do envio>/…` com o hash de cada variante (`sha256_mestre`, `sha256_exibicao`, `sha256_miniatura`). Linhas `INATIVA` também contam |
| `fiscalizacao-pacotes` | `fiscalizacao_pacotes` | só `status = CONCLUIDO`: `chave_armazenamento`, `sha256`, `tamanho_bytes` (a chave deve ser `<empresa_id>/pacote-<id>.zip` com o mesmo `empresa_id`) |

A fórmula da chave das imagens reproduz `chaveDe` de `backend/src/storage/armazenamento-imagens.js`; um teste compara as duas em todas as combinações.
Colunas do COPY são lidas por nome; escapes do formato texto (`\\`, `\t`, `\n`, `\r`, octal, `\x`) e `\N` (nulo) são tratados. Tabela ausente do dump é erro (`E_TABELA_AUSENTE`); tabela presente e vazia gera zero referências.
O NDJSON é determinístico (ordenado por `chave`, sem duplicatas); a mesma `chave` com conteúdo diferente é `E_REFERENCIA_CONFLITANTE`.

## Vínculo criptográfico

`REFERENCIAS-META.json` registra o `run_id`, o SHA-256 do `banco.dump` e o SHA-256 do `MANIFEST.json` do E1, mais o SHA-256 de cada NDJSON. O E2 com `--referencias-dir`:

1. confere a integridade da meta e de cada NDJSON (inclusive forma canônica e contagem);
2. exige que `run_id`, SHA-256 do dump e do manifesto sejam os da execução de banco informada em `BACKUP_DB_EXEC` (senão `E_REFERENCIAS_DE_OUTRO_DUMP`, código 2);
3. grava no manifesto do E2 `banco.dump_sha256` e, por fonte, `referencias.origem` (dump, referências, meta e `refs_run_id`).

## Mudanças no E2 (compatibilidade)

- Manifesto do E2 passa ao **esquema 2** (`banco.dump_sha256`, `referencias.vinculo`, `referencias.origem`, `consistencia.vinculo`); o esquema 1 é recusado pelo validador. Não existe manifesto de esquema 1 fora dos testes.
- Referências avulsas (`--referencias`) continuam aceitas e verificadas, mas **não vinculadas**: o resultado é `NAOPUBLICAVEL-` com bloqueio `REFERENCIAS_NAO_VINCULADAS` (código 10).
- Publicável exige: sem alteração concorrente, referências `VERIFICADO_COMPLETO` e `VINCULADO_AO_DUMP` em todas as fontes. O validador recusa manifesto que se declare publicável sem isso.
- `--referencias` e `--referencias-dir` para a mesma fonte são recusados (código 2).

## Janela de escrita `BACKUP` (somente verificação; não ativada)

O protocolo de `backend/src/utils/janela-escrita-imagens.js` é um arquivo comum, fora do armazenamento de imagens (variável `IMAGENS_JANELA_ESCRITA_ARQUIVO`), criado de forma exclusiva (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600) com uma linha JSON `{versao:1, tipo:"BACKUP", pid, hospedeiro, iniciadoEm (ISO com milissegundos), token (hex 32 a 128)}`; só o dono com o mesmo token o remove. Isso é implementável pelo backup em shell ou Node sem alterar o mecanismo, e excluiria a limpeza de órfãos entre o dump e a cópia. **Nada disso foi implementado ou ativado nesta etapa.** Sem a janela, uma limpeza concorrente pode apagar um arquivo ainda referenciado pelo dump: o E2 detecta (código 12) e a execução fica bloqueada, nunca publicada.

## Limites e pendências

- Os testes automatizados usam dados sintéticos e um `pg_restore` simulado. Num ensaio em VM Linux (PostgreSQL 16.15, dados sintéticos) executei o gerador com um `pg_restore` real, a partir de um dump real de um banco sintético com as migrations aplicadas; os registros ficam fora deste repositório e não são versionados. Isso é evidência de ensaio, **não homologação**, e não cobre dados reais, volume nem produção.
- O vínculo por SHA-256 detecta a substituição do dump entre o E1 e o E2, mas só dentro da mesma pasta: o manifesto e o `.sha256` não são assinados, então quem escreve na pasta pode alterá-los juntos (ver `README.md`).
- Sem criptografia, sem retenção, sem agendamento e com armazenamento só local (ver `README.md`).
- A suíte rodou em macOS (correções desta entrega) e, antes delas, numa VM Linux em ensaio.
