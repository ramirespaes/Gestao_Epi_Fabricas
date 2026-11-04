'use strict';

const { listarPadrao, listarEmpresa, identificarBanco } = require('../repositories/imagem-verificacao.repository');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): ADAPTADOR DE CONSISTÊNCIA LÓGICA. Lê, num banco PostgreSQL RESTAURADO, as referências às imagens (`imagens_padrao` e `imagens_empresa`) pelos MESMOS contratos de leitura do verificador e do
 * snapshot do backup (`imagem-verificacao.repository`: `listarPadrao`, `listarEmpresa`, `identificarBanco`; nenhuma tabela, coluna ou relacionamento novo) e devolve ao restaurador o objeto que o contrato de consistência espera. NÃO conecta por conta
 * própria, não lê ambiente, não executa nada ao ser carregado nem ao ser construído.
 *
 * `criarAdaptadorDeReferencias({ criarConexao, tamanhoDaPagina? })` (ESTRITO; TypeError genérico) -> `{ consultar({ banco, conjuntoId, sha256Manifesto }) }`.
 *  - CONEXÃO EXPLICITAMENTE INJETADA: `criarConexao()` devolve um cliente DEDICADO (connect/query/end/on; objeto com forma de pool ou de cliente emprestado é recusado sem ser tocado). A conexão é do chamador; o adaptador só a usa para esta consulta e a encerra.
 *  - SOMENTE LEITURA: cada SQL passa por uma porta que só admite `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SELECT ...` (um comando, sem `;` interno) e `ROLLBACK`; qualquer outra coisa é recusada ANTES de chegar ao cliente. A transação é READ ONLY e termina em ROLLBACK.
 *  - IDENTIDADE: o banco que o PRÓPRIO PostgreSQL informa para a conexão precisa ser o `banco` pedido; senão nada é lido (`BANCO_DIFERENTE`). A resposta ecoa `banco`, `conjuntoId` e `sha256Manifesto` recebidos, para o restaurador rejeitar resposta de outra operação.
 *  - COMPLETUDE: `completa:true` só com as duas tabelas lidas até o fim (páginas coerentes, cursor estritamente crescente, limite respeitado), conexão não perdida e transação encerrada (ROLLBACK + end confirmados). Qualquer falha devolve `{ ok:false, motivo }`
 *    de um conjunto fechado, sem mensagem do banco, sem SQL e sem valores.
 *
 * LIMITES: nenhuma conexão real foi exercida; o resultado de uma consulta feita num banco SIMULADO não é prova de consistência lógica de um banco restaurado de verdade (o restaurador nunca marca `verificada:true` por isso).
 */

const CHAVES_DA_CONSULTA = ['banco', 'conjuntoId', 'sha256Manifesto'];
const EXECUCAO_ID = /^[0-9a-f]{32}$/;
/** Chaves exatas, mais `execucaoId` OPCIONAL (identidade da execução de restauração, gerada pela composição). Devolve o identificador (ou null) ou `undefined` se a forma for inválida. */
function execucaoDaEntrada(entrada, base) {
  const proprias = Reflect.ownKeys(entrada);
  const comId = proprias.includes('execucaoId');
  if (!chavesExatas(entrada, comId ? [...base, 'execucaoId'] : base)) return undefined;
  if (!comId) return null;
  return typeof entrada.execucaoId === 'string' && EXECUCAO_ID.test(entrada.execucaoId) ? entrada.execucaoId : undefined;
}
const PAGINA_PADRAO = 500;
const PAGINA_MAXIMA = 1000;
const BANCO = /^[a-z][a-z0-9_]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const SQL_PERMITIDO = /^\s*(?:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SELECT\b[^;]*;?)\s*$/i;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const invalido = () => new TypeError('adaptador de referências inválido');

function clienteDedicado(c) {
  if (c === null || typeof c !== 'object') return false;
  if (!ehFuncao(c.connect) || !ehFuncao(c.query) || !ehFuncao(c.end) || !ehFuncao(c.on)) return false;
  return !('release' in c) && !('totalCount' in c) && !('idleCount' in c) && !('waitingCount' in c);
}

/** Evidências PRODUZIDAS por este módulo (marcas internas): literal ou clone não é reconhecido. */
const consultasProduzidas = new WeakSet();
const sondasProduzidas = new WeakSet();
const ehResultadoDeConsulta = (v) => v !== null && typeof v === 'object' && consultasProduzidas.has(v);
const ehEvidenciaDeInstancia = (v) => v !== null && typeof v === 'object' && sondasProduzidas.has(v);
/** O cliente é uma instância do `Client` do driver `pg`? (carregamento adiado: nada é carregado nem conectado ao importar o módulo). Um cliente simulado nunca é. */
function clienteDoDriver(cliente) {
  try { return cliente instanceof require('pg').Client; } catch { return false; }
}

class Falha extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}

