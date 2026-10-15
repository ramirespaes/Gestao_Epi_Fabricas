'use strict';

/**
 * Etapa I (RED) — infraestrutura dos testes do Totem de Autoatendimento. Arquivo NOVO: não altera dom-pagina.js nem
 * nenhum teste anterior; só o usa.
 *
 * O que fornece:
 *  - `abrirTotem()`: abre `frontend/totem/index.html` no harness de páginas existente. A página derivada AINDA NÃO EXISTE:
 *    enquanto não existir, a abertura falha com uma asserção legível ("RED I: ... ainda não existe"), que é o RED esperado.
 *  - um relógio virtual injetado como PRIMEIRO script da página (setTimeout/setInterval/Date.now/performance.now sob
 *    controle do teste), `AbortController` e um `fetch` que devolve cabeçalhos de resposta (Retry-After). Nada disso muda
 *    o que a página faz: só deixa o teste observar o tempo e a rede sem esperas reais.
 *  - `criarServidor()`: um backend FALSO fiel aos contratos reais das Etapas C–G (corpos estritos, respostas, códigos de
 *    erro, atendimento de 60 s deslizantes pelo relógio do servidor, idempotência, 409, limite de identificação). Ele
 *    registra violações do contrato por parte da página (`servidor.violacoes`).
 *  - seletores e textos da interface (contrato de teste da Etapa I, ver I-RED/).
 *
 * Diagnóstico de validade do RED: com TOTEM_I_DIAGNOSTICO_HTML=<caminho do protótipo original>, `abrirTotem()` abre esse
 * HTML (somente leitura) no lugar da página derivada, para provar que os testes falham por COMPORTAMENTO ausente e não
 * por erro de ambiente. Nunca altera o arquivo.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, existePagina, RAIZ, semComentarios } = require('./dom-pagina');

const ARQUIVOS = Object.freeze({ html: 'totem/index.html', boot: 'totem/boot.js', js: 'totem/totem.js', css: 'totem/totem.css' });
const BASE_TEMPO = 1760000000000;
const BASE = '/atendimento-token/tablet';
const SENTINELA = 'SENTINELA_MENSAGEM_DO_SERVIDOR';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MOTIVOS = Object.freeze(['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO']);
const SITUACOES_ABERTAS = Object.freeze(['DISPONIVEL_PARA_RETIRADA', 'AGUARDANDO_ESTOQUE', 'AGUARDANDO_APROVACAO', 'INDISPONIVEL']);

/** Textos da interface (catálogo `I-GOVERNANCA-Q0-Q8/02-CATALOGO-DE-TEXTOS-E-APROVACAO.md`), literais. */
const TEXTOS = Object.freeze({
  ativacaoTitulo: 'Ativar este tablet',
  ativacaoCorpo: 'Toque em Ativar para liberar este tablet para uso.',
  ativacaoBotao: 'Ativar',
  ativacaoFalha: 'Código inválido ou expirado. Peça um novo código à administração.',
  naoAutorizado: 'Este tablet não está autorizado. Procure a administração do sistema.',
  foraDaRede: 'Este tablet está fora da rede autorizada. Procure a administração do sistema.',
  identifique: 'Identifique-se',
  subtituloIdentificacao: 'Digite seu CPF ou o número da sua matrícula para ver os equipamentos disponíveis.',
  marcadorCampo: 'Toque nos números abaixo',
  privacidade: 'Seus dados são usados apenas para identificar você nesta retirada.',
  campoVazio: 'Digite seu CPF ou sua matrícula.',
  naoEncontrado: 'Não encontramos esse CPF ou matrícula. Confira os dados ou procure o RH.',
  cpfIncompleto: 'Digite os 11 números do CPF.',
  limite: 'Muitas tentativas. Aguarde alguns segundos e tente de novo.',
  avisoDisponiveis: 'Você possui EPIs disponíveis para retirada.',
  avisoProcure: 'Procure a Segurança do Trabalho para realizar a retirada desses materiais.',
  avisoOk: 'OK — Solicitar novos EPIs',
  aguardandoAprovacao: 'Aguardando aprovação',
  aguardandoEstoque: 'Aprovados, aguardando a chegada do material',
  indisponivel: 'Temporariamente indisponíveis. Procure a Segurança do Trabalho.',
  produtosSubtitulo: 'Toque em um produto para ver os tamanhos disponíveis.',
  nestaRetirada: 'Nesta retirada:',
  solicitado: '✓ Solicitado',
  jaSolicitouNestaRetirada: 'Você já solicitou este item nesta retirada.',
  adicionar: 'Adicionar ao pedido',
  semGhe: 'Seu cadastro ainda não tem materiais liberados. Procure a Segurança do Trabalho.',
  gheInativo: 'Os materiais do seu grupo estão indisponíveis no momento. Procure a Segurança do Trabalho.',
  semMateriais: 'Não há materiais liberados para o seu grupo. Procure a Segurança do Trabalho.',
  revisar: 'Revisar e enviar pedido',
  jaIncluido: 'Item já incluído no pedido.',
  limite20: 'Limite de 20 itens.',
  revise: 'Revise o seu pedido',
  escolhaMotivo: 'Escolha o motivo de cada item',
  remover: 'Remover',
  enviar: 'Enviar pedido',
  motivos: Object.freeze({ SUBSTITUICAO_PRAZO: 'Substituição por prazo', DESGASTE_DANO: 'Desgaste ou dano', PERDA_EXTRAVIO: 'Perda ou extravio' }),
  duplicado: 'Este item já foi solicitado.',
  naoLiberado: 'Este material não está liberado para você.',
  expirada: 'Sessão encerrada por inatividade.',
  comunicacao: 'Não foi possível se comunicar com o sistema. Tente novamente.',
  incerto: 'Não conseguimos confirmar o envio do seu pedido.',
  verificar: 'Verificar',
  processando: 'Ainda estamos processando o seu pedido. Toque em Verificar novamente.',
  reenviar: 'Enviar novamente',
  sessaoTerminou: 'Sua sessão terminou. Identifique-se novamente para ver seus pedidos.',
  confirmacao1: 'Solicitação enviada com sucesso.',
  confirmacao2: 'Seu pedido foi registrado e será analisado pela Segurança do Trabalho.',
  concluir: 'Concluir e sair',
});

