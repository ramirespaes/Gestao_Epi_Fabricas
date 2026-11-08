#!/bin/bash
# D-ORF-6 — DEP-3 — GATE DE ATUALIZAÇÃO CONTROLADA DE DEPENDÊNCIAS — V1 (07/11/2026)
# Padrão do V6 do DEP-2: modos separados com recibo, hash do próprio script conferido antes de agir, main esperada,
# reserva mínima de disco (40 GiB) e orçamento da rodada (20 GB), snapshot antes de alterar, nunca `npm audit fix`,
# nenhum Git de escrita (os comandos Git são impressos para Ramires), nenhuma AWS, nenhum PostgreSQL.
#
# Uso: GATE_SHA256=<hash aprovado> bash D-ORF-6-DEP-3-GATE-ATUALIZACAO-V1-20261107.sh <modo>
#   pre            só leitura: ambiente, árvore, main, registro (versões-alvo, maturidade, integridade), audit ANTES → recibo
#   ensaio-copia   cópia do backend em ~/SafeWorkDados/dep3-ensaio/<instante>/ (fora do worktree), update + ci + audit + testes focais
#   aplicar        snapshot (package.json, lock, node_modules) → `npm update` dos seis pacotes no worktree → `npm ci --ignore-scripts`
#   aceite         audit (0 críticas, 0 altas), signatures, versões instaladas, lock sem pacote novo/removido, suíte completa (TAP)
#   reverter       restaura node_modules do snapshot indicado em SNAPSHOT=<dir> e imprime o comando Git de reposição do lock
# Cada modo grava recibo em ~/SafeWorkDados/dep3-evidencias-<data>/execucoes/<modo>-<instante>/ (nunca sobrescreve).
set -euo pipefail

MODO="${1:-}"
G2="${G2:-/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104}"
BRANCH_ESPERADA="feature/d-orf-6-rodada-a-r2-r3-20261107"
MAIN_ESPERADA="fe27357085fdb2e6be3e3f56bfb9cb3f25707db6"
NODE_BIN="$HOME/.nvm/versions/node/v22.23.3/bin"
NPM="$NODE_BIN/npm"; NODE="$NODE_BIN/node"
REGISTRO="https://registry.npmjs.org/"
RESERVA_GIB=40
ORCAMENTO_GB=20
MATURIDADE_DIAS=7
# pacote:versão-alvo mínima aceitável (o update pode trazer versão maior dentro do intervalo; a maturidade é checada na versão RESOLVIDA)
ALVOS=(proxy-addr:2.0.8 body-parser:2.4.0 brace-expansion:5.0.12 qs:6.16.1 ip-address:10.7.4 zod:4.6.6)
PACOTES=(proxy-addr body-parser brace-expansion qs ip-address zod)
PROIBIDOS_ALTERAR='@aws-sdk/|express"|nodemailer"|node-pg-migrate"|nodemon"'
EVID="$HOME/SafeWorkDados/dep3-evidencias-20261107"
INSTANTE="$(date -u +%Y%m%dT%H%M%SZ)"

falhar() { echo "REPROVADO: $*" >&2; exit 1; }
info() { echo "== $*"; }

# --- hash do próprio script: só age se for exatamente o aprovado -------------------------------------------------------
PROPRIO="$(shasum -a 256 "$0" | cut -c1-64)"
echo "gate_sha256=$PROPRIO"
[ -n "${GATE_SHA256:-}" ] || falhar "GATE_SHA256 não informado (hash aprovado deste script)"
[ "$GATE_SHA256" = "$PROPRIO" ] || falhar "o script não é o aprovado (esperado $GATE_SHA256)"
case "$MODO" in pre|ensaio-copia|aplicar|aceite|reverter) ;; *) falhar "modo inválido: '$MODO'";; esac

