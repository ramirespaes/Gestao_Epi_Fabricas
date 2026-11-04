'use strict';

const { saidaDoSinal } = require('../utils/parada-por-sinal');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-SUP-1): SUPERVISÃO unitária do ciclo de vida de um processo externo (no futuro, o
 * pg_dump). Tudo chega por dependência injetada (processo, grupo, sinais e relógio): este módulo não cria processo, não envia sinal real, não lê grupo
 * real nem usa relógio real. Contrato PROVISÓRIO (RED-SUP-1 e RED-SUP-1A).
 *
 * Princípio: o fim do processo principal NÃO prova que acabou. Conclusão (saída 0) exige, juntos: término informado com código 0 e sem sinal, fluxos
 * fechados e o grupo CONFIRMADO vazio. Enviar um sinal não prova a morte de ninguém. `liberarTravaPermitido` só é true com o término do processo
 * principal CONFIRMADO (código inteiro ou sinal; GREEN-SUP-1B: o grupo vazio não o substitui), os fluxos fechados E o grupo confirmado vazio; em
 * qualquer outro caso a trava fica (saída 11).
 *
 * Ordem: (1) valida as dependências e os prazos ANTES de iniciar (saída 2); (2) registra o pedido de parada, que só é anotado (e, com
 * `repassarParada`, repassado ao grupo uma única vez); (3) inicia o processo (falha ou manipulador sem pgid: saída 1, sem liberação); (4) espera o
 * término E o fechamento dos fluxos contra o prazo total; (5) prazo esgotado com o processo vivo: SIGTERM por `sinais.enviar(pgid, …)` (ver DESTINO DO SINAL abaixo), cortesia, e SIGKILL pelo mesmo caminho só se
 * o processo principal não terminar durante a cortesia (GREEN-SUP-1C: a cortesia observa só o término do processo, nunca os fluxos); depois do SIGKILL não espera indefinidamente: decide pela conferência do grupo; prazo esgotado com o
 * processo já terminado e os fluxos abertos: nenhum sinal; (6) confere o grupo até `tentativasGrupo` vezes, cada consulta limitada por
 * `prazo(consultaGrupoMs)` (consulta que não responde, lança ou responde algo que não seja true/false vale como NÃO confirmada); descendente vivo
 * nunca é sinalizado aqui; (7) cancela TODOS os prazos criados e passa a ignorar pedidos, prazos e respostas tardias.
 *
 * Saídas: 0 concluído; 1 o processo não pôde ser iniciado; 2 argumentos; 9 falha com o término confirmado, o grupo confirmado vazio e os fluxos fechados; 11 estado
 * desconhecido (trava mantida); 128 + número do sinal quando só a parada impediu a conclusão. Precedência: 11, depois 9, depois a parada.
 *
 * LIMITES (requisitos da integração, não garantias deste módulo): o `executarBackup` ainda NÃO respeita `liberarTravaPermitido: false` e precisa
 * passar a respeitá-lo antes de qualquer execução operacional; o processo real tem de nascer em grupo próprio e isolado, com a identidade do grupo
 * protegida contra a reutilização do PGID; a qualidade da resposta de `grupo.vivos` (por exemplo, processos que saem do grupo com setsid) depende da
 * implementação real, fora deste módulo. RISCO EM ABERTO: uma promessa de `sinais.enviar()` que nunca resolve deixa a supervisão suspensa; não há
 * prazo aqui de propósito (abandonar um envio ainda capaz de produzir efeito tardio não é seguro): a solução futura precisa de cancelamento seguro
 * ou de conclusão comprovada do envio antes de liberar qualquer recurso.
 *
 * DESTINO DO SINAL: este módulo só entrega `(pgid, sinal)` à dependência `sinais.enviar`; quem decide para QUEM o sinal vai é a dependência. Na composição de produção ela é `enviarSinal` do controle de processo (imagem-backup-pgdump-controle-processo.service.js), que
 * sinaliza o PROCESSO FILHO (o líder do grupo) pelo `kill` capturado do próprio filho, só se o pgid pedido for o do lançamento daquele controle, o início estiver confirmado e nenhum `exit` tiver sido observado. Não há sinal por PGID negativo nem `process.kill`: descendentes do filho NÃO são sinalizados
 * aqui e sua ausência só é OBSERVADA (`grupo.vivos`), nunca comprovada. A janela de reutilização de PID depois do término do filho não é eliminada por este desenho (a documentação do Node.js reconhece o risco).
 */

const SAIDAS = Object.freeze({
  CONCLUIDO: 0,
  INICIO_FALHOU: 1,
  ARGUMENTOS: 2,
  FALHA: 9,
  ESTADO_DESCONHECIDO: 11,
});

