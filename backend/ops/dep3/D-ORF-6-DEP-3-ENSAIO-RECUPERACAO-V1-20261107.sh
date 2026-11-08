#!/bin/bash
# D-ORF-6 — DEP-3 — ENSAIO ISOLADO DE RECUPERAÇÃO POR SNAPSHOT — V1 (07/11/2026). PREPARADO, NÃO EXECUTADO.
# Comprova, SEM npm e SEM tocar o worktree, que a lógica de snapshot/reversão do gate V2 recupera package.json, package-lock.json e
# node_modules a um estado idêntico (hash a hash) depois de uma alteração SINTÉTICA controlada. Tudo acontece numa CÓPIA em
# ~/SafeWorkDados/dep3-ensaio/recuperacao-<instante>/ (criada aqui, nunca reutilizada, nunca apagada). O gate V2 não é alterado.
# Uso: ENSAIO_SHA256=<hash aprovado deste script> bash D-ORF-6-DEP-3-ENSAIO-RECUPERACAO-V1-20261107.sh
# Passos: (1) cópia do backend (package.json, lock, node_modules) → (2) hashes do estado ORIGINAL → (3) snapshot no formato do V2
# (ARQUIVOS.sha256 + DIGEST.txt) → (4) alteração sintética: campo "swbEnsaio" no lock, faixa do zod no package.json, arquivo novo e
# arquivo alterado em node_modules → (5) prova de que a alteração foi detectada (hashes diferem) → (6) reversão com a MESMA lógica do
# V2 (conferir snapshot, preservar estado alterado, repor os três, reconferir) → (7) estado restaurado == ORIGINAL (hash a hash e
# digest) → recibo. Qualquer passo falho reprova e para; nada do worktree é lido para escrita.
set -euo pipefail

G2="${G2:-/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104}"
BRANCH_ESPERADA="feature/d-orf-6-rodada-a-r2-r3-20261107"
NODE_BIN="$HOME/.nvm/versions/node/v22.23.3/bin"; NODE="$NODE_BIN/node"
RESERVA_GIB=40; ORCAMENTO_KIB=19531250
EVID="$HOME/SafeWorkDados/dep3-evidencias-20261107"
BASE="$HOME/SafeWorkDados/dep3-ensaio"
INSTANTE="$(date -u +%Y%m%dT%H%M%SZ)"
DIRETORIOS_DA_RODADA=("$HOME/SafeWorkDados/dep3-ensaio" "$HOME/SafeWorkDados/dep3-snapshots" "$EVID" "$HOME/SafeWorkDados/d-orf-6-rodada-a-evidencias-20261107")

falhar() { echo "REPROVADO: $*" >&2; exit 1; }
info() { echo "== $*"; }
digest_nm() { ( cd "$1" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 ); }
hashes_arquivos() { ( cd "$1" && shasum -a 256 package.json package-lock.json ); }

PROPRIO="$(shasum -a 256 "$0" | cut -c1-64)"; echo "ensaio_sha256=$PROPRIO"
[ -n "${ENSAIO_SHA256:-}" ] && [ "$ENSAIO_SHA256" = "$PROPRIO" ] || falhar "ENSAIO_SHA256 ausente ou diferente do aprovado"
[ -x "$NODE" ] || falhar "Node 22.23.3 ausente"
cd "$G2"; [ "$(git branch --show-current)" = "$BRANCH_ESPERADA" ] || falhar "branch diferente de $BRANCH_ESPERADA"
git diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "package.json/lock do worktree ja diferem do HEAD; o ensaio parte do estado aprovado"
LIVRE_GIB="$(df -g . | awk 'NR==2{print $4}')"; [ "$LIVRE_GIB" -ge "$RESERVA_GIB" ] || falhar "so $LIVRE_GIB GiB livres"
TOTAL=0; for d in "${DIRETORIOS_DA_RODADA[@]}"; do [ -d "$d" ] && TOTAL=$((TOTAL + $(du -sk "$d" | awk '{print $1}'))); done
for d in /private/tmp/swb-*; do [ -d "$d" ] && TOTAL=$((TOTAL + $(du -sk "$d" | awk '{print $1}'))); done
NM_KIB="$(du -sk backend/node_modules | awk '{print $1}')"
echo "orcamento-rodada-a: usados=$TOTAL KiB; este ensaio acrescenta ~$((NM_KIB * 3)) KiB (copia + snapshot + preservado)"
[ $((TOTAL + NM_KIB * 3)) -le "$ORCAMENTO_KIB" ] || falhar "o ensaio estouraria o orcamento unico de 20 GB da Rodada A"

RECIBO="$EVID/execucoes/ensaio-recuperacao-$INSTANTE"; [ ! -e "$RECIBO" ] || falhar "recibo ja existe"
COPIA="$BASE/recuperacao-$INSTANTE"; [ ! -e "$COPIA" ] || falhar "copia ja existe (nunca reutilizar)"
mkdir -p "$RECIBO" "$COPIA" && chmod 700 "$EVID" "$RECIBO" "$BASE" "$COPIA"
{ echo "ensaio=recuperacao instante=$INSTANTE ensaio_sha256=$PROPRIO"; echo "branch=$(git branch --show-current) head=$(git rev-parse HEAD)"; echo "copia=$COPIA"; } > "$RECIBO/cabecalho.txt"