# --- pré-condições comuns ---------------------------------------------------------------------------------------------
[ -x "$NODE" ] && [ -x "$NPM" ] || falhar "Node 22.23.3 não encontrado em $NODE_BIN"
export PATH="$NODE_BIN:$PATH"
cd "$G2"
[ "$(git branch --show-current)" = "$BRANCH_ESPERADA" ] || falhar "branch diferente de $BRANCH_ESPERADA"
[ "$(git rev-parse origin/main)" = "$MAIN_ESPERADA" ] || falhar "origin/main local ≠ MAIN_ESPERADA (rode 'git fetch' e reavalie; este gate é da main $MAIN_ESPERADA)"
LIVRE_GIB="$(df -g . | awk 'NR==2{print $4}')"
[ "$LIVRE_GIB" -ge "$RESERVA_GIB" ] || falhar "só $LIVRE_GIB GiB livres (mínimo $RESERVA_GIB)"
RECIBO="$EVID/execucoes/$MODO-$INSTANTE"
[ ! -e "$RECIBO" ] || falhar "recibo já existe: $RECIBO"
mkdir -p "$RECIBO" && chmod 700 "$EVID" "$RECIBO"
{
  echo "modo=$MODO instante=$INSTANTE gate_sha256=$PROPRIO"
  echo "branch=$(git branch --show-current) head=$(git rev-parse HEAD) origin_main=$(git rev-parse origin/main)"
  echo "node=$($NODE -v) npm=$($NPM -v) livre_gib=$LIVRE_GIB"
} > "$RECIBO/cabecalho.txt"
echo "recibo=$RECIBO"

