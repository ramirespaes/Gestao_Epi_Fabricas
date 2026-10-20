'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./dom-pagina');
const H = require('./imagens-material');
const P = require('./imagens-material-persistencia');
const { lerConfiguracao } = require('../../../backend/src/config/imagens');

/**
 * Apoio dos testes da Unidade 5C-7 (RED do frontend do upload e do gerenciamento das imagens da empresa). Sem PostgreSQL, sem a API 3300 e sem upload real: a página real
 * `pages/materials.html` roda no harness de DOM com uma BIBLIOTECA SIMULADA COM ESTADO que segue o contrato lido no backend local (routes, schemas, serviços e repositórios
 * de imagem-material*): lista conjunta (padrão primeiro, depois a da empresa, paginada em conjunto, `emUso`, estado), envio binário (201 / 200 reaproveitada / erros),
 * renomear, inativar, reativar e excluir (com `confirmacao: true`), e materiais que associam imagem PADRAO ou EMPRESA (só ativa; inexistente, de outra empresa ou inativa é 404
 * IMAGEM_NAO_ENCONTRADA). O envio é BINÁRIO: o harness de página só entende JSON no `fetch`, então este auxiliar intercepta o POST de envio ANTES dele e guarda o que a página
 * mandou (URL, método, credenciais, cabeçalhos e o próprio objeto do corpo).
 *
 * Os controles NOVOS são localizados pelo NOME ACESSÍVEL e pelo tipo do campo (rótulos do protótipo V6 aprovado: abas "Todas", "Padrão SafeWork" e "Minha Empresa", botão
 * "Adicionar imagens", campo de arquivos, botão "Adicionar à biblioteca"), nunca por classe CSS: a aparência final é da 5C-8. Todo teste que depende de algo ainda inexistente
 * começa por uma conferência com o marcador "comportamento ausente:", para a falha ser legível e classificável.
 */

const RAIZ = H.RAIZ;
const API = H.API;
const IDS = H.IDS;
const MIB = 1024 * 1024;
const ID_GRANDE_EMPRESA = '9007199254740993'; // 2^53 + 1
const MARCA = 'comportamento ausente:';
const MODULO_ENVIO = 'js/imagens-envio.js';
const ABAS = Object.freeze(['Todas', 'Padrão SafeWork', 'Minha Empresa']);
const LIMITES_DO_BACKEND = lerConfiguracao({});
const TIPOS_ACEITOS = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

// ───────────────────────── módulos ─────────────────────────

const existeEnvio = () => fs.existsSync(path.join(RAIZ, MODULO_ENVIO));

/** O módulo novo de transporte binário (EpiImagensEnvio). */
function envio(para = 'transporte binário do envio de imagens') {
  assert.ok(existeEnvio(), `${MARCA} ${MODULO_ENVIO} não existe (${para})`);
  return require('../../js/imagens-envio'); // eslint-disable-line global-require
}

/** O módulo da seleção (EpiImagensMaterial), já existente; os testes exigem, um a um, o que a 5C-8 vai acrescentar a ele. */
function biblioteca() {
  return require('../../js/imagens-material'); // eslint-disable-line global-require
}

