#!/usr/bin/env bash
# Funções comuns do backup (E1). Portável entre macOS e Linux. Não imprime ambiente nem segredos.

sha256_arquivo() {
  local arq="$1"
  [ -f "$arq" ] || { echo "E_ARQUIVO_AUSENTE" >&2; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$arq" | awk '{print $1}'
  else
    shasum -a 256 "$arq" | awk '{print $1}'
  fi
}

gerar_run_id() {
  local sufixo
  sufixo="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$sufixo"
}

modo_octal() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

dono_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

exigir_diretorio_privado() {
  local d="$1"
  if [ ! -d "$d" ] || [ "$(modo_octal "$d")" != "700" ] || [ "$(dono_uid "$d")" != "$(id -u)" ]; then
    echo "E_DESTINO_INSEGURO" >&2
    return 1
  fi
}

# Resolve o caminho real mesmo quando o final ainda não existe.
caminho_resolvido() {
  local alvo="$1" resto="" base
  while [ ! -d "$alvo" ] && [ "$alvo" != "/" ] && [ "$alvo" != "." ]; do
    resto="/$(basename "$alvo")$resto"
    alvo="$(dirname "$alvo")"
  done
  base="$(cd "$alvo" 2>/dev/null && pwd -P)" || return 1
  printf '%s%s\n' "$base" "$resto"
}

caminho_sincronizado() {
  local p home=""
  p="$(caminho_resolvido "$1")" || return 0
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    home="$(cd "$HOME" && pwd -P)"
  fi
  if [ -n "$home" ]; then
    case "$p" in
      "$home"/Desktop|"$home"/Desktop/*|"$home"/Documents|"$home"/Documents/*|"$home"/Library/Mobile\ Documents|"$home"/Library/Mobile\ Documents/*|"$home"/Library/CloudStorage|"$home"/Library/CloudStorage/*) return 0 ;;
    esac
  fi
  case "$p" in
    */Dropbox|*/Dropbox/*|*/OneDrive*|*/Google\ Drive|*/Google\ Drive/*|*/iCloud*|*/Mobile\ Documents/*) return 0 ;;
  esac
  return 1
}

# 0 se nenhum nome de execução com este run_id existe no destino (final, FALHA-, NAOPUBLICAVEL- ou em andamento; link, mesmo quebrado, conta como existente).
run_id_livre() {
  local d="$1" id="$2" prefixo
  for prefixo in "" "FALHA-" "NAOPUBLICAVEL-" ".em-andamento-"; do
    if [ -e "$d/$prefixo$id" ] || [ -L "$d/$prefixo$id" ]; then return 1; fi
  done
  return 0
}

# Publica a execução sem nunca sobrescrever nem aninhar: reserva o nome final com mkdir (atômico; falha se o nome já existir,
# mesmo vazio) e só então troca a reserva vazia, criada aqui, pela execução com rename(2). Se algo for colocado na reserva
# antes da troca, o rename falha (ENOTEMPTY) e nada do que existe é tocado. Retorna 0; 1 = nome já existe (colisão real);
# 2 = falha operacional (sem espaço, permissão, rename): o nome não existe e a execução permanece intacta na origem.
publicar_execucao() {
  local origem="$1" final="$2"
  if ! mkdir "$final" 2>/dev/null; then
    if [ -e "$final" ] || [ -L "$final" ]; then return 1; fi
    return 2
  fi
  if ! node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" "$origem" "$final" 2>/dev/null; then
    rmdir "$final" 2>/dev/null
    return 2
  fi
}

log_registro() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >> "$1"
}
