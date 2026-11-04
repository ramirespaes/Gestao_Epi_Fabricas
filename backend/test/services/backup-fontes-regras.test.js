'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

const R = () => exigirModulo('src/services/backup-fontes-regras.service');
const ARQUIVO_REGRAS = path.join(__dirname, '..', '..', 'src', 'services', 'backup-fontes-regras.service.js');

const componente = (estado, nome) => ({
  estado,
  modulo: estado === 'AUSENTE' ? null : `src/services/${nome}.service.js`,
  teste: estado === 'PRESENTE' ? `test/services/${nome}.test.js` : null,
});
const componentes = (estado = 'PRESENTE') => ({
  planejador: componente(estado, 'sint-planejador'),
  copiador: componente(estado, 'sint-copiador'),
  verificador: componente(estado, 'sint-verificador'),
  restaurador: componente(estado, 'sint-restaurador'),
});
const base = (id, sobre) => ({
  id, tipo: 'ARQUIVOS', classe: 'PROTEGIDA', decisaoPendente: null, recomendacao: null, decisaoRef: null, justificativa: null,
  relevancia: null, persistenciaFisica: null, riscoResidual: null, categoriaDeSegredo: null, recuperacao: null,
  responsavel: 'MODULO_SINTETICO', aprovador: 'AUTORIDADE_DO_PROJETO',
  raiz: { variavel: null }, chave: { formatoChaveId: null }, verificadorId: null,
  escopo: { tipo: 'GLOBAL', regraEmpresa: null }, referencias: [], mutabilidade: 'IMUTAVEL_POR_CONTEUDO', sensibilidade: 'INTERNO',
  remocao: { fisica: 'NENHUMA', janela: 'NAO_APLICAVEL' }, componentes: componentes('AUSENTE'),
  reconstrucao: null, promocao: null, suspensao: null, versaoContrato: 1,
  ...sobre,
});
const sufixo = (id) => id.toUpperCase().replace(/-/g, '_');
const fonteArquivos = (id, sobre) => base(id, {
  raiz: { variavel: `SINT_${sufixo(id)}_DIRETORIO` }, chave: { formatoChaveId: 'imagem-v1' }, verificadorId: 'imagens-consistencia-v1',
  escopo: { tipo: 'EMPRESA', regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' }, referencias: [{ tabela: 'tabela_sintetica', colunas: ['empresa_id', 'sha256'] }],
  remocao: { fisica: 'JANELA_LIMPEZA', janela: 'UNICA' }, componentes: componentes('PRESENTE'), ...sobre,
});
const fonteBanco = (id, sobre) => base(id, {
  tipo: 'POSTGRES', verificadorId: 'postgres-estrutura-v1', escopo: { tipo: 'MISTO', regraEmpresa: 'COLUNA_EMPRESA_ID' },
  mutabilidade: 'VERSIONADA', sensibilidade: 'PESSOAL', componentes: componentes('PRESENTE'), ...sobre,
});
const fontePendente = (id, sobre) => base(id, {
  classe: null, decisaoPendente: 'D-F1', recomendacao: 'PROTEGIDA', relevancia: 'PERSISTENTE_RELEVANTE', persistenciaFisica: 'SIM',
  riscoResidual: 'DADO_PESSOAL', raiz: { variavel: `SINT_${sufixo(id)}_DIRETORIO` }, ...sobre,
});
const fonteEfemera = (id, sobre) => base(id, {
  classe: 'EFEMERA', decisaoRef: 'P0-CF-1', justificativa: 'Mecanismo sintético de coordenação; política de recuperação: não copiar nem restaurar.',
  relevancia: 'NAO_PERSISTENTE', persistenciaFisica: 'SIM', riscoResidual: 'TRAVA_OBSOLETA_BLOQUEIA_OPERACAO',
  raiz: { variavel: `SINT_${sufixo(id)}_ARQUIVO` }, mutabilidade: 'MUTAVEL', ...sobre,
});
const fonteSegredo = (id, sobre) => base(id, {
  classe: 'EXCLUIDA', decisaoRef: 'P0-CF-2', justificativa: 'Segredo operacional sintético, fora do pacote; recuperação por procedimento independente.',
  relevancia: 'POLITICA_SEGURANCA', persistenciaFisica: 'DEPENDE_DO_AMBIENTE', riscoResidual: 'SEGREDO_FORA_DO_PACOTE_REQUER_CUSTODIA',
  categoriaDeSegredo: 'CREDENCIAL', recuperacao: { procedimento: 'INDEPENDENTE', decisao: 'D-F5' },
  mutabilidade: 'MUTAVEL', sensibilidade: 'SEGREDO', ...sobre,
});
const PROMOCAO = { decisao: 'PROMOCAO-sintetica', evidencias: ['evidencia-sintetica-1'], aprovadoEm: '2026-11-01' };
const cat = (...fontes) => ({ versao: 1, fontes });
const codigos = (resultado) => resultado.erros.map((e) => e.codigo);
const exigeCodigo = (catalogo, codigo) => {
  const resultado = R().validarCatalogo(catalogo);
  assert.equal(resultado.valido, false, `esperava recusa com ${codigo}`);
  assert.ok(codigos(resultado).includes(codigo), `esperava ${codigo}; veio ${codigos(resultado).join(',')}`);
};
const invertido = (valor) => {
  if (Array.isArray(valor)) return valor.map(invertido);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).reverse().map(([k, v]) => [k, invertido(v)]));
  return valor;
};

