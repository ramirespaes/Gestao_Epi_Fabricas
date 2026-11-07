'use strict';

/**
 * Núcleo do instalador de releases: configuração, política de operações por componente, leitura e autenticação da
 * release, e tudo o que toca a árvore operacional (estado, metadados, diário, links, preparo, trava), sempre por
 * âncoras de diretório (ancora.js) e nunca por caminho remontado. Só o núcleo do Node. As operações (instalar,
 * reverter, identificar) ficam em instalar-release.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ErroInstalador, erro, config } = require('./erros');
const { criarAncora, validarDiretorioConfiavel } = require('./ancora');

const SHA_COMPLETO = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROTULO = /^hml-\d{8}T\d{6}-[0-9a-f]{7}(-retroativo)?$/;
const NOME_COMPONENTE = /^[a-z0-9][a-z0-9-]*$/;
const NOME_DE_LINK = /^(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const COMANDO_DEPENDENCIAS = ['ci', '--omit=dev', '--ignore-scripts'];
const URL_SAUDE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/\S*)?$/;
const HISTORICO_MAXIMO = 50;
const PASSOS_FINAIS = new Set(['CONCLUIDA', 'REVERTIDA_AUTOMATICA', 'FALHOU', 'ABORTADA', 'RECUPERADA']);

const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chaveDeData = (rotulo) => rotulo.slice(4, 19);

function caminhoReal(abs) {
  const pendentes = [];
  let atual = abs;
  while (!fs.existsSync(atual)) {
    pendentes.unshift(path.basename(atual));
    atual = path.dirname(atual);
  }
  return path.join(fs.realpathSync(atual), ...pendentes);
}
const sobrepoe = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const dentroDe = (pai, caminho) => caminho === pai || caminho.startsWith(pai + path.sep);

// ------------------------------------------------- política de operações por componente

// Única fonte da verdade sobre o que cada tipo de componente pode fazer, consultada pela configuração, pela linha de
// comando e pela biblioteca. Frontend estático nunca reinicia nada, nunca instala dependências e não tem processo,
// saúde nem links persistentes. O backend fica bloqueado para trocar, reiniciar e reverter na linha de comando
// (o único ponto de entrada operacional) enquanto não existir coordenação homologada com o D-ORF-6.
const POLITICA_DE_COMPONENTES = Object.freeze({
  estatico: Object.freeze({
    cli: Object.freeze(['instalar', 'reverter', 'identificar', 'reconciliar']),
    campos: Object.freeze([]),
    bloqueios: Object.freeze({}),
  }),
  backend: Object.freeze({
    cli: Object.freeze(['identificar', 'reconciliar']),
    campos: Object.freeze(['linksPersistentes', 'dependencias', 'saude', 'reinicio', 'processo']),
    bloqueios: Object.freeze({
      instalar: 'trocar, reiniciar ou reverter o backend está bloqueado: nenhuma trava de operação do D-ORF-6 foi homologada, e atestado ou arquivo de coordenação não excluem um backup concorrente',
      reverter: 'trocar, reiniciar ou reverter o backend está bloqueado: nenhuma trava de operação do D-ORF-6 foi homologada, e atestado ou arquivo de coordenação não excluem um backup concorrente',
    }),
  }),
});
const CAMPOS_SO_DO_BACKEND = ['linksPersistentes', 'dependencias', 'saude', 'reinicio', 'processo'];

// Aplicada pela linha de comando. A biblioteca aplica a mesma tabela para o que não é operação (campos) e exige
// coordenação revalidada para o backend (ver instalar-release.js).
function verificarOperacaoNaInterface(tipo, operacao, interfaceNome = 'cli') {
  const politica = POLITICA_DE_COMPONENTES[tipo];
  if (!politica) throw erro('COMPONENTE_DESCONHECIDO', `tipo de componente sem política: ${tipo}`);
  if (interfaceNome === 'cli' && !politica.cli.includes(operacao)) {
    const mensagem = politica.bloqueios[operacao];
    throw erro(tipo === 'backend' ? 'COORDENACAO_NAO_HOMOLOGADA' : 'OPERACAO_NAO_PERMITIDA', mensagem || `a operação ${operacao} não é permitida para componente ${tipo}`);
  }
}

// ---------------------------------------------------------------- contexto e configuração

function verificarContextoDeExecucao({ uid = typeof process.getuid === 'function' ? process.getuid() : undefined, permitirRoot = false } = {}) {
  if (uid === 0 && permitirRoot !== true) throw erro('EXECUCAO_COMO_ROOT', 'o instalador não deve rodar como root: use o usuário de implantação (ou --permitir-execucao-como-root, de forma explícita)');
}

function lerArquivoJsonSeguro(arquivo, { uid = typeof process.getuid === 'function' ? process.getuid() : undefined } = {}) {
  const insegura = (m) => erro('CONFIG_INSEGURA', `${m}: ${arquivo}`);
  let info;
  try { info = fs.lstatSync(arquivo); } catch { throw insegura('arquivo inexistente ou ilegível'); }
  if (!info.isFile()) throw insegura('precisa ser arquivo regular (link simbólico não é aceito)');
  if ((info.mode & 0o022) !== 0) throw insegura('gravável por grupo ou outros');
  if (uid !== undefined && info.uid !== uid && info.uid !== 0) throw insegura('pertence a outro usuário');
  const pasta = fs.statSync(path.dirname(arquivo));
  if ((pasta.mode & 0o022) !== 0 && (pasta.mode & 0o1000) === 0) throw insegura('diretório gravável por grupo ou outros');
  const bruto = fs.readFileSync(arquivo);
  try { return { dados: JSON.parse(bruto.toString('utf8')), sha256: sha256(bruto) }; } catch { throw erro('CONFIG_INVALIDA', `JSON inválido: ${arquivo}`); }
}
const lerConfigSegura = (arquivo, opcoes) => lerArquivoJsonSeguro(arquivo, opcoes).dados;

function comandoDeDependenciasValido(comando) {
  return Array.isArray(comando) && comando.length === 4
    && path.isAbsolute(comando[0]) && path.basename(comando[0]) === 'npm'
    && COMANDO_DEPENDENCIAS.every((arg, i) => comando[i + 1] === arg);
}
const comandoAbsoluto = (c) => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string' && a !== '' && !/[\n\r\0]/.test(a)) && path.isAbsolute(c[0]);

function validarConfig(bruta) {
  if (!ehObjeto(bruta) || !ehObjeto(bruta.componentes) || Object.keys(bruta.componentes).length === 0) throw config('componentes ausentes');
  const retencao = bruta.retencao === undefined ? 5 : bruta.retencao;
  if (!Number.isInteger(retencao) || retencao < 2 || retencao > 20) throw config('retencao precisa ser inteiro entre 2 e 20');
  if (!Array.isArray(bruta.raizesPersistentes) || !bruta.raizesPersistentes.every((p) => typeof p === 'string' && path.isAbsolute(p))) throw config('raizesPersistentes precisa ser lista de caminhos absolutos');
  const persistentes = bruta.raizesPersistentes.map((p) => path.resolve(p));
  const componentes = {};
  const usados = new Set();
  for (const [chave, c] of Object.entries(bruta.componentes)) {
    if (!NOME_COMPONENTE.test(chave) || !ehObjeto(c)) throw config(`componente inválido: ${chave}`);
    if (c.tipo !== 'estatico' && c.tipo !== 'backend') throw config(`${chave}: tipo precisa ser estatico ou backend`);
    // Política: reinício, processo, saúde, dependências e links persistentes são do backend. Em estático são recusados,
    // para que um comando de reinício do backend nunca seja associado a um frontend e executado sem coordenação.
    if (c.tipo === 'estatico') for (const campo of CAMPOS_SO_DO_BACKEND) if (c[campo] !== undefined) throw config(`${chave}: "${campo}" só vale para componente backend; frontend estático nunca reinicia nada nem instala dependências`);
    if (typeof c.base !== 'string' || !path.isAbsolute(c.base)) throw config(`${chave}: base precisa ser caminho absoluto`);
    if (typeof c.nome !== 'string' || !NOME_COMPONENTE.test(c.nome)) throw config(`${chave}: nome inválido`);
    const base = path.resolve(c.base);
    const unico = `${base}\0${c.nome}`;
    if (usados.has(unico)) throw config(`${chave}: base e nome já usados por outro componente`);
    usados.add(unico);
    for (const protegido of [path.join(base, c.nome), path.join(base, '.releases', c.nome)]) {
      if (persistentes.some((p) => sobrepoe(p, protegido))) throw config(`${chave}: raiz persistente sobrepõe os caminhos de release`);
    }
    const normal = { tipo: c.tipo, base, nome: c.nome };
    if (c.linksPersistentes !== undefined) {
      if (!Array.isArray(c.linksPersistentes)) throw config(`${chave}: linksPersistentes precisa ser lista`);
      const nomes = new Set();
      normal.linksPersistentes = c.linksPersistentes.map((l) => {
        if (!ehObjeto(l) || typeof l.nome !== 'string' || !NOME_DE_LINK.test(l.nome) || l.nome === 'node_modules' || nomes.has(l.nome)) throw config(`${chave}: nome de link persistente inválido ou repetido`);
        if (typeof l.destino !== 'string' || !path.isAbsolute(l.destino)) throw config(`${chave}: destino de link persistente precisa ser absoluto`);
        const destino = path.resolve(l.destino);
        if (!persistentes.some((p) => dentroDe(p, destino))) throw config(`${chave}: destino de link fora das raízes persistentes`);
        nomes.add(l.nome);
        return { nome: l.nome, destino };
      });
    }
    if (c.dependencias !== undefined) {
      if (!ehObjeto(c.dependencias) || !comandoDeDependenciasValido(c.dependencias.comando)) throw config(`${chave}: o único comando de dependências aceito é <caminho absoluto>/npm ci --omit=dev --ignore-scripts`);
      normal.dependencias = { comando: c.dependencias.comando.slice() };
    }
    if (c.saude !== undefined) {
      const s = c.saude;
      if (!ehObjeto(s) || typeof s.url !== 'string' || !URL_SAUDE.test(s.url)) throw config(`${chave}: saude.url precisa apontar para o próprio servidor (http local)`);
      const faixa = (v, min, max) => v === undefined || (Number.isInteger(v) && v >= min && v <= max);
      if (!faixa(s.tentativas, 1, 20) || !faixa(s.intervaloMs, 0, 60000) || !faixa(s.timeoutMs, 100, 60000)) throw config(`${chave}: parâmetros de saúde fora da faixa`);
      if (s.servicoEsperado !== undefined && (typeof s.servicoEsperado !== 'string' || !/^[a-z0-9-]{1,64}$/.test(s.servicoEsperado))) throw config(`${chave}: saude.servicoEsperado inválido`);
      normal.saude = { ...s };
    }
    if (c.reinicio !== undefined) {
      if (!ehObjeto(c.reinicio) || !comandoAbsoluto(c.reinicio.comando)) throw config(`${chave}: reinicio.comando precisa ser lista com caminho absoluto no primeiro item`);
      normal.reinicio = { comando: c.reinicio.comando.slice() };
    }
    if (c.processo !== undefined) {
      if (!ehObjeto(c.processo) || !comandoAbsoluto(c.processo.pidComando)) throw config(`${chave}: processo.pidComando precisa ser lista com caminho absoluto no primeiro item`);
      normal.processo = { pidComando: c.processo.pidComando.slice() };
    }
    componentes[chave] = normal;
  }
  return { raizesPersistentes: persistentes, retencao, componentes };
}

// Conferência estática da configuração (não é a proteção contra corrida: essa vem das âncoras): a base existe e as
// raízes persistentes, resolvidas, não se sobrepõem aos caminhos de release.
function revalidarCaminhos(cfg, comp) {
  if (!fs.existsSync(comp.base) || !fs.statSync(comp.base).isDirectory()) throw erro('BASE_AUSENTE', `a base do componente não existe: ${comp.base}`);
  const reaisPersistentes = cfg.raizesPersistentes.map(caminhoReal);
  const base = fs.realpathSync(comp.base);
  for (const protegido of [path.join(base, comp.nome), path.join(base, '.releases', comp.nome)]) {
    if (reaisPersistentes.some((p) => sobrepoe(p, protegido))) throw config('uma raiz persistente (resolvida) sobrepõe os caminhos de release');
  }
  return reaisPersistentes;
}

// -------------------------------------------------------------------- árvore operacional

// Âncora desta operação: com a exigência de durabilidade desta operação e só dela. A fábrica padrão exige Linux. Uma
// fábrica injetada (âncora por caminho ou emulação, sem garantia contra corrida) só é aceita em testes (NODE_ENV=test):
// fora deles a biblioteca recusa a injeção, e a linha de comando nunca injeta nada.
function criarAncoraDaOperacao(deps = {}, opcoes = {}) {
  if (deps.criarAncora !== undefined && process.env.NODE_ENV !== 'test') {
    throw erro('ANCORA_DE_TESTE_FORA_DE_TESTE', 'uma âncora injetada não protege contra substituição concorrente de diretórios e só é aceita em testes (NODE_ENV=test)');
  }
  const fabrica = typeof deps.criarAncora === 'function' ? deps.criarAncora : criarAncora;
  return fabrica({ exigirDurabilidade: opcoes.exigirDurabilidade === true });
}

function abrirContexto(A, comp, { criar = false } = {}) {
  const base = A.abrirBase(comp.base);
  const releases = A.abrirFilho(base, '.releases', { criar });
  const raiz = A.abrirFilho(releases, comp.nome, { criar });
  const meta = A.abrirFilho(raiz, 'meta', { criar });
  return { A, comp, base, releases, raiz, meta };
}
// Para operações que não criam nada: devolve null quando a árvore ainda não existe.
function abrirContextoSeExistir(A, comp) {
  const base = A.abrirBase(comp.base);
  const releases = A.tipo(base, '.releases');
  if (!releases) return null;
  const pasta = A.tipo(A.abrirFilho(base, '.releases'), comp.nome);
  if (!pasta) return null;
  return abrirContexto(A, comp);
}

async function comTrava(ctx, comando, trabalho) {
  const A = ctx.A;
  let trava;
  try {
    trava = A.criarExclusivo(ctx.raiz, '.trava');
  } catch (falha) {
    if (falha.code !== 'EEXIST') throw falha;
    let info = {};
    try {
      const existente = A.abrirFilho(ctx.raiz, '.trava', { confiavel: false });
      try { info = JSON.parse(A.lerTexto(existente, 'info.json') || '{}'); } finally { A.fechar(existente); }
    } catch { /* sem detalhes */ }
    throw erro('TRAVA_OCUPADA', `outra operação está em andamento (pid ${info.pid || 'desconhecido'}, desde ${info.iniciadoEm || 'data desconhecida'}); se tiver certeza de que não há processo ativo, remova ${path.join(ctx.raiz.caminho, '.trava')} manualmente`);
  }
  const identidade = A.identidade(trava);
  try {
    A.escreverAtomico(trava, 'info.json', JSON.stringify({ pid: process.pid, iniciadoEm: new Date().toISOString(), comando }));
    return await trabalho();
  } finally {
    try {
      A.fechar(trava);
      A.removerArvore(ctx.raiz, '.trava', { identidade });
    } catch (falha) {
      process.emitWarning(`não foi possível liberar a trava ${path.join(ctx.raiz.caminho, '.trava')}: ${falha.code || falha.message}; remova-a manualmente`);
    }
  }
}

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ----------------------------------------------- preparo ancorado da release (cópia, chmod, fsync, publicação)

