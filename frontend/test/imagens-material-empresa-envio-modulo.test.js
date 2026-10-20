'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/imagens-material-empresa');
const EpiHttp = require('../js/api-http');
const { enviar: esquemaDeEnvio } = require('../../backend/src/schemas/imagem-material.schema');
const { ROTA_DE_ENVIO_DE_IMAGEM } = require('../../backend/src/middleware/conteudo');

/**
 * Unidade 5C-7 (RED do frontend) — contrato do módulo NOVO js/imagens-envio.js (EpiImagensEnvio): o TRANSPORTE BINÁRIO do envio de imagens para a biblioteca da empresa,
 * separado do EpiHttp (que só envia JSON e não pode ser alterado), mais as validações locais, o envio em lote e os textos das falhas. Ele ainda não existe: cada teste
 * abaixo falha com "comportamento ausente:" e passa a valer na 5C-8. Sem DOM, sem PostgreSQL, sem API 3300 e sem upload real: `fetch` simulado e `File` reais do Node.
 *
 * Contratos do backend conferidos por leitura (routes/imagem-material.routes.js, schemas/imagem-material.schema.js, config/imagens.js, middleware/conteudo.js e
 * services/imagem-material*.js): POST /imagens-material/empresa?nome=<nome> (materials.criar), corpo = a imagem em binário com Content-Type image/*, até 2 MiB; a consulta
 * leva SÓ `nome` (1 a 100 pontos de código, sem caractere de controle); 201 { status, imagem, reaproveitada:false } para imagem nova e 200 com reaproveitada:true para o mesmo
 * conteúdo já existente na empresa; erros 400 (IMAGEM_INVALIDA, IMAGEM_DIMENSOES_INVALIDAS, VALIDACAO), 401, 403, 409 (IMAGEM_COTA_EXCEDIDA), 413 (PAYLOAD_MUITO_GRANDE),
 * 415 (TIPO_CONTEUDO_NAO_SUPORTADO, IMAGEM_FORMATO_NAO_SUPORTADO, IMAGEM_ANIMADA_NAO_SUPORTADA), 422 (IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO, IMAGEM_SAIDA_EXCEDE_LIMITE),
 * 429 (LIMITE_REQUISICOES_EXCEDIDO, com Retry-After), 503 (IMAGENS_INDISPONIVEL; IMAGENS_OCUPADO com Retry-After) e 500.
 */

const BASE = 'http://localhost:3000/api';
const m = (para) => E.envio(para);
const reiniciar = () => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: null });
  if (E.existeEnvio()) E.envio().configurar({ fetch: null });
};
afterEach(reiniciar);

/** Instala o fetch roteirizado no módulo e na base de EpiHttp; devolve o estado do fetch. */
function preparar(roteiro, base = BASE) {
  EpiHttp.configurar({ baseUrl: base, fetch: null });
  const { fetch, estado } = E.fetchRoteirizado(roteiro);
  m('configurar o fetch').configurar({ fetch });
  return estado;
}

async function recusaComTypeError(fn, rotulo) {
  let erro = null;
  try { await fn(); } catch (falha) { erro = falha; }
  assert.ok(erro instanceof TypeError, `${rotulo}: esperava TypeError antes da rede (veio ${erro === null ? 'nada' : erro.name})`);
}

