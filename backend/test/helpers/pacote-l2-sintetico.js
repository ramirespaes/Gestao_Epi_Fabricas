'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../../src/services/backup-fontes-manifesto-l2.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');

/** R-D45: pacote layout 2 SINTÉTICO em disco (2 imagens padrão, dump fictício, manifesto selado pelo escritor L2). Mesmo desenho do teste da cifra (P11). */

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const raizes = [];
function novaRaiz(prefixo = 'gepi-d45-') {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefixo));
  fs.chmodSync(r, 0o700);
  raizes.push(r);
  return r;
}
const limparRaizes = () => { for (const r of raizes) fs.rmSync(r, { recursive: true, force: true }); };

function pacoteSintetico(raiz, { fonteMac, macId, conjuntoId = 'conjunto-d45' }) {
  const dir = path.join(raiz, 'pacote');
  fs.mkdirSync(dir, { mode: 0o700 });
  const mestre = Buffer.from(`mestre-${raiz}`);
  const mini = Buffer.from('mini');
  const h = sha(mestre);
  for (const [chave, b] of [[`padrao/${h}/mestre.png`, mestre], [`padrao/${h}/miniatura.webp`, mini]]) {
    fs.mkdirSync(path.join(dir, 'arquivos', 'imagens', 'padrao', h), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'arquivos', 'imagens', ...chave.split('/')), b, { mode: 0o600 });
  }
  fs.mkdirSync(path.join(dir, 'dump'), { mode: 0o700 });
  const dump = Buffer.from('PGDMP-ficticio-d45');
  fs.writeFileSync(path.join(dir, 'dump', 'postgres.dump'), dump, { mode: 0o600 });
  const escrito = M.criarEscritorL2({ fonteDeChaves: fonteMac, chaveId: macId }).construir({
    banco: { nome: 'gepi_d45', oid: '16384' }, conjuntoId, dump: { bytes: dump.length, sha256: sha(dump) }, catalogo: obterCatalogo(),
    fontes: [{ id: 'imagens', arquivos: [{ chave: `padrao/${h}/mestre.png`, sha256: h, bytes: mestre.length }, { chave: `padrao/${h}/miniatura.webp`, sha256: sha(mini), bytes: mini.length }] }],
    contexto: {}, postgres: C.blocoN0(),
  });
  fs.writeFileSync(path.join(dir, 'manifesto.json'), escrito.bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'manifesto.sha256'), `${escrito.sha256}  manifesto.json\n`, { mode: 0o600 });
  return { dir, lido: escrito, mestre, h };
}

const arvore = (dir) => {
  const saida = [];
  const andar = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) andar(r); else saida.push(r);
    }
  };
  andar('');
  return saida.sort();
};

module.exports = { novaRaiz, limparRaizes, pacoteSintetico, arvore, sha };
