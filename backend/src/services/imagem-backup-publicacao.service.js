'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { reconhecerCorrelacao, avaliarCorrelacao, estruturaVerificada } = require('./imagem-backup-correlacao.service');
const { lerManifesto } = require('./imagem-backup-manifesto.service');
const { ehAutenticacaoReconhecida } = require('./imagem-backup-manifesto-autenticado.service');
const { ehAutenticacaoL2 } = require('./backup-fontes-manifesto-l2.service'); // P6: autenticação do manifesto layout 2 (leitor L2 injetado)
const { ehFaltaDeEspaco, ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');
const { criarRegistroDePublicacao } = require('./imagem-backup-registro-publicacao.service');

const lerNoDescritor = promisify(fs.read);

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MARCO C): PACOTE COMPLETO, CONSISTÊNCIA e PUBLICAÇÃO ATÔMICA E DURÁVEL (preparação técnica). Contrato PROVISÓRIO, para chamador confiável. NENHUMA publicação
 * operacional real é executada por este módulo: o destino é uma raiz injetada, sem configuração de produção, e o relatório operacional não tem produtor reconhecido, então a publicação operacional permanece BLOQUEADA.
 *
 * PACOTE (layout dentro da preparação já selada): `imagens/<chave>` (cópia verificada), `manifesto.json`, `manifesto.sha256` (selagem) e `dump/postgres.dump` (o dump incorporado). O manifesto e a selagem existentes NÃO mudam de
 * formato: o `dump` do manifesto já registra { bytes, sha256 }, e é contra ele (e contra T1) que o dump incorporado é conferido. A selagem cobre o manifesto, não os demais arquivos; a integridade do pacote vem de `verificarPacote`.
 *  - `incorporarDump({ preparacao, artefato, manifesto })`: copia o artefato identificado por T1 (descritor aberto pelo observador, com `dev/ino` conferidos) para `dump/postgres.dump` por criação EXCLUSIVA (0600, sem seguir link), conta e
 *    confere bytes/SHA-256 durante a escrita (com `orcamento` opcional, reserva `artefato.bytes` por inteiro ANTES de qualquer efeito: `LIMITE_TOTAL_EXCEDIDO` sem criar nada; a reserva não é devolvida se a escrita falhar depois), fsync do arquivo e RELEITURA independente do arquivo incorporado (tipo, `dev/ino` do caminho = do descritor criado, tamanho, SHA-256 contra T1 e contra o manifesto).
 *  - `verificarPacote({ preparacao, manifesto, identidade })`: o conjunto de arquivos é EXATAMENTE o esperado (nem faltante nem extra, sem link), e cada arquivo é relido (tamanho e SHA-256 contra o manifesto; `manifesto.json` contra o digest
 *    da selagem verificada; `manifesto.sha256` coerente; dump contra o manifesto).
 *  - `avaliarConsistencia({ operacaoId, itensDoPlano, composicao, verificacao })`: a consistência PLANO DO SNAPSHOT x CÓPIA PRESERVADA (contagem igual, cópia classificada INTEGRA; os hashes já foram impostos por `construirManifesto`). NÃO prova
 *    ausência de escritores externos, de remoção física fora da trava, nem consistência temporal do banco além do snapshot; os `limites` constam na evidência.
 *  - `persistirPacote({ preparacao })`: fsync de TODOS os arquivos e, de baixo para cima, de TODOS os diretórios do pacote.
 *  Evidências retornadas são congeladas e RECONHECIDAS por este módulo (WeakSet); falhas devolvem { ok:false, motivo } com motivo fixo, sem caminho, e NUNCA removem nada (a preparação não publicada fica reservada).
 *
 * PUBLICAÇÃO: `criarPublicador({ raizDoDestino, produtorDeRelatorio, origensAceitas?, ops? })` (ESTRITO). `publicar({ preparacao, nomeFinal, correlacao, pacote, consistencia })` só publica depois de TODAS as portas, na ordem:
 *  (1) correlação do CONJUNTO reconhecida e satisfeita (T2 ok, supervisão concluída, manifesto selado e verificado); (2) estrutura verificada para o MESMO artefato/operação; (3) pacote verificado e do MESMO manifesto/dump; (4) consistência demonstrada
 *  da mesma operação; (5) relatório operacional com procedência: `produtorDeRelatorio` precisa devolver { ok:true, origem, operacaoId } com origem em `origensAceitas` (padrão ['OPERACIONAL'], origem que HOJE ninguém produz) e a mesma operação;
 *  (6) destino: raiz canônica existente e fora da preparação, nome final válido, destino inexistente; (7) persistência: fsync dos arquivos e diretórios + nova verificação do pacote; (8) publicação: `mkdir` exclusivo do nome final (colisão = recusa)
 *  e `rename` atômico da preparação sobre ele; (9) fsync do diretório de destino. Falha antes do rename: nada publicado, preparação preservada, pacotes anteriores intocados. Falha de rename: só o diretório reservado VAZIO que este módulo criou é
 *  removido (`rmdir` falha se não estiver vazio). Falha do fsync do destino depois do rename: tenta reverter o rename; sem reversão comprovada o estado é INCERTA e nada é apagado. O pacote anterior (outro nome) nunca é tocado.
 *
 * REGISTRO DURÁVEL (`imagem-backup-registro-publicacao.service.js`): a INTENÇÃO é gravada ANTES do `rename` (sem ela, nada é publicado: `INTENCAO_NAO_REGISTRADA`); a CONCLUSÃO só DEPOIS do `rename` e do `fsync` do destino e sem pedido de cancelamento (`sinal` opcional); falha ao registrar a conclusão = INCERTA; INCERTA e
 * "publicado sob cancelamento" gravam a QUARENTENA durável. Um pacote só é admissível com a conclusão (prova positiva): a ausência de marcador nunca prova publicação válida. A evidência traz `quarentena: { necessaria, registrada }` quando uma quarentena era necessária; `registrada:false` obriga o chamador a manter a trava RETIDA.
 *
 * LIMITES: o produtor de relatório injetado é decisão da composição confiável (nos testes, um produtor CONTROLADO de origem TESTE_CONTROLADO aceito explicitamente); a marca (WeakSet) prova origem em processo, não autorização operacional; rename atômico e fsync
 * de diretório dependem do sistema de arquivos local; `rename` entre sistemas de arquivos falha (EXDEV) e é recusado; não há trava distribuída de destino, durabilidade de mídia, replicação, restauração nem recuperabilidade.
 */

