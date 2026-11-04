'use strict';

const { supervisionar } = require('./imagem-backup-supervisor.service');
const { hostAutorizavel, socketFisicoSeguro } = require('./imagem-backup-host-postgres');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MARCO D): RESTAURAÇÃO DO BANCO por EXECUTOR INJETADO e SUPERVISIONADO. Contrato PROVISÓRIO. Este módulo NÃO executa `pg_restore`, não conecta a PostgreSQL e não tem lançador
 * real: o processo só nasce no `lancador` INJETADO (nos testes, controlado). Nada aqui prova restauração operacional real nem recuperabilidade: o resultado leva SEMPRE `restauracaoReal: false`.
 *
 * `criarRestauradorDoBanco({ alvo: { executavel }, lancador, sistema, temporizador, prazos, politicaDeDestino: { prefixoDoBanco, hostsAutorizados, bancosProtegidos } })` (ESTRITO; TypeError genérico) -> `{ restaurar({ destino, dump }) }`.
 *  - POLÍTICA DE DESTINO (antes de qualquer lançamento): o banco precisa começar pelo prefixo exigido (ex.: `gestao_epi_restauracao_`), ter só `[a-z0-9_]`, NÃO constar em `bancosProtegidos`, e o host precisa constar em `hostsAutorizados`
 *    (lista vazia = nenhum destino é aceito). Um banco de produção nunca é destino de restauração de teste. Recusa: { ok:false, motivo:'DESTINO_NAO_AUTORIZADO' }, sem lançar nada.
 *  - `destino` = { banco, host, porta, usuario, arquivoDeSenha } (estrito); `dump` = o descritor de LEITURA já conferido pelo orquestrador ({ descritor, bytes, sha256 }); o dump chega ao processo como ENTRADA PADRÃO, nunca por caminho.
 *  - Spec lançado: `pg_restore --exit-on-error --no-owner --no-privileges --single-transaction --dbname=<banco>`, ambiente exatamente PGPASSFILE/PGHOST/PGPORT/PGUSER, `{ shell:false, detached:true, stdio:[descritor,'ignore','ignore'] }`.
 *  - SUPERVISÃO pelo `supervisionar` aprovado (término confirmado, fluxos fechados, grupo vazio, prazos, sinais). Só código 0, sem sinal e sem encerramento forçado é ok. Falha fechada com motivos fixos: NAO_INICIADA, SAIDA_NAO_ZERO, SINAL,
 *    ENCERRAMENTO_FORCADO, ESTADO_INCERTO. Nada é apagado: um banco temporário parcialmente restaurado fica como está (a propriedade e a limpeza são decisão humana).
 *
 * LIMITES: sem execução real, sem conferência lógica das tabelas restauradas (consistência PostgreSQL x imagens NÃO é verificada aqui), sem lançador real de `pg_restore` (o lançador estrutural só aceita `--list`).
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const BANCO = /^[a-z][a-z0-9_]{0,62}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const SINAIS_PERMITIDOS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);
const CHAVES_DOS_PRAZOS = ['totalMs', 'cortesiaMs', 'intervaloGrupoMs', 'tentativasGrupo', 'consultaGrupoMs'];
const SHA256 = /^[0-9a-f]{64}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const ehPromessa = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && ehFuncao(v.then);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const invalido = () => new TypeError('restaurador do banco inválido');
const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const resultadoBase = (dados) => Object.freeze({ restauracaoReal: false, origem: 'EXECUTOR_INJETADO', ...dados });
const EXECUCAO_ID = /^[0-9a-f]{32}$/;

