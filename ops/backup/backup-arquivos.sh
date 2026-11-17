#!/usr/bin/env bash
# E2 — cópia dos arquivos persistentes para um destino local, depois do backup do banco (errata E-65-01).
# Só lê as origens. Fingerprints F0/F1 por fonte, até 3 tentativas, SHA-256 por arquivo e manifesto.
#
# Uso: BACKUP_DESTINO=<dir 0700> BACKUP_DB_EXEC=<diretório de execução do backup-db.sh> \
#      bash backup-arquivos.sh --fonte <id>=<dir absoluto> [--fonte ...] [--referencias <id>=<arquivo.ndjson> ...]
# Opcionais: BACKUP_DB_IDADE_MAX_S (padrão 3600), BACKUP_TENTATIVAS (1 a 3; padrão 3), BACKUP_LIMITE_BYTES (padrão 20 GiB).
#
# Códigos: 0 publicável; 2 configuração/ordem banco→arquivos; 3 destino; 4 ferramenta; 5 falha de cópia;
#          10 referências não verificadas; 11 alteração concorrente; 12 referências faltantes ou divergentes.
set -u
set -o pipefail
umask 077

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/comum.sh
. "$AQUI/lib/comum.sh"

DESTINO="${BACKUP_DESTINO:-}"
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
    rm -rf "$DIR_EXEC/tentativas"
    rm -f "$DIR_EXEC/MANIFEST-ARQUIVOS.json" "$DIR_EXEC/MANIFEST-ARQUIVOS.json.sha256"
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

RUN_ID="$(gerar_run_id)"
run_id_livre "$DESTINO" "$RUN_ID" || recusar 3 E_RUN_ID_EXISTENTE
DIR_EXEC="$DESTINO/.em-andamento-$RUN_ID"
mkdir "$DIR_EXEC" || recusar 3 E_DESTINO_INSEGURO
trap 'falhar 130 E_INTERROMPIDO' INT TERM
REGISTRO="$DIR_EXEC/registro.log"
log_registro "$REGISTRO" "inicio run_id=$RUN_ID"

ARGS=(copiar "$DIR_EXEC" --run-id "$RUN_ID" --host "$(hostname -s 2>/dev/null || echo desconhecido)")
if [ -n "${BACKUP_DB_EXEC:-}" ]; then ARGS+=(--banco-exec "$BACKUP_DB_EXEC"); fi
if [ -n "${BACKUP_DB_IDADE_MAX_S:-}" ]; then ARGS+=(--banco-idade-max-s "$BACKUP_DB_IDADE_MAX_S"); fi
if [ -n "${BACKUP_TENTATIVAS:-}" ]; then ARGS+=(--tentativas "$BACKUP_TENTATIVAS"); fi
if [ -n "${BACKUP_LIMITE_BYTES:-}" ]; then ARGS+=(--limite-bytes "$BACKUP_LIMITE_BYTES"); fi

log_registro "$REGISTRO" "copia controlada (banco primeiro, arquivos depois)"
node "$AQUI/lib/arquivos.js" "${ARGS[@]}" "$@" > "$DIR_EXEC/saida.json" 2> "$DIR_EXEC/erro.txt"
SAIDA=$?
CODIGO_ERRO="$(sed -n 's/^ERRO //p' "$DIR_EXEC/erro.txt" | head -n 1)"
printf '%s' "$CODIGO_ERRO" | grep -Eq '^E_[A-Z_]+$' || CODIGO_ERRO="E_INESPERADO"
rm -f "$DIR_EXEC/erro.txt"
trap - INT TERM

case "$SAIDA" in
  0)
    log_registro "$REGISTRO" "concluido publicavel"
    rm -f "$DIR_EXEC/saida.json"
    publicar_execucao "$DIR_EXEC" "$DESTINO/$RUN_ID"
    case "$?" in
      0) ;;
      1) recusar 3 E_RUN_ID_EXISTENTE ;;
      *) recusar 5 E_PUBLICACAO_LOCAL ;;
    esac
    printf '{"status":"OK","run_id":"%s","diretorio":"%s"}\n' "$RUN_ID" "$DESTINO/$RUN_ID"
    ;;
  10|11|12)
    log_registro "$REGISTRO" "concluido NAO PUBLICAVEL codigo=$SAIDA"
    rm -f "$DIR_EXEC/saida.json"
    publicar_execucao "$DIR_EXEC" "$DESTINO/NAOPUBLICAVEL-$RUN_ID"
    case "$?" in
      0) ;;
      1) recusar 3 E_RUN_ID_EXISTENTE ;;
      *) recusar 5 E_PUBLICACAO_LOCAL ;;
    esac
    printf '{"status":"NAO_PUBLICAVEL","run_id":"%s","diretorio":"%s","saida":%s}\n' "$RUN_ID" "$DESTINO/NAOPUBLICAVEL-$RUN_ID" "$SAIDA"
    exit "$SAIDA"
    ;;
  2)
    descartar_execucao_vazia
    recusar 2 "$CODIGO_ERRO"
    ;;
  *)
    rm -f "$DIR_EXEC/saida.json"
    falhar "$SAIDA" "$CODIGO_ERRO"
    ;;
esac
