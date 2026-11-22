'use strict';
// Agente do escopo backend (Etapa 2B): módulo separado do agente do frontend, inerte e sem ativação.
// Lê pedidos só do prefixo hml-backend/ e entrega o pedido ao instalador, que recusa o backend enquanto não houver
// coordenação homologada com o D-ORF-6. Este módulo não oferece contorno: não declara coordenação nem homologa
// provedor, não pula a prova de versão e não executa banco, migrations, backup nem recuperação. Qualquer falha depois de
// iniciada a instalação vira estado CRITICO com a trava preservada, para diagnóstico humano.
// Etapa 3B-2B-1: antes de instalar, o agente adquire a exclusão do D-ORF-6 pelo guardião da baseline e entrega ao
// instalador o consultar desse provedor, que o instalador continua recusando enquanto ele não for homologado.
// Etapa 3B-2B-3A: a garantia tem de valer do começo ao fim. Cada ação entregue ao instalador (dependências, reinício,
// identificação do processo, saúde) só começa com a garantia local do provedor, uma confirmação nova e tempo restante
// para terminar; as ações com processo têm prazo efetivo (executor-com-prazo). Depois da última ação vem a confirmação
// final; só então o guardião é liberado. SUCESSO exige ainda a soltura conferida dos quatro cadeados.
const fs = require('node:fs');
const path = require('node:path');
const N = require('../instalador/nucleo');
const I = require('../instalador/instalar-release');
const { criarAncora } = require('../instalador/ancora');
const { criarS3 } = require('./s3');
const P = require('./protocolo');
const { criarCoordenacaoPorGuardiao } = require('./coordenacao-por-guardiao');
const { executarComPrazo } = require('./executor-com-prazo');

const ESCOPO = 'backend';
const PREFIXO = 'hml-backend';
const ISOLAMENTO = 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND';
const TRAVA = '.trava-cd-backend';
const chave = (tipo, id) => `${PREFIXO}/${tipo}/${id}.json`;
const igual = (a, b) => a.rotulo === b.rotulo && a.commit === b.commit;

// Recusas do instalador comprovadamente anteriores a qualquer mudança no servidor: cada código tem um único ponto de
// lançamento, nas guardas iniciais de instalar(), antes de abrir contexto, trava ou diário. OPERACAO_EM_CURSO e
// COORDENACAO_NAO_CONFIRMADA ficam de fora de propósito: o instalador também as lança depois de preparar a release e
// depois de trocar o link, então elas não provam ausência de mutação.
const RECUSAS_SEM_MUTACAO = new Set(['COORDENACAO_NAO_HOMOLOGADA', 'SAUDE_NAO_CONFIGURADA', 'REINICIO_NAO_CONFIGURADO', 'VERSAO_NAO_COMPROVAVEL']);
const MOTIVOS_DE_RECUSA = new Set([...RECUSAS_SEM_MUTACAO, 'PEDIDO_EXPIRADO', 'PEDIDO_INVALIDO', 'PEDIDO_AUSENTE', 'ID_DIVERGENTE', 'BLOB_DIVERGENTE', 'ESCOPO_DIVERGENTE', 'RETROATIVO_BLOQUEADO', 'S3_OPERACAO_FALHOU', 'BASELINE_NAO_COMPROVADA', 'BASELINE_MUDOU', 'ESTADO_OBSERVADO_INDISPONIVEL', 'ESTADO_OBSERVADO_DIVERGENTE', 'GUARDIAO_NAO_VINCULADO', 'COORDENACAO_OCUPADA', 'COORDENACAO_NAO_ADQUIRIDA', 'PRAZO_DA_COORDENACAO_INSUFICIENTE']);
// Recusas do guardião que significam outra operação do D-ORF-6 em curso; qualquer outra recusa é aquisição sem garantia.
const OCUPACOES_DO_GUARDIAO = new Set(['EM_USO', 'MIGRACAO_EM_CURSO']);
// Falhas que o próprio instalador declara críticas depois de alterar a release.
const CODIGOS_CRITICOS = new Set(['FALHA_POS_TROCA', 'FALHA_POS_REINICIO', 'ESTADO_CRITICO']);
// Resultados do instalador que contam como instalação concluída, e avisos que tiram a afirmação de sucesso.
const RESULTADOS_ACEITOS = new Set(['INSTALADA', 'JA_INSTALADA', 'CONFIRMADA']);
const AVISOS_QUE_IMPEDEM_SUCESSO = new Set(['ESTADO_NAO_ATUALIZADO', 'DURABILIDADE_NAO_GARANTIDA']);
const codigoSeguro = (e) => (e && typeof e.codigo === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.codigo) ? e.codigo : 'ERRO');

