'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, P-ORF-01 dos ARTEFATOS DE BACKUP): identificação de órfãos em SIMULAÇÃO e remoção controlada. Não confundir com a limpeza de órfãos das IMAGENS (outro módulo, outra janela).
 *
 * Nome parecido com temporário NÃO é prova de órfão. Um item só é CANDIDATO quando TODAS estas condições se somam: raiz autorizada (caminho canônico, sem link, dono autorizado, sem escrita para grupo/outros); item sem link simbólico e de dono autorizado; CORRELAÇÃO com uma operação conhecida
 * (registro injetado: sem registro, o item é de ORIGEM DESCONHECIDA e fica PROTEGIDO); operação não ATIVA; janela de escrita livre; idade/retenção cumprida (relógio injetado; relógio inconsistente protege). Pacote publicado e referenciado nunca é candidato. Cada item recebe uma decisão com classe, ação e motivo fixos.
 * Os registros de operação ainda não têm armazenamento persistente (decisão pendente do responsável): a correlação depende do registro injetado e, sem ele, nada é candidato.
 *
 * REMOÇÃO: `executarLimpeza` tem três modos. 'SIMULACAO' nunca remove. 'OPERACIONAL' está DESATIVADO por constante (`LIMPEZA_OPERACIONAL_HABILITADA = false`). 'FIXTURE_DESCARTAVEL' só em NODE_ENV=test e só com raízes obtidas de `criarFixtureDescartavel` NESTE processo (registro por dev/ino + marcador com token em memória; prefixo, NODE_ENV e dono não bastam). Antes de remover, o plano é REFEITO do zero (operações e janela
 * relidas) e só entra quem continua candidato com a MESMA identidade física (dev/ino); a remoção é item a item, por nome explícito (arquivo: unlink; diretório: percurso com lstat, recusando links, dono estranho e outro dispositivo, rmdir de baixo para cima) — nunca recursão genérica. Concorrência: trava por diretório
 * (mkdir exclusivo) e trava em processo; segunda limpeza simultânea é recusada. Cada decisão é entregue a `registrar` (só raiz lógica, nome e códigos).
 */

const LIMPEZA_OPERACIONAL_HABILITADA = false;
const RAIZES = Object.freeze(['preparacoes', 'dumps', 'publicados']);
const ESTADOS_OPERACAO = Object.freeze(['ATIVA', 'INTERROMPIDA', 'CONCLUIDA', 'FALHA']);
const TIPOS_OPERACAO = Object.freeze(['BACKUP', 'RESTAURACAO']);
const TEMPORARIO = /\.[0-9a-f]{16}\.tmp$/;
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFIXO_FIXTURE = 'gepi-orf-fixture-';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração de limpeza inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const erro = (codigo) => Object.assign(new Error('limpeza de artefatos de backup'), { code: codigo });
const canonico = (p) => typeof p === 'string' && p.length > 1 && p.length <= 1024 && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/') && !/\0/.test(p);

function validarOperacoes(operacoes) {
  if (!Array.isArray(operacoes) || operacoes.length > 100000) throw configuracaoInvalida();
  for (const o of operacoes) {
    if (!ehObjeto(o) || !chavesExatas(o, ['id', 'tipo', 'estado', 'atualizadoEm', 'artefatos']) || typeof o.id !== 'string' || !NOME.test(o.id) || !TIPOS_OPERACAO.includes(o.tipo) || !ESTADOS_OPERACAO.includes(o.estado)) throw configuracaoInvalida();
    if (!Number.isSafeInteger(o.atualizadoEm) || o.atualizadoEm < 0 || !Array.isArray(o.artefatos) || o.artefatos.length > 1000) throw configuracaoInvalida();
    for (const a of o.artefatos) if (!ehObjeto(a) || !chavesExatas(a, ['raiz', 'nome']) || !RAIZES.includes(a.raiz) || typeof a.nome !== 'string' || !NOME.test(a.nome)) throw configuracaoInvalida();
  }
}

function validarEntrada(e) {
  if (!ehObjeto(e) || !chavesExatas(e, ['raizes', 'uidsAutorizados', 'operacoes', 'janelaAtiva', 'politica', 'agora'])) throw configuracaoInvalida();
  if (!ehObjeto(e.raizes) || !chavesExatas(e.raizes, RAIZES) || !RAIZES.every((r) => canonico(e.raizes[r]))) throw configuracaoInvalida();
  if (!Array.isArray(e.uidsAutorizados) || e.uidsAutorizados.length === 0 || !e.uidsAutorizados.every((u) => Number.isSafeInteger(u) && u >= 0)) throw configuracaoInvalida();
  validarOperacoes(e.operacoes);
  if (typeof e.janelaAtiva !== 'boolean') throw configuracaoInvalida();
  if (!ehObjeto(e.politica) || !chavesExatas(e.politica, ['idadeMinimaMs', 'retencaoMs']) || !Number.isSafeInteger(e.politica.idadeMinimaMs) || e.politica.idadeMinimaMs < 1 || !Number.isSafeInteger(e.politica.retencaoMs) || e.politica.retencaoMs < e.politica.idadeMinimaMs) throw configuracaoInvalida();
  if (!Number.isSafeInteger(e.agora) || e.agora < 0) throw configuracaoInvalida();
}

