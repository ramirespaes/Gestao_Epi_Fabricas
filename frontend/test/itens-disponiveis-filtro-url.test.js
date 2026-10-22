'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const Catalogo = require('../js/catalogo-visual');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/itens-disponiveis');

const resposta = (status, corpo) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => corpo === undefined ? '' : JSON.stringify(corpo),
});

const pagina = {
  status: 'ok',
  itens: [],
  total: 0,
  pagina: 1,
  limite: 15,
  filtros: { categorias: [], tipos: [], tamanhos: [] },
};

describe('EpiItensDisponiveis.filtroDaUrl', () => {
  test('aceita somente situações conhecidas', () => {
    const f = modulo().filtroDaUrl;

    assert.equal(
      typeof f,
      'function',
      'EpiItensDisponiveis.filtroDaUrl ainda não existe'
    );

    assert.equal(f('?situacao=ABAIXO_MINIMO'), 'ABAIXO_MINIMO');
    assert.equal(f('situacao=ABAIXO_MINIMO&x=1'), 'ABAIXO_MINIMO');

    for (const situacao of [
      'SEM_ESTOQUE',
      'COM_COMPROMETIDO',
      'SEM_COBERTURA',
    ]) {
      assert.equal(f(`?situacao=${situacao}`), situacao);
    }

    for (const ruim of [
      '',
      undefined,
      null,
      '?',
      '?situacao=',
      '?situacao=abaixo_minimo',
      '?situacao=DROP%20TABLE',
      '?situacao=%3Cscript%3E',
      '?busca=luva',
      '?situacao=ABAIXO_MINIMO%20',
      42,
    ]) {
      assert.equal(f(ruim), '', String(ruim));
    }
  });
});

let chamadas;

function servidor(responder) {
  chamadas = [];

  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);

      chamadas.push({
        metodo: opcoes.method,
        caminho: u.pathname + u.search,
      });

      return typeof responder === 'function'
        ? responder(u)
        : responder;
    },
  });
}

const PERMISSOES_OK = {
  recursos: {
    availableItems: {
      visualizar: true,
      criar: false,
      editar: false,
      excluir: false,
    },
  },
  acoes: {},
  administracao: {},
};

const CONTEXTO = {
  empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' },
  usuario: {
    id: 7,
    nome: 'Pessoa',
    email: 'p@exemplo-cliente.com.br',
    perfil: 'MASTER',
  },
};

function montarPagina(busca, responder = resposta(200, pagina)) {
  servidor(responder);

  const html = ler('pages/available-items.html');
  const script = html.slice(
    html.lastIndexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>')
  );

  const SELECTS = new Set([
    'availableCategory',
    'availableType',
    'availableSize',
    'deliveredStatus',
    'availableSituation',
  ]);

  const mapa = {};

  const el = (id) => (
    mapa[id] = mapa[id] || {
      id,
      value: '',
      checked: false,
      innerHTML: '',
      textContent: '',
      disabled: false,
      style: {},
      listeners: {},
      tagName: SELECTS.has(id) ? 'SELECT' : 'DIV',

      addEventListener(ev, fn) {
        (this.listeners[ev] = this.listeners[ev] || []).push(fn);
      },
    }
  );

  const janela = {
    SAFEWORK_PORTAL_API_BASE_URL: BASE,
  };

  if (busca !== undefined) {
    janela.location = { search: busca };
  }

  const sandbox = {
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      createElement: () => ({
        click() {},
        remove() {},
      }),
      body: { appendChild() {} },
    },

    window: janela,

    URL: {
      createObjectURL: () => 'blob:x',
      revokeObjectURL() {},
    },

    Blob: class {},

    EpiHttp,
    EpiItensDisponiveis: modulo(),
    EpiCatalogoVisual: Catalogo,

    EpiPermissoes: {
      prepararPagina: async () => ({
        permissoes: PERMISSOES_OK,
        podeAlterar: false,
      }),
    },

    EpiSessaoEmpresarial: {
      montar: async (opcoes) => {
        sandbox.opcoesMontar = opcoes;
        return CONTEXTO;
      },
      sessaoEncerrada() {
        sandbox.encerrada = true;
      },
    },

    console,
    setTimeout,
    Promise,
    String,
    Number,
    Array,
    Object,
    JSON,
  };

  vm.runInNewContext(script, sandbox);

  const esperar = async () => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolver) => setImmediate(resolver));
    }
  };

  const clicar = async (id) => {
    for (const fn of (el(id).listeners.click || [])) {
      await fn();
    }
    await esperar();
  };

  return { el, esperar, clicar };
}