// Prazos da operação (3B-2B-3A). O guardião vive no máximo o que informar na aquisição; a instalação inteira, da
// aquisição à confirmação final, cabe em 30 min, com 5 min de margem para confirmar, liberar e encerrar e 10 min de
// reserva. Cada ação só começa se o prazo dela couber no que resta; as ações com processo são encerradas no prazo.
const MINUTO_MS = 60 * 1000;
const PRAZOS_DA_OPERACAO = Object.freeze({
  instalacaoMs: 30 * MINUTO_MS, margemDeEncerramentoMs: 5 * MINUTO_MS, reservaMs: 10 * MINUTO_MS, vidaMinimaDoGuardiaoMs: 45 * MINUTO_MS,
  acoes: Object.freeze({ executar: 15 * MINUTO_MS, reiniciar: 2 * MINUTO_MS, identificarProcesso: 30 * 1000, verificarSaude: 30 * 1000 }),
});
const PERDA_DA_COORDENACAO = 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO';
// Desfechos de uma ação que impedem qualquer ação seguinte: o processo pode ter ficado vivo ou passou do prazo.
const ACOES_SEM_FIM_SEGURO = new Set(['PRAZO_DA_ACAO_EXCEDIDO', 'ENCERRAMENTO_DA_ACAO_INCERTO', 'ACAO_DEIXOU_DESCENDENTES']);
const relogioMonotonico = () => Number(process.hrtime.bigint() / 1000000n);
// Depois de iniciada a instalação nada é "recusa": ou o estado é incerto, ou o instalador declarou falha crítica.
function motivoCritico(e) {
  const codigo = codigoSeguro(e);
  if (codigo === 'RESULTADO_NAO_RECONHECIDO' || codigo === 'SUCESSO_SEM_REGISTRO_DURAVEL') return codigo;
  const critico = e.detalhes !== null && typeof e.detalhes === 'object' && e.detalhes.critico === true;
  return CODIGOS_CRITICOS.has(codigo) || critico ? 'FALHA_CRITICA_APOS_ALTERACAO' : 'RESULTADO_INCERTO';
}

function saudavel(s) {
  P.exigir(s && s.instalado === true && s.integro === true && s.consistente === true && s.garantiaContraCorrida === true && N.SHA_COMPLETO.test(s.commit) && N.ROTULO.test(s.rotulo), 'BASELINE_NAO_COMPROVADA');
  return s;
}

const PRAZO_DA_SONDA_MS = 20000;
const NOME_DE_MIGRATION = /^[A-Za-z0-9_.-]+$/;
const textoPreenchido = (v) => typeof v === 'string' && v.trim() !== '';
const IDENTIFICADOR_DO_CLUSTER = /^[1-9]\d{0,19}$/;
// `credencial` é o CAMINHO do arquivo que só a sonda lê; `sistema` é o identificador único do cluster esperado.
const sondaValida = (s) => s !== null && typeof s === 'object' && Array.isArray(s.comando) && s.comando.length >= 2
  && s.comando.every(textoPreenchido) && path.isAbsolute(s.comando[0]) && textoPreenchido(s.banco)
  && textoPreenchido(s.credencial) && path.isAbsolute(s.credencial) && typeof s.sistema === 'string' && IDENTIFICADOR_DO_CLUSTER.test(s.sistema)
  && (s.timeoutMs === undefined || (Number.isInteger(s.timeoutMs) && s.timeoutMs >= 100 && s.timeoutMs <= 120000));

const indisponivel = () => Object.assign(new Error('ESTADO_OBSERVADO_INDISPONIVEL'), { codigo: 'ESTADO_OBSERVADO_INDISPONIVEL' });
const dentroDe = (caminho, dir) => caminho.startsWith(dir + path.sep);
const SO_OPCAO = /^--?[A-Za-z][A-Za-z0-9=_.-]*$/;

// Prende a sonda à baseline FÍSICA conferida no início da operação: o diretório da release identificada, alcançado
// por .releases/<nome>/<rótulo> e nunca pelo link corrente, e o roteiro já resolvido dentro dele. O instalador troca
// o link no meio da operação; com este vínculo a sonda que decide a compatibilidade nunca é a da candidata. Recusa
// roteiro fora da baseline (inclusive pelo link corrente, por .. ou por link interno), executável vindo da árvore de
// releases e argumento que não seja opção simples. Vale para uma operação: não há cache nem substituta.
function vincularRoteiro(cfg, comando, baseline) {
  P.exigir(baseline !== null && typeof baseline === 'object' && N.ROTULO.test(baseline.rotulo || ''), 'VINCULO');
  const comp = N.validarConfig(cfg.instalador).componentes[ESCOPO];
  const raiz = fs.realpathSync(comp.base);
  const dir = path.join(raiz, '.releases', comp.nome, baseline.rotulo);
  P.exigir(fs.realpathSync(dir) === dir && fs.statSync(dir).isDirectory(), 'VINCULO');
  const [executavel, roteiro, ...opcoes] = comando;
  P.exigir(!dentroDe(path.resolve(executavel), raiz) && !dentroDe(fs.realpathSync(executavel), raiz), 'VINCULO');
  const pretendido = path.resolve(dir, roteiro);
  P.exigir(dentroDe(pretendido, dir), 'VINCULO');
  const real = fs.realpathSync(pretendido);
  P.exigir(dentroDe(real, dir) && fs.statSync(real).isFile() && opcoes.every((o) => SO_OPCAO.test(o)), 'VINCULO');
  return Object.freeze({ dir, comando: Object.freeze([executavel, real, ...opcoes]) });
}

