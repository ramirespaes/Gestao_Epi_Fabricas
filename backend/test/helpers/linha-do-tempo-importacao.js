'use strict';

/**
 * Linha do tempo comum do que o importador faz (Unidade 5A-2, guarda de destino): cada instrução SQL com o número da CONEXÃO que a enviou, as aberturas e
 * liberações de conexão e cada chamada ao armazenamento, tudo na ordem em que aconteceu. Serve para provar ORDEM ("a identidade vem antes de qualquer efeito")
 * e IDENTIDADE DE CONEXÃO ("quem confere é quem grava"). Funciona sobre um Pool real ou sobre um falso com `connect()`.
 */

const sqlDe = (entrada) => (typeof entrada === 'string' ? entrada : String(entrada?.text ?? '')).trim();

function linhaDoTempo() {
  const eventos = [];
  let conexoes = 0;

  const envolverCliente = (cliente, conexao) => new Proxy(cliente, {
    get(c, propriedade) {
      if (propriedade === 'query') return (...a) => { eventos.push({ tipo: 'SQL', conexao, texto: sqlDe(a[0]) }); return c.query(...a); };
      if (propriedade === 'release') return (...a) => { eventos.push({ tipo: 'LIBERA', conexao, texto: String(a[0] === true) }); return c.release(...a); };
      const valor = c[propriedade];
      return typeof valor === 'function' ? valor.bind(c) : valor;
    },
  });

  const pool = (real) => new Proxy(real, {
    get(p, propriedade) {
      if (propriedade === 'connect') {
        return (...a) => {
          if (typeof a[0] === 'function') return p.connect(...a);
          conexoes += 1;
          const conexao = conexoes;
          eventos.push({ tipo: 'CONNECT', conexao, texto: 'CONNECT' });
          return p.connect().then((cliente) => envolverCliente(cliente, conexao));
        };
      }
      if (propriedade === 'query') return (...a) => { eventos.push({ tipo: 'SQL', conexao: 0, texto: sqlDe(a[0]) }); return p.query(...a); };
      const valor = p[propriedade];
      return typeof valor === 'function' ? valor.bind(p) : valor;
    },
  });

  const armazenamento = (real) => {
    const espiao = {};
    for (const nome of Object.keys(real)) {
      espiao[nome] = typeof real[nome] === 'function' ? (...a) => { eventos.push({ tipo: 'ARM', conexao: null, texto: nome }); return real[nome](...a); } : real[nome];
    }
    return Object.freeze(espiao);
  };

  /** A instrução de identidade: current_database() e o OID lido de pg_database. */
  const ehIdentidade = (e) => e.tipo === 'SQL' && /current_database\(\)/i.test(e.texto) && /pg_database/i.test(e.texto);
  /** Qualquer efeito além de abrir a transação e conferir a identidade: trava, ajuste de espera, leitura de estado, gravação de arquivo, escrita no banco. */
  const ehEfeito = (e) => (e.tipo === 'ARM') || (e.tipo === 'SQL' && !ehIdentidade(e) && !/^(BEGIN\b|ROLLBACK\b)/i.test(e.texto));

  return {
    eventos, pool, armazenamento, ehIdentidade, ehEfeito,
    sql: () => eventos.filter((e) => e.tipo === 'SQL'),
    resumo: () => eventos.map((e) => (e.tipo === 'SQL' || e.tipo === 'CONNECT' ? `${e.conexao}:${e.texto.slice(0, 48)}` : `${e.tipo}:${e.texto}`)),
  };
}

module.exports = { linhaDoTempo };
