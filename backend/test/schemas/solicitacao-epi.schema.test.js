'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Consultas HTTP da solicitação de EPI (12F-1): minhas, fila, entregáveis e
 * detalhe. Query e params estritos: empresa e usuário vêm só da sessão, nunca
 * do cliente. O filtro de trabalhador usa o nome do contrato existente,
 * `funcionarioId` (o mesmo da lista de fichas).
 */

const schema = () => exigirModulo('src/schemas/solicitacao-epi.schema');
const consultaRepo = require('../../src/repositories/solicitacao-epi-consulta.repository');

describe('solicitacao-epi.schema — paginação comum às listas', () => {
  for (const nome of ['minhas', 'fila', 'entregaveis']) {
    test(`${nome}: sem nada, página 1 e limite 20; página e limite numéricos canônicos, limite de 1 a 100`, () => {
      const q = schema()[nome].query;
      assert.deepEqual(q.safeParse({}).data, { pagina: 1, limite: 20 });
      assert.deepEqual(q.safeParse({ pagina: '3', limite: '100' }).data, { pagina: 3, limite: 100 });
      for (const bruto of [{ pagina: '0' }, { pagina: '-1' }, { pagina: '1.5' }, { pagina: 'abc' }, { pagina: '01' }, { limite: '0' }, { limite: '101' }, { limite: '1e2' }, { limite: '' }]) {
        assert.equal(q.safeParse(bruto).success, false, `${nome} ${JSON.stringify(bruto)}`);
      }
    });

    test(`${nome}: recusa campos de autoridade e desconhecidos (empresaId, usuarioId, solicitanteUsuarioId, ordem)`, () => {
      const q = schema()[nome].query;
      for (const bruto of [{ empresaId: '1' }, { usuarioId: '1' }, { solicitanteUsuarioId: '1' }, { ordem: 'id' }]) {
        assert.equal(q.safeParse(bruto).success, false, `${nome} ${JSON.stringify(bruto)}`);
      }
    });
  }
});

describe('solicitacao-epi.schema — filtros', () => {
  test('minhas: status opcional, só os sete do banco (inclusive ENCERRADA); o mesmo conjunto do repositório', () => {
    const q = schema().minhas.query;
    assert.deepEqual([...schema().STATUS], [...consultaRepo.STATUS]);
    for (const status of consultaRepo.STATUS) assert.equal(q.safeParse({ status }).data.status, status);
    for (const status of ['', 'ABERTA', 'encerrada', 'PENDENTE,APROVADA']) assert.equal(q.safeParse({ status }).success, false, status);
  });

  test('fila: só paginação; não aceita status nem trabalhador', () => {
    const q = schema().fila.query;
    assert.equal(q.safeParse({ status: 'PENDENTE' }).success, false);
    assert.equal(q.safeParse({ funcionarioId: '1' }).success, false);
  });

  test('entregáveis: funcionarioId opcional, identificador canônico positivo; não aceita status', () => {
    const q = schema().entregaveis.query;
    assert.deepEqual(q.safeParse({ funcionarioId: '42' }).data, { funcionarioId: 42, pagina: 1, limite: 20 });
    for (const funcionarioId of ['0', '-1', '1.5', 'abc', '007', '', '2147483648']) {
      assert.equal(q.safeParse({ funcionarioId }).success, false, funcionarioId);
    }
    assert.equal(q.safeParse({ status: 'APROVADA' }).success, false);
    assert.equal(q.safeParse({ trabalhadorId: '1' }).success, false, 'o contrato existente usa funcionarioId');
  });
});

describe('solicitacao-epi.schema — detalhe', () => {
  test('params: id canônico positivo; query vazia e estrita', () => {
    const { params, query } = schema().detalhe;
    assert.deepEqual(params.safeParse({ id: '17' }).data, { id: 17 });
    for (const id of ['0', '-1', '1.5', 'abc', '017', '', '2147483648', 'minhas']) assert.equal(params.safeParse({ id }).success, false, id);
    assert.equal(params.safeParse({ id: '17', empresaId: '1' }).success, false);
    assert.deepEqual(query.safeParse({}).data, {});
    for (const bruto of [{ empresaId: '1' }, { usuarioId: '1' }, { incluirCpf: 'true' }]) assert.equal(query.safeParse(bruto).success, false, JSON.stringify(bruto));
  });
});

// ── Escrita (12F-2) ─────────────────────────────────────────────────

const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');