function vincularSonda(cfg, baseline) {
  try {
    P.exigir(sondaValida(cfg.sonda), 'ESTADO_OBSERVADO_INDISPONIVEL');
    return vincularRoteiro(cfg, cfg.sonda.comando, baseline);
  } catch {
    throw indisponivel();
  }
}

// O guardião é código da baseline, como a sonda, e fica preso a ela pelas mesmas regras: o processo segue vivo durante
// toda a instalação, inclusive depois da troca do link, e nunca é o da candidata.
// `credencial` é o CAMINHO do arquivo que só o guardião lê, distinto do da sonda; o cluster esperado é o da sonda.
const guardiaoValido = (g, sonda) => g !== null && typeof g === 'object' && Array.isArray(g.comando) && g.comando.length === 2
  && g.comando.every(textoPreenchido) && path.isAbsolute(g.comando[0]) && textoPreenchido(g.credencial) && path.isAbsolute(g.credencial)
  && !(sonda && sonda.credencial === g.credencial);

// Hash esperado do roteiro do guardião: o do manifesto que o instalador gravou para a release da baseline (meta/<rótulo>)
// e contra o qual identificar() conferiu a integridade. O arquivo tem de ter esse hash agora; o provedor confere de
// novo imediatamente antes de iniciar o processo.
function hashDoRoteiroNaBaseline(vinculo, baseline) {
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(vinculo.dir), 'meta', `${baseline.rotulo}.json`), 'utf8'));
  P.exigir(meta !== null && typeof meta === 'object' && meta.rotulo === baseline.rotulo && meta.manifesto !== null && typeof meta.manifesto === 'object', 'VINCULO');
  P.exigir(baseline.commit === undefined || meta.commit === baseline.commit, 'VINCULO');
  const esperado = meta.manifesto[path.relative(vinculo.dir, vinculo.comando[1]).split(path.sep).join('/')];
  P.exigir(typeof esperado === 'string' && /^[0-9a-f]{64}$/.test(esperado) && N.sha256(fs.readFileSync(vinculo.comando[1])) === esperado, 'VINCULO');
  return esperado;
}

function vincularGuardiao(cfg, baseline) {
  try {
    P.exigir(guardiaoValido(cfg.guardiao, cfg.sonda) && sondaValida(cfg.sonda), 'GUARDIAO_NAO_VINCULADO');
    const vinculo = vincularRoteiro(cfg, cfg.guardiao.comando, baseline);
    return Object.freeze({ ...vinculo, sha256DoRoteiro: hashDoRoteiroNaBaseline(vinculo, baseline) });
  } catch {
    throw Object.assign(new Error('GUARDIAO_NAO_VINCULADO'), { codigo: 'GUARDIAO_NAO_VINCULADO' });
  }
}

const recusaDeCoordenacao = (codigo) => Object.assign(new Error(codigo), { codigo });
// Só { ok: true } vale como aquisição. Recusa por operação em curso é OCUPADA; o resto, inclusive exceção, é sem garantia.
// Um guardião que vive menos que a instalação, a margem e a reserva somadas não serve: nada começa.
async function adquirirGuardiao(coordenacao) {
  let aquisicao;
  try { aquisicao = await coordenacao.adquirir(); } catch { throw recusaDeCoordenacao('COORDENACAO_NAO_ADQUIRIDA'); }
  if (aquisicao !== null && typeof aquisicao === 'object' && aquisicao.ok === true) {
    P.exigir(Number.isInteger(aquisicao.vidaMaximaMs) && aquisicao.vidaMaximaMs >= PRAZOS_DA_OPERACAO.vidaMinimaDoGuardiaoMs, 'PRAZO_DA_COORDENACAO_INSUFICIENTE');
    return;
  }
  const ocupada = aquisicao !== null && typeof aquisicao === 'object' && OCUPACOES_DO_GUARDIAO.has(aquisicao.motivo);
  throw recusaDeCoordenacao(ocupada ? 'COORDENACAO_OCUPADA' : 'COORDENACAO_NAO_ADQUIRIDA');
}