function raizAutorizada(raiz, uids) {
  let st;
  try { st = fs.lstatSync(raiz); if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(raiz) !== raiz) return false; } catch { return false; }
  return uids.includes(st.uid) && (st.mode & 0o022) === 0;
}

/** SIMULAÇÃO: devolve o plano; nenhuma escrita. */
function identificarOrfaos(entrada) {
  validarEntrada(entrada);
  const { raizes, uidsAutorizados: uids, operacoes, janelaAtiva, politica, agora } = entrada;
  for (const r of RAIZES) if (!raizAutorizada(raizes[r], uids)) throw erro('RAIZ_NAO_AUTORIZADA');
  const itens = [];

  const decidir = (raiz, nome, st, relativoAoPai) => {
    const base = { raiz, nome, tipo: st === null ? 'DESCONHECIDO' : st.isDirectory() ? 'DIRETORIO' : st.isFile() ? 'ARQUIVO' : 'ESPECIAL', dev: st ? st.dev : null, ino: st ? st.ino : null };
    const proteger = (classe, motivo) => ({ ...base, classe, acao: 'PROTEGER', motivo, idadeMs: null });
    if (st === null) return proteger('ILEGIVEL', 'ENTRADA_ILEGIVEL');
    if (st.isSymbolicLink()) return proteger('INSEGURO', 'LINK_SIMBOLICO');
    if (!st.isDirectory() && !st.isFile()) return proteger('INSEGURO', 'TIPO_ESPECIAL');
    if (!uids.includes(st.uid)) return proteger('INSEGURO', 'PROPRIEDADE_NAO_COMPROVADA');
    const dono = relativoAoPai ?? nome;
    const topo = dono.split('/')[0];
    const ops = operacoes.filter((o) => o.artefatos.some((a) => a.raiz === raiz && a.nome === topo));
    if (ops.length === 0) return proteger('DESCONHECIDO', TEMPORARIO.test(nome) ? 'PARECE_TEMPORARIO_SEM_CORRELACAO' : 'ORIGEM_DESCONHECIDA');
    if (janelaAtiva) return proteger('EM_USO', 'JANELA_ATIVA');
    if (ops.some((o) => o.estado === 'ATIVA')) return proteger('PREPARACAO_ATIVA', 'OPERACAO_ATIVA');
    const ultima = Math.max(...ops.map((o) => o.atualizadoEm), Math.floor(st.mtimeMs));
    if (ultima > agora) return proteger('INSEGURO', 'RELOGIO_INCONSISTENTE');
    const idadeMs = agora - ultima;
    const candidato = (classe, motivo) => ({ ...base, classe, acao: 'CANDIDATO', motivo, idadeMs });
    const protegerIdade = (motivo) => ({ ...base, classe: 'RETIDO', acao: 'PROTEGER', motivo, idadeMs });
    const eTemporario = relativoAoPai !== null && relativoAoPai !== undefined && TEMPORARIO.test(nome.split('/').pop());
    if (raiz === 'publicados') return ops.some((o) => o.estado === 'CONCLUIDA') ? proteger('PACOTE_PUBLICADO', 'PACOTE_PUBLICADO_REFERENCIADO') : proteger('PACOTE_PUBLICADO', 'PUBLICADO_COM_OPERACAO_INCOMPLETA');
    if (eTemporario) return idadeMs >= politica.idadeMinimaMs ? candidato('TEMPORARIO_ABANDONADO', 'TEMPORARIO_CORRELACIONADO_E_ANTIGO') : protegerIdade('IDADE_INSUFICIENTE');
    if (ops.some((o) => o.tipo === 'RESTAURACAO')) return idadeMs >= politica.retencaoMs ? candidato('ARTEFATO_DE_RESTAURACAO', 'RETENCAO_CUMPRIDA') : protegerIdade('RETENCAO_EM_CURSO');
    if (ops.every((o) => o.estado === 'INTERROMPIDA' || o.estado === 'FALHA')) return idadeMs >= politica.idadeMinimaMs ? candidato('PREPARACAO_INTERROMPIDA', 'OPERACAO_INTERROMPIDA_E_ANTIGA') : protegerIdade('IDADE_INSUFICIENTE');
    return idadeMs >= politica.retencaoMs ? candidato('RESIDUO_DE_OPERACAO_CONCLUIDA', 'RETENCAO_CUMPRIDA') : protegerIdade('RETENCAO_EM_CURSO');
  };

  for (const raiz of RAIZES) {
    let nomes;
    try { nomes = fs.readdirSync(raizes[raiz]).sort(); } catch { throw erro('RAIZ_NAO_AUTORIZADA'); }
    for (const nome of nomes) {
      let st = null;
      try { st = fs.lstatSync(path.join(raizes[raiz], nome)); } catch { /* ilegível */ }
      const item = decidir(raiz, nome, st, null);
      itens.push(item);
      // temporários DENTRO de um diretório correlacionado (um nível), só se o diretório em si não for inseguro
      if (st !== null && st.isDirectory() && !st.isSymbolicLink() && uids.includes(st.uid) && raiz !== 'publicados') {
        let filhos = [];
        try { filhos = fs.readdirSync(path.join(raizes[raiz], nome)).sort(); } catch { /* ignora */ }
        for (const f of filhos) {
          if (!TEMPORARIO.test(f)) continue;
          let sf = null;
          try { sf = fs.lstatSync(path.join(raizes[raiz], nome, f)); } catch { /* ilegível */ }
          itens.push(decidir(raiz, `${nome}/${f}`, sf, nome));
        }
      }
    }
  }
  const resumo = { candidatos: itens.filter((i) => i.acao === 'CANDIDATO').length, protegidos: itens.filter((i) => i.acao === 'PROTEGER').length, total: itens.length };
  const id = crypto.createHash('sha256').update(JSON.stringify(itens)).digest('hex');
  return Object.freeze({ modo: 'SIMULACAO', id, geradoEm: agora, itens: Object.freeze(itens.map((i) => Object.freeze(i))), resumo: Object.freeze(resumo) });
}

