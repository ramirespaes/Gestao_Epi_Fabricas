'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');
const { ID_DA_OPERACAO } = require('./imagem-backup-evidencia-dump.service');
const { ehFaltaDeEspaco } = require('../utils/orcamento-de-bytes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): REGISTRO DURÁVEL DA PUBLICAÇÃO e QUARENTENA. Resolve a lacuna de que, depois de uma publicação INCERTA, INDETERMINADA ou comprometida por cancelamento, nada em disco dizia que o pacote não podia ser aceito.
 *
 * PRINCÍPIO (escrita antecipada + evidência POSITIVA): a quarentena NÃO depende de alguém conseguir gravar um marcador DEPOIS do problema (uma queda entre o `rename` e o marcador deixaria um pacote publicado sem marca). Um pacote só é ADMISSÍVEL com PROVA POSITIVA gravada: a CONCLUSÃO, escrita pelo
 * publicador apenas depois de o `rename` e do `fsync` do destino terem dado certo e sem pedido de cancelamento pendente. A INTENÇÃO é gravada ANTES do `rename`. Logo: intenção sem conclusão = publicação não concluída (recusada), em qualquer ponto de queda; a AUSÊNCIA de registro nunca é prova de publicação válida
 * (os leitores de produção a recusam). A QUARENTENA explícita é um terceiro registro, acrescentado quando a incerteza é conhecida (INCERTA, INDETERMINADA, publicado sob cancelamento) e sempre prevalece sobre a conclusão.
 *
 * REGISTROS (um arquivo por tipo e por pacote, SEM SOBRESCRITA: criação exclusiva `O_EXCL|O_NOFOLLOW`, 0600, dentro de um diretório 0700 do mesmo dono, `fsync` do arquivo e do diretório; o diretório novo tem o pai sincronizado). Ficam ao lado da raiz de publicados (`.registro-publicacao-<raiz>`), nunca dentro
 * do pacote (o conjunto exato de arquivos do pacote não muda) nem dentro da raiz. Cada registro é JSON canônico com nome, operação, conjunto, SHA-256 do manifesto e do dump (identidade ligada ao pacote), `integridade` (SHA-256 do corpo) e, quando há fonte de chaves, HMAC-SHA256 com domínio PRÓPRIO
 * (o segredo nunca é gravado). Nenhum caminho, segredo ou texto de dependência entra no registro.
 *
 * LEITURA (`lerSituacao`): lstat sem seguir link, dono e permissões conferidos, tamanho limitado, abertura `O_NOFOLLOW` e identidade (dev/ino) reconferida. Estados: ADMISSIVEL | EM_QUARENTENA | PUBLICACAO_NAO_CONCLUIDA | REGISTRO_INVALIDO | SEM_REGISTRO. Qualquer arquivo ilegível, inseguro, de outro dono, adulterado
 * ou de outro pacote é REGISTRO_INVALIDO (falha fechada); um arquivo de quarentena presente bloqueia mesmo ilegível.
 *
 * RETIRADA: `retirarQuarentena` é um procedimento EXPLÍCITO — exige uma autorização produzida por `criarAutorizacaoDeRetirada` (responsável, justificativa e a confirmação textual ligada ao pacote), fonte de chaves ativa e grava um registro RETIRADA autenticado (nada é apagado). Nenhum caminho do pipeline a chama, e passar
 * na verificação de integridade nunca retira a quarentena. A política de QUEM pode autorizar é decisão operacional (fora deste código).
 *
 * LIMITES: o HMAC prova posse da chave, não a origem; sem fonte de chaves o registro só tem integridade (e os leitores com fonte o recusam). A atomicidade entre sistemas de arquivos distintos e a durabilidade de mídia dependem do sistema de arquivos. Não prova que o pacote é restaurável.
 */

const VERSAO = 1;
const DOMINIO = Buffer.from('SAFEWORK-BACKUP-REGISTRO-PUBLICACAO-V1\n', 'utf8');
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LIMITE_DO_ARQUIVO = 16 * 1024;
const TIPOS = Object.freeze(['INTENCAO', 'CONCLUSAO', 'QUARENTENA', 'RETIRADA']);
const MOTIVOS_DE_QUARENTENA = Object.freeze(['PUBLICACAO_INCERTA', 'PUBLICACAO_SEM_CONCLUSAO_CONHECIDA', 'PUBLICADO_SOB_CANCELAMENTO', 'CONCLUSAO_NAO_REGISTRADA']);
const ESTADOS = Object.freeze({ ADMISSIVEL: 'ADMISSIVEL', EM_QUARENTENA: 'EM_QUARENTENA', PUBLICACAO_NAO_CONCLUIDA: 'PUBLICACAO_NAO_CONCLUIDA', REGISTRO_INVALIDO: 'REGISTRO_INVALIDO', SEM_REGISTRO: 'SEM_REGISTRO' });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const uidAtual = typeof process.getuid === 'function' ? process.getuid() : null;

const OPS_PADRAO = Object.freeze({
  mkdir: (p) => fsp.mkdir(p, { mode: 0o700 }),
  lstat: (p) => fsp.lstat(p),
  listar: (p) => fsp.readdir(p),
  abrirExclusivo: (p) => fsp.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600),
  abrirLeitura: (p) => fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  escrever: (h, buffer) => h.writeFile(buffer),
  fsyncArquivo: (h) => h.sync(),
  fsyncDiretorio: async (p) => { const h = await fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { await h.sync(); } finally { await h.close(); } },
});
const OPERACOES = Object.keys(OPS_PADRAO);

