'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

/**
 * Registro de fontes persistentes do backup (D-ORF-6, P1): regras PURAS, sem leitura de ambiente, banco, rede ou disco.
 * Quatro eixos independentes: tipo, classe, implementação dos componentes e cobertura DERIVADA. Registrar não é proteger:
 * a cobertura nunca é escrita à mão e a declaração nunca excede o que foi verificado. Erros levam só códigos, ids e nomes
 * de campo fixos, nunca valores recebidos.
 */

const TIPOS = Object.freeze(['ARQUIVOS', 'POSTGRES']);
const CLASSES = Object.freeze(['PROTEGIDA', 'DERIVAVEL', 'EFEMERA', 'EXCLUIDA']);
const RELEVANCIAS = Object.freeze(['PERSISTENTE_RELEVANTE', 'PERSISTENTE_DE_BAIXO_VALOR', 'NAO_PERSISTENTE', 'POLITICA_SEGURANCA']);
const PERSISTENCIAS_FISICAS = Object.freeze(['SIM', 'NAO', 'DEPENDE_DO_AMBIENTE']);
const RISCOS_RESIDUAIS = Object.freeze(['DADO_PESSOAL', 'DADO_PESSOAL_E_TOKENS', 'TRAVA_OBSOLETA_BLOQUEIA_OPERACAO', 'SEGREDO_FORA_DO_PACOTE_REQUER_CUSTODIA']);
const CATEGORIAS_DE_SEGREDO = Object.freeze(['CREDENCIAL', 'CHAVE_PRIVADA', 'SEGREDO_DE_APLICACAO', 'ARQUIVO_DE_AMBIENTE']);
const ESCOPOS = Object.freeze(['EMPRESA', 'GLOBAL', 'MISTO']);
const REGRAS_DE_EMPRESA = Object.freeze(['SEGMENTO_INICIAL_DA_CHAVE', 'COLUNA_EMPRESA_ID']);
const MUTABILIDADES = Object.freeze(['IMUTAVEL_POR_CONTEUDO', 'VERSIONADA', 'MUTAVEL']);
const SENSIBILIDADES = Object.freeze(['INTERNO', 'PESSOAL', 'PESSOAL_SENSIVEL', 'SEGREDO']);
const REMOCOES = Object.freeze(['JANELA_LIMPEZA', 'SOMENTE_NAO_REFERENCIADOS', 'NENHUMA']);
const JANELAS = Object.freeze(['UNICA', 'NAO_APLICAVEL']);
const COMPONENTES = Object.freeze(['planejador', 'copiador', 'verificador', 'restaurador']);
const ESTADOS_DE_COMPONENTE = Object.freeze(['AUSENTE', 'PARCIAL', 'PRESENTE']);
const VERIFICADORES = Object.freeze(['imagens-consistencia-v1', 'postgres-estrutura-v1', 'fiscalizacao-pacotes-consistencia-v1']);
const NIVEIS_POSTGRES = Object.freeze(['N0', 'N1', 'N2a', 'N2b', 'N3']);
const NIVEIS_SUFICIENTES = Object.freeze(['N1', 'N2a', 'N2b', 'N3']);
const DECISOES_PENDENTES = Object.freeze(Array.from({ length: 17 }, (_, i) => `D-F${i + 1}`));
const DECISOES_VALIDAS = Object.freeze([...DECISOES_PENDENTES, 'P0-CF-1', 'P0-CF-2', 'P0-CF-3']);
const FORMATOS_DE_CHAVE = Object.freeze({
  'imagem-v1': /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/,
  // D-F1 (P3): a chave do ZIP da Fiscalização é montada SÓ com inteiros do servidor (storage/armazenamento-local.js, CHAVE_FORMATO).
  'fiscalizacao-v1': /^[1-9][0-9]{0,14}\/pacote-[1-9][0-9]{0,14}\.zip$/,
});
const LIMITE_DE_FONTES = 16;

const ID = /^[a-z0-9-]{1,40}$/;
const PAPEL = /^[A-Z][A-Z0-9_]{1,59}$/;
const VARIAVEL = /^[A-Z][A-Z0-9_]{2,63}$/;
const NOME_PROIBIDO = /SENHA|SECRET|TOKEN|PASSWORD|PASSWD|PGPASSFILE|PRIVATE/;
const IDENTIFICADOR_SQL = /^[a-z][a-z0-9_]{0,62}$/;
const CAMINHO_RELATIVO = /^[A-Za-z0-9._/-]{1,200}$/;
const CODIGO = /^[A-Z][A-Z0-9_]{2,40}$/;
const DECISAO_DE_PROMOCAO = /^PROMOCAO-[a-z0-9-]{1,40}$/;
const CONTROLE = /[\u0000-\u001f\u007f]/;

