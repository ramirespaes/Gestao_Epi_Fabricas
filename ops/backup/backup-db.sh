#!/usr/bin/env bash
# E1 — backup do PostgreSQL 16 (pg_dump -Fc) com validação por pg_restore --list e manifesto parcial.
# Somente leitura sobre o banco. Configuração por variáveis de ambiente (ver config/backup.env.exemplo).
# Códigos de saída: 0 ok; 2 configuração; 3 destino; 4 ferramenta ausente; 5 pg_dump; 6 índice do dump; 7 manifesto.
set -u
set -o pipefail
umask 077

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/comum.sh
. "$AQUI/lib/comum.sh"

NOME="${BACKUP_DB_NOME:-}"
DESTINO="${BACKUP_DESTINO:-}"
REPO_RAIZ="${BACKUP_REPO_RAIZ:-$(cd "$AQUI/../.." && pwd -P)}"
RUN_ID=""
DIR_EXEC=""

recusar() {
  echo "ERRO $2" >&2
  exit "$1"
}

falhar() {
  local codigo="$1" nome="$2"
  if [ -n "$DIR_EXEC" ] && [ -d "$DIR_EXEC" ]; then
    rm -f "$DIR_EXEC/banco.dump" "$DIR_EXEC/toc.txt" "$DIR_EXEC/MANIFEST.json" "$DIR_EXEC/MANIFEST.json.sha256"
    printf '{\n  "run_id": "%s",\n  "codigo": "%s",\n  "saida": %s,\n  "em": "%s"\n}\n' \
      "$RUN_ID" "$nome" "$codigo" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR_EXEC/falha.json"
    log_registro "$DIR_EXEC/registro.log" "FALHA $nome"
    publicar_execucao "$DIR_EXEC" "$DESTINO/FALHA-$RUN_ID"
    case "$?" in
      0) ;;
      1) echo "ERRO E_RUN_ID_EXISTENTE" >&2; exit 3 ;;
      *) echo "ERRO E_PUBLICACAO_LOCAL" >&2 ;;
    esac
  fi
  echo "ERRO $nome" >&2
  exit "$codigo"
}

# 1. configuração
if [ -z "$NOME" ] || [ -z "$DESTINO" ]; then recusar 2 E_CONFIG; fi
if ! printf '%s' "$NOME" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$'; then recusar 2 E_CONFIG; fi

# 2. destino privado e fora de área sincronizada
if caminho_sincronizado "$DESTINO"; then recusar 3 E_DESTINO_SINCRONIZADO; fi
exigir_diretorio_privado "$DESTINO" 2>/dev/null || recusar 3 E_DESTINO_INSEGURO
DESTINO="$(cd "$DESTINO" && pwd -P)"

# 3. ferramentas
if [ -n "${BACKUP_PG_BIN:-}" ]; then
  PG_BIN="$BACKUP_PG_BIN"
elif command -v pg_dump >/dev/null 2>&1; then
  PG_BIN="$(dirname "$(command -v pg_dump)")"
else
  PG_BIN=""
fi
PG_DUMP="$PG_BIN/pg_dump"
PG_RESTORE="$PG_BIN/pg_restore"
if [ -z "$PG_BIN" ] || [ ! -x "$PG_DUMP" ] || [ ! -x "$PG_RESTORE" ] || ! command -v node >/dev/null 2>&1; then
  recusar 4 E_FERRAMENTA_AUSENTE
fi
VERSAO_PG_DUMP="$("$PG_DUMP" --version 2>/dev/null | head -n 1)"

# 4. execução
RUN_ID="$(gerar_run_id)"
run_id_livre "$DESTINO" "$RUN_ID" || recusar 3 E_RUN_ID_EXISTENTE
DIR_EXEC="$DESTINO/.em-andamento-$RUN_ID"
mkdir "$DIR_EXEC" || recusar 3 E_DESTINO_INSEGURO
trap 'falhar 130 E_INTERROMPIDO' INT TERM
REGISTRO="$DIR_EXEC/registro.log"
log_registro "$REGISTRO" "inicio run_id=$RUN_ID banco=$NOME"

log_registro "$REGISTRO" "pg_dump formato custom"
if ! "$PG_DUMP" --format=custom --no-password --file="$DIR_EXEC/banco.dump" --dbname="$NOME" 2> "$DIR_EXEC/pg_dump.stderr"; then
  head -c 4096 "$DIR_EXEC/pg_dump.stderr" > "$DIR_EXEC/pg_dump.stderr.tmp" && mv "$DIR_EXEC/pg_dump.stderr.tmp" "$DIR_EXEC/pg_dump.stderr"
  falhar 5 E_PGDUMP_FALHOU
fi
[ -s "$DIR_EXEC/banco.dump" ] || falhar 5 E_PGDUMP_FALHOU

log_registro "$REGISTRO" "validacao por pg_restore --list"
if ! "$PG_RESTORE" --list "$DIR_EXEC/banco.dump" > "$DIR_EXEC/toc.txt" 2> "$DIR_EXEC/pg_restore.stderr"; then
  falhar 6 E_TOC_INVALIDO
fi
if ! awk '!/^;/ && NF > 0 { achou = 1 } END { exit achou ? 0 : 1 }' "$DIR_EXEC/toc.txt"; then
  if [ "${BACKUP_PERMITIR_BANCO_VAZIO:-0}" = "1" ]; then
    log_registro "$REGISTRO" "AVISO indice vazio permitido explicitamente (banco sem objetos de usuario)"
  else
    falhar 6 E_TOC_INVALIDO
  fi
fi

log_registro "$REGISTRO" "manifesto parcial"
if ! node "$AQUI/lib/manifesto.js" gerar "$DIR_EXEC" --run-id "$RUN_ID" --banco "$NOME" \
  --versao-pg-dump "$VERSAO_PG_DUMP" --host "$(hostname -s 2>/dev/null || echo desconhecido)" --repo-raiz "$REPO_RAIZ" >/dev/null 2>&1; then
  falhar 7 E_MANIFESTO
fi
if ! node "$AQUI/lib/manifesto.js" verificar "$DIR_EXEC" >/dev/null 2>&1; then falhar 7 E_MANIFESTO; fi

log_registro "$REGISTRO" "concluido"
trap - INT TERM
publicar_execucao "$DIR_EXEC" "$DESTINO/$RUN_ID"
case "$?" in
  0) ;;
  1) recusar 3 E_RUN_ID_EXISTENTE ;;
  *) recusar 7 E_PUBLICACAO_LOCAL ;;
esac
printf '{"status":"OK","run_id":"%s","diretorio":"%s"}\n' "$RUN_ID" "$DESTINO/$RUN_ID"
