'use strict';

/**
 * Âncoras de diretório: toda leitura, escrita, troca de link, renomeação e remoção da árvore operacional passa por
 * descritores de diretório abertos e verificados, nunca por um caminho remontado a cada operação.
 *
 * O problema: verificar um caminho (realpath, lstat, inode) e usá-lo depois deixa uma janela em que um ancestral ou a
 * própria entrada pode ser trocada por um link. O Node não tem openat nem efeitos locais seguros como chdir (que é
 * global ao processo e desvia E/S pendente). A saída sem efeito global é deixar o KERNEL resolver os nomes a partir do
 * inode do diretório que já foi aberto e verificado:
 *
 *   modo 'proc' (Linux): o diretório é aberto UMA vez com O_DIRECTORY|O_NOFOLLOW; cada operação usa
 *     /proc/self/fd/<fd>/<nome>, que o kernel resolve contra o inode do descritor. Trocar o caminho do diretório, ou
 *     um ancestral dele, depois da abertura não redireciona nada, nem durante a espera por um processo externo ou por
 *     E/S assíncrona. Cada nível é aberto a partir do descritor do nível anterior (equivalente a openat).
 *
 *   modo 'caminho' (SEM garantia contra corrida): usa o caminho do diretório e confere a identidade (dev/inode) antes
 *     de cada operação. Detecta uma troca ocorrida entre duas operações, mas NÃO fecha a janela entre a conferência e
 *     o uso. Só existe para testes: exige semGarantiaDeCorrida: true E NODE_ENV=test, e nunca é escolhido sozinho nem
 *     pela linha de comando. O mesmo vale para um fsImpl injetado (emulação do /proc não é prova do kernel).
 *
 *   modo 'leitura' (qualquer plataforma, SEM garantia contra corrida): igual ao 'caminho', mas toda operação que
 *     escreve, renomeia ou remove é recusada (ANCORA_SOMENTE_LEITURA). Serve só para identificar o que está instalado.
 *
 * Sem o modo 'proc' (por exemplo, fora do Linux) a âncora padrão se recusa a existir: a operação fica BLOQUEADA
 * (PLATAFORMA_SEM_ANCORA) em vez de degradar para algo permissivo.
 *
 * Limites que nenhuma âncora fecha, e como são tratados:
 *   - O nome de uma entrada dentro de um diretório que outro escritor consegue modificar. Os diretórios operacionais
 *     e todos os ancestrais da base precisam ser do usuário de implantação (ou de root) e sem escrita para grupo ou
 *     outros, verificado por fstat no descritor realmente atravessado. Um escritor com o mesmo usuário (ou root) está
 *     fora do que esta camada consegue impedir; o que ela faz é nunca agir sobre uma entrada sem conferir, no
 *     descritor aberto, que é a entrada esperada (identidade, tipo e contagem de links), e falhar fechado.
 *   - Escrita no lugar em arquivo com mais de um link: o inode pode ser de outro caminho (por exemplo, um dado
 *     persistente). Todo arquivo aberto aqui é conferido com fstat (nlink 1) antes de ser lido, gravado ou alterado.
 *   - Remoção: o diretório é aberto sem seguir link, e só é esvaziado se o descritor aberto for a entrada esperada.
 *
 * Nada aqui é global: cada operação cria a sua âncora, com a sua exigência de durabilidade e os seus descritores.
 */

const fs = require('node:fs');
const path = require('node:path');
const { erro } = require('./erros');

const C = fs.constants;
const ABRIR_DIRETORIO = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
const ABRIR_ARQUIVO = C.O_RDONLY | C.O_NOFOLLOW;
const NOME_SIMPLES = /^[^/\0]+$/;
const idDoProcesso = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);
const invalido = (mensagem, detalhes) => erro('CAMINHO_OPERACIONAL_INVALIDO', mensagem, detalhes);

