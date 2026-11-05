'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../src/services/backup-armazenamento-duravel-fichas.service');
const { fichaDeTeste, fichaEntreContas, registro, registroDeTeste, clonar } = require('../helpers/fichas-duraveis');

/** R-D45 [REG]: ficha de destino durável — formato literal, separação HML/PROD, sem configuração arbitrária. Dados 100% sintéticos. */

const motivoDe = (r) => { try { F.validarRegistroDuravel(r); return null; } catch (e) { assert.equal(e.code, 'REGISTRO_DURAVEL_INVALIDO'); return e.motivo; } };
const variar = (ambiente, mutar) => { const f = fichaDeTeste(ambiente); mutar(f); return registro(f); };

describe('[REG] validação do registro e das fichas', () => {
  test('REG-01 — registros válidos: vazio, só HML, HML+PROD e ficha entre contas; recusa não-array e registro não congelado', () => {
    for (const r of [registro(), registro(fichaDeTeste('HOMOLOGACAO')), registroDeTeste(), registro(fichaEntreContas())]) assert.equal(motivoDe(r), null);
    assert.equal(motivoDe({}), 'REGISTRO_FORMATO');
    assert.equal(motivoDe(null), 'REGISTRO_FORMATO');
    assert.equal(motivoDe([fichaDeTeste()]), 'REGISTRO_NAO_CONGELADO');
    assert.equal(motivoDe(Object.freeze([fichaDeTeste()])), 'REGISTRO_NAO_CONGELADO');
  });

  test('REG-02 — o formato antigo (texto simples) e fichas incompletas ou com campo extra são recusados', () => {
    assert.equal(motivoDe(Object.freeze(['hml-s3-principal'])), 'FICHA_FORMATO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.extra = 1; })), 'FICHA_FORMATO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { delete f.retencao; })), 'FICHA_FORMATO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.identidades.extra = {}; })), 'FICHA_FORMATO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.retencao.extra = 1; })), 'FICHA_FORMATO');
  });

  test('REG-03 — identificador, ambiente, tipo, região e conta com formato inválido', () => {
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.id = 'ID Invalido!'; })), 'ID_INVALIDO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.ambiente = 'CI'; })), 'AMBIENTE_INVALIDO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.tipo = 'GCS'; })), 'TIPO_INVALIDO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.regiao = 'Virginia'; })), 'REGIAO_INVALIDA');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.contaId = '12345'; })), 'CONTA_INVALIDA');
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), fichaDeTeste('HOMOLOGACAO'))), 'ID_DUPLICADO');
  });

  test('REG-04 — o nome do bucket e o prefixo seguem o padrão do ambiente e da conta; nada arbitrário', () => {
    const ruins = ['meu-bucket', 'safework-prod-backup-111111111111', 'safework-hml-backup-999999999999', 'SAFEWORK-HML-BACKUP-111111111111', 'safework-hml-backup-111111111111-extra', 'safework-hml-backup-1111111111'];
    for (const b of ruins) assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.bucket = b; })), 'BUCKET_FORA_DO_PADRAO', b);
    for (const p of ['prod/', 'hml', 'hml/x/', '/hml/', '']) assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.prefixo = p; })), 'PREFIXO_FORA_DO_PADRAO', p);
    assert.equal(motivoDe(variar('PRODUCAO', (f) => { f.bucket = 'safework-hml-backup-222222222222'; })), 'BUCKET_FORA_DO_PADRAO');
  });

  test('REG-05 — chaves KMS: só ARN completo de chave (nunca alias), mesma região, duas chaves distintas, nenhuma repetida entre fichas', () => {
    for (const c of ['alias/safework-mac', 'arn:aws:kms:us-east-1:111111111111:alias/x', 'arn:aws-cn:kms:us-east-1:111111111111:key/11111111-1111-4111-8111-111111111111', 'arn:aws:kms:us-east-1:111111111111:key/nao-e-uuid', '']) {
      assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.chaveMac = c; })), 'CHAVE_KMS_INVALIDA', c);
    }
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.chaveCifra = 'arn:aws:kms:sa-east-1:111111111111:key/22222222-2222-4222-8222-222222222222'; })), 'CHAVE_KMS_REGIAO_DIVERGENTE');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.chaveCifra = f.chaveMac; })), 'CHAVES_KMS_NAO_SEPARADAS');
    const prod = fichaDeTeste('PRODUCAO');
    prod.chaveMac = fichaDeTeste('HOMOLOGACAO').chaveMac.replace('111111111111', '222222222222');
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), prod)), null, 'mesmo UUID em contas diferentes são chaves diferentes');
    const repetida = fichaDeTeste('PRODUCAO');
    repetida.chaveCifra = fichaDeTeste('HOMOLOGACAO').chaveCifra;
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), repetida)), 'CHAVE_KMS_COMPARTILHADA');
  });

  test('REG-06 — retenção: modo e dias válidos; produção exige COMPLIANCE', () => {
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.retencao.modo = 'NENHUM'; })), 'RETENCAO_INVALIDA');
    for (const d of [0, -1, 1.5, 3651, '7', null]) assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.retencao.dias = d; })), 'RETENCAO_INVALIDA', String(d));
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.retencao = { modo: 'COMPLIANCE', dias: 3650 }; })), null);
    assert.equal(motivoDe(variar('PRODUCAO', (f) => { f.retencao = { modo: 'GOVERNANCE', dias: 30 }; })), 'RETENCAO_INVALIDA');
  });

  test('REG-07 — identidades: três papéis distintos, formato válido, nenhum principal repetido entre fichas', () => {
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { delete f.identidades.restauracao; })), 'FICHA_FORMATO');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.identidades.publicador.tipo = 'group'; })), 'IDENTIDADE_INVALIDA');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.identidades.publicador.nome = 'tem espaço'; })), 'IDENTIDADE_INVALIDA');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.identidades.verificador.contaId = 'abc'; })), 'IDENTIDADE_INVALIDA');
    assert.equal(motivoDe(variar('HOMOLOGACAO', (f) => { f.identidades.verificador = { ...f.identidades.publicador }; })), 'IDENTIDADES_NAO_SEPARADAS');
    const prod = fichaDeTeste('PRODUCAO');
    prod.identidades.publicador = { ...fichaDeTeste('HOMOLOGACAO').identidades.publicador };
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), prod)), 'IDENTIDADE_COMPARTILHADA');
  });

  test('REG-08 — HML e PROD não compartilham conta; um bucket nunca aparece em dois ambientes', () => {
    const prod = fichaDeTeste('PRODUCAO');
    prod.contaId = '111111111111';
    prod.bucket = 'safework-prod-backup-111111111111';
    prod.chaveMac = prod.chaveMac.replace('222222222222', '111111111111');
    prod.chaveCifra = prod.chaveCifra.replace('222222222222', '111111111111');
    prod.identidades = Object.fromEntries(Object.entries(prod.identidades).map(([k, v]) => [k, { ...v, contaId: '111111111111' }]));
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), prod)), 'CONTA_COMPARTILHADA_ENTRE_AMBIENTES');
    const hmlDuplicado = fichaDeTeste('HOMOLOGACAO');
    hmlDuplicado.id = 'hml-s3-secundario';
    assert.equal(motivoDe(registro(fichaDeTeste('HOMOLOGACAO'), hmlDuplicado)), 'BUCKET_DUPLICADO');
  });
});

