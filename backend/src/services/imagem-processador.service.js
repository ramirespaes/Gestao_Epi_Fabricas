'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lerConfiguracao } = require('../config/imagens');
const { inspecionarContainer, ErroDeImagem, CODIGOS, PEDACOS_DE_METADADOS } = require('../utils/imagem-container');
const { lerQuadro } = require('../utils/imagem-quadro');
const { validarParametros, SECOES } = require('../utils/imagem-parametros');

/**
 * Processador REAL de imagens (Biblioteca de Imagens, Unidade 5C-4, decisões D-C5 e D-C6): implementa a porta `processar(bytes) -> { formato, largura, altura, mestre,
 * exibicao, miniatura }` usada por imagem-material-upload.service.js. A decodificação roda em um PROCESSO FILHO (workers/imagem-processador.worker.js):
 *  - recebe SÓ os bytes do envio (entrada padrão) e os parâmetros numéricos (um argumento JSON); ambiente mínimo e fixo, sem segredo da aplicação; sem shell; pasta neutra;
 *  - tem prazo externo: passado o prazo é morto com SIGKILL (não depende de cooperação do filho) e o processador só termina depois que o processo morreu;
 *  - sua resposta nunca é aceita sem conferência: quadro estrito, tetos, e cada variante reinspecionada (formato, medidas, metadados, nada depois do fim).
 * O que se recusa só pelos bytes (formato, animação, dimensões declaradas, arquivo cortado, poliglota perigoso) é recusado ANTES de iniciar o filho.
 * LIMITE: separar por processo contém uma falha nativa do decodificador, mas não é isolamento completo do sistema operacional (mesmo usuário, mesmo sistema de arquivos e rede).
 * Concorrência e fila são do semáforo do serviço de envio; este módulo cuida de um filho por chamada. Não está ligado ao app nesta unidade.
 */

const CAMINHO_DO_FILHO = path.join(__dirname, '..', 'workers', 'imagem-processador.worker.js');
const PRAZO_EXTERNO_PADRAO_MS = lerConfiguracao({}).processamento.tempo.externoMs;
const MEMORIA_DO_FILHO_MB = 192;
const ESPERA_PELA_MORTE_MS = 5000;
const FOLGA_DA_SAIDA_BYTES = 4096;
const SAIDA_RELOGIO_DO_FILHO = 124;
const SAIDA_SHARP_INDISPONIVEL = 3;

const erroInterno = (codigo) => Object.assign(new Error('falha no processamento de imagem'), { codigo });
const respostaInvalida = () => erroInterno('IMAGEM_FILHO_RESPOSTA_INVALIDA');

function parametrosDoProcessamento(config = lerConfiguracao(process.env), sobrescritas = {}) {
  if (sobrescritas === null || typeof sobrescritas !== 'object' || Array.isArray(sobrescritas)) throw new TypeError('sobrescritas dos parâmetros de imagem inválidas');
  const p = config.processamento;
  const base = {
    ladoMin: config.ladoMin,
    ladoMax: config.ladoMax,
    pixelsMax: config.pixelsMax,
    entradaMaxBytes: config.arquivoMaxBytes,
    timeoutSegundos: p.tempo.internoSegundos,
    mestre: { lado: p.mestre.lado, bytesMax: p.mestre.bytesMax },
    exibicao: { lado: config.exibicao.lado, bytesMax: p.exibicaoBytesMax },
    miniatura: { lado: config.miniatura.lado, bytesMax: config.miniatura.bytesMax },
  };
  const final = { ...base };
  for (const [chave, valor] of Object.entries(sobrescritas)) {
    if (!Object.hasOwn(base, chave)) throw new TypeError('sobrescrita de parâmetro de imagem desconhecida');
    if (SECOES.includes(chave)) {
      if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) throw new TypeError('sobrescrita de seção de parâmetros de imagem inválida');
      final[chave] = { ...base[chave], ...valor };
    } else {
      final[chave] = valor;
    }
  }
  return validarParametros(final);
}

