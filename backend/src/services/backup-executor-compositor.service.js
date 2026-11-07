'use strict';

const { criarExecutorOperacional } = require('./backup-executor-operacional.service');
const { adquirirExclusao } = require('./backup-fontes-coordenacao-operacoes.service');
const Pol = require('./backup-executor-politica.service');

/**
 * D-ORF-6, L2 (Bloco C): COMPOSITOR LOCAL DO EXECUTOR — a peça que faltava entre a ligação (Bloco A: portas AWS por papel, KMS, auditoria), os adaptadores L2 (Bloco B: produção e
 * restaurador) e o compositor operacional (`criarExecutorOperacional`), do qual é o ÚNICO chamador. Produz o objeto que o CLI espera em `portas.compor` (`compor(pedido) -> { executar() }`),
 * mas NÃO é ligado ao CLI nesta etapa: `scripts/backup-operar.js` continua sem ligação e devolve `LIGACAO_OPERACIONAL_AUSENTE`; a injeção depende das decisões H9 (credenciais, destinos, chaves).
 * Nada aqui lê ambiente, arquivo ou rede, cria processo ou decide política: os portões continuam na política (`OPERACAO_HABILITADA` permanece falsa) e no executor operacional.
 *
 * `criarCompositor(opcoes)`; chaves por ação:
 *  - sempre: `ligacao` (de `criarLigacaoDoExecutor`: { acao, modo, portas, kms, finalizar }), `coordenacao` ({ adquirir }), `evidencia` e `recibos` ({ registrar }), `trabalho`, `fatos`, `relogio`;
 *    opcionais: `gerarId`, `registro` (só em teste; repassado ao executor);
 *  - BACKUP: `producao` ({ produzir }), `chaves` ({ cifra, mac }), `destinoLocal` ({ validador, destinoLocalId, raiz }), `protegidos`, `limites`, `prazoMs`; `trabalho` = { conjuntoId, nomeContainer };
 *  - RESTAURACAO: `restaurador` ({ restaurar }), `chaves`, `destinoLocal`, `protegidos`, `limites`, `prazoMs`; `trabalho` = { consolidado, nomeContainer, nomeDecifrado, alvos?, ultimoBackupEm? };
 *  - VERIFICACAO_DESTINO: `trabalho` = { consolidado }.
 * `compor({ modo, acao, ambiente, destino, confirmacao })` exige modo e ação IGUAIS aos da ligação (uma ligação serve a uma única ação) e devolve `{ acao, modo, ambiente, destino, executar() }`.
 * `executar()` roda a ação no executor operacional (portões, coordenação, estágio, evidência sempre registrada), depois entrega a linha de evidência a `ligacao.finalizar` (auditoria D-F13) e
 * devolve o resultado do executor acrescido de `auditoria: { gravado, codigo? }`. A auditoria nunca altera o desfecho nem lança.
 *
 * `criarCoordenacaoDoExecutor({ executorDeBanco })` -> `{ adquirir({ operacao }) }`: adapta os advisory locks do P10 (`adquirirExclusao`, executor por parâmetro) à porta `coordenacao` do executor;
 * nunca lança (falha de consulta vira `{ ok: false, motivo: 'CONSULTA_FALHOU' }`, que o executor trata como FALHOU/COORDENACAO_INDISPONIVEL).
 */

