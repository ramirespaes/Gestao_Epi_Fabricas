#!/usr/bin/env bash
# V15 (11/11/2026, Rodada C, CONS-03) = V14 (6f8910ab…3b87, preservado e NÃO alterado). PREPARADO, NÃO EXECUTADO. Finalidade: rodar, na instância PostgreSQL EFÊMERA exclusiva, o ensaio `d-orf-6-cons03-estrutura-real.integration.js`
# (verificação estrutural REAL do dump, `pg_restore --list` supervisionado, pela composição real de produção com o papel mínimo B-1: dump válido, confirmação independente, lançador real sobre cópias adulteradas e dump adulterado
# pela composição; só fonte de chaves TESTE_CONTROLADO, sem GEPI_CI_EFEMERO). Porta 55471, EXCLUSIVAMENTE por socket Unix (`listen_addresses=''`), como no V14. Mudanças em relação ao V14: TESTES, SUITES_ESPERADAS e casos C3-01..06;
# SWB_CONS03=1 exportado SÓ ao processo de teste (e SWB_C1 não); observações C3_OBSERVACAO_JSON (mínimo 6) exigidas no TAP; verificação nova do socket `.s.PGSQL.55471` AUSENTE no preflight e de que a porta e o socket de outras
# instâncias (5432 e as `swb-*` anteriores) não são tocados; após o teste nenhum banco além dos quatro de base, nenhuma área `c3est-*`, o papel B-1 não pode sobrar e nenhum processo `pg_restore`/`pg_dump` pode ficar na área da instância;
# evidências em .../d-orf-6-rodada-c-evidencias-20261111/cons03; marcador `v15.marcador` (a limpeza só atua em instância criada por ESTA versão). Isolamento I1–I10, orçamento único (20 GB), reserva (40 GiB), encerramento protegido
# e preservação de evidências: idênticos ao V14, EXCETO o orçamento: o limite de 20 GB vale só para o consumo ADICIONAL da rodada (total atual − base histórica registrada em `orcamento-base-kib` na criação da instância); o histórico
# é apenas informado. Correções da revisão independente: (1) o encerramento por orçamento só emite `pg_ctl stop` com a identidade completa conferida; (2) erro/aviso de lsof e netstat nunca valem como porta livre; (3) processos
# pg_dump/pg_restore NOVOS depois do teste (e processos da área c3est-*) bloqueiam sem sinalizar nada. NUNCA usa a porta 5432, o banco `homolog_local` nem as instâncias `swb-*` anteriores (o diretório da instância é sempre novo).
# V14 (10/11/2026, Rodada C, C-1) = V13 (03c5fec2…34de, preservado e NÃO alterado). PREPARADO, NÃO EXECUTADO. Finalidade: rodar, na instância PostgreSQL EFÊMERA exclusiva, o ensaio `d-orf-6-c1-dr-cifrado-b1.integration.js`
# (backup pelo papel mínimo B-1 → pacote L2 → cifra P11 → perda da origem → decifra → restauração P12 → contraprova de adulteração; só fonte de chaves TESTE_CONTROLADO, sem GEPI_CI_EFEMERO). Mudanças em relação ao V13: TESTES e
# SUITES_ESPERADAS; SWB_C1=1 exportado SÓ ao processo de teste; os oito casos C1-01..08 e as observações C1_OBSERVACAO_JSON (mínimo 8) exigidos no TAP; sem arquivo de resultados à parte (o TAP é a evidência); o papel B-1 não pode
# sobrar na instância e nenhuma área `c1dr-*` pode restar; evidências em .../d-orf-6-rodada-c-evidencias-20261110/c1; marcador `v14.marcador` (a limpeza só atua em instância criada por ESTA versão). Isolamento I1–I10, orçamento
# único (20 GB), reserva (40 GiB), encerramento protegido e preservação de evidências: idênticos ao V13. PRÉ-REQUISITO: o teste da trava B2 (`backup-decifra-chamadores.test.js`) precisa listar o ensaio C-1 em TESTES_AUTORIZADOS.
# V13 (09/11/2026, H9-h, ensaio do candidato B-1) = V12 (21165f68…0d5, preservado e NÃO alterado). Finalidade: rodar, na instância PostgreSQL EFÊMERA exclusiva, o ensaio `d-orf-6-h9h-b1-papel-minimo.integration.js` (papel mínimo de banco,
# backup e restauração pela composição real de produção, medição de conexões, negativos). Mudanças em relação ao V12: TESTES e SUITES_ESPERADAS; SWB_H9H_B1=1 exportado SÓ ao processo de teste; os onze casos H9H-B1-01..11 e as observações
# H9H_OBSERVACAO_JSON exigidos no TAP; h9h-resultados.json preservado com o TAP; os papéis do ensaio não podem sobrar na instância; evidências em .../h9h; marcador `v13.marcador`. Isolamento I1–I10, orçamento (20 GB), reserva (40 GiB),
# encerramento protegido, preservação de evidências e limpeza (`limpar-verificar`, `limpar`): idênticos ao V12 (a limpeza só atua em instância criada por ESTA versão).
# V12 (08/11/2026, Rodada B, B3B-2) = V11 (088f0a07…49982eb, preservado e NÃO alterado). PREPARADO, NÃO EXECUTADO. Finalidade: rodar, na instância PostgreSQL EFÊMERA, UM arquivo de integração, o ensaio ponta a ponta [B3-E2E]
# (backup real pela composição de produção, restauração real em banco novo, RECUPERADO/ÍNTEGRO, negativos), com o banco de origem dedicado e as migrations no `public` desse banco. A exceção de migrations no `public` do banco dedicado
# e a execução PostgreSQL exigem autorização específica. Mudanças em relação ao V11: TESTES e SUITES_ESPERADAS (1 arquivo, 1 suíte conferida por nome, fail 0, skipped 0, cancelled 0); SWB_B3_PONTA_A_PONTA=1 exportado SÓ ao processo
# de teste; os nove casos B3-E2E-01..09 e as observações JSON exigidos no TAP; após o teste a instância só pode ter os quatro bancos de base e nenhuma área `b3e2e-*`; marcador `v13.marcador`. Limpeza (`limpar-verificar` e `limpar`),
# isolamento I1–I10, encerramento protegido, orçamento único (20 GB por rodada), reserva de 40 GiB e preservação de evidências: idênticos ao V11 (a limpeza só atua em instância criada por ESTA versão).
# V11 (08/11/2026, Rodada B, B3B) = V10 (3d2014f6…13db, preservado e NÃO alterado). PREPARADO, NÃO EXECUTADO. Mudança ÚNICA: endurecimento da limpeza (`limpar-verificar` e `limpar`); `rodada`, isolamento, I1–I10, orçamento e testes são idênticos ao V10.
# Marcador gravado na criação passa a ser `v13.marcador` (contém o hash do V11): instâncias criadas pelo V10 NÃO são limpas por este roteiro. Lacunas do V10 fechadas: (1) `revalidar_alvo` roda no início E de novo imediatamente antes do `rm`
# (junto com a conferência das evidências); (2) o diretório da rodada é recusado se tiver QUALQUER link simbólico, arquivo especial (dispositivo, fifo), entrada de outro dono, arquivo com mais de um vínculo ou subdiretório em outro dispositivo;
# (3) o alvo é recusado se for ponto de montagem, se houver montagem dentro dele ou se estiver em dispositivo diferente de /private/tmp; (4) modo do diretório exigido 0700; (5) evidências: destino `encerrar-ok` de dono correto, não link,
# TAP e MANIFESTO regulares (não links), MANIFESTO (0400) cobrindo o TAP, hash do TAP idêntico e `shasum -c` do manifesto. Falha de qualquer verificação bloqueia ANTES de qualquer exclusão. Resíduo declarado: entre a última revalidação e o `rm`
# há uma janela de milissegundos; o diretório é 0700 do próprio usuário, o que a torna inexplorável por terceiros.
# V10 (08/11/2026, Rodada B, B3B) = V9 (8708336f…30a1, preservado). PREPARADO, NÃO EXECUTADO. Finalidade: rodar, em PostgreSQL EFÊMERO, as DUAS suítes de integração do B3: o papel mínimo de banco do executor (modelo SQL do H9-h) e as peças reais
# de coordenação e auditoria pelo montador. Mudanças em relação ao V9: TESTES e SUITES_ESPERADAS (2 arquivos, 2 suítes conferidas por nome, fail 0, skipped 0, cancelled 0); BACKUP_PG_BINARIOS exportado SÓ para o processo de teste
# (os binários 16 do Postgres.app, que a suíte do papel valida); evidências em ~/SafeWorkDados/d-orf-6-rodada-b-evidencias-20261108/b3; marcador `v10.marcador` gravado na criação da instância; e dois modos novos de limpeza
# SEGURA, `limpar-verificar` (só lê) e `limpar` (remove), que NUNCA fazem parte de `rodada`: só atuam sobre instância criada por ESTA versão, parada, com evidências já preservadas e conferidas. Isolamento, I1–I10, encerramento protegido,
# orçamento único (20 GB), reserva de 40 GiB e preservação de evidências: idênticos ao V9. LIMITE: o ensaio ponta a ponta com pg_dump pela composição de produção NÃO está nesta rodada (depende de autorização própria; ver o relatório do B3A).
# V9 (08/11/2026) = V8 (386e1696…3e1a, preservado) com UMA correção focal, achada na rodada swb-20261108114658-1: o `du` sobre o diretório da instância em execução sai com erro quando o PostgreSQL
# apaga arquivos temporários durante a medição ("No such file or directory"); sob pipefail isso virava leitura inválida e o monitor, fail-closed, parava a instância (falso positivo; uso real ~0,9 GiB de 20).
# Agora `du` tolera apenas esse erro (stderr descartado, status ignorado) e continua EXIGINDO total numérico: saída vazia ou não numérica segue contando como violação. Limites e demais controles inalterados.
# V8 (08/11/2026, correção focal da CI da PR #98, run 42488447506) = V7 (4c9ef9c5…4007, preservado) com UMA finalidade: executar, em PostgreSQL EFÊMERO, os 20 arquivos de integração
# corrigidos para a migration 097 (22 falhas da CI: contagem 96→97, sequência até a 097, primeira barreira JS + gatilho do banco). Mudanças em relação ao V7: TESTES com os 20 arquivos;
# guarda de quantidade (20); validador por NOME das 20 suítes de topo + fail 0, skipped 0, cancelled 0; monitor até 40 min; mensagens. Isolamento, I1–I10, encerramento protegido,
# interrupções, orçamento único e preservação de evidências: idênticos ao V7. Nunca apaga nada. Uso e códigos de saída: como no V7.
# SAFEWORK D-ORF-6 RODADA A (R3, comprovação H-DEP3-b): ciclo de vida do PostgreSQL EFÊMERO (socket Unix), VERSÃO 7. PREPARADO, NÃO EXECUTADO.
# V7 = V6 (dc91fba0…c176, preservado) com UMA finalidade: execução FOCAL de `migrations-runner.integration.js` (node-pg-migrate 9.0.0 sobre
# glob 14.0.2 / minimatch 11.0.1, instalados na G2 pela Fase 2 do DEP-3). Mudanças: TESTES só com o runner (exatamente 1 arquivo); pré-condição
# de que a G2 tem glob 14.0.2, minimatch 11.0.1 e node-pg-migrate 9.0.0 instalados (lidos de node_modules, falha fechada); validador exige as
# NOVE suítes de topo do runner `ok` + fail 0, skipped 0, cancelled 0; TAP em rodada-a.tap (mesmo nome do V6). Isolamento, I1–I10, encerramento protegido,
# interrupções e preservação de evidências: idênticos ao V6. As suítes da 097 e do trigger NÃO são repetidas (já aprovadas na R2).
# V6 = V5 (eff45483…0d6c, preservado) com DUAS correções focais, achadas na rodada swb-20261107210129-2 (08/11):
#  1. ÓRFÃO EM FALHA DE `testar`: traps são globais no bash; o trap de saída do `testar` sobrescrevia o da `rodada` e, em reprovação, só
#     preservava evidências — a instância ficou em execução. Agora o trap de falha do `testar` também chama `encerrar_protegido`
#     (encerra SÓ a instância validada; ambiguidade bloqueia e imprime o roteiro manual).
#  2. VALIDADOR DE SUÍTES: o `node --test` nomeia os testes de topo pelo `describe` de cada arquivo, não pelo caminho; o V5 contava 0/3.
#     Agora exige, por NOME, as três suítes de topo: `[L1-TRIGGER] …`, `migration 097 — chave JSON sensível sem separador` e, do runner,
#     `aplicação das migrations reais em schema vazio` E `isolamento do schema public`; além de fail 0, skipped 0, cancelled 0.
# V5 = V4 (f1489bc4…9909, preservado) com UMA correção focal: o Node deixa de ser resolvido pelo PATH (que no Mac aponta para o Homebrew,
# 26.10.0, causa do bloqueio de 07/11 na rodada swb-20261107194636-1) e passa a ser o binário EXPLÍCITO 22.23.3 do nvm (NODE), também para
# os processos filhos do `node --test` (que herdam process.execPath) e para qualquer filho que procure `node` no PATH (PATH prefixado só
# dentro do subshell dos testes). Nada mais muda: migration, testes, I1–I10, encerramento protegido e preservação de evidências intactos.
# V4 = V3 (e47f1725…4401, preservado) com: BACKEND = G2; TESTE → lista TESTES (runner e 097 antes, trigger por último porque exige `public`
# vazio e tira a impressão do catálogo); timeout por teste 300 s (o runner aplica 97 migrations). Controles I1–I9, porta 55471, só socket,
# protegidas 5432/55460 e encerramento só por `pg_ctl stop` no diretório validado: os do V3, inalterados. ACRESCENTADOS (revisão 07/11):
#  - I10: o dono do processo da instância tem de ser o usuário corrente (`ps -o user=`), em verificar e encerrar;
#  - encerrar_protegido: SÓ encerra se PID, diretório de dados, porta, socket, linha do `ps` e usuário conferirem; qualquer ambiguidade
#    BLOQUEIA o encerramento automático e imprime o procedimento de recuperação manual (nunca kill, nunca glob);
#  - interrupção (INT/TERM) em iniciar/testar/rodada: para o monitor, encerra só a instância validada, preserva evidências, sai com 130;
#  - preservar_evidencias: copia (nunca move) logs, TAP, env, listas de instâncias e um manifesto SHA-256 para o diretório de evidências
#    da Rodada A, em sucesso ou falha, inclusive falha em iniciar/verificar/testar; diretórios temporários nunca são apagados;
#  - orçamento ÚNICO da Rodada A (20 GB): soma de todos os diretórios da rodada (instâncias swb-*, ensaio/snapshots/evidências do DEP-3)
#    conferida antes de iniciar e antes de testar — o orçamento não é reiniciado entre R2 e R3;
#  - modo `rodada <swb>`: preflight → iniciar → verificar → testar → encerrar com preservação de evidências em qualquer saída.
# Uso: SWB_SHA256_ESPERADO=<sha256 deste arquivo> bash <este-arquivo> <preflight|iniciar|verificar|testar|encerrar|rodada|limpar-verificar|limpar> [DIRETORIO_SWB]
# Só o modo `limpar` remove algo (rm), e só a instância criada por esta versão (marcador), parada, com evidências preservadas e conferidas, e com a confirmação SWB_CONFIRMO_LIMPEZA=<nome do diretório>; `limpar-verificar` apenas descreve.
# Nunca sinaliza processo por PID: só `pg_ctl stop` no diretório de dados validado. Não toca nas instâncias protegidas.
# Códigos: 2 uso/ambiente, 3 espaço/orçamento, 4 identidade/isolamento, 5 encerramento, 6 hash do script, 7 teste reprovado.
# V3: gate de hash em TODOS os modos; porta e socket do postmaster.pid conferidos antes de parar; contenção em camadas do consumo de disco (ver conter_recursos e monitorar).
# LIMITE HONESTO: o orçamento de 20 GB NÃO é fisicamente garantido. Só o limite de tamanho por arquivo (RLIMIT_FSIZE) é imposto pelo núcleo, e é por arquivo; o restante é configuração do PostgreSQL e amostragem a cada 1 s.
set -euo pipefail

