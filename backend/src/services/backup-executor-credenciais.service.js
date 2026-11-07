'use strict';

/**
 * D-ORF-6, L1 (Bloco A): CONTRATO DE CREDENCIAIS POR PAPEL para as portas AWS do executor. Este módulo NÃO lê arquivo, ambiente nem rede e não conhece a AWS: ele só valida, separa por papel e
 * entrega, no formato que as portas pedem (`credenciais` = função assíncrona), o que um FORNECEDOR injetado devolve. A fonte real das credenciais (arquivo, STS, Roles Anywhere) é decisão H9-a e
 * fica para uma etapa própria; nos testes só existem fornecedores falsos.
 *
 * Papéis = as três identidades da ficha de destino: PUBLICADOR, VERIFICADOR (fora do host do backup) e RESTAURACAO. A porta KMS usa o papel da ação (publicador no backup, restauração na restauração):
 * assunção a confirmar em H9-a.
 *
 * `criarProvedorDeCredenciais({ papel, fornecedor, relogio, margemMs? })` -> `async () => credencial`. O fornecedor tem `obter({ papel }) -> Promise<{ papel, accessKeyId, secretAccessKey, sessionToken?, expiration? }>`.
 * A credencial devolvida é congelada; `secretAccessKey` e `sessionToken` ficam NÃO enumeráveis (não aparecem em `JSON.stringify`, `Object.keys` nem em log por espalhamento); credencial de outro papel, expirada
 * (ou a menos de `margemMs` de expirar), com campo extra ou fora do formato é recusada com código fixo. Nenhum erro carrega valor, mensagem do fornecedor ou causa.
 *
 * `criarConjuntoDeCredenciais({ acao, modo, fornecedores, relogio })` -> `{ papeis, credenciais(papel), verificarSeparacao() }`: só os papéis PERMITIDOS à ação/modo podem ser informados (o host do backup nunca
 * recebe o verificador na operação; no ensaio ele é opcional); um mesmo fornecedor não pode servir a dois papéis; `verificarSeparacao()` exige `accessKeyId` distintos entre os papéis.
 */

const PAPEIS = Object.freeze(['PUBLICADOR', 'VERIFICADOR', 'RESTAURACAO']);
const PAPEIS_DA_ACAO = Object.freeze({
  BACKUP: Object.freeze({ obrigatorios: Object.freeze(['PUBLICADOR']), opcionaisNoEnsaio: Object.freeze(['VERIFICADOR']) }),
  RESTAURACAO: Object.freeze({ obrigatorios: Object.freeze(['RESTAURACAO']), opcionaisNoEnsaio: Object.freeze([]) }),
  VERIFICACAO_DESTINO: Object.freeze({ obrigatorios: Object.freeze(['VERIFICADOR']), opcionaisNoEnsaio: Object.freeze([]) }),
});
const PAPEL_DA_PORTA_KMS = Object.freeze({ BACKUP: 'PUBLICADOR', RESTAURACAO: 'RESTAURACAO' });
const MODOS = Object.freeze(['ENSAIO', 'OPERACAO']);
const ID_DA_CHAVE = /^[A-Z0-9]{16,128}$/;
const SEGREDO = /^[A-Za-z0-9/+=_-]{16,256}$/;
const SESSAO = /^[A-Za-z0-9/+=_.-]{16,4096}$/;
const CHAVES_DA_CREDENCIAL = Object.freeze(['papel', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'expiration']);
const MARGEM_PADRAO_MS = 60000;
const MENSAGENS = Object.freeze({
  CONFIGURACAO_INVALIDA: 'configuração das credenciais inválida',
  CREDENCIAL_INDISPONIVEL: 'credencial indisponível',
  CREDENCIAL_INVALIDA: 'credencial inválida',
  CREDENCIAL_DE_OUTRO_PAPEL: 'credencial de outro papel',
  CREDENCIAL_EXPIRADA: 'credencial expirada',
  CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS: 'credenciais repetidas entre papéis',
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function erro(codigo) {
  return Object.assign(new Error(MENSAGENS[codigo]), { code: codigo });
}

function validarCredencial(bruta, papel, agora, margemMs) {
  if (!ehObjeto(bruta)) throw erro('CREDENCIAL_INVALIDA');
  const proprias = Reflect.ownKeys(bruta);
  if (!proprias.every((k) => typeof k === 'string' && CHAVES_DA_CREDENCIAL.includes(k)) || !['papel', 'accessKeyId', 'secretAccessKey'].every((k) => proprias.includes(k))) throw erro('CREDENCIAL_INVALIDA');
  const { papel: papelDaCredencial, accessKeyId, secretAccessKey, sessionToken, expiration } = bruta;
  if (typeof papelDaCredencial !== 'string' || !PAPEIS.includes(papelDaCredencial)) throw erro('CREDENCIAL_INVALIDA');
  if (papelDaCredencial !== papel) throw erro('CREDENCIAL_DE_OUTRO_PAPEL');
  if (typeof accessKeyId !== 'string' || !ID_DA_CHAVE.test(accessKeyId) || typeof secretAccessKey !== 'string' || !SEGREDO.test(secretAccessKey)) throw erro('CREDENCIAL_INVALIDA');
  if (sessionToken !== undefined && (typeof sessionToken !== 'string' || !SESSAO.test(sessionToken))) throw erro('CREDENCIAL_INVALIDA');
  let expiraEm;
  if (expiration !== undefined) {
    if (!(expiration instanceof Date) || Number.isNaN(expiration.getTime())) throw erro('CREDENCIAL_INVALIDA');
    expiraEm = expiration.getTime();
    if (expiraEm - agora < margemMs) throw erro('CREDENCIAL_EXPIRADA');
  }
  const credencial = { accessKeyId };
  Object.defineProperty(credencial, 'secretAccessKey', { value: secretAccessKey, enumerable: false });
  if (sessionToken !== undefined) Object.defineProperty(credencial, 'sessionToken', { value: sessionToken, enumerable: false });
  if (expiraEm !== undefined) credencial.expiration = new Date(expiraEm);
  return Object.freeze(credencial);
}

function criarProvedorDeCredenciais(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['papel', 'fornecedor', 'relogio', 'margemMs'].includes(k))) throw erro('CONFIGURACAO_INVALIDA');
  const { papel, fornecedor, relogio, margemMs = MARGEM_PADRAO_MS } = opcoes;
  if (typeof papel !== 'string' || !PAPEIS.includes(papel) || !ehObjeto(fornecedor) || typeof fornecedor.obter !== 'function' || typeof relogio !== 'function') throw erro('CONFIGURACAO_INVALIDA');
  if (!Number.isSafeInteger(margemMs) || margemMs < 0 || margemMs > 3600000) throw erro('CONFIGURACAO_INVALIDA');
  const obter = fornecedor.obter;
  return async function credenciais() {
    let bruta;
    try { bruta = await obter.call(fornecedor, Object.freeze({ papel })); } catch { throw erro('CREDENCIAL_INDISPONIVEL'); }
    const agora = relogio();
    if (!Number.isSafeInteger(agora)) throw erro('CONFIGURACAO_INVALIDA');
    return validarCredencial(bruta, papel, agora, margemMs);
  };
}

