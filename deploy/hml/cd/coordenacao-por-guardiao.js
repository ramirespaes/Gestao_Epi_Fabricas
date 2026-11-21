'use strict';
// Provedor de coordenação do CD do backend que conversa com o guardião (backend/scripts/guardiao-de-coordenacao.js).
// Etapa 3B-2A: módulo ISOLADO. Não está ligado ao agente nem ao instalador e não consta da lista de provedores aceitos
// pelo instalador; sozinho, não libera nada.
//
// O guardião é um processo que segura, numa sessão PostgreSQL dedicada, a exclusão do D-ORF-6. Este módulo o inicia,
// pergunta a ele e devolve o estado no formato que o instalador espera de um provedor:
//   LIVRE         só quando o guardião responde, a ESTA pergunta, que a sessão está viva e detém a exclusão;
//   OCUPADO       quando a aquisição foi recusada porque outra operação já estava em curso;
//   DESCONHECIDO  em qualquer outro caso: sem aquisição, sem resposta, resposta fora do protocolo, processo morto,
//                 aviso de perda, ou depois da liberação. Uma vez perdida, a garantia não volta.
// A credencial fica num arquivo que só o guardião lê; aqui passa apenas o caminho. O guardião roda com ambiente vazio:
// nada do ambiente de quem o inicia (credenciais, opções do Node) chega a ele.
//
// Cada pergunta leva um identificador novo; só a resposta com esse mesmo identificador produz LIVRE.
//
// liberar() informa o que foi visto DESTE lado, nunca uma comprovação no PostgreSQL (comprovadaNoBanco é sempre false):
//   LIBERACAO_INFORMADA  o guardião avisou que soltou os cadeados e encerrou a sessão, e o processo terminou;
//   PROCESSO_ENCERRADO   o processo terminou sem esse aviso (derrubado ou já morto): a sessão dele caiu;
//   INDETERMINADA        o processo não terminou no prazo, nem depois do sinal: nada pode ser afirmado;
//   SEM_PROCESSO         nenhum guardião chegou a ser iniciado.
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PRAZOS = Object.freeze({ adquirirMs: 20000, confirmarMs: 10000, liberarMs: 10000, encerrarMs: 5000 });
const ORIGEM = 'guardiao-postgresql';
const OCUPACOES = new Set(['EM_USO', 'MIGRACAO_EM_CURSO']);
const EVENTOS = new Set(['ADQUIRIDA', 'RECUSADA', 'CONFIRMADA', 'PERDIDA', 'LIBERADA', 'CANAL_FECHADO', 'EXPIRADA', 'PROTOCOLO']);
const FORMATO_SISTEMA = /^[1-9]\d{0,19}$/;
const FORMATO_MOTIVO = /^[A-Z][A-Z0-9_]{0,63}$/;

const texto = (v) => typeof v === 'string' && v.trim() !== '';
const prazoValido = (v) => Number.isInteger(v) && v >= 10 && v <= 10 * 60 * 1000;

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

