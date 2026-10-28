'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recursos = require('../../src/rbac/recursos');
const toggles = require('../../src/rbac/toggles');
const { resumirToggles } = require('../../src/services/permissao-usuario.service');

/**
 * LGPD-1: recursos EXCLUSIVOS do MASTER (decisão A de 27/10/2026): `lgpdEncarregado` (operacional neste pacote) e
 * `lgpdRetencao` (só catálogo e proteção; sem rota, sem toggle, sem provisionamento até o LGPD-3). Nenhum bypass por nome de
 * perfil: o MASTER continua precisando da linha do perfil; a exclusividade é a RECUSA de conceder a outros perfis.
 */
const RAIZ = path.join(__dirname, '..', '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

describe('catálogo: recursos exclusivos do MASTER', () => {
  test('RECURSOS_EXCLUSIVOS_MASTER tem exatamente lgpdEncarregado e lgpdRetencao; os dois são conhecidos; recursoExclusivoMaster decide por nome exato', () => {
    assert.deepEqual([...recursos.RECURSOS_EXCLUSIVOS_MASTER].sort(), ['lgpdEncarregado', 'lgpdRetencao']);
    for (const r of recursos.RECURSOS_EXCLUSIVOS_MASTER) assert.ok(recursos.recursoConhecido(r), r);
    assert.equal(recursos.recursoExclusivoMaster('lgpdEncarregado'), true);
    assert.equal(recursos.recursoExclusivoMaster('lgpdRetencao'), true);
    for (const outro of ['lgpd', 'emailsGestao', 'companyData', 'LGPDENCARREGADO', '', null, undefined]) assert.equal(recursos.recursoExclusivoMaster(outro), false, String(outro));
  });

  test('escopo do MASTER: lgpdEncarregado com visualizar e editar (16 recursos); lgpdRetencao FORA do escopo e de RECURSOS_COM_EFEITO (sem rota ainda); lgpd e emailsGestao inalterados', () => {
    const escopo = Object.fromEntries(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => [r.recurso, [...r.operacoes]]));
    assert.deepEqual(escopo.lgpdEncarregado, ['visualizar', 'editar']);
    assert.equal(escopo.lgpdRetencao, undefined, 'lgpdRetencao só entra no escopo quando tiver rota (LGPD-3)');
    assert.deepEqual(escopo.lgpd, ['visualizar']);
    assert.deepEqual(escopo.emailsGestao, ['visualizar']);
    assert.equal(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.length, 16);
    assert.equal(recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes.length, 9, 'nenhuma ação nova');
    assert.ok(recursos.RECURSOS_COM_EFEITO.some((r) => r.recurso === 'lgpdEncarregado'));
    assert.ok(!recursos.RECURSOS_COM_EFEITO.some((r) => r.recurso === 'lgpdRetencao'));
    assert.equal(recursos.ROTULOS_RECURSOS.lgpdEncarregado, 'LGPD — Encarregado (DPO)');
  });

  test('toggles: lgpdEncarregado existe (ADMINISTRACAO, visualizar+editar, somenteMaster); não há toggle de lgpdRetencao; a retenção está em PENDENCIAS', () => {
    const t = toggles.buscar('lgpdEncarregado');
    assert.ok(t);
    assert.deepEqual([t.grupo, t.regra.tipo, t.regra.recurso, [...t.regra.operacoes], t.somenteMaster], ['ADMINISTRACAO', 'RECURSO', 'lgpdEncarregado', ['visualizar', 'editar'], true]);
    assert.equal(toggles.buscar('lgpdRetencao'), null);
    assert.ok(toggles.PENDENCIAS.some((p) => p.id === 'lgpdRetencao' && p.situacao === 'SEM_ENFORCEMENT'));
    assert.deepEqual(toggles.TOGGLES.filter((x) => x.somenteMaster === true).map((x) => x.id), ['lgpdEncarregado'], 'o único toggle exclusivo');
    for (const id of ['privacidadeLgpd', 'gestaoEmail']) assert.notEqual(toggles.buscar(id).somenteMaster, true, `${id} continua concedível`);
  });

  test('resumirToggles: para alvo não-MASTER o toggle exclusivo não é oferecido; para o MASTER aparece fixo, ligado só com a permissão efetiva da linha do perfil', () => {
    const completo = (perfil, efetivo) => ({
      usuario: { id: 5, nome: 'X', perfil, ativo: true },
      podeAlterar: true,
      motivoSomenteLeitura: null,
      grupo: null,
      recursos: recursos.RECURSOS_COM_EFEITO.map((r) => ({
        recurso: r.recurso,
        operacoes: Object.fromEntries(r.operacoes.map((op) => [op, { efetivo: r.recurso === 'lgpdEncarregado' ? efetivo : false, perfil: false, grupo: null, individual: null, origem: 'perfil' }])),
      })),
      acoes: [],
      resumoIndividual: { recursos: 0, autorizacoes: 0, bloqueios: 0 },
    });
    const usuario = resumirToggles(completo('USUARIO', true));
    assert.equal(usuario.toggles.some((t) => t.id === 'lgpdEncarregado'), false);
    assert.ok(usuario.toggles.some((t) => t.id === 'privacidadeLgpd'), 'os demais continuam');
    const masterSem = resumirToggles(completo('MASTER', false));
    const masterCom = resumirToggles(completo('MASTER', true));
    assert.deepEqual([masterSem.toggles.find((t) => t.id === 'lgpdEncarregado').ligado, masterSem.toggles.find((t) => t.id === 'lgpdEncarregado').fixo], [false, true]);
    assert.deepEqual([masterCom.toggles.find((t) => t.id === 'lgpdEncarregado').ligado, masterCom.toggles.find((t) => t.id === 'lgpdEncarregado').fixo], [true, true]);
  });

  test('rota do encarregado: só GET e POST, cada um exigindo lgpdEncarregado por criarExigirPermissaoRecurso com RECURSO literal; nenhum verbo de exclusão', () => {
    const fonte = ler('src/routes/lgpd-encarregado.routes.js');
    assert.match(fonte, /const RECURSO = 'lgpdEncarregado'/);
    assert.match(fonte, /criarExigirPermissaoRecurso\(\{ pool: poolInjetado \}, RECURSO, 'visualizar'\)/);
    assert.match(fonte, /criarExigirPermissaoRecurso\(\{ pool: poolInjetado \}, RECURSO, 'editar'\)/);
    assert.equal(/router\.(put|patch|delete)\(/.test(fonte), false);
    assert.ok((fonte.match(/router\.post\(/g) || []).length >= 4, 'designar, substituir, contato, encerrar');
    assert.ok((fonte.match(/router\.get\(/g) || []).length >= 2, 'vigentes e histórico');
  });

  test('migrations 094 (tabela) e 095 (CNPJ do PJ, a última) existem, estão no manifesto e não tocam as colunas legadas de empresas; a 095 é só aditiva', () => {
    const arquivos = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const ultima = arquivos[arquivos.length - 1];
    assert.match(ultima, /^095_alter_lgpd_encarregados_add_cnpj\.sql$/);
    const a094 = arquivos.find((f) => f.startsWith('094_'));
    assert.equal(a094, '094_create_lgpd_encarregados.sql');
    const sql094 = ler(`migrations/${a094}`);
    assert.match(sql094, /CREATE TABLE lgpd_encarregados/);
    assert.match(sql094, /CREATE UNIQUE INDEX[\s\S]*WHERE fim_em IS NULL/, 'um vigente por função e empresa');
    const sql095 = ler(`migrations/${ultima}`);
    const semComentarios = (s) => s.replace(/^\s*--.*$/gm, '');
    for (const sql of [sql094, sql095]) assert.doesNotMatch(semComentarios(sql), /ALTER TABLE empresas|UPDATE empresas|dpo_nome|dpo_email|dpo_tel/, 'colunas legadas intocadas: nada migrado, nada apagado (só o comentário as cita)');
    assert.match(sql095, /ADD COLUMN cnpj CHAR\(14\)/);
    assert.match(sql095, /chk_lgpd_encarregados_cnpj_formato CHECK \(cnpj IS NULL OR cnpj ~ '\^\[0-9A-Z\]\{12\}\[0-9\]\{2\}\$'\)/, 'mesmo formato canônico de empresas.cnpj (016)');
    assert.match(sql095, /chk_lgpd_encarregados_cnpj_pf CHECK \(tipo_pessoa = 'PJ' OR cnpj IS NULL\)/);
    assert.match(sql095, /OR NEW\.cnpj IS DISTINCT FROM OLD\.cnpj/, 'o CNPJ entra na lista de dados imutáveis do gatilho');
    assert.match(sql095, /ADD COLUMN cnpj CHAR\(14\);/, 'coluna nula, sem default');
    assert.doesNotMatch(semComentarios(sql095), /UPDATE lgpd_encarregados|DELETE FROM|DROP TABLE|DROP COLUMN|UNIQUE|cnpj CHAR\(14\) NOT NULL/, 'aditiva: sem backfill, sem obrigatoriedade no banco, sem unicidade');
    const manifesto = JSON.parse(ler('migrations/checksums.json'));
    for (const nome of [a094, ultima]) assert.ok(Object.hasOwn(manifesto.migrations ?? manifesto, nome), `manifesto com ${nome}`);
  });
});
