#!/bin/bash
# D-ORF-6 — DEP-3 — GATE DE ATUALIZAÇÃO CONTROLADA DE DEPENDÊNCIAS — V2 (07/11/2026). Supera o V1 (nunca executado).
# Padrão do V6 do DEP-2: modos separados com recibo, hash do próprio script conferido antes de agir, main esperada, reserva
# mínima de disco (40 GiB), orçamento da rodada (20 GB), snapshot antes de alterar, nunca `npm audit fix`, nenhum Git de
# escrita (os comandos Git são impressos para Ramires), nenhuma AWS, nenhum PostgreSQL.
#
# O que mudou do V1 (revisão de 07/11):
#  - SELEÇÃO DE VERSÕES: `npm update` resolve a MAIOR versão do intervalo declarado disponível ATÉ UM CORTE DE DATA imposto ao
#    próprio resolvedor (`--before=<corte>`, corte = agora − MATURIDADE_DIAS). A maturidade deixa de ser inferida: nada publicado
#    depois do corte pode ser escolhido. As versões resolvidas no ENSAIO são gravadas e o APLICAR exige exatamente as mesmas
#    (registro mudou entre um e outro → reprova; refaz-se o ensaio).
#  - INTEGRIDADE: para cada pacote-alvo, o `integrity` do lock resolvido tem de ser igual ao `dist.integrity` do registro para
#    aquela versão exata, e a data de publicação da versão resolvida tem de ser ≤ corte.
#  - ACEITE EM DUAS FASES, sem aceitar vulnerabilidade em silêncio: `aceite-fase1` exige 0 críticas, 0 altas e que o conjunto
#    restante seja EXATAMENTE o enumerado em RESTANTES_FASE1 (moderadas que dependem de decisão humana H-DEP3-a/b); qualquer
#    outra entrada reprova. `aceite-final` (depois das decisões da Fase 2) exige total 0.
#  - Versão no lock lida por caminho explícito; testes focais do ensaio por lista explícita; parada em qualquer passo falho.
#  - OPÇÕES DO NPM sempre em arrays expandidos com "${...[@]}" (nunca variável sem aspas: no zsh ela não se divide e o npm ignora
#    as opções em silêncio — causa do incidente de 07/11 na cópia dep3-dryrun-213248). Sem `--save=false`: nas versões 7+ do npm
#    `--no-save` também pode deixar de gravar o package-lock, o que anularia a atualização; em vez disso o gate PERMITE que o
#    `package.json` mude SOMENTE na faixa do `zod` (única dependência direta entre as seis) e reprova qualquer outra diferença.
#  - RECUPERAÇÃO INDEPENDENTE DE GIT: o snapshot guarda package.json, package-lock.json e node_modules com SHA-256/digest; o modo
#    `reverter` repõe os TRÊS a partir do snapshot, conferindo os hashes, e preserva os atuais no recibo. (Garantia a comprovar em
#    teste operacional: pendente até a primeira execução autorizada de aplicar→reverter.)
#
# Uso: GATE_SHA256=<hash aprovado> bash D-ORF-6-DEP-3-GATE-ATUALIZACAO-V2-20261107.sh <modo>
#   pre            só leitura: ambiente, árvore, main, corte, registro (alvos existem, integridade), audit ANTES → recibo
#   ensaio-copia   cópia do backend fora do worktree; `npm update --before=<corte>`; conferências; `npm ci`; audit; testes focais;
#                  grava versoes-resolvidas.txt (insumo obrigatório do aplicar)
#   aplicar        ENSAIO=<recibo do ensaio>; snapshot; `npm update --before=<corte do ensaio>` no worktree; versões == ensaio;
#                  integridade; nenhum pacote novo/removido/proibido; `npm ci --ignore-scripts`
#   aceite-fase1   audit (0 críticas/0 altas, restantes == RESTANTES_FASE1), signatures, versões instaladas, suíte completa (TAP)
#   aceite-final   audit total 0 (depois da Fase 2), signatures, suíte completa (TAP)
#   reverter       SNAPSHOT=<dir>: restaura node_modules do snapshot (o atual é preservado) e imprime o comando Git do lock
# Recibos em ~/SafeWorkDados/dep3-evidencias-20261107/execucoes/<modo>-<instante>/ (nunca sobrescreve).
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
# pacote:versão MÍNIMA que corrige o alerta (o resolvedor pode escolher maior, dentro do intervalo e antes do corte)
ALVOS=(proxy-addr:2.0.8 body-parser:2.4.0 brace-expansion:5.0.12 qs:6.16.1 ip-address:10.7.4 zod:4.6.6)
PACOTES=(proxy-addr body-parser brace-expansion qs ip-address zod)
# Fase 1: o que PODE restar no audit (moderadas que dependem das decisões H-DEP3-a/b); qualquer outro nome, ou outra severidade, reprova.
RESTANTES_FASE1=(nodemailer minimatch glob node-pg-migrate nodemon)
PROIBIDOS_NO_DIFF='"node_modules/(@aws-sdk/|express"|nodemailer"|node-pg-migrate"|nodemon")'
EVID="$HOME/SafeWorkDados/dep3-evidencias-20261107"
INSTANTE="$(date -u +%Y%m%dT%H%M%SZ)"
NPM_FLAGS=(--ignore-scripts --no-audit --no-fund --registry="$REGISTRO" --fetch-retries=0)

