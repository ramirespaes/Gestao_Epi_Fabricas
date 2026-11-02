'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const regras = require('../../src/services/backup-fontes-regras.service');

/**
 * Núcleo da guarda estática de CI (D-ORF-6, P2): confronta o CATÁLOGO de fontes com o CÓDIGO, por leitura de texto, sobre um
 * provedor de árvore (disco somente leitura, ou memória para as mutações). Falha fechada: fonte desconhecida, lista sem revisão
 * humana rastreável, pendência de comprovação, link simbólico na árvore, árvore insuficiente, catálogo inválido ou erro interno
 * de um detector reprovam. Saídas levam só nomes, caminhos relativos, linhas e códigos — nunca o conteúdo das linhas.
 *
 * IDENTIDADE POR SINAL (correção focal de 02/11/2026): toda contagem da linha de base é um MAPA sinal → quantidade, por arquivo e
 * por categoria (escrita e remoção separadas; token de migration; sinal MIME/API de rota; constante de exceção G1 por arquivo).
 * Normalização: o sinal é o texto casado pela expressão regular, sem parênteses nem espaço final, em minúsculas (variáveis G1 em
 * maiúsculas). A comparação é exata nos dois sentidos: sinal a mais, a menos ou trocado reprova, e uma categoria nunca compensa
 * outra. Estrutura antiga (totais numéricos) é recusada.
 *
 * RASTREABILIDADE: uma entrada só conta como aprovada com `revisaoHumana: 'APROVADA'`, `aprovadoEm` e `aprovacaoRef` registrada em
 * `APROVACOES` (ref, documento, sha256), cujo documento é lido da própria árvore e conferido pelo hash. LIMITE: o hash prova a
 * integridade do documento de aprovação, não a identidade de quem o assinou; a conferência documental humana continua obrigatória.
 *
 * LIMITES (não são cobertura comprovada): a guarda não vê escrita por processo filho ou ferramenta externa, nem por
 * dependência transitiva, nem por caminho construído dinamicamente, nem por serviço externo, nem pelo próprio banco
 * (COPY/lo_export, só procurados nas migrations), nem por pessoas/rotinas operacionais, nem código fora de src/, scripts/,
 * migrations/, package.json e .env.example. Escritas feitas ATRAVÉS de um armazenamento conhecido (importadores de imagens)
 * aparecem só no módulo do armazenamento. A detecção de links simbólicos é textual/estrutural (o link não é seguido) e NÃO
 * substitui a validação operacional de raízes (realpath, dono, permissões, sobreposição real), prevista para etapa posterior.
 */

const REGRAS = Object.freeze(['LISTAS', 'ARVORE', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14']);
const EXTENSOES_DE_TEXTO = Object.freeze(['.js', '.sql', '.json', '.example', '.md', '.yml', '.txt', '.mjs', '.cjs']);
const DIRETORIOS_IGNORADOS = Object.freeze(['node_modules', 'coverage', '.git']);
const CLASSIFICACOES_DE_ESCRITOR = Object.freeze(['FONTE', 'SAIDA_DO_BACKUP', 'JANELA', 'NAO_PERSISTENTE', 'BUILD']);
const CLASSIFICACOES_DE_ROTA = Object.freeze(['ENTRADA_BINARIA', 'SAIDA_EM_FLUXO', 'CONSTANTE_DE_TIPO']);
const CLASSIFICACOES_DE_MIGRATION = Object.freeze(['FONTE', 'INTERNO_AO_BANCO']);
const CLASSIFICACOES_DE_DEPENDENCIA = Object.freeze(['ARMAZENAMENTO_REVISADO', 'PROCESSAMENTO_SEM_PERSISTENCIA', 'SEM_RELACAO_COM_ARMAZENAMENTO', 'FERRAMENTA_DE_DESENVOLVIMENTO', 'PENDENTE_DE_COMPROVACAO']);
const CHAVES_DAS_LISTAS = Object.freeze(['ESCRITORES_CONHECIDOS', 'ROTAS_BINARIAS_CONHECIDAS', 'MIGRATIONS_CONHECIDAS', 'DEPENDENCIAS_REVISADAS', 'SUPERFICIE_ESPERADA', 'NOMES_QUE_NAO_SAO_RAIZ', 'APROVACOES', 'minimoDeArquivos']);
const LINK_SIMBOLICO = Symbol('link simbólico');

const RE_ESCRITA = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/g;
const RE_REMOCAO = /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/g;
const RE_PROCESSO_FILHO = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/g;
const RE_RAIZ = /\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/g;
const RE_COLUNA_DE_ARQUIVO = /(?:^|[^A-Za-z0-9_])(sha256|bytea|chave_armazenamento|caminho[a-z_]*|bucket|url[a-z_]*|arquivo[a-z_]*|anexo[a-z_]*|blob)(?![A-Za-z0-9_])/gi;
const RE_ESCRITA_PELO_BANCO = /\b(?:lo_import|lo_export|pg_file_write|COPY\s+[^\n]*\s+TO\s+'|COPY\s+[^\n]*\s+FROM\s+')/gi;
const RE_ROTA_BINARIA = /express\.raw|express\.static|res\.sendFile|res\.download|application\/octet-stream|application\/pdf|application\/zip|multipart\/|image\/(?:png|jpeg|webp|\*)|Content-Disposition|attachment;/g;
const RE_DEPENDENCIA_DE_ARMAZENAMENTO = /^(?:multer|busboy|formidable|express-fileupload|aws-sdk|@aws-sdk\/.*|minio|ssh2(?:-.*)?|.*sftp.*|basic-ftp|ftp|@google-cloud\/storage|@azure\/storage-.*|s3.*|.*-s3|gridfs.*|level(?:-.*)?|sqlite3|better-sqlite3|lowdb|nedb|pouchdb|mongodb|mongoose|redis|ioredis|fs-extra|graceful-fs|chokidar|tar(?:-.*)?|archiver)$/;
const RE_APROVACAO_REF = /^GATE-P2-\d{4}-\d{2}-\d{2}(?:-[A-Z0-9]{1,8})?$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_SINAL = /^[a-z0-9_*;/.-]{1,40}$/;
const ARGUMENTOS_PROIBIDOS_DO_DUMP = Object.freeze(['--schema', '--table', '--exclude', '--no-blobs', '--data-only', '--schema-only', '--section', '--no-acl', '--no-owner']);
const ARQUIVO_DO_DUMP = 'src/services/imagem-backup-pgdump-lancador.service.js';
const ARQUIVO_DO_EMAIL = 'src/config/email.js';
const TESTES_DO_EMAIL = Object.freeze({
  'test/config/email.test.js': /NODE_ENV: 'production', EMAIL_MODO: 'arquivo'/,
  'test/app-producao-email.test.js': /EMAIL_MODO: 'arquivo'/,
});

const semComentariosJs = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const semComentariosSql = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, '');
const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;
const ehTexto = (caminho) => EXTENSOES_DE_TEXTO.includes(path.posix.extname(caminho));
const ehJs = (caminho) => /\.(?:js|mjs|cjs)$/.test(caminho);
const sob = (caminho, prefixo) => caminho === prefixo || caminho.startsWith(`${prefixo}/`);
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehCaminhoRelativo = (c) => typeof c === 'string' && c.length > 0 && !c.startsWith('/') && !c.split('/').includes('..') && !c.includes('\0');
/** Exclusão deliberada: qualquer entrada cujo nome (em qualquer nível) seja um diretório ignorado fica fora da varredura, seja diretório, arquivo ou link simbólico. */
const ehIgnorado = (caminho) => caminho.split('/').some((segmento) => DIRETORIOS_IGNORADOS.includes(segmento));
const congelar = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const f of Object.values(v)) congelar(f); }
  return v;
};
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