// Operação protegida pela garantia do guardião. Cada ação só começa se a operação não foi encerrada, não houve perda,
// o prazo dela cabe no que resta, a garantia local do provedor está de pé e uma confirmação NOVA foi aprovada. Uma
// ação já iniciada não é interrompida; a perda é vista na próxima conferência, e a partir dela nada mais começa.
function criarOperacaoProtegida({ coordenacao, relogio }) {
  const inicio = relogio();
  const limite = inicio + PRAZOS_DA_OPERACAO.instalacaoMs;
  const decorrido = () => relogio() - inicio;
  let encerrada = false;
  let perda = null;
  let ultimaAcao = null;
  let confirmacoes = 0;
  let confirmacaoFinalEm = null;
  let janelaFinalMs = null;
  const interromper = (codigo, causa) => {
    if (!perda) perda = { codigo, causa, acao: ultimaAcao ? ultimaAcao.nome : null, decorridoMs: decorrido() };
    return recusaDeCoordenacao(perda.codigo);
  };
  const vigente = () => { try { return coordenacao.garantiaVigente() === true; } catch { return false; } };
  async function conferir(duracaoMs) {
    if (encerrada) throw recusaDeCoordenacao('OPERACAO_ENCERRADA');
    if (perda) throw recusaDeCoordenacao(perda.codigo);
    if (relogio() + duracaoMs > limite) throw interromper('PRAZO_DA_INSTALACAO_EXCEDIDO', 'PRAZO');
    if (!vigente()) throw interromper(PERDA_DA_COORDENACAO, 'GARANTIA_LOCAL');
    let confirmada = false;
    try { confirmada = (await coordenacao.confirmar()) === true; } catch { confirmada = false; }
    if (!confirmada || !vigente()) throw interromper(PERDA_DA_COORDENACAO, 'SEM_CONFIRMACAO');
    if (relogio() > limite) throw interromper('PRAZO_DA_INSTALACAO_EXCEDIDO', 'PRAZO');
    confirmacoes += 1;
  }
  const proteger = (nome, duracaoMs, acao) => async (...args) => {
    await conferir(duracaoMs);
    const registro = { nome, iniciadaEmMs: decorrido(), terminou: false, desfecho: null };
    ultimaAcao = registro;
    try {
      const valor = await acao(...args);
      registro.desfecho = 'CONCLUIDA';
      return valor;
    } catch (falha) {
      registro.desfecho = codigoSeguro(falha);
      if (ACOES_SEM_FIM_SEGURO.has(registro.desfecho)) interromper(registro.desfecho, 'ACAO');
      throw falha;
    } finally {
      registro.terminou = registro.desfecho !== 'ENCERRAMENTO_DA_ACAO_INCERTO';
      registro.duracaoMs = decorrido() - registro.iniciadaEmMs;
    }
  };
  return {
    proteger,
    async confirmarFinal() { await conferir(0); confirmacaoFinalEm = relogio(); encerrada = true; },
    encerrar() { encerrada = true; },
    pedirLiberacao() { encerrada = true; if (confirmacaoFinalEm !== null) janelaFinalMs = relogio() - confirmacaoFinalEm; },
    perda: () => perda,
    descrever: () => ({
      prazoMs: PRAZOS_DA_OPERACAO.instalacaoMs, decorridoMs: decorrido(), confirmacoes, confirmacaoFinal: confirmacaoFinalEm !== null, janelaFinalMs, perda,
      ultimaAcao: ultimaAcao ? { ...ultimaAcao } : null,
      guardiao: typeof coordenacao.descrever === 'function' ? coordenacao.descrever() : null,
    }),
  };
}

// Situações em que o provedor só responde depois de ver o processo do guardião terminar (evento close) ou de saber que
// ele nunca existiu. Só elas, com processoEncerrado === true, comprovam o encerramento. Nada aqui comprova o banco.
// A continuidade até a liberação é outra coisa: só a soltura dos quatro cadeados conferida pelo guardião na mesma sessão
// (LIBERACAO_INFORMADA com cadeadosLiberados.confirmada) a demonstra. Sessão encerrada é só declaração.
const ENCERRAMENTO_COMPROVADO = new Set(['LIBERACAO_INFORMADA', 'PROCESSO_ENCERRADO', 'SEM_PROCESSO']);
const liberacaoIncerta = (situacao, forcada = false) => ({
  situacao, processoEncerrado: false, forcada, encerramentoComprovado: false, comprovadaNoBanco: false, cadeadosLiberadosConfirmados: false, sessaoEncerradaDeclarada: false, continuidadeDemonstrada: false,
});

async function liberarGuardiao(coordenacao) {
  let r;
  try { r = await coordenacao.liberar(); } catch { return liberacaoIncerta('FALHA_NA_LIBERACAO'); }
  if (r === null || typeof r !== 'object' || typeof r.situacao !== 'string' || typeof r.processoEncerrado !== 'boolean') return liberacaoIncerta('RESPOSTA_INVALIDA');
  const forcada = r.forcada === true;
  if (r.situacao === 'INDETERMINADA' && r.processoEncerrado === false) return liberacaoIncerta('INDETERMINADA', forcada);
  if (!ENCERRAMENTO_COMPROVADO.has(r.situacao) || r.processoEncerrado !== true) return liberacaoIncerta('RESPOSTA_INVALIDA', forcada);
  const cadeadosLiberadosConfirmados = r.situacao === 'LIBERACAO_INFORMADA' && r.cadeadosLiberados !== null && typeof r.cadeadosLiberados === 'object' && r.cadeadosLiberados.confirmada === true;
  return {
    situacao: r.situacao, processoEncerrado: true, forcada, encerramentoComprovado: true, comprovadaNoBanco: false,
    cadeadosLiberadosConfirmados, sessaoEncerradaDeclarada: r.sessaoEncerradaDeclarada === true, continuidadeDemonstrada: cadeadosLiberadosConfirmados,
  };
}

