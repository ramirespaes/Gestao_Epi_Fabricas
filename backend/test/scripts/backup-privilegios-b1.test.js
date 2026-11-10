'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { executar, SAIDAS, CONFIRMACAO } = require('../../scripts/backup-privilegios-b1');
const S = require('../../src/services/backup-privilegios-b1.service');
const { criarCoordenacaoDoExecutor } = require('../../src/services/backup-executor-compositor.service');

const PAPEL = 'safework_backup_executor';
const DONO = 'dono_das_tabelas';
const ENV_BACKUP = Object.freeze({ BACKUP_PG_HOST: '/tmp/socket', BACKUP_PG_PORTA: '55471', BACKUP_PG_USUARIO: PAPEL, BACKUP_PG_BANCO: 'banco_sintetico' });
const ENV_DONO = Object.freeze({ DB_HOST: '/tmp/socket', DB_PORT: '55471', DB_USER: DONO, DB_NAME: 'banco_sintetico', DB_PASSWORD: 'ficticia-nao-vaza' });

/** Cliente falso que responde às consultas do módulo e guarda tudo que recebe (inclusive INSERT da auditoria). */
function clienteFalso({ usuario, pendentes = [], donos = [{ dono: DONO, n: 75 }] }) {
  const estado = { pendentes: [...pendentes] };
  const c = { chamadas: [], encerrado: false, conectado: false, on() {} };
  c.connect = async () => { c.conectado = true; };
  c.end = async () => { c.encerrado = true; };
  c.query = async (sql) => {
    c.chamadas.push(sql);
    switch (sql) {
      case S.CONSULTAS.IDENTIDADE: return { rows: [{ usuario, sessao: usuario, banco: 'banco_sintetico' }] };
      case S.CONSULTAS.PAPEL: return { rows: [{ limite: 5 }] };
      case S.CONSULTAS.TOTAL: return { rows: [{ n: 75 }] };
      case S.CONSULTAS.PENDENTES: return { rows: estado.pendentes.map((nome) => ({ nome, tipo: 'r', total: estado.pendentes.length })) };
      case S.CONSULTAS.ESQUEMAS: return { rows: [] };
      case S.CONSULTAS.ACESSO: return { rows: [{ usage_public: true, connect: true }] };
      case S.CONSULTAS.PROPRIETARIOS: return { rows: donos.map((d) => ({ dono: d.dono, n: d.n })) };
      case 'COMMIT': estado.pendentes = []; return { rows: [] };
      default: return /^INSERT INTO logs_auditoria_plataforma/.test(sql) ? { rows: [{ id: 1, criado_em: new Date() }] } : { rows: [] };
    }
  };
  return c;
}
async function rodar(argv, env, cliente) {
  const saidas = [];
  const configs = [];
  const codigo = await executar(argv, env, { criarCliente: (cfg) => { configs.push(cfg); return cliente; }, saida: (t) => saidas.push(t) });
  const texto = saidas.join('');
  const linha = texto.trim().startsWith('{') ? JSON.parse(texto.trim().split('\n').pop()) : null;
  return { codigo, texto, linha, configs };
}
const auditorias = (c) => c.chamadas.filter((s) => /^INSERT INTO logs_auditoria_plataforma/.test(s));