/** Textos que NÃO podem existir na página integrada (reserva, saldo, demonstração, mensagens trocadas). */
const PROIBIDOS = Object.freeze([
  /\breserv/i, /poucas unidades/i, /demonstra[cç][aã]o/i, /bookmark_add/i, /\bsaldo\b/i,
  /este item já foi solicitado e está em andamento/i, /não está mais disponível para você/i, /código do pedido/i,
]);

const FUNCIONARIOS = Object.freeze([
  Object.freeze({ id: 1, nome: 'Ana Beatriz Teste Sobrenome', cpf: '52998224725', matricula: '000123', ativo: true }),
  Object.freeze({ id: 2, nome: 'Bruno Carvalho Fictício', cpf: '11144477735', matricula: 'mat-0045', ativo: true }),
  Object.freeze({ id: 3, nome: 'Carla Zero Esquerda', cpf: '39053344705', matricula: '0123', ativo: true }),
  Object.freeze({ id: 4, nome: 'Daniel Sem Zero', cpf: '86288366757', matricula: '123', ativo: true }),
  Object.freeze({ id: 5, nome: 'Eva Inativa Teste', cpf: '16899535009', matricula: 'inativa-1', ativo: false }),
]);

const IMAGEM_AUSENTE = Object.freeze({ disponivel: false });
const CATALOGO = Object.freeze([
  Object.freeze({ id: 11, nome: 'Botina de Segurança', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'PES', tipo: Object.freeze({ id: 1, nome: 'Botina de Segurança' }), exigeTamanho: true, tamanhos: Object.freeze(['38', '39', '40', '41', '42']), imagem: IMAGEM_AUSENTE }),
  Object.freeze({ id: 12, nome: 'Protetor Auricular', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'AUDICAO', tipo: Object.freeze({ id: 2, nome: 'Proteção Auricular Descartável' }), exigeTamanho: false, tamanhos: Object.freeze([]), imagem: IMAGEM_AUSENTE }),
  Object.freeze({ id: 13, nome: 'Camiseta', unidade: 'UN', categoria: 'Uniforme', grupoProtecao: null, tipo: Object.freeze({ id: 3, nome: 'Camiseta' }), exigeTamanho: true, tamanhos: Object.freeze(['P', 'M', 'G']), imagem: IMAGEM_AUSENTE }),
  Object.freeze({ id: 14, nome: 'Capacete', unidade: 'UN', categoria: 'EPI', grupoProtecao: 'CABECA', tipo: Object.freeze({ id: 4, nome: 'Capacete' }), exigeTamanho: false, tamanhos: Object.freeze([]), imagem: IMAGEM_AUSENTE }),
]);

// ───────────────────────── relógio virtual, AbortController e fetch com cabeçalhos (script da página) ─────────────────────────

