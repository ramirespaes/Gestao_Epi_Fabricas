'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chaveDe } = require('../src/storage/armazenamento-imagens');
const { lerConfiguracao } = require('../src/config/imagens');
const { inspecionarContainer, ErroDeImagem, PEDACOS_DE_METADADOS } = require('../src/utils/imagem-container');
const { nomeSeguro } = require('../src/utils/pacote-padrao-erros');

/**
 * Script administrativo: completa a variante de EXIBIÇÃO (WebP 640x640) de UMA imagem padrão da Biblioteca de Imagens que ainda não a tem.
 * O importador histórico gravou só o mestre (PNG padronizado) e a miniatura; sem `exibicao.webp` e sem `sha256_exibicao`/`bytes_exibicao`, a rota de
 * entrega responde 404 para a variante `exibicao` (Totem e Central ficam sem a foto ampliada).
 *
 *   node --require dotenv/config scripts/imagens-completar-exibicao.js --id <n> --banco-autorizado <nome> --banco-oid <oid> --diretorio-autorizado <caminho>
 *        [--dry-run | --executar] [--backup-arquivo <caminho> --backup-sha256 <hash> --inventario-arquivo <caminho> --inventario-sha256 <hash> --prova-restauracao-arquivo <caminho>]
 *
 * SEGURO POR PADRÃO: sem `--executar` nada é gravado (banco em transação READ ONLY, armazenamento só lido). Uma imagem por vez; não existe modo em lote.
 * DESTINO: o banco (nome e OID) e o diretório de imagens vêm da autorização escrita do operador, nunca do ambiente; o banco é conferido na própria conexão antes
 * de ler o registro, e o diretório efetivo (IMAGENS_ARMAZENAMENTO_DIRETORIO) tem de ser exatamente o autorizado. `--executar` exige ainda os cinco artefatos
 * prévios (dump do backup, inventário e prova de restauração), que o script CONFERE de verdade antes de conectar: arquivos comuns do próprio usuário, fora do
 * diretório de imagens e do repositório, com até 2 h, SHA-256 recalculado; inventário linha a linha contra o disco (tipo, tamanho e SHA-256 de cada arquivo);
 * prova com `restauradoEm` válido, recente e do mesmo dump; e, já na transação, a impressão digital dos dados relevantes igual à da prova. Os artefatos nunca são
 * criados nem alterados por este script. Na simulação os cinco são opcionais, mas, se informados, são conferidos do mesmo modo.
 * PROCESSAMENTO: reutiliza o processador existente (processo filho com sharp) e aproveita SÓ a saída `exibicao`; mestre e miniatura reprocessados são
 * descartados e os arquivos originais nunca são regravados. Mestre e miniatura registrados são conferidos pelo SHA-256 e pelo tamanho do próprio registro
 * (não pelos bytes de um reprocessamento, que usa outro codificador que o do pacote importado).
 * ESCRITA (só com `--executar`), numa transação, nesta ordem: trava da linha (FOR UPDATE, espera máxima de 5 s), conferência de que a exibição continua ausente,
 * publicação do arquivo pela API do armazenamento (link que nunca sobrescreve), UPDATE condicional dos DOIS campos exigindo exatamente 1 linha, COMMIT e leitura de
 * volta do arquivo. Banco e disco não são atômicos: se algo falhar depois de o arquivo ser criado por esta execução e a linha continuar sem exibição, só o arquivo
 * que ESTA execução criou é removido; arquivo preexistente nunca é apagado nem sobrescrito. Repetir o comando é inofensivo (idempotente).
 * `sharp`: o filho não herda NODE_PATH; o comando só funciona onde `sharp` resolve a partir do diretório do worker (backend com node_modules).
 *
 * Códigos de saída: OK=0 (inclui simulação e imagem já completa), ERRO=1, ARGUMENTOS=2 (inclui destino/diretório não autorizados), NAO_ENCONTRADA=3,
 * RECUSADA=4 (inconsistência ou conflito: nada foi mantido), INVESTIGAR=5 (estado a conferir manualmente). A saída nunca leva caminho absoluto nem segredo.
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1, ARGUMENTOS: 2, NAO_ENCONTRADA: 3, RECUSADA: 4, INVESTIGAR: 5 });

const CONFIG = lerConfiguracao({});
const LADO_EXIBICAO = CONFIG.exibicao.lado;
const EXIBICAO_BYTES_MAX = CONFIG.processamento.exibicaoBytesMax;
const ENTRADA_BYTES_MAX = CONFIG.arquivoMaxBytes;
const MINIATURA_BYTES_MAX = CONFIG.miniatura.bytesMax;

const ID_MAXIMO = '9223372036854775807';
const ID = /^[1-9][0-9]{0,18}$/;
const BANCO = /^[A-Za-z0-9_]{1,63}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const OID_MAXIMO = 4294967295;
const SHA256 = /^[0-9a-f]{64}$/;
const VALIDADE_ARTEFATOS_MS = 2 * 60 * 60 * 1000;
const TOLERANCIA_RELOGIO_MS = 60 * 1000;
const INVENTARIO_BYTES_MAX = 4 * 1024 * 1024;
const PROVA_BYTES_MAX = 1024 * 1024;
const NOME_PASTA = /^[0-9a-f]{64}$/;
const NOME_ARQUIVO = /^(?:mestre\.(?:png|jpg|webp)|miniatura\.webp|exibicao\.webp)$/;
const DATA_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SQL_IMPRESSAO = [
  'SELECT json_agg(r ORDER BY r.t)::text AS v FROM (',
  "  SELECT 'imagens_padrao' AS t, count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM imagens_padrao x",
  "  UNION ALL SELECT 'imagens_padrao_tipos', count(*)::text, md5(coalesce(string_agg(x::text, '|' ORDER BY x.imagem_padrao_id, x.tipo_nome), '')) FROM imagens_padrao_tipos x",
  "  UNION ALL SELECT 'imagens_empresa', count(*)::text, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM imagens_empresa x",
  "  UNION ALL SELECT 'materiais_imagem', count(*)::text, md5(coalesce(string_agg(m.id || ':' || coalesce(m.imagem_padrao_id::text, '-') || ':' || coalesce(m.imagem_empresa_id::text, '-') || ':' || m.ativo, '|' ORDER BY m.id), '')) FROM materiais m",
  ') r',
].join('\n');
const FORMATOS = Object.freeze(['PNG', 'JPEG', 'WEBP']);
const MODOS = Object.freeze({ '--dry-run': 'SIMULAR', '--executar': 'EXECUTAR' });
const COM_VALOR = Object.freeze({
  '--id': 'id', '--banco-autorizado': 'banco', '--banco-oid': 'oid', '--diretorio-autorizado': 'diretorio', '--backup-sha256': 'backup', '--inventario-sha256': 'inventario',
  '--backup-arquivo': 'backupArquivo', '--inventario-arquivo': 'inventarioArquivo', '--prova-restauracao-arquivo': 'provaArquivo',
});
const caminhoCanonico = (v) => !v.includes('\0') && path.isAbsolute(v) && path.resolve(v) === v && v !== path.parse(v).root;

class ErroExibicao extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroExibicao';
    this.codigo = codigo;
  }
}
const falhar = (codigo, mensagem) => new ErroExibicao(codigo, mensagem);

const SAIDA_DO_CODIGO = Object.freeze({
  DESTINO_NAO_AUTORIZADO: SAIDAS.ARGUMENTOS,
  DIRETORIO_NAO_AUTORIZADO: SAIDAS.ARGUMENTOS,
  PRE_CONDICOES_AUSENTES: SAIDAS.ARGUMENTOS,
  ARTEFATO_INVALIDO: SAIDAS.RECUSADA,
  ARTEFATOS_EXPIRADOS: SAIDAS.RECUSADA,
  ARTEFATOS_DESATUALIZADOS: SAIDAS.RECUSADA,
  IMAGEM_NAO_ENCONTRADA: SAIDAS.NAO_ENCONTRADA,
  REGISTRO_PARCIAL: SAIDAS.RECUSADA,
  REGISTRO_INVALIDO: SAIDAS.RECUSADA,
  MESTRE_AUSENTE: SAIDAS.RECUSADA,
  MESTRE_DIVERGENTE: SAIDAS.RECUSADA,
  MESTRE_GRANDE_DEMAIS: SAIDAS.RECUSADA,
  MESTRE_RECUSADO: SAIDAS.RECUSADA,
  MINIATURA_AUSENTE: SAIDAS.RECUSADA,
  MINIATURA_DIVERGENTE: SAIDAS.RECUSADA,
  VARIANTE_GERADA_INVALIDA: SAIDAS.RECUSADA,
  EXIBICAO_EXISTENTE_DIVERGENTE: SAIDAS.RECUSADA,
  ALTERACAO_CONCORRENTE: SAIDAS.RECUSADA,
  REGISTRO_EM_USO: SAIDAS.RECUSADA,
  VERIFICACAO_POSTERIOR_FALHOU: SAIDAS.INVESTIGAR,
  COMMIT_INCERTO: SAIDAS.INVESTIGAR,
});
const codigoDeSaida = (codigo) => (Object.hasOwn(SAIDA_DO_CODIGO, codigo) ? SAIDA_DO_CODIGO[codigo] : SAIDAS.ERRO);

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const resumir = (hash) => `${hash.slice(0, 12)}…`;
const ehWebp = (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

// ───────────────────────── argumentos ─────────────────────────
function interpretarArgumentos(argv) {
  const valores = {};
  const modos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const argumento = argv[i];
    if (Object.hasOwn(MODOS, argumento)) {
      if (modos.includes(MODOS[argumento])) return { ok: false, erro: 'modo repetido' };
      modos.push(MODOS[argumento]);
    } else if (Object.hasOwn(COM_VALOR, argumento)) {
      const campo = COM_VALOR[argumento];
      const valor = argv[i + 1];
      if (typeof valor !== 'string' || valor.startsWith('--')) return { ok: false, erro: `${argumento} exige um valor` };
      if (valores[campo] !== undefined) return { ok: false, erro: `${argumento} repetido` };
      valores[campo] = valor;
      i += 1;
    } else {
      return { ok: false, erro: 'argumento desconhecido' };
    }
  }
  if (modos.length > 1) return { ok: false, erro: '--dry-run e --executar são mutuamente exclusivos' };
  const modo = modos[0] ?? 'SIMULAR';

  const { id, banco, oid, diretorio, backup, inventario } = valores;
  if (id === undefined) return { ok: false, erro: '--id <n> é obrigatório' };
  if (!ID.test(id) || (id.length === 19 && id > ID_MAXIMO)) return { ok: false, erro: '--id deve ser um inteiro positivo (BIGINT) em texto canônico' };
  if (banco === undefined || oid === undefined) return { ok: false, erro: '--banco-autorizado <nome> e --banco-oid <oid> são obrigatórios' };
  if (!BANCO.test(banco)) return { ok: false, erro: '--banco-autorizado deve ter de 1 a 63 letras, números ou _' };
  if (!OID.test(oid) || Number(oid) > OID_MAXIMO) return { ok: false, erro: '--banco-oid deve ser um inteiro positivo' };
  if (diretorio === undefined) return { ok: false, erro: '--diretorio-autorizado <caminho absoluto> é obrigatório' };
  if (!caminhoCanonico(diretorio)) {
    return { ok: false, erro: '--diretorio-autorizado deve ser um caminho absoluto, canônico e diferente da raiz' };
  }
  const { backupArquivo, inventarioArquivo, provaArquivo } = valores;
  const informados = [backup, backupArquivo, inventario, inventarioArquivo, provaArquivo].filter((v) => v !== undefined).length;
  if (informados !== 0 && informados !== 5) {
    return { ok: false, erro: 'os cinco argumentos de artefatos devem vir juntos (--backup-arquivo, --backup-sha256, --inventario-arquivo, --inventario-sha256, --prova-restauracao-arquivo)' };
  }
  if (modo === 'EXECUTAR' && informados !== 5) {
    return { ok: false, erro: '--executar exige os cinco argumentos de artefatos (backup, inventário e prova de restauração)' };
  }
  let artefatos = null;
  if (informados === 5) {
    if (!SHA256.test(backup) || !SHA256.test(inventario)) return { ok: false, erro: '--backup-sha256 e --inventario-sha256 devem ter 64 caracteres hexadecimais minúsculos' };
    if (![backupArquivo, inventarioArquivo, provaArquivo].every(caminhoCanonico)) return { ok: false, erro: 'os arquivos de artefatos devem ser caminhos absolutos e canônicos' };
    artefatos = {
      backup: { arquivo: backupArquivo, sha256: backup },
      inventario: { arquivo: inventarioArquivo, sha256: inventario },
      prova: { arquivo: provaArquivo },
    };
  }
  return { ok: true, modo, id, destino: { banco, oid }, diretorio, artefatos };
}

function uso() {
  return [
    'Uso: node --require dotenv/config scripts/imagens-completar-exibicao.js --id <n> --banco-autorizado <nome> --banco-oid <oid> --diretorio-autorizado <caminho absoluto> [--dry-run | --executar] [--backup-arquivo <caminho> --backup-sha256 <hash> --inventario-arquivo <caminho> --inventario-sha256 <hash> --prova-restauracao-arquivo <caminho>]',
    '  --id                    identificador da imagem padrão (uma por vez)',
    '  --banco-autorizado/oid  nome e OID do banco, conferidos na conexão antes de ler o registro (obrigatórios)',
    '  --diretorio-autorizado  diretório de imagens autorizado; precisa ser igual a IMAGENS_ARMAZENAMENTO_DIRETORIO (obrigatório)',
    '  --dry-run               confere e relata o que seria feito, sem gravar; é o padrão',
    '  --executar              gera e registra a exibição; exige os cinco artefatos prévios (dump, inventário e prova de restauração, com seus SHA-256)',
  ].join('\n');
}

// ───────────────────────── leitura e validação ─────────────────────────
/** Lê o fluxo até o teto; passando dele devolve null. O fluxo é sempre destruído. */
async function lerComTeto(fluxo, limite) {
  const blocos = [];
  let total = 0;
  try {
    for await (const bloco of fluxo) {
      total += bloco.length;
      if (total > limite) return null;
      blocos.push(bloco);
    }
  } finally {
    if (typeof fluxo.destroy === 'function') fluxo.destroy();
  }
  return Buffer.concat(blocos, total);
}