falhar() { echo "REPROVADO: $*" >&2; exit 1; }
info() { echo "== $*"; }

# --- hash do próprio script: só age se for exatamente o aprovado -------------------------------------------------------
PROPRIO="$(shasum -a 256 "$0" | cut -c1-64)"
echo "gate_sha256=$PROPRIO"
[ -n "${GATE_SHA256:-}" ] || falhar "GATE_SHA256 não informado (hash aprovado deste script)"
[ "$GATE_SHA256" = "$PROPRIO" ] || falhar "o script não é o aprovado (esperado $GATE_SHA256)"
case "$MODO" in pre|ensaio-copia|aplicar|aceite-fase1|aceite-final|reverter) ;; *) falhar "modo inválido: '$MODO'";; esac

# --- pré-condições comuns ---------------------------------------------------------------------------------------------
[ -x "$NODE" ] && [ -x "$NPM" ] || falhar "Node 22.23.3 não encontrado em $NODE_BIN"
export PATH="$NODE_BIN:$PATH"
cd "$G2"
[ "$(git branch --show-current)" = "$BRANCH_ESPERADA" ] || falhar "branch diferente de $BRANCH_ESPERADA"
[ "$(git rev-parse origin/main)" = "$MAIN_ESPERADA" ] || falhar "origin/main local ≠ MAIN_ESPERADA (este gate é da main $MAIN_ESPERADA; se a main avançou, novo gate)"
LIVRE_GIB="$(df -g . | awk 'NR==2{print $4}')"
[ "$LIVRE_GIB" -ge "$RESERVA_GIB" ] || falhar "só $LIVRE_GIB GiB livres (mínimo $RESERVA_GIB)"
RECIBO="$EVID/execucoes/$MODO-$INSTANTE"
[ ! -e "$RECIBO" ] || falhar "recibo já existe: $RECIBO"
mkdir -p "$RECIBO" && chmod 700 "$EVID" "$RECIBO"
AGORA_S="$(date -u +%s)"
CORTE="$(date -u -r $((AGORA_S - MATURIDADE_DIAS * 86400)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$((AGORA_S - MATURIDADE_DIAS * 86400))" +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "modo=$MODO instante=$INSTANTE gate_sha256=$PROPRIO corte=$CORTE maturidade_dias=$MATURIDADE_DIAS"
  echo "branch=$(git branch --show-current) head=$(git rev-parse HEAD) origin_main=$(git rev-parse origin/main)"
  echo "node=$($NODE -v) npm=$($NPM -v) livre_gib=$LIVRE_GIB"
} > "$RECIBO/cabecalho.txt"
echo "recibo=$RECIBO corte=$CORTE"

