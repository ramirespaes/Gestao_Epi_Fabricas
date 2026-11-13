'use strict';

const nodeHttp = require('node:http');

/**
 * D-ORF-6, D5: fornecedor de credenciais temporárias do IAM Roles Anywhere para o provedor de credenciais do executor. Fala só com o endpoint local do `aws_signing_helper serve` (127.0.0.1); contrato, limites e o que
 * não foi provado estão em docs/sistema/operacao.md. Não lê arquivo, ambiente nem processo e nada em `src/` o importa nesta etapa.
 *
 * `criarFornecedorRolesAnywhere({ papel, papelIam, porta | transporte, http? (só com porta), relogio?, prazoMs? })` -> `{ obter({ papel }) }`; `criarTransporteLoopback({ porta, http? })` -> `(pedido) => Promise<{ status, corpo }>`.
 */

const ENDERECO_LOCAL = '127.0.0.1';
const ROTA_DA_SESSAO = '/latest/api/token';
const ROTA_DO_PAPEL = '/latest/meta-data/iam/security-credentials';
const CABECALHO_DA_VALIDADE = 'x-aws-ec2-metadata-token-ttl-seconds';
const CABECALHO_DA_SESSAO = 'x-aws-ec2-metadata-token';
const VALIDADE_MINIMA_DA_SESSAO_S = 60;
const FOLGA_DA_SESSAO_S = 5;
const TEXTO_SEM_CREDENCIAL = 'failed to refresh credentials';
const CODIGO_DE_SUCESSO = 'Success';
const TIPO_DA_CREDENCIAL = 'AWS-HMAC';
const PREFIXO_TEMPORARIO = 'ASIA';
const PAPEIS_DO_PROVEDOR = Object.freeze(['PUBLICADOR', 'VERIFICADOR', 'RESTAURACAO']);
const CHAVES_DO_CORPO = Object.freeze(['AccessKeyId', 'SecretAccessKey', 'Token', 'Code', 'Type', 'Expiration', 'LastUpdated']);
const CHAVES_DO_PEDIDO = Object.freeze(['metodo', 'caminho', 'cabecalhos', 'prazoMs', 'limiteBytes']);
const CODIGOS_DO_TRANSPORTE = Object.freeze(['RESPOSTA_INVALIDA', 'CONFIGURACAO_INVALIDA']);
const PRAZO_PADRAO_MS = 15000;
const PRAZO_MAXIMO_MS = 60000;
const LIMITE_DO_CORPO = 8192;
const LIMITE_MAXIMO_DO_CORPO = 1_000_000;
const JANELA_MAXIMA_MS = 43_500_000;

