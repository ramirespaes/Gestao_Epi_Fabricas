'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): SENTINELA DO POSTMASTER — a especialização mínima da sentinela para o PostgreSQL efêmero. É o processo independente que LANÇA o postmaster, guarda o handle dele e responde pelo encerramento: a autoridade para sinalizar vem de ter criado o filho,
 * nunca de uma consulta posterior a PID, usuário, comando ou diário. Se o runner morrer, esta sentinela sobrevive, detecta a perda do canal e conduz o encerramento ordenado; se ELA morrer, ninguém mais tem essa autoridade (o diário só rastreia e reconcilia) e a tentativa fica inconclusiva.
 * Lógica pura com dependências injetadas (filho, canal, temporizador, sonda do grupo, diário, identidade e clientes); o processo real está em `src/workers/imagem-backup-postmaster.worker.js`.
 *
 * Por que NÃO reaproveita a escalada dos clientes: o pg_dump e o pg_restore admitem SIGTERM e SIGKILL; o postmaster NÃO. Ele tem semântica própria de desligamento (SIGINT = desligamento rápido, SIGQUIT = imediato, sem limpeza) e SIGKILL no postmaster deixa os backends órfãos e a memória compartilhada presa.
 *
 * Encerramento ordenado (idempotente, um só por sentinela):
 *  (1) ESPERA os clientes: até `esperaClientesMs` enquanto houver sentinela de cliente viva sem término; passado o prazo segue (o desfecho fica registrado em POSTMASTER_ORDEM e a reconciliação não declara a tentativa concluída por isso);
 *  (2) reconfirma a IDENTIDADE (até `identificacao.tentativas` consultas) e envia SIGINT; sem identidade comprovada NENHUM sinal sai (IDENTIDADE_INCERTA);
 *  (3) sem saída em `sigintMs` (30 s) a EMERGÊNCIA: identidade E isolamento reconfirmados, evento durável POSTMASTER_EMERGENCIA gravado ANTES e então SIGQUIT, com mais `sigquitMs` (15 s) de observação. Evento não durável, identidade ou isolamento não comprovados: nenhum SIGQUIT;
 *  (4) SIGINT que o sistema recusou não é "SIGINT esgotado": não há SIGQUIT, só a observação e FALHA_DE_SINALIZACAO. Nunca há sinal além de SIGINT e SIGQUIT.
 * Sinal aceito pelo `kill` não prova nada: CLIENTE_ENCERRADO só nasce do evento de saída do filho. Depois da saída confere o grupo (o postmaster nasce em grupo próprio, então os backends contam) e só então registra o fim.
 *
 * Resultados (SENTINELA_FIM): CONCLUIDO (saída 0 sem sinal e sem SIGQUIT, grupo vazio); ENCERRADO_ANORMAL (SIGQUIT usado, ou saída diferente de zero ou por sinal, grupo vazio); DESCENDENTES_ATIVOS; GRUPO_NAO_CONFIRMADO; IDENTIDADE_INCERTA; FALHA_DE_SINALIZACAO; ENCERRAMENTO_NAO_COMPROVADO;
 * DIARIO_FALHOU; LANCAMENTO_FALHOU. Códigos de saída: 127 início falhou (comprovado), 71 diário não durável, 70 encerramento não comprovado; nos demais, o código do postmaster.
 */

const LANCAMENTO = /^[0-9a-f]{32}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const CODIGO_VALIDO = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_REJEICOES_REGISTRADAS = 5;
const CODIGOS = Object.freeze({ INICIO_FALHOU: 127, DIARIO_FALHOU: 71, NAO_COMPROVADO: 70 });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
const chavesExatas = (o, esperadas) => { const k = Reflect.ownKeys(o); return k.length === esperadas.length && k.every((c) => typeof c === 'string' && esperadas.includes(c)); };
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');

function configuracaoInvalida() {
  const falha = new TypeError('configuração da sentinela do postmaster inválida');
  falha.code = 'CONFIGURACAO_INVALIDA';
  return falha;
}
const exigir = (condicao) => { if (!condicao) throw configuracaoInvalida(); };