// Estado das migrations aplicadas, lido do PostgreSQL pela sonda vinculada à baseline (comando da configuração local,
// nunca do pedido). Cada chamada é uma consulta nova ao banco; o que não muda é o código executado. Da saída só se
// aproveitam o banco, o cluster e os nomes; origem e horário são carimbados aqui. Qualquer falha é recusa: uma leitura
// que não deu certo nunca vira "banco sem migrations".
async function coletarObservado(cfg, executar, vinculo) {
  let dados;
  let relogio;
  try {
    P.exigir(sondaValida(cfg.sonda) && typeof executar === 'function', 'ESTADO_OBSERVADO_INDISPONIVEL');
    P.exigir(vinculo !== null && typeof vinculo === 'object' && textoPreenchido(vinculo.dir) && Array.isArray(vinculo.comando) && vinculo.comando.length >= 2, 'ESTADO_OBSERVADO_INDISPONIVEL');
    const prazoMs = cfg.sonda.timeoutMs || PRAZO_DA_SONDA_MS;
    const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(rejeitar, prazoMs); });
    const saida = await Promise.race([executar(vinculo.comando[0], [...vinculo.comando.slice(1), '--credencial', cfg.sonda.credencial], { cwd: vinculo.dir, prazoMs }), prazo]);
    dados = JSON.parse(String(saida));
  } catch {
    throw indisponivel();
  } finally {
    clearTimeout(relogio);
  }
  const nomes = dados !== null && typeof dados === 'object' ? dados.migrations : null;
  if (!textoPreenchido(dados && dados.banco) || typeof dados.sistema !== 'string' || !IDENTIFICADOR_DO_CLUSTER.test(dados.sistema) || !Array.isArray(nomes) || nomes.length === 0
    || !nomes.every((n) => typeof n === 'string' && NOME_DE_MIGRATION.test(n)) || new Set(nomes).size !== nomes.length) throw indisponivel();
  // Mesmo nome de banco em outro cluster não serve: o identificador do cluster precisa ser o da configuração local.
  P.exigir(dados.banco === cfg.sonda.banco && dados.sistema === cfg.sonda.sistema, 'ESTADO_OBSERVADO_DIVERGENTE');
  return { banco: dados.banco, origem: 'sonda-postgresql', coletadoEm: new Date().toISOString(), migrations: nomes.slice(), contratos: {} };
}

function validarConfiguracao(cfg) {
  P.exigir(cfg && cfg.habilitado === true && cfg.isolamentoRevisado === ISOLAMENTO, 'AGENTE_DESABILITADO');
  const instalador = N.validarConfig(cfg.instalador);
  const comp = instalador.componentes[ESCOPO];
  P.exigir(Object.keys(instalador.componentes).join(',') === ESCOPO && comp.tipo === 'backend', 'ESCOPO_INVALIDO');
  P.exigir(comp.saude && comp.reinicio && comp.processo, 'VERSAO_NAO_COMPROVAVEL');
  P.exigir(cfg.s3 && cfg.s3.prefixo === PREFIXO, 'S3_PREFIXO_INVALIDO');
  P.exigir(sondaValida(cfg.sonda), 'SONDA_NAO_CONFIGURADA');
  P.exigir(guardiaoValido(cfg.guardiao, cfg.sonda), 'GUARDIAO_NAO_CONFIGURADO');
  P.exigir(Array.isArray(cfg.raizesProtegidas) && cfg.raizesProtegidas.length > 0 && cfg.raizesProtegidas.every((p) => path.isAbsolute(p)), 'RAIZES_PROTEGIDAS_OBRIGATORIAS');
  const protegidas = cfg.raizesProtegidas.map((p) => fs.realpathSync(p));
  const estado = fs.realpathSync(cfg.estadoDir);
  const base = fs.realpathSync(comp.base);
  P.exigir(!protegidas.some((p) => N.sobrepoe(p, base)) && !N.sobrepoe(estado, base) && !protegidas.some((p) => N.sobrepoe(p, estado)), 'RAIZ_PROTEGIDA');
  return cfg;
}

// Só devolve SUCESSO quando o instalador concluiu e a identidade instalada é a da release aprovada. Qualquer outra coisa lança.
async function aplicar({ pedido, releaseDir, deps, agora = Date.now }) {
  P.exigir(deps && typeof deps.identificar === 'function' && typeof deps.instalar === 'function' && typeof deps.registrar === 'function', 'DEPENDENCIAS_INCOMPLETAS');
  P.validarPedido(pedido, agora(), { escopo: ESCOPO });
  const conferir = deps.conferirRelease || P.conferirRelease;
  const rel = conferir({ dir: releaseDir, commit: pedido.commit, rotulo: pedido.rotulo, releaseSha256: pedido.releaseSha256, escopo: ESCOPO });
  const antes = saudavel(await deps.identificar());
  await deps.registrar({ fase: 'PREPARADO', antes });
  P.validarPedido(pedido, agora(), { escopo: ESCOPO });
  P.exigir(igual(saudavel(await deps.identificar()), antes), 'BASELINE_MUDOU');
  const retorno = await deps.instalar({ releaseSha256Esperado: pedido.releaseSha256, exigirDurabilidade: true, permitirAnterior: false, permitirRetroativo: false }, releaseDir);
  P.exigir(retorno !== null && typeof retorno === 'object' && RESULTADOS_ACEITOS.has(retorno.resultado), 'RESULTADO_NAO_RECONHECIDO');
  const avisos = Array.isArray(retorno.avisos) ? retorno.avisos : [];
  P.exigir(!avisos.some((a) => a !== null && typeof a === 'object' && AVISOS_QUE_IMPEDEM_SUCESSO.has(a.codigo)), 'SUCESSO_SEM_REGISTRO_DURAVEL');
  P.exigir(igual(saudavel(await deps.identificar()), rel.release), 'POS_DEPLOY_VERSAO');
  return { estado: 'SUCESSO', verificado: true };
}

