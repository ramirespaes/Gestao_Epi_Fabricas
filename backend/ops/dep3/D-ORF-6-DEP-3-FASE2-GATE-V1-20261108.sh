#!/bin/bash
# D-ORF-6 — DEP-3 — FASE 2 (H-DEP3-a/b): GATE DE CORREÇÃO DAS CINCO MODERADAS — V1 (08/11/2026). PREPARADO, NÃO EXECUTADO.
# Reutiliza (por `source`) os leitores e validadores FAIL-CLOSED do gate V4 (hash conferido), e acrescenta os modos da Fase 2:
#   fase2-ensaio-copia   cópia do backend (estado pós-Fase 1) em ~/SafeWorkDados/dep3-ensaio/fase2-<instante>/; aplica as DUAS mudanças ao
#                        package.json da cópia (nodemailer "10.1.4" exato; overrides { glob: "14.0.2", minimatch: "11.0.1" }); `npm install
#                        --package-lock-only --before=<corte>` + `npm ci`; confere versões, integridade, adições permitidas, audit TOTAL 0,
#                        testes focais (e-mail, migrations estático, nodemon --version, guarda, executor); grava versoes-fase2.txt
#   fase2-aplicar        FASE2=<recibo aprovado do ensaio>; snapshot (package.json, lock, node_modules; formato do V4); mesmas mudanças
#                        no package.json da G2; `npm install --package-lock-only --before=<corte do ensaio>`; lock == ensaio para os alvos;
#                        `npm ci`; exige o teste dependencia-nodemailer já apontando para 10.1.4 (editado por autorização própria)
#   aceite-final         instalado == lock para nodemailer/glob/minimatch; `npm audit` TOTAL 0; `npm audit signatures`; suíte completa
#   reverter             idêntico ao do V4 (SNAPSHOT=<dir>): repõe os três e reconfere
# Regras: package.json só pode mudar em DUAS coisas (linha do nodemailer e bloco overrides exato); nenhum pacote removido; adições no lock só
# se forem dependências declaradas de glob@14.0.2 ou minimatch@11.0.1 (lidas do registro no momento); nenhum diff em @aws-sdk/*, express,
# node-pg-migrate, nodemon, nem nos seis da Fase 1; maturidade pelo corte (--before = agora − 7 dias); nunca `npm audit fix`; sem Git de escrita.
# Uso: GATE_SHA256=<hash deste script> GATE_V4_SHA256=85e3f7e5bd5a48a0a41c2bfd0c0fc85bbc653076c740e5b703af1bfdbd3c1fea bash <este> <modo>
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd -P)"
V4="$AQUI/D-ORF-6-DEP-3-GATE-ATUALIZACAO-V4-20261108.sh"
V4_ESPERADO="85e3f7e5bd5a48a0a41c2bfd0c0fc85bbc653076c740e5b703af1bfdbd3c1fea"
[ -f "$V4" ] || { echo "REPROVADO: gate V4 ausente em $V4" >&2; exit 1; }
[ "$(shasum -a 256 "$V4" | cut -c1-64)" = "${GATE_V4_SHA256:-}" ] && [ "$GATE_V4_SHA256" = "$V4_ESPERADO" ] || { echo "REPROVADO: GATE_V4_SHA256 ausente ou o V4 nao e o aprovado" >&2; exit 1; }
# shellcheck source=/dev/null
source "$V4"   # só funções e constantes (main protegido); traz set -euo pipefail

NODEMAILER_ALVO="10.1.4"
GLOB_ALVO="14.0.2"
MINIMATCH_ALVO="11.0.1"
ALVOS_FASE2=(nodemailer:$NODEMAILER_ALVO glob:$GLOB_ALVO minimatch:$MINIMATCH_ALVO)
PROIBIDOS_FASE2='"node_modules/(@aws-sdk/|express"|node-pg-migrate"|nodemon"|proxy-addr"|body-parser"|brace-expansion"|qs"|ip-address"|zod")'
TESTE_NODEMAILER="$BACKEND/test/infra/dependencia-nodemailer.test.js"