const CHAVES_DA_FONTE = Object.freeze([
  'id', 'tipo', 'classe', 'decisaoPendente', 'recomendacao', 'decisaoRef', 'justificativa', 'relevancia', 'persistenciaFisica', 'riscoResidual',
  'categoriaDeSegredo', 'recuperacao', 'responsavel', 'aprovador', 'raiz', 'chave', 'verificadorId', 'escopo', 'referencias', 'mutabilidade',
  'sensibilidade', 'remocao', 'componentes', 'reconstrucao', 'promocao', 'suspensao', 'versaoContrato',
]);

const SEVERIDADES = Object.freeze({
  CATALOGO_INVALIDO: 'BLOQUEIA',
  RAIZ_PROTEGIDA_NAO_RESOLVIDA: 'BLOQUEIA',
  RAIZ_PROTEGIDA_PERMISSAO: 'BLOQUEIA',
  RAIZES_SOBREPOSTAS_REAL: 'BLOQUEIA',
  RAIZES_SOBREPOSTAS_LEXICO: 'BLOQUEIA',
  RAIZ_MUDOU_DURANTE_OPERACAO: 'BLOQUEIA',
  JANELA_NAO_OBTIDA: 'BLOQUEIA',
  FALHA_DE_HASH_OU_COPIA: 'BLOQUEIA',
  EMAIL_ARQUIVO_EM_AMBIENTE_REAL: 'BLOQUEIA',
  RAIZ_SEM_REGISTRO: 'LIMITA',
  FONTE_PENDENTE: 'LIMITA',
  IMPLEMENTADA_NAO_COMPROVADA: 'LIMITA',
  SUSPENSA: 'LIMITA',
  RAIZES_SOBREPOSTAS_NAO_PROTEGIDAS: 'LIMITA',
  NIVEL_N0: 'LIMITA',
  SUMARIO_TRUNCADO: 'LIMITA',
  RAIZ_NAO_PROTEGIDA_AUSENTE: 'INFORMATIVO',
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const texto = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROLE.test(v);
const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });
const congelar = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const filho of Object.values(v)) congelar(filho);
  }
  return v;
};
const porId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const porTabela = (a, b) => (a.tabela < b.tabela ? -1 : a.tabela > b.tabela ? 1 : 0);
const caminhoSeguro = (v) => typeof v === 'string' && CAMINHO_RELATIVO.test(v) && !v.startsWith('/') && !v.split('/').includes('..');
const dataValida = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [a, m, d] = v.split('-').map(Number);
  const data = new Date(Date.UTC(a, m - 1, d));
  return data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
};
const mesmasChaves = (obj, esperadas) => {
  const chaves = Reflect.ownKeys(obj);
  return chaves.length === esperadas.length && esperadas.every((c) => chaves.includes(c));
};

const promocaoValida = (p) => ehObjeto(p) && mesmasChaves(p, ['decisao', 'evidencias', 'aprovadoEm'])
  && typeof p.decisao === 'string' && DECISAO_DE_PROMOCAO.test(p.decisao)
  && Array.isArray(p.evidencias) && p.evidencias.length >= 1 && p.evidencias.length <= 10 && p.evidencias.every((e) => texto(e, 200))
  && dataValida(p.aprovadoEm);

const componentesIncompletos = (c) => !ehObjeto(c) || COMPONENTES.some((n) => !ehObjeto(c[n]) || c[n].estado !== 'PRESENTE');

function validarComponente(c, e) {
  if (!ehObjeto(c) || !mesmasChaves(c, ['estado', 'modulo', 'teste'])) return e('COMPONENTE_INVALIDO', 'componentes');
  if (!ESTADOS_DE_COMPONENTE.includes(c.estado)) return e('COMPONENTE_INVALIDO', 'componentes');
  const moduloOk = caminhoSeguro(c.modulo);
  const testeOk = caminhoSeguro(c.teste);
  const coerente = c.estado === 'AUSENTE' ? c.modulo === null && c.teste === null
    : c.estado === 'PARCIAL' ? moduloOk && (c.teste === null || testeOk)
      : moduloOk && testeOk;
  return coerente ? undefined : e('COMPONENTE_INCOERENTE', 'componentes');
}

