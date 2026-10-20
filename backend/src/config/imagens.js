'use strict';

const path = require('node:path');

/**
 * Configuração das imagens de produto (Biblioteca de Imagens, Unidade 1).
 *
 * `lerConfiguracao(origem)` é função PURA da origem recebida (normalmente process.env): não lê nem altera o ambiente.
 * Só cotas, taxas e o semáforo de processamento são ajustáveis, dentro de piso e teto; os limites de arquivo, lado, pixels e
 * derivadas são fixos e variáveis de ambiente sobre eles são ignoradas. O diretório vem SÓ do ambiente; ausente deixa o recurso
 * indisponível. Mensagens de erro nomeiam a variável e nunca levam o valor recebido.
 *
 * Entrega de imagens (Unidade 5A-1): `entregasPorMinutoIp` é o limite por IP da rota de entrega (ajustável) e `entregaCorp` a política
 * Cross-Origin-Resource-Policy da imagem entregue: `same-origin` (padrão e único valor aceito em production) ou `same-site`, só fora de
 * production, para o frontend e a API em portas diferentes do mesmo site no desenvolvimento local.
 *
 * Processamento (Unidade 5C-4, decisões D-C5 e D-C6 aprovadas): a seção `processamento` traz os valores FIXOS do processador de imagens — mestre PNG de referência
 * 1024 x 1024 com teto de 4 MiB, teto de 512 KiB para a exibição (a miniatura usa `miniatura.bytesMax`), fila de 8 esperando, espera máxima de 10 s, Retry-After de 5 s
 * (fila cheia) e de 10 s (espera esgotada), tempo interno de processamento de 10 s e prazo externo de 15 s para o processo filho. Nenhuma variável de ambiente os altera;
 * só `IMAGENS_PROCESSAMENTOS_SIMULTANEOS` (processamentos simultâneos, padrão 2) continua ajustável.
 */

const MIB = 1024 * 1024;
const DECIMAL = /^[0-9]+$/;

const AJUSTAVEIS = [
  { variavel: 'IMAGENS_COTA_IMAGENS', campo: 'cotaImagens', padrao: 300, piso: 10, teto: 5000, converter: (n) => n },
  { variavel: 'IMAGENS_COTA_MIB', campo: 'cotaBytes', padrao: 300 * MIB, piso: 10, teto: 10240, converter: (n) => n * MIB },
  { variavel: 'IMAGENS_ENVIOS_POR_MINUTO_USUARIO', campo: 'envioPorMinutoUsuario', padrao: 10, piso: 1, teto: 60, converter: (n) => n },
  { variavel: 'IMAGENS_ENVIOS_POR_HORA_EMPRESA', campo: 'envioPorHoraEmpresa', padrao: 60, piso: 10, teto: 1000, converter: (n) => n },
  { variavel: 'IMAGENS_ENTREGAS_POR_MINUTO_IP', campo: 'entregasPorMinutoIp', padrao: 600, piso: 1, teto: 100000, converter: (n) => n },
  { variavel: 'IMAGENS_PROCESSAMENTOS_SIMULTANEOS', campo: 'processamentosSimultaneos', padrao: 2, piso: 1, teto: 8, converter: (n) => n },
];

const VARIAVEL_DIRETORIO = 'IMAGENS_ARMAZENAMENTO_DIRETORIO';
const configuracoesProduzidas = new WeakSet();

function erro(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { codigo });
}

function lerInteiro(origem, { variavel, piso, teto }) {
  const bruto = origem[variavel];
  if (bruto === undefined || bruto === null) return undefined;
  const texto = String(bruto).trim();
  if (texto === '') return undefined;
  const numero = DECIMAL.test(texto) && texto.length <= 6 ? Number(texto) : NaN;
  if (!Number.isSafeInteger(numero) || numero < piso || numero > teto) {
    throw erro('IMAGENS_CONFIGURACAO_INVALIDA', `${variavel}: deve ser um inteiro decimal entre ${piso} e ${teto}`);
  }
  return numero;
}

