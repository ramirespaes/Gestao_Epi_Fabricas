'use strict';

const { ehResultadoDeRestauracao } = require('./imagem-backup-restauracao.service');
const { ehSituacaoDoControle } = require('./imagem-backup-pgdump-controle-processo.service');
const { ehResultadoDeConsulta, ehEvidenciaDeInstancia } = require('./imagem-backup-consistencia-banco.service');
const { ehAutenticacaoReconhecida } = require('./imagem-backup-manifesto-autenticado.service');
const { REGISTRO_DE_EXECUCOES } = require('./imagem-backup-execucoes.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): PROVENIÊNCIA DA RESTAURAÇÃO REAL. Avalia, item a item, se uma restauração pode ser RECONHECIDA como real, a partir SÓ de evidências nascidas dos componentes confiáveis (marcas internas, não objetos literais, clones
 * nem afirmações do chamador): o resultado do restaurador, a situação do controle de processo, as sondas de instância (antes e depois) e a consulta de referências. Nenhum campo booleano fornecido de fora (`restauracaoReal`, `verificada`, `recuperavel`) é lido como prova.
 *
 * `avaliarRestauracaoReal({ restauracao, processo, instanciaAntes, instanciaDepois, consulta, destino })` -> `{ reconhecida, itens, pendencias }` congelado e RECONHECIDO (`ehAvaliacaoReconhecida`). `destino` é o destino AUTORIZADO pela configuração ({ banco, host }), nunca uma evidência.
 * Itens (todos exigidos): SPAWN_GENUINO (a função `spawn` é a do Node: um executor simulado nunca é), CLIENTE_GENUINO (os clientes de banco são o `Client` do driver `pg`: um cliente simulado nunca é), INSTANCIA_FISICA (versão 16, diretório de dados, socket correspondente ao destino
 * quando o destino é socket, `listen_addresses` vazio, sem endereço TCP; antes da restauração), DESTINO_IDENTIFICADO (o banco restaurado, o da sonda posterior e o da consulta são o destino autorizado), DUMP_AUTENTICADO (manifesto V2 autenticado por evidência reconhecida),
 * DUMP_CONFERIDO_ANTES (integridade física do arquivo imediatamente antes), PG_RESTORE_PELO_LANCADOR (processo iniciado pelo controle, e o do resultado do banco), RESULTADO_TERMINAL (término com código 0), SEM_PROCESSO_SOBREVIVENTE (fluxos fechados e grupo observado vazio),
 * IDENTIDADE_DO_BANCO_RESTAURADO (sonda posterior na MESMA instância), CONSULTAS_REAIS (consulta completa, de cliente genuíno), IMAGENS_INTEGRAS, REFERENCIAS_x_ARQUIVOS (consistência contratual satisfeita) e CORRELACAO (pacote, manifesto, conjunto, banco e processo são da mesma operação).
 * `reconhecida` só com todos. O avaliador PADRÃO (o único reconhecido) usa as identidades reais do Node e do `pg`; `criarAvaliadorDeRestauracaoReal` existe para testar a LÓGICA com predicados injetados, e o que ele produz NUNCA é reconhecido pelo código de produção.
 * LIMITES: um cliente que herda de `pg.Client` e responde de forma falsa não é detectável por código; a evidência é de proveniência de CÓDIGO, não atestação criptográfica externa. Nada aqui declara recuperabilidade em produção.
 */

const ITENS = Object.freeze(['SPAWN_GENUINO', 'CLIENTE_GENUINO', 'INSTANCIA_FISICA', 'DESTINO_IDENTIFICADO', 'DUMP_AUTENTICADO', 'DUMP_CONFERIDO_ANTES', 'PG_RESTORE_PELO_LANCADOR', 'RESULTADO_TERMINAL', 'SEM_PROCESSO_SOBREVIVENTE', 'IDENTIDADE_DO_BANCO_RESTAURADO', 'CONSULTAS_REAIS', 'IMAGENS_INTEGRAS', 'REFERENCIAS_X_ARQUIVOS', 'CORRELACAO']);
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reconhecidas = new WeakSet();

