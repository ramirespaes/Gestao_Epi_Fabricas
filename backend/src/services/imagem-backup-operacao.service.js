'use strict';

const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('./imagem-backup-composicao-producao.service');
const { lerSituacao } = require('./imagem-backup-registro-publicacao.service');
const { ehJanelaDeBackup } = require('./imagem-backup.service');
const { DESTINOS_OPERACIONAIS_AUTORIZADOS } = require('./imagem-backup-publicacao.service');
const { ehAvaliacaoReconhecida } = require('./imagem-backup-proveniencia-restauracao.service');
const { REGISTRO_DE_EXECUCOES } = require('./imagem-backup-execucoes.service');
const { ehChaveiro } = require('./imagem-backup-chaveiro.service');
const { ehDestinoValidado } = require('./imagem-backup-destinos.service');
const { inspecionarArmazenamento, fotografar, avaliarConsistencia, GARANTIA_CONTRA_ESCRITORES_EXTERNOS, CONTROLES_EXTERNOS_APROVADOS } = require('./imagem-backup-escritores.service');
const { classificarDurabilidade } = require('./imagem-backup-durabilidade.service');
const { ehCoordenadorCompartilhado } = require('./imagem-backup-coordenacao.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): PONTO DE ENTRADA INTERNO DA OPERAÇÃO de backup e restauração. Não é rota, interface, agendador nem script: é uma fábrica que LIGA a composição de produção já existente (coordenador, supervisor, PIPE_COM_HASH, T1/T2, janela PRT-07,
 * manifesto V2, selagem, publicação, verificação independente, política de destino, identidades) ao produtor operacional e à prova de restauração, e que falha FECHADO antes de qualquer efeito.
 *
 * `criarEntradaOperacional({ composicao, restauracao?, execucao: { fronteira, politica } })` — valida TUDO na construção (a validação da composição é a da própria composição; nada é aberto, conectado ou lançado). Devolve `{ avaliarPrerequisitos(), executarBackup({ nomeDaPreparacao, conjuntoId }), provarRestauracao({ resultado, imagens, destino }) }`.
 *
 * FRONTEIRA DE EXECUÇÃO e MULTIPROCESSO: o registro de identidades é DE UM PROCESSO (volátil, sem persistência e sem coordenação). A fronteira declarada precisa corresponder ao escopo REAL do registro: `PROCESSO_UNICO` (toda a operação — emissão, avaliação e consumo do reconhecimento — acontece
 * neste processo; evidência exportada, reconstruída ou apresentada a outro processo/depois de um reinício é DESCONHECIDA e nunca autoriza, e o resultado reconhecido NÃO é exportável) ou `MULTIPROCESSO`, que exige um registro `COMPARTILHADO_DURAVEL` que NÃO EXISTE: falha fechada (GARANTIA_DE_IDENTIDADE_NAO_COMPROVADA). Não há banco,
 * fila ou armazenamento persistente novo. Uma implantação com vários processos precisa de coordenação compartilhada (decisão do responsável).
 *
 * PRÉ-REQUISITOS (todos, ANTES de qualquer efeito): fonte de chaves OPERACIONAL aprovada, destino operacional AUTORIZADO, política de execução válida, janela genuína (capacidade reconhecida do coordenador), garantia de identidade e não reutilização, produtor operacional padrão (nenhum relatório injetado) e
 * dependências da composição (binários, senha 0600, diretórios). Hoje a fonte operacional de chaves e a lista de destinos operacionais estão VAZIAS: a entrada recusa (`PRE_REQUISITOS_AUSENTES`, `efeitos:'NENHUM'`). O segundo argumento (`politicaDeProducao`, só testes) permite exercitar a LÓGICA com listas de teste; o que ele produz NUNCA é uma
 * autorização reconhecida pela produção.
 *
 * ESTADOS (separados, nunca promovidos por simulação): backup tecnicamente produzido, pacote íntegro e autenticado, publicação operacional autorizada, backup operacional válido, restauração comprovada (prova ligada AO PACOTE e À EXECUÇÃO que a originaram) e recuperabilidade em produção (SEMPRE falsa aqui).
 * O veredito do coordenador é repassado sem alteração.
 *
 * BLOCO `operacao` (OPCIONAL; ausente = apenas os pré-requisitos acima): `{ ambiente, chaveiro, destino: { validador, destinoId }, protecao: { uidsAutorizados }, coordenador?, destinoDuravel? }`, todos produzidos pelas fábricas dos módulos de chaveiro, destinos, escritores, coordenação e durabilidade (objetos do chamador não valem).
 * Com o bloco, entram pré-requisitos adicionais: CHAVEIRO_COMPATIVEL (ambiente, chave de assinatura ativa e disponível, fonte DERIVADA do próprio chaveiro), DESTINO_VALIDADO (validação física do destino a cada avaliação), PROTECAO_LOCAL_DO_ARMAZENAMENTO (propriedade/permissões/links das imagens) e, na política de PRODUÇÃO,
 * REQUISITO_EXTERNO_DE_EXCLUSAO (controle do sistema operacional/armazenamento contra escritores externos: não comprovável por código, lista de controles aprovados VAZIA). Na fronteira MULTIPROCESSO só um coordenador compartilhado OPERACIONAL (lista vazia) satisfaz a garantia de identidade.
 * Com o bloco, a execução fotografa as imagens antes e depois: remoção ou modificação concorrente (ou fotografia inconclusiva) invalida o backup (todos os estados favoráveis ficam falsos); adições são sinalizadas. O resultado traz `durabilidade` (gravado, sincronizado localmente, publicado, duravelmente armazenado, restaurável comprovado — esta última e a durabilidade exigem confirmação reconhecida).
 */

