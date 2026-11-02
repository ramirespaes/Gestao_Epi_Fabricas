'use strict';

const { hostSintaticamenteValido, socketFisicoSeguro } = require('./imagem-backup-host-postgres');
const crypto = require('node:crypto');
const { SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('./imagem-backup.service');
const { executarBackupOperacional } = require('./imagem-backup-operacional.service');
const { criarObservadorDoDump, ID_DA_OPERACAO } = require('./imagem-backup-evidencia-dump.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-PGDUMP-SNAPSHOT-1): CONSTRUTOR da descrição supervisionada do `pg_dump` e COMPOSIÇÃO com a
 * entrada operacional. Contrato PROVISÓRIO: não executa pg_dump, restauração nem backup reais, e `recuperavel` é SEMPRE false. As dependências
 * `lancador`, `sistema` e `arquivos` são infraestrutura injetável só para este contrato e para os testes: este módulo NÃO pode ser ligado a rota, API,
 * interface, agendador ou execução real sem uma composição protegida que escolha internamente o binário, as credenciais e os recursos do sistema.
 *
 * `criarProcessoDoDump({ contexto, dump })`: síncrona e SEM efeito colateral (não cria arquivo nem processo); lança TypeError (sem ecoar valores) se o
 * contexto ou o `dump` forem inválidos. Devolve `{ iniciar, grupo, sinais, temporizador, prazos }` e mais nada, que é o que o supervisor consome.
 *   - o `snapshotId` e o banco vêm SÓ do `contexto`; o id é validado pelo formato do snapshot e NUNCA normalizado; o nome do banco só vale se casar com
 *     /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/ (decisão de segurança desta integração, NÃO a lista de nomes aceitos pelo PostgreSQL): `pg_dump --dbname`
 *     interpreta URI e pares chave=valor como string de conexão, então nada com `=`, `/`, `:`, `@`, `?`, `%`, aspas, barra invertida ou controle passa;
 *   - nome E oid do banco do snapshot precisam ser iguais ao `bancoEsperado` (o nome sozinho não prova a identidade, e nem o par prova o cluster);
 *   - `Object.freeze` do contexto é só uma exigência auxiliar, NÃO prova a origem: a origem só é garantida pela composição abaixo.
 *   - `iniciar()` (uma vez só): cria o arquivo de saída por `arquivos.criarExclusivo` (0600, sem seguir links, sem sobrescrever) ANTES de lançar; só então
 *     lança o processo SEM shell, em grupo próprio, com a lista fechada de argumentos (`--format=custom`, `--no-password`, `--snapshot=<id>`,
 *     `--dbname=<nome>`), ambiente restrito a PGPASSFILE, PGHOST, PGPORT e PGUSER (nada do ambiente do pai; nenhuma senha) e stdio
 *     `['ignore', descritor, 'ignore']` (o stderr é DESCARTADO só nesta fase provisória). Falhas viram erros com mensagem fixa e, no máximo, um código
 *     seguro; o descritor é fechado uma única vez: na falha do lançamento ou ao fim dos fluxos do processo (nunca só pelo `exit`).
 *   - `grupo.vivos` e `sinais.enviar` só valem para o pgid devolvido pelo lançador (pid inteiro > 1); sinais permitidos: SIGINT, SIGTERM e SIGKILL;
 *     antes de iniciar não existe pgid, e nada chega ao sistema. Resposta do grupo que não seja true/false nunca vira "vazio".
 *
 * `executarBackupPgDump({ janela, conexao, dump, copia, avaliar, parada? })` (ESTRITO): valida e captura o `dump` ANTES da trava (saída 2, sem efeito) e
 * delega a `executarBackupOperacional`, cujo `processoDoDump` é SEMPRE o construtor acima, alimentado só pelo contexto do snapshot aberto nesta operação.
 * `processoDoDump`, `snapshot`, `finalizar`, `supervisionar`, `etapas`, `contexto` e `snapshotId` não existem nesta interface (chave desconhecida = saída 2).
 * Uma recusa DEPOIS do snapshot aberto (banco divergente, falha ao criar o arquivo, ao lançar...) retém a trava (regra conservadora do coordenador).
 *
 * CAPTURA (TOCTOU): os valores de configuração (alvo, destino, prazos) e os MÉTODOS de `lancador`, `sistema`, `arquivos` e `temporizador` são lidos UMA vez
 * na captura, validados como função e guardados em wrappers que os chamam com o `this` do objeto de origem, sem reler a propriedade. O que o lançador e o
 * sistema de arquivos devolvem (`pid`, `saida`, `fluxosFechados`, `descritor`, `fechar`) também é lido uma única vez. Erros públicos nunca carregam mensagem
 * de getter ou de dependência: a validação interna é reconhecida por identidade privada (WeakSet), não pelo texto, e `code` é lido uma vez e só vale se tiver
 * formato seguro.
 * LIMITES REMANESCENTES (não é proteção TOCTOU absoluta): o `this` continua sendo o objeto original, cujo ESTADO INTERNO o chamador ainda pode mudar;
 * a composição operacional confiável futura deve escolher esses recursos internamente. PID INVÁLIDO: se o lançador devolver pid inválido depois de talvez
 * ter iniciado o processo, nada prova que ele não iniciou e a supervisão não assume o controle; o descritor do pai é fechado, nada é sinalizado por
 * presunção e a trava fica retida (D1). BLOQUEIO PRÉ-OPERACIONAL de alta severidade (TODO PGD-12m): o lançador real precisa de contrato próprio.
 * Fora do escopo: proteção contra reutilização de PGID, identidade do binário, diagnóstico seguro do stderr, componentes ancestrais do caminho.
 */

const TOPO = new Set(['janela', 'conexao', 'dump', 'copia', 'avaliar', 'parada', 'operacao', 'verificadorEstrutural', 'controle']);
const CHAVES_DO_DUMP = ['alvo', 'destino', 'lancador', 'sistema', 'arquivos', 'temporizador', 'prazos'];
// `saida` é OPCIONAL e fechada: ausente = o pg_dump escreve direto no descritor (contrato anterior); 'PIPE_COM_HASH' = os bytes saem pelo STDOUT, passam pela captura (SHA-256 incremental + gravação íntegra + fsync) e o arquivo exclusivo é só o destino da captura.
const MODOS_DE_SAIDA = new Set(['DESCRITOR', 'PIPE_COM_HASH']);
const chavesDoDumpValidas = (dump) => {
  const proprias = Reflect.ownKeys(dump);
  const comSaida = proprias.includes('saida');
  return chavesExatas(dump, comSaida ? [...CHAVES_DO_DUMP, 'saida'] : CHAVES_DO_DUMP) && (!comSaida || (typeof dump.saida === 'string' && MODOS_DE_SAIDA.has(dump.saida)));
};
const CHAVES_DO_ALVO = ['executavel', 'host', 'porta', 'usuario', 'arquivoDeSenha', 'bancoEsperado'];
const CHAVES_DO_DESTINO = ['diretorio', 'nome'];
const CHAVES_DOS_PRAZOS = ['totalMs', 'cortesiaMs', 'intervaloGrupoMs', 'tentativasGrupo', 'consultaGrupoMs'];
const SINAIS_PERMITIDOS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);

const FORMATO_SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/;
const NOME_DE_BANCO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const NOME_DO_ARQUIVO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CODIGO_SEGURO = /^[A-Z][A-Z0-9_]{1,30}$/;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const inteiroPositivo = (valor) => Number.isSafeInteger(valor) && valor > 0;
/** Erros de validação PRÓPRIOS deste módulo, reconhecidos por identidade privada (nunca pelo texto da mensagem). */
const errosDeValidacao = new WeakSet();
function invalido(assunto) {
  const erro = new TypeError(`${assunto} inválido`);
  errosDeValidacao.add(erro);
  return erro;
}
/** O que sai para o chamador: o erro de validação próprio, ou um genérico; a mensagem de getters e dependências nunca passa. */
const publico = (falha) => (errosDeValidacao.has(falha) ? falha : invalido('dump'));
const ehPromessa = (valor) => valor !== null && (typeof valor === 'object' || typeof valor === 'function') && ehFuncao(valor.then);

/** As chaves próprias (inclusive símbolos e não enumeráveis) são exatamente as esperadas. */
function chavesExatas(objeto, esperadas) {
  const proprias = Reflect.ownKeys(objeto);
  return proprias.length === esperadas.length && proprias.every((chave) => typeof chave === 'string' && esperadas.includes(chave));
}

function caminhoAbsolutoCanonico(valor) {
  if (typeof valor !== 'string' || valor.length < 2 || valor.length > 4096 || valor[0] !== '/') return false;
  return valor.slice(1).split('/').every((parte) => SEGMENTO.test(parte) && parte !== '.' && parte !== '..');
}

/** Erro com mensagem fixa e, no máximo, um código seguro: nunca a mensagem, o caminho ou o detalhe do erro original. */
function falhaSegura(falha) {
  let codigo = null;
  try {
    // `code` é lido UMA vez (um getter pode mudar ou lançar entre leituras) e só vale se tiver o formato seguro.
    const lido = falha !== null && typeof falha === 'object' ? falha.code : undefined;
    if (typeof lido === 'string' && CODIGO_SEGURO.test(lido)) codigo = lido;
  } catch {
    codigo = null;
  }
  const erro = new Error('falha no dump');
  if (codigo !== null) erro.code = codigo;
  return erro;
}

/** Valida e COPIA a configuração do dump numa passada só (cada propriedade lida uma vez). Lança TypeError sem ecoar valores. */
function capturarDump(dump) {
  try {
    if (!ehObjeto(dump) || !chavesDoDumpValidas(dump)) throw invalido('dump');
    const { alvo, destino, lancador, sistema, arquivos, temporizador, prazos } = dump;
    const modoDeSaida = dump.saida === 'PIPE_COM_HASH' ? 'PIPE_COM_HASH' : 'DESCRITOR';

    if (!ehObjeto(alvo) || !chavesExatas(alvo, CHAVES_DO_ALVO)) throw invalido('alvo');
    const { executavel, host, porta, usuario, arquivoDeSenha, bancoEsperado } = alvo;
    if (!caminhoAbsolutoCanonico(executavel) || !executavel.endsWith('/pg_dump')) throw invalido('executável');
    if (!Number.isSafeInteger(porta) || porta < 1 || porta > 65535) throw invalido('porta');
    // nome de host OU diretório de socket Unix canônico cujo caminho completo (`/.s.PGSQL.<porta>`) cabe no limite do sistema; nunca host implícito
    if (hostSintaticamenteValido(host, porta) === null) throw invalido('host');
    if (typeof usuario !== 'string' || !USUARIO.test(usuario)) throw invalido('usuário');
    if (!caminhoAbsolutoCanonico(arquivoDeSenha)) throw invalido('arquivo de senha');
    if (!ehObjeto(bancoEsperado)) throw invalido('banco esperado');
    const { nome: nomeEsperado, oid: oidEsperado } = bancoEsperado;
    if (typeof nomeEsperado !== 'string' || !NOME_DE_BANCO.test(nomeEsperado) || typeof oidEsperado !== 'string' || !OID.test(oidEsperado)) throw invalido('banco esperado');

    if (!ehObjeto(destino) || !chavesExatas(destino, CHAVES_DO_DESTINO)) throw invalido('destino');
    const { diretorio, nome } = destino;
    if (!caminhoAbsolutoCanonico(diretorio)) throw invalido('diretório de destino');
    if (typeof nome !== 'string' || !NOME_DO_ARQUIVO.test(nome)) throw invalido('nome do arquivo');

    // Cada método é lido UMA vez e fica guardado (com o `this` de origem); nada é relido do objeto do chamador depois.
    if (!ehObjeto(lancador)) throw invalido('lançador');
    const lancar = lancador.lancar;
    if (!ehFuncao(lancar)) throw invalido('lançador');
    if (!ehObjeto(sistema)) throw invalido('sistema');
    const grupoVivo = sistema.grupoVivo;
    const enviarSinal = sistema.enviarSinal;
    if (!ehFuncao(grupoVivo) || !ehFuncao(enviarSinal)) throw invalido('sistema');
    if (!ehObjeto(arquivos)) throw invalido('arquivos');
    const criarExclusivo = arquivos.criarExclusivo;
    if (!ehFuncao(criarExclusivo)) throw invalido('arquivos');
    if (!ehObjeto(temporizador)) throw invalido('temporizador');
    const prazoDoTemporizador = temporizador.prazo;
    const intervaloDoTemporizador = temporizador.intervalo;
    if (!ehFuncao(prazoDoTemporizador) || !ehFuncao(intervaloDoTemporizador)) throw invalido('temporizador');

    if (!ehObjeto(prazos)) throw invalido('prazos');
    const copiaDosPrazos = {};
    for (const chave of CHAVES_DOS_PRAZOS) {
      const valor = prazos[chave];
      if (!inteiroPositivo(valor)) throw invalido('prazos');
      copiaDosPrazos[chave] = valor;
    }

    return Object.freeze({
      executavel,
      host,
      porta,
      usuario,
      arquivoDeSenha,
      bancoEsperado: Object.freeze({ nome: nomeEsperado, oid: oidEsperado }),
      diretorio,
      modoDeSaida,
      nomeDoArquivo: nome,
      lancar: (spec) => lancar.call(lancador, spec),
      grupoVivo: (pgid) => grupoVivo.call(sistema, pgid),
      enviarSinal: (pgid, sinal) => enviarSinal.call(sistema, pgid, sinal),
      criarExclusivo: (spec) => criarExclusivo.call(arquivos, spec),
      temporizador: Object.freeze({
        prazo: (...argumentos) => prazoDoTemporizador.apply(temporizador, argumentos),
        intervalo: (...argumentos) => intervaloDoTemporizador.apply(temporizador, argumentos),
      }),
      prazos: Object.freeze(copiaDosPrazos),
    });
  } catch (falha) {
    throw publico(falha); // leitura que lançou (por exemplo, um getter): nunca propaga a mensagem original
  }
}

/** O contexto vem do `abrir()` do snapshot: formato, congelamento (auxiliar) e identidade do banco. */
function validarContexto(contexto, configuracao) {
  try {
    if (!ehObjeto(contexto) || !Object.isFrozen(contexto)) throw invalido('contexto');
    const { snapshotId, banco } = contexto;
    if (typeof snapshotId !== 'string' || !FORMATO_SNAPSHOT.test(snapshotId)) throw invalido('identificador do snapshot');
    if (!ehObjeto(banco) || !Object.isFrozen(banco)) throw invalido('banco do snapshot');
    const { nome, oid } = banco;
    if (typeof nome !== 'string' || !NOME_DE_BANCO.test(nome) || typeof oid !== 'string' || !OID.test(oid)) throw invalido('banco do snapshot');
    if (nome !== configuracao.bancoEsperado.nome || oid !== configuracao.bancoEsperado.oid) throw invalido('banco do snapshot');
    return { snapshotId, nome };
  } catch (falha) {
    throw publico(falha);
  }
}

function construir(contexto, configuracao) {
  const { snapshotId, nome: nomeDoBanco } = validarContexto(contexto, configuracao);

  let pgid = null;
  let iniciada = false;
  let fecharArquivo = null; // o `fechar` lido UMA vez do arquivo criado, já ligado ao seu `this`; nulo = nada aberto ou já fechado

  const fecharDescritor = () => {
    if (fecharArquivo === null) return;
    const fechar = fecharArquivo;
    fecharArquivo = null;
    try { fechar(); } catch { /* o fechamento é melhor esforço; nada do erro é propagado */ }
  };

  async function iniciar() {
    if (iniciada) throw falhaSegura(null);
    iniciada = true;

    // socket Unix: o diretório é conferido no disco (real, próprio, privado) ANTES de qualquer arquivo ou processo
    if (!socketFisicoSeguro(configuracao.host, configuracao.porta)) throw falhaSegura(null);
    let criado;
    try {
      criado = await configuracao.criarExclusivo({ diretorio: configuracao.diretorio, nome: configuracao.nomeDoArquivo, modo: 0o600, semSeguirLinks: true });
    } catch (falha) {
      throw falhaSegura(falha);
    }
    // Campos do arquivo criado: lidos UMA vez; só os valores lidos valem daqui em diante.
    let descritor;
    let fechar;
    try {
      if (ehObjeto(criado)) {
        descritor = criado.descritor;
        fechar = criado.fechar;
      }
    } catch {
      throw falhaSegura(null);
    }
    if (!Number.isSafeInteger(descritor) || descritor < 0 || !ehFuncao(fechar)) throw falhaSegura(null);
    fecharArquivo = () => fechar.call(criado);

    const spec = Object.freeze({
      executavel: configuracao.executavel,
      argumentos: Object.freeze(['--format=custom', '--no-password', `--snapshot=${snapshotId}`, `--dbname=${nomeDoBanco}`]),
      ambiente: Object.freeze({
        PGPASSFILE: configuracao.arquivoDeSenha,
        PGHOST: configuracao.host,
        PGPORT: String(configuracao.porta),
        PGUSER: configuracao.usuario,
      }),
      opcoes: Object.freeze({ shell: false, detached: true, stdio: Object.freeze(configuracao.modoDeSaida === 'PIPE_COM_HASH' ? ['ignore', 'pipe', 'pipe'] : ['ignore', descritor, 'ignore']) }),
      // modo PIPE: o descritor do arquivo exclusivo NÃO vai ao processo; é o destino da captura que o lançador liga ao stdout
      ...(configuracao.modoDeSaida === 'PIPE_COM_HASH' ? { saida: Object.freeze({ descritor }) } : {}),
    });

    let processo;
    try {
      processo = await configuracao.lancar(spec);
    } catch (falha) {
      fecharDescritor();
      throw falhaSegura(falha);
    }
    // Campos do processo: lidos UMA vez. Resposta inválida NÃO prova que o processo não iniciou (bloqueio pré-operacional, TODO PGD-12m): nada é sinalizado.
    let pid;
    let saida;
    let fluxos;
    try {
      if (ehObjeto(processo)) {
        pid = processo.pid;
        saida = processo.saida;
        fluxos = processo.fluxosFechados;
      }
    } catch {
      pid = undefined;
    }
    if (!(Number.isSafeInteger(pid) && pid > 1 && ehPromessa(saida) && ehPromessa(fluxos))) {
      fecharDescritor();
      throw falhaSegura(null);
    }

    pgid = pid;
    // O descritor só é fechado quando os FLUXOS do processo fecham (o evento de saída isolado não prova nada).
    const fluxosFechados = Promise.resolve(fluxos).then(
      () => { fecharDescritor(); },
      (falha) => { fecharDescritor(); throw falhaSegura(falha); },
    );
    return { pgid, saida, fluxosFechados };
  }

  const grupo = Object.freeze({
    async vivos(pgidConsultado) {
      if (pgid === null || pgidConsultado !== pgid) throw falhaSegura(null);
      let resposta;
      try {
        resposta = await configuracao.grupoVivo(pgid);
      } catch (falha) {
        throw falhaSegura(falha);
      }
      if (resposta !== true && resposta !== false) throw falhaSegura(null);
      return resposta;
    },
  });

  const sinais = Object.freeze({
    async enviar(pgidAlvo, sinal) {
      if (pgid === null || pgidAlvo !== pgid || typeof sinal !== 'string' || !SINAIS_PERMITIDOS.has(sinal)) return false;
      try {
        return (await configuracao.enviarSinal(pgid, sinal)) === true;
      } catch {
        return false;
      }
    },
  });

  return Object.freeze({
    iniciar,
    grupo,
    sinais,
    temporizador: configuracao.temporizador,
    prazos: configuracao.prazos,
  });
}

function criarProcessoDoDump(argumentos) {
  try {
    if (!ehObjeto(argumentos) || !chavesExatas(argumentos, ['contexto', 'dump'])) throw invalido('argumentos');
    const { contexto, dump } = argumentos;
    return construir(contexto, capturarDump(dump));
  } catch (falha) {
    throw publico(falha);
  }
}

function recusa() {
  return Object.freeze({
    saida: SAIDAS.ARGUMENTOS,
    valido: false,
    recuperavel: false,
    janela: ESTADOS_DA_JANELA.NAO_ADQUIRIDA,
    etapasExecutadas: Object.freeze([]),
    motivos: Object.freeze([]),
    sinal: null,
    finalizacao: ESTADOS_DA_FINALIZACAO.NAO_APLICAVEL,
    supervisao: null,
  });
}

/**
 * E1: identidade da operação, criada ou validada ANTES de qualquer efeito (trava, snapshot, disco). `operacao`, se presente, é `{ id? }` estrito; sem `id`, o serviço gera um (UUID aleatório do Node).
 * O identificador textual identifica a execução; NÃO a autentica nem a autoriza.
 */
function identidadeDaOperacao(dependencias) {
  if (!Object.hasOwn(dependencias, 'operacao')) return crypto.randomUUID();
  const operacao = dependencias.operacao;
  if (!ehObjeto(operacao) || !Reflect.ownKeys(operacao).every((chave) => chave === 'id')) throw invalido('operação');
  if (!Object.hasOwn(operacao, 'id')) return crypto.randomUUID();
  const id = operacao.id;
  if (typeof id !== 'string' || !ID_DA_OPERACAO.test(id)) throw invalido('identidade da operação');
  return id;
}

async function executarBackupPgDump(dependencias) {
  let entrada;
  try {
    if (!ehObjeto(dependencias) || !Reflect.ownKeys(dependencias).every((chave) => typeof chave === 'string' && TOPO.has(chave))) return recusa();
    const operacaoId = identidadeDaOperacao(dependencias);
    // E3': o observador do dump é criado AQUI (um só por operação) em volta de `arquivos` e `lancador`, que são lidos UMA vez; o contrato dos dois não muda.
    const dumpBruto = dependencias.dump;
    if (!ehObjeto(dumpBruto) || !chavesDoDumpValidas(dumpBruto)) throw invalido('dump');
    const observador = criarObservadorDoDump({ arquivos: dumpBruto.arquivos, lancador: dumpBruto.lancador, operacaoId });
    const configuracao = capturarDump({ ...dumpBruto, arquivos: observador.arquivos, lancador: observador.lancador });
    entrada = {
      janela: dependencias.janela,
      conexao: dependencias.conexao,
      copia: dependencias.copia,
      avaliar: dependencias.avaliar,
      // O dump é SEMPRE o do construtor, alimentado só pelo contexto do snapshot aberto nesta operação.
      processoDoDump: (contexto) => construir(contexto, configuracao),
      // Marco C: o verificador estrutural, se houver, precisa ser o PRODUZIDO por `criarVerificadorEstrutural` (o executor revalida); sem ele a estrutura consta como NÃO EXECUTADA.
      integracao: Object.freeze({ operacaoId, observador, ...(Object.hasOwn(dependencias, 'verificadorEstrutural') ? { verificadorEstrutural: dependencias.verificadorEstrutural } : {}) }),
    };
    if (Object.hasOwn(dependencias, 'parada')) entrada.parada = dependencias.parada;
    // P2/P3 (opcional): `controle` (registro de operações) segue ao entrypoint operacional, que o confere antes da trava.
    if (Object.hasOwn(dependencias, 'controle')) entrada.controle = dependencias.controle;
  } catch {
    return recusa();
  }
  return executarBackupOperacional(entrada);
}

module.exports = { criarProcessoDoDump, executarBackupPgDump };
