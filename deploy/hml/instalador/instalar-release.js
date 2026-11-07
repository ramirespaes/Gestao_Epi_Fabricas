'use strict';

/**
 * Instalador de releases versionados de homologação (frontend estático e backend).
 *
 * Roda NO SERVIDOR, só com o núcleo do Node e os módulos irmãos desta pasta, e não deve rodar como root. Layout por
 * componente, dados <base> e <nome>:
 *   <base>/<nome>                                link relativo para a release em uso
 *   <base>/.releases/<nome>/<rotulo>/            release imutável (somente leitura)
 *   <base>/.releases/<nome>/anterior             link para o rótulo anterior
 *   <base>/.releases/<nome>/meta/<rotulo>.json   manifesto, identidade e metadados
 *   <base>/.releases/<nome>/{estado,versao}.json, diario.jsonl, .trava/
 *
 * Arquitetura de segurança do sistema de arquivos (ver ancora.js): toda leitura, escrita, troca de link, renomeação
 * e remoção da árvore operacional usa descritores de diretório abertos e verificados (/proc/self/fd no Linux), nunca
 * um caminho remontado, e nada altera estado global do processo (sem chdir, sem configuração mutável compartilhada).
 * Sem âncora por descritor (fora do Linux) a operação fica bloqueada. O que é publicado é conferido por identidade
 * contra o descritor mantido aberto, antes de qualquer ponteiro. O diretório entregue ao processo externo (npm) é o
 * inode já verificado.
 *
 * Garantias: a release só é aceita se o SHA-256 do seu release.json bater com o hash aprovado por um canal externo;
 * a identidade (commit, manifesto, release.json) de um rótulo é imutável; troca atômica por rename de link; trava de
 * concorrência; diário durável (fsync) com reconciliação após queda; nada é escrito, copiado ou apagado nas raízes
 * persistentes; falha de reinício, de versão em execução ou de saúde volta sozinha para a anterior, mas só quando a
 * anterior é íntegra, compatível e a coordenação permite; sem destino seguro o estado crítico é registrado e nada
 * é alterado; coordenação e compatibilidade são reavaliadas imediatamente antes da troca e de cada reinício, e o rastro
 * registra a consulta que de fato autorizou cada ação; uma release só é confirmada com processo e saúde comprovados;
 * o backend fica bloqueado na linha de comando e na biblioteca (provedor homologado, registro vazio em produção)
 * enquanto não houver coordenação homologada com o D-ORF-6. O modelo de ameaça e os limites desta arquitetura estão em
 * docs/sistema/publicacao-homologacao-componentes.md.
 *
 * Uso: node instalar-release.js <instalar|reverter|identificar|reconciliar> --config <json>
 *        --componente <nome> [--release <dir> --release-sha256 <hash aprovado>]
 *        [--observado <json>] [--coordenacao <json>] [--permitir-anterior] [--permitir-retroativo]
 *        [--sem-autenticacao-de-origem] [--sem-comprovacao-de-versao] [--permitir-atual-divergente]
 *        [--permitir-execucao-como-root] [--resolver-estado-critico] [--exigir-durabilidade]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { avaliarCompatibilidade } = require('./compatibilidade');
const { avaliarCoordenacao, consultaPadrao, anexarEvidencia, evidenciaDe, provedorHomologado } = require('./coordenacao');
const { criarAncora } = require('./ancora');
const N = require('./nucleo');

const {
  ErroInstalador, erro, config, chaveDeData, ROTULO, mesmaIdentidade,
  verificarContextoDeExecucao, lerArquivoJsonSeguro, lerConfigSegura, validarConfig, revalidarCaminhos, verificarOperacaoNaInterface,
  criarAncoraDaOperacao, abrirContexto, abrirContextoSeExistir, comTrava, dormir, lerRelease,
  copiarParaPreparo, criarLinkNoPreparo, finalizarPreparo, publicarPreparo,
  exigirDependenciasAusentes, inspecionarDependencias, conferirArvorePreparo, confirmarDestinoDoLink,
  lerEstado, gravarEstado, lerMeta, gravarMeta, removerMeta, registrarDiario, lerDiarioDetalhado, lerLinkAtual, lerLinkAnterior,
  verificarInstalacao, verificarConsistencia, verificarPendencias, escreverVersao, sha256, dentroDe, caminhoReal, operacaoAberta,
} = N;

const iso = (ms) => new Date(ms).toISOString();
const tratado = (e) => { e.tratado = true; return e; };
const clonar = (v) => JSON.parse(JSON.stringify(v));
const alvoDe = (comp, rotulo) => path.posix.join('.releases', comp.nome, rotulo);

// Operações sobre os links, sempre pelo descritor do diretório que os contém. Depois de apontar o link para uma
// release, o destino efetivo é conferido contra a release aberta pelo descritor (PONTEIRO_DIVERGENTE).
const trocarAtual = (ctx, rotulo) => {
  ctx.A.trocarLink(ctx.base, ctx.comp.nome, alvoDe(ctx.comp, rotulo));
  confirmarDestinoDoLink(ctx, rotulo);
};
const trocarAnterior = (ctx, rotulo) => ctx.A.trocarLink(ctx.raiz, 'anterior', rotulo);
const removerAtual = (ctx) => ctx.A.removerEntrada(ctx.base, ctx.comp.nome);
const removerAnterior = (ctx) => ctx.A.removerEntrada(ctx.raiz, 'anterior');
const removerVersao = (ctx) => ctx.A.removerEntrada(ctx.raiz, 'versao.json');
// Idempotente: só troca o que ainda difere.
const garantirAtual = (ctx, rotulo) => { if (ctx.A.lerLink(ctx.base, ctx.comp.nome) !== alvoDe(ctx.comp, rotulo)) trocarAtual(ctx, rotulo); };
const garantirAnterior = (ctx, rotulo) => { if (ctx.A.lerLink(ctx.raiz, 'anterior') !== rotulo) trocarAnterior(ctx, rotulo); };

function usuarioDe(deps) {
  try { return typeof deps.usuario === 'function' ? String(deps.usuario()) : os.userInfo().username; } catch { return 'desconhecido'; }
}

function exigirDeps(comp, deps, opcoes) {
  if (comp.tipo !== 'backend') return;
  if (typeof deps.verificarSaude !== 'function') throw erro('SAUDE_NAO_CONFIGURADA', 'o backend exige verificação de saúde configurada');
  if (typeof deps.reiniciar !== 'function') throw erro('REINICIO_NAO_CONFIGURADO', 'o backend exige reinício do serviço configurado');
  if (typeof deps.identificarProcesso !== 'function' && opcoes.semComprovacaoDeVersao !== true) {
    throw erro('VERSAO_NAO_COMPROVAVEL', 'o backend exige a prova de qual release o processo executa (identificarProcesso); sem ela só com opt-out explícito, que fica registrado');
  }
}
// A biblioteca aplica a mesma política da linha de comando ao backend: trocar, reiniciar ou reverter só com um provedor
// de coordenação HOMOLOGADO com o D-ORF-6 (registro em coordenacao.js, vazio em produção). Um provedor injetado por
// dependência, um arquivo ou um atestado não bastam, porque nenhum deles exclui um backup concorrente. A recusa vem
// antes de qualquer leitura, preparo ou reinício.
function exigirCoordenacaoHomologada(comp, deps, operacao) {
  if (comp.tipo !== 'backend') return;
  if (!provedorHomologado(deps.consultarCoordenacao)) {
    throw erro('COORDENACAO_NAO_HOMOLOGADA', `${operacao} do backend está bloqueado: nenhuma trava de operação do D-ORF-6 foi homologada, e um provedor de coordenação injetado, um arquivo ou um atestado não excluem um backup concorrente`);
  }
}
// Política por componente: frontend estático nunca reinicia nada, nunca instala dependências e não tem processo nem
// saúde. As capacidades são removidas das dependências recebidas, não apenas ignoradas na configuração.
function aplicarPoliticaNasDeps(comp, deps) {
  if (comp.tipo === 'backend') return deps;
  return { ...deps, reiniciar: undefined, identificarProcesso: undefined, verificarSaude: undefined, executar: undefined, consultarCoordenacao: undefined };
}

// ------------------------------------------------------------------------------ diário

// Protocolo: INICIO (obrigatório e durável antes de qualquer mudança), passos intermediários (obrigatórios: se
// não puderem ser gravados a operação para antes de seguir), e um passo final. Falha ao gravar o passo final
// nunca é silenciosa: vira aviso e o diário fica aberto, de modo que a próxima operação reconcilia e exige confirmação.
function criarDiario({ ctx, agora, avisos }) {
  const id = crypto.randomUUID();
  const registro = (passo, extra) => registrarDiario(ctx, { em: iso(agora()), id, passo, ...extra });
  let decidido = false;
  let reiniciou = false;
  return {
    id,
    abrir: (extra) => registro('INICIO', extra),
    passo: (nome, extra = {}) => {
      try { registro(nome, extra); } catch (falha) {
        throw erro('DIARIO_FALHOU', `não foi possível registrar o passo ${nome} no diário (${falha.codigo || falha.code || falha.message}); a operação foi interrompida por segurança`, { passo: nome });
      }
      if (nome === 'REINICIANDO') reiniciou = true;
    },
    encerrar: (nome, extra = {}) => {
      decidido = true;
      try { registro(nome, extra); } catch (falha) {
        avisos.push({ codigo: 'DIARIO_NAO_GRAVADO', mensagem: `o passo final ${nome} não pôde ser gravado no diário (${falha.codigo || falha.code || falha.message}); a próxima operação vai reconciliar e exigir confirmação` });
      }
    },
    deixarAberto: (nome, extra = {}) => {
      decidido = true;
      try { registro(nome, extra); } catch { /* o diário continua aberto de qualquer forma */ }
    },
    get decidido() { return decidido; },
    get reiniciou() { return reiniciou; },
  };
}
// Término registrado só quando o desfazer funcionou; sem isso o diário continua aberto para a reconciliação.
const fecharFalha = (journal, desfeito, extra) => (desfeito ? journal.encerrar('FALHOU', extra) : journal.deixarAberto('FALHA_SEM_DESFAZER', extra));

