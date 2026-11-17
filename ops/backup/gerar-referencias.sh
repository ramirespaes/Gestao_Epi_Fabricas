#!/usr/bin/env bash
# E2-R — gera as referências (NDJSON) de imagens e Fiscalização a partir do banco.dump de uma execução do E1.
# Lê só o arquivo do dump (pg_restore); não abre conexão com nenhum banco e não passa variáveis de conexão ao pg_restore.
#
# Uso: BACKUP_REFS_DESTINO=<dir 0700> BACKUP_DB_EXEC=<execução do backup-db.sh> [BACKUP_PG_BIN=<dir do pg_restore>] \
#      bash gerar-referencias.sh --fonte imagens [--fonte fiscalizacao-pacotes]
#
# Códigos: 0 ok; 2 configuração/banco/fonte; 3 destino; 4 ferramenta ausente; 5 extração, tabela ausente ou dados inválidos.
set -u
set -o pipefail
umask 077

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/comum.sh
. "$AQUI/lib/comum.sh"

DESTINO="${BACKUP_REFS_DESTINO:-}"
RUN_ID=""
DIR_EXEC=""

recusar() {
  echo "ERRO $2" >&2
  exit "$1"
}

descartar_execucao_vazia() {
  case "$(basename "$DIR_EXEC")" in
    .em-andamento-*) rm -rf "$DIR_EXEC" ;;
  esac
}

falhar() {
  local codigo="$1" nome="$2"
  if [ -n "$DIR_EXEC" ] && [ -d "$DIR_EXEC" ]; then
    rm -f "$DIR_EXEC"/refs-*.ndjson "$DIR_EXEC/REFERENCIAS-META.json" "$DIR_EXEC/REFERENCIAS-META.json.sha256"
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

if [ -z "$DESTINO" ]; then recusar 2 E_CONFIG; fi
if caminho_sincronizado "$DESTINO"; then recusar 3 E_DESTINO_SINCRONIZADO; fi
exigir_diretorio_privado "$DESTINO" 2>/dev/null || recusar 3 E_DESTINO_INSEGURO
DESTINO="$(cd "$DESTINO" && pwd -P)"

command -v node >/dev/null 2>&1 || recusar 4 E_FERRAMENTA_AUSENTE
if [ -n "${BACKUP_PG_BIN:-}" ]; then
  PG_BIN="$BACKUP_PG_BIN"
elif command -v pg_restore >/dev/null 2>&1; then
  PG_BIN="$(dirname "$(command -v pg_restore)")"
else
  PG_BIN=""
fi
PG_RESTORE="$PG_BIN/pg_restore"
if [ -z "$PG_BIN" ] || [ ! -x "$PG_RESTORE" ]; then recusar 4 E_FERRAMENTA_AUSENTE; fi

RUN_ID="$(gerar_run_id)"
run_id_livre "$DESTINO" "$RUN_ID" || recusar 3 E_RUN_ID_EXISTENTE
DIR_EXEC="$DESTINO/.em-andamento-$RUN_ID"
mkdir "$DIR_EXEC" || recusar 3 E_DESTINO_INSEGURO
trap 'falhar 130 E_INTERROMPIDO' INT TERM
REGISTRO="$DIR_EXEC/registro.log"
log_registro "$REGISTRO" "inicio run_id=$RUN_ID"

ARGS=(gerar "$DIR_EXEC" --run-id "$RUN_ID" --pg-restore "$PG_RESTORE" --hospedeiro "$(hostname -s 2>/dev/null || echo desconhecido)")
if [ -n "${BACKUP_DB_EXEC:-}" ]; then ARGS+=(--banco-exec "$BACKUP_DB_EXEC"); fi

log_registro "$REGISTRO" "extracao a partir do dump"
node "$AQUI/lib/referencias.js" "${ARGS[@]}" "$@" > "$DIR_EXEC/saida.json" 2> "$DIR_EXEC/erro.txt"
SAIDA=$?
CODIGO_ERRO="$(sed -n 's/^ERRO //p' "$DIR_EXEC/erro.txt" | head -n 1)"
printf '%s' "$CODIGO_ERRO" | grep -Eq '^E_[A-Z_]+$' || CODIGO_ERRO="E_INESPERADO"
rm -f "$DIR_EXEC/erro.txt"
trap - INT TERM

case "$SAIDA" in
  0)
    log_registro "$REGISTRO" "concluido"
    rm -f "$DIR_EXEC/saida.json"
    publicar_execucao "$DIR_EXEC" "$DESTINO/$RUN_ID"
    case "$?" in
      0) ;;
      1) recusar 3 E_RUN_ID_EXISTENTE ;;
      *) recusar 5 E_PUBLICACAO_LOCAL ;;
    esac
    printf '{"status":"OK","run_id":"%s","diretorio":"%s"}\n' "$RUN_ID" "$DESTINO/$RUN_ID"
    ;;
  2|4)
    descartar_execucao_vazia
    recusar "$SAIDA" "$CODIGO_ERRO"
    ;;
  *)
    rm -f "$DIR_EXEC/saida.json"
    falhar "$SAIDA" "$CODIGO_ERRO"
    ;;
esac