const SHIM = `(function (g) {
  'use strict';
  var BASE_TEMPO = ${BASE_TEMPO};
  var t = 0; var proximoId = 1; var fila = [];
  function criar(fn, ms, args, repetir) {
    var id = proximoId++; var atraso = Math.max(0, Number(ms) || 0);
    fila.push({ id: id, quando: t + atraso, ms: atraso, fn: fn, args: args || [], repetir: repetir });
    return id;
  }
  g.setTimeout = function (fn, ms) { return criar(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  g.setInterval = function (fn, ms) { return criar(fn, ms < 1 ? 1 : ms, Array.prototype.slice.call(arguments, 2), true); };
  g.clearTimeout = g.clearInterval = function (id) { for (var i = 0; i < fila.length; i++) { if (fila[i].id === id) { fila.splice(i, 1); return; } } };
  g.__relogio = {
    agora: function () { return t; },
    pendentes: function () { return fila.map(function (x) { return { id: x.id, quando: x.quando, ms: x.ms, repetir: x.repetir }; }); },
    avancar: function (ms) {
      var alvo = t + ms;
      for (;;) {
        var proximo = null;
        for (var i = 0; i < fila.length; i++) {
          var x = fila[i];
          if (x.quando <= alvo && (proximo === null || x.quando < proximo.quando || (x.quando === proximo.quando && x.id < proximo.id))) proximo = x;
        }
        if (proximo === null) break;
        t = proximo.quando;
        if (proximo.repetir) proximo.quando = t + proximo.ms; else fila.splice(fila.indexOf(proximo), 1);
        proximo.fn.apply(null, proximo.args);
      }
      t = alvo;
    },
  };
  Date.now = function () { return BASE_TEMPO + t; };
  g.performance = { now: function () { return t; } };
  // Sorteio controlável (Ciclo 2, K4): com __aleatorio.valor = null o Math.random é o original; o teste fixa um valor em [0, 1) para
  // observar o jitter do heartbeat. Nada mais da página usa Math.random (a chave do pedido vem de crypto).
  var sorteioOriginal = Math.random;
  g.__aleatorio = { valor: null };
  Math.random = function () { return g.__aleatorio.valor === null ? sorteioOriginal() : g.__aleatorio.valor; };
  g.__abortos = 0;
  if (typeof g.scrollTo !== 'function') g.scrollTo = function () {}; // o harness não tem rolagem; o navegador tem

  if (typeof g.AbortController === 'undefined') {
    var Sinal = function () { this.aborted = false; this.reason = undefined; this._o = []; this.onabort = null; };
    Sinal.prototype.addEventListener = function (tipo, fn) { if (tipo === 'abort') this._o.push(fn); };
    Sinal.prototype.removeEventListener = function (tipo, fn) { this._o = this._o.filter(function (f) { return f !== fn; }); };
    Sinal.prototype.throwIfAborted = function () { if (this.aborted) { var e = new Error('abortado'); e.name = 'AbortError'; throw e; } };
    var Controlador = function () { this.signal = new Sinal(); };
    Controlador.prototype.abort = function (motivo) {
      var s = this.signal; if (s.aborted) return;
      s.aborted = true; s.reason = motivo; g.__abortos += 1;
      s._o.slice().forEach(function (f) { f({ type: 'abort' }); });
      if (typeof s.onabort === 'function') s.onabort({ type: 'abort' });
    };
    Sinal.timeout = function (ms) { var c = new Controlador(); g.setTimeout(function () { c.abort({ name: 'TimeoutError' }); }, ms); return c.signal; };
    g.AbortController = Controlador; g.AbortSignal = Sinal;
  }
  var base = g.fetch;
  function erroAbort(motivo) { var e = new Error('abortado'); e.name = 'AbortError'; e.reason = motivo; return e; }
  g.fetch = function (destino, opcoes) {
    var o = {}; var origem = opcoes || {};
    for (var k in origem) { if (Object.prototype.hasOwnProperty.call(origem, k)) o[k] = origem[k]; }
    o.method = String(o.method || 'GET').toUpperCase();
    var sinal = o.signal;
    return new Promise(function (resolver, rejeitar) {
      var fim = false;
      if (sinal && sinal.aborted) { rejeitar(erroAbort(sinal.reason)); return; }
      if (sinal && sinal.addEventListener) sinal.addEventListener('abort', function () { if (!fim) { fim = true; rejeitar(erroAbort(sinal.reason)); } });
      base(destino, o).then(function (r) {
        var status = r.status;
        return r.text().then(function (texto) { return { status: status, texto: texto }; });
      }).then(function (r) {
        if (fim) return; fim = true;
        var envelope = null; try { envelope = JSON.parse(r.texto); } catch (e) { envelope = null; }
        var embrulhado = envelope !== null && typeof envelope === 'object' && Object.prototype.hasOwnProperty.call(envelope, '__b');
        var cab = embrulhado && envelope.__h ? envelope.__h : {};
        // __raw entrega o corpo tal como está (para simular um corpo que NÃO é JSON); sem ele, o corpo vai como JSON.
        var bruto = embrulhado && Object.prototype.hasOwnProperty.call(envelope, '__raw');
        var texto = bruto ? String(envelope.__raw) : (embrulhado ? (envelope.__b === null ? '' : JSON.stringify(envelope.__b)) : r.texto);
        resolver({
          status: r.status, ok: r.status >= 200 && r.status < 300,
          headers: { get: function (n) { var l = String(n).toLowerCase(); for (var h in cab) { if (h.toLowerCase() === l) return String(cab[h]); } return null; }, has: function (n) { var l = String(n).toLowerCase(); for (var h in cab) { if (h.toLowerCase() === l) return true; } return false; } },
          text: function () { return Promise.resolve(texto); },
          json: function () { return Promise.resolve(texto === '' ? null : JSON.parse(texto)); },
        });
      }, function (erro) { if (fim) return; fim = true; rejeitar(erro); });
    });
  };
})(globalThis);`;

