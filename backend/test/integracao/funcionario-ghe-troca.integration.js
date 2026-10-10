'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');
const { DISPOSITIVO } = require('./helpers/ambiente-funcionario-situacao');

/**
 * S3 (RED) — a TROCA de GHE do funcionário (PATCH /api/funcionarios/:id com `grupoHomogeneoId`) passa a gerar
 * `FUNCIONARIO_GHE_ALTERADO` na mesma transação, além do `FUNCIONARIO_ALTERADO` de sempre.
 *
 * Contrato esperado:
 *   - autoridade `employeeHistory.editar` (nenhuma permissão nova; sem Gestão de GHE);
 *   - o GHE novo existe, é da empresa e está ativo (400 FUNCIONARIO_GHE_INVALIDO / 409 FUNCIONARIO_GHE_INATIVO, como hoje);
 *   - evento SÓ na alteração REAL: o mesmo GHE, ou um PATCH sem GHE, não gera o evento específico;
 *   - auditoria: ator, empresa, funcionário, ip, dispositivo, contexto.origem = GESTAO_FUNCIONARIOS,
 *     dados_anteriores.grupoHomogeneo e dados_novos.grupoHomogeneo = { id, codigo, descricao } (null quando não havia GHE);
 *     nunca CPF, telefone nem nascimento;
 *   - falha na auditoria específica desfaz a troca (rollback); legado sem GHE segue consultável, editável e pode receber GHE;
 *   - a troca não toca entregas, solicitações, ficha nem auditorias anteriores.
 *
 * Os casos de GHE inválido/inativo e o PATCH sem GHE já valem hoje e são guardas de regressão.
 */