const ARQUIVO_DO_DUMP = 'postgres.dump';
const PASTA_DO_DUMP = 'dump';
const NOME_FINAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const BLOCO = 1024 * 1024;
const LIMITES_DA_CONSISTENCIA = Object.freeze(['NAO_PROVA_AUSENCIA_DE_ESCRITORES_EXTERNOS', 'NAO_PROVA_REMOCAO_FISICA_FORA_DA_TRAVA', 'NAO_PROVA_CONSISTENCIA_TEMPORAL_ALEM_DO_SNAPSHOT']);

const marcadas = new WeakSet();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const invalido = () => new TypeError('parâmetros do pacote inválidos');

function evidencia(dados) {
  const e = Object.freeze(dados);
  marcadas.add(e);
  return e;
}
const recusa = (motivo, extra = {}) => evidencia({ ok: false, motivo, ...extra });
const ehEvidenciaDoPacote = (v) => v !== null && typeof v === 'object' && marcadas.has(v);

const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const numero = (valor) => (typeof valor === 'bigint' ? (valor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(valor) : valor.toString()) : valor);

/** Operações de sistema de arquivos usadas pelo pacote e pela publicação (padrão = fs real). Injetáveis só para provocar falhas nos testes. */
const OPS_PADRAO = Object.freeze({
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  mkdir: (p, modo) => fsp.mkdir(p, { mode: modo }),
  rmdir: (p) => fsp.rmdir(p),
  rename: (de, para) => fsp.rename(de, para),
  abrir: (p, flags, modo) => fsp.open(p, flags, modo),
  escrever: (h, buffer, deslocamento, tamanho, posicao) => h.write(buffer, deslocamento, tamanho, posicao),
  fsyncArquivo: (h) => h.sync(),
  fsyncDiretorio: async (p) => {
    const h = await fsp.open(p, fs.constants.O_RDONLY);
    try { await h.sync(); } finally { await h.close(); }
  },
});
const OPERACOES = Object.keys(OPS_PADRAO);
function completarOps(ops) {
  if (ops === undefined) return OPS_PADRAO;
  if (!ehObjeto(ops) || !Reflect.ownKeys(ops).every((k) => typeof k === 'string' && OPERACOES.includes(k)) || !Object.values(ops).every(ehFuncao)) throw invalido();
  return Object.freeze({ ...OPS_PADRAO, ...ops });
}

const RDONLY_SEM_LINK = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const CRIAR_EXCLUSIVO = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

async function hashDoArquivo(ops, caminho) {
  const h = await ops.abrir(caminho, RDONLY_SEM_LINK);
  try {
    const estado = await h.stat({ bigint: true });
    if (!estado.isFile()) return null;
    const tamanho = Number(estado.size);
    const hash = crypto.createHash('sha256');
    const bloco = Buffer.allocUnsafe(Math.max(1, Math.min(BLOCO, tamanho)));
    let lidos = 0;
    while (lidos < tamanho) {
      const { bytesRead } = await h.read(bloco, 0, Math.min(bloco.length, tamanho - lidos), lidos);
      if (bytesRead === 0) return null;
      hash.update(bloco.subarray(0, bytesRead));
      lidos += bytesRead;
    }
    return { bytes: tamanho, sha256: hash.digest('hex'), dev: estado.dev, ino: estado.ino };
  } finally {
    await h.close().catch(() => {});
  }
}

async function diretorioReal(ops, caminho) {
  try {
    const estado = await ops.lstat(caminho);
    return estado.isDirectory() && !estado.isSymbolicLink() && fs.realpathSync(caminho) === caminho;
  } catch {
    return false;
  }
}

/** Percorre a árvore: { arquivos: [relativo], diretorios: [relativo], invalida: bool }. Qualquer link ou tipo estranho invalida. */
async function percorrer(ops, raiz) {
  const arquivos = [];
  const diretorios = [''];
  let invalida = false;
  const fila = [''];
  while (fila.length > 0) {
    const relativo = fila.shift();
    const entradas = await ops.readdir(path.join(raiz, relativo));
    for (const entrada of entradas) {
      const rel = relativo === '' ? entrada.name : `${relativo}/${entrada.name}`;
      if (entrada.isSymbolicLink()) invalida = true;
      else if (entrada.isDirectory()) { diretorios.push(rel); fila.push(rel); } else if (entrada.isFile()) arquivos.push(rel);
      else invalida = true;
    }
  }
  return { arquivos: arquivos.sort(), diretorios: diretorios.sort(), invalida };
}