// ------------------------------------------------------------------ reinício, prova e saúde

async function verificarComTentativas(deps, tentativas, intervaloMs) {
  if (typeof deps.verificarSaude !== 'function') return { ok: true, tentativas: 0 };
  const esperar = deps.esperar || dormir;
  let detalhe;
  for (let i = 1; i <= tentativas; i += 1) {
    try {
      const r = await deps.verificarSaude();
      if (r && r.ok) return { ok: true, tentativas: i };
      detalhe = r && r.detalhe;
    } catch (falha) {
      detalhe = falha.message;
    }
    if (i < tentativas) await esperar(intervaloMs);
  }
  return { ok: false, tentativas, detalhe };
}

// Prova do que está em execução: processo (diretório de trabalho e, quando houve reinício, PID novo) e saúde.
async function comprovarExecucao({ ctx, deps, alvoRotulo, procAntes, tentativas, intervaloMs }) {
  if (typeof deps.identificarProcesso === 'function') {
    let depois;
    try { depois = await deps.identificarProcesso(); } catch (falha) { return { ok: false, motivo: 'VERSAO', detalhe: `não foi possível identificar o processo em execução: ${falha.message}`, tentativas: 0 }; }
    let real = null;
    try { real = fs.realpathSync(depois.cwd); } catch { /* cwd inválido */ }
    let esperado = null;
    try { esperado = fs.realpathSync(path.join(ctx.raiz.caminho, alvoRotulo)); } catch { /* release sumiu */ }
    if (!real || !esperado || real !== esperado) return { ok: false, motivo: 'VERSAO', detalhe: `o processo em execução não usa a release ${alvoRotulo}`, tentativas: 0 };
    if (procAntes && procAntes.pid === depois.pid) return { ok: false, motivo: 'VERSAO', detalhe: 'o processo não foi reiniciado (mesmo PID de antes da troca)', tentativas: 0 };
  }
  const saude = await verificarComTentativas(deps, tentativas, intervaloMs);
  if (!saude.ok) return { ok: false, motivo: 'SAUDE', detalhe: saude.detalhe, tentativas: saude.tentativas };
  return { ok: true, tentativas: saude.tentativas };
}

// Reinício, prova de versão em execução e saúde, nesta ordem. A saúde sozinha não aprova uma release.
// antesDeReiniciar revalida coordenação e compatibilidade imediatamente antes do reinício; se recusar, nada é reiniciado.
// O resultado carrega a autorização (a consulta final que de fato liberou o reinício), para o rastro.
async function reiniciarEComprovar({ ctx, deps, alvoRotulo, procAntes, tentativas, intervaloMs, antesDeReiniciar, aoReiniciar }) {
  let autorizacao;
  if (typeof deps.reiniciar === 'function') {
    // Antes do reinício: coordenação e compatibilidade revalidadas e o passo REINICIANDO gravado no diário. Qualquer
    // recusa aqui (inclusive o diário não gravar) acontece antes de o serviço ser tocado.
    try {
      if (typeof antesDeReiniciar === 'function') autorizacao = await antesDeReiniciar();
      if (typeof aoReiniciar === 'function') await aoReiniciar();
    } catch (falha) { return { ok: false, motivo: 'COORDENACAO', detalhe: falha.message, erro: falha, tentativas: 0 }; }
    try { await deps.reiniciar(); } catch (falha) { return { ok: false, motivo: 'REINICIO', detalhe: falha.message, tentativas: 0, autorizacao }; }
  }
  return { ...(await comprovarExecucao({ ctx, deps, alvoRotulo, procAntes, tentativas, intervaloMs })), autorizacao };
}

const motivoDe = (resumo, pos) => `${resumo}${pos.detalhe ? ` (${String(pos.detalhe).slice(0, 160)})` : ''}`;
const CODIGO_DA_FALHA = { REINICIO: 'REINICIO_FALHOU', VERSAO: 'VERSAO_NAO_COMPROVADA', SAUDE: 'SAUDE_FALHOU', INTERNO: 'FALHA_POS_REINICIO' };
const RESUMO_DA_FALHA = {
  REINICIO: 'o reinício do serviço falhou', VERSAO: 'não foi possível provar que a release nova está em execução', SAUDE: 'a verificação de saúde falhou',
  INTERNO: 'uma falha interna ocorreu depois de o serviço ser reiniciado e o processo pode não corresponder ao link',
};

// ------------------------------------------------------------ compatibilidade e coordenação

// Consulta a coordenação agora. Cada consulta vale só para o instante em que foi feita: uma operação
// protegida repete esta chamada imediatamente antes de executar. A evidência (hash e número da leitura do conteúdo
// efetivamente lido, quando o provedor a oferece) fica no rastro junto com o estado que decidiu.
async function revalidarCoordenacao({ comp, opcoes, deps, agora }) {
  if (comp.tipo !== 'backend') return { atestadoManual: false, rastro: { situacao: 'NAO_APLICAVEL' } };
  const consultar = deps.consultarCoordenacao || consultaPadrao;
  const estado = await consultar();
  // A evidência vem junto do objeto que ESTA consulta devolveu, nunca de um estado guardado no provedor.
  const evidencia = evidenciaDe(estado);
  const coord = avaliarCoordenacao({ tipo: comp.tipo, estado, atestado: opcoes.atestarSemOperacao === true, agora });
  const rastro = {
    situacao: coord.situacao, origem: coord.origem, consultadoEm: estado && typeof estado.consultadoEm === 'string' ? estado.consultadoEm : undefined, atestadoManual: coord.atestadoManual,
    ...(evidencia ? { fonte: evidencia } : {}),
  };
  if (!coord.ok) throw erro(coord.bloqueio.codigo, coord.bloqueio.mensagem, { rastro });
  return { atestadoManual: coord.atestadoManual, rastro };
}

async function avaliarPreCondicoes({ comp, acao, release, opcoes, deps, agora }) {
  const resultado = { avisos: [], atestadoManual: false, rastro: { coordenacao: { situacao: 'NAO_APLICAVEL' }, observado: null } };
  if (comp.tipo !== 'backend') return resultado;
  const observado = opcoes.observado !== undefined ? opcoes.observado : (typeof deps.lerObservado === 'function' ? await deps.lerObservado() : undefined);
  const compat = avaliarCompatibilidade({ acao, release, observado, agora });
  if (!compat.ok) throw erro('INCOMPATIVEL', `incompatível com o estado persistente: ${compat.bloqueios.map((b) => b.codigo).join(', ')}`, { bloqueios: compat.bloqueios, avisos: compat.avisos });
  resultado.avisos = compat.avisos;
  resultado.rastro.observado = { banco: observado.banco, origem: observado.origem, coletadoEm: observado.coletadoEm, migrations: observado.migrations.length, contratos: observado.contratos };
  let rev;
  try {
    rev = await revalidarCoordenacao({ comp, opcoes, deps, agora });
  } catch (falha) {
    falha.detalhes = { ...falha.detalhes, rastro: { coordenacao: falha.detalhes && falha.detalhes.rastro, observado: resultado.rastro.observado } };
    throw falha;
  }
  resultado.atestadoManual = rev.atestadoManual;
  resultado.rastro.coordenacao = rev.rastro;
  return resultado;
}

function eventoDeRastro(evento, rotulo, extras, { pre, opcoes, deps, agora }) {
  const e = { evento, rotulo, em: iso(agora()), usuario: usuarioDe(deps), atestadoManual: pre.atestadoManual, coordenacao: pre.rastro.coordenacao, observado: pre.rastro.observado, ...extras };
  if (opcoes.fontes) e.fontes = clonar(opcoes.fontes);
  return e;
}
// O evento de uma ação registra a consulta FINAL que a autorizou (a do reinício), não a de uma etapa anterior.
function aplicarAutorizacao(evento, autorizacao, opcoes) {
  if (!autorizacao) return;
  evento.coordenacao = autorizacao.rastro.coordenacao;
  evento.observado = autorizacao.rastro.observado;
  evento.atestadoManual = autorizacao.atestadoManual;
  if (opcoes.fontes) evento.fontes = clonar(opcoes.fontes);
}
// Quando o rollback é bloqueado, a decisão se baseou na consulta que o bloqueou.
const preDeBloqueio = (bloqueio) => ({ atestadoManual: false, rastro: bloqueio.rastro && bloqueio.rastro.coordenacao ? bloqueio.rastro : { coordenacao: { situacao: 'NAO_CONSULTADA' }, observado: bloqueio.rastro ? bloqueio.rastro.observado : null } });

