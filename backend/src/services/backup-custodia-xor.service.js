'use strict';

const crypto = require('node:crypto');

/**
 * D-ORF-6, R-D45 (D-F5): CUSTÓDIA INDEPENDENTE POR DIVISÃO XOR 2 DE 3 — divisão de um segredo em partes, formato em texto para transcrição e reconstrução por qualquer
 * dupla de custodiantes. É a única forma de recuperar as chaves se o KMS ou a conta AWS forem perdidos. Módulo PURO: não lê arquivo, rede, ambiente nem entrada padrão,
 * e NÃO gera segredo operacional (o segredo chega de quem chama; a cerimônia real não faz parte desta rodada).
 *
 * MATEMÁTICA. Seja S o segredo (n bytes). Escolhem-se a e b uniformes e independentes em {0,1}^8n e c = S xor a xor b; logo a xor b xor c = S.
 * Os custodiantes 1, 2 e 3 recebem os pares (a,b), (b,c) e (c,a): o custodiante k guarda as partes de índices [k, k mod 3 + 1].
 *  - Reconstrução: quaisquer dois custodiantes juntos têm as três partes (cada par de pares cobre {1,2,3}) e S = a xor b xor c.
 *  - Limite de conhecimento: o que UM custodiante vê é um par de partes. Para cada segredo S, os pares (a,b), (a,c) e (b,c) percorrem exatamente uma vez todos os pares
 *    possíveis (a e b são livres; c = S xor a xor b é uma bijeção de b para fixo a). Logo a distribuição do que ele vê não depende de S: informação mútua zero,
 *    sigilo perfeito (teórico, sem hipótese de poder computacional). Dado qualquer par visível, TODOS os segredos possíveis são compatíveis, cada um com UMA terceira parte.
 * Este não é um esquema de limiar de Shamir: cada custodiante guarda 2/3 do volume total de partes. Dois custodiantes que se unem nunca precisam de um terceiro.
 *
 * VALOR DE VERIFICAÇÃO (VC): SHA-256 de `SAFEWORK-BACKUP-KCV-V1\n` + id da chave + `\n` + segredo. Registrado nos pacotes (não é segredo: o segredo tem 256 bits ou mais de
 * entropia). Prova a reconstrução sem decifrar nenhum dado. Cada parte carrega ainda 8 hex de verificação (SHA-256 de domínio, chave, índice e valor) para detectar erro
 * de transcrição em papel. Falha fechada: toda recusa devolve só um motivo fixo, nunca valores.
 */

const FORMATO = 'SAFEWORK-CUSTODIA-XOR-2DE3-V1';
const DOMINIO_VC = Buffer.from('SAFEWORK-BACKUP-KCV-V1\n', 'utf8');
const DOMINIO_PARTE = 'SAFEWORK-BACKUP-PARTE-V1\n';
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX8 = /^[0-9a-f]{8}$/;
const HEX_PARTE = /^(?:[0-9a-f]{2}){32,128}$/;
const BYTES_MIN = 32;
const BYTES_MAX = 128;
const TEXTO = new RegExp(`^${FORMATO}\\nchave: ([A-Za-z0-9][A-Za-z0-9._-]{0,63})\\ncustodiante: ([1-3])\\nvc: ([0-9a-f]{64})\\nparte ([1-3]): ((?:[0-9a-f]{2}){32,128}) ([0-9a-f]{8})\\nparte ([1-3]): ((?:[0-9a-f]{2}){32,128}) ([0-9a-f]{8})\\n$`);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração de custódia inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const recusa = (motivo) => Object.freeze({ ok: false, motivo });
const indicesDe = (custodiante) => [custodiante, (custodiante % 3) + 1];

const valorDeVerificacao = (chaveId, segredo) => crypto.createHash('sha256').update(DOMINIO_VC).update(chaveId, 'utf8').update('\n').update(segredo).digest('hex');
const verificacaoDaParte = (chaveId, indice, valor) => crypto.createHash('sha256').update(`${DOMINIO_PARTE}${chaveId}\n${indice}\n${valor}`, 'utf8').digest('hex').slice(0, 8);