/** Único ambiente que o filho recebe: nada do process.env da aplicação (nem NODE_OPTIONS). VIPS_BLOCK_UNTRUSTED é uma segunda trava contra carregadores não confiáveis. */
function ambienteDoFilho() {
  return Object.freeze({ PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(), UV_THREADPOOL_SIZE: '4', VIPS_BLOCK_UNTRUSTED: '1', MALLOC_ARENA_MAX: '2' });
}

function montarExecucaoDoFilho({ caminhoDoFilho = CAMINHO_DO_FILHO, parametros = parametrosDoProcessamento() } = {}) {
  return {
    comando: process.execPath,
    argumentos: [`--max-old-space-size=${MEMORIA_DO_FILHO_MB}`, '--disallow-code-generation-from-strings', caminhoDoFilho, JSON.stringify(parametros)],
    opcoes: { env: ambienteDoFilho(), cwd: os.tmpdir(), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false },
  };
}

function criarProcessadorDeImagens({
  parametros, caminhoDoFilho = CAMINHO_DO_FILHO, prazoExternoMs = PRAZO_EXTERNO_PADRAO_MS, spawnar = spawn, esperaPelaMorteMs = ESPERA_PELA_MORTE_MS,
} = {}) {
  const p = parametros === undefined ? parametrosDoProcessamento() : validarParametros(parametros);
  if (!Number.isSafeInteger(prazoExternoMs) || prazoExternoMs < 1) throw new TypeError('prazo externo do processador de imagens inválido');
  if (!Number.isSafeInteger(esperaPelaMorteMs) || esperaPelaMorteMs < 1) throw new TypeError('espera pela morte do filho inválida');
  if (typeof spawnar !== 'function') throw new TypeError('função de início de processo inválida');
  if (typeof caminhoDoFilho !== 'string' || !path.isAbsolute(caminhoDoFilho)) throw new TypeError('caminho do filho deve ser absoluto');
  const tetos = { mestreMax: p.mestre.bytesMax, exibicaoMax: p.exibicao.bytesMax, miniaturaMax: p.miniatura.bytesMax };
  const saidaMax = tetos.mestreMax + tetos.exibicaoMax + tetos.miniaturaMax + FOLGA_DA_SAIDA_BYTES;
  const limitesDeEntrada = { ladoMin: p.ladoMin, ladoMax: p.ladoMax, pixelsMax: p.pixelsMax };
  const ativos = new Set();

  function conferirVariantes(quadro) {
    if (quadro.largura !== p.mestre.lado || quadro.altura !== p.mestre.lado) throw respostaInvalida();
    for (const [nome, formato] of [['mestre', 'PNG'], ['exibicao', 'WEBP'], ['miniatura', 'WEBP']]) {
      const lado = p[nome].lado;
      let info;
      try { info = inspecionarContainer(quadro[nome], { ladoMin: lado, ladoMax: lado, pixelsMax: lado * lado }); } catch { throw respostaInvalida(); }
      if (info.formato !== formato || info.largura !== lado || info.altura !== lado || info.bytesExtras !== 0 || info.pedacos.some((pedaco) => PEDACOS_DE_METADADOS.has(pedaco))) throw respostaInvalida();
    }
  }

  function resultadoDoFilho(registro, codigo, sinal) {
    if (registro.encerradoPorMim) throw erroInterno('IMAGEM_FILHO_ENCERRADO');
    if (registro.excedeu) throw erroInterno('IMAGEM_FILHO_SAIDA_EXCESSIVA');
    if (registro.expirou) throw new ErroDeImagem(CODIGOS.TEMPO);
    if (sinal) throw erroInterno('IMAGEM_FILHO_SINAL');
    if (codigo === SAIDA_RELOGIO_DO_FILHO) throw new ErroDeImagem(CODIGOS.TEMPO);
    if (codigo === SAIDA_SHARP_INDISPONIVEL) throw erroInterno('IMAGENS_INDISPONIVEL');
    if (codigo !== 0) throw erroInterno('IMAGEM_FILHO_CODIGO_SAIDA');
    const quadro = lerQuadro(Buffer.concat(registro.partes), tetos);
    if (!quadro.ok) throw new ErroDeImagem(quadro.codigo);
    conferirVariantes(quadro);
    return { formato: quadro.formato, largura: quadro.largura, altura: quadro.altura, mestre: quadro.mestre, exibicao: quadro.exibicao, miniatura: quadro.miniatura };
  }

  function executarFilho(bytes) {
    return new Promise((resolver, rejeitar) => {
      const execucao = montarExecucaoDoFilho({ caminhoDoFilho, parametros: p });
      let filho;
      try { filho = spawnar(execucao.comando, execucao.argumentos, execucao.opcoes); } catch { rejeitar(erroInterno('IMAGENS_INDISPONIVEL')); return; }

      const registro = { filho, partes: [], total: 0, expirou: false, excedeu: false, encerradoPorMim: false, concluido: false, prazo: null, graca: null };
      registro.fim = new Promise((fim) => { registro.sinalizarFim = fim; });
      ativos.add(registro);

      const concluir = (acao) => {
        if (registro.concluido) return;
        registro.concluido = true;
        clearTimeout(registro.prazo);
        clearTimeout(registro.graca);
        ativos.delete(registro);
        registro.sinalizarFim();
        acao();
      };
      registro.matar = () => {
        try { filho.kill('SIGKILL'); } catch { /* já morto */ }
        if (registro.graca === null) {
          registro.graca = setTimeout(() => concluir(() => {
            try { resultadoDoFilho(registro, null, 'SIGKILL'); } catch (erro) { rejeitar(erro); }
          }), esperaPelaMorteMs);
        }
      };

      registro.prazo = setTimeout(() => { registro.expirou = true; registro.matar(); }, prazoExternoMs);
      filho.on('error', () => { if (filho.pid === undefined) concluir(() => rejeitar(erroInterno('IMAGENS_INDISPONIVEL'))); });
      if (filho.stdin) filho.stdin.on('error', () => {});
      if (filho.stderr) filho.stderr.on('data', () => {});
      if (filho.stdout) {
        filho.stdout.on('data', (bloco) => {
          if (registro.excedeu) return;
          registro.total += bloco.length;
          if (registro.total > saidaMax) { registro.excedeu = true; registro.partes = []; registro.matar(); return; }
          registro.partes.push(bloco);
        });
      }
      filho.once('close', (codigo, sinal) => concluir(() => {
        try { resolver(resultadoDoFilho(registro, codigo, sinal)); } catch (erro) { rejeitar(erro); }
      }));
      try { filho.stdin.end(bytes); } catch { /* quem decide é o 'close' */ }
    });
  }

  async function processar(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('os bytes da imagem devem ser um Buffer');
    if (bytes.length > p.entradaMaxBytes) throw new ErroDeImagem(CODIGOS.INVALIDA);
    inspecionarContainer(bytes, limitesDeEntrada);
    return executarFilho(bytes);
  }

  async function encerrarTodos() {
    const registros = [...ativos];
    for (const registro of registros) { registro.encerradoPorMim = true; registro.matar(); }
    await Promise.all(registros.map((registro) => registro.fim));
  }

  return Object.freeze({
    processar,
    encerrarTodos,
    ativos: () => [...ativos].map((registro) => registro.filho.pid).filter(Number.isInteger),
  });
}

module.exports = { criarProcessadorDeImagens, parametrosDoProcessamento, ambienteDoFilho, montarExecucaoDoFilho, CAMINHO_DO_FILHO, PRAZO_EXTERNO_PADRAO_MS };