function cenarioCompleto() {
  const catalogo = cat(
    fonteBanco('banco-sint', { promocao: PROMOCAO }),
    fonteArquivos('arquivos-sint', { promocao: PROMOCAO }),
    fonteEfemera('efemera-sint'),
    fonteSegredo('segredo-sint'),
  );
  const contexto = {
    raizesConfiguradas: catalogo.fontes.map((f) => f.raiz.variavel).filter(Boolean),
    nivelPostgres: 'N1',
    resultadosDinamicos: { 'banco-sint': 'APROVADO', 'arquivos-sint': 'APROVADO' },
  };
  return { catalogo, contexto };
}

describe('S1 — catálogo: estrutura, imutabilidade e formato', () => {
  test('U01 — catálogo selado é congelado em profundidade e recusa mutação', () => {
    const selado = R().selarCatalogo(cat(fonteArquivos('arquivos-sint'), fontePendente('pend-sint')));
    assert.ok(Object.isFrozen(selado) && Object.isFrozen(selado.fontes) && Object.isFrozen(selado.fontes[0]));
    assert.ok(Object.isFrozen(selado.fontes[0].componentes.copiador) && Object.isFrozen(selado.fontes[0].referencias[0].colunas));
    assert.throws(() => { selado.fontes[0].classe = 'EXCLUIDA'; }, TypeError);
    assert.throws(() => { selado.fontes.push({}); }, TypeError);
  });

  test('U01b — formato inválido, campo desconhecido e campo ausente falham fechados', () => {
    for (const ruim of [null, [], 'x', { versao: 1 }, { versao: 1, fontes: [] }, { versao: 0, fontes: [fonteArquivos('a-sint')] }, { versao: 1, fontes: [fonteArquivos('a-sint')], extra: 1 }]) {
      const resultado = R().validarCatalogo(ruim);
      assert.equal(resultado.valido, false);
      assert.ok(codigos(resultado).includes('CATALOGO_FORMATO'));
    }
    exigeCodigo(cat({ ...fonteArquivos('a-sint'), campoInventado: 1 }), 'CAMPO_DESCONHECIDO');
    const semCampo = fonteArquivos('a-sint');
    delete semCampo.sensibilidade;
    exigeCodigo(cat(semCampo), 'CAMPO_AUSENTE');
    exigeCodigo(cat(null), 'FONTE_FORMATO');
  });

  test('U01c — selarCatalogo recusa catálogo inválido com os códigos, sem valores', () => {
    assert.throws(() => R().selarCatalogo(cat(fonteArquivos('A_ruim'))), (e) => e.codigo === 'CATALOGO_INVALIDO' && Array.isArray(e.erros) && e.erros.length > 0);
  });
});