/** { estado: 'AUSENTE' } | { estado: 'EXCEDEU' } | { estado: 'LIDO', bytes } */
async function lerArquivo(armazenamento, chave, limite) {
  let fluxo;
  try {
    fluxo = await armazenamento.abrir(chave);
  } catch (falha) {
    if (falha?.codigo === 'ARQUIVO_AUSENTE') return { estado: 'AUSENTE' };
    throw falha;
  }
  const bytes = await lerComTeto(fluxo, limite);
  return bytes === null ? { estado: 'EXCEDEU' } : { estado: 'LIDO', bytes };
}

const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;

function classificar(linha) {
  if (linha === null) throw falhar('IMAGEM_NAO_ENCONTRADA', 'não existe imagem padrão com esse identificador');
  const valido = SHA256.test(linha.sha256 ?? '') && SHA256.test(linha.sha256_miniatura ?? '') && FORMATOS.includes(linha.formato)
    && inteiroPositivo(linha.bytes_mestre) && inteiroPositivo(linha.bytes_miniatura);
  if (!valido) throw falhar('REGISTRO_INVALIDO', 'o registro da imagem está fora do formato esperado');
  const temHash = linha.sha256_exibicao !== null && linha.sha256_exibicao !== undefined;
  const temBytes = linha.bytes_exibicao !== null && linha.bytes_exibicao !== undefined;
  if (temHash !== temBytes) throw falhar('REGISTRO_PARCIAL', 'o registro tem só um dos campos da exibição (hash ou tamanho)');
  if (!temHash) return 'PENDENTE';
  if (!SHA256.test(linha.sha256_exibicao) || !inteiroPositivo(linha.bytes_exibicao)) throw falhar('REGISTRO_INVALIDO', 'os campos da exibição estão fora do formato esperado');
  return 'JA_COMPLETA';
}