class Falha extends Error { constructor(motivo) { super('registro de publicação'); this.motivo = motivo; } }
const falha = (motivo) => new Falha(motivo);

function completarOps(ops) {
  if (ops === undefined) return OPS_PADRAO;
  if (!ehObjeto(ops) || !Reflect.ownKeys(ops).every((k) => typeof k === 'string' && OPERACOES.includes(k)) || !Object.values(ops).every(ehFuncao)) throw new TypeError('operações do registro inválidas');
  return Object.freeze({ ...OPS_PADRAO, ...ops });
}

const raizValida = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => /^[A-Za-z0-9._+~@-]{1,255}$/.test(p) && p !== '.' && p !== '..');

/** Diretório dos registros: AO LADO da raiz de publicados (nunca dentro dela nem dos pacotes). */
function diretorioDoRegistro(raiz) {
  if (!raizValida(raiz)) throw new TypeError('raiz de publicados inválida');
  return path.join(path.dirname(raiz), `.registro-publicacao-${path.basename(raiz)}`);
}

/** `exigirOperacao`: quem ESCREVE a intenção/conclusão/quarentena conhece a operação; quem LÊ (restaurador) e quem retira só conhece o pacote (nome, conjunto, manifesto e dump). */
function identidadeValida(i, { exigirOperacao = true } = {}) {
  return ehObjeto(i) && typeof i.nome === 'string' && NOME.test(i.nome) && (exigirOperacao ? typeof i.operacaoId === 'string' && ID_DA_OPERACAO.test(i.operacaoId) : (i.operacaoId === undefined || (typeof i.operacaoId === 'string' && ID_DA_OPERACAO.test(i.operacaoId))))
    && typeof i.conjuntoId === 'string' && i.conjuntoId !== '' && i.conjuntoId.length <= 200 && !CONTROLE.test(i.conjuntoId)
    && typeof i.sha256Manifesto === 'string' && SHA256.test(i.sha256Manifesto)
    && ehObjeto(i.dump) && Number.isSafeInteger(i.dump.bytes) && i.dump.bytes > 0 && typeof i.dump.sha256 === 'string' && SHA256.test(i.dump.sha256);
}

function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (ehObjeto(valor)) return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  return JSON.stringify(valor);
}
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const TENTATIVA = /^[0-9a-f]{16}$/;
/** A INTENÇÃO é por TENTATIVA de publicação (uma nova tentativa depois de uma falha comprovada sem publicação continua possível); os demais registros são um por pacote. */
const nomeDoArquivo = (nome, tipo, tentativa) => (tipo === 'INTENCAO' ? `${nome}.intencao.${tentativa}.json` : `${nome}.${tipo.toLowerCase()}.json`);

function calcularMac(segredo, textoCanonico) {
  return crypto.createHmac('sha256', segredo).update(Buffer.concat([DOMINIO, Buffer.from(textoCanonico, 'utf8')])).digest('hex');
}

