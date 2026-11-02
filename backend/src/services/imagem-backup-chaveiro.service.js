'use strict';

const { ehFonteDeChaves, restringirFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): CHAVEIRO — política de uso, histórico e rotação das chaves do manifesto V2 sobre uma FONTE DE CHAVES já produzida pela fábrica aprovada (o segredo nunca passa por aqui: o chaveiro só decide QUAL id pode ser usado e PARA QUÊ,
 * e entrega fontes DERIVADAS, mais restritas, da mesma origem). Nada de rede, disco, ambiente, relógio ou processo; sem log; nenhum objeto do chaveiro contém segredo (serialização = origem, ambiente, ids e estados).
 *
 * ORIGEM: herdada da fonte. O chamador não declara OPERACIONAL: ela só existe para um provedor aprovado em `PROVEDORES_OPERACIONAIS_APROVADOS` (lista vazia, decisão do responsável). Este módulo NÃO escolhe, ativa nem configura provedor algum.
 *
 * ESTADOS (o chaveiro é a verdade sobre o USO; o provedor é a verdade sobre a EXISTÊNCIA do segredo; as duas precisam concordar): ATIVA (única; assina e verifica), APOSENTADA (só verifica e restaura pacotes antigos), REVOGADA (nunca válida, mesmo que o provedor ainda a guarde; irreversível).
 * Um id fora do histórico é NAO_CADASTRADA e nunca é aceito, mesmo que o provedor o responda ATIVA. SEPARAÇÃO DE AMBIENTES: todo id carrega o prefixo do ambiente (`hml-` ou `prd-`); uma chave de homologação não existe no chaveiro de produção e vice-versa.
 *
 * ROTAÇÃO (`planejarRotacao`, pura, devolve um NOVO chaveiro): a nova chave tem de existir e estar ATIVA no provedor; a atual vira APOSENTADA (não é revogada: pacotes antigos continuam verificáveis e restauráveis, só por `VERIFICAR`); todo id de pacote existente (`idsEmUso`) tem de estar no histórico
 * e, se não estiver REVOGADA, ainda responder ATIVA no provedor (senão a rotação deixaria backups irrecuperáveis por acidente: recusa antes de efeito algum). REVOGAÇÃO (`revogar`): a chave ativa não se revoga (rotacione antes); revogar uma aposentada devolve o novo chaveiro e a LISTA dos pacotes que deixam de ser verificáveis.
 */

const AMBIENTES = Object.freeze({ HOMOLOGACAO: 'hml-', PRODUCAO: 'prd-' });
const ESTADOS = Object.freeze({ ATIVA: 'ATIVA', APOSENTADA: 'APOSENTADA', REVOGADA: 'REVOGADA' });
const USOS = Object.freeze({ ASSINAR: 'ASSINAR', VERIFICAR: 'VERIFICAR' });
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const chaveirosProduzidos = new WeakSet();

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

function erro(codigo, extra = {}) {
  const falha = new Error('chaveiro de backup');
  falha.code = codigo;
  Object.assign(falha, extra);
  return falha;
}
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do chaveiro inválida'), { code: 'CONFIGURACAO_INVALIDA' });

/** O provedor responde ATIVA para o id? (o segredo é descartado na hora e nunca sai daqui) */
function provedorTemAtiva(fonte, chaveId) {
  let r;
  try { r = fonte.obter(chaveId); } catch { return false; }
  if (!ehObjeto(r)) return false;
  if (r.segredo instanceof Uint8Array) r.segredo.fill(0);
  return r.situacao === 'ATIVA';
}

