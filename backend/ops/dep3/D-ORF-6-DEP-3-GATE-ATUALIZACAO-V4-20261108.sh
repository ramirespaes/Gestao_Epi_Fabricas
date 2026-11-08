#!/bin/bash
# D-ORF-6 — DEP-3 — GATE DE ATUALIZAÇÃO CONTROLADA DE DEPENDÊNCIAS — V4 (08/11/2026). Supera V1, V2 e V3 (preservados; só o `pre` do V2
# e do V3 foram executados: o V2 reprovou pela main avançada; o V3 reprovou-se a si mesmo ao terminar em PRE-APROVADO com seis erros).
#
# CAUSA DO DEFEITO DO V3 (recibo pre-20261108T001007Z, preservado como EVIDÊNCIA DE FALHA): os leitores do lock faziam
# `require(process.argv[1])` com caminho RELATIVO (`backend/package-lock.json`); o `require` do Node não resolve caminho relativo pelo
# diretório corrente sem `./` → MODULE_NOT_FOUND; a saída vazia era consumida dentro de `echo "...$(...)"`, cujo status é o do echo —
# `set -euo pipefail` não enxerga falha dentro de substituição de comando usada como argumento. Em `conferir_resolvidos`, a versão vazia
# ainda passaria em `!= AUSENTE` e `cmp_versao_ge "" x` devolvia 0 (NaN não é maior nem menor). Em V4 NADA disso é possível:
#  - todo JSON é lido por `fs.readFileSync(path.resolve(...))` + `JSON.parse` com erro → saída ≠ 0; caminhos sempre ABSOLUTOS (derivados de G2);
#  - toda substituição de comando é atribuída a variável com `|| falhar`, e o valor é VALIDADO (versão pelo formato semver, integridade por
#    prefixo `sha512-`, datas por Date.parse, hashes por regex) antes de qualquer uso; nunca `echo "$(...)"`;
#  - `cmp_versao_ge` valida os dois lados (formato) e sai 2 se inválido; chamadas sempre com `|| falhar`;
#  - pipelines com `tee` foram eliminados dos pontos de decisão: comandos gravam em arquivo e o status é testado explicitamente;
#  - veredito só é escrito como ÚLTIMA instrução do modo, depois de todas as verificações; qualquer `falhar` anterior deixa o recibo SEM veredito
#    aprovado e grava `REPROVADO` em veredito.txt;
#  - `main` protegido por `[[ ${BASH_SOURCE[0]} == $0 ]]`: o arquivo pode ser `source`d por um arnês de casos negativos (GATE_TESTE_INTERNO=1).
# Mantidos do V3: MAIN_ESPERADA=f6f5623; corte de data `--before`; versões ≥ mínimas; integridade lock == registro; ensaio↔aplicar idênticos;
# package.json só na faixa do zod; snapshot com ARQUIVOS.sha256+DIGEST; reverter dos três com reconferência; aceite-fase1 (0 críticas/altas,
# restantes nominais ⊆ RESTANTES_FASE1, todas moderate) e aceite-final (total 0); 40 GiB; 20 GB; nunca `npm audit fix`; nenhum Git de escrita.
#
# Uso: GATE_SHA256=<hash aprovado> bash D-ORF-6-DEP-3-GATE-ATUALIZACAO-V4-20261108.sh <pre|ensaio-copia|aplicar|aceite-fase1|aceite-final|reverter>
set -euo pipefail

G2="${G2:-/Users/ramirespaes/Desktop/SafeWork/02-worktrees/gestao-epi-g2-d-orf-6-20261104}"
BACKEND="$G2/backend"
LOCK="$BACKEND/package-lock.json"
PKG="$BACKEND/package.json"
BRANCH_ESPERADA="feature/d-orf-6-rodada-a-r2-r3-20261107"
MAIN_ESPERADA="f6f5623c1faafdbb5db18638e950aa1900152ad0"
NODE_BIN="$HOME/.nvm/versions/node/v22.23.3/bin"
NPM="$NODE_BIN/npm"; NODE="$NODE_BIN/node"
REGISTRO="https://registry.npmjs.org/"
RESERVA_GIB=40
ORCAMENTO_KIB=19531250
MATURIDADE_DIAS=7
ALVOS=(proxy-addr:2.0.8 body-parser:2.4.0 brace-expansion:5.0.12 qs:6.16.1 ip-address:10.7.4 zod:4.6.6)
PACOTES=(proxy-addr body-parser brace-expansion qs ip-address zod)
RESTANTES_FASE1=(nodemailer minimatch glob node-pg-migrate nodemon)
PROIBIDOS_NO_DIFF='"node_modules/(@aws-sdk/|express"|nodemailer"|node-pg-migrate"|nodemon")'
EVID="$HOME/SafeWorkDados/dep3-evidencias-20261107"
DIRETORIOS_DA_RODADA=("$HOME/SafeWorkDados/dep3-ensaio" "$HOME/SafeWorkDados/dep3-snapshots" "$EVID" "$HOME/SafeWorkDados/d-orf-6-rodada-a-evidencias-20261107")
NPM_FLAGS=(--ignore-scripts --no-audit --no-fund --registry="$REGISTRO" --fetch-retries=0)
RE_VERSAO='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
RE_INTEG='^sha512-[A-Za-z0-9+/]+=*$'
RE_SHA='^[0-9a-f]{64}$'
RECIBO=""