const FRONTEIRAS = Object.freeze({ PROCESSO_UNICO: 'PROCESSO_UNICO_VOLATIL', MULTIPROCESSO: 'COMPARTILHADO_DURAVEL' });
const POLITICA_DE_PRODUCAO = Object.freeze({ origemDaChave: 'OPERACIONAL', destinos: DESTINOS_OPERACIONAIS_AUTORIZADOS });
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const resultadosDaEntrada = new WeakSet();
const entradaEmissora = new WeakMap(); // resultado -> marca da entrada que o produziu
const provasDeRestauracao = new WeakSet();
const ehProvaDeRestauracao = (v) => v !== null && typeof v === 'object' && provasDeRestauracao.has(v);

function configuracaoInvalida() {
  const falha = new TypeError('configuração da entrada operacional inválida');
  falha.code = 'CONFIGURACAO_INVALIDA';
  return falha;
}

const ESTADOS_BLOQUEADOS = Object.freeze({
  backupTecnicamenteProduzido: false,
  pacoteIntegroEAutenticado: false,
  homologacaoTecnicaConcluida: null, // fato externo (relatório humano): o código não o determina
  publicacaoOperacionalAutorizada: false,
  backupOperacionalValido: false,
  restauracaoComprovada: false,
  recuperabilidadeEmProducao: false,
});

