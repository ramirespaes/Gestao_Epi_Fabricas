'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarValidadorDeDestinos, ehDestinoValidado, verificarNomeLivre, contem, DESTINOS_AUTORIZADOS } = require('../../src/services/imagem-backup-destinos.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');

/** Destinos validados contra diretórios temporários do próprio teste. Nada operacional, nada AWS, nada criado fora do tmp. */

const teste = (nome, a, b) => (typeof a === 'function' ? test(nome, { timeout: 30000 }, a) : test(nome, { timeout: 30000, ...a }, b));
const ehRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// Teardown e `chmod` por IDENTIDADE (descritor guardado na criação): nunca por prefixo nem por caminho (ver helpers/fixtures-descartaveis.js)
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-dst-test-' });
after(() => { fix.remover(); });
const nova = () => fix.criar();
const entrada = (id, raiz) => { const st = fs.lstatSync(raiz); return { id, raiz, identidade: { dev: st.dev, ino: st.ino } }; };
const validador = (ambiente, registro) => criarValidadorDeDestinos({ ambiente, registro });
const REG = (hml = [], prd = []) => ({ HOMOLOGACAO: hml, PRODUCAO: prd });
const codigo = (fn, c) => assert.throws(fn, (e) => e.code === c, c);

describe('[DS-A] autorização por lista explícita', () => {
  teste('DS-A01 — a lista do código é VAZIA nos dois ambientes: nenhum destino é autorizado, nem com raiz real e válida', () => {
    assert.deepEqual([DESTINOS_AUTORIZADOS.HOMOLOGACAO.length, DESTINOS_AUTORIZADOS.PRODUCAO.length], [0, 0]);
    const raiz = nova();
    for (const ambiente of ['HOMOLOGACAO', 'PRODUCAO']) {
      const v = criarValidadorDeDestinos({ ambiente });
      assert.equal(v.origem, 'OPERACIONAL');
      const r = v.validar({ destinoId: 'qualquer', raiz });
      assert.deepEqual([r.autorizado, r.motivo, ehDestinoValidado(r)], [false, 'DESTINO_NAO_AUTORIZADO', false]);
    }
  });

  teste('DS-A02 — a lista de teste só existe em NODE_ENV=test e gera origem TESTE_CONTROLADO (nunca OPERACIONAL); fora de teste é recusada', () => {
    const raiz = nova();
    const v = validador('HOMOLOGACAO', REG([entrada('hml-1', raiz)]));
    assert.equal(v.origem, 'TESTE_CONTROLADO');
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      codigo(() => criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: REG([entrada('hml-1', raiz)]) }), 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
  });

  teste('DS-A03 — registro malformado, ids repetidos, raiz relativa/com `..`, identidade ausente e SOBREPOSIÇÃO homologação x produção são recusados', () => {
    const a = nova();
    const b = nova();
    const e = (id, raiz) => entrada(id, raiz);
    const ruins = [
      null, {}, REG([{ id: 'x' }]), REG([e('hml-1', a), e('hml-1', b)]), REG([{ id: 'hml-1', raiz: 'relativo', identidade: { dev: 1, ino: 1 } }]),
      REG([{ id: 'hml-1', raiz: `${a}/../x`, identidade: { dev: 1, ino: 1 } }]), REG([{ id: 'hml-1', raiz: a }]), REG([{ id: 'hml-1', raiz: a, identidade: { dev: 1, ino: 0 } }]),
      REG([e('hml-1', a)], [e('prd-1', a)]),
      { ...REG(), extra: [] },
    ];
    for (const r of ruins) codigo(() => validador('HOMOLOGACAO', r), 'CONFIGURACAO_INVALIDA');
    const dentro = path.join(a, 'filho');
    fs.mkdirSync(dentro, { mode: 0o700 });
    codigo(() => validador('HOMOLOGACAO', REG([e('hml-1', a)], [e('prd-1', dentro)])), 'CONFIGURACAO_INVALIDA');
    codigo(() => criarValidadorDeDestinos({ ambiente: 'TESTE' }), 'CONFIGURACAO_INVALIDA');
  });

  teste('DS-A04 — um objeto fornecido pelo chamador NÃO é validação: literal, clone e resultado de outra fábrica não são reconhecidos', () => {
    const raiz = nova();
    const v = validador('HOMOLOGACAO', REG([entrada('hml-1', raiz)]));
    const real = v.validar({ destinoId: 'hml-1', raiz });
    assert.equal(ehDestinoValidado(real), true);
    for (const falso of [{ autorizado: true, destinoId: 'hml-1', ambiente: 'HOMOLOGACAO', origem: 'OPERACIONAL', raiz }, { ...real }, null, undefined, 'hml-1']) {
      assert.equal(ehDestinoValidado(falso), false);
      assert.deepEqual(verificarNomeLivre(falso, 'pkg-1'), { livre: false, motivo: 'DESTINO_NAO_VALIDADO' });
      assert.equal(contem(falso, path.join(raiz, 'pkg-1')), false);
    }
  });
});

