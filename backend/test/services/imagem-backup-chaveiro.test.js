'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarFonteDeChaves, criarFonteDeProvedor, criarFonteOperacionalDeChaves, PROVEDORES_OPERACIONAIS_APROVADOS } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarChaveiro, ehChaveiro, verificarContratoDoProvedor } = require('../../src/services/imagem-backup-chaveiro.service');

/** Chaveiro com provedores inteiramente FALSOS (chaves aleatórias em memória). Nenhum provedor real, nenhuma credencial, nenhuma rede. */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const seg = () => crypto.randomBytes(32);
const fonte = (extra = []) => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'hml-k1', segredo: seg() }, { id: 'hml-k2', segredo: seg() }, { id: 'hml-k3', segredo: seg() }, { id: 'hml-rev', segredo: seg(), revogada: true }, { id: 'prd-k1', segredo: seg() }, ...extra] });
const chaveiro = (f = fonte(), historico = [{ id: 'hml-k1', estado: 'ATIVA' }]) => criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: f, historico });
const codigo = (fn, c) => assert.throws(fn, (e) => e.code === c, c);

describe('[CH-A] configuração e estados', () => {
  teste('CH-A01 — configuração estrita: ambiente, fonte reconhecida, exatamente uma ATIVA, ids únicos e do ambiente', () => {
    const f = fonte();
    const ruins = [
      null, {}, { ambiente: 'HOMOLOGACAO', fonte: f }, { ambiente: 'QA', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: { origem: 'OPERACIONAL', obter: () => ({}) }, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'APOSENTADA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }, { id: 'hml-k2', estado: 'ATIVA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }, { id: 'hml-k1', estado: 'APOSENTADA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'prd-k1', estado: 'ATIVA' }] },
      { ambiente: 'PRODUCAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA', extra: 1 }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'TALVEZ' }] },
      { ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }], extra: 1 },
    ];
    for (const ruim of ruins) codigo(() => criarChaveiro(ruim), 'CONFIGURACAO_INVALIDA');
  });

  teste('CH-A02 — chave ATIVA indisponível ou REVOGADA no provedor => falha fechada na criação; provedor que lança também', () => {
    const f = fonte();
    codigo(() => criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-nao-existe', estado: 'ATIVA' }] }), 'CHAVE_ATIVA_INDISPONIVEL');
    codigo(() => criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-rev', estado: 'ATIVA' }] }), 'CHAVE_ATIVA_INDISPONIVEL');
    const quebrado = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter() { throw new Error('provedor fora do ar'); } } });
    codigo(() => criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: quebrado, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] }), 'CHAVE_ATIVA_INDISPONIVEL');
  });

  teste('CH-A03 — origem HERDADA da fonte (nunca declarada); chaveiro de teste não é operacional; a fonte operacional segue bloqueada; nada de segredo em serialização', () => {
    const c = chaveiro();
    assert.deepEqual([c.origem, c.operacional, ehChaveiro(c)], ['TESTE_CONTROLADO', false, true]);
    assert.deepEqual([...PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.throws(() => criarFonteOperacionalDeChaves({ provedor: 'qualquer', adaptador: { obter() { return { situacao: 'ATIVA', segredo: seg() }; } } }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    const texto = JSON.stringify(c) + JSON.stringify(c.historico()) + JSON.stringify(c.fonteParaAssinar());
    assert.equal(/segredo|secret/i.test(texto), false);
    assert.equal(ehChaveiro({ ...c }), false, 'clone não é chaveiro reconhecido');
    assert.equal(ehChaveiro({ ambiente: 'PRODUCAO', operacional: true }), false);
  });
});

describe('[CH-B] uso por estado: assinar, verificar, revogada, desconhecida, ambiente', () => {
  teste('CH-B01 — ATIVA assina e verifica; APOSENTADA só verifica; REVOGADA nunca (mesmo existindo no provedor); desconhecida nunca (mesmo ATIVA no provedor)', () => {
    const f = fonte();
    const c = chaveiro(f, [{ id: 'hml-k1', estado: 'APOSENTADA' }, { id: 'hml-k2', estado: 'ATIVA' }, { id: 'hml-k3', estado: 'REVOGADA' }]);
    assert.deepEqual(c.avaliar('hml-k2', 'ASSINAR'), { permitido: true, motivo: null });
    assert.deepEqual(c.avaliar('hml-k2', 'VERIFICAR'), { permitido: true, motivo: null });
    assert.deepEqual(c.avaliar('hml-k1', 'ASSINAR'), { permitido: false, motivo: 'APOSENTADA_NAO_ASSINA' });
    assert.deepEqual(c.avaliar('hml-k1', 'VERIFICAR'), { permitido: true, motivo: null });
    assert.deepEqual(c.avaliar('hml-k3', 'VERIFICAR'), { permitido: false, motivo: 'REVOGADA' });
    assert.equal(f.obter('hml-k3').situacao, 'ATIVA', 'o provedor ainda guarda a chave revogada');
    assert.deepEqual(c.avaliar('prd-k1', 'VERIFICAR'), { permitido: false, motivo: 'NAO_CADASTRADA' });
    assert.equal(f.obter('prd-k1').situacao, 'ATIVA', 'e responde ATIVA para um id fora do histórico');
    assert.deepEqual(c.avaliar('hml-k2', 'APAGAR'), { permitido: false, motivo: 'USO_INVALIDO' });
    for (const ruim of [undefined, null, 7, '', {}]) assert.equal(c.avaliar(ruim, 'VERIFICAR').permitido, false);
  });

  teste('CH-B02 — fontes DERIVADAS impõem a política antes de entregar o segredo', () => {
    const c = chaveiro(fonte(), [{ id: 'hml-k1', estado: 'APOSENTADA' }, { id: 'hml-k2', estado: 'ATIVA' }, { id: 'hml-k3', estado: 'REVOGADA' }]);
    const assinar = c.fonteParaAssinar();
    const verificar = c.fonteParaVerificar();
    assert.equal(assinar.obter('hml-k2').situacao, 'ATIVA');
    assert.equal(assinar.obter('hml-k1').situacao, 'INDISPONIVEL', 'aposentada não assina');
    assert.equal(verificar.obter('hml-k1').situacao, 'ATIVA', 'aposentada verifica');
    assert.equal(verificar.obter('hml-k3').situacao, 'REVOGADA');
    assert.equal(verificar.obter('prd-k1').situacao, 'INDISPONIVEL');
    assert.equal(assinar.origem, 'TESTE_CONTROLADO');
    assert.equal(c.ehFonteDoChaveiro(assinar) && c.ehFonteDoChaveiro(verificar), true);
    assert.equal(c.ehFonteDoChaveiro({ ...assinar }), false);
    assert.equal(c.fonteParaAssinar(), assinar, 'a mesma derivada (identidade estável)');
  });

  teste('CH-B03 — SEPARAÇÃO DE AMBIENTES: id de produção não entra no chaveiro de homologação (nem pela rotação) e vice-versa', () => {
    const f = fonte();
    const c = chaveiro(f);
    codigo(() => c.planejarRotacao({ novaChaveId: 'prd-k1', idsEmUso: [] }), 'ROTACAO_CHAVE_FORA_DO_AMBIENTE');
    assert.deepEqual(c.avaliar('prd-k1', 'VERIFICAR'), { permitido: false, motivo: 'NAO_CADASTRADA' });
  });
});

describe('[CH-C] rotação e revogação controladas', () => {
  teste('CH-C01 — rotação correta: a antiga vira APOSENTADA (verifica, não assina), a nova assina; o original não muda (imutável)', () => {
    const c1 = chaveiro();
    const c2 = c1.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] });
    assert.deepEqual(c2.historico().map((h) => [h.id, h.estado]), [['hml-k1', 'APOSENTADA'], ['hml-k2', 'ATIVA']]);
    assert.equal(c2.chaveAtivaId(), 'hml-k2');
    assert.equal(c2.avaliar('hml-k1', 'VERIFICAR').permitido, true);
    assert.equal(c2.avaliar('hml-k1', 'ASSINAR').permitido, false);
    assert.equal(c1.chaveAtivaId(), 'hml-k1', 'o chaveiro anterior segue como estava');
    assert.throws(() => { c2.historico()[0].estado = 'ATIVA'; }, TypeError);
  });

  teste('CH-C02 — rotações INCORRETAS recusadas antes de qualquer efeito: nova chave inexistente/revogada, já conhecida, pacote com chave fora do histórico (ORFANARIA), chave antiga sumida do provedor, entrada malformada', () => {
    const c = chaveiro();
    codigo(() => c.planejarRotacao({ novaChaveId: 'hml-inexistente', idsEmUso: [] }), 'ROTACAO_NOVA_CHAVE_INDISPONIVEL');
    codigo(() => c.planejarRotacao({ novaChaveId: 'hml-rev', idsEmUso: [] }), 'ROTACAO_NOVA_CHAVE_INDISPONIVEL');
    codigo(() => c.planejarRotacao({ novaChaveId: 'hml-k1', idsEmUso: [] }), 'ROTACAO_CHAVE_JA_CONHECIDA');
    assert.throws(() => c.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1', 'hml-antiga-esquecida'] }), (e) => e.code === 'ROTACAO_ORFANARIA_PACOTES' && e.chaves.join() === 'hml-antiga-esquecida');
    for (const ruim of [null, {}, { novaChaveId: 'hml-k2' }, { novaChaveId: 'hml-k2', idsEmUso: 'x' }, { novaChaveId: 'hml-k2', idsEmUso: [1] }, { novaChaveId: 'hml-k2', idsEmUso: [], extra: 1 }]) codigo(() => c.planejarRotacao(ruim), 'CONFIGURACAO_INVALIDA');
    // a chave antiga sumiu do provedor (apagada por engano): a rotação deixaria backups irrecuperáveis
    let apagada = false;
    const base = fonte();
    const provedor = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter: (id) => (apagada && id === 'hml-k1' ? { situacao: 'INDISPONIVEL' } : base.obter(id)) } });
    const c2 = criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: provedor, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] });
    apagada = true;
    assert.throws(() => c2.planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] }), (e) => e.code === 'ROTACAO_CHAVE_ANTIGA_INDISPONIVEL' && e.chaves.join() === 'hml-k1');
  });

  teste('CH-C03 — revogação: a ATIVA exige rotação antes; revogar aposentada lista os pacotes que deixam de ser verificáveis; irreversível; chave desconhecida recusada', () => {
    const c = chaveiro().planejarRotacao({ novaChaveId: 'hml-k2', idsEmUso: ['hml-k1'] });
    codigo(() => c.revogar({ chaveId: 'hml-k2', pacotes: [] }), 'REVOGACAO_DA_ATIVA_EXIGE_ROTACAO');
    codigo(() => c.revogar({ chaveId: 'hml-zzz', pacotes: [] }), 'REVOGACAO_CHAVE_DESCONHECIDA');
    const r = c.revogar({ chaveId: 'hml-k1', pacotes: [{ pacote: 'pkg-b', chaveId: 'hml-k1' }, { pacote: 'pkg-a', chaveId: 'hml-k1' }, { pacote: 'pkg-c', chaveId: 'hml-k2' }] });
    assert.deepEqual([...r.pacotesNaoVerificaveis], ['pkg-a', 'pkg-b']);
    assert.deepEqual(r.chaveiro.avaliar('hml-k1', 'VERIFICAR'), { permitido: false, motivo: 'REVOGADA' });
    assert.equal(r.chaveiro.avaliar('hml-k2', 'ASSINAR').permitido, true);
    codigo(() => r.chaveiro.planejarRotacao({ novaChaveId: 'hml-k1', idsEmUso: [] }), 'ROTACAO_CHAVE_JA_CONHECIDA');
    codigo(() => c.revogar({ chaveId: 'hml-k1', pacotes: [{ pacote: '../x', chaveId: 'hml-k1' }] }), 'CONFIGURACAO_INVALIDA');
  });

  teste('CH-C04 — provedor INDISPONÍVEL depois da criação: a chave deixa de ser permitida (falha fechada), sem exceção para o chamador', () => {
    let fora = false;
    const base = fonte();
    const f = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter(id) { if (fora) throw new Error('fora do ar'); return base.obter(id); } } });
    const c = criarChaveiro({ ambiente: 'HOMOLOGACAO', fonte: f, historico: [{ id: 'hml-k1', estado: 'ATIVA' }] });
    assert.equal(c.avaliar('hml-k1', 'ASSINAR').permitido, true);
    fora = true;
    assert.deepEqual(c.avaliar('hml-k1', 'ASSINAR'), { permitido: false, motivo: 'INDISPONIVEL_NO_PROVEDOR' });
    assert.equal(c.fonteParaAssinar().obter('hml-k1').situacao, 'INDISPONIVEL');
  });
});