function criarConjuntoDeCredenciais(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['acao', 'modo', 'fornecedores', 'relogio', 'margemMs'].includes(k))) throw erro('CONFIGURACAO_INVALIDA');
  const { acao, modo, fornecedores, relogio, margemMs } = opcoes;
  if (typeof acao !== 'string' || !Object.hasOwn(PAPEIS_DA_ACAO, acao) || !MODOS.includes(modo) || !ehObjeto(fornecedores)) throw erro('CONFIGURACAO_INVALIDA');
  const regra = PAPEIS_DA_ACAO[acao];
  const permitidos = [...regra.obrigatorios, ...(modo === 'ENSAIO' ? regra.opcionaisNoEnsaio : [])];
  const informados = Reflect.ownKeys(fornecedores);
  if (!informados.every((k) => typeof k === 'string' && permitidos.includes(k)) || !regra.obrigatorios.every((k) => informados.includes(k))) throw erro('CONFIGURACAO_INVALIDA');
  if (new Set(informados.map((k) => fornecedores[k])).size !== informados.length) throw erro('CONFIGURACAO_INVALIDA');
  const provedores = {};
  for (const p of informados) provedores[p] = criarProvedorDeCredenciais({ papel: p, fornecedor: fornecedores[p], relogio, ...(margemMs === undefined ? {} : { margemMs }) });
  const papeis = Object.freeze([...informados].sort());
  const credenciais = (papel) => {
    if (typeof papel !== 'string' || !Object.hasOwn(provedores, papel)) throw erro('CONFIGURACAO_INVALIDA');
    return provedores[papel];
  };
  async function verificarSeparacao() {
    const ids = [];
    for (const p of papeis) ids.push((await provedores[p]()).accessKeyId);
    if (new Set(ids).size !== ids.length) throw erro('CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS');
    return Object.freeze({ ok: true, papeis });
  }
  return Object.freeze({ papeis, credenciais, verificarSeparacao });
}

module.exports = { criarProvedorDeCredenciais, criarConjuntoDeCredenciais, PAPEIS, PAPEIS_DA_ACAO, PAPEL_DA_PORTA_KMS };