/**
 * IDENTIDADE DA EXECUÇÃO DE RESTAURAÇÃO: cada `restaurar()` da composição EMITE, pelo REGISTRO DE EXECUÇÕES (`imagem-backup-execucoes.service`, limitado, com política explícita), um identificador novo (128 bits aleatórios, gerado ANTES do lançamento, nunca escolhido pelo chamador) e o leva ao
 * controle de processo supervisionado, ao restaurador do banco (todo resultado), ao restaurador (resultado e consulta) e à consulta/sondas. O item CORRELACAO exige que TODAS as evidências RECONHECIDAS (cada uma emitida pelo seu componente) tragam o MESMO identificador, que ele esteja no registro como
 * ATIVA e que a execução nunca tenha sido concluída: a PRIMEIRA avaliação de produção conclui a execução (guardando a avaliação IMUTÁVEL) e qualquer reapresentação, por esta ou por outra instância do avaliador de produção, devolve resultado NÃO reconhecido; o resultado original continua consultável sem reexecutar
 * (`consultarAvaliacaoDaExecucao`). Identidade expirada, desconhecida (inclusive removida pela retenção), ausente ou nula nunca satisfaz o item. A igualdade textual não basta: evidência literal ou clonada nem é reconhecida. O PID do `pg_restore` continua exigido, mas nunca sozinho; não se confunde com o PID do servidor
 * PostgreSQL (não coletado) nem com o identificador da operação de BACKUP (`conjuntoId`/manifesto). Expirar ou remover uma identidade não libera janela, processo ou posse alguma: o registro não conhece nada disso.
 */
const emitirExecucaoDeRestauracao = () => REGISTRO_DE_EXECUCOES.emitir();
const consultarAvaliacaoDaExecucao = (id) => REGISTRO_DE_EXECUCOES.resultado(id);

const avaliacaoDeFalha = () => Object.freeze({
  reconhecida: false,
  itens: Object.freeze(Object.fromEntries(ITENS.map((k) => [k, false]))),
  pendencias: ITENS,
  correlacao: Object.freeze({ pidConfere: false, execucaoConfere: false, execucaoEmitida: false, execucaoNaoReutilizada: false, estadoDaExecucao: null }),
  falhaNaAvaliacao: true,
  atestaRecuperabilidadeEmProducao: false,
});

