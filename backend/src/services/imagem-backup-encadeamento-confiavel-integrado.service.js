'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exigirDiretorio } = require('../config/imagens');
const { executarBackupPgDump } = require('./imagem-backup-pgdump.service');
const { acrescentarManifesto, reconhecerCorrelacao, avaliarCorrelacao } = require('./imagem-backup-correlacao.service');
const { ehVerificadorEstrutural } = require('./imagem-backup-estrutura.service');
const { ehPublicador, SERVICO_PADRAO } = require('./imagem-backup-publicacao.service');
const { adquirirPreparacaoExclusiva } = require('./imagem-backup-origem-preparacao-exclusiva.service');
const { planejarArquivos } = require('./imagem-backup-plano.service');
const { ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');
const { ehRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-INTEGRADO-ENCADEAMENTO-CONFIAVEL-BACKUP-1, Marco B): ENCADEAMENTO CONFIÁVEL do backup. Interno, para chamador confiável; contrato PROVISÓRIO.
 * Liga os componentes aprovados sem reimplementar nenhum: o COORDENADOR (via `executarBackupPgDump`) segue com a autoridade sobre trava, snapshot, supervisão do dump, finalização e liberação; este módulo só fornece
 * a etapa `copia` e um `avaliar` PRÓPRIO que FECHA contra sucesso.
 *
 * `criarInicializacaoConfiavel({ configuracaoDeImagens, diretorioPai, diretorioDoDump, janela, conexao, dump, selagem?, maxBytesPorArquivo, declaracaoDoDump })` (ESTRITO) -> objeto congelado RECONHECIDO por identidade
 * privada (WeakSet): só esta fábrica o produz. Recusa avaliador, cópia, processo do dump, snapshot, finalização, planejador, origem, preparação, destino, armazenamento e qualquer chave desconhecida. A identidade privada
 * prova que o objeto saiu desta fábrica; NÃO prova autorização operacional (quem a chama é o ponto de inicialização confiável, ainda inexistente), nem que os diretórios foram escolhidos por autoridade legítima.
 * `executarBackupEncadeado({ inicializacao, nomeDaPreparacao, conjuntoId, parada? })` (assíncrona) -> congelado { coordenador, composicao, verificacao, aquisicao, evidenciaDoDump }; rejeita com PARAMETROS_INVALIDOS
 * (TypeError) ou INICIALIZACAO_INVALIDA, antes de tocar trava, snapshot ou disco.
 * Etapa `copia` (chamada pelo coordenador, só depois do dump concluído e da supervisão): (a) evidência física do observador; (b) declaração da fonte distinta; (c) SÓ ENTÃO `adquirirPreparacaoExclusiva`; (d) `compor`
 * da montagem com o `dump` { concluido, bytes, sha256Declarado (da fonte), sha256Recalculado (do observador) }. Qualquer falha devolve { ok:false } ao coordenador; a preparação adquirida e depois falha fica reservada (sem limpeza).
 *
 * LIMITES: o `avaliar` próprio NUNCA declara VÁLIDO porque nenhum contrato produz `relatorio.veredito` (a composição concluída e o backup válido são coisas distintas); a declaração do dump depende de uma fonte que ainda não
 * existe (aqui injetada pela inicialização, simulada nos testes); o veredito do supervisor não chega à etapa `copia` (a garantia é o controle de fluxo do coordenador); `diretorioDoDump` é a área de trabalho do dump,
 * FORA da preparação (o dump ainda não faz parte de nenhum conjunto publicado); sem cancelamento, sem tratamento de perda de posse durante a composição, sem publicação, durabilidade nem recuperabilidade.
 */

const OBRIGATORIAS_DA_INICIALIZACAO = ['configuracaoDeImagens', 'diretorioPai', 'diretorioDoDump', 'janela', 'conexao', 'dump', 'maxBytesPorArquivo', 'declaracaoDoDump'];
// P6 (D-ORF-6): `layoutDoManifesto` (1 | 2; padrão 1 = comportamento histórico) e `composicaoL2` ({ compor, lerAdicionais, planos, origens, contexto, postgres }), obrigatória só com layout 2.
const PERMITIDAS_DA_INICIALIZACAO = new Set([...OBRIGATORIAS_DA_INICIALIZACAO, 'selagem', 'publicador', 'verificadorEstrutural', 'orcamento', 'controle', 'observarPublicacao', 'layoutDoManifesto', 'composicaoL2']);
const CHAVES_DO_DUMP = ['alvo', 'lancador', 'sistema', 'arquivos', 'temporizador', 'prazos'];
const chavesDoDumpValidas = (dump) => chavesExatas(dump, Reflect.ownKeys(dump).includes('saida') ? [...CHAVES_DO_DUMP, 'saida'] : CHAVES_DO_DUMP) && (!Reflect.ownKeys(dump).includes('saida') || dump.saida === 'PIPE_COM_HASH' || dump.saida === 'DESCRITOR');
const CHAVES_DA_CONEXAO = new Set(['criarConexao', 'temporizador', 'prazos', 'tamanhoDaPagina']);
const OBRIGATORIAS_DA_EXECUCAO = ['inicializacao', 'nomeDaPreparacao', 'conjuntoId'];
const PERMITIDAS_DA_EXECUCAO = new Set([...OBRIGATORIAS_DA_EXECUCAO, 'parada']);
const NOME_DA_PREPARACAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODIGOS_DA_AQUISICAO = new Set(['PARAMETROS_INVALIDOS', 'ORIGEM_INVALIDA', 'ORIGEM_SOBREPOSTA', 'PREPARACAO_EXISTENTE', 'AQUISICAO_FALHOU']);
const MENSAGENS = Object.freeze({
  PARAMETROS_INVALIDOS: 'parâmetros do backup inválidos',
  INICIALIZACAO_INVALIDA: 'inicialização do backup inválida',
});

const inicializacoesProduzidas = new WeakSet();

const erro = (codigo) => Object.assign(codigo === 'PARAMETROS_INVALIDOS' ? new TypeError(MENSAGENS[codigo]) : new Error(MENSAGENS[codigo]), { code: codigo });
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

/** Diretório absoluto, canônico, JÁ EXISTENTE, sem link simbólico (validação de caminho: não é autorização operacional). */
function diretorioValido(texto) {
  if (typeof texto !== 'string' || texto === '' || texto.includes('\0') || !path.isAbsolute(texto) || texto.split(/[\\/]/).includes('..')) return false;
  const resolvido = path.resolve(texto);
  try {
    const estado = fs.lstatSync(resolvido);
    return !estado.isSymbolicLink() && estado.isDirectory() && fs.realpathSync(resolvido) === resolvido;
  } catch {
    return false;
  }
}

function criarInicializacaoConfiavel(opcoes) {
  try {
    if (!ehObjeto(opcoes)) throw erro('PARAMETROS_INVALIDOS');
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && PERMITIDAS_DA_INICIALIZACAO.has(k)) || !OBRIGATORIAS_DA_INICIALIZACAO.every((k) => proprias.includes(k))) throw erro('PARAMETROS_INVALIDOS');
    const { configuracaoDeImagens, diretorioPai, diretorioDoDump, janela, conexao, dump, maxBytesPorArquivo, declaracaoDoDump } = opcoes;
    const temSelagem = proprias.includes('selagem');
    const selagem = temSelagem ? opcoes.selagem : undefined;

    exigirDiretorio(configuracaoDeImagens); // só configuração PRODUZIDA por lerConfiguracao
    if (!diretorioValido(diretorioPai) || !diretorioValido(diretorioDoDump)) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(janela) || !ehFuncao(janela.adquirir)) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(conexao)) throw erro('PARAMETROS_INVALIDOS');
    const chavesDaConexao = Reflect.ownKeys(conexao);
    if (!chavesDaConexao.every((k) => typeof k === 'string' && CHAVES_DA_CONEXAO.has(k)) || !['criarConexao', 'temporizador', 'prazos'].every((k) => chavesDaConexao.includes(k))) throw erro('PARAMETROS_INVALIDOS');
    if (!ehFuncao(conexao.criarConexao) || !ehObjeto(conexao.temporizador) || !ehFuncao(conexao.temporizador.prazo) || !ehObjeto(conexao.prazos)) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(dump) || !chavesDoDumpValidas(dump)) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(dump.alvo) || !ehObjeto(dump.lancador) || !ehFuncao(dump.lancador.lancar) || !ehObjeto(dump.sistema) || !ehObjeto(dump.arquivos) || !ehFuncao(dump.arquivos.criarExclusivo)
      || !ehObjeto(dump.temporizador) || !ehObjeto(dump.prazos)) throw erro('PARAMETROS_INVALIDOS');
    if (!Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo <= 0) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(declaracaoDoDump) || !ehFuncao(declaracaoDoDump.sha256)) throw erro('PARAMETROS_INVALIDOS');
    if (temSelagem && (!ehObjeto(selagem) || !ehFuncao(selagem.selar) || !ehFuncao(selagem.verificar))) throw erro('PARAMETROS_INVALIDOS');

    // Marco C (opcionais): o publicador e o verificador estrutural precisam ser os PRODUZIDOS pelas suas fábricas; qualquer outra coisa é recusada.
    const publicador = proprias.includes('publicador') ? opcoes.publicador : null;
    const verificadorEstrutural = proprias.includes('verificadorEstrutural') ? opcoes.verificadorEstrutural : null;
    if (proprias.includes('publicador') && !ehPublicador(publicador)) throw erro('PARAMETROS_INVALIDOS');
    if (proprias.includes('verificadorEstrutural') && !ehVerificadorEstrutural(verificadorEstrutural)) throw erro('PARAMETROS_INVALIDOS');

    // P4 (opcional): orçamento de bytes da execução (cópia das imagens); precisa ser o PRODUZIDO por `criarOrcamentoDeBytes`
    const orcamento = proprias.includes('orcamento') ? opcoes.orcamento : null;
    if (orcamento !== null && !ehOrcamentoDeBytes(orcamento)) throw erro('PARAMETROS_INVALIDOS');

    // P2/P3 (opcional): controle de operações pendentes DESTA execução ({ registro, etapaMs?, posseMs? }); o registro precisa ser o PRODUZIDO por `criarRegistroDeOperacoes` (o coordenador confere a forma completa antes da trava)
    const controle = proprias.includes('controle') ? opcoes.controle : null;
    if (controle !== null && !(ehObjeto(controle) && ehRegistroDeOperacoes(controle.registro))) throw erro('PARAMETROS_INVALIDOS');

    // Observador (opcional) das FASES do pacote/publicação, para que a composição classifique de forma conservadora o que estava em andamento na saída (incluindo conclusão tardia). Só recebe códigos fixos; nunca decide nada.
    const observarPublicacao = proprias.includes('observarPublicacao') ? opcoes.observarPublicacao : null;
    if (observarPublicacao !== null && !ehFuncao(observarPublicacao)) throw erro('PARAMETROS_INVALIDOS');

    // P6: layout do manifesto (1 = histórico, padrão). Com 2, a composição por fonte L2 é OBRIGATÓRIA e a montagem L1 serve só para adquirir a preparação exclusiva.
    const layoutDoManifesto = proprias.includes('layoutDoManifesto') ? opcoes.layoutDoManifesto : 1;
    if (layoutDoManifesto !== 1 && layoutDoManifesto !== 2) throw erro('PARAMETROS_INVALIDOS');
    const composicaoL2 = proprias.includes('composicaoL2') ? opcoes.composicaoL2 : null;
    if (layoutDoManifesto === 2 && !(ehObjeto(composicaoL2) && ehFuncao(composicaoL2.compor) && ehFuncao(composicaoL2.lerAdicionais) && ehObjeto(composicaoL2.origens) && ehObjeto(composicaoL2.contexto) && ehFuncao(composicaoL2.postgres))) throw erro('PARAMETROS_INVALIDOS');
    if (layoutDoManifesto === 1 && composicaoL2 !== null) throw erro('PARAMETROS_INVALIDOS');

    const inicializacao = Object.freeze({
      configuracaoDeImagens, diretorioPai, diretorioDoDump, janela, conexao: Object.freeze({ ...conexao }), dump: Object.freeze({ ...dump }), maxBytesPorArquivo, declaracaoDoDump, selagem: temSelagem ? selagem : null, publicador, verificadorEstrutural, orcamento, controle, observarPublicacao,
      layoutDoManifesto, composicaoL2,
    });
    inicializacoesProduzidas.add(inicializacao);
    return inicializacao;
  } catch {
    throw erro('PARAMETROS_INVALIDOS');
  }
}

