# Backup simplificado — E1: PostgreSQL 16

Escopo do E1: dump do banco com `pg_dump -Fc`, validação por `pg_restore --list` e manifesto **parcial** com SHA-256.
Não envia nada à AWS, não copia arquivos persistentes, não restaura. Isso pertence às etapas seguintes.

Código novo e independente do D-ORF-6 (`backend/src/services/backup-fontes-*` e `imagem-backup-*`), que permanece intacto.
Fica fora de `backend/`, portanto fora do alcance da guarda estática P1/P2 e do `npm test` do backend. Os testes de `ops/backup` rodam por um passo próprio do CI (ver "Testes").

## Estado atual e limitações (leia antes de usar)

Escrevo aqui o que o código faz hoje e o que ele **não** faz:

- **Sem criptografia.** `banco.dump` e os demais arquivos ficam em texto claro no destino local. A única proteção é de permissão do sistema de arquivos (diretório `0700`, arquivos `0600`) e a do disco do servidor.
- **Sem assinatura de autenticidade.** O SHA-256 do manifesto detecta corrupção acidental e alteração isolada de um arquivo. Como o manifesto e o seu `.sha256` ficam na mesma pasta, quem puder escrever nela consegue alterar o arquivo, o manifesto e o hash juntos sem que a verificação perceba. Não há assinatura nem HMAC.
- **`pg_restore --list` não é restauração.** Ele lê o índice (TOC) do dump. Não restaura dados e não prova que o dump restaura sem erro nem que os dados estão consistentes. Esses scripts não restauram.
- **Sem retenção.** Não há rotação nem expurgo: as execuções (inclusive `FALHA-` e `NAOPUBLICAVEL-`) se acumulam até alguém removê-las manualmente. `BACKUP_LIMITE_BYTES` limita o volume de uma cópia de arquivos (E2), não o acúmulo.
- **Sem agendamento e sem trava global.** Nada executa estes scripts sozinho. Duas execuções simultâneas usam `run_id` e pastas distintos, mas disputam disco e E/S. A escrita concorrente da aplicação durante a cópia dos arquivos é detectada pelo E2 (códigos 11 e 12), não impedida; a janela de escrita `BACKUP` não está ativada.
- **Armazenamento exclusivamente local.** O destino é um diretório do mesmo host. Não há cópia externa, imutabilidade nem envio remoto.
- **Binários confiáveis.** Os scripts executam `pg_dump`, `pg_restore` e `node` com os privilégios de quem os chama. Sem `BACKUP_PG_BIN`, usam o primeiro `pg_dump` do `PATH`. Em agendador ou serviço, defino `BACKUP_PG_BIN` com um diretório absoluto e confiável e um `PATH` explícito.
- **Resíduos após interrupção abrupta.** Os scripts tratam `INT` e `TERM`. Com `kill -9`, queda de energia ou `HUP`, pode sobrar `.em-andamento-<run_id>` com dump parcial (`0700`/`0600`, nunca publicado). Removo manualmente depois de conferir que não há execução em curso. Há outros dois casos em que uma pasta `.em-andamento-<run_id>` permanece, descritos em "Publicação da execução". Os testes automatizados também deixam seus diretórios temporários no `TMPDIR`.
- **Áreas sincronizadas** são reconhecidas só por caminho: `Desktop`, `Documents`, `Library/Mobile Documents`, `Library/CloudStorage` e nomes com Dropbox, OneDrive, Google Drive e iCloud. Outros provedores não são detectados.

## Ensaios realizados e homologação pendente

Executei ensaios (G4 e G5) numa VM Linux, com PostgreSQL 16.15, Node.js 22.23.3 e **dados sintéticos**: backup do banco e dos arquivos, restauração em banco novo e comparação com a origem. No escopo testado, a comparação não apontou diferenças, com as ressalvas de que a comparação foi Linux contra Linux e de que o volume foi mínimo. Os registros, com SHA-256, estão preservados fora deste repositório e não são versionados.

Isso é evidência de ensaio. **Não é homologação.** A homologação AWS ainda não foi feita: S3 (versionamento, retenção, Object Lock), IAM/STS de privilégio mínimo, KMS, snapshots, monitoramento, alertas e restauração a partir do armazenamento remoto continuam pendentes, assim como agendamento, retenção local e notificação de falha.