function montarRegistro({ tipo, identidade, extra = {}, fonteDeChaves, chaveId, relogio }) {
  const corpo = {
    versao: VERSAO,
    tipo,
    nome: identidade.nome,
    ...(identidade.operacaoId === undefined ? {} : { operacaoId: identidade.operacaoId }),
    conjuntoId: identidade.conjuntoId,
    sha256Manifesto: identidade.sha256Manifesto,
    dump: { bytes: identidade.dump.bytes, sha256: identidade.dump.sha256 },
    criadoEm: relogio().toISOString(),
    ...extra,
  };
  const integridade = sha256(canonico(corpo));
  let registro = { ...corpo, integridade };
  if (fonteDeChaves !== undefined) {
    const chave = fonteDeChaves.obter(chaveId);
    if (!ehObjeto(chave) || chave.situacao !== 'ATIVA' || !(chave.segredo instanceof Uint8Array)) throw falha('CHAVE_INDISPONIVEL');
    registro = { ...registro, chaveId };
    registro = { ...registro, mac: calcularMac(chave.segredo, canonico(registro)) };
  }
  return `${canonico(registro)}\n`;
}

/** Valida um registro lido contra a identidade esperada. Devolve { ok, autenticado } ou { ok:false, motivo } (códigos fixos). */
function validarRegistro(texto, tipoEsperado, identidade, fonteDeChaves) {
  let r;
  try { r = JSON.parse(texto); } catch { return { ok: false, motivo: 'ILEGIVEL' }; }
  if (!ehObjeto(r) || r.versao !== VERSAO || r.tipo !== tipoEsperado) return { ok: false, motivo: 'FORMA_INVALIDA' };
  if ((tipoEsperado === 'INTENCAO' || tipoEsperado === 'CONCLUSAO') && (typeof r.tentativa !== 'string' || !TENTATIVA.test(r.tentativa))) return { ok: false, motivo: 'FORMA_INVALIDA' };
  const { integridade, mac, chaveId, ...resto } = r;
  const semMac = { ...resto, integridade, ...(chaveId === undefined ? {} : { chaveId }) };
  if (typeof integridade !== 'string' || !SHA256.test(integridade) || sha256(canonico(resto)) !== integridade) return { ok: false, motivo: 'ADULTERADO' };
  if (r.nome !== identidade.nome || r.conjuntoId !== identidade.conjuntoId || r.sha256Manifesto !== identidade.sha256Manifesto || !ehObjeto(r.dump) || r.dump.sha256 !== identidade.dump.sha256 || r.dump.bytes !== identidade.dump.bytes) return { ok: false, motivo: 'DIVERGENTE_DO_PACOTE' };
  let autenticado = false;
  if (fonteDeChaves !== undefined) {
    if (typeof mac !== 'string' || !SHA256.test(mac) || typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId)) return { ok: false, motivo: 'NAO_AUTENTICADO' };
    const chave = fonteDeChaves.obter(chaveId);
    if (!ehObjeto(chave) || chave.situacao !== 'ATIVA' || !(chave.segredo instanceof Uint8Array)) return { ok: false, motivo: 'CHAVE_INDISPONIVEL' };
    const esperado = Buffer.from(calcularMac(chave.segredo, canonico(semMac)), 'hex');
    const recebido = Buffer.from(mac, 'hex');
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return { ok: false, motivo: 'MAC_INVALIDO' };
    autenticado = true;
  }
  return { ok: true, autenticado, registro: r };
}

async function diretorioSeguro(ops, diretorio) {
  const st = await ops.lstat(diretorio);
  if (st.isSymbolicLink() || !st.isDirectory()) throw falha('DIRETORIO_INVALIDO');
  if (uidAtual !== null && st.uid !== uidAtual) throw falha('DIRETORIO_DE_OUTRO_DONO');
  if ((st.mode & 0o077) !== 0) throw falha('DIRETORIO_PERMISSIVO');
}

async function garantirDiretorio(ops, raiz) {
  const diretorio = diretorioDoRegistro(raiz);
  let criado = false;
  try { await ops.mkdir(diretorio); criado = true; } catch (f) {
    if (!f || f.code !== 'EEXIST') throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'DIRETORIO_NAO_CRIADO');
  }
  await diretorioSeguro(ops, diretorio);
  if (criado) { try { await ops.fsyncDiretorio(path.dirname(raiz)); } catch (f) { throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'FSYNC_FALHOU'); } }
  return diretorio;
}