/** Código-fonte de um arquivo do frontend, sem comentários (para as proibições de segurança). */
function codigoSemComentarios(relativo) {
  return fs.readFileSync(path.join(RAIZ, relativo), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function exigirFuncao(objeto, nome, para) {
  assert.ok(objeto && typeof objeto[nome] === 'function', `${MARCA} ${para}`);
  return objeto[nome];
}

// ───────────────────────── arquivos e respostas falsas ─────────────────────────

/** Arquivo REAL (File do Node) com conteúdo determinístico; `tamanho` cria um conteúdo desse tamanho. */
function arquivo({ nome = 'luva.png', tipo = 'image/png', semente, tamanho, bytes } = {}) {
  let conteudo = bytes;
  if (conteudo === undefined) conteudo = tamanho !== undefined ? Buffer.alloc(tamanho, 1) : Buffer.from(`conteudo-de-teste:${semente ?? nome}`);
  return new File([conteudo], nome, { type: tipo });
}

const arquivos = (quantos, base = 'imagem') => Array.from({ length: quantos }, (_, i) => arquivo({ nome: `${base}-${i + 1}.png`, semente: `${base}-${i + 1}` }));
const sha256Do = async (arq) => crypto.createHash('sha256').update(Buffer.from(await arq.arrayBuffer())).digest('hex');

const TEXTO_DO_SERVIDOR = H.TEXTO_DO_SERVIDOR;

/** Resposta de fetch para os testes do módulo (sem DOM). `cabecalhos` é consultado sem diferenciar maiúsculas. */
function resposta(status, corpo, { cabecalhos = {}, texto, leituraFalha = false } = {}) {
  const mapa = Object.fromEntries(Object.entries(cabecalhos).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (nome) => mapa[String(nome).toLowerCase()] ?? null },
    text: async () => {
      if (leituraFalha) throw new TypeError('terminated');
      if (texto !== undefined) return texto;
      return corpo === undefined ? '' : JSON.stringify(corpo);
    },
  };
}

const erroDoServidor = (status, codigo, extra = {}) => resposta(status, { status: 'error', codigo, message: TEXTO_DO_SERVIDOR, ...extra.corpo }, { cabecalhos: extra.cabecalhos });
const IMAGEM_CRIADA = (id = '7001', nome = 'Luva') => ({ origem: 'EMPRESA', id, nome, formato: 'PNG', largura: 1024, altura: 1024, versao: 1, estado: 'ATIVA' });
const criada = (id, nome) => resposta(201, { status: 'ok', imagem: IMAGEM_CRIADA(id, nome), reaproveitada: false });
const reaproveitada = (id, nome) => resposta(200, { status: 'ok', imagem: IMAGEM_CRIADA(id, nome), reaproveitada: true });

/**
 * `fetch` de teste: cada chamada consome o próximo item de `roteiro` (resposta pronta, função (chamada) => resposta | Promise, ou um Error para a falha de rede).
 * Registra URL e opções de cada chamada e quantas estavam em andamento ao mesmo tempo.
 */
function fetchRoteirizado(roteiro = []) {
  const fila = [...roteiro];
  const estado = { chamadas: [], emVoo: 0, maxEmVoo: 0 };
  const fetch = async (url, opcoes = {}) => {
    estado.chamadas.push({ url: String(url), opcoes });
    estado.emVoo += 1;
    estado.maxEmVoo = Math.max(estado.maxEmVoo, estado.emVoo);
    try {
      if (fila.length === 0) throw new Error('roteiro esgotado: o fetch foi chamado mais vezes do que o previsto');
      const proximo = fila.shift();
      const r = typeof proximo === 'function' ? await proximo({ url: String(url), opcoes }) : proximo;
      if (r instanceof Error) throw r;
      return r;
    } finally {
      estado.emVoo -= 1;
    }
  };
  return { fetch, estado };
}

/** Resposta que só sai quando `liberar()` for chamada. */
function segurar(r) {
  let liberar;
  const espera = new Promise((resolve) => { liberar = () => resolve(r); });
  return { espera, liberar };
}

// ───────────────────────── a biblioteca simulada com estado ─────────────────────────

const ID_CANONICO = /^[1-9][0-9]*$/;
const CONTROLE = /\p{Cc}/u;
const erro = (status, codigo, detalhes) => ({ status, corpo: { status: 'error', codigo, message: TEXTO_DO_SERVIDOR, ...(detalhes ? { detalhes } : {}) } });
/** Resposta de erro para `b.roteiroEnvio` (a forma que a biblioteca simulada devolve ao interceptador do envio), com cabeçalhos opcionais como o Retry-After. */
const erroDeEnvio = (status, codigo, { cabecalhos, detalhes } = {}) => ({ ...erro(status, codigo, detalhes), ...(cabecalhos ? { cabecalhos } : {}) });
const erro400 = (campo, codigo) => erro(400, 'VALIDACAO', [{ campo, codigo, mensagem: 'Valor inválido' }]);
const naoEncontrada = () => erro(404, 'IMAGEM_NAO_ENCONTRADA');

/** Mesma regra do servidor para o nome: aparar, NFC, 1 a 100 pontos de código, sem caractere de controle. */
function nomeNormalizado(nome) {
  if (typeof nome !== 'string') return null;
  const n = nome.trim().normalize('NFC');
  const tamanho = Array.from(n).length;
  return tamanho === 0 || tamanho > 100 || CONTROLE.test(n) ? null : n;
}

function normalizarEmpresa(i, ordem) {
  const nome = i.nome ?? `Imagem ${ordem + 1}`;
  return {
    id: String(i.id), nome, formato: i.formato ?? 'PNG', largura: i.largura ?? 1024, altura: i.altura ?? 1024, versao: i.versao ?? 1, estado: i.estado ?? 'ATIVA',
    sha: i.sha ?? crypto.createHash('sha256').update(`empresa:${i.id}:${nome}`).digest('hex'),
  };
}

const comparar = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

/**
 * `padrao`: imagens da Biblioteca Padrão (forma de `GET /imagens-material`); `empresa`: [{ id, nome, versao?, estado?, sha? }]; `cotaImagens`: teto de imagens da empresa
 * (ativas e inativas); `proximoId`: de onde saem os ids dos envios novos (texto decimal).
 */
function criarBiblioteca({ padrao = H.imagensPadrao(), empresa = [], cotaImagens = 300, proximoId = 5001 } = {}) {
  const b = {
    padrao: padrao.map((i) => ({ ...i })),
    empresa: empresa.map(normalizarEmpresa),
    materiais: new Map(),
    cotaImagens,
    proximoId,
    roteiroEnvio: [],
    pausa: null,
    envios: [],
    operacoes: [],
    emVoo: 0,
    maxEmVoo: 0,
    permissoes: null,
  };

  b.usos = (origem, id) => [...b.materiais.values()].filter((m) => m.imagem && m.imagem.origem === origem && m.imagem.id === id).length;
  b.acharEmpresa = (id) => b.empresa.find((i) => i.id === id) ?? null;
  const publica = (i) => ({ origem: 'EMPRESA', id: i.id, nome: i.nome, formato: i.formato, largura: i.largura, altura: i.altura, versao: i.versao, estado: i.estado });
  b.publica = publica;
  b.permitido = (operacao) => b.permissoes === null || b.permissoes.recursos.materials[operacao] === true;
  const semPermissao = () => erro(403, 'SEM_PERMISSAO');

  /** Lista conjunta como o serviço devolve: padrão primeiro, depois a da empresa, paginadas juntas; o estado só vale para a empresa. */
  b.listar = (url) => {
    if (!b.permitido('visualizar')) return semPermissao();
    const q = new URL(url).searchParams;
    for (const chave of q.keys()) if (!['pagina', 'limite', 'origem', 'estado', 'busca', 'tipoNome'].includes(chave)) return erro400(`query.${chave}`, 'CAMPO_NAO_PERMITIDO');
    const origem = q.get('origem') ?? 'TODAS';
    const estado = q.get('estado') ?? 'ATIVA';
    const pagina = Number(q.get('pagina') ?? 1);
    const limite = Number(q.get('limite') ?? 20);
    if (!['TODAS', 'PADRAO', 'EMPRESA'].includes(origem)) return erro400('query.origem', 'VALOR_NAO_PERMITIDO');
    if (!['ATIVA', 'INATIVA', 'TODAS'].includes(estado)) return erro400('query.estado', 'VALOR_NAO_PERMITIDO');
    if (!Number.isInteger(pagina) || pagina < 1 || pagina > 10000) return erro400('query.pagina', 'FORA_DO_INTERVALO');
    if (!Number.isInteger(limite) || limite < 1 || limite > 100) return erro400('query.limite', 'FORA_DO_INTERVALO');
    const busca = q.get('busca');
    const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const passaBusca = (i) => busca === null || norm(i.nome).includes(norm(busca));
    const comPadrao = origem !== 'PADRAO' ? origem === 'TODAS' : true;
    const comEmpresa = origem !== 'PADRAO';
    const doPadrao = comPadrao ? b.padrao.filter(passaBusca) : [];
    const daEmpresa = comEmpresa ? b.empresa.filter((i) => (estado === 'TODAS' || i.estado === estado) && passaBusca(i)).sort(comparar) : [];
    const deslocamento = (pagina - 1) * limite;
    const fatiaPadrao = deslocamento < doPadrao.length ? doPadrao.slice(deslocamento, deslocamento + limite) : [];
    const faltam = limite - fatiaPadrao.length;
    const deslocamentoEmpresa = Math.max(0, deslocamento - doPadrao.length);
    const fatiaEmpresa = faltam > 0 ? daEmpresa.slice(deslocamentoEmpresa, deslocamentoEmpresa + faltam) : [];
    const imagens = [
      ...fatiaPadrao.map((i) => ({ ...i, emUso: b.usos('PADRAO', i.id) })),
      ...fatiaEmpresa.map((i) => ({ ...publica(i), sugerida: null, emUso: b.usos('EMPRESA', i.id) })),
    ];
    return { status: 200, corpo: { status: 'ok', imagens, total: doPadrao.length + daEmpresa.length, pagina, limite } };
  };

  b.enviar = async (registro) => {
    b.envios.push(registro);
    if (b.roteiroEnvio.length > 0) {
      const forcada = b.roteiroEnvio.shift(); // null = este envio segue a regra normal da biblioteca
      if (forcada !== null) return typeof forcada === 'function' ? forcada(registro) : forcada;
    }
    if (!b.permitido('criar')) return semPermissao();
    const tipo = registro.cabecalhos['content-type'] ?? '';
    if (!/^image\//.test(tipo)) return erro(415, 'TIPO_CONTEUDO_NAO_SUPORTADO');
    const arq = registro.corpo;
    if (arq.size > LIMITES_DO_BACKEND.arquivoMaxBytes) return erro(413, 'PAYLOAD_MUITO_GRANDE');
    if (registro.consulta.join(',') !== 'nome') return erro400('query', 'CAMPO_NAO_PERMITIDO');
    const nome = nomeNormalizado(registro.nome);
    if (nome === null) return erro400('query.nome', 'NOME_INVALIDO');
    if (arq.size === 0 || !TIPOS_ACEITOS.includes(tipo)) return erro(415, 'IMAGEM_FORMATO_NAO_SUPORTADO');
    const sha = await sha256Do(arq);
    const existente = b.empresa.find((i) => i.sha === sha);
    if (existente) return { status: 200, corpo: { status: 'ok', imagem: publica(existente), reaproveitada: true } };
    if (b.empresa.length >= b.cotaImagens) return erro(409, 'IMAGEM_COTA_EXCEDIDA');
    const nova = normalizarEmpresa({ id: b.proximoId, nome, sha }, b.empresa.length);
    b.proximoId = String(BigInt(b.proximoId) + 1n);
    b.empresa.push(nova);
    return { status: 201, corpo: { status: 'ok', imagem: publica(nova), reaproveitada: false } };
  };

  b.renomear = (id, corpo) => {
    if (!b.permitido('editar')) return semPermissao();
    const i = b.acharEmpresa(id);
    if (i === null) return naoEncontrada();
    if (!corpo || typeof corpo !== 'object' || Object.keys(corpo).join(',') !== 'nome') return erro400('body', 'CAMPO_NAO_PERMITIDO');
    const nome = nomeNormalizado(corpo.nome);
    if (nome === null) return erro400('body.nome', 'NOME_INVALIDO');
    b.operacoes.push({ operacao: 'renomear', id, corpo });
    const alterado = i.nome !== nome;
    i.nome = nome;
    return { status: 200, corpo: { status: 'ok', imagem: publica(i), alterado } };
  };

  b.mudarEstado = (id, novo, corpo) => {
    if (!b.permitido('editar')) return semPermissao();
    if (!corpo || typeof corpo !== 'object' || Object.keys(corpo).length !== 0) return erro400('body', 'CAMPO_NAO_PERMITIDO');
    const i = b.acharEmpresa(id);
    if (i === null) return naoEncontrada();
    b.operacoes.push({ operacao: novo === 'INATIVA' ? 'inativar' : 'reativar', id, corpo });
    if (i.estado === novo) return { status: 200, corpo: { status: 'ok', imagem: publica(i), alterado: false } };
    if (novo === 'INATIVA' && b.usos('EMPRESA', id) > 0) return erro(409, 'IMAGEM_EM_USO');
    i.estado = novo;
    return { status: 200, corpo: { status: 'ok', imagem: publica(i), alterado: true } };
  };

  b.excluir = (id, corpo) => {
    if (!b.permitido('editar')) return semPermissao();
    if (!corpo || typeof corpo !== 'object' || Object.keys(corpo).join(',') !== 'confirmacao' || corpo.confirmacao !== true) return erro400('body.confirmacao', 'VALOR_NAO_PERMITIDO');
    const i = b.acharEmpresa(id);
    if (i === null) return naoEncontrada();
    if (b.usos('EMPRESA', id) > 0) return erro(409, 'IMAGEM_EM_USO');
    b.operacoes.push({ operacao: 'excluir', id, corpo });
    b.empresa = b.empresa.filter((x) => x !== i);
    return { status: 200, corpo: { status: 'ok', excluida: true, imagemId: id } };
  };

  return b;
}

/** `imagem` do corpo de POST/PATCH de /materiais, como o serviço decide: ausente = não mexe; null = remove; { origem, id } = associa (só imagem ativa). */
function lerImagemDoCorpo(b, corpo) {
  if (!Object.hasOwn(corpo, 'imagem')) return { imagem: undefined };
  const v = corpo.imagem;
  if (v === null) return { imagem: null };
  const recusa = () => ({ resposta: erro400('body.imagem', 'IMAGEM_INVALIDA') });
  if (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'id,origem') return recusa();
  if (!['PADRAO', 'EMPRESA'].includes(v.origem) || typeof v.id !== 'string' || !ID_CANONICO.test(v.id)) return recusa();
  if (v.origem === 'PADRAO') {
    const p = b.padrao.find((i) => i.id === v.id);
    return p ? { imagem: { origem: 'PADRAO', id: p.id, versao: p.versao, nome: p.nome } } : { resposta: naoEncontrada() };
  }
  const e = b.acharEmpresa(v.id);
  return e && e.estado === 'ATIVA' ? { imagem: { origem: 'EMPRESA', id: e.id, versao: e.versao, nome: e.nome } } : { resposta: naoEncontrada() };
}

/** Rotas JSON da página de materiais sobre a biblioteca simulada (o envio binário é interceptado à parte por `instalarEnvio`). */
function servidor({ p = H.permissoes(), biblioteca = criarBiblioteca(), imagemInicial = null, outros = [], respostas = {} } = {}) {
  const b = biblioteca;
  b.permissoes = p;
  b.materiais.set(501, { ...H.MATERIAL, imagem: imagemInicial });
  for (const m of outros) b.materiais.set(m.id, { ...m, imagem: m.imagem ?? null });
  b.proximoMaterial = 999;
  // As rotas de materiais do servidor da 5B têm estado próprio: saem daqui para valerem as daqui, que conhecem a biblioteca da empresa.
  const { rotas: rotasDaCincoB } = H.servidor({ p, imagens: b.padrao });
  const base = Object.fromEntries(Object.entries(rotasDaCincoB).filter(([chave]) => !/^(GET|PATCH|POST) \/materiais\/?\d*/.test(chave)));
  const material = (m) => ({ status: 200, corpo: { status: 'ok', material: m } });
  const lista = () => [...b.materiais.values()];
  const estatico = {
    ...base,
    'GET /materiais': () => ({ status: 200, corpo: { status: 'ok', materiais: lista(), total: lista().length, pagina: 1, limite: 100 } }),
    'GET /imagens-material': (c) => b.listar(c.url),
    'POST /materiais': (c) => {
      const lida = lerImagemDoCorpo(b, c.corpo);
      if (lida.resposta) return lida.resposta;
      const { imagem: _fora, tamanhos, ...demais } = c.corpo;
      const criado = { ...H.MATERIAL, ...demais, id: b.proximoMaterial, tamanhos: tamanhos ?? [], imagem: lida.imagem ?? null };
      b.proximoMaterial += 1;
      b.materiais.set(criado.id, criado);
      return { status: 201, corpo: { status: 'ok', material: criado } };
    },
  };
  const dinamicas = [
    [/^GET \/materiais\/(\d+)$/, (c, id) => (b.materiais.has(Number(id)) ? material(b.materiais.get(Number(id))) : erro(404, 'MATERIAL_NAO_ENCONTRADO'))],
    [/^PATCH \/materiais\/(\d+)$/, (c, id) => {
      const n = Number(id);
      if (!b.materiais.has(n)) return erro(404, 'MATERIAL_NAO_ENCONTRADO');
      if (Object.keys(c.corpo).length === 0) return erro(400, 'MATERIAL_SEM_ALTERACAO');
      const lida = lerImagemDoCorpo(b, c.corpo);
      if (lida.resposta) return lida.resposta;
      const { imagem: _fora, ...demais } = c.corpo;
      const atualizado = { ...b.materiais.get(n), ...demais, ...(lida.imagem === undefined ? {} : { imagem: lida.imagem }) };
      b.materiais.set(n, atualizado);
      return material(atualizado);
    }],
    [/^GET \/materiais\/(\d+)\/estoque\/lotes$/, (c, id) => ({ status: 200, corpo: { status: 'ok', material: b.materiais.get(Number(id)) ?? H.MATERIAL, saldos: [], lotes: [], totais: {} } })],
    [/^GET \/materiais\/(\d+)\/minimos$/, () => ({ status: 200, corpo: { status: 'ok', material: H.MATERIAL, minimos: [], padrao: 0 } })],
    [/^PATCH \/imagens-material\/empresa\/(\d+)$/, (c, id) => b.renomear(id, c.corpo)],
    [/^POST \/imagens-material\/empresa\/(\d+)\/inativar$/, (c, id) => b.mudarEstado(id, 'INATIVA', c.corpo)],
    [/^POST \/imagens-material\/empresa\/(\d+)\/reativar$/, (c, id) => b.mudarEstado(id, 'ATIVA', c.corpo)],
    [/^DELETE \/imagens-material\/empresa\/(\d+)$/, (c, id) => b.excluir(id, c.corpo)],
  ];
  const rotas = new Proxy({}, {
    get(_, chave) {
      if (typeof chave !== 'string') return undefined;
      if (Object.hasOwn(respostas, chave)) {
        const r = respostas[chave];
        const regra = Object.hasOwn(estatico, chave) ? estatico[chave] : dinamicas.map(([re, fn]) => (re.test(chave) ? (c) => fn(c, ...re.exec(chave).slice(1)) : null)).find(Boolean);
        return typeof r === 'function' ? (c) => r(c, regra) : r;
      }
      if (Object.hasOwn(estatico, chave)) return estatico[chave];
      for (const [re, fn] of dinamicas) {
        const m = re.exec(chave);
        if (m) return (c) => fn(c, ...m.slice(1));
      }
      return undefined;
    },
  });
  return { rotas, biblioteca: b, p };
}

// ───────────────────────── a página real, com o envio binário interceptado ─────────────────────────

const planos = (cabecalhos) => {
  const saida = {};
  if (!cabecalhos) return saida;
  const entradas = typeof cabecalhos.entries === 'function' ? [...cabecalhos.entries()] : Object.entries(cabecalhos);
  for (const [k, v] of entradas) saida[String(k).toLowerCase()] = String(v);
  return saida;
};

function respostaBinaria(r) {
  const mapa = Object.fromEntries(Object.entries(r.cabecalhos ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (nome) => mapa[String(nome).toLowerCase()] ?? null },
    text: async () => (r.corpo === undefined ? '' : JSON.stringify(r.corpo)),
  };
}

/** Espiões de URL de objeto (prévias dos arquivos escolhidos): delegam ao original e registram o que foi criado e o que foi revogado. */
const objetosDeUrl = { criados: [], revogados: [] };
if (!URL.__espiadoPela5C7) {
  const criarOriginal = URL.createObjectURL.bind(URL);
  const revogarOriginal = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (alvo) => { const u = criarOriginal(alvo); objetosDeUrl.criados.push(u); return u; };
  URL.revokeObjectURL = (u) => { objetosDeUrl.revogados.push(u); return revogarOriginal(u); };
  Object.defineProperty(URL, '__espiadoPela5C7', { value: true });
}

/** Intercepta, no `fetch` global da página, o POST binário de envio; o resto segue para o harness. Devolve a lista de envios registrados. */
function instalarEnvio(pg, b) {
  const original = pg.janela.fetch;
  pg.janela.fetch = async (destino, opcoes = {}) => {
    const alvo = String(destino);
    const metodo = String(opcoes.method ?? 'GET').toUpperCase();
    if (metodo === 'POST' && /\/imagens-material\/empresa\?/.test(alvo)) {
      const url = new URL(alvo);
      const registro = {
        url: alvo, caminho: url.pathname, consulta: [...url.searchParams.keys()], nome: url.searchParams.get('nome'), metodo, credentials: opcoes.credentials,
        cabecalhos: planos(opcoes.headers), chavesDeOpcoes: Object.keys(opcoes), corpo: opcoes.body,
      };
      b.emVoo += 1;
      b.maxEmVoo = Math.max(b.maxEmVoo, b.emVoo);
      try {
        if (b.pausa) await b.pausa.espera;
        const r = await b.enviar(registro);
        if (r instanceof Error) throw r;
        return respostaBinaria(r);
      } finally {
        b.emVoo -= 1;
      }
    }
    return original(destino, opcoes);
  };
  return b.envios;
}

/** Abre a página real de materiais sobre a biblioteca simulada. `b.pausa = segurar()` segura os envios até `liberar()`. */
async function abrir(opcoes = {}) {
  objetosDeUrl.criados.length = 0;
  objetosDeUrl.revogados.length = 0;
  const sv = servidor(opcoes);
  const pg = abrirPagina(H.PAGINA, { rotas: sv.rotas });
  await pg.esperar();
  instalarEnvio(pg, sv.biblioteca);
  return { pg, b: sv.biblioteca, p: sv.p, envios: sv.biblioteca.envios, objetosDeUrl };
}

function segurarEnvios(b) {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  b.pausa = { espera, liberar: () => { b.pausa = null; liberar(); } };
  return b.pausa;
}

// ───────────────────────── leitura da tela, por nome acessível ─────────────────────────

/** Texto que um leitor de tela falaria: sem o que é `aria-hidden` (os ícones por ligadura). */
function textoVisivel(no) {
  if (no.nodeType === 3) return no.textContent;
  if (no.getAttribute('aria-hidden') === 'true') return '';
  return no.filhos.map(textoVisivel).join('');
}
const nomeAcessivel = (no) => (no.getAttribute('aria-label') ?? textoVisivel(no)).replace(/\s+/g, ' ').trim();

const modal = (pg) => pg.el(IDS.modal);
const botaoPorNome = (raiz, regex) => raiz.querySelectorAll('button').find((b) => regex.test(nomeAcessivel(b))) ?? null;
function exigirBotao(raiz, regex, descricao) {
  const botao = botaoPorNome(raiz, regex);
  assert.ok(botao, `${MARCA} ${descricao}`);
  return botao;
}

function abas(pg) {
  const m = modal(pg);
  return Object.fromEntries(ABAS.map((nome) => [nome, m.querySelectorAll('button').find((b) => nomeAcessivel(b) === nome) ?? null]));
}
function exigirAbas(pg) {
  const a = abas(pg);
  for (const [nome, botao] of Object.entries(a)) assert.ok(botao, `${MARCA} aba "${nome}" no seletor de imagens`);
  return a;
}
const abasAtivas = (pg) => ABAS.filter((nome) => abas(pg)[nome]?.getAttribute('aria-pressed') === 'true');
async function irParaAba(pg, nome) {
  await exigirAbas(pg)[nome].disparar('click');
  await pg.esperar();
}

const par = (e) => `${e.getAttribute('data-imagem-origem')}:${e.getAttribute('data-imagem-id')}`;
const pares = (pg) => H.itens(pg).map(par);
const paresMarcados = (pg) => H.marcados(pg).map(par);

const botaoAdicionar = (pg) => botaoPorNome(modal(pg), /Adicionar imagens/i);
const campoDeArquivos = (pg) => modal(pg).querySelectorAll('input').find((i) => i.type === 'file') ?? null;
const botaoEnviar = (pg) => botaoPorNome(modal(pg), /Adicionar à biblioteca/i);
const botaoVoltar = (pg) => botaoPorNome(modal(pg), /Voltar à biblioteca/i);

/** Abre o seletor e entra na vista "Adicionar imagens". */
async function abrirEnvio(pg) {
  await H.abrirSeletor(pg);
  await exigirBotao(modal(pg), /Adicionar imagens/i, 'botão "Adicionar imagens" no seletor de imagens').disparar('click');
  await pg.esperar();
  assert.ok(campoDeArquivos(pg), `${MARCA} campo de arquivos (input type=file) da vista "Adicionar imagens"`);
  return campoDeArquivos(pg);
}

/** Espera a fila da página e também o relógio real: o resumo SHA-256 dos arquivos e o envio simulado terminam fora da fila de microtarefas da página. */
async function aguardar(pg, ms = 15) {
  await pg.esperar();
  await new Promise((resolver) => { setTimeout(resolver, ms); });
  await pg.esperar();
}

/** Espera os envios simulados acabarem: nenhum em voo e nenhum envio novo em três leituras seguidas (um envio segurado por `segurarEnvios` também estabiliza a leitura). */
async function aguardarEnvios(pg, b, maximoMs = 4000) {
  const limite = Date.now() + maximoMs;
  let anterior = -1;
  let estavel = 0;
  while (Date.now() < limite && estavel < 3) {
    await aguardar(pg, 5);
    const agora = b.envios.length + (b.emVoo > 0 ? 1000 : 0);
    estavel = agora === anterior ? estavel + 1 : 0;
    anterior = agora;
  }
}

/** Simula a escolha de arquivos pelo navegador: preenche `files` do campo, dispara `change` e espera a página ler os arquivos. */
async function escolherArquivos(pg, lista) {
  const campo = campoDeArquivos(pg);
  assert.ok(campo, `${MARCA} campo de arquivos da vista "Adicionar imagens"`);
  campo.files = lista;
  await campo.disparar('change');
  await aguardar(pg);
}

/**
 * O item da lista de envio que corresponde ao arquivo: achado pelo botão que leva o nome do arquivo no rótulo. O item é o <li> (ou listitem) que o contém; sem ele, o maior
 * ancestral que tem só o botão de tirar DESTE arquivo e não contém o campo de arquivos nem as ações da vista.
 */
function itemDoArquivo(pg, arq) {
  const m = modal(pg);
  const remover = m.querySelectorAll('button').find((b) => (b.getAttribute('aria-label') ?? '').includes(arq.name));
  assert.ok(remover, `${MARCA} item do arquivo ${arq.name} na lista de envio (botão cujo rótulo traz o nome do arquivo)`);
  const eRemover = (b) => /^Tirar .+ da lista$/.test(b.getAttribute('aria-label') ?? '');
  const eAcaoDaVista = (no) => no.querySelectorAll('input').some((i) => i.type === 'file') || botaoPorNome(no, /Adicionar à biblioteca|Voltar à biblioteca/i) !== null;
  let item = remover.closest('li, [role="listitem"]');
  if (item === null) {
    item = remover.parentElement;
    for (let no = remover.parentElement; no !== null && no !== m; no = no.parentElement) {
      if (no.querySelectorAll('button').filter(eRemover).length !== 1 || eAcaoDaVista(no)) break;
      item = no;
    }
  }
  return { remover, item, nomeInput: item.querySelectorAll('input').find((i) => i.type === 'text') ?? null };
}
const textoDoItem = (pg, arq) => textoVisivel(itemDoArquivo(pg, arq).item).replace(/\s+/g, ' ').trim();

async function digitarNome(pg, arq, texto) {
  const { nomeInput } = itemDoArquivo(pg, arq);
  assert.ok(nomeInput, `${MARCA} campo de nome do arquivo ${arq.name}`);
  nomeInput.value = texto;
  await nomeInput.disparar('input');
  await pg.esperar();
}

/** Clica em "Adicionar à biblioteca"; com a biblioteca `b`, espera todos os envios simulados terminarem. */
async function enviarLote(pg, b) {
  const botao = botaoEnviar(pg);
  assert.ok(botao, `${MARCA} botão "Adicionar à biblioteca" da vista de envio`);
  await botao.disparar('click');
  if (b) await aguardarEnvios(pg, b);
  else await aguardar(pg);
}

/** Controle que a pessoa consegue usar: existe, está visível e não está desabilitado. */
const acionavel = (pg, no) => no !== null && no !== undefined && pg.visivelNo(no) && !no.disabled;
const naoVisivel = (pg, no) => no === null || no === undefined || !pg.visivelNo(no);
const nomesDosBotoes = (raiz) => raiz.querySelectorAll('button').map(nomeAcessivel);
const normalizarTexto = (t) => String(t).replace(/\s+/g, ' ').trim();
const contagemTexto = (pg) => normalizarTexto(pg.texto(IDS.contagem));
const estadoDoSeletor = (pg) => normalizarTexto(pg.texto(IDS.estadoModal));
const resumoDaSelecao = (pg) => normalizarTexto(pg.texto('imagemResumoSelecao'));
const textoDoSeletor = (pg) => normalizarTexto(textoVisivel(modal(pg)));
/** Entradas de `empresa` para `criarBiblioteca`: n imagens ativas com ids a partir de `inicio`. */
const empresaN = (n, inicio = 7001, base = 'Imagem da empresa') => Array.from({ length: n }, (_, i) => ({ id: String(inicio + i), nome: `${base} ${i + 1}`, versao: 1 }));

/** Marca (origem, id) no seletor e confirma: a escolha vale só no formulário até salvar o material. */
async function escolherNoSeletor(pg, origem, id) {
  await H.abrirSeletor(pg);
  const alvo = H.itens(pg).find((e) => par(e) === `${origem}:${id}`);
  assert.ok(alvo, `${MARCA} opção ${origem}:${id} no seletor (opções: ${pares(pg).slice(0, 5).join(', ')}…)`);
  await alvo.disparar('click');
  await H.confirmar(pg);
  await pg.esperar();
}

const urlMiniaturaEmpresa = (imagem) => `${API}/imagens-material/empresa/${imagem.id}/miniatura?v=${imagem.versao}`;
const urlMiniaturaDe = (imagem) => (imagem.origem === 'EMPRESA' ? urlMiniaturaEmpresa(imagem) : H.urlMiniatura(imagem));
const chamadasDaLista = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /imagens-material');
const consultaDaChamada = (c) => Object.fromEntries(new URL(c.url).searchParams.entries());

// `H` (helpers/imagens-material.js) e `P` (helpers/imagens-material-persistencia.js) saem como estão; `servidor` e `abrir` deste arquivo são OUTROS, os da biblioteca da empresa.
module.exports = {
  H, P,
  RAIZ, API, IDS, MIB, ID_GRANDE_EMPRESA, MARCA, MODULO_ENVIO, ABAS, LIMITES_DO_BACKEND, TIPOS_ACEITOS, TEXTO_DO_SERVIDOR,
  existeEnvio, envio, biblioteca, codigoSemComentarios, exigirFuncao,
  arquivo, arquivos, sha256Do, resposta, erroDoServidor, erroDeEnvio, IMAGEM_CRIADA, criada, reaproveitada, fetchRoteirizado, segurar,
  nomeNormalizado, criarBiblioteca, lerImagemDoCorpo, servidor, instalarEnvio, abrir, segurarEnvios, objetosDeUrl,
  textoVisivel, nomeAcessivel, modal, botaoPorNome, exigirBotao, abas, exigirAbas, abasAtivas, irParaAba, par, pares, paresMarcados, botaoAdicionar, campoDeArquivos, botaoEnviar,
  botaoVoltar, abrirEnvio, aguardar, aguardarEnvios, escolherArquivos, itemDoArquivo, textoDoItem, digitarNome, enviarLote, acionavel, naoVisivel, nomesDosBotoes, normalizarTexto,
  contagemTexto, estadoDoSeletor, resumoDaSelecao, textoDoSeletor, empresaN, escolherNoSeletor, urlMiniaturaEmpresa, urlMiniaturaDe, chamadasDaLista, consultaDaChamada,
};
