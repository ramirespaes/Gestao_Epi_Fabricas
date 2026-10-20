'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

// Leitura entregue como fluxo por descritor numérico: um fluxo aberto e nunca lido não vira erro ao ser coletado.
const abrirDescritor = promisify(fs.open);
const fstat = promisify(fs.fstat);

/**
 * Armazenamento de imagens de produto (Biblioteca de Imagens, Unidade 1), atrás de uma interface que um driver S3 também cumpriria.
 *
 * Chave: "<empresaId|padrao>/<sha256>/<variante>.<ext>", montada por `chaveDe` só a partir de valores validados; toda chave recebida
 * é conferida contra o mesmo formato. A biblioteca padrão usa o namespace "padrao", que nunca é um identificador de empresa.
 * Escrita: temporário privado (0600) na pasta de destino, sincronizado em disco e publicado por link, que NUNCA sobrescreve; chave
 * existente com os mesmos bytes é reaproveitada e com bytes diferentes é recusada (o original fica intacto). Pastas 0700 e arquivos
 * 0600. Links simbólicos em qualquer componente da chave são recusados. Mensagens de erro nunca levam chave, caminho ou conteúdo.
 */

const CHAVE = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const PREFIXO = /^(?:[1-9][0-9]{0,14}|padrao)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NOME_VARIANTE = /^(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const NOMES_POSSIVEIS = ['mestre.png', 'mestre.jpg', 'mestre.webp', 'exibicao.webp', 'miniatura.webp'];
const EXTENSAO = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp' };
const EMPRESA_MAX = 999999999999999;
const TENTATIVAS_CRIACAO = 3;

const MENSAGENS = {
  CHAVE_INVALIDA: 'chave de armazenamento inválida',
  CHAVE_COM_CONTEUDO_DIFERENTE: 'a chave já existe com outro conteúdo',
  ARQUIVO_AUSENTE: 'arquivo indisponível',
  LIMITE_BYTES_EXCEDIDO: 'o conteúdo excede o limite de bytes',
  LIMITE_OBRIGATORIO: 'informe o limite de bytes da gravação',
  INTEGRIDADE_DIVERGENTE: 'o SHA-256 do conteúdo não confere com o esperado',
  GRAVACAO_ABORTADA: 'gravação abortada',
  FONTE_INVALIDA: 'fonte de gravação inválida',
  ARMAZENAMENTO_FALHOU: 'falha no armazenamento de imagens',
};
const erro = (codigo) => Object.assign(new Error(MENSAGENS[codigo]), { codigo });

function chaveDe(entrada) {
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) throw erro('CHAVE_INVALIDA');
  const { escopo, empresaId, sha256, variante, formato } = entrada;
  let segmento;
  if (escopo === 'EMPRESA' && Number.isSafeInteger(empresaId) && empresaId >= 1 && empresaId <= EMPRESA_MAX) segmento = String(empresaId);
  else if (escopo === 'PADRAO' && empresaId === undefined) segmento = 'padrao';
  else throw erro('CHAVE_INVALIDA');
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw erro('CHAVE_INVALIDA');
  const extensao = typeof formato === 'string' && Object.hasOwn(EXTENSAO, formato) ? EXTENSAO[formato] : undefined;
  if (extensao === undefined) throw erro('CHAVE_INVALIDA');
  if (variante === 'mestre') return `${segmento}/${sha256}/mestre.${extensao}`;
  if ((variante === 'exibicao' || variante === 'miniatura') && extensao === 'webp') return `${segmento}/${sha256}/${variante}.webp`;
  throw erro('CHAVE_INVALIDA');
}

const validarChave = (chave) => {
  if (typeof chave !== 'string' || !CHAVE.test(chave)) throw erro('CHAVE_INVALIDA');
  return chave.split('/');
};

/** Erros do sistema de arquivos levam o caminho na mensagem: nunca saem; só o que a própria camada produziu é repassado. */
const traduzir = (falha) => {
  if (falha && typeof falha.codigo === 'string' && MENSAGENS[falha.codigo]) return falha;
  if (falha && (falha.code === 'ELOOP' || falha.code === 'ENOTDIR')) return erro('CHAVE_INVALIDA');
  return erro('ARMAZENAMENTO_FALHOU');
};