function criarAdaptadorDeReferencias(opcoes) {
  let criarConexao;
  let tamanho;
  try {
    if (!ehObjeto(opcoes)) throw invalido();
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && ['criarConexao', 'tamanhoDaPagina'].includes(k)) || !proprias.includes('criarConexao')) throw invalido();
    criarConexao = opcoes.criarConexao;
    tamanho = proprias.includes('tamanhoDaPagina') ? opcoes.tamanhoDaPagina : PAGINA_PADRAO;
    if (!ehFuncao(criarConexao) || !Number.isInteger(tamanho) || tamanho < 1 || tamanho > PAGINA_MAXIMA) throw invalido();
  } catch {
    throw invalido();
  }

  async function paginar(ler) {
    const todas = [];
    let depoisDe = '0';
    for (;;) {
      const pagina = await ler(depoisDe, tamanho);
      if (!Array.isArray(pagina) || pagina.length > tamanho) throw new Falha('CONSULTA_INVALIDA');
      for (const linha of pagina) {
        if (!ehObjeto(linha) || typeof linha.id !== 'string' || !ID_DECIMAL.test(linha.id)) throw new Falha('CONSULTA_INVALIDA');
        todas.push(Object.freeze({ ...linha }));
      }
      if (pagina.length < tamanho) return Object.freeze(todas);
      const ultimo = pagina[pagina.length - 1].id;
      if (BigInt(ultimo) <= BigInt(depoisDe)) throw new Falha('CONSULTA_INVALIDA');
      depoisDe = ultimo;
    }
  }

  async function consultar(entrada) {
    if (!ehObjeto(entrada)) throw invalido();
    const execucaoId = execucaoDaEntrada(entrada, CHAVES_DA_CONSULTA);
    if (execucaoId === undefined) throw invalido();
    const { banco, conjuntoId, sha256Manifesto } = entrada;
    if (typeof banco !== 'string' || !BANCO.test(banco) || typeof conjuntoId !== 'string' || conjuntoId === '' || typeof sha256Manifesto !== 'string' || !SHA256.test(sha256Manifesto)) throw invalido();

    let cliente = null;
    let conectado = false;
    let transacao = false;
    let perdida = false;
    let genuino = false;
    let resposta;
    try {
      let candidato;
      try { candidato = await criarConexao(); } catch { throw new Falha('CONEXAO_INDISPONIVEL'); }
      if (!clienteDedicado(candidato)) throw new Falha('CONEXAO_INVALIDA');
      cliente = candidato;
      genuino = clienteDoDriver(candidato);
      cliente.on('error', () => { perdida = true; });
      cliente.on('end', () => { perdida = true; });
      // Porta de leitura: o único caminho do SQL até o cliente.
      const executor = Object.freeze({
        async query(sql, parametros) {
          if (typeof sql !== 'string' || !SQL_PERMITIDO.test(sql)) throw new Falha('SQL_NAO_PERMITIDO');
          if (perdida) throw new Falha('CONEXAO_PERDIDA');
          return cliente.query(sql, parametros);
        },
      });
      try { await cliente.connect(); conectado = true; } catch { throw new Falha('CONEXAO_FALHOU'); }
      try { transacao = true; await executor.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); } catch (f) { throw f instanceof Falha ? f : new Falha('BEGIN_FALHOU'); }
      let identidade;
      try { identidade = await identificarBanco(executor); } catch (f) { throw f instanceof Falha ? f : new Falha('IDENTIDADE_FALHOU'); }
      if (!ehObjeto(identidade) || typeof identidade.nome !== 'string') throw new Falha('IDENTIDADE_INVALIDA');
      if (identidade.nome !== banco) throw new Falha('BANCO_DIFERENTE');
      const lerSeguro = (leitor) => async (depoisDe, limite) => {
        try { return await leitor(executor, { depoisDe, limite }); } catch (f) { throw f instanceof Falha ? f : new Falha('CONSULTA_FALHOU'); }
      };
      const padrao = await paginar(lerSeguro(listarPadrao));
      const empresa = await paginar(lerSeguro(listarEmpresa));
      if (perdida) throw new Falha('CONEXAO_PERDIDA');
      resposta = { padrao, empresa };
    } catch (falha) {
      resposta = { motivo: falha instanceof Falha ? falha.motivo : 'CONSULTA_FALHOU' };
    }

    // Encerramento: ROLLBACK (se o BEGIN foi enviado) e end(); sem isso a leitura não é dada como completa.
    let encerrada = true;
    if (cliente !== null) {
      if (transacao && conectado && !perdida) {
        try { await cliente.query('ROLLBACK'); } catch { encerrada = false; }
      }
      try { await cliente.end(); } catch { encerrada = false; }
    }
    if (resposta.motivo !== undefined) return Object.freeze({ ok: false, motivo: resposta.motivo });
    if (!encerrada) return Object.freeze({ ok: false, motivo: 'ENCERRAMENTO_FALHOU' });
    const evidencia = Object.freeze({ ok: true, completa: true, origem: 'CONEXAO_INJETADA', clienteGenuino: genuino, execucaoId, banco, conjuntoId, sha256Manifesto, registros: Object.freeze({ padrao: resposta.padrao, empresa: resposta.empresa }) });
    consultasProduzidas.add(evidencia);
    return evidencia;
  }

  return Object.freeze({ consultar });
}

