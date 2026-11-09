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

describe('[CFG-V2] configuração v2 (B2): destinos locais, áreas protegidas, limites e prazo', () => {
  const v2 = (raiz, extra = {}) => ({
    ...valida(raiz),
    versao: 2,
    destinosLocais: { BACKUP: { id: 'containers-teste', raiz: path.join(raiz, 'dest', 'containers') }, RESTAURACAO: { id: 'restauracao-teste', raiz: path.join(raiz, 'dest', 'restauracoes') } },
    protegidos: { imagens: '/srv/safework/imagens', fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' },
    limites: { arquivosMaximo: 1000, totalBytesMaximo: 1073741824 },
    prazoMs: 5000,
    ...extra,
  });
  const lerV2 = (alterar = () => {}) => {
    const raiz = novaRaiz();
    const objeto = v2(raiz);
    alterar(objeto, raiz);
    return ler(gravar(path.join(raiz, 'config.json'), JSON.stringify(objeto)));
  };
  const recusa = (alterar, codigo = 'CONFIGURACAO_FORMA_INVALIDA') => { const r = lerV2(alterar); assert.deepEqual({ ok: r.ok, codigo: r.codigo }, { ok: false, codigo }, JSON.stringify(r)); };

  test('CFG-V2-01 — v2 válida: devolve os campos novos, congelados em profundidade, com o SHA-256 do conteúdo', () => {
    const raiz = novaRaiz();
    const objeto = v2(raiz);
    const r = ler(gravar(path.join(raiz, 'config.json'), JSON.stringify(objeto)));
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = r.configuracao;
    assert.equal(c.versao, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(c)), { versao: 2, finalidade: 'ENSAIO_ISOLADO', ambiente: 'HOMOLOGACAO', regiao: 'sa-east-1', papeis: objeto.papeis, destinosLocais: objeto.destinosLocais, protegidos: objeto.protegidos, limites: objeto.limites, prazoMs: 5000 });
    for (const parte of [c, c.papeis, c.destinosLocais, c.destinosLocais.BACKUP, c.destinosLocais.RESTAURACAO, c.protegidos, c.limites]) assert.ok(Object.isFrozen(parte));
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  });

  test('CFG-V2-02 — a v1 segue exatamente como era: não devolve campos v2, e v1 com campo v2 ou v2 sem campo v2 é recusada; versão desconhecida também', () => {
    const raiz = novaRaiz();
    const v1 = ler(gravar(path.join(raiz, 'v1.json'), JSON.stringify(valida(raiz))));
    assert.equal(v1.ok, true);
    assert.deepEqual(Object.keys(v1.configuracao).sort(), ['ambiente', 'finalidade', 'papeis', 'regiao', 'versao']);
    const objeto = v2(raiz);
    for (const chave of ['destinosLocais', 'protegidos', 'limites', 'prazoMs']) {
      assert.equal(ler(com({ ...valida(raiz), [chave]: objeto[chave] })).codigo, 'CONFIGURACAO_FORMA_INVALIDA', `v1 com ${chave}`);
      const sem = { ...objeto }; delete sem[chave];
      assert.equal(ler(com(sem)).codigo, 'CONFIGURACAO_FORMA_INVALIDA', `v2 sem ${chave}`);
    }
    for (const versao of [0, 3, '2', null, true]) assert.equal(ler(com({ ...objeto, versao })).codigo, 'CONFIGURACAO_FORMA_INVALIDA', String(versao));
  });

  test('CFG-V2-03 — destinosLocais: aceita só BACKUP e/ou RESTAURACAO, com { id, raiz } e id no padrão DEDICADO da ação', () => {
    assert.equal(lerV2((o) => { delete o.destinosLocais.RESTAURACAO; }).ok, true);
    assert.equal(lerV2((o) => { delete o.destinosLocais.BACKUP; }).ok, true);
    recusa((o) => { o.destinosLocais = {}; });
    recusa((o) => { o.destinosLocais = []; });
    recusa((o) => { o.destinosLocais = { VERIFICACAO_DESTINO: o.destinosLocais.BACKUP }; });
    recusa((o) => { o.destinosLocais.BACKUP.id = 'restauracao-teste'; });
    recusa((o) => { o.destinosLocais.RESTAURACAO.id = 'containers-teste'; });
    for (const id of ['Containers', 'containers_x', 'containers x', 'qualquer', '', `containers-${'a'.repeat(60)}`, 7]) recusa((o) => { o.destinosLocais.BACKUP.id = id; });
    recusa((o) => { o.destinosLocais.BACKUP.extra = 1; });
    recusa((o) => { delete o.destinosLocais.BACKUP.raiz; });
    recusa((o) => { o.destinosLocais.BACKUP = 'containers-teste'; });
    for (const raizRuim of ['relativo/containers', '/srv/../containers', '/srv/containers/', '/srv//containers', '/', 7]) recusa((o) => { o.destinosLocais.BACKUP.raiz = raizRuim; });
  });

  test('CFG-V2-04 — protegidos: exatamente as cinco áreas, caminhos canônicos, sem repetição (nem por caixa) e sem aninhamento', () => {
    recusa((o) => { delete o.protegidos.dumps; });
    recusa((o) => { o.protegidos.extra = '/srv/safework/outra'; });
    recusa((o) => { o.protegidos.imagens = 'imagens'; });
    recusa((o) => { o.protegidos.imagens = 7; });
    recusa((o) => { o.protegidos.dumps = o.protegidos.publicados; });
    recusa((o) => { o.protegidos.dumps = o.protegidos.publicados.toUpperCase(); });
    recusa((o) => { o.protegidos.dumps = `${o.protegidos.preparacoes}/dentro`; });
    recusa((o) => { o.protegidos.imagens = '/srv'; });
    recusa((o) => { o.protegidos = []; });
  });

  test('CFG-V2-05 — sobreposições: raiz de destino × área, destino × destino, e arquivos (configuração e credenciais) dentro de área ou de raiz', () => {
    recusa((o) => { o.destinosLocais.BACKUP.raiz = o.protegidos.dumps; });
    recusa((o) => { o.destinosLocais.BACKUP.raiz = `${o.protegidos.publicados}/sub`; });
    recusa((o) => { o.destinosLocais.BACKUP.raiz = '/srv/safework/backup'; });
    recusa((o) => { o.destinosLocais.BACKUP.raiz = o.destinosLocais.RESTAURACAO.raiz; });
    recusa((o) => { o.destinosLocais.BACKUP.raiz = `${o.destinosLocais.RESTAURACAO.raiz}/containers`; });
    recusa((o) => { o.papeis.PUBLICADOR = `${o.protegidos.dumps}/publicador.json`; });
    recusa((o) => { o.papeis.VERIFICADOR = `${o.destinosLocais.BACKUP.raiz}/verificador.json`; });
    const raiz = novaRaiz();
    const objeto = v2(raiz, { protegidos: { imagens: raiz, fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' } });
    assert.equal(ler(gravar(path.join(raiz, 'config.json'), JSON.stringify(objeto))).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
  });

  test('CFG-V2-06 — limites: totalBytesMaximo obrigatório e inteiro seguro ≥ 1; arquivosMaximo opcional entre 1 e 400000; nenhuma outra chave', () => {
    assert.equal(lerV2((o) => { delete o.limites.arquivosMaximo; }).ok, true);
    assert.equal(lerV2((o) => { o.limites.arquivosMaximo = 400000; }).ok, true);
    assert.equal(lerV2((o) => { o.limites.totalBytesMaximo = 1; }).ok, true);
    recusa((o) => { delete o.limites.totalBytesMaximo; });
    for (const ruim of [0, -1, 1.5, '1024', null, 2 ** 53]) recusa((o) => { o.limites.totalBytesMaximo = ruim; });
    for (const ruim of [0, -1, 1.5, 400001, '10', null]) recusa((o) => { o.limites.arquivosMaximo = ruim; });
    recusa((o) => { o.limites.extra = 1; });
    recusa((o) => { o.limites = []; });
  });

  test('CFG-V2-07 — prazoMs: inteiro entre 1 e 600000 (o limite do executor)', () => {
    assert.equal(lerV2((o) => { o.prazoMs = 1; }).ok, true);
    assert.equal(lerV2((o) => { o.prazoMs = 600000; }).ok, true);
    for (const ruim of [0, -1, 1.5, 600001, '5000', null, true]) recusa((o) => { o.prazoMs = ruim; });
  });

  test('CFG-V2-08 — o marcador A_PREENCHER reprova em qualquer chave ou valor (região, caminhos, ids, nomes de campo)', () => {
    recusa((o) => { o.regiao = 'A_PREENCHER'; });
    recusa((o) => { o.papeis.PUBLICADOR = '/A_PREENCHER/publicador.json'; });
    recusa((o) => { o.destinosLocais.BACKUP.raiz = '/A_PREENCHER/containers'; });
    recusa((o) => { o.destinosLocais.BACKUP.id = 'containers-A_PREENCHER'; });
    recusa((o) => { o.protegidos.imagens = '/A_PREENCHER/imagens'; });
    recusa((o) => { o.A_PREENCHER = 1; });
  });

  test('CFG-V2-09 — a forma é conferida ANTES da finalidade; finalidade ou ambiente errados numa v2 bem formada são FINALIDADE_NAO_AUTORIZADA', () => {
    recusa((o) => { o.finalidade = 'OPERACAO'; }, 'CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA');
    recusa((o) => { o.ambiente = 'PRODUCAO'; }, 'CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA');
    recusa((o) => { o.finalidade = 'OPERACAO'; o.limites.totalBytesMaximo = 0; }, 'CONFIGURACAO_FORMA_INVALIDA');
  });

  test('CFG-V2-10 — chave sensível ou __proto__ dentro dos campos v2 reprova; nenhum resultado ecoa caminho, id ou valor', () => {
    recusa((o) => { o.limites.senha = 'x'; });
    recusa((o) => { o.destinosLocais.BACKUP.token = 'x'; });
    recusa((o) => { o.protegidos.accessKeyId = 'x'; });
    const raiz = novaRaiz();
    const texto = JSON.stringify(v2(raiz)).replace('"limites":{', '"limites":{"__proto__":{"x":1},');
    assert.equal(ler(gravar(path.join(raiz, 'config.json'), texto)).codigo, 'CONFIGURACAO_FORMA_INVALIDA');
    const r = lerV2((o) => { o.destinosLocais.BACKUP.id = 'ID-NAO-PODE-APARECER'; o.protegidos.imagens = '/srv/caminho-nao-pode-aparecer'; });
    assert.ok(!JSON.stringify(r).includes('NAO-PODE-APARECER') && !JSON.stringify(r).includes('nao-pode-aparecer'));
    assert.deepEqual(Object.keys(r).sort(), ['codigo', 'ok']);
  });
});