function validarConfig(c) {
  exigir(ehObjeto(c) && chavesExatas(c, ['lancamentoId', 'token', 'comando', 'argumentos', 'prazos', 'grupo', 'identificacao']));
  exigir(typeof c.lancamentoId === 'string' && LANCAMENTO.test(c.lancamentoId) && typeof c.token === 'string' && LANCAMENTO.test(c.token));
  exigir(caminhoAbsoluto(c.comando));
  exigir(Array.isArray(c.argumentos) && c.argumentos.length <= 256 && c.argumentos.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')));
  exigir(ehObjeto(c.prazos) && chavesExatas(c.prazos, ['sigintMs', 'sigquitMs', 'esperaClientesMs', 'passoClientesMs']) && Object.values(c.prazos).every((v) => inteiroPositivo(v, 600000)));
  exigir(ehObjeto(c.grupo) && chavesExatas(c.grupo, ['tentativas', 'intervaloMs']) && inteiroPositivo(c.grupo.tentativas, 100) && inteiroPositivo(c.grupo.intervaloMs, 60000));
  exigir(ehObjeto(c.identificacao) && chavesExatas(c.identificacao, ['tentativas', 'intervaloMs']) && inteiroPositivo(c.identificacao.tentativas, 20) && inteiroPositivo(c.identificacao.intervaloMs, 60000));
  return Object.freeze({ ...c, argumentos: Object.freeze([...c.argumentos]), prazos: Object.freeze({ ...c.prazos }), grupo: Object.freeze({ ...c.grupo }), identificacao: Object.freeze({ ...c.identificacao }) });
}

function criarSentinelaPostmaster(opcoes) {
  exigir(ehObjeto(opcoes));
  const config = validarConfig(opcoes.config);
  const { spawn, diario, canal, temporizador, sondaGrupo, pidProprio, capturarBase, identificar, clientesPendentes } = opcoes;
  const ambiente = opcoes.ambiente === undefined ? process.env : opcoes.ambiente;
  exigir(ehFuncao(spawn) && ehObjeto(diario) && ehFuncao(diario.registrar) && ehObjeto(canal) && ehFuncao(canal.enviar) && ehFuncao(canal.aoMensagem) && ehFuncao(canal.aoDesconectar) && ehFuncao(canal.conectado));
  exigir(ehObjeto(temporizador) && ehFuncao(temporizador.prazo) && ehFuncao(temporizador.intervalo) && ehFuncao(sondaGrupo) && Number.isSafeInteger(pidProprio) && pidProprio > 1);
  exigir(ehFuncao(capturarBase) && ehFuncao(identificar) && ehFuncao(clientesPendentes));

  const id = config.lancamentoId;
  const tokenEsperado = Buffer.from(config.token);
  let filho = null;
  let clientePid = null;
  let saiu = false;
  let termino = null;
  let iniciado = false;
  let encerramentoIniciado = false;
  let usouEmergencia = false;
  let diarioFalhou = false;
  let baseP = Promise.resolve(false);
  let rejeitadas = 0;
  let resolverSaida;
  const saidaP = new Promise((r) => { resolverSaida = r; });
  let resolverDesfecho;
  const desfechoP = new Promise((r) => { resolverDesfecho = r; });

  /** Estrito: o chamador decide o que fazer se o registro não for durável. */
  function registrar(tipo, dados) {
    try { diario.registrar(tipo, dados); return true; } catch { return false; }
  }
  /** Para eventos que acompanham uma ação de segurança já decidida: a ação não depende do registro. */
  const registrarSePossivel = (tipo, dados) => { registrar(tipo, dados); };
  const notificar = (mensagem) => { try { canal.enviar({ canal: id, ...mensagem }); } catch { /* o runner pode já não existir */ } };

  /** Único ponto de envio de sinal: só os dois sinais do desligamento do PostgreSQL, sempre ao filho cujo handle esta sentinela detém. */
  function enviarSinal(origem, sinal) {
    if (saiu || filho === null) return false;
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
    if (m.t === 'PARAR' && chavesExatas(m, ['canal', 'token', 't', 'sinal']) && m.sinal === 'SIGINT') { iniciarEncerramento('RUNNER'); return; }
    if (m.t === 'ESCALAR') { rejeitar('ESCALADA_NAO_PERMITIDA'); return; }
    rejeitar('MENSAGEM_MALFORMADA');
  }

  async function esperar(promessa, ms) {
    const prazo = temporizador.prazo(ms);
    const r = await Promise.race([promessa.then(() => 'saiu'), prazo.promessa.then(() => 'prazo')]);
    prazo.cancelar();
    return r;
  }

  /** (1) Os clientes antes do postmaster. Resposta fora de NENHUM/PENDENTES, exceção ou prazo vencido valem INCONCLUSIVO/PENDENTES: nunca "sem clientes". */
  async function aguardarClientes() {
    const prazo = temporizador.prazo(config.prazos.esperaClientesMs);
    let expirou = false;
    prazo.promessa.then(() => { expirou = true; });
    let ultimo = 'INCONCLUSIVO';
    for (;;) {
      let r;
      try { r = await clientesPendentes(); } catch { r = 'INCONCLUSIVO'; }
      ultimo = r === 'NENHUM' || r === 'PENDENTES' ? r : 'INCONCLUSIVO';
      if (ultimo === 'NENHUM' || expirou || saiu) break;
      await Promise.race([temporizador.intervalo(config.prazos.passoClientesMs), prazo.promessa]);
    }
    prazo.cancelar();
    return ultimo;
  }

  const motivoSeguro = (m) => (typeof m === 'string' && CODIGO_VALIDO.test(m) ? m : 'IDENTIDADE_NAO_COMPROVADA');

  /** Identidade reconfirmada antes de CADA sinal. Só a identidade ausente é repetida (leitura transitória); o isolamento divergente é definitivo. */
  async function confirmarIdentidade(fase) {
    const base = await baseP;
    let ultima = { comprovada: false, isolamento: false, falhas: ['IDENTIFICACAO_FALHOU'] };
    for (let i = 1; i <= config.identificacao.tentativas; i += 1) {
      if (saiu) return ultima;
      try {
        const r = await identificar({ fase, pid: clientePid, baseCapturada: base, filho: { pid: filho.pid, exitCode: filho.exitCode ?? null, signalCode: filho.signalCode ?? null } });
        ultima = ehObjeto(r) ? { comprovada: r.comprovada === true, isolamento: r.isolamento === true, falhas: Array.isArray(r.falhas) ? r.falhas : [] } : { comprovada: false, isolamento: false, falhas: ['IDENTIFICACAO_FALHOU'] };
      } catch {
        ultima = { comprovada: false, isolamento: false, falhas: ['IDENTIFICACAO_FALHOU'] };
      }
      if (ultima.comprovada) break;
      if (i < config.identificacao.tentativas) await temporizador.intervalo(config.identificacao.intervaloMs);
    }
    if (!ultima.comprovada || (fase === 'SIGQUIT' && !ultima.isolamento)) registrarSePossivel('IDENTIDADE_NAO_COMPROVADA', { lancamentoId: id, fase, motivo: motivoSeguro(ultima.falhas[0]) });
    return ultima;
  }

  async function sequencia(origem) {
    if (origem === 'ORFANDADE') registrarSePossivel('ORFANDADE_DETECTADA', { lancamentoId: id });
    const clientes = await aguardarClientes();
    registrarSePossivel('POSTMASTER_ORDEM', { lancamentoId: id, clientes });
    if (saiu) return;

    const primeira = await confirmarIdentidade('SIGINT');
    if (saiu) return;
    if (!primeira.comprovada) { resolverDesfecho('IDENTIDADE_INCERTA'); return; }
    const aceitoInt = enviarSinal(origem, 'SIGINT');
    if (!aceitoInt) {
      if ((await esperar(saidaP, config.prazos.sigquitMs)) !== 'saiu') resolverDesfecho('FALHA_DE_SINALIZACAO');
      return;
    }
    if ((await esperar(saidaP, config.prazos.sigintMs)) === 'saiu') return;

    const emergencia = await confirmarIdentidade('SIGQUIT');
    if (saiu) return;
    if (!emergencia.comprovada || !emergencia.isolamento) { resolverDesfecho('IDENTIDADE_INCERTA'); return; }
    // o registro durável vem ANTES do sinal: sem ele, ou sem diário, o encerramento imediato não acontece
    if (!registrar('POSTMASTER_EMERGENCIA', { lancamentoId: id, sinal: 'SIGQUIT' })) { resolverDesfecho('ENCERRAMENTO_NAO_COMPROVADO'); return; }
    usouEmergencia = true;
    const aceitoQuit = enviarSinal('EMERGENCIA', 'SIGQUIT');
    if ((await esperar(saidaP, config.prazos.sigquitMs)) === 'saiu') return;
    resolverDesfecho(aceitoQuit ? 'ENCERRAMENTO_NAO_COMPROVADO' : 'FALHA_DE_SINALIZACAO');
  }

  function iniciarEncerramento(origem) {
    if (encerramentoIniciado || saiu || filho === null) return false;
    encerramentoIniciado = true;
    sequencia(origem).catch(() => { resolverDesfecho('ENCERRAMENTO_NAO_COMPROVADO'); });
    return true;
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
    canal.aoDesconectar(() => { iniciarEncerramento('ORFANDADE'); });

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
      await esperar(erroP, config.prazos.sigquitMs);
      registrarSePossivel('LANCAMENTO_FALHOU', { lancamentoId: id, codigo: erroDeInicio !== null && erroDeInicio.code === 'ENOENT' ? 'SPAWN_ENOENT' : 'SPAWN_ERRO' });
      return terminar('LANCAMENTO_FALHOU', CODIGOS.INICIO_FALHOU);
    }
    filho = f;
    clientePid = f.pid;
    // a base da identidade (instante de início) é capturada já, em paralelo ao registro; a identificação a aguarda
    baseP = (async () => { try { return (await capturarBase(clientePid)) === true; } catch { return false; } })();

    if (!registrar('CLIENTE_LANCADO', { lancamentoId: id, clientePid })) {
      // sem identidade durável o postmaster não segue: encerramento ORDENADO pelo handle que a sentinela detém (nunca por sinal fora do desligamento)
      diarioFalhou = true;
      iniciarEncerramento('DIARIO_FALHOU');
    } else {
      notificar({ t: 'CLIENTE', clientePid });
      if (!canal.conectado()) iniciarEncerramento('ORFANDADE');
    }

    const desfecho = await Promise.race([saidaP.then(() => 'saiu'), desfechoP]);
    if (desfecho !== 'saiu') return terminar(desfecho, CODIGOS.NAO_COMPROVADO);

    const registrouSaida = registrar('CLIENTE_ENCERRADO', { lancamentoId: id, codigo: termino.codigo, sinal: termino.sinal });
    const vazio = await conferirGrupo();
    const registrouGrupo = registrar('GRUPO_VERIFICADO', { lancamentoId: id, vazio });
    notificar({ t: 'FIM', grupoVazio: vazio });
    let resultado;
    if (vazio === true) resultado = !usouEmergencia && termino.codigo === 0 && termino.sinal === null ? 'CONCLUIDO' : 'ENCERRADO_ANORMAL';
    else resultado = vazio === false ? 'DESCENDENTES_ATIVOS' : 'GRUPO_NAO_CONFIRMADO';
    if (!registrouSaida || !registrouGrupo) resultado = 'DIARIO_FALHOU';
    if (diarioFalhou) return Object.freeze({ codigo: CODIGOS.DIARIO_FALHOU, sinal: null, resultado: 'DIARIO_FALHOU' });
    return terminar(resultado, termino.codigo, termino.sinal);
  }

  return Object.freeze({ executar, pedirParada: (origem) => (typeof origem === 'string' && CODIGO_VALIDO.test(origem) ? iniciarEncerramento(origem) : false) });
}

module.exports = { criarSentinelaPostmaster, CODIGOS };