/** Grava SEM sobrescrever: criação exclusiva, escrita completa, fsync do arquivo e do diretório. EEXIST = JA_EXISTE. Um registro parcial (falha no meio) fica no disco e vale como registro INVÁLIDO (bloqueia). */
async function gravarExclusivo(ops, raiz, nomeArquivo, texto) {
  const diretorio = await garantirDiretorio(ops, raiz);
  const caminho = path.join(diretorio, nomeArquivo);
  let h;
  try { h = await ops.abrirExclusivo(caminho); } catch (f) {
    if (f && f.code === 'EEXIST') throw falha('JA_EXISTE');
    throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'ABERTURA_FALHOU');
  }
  try {
    try { await ops.escrever(h, Buffer.from(texto, 'utf8')); } catch (f) { throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU'); }
    try { await ops.fsyncArquivo(h); } catch (f) { throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'FSYNC_FALHOU'); }
  } finally {
    await h.close().catch(() => {});
  }
  try { await ops.fsyncDiretorio(diretorio); } catch (f) { throw falha(ehFaltaDeEspaco(f) ? 'ESPACO_ESGOTADO' : 'FSYNC_FALHOU'); }
}

/** Lê um registro: AUSENTE | { situacao:'PRESENTE', texto } | { situacao:'INSEGURO'|'ILEGIVEL' }. Nunca segue link e confere dono, permissões, tamanho e identidade do arquivo aberto. */
async function lerArquivo(ops, caminho) {
  let st;
  try { st = await ops.lstat(caminho); } catch (f) { return f && f.code === 'ENOENT' ? { situacao: 'AUSENTE' } : { situacao: 'ILEGIVEL' }; }
  if (st.isSymbolicLink() || !st.isFile() || (uidAtual !== null && st.uid !== uidAtual) || (st.mode & 0o077) !== 0 || st.size > LIMITE_DO_ARQUIVO) return { situacao: 'INSEGURO' };
  let h;
  try {
    h = await ops.abrirLeitura(caminho);
    const aberto = await h.stat();
    if (aberto.ino !== st.ino || aberto.dev !== st.dev || aberto.size > LIMITE_DO_ARQUIVO) return { situacao: 'INSEGURO' };
    return { situacao: 'PRESENTE', texto: (await h.readFile()).toString('utf8') };
  } catch {
    return { situacao: 'ILEGIVEL' };
  } finally {
    if (h !== undefined) await h.close().catch(() => {});
  }
}

const resultado = (dados) => Object.freeze(dados);
const resumo = (estado, extra = {}) => resultado({ estado, ...extra });

/**
 * Situação durável do pacote `identidade.nome` na raiz `raiz`. Só LEITURA. Não confia em memória: lê o disco.
 * @param {{ raiz: string, identidade: object, fonteDeChaves?: object, ops?: object }} entrada
 */
