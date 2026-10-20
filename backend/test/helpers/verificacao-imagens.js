'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Cenários dos testes do verificador de integridade das imagens (Biblioteca de Imagens, Unidade 5C-5).
 *
 * Tudo aqui trabalha em diretórios temporários EXCLUSIVOS (test/storage/helpers/tmp-seguro.js) e com um banco FALSO em memória, exceto nos testes de
 * integração, que usam o PostgreSQL de testes em schema temporário. Nenhuma função lê variável de ambiente da aplicação nem toca em pasta real de imagens.
 * O relógio é sempre injetado: a idade de um arquivo é definida pelo mtime que o teste grava, contra o `agora` que o teste passa ao verificador.
 */

const MINUTO = 60 * 1000;
const DIA_EM_MINUTOS = 24 * 60;
const EXTENSAO = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp' };

const sha = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
const hex64 = (semente) => sha(`semente:${semente}`);

function bytesDe(semente, tamanho) {
  const partes = [];
  let total = 0;
  for (let i = 0; total < tamanho; i += 1) {
    const parte = crypto.createHash('sha256').update(`${semente}:${i}`).digest();
    partes.push(parte);
    total += parte.length;
  }
  return Buffer.concat(partes).subarray(0, tamanho);
}

const CABECALHOS = {
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
};

/** Bytes determinísticos com a ASSINATURA do formato (PNG, JPEG ou WEBP), para a verificação de assinatura ter o que conferir. */
function conteudoDe(formato, semente, tamanho = 256) {
  const corpo = Buffer.from(bytesDe(semente, tamanho));
  if (formato === 'WEBP') {
    corpo.write('RIFF', 0, 'latin1');
    corpo.writeUInt32LE(tamanho - 8, 4);
    corpo.write('WEBP', 8, 'latin1');
    return corpo;
  }
  CABECALHOS[formato].copy(corpo);
  return corpo;
}

/** Grava um arquivo no lugar da chave, com pastas 0700 e arquivo 0600 (como o armazenamento), e fixa o mtime em `agora - minutosAtras`. */
function gravarNaRaiz(raiz, chave, conteudo, { agora, minutosAtras = 7 * DIA_EM_MINUTOS, modo = 0o600 } = {}) {
  const arquivo = path.join(raiz, ...chave.split('/'));
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
  fs.writeFileSync(arquivo, conteudo, { mode: modo });
  fs.chmodSync(arquivo, modo);
  if (agora !== undefined) {
    const t = (agora - minutosAtras * MINUTO) / 1000;
    fs.utimesSync(arquivo, t, t);
  }
  return arquivo;
}

/** Imagem da empresa: a pasta leva o SHA-256 do envio; as três variantes são gravadas (menos as de `ausentes`). Devolve a linha como o PostgreSQL a entrega. */
function criarImagemEmpresa(raiz, { id, empresaId, formato = 'PNG', semente = `e${id}`, agora, minutosAtras, ausentes = [], estado = 'ATIVA' }) {
  const conteudos = {
    mestre: conteudoDe(formato, `${semente}-m`, 300),
    exibicao: conteudoDe('WEBP', `${semente}-x`, 200),
    miniatura: conteudoDe('WEBP', `${semente}-n`, 100),
  };
  const shaEnvio = hex64(`envio-${semente}`);
  const pasta = `${empresaId}/${shaEnvio}`;
  const chaves = { mestre: `${pasta}/mestre.${EXTENSAO[formato]}`, exibicao: `${pasta}/exibicao.webp`, miniatura: `${pasta}/miniatura.webp` };
  for (const variante of Object.keys(chaves)) {
    if (!ausentes.includes(variante)) gravarNaRaiz(raiz, chaves[variante], conteudos[variante], { agora, minutosAtras });
  }
  const linha = {
    id: String(id),
    empresa_id: empresaId,
    sha256: shaEnvio,
    sha256_mestre: sha(conteudos.mestre),
    sha256_exibicao: sha(conteudos.exibicao),
    sha256_miniatura: sha(conteudos.miniatura),
    formato,
    bytes_mestre: conteudos.mestre.length,
    bytes_exibicao: conteudos.exibicao.length,
    bytes_miniatura: conteudos.miniatura.length,
    estado,
  };
  return { linha, chaves, conteudos, pasta, shaEnvio, caminho: (variante) => path.join(raiz, ...chaves[variante].split('/')) };
}

