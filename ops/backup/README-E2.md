# Backup simplificado — E2: arquivos persistentes

Copia diretórios persistentes para um destino local controlado, **depois** do backup do banco (errata E-65-01: banco primeiro, arquivos depois).
Só lê as origens: nada é gravado, movido ou apagado nelas. Não envia nada à AWS e não restaura (E3 em diante).
Código independente do D-ORF-6, fora de `backend/` (portanto fora do alcance da guarda estática P1/P2 e do `npm test` do backend). Os testes rodam por um passo próprio do CI; ver `README.md`.
Limitações de segurança (sem criptografia nem assinatura, sem retenção, sem agendamento, só armazenamento local) e a distinção entre os ensaios G4/G5 e a homologação AWS, que continua pendente: ver `README.md`. Elas valem integralmente para o E2.

## Fontes persistentes (catálogo do D-ORF-6, lido sem acessar dados)

| id sugerido | Variável da aplicação | Observação |
|---|---|---|
| `imagens` | `IMAGENS_ARMAZENAMENTO_DIRETORIO` | Conteúdo imutável, endereçado por SHA-256; referências em `imagens_padrao` e `imagens_empresa` |
| `fiscalizacao-pacotes` | `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO` | ZIPs entregues; referências em `fiscalizacao_pacotes` (`chave_armazenamento`, `sha256`, `tamanho_bytes`) |
| `email-arquivo` | `EMAIL_ARQUIVO_DIRETORIO` | Só no modo arquivo; decisão D-F2 pendente (provavelmente efêmero) |

Não há diretório de anexos no código. Os caminhos reais do servidor não foram verificados nesta etapa (só dados sintéticos).

## Uso

```bash
BACKUP_DESTINO=<dir 0700> BACKUP_DB_EXEC=<dir de uma execução do backup-db.sh> \
  bash ops/backup/backup-arquivos.sh --fonte imagens=/abs/imagens --referencias imagens=/abs/refs-imagens.ndjson
```

Variáveis opcionais: `BACKUP_DB_IDADE_MAX_S` (padrão 3600), `BACKUP_TENTATIVAS` (1 a 3; padrão 3), `BACKUP_LIMITE_BYTES` (padrão 20 GiB). Ver `config/backup-arquivos.env.exemplo`.
`BACKUP_LIMITE_BYTES` aceita só inteiro decimal positivo de até 15 dígitos; qualquer outro valor (`abc`, `0`, negativo, fracionário, `1e3`) é recusado com `E_CONFIG` (código 2) antes de criar qualquer coisa, e nunca desativa o limite. Variável vazia equivale a não definida.

## Regras

1. **Banco antes dos arquivos.** `BACKUP_DB_EXEC` precisa ser uma execução do E1 íntegra (manifesto e SHA-256 conferem), com nome igual ao `run_id`, criada no máximo `BACKUP_DB_IDADE_MAX_S` segundos antes. Execução de falha ou antiga é recusada (código 2).
2. **Fingerprints.** Por fonte, F0 antes e F1 depois da cópia (caminho, tamanho, mtime em ns e inode). Se F0 ≠ F1, ou um arquivo mudar, sumir ou for trocado durante a leitura, a tentativa é instável.
3. **Até 3 tentativas.** Cada uma em `tentativas/<n>/`; nenhuma é sobrescrita nem apagada. Sem estabilização, a execução é `COM_ALTERACAO_CONCORRENTE` (código 11) e fica preservada, nunca remendada.
4. **SHA-256 individual**, calculado na leitura e recalculado no arquivo copiado. Links simbólicos e itens especiais na origem são erro fatal (`E_ANOMALIA_ORIGEM`). Isso inclui um arquivo que vire FIFO ou diretório entre a listagem e a abertura: a origem é aberta sem bloquear (`O_NONBLOCK`), o tipo é conferido com `fstat` antes de qualquer arquivo de destino ser criado e o descritor é fechado em caso de erro. A troca de um diretório intermediário por link durante a cópia continua sendo um risco residual.
5. **Referências banco↔arquivos.** A consistência só é declarada se um arquivo de referências (NDJSON) for verificado contra a cópia. Sem ele, a execução fica `NAOPUBLICAVEL-` (código 10).

Linha do arquivo de referências (uma por linha): `{"sha256":"<64 hex>","tamanho_bytes":123,"chave":"caminho/relativo"}`; só `sha256` é obrigatório.
Sem `chave`, basta existir arquivo com esse SHA-256 (adequado a conteúdo endereçado por hash).

O E2-R (`README-E2R.md`) gera esse arquivo a partir do dump e o vincula ao dump por SHA-256. Referências avulsas (`--referencias`) continuam aceitas, mas a execução fica `NAOPUBLICAVEL-` (código 10). Sem referências verificadas e vinculadas ao dump, nenhuma execução é publicável.

## Saída