const CHAVE = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const codigosDe = (resultado) => resultado.error.issues.map((i) => i.params?.codigo ?? i.code);
const itemValido = (extra = {}) => ({
  materialId: 7, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra,
});
const criacaoValida = (extra = {}) => ({ funcionarioId: 5, itens: [itemValido()], chaveIdempotencia: CHAVE, ...extra });
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const entregaValida = (extra = {}) => ({
  itens: [{ solicitacaoItemId: 11, loteId: 21, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: CHAVE, ...extra,
});

describe('solicitacao-epi.schema — criar (12F-2)', () => {
  test('corpo mínimo válido: trabalhador, itens e chave; a chave sai em minúsculas e nada da sessão aparece', () => {
    const r = schema().criar.body.safeParse(criacaoValida());
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data, { funcionarioId: 5, itens: [itemValido()], chaveIdempotencia: CHAVE.toLowerCase() });
  });

  test('tamanho é opcional e anulável (material sem tamanho); observação e justificativa opcionais, aparadas', () => {
    const r = schema().criar.body.safeParse(criacaoValida({
      itens: [itemValido({ tamanho: null }), itemValido({ materialId: 8, tamanho: undefined, justificativa: '  Troca antecipada  ' })],
      observacao: '  Turno da noite  ',
    }));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.data.itens[0].tamanho, null);
    assert.equal(r.data.itens[1].tamanho, undefined);
    assert.equal(r.data.itens[1].justificativa, 'Troca antecipada');
    assert.equal(r.data.observacao, 'Turno da noite');
  });

  test('de 1 a 20 itens, o mesmo limite do serviço: 20 passa; 0 e 21 são recusados', () => {
    const servico = require('../../src/services/solicitacao-epi.service');
    assert.equal(servico.LIMITE_ITENS, 20);
    const itens = (n) => Array.from({ length: n }, (_, i) => itemValido({ tamanho: String(30 + i) }));
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: itens(20) })).success, true);
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: itens(21) })).success, false);
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [] })).success, false);
  });

  test('recusa o que vem da sessão ou do servidor: empresa, solicitante, ator, status, número, GHE, origem, hash, instantes', () => {
    for (const extra of [
      { empresaId: 2 }, { solicitanteUsuarioId: 9 }, { atorId: 9 }, { status: 'APROVADA' }, { numero: 1 }, { gheId: 1 },
      { origemSolicitacao: 'USUARIO_INTERNO' }, { requisicaoHash: 'x' }, { criadaEm: '2026-10-03T00:00:00Z' }, { decididaPor: 1 },
    ]) {
      const r = schema().criar.body.safeParse(criacaoValida(extra));
      assert.equal(r.success, false, JSON.stringify(extra));
      assert.ok(codigosDe(r).includes('unrecognized_keys'), JSON.stringify(extra));
    }
  });

  test('o item não traz o que a SST ou o servidor decidem: previsão no GHE, justificativa técnica fora do GHE, decisão, empresa', () => {
    for (const extra of [
      { previstoNoGhe: true }, { justificativaForaGhe: 'Risco químico' }, { decisao: 'APROVADO' }, { quantidadeAprovada: 1 }, { justificativaDecisao: 'x' }, { empresaId: 2 },
    ]) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido(extra)] })).success, false, JSON.stringify(extra));
    }
  });

  test('quantidade inteira positiva até o teto do INTEGER; motivo só da lista do repositório; OUTRO exige justificativa', () => {
    assert.deepEqual([...schema().MOTIVOS], [...itemRepo.MOTIVOS]);
    for (const quantidade of [0, -1, 1.5, '2', 2147483648, null]) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ quantidade })] })).success, false, String(quantidade));
    }
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ quantidade: 2147483647 })] })).success, true);
    for (const motivo of itemRepo.MOTIVOS.filter((m) => m !== 'OUTRO')) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ motivo })] })).success, true, motivo);
    }
    for (const motivo of ['', 'admissao', 'FURTO']) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ motivo })] })).success, false, motivo);
    }
    const outroSem = schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ motivo: 'OUTRO' })] }));
    assert.ok(codigosDe(outroSem).includes('JUSTIFICATIVA_OBRIGATORIA'));
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ motivo: 'OUTRO', justificativa: 'Mudança de função' })] })).success, true);
  });

  test('tamanho e textos: vazio, só espaços, longo demais ou com caractere de controle são recusados', () => {
    for (const tamanho of ['', '   ', 'x'.repeat(21), 'G\u0007']) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ tamanho })] })).success, false, JSON.stringify(tamanho));
    }
    for (const observacao of ['', '   ', 'x'.repeat(501), 'linha\u0000']) {
      assert.equal(schema().criar.body.safeParse(criacaoValida({ observacao })).success, false, JSON.stringify(observacao).slice(0, 20));
    }
    assert.equal(schema().criar.body.safeParse(criacaoValida({ observacao: 'x'.repeat(500) })).success, true);
  });

  test('identificadores e chave: trabalhador e material inteiros positivos; a chave é obrigatória e precisa ser um UUID', () => {
    for (const funcionarioId of [0, -1, 1.5, '5', null]) assert.equal(schema().criar.body.safeParse(criacaoValida({ funcionarioId })).success, false, String(funcionarioId));
    assert.equal(schema().criar.body.safeParse(criacaoValida({ itens: [itemValido({ materialId: '7' })] })).success, false);
    const { chaveIdempotencia, ...semChave } = criacaoValida();
    assert.equal(schema().criar.body.safeParse(semChave).success, false);
    for (const chave of ['', 'abc', '3F2504E0-4F89-41D3-9A0C-0305E82C33']) assert.equal(schema().criar.body.safeParse(criacaoValida({ chaveIdempotencia: chave })).success, false, chave);
  });
});

