'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Pol = require('../../src/services/backup-executor-politica.service');
const { fichaDeTeste, registro } = require('../helpers/fichas-duraveis');

/**
 * D-ORF-6, executor operacional [POL]: portões (modo, ação, ambiente, confirmação, processo, destino durável, chaves, SDK, destino local). Função pura: devolve TODOS os bloqueios
 * de uma vez, sem curto-circuito, só com códigos fixos. `OPERACAO_HABILITADA` é constante do código (nunca ambiente ou argumento) e continua falsa.
 */

const reg = registro(fichaDeTeste('HOMOLOGACAO'), fichaDeTeste('PRODUCAO'));
const OK = () => ({
  modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', confirmacao: Pol.FRASES.ENSAIO.BACKUP, registro: reg,
  fatos: { sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', destinoLocal: 'AUTORIZADO', uid: 501, umask: 0o077 },
});
const com = (mudancas, fatos = {}) => { const e = OK(); Object.assign(e, mudancas); Object.assign(e.fatos, fatos); return e; };
const bloqueios = (e) => [...Pol.avaliarPortoes(e).bloqueios];
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const emProducao = (fn) => { const anterior = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; try { return fn(); } finally { process.env.NODE_ENV = anterior; } };

describe('[POL] constantes e forma', () => {
  test('POL-01 — a operação real NÃO está habilitada; modos, ações e códigos são fechados; as frases de confirmação são distintas por modo e ação', () => {
    assert.equal(Pol.OPERACAO_HABILITADA, false);
    assert.deepEqual([...Pol.MODOS], ['ENSAIO', 'OPERACAO']);
    assert.deepEqual([...Pol.ACOES], ['BACKUP', 'RESTAURACAO', 'VERIFICACAO_DESTINO']);
    const frases = [...Object.values(Pol.FRASES.ENSAIO), ...Object.values(Pol.FRASES.OPERACAO)];
    assert.equal(frases.length, 6);
    assert.equal(new Set(frases).size, 6);
    for (const f of frases) assert.match(f, /^[A-Z_]{10,60}$/);
    assert.ok(Object.isFrozen(Pol.BLOQUEIOS) && Object.isFrozen(Pol.FRASES) && Object.isFrozen(Pol.FRASES.ENSAIO));
    assert.ok(Pol.BLOQUEIOS.length >= 12 && Pol.BLOQUEIOS.every((c) => /^[A-Z_]{5,45}$/.test(c)));
  });

  test('POL-02 — entrada fora do formato é erro de programação (CONFIGURACAO_INVALIDA), nunca um bloqueio; o resultado é congelado e sem texto livre', () => {
    for (const ruim of [undefined, null, [], { ...OK(), extra: 1 }, { ...OK(), fatos: { ...OK().fatos, extra: 1 } }, { ...OK(), fatos: null }, { ...OK(), fatos: { ...OK().fatos, uid: '501' } },
      { ...OK(), fatos: { ...OK().fatos, sdk: 'QUALQUER' } }, { ...OK(), fatos: { ...OK().fatos, chavesOrigem: 'X' } }, { ...OK(), fatos: { ...OK().fatos, destinoLocal: 'X' } }, { ...OK(), destinoId: 5 }, { ...OK(), confirmacao: 5 }]) {
      assert.equal(codigo(() => Pol.avaliarPortoes(ruim)), 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim)?.slice(0, 80));
    }
    const r = Pol.avaliarPortoes(OK());
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.bloqueios));
    assert.deepEqual(Object.keys(r).sort(), ['bloqueios', 'permitido']);
  });
});

