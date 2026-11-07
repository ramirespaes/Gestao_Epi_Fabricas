'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarLeitorL2, LIMITES } = require('./backup-fontes-manifesto-l2.service');
const { ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');

/**
 * D-ORF-6, L2 (Bloco C): LEITOR REAL DO PACOTE PUBLICADO para a porta `lerPacote` do adaptador de produção (`backup-executor-producao-l2`). Até aqui essa porta só existia injetada
 * nos testes; este módulo a implementa SOMENTE com leitura: nenhuma escrita, remoção, processo, ambiente ou rede. Reutiliza o leitor L2 já aprovado (P5), que autentica o manifesto
 * (HMAC no domínio L2, forma canônica, estrutura completa) e impõe `layoutMinimo: 2` (um L1 autêntico no lugar do L2 é recusado).
 *
 * `criarLeitorDePacote({ fonteDeChaves, raizPublicados, catalogoAtual?, tamanhoMaximo? })` -> `{ lerPacote({ dir, nome }) }`.
 *  - `dir` tem de ser EXATAMENTE `<raizPublicados>/<nome>` (nome no formato da preparação); o caminho real do diretório tem de coincidir com o pedido (nenhum link simbólico em
 *    nenhum componente) e ser um diretório, não um link;
 *  - `manifesto.sha256` (selo, `<hex>  manifesto.json\n`) e `manifesto.json` são abertos com `O_RDONLY | O_NOFOLLOW`, precisam ser arquivos regulares com UM único nome (sem hard link),
 *    dentro do limite de bytes, e o caminho tem de apontar para o MESMO inode antes e depois da leitura (tamanho e mtime iguais): uma substituição concorrente é recusada;
 *  - o hash declarado no selo é entregue ao leitor L2, que o confere contra os bytes antes de qualquer confiança; o resultado é o `lido` do leitor (com `identidade.sha256Manifesto`).
 * Qualquer desvio lança erro com `code: 'PACOTE_ILEGIVEL'` e `motivo` fixo (nunca caminho, conteúdo ou causa); o adaptador de produção o traduz para `PRODUCAO_PACOTE_ILEGIVEL`.
 * O leitor NÃO verifica os demais arquivos do pacote: isso continua com `verificarPacoteL2`, chamado pela cifra antes de publicar.
 */

const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANIFESTO = 'manifesto.json';
const SELO = 'manifesto.sha256';
const FORMATO_DO_SELO = /^([0-9a-f]{64})  manifesto\.json\n$/;
const TAMANHO_DO_SELO = 64 + 2 + MANIFESTO.length + 1;
const MOTIVO = /^[A-Z0-9_]{1,64}$/;
const OPCOES = Object.freeze(['fonteDeChaves', 'raizPublicados', 'catalogoAtual', 'tamanhoMaximo']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.endsWith('/') && !c.includes('\0');
const configuracaoInvalida = () => Object.assign(new TypeError('leitor de pacote inválido'), { code: 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA' });
const fixo = (m) => (typeof m === 'string' && MOTIVO.test(m) ? m : 'INDETERMINADO');
const recusa = (motivo) => Object.assign(new Error('pacote ilegível'), { code: 'PACOTE_ILEGIVEL', motivo: fixo(motivo) });
const mesmoInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Lê um arquivo regular inteiro, sem seguir link, e exige que o caminho continue apontando para o mesmo inode (mesmo tamanho e mtime) ao fim da leitura. */
async function lerArquivoEstavel(caminho, { minimo, maximo }) {
  let fh;
  try { fh = await fsp.open(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw recusa('ARQUIVO_INACESSIVEL'); }
  try {
    const antes = await fh.stat();
    if (!antes.isFile() || antes.nlink !== 1) throw recusa('ARQUIVO_INVALIDO');
    if (antes.size > maximo) throw recusa('LIMITE_EXCEDIDO');
    if (antes.size < minimo) throw recusa('ARQUIVO_INVALIDO');
    const bytes = Buffer.alloc(antes.size);
    let lidos = 0;
    while (lidos < antes.size) {
      const { bytesRead } = await fh.read(bytes, lidos, antes.size - lidos, lidos);
      if (bytesRead === 0) throw recusa('LEITURA_CURTA');
      lidos += bytesRead;
    }
    const depois = await fh.stat();
    let noCaminho;
    try { noCaminho = await fsp.lstat(caminho); } catch { throw recusa('ARQUIVO_SUBSTITUIDO'); }
    if (!mesmoInode(antes, depois) || depois.size !== antes.size || depois.mtimeMs !== antes.mtimeMs || !noCaminho.isFile() || !mesmoInode(antes, noCaminho)) throw recusa('ARQUIVO_SUBSTITUIDO');
    return bytes;
  } finally {
    await fh.close().catch(() => {});
  }
}

function criarLeitorDePacote(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !('fonteDeChaves' in opcoes) || !('raizPublicados' in opcoes)) throw configuracaoInvalida();
  const { fonteDeChaves, raizPublicados, catalogoAtual } = opcoes;
  const tamanhoMaximo = opcoes.tamanhoMaximo === undefined ? LIMITES.bytesDoManifesto : opcoes.tamanhoMaximo;
  if (!ehFonteDeChaves(fonteDeChaves) || !caminhoCanonico(raizPublicados)) throw configuracaoInvalida();
  if (!Number.isSafeInteger(tamanhoMaximo) || tamanhoMaximo < 1 || tamanhoMaximo > LIMITES.bytesDoManifesto) throw configuracaoInvalida();
  let ler;
  try { ler = criarLeitorL2({ fonteDeChaves, layoutMinimo: 2, ...(catalogoAtual === undefined ? {} : { catalogoAtual }) }); } catch { throw configuracaoInvalida(); }

  async function lerPacote(pedido) {
    if (!ehObjeto(pedido) || !Reflect.ownKeys(pedido).every((k) => k === 'dir' || k === 'nome') || typeof pedido.dir !== 'string' || typeof pedido.nome !== 'string' || !NOME.test(pedido.nome)) throw recusa('PEDIDO_INVALIDO');
    const dir = path.join(raizPublicados, pedido.nome);
    if (pedido.dir !== dir) throw recusa('PACOTE_FORA_DA_RAIZ');
    let real;
    let st;
    try { [real, st] = await Promise.all([fsp.realpath(dir), fsp.lstat(dir)]); } catch { throw recusa('PACOTE_INACESSIVEL'); }
    if (real !== dir || !st.isDirectory()) throw recusa('CAMINHO_NAO_CANONICO');
    const selo = (await lerArquivoEstavel(path.join(dir, SELO), { minimo: TAMANHO_DO_SELO, maximo: TAMANHO_DO_SELO })).toString('utf8').match(FORMATO_DO_SELO);
    if (selo === null) throw recusa('SELO_INVALIDO');
    const bytes = await lerArquivoEstavel(path.join(dir, MANIFESTO), { minimo: 1, maximo: tamanhoMaximo });
    try {
      return ler({ bytes, sha256: selo[1] });
    } catch (e) {
      throw recusa(ehObjeto(e) ? e.motivo : undefined);
    }
  }

  return Object.freeze({ lerPacote });
}

module.exports = { criarLeitorDePacote };