describe('solicitacao-epi.schema — cancelar (12F-2)', () => {
  test('params: o mesmo id do detalhe; corpo vazio ou só com a justificativa opcional, aparada', () => {
    const { params, body } = schema().cancelar;
    assert.deepEqual(params.safeParse({ id: '17' }).data, { id: 17 });
    assert.equal(params.safeParse({ id: '017' }).success, false);
    assert.deepEqual(body.safeParse({}).data, {});
    assert.deepEqual(body.safeParse({ justificativa: '  Pedido em duplicidade ' }).data, { justificativa: 'Pedido em duplicidade' });
    assert.deepEqual(body.safeParse({ justificativa: null }).data, { justificativa: null });
    for (const justificativa of ['', '   ', 'x'.repeat(501), 'a\u0001']) assert.equal(body.safeParse({ justificativa }).success, false, JSON.stringify(justificativa).slice(0, 20));
  });

  test('recusa quem cancela, empresa, status e instantes vindos do cliente', () => {
    for (const extra of [{ canceladaPor: 1 }, { empresaId: 2 }, { atorId: 3 }, { status: 'CANCELADA' }, { canceladaEm: '2026-10-03' }, { solicitanteUsuarioId: 1 }]) {
      assert.equal(schema().cancelar.body.safeParse(extra).success, false, JSON.stringify(extra));
    }
  });
});

describe('solicitacao-epi.schema — decidir (12F-2)', () => {
  const decisao = (extra = {}) => ({ itemId: 11, decisao: 'APROVADO', ...extra });

  test('decisões de 1 a 20 itens: aprovar (quantidade opcional), reprovar (justificativa) e a mistura', () => {
    const { params, body } = schema().decidir;
    assert.deepEqual(params.safeParse({ id: '17' }).data, { id: 17 });
    assert.deepEqual([...schema().DECISOES], [...itemRepo.DECISOES]);
    const r = body.safeParse({
      decisoes: [decisao(), decisao({ itemId: 12, quantidadeAprovada: 1, justificativa: ' Estoque restrito ' }), decisao({ itemId: 13, decisao: 'REPROVADO', justificativa: 'Sem necessidade', quantidadeAprovada: 0 })],
    });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.data.decisoes[1].justificativa, 'Estoque restrito');
    assert.equal(body.safeParse({ decisoes: [] }).success, false);
    assert.equal(body.safeParse({ decisoes: Array.from({ length: 21 }, (_, i) => decisao({ itemId: i + 1 })) }).success, false);
    assert.equal(body.safeParse({ decisoes: Array.from({ length: 20 }, (_, i) => decisao({ itemId: i + 1 })) }).success, true);
  });

  test('decisão só APROVADO ou REPROVADO; quantidade inteira de 0 ao teto; item inteiro positivo', () => {
    const { body } = schema().decidir;
    for (const extra of [{ decisao: 'aprovado' }, { decisao: 'PARCIAL' }, { quantidadeAprovada: -1 }, { quantidadeAprovada: 1.5 }, { quantidadeAprovada: 2147483648 }, { itemId: 0 }, { itemId: '11' }]) {
      assert.equal(body.safeParse({ decisoes: [decisao(extra)] }).success, false, JSON.stringify(extra));
    }
  });

  test('recusa decisor, resultado, empresa e instantes vindos do cliente, no corpo e no item', () => {
    const { body } = schema().decidir;
    for (const extra of [{ decididaPor: 1 }, { status: 'APROVADA' }, { empresaId: 2 }, { atorId: 1 }, { decididaEm: '2026-10-03' }]) {
      assert.equal(body.safeParse({ decisoes: [decisao()], ...extra }).success, false, JSON.stringify(extra));
    }
    for (const extra of [{ previstoNoGhe: true }, { materialId: 7 }, { empresaId: 2 }]) {
      assert.equal(body.safeParse({ decisoes: [decisao(extra)] }).success, false, JSON.stringify(extra));
    }
  });
});