function construir(ambiente, fonte, historico) {
  const prefixo = AMBIENTES[ambiente];
  const mapa = new Map(historico.map((h) => [h.id, h.estado]));
  const ativa = historico.find((h) => h.estado === ESTADOS.ATIVA).id;

  let derivadaDeAssinar = null;
  let derivadaDeVerificar = null;
  const estadoDe = (id) => (typeof id === 'string' && mapa.has(id) ? mapa.get(id) : null);
  const decisaoParaAssinar = (id) => { const e = estadoDe(id); return e === ESTADOS.ATIVA ? 'PERMITIR' : e === ESTADOS.REVOGADA ? 'REVOGADA' : 'NEGAR'; };
  const decisaoParaVerificar = (id) => { const e = estadoDe(id); return e === ESTADOS.ATIVA || e === ESTADOS.APOSENTADA ? 'PERMITIR' : e === ESTADOS.REVOGADA ? 'REVOGADA' : 'NEGAR'; };

  /** Pode a chave ser usada para o uso pedido? Falha fechada com motivo fixo; o provedor tem de concordar. */
  function avaliar(chaveId, uso) {
    if (!Object.hasOwn(USOS, uso)) return { permitido: false, motivo: 'USO_INVALIDO' };
    const e = estadoDe(chaveId);
    if (e === null) return { permitido: false, motivo: 'NAO_CADASTRADA' };
    if (e === ESTADOS.REVOGADA) return { permitido: false, motivo: 'REVOGADA' };
    if (uso === USOS.ASSINAR && e !== ESTADOS.ATIVA) return { permitido: false, motivo: 'APOSENTADA_NAO_ASSINA' };
    if (!provedorTemAtiva(fonte, chaveId)) return { permitido: false, motivo: 'INDISPONIVEL_NO_PROVEDOR' };
    return { permitido: true, motivo: null };
  }

  function planejarRotacao(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['novaChaveId', 'idsEmUso'])) throw configuracaoInvalida();
    const { novaChaveId, idsEmUso } = pedido;
    if (typeof novaChaveId !== 'string' || !CHAVE_ID.test(novaChaveId) || !novaChaveId.startsWith(prefixo)) throw erro('ROTACAO_CHAVE_FORA_DO_AMBIENTE');
    if (mapa.has(novaChaveId)) throw erro('ROTACAO_CHAVE_JA_CONHECIDA');
    exigirIdsEmUso(idsEmUso);
    if (!provedorTemAtiva(fonte, novaChaveId)) throw erro('ROTACAO_NOVA_CHAVE_INDISPONIVEL');
    const orfas = [...new Set(idsEmUso.filter((id) => !mapa.has(id)))].sort();
    if (orfas.length > 0) throw erro('ROTACAO_ORFANARIA_PACOTES', { chaves: orfas });
    const semProvedor = [...new Set(idsEmUso.filter((id) => mapa.get(id) !== ESTADOS.REVOGADA && !provedorTemAtiva(fonte, id)))].sort();
    if (semProvedor.length > 0) throw erro('ROTACAO_CHAVE_ANTIGA_INDISPONIVEL', { chaves: semProvedor });
    const proximo = historico.map((h) => (h.estado === ESTADOS.ATIVA ? { id: h.id, estado: ESTADOS.APOSENTADA } : h));
    proximo.push({ id: novaChaveId, estado: ESTADOS.ATIVA });
    return construir(ambiente, fonte, proximo);
  }

  function revogar(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['chaveId', 'pacotes'])) throw configuracaoInvalida();
    const { chaveId, pacotes } = pedido;
    const e = estadoDe(chaveId);
    if (e === null) throw erro('REVOGACAO_CHAVE_DESCONHECIDA');
    if (e === ESTADOS.ATIVA) throw erro('REVOGACAO_DA_ATIVA_EXIGE_ROTACAO');
    if (!Array.isArray(pacotes) || pacotes.length > 100000 || !pacotes.every((p) => ehObjeto(p) && chavesExatas(p, ['pacote', 'chaveId']) && PACOTE.test(p.pacote) && CHAVE_ID.test(p.chaveId))) throw configuracaoInvalida();
    const afetados = pacotes.filter((p) => p.chaveId === chaveId).map((p) => p.pacote).sort();
    const proximo = historico.map((h) => (h.id === chaveId ? { id: h.id, estado: ESTADOS.REVOGADA } : h));
    return Object.freeze({ chaveiro: construir(ambiente, fonte, proximo), pacotesNaoVerificaveis: Object.freeze(afetados) });
  }

  const chaveiro = Object.freeze({
    ambiente,
    origem: fonte.origem,
    operacional: fonte.origem === 'OPERACIONAL',
    chaveAtivaId: () => ativa,
    historico: () => Object.freeze(historico.map((h) => Object.freeze({ ...h }))),
    avaliar,
    fonteParaAssinar: () => (derivadaDeAssinar ??= restringirFonteDeChaves(fonte, decisaoParaAssinar)),
    fonteParaVerificar: () => (derivadaDeVerificar ??= restringirFonteDeChaves(fonte, decisaoParaVerificar)),
    /** A fonte apresentada é uma das duas derivadas DESTE chaveiro? (identidade, nunca igualdade de conteúdo) */
    ehFonteDoChaveiro: (f) => f !== null && f !== undefined && (f === derivadaDeAssinar || f === derivadaDeVerificar),
    planejarRotacao,
    revogar,
    toJSON: () => ({ ambiente, origem: fonte.origem, chaveAtiva: ativa, historico: historico.map((h) => ({ ...h })) }),
  });
  chaveirosProduzidos.add(chaveiro);
  return chaveiro;
}

