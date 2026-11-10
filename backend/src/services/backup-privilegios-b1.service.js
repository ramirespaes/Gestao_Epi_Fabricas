'use strict';

const crypto = require('node:crypto');

/**
 * D-ORF-6, H9-h (decisão de Ramires em 09/11/2026: candidato B-1 escolhido para preparar a homologação): privilégios mínimos do papel de backup por `SELECT` explícito por objeto.
 * Este módulo é LOCAL e ISOLADO: não é ligado ao CD, ao `backup-operar.js` nem ao montador; quem integra injeta as peças. Nada aqui lê ambiente, abre conexão, cria papel ou lança processo.
 *
 *  - `criarVerificadorDePrivilegios({ executorDeBanco, papel, exigirIdentidade? })` -> `{ verificar() }`: SOMENTE LEITURA, FAIL-CLOSED. `ok` só se a sessão É o papel (quando exigido), o papel existe, `public` tem
 *    objetos, NENHUM objeto de `public` (tabelas, partições, visões materializadas, sequências, visões, tabelas externas) está sem `SELECT`, não há esquema fora de `public`, e o papel tem `USAGE` em `public` e `CONNECT`
 *    no banco. Qualquer erro de consulta ou resposta fora da forma vira `VERIFICACAO_FALHOU` (nunca `ok`). `CONNECTION LIMIT` abaixo da referência do ensaio (5) é só AVISO.
 *  - `criarPreVerificacaoDaCoordenacao({ coordenacao, verificador, auditoria })` -> `{ adquirir }`: verifica ANTES de a coordenação tomar qualquer trava; com pendência devolve `{ ok:false }` sem chamar `adquirir`
 *    (nenhuma trava advisory é tomada e nenhuma operação começa). Só vale para `BACKUP`; `RESTAURACAO` passa direto (não lê a origem).
 *  - `criarAplicadorDeConcessoes({ executorDeBanco, papel, auditoria })` -> `{ identificarProprietarios(), aplicar() }`: roda os três `GRANT` do B-1, em uma transação, SOMENTE se a sessão é o ÚNICO proprietário das
 *    relações de `public` e NÃO é o papel de backup; confere o resultado com o verificador. Nunca cria o papel. Quem o chama é a identidade proprietária (CD/humano), nunca o executor do backup.
 *  - `criarRegistradorDeAuditoria({ executorDeAuditoria, registrarEventoSistema })` -> `{ registrar }`: um evento `SISTEMA` por resultado, com papel, identidade executora (usuário e sessão), pendências e motivos. Nunca lança.
 * LIMITES: não prova nada em Linux/HML; o proprietário real das tabelas do HML ainda não foi levantado (o aplicador exige proprietário único e igual à sessão). O SQL de concessão e a consulta de verificação são os do
 * ensaio de 09/11/2026 (documento H9H-B1), com `visões` e `tabelas externas` acrescentadas à verificação por prudência.
 */

const PAPEL_PADRAO = 'safework_backup_executor';
const CONNECTION_LIMIT_REFERENCIA = 5;
const LIMITE_LISTADO = 50;
const LIMITE_NO_AUDITORIA = 20;
const RE_PAPEL = /^[a-z_][a-z0-9_]{0,62}$/;
const RELKINDS = "'r', 'p', 'm', 'S', 'v', 'f'";
const ACOES = Object.freeze({
  VERIFICACAO_OK: 'BACKUP_PRIVILEGIOS_B1_VERIFICACAO_OK',
  VERIFICACAO_BLOQUEADA: 'BACKUP_PRIVILEGIOS_B1_VERIFICACAO_BLOQUEADA',
  CONCESSAO_APLICADA: 'BACKUP_PRIVILEGIOS_B1_CONCESSAO_APLICADA',
  CONCESSAO_FALHOU: 'BACKUP_PRIVILEGIOS_B1_CONCESSAO_FALHOU',
});
const FILTRO_RELACOES = `n.nspname = 'public' AND c.relkind IN (${RELKINDS})`;
const CONSULTAS = Object.freeze({
  IDENTIDADE: 'SELECT current_user::text AS usuario, session_user::text AS sessao, current_database()::text AS banco',
  PAPEL: 'SELECT r.rolconnlimit AS limite FROM pg_roles r WHERE r.rolname = $1::name',
  TOTAL: `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${FILTRO_RELACOES}`,
  PENDENTES: `SELECT c.relname::text AS nome, c.relkind::text AS tipo, count(*) OVER ()::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${FILTRO_RELACOES} AND NOT has_table_privilege($1::name, c.oid, 'SELECT') ORDER BY c.relname LIMIT ${LIMITE_LISTADO}`,
  ESQUEMAS: "SELECT n.nspname::text AS nome FROM pg_namespace n WHERE n.nspname NOT IN ('public', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY n.nspname LIMIT 21",
  ACESSO: "SELECT has_schema_privilege($1::name, 'public', 'USAGE') AS usage_public, has_database_privilege($1::name, current_database(), 'CONNECT') AS connect",
  PROPRIETARIOS: `SELECT pg_get_userbyid(c.relowner)::text AS dono, count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${FILTRO_RELACOES} GROUP BY 1 ORDER BY 1`,
});
const SQL_LEITURA = /^\s*SELECT\b[^;]*$/i;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalida = (codigo) => Object.assign(new TypeError('configuração dos privilégios B-1 inválida'), { code: codigo });