/** `comprometer`: modo de PRODUÇÃO (a execução precisa estar ATIVA e a primeira avaliação a CONCLUI no `registro`); sem ele (avaliador de teste) a execução só precisa estar registrada e viva, e nada é gravado. */
function criarAvaliadorInterno({ ehSpawnGenuino, ehClienteGenuino }, { registro, comprometer }) {
  if (typeof ehSpawnGenuino !== 'function' || typeof ehClienteGenuino !== 'function') throw new TypeError('avaliador inválido');

  function computar(entradas, ctx) {
    const e = ehObjeto(entradas) ? entradas : {};
    const r = ehResultadoDeRestauracao(e.restauracao) ? e.restauracao : null;
    const proc = ehSituacaoDoControle(e.processo) ? e.processo : null;
    const antes = ehEvidenciaDeInstancia(e.instanciaAntes) && e.instanciaAntes.ok === true ? e.instanciaAntes : null;
    const depois = ehEvidenciaDeInstancia(e.instanciaDepois) && e.instanciaDepois.ok === true ? e.instanciaDepois : null;
    const consulta = ehResultadoDeConsulta(e.consulta) && e.consulta.ok === true && e.consulta.completa === true ? e.consulta : null;
    const etapas = r !== null ? r.etapas : {};
    const banco = ehObjeto(etapas.banco) ? etapas.banco : {};
    // identidade da execução: a mesma em TODAS as evidências reconhecidas, registrada e viva
    const execucaoId = proc !== null && typeof proc.execucaoId === 'string' ? proc.execucaoId : null;
    const estadoDaExecucao = execucaoId === null ? null : registro.estado(execucaoId);
    const execucaoConfere = execucaoId !== null && r !== null && r.execucaoId === execucaoId && banco.execucaoId === execucaoId
      && consulta !== null && consulta.execucaoId === execucaoId && antes !== null && antes.execucaoId === execucaoId && depois !== null && depois.execucaoId === execucaoId;
    const execucaoEmitida = estadoDaExecucao !== null;
    const execucaoNaoReutilizada = comprometer ? estadoDaExecucao === 'ATIVA' : (estadoDaExecucao === 'ATIVA' || estadoDaExecucao === 'CONCLUIDA');
    // só uma execução registrada e ATIVA cujo PROCESSO e RESULTADO concordam no identificador pode ser concluída (inclusive com evidências incompletas: execução que falhou ou ficou inconclusiva também se encerra, de forma negativa);
    // uma apresentação misturada (processo de uma, resultado de outra) nunca consome a identidade de nenhuma delas
    if (comprometer && estadoDaExecucao === 'ATIVA' && r !== null && r.execucaoId === execucaoId) ctx.idParaConcluir = execucaoId;
    const pidConfere = proc !== null && Number.isSafeInteger(proc.pid) && banco.pgid === proc.pid;

    const destino = ehObjeto(e.destino) && typeof e.destino.banco === 'string' && typeof e.destino.host === 'string' ? e.destino : null;
    const socketEsperado = destino !== null && destino.host.startsWith('/') ? destino.host : null;
    const itens = {
      SPAWN_GENUINO: proc !== null && ehSpawnGenuino(proc),
      CLIENTE_GENUINO: antes !== null && depois !== null && consulta !== null && ehClienteGenuino(antes) && ehClienteGenuino(depois) && ehClienteGenuino(consulta),
      INSTANCIA_FISICA: antes !== null && antes.versao16 === true && antes.dataDirectory !== '' && antes.listenVazio === true && antes.semEnderecoTcp === true && (socketEsperado === null || antes.unixSocketDirectories === socketEsperado),
      DESTINO_IDENTIFICADO: r !== null && destino !== null && banco.ok === true && banco.banco === destino.banco && depois !== null && depois.bancoAtual === destino.banco && consulta !== null && consulta.banco === destino.banco,
      DUMP_AUTENTICADO: r !== null && ehAutenticacaoReconhecida(r.autenticacao) && r.autenticacao.autenticado === true && r.autenticacao.versao === 2 && ehObjeto(etapas.pacote) && etapas.pacote.ok === true,
      DUMP_CONFERIDO_ANTES: r !== null && ehObjeto(etapas.dump) && etapas.dump.conferido === true,
      PG_RESTORE_PELO_LANCADOR: proc !== null && proc.estado === 'INICIADO' && banco.ok === true && banco.origem === 'EXECUTOR_INJETADO' && Number.isSafeInteger(proc.pid) && banco.pgid === proc.pid,
      RESULTADO_TERMINAL: proc !== null && proc.terminou === true && banco.ok === true && banco.codigoDoProcesso === 0,
      SEM_PROCESSO_SOBREVIVENTE: proc !== null && proc.fluxosFechados === true && proc.grupo === 'VAZIO_OBSERVADO',
      IDENTIDADE_DO_BANCO_RESTAURADO: antes !== null && depois !== null && depois.dataDirectory === antes.dataDirectory && depois.unixSocketDirectories === antes.unixSocketDirectories && depois.porta === antes.porta && depois.versao16 === true,
      CONSULTAS_REAIS: consulta !== null && ehClienteGenuino(consulta),
      IMAGENS_INTEGRAS: r !== null && ehObjeto(etapas.imagens) && etapas.imagens.ok === true && Number.isSafeInteger(etapas.imagens.arquivos) && etapas.imagens.arquivos > 0 && ehObjeto(etapas.pacote) && etapas.pacote.arquivos >= etapas.imagens.arquivos,
      REFERENCIAS_X_ARQUIVOS: r !== null && ehObjeto(r.consistenciaLogica) && r.consistenciaLogica.contratual === true,
      CORRELACAO: r !== null && ehObjeto(etapas.pacote) && consulta !== null && consulta.sha256Manifesto === etapas.pacote.sha256Manifesto && consulta.conjuntoId === etapas.pacote.conjuntoId && pidConfere && execucaoConfere && execucaoEmitida && execucaoNaoReutilizada,
    };
    const lista = Object.freeze(Object.fromEntries(ITENS.map((k) => [k, itens[k] === true])));
    const pendencias = Object.freeze(ITENS.filter((k) => lista[k] !== true));
    const correlacao = Object.freeze({ pidConfere, execucaoConfere, execucaoEmitida, execucaoNaoReutilizada, estadoDaExecucao });
    return Object.freeze({ reconhecida: pendencias.length === 0, itens: lista, pendencias, correlacao, atestaRecuperabilidadeEmProducao: false, ...(comprometer && estadoDaExecucao === 'CONCLUIDA' ? { reapresentada: true } : {}) });
  }

  function avaliar(entradas) {
    const ctx = { idParaConcluir: null };
    let avaliacao;
    try {
      avaliacao = computar(entradas, ctx);
    } catch {
      // falha NO MEIO da avaliação: fail-closed; se a execução já era coerente e ATIVA ela é concluída com este resultado negativo (não fica reavaliável como nova)
      avaliacao = avaliacaoDeFalha();
    }
    if (comprometer && ctx.idParaConcluir !== null) registro.concluir(ctx.idParaConcluir, avaliacao);
    return avaliacao;
  }
  return Object.freeze({ avaliar });
}

