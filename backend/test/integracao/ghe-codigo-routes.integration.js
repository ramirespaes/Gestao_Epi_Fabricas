'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');

/**
 * RED — Incremento 2: código do GHE no backend (regras de negócio e API). A migration 083 já criou a coluna
 * `grupos_homogeneos_exposicao.codigo VARCHAR(30) NULL` com a forma canônica e a unicidade por empresa; aqui ficam as regras
 * do serviço/API, pelas rotas REAIS de produção (autorização, schemas, controller, serviço, repositório e PostgreSQL real em
 * schema temporário com TODAS as migrations). Só a sessão é peça de teste (cabeçalho x-teste-usuario).
 *
 * Contrato aprovado:
 *  - NOVO GHE exige `codigo` (400 GHE_CODIGO_OBRIGATORIO se ausente) no formato "GHE-" + 3 a 6 dígitos (400 GHE_CODIGO_INVALIDO);
 *    a entrada é aparada e vai para maiúsculas. A Descrição (`nome`) continua obrigatória.
 *  - Código único por empresa (409 GHE_CODIGO_EM_USO, inclusive na corrida; outra empresa pode repetir). Nunca 500.
 *  - PATCH aceita `codigo`: o código NÃO é imutável, mas segue formato, normalização e unicidade; não pode voltar a nulo/vazio.
 *  - Informar o mesmo código já gravado não grava nada e não audita troca de código.
 *  - GHE legado (codigo NULL) continua consultável/editável/inativável/reativável sem que se exija código, e pode recebê-lo.
 *  - GET (individual e lista) devolve `codigo` (string ou null). Setor, função, descrição e riscos continuam no contrato.
 *  - Auditoria: GHE_CRIADO traz `codigo`; a troca registra anterior e novo em GHE_ALTERADO; sem alteração efetiva, sem auditoria.
 *  - Isolamento por empresa.
 *
 * Erros de domínio saem com `body.codigo` no topo (como GHE_NOME_EM_USO); só tipo de dado errado é erro de schema (VALIDACAO).
 * Os testes de alteração semeiam o GHE por SQL, para falharem pela funcionalidade ausente e não pelo cadastro.
 */

const RAIZ = '/api/grupos-homogeneos';
let contadorDeCodigos = 0;
const codigoNovo = () => { contadorDeCodigos += 1; return `GHE-${String(700 + contadorDeCodigos).padStart(3, '0')}`; };
const nomeNovo = (prefixo = 'GHE') => `${prefixo} ${crypto.randomUUID().slice(0, 8)}`;