falhar() { echo "REPROVADO: $*" >&2; if [ -n "$RECIBO" ] && [ -d "$RECIBO" ]; then echo "REPROVADO: $*" >> "$RECIBO/veredito.txt" 2>/dev/null || true; fi; exit 1; }
info() { echo "== $*"; }

# ---------------------------------------------------------------- leitores (sempre caminho absoluto; qualquer erro => saída != 0)
# json_campo <arquivo> <expressão sobre `j`> : imprime o valor; sai 3 se arquivo ausente/ilegível/JSON inválido; sai 4 se o valor for null/undefined
json_campo() {
  "$NODE" -e '
    const fs=require("node:fs"), path=require("node:path");
    const f=path.resolve(process.argv[1]);
    if (!path.isAbsolute(process.argv[1])) { console.error("caminho nao absoluto recusado:", process.argv[1]); process.exit(3); }
    let j; try { j=JSON.parse(fs.readFileSync(f,"utf8")); } catch (e) { console.error("JSON ilegivel:", f, e.code||e.message); process.exit(3); }
    let v; try { v=Function("j", "return (" + process.argv[2] + ")")(j); } catch (e) { console.error("campo ilegivel:", process.argv[2]); process.exit(4); }
    if (v===undefined || v===null) { console.error("campo ausente:", process.argv[2], "em", f); process.exit(4); }
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"
}
versao_no_lock() { json_campo "$1" "j.packages['node_modules/$2'].version"; }               # falha se o pacote não existe
integridade_no_lock() { json_campo "$1" "j.packages['node_modules/$2'].integrity"; }
nomes_lock() { json_campo "$1" "Object.keys(j.packages).filter(k=>k.startsWith('node_modules/')).sort().join('\n')"; }
versao_instalada() { json_campo "$BACKEND/node_modules/$1/package.json" "j.version"; }
exigir_versao() { [[ "${1:-}" =~ $RE_VERSAO ]] || falhar "versao invalida ou vazia para $2: '${1:-}'"; }
exigir_integridade() { [[ "${1:-}" =~ $RE_INTEG ]] || falhar "integridade invalida ou vazia para $2: '${1:-}'"; }
cmp_versao_ge() {  # 0 se $1 >= $2; 1 se menor; 2 se formato inválido
  [[ "${1:-}" =~ $RE_VERSAO ]] && [[ "${2:-}" =~ $RE_VERSAO ]] || return 2
  "$NODE" -e 'const n=v=>v.split(/[-+]/)[0].split(".").map(Number);const [a,b]=process.argv.slice(1).map(n);for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(0)' "$1" "$2"
}
publicada_em() {  # imprime a data ISO de publicação de <pacote>@<versão> ou sai != 0
  local json data
  json="$("$NPM" view "$1" time --json --registry="$REGISTRO" --fetch-retries=0)" || return 1
  data="$(printf '%s' "$json" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let t;try{t=JSON.parse(s)}catch{process.exit(3)}const d=t[process.argv[1]];if(!d||Number.isNaN(Date.parse(d)))process.exit(4);process.stdout.write(d)})' "$2")" || return 1
  printf '%s' "$data"
}
integridade_registro() { "$NPM" view "$1@$2" dist.integrity --registry="$REGISTRO" --fetch-retries=0; }
epoch() { "$NODE" -e 'const t=Date.parse(process.argv[1]);if(Number.isNaN(t))process.exit(4);console.log(Math.floor(t/1000))' "$1"; }
lock_intacto() { git -C "$G2" diff --quiet HEAD -- backend/package.json backend/package-lock.json; }