const MOTIVOS = Object.freeze({
  PROCESSO_FALHOU: 'PROCESSO_FALHOU',
  TERMINADO_POR_SINAL: 'TERMINADO_POR_SINAL',
  SAIDA_INDEFINIDA: 'SAIDA_INDEFINIDA',
  FLUXOS_PENDENTES: 'FLUXOS_PENDENTES',
  DESCENDENTES_ATIVOS: 'DESCENDENTES_ATIVOS',
  GRUPO_NAO_CONFIRMADO: 'GRUPO_NAO_CONFIRMADO',
  PRAZO_ESGOTADO: 'PRAZO_ESGOTADO',
  ENCERRAMENTO_FORCADO: 'ENCERRAMENTO_FORCADO',
  PARADA_SOLICITADA: 'PARADA_SOLICITADA',
  SINAL_NAO_ENVIADO: 'SINAL_NAO_ENVIADO',
  INICIO_FALHOU: 'INICIO_FALHOU',
  NAO_INICIADO: 'NAO_INICIADO',
  INICIO_INCONCLUSIVO: 'INICIO_INCONCLUSIVO',
  ERRO_INTERNO: 'ERRO_INTERNO',
});

/** Motivos que, com o grupo confirmado vazio e os fluxos fechados, fazem do término uma falha (9). */
const FALHAS = new Set([MOTIVOS.PROCESSO_FALHOU, MOTIVOS.TERMINADO_POR_SINAL, MOTIVOS.SAIDA_INDEFINIDA, MOTIVOS.PRAZO_ESGOTADO, MOTIVOS.SINAL_NAO_ENVIADO,
  MOTIVOS.ERRO_INTERNO]);

/**
 * Diagnóstico INFORMATIVO de uma rejeição de `iniciar()`: só para uma instância de Error cujo `code` (lido UMA vez, sob proteção) seja exatamente um dos dois
 * códigos fixos. Não é prova: o `code` pode ser forjado por qualquer dependência injetada, então nada aqui libera a trava, declara encerramento, finaliza
 * recursos ou autoriza sinal. Nunca lê `message` nem `stack`; qualquer exceção (por exemplo, de um getter) vira "sem diagnóstico".
 */
function motivoDoInicio(falha) {
  try {
    if (!(falha instanceof Error)) return null;
    const codigo = falha.code;
    if (codigo === MOTIVOS.NAO_INICIADO) return MOTIVOS.NAO_INICIADO;
    if (codigo === MOTIVOS.INICIO_INCONCLUSIVO) return MOTIVOS.INICIO_INCONCLUSIVO;
    return null;
  } catch {
    return null;
  }
}

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const ehPrazoValido = (valor) => Number.isSafeInteger(valor) && valor > 0;
const ehPromessa = (valor) => valor !== null && (typeof valor === 'object' || typeof valor === 'function') && ehFuncao(valor.then);
const ceder = () => new Promise((resolver) => setImmediate(resolver));

function opcoesValidas(o) {
  if (!ehObjeto(o) || !ehFuncao(o.iniciar)) return false;
  if (!ehObjeto(o.grupo) || !ehFuncao(o.grupo.vivos)) return false;
  if (!ehObjeto(o.sinais) || !ehFuncao(o.sinais.enviar)) return false;
  if (!ehObjeto(o.temporizador) || !ehFuncao(o.temporizador.prazo) || !ehFuncao(o.temporizador.intervalo)) return false;
  const p = o.prazos;
  if (!ehObjeto(p) || !ehPrazoValido(p.totalMs) || !ehPrazoValido(p.cortesiaMs) || !ehPrazoValido(p.intervaloGrupoMs) || !ehPrazoValido(p.consultaGrupoMs)
    || !ehPrazoValido(p.tentativasGrupo)) return false;
  if (o.parada !== undefined && o.parada !== null && !(ehObjeto(o.parada) && ehFuncao(o.parada.aoPedir))) return false;
  if (o.repassarParada !== undefined && typeof o.repassarParada !== 'boolean') return false;
  return true;
}

/** Término informado pelo processo: exatamente um de { código inteiro, sinal } — qualquer outra forma é indefinida. */
function normalizarTermino(valor) {
  if (!ehObjeto(valor)) return null;
  const { codigo, sinal } = valor;
  if (Number.isInteger(codigo) && sinal === null) return { codigo, sinal: null };
  if (codigo === null && typeof sinal === 'string' && sinal !== '') return { codigo: null, sinal };
  return null;
}