const item = (i, extra = {}) => ({ arquivo: E.arquivo({ nome: `foto-${i}.png`, semente: `lote-${i}` }), nome: `Imagem ${i}`, ...extra });
const itens = (n) => Array.from({ length: n }, (_, i) => item(i + 1));
const estadosDe = (r) => r.itens.map((x) => x.estado);

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — módulo js/imagens-envio.js: existência e forma', () => {
  test('EV-01 o arquivo existe, carrega no Node sem DOM e se expõe como EpiImagensEnvio (global e module.exports) com as partes do contrato', () => {
    const mod = m('existência do módulo');
    assert.equal(typeof mod, 'object');
    assert.equal(globalThis.EpiImagensEnvio, mod);
    for (const parte of ['LIMITES', 'ACEITAS', 'caminhos', 'configurar', 'validarNome', 'nomePadraoDoArquivo', 'validarArquivo', 'resumoSha256', 'enviar', 'enviarLote', 'mensagens']) {
      assert.ok(parte in mod, `${E.MARCA} falta EpiImagensEnvio.${parte}`);
    }
  });

  test('EV-02 não altera o EpiHttp: o EpiHttp continua o mesmo objeto, só com JSON, e o módulo novo é OUTRO objeto', () => {
    const mod = m('separação do EpiHttp');
    assert.notEqual(mod, EpiHttp);
    assert.equal(globalThis.EpiHttp, EpiHttp);
    for (const chave of ['configurar', 'requisitar', 'ehFalhaDeRede', 'ehValidacao', 'ehNaoAutenticado', 'ehSemAutorizacao', 'ehNaoEncontrado', 'ehConflito']) assert.equal(typeof EpiHttp[chave], 'function');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — limites: iguais aos do backend, nunca inventados', () => {
  test('EV-03 LIMITES = configuração do backend (2 MiB, 320 a 4096 px, lote de 10, nome de 1 a 100) e os três tipos aceitos', () => {
    const { LIMITES, ACEITAS } = m('limites do envio');
    const c = E.LIMITES_DO_BACKEND;
    assert.equal(LIMITES.arquivoMaxBytes, c.arquivoMaxBytes);
    assert.equal(LIMITES.arquivoMaxBytes, 2 * E.MIB);
    assert.deepEqual([LIMITES.ladoMin, LIMITES.ladoMax], [c.ladoMin, c.ladoMax]);
    assert.equal(LIMITES.loteMax, c.loteMaximo);
    assert.deepEqual([LIMITES.nomeMin, LIMITES.nomeMax], [c.nome.min, c.nome.max]);
    assert.deepEqual([...LIMITES.formatos].sort(), c.formatosAceitos.map((f) => `image/${f.toLowerCase()}`).sort());
    assert.deepEqual(ACEITAS.split(',').sort(), [...E.TIPOS_ACEITOS].sort(), 'ACEITAS é o valor do atributo accept do campo de arquivos');
  });

  test('EV-04 LIMITES é imutável', () => {
    const { LIMITES } = m('limites do envio');
    assert.equal(Object.isFrozen(LIMITES), true);
    assert.equal(Object.isFrozen(LIMITES.formatos), true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — nome da imagem: a mesma regra do servidor', () => {
  const NOMES = [
    'Luva', '  Luva  ', 'Luva de vaqueta', 'x'.repeat(100), 'x'.repeat(101), '😀'.repeat(100), '😀'.repeat(101), `${'a'.repeat(99)}😀`, 'é', 'é', '', '   ', '\t', 'a\tb',
    'a\u0000b', 'a\u0007b', 'a\u007fb', 'a\u0085b', 'a\nb', ` ${'x'.repeat(100)} `, '<b>negrito</b>', 'Capa & Luva #1?', undefined, null, 5, {}, [],
  ];

  test('EV-05 validarNome concorda com o schema REAL do backend (aceita/recusa e valor normalizado) numa tabela de nomes', () => {
    const { validarNome } = m('validação do nome');
    for (const nome of NOMES) {
      const r = validarNome(nome);
      const esperado = esquemaDeEnvio.query.safeParse({ nome });
      assert.equal(r.ok, esperado.success, `nome ${JSON.stringify(nome)}`);
      if (esperado.success) assert.equal(r.nome, esperado.data.nome, `normalizado ${JSON.stringify(nome)}`);
      else assert.equal(r.codigo, 'NOME_INVALIDO');
    }
  });

  test('EV-06 nomePadraoDoArquivo: sem a extensão, "_" e "-" viram espaço, aparado, NFC e no máximo 100 pontos de código (nunca corta um par substituto)', () => {
    const { nomePadraoDoArquivo } = m('nome padrão a partir do arquivo');
    assert.equal(nomePadraoDoArquivo('luva_nitrilica-azul.PNG'), 'luva nitrilica azul');
    assert.equal(nomePadraoDoArquivo('Capacete de Segurança.jpeg'), 'Capacete de Segurança');
    assert.equal(nomePadraoDoArquivo('a.b.c.webp'), 'a.b.c');
    assert.equal(nomePadraoDoArquivo('sem-extensao'), 'sem extensao');
    assert.equal(nomePadraoDoArquivo('__x__.png'), 'x');
    assert.equal(nomePadraoDoArquivo('.png'), '');
    assert.equal(nomePadraoDoArquivo('café.png'), 'café');
    const longo = nomePadraoDoArquivo(`${'a'.repeat(99)}😀😀.png`);
    assert.equal(Array.from(longo).length, 100);
    assert.equal(longo, `${'a'.repeat(99)}😀`);
    assert.equal(nomePadraoDoArquivo(`${'b'.repeat(150)}.png`).length, 100);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — arquivo: validação local antes de qualquer envio', () => {
  test('EV-07 validarArquivo aceita PNG, JPEG e WebP de 1 byte até exatamente 2 MiB', () => {
    const { validarArquivo } = m('validação do arquivo');
    for (const tipo of E.TIPOS_ACEITOS) assert.deepEqual(validarArquivo(E.arquivo({ tipo, nome: 'x' })), { ok: true }, tipo);
    assert.deepEqual(validarArquivo(E.arquivo({ tamanho: 1 })), { ok: true });
    assert.deepEqual(validarArquivo(E.arquivo({ tamanho: 2 * E.MIB })), { ok: true });
  });

  test('EV-08 recusa por tipo (decide o tipo informado, não a extensão), por arquivo vazio e por mais de 2 MiB, com código estável', () => {
    const { validarArquivo } = m('validação do arquivo');
    for (const tipo of ['image/gif', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/avif', 'application/pdf', 'text/plain', '', 'image/jpg']) {
      assert.deepEqual(validarArquivo(E.arquivo({ tipo, nome: 'foto.png' })), { ok: false, codigo: 'FORMATO_NAO_ACEITO' }, JSON.stringify(tipo));
    }
    // O File do navegador devolve o tipo em minúsculas ("IMAGE/PNG" vira "image/png"); só um objeto com a forma de arquivo traz outra caixa, e o tipo é comparado exatamente.
    assert.equal(new File([], 'x.png', { type: 'IMAGE/PNG' }).type, 'image/png');
    assert.deepEqual(validarArquivo({ name: 'x.png', type: 'IMAGE/PNG', size: 5 }), { ok: false, codigo: 'FORMATO_NAO_ACEITO' });
    assert.deepEqual(validarArquivo(E.arquivo({ tamanho: 0 })), { ok: false, codigo: 'ARQUIVO_VAZIO' });
    assert.deepEqual(validarArquivo(E.arquivo({ tamanho: (2 * E.MIB) + 1 })), { ok: false, codigo: 'ARQUIVO_GRANDE' });
    assert.deepEqual(validarArquivo(E.arquivo({ tipo: 'image/gif', tamanho: 0 })), { ok: false, codigo: 'FORMATO_NAO_ACEITO' }, 'o tipo é conferido primeiro');
  });

  test('EV-09 o que não é um arquivo (nulo, texto, objeto sem tamanho) é TypeError, não recusa de usuário', () => {
    const { validarArquivo } = m('validação do arquivo');
    for (const ruim of [null, undefined, 'x.png', 5, {}, { name: 'x.png', type: 'image/png' }, []]) assert.throws(() => validarArquivo(ruim), TypeError, JSON.stringify(ruim));
  });

  test('EV-10 resumoSha256: o SHA-256 em minúsculas do conteúdo; nulo quando o navegador não tem crypto.subtle ou não consegue ler o arquivo', async () => {
    const { resumoSha256 } = m('resumo do conteúdo para achar duplicadas');
    const a = E.arquivo({ semente: 'conteudo-conhecido' });
    assert.equal(await resumoSha256(a), await E.sha256Do(a));
    assert.match(await resumoSha256(a), /^[0-9a-f]{64}$/);
    assert.equal(await resumoSha256(E.arquivo({ semente: 'x' })) === await resumoSha256(E.arquivo({ semente: 'y' })), false);
    assert.equal(await resumoSha256({ name: 'x.png', type: 'image/png', size: 5, arrayBuffer: async () => { throw new Error('ilegível'); } }), null);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
      assert.equal(await resumoSha256(a), null, 'sem crypto');
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
      assert.equal(await resumoSha256(a), null, 'sem crypto.subtle (página servida sem HTTPS)');
    } finally {
      Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — caminho do envio (única fonte)', () => {
  test('EV-11 caminhos.envio(nome) = /imagens-material/empresa?nome=<codificado>, com o nome aparado, em NFC e só a chave nome', () => {
    const { caminhos } = m('caminho do envio');
    assert.equal(caminhos.envio('Luva'), '/imagens-material/empresa?nome=Luva');
    assert.equal(caminhos.envio('  Luva de raspa  '), '/imagens-material/empresa?nome=Luva%20de%20raspa');
    assert.equal(caminhos.envio('Capa & Luva #1?'), '/imagens-material/empresa?nome=Capa%20%26%20Luva%20%231%3F');
    assert.equal(caminhos.envio('Óculos'), '/imagens-material/empresa?nome=%C3%93culos');
    assert.equal(caminhos.envio('é'), '/imagens-material/empresa?nome=%C3%A9', 'NFC antes de codificar');
    assert.equal(caminhos.envio('😀'), '/imagens-material/empresa?nome=%F0%9F%98%80');
    const consulta = new URLSearchParams(caminhos.envio('A=B&empresaId=999').split('?')[1]);
    assert.deepEqual([...consulta.keys()], ['nome']);
    assert.equal(consulta.get('nome'), 'A=B&empresaId=999', 'o nome nunca vira outro parâmetro');
  });

  test('EV-12 nome inválido é TypeError antes de montar qualquer endereço', () => {
    const { caminhos } = m('caminho do envio');
    for (const nome of ['', '   ', 'x'.repeat(101), 'a\u0007b', undefined, null, 5, {}]) assert.throws(() => caminhos.envio(nome), TypeError, JSON.stringify(nome));
  });

  test('EV-13 é o mesmo caminho da rota do backend (POST /api/imagens-material/empresa, a exceção da política de conteúdo)', () => {
    const { caminhos } = m('caminho do envio');
    assert.deepEqual(ROTA_DE_ENVIO_DE_IMAGEM, { metodo: 'POST', caminho: '/api/imagens-material/empresa' });
    assert.equal(`/api${caminhos.envio('x').split('?')[0]}`, ROTA_DE_ENVIO_DE_IMAGEM.caminho);
  });

  test('EV-14 a consulta montada é aceita pelo schema REAL do backend', () => {
    const { caminhos } = m('caminho do envio');
    for (const nome of ['Luva', 'Capa & Luva #1?', 'Óculos de proteção', '😀'.repeat(100)]) {
      const consulta = Object.fromEntries(new URLSearchParams(caminhos.envio(nome).split('?')[1]).entries());
      assert.equal(esquemaDeEnvio.query.safeParse(consulta).success, true, nome);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — enviar: o que sai pela rede', () => {
  test('EV-15 um único POST: URL na base do EpiHttp, cookie de sessão, SÓ o Content-Type do arquivo, e o corpo é o PRÓPRIO File (nem JSON, nem FormData, nem cópia)', async () => {
    const estado = preparar([E.criada('7001', 'Luva')]);
    const arq = E.arquivo({ nome: 'luva.webp', tipo: 'image/webp', semente: 'a' });
    const r = await m().enviar({ arquivo: arq, nome: ' Luva ' });
    assert.equal(estado.chamadas.length, 1);
    const { url, opcoes } = estado.chamadas[0];
    assert.equal(url, `${BASE}/imagens-material/empresa?nome=Luva`);
    assert.equal(opcoes.method, 'POST');
    assert.equal(opcoes.credentials, 'include');
    assert.deepEqual(Object.fromEntries(Object.entries(opcoes.headers).map(([k, v]) => [k.toLowerCase(), v])), { 'content-type': 'image/webp' });
    assert.equal(opcoes.body, arq, 'o corpo é o objeto File recebido');
    assert.equal(r.ok, true);
  });

  test('EV-16 a base vem do EpiHttp.configurar (com ou sem barra final) e o cabeçalho acompanha o tipo de cada arquivo', async () => {
    for (const [base, tipo] of [['https://api.exemplo.test/api', 'image/png'], ['https://api.exemplo.test/api/', 'image/jpeg']]) {
      const estado = preparar([E.criada()], base);
      await m().enviar({ arquivo: E.arquivo({ tipo, nome: 'x' }), nome: 'X' });
      assert.equal(estado.chamadas[0].url, `https://api.exemplo.test/api/imagens-material/empresa?nome=X`);
      assert.equal(estado.chamadas[0].opcoes.headers['Content-Type'] ?? estado.chamadas[0].opcoes.headers['content-type'], tipo);
    }
  });

  test('EV-17 não usa o EpiHttp.requisitar, não manda Authorization, Cookie, Origin nem cabeçalho de empresa/ator, e não põe autoridade na consulta', async () => {
    const original = EpiHttp.requisitar;
    let usado = 0;
    EpiHttp.requisitar = (...args) => { usado += 1; return original(...args); };
    try {
      const estado = preparar([E.criada()]);
      await m().enviar({ arquivo: E.arquivo(), nome: 'Luva' });
      assert.equal(usado, 0, 'o transporte binário é do módulo novo');
      const cabecalhos = Object.keys(estado.chamadas[0].opcoes.headers).map((k) => k.toLowerCase());
      assert.deepEqual(cabecalhos, ['content-type']);
      assert.equal(/empresa_?id|ator|usuario/i.test(estado.chamadas[0].url.split('?')[1]), false);
    } finally {
      EpiHttp.requisitar = original;
    }
  });

  test('EV-18 sem configurar um fetch, usa o fetch global na hora da chamada (como o EpiHttp)', async () => {
    reiniciar();
    const { fetch, estado } = E.fetchRoteirizado([E.criada()]);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    try {
      Object.defineProperty(globalThis, 'fetch', { value: fetch, configurable: true, writable: true });
      await m().enviar({ arquivo: E.arquivo(), nome: 'Luva' });
      assert.equal(estado.chamadas.length, 1);
    } finally {
      Object.defineProperty(globalThis, 'fetch', original);
    }
  });

  test('EV-19 configurar valida o fetch (função ou nulo) e nulo volta ao global', () => {
    const { configurar } = m('configuração do fetch');
    for (const ruim of ['x', 5, {}, true]) assert.throws(() => configurar({ fetch: ruim }), TypeError, JSON.stringify(ruim));
    assert.doesNotThrow(() => configurar({ fetch: () => {} }));
    assert.doesNotThrow(() => configurar({ fetch: null }));
  });

  test('EV-20 arquivo ou nome inválidos são TypeError ANTES da rede (a tela valida antes; aqui é a segunda barreira)', async () => {
    const estado = preparar([E.criada(), E.criada(), E.criada(), E.criada(), E.criada(), E.criada()]);
    const { enviar } = m();
    await recusaComTypeError(() => enviar({ arquivo: E.arquivo({ tipo: 'image/gif' }), nome: 'X' }), 'tipo');
    await recusaComTypeError(() => enviar({ arquivo: E.arquivo({ tamanho: 0 }), nome: 'X' }), 'vazio');
    await recusaComTypeError(() => enviar({ arquivo: E.arquivo({ tamanho: (2 * E.MIB) + 1 }), nome: 'X' }), 'grande');
    await recusaComTypeError(() => enviar({ arquivo: E.arquivo(), nome: '' }), 'nome vazio');
    await recusaComTypeError(() => enviar({ arquivo: E.arquivo(), nome: 'x'.repeat(101) }), 'nome longo');
    await recusaComTypeError(() => enviar({ arquivo: null, nome: 'X' }), 'sem arquivo');
    assert.equal(estado.chamadas.length, 0);
  });

  test('EV-21 não escreve nada no console (nem o nome da imagem, nem o do arquivo) e nada em armazenamento do navegador', async () => {
    preparar([E.criada('1', 'Foto Secreta')]);
    const dito = [];
    const original = {};
    for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) { original[nivel] = console[nivel]; console[nivel] = (...a) => dito.push(a.join(' ')); }
    try {
      await m().enviar({ arquivo: E.arquivo({ nome: 'foto-secreta.png' }), nome: 'Foto Secreta' });
    } finally {
      for (const nivel of Object.keys(original)) console[nivel] = original[nivel];
    }
    assert.equal(dito.join('\n').includes('ecreta'), false, dito.join('\n'));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — enviar: o que volta', () => {
  const enviarCom = async (resposta, base = BASE) => {
    preparar([resposta], base);
    return m().enviar({ arquivo: E.arquivo(), nome: 'Luva' });
  };

  test('EV-22 201: envelope ok com a imagem criada e reaproveitada=false; o id BIGINT chega como texto exato', async () => {
    const r = await enviarCom(E.criada(E.ID_GRANDE_EMPRESA, 'Luva'));
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
    assert.equal(r.dados.reaproveitada, false);
    assert.equal(r.dados.imagem.id, E.ID_GRANDE_EMPRESA);
    assert.deepEqual(Object.keys(r.dados.imagem).sort(), ['altura', 'estado', 'formato', 'id', 'largura', 'nome', 'origem', 'versao']);
    assert.equal(r.codigo, null);
  });

  test('EV-23 200: o mesmo conteúdo já existente na empresa é sucesso com reaproveitada=true (não é erro e não cria outra)', async () => {
    const r = await enviarCom(E.reaproveitada('12', 'Nome original'));
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.dados.reaproveitada, true);
    assert.equal(r.dados.imagem.nome, 'Nome original');
  });

  test('EV-24 o envelope é compatível com o do EpiHttp: ok, status, dados, codigo, mensagem, detalhes, e os predicados eh* funcionam', async () => {
    const casos = [[401, 'NAO_AUTENTICADO', 'ehNaoAutenticado'], [403, 'SEM_PERMISSAO', 'ehSemAutorizacao'], [409, 'IMAGEM_COTA_EXCEDIDA', 'ehConflito'], [400, 'VALIDACAO', 'ehValidacao']];
    for (const [status, codigo, predicado] of casos) {
      const r = await enviarCom(E.erroDoServidor(status, codigo));
      assert.deepEqual(Object.keys(r).filter((k) => ['ok', 'status', 'dados', 'codigo', 'mensagem', 'detalhes'].includes(k)).sort(), ['codigo', 'dados', 'detalhes', 'mensagem', 'ok', 'status']);
      assert.equal(r.ok, false);
      assert.equal(r.status, status);
      assert.equal(r.codigo, codigo);
      assert.equal(r.dados, null);
      assert.equal(EpiHttp[predicado](r), true, predicado);
    }
  });

  test('EV-25 falha de rede (o fetch rejeita) e leitura do corpo interrompida: status 0, FALHA_DE_REDE, sem lançar; ehFalhaDeRede reconhece', async () => {
    for (const falha of [new TypeError('Failed to fetch'), E.resposta(200, {}, { leituraFalha: true })]) {
      const r = await enviarCom(falha);
      assert.equal(r.ok, false);
      assert.equal(r.status, 0);
      assert.equal(r.codigo, 'FALHA_DE_REDE');
      assert.equal(EpiHttp.ehFalhaDeRede(r), true);
    }
  });

  test('EV-26 resposta que não é JSON (502 de proxy com HTML): RESPOSTA_INVALIDA com o status, sem devolver o texto cru', async () => {
    const r = await enviarCom(E.resposta(502, undefined, { texto: '<html>Bad Gateway segredo-do-proxy</html>' }));
    assert.deepEqual([r.ok, r.status, r.codigo], [false, 502, 'RESPOSTA_INVALIDA']);
    assert.equal(JSON.stringify(r).includes('segredo-do-proxy'), false);
  });

  test('EV-27 o detalhe do 400 (campo, código) chega em detalhes, sem o texto livre do servidor nas mensagens do módulo', async () => {
    const r = await enviarCom(E.erroDoServidor(400, 'VALIDACAO', { corpo: { detalhes: [{ campo: 'query.nome', codigo: 'NOME_INVALIDO', mensagem: 'Nome da imagem inválido' }] } }));
    assert.deepEqual(r.detalhes, [{ campo: 'query.nome', codigo: 'NOME_INVALIDO', mensagem: 'Nome da imagem inválido' }]);
  });

  test('EV-28 Retry-After vira esperaSegundos: inteiro de 1 a 3600 nos 429 e 503; qualquer outra coisa (ausente, 0, negativo, fração, data, texto, acima de 3600) é nulo', async () => {
    for (const [cabecalho, esperado] of [['5', 5], ['10', 10], ['120', 120], ['3600', 3600], ['3601', null], ['0', null], ['-5', null], ['1.5', null], ['abc', null], ['Wed, 21 Oct 2026 07:28:00 GMT', null], [undefined, null]]) {
      for (const [status, codigo] of [[429, 'LIMITE_REQUISICOES_EXCEDIDO'], [503, 'IMAGENS_OCUPADO']]) {
        const r = await enviarCom(E.erroDoServidor(status, codigo, { cabecalhos: cabecalho === undefined ? {} : { 'Retry-After': cabecalho } }));
        assert.equal(r.esperaSegundos, esperado, `${status} com Retry-After ${cabecalho}`);
      }
    }
    assert.equal((await enviarCom(E.criada())).esperaSegundos ?? null, null, 'sucesso não traz espera');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — mensagens: texto próprio por falha, nunca o do servidor', () => {
  const casos = [
    ['falha de rede', new TypeError('Failed to fetch'), /rede|conex/i],
    ['400 imagem inválida', E.erroDoServidor(400, 'IMAGEM_INVALIDA'), /inv[áa]lida|corrompid|danificad|n[ãa]o foi poss[íi]vel ler/i],
    ['400 dimensões', E.erroDoServidor(400, 'IMAGEM_DIMENSOES_INVALIDAS'), /320.*4096|4096.*320/s],
    ['400 nome', E.erroDoServidor(400, 'VALIDACAO', { corpo: { detalhes: [{ campo: 'query.nome', codigo: 'NOME_INVALIDO', mensagem: 'x' }] } }), /nome/i],
    ['401', E.erroDoServidor(401, 'NAO_AUTENTICADO'), /sess[ãa]o/i],
    ['403', E.erroDoServidor(403, 'SEM_PERMISSAO'), /permiss/i],
    ['409 cota', E.erroDoServidor(409, 'IMAGEM_COTA_EXCEDIDA'), /cota|limite de imagens/i],
    ['413', E.erroDoServidor(413, 'PAYLOAD_MUITO_GRANDE'), /2 ?MiB|muito grande|tamanho/i],
    ['415 tipo de conteúdo', E.erroDoServidor(415, 'TIPO_CONTEUDO_NAO_SUPORTADO'), /PNG, JPEG ou WebP/i],
    ['415 formato', E.erroDoServidor(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'), /PNG, JPEG ou WebP/i],
    ['415 animada', E.erroDoServidor(415, 'IMAGEM_ANIMADA_NAO_SUPORTADA'), /animad/i],
    ['422 tempo', E.erroDoServidor(422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'), /tempo|demor|n[ãa]o foi poss[íi]vel processar/i],
    ['422 saída', E.erroDoServidor(422, 'IMAGEM_SAIDA_EXCEDE_LIMITE'), /processar|complex|grande/i],
    ['429', E.erroDoServidor(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } }), /muitas|aguarde|tentativas|limite/i],
    ['503 indisponível', E.erroDoServidor(503, 'IMAGENS_INDISPONIVEL'), /indispon/i],
    ['503 ocupado', E.erroDoServidor(503, 'IMAGENS_OCUPADO', { cabecalhos: { 'Retry-After': '5' } }), /ocupad|muitas imagens|tente novamente|aguarde/i],
    ['500', E.erroDoServidor(500, 'ERRO_INTERNO'), /n[ãa]o foi poss[íi]vel|tente novamente/i],
    ['resposta que não é JSON', E.resposta(502, undefined, { texto: '<html>x</html>' }), /n[ãa]o foi poss[íi]vel|tente novamente/i],
  ];
  for (const [nome, resposta, esperado] of casos) {
    test(`EV-29 mensagens.deEnvio — ${nome}`, async () => {
      preparar([resposta]);
      const r = await m().enviar({ arquivo: E.arquivo(), nome: 'Luva' });
      const texto = m().mensagens.deEnvio(r);
      assert.equal(typeof texto, 'string');
      assert.match(texto, esperado);
      assert.equal(texto.includes(E.TEXTO_DO_SERVIDOR), false, 'o texto do servidor não pode aparecer');
      assert.equal(/SQL|relation|imagens_empresa|Bad Gateway/i.test(texto), false);
    });
  }

  test('EV-30 deEnvio devolve nulo para sucesso (201 e 200); deArquivo e deNome têm texto próprio; código desconhecido não lança', async () => {
    const { mensagens } = m('textos do envio');
    preparar([E.criada(), E.reaproveitada()]);
    assert.equal(mensagens.deEnvio(await m().enviar({ arquivo: E.arquivo(), nome: 'A' })), null);
    assert.equal(mensagens.deEnvio(await m().enviar({ arquivo: E.arquivo({ semente: 'b' }), nome: 'B' })), null);
    assert.match(mensagens.deArquivo('FORMATO_NAO_ACEITO'), /PNG, JPEG ou WebP/);
    assert.match(mensagens.deArquivo('ARQUIVO_VAZIO'), /vazi/i);
    assert.match(mensagens.deArquivo('ARQUIVO_GRANDE'), /2 ?MiB/);
    assert.equal(typeof mensagens.deArquivo('CODIGO_NOVO'), 'string');
    assert.match(mensagens.deNome(), /1 a 100/);
    assert.equal(typeof mensagens.TEXTOS, 'object');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — enviarLote: um arquivo por vez, estado por arquivo, parada no que não adianta insistir (FE-11)', () => {
  test('EV-31 envia na ordem, um de cada vez (nunca dois ao mesmo tempo), e resume cada arquivo: CRIADA ou REAPROVEITADA com a imagem do servidor', async () => {
    const estado = preparar([E.criada('1', 'Imagem 1'), E.reaproveitada('2', 'Já existia'), E.criada('3', 'Imagem 3')]);
    const lote = itens(3);
    const r = await m().enviarLote(lote);
    assert.equal(estado.chamadas.length, 3);
    assert.equal(estado.maxEmVoo, 1, 'sequencial');
    assert.deepEqual(estado.chamadas.map((c) => c.opcoes.body), lote.map((x) => x.arquivo), 'na ordem da lista, com os próprios arquivos');
    assert.deepEqual(estado.chamadas.map((c) => new URL(c.url).searchParams.get('nome')), ['Imagem 1', 'Imagem 2', 'Imagem 3']);
    assert.equal(r.interrompido, null);
    assert.deepEqual(estadosDe(r), ['CRIADA', 'REAPROVEITADA', 'CRIADA']);
    assert.deepEqual(r.itens.map((x) => x.imagem.id), ['1', '2', '3']);
    assert.equal(r.itens[1].reaproveitada, true);
  });

  test('EV-32 avisa cada mudança: ENVIANDO e depois o estado final de cada arquivo, na ordem', async () => {
    preparar([E.criada('1'), E.erroDoServidor(415, 'IMAGEM_FORMATO_NAO_SUPORTADO')]);
    const eventos = [];
    await m().enviarLote(itens(2), { aoMudar: (indice, estado) => eventos.push(`${indice}:${typeof estado === 'string' ? estado : estado.estado}`) });
    assert.deepEqual(eventos, ['0:ENVIANDO', '0:CRIADA', '1:ENVIANDO', '1:RECUSADA']);
  });

  test('EV-33 recusa DO ARQUIVO (400 inválida e dimensões, 413, 415, 422) não para o lote: o arquivo fica RECUSADA com código e texto próprios e o seguinte é enviado', async () => {
    const recusas = [
      E.erroDoServidor(400, 'IMAGEM_INVALIDA'), E.erroDoServidor(400, 'IMAGEM_DIMENSOES_INVALIDAS'), E.erroDoServidor(413, 'PAYLOAD_MUITO_GRANDE'),
      E.erroDoServidor(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'), E.erroDoServidor(415, 'IMAGEM_ANIMADA_NAO_SUPORTADA'), E.erroDoServidor(422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'),
    ];
    const estado = preparar([...recusas, E.criada('9')]);
    const r = await m().enviarLote(itens(7));
    assert.equal(estado.chamadas.length, 7);
    assert.deepEqual(estadosDe(r), ['RECUSADA', 'RECUSADA', 'RECUSADA', 'RECUSADA', 'RECUSADA', 'RECUSADA', 'CRIADA']);
    assert.deepEqual(r.itens.slice(0, 6).map((x) => x.codigo), ['IMAGEM_INVALIDA', 'IMAGEM_DIMENSOES_INVALIDAS', 'PAYLOAD_MUITO_GRANDE', 'IMAGEM_FORMATO_NAO_SUPORTADO', 'IMAGEM_ANIMADA_NAO_SUPORTADA', 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO']);
    for (const x of r.itens.slice(0, 6)) assert.ok(typeof x.mensagem === 'string' && x.mensagem.length > 0 && !x.mensagem.includes(E.TEXTO_DO_SERVIDOR));
    assert.equal(r.interrompido, null);
  });

  test('EV-34 sessão encerrada (401): para na hora; o arquivo atual e os seguintes ficam PENDENTE (nada foi aceito) e interrompido = SESSAO', async () => {
    const estado = preparar([E.criada('1'), E.erroDoServidor(401, 'NAO_AUTENTICADO')]);
    const r = await m().enviarLote(itens(4));
    assert.equal(estado.chamadas.length, 2);
    assert.deepEqual(estadosDe(r), ['CRIADA', 'PENDENTE', 'PENDENTE', 'PENDENTE']);
    assert.equal(r.interrompido, 'SESSAO');
  });

  test('EV-35 sem permissão (403): para, itens PENDENTE, interrompido = PERMISSAO', async () => {
    const estado = preparar([E.erroDoServidor(403, 'SEM_PERMISSAO')]);
    const r = await m().enviarLote(itens(3));
    assert.equal(estado.chamadas.length, 1);
    assert.deepEqual(estadosDe(r), ['PENDENTE', 'PENDENTE', 'PENDENTE']);
    assert.equal(r.interrompido, 'PERMISSAO');
  });

  test('EV-36 cota da empresa (409 IMAGEM_COTA_EXCEDIDA): o arquivo é RECUSADA, os seguintes ficam PENDENTE (iam falhar igual) e interrompido = COTA', async () => {
    const estado = preparar([E.criada('1'), E.erroDoServidor(409, 'IMAGEM_COTA_EXCEDIDA')]);
    const r = await m().enviarLote(itens(4));
    assert.equal(estado.chamadas.length, 2);
    assert.deepEqual(estadosDe(r), ['CRIADA', 'RECUSADA', 'PENDENTE', 'PENDENTE']);
    assert.equal(r.itens[1].codigo, 'IMAGEM_COTA_EXCEDIDA');
    assert.equal(r.interrompido, 'COTA');
  });

  test('EV-37 limite de envios (429): para, o arquivo atual e os seguintes ficam PENDENTE com a espera sugerida; interrompido = LIMITE; não insiste', async () => {
    const estado = preparar([E.criada('1'), E.criada('2'), E.erroDoServidor(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '20' } })]);
    const r = await m().enviarLote(itens(5));
    assert.equal(estado.chamadas.length, 3, 'nenhuma repetição automática');
    assert.deepEqual(estadosDe(r), ['CRIADA', 'CRIADA', 'PENDENTE', 'PENDENTE', 'PENDENTE']);
    assert.equal(r.interrompido, 'LIMITE');
    assert.equal(r.esperaSegundos, 20);
  });

  test('EV-38 servidor ocupado (503 IMAGENS_OCUPADO): para com espera sugerida; indisponível (503 IMAGENS_INDISPONIVEL): para sem espera; ambos deixam o atual PENDENTE', async () => {
    let estado = preparar([E.erroDoServidor(503, 'IMAGENS_OCUPADO', { cabecalhos: { 'Retry-After': '5' } })]);
    let r = await m().enviarLote(itens(3));
    assert.equal(estado.chamadas.length, 1);
    assert.deepEqual([r.interrompido, r.esperaSegundos, estadosDe(r)[0]], ['OCUPADO', 5, 'PENDENTE']);
    estado = preparar([E.erroDoServidor(503, 'IMAGENS_INDISPONIVEL')]);
    r = await m().enviarLote(itens(3));
    assert.equal(estado.chamadas.length, 1);
    assert.deepEqual([r.interrompido, estadosDe(r)[0]], ['INDISPONIVEL', 'PENDENTE']);
    assert.ok(r.esperaSegundos === undefined || r.esperaSegundos === null);
  });

  test('EV-39 falha de rede: o resultado do arquivo é INCERTO (o servidor pode ter gravado): INCERTA, os seguintes PENDENTE, interrompido = REDE', async () => {
    const estado = preparar([E.criada('1'), new TypeError('Failed to fetch')]);
    const r = await m().enviarLote(itens(4));
    assert.equal(estado.chamadas.length, 2);
    assert.deepEqual(estadosDe(r), ['CRIADA', 'INCERTA', 'PENDENTE', 'PENDENTE']);
    assert.equal(r.interrompido, 'REDE');
  });

  test('EV-40 erro 5xx do servidor (500, 502, 504) também é incerto: INCERTA e interrompido = SERVIDOR (padrão do projeto: nada de repetição automática)', async () => {
    for (const status of [500, 502, 504]) {
      const estado = preparar([status === 500 ? E.erroDoServidor(500, 'ERRO_INTERNO') : E.resposta(status, undefined, { texto: '<html>x</html>' })]);
      const r = await m().enviarLote(itens(2));
      assert.equal(estado.chamadas.length, 1, `${status}`);
      assert.deepEqual([estadosDe(r)[0], estadosDe(r)[1], r.interrompido], ['INCERTA', 'PENDENTE', 'SERVIDOR'], `${status}`);
    }
  });

  test('EV-41 retomar: o chamador reenvia só o que ficou INCERTA ou PENDENTE, com os MESMOS arquivos; a incerta que o servidor já tinha volta 200 reaproveitada e conta como sucesso', async () => {
    const lote = itens(3);
    preparar([E.criada('1'), new TypeError('Failed to fetch')]);
    const primeira = await m().enviarLote(lote);
    assert.deepEqual(estadosDe(primeira), ['CRIADA', 'INCERTA', 'PENDENTE']);
    const estado = preparar([E.reaproveitada('2', 'Imagem 2'), E.criada('3', 'Imagem 3')]);
    const restante = lote.filter((_, i) => primeira.itens[i].estado === 'INCERTA' || primeira.itens[i].estado === 'PENDENTE');
    const segunda = await m().enviarLote(restante);
    assert.deepEqual(estadosDe(segunda), ['REAPROVEITADA', 'CRIADA']);
    assert.equal(segunda.interrompido, null);
    assert.deepEqual(estado.chamadas.map((c) => c.opcoes.body), [lote[1].arquivo, lote[2].arquivo]);
  });

  test('EV-42 um lote vazio, maior que o limite do backend, com item que não é arquivo ou com nome inválido é TypeError antes da rede', async () => {
    const estado = preparar([E.criada(), E.criada()]);
    const { enviarLote } = m();
    await recusaComTypeError(() => enviarLote([]), 'vazio');
    await recusaComTypeError(() => enviarLote(itens(E.LIMITES_DO_BACKEND.loteMaximo + 1)), 'acima do limite');
    await recusaComTypeError(() => enviarLote([{ arquivo: 'x.png', nome: 'X' }]), 'não é arquivo');
    await recusaComTypeError(() => enviarLote([item(1, { nome: '' })]), 'nome inválido');
    await recusaComTypeError(() => enviarLote([item(1, { arquivo: E.arquivo({ tipo: 'image/gif' }) })]), 'tipo recusado');
    await recusaComTypeError(() => enviarLote('x'), 'não é lista');
    assert.equal(estado.chamadas.length, 0);
  });

  test('EV-43 aceita exatamente o lote máximo (10) e o envia por inteiro, um por vez', async () => {
    const estado = preparar(Array.from({ length: 10 }, (_, i) => E.criada(String(i + 1))));
    const r = await m().enviarLote(itens(10));
    assert.equal(estado.chamadas.length, 10);
    assert.equal(estado.maxEmVoo, 1);
    assert.equal(estadosDe(r).every((x) => x === 'CRIADA'), true);
  });

  test('EV-44 um segundo lote enquanto o primeiro está em andamento é recusado (ENVIO_EM_ANDAMENTO) e nada extra sai pela rede; depois que o primeiro termina, um novo lote funciona', async () => {
    const pausa = E.segurar(E.criada('1'));
    const estado = preparar([() => pausa.espera, E.criada('2')]);
    const primeiro = m().enviarLote(itens(1));
    await new Promise((resolver) => { setImmediate(resolver); });
    let erro = null;
    try { await m().enviarLote(itens(1)); } catch (falha) { erro = falha; }
    assert.ok(erro, 'o segundo lote precisa ser recusado');
    assert.equal(erro.codigo, 'ENVIO_EM_ANDAMENTO');
    assert.equal(estado.chamadas.length, 1);
    pausa.liberar();
    assert.equal((await primeiro).itens[0].estado, 'CRIADA');
    assert.equal((await m().enviarLote(itens(1))).itens[0].estado, 'CRIADA');
    assert.equal(estado.chamadas.length, 2);
  });

  test('EV-45 o lote nunca repete um arquivo sozinho: depois de qualquer parada o fetch foi chamado uma vez por arquivo tentado', async () => {
    for (const parada of [E.erroDoServidor(401, 'NAO_AUTENTICADO'), E.erroDoServidor(403, 'SEM_PERMISSAO'), E.erroDoServidor(429, 'LIMITE_REQUISICOES_EXCEDIDO'), E.erroDoServidor(503, 'IMAGENS_OCUPADO'),
      E.erroDoServidor(503, 'IMAGENS_INDISPONIVEL'), E.erroDoServidor(409, 'IMAGEM_COTA_EXCEDIDA'), new TypeError('Failed to fetch'), E.erroDoServidor(500, 'ERRO_INTERNO')]) {
      const estado = preparar([parada, E.criada(), E.criada()]);
      await m().enviarLote(itens(3));
      assert.equal(estado.chamadas.length, 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — proibições de segurança do código do módulo novo', () => {
  const codigo = () => { m('verificação do código-fonte'); return E.codigoSemComentarios(E.MODULO_ENVIO); };

  test('EV-46 não monta HTML por texto nem executa código dinâmico', () => {
    const c = codigo();
    for (const padrao of E.H.PROIBIDOS_DE_DOM) assert.equal(padrao.test(c), false, `o módulo usa ${padrao}`);
  });

  test('EV-47 não guarda nada no navegador: sem localStorage, sessionStorage, document.cookie ou indexedDB', () => {
    const c = codigo();
    for (const padrao of E.H.PROIBIDOS_DE_ARMAZENAMENTO) assert.equal(padrao.test(c), false, `o módulo usa ${padrao}`);
  });

  test('EV-48 é o único módulo de imagens com fetch: usa fetch, mas não XMLHttpRequest nem sendBeacon, e nunca converte o arquivo (sem FormData, base64, FileReader ou texto)', () => {
    const c = codigo();
    assert.match(c, /\bfetch\b/);
    for (const padrao of [/\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bFormData\b/, /\bbtoa\s*\(/, /\batob\s*\(/, /\bFileReader\b/, /\breadAs\w+\s*\(/, /\bJSON\.stringify\s*\(\s*(arquivo|file)\b/]) {
      assert.equal(padrao.test(c), false, `o módulo usa ${padrao}`);
    }
  });

  test('EV-49 não escreve cabeçalhos que só o navegador ou o servidor decidem (Origin, Cookie, Authorization) nem usa EpiHttp.requisitar', () => {
    const c = codigo();
    assert.equal(/['"](origin|cookie|authorization)['"]/i.test(c), false);
    assert.equal(/\.requisitar\s*\(/.test(c), false);
  });

  test('EV-50 o módulo da seleção (imagens-material.js) continua SEM fetch próprio: o transporte binário mora só no módulo novo', () => {
    const c = E.H.lerModuloSemComentarios();
    for (const padrao of E.H.PROIBIDOS_DE_TRANSPORTE) assert.equal(padrao.test(c), false, `imagens-material.js usa ${padrao}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 EV — por que o transporte é separado: o EpiHttp só envia JSON (caracterização, verde desde o nascimento)', () => {
  test('EV-51 EpiHttp.requisitar com um File no corpo envia JSON "{}" com Content-Type application/json: o arquivo se perderia em silêncio', async () => {
    const { fetch, estado } = E.fetchRoteirizado([E.criada()]);
    EpiHttp.configurar({ baseUrl: BASE, fetch });
    try {
      await EpiHttp.requisitar('POST', '/imagens-material/empresa?nome=X', { corpo: E.arquivo({ semente: 'perdido' }) });
    } finally {
      EpiHttp.configurar({ baseUrl: BASE, fetch: null });
    }
    assert.equal(estado.chamadas[0].opcoes.body, '{}');
    assert.equal(estado.chamadas[0].opcoes.headers['Content-Type'], 'application/json');
  });

  test('EV-52 o EpiHttp não tem modo binário nem lê cabeçalhos de resposta (Retry-After): os dois motivos do módulo próprio', () => {
    assert.equal(['enviarBinario', 'upload', 'enviarArquivo', 'requisitarBinario'].some((n) => n in EpiHttp), false);
    assert.equal(/headers\.get|Retry-After/i.test(E.codigoSemComentarios('js/api-http.js')), false);
  });
});