# conferir_resolvidos <lock absoluto> <saída> <corte>: para cada alvo, versão válida ≥ mínima, publicada ≤ corte, integridade lock == registro
conferir_resolvidos() {
  local lock="$1" saida="$2" corte="$3" p v r data integ_lock integ_reg ec cs
  cs="$(epoch "$corte")" || falhar "corte invalido: $corte"
  : > "$saida"
  for pv in "${ALVOS[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"
    r="$(versao_no_lock "$lock" "$p")" || falhar "$p: nao foi possivel ler a versao no lock $lock"
    exigir_versao "$r" "$p"
    cmp_versao_ge "$r" "$v" && ec=0 || ec=$?
    [ "$ec" -eq 0 ] || falhar "$p resolvido em $r (< minimo $v que corrige o alerta, ou formato invalido: ec=$ec)"
    data="$(publicada_em "$p" "$r")" || falhar "$p@$r: data de publicacao indisponivel no registro"
    [ "$(epoch "$data")" -le "$cs" ] || falhar "$p@$r publicada em $data, depois do corte $corte"
    integ_lock="$(integridade_no_lock "$lock" "$p")" || falhar "$p: integridade ausente no lock"
    exigir_integridade "$integ_lock" "$p (lock)"
    integ_reg="$(integridade_registro "$p" "$r")" || falhar "$p@$r: integridade indisponivel no registro"
    exigir_integridade "$integ_reg" "$p (registro)"
    [ "$integ_lock" = "$integ_reg" ] || falhar "$p@$r: integridade do lock ($integ_lock) != registro ($integ_reg)"
    echo "$p=$r publicada=$data integridade=$integ_lock" >> "$saida"; tail -1 "$saida"
  done
}
sem_pacote_novo_ou_removido() {  # <lock antes> <lock depois> <saída>
  local a b
  a="$(nomes_lock "$1")" || falhar "nao foi possivel listar o lock $1"
  b="$(nomes_lock "$2")" || falhar "nao foi possivel listar o lock $2"
  if diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") > "$3"; then echo "nenhum pacote novo/removido" >> "$3"; tail -1 "$3"; else falhar "o lock adiciona/remove pacotes (ver $3)"; fi
}
sem_proibidos_no_diff() { if diff "$1" "$2" | grep -E "^[<>]\s*$PROIBIDOS_NO_DIFF"; then falhar "o lock tocou pacote proibido"; fi; }
so_zod_mudou() {  # <package.json antes> <depois>
  if diff "$1" "$2" | grep -E '^[<>]' | grep -vE '^[<>]\s*"zod": "\^?[0-9][0-9.]*",?\s*$'; then falhar "package.json mudou alem da faixa do zod"; fi
  if diff -q "$1" "$2" > /dev/null; then echo "package.json inalterado"; else echo "package.json: so a faixa do zod mudou (permitido)"; fi
}
auditar() {  # <json de saída> <resumo de saída>; cwd = diretório com o lock a auditar. npm audit sai != 0 quando ha vulnerabilidades: isso NAO e erro de execucao
  "$NPM" audit --json --registry="$REGISTRO" > "$1" 2> "$1.err" || true
  "$NODE" -e '
    const fs=require("node:fs"),path=require("node:path"); let a; try { a=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8")); } catch { console.error("audit JSON ilegivel"); process.exit(3); }
    if (a.error) { console.error("npm audit falhou:", a.error.code||a.error.summary); process.exit(2); }
    const m=a.metadata&&a.metadata.vulnerabilities; if (!m || typeof m.total!=="number") { console.error("audit sem metadata"); process.exit(4); }
    const linhas=[JSON.stringify(m)]; for (const [n,x] of Object.entries(a.vulnerabilities||{})) linhas.push(`${x.severity} ${n}@${x.range}`);
    fs.writeFileSync(process.argv[2], linhas.join("\n")+"\n"); console.log(linhas.join("\n"));' "$1" "$2"
}
exigir_restantes_fase1() {  # <json> <saída nominal>
  "$NODE" -e '
    const fs=require("node:fs"),path=require("node:path"); const a=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8")); const saida=process.argv[2];
    const permitidos=new Set(process.argv.slice(3)); const m=a.metadata.vulnerabilities; const v=a.vulnerabilities||{}; const nomes=Object.keys(v).sort();
    const fora=nomes.filter(n=>!permitidos.has(n)); const naoModeradas=nomes.filter(n=>v[n].severity!=="moderate");
    const linhas=nomes.map(n=>`${v[n].severity} ${n}@${v[n].range} via=${(v[n].via||[]).map(w=>typeof w==="string"?w:`${w.title} [${w.url}]`).join(" | ")} fixAvailable=${JSON.stringify(v[n].fixAvailable)}`);
    fs.writeFileSync(saida, [`total=${m.total} critical=${m.critical} high=${m.high} moderate=${m.moderate} low=${m.low} info=${m.info}`, ...linhas, ""].join("\n"));
    for (const l of linhas) console.log("REMANESCENTE", l);
    if (m.critical!==0||m.high!==0||naoModeradas.length||fora.length) { console.error("FASE1 reprovada: criticas=",m.critical,"altas=",m.high,"fora da lista=",fora,"nao moderadas=",naoModeradas); process.exit(1); }
    console.log("FASE1 ok: remanescentes (pendentes de decisao H-DEP3-a/b) =", nomes.join(",")||"(nenhum)");' "$1" "$2" "${RESTANTES_FASE1[@]}"
}
exigir_total_zero() { "$NODE" -e 'const fs=require("node:fs"),path=require("node:path");const a=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8"));const m=a.metadata.vulnerabilities;if(m.total!==0){console.error("FINAL reprovado: total=",m.total,m);process.exit(1)}console.log("FINAL ok: total 0")' "$1"; }
executar_gravando() {  # <arquivo de saída> <comando...>: grava stdout+stderr, mostra o fim e reprova se o status != 0
  local saida="$1"; shift
  if ! "$@" > "$saida" 2>&1; then tail -20 "$saida" >&2; falhar "comando reprovado: $* (ver $saida)"; fi
  tail -3 "$saida"
}
rodar_suite_completa() {  # cwd backend; <recibo>
  info "suite completa (Node 22) -> TAP"; "$NODE" --require ./test/setup.js --test "test/**/*.test.js" > "$1/completa.tap" 2>&1 || true
  grep -E "^# (tests|pass|fail|todo)" "$1/completa.tap" >> "$1/veredito.txt" || falhar "TAP sem resumo"
  grep -E "^# (tests|pass|fail|todo)" "$1/completa.tap"
  grep -E "^\s*not ok" "$1/completa.tap" | grep -v "# TODO" > "$1/falhas.txt" || true
  grep -qE "^\s*ok [0-9]+ - TPX-04" "$1/completa.tap" || falhar "TPX-04 nao passou"
  local nfail; nfail="$(grep -E '^# fail' "$1/completa.tap" | awk '{print $3}')"; [[ "$nfail" =~ ^[0-9]+$ ]] || falhar "contagem de falhas ilegivel"
  if [ "$nfail" = "0" ]; then echo "SUITE-VERDE" >> "$1/veredito.txt"
  elif [ "$nfail" = "1" ] && grep -qE '^\s*not ok [0-9]+ - CAP-B01' "$1/completa.tap"; then echo "SUITE-VERDE-COM-RESSALVA (unica falha: CAP-B01, preexistente no macOS, documentada; verde na CI Linux)" >> "$1/veredito.txt"
  else falhar "suite com $nfail falha(s) alem da ressalva conhecida (ver $1/falhas.txt)"; fi
  tail -1 "$1/veredito.txt"
}
orcamento_rodada_a() {
  local total=0 d usado
  for d in "${DIRETORIOS_DA_RODADA[@]}"; do [ -d "$d" ] || continue; usado="$(du -sk "$d" | awk '{print $1}')"; [[ "$usado" =~ ^[0-9]+$ ]] || falhar "medicao de $d invalida"; total=$((total + usado)); done
  for d in /private/tmp/swb-*; do [ -d "$d" ] || continue; usado="$(du -sk "$d" | awk '{print $1}')"; [[ "$usado" =~ ^[0-9]+$ ]] || falhar "medicao de $d invalida"; total=$((total + usado)); done
  echo "orcamento-rodada-a[$1]: $total KiB usados (limite $ORCAMENTO_KIB)"
  [ "$total" -le "$ORCAMENTO_KIB" ] || falhar "orcamento unico de 20 GB da Rodada A atingido"
}

# ---------------------------------------------------------------- pré-condições comuns e recibo
preparar() {
  local MODO="$1" PROPRIO livre instante corte agora
  PROPRIO="$(shasum -a 256 "$0" | cut -c1-64)"; [[ "$PROPRIO" =~ $RE_SHA ]] || falhar "hash do script ilegivel"
  echo "gate_sha256=$PROPRIO"
  [ -n "${GATE_SHA256:-}" ] || falhar "GATE_SHA256 nao informado (hash aprovado deste script)"
  [ "$GATE_SHA256" = "$PROPRIO" ] || falhar "o script nao e o aprovado (esperado $GATE_SHA256)"
  [ -x "$NODE" ] && [ -x "$NPM" ] || falhar "Node 22.23.3 nao encontrado em $NODE_BIN"
  [ "$("$NODE" -p 'process.versions.node')" = "22.23.3" ] || falhar "node nao e 22.23.3"
  export PATH="$NODE_BIN:$PATH"
  [ -d "$G2" ] && [ -f "$LOCK" ] && [ -f "$PKG" ] || falhar "G2, package.json ou package-lock.json ausentes em $BACKEND"
  cd "$G2"
  [ "$(git branch --show-current)" = "$BRANCH_ESPERADA" ] || falhar "branch diferente de $BRANCH_ESPERADA"
  [ "$(git rev-parse origin/main)" = "$MAIN_ESPERADA" ] || falhar "origin/main local != MAIN_ESPERADA ($MAIN_ESPERADA)"
  livre="$(df -g . | awk 'NR==2{print $4}')"; [[ "$livre" =~ ^[0-9]+$ ]] || falhar "leitura de espaco invalida"
  [ "$livre" -ge "$RESERVA_GIB" ] || falhar "so $livre GiB livres (minimo $RESERVA_GIB)"
  instante="$(date -u +%Y%m%dT%H%M%SZ)"
  RECIBO="$EVID/execucoes/$MODO-$instante"; [ ! -e "$RECIBO" ] || falhar "recibo ja existe: $RECIBO"
  mkdir -p "$RECIBO" && chmod 700 "$EVID" "$RECIBO"
  agora="$(date -u +%s)"
  corte="$(date -u -r $((agora - MATURIDADE_DIAS * 86400)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$((agora - MATURIDADE_DIAS * 86400))" +%Y-%m-%dT%H:%M:%SZ)"
  epoch "$corte" > /dev/null || falhar "corte ilegivel"
  CORTE="$corte"; INSTANTE="$instante"
  { echo "modo=$MODO instante=$INSTANTE gate_sha256=$PROPRIO corte=$CORTE maturidade_dias=$MATURIDADE_DIAS"
    echo "branch=$(git branch --show-current) head=$(git rev-parse HEAD) origin_main=$(git rev-parse origin/main)"
    echo "node=$("$NODE" -v) npm=$("$NPM" -v) livre_gib=$livre"; } > "$RECIBO/cabecalho.txt"
  echo "recibo=$RECIBO corte=$CORTE"
  orcamento_rodada_a "$MODO" >> "$RECIBO/cabecalho.txt"; tail -1 "$RECIBO/cabecalho.txt"
}

