'use strict';

/**
 * Pacote do BACKEND por allowlist explícita (deploy/hml/allowlist-backend.json).
 *
 * Leva só src/, scripts/, migrations/ (com o checksums.json) e package.json /
 * package-lock.json. Nunca leva test/, docs/, .env*, node_modules nem segredos.
 * As dependências são instaladas no destino a partir do lockfile; este pacote
 * não carrega node_modules.
 *
 * Fail-closed, nesta ordem, ANTES de escrever qualquer arquivo:
 *   1. item desconhecido na raiz, link simbólico, duplicata do Finder;
 *   2. arquivo de segredo por nome e arquivo fora da regra de raiz/extensão;
 *   3. arquivo exigido ausente e arquivo acima do limite de tamanho;
 *   4. segredo no conteúdo (a mensagem cita arquivo, linha e regra, nunca o valor);
 *   5. package.json (engines, sem hooks de instalação), lockfile (v3, origem npm,
 *      integridade) e migrations iguais ao checksums.json;
 *   6. saída nova ou vazia, fora do backend.
 * Depois da cópia, o pacote é conferido contra o manifesto SHA-256; qualquer
 * divergência apaga só o que este módulo escreveu.
 *
 * Uso: node deploy/hml/empacotar-backend.js --saida <dir> --commit <sha40> --rotulo <rotulo> --atual <true|false>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const RAIZ_BACKEND = path.join(RAIZ_REPO, 'backend');
const ARQUIVO_ALLOWLIST = path.join(__dirname, 'allowlist-backend.json');
const ARQUIVO_CONTRATOS = path.join(__dirname, 'contratos-persistentes.json');
const LIMITE_PADRAO = 5 * 1024 * 1024;
const SHA_COMPLETO = /^[0-9a-f]{40}$/;
const ROTULO = /^hml-\d{8}T\d{6}-[0-9a-f]{7}(-retroativo)?$/;
const OBRIGATORIOS = ['package.json', 'package-lock.json', 'migrations/checksums.json', 'src/server.js', 'scripts/guarda-inicializacao.js'];
const IGNORADOS_NA_RAIZ = new Set(['node_modules', 'test', 'docs', 'coverage', '.gitignore', '.env.example']);
const ENV_NA_RAIZ = /^\.env(\..+)?$/;
const DUPLICATA_FINDER = /^.+ \d+(\.[^ ]+)?$/;
const HOOKS_DE_INSTALACAO = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack'];
const NOME_DE_CONTRATO = /^[a-z][a-z0-9-]*$/;
// Sem distinção de caixa: Credentials.json, SECRETS.YAML, KEY.PEM e .ENV são tão suspeitos quanto as formas minúsculas.
const NOMES_DE_SEGREDO = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|crt|cer|der|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|\.npmrc|\.netrc|\.pgpass)(\..+)?$/i,
  /^secrets?\.(json|ya?ml|env|txt)$/i,
];
const EXTENSOES_COM_TEXTO = new Set(['.js', '.sql', '.json']);
const REGRAS_DE_SEGREDO = [
  ['CHAVE_PRIVADA', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/],
  ['AWS_SECRET', /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/i],
  ['TOKEN_GITHUB', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['TOKEN_SLACK', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['URL_COM_CREDENCIAL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@[^\s/'"`]+/i],
];
// Chaves de teste públicas do Turnstile (documentadas pela Cloudflare: aprova, reprova, token já usado).
// Guardadas por hash e comparadas por valor exato; qualquer outro literal continua sendo recusado.
const VALORES_PUBLICOS_CONHECIDOS = new Set([
  'fb8f35129df87662c650ada12fd614f1b58dce4a37fdd7589ba3a6b9a78c0aae',
  '1e3e58656012d861e23deae64f177673d7b86a9c55fe1d5d10b94e3c9755d168',
  '841b4f5b0b34e19ada74f47a88831efbb909008ceea4430d61449c1874923f83',
]);
// Sem prefixo repetido antes da palavra-chave: o custo é linear no tamanho da linha. O limite abaixo
// continua valendo como segunda barreira contra entrada patológica (bundle minificado em uma linha).
const ATRIBUICAO_LITERAL = /(?:secret|password|passwd|passphrase|senha|api_?key|token|private_?key|credential|auth_?key|access_?key|signing_?key|pwd)[A-Za-z0-9_]*['"]?\s*[:=]\s*(['"`])([^'"`\s]{6,})\1/gi;
const LIMITE_LINHA = 10000;
// Constantes e caminhos de campo de código (portal_recuperacao_senha, SENHA_CURTA, body.senhaProvisoria, MFA_TOTP_KEY_V1)
// não são segredos, nem nomes curtos de cabeçalho (x-token). Frases longas com hífen continuam suspeitas.
const IDENTIFICADOR_DE_CODIGO = /^[A-Za-z]+(?:[._](?:[A-Za-z]+|[Vv]\d{1,2}))+$/;
const NOME_DE_CABECALHO = /^[a-z]+(?:-[a-z]+)+$/;
// Heurística, uma camada entre várias (a allowlist estrita e a revisão são as barreiras reais): literal de 6+ caracteres
// com dígito ou símbolo, ou só de letras com 12+, atribuído a um nome de segredo. Não pega valores montados em partes,
// codificados, vindos de outro arquivo ou escritos em várias linhas.
function literalSuspeito(valor) {
  if (VALORES_PUBLICOS_CONHECIDOS.has(sha256(valor))) return false;
  if (IDENTIFICADOR_DE_CODIGO.test(valor)) return false;
  if (NOME_DE_CABECALHO.test(valor) && valor.length < 16) return false;
  if (/^[A-Za-z]+$/.test(valor)) return valor.length >= 12;
  return true;
}

class ErroPublicacaoBackend extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroPublicacaoBackend';
    this.codigo = codigo;
  }
}
const erro = (codigo, mensagem) => new ErroPublicacaoBackend(codigo, mensagem);

const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
const absoluto = (raiz, rel) => path.join(raiz, ...rel.split('/'));
const dentroDe = (pai, caminho) => caminho === pai || caminho.startsWith(pai + path.sep);

function caminhoReal(abs) {
  const pendentes = [];
  let atual = abs;
  while (!fs.existsSync(atual)) {
    pendentes.unshift(path.basename(atual));
    atual = path.dirname(atual);
  }
  return path.join(fs.realpathSync(atual), ...pendentes);
}

function lerAllowlist(arquivo = ARQUIVO_ALLOWLIST) {
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const ok = dados && Array.isArray(dados.arquivos) && Array.isArray(dados.raizes)
    && dados.arquivos.every((a) => typeof a === 'string' && a !== '' && path.posix.normalize(a) === a && !a.startsWith('/') && !a.split('/').includes('..'))
    && dados.raizes.every((r) => r && typeof r.prefixo === 'string' && r.prefixo.endsWith('/') && !r.prefixo.startsWith('/')
      && path.posix.normalize(r.prefixo) === r.prefixo && Array.isArray(r.extensoes) && r.extensoes.length > 0
      && r.extensoes.every((e) => /^\.[a-z0-9]+$/.test(e)));
  if (!ok) throw erro('ALLOWLIST_INVALIDA', 'allowlist do backend malformada');
  return { arquivos: dados.arquivos.slice(), raizes: dados.raizes.map((r) => ({ prefixo: r.prefixo, extensoes: r.extensoes.slice() })) };
}

function lerContratos(arquivo = ARQUIVO_CONTRATOS) {
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return validarContratos(dados && dados.contratos);
}

function validarContratos(contratos) {
  if (!contratos || typeof contratos !== 'object' || Array.isArray(contratos)) throw erro('CONTRATOS_INVALIDOS', 'contratos precisa ser um objeto');
  for (const [nome, versao] of Object.entries(contratos)) {
    if (!NOME_DE_CONTRATO.test(nome) || !Number.isInteger(versao) || versao < 1) {
      throw erro('CONTRATOS_INVALIDOS', `contrato inválido: ${JSON.stringify(nome)}`);
    }
  }
  return { ...contratos };
}

function permitido(rel, allow) {
  if (allow.arquivos.includes(rel)) return true;
  const extensao = path.posix.extname(rel);
  return allow.raizes.some((r) => rel.startsWith(r.prefixo) && r.extensoes.includes(extensao));
}

function verificarNome(rel, nome) {
  if (DUPLICATA_FINDER.test(nome)) throw erro('DUPLICATA_FINDER', `duplicata do Finder: ${rel}`);
  if (NOMES_DE_SEGREDO.some((re) => re.test(nome))) throw erro('SEGREDO_ARQUIVO', `arquivo de segredo por nome: ${rel}`);
}

function percorrer(raiz, rel, allow, acumulado) {
  const diretorio = rel ? absoluto(raiz, rel) : raiz;
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entrada.name === '.DS_Store') continue;
    const relFilho = rel ? `${rel}/${entrada.name}` : entrada.name;
    if (entrada.isSymbolicLink()) throw erro('ENTRADA_INVALIDA', `link simbólico: ${relFilho}`);
    verificarNome(relFilho, entrada.name);
    if (entrada.isDirectory()) {
      percorrer(raiz, relFilho, allow, acumulado);
    } else if (entrada.isFile()) {
      if (!permitido(relFilho, allow)) throw erro('ARQUIVO_NAO_PERMITIDO', `fora da regra de raiz e extensão: ${relFilho}`);
      acumulado.push(relFilho);
    } else {
      throw erro('ENTRADA_INVALIDA', `não é arquivo regular: ${relFilho}`);
    }
  }
}

function enumerar(raiz, allow) {
  const dirsDeTopo = new Set([...allow.raizes.map((r) => r.prefixo.split('/')[0]), ...allow.arquivos.filter((a) => a.includes('/')).map((a) => a.split('/')[0])]);
  const arquivosDaRaiz = new Set(allow.arquivos.filter((a) => !a.includes('/')));
  const acumulado = [];
  for (const entrada of fs.readdirSync(raiz, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const nome = entrada.name;
    if (nome === '.DS_Store' || IGNORADOS_NA_RAIZ.has(nome) || ENV_NA_RAIZ.test(nome)) continue;
    if (entrada.isSymbolicLink()) throw erro('ENTRADA_INVALIDA', `link simbólico: ${nome}`);
    if (DUPLICATA_FINDER.test(nome)) throw erro('DUPLICATA_FINDER', `duplicata do Finder: ${nome}`);
    if (entrada.isDirectory() && dirsDeTopo.has(nome)) percorrer(raiz, nome, allow, acumulado);
    else if (entrada.isFile() && arquivosDaRaiz.has(nome)) acumulado.push(nome);
    else throw erro('ENTRADA_RAIZ_DESCONHECIDA', `item desconhecido na raiz do backend: ${nome}`);
  }
  return acumulado.sort();
}

function procurarSegredos(rel, texto) {
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (linha.length > LIMITE_LINHA) throw erro('LINHA_MUITO_LONGA', `linha acima de ${LIMITE_LINHA} caracteres em ${rel}:${i + 1}; código-fonte minificado não entra no pacote`);
    for (const [nome, regra] of REGRAS_DE_SEGREDO) {
      if (regra.test(linha)) throw erro('SEGREDO_NO_CONTEUDO', `possível segredo (${nome}) em ${rel}:${i + 1}`);
    }
    // Todas as atribuições da linha são examinadas; a isenção vale só para o literal público exato.
    for (const atribuicao of linha.matchAll(ATRIBUICAO_LITERAL)) {
      const valor = atribuicao[2];
      if (literalSuspeito(valor)) {
        throw erro('SEGREDO_NO_CONTEUDO', `possível segredo (ATRIBUICAO_LITERAL) em ${rel}:${i + 1}`);
      }
    }
  }
}

function lerJson(abs, codigo, rotulo) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    throw erro(codigo, `${rotulo} ilegível ou inválido`);
  }
}

function validarPackage(raiz) {
  const pacote = lerJson(absoluto(raiz, 'package.json'), 'PACKAGE_INVALIDO', 'package.json');
  if (!pacote || typeof pacote !== 'object') throw erro('PACKAGE_INVALIDO', 'package.json inválido');
  const scripts = pacote.scripts && typeof pacote.scripts === 'object' ? pacote.scripts : {};
  const gancho = HOOKS_DE_INSTALACAO.find((g) => g in scripts);
  if (gancho) throw erro('HOOKS_DE_INSTALACAO', `package.json define o hook de instalação "${gancho}"`);
  const node = pacote.engines && pacote.engines.node;
  if (typeof node !== 'string' || node.trim() === '') throw erro('PACKAGE_INVALIDO', 'package.json sem engines.node');
  return { node };
}

function validarLockfile(raiz) {
  const bruto = fs.readFileSync(absoluto(raiz, 'package-lock.json'));
  let lock;
  try { lock = JSON.parse(bruto.toString('utf8')); } catch { throw erro('LOCKFILE_INSEGURO', 'package-lock.json ilegível'); }
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw erro('LOCKFILE_INSEGURO', 'lockfile precisa ser da versão 3');
  for (const [nome, pacote] of Object.entries(lock.packages)) {
    if (nome === '') continue;
    if (!pacote || pacote.link) throw erro('LOCKFILE_INSEGURO', `pacote por link ou workspace: ${nome}`);
    if (typeof pacote.resolved !== 'string' || !pacote.resolved.startsWith('https://registry.npmjs.org/')) throw erro('LOCKFILE_INSEGURO', `origem fora do registro npm: ${nome}`);
    if (typeof pacote.integrity !== 'string' || !/^sha(256|384|512)-/.test(pacote.integrity)) throw erro('LOCKFILE_INSEGURO', `sem integridade: ${nome}`);
  }
  return sha256(bruto);
}

function validarMigrations(raiz, arquivos) {
  const manifesto = lerJson(absoluto(raiz, 'migrations/checksums.json'), 'MIGRATIONS_DIVERGENTES', 'checksums.json');
  if (!manifesto || manifesto.algoritmo !== 'sha256' || !manifesto.migrations || typeof manifesto.migrations !== 'object' || Array.isArray(manifesto.migrations)) {
    throw erro('MIGRATIONS_DIVERGENTES', 'checksums.json fora do formato esperado');
  }
  const emDisco = arquivos.filter((a) => /^migrations\/[^/]+\.sql$/.test(a)).map((a) => a.slice('migrations/'.length));
  const manifestadas = Object.keys(manifesto.migrations);
  const foraDoManifesto = emDisco.filter((n) => !(n in manifesto.migrations));
  const semArquivo = manifestadas.filter((n) => !emDisco.includes(n));
  if (foraDoManifesto.length || semArquivo.length) {
    throw erro('MIGRATIONS_DIVERGENTES', `migrations fora do manifesto: [${foraDoManifesto.join(', ')}]; manifestadas sem arquivo: [${semArquivo.join(', ')}]`);
  }
  const lista = [];
  for (const nome of emDisco.sort()) {
    const hash = sha256(fs.readFileSync(absoluto(raiz, `migrations/${nome}`)));
    if (hash !== manifesto.migrations[nome]) throw erro('MIGRATIONS_DIVERGENTES', `checksum diferente do manifesto: ${nome}`);
    lista.push({ nome, sha256: hash });
  }
  return lista;
}

function inspecionar(raiz, allow, limiteBytes) {
  const arquivos = enumerar(raiz, allow);
  for (const obrigatorio of OBRIGATORIOS) {
    if (!arquivos.includes(obrigatorio)) throw erro('ARQUIVO_AUSENTE', `arquivo exigido ausente: ${obrigatorio}`);
  }
  const manifesto = {};
  for (const rel of arquivos) {
    const abs = absoluto(raiz, rel);
    if (fs.statSync(abs).size > limiteBytes) throw erro('ARQUIVO_GRANDE', `acima do limite de tamanho: ${rel}`);
    const conteudo = fs.readFileSync(abs);
    if (EXTENSOES_COM_TEXTO.has(path.posix.extname(rel))) procurarSegredos(rel, conteudo.toString('utf8'));
    manifesto[rel] = sha256(conteudo);
  }
  const { node } = validarPackage(raiz);
  const lockfileSha256 = validarLockfile(raiz);
  const migrations = validarMigrations(raiz, arquivos);
  return { arquivos, manifesto, node, lockfileSha256, migrations };
}

function validarSaida(saida, raizReal, { dentroDoRepositorio = false } = {}) {
  if (typeof saida !== 'string' || saida.trim() === '') throw erro('SAIDA_INVALIDA', 'informe o diretório de saída (--saida)');
  const abs = path.resolve(saida);
  const real = caminhoReal(abs);
  if (dentroDe(raizReal, real)) throw erro('SAIDA_INVALIDA', 'a saída não pode ficar dentro do código-fonte do backend');
  if (dentroDoRepositorio && dentroDe(fs.realpathSync(RAIZ_REPO), real)) throw erro('SAIDA_INVALIDA', 'a release não pode ficar dentro do repositório');
  if (fs.existsSync(abs)) {
    const info = fs.lstatSync(abs);
    if (!info.isDirectory() || fs.readdirSync(abs).length > 0) throw erro('SAIDA_INVALIDA', `a saída precisa ser um diretório novo ou vazio: ${abs}`);
  }
  return abs;
}

function listarPacote(dir, base = dir) {
  return fs.readdirSync(dir).flatMap((nome) => {
    const abs = path.join(dir, nome);
    const info = fs.lstatSync(abs);
    if (info.isDirectory()) return listarPacote(abs, base);
    if (!info.isFile()) throw erro('PACOTE_DIVERGENTE', `item que não é arquivo regular: ${path.relative(base, abs)}`);
    return [path.relative(base, abs).split(path.sep).join('/')];
  });
}

function conferir(dir, manifesto) {
  const presentes = new Set(listarPacote(dir));
  const esperados = new Set(Object.keys(manifesto));
  const aMais = [...presentes].filter((f) => !esperados.has(f)).sort();
  const aMenos = [...esperados].filter((f) => !presentes.has(f)).sort();
  if (aMais.length || aMenos.length) throw erro('PACOTE_DIVERGENTE', `pacote diferente da allowlist: a mais [${aMais.join(', ')}]; a menos [${aMenos.join(', ')}]`);
  for (const rel of esperados) {
    if (sha256(fs.readFileSync(absoluto(dir, rel))) !== manifesto[rel]) throw erro('PACOTE_DIVERGENTE', `conteúdo diferente do manifesto: ${rel}`);
  }
}

function desfazer(destino, criou) {
  try {
    if (criou) fs.rmSync(destino, { recursive: true, force: true });
    else for (const nome of fs.readdirSync(destino)) fs.rmSync(path.join(destino, nome), { recursive: true, force: true });
  } catch { /* a recusa original prevalece */ }
}

