'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MARCO C, CONS-03): LANÇADOR do `pg_restore --list` para a verificação estrutural supervisionada. Mesmo desenho do lançador do `pg_dump`: este módulo NÃO inicia nada ao ser carregado
 * nem ao ser construído; o processo só nasce em `lancar(spec)`. Compatível com `supervisionar` (devolve `{ pid, saida, fluxosFechados }`) e com o verificador estrutural, mais `resultado`.
 *
 * `criarLancadorEstruturalComSpawn({ spawn })` -> `{ lancar(spec), situacao() }` (TypeError se `spawn` não for função). `criarLancadorEstruturalReal()` escolhe o `spawn` do Node INTERNAMENTE, só quando chamado
 * (o `require('node:child_process')` é adiado para dentro dessa função); nenhum teste a usa para lançar processo e nada a chama no carregamento.
 *
 * `lancar(spec)` valida o spec ANTES de qualquer spawn (cada propriedade lida uma vez; leitura que lança = inválido): executável absoluto e canônico terminado em `/pg_restore`; argumentos EXATAMENTE `['--list']` (nada de `--dbname`,
 * `--file`, host, usuário, senha ou arquivo: o artefato chega SÓ pela entrada padrão); ambiente EXATAMENTE vazio (nenhuma variável de conexão ao banco: `PGHOST`, `PGPASSWORD`... são recusadas); opcoes exatamente
 * `{ shell: false, detached: true, stdio: [inteiro >= 3, 'pipe', 'ignore'] }`. Falha: rejeita SPEC_INVALIDO, sem spawn.
 * Chama `spawn(executavel, ['--list'], { env: {}, shell: false, detached: true, stdio })` UMA vez e registra os ouvintes do filho de forma SÍNCRONA. Estados e rejeições como no lançador do `pg_dump`: NAO_INICIADO só com a ausência de início
 * comprovada; INICIO_INCONCLUSIVO em todo o resto antes do `spawn`; saída (`exit`) e fluxos (`close`) são promessas SEPARADAS, nenhuma prova a outra; `error` posterior só registra a causa segura. Mensagens e códigos fixos.
 *
 * CAPTURA RESTRITA: só os primeiros 64 KiB do stdout são retidos (o resto é lido e descartado, sem crescer a memória) e dele se extrai apenas `formato` (ex.: CUSTOM) e `entradas` (contagem de TOC); nada mais da saída, nunca o nome do banco, e a
 * saída bruta nunca sai deste módulo. `resultado` resolve no `close` com `{ formato, entradas, truncado }` (campos nulos se ausentes). stderr é descartado.
 *
 * LIMITES: a execução real de `pg_restore` NÃO foi exercida (proibida nesta atividade); `--list` só lê o sumário e não prova restauração; identidade de grupo/PGID e filhos órfãos seguem como no lançador do `pg_dump`.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const CODIGO_SEGURO = /^[A-Z][A-Z0-9_]{1,30}$/;
const CHAVES_DO_SPEC = ['executavel', 'argumentos', 'ambiente', 'opcoes'];
const CHAVES_DAS_OPCOES = ['shell', 'detached', 'stdio'];
const LIMITE_DA_CAPTURA = 64 * 1024;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const chavesExatas = (objeto, esperadas) => {
  const proprias = Reflect.ownKeys(objeto);
  return proprias.length === esperadas.length && proprias.every((chave) => typeof chave === 'string' && esperadas.includes(chave));
};
function caminhoAbsolutoCanonico(valor) {
  if (typeof valor !== 'string' || valor.length < 2 || valor.length > 4096 || valor[0] !== '/') return false;
  return valor.slice(1).split('/').every((parte) => SEGMENTO.test(parte) && parte !== '.' && parte !== '..');
}
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

