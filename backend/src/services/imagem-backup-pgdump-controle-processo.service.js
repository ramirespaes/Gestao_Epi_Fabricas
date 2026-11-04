'use strict';

const crypto = require('node:crypto');
const { criarLancadorComSpawn } = require('./imagem-backup-pgdump-lancador.service');
const { ehSpawnReal } = require('./imagem-backup-portas-sistema.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-CONTROLE-PROCESSO-1): CONTROLADOR de processo POR OPERAÇÃO. Contrato PROVISÓRIO: não inicia processo
 * real por conta própria (o `spawn` e o `observarGrupo` são injetados só para este contrato e os testes, D8; a execução real escolherá `child_process` e o
 * observador INTERNAMENTE) e NÃO é uma garantia de sinalização atômica.
 *
 * `criarControleDeProcesso({ spawn, observarGrupo, relogio? })` -> objeto CONGELADO { lancador: { lancar }, sistema: { grupoVivo, enviarSinal }, capturaDoDump, situacao,
 * registroDeRecuperacao }, compatível com `dump.lancador` e `dump.sistema` do serviço do dump e com o supervisor, sem alterá-los.
 *   - UMA operação por controle, USO ÚNICO: depois de uma chamada a `lancar` com spec aceito (inclusive uma falha de início comprovada) qualquer outra é recusada
 *     (LANCAMENTO_JA_REALIZADO), e só um spec INVÁLIDO (SPEC_INVALIDO, nada foi lançado) devolve a tentativa. O `operacaoId` é aleatório (32 hex), sem relação com pid/pgid;
 *   - o lançador é o provisório (`criarLancadorComSpawn`), alimentado por um `spawn` que CAPTURA, no instante do retorno, o filho REALMENTE devolvido, o seu `kill`
 *     (lido UMA vez, chamado com o receiver do filho) e o seu `on` (para observar o `exit`). O `pid` NÃO é relido do filho: vem do registro do lançador, que o lê uma vez
 *     no evento `spawn` e só o aceita se for inteiro seguro > 1;
 *   - SINAIS: só SIGINT, SIGTERM e SIGKILL, só para o pgid deste controle com início CONFIRMADO, só enquanto nenhum `exit` foi observado, pelo `kill` capturado (nunca
 *     `process.kill`, nunca por número). O sinal vai ao PROCESSO FILHO (líder do grupo), nunca ao grupo inteiro nem por PGID negativo: descendentes não são sinalizados e sua ausência só é OBSERVADA. A ausência do `exit` NÃO prova que o PID ainda é do filho: LIMITE PENDENTE (reutilização de PID, semântica real de
 *     `ChildProcess.kill`, atomicidade): isto reduz a janela, não a elimina. Um sinal aceito não prova o término;
 *   - GRUPO: `grupoVivo` consulta o observador SEMPRE (independente do término do líder); só `true`/`false` valem; qualquer outra resposta, exceção, pgid alheio ou início
 *     não confirmado REJEITA com erro seguro (nunca vira "vazio"). "VAZIO_OBSERVADO" é uma OBSERVAÇÃO, nunca prova de identidade do grupo (`grupoComprovado` é sempre false);
 *   - INCONCLUSIVO ou NAO_INICIADO: nenhum sinal, nenhuma consulta, nenhum pid presumido;
 *   - `situacao()` e `registroDeRecuperacao()` devolvem retratos CONGELADOS, só com códigos fixos, identificador opaco, pid e instante do relógio: nunca snapshotId, ambiente,
 *     argumentos, caminho completo nem credenciais; o registro mantém `provaSuficienteParaSinal: false` e `autorizaLiberarTrava: false` e nada é gravado em disco.
 * Fora do escopo: cgroup/systemd, stdout por pipe, observador real de grupo, recuperação após a morte do orquestrador.
 */

const SINAIS_PERMITIDOS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);
const ehFuncao = (valor) => typeof valor === 'function';
const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);