describe('[DS-B] validação física do destino', () => {
  const montar = () => { const raiz = nova(); return { raiz, v: validador('PRODUCAO', REG([], [entrada('prd-1', raiz)])) }; };

  teste('DS-B01 — destino íntegro (dono, 0700, identidade, leitura e escrita) é autorizado; a validação é refeita a cada chamada', () => {
    const { raiz, v } = montar();
    const r = v.validar({ destinoId: 'prd-1', raiz });
    assert.deepEqual([r.autorizado, r.motivo, r.ambiente, r.destinoId], [true, null, 'PRODUCAO', 'prd-1']);
    fix.chmod(raiz, 0o750);
    assert.equal(v.validar({ destinoId: 'prd-1', raiz }).motivo, 'PERMISSAO_EXCESSIVA', 'sem cache: a mudança é vista');
  });

  teste('DS-B02 — raiz diferente da autorizada, id desconhecido, ambiente trocado e entrada malformada', () => {
    const { raiz, v } = montar();
    assert.equal(v.validar({ destinoId: 'prd-1', raiz: nova() }).motivo, 'RAIZ_DIFERENTE_DA_AUTORIZADA');
    assert.equal(v.validar({ destinoId: 'prd-9', raiz }).motivo, 'DESTINO_NAO_AUTORIZADO');
    const hml = validador('HOMOLOGACAO', REG([], [entrada('prd-1', raiz)]));
    assert.equal(hml.validar({ destinoId: 'prd-1', raiz }).motivo, 'DESTINO_NAO_AUTORIZADO', 'destino de produção não vale em homologação');
    for (const ruim of [null, {}, { destinoId: 'prd-1' }, { destinoId: 'prd-1', raiz, extra: 1 }]) codigo(() => v.validar(ruim), 'CONFIGURACAO_INVALIDA');
    assert.equal(v.validar({ destinoId: 'prd-1', raiz: `${raiz}/` }).autorizado, false);
  });

  teste('DS-B03 — link simbólico no lugar do destino ou no caminho é recusado', () => {
    const real = nova();
    const alvo = path.join(nova(), 'link');
    fs.symlinkSync(real, alvo);
    const st = fs.lstatSync(real);
    const v = validador('PRODUCAO', REG([], [{ id: 'prd-1', raiz: alvo, identidade: { dev: st.dev, ino: st.ino } }]));
    assert.equal(v.validar({ destinoId: 'prd-1', raiz: alvo }).motivo, 'LINK_SIMBOLICO');
    const pai = nova();
    const ligado = path.join(pai, 'ln');
    fs.symlinkSync(real, ligado);
    const caminho = path.join(ligado);
    const v2 = validador('PRODUCAO', REG([], [{ id: 'prd-2', raiz: path.join(caminho), identidade: { dev: st.dev, ino: st.ino } }]));
    assert.equal(v2.validar({ destinoId: 'prd-2', raiz: caminho }).motivo, 'LINK_SIMBOLICO');
  });

  teste('DS-B04 — identidade DIVERGENTE: outro diretório no mesmo caminho (troca) é recusado', () => {
    const { raiz, v } = montar();
    const lateral = `${raiz}-antigo`;
    fs.renameSync(raiz, lateral);
    fix.renomeado(raiz, lateral);
    fs.mkdirSync(raiz, { mode: 0o700 });
    fix.adotar(raiz); // o substituto também foi criado por este teste: o teardown o remove pela NOVA identidade
    assert.equal(v.validar({ destinoId: 'prd-1', raiz }).motivo, 'IDENTIDADE_DIVERGENTE');
  });

  teste('DS-B05 — arquivo no lugar de diretório e destino removido', () => {
    const raiz = nova();
    const arquivo = path.join(raiz, 'a');
    fs.writeFileSync(arquivo, 'x', { mode: 0o600 });
    const st = fs.lstatSync(arquivo);
    const v = validador('PRODUCAO', REG([], [{ id: 'prd-1', raiz: arquivo, identidade: { dev: st.dev, ino: st.ino } }]));
    assert.equal(v.validar({ destinoId: 'prd-1', raiz: arquivo }).motivo, 'NAO_E_DIRETORIO');
    const { raiz: r2, v: v2 } = montar();
    fs.rmdirSync(r2);
    assert.equal(v2.validar({ destinoId: 'prd-1', raiz: r2 }).motivo, 'DESTINO_INACESSIVEL');
  });

  teste('DS-B06 — PERMISSÕES: acesso para grupo/outros é excessivo; sem escrita para o dono é insuficiente (pulado como root)', { skip: ehRoot }, () => {
    const { raiz, v } = montar();
    fix.chmod(raiz, 0o777);
    assert.equal(v.validar({ destinoId: 'prd-1', raiz }).motivo, 'PERMISSAO_EXCESSIVA');
    fix.chmod(raiz, 0o500);
    assert.equal(v.validar({ destinoId: 'prd-1', raiz }).motivo, 'PERMISSAO_INSUFICIENTE');
    fix.chmod(raiz, 0o200);
    assert.equal(v.validar({ destinoId: 'prd-1', raiz }).motivo, 'PERMISSAO_INSUFICIENTE');
  });

  teste('DS-B07 — falhas NÃO vazam caminho, dono, modo nem segredo: só código, id e ambiente', () => {
    const { raiz, v } = montar();
    fix.chmod(raiz, 0o755);
    const r = v.validar({ destinoId: 'prd-1', raiz });
    const texto = JSON.stringify(r);
    assert.equal(texto.includes(raiz) || texto.includes(os.tmpdir()), false);
    assert.deepEqual(Object.keys(r).sort(), ['ambiente', 'autorizado', 'destinoId', 'motivo']);
    const desconhecido = v.validar({ destinoId: '../../etc', raiz });
    assert.equal(desconhecido.destinoId, null, 'id fora do formato nem é ecoado');
  });
});