const OPCOES = Object.freeze(['ligacao', 'producao', 'restaurador', 'chaves', 'coordenacao', 'evidencia', 'recibos', 'destinoLocal', 'protegidos', 'limites', 'prazoMs', 'trabalho', 'fatos', 'relogio', 'gerarId', 'registro']);
const SEMPRE = Object.freeze(['ligacao', 'coordenacao', 'evidencia', 'recibos', 'trabalho', 'fatos', 'relogio']);
const POR_ACAO = Object.freeze({
  BACKUP: Object.freeze({ opcoes: ['producao', 'chaves', 'destinoLocal', 'protegidos', 'limites', 'prazoMs'], trabalho: ['conjuntoId', 'nomeContainer'], opcionais: [] }),
  RESTAURACAO: Object.freeze({ opcoes: ['restaurador', 'chaves', 'destinoLocal', 'protegidos', 'limites', 'prazoMs'], trabalho: ['consolidado', 'nomeContainer', 'nomeDecifrado'], opcionais: ['alvos', 'ultimoBackupEm'] }),
  VERIFICACAO_DESTINO: Object.freeze({ opcoes: [], trabalho: ['consolidado'], opcionais: [] }),
});
const PORTAS_DA_LIGACAO = Object.freeze({ BACKUP: Object.freeze(['publicador', 'verificador']), RESTAURACAO: Object.freeze(['restauracao']), VERIFICACAO_DESTINO: Object.freeze(['verificador']) });
const PEDIDO = Object.freeze(['modo', 'acao', 'ambiente', 'destino', 'confirmacao']);
const MOTIVO = /^[A-Z0-9_]{1,64}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const comFuncoes = (o, nomes) => ehObjeto(o) && nomes.every((n) => typeof o[n] === 'function');
const chavesExatas = (o, obrigatorias, opcionais = []) => ehObjeto(o) && Reflect.ownKeys(o).every((k) => obrigatorias.includes(k) || opcionais.includes(k)) && obrigatorias.every((k) => Object.hasOwn(o, k));
const erro = (code, mensagem) => Object.assign(new TypeError(mensagem), { code });
const configuracaoInvalida = () => erro('COMPOSITOR_CONFIGURACAO_INVALIDA', 'configuração do compositor inválida');
const fixo = (m) => (typeof m === 'string' && MOTIVO.test(m) ? m : 'INDETERMINADO');

function validarLigacao(ligacao) {
  if (!ehObjeto(ligacao) || !Pol.ACOES.includes(ligacao.acao) || !Pol.MODOS.includes(ligacao.modo) || typeof ligacao.finalizar !== 'function' || !ehObjeto(ligacao.portas)) throw configuracaoInvalida();
  const permitidas = PORTAS_DA_LIGACAO[ligacao.acao];
  const presentes = Reflect.ownKeys(ligacao.portas);
  if (!presentes.every((k) => permitidas.includes(k)) || !presentes.includes(permitidas[0]) || !presentes.every((k) => ehObjeto(ligacao.portas[k]))) throw configuracaoInvalida();
  if (ligacao.acao === 'VERIFICACAO_DESTINO' ? ligacao.kms !== null : !ehObjeto(ligacao.kms)) throw configuracaoInvalida();
  if (ligacao.acao === 'BACKUP' && presentes.includes('verificador') && ligacao.modo !== 'ENSAIO') throw configuracaoInvalida();
}

