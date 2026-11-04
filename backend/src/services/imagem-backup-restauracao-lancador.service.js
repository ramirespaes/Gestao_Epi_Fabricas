'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): LANÇADOR do `pg_restore` da RESTAURAÇÃO SUPERVISIONADA do banco. Mesmo desenho dos lançadores do `pg_dump` e do `pg_restore --list`: este módulo NÃO inicia nada ao ser carregado nem
 * ao ser construído; o processo só nasce em `lancar(spec)`. Compatível com `supervisionar` e com o restaurador do banco (devolve `{ pid, saida, fluxosFechados }`). NENHUM teste o usa para lançar processo real; a execução real do
 * `pg_restore` não foi exercida e nada aqui prova restauração operacional.
 *
 * `criarLancadorDeRestauracaoComSpawn({ spawn, politicaDeDestino: { prefixoDoBanco, hostsAutorizados, bancosProtegidos } })` (ESTRITO; TypeError genérico) -> `{ lancar(spec), situacao() }`. `criarLancadorDeRestauracaoReal({ politicaDeDestino })`
 * escolhe o `spawn` do Node INTERNAMENTE, só quando chamado (o `require('node:child_process')` é adiado para dentro dela).
 *
 * `lancar(spec)` valida o spec ANTES de qualquer spawn (cada propriedade lida uma vez; leitura que lança = inválido) e REMONTA argumentos e ambiente a partir dos valores validados (nada do que o chamador passou segue adiante além disso):
 *  - executável absoluto e canônico terminado em `/pg_restore`;
 *  - argumentos EXATAMENTE `--exit-on-error --no-owner --no-privileges --single-transaction --dbname=<banco>`, nessa ordem (nada de `--clean`, `--create`, `--file`, `--host`, `--username`, `--password`, `-d` ou qualquer outro);
 *  - POLÍTICA DE DESTINO imposta AQUI, independente da do restaurador (defesa em profundidade, fixada na construção e imutável pelo chamador): banco com o prefixo exigido, só `[a-z0-9_]`, fora dos protegidos, host autorizado;
 *  - ambiente EXATAMENTE `PGPASSFILE`, `PGHOST`, `PGPORT`, `PGUSER` (nenhuma senha, `PGDATABASE`, `PGOPTIONS`, `PATH` ou outra variável; o ambiente do processo atual NÃO é herdado);
 *  - opções exatamente `{ shell:false, detached:true, stdio:[inteiro >= 3 (o dump, entrada padrão), 'ignore', 'ignore'] }`: nenhuma saída é capturada nem retida.
 * Falha: rejeita SPEC_INVALIDO ou DESTINO_NAO_AUTORIZADO, sem spawn. Chama `spawn` UMA vez e registra os ouvintes do filho de forma SÍNCRONA. NAO_INICIADO só com a ausência de início comprovada; INICIO_INCONCLUSIVO em todo o resto
 * antes do `spawn`; saída (`exit`) e fluxos (`close`) são promessas SEPARADAS; `error` posterior só registra a causa segura. Mensagens e códigos fixos, sem eco de valores.
 *
 * LIMITES: execução real não exercida; identidade de grupo/PGID e filhos órfãos como nos demais lançadores; a política só vale para o que passa por este lançador; `PGPASSFILE` aponta um arquivo cujo conteúdo e permissões não são verificados aqui.
 */

const { hostAutorizavel, socketFisicoSeguro } = require('./imagem-backup-host-postgres');

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const BANCO = /^[a-z][a-z0-9_]{0,62}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const PORTA = /^[1-9][0-9]{0,4}$/;
const CODIGO_SEGURO = /^[A-Z][A-Z0-9_]{1,30}$/;
const CHAVES_DO_SPEC = ['executavel', 'argumentos', 'ambiente', 'opcoes'];
const CHAVES_DO_AMBIENTE = ['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGUSER'];
const CHAVES_DAS_OPCOES = ['shell', 'detached', 'stdio'];
const ARGUMENTOS_FIXOS = Object.freeze(['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction']);
const PREFIXO_DO_DBNAME = '--dbname=';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
function erro(codigo) {
  const falha = new Error('falha no lançamento');
  falha.code = codigo;
  return falha;
}
function causaSegura(falha) {
  try {
    const lido = falha !== null && typeof falha === 'object' ? falha.code : undefined;
    return typeof lido === 'string' && CODIGO_SEGURO.test(lido) ? lido : null;
  } catch {
    return null;
  }
}
function terminoValido(codigo, sinal) {
  if (Number.isInteger(codigo) && sinal === null) return { codigo, sinal: null };
  if (codigo === null && typeof sinal === 'string' && sinal !== '') return { codigo: null, sinal };
  return null;
}

