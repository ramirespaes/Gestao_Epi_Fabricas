'use strict';

const crypto = require('node:crypto');
const fsNode = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Fonte `fiscalizacao-pacotes` (D-ORF-6, P3): CÓPIA VERIFICADA dos ZIPs do plano para a área de preparação do backup e RESTAURAÇÃO em destino NOVO e isolado.
 * Contrato PROVISÓRIO para chamador confiável (a composição por fonte é P6). Nada aqui prova publicação, durabilidade do pacote nem recuperabilidade operacional.
 *
 * `criarCopiaDePacotes({ origem, destino, maxBytesPorArquivo, fs? })` -> `copia({ plano, sinal? })`. `origem` é o armazenamento da Fiscalização (`abrir(chave)`: fluxo de
 * leitura, sem caminho). `destino` é um diretório EXISTENTE da preparação (criado por quem a adquiriu), fora da origem. Cada item do plano (`{ chave, sha256, bytes }`)
 * é gravado em `<destino>/<empresa>/pacote-<id>.zip` por temporário exclusivo (O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600), com SHA-256 e tamanho RECALCULADOS sobre os
 * bytes gravados, limite por arquivo em fluxo, `fsync` e publicação por `link` (nunca sobrescreve). Resultado congelado `{ ok, completo, arquivos, copiados, falha }`,
 * no mesmo formato da cópia de imagens: em sucesso `arquivos` = [{ chave, sha256, bytes }] na ordem do plano; em falha `arquivos` = [] e `falha` = { codigo, chave|null }
 * com código FIXO: PLANO_INVALIDO, ORIGEM_AUSENTE, ORIGEM_INVALIDA, DESTINO_INVALIDO, DESTINO_EXISTENTE, INTEGRIDADE_DIVERGENTE, LIMITE_EXCEDIDO, CANCELADO, COPIA_FALHOU.
 * O plano inteiro é validado ANTES de qualquer E/S; a cópia PARA no primeiro erro; itens já gravados não são apagados (nenhuma exclusão genérica); só o próprio
 * temporário da gravação falha é removido.
 *
 * `restaurarPacotes({ origem, itens, destino, fs? })`: `origem` é o diretório da cópia (`.../fiscalizacao`), `itens` o conjunto esperado (`{ chave, sha256, bytes }`) e
 * `destino` um caminho NOVO (mkdir exclusivo, 0700; existente = DESTINO_EXISTENTE sem tocar em nada). Cada arquivo é lido SEM seguir links, conferido (tamanho e SHA-256)
 * no momento da leitura e gravado pelo mesmo gravador; ao final o destino é RELIDO: conjunto exato (nem faltante, nem extra, sem link) e SHA-256 de cada arquivo.
 * Resultado `{ ok, restaurados, falha }`. Nada é apagado em falha (o destino parcial fica; a decisão é humana).
 *
 * ISOLAMENTO POR EMPRESA: a pasta da empresa vem do primeiro segmento da chave, validada pelo formato; nenhum nome vem do disco. LINKS: nenhum componente é seguido
 * (lstat da pasta da empresa; O_NOFOLLOW no arquivo). LIMITES: sem `openat` no Node, uma troca concorrente de diretório intermediário não é excluída; a origem não é
 * congelada (o plano vem do snapshot do banco; arquivos novos são ignorados).
 */

const CHAVE_FORMATO = /^([1-9][0-9]{0,14})\/pacote-([1-9][0-9]{0,14})\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TAMANHO_MAXIMO = 1024 * 1024 * 1024;
const BLOCO = 256 * 1024;

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fsNode.constants;
const ABRIR_PARA_LER = O_RDONLY | O_NOFOLLOW;
const ABRIR_PARA_CRIAR = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

/** Fachada padrão do sistema de arquivos: exatamente as operações que este módulo usa. */
const FS_PADRAO = Object.freeze({ open: fsp.open, link: fsp.link, rm: fsp.rm, mkdir: fsp.mkdir, lstat: fsp.lstat, readdir: fsp.readdir, realpath: fsp.realpath });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const falhar = (codigo, chave = null) => Object.freeze({ ok: false, completo: false, arquivos: Object.freeze([]), copiados: 0, falha: Object.freeze({ codigo, chave }) });
const comCodigo = (codigo, chave = null) => Object.assign(new Error(codigo), { codigo, chave });
const codigoDe = (falha) => (falha && typeof falha.codigo === 'string' ? falha.codigo : 'COPIA_FALHOU');