/** Mapa sinal → quantidade válido: objeto simples, chaves normalizadas, inteiros ≥ 1. */
const ehMapaDeSinais = (m) => ehObjeto(m) && Object.entries(m).every(([k, v]) => RE_SINAL.test(k) && Number.isInteger(v) && v >= 1);
/** Diferenças exatas entre dois mapas (nos dois sentidos); cada item é `sinal:esperado=x:real=y`. */
function diferencasDeMapa(esperado, real) {
  const saida = [];
  for (const sinal of [...new Set([...Object.keys(esperado), ...Object.keys(real)])].sort()) {
    const e = esperado[sinal] ?? 0;
    const r = real[sinal] ?? 0;
    if (e !== r) saida.push(`${sinal}:esperado=${e}:real=${r}`);
  }
  return saida;
}
const contar = (achados) => {
  const mapa = {};
  for (const { sinal } of achados) mapa[sinal] = (mapa[sinal] ?? 0) + 1;
  return mapa;
};

function provedorDeDisco(raiz) {
  const absoluta = path.resolve(raiz);
  const arquivos = [];
  const links = [];
  const percorrer = (dir, rel) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const caminho = rel ? `${rel}/${entrada.name}` : entrada.name;
      // A exclusão deliberada vem ANTES do tratamento de link: node_modules/coverage/.git simbólicos não são violação nem são seguidos.
      if (DIRETORIOS_IGNORADOS.includes(entrada.name)) continue;
      if (entrada.isSymbolicLink()) { links.push(caminho); continue; } // nunca seguido; relatado como violação pelo núcleo
      if (entrada.isDirectory()) percorrer(path.join(dir, entrada.name), caminho);
      else if (entrada.isFile()) arquivos.push(caminho);
    }
  };
  percorrer(absoluta, '');
  const conjunto = new Set(arquivos);
  return Object.freeze({
    tipo: 'DISCO_SOMENTE_LEITURA',
    listar: () => [...arquivos],
    links: () => [...links],
    ler: (caminho) => {
      if (!conjunto.has(caminho)) throw Object.assign(new Error('arquivo fora da listagem'), { codigo: 'FALHA_DE_LEITURA' });
      return fs.readFileSync(path.join(absoluta, ...caminho.split('/')), 'utf8');
    },
  });
}

/** Árvore em memória: valor string = arquivo; valor `LINK_SIMBOLICO` = link simbólico (listado à parte, nunca "lido"). Mesma exclusão deliberada do disco. */
function provedorEmMemoria(arquivos) {
  const mapa = new Map([...(arquivos instanceof Map ? arquivos : new Map(Object.entries(arquivos)))].filter(([k]) => !ehIgnorado(k)));
  const regulares = [...mapa.entries()].filter(([, v]) => v !== LINK_SIMBOLICO).map(([k]) => k).sort();
  const links = [...mapa.entries()].filter(([, v]) => v === LINK_SIMBOLICO).map(([k]) => k).sort();
  return Object.freeze({
    tipo: 'MEMORIA',
    listar: () => [...regulares],
    links: () => [...links],
    ler: (caminho) => {
      if (!mapa.has(caminho) || mapa.get(caminho) === LINK_SIMBOLICO) throw Object.assign(new Error('arquivo inexistente'), { codigo: 'FALHA_DE_LEITURA' });
      return mapa.get(caminho);
    },
  });
}

