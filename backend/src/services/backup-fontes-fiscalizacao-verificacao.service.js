'use strict';

const crypto = require('node:crypto');
const fsNode = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const repositorio = require('../repositories/fiscalizacao-verificacao.repository');
const { identificarBanco: identificarBancoDaConexao } = require('../repositories/imagem-verificacao.repository');
const { nomeSeguro } = require('../utils/pacote-padrao-erros');

/**
 * Verificador da fonte `fiscalizacao-pacotes` (D-ORF-6, P3; ZIPs do Relatório de Fiscalização, 12K-D6). SOMENTE LEITURA, do início ao fim:
 *   - no banco, só SELECT dentro de uma transação READ ONLY e REPEATABLE READ, sempre encerrada com ROLLBACK;
 *   - no disco, só lstat, readdir, realpath e open com O_RDONLY | O_NOFOLLOW (a fachada recebida, ou a padrão, expõe apenas isso).
 * Nunca cria, apaga, move, corrige, restaura nem toca em registro algum. A classificação da fonte (D-F1) continua pendente: este módulo
 * não a decide nem a promove; ele produz a evidência que qualquer classe PROTEGIDA exigiria.
 *
 * Cruza as REFERÊNCIAS do banco (`fiscalizacao_pacotes`: empresa_id, status, chave_armazenamento, sha256, tamanho_bytes) com os ARQUIVOS em
 * `FISCALIZACAO_ARMAZENAMENTO_DIRETORIO` (`<empresa>/pacote-<id>.zip`) e classifica cada pacote CONCLUIDO e cada sobra:
 *   INTEGRO     — arquivo existe, é regular, tem o tamanho, o SHA-256 e a assinatura ZIP do registro.
 *   RECUPERAVEL — registro CONCLUIDO íntegro e arquivo AUSENTE (sintoma do achado ACH-FISC-01): restaura-se do backup e confere-se o SHA-256.
 *   INVESTIGAR  — divergência de conteúdo, entrada imprópria (link, tipo errado), registro inconsistente (chave fora do formato, empresa da chave
 *                 diferente da linha, hash ou tamanho inválidos), estrutura estranha, empresa inexistente ou leitura que falhou. Ninguém corrige sozinho.
 *   ORFAO       — arquivo sem registro CONCLUIDO que o reivindique (resíduo .tmp, ZIP de tentativa FALHA, ZIP sem linha). Não é dano.
 * O veredito é a PIOR classe presente (INTEGRO < ORFAO < RECUPERAVEL < INVESTIGAR).
 *
 * Isolamento por empresa: um registro só reivindica arquivo na pasta da própria empresa (primeiro segmento da chave = empresa_id); nunca cruza.
 * Geração em curso: o arquivo (.tmp ou .zip) de uma tentativa GERANDO, ou qualquer arquivo mais novo que a idade mínima, é listado como `recente` e
 * fica fora dos contadores e do veredito (o ZIP é publicado ANTES de a linha virar CONCLUIDO). O relatório é uma fotografia.
 *
 * Caminhos: nada vindo do disco entra num caminho; os caminhos são montados só de valores validados do registro. Nomes estranhos lidos do disco são
 * apenas descritos (escapados). Link simbólico em qualquer nível é recusado e nunca seguido. O relatório nunca leva caminho absoluto.
 */