// Overrides efetivamente usados nesta operação (não os que apenas foram permitidos). Só nomes e fatos não sensíveis:
// rótulos, contagens. Nenhum valor de configuração, caminho do servidor ou hash informado pelo operador.
function excecoesDaOperacao({ rel, comp, deps, opcoes, extras = [] }) {
  const lista = [];
  if (rel && rel.autenticidade === 'NAO_VERIFICADA') lista.push({ nome: 'semAutenticacao' });
  if (comp.tipo === 'backend' && typeof deps.identificarProcesso !== 'function') lista.push({ nome: 'semComprovacaoDeVersao' });
  if (opcoes.permitirRootEfetivo === true) lista.push({ nome: 'permitirRoot' });
  return [...lista, ...extras];
}
const comExcecoes = (extras, excecoes) => (excecoes.length > 0 ? { ...extras, excecoes } : extras);

// ------------------------------------------------------------ preparo, órfãs e reconciliação

// Todo o preparo é ancorado (ver ancora.js e nucleo.js): cada escrita, chmod, fsync, remoção e o rename final usam
// descritores abertos e verificados, inclusive depois da espera pelas dependências, e o npm recebe o inode já
// verificado como diretório de trabalho. A ordem de durabilidade é: arquivos e diretórios do preparo sincronizados,
// rename para a release, conferência de identidade da entrada publicada, raiz sincronizada, metadado, e só depois
// (no chamador) o ponteiro.
function preparar({ ctx, comp, componente, rel, reaisPersistentes, deps, agora }) {
  const { A } = ctx;
  const nomePreparo = `.preparo-${rel.rotulo}-${process.pid}`;
  const ignorados = [];
  let renomeado = false;
  let identidadeDoPreparo = null; // o inode criado aqui: toda limpeza e toda publicação são conferidas contra ele
  const executar = async () => {
    // 0700 enquanto é preparado: nenhum outro usuário pode plantar entradas nele durante a espera pelo npm.
    const preparo = A.abrirFilho(ctx.raiz, nomePreparo, { criar: true, modo: 0o700 });
    identidadeDoPreparo = A.identidade(preparo);
    const { arquivos, diretorios } = copiarParaPreparo({ A, preparo, manifesto: rel.manifesto, pacote: rel.pacote });
    for (const link of comp.linksPersistentes || []) {
      if (!fs.existsSync(link.destino)) throw erro('PERSISTENTE_AUSENTE', `destino persistente ausente: ${link.destino}`);
      if (!reaisPersistentes.some((p) => dentroDe(p, fs.realpathSync(link.destino)))) throw config('o destino persistente resolve para fora das raízes persistentes');
      criarLinkNoPreparo({ A, preparo, nome: link.nome, destino: link.destino });
      ignorados.push(link.nome);
    }
    if (comp.dependencias) {
      // O npm ci apaga o que encontrar em node_modules, inclusive o conteúdo do destino de um link: o nome não pode existir.
      exigirDependenciasAusentes(A, preparo);
      try {
        await deps.executar(comp.dependencias.comando[0], comp.dependencias.comando.slice(1), { cwd: A.cwdParaProcessoExterno(preparo), caminho: preparo.caminho });
      } catch (falha) {
        throw erro('DEPENDENCIAS_FALHARAM', `instalação de dependências falhou: ${falha.message}`);
      }
      const problemasDeps = inspecionarDependencias(A, preparo, 'node_modules');
      if (problemasDeps.length > 0) throw erro('DEPENDENCIAS_INSEGURAS', `as dependências instaladas não são uma árvore própria: ${problemasDeps.slice(0, 3).join('; ')}`);
      ignorados.push('node_modules');
    }
    finalizarPreparo({ A, preparo, arquivos, diretorios, manifesto: rel.manifesto, subarvores: comp.dependencias ? ['node_modules'] : [] });
    // Os descritores provaram o conteúdo dos inodes copiados; agora os NOMES da árvore precisam alcançar esses mesmos inodes.
    conferirArvorePreparo({ A, preparo, arquivos, diretorios, permitidos: new Set(ignorados), links: comp.linksPersistentes || [] });
    publicarPreparo({ A, raiz: ctx.raiz, preparo, nomePreparo, rotulo: rel.rotulo });
    renomeado = true;
    const meta = {
      componente, rotulo: rel.rotulo, commit: rel.commit, atual: rel.atual, geradoEm: rel.geradoEm, instaladoEm: iso(agora()),
      manifestoSha256: rel.secao.manifestoSha256, releaseSha256: rel.releaseSha256, autenticidade: rel.autenticidade, manifesto: rel.manifesto, ignorados,
      linksPersistentes: (comp.linksPersistentes || []).map((l) => ({ nome: l.nome, destino: l.destino })),
    };
    if (comp.tipo === 'backend') Object.assign(meta, { migrations: rel.secao.migrations, contratos: rel.secao.contratos, lockfileSha256: rel.secao.lockfileSha256 });
    gravarMeta(ctx, rel.rotulo, meta);
    // Verificação final do que foi publicado, lida POR NOME e hasheada de novo, antes de qualquer ponteiro.
    const publicada = verificarInstalacao(ctx, rel.rotulo, { persistentesReais: reaisPersistentes });
    if (!publicada.integro) throw erro('INTEGRIDADE_DIVERGENTE', `a release publicada não confere com o manifesto: ${publicada.problemas.slice(0, 3).join('; ')}`);
    return meta;
  };
  return executar().catch((falha) => {
    // A limpeza também é ancorada e presa à identidade do preparo criado aqui: uma entrada que já não é esse inode
    // nunca é esvaziada. Se a limpeza for recusada, o erro original prevalece. Uma entrada de release que não é o
    // diretório preparado fica em quarentena (renomeado continua falso) e é tratada como órfã depois.
    const comIdentidade = identidadeDoPreparo ? { identidade: identidadeDoPreparo } : {};
    try { A.removerArvore(ctx.raiz, nomePreparo, comIdentidade); } catch { /* fica para a reconciliação */ }
    if (renomeado) {
      try {
        A.removerArvore(ctx.raiz, rel.rotulo, comIdentidade);
        removerMeta(ctx, rel.rotulo);
      } catch { /* o que não pôde ser limpo com segurança fica para a reconciliação */ }
    }
    throw falha;
  });
}

// Remove só o que esta ferramenta cria e que nunca chegou a ser publicado: preparos e releases sem metadados fora de uso.
function limparOrfas(ctx) {
  const { A } = ctx;
  let atual = null;
  try { atual = lerLinkAtual(ctx); } catch { /* a operação trata */ }
  const anterior = lerLinkAnterior(ctx);
  const removidas = [];
  for (const e of A.listar(ctx.raiz)) {
    if (!e.ehDiretorio) continue;
    const orfaDePreparo = e.nome.startsWith('.preparo-');
    const orfaDeRelease = ROTULO.test(e.nome) && !lerMeta(ctx, e.nome) && e.nome !== atual && e.nome !== anterior;
    if (orfaDePreparo || orfaDeRelease) { A.removerArvore(ctx.raiz, e.nome); removidas.push(e.nome); }
  }
  return removidas;
}

// Faz os registros (estado.json, versao.json, link anterior) seguirem o link em uso, que é a fonte da verdade.
function alinharRegistros({ ctx, componente, atual, anteriorRotulo, comprovada, evento, critico }) {
  if (anteriorRotulo) garantirAnterior(ctx, anteriorRotulo);
  else removerAnterior(ctx);
  const meta = lerMeta(ctx, atual);
  if (!meta) return;
  const estado = lerEstado(ctx);
  const anteriorNovo = anteriorRotulo ? { rotulo: anteriorRotulo, commit: (lerMeta(ctx, anteriorRotulo) || {}).commit ?? null } : null;
  const estadoJaDizAtual = estado.atual && estado.atual.rotulo === atual;
  const atualNovo = estadoJaDizAtual && comprovada === undefined ? estado.atual : { rotulo: atual, commit: meta.commit, instaladoEm: meta.instaladoEm, comprovada: comprovada === undefined ? false : comprovada };
  const mudou = Boolean(critico) || JSON.stringify([estado.atual, estado.anterior]) !== JSON.stringify([atualNovo, anteriorNovo]);
  estado.atual = atualNovo;
  estado.anterior = anteriorNovo;
  if (critico) estado.critico = critico;
  if (mudou) { estado.historico.push(evento); gravarEstado(ctx, estado); }
  escreverVersao(ctx, componente, meta);
}

// Operação interrompida depois de o reinício começar: o processo pode não corresponder ao link. O estado fica
// crítico (bloqueia novas operações) até a release em uso ser confirmada com reinício, processo e saúde comprovados.
const criticoDoReinicio = (aberta, atual, em) => (aberta.reiniciou
  ? { desde: em, motivo: 'OPERACAO_INTERROMPIDA_APOS_REINICIO', release: atual, operacao: aberta.operacao, id: aberta.id }
  : undefined);