function ocorrencias(texto, re) {
  const saida = [];
  re.lastIndex = 0;
  for (let m = re.exec(texto); m !== null; m = re.exec(texto)) {
    saida.push({ linha: linhaDe(texto, m.index), sinal: (m[1] ?? m[0]).replace(/\s*\($/, '').toLowerCase() });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return saida;
}

function validarListas(listas, catalogo, relatar) {
  if (!ehObjeto(listas) || !CHAVES_DAS_LISTAS.every((c) => Object.hasOwn(listas, c)) || Object.keys(listas).length !== CHAVES_DAS_LISTAS.length) {
    relatar('LISTAS', 'LISTAS_INVALIDAS', null, null, 'estrutura');
    return false;
  }
  let ok = true;
  const invalida = (detalhe, chave = null) => { ok = false; relatar('LISTAS', 'LISTAS_INVALIDAS', chave, null, detalhe); };
  if (!(Number.isInteger(listas.minimoDeArquivos) && listas.minimoDeArquivos >= 1)) invalida('minimoDeArquivos');
  if (!Array.isArray(listas.NOMES_QUE_NAO_SAO_RAIZ) || !listas.NOMES_QUE_NAO_SAO_RAIZ.every((e) => ehObjeto(e) && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.nome) && ehCaminhoRelativo(e.arquivo) && Number.isInteger(e.ocorrencias) && e.ocorrencias >= 1)) invalida('NOMES_QUE_NAO_SAO_RAIZ');
  const refs = new Set();
  if (!Array.isArray(listas.APROVACOES)) invalida('APROVACOES');
  else {
    for (const a of listas.APROVACOES) {
      if (!(ehObjeto(a) && typeof a.ref === 'string' && RE_APROVACAO_REF.test(a.ref) && ehCaminhoRelativo(a.documento) && /^[0-9a-f]{64}$/.test(a.sha256 ?? ''))) invalida('APROVACOES');
      else refs.add(a.ref);
    }
  }
  const fontes = catalogo === null ? null : new Set(catalogo.fontes.map((f) => f.id));
  const admiteFonte = (nomeLista, classificacao) => classificacao === 'FONTE' || (nomeLista === 'ROTAS_BINARIAS_CONHECIDAS' && classificacao !== 'CONSTANTE_DE_TIPO');
  const conferir = (nomeLista, classificacoes, formatoContagem) => {
    const lista = listas[nomeLista];
    if (!ehObjeto(lista)) { invalida(nomeLista); return; }
    for (const [chave, entrada] of Object.entries(lista)) {
      if (!ehObjeto(entrada)) { invalida(nomeLista, chave); continue; }
      if (!classificacoes.includes(entrada.classificacao)) relatar('LISTAS', 'EXCECAO_SEM_CLASSIFICACAO', chave, null, nomeLista);
      if (typeof entrada.justificativa !== 'string' || entrada.justificativa.trim().length < 10) relatar('LISTAS', 'EXCECAO_SEM_JUSTIFICATIVA', chave, null, nomeLista);
      const temFonte = entrada.fonteId !== undefined && entrada.fonteId !== null;
      if (entrada.classificacao === 'FONTE' && fontes !== null && !fontes.has(entrada.fonteId)) relatar('LISTAS', 'EXCECAO_COM_FONTE_INEXISTENTE', chave, null, nomeLista);
      if (temFonte && !admiteFonte(nomeLista, entrada.classificacao)) relatar('LISTAS', 'EXCECAO_COM_FONTE_INDEVIDA', chave, null, nomeLista);
      if (temFonte && entrada.classificacao !== 'FONTE' && fontes !== null && !fontes.has(entrada.fonteId)) relatar('LISTAS', 'EXCECAO_COM_FONTE_INEXISTENTE', chave, null, nomeLista);
      if (formatoContagem === 'ESCRITOR') {
        const o = entrada.ocorrencias;
        if (!(ehObjeto(o) && Object.keys(o).length === 2 && ehMapaDeSinais(o.escrita) && ehMapaDeSinais(o.remocao))) relatar('LISTAS', 'EXCECAO_CONTAGEM_FORMATO_INVALIDO', chave, null, nomeLista);
      } else if (formatoContagem === 'MAPA' && !ehMapaDeSinais(entrada.ocorrencias)) relatar('LISTAS', 'EXCECAO_CONTAGEM_FORMATO_INVALIDO', chave, null, nomeLista);
      const pendenteDeComprovacao = entrada.classificacao === 'PENDENTE_DE_COMPROVACAO';
      if (pendenteDeComprovacao) {
        if (typeof entrada.hipotese !== 'string' || typeof entrada.comprovacaoPendente !== 'string' || entrada.comprovacaoPendente.trim().length < 10) relatar('LISTAS', 'EXCECAO_PENDENTE_SEM_DESCRICAO', chave, null, nomeLista);
        relatar('LISTAS', 'EXCECAO_PENDENTE_DE_COMPROVACAO', chave, null, nomeLista);
      }
      if (entrada.revisaoHumana === 'APROVADA') {
        if (pendenteDeComprovacao) relatar('LISTAS', 'EXCECAO_PENDENTE_APROVADA', chave, null, nomeLista);
        const refOk = typeof entrada.aprovacaoRef === 'string' && RE_APROVACAO_REF.test(entrada.aprovacaoRef);
        if (!RE_DATA.test(entrada.aprovadoEm ?? '') || !refOk) relatar('LISTAS', 'EXCECAO_NAO_REVISADA', chave, null, nomeLista);
        else if (!refs.has(entrada.aprovacaoRef)) relatar('LISTAS', 'EXCECAO_APROVACAO_SEM_REGISTRO', chave, null, nomeLista);
      } else {
        relatar('LISTAS', 'EXCECAO_NAO_REVISADA', chave, null, nomeLista);
        if ((entrada.aprovadoEm ?? null) !== null || (entrada.aprovacaoRef ?? null) !== null) relatar('LISTAS', 'EXCECAO_PENDENTE_COM_DADOS_DE_APROVACAO', chave, null, nomeLista);
      }
    }
  };
  conferir('ESCRITORES_CONHECIDOS', CLASSIFICACOES_DE_ESCRITOR, 'ESCRITOR');
  conferir('ROTAS_BINARIAS_CONHECIDAS', CLASSIFICACOES_DE_ROTA, 'MAPA');
  conferir('MIGRATIONS_CONHECIDAS', CLASSIFICACOES_DE_MIGRATION, 'MAPA');
  conferir('DEPENDENCIAS_REVISADAS', CLASSIFICACOES_DE_DEPENDENCIA, null);
  if (!ehObjeto(listas.SUPERFICIE_ESPERADA)) invalida('SUPERFICIE_ESPERADA');
  else {
    for (const [fonteId, s] of Object.entries(listas.SUPERFICIE_ESPERADA)) {
      if (fontes !== null && !fontes.has(fonteId)) relatar('LISTAS', 'EXCECAO_COM_FONTE_INEXISTENTE', fonteId, null, 'SUPERFICIE_ESPERADA');
      if (!ehObjeto(s) || typeof s.modulo !== 'string' || !Array.isArray(s.exportsEsperados) || !Number.isInteger(s.versaoContrato)) invalida('SUPERFICIE_ESPERADA', fonteId);
    }
  }
  return ok;
}

/** Conferência dos registros de aprovação declarados: documento presente na árvore e hash igual (integridade, não identidade). */
function conferirAprovacoes(ctx) {
  const { listar, ler, listas, relatar } = ctx;
  const existentes = new Set(listar());
  for (const a of listas.APROVACOES) {
    if (!existentes.has(a.documento)) { relatar('LISTAS', 'REGISTRO_DE_APROVACAO_INVALIDO', a.documento, null, `${a.ref}:ausente`); continue; }
    if (sha256(ler(a.documento)) !== a.sha256) relatar('LISTAS', 'REGISTRO_DE_APROVACAO_INVALIDO', a.documento, null, `${a.ref}:hash`);
  }
}

const DETECTORES = {
  G1(ctx) {
    const { listar, ler, catalogo, listas, relatar, registrar } = ctx;
    const arquivos = listar().filter((c) => c === '.env.example' || (sob(c, 'src/config') && ehJs(c)));
    const registradas = new Set(catalogo.fontes.map((f) => f.raiz.variavel).filter((v) => v !== null));
    const excecoes = new Map(listas.NOMES_QUE_NAO_SAO_RAIZ.map((e) => [`${e.arquivo}\n${e.nome}`, e.ocorrencias]));
    const encontradas = new Set();
    const porExcecao = new Map();
    for (const arquivo of arquivos) {
      for (const { linha, sinal } of ocorrencias(ler(arquivo), RE_RAIZ)) {
        const nome = sinal.toUpperCase();
        encontradas.add(nome);
        const chaveExcecao = `${arquivo}\n${nome}`;
        const classificacao = registradas.has(nome) ? 'RAIZ_REGISTRADA' : excecoes.has(chaveExcecao) ? 'NOME_QUE_NAO_E_RAIZ' : 'NAO_CLASSIFICADA';
        registrar('G1', arquivo, linha, nome, classificacao, catalogo.fontes.find((f) => f.raiz.variavel === nome)?.id ?? null);
        if (classificacao === 'NOME_QUE_NAO_E_RAIZ') porExcecao.set(chaveExcecao, (porExcecao.get(chaveExcecao) ?? 0) + 1);
        if (classificacao === 'NAO_CLASSIFICADA') relatar('G1', 'G1_RAIZ_SEM_REGISTRO', arquivo, linha, nome);
      }
    }
    for (const [chave, esperado] of excecoes) {
      const [arquivo, nome] = chave.split('\n');
      const real = porExcecao.get(chave) ?? 0;
      if (real === 0) relatar('G1', 'G1_EXCECAO_INEXISTENTE', arquivo, null, nome);
      else if (real !== esperado) relatar('G1', 'G1_EXCECAO_CONTAGEM_DIVERGENTE', arquivo, null, `${nome}:esperado=${esperado}:real=${real}`);
    }
    for (const nome of registradas) if (!encontradas.has(nome)) relatar('G1', 'G1_RAIZ_REGISTRADA_SEM_CONFIGURACAO', null, null, nome);
  },
  G2(ctx) { escritasOuRemocoes(ctx, 'G2', RE_ESCRITA, 'escrita'); },
  G3(ctx) { escritasOuRemocoes(ctx, 'G3', RE_REMOCAO, 'remocao'); },
  G4(ctx) {
    const { listas, relatar, contagens, listar } = ctx;
    const existentes = new Set(listar());
    for (const [arquivo, entrada] of Object.entries(listas.ESCRITORES_CONHECIDOS)) {
      if (!existentes.has(arquivo)) { relatar('G4', 'G4_ESCRITOR_CONHECIDO_INEXISTENTE', arquivo, null, null); continue; }
      const real = contagens.get(arquivo) ?? { escrita: {}, remocao: {} };
      for (const categoria of ['escrita', 'remocao']) {
        for (const d of diferencasDeMapa(entrada.ocorrencias[categoria], real[categoria])) relatar('G4', 'G4_SINAL_DIVERGENTE', arquivo, null, `${categoria}:${d}`);
      }
    }
  },
  G5(ctx) {
    const { listar, ler, listas, catalogo, relatar, registrar } = ctx;
    const fontes = new Set(catalogo.fontes.map((f) => f.id));
    for (const arquivo of listar().filter((c) => sob(c, 'migrations') && c.endsWith('.sql'))) {
      const texto = semComentariosSql(ler(arquivo));
      const colunas = ocorrencias(texto, RE_COLUNA_DE_ARQUIVO);
      const escritas = ocorrencias(texto, RE_ESCRITA_PELO_BANCO);
      const entrada = listas.MIGRATIONS_CONHECIDAS[arquivo];
      const classificacao = entrada ? entrada.classificacao : 'NAO_CLASSIFICADA';
      for (const { linha, sinal } of colunas) registrar('G5', arquivo, linha, sinal, classificacao, entrada?.fonteId ?? null);
      for (const { linha, sinal } of escritas) {
        registrar('G5', arquivo, linha, sinal.split(/\s/)[0], 'ESCRITA_PELO_BANCO', null);
        relatar('G5', 'G5_ESCRITA_PELO_BANCO', arquivo, linha, sinal.split(/\s/)[0]);
      }
      if (colunas.length === 0) continue;
      if (!entrada) relatar('G5', 'G5_MIGRATION_COM_REFERENCIA_NAO_MAPEADA', arquivo, colunas[0].linha, null);
      else {
        if (entrada.classificacao === 'FONTE' && !fontes.has(entrada.fonteId)) relatar('G5', 'G5_FONTE_INEXISTENTE', arquivo, null, null);
        for (const d of diferencasDeMapa(entrada.ocorrencias, contar(colunas))) relatar('G5', 'G5_SINAL_DIVERGENTE', arquivo, null, d);
      }
    }
    for (const arquivo of Object.keys(listas.MIGRATIONS_CONHECIDAS)) if (!listar().includes(arquivo)) relatar('G5', 'G5_MIGRATION_CONHECIDA_INEXISTENTE', arquivo, null, null);
  },
  G6(ctx) {
    const { listar, ler, listas, relatar, registrar } = ctx;
    if (!listar().includes('package.json')) { relatar('G6', 'G6_PACKAGE_AUSENTE', 'package.json', null, null); return; }
    const pacote = JSON.parse(ler('package.json'));
    const nomes = [...Object.keys(pacote.dependencies ?? {}), ...Object.keys(pacote.devDependencies ?? {})];
    for (const nome of nomes) {
      const entrada = listas.DEPENDENCIAS_REVISADAS[nome];
      const deArmazenamento = RE_DEPENDENCIA_DE_ARMAZENAMENTO.test(nome);
      registrar('G6', 'package.json', null, nome, entrada ? entrada.classificacao : 'NAO_CLASSIFICADA', null);
      if (!entrada) relatar('G6', deArmazenamento ? 'G6_DEPENDENCIA_DE_ARMAZENAMENTO_NAO_REVISADA' : 'G6_DEPENDENCIA_NAO_REVISADA', 'package.json', null, nome);
      else if (deArmazenamento && entrada.classificacao !== 'ARMAZENAMENTO_REVISADO') relatar('G6', 'G6_DEPENDENCIA_DE_ARMAZENAMENTO_NAO_REVISADA', 'package.json', null, nome);
    }
    for (const nome of Object.keys(listas.DEPENDENCIAS_REVISADAS)) if (!nomes.includes(nome)) relatar('G6', 'G6_DEPENDENCIA_REVISADA_INEXISTENTE', 'package.json', null, nome);
  },
  G7(ctx) {
    const { listar, ler, listas, catalogo, relatar, registrar } = ctx;
    const fontes = new Set(catalogo.fontes.map((f) => f.id));
    for (const arquivo of listar().filter((c) => sob(c, 'src') && ehJs(c))) {
      const sinais = ocorrencias(semComentariosJs(ler(arquivo)), RE_ROTA_BINARIA);
      if (sinais.length === 0) continue;
      const entrada = listas.ROTAS_BINARIAS_CONHECIDAS[arquivo];
      for (const { linha, sinal } of sinais) registrar('G7', arquivo, linha, sinal, entrada ? entrada.classificacao : 'NAO_CLASSIFICADA', entrada?.fonteId ?? null);
      if (!entrada) relatar('G7', 'G7_ROTA_BINARIA_DESCONHECIDA', arquivo, sinais[0].linha, null);
      else {
        if (entrada.fonteId && !fontes.has(entrada.fonteId)) relatar('G7', 'G7_FONTE_INEXISTENTE', arquivo, null, null);
        for (const d of diferencasDeMapa(entrada.ocorrencias, contar(sinais))) relatar('G7', 'G7_SINAL_DIVERGENTE', arquivo, null, d);
      }
    }
    for (const arquivo of Object.keys(listas.ROTAS_BINARIAS_CONHECIDAS)) if (!listar().includes(arquivo)) relatar('G7', 'G7_ROTA_CONHECIDA_INEXISTENTE', arquivo, null, null);
  },
  G8(ctx) {
    const { catalogo, relatar, informar } = ctx;
    for (const f of catalogo.fontes) {
      if (f.classe === null && !regras.DECISOES_PENDENTES.includes(f.decisaoPendente)) relatar('G8', 'G8_FONTE_SEM_CLASSIFICACAO', null, null, f.id);
      else if (f.classe === null) informar('G8', 'G8_FONTE_PENDENTE_DE_DECISAO', null, null, `${f.id}:${f.decisaoPendente}`);
      const estado = regras.estadoDeCobertura(f);
      if (['CANDIDATA', 'IMPLEMENTACAO_PARCIAL', 'IMPLEMENTADA_NAO_COMPROVADA', 'SUSPENSA'].includes(estado)) informar('G8', 'G8_FONTE_NAO_COMPROVADA', null, null, `${f.id}:${estado}`);
    }
  },
  G9(ctx) {
    const { listar, catalogo, relatar } = ctx;
    const existentes = new Set(listar());
    for (const f of catalogo.fontes) {
      for (const [nome, c] of Object.entries(f.componentes)) {
        for (const campo of ['modulo', 'teste']) {
          if (c[campo] !== null && !existentes.has(c[campo])) relatar('G9', 'G9_COMPONENTE_INEXISTENTE', c[campo], null, `${f.id}:${nome}:${campo}`);
        }
      }
      if (f.promocao) for (const ev of f.promocao.evidencias) if (ev.includes('/') && !existentes.has(ev)) relatar('G9', 'G9_EVIDENCIA_INEXISTENTE', ev, null, f.id);
    }
  },
  G10(ctx) {
    const resultado = regras.validarCatalogo(ctx.catalogo);
    if (!resultado.valido) for (const e of resultado.erros) ctx.relatar('G10', `G10_${e.codigo}`, null, null, `${e.fonteId ?? '-'}:${e.campo ?? '-'}`);
  },
  G11(ctx) {
    const { listar, listas, relatar, informar } = ctx;
    const total = listar().length;
    if (total === 0) relatar('G11', 'ARVORE_VAZIA', null, null, null);
    else if (total < listas.minimoDeArquivos) relatar('G11', 'ARVORE_INSUFICIENTE', null, null, `varridos=${total}:minimo=${listas.minimoDeArquivos}`);
    for (const arquivo of listar().filter((c) => (sob(c, 'src') || sob(c, 'scripts')) && ehJs(c))) {
      const n = ocorrencias(semComentariosJs(ctx.ler(arquivo)), RE_PROCESSO_FILHO).length;
      if (n > 0) informar('G11', 'G2B_PROCESSO_FILHO', arquivo, null, `ocorrencias=${n}`);
    }
  },
  G12(ctx) {
    const { listar, ler, relatar } = ctx;
    const existentes = new Set(listar());
    if (!existentes.has(ARQUIVO_DO_EMAIL)) { relatar('G12', 'G12_CONFIG_DE_EMAIL_AUSENTE', ARQUIVO_DO_EMAIL, null, null); return; }
    const config = semComentariosJs(ler(ARQUIVO_DO_EMAIL));
    if (!/producao\s*&&\s*e\.EMAIL_MODO\s*!==\s*'smtp'/.test(config) || !config.includes('SO_SMTP_EM_PRODUCAO')) relatar('G12', 'G12_RECUSA_EMAIL_PRODUCAO_AUSENTE', ARQUIVO_DO_EMAIL, null, null);
    for (const [arquivo, re] of Object.entries(TESTES_DO_EMAIL)) {
      if (!existentes.has(arquivo)) relatar('G12', 'G12_TESTE_DA_RECUSA_AUSENTE', arquivo, null, null);
      else if (!re.test(ler(arquivo))) relatar('G12', 'G12_TESTE_DA_RECUSA_SEM_ASSERCAO', arquivo, null, null);
    }
  },
  G13(ctx) {
    const { listar, ler, relatar } = ctx;
    if (!listar().includes(ARQUIVO_DO_DUMP)) { relatar('G13', 'G13_LANCADOR_AUSENTE', ARQUIVO_DO_DUMP, null, null); return; }
    const texto = semComentariosJs(ler(ARQUIVO_DO_DUMP));
    for (const arg of ARGUMENTOS_PROIBIDOS_DO_DUMP) if (texto.includes(arg)) relatar('G13', 'G13_PGDUMP_FILTRADO', ARQUIVO_DO_DUMP, linhaDe(texto, texto.indexOf(arg)), arg);
    if (!texto.includes('--format=custom') || !texto.includes('--snapshot=')) relatar('G13', 'G13_PGDUMP_SEM_FORMATO_OU_SNAPSHOT', ARQUIVO_DO_DUMP, null, null);
  },
  G14(ctx) {
    const { listar, ler, listas, catalogo, relatar } = ctx;
    const existentes = new Set(listar());
    for (const [fonteId, s] of Object.entries(listas.SUPERFICIE_ESPERADA)) {
      const fonte = catalogo.fontes.find((f) => f.id === fonteId);
      if (!fonte) continue;
      if (fonte.versaoContrato !== s.versaoContrato) relatar('G14', 'G14_VERSAO_DE_CONTRATO_DIVERGENTE', s.modulo, null, fonteId);
      if (!existentes.has(s.modulo)) { relatar('G14', 'G14_MODULO_AUSENTE', s.modulo, null, fonteId); continue; }
      const texto = semComentariosJs(ler(s.modulo));
      const m = texto.match(/module\.exports\s*=\s*\{([^}]*)\}/);
      const exportados = m ? m[1].split(',').map((x) => x.trim().split(/\s*:\s*/)[0]).filter(Boolean).sort() : [];
      if (JSON.stringify(exportados) !== JSON.stringify([...s.exportsEsperados].sort())) relatar('G14', 'G14_SUPERFICIE_ALTERADA', s.modulo, m ? linhaDe(texto, m.index) : null, `${fonteId}:exports`);
      if (s.regexChave) {
        const literal = texto.match(/^const CHAVE = (\/.*\/);$/m);
        const esperado = regras.FORMATOS_DE_CHAVE[s.regexChave] ? `/${regras.FORMATOS_DE_CHAVE[s.regexChave].source}/` : null;
        if (!literal || literal[1] !== esperado) relatar('G14', 'G14_SUPERFICIE_ALTERADA', s.modulo, literal ? linhaDe(texto, literal.index) : null, `${fonteId}:regexChave`);
      }
      if (s.variavel) {
        if (fonte.raiz.variavel !== s.variavel) relatar('G14', 'G14_SUPERFICIE_ALTERADA', s.modulo, null, `${fonteId}:variavel`);
        if (!existentes.has(s.arquivoDeConfig) || !ler(s.arquivoDeConfig).includes(s.variavel)) relatar('G14', 'G14_SUPERFICIE_ALTERADA', s.arquivoDeConfig ?? null, null, `${fonteId}:config`);
      }
    }
  },
};