describe('solicitacao-epi.schema — encerrar (12F-2)', () => {
  test('justificativa obrigatória, aparada, de 1 a 500 caracteres, sem caractere de controle', () => {
    const { params, body } = schema().encerrar;
    assert.deepEqual(params.safeParse({ id: '17' }).data, { id: 17 });
    assert.deepEqual(body.safeParse({ justificativa: '  Trabalhador desligado  ' }).data, { justificativa: 'Trabalhador desligado' });
    assert.equal(body.safeParse({ justificativa: 'x'.repeat(500) }).success, true);
    for (const corpo of [{}, { justificativa: null }, { justificativa: 'x'.repeat(501) }, { justificativa: 'a\u0000b' }, { justificativa: 7 }]) {
      assert.equal(body.safeParse(corpo).success, false, JSON.stringify(corpo).slice(0, 30));
    }
  });

  test('só espaços (inclusive os de Unicode) não é justificativa: JUSTIFICATIVA_OBRIGATORIA, o mesmo código do serviço', () => {
    for (const justificativa of ['', '   ', '   ']) {
      const r = schema().encerrar.body.safeParse({ justificativa });
      assert.equal(r.success, false, JSON.stringify(justificativa));
      assert.ok(codigosDe(r).includes('JUSTIFICATIVA_OBRIGATORIA'), JSON.stringify(codigosDe(r)));
    }
  });

  test('recusa encerrador, instante, status e empresa vindos do cliente', () => {
    for (const extra of [{ encerradaPor: 1 }, { encerradaEm: '2026-10-03' }, { status: 'ENCERRADA' }, { empresaId: 2 }, { atorId: 1 }]) {
      assert.equal(schema().encerrar.body.safeParse({ justificativa: 'Desligado', ...extra }).success, false, JSON.stringify(extra));
    }
  });
});

describe('solicitacao-epi.schema — entregar (12F-2)', () => {
  test('itens (item da solicitação, lote e quantidade), confirmação e chave; de 1 a 20 itens, o limite do serviço', () => {
    const { params, body } = schema().entregar;
    assert.deepEqual(params.safeParse({ id: '17' }).data, { id: 17 });
    const r = body.safeParse(entregaValida());
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.data.chaveIdempotencia, CHAVE.toLowerCase());
    const entregaSvc = require('../../src/services/entrega-solicitacao.service');
    const itens = (n) => Array.from({ length: n }, (_, i) => ({ solicitacaoItemId: 11, loteId: i + 1, quantidade: 1 }));
    assert.equal(entregaSvc.LIMITE_ITENS, 20);
    assert.equal(body.safeParse(entregaValida({ itens: itens(20) })).success, true);
    assert.equal(body.safeParse(entregaValida({ itens: itens(21) })).success, false);
    assert.equal(body.safeParse(entregaValida({ itens: [] })).success, false);
  });

  test('o item não traz o que o servidor deriva da solicitação (material, tamanho, motivo, justificativas, GHE)', () => {
    const { body } = schema().entregar;
    for (const extra of [{ materialId: 7 }, { tamanho: '40' }, { motivo: 'ADMISSAO' }, { justificativa: 'x' }, { justificativaForaGhe: 'x' }, { previstoNoGhe: true }]) {
      assert.equal(body.safeParse(entregaValida({ itens: [{ solicitacaoItemId: 11, loteId: 21, quantidade: 1, ...extra }] })).success, false, JSON.stringify(extra));
    }
  });

  test('o corpo não traz trabalhador, solicitação, empresa nem responsável; lote repetido e quantidade inválida são recusados', () => {
    const { body } = schema().entregar;
    for (const extra of [{ funcionarioId: 1 }, { solicitacaoId: 17 }, { empresaId: 2 }, { responsavelId: 1 }]) {
      assert.equal(body.safeParse(entregaValida(extra)).success, false, JSON.stringify(extra));
    }
    const repetido = body.safeParse(entregaValida({ itens: [{ solicitacaoItemId: 11, loteId: 21, quantidade: 1 }, { solicitacaoItemId: 12, loteId: 21, quantidade: 1 }] }));
    assert.ok(codigosDe(repetido).includes('LOTE_REPETIDO'));
    for (const quantidade of [0, -1, 1.5, '1']) {
      assert.equal(body.safeParse(entregaValida({ itens: [{ solicitacaoItemId: 11, loteId: 21, quantidade }] })).success, false, String(quantidade));
    }
  });

  test('a confirmação é a mesma da entrega direta: modo da lista, traços só no desenho, declaração obrigatória', () => {
    const { body } = schema().entregar;
    for (const confirmacao of [{ ...ACEITE, modo: 'X' }, { ...ACEITE, tracos: [[[0, 0]]] }, { modo: 'ACEITE_PRESENCIAL' }, { ...ACEITE, hashConteudo: 'x' }]) {
      assert.equal(body.safeParse(entregaValida({ confirmacao })).success, false, JSON.stringify(confirmacao).slice(0, 40));
    }
    assert.equal(body.safeParse(entregaValida({ confirmacao: undefined })).success, false);
  });
});

