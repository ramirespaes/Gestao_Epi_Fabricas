'use strict';
// Provedor de coordenação do CD do backend que conversa com o guardião (backend/scripts/guardiao-de-coordenacao.js).
// Usado só pelo agente do backend; não consta da lista de provedores aceitos pelo instalador e, sozinho, não libera
// nada.
//
// O guardião é um processo que segura, numa sessão PostgreSQL dedicada, a exclusão do D-ORF-6. Este módulo o inicia,
// pergunta a ele e devolve o estado no formato que o instalador espera de um provedor:
//   LIVRE         só quando o guardião responde, a ESTA pergunta, que a MESMA sessão da aquisição (impressão igual)
//                 detém exatamente os quatro cadeados, e o contador de comandos da sessão bate com as perguntas feitas;
//   OCUPADO       quando a aquisição foi recusada porque outra operação já estava em curso;
//   DESCONHECIDO  em qualquer outro caso: sem aquisição, sem resposta, resposta fora do protocolo, processo morto,
//                 aviso de perda, ou depois da liberação. Uma vez perdida, a garantia não volta.
// O contador de comandos é controle complementar: divergência é perda, mas contador certo não prova nada sozinho.
// A credencial fica num arquivo que só o guardião lê; aqui passa apenas o caminho. O guardião roda com ambiente vazio:
// nada do ambiente de quem o inicia (credenciais, opções do Node) chega a ele.
//
// 3B-2B-3A: cada instância guarda a primeira causa da perda e responde garantiaVigente() na hora, sem perguntar ao
// guardião. Uma instância só é RECONHECIDA (garantiaVigente(consultar, expectativa)) se foi iniciada pelo iniciador
// deste módulo, conferiu o hash do roteiro antes de iniciar, está adquirida e sem perda, e foi criada para a baseline e
// o roteiro esperados. O reconhecimento não libera nada: o instalador continua recusando o backend.
//
// liberar() informa o que foi visto DESTE lado, nunca uma comprovação no PostgreSQL (comprovadaNoBanco é sempre false):
//   LIBERACAO_INFORMADA  o guardião avisou que soltou os cadeados e encerrou a sessão, e o processo terminou;
//   PROCESSO_ENCERRADO   o processo terminou sem esse aviso (derrubado ou já morto): a sessão dele caiu;
//   INDETERMINADA        o processo não terminou no prazo, nem depois do sinal: nada pode ser afirmado;
//   SEM_PROCESSO         nenhum guardião chegou a ser iniciado.
// Separadamente, cadeadosLiberados.confirmada só é verdadeiro quando o aviso traz a impressão da aquisição (posse
// conferida imediatamente antes de soltar), quatro soltos e nenhum restante, sem perda antes do pedido. A sessão
// encerrada é só declaração do guardião (sessaoEncerradaDeclarada).
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PRAZOS = Object.freeze({ adquirirMs: 20000, confirmarMs: 10000, liberarMs: 10000, encerrarMs: 5000 });
const ORIGEM = 'guardiao-postgresql';
const CADEADOS = 4;
const OCUPACOES = new Set(['EM_USO', 'MIGRACAO_EM_CURSO']);
const EVENTOS = new Set(['ADQUIRIDA', 'RECUSADA', 'CONFIRMADA', 'PERDIDA', 'LIBERADA', 'CANAL_FECHADO', 'EXPIRADA', 'PROTOCOLO', 'SESSAO_INCERTA']);
const AVISOS_DE_FIM = new Set(['PERDIDA', 'LIBERADA', 'CANAL_FECHADO', 'EXPIRADA', 'PROTOCOLO', 'SESSAO_INCERTA']);
const FORMATO_SISTEMA = /^[1-9]\d{0,19}$/;
const FORMATO_MOTIVO = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_COMMIT = /^[0-9a-f]{40}$/;