function validarFonte(f, add) {
  if (!ehObjeto(f)) { add('FONTE_FORMATO', null, null); return; }
  const id = typeof f.id === 'string' && ID.test(f.id) ? f.id : null;
  const e = (codigo, campo) => add(codigo, id, campo);

  for (const c of Reflect.ownKeys(f)) if (!CHAVES_DA_FONTE.includes(c)) e('CAMPO_DESCONHECIDO', null);
  const ausentes = CHAVES_DA_FONTE.filter((c) => !Reflect.ownKeys(f).includes(c));
  if (ausentes.length > 0) { for (const c of ausentes) e('CAMPO_AUSENTE', c); return; }

  if (id === null) e('ID_INVALIDO', 'id');
  if (!TIPOS.includes(f.tipo)) e('TIPO_INVALIDO', 'tipo');
  if (f.classe !== null && !CLASSES.includes(f.classe)) e('CLASSE_INVALIDA', 'classe');
  const classe = f.classe === null || CLASSES.includes(f.classe) ? f.classe : undefined;
  const efemeraOuExcluida = classe === 'EFEMERA' || classe === 'EXCLUIDA';
  const seguranca = classe === 'EXCLUIDA' && f.relevancia === 'POLITICA_SEGURANCA';

  if (classe === null) {
    if (!DECISOES_PENDENTES.includes(f.decisaoPendente)) e('DECISAO_PENDENTE_AUSENTE', 'decisaoPendente');
    if (f.recomendacao !== null && !CLASSES.includes(f.recomendacao)) e('RECOMENDACAO_INVALIDA', 'recomendacao');
    if (f.decisaoRef !== null) e('DECISAO_REF_INDEVIDA', 'decisaoRef');
  } else if (classe !== undefined) {
    if (f.decisaoPendente !== null) e('DECISAO_PENDENTE_COM_CLASSE', 'decisaoPendente');
    if (f.recomendacao !== null) e('RECOMENDACAO_INDEVIDA', 'recomendacao');
    if (f.decisaoRef !== null && !DECISOES_VALIDAS.includes(f.decisaoRef)) e('DECISAO_REF_INVALIDA', 'decisaoRef');
    if (['EFEMERA', 'EXCLUIDA', 'DERIVAVEL'].includes(classe)) {
      if (f.decisaoRef === null) e('DECISAO_REF_OBRIGATORIA', 'decisaoRef');
      if (!texto(f.justificativa)) e('JUSTIFICATIVA_OBRIGATORIA', 'justificativa');
    }
  }
  if (f.justificativa !== null && !texto(f.justificativa)) e('JUSTIFICATIVA_INVALIDA', 'justificativa');

  if (f.relevancia !== null && !RELEVANCIAS.includes(f.relevancia)) e('RELEVANCIA_INVALIDA', 'relevancia');
  if (efemeraOuExcluida && f.relevancia === null) e('RELEVANCIA_OBRIGATORIA', 'relevancia');
  if (f.persistenciaFisica !== null && !PERSISTENCIAS_FISICAS.includes(f.persistenciaFisica)) e('PERSISTENCIA_FISICA_INVALIDA', 'persistenciaFisica');
  if (efemeraOuExcluida && f.persistenciaFisica === null) e('PERSISTENCIA_FISICA_OBRIGATORIA', 'persistenciaFisica');
  if (f.riscoResidual !== null && !RISCOS_RESIDUAIS.includes(f.riscoResidual)) e('RISCO_RESIDUAL_INVALIDO', 'riscoResidual');
  if ((efemeraOuExcluida || classe === null) && ['SIM', 'DEPENDE_DO_AMBIENTE'].includes(f.persistenciaFisica) && f.riscoResidual === null) {
    e('RISCO_RESIDUAL_OBRIGATORIO', 'riscoResidual');
  }

  if (seguranca) {
    if (!CATEGORIAS_DE_SEGREDO.includes(f.categoriaDeSegredo)) e('CATEGORIA_DE_SEGREDO_OBRIGATORIA', 'categoriaDeSegredo');
    const r = f.recuperacao;
    if (!(ehObjeto(r) && mesmasChaves(r, ['procedimento', 'decisao']) && r.procedimento === 'INDEPENDENTE' && r.decisao === 'D-F5')) {
      e('RECUPERACAO_INDEPENDENTE_OBRIGATORIA', 'recuperacao');
    }
    if ((Array.isArray(f.referencias) && f.referencias.length > 0) || (ehObjeto(f.escopo) && f.escopo.tipo !== 'GLOBAL')) {
      e('EXCLUSAO_SEGURANCA_DE_DADO_DE_NEGOCIO', 'relevancia');
    }
  } else {
    if (f.categoriaDeSegredo !== null) e('CATEGORIA_DE_SEGREDO_INDEVIDA', 'categoriaDeSegredo');
    if (f.recuperacao !== null) e('RECUPERACAO_INDEVIDA', 'recuperacao');
  }

  if (!(typeof f.responsavel === 'string' && PAPEL.test(f.responsavel))) e('RESPONSAVEL_OBRIGATORIO', 'responsavel');
  if (!(typeof f.aprovador === 'string' && PAPEL.test(f.aprovador))) e('APROVADOR_OBRIGATORIO', 'aprovador');

  const arquivosProtegida = f.tipo === 'ARQUIVOS' && classe === 'PROTEGIDA';
  if (!ehObjeto(f.raiz) || !mesmasChaves(f.raiz, ['variavel'])) e('RAIZ_FORMATO', 'raiz');
  else {
    const v = f.raiz.variavel;
    if (v !== null && !(typeof v === 'string' && VARIAVEL.test(v))) e('RAIZ_NOME_INVALIDO', 'raiz');
    else if (typeof v === 'string' && NOME_PROIBIDO.test(v)) e('RAIZ_NOME_PROIBIDO', 'raiz');
    if (f.tipo === 'POSTGRES' && v !== null) e('POSTGRES_COM_RAIZ', 'raiz');
    if (arquivosProtegida && v === null) e('RAIZ_OBRIGATORIA', 'raiz');
  }

  if (!ehObjeto(f.chave) || !mesmasChaves(f.chave, ['formatoChaveId'])) e('CHAVE_FORMATO', 'chave');
  else {
    const fid = f.chave.formatoChaveId;
    if (fid !== null && !(typeof fid === 'string' && Object.hasOwn(FORMATOS_DE_CHAVE, fid))) e('FORMATO_DE_CHAVE_DESCONHECIDO', 'chave');
    if (arquivosProtegida && fid === null) e('FORMATO_DE_CHAVE_OBRIGATORIO', 'chave');
    if (f.tipo === 'POSTGRES' && fid !== null) e('POSTGRES_COM_CHAVE', 'chave');
  }

  if (f.verificadorId !== null && !VERIFICADORES.includes(f.verificadorId)) e('VERIFICADOR_DESCONHECIDO', 'verificadorId');
  if (classe === 'PROTEGIDA' && f.verificadorId === null) e('VERIFICADOR_OBRIGATORIO', 'verificadorId');

  if (!ehObjeto(f.escopo) || !mesmasChaves(f.escopo, ['tipo', 'regraEmpresa'])) e('ESCOPO_INVALIDO', 'escopo');
  else if (!ESCOPOS.includes(f.escopo.tipo)) e('ESCOPO_INVALIDO', 'escopo');
  else if (f.escopo.regraEmpresa !== null && !REGRAS_DE_EMPRESA.includes(f.escopo.regraEmpresa)) e('ESCOPO_REGRA_INVALIDA', 'escopo');
  else if (f.escopo.tipo !== 'GLOBAL' && f.escopo.regraEmpresa === null) e('ESCOPO_SEM_REGRA_DE_EMPRESA', 'escopo');
  else if (f.escopo.tipo === 'GLOBAL' && f.escopo.regraEmpresa !== null) e('ESCOPO_GLOBAL_COM_REGRA', 'escopo');

  const refOk = (r) => ehObjeto(r) && mesmasChaves(r, ['tabela', 'colunas']) && typeof r.tabela === 'string' && IDENTIFICADOR_SQL.test(r.tabela)
    && Array.isArray(r.colunas) && r.colunas.length >= 1 && r.colunas.length <= 30 && r.colunas.every((c) => typeof c === 'string' && IDENTIFICADOR_SQL.test(c));
  if (!Array.isArray(f.referencias) || f.referencias.length > 20 || !f.referencias.every(refOk)) e('REFERENCIA_INVALIDA', 'referencias');

  if (!MUTABILIDADES.includes(f.mutabilidade)) e('MUTABILIDADE_INVALIDA', 'mutabilidade');
  else if (classe === 'PROTEGIDA' && f.mutabilidade === 'MUTAVEL') e('PROTEGIDA_MUTAVEL', 'mutabilidade');
  if (!SENSIBILIDADES.includes(f.sensibilidade)) e('SENSIBILIDADE_INVALIDA', 'sensibilidade');

  if (!ehObjeto(f.remocao) || !mesmasChaves(f.remocao, ['fisica', 'janela'])) e('REMOCAO_INVALIDA', 'remocao');
  else {
    if (!REMOCOES.includes(f.remocao.fisica)) e('REMOCAO_INVALIDA', 'remocao');
    if (!JANELAS.includes(f.remocao.janela)) e('JANELA_INVALIDA', 'remocao');
  }

  if (!ehObjeto(f.componentes) || !mesmasChaves(f.componentes, COMPONENTES)) e('COMPONENTE_INVALIDO', 'componentes');
  else {
    for (const n of COMPONENTES) validarComponente(f.componentes[n], e);
    const algum = COMPONENTES.some((n) => ehObjeto(f.componentes[n]) && f.componentes[n].estado !== 'AUSENTE');
    if (algum && ['EFEMERA', 'EXCLUIDA', 'DERIVAVEL'].includes(classe)) e('COMPONENTES_NAO_SE_APLICAM', 'componentes');
  }

  if (classe === 'DERIVAVEL') {
    const r = f.reconstrucao;
    if (!(ehObjeto(r) && mesmasChaves(r, ['comprovada', 'evidencia']) && r.comprovada === true && texto(r.evidencia, 200))) e('DERIVAVEL_SEM_PROVA', 'reconstrucao');
  } else if (f.reconstrucao !== null) e('RECONSTRUCAO_INDEVIDA', 'reconstrucao');

  if (f.promocao !== null) {
    if (!promocaoValida(f.promocao)) e('PROMOCAO_INVALIDA', 'promocao');
    if (classe !== 'PROTEGIDA') e('PROMOCAO_FORA_DE_PROTEGIDA', 'promocao');
    else if (componentesIncompletos(f.componentes)) e('PROMOCAO_COM_COMPONENTE_INCOMPLETO', 'promocao');
  }
  if (f.suspensao !== null) {
    const s = f.suspensao;
    if (!(ehObjeto(s) && mesmasChaves(s, ['motivo', 'desde']) && typeof s.motivo === 'string' && CODIGO.test(s.motivo) && dataValida(s.desde))) e('SUSPENSAO_INVALIDA', 'suspensao');
  }
  if (!(Number.isInteger(f.versaoContrato) && f.versaoContrato >= 1)) e('VERSAO_CONTRATO_INVALIDA', 'versaoContrato');
}