function criarServicoDePacote(opcoes = {}) {
  const ops = completarOps(opcoes.ops);

  async function incorporarDump(entrada) {
    // `orcamento` (opcional): o orçamento de bytes da execução; a incorporação é a SEGUNDA cópia física do dump e é reservada por inteiro ANTES de qualquer efeito
    const comOrcamento = ehObjeto(entrada) && Reflect.ownKeys(entrada).includes('orcamento');
    if (!ehObjeto(entrada) || !chavesExatas(entrada, comOrcamento ? ['preparacao', 'artefato', 'manifesto', 'orcamento'] : ['preparacao', 'artefato', 'manifesto'])) throw invalido();
    if (comOrcamento && !ehOrcamentoDeBytes(entrada.orcamento)) throw invalido();
    const { preparacao, artefato, manifesto } = entrada;
    const orcamento = comOrcamento ? entrada.orcamento : null;
    if (!caminhoAbsolutoCanonico(preparacao) || !ehObjeto(artefato) || artefato.ok !== true || !Number.isSafeInteger(artefato.descritor) || !Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0
      || typeof artefato.sha256 !== 'string' || !SHA256.test(artefato.sha256) || !ehObjeto(manifesto) || !ehObjeto(manifesto.dump)) throw invalido();
    if (manifesto.dump.bytes !== artefato.bytes || manifesto.dump.sha256 !== artefato.sha256) return recusa('MANIFESTO_DIVERGE_DO_DUMP');
    if (!(await diretorioReal(ops, preparacao))) return recusa('PREPARACAO_INVALIDA');
    // Reserva TUDO OU NADA (BigInt, sem soma que estoure) antes de criar pasta ou arquivo: sem saldo, nenhum efeito. A reserva não é devolvida se a escrita falhar depois (o parcial fica preservado e continua ocupando espaço).
    if (orcamento !== null && orcamento.reservar(artefato.bytes).ok !== true) return recusa('LIMITE_TOTAL_EXCEDIDO');

    const pasta = path.join(preparacao, PASTA_DO_DUMP);
    const alvo = path.join(pasta, ARQUIVO_DO_DUMP);
    try {
      await ops.mkdir(pasta, 0o700);
    } catch (falha) {
      return recusa(falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU');
    }

    let h;
    let criado;
    try {
      h = await ops.abrir(alvo, CRIAR_EXCLUSIVO, 0o600);
      criado = await h.stat({ bigint: true });
    } catch (falha) {
      return recusa(falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU');
    }
    try {
      const hash = crypto.createHash('sha256');
      const bloco = Buffer.allocUnsafe(Math.min(BLOCO, artefato.bytes));
      let posicao = 0;
      while (posicao < artefato.bytes) {
        const quero = Math.min(bloco.length, artefato.bytes - posicao);
        const { bytesRead } = await lerNoDescritor(artefato.descritor, bloco, 0, quero, posicao);
        if (bytesRead === 0) return recusa('ARTEFATO_TRUNCADO');
        hash.update(bloco.subarray(0, bytesRead));
        let escritos = 0;
        while (escritos < bytesRead) {
          const { bytesWritten } = await ops.escrever(h, bloco, escritos, bytesRead - escritos, posicao + escritos);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) return recusa('ESCRITA_FALHOU');
          escritos += bytesWritten;
        }
        posicao += bytesRead;
      }
      const { bytesRead: excesso } = await lerNoDescritor(artefato.descritor, Buffer.allocUnsafe(1), 0, 1, posicao);
      if (excesso !== 0) return recusa('ARTEFATO_CRESCEU');
      if (hash.digest('hex') !== artefato.sha256) return recusa('DUMP_DIVERGENTE');
      try { await ops.fsyncArquivo(h); } catch (falha) { return recusa(ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'FSYNC_FALHOU'); }
    } catch (falha) {
      return recusa(ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU');
    } finally {
      await h.close().catch(() => {});
    }

    // Releitura independente do arquivo incorporado.
    let relido;
    try {
      relido = await hashDoArquivo(ops, alvo);
      const noCaminho = await ops.lstat(alvo);
      if (relido === null || !noCaminho.isFile() || noCaminho.dev !== criado.dev || noCaminho.ino !== criado.ino || relido.dev !== criado.dev || relido.ino !== criado.ino) return recusa('DUMP_SUBSTITUIDO');
    } catch {
      return recusa('RELEITURA_FALHOU');
    }
    if (relido.bytes !== artefato.bytes || relido.sha256 !== artefato.sha256 || relido.sha256 !== manifesto.dump.sha256 || relido.bytes !== manifesto.dump.bytes) return recusa('DUMP_INCORPORADO_DIVERGENTE');
    return evidencia({ ok: true, origem: 'DUMP_INCORPORADO', bytes: relido.bytes, sha256: relido.sha256, identidade: Object.freeze({ dev: numero(criado.dev), ino: numero(criado.ino) }) });
  }

  async function verificarPacote(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['preparacao', 'manifesto', 'identidade'])) throw invalido();
    const { preparacao, manifesto, identidade } = entrada;
    const formaValida = ehObjeto(manifesto) && (manifesto.layout === 2 ? Array.isArray(manifesto.fontes) : Array.isArray(manifesto.arquivos));
    if (!caminhoAbsolutoCanonico(preparacao) || !formaValida || !ehObjeto(manifesto.dump) || !ehObjeto(identidade) || !SHA256.test(String(identidade.sha256Manifesto))) throw invalido();
    if (!(await diretorioReal(ops, preparacao))) return recusa('PREPARACAO_INVALIDA');

    let arvore;
    try { arvore = await percorrer(ops, preparacao); } catch { return recusa('LEITURA_FALHOU'); }
    if (arvore.invalida) return recusa('ENTRADA_INVALIDA');

    const esperados = new Map();
    // P6 (D-ORF-6): layout 2 = `arquivos/<fonteId>/<chave>` por fonte (manifesto L2 lido e autenticado pelo leitor injetado); layout 1 continua `imagens/<chave>`.
    if (manifesto.layout === 2) {
      if (!Array.isArray(manifesto.fontes)) throw invalido();
      for (const fonte of manifesto.fontes) {
        if (!ehObjeto(fonte) || typeof fonte.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(fonte.id) || !Array.isArray(fonte.arquivos)) throw invalido();
        for (const item of fonte.arquivos) esperados.set(`arquivos/${fonte.id}/${item.chave}`, { bytes: item.bytes, sha256: item.sha256 });
      }
    } else {
      for (const item of manifesto.arquivos) esperados.set(`imagens/${item.chave}`, { bytes: item.bytes, sha256: item.sha256 });
    }
    esperados.set('manifesto.json', { sha256: identidade.sha256Manifesto });
    esperados.set('manifesto.sha256', null);
    esperados.set(`${PASTA_DO_DUMP}/${ARQUIVO_DO_DUMP}`, { bytes: manifesto.dump.bytes, sha256: manifesto.dump.sha256 });
    for (const rel of esperados.keys()) if (!arvore.arquivos.includes(rel)) return recusa('ARQUIVO_AUSENTE');
    for (const rel of arvore.arquivos) if (!esperados.has(rel)) return recusa('ARQUIVO_EXTRA');

    try {
      for (const [rel, esperado] of esperados) {
        const caminho = path.join(preparacao, ...rel.split('/'));
        if (esperado === null) {
          const selo = await hashDoArquivo(ops, caminho);
          const texto = fs.readFileSync(caminho, 'utf8');
          if (selo === null || texto !== `${identidade.sha256Manifesto}  manifesto.json\n`) return recusa('SELO_DIVERGENTE');
          continue;
        }
        const lido = await hashDoArquivo(ops, caminho);
        if (lido === null) return recusa('ARQUIVO_AUSENTE');
        if (lido.sha256 !== esperado.sha256 || (esperado.bytes !== undefined && lido.bytes !== esperado.bytes)) return recusa(rel === 'manifesto.json' ? 'MANIFESTO_ADULTERADO' : 'ARQUIVO_DIVERGENTE');
      }
    } catch {
      return recusa('LEITURA_FALHOU');
    }
    return evidencia({
      ok: true,
      origem: 'PACOTE_VERIFICADO',
      arquivos: arvore.arquivos.length,
      sha256Manifesto: identidade.sha256Manifesto,
      dump: Object.freeze({ bytes: manifesto.dump.bytes, sha256: manifesto.dump.sha256 }),
    });
  }

  async function persistirPacote(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['preparacao']) || !caminhoAbsolutoCanonico(entrada.preparacao)) throw invalido();
    const { preparacao } = entrada;
    let arvore;
    try { arvore = await percorrer(ops, preparacao); } catch { return recusa('LEITURA_FALHOU'); }
    if (arvore.invalida) return recusa('ENTRADA_INVALIDA');
    try {
      for (const rel of arvore.arquivos) {
        const h = await ops.abrir(path.join(preparacao, ...rel.split('/')), RDONLY_SEM_LINK);
        try { await ops.fsyncArquivo(h); } finally { await h.close().catch(() => {}); }
      }
    } catch {
      return recusa('FSYNC_FALHOU', { alvo: 'ARQUIVO' });
    }
    try {
      for (const rel of [...arvore.diretorios].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1))) {
        await ops.fsyncDiretorio(rel === '' ? preparacao : path.join(preparacao, ...rel.split('/')));
      }
    } catch {
      return recusa('FSYNC_FALHOU', { alvo: 'DIRETORIO' });
    }
    return evidencia({ ok: true, origem: 'PACOTE_PERSISTIDO', arquivos: arvore.arquivos.length, diretorios: arvore.diretorios.length });
  }

  function avaliarConsistencia(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['operacaoId', 'itensDoPlano', 'composicao', 'verificacao'])) throw invalido();
    const { operacaoId, itensDoPlano, composicao, verificacao } = entrada;
    const criterios = Object.freeze({
      planoIgualAoManifesto: ehObjeto(composicao) && composicao.ok === true && Number.isSafeInteger(itensDoPlano) && itensDoPlano > 0 && composicao.arquivos === itensDoPlano,
      copiaIntegra: ehObjeto(verificacao) && verificacao.classe === 'INTEGRA',
    });
    return evidencia({ origem: 'CONSISTENCIA_PLANO_COPIA', demonstrada: Object.values(criterios).every((c) => c === true), operacaoId, criterios, limites: LIMITES_DA_CONSISTENCIA });
  }

  return Object.freeze({ incorporarDump, verificarPacote, persistirPacote, avaliarConsistencia, ops });
}