PGB=/Applications/Postgres.app/Contents/Versions/16/bin
PORTA=55471
RESERVA_KIB=41943040       # 40 GiB livres no mínimo
ORCAMENTO_KIB=19531250     # 20 GB (10^9) por rodada, medido no diretório da instância
PROTEGIDAS="5432 55460"
LIMITE_ARQUIVO_KIB=524288  # 512 MiB por arquivo (ulimit -f em unidades de 1024 bytes no bash)
AMOSTRAS_MAXIMAS=2400      # o monitor vive no máximo 40 min (1 amostra por segundo), mesmo que o pai morra
OPCOES_PG="-p 55471 -c listen_addresses='' -c fsync=off -c wal_level=minimal -c max_wal_senders=0 -c archive_mode=off -c max_wal_size=192MB -c min_wal_size=80MB -c wal_keep_size=0 -c temp_file_limit=256MB -c max_connections=10 -c logging_collector=off -c log_statement=none -c log_min_duration_statement=-1"
CONFIG_ESPERADA='temp_file_limit=262144;max_wal_size=192;wal_keep_size=0;wal_level=minimal;archive_mode=off;logging_collector=off;max_connections=10'
PADRAO_SWB='^/private/tmp/swb-[0-9]{14}-[0-9]{1,5}$'
BACKEND=/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104/backend
DEPENDENCIAS=/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104/backend/node_modules
NODE_BIN="$HOME/.nvm/versions/node/v22.23.3/bin"   # Node 22.23.3 explícito: nunca o `node` do PATH
NODE="$NODE_BIN/node"
TESTES=(
  test/integracao/d-orf-6-cons03-estrutura-real.integration.js
)
# suítes de topo que o TAP deve conter como "ok" (o node --test as nomeia pelo describe de cada arquivo); casamento por trecho fixo
SUITES_ESPERADAS=(
  '[CONS03-REAL] verificação estrutural real do dump'
)
# pacote:versão que a G2 TEM de ter instalada (Fase 2 do DEP-3) para esta comprovação valer
DEPS_ESPERADAS=(glob:14.0.2 minimatch:11.0.1 node-pg-migrate:9.0.0)
EVID_RODADA_A="$HOME/SafeWorkDados/d-orf-6-rodada-c-evidencias-20261111/cons03"   # nome herdado do V9; aqui é o diretório de evidências do ensaio CONS-03
# Diretórios que consomem o orçamento ÚNICO da Rodada A e B: instâncias efêmeras, tudo o que o gate DEP-3 grava e as evidências das duas rodadas. Soma ≤ ORCAMENTO_KIB.
DIRETORIOS_DA_RODADA=("$HOME/SafeWorkDados/dep3-ensaio" "$HOME/SafeWorkDados/dep3-snapshots" "$HOME/SafeWorkDados/dep3-evidencias-20261107" "$HOME/SafeWorkDados/d-orf-6-rodada-a-evidencias-20261107" "$HOME/SafeWorkDados/d-orf-6-rodada-b-evidencias-20261108" "$HOME/SafeWorkDados/d-orf-6-rodada-c-evidencias-20261110" "$HOME/SafeWorkDados/d-orf-6-rodada-c-evidencias-20261111")