# aplica as duas mudanças ao package.json <arquivo>, de forma determinística (JSON reescrito com 2 espaços, como o npm faz)
aplicar_mudancas_package_json() {
  "$NODE" -e '
    const fs=require("node:fs"),path=require("node:path"); const f=path.resolve(process.argv[1]);
    const j=JSON.parse(fs.readFileSync(f,"utf8"));
    if (!j.dependencies || !j.dependencies.nodemailer) { console.error("package.json sem nodemailer"); process.exit(4); }
    j.dependencies.nodemailer=process.argv[2];
    j.overrides={ glob: process.argv[3], minimatch: process.argv[4] };
    fs.writeFileSync(f, JSON.stringify(j,null,2)+"\n");' "$1" "$NODEMAILER_ALVO" "$GLOB_ALVO" "$MINIMATCH_ALVO"
}
# só_mudancas_fase2 <antes> <depois>: a diferença tem de ser EXATAMENTE nodemailer + overrides (comparação estrutural, não textual)
so_mudancas_fase2() {
  "$NODE" -e '
    const fs=require("node:fs"),path=require("node:path");
    const a=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8")), b=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),"utf8"));
    const esp=JSON.parse(JSON.stringify(a)); esp.dependencies.nodemailer=process.argv[3]; esp.overrides={glob:process.argv[4],minimatch:process.argv[5]};
    const canon=o=>JSON.stringify(Object.keys(o).sort().reduce((r,k)=>(r[k]=o[k],r),{}));
    if (canon(esp)!==canon(b) || JSON.stringify(esp.dependencies)!==JSON.stringify(b.dependencies) || JSON.stringify(esp.overrides)!==JSON.stringify(b.overrides) || JSON.stringify(esp.devDependencies)!==JSON.stringify(b.devDependencies)) { console.error("package.json difere do esperado da Fase 2"); process.exit(1); }
    console.log("package.json: so nodemailer=" + process.argv[3] + " e overrides {glob:" + process.argv[4] + ", minimatch:" + process.argv[5] + "}");' "$1" "$2" "$NODEMAILER_ALVO" "$GLOB_ALVO" "$MINIMATCH_ALVO"
}
# adicoes_permitidas: nomes que podem APARECER no lock = dependências declaradas de glob@14.0.2 e minimatch@11.0.1 (lidas do registro)
adicoes_permitidas() {
  local a b
  a="$("$NPM" view "glob@$GLOB_ALVO" dependencies --json --registry="$REGISTRO" --fetch-retries=0)" || return 1
  b="$("$NPM" view "minimatch@$MINIMATCH_ALVO" dependencies --json --registry="$REGISTRO" --fetch-retries=0)" || return 1
  "$NODE" -e 'const n=new Set();for(const s of process.argv.slice(1)){let o;try{o=JSON.parse(s)}catch{process.exit(3)}if(o&&typeof o==="object")for(const k of Object.keys(o))n.add(k)}console.log([...n].sort().join("\n"))' "$a" "$b"
}
# a G2 não pode mudar durante o ensaio: hash de package.json e lock antes/depois (o lock JÁ difere do HEAD por direito: Fase 1 aplicada)
G2_ANTES=""
registrar_g2() { G2_ANTES="$(shasum -a 256 "$PKG" "$LOCK" | cut -c1-64 | tr '\n' ' ')"; echo "g2_antes=$G2_ANTES" >> "$RECIBO/cabecalho.txt"; }
exigir_g2_intacta() { [ "$(shasum -a 256 "$PKG" "$LOCK" | cut -c1-64 | tr '\n' ' ')" = "$G2_ANTES" ] || falhar "package.json/lock da G2 mudaram durante o ensaio (nao deveriam)"; }
# conferir_lock_fase2 <lock antes> <lock depois> <saída> <corte>: alvos ≥/== versão, publicação ≤ corte, integridade == registro; nenhum removido; adições ⊆ permitidas; proibidos intactos
conferir_lock_fase2() {
  local antes="$1" depois="$2" saida="$3" corte="$4" p v r data integ_lock integ_reg cs removidos adicoes permitidas fora
  cs="$(epoch "$corte")" || falhar "corte invalido"
  : > "$saida"
  for pv in "${ALVOS_FASE2[@]}"; do
    p="${pv%%:*}"; v="${pv##*:}"
    r="$(versao_no_lock "$depois" "$p")" || falhar "$p: nao foi possivel ler a versao no lock"
    exigir_versao "$r" "$p"; [ "$r" = "$v" ] || falhar "$p resolvido em $r (esperado exatamente $v)"
    data="$(publicada_em "$p" "$r")" || falhar "$p@$r: data indisponivel"; [ "$(epoch "$data")" -le "$cs" ] || falhar "$p@$r publicada depois do corte"
    integ_lock="$(integridade_no_lock "$depois" "$p")" || falhar "$p: integridade ausente no lock"; exigir_integridade "$integ_lock" "$p (lock)"
    integ_reg="$(integridade_registro "$p" "$r")" || falhar "$p@$r: integridade indisponivel"; exigir_integridade "$integ_reg" "$p (registro)"
    [ "$integ_lock" = "$integ_reg" ] || falhar "$p@$r: integridade lock != registro"
    echo "$p=$r publicada=$data integridade=$integ_lock" >> "$saida"; tail -1 "$saida"
  done
  # nenhuma OUTRA versao de minimatch/glob aninhada pode restar (a vulnerabilidade voltaria por outro caminho)
  "$NODE" -e 'const fs=require("node:fs"),path=require("node:path");const l=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8"));const ruins=Object.entries(l.packages).filter(([k,v])=>/(^|\/)node_modules\/(glob|minimatch)$/.test(k)&&!((k.endsWith("node_modules/glob")&&v.version===process.argv[2])||(k.endsWith("node_modules/minimatch")&&v.version===process.argv[3])));if(ruins.length){console.error("copias aninhadas vulneraveis:",ruins.map(([k,v])=>k+"@"+v.version));process.exit(1)}console.log("glob/minimatch: so as versoes corrigidas em todo o lock")' "$depois" "$GLOB_ALVO" "$MINIMATCH_ALVO" || falhar "ha copias aninhadas de glob/minimatch fora da versao corrigida"
  removidos="$(comm -23 <(nomes_lock "$antes") <(nomes_lock "$depois"))"; [ -z "$removidos" ] || falhar "pacotes removidos do lock: $removidos"
  adicoes="$(comm -13 <(nomes_lock "$antes") <(nomes_lock "$depois") | sed 's#^node_modules/##')"
  if [ -n "$adicoes" ]; then
    permitidas="$(adicoes_permitidas)" || falhar "nao foi possivel ler as dependencias de glob/minimatch no registro"
    fora="$(comm -23 <(printf '%s\n' "$adicoes" | sort) <(printf '%s\n' "$permitidas" | sort))"
    [ -z "$fora" ] || falhar "adicoes nao permitidas no lock: $fora"
    echo "adicoes (dependencias de glob@$GLOB_ALVO/minimatch@$MINIMATCH_ALVO): $(printf '%s' "$adicoes" | tr '\n' ' ')" >> "$saida"; tail -1 "$saida"
  else echo "nenhuma adicao no lock" >> "$saida"; fi
  if diff "$antes" "$depois" | grep -E "^[<>]\s*$PROIBIDOS_FASE2"; then falhar "o lock tocou pacote proibido na Fase 2 (SDK, express, node-pg-migrate, nodemon ou os seis da Fase 1)"; fi
}
testes_focais_fase2() {  # cwd = backend a testar; <recibo>
  "$NODE" --require ./test/setup.js --test test/infra/dependencia-nodemailer.test.js test/email/transporte-smtp.test.js test/email/transporte.test.js test/email/servico-email.test.js test/email/convite.test.js test/email/templates.test.js test/config/email.test.js test/db/checksums.test.js test/db/migration-097-estatico.test.js test/services/backup-executor-invariantes.test.js test/backup-guarda/guarda-estatica.test.js test/backup-guarda/guarda-mutacao.test.js test/config/proxy-addr-condicao-de-explorabilidade.test.js > "$1/focais.tap" 2>&1 || true
  grep -E "^# (tests|pass|fail)" "$1/focais.tap" >> "$1/veredito.txt" || falhar "TAP focal sem resumo"; grep -E "^# (tests|pass|fail)" "$1/focais.tap"
  grep -qE "^# fail 0$" "$1/focais.tap" || falhar "testes focais com falha"
  # nodemon e node-pg-migrate carregam com as versoes sobrescritas (sem rodar nada de verdade)
  "$NODE" node_modules/nodemon/bin/nodemon.js --version > "$1/nodemon-version.txt" 2>&1 || falhar "nodemon nao carrega com minimatch $MINIMATCH_ALVO"
  "$NODE" -e 'import("node-pg-migrate").then(m=>{if(typeof m.runner!=="function")process.exit(1);console.log("node-pg-migrate carrega; runner ok")}).catch(e=>{console.error(e.message);process.exit(1)})' > "$1/node-pg-migrate-carga.txt" 2>&1 || falhar "node-pg-migrate nao carrega com glob $GLOB_ALVO"
  cat "$1/nodemon-version.txt" "$1/node-pg-migrate-carga.txt"
}