modo_pre() {
  local p v r d integ
  lock_intacto || falhar "package.json/lock ja diferem do HEAD; 'pre' exige lock intacto"
  cp -p "$LOCK" "$RECIBO/package-lock.antes.json"; cp -p "$PKG" "$RECIBO/package.antes.json"
  for p in "${PACOTES[@]}"; do
    r="$(versao_no_lock "$LOCK" "$p")" || falhar "$p: nao encontrado no lock"
    exigir_versao "$r" "$p"
    echo "lock_antes $p=$r" >> "$RECIBO/lock-antes.txt"; tail -1 "$RECIBO/lock-antes.txt"
  done
  info "registro: existencia, data e integridade das versoes MINIMAS"
  for pv in "${ALVOS[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"
    d="$(publicada_em "$p" "$v")" || falhar "$p@$v inexistente no registro"
    integ="$(integridade_registro "$p" "$v")" || falhar "$p@$v sem integridade no registro"; exigir_integridade "$integ" "$p@$v"
    echo "$p@$v publicada=$d integridade=$integ" >> "$RECIBO/registro.txt"; tail -1 "$RECIBO/registro.txt"
  done
  info "audit ANTES (so leitura)"; ( cd "$BACKEND" && auditar "$RECIBO/audit-antes.json" "$RECIBO/audit-antes.resumo.txt" ) || falhar "audit antes ilegivel"
  [ "$(wc -l < "$RECIBO/lock-antes.txt" | tr -d ' ')" = "${#PACOTES[@]}" ] || falhar "lock-antes incompleto"
  echo "PRE-APROVADO corte=$CORTE" > "$RECIBO/veredito.txt"; cat "$RECIBO/veredito.txt"
}

