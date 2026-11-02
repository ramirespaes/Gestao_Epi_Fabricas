'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { lerConfiguracao } = require('../config/imagens');
const { criarControleDeProcesso } = require('./imagem-backup-pgdump-controle-processo.service');
const { criarLancadorEstruturalComSpawn } = require('./imagem-backup-estrutura-lancador.service');
const { criarVerificadorEstrutural } = require('./imagem-backup-estrutura.service');
const { criarInicializacaoConfiavel, executarBackupEncadeado } = require('./imagem-backup-encadeamento-confiavel-integrado.service');
const { criarPublicador, criarProdutorOperacional, avaliarProntidaoOperacional, ehProdutorReconhecido } = require('./imagem-backup-publicacao.service');
const { avaliarCorrelacao, estruturaVerificada } = require('./imagem-backup-correlacao.service');
const { criarSelagemAutenticada, criarLeitorV2, ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');
const { ehJanelaDeBackup } = require('./imagem-backup.service');
const { criarRestaurador } = require('./imagem-backup-restauracao.service');
const { criarRestauradorDoBanco } = require('./imagem-backup-restauracao-banco.service');
const { criarLancadorDeRestauracaoComSpawn } = require('./imagem-backup-restauracao-lancador.service');
const { criarAdaptadorDeReferencias, criarSondaDeInstancia } = require('./imagem-backup-consistencia-banco.service');
const { avaliarRestauracaoReal, ehAvaliacaoReconhecida, emitirExecucaoDeRestauracao } = require('./imagem-backup-proveniencia-restauracao.service');
const { hostSintaticamenteValido } = require('./imagem-backup-host-postgres');
const portas = require('./imagem-backup-portas-sistema.service');
const { criarOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');
const { criarRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): COMPOSIÇÃO DE PRODUÇÃO do backup e da restauração. Liga, com contratos explícitos e falha fechada, os componentes JÁ APROVADOS (coordenador, supervisor, controle de processo, janela de escrita,
 * preparação exclusiva, verificação de imagens, manifesto V2 autenticado, publicação, restauração); não reimplementa nenhum. Não lê ambiente (NODE_ENV inclusive), não abre conexão, não escolhe serviço de segredos e não cadastra destinos.
 *
 * `criarBackupDeProducao(config)` (ESTRITO; TypeError `CONFIGURACAO_INVALIDA` genérico, sem eco de valores, ANTES de qualquer efeito) -> `{ verificarDependencias(), executar({ nomeDaPreparacao, conjuntoId }) }`. `config`:
 *   - `postgres`: { pgDump, pgRestore (caminhos absolutos canônicos), host (nome ou socket Unix canônico), porta (inteiro 1..65535, OBRIGATÓRIA), usuario, arquivoDeSenha (absoluto), banco: { nome, oid } };
 *   - `conexao`: { criarConexao (cliente DEDICADO, injetado), finalizacaoMs };  `armazenamento`: { imagens, preparacoes, dumps, publicados } (absolutos);
 *   - `chaves`: { fonteDeChaves (produzida pela fábrica aprovada), chaveId };  `prazos`: os cinco do supervisor;  `maxBytesPorArquivo`;
 *   - `relatorio` (opcional): { produtor, origensAceitas }. O PADRÃO é o produtor OPERACIONAL BLOQUEADO (`criarProdutorOperacional`): nenhuma publicação até haver fonte operacional de chaves e destino autorizado. O produtor de TESTE só existe com a fábrica de teste e nunca vira operacional;
 *   - `janela` (OBRIGATÓRIA): a capacidade RECONHECIDA produzida por `criarJanelaDeBackup` (módulo do coordenador, o ponto de integração autorizado da trava; guarda PRT-07 intacta). Função arbitrária, literal, clone ou posse simulada são recusados na configuração;
 *   - `portas` (opcional): { spawn, observarGrupo, temporizador, criarExclusivo, statfs }; o padrão são as portas reais de `imagem-backup-portas-sistema.service` (`statfs` padrão = `fs.statfsSync`, só para a verificação INDICATIVA de espaço);
 *   - `limites` (opcional, P4; NENHUM valor padrão e nenhum valor operacional é inventado aqui): { totalBytes?, maxBytesDoDump?, bytesLivresMinimos? }, inteiros seguros positivos. `totalBytes` cria, POR EXECUÇÃO, um orçamento de bytes compartilhado pela captura do dump e pela cópia das imagens (aplicado DURANTE a produção,
 *     antes de gravar cada pedaço/arquivo); `maxBytesDoDump` é o teto do dump (<= `totalBytes` quando ambos existem); `bytesLivresMinimos` ativa a verificação PRÉVIA e apenas INDICATIVA de espaço (`statfs` dos diretórios de trabalho): ela pode recusar cedo (`ESPACO_INSUFICIENTE`, sem efeitos), mas passar nela
 *     NÃO garante espaço (cotas, outros escritores, alocação tardia) — o limite efetivo é o orçamento aplicado na produção e o tratamento de `ENOSPC` em cada escrita. A incorporação do dump ao pacote (segunda cópia física do dump) CONSOME o orçamento (reserva por inteiro antes de qualquer efeito). Mesmo assim `totalBytes` NÃO é o limite absoluto de ocupação em disco: manifesto e selo, temporários, metadados/overhead do sistema de arquivos e arredondamento de blocos não são contabilizados; dimensione o volume com folga.
 *   - `operacoes` (opcional, P2/P3; DESLIGADO por omissão e SEM valor padrão): { aberturaMs?, etapaMs?, posseMs?, cortesiaMs? }, inteiros seguros positivos, pelo menos um. Cria, POR EXECUÇÃO, o registro de operações pendentes. `aberturaMs` limita a abertura do snapshot; `etapaMs` (só cópia e avaliação) e `posseMs` ficam com o coordenador; `cortesiaMs` é só um intervalo de OBSERVAÇÃO depois de um pedido de cancelamento
 *     (nunca prova de término). Prazo vencido apenas SOLICITA cancelamento; cancelamento não confirmado retém a trava e mantém a operação na lista de pendentes. A proveniência traz `operacoes` (resumo por código). A restauração (`criarRestauracaoDeProducao`) NÃO usa este mecanismo.
 * `verificarDependencias()` (e `executar`, que a chama primeiro): binários existentes, regulares e executáveis (SEM executá-los), arquivo de senha regular 0600 do usuário do processo, diretórios reais e próprios; falha com `DEPENDENCIA_INDISPONIVEL` e o NOME do item.
 * `executar` monta, por operação, o controle de processo do `pg_dump` (uso único) e o da verificação estrutural, a janela de escrita, a selagem autenticada e o publicador, e roda o pipeline encadeado. Devolve um resultado CONGELADO e RECONHECIDO com `{ resultado, prontidao, estado, proveniencia }`.
 *
 * `classificarEstadoDoBackup(resultadoDaComposicao)`: separa, SEM alterar o veredito do coordenador: correlação contratual, pacote publicado, publicação operacional, prontidão operacional, backup operacional válido e recuperabilidade comprovada. Só aceita o resultado produzido por `executar` (literal ou clone =
 * tudo falso, motivo RESULTADO_NAO_RECONHECIDO). `backupOperacionalValido` exige prontidão satisfeita E veredito `valido` do coordenador E publicação operacional: hoje impossível. `recuperabilidadeComprovada` é sempre falsa aqui (depende de restauração real provada, que este código não produz).
 *
 * CAPTURA DO DUMP: o `pg_dump` (formato custom) emite os bytes pelo STDOUT; o lançador os captura (fluxo binário, backpressure, escritas parciais tratadas, SHA-256 incremental, gravação íntegra no arquivo exclusivo e fsync) e só então declara os fluxos fechados. A proveniência registra SHA256_FLUXO_RECEBIDO e
 * SHA256_ARQUIVO_PERSISTIDO (releitura posterior) e se correspondem. O pipeline compara o hash do fluxo com a releitura física T1 e T2 verifica o arquivo de novo: divergência impede composição, selagem e publicação. Isso prova que o arquivo é o que o `pg_dump` EMITIU; NÃO é atestação independente do conteúdo
 * lógico do banco nem da correção interna do `pg_dump` (`independenteDaCorrecaoInternaDoPgDump:false`, `atestaConteudoLogico:false`).
 *
 * `criarRestauracaoDeProducao(config)` -> `{ restaurar({ raizAutorizada, nome, imagens, destino }) }`: monta, por restauração, o controle do `pg_restore` (uso único) com o lançador de restauração, a política de destino IMPOSTA pelo chamador (obrigatória, sem padrão), a sonda de instância e o adaptador de consistência sobre a conexão
 * injetada. O resultado traz `proveniencia.avaliacao` (itens e pendências) e `estado`, DERIVADO dela: `restauracaoReal` e `consistenciaLogicaVerificada` só ficam verdadeiros se TODOS os itens da proveniência forem satisfeitos por evidências produzidas pelos componentes confiáveis (spawn e cliente genuínos, instância física,
 * dump autenticado e conferido, terminal, sem sobrevivente, banco restaurado, consultas reais, imagens e correlação). `recuperavelEmProducao` é SEMPRE falso aqui. O resultado do restaurador (Marco D) continua com os três estados falsos.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const NOME_DE_BANCO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const NOME_DA_PREPARACAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHAVES_DOS_PRAZOS = ['totalMs', 'cortesiaMs', 'intervaloGrupoMs', 'tentativasGrupo', 'consultaGrupoMs'];
const PORTAS_PERMITIDAS = ['spawn', 'observarGrupo', 'temporizador', 'criarExclusivo', 'statfs'];
const LIMITES_PERMITIDOS = ['totalBytes', 'maxBytesDoDump', 'bytesLivresMinimos'];
const OPERACOES_PERMITIDAS = ['aberturaMs', 'etapaMs', 'posseMs', 'cortesiaMs'];

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const soChaves = (o, permitidas, obrigatorias = []) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.every((k) => typeof k === 'string' && permitidas.includes(k)) && obrigatorias.every((k) => proprias.includes(k));
};
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const executavelDe = (v, nome) => caminhoAbsoluto(v) && v.endsWith(`/${nome}`);

function configuracaoInvalida() {
  const falha = new TypeError('configuração da composição de produção inválida');
  falha.code = 'CONFIGURACAO_INVALIDA';
  return falha;
}
function dependenciaIndisponivel(item) {
  const falha = new Error('dependência do backup indisponível');
  falha.code = 'DEPENDENCIA_INDISPONIVEL';
  falha.item = item;
  return falha;
}
const exigir = (condicao) => { if (!condicao) throw configuracaoInvalida(); };

function validarPostgres(pgcfg, { precisaDump }) {
  exigir(ehObjeto(pgcfg) && chavesExatas(pgcfg, precisaDump ? ['pgDump', 'pgRestore', 'host', 'porta', 'usuario', 'arquivoDeSenha', 'banco'] : ['pgRestore']));
  exigir(executavelDe(pgcfg.pgRestore, 'pg_restore'));
  if (!precisaDump) return;
  exigir(executavelDe(pgcfg.pgDump, 'pg_dump'));
  exigir(Number.isSafeInteger(pgcfg.porta) && pgcfg.porta >= 1 && pgcfg.porta <= 65535);
  exigir(hostSintaticamenteValido(pgcfg.host, pgcfg.porta) !== null);
  exigir(typeof pgcfg.usuario === 'string' && USUARIO.test(pgcfg.usuario) && caminhoAbsoluto(pgcfg.arquivoDeSenha));
  exigir(ehObjeto(pgcfg.banco) && chavesExatas(pgcfg.banco, ['nome', 'oid']) && typeof pgcfg.banco.nome === 'string' && NOME_DE_BANCO.test(pgcfg.banco.nome) && typeof pgcfg.banco.oid === 'string' && OID.test(pgcfg.banco.oid));
}
function validarPrazos(prazos) {
  exigir(ehObjeto(prazos) && chavesExatas(prazos, CHAVES_DOS_PRAZOS) && CHAVES_DOS_PRAZOS.every((k) => inteiroPositivo(prazos[k])));
  return Object.freeze({ ...prazos });
}
function validarPortas(p) {
  if (p === undefined) return Object.freeze({});
  exigir(ehObjeto(p) && soChaves(p, PORTAS_PERMITIDAS) && Object.values(p).every((v) => ehFuncao(v) || ehObjeto(v)));
  if (p.temporizador !== undefined) exigir(ehObjeto(p.temporizador) && ehFuncao(p.temporizador.prazo) && ehFuncao(p.temporizador.intervalo));
  for (const k of ['spawn', 'observarGrupo', 'criarExclusivo', 'statfs']) if (p[k] !== undefined) exigir(ehFuncao(p[k]));
  return Object.freeze({ ...p });
}
/** Limites opcionais (P4): só chaves conhecidas, pelo menos uma, inteiros seguros positivos; o teto do dump nunca excede o total. Nenhum valor padrão. */
function validarLimites(l) {
  exigir(ehObjeto(l) && Reflect.ownKeys(l).length > 0 && soChaves(l, LIMITES_PERMITIDOS) && Reflect.ownKeys(l).every((k) => inteiroPositivo(l[k])));
  if (l.totalBytes !== undefined && l.maxBytesDoDump !== undefined) exigir(l.maxBytesDoDump <= l.totalBytes);
  return Object.freeze({ ...l });
}
/** Controle de operações pendentes (P2/P3), opcional e DESLIGADO por omissão; NENHUM valor padrão: só chaves conhecidas, pelo menos uma, inteiros seguros positivos. */
function validarOperacoes(o) {
  exigir(ehObjeto(o) && Reflect.ownKeys(o).length > 0 && soChaves(o, OPERACOES_PERMITIDAS) && Reflect.ownKeys(o).every((k) => inteiroPositivo(o[k])));
  return Object.freeze({ ...o });
}
function espacoInsuficiente(item) {
  const falha = new Error('espaço indicativo insuficiente para o backup');
  falha.code = 'ESPACO_INSUFICIENTE';
  falha.item = item;
  return falha;
}
/** Verificação INDICATIVA e SEM efeitos: livre = bavail*bsize (BigInt, sem estouro) de cada diretório de trabalho contra `bytesLivresMinimos`. Falha do `statfs` não bloqueia (é só indicativo) e consta como INDISPONIVEL. */
function verificarEspacoIndicativo(cfg) {
  if (cfg.limites === null || cfg.limites.bytesLivresMinimos === undefined) return Object.freeze({ verificado: false, motivo: 'NAO_CONFIGURADO' });
  const statfs = cfg.portas.statfs ?? fs.statfsSync;
  const minimo = BigInt(cfg.limites.bytesLivresMinimos);
  for (const [item, dir] of [['DUMPS', cfg.armazenamento.dumps], ['PREPARACOES', cfg.armazenamento.preparacoes], ['PUBLICADOS', cfg.armazenamento.publicados]]) {
    let livre;
    try {
      const st = statfs(dir);
      livre = BigInt(st.bavail) * BigInt(st.bsize);
      if (livre < 0n) throw new Error('x');
    } catch { return Object.freeze({ verificado: false, motivo: 'INDISPONIVEL' }); }
    if (livre < minimo) throw espacoInsuficiente(item);
  }
  return Object.freeze({ verificado: true, motivo: null, indicativo: true });
}
const portasEfetivas = (p) => Object.freeze({
  spawn: p.spawn ?? portas.criarSpawnReal(),
  observarGrupo: p.observarGrupo ?? portas.observarGrupoReal,
  temporizador: p.temporizador ?? portas.temporizadorReal,
});

const resultadosProduzidos = new WeakSet();

/**
 * Proveniência do hash do dump: SHA256_FLUXO_RECEBIDO (calculado sobre os bytes recebidos do stdout do pg_dump, durante a escrita) e SHA256_ARQUIVO_PERSISTIDO (releitura posterior do arquivo). A correspondência prova que o arquivo é o que o pg_dump EMITIU;
 * NÃO são duas fontes independentes do conteúdo lógico do banco e NÃO atestam a correção interna do pg_dump.
 */
function hashDoDumpProvado(captura, caminho) {
  let persistido = null;
  try { if (caminho !== null) persistido = crypto.createHash('sha256').update(fs.readFileSync(caminho)).digest('hex'); } catch { persistido = null; }
  const fluxo = captura === null ? null : captura.sha256FluxoRecebido;
  return Object.freeze({
    origem: 'FLUXO_STDOUT_DURANTE_A_ESCRITA',
    SHA256_FLUXO_RECEBIDO: fluxo,
    SHA256_ARQUIVO_PERSISTIDO: persistido,
    correspondem: fluxo !== null && persistido !== null && fluxo === persistido,
    bytesRecebidos: captura === null ? null : captura.bytesRecebidos,
    bytesGravados: captura === null ? null : captura.bytesGravados,
    fsyncConcluido: captura === null ? false : captura.fsyncConcluido === true,
    independenteDaCorrecaoInternaDoPgDump: false,
    atestaConteudoLogico: false,
  });
}

function lerAutenticacaoDoPacote(leitor, preparacoes, publicados, nome, sha256Manifesto) {
  for (const raiz of [publicados, preparacoes]) {
    try {
      const l = leitor({ bytes: fs.readFileSync(path.join(raiz, nome, 'manifesto.json')), sha256: sha256Manifesto });
      return l.autenticacao ?? null;
    } catch { /* tenta a próxima raiz; sem leitura autenticada, a prontidão fica sem evidência */ }
  }
  return null;
}

function criarBackupDeProducao(config) {
  let cfg;
  try {
    exigir(ehObjeto(config) && soChaves(config, ['postgres', 'conexao', 'armazenamento', 'chaves', 'relatorio', 'prazos', 'maxBytesPorArquivo', 'portas', 'janela', 'limites', 'operacoes'], ['postgres', 'conexao', 'armazenamento', 'chaves', 'prazos', 'maxBytesPorArquivo', 'janela']));
    validarPostgres(config.postgres, { precisaDump: true });
    exigir(ehJanelaDeBackup(config.janela));
    const { conexao, armazenamento, chaves, relatorio } = config;
    exigir(ehObjeto(conexao) && chavesExatas(conexao, ['criarConexao', 'finalizacaoMs']) && ehFuncao(conexao.criarConexao) && inteiroPositivo(conexao.finalizacaoMs));
    exigir(ehObjeto(armazenamento) && chavesExatas(armazenamento, ['imagens', 'preparacoes', 'dumps', 'publicados']) && Object.values(armazenamento).every(caminhoAbsoluto));
    exigir(ehObjeto(chaves) && chavesExatas(chaves, ['fonteDeChaves', 'chaveId']) && ehFonteDeChaves(chaves.fonteDeChaves) && typeof chaves.chaveId === 'string' && CHAVE_ID.test(chaves.chaveId));
    if (relatorio !== undefined) exigir(ehObjeto(relatorio) && soChaves(relatorio, ['produtor', 'origensAceitas'], ['produtor']) && ehProdutorReconhecido(relatorio.produtor));
    exigir(inteiroPositivo(config.maxBytesPorArquivo));
    cfg = Object.freeze({
      postgres: Object.freeze({ ...config.postgres, banco: Object.freeze({ ...config.postgres.banco }) }),
      conexao: Object.freeze({ ...conexao }),
      armazenamento: Object.freeze({ ...armazenamento }),
      chaves: Object.freeze({ ...chaves }),
      relatorio: relatorio === undefined ? null : Object.freeze({ ...relatorio }),
      prazos: validarPrazos(config.prazos),
      maxBytesPorArquivo: config.maxBytesPorArquivo,
      portas: validarPortas(config.portas),
      janela: config.janela,
      limites: config.limites === undefined ? null : validarLimites(config.limites),
      operacoes: config.operacoes === undefined ? null : validarOperacoes(config.operacoes),
    });
  } catch {
    throw configuracaoInvalida();
  }

  async function verificarDependencias() {
    const executavel = (item, caminho) => {
      let estado;
      try { estado = fs.statSync(caminho); } catch { throw dependenciaIndisponivel(item); }
      if (!estado.isFile()) throw dependenciaIndisponivel(item);
      try { fs.accessSync(caminho, fs.constants.X_OK); } catch { throw dependenciaIndisponivel(item); }
    };
    executavel('PG_DUMP', cfg.postgres.pgDump);
    executavel('PG_RESTORE', cfg.postgres.pgRestore);
    let senha;
    try { senha = fs.lstatSync(cfg.postgres.arquivoDeSenha); } catch { throw dependenciaIndisponivel('ARQUIVO_DE_SENHA'); }
    if (!senha.isFile() || senha.isSymbolicLink() || (senha.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && senha.uid !== process.getuid())) throw dependenciaIndisponivel('ARQUIVO_DE_SENHA');
    for (const [item, dir] of [['IMAGENS', cfg.armazenamento.imagens], ['PREPARACOES', cfg.armazenamento.preparacoes], ['DUMPS', cfg.armazenamento.dumps], ['PUBLICADOS', cfg.armazenamento.publicados]]) {
      let e;
      try { e = fs.lstatSync(dir); } catch { throw dependenciaIndisponivel(item); }
      if (!e.isDirectory() || e.isSymbolicLink() || fs.realpathSync(dir) !== dir || (typeof process.getuid === 'function' && e.uid !== process.getuid())) throw dependenciaIndisponivel(item);
    }
    return Object.freeze({ ok: true, itens: Object.freeze(['PG_DUMP', 'PG_RESTORE', 'ARQUIVO_DE_SENHA', 'IMAGENS', 'PREPARACOES', 'DUMPS', 'PUBLICADOS']) });
  }

  async function executar(entrada) {
    exigir(ehObjeto(entrada) && chavesExatas(entrada, ['nomeDaPreparacao', 'conjuntoId']) && typeof entrada.nomeDaPreparacao === 'string' && NOME_DA_PREPARACAO.test(entrada.nomeDaPreparacao) && typeof entrada.conjuntoId === 'string' && entrada.conjuntoId !== '');
    await verificarDependencias();
    // P4: verificação PRÉVIA e apenas indicativa de espaço (recusa cedo, sem efeitos; passar NÃO garante espaço) e orçamento de bytes DESTA execução
    const espacoIndicativo = verificarEspacoIndicativo(cfg);
    const orcamento = cfg.limites !== null && cfg.limites.totalBytes !== undefined ? criarOrcamentoDeBytes({ totalBytes: cfg.limites.totalBytes }) : null;
    const { spawn, observarGrupo, temporizador } = portasEfetivas(cfg.portas);
    // P2/P3: registro de operações pendentes DESTA execução (só com `operacoes` configurado; sem isso o fluxo é o de sempre). O prazo de abertura vai ao snapshot; `etapaMs`/`posseMs` ao coordenador; `cortesiaMs` ao registro (só observação).
    const registro = cfg.operacoes === null ? null : criarRegistroDeOperacoes({ temporizador, ...(cfg.operacoes.cortesiaMs === undefined ? {} : { cortesiaMs: cfg.operacoes.cortesiaMs }) });
    const controle = registro === null ? null : Object.freeze({ registro, ...(cfg.operacoes.etapaMs === undefined ? {} : { etapaMs: cfg.operacoes.etapaMs }), ...(cfg.operacoes.posseMs === undefined ? {} : { posseMs: cfg.operacoes.posseMs }) });
    // fase do pacote/publicação (códigos fixos, vinda do encadeamento); uma conclusão TARDIA (depois da saída) também a atualiza
    let fasePublicacao = Object.freeze({ fase: 'NAO_INICIADA' });
    const criador = cfg.portas.criarExclusivo === undefined ? portas.criarCriadorExclusivoDeArquivo() : { criarExclusivo: cfg.portas.criarExclusivo, ultimoCaminho: () => null };

    // um controle de processo por operação e por processo (uso único): pg_dump e verificação estrutural
    const controleDump = criarControleDeProcesso({ spawn, observarGrupo, ...(cfg.limites !== null && cfg.limites.maxBytesDoDump !== undefined ? { limiteDeBytes: cfg.limites.maxBytesDoDump } : {}), ...(orcamento === null ? {} : { orcamento }) });
    const controleLista = criarControleDeProcesso({ spawn, observarGrupo, criarLancador: ({ spawn: s }) => criarLancadorEstruturalComSpawn({ spawn: s }) });
    const verificadorEstrutural = criarVerificadorEstrutural({ alvo: { executavel: cfg.postgres.pgRestore }, lancador: controleLista.lancador, sistema: controleLista.sistema, temporizador, prazos: cfg.prazos });
    const selagem = criarSelagemAutenticada(cfg.chaves);
    const leitor = criarLeitorV2({ fonteDeChaves: cfg.chaves.fonteDeChaves });
    let capturado = null;
    // Produtor padrão = OPERACIONAL, que só reconhece evidências emitidas pelos componentes confiáveis e, por fatos que só a composição conhece, a captura íntegra do dump (fluxo = arquivo persistido, fsync) e a janela genuína. Fonte de chaves e destino operacionais: listas vazias.
    const complementos = () => ({
      capturaIntegra: capturado !== null && capturado.ok === true && capturado.fsyncConcluido === true && capturado.bytesRecebidos === capturado.bytesGravados && hashDoDumpProvado(capturado, criador.ultimoCaminho()).correspondem === true,
      janelaGenuina: ehJanelaDeBackup(cfg.janela),
    });
    const publicador = criarPublicador({
      raizDoDestino: cfg.armazenamento.publicados,
      produtorDeRelatorio: cfg.relatorio === null ? criarProdutorOperacional({ complementos }) : cfg.relatorio.produtor,
      ...(cfg.relatorio !== null && cfg.relatorio.origensAceitas !== undefined ? { origensAceitas: cfg.relatorio.origensAceitas } : {}),
      leitorDeManifesto: leitor,
      // registros duráveis da publicação autenticados com a MESMA fonte de chaves do manifesto V2 (domínio de HMAC próprio; o segredo nunca é gravado)
      registro: { fonteDeChaves: cfg.chaves.fonteDeChaves, chaveId: cfg.chaves.chaveId },
    });
    const inicializacao = criarInicializacaoConfiavel({
      configuracaoDeImagens: lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: cfg.armazenamento.imagens }),
      diretorioPai: cfg.armazenamento.preparacoes,
      diretorioDoDump: cfg.armazenamento.dumps,
      janela: cfg.janela,
      conexao: { criarConexao: cfg.conexao.criarConexao, temporizador, prazos: { finalizacaoMs: cfg.conexao.finalizacaoMs, ...(cfg.operacoes !== null && cfg.operacoes.aberturaMs !== undefined ? { aberturaMs: cfg.operacoes.aberturaMs } : {}) } },
      ...(controle === null ? {} : { controle }),
      observarPublicacao: (dados) => { fasePublicacao = dados; },
      dump: {
        alvo: { executavel: cfg.postgres.pgDump, host: cfg.postgres.host, porta: cfg.postgres.porta, usuario: cfg.postgres.usuario, arquivoDeSenha: cfg.postgres.arquivoDeSenha, bancoEsperado: { nome: cfg.postgres.banco.nome, oid: cfg.postgres.banco.oid } },
        lancador: controleDump.lancador,
        sistema: controleDump.sistema,
        arquivos: { criarExclusivo: (spec) => criador.criarExclusivo(spec) },
        temporizador,
        prazos: cfg.prazos,
        // os bytes saem pelo STDOUT do pg_dump, passam pela captura (SHA-256 incremental + gravação íntegra + fsync) e só então chegam ao arquivo exclusivo
        saida: 'PIPE_COM_HASH',
      },
      selagem: { selar: (e) => selagem.selar(e), verificar: (e) => selagem.verificar(e), autenticar: (c) => selagem.autenticar(c) },
      maxBytesPorArquivo: cfg.maxBytesPorArquivo,
      ...(orcamento === null ? {} : { orcamento }),
      // SHA256_FLUXO_RECEBIDO: o hash incremental dos bytes que o pg_dump emitiu pelo stdout (captura do lançador). O pipeline o compara com a releitura física do arquivo (T1): divergência impede a composição.
      declaracaoDoDump: {
        async sha256() {
          const promessa = controleDump.capturaDoDump();
          if (promessa === null) throw dependenciaIndisponivel('CAPTURA_DO_DUMP');
          const evidencia = await promessa;
          if (!evidencia || evidencia.ok !== true || evidencia.bytesRecebidos !== evidencia.bytesGravados || evidencia.fsyncConcluido !== true) throw dependenciaIndisponivel('CAPTURA_DO_DUMP');
          capturado = evidencia;
          return evidencia.sha256FluxoRecebido;
        },
      },
      verificadorEstrutural,
      publicador,
    });
    const resultado = await executarBackupEncadeado({ inicializacao, nomeDaPreparacao: entrada.nomeDaPreparacao, conjuntoId: entrada.conjuntoId });
    // evidência final da captura (inclusive a falha, com o motivo fixo), mesmo que a declaração do dump não tenha chegado a ser pedida
    // A espera é LIMITADA (cortesia do supervisor): um stdout que nunca fecha não prende a composição; a captura pendente é registrada como tal, nunca como sucesso.
    const promessaDaCaptura = controleDump.capturaDoDump();
    let capturaFinal = null;
    if (promessaDaCaptura !== null) {
      const limite = temporizador.prazo(cfg.prazos.cortesiaMs);
      capturaFinal = await Promise.race([promessaDaCaptura, limite.promessa.then(() => Object.freeze({ ok: false, motivo: 'CAPTURA_PENDENTE', bytesRecebidos: null, bytesGravados: null, stderrBytes: null }))]);
      limite.cancelar();
    }

    const correlacao = resultado.correlacao;
    const autenticacao = correlacao ? lerAutenticacaoDoPacote(leitor, cfg.armazenamento.preparacoes, cfg.armazenamento.publicados, entrada.nomeDaPreparacao, correlacao.manifesto && correlacao.manifesto.sha256Manifesto) : null;
    const prontidao = avaliarProntidaoOperacional({
      correlacao,
      pacote: resultado.pacote && resultado.pacote.verificacao,
      consistencia: resultado.pacote && resultado.pacote.consistencia,
      autenticacao,
      destino: { raizDoDestino: cfg.armazenamento.publicados, nomeFinal: entrada.nomeDaPreparacao },
    });
    const composto = Object.freeze({
      resultado,
      prontidao,
      proveniencia: Object.freeze({
        hashDoDump: hashDoDumpProvado(capturado, criador.ultimoCaminho()),
        captura: capturaFinal === null ? null : Object.freeze({ ok: capturaFinal.ok === true, motivo: capturaFinal.motivo ?? null, bytesRecebidos: capturaFinal.bytesRecebidos, bytesGravados: capturaFinal.bytesGravados, stderrBytes: capturaFinal.stderrBytes, diagnosticoDoStderr: capturaFinal.diagnosticoDoStderr ?? null, sha256FluxoRecebido: capturaFinal.ok === true ? capturaFinal.sha256FluxoRecebido : null }),
        // O orçamento conta o dump capturado, as imagens e a SEGUNDA cópia física do dump (incorporação ao pacote). `totalBytes` NÃO é, porém, um limite absoluto de ocupação em disco: manifesto e selo, temporários, metadados/overhead do sistema de arquivos e arredondamento de blocos não são contabilizados.
        limites: Object.freeze({ configurados: cfg.limites !== null, espacoIndicativo, usadoDoOrcamento: orcamento === null ? null : orcamento.usado(), totalBytes: orcamento === null ? null : orcamento.totalBytes, cobreSegundaCopiaDoDump: true, ocupacaoFisicaTotal: false }),
        operacoes: registro === null ? null : registro.resumo(),
        publicacao: Object.freeze({ faseNaSaida: fasePublicacao.fase }),
        /** Leitura FRESCA do que foi observado depois da saída (conclusão tardia de uma operação abandonada); só códigos fixos. */
        situacaoAtual: () => Object.freeze({ fasePublicacao: fasePublicacao.fase, publicada: fasePublicacao.publicada === true, estadoDaPublicacao: fasePublicacao.estadoDaPublicacao ?? null, operacoes: registro === null ? null : registro.resumo() }),
        chaves: Object.freeze({ origem: cfg.chaves.fonteDeChaves.origem, chaveId: cfg.chaves.chaveId }),
        processosDoDump: controleDump.situacao(),
        processosDaListagem: controleLista.situacao(),
      }),
    });
    resultadosProduzidos.add(composto);
    return composto;
  }

  return Object.freeze({ verificarDependencias, executar });
}

