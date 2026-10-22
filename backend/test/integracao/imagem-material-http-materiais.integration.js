'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbienteHttpImagens } = require('./helpers/imagem-material-http');

/**
 * Biblioteca de Imagens, Unidade 4 (RED) — o campo `imagem` nas rotas REAIS de materiais (`src/routes/material.routes.js`, schema
 * `src/schemas/material.schema.js`, controller e serviço existentes). Contrato:
 *   POST  /api/materiais         (materials.criar)   body.imagem?: { origem:'PADRAO'|'EMPRESA', id } | null   → 201 { material: { …, imagem } }
 *   PATCH /api/materiais/:id     (materials.editar)  body.imagem ausente = não mexer; null = remover; objeto = associar → 200 { material: { …, imagem } }
 *   GET   /api/materiais/:id e GET /api/materiais (materials.visualizar) → `imagem: null | { origem, id, versao, nome }` em cada material
 * `id` da imagem = inteiro seguro ou texto decimal canônico (BIGINT); malformado = 400 VALIDACAO em body.imagem…; imagem inexistente, de outra
 * empresa ou inativa = 404 IMAGEM_NAO_ENCONTRADA uniforme e NADA gravado. Todos os demais campos e regras do material permanecem.
 *
 * RED: hoje o schema é strictObject sem `imagem` (400 CAMPO_NAO_PERMITIDO) e a resposta não traz `imagem`; os controles marcados passam já.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const ok = (r, status = 200) => { assert.equal(r.status, status, aviso(r)); assert.equal(r.body.status, 'ok'); return r.body; };
const erro = (r, status, codigo) => { assert.equal(r.status, status, aviso(r)); assert.deepEqual([r.body.status, r.body.codigo], ['error', codigo]); return r.body; };
const CHAVES_DO_MATERIAL_HOJE = ['ativo', 'atualizadoEm', 'categoria', 'categoriaDescricao', 'codigoInterno', 'criadoEm', 'descricao', 'empresaId', 'estoqueMinimo', 'exigeTamanho', 'fabricante', 'grupoProtecao', 'grupoProtecaoDescricao', 'id', 'modeloClassificacao', 'nome', 'oculosComGrau', 'prazoUsoDias', 'tamanhos', 'tipo', 'tipoDescricao', 'tipoMaterialAtivo', 'tipoMaterialId', 'unidade'];

// Verifica campos tipados, não a presença textual de um ID em nomes, datas ou outros identificadores.
// IDs de imagem são textos BIGINT; PADRAO e EMPRESA possuem espaços de identificação distintos.
function conferirIsolamento(lista, { empresaId, materiaisDeA, imagemDeA, materialDeB, imagemDeB }) {
  assert.ok(Array.isArray(lista), 'a listagem deve ser um array');
  const ids = new Set();
  for (const m of lista) {
    assert.ok(Number.isSafeInteger(m.id) && m.id > 0, 'ID de material inválido');
    assert.equal(ids.has(m.id), false, 'material duplicado na listagem');
    ids.add(m.id);
    assert.equal(m.empresaId, empresaId, 'material de outra empresa na listagem');
    assert.equal(materiaisDeA.includes(m.id), false, 'material privado de A na listagem de B');
    assert.equal(Object.hasOwn(m, 'imagem'), true, 'campo imagem ausente');
    if (m.imagem === null) continue;
    assert.deepEqual(Object.keys(m.imagem).sort(), ['id', 'nome', 'origem', 'versao'], 'projeção pública da imagem');
    assert.ok(['EMPRESA', 'PADRAO'].includes(m.imagem.origem), 'origem de imagem inválida');
    assert.equal(typeof m.imagem.id, 'string', 'ID BIGINT deve permanecer texto');
    assert.match(m.imagem.id, /^[1-9][0-9]*$/);
    assert.ok(Number.isInteger(m.imagem.versao) && m.imagem.versao > 0, 'versão de imagem inválida');
    assert.equal(typeof m.imagem.nome, 'string');
    if (m.imagem.origem === 'EMPRESA') assert.notEqual(m.imagem.id, imagemDeA, 'imagem privada de A na listagem de B');
  }
  const propria = lista.filter((m) => m.id === materialDeB);
  assert.equal(propria.length, 1, 'material próprio de B deve estar presente uma única vez');
  assert.deepEqual(propria[0].imagem, imagemDeB, 'imagem própria de B deve ser retornada integralmente');
}

describe('Isolamento estrutural de materiais — sem banco', () => {
  const contexto = {
    empresaId: 2, materiaisDeA: [1, 3], imagemDeA: '11', materialDeB: 111,
    imagemDeB: { origem: 'EMPRESA', id: '9007199254740993', versao: 1, nome: 'Imagem 11 da B' },
  };
  const legitima = () => [
    { id: 111, empresaId: 2, nome: 'Material 11 da B', criadoEm: '2026-11-01', imagem: { ...contexto.imagemDeB } },
    { id: 112, empresaId: 2, imagem: null },
    { id: 113, empresaId: 2, imagem: { origem: 'PADRAO', id: '11', versao: 1, nome: 'Imagem global' } },
  ];
  const rejeita = (lista, mensagem) => assert.throws(
    () => conferirIsolamento(lista, contexto),
    (e) => e instanceof assert.AssertionError && mensagem.test(e.message),
  );

  test('coincidências em nomes, datas, IDs e imagem PADRAO são legítimas; BIGINT não perde precisão', () => {
    const lista = legitima();
    // Contraprova do critério antigo: ele reprova esta resposta legítima.
    assert.throws(() => assert.equal(JSON.stringify(lista).includes(contexto.imagemDeA), false), assert.AssertionError);
    assert.doesNotThrow(() => conferirIsolamento(lista, contexto));
    assert.equal(lista[0].imagem.id, '9007199254740993');
  });

  test('contaminar a resposta com um material de A é detectado pela empresa', () => {
    rejeita([...legitima(), { id: 1, empresaId: 1, imagem: null }], /material de outra empresa/);
  });

  test('mesmo com empresaId adulterado, o ID do material privado de A é recusado', () => {
    rejeita([...legitima(), { id: 1, empresaId: 2, imagem: null }], /material privado de A/);
  });

  test('contaminar a imagem de um material de B com a imagem privada de A é detectado', () => {
    const lista = legitima();
    lista[1].imagem = { origem: 'EMPRESA', id: '11', versao: 1, nome: 'Privada da A' };
    rejeita(lista, /imagem privada de A/);
  });

  test('resposta vazia, material próprio ausente e imagem própria trocada não passam por vacuidade', () => {
    rejeita([], /material próprio de B/);
    rejeita(legitima().slice(1), /material próprio de B/);
    const lista = legitima();
    lista[0].imagem = null;
    rejeita(lista, /imagem própria de B/);
  });

  test('campo interno adicional de imagem e omissão do campo imagem são recusados', () => {
    const lista = legitima();
    lista[0].imagem.sha256 = 'interno';
    rejeita(lista, /projeção pública da imagem/);
    const ausente = legitima();
    delete ausente[1].imagem;
    rejeita(ausente, /campo imagem ausente/);
  });
});

describe('Materiais — campo `imagem` por HTTP (PostgreSQL real)', () => {
  let a;
  let A;
  let B;
  let master;
  let masterB;
  let soVisualizar;
  let soCriar;

  before(async () => {
    a = await montarAmbienteHttpImagens();
    ({ empresaA: A, empresaB: B } = a.d);
    master = a.como(a.d.master);
    masterB = a.como(a.d.masterB);
    soVisualizar = a.como(await a.usuarioCom(A, { materials: ['visualizar'] }));
    soCriar = a.como(await a.usuarioCom(A, { materials: ['criar'] }));
  });
  after(async () => { if (a) await a.encerrar(); });

  const propria = (extra) => a.imagemDaEmpresa(A, a.d.master, extra);
  const criar = (extra = {}, quem = master) => quem.post('/api/materiais').send(a.corpoDeMaterial(extra));
  const alterar = (id, corpo, quem = master) => quem.patch(`/api/materiais/${id}`).send(corpo);
  const semImagem = (corpo) => { const t = JSON.stringify(corpo); for (const p of ['sha256', 'bytes', 'caminho', 'chave', 'criadoPor']) assert.equal(t.includes(p), false, `vazou ${p}`); };

  describe('controles (devem passar já no RED)', () => {
    test('K1 — o cadastro ATUAL continua igual: POST sem imagem é 201 com as chaves de hoje; PATCH do nome 200; GET 200; inativar/reativar 200', async () => {
      const m = ok(await criar(), 201).material;
      for (const chave of CHAVES_DO_MATERIAL_HOJE) assert.ok(chave in m, `chave ${chave} continua na resposta`);
      ok(await alterar(m.id, { nome: 'Renomeado K1' }));
      assert.equal(ok(await master.get(`/api/materiais/${m.id}`)).material.nome, 'Renomeado K1');
      ok(await master.post(`/api/materiais/${m.id}/inativar`).send({}));
      ok(await master.post(`/api/materiais/${m.id}/reativar`).send({}));
    });
  });

  describe('[ASS] criar com imagem', () => {
    test('ASS-01 — POST com imagem da EMPRESA (id como texto OU como inteiro) → 201 e material.imagem = { origem, id (texto), versao, nome }; as colunas do material apontam para ela', async () => {
      const img = await propria({ nome: 'Luva ASS01' });
      for (const id of [img.id, Number(img.id)]) {
        const m = ok(await criar({ imagem: { origem: 'EMPRESA', id } }), 201).material;
        assert.deepEqual(m.imagem, { origem: 'EMPRESA', id: img.id, versao: 1, nome: 'Luva ASS01' });
        assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: img.id });
        semImagem(m);
      }
    });

    test('ASS-02 — POST com imagem PADRÃO → 201, imagem.origem = PADRAO e só imagem_padrao_id preenchida; a mesma padrão serve a materiais de empresas diferentes', async () => {
      const p = await a.padrao({ nome: 'Padrão ASS02' });
      const m = ok(await criar({ imagem: { origem: 'PADRAO', id: String(p.id) } }), 201).material;
      assert.deepEqual(m.imagem, { origem: 'PADRAO', id: String(p.id), versao: 1, nome: 'Padrão ASS02' });
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: String(p.id), imagem_empresa_id: null });
      const deB = ok(await criar({ imagem: { origem: 'PADRAO', id: String(p.id) } }, masterB), 201).material;
      assert.equal(deB.imagem.id, String(p.id));
    });

    test('ASS-03 — POST sem imagem (ou com imagem: null) → 201 com `imagem: null` PRESENTE na resposta e todas as chaves de hoje preservadas', async () => {
      for (const extra of [{}, { imagem: null }]) {
        const m = ok(await criar(extra), 201).material;
        assert.equal('imagem' in m, true, 'a chave imagem existe na resposta');
        assert.equal(m.imagem, null);
        for (const chave of CHAVES_DO_MATERIAL_HOJE) assert.ok(chave in m, chave);
        assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      }
    });

    test('ASS-04 — POST com imagem de OUTRA empresa, inexistente, privada INATIVA ou padrão inativa → o MESMO 404 IMAGEM_NAO_ENCONTRADA (corpo idêntico) e NENHUM material criado', async () => {
      const deB = await a.imagemDaEmpresa(B, a.d.masterB);
      const inativa = await propria();
      await a.q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [inativa.id]);
      const padraoInativa = await a.padrao({ ativo: false });
      const antes = await a.contagem('materiais', 'empresa_id = $1', [A]);
      const corpos = new Set();
      for (const imagem of [{ origem: 'EMPRESA', id: deB.id }, { origem: 'EMPRESA', id: '987654321991' }, { origem: 'EMPRESA', id: inativa.id }, { origem: 'PADRAO', id: String(padraoInativa.id) }, { origem: 'PADRAO', id: '987654321992' }]) {
        const r = await criar({ imagem });
        erro(r, 404, 'IMAGEM_NAO_ENCONTRADA');
        corpos.add(JSON.stringify(r.body));
      }
      assert.equal(corpos.size, 1, 'um corpo só: não revela se o id existe, de quem é ou se está inativo');
      assert.equal(await a.contagem('materiais', 'empresa_id = $1', [A]), antes);
    });

    test('ASS-05 — POST com imagem malformada → 400 VALIDACAO apontando body.imagem (ou um campo dentro dela) e nada criado: origem em minúsculas/desconhecida, id "05"/"abc"/0/−1/1.5/acima de 2^53 como número/acima de 2^63−1, chave extra (caminho, versao), string, array, número', async () => {
      const antes = await a.contagem('materiais', 'empresa_id = $1', [A]);
      const invalidas = [
        { origem: 'empresa', id: '1' }, { origem: 'OUTRA', id: '1' }, { origem: 'EMPRESA', id: '05' }, { origem: 'EMPRESA', id: 'abc' }, { origem: 'EMPRESA', id: 0 }, { origem: 'EMPRESA', id: -1 },
        { origem: 'EMPRESA', id: 1.5 }, { origem: 'EMPRESA', id: 9007199254740993 }, { origem: 'EMPRESA', id: '9223372036854775808' }, { origem: 'EMPRESA', id: '1', caminho: '/x' },
        { origem: 'EMPRESA', id: '1', versao: 2 }, { origem: 'EMPRESA' }, { id: '1' }, 'x', [], 7, true,
      ];
      for (const imagem of invalidas) {
        const b = erro(await criar({ imagem }), 400, 'VALIDACAO');
        assert.equal(b.detalhes.some((d) => d.campo.startsWith('body.imagem')), true, JSON.stringify(imagem));
      }
      assert.equal(await a.contagem('materiais', 'empresa_id = $1', [A]), antes);
    });

    test('ASS-06 — auditoria MATERIAL_CRIADO leva imagem { origem, id } só quando informada; nunca hash, bytes ou caminho', async () => {
      const img = await propria();
      const com = ok(await criar({ imagem: { origem: 'EMPRESA', id: img.id } }), 201).material;
      const sem = ok(await criar(), 201).material;
      const [logCom] = await a.auditorias('MATERIAL_CRIADO', com.id);
      const [logSem] = await a.auditorias('MATERIAL_CRIADO', sem.id);
      assert.deepEqual(logCom.dados_novos.imagem, { origem: 'EMPRESA', id: img.id });
      assert.equal('imagem' in logSem.dados_novos, false);
      // Só os dados do ATO (não o `contexto`, que desde o Bloco 9 leva { criadoPor } do ator — comportamento preexistente e legítimo): a imagem
      // aparece como { origem, id } e nunca com hash, bytes, miniatura ou caminho.
      const dados = JSON.stringify([logCom.dados_novos, logCom.dados_anteriores]);
      for (const proibido of ['sha256', 'bytes', 'caminho', 'chave', 'miniatura']) assert.equal(dados.includes(proibido), false, `a auditoria vazou ${proibido}`);
    });
  });

  describe('[ALT] alterar a imagem', () => {
    test('ALT-01 — PATCH só com { imagem } é alteração válida (não é MATERIAL_SEM_ALTERACAO); troca EMPRESA → PADRAO zera a outra coluna; a resposta traz a imagem nova', async () => {
      const x = await propria({ nome: 'X ALT01' });
      const p = await a.padrao({ nome: 'P ALT01' });
      const m = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      const r = ok(await alterar(m.id, { imagem: { origem: 'PADRAO', id: String(p.id) } })).material;
      assert.deepEqual(r.imagem, { origem: 'PADRAO', id: String(p.id), versao: 1, nome: 'P ALT01' });
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: String(p.id), imagem_empresa_id: null });
    });

    test('ALT-02 — PATCH com imagem: null remove a associação (resposta imagem: null); a imagem continua na biblioteca', async () => {
      const x = await propria({ nome: 'X ALT02' });
      const m = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      const r = ok(await alterar(m.id, { imagem: null })).material;
      assert.equal(r.imagem, null);
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.equal((await a.linhaDaImagem(x.id)).estado, 'ATIVA');
    });

    test('ALT-03 — PATCH sem o campo imagem (só o nome) PRESERVA a associação, e a resposta continua trazendo a imagem atual', async () => {
      const x = await propria({ nome: 'X ALT03' });
      const m = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      const r = ok(await alterar(m.id, { nome: 'Nome novo ALT03' })).material;
      assert.deepEqual([r.nome, r.imagem], ['Nome novo ALT03', { origem: 'EMPRESA', id: x.id, versao: 1, nome: 'X ALT03' }]);
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: x.id });
    });

    test('ALT-04 — PATCH com nome válido e imagem inválida (outra empresa/inexistente/inativa) → 404 e NADA muda (tudo ou nada); imagem malformada → 400 e nada muda', async () => {
      const deB = await a.imagemDaEmpresa(B, a.d.masterB);
      const m = ok(await criar({ nome: 'Original ALT04' }), 201).material;
      erro(await alterar(m.id, { nome: 'Não pode ficar', imagem: { origem: 'EMPRESA', id: deB.id } }), 404, 'IMAGEM_NAO_ENCONTRADA');
      erro(await alterar(m.id, { nome: 'Não pode ficar', imagem: { origem: 'EMPRESA', id: '05' } }), 400, 'VALIDACAO');
      const atual = ok(await master.get(`/api/materiais/${m.id}`)).material;
      assert.deepEqual([atual.nome, atual.imagem], ['Original ALT04', null]);
    });

    test('ALT-05 — material de OUTRA empresa com imagem válida de quem chama → 404 MATERIAL_NAO_ENCONTRADO (o material é conferido antes da imagem) e nada muda', async () => {
      const x = await propria();
      const deB = ok(await criar({}, masterB), 201).material;
      erro(await alterar(deB.id, { imagem: { origem: 'EMPRESA', id: x.id } }), 404, 'MATERIAL_NAO_ENCONTRADO');
      assert.deepEqual(await a.imagemDoMaterial(deB.id), { imagem_padrao_id: null, imagem_empresa_id: null });
    });

    test('ALT-06 — permissões da matriz: só visualizar → 403 no PATCH com imagem; só criar → 201 no POST com imagem, mas 403 no PATCH', async () => {
      const x = await propria();
      const m = ok(await criar(), 201).material;
      erro(await alterar(m.id, { imagem: { origem: 'EMPRESA', id: x.id } }, soVisualizar), 403, 'PERMISSAO_NEGADA');
      const criado = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }, soCriar), 201).material;
      assert.equal(criado.imagem.id, x.id);
      erro(await alterar(criado.id, { imagem: null }, soCriar), 403, 'PERMISSAO_NEGADA');
      assert.deepEqual(await a.imagemDoMaterial(criado.id), { imagem_padrao_id: null, imagem_empresa_id: x.id });
    });
  });

  describe('[LER] leitura', () => {
    test('LER-01 — GET /api/materiais/:id e GET /api/materiais trazem `imagem` (null ou { origem, id, versao, nome }) em cada material, sem campos internos; nunca a imagem de outra empresa', async () => {
      const x = await propria({ nome: 'X LER01' });
      const com = ok(await criar({ nome: 'Com imagem LER01', imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      const sem = ok(await criar({ nome: 'Sem imagem LER01' }), 201).material;
      const um = ok(await master.get(`/api/materiais/${com.id}`)).material;
      assert.deepEqual(um.imagem, { origem: 'EMPRESA', id: x.id, versao: 1, nome: 'X LER01' });
      const lista = ok(await master.get('/api/materiais?busca=LER01&limite=100')).materiais;
      assert.deepEqual(lista.map((m) => [m.id, m.imagem === null ? null : m.imagem.id]).sort((u, v) => u[0] - v[0]), [[com.id, x.id], [sem.id, null]].sort((u, v) => u[0] - v[0]));
      for (const m of lista) assert.equal('imagem' in m, true);
      semImagem(lista);
      const imagemB = await a.imagemDaEmpresa(B, a.d.masterB, { nome: `Imagem ${x.id} da B LER01` });
      const deB = ok(await criar({ nome: `Material ${x.id} da B LER01`, imagem: { origem: 'EMPRESA', id: imagemB.id } }, masterB), 201).material;
      const esperadaB = { origem: 'EMPRESA', id: imagemB.id, versao: 1, nome: `Imagem ${x.id} da B LER01` };
      const daB = ok(await masterB.get('/api/materiais?limite=100')).materiais;
      const contextoB = { empresaId: B, materiaisDeA: [com.id, sem.id], imagemDeA: x.id, materialDeB: deB.id, imagemDeB: esperadaB };
      assert.equal(JSON.stringify(daB).includes(x.id), true, 'coincidência legítima no nome: a comparação textual antiga reprovaria');
      conferirIsolamento(daB, contextoB);
      semImagem(daB);
      for (const m of daB) {
        if (m.imagem?.origem === 'EMPRESA') {
          const privada = await a.linhaDaImagem(m.imagem.id);
          assert.ok(privada, 'toda imagem privada retornada deve existir');
          assert.equal(privada.empresa_id, B, 'a imagem privada pertence à empresa da sessão');
        }
      }
      const proprio = ok(await masterB.get(`/api/materiais/${deB.id}`)).material;
      assert.deepEqual(proprio.imagem, esperadaB);
      semImagem(proprio);
      erro(await masterB.get(`/api/materiais/${com.id}`), 404, 'MATERIAL_NAO_ENCONTRADO');
      erro(await master.get(`/api/materiais/${deB.id}`), 404, 'MATERIAL_NAO_ENCONTRADO');
      erro(await soCriar.get(`/api/materiais/${com.id}`), 403, 'PERMISSAO_NEGADA');
      erro(await a.anonimo().get(`/api/materiais/${com.id}`), 401, 'SESSAO_INVALIDA');

      // O MESMO verificador usado na resposta HTTP deve reprovar contaminações deliberadas.
      assert.throws(() => conferirIsolamento([...daB, com], contextoB), assert.AssertionError);
      const contaminada = daB.map((m) => m.id === deB.id ? { ...m, imagem: { ...um.imagem } } : m);
      assert.throws(() => conferirIsolamento(contaminada, contextoB), assert.AssertionError);
    });

    test('LER-02 — a imagem que ficou INATIVA depois de associada continua na resposta do material (a associação sobrevive); quem só vê materiais a lê (visualizar)', async () => {
      const x = await propria({ nome: 'X LER02' });
      const m = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      await a.q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [x.id]);
      const lido = ok(await soVisualizar.get(`/api/materiais/${m.id}`)).material;
      assert.deepEqual(lido.imagem, { origem: 'EMPRESA', id: x.id, versao: 1, nome: 'X LER02' });
    });
  });

  describe('[REG] preservação', () => {
    test('REG-01 — inativar e reativar o MATERIAL não mexem na imagem; a unidade continua imutável (400) e `ativo`/`empresaId` continuam recusados no corpo', async () => {
      const x = await propria();
      const m = ok(await criar({ imagem: { origem: 'EMPRESA', id: x.id } }), 201).material;
      ok(await master.post(`/api/materiais/${m.id}/inativar`).send({}));
      ok(await master.post(`/api/materiais/${m.id}/reativar`).send({}));
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: x.id });
      erro(await alterar(m.id, { unidade: 'par' }), 400, 'VALIDACAO');
      erro(await alterar(m.id, { ativo: false, imagem: null }), 400, 'VALIDACAO');
      erro(await criar({ empresaId: B, imagem: { origem: 'EMPRESA', id: x.id } }), 400, 'VALIDACAO');
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: x.id });
    });
  });
});
