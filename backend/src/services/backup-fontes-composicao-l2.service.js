'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarSelagem } = require('./imagem-backup-selagem.service');
const { ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');
const { criarEscritorL2, criarLeitorL2 } = require('./backup-fontes-manifesto-l2.service');
const { obterAdaptador } = require('./backup-fontes-adaptadores.service');
const { inventariar } = require('../repositories/backup-fontes-postgres-inventario.repository');
const { criarLeitorDeSumario } = require('./backup-fontes-postgres-sumario.service');
const { avaliarCoberturaPostgres, blocoN0 } = require('./backup-fontes-postgres-cobertura.service');
const { conciliarFonte, pontoDeRecuperacao, criarOrdemDeRestauracao, avaliarRestauracao } = require('./backup-fontes-consistencia.service');
const R = require('./backup-fontes-regras.service');

/**
 * D-ORF-6, P6: COMPOSIÇÃO POR FONTE do pacote LAYOUT 2 e RESTAURAÇÃO por fonte. Contrato PROVISÓRIO para chamador confiável (a composição de produção
 * histórica continua produzindo layout 1 até decisão de troca; esta é a composição evolutiva, usada por ensaio e pela homologação). Reutiliza os componentes
 * aprovados: planejadores/copiadores/restauradores por fonte (`backup-fontes-adaptadores`), inventário e leitor do P4, escritor/leitor L2 do P5, selagem
 * histórica (com o leitor L2 injetado) e a consistência cruzada do P7.
 *
 * PACOTE L2 na preparação: `arquivos/<fonteId>/<chave>`, `manifesto.json`, `manifesto.sha256`, `dump/postgres.dump` (o dump é incorporado pelo chamador, como hoje).
 *
 * `planejarNoSnapshot({ executor, catalogo, fontes, esquemaDasMigrations?, tamanhoDaPagina? })`: lê, NO MESMO executor (a transação do snapshot), o plano e as
 * referências de cada fonte com adaptador e o inventário PostgreSQL. É a função a injetar no snapshot histórico (`lerAdicionais`). Puro quanto a disco.
 *
 * `criarComposicaoL2({ catalogo, fonteDeChaves, chaveId, maxBytesPorArquivo })` -> `compor({ preparacao, planos, origens, banco, conjuntoId, dump, contexto, postgres })`:
 *   (1) cria `arquivos/` e `arquivos/<fonteId>` (mkdir NÃO recursivo, 0700, só dentro da preparação já exclusiva); (2) copia cada fonte pelo seu adaptador;
 *   (3) constrói o manifesto L2 (escritor do P5: catálogo por valor, cobertura, bloco postgres); (4) sela com a selagem histórica usando o leitor L2;
 *   (5) verifica a selagem relendo o manifesto e confere o pacote (conjunto EXATO, SHA-256 de cada arquivo). Falha em qualquer etapa interrompe as seguintes;
 *   nada é apagado. Resultado congelado `{ ok, identidade, manifesto, fontes, pacote, falha:{ estagio, codigo } }`.
 *
 * `verificarPacoteL2({ pacote, lido })`: conjunto exato e releitura (somente leitura, O_RDONLY|O_NOFOLLOW, sem seguir links).
 *
 * `restaurarL2({ pacote, destino, fonteDeChaves, layoutMinimo, maxBytesPorArquivo, referencias? })` (11.4): (1) destino NOVO 0700; (2) verificações 8.7 pela
 * selagem + leitor L2 (layout mínimo da operação) e conjunto exato; (3) o banco é do restaurador histórico (fora daqui): o chamador informa `esquema` e
 * `referencias` lidas do banco RESTAURADO; (4) restauração por fonte em `destino/<fonteId>` e conciliação (P7) contra as referências; (5) veredito
 * INTEGRO | INCONSISTENTE | INCOMPLETO, nunca recuperável. Sem referências, o passo 4 fica `INCOMPLETO` por desenho.
 *
 * LIMITES: nada aqui publica (publicação atômica e registro durável são do módulo histórico, cuja verificação de pacote ainda é layout 1 — pendência P6/P8);
 * o dump é incorporado pelo chamador; `recuperavelEmProducao` nunca é produzido.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCO = 256 * 1024;
const ESTAGIOS = Object.freeze({ ENTRADA: 'ENTRADA', AREA: 'AREA', COPIA: 'COPIA', MANIFESTO: 'MANIFESTO', SELAGEM: 'SELAGEM', VERIFICACAO: 'VERIFICACAO' });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const falha = (estagio, codigo) => Object.freeze({ ok: false, falha: Object.freeze({ estagio, codigo }) });
function entradaInvalida(motivo) {
  const e = new TypeError('entrada da composição inválida');
  e.code = 'ENTRADA_INVALIDA';
  e.motivo = motivo;
  return e;
}

async function diretorioReal(caminho) {
  try {
    const estado = await fsp.lstat(caminho);
    return estado.isDirectory() && (await fsp.realpath(caminho)) === caminho;
  } catch { return false; }
}
/** mkdir NÃO recursivo, 0700, só de um segmento novo dentro de um pai real; existente = recusa (nada é reaproveitado). */
async function criarSubdiretorio(pai, nome) {
  if (!SEGMENTO.test(nome) || nome === '.' || nome === '..' || !(await diretorioReal(pai))) return false;
  try { await fsp.mkdir(path.join(pai, nome), { recursive: false, mode: 0o700 }); } catch { return false; }
  return diretorioReal(path.join(pai, nome));
}

// ----------------------------------------------------------------------------------------------------------------------------------- leitura no snapshot
async function planejarNoSnapshot(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['executor', 'catalogo', 'fontes', 'esquemaDasMigrations', 'tamanhoDaPagina'].includes(k))) throw entradaInvalida('ENTRADA');
  const { executor, catalogo, fontes, esquemaDasMigrations, tamanhoDaPagina } = entrada;
  if (!ehObjeto(executor) || typeof executor.query !== 'function') throw entradaInvalida('EXECUTOR');
  if (!R.validarCatalogo(catalogo).valido) throw entradaInvalida('CATALOGO_INVALIDO');
  if (!Array.isArray(fontes) || new Set(fontes).size !== fontes.length) throw entradaInvalida('FONTES');
  const planos = {};
  for (const id of [...fontes].sort()) {
    const adaptador = obterAdaptador(id, catalogo);
    planos[id] = await adaptador.planejar(executor, tamanhoDaPagina === undefined ? {} : { tamanhoDaPagina });
  }
  const inventario = await inventariar(executor, esquemaDasMigrations === undefined ? undefined : { esquemaDasMigrations });
  return Object.freeze({ planos: Object.freeze(planos), inventario });
}

