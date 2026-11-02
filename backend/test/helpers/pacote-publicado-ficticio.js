'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lerConfiguracao } = require('../../src/config/imagens');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { criarInicializacaoConfiavel, executarBackupEncadeado } = require('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');
const { criarVerificadorEstrutural } = require('../../src/services/imagem-backup-estrutura.service');
const { criarPublicador, criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarFonteDeChaves, criarLeitorV2, criarSelagemAutenticada } = require('../../src/services/imagem-backup-manifesto-autenticado.service');

/**
 * Gerador de PACOTE COMPLETO FICTÍCIO para os testes de restauração (Marco D): executa o pipeline REAL do backup (encadeamento, T1/T2, estrutura simulada, pacote e publicação de TESTE_CONTROLADO) em diretórios temporários
 * exclusivos e devolve APENAS o que está persistido em disco (caminhos e nomes). Nenhum objeto, closure ou marca do pipeline é devolvido: quem testa a restauração parte dos arquivos. Só dados fictícios; PostgreSQL, `pg_dump`,
 * `pg_restore --list` e a trava são simulados.
 */

const PREFIXO = 'gepi-md-test-';
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_BYTES = Buffer.from('dump-ficticio-restauracao-0123456789-'.repeat(100));
const ID_SNAPSHOT = '00000003-0000001B-1';
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const raizes = [];

function limparTemporarios() {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
}
function novaRaiz() {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(p, 0o700);
  raizes.push(p);
  return p;
}

function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}
const paginar = (linhas, [depoisDe, limite]) => linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);

/** Constrói e PUBLICA um pacote fictício; devolve { raiz, publicados, nome, plano, dumpBytes, limpar }. */
async function construirPacotePublicado({ nome = 'prep-1', autenticado = null, devolverEvidencias = false, produtor = null, origensAceitas = ['TESTE_CONTROLADO'] } = {}) {
  const raiz = novaRaiz();
  const buf = (t) => Buffer.from(t, 'utf8');
  const pm = buf('padrao-mestre-conteudo');
  const pn = buf('padrao-miniatura-conteudo');
  const em = buf('empresa7-mestre');
  const ee = buf('empresa7-exibicao');
  const en = buf('empresa7-miniatura');
  const registros = {
    padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }],
    empresa: [{ id: '2', empresaId: 7, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(em), sha256Exibicao: sha(ee), sha256Miniatura: sha(en), bytesMestre: em.length, bytesExibicao: ee.length, bytesMiniatura: en.length }],
  };
  const linhasPadrao = [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }];
  const linhasEmpresa = [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }];
  const plano = planejarArquivos(registros);
  const dirOrigem = path.join(raiz, 'origem');
  const origem = criarArmazenamentoImagens({ diretorio: dirOrigem });
  for (const item of plano) await origem.gravar(item.chave, [pm, pn, em, ee, en].find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const pai = path.join(raiz, 'preparacoes');
  const dumps = path.join(raiz, 'dumps');
  const publicados = path.join(raiz, 'publicados');
  for (const d of [pai, dumps, publicados]) fs.mkdirSync(d, { mode: 0o700 });

  const estado = { documento: null };
  const janela = {
    async adquirir(argumentos) {
      const token = 'token-md';
      estado.documento = { token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { return { confirmada: estado.documento !== null && estado.documento.token === token }; },
        async liberar() { estado.documento = null; return { liberada: true }; },
      });
    },
  };
  const criarCliente = () => {
    const c = {
      ouvintes: { error: [], end: [] },
      async connect() {},
      async query(sql, parametros) {
        switch (tipoDe(sql)) {
          case 'EXPORTAR': return { rows: [{ snapshot_id: ID_SNAPSHOT }] };
          case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
          case 'PADRAO': return { rows: paginar(linhasPadrao, parametros) };
          case 'EMPRESA': return { rows: paginar(linhasEmpresa, parametros) };
          default: return { rows: [] };
        }
      },
      async end() { for (const f of c.ouvintes.end) f(); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    return c;
  };
  let caminhoDoDump = null;
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    lancador: { lancar(spec) { fs.writeSync(spec.opcoes.stdio[1], DUMP_BYTES); return { pid: 4242, saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() }; } },
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return false; } },
    arquivos: {
      criarExclusivo(spec) {
        caminhoDoDump = path.join(spec.diretorio, spec.nome);
        const descritor = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
        let fechado = false;
        return { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
      },
    },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
  };
  const selagemReal = autenticado === null ? criarSelagem() : criarSelagemAutenticada(autenticado);
  const verificador = criarVerificadorEstrutural({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador: {
      lancar() {
        return { pid: 5151, saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve(), resultado: Promise.resolve({ formato: 'CUSTOM', entradas: 12, truncado: false }) };
      },
    },
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
  });
  const publicador = criarPublicador({
    raizDoDestino: publicados,
    produtorDeRelatorio: produtor === null ? criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }) : produtor,
    origensAceitas,
    ...(autenticado === null ? {} : { leitorDeManifesto: criarLeitorV2({ fonteDeChaves: autenticado.fonteDeChaves }) }),
  });
  const inicializacao = criarInicializacaoConfiavel({
    configuracaoDeImagens: lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: dirOrigem }),
    diretorioPai: pai,
    diretorioDoDump: dumps,
    janela,
    conexao: { criarConexao: () => criarCliente(), temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) }, prazos: { finalizacaoMs: 5000 } },
    dump,
    selagem: { selar: (e) => selagemReal.selar(e), verificar: (e) => selagemReal.verificar(e), ...(autenticado === null ? {} : { autenticar: (c) => selagemReal.autenticar(c) }) },
    maxBytesPorArquivo: 4096,
    declaracaoDoDump: { async sha256() { return sha(DUMP_BYTES); } },
    verificadorEstrutural: verificador,
    publicador,
  });
  const resultado = await executarBackupEncadeado({ inicializacao, nomeDaPreparacao: nome, conjuntoId: 'conjunto-md-0001' });
  // `devolverEvidencias` expõe o resultado do pipeline (evidências RECONHECIDAS) e tolera publicação bloqueada; o uso padrão continua exigindo a publicação.
  if (!devolverEvidencias && (!resultado.publicacao || resultado.publicacao.publicada !== true)) throw new Error('o pacote fictício não foi publicado');
  return {
    raiz,
    publicados,
    nome,
    plano: plano.map((p) => ({ chave: p.chave, sha256: p.sha256 })),
    dumpBytes: DUMP_BYTES,
    caminho: path.join(publicados, nome),
    ...(devolverEvidencias ? { evidencias: resultado, preparacao: path.join(pai, nome) } : {}),
  };
}

/** Fonte de chaves FICTÍCIA: segredos aleatórios gerados em memória no processo do teste (nenhuma credencial real). */
function criarFonteFicticia(extra = []) {
  const principal = { id: 'chave-teste-1', segredo: crypto.randomBytes(32) };
  return { fonteDeChaves: criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [principal, ...extra] }), chaveId: principal.id, segredo: principal.segredo };
}

module.exports = { criarFonteFicticia, construirPacotePublicado, limparTemporarios, novaRaiz, DUMP_BYTES, PREFIXO };