describe('[PRIV-B1-CLI] --verificar (como o papel de backup)', () => {
  test('POSITIVO: ok, exit 0, conecta com o usuário do papel, grava uma auditoria e só lê', async () => {
    const c = clienteFalso({ usuario: PAPEL });
    const r = await rodar(['--verificar'], ENV_BACKUP, c);
    assert.equal(r.codigo, SAIDAS.OK);
    assert.equal(r.linha.ok, true);
    assert.equal(r.configs[0].user, PAPEL);
    assert.equal(r.configs[0].port, 55471);
    assert.equal(auditorias(c).length, 1);
    assert.equal(c.encerrado, true);
    assert.ok(c.chamadas.every((s) => /^(SELECT|INSERT INTO logs_auditoria_plataforma)\b/.test(s)));
  });

  test('NEGATIVO: objeto sem concessão devolve exit 3 (BLOQUEADO) com a lista, e audita o bloqueio', async () => {
    const c = clienteFalso({ usuario: PAPEL, pendentes: ['tabela_nova'] });
    const r = await rodar(['--verificar'], ENV_BACKUP, c);
    assert.equal(r.codigo, SAIDAS.BLOQUEADO);
    assert.deepEqual(r.linha.motivos, ['OBJETOS_SEM_CONCESSAO']);
    assert.deepEqual(r.linha.pendentes.itens.map((p) => p.nome), ['tabela_nova']);
    assert.equal(auditorias(c).length, 1);
  });

  test('NEGATIVO: rodar como outra identidade (ex.: o dono) é bloqueado; a saída nunca contém senha', async () => {
    const c = clienteFalso({ usuario: DONO });
    const r = await rodar(['--verificar'], { ...ENV_BACKUP, BACKUP_PG_USUARIO: DONO, DB_PASSWORD: 'ficticia-nao-vaza' }, c);
    assert.equal(r.codigo, SAIDAS.BLOQUEADO);
    assert.deepEqual(r.linha.motivos, ['IDENTIDADE_DIFERENTE_DO_PAPEL']);
    assert.doesNotMatch(r.texto, /ficticia-nao-vaza/);
  });
});

describe('[PRIV-B1-CLI] --aplicar e --proprietarios (como o proprietário)', () => {
  test('--aplicar sem a frase de confirmação (ou a frase sem --aplicar) é recusado com exit 2 e NADA é conectado', async () => {
    for (const argv of [['--aplicar'], [CONFIRMACAO], ['--verificar', CONFIRMACAO]]) {
      const c = clienteFalso({ usuario: DONO });
      const r = await rodar(argv, ENV_DONO, c);
      assert.equal(r.codigo, SAIDAS.ARGUMENTOS, argv.join(' '));
      assert.equal(c.conectado, false);
      assert.equal(r.configs.length, 0);
    }
  });

  test('POSITIVO: proprietário único aplica, a pós-verificação passa, exit 0, auditoria com o executor, senha nunca impressa', async () => {
    const c = clienteFalso({ usuario: DONO, pendentes: ['a', 'b'] });
    const r = await rodar(['--aplicar', CONFIRMACAO], ENV_DONO, c);
    assert.equal(r.codigo, SAIDAS.OK);
    assert.equal(r.linha.aplicado, true);
    assert.equal(r.linha.executor, DONO);
    assert.equal(r.configs[0].user, DONO);
    assert.deepEqual(c.chamadas.filter((s) => !/^(SELECT|INSERT INTO logs)/.test(s)), ['BEGIN', ...S.sqlDeConcessao(PAPEL), 'COMMIT']);
    assert.equal(auditorias(c).length, 1);
    assert.doesNotMatch(r.texto, /ficticia-nao-vaza/);
  });

  test('NEGATIVO: o papel de backup tentando --aplicar é recusado (exit 3), sem escrita', async () => {
    const c = clienteFalso({ usuario: PAPEL, donos: [{ dono: PAPEL, n: 75 }] });
    const r = await rodar(['--aplicar', CONFIRMACAO], { ...ENV_DONO, DB_USER: PAPEL }, c);
    assert.equal(r.codigo, SAIDAS.BLOQUEADO);
    assert.equal(r.linha.motivo, 'EXECUTOR_E_O_PAPEL_DE_BACKUP');
    assert.deepEqual(c.chamadas.filter((s) => /^(BEGIN|GRANT|COMMIT)/.test(s)), []);
  });

  test('--proprietarios só lê e lista os donos reais das relações de public', async () => {
    const c = clienteFalso({ usuario: DONO });
    const r = await rodar(['--proprietarios'], ENV_DONO, c);
    assert.equal(r.codigo, SAIDAS.OK);
    assert.deepEqual(r.linha.donos, [{ dono: DONO, relacoes: 75 }]);
    assert.ok(c.chamadas.every((s) => /^SELECT\b/.test(s)));
  });
});