function nomeSimples(nome) {
  if (typeof nome !== 'string' || !NOME_SIMPLES.test(nome) || nome === '.' || nome === '..') throw invalido(`nome de entrada inválido: ${JSON.stringify(nome)}`);
  return nome;
}

// Diretório operacional confiável: real (nunca link), do usuário de execução e sem escrita para grupo ou outros.
function validarDiretorioConfiavel(info, uid = idDoProcesso(), rotulo = 'diretório operacional') {
  if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) throw invalido(`${rotulo} é um link simbólico; a árvore operacional precisa ser de diretórios reais`);
  if (!info.isDirectory()) throw invalido(`${rotulo} existe e não é diretório`);
  if (uid !== undefined && info.uid !== uid) throw erro('DIRETORIO_NAO_CONFIAVEL', `${rotulo} pertence a outro usuário (uid ${info.uid}); precisa ser do usuário de implantação`);
  if ((info.mode & 0o022) !== 0) throw erro('DIRETORIO_NAO_CONFIAVEL', `${rotulo} é gravável por grupo ou outros (modo ${(info.mode & 0o777).toString(8)}); use 0755 ou mais restrito`);
}

// Ancestral da base: real (nunca link), de root ou do usuário de execução, e sem escrita para grupo ou outros. Um
// diretório com o bit sticky e dono root (como /tmp) também serve: só o dono de cada entrada consegue renomeá-la.
function validarAncestral(info, uid, rotulo) {
  if (!info.isDirectory()) throw invalido(`${rotulo} existe e não é diretório`);
  const dono = info.uid === 0 || uid === undefined || info.uid === uid;
  if (!dono) throw erro('ANCESTRAL_NAO_CONFIAVEL', `${rotulo} pertence a outro usuário (uid ${info.uid}); todo ancestral da base precisa ser de root ou do usuário de implantação`);
  const gravavel = (info.mode & 0o022) !== 0;
  const sticky = (info.mode & 0o1000) !== 0 && info.uid === 0;
  if (gravavel && !sticky) throw erro('ANCESTRAL_NAO_CONFIAVEL', `${rotulo} é gravável por grupo ou outros (modo ${(info.mode & 0o7777).toString(8)}); quem escreve num ancestral da base pode redirecionar tudo o que está abaixo dele`);
}

const emTeste = () => process.env.NODE_ENV === 'test';

function procDisponivel(f) {
  try {
    const fd = f.openSync(path.sep, ABRIR_DIRETORIO);
    try {
      const a = f.fstatSync(fd);
      const b = f.statSync(`/proc/self/fd/${fd}/.`);
      return a.dev === b.dev && a.ino === b.ino;
    } finally { f.closeSync(fd); }
  } catch { return false; }
}