describe('S2 — validação: tipos, classes, decisões, relevância e campos obrigatórios', () => {
  test('U02 — id duplicado → recusa', () => exigeCodigo(cat(fonteArquivos('a-sint'), fonteArquivos('a-sint', { raiz: { variavel: 'SINT_OUTRA_DIRETORIO' } })), 'ID_DUPLICADO'));

  test('U03 — id fora do formato → recusa', () => {
    for (const id of ['Maiusculo', '', 'a_b', 'a'.repeat(41), 'a b', 7]) exigeCodigo(cat(fonteArquivos('ok-sint', { id })), 'ID_INVALIDO');
  });

  test('U04 — tipo inválido → recusa', () => exigeCodigo(cat(fonteArquivos('a-sint', { tipo: 'BUCKET' })), 'TIPO_INVALIDO'));

  test('U05 — classe inválida; classe nula só com decisão pendente rastreável', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { classe: 'MEIA_PROTEGIDA' })), 'CLASSE_INVALIDA');
    exigeCodigo(cat(fontePendente('p-sint', { decisaoPendente: null })), 'DECISAO_PENDENTE_AUSENTE');
    exigeCodigo(cat(fontePendente('p-sint', { decisaoPendente: 'D-F99' })), 'DECISAO_PENDENTE_AUSENTE');
    exigeCodigo(cat(fonteArquivos('a-sint', { decisaoPendente: 'D-F1' })), 'DECISAO_PENDENTE_COM_CLASSE');
    assert.equal(R().validarCatalogo(cat(fontePendente('p-sint'))).valido, true);
  });

  test('U06 — EFEMERA/EXCLUIDA/DERIVAVEL sem justificativa → recusa', () => {
    exigeCodigo(cat(fonteEfemera('e-sint', { justificativa: null })), 'JUSTIFICATIVA_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { justificativa: '   ' })), 'JUSTIFICATIVA_OBRIGATORIA');
    exigeCodigo(cat(fonteArquivos('d-sint', { classe: 'DERIVAVEL', decisaoRef: 'D-F1', justificativa: null, componentes: componentes('AUSENTE'), reconstrucao: { comprovada: true, evidencia: 'ev' } })), 'JUSTIFICATIVA_OBRIGATORIA');
  });

  test('U07 — EXCLUIDA sem relevância ou sem decisão rastreável → recusa; referência inventada → recusa', () => {
    exigeCodigo(cat(fonteSegredo('s-sint', { relevancia: null })), 'RELEVANCIA_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { decisaoRef: null })), 'DECISAO_REF_OBRIGATORIA');
    for (const ref of ['P0-CF-9', 'D-F18', 'D-F0', 'DECISAO-QUALQUER', 'p0-cf-1']) exigeCodigo(cat(fonteSegredo('s-sint', { decisaoRef: ref })), 'DECISAO_REF_INVALIDA');
    for (const ref of ['P0-CF-1', 'P0-CF-2', 'P0-CF-3', 'D-F1', 'D-F17']) assert.ok(R().DECISOES_VALIDAS.includes(ref), ref);
  });

  test('U08 — responsável e aprovador obrigatórios', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { responsavel: null })), 'RESPONSAVEL_OBRIGATORIO');
    exigeCodigo(cat(fonteArquivos('a-sint', { aprovador: '' })), 'APROVADOR_OBRIGATORIO');
  });

  test('U09 — variável de raiz duplicada ou com nome de segredo → recusa', () => {
    exigeCodigo(cat(fonteArquivos('a-sint'), fonteArquivos('b-sint', { raiz: { variavel: 'SINT_A_SINT_DIRETORIO' } })), 'RAIZ_DUPLICADA');
    for (const nome of ['SINT_SENHA_DIRETORIO', 'SINT_SECRET_DIRETORIO', 'SINT_TOKEN_DIRETORIO', 'SINT_PASSWORD_DIRETORIO', 'PGPASSFILE']) {
      exigeCodigo(cat(fonteArquivos('a-sint', { raiz: { variavel: nome } })), 'RAIZ_NOME_PROIBIDO');
    }
    exigeCodigo(cat(fonteArquivos('a-sint', { raiz: { variavel: 'minuscula' } })), 'RAIZ_NOME_INVALIDO');
    exigeCodigo(cat(fonteArquivos('a-sint', { raiz: { variavel: null } })), 'RAIZ_OBRIGATORIA');
    exigeCodigo(cat(fonteBanco('b-sint', { raiz: { variavel: 'SINT_BANCO_DIRETORIO' } })), 'POSTGRES_COM_RAIZ');
  });

  test('U10 — PROTEGIDA mutável → recusa', () => exigeCodigo(cat(fonteArquivos('a-sint', { mutabilidade: 'MUTAVEL' })), 'PROTEGIDA_MUTAVEL'));

  test('U19 — versaoContrato deve ser inteiro positivo', () => {
    for (const v of [0, -1, 1.5, '1', null]) exigeCodigo(cat(fonteArquivos('a-sint', { versaoContrato: v })), 'VERSAO_CONTRATO_INVALIDA');
  });

  test('U20 — escopo por empresa exige regra de derivação; global não admite', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { escopo: { tipo: 'EMPRESA', regraEmpresa: null } })), 'ESCOPO_SEM_REGRA_DE_EMPRESA');
    exigeCodigo(cat(fonteArquivos('a-sint', { escopo: { tipo: 'MISTO', regraEmpresa: null } })), 'ESCOPO_SEM_REGRA_DE_EMPRESA');
    exigeCodigo(cat(fonteArquivos('a-sint', { escopo: { tipo: 'GLOBAL', regraEmpresa: 'COLUNA_EMPRESA_ID' } })), 'ESCOPO_GLOBAL_COM_REGRA');
    exigeCodigo(cat(fonteArquivos('a-sint', { escopo: { tipo: 'SETOR', regraEmpresa: null } })), 'ESCOPO_INVALIDO');
  });

  test('U24 — DERIVAVEL sem reconstrução comprovada → recusa', () => {
    const derivavel = (reconstrucao) => fonteArquivos('d-sint', {
      classe: 'DERIVAVEL', decisaoRef: 'D-F1', justificativa: 'Derivável sintética.', componentes: componentes('AUSENTE'), reconstrucao,
    });
    exigeCodigo(cat(derivavel(null)), 'DERIVAVEL_SEM_PROVA');
    exigeCodigo(cat(derivavel({ comprovada: false, evidencia: 'ev' })), 'DERIVAVEL_SEM_PROVA');
    assert.equal(R().validarCatalogo(cat(derivavel({ comprovada: true, evidencia: 'evidencia-sintetica' }))).valido, true);
  });

  test('R-04 — janela só aceita UNICA ou NAO_APLICAVEL', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { remocao: { fisica: 'JANELA_LIMPEZA', janela: 'POR_FONTE' } })), 'JANELA_INVALIDA');
  });

  test('U31 — EFEMERA/EXCLUIDA exigem persistência física e risco residual declarados', () => {
    exigeCodigo(cat(fonteEfemera('e-sint', { persistenciaFisica: null })), 'PERSISTENCIA_FISICA_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { persistenciaFisica: null })), 'PERSISTENCIA_FISICA_OBRIGATORIA');
    exigeCodigo(cat(fonteEfemera('e-sint', { riscoResidual: null })), 'RISCO_RESIDUAL_OBRIGATORIO');
    exigeCodigo(cat(fontePendente('p-sint', { riscoResidual: null })), 'RISCO_RESIDUAL_OBRIGATORIO');
    exigeCodigo(cat(fonteEfemera('e-sint', { persistenciaFisica: 'TALVEZ' })), 'PERSISTENCIA_FISICA_INVALIDA');
  });

  test('U28 — dado de negócio nunca é EXCLUIDA por política de segurança', () => {
    exigeCodigo(cat(fonteSegredo('s-sint', { referencias: [{ tabela: 'materiais', colunas: ['empresa_id', 'sha256'] }] })), 'EXCLUSAO_SEGURANCA_DE_DADO_DE_NEGOCIO');
    exigeCodigo(cat(fonteSegredo('s-sint', { escopo: { tipo: 'EMPRESA', regraEmpresa: 'COLUNA_EMPRESA_ID' } })), 'EXCLUSAO_SEGURANCA_DE_DADO_DE_NEGOCIO');
  });

  test('U29 — segredo excluído exige categoria fechada; categoria só com política de segurança', () => {
    exigeCodigo(cat(fonteSegredo('s-sint', { categoriaDeSegredo: null })), 'CATEGORIA_DE_SEGREDO_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { categoriaDeSegredo: 'CERTIFICADO' })), 'CATEGORIA_DE_SEGREDO_OBRIGATORIA');
    for (const categoria of ['CREDENCIAL', 'CHAVE_PRIVADA', 'SEGREDO_DE_APLICACAO', 'ARQUIVO_DE_AMBIENTE']) {
      assert.equal(R().validarCatalogo(cat(fonteSegredo('s-sint', { categoriaDeSegredo: categoria }))).valido, true, categoria);
    }
    exigeCodigo(cat(fonteEfemera('e-sint', { categoriaDeSegredo: 'CREDENCIAL' })), 'CATEGORIA_DE_SEGREDO_INDEVIDA');
  });

  test('U30 — segredo excluído exige recuperação independente referenciando D-F5', () => {
    exigeCodigo(cat(fonteSegredo('s-sint', { recuperacao: null })), 'RECUPERACAO_INDEPENDENTE_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { recuperacao: { procedimento: 'INDEPENDENTE', decisao: 'D-F4' } })), 'RECUPERACAO_INDEPENDENTE_OBRIGATORIA');
    exigeCodigo(cat(fonteSegredo('s-sint', { recuperacao: { procedimento: 'NO_PACOTE', decisao: 'D-F5' } })), 'RECUPERACAO_INDEPENDENTE_OBRIGATORIA');
    exigeCodigo(cat(fonteEfemera('e-sint', { recuperacao: { procedimento: 'INDEPENDENTE', decisao: 'D-F5' } })), 'RECUPERACAO_INDEVIDA');
  });

  test('X09 — combinações inválidas de promoção e cobertura são recusadas', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { promocao: { ...PROMOCAO, decisao: 'qualquer-coisa' } })), 'PROMOCAO_INVALIDA');
    exigeCodigo(cat(fonteArquivos('a-sint', { promocao: { ...PROMOCAO, evidencias: [] } })), 'PROMOCAO_INVALIDA');
    exigeCodigo(cat(fonteArquivos('a-sint', { promocao: { ...PROMOCAO, aprovadoEm: '2026-13-45' } })), 'PROMOCAO_INVALIDA');
    exigeCodigo(cat(fonteArquivos('a-sint', { promocao: PROMOCAO, componentes: { ...componentes('PRESENTE'), copiador: componente('PARCIAL', 'sint-copiador') } })), 'PROMOCAO_COM_COMPONENTE_INCOMPLETO');
    exigeCodigo(cat(fonteArquivos('a-sint', { promocao: PROMOCAO, componentes: componentes('AUSENTE') })), 'PROMOCAO_COM_COMPONENTE_INCOMPLETO');
    exigeCodigo(cat(fontePendente('p-sint', { promocao: PROMOCAO })), 'PROMOCAO_FORA_DE_PROTEGIDA');
    exigeCodigo(cat(fonteEfemera('e-sint', { promocao: PROMOCAO })), 'PROMOCAO_FORA_DE_PROTEGIDA');
    exigeCodigo(cat(fonteSegredo('s-sint', { promocao: PROMOCAO })), 'PROMOCAO_FORA_DE_PROTEGIDA');
    exigeCodigo(cat(fonteEfemera('e-sint', { componentes: componentes('PRESENTE') })), 'COMPONENTES_NAO_SE_APLICAM');
    exigeCodigo(cat(fonteArquivos('a-sint', { componentes: { ...componentes('PRESENTE'), copiador: { estado: 'PRESENTE', modulo: null, teste: null } } })), 'COMPONENTE_INCOERENTE');
    exigeCodigo(cat(fonteArquivos('a-sint', { componentes: { ...componentes('PRESENTE'), copiador: { estado: 'AUSENTE', modulo: 'src/x.js', teste: null } } })), 'COMPONENTE_INCOERENTE');
    exigeCodigo(cat(fonteArquivos('a-sint', { componentes: { ...componentes('PRESENTE'), copiador: { estado: 'PRESENTE', modulo: '../fora.js', teste: 'test/x.test.js' } } })), 'COMPONENTE_INCOERENTE');
  });

  test('X09b — suspensão malformada e limite de fontes', () => {
    exigeCodigo(cat(fonteArquivos('a-sint', { suspensao: { motivo: '', desde: '2026-11-01' } })), 'SUSPENSAO_INVALIDA');
    const muitas = Array.from({ length: 17 }, (_, i) => fonteArquivos(`f${i}-sint`));
    exigeCodigo(cat(...muitas), 'LIMITE_DE_FONTES');
  });
});