// As mesmas ações que depsDoConfig monta da configuração (npm ci, reinício, PID do serviço), com prazo efetivo: o
// executor encerra o grupo de processos inteiro no prazo e confere o fim. A saúde continua a do instalador (HTTP com
// prazo próprio, sem processo).
function acoesComPrazo(comp) {
  const { acoes } = PRAZOS_DA_OPERACAO;
  const r = { executar: (comando, args, opcoes = {}) => executarComPrazo(comando, args, { cwd: opcoes.cwd, prazoMs: Math.min(opcoes.prazoMs || acoes.executar, acoes.executar) }) };
  if (comp.reinicio) r.reiniciar = () => executarComPrazo(comp.reinicio.comando[0], comp.reinicio.comando.slice(1), { prazoMs: acoes.reiniciar });
  if (comp.processo) {
    r.identificarProcesso = async () => {
      const saida = await executarComPrazo(comp.processo.pidComando[0], comp.processo.pidComando.slice(1), { prazoMs: acoes.identificarProcesso });
      const pid = Number(String(saida).trim());
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('PID do serviço inválido');
      return { pid, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) };
    };
  }
  return r;
}

// O instalador recebe o que o próprio contrato dele monta a partir da configuração validada (depsDoConfig), com as ações
// de processo trocadas pelas de prazo efetivo e, durante uma operação, protegidas pela garantia do guardião. `extras` só
// existe para testes injetarem dependências controladas, e a linha de comando nunca o preenche.
function dependenciasPadrao(cfg, extras) {
  const config = cfg.instalador;
  // A pré-checagem e o lerObservado do instalador recebem o MESMO vínculo, criado uma vez por operação.
  const depsDoInstalador = (vinculo, coordenacao, operacao) => {
    const comp = N.validarConfig(config).componentes[ESCOPO];
    const deps = { ...I.depsDoConfig(comp), ...acoesComPrazo(comp), ...extras };
    // O instalador chama lerObservado em cada pré-condição: cada chamada é uma coleta nova pela sonda vinculada. A
    // leitura da sonda não muda nada no servidor e não passa pela proteção das ações.
    const executarDaSonda = deps.executar;
    if (typeof deps.lerObservado !== 'function') deps.lerObservado = () => coletarObservado(cfg, executarDaSonda, vinculo);
    // A coordenação vem só do provedor adquirido nesta operação; nada dos extras a substitui.
    deps.consultarCoordenacao = coordenacao ? coordenacao.consultar : undefined;
    if (operacao) {
      for (const [nome, prazoMs] of Object.entries(PRAZOS_DA_OPERACAO.acoes)) {
        if (typeof deps[nome] === 'function') deps[nome] = operacao.proteger(nome, prazoMs, deps[nome]);
      }
    }
    return deps;
  };
  return {
    criarAncora: () => criarAncora({ exigirDurabilidade: true }),
    vincular: (baseline) => vincularSonda(cfg, baseline),
    vincularGuardiao: (baseline) => vincularGuardiao(cfg, baseline),
    criarCoordenacao: (vinculo, baseline) => criarCoordenacaoPorGuardiao({
      comando: [...vinculo.comando], dir: vinculo.dir, credencial: cfg.guardiao.credencial, sistema: cfg.sonda.sistema,
      baseline: { rotulo: baseline.rotulo, commit: baseline.commit }, sha256DoRoteiro: vinculo.sha256DoRoteiro,
    }),
    observar: (vinculo) => depsDoInstalador(vinculo).lerObservado(),
    identificar: () => I.identificar({ config, componente: ESCOPO }),
    instalar: (opcoes, release, vinculo, coordenacao, operacao) => I.instalar({ config, componente: ESCOPO, release, opcoes, deps: depsDoInstalador(vinculo, coordenacao, operacao) }),
  };
}

