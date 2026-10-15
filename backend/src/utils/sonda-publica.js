'use strict';

/**
 * Sonda de conectividade do monitoramento dos tablets (Etapa J, J2a): do ponto de vista do agendador, o SafeWork responde pelo
 * caminho público? Resultado no contrato do serviço de monitoramento: true = saudável, false = falha comprovada (timeout, rede, TLS,
 * HTTP 5xx), undefined = inconclusiva (resposta que não comprova saúde nem falha). Só consulta a origem configurada pelo
 * OPERADOR no ambiente do job; nada vindo de tablet ou usuário escolhe o destino. O caminho é fixo, redirecionamento não é
 * seguido, o corpo é limitado e o destino nunca vai para log. Esta sonda NÃO prova o PostgreSQL (a rota de saúde não o consulta):
 * a consulta trivial ao banco é feita à parte pelo executor.
 */

const CAMINHO_SAUDE = '/api/health';
const TIMEOUT_PADRAO_MS = 5000;
const TIMEOUT_MINIMO_MS = 1000;
const TIMEOUT_MAXIMO_MS = 15000;
const TAMANHO_MAXIMO_CORPO = 4096;
const SERVICO_ESPERADO = 'gestao-epi-api';

/** Origem canônica https://host[:porta], sem credencial, caminho, consulta nem fragmento. Devolve a origem ou lança TypeError. */
function validarOrigem(valor) {
  if (typeof valor !== 'string') throw new TypeError('origem da sonda inválida');
  let url;
  try {
    url = new URL(valor);
  } catch {
    throw new TypeError('origem da sonda inválida');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || valor !== url.origin) {
    throw new TypeError('origem da sonda deve ser uma origem https canônica');
  }
  return url.origin;
}

async function descartarCorpo(resposta) {
  try {
    await resposta.body?.cancel?.();
  } catch {
    // corpo já consumido ou fechado
  }
}

function criarSondaPublica({ origem, timeoutMs = TIMEOUT_PADRAO_MS, requisitar = globalThis.fetch } = {}) {
  const raiz = validarOrigem(origem);
  if (!Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MINIMO_MS || timeoutMs > TIMEOUT_MAXIMO_MS) throw new TypeError('timeout da sonda inválido');
  if (typeof requisitar !== 'function') throw new TypeError('cliente HTTP da sonda indisponível');
  const alvo = `${raiz}${CAMINHO_SAUDE}`;

  return async function sonda() {
    let resposta;
    try {
      resposta = await requisitar(alvo, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch {
      return false;
    }
    if (resposta.status >= 500) {
      await descartarCorpo(resposta);
      return false;
    }
    if (resposta.status !== 200) {
      await descartarCorpo(resposta);
      return undefined;
    }
    if (Number(resposta.headers?.get?.('content-length') ?? 0) > TAMANHO_MAXIMO_CORPO) {
      await descartarCorpo(resposta);
      return undefined;
    }
    let texto;
    try {
      texto = await resposta.text();
    } catch {
      return false;
    }
    if (texto.length > TAMANHO_MAXIMO_CORPO) return undefined;
    try {
      const corpo = JSON.parse(texto);
      return corpo !== null && typeof corpo === 'object' && corpo.status === 'ok' && corpo.service === SERVICO_ESPERADO ? true : undefined;
    } catch {
      return undefined;
    }
  };
}

module.exports = { CAMINHO_SAUDE, TIMEOUT_PADRAO_MS, validarOrigem, criarSondaPublica };