function combinarPartes(...partes) {
  if (partes.length === 0 || !partes.every((p) => p instanceof Uint8Array && p.length === partes[0].length)) throw configuracaoInvalida();
  const saida = Buffer.alloc(partes[0].length);
  for (const p of partes) for (let i = 0; i < saida.length; i += 1) saida[i] ^= p[i];
  return saida;
}

/** Primitiva da divisão: com a e b dados, c = S xor a xor b. Devolve cópias [a, b, c]. */
function dividirEmTresPartes(segredo, a, b) {
  const c = combinarPartes(segredo, a, b);
  return [Buffer.from(a), Buffer.from(b), c];
}

function dividirSegredo(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['chaveId', 'segredo', 'aleatorio'].includes(k)) || !Reflect.ownKeys(opcoes).includes('chaveId') || !Reflect.ownKeys(opcoes).includes('segredo')) throw configuracaoInvalida();
  const { chaveId, segredo } = opcoes;
  const aleatorio = opcoes.aleatorio === undefined ? (n) => crypto.randomBytes(n) : opcoes.aleatorio;
  if (typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId) || !(segredo instanceof Uint8Array) || segredo.length < BYTES_MIN || segredo.length > BYTES_MAX || typeof aleatorio !== 'function') throw configuracaoInvalida();
  const n = segredo.length;
  const sorteio = () => {
    let b;
    try { b = aleatorio(n); } catch { throw configuracaoInvalida(); }
    if (!(b instanceof Uint8Array) || b.length !== n) throw configuracaoInvalida();
    return Buffer.from(b);
  };
  const a = sorteio();
  const b = sorteio();
  const [pa, pb, pc] = dividirEmTresPartes(segredo, a, b);
  const parte = (indice, buf) => { const valor = buf.toString('hex'); return Object.freeze({ indice, valor, verificacao: verificacaoDaParte(chaveId, indice, valor) }); };
  const partes = { 1: parte(1, pa), 2: parte(2, pb), 3: parte(3, pc) };
  for (const buf of [a, b, pa, pb, pc]) buf.fill(0);
  const vc = valorDeVerificacao(chaveId, segredo);
  const pacotes = [1, 2, 3].map((k) => Object.freeze({ formato: FORMATO, chaveId, custodiante: k, valorDeVerificacao: vc, partes: Object.freeze(indicesDe(k).map((i) => partes[i])) }));
  return Object.freeze({ chaveId, valorDeVerificacao: vc, pacotes: Object.freeze(pacotes) });
}

/** Motivo da recusa de um pacote (forma e transcrição) ou null. */
function motivoDoPacote(p) {
  if (!ehObjeto(p) || !chavesExatas(p, ['formato', 'chaveId', 'custodiante', 'valorDeVerificacao', 'partes']) || p.formato !== FORMATO || typeof p.chaveId !== 'string' || !CHAVE_ID.test(p.chaveId)) return 'PACOTE_FORMATO';
  if (!Number.isInteger(p.custodiante) || p.custodiante < 1 || p.custodiante > 3 || typeof p.valorDeVerificacao !== 'string' || !HEX64.test(p.valorDeVerificacao)) return 'PACOTE_FORMATO';
  if (!Array.isArray(p.partes) || p.partes.length !== 2) return 'PACOTE_FORMATO';
  const esperados = indicesDe(p.custodiante);
  for (let i = 0; i < 2; i += 1) {
    const x = p.partes[i];
    if (!ehObjeto(x) || !chavesExatas(x, ['indice', 'valor', 'verificacao']) || x.indice !== esperados[i] || typeof x.valor !== 'string' || !HEX_PARTE.test(x.valor) || typeof x.verificacao !== 'string' || !HEX8.test(x.verificacao)) return 'PACOTE_FORMATO';
  }
  if (p.partes[0].valor.length !== p.partes[1].valor.length) return 'PACOTE_FORMATO';
  for (const x of p.partes) if (verificacaoDaParte(p.chaveId, x.indice, x.valor) !== x.verificacao) return 'PARTE_COM_ERRO_DE_TRANSCRICAO';
  return null;
}

