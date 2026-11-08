'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/services/backup-executor-configuracao.service');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');

/** D-ORF-6, Rodada B (B1) [CFG]: leitor da configuração do executor (BACKUP_EXECUTOR_CONFIG) e leitura restrita. Só arquivos temporários 0700; nada é real. */

const UID = process.getuid();
const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); });
const novaRaiz = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
const gravar = (caminho, texto, modo = 0o600) => { fs.writeFileSync(caminho, texto, { mode: modo }); fs.chmodSync(caminho, modo); return caminho; };
const valida = (raiz) => ({
  versao: 1, finalidade: 'ENSAIO_ISOLADO', ambiente: 'HOMOLOGACAO', regiao: 'sa-east-1',
  papeis: { PUBLICADOR: path.join(raiz, 'pub.json'), VERIFICADOR: path.join(raiz, 'ver.json'), RESTAURACAO: path.join(raiz, 'res.json') },
});
const ler = (caminho, extra = {}) => C.lerConfiguracaoOperacional({ ambiente: caminho === undefined ? {} : { [C.VARIAVEL]: caminho }, ...extra });
const com = (objeto, nome = 'config.json') => { const raiz = novaRaiz(); return gravar(path.join(raiz, nome), JSON.stringify(objeto)); };

describe('[CFG] leitor da configuração do executor', () => {
  test('CFG-01 — variável ausente ou vazia é CONFIGURACAO_AUSENTE (não é erro: o CLI segue sem ligação)', () => {
    assert.deepEqual(ler(undefined), { ok: false, codigo: 'CONFIGURACAO_AUSENTE' });
    assert.deepEqual(ler(''), { ok: false, codigo: 'CONFIGURACAO_AUSENTE' });
  });

  test('CFG-02 — configuração válida: congelada, com SHA-256 do conteúdo e os três papéis', () => {
    const raiz = novaRaiz();
    const objeto = valida(raiz);
    const caminho = gravar(path.join(raiz, 'config.json'), JSON.stringify(objeto));
    const r = ler(caminho);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Object.isFrozen(r.configuracao) && Object.isFrozen(r.configuracao.papeis));
    assert.deepEqual({ ...r.configuracao.papeis }, objeto.papeis);
    assert.equal(r.configuracao.finalidade, 'ENSAIO_ISOLADO');
    assert.equal(r.configuracao.ambiente, 'HOMOLOGACAO');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  });

  test('CFG-03 — caminho relativo, não canônico, com .. ou com NUL é CONFIGURACAO_CAMINHO_INVALIDO', () => {
    for (const caminho of ['config.json', './config.json', '/tmp/../config.json', '/tmp//config.json', '/tmp/config.json/', '/tmp/a\0b', ` ${path.join(novaRaiz(), 'c.json')}`]) {
      assert.deepEqual(ler(caminho), { ok: false, codigo: 'CONFIGURACAO_CAMINHO_INVALIDO' }, JSON.stringify(caminho));
    }
  });

  test('CFG-04 — inexistente é INDISPONIVEL; diretório, arquivo especial e dono diferente são INSEGURO', () => {
    const raiz = novaRaiz();
    assert.equal(ler(path.join(raiz, 'nao-existe.json')).codigo, 'CONFIGURACAO_ARQUIVO_INDISPONIVEL');
    assert.equal(ler(raiz).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    assert.equal(ler('/dev/null').codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    const caminho = com(valida(raiz));
    assert.equal(ler(caminho, { uid: UID + 1 }).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
  });

  test('CFG-05 — link simbólico no arquivo ou em qualquer diretório do caminho é recusado', () => {
    const raiz = novaRaiz();
    const real = gravar(path.join(raiz, 'real.json'), JSON.stringify(valida(raiz)));
    const link = path.join(raiz, 'link.json');
    fs.symlinkSync(real, link);
    assert.equal(ler(link).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    const subdir = path.join(raiz, 'sub');
    fs.mkdirSync(subdir, { mode: 0o700 });
    gravar(path.join(subdir, 'config.json'), JSON.stringify(valida(raiz)));
    const dirLink = path.join(raiz, 'dir-link');
    fs.symlinkSync(subdir, dirLink);
    assert.equal(ler(path.join(dirLink, 'config.json')).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
  });

  test('CFG-06 — SOMENTE 0600: 0400, 0640, 0644, 0660, 0666 e 0700 são recusados', () => {
    const raiz = novaRaiz();
    const texto = JSON.stringify(valida(raiz));
    for (const modo of [0o400, 0o640, 0o644, 0o660, 0o666, 0o700]) {
      const caminho = gravar(path.join(raiz, `c-${modo.toString(8)}.json`), texto, modo);
      assert.equal(ler(caminho).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO', modo.toString(8));
    }
    assert.equal(ler(gravar(path.join(raiz, 'ok.json'), texto, 0o600)).ok, true);
  });

  test('CFG-07 — arquivo grande demais, com mais de um vínculo ou em diretório gravável por grupo/outros é recusado', () => {
    const raiz = novaRaiz();
    const grande = gravar(path.join(raiz, 'grande.json'), `{${' '.repeat(C.LIMITE_CONFIGURACAO_BYTES + 10)}}`);
    assert.equal(ler(grande).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    const original = gravar(path.join(raiz, 'a.json'), JSON.stringify(valida(raiz)));
    fs.linkSync(original, path.join(raiz, 'b.json'));
    assert.equal(ler(original).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    const aberto = path.join(raiz, 'aberto');
    fs.mkdirSync(aberto, { mode: 0o700 });
    gravar(path.join(aberto, 'config.json'), JSON.stringify(valida(raiz)));
    for (const modo of [0o770, 0o707, 0o777]) {
      fs.chmodSync(aberto, modo);
      assert.equal(ler(path.join(aberto, 'config.json')).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO', modo.toString(8));
    }
    fs.chmodSync(aberto, 0o700);
    assert.equal(ler(path.join(aberto, 'config.json')).ok, true);
  });

  test('CFG-08 — forma inválida: JSON quebrado, não objeto, chave extra ou ausente, versão, região, papéis, __proto__', () => {
    const raiz = novaRaiz();
    const base = valida(raiz);
    const texto = (t) => gravar(path.join(raiz, `t-${Math.random().toString(36).slice(2)}.json`), t);
    const invalidos = [
      '{', '[]', '"texto"', '42', 'null',
      JSON.stringify({ ...base, extra: 1 }),
      JSON.stringify((({ regiao, ...resto }) => resto)(base)),
      JSON.stringify({ ...base, versao: 2 }),
      JSON.stringify({ ...base, versao: '1' }),
      JSON.stringify({ ...base, regiao: 'sa east 1' }),
      JSON.stringify({ ...base, regiao: 'SA-EAST-1' }),
      JSON.stringify({ ...base, papeis: {} }),
      JSON.stringify({ ...base, papeis: [] }),
      JSON.stringify({ ...base, papeis: { OUTRO: path.join(raiz, 'x.json') } }),
      JSON.stringify({ ...base, papeis: { PUBLICADOR: 'relativo.json' } }),
      JSON.stringify({ ...base, papeis: { PUBLICADOR: path.join(raiz, 'x.json'), VERIFICADOR: path.join(raiz, 'x.json') } }),
      JSON.stringify({ ...base, papeis: { PUBLICADOR: path.join(raiz, 'X.json'), VERIFICADOR: path.join(raiz, 'x.json') } }),
      `{"versao":1,"finalidade":"ENSAIO_ISOLADO","ambiente":"HOMOLOGACAO","regiao":"sa-east-1","papeis":{"PUBLICADOR":"${path.join(raiz, 'p.json')}"},"__proto__":{"x":1}}`,
      JSON.stringify({ ...base, finalidade: 1 }),
    ];
    for (const t of invalidos) assert.equal(ler(texto(t)).codigo, 'CONFIGURACAO_FORMA_INVALIDA', t.slice(0, 80));
  });

  test('CFG-09 — nunca aceita chave sensível: a configuração só guarda caminhos, jamais segredos', () => {
    const raiz = novaRaiz();
    const base = valida(raiz);
    for (const extra of [{ accessKeyId: 'SWBTESTEXXXXXXXX' }, { secretAccessKey: 'SWBTESTE-xxxxxxxx' }, { senha: 'x' }, { token: 'x' }, { credenciais: {} }, { papeis: { ...base.papeis, PUBLICADOR_secret: 'x' } }]) {
      const caminho = com({ ...base, ...extra });
      const r = ler(caminho);
      assert.equal(r.ok, false);
      assert.equal(r.codigo, 'CONFIGURACAO_FORMA_INVALIDA', JSON.stringify(extra));
    }
  });

  test('CFG-10 — finalidade ou ambiente fora de ENSAIO_ISOLADO e HOMOLOGACAO é CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA', () => {
    const raiz = novaRaiz();
    const base = valida(raiz);
    for (const troca of [{ finalidade: 'OPERACAO' }, { finalidade: 'ensaio_isolado' }, { ambiente: 'PRODUCAO' }, { ambiente: 'homologacao' }, { finalidade: 'ENSAIO_ISOLADO ', ambiente: 'HOMOLOGACAO' }]) {
      assert.equal(ler(com({ ...base, ...troca })).codigo, 'CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA', JSON.stringify(troca));
    }
  });

  test('CFG-11 — o caminho do próprio arquivo de configuração não pode ser um arquivo de credencial', () => {
    const raiz = novaRaiz();
    const caminho = path.join(raiz, 'config.json');
    gravar(caminho, JSON.stringify({ ...valida(raiz), papeis: { PUBLICADOR: caminho } }));
    assert.equal(ler(caminho).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
  });

  test('CFG-12 — o resultado nunca ecoa caminho, conteúdo ou valor', () => {
    const raiz = novaRaiz();
    const segredo = 'SWBTESTE-SEGREDO-NAO-PODE-APARECER';
    const casos = [
      ler(com({ ...valida(raiz), secretAccessKey: segredo })),
      ler(gravar(path.join(raiz, 'quebrado.json'), `{${segredo}`)),
      ler(path.join(raiz, 'nao-existe.json')),
      ler('relativo.json'),
      ler(com({ ...valida(raiz), finalidade: segredo })),
    ];
    for (const r of casos) {
      const texto = JSON.stringify(r);
      assert.ok(!texto.includes(segredo) && !texto.includes(raiz) && !texto.includes('relativo.json'), texto);
      assert.deepEqual(Object.keys(r).sort(), ['codigo', 'ok']);
      assert.ok(C.CODIGOS.includes(r.codigo), r.codigo);
    }
  });

  test('CFG-13 — leitor injetado: falhas dele viram o código correspondente; resposta fora da forma é INDISPONIVEL', () => {
    const lerCom = (resposta) => C.lerConfiguracaoOperacional({ ambiente: { [C.VARIAVEL]: '/qualquer/coisa.json' }, lerArquivo: () => resposta });
    assert.equal(lerCom({ ok: false, codigo: 'CAMINHO_INVALIDO' }).codigo, 'CONFIGURACAO_CAMINHO_INVALIDO');
    assert.equal(lerCom({ ok: false, codigo: 'ARQUIVO_INSEGURO' }).codigo, 'CONFIGURACAO_ARQUIVO_INSEGURO');
    assert.equal(lerCom({ ok: false, codigo: 'QUALQUER' }).codigo, 'CONFIGURACAO_ARQUIVO_INDISPONIVEL');
    assert.equal(lerCom(undefined).codigo, 'CONFIGURACAO_ARQUIVO_INDISPONIVEL');
    assert.equal(lerCom({ ok: true, texto: 42 }).codigo, 'CONFIGURACAO_ARQUIVO_INDISPONIVEL');
  });

  test('CFG-14 — parâmetros fora da forma lançam TypeError (erro de programação), sem tocar em arquivo', () => {
    for (const ruim of [undefined, null, [], 'x', { ambiente: null }, { ambiente: [] }, { ambiente: {}, extra: 1 }, { ambiente: {}, lerArquivo: 'x' }]) {
      assert.throws(() => C.lerConfiguracaoOperacional(ruim), TypeError);
    }
    for (const ruim of [{ uid: -1, limiteBytes: 10 }, { uid: 1.5, limiteBytes: 10 }, { uid: 1, limiteBytes: 0 }, { uid: 1, limiteBytes: 1.5 }]) {
      assert.throws(() => C.lerArquivoRestrito('/tmp/x', ruim), TypeError);
    }
  });
});
