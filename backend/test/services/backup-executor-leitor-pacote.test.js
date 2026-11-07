'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarLeitorDePacote } = require('../../src/services/backup-executor-leitor-pacote.service');
const { ehResultadoDoLeitor, LIMITES } = require('../../src/services/backup-fontes-manifesto-l2.service');
const { chavesOffline } = require('../helpers/ambiente-executor');
const { novaRaiz, limparRaizes, pacoteSintetico } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, L2 (Bloco C) [LPK]: leitor REAL do pacote publicado para a porta `lerPacote`. Pacote sintético escrito pelo escritor L2 real; chaves de teste reconstruídas off-line.
 * Caminhos inseguros (fora da raiz, links simbólicos em qualquer componente, hard link, não arquivo), selo e manifesto adulterados, limite de bytes e ausência de vazamento.
 */

after(limparRaizes);
const { fonteMac } = chavesOffline();
const MAC_ID = 'mac-hml-v1';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const falha = async (promessa) => { try { await promessa; } catch (e) { return e; } return assert.fail('deveria falhar'); };
const codigoDe = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const RAIZ_FICTICIA = '/var/safework/publicados';
const mk = (raiz, extra = {}) => criarLeitorDePacote({ fonteDeChaves: fonteMac, raizPublicados: raiz, ...extra });
const publicado = (raiz) => { const p = pacoteSintetico(raiz, { fonteMac, macId: MAC_ID }); return { ...p, nome: 'pacote', pedido: { dir: p.dir, nome: 'pacote' } }; };
const recusado = async (leitor, pedido, motivo) => {
  const e = await falha(leitor.lerPacote(pedido));
  assert.deepEqual({ code: e.code, motivo: e.motivo, mensagem: e.message }, { code: 'PACOTE_ILEGIVEL', motivo, mensagem: 'pacote ilegível' });
  return e;
};