/** Erro público: mensagem fixa e código fixo; nunca o texto de dependências. */
function erro(codigo) {
  const falha = new Error('falha no controle de processo');
  falha.code = codigo;
  return falha;
}

/** Retratos de situação PRODUZIDOS por um controle (marca interna): literal ou clone não é reconhecido como situação de processo. */
const situacoesProduzidas = new WeakSet();
const ehSituacaoDoControle = (v) => v !== null && typeof v === 'object' && situacoesProduzidas.has(v);

function criarControleDeProcesso(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções do controle inválidas');
  const spawn = opcoes.spawn;
  const observarGrupo = opcoes.observarGrupo;
  const relogio = opcoes.relogio === undefined ? Date.now : opcoes.relogio;
  // Opcional: fábrica `({ spawn }) => { lancar, situacao }` de outro lançador SUPERVISIONADO (verificação estrutural, restauração); o padrão continua o lançador do `pg_dump`.
  const criarLancador = opcoes.criarLancador === undefined ? criarLancadorComSpawn : opcoes.criarLancador;
  if (!ehFuncao(criarLancador)) throw new TypeError('fábrica do lançador inválida');
  if (!ehFuncao(spawn)) throw new TypeError('spawn inválido');
  if (!ehFuncao(observarGrupo)) throw new TypeError('observador de grupo inválido');
  if (!ehFuncao(relogio)) throw new TypeError('relógio inválido');

  const operacaoId = crypto.randomBytes(16).toString('hex');
  // identidade da EXECUÇÃO supervisionada (opcional; gerada pela composição antes do lançamento): acompanha o controle e consta do retrato
  const execucaoId = opcoes.execucaoId === undefined ? null : opcoes.execucaoId;
  if (execucaoId !== null && !(typeof execucaoId === 'string' && /^[0-9a-f]{32}$/.test(execucaoId))) throw new TypeError('identidade da execução inválida');
  const spawnGenuino = ehSpawnReal(spawn);

  let usado = false;
  let iniciadoEm = null;
  let executavel = null;
  let exitObservado = false;
  let matar = null; // o `kill` do filho lido UMA vez, ligado ao receiver do filho; nulo = nada sinalizável
  let grupo = 'NAO_OBSERVADO';

  /** O `spawn` do lançador: devolve o filho exatamente como veio e captura, de forma síncrona, o que o controle precisa. Nada é relido depois. */
  function spawnCapturando(comando, argumentos, opcoesDoSpawn) {
    const filho = spawn(comando, argumentos, opcoesDoSpawn);
    executavel = typeof comando === 'string' ? comando.slice(comando.lastIndexOf('/') + 1) : null;
    try {
      if (filho !== null && typeof filho === 'object') {
        const kill = filho.kill;
        const on = filho.on;
        if (ehFuncao(kill) && ehFuncao(on)) {
          on.call(filho, 'exit', () => { exitObservado = true; });
          matar = (sinal) => kill.call(filho, sinal);
        }
      }
    } catch {
      matar = null; // filho não observável de forma segura: nenhum sinal será enviado
    }
    return filho;
  }

  // P4 (opcionais; só o lançador do `pg_dump` os entende): teto do dump e orçamento de bytes da execução, repassados à captura
  const lancadorInterno = criarLancador({ spawn: spawnCapturando, ...(opcoes.limiteDeBytes === undefined ? {} : { limiteDeBytes: opcoes.limiteDeBytes }), ...(opcoes.orcamento === undefined ? {} : { orcamento: opcoes.orcamento }) });
  if (!ehObjeto(lancadorInterno) || !ehFuncao(lancadorInterno.lancar) || !ehFuncao(lancadorInterno.situacao)) throw new TypeError('lançador inválido');

  const registroDoLancamento = () => lancadorInterno.situacao()[0] ?? null;
  const instanteIso = (instante) => {
    try { return new Date(instante).toISOString(); } catch { return null; }
  };

  function lancar(spec) {
    if (usado) return Promise.reject(erro('LANCAMENTO_JA_REALIZADO'));
    usado = true;
    let lido;
    try { lido = relogio(); } catch { lido = Number.NaN; }
    iniciadoEm = instanteIso(lido);
    return lancadorInterno.lancar(spec).catch((falha) => {
      // Spec inválido: nada foi lançado, e a tentativa é devolvida. Qualquer outra falha (início comprovado ou inconclusivo) consome o controle.
      if (falha !== null && typeof falha === 'object' && falha.code === 'SPEC_INVALIDO') {
        usado = false;
        iniciadoEm = null;
      }
      throw falha;
    });
  }

  /** O lançamento DESTE controle com início confirmado e o pgid pedido; fora disso, nenhuma autorização. */
  function autorizado(pgid) {
    const registro = registroDoLancamento();
    return registro !== null && registro.estado === 'INICIADO' && Number.isSafeInteger(pgid) && pgid === registro.pid;
  }

  async function enviarSinal(pgid, sinal) {
    if (!autorizado(pgid)) return false;
    if (typeof sinal !== 'string' || !SINAIS_PERMITIDOS.has(sinal)) return false;
    if (exitObservado || matar === null) return false;
    try {
      return matar(sinal) === true;
    } catch {
      return false;
    }
  }

  async function grupoVivo(pgid) {
    if (!autorizado(pgid)) throw erro('OBSERVACAO_INCONCLUSIVA');
    let resposta;
    try {
      resposta = await observarGrupo(pgid);
    } catch {
      grupo = 'INCONCLUSIVO';
      throw erro('OBSERVACAO_INCONCLUSIVA');
    }
    if (resposta === true) {
      grupo = 'POVOADO';
      return true;
    }
    if (resposta === false) {
      grupo = 'VAZIO_OBSERVADO';
      return false;
    }
    grupo = 'INCONCLUSIVO';
    throw erro('OBSERVACAO_INCONCLUSIVA');
  }

  function situacao() {
    const registro = registroDoLancamento();
    const retrato = Object.freeze({
      operacaoId,
      execucaoId,
      estado: registro === null ? 'NAO_LANCADO' : registro.estado,
      pid: registro === null ? null : registro.pid,
      terminou: registro === null ? false : registro.terminou,
      fluxosFechados: registro === null ? false : registro.fluxosFechados,
      grupo,
      grupoComprovado: false,
      // o `spawn` usado é o do Node (identidade da função)? Um `spawn` injetado/simulado nunca é genuíno, por mais que o resto imite um processo.
      spawnGenuino: spawnGenuino,
      causa: registro === null ? null : registro.causa,
    });
    situacoesProduzidas.add(retrato);
    return retrato;
  }

  function registroDeRecuperacao() {
    const registro = registroDoLancamento();
    return Object.freeze({
      versao: 1,
      operacaoId,
      estado: registro === null ? 'NAO_LANCADO' : registro.estado,
      pidDoFilho: registro === null ? null : registro.pid,
      iniciadoEm: registro === null ? null : iniciadoEm,
      executavel: registro === null ? null : executavel,
      provaSuficienteParaSinal: false,
      autorizaLiberarTrava: false,
    });
  }

  return Object.freeze({
    lancador: Object.freeze({ lancar }),
    sistema: Object.freeze({ grupoVivo, enviarSinal }),
    // Evidência da captura do stdout (promessa que nunca rejeita) quando o lançamento foi em modo PIPE; nulo caso contrário.
    capturaDoDump: () => (ehFuncao(lancadorInterno.capturaDaSaida) ? lancadorInterno.capturaDaSaida() : null),
    situacao,
    registroDeRecuperacao,
  });
}

module.exports = { criarControleDeProcesso, ehSituacaoDoControle };