modo_ensaio_copia() {
  local DEST tam
  lock_intacto || falhar "lock ja alterado; o ensaio em copia exige lock intacto"
  DEST="$HOME/SafeWorkDados/dep3-ensaio/copia-$INSTANTE"; [ ! -e "$DEST" ] || falhar "destino do ensaio ja existe"
  tam="$(du -sk "$BACKEND" | awk '{print $1}')"; [[ "$tam" =~ ^[0-9]+$ ]] || falhar "medicao do backend invalida"
  [ "$tam" -lt "$ORCAMENTO_KIB" ] || falhar "backend ocupa $tam KiB; acima do orcamento"
  mkdir -p "$DEST" && chmod 700 "$DEST"
  info "copiando backend ($((tam/1024)) MB) para $DEST"; cp -a "$BACKEND" "$DEST/backend"
  cp -p "$LOCK" "$RECIBO/package-lock.antes.json"; cp -p "$PKG" "$RECIBO/package.antes.json"
  cd "$DEST/backend"
  info "npm update --before=$CORTE dos seis pacotes, na COPIA"
  executar_gravando "$RECIBO/update.txt" "$NPM" update --before="$CORTE" "${NPM_FLAGS[@]}" "${PACOTES[@]}"
  lock_intacto || falhar "o worktree foi alterado pelo ensaio em copia (nao deveria)"
  so_zod_mudou "$RECIBO/package.antes.json" "$DEST/backend/package.json" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
  cp -p package.json "$RECIBO/package.copia.json"; cp -p package-lock.json "$RECIBO/package-lock.copia.json"
  conferir_resolvidos "$DEST/backend/package-lock.json" "$RECIBO/versoes-resolvidas.txt" "$CORTE"
  sem_pacote_novo_ou_removido "$RECIBO/package-lock.antes.json" "$DEST/backend/package-lock.json" "$RECIBO/lock-nomes.diff"
  sem_proibidos_no_diff "$RECIBO/package-lock.antes.json" "$DEST/backend/package-lock.json"
  info "npm ci --ignore-scripts na copia"; executar_gravando "$RECIBO/ci.txt" "$NPM" ci "${NPM_FLAGS[@]}"
  info "audit na copia"; auditar "$RECIBO/audit-copia.json" "$RECIBO/audit-copia.resumo.txt" || falhar "audit da copia ilegivel"
  exigir_restantes_fase1 "$RECIBO/audit-copia.json" "$RECIBO/restantes.txt" >> "$RECIBO/veredito.txt" || falhar "audit da copia fora do criterio da Fase 1 (ver $RECIBO/restantes.txt)"
  tail -1 "$RECIBO/veredito.txt"
  info "testes focais na copia"
  "$NODE" --require ./test/setup.js --test test/config/proxy-addr-condicao-de-explorabilidade.test.js test/config/http.test.js test/config/env-example.test.js test/app-recuperacao-senha.test.js test/app-solicitacao-epi.test.js test/middleware/autenticacao-ip.test.js test/services/backup-executor-invariantes.test.js test/services/backup-aws-sdk-carregador.test.js test/backup-guarda/guarda-estatica.test.js test/backup-guarda/guarda-mutacao.test.js > "$RECIBO/focais.tap" 2>&1 || true
  grep -E "^# (tests|pass|fail)" "$RECIBO/focais.tap" >> "$RECIBO/veredito.txt" || falhar "TAP focal sem resumo"
  grep -E "^# (tests|pass|fail)" "$RECIBO/focais.tap"
  grep -qE "^# fail 0$" "$RECIBO/focais.tap" || falhar "testes focais com falha na copia"
  [ "$(wc -l < "$RECIBO/versoes-resolvidas.txt" | tr -d ' ')" = "${#ALVOS[@]}" ] || falhar "versoes-resolvidas incompleto"
  echo "ENSAIO-COPIA-APROVADO corte=$CORTE (worktree intacto; copia em $DEST; use ENSAIO=$RECIBO no aplicar)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
}