describe('[POL] o ensaio permitido e cada portão sozinho', () => {
  test('POL-03 — ensaio de homologação com tudo em ordem (destino de teste, chaves de teste, SDK simulado, confirmação correta, usuário comum, umask 077): permitido, sem bloqueios', () => {
    assert.deepEqual(Pol.avaliarPortoes(OK()), { permitido: true, bloqueios: [] });
    for (const acao of Pol.ACOES) {
      const e = com({ acao, confirmacao: Pol.FRASES.ENSAIO[acao] }, acao === 'VERIFICACAO_DESTINO' ? { destinoLocal: 'NAO_APLICA' } : {});
      assert.deepEqual(bloqueios(e), [], acao);
    }
  });

  test('POL-04 — modo, ação e ambiente inválidos; confirmação ausente, de outro modo ou de outra ação', () => {
    assert.deepEqual(bloqueios(com({ modo: 'DIAGNOSTICO' })), ['MODO_INVALIDO']);
    assert.ok(bloqueios(com({ acao: 'LIMPEZA' })).includes('ACAO_INVALIDA'));
    assert.ok(bloqueios(com({ ambiente: 'DESENVOLVIMENTO' })).includes('AMBIENTE_INVALIDO'));
    assert.deepEqual(bloqueios(com({ confirmacao: null })), ['CONFIRMACAO_AUSENTE_OU_INVALIDA']);
    assert.deepEqual(bloqueios(com({ confirmacao: '' })), ['CONFIRMACAO_AUSENTE_OU_INVALIDA']);
    assert.deepEqual(bloqueios(com({ confirmacao: Pol.FRASES.OPERACAO.BACKUP })), ['CONFIRMACAO_AUSENTE_OU_INVALIDA']);
    assert.deepEqual(bloqueios(com({ confirmacao: Pol.FRASES.ENSAIO.RESTAURACAO })), ['CONFIRMACAO_AUSENTE_OU_INVALIDA']);
    assert.deepEqual(bloqueios(com({ confirmacao: `${Pol.FRASES.ENSAIO.BACKUP} ` })), ['CONFIRMACAO_AUSENTE_OU_INVALIDA']);
  });

  test('POL-05 — ensaio em produção é proibido; a operação real está bloqueada mesmo com TUDO em ordem (constante do código)', () => {
    const prod = com({ ambiente: 'PRODUCAO', destinoId: 'prod-s3-principal' });
    assert.deepEqual(bloqueios(prod), ['ENSAIO_EM_PRODUCAO_PROIBIDO']);
    const real = com({ modo: 'OPERACAO', confirmacao: Pol.FRASES.OPERACAO.BACKUP });
    assert.ok(bloqueios(real).includes('OPERACAO_NAO_HABILITADA'));
    const realProd = com({ modo: 'OPERACAO', ambiente: 'PRODUCAO', destinoId: 'prod-s3-principal', confirmacao: Pol.FRASES.OPERACAO.BACKUP }, { chavesOrigem: 'OPERACIONAL', sdk: 'APROVADO' });
    assert.ok(bloqueios(realProd).includes('OPERACAO_NAO_HABILITADA'));
    assert.equal(Pol.avaliarPortoes(realProd).permitido, false);
  });

  test('POL-06 — processo: usuário root e umask permissiva bloqueiam (e usuário/umask desconhecidos também); o dono comum com umask 077 ou mais restritiva passa', () => {
    assert.deepEqual(bloqueios(com({}, { uid: 0 })), ['USUARIO_ROOT']);
    assert.deepEqual(bloqueios(com({}, { uid: null })), ['USUARIO_NAO_IDENTIFICADO']);
    assert.deepEqual(bloqueios(com({}, { umask: 0o022 })), ['UMASK_PERMISSIVA']);
    assert.deepEqual(bloqueios(com({}, { umask: 0o027 })), ['UMASK_PERMISSIVA']);
    assert.deepEqual(bloqueios(com({}, { umask: null })), ['UMASK_PERMISSIVA']);
    assert.deepEqual(bloqueios(com({}, { umask: 0o177 })), []);
    assert.deepEqual(bloqueios(com({}, { umask: 0o777 })), []);
  });

  test('POL-07 — destino durável: ausente da lista, de outro ambiente ou de outro id bloqueia; a ficha de teste só vale em NODE_ENV=test', () => {
    assert.deepEqual(bloqueios(com({ destinoId: 'nao-existe' })), ['DESTINO_DURAVEL_NAO_APROVADO']);
    assert.deepEqual(bloqueios(com({ destinoId: 'prod-s3-principal' })), ['DESTINO_DURAVEL_NAO_APROVADO']);
    assert.deepEqual(bloqueios(com({ destinoId: 'ID_INVALIDO!' })), ['DESTINO_DURAVEL_NAO_APROVADO']);
    const sem = OK();
    delete sem.registro;
    emProducao(() => assert.ok(Pol.avaliarPortoes(sem).bloqueios.includes('DESTINO_DURAVEL_NAO_APROVADO')));
    emProducao(() => assert.equal(codigo(() => Pol.avaliarPortoes(OK())), 'CONFIGURACAO_INVALIDA'), 'lista injetada fora de teste é recusada');
  });

  test('POL-08 — chaves: ausentes bloqueiam; de teste só em NODE_ENV=test; "operacional" sem provedor aprovado na lista é inconsistente e bloqueia', () => {
    assert.deepEqual(bloqueios(com({}, { chavesOrigem: 'AUSENTE' })), ['FONTE_DE_CHAVES_NAO_APROVADA']);
    assert.deepEqual(bloqueios(com({}, { chavesOrigem: 'OPERACIONAL' })), ['FONTE_DE_CHAVES_NAO_APROVADA']);
    const semRegistro = OK();
    delete semRegistro.registro;
    emProducao(() => assert.ok(Pol.avaliarPortoes({ ...semRegistro }).bloqueios.includes('FONTE_DE_CHAVES_NAO_APROVADA')));
  });

  test('POL-09 — SDK: não aprovado bloqueia; simulado só em NODE_ENV=test; aprovado passa (a aprovação é do carregador, não do ambiente)', () => {
    assert.deepEqual(bloqueios(com({}, { sdk: 'NAO_APROVADO' })), ['SDK_NAO_APROVADO']);
    assert.deepEqual(bloqueios(com({}, { sdk: 'APROVADO' })), []);
    const semRegistro = OK();
    delete semRegistro.registro;
    emProducao(() => assert.ok(Pol.avaliarPortoes(semRegistro).bloqueios.includes('PORTAS_SIMULADAS_FORA_DE_TESTE')));
  });

  test('POL-10 — destino local: não autorizado bloqueia backup e restauração; a verificação do destino não exige destino local', () => {
    assert.deepEqual(bloqueios(com({}, { destinoLocal: 'NAO_AUTORIZADO' })), ['DESTINO_LOCAL_NAO_AUTORIZADO']);
    assert.deepEqual(bloqueios(com({}, { destinoLocal: 'NAO_APLICA' })), ['DESTINO_LOCAL_NAO_AUTORIZADO']);
    const restauracao = com({ acao: 'RESTAURACAO', confirmacao: Pol.FRASES.ENSAIO.RESTAURACAO }, { destinoLocal: 'NAO_AUTORIZADO' });
    assert.deepEqual(bloqueios(restauracao), ['DESTINO_LOCAL_NAO_AUTORIZADO']);
    const verificacao = com({ acao: 'VERIFICACAO_DESTINO', confirmacao: Pol.FRASES.ENSAIO.VERIFICACAO_DESTINO }, { destinoLocal: 'NAO_AUTORIZADO' });
    assert.deepEqual(bloqueios(verificacao), [], 'ignorado: a verificação não usa destino local');
  });
});