const VARIAVEL_CORP = 'IMAGENS_ENTREGA_CORP';
const POLITICAS_CORP = Object.freeze(['same-origin', 'same-site']);

function lerCorp(origem) {
  const bruto = origem[VARIAVEL_CORP];
  const texto = bruto === undefined || bruto === null ? '' : String(bruto).trim();
  if (texto === '') return 'same-origin';
  if (!POLITICAS_CORP.includes(texto)) throw erro('IMAGENS_CONFIGURACAO_INVALIDA', `${VARIAVEL_CORP}: deve ser same-origin ou same-site`);
  if (texto === 'same-site' && origem.NODE_ENV === 'production') throw erro('IMAGENS_CONFIGURACAO_INVALIDA', `${VARIAVEL_CORP}: same-site não é permitido em production`);
  return texto;
}

function lerDiretorio(origem) {
  const bruto = origem[VARIAVEL_DIRETORIO];
  if (typeof bruto !== 'string' || bruto.trim() === '') return null;
  let diretorio = bruto.trim();
  if (diretorio.length > 1 && diretorio.endsWith('/')) diretorio = diretorio.slice(0, -1);
  const invalido = diretorio.includes('\0') || !path.isAbsolute(diretorio) || path.resolve(diretorio) !== diretorio || diretorio === path.parse(diretorio).root;
  if (invalido) throw erro('IMAGENS_DIRETORIO_INVALIDO', `${VARIAVEL_DIRETORIO}: deve ser um caminho absoluto, canônico e diferente da raiz do sistema`);
  return diretorio;
}

function lerConfiguracao(origem = process.env) {
  const fonte = origem && typeof origem === 'object' ? origem : {};
  const ajustados = {};
  for (const regra of AJUSTAVEIS) {
    const lido = lerInteiro(fonte, regra);
    ajustados[regra.campo] = lido === undefined ? regra.padrao : regra.converter(lido);
  }
  if (ajustados.envioPorHoraEmpresa < ajustados.envioPorMinutoUsuario) {
    throw erro('IMAGENS_CONFIGURACAO_INVALIDA', 'IMAGENS_ENVIOS_POR_HORA_EMPRESA: não pode ser menor que IMAGENS_ENVIOS_POR_MINUTO_USUARIO');
  }
  const configuracao = Object.freeze({
    arquivoMaxBytes: 2 * MIB,
    arquivoPadraoMaxBytes: 5 * MIB,
    ladoMin: 320,
    ladoMax: 4096,
    pixelsMax: 8388608,
    miniatura: Object.freeze({ lado: 320, formato: 'webp', bytesMax: 65536 }),
    exibicao: Object.freeze({ lado: 640, formato: 'webp' }),
    ampliar: false,
    processamento: Object.freeze({
      mestre: Object.freeze({ lado: 1024, formato: 'png', bytesMax: 4 * MIB }),
      exibicaoBytesMax: 512 * 1024,
      fila: Object.freeze({ maxima: 8, esperaMaximaMs: 10000, retryAfterFilaCheiaSegundos: 5, retryAfterEsperaSegundos: 10 }),
      tempo: Object.freeze({ internoSegundos: 10, externoMs: 15000 }),
    }),
    ...ajustados,
    loteMaximo: 10,
    nome: Object.freeze({ min: 1, max: 100 }),
    formatosAceitos: Object.freeze(['PNG', 'JPEG', 'WEBP']),
    entregaCorp: lerCorp(fonte),
    diretorio: lerDiretorio(fonte),
  });
  configuracoesProduzidas.add(configuracao);
  return configuracao;
}

/** Devolve o diretório de uma configuração produzida por lerConfiguracao; sem diretório (ou configuração estranha) o recurso está indisponível. */
function exigirDiretorio(configuracao) {
  if (!configuracao || typeof configuracao !== 'object' || !configuracoesProduzidas.has(configuracao) || typeof configuracao.diretorio !== 'string') {
    throw erro('IMAGENS_INDISPONIVEL', `${VARIAVEL_DIRETORIO}: armazenamento de imagens não configurado`);
  }
  return configuracao.diretorio;
}

module.exports = { lerConfiguracao, exigirDiretorio };
