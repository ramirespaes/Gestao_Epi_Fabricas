'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');
const { verificarPacoteL2 } = require('./backup-fontes-composicao-l2.service');

/**
 * D-ORF-6, P11 (R2 §13.3 RC-1, RC-2, RC-4, RC-7, RC-8; D-F4 opção a — envelope no pacote): CIFRA EM ENVELOPE de um pacote layout 2 JÁ VERIFICADO, produzindo um
 * CONTÊINER cifrado em diretório NOVO, e a operação inversa. Nada aqui escolhe provedor, cofre ou KMS: a chave de cifra (KEK) chega por uma FONTE DE CHAVES DE CIFRA
 * produzida pela fábrica deste módulo (hoje só `TESTE_CONTROLADO`, com NODE_ENV=test; `PROVEDORES_DE_CIFRA_APROVADOS` está VAZIA — decisão D-F5). A chave do MAC do
 * envelope vem de uma fonte DISTINTA (a fábrica do manifesto); as duas fontes nunca podem ser o mesmo objeto, da mesma família, com o mesmo id ou o mesmo segredo (RC-4).
 *
 * FORMATO: `envelope.json` (canônico; HMAC-SHA256 com domínio `SAFEWORK-BACKUP-ENVELOPE-V1\n` sobre o corpo sem `autenticacao` — encrypt-then-MAC, RC-7) +
 * `dados/<caminho>.enc` para CADA arquivo do pacote (inclusive `manifesto.json`, `manifesto.sha256` e o dump: o manifesto em claro exporia chaves com `empresaId` e
 * hashes — RC-8). Cada arquivo: AES-256-GCM com chave de dados (DEK) aleatória por contêiner, IV aleatório de 12 bytes por arquivo, AAD = caminho relativo; a DEK é
 * envolvida (AES-256-GCM) pela KEK `chaveIdCifra`. O envelope registra caminho, bytes em claro, SHA-256 do cifrado, IV e tag; nunca conteúdo. Limite declarado
 * (RC-8): os caminhos ficam visíveis no contêiner (contêm `empresaId` e hashes de conteúdo, já presentes no manifesto).
 *
 * `cifrarPacote({ pacote, lido, destino, cifra:{fonte,chaveId}, mac:{fonte,chaveId} })`: (1) `verificarPacoteL2` (conjunto exato, hashes) — nada é cifrado de um pacote
 * não verificado; (2) destino NOVO 0700 (mkdir não recursivo; existente = recusa); (3) cifra arquivo a arquivo (temporário exclusivo 0600 → fsync → link; o temporário
 * de uma gravação falha é removido; nada mais é apagado); (4) envelope assinado por último. DEK e KEK são zeradas na memória ao fim.
 * `decifrarContainer({ container, destino, cifra, mac })`: envelope lido com limite → forma exata → MAC em tempo constante ANTES de qualquer confiança → KEK → DEK →
 * cada arquivo decifrado (GCM: tag inválida = `ARQUIVO_ADULTERADO`, sem publicar; SHA-256 do cifrado e bytes em claro conferidos) para destino NOVO. A verificação do
 * pacote reconstruído (`verificarPacoteL2` com o leitor L2) é do chamador, que possui a fonte do manifesto.
 *
 * O que NÃO está aqui: custódia (módulo próprio), destino durável (lista vazia), rotação da KEK (re-envelopar), TLS (D-F7). Nenhuma chave real: só TESTE_CONTROLADO.
 */

const VERSAO = 1;
const ALGORITMO = 'AES-256-GCM';
const ALGORITMO_MAC = 'HMAC-SHA256';
const DOMINIO = Buffer.from('SAFEWORK-BACKUP-ENVELOPE-V1\n', 'utf8');
const PROVEDORES_DE_CIFRA_APROVADOS = Object.freeze([]);
const ORIGENS_PRODUZIVEIS = new Set(['TESTE_CONTROLADO']);
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IV = /^[0-9a-f]{24}$/;
const TAG = /^[0-9a-f]{32}$/;
const DEK_ENVOLVIDA = /^[0-9a-f]{64}$/;
const CAMINHO = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const LIMITES = Object.freeze({ envelopeBytes: 64 * 1024 * 1024, arquivos: 400000, bytesDoSegredo: 32, blocoBytes: 256 * 1024 });
const CHAVES_DO_ENVELOPE = Object.freeze(['algoritmo', 'arquivos', 'autenticacao', 'chaveEnvolvida', 'chaveIdCifra', 'versao']);
const CHAVES_DO_ARQUIVO = Object.freeze(['bytes', 'caminho', 'iv', 'sha256Cifrado', 'tag']);
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;