function injetarShim(html) {
  const tag = `<script>${SHIM}</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
}

// ───────────────────────── servidor falso fiel aos contratos C–G ─────────────────────────

const resp = (status, corpo, cabecalhos = {}, bruto = undefined) => ({
  status,
  texto: JSON.stringify({ __h: cabecalhos, __b: corpo === undefined ? null : corpo, ...(bruto === undefined ? {} : { __raw: bruto }) }),
});
const erro = (status, codigo, extra = {}) => resp(status, { status: 'error', codigo, message: `${SENTINELA}_${codigo}`, ...extra }, extra.cabecalhos);
const iso = (ms) => new Date(BASE_TEMPO + ms).toISOString();
const soDigitos = (v) => String(v).replace(/\D/g, '');
const chaves = (o) => Object.keys(o).sort().join(',');
const valorCab = (cabecalhos, nome) => { const k = Object.keys(cabecalhos || {}).find((x) => x.toLowerCase() === nome); return k === undefined ? null : cabecalhos[k]; };

function criarServidor(opcoes = {}) {
  const s = {
    agora: 0,
    tablet: opcoes.tablet ?? 'ativo', // 'ativo' | 'nao_autorizado' | 'rede'
    codigos: new Map(Object.entries(opcoes.codigos ?? {})), // codigo -> 'valido' | 'usado' | 'expirado' | 'revogado'
    funcionarios: opcoes.funcionarios ?? FUNCIONARIOS.map((f) => ({ ...f })),
    materiais: opcoes.materiais ?? CATALOGO.map((m) => ({ ...m })),
    estadoCatalogo: opcoes.estadoCatalogo ?? 'OK', // 'OK' | 'SEM_GHE' | 'GHE_INATIVO' | 'SEM_MATERIAIS'
    solicitacoes: opcoes.solicitacoes ?? [], // itens que a Etapa G devolve
    pedidos: new Map(),
    seq: 1000,
    atendimentos: [],
    cookie: null,
    reativacoes: 0,
    ativacoes: 0,
    atividades: 0,
    chamadas: [],
    // Ciclo 2 (K4): as batidas de presença do tablet (POST /heartbeat) ficam num canal PRÓPRIO, fora de `chamadas`: elas não são
    // operação do atendimento e as sequências de chamadas dos testes anteriores continuam descrevendo só as operações.
    batidas: [],
    ordem: 0,
    violacoes: [],
    falhas: [],
    segurados: [],
    emVoo: 0,
    emVooPorRota: {},
    maxEmVoo: {},
    identificacoes: [],
    restantePara: [], // fila de restanteSegundos a devolver nas próximas atividades
  };
  const atual = () => s.atendimentos[s.atendimentos.length - 1] ?? null;
  const vigente = () => { const a = atual(); return a !== null && a.encerrado === null && a.expira > s.agora ? a : null; };
  const cookieVale = () => s.cookie !== null && s.cookie.ate > s.agora;
  s.atendimentoAberto = () => vigente() !== null;
  s.restanteMs = () => { const a = vigente(); return a === null ? 0 : a.expira - s.agora; };
  s.avancar = (ms) => { s.agora += ms; };
  s.chamadasDe = (chave) => s.chamadas.filter((c) => c.chave === chave);
  s.contar = (chave) => s.chamadasDe(chave).length;
  s.falhar = (chave, modo, extra = {}) => { s.falhas.push({ chave, modo, restantes: extra.vezes ?? 1, ...extra }); };
  s.liberarSegurados = () => { const lista = s.segurados.splice(0); lista.forEach((l) => l()); };

  const nomeDe = (id) => s.funcionarios.find((f) => f.id === id);
  const primeiroNome = (f) => f.nome.trim().split(/\s+/)[0];
  const dispositivo = { nome: 'Tablet de Teste', unidade: 'Unidade Teste', setor: 'Setor Teste', localInstalacao: 'Local Teste' };

  const barreira = () => {
    if (s.tablet === 'nao_autorizado') return erro(401, 'DISPOSITIVO_NAO_AUTORIZADO');
    if (s.tablet === 'rede') return erro(403, 'REDE_NAO_AUTORIZADA');
    return null;
  };
  const exigirAtendimento = () => { const a = vigente(); return a === null ? { negado: erro(401, 'ATENDIMENTO_INVALIDO') } : { a }; };
  const resumo = (a, segundos) => ({
    funcionario: { primeiroNome: primeiroNome(nomeDe(a.funcionarioId)) }, expiraEm: iso(a.expira), restanteSegundos: segundos,
  });

  function validarPedido(corpo) {
    const problemas = [];
    if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) return ['corpo não é objeto'];
    if (chaves(corpo) !== 'chaveIdempotencia,itens') problemas.push(`campos do corpo: ${chaves(corpo)}`);
    if (!UUID.test(String(corpo.chaveIdempotencia))) problemas.push('chaveIdempotencia não é UUID');
    if (!Array.isArray(corpo.itens) || corpo.itens.length < 1 || corpo.itens.length > 20) problemas.push('itens fora de 1..20');
    (Array.isArray(corpo.itens) ? corpo.itens : []).forEach((i, n) => {
      if (i === null || typeof i !== 'object') { problemas.push(`item ${n} inválido`); return; }
      const k = Object.keys(i).filter((x) => x !== 'tamanho').sort().join(',');
      if (k !== 'materialId,motivo,quantidade') problemas.push(`item ${n}: campos ${Object.keys(i).sort().join(',')}`);
      if (!Number.isInteger(i.materialId) || i.materialId <= 0) problemas.push(`item ${n}: materialId`);
      if (!Number.isInteger(i.quantidade) || i.quantidade < 1) problemas.push(`item ${n}: quantidade`);
      if (!MOTIVOS.includes(i.motivo)) problemas.push(`item ${n}: motivo`);
      if (Object.hasOwn(i, 'tamanho') && i.tamanho !== null && (typeof i.tamanho !== 'string' || i.tamanho.length < 1 || i.tamanho.length > 20)) problemas.push(`item ${n}: tamanho`);
    });
    return problemas;
  }

  const rotas = {
    [`GET ${BASE}/estado`]: () => barreira() ?? resp(200, { status: 'ok', dispositivo }),
    // Contrato do backend (token-heartbeat.routes): corpo e query vazios e estritos, validados ANTES da autenticação; só o cookie do tablet.
    [`POST ${BASE}/heartbeat`]: (c) => {
      if (c.corpo === null || typeof c.corpo !== 'object' || Array.isArray(c.corpo) || Object.keys(c.corpo).length > 0) return erro(400, 'VALIDACAO');
      return barreira() ?? resp(200, { status: 'ok' });
    },
    [`POST ${BASE}/ativar`]: (c) => {
      if (chaves(c.corpo ?? {}) !== 'codigo' || typeof c.corpo.codigo !== 'string' || c.corpo.codigo.length < 1 || c.corpo.codigo.length > 128) {
        return erro(400, 'VALIDACAO');
      }
      const estado = s.codigos.get(c.corpo.codigo);
      if (!TOKEN.test(c.corpo.codigo) || estado !== 'valido') return erro(401, 'ATIVACAO_INVALIDA');
      if (s.tablet === 'rede') return erro(403, 'REDE_NAO_AUTORIZADA');
      s.codigos.set(c.corpo.codigo, 'usado');
      if (s.tablet === 'ativo') s.reativacoes += 1;
      s.tablet = 'ativo';
      s.ativacoes += 1;
      return resp(200, { status: 'ok', dispositivo });
    },
    [`POST ${BASE}/atendimento`]: (c) => {
      const b = barreira(); if (b) return b;
      const corpo = c.corpo ?? {};
      if (chaves(corpo) !== 'tipo,valor' || !['CPF', 'MATRICULA'].includes(corpo.tipo) || typeof corpo.valor !== 'string') return erro(400, 'VALIDACAO');
      s.identificacoes = s.identificacoes.filter((x) => x > s.agora - 60000);
      s.identificacoes.push(s.agora);
      if (s.identificacoes.length > 10) return erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } });
      let alvo = null;
      if (corpo.tipo === 'CPF') {
        if (/[^\d]/.test(corpo.valor)) s.violacoes.push('CPF enviado com pontuação ou letras');
        const d = soDigitos(corpo.valor.replace(/[.\-\s]/g, ''));
        if (d.length !== 11) return erro(400, 'VALIDACAO', { detalhes: [{ campo: 'body.valor', codigo: 'CPF_INVALIDO' }] });
        alvo = s.funcionarios.find((f) => f.ativo && f.cpf === d);
      } else {
        const v = corpo.valor.trim();
        if (v.length < 1 || v.length > 30) return erro(400, 'VALIDACAO', { detalhes: [{ campo: 'body.valor', codigo: 'MATRICULA_INVALIDA' }] });
        alvo = s.funcionarios.find((f) => f.ativo && f.matricula === v);
      }
      if (!alvo) return erro(404, 'FUNCIONARIO_NAO_IDENTIFICADO');
      const aberto = vigente(); if (aberto) aberto.encerrado = 'SUBSTITUIDO';
      const a = { id: s.atendimentos.length + 1, funcionarioId: alvo.id, expira: s.agora + 60000, encerrado: null };
      s.atendimentos.push(a);
      s.cookie = { atendimentoId: a.id, ate: s.agora + 60000 };
      return resp(201, { status: 'ok', atendimento: { funcionario: { primeiroNome: primeiroNome(alvo) }, expiraEm: iso(a.expira), inatividadeSegundos: 60 } });
    },
    [`GET ${BASE}/atendimento`]: () => {
      const b = barreira(); if (b) return b;
      const { a, negado } = exigirAtendimento(); if (negado) return negado;
      return resp(200, { status: 'ok', atendimento: resumo(a, Math.floor((a.expira - s.agora) / 1000)) });
    },
    [`POST ${BASE}/atendimento/atividade`]: () => {
      const b = barreira(); if (b) return b;
      const { a, negado } = exigirAtendimento(); if (negado) return negado;
      const forcado = s.restantePara.shift();
      const segundos = forcado ?? 60;
      a.expira = s.agora + segundos * 1000;
      s.cookie = { atendimentoId: a.id, ate: a.expira };
      s.atividades += 1;
      return resp(200, { status: 'ok', atendimento: resumo(a, segundos) });
    },
    [`POST ${BASE}/atendimento/encerrar`]: () => {
      const b = barreira(); if (b) return b;
      const { a, negado } = exigirAtendimento(); if (negado) return negado;
      a.encerrado = 'SAIDA';
      return resp(200, { status: 'ok' });
    },
    [`GET ${BASE}/atendimento/solicitacoes`]: () => {
      const b = barreira(); if (b) return b;
      const { negado } = exigirAtendimento(); if (negado) return negado;
      const itens = s.solicitacoes.map((i) => ({ retiradaParcial: false, ...i }))
        .sort((x, y) => SITUACOES_ABERTAS.indexOf(x.situacao) - SITUACOES_ABERTAS.indexOf(y.situacao));
      return resp(200, { status: 'ok', temDisponiveis: itens.some((i) => i.situacao === 'DISPONIVEL_PARA_RETIRADA'), itens });
    },
    [`GET ${BASE}/atendimento/catalogo`]: () => {
      const b = barreira(); if (b) return b;
      const { negado } = exigirAtendimento(); if (negado) return negado;
      const materiais = s.estadoCatalogo === 'OK' ? s.materiais : [];
      return resp(200, { status: 'ok', catalogo: { estado: s.estadoCatalogo, total: materiais.length, materiais } });
    },
    [`POST ${BASE}/atendimento/pedido`]: (c) => {
      const b = barreira(); if (b) return b;
      const problemas = validarPedido(c.corpo);
      if (problemas.length > 0) { s.violacoes.push(`corpo do pedido: ${problemas.join('; ')}`); return erro(400, 'VALIDACAO'); }
      const hash = JSON.stringify([c.corpo.itens.map((i) => [i.materialId, i.tamanho ?? null, i.quantidade, i.motivo]).sort()]);
      const existente = s.pedidos.get(c.corpo.chaveIdempotencia);
      if (existente) {
        if (!cookieVale()) return erro(401, 'ATENDIMENTO_INVALIDO');
        if (existente.hash !== hash || existente.atendimentoId !== s.cookie.atendimentoId) return erro(409, 'IDEMPOTENCIA_CONFLITO');
        return resp(200, { status: 'ok', repetida: true, pedido: existente.visao });
      }
      const { a, negado } = exigirAtendimento(); if (negado) return negado;
      for (const [indice, i] of c.corpo.itens.entries()) {
        const m = s.materiais.find((x) => x.id === i.materialId);
        const tamanho = i.tamanho ?? null;
        if (!m || s.estadoCatalogo !== 'OK' || (m.exigeTamanho && !m.tamanhos.includes(tamanho)) || (!m.exigeTamanho && tamanho !== null)) {
          return erro(409, 'ITEM_NAO_AUTORIZADO', { detalhes: [{ campo: `body.itens[${indice}].materialId`, codigo: 'ITEM_NAO_AUTORIZADO' }] });
        }
        if (s.solicitacoes.some((x) => x.materialId === i.materialId && (x.tamanho ?? null) === tamanho)) {
          return erro(409, 'ITEM_JA_SOLICITADO', { detalhes: [{ campo: `body.itens[${indice}].materialId`, codigo: 'ITEM_JA_SOLICITADO' }] });
        }
      }
      s.seq += 1;
      const visao = { numero: `PED-${s.seq}`, status: 'PENDENTE', quantidadeItens: c.corpo.itens.length, itens: c.corpo.itens.map((i) => ({ materialId: i.materialId, tamanho: i.tamanho ?? null, quantidade: i.quantidade, motivo: i.motivo })) };
      s.pedidos.set(c.corpo.chaveIdempotencia, { hash, atendimentoId: a.id, visao, itens: c.corpo.itens });
      a.encerrado = 'PEDIDO_ENVIADO';
      return resp(201, { status: 'ok', repetida: false, pedido: visao });
    },
  };

  const PEDIDO_RESULTADO = new RegExp(`^GET ${BASE}/atendimento/pedidos/([^/?]+)$`);

  async function tratar(c) {
    s.ordem += 1;
    const registro = { chave: c.chave, corpo: c.corpo, url: c.url, cabecalhos: c.cabecalhos, em: s.agora, credentials: c.credentials, ordem: s.ordem };
    (c.chave === `POST ${BASE}/heartbeat` ? s.batidas : s.chamadas).push(registro);
    if (c.credentials !== 'include') s.violacoes.push(`sem credentials: include (${c.chave})`);
    for (const k of Object.keys(c.cabecalhos ?? {})) {
      if (!['content-type', 'accept'].includes(k.toLowerCase())) s.violacoes.push(`cabeçalho não permitido ${k} (${c.chave})`);
    }
    if (c.corpoBruto !== null && !/^application\/json/i.test(valorCab(c.cabecalhos, 'content-type') ?? '')) s.violacoes.push(`corpo sem Content-Type JSON (${c.chave})`);
    if (c.temQuery) s.violacoes.push(`query string não permitida (${c.chave})`);

    const rotaChave = c.chave.replace(PEDIDO_RESULTADO, `GET ${BASE}/atendimento/pedidos/:chave`);
    // maxEmVoo mede a concorrência DA PRÓPRIA rota (antes somava requisições de rotas diferentes e acusava falso excesso).
    s.maxEmVoo[rotaChave] = s.maxEmVoo[rotaChave] ?? 0;
    s.emVooPorRota[rotaChave] = (s.emVooPorRota[rotaChave] ?? 0) + 1;
    s.emVoo += 1;
    s.maxEmVoo[rotaChave] = Math.max(s.maxEmVoo[rotaChave], s.emVooPorRota[rotaChave]);
    try {
      const f = s.falhas.find((x) => x.chave === rotaChave && x.restantes > 0);
      let perdida = false;
      if (f) {
        f.restantes -= 1;
        if (f.modo === 'rede') throw new Error('falha de rede simulada');
        if (f.modo === 'pendente') return await new Promise(() => {});
        if (f.modo === 'segurar') await new Promise((resolver) => { s.segurados.push(resolver); });
        if (f.modo === '429') return erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': String(f.retryAfter ?? 5) } });
        if (f.modo === 'status') {
          // `segurar`: a resposta já está decidida na chegada (o status da falha); só a entrega espera `liberarSegurados`.
          if (f.segurar) await new Promise((resolver) => { s.segurados.push(resolver); });
          if (f.bruto !== undefined) return resp(f.status, undefined, {}, f.bruto); // corpo que não é JSON
          return f.corpo !== undefined ? resp(f.status, f.corpo) : erro(f.status, f.codigo ?? 'ERRO');
        }
        if (f.modo === 'perdida') perdida = true;
      }
      let r;
      const m = PEDIDO_RESULTADO.exec(c.chave);
      if (m) {
        const b = barreira();
        if (b) r = b;
        else if (!cookieVale()) r = erro(401, 'ATENDIMENTO_INVALIDO');
        else {
          const p = s.pedidos.get(m[1]);
          if (p && p.atendimentoId === s.cookie.atendimentoId) r = resp(200, { status: 'ok', pedido: { estado: 'REGISTRADO', numero: p.visao.numero, status: p.visao.status, quantidadeItens: p.visao.quantidadeItens } });
          else if (s.processando === m[1]) r = resp(202, { status: 'ok', pedido: { estado: 'EM_PROCESSAMENTO' } });
          else r = erro(404, 'PEDIDO_NAO_ENCONTRADO');
        }
      } else if (Object.hasOwn(rotas, c.chave)) {
        r = rotas[c.chave](c);
      } else {
        r = erro(404, 'ROTA_NAO_ENCONTRADA');
        s.violacoes.push(`rota inexistente chamada: ${c.chave}`);
      }
      if (perdida) throw new Error('resposta perdida (efeito aplicado no servidor)');
      if (c.chave === `POST ${BASE}/atendimento/pedido` && r.status >= 200 && r.status < 300) s.cookie = null;
      return r;
    } finally {
      s.emVoo -= 1;
      s.emVooPorRota[rotaChave] -= 1;
    }
  }

  s.rotas = new Proxy({}, { get: (_, chave) => (typeof chave === 'string' ? (chamada) => tratar(chamada) : undefined), has: () => true });
  return s;
}

// ───────────────────────── abertura da página e utilidades de interação ─────────────────────────

function lerTotem(rel) {
  const arquivo = path.join(RAIZ, rel);
  if (!fs.existsSync(arquivo)) assert.fail(`RED I: ${rel} ainda não existe (funcionalidade futura da Etapa I)`);
  return fs.readFileSync(arquivo, 'utf8');
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', check: '✓', ccedil: 'ç', atilde: 'ã', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ecirc: 'ê', ocirc: 'ô', acirc: 'â' };
/** Decodifica entidades HTML (nomeadas comuns e numéricas) para comparar texto como o navegador o apresenta. */
const decodificar = (texto) => texto.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return Object.hasOwn(ENTIDADES, e) ? ENTIDADES[e] : m;
});

/**
 * Arquivos locais do Totem referenciados por index.html (scripts com src e folhas de estilo), relativos a frontend/, só os que
 * ficam sob totem/. A organização dos arquivos é livre (P5): o teste segue as referências da página, não uma lista fixa.
 */
function arquivosLocaisDoTotem() {
  const html = lerTotem(ARQUIVOS.html).replace(/<!--[\s\S]*?-->/g, '');
  const refs = [
    ...[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)].map((m) => m[1]),
  ];
  return [...new Set(refs.filter((r) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r)).map((r) => path.posix.normalize(path.posix.join('totem', r.split(/[?#]/)[0]))))]
    .filter((r) => r.startsWith('totem/'));
}

/** Script local executado primeiro no <head> (o de inicialização, que remove o fragmento da URL). */
function primeiroScriptDoHead() {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(lerTotem(ARQUIVOS.html).replace(/<!--[\s\S]*?-->/g, ''))?.[1] ?? '';
  const src = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/i.exec(head)?.[1] ?? null;
  return src === null ? null : path.posix.normalize(path.posix.join('totem', src.split(/[?#]/)[0]));
}

function corpus() {
  const html = lerTotem(ARQUIVOS.html);
  const locais = arquivosLocaisDoTotem();
  const primeiro = primeiroScriptDoHead();
  const lerLocal = (rel) => (fs.existsSync(path.join(RAIZ, rel)) ? fs.readFileSync(path.join(RAIZ, rel), 'utf8') : assert.fail(`${ARQUIVOS.html} referencia ${rel}, que não existe`));
  const scripts = locais.filter((r) => r.endsWith('.js'));
  const folhas = locais.filter((r) => r.endsWith('.css'));
  const boot = primeiro === null ? '' : lerLocal(primeiro);
  const js = scripts.filter((r) => r !== primeiro).map(lerLocal).join('\n');
  const css = folhas.map(lerLocal).join('\n');
  const partes = [html, boot, js, css];
  return {
    html, boot, js, css, locais, primeiro,
    tudo: partes.join('\n'),
    semComentarios: [html.replace(/<!--[\s\S]*?-->/g, ''), semComentarios(boot), semComentarios(js)].join('\n'),
    textoDoHtml: decodificar(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
  };
}

function textoRenderizado(p, no) {
  if (no.nodeType === 3) return no.textContent;
  if (no.nodeType !== 1 || ['script', 'style', 'head', 'meta', 'link', 'title'].includes(no.localName)) return '';
  if (!p.visivelNo(no)) return '';
  return no.filhos.map((f) => textoRenderizado(p, f)).join(' ');
}

function montar(p, servidor) {
  const t = { ...p, servidor, relogio: p.janela.__relogio };
  const botoes = () => p.consulta('button').filter(p.visivelNo);
  t.telaAtual = () => p.consulta('.tela').filter(p.visivelNo).map((e) => e.id);
  t.textoVisivel = () => textoRenderizado(p, p.documento.body).replace(/\s+/g, ' ').trim();
  t.botao = (texto) => botoes().find((b) => b.textContent.includes(texto)) ?? null;
  t.botoesVisiveis = () => botoes().map((b) => b.textContent.replace(/\s+/g, ' ').trim());
  t.clicarEl = async (el) => { await el.disparar('click'); await p.esperar(); };
  t.clicarTexto = async (texto) => {
    const b = t.botao(texto);
    assert.ok(b, `botão com o texto "${texto}" não encontrado entre os visíveis: ${JSON.stringify(t.botoesVisiveis())}`);
    await t.clicarEl(b);
  };
  t.passar = async (ms, passo = 1000) => {
    let resto = ms;
    while (resto > 0) {
      const d = Math.min(passo, resto);
      servidor.avancar(d);
      t.relogio.avancar(d);
      await p.esperar();
      resto -= d;
    }
  };
  t.digitar = async (texto) => {
    if (/^\d+$/.test(texto)) {
      for (const d of texto) {
        const tecla = p.consulta('#teclado .tecla').find((b) => b.textContent.trim() === d);
        assert.ok(tecla, `tecla "${d}" do teclado numérico não encontrada`);
        await t.clicarEl(tecla);
      }
    } else {
      await p.digitar('doc', texto);
      await p.esperar();
    }
  };
  t.escolherTipo = async (tipo) => { await t.clicarEl(p.el(tipo === 'CPF' ? 'tipoCpf' : 'tipoMatricula')); };
  t.identificar = async ({ tipo, valor }) => { await t.escolherTipo(tipo); await t.digitar(valor); await t.clicarTexto('Continuar'); await p.esperar(); };
  t.produtos = () => p.consulta('#grade .prod-nome').map((e) => e.textContent.trim());
  t.abrirProduto = async (nome) => {
    const card = p.consulta('#grade .prod').find((e) => e.querySelector('.prod-nome')?.textContent.trim() === nome);
    assert.ok(card, `produto "${nome}" não encontrado: ${JSON.stringify(t.produtos())}`);
    await t.clicarEl(card);
  };
  t.tamanhos = () => p.consulta('#tams .tam').map((e) => (e.querySelector('b')?.textContent ?? e.textContent).trim());
  t.escolherTamanho = async (rotulo) => {
    const b = p.consulta('#tams .tam').find((e) => (e.querySelector('b')?.textContent ?? e.textContent).trim() === rotulo);
    assert.ok(b, `tamanho "${rotulo}" não encontrado: ${JSON.stringify(t.tamanhos())}`);
    await t.clicarEl(b);
  };
  t.adicionar = async () => { await t.clicarEl(p.el('btnSolicitar')); };
  t.adicionarItem = async (nome, tamanho = null) => {
    await t.abrirProduto(nome);
    if (tamanho !== null) await t.escolherTamanho(tamanho);
    await t.adicionar();
  };
  t.itensDaRevisao = () => p.consulta('#telaRevisao [data-item]');
  t.escolherMotivo = async (indice, motivo) => {
    const linha = p.consulta(`#telaRevisao [data-item="${indice}"]`)[0];
    assert.ok(linha, `linha ${indice} da revisão não encontrada`);
    const b = linha.querySelectorAll('button').find((x) => x.getAttribute('data-motivo') === motivo);
    assert.ok(b, `botão do motivo ${motivo} não encontrado na linha ${indice}`);
    await t.clicarEl(b);
  };
  t.motivoParaTodos = async (motivo) => { const n = t.itensDaRevisao().length; for (let i = 0; i < n; i += 1) await t.escolherMotivo(i, motivo); };
  t.enviar = async () => { await t.clicarTexto(TEXTOS.enviar); };
  t.pedidosPost = () => servidor.chamadasDe(`POST ${BASE}/atendimento/pedido`);
  t.chaveDoPedido = () => t.pedidosPost()[0]?.corpo?.chaveIdempotencia ?? null;
  t.segundosNoContador = () => { const m = /(\d+)\s*s/.exec(p.el('tempo').textContent); return m ? Number(m[1]) : null; };
  /** Depois da identificação, passa pelo aviso de pedidos existentes (se houver) e chega ao catálogo. */
  t.irAoCatalogo = async () => { if (t.telaAtual().includes('telaAviso')) await t.clicarTexto(TEXTOS.avisoOk); };
  t.irARevisao = async (itens = [['Botina de Segurança', '40'], ['Protetor Auricular', null]]) => {
    for (const [nome, tamanho] of itens) await t.adicionarItem(nome, tamanho);
    await t.clicarTexto(TEXTOS.revisar);
  };
  return t;
}