modo_aplicar() {
  local CORTE_ENSAIO SNAP
  lock_intacto || falhar "lock ja alterado; 'aplicar' so parte do HEAD"
  [ -n "${ENSAIO:-}" ] && [ -f "$ENSAIO/versoes-resolvidas.txt" ] && [ -f "$ENSAIO/package.copia.json" ] && grep -q "ENSAIO-COPIA-APROVADO" "$ENSAIO/veredito.txt" || falhar "ENSAIO=<recibo aprovado do ensaio-copia> obrigatorio"
  [ "$(wc -l < "$ENSAIO/versoes-resolvidas.txt" | tr -d ' ')" = "${#ALVOS[@]}" ] || falhar "versoes-resolvidas do ensaio incompleto"
  CORTE_ENSAIO="$(grep -oE 'corte=[^ ]+' "$ENSAIO/cabecalho.txt" | head -1 | cut -d= -f2)"; epoch "$CORTE_ENSAIO" > /dev/null || falhar "corte do ensaio ilegivel"
  echo "corte_do_ensaio=$CORTE_ENSAIO ensaio=$ENSAIO" >> "$RECIBO/cabecalho.txt"
  SNAP="$HOME/SafeWorkDados/dep3-snapshots/snapshot-$INSTANTE"; [ ! -e "$SNAP" ] || falhar "snapshot ja existe"
  mkdir -p "$SNAP" && chmod 700 "$SNAP"
  info "snapshot de package.json, lock e node_modules em $SNAP"
  cp -p "$PKG" "$LOCK" "$SNAP/" && cp -a "$BACKEND/node_modules" "$SNAP/node_modules"
  ( cd "$SNAP" && shasum -a 256 package.json package-lock.json > ARQUIVOS.sha256 && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 > DIGEST.txt ) || falhar "snapshot incompleto"
  [[ "$(cat "$SNAP/DIGEST.txt")" =~ $RE_SHA ]] || falhar "digest do snapshot ilegivel"
  { echo "snapshot=$SNAP"; cat "$SNAP/ARQUIVOS.sha256"; echo "digest=$(cat "$SNAP/DIGEST.txt")"; } >> "$RECIBO/snapshot.txt"; echo "$SNAP" > "$RECIBO/snapshot-dir.txt"
  cd "$BACKEND"
  info "npm update --before=$CORTE_ENSAIO (mesmo corte do ensaio)"
  executar_gravando "$RECIBO/update.txt" "$NPM" update --before="$CORTE_ENSAIO" "${NPM_FLAGS[@]}" "${PACOTES[@]}"
  so_zod_mudou "$SNAP/package.json" "$PKG" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
  diff -q "$PKG" "$ENSAIO/package.copia.json" > /dev/null || falhar "package.json resultante difere do ensaio"
  conferir_resolvidos "$LOCK" "$RECIBO/versoes-resolvidas.txt" "$CORTE_ENSAIO"
  diff <(cut -d' ' -f1 "$ENSAIO/versoes-resolvidas.txt") <(cut -d' ' -f1 "$RECIBO/versoes-resolvidas.txt") || falhar "versoes resolvidas diferem do ensaio (registro mudou); refaca o ensaio"
  sem_pacote_novo_ou_removido "$SNAP/package-lock.json" "$LOCK" "$RECIBO/lock-nomes.diff"
  sem_proibidos_no_diff "$SNAP/package-lock.json" "$LOCK"
  info "npm ci --ignore-scripts"; executar_gravando "$RECIBO/ci.txt" "$NPM" ci "${NPM_FLAGS[@]}"
  echo "APLICADO (so o lock e, se tanto, a faixa do zod mudaram; node_modules reinstalado; snapshot $SNAP)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
}