const FONTE = 'fiscalizacao-pacotes';
const CLASSES = Object.freeze({ INTEGRO: 'INTEGRO', ORFAO: 'ORFAO', RECUPERAVEL: 'RECUPERAVEL', INVESTIGAR: 'INVESTIGAR' });
const GRAVIDADE = Object.freeze({ INTEGRO: 0, ORFAO: 1, RECUPERAVEL: 2, INVESTIGAR: 3 });
const TIPOS = Object.freeze({
  ARQUIVO_AUSENTE: 'ARQUIVO_AUSENTE',
  TAMANHO_DIVERGENTE: 'TAMANHO_DIVERGENTE',
  SHA256_DIVERGENTE: 'SHA256_DIVERGENTE',
  ASSINATURA_DIVERGENTE: 'ASSINATURA_DIVERGENTE',
  ENTRADA_IMPROPRIA: 'ENTRADA_IMPROPRIA',
  LEITURA_FALHOU: 'LEITURA_FALHOU',
  REGISTRO_INVALIDO: 'REGISTRO_INVALIDO',
  EMPRESA_DIVERGENTE: 'EMPRESA_DIVERGENTE',
  SOBRA_SEM_REGISTRO: 'SOBRA_SEM_REGISTRO',
  SOBRA_DE_TENTATIVA_FALHA: 'SOBRA_DE_TENTATIVA_FALHA',
  SOBRA_TEMPORARIO: 'SOBRA_TEMPORARIO',
  EM_GERACAO: 'EM_GERACAO',
  EMPRESA_INEXISTENTE: 'EMPRESA_INEXISTENTE',
  ESTRUTURA_ESTRANHA: 'ESTRUTURA_ESTRANHA',
});
const ALERTAS = Object.freeze({
  RAIZ_AUSENTE: 'RAIZ_AUSENTE',
  RAIZ_INVALIDA: 'RAIZ_INVALIDA',
  NENHUM_ARQUIVO_ESPERADO_PRESENTE: 'NENHUM_ARQUIVO_ESPERADO_PRESENTE',
  BANCO_SEM_REGISTROS_COM_ARQUIVOS: 'BANCO_SEM_REGISTROS_COM_ARQUIVOS',
});
const LIMITES = Object.freeze([
  'SOMENTE_LEITURA: nada é criado, removido, corrigido ou restaurado',
  'FOTOGRAFIA: banco em REPEATABLE READ, disco lido em seguida; não prova consistência temporal entre os dois',
  'NAO_PROVA_RESTAURABILIDADE: íntegro no disco não significa coberto por backup nem restaurável',
  'NAO_DECIDE_CLASSE: a classificação da fonte (D-F1) continua pendente',
]);