describe('S3 — estados derivados, pendências e suspensões', () => {
  test('U12 — implementação completa sem promoção nunca é "comprovada"', () => {
    assert.equal(R().estadoDeCobertura(fonteArquivos('a-sint')), 'IMPLEMENTADA_NAO_COMPROVADA');
    assert.equal(R().estadoDeCobertura(fonteArquivos('a-sint', { promocao: PROMOCAO })), 'PROTEGIDA_COMPROVADA');
    assert.equal(R().estadoDeCobertura(fonteArquivos('a-sint', { promocao: PROMOCAO, suspensao: { motivo: 'REGRESSAO_DE_CONTRATO', desde: '2026-11-02' } })), 'SUSPENSA');
  });

  test('U13 — implementação parcial: fora do pacote, com motivo fechado', () => {
    const parcial = fonteArquivos('a-sint', { componentes: { ...componentes('PRESENTE'), verificador: componente('PARCIAL', 'sint-verificador') } });
    assert.equal(R().estadoDeCobertura(parcial), 'IMPLEMENTACAO_PARCIAL');
    assert.equal(R().incluidaNoPacote(parcial), false);
    assert.equal(R().motivoForaDoPacote(parcial), 'COMPONENTE_PARCIAL:verificador');
    assert.equal(R().estadoDeCobertura(fonteArquivos('c-sint', { componentes: componentes('AUSENTE') })), 'CANDIDATA');
    assert.equal(R().motivoForaDoPacote(fonteArquivos('c-sint', { componentes: componentes('AUSENTE') })), 'COMPONENTE_AUSENTE:planejador');
    assert.equal(R().incluidaNoPacote(fonteArquivos('a-sint', { promocao: PROMOCAO })), true);
  });

  test('S3 — demais estados derivados e motivos', () => {
    assert.equal(R().estadoDeCobertura(fontePendente('p-sint')), 'PENDENTE_DECISAO');
    assert.equal(R().motivoForaDoPacote(fontePendente('p-sint')), 'CLASSE_NAO_DECIDIDA');
    assert.equal(R().estadoDeCobertura(fonteEfemera('e-sint')), 'DECLARADA_EFEMERA');
    assert.equal(R().estadoDeCobertura(fonteSegredo('s-sint')), 'DECLARADA_EXCLUIDA');
    assert.equal(R().estadoDeCobertura(fonteArquivos('d-sint', { classe: 'DERIVAVEL', reconstrucao: { comprovada: true, evidencia: 'ev' } })), 'DERIVAVEL_COMPROVADA');
    assert.equal(R().incluidaNoPacote(fonteEfemera('e-sint')), false);
    assert.equal(R().estadoImplementacao(fonteArquivos('a-sint')), 'COMPLETA');
    assert.equal(R().estadoImplementacao(fonteArquivos('a-sint', { componentes: componentes('AUSENTE') })), 'NENHUMA');
  });

  test('U14 — pendências de cobertura: códigos fechados e ordem estável', () => {
    const catalogo = cat(
      fonteArquivos('b-sint'),
      fontePendente('a-sint'),
      fontePendente('c-sint', { decisaoPendente: 'D-F2', recomendacao: 'EFEMERA' }),
      fonteEfemera('d-sint'),
      fonteSegredo('e-sint'),
      fonteArquivos('f-sint', { promocao: PROMOCAO }),
      fonteBanco('g-sint', { componentes: { ...componentes('PRESENTE'), verificador: componente('PARCIAL', 'sint-verificador') } }),
      fonteSegredo('h-sint', { relevancia: 'PERSISTENTE_RELEVANTE', categoriaDeSegredo: null, recuperacao: null }),
    );
    const pendencias = R().pendenciasDeCobertura(catalogo);
    assert.deepEqual(pendencias.map((p) => [p.fonteId, p.codigo]), [
      ['a-sint', 'CLASSE_NAO_DECIDIDA'],
      ['b-sint', 'NAO_COMPROVADA'],
      ['c-sint', 'CLASSE_NAO_DECIDIDA'],
      ['g-sint', 'COMPONENTE_PARCIAL:verificador'],
      ['h-sint', 'EXCLUSAO_RELEVANTE'],
    ]);
    assert.deepEqual(R().pendenciasDeCobertura(cat(...[...catalogo.fontes].reverse())), pendencias);
    assert.throws(() => R().pendenciasDeCobertura(cat(fonteArquivos('A_ruim'))), (e) => e.codigo === 'CATALOGO_INVALIDO');
  });

  test('U18 — resultados são congelados', () => {
    const catalogo = cat(fonteArquivos('a-sint'), fontePendente('p-sint'));
    const pendencias = R().pendenciasDeCobertura(catalogo);
    assert.ok(Object.isFrozen(pendencias) && Object.isFrozen(pendencias[0]));
    const avaliacao = R().avaliarCobertura(catalogo, {});
    assert.ok(Object.isFrozen(avaliacao) && Object.isFrozen(avaliacao.motivos));
    const projecao = R().projetarParaManifesto(catalogo);
    assert.ok(Object.isFrozen(projecao) && Object.isFrozen(projecao.fontes) && Object.isFrozen(projecao.fontes[0]));
  });

  test('U17 — só objetos produzidos pelo módulo são fontes registradas', () => {
    const selado = R().selarCatalogo(cat(fonteArquivos('a-sint')));
    assert.equal(R().ehFonteRegistrada(selado.fontes[0]), true);
    assert.equal(R().ehFonteRegistrada(selado), true);
    assert.equal(R().ehFonteRegistrada(structuredClone(selado.fontes[0])), false);
    assert.equal(R().ehFonteRegistrada({ ...selado.fontes[0] }), false);
    assert.equal(R().ehFonteRegistrada(fonteArquivos('a-sint')), false);
    for (const v of [null, undefined, 1, 'a', [], {}]) assert.equal(R().ehFonteRegistrada(v), false);
  });
});