modo_fase2_ensaio_copia() {
  local DEST tam
  grep -q "ACEITE-FASE1-APROVADO" "$EVID"/execucoes/aceite-fase1-*/veredito.txt 2>/dev/null || falhar "nenhum aceite-fase1 aprovado: a Fase 2 parte do estado pos-Fase 1"
  DEST="$HOME/SafeWorkDados/dep3-ensaio/fase2-$INSTANTE"; [ ! -e "$DEST" ] || falhar "destino ja existe"
  tam="$(du -sk "$BACKEND" | awk '{print $1}')"; [[ "$tam" =~ ^[0-9]+$ ]] && [ "$tam" -lt "$ORCAMENTO_KIB" ] || falhar "backend acima do orcamento"
  mkdir -p "$DEST" && chmod 700 "$DEST"; info "copiando backend ($((tam/1024)) MB) para $DEST"; cp -a "$BACKEND" "$DEST/backend"
  cp -p "$LOCK" "$RECIBO/package-lock.antes.json"; cp -p "$PKG" "$RECIBO/package.antes.json"
  registrar_g2
  cd "$DEST/backend"
  info "mudancas no package.json da COPIA"; aplicar_mudancas_package_json "$DEST/backend/package.json" || falhar "nao foi possivel aplicar as mudancas"
  so_mudancas_fase2 "$RECIBO/package.antes.json" "$DEST/backend/package.json" >> "$RECIBO/veredito.txt" || falhar "package.json da copia fora do esperado"; tail -1 "$RECIBO/veredito.txt"
  info "npm install --package-lock-only --before=$CORTE (so o lock) na copia"
  executar_gravando "$RECIBO/install-lock.txt" "$NPM" install --package-lock-only --before="$CORTE" "${NPM_FLAGS[@]}"
  exigir_g2_intacta
  cp -p package.json "$RECIBO/package.copia.json"; cp -p package-lock.json "$RECIBO/package-lock.copia.json"
  conferir_lock_fase2 "$RECIBO/package-lock.antes.json" "$DEST/backend/package-lock.json" "$RECIBO/versoes-fase2.txt" "$CORTE"
  info "npm ci --ignore-scripts na copia"; executar_gravando "$RECIBO/ci.txt" "$NPM" ci "${NPM_FLAGS[@]}"
  info "audit na copia (exige TOTAL 0)"; auditar "$RECIBO/audit-copia.json" "$RECIBO/audit-copia.resumo.txt" || falhar "audit ilegivel"
  exigir_total_zero "$RECIBO/audit-copia.json" >> "$RECIBO/veredito.txt" || falhar "audit da copia nao zerou (ver $RECIBO/audit-copia.resumo.txt)"; tail -1 "$RECIBO/veredito.txt"
  info "teste dependencia-nodemailer na copia precisa apontar para $NODEMAILER_ALVO (edicao autorizada a parte); se ainda afixa 10.0.13, o ensaio o ajusta SO NA COPIA"
  if ! grep -q "const VERSAO = '$NODEMAILER_ALVO'" test/infra/dependencia-nodemailer.test.js; then
    "$NODE" -e 'const fs=require("node:fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");s=s.replace(/const VERSAO = .*;/,"const VERSAO = \x27"+process.argv[2]+"\x27;").replace(/const INTEGRIDADE = .*;/,"const INTEGRIDADE = \x27"+process.argv[3]+"\x27;");fs.writeFileSync(f,s)' test/infra/dependencia-nodemailer.test.js "$NODEMAILER_ALVO" "$(integridade_no_lock "$DEST/backend/package-lock.json" nodemailer)"
    echo "teste dependencia-nodemailer ajustado SO NA COPIA (a G2 exige edicao autorizada antes do fase2-aplicar)" >> "$RECIBO/veredito.txt"
  fi
  testes_focais_fase2 "$RECIBO"
  exigir_g2_intacta
  echo "g2_depois=$(shasum -a 256 "$PKG" "$LOCK" | cut -c1-64 | tr '\n' ' ') g2_intacta=sim" >> "$RECIBO/cabecalho.txt"
  echo "FASE2-ENSAIO-APROVADO corte=$CORTE (copia em $DEST; use FASE2=$RECIBO no fase2-aplicar)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
  # manifesto do recibo por ULTIMO (depois da linha final do veredito): no ensaio de 08/11 00:47 a ordem inversa deixou veredito.txt divergente do manifesto (corrigido por MANIFESTO-2 aditivo)
  ( cd "$RECIBO" && find . -maxdepth 1 -type f ! -name 'MANIFESTO*' | sed 's#^\./##' | sort | xargs shasum -a 256 > MANIFESTO.sha256 )
}