/** Imagem padrão: a pasta leva o SHA-256 do mestre (é o `sha256` do registro); a exibição é opcional. */
function criarImagemPadrao(raiz, { id, formato = 'PNG', comExibicao = false, semente = `p${id}`, agora, minutosAtras, ausentes = [] }) {
  const conteudos = {
    mestre: conteudoDe(formato, `${semente}-m`, 300),
    miniatura: conteudoDe('WEBP', `${semente}-n`, 100),
  };
  if (comExibicao) conteudos.exibicao = conteudoDe('WEBP', `${semente}-x`, 200);
  const shaMestre = sha(conteudos.mestre);
  const pasta = `padrao/${shaMestre}`;
  const chaves = { mestre: `${pasta}/mestre.${EXTENSAO[formato]}`, miniatura: `${pasta}/miniatura.webp` };
  if (comExibicao) chaves.exibicao = `${pasta}/exibicao.webp`;
  for (const variante of Object.keys(chaves)) {
    if (!ausentes.includes(variante)) gravarNaRaiz(raiz, chaves[variante], conteudos[variante], { agora, minutosAtras });
  }
  const linha = {
    id: String(id),
    sha256: shaMestre,
    sha256_miniatura: sha(conteudos.miniatura),
    sha256_exibicao: comExibicao ? sha(conteudos.exibicao) : null,
    formato,
    bytes_mestre: conteudos.mestre.length,
    bytes_miniatura: conteudos.miniatura.length,
    bytes_exibicao: comExibicao ? conteudos.exibicao.length : null,
    ativo: true,
  };
  return { linha, chaves, conteudos, pasta, shaMestre, caminho: (variante) => path.join(raiz, ...chaves[variante].split('/')) };
}

/**
 * Banco FALSO que cumpre só o que o verificador usa (`connect` → `query`/`release`, e `query` direto). Responde por trechos do SQL e emula a paginação por
 * chave (`id > $1 ... LIMIT $2`), para um erro de paginação aparecer de verdade. Guarda todo SQL recebido e os eventos de conexão.
 */
function poolFalso({
  padrao = [], empresa = [], empresas = null, usoPadrao = [], usoEmpresa = [], banco = { nome: 'banco_falso', oid: '424242' }, falharEm = null,
} = {}) {
  const sql = [];
  const eventos = [];
  const idsDeEmpresas = empresas ?? [...new Set(empresa.map((linha) => linha.empresa_id))];
  const pagina = (linhas, params) => {
    const [depoisDe, limite] = params;
    return linhas.filter((linha) => BigInt(linha.id) > BigInt(depoisDe)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, limite);
  };
  async function responder(texto, params) {
    const t = String(texto).replace(/\s+/g, ' ').trim();
    sql.push(t);
    if (falharEm !== null && t.includes(falharEm)) throw Object.assign(new Error('falha simulada do banco'), { code: 'XX000' });
    if (/^(BEGIN|ROLLBACK)/i.test(t)) return { rows: [] };
    if (/current_database\(\)/i.test(t)) return { rows: [{ nome: banco.nome, oid: banco.oid }] };
    if (/FROM materiais/i.test(t) && /imagem_padrao_id/i.test(t)) return { rows: usoPadrao };
    if (/FROM materiais/i.test(t) && /imagem_empresa_id/i.test(t)) return { rows: usoEmpresa };
    if (/FROM imagens_padrao/i.test(t)) return { rows: pagina(padrao, params) };
    if (/FROM imagens_empresa/i.test(t)) return { rows: pagina(empresa, params) };
    if (/FROM empresas/i.test(t)) return { rows: idsDeEmpresas.map((id) => ({ id })) };
    throw new Error(`SQL inesperado no banco falso: ${t.slice(0, 80)}`);
  }
  const cliente = {
    query: responder,
    release() { eventos.push('release'); },
  };
  return {
    async connect() { eventos.push('connect'); return cliente; },
    query: responder,
    sql,
    eventos,
  };
}

/** Pool que falha se alguém o usar (provas de que o banco NÃO foi tocado). */
function poolProibidoDeUsar() {
  const usos = [];
  const proibido = async () => { usos.push('uso'); throw new Error('o banco não deveria ser usado'); };
  return { connect: proibido, query: proibido, usos };
}

