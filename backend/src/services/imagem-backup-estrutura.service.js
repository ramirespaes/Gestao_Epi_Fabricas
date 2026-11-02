'use strict';

const { supervisionar } = require('./imagem-backup-supervisor.service');
const { ehObservadorDoDump, ID_DA_OPERACAO } = require('./imagem-backup-evidencia-dump.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MARCO C, CONS-03): VERIFICAÇÃO ESTRUTURAL LIMITADA e SUPERVISIONADA do dump. Contrato PROVISÓRIO; nada aqui executa `pg_restore`: o processo é lançado
 * por um `lancador` INJETADO (nos testes, simulado) e a supervisão é a do `supervisionar` aprovado.
 *
 * `criarVerificadorEstrutural({ alvo: { executavel }, lancador, sistema, temporizador, prazos })` (ESTRITO; TypeError genérico) -> objeto congelado RECONHECIDO (WeakSet) com `verificar({ operacaoId, observador })`.
 * `observador` precisa ser o observador do dump PRODUZIDO por `criarObservadorDoDump` (a cadeia o fornece): o verificador abre o MESMO artefato identificado por T1 (`abrirArtefato`, que confere `dev/ino` e que o
 * arquivo é regular) e o entrega ao processo como ENTRADA PADRÃO (`pg_restore --list` sem arquivo, `stdio: [descritor, 'pipe', 'ignore']`; o stdout é capturado de forma RESTRITA pelo lançador e dele só o formato CUSTOM e a contagem de entradas do sumário são exigidos): o caminho nunca é passado ao processo e o artefato lido é, por
 * construção, o observado. O processo é supervisionado (término confirmado, fluxos fechados, grupo vazio, prazos, sinais).
 *
 * Resultado `verificar` (congelado e RECONHECIDO por `ehEvidenciaEstrutural`, motivos fixos, sem caminho nem texto do processo):
 *   { ok, concluida: true, origem: 'PG_RESTORE_LIST_SUPERVISIONADO', escopo: 'LISTAGEM_DO_SUMARIO', operacaoId, identidade, bytes, sha256, motivo? }.
 *   `ok` exige: artefato aberto com a identidade de T1, supervisão CONCLUÍDA (saída 0), código do processo 0, sem sinal, sem encerramento forçado e liberação permitida. Qualquer outra coisa é falha fechada com
 *   motivo ARTEFATO_*, NAO_INICIADA, SAIDA_NAO_ZERO, SINAL, ENCERRAMENTO_FORCADO ou ESTADO_INCERTO.
 * `ESTRUTURA_NAO_EXECUTADA`: a evidência reconhecida de quando nenhum verificador foi configurado ({ ok:false, concluida:false, origem:'NAO_EXECUTADA' }).
 *
 * LIMITES: a listagem do sumário (`--list`) lê o índice do arquivo no formato custom; NÃO comprova restauração bem-sucedida, integridade do conteúdo das tabelas nem compatibilidade de versão. O lançador REAL
 * ainda não existe (o do `pg_dump` é restrito à sua própria lista de argumentos): este módulo define o contrato, e a execução real de `pg_restore` está fora desta atividade. A marca (WeakSet) prova a origem em
 * processo, não autorização operacional.
 */

const verificadoresProduzidos = new WeakSet();
const evidenciasProduzidas = new WeakSet();
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const SINAIS_PERMITIDOS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);
const CHAVES_DOS_PRAZOS = ['totalMs', 'cortesiaMs', 'intervaloGrupoMs', 'tentativasGrupo', 'consultaGrupoMs'];
const ORIGEM = 'PG_RESTORE_LIST_SUPERVISIONADO';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const ehPromessa = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && ehFuncao(v.then);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const invalido = () => new TypeError('verificador estrutural inválido');

function caminhoAbsolutoCanonico(valor) {
  if (typeof valor !== 'string' || valor.length < 2 || valor.length > 4096 || valor[0] !== '/') return false;
  return valor.slice(1).split('/').every((parte) => SEGMENTO.test(parte) && parte !== '.' && parte !== '..');
}

function evidencia(dados) {
  const e = Object.freeze(dados);
  evidenciasProduzidas.add(e);
  return e;
}

const ESTRUTURA_NAO_EXECUTADA = evidencia({ ok: false, concluida: false, origem: 'NAO_EXECUTADA' });