## Uso

```bash
BACKUP_DB_NOME=<banco> BACKUP_DESTINO=<diretório 0700> BACKUP_PG_BIN=<dir do pg_dump 16> bash ops/backup/backup-db.sh
```

Variáveis: ver `config/backup.env.exemplo`. A senha nunca vai por argumento; use `PGPASSFILE` (0600) ou `PGPASSWORD` no ambiente.

## Saída

Sucesso: `<destino>/<run_id>/` (0700) com `banco.dump`, `toc.txt`, `MANIFEST.json`, `MANIFEST.json.sha256`, `registro.log`, todos 0600.
Falha: `<destino>/FALHA-<run_id>/` com `falha.json` e `registro.log`; o dump parcial é removido e nenhum manifesto é publicado. Isso vale quando a publicação da falha é possível; senão, ver "Publicação da execução".
Durante a execução o diretório se chama `.em-andamento-<run_id>`. Ele só passa a `<run_id>` ou `FALHA-<run_id>` quando a publicação termina.

| Código | Significado |
|---|---|
| 0 | sucesso |
| 2 | configuração ausente ou inválida |
| 3 | destino inexistente, fora de 0700 ou em área sincronizada; ou `run_id` já existente (`E_RUN_ID_EXISTENTE`) |
| 4 | `pg_dump`, `pg_restore` ou `node` ausente |
| 5 | `pg_dump` falhou |
| 6 | `pg_restore --list` falhou ou índice vazio (dump sem objetos; só aceito com `BACKUP_PERMITIR_BANCO_VAZIO=1`) |
| 7 | manifesto não gerado ou não verificado; ou falha operacional ao publicar a execução (`E_PUBLICACAO_LOCAL`) |

## Publicação da execução (os três scripts)

`backup-db.sh`, `backup-arquivos.sh` e `gerar-referencias.sh` publicam a execução da mesma forma, e esta seção vale para os três. Os outros dois READMEs descrevem as saídas normais de `backup-arquivos.sh` e `gerar-referencias.sh`; as exceções de publicação abaixo se somam a elas.

**Como publico.** Antes de criar qualquer coisa, recuso o `run_id` se já existir no destino `<run_id>`, `FALHA-<run_id>`, `NAOPUBLICAVEL-<run_id>` ou `.em-andamento-<run_id>` (um link, mesmo quebrado, também conta). Na publicação, reservo o nome final com `mkdir` (que falha se o nome já existir, mesmo vazio) e só então troco a reserva vazia pela execução com `rename`. Nunca sobrescrevo nada e nunca coloco uma execução dentro de outra.

**Colisão real contra falha operacional.** São duas situações distintas, com erros distintos:

| Situação | Erro | Código de saída | Estado do destino |
|---|---|---|---|
| Colisão real: o nome já existe, detectada no início | `E_RUN_ID_EXISTENTE` | 3 | nada é criado; o que existia fica intacto |
| Colisão real detectada ao publicar uma execução concluída | `E_RUN_ID_EXISTENTE` | 3 | o que existia fica intacto; a execução concluída permanece em `.em-andamento-<run_id>` |
| Falha operacional ao publicar uma execução concluída (sem espaço, permissão ou falha do `rename`; o nome não existe) | `E_PUBLICACAO_LOCAL` | 7 em `backup-db.sh`; 5 em `backup-arquivos.sh` e `gerar-referencias.sh` | a execução concluída permanece em `.em-andamento-<run_id>`; nenhum dado da execução é apagado |
| Falha operacional ao publicar uma execução que já havia falhado | `ERRO E_PUBLICACAO_LOCAL` seguido, na **última** linha, de `ERRO <erro original>` | o código da falha original (por exemplo, 5 para `E_PGDUMP_FALHOU`) | `.em-andamento-<run_id>/falha.json` registra a falha original |
| Colisão real ao publicar uma execução que já havia falhado | `ERRO E_RUN_ID_EXISTENTE` | 3 | `.em-andamento-<run_id>/falha.json` registra a falha original; é o único caso em que o código de saída deixa de ser o da falha original |

Em `backup-arquivos.sh`, a falha operacional ao publicar uma execução `NAOPUBLICAVEL-` também sai com 5 e `E_PUBLICACAO_LOCAL`, em vez de 10, 11 ou 12; o motivo do bloqueio continua no manifesto dentro da pasta.