function nomesDoCaminho(rel) {
  const partes = rel.split('/');
  const nome = partes.pop();
  return { dirRel: partes.join('/'), nome };
}
// Copia o pacote para o preparo, nível a nível: cada diretório é aberto a partir do descritor do pai e mantido aberto
// até o fim da operação; cada arquivo é copiado de forma exclusiva e tem hash e identidade registrados.
function copiarParaPreparo({ A, preparo, manifesto, pacote }) {
  const arquivos = new Map();
  const diretorios = new Map([['', preparo]]);
  const dirDe = (rel) => {
    if (diretorios.has(rel)) return diretorios.get(rel);
    const { dirRel, nome } = nomesDoCaminho(rel);
    const h = A.abrirFilho(dirDe(dirRel), nome, { criar: true });
    diretorios.set(rel, h);
    return h;
  };
  for (const [rel, hash] of Object.entries(manifesto)) {
    const { dirRel, nome } = nomesDoCaminho(rel);
    const dir = dirDe(dirRel);
    const id = A.copiarArquivo(path.join(pacote, ...rel.split('/')), dir, nome);
    if (sha256(A.lerBytes(dir, nome)) !== hash) throw erro('INTEGRIDADE_DIVERGENTE', `cópia diferente do manifesto: ${rel}`);
    arquivos.set(rel, id);
  }
  return { arquivos, diretorios };
}
function criarLinkNoPreparo({ A, preparo, nome, destino }) {
  if (A.tipo(preparo, nome)) throw erro('LINK_CONFLITA', `o link persistente "${nome}" colide com um arquivo da release`);
  A.criarLink(preparo, nome, destino);
}
// node_modules é criado por um processo externo (npm ci), que APAGA o que encontra nesse nome, inclusive o conteúdo do
// destino se for um link. Por isso ele nunca pode existir antes do processo, e depois precisa ser um diretório real
// cujos links não saiam da própria árvore.
function exigirDependenciasAusentes(A, preparo) {
  const info = A.tipo(preparo, 'node_modules');
  if (info) throw erro('NODE_MODULES_PREEXISTENTE', `node_modules já existe no preparo (${info.isSymbolicLink() ? 'link' : 'entrada'}): o npm ci apagaria o que estiver nesse nome, e nada foi executado`);
}
function inspecionarDependencias(A, pai, nome) {
  const problemas = [];
  const info = A.tipo(pai, nome);
  if (!info) return problemas;
  if (!info.isDirectory()) return [`${nome} precisa ser um diretório real e é ${info.isSymbolicLink() ? 'um link' : 'outro tipo de entrada'}`];
  let raiz;
  try { raiz = A.abrirFilho(pai, nome, { confiavel: false }); } catch { return [`${nome} não é um diretório real`]; }
  const percorrer = (dir, rel) => {
    let entradas;
    try { entradas = A.listar(dir); } catch { problemas.push(`${nome}/${rel || '.'}: diretório ilegível`); return; }
    for (const e of entradas) {
      const relFilho = rel ? `${rel}/${e.nome}` : e.nome;
      if (e.ehLink) {
        let destino = null;
        try { destino = A.lerLink(dir, e.nome); } catch { /* tratado abaixo */ }
        const resolvido = destino && !path.posix.isAbsolute(destino) ? path.posix.normalize(path.posix.join(rel, destino)) : null;
        if (resolvido === null || resolvido === '..' || resolvido.startsWith('../')) problemas.push(`${nome}/${relFilho}: link sai da árvore de dependências`);
      } else if (e.ehDiretorio) {
        let filho = null;
        try { filho = A.abrirFilho(dir, e.nome, { confiavel: false }); } catch { problemas.push(`${nome}/${relFilho}: diretório não é real`); }
        if (filho) { try { percorrer(filho, relFilho); } finally { A.fechar(filho); } }
      } else if (!e.ehArquivo) problemas.push(`${nome}/${relFilho}: item que não é arquivo regular nem diretório`);
    }
  };
  try { percorrer(raiz, ''); } finally { A.fechar(raiz); }
  return problemas;
}