function codificarPacote(p) {
  if (motivoDoPacote(p) !== null) throw configuracaoInvalida();
  const [x, y] = p.partes;
  return `${FORMATO}\nchave: ${p.chaveId}\ncustodiante: ${p.custodiante}\nvc: ${p.valorDeVerificacao}\nparte ${x.indice}: ${x.valor} ${x.verificacao}\nparte ${y.indice}: ${y.valor} ${y.verificacao}\n`;
}

function decodificarPacote(texto) {
  const m = typeof texto === 'string' ? TEXTO.exec(texto) : null;
  if (m === null) return recusa('PACOTE_FORMATO');
  return Object.freeze({ ok: true, pacote: Object.freeze({ formato: FORMATO, chaveId: m[1], custodiante: Number(m[2]), valorDeVerificacao: m[3], partes: Object.freeze([Object.freeze({ indice: Number(m[4]), valor: m[5], verificacao: m[6] }), Object.freeze({ indice: Number(m[7]), valor: m[8], verificacao: m[9] })]) }) });
}

/** Reconstrói o segredo a partir de 2 ou 3 pacotes (objetos ou texto) de custodiantes distintos e confere o valor de verificação. */
function reconstruirSegredo(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, ['pacotes']) || !Array.isArray(entrada.pacotes) || entrada.pacotes.length < 1 || entrada.pacotes.length > 3) return recusa('ENTRADA_INVALIDA');
  const pacotes = [];
  for (const item of entrada.pacotes) {
    let p = item;
    if (typeof item === 'string') {
      const d = decodificarPacote(item);
      if (!d.ok) return recusa(d.motivo);
      p = d.pacote;
    }
    const motivo = motivoDoPacote(p);
    if (motivo !== null) return recusa(motivo);
    pacotes.push(p);
  }
  if (pacotes.length < 2) return recusa('PACOTES_INSUFICIENTES');
  if (pacotes.some((p) => p.chaveId !== pacotes[0].chaveId || p.valorDeVerificacao !== pacotes[0].valorDeVerificacao)) return recusa('PACOTES_DE_CHAVES_DIFERENTES');
  if (new Set(pacotes.map((p) => p.custodiante)).size !== pacotes.length) return recusa('CUSTODIANTES_REPETIDOS');
  const porIndice = new Map();
  for (const p of pacotes) {
    for (const x of p.partes) {
      if (porIndice.has(x.indice) && porIndice.get(x.indice) !== x.valor) return recusa('PARTE_DIVERGENTE');
      porIndice.set(x.indice, x.valor);
    }
  }
  if (porIndice.size !== 3) return recusa('PACOTES_INSUFICIENTES');
  const buffers = [1, 2, 3].map((i) => Buffer.from(porIndice.get(i), 'hex'));
  if (buffers.some((b) => b.length !== buffers[0].length)) return recusa('PARTE_DIVERGENTE');
  const segredo = combinarPartes(...buffers);
  for (const b of buffers) b.fill(0);
  const vc = valorDeVerificacao(pacotes[0].chaveId, segredo);
  if (!crypto.timingSafeEqual(Buffer.from(vc, 'hex'), Buffer.from(pacotes[0].valorDeVerificacao, 'hex'))) { segredo.fill(0); return recusa('VALOR_DE_VERIFICACAO_DIVERGENTE'); }
  return Object.freeze({ ok: true, chaveId: pacotes[0].chaveId, segredo, valorDeVerificacao: vc });
}

module.exports = { dividirSegredo, dividirEmTresPartes, combinarPartes, reconstruirSegredo, codificarPacote, decodificarPacote, valorDeVerificacao, verificacaoDaParte, FORMATO, BYTES_MIN, BYTES_MAX };
