'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../../src/services/imagem-backup-durabilidade.service');
const K = require('../../src/services/backup-fontes-custodia-chaves.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const Dest = require('../../src/services/imagem-backup-destinos.service');
const S3 = require('../../src/services/backup-armazenamento-s3.service');
const { ambienteS3, sha } = require('../helpers/ambiente-s3-falso');

/** R-D45 [INV]: invariantes da rodada — nada é ativado, nenhuma dependência nem variável nova, e uma confirmação de TESTE nunca torna nada durável. */

const BACKEND = path.join(__dirname, '..', '..');
const NOVOS = [
  'backup-armazenamento-duravel-fichas', 'backup-recibo-duravel', 'backup-armazenamento-s3', 'backup-verificador-duravel', 'backup-baixador-duravel', 'backup-restauracao-duravel',
  'backup-custodia-xor', 'backup-fontes-provedor-memoria', 'backup-fontes-kms-pre-resolvido', 'backup-fontes-recuperacao-offline', 'backup-contencao-destino',
];
const lerFonte = (arquivo) => fs.readFileSync(path.join(BACKEND, arquivo), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-inv-'));
fs.chmodSync(raiz, 0o700);
after(() => fs.rmSync(raiz, { recursive: true, force: true }));

describe('[INV] nada é ativado e nada novo entra por configuração', () => {
  test('INV-01 — os onze módulos novos não leem ambiente, não citam SDK, não definem nomes de raiz da guarda G1 e só o baixador escreve ou remove arquivos', () => {
    for (const nome of NOVOS) {
      const fonte = lerFonte(`src/services/${nome}.service.js`);
      assert.equal(/process\.env|@aws-sdk|process\.stdin|process\.argv/.test(fonte), false, `${nome}: ambiente ou SDK`);
      assert.equal(/\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/.test(fonte), false, `${nome}: nome de raiz`);
      const escreve = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/.test(fonte);
      assert.equal(escreve, nome === 'backup-baixador-duravel', nome);
    }
  });

  test('INV-02 — listas aprovadas vazias e travas fechadas: destino durável, provedores, destinos locais, fábricas operacionais, envio e limpeza', () => {
    assert.deepEqual([...D.ARMAZENAMENTOS_DURAVEIS_APROVADOS], []);
    assert.deepEqual([...H.PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.deepEqual([...E.PROVEDORES_DE_CIFRA_APROVADOS], []);
    assert.deepEqual([...Dest.DESTINOS_AUTORIZADOS.HOMOLOGACAO, ...Dest.DESTINOS_AUTORIZADOS.PRODUCAO], []);
    assert.throws(() => H.criarFonteOperacionalDeChaves({ provedor: 'aws-kms-pre-resolvido-v1', adaptador: { obter() {} } }));
    assert.throws(() => E.criarFonteOperacionalDeCifra({ provedor: 'aws-kms-pre-resolvido-v1', adaptador: { obter() {} } }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    assert.equal(K.autorizarEnvioDuravel({ containerCifrado: { ok: true, sha256Envelope: 'a'.repeat(64) }, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO' }).autorizado, false);
    const a = ambienteS3();
    assert.throws(() => S3.criarEnviadorS3({ destinoId: a.ficha.id, ambiente: 'HOMOLOGACAO', cliente: a.s3.clientes.publicador }), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    assert.match(lerFonte('src/services/imagem-backup-orfaos.service.js'), /const LIMPEZA_OPERACIONAL_HABILITADA = false;/);
  });

  test('INV-03 — a única dependência de SDK da AWS são os três clientes exatos do gate DEP-2 (no package.json e na raiz do lock) e nenhuma variável nova de bucket, chave ou AWS em .env.example ou src/config', () => {
    const esperadas = { '@aws-sdk/client-kms': '3.1152.0', '@aws-sdk/client-s3': '3.1152.0', '@aws-sdk/client-sts': '3.1152.0' };
    const doSdk = ([n]) => /aws-sdk|^@smithy\/|^@aws\//i.test(n);
    const lerJson = (arquivo) => JSON.parse(fs.readFileSync(path.join(BACKEND, arquivo), 'utf8'));
    const pacote = lerJson('package.json');
    const raizDoLock = lerJson('package-lock.json').packages[''];
    for (const grupo of [pacote, raizDoLock]) {
      assert.deepEqual(Object.fromEntries(Object.entries(grupo.dependencies ?? {}).filter(doSdk)), esperadas);
      for (const outro of ['devDependencies', 'optionalDependencies', 'peerDependencies']) assert.deepEqual(Object.entries(grupo[outro] ?? {}).filter(doSdk), [], outro);
    }
    assert.equal(/bucket|kms|aws_/i.test(fs.readFileSync(path.join(BACKEND, '.env.example'), 'utf8')), false);
    for (const f of fs.readdirSync(path.join(BACKEND, 'src', 'config'))) if (f.endsWith('.js')) assert.equal(/bucket|kms|aws_/i.test(fs.readFileSync(path.join(BACKEND, 'src', 'config', f), 'utf8')), false, f);
  });
});

describe('[INV] compatibilidade com a classificação de durabilidade existente', () => {
  test('INV-04 — mesmo com recibo e confirmação, uma confirmação de TESTE_CONTROLADO nunca torna o backup duravelmente armazenado nem restaurável', async () => {
    const a = ambienteS3();
    const e = a.enviador();
    assert.equal((await e.executarPreVoo()).ok, true);
    const conteudo = Buffer.from('conteudo cifrado sintético');
    const caminho = path.join(raiz, 'obj.bin');
    fs.writeFileSync(caminho, conteudo, { mode: 0o600 });
    const r = await e.enviarArquivo({ caminho, chave: 'c1/envelope.json', sha256: sha(conteudo), bytes: conteudo.length });
    assert.equal(r.estado, 'GRAVADO');
    const confirmacao = await e.criarDestino({ prazoMs: 200 }).confirmarGravacao({ chave: r.recibo.chave, sha256: r.recibo.sha256, bytes: r.recibo.bytes });
    assert.deepEqual([confirmacao.confirmado, confirmacao.operacional, confirmacao.origem], [true, false, 'TESTE_CONTROLADO']);
    const c = D.classificarDurabilidade({ captura: { ok: true, bytesRecebidos: 1, bytesGravados: 1, fsyncConcluido: true }, publicacao: { publicada: true, estado: 'PUBLICADA' }, confirmacao, restauravelComprovado: true });
    assert.deepEqual([c.pacotePublicado, c.duravelmenteArmazenado, c.restauravelComprovado], [true, false, false]);
  });
});