/**
 * SONDA DE IDENTIDADE DA INSTÂNCIA: `criarSondaDeInstancia({ criarConexao })` -> `{ sondar({ banco }) }`. Pela conexão dedicada INJETADA, numa transação READ ONLY, pergunta ao PRÓPRIO servidor: banco atual, versão (16), `data_directory`, `unix_socket_directories`, porta,
 * `listen_addresses` e se a conexão NÃO tem endereço TCP; devolve a evidência RECONHECIDA `{ ok, bancoAtual, versao16, dataDirectory, unixSocketDirectories, porta, listenVazio, semEnderecoTcp, clienteGenuino }` (ou `{ ok:false, motivo }`). Não compara com nada: quem decide é o avaliador
 * da proveniência, contra o destino AUTORIZADO pela configuração. Um cliente simulado resulta em `clienteGenuino:false`.
 */
function criarSondaDeInstancia(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['criarConexao']) || !ehFuncao(opcoes.criarConexao)) throw invalido();
  const { criarConexao } = opcoes;
  async function sondar(entrada) {
    if (!ehObjeto(entrada)) throw invalido();
    const execucaoId = execucaoDaEntrada(entrada, ['banco']);
    if (execucaoId === undefined || typeof entrada.banco !== 'string' || !BANCO.test(entrada.banco)) throw invalido();
    let cliente = null;
    let transacao = false;
    let linha = null;
    let genuino = false;
    let motivo = null;
    try {
      let candidato;
      try { candidato = await criarConexao(); } catch { throw new Falha('CONEXAO_INDISPONIVEL'); }
      if (!clienteDedicado(candidato)) throw new Falha('CONEXAO_INVALIDA');
      cliente = candidato;
      genuino = clienteDoDriver(candidato);
      cliente.on('error', () => {});
      try { await cliente.connect(); } catch { throw new Falha('CONEXAO_FALHOU'); }
      const consultar = async (sql) => { if (!SQL_PERMITIDO.test(sql)) throw new Falha('SQL_NAO_PERMITIDO'); return cliente.query(sql); };
      try { transacao = true; await consultar('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); } catch { throw new Falha('BEGIN_FALHOU'); }
      let resposta;
      try {
        resposta = await consultar(`SELECT current_database() AS banco, current_setting('server_version_num') AS versao, current_setting('data_directory') AS data_directory,
          current_setting('unix_socket_directories') AS sockets, current_setting('port') AS porta, current_setting('listen_addresses') AS listen, (inet_server_addr() IS NULL) AS sem_tcp`);
      } catch { throw new Falha('SONDA_FALHOU'); }
      linha = resposta && Array.isArray(resposta.rows) && resposta.rows.length === 1 ? resposta.rows[0] : null;
      if (!ehObjeto(linha) || typeof linha.banco !== 'string' || typeof linha.versao !== 'string' || typeof linha.data_directory !== 'string' || typeof linha.sockets !== 'string' || typeof linha.porta !== 'string' || typeof linha.listen !== 'string' || typeof linha.sem_tcp !== 'boolean') throw new Falha('SONDA_INVALIDA');
    } catch (falha) {
      motivo = falha instanceof Falha ? falha.motivo : 'SONDA_FALHOU';
    }
    let encerrada = true;
    if (cliente !== null) {
      if (transacao) { try { await cliente.query('ROLLBACK'); } catch { encerrada = false; } }
      try { await cliente.end(); } catch { encerrada = false; }
    }
    if (motivo !== null) return Object.freeze({ ok: false, motivo });
    if (!encerrada) return Object.freeze({ ok: false, motivo: 'ENCERRAMENTO_FALHOU' });
    const evidencia = Object.freeze({
      ok: true,
      origem: 'SONDA_DE_INSTANCIA',
      execucaoId,
      clienteGenuino: genuino,
      bancoAtual: linha.banco,
      versao16: /^16[0-9]{4}$/.test(linha.versao),
      dataDirectory: linha.data_directory,
      unixSocketDirectories: linha.sockets,
      porta: linha.porta,
      listenVazio: linha.listen === '',
      semEnderecoTcp: linha.sem_tcp === true,
    });
    sondasProduzidas.add(evidencia);
    return evidencia;
  }
  return Object.freeze({ sondar });
}

module.exports = { criarAdaptadorDeReferencias, criarSondaDeInstancia, ehResultadoDeConsulta, ehEvidenciaDeInstancia, sqlPermitido: (sql) => typeof sql === 'string' && SQL_PERMITIDO.test(sql) };