describe('S4 — teto de cobertura', () => {
  test('U15 — catálogo sem comprovação nunca ultrapassa NAO_COMPROVADA, com ou sem contexto', () => {
    const catalogo = cat(fonteBanco('banco-sint'), fonteArquivos('a-sint'), fontePendente('p-sint'));
    assert.equal(R().tetoDeDeclaracao(catalogo), 'NAO_COMPROVADA');
    const contexto = { raizesConfiguradas: ['SINT_A_SINT_DIRETORIO', 'SINT_P_SINT_DIRETORIO'], nivelPostgres: 'N3', resultadosDinamicos: { 'banco-sint': 'APROVADO', 'a-sint': 'APROVADO' } };
    assert.equal(R().tetoDeDeclaracao(catalogo, contexto), 'NAO_COMPROVADA');
  });

  test('X02 — cenário sintético inteiramente válido alcança COMPLETA', () => {
    const { catalogo, contexto } = cenarioCompleto();
    assert.equal(R().validarCatalogo(catalogo).valido, true);
    const avaliacao = R().avaliarCobertura(catalogo, contexto);
    assert.equal(avaliacao.teto, 'COMPLETA');
    assert.deepEqual([...avaliacao.motivos], []);
    assert.equal(R().tetoDeDeclaracao(catalogo, contexto), 'COMPLETA');
    assert.deepEqual(R().pendenciasDeCobertura(catalogo), []);
  });

  test('X02b — cada condição ausente rebaixa o teto de COMPLETA', () => {
    const { catalogo, contexto } = cenarioCompleto();
    const teto = (cat2, ctx) => R().avaliarCobertura(cat2, ctx);

    assert.equal(teto(catalogo, undefined).teto, 'NAO_COMPROVADA');
    assert.equal(teto(catalogo, { ...contexto, resultadosDinamicos: {} }).teto, 'NAO_COMPROVADA');

    const reprovado = teto(catalogo, { ...contexto, resultadosDinamicos: { ...contexto.resultadosDinamicos, 'arquivos-sint': 'REPROVADO' } });
    assert.equal(reprovado.teto, 'PARCIAL');
    assert.ok(reprovado.motivos.includes('DINAMICA_REPROVADA:arquivos-sint'));

    const semRegistro = teto(catalogo, { ...contexto, raizesConfiguradas: [...contexto.raizesConfiguradas, 'OUTRA_RAIZ_DIRETORIO'] });
    assert.equal(semRegistro.teto, 'PARCIAL');
    assert.ok(semRegistro.motivos.includes('RAIZ_SEM_REGISTRO'));

    const semUniverso = teto(catalogo, { nivelPostgres: 'N1', resultadosDinamicos: contexto.resultadosDinamicos });
    assert.equal(semUniverso.teto, 'PARCIAL');
    assert.ok(semUniverso.motivos.includes('UNIVERSO_NAO_VERIFICADO'));

    const nivel = teto(catalogo, { ...contexto, nivelPostgres: 'N0' });
    assert.equal(nivel.teto, 'PARCIAL');
    assert.ok(nivel.motivos.includes('NIVEL_POSTGRES_INSUFICIENTE:banco-sint'));

    const comPendente = teto(cat(...catalogo.fontes, fontePendente('p-sint')), contexto);
    assert.equal(comPendente.teto, 'PARCIAL');
    assert.ok(comPendente.motivos.includes('PENDENCIA:p-sint'));

    const relevante = teto(cat(...catalogo.fontes, fonteSegredo('rel-sint', { relevancia: 'PERSISTENTE_RELEVANTE', categoriaDeSegredo: null, recuperacao: null })), contexto);
    assert.equal(relevante.teto, 'PARCIAL');
    assert.ok(relevante.motivos.includes('EXCLUSAO_RELEVANTE:rel-sint'));

    const suspensa = cat(fonteBanco('banco-sint', { promocao: PROMOCAO }), fonteArquivos('arquivos-sint', { promocao: PROMOCAO, suspensao: { motivo: 'REGRESSAO_DE_CONTRATO', desde: '2026-11-02' } }), fonteEfemera('efemera-sint'), fonteSegredo('segredo-sint'));
    const rebaixada = teto(suspensa, contexto);
    assert.equal(rebaixada.teto, 'PARCIAL');
    assert.ok(rebaixada.motivos.includes('PENDENCIA:arquivos-sint'));

    const semBanco = cat(fonteArquivos('arquivos-sint', { promocao: PROMOCAO }), fonteEfemera('efemera-sint'), fonteSegredo('segredo-sint'));
    const ausente = teto(semBanco, { ...contexto, resultadosDinamicos: { 'arquivos-sint': 'APROVADO' } });
    assert.equal(ausente.teto, 'PARCIAL');
    assert.ok(ausente.motivos.includes('FONTE_RELEVANTE_AUSENTE'));
  });

  test('X02c — catálogo e contexto inválidos falham fechados', () => {
    const { catalogo, contexto } = cenarioCompleto();
    const invalido = R().avaliarCobertura(cat(fonteArquivos('A_ruim')), contexto);
    assert.equal(invalido.teto, 'NAO_COMPROVADA');
    assert.ok(invalido.motivos.includes('CATALOGO_INVALIDO'));
    for (const ctx of [{ ...contexto, inventado: 1 }, { ...contexto, nivelPostgres: 'N9' }, { ...contexto, raizesConfiguradas: 'x' }, { ...contexto, resultadosDinamicos: { 'banco-sint': 'TALVEZ' } }, 5]) {
      const resultado = R().avaliarCobertura(catalogo, ctx);
      assert.equal(resultado.teto, 'NAO_COMPROVADA');
      assert.ok(resultado.motivos.includes('CONTEXTO_INVALIDO'));
    }
    assert.equal(R().tetoDeDeclaracao(null), 'NAO_COMPROVADA');
  });
});