// Sincroniza (sem alterar permissões) uma subárvore que não é do pacote, como node_modules. Links são ignorados.
function sincronizarSubarvore(A, pai, nome) {
  const info = A.tipo(pai, nome);
  if (!info) return;
  if (info.isFile()) { A.comArquivo(pai, nome, (a) => a.sincronizar(), { exigirLinkUnico: false }); return; }
  if (!info.isDirectory()) return;
  const dir = A.abrirFilho(pai, nome, { confiavel: false });
  try {
    for (const e of A.listar(dir)) sincronizarSubarvore(A, dir, e.nome);
    A.sincronizarDir(dir);
  } finally { A.fechar(dir); }
}
// A cópia e o hash foram conferidos pelos descritores que se mantiveram abertos. Isso prova o conteúdo dos inodes
// copiados, não o que os NOMES da árvore alcançam agora: um nome trocado depois da cópia (durante a espera pelas
// dependências, por exemplo) continuaria apontando para o diretório antigo no descritor e para outro lugar na árvore
// publicada. Aqui a árvore é percorrida POR NOME, sem seguir link, e cada diretório e arquivo tem de ser o mesmo inode
// registrado na cópia, sem entradas a mais nem a menos. Os nomes em `permitidos` (links persistentes e node_modules)
// são verificados à parte.
function conferirArvorePreparo({ A, preparo, arquivos, diretorios, permitidos = new Set(), links = [] }) {
  const divergente = (mensagem) => erro('INTEGRIDADE_DIVERGENTE', `a árvore do preparo mudou depois da cópia: ${mensagem}`);
  const arquivosVistos = new Set();
  const diretoriosVistos = new Set(['']);
  const visitar = (dir, rel) => {
    for (const e of A.listar(dir)) {
      const relFilho = rel ? `${rel}/${e.nome}` : e.nome;
      if (!rel && permitidos.has(e.nome)) continue;
      if (e.ehLink) throw divergente(`link inesperado em ${relFilho}`);
      if (e.ehDiretorio) {
        const esperado = diretorios.get(relFilho);
        if (!esperado) throw divergente(`diretório inesperado ${relFilho}`);
        let filho;
        try { filho = A.abrirFilho(dir, e.nome, { confiavel: false }); } catch { throw divergente(`${relFilho} deixou de ser um diretório real`); }
        try {
          if (!A.mesmaIdentidade(filho, esperado)) throw divergente(`diretório substituído em ${relFilho}`);
          diretoriosVistos.add(relFilho);
          visitar(filho, relFilho);
        } finally { A.fechar(filho); }
      } else if (e.ehArquivo) {
        const esperado = arquivos.get(relFilho);
        if (!esperado) throw divergente(`arquivo inesperado ${relFilho}`);
        A.comArquivo(dir, e.nome, (a) => { if (!a || !A.mesmaIdentidade(a.info, esperado)) throw divergente(`arquivo substituído em ${relFilho}`); });
        arquivosVistos.add(relFilho);
      } else throw divergente(`entrada que não é arquivo regular nem diretório em ${relFilho}`);
    }
  };
  visitar(preparo, '');
  for (const rel of arquivos.keys()) if (!arquivosVistos.has(rel)) throw divergente(`arquivo ausente ${rel}`);
  for (const rel of diretorios.keys()) if (!diretoriosVistos.has(rel)) throw divergente(`diretório ausente ${rel}`);
  for (const l of links) {
    const info = A.tipo(preparo, l.nome);
    if (!info || !info.isSymbolicLink() || A.lerLink(preparo, l.nome) !== l.destino) throw divergente(`link persistente ${l.nome} diferente do criado`);
  }
}
// Passada única: confere hash e identidade de cada arquivo pelo descritor aberto sem seguir link, torna-o somente
// leitura e o sincroniza; depois, do mais fundo ao mais raso, torna cada diretório somente leitura e o sincroniza.
function finalizarPreparo({ A, preparo, arquivos, diretorios, manifesto, subarvores = [] }) {
  for (const [rel, esperado] of arquivos) {
    const { dirRel, nome } = nomesDoCaminho(rel);
    A.comArquivo(diretorios.get(dirRel), nome, (a) => {
      if (!a || !A.mesmaIdentidade(a.info, esperado)) throw erro('INTEGRIDADE_DIVERGENTE', `arquivo substituído durante o preparo: ${rel}`);
      if (sha256(a.ler()) !== manifesto[rel]) throw erro('INTEGRIDADE_DIVERGENTE', `arquivo alterado durante a instalação de dependências: ${rel}`);
      a.chmod(0o444);
      a.sincronizar();
    });
  }
  for (const nome of subarvores) sincronizarSubarvore(A, preparo, nome);
  const fundos = [...diretorios.entries()].filter(([rel]) => rel !== '').sort((a, b) => b[0].split('/').length - a[0].split('/').length);
  for (const [, dir] of fundos) { A.tornarSomenteLeitura(dir); A.sincronizarDir(dir); }
  A.sincronizarDir(preparo);
}
// Publica o preparo por rename e CONFERE, por identidade contra o descritor que se manteve aberto, que o que ficou no
// nome da release é mesmo o diretório preparado. Um escritor concorrente que troque a entrada antes do rename vê o
// link ou diretório alheio publicado no nome da release: aqui isso é detectado e recusado ANTES de qualquer ponteiro.
function publicarPreparo({ A, raiz, preparo, nomePreparo, rotulo }) {
  A.tornarSomenteLeitura(preparo);
  A.sincronizarDir(preparo);
  A.renomear(raiz, nomePreparo, raiz, rotulo);
  let publicado = null;
  try {
    publicado = A.abrirFilho(raiz, rotulo, { confiavel: false });
  } catch (falha) {
    const info = A.tipo(raiz, rotulo);
    if (info && info.isSymbolicLink()) A.removerEntrada(raiz, rotulo);
    throw erro('RELEASE_SUBSTITUIDA', `a entrada ${rotulo} publicada não é o diretório preparado (${falha.codigo || falha.code}); nada foi apontado para ela`, { quarentena: !(info && info.isSymbolicLink()) });
  }
  try {
    if (!A.mesmaIdentidade(publicado, preparo)) throw erro('RELEASE_SUBSTITUIDA', `a entrada ${rotulo} publicada foi substituída por outro diretório; nada foi apontado para ela`, { quarentena: true });
  } finally { A.fechar(publicado); }
  A.sincronizarDir(raiz);
}