function criarAncora(opcoes = {}) {
  if (opcoes.fsImpl && !emTeste()) throw erro('ANCORA_DE_TESTE_FORA_DE_TESTE', 'um sistema de arquivos injetado (emulação) só é aceito em testes (NODE_ENV=test): emulação não é prova do kernel');
  const f = opcoes.fsImpl || fs;
  const uid = opcoes.uid === undefined ? idDoProcesso() : opcoes.uid;
  const pid = opcoes.pid || process.pid;
  let modo = opcoes.modo;
  if (modo === undefined) {
    if (process.platform === 'linux' && procDisponivel(f)) modo = 'proc';
    else throw erro('PLATAFORMA_SEM_ANCORA', 'a instalação exige âncoras por descritor (/proc/self/fd), que só existem em Linux: sem elas não há garantia contra a substituição concorrente de diretórios, e a operação fica bloqueada');
  } else if (modo === 'proc') {
    if (!procDisponivel(f)) throw erro('PLATAFORMA_SEM_ANCORA', '/proc/self/fd não está disponível: a âncora por descritor não pode ser usada');
  } else if (modo === 'caminho') {
    if (!emTeste()) throw erro('ANCORA_DE_TESTE_FORA_DE_TESTE', 'a âncora por caminho não protege contra substituição concorrente e só é aceita em testes (NODE_ENV=test)');
    if (opcoes.semGarantiaDeCorrida !== true) throw erro('ANCORA_SEM_GARANTIA_NAO_RECONHECIDA', 'a âncora por caminho não protege contra substituição concorrente de diretórios; exige semGarantiaDeCorrida: true e é só para testes e desenvolvimento');
  } else if (modo !== 'leitura') {
    throw erro('ANCORA_MODO_INVALIDO', `modo de âncora desconhecido: ${modo}`);
  }
  const porCaminho = modo === 'caminho' || modo === 'leitura';
  const somenteLeitura = modo === 'leitura';
  const exigirEscrita = (operacao) => {
    if (somenteLeitura) throw erro('ANCORA_SOMENTE_LEITURA', `a âncora de leitura não permite ${operacao}`);
  };

  const abertos = new Set();
  // Estado desta operação, nunca compartilhado com outra: a exigência de durabilidade e a contagem de fsync não suportado.
  const durabilidade = { naoSuportado: 0, exigir: opcoes.exigirDurabilidade === true };

  const novoDir = (fd, info, caminho) => {
    abertos.add(fd);
    return { fd, dev: info.dev, ino: info.ino, caminho, proc: modo === 'proc' ? `/proc/self/fd/${fd}` : caminho, modo };
  };
  const fechar = (dir) => {
    if (dir && abertos.delete(dir.fd)) { try { f.closeSync(dir.fd); } catch { /* já fechado */ } }
  };
  const fecharTudo = () => {
    for (const fd of [...abertos]) { abertos.delete(fd); try { f.closeSync(fd); } catch { /* já fechado */ } }
  };

  // Base do caminho usado nas chamadas. No modo 'caminho' confere a identidade antes de cada uso.
  function raiz(dir) {
    if (porCaminho) {
      let info;
      try { info = f.lstatSync(dir.caminho); } catch { throw invalido(`${dir.caminho} desapareceu durante a operação; nada foi gravado`); }
      if (!info.isDirectory() || info.dev !== dir.dev || info.ino !== dir.ino) throw invalido(`${dir.caminho} foi substituído durante a operação; nada foi gravado`);
    }
    return dir.proc;
  }
  const alvo = (dir, nome) => `${raiz(dir)}/${nomeSimples(nome)}`;

  function traduzir(falha, rotulo) {
    if (['ELOOP', 'ENOTDIR', 'ENOENT'].includes(falha.code)) return invalido(`${rotulo} não é um diretório real ou foi substituído (${falha.code}); nada foi gravado`);
    return falha;
  }

  function sincronizarDescritorDeDiretorio(fd) {
    try {
      f.fsyncSync(fd);
    } catch (falha) {
      if (falha.code !== 'EINVAL' && falha.code !== 'ENOTSUP') throw falha;
      if (durabilidade.exigir) throw erro('DURABILIDADE_NAO_SUPORTADA', 'o sistema de arquivos não suporta fsync de diretório e a durabilidade foi exigida; a operação foi recusada');
      durabilidade.naoSuportado += 1;
    }
  }
  const sincronizarDir = (dir) => sincronizarDescritorDeDiretorio(dir.fd);

  // validar: true (diretório operacional confiável), false (só diretório real, sem seguir link) ou função(info).
  function abrirPorNome(caminhoDeAbertura, caminhoInformativo, validar) {
    let fd;
    try { fd = f.openSync(caminhoDeAbertura, ABRIR_DIRETORIO); } catch (falha) { throw traduzir(falha, caminhoInformativo); }
    let info;
    try {
      info = f.fstatSync(fd);
      if (typeof validar === 'function') validar(info);
      else if (validar) validarDiretorioConfiavel(info, uid, caminhoInformativo);
    } catch (falha) { f.closeSync(fd); throw falha; }
    return novoDir(fd, info, caminhoInformativo);
  }
  // A base vem da configuração. O caminho é canonicalizado UMA vez e depois atravessado componente a componente a
  // partir da raiz, cada um aberto sem seguir link a partir do descritor do anterior (equivalente a openat), e cada
  // ancestral é validado no descritor realmente atravessado (de root ou do usuário de implantação, sem escrita para
  // grupo ou outros). Trocar um ancestral por um link depois da canonicalização faz a abertura falhar; trocá-lo por
  // outro diretório exigiria escrever num ancestral que já foi recusado se fosse gravável por terceiros.
  function abrirBase(caminhoAbsoluto) {
    if (!path.isAbsolute(caminhoAbsoluto)) throw invalido(`a base precisa ser um caminho absoluto: ${caminhoAbsoluto}`);
    const canonico = f.realpathSync(caminhoAbsoluto);
    const partes = canonico.split(path.sep).filter(Boolean);
    let atual = abrirPorNome(path.sep, path.sep, (info) => validarAncestral(info, uid, path.sep));
    let acumulado = '';
    try {
      for (let i = 0; i < partes.length; i += 1) {
        const ultimo = i === partes.length - 1;
        acumulado = `${acumulado}${path.sep}${partes[i]}`;
        const caminhoDeAbertura = modo === 'proc' ? `${atual.proc}/${partes[i]}` : acumulado;
        const proximo = abrirPorNome(caminhoDeAbertura, acumulado, ultimo ? (info) => validarDiretorioConfiavel(info, uid, acumulado) : (info) => validarAncestral(info, uid, acumulado));
        fechar(atual);
        atual = proximo;
      }
    } catch (falha) { fechar(atual); throw falha; }
    // Nos modos por caminho cada abertura resolve de novo todos os componentes pelo nome (O_NOFOLLOW só vale para o
    // último), então uma troca no meio da travessia só é detectável pelo resultado: o caminho precisa continuar
    // resolvendo para o mesmo diretório. No modo 'proc' a travessia é relativa a descritores e isto não é necessário.
    if (porCaminho) {
      let depois = null;
      try { depois = f.realpathSync(canonico); } catch { /* tratado abaixo */ }
      const info = f.fstatSync(atual.fd);
      let ident = null;
      try { ident = f.statSync(canonico); } catch { /* tratado abaixo */ }
      if (depois !== canonico || !ident || ident.dev !== info.dev || ident.ino !== info.ino) {
        fechar(atual);
        throw invalido(`${canonico} foi substituído durante a abertura; nada foi gravado`);
      }
    }
    return atual;
  }
  function abrirFilho(pai, nome, { criar = false, modo: permissao = 0o755, confiavel = true } = {}) {
    if (criar) exigirEscrita('criar diretório');
    const alvoAbs = alvo(pai, nome);
    let criado = false;
    if (criar) {
      try { f.mkdirSync(alvoAbs, { mode: permissao }); criado = true; } catch (falha) { if (falha.code !== 'EEXIST') throw falha; }
    }
    const dir = abrirPorNome(alvoAbs, path.join(pai.caminho, nome), confiavel);
    if (criado) sincronizarDir(pai);
    return dir;
  }

  // mkdir exclusivo (EEXIST propaga): é a base da trava de concorrência.
  function criarExclusivo(pai, nome, permissao = 0o755) {
    exigirEscrita('criar diretório');
    f.mkdirSync(alvo(pai, nome), { mode: permissao });
    const dir = abrirPorNome(alvo(pai, nome), path.join(pai.caminho, nome), true);
    try {
      sincronizarDir(pai);
    } catch (falha) {
      // Sem a sincronização exigida a trava não vale: não deixa um diretório de trava para trás.
      fechar(dir);
      try { f.rmdirSync(alvo(pai, nome)); } catch { /* fica para remoção manual */ }
      throw falha;
    }
    return dir;
  }

  const tipo = (dir, nome) => {
    try { return f.lstatSync(alvo(dir, nome)); } catch (falha) { if (falha.code === 'ENOENT') return null; throw falha; }
  };
  const listar = (dir) => f.readdirSync(raiz(dir), { withFileTypes: true }).map((e) => ({ nome: e.name, ehDiretorio: e.isDirectory(), ehArquivo: e.isFile(), ehLink: e.isSymbolicLink() }));
  const lerLink = (dir, nome) => {
    try { return f.readlinkSync(alvo(dir, nome)); } catch (falha) { if (falha.code === 'ENOENT' || falha.code === 'EINVAL') return null; throw falha; }
  };

  // Abre sem seguir link e confere NO DESCRITOR: arquivo regular e, por padrão, um único link. Um inode com mais de um
  // link pode ser o mesmo de outro caminho (por exemplo, um dado persistente): ler, gravar, alterar permissões ou
  // sincronizar por esse nome agiria sobre o outro caminho também. Só a sincronização de uma subárvore que não é do
  // pacote (node_modules) dispensa a exigência.
  function comArquivo(dir, nome, fn, { exigirLinkUnico = true } = {}) {
    let fd;
    try { fd = f.openSync(alvo(dir, nome), ABRIR_ARQUIVO); } catch (falha) {
      if (falha.code === 'ENOENT') return fn(null);
      if (falha.code === 'ELOOP') throw invalido(`${nome} é um link simbólico; apenas arquivos regulares são aceitos`);
      throw falha;
    }
    try {
      const info = f.fstatSync(fd);
      if (!info.isFile()) throw invalido(`${nome} não é arquivo regular`);
      if (exigirLinkUnico && info.nlink !== 1) throw erro('ARQUIVO_COMPARTILHADO', `${nome} tem ${info.nlink} links: o mesmo inode pode ser de outro caminho, e nada é lido nem alterado por este nome`);
      return fn({
        info,
        ler: () => f.readFileSync(fd),
        chmod: (m) => { exigirEscrita('alterar permissões'); f.fchmodSync(fd, m); },
        sincronizar: () => f.fsyncSync(fd),
      });
    } finally { f.closeSync(fd); }
  }
  const lerBytes = (dir, nome) => comArquivo(dir, nome, (a) => (a ? a.ler() : null));
  const lerTexto = (dir, nome) => comArquivo(dir, nome, (a) => (a ? a.ler().toString('utf8') : null));

  function gravarTudo(fd, texto) {
    const buffer = Buffer.from(texto, 'utf8');
    let escrito = 0;
    while (escrito < buffer.length) escrito += f.writeSync(fd, buffer, escrito, buffer.length - escrito);
  }
  // Arquivo temporário exclusivo (um link pré-existente com o nome é removido, nunca seguido), conteúdo e renomeação
  // sincronizados em disco.
  function escreverAtomico(dir, nome, texto, permissao = 0o644) {
    exigirEscrita('gravar arquivo');
    const temporario = `${nomeSimples(nome)}.tmp-${pid}`;
    let fd;
    try {
      fd = f.openSync(alvo(dir, temporario), 'wx', permissao);
    } catch (falha) {
      if (falha.code !== 'EEXIST') throw falha;
      f.unlinkSync(alvo(dir, temporario));
      fd = f.openSync(alvo(dir, temporario), 'wx', permissao);
    }
    try {
      gravarTudo(fd, texto);
      f.fsyncSync(fd);
    } catch (falha) {
      try { f.closeSync(fd); } catch { /* já tratado */ }
      try { f.unlinkSync(alvo(dir, temporario)); } catch { /* não existe */ }
      throw falha;
    }
    f.closeSync(fd);
    try {
      f.renameSync(alvo(dir, temporario), alvo(dir, nome));
    } catch (falha) {
      try { f.unlinkSync(alvo(dir, temporario)); } catch { /* não existe */ }
      throw falha;
    }
    sincronizarDir(dir);
  }
  // Diário: anexa uma linha com O_APPEND, sem seguir link, modo 0600, fsync; se a cauda foi truncada por uma queda
  // (sem \n final), a nova entrada começa em linha própria. Um arquivo que já existe é aberto SEM criar e conferido no
  // descritor (regular, do usuário de execução, um único link) antes da primeira gravação: gravar em um inode
  // compartilhado alteraria também o outro caminho. Só o arquivo que não existe é criado, de forma exclusiva.
  function anexar(dir, nome, texto) {
    exigirEscrita('anexar ao diário');
    const aberto = C.O_RDWR | C.O_APPEND | C.O_NOFOLLOW;
    let fd;
    let criado = false;
    try {
      try {
        fd = f.openSync(alvo(dir, nome), aberto);
      } catch (falha) {
        if (falha.code !== 'ENOENT') throw falha;
        fd = f.openSync(alvo(dir, nome), aberto | C.O_CREAT | C.O_EXCL, 0o600);
        criado = true;
      }
    } catch (falha) {
      throw erro('DIARIO_INVALIDO', `não foi possível abrir ${nome} (${falha.code || falha.message})`);
    }
    try {
      const info = f.fstatSync(fd);
      if (!info.isFile()) throw erro('DIARIO_INVALIDO', `${nome} não é arquivo regular`);
      if (info.nlink !== 1) throw erro('DIARIO_INVALIDO', `${nome} tem ${info.nlink} links: o mesmo inode pode ser de outro caminho e nada foi gravado`);
      if (uid !== undefined && info.uid !== uid) throw erro('DIARIO_INVALIDO', `${nome} pertence a outro usuário (uid ${info.uid}) e nada foi gravado`);
      const { size } = info;
      let prefixo = '';
      if (size > 0) {
        const ultimo = Buffer.alloc(1);
        f.readSync(fd, ultimo, 0, 1, size - 1);
        if (ultimo[0] !== 0x0a) prefixo = '\n';
      }
      gravarTudo(fd, prefixo + texto);
      f.fsyncSync(fd);
      // Um link criado depois da conferência para este inode não altera o dado de outro caminho, mas é registrado como falha.
      if (f.fstatSync(fd).nlink !== 1) throw erro('DIARIO_INVALIDO', `${nome} passou a ter mais de um link durante a gravação`);
    } finally { f.closeSync(fd); }
    if (criado) sincronizarDir(dir);
  }
  function trocarLink(dir, nome, alvoRelativo) {
    exigirEscrita('trocar link');
    const temporario = `${nomeSimples(nome)}.novo-${pid}-${Date.now()}`;
    try {
      f.symlinkSync(alvoRelativo, alvo(dir, temporario));
      f.renameSync(alvo(dir, temporario), alvo(dir, nome));
    } catch (falha) {
      try { f.unlinkSync(alvo(dir, temporario)); } catch { /* não existe */ }
      throw falha;
    }
    sincronizarDir(dir);
  }
  const criarLink = (dir, nome, destino) => { exigirEscrita('criar link'); return f.symlinkSync(destino, alvo(dir, nome)); };
  function removerEntrada(dir, nome) {
    exigirEscrita('remover entrada');
    try { f.unlinkSync(alvo(dir, nome)); } catch (falha) { if (falha.code !== 'ENOENT') throw falha; }
    sincronizarDir(dir);
  }
  const renomear = (deDir, de, paraDir, para) => { exigirEscrita('renomear'); return f.renameSync(alvo(deDir, de), alvo(paraDir, para)); };
  function copiarArquivo(origemAbsoluta, dir, nome) {
    exigirEscrita('copiar arquivo');
    f.copyFileSync(origemAbsoluta, alvo(dir, nome), C.COPYFILE_EXCL);
    return comArquivo(dir, nome, (a) => {
      if (!a) throw invalido(`${nome} sumiu depois da cópia`);
      return { dev: a.info.dev, ino: a.info.ino };
    });
  }
  const tornarSomenteLeitura = (dir) => { exigirEscrita('alterar permissões'); f.fchmodSync(dir.fd, 0o555); };
  const identidade = (dir) => ({ dev: dir.dev, ino: dir.ino });
  const mesmaIdentidade = (a, b) => a.dev === b.dev && a.ino === b.ino;
  // Identidade do que o nome alcança SEGUINDO links (por exemplo, o diretório para o qual o link de release aponta
  // agora), para conferir o destino efetivo de um ponteiro contra o diretório que se manteve aberto.
  function alcancar(dir, nome) {
    try {
      const info = f.statSync(alvo(dir, nome));
      return { dev: info.dev, ino: info.ino, ehDiretorio: info.isDirectory() };
    } catch (falha) { if (falha.code === 'ENOENT' || falha.code === 'ENOTDIR' || falha.code === 'ELOOP') return null; throw falha; }
  }

  // Remoção recursiva ancorada. Cada diretório é aberto SEM seguir link a partir do pai e só é esvaziado se o
  // descritor aberto for a entrada esperada: a identidade informada por quem chamou ou, sem ela, a vista pelo lstat
  // imediatamente antes da abertura. Uma entrada trocada entre a conferência e a abertura nunca é esvaziada. O rmdir
  // final só remove diretório vazio, então uma troca depois da conferência não apaga conteúdo de terceiros. Um link
  // vira só um unlink do link. Nunca usa fs.rmSync (que resolve a árvore por nome).
  function removerInterno(pai, nome, esperada) {
    const alvoAbs = alvo(pai, nome);
    let info;
    try { info = f.lstatSync(alvoAbs); } catch (falha) { if (falha.code === 'ENOENT') return false; throw falha; }
    if (!info.isDirectory()) {
      if (esperada) throw invalido(`${nome} foi substituído; não será removido`);
      f.unlinkSync(alvoAbs);
      return true;
    }
    const visto = esperada || { dev: info.dev, ino: info.ino };
    const filho = abrirPorNome(alvoAbs, path.join(pai.caminho, nome), false);
    try {
      if (filho.dev !== visto.dev || filho.ino !== visto.ino) throw invalido(`${nome} foi substituído; não será removido`);
      f.fchmodSync(filho.fd, 0o755);
      for (const e of listar(filho)) removerInterno(filho, e.nome);
    } finally { fechar(filho); }
    f.rmdirSync(alvoAbs);
    return true;
  }
  function removerArvore(pai, nome, { identidade: esperada } = {}) {
    exigirEscrita('remover árvore');
    if (!removerInterno(pai, nome, esperada)) return false;
    sincronizarDir(pai);
    return true;
  }
  // Diretório de trabalho entregue a um processo externo (npm). No modo 'proc' é o inode já verificado, resolvido pelo
  // kernel no momento do spawn, e não um nome que alguém possa trocar depois.
  const cwdParaProcessoExterno = (dir) => (modo === 'proc' ? `/proc/${pid}/fd/${dir.fd}` : dir.caminho);

  return {
    modo, garantiaContraCorrida: modo === 'proc', durabilidade,
    abrirBase, abrirFilho, criarExclusivo, fechar, fecharTudo, tipo, listar, lerLink, comArquivo, lerBytes, lerTexto,
    escreverAtomico, anexar, trocarLink, criarLink, removerEntrada, renomear, copiarArquivo,
    sincronizarDir, tornarSomenteLeitura, identidade, mesmaIdentidade, alcancar, removerArvore, cwdParaProcessoExterno,
  };
}

module.exports = { criarAncora, validarDiretorioConfiavel, validarAncestral, nomeSimples, procDisponivel };