describe('código do GHE — regras e API (RED)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soVer;
  let seq = 0;

  const como = (id) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(id)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(id)).send(corpo),
    patch: (url, corpo = {}) => request(app).patch(url).set(CABECALHO, String(id)).send(corpo),
  });
  async function usuarioCom(empresaId, operacoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `ghe-codigo-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    await ctx.pool.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, 'employeeGroups', $3, $4, $5, false, $6)`,
      [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), mestre],
    );
    return id;
  }

  const q = (sql, params) => ctx.pool.query(sql, params);
  /** GHE semeado por SQL (legado ou já com código): independe do cadastro que está sendo especificado. */
  async function semear(empresaId, campos = {}) {
    const v = { empresa_id: empresaId, nome: nomeNovo('Semeado'), ...campos };
    const colunas = Object.keys(v);
    return (await q(`INSERT INTO grupos_homogeneos_exposicao (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(v))).rows[0];
  }
  const linha = async (id) => (await q('SELECT * FROM grupos_homogeneos_exposicao WHERE id = $1', [id])).rows[0];
  const total = async (empresaId) => (await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao WHERE empresa_id = $1', [empresaId])).rows[0].n;
  const auditorias = async (empresaId, acao, referencia) => (await q(
    'SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3 ORDER BY id', [empresaId, acao, String(referencia)],
  )).rows;
  const criar = (corpo, quem = gestor) => como(quem).post(RAIZ, corpo);

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => {
      a.use('/api', criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool }));
    });
    gestor = await usuarioCom(d.empresaA, ['visualizar', 'criar', 'editar']);
    gestorB = await usuarioCom(d.empresaB, ['visualizar', 'criar', 'editar']);
    soVer = await usuarioCom(d.empresaA, ['visualizar']);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('criação: código obrigatório, formato e normalização', () => {
    test('aceita GHE- + 3 a 6 dígitos; a entrada é aparada e vai para maiúsculas; o valor normalizado é persistido e devolvido', async () => {
      const casos = [
        ['GHE-001', 'GHE-001'], ['GHE-032', 'GHE-032'], ['GHE-1000', 'GHE-1000'], ['GHE-999999', 'GHE-999999'],
        ['ghe-003', 'GHE-003'], ['  ghe-004  ', 'GHE-004'], ['Ghe-005', 'GHE-005'],
      ];
      for (const [entrada, esperado] of casos) {
        const r = await criar({ nome: nomeNovo(), codigo: entrada });
        assert.equal(r.status, 201, `${JSON.stringify(entrada)} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.grupo.codigo, esperado, JSON.stringify(entrada));
        assert.equal((await linha(r.body.grupo.id)).codigo, esperado, 'persistido normalizado');
      }
    });

    test('código ausente: 400 GHE_CODIGO_OBRIGATORIO e nada é criado', async () => {
      const antes = await total(d.empresaA);
      const r = await criar({ nome: nomeNovo() });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.codigo, 'GHE_CODIGO_OBRIGATORIO');
      assert.equal(await total(d.empresaA), antes);
    });

    test('código presente porém inválido: 400 GHE_CODIGO_INVALIDO e nada é criado', async () => {
      const antes = await total(d.empresaA);
      const invalidos = ['GHE-01', 'GHE-1234567', 'ABC-001', 'GHE-ABC', 'GHE 001', '', '   ', 'GHE001', 'GHE-0 01', 'GHE--001', '-GHE-001', 'GHE-00１'];
      for (const codigo of invalidos) {
        const r = await criar({ nome: nomeNovo(), codigo });
        assert.equal(r.status, 400, `${JSON.stringify(codigo)} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.codigo, 'GHE_CODIGO_INVALIDO', JSON.stringify(codigo));
      }
      assert.equal(await total(d.empresaA), antes);
    });

    test('tipo de dado errado no código (número, objeto, lista, lista com texto, booleano): campo reconhecido, 400 VALIDACAO com TIPO_INVALIDO em body.codigo', async () => {
      const antes = await total(d.empresaA);
      for (const codigo of [123, {}, [], ['GHE-001'], true]) {
        const r = await criar({ nome: nomeNovo(), codigo });
        const quando = `${JSON.stringify(codigo)} → ${JSON.stringify(r.body)}`;
        assert.equal(r.status, 400, quando);
        assert.equal(r.body.codigo, 'VALIDACAO', quando);
        const doCodigo = (r.body.detalhes || []).filter((x) => x.campo === 'body.codigo');
        assert.ok(doCodigo.length > 0, `body.codigo ausente dos detalhes: ${quando}`);
        assert.ok(doCodigo.every((x) => x.codigo === 'TIPO_INVALIDO'), `esperado TIPO_INVALIDO (nunca CAMPO_NAO_PERMITIDO): ${quando}`);
      }
      assert.equal(await total(d.empresaA), antes);
    });

    // Contrato EXISTENTE do nome, preservado: erro de schema (VALIDACAO), sem código de domínio novo.
    test('a Descrição (nome) segue com o contrato atual: ausente ou só com espaços é 400 VALIDACAO e nada é criado', async () => {
      const antes = await total(d.empresaA);
      const semNome = await criar({ codigo: codigoNovo() });
      assert.equal(semNome.status, 400, JSON.stringify(semNome.body));
      assert.equal(semNome.body.codigo, 'VALIDACAO', JSON.stringify(semNome.body));
      assert.ok((semNome.body.detalhes || []).some((x) => x.campo === 'body.nome' && x.codigo === 'CAMPO_OBRIGATORIO'), JSON.stringify(semNome.body));
      const vazio = await criar({ nome: '   ', codigo: codigoNovo() });
      assert.equal(vazio.status, 400, JSON.stringify(vazio.body));
      assert.equal(vazio.body.codigo, 'VALIDACAO', JSON.stringify(vazio.body));
      assert.ok((vazio.body.detalhes || []).some((x) => x.campo === 'body.nome' && x.codigo === 'NOME_INVALIDO'), JSON.stringify(vazio.body));
      assert.ok(!(vazio.body.detalhes || []).some((x) => x.campo === 'body.codigo'), 'o código válido não pode ser o motivo da recusa');
      assert.equal(await total(d.empresaA), antes);
    });

    test('os campos legados (setor, função, descrição, riscos) continuam aceitos junto com o código', async () => {
      const codigo = codigoNovo();
      const r = await criar({ nome: nomeNovo(), codigo, setor: 'Manutenção', funcao: 'Mecânico', descricao: 'Texto antigo', riscos: 'Ruído' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.grupo.codigo, r.body.grupo.setor, r.body.grupo.funcao, r.body.grupo.descricao, r.body.grupo.riscos], [codigo, 'Manutenção', 'Mecânico', 'Texto antigo', 'Ruído']);
    });

    test('a auditoria GHE_CRIADO traz o código no instantâneo', async () => {
      const codigo = codigoNovo();
      const r = await criar({ nome: nomeNovo(), codigo: codigo.toLowerCase() });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const [a, ...resto] = await auditorias(d.empresaA, 'GHE_CRIADO', r.body.grupo.id);
      assert.equal(resto.length, 0);
      assert.equal(a.dados_novos.codigo, codigo);
      assert.equal(a.dados_novos.nome, r.body.grupo.nome);
    });
  });

  describe('unicidade por empresa', () => {
    test('mesmo código na mesma empresa: 409 GHE_CODIGO_EM_USO (inclusive em outra caixa); nada é criado; outra empresa pode usar o mesmo código', async () => {
      const codigo = codigoNovo();
      assert.equal((await criar({ nome: nomeNovo(), codigo })).status, 201);
      const antes = await total(d.empresaA);
      for (const entrada of [codigo, codigo.toLowerCase(), `  ${codigo} `]) {
        const r = await criar({ nome: nomeNovo(), codigo: entrada });
        assert.equal(r.status, 409, `${entrada} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.codigo, 'GHE_CODIGO_EM_USO');
      }
      assert.equal(await total(d.empresaA), antes);
      const outraEmpresa = await criar({ nome: nomeNovo(), codigo }, gestorB);
      assert.equal(outraEmpresa.status, 201, JSON.stringify(outraEmpresa.body));
      assert.equal(outraEmpresa.body.grupo.codigo, codigo);
    });

    test('o 409 não revela o GHE que já usa o código', async () => {
      const codigo = codigoNovo();
      const dono = await criar({ nome: 'Nome Reservado Do Dono', codigo });
      const r = await criar({ nome: nomeNovo(), codigo });
      assert.equal(r.status, 409);
      const texto = JSON.stringify(r.body);
      assert.ok(!texto.includes('Nome Reservado Do Dono') && !texto.includes(`"id":${dono.body.grupo.id}`), texto);
    });

    test('corrida: criações simultâneas com o mesmo código resultam em exatamente um 201 e os demais 409 — nunca 500', async () => {
      const codigo = codigoNovo();
      const respostas = await Promise.all([1, 2, 3, 4].map(() => criar({ nome: nomeNovo('Corrida'), codigo })));
      const status = respostas.map((r) => r.status).sort();
      assert.deepEqual(status, [201, 409, 409, 409], JSON.stringify(respostas.map((r) => [r.status, r.body.codigo])));
      assert.ok(respostas.filter((r) => r.status === 409).every((r) => r.body.codigo === 'GHE_CODIGO_EM_USO'));
      assert.equal((await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND codigo = $2', [d.empresaA, codigo])).rows[0].n, 1);
    });

    test('corrida na edição: dois GHEs recebendo o mesmo código ao mesmo tempo resultam em um 200 e um 409 — nunca 500', async () => {
      const a = await semear(d.empresaA, { codigo: codigoNovo() });
      const b = await semear(d.empresaA, { codigo: codigoNovo() });
      const alvo = codigoNovo();
      const respostas = await Promise.all([
        como(gestor).patch(`${RAIZ}/${a.id}`, { codigo: alvo }),
        como(gestor).patch(`${RAIZ}/${b.id}`, { codigo: alvo }),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 409], JSON.stringify(respostas.map((r) => [r.status, r.body.codigo])));
      assert.equal(respostas.find((r) => r.status === 409).body.codigo, 'GHE_CODIGO_EM_USO');
      assert.equal((await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND codigo = $2', [d.empresaA, alvo])).rows[0].n, 1);
    });
  });

  describe('edição: o código NÃO é imutável', () => {
    test('troca GHE-002 por outro código válido e livre; persiste normalizado; audita anterior e novo', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const novo = codigoNovo();
      const antes = await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id);
      const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: `  ${novo.toLowerCase()} ` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.grupo.codigo, novo);
      assert.equal((await linha(ghe.id)).codigo, novo);
      const depois = await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id);
      assert.equal(depois.length, antes.length + 1, 'uma auditoria da troca');
      const a = depois.at(-1);
      assert.equal(a.dados_anteriores.codigo, ghe.codigo);
      assert.equal(a.dados_novos.codigo, novo);
    });

    test('código e descrição trocados juntos: um PATCH, uma auditoria com os dois valores novos e anteriores', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const novo = codigoNovo();
      const nome = nomeNovo('Renomeado');
      const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: novo, nome });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [a] = await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id);
      assert.deepEqual([a.dados_anteriores.codigo, a.dados_novos.codigo, a.dados_anteriores.nome, a.dados_novos.nome], [ghe.codigo, novo, ghe.nome, nome]);
    });

    test('código de outro GHE da mesma empresa: 409 GHE_CODIGO_EM_USO, nada muda e nada é auditado; outra empresa pode ter o mesmo código', async () => {
      const dono = await semear(d.empresaA, { codigo: codigoNovo() });
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: dono.codigo });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.codigo, 'GHE_CODIGO_EM_USO');
      assert.equal((await linha(ghe.id)).codigo, ghe.codigo);
      assert.equal((await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id)).length, 0);
      const deB = await semear(d.empresaB, { codigo: codigoNovo() });
      const outra = await como(gestorB).patch(`${RAIZ}/${deB.id}`, { codigo: dono.codigo });
      assert.equal(outra.status, 200, JSON.stringify(outra.body));
    });

    test('código inválido na edição: 400 GHE_CODIGO_INVALIDO e o código atual permanece', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      for (const codigo of ['GHE-01', 'GHE-1234567', 'ABC-001', 'GHE-ABC', 'GHE 001', 'GHE001']) {
        const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo });
        assert.equal(r.status, 400, `${codigo} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.codigo, 'GHE_CODIGO_INVALIDO', codigo);
      }
      assert.equal((await linha(ghe.id)).codigo, ghe.codigo);
      assert.equal((await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id)).length, 0);
    });

    test('o código não pode ser removido pela API: nulo ou vazio é recusado (400 GHE_CODIGO_INVALIDO) e o código permanece', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      for (const codigo of [null, '', '   ']) {
        const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo });
        assert.equal(r.status, 400, `${JSON.stringify(codigo)} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.codigo, 'GHE_CODIGO_INVALIDO', JSON.stringify(codigo));
      }
      assert.equal((await linha(ghe.id)).codigo, ghe.codigo);
    });

    test('mesmo código (após normalizar): nada é gravado e não há auditoria de troca de código', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const antes = await linha(ghe.id);
      for (const entrada of [ghe.codigo, ghe.codigo.toLowerCase(), `  ${ghe.codigo} `]) {
        const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: entrada });
        assert.equal(r.status, 200, `${entrada} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.grupo.codigo, ghe.codigo);
      }
      const depois = await linha(ghe.id);
      assert.equal(new Date(depois.atualizado_em).getTime(), new Date(antes.atualizado_em).getTime(), 'nenhuma gravação inútil');
      assert.equal((await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id)).length, 0);
    });

    test('mesmo código junto de outra alteração: a auditoria da alteração existe e o código aparece igual antes e depois (nenhuma troca)', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: ghe.codigo, nome: nomeNovo('Só a descrição') });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [a, ...resto] = await auditorias(d.empresaA, 'GHE_ALTERADO', ghe.id);
      assert.equal(resto.length, 0);
      assert.equal(a.dados_anteriores.codigo, ghe.codigo);
      assert.equal(a.dados_novos.codigo, ghe.codigo);
    });

    test('os campos legados continuam aceitos no PATCH e são preservados quando ausentes', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo(), setor: 'Almox', funcao: 'Auxiliar', descricao: 'Texto antigo', riscos: 'Poeira' });
      const trocaCodigo = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { codigo: codigoNovo() });
      assert.equal(trocaCodigo.status, 200, JSON.stringify(trocaCodigo.body));
      assert.deepEqual([trocaCodigo.body.grupo.setor, trocaCodigo.body.grupo.funcao, trocaCodigo.body.grupo.descricao, trocaCodigo.body.grupo.riscos], ['Almox', 'Auxiliar', 'Texto antigo', 'Poeira']);
      const setor = await como(gestor).patch(`${RAIZ}/${ghe.id}`, { setor: 'Expedição' });
      assert.equal(setor.status, 200);
      assert.equal(setor.body.grupo.codigo, trocaCodigo.body.grupo.codigo, 'o código ausente no PATCH é preservado');
    });
  });

  describe('GHE legado (codigo NULL, anterior à 083)', () => {
    test('continua consultável, editável sem código, inativável e reativável; nada exige que se atribua código', async () => {
      const legado = await semear(d.empresaA, { setor: 'Antigo' });
      assert.equal(legado.codigo, null);
      const lido = await como(soVer).get(`${RAIZ}/${legado.id}`);
      assert.equal(lido.status, 200);
      assert.equal(lido.body.grupo.codigo, null);
      const nome = nomeNovo('Nova descrição');
      const editado = await como(gestor).patch(`${RAIZ}/${legado.id}`, { nome });
      assert.equal(editado.status, 200, JSON.stringify(editado.body));
      assert.deepEqual([editado.body.grupo.nome, editado.body.grupo.codigo], [nome, null]);
      const riscos = await como(gestor).patch(`${RAIZ}/${legado.id}`, { riscos: 'Ruído' });
      assert.equal(riscos.status, 200);
      assert.equal((await como(gestor).post(`${RAIZ}/${legado.id}/inativar`)).status, 200);
      assert.equal((await como(gestor).post(`${RAIZ}/${legado.id}/reativar`)).status, 200);
      assert.equal((await linha(legado.id)).codigo, null, 'permanece sem código');
    });

    test('o legado pode receber um código (formato e unicidade valem); depois ele não pode mais ser removido', async () => {
      const legado = await semear(d.empresaA);
      const ruim = await como(gestor).patch(`${RAIZ}/${legado.id}`, { codigo: 'GHE-1' });
      assert.equal(ruim.status, 400);
      assert.equal(ruim.body.codigo, 'GHE_CODIGO_INVALIDO');
      const dono = await semear(d.empresaA, { codigo: codigoNovo() });
      const emUso = await como(gestor).patch(`${RAIZ}/${legado.id}`, { codigo: dono.codigo });
      assert.equal(emUso.status, 409);
      assert.equal(emUso.body.codigo, 'GHE_CODIGO_EM_USO');
      const codigo = codigoNovo();
      const ok = await como(gestor).patch(`${RAIZ}/${legado.id}`, { codigo });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.grupo.codigo, codigo);
      const [a] = await auditorias(d.empresaA, 'GHE_ALTERADO', legado.id);
      assert.deepEqual([a.dados_anteriores.codigo, a.dados_novos.codigo], [null, codigo], 'a atribuição ao legado fica auditada (de nulo para o código)');
      const remover = await como(gestor).patch(`${RAIZ}/${legado.id}`, { codigo: null });
      assert.equal(remover.status, 400);
      assert.equal(remover.body.codigo, 'GHE_CODIGO_INVALIDO');
      assert.equal((await linha(legado.id)).codigo, codigo);
    });
  });

  describe('leitura', () => {
    test('GET individual e listagem devolvem `codigo` (string ou null) e mantêm todos os campos antigos', async () => {
      const comCodigo = await semear(d.empresaA, { codigo: codigoNovo(), nome: nomeNovo('Lista com código'), setor: 'S', funcao: 'F', descricao: 'D', riscos: 'R' });
      const legado = await semear(d.empresaA, { nome: nomeNovo('Lista legado') });
      const antigos = ['ativo', 'atualizadoEm', 'criadoEm', 'descricao', 'empresaId', 'funcao', 'id', 'nome', 'riscos', 'setor'];
      const um = await como(soVer).get(`${RAIZ}/${comCodigo.id}`);
      assert.equal(um.status, 200);
      assert.deepEqual(Object.keys(um.body.grupo).sort(), [...antigos, 'codigo'].sort());
      assert.equal(um.body.grupo.codigo, comCodigo.codigo);
      const lista = await como(soVer).get(`${RAIZ}?limite=100`);
      assert.equal(lista.status, 200);
      const dela = lista.body.grupos.find((g) => g.id === comCodigo.id);
      const dele = lista.body.grupos.find((g) => g.id === legado.id);
      assert.equal(dela.codigo, comCodigo.codigo);
      assert.equal(dele.codigo, null);
      assert.ok(lista.body.grupos.every((g) => Object.hasOwn(g, 'codigo')), 'todo item da lista traz o campo codigo');
      assert.deepEqual(Object.keys(dela).sort(), [...antigos, 'codigo'].sort());
    });
  });

  describe('isolamento e permissão', () => {
    test('a empresa B não consulta nem altera GHE da empresa A: o mesmo 404 do inexistente, e o código de A não vaza', async () => {
      const deA = await semear(d.empresaA, { codigo: codigoNovo() });
      const inexistente = 2147483000;
      const lerA = await como(gestorB).get(`${RAIZ}/${deA.id}`);
      const lerNada = await como(gestorB).get(`${RAIZ}/${inexistente}`);
      assert.equal(lerA.status, 404);
      assert.deepEqual([lerA.status, lerA.body], [lerNada.status, lerNada.body]);
      const alterarA = await como(gestorB).patch(`${RAIZ}/${deA.id}`, { codigo: codigoNovo() });
      const alterarNada = await como(gestorB).patch(`${RAIZ}/${inexistente}`, { codigo: codigoNovo() });
      assert.equal(alterarA.status, 404);
      assert.deepEqual([alterarA.status, alterarA.body], [alterarNada.status, alterarNada.body]);
      assert.equal((await linha(deA.id)).codigo, deA.codigo);
      assert.ok(!JSON.stringify((await como(gestorB).get(`${RAIZ}?limite=100`)).body).includes(deA.codigo), 'a listagem da B não traz o código de A');
    });

    test('quem só visualiza não cria nem edita código (403) e nada muda; sem sessão é 401', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const antes = await total(d.empresaA);
      const criarSemPermissao = await criar({ nome: nomeNovo(), codigo: codigoNovo() }, soVer);
      assert.equal(criarSemPermissao.status, 403);
      const editarSemPermissao = await como(soVer).patch(`${RAIZ}/${ghe.id}`, { codigo: codigoNovo() });
      assert.equal(editarSemPermissao.status, 403);
      assert.equal(await total(d.empresaA), antes);
      assert.equal((await linha(ghe.id)).codigo, ghe.codigo);
      assert.equal((await request(app).post(RAIZ).send({ nome: nomeNovo(), codigo: codigoNovo() })).status, 401);
    });

    test('regressão: PATCH vazio continua 400 GHE_SEM_ALTERACAO', async () => {
      const ghe = await semear(d.empresaA, { codigo: codigoNovo() });
      const r = await como(gestor).patch(`${RAIZ}/${ghe.id}`, {});
      assert.equal(r.status, 400);
      assert.equal(r.body.codigo, 'GHE_SEM_ALTERACAO');
    });
  });
});
