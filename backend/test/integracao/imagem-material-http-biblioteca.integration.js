'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbienteHttpImagens, ORIGEM_PERMITIDA } = require('./helpers/imagem-material-http');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 4 (RED) — rotas HTTP da BIBLIOTECA (padrão SafeWork, somente leitura; privada da empresa, gestão), sobre os
 * serviços da Unidade 3. Contrato (todas sob /api, sessão administrativa; empresa e ator SÓ da sessão):
 *
 *   GET    /api/imagens-material                      materials.visualizar  query estrita: origem=TODAS|PADRAO|EMPRESA (TODAS), busca ≤100,
 *                                                                           tipoNome ≤100, estado=ATIVA|INATIVA|TODAS (ATIVA; só a privada), pagina, limite 1–100
 *                                                     200 { status:'ok', imagens:[...], total, pagina, limite }
 *   PATCH  /api/imagens-material/empresa/:id          materials.editar      { nome }            → 200 { status:'ok', imagem, alterado }
 *   POST   /api/imagens-material/empresa/:id/inativar materials.editar      {}                  → 200 { status:'ok', imagem, alterado } | 409 IMAGEM_EM_USO
 *   POST   /api/imagens-material/empresa/:id/reativar materials.editar      {}                  → 200 { status:'ok', imagem, alterado }
 *   DELETE /api/imagens-material/empresa/:id          materials.editar      { confirmacao: true } → 200 { status:'ok', excluida:true, imagemId } | 409 IMAGEM_EM_USO
 *   (DELETE com corpo validado é convenção existente: DELETE /autorizacoes-individuais/:id.)
 *   Biblioteca padrão: NENHUMA rota de escrita (404 ROTA_NAO_ENCONTRADA); o id de uma padrão nas rotas da empresa é 404 IMAGEM_NAO_ENCONTRADA.
 *   `:id` é BIGINT em texto decimal canônico; inexistente e de outra empresa = o MESMO 404. Nenhuma resposta traz hash, bytes, chave, caminho,
 *   criador ou empresa. O upload (registro por processamento) e a entrega dos arquivos são de outra unidade (imagem-material-http-upload-entrega).
 *
 * RED: hoje as rotas não existem (404 ROTA_NAO_ENCONTRADA em tudo); cada teste falha por isso. Os controles marcados passam já.
 */

const BASE = '/api/imagens-material';
const CHAVES_PADRAO = ['altura', 'emUso', 'id', 'ilustrativa', 'largura', 'nome', 'origem', 'sugerida', 'versao'];
const CHAVES_EMPRESA = ['altura', 'emUso', 'estado', 'formato', 'id', 'largura', 'nome', 'origem', 'sugerida', 'versao'];
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const ok = (r, status = 200) => { assert.equal(r.status, status, aviso(r)); assert.equal(r.body.status, 'ok'); return r.body; };
const erro = (r, status, codigo) => { assert.equal(r.status, status, aviso(r)); assert.deepEqual([r.body.status, r.body.codigo], ['error', codigo]); return r.body; };