function validarCatalogo(catalogo) {
  const erros = [];
  const add = (codigo, fonteId, campo) => erros.push(Object.freeze({ codigo, fonteId, campo }));
  const formatoOk = ehObjeto(catalogo) && mesmasChaves(catalogo, ['versao', 'fontes']) && Number.isInteger(catalogo.versao) && catalogo.versao >= 1
    && Array.isArray(catalogo.fontes) && catalogo.fontes.length >= 1;
  if (!formatoOk) {
    add('CATALOGO_FORMATO', null, null);
    return congelar({ valido: false, erros });
  }
  if (catalogo.fontes.length > LIMITE_DE_FONTES) add('LIMITE_DE_FONTES', null, null);
  for (const fonte of catalogo.fontes) validarFonte(fonte, add);

  const vistos = new Set();
  const raizes = new Set();
  for (const fonte of catalogo.fontes) {
    if (!ehObjeto(fonte)) continue;
    if (typeof fonte.id === 'string' && ID.test(fonte.id)) {
      if (vistos.has(fonte.id)) add('ID_DUPLICADO', fonte.id, 'id');
      vistos.add(fonte.id);
    }
    const v = ehObjeto(fonte.raiz) ? fonte.raiz.variavel : null;
    if (typeof v === 'string' && VARIAVEL.test(v)) {
      if (raizes.has(v)) add('RAIZ_DUPLICADA', typeof fonte.id === 'string' && ID.test(fonte.id) ? fonte.id : null, 'raiz');
      raizes.add(v);
    }
  }
  return congelar({ valido: erros.length === 0, erros });
}