/** Separa as dimensões do estado; só o resultado produzido pela entrada e a prova produzida por ela são reconhecidos. */
function classificarEstadosDaOperacao(resultado, prova = null) {
  if (resultado === null || typeof resultado !== 'object' || !resultadosDaEntrada.has(resultado)) return ESTADOS_BLOQUEADOS;
  if (resultado.consistenciaDasImagens !== null && resultado.consistenciaDasImagens !== undefined && resultado.consistenciaDasImagens.consistente !== true) return ESTADOS_BLOQUEADOS;
  const c = classificarEstadoDoBackup(resultado.composto);
  const manifesto = resultado.composto.resultado.correlacao ? resultado.composto.resultado.correlacao.manifesto.sha256Manifesto : null;
  const provaValida = prova !== null && ehProvaDeRestauracao(prova) && manifesto !== null && prova.sha256Manifesto === manifesto && prova.conjuntoId === resultado.conjuntoId && prova.nomeDoPacote === resultado.nome;
  return Object.freeze({
    backupTecnicamenteProduzido: c.correlacaoContratual === true,
    pacoteIntegroEAutenticado: c.correlacaoContratual === true && c.pacotePublicado === true && resultado.composto.prontidao.pendencias.every((p) => p === 'FONTE_OPERACIONAL_DE_CHAVES' || p === 'DESTINO_AUTORIZADO'),
    homologacaoTecnicaConcluida: null,
    publicacaoOperacionalAutorizada: c.publicacaoOperacional === true,
    backupOperacionalValido: c.backupOperacionalValido === true,
    restauracaoComprovada: provaValida,
    recuperabilidadeEmProducao: false, // uma restauração comprovada não é recuperabilidade em produção: depende de orquestração operacional completa que este código não declara
  });
}

function validarBlocoOperacao(op) {
  if (!ehObjeto(op) || !Reflect.ownKeys(op).every((k) => ['ambiente', 'chaveiro', 'destino', 'protecao', 'coordenador', 'destinoDuravel'].includes(k)) || !['ambiente', 'chaveiro', 'destino', 'protecao'].every((k) => Reflect.ownKeys(op).includes(k))) throw configuracaoInvalida();
  if (op.ambiente !== 'HOMOLOGACAO' && op.ambiente !== 'PRODUCAO') throw configuracaoInvalida();
  if (!ehChaveiro(op.chaveiro) || op.chaveiro.ambiente !== op.ambiente) throw configuracaoInvalida();
  if (!ehObjeto(op.destino) || !chavesExatas(op.destino, ['validador', 'destinoId']) || !ehObjeto(op.destino.validador) || typeof op.destino.validador.validar !== 'function' || op.destino.validador.ambiente !== op.ambiente || typeof op.destino.destinoId !== 'string') throw configuracaoInvalida();
  if (!ehObjeto(op.protecao) || !chavesExatas(op.protecao, ['uidsAutorizados']) || !Array.isArray(op.protecao.uidsAutorizados) || op.protecao.uidsAutorizados.length === 0) throw configuracaoInvalida();
  if (Object.hasOwn(op, 'coordenador') && !ehCoordenadorCompartilhado(op.coordenador)) throw configuracaoInvalida();
  if (Object.hasOwn(op, 'destinoDuravel') && (!ehObjeto(op.destinoDuravel) || typeof op.destinoDuravel.confirmarGravacao !== 'function')) throw configuracaoInvalida();
}