info "(1) copia isolada do backend (package.json, lock, node_modules)"
cp -p backend/package.json backend/package-lock.json "$COPIA/" && cp -a backend/node_modules "$COPIA/node_modules"
git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "o worktree mudou durante a copia"

info "(2) hashes do estado ORIGINAL"
hashes_arquivos "$COPIA" | tee "$RECIBO/original.arquivos.sha256"
ORIG_DIG="$(digest_nm "$COPIA")"; echo "digest_original=$ORIG_DIG" | tee "$RECIBO/original.digest.txt"

info "(3) snapshot no formato do gate V2"
SNAP="$COPIA/snapshot"; mkdir -m 700 "$SNAP"
cp -p "$COPIA/package.json" "$COPIA/package-lock.json" "$SNAP/" && cp -a "$COPIA/node_modules" "$SNAP/node_modules"
( cd "$SNAP" && shasum -a 256 package.json package-lock.json > ARQUIVOS.sha256 && echo "$(digest_nm "$SNAP")" > DIGEST.txt )
[ "$(cat "$SNAP/DIGEST.txt")" = "$ORIG_DIG" ] || falhar "snapshot nao reproduz o digest original"
cp -p "$SNAP/ARQUIVOS.sha256" "$RECIBO/snapshot.ARQUIVOS.sha256"; cp -p "$SNAP/DIGEST.txt" "$RECIBO/snapshot.DIGEST.txt"

info "(4) alteracao SINTETICA controlada na copia (simula um update que mudou lock, package.json e node_modules)"
"$NODE" -e 'const fs=require("node:fs");const p=process.argv[1];const l=JSON.parse(fs.readFileSync(p+"/package-lock.json","utf8"));l.swbEnsaio={instante:process.argv[2]};fs.writeFileSync(p+"/package-lock.json",JSON.stringify(l,null,2)+"\n");const j=JSON.parse(fs.readFileSync(p+"/package.json","utf8"));j.dependencies.zod="^9.9.9";fs.writeFileSync(p+"/package.json",JSON.stringify(j,null,2)+"\n");' "$COPIA" "$INSTANTE"
echo "ensaio $INSTANTE" > "$COPIA/node_modules/.swb-ensaio-arquivo-novo"
ALVO="$(cd "$COPIA" && find node_modules -maxdepth 2 -name package.json -type f | head -1)"; [ -n "$ALVO" ] || falhar "nenhum package.json em node_modules para alterar"
printf '\n' >> "$COPIA/$ALVO"
echo "alterados: package-lock.json (campo swbEnsaio), package.json (zod ^9.9.9), node_modules/.swb-ensaio-arquivo-novo (novo), $ALVO (byte acrescentado)" | tee "$RECIBO/alteracao-sintetica.txt"

info "(5) a alteracao e detectavel: hashes e digest diferem do original"
hashes_arquivos "$COPIA" | tee "$RECIBO/alterado.arquivos.sha256"
diff -q "$RECIBO/original.arquivos.sha256" "$RECIBO/alterado.arquivos.sha256" > /dev/null && falhar "package.json/lock nao mudaram (alteracao sintetica falhou)"
ALT_DIG="$(digest_nm "$COPIA")"; echo "digest_alterado=$ALT_DIG" | tee "$RECIBO/alterado.digest.txt"
[ "$ALT_DIG" != "$ORIG_DIG" ] || falhar "node_modules nao mudou (alteracao sintetica falhou)"

info "(6) reversao com a MESMA logica do modo reverter do gate V2"
( cd "$SNAP" && shasum -a 256 -c ARQUIVOS.sha256 ) | tee -a "$RECIBO/reversao.txt" || falhar "snapshot: ARQUIVOS.sha256 nao confere"
[ "$(digest_nm "$SNAP")" = "$(cat "$SNAP/DIGEST.txt")" ] || falhar "snapshot: digest nao confere"
cp -p "$COPIA/package.json" "$RECIBO/package.alterado.json"; cp -p "$COPIA/package-lock.json" "$RECIBO/package-lock.alterado.json"
mv "$COPIA/node_modules" "$COPIA/node_modules.alterado-preservado"
cp -p "$SNAP/package.json" "$COPIA/package.json"; cp -p "$SNAP/package-lock.json" "$COPIA/package-lock.json"; cp -a "$SNAP/node_modules" "$COPIA/node_modules"

info "(7) estado restaurado == ORIGINAL"
hashes_arquivos "$COPIA" | tee "$RECIBO/restaurado.arquivos.sha256"
diff "$RECIBO/original.arquivos.sha256" "$RECIBO/restaurado.arquivos.sha256" || falhar "package.json/lock restaurados diferem do original"
REST_DIG="$(digest_nm "$COPIA")"; echo "digest_restaurado=$REST_DIG" | tee "$RECIBO/restaurado.digest.txt"
[ "$REST_DIG" = "$ORIG_DIG" ] || falhar "digest do node_modules restaurado difere do original"
[ ! -e "$COPIA/node_modules/.swb-ensaio-arquivo-novo" ] || falhar "arquivo sintetico sobreviveu a restauracao"
git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "o worktree mudou durante o ensaio (nao deveria)"
( cd "$RECIBO" && ls | grep -v '^MANIFESTO' | xargs shasum -a 256 > MANIFESTO.sha256 && chmod 400 MANIFESTO.sha256 )
echo "ENSAIO-RECUPERACAO-APROVADO (copia preservada em $COPIA, inclusive node_modules.alterado-preservado; recibo $RECIBO)" | tee "$RECIBO/veredito.txt"