const invalido = (resultado) => Object.assign(erro('CATALOGO_INVALIDO', 'catálogo inválido'), { erros: resultado.erros });
const exigirValido = (catalogo) => {
  const resultado = validarCatalogo(catalogo);
  if (!resultado.valido) throw invalido(resultado);
};

const registradas = new WeakSet();
function selarCatalogo(catalogo) {
  exigirValido(catalogo);
  const selado = congelar(structuredClone(catalogo));
  registradas.add(selado);
  for (const fonte of selado.fontes) registradas.add(fonte);
  return selado;
}
const ehFonteRegistrada = (objeto) => objeto !== null && typeof objeto === 'object' && registradas.has(objeto);

function estadoImplementacao(fonte) {
  const estados = COMPONENTES.map((n) => fonte?.componentes?.[n]?.estado ?? 'AUSENTE');
  if (estados.every((s) => s === 'AUSENTE')) return 'NENHUMA';
  return estados.every((s) => s === 'PRESENTE') ? 'COMPLETA' : 'PARCIAL';
}

function estadoDeCobertura(fonte) {
  if (!ehObjeto(fonte)) throw erro('FONTE_INVALIDA', 'fonte inválida');
  if (fonte.suspensao !== null && fonte.suspensao !== undefined) return 'SUSPENSA';
  switch (fonte.classe) {
    case 'EFEMERA': return 'DECLARADA_EFEMERA';
    case 'EXCLUIDA': return 'DECLARADA_EXCLUIDA';
    case 'DERIVAVEL': return fonte.reconstrucao?.comprovada === true ? 'DERIVAVEL_COMPROVADA' : 'PENDENTE_DECISAO';
    case 'PROTEGIDA': {
      const impl = estadoImplementacao(fonte);
      if (impl === 'NENHUMA') return 'CANDIDATA';
      if (impl === 'PARCIAL') return 'IMPLEMENTACAO_PARCIAL';
      return promocaoValida(fonte.promocao) ? 'PROTEGIDA_COMPROVADA' : 'IMPLEMENTADA_NAO_COMPROVADA';
    }
    default: return 'PENDENTE_DECISAO';
  }
}