// ---------------------------------------------------------------- release (entrada do operador, só leitura)

function listarArvorePorCaminho(dir, ignoradosNoTopo) {
  const arquivos = [];
  const problemas = [];
  const percorrer = (abs, rel) => {
    let entradas;
    try { entradas = fs.readdirSync(abs, { withFileTypes: true }); } catch { problemas.push(`diretório ilegível: ${rel || '.'}`); return; }
    for (const e of entradas) {
      const relFilho = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && ignoradosNoTopo.has(e.name)) continue;
      if (e.isSymbolicLink()) problemas.push(`link inesperado: ${relFilho}`);
      else if (e.isDirectory()) percorrer(path.join(abs, e.name), relFilho);
      else if (e.isFile()) arquivos.push(relFilho);
      else problemas.push(`item que não é arquivo regular: ${relFilho}`);
    }
  };
  percorrer(dir, '');
  return { arquivos: arquivos.sort(), problemas };
}

// Autenticidade: o SHA-256 do release.json precisa bater com o hash aprovado por um canal externo à própria release.
function autenticar(hashDaRelease, opcoes) {
  const esperado = opcoes.releaseSha256Esperado;
  if (esperado === undefined) {
    if (opcoes.semAutenticacao === true) return 'NAO_VERIFICADA';
    throw erro('ORIGEM_NAO_AUTENTICADA', 'informe o hash SHA-256 aprovado do release.json (releaseSha256Esperado); sem ele a instalação é recusada, salvo opt-out explícito');
  }
  if (typeof esperado !== 'string' || !HEX64.test(esperado)) throw erro('RELEASE_NAO_AUTENTICADA', 'o hash aprovado do release.json é inválido (64 hexadecimais minúsculos)');
  if (esperado !== hashDaRelease) throw erro('RELEASE_NAO_AUTENTICADA', 'o release.json não confere com o hash aprovado: a release foi trocada ou não é a aprovada');
  return 'HASH_EXTERNO';
}