function criarCompositor(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !SEMPRE.every((k) => Object.hasOwn(opcoes, k))) throw configuracaoInvalida();
  const { ligacao, coordenacao, evidencia, recibos, trabalho, fatos, relogio, gerarId, registro } = opcoes;
  validarLigacao(ligacao);
  const { acao, modo } = ligacao;
  const regra = POR_ACAO[acao];
  const informadas = Reflect.ownKeys(opcoes).filter((k) => !SEMPRE.includes(k) && k !== 'gerarId' && k !== 'registro');
  if (!regra.opcoes.every((k) => informadas.includes(k)) || !informadas.every((k) => regra.opcoes.includes(k))) throw configuracaoInvalida();
  if (!comFuncoes(coordenacao, ['adquirir']) || !comFuncoes(evidencia, ['registrar']) || !comFuncoes(recibos, ['registrar']) || typeof relogio !== 'function' || !ehObjeto(fatos)) throw configuracaoInvalida();
  if ((gerarId !== undefined && typeof gerarId !== 'function') || !chavesExatas(trabalho, regra.trabalho, regra.opcionais)) throw configuracaoInvalida();
  if (acao === 'BACKUP' && !comFuncoes(opcoes.producao, ['produzir'])) throw configuracaoInvalida();
  if (acao === 'RESTAURACAO' && !comFuncoes(opcoes.restaurador, ['restaurar'])) throw configuracaoInvalida();
  if (acao !== 'VERIFICACAO_DESTINO') {
    if (!ehObjeto(opcoes.chaves) || !ehObjeto(opcoes.chaves.cifra) || !ehObjeto(opcoes.chaves.mac)) throw configuracaoInvalida();
    if (!chavesExatas(opcoes.destinoLocal, ['validador', 'destinoLocalId', 'raiz']) || !comFuncoes(opcoes.destinoLocal.validador, ['validar'])) throw configuracaoInvalida();
    if (!ehObjeto(opcoes.protegidos) || !ehObjeto(opcoes.limites) || !Number.isSafeInteger(opcoes.prazoMs)) throw configuracaoInvalida();
  }

  function pedidoDoExecutor() {
    if (acao === 'VERIFICACAO_DESTINO') return { consolidado: trabalho.consolidado, portas: { verificador: ligacao.portas.verificador } };
    const { destinoLocal, protegidos, limites, prazoMs, chaves } = opcoes;
    const base = { destinoLocal: { validador: destinoLocal.validador, destinoLocalId: destinoLocal.destinoLocalId, raiz: destinoLocal.raiz, nomeContainer: trabalho.nomeContainer }, protegidos: { ...protegidos }, limites: { ...limites }, prazoMs };
    if (acao === 'BACKUP') {
      const portas = { producao: opcoes.producao, publicador: ligacao.portas.publicador, chaves };
      if (ligacao.portas.verificador !== undefined) portas.verificador = ligacao.portas.verificador;
      return { conjuntoId: trabalho.conjuntoId, ...base, portas };
    }
    base.destinoLocal.nomeDecifrado = trabalho.nomeDecifrado;
    const extras = trabalho.alvos === undefined ? {} : { alvos: trabalho.alvos, ultimoBackupEm: trabalho.ultimoBackupEm };
    return { consolidado: trabalho.consolidado, ...base, portas: { restauracao: ligacao.portas.restauracao, restaurador: opcoes.restaurador, chaves }, ...extras };
  }

  function compor(pedido) {
    if (!chavesExatas(pedido, PEDIDO)) throw erro('COMPOSITOR_PEDIDO_INVALIDO', 'pedido do compositor inválido');
    if (pedido.modo !== modo || pedido.acao !== acao) throw erro('COMPOSITOR_PEDIDO_INCOERENTE', 'pedido incoerente com a ligação');
    const { ambiente, destino, confirmacao } = pedido;
    if (!Pol.AMBIENTES.includes(ambiente) || typeof destino !== 'string' || (confirmacao !== null && typeof confirmacao !== 'string')) throw erro('COMPOSITOR_PEDIDO_INVALIDO', 'pedido do compositor inválido');
    let executor;
    try {
      executor = criarExecutorOperacional({ modo, ambiente, destinoDuravelId: destino, confirmacao, fatos: { ...fatos }, relogio, coordenacao, evidencia, recibos, ...(gerarId === undefined ? {} : { gerarId }), ...(registro === undefined ? {} : { registro }) });
    } catch { throw erro('COMPOSITOR_PEDIDO_INVALIDO', 'pedido do compositor inválido'); }

    async function executar() {
      const entrada = pedidoDoExecutor();
      const resultado = acao === 'BACKUP' ? await executor.executarBackup(entrada) : acao === 'RESTAURACAO' ? await executor.executarRestauracao(entrada) : await executor.verificarDestino(entrada);
      let auditoria;
      try {
        const a = await ligacao.finalizar({ linha: resultado.linha });
        auditoria = ehObjeto(a) && a.gravado === true ? { gravado: true } : { gravado: false, codigo: fixo(ehObjeto(a) ? a.codigo : undefined) };
      } catch { auditoria = { gravado: false, codigo: 'AUDITORIA_FALHOU' }; }
      return Object.freeze({ ...resultado, auditoria: Object.freeze(auditoria) });
    }

    return Object.freeze({ acao, modo, ambiente, destino, executar });
  }

  return Object.freeze({ acao, modo, compor });
}

function criarCoordenacaoDoExecutor(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['executorDeBanco']) || !comFuncoes(opcoes.executorDeBanco, ['query'])) throw configuracaoInvalida();
  const { executorDeBanco } = opcoes;
  async function adquirir(pedido) {
    if (!chavesExatas(pedido, ['operacao']) || (pedido.operacao !== 'BACKUP' && pedido.operacao !== 'RESTAURACAO')) return Object.freeze({ ok: false, motivo: 'CONSULTA_FALHOU' });
    try { return await adquirirExclusao(executorDeBanco, { operacao: pedido.operacao }); } catch { return Object.freeze({ ok: false, motivo: 'CONSULTA_FALHOU' }); }
  }
  return Object.freeze({ adquirir });
}

module.exports = { criarCompositor, criarCoordenacaoDoExecutor };