function validarFachada(fs) {
  if (!ehObjeto(fs)) throw new TypeError('fachada de arquivos inválida');
  for (const n of Object.keys(FS_PADRAO)) if (typeof fs[n] !== 'function') throw new TypeError('fachada de arquivos inválida');
  return fs;
}

function validarItens(itens) {
  if (!Array.isArray(itens)) throw comCodigo('PLANO_INVALIDO');
  const chaves = new Set();
  const saida = [];
  for (const item of itens) {
    if (!ehObjeto(item) || !mesmasChaves(item, ['chave', 'sha256', 'bytes'])) throw comCodigo('PLANO_INVALIDO');
    const m = typeof item.chave === 'string' ? CHAVE_FORMATO.exec(item.chave) : null;
    if (m === null || !(typeof item.sha256 === 'string' && SHA256.test(item.sha256)) || !(Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= TAMANHO_MAXIMO)) throw comCodigo('PLANO_INVALIDO');
    if (chaves.has(item.chave)) throw comCodigo('PLANO_INVALIDO');
    chaves.add(item.chave);
    saida.push({ chave: item.chave, sha256: item.sha256, bytes: item.bytes, empresa: m[1], nome: `pacote-${m[2]}.zip` });
  }
  return saida;
}
const mesmasChaves = (o, esperadas) => { const k = Reflect.ownKeys(o); return k.length >= esperadas.length && esperadas.every((c) => k.includes(c)) && k.every((c) => typeof c === 'string' && esperadas.includes(c)); };

