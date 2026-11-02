'use strict';

const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): IDENTIDADE DO POSTMASTER efêmero. Funções PURAS (sem processo, sem disco, sem rede): decidem, a partir de observações já feitas por quem as chama, se o processo observado é COMPROVADAMENTE o postmaster que a sentinela lançou e,
 * separadamente, se o ISOLAMENTO da instância está comprovado (a condição EXTRA exigida para o SIGQUIT de emergência). Qualquer ausência ou divergência é falha: nunca presunção.
 *
 * Identidade (todas as condições ao mesmo tempo, reconferidas antes de CADA sinal):
 *  - o handle do filho tem o pid esperado e ainda não terminou;
 *  - `postmaster.pid` traz o mesmo pid e o mesmo diretório de dados (o PostgreSQL persistente ou qualquer outro processo semelhante tem outro pid e/ou outro PGDATA);
 *  - `ps` mostra o mesmo dono, o pai é a sentinela, o mesmo instante de início (protege contra reutilização de pid) e a linha de comando é o executável lançado com o PGDATA desta execução.
 * Isolamento (só vale com a identidade): `postmaster.pid` confirma a porta e o diretório do socket desta execução e `listen_addresses` vazio (sem listener TCP).
 *
 * `esperado`: { pid, pgdata, porta, socket, uid, ppid, inicio, executavel }. `observado`: { filho: { pid, exitCode, signalCode }, pidArquivo: { pid, pgdata, porta, socket, listen } | null, ps: { uid, ppid, inicio, comando } | null }.
 */

const pidSeguro = (v) => Number.isSafeInteger(v) && v > 1;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Interpreta UMA linha de `ps -o uid=,ppid=,lstart=,command= -p <pid>` (lstart tem 5 campos). `null` se a forma não for exatamente essa. */
function interpretarLinhaDoPs(texto) {
  if (typeof texto !== 'string') return null;
  const t = texto.trim().split(/\s+/);
  if (t.length < 8) return null;
  const [uid, ppid, dia, mes, numero, hora, ano, ...comando] = t;
  if (!/^\d{1,10}$/.test(uid) || !/^\d{1,10}$/.test(ppid) || !/^[A-Za-z]{3}$/.test(dia) || !/^[A-Za-z]{3}$/.test(mes) || !/^\d{1,2}$/.test(numero) || !/^\d{2}:\d{2}:\d{2}$/.test(hora) || !/^\d{4}$/.test(ano)) return null;
  return Object.freeze({ uid: Number(uid), ppid: Number(ppid), inicio: `${dia} ${mes} ${numero} ${hora} ${ano}`, comando: comando.join(' ') });
}

/** Interpreta o texto de `postmaster.pid`: linha 1 pid, 2 diretório de dados, 4 porta, 5 diretório do socket, 6 listen_addresses. */
function interpretarPostmasterPid(texto) {
  if (typeof texto !== 'string' || texto.length > 4096) return null;
  const l = texto.split('\n');
  if (l.length < 6 || !/^\d{1,10}$/.test(l[0]) || !/^\d{1,5}$/.test(l[3])) return null;
  if (typeof l[1] !== 'string' || l[1][0] !== '/' || typeof l[4] !== 'string' || l[4][0] !== '/') return null;
  const identificador = Number(l[0]);
  if (!pidSeguro(identificador)) return null;
  return Object.freeze({ pid: identificador, pgdata: l[1], porta: Number(l[3]), socket: l[4], listen: l[5] });
}

function esperadoValido(e) {
  return ehObjeto(e) && pidSeguro(e.pid) && typeof e.pgdata === 'string' && e.pgdata !== '' && Number.isSafeInteger(e.porta) && e.porta > 0 && typeof e.socket === 'string' && e.socket !== ''
    && Number.isSafeInteger(e.uid) && Number.isSafeInteger(e.ppid) && typeof e.inicio === 'string' && e.inicio !== '' && typeof e.executavel === 'string' && e.executavel !== '';
}

function avaliarIdentidadeDoPostmaster({ esperado, observado } = {}) {
  if (!esperadoValido(esperado)) return Object.freeze({ comprovada: false, isolamento: false, falhas: Object.freeze(['IDENTIDADE_NAO_REGISTRADA']) });
  const e = esperado;
  const o = ehObjeto(observado) ? observado : {};
  const falhas = [];
  const f = ehObjeto(o.filho) ? o.filho : null;
  if (f === null || f.pid !== e.pid) falhas.push('FILHO_DIVERGENTE');
  else if (f.exitCode !== null || f.signalCode !== null) falhas.push('FILHO_JA_TERMINOU');
  const a = ehObjeto(o.pidArquivo) ? o.pidArquivo : null;
  if (a === null) falhas.push('POSTMASTER_PID_AUSENTE');
  else {
    if (a.pid !== e.pid) falhas.push('POSTMASTER_PID_DIVERGENTE');
    if (a.pgdata !== e.pgdata) falhas.push('POSTMASTER_PGDATA_DIVERGENTE');
  }
  const p = ehObjeto(o.ps) ? o.ps : null;
  if (p === null) falhas.push('PS_AUSENTE');
  else {
    if (p.uid !== e.uid) falhas.push('DONO_DIVERGENTE');
    if (p.ppid !== e.ppid) falhas.push('PAI_DIVERGENTE');
    if (p.inicio !== e.inicio) falhas.push('INICIO_DIVERGENTE');
    const comando = typeof p.comando === 'string' ? p.comando : '';
    const [executavel] = comando.split(/\s+/);
    if (path.basename(executavel ?? '') !== e.executavel || !comando.includes(` -D ${e.pgdata}`)) falhas.push('COMANDO_DIVERGENTE');
  }
  const comprovada = falhas.length === 0;
  const isolamentoFalhas = [];
  if (a !== null) {
    if (a.porta !== e.porta) isolamentoFalhas.push('ISOLAMENTO_PORTA_DIVERGENTE');
    if (a.socket !== e.socket) isolamentoFalhas.push('ISOLAMENTO_SOCKET_DIVERGENTE');
    if (a.listen !== '') isolamentoFalhas.push('ISOLAMENTO_LISTEN_NAO_VAZIO');
  }
  // o isolamento só vale junto com a identidade: nunca se declara isolada uma instância que não é comprovadamente a nossa
  const isolamento = comprovada && isolamentoFalhas.length === 0;
  return Object.freeze({ comprovada, isolamento, falhas: Object.freeze([...falhas, ...isolamentoFalhas]) });
}

module.exports = { avaliarIdentidadeDoPostmaster, interpretarLinhaDoPs, interpretarPostmasterPid };
