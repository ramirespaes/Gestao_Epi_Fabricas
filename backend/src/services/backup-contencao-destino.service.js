'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { ehDestinoValidado, contem } = require('./imagem-backup-destinos.service');
const { AMBIENTES } = require('./backup-armazenamento-duravel-fichas.service');

/**
 * D-ORF-6, R-D45 (D-F4): GUARDA DE CONTENÇÃO de um destino local NOVO dentro de uma raiz AUTORIZADA, para a decifragem da entrada 47 (que cria pastas e arquivos por conta própria).
 * Somente LEITURA do sistema de arquivos (`lstat`, `realpath`) e consulta ao validador oficial de destinos locais (`criarValidadorDeDestinos`, registro `DESTINOS_AUTORIZADOS`):
 * não escreve, não remove, não lê ambiente.
 *
 * Contrato (usado por `decifrarContainer` via a opção `contencao`):
 *  - `conferir(dir)`: chamada ANTES de criar uma subpasta, abrir um temporário ou ligar um arquivo dentro de `dir`. Verdadeira só se (1) a raiz continua EXATAMENTE a autorizada
 *    (validador oficial, físico e sem cache: caminho canônico, sem link, mesma identidade dev/ino, dono, modo sem acesso de grupo e outros) e (2) `dir` é a raiz, ou é o destino ou
 *    uma pasta dentro dele CRIADA e registrada nesta operação, e cada pasta da cadeia, de `dir` até o destino, ainda é o MESMO diretório real (identidade dev/ino, sem link,
 *    do usuário do processo, caminho real igual ao caminho). Pasta desconhecida nunca confere (falha fechada).
 *  - `registrar(dir)`: chamada logo DEPOIS de uma pasta ser criada. Só aceita o destino (filho direto da raiz) ou filha de pasta já registrada e ainda intacta, que seja diretório real
 *    do usuário do processo; guarda a identidade para as conferências seguintes.
 * Qualquer exceção, resposta fora do contrato ou validador forjado resulta em `false`. Limite honesto: Node não oferece operações relativas a descritor de diretório; entre
 * `conferir` e a chamada de sistema que se segue resta uma janela mínima, que só quem já escreve na raiz 0700 do mesmo usuário (ou o administrador do sistema) consegue explorar.
 */

const OPCOES = Object.freeze(['validadorDeDestinos', 'destinoLocalId', 'raiz', 'destino']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const configuracaoInvalida = () => Object.assign(new TypeError('configuração da contenção do destino inválida'), { code: 'CONFIGURACAO_INVALIDA' });

function criarContencaoDeDestino(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, OPCOES)) throw configuracaoInvalida();
  const { validadorDeDestinos: validador, destinoLocalId, raiz, destino } = opcoes;
  if (!ehObjeto(validador) || typeof validador.validar !== 'function' || !AMBIENTES.includes(validador.ambiente) || typeof destinoLocalId !== 'string') throw configuracaoInvalida();
  if (!caminhoCanonico(raiz) || !caminhoCanonico(destino) || path.dirname(destino) !== raiz) throw configuracaoInvalida();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const identidades = new Map();

  /** A raiz continua exatamente a autorizada? Devolve a validação oficial ou `null`. */
  function raizAutorizada() {
    let v;
    try { v = validador.validar({ destinoId: destinoLocalId, raiz }); } catch { return null; }
    return ehDestinoValidado(v) && v.autorizado === true && v.ambiente === validador.ambiente && v.raiz === raiz ? v : null;
  }
  /** A pasta registrada ainda é o mesmo diretório real, do usuário do processo, sem link e com o caminho real igual ao caminho? */
  async function pastaIntacta(dir) {
    const esperado = identidades.get(dir);
    if (esperado === undefined) return false;
    try {
      const st = await fsp.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== esperado.dev || st.ino !== esperado.ino || (uid !== null && st.uid !== uid)) return false;
      return (await fsp.realpath(dir)) === dir;
    } catch { return false; }
  }
  const dentroDoDestino = (dir) => dir === destino || dir.startsWith(`${destino}/`);

  async function conferir(dir) {
    const v = raizAutorizada();
    if (v === null || typeof dir !== 'string') return false;
    if (dir === raiz) return true;
    if (!contem(v, dir) || !dentroDoDestino(dir)) return false;
    for (let atual = dir; ; atual = path.dirname(atual)) {
      if (!(await pastaIntacta(atual))) return false;
      if (atual === destino) return true;
    }
  }

  async function registrar(dir) {
    const v = raizAutorizada();
    if (v === null || typeof dir !== 'string' || !contem(v, dir) || !dentroDoDestino(dir)) return false;
    if (dir !== destino && !(await conferir(path.dirname(dir)))) return false;
    try {
      const st = await fsp.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid) || (await fsp.realpath(dir)) !== dir) return false;
      identidades.set(dir, { dev: st.dev, ino: st.ino });
      return true;
    } catch { return false; }
  }

  return Object.freeze({ conferir, registrar });
}

module.exports = { criarContencaoDeDestino };
