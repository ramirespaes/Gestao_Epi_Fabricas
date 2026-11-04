'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, P5): DIAGNÓSTICO SANITIZADO do stderr do `pg_dump`. Função pura, em memória, sem disco, rede, ambiente, relógio ou log.
 *
 * O texto NUNCA é guardado nem devolvido: cada linha é classificada contra uma TABELA FECHADA de padrões e descartada. A saída só tem códigos de um enum fixo, contadores limitados e um indicador de truncamento — nenhum trecho do texto, nenhum
 * caminho, host, usuário, senha, comando ou SQL. Limites: linha classificada só pelos primeiros 512 bytes; no máximo 64 KiB de stderr são CLASSIFICADOS (o excedente é só contado e marca `truncado`); no máximo 8 códigos distintos; cada contador
 * satura em 999 (linhas em 99999). `consumir` e `resultado` NUNCA lançam. O diagnóstico é INFORMATIVO: nenhuma decisão de segurança (término, grupo, liberação da trava) depende dele.
 */

const LIMITE_LINHA = 512;
const LIMITE_CLASSIFICADO = 64 * 1024;
const MAX_CODIGOS = 8;
const SATURACAO_CODIGO = 999;
const SATURACAO_LINHAS = 99999;

/** Enum fechado + padrões (sem distinção de caixa). A ordem importa: o primeiro padrão que casa vence. */
const TABELA = Object.freeze([
  ['ESPACO_ESGOTADO', /no space left on device|disk quota exceeded/],
  ['AUTENTICACAO_FALHOU', /password authentication failed|no password supplied|authentication failed|fe_sendauth|scram|peer authentication/],
  ['PERMISSAO_NEGADA', /permission denied|must be (?:owner|superuser)/],
  ['VERSAO_INCOMPATIVEL', /server version mismatch|aborting because of server version|unsupported version/],
  ['SNAPSHOT_INVALIDO', /invalid snapshot|snapshot .*(?:not|invalid)|could not import the requested snapshot/],
  ['BANCO_INEXISTENTE', /database ".*" does not exist|database does not exist/],
  ['CONEXAO_RECUSADA', /connection refused|could not connect|could not translate host name|connection to server|timeout expired|no route to host|name or service not known/],
  ['INTERROMPIDO', /terminating connection|canceling statement|server closed the connection unexpectedly|interrupted|terminated by signal/],
  ['ERRO_GENERICO', /^pg_dump: (?:error|erro):/],
]);
const CODIGOS = Object.freeze(TABELA.map(([codigo]) => codigo));

function criarDiagnosticoDoStderr() {
  let bytes = 0;
  let linhas = 0;
  let classificados = 0;
  let truncado = false;
  let naoClassificadas = 0;
  let restoDeLinha = ''; // no máximo LIMITE_LINHA caracteres da linha em curso
  let linhaEmCurso = false;
  const contagem = new Map();

  function fecharLinha() {
    if (!linhaEmCurso) return;
    linhaEmCurso = false;
    if (linhas < SATURACAO_LINHAS) linhas += 1;
    const texto = restoDeLinha.toLowerCase();
    restoDeLinha = '';
    for (const [codigo, padrao] of TABELA) {
      if (padrao.test(texto)) {
        if (contagem.has(codigo)) contagem.set(codigo, Math.min(SATURACAO_CODIGO, contagem.get(codigo) + 1));
        else if (contagem.size < MAX_CODIGOS) contagem.set(codigo, 1);
        else truncado = true;
        return;
      }
    }
    if (naoClassificadas < SATURACAO_CODIGO) naoClassificadas += 1;
  }

  function consumir(bloco) {
    try {
      if (!Buffer.isBuffer(bloco)) return;
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + bloco.length);
      const disponivel = Math.max(0, LIMITE_CLASSIFICADO - classificados);
      const parte = bloco.length > disponivel ? bloco.subarray(0, disponivel) : bloco;
      if (bloco.length > disponivel) truncado = true;
      classificados += parte.length;
      for (const byte of parte) {
        if (byte === 0x0a) { fecharLinha(); continue; }
        linhaEmCurso = true;
        if (restoDeLinha.length < LIMITE_LINHA) restoDeLinha += String.fromCharCode(byte);
        else truncado = true;
      }
    } catch { /* o diagnóstico nunca interfere na captura */ }
  }

  function resultado() {
    try {
      fecharLinha(); // a linha final sem quebra também conta (no-op se não há linha em curso)
      return Object.freeze({
        codigos: Object.freeze([...contagem.entries()].map(([codigo, ocorrencias]) => Object.freeze({ codigo, ocorrencias })).sort((a, b) => (a.codigo < b.codigo ? -1 : 1))),
        linhas,
        bytes,
        truncado,
        naoClassificadas,
      });
    } catch {
      return Object.freeze({ codigos: Object.freeze([]), linhas: 0, bytes: 0, truncado: true, naoClassificadas: 0 });
    }
  }

  return Object.freeze({ consumir, resultado });
}

module.exports = { criarDiagnosticoDoStderr, CODIGOS_DO_STDERR: CODIGOS };