function capturarSpec(spec) {
  try {
    if (!ehObjeto(spec) || !chavesExatas(spec, CHAVES_DO_SPEC)) return null;
    const { executavel, argumentos, ambiente, opcoes } = spec;
    if (!caminhoAbsolutoCanonico(executavel) || !executavel.endsWith('/pg_restore')) return null;
    if (!Array.isArray(argumentos) || argumentos.length !== 1 || argumentos[0] !== '--list') return null;
    if (!ehObjeto(ambiente) || Reflect.ownKeys(ambiente).length !== 0) return null;
    if (!ehObjeto(opcoes) || !chavesExatas(opcoes, CHAVES_DAS_OPCOES)) return null;
    const { shell, detached, stdio } = opcoes;
    if (shell !== false || detached !== true) return null;
    if (!Array.isArray(stdio) || stdio.length !== 3) return null;
    const entrada = stdio[0];
    if (!Number.isSafeInteger(entrada) || entrada < 3 || stdio[1] !== 'pipe' || stdio[2] !== 'ignore') return null;
    return { executavel, entrada };
  } catch {
    return null;
  }
}

/** Extrai só `formato` e `entradas` do começo do sumário (nada mais é retido). */
function resumir(texto, truncado) {
  const formato = /^;\s+Format:\s+([A-Za-z]{1,16})\s*$/m.exec(texto);
  const entradas = /^;\s+TOC Entries:\s+(\d{1,9})\s*$/m.exec(texto);
  return Object.freeze({ formato: formato === null ? null : formato[1].toUpperCase(), entradas: entradas === null ? null : Number(entradas[1]), truncado });
}

function criarLancadorEstruturalComSpawn(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções do lançador inválidas');
  const spawn = opcoes.spawn;
  if (!ehFuncao(spawn)) throw new TypeError('spawn inválido');
  const registros = [];

  function lancar(spec) {
    return new Promise((resolver, rejeitar) => {
      const capturado = capturarSpec(spec);
      if (capturado === null) {
        rejeitar(erro('SPEC_INVALIDO'));
        return;
      }
      const registro = { estado: 'INCONCLUSIVO', pid: null, terminou: false, fluxosFechados: false, causa: null };
      let filho;
      try {
        filho = spawn(capturado.executavel, ['--list'], { env: {}, shell: false, detached: true, stdio: [capturado.entrada, 'pipe', 'ignore'] });
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
      let resolverResultado = null;
      let retido = '';
      let truncado = false;

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
        const resultado = new Promise((res) => { resolverResultado = res; });
        saida.catch(() => {});
        fluxosFechados.catch(() => {});
        resultado.catch(() => {});
        resolver(Object.freeze({ pid, saida, fluxosFechados, resultado }));
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
        if (resolverResultado !== null) resolverResultado(resumir(retido, truncado));
      };
      // O stdout é lido e DESCARTADO além do limite: o excesso nunca é retido.
      const aoDado = (bloco) => {
        try {
          const texto = Buffer.isBuffer(bloco) ? bloco.toString('latin1') : String(bloco);
          const restante = LIMITE_DA_CAPTURA - retido.length;
          if (restante <= 0) { truncado = true; return; }
          if (texto.length > restante) { retido += texto.slice(0, restante); truncado = true; } else retido += texto;
        } catch { /* captura é melhor esforço; o contrato de término não depende dela */ }
      };

      try {
        const on = filho.on;
        if (!ehFuncao(on)) throw new TypeError('filho não observável');
        on.call(filho, 'error', aoErro);
        on.call(filho, 'spawn', aoSpawn);
        on.call(filho, 'exit', aoExit);
        on.call(filho, 'close', aoClose);
        const saidaPadrao = filho.stdout;
        if (saidaPadrao && ehFuncao(saidaPadrao.on)) {
          saidaPadrao.on('data', aoDado);
          saidaPadrao.on('error', () => {});
        }
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
function criarLancadorEstruturalReal() {
  const { spawn } = require('node:child_process');
  return criarLancadorEstruturalComSpawn({ spawn });
}

module.exports = { criarLancadorEstruturalComSpawn, criarLancadorEstruturalReal, LIMITE_DA_CAPTURA };
