'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): VALIDAÇÃO OPERACIONAL DOS DESTINOS de armazenamento de backups. Só LEITURA do sistema de arquivos (lstat, realpath, access): nenhum diretório é criado, nenhuma permissão é alterada.
 *
 * AUTORIZAÇÃO: vem de uma lista fechada neste código, por ambiente (`DESTINOS_AUTORIZADOS`, HOMOLOGACAO e PRODUCAO), hoje VAZIA (decisão do responsável). Cada destino autorizado é `{ id, raiz, identidade: { dev, ino } }`. Um objeto do chamador nunca autoriza: a lista só pode ser
 * substituída em NODE_ENV=test, e a validação resultante carrega a origem TESTE_CONTROLADO (nunca OPERACIONAL, que só nasce da lista do código). HOMOLOGACAO e PRODUCAO não podem se sobrepor (uma raiz dentro da outra, ou igual).
 *
 * VALIDAÇÃO FÍSICA (cada chamada, nada em cache): destino conhecido no ambiente pedido; a raiz informada é IGUAL à autorizada (caminho absoluto, normalizado, sem `..`); nenhum componente é link simbólico (realpath = caminho); é diretório; `dev`/`ino` iguais à identidade autorizada (um diretório
 * diferente no mesmo caminho é recusado); dono = usuário do processo; permissão exata sem acesso de grupo/outros (`mode & 0o077 === 0`); leitura, escrita e travessia permitidas ao processo. Falhas devolvem SÓ um código fixo, o id e o ambiente: nunca caminho, dono, modo nem segredo.
 *
 * Sobrescrita: `verificarNomeLivre` recusa nome inválido ou já existente (lstat, sem seguir link). `contem` recusa qualquer caminho fora da raiz validada.
 * LIMITES: validar a pasta não prova durabilidade nem que NINGUÉM mais escreve nela (ver o módulo de escritores); gravação local não é persistência em nuvem (ver o módulo de durabilidade).
 */

const ID_DESTINO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AMBIENTES = Object.freeze(['HOMOLOGACAO', 'PRODUCAO']);
const DESTINOS_AUTORIZADOS = Object.freeze({ HOMOLOGACAO: Object.freeze([]), PRODUCAO: Object.freeze([]) });
const validacoesProduzidas = new WeakSet();

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração de destinos inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const caminhoCanonico = (p) => typeof p === 'string' && p.length > 1 && p.length <= 1024 && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/') && !p.split('/').includes('..') && !/[\0]/.test(p);
const dentro = (pai, filho) => filho === pai || filho.startsWith(`${pai}/`);

function validarRegistro(registro) {
  if (!ehObjeto(registro) || !chavesExatas(registro, AMBIENTES)) throw configuracaoInvalida();
  const ids = new Set();
  const todos = [];
  for (const ambiente of AMBIENTES) {
    if (!Array.isArray(registro[ambiente])) throw configuracaoInvalida();
    for (const d of registro[ambiente]) {
      if (!ehObjeto(d) || !chavesExatas(d, ['id', 'raiz', 'identidade']) || typeof d.id !== 'string' || !ID_DESTINO.test(d.id) || ids.has(d.id) || !caminhoCanonico(d.raiz)) throw configuracaoInvalida();
      if (!ehObjeto(d.identidade) || !chavesExatas(d.identidade, ['dev', 'ino']) || !Number.isSafeInteger(d.identidade.dev) || !Number.isSafeInteger(d.identidade.ino) || d.identidade.ino <= 0) throw configuracaoInvalida();
      ids.add(d.id);
      todos.push({ ambiente, raiz: d.raiz });
    }
  }
  for (const a of todos) for (const b of todos) if (a !== b && a.ambiente !== b.ambiente && (dentro(a.raiz, b.raiz) || dentro(b.raiz, a.raiz))) throw configuracaoInvalida();
  for (const a of todos) for (const b of todos) if (a !== b && a.raiz === b.raiz) throw configuracaoInvalida();
}