modo_fase2_aplicar() {
  local CORTE_ENSAIO SNAP
  [ -n "${FASE2:-}" ] && [ -f "$FASE2/versoes-fase2.txt" ] && [ -f "$FASE2/package.copia.json" ] && grep -q "FASE2-ENSAIO-APROVADO" "$FASE2/veredito.txt" || falhar "FASE2=<recibo aprovado do fase2-ensaio-copia> obrigatorio"
  grep -q "ACEITE-FASE1-APROVADO" "$EVID"/execucoes/aceite-fase1-*/veredito.txt 2>/dev/null || falhar "nenhum aceite-fase1 aprovado"
  grep -q "const VERSAO = '$NODEMAILER_ALVO'" "$TESTE_NODEMAILER" || falhar "a G2 ainda afixa o nodemailer antigo em $TESTE_NODEMAILER: edicao autorizada necessaria ANTES do aplicar"
  CORTE_ENSAIO="$(grep -oE 'corte=[^ ]+' "$FASE2/cabecalho.txt" | head -1 | cut -d= -f2)"; epoch "$CORTE_ENSAIO" > /dev/null || falhar "corte do ensaio ilegivel"
  echo "corte_do_ensaio=$CORTE_ENSAIO fase2=$FASE2" >> "$RECIBO/cabecalho.txt"
  SNAP="$HOME/SafeWorkDados/dep3-snapshots/snapshot-fase2-$INSTANTE"; [ ! -e "$SNAP" ] || falhar "snapshot ja existe"
  mkdir -p "$SNAP" && chmod 700 "$SNAP"; info "snapshot (estado pos-Fase 1) em $SNAP"
  cp -p "$PKG" "$LOCK" "$SNAP/" && cp -a "$BACKEND/node_modules" "$SNAP/node_modules"
  ( cd "$SNAP" && shasum -a 256 package.json package-lock.json > ARQUIVOS.sha256 && find node_modules -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64 > DIGEST.txt ) || falhar "snapshot incompleto"
  { echo "snapshot=$SNAP"; cat "$SNAP/ARQUIVOS.sha256"; echo "digest=$(cat "$SNAP/DIGEST.txt")"; } >> "$RECIBO/snapshot.txt"; echo "$SNAP" > "$RECIBO/snapshot-dir.txt"
  cd "$BACKEND"
  info "mudancas no package.json da G2"; aplicar_mudancas_package_json "$PKG" || falhar "nao foi possivel aplicar as mudancas"
  so_mudancas_fase2 "$SNAP/package.json" "$PKG" >> "$RECIBO/veredito.txt" || falhar "package.json fora do esperado"; tail -1 "$RECIBO/veredito.txt"
  diff -q "$PKG" "$FASE2/package.copia.json" > /dev/null || falhar "package.json difere do ensaio"
  info "npm install --package-lock-only --before=$CORTE_ENSAIO"; executar_gravando "$RECIBO/install-lock.txt" "$NPM" install --package-lock-only --before="$CORTE_ENSAIO" "${NPM_FLAGS[@]}"
  conferir_lock_fase2 "$SNAP/package-lock.json" "$LOCK" "$RECIBO/versoes-fase2.txt" "$CORTE_ENSAIO"
  diff <(cut -d' ' -f1 "$FASE2/versoes-fase2.txt" | grep '=') <(cut -d' ' -f1 "$RECIBO/versoes-fase2.txt" | grep '=') || falhar "versoes diferem do ensaio; refaca o ensaio"
  diff <(nomes_lock "$FASE2/package-lock.copia.json") <(nomes_lock "$LOCK") > /dev/null || falhar "conjunto de pacotes do lock difere do ensaio"
  info "npm ci --ignore-scripts"; executar_gravando "$RECIBO/ci.txt" "$NPM" ci "${NPM_FLAGS[@]}"
  echo "FASE2-APLICADO (snapshot $SNAP)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
}

