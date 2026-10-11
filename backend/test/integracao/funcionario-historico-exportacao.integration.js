'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { montar: montarAmbiente } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, criarGhe, registrarEntrega,
} = require('./helpers/entrega-epi');
const { criarEntregaEpiController } = require('../../src/controllers/entrega-epi.controller');
const { criarEntregaEpiRoutes } = require('../../src/routes/entrega-epi.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');

/**
 * Histórico de Funcionários — pacote I (RED): EXPORTAÇÃO do histórico (PostgreSQL real, rotas reais).
 *
 * Contrato proposto, INDEPENDENTE do formato (PDF/XLSX ainda por decidir): o serviço
 * src/services/funcionario-historico-exportacao.service.js exporta
 *   - FORMATOS: [{ id, extensao, mime }] — os formatos que o servidor gera (a decisão fica só nessa lista);
 *   - montar(executor, { empresaId, usuarioId, perfil, funcionarioId, de, ate }) → o MODELO do documento:
 *       { funcionario: { id, nome, matricula, setor, funcao, situacao, ghe: { codigo, descricao } | null },
 *         periodo: { de, ate } | null, indicadores: { totalEntregas, episDistintos, ultimaEntregaEm, episDentroPrazoUso } | null,
 *         entregas: [...] | null, ghe: [...], situacao: [...], cadastral: [...], secoes: [...] }
 *     com a MESMA autorização da rota (exportacao-historico-autorizacao.service: visualizar E exportar), o mesmo 404 para
 *     inexistente e de outra empresa, TODAS as páginas de cada histórico (nunca só a primeira), os eventos iguais aos de
 *     GET /funcionarios/:id/eventos e os indicadores iguais ao resumo de GET /fichas-epi (histórico completo, sem período);
 *     sem epiFicha.visualizar, entregas e indicadores ficam null (como na tela, nunca expostos por outro caminho);
 *   - exportar(pool, { ...contexto, formato, de, ate, ip, dispositivo }, { renderizadores }) → { conteudo, nomeArquivo, mime,
 *     sha256, bytes }; gera o arquivo ANTES de auditar; falha na geração não audita nem devolve arquivo.
 * Rota: POST /api/funcionarios/:id/historico/exportacao { formato, de?, ate? } (POST: passa pela verificação de origem e
 * não é disparada por navegação). Período: o do pacote H, mas FECHADO (as duas datas ou nenhuma). Auditoria
 * FUNCIONARIO_HISTORICO_EXPORTADO { formato, periodo, secoes, contagens, bytes, sha256 } — nunca o conteúdo nem o CPF.
 */

const SERVICO = path.join(__dirname, '..', '..', 'src', 'services', 'funcionario-historico-exportacao.service.js');
function servico() {
  assert.ok(fs.existsSync(SERVICO), 'serviço de exportação ausente (src/services/funcionario-historico-exportacao.service.js)');
  const m = require(SERVICO);
  assert.ok(Array.isArray(m.FORMATOS) && m.FORMATOS.length > 0, 'FORMATOS: ao menos um formato declarado');
  for (const f of m.FORMATOS) assert.deepEqual(Object.keys(f).filter((k) => ['id', 'extensao', 'mime'].includes(k)).sort(), ['extensao', 'id', 'mime'], JSON.stringify(f));
  assert.equal(typeof m.montar, 'function', 'montar() ausente');
  assert.equal(typeof m.exportar, 'function', 'exportar() ausente');
  return m;
}

const AUDITORIA = 'FUNCIONARIO_HISTORICO_EXPORTADO';
const DIA = (n) => `2026-01-${String(n).padStart(2, '0')}`;
const instante = (dia, hora = '12:00:00') => `${dia}T${hora}-03:00`;