/** Decisão PURA e única de "backup operacional válido": todas as dimensões verdadeiras E fora de quarentena (qualquer valor que não seja exatamente `true`/`false` esperado falha fechado). */
function derivarBackupOperacionalValido({ prontidaoOperacional, coordenadorValido, publicacaoOperacional, emQuarentena }) {
  return prontidaoOperacional === true && coordenadorValido === true && publicacaoOperacional === true && emQuarentena === false;
}

/** Separa as dimensões do estado sem alterar o veredito do coordenador; só o resultado PRODUZIDO por `executar` é reconhecido. */
function classificarEstadoDoBackup(composto) {
  const reconhecido = composto !== null && typeof composto === 'object' && resultadosProduzidos.has(composto);
  const nada = Object.freeze({ reconhecido: false, motivo: 'RESULTADO_NAO_RECONHECIDO', correlacaoContratual: false, pacotePublicado: false, publicacaoOperacional: false, prontidaoOperacional: false, backupOperacionalValido: false, recuperabilidadeComprovada: false });
  if (!reconhecido) return nada;
  const r = composto.resultado;
  const c = r.correlacao;
  const correlacaoContratual = Boolean(c) && avaliarCorrelacao(c).satisfeita === true && estruturaVerificada(c) === true && r.pacote && r.pacote.ok === true && Boolean(r.pacote.consistencia) && r.pacote.consistencia.demonstrada === true;
  const pacotePublicado = Boolean(r.publicacao) && r.publicacao.publicada === true;
  const publicacaoOperacional = pacotePublicado && r.publicacao.publicacaoOperacional === true;
  const coordenadorValido = Boolean(r.coordenador) && r.coordenador.valido === true;
  const prontidaoOperacional = composto.prontidao.pronta === true;
  // Classificação CONSERVADORA do que estava em andamento ou foi cancelado: nunca favorece o resultado. Uma publicação física já iniciada não é interrompível por este contrato; se ficou sem conclusão conhecida, foi concluída sob cancelamento/pendência ou está INCERTA, o pacote
  // é tratado como suspeito (quarentena recomendada) e a trava retida só sai por recuperação autorizada. `backupOperacionalValido` continua exigindo o veredito válido do coordenador, que nunca é válido nesses casos.
  // A leitura FRESCA (`situacaoAtual`) soma o que aconteceu DEPOIS da saída (conclusão tardia): o pior entre a fase na saída e a atual vale.
  const faseNaSaida = composto.proveniencia.publicacao === undefined ? 'NAO_INICIADA' : composto.proveniencia.publicacao.faseNaSaida;
  let viva = null;
  try { viva = typeof composto.proveniencia.situacaoAtual === 'function' ? composto.proveniencia.situacaoAtual() : null; } catch { viva = null; }
  const fases = [faseNaSaida, ...(viva === null ? [] : [viva.fasePublicacao])];
  const publicadoFisicamente = pacotePublicado || (viva !== null && viva.publicada === true);
  const motivosDoCoordenador = r.coordenador ? r.coordenador.motivos : [];
  const sobCancelamento = motivosDoCoordenador.some((m) => ['ETAPA_EXPIRADA', 'CANCELAMENTO_NAO_CONFIRMADO', 'OPERACAO_PENDENTE', 'INTERROMPIDO'].includes(m));
  const motivosDaQuarentena = [];
  if (fases.includes('PUBLICANDO') || fases.includes('INDETERMINADA')) motivosDaQuarentena.push('PUBLICACAO_SEM_CONCLUSAO_CONHECIDA');
  if (r.publicacao && r.publicacao.estado === 'INCERTA') motivosDaQuarentena.push('PUBLICACAO_INCERTA');
  if (publicadoFisicamente && sobCancelamento) motivosDaQuarentena.push('PUBLICADO_SOB_CANCELAMENTO_OU_PENDENCIA');
  if (viva !== null && viva.operacoes !== null && viva.operacoes !== undefined && viva.operacoes.pendentes > 0) motivosDaQuarentena.push('OPERACAO_AINDA_PENDENTE');
  const emQuarentena = motivosDaQuarentena.length > 0;
  const janelaDoCoordenador = r.coordenador ? r.coordenador.janela : null;
  return Object.freeze({
    reconhecido: true,
    quarentena: Object.freeze({ recomendada: emQuarentena, motivos: Object.freeze(motivosDaQuarentena) }),
    recuperacaoAutorizadaDaTravaNecessaria: janelaDoCoordenador === 'RETIDA' || janelaDoCoordenador === 'NAO_LIBERADA',
    homologacaoTecnica: Object.freeze({ determinavelPeloCodigo: false, registro: 'EXTERNO_RELATORIO_HUMANO' }),
    correlacaoContratual,
    pacotePublicado,
    // BLOQUEIO EFETIVO (não só recomendação): pacote em quarentena nunca conta como publicação operacional nem como backup válido, ainda que as demais dimensões digam o contrário
    publicacaoOperacional: publicacaoOperacional && !emQuarentena,
    prontidaoOperacional,
    pendenciasDaProntidao: composto.prontidao.pendencias,
    coordenador: Object.freeze({ saida: r.coordenador ? r.coordenador.saida : null, valido: coordenadorValido }),
    backupOperacionalValido: derivarBackupOperacionalValido({ prontidaoOperacional, coordenadorValido, publicacaoOperacional, emQuarentena }),
    recuperabilidadeComprovada: false,
    motivoDaRecuperabilidade: 'SEM_RESTAURACAO_REAL_PROVADA_PELO_CODIGO',
    hashDoDumpIndependente: false,
    hashDoDump: Object.freeze({ capturadoNoFluxo: composto.proveniencia.hashDoDump.SHA256_FLUXO_RECEBIDO !== null, fluxoCorrespondeAoArquivo: composto.proveniencia.hashDoDump.correspondem === true, atestaConteudoLogico: false }),
  });
}