function criarEntradaOperacional(config, politicaDeProducao = POLITICA_DE_PRODUCAO) {
  let cfg;
  try {
    if (ehObjeto(config) && Object.hasOwn(config, 'operacao')) validarBlocoOperacao(config.operacao);
    if (!ehObjeto(config) || !Reflect.ownKeys(config).every((k) => ['composicao', 'restauracao', 'execucao', 'operacao'].includes(k)) || !['composicao', 'execucao'].every((k) => Reflect.ownKeys(config).includes(k))) throw configuracaoInvalida();
    const { execucao } = config;
    if (!ehObjeto(execucao) || !chavesExatas(execucao, ['fronteira', 'politica']) || typeof execucao.fronteira !== 'string' || !Object.hasOwn(FRONTEIRAS, execucao.fronteira)) throw configuracaoInvalida();
    if (!ehObjeto(execucao.politica) || !chavesExatas(execucao.politica, ['versao', 'execucoesSimultaneas']) || execucao.politica.versao !== 1 || execucao.politica.execucoesSimultaneas !== 1) throw configuracaoInvalida();
    if (!ehObjeto(politicaDeProducao) || !chavesExatas(politicaDeProducao, ['origemDaChave', 'destinos']) || typeof politicaDeProducao.origemDaChave !== 'string' || !Array.isArray(politicaDeProducao.destinos)) throw configuracaoInvalida();
    cfg = Object.freeze({
      composicao: config.composicao,
      restauracao: config.restauracao,
      operacao: config.operacao ?? null,
      fronteira: execucao.fronteira,
      backup: criarBackupDeProducao(config.composicao), // validação estrita da composição, sem efeitos
      restaurador: config.restauracao === undefined ? null : criarRestauracaoDeProducao(config.restauracao),
    });
  } catch (falha) {
    if (falha && falha.code === 'CONFIGURACAO_INVALIDA') throw falha;
    throw configuracaoInvalida();
  }
  const ehPoliticaPadrao = politicaDeProducao === POLITICA_DE_PRODUCAO;
  let emAndamento = false;
  const marca = Object.freeze({});

  async function avaliarPrerequisitos() {
    const comp = cfg.composicao;
    const itens = {
      FONTE_OPERACIONAL_DE_CHAVES: comp.chaves.fonteDeChaves.origem === politicaDeProducao.origemDaChave,
      DESTINO_OPERACIONAL_AUTORIZADO: politicaDeProducao.destinos.includes(comp.armazenamento.publicados),
      POLITICA_DE_EXECUCAO_VALIDA: true, // validada na construção (forma fechada); a entrada executa uma operação por vez neste processo
      JANELA_GENUINA: ehJanelaDeBackup(comp.janela),
      GARANTIA_DE_IDENTIDADE_E_NAO_REUTILIZACAO: REGISTRO_DE_EXECUCOES.escopo === FRONTEIRAS[cfg.fronteira] || (cfg.fronteira === 'MULTIPROCESSO' && cfg.operacao !== null && cfg.operacao.coordenador !== undefined && cfg.operacao.coordenador.operacional === true),
      PRODUTOR_OPERACIONAL_PADRAO: comp.relatorio === undefined,
      DEPENDENCIAS_DA_COMPOSICAO: false,
    };
    if (cfg.operacao !== null) {
      const op = cfg.operacao;
      const chaveId = comp.chaves.chaveId;
      itens.CHAVEIRO_COMPATIVEL = op.chaveiro.chaveAtivaId() === chaveId && op.chaveiro.ehFonteDoChaveiro(comp.chaves.fonteDeChaves) && op.chaveiro.origem === comp.chaves.fonteDeChaves.origem && op.chaveiro.avaliar(chaveId, 'ASSINAR').permitido === true;
      let destinoValido = false;
      try { destinoValido = ehDestinoValidado(op.destino.validador.validar({ destinoId: op.destino.destinoId, raiz: comp.armazenamento.publicados })); } catch { destinoValido = false; }
      itens.DESTINO_VALIDADO = destinoValido;
      let protegido = false;
      try { protegido = inspecionarArmazenamento({ raiz: comp.armazenamento.imagens, uidsAutorizados: [...op.protecao.uidsAutorizados] }).conforme === true; } catch { protegido = false; }
      itens.PROTECAO_LOCAL_DO_ARMAZENAMENTO = protegido;
      if (ehPoliticaPadrao) itens.REQUISITO_EXTERNO_DE_EXCLUSAO = CONTROLES_EXTERNOS_APROVADOS.length > 0 && GARANTIA_CONTRA_ESCRITORES_EXTERNOS !== 'NAO_COMPROVADA';
    }
    try { itens.DEPENDENCIAS_DA_COMPOSICAO = (await cfg.backup.verificarDependencias()).ok === true; } catch { itens.DEPENDENCIAS_DA_COMPOSICAO = false; }
    const pendencias = Object.freeze(Object.keys(itens).filter((k) => itens[k] !== true));
    return Object.freeze({ aptos: pendencias.length === 0, itens: Object.freeze(itens), pendencias });
  }

  const bloqueado = (motivo, extra = {}) => Object.freeze({ executado: false, motivo, efeitos: 'NENHUM', estados: ESTADOS_BLOQUEADOS, ...extra });

  async function executarBackup(entrada) {
    if (emAndamento) return bloqueado('OPERACAO_EM_ANDAMENTO');
    emAndamento = true;
    try {
      const pre = await avaliarPrerequisitos();
      if (!pre.aptos) return bloqueado('PRE_REQUISITOS_AUSENTES', { pendencias: pre.pendencias });
      let composto;
      let antes = null;
      try {
        if (cfg.operacao !== null) antes = fotografar({ raiz: cfg.composicao.armazenamento.imagens });
        composto = await cfg.backup.executar(entrada);
      } catch (falha) {
        // falha depois dos pré-requisitos (por exemplo, entrada inválida ou dependência que sumiu): nada é presumido concluído; as proteções de quem já agiu (janela, processos) são as do coordenador
        return bloqueado('FALHA_NA_EXECUCAO', { codigo: falha && typeof falha.code === 'string' && /^[A-Z_]{3,60}$/.test(falha.code) ? falha.code : 'DESCONHECIDO', efeitos: 'PODEM_EXISTIR_PRESERVADOS' });
      }
      let consistenciaDasImagens = null;
      let escritoresExternos = null;
      if (cfg.operacao !== null) {
        let depois = null;
        try { depois = fotografar({ raiz: cfg.composicao.armazenamento.imagens }); } catch { depois = null; }
        consistenciaDasImagens = avaliarConsistencia(antes, depois);
        escritoresExternos = Object.freeze({ garantia: GARANTIA_CONTRA_ESCRITORES_EXTERNOS, detectadoDuranteAExecucao: consistenciaDasImagens.consistente !== true });
      }
      const publicacaoFeita = composto.resultado.publicacao;
      const correl = composto.resultado.correlacao;
      let confirmacao = null;
      if (cfg.operacao !== null && cfg.operacao.destinoDuravel !== undefined && publicacaoFeita && publicacaoFeita.publicada === true && correl) {
        try { confirmacao = await cfg.operacao.destinoDuravel.confirmarGravacao({ chave: `${entrada.nomeDaPreparacao}/dump/postgres.dump`, sha256: correl.dump.sha256, bytes: correl.dump.bytes }); } catch { confirmacao = null; }
      }
      const captura = composto.proveniencia.captura;
      const durabilidade = classificarDurabilidade({ captura: captura === null ? null : { ...captura, fsyncConcluido: composto.proveniencia.hashDoDump.fsyncConcluido === true }, publicacao: publicacaoFeita, confirmacao, restauravelComprovado: false });
      const resultado = {
        consistenciaDasImagens,
        escritoresExternos,
        durabilidade,
        executado: true,
        nome: entrada.nomeDaPreparacao,
        conjuntoId: entrada.conjuntoId,
        fronteira: cfg.fronteira,
        exportavel: false, // o reconhecimento vale só neste processo
        composto,
        // só a política de PRODUÇÃO pode gerar autorização reconhecida; com política de teste o resultado nunca é reconhecido pela produção
        autorizacaoReconhecidaPelaProducao: ehPoliticaPadrao && composto.resultado.publicacao !== null && composto.resultado.publicacao !== undefined && composto.resultado.publicacao.publicacaoOperacional === true,
      };
      const base = Object.freeze({ ...resultado, estados: undefined });
      resultadosDaEntrada.add(base);
      entradaEmissora.set(base, marca);
      const final = Object.freeze({ ...resultado, estados: classificarEstadosDaOperacao(base) });
      resultadosDaEntrada.add(final);
      entradaEmissora.set(final, marca);
      return final;
    } finally {
      emAndamento = false;
    }
  }

  async function provarRestauracao(pedido) {
    const negada = (motivo) => Object.freeze({ comprovada: false, motivo, prova: null });
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['resultado', 'imagens', 'destino'])) throw configuracaoInvalida();
    if (cfg.restaurador === null) return negada('RESTAURACAO_NAO_CONFIGURADA');
    const { resultado } = pedido;
    if (resultado === null || typeof resultado !== 'object' || !resultadosDaEntrada.has(resultado) || resultado.executado !== true) return negada('BACKUP_NAO_RECONHECIDO');
    if (entradaEmissora.get(resultado) !== marca) return negada('RESULTADO_DE_OUTRA_ENTRADA');
    if (resultado.consistenciaDasImagens !== null && resultado.consistenciaDasImagens !== undefined && resultado.consistenciaDasImagens.consistente !== true) return negada('BACKUP_INCONSISTENTE');
    const publicacao = resultado.composto.resultado.publicacao;
    const correlacao = resultado.composto.resultado.correlacao;
    if (!publicacao || publicacao.publicada !== true || !correlacao) return negada('PACOTE_NAO_PUBLICADO');
    // QUARENTENA: bloqueio efetivo, volátil E durável. O estado em memória (classificação) recusa; o registro lido do DISCO também, de modo que um pacote em quarentena é recusado mesmo que o processo que o produziu já não exista. Só a conclusão autenticada admite.
    const classificacao = classificarEstadoDoBackup(resultado.composto);
    if (classificacao.quarentena !== undefined && classificacao.quarentena.recomendada === true) return negada('PACOTE_EM_QUARENTENA');
    const situacao = await lerSituacao({
      raiz: cfg.composicao.armazenamento.publicados,
      identidade: { nome: resultado.nome, conjuntoId: resultado.conjuntoId, sha256Manifesto: correlacao.manifesto.sha256Manifesto, dump: { bytes: correlacao.dump.bytes, sha256: correlacao.dump.sha256 } },
      fonteDeChaves: cfg.composicao.chaves.fonteDeChaves,
    });
    if (situacao.estado !== 'ADMISSIVEL') return negada(situacao.estado === 'EM_QUARENTENA' ? 'PACOTE_EM_QUARENTENA' : situacao.estado === 'SEM_REGISTRO' ? 'PUBLICACAO_SEM_REGISTRO' : situacao.estado === 'PUBLICACAO_NAO_CONCLUIDA' ? 'PUBLICACAO_NAO_CONCLUIDA' : 'REGISTRO_DE_PUBLICACAO_INVALIDO');
    const saida = await cfg.restaurador.restaurar({ raizAutorizada: cfg.composicao.armazenamento.publicados, nome: resultado.nome, imagens: pedido.imagens, destino: pedido.destino });
    const etapa = saida.restauracao.etapas.pacote;
    const ligadaAoPacote = etapa !== null && typeof etapa === 'object' && etapa.ok === true && etapa.sha256Manifesto === correlacao.manifesto.sha256Manifesto && etapa.conjuntoId === resultado.conjuntoId;
    const avaliacao = saida.proveniencia.avaliacao;
    if (!ligadaAoPacote) return negada('PROVA_DE_OUTRO_PACOTE');
    if (saida.estado.restauracaoReal !== true || avaliacao.reconhecida !== true || !ehAvaliacaoReconhecida(avaliacao)) return Object.freeze({ comprovada: false, motivo: 'PROVA_DE_RESTAURACAO_AUSENTE', prova: null, pendencias: avaliacao.pendencias, restauracao: saida.restauracao });
    const prova = Object.freeze({ execucaoId: saida.proveniencia.execucaoId, sha256Manifesto: etapa.sha256Manifesto, conjuntoId: etapa.conjuntoId, nomeDoPacote: resultado.nome, avaliacao });
    provasDeRestauracao.add(prova);
    return Object.freeze({ comprovada: true, motivo: null, prova, estados: classificarEstadosDaOperacao(resultado, prova) });
  }

  return Object.freeze({ avaliarPrerequisitos, executarBackup, provarRestauracao });
}

module.exports = { criarEntradaOperacional, classificarEstadosDaOperacao, ehProvaDeRestauracao, POLITICA_DE_PRODUCAO, FRONTEIRAS, ESTADOS_BLOQUEADOS };