const COBERTAS = new Set(['PROTEGIDA_COMPROVADA', 'DERIVAVEL_COMPROVADA']);
const ESTADOS_PENDENTES = new Set(['PENDENTE_DECISAO', 'CANDIDATA', 'IMPLEMENTACAO_PARCIAL', 'IMPLEMENTADA_NAO_COMPROVADA', 'SUSPENSA']);
const incluidaNoPacote = (fonte) => estadoDeCobertura(fonte) === 'PROTEGIDA_COMPROVADA';

const componentesPendentes = (fonte) => COMPONENTES.filter((n) => (fonte.componentes?.[n]?.estado ?? 'AUSENTE') !== 'PRESENTE')
  .map((n) => `${(fonte.componentes?.[n]?.estado ?? 'AUSENTE') === 'AUSENTE' ? 'COMPONENTE_AUSENTE' : 'COMPONENTE_PARCIAL'}:${n}`);

function motivoForaDoPacote(fonte) {
  const estado = estadoDeCobertura(fonte);
  switch (estado) {
    case 'PROTEGIDA_COMPROVADA': return null;
    case 'PENDENTE_DECISAO': return 'CLASSE_NAO_DECIDIDA';
    case 'CANDIDATA':
    case 'IMPLEMENTACAO_PARCIAL': return componentesPendentes(fonte)[0];
    case 'IMPLEMENTADA_NAO_COMPROVADA': return 'NAO_COMPROVADA';
    default: return estado;
  }
}

function pendenciasDeCobertura(catalogo) {
  exigirValido(catalogo);
  const saida = [];
  for (const fonte of [...catalogo.fontes].sort(porId)) {
    const estado = estadoDeCobertura(fonte);
    const adiciona = (codigo) => saida.push(Object.freeze({ fonteId: fonte.id, estadoCobertura: estado, codigo }));
    if (estado === 'PENDENTE_DECISAO') adiciona('CLASSE_NAO_DECIDIDA');
    else if (estado === 'CANDIDATA' || estado === 'IMPLEMENTACAO_PARCIAL') componentesPendentes(fonte).forEach(adiciona);
    else if (estado === 'IMPLEMENTADA_NAO_COMPROVADA') adiciona('NAO_COMPROVADA');
    else if (estado === 'SUSPENSA') adiciona('SUSPENSA');
    else if (estado === 'DECLARADA_EXCLUIDA' && fonte.relevancia === 'PERSISTENTE_RELEVANTE') adiciona('EXCLUSAO_RELEVANTE');
  }
  return congelar(saida);
}

function normalizarContexto(contexto) {
  if (contexto === undefined) return {};
  if (!ehObjeto(contexto)) return null;
  const permitidas = ['raizesConfiguradas', 'nivelPostgres', 'resultadosDinamicos'];
  if (!Reflect.ownKeys(contexto).every((c) => permitidas.includes(c))) return null;
  const { raizesConfiguradas, nivelPostgres, resultadosDinamicos } = contexto;
  if (raizesConfiguradas !== undefined && !(Array.isArray(raizesConfiguradas) && raizesConfiguradas.length <= 200
    && raizesConfiguradas.every((n) => typeof n === 'string' && VARIAVEL.test(n)))) return null;
  if (nivelPostgres !== undefined && !NIVEIS_POSTGRES.includes(nivelPostgres)) return null;
  if (resultadosDinamicos !== undefined && !(ehObjeto(resultadosDinamicos)
    && Object.entries(resultadosDinamicos).every(([k, v]) => ID.test(k) && ['APROVADO', 'REPROVADO'].includes(v)))) return null;
  return contexto;
}

