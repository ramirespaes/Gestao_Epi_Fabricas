'use strict';

const { hostSintaticamenteValido, socketFisicoSeguro, formaDoAmbiente, tlsDoAmbienteValido } = require('./imagem-backup-host-postgres');
const { criarCapturaDoDump } = require('./imagem-backup-captura-dump.service');
const { ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');
/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-LANCADOR-SEGURO-1): LANÇADOR PROVISÓRIO do processo externo (futuro `pg_dump`). Contrato
 * PROVISÓRIO: este módulo NÃO inicia processos reais por conta própria; recebe o `spawn` injetado (só para a implementação provisória e os testes, D8). A
 * execução real deverá escolher `child_process` INTERNAMENTE, sem receber nada do chamador, e continuam abertos: identidade do grupo e reutilização de PGID,
 * propriedade dos descritores no sistema operacional, procedimento para filhos órfãos e a distinção NAO_INICIADO × INCONCLUSIVO no supervisor e na composição.
 *
 * `criarLancadorComSpawn({ spawn })` -> `{ lancar(spec), situacao() }` (TypeError se `spawn` não for função).
 *
 * `lancar(spec)` -> Promise<{ pid, saida, fluxosFechados }>, compatível com o serviço do dump:
 *   1. captura e valida o spec ANTES de qualquer spawn (cada propriedade lida uma vez; leitura que lança = inválido): executável absoluto terminado em
 *      /pg_dump; exatamente os quatro argumentos fechados; ambiente exatamente PGPASSFILE, PGHOST, PGPORT e PGUSER (D-F7, opt-in: mais, em par, PGSSLMODE=verify-full e PGSSLROOTCERT); opcoes exatamente
 *      { shell: false, detached: true, stdio: ['ignore', inteiro >= 3, 'ignore'] }. Falha: rejeita SPEC_INVALIDO, sem spawn e sem registro;
 *   2. chama `spawn(executavel, argumentos, { env, shell: false, detached: true, stdio })` UMA vez, com cópias (nada de `process.env`), e registra os
 *      ouvintes do filho de forma SÍNCRONA (`spawn`, `error`, `exit`, `close`);
 *   3. ESTADOS: NAO_INICIADO só quando a ausência de início está comprovada (o `spawn` lançou; ou `error` ANTES de `spawn` com `pid` indefinido);
 *      INICIADO só com o evento `spawn` e `pid` inteiro seguro > 1 lido UMA vez; INCONCLUSIVO em todo o resto (evento `spawn` com pid inválido, `error` antes de
 *      `spawn` COM pid, retorno do `spawn` que não é um filho observável) e enquanto nada foi decidido. Nada é presumido: nenhum pid inventado, nenhum
 *      sinal, nenhum `kill`, nenhuma prova de encerramento;
 *   4. REJEIÇÕES com código fixo: SPEC_INVALIDO, NAO_INICIADO, INICIO_INCONCLUSIVO (e TERMINO_INVALIDO em `saida`); nunca a mensagem de `spawn`, de getters
 *      ou de eventos;
 *   5. EVENTOS (depois da decisão de início): `exit` (o PRIMEIRO decide; dados inválidos rejeitam `saida` com TERMINO_INVALIDO e ninguém os converte depois)
 *      resolve só `saida`; `close` (o primeiro) resolve só `fluxosFechados`; um não prova o outro, e `close` isolado não inventa o `exit`; `error`
 *      posterior só registra a causa segura e NÃO resolve nem rejeita nada nem apaga a identidade; `spawn` e eventos repetidos não mudam o decidido; eventos
 *      anteriores à decisão de início são ignorados. As promessas ficam pendentes na ausência de evidência (o supervisor trata prazo e falta de evidência);
 *      `saida` e `fluxosFechados` ganham um tratamento vazio de rejeição para nunca gerar rejeição sem tratamento.
 *
 * `situacao()` -> lista congelada de `{ estado, pid | null, terminou, fluxosFechados, causa | null, grupoComprovado: false }`: só diagnóstico seguro (a causa é
 * um código lido uma vez e de formato seguro). NÃO autoriza liberar a trava nem finalizar a transação, e `grupoComprovado` é sempre false (o lançador não
 * afirma identidade de grupo). A lista cresce sem limite nesta fase provisória.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const PORTA = /^[1-9][0-9]{0,4}$/;