function exigirIdsEmUso(ids) {
  if (!Array.isArray(ids) || ids.length > 100000 || !ids.every((id) => typeof id === 'string' && CHAVE_ID.test(id))) throw configuracaoInvalida();
}

/**
 * `criarChaveiro({ ambiente, fonte, historico: [{ id, estado }] })`: exatamente UMA ATIVA, ids únicos e do ambiente, fonte produzida pela fábrica aprovada. A ATIVA tem de estar disponível no provedor (senão não há como assinar: falha fechada, sem efeito).
 */
function criarChaveiro(config) {
  if (!ehObjeto(config) || !chavesExatas(config, ['ambiente', 'fonte', 'historico'])) throw configuracaoInvalida();
  const { ambiente, fonte, historico } = config;
  if (typeof ambiente !== 'string' || !Object.hasOwn(AMBIENTES, ambiente) || !ehFonteDeChaves(fonte)) throw configuracaoInvalida();
  if (!Array.isArray(historico) || historico.length === 0 || historico.length > 1000) throw configuracaoInvalida();
  const ids = new Set();
  let ativas = 0;
  const copia = [];
  for (const h of historico) {
    if (!ehObjeto(h) || !chavesExatas(h, ['id', 'estado']) || typeof h.id !== 'string' || !CHAVE_ID.test(h.id) || !h.id.startsWith(AMBIENTES[ambiente]) || ids.has(h.id)) throw configuracaoInvalida();
    if (typeof h.estado !== 'string' || !Object.hasOwn(ESTADOS, h.estado)) throw configuracaoInvalida();
    ids.add(h.id);
    if (h.estado === ESTADOS.ATIVA) ativas += 1;
    copia.push({ id: h.id, estado: h.estado });
  }
  if (ativas !== 1) throw configuracaoInvalida();
  const ativa = copia.find((h) => h.estado === ESTADOS.ATIVA).id;
  if (!provedorTemAtiva(fonte, ativa)) throw erro('CHAVE_ATIVA_INDISPONIVEL');
  return construir(ambiente, fonte, copia);
}

const ehChaveiro = (v) => v !== null && typeof v === 'object' && chaveirosProduzidos.has(v);

/**
 * Contrato do PROVEDOR (para qualquer provedor futuro): dado um id que ele diz ATIVO, um REVOGADO e um inexistente, as respostas têm de ser exatamente ATIVA (com segredo >= 32 bytes), REVOGADA e INDISPONIVEL, e uma exceção do provedor tem de virar INDISPONIVEL.
 * Verifica a FONTE (que já aplica a falha fechada); devolve só códigos, nunca valores.
 */
function verificarContratoDoProvedor(fonte, { ativa, revogada, inexistente }) {
  if (!ehFonteDeChaves(fonte) || ![ativa, revogada, inexistente].every((id) => typeof id === 'string' && CHAVE_ID.test(id))) throw configuracaoInvalida();
  const falhas = [];
  const ler = (id) => { try { return fonte.obter(id); } catch { return null; } };
  const a = ler(ativa);
  if (!a || a.situacao !== 'ATIVA' || !(a.segredo instanceof Uint8Array) || a.segredo.length < 32) falhas.push('ATIVA_NAO_RESPONDIDA');
  if (a && a.segredo instanceof Uint8Array) a.segredo.fill(0);
  const r = ler(revogada);
  if (!r || r.situacao !== 'REVOGADA' || Object.hasOwn(r, 'segredo')) falhas.push('REVOGADA_NAO_RESPONDIDA');
  const i = ler(inexistente);
  if (!i || i.situacao !== 'INDISPONIVEL' || Object.hasOwn(i, 'segredo')) falhas.push('INEXISTENTE_NAO_INDISPONIVEL');
  return Object.freeze({ conforme: falhas.length === 0, falhas: Object.freeze(falhas) });
}

module.exports = { criarChaveiro, ehChaveiro, verificarContratoDoProvedor, AMBIENTES, ESTADOS, USOS };