describe('[CH-D] contrato do provedor', () => {
  teste('CH-D01 — provedor conforme passa; provedor que responde ATIVA para inexistente, entrega segredo da revogada ou segredo curto reprova (a fonte já normaliza para INDISPONIVEL)', () => {
    const base = fonte();
    const ok = verificarContratoDoProvedor(base, { ativa: 'hml-k1', revogada: 'hml-rev', inexistente: 'hml-nao-existe' });
    assert.deepEqual([ok.conforme, [...ok.falhas]], [true, []]);
    const revogadaComoAtiva = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter: (id) => (id === 'hml-rev' ? { situacao: 'ATIVA', segredo: seg() } : base.obter(id)) } });
    assert.deepEqual([...verificarContratoDoProvedor(revogadaComoAtiva, { ativa: 'hml-k1', revogada: 'hml-rev', inexistente: 'hml-nao-existe' }).falhas], ['REVOGADA_NAO_RESPONDIDA']);
    const curto = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter: (id) => (id === 'hml-k1' ? { situacao: 'ATIVA', segredo: Buffer.alloc(8, 1) } : base.obter(id)) } });
    assert.deepEqual([...verificarContratoDoProvedor(curto, { ativa: 'hml-k1', revogada: 'hml-rev', inexistente: 'hml-nao-existe' }).falhas], ['ATIVA_NAO_RESPONDIDA']);
    const mudo = criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter() { throw new Error('x'); } } });
    assert.equal(verificarContratoDoProvedor(mudo, { ativa: 'hml-k1', revogada: 'hml-rev', inexistente: 'hml-nao-existe' }).conforme, false);
    assert.throws(() => verificarContratoDoProvedor({ obter() {} }, { ativa: 'a', revogada: 'b', inexistente: 'c' }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});
