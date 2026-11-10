'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../../src/services/backup-privilegios-b1.service');

const PAPEL = 'safework_backup_executor';
const DONO = 'dono_das_tabelas';

/** Executor falso que responde por IGUALDADE do SQL (as consultas são as constantes do módulo) e guarda toda chamada. */
function criarFalso(inicial = {}) {
  const e = {
    usuario: PAPEL, sessao: PAPEL, banco: 'gestao_epi_sintetico', papelExiste: true, limite: 5, total: 75, pendentes: [], esquemas: [], usage: true, connect: true,
    donos: [{ dono: DONO, n: 75 }], falharEm: null, commitResolve: true, ...inicial,
  };
  const chamadas = [];
  const gravacoes = [];
  const rows = (sql) => {
    switch (sql) {
      case S.CONSULTAS.IDENTIDADE: return [{ usuario: e.usuario, sessao: e.sessao, banco: e.banco }];
      case S.CONSULTAS.PAPEL: return e.papelExiste ? [{ limite: e.limite }] : [];
      case S.CONSULTAS.TOTAL: return [{ n: e.total }];
      case S.CONSULTAS.PENDENTES: return e.pendentes.map((nome) => ({ nome, tipo: 'r', total: e.pendentes.length }));
      case S.CONSULTAS.ESQUEMAS: return e.esquemas.map((nome) => ({ nome }));
      case S.CONSULTAS.ACESSO: return [{ usage_public: e.usage, connect: e.connect }];
      case S.CONSULTAS.PROPRIETARIOS: return e.donos.map((d) => ({ dono: d.dono, n: d.n }));
      default: return null;
    }
  };
  return {
    estado: e, chamadas, gravacoes,
    async query(sql, parametros) {
      chamadas.push(sql);
      if (e.falharEm !== null && (typeof e.falharEm === 'string' ? sql.startsWith(e.falharEm) : e.falharEm(sql))) throw new Error('falha simulada');
      const linhas = rows(sql);
      if (linhas !== null) {
        if (parametros !== undefined) assert.deepEqual(parametros, [PAPEL]);
        return { rows: linhas };
      }
      if (sql === 'COMMIT' && e.commitResolve) e.pendentes = [];
      return { rows: [] };
    },
  };
}
const leituras = (f) => f.chamadas.filter((s) => /^\s*SELECT\b/i.test(s));
function criarAuditoriaFalsa({ falhar = false } = {}) {
  const eventos = [];
  const executor = criarFalso();
  const registrarEventoSistema = async (ex, dados) => { if (falhar) throw new Error('falha simulada'); assert.equal(ex, executor); eventos.push(dados); return { id: eventos.length }; };
  const auditoria = S.criarRegistradorDeAuditoria({ executorDeAuditoria: executor, registrarEventoSistema, gerarId: () => 'a'.repeat(32) });
  return { auditoria, eventos };
}

describe('[PRIV-B1] SQL de concessão e consultas (texto fixo, o do ensaio de 09/11/2026)', () => {
  test('os três GRANT são exatamente os do B-1, só para o papel informado, e o identificador é validado', () => {
    assert.deepEqual([...S.sqlDeConcessao()], [
      'GRANT USAGE ON SCHEMA public TO safework_backup_executor',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO safework_backup_executor',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO safework_backup_executor',
    ]);
    assert.ok(Object.isFrozen(S.sqlDeConcessao()));
    for (const ruim of ['x; DROP TABLE a', 'Papel', '', 'a b', '1abc', 'a'.repeat(64), 'pg_read_all_data --']) assert.throws(() => S.sqlDeConcessao(ruim), (e) => e.code === 'PRIVILEGIOS_B1_PAPEL_INVALIDO', ruim);
  });

  test('toda consulta de leitura é um SELECT único, sem ponto e vírgula interno, e nenhuma concede, altera ou escreve', () => {
    for (const [nome, sql] of Object.entries(S.CONSULTAS)) {
      assert.match(sql, /^\s*SELECT\b[^;]*$/i, nome);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|TRUNCATE)\b/i, nome);
    }
    assert.match(S.CONSULTAS.PENDENTES, /has_table_privilege\(\$1::name, c\.oid, 'SELECT'\)/);
    assert.match(S.CONSULTAS.PENDENTES, /relkind IN \('r', 'p', 'm', 'S', 'v', 'f'\)/);
  });
});