function empacotarBackend({ saida, raiz = RAIZ_BACKEND, allowlist = lerAllowlist(), limiteBytes = LIMITE_PADRAO, copiarArquivo = fs.copyFileSync, dentroDoRepositorio = false } = {}) {
  const raizReal = fs.realpathSync(raiz);
  const destino = validarSaida(saida, raizReal, { dentroDoRepositorio });
  const inspecao = inspecionar(raizReal, allowlist, limiteBytes);
  const criou = !fs.existsSync(destino);
  try {
    fs.mkdirSync(destino, { recursive: true });
    for (const rel of inspecao.arquivos) {
      const alvo = absoluto(destino, rel);
      fs.mkdirSync(path.dirname(alvo), { recursive: true });
      copiarArquivo(absoluto(raizReal, rel), alvo, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(alvo, 0o644);
    }
    conferir(destino, inspecao.manifesto);
  } catch (falha) {
    desfazer(destino, criou);
    throw falha;
  }
  return { saida: destino, arquivos: inspecao.arquivos, manifesto: inspecao.manifesto, migrations: inspecao.migrations, lockfileSha256: inspecao.lockfileSha256, node: inspecao.node };
}

function linhasDoManifesto(manifesto) {
  return `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
}

function gerarReleaseBackend({ saida, commit, rotulo, atual, agora = Date.now(), raiz = RAIZ_BACKEND, contratos, ...resto } = {}) {
  if (typeof commit !== 'string' || !SHA_COMPLETO.test(commit)) throw erro('COMMIT_INVALIDO', 'commit precisa ser SHA completo');
  if (typeof rotulo !== 'string' || !ROTULO.test(rotulo)) throw erro('ROTULO_INVALIDO', `rótulo fora do padrão: ${rotulo}`);
  if (typeof atual !== 'boolean') throw erro('FATO_INVALIDO', 'atual precisa ser booleano');
  if (atual === rotulo.endsWith('-retroativo')) throw erro('FATO_INVALIDO', 'rótulo retroativo e marca "atual" divergem');
  const declarados = validarContratos(contratos === undefined ? lerContratos() : contratos);
  const raizReal = fs.realpathSync(raiz);
  const destino = validarSaida(saida, raizReal, { dentroDoRepositorio: true });

  const criou = !fs.existsSync(destino);
  try {
    fs.mkdirSync(destino, { recursive: true });
    const pacote = empacotarBackend({ ...resto, saida: path.join(destino, 'backend'), raiz });
    const texto = linhasDoManifesto(pacote.manifesto);
    fs.writeFileSync(path.join(destino, 'manifesto-backend.sha256'), texto);
    const release = {
      commit,
      rotulo,
      atual,
      geradoEm: new Date(agora).toISOString(),
      backend: {
        arquivos: pacote.arquivos.length,
        manifestoSha256: sha256(texto),
        lockfileSha256: pacote.lockfileSha256,
        node: pacote.node,
        migrations: pacote.migrations,
        contratos: declarados,
      },
    };
    fs.writeFileSync(path.join(destino, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    return { saida: destino, release };
  } catch (falha) {
    desfazer(destino, criou);
    throw falha;
  }
}

/** Reconfere uma release gerada: manifesto, contagem, arquivos exatos e hashes. */
function verificarReleaseBackend(dir) {
  const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  const secao = release && release.backend;
  if (!secao) throw erro('RELEASE_DIVERGENTE', 'release.json sem a seção backend');
  const texto = fs.readFileSync(path.join(dir, 'manifesto-backend.sha256'), 'utf8');
  if (sha256(texto) !== secao.manifestoSha256) throw erro('RELEASE_DIVERGENTE', 'manifesto-backend.sha256 difere do release.json');
  const manifesto = {};
  for (const linha of texto.split('\n').filter(Boolean)) {
    const [hash, rel] = [linha.slice(0, 64), linha.slice(66)];
    manifesto[rel] = hash;
  }
  if (Object.keys(manifesto).length !== secao.arquivos) throw erro('RELEASE_DIVERGENTE', 'contagem difere do manifesto');
  try {
    conferir(path.join(dir, 'backend'), manifesto);
  } catch (falha) {
    throw erro('RELEASE_DIVERGENTE', falha.message);
  }
  return release;
}

function lerArgumentos(argv) {
  const valores = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--(saida|commit|rotulo|atual)$/.test(argv[i]) || argv[i + 1] === undefined) throw erro('USO', 'uso: empacotar-backend.js --saida <dir> --commit <sha> --rotulo <rotulo> --atual <true|false>');
    valores[argv[i].slice(2)] = argv[i + 1];
  }
  if (valores.atual !== 'true' && valores.atual !== 'false') throw erro('USO', '--atual precisa ser true ou false');
  return { ...valores, atual: valores.atual === 'true' };
}

if (require.main === module) {
  try {
    const { release, saida } = gerarReleaseBackend(lerArgumentos(process.argv.slice(2)));
    verificarReleaseBackend(saida);
    console.log(`Release ${release.rotulo} do backend gerada em ${saida}: backend ${release.backend.arquivos} arquivos${release.atual ? '' : ' (RETROATIVA: não é a versão atual da main)'}.`);
  } catch (falha) {
    console.error(`Release do backend recusada (${falha.codigo || 'ERRO'}): ${falha.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  empacotarBackend, gerarReleaseBackend, verificarReleaseBackend, lerAllowlist, lerContratos, linhasDoManifesto, ErroPublicacaoBackend, ROTULO, LIMITE_LINHA,
};