const CHAVE_FORMATO = /^([1-9][0-9]{0,14})\/pacote-([1-9][0-9]{0,14})\.zip$/;
const NOME_EMPRESA = /^[1-9][0-9]{0,14}$/;
const NOME_ARQUIVO = /^pacote-([1-9][0-9]{0,14})\.(zip|tmp)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODIGO_DO_SISTEMA = /^[A-Z][A-Z0-9_]{1,30}$/;
const ASSINATURAS_ZIP = Object.freeze([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1')]);
const BYTES_DE_ASSINATURA = 4;
const BLOCO_DE_LEITURA = 256 * 1024;
const TAMANHO_MAXIMO = 1024 * 1024 * 1024;
const IDADE_MINIMA_RECENTE_PADRAO_MINUTOS = 60;
const IDADE_MINIMA_RECENTE_MAXIMA_MINUTOS = 525600;
const PAGINA_PADRAO = 500;

/** Fachada padrão do sistema de arquivos: SÓ as operações de leitura que o verificador usa. */
const FS_DE_LEITURA = Object.freeze({ lstat: fsp.lstat, readdir: fsp.readdir, realpath: fsp.realpath, open: fsp.open, constants: fsNode.constants });

const codigoDoSistema = (falha) => (typeof falha?.code === 'string' && CODIGO_DO_SISTEMA.test(falha.code) ? falha.code : 'DESCONHECIDO');
const piorClasse = (classes) => classes.reduce((pior, atual) => (GRAVIDADE[atual] > GRAVIDADE[pior] ? atual : pior), CLASSES.INTEGRO);
const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compararIds = (a, b) => comparar(BigInt(a), BigInt(b));

function validarOpcoes(pool, opcoes) {
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') throw new TypeError('pool do banco inválido');
  if (opcoes === null || typeof opcoes !== 'object') throw new TypeError('opções inválidas');
  const { diretorio, idadeMinimaRecenteMinutos = IDADE_MINIMA_RECENTE_PADRAO_MINUTOS, agora = Date.now, fs = FS_DE_LEITURA, tamanhoDaPagina = PAGINA_PADRAO } = opcoes;
  if (typeof diretorio !== 'string' || diretorio.trim() === '' || !path.isAbsolute(diretorio) || diretorio.includes('\0')) throw new TypeError('diretório inválido');
  if (!Number.isInteger(idadeMinimaRecenteMinutos) || idadeMinimaRecenteMinutos < 0 || idadeMinimaRecenteMinutos > IDADE_MINIMA_RECENTE_MAXIMA_MINUTOS) throw new TypeError('idade mínima inválida');
  if (typeof agora !== 'function') throw new TypeError('relógio inválido');
  if (!Number.isInteger(tamanhoDaPagina) || tamanhoDaPagina < 1 || tamanhoDaPagina > repositorio.LIMITE_MAXIMO) throw new TypeError('tamanho de página inválido');
  for (const nome of ['lstat', 'readdir', 'realpath', 'open']) if (typeof fs?.[nome] !== 'function') throw new TypeError('fachada de arquivos inválida');
  if (fs.constants === null || typeof fs.constants !== 'object') throw new TypeError('fachada de arquivos inválida');
  return { diretorio: path.resolve(diretorio), idadeMinimaRecenteMinutos, agora, fs, tamanhoDaPagina };
}

// ------------------------------------------------------------------------------------------------------------------------- banco
async function paginar(buscar, tamanho) {
  const todos = [];
  let depoisDe = '0';
  for (;;) {
    const pagina = await buscar(depoisDe);
    todos.push(...pagina);
    if (pagina.length < tamanho) return todos;
    depoisDe = pagina[pagina.length - 1].id;
  }
}

/** Uma fotografia consistente do banco: tudo numa transação READ ONLY e REPEATABLE READ, sempre desfeita no fim. */
async function lerBanco(pool, tamanhoDaPagina) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const pacotes = await paginar((depoisDe) => repositorio.listarPacotes(cliente, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina);
    const empresas = new Set(await repositorio.listarIdsDeEmpresas(cliente));
    return { pacotes, empresas };
  } finally {
    try { await cliente.query('ROLLBACK'); } catch { /* a conexão pode já estar inutilizada; o ROLLBACK é só higiene */ }
    cliente.release();
  }
}

// ------------------------------------------------------------------------------------------------------------------------- disco
async function resolverRaiz(fs, diretorio) {
  let raiz;
  try { raiz = await fs.realpath(diretorio); } catch (falha) { return { alerta: falha?.code === 'ENOENT' ? ALERTAS.RAIZ_AUSENTE : ALERTAS.RAIZ_INVALIDA }; }
  try {
    const estado = await fs.lstat(raiz);
    if (!estado.isDirectory()) return { alerta: ALERTAS.RAIZ_INVALIDA };
  } catch { return { alerta: ALERTAS.RAIZ_INVALIDA }; }
  return { raiz };
}

async function estadoDe(ctx, partes) {
  try {
    const estado = await ctx.fs.lstat(path.join(ctx.raiz, ...partes));
    if (estado.isSymbolicLink()) return { tipo: 'LINK' };
    if (estado.isDirectory()) return { tipo: 'DIRETORIO', mtimeMs: estado.mtimeMs };
    if (estado.isFile()) return { tipo: 'ARQUIVO', tamanho: estado.size, mtimeMs: estado.mtimeMs };
    return { tipo: 'OUTRO' };
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { tipo: 'AUSENTE' };
    return { tipo: 'FALHA', codigoSistema: codigoDoSistema(falha) };
  }
}

/** Lê o arquivo sem seguir link, até o tamanho esperado (+1 byte, para notar crescimento), calculando o SHA-256 e guardando a assinatura. */
async function lerConteudo(ctx, partes, bytesEsperados) {
  let identificador;
  try {
    identificador = await ctx.fs.open(path.join(ctx.raiz, ...partes), ctx.fs.constants.O_RDONLY | ctx.fs.constants.O_NOFOLLOW);
  } catch (falha) { return { falha }; }
  try {
    const estado = await identificador.stat();
    if (!estado.isFile()) return { naoRegular: true };
    if (estado.size !== bytesEsperados) return { tamanho: estado.size };
    const hash = crypto.createHash('sha256');
    const inicio = Buffer.alloc(BYTES_DE_ASSINATURA);
    const bloco = Buffer.allocUnsafe(BLOCO_DE_LEITURA);
    let capturados = 0;
    let total = 0;
    for (;;) {
      const { bytesRead } = await identificador.read(bloco, 0, bloco.length, null);
      if (bytesRead === 0) break;
      if (capturados < BYTES_DE_ASSINATURA) {
        const quanto = Math.min(BYTES_DE_ASSINATURA - capturados, bytesRead);
        bloco.copy(inicio, capturados, 0, quanto);
        capturados += quanto;
      }
      hash.update(bloco.subarray(0, bytesRead));
      total += bytesRead;
      if (total > bytesEsperados) return { tamanho: total };
    }
    if (total !== bytesEsperados) return { tamanho: total };
    return { sha256: hash.digest('hex'), assinaturaZip: ASSINATURAS_ZIP.some((a) => inicio.subarray(0, a.length).equals(a)) };
  } catch (falha) {
    return { falha };
  } finally {
    await identificador.close().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------------------------------- registros → arquivos esperados
function planejar(linha) {
  const plano = { id: linha.id, empresaId: linha.empresaId, status: linha.status, chave: null, partes: null, invalido: null, sha256: null, tamanho: null };
  if (linha.status === 'CONCLUIDO') {
    const m = typeof linha.chaveArmazenamento === 'string' ? CHAVE_FORMATO.exec(linha.chaveArmazenamento) : null;
    if (m === null) plano.invalido = 'chave_armazenamento';
    else if (m[2] !== linha.id) plano.invalido = 'chave_armazenamento';
    else if (m[1] !== linha.empresaId) plano.invalido = 'empresa';
    else if (!(typeof linha.sha256 === 'string' && SHA256.test(linha.sha256))) plano.invalido = 'sha256';
    else if (!(Number.isInteger(linha.tamanhoBytes) && linha.tamanhoBytes > 0 && linha.tamanhoBytes <= TAMANHO_MAXIMO)) plano.invalido = 'tamanho_bytes';
    else { plano.chave = linha.chaveArmazenamento; plano.partes = [m[1], `pacote-${m[2]}.zip`]; plano.sha256 = linha.sha256; plano.tamanho = linha.tamanhoBytes; }
  } else if (linha.status !== 'GERANDO' && linha.status !== 'FALHA') {
    plano.invalido = 'status';
  }
  return plano;
}

async function conferirPacote(ctx, plano, contagem) {
  const estado = await estadoDe(ctx, plano.partes);
  if (estado.tipo === 'AUSENTE') { contagem.ausentes += 1; return { tipo: TIPOS.ARQUIVO_AUSENTE, classe: CLASSES.RECUPERAVEL, sintoma: 'ACH-FISC-01' }; }
  if (estado.tipo === 'FALHA') { contagem.naoVerificados += 1; return { tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR, codigoSistema: estado.codigoSistema }; }
  if (estado.tipo !== 'ARQUIVO') { contagem.naoVerificados += 1; return { tipo: TIPOS.ENTRADA_IMPROPRIA, classe: CLASSES.INVESTIGAR, entrada: estado.tipo === 'LINK' ? 'LINK_SIMBOLICO' : estado.tipo }; }
  if (estado.tamanho !== plano.tamanho) { contagem.divergentes += 1; return { tipo: TIPOS.TAMANHO_DIVERGENTE, classe: CLASSES.INVESTIGAR, esperado: plano.tamanho, encontrado: estado.tamanho }; }
  const conteudo = await lerConteudo(ctx, plano.partes, plano.tamanho);
  if (conteudo.falha) { contagem.naoVerificados += 1; return { tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR, codigoSistema: codigoDoSistema(conteudo.falha) }; }
  if (conteudo.naoRegular) { contagem.naoVerificados += 1; return { tipo: TIPOS.ENTRADA_IMPROPRIA, classe: CLASSES.INVESTIGAR, entrada: 'NAO_REGULAR' }; }
  if (conteudo.tamanho !== undefined) { contagem.divergentes += 1; return { tipo: TIPOS.TAMANHO_DIVERGENTE, classe: CLASSES.INVESTIGAR, esperado: plano.tamanho, encontrado: conteudo.tamanho }; }
  if (conteudo.sha256 !== plano.sha256) { contagem.divergentes += 1; return { tipo: TIPOS.SHA256_DIVERGENTE, classe: CLASSES.INVESTIGAR }; }
  if (!conteudo.assinaturaZip) { contagem.divergentes += 1; return { tipo: TIPOS.ASSINATURA_DIVERGENTE, classe: CLASSES.INVESTIGAR }; }
  contagem.integros += 1;
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------- varredura das sobras
function sobra(ctx, { empresaId, nome, tipo, classe, bytes = null, mtimeMs = null, pacoteId = null }) {
  const recente = mtimeMs !== null && ctx.agora - mtimeMs < ctx.idadeMinima * 60000;
  ctx.sobras.push({ empresaId, nome: nomeSeguro(nome), pacoteId, tipo, classe, bytes, recente });
}

async function varrerRaiz(ctx) {
  let entradas;
  try { entradas = await ctx.fs.readdir(ctx.raiz, { withFileTypes: true }); } catch (falha) {
    ctx.alertas.push({ codigo: ALERTAS.RAIZ_INVALIDA, classe: CLASSES.INVESTIGAR, codigoSistema: codigoDoSistema(falha) });
    return;
  }
  for (const entrada of [...entradas].sort((a, b) => comparar(a.name, b.name))) {
    if (entrada.isSymbolicLink()) { sobra(ctx, { empresaId: null, nome: entrada.name, tipo: TIPOS.ENTRADA_IMPROPRIA, classe: CLASSES.INVESTIGAR }); continue; }
    if (!entrada.isDirectory() || !NOME_EMPRESA.test(entrada.name)) { sobra(ctx, { empresaId: null, nome: entrada.name, tipo: TIPOS.ESTRUTURA_ESTRANHA, classe: CLASSES.INVESTIGAR }); continue; }
    await varrerEmpresa(ctx, entrada.name);
  }
}

async function varrerEmpresa(ctx, empresaId) {
  let entradas;
  try { entradas = await ctx.fs.readdir(path.join(ctx.raiz, empresaId), { withFileTypes: true }); } catch (falha) {
    sobra(ctx, { empresaId, nome: '', tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR });
    return;
  }
  const empresaExiste = ctx.empresas.has(empresaId);
  for (const entrada of [...entradas].sort((a, b) => comparar(a.name, b.name))) {
    if (entrada.isSymbolicLink()) { sobra(ctx, { empresaId, nome: entrada.name, tipo: TIPOS.ENTRADA_IMPROPRIA, classe: CLASSES.INVESTIGAR }); continue; }
    const m = entrada.isFile() ? NOME_ARQUIVO.exec(entrada.name) : null;
    if (m === null) { sobra(ctx, { empresaId, nome: entrada.name, tipo: TIPOS.ESTRUTURA_ESTRANHA, classe: CLASSES.INVESTIGAR }); continue; }
    const [, pacoteId, extensao] = m;
    const chave = `${empresaId}/${entrada.name}`;
    if (extensao === 'zip' && ctx.reivindicadas.has(chave)) continue;
    const estado = await estadoDe(ctx, [empresaId, entrada.name]);
    const bytes = estado.tipo === 'ARQUIVO' ? estado.tamanho : null;
    const mtimeMs = estado.tipo === 'ARQUIVO' ? estado.mtimeMs : null;
    if (!empresaExiste) { sobra(ctx, { empresaId, nome: entrada.name, pacoteId, tipo: TIPOS.EMPRESA_INEXISTENTE, classe: CLASSES.INVESTIGAR, bytes, mtimeMs }); continue; }
    const status = ctx.statusPorPacote.get(`${empresaId}/${pacoteId}`) ?? null;
    if (status === 'GERANDO') { sobra(ctx, { empresaId, nome: entrada.name, pacoteId, tipo: TIPOS.EM_GERACAO, classe: CLASSES.INTEGRO, bytes, mtimeMs: ctx.agora }); continue; }
    if (extensao === 'tmp') { sobra(ctx, { empresaId, nome: entrada.name, pacoteId, tipo: TIPOS.SOBRA_TEMPORARIO, classe: CLASSES.ORFAO, bytes, mtimeMs }); continue; }
    sobra(ctx, { empresaId, nome: entrada.name, pacoteId, tipo: status === 'FALHA' ? TIPOS.SOBRA_DE_TENTATIVA_FALHA : TIPOS.SOBRA_SEM_REGISTRO, classe: CLASSES.ORFAO, bytes, mtimeMs });
  }
}

// ------------------------------------------------------------------------------------------------------------------------- relatório
function relatorioBase(instante, idadeMinima) {
  return { versao: 1, fonte: FONTE, geradoEm: new Date(instante).toISOString(), idadeMinimaRecenteMinutos: idadeMinima, limites: [...LIMITES] };
}

function relatorioDeRaizInutilizavel(instante, idadeMinima, alerta) {
  return Object.freeze({
    ...relatorioBase(instante, idadeMinima), veredito: CLASSES.INVESTIGAR, raiz: { estado: alerta }, registros: null, pacotes: [], sobras: [],
    resumo: { esperados: 0, integros: 0, ausentes: 0, divergentes: 0, naoVerificados: 0, sobras: 0, recentes: 0 }, alertas: [{ codigo: alerta, classe: CLASSES.INVESTIGAR }],
  });
}

const ordemDePacote = (a, b) => compararIds(a.empresaId, b.empresaId) || compararIds(a.pacoteId, b.pacoteId);

async function verificarFiscalizacao(pool, opcoes) {
  const { diretorio, idadeMinimaRecenteMinutos, agora, fs, tamanhoDaPagina } = validarOpcoes(pool, opcoes);
  const instante = Number(agora());
  if (!Number.isFinite(instante)) throw new TypeError('relógio inválido');

  const resolvida = await resolverRaiz(fs, diretorio);
  if (resolvida.alerta) return relatorioDeRaizInutilizavel(instante, idadeMinimaRecenteMinutos, resolvida.alerta);

  const banco = await lerBanco(pool, tamanhoDaPagina);
  const ctx = { fs, raiz: resolvida.raiz, agora: instante, idadeMinima: idadeMinimaRecenteMinutos, empresas: banco.empresas, reivindicadas: new Set(), statusPorPacote: new Map(), sobras: [], alertas: [] };
  const planos = banco.pacotes.map(planejar);
  for (const p of planos) {
    ctx.statusPorPacote.set(`${p.empresaId}/${p.id}`, p.status);
    if (p.chave !== null) ctx.reivindicadas.add(p.chave);
  }

  const contagem = { esperados: 0, integros: 0, ausentes: 0, divergentes: 0, naoVerificados: 0 };
  const pacotes = [];
  for (const plano of planos) {
    if (plano.invalido !== null) {
      const tipo = plano.invalido === 'empresa' ? TIPOS.EMPRESA_DIVERGENTE : TIPOS.REGISTRO_INVALIDO;
      pacotes.push({ empresaId: plano.empresaId, pacoteId: plano.id, status: plano.status, classe: CLASSES.INVESTIGAR, achados: [{ tipo, classe: CLASSES.INVESTIGAR, campo: plano.invalido }] });
      continue;
    }
    if (plano.chave === null) continue;
    contagem.esperados += 1;
    const achado = await conferirPacote(ctx, plano, contagem);
    if (achado !== null) pacotes.push({ empresaId: plano.empresaId, pacoteId: plano.id, status: plano.status, chave: plano.chave, classe: achado.classe, achados: [achado] });
  }
  pacotes.sort(ordemDePacote);

  await varrerRaiz(ctx);

  const registros = {
    total: banco.pacotes.length,
    concluidos: planos.filter((p) => p.status === 'CONCLUIDO').length,
    gerando: planos.filter((p) => p.status === 'GERANDO').length,
    falha: planos.filter((p) => p.status === 'FALHA').length,
    invalidos: planos.filter((p) => p.invalido !== null).length,
  };
  const sobrasContadas = ctx.sobras.filter((s) => !s.recente && s.tipo !== TIPOS.EM_GERACAO);
  if (contagem.esperados > 0 && contagem.ausentes === contagem.esperados) ctx.alertas.push({ codigo: ALERTAS.NENHUM_ARQUIVO_ESPERADO_PRESENTE, classe: CLASSES.INVESTIGAR });
  if (registros.total === 0 && sobrasContadas.length > 0) ctx.alertas.push({ codigo: ALERTAS.BANCO_SEM_REGISTROS_COM_ARQUIVOS, classe: CLASSES.INVESTIGAR });

  const veredito = piorClasse([...pacotes.map((p) => p.classe), ...sobrasContadas.map((s) => s.classe), ...ctx.alertas.map((a) => a.classe)]);
  return Object.freeze({
    ...relatorioBase(instante, idadeMinimaRecenteMinutos),
    veredito,
    raiz: { estado: 'OK' },
    registros,
    pacotes,
    sobras: ctx.sobras,
    resumo: { ...contagem, sobras: sobrasContadas.length, recentes: ctx.sobras.length - sobrasContadas.length },
    alertas: ctx.alertas,
  });
}

/** Banco e OID da conexão, como o PostgreSQL os informa: o operador confere se o par banco/armazenamento é o certo. */
async function identificarBanco(pool) {
  return identificarBancoDaConexao(pool);
}

module.exports = {
  verificarFiscalizacao,
  identificarBanco,
  FONTE,
  CLASSES,
  TIPOS,
  ALERTAS,
  LIMITES,
  FS_DE_LEITURA,
  IDADE_MINIMA_RECENTE_PADRAO_MINUTOS,
  IDADE_MINIMA_RECENTE_MAXIMA_MINUTOS,
};