/** Abre a página do Totem (RED enquanto não existir) com o relógio virtual e o servidor falso. */
async function abrirTotem({ servidor = criarServidor(), hash = '', transformar = null } = {}) {
  let html;
  const diag = process.env.TOTEM_I_DIAGNOSTICO_HTML;
  if (diag) html = fs.readFileSync(diag, 'utf8');
  else {
    assert.ok(existePagina(ARQUIVOS.html), `RED I: a página derivada ${ARQUIVOS.html} ainda não existe (funcionalidade futura da Etapa I)`);
    html = lerTotem(ARQUIVOS.html);
  }
  const pagina = abrirPagina(ARQUIVOS.html, { rotas: servidor.rotas, hash, html: injetarShim(html), transformar });
  const t = montar(pagina, servidor);
  await pagina.esperar();
  return t;
}

/** Abre um HTML qualquer (controle do próprio helper), sem exigir a página derivada. */
async function abrirHtmlDeControle(html, { servidor = criarServidor(), hash = '', arquivos = {} } = {}) {
  const pagina = abrirPagina(ARQUIVOS.html, { rotas: servidor.rotas, hash, html: injetarShim(html), arquivos });
  const t = montar(pagina, servidor);
  await pagina.esperar();
  return t;
}

/** Abre a página, identifica o funcionário e devolve o estado já dentro do atendimento. */
async function abrirIdentificado({ servidor = criarServidor(), funcionario = FUNCIONARIOS[0], tipo = 'CPF' } = {}) {
  const t = await abrirTotem({ servidor });
  await t.identificar({ tipo, valor: tipo === 'CPF' ? funcionario.cpf : funcionario.matricula });
  return t;
}

