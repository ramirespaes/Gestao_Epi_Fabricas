'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-EVIDENCIA-DUMP-1): OBSERVADOR e PRODUTOR de EVIDÊNCIA FÍSICA do arquivo de dump. Contrato PROVISÓRIO; uma instância por operação.
 * Produz somente o que demonstra: a quantidade de bytes e o SHA-256 CALCULADO sobre os bytes lidos do arquivo criado por esta operação. NÃO declara o dump concluído, NÃO produz `sha256Declarado`
 * nem `sha256Recalculado` (o `pg_dump` escreve direto no descritor, nada passa pelo Node: não há fonte independente de "hash declarado", e uma segunda leitura do mesmo arquivo não a substitui),
 * NÃO enxerga o veredito do supervisor (término confirmado, grupo vazio, permissão de liberar a trava), NÃO autentica a evidência e não afirma validade, publicação ou recuperabilidade.
 *
 * `criarObservadorDoDump({ arquivos, lancador })` (ESTRITO; TypeError se inválido) -> { arquivos, lancador, evidencia }. `arquivos` e `lancador` são envoltórios que DELEGAM aos originais (métodos
 * capturados uma vez; `this` original; mesmos argumentos; retorno e erros repassados sem alteração) e só registram: na criação exclusiva, o caminho e o `dev`/`ino` do descritor; no lançamento, o
 * término (`saida`) e o fechamento dos fluxos (`fluxosFechados`) BRUTOS do lançador, capturando uma linha de base do arquivo quando os fluxos fecham. Nunca fecham o descritor do serviço do dump.
 *
 * `evidencia()` -> { ok: true, bytes, sha256Calculado } | { ok: false, motivo } (congelados; motivos fixos). Consumo ÚNICO, reservado de forma SÍNCRONA antes de qualquer await: LIVRE -> EM_ANDAMENTO ->
 * CONSUMIDA. Consulta prematura (não observado, processo em andamento, saída ruim, fluxos abertos) é recusada SEM consumir. Depois de reservado, qualquer desfecho (sucesso ou falha) consome
 * definitivamente: chamada em andamento ou posterior é JA_CONSUMIDA, nunca há nova tentativa. A leitura abre o caminho com O_RDONLY|O_NOFOLLOW, confere dev/ino com os da criação, exige arquivo regular e
 * não vazio, compara com a linha de base (tamanho, mtime, ctime), lê em blocos DO MESMO descritor e confere de novo os metadados e o fim do arquivo.
 *
 * LIMITES: igualdade de inode não é conteúdo imutável; tamanho/mtime/ctime não eliminam TOCTOU (reescrita de mesmo tamanho dentro da granularidade do relógio, troca de diretórios intermediários
 * e mudança durante a leitura não são totalmente excluídas); o vínculo com snapshot e conjunto não existe nos contratos atuais; o isolamento por instância é em memória e NÃO é autenticidade.
 */

const OPERACAO = ['arquivos', 'lancador'];
/** Formato da identidade de operação (textual, limitado, sem controle). Identifica a execução; NÃO a autentica nem a autoriza. */
const ID_DA_OPERACAO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Marcas de origem em memória: só este módulo produz observadores e evidências físicas reconhecidos (não é autorização operacional). */
const observadoresProduzidos = new WeakSet();
const evidenciasProduzidas = new WeakSet();
const TAMANHO_DO_BLOCO = 1024 * 1024;
const ABRIR_SEM_SEGUIR = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const ehPromessa = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && ehFuncao(v.then);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

const recusa = (motivo) => Object.freeze({ ok: false, motivo });

/** Erro interno com motivo fixo: nunca carrega mensagem, caminho ou detalhe de dependência. */
class Recusa extends Error {
  constructor(motivo) { super('evidência recusada'); this.motivo = motivo; }
}