async function conferirOriginais(armazenamento, linha, chaves) {
  if (linha.bytes_mestre > ENTRADA_BYTES_MAX) throw falhar('MESTRE_GRANDE_DEMAIS', 'o mestre excede o limite de entrada do processador');
  const mestre = await lerArquivo(armazenamento, chaves.mestre, linha.bytes_mestre);
  if (mestre.estado === 'AUSENTE') throw falhar('MESTRE_AUSENTE', 'o arquivo do mestre não existe');
  if (mestre.estado !== 'LIDO' || mestre.bytes.length !== linha.bytes_mestre || sha256Hex(mestre.bytes) !== linha.sha256) {
    throw falhar('MESTRE_DIVERGENTE', 'o mestre não confere com o SHA-256 e o tamanho registrados');
  }
  const miniatura = await lerArquivo(armazenamento, chaves.miniatura, Math.min(linha.bytes_miniatura, MINIATURA_BYTES_MAX));
  if (miniatura.estado === 'AUSENTE') throw falhar('MINIATURA_AUSENTE', 'o arquivo da miniatura não existe');
  if (miniatura.estado !== 'LIDO' || miniatura.bytes.length !== linha.bytes_miniatura || sha256Hex(miniatura.bytes) !== linha.sha256_miniatura || !ehWebp(miniatura.bytes)) {
    throw falhar('MINIATURA_DIVERGENTE', 'a miniatura não confere com o SHA-256, o tamanho ou o formato registrados');
  }
  return mestre.bytes;
}