falhar() { printf 'BLOQUEADO[%s]: %s\n' "$1" "$2" >&2; exit "$1"; }

gate_hash() {  # o script só roda se for exatamente o arquivo aprovado
  local esperado="${SWB_SHA256_ESPERADO:-}" atual
  [[ "$esperado" =~ ^[0-9a-f]{64}$ ]] || falhar 6 "SWB_SHA256_ESPERADO ausente ou invalido"
  atual=$(shasum -a 256 "$0" | awk '{print $1}') || falhar 6 "nao foi possivel calcular o hash do script"
  [ "$atual" = "$esperado" ] || falhar 6 "hash do script difere do aprovado"
}

gate_espaco() {  # gate_espaco <rotulo> [diretorio_da_instancia]
  local livre usado
  livre=$(df -k /private/tmp | awk 'NR==2{print $4}') || falhar 3 "leitura de espaco falhou"
  [[ "$livre" =~ ^[0-9]+$ ]] || falhar 3 "leitura de espaco invalida"
  printf 'espaco[%s]: %s KiB livres (%s GiB)\n' "$1" "$livre" "$(awk -v k="$livre" 'BEGIN{printf "%.2f", k/1048576}')"
  [ "$livre" -ge "$RESERVA_KIB" ] || falhar 3 "menos de 40 GiB livres; nenhuma nova operacao"
  if [ -n "${2:-}" ] && [ -d "$2" ]; then
    usado=$(du -sk "$2" 2>/dev/null | awk '{print $1}' || true)
    [[ "$usado" =~ ^[0-9]+$ ]] || falhar 3 "medicao do diretorio invalida"
    printf 'orcamento[%s]: instancia usa %s KiB (limite %s KiB)\n' "$1" "$usado" "$ORCAMENTO_KIB"
    [ "$usado" -le "$ORCAMENTO_KIB" ] || falhar 3 "orcamento de 20 GB por rodada excedido"
  fi
}

exigir_swb() {
  [[ "${1:-}" =~ $PADRAO_SWB ]] || falhar 2 "diretorio fora do padrao /private/tmp/swb-<AAAAMMDDHHMMSS>-<n>"
}

# Lê linhas de `ps -axww -o pid=,command=` e emite "pid|diretorio-de-dados" COMPLETO, só do postmaster (executável termina em /postgres).
extrair_instancias() {
  awk '{ exe=$2; if (exe !~ /(^|\/)postgres$/) next;
         i=index($0," -D "); if (i==0) next;
         r=substr($0,i+4);
         if (match(r," -[A-Za-z] ")) r=substr(r,1,RSTART-1);
         sub(/ +$/,"",r); print $1 "|" r }'
}
instancias_existentes() { ps -axww -o pid=,command= | extrair_instancias | sort; }

contem_linha() {  # contem_linha <lista> <linha exata>
  [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]
}

sql() {  # sql <swb> <banco> <comando>; falha do psql => status != 0
  "$PGB/psql" -X -q -At -h "$1/sock" -p "$PORTA" -U swb_teste -d "$2" -v ON_ERROR_STOP=1 -c "$3"
}

porta_ocupada() {  # 0 se há listener TCP na porta OU se a leitura for inválida: erro, aviso ou status inesperado do lsof NUNCA vale como porta livre (falha fechada); só "status 1 e saída vazia" é porta livre
  local saida rc
  saida=$(lsof -nP -iTCP:"$PORTA" -sTCP:LISTEN 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 1 ] && [ -z "$saida" ]; then return 1; fi
  return 0
}

conter_recursos() {  # herdado por postgres, psql e node: sem core dump e com teto de tamanho por arquivo (imposto pelo núcleo, por arquivo)
  ulimit -c 0 || falhar 2 "nao foi possivel desligar core dump"
  ulimit -f "$LIMITE_ARQUIVO_KIB" || falhar 2 "nao foi possivel fixar o teto de tamanho por arquivo"
  [ "$(ulimit -c)" = "0" ] && [ "$(ulimit -f)" = "$LIMITE_ARQUIVO_KIB" ] || falhar 2 "limites de recursos nao aplicados"
  export PSQL_HISTORY=/dev/null
}

amostra_excede() {  # amostra_excede <swb> [extra_kib]: 0 se o orçamento OU a reserva foram violados (leitura inválida conta como violação: falha fechada)
  # V15: o consumo ADICIONAL da rodada é o da instância MAIS o crescimento do diretório de evidências desde a criação da instância (`orcamento-base-evid-kib`); `extra_kib` é o que uma cópia de evidências
  # ainda por fazer acrescentaria. Sem a base de evidências a leitura é inválida (violação).
  local swb="$1" extra="${2:-0}" livre usado evid base_evid adicional_evid=0
  livre=$(df -k /private/tmp | awk 'NR==2{print $4}') || return 0
  usado=$(du -sk "$swb" 2>/dev/null | awk '{print $1}' || true)
  base_evid=$(cat "$swb/orcamento-base-evid-kib" 2>/dev/null || true)
  [[ "$livre" =~ ^[0-9]+$ ]] && [[ "$usado" =~ ^[0-9]+$ ]] && [[ "$base_evid" =~ ^[0-9]+$ ]] && [[ "$extra" =~ ^[0-9]+$ ]] || return 0
  if [ -d "$EVID_RODADA_A" ]; then
    evid=$(du -sk "$EVID_RODADA_A" 2>/dev/null | awk '{print $1}' || true)
    [[ "$evid" =~ ^[0-9]+$ ]] || return 0
    adicional_evid=$((evid - base_evid)); [ "$adicional_evid" -ge 0 ] || adicional_evid=0
  fi
  [ "$livre" -lt "$RESERVA_KIB" ] || [ $((usado + adicional_evid + extra)) -gt "$ORCAMENTO_KIB" ]
}

parar_por_orcamento() {  # V15: marca e pára SÓ a nossa instância, e SÓ se TODA a identidade conferir (pid, diretório, porta, socket, linha do ps e dono = usuário corrente); ambiguidade nunca para nem sinaliza nada
  local swb="$1"
  : > "$swb/orcamento-excedido"
  [ -f "$swb/pgdata/postmaster.pid" ] || return 0
  if instancia_e_nossa "$swb"; then
    "$PGB/pg_ctl" -D "$swb/pgdata" -m fast stop > /dev/null 2>&1 || true
  else
    : > "$swb/orcamento-identidade-ambigua"
    echo "ORCAMENTO EXCEDIDO, mas a identidade da instancia nao conferiu: NENHUM pg_ctl stop foi emitido" >&2
    recuperacao_manual "$swb"
  fi
}

monitorar() {  # monitorar <swb>: amostra a cada 1 s até existir $swb/monitor.parar ou até AMOSTRAS_MAXIMAS
  local swb="$1" n=0
  while [ ! -e "$swb/monitor.parar" ] && [ "$n" -lt "$AMOSTRAS_MAXIMAS" ]; do
    if amostra_excede "$swb"; then parar_por_orcamento "$swb"; return 0; fi
    sleep 1
    n=$((n + 1))
  done
}

conteudo_env() {  # conteúdo exato esperado de instancia.env
  printf 'export DB_HOST=%s\nexport DB_PORT=%s\nexport DB_NAME=gestao_epi_teste_local\nexport DB_USER=swb_teste\nexport DB_PASSWORD=\nexport SWB_PGDATA=%s\nexport SWB_PORT=%s\n' "$1/sock" "$PORTA" "$1/pgdata" "$PORTA"
}