function instante(estado) {
  return { dev: estado.dev, ino: estado.ino, size: estado.size, mtimeNs: estado.mtimeNs, ctimeNs: estado.ctimeNs };
}
const mesmoArquivo = (a, b) => a.dev === b.dev && a.ino === b.ino;
const mesmoEstado = (a, b) => mesmoArquivo(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Término observado do processo: só código 0 sem sinal vale; qualquer outra forma (inclusive inválida) é saída ruim. */
function terminoBom(valor) {
  try {
    return ehObjeto(valor) && valor.codigo === 0 && valor.sinal === null;
  } catch {
    return false;
  }
}

function criarObservadorDoDump(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções do observador inválidas');
  const proprias = Reflect.ownKeys(opcoes);
  if (!proprias.every((k) => typeof k === 'string' && (OPERACAO.includes(k) || k === 'operacaoId')) || !OPERACAO.every((k) => proprias.includes(k))) throw new TypeError('opções do observador inválidas');
  let arquivos;
  let lancador;
  let criarExclusivo;
  let lancar;
  let operacaoId;
  try {
    arquivos = opcoes.arquivos;
    lancador = opcoes.lancador;
    operacaoId = proprias.includes('operacaoId') ? opcoes.operacaoId : undefined;
    if (operacaoId !== undefined && !(typeof operacaoId === 'string' && ID_DA_OPERACAO.test(operacaoId))) throw new TypeError('identidade da operação inválida');
    if (!ehObjeto(arquivos) || !ehObjeto(lancador)) throw new TypeError('dependências inválidas');
    criarExclusivo = arquivos.criarExclusivo;
    lancar = lancador.lancar;
  } catch {
    throw new TypeError('opções do observador inválidas');
  }
  if (!ehFuncao(criarExclusivo) || !ehFuncao(lancar)) throw new TypeError('dependências inválidas');

  const visto = {
    criacoes: 0,
    arquivo: null, // { caminho, dev, ino } da criação exclusiva observada
    lancamentos: 0,
    saida: 'PENDENTE', // PENDENTE | BOA | RUIM
    fluxos: 'PENDENTE', // PENDENTE | FECHADOS | REJEITADOS
    base: null, // linha de base ao fechar os fluxos, ou 'INVALIDA'
  };
  let consumo = 'LIVRE'; // LIVRE | EM_ANDAMENTO | CONSUMIDA

  function registrarCriacao(spec, criado) {
    visto.criacoes += 1;
    if (visto.criacoes > 1) { visto.arquivo = null; return; }
    try {
      const diretorio = spec.diretorio;
      const nome = spec.nome;
      const descritor = criado.descritor;
      if (typeof diretorio !== 'string' || typeof nome !== 'string' || !Number.isSafeInteger(descritor) || descritor < 0) return;
      const estado = fs.fstatSync(descritor, { bigint: true });
      if (!estado.isFile()) return;
      visto.arquivo = { caminho: path.join(diretorio, nome), dev: estado.dev, ino: estado.ino };
    } catch {
      visto.arquivo = null;
    }
  }

  function capturarBase() {
    if (visto.arquivo === null) return;
    let fd = null;
    try {
      fd = fs.openSync(visto.arquivo.caminho, ABRIR_SEM_SEGUIR);
      visto.base = instante(fs.fstatSync(fd, { bigint: true }));
    } catch {
      visto.base = 'INVALIDA';
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* descritor próprio já inutilizável */ } }
    }
  }

  function registrarLancamento(processo) {
    visto.lancamentos += 1;
    if (visto.lancamentos > 1) { visto.saida = 'RUIM'; visto.fluxos = 'REJEITADOS'; return; }
    let saida;
    let fluxos;
    try {
      saida = processo.saida;
      fluxos = processo.fluxosFechados;
    } catch {
      visto.lancamentos = 2; // leitura que falha: operação não observável
      return;
    }
    if (!ehPromessa(saida) || !ehPromessa(fluxos)) { visto.lancamentos = 2; return; }
    Promise.resolve(saida).then(
      (valor) => { visto.saida = terminoBom(valor) ? 'BOA' : 'RUIM'; },
      () => { visto.saida = 'RUIM'; },
    );
    Promise.resolve(fluxos).then(
      () => { visto.fluxos = 'FECHADOS'; capturarBase(); },
      () => { visto.fluxos = 'REJEITADOS'; },
    );
  }

  const envolvidoArquivos = Object.freeze({
    async criarExclusivo(spec) {
      const criado = await criarExclusivo.call(arquivos, spec);
      try { registrarCriacao(spec, criado); } catch { /* o registro nunca altera o contrato observado */ }
      return criado;
    },
  });
  const envolvidoLancador = Object.freeze({
    async lancar(spec) {
      const processo = await lancar.call(lancador, spec);
      try { registrarLancamento(processo); } catch { /* idem */ }
      return processo;
    },
  });

  /** Recusas prematuras: dependem só do que já foi observado e NÃO consomem a evidência. */
  function motivoPrematuro() {
    if (visto.criacoes !== 1 || visto.arquivo === null || visto.lancamentos !== 1) return 'NAO_OBSERVADO';
    if (visto.saida === 'PENDENTE') return 'PROCESSO_EM_ANDAMENTO';
    if (visto.saida === 'RUIM') return 'SAIDA_NAO_ZERO';
    if (visto.fluxos !== 'FECHADOS') return 'FLUXOS_ABERTOS';
    return null;
  }

  async function lerFisica() {
    const alvo = visto.arquivo;
    let identificador;
    try {
      identificador = await fsp.open(alvo.caminho, ABRIR_SEM_SEGUIR);
    } catch (falha) {
      throw new Recusa(falha && (falha.code === 'ENOENT' || falha.code === 'ELOOP' || falha.code === 'ENOTDIR') ? 'ARQUIVO_INVALIDO' : 'LEITURA_FALHOU');
    }
    let resultado = null;
    try {
      const antes = await identificador.stat({ bigint: true });
      if (!antes.isFile()) throw new Recusa('ARQUIVO_INVALIDO');
      if (!mesmoArquivo(antes, alvo)) throw new Recusa('IDENTIDADE_DIVERGENTE');
      if (antes.size === 0n) throw new Recusa('ARQUIVO_VAZIO');
      if (visto.base === 'INVALIDA' || visto.base === null) throw new Recusa('ARQUIVO_INVALIDO');
      if (!mesmoEstado(instante(antes), visto.base)) throw new Recusa('ARQUIVO_INSTAVEL');
      if (antes.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Recusa('LEITURA_FALHOU');
      const tamanho = Number(antes.size);

      const hash = crypto.createHash('sha256');
      const bloco = Buffer.allocUnsafe(Math.min(TAMANHO_DO_BLOCO, tamanho));
      let lidos = 0;
      while (lidos < tamanho) {
        const { bytesRead } = await identificador.read(bloco, 0, Math.min(bloco.length, tamanho - lidos), lidos);
        if (bytesRead === 0) break;
        hash.update(bloco.subarray(0, bytesRead));
        lidos += bytesRead;
      }
      if (lidos !== tamanho) throw new Recusa('ARQUIVO_INSTAVEL');
      if ((await identificador.read(Buffer.allocUnsafe(1), 0, 1, lidos)).bytesRead !== 0) throw new Recusa('ARQUIVO_INSTAVEL');
      const depois = await identificador.stat({ bigint: true });
      if (!mesmoEstado(instante(depois), instante(antes))) throw new Recusa('ARQUIVO_INSTAVEL');
      resultado = Object.freeze({ ok: true, bytes: tamanho, sha256Calculado: hash.digest('hex') });
    } finally {
      try { await identificador.close(); } catch { if (resultado !== null) resultado = recusa('LEITURA_FALHOU'); }
    }
    return resultado;
  }

  // A reserva do consumo acontece na parte SÍNCRONA, antes de qualquer await.
  async function evidencia() {
    if (consumo !== 'LIVRE') return recusa('JA_CONSUMIDA');
    const prematuro = motivoPrematuro();
    if (prematuro !== null) return recusa(prematuro);
    consumo = 'EM_ANDAMENTO';
    try {
      return await lerFisica();
    } catch (falha) {
      return recusa(falha instanceof Recusa ? falha.motivo : 'LEITURA_FALHOU');
    } finally {
      consumo = 'CONSUMIDA'; // sucesso ou falha: nunca volta a LIVRE
    }
  }

  // E3' — T1 e T2 (alternativa C): integridade física ENTRE observações. NÃO é declaração independente dos bytes escritos pelo `pg_dump`.
  const numero = (valor) => (valor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(valor) : valor.toString());
  let primeira = null; // T1 aceita: { bytes, sha256, dev, ino }
  const comOperacao = (dados) => (operacaoId === undefined ? dados : { ...dados, operacaoId });
  const recusaDeConferencia = (motivo) => { const r = Object.freeze(comOperacao({ ok: false, motivo })); evidenciasProduzidas.add(r); return r; };

  /** T1: consome a evidência única (a máquina de consumo único não muda) e a enriquece com identidade física e operação. */
  async function observar() {
    const lida = await evidencia();
    if (lida.ok !== true) return lida;
    const alvo = visto.arquivo;
    primeira = { bytes: lida.bytes, sha256: lida.sha256Calculado, dev: alvo.dev, ino: alvo.ino };
    const t1 = Object.freeze(comOperacao({
      ok: true,
      origem: 'OBSERVACAO_FISICA',
      bytes: lida.bytes,
      sha256: lida.sha256Calculado,
      identidade: Object.freeze({ dev: numero(alvo.dev), ino: numero(alvo.ino) }),
    }));
    evidenciasProduzidas.add(t1);
    return t1;
  }

  /** T2: NOVA leitura física do mesmo artefato (nunca devolve o que T1 calculou). Falha fechada com motivos fixos. */
  async function conferir() {
    if (primeira === null) return recusaDeConferencia('SEM_OBSERVACAO');
    const alvo = visto.arquivo;
    let identificador;
    try {
      identificador = await fsp.open(alvo.caminho, ABRIR_SEM_SEGUIR);
    } catch (falha) {
      const codigo = falha && falha.code;
      return recusaDeConferencia(codigo === 'ENOENT' ? 'AUSENTE' : (codigo === 'ELOOP' || codigo === 'ENOTDIR') ? 'SUBSTITUIDO' : 'LEITURA_FALHOU');
    }
    let resultado;
    try {
      const antes = await identificador.stat({ bigint: true });
      if (!antes.isFile() || !mesmoArquivo(antes, alvo)) {
        resultado = recusaDeConferencia('SUBSTITUIDO');
      } else if (antes.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        resultado = recusaDeConferencia('LEITURA_FALHOU');
      } else {
        const tamanho = Number(antes.size);
        const hash = crypto.createHash('sha256');
        const bloco = Buffer.allocUnsafe(Math.max(1, Math.min(TAMANHO_DO_BLOCO, tamanho)));
        let lidos = 0;
        while (lidos < tamanho) {
          const { bytesRead } = await identificador.read(bloco, 0, Math.min(bloco.length, tamanho - lidos), lidos);
          if (bytesRead === 0) break;
          hash.update(bloco.subarray(0, bytesRead));
          lidos += bytesRead;
        }
        const crescimento = lidos === tamanho ? (await identificador.read(Buffer.allocUnsafe(1), 0, 1, lidos)).bytesRead : 0;
        const depois = await identificador.stat({ bigint: true });
        if (lidos !== tamanho || crescimento !== 0 || !mesmoEstado(instante(depois), instante(antes))) {
          resultado = recusaDeConferencia('INSTAVEL');
        } else {
          const sha256 = hash.digest('hex');
          if (tamanho !== primeira.bytes || sha256 !== primeira.sha256) {
            resultado = recusaDeConferencia('DIVERGENTE');
          } else {
            resultado = Object.freeze(comOperacao({ ok: true, bytes: tamanho, sha256, identidade: Object.freeze({ dev: numero(alvo.dev), ino: numero(alvo.ino) }) }));
            evidenciasProduzidas.add(resultado);
          }
        }
      }
    } catch {
      resultado = recusaDeConferencia('LEITURA_FALHOU');
    } finally {
      try { await identificador.close(); } catch { /* descritor próprio já inutilizável */ }
    }
    return resultado;
  }

  /**
   * Marco C: abre o MESMO artefato identificado por T1 (por caminho, sem seguir link) e só entrega o descritor se `dev/ino` forem os de T1 e o arquivo for regular. O chamador recebe um descritor de LEITURA
   * (o caminho nunca sai deste módulo) e é responsável por fechá-lo (`fechar()`, idempotente). Usado pelo verificador estrutural (stdin do `pg_restore --list`) e pela incorporação do dump ao pacote.
   */
  function abrirArtefato() {
    if (primeira === null) return recusa('SEM_OBSERVACAO');
    const alvo = visto.arquivo;
    let fd = null;
    try {
      fd = fs.openSync(alvo.caminho, ABRIR_SEM_SEGUIR);
      const estado = fs.fstatSync(fd, { bigint: true });
      if (!estado.isFile() || !mesmoArquivo(estado, alvo)) { fs.closeSync(fd); return recusa('SUBSTITUIDO'); }
    } catch (falha) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
      return recusa(falha && falha.code === 'ENOENT' ? 'AUSENTE' : 'LEITURA_FALHOU');
    }
    let aberto = true;
    const descritor = fd;
    return Object.freeze({
      ok: true,
      descritor,
      identidade: Object.freeze({ dev: numero(alvo.dev), ino: numero(alvo.ino) }),
      bytes: primeira.bytes,
      sha256: primeira.sha256,
      fechar() { if (aberto) { aberto = false; try { fs.closeSync(descritor); } catch { /* já fechado */ } } },
    });
  }

  const observador = Object.freeze({ arquivos: envolvidoArquivos, lancador: envolvidoLancador, evidencia, observar, conferir, abrirArtefato });
  observadoresProduzidos.add(observador);
  return observador;
}

/** O objeto foi produzido por `criarObservadorDoDump` neste processo (origem, não autorização). */
const ehObservadorDoDump = (valor) => valor !== null && typeof valor === 'object' && observadoresProduzidos.has(valor);
/** A evidência (T1/T2) foi produzida por um observador deste módulo. */
const ehEvidenciaFisica = (valor) => valor !== null && typeof valor === 'object' && evidenciasProduzidas.has(valor);

module.exports = { criarObservadorDoDump, ehObservadorDoDump, ehEvidenciaFisica, ID_DA_OPERACAO };
