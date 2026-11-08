#!/bin/bash
# D-ORF-6 — DEP-3 — ENSAIO ISOLADO DE RECUPERAÇÃO POR SNAPSHOT — V2 (08/11/2026). Supera o V1 (36453732…b37f, nunca executado).
# Comprova, SEM npm e SEM tocar o worktree, que a lógica de snapshot/reversão do gate V4 recupera package.json, package-lock.json e
# node_modules a um estado idêntico (hash a hash) depois de uma alteração SINTÉTICA delimitada.
#
# V2: a ORIGEM passa a ser a cópia aprovada do E-A (`~/SafeWorkDados/dep3-ensaio/copia-20261108T002412Z/backend`, estado PÓS-atualização,
# o mesmo que o `aplicar` produzirá), usada SOMENTE EM LEITURA: antes de copiar, seus package.json/lock são conferidos contra o recibo do
# E-A (`package.copia.json`, `package-lock.copia.json`) e o digest do seu node_modules é registrado; ao fim, tudo é reconferido — a cópia do
# E-A tem de sair IDÊNTICA (é evidência). O E-B trabalha numa área própria `recuperacao-<instante>/` (cópia + snapshot ≈ 2× node_modules do
# E-A ≈ 225 MB; o estado alterado é preservado por `mv`, sem custo extra). Nada é apagado, movido ou sobrescrito fora dessa área.
# Uso: ENSAIO_SHA256=<hash aprovado deste script> bash D-ORF-6-DEP-3-ENSAIO-RECUPERACAO-V2-20261108.sh
set -euo pipefail

G2="${G2:-/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104}"
BRANCH_ESPERADA="feature/d-orf-6-rodada-a-r2-r3-20261107"
NODE_BIN="$HOME/.nvm/versions/node/v22.23.3/bin"; NODE="$NODE_BIN/node"
RESERVA_GIB=40; ORCAMENTO_KIB=19531250
EVID="$HOME/SafeWorkDados/dep3-evidencias-20261107"
BASE="$HOME/SafeWorkDados/dep3-ensaio"
ORIGEM="${ORIGEM:-$BASE/copia-20261108T002412Z/backend}"
RECIBO_EA="${RECIBO_EA:-$EVID/execucoes/ensaio-copia-20261108T002412Z}"
INSTANTE="$(date -u +%Y%m%dT%H%M%SZ)"
DIRETORIOS_DA_RODADA=("$BASE" "$HOME/SafeWorkDados/dep3-snapshots" "$EVID" "$HOME/SafeWorkDados/d-orf-6-rodada-a-evidencias-20261107")
RE_SHA='^[0-9a-f]{64}$'
RECIBO=""

falhar() { echo "REPROVADO: $*" >&2; [ -n "$RECIBO" ] && [ -d "$RECIBO" ] && echo "REPROVADO: $*" >> "$RECIBO/veredito.txt" 2>/dev/null; exit 1; }
info() { echo "== $*"; }
digest_nm() { ( cd "$1" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 ); }
hashes_arquivos() { ( cd "$1" && shasum -a 256 package.json package-lock.json ); }
sha() { shasum -a 256 "$1" | cut -c1-64; }

PROPRIO="$(sha "$0")"; echo "ensaio_sha256=$PROPRIO"
[ -n "${ENSAIO_SHA256:-}" ] && [ "$ENSAIO_SHA256" = "$PROPRIO" ] || falhar "ENSAIO_SHA256 ausente ou diferente do aprovado"
[ -x "$NODE" ] || falhar "Node 22.23.3 ausente"
cd "$G2"; [ "$(git branch --show-current)" = "$BRANCH_ESPERADA" ] || falhar "branch diferente de $BRANCH_ESPERADA"
git diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "package.json/lock do worktree ja diferem do HEAD"
LIVRE_GIB="$(df -g . | awk 'NR==2{print $4}')"; [[ "$LIVRE_GIB" =~ ^[0-9]+$ ]] && [ "$LIVRE_GIB" -ge "$RESERVA_GIB" ] || falhar "so $LIVRE_GIB GiB livres"