usuario_do_pid() { ps -o user= -p "$1" 2>/dev/null | awk '{print $1}'; }

total_dirs_kib() {  # soma, em KiB, de TODOS os diretórios da rodada (consumo HISTÓRICO incluído: instâncias swb-* anteriores, DEP-3 e evidências); medição inválida bloqueia (a saída é só o número)
  local total=0 d usado
  for d in "${DIRETORIOS_DA_RODADA[@]}"; do [ -d "$d" ] || continue; usado=$(du -sk "$d" 2>/dev/null | awk '{print $1}' || true); [[ "$usado" =~ ^[0-9]+$ ]] || falhar 3 "medicao de $d invalida"; total=$((total + usado)); done
  for d in /private/tmp/swb-*; do [ -d "$d" ] && [[ "$d" =~ $PADRAO_SWB ]] || continue; usado=$(du -sk "$d" 2>/dev/null | awk '{print $1}' || true); [[ "$usado" =~ ^[0-9]+$ ]] || falhar 3 "medicao de $d invalida"; total=$((total + usado)); done
  printf '%s' "$total"
}

# V15: o limite de 20 GB vale para o consumo ADICIONAL desta rodada, não para o histórico. A linha de base é a soma de todos os diretórios medida na criação da instância (`orcamento-base-kib`);
# o consumo adicional é (total atual − base) e é ele que é comparado com ORCAMENTO_KIB. O histórico só é informado (a reserva de 40 GiB livres continua valendo e é checada à parte).
registrar_base_orcamento() {  # registrar_base_orcamento <swb>: grava a base histórica uma única vez, logo depois de criar o diretório da instância
  local swb="$1" base
  [ ! -e "$swb/orcamento-base-kib" ] || falhar 3 "base do orcamento ja registrada nesta instancia"
  base=$(total_dirs_kib) || falhar 3 "medicao da base do orcamento invalida"
  [[ "$base" =~ ^[0-9]+$ ]] || falhar 3 "base do orcamento invalida"
  printf '%s\n' "$base" > "$swb/orcamento-base-kib"
  # base do diretório de evidências (0 se ainda não existe): o monitor soma só o CRESCIMENTO dele durante a rodada, sem reler todo o histórico a cada amostra
  local evid=0
  if [ -d "$EVID_RODADA_A" ]; then evid=$(du -sk "$EVID_RODADA_A" 2>/dev/null | awk '{print $1}' || true); fi
  [[ "$evid" =~ ^[0-9]+$ ]] || falhar 3 "medicao da base das evidencias invalida"
  printf '%s\n' "$evid" > "$swb/orcamento-base-evid-kib"
  printf 'orcamento-base: %s KiB de consumo historico registrados; o limite de %s KiB vale so para o consumo adicional desta rodada\n' "$base" "$ORCAMENTO_KIB"
}

orcamento_rodada_a() {  # orcamento_rodada_a <rotulo> [swb]: sem <swb> (antes de existir instância) só informa o histórico; com <swb> compara o consumo ADICIONAL com o limite
  local rotulo="$1" swb="${2:-}" total base delta
  total=$(total_dirs_kib) || falhar 3 "medicao do orcamento invalida"
  [[ "$total" =~ ^[0-9]+$ ]] || falhar 3 "medicao do orcamento invalida"
  if [ -z "$swb" ]; then
    printf 'orcamento-rodada-a[%s]: historico %s KiB (informativo; o limite de %s KiB vale so para o consumo adicional da rodada)\n' "$rotulo" "$total" "$ORCAMENTO_KIB"
    return 0
  fi
  [ -f "$swb/orcamento-base-kib" ] && [ ! -L "$swb/orcamento-base-kib" ] || falhar 3 "base historica do orcamento ausente nesta instancia: nao ha como separar o consumo adicional"
  base=$(cat "$swb/orcamento-base-kib")
  [[ "$base" =~ ^[0-9]+$ ]] || falhar 3 "base historica do orcamento invalida"
  delta=$((total - base)); [ "$delta" -ge 0 ] || delta=0
  printf 'orcamento-rodada-a[%s]: historico (base) %s KiB; total atual %s KiB; consumo adicional %s KiB (limite %s KiB)\n' "$rotulo" "$base" "$total" "$delta" "$ORCAMENTO_KIB"
  [ "$delta" -le "$ORCAMENTO_KIB" ] || falhar 3 "limite adicional de 20 GB da rodada atingido; suspender novos testes e reavaliar"
}

processos_pg() {  # pids (um por linha, ordenados) dos pg_dump/pg_restore REAIS (binários de $PGB) em execução; leitura inválida bloqueia; não envia sinal algum
  local lista
  lista=$(ps -axww -o pid=,command=) || falhar 7 "ps falhou: nao foi possivel listar processos"
  PGB_PROC="$PGB" awk 'index($0, ENVIRON["PGB_PROC"] "/pg_restore") || index($0, ENVIRON["PGB_PROC"] "/pg_dump") { print $1 }' <<< "$lista" | sort
}

instancia_e_nossa() {  # 0 só se TODA a identidade confere: postmaster.pid (pid, dir, porta, socket), linha do ps e usuário dono = usuário corrente
  local swb="$1" pid dir porta_pid socket_pid lista dono
  [ -f "$swb/pgdata/postmaster.pid" ] || return 1
  pid=$(sed -n 1p "$swb/pgdata/postmaster.pid"); dir=$(sed -n 2p "$swb/pgdata/postmaster.pid"); porta_pid=$(sed -n 4p "$swb/pgdata/postmaster.pid"); socket_pid=$(sed -n 5p "$swb/pgdata/postmaster.pid")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$dir" = "$swb/pgdata" ] && [ "$porta_pid" = "$PORTA" ] && [ "$socket_pid" = "$swb/sock" ] || return 1
  lista=$(instancias_existentes); contem_linha "$lista" "$pid|$swb/pgdata" || return 1
  dono=$(usuario_do_pid "$pid"); [ -n "$dono" ] && [ "$dono" = "$(id -un)" ] || return 1
  return 0
}

recuperacao_manual() {  # nunca executa nada destrutivo: só descreve
  local swb="$1"
  cat >&2 <<FIM
ENCERRAMENTO AUTOMATICO BLOQUEADO: identidade da instancia em $swb ambigua ou divergente.
Recuperacao manual (decisao humana, passo a passo, sem kill e sem glob):
  1. cat $swb/pgdata/postmaster.pid            # pid, diretorio, porta, socket registrados
  2. ps -axww -o pid=,user=,command= | awk '\$3 ~ /(^|\\/)postgres\$/'   # confronte pid, usuario e "-D $swb/pgdata"
  3. Se e somente se TODOS conferirem: $PGB/pg_ctl -D $swb/pgdata -m fast -w stop
  4. Se nao conferirem: nao sinalize processo algum; registre a divergencia e consulte antes de agir.
Nada em $swb foi apagado; evidencias preservadas.
FIM
}

encerrar_protegido() {  # usado por interrupções e pelo modo rodada: encerra SÓ a instância validada; ambiguidade bloqueia
  local swb="$1"
  [ -f "$swb/pgdata/postmaster.pid" ] || { echo "encerrar_protegido: nenhuma instancia em execucao em $swb"; return 0; }
  if instancia_e_nossa "$swb"; then
    "$PGB/pg_ctl" -D "$swb/pgdata" -m fast -w stop > "$swb/pg_ctl-stop.log" 2>&1 || { echo "pg_ctl stop falhou; ver $swb/pg_ctl-stop.log" >&2; recuperacao_manual "$swb"; return 5; }
    echo "encerrar_protegido: instancia validada encerrada"
  else
    recuperacao_manual "$swb"; return 4
  fi
}

