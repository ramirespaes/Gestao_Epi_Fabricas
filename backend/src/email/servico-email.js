'use strict';

const { normalizarEmail } = require('../utils/normalizacao');
const { emailConfig } = require('../config/email');
const { ErroEntrega, codigoDe } = require('./erros');
const { criarTransporte } = require('./transporte');

/**
 * Serviço único de e-mail transacional. Todo envio do sistema passa por aqui:
 *
 *   enviarAguardando  espera o transporte e devolve { estado, codigo? } sem
 *                     nunca lançar (convites: quem convidou precisa saber se
 *                     o e-mail saiu);
 *   enfileirar        entrega em segundo plano numa fila em memória limitada,
 *                     sem promessa e sem exceção para quem chama (recuperação
 *                     e aviso: a resposta pública não pode variar com a
 *                     entrega).
 *
 * Um envio nunca passa de limiteEnvioMs, mesmo que o transporte trave. A fila
 * tem teto de simultaneidade e de mensagens aceitas e ainda não terminadas
 * (filaMaxima): o excedente é descartado e contado.
 * O registro técnico leva só evento, tipo, escopo e um código seguro, com
 * amostragem para que um atacante não encha o log. Perder uma mensagem entre
 * o COMMIT e o envio é um risco aceito deste bloco (sem outbox durável).
 */

const ETIQUETA_DE_REGISTRO = '[entrega-email]';
const FORMATO_ETIQUETA = /^[A-Z][A-Z0-9_]{0,39}$/;
const JANELA_DE_REGISTRO_MS = 60_000;
const MAX_FALHAS_REGISTRADAS_POR_JANELA = 20;

const registroPadrao = (etiqueta, campos) => { console.error(etiqueta, campos); };

function etiquetaSegura(valor) {
  return typeof valor === 'string' && FORMATO_ETIQUETA.test(valor) ? valor : 'INVALIDO';
}

function comLimite(promessa, ms) {
  let relogio;
  const limite = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new ErroEntrega('ETIMEDOUT')), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(relogio));
}

function criarServicoEmail({
  transporte,
  registrar = registroPadrao,
  concorrencia = 2,
  filaMaxima = 100,
  limiteEnvioMs = 15_000,
  agora = Date.now,
}) {
  const fila = [];
  const ouvintes = new Set();
  let executando = 0;
  let emVoo = 0;
  let descartadas = 0;
  let parado = false;

  const falhas = { inicio: agora(), emitidas: 0, suprimidas: 0 };
  const filaCheia = { inicio: null, naJanela: 0 };

  const faltam = () => fila.length + executando + emVoo;
  const notificar = () => { for (const ouvinte of [...ouvintes]) ouvinte(); };

  function registrarFalha(mensagem, codigo) {
    const instante = agora();
    if (instante - falhas.inicio >= JANELA_DE_REGISTRO_MS) {
      if (falhas.suprimidas > 0) {
        registrar(ETIQUETA_DE_REGISTRO, { evento: 'entrega_falhou_suprimidas', suprimidas: falhas.suprimidas });
      }
      falhas.inicio = instante;
      falhas.emitidas = 0;
      falhas.suprimidas = 0;
    }
    if (falhas.emitidas >= MAX_FALHAS_REGISTRADAS_POR_JANELA) {
      falhas.suprimidas += 1;
      return;
    }
    falhas.emitidas += 1;
    registrar(ETIQUETA_DE_REGISTRO, {
      evento: 'entrega_falhou', tipo: etiquetaSegura(mensagem && mensagem.tipo), escopo: etiquetaSegura(mensagem && mensagem.escopo), codigo,
    });
  }

  function registrarDescarte() {
    descartadas += 1;
    const instante = agora();
    if (filaCheia.inicio === null || instante - filaCheia.inicio >= JANELA_DE_REGISTRO_MS) {
      const campos = { evento: 'fila_cheia', filaMaxima };
      if (filaCheia.naJanela > 0) campos.descartadasNaJanela = filaCheia.naJanela;
      registrar(ETIQUETA_DE_REGISTRO, campos);
      filaCheia.inicio = instante;
      filaCheia.naJanela = 0;
    }
    filaCheia.naJanela += 1;
  }

  /** Valida, entrega ao transporte sob o limite de tempo e devolve o desfecho. Nunca lança. */
  async function entregar(mensagem) {
    try {
      if (!mensagem || !FORMATO_ETIQUETA.test(mensagem.tipo) || !FORMATO_ETIQUETA.test(mensagem.escopo)
        || !mensagem.conteudo || ['assunto', 'texto', 'html'].some((c) => typeof mensagem.conteudo[c] !== 'string')) {
        throw new ErroEntrega('ENTRADA_INVALIDA');
      }
      const para = normalizarEmail(mensagem.para);
      if (para === null) {
        throw new ErroEntrega('DESTINATARIO_INVALIDO');
      }
      const { assunto, texto, html } = mensagem.conteudo;
      const resultado = await comLimite(
        Promise.resolve().then(() => transporte.enviar({ tipo: mensagem.tipo, escopo: mensagem.escopo, para, assunto, texto, html })),
        limiteEnvioMs,
      );
      return { estado: resultado.estado };
    } catch (erro) {
      const codigo = codigoDe(erro);
      registrarFalha(mensagem, codigo);
      return { estado: 'FALHA', codigo };
    }
  }

  async function enviarAguardando(mensagem) {
    if (parado) {
      return { estado: 'FALHA', codigo: 'SERVICO_ENCERRANDO' };
    }
    emVoo += 1;
    try {
      return await entregar(mensagem);
    } finally {
      emVoo -= 1;
      notificar();
    }
  }

  function processar() {
    while (executando < concorrencia && fila.length > 0) {
      const mensagem = fila.shift();
      executando += 1;
      entregar(mensagem).then(() => {
        executando -= 1;
        processar();
        notificar();
      });
    }
  }

  function enfileirar(mensagem) {
    if (parado || fila.length + executando >= filaMaxima) {
      if (parado) descartadas += 1;
      else registrarDescarte();
      return undefined;
    }
    fila.push(mensagem);
    // Quem enfileira nunca recebe a entrega: ela começa só depois desta chamada.
    queueMicrotask(processar);
    return undefined;
  }

  function aguardarOciosidade(limiteMs = Infinity) {
    if (faltam() === 0) {
      return Promise.resolve({ pendentes: 0 });
    }
    return new Promise((resolver) => {
      let relogio = null;
      const ouvinte = () => {
        if (faltam() === 0) {
          clearTimeout(relogio);
          ouvintes.delete(ouvinte);
          resolver({ pendentes: 0 });
        }
      };
      ouvintes.add(ouvinte);
      if (Number.isFinite(limiteMs)) {
        relogio = setTimeout(() => {
          ouvintes.delete(ouvinte);
          resolver({ pendentes: faltam() });
        }, limiteMs);
      }
    });
  }

  return {
    enviarAguardando,
    enfileirar,
    aguardarOciosidade,
    parar() { parado = true; },
    estado: () => ({ executando, pendentes: fila.length, descartadas, parado }),
    async fechar() {
      parado = true;
      transporte.fechar();
    },
  };
}

let padrao = null;

/** Serviço da aplicação, criado no primeiro uso com a configuração carregada do ambiente. */
function servicoPadrao() {
  if (padrao === null) {
    padrao = criarServicoEmail({ transporte: criarTransporte(emailConfig) });
  }
  return padrao;
}

module.exports = { criarServicoEmail, servicoPadrao };
