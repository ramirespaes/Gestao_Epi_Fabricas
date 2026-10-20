'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');

/**
 * Trava de JANELA DE ESCRITA (Biblioteca de Imagens, P-ORF-01, fase RED): o PROTOCOLO funciona entre processos diferentes, em particular com o procedimento de BACKUP, que é um
 * script de shell e cria a trava à mão. Contrato do módulo: ver janela-escrita-imagens.test.js. Aqui um `bash` de verdade faz o papel do backup:
 *   - cria a trava com `set -o noclobber` (o `>` do shell falha se o arquivo já existe: criação exclusiva) e um documento JSON do protocolo;
 *   - se a limpeza já segura a janela, esse mesmo comando FALHA e a trava da limpeza fica intacta;
 *   - se o backup já segura a janela, a limpeza é recusada (JANELA_OCUPADA, dono BACKUP) e a trava do backup fica intacta;
 *   - quando o backup termina (`rm -f` da sua trava), a janela volta a ficar livre para a limpeza.
 */

const { AGORA } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const J = () => exigirModulo('src/utils/janela-escrita-imagens');

function cenario() {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  return { raiz, pastaDaTrava, arquivo: path.join(pastaDaTrava, 'janela-imagens.lock') };
}
const bash = (script, arquivo) => spawnSync('bash', ['-c', script, '_', arquivo], { encoding: 'utf8', timeout: 20000 });

/** O que o procedimento de backup executa para ASSUMIR a janela: criação exclusiva (noclobber) do documento do protocolo. */
const ASSUMIR_COMO_BACKUP = `
set -o noclobber
TOKEN="$(openssl rand -hex 16)"
AGORA_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
printf '{"versao":1,"tipo":"BACKUP","pid":%s,"hospedeiro":"%s","iniciadoEm":"%s","token":"%s"}\\n' "$$" "$(hostname)" "$AGORA_ISO" "$TOKEN" > "$1"
`;

describe('[JAN-SH] a trava entre a limpeza e um BACKUP em shell', () => {
  test('JAN-21 — o backup (bash, noclobber) assume a janela livre; a limpeza é então recusada (JANELA_OCUPADA, dono BACKUP, com o pid do shell) e a trava do backup não muda; quando o backup solta a trava (rm -f), a limpeza assume', async () => {
    const { adquirirJanela, lerJanela } = J();
    const c = cenario();
    const criou = bash(ASSUMIR_COMO_BACKUP, c.arquivo);
    assert.equal(criou.status, 0, criou.stderr);
    const antes = fs.readFileSync(c.arquivo);
    const lida = await lerJanela({ arquivo: c.arquivo });
    assert.equal(lida.tipo, 'BACKUP');
    assert.equal(lida.versao, 1);
    assert.equal(Number.isInteger(lida.pid) && lida.pid > 0, true);
    assert.equal(Object.hasOwn(lida, 'token'), false);
    const erro = await adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: c.raiz, agora: () => AGORA }).then(() => null, (e) => e);
    assert.equal(erro?.codigo, 'JANELA_OCUPADA');
    assert.equal(erro.dono.tipo, 'BACKUP');
    assert.equal(erro.dono.pid, lida.pid);
    assert.deepEqual(fs.readFileSync(c.arquivo), antes);
    assert.equal(bash('rm -f "$1"', c.arquivo).status, 0);
    const janela = await adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: c.raiz, agora: () => AGORA });
    assert.equal(janela.tipo, 'LIMPEZA');
    await janela.liberar();
  });

  test('JAN-22 — com a janela nas mãos da LIMPEZA, o mesmo comando do backup FALHA (status diferente de zero, noclobber) e a trava da limpeza continua byte a byte igual; ao liberar, o backup consegue', async () => {
    const { adquirirJanela } = J();
    const c = cenario();
    const janela = await adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: c.raiz, agora: () => AGORA });
    const antes = fs.readFileSync(c.arquivo);
    const tentativa = bash(ASSUMIR_COMO_BACKUP, c.arquivo);
    assert.notEqual(tentativa.status, 0, 'o backup não pode assumir a janela enquanto a limpeza a segura');
    assert.deepEqual(fs.readFileSync(c.arquivo), antes);
    assert.deepEqual(await janela.liberar(), { liberada: true });
    const depois = bash(ASSUMIR_COMO_BACKUP, c.arquivo);
    assert.equal(depois.status, 0, depois.stderr);
    assert.equal(JSON.parse(fs.readFileSync(c.arquivo, 'utf8')).tipo, 'BACKUP');
  });

  test('JAN-23 — entre PROCESSOS: quando seis processos Node disputam a mesma janela ao mesmo tempo, exatamente UM vence (criação exclusiva no sistema de arquivos, não só na memória; a trava do vencedor continua depois que ele sai)', async () => {
    const c = cenario();
    exigirModulo('src/utils/janela-escrita-imagens');
    const moduloAbsoluto = path.join(__dirname, '..', '..', 'src', 'utils', 'janela-escrita-imagens.js');
    const codigo = `
      const { adquirirJanela } = require(process.argv[1]);
      adquirirJanela({ arquivo: process.argv[2], tipo: 'LIMPEZA', raizArmazenamento: process.argv[3] })
        .then(() => { process.stdout.write('GANHOU'); process.exit(0); }, (e) => { process.stdout.write('RECUSADO:' + e.codigo); process.exit(0); });
    `;
    const executar = () => new Promise((resolver) => {
      const { spawn } = require('node:child_process');
      const filho = spawn(process.execPath, ['-e', codigo, moduloAbsoluto, c.arquivo, c.raiz], { stdio: ['ignore', 'pipe', 'inherit'] });
      let saida = '';
      filho.stdout.on('data', (d) => { saida += d; });
      filho.on('close', () => resolver(saida));
    });
    const resultados = await Promise.all(Array.from({ length: 6 }, executar));
    assert.equal(resultados.filter((r) => r === 'GANHOU').length, 1, JSON.stringify(resultados));
    assert.equal(resultados.filter((r) => r === 'RECUSADO:JANELA_OCUPADA').length, 5, JSON.stringify(resultados));
  });
});