info "(0) origem = copia aprovada do E-A, conferida contra o recibo do E-A (somente leitura)"
[ -d "$ORIGEM/node_modules" ] && [ -f "$ORIGEM/package.json" ] && [ -f "$ORIGEM/package-lock.json" ] || falhar "origem incompleta: $ORIGEM"
[ -f "$RECIBO_EA/package.copia.json" ] && [ -f "$RECIBO_EA/package-lock.copia.json" ] && grep -q "ENSAIO-COPIA-APROVADO" "$RECIBO_EA/veredito.txt" || falhar "recibo do E-A ausente ou nao aprovado: $RECIBO_EA"
[ "$(sha "$ORIGEM/package.json")" = "$(sha "$RECIBO_EA/package.copia.json")" ] || falhar "package.json da origem difere do recibo do E-A"
[ "$(sha "$ORIGEM/package-lock.json")" = "$(sha "$RECIBO_EA/package-lock.copia.json")" ] || falhar "package-lock.json da origem difere do recibo do E-A"
ORIGEM_DIG="$(digest_nm "$ORIGEM")"; [[ "$ORIGEM_DIG" =~ $RE_SHA ]] || falhar "digest da origem ilegivel"
NM_KIB="$(du -sk "$ORIGEM/node_modules" | awk '{print $1}')"; [[ "$NM_KIB" =~ ^[0-9]+$ ]] || falhar "medicao da origem invalida"
TOTAL=0; for d in "${DIRETORIOS_DA_RODADA[@]}"; do [ -d "$d" ] && TOTAL=$((TOTAL + $(du -sk "$d" | awk '{print $1}'))); done
for d in /private/tmp/swb-*; do [ -d "$d" ] && TOTAL=$((TOTAL + $(du -sk "$d" | awk '{print $1}'))); done
echo "orcamento-rodada-a: usados=$TOTAL KiB; este ensaio acrescenta ~$((NM_KIB * 2)) KiB (copia + snapshot)"
[ $((TOTAL + NM_KIB * 2)) -le "$ORCAMENTO_KIB" ] || falhar "o ensaio estouraria o orcamento unico de 20 GB da Rodada A"

RECIBO="$EVID/execucoes/ensaio-recuperacao-$INSTANTE"; [ ! -e "$RECIBO" ] || falhar "recibo ja existe"
COPIA="$BASE/recuperacao-$INSTANTE"; [ ! -e "$COPIA" ] || falhar "area do ensaio ja existe (nunca reutilizar)"
mkdir -p "$RECIBO" "$COPIA" && chmod 700 "$EVID" "$RECIBO" "$COPIA"
{ echo "ensaio=recuperacao instante=$INSTANTE ensaio_sha256=$PROPRIO"; echo "branch=$(git branch --show-current) head=$(git rev-parse HEAD)"; echo "origem=$ORIGEM recibo_ea=$RECIBO_EA origem_digest=$ORIGEM_DIG"; echo "area=$COPIA"; } > "$RECIBO/cabecalho.txt"

info "(1) copia da origem para a area do ensaio"
cp -p "$ORIGEM/package.json" "$ORIGEM/package-lock.json" "$COPIA/" && cp -a "$ORIGEM/node_modules" "$COPIA/node_modules"

info "(2) hashes do estado ORIGINAL (devem ser os da origem)"
hashes_arquivos "$COPIA" > "$RECIBO/original.arquivos.sha256"; cat "$RECIBO/original.arquivos.sha256"
ORIG_DIG="$(digest_nm "$COPIA")"; echo "digest_original=$ORIG_DIG" > "$RECIBO/original.digest.txt"; cat "$RECIBO/original.digest.txt"
[ "$ORIG_DIG" = "$ORIGEM_DIG" ] || falhar "a copia nao reproduz o digest da origem"

info "(3) snapshot no formato do gate V4 (ARQUIVOS.sha256 + DIGEST.txt)"
SNAP="$COPIA/snapshot"; mkdir -m 700 "$SNAP"
cp -p "$COPIA/package.json" "$COPIA/package-lock.json" "$SNAP/" && cp -a "$COPIA/node_modules" "$SNAP/node_modules"
( cd "$SNAP" && shasum -a 256 package.json package-lock.json > ARQUIVOS.sha256 ) && digest_nm "$SNAP" > "$SNAP/DIGEST.txt"
[ "$(cat "$SNAP/DIGEST.txt")" = "$ORIG_DIG" ] || falhar "snapshot nao reproduz o digest original"
cp -p "$SNAP/ARQUIVOS.sha256" "$RECIBO/snapshot.ARQUIVOS.sha256"; cp -p "$SNAP/DIGEST.txt" "$RECIBO/snapshot.DIGEST.txt"