modo_aceite() {  # aceite-fase1 | aceite-final
  local MODO="$1" p v r rl ec
  cd "$BACKEND"
  git -C "$G2" show HEAD:backend/package.json > "$RECIBO/package.head.json"
  so_zod_mudou "$RECIBO/package.head.json" "$PKG" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
  if git -C "$G2" diff --quiet HEAD -- backend/package-lock.json; then falhar "lock igual ao HEAD: nada foi aplicado"; fi
  for pv in "${ALVOS[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"
    r="$(versao_instalada "$p")" || falhar "$p nao instalado em node_modules"; exigir_versao "$r" "$p (instalado)"
    rl="$(versao_no_lock "$LOCK" "$p")" || falhar "$p ausente do lock"; exigir_versao "$rl" "$p (lock)"
    [ "$r" = "$rl" ] || falhar "$p: node_modules ($r) != lock ($rl)"
    cmp_versao_ge "$r" "$v" && ec=0 || ec=$?; [ "$ec" -eq 0 ] || falhar "$p instalado em $r (< $v, ec=$ec)"
    echo "instalado $p=$r (minimo $v)" >> "$RECIBO/instalados.txt"; tail -1 "$RECIBO/instalados.txt"
  done
  info "audit DEPOIS"; auditar "$RECIBO/audit-depois.json" "$RECIBO/audit-depois.resumo.txt" || falhar "audit depois ilegivel"
  if [ "$MODO" = "aceite-fase1" ]; then exigir_restantes_fase1 "$RECIBO/audit-depois.json" "$RECIBO/restantes.txt" >> "$RECIBO/veredito.txt" || falhar "Fase 1: vulnerabilidades fora do criterio (ver $RECIBO/restantes.txt)"
  else exigir_total_zero "$RECIBO/audit-depois.json" >> "$RECIBO/veredito.txt" || falhar "Final: audit nao zerado"; fi
  tail -1 "$RECIBO/veredito.txt"
  info "npm audit signatures"; "$NPM" audit signatures --registry="$REGISTRO" > "$RECIBO/signatures.txt" 2>&1 || falhar "audit signatures reprovado (ver $RECIBO/signatures.txt)"
  grep -qiE "verified|verificad" "$RECIBO/signatures.txt" || falhar "audit signatures sem confirmacao"
  rodar_suite_completa "$RECIBO"
  if [ "$MODO" = "aceite-fase1" ]; then echo "ACEITE-FASE1-APROVADO (restam so as moderadas enumeradas em restantes.txt, pendentes de decisao H-DEP3-a/b)" >> "$RECIBO/veredito.txt"
  else echo "ACEITE-FINAL-APROVADO (total 0)" >> "$RECIBO/veredito.txt"; fi
  tail -1 "$RECIBO/veredito.txt"
  ( cd "$RECIBO" && find . -maxdepth 1 -type f ! -name 'MANIFESTO*' | sed 's#^\./##' | sort | xargs shasum -a 256 > MANIFESTO.sha256 )
  echo "Git (so Ramires): git -C $G2 add backend/package-lock.json backend/package.json && git -C $G2 diff --cached --stat"
}