const SERVICO_PADRAO = criarServicoDePacote();
const publicadoresProduzidos = new WeakSet();
const produtoresProduzidos = new WeakSet();
const decisoesProduzidas = new WeakSet();

/**
 * PROVENIÊNCIA do relatório operacional: o publicador só aceita um produtor criado por `criarProdutorDeRelatorio` e, de cada decisão, apenas a que esse produtor reconhecido produziu (nunca um literal `{ ok, origem }`).
 * A origem `OPERACIONAL` NÃO é produzível nesta entrega (não existe autoridade operacional): quem informa o texto `OPERACIONAL` não obtém proveniência. `TESTE_CONTROLADO` só pode ser criada com `NODE_ENV === 'test'` (lido
 * na chamada, não no carregamento) e a publicação feita com ela é marcada `publicacaoOperacional: false`.
 */
const ORIGENS_PRODUZIVEIS = new Set(['TESTE_CONTROLADO']);
function criarProdutorDeRelatorio(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['origem', 'decidir']) || !ehFuncao(opcoes.decidir) || typeof opcoes.origem !== 'string' || !ORIGENS_PRODUZIVEIS.has(opcoes.origem)) throw invalido();
  if (opcoes.origem === 'TESTE_CONTROLADO' && process.env.NODE_ENV !== 'test') throw invalido();
  const { origem, decidir } = opcoes;
  const produtor = async (contexto) => {
    const resposta = await decidir(contexto);
    const decisao = Object.freeze({ ok: ehObjeto(resposta) && resposta.ok === true, origem, operacaoId: contexto.operacaoId });
    decisoesProduzidas.add(decisao);
    return decisao;
  };
  produtoresProduzidos.add(produtor);
  return produtor;
}