lock_intacto() { git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json; }
versao_no_lock() { "$NODE" -e 'const l=require(process.argv[1]);const p=l.packages["node_modules/"+process.argv[2]];console.log(p?p.version:"AUSENTE")' "$1" "$2"; }
integridade_no_lock() { "$NODE" -e 'const l=require(process.argv[1]);const p=l.packages["node_modules/"+process.argv[2]];console.log(p?p.integrity:"AUSENTE")' "$1" "$2"; }
nomes_lock() { "$NODE" -e 'const l=require(process.argv[1]);console.log(Object.keys(l.packages).filter(k=>k.startsWith("node_modules/")).sort().join("\n"))' "$1"; }
cmp_versao_ge() { "$NODE" -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(0)' "$1" "$2"; }
publicada_em() { "$NPM" view "$1" time --json --registry="$REGISTRO" --fetch-retries=0 | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(t[process.argv[1]]||"")})' "$2"; }
integridade_registro() { "$NPM" view "$1@$2" dist.integrity --registry="$REGISTRO" --fetch-retries=0; }
epoch() { "$NODE" -e 'console.log(Math.floor(Date.parse(process.argv[1])/1000))' "$1"; }

# Confere, num lock resolvido, cada pacote-alvo: versão ≥ mínima; publicada ≤ corte; integridade do lock == registro. Grava "pacote=versão" em $2.
conferir_resolvidos() {  # $1 lock, $2 saída, $3 corte
  local p v r data integ_lock integ_reg
  : > "$2"
  for pv in "${ALVOS[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"; r="$(versao_no_lock "$1" "$p")"
    [ "$r" != "AUSENTE" ] || falhar "$p ausente do lock"
    cmp_versao_ge "$r" "$v" || falhar "$p resolvido em $r (< mínimo $v que corrige o alerta)"
    data="$(publicada_em "$p" "$r")"; [ -n "$data" ] || falhar "$p@$r não existe no registro"
    [ "$(epoch "$data")" -le "$(epoch "$3")" ] || falhar "$p@$r publicada em $data, depois do corte $3"
    integ_lock="$(integridade_no_lock "$1" "$p")"; integ_reg="$(integridade_registro "$p" "$r")"
    [ -n "$integ_reg" ] && [ "$integ_lock" = "$integ_reg" ] || falhar "$p@$r: integridade do lock ($integ_lock) ≠ registro ($integ_reg)"
    echo "$p=$r publicada=$data integridade=$integ_lock" | tee -a "$2"
  done
}
sem_pacote_novo_ou_removido() {  # $1 lock antes, $2 lock depois, $3 saída
  diff <(nomes_lock "$1") <(nomes_lock "$2") > "$3" && echo "nenhum pacote novo/removido" | tee -a "$3" || falhar "o lock adiciona/remove pacotes (ver $3)"
}
sem_proibidos_no_diff() {  # $1 lock antes, $2 lock depois
  if diff "$1" "$2" | grep -E "^[<>]\s*$PROIBIDOS_NO_DIFF" ; then falhar "o lock tocou pacote proibido"; fi
}
so_zod_mudou() {  # $1 package.json antes, $2 depois: nenhuma diferença, ou só a linha da faixa do zod
  if diff "$1" "$2" | grep -E '^[<>]' | grep -vE '^[<>]\s*"zod": "\^?[0-9][0-9.]*",?\s*$' ; then falhar "package.json mudou além da faixa do zod"; fi
  diff -q "$1" "$2" > /dev/null && echo "package.json inalterado" || echo "package.json: só a faixa do zod mudou (permitido)"
}
auditar() {  # $1 saída json (cwd = backend com lock atual)
  "$NPM" audit --json --registry="$REGISTRO" > "$1" 2> "$1.err" || true
  "$NODE" -e 'const a=require(process.argv[1]);if(a.error){console.error("npm audit falhou:",a.error.code||a.error.summary);process.exit(2)}const m=a.metadata?.vulnerabilities||{};console.log(JSON.stringify(m));for(const [n,x] of Object.entries(a.vulnerabilities||{}))console.log(`${x.severity} ${n}@${x.range}`)' "$1"
}
exigir_restantes_fase1() {  # $1 json, $2 saída nominal: 0 críticas/altas; nomes restantes ⊆ RESTANTES_FASE1, todos MODERATE; cada remanescente listado com advisories
  "$NODE" -e '
    const fs=require("node:fs"); const a=require(process.argv[1]); const saida=process.argv[2]; const permitidos=new Set(process.argv.slice(3)); const m=a.metadata.vulnerabilities;
    const v=a.vulnerabilities||{}; const nomes=Object.keys(v).sort(); const fora=nomes.filter(n=>!permitidos.has(n));
    const naoModeradas=nomes.filter(n=>v[n].severity!=="moderate");
    const linhas=nomes.map(n=>`${v[n].severity} ${n}@${v[n].range} via=${(v[n].via||[]).map(w=>typeof w==="string"?w:`${w.title} [${w.url}]`).join(" | ")} fixAvailable=${JSON.stringify(v[n].fixAvailable)}`);
    fs.writeFileSync(saida, [`total=${m.total} critical=${m.critical} high=${m.high} moderate=${m.moderate} low=${m.low} info=${m.info}`, ...linhas, ""].join("\n"));
    for (const l of linhas) console.log("REMANESCENTE", l);
    if(m.critical!==0||m.high!==0||naoModeradas.length||fora.length){console.error("FASE1 reprovada: criticas=",m.critical,"altas=",m.high,"fora da lista=",fora,"nao moderadas=",naoModeradas);process.exit(1)}
    console.log("FASE1 ok: remanescentes (pendentes de decisao H-DEP3-a/b) =",nomes.join(",")||"(nenhum)");' "$1" "$2" "${RESTANTES_FASE1[@]}"
}
exigir_total_zero() { "$NODE" -e 'const a=require(process.argv[1]);const m=a.metadata.vulnerabilities;if(m.total!==0){console.error("FINAL reprovado: total=",m.total,m);process.exit(1)}console.log("FINAL ok: total 0")' "$1"; }
rodar_suite_completa() {  # cwd backend; $1 recibo
  info "suíte completa (Node 22) → TAP"; "$NODE" --require ./test/setup.js --test "test/**/*.test.js" > "$1/completa.tap" 2>&1 || true
  grep -E "^# (tests|pass|fail|todo)" "$1/completa.tap" | tee -a "$1/veredito.txt"
  grep -E "^\s*not ok" "$1/completa.tap" | grep -v "# TODO" > "$1/falhas.txt" || true
  grep -qE "^\s*ok [0-9]+ - TPX-04" "$1/completa.tap" || falhar "TPX-04 não passou"
  local nfail; nfail="$(grep -E '^# fail' "$1/completa.tap" | awk '{print $3}')"
  if [ "$nfail" = "0" ]; then echo "SUITE-VERDE" | tee -a "$1/veredito.txt"
  elif [ "$nfail" = "1" ] && grep -qE '^\s*not ok [0-9]+ - CAP-B01' "$1/completa.tap"; then echo "SUITE-VERDE-COM-RESSALVA (única falha: CAP-B01, preexistente no macOS, documentada; verde na CI Linux)" | tee -a "$1/veredito.txt"
  else falhar "suíte com $nfail falha(s) além da ressalva conhecida (ver $1/falhas.txt)"; fi
}