async function lerSituacao({ raiz, identidade, fonteDeChaves, ops: opsInjetadas } = {}) {
  const ops = completarOps(opsInjetadas);
  if (!identidadeValida(identidade, { exigirOperacao: false })) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'IDENTIDADE_INVALIDA' });
  if (fonteDeChaves !== undefined && !ehFonteDeChaves(fonteDeChaves)) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'FONTE_INVALIDA' });
  let diretorio;
  try { diretorio = diretorioDoRegistro(raiz); } catch { return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'RAIZ_INVALIDA' }); }
  try {
    await diretorioSeguro(ops, diretorio);
  } catch (f) {
    if (f instanceof Falha) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: f.motivo });
    return f && f.code === 'ENOENT' ? resumo(ESTADOS.SEM_REGISTRO) : resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'DIRETORIO_ILEGIVEL' });
  }
  const ler = (tipo, tentativa) => lerArquivo(ops, path.join(diretorio, nomeDoArquivo(identidade.nome, tipo, tentativa)));
  const [quarentena, conclusao, retirada] = [await ler('QUARENTENA'), await ler('CONCLUSAO'), await ler('RETIRADA')];
  // Há alguma INTENÇÃO (de qualquer tentativa) deste pacote? Listagem do diretório do registro (pequeno); falha ao listar = inconclusivo (fecha).
  let temIntencao = false;
  try { temIntencao = (await ops.listar(diretorio)).some((n) => n.startsWith(`${identidade.nome}.intencao.`) && n.endsWith('.json')); } catch { return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'DIRETORIO_ILEGIVEL' }); }

  // 1) RETIRADA autorizada e válida levanta a quarentena/não conclusão; uma retirada presente porém inválida bloqueia.
  if (retirada.situacao !== 'AUSENTE') {
    if (retirada.situacao !== 'PRESENTE') return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'RETIRADA_INSEGURA' });
    const v = fonteDeChaves === undefined ? { ok: false, motivo: 'SEM_FONTE_DE_CHAVES' } : validarRegistro(retirada.texto, 'RETIRADA', identidade, fonteDeChaves);
    if (!v.ok) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: `RETIRADA_${v.motivo}` });
    return resumo(ESTADOS.ADMISSIVEL, { origem: 'RETIRADA_AUTORIZADA', autenticado: true });
  }
  // 2) Quarentena explícita prevalece sobre tudo (inclusive ilegível: o arquivo existir já bloqueia).
  if (quarentena.situacao !== 'AUSENTE') {
    let motivo = 'REGISTRO_ILEGIVEL';
    if (quarentena.situacao === 'PRESENTE') { const v = validarRegistro(quarentena.texto, 'QUARENTENA', identidade, undefined); motivo = v.ok ? v.registro.motivo : `REGISTRO_${v.motivo}`; }
    return resumo(ESTADOS.EM_QUARENTENA, { motivo });
  }
  // 3) Conclusão: prova positiva. Intenção sem conclusão = publicação não concluída.
  if (conclusao.situacao === 'AUSENTE') return temIntencao ? resumo(ESTADOS.PUBLICACAO_NAO_CONCLUIDA) : resumo(ESTADOS.SEM_REGISTRO);
  if (conclusao.situacao !== 'PRESENTE') return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'REGISTRO_INSEGURO' });
  const vc = validarRegistro(conclusao.texto, 'CONCLUSAO', identidade, fonteDeChaves);
  if (!vc.ok) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: `CONCLUSAO_${vc.motivo}` });
  // a conclusão referencia a TENTATIVA: só a intenção dessa tentativa a sustenta (intenções de tentativas anteriores sem publicação não contam)
  const intencao = await ler('INTENCAO', vc.registro.tentativa);
  if (intencao.situacao === 'AUSENTE') return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'INTENCAO_AUSENTE' });
  if (intencao.situacao !== 'PRESENTE') return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: 'REGISTRO_INSEGURO' });
  const vi = validarRegistro(intencao.texto, 'INTENCAO', identidade, fonteDeChaves);
  if (!vi.ok || vi.registro.tentativa !== vc.registro.tentativa) return resumo(ESTADOS.REGISTRO_INVALIDO, { motivo: vi.ok ? 'INTENCAO_DE_OUTRA_TENTATIVA' : `INTENCAO_${vi.motivo}` });
  return resumo(ESTADOS.ADMISSIVEL, { origem: 'CONCLUSAO', autenticado: vc.autenticado });
}

const autorizacoes = new WeakSet();

/** Autorização EXPLÍCITA para retirar uma quarentena. A confirmação textual é ligada ao pacote; nada a produz automaticamente. */
function textoDeConfirmacao(identidade) { return `RETIRAR-QUARENTENA ${identidade.nome} ${identidade.sha256Manifesto.slice(0, 16)}`; }
function criarAutorizacaoDeRetirada({ responsavel, justificativa, confirmacao, identidade } = {}) {
  const texto = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !CONTROLE.test(v);
  if (!identidadeValida(identidade, { exigirOperacao: false }) || !texto(responsavel, 100) || !texto(justificativa, 500) || confirmacao !== textoDeConfirmacao(identidade)) throw new TypeError('autorização de retirada inválida');
  const a = Object.freeze({ responsavel: responsavel.trim(), justificativa: justificativa.trim(), nome: identidade.nome, sha256Manifesto: identidade.sha256Manifesto });
  autorizacoes.add(a);
  return a;
}

/**
 * Cria o registro de publicação de UMA raiz. `fonteDeChaves`/`chaveId` (opcionais, juntos) autenticam os registros; sem eles só há integridade.
 * Todas as escritas devolvem { ok:true } ou { ok:false, motivo } (nunca lançam).
 */