// --------------------------------------------------------------------------------------------------------------------------------- verificação do pacote
async function percorrer(raiz) {
  const arquivos = [];
  const pilha = [''];
  while (pilha.length > 0) {
    const rel = pilha.pop();
    const entradas = await fsp.readdir(path.join(raiz, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
    for (const e of entradas) {
      const relFilho = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) throw Object.assign(new Error('link'), { codigo: 'LINK_SIMBOLICO' });
      if (e.isDirectory()) pilha.push(relFilho);
      else if (e.isFile()) arquivos.push(relFilho);
      else throw Object.assign(new Error('tipo'), { codigo: 'ENTRADA_INVALIDA' });
    }
  }
  return arquivos.sort();
}
async function hashDoArquivo(caminho) {
  const descritor = await fsp.open(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const estado = await descritor.stat();
    if (!estado.isFile()) return null;
    const hash = crypto.createHash('sha256');
    const bloco = Buffer.alloc(BLOCO);
    let total = 0;
    for (;;) {
      const { bytesRead } = await descritor.read(bloco, 0, BLOCO, null);
      if (bytesRead === 0) break;
      hash.update(bloco.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { bytes: total, sha256: hash.digest('hex') };
  } finally { await descritor.close(); }
}

/** Conjunto EXATO do pacote L2 e releitura de cada arquivo contra o manifesto lido (resultado do leitor L2, já autenticado). */
async function verificarPacoteL2({ pacote, lido }) {
  if (!caminhoAbsolutoCanonico(pacote) || !ehObjeto(lido) || !Array.isArray(lido.fontes) || !ehObjeto(lido.manifesto) || !ehObjeto(lido.identidade)) return Object.freeze({ ok: false, motivo: 'ENTRADA_INVALIDA' });
  if (!(await diretorioReal(pacote))) return Object.freeze({ ok: false, motivo: 'PACOTE_INVALIDO' });
  let arvore;
  try { arvore = await percorrer(pacote); } catch (e) { return Object.freeze({ ok: false, motivo: e?.codigo === 'LINK_SIMBOLICO' ? 'LINK_SIMBOLICO' : 'LEITURA_FALHOU' }); }
  const esperados = new Map();
  for (const fonte of lido.fontes) for (const a of fonte.arquivos) esperados.set(lido.caminhoDe(fonte.id, a.chave), { bytes: a.bytes, sha256: a.sha256 });
  esperados.set('manifesto.json', { sha256: lido.identidade.sha256Manifesto });
  esperados.set('manifesto.sha256', null);
  esperados.set(lido.manifesto.dump.arquivo, { bytes: lido.manifesto.dump.bytes, sha256: lido.manifesto.dump.sha256 });
  for (const rel of esperados.keys()) if (!arvore.includes(rel)) return Object.freeze({ ok: false, motivo: 'ARQUIVO_AUSENTE' });
  for (const rel of arvore) if (!esperados.has(rel)) return Object.freeze({ ok: false, motivo: 'ARQUIVO_EXTRA' });
  try {
    for (const [rel, esperado] of esperados) {
      const caminho = path.join(pacote, ...rel.split('/'));
      if (esperado === null) {
        const texto = await fsp.readFile(caminho, 'utf8');
        if (texto !== `${lido.identidade.sha256Manifesto}  manifesto.json\n`) return Object.freeze({ ok: false, motivo: 'SELO_DIVERGENTE' });
        continue;
      }
      const real = await hashDoArquivo(caminho);
      if (real === null) return Object.freeze({ ok: false, motivo: 'ARQUIVO_AUSENTE' });
      if (real.sha256 !== esperado.sha256 || (esperado.bytes !== undefined && real.bytes !== esperado.bytes)) return Object.freeze({ ok: false, motivo: rel === 'manifesto.json' ? 'MANIFESTO_ADULTERADO' : 'ARQUIVO_DIVERGENTE' });
    }
  } catch { return Object.freeze({ ok: false, motivo: 'LEITURA_FALHOU' }); }
  return Object.freeze({ ok: true, arquivos: arvore.length, sha256Manifesto: lido.identidade.sha256Manifesto, layout: lido.layout });
}

// --------------------------------------------------------------------------------------------------------------------------------------- composição
function criarComposicaoL2(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['catalogo', 'fonteDeChaves', 'chaveId', 'maxBytesPorArquivo'].includes(k))) throw entradaInvalida('OPCOES');
  const { catalogo, fonteDeChaves, chaveId, maxBytesPorArquivo } = opcoes;
  if (!R.validarCatalogo(catalogo).valido) throw entradaInvalida('CATALOGO_INVALIDO');
  if (!ehFonteDeChaves(fonteDeChaves) || !inteiroPositivo(maxBytesPorArquivo)) throw entradaInvalida('OPCOES');
  const escritor = criarEscritorL2({ fonteDeChaves, chaveId });
  const selagem = criarSelagem({ leitor: criarLeitorL2({ fonteDeChaves, layoutMinimo: 2 }) });

  async function compor(entrada) {
    if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['preparacao', 'planos', 'origens', 'banco', 'conjuntoId', 'dump', 'contexto', 'postgres'].includes(k))) return falha(ESTAGIOS.ENTRADA, 'ENTRADA_INVALIDA');
    const { preparacao, planos, origens, banco, conjuntoId, dump, contexto, postgres } = entrada;
    if (!caminhoAbsolutoCanonico(preparacao) || !ehObjeto(planos) || !ehObjeto(origens)) return falha(ESTAGIOS.ENTRADA, 'ENTRADA_INVALIDA');
    const ids = Object.keys(planos).sort();
    const adaptadores = {};
    try { for (const id of ids) { adaptadores[id] = obterAdaptador(id, catalogo); if (!ehObjeto(origens[id])) return falha(ESTAGIOS.ENTRADA, 'ORIGEM_AUSENTE'); } } catch { return falha(ESTAGIOS.ENTRADA, 'ADAPTADOR_INDISPONIVEL'); }
    if (!(await diretorioReal(preparacao))) return falha(ESTAGIOS.AREA, 'AREA_INVALIDA');
    if (!(await criarSubdiretorio(preparacao, 'arquivos'))) return falha(ESTAGIOS.AREA, 'DESTINO_EXISTENTE');
    const fontesDeDados = [];
    const relatorio = {};
    for (const id of ids) {
      if (!(await criarSubdiretorio(path.join(preparacao, 'arquivos'), id))) return falha(ESTAGIOS.AREA, 'DESTINO_EXISTENTE');
      let copia;
      try { copia = await adaptadores[id].copiar({ origem: origens[id], destinoDir: path.join(preparacao, 'arquivos', id), plano: planos[id].plano, maxBytesPorArquivo }); } catch { return falha(ESTAGIOS.COPIA, 'COPIA_FALHOU'); }
      if (!ehObjeto(copia) || copia.ok !== true || copia.completo !== true || !Array.isArray(copia.arquivos)) return falha(ESTAGIOS.COPIA, typeof copia?.falha?.codigo === 'string' ? copia.falha.codigo : 'COPIA_FALHOU');
      fontesDeDados.push({ id, arquivos: copia.arquivos.map((a) => ({ chave: a.chave, sha256: a.sha256, bytes: a.bytes })) });
      relatorio[id] = Object.freeze({ planejados: planos[id].plano.length, copiados: copia.copiados });
    }
    // Releitura FÍSICA independente de tudo o que foi copiado (tamanho e SHA-256 contra o que o copiador declarou): o equivalente, no L2, à verificação de imagens copiadas do L1.
    let examinados = 0;
    let bytesExaminados = 0;
    try {
      for (const fonte of fontesDeDados) {
        for (const a of fonte.arquivos) {
          const real = await hashDoArquivo(path.join(preparacao, 'arquivos', fonte.id, ...a.chave.split('/')));
          if (real === null || real.sha256 !== a.sha256 || real.bytes !== a.bytes) return falha(ESTAGIOS.COPIA, 'INTEGRIDADE_DIVERGENTE');
          examinados += 1;
          bytesExaminados += real.bytes;
        }
      }
    } catch { return falha(ESTAGIOS.COPIA, 'COPIA_FALHOU'); }
    const verificacao = Object.freeze({ classe: 'INTEGRA', verificacao: Object.freeze({ concluida: true, ok: true, examinados, bytes: bytesExaminados }) });
    let escrito;
    try { escrito = escritor.construir({ banco, conjuntoId, dump, catalogo, fontes: fontesDeDados, contexto, postgres }); } catch (e) { return falha(ESTAGIOS.MANIFESTO, typeof e?.motivo === 'string' ? e.motivo : 'MANIFESTO_INVALIDO'); }
    let selado;
    try { selado = await selagem.selar({ area: preparacao, resultado: escrito }); } catch { return falha(ESTAGIOS.SELAGEM, 'ESCRITA_FALHOU'); }
    if (!ehObjeto(selado) || selado.ok !== true) return falha(ESTAGIOS.SELAGEM, typeof selado?.falha?.codigo === 'string' ? selado.falha.codigo : 'ESCRITA_FALHOU');
    let verificado;
    try { verificado = await selagem.verificar({ area: preparacao, esperado: escrito.identidade }); } catch { return falha(ESTAGIOS.VERIFICACAO, 'LEITURA_FALHOU'); }
    if (!ehObjeto(verificado) || verificado.ok !== true) return falha(ESTAGIOS.VERIFICACAO, typeof verificado?.falha?.codigo === 'string' ? verificado.falha.codigo : 'MANIFESTO_INVALIDO');
    // `selado`/`arquivos`/`verificacao`: a mesma forma que o encadeamento histórico consome da composição L1 (consistência plano × cópia).
    return Object.freeze({ ok: true, selado: true, arquivos: examinados, verificacao, identidade: escrito.identidade, manifesto: escrito.manifesto, fontes: Object.freeze(relatorio), layout: 2, escrito });
  }
  return Object.freeze({ compor });
}