modo_aceite_final_fase2() {
  local p v r rl
  cd "$BACKEND"
  grep -q "FASE2-APLICADO" "$EVID"/execucoes/fase2-aplicar-*/veredito.txt 2>/dev/null || falhar "nenhum fase2-aplicar aprovado"
  for pv in "${ALVOS_FASE2[@]}"; do p="${pv%%:*}"; v="${pv##*:}"; r="$(versao_instalada "$p")" || falhar "$p nao instalado"; rl="$(versao_no_lock "$LOCK" "$p")" || falhar "$p ausente do lock"; [ "$r" = "$v" ] && [ "$rl" = "$v" ] || falhar "$p: instalado $r / lock $rl (esperado $v)"; echo "instalado $p=$r" >> "$RECIBO/instalados.txt"; done
  for pv in "${ALVOS[@]}"; do p="${pv%%:*}"; r="$(versao_instalada "$p")" || falhar "$p (Fase 1) nao instalado"; exigir_versao "$r" "$p"; echo "fase1_preservado $p=$r" >> "$RECIBO/instalados.txt"; done
  cat "$RECIBO/instalados.txt"
  info "audit FINAL (TOTAL 0)"; auditar "$RECIBO/audit-final.json" "$RECIBO/audit-final.resumo.txt" || falhar "audit ilegivel"
  exigir_total_zero "$RECIBO/audit-final.json" >> "$RECIBO/veredito.txt" || falhar "audit final nao zerado"; tail -1 "$RECIBO/veredito.txt"
  info "npm audit signatures"; "$NPM" audit signatures --registry="$REGISTRO" > "$RECIBO/signatures.txt" 2>&1 || falhar "audit signatures reprovado"
  grep -qiE "verified|verificad" "$RECIBO/signatures.txt" || falhar "audit signatures sem confirmacao"
  rodar_suite_completa "$RECIBO"
  echo "ACEITE-FINAL-APROVADO (npm audit total 0; Fase 1 preservada; H-DEP3-a/b encerradas)" >> "$RECIBO/veredito.txt"; tail -1 "$RECIBO/veredito.txt"
  ( cd "$RECIBO" && find . -maxdepth 1 -type f ! -name 'MANIFESTO*' | sed 's#^\./##' | sort | xargs shasum -a 256 > MANIFESTO.sha256 )
  echo "Git (so Ramires): git -C $G2 add backend/package.json backend/package-lock.json backend/test/infra/dependencia-nodemailer.test.js"
}

main_fase2() {
  local MODO="${1:-}"
  case "$MODO" in fase2-ensaio-copia|fase2-aplicar|aceite-final|reverter) ;; *) echo "uso: $0 <fase2-ensaio-copia|fase2-aplicar|aceite-final|reverter>" >&2; exit 2;; esac
  preparar "$MODO"
  case "$MODO" in
    fase2-ensaio-copia) modo_fase2_ensaio_copia ;;
    fase2-aplicar) modo_fase2_aplicar ;;
    aceite-final) modo_aceite_final_fase2 ;;
    reverter) modo_reverter ;;
  esac
  echo "FIM $MODO $INSTANTE"
}
main_fase2 "$@"