const CODIGO_SEGURO = /^[A-Z][A-Z0-9_]{1,30}$/;
const ARGUMENTOS_FECHADOS = [
  /^--format=custom$/,
  /^--no-password$/,
  /^--snapshot=[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/,
  /^--dbname=[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/,
];
const CHAVES_DO_SPEC = ['executavel', 'argumentos', 'ambiente', 'opcoes'];
// Modo PIPE (captura durante a escrita): o spec traz também `saida: { descritor }` e `stdio` EXATAMENTE ['ignore','pipe','pipe']; o lançador, e só ele, liga o stdout à captura.
const CHAVES_DO_SPEC_PIPE = [...CHAVES_DO_SPEC, 'saida'];
const CHAVES_DO_AMBIENTE = ['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGUSER'];
const CHAVES_DAS_OPCOES = ['shell', 'detached', 'stdio'];

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';

function chavesExatas(objeto, esperadas) {
  const proprias = Reflect.ownKeys(objeto);
  return proprias.length === esperadas.length && proprias.every((chave) => typeof chave === 'string' && esperadas.includes(chave));
}

function caminhoAbsolutoCanonico(valor) {
  if (typeof valor !== 'string' || valor.length < 2 || valor.length > 4096 || valor[0] !== '/') return false;
  return valor.slice(1).split('/').every((parte) => SEGMENTO.test(parte) && parte !== '.' && parte !== '..');
}

/** Erro público: mensagem fixa e código fixo; nunca o texto de `spawn`, de getters ou de eventos. */
function erro(codigo) {
  const falha = new Error('falha no lançamento');
  falha.code = codigo;
  return falha;
}

/** Código de causa seguro: `code` lido UMA vez, só se tiver formato seguro; qualquer exceção do getter vira nulo. */
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

/** Valida e COPIA o spec numa passada só (cada propriedade lida uma vez). Devolve null se qualquer coisa for inválida. */
function capturarSpec(spec) {
  try {
    if (!ehObjeto(spec)) return null;
    const modoPipe = Reflect.ownKeys(spec).includes('saida');
    if (!chavesExatas(spec, modoPipe ? CHAVES_DO_SPEC_PIPE : CHAVES_DO_SPEC)) return null;
    const { executavel, argumentos, ambiente, opcoes } = spec;

    if (!caminhoAbsolutoCanonico(executavel) || !executavel.endsWith('/pg_dump')) return null;

    if (!Array.isArray(argumentos) || argumentos.length !== ARGUMENTOS_FECHADOS.length) return null;
    const lista = [];
    for (let i = 0; i < ARGUMENTOS_FECHADOS.length; i += 1) lista.push(argumentos[i]);
    if (!lista.every((argumento) => typeof argumento === 'string')) return null;
    // Cada padrão fechado precisa casar com exatamente um argumento (e cada argumento com exatamente um padrão).
    const casamentos = ARGUMENTOS_FECHADOS.map((padrao) => lista.filter((argumento) => padrao.test(argumento)).length);
    if (!casamentos.every((n) => n === 1)) return null;

    // D-F7 (opt-in): o conjunto fechado são as quatro chaves OU as quatro mais o par TLS (PGSSLMODE=verify-full e PGSSLROOTCERT), nunca uma chave só do par.
    const forma = formaDoAmbiente(ambiente, CHAVES_DO_AMBIENTE);
    if (forma === null) return null;
    const { PGPASSFILE, PGHOST, PGPORT, PGUSER, PGSSLMODE, PGSSLROOTCERT } = ambiente;
    if (!caminhoAbsolutoCanonico(PGPASSFILE)) return null;
    if (typeof PGPORT !== 'string' || !PORTA.test(PGPORT) || Number(PGPORT) > 65535) return null;
    // nome de host OU socket Unix (caminho completo dentro do limite; diretório real, próprio e privado, conferido ANTES do spawn)
    if (!socketFisicoSeguro(PGHOST, Number(PGPORT))) return null;
    if (typeof PGUSER !== 'string' || !USUARIO.test(PGUSER)) return null;
    if (forma === 'TLS' && !tlsDoAmbienteValido({ modo: PGSSLMODE, raiz: PGSSLROOTCERT, host: PGHOST, porta: Number(PGPORT) })) return null;

    if (!ehObjeto(opcoes) || !chavesExatas(opcoes, CHAVES_DAS_OPCOES)) return null;
    const { shell, detached, stdio } = opcoes;
    if (shell !== false || detached !== true) return null;
    if (!Array.isArray(stdio) || stdio.length !== 3) return null;
    const entrada = stdio[0];
    const descritor = stdio[1];
    const erros = stdio[2];
    let descritorDaSaida = null;
    if (modoPipe) {
      if (entrada !== 'ignore' || descritor !== 'pipe' || erros !== 'pipe') return null;
      const { saida } = spec;
      if (!ehObjeto(saida) || !chavesExatas(saida, ['descritor']) || !Number.isSafeInteger(saida.descritor) || saida.descritor < 3) return null;
      descritorDaSaida = saida.descritor;
    } else if (entrada !== 'ignore' || erros !== 'ignore' || !Number.isSafeInteger(descritor) || descritor < 3) {
      return null;
    }

    return {
      executavel,
      argumentos: lista,
      ambiente: forma === 'TLS' ? { PGPASSFILE, PGHOST, PGPORT, PGUSER, PGSSLMODE, PGSSLROOTCERT } : { PGPASSFILE, PGHOST, PGPORT, PGUSER },
      descritor,
      descritorDaSaida,
    };
  } catch {
    return null;
  }
}

function criarLancadorComSpawn(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções do lançador inválidas');
  const spawn = opcoes.spawn;
  if (!ehFuncao(spawn)) throw new TypeError('spawn inválido');
  // Só para testes de falha de escrita/fsync da captura (as operações de arquivo, nunca executável, destino, ambiente ou supervisão); o padrão é o `fs` real.
  const sistemaDeArquivos = opcoes.sistemaDeArquivos;
  if (sistemaDeArquivos !== undefined && !(ehObjeto(sistemaDeArquivos) && ehFuncao(sistemaDeArquivos.escrever) && ehFuncao(sistemaDeArquivos.sincronizar))) throw new TypeError('sistema de arquivos inválido');
  // P4 (opcionais): teto deste dump e orçamento de bytes da execução; repassados à captura, que os aplica ANTES de gravar cada pedaço
  const limiteDeBytes = opcoes.limiteDeBytes;
  if (limiteDeBytes !== undefined && !(Number.isSafeInteger(limiteDeBytes) && limiteDeBytes > 0)) throw new TypeError('limite de bytes inválido');
  const orcamento = opcoes.orcamento;
  if (orcamento !== undefined && !ehOrcamentoDeBytes(orcamento)) throw new TypeError('orçamento inválido');

  const registros = [];
  const capturas = [];

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
        filho = spawn(capturado.executavel, capturado.argumentos, {
          env: { ...capturado.ambiente },
          shell: false,
          detached: true,
          stdio: capturado.descritorDaSaida === null ? ['ignore', capturado.descritor, 'ignore'] : ['ignore', 'pipe', 'pipe'],
        });
      } catch (falha) {
        // O spawn lançou: nenhum filho existe. É a única falha de início comprovada junto com o `error` sem pid.
        registro.estado = 'NAO_INICIADO';
        registro.causa = causaSegura(falha);
        registros.push(registro);
        rejeitar(erro('NAO_INICIADO'));
        return;
      }
      registros.push(registro);

      // MODO PIPE: a captura (SHA-256 incremental + gravação íntegra + fsync) começa já, de forma síncrona, para nenhum byte do stdout ser perdido.
      let capturaPromessa = null;
      if (capturado.descritorDaSaida !== null) {
        try {
          const captura = criarCapturaDoDump({ descritor: capturado.descritorDaSaida, ...(sistemaDeArquivos === undefined ? {} : { sistemaDeArquivos }), ...(limiteDeBytes === undefined ? {} : { limiteDeBytes }), ...(orcamento === undefined ? {} : { orcamento }) });
          capturaPromessa = captura.consumir({ stdout: filho.stdout, stderr: filho.stderr });
        } catch {
          capturaPromessa = Promise.resolve(Object.freeze({ ok: false, motivo: 'FLUXO_AUSENTE', bytesRecebidos: 0, bytesGravados: 0, stderrBytes: 0 }));
        }
        capturas.push(capturaPromessa);
      }

      let decidido = false;
      let exitVisto = false;
      let closeVisto = false;
      let resolverSaida = null;
      let rejeitarSaida = null;
      let resolverFluxos = null;
      let rejeitarFluxos = null;

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
        if (!(Number.isSafeInteger(pid) && pid > 1)) {
          inconclusivo();
          return;
        }
        decidido = true;
        registro.estado = 'INICIADO';
        registro.pid = pid;
        const saida = new Promise((res, rej) => { resolverSaida = res; rejeitarSaida = rej; });
        const fluxosFechados = new Promise((res, rej) => { resolverFluxos = res; rejeitarFluxos = rej; });
        saida.catch(() => {});
        fluxosFechados.catch(() => {});
        resolver(Object.freeze({ pid, saida, fluxosFechados }));
      };

      const aoErro = (falha) => {
        const causa = causaSegura(falha);
        if (decidido) {
          // Depois do início (ou da decisão): só registra a causa segura; não apaga identidade, não prova encerramento, não resolve nada.
          if (registro.causa === null) registro.causa = causa;
          return;
        }
        let pid;
        try { pid = filho.pid; } catch { pid = null; }
        registro.causa = causa;
        if (pid === undefined) {
          decidido = true;
          registro.estado = 'NAO_INICIADO';
          rejeitar(erro('NAO_INICIADO'));
        } else {
          inconclusivo();
        }
      };

      const aoExit = (codigo, sinal) => {
        if (!decidido || exitVisto) return;
        exitVisto = true;
        const termino = terminoValido(codigo, sinal);
        if (termino !== null) registro.terminou = true;
        if (resolverSaida !== null) {
          if (termino !== null) resolverSaida(Object.freeze(termino));
          else rejeitarSaida(erro('TERMINO_INVALIDO'));
        }
      };

      const aoClose = () => {
        if (!decidido || closeVisto) return;
        closeVisto = true;
        if (capturaPromessa === null) {
          registro.fluxosFechados = true;
          if (resolverFluxos !== null) resolverFluxos();
          return;
        }
        // Os fluxos só contam como fechados depois de a captura terminar (bytes gravados e fsync); captura com falha REJEITA os fluxos (fail-closed), nunca é tratada como fechamento normal.
        capturaPromessa.then((evidencia) => {
          registro.fluxosFechados = true;
          if (evidencia.ok === true) { if (resolverFluxos !== null) resolverFluxos(); } else if (rejeitarFluxos !== null) rejeitarFluxos(erro('CAPTURA_FALHOU'));
        });
      };

      // Ouvintes registrados de forma SÍNCRONA: os eventos reais chegam no turno seguinte. O `error` fica sempre ouvido (um `error` sem ouvinte derruba o processo).
      try {
        const on = filho.on;
        if (!ehFuncao(on)) throw new TypeError('filho não observável');
        on.call(filho, 'error', aoErro);
        on.call(filho, 'spawn', aoSpawn);
        on.call(filho, 'exit', aoExit);
        on.call(filho, 'close', aoClose);
      } catch {
        // O filho pode existir e não é observável: INCONCLUSIVO, sem sinal e sem presunção.
        if (!decidido) inconclusivo();
      }
    });
  }

  function situacao() {
    return Object.freeze(registros.map((r) => Object.freeze({
      estado: r.estado,
      pid: r.pid,
      terminou: r.terminou,
      fluxosFechados: r.fluxosFechados,
      causa: r.causa,
      grupoComprovado: false,
    })));
  }

  /** A evidência da captura do ÚLTIMO lançamento em modo PIPE (promessa que nunca rejeita), ou nulo. */
  const capturaDaSaida = () => (capturas.length === 0 ? null : capturas[capturas.length - 1]);

  return Object.freeze({ lancar, situacao, capturaDaSaida });
}

module.exports = { criarLancadorComSpawn };