/** Bloco `cobertura.postgres` a partir do inventário lido no snapshot e do sumário capturado pelo lançador estrutural (observador `aoDado` do P6). */
function avaliarPostgresDoSnapshot({ inventario, leitorDeSumario, migrationsDoCodigo }) {
  if (inventario === undefined || inventario === null) return blocoN0('INVENTARIO_NAO_LIDO');
  if (leitorDeSumario === undefined || leitorDeSumario === null) return blocoN0('SUMARIO_NAO_CAPTURADO');
  const sumario = leitorDeSumario.concluir();
  return avaliarCoberturaPostgres({ inventario, sumario, migrationsDoCodigo });
}
const criarCapturaDeSumario = () => criarLeitorDeSumario();

// ---------------------------------------------------------------------------------------------------------------------------------------- restauração
async function restaurarL2(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['pacote', 'destino', 'fonteDeChaves', 'layoutMinimo', 'maxBytesPorArquivo', 'referencias', 'esquema', 'catalogo'].includes(k))) throw entradaInvalida('ENTRADA');
  const { pacote, destino, fonteDeChaves, layoutMinimo, maxBytesPorArquivo, referencias, esquema, catalogo } = entrada;
  if (!caminhoAbsolutoCanonico(pacote) || !caminhoAbsolutoCanonico(destino) || !ehFonteDeChaves(fonteDeChaves) || !inteiroPositivo(maxBytesPorArquivo)) throw entradaInvalida('ENTRADA');
  if (catalogo !== undefined && !R.validarCatalogo(catalogo).valido) throw entradaInvalida('CATALOGO_INVALIDO');
  const ordem = criarOrdemDeRestauracao();
  const resultado = (ok, extra) => Object.freeze({ ok, ordem: ordem.situacao(), recuperavelEmProducao: false, restauracaoReal: false, ...extra });

  // 1. destino NOVO e isolado (0700): existente = recusa sem tocar em nada
  const pai = path.dirname(destino);
  const criado = (await diretorioReal(pai)) && !fs.existsSync(destino) && (await criarSubdiretorio(pai, path.basename(destino)));
  ordem.registrar('DESTINO_NOVO', { ok: criado });
  if (!criado) return resultado(false, { falha: Object.freeze({ passo: 'DESTINO_NOVO', codigo: 'DESTINO_EXISTENTE' }) });

  // 2. verificações 8.7: selagem relida com o leitor L2 (layout mínimo da OPERAÇÃO) e conjunto exato
  const leitor = criarLeitorL2({ fonteDeChaves, layoutMinimo, ...(catalogo === undefined ? {} : { catalogoAtual: catalogo }) });
  const selagem = criarSelagem({ leitor });
  let lido;
  try {
    // A selagem relê manifesto + selo pelo leitor L2 (hash, versão, layout mínimo, MAC, estrutura); depois o mesmo leitor produz a forma normalizada (fontes, caminhoDe).
    const v = await selagem.verificar({ area: pacote });
    lido = v.ok === true ? leitor({ bytes: await fsp.readFile(path.join(pacote, 'manifesto.json')), sha256: v.sha256 }) : null;
  } catch { lido = null; }
  const pacoteOk = lido !== null ? await verificarPacoteL2({ pacote, lido }) : Object.freeze({ ok: false, motivo: 'SELAGEM_INVALIDA' });
  ordem.registrar('VERIFICACOES_8_7', { ok: pacoteOk.ok });
  if (!pacoteOk.ok) return resultado(false, { falha: Object.freeze({ passo: 'VERIFICACOES_8_7', codigo: pacoteOk.motivo }) });

  // 3. banco e esquema: restaurados FORA daqui (restaurador histórico); o chamador entrega a compatibilidade do esquema (6.4)
  const esquemaOk = ehObjeto(esquema) && typeof esquema.relacao === 'string';
  ordem.registrar('BANCO_E_ESQUEMA', { ok: esquemaOk });
  if (!esquemaOk) return resultado(false, { falha: Object.freeze({ passo: 'BANCO_E_ESQUEMA', codigo: 'ESQUEMA_NAO_INFORMADO' }), lido: Object.freeze({ layout: lido.layout, identidade: lido.identidade }) });

  // 4. restauração por fonte em destino/<fonteId> e conciliação com as referências do banco restaurado
  if (!(await criarSubdiretorio(destino, 'arquivos'))) return resultado(false, { falha: Object.freeze({ passo: 'VERIFICADOR_POR_FONTE', codigo: 'DESTINO_EXISTENTE' }) });
  const fontes = {};
  let todasOk = true;
  for (const fonte of lido.fontes) {
    let adaptador;
    try { adaptador = obterAdaptador(fonte.id, catalogo); } catch { fontes[fonte.id] = Object.freeze({ classe: 'INCOMPLETO', restaurados: 0, motivo: 'ADAPTADOR_INDISPONIVEL' }); todasOk = false; continue; }
    const origemDir = lido.layout === 2 ? path.join(pacote, 'arquivos', fonte.id) : path.join(pacote, 'imagens');
    const destinoDir = path.join(destino, 'arquivos', fonte.id);
    // Adaptador que grava por armazenamento (imagens) precisa da pasta da fonte já criada; o da Fiscalização cria o destino NOVO ele mesmo.
    if (adaptador.destinoPrecisaExistir === true && !(await criarSubdiretorio(path.join(destino, 'arquivos'), fonte.id))) { fontes[fonte.id] = Object.freeze({ classe: 'INCOMPLETO', restaurados: 0, motivo: 'DESTINO_EXISTENTE' }); todasOk = false; continue; }
    let r;
    try { r = await adaptador.restaurar({ origemDir, destinoDir, itens: fonte.arquivos, maxBytesPorArquivo }); } catch { r = { ok: false, restaurados: 0, falha: { codigo: 'RESTAURACAO_FALHOU', chave: null } }; }
    if (r.ok !== true) { fontes[fonte.id] = Object.freeze({ classe: 'INCOMPLETO', restaurados: r.restaurados ?? 0, motivo: r.falha?.codigo ?? 'RESTAURACAO_FALHOU' }); todasOk = false; continue; }
    const refs = ehObjeto(referencias) && Array.isArray(referencias[fonte.id]) ? referencias[fonte.id] : null;
    if (refs === null) { fontes[fonte.id] = Object.freeze({ classe: 'INCOMPLETO', restaurados: r.restaurados, motivo: 'REFERENCIAS_NAO_INFORMADAS' }); todasOk = false; continue; }
    const regra = catalogo === undefined ? 'SEGMENTO_INICIAL_DA_CHAVE' : (catalogo.fontes.find((f) => f.id === fonte.id)?.escopo.regraEmpresa ?? null);
    const conciliacao = conciliarFonte({ referencias: refs, arquivos: fonte.arquivos.map((a) => ({ chave: a.chave, sha256: a.sha256, bytes: a.bytes })), regraEmpresa: regra === 'COLUNA_EMPRESA_ID' ? null : regra });
    fontes[fonte.id] = Object.freeze({ classe: conciliacao.classe, restaurados: r.restaurados, conciliacao });
    if (conciliacao.classe !== 'INTEGRO') todasOk = false;
  }
  ordem.registrar('VERIFICADOR_POR_FONTE', { ok: todasOk });
  if (todasOk) ordem.registrar('RESULTADO', { ok: true });
  const veredito = avaliarRestauracao({ fontes, esquema, ordem: ordem.situacao() });
  return resultado(veredito.classe === 'INTEGRO', { veredito, fontes: Object.freeze(fontes), lido: Object.freeze({ layout: lido.layout, identidade: lido.identidade, avisos: lido.avisos }) });
}

module.exports = { planejarNoSnapshot, criarComposicaoL2, verificarPacoteL2, restaurarL2, avaliarPostgresDoSnapshot, criarCapturaDeSumario, pontoDeRecuperacao, ESTAGIOS };
