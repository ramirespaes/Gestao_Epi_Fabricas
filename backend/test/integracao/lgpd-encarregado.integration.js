'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarLgpdRoutes } = require('../../src/routes/lgpd.routes');
const { criarLgpdController } = require('../../src/controllers/lgpd.controller');
const { criarLgpdEncarregadoRoutes } = require('../../src/routes/lgpd-encarregado.routes');
const { criarLgpdEncarregadoController } = require('../../src/controllers/lgpd-encarregado.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarRelatorioRoutes } = require('../../src/routes/relatorio.routes');
const { criarRelatorioController } = require('../../src/controllers/relatorio.controller');

/**
 * LGPD-1 — cadastro do encarregado (DPO) e recursos EXCLUSIVOS do MASTER, com PostgreSQL real (schema temporário).
 *
 * Autoridade: a rota exige a linha do perfil (lgpdEncarregado.visualizar / .editar, provisionada ao MASTER) E o serviço de
 * escrita exige a autoridade administrativa com ator MASTER (dupla barreira, sem bypass por nome: sem a linha, o MASTER recebe
 * 403; com a linha criada por fora para outro perfil, o serviço ainda recusa). Exclusividade: toggle, grupo e exceção individual
 * recusam os recursos exclusivos com 409 e auditam a tentativa. Dados: principal e substituto vigentes por empresa, histórico
 * imutável, substituição/correção/encerramento sem apagar, versão para concorrência. Auditoria LGPD_DPO_* consultável na aba
 * Auditoria → Log de ações (GET /relatorios/auditoria/log, filtro por ação), sem e-mail, telefone ou nome no JSONB.
 */
const ENC = '/api/lgpd/encarregados';
const RESUMO = '/api/lgpd/resumo';
const ACESSOS = '/api/administracao/usuarios';

const pf = (extra = {}) => ({
  funcao: 'PRINCIPAL', tipoPessoa: 'PF', nome: 'Ana Encarregada Teste', vinculo: 'INTERNO', cargo: 'Analista de privacidade',
  email: 'dpo.ana@example.invalid', telefone: '(11) 4000-1000', inicioEm: '2026-10-01', atoReferencia: 'Portaria interna 07/2026', atoData: '2026-09-30',
  conflitoInteresses: 'SEM_CONFLITO', conflitoNota: 'Não exerce função decisória sobre os tratamentos.', ...extra,
});
// CNPJs FICTÍCIOS com dígitos verificadores válidos (regra canônica do SafeWork), só para teste.
const CNPJ_PJ = '12345678000195';
const CNPJ_PJ_FORMATADO = '12.345.678/0001-95';
const CNPJ_PJ_2 = '98765432000198';
const pj = (extra = {}) => ({
  funcao: 'SUBSTITUTO', tipoPessoa: 'PJ', razaoSocial: 'Consultoria Privacidade Teste Ltda', cnpj: CNPJ_PJ_FORMATADO, nome: 'Bruno Responsavel Teste', vinculo: 'EXTERNO',
  cargo: 'Consultor', email: 'dpo.bruno@example.invalid', inicioEm: '2026-10-05', conflitoInteresses: 'NAO_AVALIADO', ...extra,
});

describe('LGPD-1 — encarregado (DPO) e recursos exclusivos do MASTER (PostgreSQL real)', () => {
  let g;
  let masterA;
  let masterB;

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarLgpdRoutes({ controller: criarLgpdController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarLgpdEncarregadoRoutes({ controller: criarLgpdEncarregadoController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    masterA = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
  });
  after(async () => { if (g) await g.encerrar(); });

  const get = (caminho, c) => g.request(g.app).get(caminho).set('Cookie', g.cookie(c));
  const post = (caminho, c, corpo) => g.request(g.app).post(caminho).set('Cookie', g.cookie(c)).send(corpo);
  const cookieDe = async (u) => ({ cookie: g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))) });
  const getCookie = (caminho, cookie) => g.request(g.app).get(caminho).set('Cookie', cookie);
  const auditorias = (empresaId, prefixo) => g.todos("SELECT usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao LIKE $2 ORDER BY id", [empresaId, `${prefixo}%`]);
  const novoGrupo = async (empresaId, master, nome) => (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [empresaId, nome, master.usuarioId])).id;

  test('401 sem sessão em todas as rotas do encarregado', async () => {
    assert.equal((await g.request(g.app).get(ENC)).status, 401);
    assert.equal((await g.request(g.app).get(`${ENC}/historico`)).status, 401);
    assert.equal((await g.request(g.app).post(ENC).send(pf())).status, 401);
    assert.equal((await g.request(g.app).post(`${ENC}/1/encerrar`).send({ versao: 1 })).status, 401);
  });

  test('MASTER sem a linha do perfil: 403 na consulta e na escrita; o toggle lgpdEncarregado aparece desligado e fixo; nada é gravado', async () => {
    assert.equal((await get(ENC, masterA)).status, 403);
    assert.equal((await post(ENC, masterA, pf())).status, 403);
    const l = (await get(`${ACESSOS}/${masterA.usuarioId}/acessos`, masterA)).body.acessos.toggles;
    const t = l.find((x) => x.id === 'lgpdEncarregado');
    assert.deepEqual([t.ligado, t.fixo], [false, true]);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM lgpd_encarregados')).n, 0);
  });

  test('provisionamento oficial insere lgpdEncarregado [visualizar, editar] (e NÃO lgpdRetencao); o toggle passa a ligado e fixo', async () => {
    const r = await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    assert.ok(r.inseridos.recursos.includes('lgpdEncarregado'));
    assert.equal(r.inseridos.recursos.includes('lgpdRetencao'), false);
    const linha = await g.um("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = 'lgpdEncarregado'", [g.empresas.A]);
    assert.deepEqual(linha, { pode_visualizar: true, pode_criar: false, pode_editar: true, pode_excluir: false });
    const t = (await get(`${ACESSOS}/${masterA.usuarioId}/acessos`, masterA)).body.acessos.toggles.find((x) => x.id === 'lgpdEncarregado');
    assert.deepEqual([t.ligado, t.fixo], [true, true]);
    const efetivas = (await get('/api/auth/permissoes', masterA)).body.recursos.lgpdEncarregado;
    assert.deepEqual(efetivas, { visualizar: true, criar: false, editar: true, excluir: false });
  });

  test('sem encarregado: GET devolve principal e substituto nulos e histórico vazio; o resumo LGPD traz encarregado nulo (contrato anterior preservado)', async () => {
    const r = await get(ENC, masterA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: 'ok', encarregados: { principal: null, substituto: null } });
    const h = await get(`${ENC}/historico`, masterA);
    assert.deepEqual(h.body, { status: 'ok', historico: [] });
    const resumo = await get(RESUMO, masterA);
    assert.equal(resumo.status, 200);
    assert.deepEqual(Object.keys(resumo.body.resumo).sort(), ['controladora', 'encarregado', 'titulares']);
    assert.deepEqual(resumo.body.resumo.encarregado, { principal: null, substituto: null });
  });

  test('validação: PJ exige razão social e CNPJ (formato canônico e dígitos verificadores); PF não aceita razão social nem CNPJ; e-mail inválido, função desconhecida, data inválida e campo extra são 400 sem gravar', async () => {
    const casos = [
      [pj({ razaoSocial: undefined }), 'body.razaoSocial'],
      [pf({ razaoSocial: 'Indevida' }), 'body.razaoSocial'],
      [pj({ cnpj: undefined }), 'body.cnpj'],
      [pj({ cnpj: '12.345.678/0001-96' }), 'body.cnpj'], // dígitos verificadores errados
      [pj({ cnpj: '1234' }), 'body.cnpj'],
      [pf({ cnpj: CNPJ_PJ }), 'body.cnpj'],
      [pf({ email: 'nao-e-email' }), 'body.email'],
      [pf({ funcao: 'TITULAR' }), 'body.funcao'],
      [pf({ inicioEm: '2026-02-30' }), 'body.inicioEm'],
      [pf({ atoData: '2026-13-01' }), 'body.atoData'],
      [pf({ cpf: '12345678901' }), 'body'],
      [pf({ empresaId: 2 }), 'body'],
    ];
    for (const [corpo, campo] of casos) {
      const r = await post(ENC, masterA, corpo);
      assert.equal(r.status, 400, `${campo}: ${JSON.stringify(r.body)}`);
      assert.ok(JSON.stringify(r.body.detalhes ?? r.body).includes(campo.replace('body.', '')) || campo === 'body', campo);
    }
    assert.equal((await g.um('SELECT count(*)::int AS n FROM lgpd_encarregados')).n, 0);
  });

  let principal1;
  let substituto1;

  test('designar PRINCIPAL (PF) e SUBSTITUTO (PJ com pessoa natural responsável): 201, vigentes, resumo atualizado, auditoria LGPD_DPO_DESIGNADO sem dados de contato', async () => {
    const r1 = await post(ENC, masterA, pf());
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    principal1 = r1.body.encarregado;
    assert.equal(principal1.funcao, 'PRINCIPAL');
    assert.equal(principal1.situacao, 'VIGENTE');
    assert.equal(principal1.versao, 1);
    assert.equal(principal1.nome, 'Ana Encarregada Teste');
    assert.equal(principal1.razaoSocial, null);

    const r2 = await post(ENC, masterA, pj());
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    substituto1 = r2.body.encarregado;
    assert.deepEqual([substituto1.funcao, substituto1.tipoPessoa, substituto1.razaoSocial, substituto1.nome, substituto1.vinculo], ['SUBSTITUTO', 'PJ', 'Consultoria Privacidade Teste Ltda', 'Bruno Responsavel Teste', 'EXTERNO']);
    assert.equal(substituto1.telefone, null);
    assert.equal(substituto1.cnpj, CNPJ_PJ, 'CNPJ gravado normalizado, sem máscara');
    assert.equal(principal1.cnpj, null, 'PF nunca tem CNPJ');
    assert.equal((await g.um('SELECT cnpj FROM lgpd_encarregados WHERE id = $1', [substituto1.id])).cnpj, CNPJ_PJ);

    const vigentes = (await get(ENC, masterA)).body.encarregados;
    assert.deepEqual([vigentes.principal.id, vigentes.substituto.id], [principal1.id, substituto1.id]);
    const resumo = (await get(RESUMO, masterA)).body.resumo.encarregado;
    assert.deepEqual(Object.keys(resumo.principal).sort(), ['cargo', 'cnpj', 'email', 'inicioEm', 'nome', 'razaoSocial', 'telefone', 'tipoPessoa', 'vinculo']);
    assert.equal(resumo.principal.nome, 'Ana Encarregada Teste');
    assert.equal(resumo.substituto.razaoSocial, 'Consultoria Privacidade Teste Ltda');
    assert.equal(resumo.substituto.cnpj, CNPJ_PJ, 'o CNPJ do prestador sai no resumo para quem tem lgpd.visualizar');

    const a = await auditorias(g.empresas.A, 'LGPD_DPO_DESIGNADO');
    assert.equal(a.length, 2);
    assert.deepEqual(a.map((x) => x.referencia), [String(principal1.id), String(substituto1.id)]);
    assert.equal(a[0].usuario_id, masterA.usuarioId);
    assert.deepEqual(a[0].dados_novos, { funcao: 'PRINCIPAL', tipoPessoa: 'PF', vinculo: 'INTERNO', inicioEm: '2026-10-01', atoInformado: true, conflitoInteresses: 'SEM_CONFLITO', temCnpj: false });
    assert.equal(a[1].dados_novos.temCnpj, true, 'PJ: só o indicador, nunca o número');
    const bruto = JSON.stringify(a);
    for (const sensivel of ['Ana', 'Bruno', 'example.invalid', '4000-1000', 'Portaria', 'Consultoria']) assert.equal(bruto.includes(sensivel), false, `auditoria sem ${sensivel}`);
  });

  test('duplicidade: segunda designação PRINCIPAL vigente é 409 LGPD_DPO_JA_VIGENTE (substituir é operação própria); o banco também recusa por índice único parcial', async () => {
    const r = await post(ENC, masterA, pf({ nome: 'Outra Pessoa Teste', email: 'outra@example.invalid' }));
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'LGPD_DPO_JA_VIGENTE');
    await assert.rejects(
      g.pool.query("INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, vinculo, email, inicio_em, designado_por) VALUES ($1, 'PRINCIPAL', 'PF', 'Dup', 'INTERNO', 'dup@example.invalid', '2026-10-10', $2)", [g.empresas.A, masterA.usuarioId]),
      (e) => e.code === '23505',
    );
  });

  test('substituir o principal: versão conferida (409 LGPD_DPO_VERSAO_DESATUALIZADA), o anterior fica ENCERRADA por SUBSTITUICAO com fim_em, o novo é vigente e aponta o anterior; auditoria LGPD_DPO_SUBSTITUIDO', async () => {
    const errada = await post(`${ENC}/${principal1.id}/substituir`, masterA, { versao: 9, ...pf({ nome: 'Carla Nova Teste', email: 'dpo.carla@example.invalid', inicioEm: '2026-10-20' }) });
    assert.equal(errada.status, 409);
    assert.equal(errada.body.codigo, 'LGPD_DPO_VERSAO_DESATUALIZADA');

    const r = await post(`${ENC}/${principal1.id}/substituir`, masterA, { versao: principal1.versao, fimAnteriorEm: '2026-10-19', ...pf({ nome: 'Carla Nova Teste', email: 'dpo.carla@example.invalid', inicioEm: '2026-10-20' }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const novo = r.body.encarregado;
    assert.deepEqual([novo.funcao, novo.situacao, novo.substituiId], ['PRINCIPAL', 'VIGENTE', principal1.id]);
    const anterior = await g.um('SELECT situacao, fim_em::text AS fim_em, motivo_encerramento, substituida_por_id::int AS substituida_por_id, versao FROM lgpd_encarregados WHERE id = $1', [principal1.id]);
    assert.deepEqual(anterior, { situacao: 'ENCERRADA', fim_em: '2026-10-19', motivo_encerramento: 'SUBSTITUICAO', substituida_por_id: novo.id, versao: 2 });
    assert.equal((await get(ENC, masterA)).body.encarregados.principal.id, novo.id);
    const a = await auditorias(g.empresas.A, 'LGPD_DPO_SUBSTITUIDO');
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].referencia, a[0].dados_anteriores.encarregadoId, a[0].dados_novos.encarregadoId], [String(novo.id), principal1.id, novo.id]);
    principal1 = novo;
  });

  test('corrigir contato: novo registro com os mesmos dados e contatos novos; o anterior encerra por CORRECAO sem perder o histórico; auditoria só com os nomes dos campos', async () => {
    const r = await post(`${ENC}/${substituto1.id}/contato`, masterA, { versao: substituto1.versao, telefone: '(11) 5000-2000', cargo: 'Consultor sênior' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const novo = r.body.encarregado;
    assert.deepEqual([novo.funcao, novo.razaoSocial, novo.nome, novo.email, novo.telefone, novo.cargo, novo.inicioEm], ['SUBSTITUTO', 'Consultoria Privacidade Teste Ltda', 'Bruno Responsavel Teste', 'dpo.bruno@example.invalid', '(11) 5000-2000', 'Consultor sênior', '2026-10-05']);
    const anterior = await g.um('SELECT situacao, motivo_encerramento, substituida_por_id::int AS substituida_por_id FROM lgpd_encarregados WHERE id = $1', [substituto1.id]);
    assert.deepEqual(anterior, { situacao: 'ENCERRADA', motivo_encerramento: 'CORRECAO', substituida_por_id: novo.id });
    const a = await auditorias(g.empresas.A, 'LGPD_DPO_CONTATO_ALTERADO');
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].dados_novos, { encarregadoId: novo.id, anteriorId: substituto1.id, camposAlterados: ['telefone', 'cargo'] });
    assert.equal(JSON.stringify(a).includes('5000-2000'), false);
    assert.equal(novo.cnpj, CNPJ_PJ, 'a correção de contato carrega o CNPJ da designação');
    const semMudanca = await post(`${ENC}/${novo.id}/contato`, masterA, { versao: novo.versao, telefone: '(11) 5000-2000' });
    assert.equal(semMudanca.status, 400);
    assert.equal(semMudanca.body.codigo, 'LGPD_DPO_SEM_ALTERACAO');
    // CNPJ já gravado não se troca por "contato": outra pessoa jurídica é Substituição. PF nunca recebe CNPJ.
    const trocaCnpj = await post(`${ENC}/${novo.id}/contato`, masterA, { versao: novo.versao, cnpj: CNPJ_PJ_2 });
    assert.deepEqual([trocaCnpj.status, trocaCnpj.body.codigo], [400, 'LGPD_DPO_CNPJ_IMUTAVEL']);
    const cnpjEmPf = await post(`${ENC}/${principal1.id}/contato`, masterA, { versao: principal1.versao, cnpj: CNPJ_PJ_2 });
    assert.deepEqual([cnpjEmPf.status, cnpjEmPf.body.codigo], [400, 'LGPD_DPO_CNPJ_NAO_SE_APLICA']);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM lgpd_encarregados WHERE cnpj = $1', [CNPJ_PJ_2])).n, 0, 'nada gravado nas recusas');
    substituto1 = novo;
  });

  test('encerrar o substituto: ENCERRADA por ENCERRAMENTO, vigente passa a nulo, histórico com todos os registros em ordem; encerrar de novo é 409', async () => {
    const r = await post(`${ENC}/${substituto1.id}/encerrar`, masterA, { versao: substituto1.versao, fimEm: '2026-10-27' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.encarregado.situacao, r.body.encarregado.fimEm, r.body.encarregado.motivoEncerramento], ['ENCERRADA', '2026-10-27', 'ENCERRAMENTO']);
    assert.equal((await get(ENC, masterA)).body.encarregados.substituto, null);
    const h = (await get(`${ENC}/historico`, masterA)).body.historico;
    assert.equal(h.length, 4);
    assert.deepEqual(h.map((x) => x.situacao), ['VIGENTE', 'ENCERRADA', 'ENCERRADA', 'ENCERRADA']);
    const denovo = await post(`${ENC}/${substituto1.id}/encerrar`, masterA, { versao: r.body.encarregado.versao });
    assert.equal(denovo.status, 409);
    assert.equal(denovo.body.codigo, 'LGPD_DPO_NAO_VIGENTE');
    const a = await auditorias(g.empresas.A, 'LGPD_DPO_ENCERRADO');
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].dados_novos, { encarregadoId: substituto1.id, fimEm: '2026-10-27', motivo: 'ENCERRAMENTO' });
  });

  test('integridade no banco: registro encerrado é imutável (UPDATE recusado), nenhum DELETE, dados identificadores de um vigente não mudam por UPDATE direto', async () => {
    await assert.rejects(g.pool.query("UPDATE lgpd_encarregados SET nome = 'X' WHERE id = $1", [substituto1.id]), /encerrad|imut/i);
    await assert.rejects(g.pool.query('DELETE FROM lgpd_encarregados WHERE id = $1', [substituto1.id]), /apag|delete|imut/i);
    await assert.rejects(g.pool.query("UPDATE lgpd_encarregados SET email = 'x@example.invalid' WHERE id = $1", [principal1.id]), /imut|não pode|alterad/i);
  });

  test('isolamento: o MASTER de B (provisionado) não vê nem altera registros de A (lista vazia; id de A é 404 no substituir, contato e encerrar)', async () => {
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.B, dryRun: false });
    assert.deepEqual((await get(ENC, masterB)).body.encarregados, { principal: null, substituto: null });
    assert.deepEqual((await get(`${ENC}/historico`, masterB)).body.historico, []);
    for (const [caminho, corpo] of [[`${ENC}/${principal1.id}/substituir`, { versao: 1, ...pf() }], [`${ENC}/${principal1.id}/contato`, { versao: 1, telefone: '(11) 4000-9999' }], [`${ENC}/${principal1.id}/encerrar`, { versao: 1 }]]) {
      const r = await post(caminho, masterB, corpo);
      assert.equal(r.status, 404, caminho);
      assert.equal(r.body.codigo, 'LGPD_DPO_NAO_ENCONTRADO');
    }
    assert.equal((await g.um('SELECT situacao FROM lgpd_encarregados WHERE id = $1', [principal1.id])).situacao, 'VIGENTE');
  });

  test('legado PJ sem CNPJ (linha anterior à 095, gravada por SQL na empresa B): "corrigir contato" só com o CNPJ completa o registro numa nova versão por CORRECAO; auditoria com temCnpj e sem o número; UPDATE direto recusado', async () => {
    const legado = await g.um(
      `INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, vinculo, email, inicio_em, designado_por)
       VALUES ($1, 'PRINCIPAL', 'PJ', 'Carla Legado Teste', 'Legado Consultoria Ltda', 'EXTERNO', 'dpo.legado@example.invalid', '2026-09-01', $2)
       RETURNING id::int AS id, versao, cnpj`,
      [g.empresas.B, masterB.usuarioId],
    );
    assert.equal(legado.cnpj, null);
    assert.equal((await get(ENC, masterB)).body.encarregados.principal.cnpj, null, 'legado lido com cnpj nulo');
    const r = await post(`${ENC}/${legado.id}/contato`, masterB, { versao: legado.versao, cnpj: CNPJ_PJ_FORMATADO });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const completado = r.body.encarregado;
    assert.deepEqual([completado.cnpj, completado.razaoSocial, completado.nome, completado.email, completado.substituiId], [CNPJ_PJ, 'Legado Consultoria Ltda', 'Carla Legado Teste', 'dpo.legado@example.invalid', legado.id]);
    const anterior = await g.um('SELECT situacao, motivo_encerramento, cnpj FROM lgpd_encarregados WHERE id = $1', [legado.id]);
    assert.deepEqual(anterior, { situacao: 'ENCERRADA', motivo_encerramento: 'CORRECAO', cnpj: null }, 'a linha legada não é reescrita');
    const a = await auditorias(g.empresas.B, 'LGPD_DPO_CONTATO_ALTERADO');
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].dados_novos.camposAlterados, ['cnpj']);
    assert.equal(JSON.stringify(a).includes(CNPJ_PJ), false, 'o número do CNPJ nunca vai à auditoria');
    const designadas = await auditorias(g.empresas.A, 'LGPD_DPO_DESIGNADO');
    assert.ok(designadas.every((x) => typeof x.dados_novos.temCnpj === 'boolean' && !JSON.stringify(x.dados_novos).includes(CNPJ_PJ)), 'designação audita só temCnpj');
    const direto = await g.pool.query('UPDATE lgpd_encarregados SET cnpj = $2 WHERE id = $1', [completado.id, CNPJ_PJ_2]).catch((e) => e);
    assert.equal(direto.code, 'P0001', 'UPDATE direto do CNPJ de uma vigente é recusado pelo gatilho');
    const pfComCnpj = await g.pool.query("INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, cnpj, vinculo, email, inicio_em, designado_por) VALUES ($1, 'SUBSTITUTO', 'PF', 'X', $3, 'INTERNO', 'x@example.invalid', '2026-09-01', $2)", [g.empresas.B, masterB.usuarioId, CNPJ_PJ_2]).catch((e) => e);
    assert.equal(pfComCnpj.code, '23514', 'CHECK: PF nunca tem CNPJ');
    // 14 posições com pontuação: cabe no CHAR(14) e cai no CHECK de formato (um valor maior que 14 nem chega ao CHECK: 22001).
    const formatoRuim = await g.pool.query("INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, email, inicio_em, designado_por) VALUES ($1, 'SUBSTITUTO', 'PJ', 'X', 'Y', '12.345.678/001', 'INTERNO', 'x@example.invalid', '2026-09-01', $2)", [g.empresas.B, masterB.usuarioId]).catch((e) => e);
    assert.equal(formatoRuim.code, '23514', 'CHECK: só o formato canônico');
    const longo = await g.pool.query("INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, email, inicio_em, designado_por) VALUES ($1, 'SUBSTITUTO', 'PJ', 'X', 'Y', '12.345.678/0001-95', 'INTERNO', 'x@example.invalid', '2026-09-01', $2)", [g.empresas.B, masterB.usuarioId]).catch((e) => e);
    assert.equal(longo.code, '22001', 'máscara completa não cabe em CHAR(14): recusada pelo tipo');
  });

  test('exclusividade (usuário): toggle lgpdEncarregado não aparece para USUARIO e ligar é 409 RECURSO_EXCLUSIVO_MASTER; PATCH individual é 409; lgpdRetencao idem; nada gravado; tentativa auditada', async () => {
    const u = await g.usuarioPronto(masterA);
    const lista = (await get(`${ACESSOS}/${u.id}/acessos`, masterA)).body.acessos.toggles;
    assert.equal(lista.some((t) => t.id === 'lgpdEncarregado'), false);
    assert.ok(lista.some((t) => t.id === 'privacidadeLgpd'), 'o toggle concedível continua oferecido');
    const t = await g.request(g.app).put(`${ACESSOS}/${u.id}/acessos/lgpdEncarregado`).set('Cookie', g.cookie(masterA)).send({ ligado: true });
    assert.equal(t.status, 409, JSON.stringify(t.body));
    assert.equal(t.body.codigo, 'RECURSO_EXCLUSIVO_MASTER');
    for (const recurso of ['lgpdEncarregado', 'lgpdRetencao']) {
      const p = await g.request(g.app).patch(`${ACESSOS}/${u.id}/permissoes/recursos/${recurso}`).set('Cookie', g.cookie(masterA)).send({ visualizar: true, editar: true });
      assert.equal(p.status, 409, `${recurso}: ${JSON.stringify(p.body)}`);
      assert.equal(p.body.codigo, 'RECURSO_EXCLUSIVO_MASTER');
    }
    assert.equal((await g.um("SELECT count(*)::int AS n FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2 AND recurso LIKE 'lgpd%'", [g.empresas.A, u.id])).n, 0);
    const a = await auditorias(g.empresas.A, 'LGPD_PERMISSAO_EXCLUSIVA_RECUSADA');
    assert.ok(a.length >= 3, `tentativas auditadas: ${a.length}`);
    assert.deepEqual(a[0].contexto.recurso, 'lgpdEncarregado');
    assert.equal(a[0].usuario_id, masterA.usuarioId);
    const { cookie } = await cookieDe(u);
    assert.equal((await getCookie(ENC, cookie)).status, 403);
    assert.equal((await getCookie('/api/auth/permissoes', cookie)).body.recursos.lgpdEncarregado.editar, false);
  });

  test('exclusividade (grupo): PATCH de recurso exclusivo no grupo e toggle de grupo são 409; o grupo não lista o toggle; nada gravado', async () => {
    const grupo = await novoGrupo(g.empresas.A, masterA, 'Grupo LGPD teste');
    for (const recurso of ['lgpdEncarregado', 'lgpdRetencao']) {
      const r = await g.request(g.app).patch(`/api/grupos-acesso/${grupo}/permissoes/recursos/${recurso}`).set('Cookie', g.cookie(masterA)).send({ podeVisualizar: true, podeEditar: true });
      assert.equal(r.status, 409, `${recurso}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.codigo, 'RECURSO_EXCLUSIVO_MASTER');
    }
    const toggle = await g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/lgpdEncarregado`).set('Cookie', g.cookie(masterA)).send({ ligado: true });
    assert.equal(toggle.status, 409);
    assert.equal(toggle.body.codigo, 'RECURSO_EXCLUSIVO_MASTER');
    const lista = (await g.request(g.app).get(`/api/grupos-acesso/${grupo}/acessos`).set('Cookie', g.cookie(masterA))).body.acessos.toggles;
    assert.equal(lista.some((t) => t.id === 'lgpdEncarregado'), false);
    assert.equal((await g.um("SELECT count(*)::int AS n FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso LIKE 'lgpd%'", [grupo])).n, 0);
  });

  test('dupla barreira: ADMINISTRADOR com GERENCIAR_USUARIOS e linha de perfil criada por fora passa na rota mas o serviço recusa a escrita (403 LGPD_DPO_SOMENTE_MASTER), nada gravado; a leitura dele continua pela linha', async () => {
    const adm = await g.administradorAutorizado(g.empresas.A, masterA);
    assert.equal((await post(ENC, adm, pj({ funcao: 'SUBSTITUTO' }))).status, 403, 'sem linha do perfil: a rota recusa');
    await g.pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir) VALUES ($1, 'ADMINISTRADOR', 'lgpdEncarregado', true, false, true, false)", [g.empresas.A]);
    const antes = (await g.um('SELECT count(*)::int AS n FROM lgpd_encarregados')).n;
    const r = await post(ENC, adm, pj({ funcao: 'SUBSTITUTO' }));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.codigo, 'LGPD_DPO_SOMENTE_MASTER');
    assert.equal((await g.um('SELECT count(*)::int AS n FROM lgpd_encarregados')).n, antes);
    assert.equal((await get(ENC, adm)).status, 200, 'a leitura segue a linha do perfil (consulta não é exclusiva da escrita)');
    const a = await auditorias(g.empresas.A, 'LGPD_DPO_ACESSO_RECUSADO');
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].usuario_id, a[0].contexto.operacao], [adm.usuarioId, 'designar']);
    await g.pool.query("DELETE FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'ADMINISTRADOR' AND recurso = 'lgpdEncarregado'", [g.empresas.A]);
  });

  test('quem só tem lgpd.visualizar vê o encarregado no resumo, mas não abre a rota do encarregado (403)', async () => {
    const u = await g.usuarioPronto(masterA);
    await g.request(g.app).put(`${ACESSOS}/${u.id}/acessos/privacidadeLgpd`).set('Cookie', g.cookie(masterA)).send({ ligado: true });
    const { cookie } = await cookieDe(u);
    const resumo = await getCookie(RESUMO, cookie);
    assert.equal(resumo.status, 200);
    assert.equal(resumo.body.resumo.encarregado.principal.nome, 'Carla Nova Teste');
    assert.equal((await getCookie(ENC, cookie)).status, 403);
    assert.equal((await getCookie(`${ENC}/historico`, cookie)).status, 403);
  });

  test('Log de ações: os eventos LGPD_DPO_* aparecem em GET /relatorios/auditoria/log com o filtro por ação, com referência e perfil do ator, e sem dados de contato', async () => {
    // O período é o dia civil de São Paulo de HOJE (os eventos foram gravados nesta execução), nunca uma data fixa.
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const r = await get(`/api/relatorios/auditoria/log?acao=LGPD_DPO&de=${hoje}&ate=${hoje}`, masterA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const acoes = r.body.itens.map((i) => i.acao);
    for (const esperado of ['LGPD_DPO_DESIGNADO', 'LGPD_DPO_SUBSTITUIDO', 'LGPD_DPO_CONTATO_ALTERADO', 'LGPD_DPO_ENCERRADO', 'LGPD_DPO_ACESSO_RECUSADO']) assert.ok(acoes.includes(esperado), esperado);
    assert.ok(r.body.itens.every((i) => i.perfil === 'MASTER' || i.perfil === 'ADMINISTRADOR'));
    assert.ok(r.body.itens.some((i) => i.referencia === String(principal1.id)));
    const bruto = JSON.stringify(r.body);
    for (const sensivel of ['example.invalid', '5000-2000', 'Carla', 'Consultoria', CNPJ_PJ, CNPJ_PJ_FORMATADO]) assert.equal(bruto.includes(sensivel), false, sensivel);
    const outra = await get(`/api/relatorios/auditoria/log?acao=LGPD_DPO&de=${hoje}&ate=${hoje}`, masterB);
    assert.deepEqual([...new Set(outra.body.itens.map((i) => i.acao))], ['LGPD_DPO_CONTATO_ALTERADO'], 'a empresa B vê só a própria trilha (a correção do legado), nunca a de A');
    assert.ok(outra.body.itens.every((i) => i.referencia !== String(principal1.id)));
  });
});