function consistenciaDoBackend(secao, manifesto, pacote, divergente) {
  const sqls = Object.keys(manifesto).filter((f) => /^migrations\/[^/]+\.sql$/.test(f)).map((f) => f.slice('migrations/'.length)).sort();
  const declaradas = new Map(secao.migrations.map((m) => [m.nome, m.sha256]));
  const nomes = [...declaradas.keys()].sort();
  if (declaradas.size !== secao.migrations.length || nomes.length !== sqls.length || nomes.some((n, i) => n !== sqls[i])) {
    throw divergente('as migrations declaradas no release.json diferem das migrations do pacote');
  }
  for (const nome of nomes) if (declaradas.get(nome) !== manifesto[`migrations/${nome}`]) throw divergente(`o hash declarado da migration ${nome} difere do arquivo`);
  const ler = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(pacote, ...rel.split('/')), 'utf8')); } catch { throw divergente(`${rel} ausente ou ilegível no pacote`); } };
  const checksums = ler('migrations/checksums.json');
  if (!ehObjeto(checksums) || checksums.algoritmo !== 'sha256' || !ehObjeto(checksums.migrations)) throw divergente('migrations/checksums.json fora do formato esperado');
  const chaves = Object.keys(checksums.migrations).sort();
  if (chaves.length !== sqls.length || chaves.some((n, i) => n !== sqls[i])) throw divergente('migrations/checksums.json não lista as mesmas migrations do pacote');
  for (const nome of chaves) if (checksums.migrations[nome] !== manifesto[`migrations/${nome}`]) throw divergente(`migrations/checksums.json diverge do arquivo ${nome}`);
  const pacoteJson = ler('package.json');
  if (!ehObjeto(pacoteJson) || !pacoteJson.engines || pacoteJson.engines.node !== secao.node) throw divergente('engines.node do package.json difere do declarado no release.json');
}