describe('Biblioteca de Imagens — rotas HTTP da biblioteca (PostgreSQL real)', () => {
  let a;
  let A;
  let B;
  let master;
  let masterB;
  let soVisualizar;
  let soEditar;
  let semNada;

  before(async () => {
    a = await montarAmbienteHttpImagens();
    ({ empresaA: A, empresaB: B } = a.d);
    master = a.como(a.d.master);
    masterB = a.como(a.d.masterB);
    soVisualizar = a.como(await a.usuarioCom(A, { materials: ['visualizar'] }));
    soEditar = a.como(await a.usuarioCom(A, { materials: ['editar'] }));
    semNada = a.como(await a.usuarioCom(A, {}));
  });
  after(async () => { if (a) await a.encerrar(); });

  const propria = (extra) => a.imagemDaEmpresa(A, a.d.master, extra);
  const emUsoPor = async (imagemId) => { const m = await a.material(A, `Material em uso ${imagemId}`, { exigeTamanho: false }); await a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m, imagemId]); return m; };
  const url = (id, sufixo = '') => `${BASE}/empresa/${id}${sufixo}`;

  describe('controles (devem passar já no RED)', () => {
    test('K1 — o ambiente serve as rotas REAIS de materiais com a sessão de teste: o MASTER cadastra um material sem imagem (201)', async () => {
      const r = await master.post('/api/materiais').send(a.corpoDeMaterial());
      assert.equal(r.status, 201, aviso(r));
    });

    test('K2 — o cliente NUNCA registra imagem por JSON (descritor forjado): qualquer POST JSON em /empresa não cria linha (404 enquanto a rota de upload não existe; 415 depois, porque ela só aceita imagem binária)', async () => {
      const antes = await a.contagem('imagens_empresa');
      const r = await master.post(`${BASE}/empresa`).send({ nome: 'forjada', sha256: 'a'.repeat(64), sha256Mestre: 'b'.repeat(64), sha256Exibicao: 'c'.repeat(64), sha256Miniatura: 'd'.repeat(64), formato: 'PNG', largura: 1024, altura: 1024, bytesMestre: 1, bytesExibicao: 1, bytesMiniatura: 1 });
      assert.ok([404, 415].includes(r.status), aviso(r));
      assert.equal(await a.contagem('imagens_empresa'), antes);
    });
  });

  describe('[ROTA] a camada HTTP da biblioteca', () => {
    test('ROTA-01 — o módulo de rotas da biblioteca existe e exporta a fábrica no molde de material.routes.js', () => {
      const rotas = exigirModulo('src/routes/imagem-material.routes');
      assert.equal(typeof rotas.criarImagemMaterialRoutes, 'function');
      const controller = exigirModulo('src/controllers/imagem-material.controller');
      assert.equal(typeof controller.criarImagemMaterialController, 'function');
    });
  });

  describe('[LST] listagem e pesquisa', () => {
    test('LST-01 — TODAS: padrão primeiro (ilustrativa), depois a privada ATIVA; chaves exatas por origem; id como texto; total = padrão + privada', async () => {
      const p = await a.padrao({ nome: 'Padrão LST01' });
      const e = await propria({ nome: 'Privada LST01' });
      const corpo = ok(await master.get(`${BASE}?busca=LST01`));
      assert.deepEqual(Object.keys(corpo).sort(), ['imagens', 'limite', 'pagina', 'status', 'total']);
      assert.deepEqual(corpo.imagens.map((i) => [i.origem, i.id, i.nome]), [['PADRAO', String(p.id), 'Padrão LST01'], ['EMPRESA', e.id, 'Privada LST01']]);
      assert.deepEqual(Object.keys(corpo.imagens[0]).sort(), CHAVES_PADRAO);
      assert.deepEqual(Object.keys(corpo.imagens[1]).sort(), CHAVES_EMPRESA);
      assert.deepEqual([corpo.imagens[0].ilustrativa, corpo.imagens[1].estado, corpo.total, corpo.pagina, corpo.limite], [true, 'ATIVA', 2, 1, 20]);
      for (const i of corpo.imagens) assert.equal(typeof i.id, 'string');
      a.semCamposInternos(corpo, 'LST-01');
    });

    test('LST-02 — origem=PADRAO e origem=EMPRESA filtram; padrão inativa nunca aparece; privada INATIVA só com estado=TODAS ou INATIVA', async () => {
      await a.padrao({ nome: 'Padrão viva LST02' });
      await a.padrao({ nome: 'Padrão morta LST02', ativo: false });
      const inativa = await propria({ nome: 'Privada inativa LST02' });
      await a.q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [inativa.id]);
      await propria({ nome: 'Privada viva LST02' });
      const nomes = async (query) => ok(await master.get(`${BASE}?busca=LST02${query}`)).imagens.map((i) => i.nome);
      assert.deepEqual(await nomes('&origem=PADRAO'), ['Padrão viva LST02']);
      assert.deepEqual(await nomes('&origem=EMPRESA'), ['Privada viva LST02']);
      assert.deepEqual(await nomes('&origem=EMPRESA&estado=INATIVA'), ['Privada inativa LST02']);
      assert.deepEqual(await nomes('&origem=EMPRESA&estado=TODAS'), ['Privada inativa LST02', 'Privada viva LST02']);
      assert.deepEqual(await nomes(''), ['Padrão viva LST02', 'Privada viva LST02']);
    });

    test('LST-03 — busca sem acento e sem caixa; tipoNome só DESTACA (sugerida PRINCIPAL antes de ALTERNATIVA) e nada é selecionado', async () => {
      const alt = await a.padrao({ nome: 'Beta alternativa LST03' });
      const princ = await a.padrao({ nome: 'Gama principal LST03' });
      await a.padrao({ nome: 'Ômega sem sugestão LST03' });
      await a.sugestao(alt.id, 'Tipo LST03', 'ALTERNATIVA');
      await a.sugestao(princ.id, 'Tipo LST03', 'PRINCIPAL');
      const com = ok(await master.get(`${BASE}?origem=PADRAO&busca=lst03&tipoNome=${encodeURIComponent('Tipo LST03')}`));
      assert.deepEqual(com.imagens.map((i) => [i.nome, i.sugerida]), [['Gama principal LST03', 'PRINCIPAL'], ['Beta alternativa LST03', 'ALTERNATIVA'], ['Ômega sem sugestão LST03', null]]);
      const sem = ok(await master.get(`${BASE}?origem=PADRAO&busca=${encodeURIComponent('omega sem sugestao')}`));
      assert.deepEqual(sem.imagens.map((i) => [i.nome, i.sugerida]), [['Ômega sem sugestão LST03', null]]);
      assert.equal(JSON.stringify(com).includes('selecionad'), false);
    });

    test('LST-04 — isolamento: a empresa B não vê a privada de A (e vice-versa); a padrão é igual para as duas; emUso conta só os materiais da PRÓPRIA empresa', async () => {
      const deA = await propria({ nome: 'Privada de A LST04' });
      const deB = await a.imagemDaEmpresa(B, a.d.masterB, { nome: 'Privada de B LST04' });
      const p = await a.padrao({ nome: 'Padrão LST04' });
      await a.q('UPDATE materiais SET imagem_padrao_id = $2 WHERE id = $1', [await a.material(A, 'M-A1 LST04', { exigeTamanho: false }), p.id]);
      for (const m of ['M-B1 LST04', 'M-B2 LST04']) await a.q('UPDATE materiais SET imagem_padrao_id = $2 WHERE id = $1', [await a.material(B, m, { exigeTamanho: false }), p.id]);
      const visaoA = ok(await master.get(`${BASE}?busca=LST04`));
      const visaoB = ok(await masterB.get(`${BASE}?busca=LST04`));
      assert.deepEqual(visaoA.imagens.map((i) => i.id), [String(p.id), deA.id]);
      assert.deepEqual(visaoB.imagens.map((i) => i.id), [String(p.id), deB.id]);
      assert.deepEqual([visaoA.imagens[0].emUso, visaoB.imagens[0].emUso], [1, 2]);
      assert.equal(JSON.stringify(visaoA).includes(deB.id), false);
    });

    test('LST-05 — query estrita: origem desconhecida, estado desconhecido, limite fora de 1–100, busca acima de 100, empresaId e qualquer chave extra são 400 VALIDACAO com o campo', async () => {
      const casos = [['origem=outra', 'query.origem'], ['origem=padrao', 'query.origem'], ['estado=X', 'query.estado'], ['limite=101', 'query.limite'], ['limite=0', 'query.limite'], ['pagina=0', 'query.pagina'], [`busca=${'x'.repeat(101)}`, 'query.busca'], ['empresaId=1', 'query.empresaId'], ['selecionada=true', 'query.selecionada']];
      for (const [query, campo] of casos) {
        const corpo = erro(await master.get(`${BASE}?${query}`), 400, 'VALIDACAO');
        assert.equal(corpo.detalhes.some((d) => d.campo === campo), true, `${query}: ${JSON.stringify(corpo.detalhes)}`);
      }
    });

    test('LST-06 — a listagem é leitura pura (nada é gravado) e paginada de forma estável entre as duas origens', async () => {
      const antes = [await a.contagem('imagens_empresa'), await a.contagem('imagens_padrao'), await a.contagem('logs_auditoria')];
      const tudo = ok(await master.get(`${BASE}?limite=100`));
      const p1 = ok(await master.get(`${BASE}?limite=3&pagina=1`));
      const p2 = ok(await master.get(`${BASE}?limite=3&pagina=2`));
      assert.deepEqual([...p1.imagens, ...p2.imagens].map((i) => `${i.origem}:${i.id}`), tudo.imagens.slice(0, 6).map((i) => `${i.origem}:${i.id}`));
      assert.deepEqual([await a.contagem('imagens_empresa'), await a.contagem('imagens_padrao'), await a.contagem('logs_auditoria')], antes);
    });
  });

  describe('[PAD] biblioteca padrão: somente leitura para a empresa', () => {
    test('PAD-01 — não existe rota de escrita sob /padrao: PATCH, inativar, reativar e DELETE respondem 404 ROTA_NAO_ENCONTRADA e a linha não muda', async () => {
      const p = await a.padrao({ nome: 'Padrão intocável PAD01' });
      const antes = (await a.q('SELECT nome, ativo, versao FROM imagens_padrao WHERE id = $1', [p.id])).rows[0];
      erro(await master.patch(`${BASE}/padrao/${p.id}`).send({ nome: 'x' }), 404, 'ROTA_NAO_ENCONTRADA');
      erro(await master.post(`${BASE}/padrao/${p.id}/inativar`).send({}), 404, 'ROTA_NAO_ENCONTRADA');
      erro(await master.post(`${BASE}/padrao/${p.id}/reativar`).send({}), 404, 'ROTA_NAO_ENCONTRADA');
      erro(await master.delete(`${BASE}/padrao/${p.id}`).send({ confirmacao: true }), 404, 'ROTA_NAO_ENCONTRADA');
      assert.deepEqual((await a.q('SELECT nome, ativo, versao FROM imagens_padrao WHERE id = $1', [p.id])).rows[0], antes);
    });

    test('PAD-02 — o id de uma imagem PADRÃO nas rotas da empresa é o MESMO 404 IMAGEM_NAO_ENCONTRADA da inexistente (nada revela que o id existe) e a padrão fica intacta', async () => {
      const p = await a.padrao({ nome: 'Padrão alvo PAD02' });
      const inexistente = '987654321987';
      for (const [chamar] of [[(id) => master.patch(url(id)).send({ nome: 'x' })], [(id) => master.post(url(id, '/inativar')).send({})], [(id) => master.post(url(id, '/reativar')).send({})], [(id) => master.delete(url(id)).send({ confirmacao: true })]]) {
        const r1 = await chamar(String(p.id));
        const r2 = await chamar(inexistente);
        erro(r1, 404, 'IMAGEM_NAO_ENCONTRADA');
        assert.deepEqual([r1.status, r1.body], [r2.status, r2.body]);
      }
      assert.deepEqual((await a.q('SELECT nome, ativo FROM imagens_padrao WHERE id = $1', [p.id])).rows[0], { nome: 'Padrão alvo PAD02', ativo: true });
    });
  });

  describe('[GES] gestão da biblioteca privada', () => {
    test('GES-01 — renomear: 200 { imagem, alterado }, nome aparado, auditoria IMAGEM_MATERIAL_RENOMEADA só com o id; repetir o mesmo nome é alterado=false sem auditar de novo', async () => {
      const img = await propria({ nome: 'Antes GES01' });
      const r1 = ok(await master.patch(url(img.id)).send({ nome: '  Depois GES01  ' }));
      assert.deepEqual([r1.alterado, r1.imagem.nome, r1.imagem.id, r1.imagem.origem], [true, 'Depois GES01', img.id, 'EMPRESA']);
      a.semCamposInternos(r1, 'GES-01');
      const r2 = ok(await master.patch(url(img.id)).send({ nome: 'Depois GES01' }));
      assert.equal(r2.alterado, false);
      const logs = await a.auditorias('IMAGEM_MATERIAL_RENOMEADA', img.id);
      assert.equal(logs.length, 1);
      assert.deepEqual([logs[0].empresa_id, logs[0].usuario_id, logs[0].contexto], [A, a.d.master, { imagemId: img.id }]);
      assert.equal(JSON.stringify(logs[0]).includes('GES01'), false);
    });

    test('GES-02 — inativar e reativar: 200 idempotentes com o estado; imagem EM USO por material não inativa (409 IMAGEM_EM_USO, nada muda)', async () => {
      const livre = await propria();
      const i1 = ok(await master.post(url(livre.id, '/inativar')).send({}));
      assert.deepEqual([i1.alterado, i1.imagem.estado], [true, 'INATIVA']);
      assert.deepEqual((ok(await master.post(url(livre.id, '/inativar')).send({}))).alterado, false);
      const r1 = ok(await master.post(url(livre.id, '/reativar')).send({}));
      assert.deepEqual([r1.alterado, r1.imagem.estado], [true, 'ATIVA']);
      const usada = await propria();
      await emUsoPor(usada.id);
      erro(await master.post(url(usada.id, '/inativar')).send({}), 409, 'IMAGEM_EM_USO');
      assert.equal((await a.linhaDaImagem(usada.id)).estado, 'ATIVA');
    });

    test('GES-03 — excluir: DELETE com { confirmacao: true } → 200 { status, excluida:true, imagemId }; a linha some, deixa de ser listada e a auditoria IMAGEM_MATERIAL_EXCLUIDA fica só com id, formato e bytes', async () => {
      const img = await propria({ nome: 'Para excluir GES03' });
      const r = ok(await master.delete(url(img.id)).send({ confirmacao: true }));
      assert.deepEqual(r, { status: 'ok', excluida: true, imagemId: img.id });
      assert.equal(await a.linhaDaImagem(img.id), null);
      assert.equal(ok(await master.get(`${BASE}?origem=EMPRESA&estado=TODAS&busca=GES03`)).imagens.length, 0);
      const logs = await a.auditorias('IMAGEM_MATERIAL_EXCLUIDA', img.id);
      assert.equal(logs.length, 1);
      assert.deepEqual(Object.keys(logs[0].contexto).sort(), ['bytes', 'formato', 'imagemId']);
      assert.equal(JSON.stringify(logs[0]).includes('GES03'), false);
    });

    test('GES-04 — excluir exige confirmação explícita (ausente, false, "true", 1 → 400 em body.confirmacao) e recusa imagem em uso (409); nada é apagado nem auditado', async () => {
      const img = await propria();
      for (const corpo of [{}, { confirmacao: false }, { confirmacao: 'true' }, { confirmacao: 1 }]) {
        const b = erro(await master.delete(url(img.id)).send(corpo), 400, 'VALIDACAO');
        assert.equal(b.detalhes.some((d) => d.campo === 'body.confirmacao'), true, JSON.stringify(corpo));
      }
      const usada = await propria();
      await emUsoPor(usada.id);
      erro(await master.delete(url(usada.id)).send({ confirmacao: true }), 409, 'IMAGEM_EM_USO');
      assert.notEqual(await a.linhaDaImagem(img.id), null);
      assert.notEqual(await a.linhaDaImagem(usada.id), null);
      assert.equal((await a.auditorias('IMAGEM_MATERIAL_EXCLUIDA', usada.id)).length, 0);
    });

    test('GES-05 — isolamento: imagem de OUTRA empresa e imagem inexistente dão o MESMO 404 (status e corpo) em renomear, inativar, reativar e excluir; a imagem de B fica intacta', async () => {
      const deB = await a.imagemDaEmpresa(B, a.d.masterB, { nome: 'Privada de B GES05' });
      const inexistente = '987654321988';
      for (const chamar of [(id) => master.patch(url(id)).send({ nome: 'x' }), (id) => master.post(url(id, '/inativar')).send({}), (id) => master.post(url(id, '/reativar')).send({}), (id) => master.delete(url(id)).send({ confirmacao: true })]) {
        const r1 = await chamar(deB.id);
        const r2 = await chamar(inexistente);
        erro(r1, 404, 'IMAGEM_NAO_ENCONTRADA');
        assert.deepEqual([r1.status, r1.body], [r2.status, r2.body]);
      }
      assert.deepEqual((await a.linhaDaImagem(deB.id)).nome, 'Privada de B GES05');
      assert.equal((await a.linhaDaImagem(deB.id)).estado, 'ATIVA');
    });

    test('GES-06 — :id é BIGINT em texto decimal canônico: "05", "abc", "0", "-1", "1.5" e acima de 2^63−1 são 400 ID_INVALIDO em params.id; acima de 2^53 é válido e, inexistente, é 404', async () => {
      for (const id of ['05', 'abc', '0', '-1', '1.5', '9223372036854775808', '1e3']) {
        const b = erro(await master.patch(url(id)).send({ nome: 'x' }), 400, 'VALIDACAO');
        assert.equal(b.detalhes.some((d) => d.campo === 'params.id' && d.codigo === 'ID_INVALIDO'), true, id);
      }
      erro(await master.patch(url('9007199254740993')).send({ nome: 'x' }), 404, 'IMAGEM_NAO_ENCONTRADA');
    });

    test('GES-07 — corpos estritos: campos extras, de autoridade (empresaId, criadoPor) ou de estado (estado, ativo, versao) são 400 CAMPO_NAO_PERMITIDO e nada muda', async () => {
      const img = await propria({ nome: 'Estrita GES07' });
      const casos = [
        ['patch', url(img.id), { nome: 'x', estado: 'INATIVA' }, 'body.estado'], ['patch', url(img.id), { nome: 'x', empresaId: B }, 'body.empresaId'], ['patch', url(img.id), { nome: 'x', versao: 9 }, 'body.versao'],
        ['post', url(img.id, '/inativar'), { ativo: false }, 'body.ativo'], ['post', url(img.id, '/reativar'), { empresaId: A }, 'body.empresaId'],
        ['delete', url(img.id), { confirmacao: true, empresaId: B }, 'body.empresaId'], ['delete', url(img.id), { confirmacao: true, criadoPor: 1 }, 'body.criadoPor'],
      ];
      for (const [metodo, caminho, corpo, campo] of casos) {
        const b = erro(await master[metodo](caminho).send(corpo), 400, 'VALIDACAO');
        assert.equal(b.detalhes.some((d) => d.campo === campo && d.codigo === 'CAMPO_NAO_PERMITIDO'), true, `${metodo} ${JSON.stringify(corpo)}`);
      }
      assert.deepEqual([(await a.linhaDaImagem(img.id)).nome, (await a.linhaDaImagem(img.id)).estado], ['Estrita GES07', 'ATIVA']);
    });
  });

  describe('[SEG] segurança', () => {
    test('SEG-01 — sem sessão (middleware REAL de cookie): 401 SESSAO_INVALIDA em listar, renomear, inativar, reativar e excluir; nada muda', async () => {
      const img = await propria({ nome: 'Sem sessão SEG01' });
      const an = a.anonimo();
      erro(await an.get(BASE), 401, 'SESSAO_INVALIDA');
      erro(await an.patch(url(img.id)).send({ nome: 'x' }), 401, 'SESSAO_INVALIDA');
      erro(await an.post(url(img.id, '/inativar')).send({}), 401, 'SESSAO_INVALIDA');
      erro(await an.post(url(img.id, '/reativar')).send({}), 401, 'SESSAO_INVALIDA');
      erro(await an.delete(url(img.id)).send({ confirmacao: true }), 401, 'SESSAO_INVALIDA');
      assert.deepEqual([(await a.linhaDaImagem(img.id)).nome, (await a.linhaDaImagem(img.id)).estado], ['Sem sessão SEG01', 'ATIVA']);
    });

    test('SEG-02 — autorização pela matriz do doc. 03: sem nada → 403 em tudo; só visualizar → lista, mas 403 nas escritas; só editar → escreve, mas 403 na listagem; 403 = PERMISSAO_NEGADA antes de qualquer detalhe (o id inexistente também é 403)', async () => {
      const img = await propria({ nome: 'Permissões SEG02' });
      erro(await semNada.get(BASE), 403, 'PERMISSAO_NEGADA');
      erro(await semNada.patch(url(img.id)).send({ nome: 'x' }), 403, 'PERMISSAO_NEGADA');
      ok(await soVisualizar.get(BASE));
      erro(await soVisualizar.patch(url(img.id)).send({ nome: 'x' }), 403, 'PERMISSAO_NEGADA');
      erro(await soVisualizar.post(url(img.id, '/inativar')).send({}), 403, 'PERMISSAO_NEGADA');
      erro(await soVisualizar.delete(url(img.id)).send({ confirmacao: true }), 403, 'PERMISSAO_NEGADA');
      erro(await soVisualizar.delete(url('987654321989')).send({ confirmacao: true }), 403, 'PERMISSAO_NEGADA');
      // A permissão é decidida ANTES da validação: sem permissão, id inválido, corpo inválido e query inválida não viram 400 (nada de detalhe a quem não pode).
      erro(await soVisualizar.delete(url('05')).send({}), 403, 'PERMISSAO_NEGADA');
      erro(await soVisualizar.patch(url('abc')).send({ empresaId: B }), 403, 'PERMISSAO_NEGADA');
      erro(await semNada.get(`${BASE}?limite=101&empresaId=1`), 403, 'PERMISSAO_NEGADA');
      erro(await soEditar.get(BASE), 403, 'PERMISSAO_NEGADA');
      ok(await soEditar.patch(url(img.id)).send({ nome: 'Renomeada por quem edita' }));
      assert.deepEqual([(await a.linhaDaImagem(img.id)).nome, (await a.linhaDaImagem(img.id)).estado], ['Renomeada por quem edita', 'ATIVA']);
    });

    test('SEG-03 — verificação de origem (CSRF): PATCH, POST e DELETE sem Origin são 403 ORIGEM_AUSENTE e com Origin estranha 403 ORIGEM_NAO_PERMITIDA; com a origem permitida passam; GET não exige Origin', async () => {
      const img = await propria({ nome: 'Origem SEG03' });
      const m = a.como(a.d.master, a.appComOrigem);
      ok(await m.get(BASE));
      erro(await m.patch(url(img.id)).send({ nome: 'x' }), 403, 'ORIGEM_AUSENTE');
      erro(await m.patch(url(img.id)).set('Origin', 'https://atacante.invalid').send({ nome: 'x' }), 403, 'ORIGEM_NAO_PERMITIDA');
      erro(await m.delete(url(img.id)).send({ confirmacao: true }), 403, 'ORIGEM_AUSENTE');
      erro(await m.post(url(img.id, '/inativar')).send({}), 403, 'ORIGEM_AUSENTE');
      ok(await m.patch(url(img.id)).set('Origin', ORIGEM_PERMITIDA).send({ nome: 'Com origem SEG03' }));
      assert.equal((await a.linhaDaImagem(img.id)).nome, 'Com origem SEG03');
    });

    test('SEG-04 — nenhuma resposta (lista, renomear, inativar, reativar, excluir, erros) traz hash, bytes, chave, caminho, criador ou empresa', async () => {
      const img = await propria({ nome: 'Sigilo SEG04' });
      const respostas = [
        await master.get(`${BASE}?busca=SEG04`), await master.patch(url(img.id)).send({ nome: 'Sigilo SEG04 b' }), await master.post(url(img.id, '/inativar')).send({}),
        await master.post(url(img.id, '/reativar')).send({}), await master.delete(url('987654321990')).send({ confirmacao: true }), await master.delete(url(img.id)).send({ confirmacao: true }),
      ];
      for (const r of respostas) a.semCamposInternos(r.body, `SEG-04 ${r.status}`);
    });
  });
});