function removerEspecifico(caminho, st, uids) {
  if (st.isFile()) { fs.unlinkSync(caminho); return; }
  const dispositivo = st.dev;
  const descer = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || s.dev !== dispositivo || !uids.includes(s.uid)) throw erro('ITEM_INSEGURO_NO_INTERIOR');
      if (s.isDirectory()) { descer(p); fs.rmdirSync(p); } else if (s.isFile()) fs.unlinkSync(p); else throw erro('ITEM_INSEGURO_NO_INTERIOR');
    }
  };
  descer(caminho);
  fs.rmdirSync(caminho);
}

const MARCADOR_DA_FIXTURE = '.fixture-descartavel';
const fixturesRegistradas = new Map(); // base canônica -> { dev, ino, token } (só em memória deste processo)

/**
 * ÚNICA forma de obter raízes aceitas pelo modo FIXTURE_DESCARTAVEL: cria, em `<tmp>`, um diretório novo (mkdtemp, 0700) com as três raízes, grava nele um marcador com um token aleatório que só existe na memória deste processo e registra a identidade física (dev/ino).
 * O prefixo do nome, NODE_ENV=test e a propriedade do diretório NÃO bastam: um diretório fabricado à mão (mesmo com o prefixo, o marcador copiado ou o dono certo) não está registrado e é recusado.
 */
function criarFixtureDescartavel() {
  if (process.env.NODE_ENV !== 'test') throw configuracaoInvalida();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), PREFIXO_FIXTURE)));
  fs.chmodSync(base, 0o700);
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(base, MARCADOR_DA_FIXTURE), token, { mode: 0o600, flag: 'wx' });
  const st = fs.lstatSync(base);
  fixturesRegistradas.set(base, { dev: st.dev, ino: st.ino, token });
  const raizes = {};
  for (const nome of RAIZES) { raizes[nome] = path.join(base, nome); fs.mkdirSync(raizes[nome], { mode: 0o700 }); }
  return Object.freeze({ base, raizes: Object.freeze(raizes) });
}

function exigirFixtureRegistrada(raizes) {
  const recusa = () => erro('RAIZ_NAO_E_FIXTURE_DESCARTAVEL');
  const base = path.dirname(raizes.preparacoes);
  if (!RAIZES.every((r) => raizes[r] === path.join(base, r))) throw recusa();
  const registro = fixturesRegistradas.get(base);
  if (registro === undefined || path.dirname(base) !== fs.realpathSync(os.tmpdir())) throw recusa();
  try {
    const st = fs.lstatSync(base);
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== registro.dev || st.ino !== registro.ino || fs.realpathSync(base) !== base) throw recusa();
    const marcador = path.join(base, MARCADOR_DA_FIXTURE);
    const sm = fs.lstatSync(marcador);
    if (sm.isSymbolicLink() || !sm.isFile() || fs.readFileSync(marcador, 'utf8') !== registro.token) throw recusa();
    for (const r of RAIZES) {
      const sr = fs.lstatSync(raizes[r]);
      if (sr.isSymbolicLink() || !sr.isDirectory() || fs.realpathSync(raizes[r]) !== raizes[r]) throw recusa();
    }
  } catch (falha) {
    throw falha && falha.code === 'RAIZ_NAO_E_FIXTURE_DESCARTAVEL' ? falha : recusa();
  }
}