function reconciliarSobTrava(ctx, componente, agoraMs) {
  // O diário é lido ANTES de qualquer limpeza: diário ilegível (DIARIO_ILEGIVEL) bloqueia a reconciliação inteira, e
  // nada é removido sobre um registro que não pôde ser lido.
  const aberta = operacaoAberta(ctx);
  const resultado = { interrompida: false, situacao: null, comprovada: null, orfasRemovidas: limparOrfas(ctx) };
  if (!aberta) return resultado;
  const atual = lerLinkAtual(ctx);
  const em = iso(agoraMs);
  resultado.interrompida = true;
  if (atual === aberta.para) {
    // A release nova está em uso, mas ninguém provou processo e saúde: fica registrada como NÃO comprovada.
    resultado.situacao = 'NOVA_EM_USO_SEM_CONFIRMACAO';
    resultado.comprovada = false;
    alinharRegistros({
      ctx, componente, atual, anteriorRotulo: aberta.de || null, comprovada: false, critico: criticoDoReinicio(aberta, atual, em),
      evento: { evento: 'RECUPERACAO', rotulo: atual, de: aberta.de, situacao: resultado.situacao, comprovada: false, ...(aberta.reiniciou ? { reiniciou: true } : {}), em },
    });
    registrarDiario(ctx, { em, id: aberta.id, passo: 'RECUPERADA', situacao: resultado.situacao, comprovada: false });
  } else if (atual === aberta.de) {
    // O link ficou (ou voltou) na release anterior. Se os registros ainda dizem outra coisa, ou se o serviço chegou a
    // ser reiniciado, o processo pode ser o da release nova: a anterior só é dada como comprovada se nada disso ocorreu.
    resultado.situacao = 'ABORTADA';
    const estado = lerEstado(ctx);
    const registrosJaDizem = Boolean(estado.atual) && estado.atual.rotulo === atual && !aberta.reiniciou;
    const linkAnterior = lerLinkAnterior(ctx);
    resultado.comprovada = registrosJaDizem ? (estado.atual.comprovada === false ? false : null) : false;
    alinharRegistros({
      ctx, componente, atual, anteriorRotulo: linkAnterior && linkAnterior !== atual ? linkAnterior : null, critico: criticoDoReinicio(aberta, atual, em),
      comprovada: registrosJaDizem ? undefined : false,
      evento: { evento: 'RECUPERACAO', rotulo: atual, de: aberta.de, situacao: resultado.situacao, comprovada: false, ...(aberta.reiniciou ? { reiniciou: true } : {}), em },
    });
    registrarDiario(ctx, { em, id: aberta.id, passo: 'ABORTADA', situacao: resultado.situacao });
  } else {
    throw erro('ESTADO_INCONSISTENTE', `a operação interrompida (${aberta.id}) não bate com o link em uso (${atual}); verifique manualmente`);
  }
  if (resultado.comprovada === false) resultado.pendencia = `a release em uso (${atual}) não teve processo e saúde comprovados: reinstale a mesma release para confirmar ou reverta`;
  return resultado;
}

async function reconciliar({ config: bruta, componente, deps = {} } = {}) {
  const cfg = validarConfig(bruta);
  const comp = cfg.componentes[componente];
  if (!comp) throw erro('COMPONENTE_DESCONHECIDO', `componente desconhecido: ${componente}`);
  revalidarCaminhos(cfg, comp);
  const agora = deps.agora || Date.now;
  const A = criarAncoraDaOperacao(deps);
  try {
    const ctx = abrirContextoSeExistir(A, comp);
    if (!ctx) return { interrompida: false, situacao: null, comprovada: null, orfasRemovidas: [] };
    return finalizarResultado(A, await comTrava(ctx, 'reconciliar', async () => reconciliarSobTrava(ctx, componente, agora())));
  } finally { A.fecharTudo(); }
}

function aplicarRetencao(ctx, cfg, manter) {
  const { A } = ctx;
  const itens = A.listar(ctx.raiz)
    .filter((e) => e.ehDiretorio && ROTULO.test(e.nome))
    .map((e) => ({ rotulo: e.nome, instaladoEm: (lerMeta(ctx, e.nome) || {}).instaladoEm || '' }))
    .sort((a, b) => (a.instaladoEm === b.instaladoEm ? (a.rotulo < b.rotulo ? 1 : -1) : (a.instaladoEm < b.instaladoEm ? 1 : -1)));
  const ficam = new Set([...itens.slice(0, cfg.retencao).map((i) => i.rotulo), ...manter.filter(Boolean)]);
  for (const item of itens) {
    if (ficam.has(item.rotulo)) continue;
    A.removerArvore(ctx.raiz, item.rotulo);
    removerMeta(ctx, item.rotulo);
  }
}