/**
 * PRONTIDÃO OPERACIONAL (contrato do produtor operacional): confere, item a item, as evidências efetivamente RECONHECIDAS (marcas internas, não objetos literais nem clones): identidade da operação, snapshot, supervisão + dump T1/T2 (correlação
 * satisfeita), verificação estrutural, consistência exigida, pacote verificado, manifesto V2 AUTENTICADO, FONTE OPERACIONAL das chaves e DESTINO autorizado. `pronta` só é verdadeira com TODOS os itens; hoje NÃO PODE ser: não existe fonte
 * operacional de chaves (lista de provedores aprovados vazia) nem destino operacional autorizado (lista vazia). Nenhuma variável de ambiente, inclusive NODE_ENV, participa. Retorna { pronta, itens, pendencias } congelado.
 */
const DESTINOS_OPERACIONAIS_AUTORIZADOS = Object.freeze([]);
function criarAvaliadorDeProntidao({ destinos, origemDaChave }) {
  if (!Array.isArray(destinos) || !destinos.every((d) => typeof d === 'string') || typeof origemDaChave !== 'string' || origemDaChave === '') throw invalido();
  return function avaliarProntidao(evidencias) {
    const e = ehObjeto(evidencias) ? evidencias : {};
    let correlacaoReconhecida = false;
    let correlacaoSatisfeita = false;
    let estrutura = false;
    try {
      correlacaoReconhecida = reconhecerCorrelacao(e.correlacao) && e.correlacao.escopo === 'CONJUNTO';
      correlacaoSatisfeita = correlacaoReconhecida && avaliarCorrelacao(e.correlacao).satisfeita === true;
      estrutura = correlacaoReconhecida && estruturaVerificada(e.correlacao) === true;
    } catch { /* qualquer falha é item não satisfeito */ }
    const operacaoId = correlacaoReconhecida ? e.correlacao.snapshot.operacaoId : null;
    const pacoteOk = ehEvidenciaDoPacote(e.pacote) && e.pacote.ok === true && e.pacote.origem === 'PACOTE_VERIFICADO' && correlacaoReconhecida && e.pacote.sha256Manifesto === e.correlacao.manifesto.sha256Manifesto;
    const consistenciaOk = ehEvidenciaDoPacote(e.consistencia) && e.consistencia.origem === 'CONSISTENCIA_PLANO_COPIA' && e.consistencia.demonstrada === true;
    const aut = ehObjeto(e.autenticacao) ? e.autenticacao : {};
    const destino = ehObjeto(e.destino) ? e.destino : {};
    const itens = Object.freeze({
      IDENTIDADE_DA_OPERACAO: typeof operacaoId === 'string' && operacaoId !== '' && ehEvidenciaDoPacote(e.consistencia) && e.consistencia.operacaoId === operacaoId,
      SNAPSHOT_E_CORRELACAO: correlacaoReconhecida,
      SUPERVISAO_E_DUMP_T1_T2: correlacaoSatisfeita,
      VERIFICACAO_ESTRUTURAL: estrutura,
      CONSISTENCIA_EXIGIDA: consistenciaOk,
      PACOTE_VERIFICADO: pacoteOk,
      MANIFESTO_V2_AUTENTICADO: (ehAutenticacaoReconhecida(e.autenticacao) || ehAutenticacaoL2(e.autenticacao)) && aut.versao === 2 && aut.autenticado === true,
      FONTE_OPERACIONAL_DE_CHAVES: ehAutenticacaoReconhecida(e.autenticacao) && aut.origemDaChave === origemDaChave,
      DESTINO_AUTORIZADO: typeof destino.raizDoDestino === 'string' && destinos.includes(destino.raizDoDestino),
    });
    const pendencias = Object.freeze(Object.keys(itens).filter((k) => itens[k] !== true));
    return Object.freeze({ pronta: pendencias.length === 0, itens, pendencias });
  };
}