function exigirPapel(papel) {
  if (typeof papel !== 'string' || !RE_PAPEL.test(papel)) throw invalida('PRIVILEGIOS_B1_PAPEL_INVALIDO');
  return papel;
}
function exigirExecutor(executor) {
  if (!ehObjeto(executor) || typeof executor.query !== 'function') throw invalida('PRIVILEGIOS_B1_EXECUTOR_INVALIDO');
  return executor;
}

/** O SQL de concessão do B-1 (texto idêntico ao do ensaio de 09/11/2026). */
function sqlDeConcessao(papel = PAPEL_PADRAO) {
  exigirPapel(papel);
  return Object.freeze([
    `GRANT USAGE ON SCHEMA public TO ${papel}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${papel}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${papel}`,
  ]);
}

async function lerLinhas(executor, sql, parametros) {
  if (!SQL_LEITURA.test(sql)) throw invalida('PRIVILEGIOS_B1_SQL_NAO_PERMITIDO');
  const r = parametros === undefined ? await executor.query(sql) : await executor.query(sql, parametros);
  if (!ehObjeto(r) || !Array.isArray(r.rows) || !r.rows.every(ehObjeto)) throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA');
  return r.rows;
}
const exatamenteUma = (linhas) => { if (linhas.length !== 1) throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA'); return linhas[0]; };
const texto = (v) => { if (typeof v !== 'string' || v === '') throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA'); return v; };
const inteiro = (v) => { if (!Number.isInteger(v) || v < 0) throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA'); return v; };
const booleano = (v) => { if (typeof v !== 'boolean') throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA'); return v; };

function criarVerificadorDePrivilegios(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['executorDeBanco', 'papel', 'exigirIdentidade'].includes(k))) throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const executor = exigirExecutor(opcoes.executorDeBanco);
  const papel = exigirPapel(opcoes.papel ?? PAPEL_PADRAO);
  const exigirIdentidade = opcoes.exigirIdentidade !== false;

  async function verificar() {
    try {
      const id = exatamenteUma(await lerLinhas(executor, CONSULTAS.IDENTIDADE));
      const identidade = Object.freeze({ usuario: texto(id.usuario), sessao: texto(id.sessao) });
      const banco = texto(id.banco);
      const motivos = [];
      if (exigirIdentidade && (identidade.usuario !== papel || identidade.sessao !== papel)) motivos.push('IDENTIDADE_DIFERENTE_DO_PAPEL');
      const existentes = await lerLinhas(executor, CONSULTAS.PAPEL, [papel]);
      if (existentes.length === 0) {
        motivos.push('PAPEL_INEXISTENTE');
        return resultado({ papel, banco, identidade, motivos, totalRelacoes: 0, pendentes: { total: 0, itens: [], truncado: false }, esquemas: [], usage: false, connect: false, limite: null });
      }
      const limite = exatamenteUma(existentes).limite;
      if (!Number.isInteger(limite)) throw invalida('PRIVILEGIOS_B1_RESPOSTA_INVALIDA');
      const totalRelacoes = inteiro(exatamenteUma(await lerLinhas(executor, CONSULTAS.TOTAL)).n);
      const linhasPendentes = await lerLinhas(executor, CONSULTAS.PENDENTES, [papel]);
      const itens = linhasPendentes.map((l) => Object.freeze({ nome: texto(l.nome), tipo: texto(l.tipo) }));
      const totalPendentes = linhasPendentes.length === 0 ? 0 : inteiro(linhasPendentes[0].total);
      const esquemas = (await lerLinhas(executor, CONSULTAS.ESQUEMAS)).map((l) => texto(l.nome));
      const acesso = exatamenteUma(await lerLinhas(executor, CONSULTAS.ACESSO, [papel]));
      const usage = booleano(acesso.usage_public);
      const connect = booleano(acesso.connect);
      if (totalRelacoes === 0) motivos.push('SEM_OBJETOS_EM_PUBLIC');
      if (totalPendentes > 0) motivos.push('OBJETOS_SEM_CONCESSAO');
      if (esquemas.length > 0) motivos.push('ESQUEMA_NAO_COBERTO');
      if (!usage) motivos.push('SEM_USAGE_EM_PUBLIC');
      if (!connect) motivos.push('SEM_CONNECT_NO_BANCO');
      return resultado({ papel, banco, identidade, motivos, totalRelacoes, pendentes: { total: totalPendentes, itens, truncado: totalPendentes > itens.length }, esquemas, usage, connect, limite });
    } catch {
      return Object.freeze({ ok: false, motivos: Object.freeze(['VERIFICACAO_FALHOU']), papel, banco: null, identidade: null, totalRelacoes: null, pendentes: Object.freeze({ total: null, itens: Object.freeze([]), truncado: false }), esquemasNaoCobertos: Object.freeze([]), usageEmPublic: null, connect: null, avisos: Object.freeze([]) });
    }
  }
  return Object.freeze({ verificar });
}

function resultado({ papel, banco, identidade, motivos, totalRelacoes, pendentes, esquemas, usage, connect, limite }) {
  const avisos = [];
  if (limite !== null && limite !== -1 && limite < CONNECTION_LIMIT_REFERENCIA) avisos.push(`CONNECTION_LIMIT_${limite}_ABAIXO_DA_REFERENCIA_${CONNECTION_LIMIT_REFERENCIA}`);
  return Object.freeze({
    ok: motivos.length === 0, motivos: Object.freeze([...motivos]), papel, banco, identidade, totalRelacoes,
    pendentes: Object.freeze({ total: pendentes.total, itens: Object.freeze([...pendentes.itens]), truncado: pendentes.truncado }),
    esquemasNaoCobertos: Object.freeze([...esquemas]), usageEmPublic: usage, connect, avisos: Object.freeze(avisos),
  });
}

function criarRegistradorDeAuditoria(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['executorDeAuditoria', 'registrarEventoSistema', 'gerarId'].includes(k))) throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const executor = exigirExecutor(opcoes.executorDeAuditoria);
  if (typeof opcoes.registrarEventoSistema !== 'function') throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const gerarId = opcoes.gerarId ?? (() => crypto.randomBytes(16).toString('hex'));
  async function registrar({ tipo, resultado: r, executor: executorDaConcessao = null, motivo = null }) {
    try {
      const acao = tipo === 'CONCESSAO' ? (r.ok ? ACOES.CONCESSAO_APLICADA : ACOES.CONCESSAO_FALHOU) : (r.ok ? ACOES.VERIFICACAO_OK : ACOES.VERIFICACAO_BLOQUEADA);
      const referencia = gerarId();
      const contexto = {
        papel: r.papel, banco: r.banco, ok: r.ok, motivos: [...r.motivos], usuario: r.identidade?.usuario ?? null, sessao: r.identidade?.sessao ?? null,
        pendentesTotal: r.pendentes.total, pendentes: r.pendentes.itens.slice(0, LIMITE_NO_AUDITORIA).map((p) => p.nome), esquemasNaoCobertos: [...r.esquemasNaoCobertos], avisos: [...r.avisos],
        ...(executorDaConcessao === null ? {} : { executorDaConcessao }), ...(motivo === null ? {} : { motivoDoBloqueio: motivo }),
      };
      await opcoes.registrarEventoSistema(executor, { acao, referencia, descricao: `Privilégios B-1: ${tipo === 'CONCESSAO' ? 'concessão' : 'verificação'} ${r.ok ? 'concluída' : 'bloqueada'}`, contexto });
      return Object.freeze({ gravado: true, referencia, acao });
    } catch {
      return Object.freeze({ gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' });
    }
  }
  return Object.freeze({ registrar });
}

function criarPreVerificacaoDaCoordenacao(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['coordenacao', 'verificador', 'auditoria'].includes(k))) throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const { coordenacao, verificador, auditoria } = opcoes;
  if (!ehObjeto(coordenacao) || typeof coordenacao.adquirir !== 'function' || !ehObjeto(verificador) || typeof verificador.verificar !== 'function' || !ehObjeto(auditoria) || typeof auditoria.registrar !== 'function') throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  async function adquirir(pedido) {
    if (!ehObjeto(pedido) || pedido.operacao !== 'BACKUP') return coordenacao.adquirir(pedido);
    let r;
    try { r = await verificador.verificar(); } catch { r = null; }
    if (!ehObjeto(r) || typeof r.ok !== 'boolean') return Object.freeze({ ok: false, motivo: 'PRIVILEGIOS_B1_NAO_VERIFICADOS', operacao: 'BACKUP' });
    await auditoria.registrar({ tipo: 'VERIFICACAO', resultado: r });
    if (r.ok !== true) return Object.freeze({ ok: false, motivo: Array.isArray(r.motivos) && r.motivos.includes('VERIFICACAO_FALHOU') ? 'PRIVILEGIOS_B1_NAO_VERIFICADOS' : 'PRIVILEGIOS_B1_PENDENTES', operacao: 'BACKUP' });
    return coordenacao.adquirir(pedido);
  }
  return Object.freeze({ adquirir });
}

