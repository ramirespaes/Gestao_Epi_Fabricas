'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { montarCenario, criarSolicitacao } = require('./helpers/solicitacao-epi');

/**
 * Atendimento Token — Etapa A (RED): banco do tablet compartilhado de autoatendimento. PostgreSQL real, schema temporário
 * exclusivo do banco de teste; o estado anterior (000 a 085) é montado explicitamente e a 086/087 só são aplicadas aqui.
 *
 * 086 — estrutura (nenhuma tabela existente muda; solicitacoes_epi fica idêntica):
 *   token_dispositivos        tablet da empresa: identificador interno UUID único, nome único por empresa (sem caixa),
 *                             unidade, setor, local, fabricante, modelo, número de série (inventário, único por empresa quando
 *                             informado), credencial (só o SHA-256 hex; só com o tablet ativado; nunca depois da revogação),
 *                             hash anterior para detectar reuso, último contato e a comunicação registrada (ONLINE|OFFLINE).
 *                             A situação administrativa é DERIVADA (pendente/ativo/revogado pelos carimbos), sem coluna status.
 *   token_ativacoes           código do QR: só o SHA-256; uso único; validade de no máximo 10 minutos; usado XOR cancelado;
 *                             um pendente por tablet.
 *   token_atendimentos        sessão curta do trabalhador no tablet: funcionário e tablet da MESMA empresa; um aberto por
 *                             tablet; encerramento com motivo do domínio.
 *   token_redes_autorizadas   redes da empresa: IP_FIXO ou TUNEL (CIDR); a sub-rede de túnel ativa nunca se sobrepõe a
 *                             outra (cada túnel identifica UMA empresa); IP fixo pode coincidir entre empresas (o tablet
 *                             decide a empresa); sem duplicata ativa na mesma empresa.
 *   token_dispositivo_eventos histórico append-only (cadastro, ativação, revogação, credencial, rede recusada, queda,
 *                             restabelecimento com duração); UPDATE e DELETE recusados.
 *   solicitacoes_autoatendimento  tabela lateral 1:1: solicitação AUTOATENDIMENTO, tablet e atendimento coerentes, cópia
 *                             da localização do tablet na data do pedido; imutável.
 *   Todas as referências entre empresas por FK composta (empresa_id, ...).
 * 087 — permissões (só dados): ações TOKEN_GERAR_ATIVACAO, TOKEN_REVOGAR_DISPOSITIVO, TOKEN_GERENCIAR_REDES (OBRIGATORIA) e
 *   TOKEN_PREVIA_CATALOGO_REAL; sem SST; nascem NEGADAS (nenhum perfil, grupo, concessão ou bloqueio); nenhuma ação
 *   existente muda. Visualizar, cadastrar e editar são o recurso `atendimentoToken` (sem linha no banco).
 *
 * Enquanto backend/migrations/086_*.sql e 087_*.sql não existirem, cada teste falha por asserção.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const MIGRATIONS_ATE_085 = fs.readdirSync(DIRETORIO_MIGRATIONS)
  .map((nome) => nome.match(/^(\d{3})_.*\.sql$/)?.[1])
  .filter((prefixo) => prefixo !== undefined && prefixo <= '085')
  .sort();

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const VIOLACAO_EXCLUSAO = '23P01';
const RECUSA_DO_GATILHO = 'P0001';
const TABELAS_NOVAS = ['token_dispositivos', 'token_ativacoes', 'token_atendimentos', 'token_redes_autorizadas', 'token_dispositivo_eventos', 'solicitacoes_autoatendimento'];
const ACOES_NOVAS = {
  TOKEN_GERAR_ATIVACAO: 'ALTERNATIVA',
  TOKEN_REVOGAR_DISPOSITIVO: 'ALTERNATIVA',
  TOKEN_GERENCIAR_REDES: 'OBRIGATORIA',
  TOKEN_PREVIA_CATALOGO_REAL: 'ALTERNATIVA',
  TOKEN_VISUALIZAR_MONITORAMENTO: 'ALTERNATIVA',
  TOKEN_VISUALIZAR_HISTORICO: 'ALTERNATIVA',
};

const hash = () => crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');

describe('migrations 086/087 — Atendimento Token (PostgreSQL real, schema temporário)', () => {
  let contexto;
  let c;
  let d;
  let solicitacaoAuto;
  let solicitacaoAuto2;
  let solicitacaoInterna;
  let antes;
  let aplicada086 = false;
  let aplicada087 = false;
  let sequencia = 0;

  const q = (sql, parametros = []) => c.query(sql, parametros);
  /** Executa e devolve { ok, linha } ou { ok:false, code, constraint } (nunca lança). */
  const tentar = async (sql, parametros = []) => {
    try {
      const { rows } = await c.query(sql, parametros);
      return { ok: true, linha: rows[0] };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint, mensagem: erro.message };
    }
  };
  const recusa = (r, code, rotulo) => {
    assert.equal(r.ok, false, `${rotulo}: deveria ser recusado`);
    assert.equal(r.code, code, `${rotulo}: SQLSTATE ${r.code} (${r.constraint || ''}) ${r.mensagem || ''}`);
  };
  /** Recusa da regra do gatilho (não de outra restrição qualquer): P0001 com a mensagem da regra. */
  const recusaDaRegra = (r, mensagem, rotulo) => {
    recusa(r, RECUSA_DO_GATILHO, rotulo);
    assert.match(r.mensagem, mensagem, `${rotulo}: mensagem "${r.mensagem}"`);
  };
  const aceita = (r, rotulo) => assert.equal(r.ok, true, `${rotulo}: recusado com ${r.code} (${r.constraint || ''})`);

  const estruturaDe = async (tabela) => ({
    colunas: (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [tabela])).rows,
    restricoes: (await q('SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY 1', [tabela])).rows,
    gatilhos: (await q('SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1', [tabela])).rows,
    indices: (await q('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY 1', [tabela])).rows,
  });
  const contagens = async () => (await q(`SELECT (SELECT count(*) FROM solicitacoes_epi)::int AS solicitacoes, (SELECT count(*) FROM funcionarios)::int AS funcionarios,
    (SELECT count(*) FROM usuarios)::int AS usuarios, (SELECT count(*) FROM empresas)::int AS empresas, (SELECT count(*) FROM materiais)::int AS materiais`)).rows[0];
  const acoesExistentes = async () => (await q('SELECT codigo, nome, descricao, ativo, exige_sst, modo_autorizacao_individual FROM acoes ORDER BY codigo')).rows;

  const aplicar086 = async () => {
    assert.ok(migrationExiste('086'), 'a migration 086 (estrutura do Atendimento Token) ainda não existe em backend/migrations');
    if (!aplicada086) { await q(conteudoDaMigration('086')); aplicada086 = true; }
  };
  const aplicar087 = async () => {
    await aplicar086();
    assert.ok(migrationExiste('087'), 'a migration 087 (permissões do Atendimento Token) ainda não existe em backend/migrations');
    if (!aplicada087) { await q(conteudoDaMigration('087')); aplicada087 = true; }
  };

  // ── fixtures sobre as tabelas novas (usadas só depois de aplicar086) ──
  const novoDispositivo = (empresaId, criadoPor, extra = {}) => {
    sequencia += 1;
    const valores = { empresa_id: empresaId, nome: `Tablet ${sequencia}`, criado_por: criadoPor, ...extra };
    const colunas = Object.keys(valores);
    return tentar(`INSERT INTO token_dispositivos (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(valores));
  };
  const dispositivo = async (empresaId, criadoPor, extra) => {
    const r = await novoDispositivo(empresaId, criadoPor, extra);
    aceita(r, 'fixture de dispositivo');
    return r.linha;
  };
  const novoAtendimento = (empresaId, dispositivoId, funcionarioId, extra = {}) => tentar(
    `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em${Object.keys(extra).map((k) => `, ${k}`).join('')})
     VALUES ($1, $2, $3, $4, now() + interval '90 seconds'${Object.keys(extra).map((_, i) => `, $${i + 5}`).join('')}) RETURNING *`,
    [empresaId, dispositivoId, funcionarioId, hash(), ...Object.values(extra)],
  );

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_085);
    c = contexto.cliente;
    d = await montarCenario(c);
    solicitacaoAuto = (await criarSolicitacao(c, d, { origem: 'AUTOATENDIMENTO', itens: [{ material_id: d.capacete, tamanho: null }] })).solicitacao;
    solicitacaoAuto2 = (await criarSolicitacao(c, d, { origem: 'AUTOATENDIMENTO', funcionarioId: d.trabalhadorA2, itens: [{ material_id: d.capacete, tamanho: null }] })).solicitacao;
    solicitacaoInterna = (await criarSolicitacao(c, d, { itens: [{ material_id: d.capacete, tamanho: null }] })).solicitacao;
    antes = { solicitacoes: await estruturaDe('solicitacoes_epi'), itens: await estruturaDe('solicitacoes_epi_itens'), contagens: await contagens(), acoes: await acoesExistentes() };
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('086 — estrutura geral e preservação', () => {
    test('as seis tabelas novas existem; nenhuma tabela antiga muda (solicitações e itens idênticos, dados intactos)', async () => {
      await aplicar086();
      for (const tabela of TABELAS_NOVAS) {
        assert.equal((await q('SELECT to_regclass($1) IS NOT NULL AS existe', [tabela])).rows[0].existe, true, tabela);
      }
      assert.deepEqual(await estruturaDe('solicitacoes_epi'), antes.solicitacoes, 'solicitacoes_epi não muda');
      assert.deepEqual(await estruturaDe('solicitacoes_epi_itens'), antes.itens, 'solicitacoes_epi_itens não muda');
      assert.deepEqual(await contagens(), antes.contagens);
    });

    test('todas as referências entre tabelas novas e antigas são FKs compostas por empresa (nenhuma FK só por id)', async () => {
      await aplicar086();
      const fks = (await q(`SELECT conrelid::regclass::text AS tabela, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                             WHERE contype = 'f' AND conrelid::regclass::text = ANY($1)`, [TABELAS_NOVAS])).rows;
      assert.ok(fks.length >= 10, `FKs encontradas: ${fks.length}`);
      for (const fk of fks.filter((x) => !/REFERENCES empresas\(id\)/.test(x.def))) {
        assert.match(fk.def, /^FOREIGN KEY \(empresa_id, /, `${fk.tabela}.${fk.conname}: ${fk.def}`);
      }
    });
  });

  describe('086 — token_dispositivos', () => {
    test('identificador interno UUID gerado e único; situação administrativa derivada (sem coluna status/situacao)', async () => {
      await aplicar086();
      const a = await dispositivo(d.empresaA, d.solicitante);
      const b = await dispositivo(d.empresaA, d.solicitante);
      assert.match(String(a.identificador), /^[0-9a-f-]{36}$/);
      assert.notEqual(a.identificador, b.identificador);
      recusa(await tentar('UPDATE token_dispositivos SET identificador = $1 WHERE id = $2', [b.identificador, a.id]), VIOLACAO_UNIQUE, 'identificador repetido');
      const colunas = (await estruturaDe('token_dispositivos')).colunas.map((x) => x.column_name);
      for (const coluna of ['empresa_id', 'identificador', 'nome', 'unidade', 'setor', 'local_instalacao', 'fabricante', 'modelo', 'numero_serie',
        'credencial_hash', 'credencial_anterior_hash', 'credencial_emitida_em', 'ativado_em', 'revogado_em', 'revogado_por', 'ultimo_contato_em',
        'comunicacao_registrada', 'criado_por', 'criado_em', 'atualizado_em']) {
        assert.ok(colunas.includes(coluna), `falta ${coluna}`);
      }
      assert.equal(colunas.some((x) => /^(status|situacao)$/.test(x)), false);
    });

    test('nome obrigatório, aparado e único por empresa sem diferenciar caixa; outra empresa pode repetir', async () => {
      await aplicar086();
      await dispositivo(d.empresaA, d.solicitante, { nome: 'Tablet Expedição' });
      recusa(await novoDispositivo(d.empresaA, d.solicitante, { nome: 'tablet expedição' }), VIOLACAO_UNIQUE, 'nome repetido na empresa');
      aceita(await novoDispositivo(d.empresaB, d.usuarioB, { nome: 'Tablet Expedição' }), 'mesmo nome em outra empresa');
      recusa(await novoDispositivo(d.empresaA, d.solicitante, { nome: ' Tablet ' }), VIOLACAO_CHECK, 'nome não aparado');
      recusa(await novoDispositivo(d.empresaA, d.solicitante, { nome: '' }), VIOLACAO_CHECK, 'nome vazio');
    });

    test('número de série é inventário: opcional, único por empresa quando informado, repetível em outra empresa', async () => {
      await aplicar086();
      await dispositivo(d.empresaA, d.solicitante, { numero_serie: 'SN-0001', fabricante: 'Fab', modelo: 'Tab 10' });
      recusa(await novoDispositivo(d.empresaA, d.solicitante, { numero_serie: 'SN-0001' }), VIOLACAO_UNIQUE, 'série repetida');
      aceita(await novoDispositivo(d.empresaB, d.usuarioB, { numero_serie: 'SN-0001' }), 'série em outra empresa');
      aceita(await novoDispositivo(d.empresaA, d.solicitante, {}), 'sem série 1');
      aceita(await novoDispositivo(d.empresaA, d.solicitante, {}), 'sem série 2');
    });

    test('criado_por e revogado_por precisam ser usuários da MESMA empresa (FK composta)', async () => {
      await aplicar086();
      recusa(await novoDispositivo(d.empresaA, d.usuarioB), VIOLACAO_FK, 'criador de outra empresa');
      const t = await dispositivo(d.empresaA, d.solicitante);
      recusa(await tentar('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $1 WHERE id = $2', [d.usuarioB, t.id]), VIOLACAO_FK, 'revogador de outra empresa');
    });

    test('credencial: só SHA-256 hex minúsculo, única, só com o tablet ativado, nunca depois da revogação; revogação exige quem revogou', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      recusa(await tentar('UPDATE token_dispositivos SET credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2', [hash(), t.id]), VIOLACAO_CHECK, 'credencial sem ativação');
      recusa(await tentar('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2', ['ABC', t.id]), VIOLACAO_CHECK, 'formato');
      recusa(await tentar('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2', [hash().toUpperCase(), t.id]), VIOLACAO_CHECK, 'maiúsculas');
      const h = hash();
      aceita(await tentar('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2 RETURNING id', [h, t.id]), 'ativação');
      const outro = await dispositivo(d.empresaA, d.solicitante);
      recusa(await tentar('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2', [h, outro.id]), VIOLACAO_UNIQUE, 'credencial repetida');
      recusa(await tentar('UPDATE token_dispositivos SET revogado_em = now() WHERE id = $1', [t.id]), VIOLACAO_CHECK, 'revogação sem quem revogou');
      // Tablet SEM credencial (nunca ativado): aqui só a regra "revogado_em e revogado_por andam juntos" se aplica.
      const pendente = await dispositivo(d.empresaA, d.solicitante);
      const semResponsavel = await tentar('UPDATE token_dispositivos SET revogado_em = now() WHERE id = $1', [pendente.id]);
      recusa(semResponsavel, VIOLACAO_CHECK, 'revogação de tablet sem credencial e sem quem revogou');
      assert.equal(semResponsavel.constraint, 'chk_token_dispositivos_revogacao', `a regra violada deveria ser a da revogação, não ${semResponsavel.constraint}`);
      aceita(await tentar('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $1 WHERE id = $2 RETURNING id', [d.aprovador, pendente.id]), 'revogação completa de tablet pendente');
      recusa(await tentar('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $1 WHERE id = $2', [d.aprovador, t.id]), VIOLACAO_CHECK, 'revogado ainda com credencial');
      aceita(await tentar('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $1, credencial_hash = NULL WHERE id = $2 RETURNING id', [d.aprovador, t.id]), 'revogação limpa a credencial');
    });

    test('comunicação registrada só ONLINE ou OFFLINE (nula antes do primeiro heartbeat)', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      assert.equal(t.comunicacao_registrada, null);
      aceita(await tentar("UPDATE token_dispositivos SET comunicacao_registrada = 'ONLINE', ultimo_contato_em = now() WHERE id = $1 RETURNING id", [t.id]), 'ONLINE');
      recusa(await tentar("UPDATE token_dispositivos SET comunicacao_registrada = 'DESLIGADO' WHERE id = $1", [t.id]), VIOLACAO_CHECK, 'valor fora do domínio');
    });
  });

  describe('086 — token_ativacoes (QR de uso único)', () => {
    const novaAtivacao = (empresaId, dispositivoId, criadoPor, expiraEm = "now() + interval '10 minutes'") => tentar(
      `INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em)
       VALUES ($1, $2, $3, $4, now(), ${expiraEm}) RETURNING *`,
      [empresaId, dispositivoId, hash(), criadoPor],
    );

    test('validade de no máximo 10 minutos e sempre depois da criação; código só como SHA-256 hex', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      recusa(await novaAtivacao(d.empresaA, t.id, d.solicitante, "now() + interval '10 minutes 1 second'"), VIOLACAO_CHECK, 'acima de 10 minutos');
      recusa(await novaAtivacao(d.empresaA, t.id, d.solicitante, 'now()'), VIOLACAO_CHECK, 'sem validade');
      aceita(await novaAtivacao(d.empresaA, t.id, d.solicitante), '10 minutos');
      recusa(await tentar(`INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, expira_em)
                           VALUES ($1, $2, 'abc', $3, now() + interval '5 minutes')`, [d.empresaA, t.id, d.solicitante]), VIOLACAO_CHECK, 'formato do código');
    });

    test('um pendente por tablet; usado e cancelado nunca ao mesmo tempo; tablet e criador da mesma empresa', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      const primeira = await novaAtivacao(d.empresaA, t.id, d.solicitante);
      aceita(primeira, 'primeira');
      recusa(await novaAtivacao(d.empresaA, t.id, d.solicitante), VIOLACAO_UNIQUE, 'segundo pendente');
      recusa(await tentar('UPDATE token_ativacoes SET usado_em = now(), cancelado_em = now() WHERE id = $1', [primeira.linha.id]), VIOLACAO_CHECK, 'usado e cancelado');
      aceita(await tentar('UPDATE token_ativacoes SET cancelado_em = now() WHERE id = $1 RETURNING id', [primeira.linha.id]), 'cancela');
      aceita(await novaAtivacao(d.empresaA, t.id, d.solicitante), 'novo pendente depois do cancelamento');
      recusa(await novaAtivacao(d.empresaB, t.id, d.usuarioB), VIOLACAO_FK, 'tablet de outra empresa');
      const tb = await dispositivo(d.empresaB, d.usuarioB);
      recusa(await novaAtivacao(d.empresaB, tb.id, d.solicitante), VIOLACAO_FK, 'criador de outra empresa');
    });
  });

  describe('086 — token_atendimentos (sessão curta do trabalhador)', () => {
    test('funcionário e tablet da MESMA empresa; token só SHA-256; expira depois de começar', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      recusa(await novoAtendimento(d.empresaA, t.id, d.trabalhadorB), VIOLACAO_FK, 'funcionário de outra empresa');
      const tb = await dispositivo(d.empresaB, d.usuarioB);
      recusa(await novoAtendimento(d.empresaA, tb.id, d.trabalhadorA), VIOLACAO_FK, 'tablet de outra empresa');
      recusa(await tentar(`INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em)
                           VALUES ($1, $2, $3, 'x', now() + interval '1 minute')`, [d.empresaA, t.id, d.trabalhadorA]), VIOLACAO_CHECK, 'formato do token');
      recusa(await tentar(`INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, iniciado_em, expira_em)
                           VALUES ($1, $2, $3, $4, now(), now() - interval '1 second')`, [d.empresaA, t.id, d.trabalhadorA, hash()]), VIOLACAO_CHECK, 'expira antes de começar');
    });

    test('um atendimento aberto por tablet; encerramento com motivo do domínio, sempre os dois juntos', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      const aberto = await novoAtendimento(d.empresaA, t.id, d.trabalhadorA);
      aceita(aberto, 'primeiro');
      recusa(await novoAtendimento(d.empresaA, t.id, d.trabalhadorA2), VIOLACAO_UNIQUE, 'segundo aberto no mesmo tablet');
      recusa(await tentar('UPDATE token_atendimentos SET encerrado_em = now() WHERE id = $1', [aberto.linha.id]), VIOLACAO_CHECK, 'encerrado sem motivo');
      recusa(await tentar("UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = 'LOGOUT' WHERE id = $1", [aberto.linha.id]), VIOLACAO_CHECK, 'motivo fora do domínio');
      for (const motivo of ['PEDIDO_ENVIADO', 'SAIDA', 'INATIVIDADE', 'SUBSTITUIDO', 'DISPOSITIVO_REVOGADO']) {
        const t2 = await dispositivo(d.empresaA, d.solicitante);
        const a = await novoAtendimento(d.empresaA, t2.id, d.trabalhadorA);
        aceita(await tentar('UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = $1 WHERE id = $2 RETURNING id', [motivo, a.linha.id]), motivo);
      }
      aceita(await tentar("UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = 'SAIDA' WHERE id = $1 RETURNING id", [aberto.linha.id]), 'encerra');
      aceita(await novoAtendimento(d.empresaA, t.id, d.trabalhadorA2), 'novo aberto depois de encerrar');
    });
  });

  describe('086 — token_redes_autorizadas', () => {
    const novaRede = (empresaId, tipo, rede, criadoPor) => tentar(
      'INSERT INTO token_redes_autorizadas (empresa_id, tipo, rede, criado_por) VALUES ($1, $2, $3::cidr, $4) RETURNING *', [empresaId, tipo, rede, criadoPor],
    );

    test('tipo só IP_FIXO ou TUNEL; rede em CIDR; sem duplicata ativa na mesma empresa; criador da mesma empresa', async () => {
      await aplicar086();
      aceita(await novaRede(d.empresaA, 'IP_FIXO', '203.0.113.10/32', d.solicitante), 'IP fixo');
      recusa(await novaRede(d.empresaA, 'IP_FIXO', '203.0.113.10/32', d.solicitante), VIOLACAO_UNIQUE, 'duplicata ativa');
      recusa(await novaRede(d.empresaA, 'WIFI', '198.51.100.0/24', d.solicitante), VIOLACAO_CHECK, 'tipo fora do domínio');
      recusa(await novaRede(d.empresaA, 'IP_FIXO', '198.51.100.0/24', d.usuarioB), VIOLACAO_FK, 'criador de outra empresa');
    });

    test('túnel identifica UMA empresa: sub-redes de túnel ativas nunca se sobrepõem; IP fixo pode coincidir entre empresas', async () => {
      await aplicar086();
      aceita(await novaRede(d.empresaA, 'TUNEL', '10.77.1.0/24', d.solicitante), 'túnel A');
      recusa(await novaRede(d.empresaB, 'TUNEL', '10.77.1.128/25', d.usuarioB), VIOLACAO_EXCLUSAO, 'túnel B sobreposto ao de A');
      aceita(await novaRede(d.empresaB, 'TUNEL', '10.77.2.0/24', d.usuarioB), 'túnel B separado');
      aceita(await novaRede(d.empresaA, 'IP_FIXO', '192.0.2.50/32', d.solicitante), 'IP fixo A');
      aceita(await novaRede(d.empresaB, 'IP_FIXO', '192.0.2.50/32', d.usuarioB), 'mesmo IP fixo em B (o tablet decide a empresa)');
    });
  });

  describe('086 — token_dispositivo_eventos (histórico append-only)', () => {
    const novoEvento = (empresaId, dispositivoId, tipo, extra = {}) => tentar(
      `INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo${Object.keys(extra).map((k) => `, ${k}`).join('')})
       VALUES ($1, $2, $3${Object.keys(extra).map((_, i) => `, $${i + 4}`).join('')}) RETURNING *`,
      [empresaId, dispositivoId, tipo, ...Object.values(extra)],
    );

    test('tipos do domínio; duração só (e sempre) no restabelecimento; usuário e tablet da mesma empresa', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      for (const tipo of ['CADASTRO', 'ALTERACAO', 'ATIVACAO_GERADA', 'ATIVACAO', 'REVOGACAO', 'CREDENCIAL_RENOVADA', 'REUSO_CREDENCIAL', 'REDE_RECUSADA', 'QUEDA']) {
        aceita(await novoEvento(d.empresaA, t.id, tipo), tipo);
      }
      aceita(await novoEvento(d.empresaA, t.id, 'RESTABELECIMENTO', { duracao_segundos: 240 }), 'restabelecimento com duração');
      recusa(await novoEvento(d.empresaA, t.id, 'RESTABELECIMENTO'), VIOLACAO_CHECK, 'restabelecimento sem duração');
      recusa(await novoEvento(d.empresaA, t.id, 'QUEDA', { duracao_segundos: 10 }), VIOLACAO_CHECK, 'duração fora do restabelecimento');
      recusa(await novoEvento(d.empresaA, t.id, 'DESLIGADO'), VIOLACAO_CHECK, 'tipo fora do domínio');
      recusa(await novoEvento(d.empresaA, t.id, 'REVOGACAO', { usuario_id: d.usuarioB }), VIOLACAO_FK, 'usuário de outra empresa');
    });

    test('append-only: UPDATE e DELETE recusados, o registro continua igual', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      const e = await novoEvento(d.empresaA, t.id, 'QUEDA');
      aceita(e, 'evento');
      recusaDaRegra(await tentar("UPDATE token_dispositivo_eventos SET tipo = 'ATIVACAO' WHERE id = $1", [e.linha.id]), /append-only/, 'UPDATE');
      recusaDaRegra(await tentar('DELETE FROM token_dispositivo_eventos WHERE id = $1', [e.linha.id]), /append-only/, 'DELETE');
      assert.equal((await q('SELECT tipo FROM token_dispositivo_eventos WHERE id = $1', [e.linha.id])).rows[0].tipo, 'QUEDA');
    });
  });

  describe('086 — solicitacoes_autoatendimento (rastreabilidade do tablet)', () => {
    const vincular = (solicitacao, dispositivoId, atendimentoId, local = {}) => tentar(
      `INSERT INTO solicitacoes_autoatendimento (empresa_id, solicitacao_id, dispositivo_id, atendimento_id, unidade, setor, local_instalacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [solicitacao.empresa_id, solicitacao.id, dispositivoId, atendimentoId, local.unidade ?? null, local.setor ?? null, local.local ?? null],
    );

    test('só solicitação AUTOATENDIMENTO; uma linha por solicitação; cópia da localização que não acompanha o tablet depois', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante, { unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria norte' });
      const a = (await novoAtendimento(d.empresaA, t.id, d.trabalhadorA)).linha;
      const atendInterno = (await novoAtendimento(d.empresaA, (await dispositivo(d.empresaA, d.solicitante)).id, d.trabalhadorA)).linha;
      recusaDaRegra(await vincular(solicitacaoInterna, t.id, atendInterno.id), /AUTOATENDIMENTO/, 'solicitação USUARIO_INTERNO');
      const ok = await vincular(solicitacaoAuto, t.id, a.id, { unidade: 'Fábrica 1', setor: 'Expedição', local: 'Portaria norte' });
      aceita(ok, 'solicitação AUTOATENDIMENTO');
      recusa(await vincular(solicitacaoAuto, t.id, a.id), VIOLACAO_UNIQUE, 'segunda linha da mesma solicitação');
      await q("UPDATE token_dispositivos SET local_instalacao = 'Almoxarifado' WHERE id = $1", [t.id]);
      assert.equal((await q('SELECT local_instalacao FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacaoAuto.id])).rows[0].local_instalacao, 'Portaria norte');
    });

    test('tablet da mesma empresa; atendimento do MESMO tablet e do MESMO funcionário da solicitação', async () => {
      await aplicar086();
      const t = await dispositivo(d.empresaA, d.solicitante);
      const outroTablet = await dispositivo(d.empresaA, d.solicitante);
      const tb = await dispositivo(d.empresaB, d.usuarioB);
      const doOutroTablet = (await novoAtendimento(d.empresaA, outroTablet.id, d.trabalhadorA2)).linha;
      const doOutroFuncionario = (await novoAtendimento(d.empresaA, t.id, d.trabalhadorA)).linha;
      // Atendimento coerente com o funcionário da solicitação (A2): a ÚNICA regra violada é a do tablet de outra empresa.
      recusa(await vincular(solicitacaoAuto2, tb.id, doOutroTablet.id), VIOLACAO_FK, 'tablet de outra empresa');
      recusa(await vincular(solicitacaoAuto2, t.id, doOutroTablet.id), VIOLACAO_FK, 'atendimento de outro tablet');
      recusaDaRegra(await vincular(solicitacaoAuto2, t.id, doOutroFuncionario.id), /outro funcionário/, 'atendimento de outro funcionário');
      const doMesmo = (await novoAtendimento(d.empresaA, outroTablet.id, d.trabalhadorA2)).linha;
      assert.equal(doMesmo, undefined, 'premissa: outroTablet já tem atendimento aberto de A2');
      aceita(await vincular(solicitacaoAuto2, outroTablet.id, doOutroTablet.id), 'controle: tablet e funcionário coerentes');
    });

    test('imutável: UPDATE e DELETE recusados', async () => {
      await aplicar086();
      const linha = (await q('SELECT * FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacaoAuto.id])).rows[0];
      assert.ok(linha, 'premissa: a linha do teste anterior existe');
      recusaDaRegra(await tentar("UPDATE solicitacoes_autoatendimento SET setor = 'Outro' WHERE solicitacao_id = $1", [solicitacaoAuto.id]), /imutável/, 'UPDATE');
      recusaDaRegra(await tentar('DELETE FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacaoAuto.id]), /imutável/, 'DELETE');
      assert.equal((await q('SELECT setor FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacaoAuto.id])).rows[0].setor, linha.setor);
    });
  });

  describe('087 — permissões do Atendimento Token', () => {
    test('quatro ações novas, ativas, sem SST, com o modo de autorização aprovado; nenhuma ação existente muda', async () => {
      await aplicar087();
      const novas = (await q('SELECT codigo, ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = ANY($1) ORDER BY codigo', [Object.keys(ACOES_NOVAS)])).rows;
      assert.deepEqual(novas.map((x) => [x.codigo, x.ativo, x.exige_sst, x.modo_autorizacao_individual]),
        Object.entries(ACOES_NOVAS).sort().map(([codigo, modo]) => [codigo, true, false, modo]));
      const depois = (await acoesExistentes()).filter((x) => !(x.codigo in ACOES_NOVAS));
      assert.deepEqual(depois, antes.acoes);
    });

    test('nascem NEGADAS: nenhuma permissão de perfil, de grupo, concessão ou bloqueio individual', async () => {
      await aplicar087();
      assert.equal((await q('SELECT count(*)::int AS n FROM acoes WHERE codigo = ANY($1)', [Object.keys(ACOES_NOVAS)])).rows[0].n, Object.keys(ACOES_NOVAS).length,
        'premissa: as seis ações existem');
      for (const tabela of ['permissoes_acao', 'grupo_permissoes_acao', 'usuario_autorizacoes', 'usuario_bloqueios']) {
        const n = (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE acao_codigo = ANY($1)`, [Object.keys(ACOES_NOVAS)])).rows[0].n;
        assert.equal(n, 0, tabela);
      }
    });
  });
});
