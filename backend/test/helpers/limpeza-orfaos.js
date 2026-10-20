'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./verificacao-imagens');

/**
 * Apoio dos testes da LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED). Só serve a testes.
 *
 *   - cenários em diretórios temporários EXCLUSIVOS (test/storage/helpers/tmp-seguro.js): conjuntos órfãos, temporários e entradas estranhas com idade definida
 *     pelo mtime contra um relógio injetado (AGORA); as imagens registradas vêm de test/helpers/verificacao-imagens.js;
 *   - um banco FALSO que, além do que o verificador consulta, entende o que a limpeza consulta (trava da biblioteca da empresa, transação, registro por empresa + SHA-256)
 *     e registra tudo numa linha do tempo, para provar a ORDEM das operações;
 *   - uma fachada de arquivos que só tem as operações permitidas à limpeza (as quatro de leitura do verificador + unlink + rmdir) e registra cada chamada.
 *
 * Nenhuma função lê variável de ambiente da aplicação nem toca em pasta real de imagens, de backup ou de documentos.
 */

const AGORA = Date.parse('2026-10-18T12:00:00.000Z');
const MINUTO = h.MINUTO;
const DIA = h.DIA_EM_MINUTOS;
const NOMES_PNG = Object.freeze(['mestre.png', 'exibicao.webp', 'miniatura.webp']);
const HEX64 = /^[0-9a-f]{64}$/;
const FORMATO_DO_MESTRE = { png: 'PNG', jpg: 'JPEG', webp: 'WEBP' };

const formatoDoArquivo = (nome) => (nome.startsWith('mestre.') ? FORMATO_DO_MESTRE[nome.split('.')[1]] : 'WEBP');
const erroDoSistema = (codigo) => Object.assign(new Error(`${codigo}: falha simulada do sistema de arquivos`), { code: codigo, syscall: 'simulada' });

/** Fixa atime e mtime de um caminho (arquivo ou pasta) em `agora - idadeMin`. */
function envelhecer(caminho, idadeMin, agora = AGORA) {
  const t = (agora - idadeMin * MINUTO) / 1000;
  fs.utimesSync(caminho, t, t);
}

/**
 * Conjunto SEM registro (órfão): <empresa|padrao>/<hash>/<variantes>. Todos os arquivos e a pasta recebem a mesma idade. `variantes: []` cria a pasta vazia.
 * Devolve também o conteúdo de cada arquivo, para o teste comparar o SHA-256 que o relatório informa.
 */
function criarOrfao(raiz, { escopo = 'EMPRESA', empresaId = 7, semente, idadeMin = 3 * DIA, variantes = NOMES_PNG, agora = AGORA, hash: hashFixo = null } = {}) {
  if (typeof semente !== 'string' || semente === '') throw new TypeError('semente obrigatória');
  if (hashFixo !== null && !HEX64.test(hashFixo)) throw new TypeError('hash inválido');
  const ns = escopo === 'PADRAO' ? 'padrao' : String(empresaId);
  const hash = hashFixo ?? h.hex64(`orfao-${semente}`);
  const pasta = path.join(raiz, ns, hash);
  const conteudos = {};
  const caminhos = {};
  for (const nome of variantes) {
    conteudos[nome] = h.conteudoDe(formatoDoArquivo(nome), `${semente}-${nome}`, nome.startsWith('mestre') ? 300 : 120);
    caminhos[nome] = h.gravarNaRaiz(raiz, `${ns}/${hash}/${nome}`, conteudos[nome], { agora, minutosAtras: idadeMin });
  }
  if (variantes.length === 0) fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  envelhecer(pasta, idadeMin, agora);
  return {
    escopo,
    empresaId: escopo === 'PADRAO' ? null : empresaId,
    ns,
    hash,
    pasta,
    relPasta: `${ns}/${hash}`,
    conteudos,
    caminhos,
    existe: () => fs.existsSync(pasta),
    nomes: () => (fs.existsSync(pasta) ? fs.readdirSync(pasta).sort() : []),
  };
}