function criarArmazenamentoImagens({ diretorio } = {}) {
  if (typeof diretorio !== 'string' || diretorio.trim() === '') throw new TypeError('diretório de armazenamento obrigatório');
  if (diretorio.includes('\0')) throw new TypeError('diretório de armazenamento inválido');
  if (!path.isAbsolute(diretorio)) throw new TypeError('o diretório de armazenamento deve ser um caminho absoluto');
  const informado = path.resolve(diretorio);
  const existia = fs.existsSync(informado);
  fs.mkdirSync(informado, { recursive: true, mode: 0o700 });
  if (!existia) fs.chmodSync(informado, 0o700);
  const raiz = fs.realpathSync(informado);
  if (!fs.statSync(raiz).isDirectory()) throw new TypeError('o diretório de armazenamento deve ser um diretório');

  /** Estado de UM componente: false se ausente; true se é do tipo esperado; link simbólico ou tipo errado é recusado. */
  async function presente(caminho, diretorioEsperado) {
    let estado;
    try { estado = await fsp.lstat(caminho); } catch (falha) {
      if (falha.code === 'ENOENT') return false;
      throw traduzir(falha);
    }
    if (estado.isSymbolicLink() || (diretorioEsperado ? !estado.isDirectory() : !estado.isFile())) throw erro('CHAVE_INVALIDA');
    return true;
  }

  const pastasDe = (segmento, sha) => ({ empresa: path.join(raiz, segmento), hash: path.join(raiz, segmento, sha) });

  /** Confere os componentes existentes da chave e devolve o caminho do arquivo, ou null quando algum não existe. */
  async function localizar(chave) {
    const [segmento, sha, nome] = validarChave(chave);
    const { empresa, hash } = pastasDe(segmento, sha);
    if (!(await presente(empresa, true)) || !(await presente(hash, true))) return null;
    const arquivo = path.join(hash, nome);
    return (await presente(arquivo, false)) ? arquivo : null;
  }

  async function criarPasta(caminho) {
    try {
      await fsp.mkdir(caminho, { mode: 0o700 });
      await fsp.chmod(caminho, 0o700);
    } catch (falha) {
      if (falha.code !== 'EEXIST') throw falha;
    }
    if (!(await presente(caminho, true))) throw erro('CHAVE_INVALIDA');
  }

  function criarLeitor(fonte) {
    if (Buffer.isBuffer(fonte)) return { proximo: async () => ({ done: true, value: undefined }), blocos: [fonte], encerrar() {} };
    if (fonte && typeof fonte[Symbol.asyncIterator] === 'function') {
      // O erro da fonte pode chegar antes da primeira leitura: sem ouvinte, o Node o trataria como exceção não capturada.
      if (typeof fonte.on === 'function') fonte.on('error', () => {});
      const iterador = fonte[Symbol.asyncIterator]();
      return { proximo: () => iterador.next(), blocos: [], encerrar() { if (typeof fonte.destroy === 'function') fonte.destroy(); } };
    }
    throw erro('FONTE_INVALIDA');
  }

  async function sha256Do(arquivo) {
    const identificador = await fsp.open(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!(await identificador.stat()).isFile()) throw erro('CHAVE_INVALIDA');
      const hash = crypto.createHash('sha256');
      for await (const bloco of identificador.createReadStream({ autoClose: false })) hash.update(bloco);
      return hash.digest('hex');
    } finally { await identificador.close(); }
  }

  async function gravar(chave, fonte, { maxBytes, sha256Esperado, signal } = {}) {
    const [segmento, sha, nome] = validarChave(chave);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw erro('LIMITE_OBRIGATORIO');
    if (sha256Esperado !== undefined && (typeof sha256Esperado !== 'string' || !SHA256.test(sha256Esperado))) throw erro('INTEGRIDADE_DIVERGENTE');
    if (signal && signal.aborted) throw erro('GRAVACAO_ABORTADA');
    if (Buffer.isBuffer(fonte) && fonte.length > maxBytes) throw erro('LIMITE_BYTES_EXCEDIDO');
    const leitor = criarLeitor(fonte);
    const { empresa, hash: pastaHash } = pastasDe(segmento, sha);
    const destino = path.join(pastaHash, nome);
    let temporario = null;
    let identificador = null;
    let aoAbortar = null;
    try {
      for (let tentativa = 1; identificador === null; tentativa += 1) {
        await criarPasta(empresa);
        await criarPasta(pastaHash);
        temporario = path.join(pastaHash, `${nome}.${crypto.randomBytes(8).toString('hex')}.tmp`);
        try {
          identificador = await fsp.open(temporario, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        } catch (falha) {
          temporario = null;
          if (falha.code !== 'ENOENT' || tentativa >= TENTATIVAS_CRIACAO) throw falha;
        }
      }
      await identificador.chmod(0o600);

      const abortada = new Promise((_resolver, rejeitar) => {
        if (!signal) return;
        aoAbortar = () => rejeitar(erro('GRAVACAO_ABORTADA'));
        signal.addEventListener('abort', aoAbortar, { once: true });
      });
      abortada.catch(() => {});
      const hash = crypto.createHash('sha256');
      let total = 0;
      const gravarBloco = async (bloco) => {
        if (!(bloco instanceof Uint8Array)) throw erro('FONTE_INVALIDA');
        total += bloco.length;
        if (total > maxBytes) throw erro('LIMITE_BYTES_EXCEDIDO');
        hash.update(bloco);
        await identificador.writeFile(bloco);
      };
      for (const bloco of leitor.blocos) await gravarBloco(bloco);
      for (;;) {
        if (signal && signal.aborted) throw erro('GRAVACAO_ABORTADA');
        let passo;
        try { passo = await Promise.race([leitor.proximo(), abortada]); } catch (falha) {
          throw falha && falha.codigo === 'GRAVACAO_ABORTADA' ? falha : erro('GRAVACAO_ABORTADA');
        }
        if (passo.done) break;
        await gravarBloco(passo.value);
      }

      const calculado = hash.digest('hex');
      if (sha256Esperado !== undefined && sha256Esperado !== calculado) throw erro('INTEGRIDADE_DIVERGENTE');
      await identificador.sync();
      await identificador.close();
      identificador = null;

      let reaproveitado = false;
      try { await fsp.link(temporario, destino); } catch (falha) {
        if (falha.code !== 'EEXIST') throw falha;
        if ((await sha256Do(destino)) !== calculado) throw erro('CHAVE_COM_CONTEUDO_DIFERENTE');
        reaproveitado = true;
      }
      return { chave, bytes: total, sha256: calculado, reaproveitado };
    } catch (falha) {
      leitor.encerrar();
      throw traduzir(falha);
    } finally {
      if (aoAbortar) signal.removeEventListener('abort', aoAbortar);
      if (identificador) await identificador.close().catch(() => {});
      if (temporario) await fsp.rm(temporario, { force: true }).catch(() => {});
    }
  }

  async function abrir(chave) {
    try {
      const arquivo = await localizar(chave);
      if (arquivo === null) throw erro('ARQUIVO_AUSENTE');
      let fd;
      try { fd = await abrirDescritor(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (falha) {
        if (falha.code === 'ENOENT') throw erro('ARQUIVO_AUSENTE');
        throw falha;
      }
      try {
        if (!(await fstat(fd)).isFile()) throw erro('CHAVE_INVALIDA');
      } catch (falha) {
        fs.close(fd, () => {});
        throw falha;
      }
      return fs.createReadStream(null, { fd, autoClose: true });
    } catch (falha) { throw traduzir(falha); }
  }

  async function existe(chave) {
    try { return (await localizar(chave)) !== null; } catch (falha) { throw traduzir(falha); }
  }

  async function remover(chave) {
    try {
      const arquivo = await localizar(chave);
      if (arquivo === null) return;
      try { await fsp.unlink(arquivo); } catch (falha) { if (falha.code !== 'ENOENT') throw falha; }
    } catch (falha) { throw traduzir(falha); }
  }

  /** Apaga as variantes de UMA imagem (de uma empresa ou da biblioteca padrão); arquivos estranhos na pasta ficam. */
  async function removerVariantes(argumentos) {
    try {
      const [segmento, sha] = validarChave(chaveDe({ ...argumentos, variante: 'mestre', formato: 'PNG' }));
      const { empresa, hash } = pastasDe(segmento, sha);
      if (!(await presente(empresa, true)) || !(await presente(hash, true))) return;
      for (const nome of NOMES_POSSIVEIS) {
        const arquivo = path.join(hash, nome);
        if (!(await presente(arquivo, false))) continue;
        try { await fsp.unlink(arquivo); } catch (falha) { if (falha.code !== 'ENOENT') throw falha; }
      }
      await fsp.rmdir(hash).catch(() => {});
    } catch (falha) { throw traduzir(falha); }
  }

  async function listar(prefixo) {
    try {
      if (typeof prefixo !== 'string' || !PREFIXO.test(prefixo)) throw erro('CHAVE_INVALIDA');
      const pasta = path.join(raiz, prefixo);
      if (!(await presente(pasta, true))) return [];
      const chaves = [];
      for (const imagem of await fsp.readdir(pasta, { withFileTypes: true })) {
        if (!imagem.isDirectory() || !SHA256.test(imagem.name)) continue;
        let arquivos;
        try { arquivos = await fsp.readdir(path.join(pasta, imagem.name), { withFileTypes: true }); } catch (falha) {
          if (falha.code === 'ENOENT') continue;
          throw falha;
        }
        for (const arquivo of arquivos) if (arquivo.isFile() && NOME_VARIANTE.test(arquivo.name)) chaves.push(`${prefixo}/${imagem.name}/${arquivo.name}`);
      }
      return chaves.sort();
    } catch (falha) { throw traduzir(falha); }
  }

  return Object.freeze({ gravar, abrir, existe, remover, removerVariantes, listar, chaveDe });
}

module.exports = { criarArmazenamentoImagens, chaveDe };
