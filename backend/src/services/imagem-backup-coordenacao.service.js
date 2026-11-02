'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): CONTRATO DA COORDENAÇÃO COMPARTILHADA E DURÁVEL de identidades de execução, necessária se a aplicação rodar em MAIS DE UM PROCESSO/INSTÂNCIA. Só o CONTRATO e a verificação dele: nenhuma implementação operacional existe, e não há banco, tabela, migration, fila ou armazenamento novo.
 *
 * O registro em memória (`REGISTRO_DE_EXECUCOES`) vale para UM processo: some no reinício e não é visto por outro processo. Ele NÃO é garantia distribuída. A fronteira MULTIPROCESSO da entrada operacional continua FECHADA até existir um coordenador operacional aprovado
 * (`COORDENADORES_COMPARTILHADOS_APROVADOS`, lista fechada e VAZIA) — um coordenador de teste, por mais que cumpra o contrato, nunca é operacional.
 *
 * CONTRATO do implementador (`emitir`, `consumir`, `estado`, `adquirirExclusao`, `liberarExclusao`, `recuperar`, todos assíncronos):
 *  - `emitir()` -> { id } com id único de 128 bits (32 hex), registrado de forma DURÁVEL antes de responder;
 *  - `consumir(id)` -> { consumido: true } UMA ÚNICA vez no sistema inteiro (mesmo sob concorrência e depois de reinício); qualquer outra apresentação -> { consumido: false, motivo: 'JA_CONSUMIDA' | 'EXPIRADA' | 'DESCONHECIDA' };
 *  - `estado(id)` -> 'ATIVA' | 'CONSUMIDA' | 'EXPIRADA' | null (desconhecida);
 *  - `adquirirExclusao({ chave, ttlMs })` -> { posse } para UM dono por vez, ou { ocupada: true }; a posse expira sozinha no ttl (nunca é eterna); `liberarExclusao(posse)` só o dono libera;
 *  - `recuperar()` -> { ok: true } depois de uma reinicialização, reconstruindo o estado do armazenamento durável.
 * O INVÓLUCRO (`criarCoordenadorCompartilhado`) impõe FALHA FECHADA: exceção, prazo estourado, resposta fora do formato ou inconclusiva nunca é sucesso (`consumir` só é verdadeiro com `{ consumido: true }` exato), e a reapresentação nunca vira nova autorização.
 * `verificarContratoDoCoordenador` roda os cenários do contrato contra uma implementação e devolve só códigos.
 */

const COORDENADORES_COMPARTILHADOS_APROVADOS = Object.freeze([]);
const ID_COORDENADOR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_EXECUCAO = /^[0-9a-f]{32}$/;
const CHAVE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METODOS = Object.freeze(['emitir', 'consumir', 'estado', 'adquirirExclusao', 'liberarExclusao', 'recuperar']);
const MOTIVOS_DE_RECUSA = Object.freeze(['JA_CONSUMIDA', 'EXPIRADA', 'DESCONHECIDA']);
const coordenadoresProduzidos = new WeakSet();

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração da coordenação inválida'), { code: 'CONFIGURACAO_INVALIDA' });