function avaliarCobertura(catalogo, contexto) {
  const motivos = new Set();
  const fim = (teto) => congelar({ teto, motivos: [...motivos].sort() });
  if (!validarCatalogo(catalogo).valido) {
    motivos.add('CATALOGO_INVALIDO');
    return fim('NAO_COMPROVADA');
  }
  const ctx = normalizarContexto(contexto);
  if (ctx === null) {
    motivos.add('CONTEXTO_INVALIDO');
    return fim('NAO_COMPROVADA');
  }

  let efetivas = 0;
  for (const fonte of [...catalogo.fontes].sort(porId)) {
    const estado = estadoDeCobertura(fonte);
    if (COBERTAS.has(estado)) {
      const dinamica = ctx.resultadosDinamicos && Object.hasOwn(ctx.resultadosDinamicos, fonte.id) ? ctx.resultadosDinamicos[fonte.id] : undefined;
      if (dinamica === 'APROVADO') {
        if (fonte.tipo === 'POSTGRES' && !NIVEIS_SUFICIENTES.includes(ctx.nivelPostgres)) motivos.add(`NIVEL_POSTGRES_INSUFICIENTE:${fonte.id}`);
        else efetivas += 1;
      } else motivos.add(`${dinamica === 'REPROVADO' ? 'DINAMICA_REPROVADA' : 'DINAMICA_AUSENTE'}:${fonte.id}`);
    } else if (ESTADOS_PENDENTES.has(estado)) motivos.add(`PENDENCIA:${fonte.id}`);
    else if (estado === 'DECLARADA_EXCLUIDA' && fonte.relevancia === 'PERSISTENTE_RELEVANTE') motivos.add(`EXCLUSAO_RELEVANTE:${fonte.id}`);
  }
  if (ctx.raizesConfiguradas === undefined) motivos.add('UNIVERSO_NAO_VERIFICADO');
  else {
    const registradasNoCatalogo = new Set(catalogo.fontes.map((f) => f.raiz.variavel).filter((v) => v !== null));
    if (ctx.raizesConfiguradas.some((n) => !registradasNoCatalogo.has(n))) motivos.add('RAIZ_SEM_REGISTRO');
  }
  if (!catalogo.fontes.some((f) => f.tipo === 'POSTGRES' && f.classe === 'PROTEGIDA')) motivos.add('FONTE_RELEVANTE_AUSENTE');
  if (efetivas === 0) {
    motivos.add('NENHUMA_FONTE_COMPROVADA');
    return fim('NAO_COMPROVADA');
  }
  return fim(motivos.size === 0 ? 'COMPLETA' : 'PARCIAL');
}
const tetoDeDeclaracao = (catalogo, contexto) => avaliarCobertura(catalogo, contexto).teto;

const canonico = (valor) => {
  if (valor === null) return 'null';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor)) throw erro('VALOR_NAO_SERIALIZAVEL', 'valor não serializável');
    return String(valor);
  }
  if (typeof valor === 'string') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (ehObjeto(valor)) return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  throw erro('VALOR_NAO_SERIALIZAVEL', 'valor não serializável');
};

const referenciasOrdenadas = (referencias) => [...referencias].sort(porTabela).map((r) => ({ tabela: r.tabela, colunas: [...r.colunas].sort() }));

function serializarCatalogo(catalogo) {
  exigirValido(catalogo);
  const fontes = [...catalogo.fontes].sort(porId).map((f) => ({
    ...structuredClone(f),
    referencias: referenciasOrdenadas(f.referencias),
    promocao: f.promocao === null ? null : { ...f.promocao, evidencias: [...f.promocao.evidencias].sort() },
  }));
  return canonico({ versao: catalogo.versao, fontes });
}
const hashCatalogo = (catalogo) => crypto.createHash('sha256').update(serializarCatalogo(catalogo), 'utf8').digest('hex');

function projetarParaManifesto(catalogo) {
  exigirValido(catalogo);
  const fontes = [...catalogo.fontes].sort(porId).map((f) => ({
    id: f.id,
    tipo: f.tipo,
    classe: f.classe,
    estadoCobertura: estadoDeCobertura(f),
    incluida: incluidaNoPacote(f),
    motivo: motivoForaDoPacote(f),
    versaoContrato: f.versaoContrato,
    formatoChaveId: f.chave.formatoChaveId,
    verificadorId: f.verificadorId,
    escopo: { tipo: f.escopo.tipo, regraEmpresa: f.escopo.regraEmpresa },
    referencias: referenciasOrdenadas(f.referencias),
  }));
  return congelar({ versao: catalogo.versao, sha256: hashCatalogo(catalogo), fontes });
}

const caminhoInvalido = () => erro('CAMINHO_INVALIDO', 'caminho inválido');
function normalizarCaminho(caminho) {
  if (typeof caminho !== 'string' || caminho.length === 0 || caminho.includes('\0') || !caminho.startsWith('/')) throw caminhoInvalido();
  const n = path.posix.normalize(caminho);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}
