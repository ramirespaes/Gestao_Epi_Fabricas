'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const { lerConfiguracao } = require('../config/imagens');
const { chaveDe, criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { criarSemaforo, ErroDeSemaforo } = require('../utils/semaforo');
const imagemMaterialService = require('./imagem-material.service');

/**
 * Envio (upload) de imagem da biblioteca da empresa (Biblioteca de Imagens, Unidade 5C-2).
 *
 *   enviar(pool, { empresaId, atorId, nome, bytes: Buffer, ip, dispositivo }) -> { imagem, reaproveitada }
 *
 * Recebe os bytes enviados, pede ao PROCESSADOR (porta injetada) o mestre saneado e as duas derivadas, grava as três variantes no ARMAZENAMENTO
 * e registra a linha pela persistência que já existe (`registrarEmpresa`: trava da biblioteca, deduplicação por SHA-256, cota, INSERT e auditoria).
 * AUTORIZAÇÃO NÃO MORA AQUI (é do middleware da rota); o isolamento sim: empresa e ator vêm do contexto da sessão, nunca de quem enviou.
 *
 * O PROCESSADOR é uma porta: `processar(bytes) -> { formato: 'PNG'|'JPEG'|'WEBP', largura, altura, mestre, exibicao, miniatura }` (três Buffers), ou
 * rejeita com um Error cujo `codigo` é um destes: IMAGEM_FORMATO_NAO_SUPORTADO, IMAGEM_ANIMADA_NAO_SUPORTADA, IMAGEM_INVALIDA, IMAGEM_DIMENSOES_INVALIDAS,
 * IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO e IMAGEM_SAIDA_EXCEDE_LIMITE (recusas públicas), ou IMAGENS_INDISPONIVEL (503); qualquer outra falha é inesperada: 500 genérico.
 * O processador REAL (processo filho com sharp, Unidade 5C-4) existe, mas o app AINDA NÃO o liga (isso é da integração controlada): sem processador, o envio responde
 * 503 IMAGENS_INDISPONIVEL antes de ler qualquer coisa. O processador FALSO dos testes nunca é importado por src/.
 * FILA (5C-4): o semáforo tem fila máxima e espera máxima (config.processamento.fila); sem vaga ou sem paciência o envio responde 503 IMAGENS_OCUPADO com Retry-After,
 * antes de qualquer conexão com o banco.
 *
 * ORDEM E TRAVAS (decisão D-C2, aprovada): (1) a decodificação, que é a operação cara, roda FORA de qualquer transação e de qualquer trava, limitada a
 * N simultâneas por processo (semáforo; configuração IMAGENS_PROCESSAMENTOS_SIMULTANEOS); (2) a gravação dos três arquivos acontece DENTRO da seção
 * crítica que `registrarEmpresa` já protege com a trava DA EMPRESA (advisory, uma só aquisição, na mesma transação e conexão: o gancho
 * `antesDeInserir` não toma trava nenhuma, então não há aquisição recursiva nem deadlock), depois da deduplicação e da cota e antes do INSERT. Assim:
 *   - conteúdo já existente ou cota esgotada não gravam arquivo algum (nada de órfão por recusa);
 *   - NUNCA existe registro sem os três arquivos (se uma gravação falha, a transação é desfeita: nenhuma linha, nenhuma auditoria);
 *   - dois envios simultâneos do mesmo conteúdo se serializam na trava da empresa: um registra, o outro devolve a imagem existente.
 * A trava só é segurada durante a gravação de três arquivos pequenos, com tempo máximo (AbortSignal); a decodificação nunca está sob ela.
 *
 * ARQUIVOS (D-C3): o layout das chaves é <empresa>/<SHA-256 do ENVIO>/mestre.<ext>, exibicao.webp, miniatura.webp, o mesmo que a entrega lê e verifica.
 * O armazenamento nunca sobrescreve: gravar a mesma chave com o mesmo conteúdo é reaproveitado, com outro conteúdo é erro. Este serviço NUNCA remove
 * arquivo (nem na falha, nem no reenvio): uma falha parcial pode deixar arquivo sem registro (órfão), jamais apagar arquivo que um registro válido use. A
 * limpeza de órfãos é rotina própria, com idade mínima e reconferência sob a trava, em etapa posterior.
 */

const MSG = Object.freeze({
  INDISPONIVEL: 'Imagens indisponíveis',
  FORMATO: 'Formato de imagem não suportado: envie PNG, JPEG ou WebP',
  ANIMADA: 'Imagens animadas não são suportadas',
  INVALIDA: 'A imagem está corrompida ou não pôde ser lida',
  GRANDE: 'Corpo da requisição excede o tamanho máximo permitido',
  OCUPADO: 'Muitas imagens estão sendo processadas; tente novamente em instantes',
  TEMPO: 'A imagem não pôde ser processada no tempo máximo permitido; tente uma imagem menor ou mais simples',
  SAIDA: 'A imagem é complexa demais para os limites de armazenamento; reduza as dimensões ou simplifique a imagem',
});

// Tetos de DEFESA EM PROFUNDIDADE das variantes que o processador devolve: o processador real já respeita mestre 4 MiB, exibição 512 KiB e miniatura 64 KiB
// (config.processamento); aqui a exibição aceita até 1 MiB, o máximo que a entrega lê. Acima disso a saída é recusada ANTES de qualquer gravação.
const TETO_MESTRE_BYTES = 4 * 1024 * 1024;
const TETO_EXIBICAO_BYTES = 1024 * 1024;
// Tempo máximo da gravação dos três arquivos sob a trava da empresa; passado o prazo o armazenamento aborta e a transação é desfeita.
const TEMPO_MAXIMO_DA_GRAVACAO_MS = 30000;

const sha256Hex = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function criarUploadDeImagens({ armazenamento = null, processador = null, semaforo = null } = {}) {
  if (armazenamento !== null && typeof armazenamento.gravar !== 'function') throw new TypeError('armazenamento de imagens inválido');
  if (processador !== null && typeof processador.processar !== 'function') throw new TypeError('processador de imagens inválido');
  const config = lerConfiguracao(process.env);
  const { fila } = config.processamento;
  const limitador = semaforo ?? criarSemaforo(config.processamentosSimultaneos, { filaMaxima: fila.maxima, esperaMaximaMs: fila.esperaMaximaMs });

  const recusas = Object.freeze({
    IMAGEM_FORMATO_NAO_SUPORTADO: { status: 415, mensagem: MSG.FORMATO },
    IMAGEM_ANIMADA_NAO_SUPORTADA: { status: 415, mensagem: MSG.ANIMADA },
    IMAGEM_INVALIDA: { status: 400, mensagem: MSG.INVALIDA },
    IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO: { status: 422, mensagem: MSG.TEMPO },
    IMAGEM_SAIDA_EXCEDE_LIMITE: { status: 422, mensagem: MSG.SAIDA },
    IMAGEM_DIMENSOES_INVALIDAS: {
      status: 400,
      mensagem: `Dimensões da imagem fora do permitido: lado de ${config.ladoMin} a ${config.ladoMax} pixels e até ${Math.floor(config.pixelsMax / 1000000)} megapixels`,
    },
  });

  const indisponivel = () => new HttpError(503, 'IMAGENS_INDISPONIVEL', MSG.INDISPONIVEL);
  const formatoNaoSuportado = () => new HttpError(415, 'IMAGEM_FORMATO_NAO_SUPORTADO', MSG.FORMATO);
  const ocupado = (codigoDoSemaforo) => new HttpError(503, 'IMAGENS_OCUPADO', MSG.OCUPADO, {
    headers: { 'Retry-After': String(codigoDoSemaforo === 'SEMAFORO_FILA_CHEIA' ? fila.retryAfterFilaCheiaSegundos : fila.retryAfterEsperaSegundos) },
  });

  /** Decodifica fora de trava e de transação. Recusa conhecida vira HttpError público e genérico; qualquer outra falha, 500 sem vazar a mensagem. */
  async function processar(bytes) {
    try {
      return await limitador.executar(() => processador.processar(bytes));
    } catch (falha) {
      if (falha instanceof ErroDeSemaforo) throw ocupado(falha.codigo);
      const codigo = falha !== null && typeof falha === 'object' ? falha.codigo : undefined;
      if (typeof codigo === 'string' && Object.hasOwn(recusas, codigo)) {
        throw new HttpError(recusas[codigo].status, codigo, recusas[codigo].mensagem);
      }
      if (codigo === 'IMAGENS_INDISPONIVEL') throw indisponivel();
      throw HttpError.internal(falha);
    }
  }

  /** O que o processador devolveu precisa caber na biblioteca; senão é defeito do processador (500), nunca uma imagem registrada pela metade. */
  function validarSaida(saida) {
    const defeituosa = () => HttpError.internal(new TypeError('saída inválida do processador de imagens'));
    if (saida === null || typeof saida !== 'object') throw defeituosa();
    const { formato, largura, altura, mestre, exibicao, miniatura } = saida;
    if (!config.formatosAceitos.includes(formato)) throw defeituosa();
    for (const lado of [largura, altura]) {
      if (!Number.isInteger(lado) || lado < config.ladoMin || lado > config.ladoMax) throw defeituosa();
    }
    if (largura * altura > config.pixelsMax) throw defeituosa();
    const tetos = [[mestre, TETO_MESTRE_BYTES], [exibicao, TETO_EXIBICAO_BYTES], [miniatura, config.miniatura.bytesMax]];
    for (const [conteudo, teto] of tetos) {
      if (!Buffer.isBuffer(conteudo) || conteudo.length === 0 || conteudo.length > teto) throw defeituosa();
    }
    return { formato, largura, altura, mestre, exibicao, miniatura };
  }

  /** Grava as três variantes (o mestre leva a extensão do formato; as derivadas são sempre .webp). Chamada SOB a trava da empresa, antes do INSERT. */
  async function gravarVariantes({ empresaId, shaEnvio, formato, variantes }) {
    const sinal = AbortSignal.timeout(TEMPO_MAXIMO_DA_GRAVACAO_MS);
    const destinos = [
      ['mestre', formato, variantes.mestre, TETO_MESTRE_BYTES],
      ['exibicao', 'WEBP', variantes.exibicao, TETO_EXIBICAO_BYTES],
      ['miniatura', 'WEBP', variantes.miniatura, config.miniatura.bytesMax],
    ];
    for (const [variante, formatoDaChave, conteudo, maxBytes] of destinos) {
      const chave = chaveDe({ escopo: 'EMPRESA', empresaId, sha256: shaEnvio, variante, formato: formatoDaChave });
      await armazenamento.gravar(chave, conteudo, { maxBytes, sha256Esperado: sha256Hex(conteudo), signal: sinal });
    }
  }

  async function enviar(pool, {
    empresaId, atorId, nome, bytes, ip = null, dispositivo = null,
  }) {
    exigirId(empresaId, 'identificador de empresa');
    exigirId(atorId, 'identificador de ator');
    // Falha fechada: sem armazenamento ou sem processador definitivo nada é lido, decodificado, gravado nem registrado.
    if (armazenamento === null || processador === null) throw indisponivel();
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw formatoNaoSuportado();
    if (bytes.length > config.arquivoMaxBytes) throw new HttpError(413, 'PAYLOAD_MUITO_GRANDE', MSG.GRANDE);

    const shaEnvio = sha256Hex(bytes);
    const { formato, largura, altura, mestre, exibicao, miniatura } = validarSaida(await processar(bytes));
    const descritor = {
      sha256: shaEnvio,
      sha256Mestre: sha256Hex(mestre),
      sha256Exibicao: sha256Hex(exibicao),
      sha256Miniatura: sha256Hex(miniatura),
      formato,
      largura,
      altura,
      bytesMestre: mestre.length,
      bytesExibicao: exibicao.length,
      bytesMiniatura: miniatura.length,
    };

    return imagemMaterialService.registrarEmpresa(pool, {
      empresaId,
      atorId,
      nome,
      imagem: descritor,
      ip,
      dispositivo,
      antesDeInserir: () => gravarVariantes({ empresaId, shaEnvio, formato, variantes: { mestre, exibicao, miniatura } }),
    });
  }

  return Object.freeze({ enviar });
}

/**
 * O serviço de envio com o armazenamento do AMBIENTE (IMAGENS_ARMAZENAMENTO_DIRETORIO), no mesmo molde de `criarEntregaDoAmbiente`: sem diretório
 * configurado o armazenamento é nulo e o envio responde 503. Diretório inválido falha cedo, sem ecoar o valor. O processador é sempre explícito.
 */
function criarUploadDoAmbiente({ processador = null, origem = process.env } = {}) {
  const { diretorio } = lerConfiguracao(origem);
  const armazenamento = diretorio === null ? null : criarArmazenamentoImagens({ diretorio });
  return criarUploadDeImagens({ armazenamento, processador });
}

module.exports = { criarUploadDeImagens, criarUploadDoAmbiente };