describe('[LPK] construção e pedido', () => {
  test('LPK-01 — configuração estrita: fonte de chaves reconhecida, raiz canônica, limite dentro do limite do L2, nenhuma chave extra', () => {
    assert.equal(codigoDe(() => mk(RAIZ_FICTICIA)), null);
    assert.equal(codigoDe(() => criarLeitorDePacote(undefined)), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA');
    assert.equal(codigoDe(() => criarLeitorDePacote({ raizPublicados: RAIZ_FICTICIA })), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA');
    assert.equal(codigoDe(() => criarLeitorDePacote({ fonteDeChaves: { obter: () => ({}), origem: 'TESTE_CONTROLADO' }, raizPublicados: RAIZ_FICTICIA })), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA', 'fonte forjada');
    for (const raiz of ['relativo', `${RAIZ_FICTICIA}/`, '/a/../b', '/']) assert.equal(codigoDe(() => mk(raiz)), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA', raiz);
    for (const tamanhoMaximo of [0, -1, 1.5, LIMITES.bytesDoManifesto + 1, '10']) assert.equal(codigoDe(() => mk(RAIZ_FICTICIA, { tamanhoMaximo })), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA', String(tamanhoMaximo));
    assert.equal(codigoDe(() => mk(RAIZ_FICTICIA, { extra: 1 })), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA');
    assert.equal(codigoDe(() => mk(RAIZ_FICTICIA, { catalogoAtual: {} })), 'LEITOR_PACOTE_CONFIGURACAO_INVALIDA', 'catálogo inválido');
    const leitor = mk(RAIZ_FICTICIA);
    assert.ok(Object.isFrozen(leitor));
    assert.deepEqual(Object.keys(leitor), ['lerPacote']);
  });

  test('LPK-02 — pedido fora da forma, nome fora do formato ou dir diferente de <raiz>/<nome>: recusado ANTES de tocar o disco (a raiz nem existe); diretório inexistente é PACOTE_INACESSIVEL', async () => {
    const leitor = mk(RAIZ_FICTICIA);
    for (const ruim of [undefined, null, {}, { dir: `${RAIZ_FICTICIA}/p` }, { nome: 'p' }, { dir: `${RAIZ_FICTICIA}/p`, nome: 'p', extra: 1 }, { dir: `${RAIZ_FICTICIA}/p`, nome: '../p' }, { dir: `${RAIZ_FICTICIA}/p`, nome: '.p' }, { dir: `${RAIZ_FICTICIA}/p`, nome: 'a/b' }, { dir: `${RAIZ_FICTICIA}/p`, nome: 'x'.repeat(129) }]) {
      await recusado(leitor, ruim, 'PEDIDO_INVALIDO');
    }
    for (const dir of ['/outra/raiz/p', `${RAIZ_FICTICIA}/q`, `${RAIZ_FICTICIA}/p/`, `${RAIZ_FICTICIA}//p`, 'p']) await recusado(leitor, { dir, nome: 'p' }, 'PACOTE_FORA_DA_RAIZ');
    await recusado(leitor, { dir: `${RAIZ_FICTICIA}/p`, nome: 'p' }, 'PACOTE_INACESSIVEL');
  });
});

describe('[LPK] leitura autenticada', () => {
  test('LPK-03 — pacote publicado pelo escritor L2 real: devolve o `lido` do leitor L2 (reconhecido), layout 2, identidade e bytes iguais aos do escritor; o selo é a fonte do hash declarado', async () => {
    const raiz = novaRaiz();
    const p = publicado(raiz);
    const lido = await mk(raiz).lerPacote(p.pedido);
    assert.ok(ehResultadoDoLeitor(lido), 'produzido pelo leitor L2, não forjado');
    assert.deepEqual({ layout: lido.layout, sha: lido.identidade.sha256Manifesto, conjunto: lido.identidade.conjuntoId, autenticado: lido.autenticacao.autenticado, origem: lido.autenticacao.origemDaChave },
      { layout: 2, sha: p.lido.sha256, conjunto: 'conjunto-d45', autenticado: true, origem: 'TESTE_CONTROLADO' });
    assert.ok(Buffer.from(lido.bytes).equals(p.lido.bytes));
    assert.equal(lido.caminhoDe('imagens', `padrao/${p.h}/mestre.png`), `arquivos/imagens/padrao/${p.h}/mestre.png`);
    // o pedido é congelado pelo adaptador de produção; aqui também aceita objeto congelado e não o altera
    const congelado = Object.freeze({ dir: p.dir, nome: 'pacote' });
    assert.equal((await mk(raiz).lerPacote(congelado)).identidade.sha256Manifesto, p.lido.sha256);
  });

  test('LPK-04 — links simbólicos em qualquer componente (raiz, diretório do pacote ou o próprio manifesto), hard link e "manifesto" que não é arquivo regular são recusados', async () => {
    const raiz = novaRaiz();
    const p = publicado(raiz);
    // diretório do pacote é um link para o pacote real
    fs.symlinkSync(p.dir, path.join(raiz, 'alias'));
    await recusado(mk(raiz), { dir: path.join(raiz, 'alias'), nome: 'alias' }, 'CAMINHO_NAO_CANONICO');
    // a raiz configurada passa por um link
    const raizPorLink = novaRaiz();
    fs.symlinkSync(raiz, path.join(raizPorLink, 'r'));
    await recusado(mk(path.join(raizPorLink, 'r')), { dir: path.join(raizPorLink, 'r', 'pacote'), nome: 'pacote' }, 'CAMINHO_NAO_CANONICO');
    // "pacote" que é arquivo, não diretório
    fs.writeFileSync(path.join(raiz, 'arquivo'), 'x', { mode: 0o600 });
    await recusado(mk(raiz), { dir: path.join(raiz, 'arquivo'), nome: 'arquivo' }, 'CAMINHO_NAO_CANONICO');
    // manifesto.json substituído por link para um arquivo com o MESMO conteúdo: O_NOFOLLOW recusa
    const r2 = novaRaiz();
    const p2 = publicado(r2);
    const manifesto = path.join(p2.dir, 'manifesto.json');
    fs.renameSync(manifesto, path.join(r2, 'fora.json'));
    fs.symlinkSync(path.join(r2, 'fora.json'), manifesto);
    await recusado(mk(r2), p2.pedido, 'ARQUIVO_INACESSIVEL');
    // hard link: o mesmo inode tem dois nomes
    fs.unlinkSync(manifesto);
    fs.linkSync(path.join(r2, 'fora.json'), manifesto);
    assert.equal(fs.statSync(manifesto).nlink, 2);
    await recusado(mk(r2), p2.pedido, 'ARQUIVO_INVALIDO');
    // manifesto que é diretório
    fs.unlinkSync(manifesto);
    fs.mkdirSync(manifesto);
    const e = await recusado(mk(r2), p2.pedido, 'ARQUIVO_INVALIDO');
    assert.ok(!JSON.stringify({ ...e, message: e.message, stack: '' }).includes(r2), 'nenhum caminho no erro');
    // o selo também é protegido: selo por link
    const r3 = novaRaiz();
    const p3 = publicado(r3);
    const selo = path.join(p3.dir, 'manifesto.sha256');
    fs.renameSync(selo, path.join(r3, 'selo'));
    fs.symlinkSync(path.join(r3, 'selo'), selo);
    await recusado(mk(r3), p3.pedido, 'ARQUIVO_INACESSIVEL');
  });

  test('LPK-05 — selo e manifesto: selo ausente, curto, fora do formato ou com outro hash; manifesto adulterado com selo recomputado (MAC inválido); manifesto acima do limite', async () => {
    const raiz = novaRaiz();
    const p = publicado(raiz);
    const selo = path.join(p.dir, 'manifesto.sha256');
    const manifesto = path.join(p.dir, 'manifesto.json');
    const original = fs.readFileSync(selo);
    fs.unlinkSync(selo);
    await recusado(mk(raiz), p.pedido, 'ARQUIVO_INACESSIVEL');
    fs.writeFileSync(selo, 'abc', { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'ARQUIVO_INVALIDO');
    fs.writeFileSync(selo, `${'g'.repeat(64)}  manifesto.json\n`, { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'SELO_INVALIDO');
    fs.writeFileSync(selo, `${p.lido.sha256}  manifesto.jsonX`, { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'SELO_INVALIDO');
    fs.writeFileSync(selo, `${'0'.repeat(64)}  manifesto.json\n`, { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'HASH_DIVERGENTE');
    fs.writeFileSync(selo, original, { mode: 0o600 });
    assert.equal((await mk(raiz).lerPacote(p.pedido)).identidade.sha256Manifesto, p.lido.sha256, 'restaurado, volta a ler');
    // manifesto adulterado (um caractere do nome do banco) e selo coerente com os bytes adulterados: hash confere, MAC não
    const adulterado = Buffer.from(p.lido.bytes.toString('utf8').replace('"gepi_d45"', '"gepi_d46"'), 'utf8');
    assert.notEqual(sha(adulterado), p.lido.sha256);
    fs.writeFileSync(manifesto, adulterado, { mode: 0o600 });
    fs.writeFileSync(selo, `${sha(adulterado)}  manifesto.json\n`, { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'MAC_INVALIDO');
    fs.writeFileSync(manifesto, p.lido.bytes, { mode: 0o600 });
    fs.writeFileSync(selo, original, { mode: 0o600 });
    // limite de bytes do manifesto imposto pelo leitor (antes do leitor L2)
    await recusado(mk(raiz, { tamanhoMaximo: 16 }), p.pedido, 'LIMITE_EXCEDIDO');
    assert.equal((await mk(raiz, { tamanhoMaximo: p.lido.bytes.length }).lerPacote(p.pedido)).layout, 2, 'limite exato aceita');
    // manifesto vazio
    fs.writeFileSync(manifesto, '', { mode: 0o600 });
    await recusado(mk(raiz), p.pedido, 'ARQUIVO_INVALIDO');
  });

  test('LPK-06 — o módulo só lê: nenhuma escrita, remoção, flag de criação/escrita, processo, ambiente, argumentos ou rede; não cita a trava da política', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/backup-executor-leitor-pacote.service.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const padrao of [/\bwriteFile/, /\bappendFile/, /createWriteStream/, /\bunlink/, /\brmSync|\brm\(/, /\brename/, /\bmkdir/, /\bchmod/, /\blink(?:Sync)?\s*\(/, /\bsymlink/, /\bO_(?:WRONLY|CREAT|RDWR|APPEND|TRUNC)\b/, /child_process/, /\bspawn|\bexec(?:File)?\b/, /process\.(?:env|argv|umask)/, /\bfetch\(/, /node:(?:http|https|net|dns)/, /OPERACAO_HABILITADA/]) {
      assert.doesNotMatch(fonte, padrao, String(padrao));
    }
    assert.match(fonte, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
    assert.match(fonte, /layoutMinimo: 2/);
  });
});
