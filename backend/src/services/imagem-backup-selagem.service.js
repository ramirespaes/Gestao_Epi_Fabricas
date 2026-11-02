'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { lerManifesto: lerManifestoV1 } = require('./imagem-backup-manifesto.service');
const { ehFaltaDeEspaco } = require('../utils/orcamento-de-bytes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-SELAGEM-ARTEFATOS-1): SELAGEM do manifesto numa ÁREA DE PREPARAÇÃO. Contrato PROVISÓRIO. Grava `manifesto.json` (bytes canônicos) e,
 * por último, `manifesto.sha256` (`<hex>  manifesto.json\n`), e sabe reler e conferir os dois. `manifesto.sha256` é só a MARCA de selagem do manifesto naquela área: NÃO prova durabilidade após
 * queda de energia, publicação do backup, integridade física do dump nem restauração, e nenhum resultado tem estado de recuperável.
 *
 * `criarSelagem({ operacoes? })` -> { selar({ area, resultado }), verificar({ area, esperado? }) }; `operacoesDoSistema()` = { abrirExclusivo(caminho) -> { escrever, sincronizar, fechar }, ligar,
 * remover, sincronizarDiretorio }. As operações são injetáveis só para simular falhas e observar a ordem.
 *
 * ESCRITA (por arquivo): temporário `<nome>.<aleatório>.tmp` criado com O_CREAT|O_EXCL|O_NOFOLLOW (0600) -> escrever -> sincronizar o ARQUIVO -> fechar -> `link` ao nome final (nunca sobrescreve:
 * EEXIST) -> remover o temporário. O manifesto vem antes do hash. A ÚLTIMA operação antes do sucesso é a sincronização do DIRETÓRIO. Nada de `rename` sobre destino existente.
 * PROPRIEDADE: só se remove o que esta operação comprovadamente criou: o dispositivo e o inode do temporário são registrados logo após a criação exclusiva, e o final ligado a ele tem o mesmo
 * inode. Antes de remover, o caminho é conferido de novo contra esse registro; se foi trocado, NÃO é removido. Falha de remoção ou impossibilidade de provar propriedade não é ocultada: o
 * resultado traz `falha.limpeza = 'INCOMPLETA'`. A conferência por caminho seguida de `unlink` não é atômica (sem `openat`): uma troca concorrente entre os dois passos não é excluída.
 *
 * LIMITES: `area` precisa vir de uma composição CONFIÁVEL (este módulo não autoriza diretórios escolhidos por usuários); `lstat`/`realpath` não são atômicos contra troca concorrente de diretórios
 * intermediários; `fsync` de diretório não é prova de durabilidade real (depende do sistema de arquivos e do dispositivo); o SHA-256 ao lado do manifesto não autentica (quem regrava os dois o forja);
 * um par manifesto+hash coerente só é aceito como PERTENCENTE a uma operação quando a identidade esperada é informada.
 */

const MANIFESTO = 'manifesto.json';
const HASH = 'manifesto.sha256';
const LIMITE_MANIFESTO = 64 * 1024 * 1024;
const LIMITE_HASH = 256;
const SHA256 = /^[0-9a-f]{64}$/;
const LINHA_HASH = /^([0-9a-f]{64}) {2}manifesto\.json\n$/;
const OPERACOES = ['abrirExclusivo', 'ligar', 'remover', 'sincronizarDiretorio'];

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

function operacoesDoSistema() {
  return Object.freeze({
    async abrirExclusivo(caminho) {
      const fh = await fsp.open(caminho, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      let fechado = false;
      try { await fh.chmod(0o600); } catch (falha) { fechado = true; await fh.close().catch(() => {}); throw falha; }
      return {
        escrever: (buffer) => fh.writeFile(buffer),
        sincronizar: () => fh.sync(),
        fechar: async () => { if (fechado) return; fechado = true; await fh.close(); },
      };
    },
    ligar: (origem, destino) => fsp.link(origem, destino),
    remover: (caminho) => fsp.unlink(caminho),
    async sincronizarDiretorio(caminho) {
      const fh = await fsp.open(caminho, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { await fh.sync(); } finally { await fh.close(); }
    },
  });
}

const falhaDe = (codigo, extra = {}) => Object.freeze({ ok: false, selado: false, falha: Object.freeze({ codigo, ...extra }) });
const falhaDeLeitura = (codigo, motivo) => Object.freeze({ ok: false, falha: Object.freeze(motivo === undefined ? { codigo } : { codigo, motivo }) });
const MOTIVO_DE_AUTENTICACAO = /^[A-Z_]{3,40}$/;

/** Área: caminho absoluto, canônico (sem `..`, NUL nem link simbólico em nenhum componente), diretório existente. */
async function areaValida(area) {
  if (typeof area !== 'string' || area === '' || area.includes('\0') || !path.isAbsolute(area)) return false;
  if (area.split(/[\\/]/).includes('..')) return false;
  const resolvida = path.resolve(area);
  try {
    const estado = await fsp.lstat(resolvida);
    if (estado.isSymbolicLink() || !estado.isDirectory()) return false;
    return (await fsp.realpath(resolvida)) === resolvida;
  } catch {
    return false;
  }
}

const existe = async (caminho) => {
  try { await fsp.lstat(caminho); return true; } catch (falha) {
    if (falha.code === 'ENOENT') return false;
    throw falha;
  }
};

function criarSelagem(opcoes = {}) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções da selagem inválidas');
  const injetadas = opcoes.operacoes;
  if (injetadas !== undefined && (!ehObjeto(injetadas) || OPERACOES.some((n) => typeof injetadas[n] !== 'function'))) throw new TypeError('operações da selagem inválidas');
  const ops = injetadas === undefined ? operacoesDoSistema() : Object.freeze(Object.fromEntries(OPERACOES.map((n) => [n, injetadas[n]])));
  // Leitor do manifesto: por padrão o V1 (sem autenticação). O leitor V2 autenticado é injetado por quem possui a fonte de chaves; um leitor só aceita o formato que ele mesmo valida.
  if (opcoes.leitor !== undefined && typeof opcoes.leitor !== 'function') throw new TypeError('leitor da selagem inválido');
  const lerManifesto = opcoes.leitor === undefined ? lerManifestoV1 : opcoes.leitor;

  async function selar(entrada) {
    let resultadoValido;
    let area;
    try {
      if (!ehObjeto(entrada)) return falhaDe('ENTRADA_INVALIDA');
      area = entrada.area;
      const resultado = entrada.resultado;
      try {
        if (!ehObjeto(resultado)) return falhaDe('ENTRADA_INVALIDA');
        const bytes = resultado.bytes;
        const sha256 = resultado.sha256;
        if (!(bytes instanceof Uint8Array)) return falhaDe('ENTRADA_INVALIDA');
        const copia = Buffer.from(bytes);
        lerManifesto({ bytes: copia, sha256 });
        resultadoValido = { bytes: copia, sha256 };
      } catch {
        return falhaDe('ENTRADA_INVALIDA');
      }
      if (!(await areaValida(area))) return falhaDe('AREA_INVALIDA');
      const caminhos = { [MANIFESTO]: path.join(area, MANIFESTO), [HASH]: path.join(area, HASH) };
      if ((await existe(caminhos[MANIFESTO])) || (await existe(caminhos[HASH]))) return falhaDe('DESTINO_EXISTENTE');
    } catch {
      return falhaDe('ESCRITA_FALHOU');
    }

    const caminhos = { [MANIFESTO]: path.join(area, MANIFESTO), [HASH]: path.join(area, HASH) };
    const proprios = []; // { caminho, dev, ino }: só o que esta operação comprovadamente criou
    let limpezaIncompleta = false;
    let aberto = null;

    async function registrar(caminho) {
      const estado = await fsp.lstat(caminho);
      if (!estado.isFile()) throw new Error('registro');
      const item = { caminho, dev: estado.dev, ino: estado.ino };
      proprios.push(item);
      return item;
    }
    async function removerProprio(item) {
      let estado;
      try { estado = await fsp.lstat(item.caminho); } catch (falha) {
        if (falha.code === 'ENOENT') return;
        limpezaIncompleta = true;
        return;
      }
      if (estado.isSymbolicLink() || !estado.isFile() || estado.dev !== item.dev || estado.ino !== item.ino) return; // não é mais o nosso: nunca remover
      try { await ops.remover(item.caminho); } catch { limpezaIncompleta = true; }
    }

    async function publicar(nome, conteudo) {
      const temporario = path.join(area, `${nome}.${crypto.randomBytes(8).toString('hex')}.tmp`);
      aberto = await ops.abrirExclusivo(temporario);
      const doTemporario = await registrar(temporario);
      await aberto.escrever(conteudo);
      await aberto.sincronizar();
      await aberto.fechar();
      aberto = null;
      await ops.ligar(temporario, caminhos[nome]);
      proprios.push({ caminho: caminhos[nome], dev: doTemporario.dev, ino: doTemporario.ino }); // mesmo inode do temporário que criamos
      await ops.remover(temporario);
      proprios.splice(proprios.indexOf(doTemporario), 1);
    }

    // P3 (opcional): `entrada.sinal` = pedido de cancelamento COOPERATIVO, conferido só em pontos seguros — antes de criar qualquer arquivo e entre o manifesto e a marca de selagem. Uma operação de E/S em andamento nunca é interrompida no meio; o que esta chamada criou é removido pela regra de propriedade de sempre.
    let sinal = null;
    try { if (Object.hasOwn(entrada, 'sinal') && ehObjeto(entrada.sinal) && typeof entrada.sinal.aborted === 'boolean') sinal = entrada.sinal; } catch { sinal = null; }
    const pontoSeguro = () => { if (sinal !== null && sinal.aborted === true) { const f = new Error('selagem cancelada'); f.code = 'SELAGEM_CANCELADA'; throw f; } };

    try {
      pontoSeguro();
      await publicar(MANIFESTO, resultadoValido.bytes);
      pontoSeguro();
      await publicar(HASH, Buffer.from(`${resultadoValido.sha256}  ${MANIFESTO}\n`, 'utf8'));
      await ops.sincronizarDiretorio(area);
      return Object.freeze({ ok: true, selado: true, sha256: resultadoValido.sha256, arquivos: Object.freeze([MANIFESTO, HASH]) });
    } catch (falha) {
      const codigo = falha && falha.code === 'SELAGEM_CANCELADA' ? 'CANCELADO' : falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU'; // P4: falta de espaço/cota é distinguida; a limpeza e os parciais seguem a regra de sempre
      if (aberto) { try { await aberto.fechar(); } catch { /* o descritor pode já estar fechado */ } }
      for (const item of [...proprios].reverse()) await removerProprio(item);
      return falhaDe(codigo, limpezaIncompleta ? { limpeza: 'INCOMPLETA' } : {});
    }
  }

  /** Lê um arquivo regular sem seguir link simbólico no componente final. */
  async function lerArquivo(caminho, limite) {
    let fh;
    try {
      fh = await fsp.open(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (falha) {
      if (falha.code === 'ENOENT') return { ausente: true };
      return { invalido: true };
    }
    try {
      const estado = await fh.stat();
      if (!estado.isFile() || estado.size > limite) return { invalido: true };
      const dados = await fh.readFile();
      if (dados.length > limite) return { invalido: true };
      return { dados };
    } catch {
      return { invalido: true };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function verificar(entrada) {
    try {
      if (!ehObjeto(entrada)) return falhaDeLeitura('ENTRADA_INVALIDA');
      const area = entrada.area;
      const esperado = Object.hasOwn(entrada, 'esperado') ? entrada.esperado : undefined;
      if (!(await areaValida(area))) return falhaDeLeitura('AREA_INVALIDA');
      if (esperado !== undefined) {
        if (!ehObjeto(esperado) || !chavesExatas(esperado, ['conjuntoId', 'sha256Manifesto']) || typeof esperado.conjuntoId !== 'string' || typeof esperado.sha256Manifesto !== 'string' || !SHA256.test(esperado.sha256Manifesto)) {
          return falhaDeLeitura('ENTRADA_INVALIDA');
        }
      }
      const manifesto = await lerArquivo(path.join(area, MANIFESTO), LIMITE_MANIFESTO);
      if (manifesto.ausente) return falhaDeLeitura('MANIFESTO_AUSENTE');
      if (manifesto.invalido) return falhaDeLeitura('ARQUIVO_INVALIDO');
      const hash = await lerArquivo(path.join(area, HASH), LIMITE_HASH);
      if (hash.ausente) return falhaDeLeitura('HASH_AUSENTE');
      if (hash.invalido) return falhaDeLeitura('ARQUIVO_INVALIDO');
      const linha = LINHA_HASH.exec(hash.dados.toString('latin1'));
      if (linha === null) return falhaDeLeitura('HASH_INVALIDO');
      let lido;
      try { lido = lerManifesto({ bytes: manifesto.dados, sha256: linha[1] }); } catch (falha) {
        return falhaDeLeitura('MANIFESTO_INVALIDO', falha && typeof falha.motivo === 'string' && MOTIVO_DE_AUTENTICACAO.test(falha.motivo) ? falha.motivo : undefined);
      }
      if (esperado !== undefined && (lido.identidade.conjuntoId !== esperado.conjuntoId || lido.identidade.sha256Manifesto !== esperado.sha256Manifesto)) {
        return falhaDeLeitura('IDENTIDADE_DIVERGENTE');
      }
      return Object.freeze({ ok: true, verificado: true, sha256: lido.sha256, manifesto: lido.manifesto, identidade: lido.identidade, ...(lido.autenticacao === undefined ? {} : { autenticacao: lido.autenticacao }) });
    } catch {
      return falhaDeLeitura('LEITURA_FALHOU');
    }
  }

  return Object.freeze({ selar, verificar });
}

module.exports = { criarSelagem, operacoesDoSistema };