function criarVerificadorEstrutural(opcoes) {
  let executavel;
  let lancar;
  let grupoVivo;
  let enviarSinal;
  let prazoDoTemporizador;
  let intervaloDoTemporizador;
  let temporizador;
  let lancador;
  let sistema;
  const prazos = {};
  try {
    if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['alvo', 'lancador', 'sistema', 'temporizador', 'prazos'])) throw invalido();
    const { alvo } = opcoes;
    lancador = opcoes.lancador;
    sistema = opcoes.sistema;
    temporizador = opcoes.temporizador;
    if (!ehObjeto(alvo) || !chavesExatas(alvo, ['executavel']) || !caminhoAbsolutoCanonico(alvo.executavel)) throw invalido();
    executavel = alvo.executavel;
    if (!ehObjeto(lancador) || !ehFuncao(lancador.lancar)) throw invalido();
    lancar = lancador.lancar;
    if (!ehObjeto(sistema) || !ehFuncao(sistema.grupoVivo) || !ehFuncao(sistema.enviarSinal)) throw invalido();
    grupoVivo = sistema.grupoVivo;
    enviarSinal = sistema.enviarSinal;
    if (!ehObjeto(temporizador) || !ehFuncao(temporizador.prazo) || !ehFuncao(temporizador.intervalo)) throw invalido();
    prazoDoTemporizador = temporizador.prazo;
    intervaloDoTemporizador = temporizador.intervalo;
    if (!ehObjeto(opcoes.prazos)) throw invalido();
    for (const chave of CHAVES_DOS_PRAZOS) {
      if (!inteiroPositivo(opcoes.prazos[chave])) throw invalido();
      prazos[chave] = opcoes.prazos[chave];
    }
  } catch {
    throw invalido();
  }
  Object.freeze(prazos);

  const falha = (base, motivo) => evidencia({ ...base, ok: false, concluida: true, origem: ORIGEM, escopo: 'LISTAGEM_DO_SUMARIO', motivo });

  async function verificar(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['operacaoId', 'observador'])) throw invalido();
    const { operacaoId, observador } = entrada;
    if (typeof operacaoId !== 'string' || !ID_DA_OPERACAO.test(operacaoId) || !ehObservadorDoDump(observador)) throw invalido();

    const artefato = observador.abrirArtefato();
    if (artefato.ok !== true) return falha({ operacaoId }, `ARTEFATO_${artefato.motivo}`);
    const base = { operacaoId, identidade: artefato.identidade, bytes: artefato.bytes, sha256: artefato.sha256 };

    let pgid = null;
    let supervisao = null;
    let resultadoDoProcesso = null; // promessa do sumário restrito (formato e contagem), entregue pelo lançador
    try {
      const iniciar = async () => {
        const spec = Object.freeze({
          executavel,
          argumentos: Object.freeze(['--list']),
          ambiente: Object.freeze({}),
          opcoes: Object.freeze({ shell: false, detached: true, stdio: Object.freeze([artefato.descritor, 'pipe', 'ignore']) }),
        });
        let processo;
        try {
          processo = await lancar.call(lancador, spec);
        } catch {
          artefato.fechar();
          throw new Error('falha na verificação estrutural');
        }
        let pid;
        let saida;
        let fluxos;
        try {
          if (ehObjeto(processo)) { pid = processo.pid; saida = processo.saida; fluxos = processo.fluxosFechados; }
        } catch {
          pid = undefined;
        }
        if (!(Number.isSafeInteger(pid) && pid > 1 && ehPromessa(saida) && ehPromessa(fluxos))) {
          artefato.fechar();
          throw new Error('falha na verificação estrutural');
        }
        pgid = pid;
        resultadoDoProcesso = processo.resultado;
        const fluxosFechados = Promise.resolve(fluxos).then(
          () => { artefato.fechar(); },
          () => { artefato.fechar(); throw new Error('falha na verificação estrutural'); },
        );
        return { pgid, saida, fluxosFechados };
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
        temporizador: Object.freeze({
          prazo: (...a) => prazoDoTemporizador.apply(temporizador, a),
          intervalo: (...a) => intervaloDoTemporizador.apply(temporizador, a),
        }),
        prazos,
      });
    } catch {
      supervisao = null;
    } finally {
      artefato.fechar();
    }

    if (supervisao === null) return falha(base, 'ESTADO_INCERTO');
    if (supervisao.concluido === true && supervisao.liberarTravaPermitido === true && supervisao.encerramentoForcado !== true && supervisao.codigoDoProcesso === 0 && supervisao.sinalDoProcesso === null) {
      // Saída 0 sozinha não basta: o sumário restrito capturado precisa reconhecer o formato CUSTOM e ao menos uma entrada. Ausência do sumário = falha fechada.
      let sumario = null;
      try { sumario = ehPromessa(resultadoDoProcesso) ? await resultadoDoProcesso : null; } catch { sumario = null; }
      if (!ehObjeto(sumario) || sumario.formato !== 'CUSTOM' || !Number.isSafeInteger(sumario.entradas) || sumario.entradas < 1) return falha(base, 'SUMARIO_INVALIDO');
      return evidencia({ ...base, ok: true, concluida: true, origem: ORIGEM, escopo: 'LISTAGEM_DO_SUMARIO', formato: 'CUSTOM', entradas: sumario.entradas });
    }
    if (supervisao.saida === 1) return falha(base, 'NAO_INICIADA');
    if (supervisao.encerramentoForcado === true) return falha(base, 'ENCERRAMENTO_FORCADO');
    if (supervisao.sinalDoProcesso !== null && supervisao.sinalDoProcesso !== undefined) return falha(base, 'SINAL');
    if (supervisao.saida === 9) return falha(base, 'SAIDA_NAO_ZERO');
    return falha(base, 'ESTADO_INCERTO');
  }

  const verificador = Object.freeze({ verificar });
  verificadoresProduzidos.add(verificador);
  return verificador;
}

const ehVerificadorEstrutural = (v) => v !== null && typeof v === 'object' && verificadoresProduzidos.has(v);
const ehEvidenciaEstrutural = (v) => v !== null && typeof v === 'object' && evidenciasProduzidas.has(v);

module.exports = { criarVerificadorEstrutural, ehVerificadorEstrutural, ehEvidenciaEstrutural, ESTRUTURA_NAO_EXECUTADA, ORIGEM_ESTRUTURAL: ORIGEM };
