'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exigir, MAX } = require('./protocolo');
function criarS3({ bucket, conta, regiao, executavel = '/usr/local/bin/aws' }) {
  exigir(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '') && !bucket.includes('..') && /^[0-9]{12}$/.test(conta || '') && /^[a-z]{2}-[a-z]+-[1-9]$/.test(regiao || '') && path.isAbsolute(executavel), 'S3_CONFIG');
  exigir(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_SESSION_TOKEN, 'CREDENCIAL_TEMPORARIA_OBRIGATORIA');
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), AWS_DEFAULT_REGION: regiao, AWS_REGION: regiao, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '2' };
  function executar(args) {
    try { return execFileSync(executavel, [...args, '--region', regiao, '--output', 'json', '--no-cli-pager'], { env, timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      if (e.stderr && /\(NoSuchKey\)/.test(e.stderr.toString())) return null;
      throw Object.assign(new Error('S3_OPERACAO_FALHOU'), { codigo: 'S3_OPERACAO_FALHOU' });
    }
  }
  const identidade = JSON.parse(executar(['sts', 'get-caller-identity']));
  exigir(identidade.Account === conta, 'CONTA_DIVERGENTE');
  function operar(tipo, key, b) {
    exigir(/^hml\/(blobs|pedidos|recibos)\/[a-zA-Z0-9.-]+\.json$/.test(key), 'CHAVE_INVALIDA');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-s3-'));
    const arquivo = path.join(dir, 'objeto');
    try {
      const args = ['s3api', tipo, '--bucket', bucket, '--key', key, '--expected-bucket-owner', conta];
      if (tipo === 'put-object') {
        exigir(Buffer.isBuffer(b) && b.length <= MAX, 'TAMANHO');
        fs.writeFileSync(arquivo, b, { flag: 'wx', mode: 0o600 });
        const resultado = executar([...args, '--body', arquivo, '--if-none-match', '*', '--server-side-encryption', 'AES256']);
        exigir(resultado !== null, 'S3_PUT_FALHOU');
        return;
      }
      if (key.startsWith('hml/recibos/')) {
        const lista = JSON.parse(executar(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', key, '--expected-bucket-owner', conta, '--max-keys', '2', '--no-paginate']));
        if (!(lista.Contents || []).some(o => o.Key === key)) return null;
      }
      const meta = executar([...args, arquivo]);
      if (meta === null) return null;
      exigir(fs.statSync(arquivo).size <= MAX, 'TAMANHO');
      return fs.readFileSync(arquivo);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return {
    get: key => operar('get-object', key), put: (key, b) => operar('put-object', key, b),
    listarPedidos: () => {
      const r = JSON.parse(executar(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'hml/pedidos/', '--expected-bucket-owner', conta, '--max-keys', '1000', '--no-paginate']));
      exigir(!r.IsTruncated, 'FILA_EXCEDE_LIMITE');
      return (r.Contents || []).map(o => {
        const m = /^hml\/pedidos\/([1-9][0-9]{0,19}-[1-9][0-9]{0,5})\.json$/.exec(o.Key);
        exigir(m, 'FILA_INVALIDA');
        return { id: m[1], em: Date.parse(o.LastModified) };
      }).sort((a, b) => a.em - b.em).map(o => o.id);
    },
  };
}
module.exports = { criarS3 };
