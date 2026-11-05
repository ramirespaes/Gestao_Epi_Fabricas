'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const S3 = require('../../src/services/backup-armazenamento-s3.service');
const V = require('../../src/services/backup-verificador-duravel.service');
const D = require('../../src/services/backup-baixador-duravel.service');
const Rb = require('../../src/services/backup-recibo-duravel.service');
const { criarValidadorDeDestinos } = require('../../src/services/imagem-backup-destinos.service');
const { criarS3Falso } = require('./s3-falso');
const { fichaDeTeste, registro } = require('./fichas-duraveis');

/** R-D45: ambiente de teste completo — S3 falso, ficha, registro de teste, enviador, verificador e baixador com os clientes dos papéis certos, e a publicação de um conjunto de arquivos sintéticos. */

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function ambienteS3({ ambiente = 'HOMOLOGACAO', config, bloco } = {}) {
  const reg = registro(fichaDeTeste('HOMOLOGACAO'), fichaDeTeste('PRODUCAO'));
  const ficha = reg.find((f) => f.ambiente === ambiente);
  let agora = 1_800_000_000_000;
  const relogio = () => agora;
  const s3 = criarS3Falso({ ficha, relogio, config, bloco });
  const base = { destinoId: ficha.id, ambiente, relogio, prazoMs: 1000, registro: reg };
  const enviador = (o = {}) => S3.criarEnviadorS3({ ...base, cliente: s3.clientes.publicador, ...o });
  const verificador = (o = {}) => V.criarVerificadorIndependente({ ...base, cliente: s3.clientes.verificador, ...o });
  /** `dl` vem de `destinoLocal`: o validador OFICIAL de destinos locais (registro de TESTE) que o baixador exige. */
  const baixador = (dl, o = {}) => D.criarBaixadorDuravel({ destinoId: ficha.id, ambiente, prazoMs: 1000, registro: reg, cliente: s3.clientes.restauracao, validadorDeDestinos: dl.validador, limites: { totalBytesMaximo: 2 ** 30 }, ...o });
  /** Destino local autorizado de TESTE: pasta 0700 real e canônica dentro de `pai`, registrada com a identidade (dev, ino) que ela tem. */
  function destinoLocal(pai, { id = 'restauracao-teste', nome = 'restauracoes' } = {}) {
    const caminho = path.join(fs.realpathSync(pai), nome);
    fs.mkdirSync(caminho, { mode: 0o700 });
    fs.chmodSync(caminho, 0o700);
    const st = fs.lstatSync(caminho);
    const registroLocal = { HOMOLOGACAO: ambiente === 'HOMOLOGACAO' ? [{ id, raiz: caminho, identidade: { dev: st.dev, ino: st.ino } }] : [], PRODUCAO: ambiente === 'PRODUCAO' ? [{ id, raiz: caminho, identidade: { dev: st.dev, ino: st.ino } }] : [] };
    return { id, raiz: caminho, identidade: { dev: st.dev, ino: st.ino }, registro: registroLocal, validador: criarValidadorDeDestinos({ ambiente, registro: registroLocal }) };
  }

  /** Publica `arquivos` (`[{ chave, conteudo }]`, chave relativa ao conjunto) e devolve o consolidado dos recibos. */
  async function publicar({ conjuntoId = 'c1', arquivos, raiz }) {
    const e = enviador();
    const pre = await e.executarPreVoo();
    if (!pre.ok) throw new Error('pré-voo reprovado no ambiente de teste');
    for (const a of arquivos) {
      const caminho = path.join(raiz, `pub-${crypto.randomBytes(6).toString('hex')}.bin`);
      fs.writeFileSync(caminho, a.conteudo, { mode: 0o600 });
      const r = await e.enviarArquivo({ caminho, chave: `${conjuntoId}/${a.chave}`, sha256: sha(a.conteudo), bytes: a.conteudo.length });
      if (r.estado !== 'GRAVADO') throw new Error(`envio falhou no ambiente de teste: ${r.motivo}`);
    }
    return Rb.consolidarRecibos({ destinoId: ficha.id, ambiente, conjuntoId, recibos: [...e.recibos()] });
  }

  return { ficha, reg, s3, relogio, avancar: (ms) => { agora += ms; }, enviador, verificador, baixador, destinoLocal, publicar };
}

module.exports = { ambienteS3, sha };
