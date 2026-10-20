'use strict';

const { CODIGOS } = require('./imagem-container');

/**
 * O QUADRO (Biblioteca de Imagens, Unidade 5C-4): o formato binário em que o processo filho do decodificador devolve o resultado ao processo da API pela saída padrão.
 *
 *   'GIMG' | versão (1 byte, =1) | tamanho do JSON (4 bytes, big-endian) | JSON | mestre | exibição | miniatura
 *
 * Sucesso: {"ok":true,"formato":"PNG","largura":L,"altura":A,"tamanhos":[mestre,exibição,miniatura]} seguido das três cargas, na ordem. Recusa: {"ok":false,"codigo":"IMAGEM_..."}
 * sem carga. Quem LÊ (o lado da API) não confia em nada: confere magia, versão, tamanho do JSON, chaves exatas, tipos, tamanhos, tetos, soma exata dos bytes e o código de
 * recusa contra a lista combinada. Qualquer violação é o MESMO erro interno (IMAGEM_FILHO_RESPOSTA_INVALIDA), de mensagem fixa: nada do conteúdo recebido é repetido.
 * Função pura: sem arquivo, rede nem ambiente.
 */

const MAGIA = Buffer.from('GIMG', 'ascii');
const VERSAO = 1;
const CABECALHO = 9;
const JSON_MAXIMO = 1024;
const LADO_MAXIMO = 65535;
const CODIGOS_DE_RECUSA = Object.freeze(Object.values(CODIGOS));

const respostaInvalida = () => Object.assign(new Error('resposta inválida do processo filho de imagens'), { codigo: 'IMAGEM_FILHO_RESPOSTA_INVALIDA' });
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const mesmasChaves = (objeto, chaves) => {
  const reais = Object.keys(objeto).sort();
  return reais.length === chaves.length && reais.every((c, i) => c === [...chaves].sort()[i]);
};

function montar(objeto, ...cargas) {
  const json = Buffer.from(JSON.stringify(objeto), 'utf8');
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(json.length);
  return Buffer.concat([MAGIA, Buffer.from([VERSAO]), tamanho, json, ...cargas]);
}

function serializarSucesso({ formato, largura, altura, mestre, exibicao, miniatura } = {}) {
  if (formato !== 'PNG') throw new TypeError('o mestre do quadro é sempre PNG');
  if (!inteiroPositivo(largura) || !inteiroPositivo(altura) || largura > LADO_MAXIMO || altura > LADO_MAXIMO) throw new TypeError('medidas do quadro inválidas');
  for (const carga of [mestre, exibicao, miniatura]) if (!Buffer.isBuffer(carga) || carga.length === 0) throw new TypeError('as cargas do quadro devem ser Buffers não vazios');
  return montar({ ok: true, formato, largura, altura, tamanhos: [mestre.length, exibicao.length, miniatura.length] }, mestre, exibicao, miniatura);
}

function serializarRecusa(codigo) {
  if (typeof codigo !== 'string' || !CODIGOS_DE_RECUSA.includes(codigo)) throw new TypeError('código de recusa fora da lista combinada');
  return montar({ ok: false, codigo });
}

function lerQuadro(buffer, tetos) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('o quadro deve ser um Buffer');
  if (tetos === null || typeof tetos !== 'object' || !inteiroPositivo(tetos.mestreMax) || !inteiroPositivo(tetos.exibicaoMax) || !inteiroPositivo(tetos.miniaturaMax)) throw new TypeError('tetos do quadro inválidos');
  if (buffer.length < CABECALHO || !buffer.subarray(0, 4).equals(MAGIA) || buffer[4] !== VERSAO) throw respostaInvalida();
  const tamanhoJson = buffer.readUInt32BE(5);
  if (tamanhoJson === 0 || tamanhoJson > JSON_MAXIMO || CABECALHO + tamanhoJson > buffer.length) throw respostaInvalida();
  let objeto;
  try { objeto = JSON.parse(buffer.toString('utf8', CABECALHO, CABECALHO + tamanhoJson)); } catch { throw respostaInvalida(); }
  if (objeto === null || typeof objeto !== 'object' || Array.isArray(objeto)) throw respostaInvalida();
  const inicio = CABECALHO + tamanhoJson;

  if (objeto.ok === false) {
    if (!mesmasChaves(objeto, ['ok', 'codigo']) || typeof objeto.codigo !== 'string' || !CODIGOS_DE_RECUSA.includes(objeto.codigo) || buffer.length !== inicio) throw respostaInvalida();
    return { ok: false, codigo: objeto.codigo };
  }

  if (objeto.ok !== true || !mesmasChaves(objeto, ['ok', 'formato', 'largura', 'altura', 'tamanhos'])) throw respostaInvalida();
  const { formato, largura, altura, tamanhos } = objeto;
  if (formato !== 'PNG' || !inteiroPositivo(largura) || !inteiroPositivo(altura) || largura > LADO_MAXIMO || altura > LADO_MAXIMO) throw respostaInvalida();
  if (!Array.isArray(tamanhos) || tamanhos.length !== 3 || !tamanhos.every(inteiroPositivo)) throw respostaInvalida();
  const [m, e, i] = tamanhos;
  if (m > tetos.mestreMax || e > tetos.exibicaoMax || i > tetos.miniaturaMax || buffer.length !== inicio + m + e + i) throw respostaInvalida();
  return {
    ok: true,
    formato,
    largura,
    altura,
    mestre: Buffer.from(buffer.subarray(inicio, inicio + m)),
    exibicao: Buffer.from(buffer.subarray(inicio + m, inicio + m + e)),
    miniatura: Buffer.from(buffer.subarray(inicio + m + e)),
  };
}

module.exports = { serializarSucesso, serializarRecusa, lerQuadro, CODIGOS_DE_RECUSA };
