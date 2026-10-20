'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Instrumentação dos testes da importação da biblioteca padrão (Unidade 5A-2): espiões que registram toda chamada de escrita e instantâneos
 * do disco e do banco para provar "nada mudou". O instantâneo do disco enxerga reescrita mesmo com bytes idênticos (inode, mtime e ctime); o do
 * banco enxerga UPDATE sem mudança de valor (xmin, ctid e atualizado_em). Cada um tem controle positivo em instrumentacao-importacao.test.js.
 */

/** Objeto congelado (como o armazenamento) não aceita Proxy que troque suas funções: cria um novo, com as funções espiadas. */
function espiarObjeto(alvo, registros = []) {
  const espiao = {};
  for (const nome of Object.keys(alvo)) {
    espiao[nome] = typeof alvo[nome] === 'function' ? (...args) => { registros.push({ metodo: nome, args }); return alvo[nome](...args); } : alvo[nome];
  }
  return { espiao: Object.freeze(espiao), registros };
}

// Escrita é também o INSERT/UPDATE/DELETE escondido num WITH e o consumo explícito de sequência (nextval/setval).
const ESCRITA_SQL = /^\s*(?:(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|CREATE|ALTER|DROP)\b|WITH\b[\s\S]*?\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b|SELECT\b[\s\S]*?\b(?:nextval|setval)\s*\()/i;

/** Espia um Pool do pg: registra todo SQL (do pool e dos clientes que ele entrega) e a abertura de conexão. */
function espiarPool(pool) {
  const registros = [];
  const sqlDe = (entrada) => (typeof entrada === 'string' ? entrada : String(entrada?.text ?? ''));
  const envolverCliente = (cliente) => new Proxy(cliente, {
    get(c, propriedade) {
      if (propriedade === 'query') return (...a) => { registros.push({ origem: 'cliente', sql: sqlDe(a[0]) }); return c.query(...a); };
      const valor = c[propriedade];
      return typeof valor === 'function' ? valor.bind(c) : valor;
    },
  });
  const espiao = new Proxy(pool, {
    get(p, propriedade) {
      if (propriedade === 'query') return (...a) => { registros.push({ origem: 'pool', sql: sqlDe(a[0]) }); return p.query(...a); };
      if (propriedade === 'connect') {
        return (...a) => {
          if (typeof a[0] === 'function') return p.connect(...a);
          registros.push({ origem: 'pool', sql: 'CONNECT' });
          return p.connect().then(envolverCliente);
        };
      }
      const valor = p[propriedade];
      return typeof valor === 'function' ? valor.bind(p) : valor;
    },
  });
  return { espiao, registros, escritas: () => registros.filter((r) => ESCRITA_SQL.test(r.sql)) };
}

/** Pool que falha NA N-ÉSIMA instrução que casa com `padrao` (antes de enviá-la ao banco), uma só vez, e segue normal nas demais. */
function falharNoPool(pool, { padrao, numero }) {
  let vistos = 0;
  const disparos = [];
  const sqlDe = (entrada) => (typeof entrada === 'string' ? entrada : String(entrada?.text ?? ''));
  const conferir = (sql) => {
    if (!padrao.test(sql)) return;
    vistos += 1;
    if (vistos === numero) {
      disparos.push(sql);
      throw Object.assign(new Error('falha injetada pelo teste'), { code: 'XX000', injetada: true });
    }
  };
  const envolverCliente = (cliente) => new Proxy(cliente, {
    get(c, propriedade) {
      if (propriedade === 'query') return async (...a) => { conferir(sqlDe(a[0])); return c.query(...a); };
      const valor = c[propriedade];
      return typeof valor === 'function' ? valor.bind(c) : valor;
    },
  });
  const espiao = new Proxy(pool, {
    get(p, propriedade) {
      if (propriedade === 'query') return async (...a) => { conferir(sqlDe(a[0])); return p.query(...a); };
      if (propriedade === 'connect') return (...a) => (typeof a[0] === 'function' ? p.connect(...a) : p.connect().then(envolverCliente));
      const valor = p[propriedade];
      return typeof valor === 'function' ? valor.bind(p) : valor;
    },
  });
  return { espiao, disparos, vistos: () => vistos };
}

/** Armazenamento que falha NA N-ÉSIMA chamada de `metodo` (padrão: gravar), uma só vez, com o código do próprio armazenamento; as demais chamadas são reais. */
function armazenamentoQueFalha(armazenamento, { metodo = 'gravar', numero }) {
  let chamadas = 0;
  const disparos = [];
  const espiao = {};
  for (const nome of Object.keys(armazenamento)) {
    espiao[nome] = typeof armazenamento[nome] === 'function' ? (...args) => {
      if (nome === metodo) {
        chamadas += 1;
        if (chamadas === numero) {
          disparos.push(nome);
          return Promise.reject(Object.assign(new Error('falha injetada pelo teste'), { codigo: 'ARMAZENAMENTO_FALHOU', injetada: true }));
        }
      }
      return armazenamento[nome](...args);
    } : armazenamento[nome];
  }
  return { armazenamento: Object.freeze(espiao), disparos, chamadas: () => chamadas };
}

/** Pool que NÃO pode ser usado: registra a tentativa e falha. Prova "o banco nem foi consultado". */
function poolProibido() {
  const registros = [];
  const usar = (metodo) => (...args) => { registros.push({ metodo, args }); throw new Error('o banco não deveria ter sido usado'); };
  return { pool: { query: usar('query'), connect: usar('connect') }, registros };
}

/** Armazenamento que NÃO pode ser usado: registra a tentativa e falha. Prova "o armazenamento nem foi tocado". */
function armazenamentoProibido() {
  const registros = [];
  const usar = (metodo) => (...args) => { registros.push({ metodo, args }); throw new Error('o armazenamento não deveria ter sido usado'); };
  const armazenamento = Object.freeze({
    gravar: usar('gravar'), abrir: usar('abrir'), existe: usar('existe'), remover: usar('remover'), removerVariantes: usar('removerVariantes'), listar: usar('listar'),
    chaveDe: usar('chaveDe'),
  });
  return { armazenamento, registros };
}

/** Todo o conteúdo do diretório de armazenamento: caminho, tipo, modo, inode, mtime, ctime, tamanho, links e SHA-256. Não inclui atime. */
function instantaneoDoArmazenamento(raiz) {
  const itens = [];
  const percorrer = (relativo) => {
    for (const nome of fs.readdirSync(path.join(raiz, relativo)).sort()) {
      const rel = path.join(relativo, nome);
      const absoluto = path.join(raiz, rel);
      const estado = fs.lstatSync(absoluto);
      const item = {
        caminho: rel.split(path.sep).join('/'), tipo: estado.isDirectory() ? 'dir' : estado.isFile() ? 'arq' : 'outro', modo: estado.mode & 0o7777,
        ino: estado.ino, mtimeMs: estado.mtimeMs, ctimeMs: estado.ctimeMs, tamanho: estado.size, links: estado.nlink,
      };
      if (estado.isFile()) item.sha256 = crypto.createHash('sha256').update(fs.readFileSync(absoluto)).digest('hex');
      itens.push(item);
      if (estado.isDirectory()) percorrer(rel);
    }
  };
  percorrer('');
  return itens;
}

const tabelas = ['imagens_empresa', 'tipos_material', 'empresas', 'usuarios'];

/**
 * Estado do banco que a importação pode tocar ou NÃO pode tocar: as linhas de imagens_padrao e imagens_padrao_tipos com xmin e ctid (um UPDATE
 * ou reescrita muda os dois, mesmo sem mudar valor), as sequências de identidade das duas (um INSERT que conflita e não grava consome o número),
 * os materiais inteiros e a contagem das tabelas vizinhas.
 */
async function sequenciaDe(q, tabela) {
  const { nome } = (await q(`SELECT pg_get_serial_sequence('${tabela}', 'id') AS nome`)).rows[0];
  return (await q(`SELECT last_value::text AS ultimo, is_called AS usada FROM ${nome}`)).rows[0];
}

async function instantaneoDoBanco(q) {
  const linhas = async (tabela) => (await q(`SELECT id::text AS id, xmin::text AS xmin, ctid::text AS ctid, to_jsonb(t) AS linha FROM ${tabela} t ORDER BY id`)).rows;
  const contagens = {};
  for (const tabela of tabelas) contagens[tabela] = (await q(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n;
  const sequencias = { padrao: await sequenciaDe(q, 'imagens_padrao'), sugestoes: await sequenciaDe(q, 'imagens_padrao_tipos') };
  return { padrao: await linhas('imagens_padrao'), sugestoes: await linhas('imagens_padrao_tipos'), materiais: await linhas('materiais'), contagens, sequencias };
}

module.exports = {
  espiarObjeto, espiarPool, falharNoPool, armazenamentoQueFalha, poolProibido, armazenamentoProibido, instantaneoDoArmazenamento, instantaneoDoBanco, ESCRITA_SQL,
};