async function processar({ cfg, id, s3, deps: injetadas = {} }) {
  P.exigir(P.ID.test(id), 'ID_INVALIDO');
  const base0 = { ...dependenciasPadrao(cfg, injetadas.depsExtrasDoInstalador), ...injetadas };
  const A = base0.criarAncora();
  let base, trava, liberar = false;
  // Provedor do guardião desta operação: criado só na hora de instalar e sempre liberado (uma vez) antes do fim.
  let coordenacao = null;
  let operacao = null;
  let liberacaoDaCoordenacao = null;
  const relogio = typeof base0.relogio === 'function' ? base0.relogio : relogioMonotonico;
  const liberarCoordenacao = async () => {
    if (coordenacao && !liberacaoDaCoordenacao) liberacaoDaCoordenacao = await liberarGuardiao(coordenacao);
    return liberacaoDaCoordenacao;
  };
  const seguro = (r) => r && ((r.estado === 'RECUSADO' && r.mutacao === 'NENHUMA') || (r.estado === 'SUCESSO' && r.verificado === true));
  try {
    base = A.abrirBase(cfg.estadoDir);
    trava = A.criarExclusivo(base, TRAVA);
    const anterior = A.lerTexto(base, `${id}.json`);
    let pedido = null, mutacaoIniciada = false, origemIncerta = false, resultado, rastro = {};
    const registrar = async (detalhe) => {
      const proximo = { ...rastro, ...detalhe, versao: 2, id, escopo: ESCOPO, pedido };
      A.escreverAtomico(base, `${id}.json`, JSON.stringify(proximo));
      rastro = proximo;
    };
    const publicarRecibo = async (recibo) => {
      if (!recibo) return { reciboPendente: true };
      let existente;
      try { existente = await s3.get(chave('recibos', id)); } catch { return { reciboPendente: true }; }
      if (existente !== null) {
        if (existente.toString() !== JSON.stringify(recibo)) {
          liberar = false;
          await registrar({ fase: 'TERMINAL', resultado: { estado: 'CRITICO', verificado: false, motivo: 'RECIBO_DIVERGENTE' } });
          P.exigir(false, 'RECIBO_DIVERGENTE');
        }
      } else {
        try { await s3.put(chave('recibos', id), Buffer.from(JSON.stringify(recibo))); } catch { return { reciboPendente: true }; }
      }
      return {};
    };
    if (anterior !== null) {
      const registro = JSON.parse(anterior);
      P.exigir(registro.versao === 2 && registro.id === id && registro.fase === 'TERMINAL' && seguro(registro.resultado), 'OPERACAO_PENDENTE_OU_CRITICA');
      pedido = registro.pedido; rastro = registro;
      liberar = true;
      return { id, ...registro.resultado, ...await publicarRecibo(registro.recibo) };
    }
    await registrar({ fase: 'INICIO', mutacao: 'NENHUMA' });
    try {
      const b = await s3.get(chave('pedidos', id));
      P.exigir(b !== null, 'PEDIDO_AUSENTE');
      const candidato = P.validarEstruturaPedido(P.json(b));
      P.exigir(candidato.id === id, 'ID_DIVERGENTE');
      pedido = candidato;
      P.validarPedido(pedido, Date.now(), { escopo: ESCOPO });
      // Pré-checagem: sem o estado do banco nada é baixado, extraído nem instalado. A sonda é código da release
      // instalada, então a integridade dessa release é comprovada (pelo instalador) antes de executá-la.
      // O vínculo é resolvido aqui, uma única vez, e vale para todas as coletas desta operação.
      const baseline = saudavel(await base0.identificar());
      const vinculo = base0.vincular(baseline);
      const vinculoDoGuardiao = base0.vincularGuardiao(baseline);
      await base0.observar(vinculo);
      const blob = await s3.get(chave('blobs', id));
      P.exigir(blob !== null && N.sha256(blob) === pedido.blobSha256, 'BLOB_DIVERGENTE');
      const dir = path.join(cfg.estadoDir, `entrada-${id}`);
      try { origemIncerta = Boolean(fs.lstatSync(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      P.exigir(!origemIncerta, 'ENTRADA_PREEXISTENTE');
      P.extrair(blob, dir);
      const deps = { ...base0, registrar };
      const instalar = base0.instalar;
      deps.instalar = async (opcoes, release) => {
        // A exclusão é adquirida antes de qualquer mudança e mantida até o fim da operação; sem ela, nada começa.
        coordenacao = base0.criarCoordenacao(vinculoDoGuardiao, baseline);
        await adquirirGuardiao(coordenacao);
        operacao = criarOperacaoProtegida({ coordenacao, relogio });
        await registrar({ fase: 'INSTALACAO_INICIADA', componente: ESCOPO });
        mutacaoIniciada = true;
        try { return await instalar(opcoes, release, vinculo, coordenacao, operacao); } catch (falha) {
          if (RECUSAS_SEM_MUTACAO.has(falha.codigo)) mutacaoIniciada = false;
          throw falha;
        }
      };
      resultado = await aplicar({ pedido, releaseDir: dir, deps });
      // Depois da última ação: a garantia tem de estar de pé agora, numa confirmação nova e dentro do prazo.
      P.exigir(operacao !== null, 'COORDENACAO_NAO_ADQUIRIDA');
      await operacao.confirmarFinal();
    } catch (e) {
      // Uma perda (ou prazo, ou ação sem fim seguro) vista pelo agente é a causa; o código do instalador fica no diagnóstico.
      const perda = operacao ? operacao.perda() : null;
      resultado = mutacaoIniciada || origemIncerta
        ? { estado: 'CRITICO', verificado: false, motivo: perda ? perda.codigo : motivoCritico(e), diagnostico: codigoSeguro(e) }
        : { estado: 'RECUSADO', verificado: false, mutacao: 'NENHUMA', motivo: MOTIVOS_DE_RECUSA.has(e.codigo) ? e.codigo : 'RECUSA_ANTES_DA_INSTALACAO' };
    }
    // Janela final: nenhuma ação começa daqui em diante; o tempo entre a confirmação final e o pedido de liberação fica
    // registrado. A liberação fica no registro local; o recibo publicado não muda de formato. Sem encerramento comprovado
    // do guardião, os cadeados podem continuar presos: nenhum resultado seguro se mantém e a operação vira CRITICO, com a
    // trava preservada. Com encerramento comprovado mas sem a soltura conferida dos quatro cadeados, a continuidade até o
    // fim não está demonstrada: SUCESSO também vira CRITICO. Um CRITICO anterior continua com o próprio motivo.
    if (operacao) operacao.pedirLiberacao();
    await liberarCoordenacao();
    let resultadoAntesDaLiberacao;
    if (liberacaoDaCoordenacao && !liberacaoDaCoordenacao.encerramentoComprovado && resultado.estado !== 'CRITICO') {
      resultadoAntesDaLiberacao = resultado;
      resultado = { estado: 'CRITICO', verificado: false, motivo: 'LIBERACAO_DA_COORDENACAO_INCERTA', diagnostico: liberacaoDaCoordenacao.situacao };
    } else if (liberacaoDaCoordenacao && !liberacaoDaCoordenacao.continuidadeDemonstrada && resultado.estado === 'SUCESSO') {
      resultadoAntesDaLiberacao = resultado;
      resultado = { estado: 'CRITICO', verificado: false, motivo: 'CONTINUIDADE_NAO_DEMONSTRADA', diagnostico: liberacaoDaCoordenacao.situacao };
    }
    const recibo = pedido ? { id, commit: pedido.commit, releaseSha256: pedido.releaseSha256, escopo: ESCOPO, ...resultado } : null;
    await registrar({
      fase: 'TERMINAL', resultado, recibo, ...(liberacaoDaCoordenacao ? { liberacaoDaCoordenacao } : {}), ...(resultadoAntesDaLiberacao ? { resultadoAntesDaLiberacao } : {}),
      ...(operacao ? { coordenacao: operacao.descrever() } : {}),
    });
    liberar = Boolean(seguro(resultado));
    return { id, ...resultado, ...await publicarRecibo(recibo) };
  } finally {
    // Se algo lançou antes do registro final, o guardião ainda é liberado: os cadeados nunca ficam presos ao agente.
    try { await liberarCoordenacao(); } finally {
      try { if (trava && liberar) { const identidade = A.identidade(trava); A.fechar(trava); A.removerArvore(base, TRAVA, { identidade }); } } finally { A.fecharTudo(); }
    }
  }
}

async function processarFila({ cfg, ids, s3, deps }) {
  let ok = true;
  for (const id of ids) {
    P.exigir(P.ID.test(id), 'ID_INVALIDO');
    const existente = await s3.get(chave('recibos', id));
    if (existente !== null) {
      const r = P.json(existente);
      P.exigir(r.id === id && r.escopo === ESCOPO && ['SUCESSO', 'RECUSADO'].includes(r.estado), 'RECIBO_INVALIDO_OU_CRITICO');
      continue;
    }
    const r = await processar({ cfg, id, s3, deps });
    P.exigir(r.estado !== 'CRITICO', 'OPERACAO_CRITICA');
    if (r.estado !== 'SUCESSO' || r.reciboPendente) ok = false;
    if (r.reciboPendente && r.estado !== 'RECUSADO') break;
  }
  return { ok };
}

async function principal(argv) {
  P.exigir(argv[0] === '--config' && ((argv.length === 4 && argv[2] === '--pedido') || (argv.length === 3 && argv[2] === '--pendentes')), 'USO');
  N.verificarContextoDeExecucao();
  P.exigir(process.platform === 'linux', 'LINUX_OBRIGATORIO');
  const cfg = validarConfiguracao(N.lerConfigSegura(argv[1]));
  const s3 = criarS3(cfg.s3);
  if (argv[2] === '--pendentes') P.exigir((await processarFila({ cfg, ids: await s3.listarPedidos(), s3 })).ok, 'FILA_COM_FALHAS');
  else {
    const r = await processar({ cfg, id: argv[3], s3 });
    P.exigir(r.estado === 'SUCESSO' && !r.reciboPendente, 'PUBLICACAO_FALHOU');
  }
}

if (require.main === module) principal(process.argv.slice(2)).catch((e) => { console.error(`Agente do backend recusou: ${e.codigo || 'ERRO'}`); process.exitCode = 1; });
module.exports = { aplicar, validarConfiguracao, vincularSonda, vincularGuardiao, coletarObservado, processar, processarFila, principal, PRAZOS_DA_OPERACAO };