function escritasOuRemocoes(ctx, regra, re, categoria) {
  const { listar, ler, listas, catalogo, relatar, registrar, contagens } = ctx;
  const fontes = new Set(catalogo.fontes.map((f) => f.id));
  for (const arquivo of listar().filter((c) => (sob(c, 'src') || sob(c, 'scripts')) && ehJs(c))) {
    const achados = ocorrencias(semComentariosJs(ler(arquivo)), re);
    const atual = contagens.get(arquivo) ?? { escrita: {}, remocao: {} };
    atual[categoria] = contar(achados);
    contagens.set(arquivo, atual);
    if (achados.length === 0) continue;
    const entrada = listas.ESCRITORES_CONHECIDOS[arquivo];
    for (const { linha, sinal } of achados) registrar(regra, arquivo, linha, sinal, entrada ? entrada.classificacao : 'NAO_CLASSIFICADA', entrada?.fonteId ?? null);
    if (!entrada) relatar(regra, regra === 'G2' ? 'G2_ESCRITOR_DESCONHECIDO' : 'G3_REMOCAO_DESCONHECIDA', arquivo, achados[0].linha, null);
    else if (entrada.classificacao === 'FONTE' && !fontes.has(entrada.fonteId)) relatar(regra, `${regra}_FONTE_INEXISTENTE`, arquivo, null, null);
  }
}

