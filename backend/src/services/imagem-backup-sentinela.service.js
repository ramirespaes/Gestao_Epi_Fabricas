'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): SENTINELA — o supervisor independente de UM cliente externo (pg_dump, pg_restore, verificação estrutural). A sentinela é um processo próprio, lançado pelo runner, que por sua vez LANÇA o cliente e guarda o handle dele:
 * a autoridade para sinalizar o cliente vem de ter sido ela quem o criou, nunca de uma consulta posterior a PID, usuário, comando ou horário. Se o runner morrer, a sentinela sobrevive, detecta a perda do canal e encerra o PRÓPRIO cliente; se a sentinela morrer, nenhum outro componente
 * tem essa autoridade (o diário durável só rastreia e reconcilia). Este módulo é lógica pura com dependências injetadas (filho, canal, temporizador, sonda do grupo, diário); o processo real está em `src/workers/imagem-backup-sentinela.worker.js`.
 *
 * Ordem: (1) SENTINELA_ATIVA durável; sem ela NENHUM cliente é lançado; (2) lança o cliente (`detached:true`, fluxos herdados) e só então registra CLIENTE_LANCADO; se esse registro falhar, o cliente é encerrado (SIGKILL pela referência que a sentinela tem), nunca deixado sem identidade;
 * (3) canal restrito: só o canal e o token deste lançamento e só PARAR (SIGINT/SIGTERM) e ESCALAR (SIGKILL do CLIENTE); o resto é rejeitado e registrado, sem sinal; (4) runner desconectado com o cliente vivo é ÓRFÃ: SIGTERM, cortesia, SIGKILL; (5) CLIENTE_ENCERRADO só nasce do evento de SAÍDA do filho:
 * sinal aceito pelo `kill` não prova nada; cliente que resiste até ao SIGKILL termina em ENCERRAMENTO_NAO_COMPROVADO, sem afirmar o encerramento; (6) depois da saída confere o grupo do cliente (sonda): vazio comprovado, ocupado ou não confirmado, e só então registra o fim.
 * O grupo do cliente é o que o `detached:true` cria (sessão própria; o cliente é o líder); a sentinela só OBSERVA o grupo, não o sinaliza (descendentes ficam como DESCENDENTES_ATIVOS e a tentativa permanece bloqueada).
 *
 * Saída espelha o cliente: código igual ao dele ou o mesmo sinal. Códigos próprios: 127 início falhou (comprovado), 71 diário não durável, 70 encerramento não comprovado.
 */

const SINAIS_DE_PARADA = Object.freeze(['SIGINT', 'SIGTERM']);
const LANCAMENTO = /^[0-9a-f]{32}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const MAX_REJEICOES_REGISTRADAS = 5;
const CODIGOS = Object.freeze({ INICIO_FALHOU: 127, DIARIO_FALHOU: 71, NAO_COMPROVADO: 70 });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
const chavesExatas = (o, esperadas) => { const k = Reflect.ownKeys(o); return k.length === esperadas.length && k.every((c) => typeof c === 'string' && esperadas.includes(c)); };
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');

function configuracaoInvalida() {
  const falha = new TypeError('configuração da sentinela inválida');
  falha.code = 'CONFIGURACAO_INVALIDA';
  return falha;
}
const exigir = (condicao) => { if (!condicao) throw configuracaoInvalida(); };

