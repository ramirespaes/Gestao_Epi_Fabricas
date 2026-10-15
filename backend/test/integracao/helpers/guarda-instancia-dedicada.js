'use strict';

/**
 * Guarda D1 do RED integrado J2a: só testa contra o cluster dedicado (127.0.0.1:55432, cluster gepi_teste_j2a). Este módulo NÃO tem
 * efeitos ao ser carregado: expõe funções puras e `instalarGuarda`, que recebe `pg`, `net` e `aoFalhar` por injeção (o carregador real
 * é `test/integracao/exigir-instancia-dedicada.js`; os testes usam doubles e um servidor falso em loopback).
 *
 * Três camadas, nesta ordem:
 *  1. destino do cliente (host, porta, banco, papel) conferido ANTES de qualquer pacote, em Client._connect, o ponto único por onde
 *     toda conexão do `pg` nasce (Client.connect e todo cliente de Pool passam por ele);
 *  2. identidade da instância (banco, papel, porta, cluster e marcador) conferida na própria conexão, depois de autenticar e ANTES de
 *     entregá-la ao chamador; Client.query recusa conexões ainda não verificadas (o evento 'connect' do pg vem antes do callback);
 *  3. rede: net.Socket.prototype.connect recusa soquete Unix, host fora do loopback explícito e a porta 5432; a porta dedicada só é
 *     aceita enquanto Client._connect estiver em curso.
 * Qualquer divergência chama `aoFalhar(motivo)` (no carregador real, encerra o processo) e a conexão nunca é entregue. Nenhuma
 * mensagem contém senha, marcador ou valores de variáveis.
 */

const ALVO = Object.freeze({ host: '127.0.0.1', port: 55432, database: 'gestao_epi_teste_local', user: 'gepi_teste_j2a', cluster: 'gepi_teste_j2a' });
const PORTA_COMPARTILHADA = 5432;
const HOSTS_PERMITIDOS = Object.freeze(['127.0.0.1', '::1']);
const ESPERADO_ENV = Object.freeze({ DB_HOST: ALVO.host, DB_PORT: String(ALVO.port), DB_NAME: ALVO.database, DB_USER: ALVO.user, NODE_ENV: 'test' });
const PROIBIDAS = /^(PG.*|DATABASE_URL|NODE_OPTIONS|NODE_PG_FORCE_NATIVE|DOTENV_KEY|DOTENV_ENVIRONMENT|DOTENV_VAULT.*|DOTENV_CONFIG_(OVERRIDE|DOTENV_KEY|ENCODING|DEBUG))$/i;
const SQL_IDENTIDADE = "SELECT current_database() AS banco, current_user AS papel, inet_server_port() AS porta, current_setting('cluster_name') AS cluster, (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()) AS marcador";
const FORMATO_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const FORMATO_SISTEMA = /^[0-9]{10,}$/;

/** Motivo da recusa ou null. Nunca devolve valores de variáveis (senha inclusive). */
function validarAmbiente(env, execArgv, caminhoEnvEsperado, esperado = ESPERADO_ENV) {
  for (const [nome, valor] of Object.entries(esperado)) if (env[nome] !== valor) return `${nome} divergente`;
  if (env.DOTENV_CONFIG_PATH !== caminhoEnvEsperado) return 'DOTENV_CONFIG_PATH divergente';
  if (typeof env.DB_PASSWORD !== 'string' || env.DB_PASSWORD.length < 40) return 'DB_PASSWORD ausente ou curta';
  for (const nome of Object.keys(env)) if (PROIBIDAS.test(nome)) return `variável proibida presente: ${nome}`;
  if (execArgv.some((argumento) => /^--env-file/.test(argumento))) return '--env-file não é permitido';
  return null;
}

function marcadorEsperado(uuid, identificadorDoSistema) {
  if (!FORMATO_UUID.test(uuid) || !FORMATO_SISTEMA.test(identificadorDoSistema)) throw new Error('IDENTIDADE ou SYSTEM_ID com formato inválido');
  return `GEPI_J2A_ISOLADO:${uuid}:${identificadorDoSistema}`;
}

/** Normaliza os argumentos de net.Socket.prototype.connect: objeto, [objeto, cb] normalizado, (porta[, host]) ou caminho. */
function normalizarDestino(args) {
  let primeiro = args[0];
  if (Array.isArray(primeiro)) [primeiro] = primeiro;
  if (primeiro !== null && typeof primeiro === 'object') {
    // O Node trata como IPC apenas `path` verdadeiro (`!!options.path`); o agente HTTP passa `path` nulo ou vazio em conexões TCP.
    return { caminho: primeiro.path ? String(primeiro.path) : undefined, host: primeiro.host, porta: primeiro.port === undefined ? undefined : Number(primeiro.port) };
  }
  if (typeof primeiro === 'number' || (typeof primeiro === 'string' && /^\d+$/.test(primeiro))) {
    return { host: typeof args[1] === 'string' ? args[1] : undefined, porta: Number(primeiro) };
  }
  if (typeof primeiro === 'string') return { caminho: primeiro };
  return null;
}