/** Resíduo de gravação (`<variante>.<16 hex>.tmp`) dentro de uma pasta de imagem. */
function criarTemporario(raiz, { empresaId = 7, hash, nome = 'mestre.png', idadeMin = 3 * DIA, agora = AGORA }) {
  if (!HEX64.test(hash)) throw new TypeError('hash inválido');
  const arquivo = `${nome}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const caminho = h.gravarNaRaiz(raiz, `${empresaId}/${hash}/${arquivo}`, Buffer.from('gravacao-interrompida'), { agora, minutosAtras: idadeMin });
  return { nome: arquivo, caminho };
}

/** Linha de registro (como o PostgreSQL a entrega ao verificador) que COBRE um conjunto de arquivos já gravado: o conjunto deixa de ser órfão. */
function linhaQueCobre(orfao, { id, estado = 'ATIVA', formato = 'PNG' } = {}) {
  const mestre = Object.keys(orfao.conteudos).find((n) => n.startsWith('mestre.'));
  return {
    id: String(id),
    empresa_id: orfao.empresaId,
    sha256: orfao.hash,
    sha256_mestre: h.sha(orfao.conteudos[mestre]),
    sha256_exibicao: h.sha(orfao.conteudos['exibicao.webp']),
    sha256_miniatura: h.sha(orfao.conteudos['miniatura.webp']),
    formato,
    bytes_mestre: orfao.conteudos[mestre].length,
    bytes_exibicao: orfao.conteudos['exibicao.webp'].length,
    bytes_miniatura: orfao.conteudos['miniatura.webp'].length,
    estado,
  };
}

/** Descritor de uma imagem JÁ PROCESSADA (o que `registrarEmpresa` recebe) que corresponde aos arquivos de um conjunto: serve para "adotar" o órfão por um envio. */
function descritorQueCobre(orfao) {
  const mestre = Object.keys(orfao.conteudos).find((n) => n.startsWith('mestre.'));
  return {
    sha256: orfao.hash,
    sha256Mestre: h.sha(orfao.conteudos[mestre]),
    sha256Exibicao: h.sha(orfao.conteudos['exibicao.webp']),
    sha256Miniatura: h.sha(orfao.conteudos['miniatura.webp']),
    formato: formatoDoArquivo(mestre),
    largura: 1024,
    altura: 1024,
    bytesMestre: orfao.conteudos[mestre].length,
    bytesExibicao: orfao.conteudos['exibicao.webp'].length,
    bytesMiniatura: orfao.conteudos['miniatura.webp'].length,
  };
}

/**
 * Banco FALSO da limpeza: tudo o que o verificador consulta (via test/helpers/verificacao-imagens.js) mais o que a limpeza faz por conjunto: abrir transação, tomar a
 * trava da biblioteca (qualquer SQL com "advisory"), configurar a sessão (SET), reler o registro por (empresa, SHA-256) e confirmar. `empresa` é uma lista MUTÁVEL: o teste
 * a altera para simular um registro que aparece depois do plano. `eventos` é a linha do tempo (BEGIN, TRAVA, REGISTRO, COMMIT, ROLLBACK, RELEASE e, quando
 * ligada à fachada, FS). `aoConsultar(sql, params)` deixa o teste observar o mundo a cada comando (por exemplo, se o arquivo da janela existe).
 * IMPORTANTE: `empresas` precisa listar as empresas que existem, senão a pasta de uma empresa sem imagens registradas vira "empresa inexistente" (INVESTIGAR).
 */
function criarBancoDeLimpeza({
  empresas = null, empresa = [], padrao = [], usoEmpresa = [], usoPadrao = [], banco = { nome: 'banco_falso', oid: '424242' }, aoConsultar = null, falharEm = null, eventos = [],
} = {}) {
  const base = h.poolFalso({
    padrao, empresa, empresas, usoEmpresa, usoPadrao, banco, falharEm,
  });
  const normalizar = (texto) => String(texto).replace(/\s+/g, ' ').trim();
  const contadores = { conexoes: 0, liberacoes: 0 };

  /** Linha de resultado que responde "verdadeiro" a qualquer coluna pedida (por exemplo, o alias de um pg_try_advisory_xact_lock): a trava do banco falso sempre é concedida. */
  const linhaSempreVerdadeira = () => new Proxy({}, { get: (_alvo, propriedade) => (propriedade === 'then' ? undefined : true) });

  async function atender(texto, params, delegar) {
    const t = normalizar(texto);
    if (aoConsultar) await aoConsultar(t, params);
    if (/^(?:BEGIN|START TRANSACTION)\b/i.test(t)) { base.sql.push(t); eventos.push({ tipo: 'BEGIN', sql: t }); return { rows: [], rowCount: null }; }
    if (/^ROLLBACK\b/i.test(t)) { base.sql.push(t); eventos.push({ tipo: 'ROLLBACK' }); return { rows: [], rowCount: null }; }
    if (/^COMMIT\b/i.test(t)) { base.sql.push(t); eventos.push({ tipo: 'COMMIT' }); return { rows: [], rowCount: null }; }
    if (/^SET\b/i.test(t) || /\bset_config\s*\(/i.test(t)) { base.sql.push(t); eventos.push({ tipo: 'CONFIG', sql: t }); return { rows: [{ set_config: '' }], rowCount: 1 }; }
    if (/advisory/i.test(t)) {
      base.sql.push(t);
      eventos.push({ tipo: 'TRAVA', sql: t, params });
      return { rows: [linhaSempreVerdadeira()], rowCount: 1 };
    }
    if (/FROM imagens_empresa/i.test(t) && Array.isArray(params) && params.some((p) => typeof p === 'string' && HEX64.test(p))) {
      base.sql.push(t);
      const sha = params.find((p) => typeof p === 'string' && HEX64.test(p));
      const empresaId = params.find((p) => Number.isInteger(p));
      eventos.push({ tipo: 'REGISTRO', empresaId, sha });
      const achadas = empresa.filter((l) => l.empresa_id === empresaId && l.sha256 === sha);
      if (/\bEXISTS\b/i.test(t) || /\bcount\s*\(/i.test(t)) {
        return { rows: [{ exists: achadas.length > 0, existe: achadas.length > 0, count: String(achadas.length), n: achadas.length }], rowCount: 1 };
      }
      return { rows: achadas.map((l) => ({ nome: 'Imagem de teste', largura: 1024, altura: 1024, versao: 1, criado_por: 1, ...l })), rowCount: achadas.length };
    }
    return delegar(texto, params);
  }

  return {
    async connect() {
      contadores.conexoes += 1;
      const cliente = await base.connect();
      return {
        query: (texto, params) => atender(texto, params, (t, p) => cliente.query(t, p)),
        release() { contadores.liberacoes += 1; eventos.push({ tipo: 'RELEASE' }); cliente.release(); },
      };
    },
    query: (texto, params) => atender(texto, params, (t, p) => base.query(t, p)),
    sql: base.sql,
    eventos,
    contadores,
    registro: empresa,
  };
}

/**
 * Fachada de arquivos da limpeza: as quatro leituras do verificador (lstat, readdir, realpath, open) mais SÓ unlink e rmdir. Registra cada chamada em `chamadas` e,
 * se `eventos` for informado, as operações DESTRUTIVAS também na linha do tempo do banco falso. `falhas`: [{ metodo, ondeIgual|ondeTermina|ondeContem, codigo }] com o
 * caminho RELATIVO à raiz, como em h.fachadaDeLeitura.
 */
function fachadaDeLimpeza(raiz, { falhas = [], eventos = null, inverterListagens = false } = {}) {
  const base = h.fachadaDeLeitura(raiz, { falhas, inverterListagens });
  const relativo = (p) => path.relative(raiz, p);
  const falhaDe = (metodo, rel) => falhas.find((f) => f.metodo === metodo
    && (f.ondeIgual === undefined || rel === f.ondeIgual)
    && (f.ondeTermina === undefined || rel.endsWith(f.ondeTermina))
    && (f.ondeContem === undefined || rel.includes(f.ondeContem)));
  const destrutiva = async (metodo, caminho, executar) => {
    const rel = relativo(caminho);
    base.chamadas.push({ metodo, rel });
    if (eventos) eventos.push({ tipo: 'FS', metodo, rel });
    const falha = falhaDe(metodo, rel);
    if (falha) throw erroDoSistema(falha.codigo);
    return executar(caminho);
  };
  /**
   * `open` devolve um manipulador que DELEGA ao FileHandle real (stat, read, readFile, createReadStream, close, ...), registrando cada chamada: uma implementação pode
   * calcular o SHA-256 de um arquivo por qualquer um desses caminhos. Falha de `read` pode ser injetada como em h.fachadaDeLeitura.
   */
  const abrir = async (caminho, flags) => {
    const rel = relativo(caminho);
    base.chamadas.push({ metodo: 'open', rel, flags });
    const falha = falhaDe('open', rel);
    if (falha) throw erroDoSistema(falha.codigo);
    const real = await fsp.open(caminho, flags);
    const falhaDeLeitura = falhas.find((f) => f.metodo === 'read' && (f.ondeTermina === undefined || rel.endsWith(f.ondeTermina)));
    return new Proxy(real, {
      get(alvo, propriedade) {
        const valor = Reflect.get(alvo, propriedade, alvo);
        if (typeof valor !== 'function') return valor;
        return (...argumentos) => {
          base.chamadas.push({ metodo: String(propriedade), rel });
          if (propriedade === 'read' && falhaDeLeitura) return Promise.reject(erroDoSistema(falhaDeLeitura.codigo));
          return valor.apply(alvo, argumentos);
        };
      },
    });
  };
  const fachada = Object.freeze({
    constants: base.fs.constants,
    lstat: base.fs.lstat,
    readdir: base.fs.readdir,
    realpath: base.fs.realpath,
    open: abrir,
    unlink: (caminho) => destrutiva('unlink', caminho, fsp.unlink),
    rmdir: (caminho) => destrutiva('rmdir', caminho, fsp.rmdir),
  });
  return {
    fs: fachada,
    chamadas: base.chamadas,
    destrutivas: () => base.chamadas.filter((c) => c.metodo === 'unlink' || c.metodo === 'rmdir'),
  };
}

/** Documento que a trava de janela leva (protocolo compartilhado com o procedimento de backup, que a cria à mão). */
function documentoDaTrava({
  tipo = 'BACKUP', pid = 424242, hospedeiro = 'maquina-de-teste', iniciadoEm = new Date(AGORA).toISOString(), token = crypto.randomBytes(16).toString('hex'),
} = {}) {
  return {
    versao: 1, tipo, pid, hospedeiro, iniciadoEm, token,
  };
}

/** Cria, à mão e de forma exclusiva, a trava de janela de OUTRO dono (por exemplo, um backup em andamento). */
function escreverTravaAlheia(arquivo, extra = {}) {
  const documento = documentoDaTrava(extra);
  fs.writeFileSync(arquivo, `${JSON.stringify(documento)}\n`, { flag: 'wx', mode: 0o600 });
  return documento;
}

/** PID de um processo que acabou de existir e já terminou (para provar que trava "órfã" não é quebrada sozinha). */
function pidMorto() {
  const filho = spawnSync(process.execPath, ['-e', '0']);
  const { pid } = filho;
  try { process.kill(pid, 0); } catch { return pid; }
  throw new Error('o processo de teste ainda está vivo');
}

/** Posição do primeiro evento da linha do tempo que satisfaz o predicado (-1 se não houver). */
const primeiro = (eventos, predicado) => eventos.findIndex(predicado);
const ultimo = (eventos, predicado) => { for (let i = eventos.length - 1; i >= 0; i -= 1) if (predicado(eventos[i])) return i; return -1; };

/** Texto sem nenhum caractere de controle (exceto quebra de linha) e sem o caminho absoluto: a regra de saída do verificador. */
const saidaLimpa = (texto, raiz) => !texto.includes(raiz) && !/(?!\n)\p{Cc}/u.test(texto);

/**
 * "Mundo" padrão dos testes de serviço e de comando: um armazenamento temporário com `registradas` imagens da empresa INTEGRAS (para o banco nunca parecer vazio:
 * o verificador desconfia de um banco sem registro algum), os órfãos pedidos, o banco falso e a fachada de arquivos ligados à MESMA linha do tempo, e uma pasta
 * separada para o arquivo da janela. `novaRaiz` vem do arquivo de teste, que cuida da limpeza dos diretórios temporários.
 * `orfaos`: lista de opções de criarOrfao (semente obrigatória). Devolve as imagens registradas e os órfãos na mesma ordem em que foram pedidos.
 */
function criarMundo(novaRaiz, { orfaos = [], registradas = 1, empresas = [7], bancoOpcoes = {}, falhasFs = [], inverterListagens = false } = {}) {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  const imagens = [];
  for (let id = 1; id <= registradas; id += 1) imagens.push(h.criarImagemEmpresa(raiz, { id, empresaId: empresas[0], semente: `reg-${id}`, agora: AGORA }));
  const criados = orfaos.map((opcoes) => criarOrfao(raiz, { empresaId: empresas[0], ...opcoes }));
  const eventos = [];
  const banco = criarBancoDeLimpeza({
    empresas, empresa: imagens.map((i) => i.linha), eventos, ...bancoOpcoes,
  });
  const arquivos = fachadaDeLimpeza(raiz, { eventos, falhas: falhasFs, inverterListagens });
  return {
    raiz,
    pastaDaTrava,
    arquivoDaJanela: path.join(pastaDaTrava, 'janela-imagens.lock'),
    registradas: imagens,
    orfaos: criados,
    banco,
    eventos,
    fs: arquivos.fs,
    chamadas: arquivos.chamadas,
    destrutivas: arquivos.destrutivas,
    retrato: () => h.retratoDaArvore(raiz),
  };
}

module.exports = {
  AGORA, MINUTO, DIA, NOMES_PNG, h,
  envelhecer, criarOrfao, criarTemporario, linhaQueCobre, descritorQueCobre,
  criarBancoDeLimpeza, fachadaDeLimpeza, documentoDaTrava, escreverTravaAlheia, pidMorto, primeiro, ultimo, saidaLimpa, criarMundo,
};