function capturarPolitica(politica) {
  try {
    if (!ehObjeto(politica) || !chavesExatas(politica, ['prefixoDoBanco', 'hostsAutorizados', 'bancosProtegidos'])) throw new TypeError('política inválida');
    const { prefixoDoBanco, hostsAutorizados, bancosProtegidos } = politica;
    if (typeof prefixoDoBanco !== 'string' || !/^[a-z][a-z0-9_]{5,40}_$/.test(prefixoDoBanco)) throw new TypeError('política inválida');
    if (!Array.isArray(hostsAutorizados) || !hostsAutorizados.every((h) => hostAutorizavel(h))) throw new TypeError('política inválida');
    if (!Array.isArray(bancosProtegidos) || !bancosProtegidos.every((b) => typeof b === 'string' && b !== '')) throw new TypeError('política inválida');
    return Object.freeze({ prefixoDoBanco, hosts: new Set(hostsAutorizados), protegidos: new Set(bancosProtegidos.map((b) => b.toLowerCase())) });
  } catch {
    throw new TypeError('opções do lançador inválidas');
  }
}

/** Valida o spec e devolve só valores primitivos já validados (ou null / 'DESTINO'). */
function capturarSpec(spec, politica) {
  try {
    if (!ehObjeto(spec) || !chavesExatas(spec, CHAVES_DO_SPEC)) return { codigo: 'SPEC_INVALIDO' };
    const { executavel, argumentos, ambiente, opcoes } = spec;
    if (!caminhoAbsolutoCanonico(executavel) || !executavel.endsWith('/pg_restore')) return { codigo: 'SPEC_INVALIDO' };
    if (!Array.isArray(argumentos) || argumentos.length !== ARGUMENTOS_FIXOS.length + 1) return { codigo: 'SPEC_INVALIDO' };
    for (let i = 0; i < ARGUMENTOS_FIXOS.length; i += 1) if (argumentos[i] !== ARGUMENTOS_FIXOS[i]) return { codigo: 'SPEC_INVALIDO' };
    const ultimo = argumentos[ARGUMENTOS_FIXOS.length];
    if (typeof ultimo !== 'string' || !ultimo.startsWith(PREFIXO_DO_DBNAME)) return { codigo: 'SPEC_INVALIDO' };
    const banco = ultimo.slice(PREFIXO_DO_DBNAME.length);
    if (!BANCO.test(banco)) return { codigo: 'SPEC_INVALIDO' };
    if (!ehObjeto(ambiente) || !chavesExatas(ambiente, CHAVES_DO_AMBIENTE)) return { codigo: 'SPEC_INVALIDO' };
    const { PGPASSFILE: arquivoDeSenha, PGHOST: host, PGPORT: porta, PGUSER: usuario } = ambiente;
    if (!caminhoAbsolutoCanonico(arquivoDeSenha) || typeof host !== 'string' || typeof porta !== 'string' || !PORTA.test(porta) || Number(porta) > 65535 || !socketFisicoSeguro(host, Number(porta)) || typeof usuario !== 'string' || !USUARIO.test(usuario)) return { codigo: 'SPEC_INVALIDO' };
    if (!ehObjeto(opcoes) || !chavesExatas(opcoes, CHAVES_DAS_OPCOES)) return { codigo: 'SPEC_INVALIDO' };
    const { shell, detached, stdio } = opcoes;
    if (shell !== false || detached !== true || !Array.isArray(stdio) || stdio.length !== 3) return { codigo: 'SPEC_INVALIDO' };
    const entrada = stdio[0];
    if (!Number.isSafeInteger(entrada) || entrada < 3 || stdio[1] !== 'ignore' || stdio[2] !== 'ignore') return { codigo: 'SPEC_INVALIDO' };
    // política de destino imposta pelo lançador, independente da do restaurador
    if (!banco.startsWith(politica.prefixoDoBanco) || banco.length === politica.prefixoDoBanco.length || politica.protegidos.has(banco.toLowerCase()) || !politica.hosts.has(host)) return { codigo: 'DESTINO_NAO_AUTORIZADO' };
    return { executavel, banco, arquivoDeSenha, host, porta, usuario, entrada };
  } catch {
    return { codigo: 'SPEC_INVALIDO' };
  }
}