function validarExibicao(bytes) {
  const invalida = (motivo) => falhar('VARIANTE_GERADA_INVALIDA', `a exibição gerada é inválida (${motivo})`);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalida('vazia');
  if (bytes.length > EXIBICAO_BYTES_MAX) throw invalida('excede o limite de tamanho');
  let info;
  try { info = inspecionarContainer(bytes, { ladoMin: LADO_EXIBICAO, ladoMax: LADO_EXIBICAO, pixelsMax: LADO_EXIBICAO * LADO_EXIBICAO }); } catch { throw invalida('contêiner'); }
  if (info.formato !== 'WEBP' || info.largura !== LADO_EXIBICAO || info.altura !== LADO_EXIBICAO) throw invalida('formato ou medidas');
  if (info.bytesExtras !== 0 || info.pedacos.some((pedaco) => PEDACOS_DE_METADADOS.has(pedaco))) throw invalida('bytes extras ou metadados');
  return bytes;
}

function traduzirFalhaDoProcessador(falha) {
  if (falha instanceof ErroExibicao) return falha;
  if (falha?.codigo === 'IMAGENS_INDISPONIVEL') {
    return falhar('PROCESSADOR_INDISPONIVEL', 'o processador de imagens (sharp) não está disponível neste ambiente; rode onde o sharp resolve a partir do worker');
  }
  if (falha instanceof ErroDeImagem) return falhar('MESTRE_RECUSADO', 'o processador recusou o mestre registrado');
  return falhar('PROCESSAMENTO_FALHOU', 'o processamento da imagem falhou');
}

/** Gera a exibição (e a repete uma vez só para informar se o resultado é determinístico); mestre e miniatura do processador são descartados. */
async function gerarExibicao(processador, mestre) {
  let primeira;
  try { primeira = await processador.processar(mestre); } catch (falha) { throw traduzirFalhaDoProcessador(falha); }
  const bytes = validarExibicao(primeira?.exibicao);
  let deterministico = null;
  try {
    const segunda = await processador.processar(mestre);
    deterministico = Buffer.isBuffer(segunda?.exibicao) && sha256Hex(segunda.exibicao) === sha256Hex(bytes);
  } catch { deterministico = false; }
  return { bytes, sha256: sha256Hex(bytes), deterministico };
}

// ───────────────────────── banco ─────────────────────────
async function conferirDestino(cliente, destino) {
  const { rows } = await cliente.query('SELECT current_database() AS banco, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid');
  const efetivo = rows[0];
  if (efetivo === undefined || efetivo.banco !== destino.banco || efetivo.oid !== destino.oid) {
    throw falhar('DESTINO_NAO_AUTORIZADO', 'o banco conectado não é o autorizado (nome e OID)');
  }
}

async function lerLinha(cliente, id, travar) {
  const consulta = 'SELECT id::text AS id, sha256, sha256_miniatura, sha256_exibicao, formato, bytes_mestre, bytes_miniatura, bytes_exibicao FROM imagens_padrao WHERE id = $1::bigint';
  try {
    const { rows } = await cliente.query(travar ? `${consulta} FOR UPDATE` : consulta, [id]);
    return rows[0] ?? null;
  } catch (falha) {
    if (falha?.code === '55P03') throw falhar('REGISTRO_EM_USO', 'o registro está bloqueado por outra operação');
    throw falha;
  }
}

async function desfazer(cliente) {
  try { await cliente.query('ROLLBACK'); } catch { /* a conexão pode já ter sido encerrada */ }
}

/** Só o arquivo criado por esta execução, e só se nenhuma linha passou a referenciar a exibição. */
async function compensar(pool, armazenamento, id, chave) {
  const { rows } = await pool.query('SELECT sha256_exibicao FROM imagens_padrao WHERE id = $1::bigint', [id]);
  if ((rows[0]?.sha256_exibicao ?? null) !== null) return 'MANTIDO_REGISTRADO';
  await armazenamento.remover(chave);
  return 'REMOVIDO';
}