function montarResultado({ saida, liberarTravaPermitido = false, encerramentoForcado = false, parada = null, termino = null, motivos = [] }) {
  return Object.freeze({
    saida,
    concluido: saida === SAIDAS.CONCLUIDO,
    liberarTravaPermitido: liberarTravaPermitido === true,
    encerramentoForcado,
    parada,
    codigoDoProcesso: termino === null ? null : termino.codigo,
    sinalDoProcesso: termino === null ? null : termino.sinal,
    motivos: Object.freeze([...new Set(motivos)]),
  });
}

function saidaDaParada(sinal) {
  try {
    return saidaDoSinal(sinal);
  } catch {
    return SAIDAS.FALHA;
  }
}

async function supervisionar(opcoes) {
  if (!opcoesValidas(opcoes)) return montarResultado({ saida: SAIDAS.ARGUMENTOS });
  const { iniciar, grupo, sinais, temporizador, prazos, parada } = opcoes;
  const repassar = opcoes.repassarParada === true;

  const motivos = [];
  const enviados = new Set();
  const prazosCriados = [];
  const pendentes = [];
  let encerrado = false;
  let pgid = null;
  let sinalDaParada = null;
  let repassado = false;
  let encerramentoForcado = false;

  /** Todo prazo passa por aqui, para ser cancelado no fim; um prazo fora do contrato é erro (nunca uma espera sem limite). */
  function criarPrazo(ms) {
    const prazo = temporizador.prazo(ms);
    if (!ehObjeto(prazo) || !ehPromessa(prazo.promessa) || !ehFuncao(prazo.cancelar)) throw Object.assign(new Error('prazo inválido'), { codigo: MOTIVOS.ERRO_INTERNO });
    prazosCriados.push(prazo);
    return prazo;
  }
  const cancelar = (prazo) => { try { prazo.cancelar(); } catch { /* cancelar é melhor esforço: o fim já ignora o que vier depois */ } };

  /** Sinal pela dependência `sinais.enviar(pgid, sinal)` (na composição de produção: o `kill` do filho líder do grupo, não do grupo inteiro; ver DESTINO DO SINAL no cabeçalho). Aceito não prova nada; recusado ou com erro vira SINAL_NAO_ENVIADO. Depois do fim, nenhum sinal sai daqui. */
  async function enviarAoGrupo(sinal) {
    if (encerrado || pgid === null) return false;
    enviados.add(sinal);
    encerramentoForcado = true;
    let aceito = false;
    try {
      aceito = (await sinais.enviar(pgid, sinal)) === true;
    } catch {
      aceito = false;
    }
    if (!aceito) motivos.push(MOTIVOS.SINAL_NAO_ENVIADO);
    return aceito;
  }

  function repassarSeCabivel() {
    if (!repassar || repassado || sinalDaParada === null || pgid === null || encerrado) return;
    repassado = true;
    pendentes.push(enviarAoGrupo(sinalDaParada));
  }

  if (parada) {
    parada.aoPedir((recebido) => {
      if (encerrado || sinalDaParada !== null) return;
      sinalDaParada = typeof recebido === 'string' && recebido !== '' ? recebido : 'DESCONHECIDO';
      repassarSeCabivel();
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------- início
  let processo;
  try {
    processo = await iniciar();
  } catch (falha) {
    encerrado = true;
    const diagnostico = motivoDoInicio(falha);
    return montarResultado({ saida: SAIDAS.INICIO_FALHOU, motivos: diagnostico === null ? [MOTIVOS.INICIO_FALHOU] : [MOTIVOS.INICIO_FALHOU, diagnostico] });
  }
  if (!ehObjeto(processo) || !Number.isSafeInteger(processo.pgid) || processo.pgid <= 1 || !ehPromessa(processo.saida) || !ehPromessa(processo.fluxosFechados)) {
    encerrado = true;
    return montarResultado({ saida: SAIDAS.INICIO_FALHOU, motivos: [MOTIVOS.INICIO_FALHOU] });
  }
  pgid = processo.pgid;

  // Três confirmações DISTINTAS, nunca deduzidas uma da outra: o término do processo principal (`terminou`/`termino`), o fechamento dos fluxos
  // (`fluxosFechados`) e, mais adiante, a ausência confirmada de processos no grupo (`vazio`).
  const estado = { terminou: false, termino: null, fluxosResolvidos: false, fluxosFechados: false };
  const terminoP = Promise.resolve(processo.saida).then(
    (valor) => { estado.terminou = true; estado.termino = normalizarTermino(valor); },
    () => { estado.terminou = true; estado.termino = null; },
  );
  const fluxosP = Promise.resolve(processo.fluxosFechados).then(
    () => { estado.fluxosResolvidos = true; estado.fluxosFechados = true; },
    () => { estado.fluxosResolvidos = true; estado.fluxosFechados = false; },
  );
  const fimTudo = Promise.all([terminoP, fluxosP]).then(() => 'fim');

  let vazio = false;
  let ultimaConsulta = null;
  try {
    repassarSeCabivel();

    // --------------------------------------------------------------------------------------------------------------------- espera e prazo
    const total = criarPrazo(prazos.totalMs);
    const primeiro = await Promise.race([fimTudo, total.promessa.then(() => 'prazo')]);
    cancelar(total);

    if (primeiro === 'prazo') {
      motivos.push(MOTIVOS.PRAZO_ESGOTADO);
      if (!estado.terminou) {
        await enviarAoGrupo('SIGTERM');
        const cortesia = criarPrazo(prazos.cortesiaMs);
        // GREEN-SUP-1C: a cortesia observa SÓ o término do processo principal, separado dos fluxos. Término confirmado (ou ilegível: o processo já
        // respondeu) cancela a cortesia e impede o SIGKILL, mesmo com os fluxos abertos, que depois mantêm a trava; processo vivo ao fim da
        // cortesia recebe SIGKILL, mesmo com os fluxos já fechados.
        const naCortesia = await Promise.race([terminoP.then(() => 'terminou'), cortesia.promessa.then(() => 'prazo')]);
        cancelar(cortesia);
        if (naCortesia === 'prazo') {
          await enviarAoGrupo('SIGKILL');
          motivos.push(MOTIVOS.ENCERRAMENTO_FORCADO);
          // O envio não prova a morte: dá uma volta na fila para registrar o que já tiver acontecido e decide pela conferência do grupo.
          await Promise.race([fimTudo, ceder()]);
        }
      }
    }

    // --------------------------------------------------------------------------------------------------------------------- conferência do grupo
    for (let tentativa = 1; tentativa <= prazos.tentativasGrupo; tentativa += 1) {
      const limite = criarPrazo(prazos.consultaGrupoMs);
      const consulta = Promise.resolve()
        .then(() => grupo.vivos(pgid))
        .then((resposta) => (resposta === true || resposta === false ? resposta : null), () => null);
      ultimaConsulta = await Promise.race([consulta, limite.promessa.then(() => null)]);
      cancelar(limite);
      if (ultimaConsulta === false) { vazio = true; break; }
      if (tentativa < prazos.tentativasGrupo) await temporizador.intervalo(prazos.intervaloGrupoMs);
    }
  } catch {
    motivos.push(MOTIVOS.ERRO_INTERNO);
    vazio = false;
  }

  await Promise.all(pendentes);
  encerrado = true;
  for (const prazo of prazosCriados) cancelar(prazo);

  // ----------------------------------------------------------------------------------------------------------------------- veredito
  if (!vazio) motivos.push(ultimaConsulta === true ? MOTIVOS.DESCENDENTES_ATIVOS : MOTIVOS.GRUPO_NAO_CONFIRMADO);
  if (!estado.fluxosFechados) motivos.push(MOTIVOS.FLUXOS_PENDENTES);
  if (sinalDaParada !== null) motivos.push(MOTIVOS.PARADA_SOLICITADA);

  const { termino } = estado;
  if (termino === null) motivos.push(MOTIVOS.SAIDA_INDEFINIDA);
  else if (termino.sinal !== null && !enviados.has(termino.sinal)) motivos.push(MOTIVOS.TERMINADO_POR_SINAL);
  else if (termino.codigo !== null && termino.codigo !== 0) motivos.push(MOTIVOS.PROCESSO_FALHOU);

  // GREEN-SUP-1B: o grupo vazio NÃO substitui a confirmação do processo principal. Liberar exige o término informado de forma positiva e válida
  // (código inteiro ou sinal), os fluxos fechados e o grupo confirmado vazio; término pendente, rejeitado ou fora do formato mantém a trava (11).
  const liberarTravaPermitido = termino !== null && estado.fluxosFechados && vazio;
  let saida;
  if (!liberarTravaPermitido) saida = SAIDAS.ESTADO_DESCONHECIDO;
  else if (motivos.some((motivo) => FALHAS.has(motivo))) saida = SAIDAS.FALHA;
  else if (sinalDaParada !== null) saida = saidaDaParada(sinalDaParada);
  else saida = SAIDAS.CONCLUIDO;

  return montarResultado({ saida, liberarTravaPermitido, encerramentoForcado, parada: sinalDaParada, termino, motivos });
}

module.exports = { supervisionar, SAIDAS, MOTIVOS };
