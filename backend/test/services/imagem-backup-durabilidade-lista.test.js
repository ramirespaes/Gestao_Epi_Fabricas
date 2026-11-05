'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../src/services/imagem-backup-durabilidade.service');
const K = require('../../src/services/backup-fontes-custodia-chaves.service');
const { registroDeTeste, registro, fichaDeTeste } = require('../helpers/fichas-duraveis');

/** R-D45 [LST]: a lista de armazenamentos duráveis tem UM formato e UMA função de localização, usada pela criação do destino e pela autorização de envio. */

const SHA = 'a'.repeat(64);
const CONTAINER = { ok: true, sha256Envelope: SHA };
const eco = async (p) => ({ confirmado: true, ...p });
const SRC = path.join(__dirname, '..', '..', 'src');
const semComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

describe('[LST] lista vazia: comportamento anterior preservado', () => {
  test('LST-01 — lista real vazia e congelada; localização, criação e autorização recusam como antes', () => {
    assert.deepEqual([...D.ARMAZENAMENTOS_DURAVEIS_APROVADOS], []);
    assert.equal(Object.isFrozen(D.ARMAZENAMENTOS_DURAVEIS_APROVADOS), true);
    assert.deepEqual({ ...D.localizarArmazenamentoDuravel('hml-s3-principal', 'HOMOLOGACAO') }, { encontrada: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
    assert.deepEqual({ ...K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO' }) }, { autorizado: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => D.criarDestinoDuravel({ id: 'hml-s3-principal', adaptador: { confirmar: eco }, prazoMs: 100 }), (e) => e.code === 'ARMAZENAMENTO_DURAVEL_NAO_APROVADO');
    } finally { process.env.NODE_ENV = antes; }
  });
});

describe('[LST] as duas funções concordam, com um registro de teste', () => {
  const lista = registroDeTeste();

  test('LST-02 — id e ambiente corretos: criação do destino (origem de TESTE, nunca operacional) e autorização de envio (origem de TESTE)', async () => {
    const destino = D.criarDestinoDuravel({ id: 'hml-s3-principal', adaptador: { confirmar: eco }, prazoMs: 100, registro: lista });
    assert.equal(destino.origem, 'TESTE_CONTROLADO');
    const confirmacao = await destino.confirmarGravacao({ chave: 'hml/c1/envelope.json', sha256: SHA, bytes: 10 });
    assert.deepEqual([confirmacao.confirmado, confirmacao.operacional], [true, false]);
    assert.deepEqual({ ...K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', registro: lista }) }, { autorizado: true, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', origem: 'TESTE_CONTROLADO' });
  });

  test('LST-03 — ambiente divergente e id desconhecido: motivos fixos, iguais na localização e na autorização (tabela de combinações)', () => {
    const ids = ['hml-s3-principal', 'prod-s3-principal', 'nao-existe'];
    for (const id of ids) {
      for (const ambiente of ['HOMOLOGACAO', 'PRODUCAO']) {
        const achado = D.localizarArmazenamentoDuravel(id, ambiente, lista);
        const autor = K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: id, ambiente, registro: lista });
        assert.equal(autor.autorizado, achado.encontrada, `${id}/${ambiente}`);
        if (!achado.encontrada) assert.equal(autor.motivo, achado.motivo, `${id}/${ambiente}`);
      }
    }
    assert.equal(K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'PRODUCAO', registro: lista }).motivo, 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE');
    assert.equal(K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'prod-s3-principal', ambiente: 'HOMOLOGACAO', registro: lista }).motivo, 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE');
    assert.equal(K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'prod-s3-principal', ambiente: 'PRODUCAO', registro: lista }).autorizado, true);
  });

  test('LST-04 — as validações anteriores continuam valendo: contêiner não cifrado e ambiente inválido vêm antes da lista', () => {
    assert.deepEqual({ ...K.autorizarEnvioDuravel({ containerCifrado: { ok: false }, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', registro: lista }) }, { autorizado: false, motivo: 'CONTAINER_NAO_CIFRADO' });
    assert.deepEqual({ ...K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'CI', registro: lista }) }, { autorizado: false, motivo: 'AMBIENTE_INVALIDO' });
  });
});

describe('[LST] formato único e fora de produção', () => {
  test('LST-05 — o formato antigo (texto simples) é recusado pela localização, pela criação e pela autorização', () => {
    const antigo = Object.freeze(['hml-s3-principal']);
    const recusa = (e) => e.code === 'REGISTRO_DURAVEL_INVALIDO';
    assert.throws(() => D.localizarArmazenamentoDuravel('hml-s3-principal', 'HOMOLOGACAO', antigo), recusa);
    assert.throws(() => D.criarDestinoDuravel({ id: 'hml-s3-principal', adaptador: { confirmar: eco }, prazoMs: 100, registro: antigo }), recusa);
    assert.throws(() => K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', registro: antigo }), recusa);
  });

  test('LST-06 — registro de teste fora de NODE_ENV=test é recusado nas três funções; configuração com chave extra continua inválida', () => {
    const lista = registroDeTeste();
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => D.localizarArmazenamentoDuravel('hml-s3-principal', 'HOMOLOGACAO', lista), (e) => e.code === 'CONFIGURACAO_INVALIDA');
      assert.throws(() => D.criarDestinoDuravel({ id: 'hml-s3-principal', adaptador: { confirmar: eco }, prazoMs: 100, registro: lista }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
      assert.throws(() => K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', registro: lista }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
    assert.throws(() => D.criarDestinoDuravel({ id: 'x', adaptador: { confirmar: eco }, prazoMs: 100, extra: 1 }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => K.autorizarEnvioDuravel({ containerCifrado: CONTAINER, destinoId: 'x', ambiente: 'HOMOLOGACAO', extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
  });

  test('LST-07 — a localização sempre valida o registro (ficha malformada derruba a consulta, não é ignorada)', () => {
    const ruim = fichaDeTeste('HOMOLOGACAO');
    ruim.bucket = 'meu-bucket';
    assert.throws(() => D.localizarArmazenamentoDuravel('hml-s3-principal', 'HOMOLOGACAO', registro(ruim)), (e) => e.code === 'REGISTRO_DURAVEL_INVALIDO' && e.motivo === 'BUCKET_FORA_DO_PADRAO');
  });
});

describe('[LST] a função única é a única porta de consulta', () => {
  test('LST-08 — nenhum código de src consulta a lista por includes/some/find/filter/indexOf; só a função única a usa', () => {
    const achados = [];
    const varrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const c = path.join(dir, e.name);
        if (e.isDirectory()) varrer(c);
        else if (c.endsWith('.js') && /ARMAZENAMENTOS_DURAVEIS_APROVADOS\s*\.\s*(?:includes|some|find|findIndex|filter|indexOf|map|every)\b/.test(semComentarios(fs.readFileSync(c, 'utf8')))) achados.push(path.relative(SRC, c));
      }
    };
    varrer(SRC);
    assert.deepEqual(achados, []);
    const dur = semComentarios(fs.readFileSync(path.join(SRC, 'services', 'imagem-backup-durabilidade.service.js'), 'utf8'));
    const cus = semComentarios(fs.readFileSync(path.join(SRC, 'services', 'backup-fontes-custodia-chaves.service.js'), 'utf8'));
    assert.match(dur, /localizarArmazenamentoDuravel\(opcoes\.id/);
    assert.match(cus, /localizarArmazenamentoDuravel\(destinoId, ambiente/);
  });
});