/** Motivo da recusa de uma conexão de rede ou null. `dentroDoCliente`: Client._connect em curso. */
function recusaDeRede(destino, dentroDoCliente, alvo = ALVO) {
  if (destino === null) return 'destino de conexão não reconhecido';
  if (destino.caminho !== undefined) return 'conexão por soquete Unix não é permitida';
  if (!HOSTS_PERMITIDOS.includes(destino.host)) return 'host de conexão fora do loopback explícito';
  if (destino.porta === PORTA_COMPARTILHADA) return 'porta 5432 proibida';
  if (destino.porta === alvo.port && (!dentroDoCliente || destino.host !== alvo.host)) return 'conexão à instância dedicada fora do cliente guardado';
  return null;
}

const destinoDoClienteOk = (cliente, alvo = ALVO) => cliente.host === alvo.host && Number(cliente.port) === alvo.port && cliente.database === alvo.database && cliente.user === alvo.user;

function identidadeOk(linha, marcador, alvo = ALVO) {
  return Boolean(linha) && linha.banco === alvo.database && linha.papel === alvo.user && String(linha.porta) === String(alvo.port)
    && linha.cluster === alvo.cluster && typeof linha.marcador === 'string' && linha.marcador === marcador;
}

/**
 * Instala as três camadas. Devolve { desinstalar } (restaura os originais; usado nos testes). `aoFalhar` é chamada com o motivo;
 * no carregador real ela encerra o processo, e nos testes apenas registra. Mesmo que `aoFalhar` retorne, a conexão não é entregue.
 */
function instalarGuarda({ pg, net, alvo = ALVO, marcador, aoFalhar, tempoMaxIdentidadeMs = 8000 }) {
  const protoCliente = pg && pg.Client && pg.Client.prototype;
  const protoSocket = net && net.Socket && net.Socket.prototype;
  const recusar = (motivo) => { aoFalhar(motivo); return new Error(`GUARDA J2a: ${motivo}`); };
  if (!protoCliente || typeof protoCliente._connect !== 'function' || typeof protoCliente.query !== 'function' || !protoSocket || typeof protoSocket.connect !== 'function') {
    throw recusar('API do driver ou da rede ausente: a guarda não pode ser instalada');
  }
  if (typeof marcador !== 'string' || marcador.length === 0) throw recusar('marcador esperado ausente');
  if (protoCliente.__guardaJ2a === true) throw recusar('guarda já instalada');

  const conectarOriginal = protoCliente._connect;
  const consultarOriginal = protoCliente.query;
  const conectarRedeOriginal = protoSocket.connect;
  const verificados = new WeakSet();
  let dentroDoCliente = 0;

  protoSocket.connect = function conectarRedeGuardado(...args) {
    const motivo = recusaDeRede(normalizarDestino(args), dentroDoCliente > 0, alvo);
    if (motivo !== null) throw recusar(motivo);
    return conectarRedeOriginal.apply(this, args);
  };

  protoCliente._connect = function conectarClienteGuardado(callback) {
    if (!destinoDoClienteOk(this, alvo)) {
      const erro = recusar('destino do cliente divergente (host, porta, banco ou papel)');
      process.nextTick(() => callback(erro));
      return undefined;
    }
    const cliente = this;
    let encerrado = false;
    let temporizador = null;
    const aoErro = () => falharIdentidade('falha de conexão durante a verificação de identidade'); // eslint-disable-line no-use-before-define
    const finalizar = (erro, ...resto) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(temporizador);
      if (erro) { callback(erro); return; }
      cliente.removeListener('error', aoErro);
      verificados.add(cliente);
      callback(null, ...resto);
    };
    function falharIdentidade(motivo) {
      if (encerrado) return;
      const erro = recusar(motivo);
      // end() marca o encerramento como intencional (o pg então não emite 'error', que o ouvinte do pool tornaria exceção não tratada).
      try { const encerrando = cliente.end(); if (encerrando && typeof encerrando.catch === 'function') encerrando.catch(() => {}); } catch (_) { /* já encerrada */ }
      try { cliente.connection.stream.destroy(); } catch (_) { /* já encerrada */ }
      finalizar(erro);
    }
    const aposAutenticar = (erro, ...resto) => {
      if (erro) { finalizar(erro); return; }
      cliente.on('error', aoErro);
      temporizador = setTimeout(() => falharIdentidade('tempo esgotado na verificação de identidade'), tempoMaxIdentidadeMs);
      consultarOriginal.call(cliente, SQL_IDENTIDADE).then((resultado) => {
        let ok = false;
        try { ok = identidadeOk(resultado.rows[0], marcador, alvo); } catch (_) { ok = false; }
        if (!ok) { falharIdentidade('identidade da instância divergente'); return; }
        finalizar(null, ...resto);
      }, () => falharIdentidade('não foi possível comprovar a identidade da instância'));
    };
    dentroDoCliente += 1;
    try { return conectarOriginal.call(this, aposAutenticar); } finally { dentroDoCliente -= 1; }
  };

  protoCliente.query = function consultarGuardado(...args) {
    if (!verificados.has(this)) throw recusar('consulta emitida antes da verificação de identidade da conexão');
    return consultarOriginal.apply(this, args);
  };
  protoCliente.__guardaJ2a = true;

  return {
    desinstalar() {
      protoSocket.connect = conectarRedeOriginal;
      protoCliente._connect = conectarOriginal;
      protoCliente.query = consultarOriginal;
      delete protoCliente.__guardaJ2a;
    },
  };
}

module.exports = {
  ALVO, PORTA_COMPARTILHADA, ESPERADO_ENV, SQL_IDENTIDADE, validarAmbiente, marcadorEsperado, normalizarDestino, recusaDeRede, destinoDoClienteOk, identidadeOk, instalarGuarda,
};