/**
 * @returns {{ aprovado: boolean, violacoes: Array, informativos: Array, ocorrencias: Array, varridos: number, links: number, regrasExecutadas: string[] }}
 */
function analisarArvore(provedor, catalogo, listas) {
  const violacoes = [];
  const informativos = [];
  const inventario = [];
  const contagens = new Map();
  const relatar = (regra, codigo, arquivo, linha, detalhe) => violacoes.push(Object.freeze({ regra, codigo, arquivo: arquivo ?? null, linha: linha ?? null, detalhe: detalhe ?? null }));
  const informar = (regra, codigo, arquivo, linha, detalhe) => informativos.push(Object.freeze({ regra, codigo, arquivo: arquivo ?? null, linha: linha ?? null, detalhe: detalhe ?? null }));
  const registrar = (regra, arquivo, linha, sinal, classificacao, fonteId) => inventario.push({ regra, arquivo, linha: linha ?? null, sinal, classificacao, fonteId: fonteId ?? null });
  const regrasExecutadas = [];
  let listagem = null;
  let links = [];
  try {
    if (!provedor || typeof provedor.listar !== 'function' || typeof provedor.ler !== 'function' || typeof provedor.links !== 'function') throw Object.assign(new Error('provedor inválido'), { codigo: 'PROVEDOR_INVALIDO' });
    listagem = provedor.listar();
    links = provedor.links();
    if (!Array.isArray(listagem) || !listagem.every(ehCaminhoRelativo) || !Array.isArray(links) || !links.every(ehCaminhoRelativo)) throw Object.assign(new Error('listagem inválida'), { codigo: 'FALHA_DE_LEITURA' });
  } catch (erro) {
    relatar('LISTAS', erro.codigo === 'PROVEDOR_INVALIDO' ? 'PROVEDOR_INVALIDO' : 'FALHA_DE_LEITURA', null, null, null);
    return congelar({ aprovado: false, violacoes, informativos, ocorrencias: inventario, varridos: 0, links: 0, regrasExecutadas });
  }
  const cache = new Map();
  const ler = (caminho) => {
    if (!cache.has(caminho)) {
      if (!ehTexto(caminho)) throw Object.assign(new Error('arquivo não textual'), { codigo: 'FALHA_DE_LEITURA' });
      const conteudo = provedor.ler(caminho);
      if (typeof conteudo !== 'string') throw Object.assign(new Error('conteúdo inválido'), { codigo: 'FALHA_DE_LEITURA' });
      cache.set(caminho, conteudo);
    }
    return cache.get(caminho);
  };
  const listar = () => listagem;
  const catalogoValido = regras.validarCatalogo(catalogo).valido;
  if (!catalogoValido) relatar('LISTAS', 'CATALOGO_INVALIDO', null, null, null);
  const listasValidas = validarListas(listas, catalogoValido ? catalogo : null, relatar);
  regrasExecutadas.push('LISTAS');
  regrasExecutadas.push('ARVORE');
  for (const link of [...links].sort()) relatar('ARVORE', 'LINK_SIMBOLICO_NA_ARVORE', link, null, 'nao_seguido');
  const ctx = { listar, ler, catalogo, listas, relatar, informar, registrar, contagens };
  const executar = (regra) => {
    regrasExecutadas.push(regra);
    try { DETECTORES[regra](ctx); } catch (erro) {
      relatar(regra, erro && erro.codigo === 'FALHA_DE_LEITURA' ? 'FALHA_DE_LEITURA' : 'ERRO_INTERNO_DO_DETECTOR', null, null, regra);
    }
  };
  if (catalogoValido && listasValidas) {
    try { conferirAprovacoes(ctx); } catch { relatar('LISTAS', 'ERRO_INTERNO_DO_DETECTOR', null, null, 'APROVACOES'); }
    for (const regra of REGRAS.slice(2)) executar(regra);
  } else {
    // Catálogo ou listas inválidos: só as regras que não dependem deles, para o motivo real aparecer junto da reprovação.
    executar('G10');
    if (ehObjeto(catalogo) && Array.isArray(catalogo.fontes) && catalogo.fontes.every(ehObjeto)) executar('G8');
  }
  inventario.sort((a, b) => (a.regra < b.regra ? -1 : a.regra > b.regra ? 1 : (a.arquivo ?? '') < (b.arquivo ?? '') ? -1 : (a.arquivo ?? '') > (b.arquivo ?? '') ? 1 : (a.linha ?? 0) - (b.linha ?? 0)));
  const ocorrenciasNumeradas = inventario.map((o, i) => Object.freeze({ id: `OC-${String(i + 1).padStart(4, '0')}`, ...o }));
  return congelar({ aprovado: violacoes.length === 0, violacoes, informativos, ocorrencias: ocorrenciasNumeradas, varridos: listagem.length, links: links.length, regrasExecutadas });
}