const fontesDeCifra = new WeakSet();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const chavesExatas = (o, esperadas) => { const p = Reflect.ownKeys(o); return p.length === esperadas.length && p.every((k) => typeof k === 'string' && esperadas.includes(k)); };
function fonteInvalida() { const e = new TypeError('fonte de chaves de cifra inválida'); e.code = 'FONTE_INVALIDA'; return e; }
const falha = (passo, codigo) => Object.freeze({ ok: false, falha: Object.freeze({ passo, codigo }) });

/** Mesmo contrato da fonte de chaves do manifesto, mas de outra FAMÍLIA: um objeto da fonte do manifesto nunca é aceito como fonte de cifra, e vice-versa. */
function criarFonteDeChavesDeCifra(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['origem', 'chaves'])) throw fonteInvalida();
  const { origem, chaves } = opcoes;
  if (typeof origem !== 'string' || !ORIGENS_PRODUZIVEIS.has(origem)) throw fonteInvalida();
  if (origem === 'TESTE_CONTROLADO' && process.env.NODE_ENV !== 'test') throw fonteInvalida();
  if (!Array.isArray(chaves) || chaves.length === 0) throw fonteInvalida();
  const mapa = new Map();
  for (const item of chaves) {
    const p = ehObjeto(item) ? Reflect.ownKeys(item) : [];
    if (!ehObjeto(item) || !p.every((k) => ['id', 'segredo', 'revogada'].includes(k)) || !p.includes('id') || !p.includes('segredo')) throw fonteInvalida();
    if (typeof item.id !== 'string' || !CHAVE_ID.test(item.id) || mapa.has(item.id)) throw fonteInvalida();
    if (!(item.segredo instanceof Uint8Array) || item.segredo.length !== LIMITES.bytesDoSegredo) throw fonteInvalida();
    if (p.includes('revogada') && typeof item.revogada !== 'boolean') throw fonteInvalida();
    mapa.set(item.id, { segredo: Buffer.from(item.segredo), revogada: item.revogada === true });
  }
  const fonte = Object.freeze({
    origem, familia: 'CIFRA',
    obter(id) { const i = typeof id === 'string' ? mapa.get(id) : undefined; if (i === undefined) return { situacao: 'INDISPONIVEL' }; if (i.revogada) return { situacao: 'REVOGADA' }; return { situacao: 'ATIVA', segredo: Buffer.from(i.segredo) }; },
    toJSON() { return { origem, familia: 'CIFRA' }; },
  });
  fontesDeCifra.add(fonte);
  return fonte;
}
/** Fonte OPERACIONAL de cifra: BLOQUEADA enquanto `PROVEDORES_DE_CIFRA_APROVADOS` estiver vazia (D-F5). */
function criarFonteOperacionalDeCifra(opcoes) {
  const e = new Error('fonte operacional de cifra indisponível');
  e.code = 'FONTE_OPERACIONAL_INDISPONIVEL';
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['provedor', 'adaptador']) || !PROVEDORES_DE_CIFRA_APROVADOS.includes(opcoes.provedor)) throw e;
  throw e;
}
const ehFonteDeCifra = (v) => v !== null && typeof v === 'object' && fontesDeCifra.has(v);