let limpezaEmProcesso = false;

/** `opcoes`: { modo, entrada: () => entradaDeIdentificarOrfaos (relida a cada chamada), plano, registrar? }. */
function executarLimpeza(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['modo', 'entrada', 'plano', 'registrar'].includes(k)) || typeof opcoes.entrada !== 'function' || !ehObjeto(opcoes.plano)) throw configuracaoInvalida();
  const { modo, entrada, plano } = opcoes;
  const registrar = typeof opcoes.registrar === 'function' ? opcoes.registrar : () => {};
  if (modo === 'OPERACIONAL' || LIMPEZA_OPERACIONAL_HABILITADA !== false) return Object.freeze({ executado: false, motivo: 'LIMPEZA_OPERACIONAL_DESATIVADA', removidos: 0 });
  if (modo === 'SIMULACAO') return Object.freeze({ executado: false, motivo: 'SIMULACAO', removidos: 0, candidatos: plano.itens.filter((i) => i.acao === 'CANDIDATO').length });
  if (modo !== 'FIXTURE_DESCARTAVEL' || process.env.NODE_ENV !== 'test') throw configuracaoInvalida();

  const atual = entrada();
  validarEntrada(atual);
  exigirFixtureRegistrada(atual.raizes);
  if (limpezaEmProcesso) return Object.freeze({ executado: false, motivo: 'LIMPEZA_CONCORRENTE', removidos: 0 });
  limpezaEmProcesso = true;
  const trava = path.join(path.dirname(atual.raizes.preparacoes), '.limpeza.lock');
  let travaCriada = false;
  try {
    try { fs.mkdirSync(trava, { mode: 0o700 }); travaCriada = true; } catch { return Object.freeze({ executado: false, motivo: 'LIMPEZA_CONCORRENTE', removidos: 0 }); }
    const fresco = identificarOrfaos(atual); // plano refeito do zero com o estado de agora
    const vigentes = new Map(fresco.itens.filter((i) => i.acao === 'CANDIDATO').map((i) => [`${i.raiz}|${i.nome}|${i.dev}|${i.ino}`, i]));
    let removidos = 0;
    for (const item of plano.itens.filter((i) => i.acao === 'CANDIDATO')) {
      const chave = `${item.raiz}|${item.nome}|${item.dev}|${item.ino}`;
      const decisao = { raiz: item.raiz, nome: item.nome, classe: item.classe };
      if (!vigentes.has(chave)) { registrar({ ...decisao, resultado: 'PULADO', motivo: 'MUDOU_DESDE_O_PLANO' }); continue; }
      const caminho = path.join(atual.raizes[item.raiz], item.nome);
      try {
        const st = fs.lstatSync(caminho);
        if (st.isSymbolicLink() || st.dev !== item.dev || st.ino !== item.ino) { registrar({ ...decisao, resultado: 'PULADO', motivo: 'IDENTIDADE_FISICA_DIVERGENTE' }); continue; }
        removerEspecifico(caminho, st, atual.uidsAutorizados);
        removidos += 1;
        registrar({ ...decisao, resultado: 'REMOVIDO', motivo: item.motivo });
      } catch (falha) {
        if (falha && falha.code === 'ENOENT') { registrar({ ...decisao, resultado: 'PULADO', motivo: 'JA_REMOVIDO' }); continue; }
        registrar({ ...decisao, resultado: 'FALHA', motivo: falha && typeof falha.code === 'string' && /^[A-Z_]{3,60}$/.test(falha.code) ? falha.code : 'ERRO_NA_REMOCAO' });
      }
    }
    return Object.freeze({ executado: true, motivo: null, removidos });
  } finally {
    if (travaCriada) { try { fs.rmdirSync(trava); } catch { /* mantida: não removemos o que não conseguimos provar nosso */ } }
    limpezaEmProcesso = false;
  }
}

module.exports = { identificarOrfaos, executarLimpeza, criarFixtureDescartavel, LIMPEZA_OPERACIONAL_HABILITADA, RAIZES, PREFIXO_FIXTURE };