modo_reverter() {
  local DIG DIG2
  [ -n "${SNAPSHOT:-}" ] && [ -d "$SNAPSHOT/node_modules" ] && [ -f "$SNAPSHOT/DIGEST.txt" ] && [ -f "$SNAPSHOT/ARQUIVOS.sha256" ] || falhar "SNAPSHOT=<dir do snapshot> obrigatorio (com DIGEST.txt e ARQUIVOS.sha256)"
  ( cd "$SNAPSHOT" && shasum -a 256 -c ARQUIVOS.sha256 ) > "$RECIBO/snapshot-conferido.txt" 2>&1 || falhar "package.json/lock do snapshot divergem do registrado"
  DIG="$(cd "$SNAPSHOT" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"; [[ "$DIG" =~ $RE_SHA ]] || falhar "digest ilegivel"
  [ "$DIG" = "$(cat "$SNAPSHOT/DIGEST.txt")" ] || falhar "digest do node_modules do snapshot divergente"
  info "preservando o estado atual no recibo e restaurando package.json, package-lock.json e node_modules (nada e apagado)"
  cp -p "$PKG" "$RECIBO/package.revertido.json" && cp -p "$LOCK" "$RECIBO/package-lock.revertido.json"
  mv "$BACKEND/node_modules" "$BACKEND/node_modules.revertido-$INSTANTE"
  cp -p "$SNAPSHOT/package.json" "$PKG" && cp -p "$SNAPSHOT/package-lock.json" "$LOCK" && cp -a "$SNAPSHOT/node_modules" "$BACKEND/node_modules"
  ( cd "$BACKEND" && shasum -a 256 -c "$SNAPSHOT/ARQUIVOS.sha256" ) > "$RECIBO/restaurado-conferido.txt" 2>&1 || falhar "apos a restauracao, package.json/lock nao conferem com o snapshot"
  DIG2="$(cd "$BACKEND" && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
  [ "$DIG2" = "$DIG" ] || falhar "apos a restauracao, o digest do node_modules nao confere"
  echo "REVERTIDO (package.json, lock e node_modules iguais ao snapshot $SNAPSHOT; anteriores preservados em $RECIBO e $BACKEND/node_modules.revertido-$INSTANTE)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
}

main() {
  local MODO="${1:-}"
  case "$MODO" in pre|ensaio-copia|aplicar|aceite-fase1|aceite-final|reverter) ;; *) echo "uso: $0 <pre|ensaio-copia|aplicar|aceite-fase1|aceite-final|reverter>" >&2; exit 2;; esac
  preparar "$MODO"
  case "$MODO" in
    pre) modo_pre ;;
    ensaio-copia) modo_ensaio_copia ;;
    aplicar) modo_aplicar ;;
    aceite-fase1|aceite-final) modo_aceite "$MODO" ;;
    reverter) modo_reverter ;;
  esac
  echo "FIM $MODO $INSTANTE"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