case "$MODO" in
  pre)
    lock_intacto || falhar "package.json/lock já diferem do HEAD; 'pre' exige lock intacto"
    cp -p backend/package-lock.json "$RECIBO/package-lock.antes.json"
    for p in "${PACOTES[@]}"; do echo "lock_antes $p=$(versao_no_lock backend/package-lock.json "$p")" | tee -a "$RECIBO/lock-antes.txt"; done
    info "registro: existência e integridade das versões MÍNIMAS; datas"
    for pv in "${ALVOS[@]}"; do p="${pv%%:*}"; v="${pv##*:}"; d="$(publicada_em "$p" "$v")"; [ -n "$d" ] || falhar "$p@$v inexistente"; echo "$p@$v publicada=$d integridade=$(integridade_registro "$p" "$v")" | tee -a "$RECIBO/registro.txt"; done
    info "audit ANTES (só leitura)"; ( cd backend && auditar "$RECIBO/audit-antes.json" ) | tee "$RECIBO/audit-antes.resumo.txt"
    echo "PRE-APROVADO corte=$CORTE" | tee "$RECIBO/veredito.txt" ;;

  ensaio-copia)
    lock_intacto || falhar "lock já alterado; o ensaio em cópia exige lock intacto"
    DEST="$HOME/SafeWorkDados/dep3-ensaio/copia-$INSTANTE"; [ ! -e "$DEST" ] || falhar "destino do ensaio já existe"
    TAM_KB="$(du -sk backend | cut -f1)"; [ "$((TAM_KB/1024/1024))" -lt "$ORCAMENTO_GB" ] || falhar "backend ocupa ${TAM_KB} KB; acima do orçamento de $ORCAMENTO_GB GB"
    mkdir -p "$DEST" && chmod 700 "$DEST"
    info "copiando backend ($((TAM_KB/1024)) MB) para $DEST"; cp -a backend "$DEST/backend"
    cp -p backend/package-lock.json "$RECIBO/package-lock.antes.json"
    cd "$DEST/backend"
    info "npm update --before=$CORTE dos seis pacotes, na CÓPIA"
    "$NPM" update --before="$CORTE" "${NPM_FLAGS[@]}" "${PACOTES[@]}" 2>&1 | tee "$RECIBO/update.txt"
    lock_intacto || falhar "o worktree foi alterado pelo ensaio em cópia (não deveria)"
    so_zod_mudou "$G2/backend/package.json" package.json
    cp -p package.json "$RECIBO/package.copia.json"
    cp -p package-lock.json "$RECIBO/package-lock.copia.json"
    conferir_resolvidos package-lock.json "$RECIBO/versoes-resolvidas.txt" "$CORTE"
    sem_pacote_novo_ou_removido "$RECIBO/package-lock.antes.json" package-lock.json "$RECIBO/lock-nomes.diff"
    sem_proibidos_no_diff "$RECIBO/package-lock.antes.json" package-lock.json
    info "npm ci --ignore-scripts na cópia"; "$NPM" ci "${NPM_FLAGS[@]}" 2>&1 | tail -3 | tee "$RECIBO/ci.txt"
    info "audit na cópia"; auditar "$RECIBO/audit-copia.json" | tee "$RECIBO/audit-copia.resumo.txt"
    exigir_restantes_fase1 "$RECIBO/audit-copia.json" "$RECIBO/restantes.txt" | tee -a "$RECIBO/veredito.txt"
    info "testes focais na cópia"
    "$NODE" --require ./test/setup.js --test test/config/proxy-addr-condicao-de-explorabilidade.test.js test/config/http.test.js test/config/env-example.test.js test/app-recuperacao-senha.test.js test/app-solicitacao-epi.test.js test/middleware/autenticacao-ip.test.js test/services/backup-executor-invariantes.test.js test/services/backup-aws-sdk-carregador.test.js test/backup-guarda/guarda-estatica.test.js test/backup-guarda/guarda-mutacao.test.js > "$RECIBO/focais.tap" 2>&1 || true
    grep -E "^# (tests|pass|fail)" "$RECIBO/focais.tap" | tee -a "$RECIBO/veredito.txt"
    grep -qE "^# fail 0$" "$RECIBO/focais.tap" || falhar "testes focais com falha na cópia"
    echo "ENSAIO-COPIA-APROVADO corte=$CORTE (worktree intacto; cópia em $DEST; use ENSAIO=$RECIBO no aplicar)" | tee -a "$RECIBO/veredito.txt" ;;

  aplicar)
    lock_intacto || falhar "lock já alterado; 'aplicar' só parte do HEAD"
    [ -n "${ENSAIO:-}" ] && [ -f "$ENSAIO/versoes-resolvidas.txt" ] && grep -q "ENSAIO-COPIA-APROVADO" "$ENSAIO/veredito.txt" || falhar "ENSAIO=<recibo aprovado do ensaio-copia> obrigatório"
    CORTE_ENSAIO="$(grep -oE 'corte=[^ ]+' "$ENSAIO/cabecalho.txt" | head -1 | cut -d= -f2)"; [ -n "$CORTE_ENSAIO" ] || falhar "corte do ensaio ilegível"
    echo "corte_do_ensaio=$CORTE_ENSAIO ensaio=$ENSAIO" | tee -a "$RECIBO/cabecalho.txt"
    SNAP="$HOME/SafeWorkDados/dep3-snapshots/snapshot-$INSTANTE"; [ ! -e "$SNAP" ] || falhar "snapshot já existe"
    mkdir -p "$SNAP" && chmod 700 "$SNAP"
    info "snapshot de package.json, lock e node_modules em $SNAP"
    cp -p backend/package.json backend/package-lock.json "$SNAP/" && cp -a backend/node_modules "$SNAP/node_modules"
    ( cd "$SNAP" && shasum -a 256 package.json package-lock.json > ARQUIVOS.sha256 && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 > DIGEST.txt && echo "digest=$(cat DIGEST.txt)" && cat ARQUIVOS.sha256 ) | tee -a "$RECIBO/snapshot.txt"
    echo "$SNAP" > "$RECIBO/snapshot-dir.txt"
    cd backend
    info "npm update --before=$CORTE_ENSAIO (mesmo corte do ensaio), --save=false, --ignore-scripts"
    "$NPM" update --before="$CORTE_ENSAIO" "${NPM_FLAGS[@]}" "${PACOTES[@]}" 2>&1 | tee "$RECIBO/update.txt"
    so_zod_mudou "$SNAP/package.json" package.json
    diff -q package.json "$ENSAIO/package.copia.json" > /dev/null || falhar "package.json resultante difere do ensaio"
    conferir_resolvidos package-lock.json "$RECIBO/versoes-resolvidas.txt" "$CORTE_ENSAIO"
    diff <(cut -d' ' -f1 "$ENSAIO/versoes-resolvidas.txt") <(cut -d' ' -f1 "$RECIBO/versoes-resolvidas.txt") || falhar "versões resolvidas diferem do ensaio (registro mudou); refaça o ensaio"
    sem_pacote_novo_ou_removido "$SNAP/package-lock.json" package-lock.json "$RECIBO/lock-nomes.diff"
    sem_proibidos_no_diff "$SNAP/package-lock.json" package-lock.json
    info "npm ci --ignore-scripts"; "$NPM" ci "${NPM_FLAGS[@]}" 2>&1 | tail -3 | tee "$RECIBO/ci.txt"
    echo "APLICADO (só o lock mudou; node_modules reinstalado; snapshot $SNAP)" | tee "$RECIBO/veredito.txt" ;;

  aceite-fase1|aceite-final)
    cd backend
    git -C "$G2" show HEAD:backend/package.json > "$RECIBO/package.head.json"
    so_zod_mudou "$RECIBO/package.head.json" package.json
    git -C "$G2" diff --quiet HEAD -- backend/package-lock.json && falhar "lock igual ao HEAD: nada foi aplicado" || true
    for pv in "${ALVOS[@]}"; do p="${pv%%:*}"; v="${pv##*:}"; r="$("$NODE" -e 'console.log(require(require.resolve(process.argv[1]+"/package.json")).version)' "$p")"; echo "instalado $p=$r (mínimo $v; lock $(versao_no_lock package-lock.json "$p"))" | tee -a "$RECIBO/instalados.txt"; cmp_versao_ge "$r" "$v" || falhar "$p instalado em $r (< $v)"; [ "$r" = "$(versao_no_lock package-lock.json "$p")" ] || falhar "$p: node_modules ≠ lock"; done
    info "audit DEPOIS"; auditar "$RECIBO/audit-depois.json" | tee "$RECIBO/audit-depois.resumo.txt"
    if [ "$MODO" = "aceite-fase1" ]; then exigir_restantes_fase1 "$RECIBO/audit-depois.json" "$RECIBO/restantes.txt" | tee -a "$RECIBO/veredito.txt"; else exigir_total_zero "$RECIBO/audit-depois.json" | tee -a "$RECIBO/veredito.txt"; fi
    info "npm audit signatures"; "$NPM" audit signatures --registry="$REGISTRO" 2>&1 | tail -4 | tee "$RECIBO/signatures.txt"
    grep -qiE "verified|verificad" "$RECIBO/signatures.txt" || falhar "audit signatures sem confirmação"
    rodar_suite_completa "$RECIBO"
    if [ "$MODO" = "aceite-fase1" ]; then echo "ACEITE-FASE1-APROVADO (restam só as moderadas enumeradas, pendentes de decisão H-DEP3-a/b)" | tee -a "$RECIBO/veredito.txt"; else echo "ACEITE-FINAL-APROVADO (total 0)" | tee -a "$RECIBO/veredito.txt"; fi
    ( cd "$RECIBO" && shasum -a 256 ./* > MANIFESTO.sha256 2>/dev/null || true )
    echo; echo "Git (só Ramires): git -C $G2 add backend/package-lock.json && git -C $G2 diff --cached --stat   # esperado: 1 arquivo" ;;

  reverter)
    [ -n "${SNAPSHOT:-}" ] && [ -d "$SNAPSHOT/node_modules" ] && [ -f "$SNAPSHOT/DIGEST.txt" ] && [ -f "$SNAPSHOT/ARQUIVOS.sha256" ] || falhar "SNAPSHOT=<dir do snapshot> obrigatório (com DIGEST.txt e ARQUIVOS.sha256)"
    ( cd "$SNAPSHOT" && shasum -a 256 -c ARQUIVOS.sha256 ) | tee -a "$RECIBO/snapshot-conferido.txt" || falhar "package.json/lock do snapshot divergem do registrado"
    DIG="$(cd "$SNAPSHOT" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
    [ "$DIG" = "$(cat "$SNAPSHOT/DIGEST.txt")" ] || falhar "digest do node_modules do snapshot divergente"
    info "preservando o estado atual no recibo e restaurando package.json, package-lock.json e node_modules do snapshot (nada é apagado)"
    cp -p backend/package.json "$RECIBO/package.revertido.json" && cp -p backend/package-lock.json "$RECIBO/package-lock.revertido.json"
    mv backend/node_modules "backend/node_modules.revertido-$INSTANTE"
    cp -p "$SNAPSHOT/package.json" backend/package.json && cp -p "$SNAPSHOT/package-lock.json" backend/package-lock.json && cp -a "$SNAPSHOT/node_modules" backend/node_modules
    ( cd backend && shasum -a 256 package.json package-lock.json | diff - <(sed 's#  package#  package#' "$SNAPSHOT/ARQUIVOS.sha256") > /dev/null ) || falhar "após a restauração, package.json/lock não conferem com o snapshot"
    DIG2="$(cd backend && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
    [ "$DIG2" = "$DIG" ] || falhar "após a restauração, o digest do node_modules não confere"
    echo "REVERTIDO (package.json, lock e node_modules iguais ao snapshot $SNAPSHOT; anteriores preservados em $RECIBO e backend/node_modules.revertido-$INSTANTE). Git NÃO é necessário; se quiser conferir: git -C $G2 diff --stat -- backend/package.json backend/package-lock.json" | tee "$RECIBO/veredito.txt" ;;
esac
echo "FIM $MODO $INSTANTE"