/** Identifica o funcionário e deixa a página no catálogo (passando pelo aviso da G, se houver). */
async function abrirNoCatalogo(opcoes = {}) {
  const t = await abrirIdentificado(opcoes);
  await t.irAoCatalogo();
  return t;
}

/** Leva o fluxo até a revisão com itens e motivos escolhidos, pronto para "Enviar pedido". */
async function abrirPronto(opcoes = {}, itens, motivo = 'DESGASTE_DANO') {
  const t = await abrirNoCatalogo(opcoes);
  await t.irARevisao(itens);
  await t.motivoParaTodos(motivo);
  return t;
}

/** Onde os segredos de um teste não podem aparecer. */
function vazamentos(t, segredos) {
  const locais = {
    storage: JSON.stringify(t.storage),
    console: JSON.stringify(t.consoleChamadas),
    historico: JSON.stringify(t.historico),
    navegacoes: JSON.stringify(t.navegacoes),
    cookiesEscritos: JSON.stringify(t.cookiesEscritos),
    dom: t.textoDoDom(),
  };
  const achados = [];
  for (const [nome, valor] of Object.entries(segredos)) {
    if (!valor) continue;
    for (const [local, conteudo] of Object.entries(locais)) if (conteudo.includes(valor)) achados.push(`${nome} em ${local}`);
  }
  return achados;
}

const novoToken = () => require('node:crypto').randomBytes(32).toString('base64url');

/** Objetos vindos do contexto da página são de outra realm: normaliza antes de comparar com deepEqual. */
const plano = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

module.exports = {
  plano,
  ARQUIVOS, BASE, SENTINELA, UUID, TOKEN, MOTIVOS, SITUACOES_ABERTAS, TEXTOS, PROIBIDOS, FUNCIONARIOS, CATALOGO, IMAGEM_AUSENTE,
  criarServidor, abrirTotem, abrirHtmlDeControle, abrirIdentificado, abrirNoCatalogo, abrirPronto, injetarShim, lerTotem, corpus, arquivosLocaisDoTotem, primeiroScriptDoHead, decodificar, vazamentos, novoToken, textoRenderizado, SHIM, BASE_TEMPO,
};