function capturarExecucao(opcoes) {
  try {
    if (!ehObjeto(opcoes)) throw erro('PARAMETROS_INVALIDOS');
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && PERMITIDAS_DA_EXECUCAO.has(k)) || !OBRIGATORIAS_DA_EXECUCAO.every((k) => proprias.includes(k))) throw erro('PARAMETROS_INVALIDOS');
    const { inicializacao, nomeDaPreparacao, conjuntoId } = opcoes;
    const parada = proprias.includes('parada') ? opcoes.parada : undefined;
    if (typeof nomeDaPreparacao !== 'string' || !NOME_DA_PREPARACAO.test(nomeDaPreparacao) || typeof conjuntoId !== 'string') throw erro('PARAMETROS_INVALIDOS');
    if (proprias.includes('parada') && (!ehObjeto(parada) || !ehFuncao(parada.aoPedir))) throw erro('PARAMETROS_INVALIDOS');
    if (!ehObjeto(inicializacao) || !inicializacoesProduzidas.has(inicializacao)) throw erro('INICIALIZACAO_INVALIDA');
    return { inicializacao, nomeDaPreparacao, conjuntoId, parada };
  } catch (falha) {
    throw falha && falha.code === 'INICIALIZACAO_INVALIDA' ? erro('INICIALIZACAO_INVALIDA') : erro('PARAMETROS_INVALIDOS');
  }
}