function criarRestauracaoDeProducao(config) {
  let cfg;
  try {
    exigir(ehObjeto(config) && soChaves(config, ['postgres', 'politicaDeDestino', 'fonteDeChaves', 'criarConexaoDoBanco', 'prazos', 'portas', 'operacoes'], ['postgres', 'politicaDeDestino', 'fonteDeChaves', 'criarConexaoDoBanco', 'prazos']));
    // `operacoes` da restauração (opcional, DESLIGADO por omissão, sem valor padrão): { imagensMs?, consultaMs?, cortesiaMs? }, inteiros seguros positivos, ao menos um
    if (config.operacoes !== undefined) exigir(ehObjeto(config.operacoes) && Reflect.ownKeys(config.operacoes).length > 0 && soChaves(config.operacoes, ['imagensMs', 'consultaMs', 'cortesiaMs']) && Reflect.ownKeys(config.operacoes).every((k) => inteiroPositivo(config.operacoes[k])));
    validarPostgres(config.postgres, { precisaDump: false });
    exigir(ehFonteDeChaves(config.fonteDeChaves) && ehFuncao(config.criarConexaoDoBanco));
    const pol = config.politicaDeDestino;
    exigir(ehObjeto(pol) && chavesExatas(pol, ['prefixoDoBanco', 'hostsAutorizados', 'bancosProtegidos']) && Array.isArray(pol.hostsAutorizados) && Array.isArray(pol.bancosProtegidos));
    cfg = Object.freeze({
      pgRestore: config.postgres.pgRestore,
      politicaDeDestino: Object.freeze({ prefixoDoBanco: pol.prefixoDoBanco, hostsAutorizados: Object.freeze([...pol.hostsAutorizados]), bancosProtegidos: Object.freeze([...pol.bancosProtegidos]) }),
      fonteDeChaves: config.fonteDeChaves,
      criarConexaoDoBanco: config.criarConexaoDoBanco,
      prazos: validarPrazos(config.prazos),
      portas: validarPortas(config.portas),
      operacoes: config.operacoes === undefined ? null : Object.freeze({ ...config.operacoes }),
    });
    // valida a política cedo, pelos próprios construtores aprovados (TypeError genérico), sem lançar nada
    criarLancadorDeRestauracaoComSpawn({ spawn: () => {}, politicaDeDestino: cfg.politicaDeDestino });
  } catch {
    throw configuracaoInvalida();
  }

  async function restaurar(entrada) {
    exigir(ehObjeto(entrada) && chavesExatas(entrada, ['raizAutorizada', 'nome', 'imagens', 'destino']) && ehObjeto(entrada.destino));
    try { fs.accessSync(cfg.pgRestore, fs.constants.X_OK); } catch { throw dependenciaIndisponivel('PG_RESTORE'); }
    const { spawn, observarGrupo, temporizador } = portasEfetivas(cfg.portas);
    // identidade da EXECUÇÃO, emitida aqui (dentro da fronteira confiável) ANTES de qualquer lançamento; o chamador não a escolhe e ela acompanha controle, restaurador, consulta e sondas
    const execucao = emitirExecucaoDeRestauracao();
    // registro de operações DESTA restauração (só com `operacoes` configurado): imagens e conferência lógica passam a ser operações rastreadas; o `pg_restore` continua só sob o supervisor
    const registro = cfg.operacoes === null ? null : criarRegistroDeOperacoes({ temporizador, ...(cfg.operacoes.cortesiaMs === undefined ? {} : { cortesiaMs: cfg.operacoes.cortesiaMs }) });
    const controleDeRestauracao = registro === null ? null : Object.freeze({ registro, ...(cfg.operacoes.imagensMs === undefined ? {} : { imagensMs: cfg.operacoes.imagensMs }), ...(cfg.operacoes.consultaMs === undefined ? {} : { consultaMs: cfg.operacoes.consultaMs }) });
    // controle de processo próprio desta restauração (uso único) com o lançador de restauração e a política imposta
    const controle = criarControleDeProcesso({ spawn, observarGrupo, execucaoId: execucao.id, criarLancador: ({ spawn: s }) => criarLancadorDeRestauracaoComSpawn({ spawn: s, politicaDeDestino: cfg.politicaDeDestino }) });
    const restauradorDoBanco = criarRestauradorDoBanco({
      alvo: { executavel: cfg.pgRestore },
      lancador: controle.lancador,
      sistema: controle.sistema,
      temporizador,
      prazos: cfg.prazos,
      politicaDeDestino: cfg.politicaDeDestino,
      execucaoId: execucao.id,
    });
    const adaptador = criarAdaptadorDeReferencias({ criarConexao: () => cfg.criarConexaoDoBanco(entrada.destino.banco) });
    const sonda = criarSondaDeInstancia({ criarConexao: () => cfg.criarConexaoDoBanco(entrada.destino.banco) });
    let consultaFeita = null;
    const restaurador = criarRestaurador({
      fonteDeChaves: cfg.fonteDeChaves,
      execucaoId: execucao.id,
      restauradorDoBanco,
      consultaDeReferencias: { async consultar(contexto) { consultaFeita = await adaptador.consultar(contexto); return consultaFeita; } },
      ...(controleDeRestauracao === null ? {} : { controle: controleDeRestauracao }),
      // produção: o pacote precisa ter registro durável AUTENTICADO de publicação concluída (ausência de registro não é prova)
      exigirRegistroDePublicacao: true,
    });
    // Identidade física da instância ANTES da restauração, só para destino já AUTORIZADO pela política (nenhuma conexão a banco não autorizado)
    const autorizado = restauradorDoBanco.autorizarDestino(entrada.destino) === true;
    const instanciaAntes = autorizado ? await sonda.sondar({ banco: entrada.destino.banco, execucaoId: execucao.id }) : null;
    const r = await restaurador.restaurarPacote({ raizAutorizada: entrada.raizAutorizada, nome: entrada.nome, imagens: entrada.imagens, banco: { destino: entrada.destino } });
    // identidade do banco efetivamente restaurado, na mesma instância, só se a restauração concluiu
    const instanciaDepois = autorizado && r.ok === true ? await sonda.sondar({ banco: entrada.destino.banco, execucaoId: execucao.id }) : null;
    const processo = controle.situacao();
    const avaliacao = avaliarRestauracaoReal({ restauracao: r, processo, instanciaAntes, instanciaDepois, consulta: consultaFeita, destino: { banco: entrada.destino.banco, host: entrada.destino.host } });
    // Nenhuma prova de restauração enquanto houver operação rastreada pendente (conexão ou imagens que não assentaram), qualquer que seja o resto
    const pendencia = registro !== null && registro.pendentes().length > 0;
    const reconhecida = !pendencia && ehAvaliacaoReconhecida(avaliacao) && avaliacao.reconhecida === true;
    return Object.freeze({
      restauracao: r,
      proveniencia: Object.freeze({
        execucaoId: execucao.id, processoDoPgRestore: processo, origemDaChave: cfg.fonteDeChaves.origem, instanciaAntes, instanciaDepois, consulta: consultaFeita, avaliacao,
        operacoes: registro === null ? null : registro.resumo(),
        /** Leitura FRESCA (resultado tardio de uma operação abandonada); só códigos fixos. */
        situacaoAtual: () => Object.freeze({ operacoes: registro === null ? null : registro.resumo() }),
      }),
      // Estados DERIVADOS da proveniência (nunca de afirmações do chamador): sem prova genuína de todos os itens ficam falsos; a recuperabilidade em produção NÃO é determinada por uma restauração.
      estado: Object.freeze({ restauracaoReal: reconhecida, consistenciaLogicaVerificada: reconhecida, recuperavelEmProducao: false, publicacaoOperacional: false }),
    });
  }

  return Object.freeze({ restaurar });
}

module.exports = { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup, derivarBackupOperacionalValido };