function lerRelease(dirRelease, componente, comp, opcoes = {}) {
  const abs = path.resolve(String(dirRelease || ''));
  const invalida = (m) => erro('RELEASE_INVALIDA', m);
  let bruto; let release;
  try {
    bruto = fs.readFileSync(path.join(abs, 'release.json'));
    release = JSON.parse(bruto.toString('utf8'));
  } catch { throw invalida('release.json ausente ou ilegível'); }
  const releaseSha256 = sha256(bruto);
  const autenticidade = autenticar(releaseSha256, opcoes);
  if (!ehObjeto(release) || typeof release.commit !== 'string' || !SHA_COMPLETO.test(release.commit)) throw invalida('commit inválido');
  if (typeof release.rotulo !== 'string' || !ROTULO.test(release.rotulo)) throw invalida('rótulo inválido');
  if (typeof release.atual !== 'boolean' || release.atual === release.rotulo.endsWith('-retroativo')) throw invalida('marca "atual" incoerente com o rótulo');
  const secao = release[componente];
  if (!ehObjeto(secao) || !Number.isInteger(secao.arquivos) || secao.arquivos < 1 || typeof secao.manifestoSha256 !== 'string' || !HEX64.test(secao.manifestoSha256)) throw invalida(`seção "${componente}" ausente ou inválida`);
  if (comp.tipo === 'backend') {
    const ok = Array.isArray(secao.migrations) && secao.migrations.every((m) => ehObjeto(m) && typeof m.nome === 'string' && HEX64.test(m.sha256))
      && ehObjeto(secao.contratos) && typeof secao.lockfileSha256 === 'string' && HEX64.test(secao.lockfileSha256) && typeof secao.node === 'string';
    if (!ok) throw invalida('seção do backend sem migrations, contratos, engines ou hash do lockfile');
  }
  const divergente = (m) => erro('INTEGRIDADE_DIVERGENTE', m);
  let texto;
  try { texto = fs.readFileSync(path.join(abs, `manifesto-${componente}.sha256`), 'utf8'); } catch { throw divergente('manifesto ausente'); }
  if (sha256(texto) !== secao.manifestoSha256) throw divergente('manifesto difere do release.json');
  const manifesto = Object.create(null);
  for (const linha of texto.split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(linha);
    const rel = m && m[2];
    if (!m || rel.startsWith('/') || rel.includes('\\') || path.posix.normalize(rel) !== rel || rel.split('/').includes('..') || rel in manifesto) throw divergente('linha de manifesto inválida');
    manifesto[rel] = m[1];
  }
  if (Object.keys(manifesto).length !== secao.arquivos) throw divergente('contagem de arquivos difere do release.json');
  const pacote = path.join(abs, componente);
  const { arquivos, problemas } = listarArvorePorCaminho(pacote, new Set());
  if (problemas.length) throw divergente(problemas[0]);
  const aMais = arquivos.filter((f) => !(f in manifesto));
  const aMenos = Object.keys(manifesto).filter((f) => !arquivos.includes(f));
  if (aMais.length || aMenos.length) throw divergente(`pacote diferente do manifesto (a mais: ${aMais.slice(0, 3).join(', ')}; a menos: ${aMenos.slice(0, 3).join(', ')})`);
  for (const rel of arquivos) {
    if (sha256(fs.readFileSync(path.join(pacote, ...rel.split('/')))) !== manifesto[rel]) throw divergente(`conteúdo diferente do manifesto: ${rel}`);
  }
  if (comp.tipo === 'backend') {
    if (manifesto['package-lock.json'] !== secao.lockfileSha256) throw divergente('package-lock.json difere do hash declarado');
    consistenciaDoBackend(secao, manifesto, pacote, divergente);
  }
  return { rotulo: release.rotulo, commit: release.commit, atual: release.atual, geradoEm: release.geradoEm, secao, manifesto, pacote, releaseSha256, autenticidade };
}

const mesmaIdentidade = (meta, rel) => Boolean(meta) && meta.commit === rel.commit && meta.manifestoSha256 === rel.secao.manifestoSha256 && meta.releaseSha256 === rel.releaseSha256;

// ---------------------------------------------------------------------- estado, metadados e diário

function lerEstado(ctx) {
  const texto = ctx.A.lerTexto(ctx.raiz, 'estado.json');
  if (texto === null) return { versao: 1, atual: null, anterior: null, historico: [] };
  try {
    const e = JSON.parse(texto);
    const release = (r) => r === null || r === undefined || (ehObjeto(r) && typeof r.rotulo === 'string');
    if (!ehObjeto(e) || !Array.isArray(e.historico) || !release(e.atual) || !release(e.anterior) || !(e.critico === undefined || e.critico === null || ehObjeto(e.critico))) throw new Error('forma');
    return e;
  } catch {
    throw erro('ESTADO_INVALIDO', 'estado.json ilegível: não será sobrescrito automaticamente');
  }
}
function gravarEstado(ctx, estado) {
  estado.historico = estado.historico.slice(-HISTORICO_MAXIMO);
  ctx.A.escreverAtomico(ctx.raiz, 'estado.json', `${JSON.stringify(estado, null, 2)}\n`);
}
// Metadado só vale com a forma completa: objeto do próprio rótulo, com manifesto de hashes válidos.
function metaValido(m, rotulo) {
  return ehObjeto(m) && m.rotulo === rotulo && typeof m.commit === 'string' && ehObjeto(m.manifesto)
    && Object.values(m.manifesto).every((h) => typeof h === 'string' && HEX64.test(h))
    && (m.ignorados === undefined || (Array.isArray(m.ignorados) && m.ignorados.every((i) => typeof i === 'string')))
    && (m.linksPersistentes === undefined || (Array.isArray(m.linksPersistentes) && m.linksPersistentes.every((l) => ehObjeto(l) && typeof l.nome === 'string' && typeof l.destino === 'string')));
}
// Metadado ausente ou com forma inválida vale null. Uma falha de leitura (E/S, arquivo compartilhado, link) NÃO é
// ausência: propaga como META_ILEGIVEL, para que nada seja decidido sobre um registro que não pôde ser lido.
function lerMeta(ctx, rotulo) {
  let texto;
  try { texto = ctx.A.lerTexto(ctx.meta, `${rotulo}.json`); } catch (falha) {
    throw erro('META_ILEGIVEL', `não foi possível ler o metadado de ${rotulo} (${falha.codigo || falha.code || falha.message})`);
  }
  if (texto === null) return null;
  let m;
  try { m = JSON.parse(texto); } catch { return null; }
  return metaValido(m, rotulo) ? m : null;
}
const gravarMeta = (ctx, rotulo, meta) => ctx.A.escreverAtomico(ctx.meta, `${rotulo}.json`, `${JSON.stringify(meta, null, 2)}\n`);
const removerMeta = (ctx, rotulo) => ctx.A.removerEntrada(ctx.meta, `${rotulo}.json`);