/** Avaliador de prontidão da PRODUÇÃO: a lista de destinos operacionais autorizados e a origem de chave exigida são as constantes do código (listas VAZIAS: nenhuma fonte operacional de chaves e nenhum destino cadastrados). */
const avaliarProntidaoOperacional = criarAvaliadorDeProntidao({ destinos: DESTINOS_OPERACIONAIS_AUTORIZADOS, origemDaChave: 'OPERACIONAL' });

/**
 * PRODUTOR OPERACIONAL: avalia a prontidão sobre as evidências RECONHECIDAS que o publicador entrega (correlação, pacote verificado, consistência, autenticação V2 com a origem da chave, destino) e, quando o criador fornece `complementos()` (captura íntegra do dump
 * confirmada por T1/T2 e janela genuína — fatos que só a composição de produção conhece), também esses dois. A decisão é `ok:true` de origem OPERACIONAL SOMENTE se TODOS os itens forem satisfeitos; nada é fabricado: com as listas de fonte de chaves e de destinos VAZIAS isso é impossível, e a decisão
 * é `ok:false` com as pendências (o publicador a trata como RELATORIO_SEM_PROVENIENCIA). `NODE_ENV` e qualquer configuração declarada pelo chamador não entram em nenhum item. `criarProdutorDePoliticaDeTeste` (política injetada) existe só para testar a LÓGICA e nunca emite a origem OPERACIONAL.
 */
function construirProdutor({ avaliar, complementos, origemDoSucesso }) {
  const produtor = async (contexto) => {
    const prontidao = avaliar(ehObjeto(contexto) ? contexto.evidencias : undefined);
    const faltas = [...prontidao.pendencias];
    if (typeof complementos === 'function') {
      let c = null;
      try { c = complementos(); } catch { c = null; }
      if (!ehObjeto(c) || c.capturaIntegra !== true) faltas.push('CAPTURA_INTEGRA');
      if (!ehObjeto(c) || c.janelaGenuina !== true) faltas.push('JANELA_GENUINA');
    }
    const ok = faltas.length === 0;
    const decisao = Object.freeze({ ok, origem: ok ? origemDoSucesso : 'OPERACIONAL_BLOQUEADO', operacaoId: contexto.operacaoId, pendencias: Object.freeze(faltas) });
    decisoesProduzidas.add(decisao);
    return decisao;
  };
  produtoresProduzidos.add(produtor);
  return produtor;
}
function criarProdutorOperacional(opcoes = {}) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => k === 'complementos') || (opcoes.complementos !== undefined && !ehFuncao(opcoes.complementos))) throw invalido();
  return construirProdutor({ avaliar: avaliarProntidaoOperacional, complementos: opcoes.complementos, origemDoSucesso: 'OPERACIONAL' });
}
/** Só para testar a lógica com política injetada: a decisão de sucesso tem origem 'TESTE_DE_POLITICA', que o publicador de produção (origens aceitas = OPERACIONAL) recusa. */
function criarProdutorDePoliticaDeTeste({ destinos, origemDaChave, complementos }) {
  return construirProdutor({ avaliar: criarAvaliadorDeProntidao({ destinos, origemDaChave }), complementos, origemDoSucesso: 'TESTE_DE_POLITICA' });
}

/** Identidade do pacote nos registros duráveis: nome final + operação, conjunto, manifesto e dump da correlação RECONHECIDA (nunca do chamador). */
function identidadeDoPacote(nomeFinal, correlacao) {
  return {
    nome: nomeFinal,
    operacaoId: correlacao.snapshot.operacaoId,
    conjuntoId: correlacao.manifesto.conjuntoId,
    sha256Manifesto: correlacao.manifesto.sha256Manifesto,
    dump: { bytes: correlacao.dump.bytes, sha256: correlacao.dump.sha256 },
  };
}