describe('[DS-C] nome livre e contenção', () => {
  teste('DS-C01 — nunca sobrescreve: nome existente (arquivo, diretório ou link, inclusive quebrado) é recusado; nome inválido também', () => {
    const raiz = nova();
    const v = validador('PRODUCAO', REG([], [entrada('prd-1', raiz)]));
    const val = v.validar({ destinoId: 'prd-1', raiz });
    assert.deepEqual(verificarNomeLivre(val, 'pkg-1'), { livre: true, motivo: null });
    fs.mkdirSync(path.join(raiz, 'pkg-1'));
    fs.writeFileSync(path.join(raiz, 'pkg-2'), 'x');
    fs.symlinkSync('/nao/existe', path.join(raiz, 'pkg-3'));
    for (const nome of ['pkg-1', 'pkg-2', 'pkg-3']) assert.deepEqual(verificarNomeLivre(val, nome), { livre: false, motivo: 'NOME_EM_USO' }, nome);
    for (const nome of ['', '../x', 'a/b', '.oculto', 'x'.repeat(200), 7, null]) assert.deepEqual(verificarNomeLivre(val, nome), { livre: false, motivo: 'NOME_INVALIDO' }, String(nome));
  });

  teste('DS-C02 — `contem` recusa a própria raiz, `..`, prefixo parecido, caminho relativo e NUL', () => {
    const raiz = nova();
    const val = validador('PRODUCAO', REG([], [entrada('prd-1', raiz)])).validar({ destinoId: 'prd-1', raiz });
    assert.equal(contem(val, path.join(raiz, 'pkg-1', 'dump')), true);
    for (const fora of [raiz, `${raiz}/`, `${raiz}/../outro`, `${raiz}-irmao/x`, path.dirname(raiz), 'relativo/x', `${raiz}/a\0b`, '', null]) assert.equal(contem(val, fora), false, String(fora));
  });
});