function compararRaizesLexico(a, b) {
  const x = normalizarCaminho(a);
  const y = normalizarCaminho(b);
  if (x === y) return 'IGUAL';
  if (x === '/' || y.startsWith(`${x}/`)) return 'ANCESTRAL';
  if (y === '/' || x.startsWith(`${y}/`)) return 'DESCENDENTE';
  return 'DISJUNTA';
}
function detectarSobreposicoesLexicas(entradas) {
  if (!Array.isArray(entradas) || !entradas.every((e) => ehObjeto(e) && typeof e.id === 'string' && ID.test(e.id))) throw erro('ENTRADAS_INVALIDAS', 'entradas inválidas');
  const saida = [];
  const validas = [];
  for (const entrada of entradas) {
    try { validas.push({ id: entrada.id, caminho: normalizarCaminho(entrada.caminho) }); } catch {
      saida.push(Object.freeze({ a: entrada.id, b: null, relacao: null, codigo: 'CAMINHO_INVALIDO', validacao: 'LEXICA' }));
    }
  }
  for (let i = 0; i < validas.length; i += 1) {
    for (let j = i + 1; j < validas.length; j += 1) {
      const relacao = compararRaizesLexico(validas[i].caminho, validas[j].caminho);
      if (relacao !== 'DISJUNTA') saida.push(Object.freeze({ a: validas[i].id, b: validas[j].id, relacao, codigo: 'RAIZES_SOBREPOSTAS_LEXICO', validacao: 'LEXICA' }));
    }
  }
  return congelar(saida);
}

const severidadeDe = (codigo) => (typeof codigo === 'string' && Object.hasOwn(SEVERIDADES, codigo) ? SEVERIDADES[codigo] : 'BLOQUEIA');

const RISCOS_EM_TEXTO = Object.freeze({
  DADO_PESSOAL: 'dado pessoal',
  DADO_PESSOAL_E_TOKENS: 'dado pessoal e tokens',
  TRAVA_OBSOLETA_BLOQUEIA_OPERACAO: 'trava obsoleta que bloqueia a operação',
  SEGREDO_FORA_DO_PACOTE_REQUER_CUSTODIA: 'segredo fora do pacote, que exige custódia própria',
});
function descreverPoliticaDeRecuperacao(fonte) {
  if (!ehObjeto(fonte)) throw erro('FONTE_INVALIDA', 'fonte inválida');
  const partes = [];
  switch (fonte.classe) {
    case 'PROTEGIDA': partes.push('Política de recuperação: fonte a proteger no backup; só conta como coberta depois de comprovada.'); break;
    case 'DERIVAVEL': partes.push('Política de recuperação: reconstruída a partir de fonte protegida.'); break;
    case 'EFEMERA': partes.push('Política de recuperação: não será copiada nem restaurada; sem valor de recuperação.'); break;
    case 'EXCLUIDA': partes.push('Política de recuperação: excluída do pacote de dados da aplicação por decisão registrada.'); break;
    default: partes.push('Política de recuperação: classe ainda não decidida; a fonte não está protegida.');
  }
  if (fonte.recuperacao) partes.push('Sua recuperação independente segue procedimento próprio, fora do pacote.');
  if (fonte.persistenciaFisica === 'SIM') partes.push('Existência física: fisicamente persistente em disco até remoção explícita.');
  else if (fonte.persistenciaFisica === 'DEPENDE_DO_AMBIENTE') partes.push('Existência física: pode estar fisicamente persistente conforme o ambiente.');
  else if (fonte.persistenciaFisica === 'NAO') partes.push('Existência física: não permanece em disco.');
  if (fonte.riscoResidual) partes.push(`Risco residual: ${RISCOS_EM_TEXTO[fonte.riscoResidual] ?? 'a classificar'}.`);
  return partes.join(' ');
}

module.exports = {
  TIPOS, CLASSES, RELEVANCIAS, PERSISTENCIAS_FISICAS, RISCOS_RESIDUAIS, CATEGORIAS_DE_SEGREDO, ESCOPOS, REGRAS_DE_EMPRESA, MUTABILIDADES,
  SENSIBILIDADES, REMOCOES, JANELAS, COMPONENTES, VERIFICADORES, NIVEIS_POSTGRES, DECISOES_PENDENTES, DECISOES_VALIDAS, FORMATOS_DE_CHAVE,
  LIMITE_DE_FONTES, SEVERIDADES,
  validarCatalogo, selarCatalogo, ehFonteRegistrada, estadoImplementacao, estadoDeCobertura, incluidaNoPacote, motivoForaDoPacote,
  pendenciasDeCobertura, avaliarCobertura, tetoDeDeclaracao, serializarCatalogo, hashCatalogo, projetarParaManifesto,
  compararRaizesLexico, detectarSobreposicoesLexicas, severidadeDe, descreverPoliticaDeRecuperacao,
};
