'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { png } = require('../helpers/imagens-validas');
const { jpeg, jpegCortadoComEoi, texto } = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-6 — o controller de PRODUÇÃO (o singleton que o app monta na carga do módulo) só processa imagem quando o ambiente liga o
 * processador real E configura o diretório. Cada caso roda em PROCESSO PRÓPRIO, com o ambiente montado aqui, e conta as chamadas a spawn: desligado, nenhum filho
 * é iniciado, nenhum byte é lido nem gravado e a resposta é a recusa controlada 503 IMAGENS_INDISPONIVEL. É a prova de que o código novo não liga o envio
 * sozinho em servidor nenhum: o servidor com diretório configurado mas SEM a variável (caso ACT-01) continua recusando.
 * O banco nunca é tocado: o ambiente do filho aponta para uma porta fechada e os casos terminam antes do registro.
 */

const HELPER = path.join(__dirname, '..', 'helpers', 'envio-singleton.js');
const VARIAVEL = 'IMAGENS_PROCESSADOR_REAL';
const DIRETORIO = 'IMAGENS_ARMAZENAMENTO_DIRETORIO';

function executar({ ambiente = {}, arquivo } = {}) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'inexistente_5c6', DB_USER: 'inexistente', DB_PASSWORD: 'inexistente', ...ambiente,
  };
  return new Promise((resolver, rejeitar) => {
    const filho = spawn(process.execPath, arquivo ? [HELPER, arquivo] : [HELPER], { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    const limite = setTimeout(() => filho.kill('SIGKILL'), 30000);
    filho.stdout.on('data', (bloco) => { saida += bloco; });
    filho.stderr.on('data', (bloco) => { erro += bloco; });
    filho.on('close', (codigo) => {
      clearTimeout(limite);
      try {
        resolver({ saida: codigo, ...JSON.parse(saida.trim().split('\n').at(-1)) });
      } catch {
        rejeitar(new Error(`auxiliar sem resposta (código ${codigo}): ${erro.slice(0, 400)}`));
      }
    });
  });
}

describe('controller de produção — ativação do envio pelo ambiente (Unidade 5C-6)', () => {
  const raizes = [];
  let arquivos;

  const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

  before(async () => {
    const pasta = novaRaiz();
    arquivos = {
      png: path.join(pasta, 'valida.png'),
      texto: path.join(pasta, 'texto.txt'),
      jpegCortado: path.join(pasta, 'cortado.jpg'),
    };
    fs.writeFileSync(arquivos.png, png(320, 320), { mode: 0o600 });
    fs.writeFileSync(arquivos.texto, texto('isto nao e uma imagem'), { mode: 0o600 });
    fs.writeFileSync(arquivos.jpegCortado, jpegCortadoComEoi(await jpeg(400, 400)), { mode: 0o600 });
  });
  after(() => { for (const raiz of raizes.reverse()) removerTemporarioSeguro(raiz); });

  const recusadoSemProcessar = (r, rotulo) => {
    assert.equal(r.desfecho, 'recusou', rotulo);
    assert.equal(r.status, 503, rotulo);
    assert.equal(r.codigo, 'IMAGENS_INDISPONIVEL', rotulo);
    assert.equal(r.spawns, 0, `${rotulo}: nenhum filho pode ser iniciado`);
  };

  test('ACT-01 — diretório configurado e variável AUSENTE (o caso do servidor 3300 após um reinício): 503, nenhum filho, nada gravado', async () => {
    const raiz = novaRaiz();
    const r = await executar({ ambiente: { [DIRETORIO]: raiz }, arquivo: arquivos.png });
    recusadoSemProcessar(r, 'ACT-01');
    assert.deepEqual(arquivosSob(raiz), []);
  });

  test('ACT-02 — sem diretório e sem variável (o caso do servidor 3000): 503 e nenhum filho', async () => {
    recusadoSemProcessar(await executar({ arquivo: arquivos.png }), 'ACT-02');
  });

  test('ACT-03 — variável `ativo` mas SEM diretório: 503 e nenhum filho (a ativação sozinha não basta)', async () => {
    recusadoSemProcessar(await executar({ ambiente: { [VARIAVEL]: 'ativo' }, arquivo: arquivos.png }), 'ACT-03');
  });

  test('ACT-04 — qualquer valor da variável diferente de `ativo`, com diretório configurado: 503, nenhum filho, nada gravado', async () => {
    for (const valor of ['', 'true', '1', 'ATIVO', ' ativo']) {
      const raiz = novaRaiz();
      const r = await executar({ ambiente: { [DIRETORIO]: raiz, [VARIAVEL]: valor }, arquivo: arquivos.png });
      recusadoSemProcessar(r, `ACT-04 ${JSON.stringify(valor)}`);
      assert.deepEqual(arquivosSob(raiz), [], JSON.stringify(valor));
    }
  });

  test('ACT-05 — variável `ativo` e diretório: o controller passa do 503 e o serviço recusa bytes que não são imagem (415) ANTES de iniciar qualquer filho', async () => {
    const raiz = novaRaiz();
    const r = await executar({ ambiente: { [DIRETORIO]: raiz, [VARIAVEL]: 'ativo' }, arquivo: arquivos.texto });
    assert.equal(r.desfecho, 'recusou');
    assert.equal(r.status, 415);
    assert.equal(r.codigo, 'IMAGEM_FORMATO_NAO_SUPORTADO');
    assert.equal(r.spawns, 0);
    assert.deepEqual(arquivosSob(raiz), []);
  });

  test('ACT-06 — variável `ativo` e diretório: uma imagem estruturalmente válida mas cortada chega ao filho REAL (um spawn) e volta como 400 IMAGEM_INVALIDA, sem gravar nada', async () => {
    const raiz = novaRaiz();
    const r = await executar({ ambiente: { [DIRETORIO]: raiz, [VARIAVEL]: 'ativo' }, arquivo: arquivos.jpegCortado });
    assert.equal(r.desfecho, 'recusou');
    assert.equal(r.status, 400);
    assert.equal(r.codigo, 'IMAGEM_INVALIDA');
    assert.equal(r.spawns, 1);
    assert.deepEqual(arquivosSob(raiz), []);
  });
});