**Falhas secundárias não mascaram o erro original.** Quando uma execução já falhou e a publicação da falha também falha por causa operacional, imprimo `E_PUBLICACAO_LOCAL` antes e deixo o erro original por último, com o código de saída original. A exceção é a colisão real, descrita na última linha da tabela, que fica registrada em `falha.json`.

**Quando uma execução permanece em `.em-andamento-<run_id>`.** Em quatro casos: interrupção abrupta (`kill -9`, queda de energia, `HUP`); colisão real ao publicar; falha operacional ao publicar; e, durante a execução, enquanto ela ainda não terminou.

**Não é backup publicado.** Uma pasta `.em-andamento-<run_id>` nunca é backup publicado. Mesmo quando contém dump e manifesto completos (colisão ou falha operacional ao publicar uma execução concluída), não a considero backup nem restaurável sem validação. O `registro.log` dessa pasta pode registrar `concluido`, porque a linha é escrita antes da tentativa de publicar. Antes de qualquer uso, rodo o verificador (`node ops/backup/lib/manifesto.js verificar <pasta>` no E1, `node ops/backup/lib/arquivos.js verificar <pasta>` no E2, `node ops/backup/lib/referencias.js verificar <pasta>` no E2-R), faço o ensaio de restauração fora destes scripts e só então decido manter ou descartar. Quando a pasta contém só `falha.json`, ela é apenas o registro da falha.

## Manifesto parcial (esquema 1)

`run_id` (UTC + 8 hex), host, banco, versão do `pg_dump`, dump (arquivo, tamanho, SHA-256), índice (`toc.txt`: entradas, SHA-256),
aplicação (última migration, total e SHA-256 de `checksums.json`) e a lista `pendente` (arquivos, fingerprints, armazenamento remoto).
Os nomes são fixos: `dump.arquivo` deve ser `banco.dump` e `toc.arquivo` deve ser `toc.txt`; o validador recusa caminhos absolutos, `../`, subdiretórios e outros nomes.
`node ops/backup/lib/manifesto.js verificar <diretório>` recalcula tudo e confere. Isso verifica integridade, não autenticidade (ver as limitações acima).

## Testes

```bash
node --test "ops/backup/test/*.test.js"
```

Exige Node.js 22 ou superior, como o backend. O workflow `.github/workflows/ci.yml` desta entrega executa esse mesmo comando, no job de verificações sem banco, com Node.js 22. Ainda não tenho o resultado dessa execução no GitHub Actions.

Cinco testes usam `pg_dump` real. Eles ficam **ignorados**, com o motivo no relatório, a menos que todas estas condições sejam atendidas:

- `BACKUP_TESTE_PG_BIN`, ou o diretório padrão do Postgres.app 16, contém `pg_dump`, `pg_restore`, `pg_isready` e `psql`.
- `BACKUP_TESTE_DB` e `BACKUP_TESTE_PG_AUTORIZADO` têm exatamente o mesmo nome. O banco precisa ser dedicado e descartável, criado só para estes testes. Um nome com "teste" não basta; a autorização é explícita.
- `PGHOST` aponta para um diretório de socket local que contém o socket, ou é `127.0.0.1` ou `::1`. Hosts remotos, `localhost`, listas de hosts e `PGHOSTADDR` fora do loopback são recusados.
- `PGSERVICE`, `PGSERVICEFILE` e `PGSYSCONFDIR` não estão definidos.
- O nome do banco não contém `homolog` nem `prod` e não é `postgres`, `template0` ou `template1`.
- O servidor já está em execução. Os testes não iniciam nem criam servidor.

`PGHOST`, `PGPORT`, `PGUSER` e `PGPASSFILE` valem igualmente para `pg_isready`, `psql` e `pg_dump`. `PGPASSWORD` nunca é repassada. Nunca aponto estes testes para um banco de homologação, de produção ou com dados reais.

Até esta revisão não tenho registro de execução bem-sucedida desses cinco testes contra um servidor PostgreSQL.

## Limites do E1

- Um dump do PostgreSQL é um instantâneo consistente do banco; consistência com arquivos persistentes é tratada na etapa E2.
- Não prova restaurabilidade: o ensaio de restauração em banco novo é a etapa E3, feita fora destes scripts.