/** RC-4: famílias distintas, objetos distintos, ids distintos, segredos distintos; ambas ATIVAS. Devolve cópias dos segredos ou { motivo }. */
function capturarChaves({ cifra, mac }) {
  if (!ehObjeto(cifra) || !chavesExatas(cifra, ['fonte', 'chaveId']) || !ehObjeto(mac) || !chavesExatas(mac, ['fonte', 'chaveId'])) return { motivo: 'CHAVES_INVALIDAS' };
  if (!ehFonteDeCifra(cifra.fonte) || !ehFonteDeChaves(mac.fonte) || ehFonteDeCifra(mac.fonte) || cifra.fonte === mac.fonte) return { motivo: 'CHAVES_NAO_SEPARADAS' };
  if (typeof cifra.chaveId !== 'string' || !CHAVE_ID.test(cifra.chaveId) || typeof mac.chaveId !== 'string' || !CHAVE_ID.test(mac.chaveId) || cifra.chaveId === mac.chaveId) return { motivo: 'CHAVES_NAO_SEPARADAS' };
  const kek = cifra.fonte.obter(cifra.chaveId);
  if (kek.situacao === 'REVOGADA') return { motivo: 'CHAVE_DE_CIFRA_REVOGADA' };
  if (kek.situacao !== 'ATIVA' || !(kek.segredo instanceof Uint8Array) || kek.segredo.length !== 32) return { motivo: 'CHAVE_DE_CIFRA_INDISPONIVEL' };
  const hm = mac.fonte.obter(mac.chaveId);
  if (hm.situacao === 'REVOGADA') return { motivo: 'CHAVE_DE_MAC_REVOGADA' };
  if (hm.situacao !== 'ATIVA' || !(hm.segredo instanceof Uint8Array) || hm.segredo.length < 32) return { motivo: 'CHAVE_DE_MAC_INDISPONIVEL' };
  if (Buffer.from(kek.segredo).equals(Buffer.from(hm.segredo))) return { motivo: 'CHAVES_NAO_SEPARADAS' };
  return { kek: Buffer.from(kek.segredo), hmac: Buffer.from(hm.segredo), chaveIdCifra: cifra.chaveId, chaveIdMac: mac.chaveId };
}