describe('[REG] localização única', () => {
  const lista = registroDeTeste();
  test('REG-09 — localiza por id e ambiente; id desconhecido, inválido e ambiente divergente têm motivos fixos', () => {
    const achada = F.localizarFicha(lista, 'hml-s3-principal', 'HOMOLOGACAO');
    assert.equal(achada.encontrada, true);
    assert.equal(achada.ficha.bucket, 'safework-hml-backup-111111111111');
    assert.equal(F.localizarFicha(lista, 'hml-s3-principal', undefined).encontrada, true, 'sem ambiente, localiza só pelo id');
    assert.deepEqual({ ...F.localizarFicha(lista, 'prod-s3-principal', 'HOMOLOGACAO') }, { encontrada: false, motivo: 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE' });
    assert.deepEqual({ ...F.localizarFicha(lista, 'nao-existe', 'HOMOLOGACAO') }, { encontrada: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
    for (const id of [undefined, null, 7, {}, 'Maiúscula', '']) assert.deepEqual({ ...F.localizarFicha(lista, id, 'HOMOLOGACAO') }, { encontrada: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
    assert.deepEqual({ ...F.localizarFicha(lista, 'hml-s3-principal', 'CI') }, { encontrada: false, motivo: 'AMBIENTE_INVALIDO' });
  });

  test('REG-10 — a identidade esperada é montada da ficha: usuário por ARN exato, papel por prefixo de sessão; conta diferente nunca confere', () => {
    const f = fichaEntreContas();
    const user = { contaId: '111111111111', tipo: 'user', nome: 'safework-hml-verificador' };
    assert.equal(F.identidadeConfere(user, { contaId: '111111111111', arn: 'arn:aws:iam::111111111111:user/safework-hml-verificador' }), true);
    assert.equal(F.identidadeConfere(user, { contaId: '111111111111', arn: 'arn:aws:iam::111111111111:user/outro' }), false);
    assert.equal(F.identidadeConfere(user, { contaId: '999999999999', arn: 'arn:aws:iam::999999999999:user/safework-hml-verificador' }), false);
    assert.equal(F.identidadeConfere(user, { contaId: '111111111111', arn: 'arn:aws:iam::999999999999:user/safework-hml-verificador' }), false, 'conta do ARN diferente da conta declarada');
    const papel = f.identidades.publicador;
    assert.equal(F.identidadeConfere(papel, { contaId: '333333333333', arn: 'arn:aws:sts::333333333333:assumed-role/safework-hml-publicador-externo/sessao-1' }), true);
    assert.equal(F.identidadeConfere(papel, { contaId: '333333333333', arn: 'arn:aws:sts::333333333333:assumed-role/safework-hml-publicador-externo-x/sessao-1' }), false);
    assert.equal(F.identidadeConfere(papel, { contaId: '333333333333', arn: 'arn:aws:iam::333333333333:user/safework-hml-publicador-externo' }), false);
    assert.equal(F.identidadeConfere(papel, null), false);
    assert.equal(F.identidadeConfere(papel, { contaId: '333333333333' }), false);
  });

  test('REG-11 — a ficha validada é a que a função devolve (congelada) e clonar não a contamina', () => {
    const copia = clonar(lista[0]);
    copia.bucket = 'qualquer';
    assert.equal(Object.isFrozen(lista[0]), true);
    assert.equal(F.localizarFicha(lista, 'hml-s3-principal', 'HOMOLOGACAO').ficha.bucket, 'safework-hml-backup-111111111111');
  });
});