/** `criarValidadorDeDestinos({ ambiente })` usa a lista do código; `{ ambiente, registro }` (lista de teste) só existe em NODE_ENV=test e nunca gera origem OPERACIONAL. */
function criarValidadorDeDestinos(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['ambiente', 'registro'].includes(k)) || !Reflect.ownKeys(opcoes).includes('ambiente')) throw configuracaoInvalida();
  const { ambiente } = opcoes;
  if (typeof ambiente !== 'string' || !AMBIENTES.includes(ambiente)) throw configuracaoInvalida();
  const deTeste = Object.hasOwn(opcoes, 'registro');
  if (deTeste && process.env.NODE_ENV !== 'test') throw configuracaoInvalida();
  const registro = deTeste ? opcoes.registro : DESTINOS_AUTORIZADOS;
  validarRegistro(registro);
  const origem = deTeste ? 'TESTE_CONTROLADO' : 'OPERACIONAL';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  const recusa = (motivo, destinoId) => Object.freeze({ autorizado: false, motivo, destinoId: typeof destinoId === 'string' && ID_DESTINO.test(destinoId) ? destinoId : null, ambiente });

  function validar(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['destinoId', 'raiz'])) throw configuracaoInvalida();
    const { destinoId, raiz } = pedido;
    const entrada = registro[ambiente].find((d) => d.id === destinoId);
    if (entrada === undefined) return recusa('DESTINO_NAO_AUTORIZADO', destinoId);
    if (raiz !== entrada.raiz || !caminhoCanonico(raiz)) return recusa('RAIZ_DIFERENTE_DA_AUTORIZADA', destinoId);
    let st;
    try {
      st = fs.lstatSync(raiz);
      if (st.isSymbolicLink()) return recusa('LINK_SIMBOLICO', destinoId);
      if (fs.realpathSync(raiz) !== raiz) return recusa('LINK_SIMBOLICO_NO_CAMINHO', destinoId);
    } catch { return recusa('DESTINO_INACESSIVEL', destinoId); }
    if (!st.isDirectory()) return recusa('NAO_E_DIRETORIO', destinoId);
    if (st.dev !== entrada.identidade.dev || st.ino !== entrada.identidade.ino) return recusa('IDENTIDADE_DIVERGENTE', destinoId);
    if (uid !== null && st.uid !== uid) return recusa('DONO_DIVERGENTE', destinoId);
    if ((st.mode & 0o077) !== 0) return recusa('PERMISSAO_EXCESSIVA', destinoId);
    try { fs.accessSync(raiz, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); } catch { return recusa('PERMISSAO_INSUFICIENTE', destinoId); }
    const validacao = Object.freeze({ autorizado: true, motivo: null, destinoId, ambiente, origem, raiz });
    validacoesProduzidas.add(validacao);
    return validacao;
  }

  return Object.freeze({ ambiente, origem, validar });
}

const ehDestinoValidado = (v) => v !== null && typeof v === 'object' && validacoesProduzidas.has(v);

/** Destino validado + nome novo: recusa nome inválido ou existente (sem seguir link). Nunca cria nada. */
function verificarNomeLivre(validacao, nome) {
  if (!ehDestinoValidado(validacao)) return Object.freeze({ livre: false, motivo: 'DESTINO_NAO_VALIDADO' });
  if (typeof nome !== 'string' || !NOME.test(nome)) return Object.freeze({ livre: false, motivo: 'NOME_INVALIDO' });
  try {
    fs.lstatSync(path.join(validacao.raiz, nome));
    return Object.freeze({ livre: false, motivo: 'NOME_EM_USO' });
  } catch (falha) {
    return falha && falha.code === 'ENOENT' ? Object.freeze({ livre: true, motivo: null }) : Object.freeze({ livre: false, motivo: 'DESTINO_INACESSIVEL' });
  }
}

/** O caminho (resolvido lexicalmente) está dentro da raiz validada? Nunca true para a própria raiz, `..` ou outra raiz com o mesmo prefixo. */
function contem(validacao, caminho) {
  if (!ehDestinoValidado(validacao) || typeof caminho !== 'string' || /\0/.test(caminho) || !path.isAbsolute(caminho)) return false;
  const resolvido = path.resolve(caminho);
  return resolvido !== validacao.raiz && resolvido.startsWith(`${validacao.raiz}/`);
}

module.exports = { criarValidadorDeDestinos, ehDestinoValidado, verificarNomeLivre, contem, DESTINOS_AUTORIZADOS, AMBIENTES };