// Volta o link e os registros para o estado anterior depois de um erro inesperado, em qualquer ponto entre as trocas.
// Idempotente: só troca o que ainda difere. Devolve false se algum link não pôde ser restaurado.
function desfazerTroca({ ctx, componente, restaurarAtual, restaurarAnterior, estadoAntes }) {
  try {
    if (restaurarAtual) {
      garantirAtual(ctx, restaurarAtual);
      if (restaurarAnterior) garantirAnterior(ctx, restaurarAnterior);
      else removerAnterior(ctx);
      const meta = lerMeta(ctx, restaurarAtual);
      if (meta) { try { escreverVersao(ctx, componente, meta); } catch { /* o link já voltou */ } }
    } else {
      removerAtual(ctx);
      removerAnterior(ctx);
      try { removerVersao(ctx); } catch { /* não existia */ }
    }
    try { gravarEstado(ctx, estadoAntes); } catch { /* o link é a fonte da verdade */ }
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------- operações

async function instalar({ config: bruta, componente, release, opcoes = {}, deps: depsBrutas = {} } = {}) {
  const cfg = validarConfig(bruta);
  const comp = cfg.componentes[componente];
  if (!comp) throw erro('COMPONENTE_DESCONHECIDO', `componente desconhecido: ${componente}`);
  const deps = aplicarPoliticaNasDeps(comp, depsBrutas);
  exigirCoordenacaoHomologada(comp, deps, 'instalar');
  exigirDeps(comp, deps, opcoes);
  const rel = lerRelease(release, componente, comp, opcoes);
  const reaisPersistentes = revalidarCaminhos(cfg, comp);
  const agora = deps.agora || Date.now;
  const A = criarAncoraDaOperacao(deps, opcoes); // exigência de durabilidade desta operação e só dela
  try {
    const ctx = abrirContexto(A, comp, { criar: true });
    const resultado = await comTrava(ctx, 'instalar', () => instalarSobTrava({ cfg, comp, componente, rel, reaisPersistentes, opcoes, deps, agora, ctx }));
    return finalizarResultado(A, resultado);
  } finally { A.fecharTudo(); }
}

// Fecha o resultado de TODA operação que escreve (instalar, reverter, reconciliar). A durabilidade só é afirmada quando
// o sistema de arquivos a suporta: o contrário é informado, nunca omitido, e sempre pela mesma função.
function finalizarResultado(A, resultado) {
  if (resultado === null || typeof resultado !== 'object') return resultado;
  if (A.durabilidade.naoSuportado > 0) {
    if (!Array.isArray(resultado.avisos)) resultado.avisos = [];
    resultado.avisos.push({ codigo: 'DURABILIDADE_NAO_GARANTIDA', mensagem: `o sistema de arquivos não suportou fsync de diretório em ${A.durabilidade.naoSuportado} ocasião(ões): não afirme durabilidade desta operação sem validar o sistema de arquivos real` });
  }
  resultado.ancora = A.modo;
  return resultado;
}

const tentativasDe = (opcoes) => opcoes.tentativasSaude || 3;
const intervaloDe = (opcoes) => (opcoes.intervaloSaudeMs === undefined ? 2000 : opcoes.intervaloSaudeMs);

async function instalarSobTrava({ cfg, comp, componente, rel, reaisPersistentes, opcoes, deps, agora, ctx }) {
  const avisos = [];
  const rec = reconciliarSobTrava(ctx, componente, agora());
  if (rec.interrompida) avisos.push({ codigo: 'OPERACAO_ANTERIOR_INTERROMPIDA', mensagem: `uma operação anterior foi interrompida e reconciliada (${rec.situacao})` });
  const estado = lerEstado(ctx);
  const antes = clonar(estado);
  const anteriorRotulo = lerLinkAtual(ctx);
  const verificar = (rotulo) => verificarInstalacao(ctx, rotulo, { persistentesReais: reaisPersistentes });

  if (anteriorRotulo === rel.rotulo) {
    const v = verificar(rel.rotulo);
    if (!v.integro) throw erro('INSTALADA_CORROMPIDA', `a release já instalada está adulterada: ${v.problemas.slice(0, 3).join('; ')}`);
    const instalada = lerMeta(ctx, rel.rotulo);
    if (!mesmaIdentidade(instalada, rel)) throw erro('IDENTIDADE_DIVERGENTE', `o rótulo ${rel.rotulo} já pertence a outra release (commit, manifesto ou release.json diferentes)`);
    // Idempotência só com prova: release registrada como comprovada e processo e saúde conferidos agora.
    const pendente = (estado.atual && estado.atual.comprovada === false) || Boolean(estado.critico);
    if (!pendente) {
      const prova = await comprovarExecucao({ ctx, deps, alvoRotulo: rel.rotulo, procAntes: null, tentativas: tentativasDe(opcoes), intervaloMs: intervaloDe(opcoes) });
      if (prova.ok) return { resultado: 'JA_INSTALADA', componente, rotulo: rel.rotulo, commit: instalada.commit, avisos };
      avisos.push({ codigo: 'INSTALADA_SEM_PROVA', mensagem: `a release já instalada não foi comprovada em execução (${prova.motivo}); a confirmação com reinício será feita` });
    }
    return confirmarSobTrava({ ctx, comp, componente, rel, instalada, estado, reaisPersistentes, avisos, opcoes, deps, agora });
  }
  // Estado crítico bloqueia qualquer operação que não seja a confirmação da release em uso (tratada acima). A saída é
  // explícita, registrada e passa por todas as demais verificações e provas.
  if (estado.critico && opcoes.resolverEstadoCritico !== true) {
    throw erro('ESTADO_CRITICO', `há um estado crítico registrado (${estado.critico.motivo}); novas instalações estão bloqueadas. Confirme a release em uso (instalar a mesma release) ou use resolverEstadoCritico de forma explícita`);
  }
  const excecoes = excecoesDaOperacao({ rel, comp, deps, opcoes });
  if (estado.critico) excecoes.push({ nome: 'resolverEstadoCritico', motivo: estado.critico.motivo });
  if (anteriorRotulo) {
    const v = verificar(anteriorRotulo);
    if (!v.integro) {
      if (opcoes.permitirAtualDivergente !== true) throw erro('ATUAL_CORROMPIDA', `a release em uso não confere com seus metadados (${v.problemas.slice(0, 2).join('; ')}); corrija ou use permitirAtualDivergente de forma explícita`);
      excecoes.push({ nome: 'permitirAtualDivergente', problemas: v.problemas.length });
    }
  }
  if (!rel.atual) {
    if (opcoes.permitirRetroativo !== true) throw erro('RETROATIVA_BLOQUEADA', 'release retroativa exige permitirRetroativo');
    excecoes.push({ nome: 'permitirRetroativo' });
  }
  if (anteriorRotulo && chaveDeData(rel.rotulo) < chaveDeData(anteriorRotulo)) {
    if (opcoes.permitirAnterior !== true) throw erro('DOWNGRADE_BLOQUEADO', 'release mais antiga que a instalada exige permitirAnterior');
    excecoes.push({ nome: 'permitirAnterior', de: anteriorRotulo, para: rel.rotulo });
  }

  const jaExiste = Boolean(ctx.A.tipo(ctx.raiz, rel.rotulo));
  if (jaExiste) {
    const v = verificar(rel.rotulo);
    if (!v.integro) throw erro('DESTINO_EXISTE_CORROMPIDO', `a release ${rel.rotulo} já existe e não confere: ${v.problemas.slice(0, 3).join('; ')}`);
    if (!mesmaIdentidade(lerMeta(ctx, rel.rotulo), rel)) throw erro('IDENTIDADE_DIVERGENTE', `o rótulo ${rel.rotulo} já pertence a outra release (commit, manifesto ou release.json diferentes)`);
  }
  const preCondicoes = () => avaliarPreCondicoes({ comp, acao: 'instalar', release: rel.secao, opcoes, deps, agora: agora() });
  let pre = await preCondicoes();
  avisos.push(...pre.avisos);

  const journal = criarDiario({ ctx, agora, avisos });
  journal.abrir({ operacao: 'instalar', de: anteriorRotulo, para: rel.rotulo, commit: rel.commit, ...(excecoes.length ? { excecoes: excecoes.map((x) => x.nome) } : {}) });
  const restaurarAnterior = antes.anterior && antes.anterior.rotulo ? antes.anterior.rotulo : null;
  const desfazer = () => desfazerTroca({ ctx, componente, restaurarAtual: anteriorRotulo, restaurarAnterior, estadoAntes: antes });

  try {
    let procAntes = null;
    if (typeof deps.identificarProcesso === 'function') { try { procAntes = await deps.identificarProcesso(); } catch { procAntes = null; } }
    const meta = jaExiste ? lerMeta(ctx, rel.rotulo) : await preparar({ ctx, comp, componente, rel, reaisPersistentes, deps, agora });
    journal.passo('PREPARADA');

    // O preparo pode ter demorado (instalação de dependências): coordenação e compatibilidade valem para o instante da troca.
    pre = await preCondicoes();

    try {
      trocarAtual(ctx, rel.rotulo);
      if (anteriorRotulo) trocarAnterior(ctx, anteriorRotulo);
      else removerAnterior(ctx);
      journal.passo('TROCADA');

      const metaAnterior = anteriorRotulo ? lerMeta(ctx, anteriorRotulo) : null;
      estado.atual = { rotulo: rel.rotulo, commit: rel.commit, instaladoEm: meta.instaladoEm, comprovada: false };
      estado.anterior = anteriorRotulo ? { rotulo: anteriorRotulo, commit: metaAnterior ? metaAnterior.commit : null } : null;
      const evento = eventoDeRastro('INSTALACAO', rel.rotulo, comExcecoes({ commit: rel.commit, autenticidade: rel.autenticidade, releaseSha256: rel.releaseSha256 }, excecoes), { pre, opcoes, deps, agora });
      if (comp.tipo === 'backend') evento.versaoComprovada = typeof deps.identificarProcesso === 'function';
      estado.historico.push(evento);
      gravarEstado(ctx, estado);
      escreverVersao(ctx, componente, meta);

      const pos = await reiniciarEComprovar({
        ctx, deps, alvoRotulo: rel.rotulo, procAntes, tentativas: tentativasDe(opcoes), intervaloMs: intervaloDe(opcoes),
        antesDeReiniciar: comp.tipo === 'backend' ? preCondicoes : undefined, aoReiniciar: () => journal.passo('REINICIANDO'),
      });
      if (pos.motivo === 'COORDENACAO') {
        // Nada foi reiniciado: o serviço segue com a release anterior; só o link e os registros voltam.
        const desfeito = desfazer();
        fecharFalha(journal, desfeito, { motivo: pos.erro.codigo || 'COORDENACAO', desfeito });
        throw tratado(pos.erro);
      }
      aplicarAutorizacao(evento, pos.autorizacao, opcoes);
      const recuperacao = { ctx, comp, componente, rel, anteriorRotulo, restaurarAnterior, estado, antes, deps, agora, pre: pos.autorizacao || pre, opcoes, journal, reaisPersistentes };
      if (!pos.ok) return await recuperarOuCritico({ ...recuperacao, pos });

      // A release já está provada em execução. Se só o registro dessa prova falhar, não se derruba uma release
      // saudável: o estado fica como "não comprovada" (conservador), o aviso é explícito e a próxima operação confirma.
      estado.atual.comprovada = true;
      estado.critico = null;
      try {
        gravarEstado(ctx, estado);
      } catch (falha) {
        avisos.push({ codigo: 'ESTADO_NAO_ATUALIZADO', mensagem: `a release foi comprovada, mas o registro da comprovação falhou (${falha.code || falha.message}); o estado segue como não comprovado até a próxima confirmação` });
      }
      try {
        aplicarRetencao(ctx, cfg, [rel.rotulo, anteriorRotulo]);
      } catch (falha) {
        avisos.push({ codigo: 'RETENCAO_FALHOU', mensagem: `a instalação foi concluída, mas a limpeza de releases antigas falhou: ${falha.code || falha.message}` });
      }
      journal.encerrar('CONCLUIDA');
      return { resultado: 'INSTALADA', componente, rotulo: rel.rotulo, commit: rel.commit, anterior: anteriorRotulo, atestadoManual: (pos.autorizacao || pre).atestadoManual, avisos };
    } catch (falha) {
      if (falha && falha.tratado) throw falha;
      if (journal.reiniciou) {
        // O serviço já foi (ou começou a ser) reiniciado: desfazer só o link deixaria o processo numa release e o
        // link em outra. A única saída é voltar à release de antes com reinício e prova, ou ficar crítico.
        const pos = { ok: false, motivo: 'INTERNO', detalhe: falha.code || falha.message, tentativas: 0 };
        return await recuperarOuCritico({ ctx, comp, componente, rel, anteriorRotulo, restaurarAnterior, estado, antes, deps, agora, pre, opcoes, journal, reaisPersistentes, pos });
      }
      const desfeito = desfazer();
      fecharFalha(journal, desfeito, { motivo: 'POS_TROCA', desfeito });
      throw erro('FALHA_POS_TROCA', `falha inesperada depois da troca (${falha.codigo || falha.code || falha.message});${desfeito ? 'o link voltou para a release anterior' : 'o link NÃO pôde ser restaurado, verifique manualmente (a próxima operação reconcilia pelo diário)'}`, { desfeito, causa: falha.codigo || falha.code || falha.name });
    }
  } catch (falha) {
    if (!journal.decidido) journal.encerrar('FALHOU', { motivo: falha.codigo || falha.code || 'ERRO' });
    throw falha;
  }
}

// Recupera voltando à release de antes da operação (com reinício e prova). Se a própria recuperação falhar de forma
// encadeada, o diário continua aberto (a próxima operação reconcilia como crítica) e o estado crítico é registrado
// quando possível. Nunca restaura uma prova antiga sem reiniciar e verificar o processo.
async function recuperarOuCritico(args) {
  try {
    return await reverterAposFalha(args);
  } catch (falha) {
    if (falha && falha.tratado) throw falha;
    const { ctx, antes, journal, agora, pos } = args;
    journal.deixarAberto('CRITICO', { motivo: 'RECUPERACAO_FALHOU', causa: falha.code || falha.name });
    let registrado = false;
    try {
      // O registro descreve a release de antes da operação, para a qual a recuperação tentava voltar, sem prova.
      if (antes.atual) antes.atual.comprovada = false;
      antes.critico = { desde: iso(agora()), motivo: 'RECUPERACAO_FALHOU', falhaOriginal: { motivo: pos.motivo, detalhe: pos.detalhe }, causa: falha.code || falha.name };
      gravarEstado(ctx, antes);
      registrado = true;
    } catch { /* sem como persistir: o diário aberto garante o bloqueio na próxima operação */ }
    throw tratado(erro('FALHA_POS_REINICIO', `${motivoDe(RESUMO_DA_FALHA[pos.motivo], pos)}; a recuperação também falhou (${falha.code || falha.message}) e o processo pode não corresponder ao link. ${registrado ? 'O estado crítico foi registrado.' : 'O diário ficou aberto e a próxima operação reconcilia como crítica.'} Novas operações ficam bloqueadas até a release em uso ser confirmada`, {
      recuperado: false, critico: true, estadoCriticoRegistrado: registrado, causa: falha.code || falha.name,
    }));
  }
}

// Confirma uma release que já está em uso mas não teve processo e saúde comprovados (por exemplo, depois de uma
// reconciliação): reinicia, prova e só então marca como comprovada. Se não provar, volta para a anterior com as
// mesmas travas do rollback automático.
async function confirmarSobTrava({ ctx, comp, componente, rel, instalada, estado, reaisPersistentes, avisos, opcoes, deps, agora }) {
  const anteriorRotulo = lerLinkAnterior(ctx);
  const preCondicoes = () => avaliarPreCondicoes({ comp, acao: 'instalar', release: rel.secao, opcoes, deps, agora: agora() });
  const pre = await preCondicoes();
  avisos.push(...pre.avisos);
  const journal = criarDiario({ ctx, agora, avisos });
  const excecoes = excecoesDaOperacao({ rel, comp, deps, opcoes, extras: estado.critico ? [{ nome: 'resolverEstadoCritico', motivo: estado.critico.motivo }] : [] });
  journal.abrir({ operacao: 'confirmar', de: anteriorRotulo, para: rel.rotulo, commit: rel.commit, ...(excecoes.length ? { excecoes: excecoes.map((x) => x.nome) } : {}) });
  try {
    let procAntes = null;
    if (typeof deps.identificarProcesso === 'function') { try { procAntes = await deps.identificarProcesso(); } catch { procAntes = null; } }
    const pos = await reiniciarEComprovar({
      ctx, deps, alvoRotulo: rel.rotulo, procAntes, tentativas: tentativasDe(opcoes), intervaloMs: intervaloDe(opcoes),
      antesDeReiniciar: comp.tipo === 'backend' ? preCondicoes : undefined, aoReiniciar: () => journal.passo('REINICIANDO'),
    });
    if (pos.motivo === 'COORDENACAO') {
      journal.encerrar('FALHOU', { motivo: pos.erro.codigo || 'COORDENACAO' });
      throw tratado(pos.erro);
    }
    if (!pos.ok) {
      const metaAnterior = anteriorRotulo ? lerMeta(ctx, anteriorRotulo) : null;
      const antes = clonar(estado);
      antes.atual = anteriorRotulo ? { rotulo: anteriorRotulo, commit: metaAnterior ? metaAnterior.commit : null, instaladoEm: metaAnterior ? metaAnterior.instaladoEm : null, comprovada: true } : null;
      antes.anterior = null;
      return await recuperarOuCritico({ ctx, comp, componente, rel, anteriorRotulo, restaurarAnterior: null, estado, antes, pos, deps, agora, pre: pos.autorizacao || pre, opcoes, journal, reaisPersistentes });
    }
    // O processo e a saúde já foram provados agora. Se só o registro falhar, o estado segue conservador e explícito.
    const autorizacao = pos.autorizacao || pre;
    estado.atual = { ...estado.atual, comprovada: true };
    estado.critico = null;
    estado.historico.push(eventoDeRastro('CONFIRMACAO', rel.rotulo, comExcecoes({ commit: rel.commit, autenticidade: rel.autenticidade, releaseSha256: rel.releaseSha256, versaoComprovada: typeof deps.identificarProcesso === 'function' }, excecoes), { pre: autorizacao, opcoes, deps, agora }));
    try {
      gravarEstado(ctx, estado);
    } catch (falha) {
      avisos.push({ codigo: 'ESTADO_NAO_ATUALIZADO', mensagem: `a release foi comprovada, mas o registro da comprovação falhou (${falha.code || falha.message}); o estado segue como não comprovado até a próxima confirmação` });
    }
    journal.encerrar('CONCLUIDA');
    return { resultado: 'CONFIRMADA', componente, rotulo: rel.rotulo, commit: instalada.commit, anterior: anteriorRotulo, atestadoManual: autorizacao.atestadoManual, avisos };
  } catch (falha) {
    if (!journal.decidido) journal.encerrar('FALHOU', { motivo: falha.codigo || falha.code || 'ERRO' });
    throw falha;
  }
}

// O rollback automático só acontece quando a release anterior é íntegra, compatível com as migrations e contratos
// observados agora e a coordenação permite: as mesmas verificações da reversão manual.
async function avaliarDestinoDoRollback({ ctx, comp, anteriorRotulo, opcoes, deps, agora, reaisPersistentes }) {
  const meta = lerMeta(ctx, anteriorRotulo);
  const v = verificarInstalacao(ctx, anteriorRotulo, { persistentesReais: reaisPersistentes });
  if (!meta || !v.integro) return { codigo: 'ANTERIOR_CORROMPIDA', mensagem: `a release anterior não confere: ${v.problemas.slice(0, 3).join('; ')}`, problemas: v.problemas.slice(0, 5) };
  try {
    await avaliarPreCondicoes({ comp, acao: 'reverter', release: { migrations: meta.migrations, contratos: meta.contratos }, opcoes, deps, agora: agora() });
  } catch (falha) {
    return { codigo: falha.codigo || 'ERRO', mensagem: falha.message, bloqueios: falha.detalhes && falha.detalhes.bloqueios, rastro: falha.detalhes && falha.detalhes.rastro };
  }
  return null;
}

async function reverterAposFalha({ ctx, comp, componente, rel, anteriorRotulo, restaurarAnterior, estado, antes, pos, deps, agora, pre, opcoes, journal, reaisPersistentes }) {
  const codigo = CODIGO_DA_FALHA[pos.motivo];
  if (!anteriorRotulo) {
    const evento = eventoDeRastro('FALHA_PRIMEIRA_INSTALACAO', rel.rotulo, { motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas }, { pre, opcoes, deps, agora });
    removerAtual(ctx);
    removerAnterior(ctx);
    antes.atual = null;
    antes.anterior = null;
    antes.historico.push(evento);
    gravarEstado(ctx, antes);
    try { removerVersao(ctx); } catch { /* ainda não existia */ }
    journal.encerrar('FALHOU', { motivo: pos.motivo });
    throw tratado(erro(codigo, `${motivoDe(RESUMO_DA_FALHA[pos.motivo], pos)}; sem release anterior, nada ficou publicado`, { reverteu: false, motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas }));
  }

  let bloqueio = await avaliarDestinoDoRollback({ ctx, comp, anteriorRotulo, opcoes, deps, agora, reaisPersistentes });
  if (!bloqueio) {
    // O passo REVERTENDO precisa ficar no diário antes de qualquer troca; se não puder, o rollback também é bloqueado.
    try { journal.passo('REVERTENDO', { para: anteriorRotulo }); } catch (falha) { bloqueio = { codigo: falha.codigo || 'DIARIO_FALHOU', mensagem: falha.message }; }
  }
  if (bloqueio) {
    // Sem destino comprovadamente seguro, nada é alterado: a release com falha continua em uso e o estado crítico
    // fica registrado, com o rastro da consulta que bloqueou.
    const evento = eventoDeRastro('ROLLBACK_BLOQUEADO', rel.rotulo, { motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas, bloqueio: { codigo: bloqueio.codigo, mensagem: bloqueio.mensagem } }, { pre: preDeBloqueio(bloqueio), opcoes, deps, agora });
    estado.critico = { desde: iso(agora()), motivo: 'ROLLBACK_BLOQUEADO', release: rel.rotulo, tentouVoltarPara: anteriorRotulo, falhaOriginal: { motivo: pos.motivo, detalhe: pos.detalhe }, bloqueio: bloqueio.codigo };
    estado.historico.push(evento);
    gravarEstado(ctx, estado);
    journal.encerrar('FALHOU', { motivo: 'ROLLBACK_BLOQUEADO', bloqueio: bloqueio.codigo });
    throw tratado(erro('ROLLBACK_BLOQUEADO', `${motivoDe(RESUMO_DA_FALHA[pos.motivo], pos)}; o rollback para ${anteriorRotulo} foi bloqueado (${bloqueio.codigo}: ${bloqueio.mensagem}) e nada foi alterado: ${rel.rotulo} continua em uso e exige ação humana`, {
      reverteu: false, motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas, bloqueio,
    }));
  }

  garantirAtual(ctx, anteriorRotulo);
  if (restaurarAnterior) garantirAnterior(ctx, restaurarAnterior);
  else removerAnterior(ctx);
  const metaAnterior = lerMeta(ctx, anteriorRotulo);
  const guarda = comp.tipo === 'backend' && metaAnterior
    ? () => avaliarPreCondicoes({ comp, acao: 'reverter', release: { migrations: metaAnterior.migrations, contratos: metaAnterior.contratos }, opcoes, deps, agora: agora() })
    : undefined;
  const rec = await reiniciarEComprovar({ ctx, deps, alvoRotulo: anteriorRotulo, procAntes: null, tentativas: 1, intervaloMs: 0, antesDeReiniciar: guarda, aoReiniciar: () => journal.passo('REINICIANDO') });
  const reinicioAposReversao = rec.motivo !== 'REINICIO' && rec.motivo !== 'COORDENACAO';
  // O evento é montado depois da recuperação, com a consulta que de fato autorizou o reinício de volta.
  const evento = eventoDeRastro('REVERSAO_AUTOMATICA', rel.rotulo, { motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas }, { pre: rec.autorizacao || pre, opcoes, deps, agora });
  evento.reinicioAposReversao = reinicioAposReversao;
  evento.saudeAposReversao = rec.ok;
  evento.recuperacao = rec.ok ? 'OK' : rec.motivo;
  antes.historico.push(evento);
  if (antes.atual) antes.atual.comprovada = rec.ok;
  antes.critico = rec.ok ? null : { desde: iso(agora()), motivo: 'RECUPERACAO_NAO_CONFIRMADA', release: anteriorRotulo, falhaOriginal: { motivo: pos.motivo, detalhe: pos.detalhe }, recuperacao: rec.motivo };
  // A identidade pública (versao.json) é escrita antes do estado: se o estado falhar, ela já coincide com link e processo.
  if (metaAnterior) escreverVersao(ctx, componente, metaAnterior);
  gravarEstado(ctx, antes);
  journal.encerrar('REVERTIDA_AUTOMATICA', { motivo: pos.motivo, recuperacao: evento.recuperacao });
  throw tratado(erro(codigo, `${motivoDe(RESUMO_DA_FALHA[pos.motivo], pos)}; voltou para ${anteriorRotulo}${rec.ok ? '' : ` e a recuperação também não foi confirmada (${rec.motivo})`}`, {
    reverteu: true, recuperado: rec.ok, motivo: pos.motivo, detalhe: pos.detalhe, tentativas: pos.tentativas, reinicioAposReversao, saudeAposReversao: rec.ok,
  }));
}

async function reverter({ config: bruta, componente, opcoes = {}, deps: depsBrutas = {} } = {}) {
  const cfg = validarConfig(bruta);
  const comp = cfg.componentes[componente];
  if (!comp) throw erro('COMPONENTE_DESCONHECIDO', `componente desconhecido: ${componente}`);
  const deps = aplicarPoliticaNasDeps(comp, depsBrutas);
  exigirCoordenacaoHomologada(comp, deps, 'reverter');
  exigirDeps(comp, deps, opcoes);
  const reaisPersistentes = revalidarCaminhos(cfg, comp);
  const agora = deps.agora || Date.now;
  const A = criarAncoraDaOperacao(deps, opcoes);
  try {
    const ctx = abrirContextoSeExistir(A, comp);
    if (!ctx) throw erro('SEM_ANTERIOR', 'nada instalado para reverter');
    const resultado = await comTrava(ctx, 'reverter', () => reverterSobTrava({ comp, componente, reaisPersistentes, opcoes, deps, agora, ctx }));
    return finalizarResultado(A, resultado);
  } finally { A.fecharTudo(); }
}

async function reverterSobTrava({ comp, componente, reaisPersistentes, opcoes, deps, agora, ctx }) {
  const avisos = [];
  const rec = reconciliarSobTrava(ctx, componente, agora());
  if (rec.interrompida) avisos.push({ codigo: 'OPERACAO_ANTERIOR_INTERROMPIDA', mensagem: `uma operação anterior foi interrompida e reconciliada (${rec.situacao})` });
  const estado = lerEstado(ctx);
  const antes = clonar(estado);
  const atualRotulo = lerLinkAtual(ctx);
  const anteriorRotulo = lerLinkAnterior(ctx);
  if (!atualRotulo || !anteriorRotulo) throw erro('SEM_ANTERIOR', 'não há release anterior para reverter');
  if (estado.critico && opcoes.resolverEstadoCritico !== true) {
    throw erro('ESTADO_CRITICO', `há um estado crítico registrado (${estado.critico.motivo}); a reversão está bloqueada. Confirme a release em uso (instalar a mesma release) ou use resolverEstadoCritico de forma explícita`);
  }
  const excecoes = excecoesDaOperacao({ comp, deps, opcoes, extras: estado.critico ? [{ nome: 'resolverEstadoCritico', motivo: estado.critico.motivo }] : [] });
  const meta = lerMeta(ctx, anteriorRotulo);
  const v = verificarInstalacao(ctx, anteriorRotulo, { persistentesReais: reaisPersistentes });
  if (!meta || !v.integro) throw erro('ANTERIOR_CORROMPIDA', `a release anterior não confere: ${v.problemas.slice(0, 3).join('; ')}`);
  const preCondicoes = () => avaliarPreCondicoes({ comp, acao: 'reverter', release: { migrations: meta.migrations, contratos: meta.contratos }, opcoes, deps, agora: agora() });
  const pre = await preCondicoes();
  avisos.push(...pre.avisos);

  const journal = criarDiario({ ctx, agora, avisos });
  journal.abrir({ operacao: 'reverter', de: atualRotulo, para: anteriorRotulo, ...(excecoes.length ? { excecoes: excecoes.map((x) => x.nome) } : {}) });
  const desfazer = () => desfazerTroca({ ctx, componente, restaurarAtual: atualRotulo, restaurarAnterior: anteriorRotulo, estadoAntes: antes });
  try {
    let procAntes = null;
    if (typeof deps.identificarProcesso === 'function') { try { procAntes = await deps.identificarProcesso(); } catch { procAntes = null; } }

    const metaAtual = lerMeta(ctx, atualRotulo);
    try {
      trocarAtual(ctx, anteriorRotulo);
      trocarAnterior(ctx, atualRotulo);
      journal.passo('TROCADA');
      escreverVersao(ctx, componente, meta);
      const pos = await reiniciarEComprovar({
        ctx, deps, alvoRotulo: anteriorRotulo, procAntes, tentativas: tentativasDe(opcoes), intervaloMs: intervaloDe(opcoes),
        antesDeReiniciar: comp.tipo === 'backend' ? preCondicoes : undefined, aoReiniciar: () => journal.passo('REINICIANDO'),
      });
      if (pos.motivo === 'COORDENACAO') {
        const desfeito = desfazer();
        fecharFalha(journal, desfeito, { motivo: pos.erro.codigo || 'COORDENACAO', desfeito });
        throw tratado(pos.erro);
      }

      const autorizacao = pos.autorizacao || pre;
      estado.atual = { rotulo: anteriorRotulo, commit: meta.commit, instaladoEm: meta.instaladoEm, comprovada: pos.ok };
      estado.anterior = { rotulo: atualRotulo, commit: metaAtual ? metaAtual.commit : null };
      const evento = eventoDeRastro('REVERSAO_MANUAL', anteriorRotulo, comExcecoes({ de: atualRotulo, reinicio: pos.motivo !== 'REINICIO', saude: pos.ok }, excecoes), { pre: autorizacao, opcoes, deps, agora });
      if (!pos.ok) { evento.motivoFalha = pos.motivo; evento.detalhe = pos.detalhe; } else estado.critico = null;
      estado.historico.push(evento);
      gravarEstado(ctx, estado);
      if (!pos.ok) {
        journal.encerrar('FALHOU', { motivo: pos.motivo });
        const codigo = { REINICIO: 'REINICIO_FALHOU_APOS_REVERSAO', VERSAO: 'VERSAO_NAO_COMPROVADA_APOS_REVERSAO', SAUDE: 'SAUDE_FALHOU_APOS_REVERSAO' }[pos.motivo];
        throw tratado(erro(codigo, `${motivoDe(RESUMO_DA_FALHA[pos.motivo], pos)} depois de reverter para ${anteriorRotulo}; nenhuma outra troca foi feita automaticamente`, { rotulo: anteriorRotulo, motivo: pos.motivo, tentativas: pos.tentativas }));
      }
      journal.encerrar('CONCLUIDA');
      return { resultado: 'REVERTIDA', componente, rotulo: anteriorRotulo, commit: meta.commit, anterior: atualRotulo, atestadoManual: autorizacao.atestadoManual, avisos };
    } catch (falha) {
      if (falha && falha.tratado) throw falha;
      if (journal.reiniciou) {
        // O reinício já aconteceu: voltar só o link deixaria o processo e o link em releases diferentes. Volta-se à
        // release de antes da operação com reinício e prova, ou o estado fica crítico.
        const pos = { ok: false, motivo: 'INTERNO', detalhe: falha.code || falha.message, tentativas: 0 };
        return await recuperarOuCritico({ ctx, comp, componente, rel: { rotulo: anteriorRotulo }, anteriorRotulo: atualRotulo, restaurarAnterior: anteriorRotulo, estado, antes, deps, agora, pre, opcoes, journal, reaisPersistentes, pos });
      }
      const desfeito = desfazer();
      fecharFalha(journal, desfeito, { motivo: 'POS_TROCA', desfeito });
      throw erro('FALHA_POS_TROCA', `falha inesperada depois da troca (${falha.codigo || falha.code || falha.message});${desfeito ? 'o link voltou para a release que estava em uso' : 'o link NÃO pôde ser restaurado, verifique manualmente (a próxima operação reconcilia pelo diário)'}`, { desfeito, causa: falha.codigo || falha.code || falha.name });
    }
  } catch (falha) {
    if (!journal.decidido) journal.encerrar('FALHOU', { motivo: falha.codigo || falha.code || 'ERRO' });
    throw falha;
  }
}

// Somente leitura: sem âncora por descritor (fora do Linux) a identificação ainda funciona, mas declara que não tem
// garantia contra substituição concorrente (garantiaContraCorrida: false). Nunca escreve nem remove nada.
async function identificar({ config: bruta, componente, deps = {} } = {}) {
  const cfg = validarConfig(bruta);
  const comp = cfg.componentes[componente];
  if (!comp) throw erro('COMPONENTE_DESCONHECIDO', `componente desconhecido: ${componente}`);
  const naoInstalado = (problemas = [], consistente = true) => ({ instalado: false, componente, rotulo: null, integro: false, consistente, problemas });
  let A;
  try {
    A = criarAncoraDaOperacao(deps);
  } catch (falha) {
    if (falha.codigo !== 'PLATAFORMA_SEM_ANCORA') throw falha;
    A = criarAncora({ modo: 'leitura' }); // só leitura: qualquer escrita, troca ou remoção é recusada pela própria âncora
  }
  try {
    let ctx;
    try {
      ctx = abrirContextoSeExistir(A, comp);
    } catch (falha) {
      if (falha.code === 'ENOENT') return naoInstalado();
      return naoInstalado([falha.message], false);
    }
    if (!ctx) return naoInstalado();
    let rotulo;
    try {
      rotulo = lerLinkAtual(ctx);
    } catch (falha) {
      return naoInstalado([falha.message], false);
    }
    if (!rotulo) return naoInstalado();
    let meta = null;
    const leituras = [];
    try { meta = lerMeta(ctx, rotulo); } catch (falha) { leituras.push(falha.message); }
    const v = verificarInstalacao(ctx, rotulo, { persistentesReais: cfg.raizesPersistentes.map(caminhoReal) });
    const inconsistencias = verificarConsistencia(ctx, comp, componente, rotulo);
    const pendencias = verificarPendencias(ctx, rotulo);
    // Diário ilegível nunca vira "sem linhas ilegíveis": a contagem fica indeterminada e a integridade, reprovada.
    let linhasIlegiveis = null;
    try { linhasIlegiveis = lerDiarioDetalhado(ctx).ilegiveis; } catch (falha) { leituras.push(`diário ilegível: ${falha.message}`); }
    const todas = [...v.problemas, ...inconsistencias, ...pendencias, ...leituras.filter((m) => ![...v.problemas, ...inconsistencias].includes(m))];
    let anterior = null;
    try { anterior = lerLinkAnterior(ctx); } catch (falha) { todas.push(`link anterior ilegível: ${falha.message}`); }
    return {
      instalado: true, componente, rotulo, commit: meta ? meta.commit : null, atual: meta ? meta.atual : null,
      instaladoEm: meta ? meta.instaladoEm : null, anterior,
      integro: v.integro && inconsistencias.length === 0 && pendencias.length === 0 && leituras.length === 0 && todas.length === 0,
      consistente: inconsistencias.length === 0 && leituras.length === 0, problemas: todas,
      diarioLinhasIlegiveis: linhasIlegiveis, garantiaContraCorrida: A.garantiaContraCorrida,
    };
  } finally { A.fecharTudo(); }
}

// ------------------------------------------------------------ linha de comando

function executarComando(comando, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(comando, args, { cwd, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, shell: false }, (falha, stdout, stderr) => {
      if (falha) reject(new Error(`${path.basename(comando)} saiu com erro: ${String(stderr || falha.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

function depsDoConfig(comp) {
  const deps = { executar: executarComando };
  if (comp.reinicio) deps.reiniciar = () => executarComando(comp.reinicio.comando[0], comp.reinicio.comando.slice(1));
  if (comp.saude) {
    const { url, timeoutMs = 3000, servicoEsperado = 'gestao-epi-api' } = comp.saude;
    deps.verificarSaude = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        const corpo = await r.json().catch(() => null);
        const ok = r.status === 200 && Boolean(corpo) && corpo.status === 'ok' && corpo.service === servicoEsperado;
        return { ok, detalhe: ok ? `HTTP ${r.status}` : `HTTP ${r.status}, corpo diferente do esperado` };
      } catch (falha) {
        return { ok: false, detalhe: falha.name };
      }
    };
  }
  if (comp.processo) {
    deps.identificarProcesso = async () => {
      const saida = await executarComando(comp.processo.pidComando[0], comp.processo.pidComando.slice(1));
      const pid = Number(String(saida).trim());
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('PID do serviço inválido');
      return { pid, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) };
    };
  }
  return deps;
}

const BOOLEANOS = {
  '--permitir-anterior': 'permitirAnterior', '--permitir-retroativo': 'permitirRetroativo',
  '--sem-autenticacao-de-origem': 'semAutenticacao', '--sem-comprovacao-de-versao': 'semComprovacaoDeVersao',
  '--permitir-atual-divergente': 'permitirAtualDivergente', '--permitir-execucao-como-root': 'permitirRoot',
  '--resolver-estado-critico': 'resolverEstadoCritico', '--exigir-durabilidade': 'exigirDurabilidade',
};

// Consulta de coordenação por arquivo: relido (com as mesmas verificações de segurança) a cada consulta. A evidência do
// conteúdo efetivamente lido (hash e número da leitura) acompanha o objeto devolvido por AQUELA consulta e é gravada no
// rastro junto com o estado que decidiu. Nada fica guardado na função: duas operações que a compartilham não trocam
// evidências. O número da leitura é só um contador monotônico.
function criarConsultaPorArquivo(arquivo) {
  let leituras = 0;
  return async () => {
    const f = lerArquivoJsonSeguro(arquivo);
    leituras += 1;
    return anexarEvidencia(f.dados, { sha256: f.sha256, leitura: leituras });
  };
}

const COM_VALOR = new Set(['--config', '--componente', '--release', '--release-sha256', '--observado', '--coordenacao']);

function lerArgumentos(argv) {
  const [comando, ...resto] = argv;
  if (!['instalar', 'reverter', 'identificar', 'reconciliar'].includes(comando)) throw erro('USO', 'uso: instalar-release.js <instalar|reverter|identificar|reconciliar> --config <json> --componente <nome> [--release <dir> --release-sha256 <hash>]');
  const valores = {};
  for (let i = 0; i < resto.length; i += 1) {
    if (resto[i] === '--atesto-sem-operacao-de-backup') throw erro('ATESTADO_NAO_LIBERA_BACKEND', 'o atestado manual foi removido: ele não impede que um backup comece durante a operação. O backend só é trocado com coordenação homologada com o D-ORF-6, que ainda não existe');
    if (BOOLEANOS[resto[i]]) valores[BOOLEANOS[resto[i]]] = true;
    else if (COM_VALOR.has(resto[i]) && resto[i + 1] !== undefined) { valores[resto[i].slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = resto[i + 1]; i += 1; } else throw erro('USO', `argumento inválido: ${resto[i]}`);
  }
  if (!valores.config || !valores.componente) throw erro('USO', '--config e --componente são obrigatórios');
  if (comando === 'instalar' && !valores.release) throw erro('USO', '--release é obrigatório para instalar');
  return { comando, valores };
}

async function principal(argv) {
  const { comando, valores } = lerArgumentos(argv);
  verificarContextoDeExecucao({ permitirRoot: valores.permitirRoot === true });
  const bruta = lerArquivoJsonSeguro(valores.config).dados;
  const cfg = validarConfig(bruta);
  const comp = cfg.componentes[valores.componente];
  if (!comp) throw erro('COMPONENTE_DESCONHECIDO', `componente desconhecido: ${valores.componente}`);
  // Política única de operações por componente (nucleo.js), aplicada antes de qualquer outra coisa nesta interface.
  verificarOperacaoNaInterface(comp.tipo, comando, 'cli');
  const opcoes = {};
  for (const chave of ['permitirAnterior', 'permitirRetroativo', 'semAutenticacao', 'semComprovacaoDeVersao', 'permitirAtualDivergente', 'resolverEstadoCritico', 'exigirDurabilidade']) if (valores[chave]) opcoes[chave] = true;
  if (valores.permitirRoot === true && typeof process.getuid === 'function' && process.getuid() === 0) opcoes.permitirRootEfetivo = true;
  if (valores.releaseSha256 !== undefined) opcoes.releaseSha256Esperado = valores.releaseSha256;
  const deps = depsDoConfig(comp);
  const fontes = {};
  if (valores.observado) {
    const f = lerArquivoJsonSeguro(valores.observado);
    opcoes.observado = f.dados;
    fontes.observado = { arquivo: path.resolve(valores.observado), sha256: f.sha256 };
  }
  if (valores.coordenacao) {
    fontes.coordenacao = { arquivo: path.resolve(valores.coordenacao) };
    deps.consultarCoordenacao = criarConsultaPorArquivo(valores.coordenacao);
  }
  if (Object.keys(fontes).length > 0) opcoes.fontes = fontes;
  if (comp.saude && comp.saude.tentativas) opcoes.tentativasSaude = comp.saude.tentativas;
  if (comp.saude && comp.saude.intervaloMs !== undefined) opcoes.intervaloSaudeMs = comp.saude.intervaloMs;
  if (comando === 'identificar') return identificar({ config: bruta, componente: valores.componente });
  if (comando === 'reconciliar') return reconciliar({ config: bruta, componente: valores.componente, deps });
  if (comando === 'reverter') return reverter({ config: bruta, componente: valores.componente, opcoes, deps });
  return instalar({ config: bruta, componente: valores.componente, release: valores.release, opcoes, deps });
}

if (require.main === module) {
  principal(process.argv.slice(2)).then((resultado) => {
    process.stdout.write(`${JSON.stringify(resultado)}\n`);
  }, (falha) => {
    console.error(`Operação recusada (${falha.codigo || 'ERRO'}): ${falha.message}`);
    if (falha.detalhes && falha.detalhes.bloqueios) for (const b of falha.detalhes.bloqueios) console.error(`  - ${b.codigo}: ${b.mensagem}`);
    process.exitCode = 1;
  });
}

module.exports = {
  instalar, reverter, identificar, reconciliar, validarConfig, verificarInstalacao, lerConfigSegura, verificarContextoDeExecucao,
  depsDoConfig, criarConsultaPorArquivo, ErroInstalador, ROTULO,
};