function criarPublicador(opcoes) {
  let raizDoDestino;
  let produtor;
  let origensAceitas;
  let servico;
  let leitorDeManifesto;
  let registro;
  try {
    if (!ehObjeto(opcoes)) throw invalido();
    const proprias = Reflect.ownKeys(opcoes);
    const permitidas = ['raizDoDestino', 'produtorDeRelatorio', 'origensAceitas', 'ops', 'leitorDeManifesto', 'registro'];
    if (!proprias.every((k) => typeof k === 'string' && permitidas.includes(k)) || !['raizDoDestino', 'produtorDeRelatorio'].every((k) => proprias.includes(k))) throw invalido();
    raizDoDestino = opcoes.raizDoDestino;
    produtor = opcoes.produtorDeRelatorio;
    if (!caminhoAbsolutoCanonico(raizDoDestino) || !ehFuncao(produtor) || !produtoresProduzidos.has(produtor)) throw invalido();
    origensAceitas = proprias.includes('origensAceitas') ? opcoes.origensAceitas : ['OPERACIONAL'];
    if (!Array.isArray(origensAceitas) || origensAceitas.length === 0 || !origensAceitas.every((o) => typeof o === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(o))) throw invalido();
    servico = criarServicoDePacote(proprias.includes('ops') ? { ops: opcoes.ops } : {});
    // Leitor do manifesto na releitura final: padrão V1; o V2 autenticado é injetado por quem possui a fonte de chaves.
    if (proprias.includes('leitorDeManifesto') && !ehFuncao(opcoes.leitorDeManifesto)) throw invalido();
    leitorDeManifesto = proprias.includes('leitorDeManifesto') ? opcoes.leitorDeManifesto : lerManifesto;
    // Registro durável da publicação (SEMPRE ligado): `registro` opcional só configura a fonte de chaves (autenticação dos registros) e, nos testes, as operações de disco/relógio.
    const cfgRegistro = proprias.includes('registro') ? opcoes.registro : {};
    if (!ehObjeto(cfgRegistro) || !Reflect.ownKeys(cfgRegistro).every((k) => ['fonteDeChaves', 'chaveId', 'ops', 'relogio'].includes(k))) throw invalido();
    registro = criarRegistroDePublicacao({ raiz: raizDoDestino, ...cfgRegistro });
  } catch {
    throw invalido();
  }
  const aceitas = new Set(origensAceitas);
  const ops = servico.ops;
  const nada = (motivo, extra = {}) => evidencia({ publicada: false, estado: 'NADA_PUBLICADO', motivo, ...extra });

  async function publicar(entrada) {
    // `sinal` (opcional): pedido de cancelamento cooperativo da operação; conferido no PONTO DE DECISÃO da conclusão (depois do fsync do destino).
    const comSinal = ehObjeto(entrada) && Reflect.ownKeys(entrada).includes('sinal');
    if (!ehObjeto(entrada) || !chavesExatas(entrada, comSinal ? ['preparacao', 'nomeFinal', 'correlacao', 'pacote', 'consistencia', 'sinal'] : ['preparacao', 'nomeFinal', 'correlacao', 'pacote', 'consistencia'])) throw invalido();
    if (comSinal && !(ehObjeto(entrada.sinal) && typeof entrada.sinal.aborted === 'boolean')) throw invalido();
    const { preparacao, nomeFinal, correlacao, pacote, consistencia } = entrada;
    const sinal = comSinal ? entrada.sinal : null;
    if (!caminhoAbsolutoCanonico(preparacao) || typeof nomeFinal !== 'string' || !NOME_FINAL.test(nomeFinal)) throw invalido();

    // (1) correlação do conjunto
    if (!reconhecerCorrelacao(correlacao) || correlacao.escopo !== 'CONJUNTO') return nada('CORRELACAO_NAO_RECONHECIDA');
    if (!avaliarCorrelacao(correlacao).satisfeita) return nada('CORRELACAO_NAO_SATISFEITA');
    const operacaoId = correlacao.snapshot.operacaoId;
    // (2) estrutura
    if (!estruturaVerificada(correlacao)) return nada('ESTRUTURA_NAO_VERIFICADA');
    // (3) pacote
    if (!ehEvidenciaDoPacote(pacote) || pacote.ok !== true || pacote.origem !== 'PACOTE_VERIFICADO' || pacote.sha256Manifesto !== correlacao.manifesto.sha256Manifesto
      || pacote.dump.sha256 !== correlacao.dump.sha256 || pacote.dump.bytes !== correlacao.dump.bytes) return nada('PACOTE_NAO_VERIFICADO');
    // (4) consistência
    if (!ehEvidenciaDoPacote(consistencia) || consistencia.origem !== 'CONSISTENCIA_PLANO_COPIA' || consistencia.demonstrada !== true || consistencia.operacaoId !== operacaoId) return nada('CONSISTENCIA_NAO_DEMONSTRADA');
    // (5) relatório operacional com procedência
    let relatorio;
    // Evidências ENTREGUES ao produtor (as mesmas que o publicador acabou de reconhecer): o produtor operacional as reavalia; o de teste as ignora. A autenticação vem da releitura do manifesto pelo leitor configurado.
    let autenticacao = null;
    try {
      const l = leitorDeManifesto({ bytes: fs.readFileSync(path.join(preparacao, 'manifesto.json')), sha256: correlacao.manifesto.sha256Manifesto });
      autenticacao = l.autenticacao ?? Object.freeze({ versao: 1, autenticado: false });
    } catch { autenticacao = null; }
    const evidencias = Object.freeze({ correlacao, pacote, consistencia, autenticacao, destino: Object.freeze({ raizDoDestino, nomeFinal }) });
    try { relatorio = await produtor({ operacaoId, escopo: correlacao.escopo, evidencias }); } catch { relatorio = null; }
    if (!ehObjeto(relatorio) || !decisoesProduzidas.has(relatorio) || relatorio.ok !== true || typeof relatorio.origem !== 'string' || !aceitas.has(relatorio.origem) || relatorio.operacaoId !== operacaoId) {
      return nada('RELATORIO_SEM_PROVENIENCIA', ehObjeto(relatorio) && decisoesProduzidas.has(relatorio) && Array.isArray(relatorio.pendencias) ? { pendencias: relatorio.pendencias } : {});
    }
    // (6) destino
    if (!(await diretorioReal(ops, raizDoDestino))) return nada('DESTINO_INVALIDO');
    if (!(await diretorioReal(ops, preparacao))) return nada('PREPARACAO_INVALIDA');
    const destino = path.join(raizDoDestino, nomeFinal);
    if (preparacao === raizDoDestino || preparacao.startsWith(`${raizDoDestino}/`) || raizDoDestino.startsWith(`${preparacao}/`) || path.dirname(preparacao) === raizDoDestino) return nada('DESTINO_NAO_ISOLADO');
    try {
      await ops.lstat(destino);
      return nada('COLISAO_DO_DESTINO');
    } catch (falha) {
      if (!falha || falha.code !== 'ENOENT') return nada('DESTINO_INVALIDO');
    }
    // (7) persistência e nova verificação do que foi persistido
    const persistido = await servico.persistirPacote({ preparacao });
    if (persistido.ok !== true) return nada(`PERSISTENCIA_${persistido.motivo}`);
    // Nova verificação do que foi persistido: o manifesto é RELIDO do disco contra o digest da selagem verificada (adulteração depois da primeira verificação é pega aqui) e o pacote inteiro é conferido de novo.
    let reverificado;
    try {
      const lido = leitorDeManifesto({ bytes: fs.readFileSync(path.join(preparacao, 'manifesto.json')), sha256: correlacao.manifesto.sha256Manifesto });
      reverificado = await servico.verificarPacote({ preparacao, manifesto: lido.manifesto, identidade: lido.identidade });
    } catch {
      return nada('MANIFESTO_ADULTERADO');
    }
    if (reverificado.ok !== true || reverificado.dump.sha256 !== correlacao.dump.sha256) return nada(`PACOTE_${reverificado.motivo ?? 'DIVERGENTE'}`);
    // (8) reserva exclusiva do nome final e rename atômico
    try {
      await ops.mkdir(destino, 0o700);
    } catch (falha) {
      return nada(falha && falha.code === 'EEXIST' ? 'COLISAO_DO_DESTINO' : 'DESTINO_INVALIDO');
    }
    // (8a) INTENÇÃO DURÁVEL, ANTES do rename (escrita antecipada): o pacote só pode aparecer no nome final depois dela. Sem ela nada é publicado e a reserva vazia que criamos é desfeita.
    const identidade = identidadeDoPacote(nomeFinal, correlacao);
    const intencao = await registro.registrarIntencao(identidade);
    if (intencao.ok !== true) {
      let reservaRemovida = false;
      try { await ops.rmdir(destino); reservaRemovida = true; } catch { /* mantido: só removemos o diretório vazio que criamos */ }
      return nada('INTENCAO_NAO_REGISTRADA', { registro: intencao.motivo, reserva: reservaRemovida ? 'REMOVIDA' : 'MANTIDA' });
    }
    try {
      await ops.rename(preparacao, destino);
    } catch {
      // Só o diretório reservado VAZIO que este módulo acabou de criar pode ser removido; rmdir falha se houver conteúdo.
      let reservaRemovida = false;
      try { await ops.rmdir(destino); reservaRemovida = true; } catch { /* mantido: não removemos nada que não comprovamos ser nosso e vazio */ }
      return nada('RENAME_FALHOU', { reserva: reservaRemovida ? 'REMOVIDA' : 'MANTIDA' });
    }
    // (9) durabilidade do rename
    try {
      await ops.fsyncDiretorio(raizDoDestino);
    } catch {
      try {
        await ops.rename(destino, preparacao);
        // O rename reverso deixa a reserva vazia de volta? O destino foi movido; recriamos nada. Estado restaurado: preparação de volta, nome final livre.
        return evidencia({ publicada: false, estado: 'REVERTIDA', motivo: 'FSYNC_DO_DESTINO_FALHOU' });
      } catch {
        const q = await registro.registrarQuarentena(identidade, 'PUBLICACAO_INCERTA');
        return evidencia({ publicada: false, estado: 'INCERTA', motivo: 'FSYNC_DO_DESTINO_FALHOU', quarentena: Object.freeze({ necessaria: true, registrada: q.ok === true }) });
      }
    }
    // (10) PONTO DE DECISÃO da conclusão: com pedido de cancelamento pendente a publicação é comprometida — QUARENTENA durável e NENHUMA conclusão. Caso contrário a conclusão (prova positiva) é gravada; se não puder ser, a publicação é INCERTA.
    if (sinal !== null && sinal.aborted === true) {
      const q = await registro.registrarQuarentena(identidade, 'PUBLICADO_SOB_CANCELAMENTO');
      return evidencia({ publicada: true, estado: 'PUBLICADA', nome: nomeFinal, origemDoRelatorio: relatorio.origem, publicacaoOperacional: relatorio.origem === 'OPERACIONAL', operacaoId, quarentena: Object.freeze({ necessaria: true, registrada: q.ok === true }) });
    }
    const conclusao = await registro.registrarConclusao(identidade, intencao.tentativa);
    if (conclusao.ok !== true) {
      const q = await registro.registrarQuarentena(identidade, 'CONCLUSAO_NAO_REGISTRADA');
      return evidencia({ publicada: false, estado: 'INCERTA', motivo: 'CONCLUSAO_NAO_REGISTRADA', quarentena: Object.freeze({ necessaria: true, registrada: q.ok === true }) });
    }
    return evidencia({ publicada: true, estado: 'PUBLICADA', nome: nomeFinal, origemDoRelatorio: relatorio.origem, publicacaoOperacional: relatorio.origem === 'OPERACIONAL', operacaoId });
  }

  const publicador = Object.freeze({ publicar, servico, registro, identidadeDe: identidadeDoPacote });
  publicadoresProduzidos.add(publicador);
  return publicador;
}

const ehPublicador = (v) => v !== null && typeof v === 'object' && publicadoresProduzidos.has(v);

const ehProdutorReconhecido = (v) => typeof v === 'function' && produtoresProduzidos.has(v);

module.exports = { ehProdutorReconhecido, avaliarProntidaoOperacional, criarAvaliadorDeProntidao, criarProdutorOperacional, criarProdutorDePoliticaDeTeste, DESTINOS_OPERACIONAIS_AUTORIZADOS, criarServicoDePacote, criarPublicador, criarProdutorDeRelatorio, ehPublicador, ehEvidenciaDoPacote, SERVICO_PADRAO, ARQUIVO_DO_DUMP, PASTA_DO_DUMP, identidadeDoPacote };