// Protocolo do diário: cada passo é uma linha JSON anexada com O_APPEND, sem seguir link, modo 0600 e fsync (e do
// diretório na criação). Qualquer falha propaga.
const registrarDiario = (ctx, entrada) => ctx.A.anexar(ctx.raiz, 'diario.jsonl', `${JSON.stringify(entrada)}\n`);
// Só a AUSÊNCIA do diário (ENOENT) vale como diário vazio. Qualquer falha de leitura (E/S, link, arquivo compartilhado,
// tipo errado) propaga como DIARIO_ILEGIVEL: sem saber o que o diário diz não há como afirmar que não existe operação
// interrompida, então integridade, reconciliação, instalação e reversão são bloqueadas.
function lerDiarioDetalhado(ctx) {
  let texto;
  try { texto = ctx.A.lerTexto(ctx.raiz, 'diario.jsonl'); } catch (falha) {
    throw erro('DIARIO_ILEGIVEL', `o diário não pôde ser lido (${falha.codigo || falha.code || falha.message}): nada pode ser afirmado sobre operações interrompidas`);
  }
  if (!texto) return { entradas: [], ilegiveis: 0 };
  const entradas = [];
  let ilegiveis = 0;
  for (const linha of texto.split('\n')) {
    if (!linha) continue;
    try {
      const e = JSON.parse(linha);
      if (ehObjeto(e)) entradas.push(e); else ilegiveis += 1;
    } catch { ilegiveis += 1; } // fragmento truncado por queda, ou adulteração: nunca é interpretado
  }
  return { entradas, ilegiveis };
}
const lerDiario = (ctx) => lerDiarioDetalhado(ctx).entradas;
// Última operação aberta (INICIO sem passo final), ou null. reiniciou: o serviço chegou a ser (ou a começar a ser)
// reiniciado nela; o processo pode não corresponder ao link, e nada disso pode ser dado como comprovado sem nova prova.
function operacaoAberta(ctx) {
  const diario = lerDiario(ctx);
  for (let i = diario.length - 1; i >= 0; i -= 1) {
    if (PASSOS_FINAIS.has(diario[i].passo)) return null;
    if (diario[i].passo === 'INICIO') {
      const passos = diario.slice(i + 1).filter((e) => e.id === diario[i].id).map((e) => e.passo);
      return { ...diario[i], passos, reiniciou: passos.includes('REINICIANDO') };
    }
  }
  return null;
}

// ------------------------------------------------------------------ links, versão e verificação

function lerLinkAtual(ctx) {
  const { A, comp } = ctx;
  const info = A.tipo(ctx.base, comp.nome);
  if (!info) return null;
  if (!info.isSymbolicLink()) throw erro('ATUAL_NAO_E_LINK', `${path.join(ctx.base.caminho, comp.nome)} existe e não é link de release; a adoção de um diretório existente é um passo manual e separado`);
  const alvo = A.lerLink(ctx.base, comp.nome);
  const rotulo = path.posix.basename(alvo || '');
  if (alvo !== path.posix.join('.releases', comp.nome, rotulo) || !ROTULO.test(rotulo)) throw erro('ATUAL_INCONSISTENTE', 'o link publicado não aponta para uma release do componente');
  // A release precisa ser um diretório real dentro da raiz: um link no lugar dela (mesmo com os hashes certos) nunca é aceito.
  const release = A.tipo(ctx.raiz, rotulo);
  if (!release || !release.isDirectory()) throw erro('ATUAL_INCONSISTENTE', 'o link publicado não aponta para um diretório de release real');
  return rotulo;
}
// O ponteiro é um NOME relativo, resolvido pelo sistema de arquivos no momento do uso: nenhum descritor o protege.
// Depois de apontá-lo, confere-se que o que ele alcança agora é o mesmo inode da release aberta pelo descritor de
// .releases/<nome> que se manteve aberto. Se .releases, o diretório do componente ou a própria release foram trocados
// por outra árvore, o destino efetivo difere e a troca é recusada (o chamador desfaz o link). Isto é uma conferência do
// resultado, não uma garantia: uma troca depois dela não é impedida por esta camada (ver o modelo de ameaça).
function confirmarDestinoDoLink(ctx, rotulo) {
  const { A, comp } = ctx;
  let esperado;
  try {
    const release = A.abrirFilho(ctx.raiz, rotulo, { confiavel: false });
    try { esperado = A.identidade(release); } finally { A.fechar(release); }
  } catch (falha) {
    throw erro('PONTEIRO_DIVERGENTE', `a release ${rotulo} não pôde ser aberta pelo diretório verificado (${falha.codigo || falha.code}); o ponteiro foi recusado`);
  }
  const alcancado = A.alcancar(ctx.base, comp.nome);
  if (!alcancado || !alcancado.ehDiretorio || !A.mesmaIdentidade(alcancado, esperado)) {
    throw erro('PONTEIRO_DIVERGENTE', `o ponteiro de ${comp.nome} não alcança a release verificada ${rotulo} (a árvore de releases foi trocada); o ponteiro foi recusado`);
  }
}
function lerLinkAnterior(ctx) {
  const info = ctx.A.tipo(ctx.raiz, 'anterior');
  if (!info || !info.isSymbolicLink()) return null;
  const rotulo = ctx.A.lerLink(ctx.raiz, 'anterior');
  return ROTULO.test(rotulo || '') ? rotulo : null;
}

// Lista a árvore de uma release por descritores, calculando o hash de cada arquivo regular na mesma passada.
function listarArvoreAncorada(A, dir, ignoradosNoTopo) {
  const arquivos = [];
  const hashes = new Map();
  const problemas = [];
  const percorrer = (d, rel) => {
    let entradas;
    try { entradas = A.listar(d); } catch { problemas.push(`diretório ilegível: ${rel || '.'}`); return; }
    for (const e of entradas) {
      const relFilho = rel ? `${rel}/${e.nome}` : e.nome;
      if (!rel && ignoradosNoTopo.has(e.nome)) {
        // Os links persistentes são verificados à parte; node_modules, criado por processo externo, tem o conteúdo
        // fora do manifesto, mas precisa ser um diretório real cujos links não saiam da própria árvore.
        if (e.nome === 'node_modules') problemas.push(...inspecionarDependencias(A, d, e.nome));
        continue;
      }
      if (e.ehLink) problemas.push(`link inesperado: ${relFilho}`);
      else if (e.ehDiretorio) {
        let filho = null;
        try { filho = A.abrirFilho(d, e.nome, { confiavel: false }); } catch { problemas.push(`diretório não é real: ${relFilho}`); }
        if (filho) { try { percorrer(filho, relFilho); } finally { A.fechar(filho); } }
      } else if (e.ehArquivo) {
        arquivos.push(relFilho);
        try { hashes.set(relFilho, sha256(A.lerBytes(d, e.nome))); } catch { problemas.push(`arquivo ilegível: ${relFilho}`); }
      } else problemas.push(`item que não é arquivo regular: ${relFilho}`);
    }
  };
  percorrer(dir, '');
  return { arquivos: arquivos.sort(), hashes, problemas };
}