info "(4) alteracao SINTETICA delimitada na area do ensaio (lock, package.json, arquivo novo e arquivo alterado em node_modules)"
"$NODE" -e 'const fs=require("node:fs"),path=require("node:path");const p=path.resolve(process.argv[1]);const l=JSON.parse(fs.readFileSync(p+"/package-lock.json","utf8"));l.swbEnsaio={instante:process.argv[2]};fs.writeFileSync(p+"/package-lock.json",JSON.stringify(l,null,2)+"\n");const j=JSON.parse(fs.readFileSync(p+"/package.json","utf8"));j.dependencies.zod="^9.9.9";fs.writeFileSync(p+"/package.json",JSON.stringify(j,null,2)+"\n");' "$COPIA" "$INSTANTE"
echo "ensaio $INSTANTE" > "$COPIA/node_modules/.swb-ensaio-arquivo-novo"
ALVO="$(cd "$COPIA" && find node_modules -maxdepth 2 -name package.json -type f | LC_ALL=C sort | head -1)"; [ -n "$ALVO" ] || falhar "nenhum package.json em node_modules para alterar"
printf '\n' >> "$COPIA/$ALVO"
echo "alterados: package-lock.json (campo swbEnsaio), package.json (zod ^9.9.9), node_modules/.swb-ensaio-arquivo-novo (novo), $ALVO (byte acrescentado)" > "$RECIBO/alteracao-sintetica.txt"; cat "$RECIBO/alteracao-sintetica.txt"

info "(5) a alteracao e detectavel: hashes e digest diferem do original"
hashes_arquivos "$COPIA" > "$RECIBO/alterado.arquivos.sha256"
if diff -q "$RECIBO/original.arquivos.sha256" "$RECIBO/alterado.arquivos.sha256" > /dev/null; then falhar "package.json/lock nao mudaram (alteracao sintetica falhou)"; fi
ALT_DIG="$(digest_nm "$COPIA")"; echo "digest_alterado=$ALT_DIG" > "$RECIBO/alterado.digest.txt"; cat "$RECIBO/alterado.digest.txt"
[ "$ALT_DIG" != "$ORIG_DIG" ] || falhar "node_modules nao mudou (alteracao sintetica falhou)"

info "(6) reversao com a MESMA logica do modo reverter do gate V4"
( cd "$SNAP" && shasum -a 256 -c ARQUIVOS.sha256 ) > "$RECIBO/reversao.txt" 2>&1 || falhar "snapshot: ARQUIVOS.sha256 nao confere"
[ "$(digest_nm "$SNAP")" = "$(cat "$SNAP/DIGEST.txt")" ] || falhar "snapshot: digest nao confere"
cp -p "$COPIA/package.json" "$RECIBO/package.alterado.json"; cp -p "$COPIA/package-lock.json" "$RECIBO/package-lock.alterado.json"
mv "$COPIA/node_modules" "$COPIA/node_modules.alterado-preservado"
cp -p "$SNAP/package.json" "$COPIA/package.json"; cp -p "$SNAP/package-lock.json" "$COPIA/package-lock.json"; cp -a "$SNAP/node_modules" "$COPIA/node_modules"

info "(7) estado restaurado == ORIGINAL; origem (copia do E-A) intacta"
hashes_arquivos "$COPIA" > "$RECIBO/restaurado.arquivos.sha256"
diff "$RECIBO/original.arquivos.sha256" "$RECIBO/restaurado.arquivos.sha256" || falhar "package.json/lock restaurados diferem do original"
REST_DIG="$(digest_nm "$COPIA")"; echo "digest_restaurado=$REST_DIG" > "$RECIBO/restaurado.digest.txt"; cat "$RECIBO/restaurado.digest.txt"
[ "$REST_DIG" = "$ORIG_DIG" ] || falhar "digest do node_modules restaurado difere do original"
[ ! -e "$COPIA/node_modules/.swb-ensaio-arquivo-novo" ] || falhar "arquivo sintetico sobreviveu a restauracao"
[ "$(sha "$ORIGEM/package.json")" = "$(sha "$RECIBO_EA/package.copia.json")" ] && [ "$(sha "$ORIGEM/package-lock.json")" = "$(sha "$RECIBO_EA/package-lock.copia.json")" ] || falhar "a ORIGEM (copia do E-A) foi alterada"
[ "$(digest_nm "$ORIGEM")" = "$ORIGEM_DIG" ] || falhar "o node_modules da ORIGEM (copia do E-A) foi alterado"
git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "o worktree mudou durante o ensaio (nao deveria)"
echo "origem_intacta=sim worktree_intacto=sim" >> "$RECIBO/cabecalho.txt"
( cd "$RECIBO" && find . -maxdepth 1 -type f ! -name 'MANIFESTO*' | sed 's#^\./##' | sort | xargs shasum -a 256 > MANIFESTO.sha256 && chmod 400 MANIFESTO.sha256 )
echo "ENSAIO-RECUPERACAO-APROVADO (area preservada em $COPIA, inclusive node_modules.alterado-preservado; origem do E-A intacta; recibo $RECIBO)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