describe('Análise de Estoque: filtro vindo da URL', () => {
  test('primeira consulta já utiliza ABAIXO_MINIMO', async () => {
    const pg = montarPagina('?situacao=ABAIXO_MINIMO');

    await pg.esperar();

    assert.deepEqual(
      chamadas.map((c) => c.caminho),
      [
        '/api/estoque/itens-disponiveis?situacao=ABAIXO_MINIMO&pagina=1&limite=15',
      ],
      'Não deve existir consulta inicial sem filtro'
    );

    assert.equal(
      pg.el('availableSituation').value,
      'ABAIXO_MINIMO'
    );
  });

  test('Limpar remove o filtro da URL', async () => {
    const pg = montarPagina('?situacao=ABAIXO_MINIMO');

    await pg.esperar();

    assert.equal(
      pg.el('availableSituation').value,
      'ABAIXO_MINIMO',
      'o filtro da URL precisa estar aplicado antes de Limpar'
    );

    await pg.clicar('botaoLimpar');

    assert.equal(
      chamadas.at(-1).caminho,
      '/api/estoque/itens-disponiveis?pagina=1&limite=15'
    );

    assert.equal(
      pg.el('availableSituation').value,
      ''
    );
  });

  test('paginação mantém ABAIXO_MINIMO', async () => {
    const pg = montarPagina(
      '?situacao=ABAIXO_MINIMO',
      (url) => {
        const numeroPagina = Number(
          url.searchParams.get('pagina') || 1
        );

        const quantidade = numeroPagina === 1 ? 15 : 1;

        const itens = Array.from(
          { length: quantidade },
          (_, indice) => ({
            materialId: indice + 1,
            material: `Luva de Segurança ${indice + 1}`,
            codigoInterno: null,
            categoria: 'EPI',
            grupo: 'EPI',
            tipo: 'Luva',
            tamanho: 'G',
            saldo: 1,
            bloqueado: 0,
            disponivel: 1,
            fisicoUtilizavel: 1,
            demandaPendente: 0,
            comprometido: 0,
            saldoLivre: 1,
            semCobertura: 0,
            estoqueMinimo: 5,
            minimoOrigem: 'PADRAO',
            abaixoDoMinimo: true,
            deficit: 4,
            necessidade: 4,
            unidade: 'un',
            caValidade: null,
            validade: 'ok',
          })
        );

        return resposta(200, {
          ...pagina,
          itens,
          total: 16,
          pagina: numeroPagina,
        });
      }
    );

    await pg.esperar();

    assert.equal(
      pg.el('paginaProxima').disabled,
      false,
      'A resposta deve permitir avançar para a segunda página'
    );

    await pg.clicar('paginaProxima');

    assert.match(
      chamadas.at(-1).caminho,
      /situacao=ABAIXO_MINIMO&pagina=2&limite=15/
    );
  });

  test('situação inválida é ignorada', async () => {
    const pg = montarPagina('?situacao=DROP%20TABLE');

    await pg.esperar();

    assert.deepEqual(
      chamadas.map((c) => c.caminho),
      ['/api/estoque/itens-disponiveis?pagina=1&limite=15']
    );

    assert.equal(pg.el('availableSituation').value, '');
  });

  test('sem parâmetro, comportamento original preservado', async () => {
    for (const busca of ['', undefined]) {
      const pg = montarPagina(busca);

      await pg.esperar();

      assert.deepEqual(
        chamadas.map((c) => c.caminho),
        ['/api/estoque/itens-disponiveis?pagina=1&limite=15']
      );

      assert.equal(pg.el('availableSituation').value, '');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12I, Task 02 — "Somente com necessidade" vindo da URL
// ═══════════════════════════════════════════════════════════════════
describe('EpiItensDisponiveis.filtrosDaUrl', () => {
  test('devolve a situação conhecida e o "somente com necessidade" (só o valor exato "true")', () => {
    const f = modulo().filtrosDaUrl;
    assert.equal(typeof f, 'function', 'EpiItensDisponiveis.filtrosDaUrl ainda não existe');
    assert.deepEqual(f('?somenteComNecessidade=true'), { situacao: '', somenteComNecessidade: true });
    assert.deepEqual(f('?situacao=SEM_COBERTURA'), { situacao: 'SEM_COBERTURA', somenteComNecessidade: false });
    assert.deepEqual(f('situacao=SEM_COBERTURA&somenteComNecessidade=true'), { situacao: 'SEM_COBERTURA', somenteComNecessidade: true });
    assert.deepEqual(f('?situacao=ABAIXO_MINIMO'), { situacao: 'ABAIXO_MINIMO', somenteComNecessidade: false });
    for (const ruim of ['', undefined, null, '?', 42, '?somenteComNecessidade=TRUE', '?somenteComNecessidade=1', '?somenteComNecessidade=false', '?somenteComNecessidade=', '?somenteComNecessidade=true%20', '?somenteComNecessidade=truex', '?busca=luva']) {
      assert.deepEqual(f(ruim), { situacao: '', somenteComNecessidade: false }, String(ruim));
    }
  });

  test('o filtroDaUrl antigo continua devolvendo só a situação', () => {
    assert.equal(modulo().filtroDaUrl('?situacao=ABAIXO_MINIMO&somenteComNecessidade=true'), 'ABAIXO_MINIMO');
  });
});

describe('página available-items.html: "Somente com necessidade" vindo da URL', () => {
  test('?somenteComNecessidade=true: a PRIMEIRA e única consulta já leva o filtro e a caixa da tela aparece marcada', async () => {
    const pg = montarPagina('?somenteComNecessidade=true');
    await pg.esperar();
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/estoque/itens-disponiveis?somenteComNecessidade=true&pagina=1&limite=15']);
    assert.equal(pg.el('availableNeed').checked, true);
    assert.equal(pg.el('availableSituation').value, '');
  });

  test('situação e necessidade juntas vêm da URL e valem na primeira consulta', async () => {
    const pg = montarPagina('?situacao=SEM_COBERTURA&somenteComNecessidade=true');
    await pg.esperar();
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/estoque/itens-disponiveis?situacao=SEM_COBERTURA&somenteComNecessidade=true&pagina=1&limite=15']);
    assert.deepEqual([pg.el('availableSituation').value, pg.el('availableNeed').checked], ['SEM_COBERTURA', true]);
  });

  test('Limpar remove os dois filtros vindos da URL e consulta de novo sem filtro', async () => {
    const pg = montarPagina('?situacao=SEM_COBERTURA&somenteComNecessidade=true');
    await pg.esperar();
    assert.equal(pg.el('availableNeed').checked, true, 'pré-condição');
    await pg.clicar('botaoLimpar');
    assert.equal(chamadas.at(-1).caminho, '/api/estoque/itens-disponiveis?pagina=1&limite=15');
    assert.deepEqual([pg.el('availableSituation').value, pg.el('availableNeed').checked], ['', false]);
  });

  test('valor que não é exatamente "true" é ignorado: consulta sem filtro e caixa desmarcada', async () => {
    for (const busca of ['?somenteComNecessidade=TRUE', '?somenteComNecessidade=1', '?somenteComNecessidade=false']) {
      const pg = montarPagina(busca);
      await pg.esperar();
      assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/estoque/itens-disponiveis?pagina=1&limite=15'], busca);
      assert.equal(pg.el('availableNeed').checked, false);
    }
  });
});