describe('S5 — serialização canônica, hash e projeção', () => {
  test('U16 — serialização determinística; qualquer campo alterado muda o hash', () => {
    const catalogo = cat(fonteArquivos('b-sint'), fonteBanco('a-sint'), fontePendente('c-sint'));
    const texto = R().serializarCatalogo(catalogo);
    assert.equal(texto.charCodeAt(0), 0x7b);
    assert.ok(!texto.includes('\n') && !texto.includes('﻿'));
    assert.equal(R().serializarCatalogo(cat(...[...catalogo.fontes].reverse())), texto);
    assert.equal(R().serializarCatalogo(invertido(catalogo)), texto);
    const hash = R().hashCatalogo(catalogo);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, crypto.createHash('sha256').update(texto, 'utf8').digest('hex'));
    const alterado = structuredClone(catalogo);
    alterado.fontes[0].versaoContrato = 2;
    assert.notEqual(R().hashCatalogo(alterado), hash);
    const outro = structuredClone(catalogo);
    outro.fontes[2].recomendacao = 'EFEMERA';
    assert.notEqual(R().hashCatalogo(outro), hash);
    const selado = R().selarCatalogo(catalogo);
    assert.equal(R().hashCatalogo(selado), hash);
    assert.throws(() => R().serializarCatalogo(cat(fonteArquivos('A_ruim'))), (e) => e.codigo === 'CATALOGO_INVALIDO');
  });

  test('U26 — projeção para o manifesto é determinística e não carrega justificativas nem decisões', () => {
    const catalogo = cat(fonteArquivos('b-sint'), fonteBanco('a-sint'), fontePendente('c-sint'), fonteEfemera('d-sint'), fonteSegredo('e-sint'));
    const projecao = R().projetarParaManifesto(catalogo);
    assert.equal(projecao.versao, 1);
    assert.equal(projecao.sha256, R().hashCatalogo(catalogo));
    assert.deepEqual(projecao.fontes.map((f) => f.id), ['a-sint', 'b-sint', 'c-sint', 'd-sint', 'e-sint']);
    assert.deepEqual(R().projetarParaManifesto(invertido(cat(...[...catalogo.fontes].reverse()))), projecao);
    const texto = JSON.stringify(projecao);
    for (const proibido of ['Mecanismo sintético', 'Segredo operacional', 'P0-CF', 'D-F1', 'D-F5', 'MODULO_SINTETICO', 'AUTORIDADE_DO_PROJETO', 'recomendacao', 'decisaoRef', 'justificativa']) {
      assert.ok(!texto.includes(proibido), proibido);
    }
    const pendente = projecao.fontes.find((f) => f.id === 'c-sint');
    assert.deepEqual([pendente.incluida, pendente.motivo, pendente.estadoCobertura, pendente.classe], [false, 'CLASSE_NAO_DECIDIDA', 'PENDENTE_DECISAO', null]);
    assert.equal(projecao.fontes.find((f) => f.id === 'b-sint').motivo, 'NAO_COMPROVADA');
    assert.equal(projecao.fontes.find((f) => f.id === 'd-sint').motivo, 'DECLARADA_EFEMERA');
  });

  test('U27 — nada fora da projeção vaza e o conjunto de chaves é exato', () => {
    const sentinela = 'SENTINELA-NAO-VAZAR-77';
    const catalogo = cat(fonteArquivos('a-sint', { justificativa: sentinela, riscoResidual: 'DADO_PESSOAL', responsavel: 'RESPONSAVEL_SENTINELA' }));
    const texto = JSON.stringify(R().projetarParaManifesto(catalogo));
    assert.ok(!texto.includes(sentinela) && !texto.includes('RESPONSAVEL_SENTINELA'));
    const chaves = Object.keys(R().projetarParaManifesto(catalogo).fontes[0]).sort();
    assert.deepEqual(chaves, ['classe', 'escopo', 'estadoCobertura', 'formatoChaveId', 'id', 'incluida', 'motivo', 'referencias', 'tipo', 'verificadorId', 'versaoContrato']);
    assert.deepEqual(Object.keys(R().projetarParaManifesto(catalogo)).sort(), ['fontes', 'sha256', 'versao']);
  });

  test('U23/X08 — erros de validação nunca carregam valores recebidos', () => {
    const sentinela = 'VALOR-SENSIVEL-ABC123';
    const ruim = fonteArquivos('a-sint', {
      id: sentinela, tipo: sentinela, classe: sentinela, justificativa: sentinela, relevancia: sentinela, persistenciaFisica: sentinela,
      responsavel: sentinela, raiz: { variavel: sentinela }, versaoContrato: sentinela, campoInventado: sentinela,
      referencias: [{ tabela: sentinela, colunas: [sentinela] }], componentes: { ...componentes('PRESENTE'), copiador: { estado: sentinela, modulo: sentinela, teste: sentinela } },
    });
    const resultado = R().validarCatalogo(cat(ruim));
    assert.equal(resultado.valido, false);
    assert.ok(!JSON.stringify(resultado).includes(sentinela));
    try { R().selarCatalogo(cat(ruim)); } catch (erro) { assert.ok(!JSON.stringify({ m: erro.message, e: erro.erros }).includes(sentinela)); }
    for (const e of resultado.erros) assert.deepEqual(Object.keys(e).sort(), ['campo', 'codigo', 'fonteId']);
  });

  test('U32 — fonte fisicamente persistente nunca é descrita como "não persistente"', () => {
    const textos = [fonteEfemera('e-sint'), fonteSegredo('s-sint', { persistenciaFisica: 'SIM' }), fontePendente('p-sint')].map((f) => R().descreverPoliticaDeRecuperacao(f));
    for (const texto of textos) {
      assert.match(texto, /fisicamente persistente/i);
      assert.doesNotMatch(texto, /n[aã]o persistente|transit[oó]rio|tempor[aá]rio/i);
    }
    assert.match(R().descreverPoliticaDeRecuperacao(fonteEfemera('e-sint')), /n[aã]o ser[aá] copiada nem restaurada/i);
    assert.match(R().descreverPoliticaDeRecuperacao(fonteSegredo('s-sint')), /recupera[cç][aã]o independente/i);
    assert.doesNotMatch(R().descreverPoliticaDeRecuperacao(fonteEfemera('e-sint', { persistenciaFisica: 'NAO' })), /fisicamente persistente/i);
  });
});