async function exigirDiretorioReal(fs, caminho, codigo) {
  if (typeof caminho !== 'string' || !path.isAbsolute(caminho) || caminho.includes('\0')) throw comCodigo(codigo);
  let st;
  try { st = await fs.lstat(caminho); } catch { throw comCodigo(codigo); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw comCodigo(codigo);
  let real;
  try { real = await fs.realpath(caminho); } catch { throw comCodigo(codigo); }
  if (real !== path.resolve(caminho)) throw comCodigo(codigo);
  return real;
}

/** Pasta da empresa dentro do destino: criada se não existir (não recursiva, 0700); existente precisa ser diretório real, nunca link. */
async function pastaDaEmpresa(fs, destino, empresa, codigo) {
  const pasta = path.join(destino, empresa);
  try { await fs.mkdir(pasta, { mode: 0o700 }); } catch (falha) {
    if (!falha || falha.code !== 'EEXIST') throw comCodigo(codigo);
  }
  let st;
  try { st = await fs.lstat(pasta); } catch { throw comCodigo(codigo); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw comCodigo(codigo);
  return pasta;
}

/** Grava `fluxo` em `arquivoFinal` por temporário exclusivo, conferindo tamanho e SHA-256 em fluxo; o temporário é SEMPRE removido; nunca sobrescreve. */
async function gravarVerificado(fs, { pasta, nome, fluxo, bytesEsperados, sha256Esperado, maxBytes, sinal }) {
  const arquivoFinal = path.join(pasta, nome);
  const temporario = path.join(pasta, `${nome}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let identificador = null;
  try {
    try { identificador = await fs.open(temporario, ABRIR_PARA_CRIAR, 0o600); } catch { throw comCodigo('COPIA_FALHOU'); }
    const hash = crypto.createHash('sha256');
    let total = 0;
    for await (const bloco of fluxo) {
      if (sinal && sinal.aborted) throw comCodigo('CANCELADO');
      if (!(bloco instanceof Uint8Array)) throw comCodigo('ORIGEM_INVALIDA');
      total += bloco.length;
      if (total > maxBytes) throw comCodigo('LIMITE_EXCEDIDO');
      if (total > bytesEsperados) throw comCodigo('INTEGRIDADE_DIVERGENTE');
      hash.update(bloco);
      try { await identificador.writeFile(bloco); } catch { throw comCodigo('COPIA_FALHOU'); }
    }
    const calculado = hash.digest('hex');
    if (total !== bytesEsperados || calculado !== sha256Esperado) throw comCodigo('INTEGRIDADE_DIVERGENTE');
    try { await identificador.sync(); await identificador.close(); } catch { throw comCodigo('COPIA_FALHOU'); }
    identificador = null;
    try { await fs.link(temporario, arquivoFinal); } catch (falha) {
      throw comCodigo(falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : 'COPIA_FALHOU');
    }
    return { sha256: calculado, bytes: total };
  } finally {
    if (identificador !== null) await identificador.close().catch(() => {});
    await fs.rm(temporario, { force: true }).catch(() => {});
  }
}

async function* lerSemSeguirLinks(fs, caminho, bytesEsperados) {
  let identificador;
  try { identificador = await fs.open(caminho, ABRIR_PARA_LER); } catch (falha) {
    throw comCodigo(falha && falha.code === 'ENOENT' ? 'ORIGEM_AUSENTE' : 'ORIGEM_INVALIDA');
  }
  try {
    const st = await identificador.stat();
    if (!st.isFile() || st.size !== bytesEsperados) throw comCodigo('INTEGRIDADE_DIVERGENTE');
    const bloco = Buffer.allocUnsafe(BLOCO);
    for (;;) {
      const { bytesRead } = await identificador.read(bloco, 0, bloco.length, null);
      if (bytesRead === 0) return;
      yield Buffer.from(bloco.subarray(0, bytesRead));
    }
  } finally {
    await identificador.close().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------------------------------- cópia
function criarCopiaDePacotes(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['origem', 'destino', 'maxBytesPorArquivo', 'fs'].includes(k))) throw new TypeError('opções da cópia inválidas');
  const { origem, destino, maxBytesPorArquivo, fs = FS_PADRAO } = opcoes;
  if (!ehObjeto(origem) || typeof origem.abrir !== 'function') throw new TypeError('origem inválida');
  if (typeof destino !== 'string' || !path.isAbsolute(destino) || destino.includes('\0')) throw new TypeError('destino inválido');
  if (!Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo <= 0) throw new TypeError('limite por arquivo inválido');
  validarFachada(fs);
  const abrir = origem.abrir.bind(origem);

  async function copia(contexto) {
    if (!ehObjeto(contexto)) return falhar('PLANO_INVALIDO');
    let itens;
    try { itens = validarItens(contexto.plano); } catch (falha) { return falhar(codigoDe(falha)); }
    const sinal = contexto.sinal ?? null;
    let raiz;
    try { raiz = await exigirDiretorioReal(fs, destino, 'DESTINO_INVALIDO'); } catch (falha) { return falhar(codigoDe(falha)); }
    const arquivos = [];
    for (const item of itens) {
      try {
        if (sinal && sinal.aborted) throw comCodigo('CANCELADO');
        const pasta = await pastaDaEmpresa(fs, raiz, item.empresa, 'DESTINO_INVALIDO');
        let fluxo;
        try { fluxo = await abrir(item.chave); } catch (falha) {
          throw comCodigo(falha && falha.codigo === 'ARQUIVO_AUSENTE' ? 'ORIGEM_AUSENTE' : 'ORIGEM_INVALIDA');
        }
        const gravado = await gravarVerificado(fs, { pasta, nome: item.nome, fluxo, bytesEsperados: item.bytes, sha256Esperado: item.sha256, maxBytes: maxBytesPorArquivo, sinal });
        arquivos.push(Object.freeze({ chave: item.chave, sha256: gravado.sha256, bytes: gravado.bytes }));
      } catch (falha) {
        return falhar(codigoDe(falha), item.chave);
      }
    }
    return Object.freeze({ ok: true, completo: true, arquivos: Object.freeze(arquivos), copiados: arquivos.length, falha: null });
  }

  return Object.freeze({ copia });
}

// ------------------------------------------------------------------------------------------------------------------------- restauração
async function relerDestino(fs, destino, itens) {
  const esperados = new Map(itens.map((i) => [i.chave, i]));
  const vistos = new Set();
  let empresas;
  try { empresas = await fs.readdir(destino, { withFileTypes: true }); } catch { throw comCodigo('LEITURA_FALHOU'); }
  for (const e of empresas) {
    if (!e.isDirectory() || e.isSymbolicLink() || !/^[1-9][0-9]{0,14}$/.test(e.name)) throw comCodigo('ARQUIVO_EXTRA');
    let arquivos;
    try { arquivos = await fs.readdir(path.join(destino, e.name), { withFileTypes: true }); } catch { throw comCodigo('LEITURA_FALHOU'); }
    for (const a of arquivos) {
      const chave = `${e.name}/${a.name}`;
      if (!a.isFile() || a.isSymbolicLink() || !esperados.has(chave)) throw comCodigo('ARQUIVO_EXTRA', chave);
      const item = esperados.get(chave);
      const hash = crypto.createHash('sha256');
      let total = 0;
      for await (const bloco of lerSemSeguirLinks(fs, path.join(destino, e.name, a.name), item.bytes)) { hash.update(bloco); total += bloco.length; }
      if (total !== item.bytes || hash.digest('hex') !== item.sha256) throw comCodigo('ARQUIVO_DIVERGENTE', chave);
      vistos.add(chave);
    }
  }
  for (const chave of esperados.keys()) if (!vistos.has(chave)) throw comCodigo('ARQUIVO_AUSENTE', chave);
}

async function restaurarPacotes(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['origem', 'itens', 'destino', 'fs'].includes(k))) throw new TypeError('opções da restauração inválidas');
  const { origem, itens, destino, fs = FS_PADRAO } = opcoes;
  validarFachada(fs);
  const resultado = (ok, restaurados, falha) => Object.freeze({ ok, restaurados, falha: falha === null ? null : Object.freeze(falha) });
  let lista;
  try { lista = validarItens(itens); } catch (falha) { return resultado(false, 0, { codigo: 'PLANO_INVALIDO', chave: null }); }
  if (typeof destino !== 'string' || !path.isAbsolute(destino) || destino.includes('\0') || path.resolve(destino) !== destino) return resultado(false, 0, { codigo: 'DESTINO_INVALIDO', chave: null });
  let raizOrigem;
  try { raizOrigem = await exigirDiretorioReal(fs, origem, 'ORIGEM_INVALIDA'); } catch (falha) { return resultado(false, 0, { codigo: codigoDe(falha), chave: null }); }
  if (destino === raizOrigem || destino.startsWith(`${raizOrigem}${path.sep}`) || raizOrigem.startsWith(`${destino}${path.sep}`)) return resultado(false, 0, { codigo: 'DESTINO_INVALIDO', chave: null });
  try { await fs.mkdir(destino, { mode: 0o700 }); } catch (falha) {
    return resultado(false, 0, { codigo: falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : 'DESTINO_INVALIDO', chave: null });
  }
  let restaurados = 0;
  for (const item of lista) {
    try {
      const pastaOrigem = path.join(raizOrigem, item.empresa);
      let stOrigem;
      try { stOrigem = await fs.lstat(pastaOrigem); } catch { throw comCodigo('ORIGEM_AUSENTE'); }
      if (stOrigem.isSymbolicLink() || !stOrigem.isDirectory()) throw comCodigo('ORIGEM_INVALIDA');
      const pasta = await pastaDaEmpresa(fs, destino, item.empresa, 'DESTINO_INVALIDO');
      const fluxo = lerSemSeguirLinks(fs, path.join(pastaOrigem, item.nome), item.bytes);
      await gravarVerificado(fs, { pasta, nome: item.nome, fluxo, bytesEsperados: item.bytes, sha256Esperado: item.sha256, maxBytes: item.bytes, sinal: null });
      restaurados += 1;
    } catch (falha) {
      return resultado(false, restaurados, { codigo: codigoDe(falha), chave: item.chave });
    }
  }
  try { await relerDestino(fs, destino, lista); } catch (falha) { return resultado(false, restaurados, { codigo: codigoDe(falha), chave: falha.chave ?? null }); }
  return resultado(true, restaurados, null);
}

module.exports = { criarCopiaDePacotes, restaurarPacotes, FS_PADRAO, CHAVE_FORMATO, TAMANHO_MAXIMO };