function criarLancadorDeRestauracaoComSpawn(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['spawn', 'politicaDeDestino'])) throw new TypeError('opções do lançador inválidas');
  const spawn = opcoes.spawn;
  if (!ehFuncao(spawn)) throw new TypeError('spawn inválido');
  const politica = capturarPolitica(opcoes.politicaDeDestino);
  const registros = [];

  function lancar(spec) {
    return new Promise((resolver, rejeitar) => {
      const capturado = capturarSpec(spec, politica);
      if (capturado.codigo !== undefined) {
        rejeitar(erro(capturado.codigo));
        return;
      }
      const registro = { estado: 'INCONCLUSIVO', pid: null, terminou: false, fluxosFechados: false, causa: null };
      let filho;
      try {
        // Argumentos e ambiente são REMONTADOS dos valores validados; o ambiente do processo atual não é herdado.
        filho = spawn(capturado.executavel, [...ARGUMENTOS_FIXOS, `${PREFIXO_DO_DBNAME}${capturado.banco}`], {
          env: { PGPASSFILE: capturado.arquivoDeSenha, PGHOST: capturado.host, PGPORT: capturado.porta, PGUSER: capturado.usuario },
          shell: false,
          detached: true,
          stdio: [capturado.entrada, 'ignore', 'ignore'],
        });
      } catch (falha) {
        registro.estado = 'NAO_INICIADO';
        registro.causa = causaSegura(falha);
        registros.push(registro);
        rejeitar(erro('NAO_INICIADO'));
        return;
      }
      registros.push(registro);

      let decidido = false;
      let exitVisto = false;
      let closeVisto = false;
      let resolverSaida = null;
      let rejeitarSaida = null;
      let resolverFluxos = null;

      const inconclusivo = () => {
        decidido = true;
        registro.estado = 'INCONCLUSIVO';
        registro.pid = null;
        rejeitar(erro('INICIO_INCONCLUSIVO'));
      };
      const aoSpawn = () => {
        if (decidido) return;
        let pid;
        try { pid = filho.pid; } catch { pid = undefined; }
        if (!(Number.isSafeInteger(pid) && pid > 1)) { inconclusivo(); return; }
        decidido = true;
        registro.estado = 'INICIADO';
        registro.pid = pid;
        const saida = new Promise((res, rej) => { resolverSaida = res; rejeitarSaida = rej; });
        const fluxosFechados = new Promise((res) => { resolverFluxos = res; });
        saida.catch(() => {});
        fluxosFechados.catch(() => {});
        resolver(Object.freeze({ pid, saida, fluxosFechados }));
      };
      const aoErro = (falha) => {
        const causa = causaSegura(falha);
        if (decidido) { if (registro.causa === null) registro.causa = causa; return; }
        let pid;
        try { pid = filho.pid; } catch { pid = null; }
        registro.causa = causa;
        if (pid === undefined) { decidido = true; registro.estado = 'NAO_INICIADO'; rejeitar(erro('NAO_INICIADO')); } else inconclusivo();
      };
      const aoExit = (codigo, sinal) => {
        if (!decidido || exitVisto) return;
        exitVisto = true;
        const termino = terminoValido(codigo, sinal);
        if (termino !== null) registro.terminou = true;
        if (resolverSaida !== null) {
          if (termino !== null) resolverSaida(Object.freeze(termino)); else rejeitarSaida(erro('TERMINO_INVALIDO'));
        }
      };
      const aoClose = () => {
        if (!decidido || closeVisto) return;
        closeVisto = true;
        registro.fluxosFechados = true;
        if (resolverFluxos !== null) resolverFluxos();
      };

      try {
        const on = filho.on;
        if (!ehFuncao(on)) throw new TypeError('filho não observável');
        on.call(filho, 'error', aoErro);
        on.call(filho, 'spawn', aoSpawn);
        on.call(filho, 'exit', aoExit);
        on.call(filho, 'close', aoClose);
      } catch {
        if (!decidido) inconclusivo();
      }
    });
  }

  function situacao() {
    return Object.freeze(registros.map((r) => Object.freeze({ estado: r.estado, pid: r.pid, terminou: r.terminou, fluxosFechados: r.fluxosFechados, causa: r.causa, grupoComprovado: false })));
  }
  return Object.freeze({ lancar, situacao });
}

/** O `spawn` real é escolhido AQUI, só quando a função é chamada (nunca no carregamento). Construir não lança nenhum processo. */
function criarLancadorDeRestauracaoReal(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['politicaDeDestino'])) throw new TypeError('opções do lançador inválidas');
  const { spawn } = require('node:child_process');
  return criarLancadorDeRestauracaoComSpawn({ spawn, politicaDeDestino: opcoes.politicaDeDestino });
}

module.exports = { criarLancadorDeRestauracaoComSpawn, criarLancadorDeRestauracaoReal };