function criarRestauradorDoBanco(opcoes) {
  let executavel;
  let lancador;
  let sistema;
  let temporizador;
  const prazos = {};
  let prefixo;
  let hostsAutorizados;
  let bancosProtegidos;
  let execucaoId = null; // identidade da EXECUÇÃO de restauração (opcional): gerada pela composição, ecoada em todo resultado
  try {
    const base = ['alvo', 'lancador', 'sistema', 'temporizador', 'prazos', 'politicaDeDestino'];
    const proprias = ehObjeto(opcoes) ? Reflect.ownKeys(opcoes) : [];
    if (!ehObjeto(opcoes) || !proprias.every((k) => typeof k === 'string' && [...base, 'execucaoId'].includes(k)) || !base.every((k) => proprias.includes(k))) throw invalido();
    if (proprias.includes('execucaoId')) {
      if (typeof opcoes.execucaoId !== 'string' || !EXECUCAO_ID.test(opcoes.execucaoId)) throw invalido();
      execucaoId = opcoes.execucaoId;
    }
    const { alvo, politicaDeDestino } = opcoes;
    lancador = opcoes.lancador;
    sistema = opcoes.sistema;
    temporizador = opcoes.temporizador;
    if (!ehObjeto(alvo) || !chavesExatas(alvo, ['executavel']) || !caminhoAbsolutoCanonico(alvo.executavel) || !alvo.executavel.endsWith('/pg_restore')) throw invalido();
    executavel = alvo.executavel;
    if (!ehObjeto(lancador) || !ehFuncao(lancador.lancar)) throw invalido();
    if (!ehObjeto(sistema) || !ehFuncao(sistema.grupoVivo) || !ehFuncao(sistema.enviarSinal)) throw invalido();
    if (!ehObjeto(temporizador) || !ehFuncao(temporizador.prazo) || !ehFuncao(temporizador.intervalo)) throw invalido();
    if (!ehObjeto(opcoes.prazos)) throw invalido();
    for (const chave of CHAVES_DOS_PRAZOS) {
      if (!inteiroPositivo(opcoes.prazos[chave])) throw invalido();
      prazos[chave] = opcoes.prazos[chave];
    }
    if (!ehObjeto(politicaDeDestino) || !chavesExatas(politicaDeDestino, ['prefixoDoBanco', 'hostsAutorizados', 'bancosProtegidos'])) throw invalido();
    prefixo = politicaDeDestino.prefixoDoBanco;
    if (typeof prefixo !== 'string' || !/^[a-z][a-z0-9_]{5,40}_$/.test(prefixo)) throw invalido();
    hostsAutorizados = politicaDeDestino.hostsAutorizados;
    bancosProtegidos = politicaDeDestino.bancosProtegidos;
    if (!Array.isArray(hostsAutorizados) || !hostsAutorizados.every((h) => hostAutorizavel(h))) throw invalido();
    if (!Array.isArray(bancosProtegidos) || !bancosProtegidos.every((b) => typeof b === 'string' && b !== '')) throw invalido();
  } catch {
    throw invalido();
  }
  Object.freeze(prazos);
  const resultado = (dados) => resultadoBase({ ...dados, execucaoId });
  const hostsPermitidos = new Set(hostsAutorizados);
  const protegidos = new Set(bancosProtegidos.map((b) => b.toLowerCase()));
  const lancar = lancador.lancar;
  const grupoVivo = sistema.grupoVivo;
  const enviarSinal = sistema.enviarSinal;
  const prazoDoTemporizador = temporizador.prazo;
  const intervaloDoTemporizador = temporizador.intervalo;

  function destinoAutorizado(destino) {
    try {
      if (!ehObjeto(destino) || !chavesExatas(destino, ['banco', 'host', 'porta', 'usuario', 'arquivoDeSenha'])) return null;
      const { banco, host, porta, usuario, arquivoDeSenha } = destino;
      if (typeof banco !== 'string' || !BANCO.test(banco) || !banco.startsWith(prefixo) || banco.length === prefixo.length || protegidos.has(banco.toLowerCase())) return null;
      if (!Number.isSafeInteger(porta) || porta < 1 || porta > 65535) return null;
      // correspondência EXATA com a lista; para socket Unix, também o caminho completo no limite e o diretório físico seguro (nenhum fallback)
      if (typeof host !== 'string' || !hostsPermitidos.has(host) || !socketFisicoSeguro(host, porta)) return null;
      if (typeof usuario !== 'string' || !USUARIO.test(usuario) || !caminhoAbsolutoCanonico(arquivoDeSenha)) return null;
      return { banco, host, porta, usuario, arquivoDeSenha };
    } catch {
      return null;
    }
  }

  async function restaurar(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['destino', 'dump'])) throw invalido();
    const destino = destinoAutorizado(entrada.destino);
    if (destino === null) return resultado({ ok: false, motivo: 'DESTINO_NAO_AUTORIZADO' });
    const { dump } = entrada;
    if (!ehObjeto(dump) || !Number.isSafeInteger(dump.descritor) || dump.descritor < 3 || !inteiroPositivo(dump.bytes) || typeof dump.sha256 !== 'string' || !SHA256.test(dump.sha256)) return resultado({ ok: false, motivo: 'DUMP_INDISPONIVEL' });

    let pgid = null;
    let supervisao = null;
    try {
      const iniciar = async () => {
        const spec = Object.freeze({
          executavel,
          argumentos: Object.freeze(['--exit-on-error', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${destino.banco}`]),
          ambiente: Object.freeze({ PGPASSFILE: destino.arquivoDeSenha, PGHOST: destino.host, PGPORT: String(destino.porta), PGUSER: destino.usuario }),
          opcoes: Object.freeze({ shell: false, detached: true, stdio: Object.freeze([dump.descritor, 'ignore', 'ignore']) }),
        });
        let processo;
        try { processo = await lancar.call(lancador, spec); } catch { throw new Error('falha na restauração'); }
        let pid;
        let saida;
        let fluxos;
        try { if (ehObjeto(processo)) { pid = processo.pid; saida = processo.saida; fluxos = processo.fluxosFechados; } } catch { pid = undefined; }
        if (!(Number.isSafeInteger(pid) && pid > 1 && ehPromessa(saida) && ehPromessa(fluxos))) throw new Error('falha na restauração');
        pgid = pid;
        return { pgid, saida, fluxosFechados: Promise.resolve(fluxos) };
      };
      const grupo = Object.freeze({
        async vivos(consultado) {
          if (pgid === null || consultado !== pgid) throw new Error('grupo desconhecido');
          const resposta = await grupoVivo.call(sistema, pgid);
          if (resposta !== true && resposta !== false) throw new Error('resposta de grupo inválida');
          return resposta;
        },
      });
      const sinais = Object.freeze({
        async enviar(alvoDoSinal, sinal) {
          if (pgid === null || alvoDoSinal !== pgid || typeof sinal !== 'string' || !SINAIS_PERMITIDOS.has(sinal)) return false;
          try { return (await enviarSinal.call(sistema, pgid, sinal)) === true; } catch { return false; }
        },
      });
      supervisao = await supervisionar({
        iniciar,
        grupo,
        sinais,
        temporizador: Object.freeze({ prazo: (...a) => prazoDoTemporizador.apply(temporizador, a), intervalo: (...a) => intervaloDoTemporizador.apply(temporizador, a) }),
        prazos,
      });
    } catch {
      supervisao = null;
    }

    if (supervisao === null) return resultado({ ok: false, motivo: 'ESTADO_INCERTO' });
    if (supervisao.concluido === true && supervisao.liberarTravaPermitido === true && supervisao.encerramentoForcado !== true && supervisao.codigoDoProcesso === 0 && supervisao.sinalDoProcesso === null) {
      return resultado({ ok: true, banco: destino.banco, codigoDoProcesso: 0, pgid });
    }
    if (supervisao.saida === 1) return resultado({ ok: false, motivo: 'NAO_INICIADA' });
    if (supervisao.encerramentoForcado === true) return resultado({ ok: false, motivo: 'ENCERRAMENTO_FORCADO' });
    if (supervisao.sinalDoProcesso !== null && supervisao.sinalDoProcesso !== undefined) return resultado({ ok: false, motivo: 'SINAL' });
    if (supervisao.saida === 9) return resultado({ ok: false, motivo: 'SAIDA_NAO_ZERO' });
    return resultado({ ok: false, motivo: 'ESTADO_INCERTO' });
  }

  /** A política de destino sozinha (sem lançar nada): o orquestrador a consulta ANTES de restaurar qualquer coisa. */
  const autorizarDestino = (destino) => destinoAutorizado(destino) !== null;

  return Object.freeze({ restaurar, autorizarDestino });
}

module.exports = { criarRestauradorDoBanco };