- `<destino>/<run_id>/`: publicável (código 0).
- `<destino>/NAOPUBLICAVEL-<run_id>/`: cópia íntegra, mas bloqueada (códigos 10, 11 ou 12, desde que a pasta seja publicada; ver "Exceções de publicação"). Um envio remoto deve ignorar este prefixo.
- `<destino>/FALHA-<run_id>/`: falha com `falha.json` (código da falha original, em geral 5); a cópia parcial é removida. Vale quando a publicação da pasta de falha é possível.
- `<destino>/.em-andamento-<run_id>/`: nome durante a execução. Ele só permanece depois do fim do script nas situações de "Exceções de publicação" ou numa interrupção abrupta.
- Conteúdo: `tentativas/<n>/<id>/...`, `MANIFEST-ARQUIVOS.json` (+ `.sha256`), `registro.log`.

| Código | Significado |
|---|---|
| 0 | publicável |
| 2 | configuração, fonte, referências ou ordem banco→arquivos inválidas |
| 3 | destino inexistente, fora de 0700 ou em área sincronizada; ou `run_id` já existente (`E_RUN_ID_EXISTENTE`) |
| 4 | `node` ausente |
| 5 | falha de cópia, anomalia na origem, espaço ou limite de bytes; ou `E_PUBLICACAO_LOCAL` (falha operacional ao publicar uma execução concluída) |
| 10 / 11 / 12 | referências não verificadas / alteração concorrente / referências faltantes ou divergentes |

`node ops/backup/lib/arquivos.js verificar <diretório da execução>` recalcula todos os hashes e confere que não falta nem sobra arquivo.

## Exceções de publicação

`backup-arquivos.sh` publica a execução como descrito em `README.md` ("Publicação da execução"): reserva o nome final com `mkdir` e o troca por `rename`, sem sobrescrever nem aninhar. Distingo duas coisas: a **falha original** da cópia (por exemplo `E_ANOMALIA_ORIGEM`, `E_ESPACO_INSUFICIENTE`) e a **falha de publicação**, que acontece depois, ao dar nome à pasta.

- **Colisão real, `E_RUN_ID_EXISTENTE`, código 3.** Já existe `<run_id>`, `FALHA-<run_id>`, `NAOPUBLICAVEL-<run_id>` ou `.em-andamento-<run_id>`. Se for detectada no início, nada é criado. Se for detectada ao publicar uma execução concluída (publicável ou `NAOPUBLICAVEL-`), o que existia fica intacto e a execução concluída permanece em `.em-andamento-<run_id>`; o código de saída é 3, não 0, 10, 11 ou 12.
- **Falha operacional, `E_PUBLICACAO_LOCAL`, código 5.** Sem espaço, sem permissão ou falha do `rename`, com o nome inexistente. Vale para a execução publicável e para a `NAOPUBLICAVEL-`, que então sai com 5 e não com 10, 11 ou 12; o motivo do bloqueio continua em `MANIFEST-ARQUIVOS.json`, dentro da pasta. A execução concluída permanece em `.em-andamento-<run_id>` e nenhum dado dela é apagado.
- **Falha original seguida de falha ao publicar a falha.** O tratamento da falha já removeu `tentativas/` e o manifesto e gravou `falha.json`. Se a pasta não puder ser publicada como `FALHA-<run_id>` por causa operacional, imprimo `ERRO E_PUBLICACAO_LOCAL` antes e deixo `ERRO <erro original>` por último, com o código de saída original. Se a causa for colisão real, o código de saída passa a 3 e a falha original fica em `falha.json`, dentro de `.em-andamento-<run_id>`.

Uma pasta `.em-andamento-<run_id>` nunca é execução publicada. Mesmo com `tentativas/` e manifesto completos, não a considero backup nem restaurável sem validação (`node ops/backup/lib/arquivos.js verificar <pasta>` e ensaio de restauração fora destes scripts). O `registro.log` dessa pasta pode dizer `concluido publicavel` ou `concluido NAO PUBLICAVEL`, porque a linha é escrita antes da tentativa de publicar.

## Testes

```bash
node --test "ops/backup/test/*.test.js"
```

Usa só arquivos sintéticos. Os cinco testes de banco do E1 que usam `pg_dump` real ficam ignorados, com o motivo no relatório, a menos que exista um ambiente PostgreSQL de teste explicitamente autorizado; as condições estão em `README.md`.

## Limites

- Fingerprints provam alteração, mas não bloqueiam escrita: uma janela sem escrita só é garantida por controle operacional.
- Escritas concorrentes entre F0 e F1 que restaurem mtime e inode idênticos não são detectáveis.
- A verificação de áreas sincronizadas é por caminho.
- Não há retenção, agendamento nem trava global entre execuções; o armazenamento é só local, sem criptografia nem assinatura (ver `README.md`).
- As correções de segurança desta entrega foram executadas só em macOS. O conjunto de testes também rodou numa VM Linux (Node.js 22.23.3), em ensaio anterior a essas correções, e não o repeti no Linux depois delas.
- Dados sintéticos pequenos: volumes grandes e desempenho não foram verificados.