describe('[PRIV-B1-CLI] argumentos, ambiente e falhas', () => {
  test('argumentos inválidos, repetidos ou sem modo: exit 2 e nada conectado', async () => {
    for (const argv of [[], ['--verificar', '--aplicar'], ['--desconhecido'], ['--verificar', '--verificar'], ['--verificar', 'extra']]) {
      const r = await rodar(argv, ENV_BACKUP, clienteFalso({ usuario: PAPEL }));
      assert.equal(r.codigo, SAIDAS.ARGUMENTOS, argv.join(' '));
      assert.equal(r.configs.length, 0);
    }
  });

  test('ambiente incompleto ou porta inválida: exit 2 sem conectar; falha de conexão: exit 1 com motivo fixo', async () => {
    for (const env of [{}, { ...ENV_BACKUP, BACKUP_PG_PORTA: '99999' }, { ...ENV_BACKUP, BACKUP_PG_PORTA: '55a' }, { ...ENV_BACKUP, BACKUP_PG_BANCO: '' }]) {
      const r = await rodar(['--verificar'], env, clienteFalso({ usuario: PAPEL }));
      assert.equal(r.codigo, SAIDAS.ARGUMENTOS);
      assert.equal(r.linha.motivo, 'AMBIENTE_INCOMPLETO');
      assert.equal(r.configs.length, 0);
    }
    const quebrado = clienteFalso({ usuario: PAPEL });
    quebrado.connect = async () => { throw new Error('sem socket'); };
    const r = await rodar(['--verificar'], ENV_BACKUP, quebrado);
    assert.equal(r.codigo, SAIDAS.ERRO);
    assert.equal(r.linha.motivo, 'CONEXAO_FALHOU');
  });

  test('o papel vem de BACKUP_PAPEL_BANCO e é validado: valor perigoso vira EXECUCAO_FALHOU, nunca SQL', async () => {
    const c = clienteFalso({ usuario: PAPEL });
    const r = await rodar(['--verificar'], { ...ENV_BACKUP, BACKUP_PAPEL_BANCO: 'x; DROP ROLE y' }, c);
    assert.equal(r.codigo, SAIDAS.ERRO);
    assert.equal(r.linha.motivo, 'EXECUCAO_FALHOU');
    assert.ok(!c.chamadas.some((s) => /DROP/.test(s)));
    assert.equal(c.encerrado, true);
  });
});

describe('[PRIV-B1-INTEGRACAO] pré-verificação + a coordenação REAL do executor (advisory locks)', () => {
  function sessaoDoPapel({ pendentes }) {
    const f = clienteFalso({ usuario: PAPEL, pendentes });
    const orig = f.query;
    f.query = async (sql) => {
      if (/pg_(try_advisory_lock|advisory_unlock)/.test(sql)) { f.chamadas.push(sql); return { rows: [{ tomado: true, liberado: true }] }; }
      return orig(sql);
    };
    return f;
  }
  const montar = (sessao) => S.criarPreVerificacaoDaCoordenacao({
    coordenacao: criarCoordenacaoDoExecutor({ executorDeBanco: sessao }),
    verificador: S.criarVerificadorDePrivilegios({ executorDeBanco: sessao, papel: PAPEL }),
    auditoria: S.criarRegistradorDeAuditoria({ executorDeAuditoria: clienteFalso({ usuario: PAPEL }), registrarEventoSistema: async () => ({ id: 1 }) }),
  });

  test('NEGATIVO: com pendência, NENHUM pg_try_advisory_lock é enviado (nada é tomado, nada precisa ser liberado)', async () => {
    const sessao = sessaoDoPapel({ pendentes: ['tabela_nova'] });
    const r = await montar(sessao).adquirir({ operacao: 'BACKUP' });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'PRIVILEGIOS_B1_PENDENTES');
    assert.deepEqual(sessao.chamadas.filter((s) => /advisory/.test(s)), []);
  });

  test('POSITIVO: sem pendência, as travas são tomadas DEPOIS das consultas de verificação e liberadas normalmente', async () => {
    const sessao = sessaoDoPapel({ pendentes: [] });
    const r = await montar(sessao).adquirir({ operacao: 'BACKUP' });
    assert.equal(r.ok, true);
    const primeiraTrava = sessao.chamadas.findIndex((s) => /pg_try_advisory_lock/.test(s));
    const ultimaVerificacao = sessao.chamadas.lastIndexOf(S.CONSULTAS.ACESSO);
    assert.ok(ultimaVerificacao >= 0 && primeiraTrava > ultimaVerificacao, 'verificação antes da primeira trava');
    await r.liberar();
    assert.ok(sessao.chamadas.some((s) => /pg_advisory_unlock/.test(s)));
  });
});