describe('S3 — troca de GHE do funcionário', () => {
  let amb;
  before(async () => { amb = await montarAmbienteGhe(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const trocar = (usuarioId, id, corpo) => amb.como(usuarioId).patch(`/api/funcionarios/${id}`, corpo);
  const dados = (id, codigo, descricao) => ({ id, codigo, descricao });
  const eventosGhe = (id) => amb.auditoria('FUNCIONARIO_GHE_ALTERADO', id);
  const eventosGenericos = (id) => amb.auditoria('FUNCIONARIO_ALTERADO', id);

  describe('a troca e as regras de validade do GHE', () => {
    test('troca válida por quem tem employeeHistory.editar (sem Gestão de GHE): 200, GHE novo gravado e na resposta', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.comEditar, id, { grupoHomogeneoId: amb.ghes.caldeiraria });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await amb.gheDe(id), amb.ghes.caldeiraria);
      assert.equal(r.body.funcionario?.grupoHomogeneoId, amb.ghes.caldeiraria);
      assert.deepEqual(r.body.funcionario?.grupoHomogeneo, dados(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'));
    });

    test('sem employeeHistory.editar (só visualizar): 403, o GHE não muda e nada é auditado', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.soVisualizar, id, { grupoHomogeneoId: amb.ghes.caldeiraria });
      assert.equal(r.status, 403);
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
      assert.equal((await eventosGhe(id)).length, 0);
      assert.equal((await eventosGenericos(id)).length, 0);
    });

    test('GHE inexistente, de outra empresa e inativo são recusados; o GHE do funcionário e a auditoria ficam como estavam', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      for (const inexistente of [999999, amb.ghes.outraEmpresa]) {
        const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: inexistente });
        assert.deepEqual([r.status, r.body.codigo], [400, 'FUNCIONARIO_GHE_INVALIDO'], String(inexistente));
      }
      const inativo = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.encerrado });
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_GHE_INATIVO']);
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
      assert.equal((await eventosGhe(id)).length, 0);
      assert.equal((await eventosGenericos(id)).length, 0);
    });
  });

  describe('auditoria FUNCIONARIO_GHE_ALTERADO', () => {
    test('uma linha por troca real, com funcionário, ator, empresa, ip, dispositivo, instante e origem GESTAO_FUNCIONARIOS', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.comEditar, id, { grupoHomogeneoId: amb.ghes.caldeiraria });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const linhas = await eventosGhe(id);
      assert.equal(linhas.length, 1);
      const [linha] = linhas;
      assert.equal(linha.referencia, String(id));
      assert.equal(linha.empresa_id, amb.d.empresaA);
      assert.equal(linha.usuario_id, amb.usuarios.comEditar);
      assert.ok(typeof linha.ip === 'string' && linha.ip.length > 0, 'ip ausente');
      assert.equal(linha.dispositivo, DISPOSITIVO);
      assert.equal(linha.contexto?.origem, 'GESTAO_FUNCIONARIOS');
      assert.ok(Math.abs(linha.agora - linha.criado_em) < 60_000, 'data/hora fora da transação da alteração');
    });

    test('anterior e novo com id, código e descrição; GHE legado sem código tem codigo nulo; sem GHE anterior, anterior nulo', async () => {
      const deLegado = await amb.trabalhadorNoGhe(amb.ghes.legado);
      assert.equal((await trocar(amb.usuarios.master, deLegado, { grupoHomogeneoId: amb.ghes.soldagem })).status, 200);
      const [linha] = await eventosGhe(deLegado);
      assert.deepEqual(linha?.dados_anteriores?.grupoHomogeneo, dados(amb.ghes.legado, null, 'GHE A'));
      assert.deepEqual(linha?.dados_novos?.grupoHomogeneo, dados(amb.ghes.soldagem, 'GHE-020', 'Soldagem'));

      const semGhe = await amb.trabalhadorNoGhe(null);
      assert.equal((await trocar(amb.usuarios.master, semGhe, { grupoHomogeneoId: amb.ghes.caldeiraria })).status, 200);
      const [atribuicao] = await eventosGhe(semGhe);
      assert.equal(atribuicao?.dados_anteriores?.grupoHomogeneo, null);
      assert.deepEqual(atribuicao?.dados_novos?.grupoHomogeneo, dados(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'));
    });

    // S4 (antes, no S3: "desvincular é troca real, com evento de novo nulo"): quem já tem GHE não fica sem; a recusa não escreve nem audita.
    test('desvincular (grupoHomogeneoId nulo) é recusado (400 FUNCIONARIO_GHE_OBRIGATORIO): o GHE fica e nenhum evento nasce', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: null });
      assert.deepEqual([r.status, r.body.codigo], [400, 'FUNCIONARIO_GHE_OBRIGATORIO']);
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
      assert.equal((await eventosGhe(id)).length, 0);
      assert.equal((await eventosGenericos(id)).length, 0);
    });

    test('nunca CPF, telefone nem data de nascimento, nem as chaves correspondentes', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      await amb.pool.query("UPDATE funcionarios SET telefone = '47988776655', data_nascimento = '1987-06-15' WHERE id = $1", [id]);
      const { cpf } = await amb.ler(id);
      const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.caldeiraria, telefone: '47911112222' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [linha] = await eventosGhe(id);
      assert.ok(linha, 'sem linha de auditoria do GHE');
      const texto = JSON.stringify([linha.contexto, linha.dados_anteriores, linha.dados_novos, linha.referencia, linha.dispositivo]);
      for (const proibido of [cpf, '47988776655', '47911112222', '1987-06-15', '15/06/1987']) assert.equal(texto.includes(proibido), false, `vazou ${proibido}`);
      assert.doesNotMatch(texto, /cpf|telefone|nascimento/i);
    });

    test('o mesmo GHE não gera o evento específico (e o genérico continua, como hoje)', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.soldagem, setor: 'Solda' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await eventosGhe(id)).length, 0, 'o mesmo GHE não é troca');
      assert.equal((await eventosGenericos(id)).length, 1);
    });

    test('PATCH sem GHE (só outros campos) não gera o evento específico; o genérico continua', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.master, id, { setor: 'Montagem' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await eventosGhe(id)).length, 0);
      assert.equal((await eventosGenericos(id)).length, 1);
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
    });

    test('o evento genérico FUNCIONARIO_ALTERADO continua na troca real, com o GHE antes e depois', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.caldeiraria });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const genericos = await eventosGenericos(id);
      assert.equal(genericos.length, 1);
      assert.equal(genericos[0].dados_anteriores.grupoHomogeneoId, amb.ghes.soldagem);
      assert.equal(genericos[0].dados_novos.grupoHomogeneoId, amb.ghes.caldeiraria);
      assert.ok(Array.isArray(genericos[0].contexto.camposSensiveisOmitidos));
      assert.equal((await eventosGhe(id)).length, 1, 'e o específico também');
    });

    test('mesma transação: se a gravação do evento específico falha, a troca de GHE desfaz (500, GHE e auditoria intactos)', async () => {
      const id = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
      await amb.pool.query(`CREATE FUNCTION s3_falha_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.acao = 'FUNCIONARIO_GHE_ALTERADO' THEN RAISE EXCEPTION 'falha induzida pelo teste'; END IF; RETURN NEW; END $$`);
      await amb.pool.query('CREATE TRIGGER trg_s3_falha_auditoria BEFORE INSERT ON logs_auditoria FOR EACH ROW EXECUTE FUNCTION s3_falha_auditoria()');
      try {
        const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.caldeiraria });
        assert.equal(r.status, 500, 'a falha da auditoria específica deveria derrubar a operação');
        assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
        assert.equal((await eventosGenericos(id)).length, 0, 'o genérico da mesma transação também desfaz');
      } finally {
        await amb.pool.query('DROP TRIGGER IF EXISTS trg_s3_falha_auditoria ON logs_auditoria');
        await amb.pool.query('DROP FUNCTION IF EXISTS s3_falha_auditoria()');
      }
    });
  });

  describe('legado sem GHE', () => {
    test('continua consultável e editável sem GHE; só o GHE informado e válido o regulariza', async () => {
      const id = await amb.trabalhadorNoGhe(null);
      const consulta = await amb.como(amb.usuarios.master).get(`/api/funcionarios/${id}`);
      assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
      assert.equal(consulta.body.funcionario?.grupoHomogeneo, null);

      const edicao = await trocar(amb.usuarios.master, id, { setor: 'Almoxarifado' });
      assert.equal(edicao.status, 200, JSON.stringify(edicao.body));
      assert.equal(await amb.gheDe(id), null, 'editar outro campo não inventa GHE');
      assert.equal((await eventosGhe(id)).length, 0);

      const regularizado = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.soldagem });
      assert.equal(regularizado.status, 200, JSON.stringify(regularizado.body));
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
      assert.deepEqual(regularizado.body.funcionario?.grupoHomogeneo, dados(amb.ghes.soldagem, 'GHE-020', 'Soldagem'));
      assert.equal((await eventosGhe(id)).length, 1);
    });
  });

  describe('a troca não apaga nem reescreve o histórico', () => {
    test('entregas, solicitações, ficha e auditorias anteriores ficam idênticos; o GHE novo vale daí em diante', async () => {
      const { f, pool } = amb;
      const material = await f.material();
      const lote = await f.estoque(material, 5);
      const outro = await f.material();
      await f.estoque(outro, 5);
      const id = await amb.trabalhadorNoGhe(amb.ghes.legado);
      await f.direta([[material, lote, 1]], { funcionarioId: id });
      const alvo = await f.aprovada({ materialId: outro, quantidade: 1, funcionarioId: id });

      const retrato = async () => ({
        entregas: (await pool.query(
          'SELECT e.id, e.ghe_id, e.trabalhador_nome, e.entregue_em FROM entregas_epi e JOIN fichas_epi f ON f.id = e.ficha_id WHERE f.funcionario_id = $1 ORDER BY e.id', [id],
        )).rows,
        fichas: (await pool.query('SELECT id, numero FROM fichas_epi WHERE funcionario_id = $1 ORDER BY id', [id])).rows,
        solicitacoes: (await pool.query('SELECT id, ghe_id, status FROM solicitacoes_epi WHERE funcionario_id = $1 ORDER BY id', [id])).rows,
        auditorias: (await pool.query('SELECT id, acao, referencia, contexto, dados_anteriores, dados_novos, criado_em FROM logs_auditoria ORDER BY id')).rows,
      });
      const antes = await retrato();
      assert.equal(antes.entregas.length, 1);
      assert.equal(antes.entregas[0].ghe_id, amb.ghes.legado);
      assert.equal(antes.solicitacoes[0].ghe_id, amb.ghes.legado);

      const r = await trocar(amb.usuarios.master, id, { grupoHomogeneoId: amb.ghes.soldagem });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const depois = await retrato();
      assert.deepEqual(depois.entregas, antes.entregas, 'o GHE gravado na entrega é do momento dela');
      assert.deepEqual(depois.fichas, antes.fichas);
      assert.deepEqual(depois.solicitacoes, antes.solicitacoes, 'a solicitação guarda o GHE da época');
      assert.deepEqual(depois.auditorias.slice(0, antes.auditorias.length), antes.auditorias, 'nenhuma auditoria anterior é tocada');
      assert.ok(depois.auditorias.length > antes.auditorias.length, 'a troca só acrescenta linhas');
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
      assert.equal(alvo.id, antes.solicitacoes[0].id);
    });
  });
});