/** Reconciliação automática: mapas sinal → quantidade por arquivo e categoria, a partir do inventário de uma análise (nunca à mão). */
function mapasDeSinais(resultado) {
  const escritores = {};
  const migrations = {};
  const rotas = {};
  const excecoesG1 = {};
  for (const o of resultado.ocorrencias) {
    if (o.regra === 'G2' || o.regra === 'G3') {
      escritores[o.arquivo] ??= { escrita: {}, remocao: {} };
      const cat = o.regra === 'G2' ? 'escrita' : 'remocao';
      escritores[o.arquivo][cat][o.sinal] = (escritores[o.arquivo][cat][o.sinal] ?? 0) + 1;
    } else if (o.regra === 'G5' && o.classificacao !== 'ESCRITA_PELO_BANCO') {
      migrations[o.arquivo] ??= {};
      migrations[o.arquivo][o.sinal] = (migrations[o.arquivo][o.sinal] ?? 0) + 1;
    } else if (o.regra === 'G7') {
      rotas[o.arquivo] ??= {};
      rotas[o.arquivo][o.sinal] = (rotas[o.arquivo][o.sinal] ?? 0) + 1;
    } else if (o.regra === 'G1' && o.classificacao !== 'RAIZ_REGISTRADA') {
      const chave = `${o.arquivo}\n${o.sinal}`;
      excecoesG1[chave] = (excecoesG1[chave] ?? 0) + 1;
    }
  }
  const ordenar = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, ehObjeto(m[k]) ? ordenar(m[k]) : m[k]]));
  return congelar({
    ESCRITORES: ordenar(escritores),
    MIGRATIONS: ordenar(migrations),
    ROTAS: ordenar(rotas),
    EXCECOES_G1: Object.entries(excecoesG1).sort().map(([chave, ocorrenciasN]) => { const [arquivo, nome] = chave.split('\n'); return { nome, arquivo, ocorrencias: ocorrenciasN }; }),
  });
}

module.exports = {
  REGRAS, CLASSIFICACOES_DE_ESCRITOR, CLASSIFICACOES_DE_ROTA, CLASSIFICACOES_DE_MIGRATION, CLASSIFICACOES_DE_DEPENDENCIA, CHAVES_DAS_LISTAS,
  ARGUMENTOS_PROIBIDOS_DO_DUMP, DIRETORIOS_IGNORADOS, LINK_SIMBOLICO, RE_APROVACAO_REF, ehIgnorado, provedorDeDisco, provedorEmMemoria, analisarArvore, mapasDeSinais,
  diferencasDeMapa, semComentariosJs, semComentariosSql, sha256,
};