preservar_evidencias() {  # copia (nunca move) o que existir em <swb> para o diretório de evidências da Rodada A; falha de cópia não mascara o desfecho
  local swb="$1" rotulo="$2" dest copiaveis="" copia_kib=0 nome
  # V15: antes de copiar, confere se a cópia (arquivos da instância ainda por copiar) cabe no limite ADICIONAL de 20 GB junto com o consumo atual (instância + crescimento das evidências); se não cabe, ou se a leitura
  # for inválida, NADA é copiado: o marcador `evidencias-nao-copiadas-orcamento` fica na instância (preservada, nunca removida) e `limpar` continua bloqueado por faltar o destino `encerrar-ok` conferido.
  for nome in rodada-a.tap pg.log initdb.log pg_ctl-start.log pg_ctl-stop.log instancias-antes.txt instancias-depois.txt instancia.env orcamento-excedido orcamento-identidade-ambigua orcamento-base-kib orcamento-base-evid-kib processos-pg-antes.txt interrompido; do
    if [ -f "$swb/$nome" ]; then copiaveis="$copiaveis $nome"; fi
  done
  # (nomes sem espaço; lista em texto, não em array, para não depender do tratamento de array vazio do bash 3.2 sob `set -u`)
  if [ -n "$copiaveis" ]; then copia_kib=$(cd "$swb" && du -ck $copiaveis 2>/dev/null | awk 'END{print $1}' || true); fi
  if ! [[ "$copia_kib" =~ ^[0-9]+$ ]] || amostra_excede "$swb" "$copia_kib"; then
    : > "$swb/evidencias-nao-copiadas-orcamento" 2>/dev/null || true
    echo "aviso: a copia das evidencias NAO cabe no limite adicional/reserva (ou a leitura e invalida); nada foi copiado; os arquivos continuam em $swb (preservado)" >&2
    return 0
  fi
  dest="$EVID_RODADA_A/pg-efemero-$(basename "$swb")-$rotulo-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dest" 2>/dev/null || { echo "aviso: nao foi possivel criar $dest" >&2; return 0; }
  chmod 700 "$dest" 2>/dev/null || true
  local f
  for f in rodada-a.tap pg.log initdb.log pg_ctl-start.log pg_ctl-stop.log instancias-antes.txt instancias-depois.txt instancia.env orcamento-excedido orcamento-identidade-ambigua orcamento-base-kib orcamento-base-evid-kib processos-pg-antes.txt interrompido; do
    [ -f "$swb/$f" ] && cp -p "$swb/$f" "$dest/" 2>/dev/null || true
  done
  { echo "script_sha256=$(shasum -a 256 "$0" | awk '{print $1}')"; echo "swb=$swb rotulo=$rotulo instante=$(date -u +%Y%m%dT%H%M%SZ) usuario=$(id -un)"; echo "backend=$BACKEND"; for f in "${TESTES[@]}"; do shasum -a 256 "$BACKEND/$f" 2>/dev/null || true; done; } > "$dest/cabecalho.txt"
  ( cd "$dest" && ls | grep -v '^MANIFESTO' | xargs shasum -a 256 > MANIFESTO.sha256 2>/dev/null && chmod 400 MANIFESTO.sha256 ) || true
  echo "evidencias preservadas em $dest"
}

on_interrupcao() {  # INT/TERM durante iniciar/testar/rodada: sem órfãos, sem destruição, com evidências
  local swb="$1"
  echo "INTERROMPIDO: encerrando SOMENTE a instancia validada e preservando evidencias" >&2
  : > "$swb/monitor.parar" 2>/dev/null || true
  : > "$swb/interrompido" 2>/dev/null || true
  encerrar_protegido "$swb" || true
  preservar_evidencias "$swb" interrompido
  exit 130
}