function validarConfig(c) {
  exigir(ehObjeto(c) && chavesExatas(c, ['lancamentoId', 'token', 'comando', 'argumentos', 'cortesiaMs', 'esperaPosKillMs', 'grupo']));
  exigir(typeof c.lancamentoId === 'string' && LANCAMENTO.test(c.lancamentoId) && typeof c.token === 'string' && LANCAMENTO.test(c.token));
  exigir(caminhoAbsoluto(c.comando));
  exigir(Array.isArray(c.argumentos) && c.argumentos.length <= 256 && c.argumentos.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')));
  exigir(inteiroPositivo(c.cortesiaMs, 600000) && inteiroPositivo(c.esperaPosKillMs, 600000));
  exigir(ehObjeto(c.grupo) && chavesExatas(c.grupo, ['tentativas', 'intervaloMs']) && inteiroPositivo(c.grupo.tentativas, 100) && inteiroPositivo(c.grupo.intervaloMs, 60000));
  return Object.freeze({ ...c, argumentos: Object.freeze([...c.argumentos]), grupo: Object.freeze({ ...c.grupo }) });
}

function criarSentinela(opcoes) {
  exigir(ehObjeto(opcoes));
  const config = validarConfig(opcoes.config);
  const { spawn, diario, canal, temporizador, sondaGrupo, pidProprio } = opcoes;
  const ambiente = opcoes.ambiente === undefined ? process.env : opcoes.ambiente;
  exigir(ehFuncao(spawn) && ehObjeto(diario) && ehFuncao(diario.registrar) && ehObjeto(canal) && ehFuncao(canal.enviar) && ehFuncao(canal.aoMensagem) && ehFuncao(canal.aoDesconectar) && ehFuncao(canal.conectado));
  exigir(ehObjeto(temporizador) && ehFuncao(temporizador.prazo) && ehFuncao(temporizador.intervalo) && ehFuncao(sondaGrupo) && Number.isSafeInteger(pidProprio) && pidProprio > 1);

  const id = config.lancamentoId;
  const tokenEsperado = Buffer.from(config.token);
  let filho = null;
  let clientePid = null;
  let saiu = false;
  let termino = null;
  let orfandade = false;
  let iniciado = false;
  let rejeitadas = 0;
  const enviados = new Set();
  let resolverSaida;
  const saidaP = new Promise((r) => { resolverSaida = r; });
  let resolverNaoComprovado;
  const naoComprovadoP = new Promise((r) => { resolverNaoComprovado = r; });

  /** Estrito: o chamador decide o que fazer se o registro não for durável. */
  function registrar(tipo, dados) {
    try { diario.registrar(tipo, dados); return true; } catch { return false; }
  }
  /** Para eventos que acompanham uma AÇÃO DE SEGURANÇA (sinal, órfã): a ação não espera nem depende do registro. */
  const registrarSePossivel = (tipo, dados) => { registrar(tipo, dados); };
  const notificar = (mensagem) => { try { canal.enviar({ canal: id, ...mensagem }); } catch { /* o runner pode já não existir */ } };

  function enviarSinal(origem, sinal) {
    if (saiu || filho === null || enviados.has(sinal)) return false;
    enviados.add(sinal);
    registrarSePossivel('PARADA_SOLICITADA', { lancamentoId: id, origem, sinal });
    let aceito = false;
    try { aceito = filho.kill(sinal) === true; } catch { aceito = false; }
    registrarSePossivel('SINAL_ENVIADO', { lancamentoId: id, sinal, aceito });
    return aceito;
  }

  function rejeitar(motivo) {
    rejeitadas += 1;
    if (rejeitadas <= MAX_REJEICOES_REGISTRADAS) registrarSePossivel('MENSAGEM_REJEITADA', { lancamentoId: id, motivo });
  }
  function tokenConfere(valor) {
    if (typeof valor !== 'string') return false;
    const recebido = Buffer.from(valor);
    return recebido.length === tokenEsperado.length && crypto.timingSafeEqual(recebido, tokenEsperado);
  }
  function aoMensagem(m) {
    if (!ehObjeto(m)) { rejeitar('MENSAGEM_MALFORMADA'); return; }
    if (m.canal !== id || !tokenConfere(m.token)) { rejeitar('MENSAGEM_NAO_AUTORIZADA'); return; }
    if (m.t === 'PARAR' && chavesExatas(m, ['canal', 'token', 't', 'sinal']) && SINAIS_DE_PARADA.includes(m.sinal)) { enviarSinal('RUNNER', m.sinal); return; }
    if (m.t === 'ESCALAR' && chavesExatas(m, ['canal', 'token', 't'])) { enviarSinal('RUNNER_ESCALADA', 'SIGKILL'); return; }
    rejeitar('MENSAGEM_MALFORMADA');
  }

  async function esperar(promessa, ms) {
    const prazo = temporizador.prazo(ms);
    const r = await Promise.race([promessa.then(() => 'saiu'), prazo.promessa.then(() => 'prazo')]);
    prazo.cancelar();
    return r;
  }

  /** Runner morto com o cliente vivo: a sentinela encerra o PRÓPRIO cliente. Sem saída observada ao fim, nada é afirmado. */
  async function tratarOrfandade() {
    if (saiu || orfandade || filho === null) return;
    orfandade = true;
    registrarSePossivel('ORFANDADE_DETECTADA', { lancamentoId: id });
    enviarSinal('ORFANDADE', 'SIGTERM');
    if ((await esperar(saidaP, config.cortesiaMs)) === 'saiu') return;
    enviarSinal('ORFANDADE', 'SIGKILL');
    if ((await esperar(saidaP, config.esperaPosKillMs)) === 'saiu') return;
    resolverNaoComprovado(true);
  }

  async function conferirGrupo() {
    let ultima = null;
    for (let i = 1; i <= config.grupo.tentativas; i += 1) {
      try {
        const r = await sondaGrupo(clientePid);
        ultima = r === true || r === false ? r : null;
      } catch {
        ultima = null;
      }
      if (ultima === false) return true;
      if (i < config.grupo.tentativas) await temporizador.intervalo(config.grupo.intervaloMs);
    }
    return ultima === true ? false : null;
  }

  function terminar(resultado, codigo, sinal = null) {
    registrarSePossivel('SENTINELA_FIM', { lancamentoId: id, resultado });
    return Object.freeze({ codigo, sinal, resultado });
  }

  async function executar() {
    if (iniciado) throw configuracaoInvalida();
    iniciado = true;
    canal.aoMensagem(aoMensagem);
    canal.aoDesconectar(() => { tratarOrfandade(); });

    if (!registrar('SENTINELA_ATIVA', { lancamentoId: id, sentinelaPid: pidProprio })) return Object.freeze({ codigo: CODIGOS.DIARIO_FALHOU, sinal: null, resultado: 'DIARIO_FALHOU' });
    notificar({ t: 'ATIVA' });

    let f;
    try {
      f = spawn(config.comando, [...config.argumentos], { env: ambiente, shell: false, detached: true, stdio: 'inherit' });
    } catch {
      registrarSePossivel('LANCAMENTO_FALHOU', { lancamentoId: id, codigo: 'SPAWN_LANCOU' });
      return terminar('LANCAMENTO_FALHOU', CODIGOS.INICIO_FALHOU);
    }
    f.on('exit', (codigo, sinal) => {
      if (saiu) return;
      saiu = true;
      termino = { codigo: Number.isInteger(codigo) ? codigo : null, sinal: typeof sinal === 'string' && sinal !== '' ? sinal : null };
      resolverSaida(termino);
    });
    let erroDeInicio = null;
    const erroP = new Promise((r) => { f.on('error', (e) => { if (!Number.isSafeInteger(f.pid)) { erroDeInicio = e; r(true); } }); });
    if (!Number.isSafeInteger(f.pid) || f.pid <= 1) {
      await esperar(erroP, config.esperaPosKillMs);
      registrarSePossivel('LANCAMENTO_FALHOU', { lancamentoId: id, codigo: erroDeInicio !== null && erroDeInicio.code === 'ENOENT' ? 'SPAWN_ENOENT' : 'SPAWN_ERRO' });
      return terminar('LANCAMENTO_FALHOU', CODIGOS.INICIO_FALHOU);
    }
    filho = f;
    clientePid = f.pid;

    if (!registrar('CLIENTE_LANCADO', { lancamentoId: id, clientePid })) {
      // sem identidade durável o cliente não pode seguir: encerra pela referência que a sentinela detém e só então sai
      enviarSinal('DIARIO_FALHOU', 'SIGKILL');
      await esperar(saidaP, config.esperaPosKillMs);
      return Object.freeze({ codigo: CODIGOS.DIARIO_FALHOU, sinal: null, resultado: 'DIARIO_FALHOU' });
    }
    notificar({ t: 'CLIENTE', clientePid });
    if (!canal.conectado()) tratarOrfandade();

    const desfecho = await Promise.race([saidaP.then(() => 'saiu'), naoComprovadoP.then(() => 'nao-comprovado')]);
    if (desfecho === 'nao-comprovado') return terminar('ENCERRAMENTO_NAO_COMPROVADO', CODIGOS.NAO_COMPROVADO);

    const registrouSaida = registrar('CLIENTE_ENCERRADO', { lancamentoId: id, codigo: termino.codigo, sinal: termino.sinal });
    const vazio = await conferirGrupo();
    const registrouGrupo = registrar('GRUPO_VERIFICADO', { lancamentoId: id, vazio });
    notificar({ t: 'FIM', grupoVazio: vazio });
    let resultado;
    if (vazio === true) resultado = termino.codigo === 0 && termino.sinal === null ? 'CONCLUIDO' : 'ENCERRADO_COM_FALHA';
    else resultado = vazio === false ? 'DESCENDENTES_ATIVOS' : 'GRUPO_NAO_CONFIRMADO';
    if (!registrouSaida || !registrouGrupo) resultado = 'DIARIO_FALHOU';
    return terminar(resultado, termino.codigo, termino.sinal);
  }

  return Object.freeze({ executar, pedirParada: (origem, sinal) => (SINAIS_DE_PARADA.includes(sinal) ? enviarSinal(origem, sinal) : false) });
}

module.exports = { criarSentinela, CODIGOS, SINAIS_DE_PARADA };