/** `criarCoordenadorCompartilhado({ id, implementacao, prazoMs })`: aprovado só pelo id da lista (vazia); em NODE_ENV=test nasce com origem TESTE_CONTROLADO e `operacional:false`. */
function criarCoordenadorCompartilhado(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['id', 'implementacao', 'prazoMs']) || typeof opcoes.id !== 'string' || !ID_COORDENADOR.test(opcoes.id)) throw configuracaoInvalida();
  if (!ehObjeto(opcoes.implementacao) || !METODOS.every((m) => typeof opcoes.implementacao[m] === 'function')) throw configuracaoInvalida();
  if (!Number.isSafeInteger(opcoes.prazoMs) || opcoes.prazoMs < 1 || opcoes.prazoMs > 600000) throw configuracaoInvalida();
  const aprovado = COORDENADORES_COMPARTILHADOS_APROVADOS.includes(opcoes.id);
  if (!aprovado && process.env.NODE_ENV !== 'test') throw Object.assign(new Error('coordenador compartilhado não aprovado'), { code: 'COORDENADOR_NAO_APROVADO' });
  const { implementacao, prazoMs } = opcoes;

  async function comPrazo(chamada) {
    let timer;
    const prazo = new Promise((resolver) => { timer = setTimeout(() => resolver({ inconclusivo: true }), prazoMs); });
    try {
      return await Promise.race([Promise.resolve().then(chamada), prazo]);
    } catch {
      return { inconclusivo: true };
    } finally {
      clearTimeout(timer);
    }
  }

  const coordenador = Object.freeze({
    id: opcoes.id,
    origem: aprovado ? 'OPERACIONAL' : 'TESTE_CONTROLADO',
    operacional: aprovado,
    compartilhado: true,
    duravel: true,
    async emitir() {
      const r = await comPrazo(() => implementacao.emitir());
      return ehObjeto(r) && chavesExatas(r, ['id']) && typeof r.id === 'string' && ID_EXECUCAO.test(r.id) ? Object.freeze({ ok: true, id: r.id }) : Object.freeze({ ok: false, motivo: 'INCONCLUSIVO' });
    },
    async consumir(id) {
      if (typeof id !== 'string' || !ID_EXECUCAO.test(id)) return Object.freeze({ consumido: false, motivo: 'DESCONHECIDA' });
      const r = await comPrazo(() => implementacao.consumir(id));
      if (ehObjeto(r) && chavesExatas(r, ['consumido']) && r.consumido === true) return Object.freeze({ consumido: true, motivo: null });
      if (ehObjeto(r) && chavesExatas(r, ['consumido', 'motivo']) && r.consumido === false && MOTIVOS_DE_RECUSA.includes(r.motivo)) return Object.freeze({ consumido: false, motivo: r.motivo });
      return Object.freeze({ consumido: false, motivo: 'INCONCLUSIVO' });
    },
    async estado(id) {
      if (typeof id !== 'string' || !ID_EXECUCAO.test(id)) return null;
      const r = await comPrazo(() => implementacao.estado(id));
      return r === 'ATIVA' || r === 'CONSUMIDA' || r === 'EXPIRADA' ? r : null;
    },
    async adquirirExclusao(pedido) {
      if (!ehObjeto(pedido) || !chavesExatas(pedido, ['chave', 'ttlMs']) || typeof pedido.chave !== 'string' || !CHAVE.test(pedido.chave) || !Number.isSafeInteger(pedido.ttlMs) || pedido.ttlMs < 1) throw configuracaoInvalida();
      const r = await comPrazo(() => implementacao.adquirirExclusao({ chave: pedido.chave, ttlMs: pedido.ttlMs }));
      if (ehObjeto(r) && chavesExatas(r, ['posse']) && r.posse !== undefined && r.posse !== null) return Object.freeze({ adquirida: true, posse: r.posse, motivo: null });
      if (ehObjeto(r) && chavesExatas(r, ['ocupada']) && r.ocupada === true) return Object.freeze({ adquirida: false, motivo: 'OCUPADA' });
      return Object.freeze({ adquirida: false, motivo: 'INCONCLUSIVO' });
    },
    async liberarExclusao(posse) {
      const r = await comPrazo(() => implementacao.liberarExclusao(posse));
      return ehObjeto(r) && chavesExatas(r, ['liberada']) && r.liberada === true;
    },
    async recuperar() {
      const r = await comPrazo(() => implementacao.recuperar());
      return ehObjeto(r) && chavesExatas(r, ['ok']) && r.ok === true;
    },
  });
  coordenadoresProduzidos.add(coordenador);
  return coordenador;
}

const ehCoordenadorCompartilhado = (v) => v !== null && typeof v === 'object' && coordenadoresProduzidos.has(v);

/** Cenários do contrato. `reiniciar()` (opcional, do teste/implantador) simula o reinício do processo mantendo só o armazenamento durável. Devolve só códigos. */
async function verificarContratoDoCoordenador(coordenador, { reiniciar = null } = {}) {
  if (!ehCoordenadorCompartilhado(coordenador)) throw configuracaoInvalida();
  const falhas = [];
  const e = await coordenador.emitir();
  if (!e.ok) return Object.freeze({ conforme: false, falhas: Object.freeze(['EMISSAO_FALHOU']) });
  const outra = await coordenador.emitir();
  if (!outra.ok || outra.id === e.id) falhas.push('IDENTIDADE_NAO_UNICA');
  if ((await coordenador.estado(e.id)) !== 'ATIVA') falhas.push('ESTADO_INICIAL_NAO_ATIVA');
  const disputa = await Promise.all([coordenador.consumir(e.id), coordenador.consumir(e.id), coordenador.consumir(e.id)]);
  if (disputa.filter((r) => r.consumido === true).length !== 1) falhas.push('CONSUMO_NAO_E_UNICO');
  if ((await coordenador.consumir(e.id)).consumido !== false) falhas.push('REAPRESENTACAO_ACEITA');
  if ((await coordenador.estado(e.id)) !== 'CONSUMIDA') falhas.push('ESTADO_FINAL_NAO_CONSUMIDA');
  if ((await coordenador.consumir('f'.repeat(32))).consumido !== false) falhas.push('DESCONHECIDA_ACEITA');
  const a = await coordenador.adquirirExclusao({ chave: 'backup:imagens', ttlMs: 60000 });
  const b = await coordenador.adquirirExclusao({ chave: 'backup:imagens', ttlMs: 60000 });
  if (!a.adquirida || b.adquirida) falhas.push('EXCLUSAO_NAO_E_MUTUA');
  if (a.adquirida && (await coordenador.liberarExclusao(a.posse)) !== true) falhas.push('LIBERACAO_FALHOU');
  if (typeof reiniciar === 'function') {
    await reiniciar();
    if ((await coordenador.recuperar()) !== true) falhas.push('RECUPERACAO_FALHOU');
    if ((await coordenador.consumir(e.id)).consumido !== false) falhas.push('REPLAY_APOS_REINICIO_ACEITO');
    if ((await coordenador.estado(e.id)) !== 'CONSUMIDA') falhas.push('ESTADO_PERDIDO_NO_REINICIO');
  }
  return Object.freeze({ conforme: falhas.length === 0, falhas: Object.freeze(falhas) });
}

module.exports = { criarCoordenadorCompartilhado, ehCoordenadorCompartilhado, verificarContratoDoCoordenador, COORDENADORES_COMPARTILHADOS_APROVADOS };