describe('I — exportação do histórico do funcionário (PostgreSQL real)', () => {
  let g;
  let master;
  const contas = {};
  const f = {};
  let cpfPrincipal;

  before(async () => {
    g = await montarAmbiente({ extras: ({ pool, exigirEmpresarial }) => [
      criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    await provisionamento.provisionar(g.pool, { empresaId: A, dryRun: false });
    master = await g.contaDaEmpresa(A);

    const gheId = await criarGhe(g.pool, A, 'GHE Exportação');
    cpfPrincipal = g.cpfFicticio(9600);
    f.principal = await criarFuncionario(g.pool, A, { matricula: 'EXP-1', cpf: cpfPrincipal, gheId, setor: 'Produção', funcao: 'Operador' });
    f.vazio = await criarFuncionario(g.pool, A, { matricula: 'EXP-2', cpf: g.cpfFicticio(9601) });
    f.outraEmpresa = await criarFuncionario(g.pool, g.empresas.B, { matricula: 'EXP-B', cpf: g.cpfFicticio(9602) });

    // 21 entregas: 10 em janeiro de 2026 (dias 2 a 11) e 11 fora (dezembro de 2025); mais do que uma página da tela (20).
    const ficha = await criarFicha(g.pool, A, f.principal);
    const materialId = await criarMaterial(g.pool, A, 'Luva Exportação', { prazo: 90 });
    const loteId = await criarLote(g.pool, { empresaId: A, materialId, quantidade: 10000, tamanho: '40' });
    const entregar = (dia) => registrarEntrega(g.pool, {
      usuarioId: master.usuarioId,
      entrega: { empresa_id: A, ficha_id: ficha.id, responsavel_id: master.usuarioId, data_operacional: dia, entregue_em: instante(dia) },
      itens: [{ material_id: materialId, lote_id: loteId, material_nome: 'Luva Exportação', material_prazo_uso_dias: 90, quantidade: 1 }],
    });
    for (let d = 2; d <= 11; d += 1) await entregar(DIA(d));
    for (let d = 10; d <= 20; d += 1) await entregar(`2025-12-${d}`);

    // Eventos: 105 alterações cadastrais em dezembro de 2025 (mais do que a página máxima da API, 100) e 3 em janeiro;
    // GHE e situação com um evento dentro e um fora do período.
    const ref = String(f.principal);
    const inst = (nome) => ({ matricula: 'EXP-1', nome, grupoHomogeneoId: gheId, setor: 'Produção', funcao: 'Operador', cracha: null, ativo: true });
    await g.pool.query(
      `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em)
       SELECT $1, $2, 'FUNCIONARIO_ALTERADO', $3, jsonb_build_object('nome', 'Nome ' || n), jsonb_build_object('nome', 'Nome ' || (n + 1)),
              timestamptz '2025-12-01T12:00:00Z' + make_interval(hours => n)
         FROM generate_series(1, 105) AS n`,
      [A, master.usuarioId, ref],
    );
    for (const d of [5, 15, 25]) {
      await g.pool.query(
        'INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [A, master.usuarioId, 'FUNCIONARIO_ALTERADO', ref, inst(`Jan ${d} a`), inst(`Jan ${d} b`), instante(DIA(d))],
      );
    }
    const auditar = (acao, anteriores, novos, em) => g.pool.query(
      'INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [A, master.usuarioId, acao, ref, anteriores, novos, em],
    );
    await auditar('FUNCIONARIO_GHE_ALTERADO', { grupoHomogeneo: { id: gheId, codigo: 'G1', descricao: 'A' } }, { grupoHomogeneo: { id: gheId, codigo: 'G2', descricao: 'B' } }, instante(DIA(20)));
    await auditar('FUNCIONARIO_GHE_ALTERADO', { grupoHomogeneo: { id: gheId, codigo: 'G0', descricao: 'Z' } }, { grupoHomogeneo: { id: gheId, codigo: 'G1', descricao: 'A' } }, instante('2025-11-20'));
    await auditar('FUNCIONARIO_SITUACAO_ALTERADA', { situacao: 'ATIVO' }, { situacao: 'AFASTADO' }, instante(DIA(22)));
    await auditar('FUNCIONARIO_SITUACAO_ALTERADA', { situacao: 'AFASTADO' }, { situacao: 'ATIVO' }, instante('2026-02-10'));

    for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) contas[perfil] = await g.contaDaEmpresa(A, perfil);
  });
  after(async () => { if (g) await g.encerrar(); });

  // ── apoio ──────────────────────────────────────────────────────────
  const ligar = async (c, id, ligado = true) => {
    const r = await g.request(g.app).put(`/api/administracao/usuarios/${c.usuarioId}/acessos/${id}`).set('Cookie', g.cookie(master)).send({ ligado });
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
  };
  const conta = async (perfil, acessos) => {
    const c = await g.contaDaEmpresa(g.empresas.A, perfil);
    for (const id of acessos) await ligar(c, id);
    return c;
  };
  const exportarHttp = (c, id, corpo) => g.request(g.app).post(`/api/funcionarios/${id}/historico/exportacao`).set('Cookie', g.cookie(c))
    .buffer(true).parse((res, cb) => { const partes = []; res.on('data', (p) => partes.push(p)); res.on('end', () => cb(null, Buffer.concat(partes))); })
    .send(corpo);
  const jsonDe = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
  const auditorias = (id) => g.todos('SELECT usuario_id, empresa_id, referencia, dados_novos, dados_anteriores FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id', [AUDITORIA, String(id)]);
  const formato0 = () => servico().FORMATOS[0].id;
  const ctx = (c, perfil, extra = {}) => ({ empresaId: c.empresaId, usuarioId: c.usuarioId, perfil, ...extra });
  const getJson = async (c, url) => {
    const r = await g.request(g.app).get(url).set('Cookie', g.cookie(c));
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  async function todasAsPaginas(c, base, chave) {
    const itens = [];
    for (let pagina = 1; pagina <= 50; pagina += 1) {
      const corpo = await getJson(c, `${base}${base.includes('?') ? '&' : '?'}pagina=${pagina}&limite=100`);
      itens.push(...corpo[chave]);
      if (itens.length >= corpo.total) break;
    }
    return itens;
  }
  const simples = (x) => JSON.parse(JSON.stringify(x));
  const SENSIVEIS = ['cpf', 'cpfMascarado', 'telefone', 'dataNascimento', 'cracha', 'dataAdmissao', 'senha', 'token'];

  // ═════════════════════════════════════════════════════════════════
  describe('I1 — autorização (as duas permissões, sempre no servidor)', () => {
    test('I1.1 sem sessão: 401; nada gerado nem auditado', async () => {
      const formato = formato0(); // antes de criar o pedido: o supertest abre o servidor já no .post()
      const r = await g.request(g.app).post(`/api/funcionarios/${f.principal}/historico/exportacao`).send({ formato });
      assert.equal(r.status, 401);
      assert.deepEqual(await auditorias(f.principal), []);
    });

    test('I1.2 só Visualizar: consulta o histórico, mas exportar é 403 (sem arquivo, sem auditoria)', async () => {
      const c = await conta('USUARIO', ['historicoFuncionarios']);
      assert.equal((await g.request(g.app).get(`/api/funcionarios/${f.principal}`).set('Cookie', g.cookie(c))).status, 200);
      const r = await exportarHttp(c, f.principal, { formato: formato0() });
      assert.equal(r.status, 403, r.body.toString('utf8'));
      assert.match(String(r.headers['content-type']), /application\/json/);
      assert.equal(r.headers['content-disposition'], undefined);
      assert.deepEqual(await auditorias(f.principal), []);
      await assert.rejects(() => servico().montar(g.pool, ctx(c, 'USUARIO', { funcionarioId: f.principal, de: null, ate: null })), (e) => e.status === 403);
    });

    test('I1.3 só Exportar (sem Visualizar): 403', async () => {
      const c = await conta('USUARIO', ['exportarHistoricoFuncionarios']);
      assert.equal((await exportarHttp(c, f.principal, { formato: formato0() })).status, 403);
      assert.deepEqual(await auditorias(f.principal), []);
    });

    test('I1.4 nenhuma das duas: 403; o perfil não decide (ADMINISTRADOR e SUPERVISOR sem as permissões também 403)', async () => {
      for (const perfil of ['USUARIO', 'ADMINISTRADOR', 'SUPERVISOR']) {
        assert.equal((await exportarHttp(contas[perfil], f.principal, { formato: formato0() })).status, 403, perfil);
      }
    });

    test('I1.5 as duas permissões: 200 para USUARIO, SUPERVISOR e ADMINISTRADOR; MASTER provisionado também', async () => {
      for (const perfil of ['USUARIO', 'SUPERVISOR', 'ADMINISTRADOR']) {
        const c = await conta(perfil, ['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
        const r = await exportarHttp(c, f.principal, { formato: formato0() });
        assert.equal(r.status, 200, `${perfil}: ${r.body.toString('utf8').slice(0, 300)}`);
      }
      assert.equal((await exportarHttp(master, f.principal, { formato: formato0() })).status, 200);
    });

    test('I1.6 sem autorização, até um id inexistente responde 403 (não revela existência); autorizado: inexistente e de outra empresa = o mesmo 404', async () => {
      const so = await conta('USUARIO', ['historicoFuncionarios']);
      assert.equal((await exportarHttp(so, 999999, { formato: formato0() })).status, 403);
      const inexistente = await exportarHttp(master, 999999, { formato: formato0() });
      const deB = await exportarHttp(master, f.outraEmpresa, { formato: formato0() });
      assert.equal(inexistente.status, 404);
      assert.deepEqual([deB.status, jsonDe(deB)], [inexistente.status, jsonDe(inexistente)]);
      assert.equal(jsonDe(inexistente)?.codigo, 'FUNCIONARIO_NAO_ENCONTRADO');
      assert.deepEqual(await auditorias(f.outraEmpresa), []);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('I2 — parâmetros (período fechado do pacote H, formato do servidor)', () => {
    const campos = (r) => (jsonDe(r)?.detalhes ?? []).map((d) => [d.campo, d.codigo]);

    test('I2.1 formato desconhecido ou ausente: 400 em body.formato', async () => {
      for (const corpo of [{ formato: 'docx' }, {}]) {
        const r = await exportarHttp(master, f.principal, corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
        assert.deepEqual(campos(r).map((x) => x[0]), ['body.formato']);
      }
    });

    test('I2.2 data inválida, invertida, só uma das datas e campo extra: 400, nada gerado nem auditado', async () => {
      const antes = (await auditorias(f.principal)).length;
      assert.deepEqual(campos(await exportarHttp(master, f.principal, { formato: formato0(), de: '2026-02-30', ate: '2026-03-01' })), [['body.de', 'DATA_INVALIDA']]);
      assert.deepEqual(campos(await exportarHttp(master, f.principal, { formato: formato0(), de: '2026-02-01', ate: '2026-01-31' })), [['body.ate', 'PERIODO_INVERTIDO']]);
      assert.deepEqual(campos(await exportarHttp(master, f.principal, { formato: formato0(), de: '2026-01-01' })), [['body.ate', 'PERIODO_INCOMPLETO']]);
      assert.deepEqual(campos(await exportarHttp(master, f.principal, { formato: formato0(), ate: '2026-01-31' })), [['body.de', 'PERIODO_INCOMPLETO']]);
      for (const extra of [{ empresaId: 2 }, { cpf: cpfPrincipal }, { secoes: ['entregas'] }]) {
        assert.equal((await exportarHttp(master, f.principal, { formato: formato0(), ...extra })).status, 400, JSON.stringify(extra));
      }
      assert.equal((await auditorias(f.principal)).length, antes);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('I3 — conteúdo (modelo do documento, independente do formato)', () => {
    const montarComo = (c, perfil, extra) => servico().montar(g.pool, ctx(c, perfil, { funcionarioId: f.principal, de: null, ate: null, ...extra }));

    test('I3.1 identificação = a ficha do A+B (detalhe), sem CPF, telefone, nascimento, crachá nem admissão', async () => {
      const m = simples(await montarComo(master, 'MASTER'));
      const { funcionario } = await getJson(master, `/api/funcionarios/${f.principal}`);
      assert.deepEqual(m.funcionario, {
        id: funcionario.id, nome: funcionario.nome, matricula: funcionario.matricula, setor: funcionario.setor, funcao: funcionario.funcao,
        situacao: funcionario.situacao, ghe: funcionario.grupoHomogeneo ? { codigo: funcionario.grupoHomogeneo.codigo ?? null, descricao: funcionario.grupoHomogeneo.descricao ?? null } : null,
      });
      const texto = JSON.stringify(m);
      for (const proibido of [cpfPrincipal, ...SENSIVEIS.map((k) => `"${k}"`)]) assert.equal(texto.includes(proibido), false, proibido);
    });

    test('I3.2 histórico completo: TODAS as páginas; entregas na ordem do servidor; eventos iguais aos de /eventos (105+ cadastrais)', async () => {
      const m = simples(await montarComo(master, 'MASTER'));
      const [ficha] = (await getJson(master, `/api/fichas-epi?funcionarioId=${f.principal}&pagina=1&limite=1`)).fichas;
      const entregas = await todasAsPaginas(master, `/api/fichas-epi/${ficha.id}/entregas`, 'entregas');
      assert.equal(entregas.length, 21);
      assert.deepEqual(m.entregas.map((e) => e.id), entregas.map((e) => e.id));
      for (const tipo of ['GHE', 'SITUACAO', 'CADASTRAL']) {
        const api = await todasAsPaginas(master, `/api/funcionarios/${f.principal}/eventos?tipo=${tipo}`, 'eventos');
        assert.deepEqual(m[tipo.toLowerCase()], api, tipo);
      }
      assert.equal(m.cadastral.length, 108, 'as 105 de dezembro e as 3 de janeiro');
      assert.equal(m.periodo, null);
    });

    test('I3.3 com período (01/01 a 31/01/2026): só o que o pacote H mostra; indicadores continuam os do histórico completo', async () => {
      const completo = simples(await montarComo(master, 'MASTER'));
      const m = simples(await montarComo(master, 'MASTER', { de: '2026-01-01', ate: '2026-01-31' }));
      const [ficha] = (await getJson(master, `/api/fichas-epi?funcionarioId=${f.principal}&pagina=1&limite=1`)).fichas;
      const entregas = await todasAsPaginas(master, `/api/fichas-epi/${ficha.id}/entregas?de=2026-01-01&ate=2026-01-31`, 'entregas');
      assert.equal(entregas.length, 10);
      assert.deepEqual(m.entregas.map((e) => e.id), entregas.map((e) => e.id));
      assert.ok(m.entregas.every((e) => e.dataOperacional >= '2026-01-01' && e.dataOperacional <= '2026-01-31'));
      for (const tipo of ['GHE', 'SITUACAO', 'CADASTRAL']) {
        const api = await todasAsPaginas(master, `/api/funcionarios/${f.principal}/eventos?tipo=${tipo}&de=2026-01-01&ate=2026-01-31`, 'eventos');
        assert.deepEqual(m[tipo.toLowerCase()], api, tipo);
      }
      assert.deepEqual([m.ghe.length, m.situacao.length, m.cadastral.length], [1, 1, 3]);
      assert.deepEqual(m.periodo, { de: '2026-01-01', ate: '2026-01-31' });
      assert.deepEqual(m.indicadores, completo.indicadores, 'indicadores globais, independentes do período');
      assert.deepEqual(m.indicadores, { totalEntregas: ficha.resumo.totalEntregas, episDistintos: ficha.resumo.episDistintos, ultimaEntregaEm: ficha.resumo.ultimaEntregaEm, episDentroPrazoUso: ficha.resumo.episDentroPrazoUso });
    });

    test('I3.4 funcionário sem histórico: seções vazias e indicadores zerados (sem ficha = 0, 0, sem data, 0)', async () => {
      const m = simples(await servico().montar(g.pool, ctx(master, 'MASTER', { funcionarioId: f.vazio, de: null, ate: null })));
      assert.deepEqual([m.entregas, m.ghe, m.situacao, m.cadastral], [[], [], [], []]);
      assert.deepEqual(m.indicadores, { totalEntregas: 0, episDistintos: 0, ultimaEntregaEm: null, episDentroPrazoUso: 0 });
    });

    test('I3.5 sem epiFicha.visualizar: entregas e indicadores ficam fora (null) e as seções dizem isso; o resto sai', async () => {
      const c = await conta('USUARIO', ['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
      const m = simples(await montarComo(c, 'USUARIO'));
      assert.deepEqual([m.entregas, m.indicadores], [null, null]);
      assert.equal(m.secoes.includes('entregas') || m.secoes.includes('indicadores'), false, JSON.stringify(m.secoes));
      assert.ok(m.cadastral.length > 0 && m.ghe.length > 0);
      const comFicha = await conta('USUARIO', ['historicoFuncionarios', 'exportarHistoricoFuncionarios', 'fichaEpi']);
      const n = simples(await montarComo(comFicha, 'USUARIO'));
      assert.equal(n.entregas.length, 21);
      assert.ok(n.secoes.includes('entregas') && n.secoes.includes('indicadores'));
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('I4 — arquivo, integridade e auditoria', () => {
    test('I4.1 cada formato declarado: 200, anexo com nome seguro, tipo do formato, sem cache; o arquivo começa como o formato exige', async () => {
      for (const formato of servico().FORMATOS) {
        const r = await exportarHttp(master, f.principal, { formato: formato.id, de: '2026-01-01', ate: '2026-01-31' });
        assert.equal(r.status, 200, `${formato.id}: ${r.body.toString('utf8').slice(0, 300)}`);
        assert.ok(String(r.headers['content-type']).startsWith(formato.mime), r.headers['content-type']);
        assert.match(String(r.headers['content-disposition']), new RegExp(`^attachment; filename="historico-funcionario-${f.principal}-20260101-20260131\\.${formato.extensao}"$`));
        assert.match(String(r.headers['cache-control']), /no-store/);
        assert.ok(r.body.length > 0);
        if (formato.id === 'pdf') assert.equal(r.body.subarray(0, 5).toString('latin1'), '%PDF-');
        if (formato.id === 'xlsx') {
          assert.equal(r.body.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
          assert.ok(r.body.toString('latin1').includes('[Content_Types].xml'));
        }
        assert.equal(r.body.toString('latin1').includes(cpfPrincipal), false);
      }
      const completo = await exportarHttp(master, f.principal, { formato: formato0() });
      assert.match(String(completo.headers['content-disposition']), new RegExp(`filename="historico-funcionario-${f.principal}-completo\\.`));
    });

    test('I4.2 auditoria depois de gerar: ator, empresa, funcionário, formato, período, seções, contagens e o SHA-256 do arquivo entregue — nada do conteúdo', async () => {
      const antes = (await auditorias(f.principal)).length;
      const r = await exportarHttp(master, f.principal, { formato: formato0(), de: '2026-01-01', ate: '2026-01-31' });
      assert.equal(r.status, 200);
      const todas = await auditorias(f.principal);
      assert.equal(todas.length, antes + 1, 'uma auditoria por exportação');
      const a = todas.at(-1);
      assert.deepEqual([a.usuario_id, a.empresa_id, a.referencia, a.dados_anteriores], [master.usuarioId, g.empresas.A, String(f.principal), null]);
      assert.deepEqual(Object.keys(a.dados_novos).sort(), ['bytes', 'contagens', 'formato', 'periodo', 'secoes', 'sha256']);
      assert.deepEqual([a.dados_novos.formato, a.dados_novos.periodo], [formato0(), { de: '2026-01-01', ate: '2026-01-31' }]);
      assert.deepEqual(a.dados_novos.contagens, { entregas: 10, ghe: 1, situacao: 1, cadastral: 3 });
      assert.equal(a.dados_novos.sha256, crypto.createHash('sha256').update(r.body).digest('hex'), 'integridade: o hash auditado é o do arquivo entregue');
      assert.equal(a.dados_novos.bytes, r.body.length);
      const texto = JSON.stringify(a);
      for (const proibido of [cpfPrincipal, 'Trabalhador EXP-1', 'Luva Exportação', 'base64']) assert.equal(texto.includes(proibido), false, proibido);
    });

    test('I4.3 falha na geração: o serviço rejeita, não devolve arquivo e não audita', async () => {
      const m = servico();
      const antes = (await auditorias(f.principal)).length;
      const quebrado = Object.fromEntries(m.FORMATOS.map((x) => [x.id, async () => { throw new Error('falha simulada na geração'); }]));
      await assert.rejects(() => m.exportar(g.pool, ctx(master, 'MASTER', { funcionarioId: f.principal, formato: formato0(), de: null, ate: null }), { renderizadores: quebrado }));
      assert.equal((await auditorias(f.principal)).length, antes);
    });

    test('I4.4 sucesso pelo serviço: devolve conteúdo, nome, tipo, sha256 e bytes coerentes', async () => {
      const m = servico();
      const r = await m.exportar(g.pool, ctx(master, 'MASTER', { funcionarioId: f.principal, formato: formato0(), de: null, ate: null }));
      assert.ok(Buffer.isBuffer(r.conteudo) && r.conteudo.length > 0);
      assert.equal(r.bytes, r.conteudo.length);
      assert.equal(r.sha256, crypto.createHash('sha256').update(r.conteudo).digest('hex'));
      assert.equal(r.mime, m.FORMATOS[0].mime);
      assert.equal(r.nomeArquivo, `historico-funcionario-${f.principal}-completo.${m.FORMATOS[0].extensao}`);
    });
  });
});