describe('[POL] processo real (listas vazias): tudo o que falta aparece junto', () => {
  test('POL-11 — num processo que não é de teste, o ensaio fica bloqueado por TODOS os motivos aplicáveis ao mesmo tempo, em ordem estável e sem repetição', () => {
    const real = { modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', confirmacao: Pol.FRASES.ENSAIO.BACKUP, fatos: { sdk: 'NAO_APROVADO', chavesOrigem: 'AUSENTE', destinoLocal: 'NAO_AUTORIZADO', uid: 501, umask: 0o077 } };
    const r = emProducao(() => Pol.avaliarPortoes(real));
    assert.equal(r.permitido, false);
    assert.deepEqual([...r.bloqueios], ['DESTINO_DURAVEL_NAO_APROVADO', 'DESTINO_LOCAL_NAO_AUTORIZADO', 'FONTE_DE_CHAVES_NAO_APROVADA', 'SDK_NAO_APROVADO']);
    assert.equal(new Set(r.bloqueios).size, r.bloqueios.length);
    assert.ok(r.bloqueios.every((c) => Pol.BLOQUEIOS.includes(c)));
  });

  test('POL-12 — as listas reais continuam vazias (nada de destino, chave ou destino local aprovado por este módulo)', () => {
    const { ARMAZENAMENTOS_DURAVEIS_APROVADOS } = require('../../src/services/imagem-backup-durabilidade.service');
    const { PROVEDORES_OPERACIONAIS_APROVADOS } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
    const { PROVEDORES_DE_CIFRA_APROVADOS } = require('../../src/services/backup-fontes-cifra-envelope.service');
    const { DESTINOS_AUTORIZADOS } = require('../../src/services/imagem-backup-destinos.service');
    assert.deepEqual([ARMAZENAMENTOS_DURAVEIS_APROVADOS.length, PROVEDORES_OPERACIONAIS_APROVADOS.length, PROVEDORES_DE_CIFRA_APROVADOS.length, DESTINOS_AUTORIZADOS.HOMOLOGACAO.length, DESTINOS_AUTORIZADOS.PRODUCAO.length], [0, 0, 0, 0, 0]);
  });
});