async function executarBackupEncadeado(opcoes) {
  const { inicializacao, nomeDaPreparacao, conjuntoId, parada } = capturarExecucao(opcoes);
  const ini = inicializacao;

  // Estado EXCLUSIVO desta operação.
  const estado = { evidencia: null, aquisicao: null, composicao: null, montagem: null, correlacao: null, pacote: null, publicacao: null, itensDoPlano: null, reterTrava: false };
  // O observador do dump é UM só por operação e é criado pelo serviço do dump (`executarBackupPgDump`); aqui só se reutiliza a observação T1 entregue no contexto.
  const dump = {
    alvo: ini.dump.alvo,
    destino: { diretorio: ini.diretorioDoDump, nome: `dump-${nomeDaPreparacao}.custom` },
    lancador: ini.dump.lancador,
    sistema: ini.dump.sistema,
    arquivos: ini.dump.arquivos,
    temporizador: ini.dump.temporizador,
    prazos: ini.dump.prazos,
    // modo de saída (opcional): 'PIPE_COM_HASH' repassa o stdout do pg_dump à captura íntegra do lançador
    ...(Object.hasOwn(ini.dump, 'saida') ? { saida: ini.dump.saida } : {}),
  };

  let copiaChamada = false;
  async function copia(entregue) {
    if (copiaChamada) return { ok: false }; // uma execução por operação
    copiaChamada = true;

    // (a) observação física T1 do dump (o coordenador só chega aqui depois do dump concluído e da supervisão; o executor já a obteve, uma única vez)
    const t1 = entregue && entregue.dump ? entregue.dump.observacao : undefined;
    if (t1 === null || typeof t1 !== 'object') return { ok: false };
    if (t1.ok !== true) {
      estado.evidencia = Object.freeze({ ok: false, motivo: t1.motivo });
      return { ok: false };
    }
    const evidencia = Object.freeze({ ok: true, bytes: t1.bytes, sha256Calculado: t1.sha256 });
    estado.evidencia = evidencia;
    // A composição recebe apenas o contexto ORIGINAL do snapshot (as chaves de operação do contexto enriquecido ficam de fora).
    const contexto = Object.freeze({ snapshotId: entregue.snapshotId, banco: entregue.banco, registros: entregue.registros, plano: entregue.plano });
    estado.itensDoPlano = Array.isArray(entregue.plano) ? entregue.plano.length : null;

    // (b) declaração de fonte DISTINTA (nunca o próprio hash calculado)
    let declarado;
    try {
      declarado = await ini.declaracaoDoDump.sha256();
    } catch {
      return { ok: false };
    }
    if (typeof declarado !== 'string' || !SHA256.test(declarado)) return { ok: false };

    // (c) só agora a preparação exclusiva é adquirida
    try {
      estado.montagem = await adquirirPreparacaoExclusiva({
        configuracaoDeImagens: ini.configuracaoDeImagens,
        diretorioPai: ini.diretorioPai,
        nomeDaPreparacao,
        conjuntoId,
        maxBytesPorArquivo: ini.maxBytesPorArquivo,
        ...(ini.selagem === null ? {} : { selagem: ini.selagem }),
        ...(ini.orcamento === null ? {} : { orcamento: ini.orcamento }),
      });
      estado.aquisicao = Object.freeze({ ok: true });
    } catch (falha) {
      const codigo = falha && typeof falha.code === 'string' && CODIGOS_DA_AQUISICAO.has(falha.code) ? falha.code : 'AQUISICAO_FALHOU';
      estado.aquisicao = Object.freeze({ ok: false, codigo });
      return { ok: false };
    }

    // (d) cópia, verificação física, manifesto, selagem e releitura: tudo da montagem aprovada
    try {
      const dumpDaComposicao = { concluido: true, bytes: evidencia.bytes, sha256Declarado: declarado, sha256Recalculado: evidencia.sha256Calculado };
      if (ini.layoutDoManifesto === 2) {
        // P6: composição POR FONTE (layout 2) na preparação já exclusiva; os planos vêm da leitura adicional feita NO MESMO snapshot (`contexto.adicionais`).
        const adicionais = entregue.adicionais;
        if (declarado !== evidencia.sha256Calculado || !ehObjeto(adicionais) || !ehObjeto(adicionais.planos)) { estado.composicao = Object.freeze({ ok: false, selado: false, falha: Object.freeze({ estagio: 'ENTRADA', codigo: 'PLANOS_DO_SNAPSHOT_AUSENTES' }) }); return { ok: false }; }
        const montagemL1 = estado.montagem;
        estado.itensDoPlano = Object.values(adicionais.planos).reduce((s, p) => s + (Array.isArray(p.plano) ? p.plano.length : 0), 0);
        const r = await ini.composicaoL2.compor({
          preparacao: path.join(ini.diretorioPai, nomeDaPreparacao), planos: adicionais.planos, origens: ini.composicaoL2.origens, banco: contexto.banco, conjuntoId,
          dump: { bytes: evidencia.bytes, sha256: evidencia.sha256Calculado }, contexto: ini.composicaoL2.contexto, postgres: ini.composicaoL2.postgres({ adicionais }),
        });
        estado.composicao = r.ok === true ? Object.freeze({ ok: true, selado: true, arquivos: r.arquivos, identidade: r.identidade, manifesto: r.manifesto, layout: 2 }) : Object.freeze({ ok: false, selado: false, falha: r.falha });
        estado.montagem = Object.freeze({ compor: montagemL1.compor, obterVerificacao: () => (r.ok === true ? r.verificacao : Object.freeze({ classe: 'NAO_EXECUTADA' })) });
      } else {
        estado.composicao = await estado.montagem.compor(entregue.sinal === undefined ? { contexto, dump: dumpDaComposicao } : { contexto, dump: dumpDaComposicao, sinal: entregue.sinal });
      }
    } catch {
      return { ok: false };
    }
    return { ok: estado.composicao !== null && estado.composicao.ok === true };
  }

  // Fecha contra sucesso: nenhum contrato produz o `relatorio.veredito` do avaliador completo, então o backup global nunca é declarado válido aqui.
  // E4: antes de fechar, acrescenta à correlação do dump (já com T2, formada pelo executor) o manifesto e a selagem que a composição produziu e RELEU, com o digest vindo dessa verificação.
  // Marco C: ainda DENTRO da janela (o coordenador só chega aqui com a posse confirmada), com a correlação do conjunto satisfeita, monta o PACOTE COMPLETO (dump incorporado e reverificado, pacote verificado, consistência) e, se houver
  // publicador configurado, tenta publicar. A publicação continua sujeita às portas do publicador (inclusive o relatório operacional, hoje sem produtor reconhecido).
  const avaliar = async (contexto) => {
    const base = contexto ? contexto.correlacao : undefined;
    if (!reconhecerCorrelacao(base)) return { valido: false };
    const c = estado.composicao;
    estado.correlacao = base; // escopo DUMP: correlação parcial, não do conjunto
    if (c !== null && c.ok === true && c.selado === true && c.identidade && typeof c.identidade.sha256Manifesto === 'string') {
      try {
        estado.correlacao = acrescentarManifesto(base, { operacaoId: contexto.operacaoId, conjuntoId: c.identidade.conjuntoId, sha256Manifesto: c.identidade.sha256Manifesto, preparacao: nomeDaPreparacao });
      } catch {
        estado.correlacao = base;
      }
    }
    if (estado.correlacao.escopo === 'CONJUNTO' && avaliarCorrelacao(estado.correlacao).satisfeita) {
      try {
        await montarPacoteEPublicar(contexto);
        // (P3) o resultado de `montarPacoteEPublicar` fica em `estado`; nada é publicado depois de um pedido de cancelamento
        if (faseAtual !== null && !FASES_TERMINAIS.has(faseAtual)) avisar({ fase: 'ENCERRADA_SEM_PUBLICAR' });
      } catch {
        estado.pacote = Object.freeze({ ok: false, motivo: 'ERRO_INTERNO' });
        if (faseAtual !== null && !FASES_TERMINAIS.has(faseAtual)) avisar({ fase: 'INDETERMINADA' });
      }
    }
    // `reterTrava` (opcional): quarentena necessária que não foi registrada de forma durável; o coordenador mantém a trava RETIDA (nunca declara validade: `valido` segue false).
    return estado.reterTrava === true ? { valido: false, reterTrava: true } : { valido: false };
  };

  // Fases observáveis (códigos fixos): o que estiver em andamento na saída é classificado de forma CONSERVADORA pela composição; uma operação física já iniciada não é interrompida por este contrato.
  const FASES_TERMINAIS = new Set(['CONCLUIDA', 'INDETERMINADA', 'ENCERRADA_SEM_PUBLICAR']);
  let faseAtual = null;
  const avisar = (dados) => {
    faseAtual = dados.fase;
    if (ini.observarPublicacao !== null) { try { ini.observarPublicacao(Object.freeze(dados)); } catch { /* o observador nunca decide nada */ } }
  };

  async function montarPacoteEPublicar(contexto) {
    // P3: pontos seguros ANTES de incorporar o dump, antes de verificar o pacote e antes de publicar. Cancelamento só impede o passo seguinte: nada é apagado e nada é publicado; uma publicação já iniciada termina pelo seu protocolo (atômico, INCERTA/REVERTIDA).
    const sinal = contexto.sinal;
    const cancelado = () => sinal !== undefined && sinal !== null && sinal.aborted === true;
    if (cancelado()) { estado.pacote = Object.freeze({ ok: false, motivo: 'CANCELADO' }); return; }
    const servico = ini.publicador === null ? SERVICO_PADRAO : ini.publicador.servico;
    const preparacao = path.join(ini.diretorioPai, nomeDaPreparacao);
    const c = estado.composicao;
    const artefato = contexto.dump.abrirArtefato();
    if (artefato.ok !== true) { estado.pacote = Object.freeze({ ok: false, motivo: `ARTEFATO_${artefato.motivo}` }); return; }
    let dumpIncorporado;
    avisar({ fase: 'INCORPORANDO_DUMP' });
    try {
      // a incorporação é a SEGUNDA cópia física do dump: com orçamento, é reservada por inteiro antes de qualquer efeito
      dumpIncorporado = await servico.incorporarDump({ preparacao, artefato, manifesto: c.manifesto, ...(ini.orcamento === null ? {} : { orcamento: ini.orcamento }) });
    } finally {
      artefato.fechar();
    }
    if (dumpIncorporado.ok !== true) { estado.pacote = Object.freeze({ ok: false, motivo: dumpIncorporado.motivo, dump: dumpIncorporado }); return; }
    if (cancelado()) { estado.pacote = Object.freeze({ ok: false, motivo: 'CANCELADO', dump: dumpIncorporado }); return; }
    avisar({ fase: 'VERIFICANDO_PACOTE' });
    const verificado = await servico.verificarPacote({ preparacao, manifesto: c.manifesto, identidade: c.identidade });
    const consistencia = servico.avaliarConsistencia({
      operacaoId: contexto.operacaoId,
      itensDoPlano: estado.itensDoPlano,
      composicao: c,
      verificacao: estado.montagem.obterVerificacao(),
    });
    estado.pacote = Object.freeze({ ok: verificado.ok === true, ...(verificado.ok === true ? {} : { motivo: verificado.motivo }), dump: dumpIncorporado, verificacao: verificado, consistencia });
    if (verificado.ok !== true || ini.publicador === null) return;
    if (cancelado()) { estado.pacote = Object.freeze({ ok: false, motivo: 'CANCELADO', dump: dumpIncorporado, verificacao: verificado, consistencia }); return; }
    avisar({ fase: 'PUBLICANDO' });
    try {
      estado.publicacao = await ini.publicador.publicar({ preparacao, nomeFinal: nomeDaPreparacao, correlacao: estado.correlacao, pacote: verificado, consistencia, ...(sinal === undefined || sinal === null ? {} : { sinal }) });
    } catch (falha) {
      avisar({ fase: 'INDETERMINADA' }); // exceção durante a publicação: o estado físico não é conhecido
      // QUARENTENA DURÁVEL do estado desconhecido; se não puder ser registrada, a trava fica RETIDA (`reterTrava`). Publicador sem o registro (ou sem a identidade) = não registrada.
      let registrada = false;
      try {
        const r = await ini.publicador.registro.registrarQuarentena(ini.publicador.identidadeDe(nomeDaPreparacao, estado.correlacao), 'PUBLICACAO_SEM_CONCLUSAO_CONHECIDA');
        registrada = r.ok === true;
      } catch { registrada = false; }
      if (!registrada) estado.reterTrava = true;
      throw falha;
    }
    // quarentena necessária e NÃO registrada de forma durável: a trava não pode ser liberada
    if (estado.publicacao.quarentena !== undefined && estado.publicacao.quarentena.necessaria === true && estado.publicacao.quarentena.registrada !== true) estado.reterTrava = true;
    avisar({ fase: 'CONCLUIDA', publicada: estado.publicacao.publicada === true, estadoDaPublicacao: estado.publicacao.estado });
  }

  const coordenador = await executarBackupPgDump({
    janela: ini.janela,
    conexao: { ...ini.conexao, planejar: planejarArquivos, ...(ini.layoutDoManifesto === 2 ? { lerAdicionais: (executor) => ini.composicaoL2.lerAdicionais(executor) } : {}) },
    dump,
    copia,
    avaliar,
    ...(ini.verificadorEstrutural === null ? {} : { verificadorEstrutural: ini.verificadorEstrutural }),
    ...(ini.controle === null ? {} : { controle: ini.controle }),
    ...(parada === undefined ? {} : { parada }),
  });

  return Object.freeze({
    coordenador,
    composicao: estado.composicao,
    verificacao: estado.montagem === null ? null : estado.montagem.obterVerificacao(),
    aquisicao: estado.aquisicao,
    evidenciaDoDump: estado.evidencia,
    correlacao: estado.correlacao,
    pacote: estado.pacote,
    publicacao: estado.publicacao,
  });
}

module.exports = { criarInicializacaoConfiavel, executarBackupEncadeado };
