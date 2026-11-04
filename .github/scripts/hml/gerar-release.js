'use strict';

/**
 * Release de homologação: os dois pacotes do frontend (Portal do Cliente e
 * Painel Privado), cada um pelo seu empacotador e allowlist, com manifesto
 * SHA-256 verificável e um release.json que identifica commit, rótulo e se
 * o commit era a cabeça da main. Não transmite, não publica, não toca AWS.
 *
 * Layout da saída (diretório novo ou vazio):
 *   portal/                 pacote do cliente (allowlist.json)
 *   painel/                 pacote do Painel Privado (allowlist-painel.json)
 *   manifesto-portal.sha256 formato de `sha256sum -c`, caminhos relativos a portal/
 *   manifesto-painel.sha256 idem, relativos a painel/
 *   release.json            commit, rotulo, atual, geradoEm, contagens e hash dos manifestos
 *
 * Uso: node gerar-release.js --saida <dir> --commit <sha40> --rotulo <rotulo> --atual <true|false>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..', '..', '..');
const FRONTEND = path.join(RAIZ_REPO, 'frontend');
const SHA_COMPLETO = /^[0-9a-f]{40}$/;
const ROTULO = /^hml-\d{8}T\d{6}-[0-9a-f]{7}(-retroativo)?$/;

class RecusaRelease extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'RecusaRelease';
    this.codigo = codigo;
  }
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function linhasDoManifesto(manifesto) {
  return `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
}

function validarSaida(saida) {
  if (typeof saida !== 'string' || saida.trim() === '') throw new RecusaRelease('SAIDA_INVALIDA', 'informe --saida');
  const abs = path.resolve(saida);
  if (abs === RAIZ_REPO || abs.startsWith(RAIZ_REPO + path.sep)) {
    throw new RecusaRelease('SAIDA_INVALIDA', 'a release não pode ficar dentro do repositório');
  }
  if (fs.existsSync(abs) && (!fs.lstatSync(abs).isDirectory() || fs.readdirSync(abs).length > 0)) {
    throw new RecusaRelease('SAIDA_INVALIDA', `a saída precisa ser um diretório novo ou vazio: ${abs}`);
  }
  return abs;
}

function gerarRelease({ saida, commit, rotulo, atual, agora = Date.now(), frontend = FRONTEND }) {
  if (typeof commit !== 'string' || !SHA_COMPLETO.test(commit)) throw new RecusaRelease('COMMIT_INVALIDO', 'commit precisa ser SHA completo');
  if (typeof rotulo !== 'string' || !ROTULO.test(rotulo)) throw new RecusaRelease('ROTULO_INVALIDO', `rótulo fora do padrão: ${rotulo}`);
  if (typeof atual !== 'boolean') throw new RecusaRelease('FATO_INVALIDO', 'atual precisa ser booleano');
  if (atual === rotulo.endsWith('-retroativo')) throw new RecusaRelease('FATO_INVALIDO', 'rótulo retroativo e marca "atual" divergem');
  const destino = validarSaida(saida);

  const portal = require(path.join(frontend, 'publicacao', 'empacotar.js'));
  const painel = require(path.join(frontend, 'publicacao', 'empacotar-painel.js'));

  const criou = !fs.existsSync(destino);
  try {
    fs.mkdirSync(destino, { recursive: true });
    const resultadoPortal = portal.empacotar({ saida: path.join(destino, 'portal') });
    const manifestoPortal = {};
    for (const rel of resultadoPortal.arquivos) manifestoPortal[rel] = sha256(fs.readFileSync(path.join(destino, 'portal', ...rel.split('/'))));
    const resultadoPainel = painel.empacotar({ saida: path.join(destino, 'painel') });
    painel.verificarPacote(path.join(destino, 'painel'), { arquivos: resultadoPainel.arquivos, manifesto: resultadoPainel.manifesto });

    const textoPortal = linhasDoManifesto(manifestoPortal);
    const textoPainel = linhasDoManifesto(resultadoPainel.manifesto);
    fs.writeFileSync(path.join(destino, 'manifesto-portal.sha256'), textoPortal);
    fs.writeFileSync(path.join(destino, 'manifesto-painel.sha256'), textoPainel);

    const release = {
      commit,
      rotulo,
      atual,
      geradoEm: new Date(agora).toISOString(),
      portal: { arquivos: resultadoPortal.arquivos.length, manifestoSha256: sha256(textoPortal) },
      painel: { arquivos: resultadoPainel.arquivos.length, manifestoSha256: sha256(textoPainel) },
    };
    fs.writeFileSync(path.join(destino, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    return { saida: destino, release };
  } catch (erro) {
    try {
      if (criou) fs.rmSync(destino, { recursive: true, force: true });
      else for (const nome of fs.readdirSync(destino)) fs.rmSync(path.join(destino, nome), { recursive: true, force: true });
    } catch { /* a recusa original prevalece */ }
    throw erro;
  }
}

/** Reconfere uma release gerada: manifestos batem com os arquivos e com release.json. */
function verificarRelease(dir) {
  const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  for (const [nome, pasta] of [['portal', 'portal'], ['painel', 'painel']]) {
    const texto = fs.readFileSync(path.join(dir, `manifesto-${nome}.sha256`), 'utf8');
    if (sha256(texto) !== release[nome].manifestoSha256) throw new RecusaRelease('RELEASE_DIVERGENTE', `manifesto-${nome}.sha256 difere do release.json`);
    const linhas = texto.split('\n').filter(Boolean);
    if (linhas.length !== release[nome].arquivos) throw new RecusaRelease('RELEASE_DIVERGENTE', `${nome}: contagem difere do manifesto`);
    for (const linha of linhas) {
      const [hash, rel] = linha.split('  ');
      const abs = path.join(dir, pasta, ...rel.split('/'));
      if (!fs.lstatSync(abs).isFile() || sha256(fs.readFileSync(abs)) !== hash) throw new RecusaRelease('RELEASE_DIVERGENTE', `${nome}/${rel} difere do manifesto`);
    }
  }
  return release;
}

function lerArgumentos(argv) {
  const valores = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--(saida|commit|rotulo|atual)$/.test(argv[i]) || argv[i + 1] === undefined) throw new RecusaRelease('USO', 'uso: gerar-release.js --saida <dir> --commit <sha> --rotulo <rotulo> --atual <true|false>');
    valores[argv[i].slice(2)] = argv[i + 1];
  }
  if (valores.atual !== 'true' && valores.atual !== 'false') throw new RecusaRelease('USO', '--atual precisa ser true ou false');
  return { ...valores, atual: valores.atual === 'true' };
}

if (require.main === module) {
  try {
    const { release, saida } = gerarRelease(lerArgumentos(process.argv.slice(2)));
    verificarRelease(saida);
    console.log(`Release ${release.rotulo} gerada em ${saida}: portal ${release.portal.arquivos} arquivos, painel ${release.painel.arquivos} arquivos${release.atual ? '' : ' (RETROATIVA: não é a versão atual da main)'}.`);
  } catch (erro) {
    console.error(`Release recusada (${erro.codigo || 'ERRO'}): ${erro.message}`);
    process.exitCode = 1;
  }
}

module.exports = { gerarRelease, verificarRelease, linhasDoManifesto, RecusaRelease, ROTULO };