const texto = (v) => typeof v === 'string' && v.trim() !== '';
const prazoValido = (v) => Number.isInteger(v) && v >= 10 && v <= 10 * 60 * 1000;
const baselineValida = (b) => b !== null && typeof b === 'object' && texto(b.rotulo) && typeof b.commit === 'string' && FORMATO_COMMIT.test(b.commit);
const hashValido = (h) => typeof h === 'string' && FORMATO_HASH.test(h);

// Ficha de cada instância criada aqui, indexada pela função consultar que ela entrega. Só este módulo escreve nela.
const INSTANCIAS = new WeakMap();

// Processo de verdade: canal de controle por stdin/stdout, sem shell. 'close' só chega depois de lidas todas as linhas.
// O evento 'error' do Node cobre casos diferentes: sem pid, o processo nunca existiu (FALHA_AO_INICIAR); com pid, é
// erro de sinal ou de canal num processo que pode continuar vivo, e não diz nada sobre o fim dele. Para um processo
// iniciado, só 'close' comprova o encerramento (ENCERRADO).
function iniciarProcessoReal(comando, args, { cwd, criarFilho = spawn }) {
  const filho = criarFilho(comando, args, { cwd, env: {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const linhas = readline.createInterface({ input: filho.stdout });
  const aoSair = [];
  let fim = null;
  const sair = (codigo, motivo) => { if (fim) return; fim = { codigo, motivo }; for (const cb of aoSair.splice(0)) cb(codigo, motivo); };
  filho.stdin.on('error', () => { /* o filho pode ter encerrado antes da escrita */ });
  filho.on('close', (codigo) => sair(codigo, 'ENCERRADO'));
  filho.on('error', () => { if (filho.pid === undefined) sair(null, 'FALHA_AO_INICIAR'); });
  return {
    escrever: (t) => { try { filho.stdin.write(t); } catch { /* canal já fechado */ } },
    fecharEntrada: () => { try { filho.stdin.end(); } catch { /* canal já fechado */ } },
    aoReceberLinha: (cb) => { linhas.on('line', cb); },
    aoSair: (cb) => { if (fim) cb(fim.codigo, fim.motivo); else aoSair.push(cb); },
    // Verdadeiro só se o sinal foi entregue; a saída do processo é outra coisa e chega por aoSair.
    matar: () => { try { return filho.kill('SIGKILL'); } catch { return false; } },
  };
}

// Reconhecimento de uma instância: real, roteiro conferido, adquirida sem perda e criada para a expectativa dada.
function garantiaVigente(consultar, expectativa) {
  const ficha = typeof consultar === 'function' ? INSTANCIAS.get(consultar) : undefined;
  if (!ficha || expectativa === null || typeof expectativa !== 'object' || !baselineValida(expectativa.baseline) || !hashValido(expectativa.sha256DoRoteiro)) return false;
  return ficha.real && ficha.baseline !== null && ficha.baseline.rotulo === expectativa.baseline.rotulo && ficha.baseline.commit === expectativa.baseline.commit
    && ficha.sha256DoRoteiro === expectativa.sha256DoRoteiro && ficha.roteiroConferido() && ficha.vigente();
}

function criarCoordenacaoPorGuardiao({ comando, dir, credencial, sistema, prazos = PRAZOS, iniciarProcesso = iniciarProcessoReal, baseline, sha256DoRoteiro } = {}) {
  const valida = Array.isArray(comando) && comando.length >= 2 && comando.every(texto) && path.isAbsolute(comando[0]) && texto(dir) && path.isAbsolute(dir)
    && texto(credencial) && path.isAbsolute(credencial) && typeof sistema === 'string' && FORMATO_SISTEMA.test(sistema)
    && prazos !== null && typeof prazos === 'object' && prazoValido(prazos.adquirirMs) && prazoValido(prazos.confirmarMs) && prazoValido(prazos.liberarMs) && prazoValido(prazos.encerrarMs)
    && typeof iniciarProcesso === 'function' && (baseline === undefined || baselineValida(baseline)) && (sha256DoRoteiro === undefined || hashValido(sha256DoRoteiro));
  if (!valida) throw Object.assign(new Error('COORDENACAO_CONFIG'), { codigo: 'COORDENACAO_CONFIG' });

  let estado = 'NOVA'; // NOVA -> AGUARDANDO -> ADQUIRIDA | OCUPADA | PERDIDA -> LIBERADA
  let ocupacao = null;
  let processo = null;
  let vivo = false;
  let pergunta = null; // quem espera a próxima mensagem do guardião
  let fila = Promise.resolve();
  let liberacao = null;
  let pedidoDeLiberacao = false;
  let liberacaoInformada = false;
  let avisoDeLiberacao = null;
  let liberadaSemPerda = null;
  let forcada = false;
  let nuncaIniciou = false;
  let roteiroConferido = false;
  let impressao = null;
  let vidaMaximaMs = null;
  let confirmacoes = 0;
  let perda = null; // primeira causa: { motivo, em }
  const esperandoSaida = [];

  const agora = () => new Date().toISOString();
  const desconhecido = (motivo) => ({ situacao: 'DESCONHECIDO', origem: `${ORIGEM}: ${motivo}`, consultadoEm: agora() });
  const responder = (mensagem) => { const p = pergunta; pergunta = null; if (p) p(mensagem); };
  const registrarPerda = (motivo) => { if (!perda) perda = Object.freeze({ motivo, em: agora() }); };
  const vigente = () => estado === 'ADQUIRIDA' && vivo && perda === null;
  // Pede o encerramento forçado. Falha ao sinalizar não vira exceção: quem decide é a saída do processo, se chegar.
  const sinalizar = () => { try { if (vivo && processo) processo.matar(); } catch { /* sem sinal entregue */ } };
  // A garantia acabou: não há caminho de volta para ADQUIRIDA, e o processo é encerrado para a sessão cair.
  const perder = (motivo) => {
    if (estado === 'ADQUIRIDA' || estado === 'AGUARDANDO') { estado = 'PERDIDA'; registrarPerda(motivo); }
    sinalizar();
  };
  const motivoDoAviso = (m) => {
    if (m === null) return 'SEM_CONFIRMACAO';
    if (AVISOS_DE_FIM.has(m.evento)) return m.evento;
    return m.evento === 'CONFIRMADA' ? 'RESPOSTA_NAO_PEDIDA' : 'MENSAGEM_INVALIDA';
  };
  const receber = (linha) => {
    let mensagem = null;
    try { mensagem = JSON.parse(linha); } catch { mensagem = null; }
    if (mensagem === null || typeof mensagem !== 'object' || Array.isArray(mensagem) || !EVENTOS.has(mensagem.evento)) mensagem = { evento: 'INVALIDA' };
    if (pergunta) { responder(mensagem); return; }
    if (estado === 'LIBERADA') { if (mensagem.evento === 'LIBERADA') { liberacaoInformada = true; avisoDeLiberacao = mensagem; } return; }
    // Mensagem que ninguém pediu (aviso de perda, resposta atrasada, linha estranha) encerra a garantia.
    if (estado === 'ADQUIRIDA') perder(motivoDoAviso(mensagem));
  };
  const saiu = (codigo, motivo) => {
    if (motivo === 'FALHA_AO_INICIAR') nuncaIniciou = true;
    vivo = false;
    if (estado === 'ADQUIRIDA' || estado === 'AGUARDANDO') { estado = 'PERDIDA'; registrarPerda('PROCESSO_ENCERRADO'); }
    responder(null);
    for (const cb of esperandoSaida.splice(0)) cb(true);
  };
  const esperarMensagem = (ms) => new Promise((resolver) => {
    const relogio = setTimeout(() => { if (pergunta === entregar) pergunta = null; resolver(null); }, ms);
    const entregar = (mensagem) => { clearTimeout(relogio); resolver(mensagem); };
    pergunta = entregar;
  });
  const esperarSaida = (ms) => new Promise((resolver) => {
    if (!vivo) { resolver(true); return; }
    const relogio = setTimeout(() => resolver(false), ms);
    esperandoSaida.push(() => { clearTimeout(relogio); resolver(true); });
  });
  // O roteiro que vai ser executado tem de ser, agora, o do hash esperado; senão nada é iniciado.
  const roteiroConfere = () => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(dir, comando[1]))).digest('hex') === sha256DoRoteiro; } catch { return false; }
  };

  async function adquirir() {
    if (estado !== 'NOVA') return { ok: false, motivo: 'GUARDIAO_JA_INICIADO' };
    estado = 'AGUARDANDO';
    if (sha256DoRoteiro !== undefined) {
      if (!roteiroConfere()) { perder('ROTEIRO_DIVERGENTE'); return { ok: false, motivo: 'ROTEIRO_DIVERGENTE' }; }
      roteiroConferido = true;
    }
    try {
      processo = iniciarProcesso(comando[0], [...comando.slice(1), '--credencial', credencial, '--sistema', sistema], { cwd: dir });
      vivo = true;
      processo.aoReceberLinha(receber);
      processo.aoSair(saiu);
    } catch {
      estado = 'PERDIDA';
      registrarPerda('GUARDIAO_INDISPONIVEL');
      return { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' };
    }
    const mensagem = await esperarMensagem(prazos.adquirirMs);
    const completa = mensagem && mensagem.cadeados === CADEADOS && hashValido(mensagem.impressao) && Number.isInteger(mensagem.vidaMaximaMs) && mensagem.vidaMaximaMs > 0;
    if (mensagem && mensagem.evento === 'ADQUIRIDA' && completa && vivo && estado === 'AGUARDANDO') {
      estado = 'ADQUIRIDA';
      impressao = mensagem.impressao;
      vidaMaximaMs = mensagem.vidaMaximaMs;
      return { ok: true, vidaMaximaMs };
    }
    if (mensagem && mensagem.evento === 'RECUSADA' && typeof mensagem.motivo === 'string' && FORMATO_MOTIVO.test(mensagem.motivo)) {
      if (OCUPACOES.has(mensagem.motivo)) { estado = 'OCUPADA'; ocupacao = mensagem.motivo; } else { estado = 'PERDIDA'; registrarPerda('AQUISICAO_RECUSADA'); }
      sinalizar();
      return { ok: false, motivo: mensagem.motivo };
    }
    perder('GUARDIAO_INDISPONIVEL');
    return { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' };
  }

  // Por que uma resposta a ESTA pergunta não confirma a posse (null quando confirma).
  const divergencia = (mensagem, id) => {
    if (!mensagem || mensagem.evento !== 'CONFIRMADA') return motivoDoAviso(mensagem);
    if (mensagem.id !== id) return 'IDENTIFICADOR_DIVERGENTE';
    if (mensagem.impressao !== impressao) return 'IMPRESSAO_DIVERGENTE';
    if (mensagem.cadeados !== CADEADOS) return 'CADEADOS_DIVERGENTES';
    if (mensagem.comandos !== confirmacoes + 1) return 'CONTADOR_DIVERGENTE';
    if (!vivo || estado !== 'ADQUIRIDA') return 'PROCESSO_ENCERRADO';
    return null;
  };

  // É esta a função que um provedor entrega ao instalador. Cada chamada faz uma pergunta nova ao guardião.
  function consultar() {
    const vez = fila.then(async () => {
      if (estado === 'OCUPADA') return { situacao: 'OCUPADO', origem: ORIGEM, consultadoEm: agora(), detalhe: ocupacao };
      if (estado !== 'ADQUIRIDA' || !vivo) return desconhecido(estado === 'NOVA' ? 'exclusão não adquirida' : 'exclusão não garantida');
      const id = crypto.randomBytes(16).toString('hex');
      const espera = esperarMensagem(prazos.confirmarMs);
      processo.escrever(`confirmar ${id}\n`);
      const motivo = divergencia(await espera, id);
      if (motivo === null) { confirmacoes += 1; return { situacao: 'LIVRE', origem: ORIGEM, consultadoEm: agora() }; }
      perder(motivo);
      return desconhecido('sem confirmação do guardião');
    });
    fila = vez.catch(() => {});
    return vez;
  }
  INSTANCIAS.set(consultar, Object.freeze({
    real: iniciarProcesso === iniciarProcessoReal,
    baseline: baseline === undefined ? null : Object.freeze({ rotulo: baseline.rotulo, commit: baseline.commit }),
    sha256DoRoteiro: sha256DoRoteiro === undefined ? null : sha256DoRoteiro,
    roteiroConferido: () => roteiroConferido,
    vigente,
  }));

  const situacaoDaLiberacao = () => {
    if (!processo || nuncaIniciou) return 'SEM_PROCESSO';
    if (vivo) return 'INDETERMINADA';
    return liberacaoInformada ? 'LIBERACAO_INFORMADA' : 'PROCESSO_ENCERRADO';
  };
  const cadeadosLiberados = (situacao) => {
    const a = avisoDeLiberacao;
    if (situacao === 'LIBERACAO_INFORMADA' && liberadaSemPerda === true && impressao !== null && a.impressao === impressao && a.liberados === CADEADOS && a.restantes === 0) {
      return { confirmada: true, liberados: CADEADOS, restantes: 0 };
    }
    return { confirmada: false, liberados: a && Number.isInteger(a.liberados) ? a.liberados : null, restantes: a && Number.isInteger(a.restantes) ? a.restantes : null };
  };
  const resultadoDaLiberacao = () => {
    const situacao = situacaoDaLiberacao();
    return {
      situacao, processoEncerrado: !vivo, forcada, comprovadaNoBanco: false,
      cadeadosLiberados: cadeadosLiberados(situacao), sessaoEncerradaDeclarada: situacao === 'LIBERACAO_INFORMADA' && avisoDeLiberacao.sessaoEncerrada === true,
    };
  };

  // Chamadas repetidas recebem o mesmo resultado. Só o resultado indeterminado é refeito: a nova chamada sinaliza outra
  // vez e volta a esperar a saída.
  function liberar() {
    if (liberacao) return liberacao;
    const vez = fila.then(async () => {
      if (liberadaSemPerda === null) liberadaSemPerda = estado === 'ADQUIRIDA' && perda === null;
      estado = 'LIBERADA';
      if (!vivo) return resultadoDaLiberacao();
      if (!pedidoDeLiberacao) {
        pedidoDeLiberacao = true;
        processo.escrever('liberar\n');
        processo.fecharEntrada();
        if (await esperarSaida(prazos.liberarMs)) return resultadoDaLiberacao();
      }
      forcada = true;
      sinalizar();
      await esperarSaida(prazos.encerrarMs);
      return resultadoDaLiberacao();
    });
    liberacao = vez;
    fila = vez.then((r) => { if (!r.processoEncerrado) liberacao = null; }, () => { liberacao = null; });
    return vez;
  }

  // Diagnóstico para o registro local: só códigos, contagens e horários.
  const descrever = () => Object.freeze({
    instanciaReal: iniciarProcesso === iniciarProcessoReal, estado, roteiroConferido, impressao, vidaMaximaMs, confirmacoes, perda,
  });

  // Uma pergunta nova ao guardião, respondida como sim ou não: verdadeiro só quando a consulta dá LIVRE.
  const confirmar = async () => (await consultar()).situacao === 'LIVRE';

  return { adquirir, consultar, confirmar, liberar, garantiaVigente: vigente, descrever };
}

module.exports = { criarCoordenacaoPorGuardiao, iniciarProcessoReal, garantiaVigente, PRAZOS, ORIGEM };