function criarCoordenacaoPorGuardiao({ comando, dir, credencial, sistema, prazos = PRAZOS, iniciarProcesso = iniciarProcessoReal } = {}) {
  const valida = Array.isArray(comando) && comando.length >= 2 && comando.every(texto) && path.isAbsolute(comando[0]) && texto(dir) && path.isAbsolute(dir)
    && texto(credencial) && path.isAbsolute(credencial) && typeof sistema === 'string' && FORMATO_SISTEMA.test(sistema)
    && prazos !== null && typeof prazos === 'object' && prazoValido(prazos.adquirirMs) && prazoValido(prazos.confirmarMs) && prazoValido(prazos.liberarMs) && prazoValido(prazos.encerrarMs)
    && typeof iniciarProcesso === 'function';
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
  let forcada = false;
  let nuncaIniciou = false;
  const esperandoSaida = [];

  const agora = () => new Date().toISOString();
  const desconhecido = (motivo) => ({ situacao: 'DESCONHECIDO', origem: `${ORIGEM}: ${motivo}`, consultadoEm: agora() });
  const responder = (mensagem) => { const p = pergunta; pergunta = null; if (p) p(mensagem); };
  // A garantia acabou: não há caminho de volta para ADQUIRIDA, e o processo é encerrado para a sessão cair.
  // Pede o encerramento forçado. Falha ao sinalizar não vira exceção: quem decide é a saída do processo, se chegar.
  const sinalizar = () => { try { if (vivo && processo) processo.matar(); } catch { /* sem sinal entregue */ } };
  const perder = () => {
    if (estado === 'ADQUIRIDA' || estado === 'AGUARDANDO') estado = 'PERDIDA';
    sinalizar();
  };
  const receber = (linha) => {
    let mensagem = null;
    try { mensagem = JSON.parse(linha); } catch { mensagem = null; }
    if (mensagem === null || typeof mensagem !== 'object' || Array.isArray(mensagem) || !EVENTOS.has(mensagem.evento)) mensagem = { evento: 'INVALIDA' };
    if (pergunta) { responder(mensagem); return; }
    if (estado === 'LIBERADA') { if (mensagem.evento === 'LIBERADA') liberacaoInformada = true; return; }
    // Mensagem que ninguém pediu (aviso de perda, resposta atrasada, linha estranha) encerra a garantia.
    if (estado === 'ADQUIRIDA') perder();
  };
  const saiu = (codigo, motivo) => {
    if (motivo === 'FALHA_AO_INICIAR') nuncaIniciou = true;
    vivo = false;
    if (estado === 'ADQUIRIDA' || estado === 'AGUARDANDO') estado = 'PERDIDA';
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

  async function adquirir() {
    if (estado !== 'NOVA') return { ok: false, motivo: 'GUARDIAO_JA_INICIADO' };
    estado = 'AGUARDANDO';
    try {
      processo = iniciarProcesso(comando[0], [...comando.slice(1), '--credencial', credencial, '--sistema', sistema], { cwd: dir });
      vivo = true;
      processo.aoReceberLinha(receber);
      processo.aoSair(saiu);
    } catch {
      estado = 'PERDIDA';
      return { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' };
    }
    const mensagem = await esperarMensagem(prazos.adquirirMs);
    const comCadeados = mensagem && Number.isInteger(mensagem.cadeados) && mensagem.cadeados > 0;
    if (mensagem && mensagem.evento === 'ADQUIRIDA' && comCadeados && vivo && estado === 'AGUARDANDO') { estado = 'ADQUIRIDA'; return { ok: true }; }
    if (mensagem && mensagem.evento === 'RECUSADA' && typeof mensagem.motivo === 'string' && FORMATO_MOTIVO.test(mensagem.motivo)) {
      if (OCUPACOES.has(mensagem.motivo)) { estado = 'OCUPADA'; ocupacao = mensagem.motivo; } else estado = 'PERDIDA';
      sinalizar();
      return { ok: false, motivo: mensagem.motivo };
    }
    perder();
    return { ok: false, motivo: 'GUARDIAO_INDISPONIVEL' };
  }

  // É esta a função que um provedor entrega ao instalador. Cada chamada faz uma pergunta nova ao guardião.
  function consultar() {
    const vez = fila.then(async () => {
      if (estado === 'OCUPADA') return { situacao: 'OCUPADO', origem: ORIGEM, consultadoEm: agora(), detalhe: ocupacao };
      if (estado !== 'ADQUIRIDA' || !vivo) return desconhecido(estado === 'NOVA' ? 'exclusão não adquirida' : 'exclusão não garantida');
      const id = crypto.randomBytes(16).toString('hex');
      const espera = esperarMensagem(prazos.confirmarMs);
      processo.escrever(`confirmar ${id}\n`);
      const mensagem = await espera;
      if (mensagem && mensagem.evento === 'CONFIRMADA' && mensagem.id === id && vivo && estado === 'ADQUIRIDA') return { situacao: 'LIVRE', origem: ORIGEM, consultadoEm: agora() };
      perder();
      return desconhecido('sem confirmação do guardião');
    });
    fila = vez.catch(() => {});
    return vez;
  }

  const situacaoDaLiberacao = () => {
    if (!processo || nuncaIniciou) return 'SEM_PROCESSO';
    if (vivo) return 'INDETERMINADA';
    return liberacaoInformada ? 'LIBERACAO_INFORMADA' : 'PROCESSO_ENCERRADO';
  };
  const resultadoDaLiberacao = () => ({ situacao: situacaoDaLiberacao(), processoEncerrado: !vivo, forcada, comprovadaNoBanco: false });

  // Chamadas repetidas recebem o mesmo resultado. Só o resultado indeterminado é refeito: a nova chamada sinaliza outra
  // vez e volta a esperar a saída.
  function liberar() {
    if (liberacao) return liberacao;
    const vez = fila.then(async () => {
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

  return { adquirir, consultar, liberar };
}

module.exports = { criarCoordenacaoPorGuardiao, iniciarProcessoReal, PRAZOS, ORIGEM };