function criarRegistroDePublicacao({ raiz, fonteDeChaves, chaveId, ops: opsInjetadas, relogio = () => new Date() } = {}) {
  if (!raizValida(raiz)) throw new TypeError('raiz de publicados inválida');
  if ((fonteDeChaves === undefined) !== (chaveId === undefined)) throw new TypeError('fonte de chaves e chave devem vir juntas');
  if (fonteDeChaves !== undefined && (!ehFonteDeChaves(fonteDeChaves) || typeof chaveId !== 'string' || !CHAVE_ID.test(chaveId))) throw new TypeError('fonte de chaves inválida');
  if (!ehFuncao(relogio)) throw new TypeError('relógio inválido');
  const ops = completarOps(opsInjetadas);

  async function escrever(tipo, identidade, extra, { idempotente = false, exigirOperacao = true } = {}) {
    if (!identidadeValida(identidade, { exigirOperacao })) return resultado({ ok: false, motivo: 'IDENTIDADE_INVALIDA' });
    if (extra.tentativa !== undefined && !TENTATIVA.test(extra.tentativa)) return resultado({ ok: false, motivo: 'TENTATIVA_INVALIDA' });
    try {
      const texto = montarRegistro({ tipo, identidade, extra, fonteDeChaves, chaveId, relogio });
      await gravarExclusivo(ops, raiz, nomeDoArquivo(identidade.nome, tipo, extra.tentativa), texto);
      return resultado({ ok: true, ...(extra.tentativa === undefined ? {} : { tentativa: extra.tentativa }) });
    } catch (f) {
      if (f instanceof Falha) {
        if (f.motivo === 'JA_EXISTE' && idempotente) return resultado({ ok: true, jaExistia: true });
        return resultado({ ok: false, motivo: f.motivo });
      }
      return resultado({ ok: false, motivo: 'FALHA_INESPERADA' });
    }
  }

  return Object.freeze({
    diretorio: diretorioDoRegistro(raiz),
    /** Antes do `rename`: o pacote só pode aparecer no destino DEPOIS desta intenção durável. */
    registrarIntencao: (identidade) => escrever('INTENCAO', identidade, { tentativa: crypto.randomBytes(8).toString('hex') }),
    /** Prova positiva: só depois do `rename` e do `fsync` do destino; referencia a TENTATIVA cuja intenção a sustenta. */
    registrarConclusao: (identidade, tentativa) => (typeof tentativa === 'string' && TENTATIVA.test(tentativa)
      ? escrever('CONCLUSAO', identidade, { tentativa })
      : Promise.resolve(resultado({ ok: false, motivo: 'TENTATIVA_INVALIDA' }))),
    registrarQuarentena: (identidade, motivo) => (MOTIVOS_DE_QUARENTENA.includes(motivo)
      ? escrever('QUARENTENA', identidade, { motivo }, { idempotente: true })
      : Promise.resolve(resultado({ ok: false, motivo: 'MOTIVO_INVALIDO' }))),
    /** Procedimento explícito e autorizado (ver cabeçalho). Não apaga nada; grava RETIRADA autenticada. */
    async retirarQuarentena(identidade, autorizacao) {
      if (fonteDeChaves === undefined) return resultado({ ok: false, motivo: 'SEM_FONTE_DE_CHAVES' });
      if (!identidadeValida(identidade, { exigirOperacao: false }) || !autorizacoes.has(autorizacao) || autorizacao.nome !== identidade.nome || autorizacao.sha256Manifesto !== identidade.sha256Manifesto) return resultado({ ok: false, motivo: 'AUTORIZACAO_INVALIDA' });
      const atual = await lerSituacao({ raiz, identidade, fonteDeChaves, ops });
      if (atual.estado === ESTADOS.ADMISSIVEL || atual.estado === ESTADOS.SEM_REGISTRO) return resultado({ ok: false, motivo: 'NADA_A_RETIRAR' });
      return escrever('RETIRADA', identidade, { responsavel: autorizacao.responsavel, justificativa: autorizacao.justificativa, estadoAnterior: atual.estado }, { exigirOperacao: false });
    },
    lerSituacao: (identidade) => lerSituacao({ raiz, identidade, ...(fonteDeChaves === undefined ? {} : { fonteDeChaves }), ops }),
  });
}

module.exports = { criarRegistroDePublicacao, lerSituacao, criarAutorizacaoDeRetirada, textoDeConfirmacao, diretorioDoRegistro, identidadeValida, ESTADOS, MOTIVOS_DE_QUARENTENA, TIPOS };