preflight() {
  gate_espaco antes
  [ -x "$PGB/initdb" ] && [ -x "$PGB/pg_ctl" ] && [ -x "$PGB/psql" ] && [ -x "$PGB/pg_isready" ] || falhar 2 "binarios do PostgreSQL 16 ausentes"
  if porta_ocupada; then falhar 2 "porta $PORTA ocupada ou leitura do lsof invalida (nunca vale como livre)"; fi
  # V15: a porta só é reutilizada se não houver NENHUM uso: nem listener TCP, nem socket Unix, nem arquivo de trava (`.s.PGSQL.55471[.lock]`), nem conexão TCP na porta. Erro, aviso ou saída irreconhecível de lsof/netstat BLOQUEIA:
  # só "lsof com status 1 e saída vazia" e "netstat com status 0, cabeçalho reconhecido e nenhuma linha da porta" provam porta livre.
  local s uso rc net
  command -v lsof >/dev/null 2>&1 && command -v netstat >/dev/null 2>&1 || falhar 2 "lsof e netstat sao obrigatorios para provar que a porta esta livre"
  for s in /tmp /private/tmp; do
    [ ! -e "$s/.s.PGSQL.$PORTA" ] && [ ! -e "$s/.s.PGSQL.$PORTA.lock" ] || falhar 2 "socket ou trava da porta $PORTA ja existe em $s; nada sera tocado"
  done
  uso=$(lsof -nP -i :"$PORTA" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then falhar 2 "a porta $PORTA tem algum uso (lsof); nada sera tocado"; fi
  if [ "$rc" -ne 1 ] || [ -n "$uso" ]; then falhar 2 "leitura do lsof invalida (status $rc ou saida/aviso inesperado): a porta nao pode ser tida como livre"; fi
  net=$(netstat -an -p tcp 2>&1) || falhar 2 "netstat falhou: a porta nao pode ser tida como livre"
  grep -q '^Active Internet connections' <<< "$net" || falhar 2 "saida do netstat irreconhecivel: a porta nao pode ser tida como livre"
  uso=$(awk -v p=".$PORTA" 'index($4, p) || index($5, p) { print }' <<< "$net") || falhar 2 "leitura do netstat invalida: a porta nao pode ser tida como livre"
  [ -z "$uso" ] || falhar 2 "a porta $PORTA aparece em conexao TCP (netstat); nada sera tocado"
  local p
  for p in $PROTEGIDAS; do "$PGB/pg_isready" -h 127.0.0.1 -p "$p" >/dev/null 2>&1 || echo "aviso: instancia protegida $p nao responde (apenas registro)"; done
  echo "instancias existentes (referencia, caminhos completos):"; instancias_existentes
  echo "preflight ok"
}

verificar() {  # I1..I8
  local swb="$1" pid dir porta_pid socket_pid v lista outras referencia ouvindo p rc8
  exigir_swb "$swb"
  [ -f "$swb/instancias-antes.txt" ] || falhar 4 "I7: lista de instancias de referencia ausente"
  [ -f "$swb/pgdata/postmaster.pid" ] || falhar 4 "I1: postmaster.pid ausente"
  pid=$(sed -n 1p "$swb/pgdata/postmaster.pid"); dir=$(sed -n 2p "$swb/pgdata/postmaster.pid"); porta_pid=$(sed -n 4p "$swb/pgdata/postmaster.pid"); socket_pid=$(sed -n 5p "$swb/pgdata/postmaster.pid")
  [[ "$pid" =~ ^[0-9]+$ ]] || falhar 4 "I1: pid invalido"
  [ "$dir" = "$swb/pgdata" ] || falhar 4 "I1: diretorio do postmaster.pid difere"
  [ "$porta_pid" = "$PORTA" ] || falhar 4 "I1: porta do postmaster.pid difere"
  [ "$socket_pid" = "$swb/sock" ] || falhar 4 "I1: socket do postmaster.pid difere"
  lista=$(instancias_existentes)
  contem_linha "$lista" "$pid|$swb/pgdata" || falhar 4 "I1: o processo $pid nao e a nossa instancia"
  [ "$(usuario_do_pid "$pid")" = "$(id -un)" ] || falhar 4 "I10: o dono do processo $pid nao e o usuario corrente"
  v=$(sql "$swb" postgres 'SHOW data_directory') || falhar 4 "I2: psql falhou"
  [ "$v" = "$swb/pgdata" ] || falhar 4 "I2: data_directory"
  v=$(sql "$swb" postgres 'SHOW port') || falhar 4 "I3: psql falhou (port)"
  [ "$v" = "$PORTA" ] || falhar 4 "I3: port"
  v=$(sql "$swb" postgres 'SHOW listen_addresses') || falhar 4 "I3: psql falhou (listen_addresses)"
  [ -z "$v" ] || falhar 4 "I3: listen_addresses nao vazio"
  v=$(sql "$swb" postgres 'SHOW unix_socket_directories') || falhar 4 "I4: psql falhou"
  [ "$v" = "$swb/sock" ] || falhar 4 "I4: unix_socket_directories"
  v=$(sql "$swb" gestao_epi_teste_local "SELECT current_user || '|' || current_database()") || falhar 4 "I5: psql falhou"
  [ "$v" = "swb_teste|gestao_epi_teste_local" ] || falhar 4 "I5: usuario/banco"
  v=$(sql "$swb" postgres "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database") || falhar 4 "I6: psql falhou"
  [ "$v" = "gestao_epi_teste_local,postgres,template0,template1" ] || falhar 4 "I6: bancos inesperados"
  v=$(sql "$swb" postgres "SELECT string_agg(name || '=' || setting, ';' ORDER BY array_position(ARRAY['temp_file_limit','max_wal_size','wal_keep_size','wal_level','archive_mode','logging_collector','max_connections'], name::text)) FROM pg_settings WHERE name IN ('temp_file_limit','max_wal_size','wal_keep_size','wal_level','archive_mode','logging_collector','max_connections')") || falhar 4 "I9: psql falhou"
  [ "$v" = "$CONFIG_ESPERADA" ] || falhar 4 "I9: configuracao de contencao diferente da esperada"
  # V15 (I8 fail-closed): só "lsof com status 1 e saída (stdout+stderr) vazia" prova que a instância não ouve em TCP; status 0 = ouve; erro, aviso ou status inesperado BLOQUEIA
  ouvindo=$(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>&1) && rc8=0 || rc8=$?
  if [ "$rc8" -eq 0 ]; then falhar 4 "I8: a instancia ouve em TCP"; fi
  if [ "$rc8" -ne 1 ] || [ -n "$ouvindo" ]; then falhar 4 "I8: leitura do lsof invalida (status $rc8 ou saida/aviso inesperado): nao e prova de ausencia de listener TCP"; fi
  outras=$(printf '%s\n' "$lista" | awk -v nosso="$pid|$swb/pgdata" '$0 != nosso')
  referencia=$(cat "$swb/instancias-antes.txt")
  [ "$outras" = "$referencia" ] || falhar 4 "I7: as instancias preexistentes mudaram"
  for p in $PROTEGIDAS; do "$PGB/pg_isready" -h 127.0.0.1 -p "$p" >/dev/null 2>&1 || echo "aviso I7: instancia protegida $p nao responde (registro)"; done
  echo "I1-I9 ok"
}

iniciar() {
  local swb="$1"
  exigir_swb "$swb"
  preflight
  orcamento_rodada_a antes-de-iniciar
  [ ! -e "$swb" ] || falhar 2 "diretorio ja existe (nunca reutilizar)"
  mkdir -m 700 "$swb" "$swb/pgdata" "$swb/sock"
  printf 'script_sha256=%s\ncriado_em=%s\nusuario=%s\n' "$(shasum -a 256 "$0" | awk '{print $1}')" "$(date -u +%Y%m%dT%H%M%SZ)" "$(id -un)" > "$swb/v15.marcador"
  registrar_base_orcamento "$swb"
  instancias_existentes > "$swb/instancias-antes.txt"
  # falha ou interrupção a partir daqui: encerra SÓ a instância validada (se houver) e preserva evidências; nada é apagado
  trap 'on_interrupcao "'"$swb"'"' INT TERM
  trap 'rc=$?; if [ $rc -ne 0 ]; then encerrar_protegido "'"$swb"'" || true; preservar_evidencias "'"$swb"'" falha-iniciar; fi' EXIT
  "$PGB/initdb" -D "$swb/pgdata" -U swb_teste --auth-local=trust --auth-host=reject -E UTF8 --locale=C --no-sync > "$swb/initdb.log" 2>&1 || falhar 4 "initdb falhou (ver $swb/initdb.log)"
  gate_espaco pos-initdb "$swb"
  "$PGB/pg_ctl" -D "$swb/pgdata" -l "$swb/pg.log" -w -o "$OPCOES_PG -c unix_socket_directories=$swb/sock" start > "$swb/pg_ctl-start.log" 2>&1 || falhar 4 "pg_ctl start falhou (ver $swb/pg_ctl-start.log)"
  sql "$swb" postgres "CREATE DATABASE gestao_epi_teste_local OWNER swb_teste" || falhar 4 "CREATE DATABASE falhou"
  ( umask 077; conteudo_env "$swb" > "$swb/instancia.env" )
  verificar "$swb"
  gate_espaco pos-verificacao "$swb"
  trap - INT TERM EXIT
  echo "instancia pronta em $swb"
}

testar() {
  local swb="$1" versao codigo=0
  exigir_swb "$swb"
  [ -f "$swb/instancia.env" ] || falhar 4 "instancia.env ausente"
  [ "$(cat "$swb/instancia.env")" = "$(conteudo_env "$swb")" ] || falhar 4 "instancia.env difere do esperado"
  gate_espaco pre-teste "$swb"
  verificar "$swb"
  [ -x "$NODE" ] || falhar 2 "node 22.23.3 ausente em $NODE (nvm)"
  versao=$("$NODE" -p 'process.versions.node') || falhar 2 "node nao respondeu"
  [ "$versao" = "22.23.3" ] || falhar 2 "node 22.23.3 e obrigatorio (encontrado $versao em $NODE)"
  echo "node=$versao ($NODE)"
  [ -d "$BACKEND" ] && [ -d "$DEPENDENCIAS" ] || falhar 2 "backend ou dependencias ausentes"
  local t
  for t in "${TESTES[@]}"; do [ -f "$BACKEND/$t" ] || falhar 2 "teste ausente: $t"; done
  [ "${#TESTES[@]}" -eq 1 ] && [ "${#SUITES_ESPERADAS[@]}" -eq 1 ] || falhar 2 "esta comprovacao executa exatamente 1 arquivo e confere 1 suite de topo"
  [ "$(printf '%s\n' "${TESTES[@]}" | sort -u | wc -l | tr -d ' ')" = "1" ] || falhar 2 "lista de testes com duplicidade"
  [ -x "$PGB/pg_dump" ] && [ -x "$PGB/pg_restore" ] || falhar 2 "pg_dump e pg_restore 16 ausentes em $PGB"
  # a G2 tem de estar no estado pos-Fase 2 do DEP-3: versoes lidas de node_modules (falha fechada; nunca do PATH nem do lock)
  local dv p v r
  for dv in "${DEPS_ESPERADAS[@]}"; do
    p="${dv%%:*}"; v="${dv##*:}"
    r=$("$NODE" -e 'const fs=require("node:fs"),path=require("node:path");const f=path.resolve(process.argv[1]);let j;try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{process.exit(3)}if(!j.version)process.exit(4);process.stdout.write(j.version)' "$BACKEND/node_modules/$p/package.json") || falhar 2 "$p nao instalado na G2"
    [ "$r" = "$v" ] || falhar 2 "$p instalado em $r; esta comprovacao exige $v (Fase 2 do DEP-3)"
    echo "dependencia $p=$r"
  done
  [ ! -e "$swb/monitor.parar" ] || falhar 2 "monitor.parar ja existe de uma rodada anterior; use outro diretorio"
  [ ! -e "$swb/orcamento-excedido" ] || falhar 3 "orcamento ja excedido nesta instancia; use outro diretorio"
  [ ! -e "$swb/rodada-a.tap" ] || falhar 2 "rodada-a.tap ja existe (teste anterior nesta instancia); use outro diretorio"
  orcamento_rodada_a antes-de-testar "$swb"
  # referência dos pg_dump/pg_restore reais já em execução ANTES do teste; só processos novos depois do teste contam como residuais (nenhum sinal é enviado)
  local pg_antes
  pg_antes=$(processos_pg) || falhar 7 "nao foi possivel registrar os processos pg_dump/pg_restore de referencia"
  printf '%s\n' "$pg_antes" > "$swb/processos-pg-antes.txt"
  # o monitor roda só durante o teste; o gancho de saída garante a sua parada mesmo em falha; interrupção encerra só a instância validada e preserva evidências
  trap 'on_interrupcao "'"$swb"'"' INT TERM
  trap 'rc=$?; : > "'"$swb"'/monitor.parar"; if [ $rc -ne 0 ]; then preservar_evidencias "'"$swb"'" falha-testar; encerrar_protegido "'"$swb"'" || true; preservar_evidencias "'"$swb"'" falha-testar-encerrado; fi' EXIT
  monitorar "$swb" &
  local monitor=$!
  ( cd "$BACKEND" && set -a && . "$swb/instancia.env" && set +a && export PATH="$NODE_BIN:$PATH" && export BACKUP_PG_BINARIOS="$PGB" && export SWB_CONS03=1 && NODE_PATH="$DEPENDENCIAS" "$NODE" --require ./test/setup.js --require ./test/integracao/exigir-banco-de-teste.js --test --test-concurrency=1 --test-timeout=300000 "${TESTES[@]}" ) > "$swb/rodada-a.tap" 2>&1 || codigo=$?
  : > "$swb/monitor.parar"
  wait "$monitor" || true
  awk '/^# (tests|pass|fail|cancelled|skipped|todo)/ || /^ℹ (tests|pass|fail|cancelled|skipped|todo)/' "$swb/rodada-a.tap"
  # as TRÊS suítes têm de aparecer no TAP como testes de topo (o node --test nomeia cada arquivo pelo caminho), nenhuma pulada, e fail 0 / skipped 0 / cancelled 0
  # o node --test nomeia os testes de topo pelo describe de cada arquivo: exige-se cada suíte por NOME, como teste de topo "ok" (nível 0, sem indentação)
  local n_suites=0 nome
  for nome in "${SUITES_ESPERADAS[@]}"; do
    if grep -E '^ok [0-9]+ - ' "$swb/rodada-a.tap" | grep -qF -- "$nome"; then n_suites=$((n_suites + 1)); else echo "suite de topo ausente ou reprovada no TAP: $nome" >&2; fi
  done
  [ "$n_suites" -eq 1 ] || { echo "suites de topo confirmadas: $n_suites/1" >&2; codigo=7; }
  local caso
  for caso in 01 02 03 04 05 06; do
    grep -qE "^ +ok [0-9]+ - C3-$caso " "$swb/rodada-a.tap" || { echo "caso C3-$caso ausente ou reprovado no TAP" >&2; codigo=7; }
  done
  [ "$(grep -c 'C3_OBSERVACAO_JSON' "$swb/rodada-a.tap")" -ge 6 ] || { echo "observacoes do ensaio CONS-03 ausentes no TAP" >&2; codigo=7; }
  # as duas provas do CONS-03 têm de estar no TAP: dump valido (PG_RESTORE_LIST_SUPERVISIONADO ok) e dump adulterado (estrutura nao ok); o TAP e a evidencia, nenhuma conclusao e inferida do codigo de saida
  grep -F 'C3_OBSERVACAO_JSON' "$swb/rodada-a.tap" | grep -F '"fase":"dump-valido"' | grep -qF '"origem":"PG_RESTORE_LIST_SUPERVISIONADO"' || { echo "observacao do dump valido ausente no TAP" >&2; codigo=7; }
  grep -F 'C3_OBSERVACAO_JSON' "$swb/rodada-a.tap" | grep -F '"fase":"dump-adulterado-composicao"' | grep -qF '"ok":false' || { echo "observacao do dump adulterado pela composicao ausente no TAP" >&2; codigo=7; }
  [ "$(grep -c 'GEPI_CI_EFEMERO' "$swb/rodada-a.tap")" -eq 0 ] || { echo "o TAP cita GEPI_CI_EFEMERO: o ensaio CONS-03 nao pode depender da flag da CI" >&2; codigo=7; }
  grep -qE "^# fail 0$" "$swb/rodada-a.tap" && grep -qE "^# skipped 0$" "$swb/rodada-a.tap" && grep -qE "^# cancelled 0$" "$swb/rodada-a.tap" || codigo=7
  [ ! -e "$swb/orcamento-excedido" ] || falhar 3 "orcamento ou reserva violados durante o teste; instancia parada; ver $swb"
  local bancos_restantes
  bancos_restantes=$(sql "$swb" postgres "SELECT datname FROM pg_database ORDER BY 1") || falhar 7 "nao foi possivel listar os bancos da instancia"
  [ "$bancos_restantes" = "$(printf 'gestao_epi_teste_local\npostgres\ntemplate0\ntemplate1')" ] || falhar 7 "a instancia tem bancos alem dos quatro de base apos o ensaio"
  [ -z "$(ls -d "$swb"/c3est-* 2>/dev/null)" ] || falhar 7 "a area de trabalho do ensaio (c3est-*) nao foi removida"
  # nenhum processo do ensaio pode restar. (1) wrapper/tail da area c3est-*: `ps` sem sinalizar nada (a área vai por ENVIRON para o awk não casar consigo mesmo); (2) pg_dump/pg_restore reais NOVOS desde o início do teste
  # (o `pg_restore --list` do lançador direto não tem o caminho da área na linha de comando). Qualquer residual BLOQUEIA: nunca sinalize por PID; identifique antes e siga o procedimento manual.
  local residuais lista_ps pg_depois novos
  lista_ps=$(ps -axww -o pid=,command=) || falhar 7 "ps falhou: nao foi possivel conferir processos residuais"
  residuais=$(AREA_PROC="$swb/c3est-" awk 'index($0, ENVIRON["AREA_PROC"]) { print }' <<< "$lista_ps") || falhar 7 "leitura de processos invalida"
  [ -z "$residuais" ] || falhar 7 "ha processo residual da area do ensaio; NAO sinalize: identifique antes (ver ps)"
  pg_depois=$(processos_pg) || falhar 7 "nao foi possivel listar pg_dump/pg_restore apos o teste"
  novos=$(comm -13 <(printf '%s\n' "$pg_antes") <(printf '%s\n' "$pg_depois")) || falhar 7 "comparacao de processos invalida"
  [ -z "$novos" ] || falhar 7 "ha pg_dump/pg_restore novo em execucao apos o teste (pids: $(printf '%s' "$novos" | tr '\n' ' ')); NAO sinalize: identifique antes (ps -o pid,ppid,pgid,command -p <pid>)"
  orcamento_rodada_a pos-teste "$swb"
  local papeis_restantes
  papeis_restantes=$(sql "$swb" postgres "SELECT count(*) FROM pg_roles WHERE rolname IN ('safework_backup_executor')") || falhar 7 "nao foi possivel conferir os papeis do ensaio"
  [ "$papeis_restantes" = "0" ] || falhar 7 "papeis do ensaio ainda existem na instancia apos o teste"
  gate_espaco pos-teste "$swb"
  verificar "$swb"
  [ "$codigo" -eq 0 ] || falhar 7 "teste reprovado (codigo $codigo); ver $swb/rodada-a.tap"
  trap - INT TERM EXIT
  : > "$swb/monitor.parar"
  preservar_evidencias "$swb" testar-ok
  echo "teste ok (1 suite de topo no TAP, 6 casos C3, fail 0, skipped 0, cancelled 0; verificacao estrutural real: dump valido, confirmacao independente, lancador real sobre copias adulteradas e dump adulterado pela composicao)"
}

encerrar() {
  local swb="$1" pid dir porta_pid socket_pid lista depois referencia p
  exigir_swb "$swb"
  [ -d "$swb" ] && [ -d "$swb/pgdata" ] && [ ! -L "$swb" ] && [ ! -L "$swb/pgdata" ] || falhar 5 "diretorio da instancia invalido"
  [ "$(cd "$swb" && pwd -P)" = "$swb" ] || falhar 5 "caminho nao canonico"
  [ -f "$swb/instancias-antes.txt" ] || falhar 5 "lista de referencia ausente"
  [ -f "$swb/pgdata/postmaster.pid" ] || falhar 5 "instancia nao esta em execucao (postmaster.pid ausente); nada a fazer"
  pid=$(sed -n 1p "$swb/pgdata/postmaster.pid"); dir=$(sed -n 2p "$swb/pgdata/postmaster.pid"); porta_pid=$(sed -n 4p "$swb/pgdata/postmaster.pid"); socket_pid=$(sed -n 5p "$swb/pgdata/postmaster.pid")
  [[ "$pid" =~ ^[0-9]+$ ]] || falhar 5 "pid invalido"
  [ "$dir" = "$swb/pgdata" ] || falhar 5 "postmaster.pid aponta outro diretorio"
  [ "$porta_pid" = "$PORTA" ] || falhar 5 "postmaster.pid registra outra porta"
  [ "$socket_pid" = "$swb/sock" ] || falhar 5 "postmaster.pid registra outro socket"
  lista=$(instancias_existentes)
  contem_linha "$lista" "$pid|$swb/pgdata" || { recuperacao_manual "$swb"; falhar 5 "o processo $pid nao e a nossa instancia"; }
  [ "$(usuario_do_pid "$pid")" = "$(id -un)" ] || { recuperacao_manual "$swb"; falhar 5 "I10: o dono do processo $pid nao e o usuario corrente"; }
  "$PGB/pg_ctl" -D "$swb/pgdata" -m fast -w stop > "$swb/pg_ctl-stop.log" 2>&1 || { recuperacao_manual "$swb"; falhar 5 "pg_ctl stop falhou (ver $swb/pg_ctl-stop.log); nao sinalize processos"; }
  [ ! -e "$swb/pgdata/postmaster.pid" ] || falhar 5 "postmaster.pid ainda existe"
  if porta_ocupada; then falhar 5 "porta $PORTA ainda ocupada"; fi
  depois=$(instancias_existentes)
  if [[ $'\n'"$depois"$'\n' == *"|$swb/pgdata"$'\n'* ]]; then falhar 5 "ainda ha processo da instancia"; fi
  printf '%s\n' "$depois" > "$swb/instancias-depois.txt"
  referencia=$(cat "$swb/instancias-antes.txt")
  [ "$depois" = "$referencia" ] || falhar 5 "as instancias preexistentes mudaram"
  for p in $PROTEGIDAS; do "$PGB/pg_isready" -h 127.0.0.1 -p "$p" >/dev/null 2>&1 || echo "aviso: instancia protegida $p nao responde"; done
  gate_espaco depois "$swb"
  preservar_evidencias "$swb" encerrar-ok
  echo "instancia preservada em $swb (remocao so com autorizacao propria)"
  echo "encerramento ok"
}

rodada() {  # preflight → iniciar → verificar → testar → encerrar, com preservação de evidências e encerramento protegido em QUALQUER saída
  local swb="$1"
  exigir_swb "$swb"
  # traps são globais no bash: iniciar/testar armam e desarmam os seus; a rodada rearma os dela depois de cada passo
  armar() {
    trap 'on_interrupcao "'"$swb"'"' INT TERM
    trap 'rc=$?; trap - INT TERM EXIT; if [ $rc -ne 0 ]; then echo "rodada interrompida/reprovada (codigo $rc): encerrando so a instancia validada e preservando evidencias" >&2; encerrar_protegido "'"$swb"'" || true; preservar_evidencias "'"$swb"'" falha-rodada; fi' EXIT
  }
  armar; iniciar "$swb"
  armar; verificar "$swb"
  armar; testar "$swb"
  armar; encerrar "$swb"
  trap - INT TERM EXIT
  echo "RODADA CONS-03 OK: verificacao estrutural real do dump (pg_restore --list supervisionado) GREEN em PostgreSQL 16 efemero (nivel 2; nao e homologacao Linux/AWS nem operacao; seis casos); instancia verificada e encerrada e PRESERVADA; evidencias em $EVID_RODADA_A; a limpeza e um passo a parte (limpar-verificar, depois limpar)"
}

mount_sob() {  # 0 se algum ponto de montagem é o próprio diretório ou está dentro dele (falha fechada: sem leitura de montagens, bloqueia)
  local swb="$1" pm lista
  lista=$(mount) || return 0
  while IFS= read -r pm; do
    case "$pm" in "$swb"|"$swb"/*) return 0 ;; esac
  done < <(printf '%s\n' "$lista" | sed -n 's/^.* on \(.*\) (.*$/\1/p')
  return 1
}

contar_achados() {  # contar_achados <rotulo> <saida do find>; saída vazia = 0 achados
  local n=0
  [ -z "$2" ] || n=$(printf '%s\n' "$2" | wc -l | tr -d ' ')
  [ "$n" = 0 ] || falhar 5 "$1 ($n): nada sera removido"
}

revalidar_alvo() {  # revalidar_alvo <swb>: TODA a identidade e o conteúdo do alvo; chamada no início e IMEDIATAMENTE antes de qualquer exclusão
  local swb="$1" lista dev_tmp dev_swb saida
  exigir_swb "$swb"
  [ -d "$swb" ] && [ ! -L "$swb" ] || falhar 5 "diretorio da instancia ausente ou link simbolico"
  [ "$(cd "$swb" && pwd -P)" = "$swb" ] || falhar 5 "caminho nao canonico"
  [ "$(dirname "$swb")" = "/private/tmp" ] || falhar 5 "a instancia nao esta em /private/tmp"
  [ "$(cd /private/tmp && pwd -P)" = "/private/tmp" ] || falhar 5 "/private/tmp nao e canonico"
  [ "$(stat -f '%Su' "$swb")" = "$(id -un)" ] || falhar 5 "o dono do diretorio nao e o usuario corrente"
  [ "$(stat -f '%Lp' "$swb")" = "700" ] || falhar 5 "o modo do diretorio nao e 0700"
  dev_tmp=$(stat -f '%d' /private/tmp) || falhar 5 "nao foi possivel ler o dispositivo de /private/tmp"
  dev_swb=$(stat -f '%d' "$swb") || falhar 5 "nao foi possivel ler o dispositivo do diretorio"
  [ "$dev_tmp" = "$dev_swb" ] || falhar 5 "o diretorio esta em dispositivo diferente de /private/tmp (ponto de montagem?)"
  if mount_sob "$swb"; then falhar 5 "o diretorio e ponto de montagem ou contem montagem"; fi
  [ -f "$swb/v15.marcador" ] && [ ! -L "$swb/v15.marcador" ] || falhar 5 "a instancia nao foi criada por esta versao (marcador ausente): nada sera removido"
  grep -qxF "script_sha256=$(shasum -a 256 "$0" | awk '{print $1}')" "$swb/v15.marcador" || falhar 5 "o marcador e de outra versao do script: nada sera removido"
  [ ! -e "$swb/pgdata/postmaster.pid" ] || falhar 5 "a instancia ainda esta em execucao (postmaster.pid existe)"
  lista=$(instancias_existentes) || falhar 5 "nao foi possivel listar processos"
  if [[ $'\n'"$lista"$'\n' == *"|$swb/pgdata"$'\n'* ]]; then falhar 5 "ha processo da instancia em execucao"; fi
  saida=$(find "$swb" -type l) || falhar 5 "falha ao varrer o diretorio (links)"
  contar_achados "link simbolico dentro do diretorio" "$saida"
  saida=$(find "$swb" ! -type d ! -type f ! -type s) || falhar 5 "falha ao varrer o diretorio (tipos)"
  contar_achados "arquivo especial dentro do diretorio (dispositivo, fifo ou outro)" "$saida"
  saida=$(find "$swb" ! -user "$(id -un)") || falhar 5 "falha ao varrer o diretorio (donos)"
  contar_achados "entrada de outro dono dentro do diretorio" "$saida"
  saida=$(find "$swb" -type f -links +1) || falhar 5 "falha ao varrer o diretorio (vinculos)"
  contar_achados "arquivo com mais de um vinculo dentro do diretorio" "$saida"
  saida=$(find "$swb" -type d -exec stat -f '%d' {} + | sort -u) || falhar 5 "falha ao varrer o diretorio (dispositivos)"
  [ "$saida" = "$dev_swb" ] || falhar 5 "subdiretorio em outro dispositivo: nada sera removido"
}

conferir_evidencias() {  # conferir_evidencias <swb>: define ENCONTRADOS (>= 1) ou bloqueia; só destinos encerrar-ok íntegros, de dono correto e sem links
  local swb="$1" dest tap_swb
  ENCONTRADOS=0
  [ -d "$EVID_RODADA_A" ] && [ ! -L "$EVID_RODADA_A" ] && [ "$(cd "$EVID_RODADA_A" && pwd -P)" = "$EVID_RODADA_A" ] || falhar 5 "diretorio de evidencias ausente, link ou nao canonico"
  [ -f "$swb/rodada-a.tap" ] && [ ! -L "$swb/rodada-a.tap" ] || falhar 5 "o TAP da instancia nao existe: as evidencias nao podem ter sido preservadas"
  tap_swb=$(shasum -a 256 "$swb/rodada-a.tap" | awk '{print $1}')
  for dest in "$EVID_RODADA_A"/pg-efemero-"$(basename "$swb")"-encerrar-ok-*; do
    [ -d "$dest" ] && [ ! -L "$dest" ] || continue
    [ "$(stat -f '%Su' "$dest")" = "$(id -un)" ] || continue
    [ -f "$dest/rodada-a.tap" ] && [ ! -L "$dest/rodada-a.tap" ] || continue
    [ -f "$dest/MANIFESTO.sha256" ] && [ ! -L "$dest/MANIFESTO.sha256" ] || continue
    [ "$(stat -f '%Lp' "$dest/MANIFESTO.sha256")" = "400" ] || continue
    grep -qE '^[0-9a-f]{64}  rodada-a\.tap$' "$dest/MANIFESTO.sha256" || continue
    [ "$(shasum -a 256 "$dest/rodada-a.tap" | awk '{print $1}')" = "$tap_swb" ] || continue
    ( cd "$dest" && shasum -a 256 -c MANIFESTO.sha256 > /dev/null 2>&1 ) || continue
    ENCONTRADOS=$((ENCONTRADOS + 1))
  done
  [ "$ENCONTRADOS" -ge 1 ] || falhar 5 "evidencias preservadas e conferidas (encerrar-ok) nao encontradas em $EVID_RODADA_A: nada sera removido"
}

limpar() {  # limpar <swb> <verificar|executar>: remove SÓ a instância criada por esta versão, parada, íntegra e com evidências conferidas; nunca faz parte de `rodada`
  local swb="$1" modo="$2" usado
  revalidar_alvo "$swb"
  conferir_evidencias "$swb"
  usado=$(du -sk "$swb" 2>/dev/null | awk '{print $1}' || true)
  printf 'limpeza[%s]: %s (%s KiB); evidencias conferidas em %s destino(s) de %s\n' "$modo" "$swb" "${usado:-?}" "$ENCONTRADOS" "$EVID_RODADA_A"
  [ "$modo" = "executar" ] || { echo "modo verificar: nada foi removido"; return 0; }
  [ "${SWB_CONFIRMO_LIMPEZA:-}" = "$(basename "$swb")" ] || falhar 5 "confirmacao ausente: defina SWB_CONFIRMO_LIMPEZA=$(basename "$swb")"
  revalidar_alvo "$swb"
  conferir_evidencias "$swb"
  rm -rf -- "$swb"
  [ ! -e "$swb" ] || falhar 5 "a remocao ficou incompleta"
  echo "instancia removida: $swb (evidencias preservadas em $EVID_RODADA_A)"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    preflight|iniciar|verificar|testar|encerrar|rodada|limpar-verificar|limpar) gate_hash; conter_recursos ;;
  esac
  case "$cmd" in
    preflight) preflight ;;
    iniciar) iniciar "${2:-}" ;;
    verificar) verificar "${2:-}" ;;
    testar) testar "${2:-}" ;;
    encerrar) encerrar "${2:-}" ;;
    rodada) rodada "${2:-}" ;;
    limpar-verificar) limpar "${2:-}" verificar ;;
    limpar) limpar "${2:-}" executar ;;
    *) falhar 2 "uso: $0 <preflight|iniciar|verificar|testar|encerrar|rodada|limpar-verificar|limpar> [DIRETORIO_SWB]" ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