/** Avaliador de TESTE: genuinidade INJETADA, nada é gravado no registro e o resultado nunca é reconhecido pela produção. Com `{ registro }` ele passa a concluir execuções DESSE registro (para testar o ciclo de vida), ainda sem nunca ser reconhecido. */
function criarAvaliadorDeRestauracaoReal(predicados, opcoes) {
  if (opcoes !== undefined && !(ehObjeto(opcoes) && Reflect.ownKeys(opcoes).length === 1 && ehObjeto(opcoes.registro) && typeof opcoes.registro.estado === 'function' && typeof opcoes.registro.concluir === 'function')) throw new TypeError('avaliador inválido');
  return criarAvaliadorInterno(predicados || {}, opcoes === undefined ? { registro: REGISTRO_DE_EXECUCOES, comprometer: false } : { registro: opcoes.registro, comprometer: true });
}

/** Avaliador de PRODUÇÃO: genuinidade já comprovada pelos produtores das evidências (o controle compara a função `spawn` com a do Node; as sondas e a consulta testam `instanceof` do `Client` do `pg`), registro ÚNICO do processo e resultado reconhecido. Várias instâncias compartilham o mesmo registro: uma execução só gera UMA autorização reconhecida. */
function criarAvaliadorPadrao() {
  const avaliador = criarAvaliadorInterno({ ehSpawnGenuino: (processo) => processo.spawnGenuino === true, ehClienteGenuino: (evidencia) => evidencia.clienteGenuino === true }, { registro: REGISTRO_DE_EXECUCOES, comprometer: true });
  return Object.freeze({
    avaliar(entradas) {
      const a = avaliador.avaliar(entradas);
      reconhecidas.add(a);
      return a;
    },
  });
}
const AVALIADOR_PADRAO = criarAvaliadorPadrao();

/** Avaliação produzida pelo avaliador PADRÃO de produção (a única que o código de produção reconhece). Literal, clone e saída de avaliador de teste não são. */
const ehAvaliacaoReconhecida = (v) => v !== null && typeof v === 'object' && reconhecidas.has(v);

module.exports = { emitirExecucaoDeRestauracao, consultarAvaliacaoDaExecucao, avaliarRestauracaoReal: (entradas) => AVALIADOR_PADRAO.avaliar(entradas), criarAvaliadorPadrao, criarAvaliadorDeRestauracaoReal, ehAvaliacaoReconhecida, ITENS_DA_PROVENIENCIA: ITENS };