// Cada link persistente registrado na instalação precisa continuar sendo link para o mesmo destino e esse destino
// precisa continuar resolvendo para dentro das raízes persistentes.
function verificarLinksPersistentes(A, dir, meta, persistentesReais, problemas) {
  for (const l of meta.linksPersistentes || []) {
    const info = A.tipo(dir, l.nome);
    if (!info) { problemas.push(`link persistente ausente: ${l.nome}`); continue; }
    if (!info.isSymbolicLink()) { problemas.push(`link persistente substituído por não-link: ${l.nome}`); continue; }
    if (A.lerLink(dir, l.nome) !== l.destino) { problemas.push(`link persistente ${l.nome} aponta para outro destino`); continue; }
    if (persistentesReais) {
      let real;
      try { real = fs.realpathSync(l.destino); } catch { problemas.push(`link persistente ${l.nome} quebrado`); continue; }
      if (!persistentesReais.some((p) => dentroDe(p, real))) problemas.push(`link persistente ${l.nome} resolve para fora das raízes persistentes`);
    }
  }
}

function verificarInstalacao(ctx, rotulo, { persistentesReais } = {}) {
  const A = ctx.A;
  let meta;
  try { meta = lerMeta(ctx, rotulo); } catch (falha) { return { integro: false, problemas: [falha.message] }; }
  if (!meta) return { integro: false, problemas: [`metadados ausentes de ${rotulo}`] };
  let dir;
  try {
    dir = A.abrirFilho(ctx.raiz, rotulo, { confiavel: false });
  } catch (falha) {
    return { integro: false, problemas: [`release ausente ou não é um diretório real: ${rotulo} (${falha.codigo || falha.code})`] };
  }
  try {
    const { arquivos, hashes, problemas } = listarArvoreAncorada(A, dir, new Set(meta.ignorados || []));
    for (const rel of Object.keys(meta.manifesto)) {
      if (!arquivos.includes(rel)) problemas.push(`ausente: ${rel}`);
      else if (hashes.get(rel) !== meta.manifesto[rel]) problemas.push(`alterado: ${rel}`);
    }
    for (const rel of arquivos) if (!Object.hasOwn(meta.manifesto, rel)) problemas.push(`extra: ${rel}`);
    verificarLinksPersistentes(A, dir, meta, persistentesReais, problemas);
    return { integro: problemas.length === 0, problemas };
  } finally { A.fechar(dir); }
}

// O que é publicado (versao.json) e o que é registrado (estado.json, link anterior) precisam concordar com o link em uso.
function verificarConsistencia(ctx, comp, componente, rotulo) {
  const problemas = [];
  let meta = null;
  try { meta = lerMeta(ctx, rotulo); } catch (falha) { problemas.push(falha.message); }
  let versao;
  try { versao = JSON.parse(ctx.A.lerTexto(ctx.raiz, 'versao.json')); } catch { problemas.push('versao.json ausente ou ilegível'); }
  if (versao !== undefined) {
    // Estrutura fechada: objeto com exatamente os quatro campos, todos texto. null, lista, número ou campos a mais reprovam.
    const campos = ['commit', 'componente', 'manifestoSha256', 'rotulo'];
    if (!ehObjeto(versao) || Object.keys(versao).sort().join(',') !== campos.join(',') || !campos.every((k) => typeof versao[k] === 'string')) {
      problemas.push('versao.json fora do formato: precisa ser objeto com commit, componente, manifestoSha256 e rotulo, todos texto');
    } else if (meta) {
      for (const campo of campos) {
        const esperado = campo === 'componente' ? componente : meta[campo];
        if (versao[campo] !== esperado) problemas.push(`versao.json difere do link em uso (${campo})`);
      }
    }
  }
  let estado = null;
  try { estado = lerEstado(ctx); } catch { problemas.push('estado.json ilegível'); }
  if (estado) {
    if (!estado.atual || estado.atual.rotulo !== rotulo) problemas.push('estado.json: release atual difere do link em uso');
    const anterior = lerLinkAnterior(ctx);
    if ((estado.anterior ? estado.anterior.rotulo : null) !== anterior) problemas.push('estado.json: release anterior difere do link anterior');
  }
  try {
    if (operacaoAberta(ctx)) problemas.push('diário: há operação interrompida sem conclusão (execute a reconciliação)');
  } catch (falha) { problemas.push(`diário ilegível: ${falha.message}`); }
  return problemas;
}

// Pendências não são inconsistência de registros: os registros batem com o link, mas a release em uso ainda não
// foi comprovada (processo e saúde) ou há um estado crítico registrado. Enquanto existirem, a release não é "íntegra".
function verificarPendencias(ctx, rotulo) {
  const problemas = [];
  let estado = null;
  try { estado = lerEstado(ctx); } catch { return problemas; }
  if (estado.critico) problemas.push(`estado crítico registrado (${estado.critico.motivo}) desde ${estado.critico.desde}: a release em uso pode não estar saudável; reinstale uma release saudável ou reverta`);
  if (estado.atual && estado.atual.rotulo === rotulo && estado.atual.comprovada === false) problemas.push('a release em uso não teve processo e saúde comprovados; reinstale a mesma release para confirmar ou reverta');
  return problemas;
}

function escreverVersao(ctx, componente, meta) {
  ctx.A.escreverAtomico(ctx.raiz, 'versao.json', `${JSON.stringify({ componente, rotulo: meta.rotulo, commit: meta.commit, manifestoSha256: meta.manifestoSha256 }, null, 2)}\n`);
}

module.exports = {
  ErroInstalador, erro, config, sha256, ehObjeto, chaveDeData, caminhoReal, sobrepoe, dentroDe,
  ROTULO, HEX64, SHA_COMPLETO, POLITICA_DE_COMPONENTES,
  verificarOperacaoNaInterface, verificarContextoDeExecucao, lerArquivoJsonSeguro, lerConfigSegura, validarConfig, revalidarCaminhos,
  validarDiretorioConfiavel, criarAncoraDaOperacao, abrirContexto, abrirContextoSeExistir, comTrava, dormir,
  copiarParaPreparo, criarLinkNoPreparo, finalizarPreparo, publicarPreparo,
  exigirDependenciasAusentes, inspecionarDependencias, conferirArvorePreparo,
  lerRelease, mesmaIdentidade,
  lerEstado, gravarEstado, lerMeta, gravarMeta, removerMeta, registrarDiario, lerDiario, lerDiarioDetalhado, operacaoAberta,
  lerLinkAtual, lerLinkAnterior, confirmarDestinoDoLink, verificarInstalacao, verificarConsistencia, verificarPendencias, escreverVersao,
};