/**
 * Fachada do sistema de arquivos que registra cada chamada e injeta falhas. Só expõe o que o verificador pode usar (lstat, readdir, realpath, open): se ele
 * tentar qualquer outra operação, a fachada não a tem. `falhas`: [{ metodo, ondeIgual|ondeTermina|ondeContem, codigo }] com o caminho RELATIVO à raiz
 * (a própria raiz é ''). `inverterListagens` devolve cada readdir em ordem invertida, para provar que o relatório não depende da ordem do sistema de arquivos.
 */
function fachadaDeLeitura(raiz, { falhas = [], inverterListagens = false } = {}) {
  const chamadas = [];
  const abertos = new Set();
  const relativo = (p) => path.relative(raiz, p);
  const falhaDe = (metodo, rel) => falhas.find((f) => f.metodo === metodo
    && (f.ondeIgual === undefined || rel === f.ondeIgual)
    && (f.ondeTermina === undefined || rel.endsWith(f.ondeTermina))
    && (f.ondeContem === undefined || rel.includes(f.ondeContem)));
  const erroDoSistema = (codigo) => Object.assign(new Error(`${codigo}: falha simulada do sistema de arquivos`), { code: codigo, syscall: 'simulada' });

  function envolver(identificador, rel) {
    abertos.add(identificador);
    const lerFalho = falhas.find((f) => f.metodo === 'read' && (f.ondeTermina === undefined || rel.endsWith(f.ondeTermina)));
    return {
      async stat() { chamadas.push({ metodo: 'stat', rel }); return identificador.stat(); },
      async read(...argumentos) {
        chamadas.push({ metodo: 'read', rel });
        if (lerFalho) throw erroDoSistema(lerFalho.codigo);
        return identificador.read(...argumentos);
      },
      async close() { chamadas.push({ metodo: 'close', rel }); abertos.delete(identificador); return identificador.close(); },
    };
  }

  const fachada = {
    constants: fs.constants,
    async lstat(p) {
      const rel = relativo(p);
      chamadas.push({ metodo: 'lstat', rel });
      const falha = falhaDe('lstat', rel);
      if (falha) throw erroDoSistema(falha.codigo);
      return fsp.lstat(p);
    },
    async readdir(p, opcoes) {
      const rel = relativo(p);
      chamadas.push({ metodo: 'readdir', rel });
      const falha = falhaDe('readdir', rel);
      if (falha) throw erroDoSistema(falha.codigo);
      const entradas = await fsp.readdir(p, opcoes);
      return inverterListagens ? [...entradas].reverse() : entradas;
    },
    async realpath(p) {
      const rel = relativo(p);
      chamadas.push({ metodo: 'realpath', rel });
      const falha = falhaDe('realpath', rel);
      if (falha) throw erroDoSistema(falha.codigo);
      return fsp.realpath(p);
    },
    async open(p, flags) {
      const rel = relativo(p);
      chamadas.push({ metodo: 'open', rel, flags });
      const falha = falhaDe('open', rel);
      if (falha) throw erroDoSistema(falha.codigo);
      return envolver(await fsp.open(p, flags), rel);
    },
  };
  return { fs: fachada, chamadas, abertos };
}

/** Retrato da árvore (tipo, tamanho, modo, mtime e SHA-256 dos arquivos), sem seguir links: serve para provar que nada mudou. */
function retratoDaArvore(raiz) {
  const itens = [];
  const andar = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      const estado = fs.lstatSync(completo);
      const item = { rel: path.relative(raiz, completo), tipo: entrada.isSymbolicLink() ? 'link' : entrada.isDirectory() ? 'dir' : 'arquivo', modo: estado.mode, mtimeMs: estado.mtimeMs };
      if (entrada.isSymbolicLink()) item.alvo = fs.readlinkSync(completo);
      else if (entrada.isDirectory()) andar(completo);
      else { item.tamanho = estado.size; item.sha256 = sha(fs.readFileSync(completo)); }
      itens.push(item);
    }
  };
  andar(raiz);
  return itens.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

module.exports = {
  MINUTO, DIA_EM_MINUTOS, EXTENSAO, sha, hex64, bytesDe, conteudoDe, gravarNaRaiz,
  criarImagemEmpresa, criarImagemPadrao, poolFalso, poolProibidoDeUsar, fachadaDeLeitura, retratoDaArvore,
};