describe('[PRIV-B1] verificador fail-closed', () => {
  const verificar = (falso, extra = {}) => S.criarVerificadorDePrivilegios({ executorDeBanco: falso, papel: PAPEL, ...extra }).verificar();

  test('POSITIVO: papel íntegro, 75 relações, nada pendente: ok, sem motivo, com identidade e só leituras', async () => {
    const f = criarFalso();
    const r = await verificar(f);
    assert.equal(r.ok, true);
    assert.deepEqual([...r.motivos], []);
    assert.deepEqual({ ...r.identidade }, { usuario: PAPEL, sessao: PAPEL });
    assert.equal(r.totalRelacoes, 75);
    assert.equal(r.pendentes.total, 0);
    assert.deepEqual(leituras(f), f.chamadas, 'só SELECT foi enviado');
  });

  test('NEGATIVO: tabela nova sem concessão bloqueia e identifica o objeto', async () => {
    const r = await verificar(criarFalso({ pendentes: ['tabela_nova'] }));
    assert.equal(r.ok, false);
    assert.deepEqual([...r.motivos], ['OBJETOS_SEM_CONCESSAO']);
    assert.deepEqual(r.pendentes.itens.map((p) => p.nome), ['tabela_nova']);
    assert.equal(r.pendentes.total, 1);
  });

  test('NEGATIVO: muitas pendências são listadas até o limite e o total real é preservado (truncado)', async () => {
    const nomes = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const f = criarFalso({ pendentes: nomes });
    const antes = f.query.bind(f);
    f.query = async (sql, p) => { const r = await antes(sql, p); return sql === S.CONSULTAS.PENDENTES ? { rows: r.rows.map((l) => ({ ...l, total: 80 })) } : r; };
    const r = await verificar(f);
    assert.equal(r.pendentes.itens.length, 50);
    assert.equal(r.pendentes.total, 80);
    assert.equal(r.pendentes.truncado, true);
  });

  test('NEGATIVO: esquema fora de public, sem USAGE em public, sem CONNECT e public vazio bloqueiam, cada um com seu motivo', async () => {
    assert.deepEqual([...(await verificar(criarFalso({ esquemas: ['relatorios'] }))).motivos], ['ESQUEMA_NAO_COBERTO']);
    assert.deepEqual([...(await verificar(criarFalso({ usage: false }))).motivos], ['SEM_USAGE_EM_PUBLIC']);
    assert.deepEqual([...(await verificar(criarFalso({ connect: false }))).motivos], ['SEM_CONNECT_NO_BANCO']);
    assert.deepEqual([...(await verificar(criarFalso({ total: 0 }))).motivos], ['SEM_OBJETOS_EM_PUBLIC']);
    const varios = await verificar(criarFalso({ pendentes: ['a'], esquemas: ['x'], usage: false }));
    assert.deepEqual([...varios.motivos], ['OBJETOS_SEM_CONCESSAO', 'ESQUEMA_NAO_COBERTO', 'SEM_USAGE_EM_PUBLIC']);
  });

  test('NEGATIVO: sessão que não é o papel (ou papel inexistente) bloqueia; sem exigir identidade (aplicador) a identidade não bloqueia', async () => {
    assert.deepEqual([...(await verificar(criarFalso({ usuario: 'swb_teste', sessao: 'swb_teste' }))).motivos], ['IDENTIDADE_DIFERENTE_DO_PAPEL']);
    assert.deepEqual([...(await verificar(criarFalso({ sessao: 'outro' }))).motivos], ['IDENTIDADE_DIFERENTE_DO_PAPEL']);
    const inexistente = await verificar(criarFalso({ papelExiste: false }));
    assert.equal(inexistente.ok, false);
    assert.ok(inexistente.motivos.includes('PAPEL_INEXISTENTE'));
    const comoDono = await verificar(criarFalso({ usuario: DONO, sessao: DONO }), { exigirIdentidade: false });
    assert.equal(comoDono.ok, true);
  });

  test('NEGATIVO: erro de consulta, resposta fora da forma, total inconsistente ou SQL escrito nunca resultam em ok (VERIFICACAO_FALHOU)', async () => {
    for (const falharEm of [(sql) => sql === S.CONSULTAS.IDENTIDADE, (sql) => sql === S.CONSULTAS.PENDENTES, (sql) => sql === S.CONSULTAS.ACESSO, (sql) => sql === S.CONSULTAS.ESQUEMAS]) {
      const r = await verificar(criarFalso({ falharEm }));
      assert.equal(r.ok, false);
      assert.deepEqual([...r.motivos], ['VERIFICACAO_FALHOU']);
    }
    const malformado = criarFalso();
    malformado.query = async (sql) => (sql === S.CONSULTAS.ACESSO ? { rows: [{ usage_public: 'sim', connect: true }] } : criarFalso().query(sql));
    assert.deepEqual([...(await verificar(malformado)).motivos], ['VERIFICACAO_FALHOU']);
    const semRows = { query: async () => ({}) };
    assert.deepEqual([...(await verificar(semRows)).motivos], ['VERIFICACAO_FALHOU']);
    assert.deepEqual([...(await verificar({ query: async () => { throw new Error('x'); } })).motivos], ['VERIFICACAO_FALHOU']);
  });

  test('AVISO (não bloqueia): CONNECTION LIMIT abaixo da referência 5 do ensaio; ilimitado (-1) e 5 não avisam', async () => {
    const dois = await verificar(criarFalso({ limite: 2 }));
    assert.equal(dois.ok, true);
    assert.deepEqual([...dois.avisos], ['CONNECTION_LIMIT_2_ABAIXO_DA_REFERENCIA_5']);
    assert.deepEqual([...(await verificar(criarFalso({ limite: 5 }))).avisos], []);
    assert.deepEqual([...(await verificar(criarFalso({ limite: -1 }))).avisos], []);
    assert.equal(S.CONNECTION_LIMIT_REFERENCIA, 5);
  });

  test('configuração inválida é recusada na construção', () => {
    assert.throws(() => S.criarVerificadorDePrivilegios({ executorDeBanco: {}, papel: PAPEL }), (e) => e.code === 'PRIVILEGIOS_B1_EXECUTOR_INVALIDO');
    assert.throws(() => S.criarVerificadorDePrivilegios({ executorDeBanco: criarFalso(), papel: 'a;b' }), (e) => e.code === 'PRIVILEGIOS_B1_PAPEL_INVALIDO');
    assert.throws(() => S.criarVerificadorDePrivilegios({ executorDeBanco: criarFalso(), extra: 1 }), (e) => e.code === 'PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  });
});

describe('[PRIV-B1] auditoria do resultado', () => {
  test('um evento SISTEMA por resultado, com papel, identidade executora, pendências e motivos; nenhuma chave sensível', async () => {
    const { auditoria, eventos } = criarAuditoriaFalsa();
    const r = await S.criarVerificadorDePrivilegios({ executorDeBanco: criarFalso({ pendentes: ['t1', 't2'] }), papel: PAPEL }).verificar();
    const g = await auditoria.registrar({ tipo: 'VERIFICACAO', resultado: r });
    assert.equal(g.gravado, true);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].acao, S.ACOES.VERIFICACAO_BLOQUEADA);
    assert.equal(eventos[0].referencia, 'a'.repeat(32));
    assert.ok(eventos[0].acao.length <= 60);
    assert.deepEqual({ ...eventos[0].contexto, avisos: undefined }, {
      papel: PAPEL, banco: 'gestao_epi_sintetico', ok: false, motivos: ['OBJETOS_SEM_CONCESSAO'], usuario: PAPEL, sessao: PAPEL, pendentesTotal: 2, pendentes: ['t1', 't2'], esquemasNaoCobertos: [], avisos: undefined,
    });
    assert.doesNotMatch(JSON.stringify(eventos[0]), /senha|password|token|segredo/i);
  });

  test('resultado ok vira VERIFICACAO_OK; falha ao gravar nunca lança e devolve código fixo', async () => {
    const ok = await S.criarVerificadorDePrivilegios({ executorDeBanco: criarFalso(), papel: PAPEL }).verificar();
    const { auditoria, eventos } = criarAuditoriaFalsa();
    await auditoria.registrar({ tipo: 'VERIFICACAO', resultado: ok });
    assert.equal(eventos[0].acao, S.ACOES.VERIFICACAO_OK);
    const quebrada = criarAuditoriaFalsa({ falhar: true });
    assert.deepEqual({ ...(await quebrada.auditoria.registrar({ tipo: 'VERIFICACAO', resultado: ok })) }, { gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' });
  });
});

describe('[PRIV-B1] pré-verificação antes da coordenação (nenhuma trava, nenhuma operação)', () => {
  function montar(inicial = {}, opcoesAuditoria = {}) {
    const sessao = criarFalso(inicial);
    const chamadasDaCoordenacao = [];
    const coordenacao = { adquirir: async (pedido) => { chamadasDaCoordenacao.push(pedido); return { ok: true, operacao: pedido.operacao, async liberar() { return { liberados: 1 }; } }; } };
    const aud = criarAuditoriaFalsa(opcoesAuditoria);
    const pre = S.criarPreVerificacaoDaCoordenacao({ coordenacao, verificador: S.criarVerificadorDePrivilegios({ executorDeBanco: sessao, papel: PAPEL }), auditoria: aud.auditoria });
    return { sessao, coordenacao, chamadasDaCoordenacao, pre, ...aud };
  }

  test('POSITIVO: sem pendência, registra o resultado e repassa a aquisição da trava', async () => {
    const m = montar();
    const t = await m.pre.adquirir({ operacao: 'BACKUP' });
    assert.equal(t.ok, true);
    assert.deepEqual(m.chamadasDaCoordenacao, [{ operacao: 'BACKUP' }]);
    assert.equal(m.eventos.length, 1);
    assert.equal(m.eventos[0].acao, S.ACOES.VERIFICACAO_OK);
  });

  test('NEGATIVO: com objeto sem concessão devolve ok:false, NÃO chama a coordenação (nenhuma trava tomada), só lê e audita o bloqueio', async () => {
    const m = montar({ pendentes: ['tabela_nova'] });
    const t = await m.pre.adquirir({ operacao: 'BACKUP' });
    assert.deepEqual({ ...t }, { ok: false, motivo: 'PRIVILEGIOS_B1_PENDENTES', operacao: 'BACKUP' });
    assert.equal(m.chamadasDaCoordenacao.length, 0, 'a coordenação nem foi consultada');
    assert.equal(leituras(m.sessao).length, m.sessao.chamadas.length, 'nenhum comando que não seja SELECT');
    assert.ok(!m.sessao.chamadas.some((s) => /advisory/i.test(s)));
    assert.equal(m.eventos[0].acao, S.ACOES.VERIFICACAO_BLOQUEADA);
  });

  test('NEGATIVO: verificação que falha ou lança bloqueia (fail-closed) e a falha da auditoria não muda o bloqueio', async () => {
    const m = montar({ falharEm: (sql) => sql === S.CONSULTAS.PENDENTES }, { falhar: true });
    assert.equal((await m.pre.adquirir({ operacao: 'BACKUP' })).ok, false);
    assert.equal(m.chamadasDaCoordenacao.length, 0);
    const lanca = S.criarPreVerificacaoDaCoordenacao({ coordenacao: { adquirir: async () => { throw new Error('não deveria'); } }, verificador: { verificar: async () => { throw new Error('x'); } }, auditoria: criarAuditoriaFalsa().auditoria });
    assert.deepEqual({ ...(await lanca.adquirir({ operacao: 'BACKUP' })) }, { ok: false, motivo: 'PRIVILEGIOS_B1_NAO_VERIFICADOS', operacao: 'BACKUP' });
  });

  test('RESTAURACAO não é verificada (não lê a origem) e passa direto', async () => {
    const m = montar({ pendentes: ['x'] });
    assert.equal((await m.pre.adquirir({ operacao: 'RESTAURACAO' })).ok, true);
    assert.deepEqual(m.chamadasDaCoordenacao, [{ operacao: 'RESTAURACAO' }]);
    assert.equal(m.sessao.chamadas.length, 0);
  });
});

describe('[PRIV-B1] aplicador das concessões (identidade proprietária)', () => {
  function montar(inicial = {}, opcoesAuditoria = {}) {
    const f = criarFalso({ usuario: DONO, sessao: DONO, pendentes: ['a', 'b'], ...inicial });
    const aud = criarAuditoriaFalsa(opcoesAuditoria);
    const aplicador = S.criarAplicadorDeConcessoes({ executorDeBanco: f, papel: PAPEL, auditoria: aud.auditoria });
    return { f, aplicador, ...aud };
  }
  const escritas = (f) => f.chamadas.filter((s) => !/^\s*SELECT\b/i.test(s));

  test('POSITIVO: o proprietário único aplica BEGIN, três GRANT na ordem e COMMIT; a pós-verificação fica ok e o evento registra o executor', async () => {
    const m = montar();
    const r = await m.aplicador.aplicar();
    assert.equal(r.ok, true);
    assert.equal(r.aplicado, true);
    assert.equal(r.executor, DONO);
    assert.equal(r.proprietario, DONO);
    assert.deepEqual(escritas(m.f), ['BEGIN', ...S.sqlDeConcessao(PAPEL), 'COMMIT']);
    assert.equal(r.verificacao.pendentes.total, 0);
    assert.equal(m.eventos.length, 1);
    assert.equal(m.eventos[0].acao, S.ACOES.CONCESSAO_APLICADA);
    assert.equal(m.eventos[0].contexto.executorDaConcessao, DONO);
  });

  test('IDEMPOTENTE: repetir com tudo já concedido aplica de novo sem erro', async () => {
    const m = montar({ pendentes: [] });
    const r = await m.aplicador.aplicar();
    assert.equal(r.ok, true);
    assert.deepEqual(escritas(m.f), ['BEGIN', ...S.sqlDeConcessao(PAPEL), 'COMMIT']);
  });

  test('NEGATIVO: o próprio papel de backup nunca concede a si mesmo (nenhuma escrita), com auditoria da recusa', async () => {
    const m = montar({ usuario: PAPEL, sessao: PAPEL, donos: [{ dono: PAPEL, n: 75 }] });
    const r = await m.aplicador.aplicar();
    assert.equal(r.ok, false);
    assert.equal(r.aplicado, false);
    assert.equal(r.motivo, 'EXECUTOR_E_O_PAPEL_DE_BACKUP');
    assert.deepEqual(escritas(m.f), []);
    assert.equal(m.eventos[0].acao, S.ACOES.CONCESSAO_FALHOU);
  });

  test('NEGATIVO: sessão que não é o proprietário, proprietário ambíguo e public sem objetos são recusados sem nenhuma escrita', async () => {
    const naoDono = montar({ usuario: 'outro', sessao: 'outro' });
    assert.equal((await naoDono.aplicador.aplicar()).motivo, 'EXECUTOR_NAO_E_O_PROPRIETARIO');
    assert.deepEqual(escritas(naoDono.f), []);
    const ambiguo = montar({ donos: [{ dono: DONO, n: 70 }, { dono: 'outro_dono', n: 5 }] });
    const r = await ambiguo.aplicador.aplicar();
    assert.equal(r.motivo, 'PROPRIETARIO_AMBIGUO');
    assert.deepEqual(r.donos, [DONO, 'outro_dono']);
    assert.deepEqual(escritas(ambiguo.f), []);
    const vazio = montar({ donos: [], total: 0 });
    assert.equal((await vazio.aplicador.aplicar()).motivo, 'SEM_OBJETOS_EM_PUBLIC');
    assert.deepEqual(escritas(vazio.f), []);
    const sessaoDiferente = montar({ sessao: 'outro' });
    assert.equal((await sessaoDiferente.aplicador.aplicar()).motivo, 'EXECUTOR_NAO_E_O_PROPRIETARIO');
  });

  test('NEGATIVO: o papel de backup inexistente NÃO é criado: recusa sem escrita', async () => {
    const m = montar({ papelExiste: false });
    const r = await m.aplicador.aplicar();
    assert.equal(r.motivo, 'PAPEL_INEXISTENTE');
    assert.deepEqual(escritas(m.f), []);
  });

  test('NEGATIVO: falha em um GRANT faz ROLLBACK, nunca COMMIT, e é auditada como falha', async () => {
    const m = montar({ falharEm: 'GRANT SELECT ON ALL TABLES' });
    const r = await m.aplicador.aplicar();
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'CONCESSAO_FALHOU');
    assert.deepEqual(escritas(m.f), ['BEGIN', 'GRANT USAGE ON SCHEMA public TO safework_backup_executor', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO safework_backup_executor', 'ROLLBACK']);
    assert.equal(m.eventos[0].acao, S.ACOES.CONCESSAO_FALHOU);
  });

  test('NEGATIVO: concessão aplicada mas pendência persistente (ex.: esquema fora de public) fica ok:false com POS_VERIFICACAO_FALHOU', async () => {
    const m = montar({ esquemas: ['relatorios'] });
    const r = await m.aplicador.aplicar();
    assert.equal(r.aplicado, true);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'POS_VERIFICACAO_FALHOU');
    assert.ok(r.verificacao.motivos.includes('ESQUEMA_NAO_COBERTO'));
  });

  test('o aplicador só envia SQL de escrita do conjunto fixo: papel malicioso nem chega a ser construído', () => {
    assert.throws(() => S.criarAplicadorDeConcessoes({ executorDeBanco: criarFalso(), papel: 'x; DROP ROLE y', auditoria: criarAuditoriaFalsa().auditoria }), (e) => e.code === 'PRIVILEGIOS_B1_PAPEL_INVALIDO');
  });

  test('identificarProprietarios lista os donos reais e a identidade, somente leitura', async () => {
    const m = montar({ donos: [{ dono: DONO, n: 75 }] });
    const p = await m.aplicador.identificarProprietarios();
    assert.deepEqual({ executor: p.executor, sessao: p.sessao, donos: p.donos.map((d) => ({ ...d })) }, { executor: DONO, sessao: DONO, donos: [{ dono: DONO, relacoes: 75 }] });
    assert.deepEqual(escritas(m.f), []);
  });
});