const NOME_DO_PAPEL_IAM = /^[A-Za-z0-9+=,@_-][A-Za-z0-9+=,.@_-]{0,63}$/;
const FORMATO_DA_SESSAO = /^[A-Za-z0-9+/=_-]{16,512}$/;
const IDENTIFICADOR = /^[A-Z0-9]{16,128}$/;
const SEGREDO = /^[A-Za-z0-9/+=_-]{16,256}$/;
const SESSAO_AWS = /^[A-Za-z0-9/+=_.-]{16,4096}$/;
const CAMINHO_PERMITIDO = /^\/latest\/[A-Za-z0-9/_+=,.@-]*$/;
const NOME_DE_CABECALHO = /^[a-z0-9-]{1,64}$/;
const VALOR_DE_CABECALHO = /^[\x21-\x7e]{1,600}$/;
const INSTANTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const MENSAGENS = Object.freeze({
  CONFIGURACAO_INVALIDA: 'configuração do fornecedor de credenciais temporárias inválida',
  PEDIDO_INCOERENTE: 'pedido de credencial incoerente com o papel',
  ENDPOINT_INDISPONIVEL: 'endpoint local de credenciais indisponível',
  RESPOSTA_INVALIDA: 'resposta do endpoint local fora do contrato',
  HELPER_SEM_CREDENCIAL: 'o endpoint local não tem credencial válida',
  PAPEL_IAM_DIVERGENTE: 'papel IAM do endpoint diverge do configurado',
  CREDENCIAL_NAO_TEMPORARIA: 'identificador de credencial não é temporário',
  CREDENCIAL_EXPIRADA: 'credencial expirada',
  EXPIRACAO_FORA_DA_FAIXA: 'expiração fora da faixa esperada',
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroEntre = (v, minimo, maximo) => Number.isSafeInteger(v) && v >= minimo && v <= maximo;
const soChaves = (objeto, permitidas) => Reflect.ownKeys(objeto).every((k) => typeof k === 'string' && permitidas.includes(k));
const semQuebraFinal = (texto) => texto.replace(/\r?\n$/, '');
const erro = (codigo) => Object.assign(new Error(MENSAGENS[codigo]), { code: codigo });

/** Cada campo do pedido é lido uma só vez; o que for validado é exatamente o que será enviado. */
function conferirPedido(pedido) {
  if (!ehObjeto(pedido) || Reflect.ownKeys(pedido).length !== CHAVES_DO_PEDIDO.length || !CHAVES_DO_PEDIDO.every((k) => Object.hasOwn(pedido, k))) throw erro('CONFIGURACAO_INVALIDA');
  const { metodo, caminho, cabecalhos, prazoMs, limiteBytes } = pedido;
  const entradas = ehObjeto(cabecalhos) && Reflect.ownKeys(cabecalhos).every((k) => typeof k === 'string') ? Object.entries(cabecalhos) : null;
  const caminhoValido = typeof caminho === 'string' && CAMINHO_PERMITIDO.test(caminho) && !caminho.includes('//') && !caminho.split('/').some((trecho) => trecho === '.' || trecho === '..');
  const cabecalhosValidos = entradas !== null && entradas.every(([nome, valor]) => NOME_DE_CABECALHO.test(nome) && typeof valor === 'string' && VALOR_DE_CABECALHO.test(valor));
  if (!['PUT', 'GET'].includes(metodo) || !caminhoValido || !cabecalhosValidos || !inteiroEntre(prazoMs, 1, PRAZO_MAXIMO_MS) || !inteiroEntre(limiteBytes, 1, LIMITE_MAXIMO_DO_CORPO)) throw erro('CONFIGURACAO_INVALIDA');
  return { metodo, caminho, cabecalhos: Object.fromEntries(entradas), prazoMs, limiteBytes };
}

/** Conclui a promessa uma só vez; `abortar` destrói a requisição, e prazo, erro ou fechamento antes do fim viram uma recusa de código fixo. */
function criarControle(rejeitar, prazoMs) {
  let concluido = false;
  let requisicao = null;
  const temporizador = setTimeout(() => controle.abortar('ENDPOINT_INDISPONIVEL'), prazoMs);
  const controle = {
    vincular: (nova) => { requisicao = nova; },
    concluir: (acao, valor) => {
      if (concluido) return;
      concluido = true;
      clearTimeout(temporizador);
      acao(valor);
    },
    abortar: (codigo) => {
      if (concluido) return;
      try { requisicao?.destroy(); } catch { /* destruir falhou: a requisição já terminou */ }
      controle.concluir(rejeitar, erro(codigo));
    },
  };
  return controle;
}

function lerResposta(resposta, limiteBytes, controle, resolver) {
  resposta.on('error', () => controle.abortar('ENDPOINT_INDISPONIVEL'));
  resposta.on('close', () => controle.abortar('ENDPOINT_INDISPONIVEL'));
  const declarado = Number(resposta.headers?.['content-length']);
  if (Number.isFinite(declarado) && declarado > limiteBytes) {
    controle.abortar('RESPOSTA_INVALIDA');
    return;
  }
  const blocos = [];
  let total = 0;
  resposta.on('data', (parte) => {
    const bloco = typeof parte === 'string' ? Buffer.from(parte) : parte;
    total += bloco.length;
    if (total > limiteBytes) controle.abortar('RESPOSTA_INVALIDA');
    else blocos.push(bloco);
  });
  resposta.on('end', () => controle.concluir(resolver, { status: resposta.statusCode, corpo: Buffer.concat(blocos).toString('utf8') }));
}

function requisitar(http, porta, { metodo, caminho, cabecalhos, prazoMs, limiteBytes }) {
  return new Promise((resolver, rejeitar) => {
    const controle = criarControle(rejeitar, prazoMs);
    let requisicao;
    try {
      requisicao = http.request({ host: ENDERECO_LOCAL, port: porta, method: metodo, path: caminho, headers: cabecalhos, agent: false });
    } catch {
      controle.abortar('ENDPOINT_INDISPONIVEL');
      return;
    }
    controle.vincular(requisicao);
    requisicao.on('error', () => controle.abortar('ENDPOINT_INDISPONIVEL'));
    requisicao.on('response', (resposta) => lerResposta(resposta, limiteBytes, controle, resolver));
    requisicao.end();
  });
}

function criarTransporteLoopback(opcoes) {
  if (!ehObjeto(opcoes) || !soChaves(opcoes, ['porta', 'http'])) throw erro('CONFIGURACAO_INVALIDA');
  const { porta, http = nodeHttp } = opcoes;
  if (!inteiroEntre(porta, 1024, 65535) || !ehObjeto(http) || typeof http.request !== 'function') throw erro('CONFIGURACAO_INVALIDA');
  return function transportar(pedido) {
    let validado;
    try { validado = conferirPedido(pedido); } catch { return Promise.reject(erro('CONFIGURACAO_INVALIDA')); }
    return requisitar(http, porta, validado);
  };
}

/** O prazo vale no próprio fornecedor: um transporte injetado que nunca conclui não prende a aquisição compartilhada. */
function comPrazo(iniciar, prazoMs) {
  let temporizador = null;
  return new Promise((resolver, rejeitar) => {
    temporizador = setTimeout(() => rejeitar(erro('ENDPOINT_INDISPONIVEL')), prazoMs);
    Promise.resolve(iniciar()).then(resolver, rejeitar);
  }).finally(() => clearTimeout(temporizador));
}

/** Lê o código uma só vez; um erro hostil (acessor ou Proxy que lança) cai no código padrão. */
function codigoDoTransporte(e) {
  try {
    const codigo = e.code;
    if (CODIGOS_DO_TRANSPORTE.includes(codigo)) return codigo;
  } catch { /* acessor ou Proxy hostil: vale o código padrão */ }
  return 'ENDPOINT_INDISPONIVEL';
}

/** Lê `status` e `corpo` uma só vez e devolve a cópia validada: o que foi conferido é o que será usado. */
function copiarResposta(resposta) {
  let status;
  let corpo;
  try {
    if (ehObjeto(resposta)) ({ status, corpo } = resposta);
  } catch {
    throw erro('RESPOSTA_INVALIDA');
  }
  if (typeof corpo !== 'string' || Buffer.byteLength(corpo) > LIMITE_DO_CORPO) throw erro('RESPOSTA_INVALIDA');
  return { status, corpo };
}

async function chamar(enviar, prazoMs, metodo, caminho, cabecalhos) {
  let resposta;
  try {
    resposta = await comPrazo(() => enviar({ metodo, caminho, cabecalhos, prazoMs, limiteBytes: LIMITE_DO_CORPO }), prazoMs);
  } catch (e) {
    throw erro(codigoDoTransporte(e));
  }
  return copiarResposta(resposta);
}

function corpoDe({ status, corpo }, aceitaSemCredencial = false) {
  if (status === 200) return corpo;
  if (aceitaSemCredencial && status === 500 && semQuebraFinal(corpo) === TEXTO_SEM_CREDENCIAL) throw erro('HELPER_SEM_CREDENCIAL');
  throw erro('RESPOSTA_INVALIDA');
}

/** O V8 aceita dia além do fim do mês e hora 24: a tabela de dias e a conferência da hora os recusam aqui (mês fora de 1 a 12 também). Dia 00, minuto, segundo e deslocamento fora da faixa ficam com o `Date.parse` (RA-10). */
function lerInstante(valor) {
  const partes = INSTANTE.exec(valor);
  if (partes === null) throw erro('RESPOSTA_INVALIDA');
  const [ano, mes, dia, hora] = partes.slice(1).map(Number);
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const diasDoMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const instante = hora <= 23 && dia <= diasDoMes[mes - 1] ? Date.parse(valor) : Number.NaN;
  if (Number.isNaN(instante)) throw erro('RESPOSTA_INVALIDA');
  return instante;
}

function lerCredenciais(corpo, relogio) {
  let bruto;
  try { bruto = JSON.parse(corpo); } catch { throw erro('RESPOSTA_INVALIDA'); }
  const chaves = ehObjeto(bruto) ? Reflect.ownKeys(bruto) : [];
  if (chaves.length !== CHAVES_DO_CORPO.length || !CHAVES_DO_CORPO.every((k) => chaves.includes(k))) throw erro('RESPOSTA_INVALIDA');
  const { AccessKeyId: identificador, SecretAccessKey: segredo, Token: sessao, Code: situacao, Type: tipo, Expiration: validade, LastUpdated: atualizadoEm } = bruto;
  if (![identificador, segredo, sessao, situacao, tipo, validade, atualizadoEm].every((v) => typeof v === 'string')) throw erro('RESPOSTA_INVALIDA');
  if (situacao !== CODIGO_DE_SUCESSO || tipo !== TIPO_DA_CREDENCIAL) throw erro('RESPOSTA_INVALIDA');
  if (!IDENTIFICADOR.test(identificador) || !SEGREDO.test(segredo) || !SESSAO_AWS.test(sessao) || atualizadoEm.length < 1 || atualizadoEm.length > 64) throw erro('RESPOSTA_INVALIDA');
  if (!identificador.startsWith(PREFIXO_TEMPORARIO)) throw erro('CREDENCIAL_NAO_TEMPORARIA');
  const expira = lerInstante(validade);
  let agora;
  try { agora = relogio(); } catch { throw erro('CONFIGURACAO_INVALIDA'); }
  if (!Number.isSafeInteger(agora)) throw erro('CONFIGURACAO_INVALIDA');
  if (expira <= agora) throw erro('CREDENCIAL_EXPIRADA');
  if (expira - agora > JANELA_MAXIMA_MS) throw erro('EXPIRACAO_FORA_DA_FAIXA');
  return { identificador, segredo, sessao, expira };
}

/** Um resultado por chamador, com `Date` próprio; segredo e sessão não enumeráveis. */
function montarResultado(papel, { identificador, segredo, sessao, expira }) {
  const resultado = { papel, accessKeyId: identificador, expiration: new Date(expira) };
  Object.defineProperty(resultado, 'secretAccessKey', { value: segredo, enumerable: false });
  Object.defineProperty(resultado, 'sessionToken', { value: sessao, enumerable: false });
  return Object.freeze(resultado);
}

/** A sessão precisa durar mais que o pior caso das três chamadas em série. */
const validadeDaSessao = (prazoMs) => String(Math.max(VALIDADE_MINIMA_DA_SESSAO_S, Math.ceil((3 * prazoMs) / 1000) + FOLGA_DA_SESSAO_S));

async function adquirir({ enviar, prazoMs, papelIam, relogio }) {
  const abertura = await chamar(enviar, prazoMs, 'PUT', ROTA_DA_SESSAO, { [CABECALHO_DA_VALIDADE]: validadeDaSessao(prazoMs), 'content-length': '0' });
  const codigo = semQuebraFinal(corpoDe(abertura));
  if (!FORMATO_DA_SESSAO.test(codigo)) throw erro('RESPOSTA_INVALIDA');
  const nome = semQuebraFinal(corpoDe(await chamar(enviar, prazoMs, 'GET', ROTA_DO_PAPEL, { [CABECALHO_DA_SESSAO]: codigo })));
  if (nome !== papelIam) throw erro('PAPEL_IAM_DIVERGENTE');
  const resposta = await chamar(enviar, prazoMs, 'GET', `${ROTA_DO_PAPEL}/${papelIam}`, { [CABECALHO_DA_SESSAO]: codigo });
  return lerCredenciais(corpoDe(resposta, true), relogio);
}

function criarFornecedorRolesAnywhere(opcoes) {
  if (!ehObjeto(opcoes) || !soChaves(opcoes, ['papel', 'papelIam', 'porta', 'transporte', 'http', 'relogio', 'prazoMs'])) throw erro('CONFIGURACAO_INVALIDA');
  const { papel, papelIam, porta, transporte, http, relogio = () => Date.now(), prazoMs = PRAZO_PADRAO_MS } = opcoes;
  const origemUnica = (transporte === undefined) !== (porta === undefined);
  const httpSoComPorta = http === undefined || porta !== undefined;
  const transporteValido = transporte === undefined || typeof transporte === 'function';
  if (!PAPEIS_DO_PROVEDOR.includes(papel) || typeof papelIam !== 'string' || !NOME_DO_PAPEL_IAM.test(papelIam)
    || !origemUnica || !httpSoComPorta || !transporteValido || typeof relogio !== 'function' || !inteiroEntre(prazoMs, 1, PRAZO_MAXIMO_MS)) throw erro('CONFIGURACAO_INVALIDA');
  const enviar = transporte ?? criarTransporteLoopback({ porta, ...(http === undefined ? {} : { http }) });
  const contexto = { enviar, prazoMs, papelIam, relogio };
  let emAndamento = null;
  function obter(pedido) {
    if (!ehObjeto(pedido) || Reflect.ownKeys(pedido).length !== 1 || !Object.hasOwn(pedido, 'papel') || pedido.papel !== papel) return Promise.reject(erro('PEDIDO_INCOERENTE'));
    if (emAndamento === null) emAndamento = adquirir(contexto).finally(() => { emAndamento = null; });
    return emAndamento.then((dados) => montarResultado(papel, dados));
  }
  return Object.freeze({ obter });
}

module.exports = { criarFornecedorRolesAnywhere, criarTransporteLoopback };