async function diretorioReal(caminho) { try { const e = await fsp.lstat(caminho); return e.isDirectory() && (await fsp.realpath(caminho)) === caminho; } catch { return false; } }
async function criarSubdiretorio(pai, nome) {
  if (!SEGMENTO.test(nome) || nome === '.' || nome === '..' || !(await diretorioReal(pai))) return false;
  try { await fsp.mkdir(path.join(pai, nome), { recursive: false, mode: 0o700 }); } catch { return false; }
  return diretorioReal(path.join(pai, nome));
}
async function garantirCaminho(raiz, relativo) {
  const partes = relativo.split('/');
  let atual = raiz;
  for (const p of partes.slice(0, -1)) {
    const alvo = path.join(atual, p);
    if (!(await diretorioReal(alvo)) && !(await criarSubdiretorio(atual, p))) return null;
    atual = alvo;
  }
  return path.join(atual, partes[partes.length - 1]);
}
/** Grava arquivo NOVO: temporário exclusivo 0600 → blocos → fsync → link (nunca sobrescreve) → rm SÓ do próprio temporário (também em falha). */
async function gravarNovo(caminhoFinal, produzir) {
  const temporario = `${caminhoFinal}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const descritor = await fsp.open(temporario, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  const hash = crypto.createHash('sha256');
  let total = 0;
  let ligado = false;
  try {
    try {
      for await (const bloco of produzir()) { await descritor.writeFile(bloco); hash.update(bloco); total += bloco.length; }
      await descritor.sync();
    } finally { await descritor.close(); }
    await fsp.link(temporario, caminhoFinal);
    ligado = true;
    return { bytes: total, sha256: hash.digest('hex') };
  } finally {
    await fsp.rm(temporario, { force: true }).catch(() => {});
    if (!ligado) { /* nada ligado: o destino final não existe; o temporário foi removido */ }
  }
}
async function* lerBlocos(caminho) {
  const d = await fsp.open(caminho, O_RDONLY | O_NOFOLLOW);
  try {
    if (!(await d.stat()).isFile()) throw Object.assign(new Error('tipo'), { codigo: 'ENTRADA_INVALIDA' });
    const bloco = Buffer.alloc(LIMITES.blocoBytes);
    for (;;) { const { bytesRead } = await d.read(bloco, 0, bloco.length, null); if (bytesRead === 0) return; yield Buffer.from(bloco.subarray(0, bytesRead)); }
  } finally { await d.close(); }
}
function canonico(valor) {
  if (valor === null || typeof valor === 'boolean' || typeof valor === 'string' || Number.isSafeInteger(valor)) return valor;
  if (Array.isArray(valor)) return valor.map(canonico);
  if (ehObjeto(valor)) { const s = {}; for (const k of Object.keys(valor).sort()) s[k] = canonico(valor[k]); return s; }
  throw new TypeError('valor não serializável');
}
const bytesCanonicos = (o) => Buffer.from(JSON.stringify(canonico(o)), 'utf8');
const calcularMac = (segredo, corpo) => crypto.createHmac('sha256', segredo).update(DOMINIO).update(corpo).digest('hex');
const iguais = (a, b) => { const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex'); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function envolverDek(kek, dek) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const corpo = Buffer.concat([c.update(dek), c.final()]);
  return { corpo: corpo.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex') };
}
function desenvolverDek(kek, env) {
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(env.iv, 'hex'));
  d.setAuthTag(Buffer.from(env.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(env.corpo, 'hex')), d.final()]);
}

async function cifrarPacote(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, ['pacote', 'lido', 'destino', 'cifra', 'mac'])) return falha('ENTRADA', 'ENTRADA_INVALIDA');
  const { pacote, lido, destino } = entrada;
  if (!caminhoAbsolutoCanonico(pacote) || !caminhoAbsolutoCanonico(destino)) return falha('ENTRADA', 'ENTRADA_INVALIDA');
  const chaves = capturarChaves({ cifra: entrada.cifra, mac: entrada.mac });
  if (chaves.motivo !== undefined) return falha('CHAVES', chaves.motivo);
  try {
    // (1) só pacote verificado
    const v = await verificarPacoteL2({ pacote, lido });
    if (v.ok !== true) return falha('VERIFICACAO', v.motivo);
    const relativos = [];
    for (const f of lido.fontes) for (const a of f.arquivos) relativos.push(lido.caminhoDe(f.id, a.chave));
    relativos.push('manifesto.json', 'manifesto.sha256', lido.manifesto.dump.arquivo);
    relativos.sort();
    if (relativos.length > LIMITES.arquivos || !relativos.every((r) => CAMINHO.test(r)) || new Set(relativos).size !== relativos.length) return falha('VERIFICACAO', 'LIMITE_EXCEDIDO');
    // (2) destino NOVO
    if (fs.existsSync(destino) || !(await criarSubdiretorio(path.dirname(destino), path.basename(destino))) || !(await criarSubdiretorio(destino, 'dados'))) return falha('DESTINO', 'DESTINO_EXISTENTE');
    // (3) cifra arquivo a arquivo (a DEK é envolvida ANTES de qualquer efeito e zerada ao fim)
    const dek = crypto.randomBytes(32);
    const chaveEnvolvida = envolverDek(chaves.kek, dek);
    const arquivos = [];
    let bytesEmClaro = 0;
    try {
      for (const rel of relativos) {
        const alvo = await garantirCaminho(path.join(destino, 'dados'), `${rel}.enc`);
        if (alvo === null) return falha('CIFRA', 'DESTINO_INVALIDO');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
        cipher.setAAD(Buffer.from(rel, 'utf8'));
        let bytesClaro = 0;
        const gravado = await gravarNovo(alvo, async function* produzir() {
          for await (const bloco of lerBlocos(path.join(pacote, ...rel.split('/')))) { bytesClaro += bloco.length; const c = cipher.update(bloco); if (c.length > 0) yield c; }
          const fim = cipher.final(); if (fim.length > 0) yield fim;
        });
        bytesEmClaro += bytesClaro;
        arquivos.push({ bytes: bytesClaro, caminho: rel, iv: iv.toString('hex'), sha256Cifrado: gravado.sha256, tag: cipher.getAuthTag().toString('hex') });
      }
    } catch { return falha('CIFRA', 'ESCRITA_FALHOU'); } finally { dek.fill(0); }
    // (4) envelope autenticado por último (encrypt-then-MAC)
    const corpo = { algoritmo: ALGORITMO, arquivos, chaveEnvolvida, chaveIdCifra: chaves.chaveIdCifra, versao: VERSAO };
    const envelope = { ...corpo, autenticacao: { algoritmo: ALGORITMO_MAC, chaveId: chaves.chaveIdMac, mac: calcularMac(chaves.hmac, bytesCanonicos(corpo)) } };
    const bytes = bytesCanonicos(envelope);
    let gravado;
    try { gravado = await gravarNovo(path.join(destino, 'envelope.json'), async function* produzir() { yield bytes; }); } catch { return falha('ENVELOPE', 'ESCRITA_FALHOU'); }
    return Object.freeze({ ok: true, container: destino, arquivos: arquivos.length, bytesEmClaro, sha256Envelope: gravado.sha256, chaveIdCifra: chaves.chaveIdCifra, chaveIdMac: chaves.chaveIdMac });
  } finally { chaves.kek.fill(0); chaves.hmac.fill(0); }
}

function validarEnvelope(objeto) {
  if (!ehObjeto(objeto) || !chavesExatas(objeto, CHAVES_DO_ENVELOPE)) return 'ENVELOPE_INVALIDO';
  if (objeto.versao !== VERSAO) return 'VERSAO_DESCONHECIDA';
  if (objeto.algoritmo !== ALGORITMO) return 'ALGORITMO_INVALIDO';
  if (typeof objeto.chaveIdCifra !== 'string' || !CHAVE_ID.test(objeto.chaveIdCifra)) return 'ENVELOPE_INVALIDO';
  const env = objeto.chaveEnvolvida;
  if (!ehObjeto(env) || !chavesExatas(env, ['corpo', 'iv', 'tag']) || !DEK_ENVOLVIDA.test(env.corpo) || !IV.test(env.iv) || !TAG.test(env.tag)) return 'ENVELOPE_INVALIDO';
  if (!Array.isArray(objeto.arquivos) || objeto.arquivos.length === 0 || objeto.arquivos.length > LIMITES.arquivos) return 'ENVELOPE_INVALIDO';
  const vistos = new Set();
  let anterior = null;
  for (const a of objeto.arquivos) {
    if (!ehObjeto(a) || !chavesExatas(a, CHAVES_DO_ARQUIVO) || typeof a.caminho !== 'string' || !CAMINHO.test(a.caminho) || vistos.has(a.caminho)) return 'ENVELOPE_INVALIDO';
    if (anterior !== null && a.caminho <= anterior) return 'ENVELOPE_INVALIDO';
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 0 || !IV.test(a.iv) || !TAG.test(a.tag) || !SHA256.test(a.sha256Cifrado)) return 'ENVELOPE_INVALIDO';
    vistos.add(a.caminho);
    anterior = a.caminho;
  }
  return null;
}

async function decifrarContainer(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, ['container', 'destino', 'cifra', 'mac'])) return falha('ENTRADA', 'ENTRADA_INVALIDA');
  const { container, destino } = entrada;
  if (!caminhoAbsolutoCanonico(container) || !caminhoAbsolutoCanonico(destino)) return falha('ENTRADA', 'ENTRADA_INVALIDA');
  const chaves = capturarChaves({ cifra: entrada.cifra, mac: entrada.mac });
  if (chaves.motivo !== undefined) return falha('CHAVES', chaves.motivo);
  try {
    // envelope: tamanho, JSON, forma exata, MAC (antes de confiar em qualquer campo)
    let objeto;
    try {
      const d = await fsp.open(path.join(container, 'envelope.json'), O_RDONLY | O_NOFOLLOW);
      try {
        const estado = await d.stat();
        if (!estado.isFile() || estado.size === 0 || estado.size > LIMITES.envelopeBytes) return falha('ENVELOPE', 'ENVELOPE_INVALIDO');
        const buf = Buffer.alloc(estado.size);
        const { bytesRead } = await d.read(buf, 0, buf.length, 0);
        objeto = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, bytesRead)));
      } finally { await d.close(); }
    } catch { return falha('ENVELOPE', 'ENVELOPE_AUSENTE'); }
    if (!ehObjeto(objeto) || !ehObjeto(objeto.autenticacao) || !chavesExatas(objeto.autenticacao, ['algoritmo', 'chaveId', 'mac'])) return falha('ENVELOPE', 'AUTENTICACAO_AUSENTE');
    const { autenticacao, ...corpo } = objeto;
    if (autenticacao.algoritmo !== ALGORITMO_MAC || autenticacao.chaveId !== chaves.chaveIdMac || typeof autenticacao.mac !== 'string' || !SHA256.test(autenticacao.mac)) return falha('ENVELOPE', 'AUTENTICACAO_AUSENTE');
    let esperado;
    try { esperado = calcularMac(chaves.hmac, bytesCanonicos(corpo)); } catch { return falha('ENVELOPE', 'MAC_INVALIDO'); }
    if (!iguais(esperado, autenticacao.mac)) return falha('ENVELOPE', 'MAC_INVALIDO');
    const motivo = validarEnvelope(objeto);
    if (motivo !== null) return falha('ENVELOPE', motivo);
    if (objeto.chaveIdCifra !== chaves.chaveIdCifra) return falha('CHAVES', 'CHAVE_DE_CIFRA_DIVERGENTE');
    if (!bytesCanonicos(objeto).equals(bytesCanonicos(canonico(objeto)))) return falha('ENVELOPE', 'ENVELOPE_INVALIDO');
    // DEK
    let dek;
    try { dek = desenvolverDek(chaves.kek, objeto.chaveEnvolvida); } catch { return falha('CHAVES', 'DEK_NAO_DESENVOLVIDA'); }
    if (dek.length !== 32) { dek.fill(0); return falha('CHAVES', 'DEK_NAO_DESENVOLVIDA'); }
    try {
      // destino NOVO
      if (fs.existsSync(destino) || !(await criarSubdiretorio(path.dirname(destino), path.basename(destino)))) return falha('DESTINO', 'DESTINO_EXISTENTE');
      let total = 0;
      for (const a of objeto.arquivos) {
        const origem = path.join(container, 'dados', ...`${a.caminho}.enc`.split('/'));
        const alvo = await garantirCaminho(destino, a.caminho);
        if (alvo === null) return falha('DECIFRA', 'DESTINO_INVALIDO');
        const decipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(a.iv, 'hex'));
        decipher.setAAD(Buffer.from(a.caminho, 'utf8'));
        decipher.setAuthTag(Buffer.from(a.tag, 'hex'));
        const hashCifrado = crypto.createHash('sha256');
        let gravado;
        try {
          gravado = await gravarNovo(alvo, async function* produzir() {
            for await (const bloco of lerBlocos(origem)) { hashCifrado.update(bloco); const p = decipher.update(bloco); if (p.length > 0) yield p; }
            const fim = decipher.final(); if (fim.length > 0) yield fim; // lança se a tag não confere: nada é ligado ao nome final
          });
        } catch (e) { return falha('DECIFRA', e && e.code === 'ENOENT' ? 'ARQUIVO_AUSENTE' : 'ARQUIVO_ADULTERADO'); }
        if (hashCifrado.digest('hex') !== a.sha256Cifrado || gravado.bytes !== a.bytes) return falha('DECIFRA', 'ARQUIVO_ADULTERADO');
        total += gravado.bytes;
      }
      return Object.freeze({ ok: true, pacote: destino, arquivos: objeto.arquivos.length, bytesEmClaro: total, chaveIdCifra: objeto.chaveIdCifra });
    } finally { dek.fill(0); }
  } finally { chaves.kek.fill(0); chaves.hmac.fill(0); }
}

module.exports = { criarFonteDeChavesDeCifra, criarFonteOperacionalDeCifra, ehFonteDeCifra, capturarChaves, cifrarPacote, decifrarContainer, validarEnvelope, PROVEDORES_DE_CIFRA_APROVADOS, VERSAO, ALGORITMO, ALGORITMO_MAC, DOMINIO, LIMITES, CHAVES_DO_ENVELOPE, CHAVES_DO_ARQUIVO };