# lock só pode ter sido alterado por este gate (modo aplicar/aceite); em pre/ensaio o lock tem de estar como no HEAD
lock_intacto() { git diff --quiet HEAD -- backend/package.json backend/package-lock.json; }
versao_no_lock() { "$NODE" -e 'const l=require(process.argv[1]);const p=l.packages["node_modules/"+process.argv[2]];console.log(p?p.version:"AUSENTE")' "$G2/backend/package-lock.json" "$1"; }
contar_pacotes_lock() { "$NODE" -e 'const l=require(process.argv[1]);console.log(Object.keys(l.packages).filter(k=>k.startsWith("node_modules/")).length)' "$1"; }
nomes_lock() { "$NODE" -e 'const l=require(process.argv[1]);console.log(Object.keys(l.packages).filter(k=>k.startsWith("node_modules/")).sort().join("\n"))' "$1"; }
cmp_versao_ge() { "$NODE" -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(0)' "$1" "$2"; }

conferir_registro() {  # para cada alvo: existe, maturidade (na versão resolvida que o update traria = maior do intervalo), integridade
  info "registro: versões-alvo, maturidade (≥ $MATURIDADE_DIAS dias) e integridade"
  local p v info_json data idade integ
  for pv in "${ALVOS[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"
    info_json="$("$NPM" view "$p@$v" time.modified dist.integrity version --json --registry="$REGISTRO" --fetch-retries=0)"
    data="$("$NPM" view "$p" time --json --registry="$REGISTRO" --fetch-retries=0 | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(t[process.argv[1]]||"")})' "$v")"
    [ -n "$data" ] || falhar "$p@$v não existe no registro"
    idade="$(( ( $(date -u +%s) - $(date -u -j -f '%Y-%m-%dT%H:%M:%S' "${data%%.*}" +%s 2>/dev/null || date -u -d "${data%%.*}" +%s) ) / 86400 ))"
    integ="$(echo "$info_json" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o["dist.integrity"]||"")})')"
    echo "$p@$v publicada=$data idade_dias=$idade integridade=$integ" | tee -a "$RECIBO/registro.txt"
    [ "$idade" -ge "$MATURIDADE_DIAS" ] || falhar "$p@$v tem $idade dias (mínimo $MATURIDADE_DIAS): aguardar ou decidir fixação por overrides"
    [ -n "$integ" ] || falhar "$p@$v sem integridade no registro"
  done
}

auditar() { "$NPM" audit --json --registry="$REGISTRO" > "$1" 2> "$1.err" || true; "$NODE" -e 'const a=require(process.argv[1]);const m=a.metadata?.vulnerabilities||{};console.log(JSON.stringify(m));for(const [n,x] of Object.entries(a.vulnerabilities||{}))console.log(`${x.severity} ${n}@${x.range}`)' "$1"; }

case "$MODO" in
  pre)
    lock_intacto || falhar "package.json/lock já diferem do HEAD; 'pre' exige lock intacto"
    for p in "${PACOTES[@]}"; do echo "lock_antes $p=$(versao_no_lock "$p")" | tee -a "$RECIBO/lock-antes.txt"; done
    cp -p backend/package-lock.json "$RECIBO/package-lock.antes.json"
    conferir_registro
    info "audit ANTES (só leitura)"; ( cd backend && auditar "$RECIBO/audit-antes.json" ) | tee "$RECIBO/audit-antes.resumo.txt"
    echo "PRE-APROVADO" | tee "$RECIBO/veredito.txt" ;;

  ensaio-copia)
    lock_intacto || falhar "lock já alterado; o ensaio em cópia exige lock intacto"
    DEST="$HOME/SafeWorkDados/dep3-ensaio/copia-$INSTANTE"; [ ! -e "$DEST" ] || falhar "destino do ensaio já existe"
    TAM_KB="$(du -sk backend | cut -f1)"; [ "$((TAM_KB/1024/1024))" -lt "$ORCAMENTO_GB" ] || falhar "backend ocupa ${TAM_KB} KB; acima do orçamento de $ORCAMENTO_GB GB"
    mkdir -p "$DEST" && chmod 700 "$DEST"
    info "copiando backend ($((TAM_KB/1024)) MB) para $DEST"; cp -a backend "$DEST/backend"
    cd "$DEST/backend"
    info "update dos seis pacotes na CÓPIA"; "$NPM" update --ignore-scripts --no-audit --no-fund --save=false "${PACOTES[@]}" 2>&1 | tee "$RECIBO/update.txt"
    git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json || falhar "o worktree foi alterado pelo ensaio em cópia (não deveria)"
    info "npm ci --ignore-scripts na cópia"; "$NPM" ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -3 | tee "$RECIBO/ci.txt"
    for p in "${PACOTES[@]}"; do echo "copia $p=$(versao_no_lock "$p" 2>/dev/null || "$NODE" -e 'console.log(require(process.argv[1]).packages["node_modules/"+process.argv[2]].version)' "$DEST/backend/package-lock.json" "$p")" | tee -a "$RECIBO/lock-copia.txt"; done
    diff <(nomes_lock "$G2/backend/package-lock.json") <(nomes_lock "$DEST/backend/package-lock.json") > "$RECIBO/lock-nomes.diff" && echo "nenhum pacote novo/removido" | tee -a "$RECIBO/lock-nomes.diff" || falhar "o lock da cópia adiciona/remove pacotes (ver $RECIBO/lock-nomes.diff)"
    grep -E "$PROIBIDOS_ALTERAR" "$RECIBO/update.txt" && falhar "update tocou pacote proibido" || true
    info "audit na cópia"; auditar "$RECIBO/audit-copia.json" | tee "$RECIBO/audit-copia.resumo.txt"
    info "testes focais na cópia"; "$NODE" --require ./test/setup.js --test test/config/proxy-addr-condicao-de-explorabilidade.test.js test/config/*.test.js test/app*.test.js test/services/backup-executor-*.test.js test/backup-guarda/*.test.js > "$RECIBO/focais.tap" 2>&1 || true
    grep -E "^# (tests|pass|fail)" "$RECIBO/focais.tap" | tee -a "$RECIBO/veredito.txt"
    grep -qE "^# fail 0$" "$RECIBO/focais.tap" || falhar "testes focais com falha na cópia"
    echo "ENSAIO-COPIA-APROVADO (worktree intacto; cópia em $DEST — preservar até o aceite)" | tee -a "$RECIBO/veredito.txt" ;;

  aplicar)
    lock_intacto || falhar "lock já alterado; 'aplicar' só parte do HEAD"
    conferir_registro
    SNAP="$HOME/SafeWorkDados/dep3-snapshots/snapshot-$INSTANTE"; [ ! -e "$SNAP" ] || falhar "snapshot já existe"
    mkdir -p "$SNAP" && chmod 700 "$SNAP"
    info "snapshot de package.json, lock e node_modules em $SNAP"
    cp -p backend/package.json backend/package-lock.json "$SNAP/" && cp -a backend/node_modules "$SNAP/node_modules"
    ( cd "$SNAP" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 > DIGEST.txt && echo "digest=$(cat DIGEST.txt)" ) | tee -a "$RECIBO/snapshot.txt"
    echo "$SNAP" > "$RECIBO/snapshot-dir.txt"
    cd backend
    info "npm update (seis pacotes, --save=false, --ignore-scripts)"; "$NPM" update --ignore-scripts --no-audit --no-fund --save=false "${PACOTES[@]}" 2>&1 | tee "$RECIBO/update.txt"
    git -C "$G2" diff --quiet HEAD -- backend/package.json || falhar "package.json mudou (esperado: só o lock)"
    diff <(nomes_lock "$SNAP/package-lock.json") <(nomes_lock package-lock.json) > "$RECIBO/lock-nomes.diff" && echo "nenhum pacote novo/removido" | tee -a "$RECIBO/lock-nomes.diff" || falhar "lock adiciona/remove pacotes"
    for pv in "${ALVOS[@]}"; do p="${pv%%:*}"; v="${pv##*:}"; r="$(versao_no_lock "$p")"; echo "lock_depois $p=$r (mínimo $v)" | tee -a "$RECIBO/lock-depois.txt"; cmp_versao_ge "$r" "$v" || falhar "$p ficou em $r (< $v)"; done
    git -C "$G2" diff HEAD -- backend/package-lock.json | grep -E '^[-+]\s*"(node_modules/)?(@aws-sdk/|express"|nodemailer"|node-pg-migrate"|nodemon")' && falhar "lock tocou pacote proibido" || true
    info "npm ci --ignore-scripts"; "$NPM" ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -3 | tee "$RECIBO/ci.txt"
    echo "APLICADO (lock alterado; node_modules reinstalado; snapshot $SNAP)" | tee "$RECIBO/veredito.txt" ;;

  aceite)
    cd backend
    git -C "$G2" diff --quiet HEAD -- package.json && echo "package.json intacto" | tee -a "$RECIBO/veredito.txt" || falhar "package.json alterado"
    git -C "$G2" diff --quiet HEAD -- package-lock.json && falhar "lock igual ao HEAD: nada foi aplicado" || true
    for pv in "${ALVOS[@]}"; do p="${pv%%:*}"; v="${pv##*:}"; r="$("$NODE" -e 'console.log(require(require.resolve(process.argv[1]+"/package.json")).version)' "$p")"; echo "instalado $p=$r (mínimo $v)" | tee -a "$RECIBO/instalados.txt"; cmp_versao_ge "$r" "$v" || falhar "$p instalado em $r (< $v)"; done
    info "audit DEPOIS"; auditar "$RECIBO/audit-depois.json" | tee "$RECIBO/audit-depois.resumo.txt"
    "$NODE" -e 'const a=require(process.argv[1]);const m=a.metadata.vulnerabilities;if(m.critical!==0||m.high!==0){console.error("críticas/altas restantes",m);process.exit(1)}' "$RECIBO/audit-depois.json" || falhar "ainda há vulnerabilidades críticas/altas"
    info "npm audit signatures"; "$NPM" audit signatures --registry="$REGISTRO" 2>&1 | tail -4 | tee "$RECIBO/signatures.txt"
    info "suíte completa (Node 22) → TAP"; "$NODE" --require ./test/setup.js --test "test/**/*.test.js" > "$RECIBO/completa.tap" 2>&1 || true
    grep -E "^# (tests|pass|fail|todo)" "$RECIBO/completa.tap" | tee -a "$RECIBO/veredito.txt"
    grep -E "^\s*not ok" "$RECIBO/completa.tap" | tee "$RECIBO/falhas.txt" || true
    grep -qE "^ok .*TPX-04" "$RECIBO/completa.tap" || grep -qE "^\s*ok .*TPX-04" "$RECIBO/completa.tap" || falhar "TPX-04 não passou"
    if grep -qE "^# fail 0$" "$RECIBO/completa.tap"; then echo "ACEITE-LOCAL-APROVADO" | tee -a "$RECIBO/veredito.txt"
    elif [ "$(grep -cE '^\s*not ok [0-9]+ - CAP-B01' "$RECIBO/completa.tap")" = "1" ] && [ "$(grep -E '^# fail' "$RECIBO/completa.tap" | awk '{print $3}')" = "1" ]; then echo "ACEITE-LOCAL-APROVADO-COM-RESSALVA (única falha: CAP-B01, preexistente no macOS, documentada)" | tee -a "$RECIBO/veredito.txt"
    else falhar "suíte com falhas além da ressalva conhecida (ver $RECIBO/falhas.txt)"; fi
    ( cd "$RECIBO" && shasum -a 256 ./* > MANIFESTO.sha256 2>/dev/null || true )
    echo; echo "Git (só Ramires): git -C $G2 add backend/package-lock.json && git -C $G2 diff --cached --stat" ;;

  reverter)
    [ -n "${SNAPSHOT:-}" ] && [ -d "$SNAPSHOT/node_modules" ] || falhar "SNAPSHOT=<dir do snapshot> obrigatório"
    DIG="$(cd "$SNAPSHOT" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
    [ "$DIG" = "$(cat "$SNAPSHOT/DIGEST.txt")" ] || falhar "digest do snapshot divergente"
    info "restaurando node_modules do snapshot (o atual vai para node_modules.revertido-$INSTANTE, não é apagado)"
    mv backend/node_modules "backend/node_modules.revertido-$INSTANTE" && cp -a "$SNAPSHOT/node_modules" backend/node_modules
    echo "REVERTIDO node_modules; para repor o lock (Git, só Ramires): git -C $G2 checkout -- backend/package-lock.json" | tee "$RECIBO/veredito.txt" ;;
esac
echo "FIM $MODO $INSTANTE"