// ───────────────────────── artefatos prévios ─────────────────────────
function hashDeArquivo(arquivo) {
  return new Promise((resolver, rejeitar) => {
    const hash = crypto.createHash('sha256');
    const fluxo = fs.createReadStream(arquivo);
    fluxo.on('data', (bloco) => hash.update(bloco));
    fluxo.on('error', rejeitar);
    fluxo.on('end', () => resolver(hash.digest('hex')));
  });
}
const dentroDe = (pai, filho) => { const r = path.relative(pai, filho); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const invalido = (rotulo, motivo) => falhar('ARTEFATO_INVALIDO', `${rotulo}: ${motivo}`);

async function conferirArquivoDoArtefato(rotulo, arquivo, { sha256, maxBytes, agora, proibidos }) {
  let info;
  try { info = fs.lstatSync(arquivo); } catch { throw invalido(rotulo, 'arquivo ausente'); }
  if (info.isSymbolicLink() || !info.isFile()) throw invalido(rotulo, 'não é um arquivo comum');
  if (info.uid !== process.getuid()) throw invalido(rotulo, 'pertence a outro usuário');
  if ((info.mode & 0o077) !== 0) throw invalido(rotulo, 'permissões abertas a grupo ou outros');
  if (info.size <= 0) throw invalido(rotulo, 'arquivo vazio');
  if (maxBytes !== undefined && info.size > maxBytes) throw invalido(rotulo, 'arquivo grande demais');
  const real = fs.realpathSync(arquivo);
  if (proibidos.some((proibido) => dentroDe(proibido, real))) throw invalido(rotulo, 'local proibido (diretório de imagens ou repositório)');
  const agoraMs = agora();
  if (info.mtimeMs > agoraMs + TOLERANCIA_RELOGIO_MS) throw invalido(rotulo, 'data de modificação no futuro');
  if (agoraMs - info.mtimeMs > VALIDADE_ARTEFATOS_MS) throw falhar('ARTEFATOS_EXPIRADOS', `${rotulo}: mais de 2 h; renove os artefatos e repita a conferência`);
  const calculado = await hashDeArquivo(arquivo);
  if (sha256 !== undefined && calculado !== sha256) throw invalido(rotulo, 'o SHA-256 do arquivo não confere com o informado');
  return calculado;
}

const LINHA_INVENTARIO = /^padrao\/([0-9a-f]{64})\/(mestre\.(?:png|jpg|webp)|miniatura\.webp|exibicao\.webp)\|([0-9]+)\|([0-9a-f]{64})$/;
function lerInventario(texto) {
  const mapa = new Map();
  for (const linha of texto.split('\n')) {
    if (linha === '') continue;
    const m = LINHA_INVENTARIO.exec(linha);
    if (m === null) throw invalido('inventário', 'linha fora do formato');
    const caminho = `padrao/${m[1]}/${m[2]}`;
    if (mapa.has(caminho)) throw invalido('inventário', 'entrada repetida');
    mapa.set(caminho, { bytes: Number(m[3]), sha256: m[4] });
  }
  if (mapa.size === 0) throw invalido('inventário', 'sem entradas');
  return mapa;
}

function lerProva(texto, dumpSha256, agoraMs) {
  let prova;
  try { prova = JSON.parse(texto); } catch { throw invalido('prova de restauração', 'JSON inválido'); }
  const chaves = prova !== null && typeof prova === 'object' && !Array.isArray(prova) ? Object.keys(prova).sort().join(',') : '';
  if (chaves !== 'dumpSha256,impressao,restauradoEm,versao' || prova.versao !== 1) throw invalido('prova de restauração', 'estrutura inesperada');
  if (prova.dumpSha256 !== dumpSha256) throw invalido('prova de restauração', 'a prova pertence a outro backup');
  const itens = Array.isArray(prova.impressao) && prova.impressao.length === 4
    && prova.impressao.every((i) => i !== null && typeof i === 'object' && typeof i.t === 'string' && /^[0-9]+$/.test(i.n) && /^[0-9a-f]{32}$/.test(i.h));
  if (!itens) throw invalido('prova de restauração', 'impressão digital inválida');
  const quando = typeof prova.restauradoEm === 'string' && DATA_ISO_UTC.test(prova.restauradoEm) ? Date.parse(prova.restauradoEm) : Number.NaN;
  if (!Number.isFinite(quando)) throw invalido('prova de restauração', 'restauradoEm não é uma data ISO em UTC');
  if (quando > agoraMs + TOLERANCIA_RELOGIO_MS) throw invalido('prova de restauração', 'restauradoEm no futuro');
  if (agoraMs - quando > VALIDADE_ARTEFATOS_MS) throw falhar('ARTEFATOS_EXPIRADOS', 'prova de restauração: restauradoEm com mais de 2 h; renove os artefatos e repita a conferência');
  return prova;
}

async function validarArtefatos({ artefatos, diretorioImagens, raizRepositorio, agora = Date.now }) {
  const proibidos = [fs.realpathSync(diretorioImagens), fs.realpathSync(raizRepositorio)];
  const backupSha = await conferirArquivoDoArtefato('backup', artefatos.backup.arquivo, { sha256: artefatos.backup.sha256, agora, proibidos });
  const descritor = fs.openSync(artefatos.backup.arquivo, 'r');
  const cabecalho = Buffer.alloc(5);
  try { fs.readSync(descritor, cabecalho, 0, 5, 0); } finally { fs.closeSync(descritor); }
  if (cabecalho.toString('latin1') !== 'PGDMP') throw invalido('backup', 'não é um dump no formato personalizado do PostgreSQL');
  const inventarioSha = await conferirArquivoDoArtefato('inventário', artefatos.inventario.arquivo, { sha256: artefatos.inventario.sha256, maxBytes: INVENTARIO_BYTES_MAX, agora, proibidos });
  const provaSha = await conferirArquivoDoArtefato('prova de restauração', artefatos.prova.arquivo, { maxBytes: PROVA_BYTES_MAX, agora, proibidos });
  return {
    backupSha,
    inventarioSha,
    provaSha,
    inventario: lerInventario(fs.readFileSync(artefatos.inventario.arquivo, 'utf8')),
    prova: lerProva(fs.readFileSync(artefatos.prova.arquivo, 'utf8'), backupSha, agora()),
  };
}

/** Layout exato do disco; só arquivos comuns; tamanho e SHA-256 recalculado de cada arquivo do inventário, inclusive as exibições de OUTRAS imagens. A exibição da própria imagem (tentativa anterior) nunca entra no inventário: fica de fora e é tratada depois, sem sobrescrita. */
async function conferirInventarioContraODisco({ inventario, diretorioImagens, linha }) {
  const desatualizado = (motivo) => falhar('ARTEFATOS_DESATUALIZADOS', motivo);
  const base = path.join(diretorioImagens, 'padrao');
  const encontrados = new Set();
  let pastas;
  try { pastas = fs.readdirSync(base, { withFileTypes: true }); } catch { throw desatualizado('não foi possível listar padrao/'); }
  for (const pasta of pastas) {
    if (!pasta.isDirectory() || !NOME_PASTA.test(pasta.name)) throw desatualizado('entrada inesperada em padrao/');
    let arquivos;
    try { arquivos = fs.readdirSync(path.join(base, pasta.name), { withFileTypes: true }); } catch { throw desatualizado('não foi possível listar uma pasta de imagem'); }
    for (const arquivo of arquivos) {
      if (!arquivo.isFile() || !NOME_ARQUIVO.test(arquivo.name)) throw desatualizado('arquivo inesperado, link simbólico ou diretório dentro de uma pasta de imagem');
      encontrados.add(`padrao/${pasta.name}/${arquivo.name}`);
    }
  }
  const exibicaoAlvo = `padrao/${linha.sha256}/exibicao.webp`;
  if (inventario.has(exibicaoAlvo)) throw desatualizado('o inventário já lista a exibição da imagem alvo');
  encontrados.delete(exibicaoAlvo);
  if (encontrados.size !== inventario.size) throw desatualizado('o inventário não corresponde ao diretório de imagens');
  for (const [caminho, esperado] of inventario) {
    if (!encontrados.has(caminho)) throw desatualizado('arquivo do inventário ausente no disco');
    const completo = path.join(diretorioImagens, caminho);
    if (fs.lstatSync(completo).size !== esperado.bytes) throw desatualizado('tamanho diferente do inventário');
    if ((await hashDeArquivo(completo)) !== esperado.sha256) throw desatualizado('conteúdo diferente do inventário (SHA-256)');
  }
}

/** Impressão digital em snapshot único, com fuso e estilo de data fixos; com pool abre transação somente-leitura própria. */
async function calcularImpressao(executor) {
  if (typeof executor.release !== 'function' && typeof executor.connect === 'function') {
    const cliente = await executor.connect();
    try {
      await cliente.query('BEGIN READ ONLY');
      try { return await calcularImpressao(cliente); } finally { await cliente.query('ROLLBACK'); }
    } finally { cliente.release(); }
  }
  await executor.query("SET LOCAL TIME ZONE 'UTC'");
  await executor.query("SET LOCAL DateStyle TO 'ISO, YMD'");
  const { rows } = await executor.query(SQL_IMPRESSAO);
  return JSON.parse(rows[0].v);
}

// ───────────────────────── operação ─────────────────────────
async function corrigir({ modo, id, destino, conferidos = null, diretorioImagens = null }, { pool, armazenamento, processador }) {
  const executar = modo === 'EXECUTAR';
  const cliente = await pool.connect();
  let aberta = false;
  let criadoPorEsta = null;
  let chaveExibicao = null;
  try {
    await cliente.query(executar ? 'BEGIN' : 'BEGIN READ ONLY');
    aberta = true;
    if (executar) await cliente.query("SET LOCAL lock_timeout = '5s'");
    await conferirDestino(cliente, destino);
    const linha = await lerLinha(cliente, id, executar);
    const situacao = classificar(linha);

    const base = { chave: (variante, formato) => chaveDe({ escopo: 'PADRAO', sha256: linha.sha256, variante, formato }) };
    chaveExibicao = base.chave('exibicao', 'WEBP');
    if (situacao === 'JA_COMPLETA') {
      await desfazer(cliente);
      aberta = false;
      return { id, modo, estado: 'JA_COMPLETA', arquivoPresente: await armazenamento.existe(chaveExibicao) };
    }
    if (conferidos !== null) {
      await conferirInventarioContraODisco({ inventario: conferidos.inventario, diretorioImagens, linha });
      const atual = await calcularImpressao(cliente);
      if (JSON.stringify(atual) !== JSON.stringify(conferidos.prova.impressao)) throw falhar('ARTEFATOS_DESATUALIZADOS', 'os dados relevantes mudaram depois da prova de restauração');
    }
    if (!executar) { await desfazer(cliente); aberta = false; }

    const mestre = await conferirOriginais(armazenamento, linha, { mestre: base.chave('mestre', linha.formato), miniatura: base.chave('miniatura', 'WEBP') });
    const existente = await lerArquivo(armazenamento, chaveExibicao, EXIBICAO_BYTES_MAX);
    const gerada = await gerarExibicao(processador, mestre);
    const preexistente = existente.estado === 'AUSENTE' ? 'NENHUM' : 'IGUAL';
    if (existente.estado !== 'AUSENTE' && (existente.estado !== 'LIDO' || sha256Hex(existente.bytes) !== gerada.sha256)) {
      throw falhar('EXIBICAO_EXISTENTE_DIVERGENTE', 'já existe um arquivo de exibição com outro conteúdo; ele nunca é sobrescrito');
    }
    const plano = { id, modo, estado: 'PENDENTE', sha256: gerada.sha256, bytes: gerada.bytes.length, deterministico: gerada.deterministico, arquivoPreexistente: preexistente };
    if (!executar) return plano;

    let publicado;
    try {
      publicado = await armazenamento.gravar(chaveExibicao, gerada.bytes, { maxBytes: EXIBICAO_BYTES_MAX, sha256Esperado: gerada.sha256 });
    } catch (falha) {
      if (falha?.codigo === 'CHAVE_COM_CONTEUDO_DIFERENTE') throw falhar('EXIBICAO_EXISTENTE_DIVERGENTE', 'já existe um arquivo de exibição com outro conteúdo; ele nunca é sobrescrito');
      throw falhar('PUBLICACAO_FALHOU', 'a publicação do arquivo de exibição falhou');
    }
    if (publicado.reaproveitado !== true) criadoPorEsta = chaveExibicao;

    const atualizado = await cliente.query(
      'UPDATE imagens_padrao SET sha256_exibicao = $2, bytes_exibicao = $3 WHERE id = $1::bigint AND sha256 = $4 AND sha256_exibicao IS NULL AND bytes_exibicao IS NULL',
      [id, gerada.sha256, gerada.bytes.length, linha.sha256],
    );
    if (atualizado.rowCount !== 1) throw falhar('ALTERACAO_CONCORRENTE', 'o registro mudou durante a operação; nada foi alterado');

    try {
      await cliente.query('COMMIT');
      aberta = false;
    } catch (falha) {
      aberta = false;
      let registrado;
      try { registrado = (await pool.query('SELECT sha256_exibicao FROM imagens_padrao WHERE id = $1::bigint', [id])).rows[0]?.sha256_exibicao ?? null; } catch {
        criadoPorEsta = null;
        throw falhar('COMMIT_INCERTO', 'não foi possível confirmar se o registro foi gravado; confira antes de repetir');
      }
      if (registrado !== gerada.sha256) throw falha;
    }
    criadoPorEsta = null;

    const volta = await lerArquivo(armazenamento, chaveExibicao, EXIBICAO_BYTES_MAX);
    if (volta.estado !== 'LIDO' || sha256Hex(volta.bytes) !== gerada.sha256 || volta.bytes.length !== gerada.bytes.length) {
      throw falhar('VERIFICACAO_POSTERIOR_FALHOU', 'o registro foi gravado, mas o arquivo lido de volta não confere; investigue');
    }
    return { ...plano, estado: 'CORRIGIDA', publicadoAgora: publicado.reaproveitado !== true, verificado: true };
  } catch (erro) {
    if (aberta) await desfazer(cliente);
    if (criadoPorEsta !== null) {
      try { erro.compensacao = await compensar(pool, armazenamento, id, criadoPorEsta); } catch { erro.compensacao = 'FALHOU'; }
    }
    throw erro;
  } finally {
    cliente.release();
  }
}

function imprimir(saida, r, banco) {
  saida.log(`Banco confirmado: ${nomeSeguro(banco)}`);
  if (r.estado === 'JA_COMPLETA') {
    saida.log(`Imagem padrão ${r.id}: exibição já registrada; nada a fazer (arquivo ${r.arquivoPresente ? 'presente' : 'AUSENTE: caso de restauração, fora deste comando'}).`);
    return;
  }
  saida.log(`Imagem padrão ${r.id}: exibição WebP ${LADO_EXIBICAO}x${LADO_EXIBICAO} gerada (${r.bytes} bytes, sha256 ${resumir(r.sha256)}); determinismo ${r.deterministico === null ? 'não avaliado' : r.deterministico ? 'confirmado' : 'NÃO confirmado'}; arquivo preexistente: ${r.arquivoPreexistente}.`);
  if (r.estado === 'PENDENTE') saida.log('Simulação: nada foi gravado. Para gravar, repita com --executar (e o backup e o inventário prévios).');
  else saida.log(`Corrigida: arquivo ${r.publicadoAgora ? 'publicado agora' : 'já existia com o mesmo conteúdo'}, registro atualizado e leitura de volta conferida.`);
}

function imprimirRecusa(saida, erro) {
  saida.error(`Recusado (${erro.codigo}): ${erro.message}`);
  if (erro.compensacao !== undefined) saida.error(`  Arquivo criado por esta execução: ${erro.compensacao === 'REMOVIDO' ? 'removido' : erro.compensacao === 'MANTIDO_REGISTRADO' ? 'mantido (já referenciado pelo registro)' : 'remoção FALHOU, confira'}.`);
  if (erro.codigo === 'DESTINO_NAO_AUTORIZADO') saida.error('  Informe o destino com --banco-autorizado <nome> e --banco-oid <oid>; os dois são conferidos na conexão.');
}

/**
 * @param {{modo: 'SIMULAR'|'EXECUTAR', id: string, destino: {banco: string, oid: string}, diretorio: string, artefatos?: {backup: {arquivo: string, sha256: string}, inventario: {arquivo: string, sha256: string}, prova: {arquivo: string}}|null}} opcoes
 * @param {{pool: object, armazenamento: object, processador: object, diretorioEfetivo: string, saida?: {log: Function, error: Function}, agora?: Function, raizRepositorio?: string}} dependencias
 */
async function executarComando({ modo, id, destino, diretorio, artefatos = null }, { pool, armazenamento, processador, diretorioEfetivo, saida = console, agora = Date.now, raizRepositorio = path.resolve(__dirname, '..') } = {}) {
  if (!['SIMULAR', 'EXECUTAR'].includes(modo)) throw new TypeError('modo inválido');
  try {
    if (diretorioEfetivo !== diretorio) throw falhar('DIRETORIO_NAO_AUTORIZADO', 'o diretório de imagens do ambiente não é o autorizado');
    if (modo === 'EXECUTAR' && artefatos === null) throw falhar('PRE_CONDICOES_AUSENTES', 'a execução exige backup, inventário e prova de restauração');
    let conferidos = null;
    if (artefatos !== null) {
      conferidos = await validarArtefatos({ artefatos, diretorioImagens: diretorio, raizRepositorio, agora });
      saida.log(`Artefatos conferidos: backup sha256 ${resumir(conferidos.backupSha)}, inventário sha256 ${resumir(conferidos.inventarioSha)}, prova de restauração sha256 ${resumir(conferidos.provaSha)}.`);
    }
    const resultado = await corrigir({ modo, id, destino, conferidos, diretorioImagens: diretorio }, { pool, armazenamento, processador });
    imprimir(saida, resultado, destino.banco);
    return { saida: SAIDAS.OK, resultado };
  } catch (erro) {
    if (erro instanceof ErroExibicao) {
      imprimirRecusa(saida, erro);
      return { saida: codigoDeSaida(erro.codigo), resultado: null, codigo: erro.codigo };
    }
    throw erro;
  }
}

/** Armazenamento aberto só na primeira chamada (depois da conferência do destino); na simulação não grava nem remove, e um diretório inexistente nunca é criado. */
function criarArmazenamento(modo, diretorio) {
  let real = null;
  const doDisco = () => {
    if (real === null) {
      let info;
      try { info = fs.lstatSync(diretorio); } catch { throw falhar('DIRETORIO_NAO_AUTORIZADO', 'o diretório de imagens não existe'); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw falhar('DIRETORIO_NAO_AUTORIZADO', 'o diretório de imagens não é um diretório comum');
      const { criarArmazenamentoImagens } = require('../src/storage/armazenamento-imagens');
      real = criarArmazenamentoImagens({ diretorio });
    }
    return real;
  };
  const somenteLeitura = async () => { throw new Error('armazenamento somente leitura'); };
  return Object.freeze({
    existe: async (...a) => doDisco().existe(...a),
    abrir: async (...a) => doDisco().abrir(...a),
    gravar: modo === 'EXECUTAR' ? async (...a) => doDisco().gravar(...a) : somenteLeitura,
    remover: modo === 'EXECUTAR' ? async (...a) => doDisco().remover(...a) : somenteLeitura,
  });
}

function descreverFalha(erro) {
  const tecnico = [erro?.codigo, erro?.code].find((codigo) => typeof codigo === 'string' && /^[A-Za-z0-9_.]{1,40}$/.test(codigo));
  return tecnico ?? 'erro inesperado';
}

async function principal() {
  const interpretado = interpretarArgumentos(process.argv.slice(2));
  if (!interpretado.ok) {
    console.error(`Argumentos inválidos: ${interpretado.erro}`);
    console.error(uso());
    return SAIDAS.ARGUMENTOS;
  }
  const { lerConfiguracao: lerConfig, exigirDiretorio } = require('../src/config/imagens');
  let diretorioEfetivo;
  try { diretorioEfetivo = exigirDiretorio(lerConfig(process.env)); } catch {
    console.error('Recusado (DIRETORIO_NAO_AUTORIZADO): IMAGENS_ARMAZENAMENTO_DIRETORIO não está configurado.');
    return SAIDAS.ARGUMENTOS;
  }
  const ambiente = [process.env.DB_NAME, process.env.DB_HOST, process.env.DB_PORT ?? '5432'].map((valor) => nomeSeguro(valor ?? '(não definido)'));
  console.log(`Ambiente (DB_*): banco ${ambiente[0]} em ${ambiente[1]}:${ambiente[2]}; modo ${interpretado.modo === 'EXECUTAR' ? 'EXECUTAR (grava)' : 'SIMULAR (não grava)'}`);
  console.log(`Destino autorizado: banco ${nomeSeguro(interpretado.destino.banco)} (oid ${nomeSeguro(interpretado.destino.oid)}); conferido na conexão antes de ler o registro`);
  const armazenamento = criarArmazenamento(interpretado.modo, diretorioEfetivo);
  const { criarProcessadorDeImagens } = require('../src/services/imagem-processador.service');
  const processador = criarProcessadorDeImagens();
  const { pool } = require('../src/config/database');
  try {
    return (await executarComando(interpretado, { pool, armazenamento, processador, diretorioEfetivo })).saida;
  } finally {
    await processador.encerrarTodos();
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${descreverFalha(erro)}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = {
  interpretarArgumentos, executarComando, criarArmazenamento, uso, SAIDAS, ErroExibicao, SQL_IMPRESSAO, calcularImpressao, validarArtefatos, VALIDADE_ARTEFATOS_MS,
};