// ── 12G-0 ───────────────────────────────────────────────────────────

describe('solicitacao-epi.schema — contexto da nova solicitação (12G-0)', () => {
  test('trabalhadores: busca opcional aparada (até 100), paginação; nada de CPF, empresa ou campo desconhecido', () => {
    const q = schema().contextoFuncionarios.query;
    assert.deepEqual(q.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.deepEqual(q.safeParse({ busca: '  Silva ', pagina: '2', limite: '50' }).data, { busca: 'Silva', pagina: 2, limite: 50 });
    assert.equal(q.safeParse({ busca: 'x'.repeat(100) }).success, true);
    for (const bruto of [{ busca: '' }, { busca: '   ' }, { busca: 'x'.repeat(101) }, { busca: 'a\u0000' }, { limite: '101' }, { pagina: '0' },
      { cpf: '12345678909' }, { empresaId: '2' }, { ativo: 'false' }, { funcionarioId: '1' }]) {
      assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });

  test('materiais: o trabalhador no caminho; busca, previsto no GHE (true/false) e paginação opcionais; nada além', () => {
    const { params, query } = schema().contextoMateriais;
    assert.deepEqual(params.safeParse({ funcionarioId: '7' }).data, { funcionarioId: 7 });
    for (const funcionarioId of ['0', '-1', '07', 'abc', '2147483648']) assert.equal(params.safeParse({ funcionarioId }).success, false, funcionarioId);
    assert.equal(params.safeParse({ funcionarioId: '7', empresaId: '2' }).success, false);
    assert.deepEqual(query.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.deepEqual(query.safeParse({ busca: ' Luva ', previstoNoGhe: 'true' }).data, { busca: 'Luva', previstoNoGhe: true, pagina: 1, limite: 20 });
    assert.equal(query.safeParse({ previstoNoGhe: 'false' }).data.previstoNoGhe, false);
    for (const bruto of [{ previstoNoGhe: 'sim' }, { previstoNoGhe: '1' }, { busca: '' }, { saldo: '1' }, { comEstoque: 'true' }, { empresaId: '2' }, { limite: '0' }]) {
      assert.equal(query.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });
});

describe('solicitacao-epi.schema — encerráveis (12G-0)', () => {
  test('trabalhador opcional e paginação; sem status, situação, empresa nem campo desconhecido', () => {
    const q = schema().encerraveis.query;
    assert.deepEqual(q.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.deepEqual(q.safeParse({ funcionarioId: '42', pagina: '3', limite: '10' }).data, { funcionarioId: 42, pagina: 3, limite: 10 });
    for (const bruto of [{ funcionarioId: '0' }, { funcionarioId: 'abc' }, { status: 'APROVADA' }, { situacao: 'SUSPENSA' }, { empresaId: '2' }, { limite: '101' }]) {
      assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });
});