function criarAplicadorDeConcessoes(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['executorDeBanco', 'papel', 'auditoria'].includes(k))) throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const executor = exigirExecutor(opcoes.executorDeBanco);
  const papel = exigirPapel(opcoes.papel ?? PAPEL_PADRAO);
  const { auditoria } = opcoes;
  if (!ehObjeto(auditoria) || typeof auditoria.registrar !== 'function') throw invalida('PRIVILEGIOS_B1_CONFIGURACAO_INVALIDA');
  const concessoes = sqlDeConcessao(papel);
  const permitidos = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', ...concessoes]);
  const escrever = async (sql) => { if (!permitidos.has(sql)) throw invalida('PRIVILEGIOS_B1_SQL_NAO_PERMITIDO'); return executor.query(sql); };
  const verificador = criarVerificadorDePrivilegios({ executorDeBanco: executor, papel, exigirIdentidade: false });

  async function identificarProprietarios() {
    const id = exatamenteUma(await lerLinhas(executor, CONSULTAS.IDENTIDADE));
    const donos = (await lerLinhas(executor, CONSULTAS.PROPRIETARIOS)).map((l) => Object.freeze({ dono: texto(l.dono), relacoes: inteiro(l.n) }));
    return Object.freeze({ executor: texto(id.usuario), sessao: texto(id.sessao), banco: texto(id.banco), donos: Object.freeze(donos) });
  }
  const falha = (motivo, extra = {}) => Object.freeze({ ok: false, aplicado: false, motivo, ...extra });

  async function registrarFalha(motivo, executorDaConcessao, verificacao = null) {
    const base = verificacao ?? { ok: false, motivos: [motivo], papel, banco: null, identidade: null, pendentes: { total: null, itens: [] }, esquemasNaoCobertos: [], avisos: [] };
    const reg = await auditoria.registrar({ tipo: 'CONCESSAO', resultado: { ...base, ok: false, motivos: [...new Set([motivo, ...base.motivos])] }, executor: executorDaConcessao, motivo });
    return Object.freeze({ gravado: reg.gravado });
  }

  async function aplicar() {
    let dono;
    try { dono = await identificarProprietarios(); } catch { return falha('PROPRIETARIO_NAO_IDENTIFICADO'); }
    const quem = dono.executor;
    const recusar = async (motivo) => Object.freeze({ ...falha(motivo, { executor: quem, donos: dono.donos.map((d) => d.dono) }), auditoria: await registrarFalha(motivo, quem) });
    if (quem === papel || dono.sessao === papel) return recusar('EXECUTOR_E_O_PAPEL_DE_BACKUP');
    if (dono.donos.length === 0) return recusar('SEM_OBJETOS_EM_PUBLIC');
    if (dono.donos.length !== 1) return recusar('PROPRIETARIO_AMBIGUO');
    if (dono.donos[0].dono !== quem || dono.sessao !== quem) return recusar('EXECUTOR_NAO_E_O_PROPRIETARIO');
    const antes = await verificador.verificar();
    if (antes.motivos.includes('PAPEL_INEXISTENTE') || antes.motivos.includes('VERIFICACAO_FALHOU')) return recusar(antes.motivos.includes('PAPEL_INEXISTENTE') ? 'PAPEL_INEXISTENTE' : 'VERIFICACAO_FALHOU');
    let comecou = false;
    try {
      await escrever('BEGIN'); comecou = true;
      for (const sql of concessoes) await escrever(sql);
      await escrever('COMMIT');
    } catch {
      if (comecou) { try { await escrever('ROLLBACK'); } catch { /* a sessão pode ter caído: a transação some com ela */ } }
      return Object.freeze({ ...falha('CONCESSAO_FALHOU', { executor: quem }), auditoria: await registrarFalha('CONCESSAO_FALHOU', quem, antes) });
    }
    const depois = await verificador.verificar();
    const auditoriaDepois = await auditoria.registrar({ tipo: 'CONCESSAO', resultado: depois, executor: quem });
    return Object.freeze({ ok: depois.ok, aplicado: true, motivo: depois.ok ? null : 'POS_VERIFICACAO_FALHOU', executor: quem, proprietario: dono.donos[0].dono, verificacao: depois, auditoria: Object.freeze({ gravado: auditoriaDepois.gravado }) });
  }
  return Object.freeze({ identificarProprietarios, aplicar });
}

module.exports = {
  PAPEL_PADRAO, CONNECTION_LIMIT_REFERENCIA, ACOES, CONSULTAS, sqlDeConcessao,
  criarVerificadorDePrivilegios, criarRegistradorDeAuditoria, criarPreVerificacaoDaCoordenacao, criarAplicadorDeConcessoes,
};