describe('S5b — raízes: comparação léxica e severidades', () => {
  test('U25 — comparação léxica de caminhos sintéticos (nunca prova isolamento operacional)', () => {
    const { compararRaizesLexico, detectarSobreposicoesLexicas } = R();
    assert.equal(compararRaizesLexico('/a/b', '/a/b'), 'IGUAL');
    assert.equal(compararRaizesLexico('/a/b/', '/a/b'), 'IGUAL');
    assert.equal(compararRaizesLexico('/a/./b/../b', '/a/b'), 'IGUAL');
    assert.equal(compararRaizesLexico('/a', '/a/b'), 'ANCESTRAL');
    assert.equal(compararRaizesLexico('/a/b', '/a'), 'DESCENDENTE');
    assert.equal(compararRaizesLexico('/a/b', '/a/bc'), 'DISJUNTA');
    assert.equal(compararRaizesLexico('/', '/a'), 'ANCESTRAL');
    assert.throws(() => compararRaizesLexico('relativo/x', '/a'), (e) => e.codigo === 'CAMINHO_INVALIDO');
    assert.throws(() => compararRaizesLexico('/a\0b', '/a'), (e) => e.codigo === 'CAMINHO_INVALIDO');
    assert.throws(() => compararRaizesLexico(7, '/a'), (e) => e.codigo === 'CAMINHO_INVALIDO');

    const resultado = detectarSobreposicoesLexicas([
      { id: 'imagens', caminho: '/dados/imagens' },
      { id: 'saida-backup', caminho: '/dados/imagens/backup' },
      { id: 'fiscalizacao', caminho: '/dados/fiscalizacao' },
      { id: 'duplicada', caminho: '/dados/fiscalizacao/' },
      { id: 'invalida', caminho: 'relativo' },
    ]);
    assert.deepEqual(resultado.map((o) => [o.a, o.b, o.relacao, o.codigo]).sort(), [
      ['fiscalizacao', 'duplicada', 'IGUAL', 'RAIZES_SOBREPOSTAS_LEXICO'],
      ['imagens', 'saida-backup', 'ANCESTRAL', 'RAIZES_SOBREPOSTAS_LEXICO'],
      ['invalida', null, null, 'CAMINHO_INVALIDO'],
    ].sort());
    for (const o of resultado) assert.equal(o.validacao, 'LEXICA');
    assert.ok(!JSON.stringify(resultado).includes('/dados'));
    assert.deepEqual(detectarSobreposicoesLexicas([{ id: 'a', caminho: '/x' }, { id: 'b', caminho: '/y' }]), []);
  });

  test('AC-06 — tabela de severidades fechada; código desconhecido bloqueia', () => {
    const { SEVERIDADES, severidadeDe } = R();
    assert.ok(Object.isFrozen(SEVERIDADES));
    for (const [codigo, severidade] of Object.entries(SEVERIDADES)) assert.ok(['BLOQUEIA', 'LIMITA', 'INFORMATIVO'].includes(severidade), codigo);
    for (const codigo of ['CATALOGO_INVALIDO', 'RAIZ_PROTEGIDA_NAO_RESOLVIDA', 'RAIZ_PROTEGIDA_PERMISSAO', 'RAIZES_SOBREPOSTAS_REAL', 'RAIZ_MUDOU_DURANTE_OPERACAO', 'JANELA_NAO_OBTIDA', 'EMAIL_ARQUIVO_EM_AMBIENTE_REAL']) {
      assert.equal(severidadeDe(codigo), 'BLOQUEIA', codigo);
    }
    for (const codigo of ['RAIZ_SEM_REGISTRO', 'FONTE_PENDENTE', 'IMPLEMENTADA_NAO_COMPROVADA', 'SUSPENSA', 'RAIZES_SOBREPOSTAS_NAO_PROTEGIDAS', 'NIVEL_N0', 'SUMARIO_TRUNCADO']) {
      assert.equal(severidadeDe(codigo), 'LIMITA', codigo);
    }
    assert.equal(severidadeDe('RAIZ_NAO_PROTEGIDA_AUSENTE'), 'INFORMATIVO');
    for (const desconhecido of ['CODIGO_QUE_NAO_EXISTE', '', undefined, null, 7, '__proto__', 'toString']) assert.equal(severidadeDe(desconhecido), 'BLOQUEIA');
  });
});

describe('S1/S2 — pureza do módulo', () => {
  test('U21 — o módulo não depende de banco, rede, processos nem do sistema de arquivos', () => {
    const texto = fs.readFileSync(ARQUIVO_REGRAS, 'utf8');
    const requeridos = [...texto.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(requeridos.length > 0);
    for (const modulo of requeridos) assert.ok(['node:crypto', 'node:path'].includes(modulo), `dependência não permitida: ${modulo}`);
  });

  test('U22 — o módulo não lê variáveis de ambiente', () => {
    assert.doesNotMatch(fs.readFileSync(ARQUIVO_REGRAS, 'utf8'), /process\.env/);
  });
});
