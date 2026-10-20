'use strict';

const servico = require('../src/services/imagem-armazenamento-limpeza.service');
const verificacao = require('../src/services/imagem-armazenamento-verificacao.service');
const janelaDeEscrita = require('../src/utils/janela-escrita-imagens');
const { nomeSeguro } = require('../src/utils/pacote-padrao-erros');
const { criarParadaPorSinal, saidaDoSinal } = require('../src/utils/parada-por-sinal');

/**
 * Script administrativo: LIMPA os arquivos ÓRFÃOS do armazenamento de imagens (arquivos sem registro no banco). Biblioteca de Imagens, P-ORF-01, G5 e G7.
 *
 *   node --require dotenv/config scripts/imagens-limpar-orfaos.js [--json] [--executar] [--retencao-minutos <n>] [--intervalo-backup-minutos <n>] [--limite <n>]
 *                                                                  [--banco-autorizado <nome> --banco-oid <oid>]
 *
 * Ferramenta SEPARADA do verificador (`imagens:verificar` segue somente leitura). A SIMULAÇÃO é o padrão: só lê e relata. Só `--executar` apaga, e só com o destino
 * (banco e OID) conferido na conexão ANTES de ler qualquer imagem, o intervalo entre backups informado e a trava de janela configurada. NÃO EXISTE argumento que pule a
 * janela, a política, o veredito ou a conferência do banco, nem que inclua a biblioteca padrão. Executar sempre é decisão do operador, na hora: nenhum script npm embute `--executar`.
 * Credenciais e caminhos só pelo ambiente (DB_*, IMAGENS_ARMAZENAMENTO_DIRETORIO e IMAGENS_JANELA_ESCRITA_ARQUIVO, a trava compartilhada com o procedimento de backup).
 *
 * Códigos de saída: OK=0 (simulação concluída, mesmo com impedimentos, que só são informados, ou execução concluída), ERRO=1 (erro inesperado, inclusive de execução, e configuração),
 * ARGUMENTOS=2 (argumentos ou destino não autorizado), JANELA_OCUPADA=6 (backup ou outra limpeza em andamento), RECUSADO=7 (política, janela não configurada ou inválida, armazenamento
 * não confiável) e PARCIAL=8 (execução com falha ao remover algum conjunto). Os códigos 3, 4 e 5 são do verificador e não se repetem aqui. Erro inesperado nunca vira 6, 7 ou 8.
 *
 * Sinais (G7): na EXECUÇÃO, SIGINT e SIGTERM não matam o processo no meio: viram um pedido de parada. O conjunto em andamento termina (inclusive a espera pela trava do banco, que é
 * limitada), nenhum outro começa e a trava de janela é solta SÓ se a posse for confirmada pelo token (a de outro dono nunca é tocada). Um segundo sinal não interrompe nada. Sai com
 * 128 + o número do sinal (SIGINT 130, SIGTERM 143) quando o pedido impediu o início de algum conjunto; falha ao remover (8) e erro inesperado (1) prevalecem; pedido que não impediu
 * nada (chegou depois do último conjunto) sai como sempre. Os avisos vão para STDERR. O pedido só é ARMADO imediatamente antes do serviço, quando a trava passa a existir: antes disso
 * (por exemplo, numa conexão ao banco que não responde) Ctrl-C mata o processo como sempre. A simulação não toma trava nem apaga nada: o sinal a encerra como sempre. SIGKILL, falta de
 * energia e memória esgotada não são tratáveis: a trava ficaria no disco e só a recuperação controlada a resolve.
 *
 * A saída nunca leva caminho absoluto, segredo, token nem caractere de controle vindo do disco. De uma falha inesperada só se mostra o código técnico (e a mensagem dos erros que o
 * próprio módulo produz, escapada): a mensagem original de E/S ou do banco pode ter caminho, usuário ou segredo e nunca sai. O relatório do que já foi feito sai junto.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  JANELA_OCUPADA: 6,
  RECUSADO: 7,
  PARCIAL: 8,
});

const COM_VALOR = Object.freeze({
  '--retencao-minutos': 'retencao',
  '--intervalo-backup-minutos': 'intervalo',
  '--limite': 'limite',
  '--banco-autorizado': 'banco',
  '--banco-oid': 'oid',
});
const INTEIRO = /^[1-9][0-9]{0,5}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const CODIGO_TECNICO = /^[A-Za-z0-9_.]{1,40}$/;
const MAX_LINHAS_POR_SECAO = 40;

const dentroDe = (texto, minimo, maximo) => INTEIRO.test(texto) && Number(texto) >= minimo && Number(texto) <= maximo;

/**
 * Interpreta argv (já sem `node` e o caminho do script). Puro, sem I/O; o erro nunca ecoa o valor recebido.
 * @returns {{ok: true, json: boolean, executar: boolean, retencaoMinutos: number, intervaloBackupMinutos: number|null, limite: number, destino: {banco: string, oid: string}|null}|{ok: false, erro: string}}
 */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  const valores = { retencao: null, intervalo: null, limite: null, banco: null, oid: null };
  let json = false;
  let executar = false;
  for (let i = 0; i < argumentos.length; i += 1) {
    const argumento = argumentos[i];
    if (Object.hasOwn(COM_VALOR, argumento)) {
      const campo = COM_VALOR[argumento];
      const valor = argumentos[i + 1];
      if (typeof valor !== 'string' || valor.startsWith('--')) return { ok: false, erro: `${argumento} exige um valor` };
      if (valores[campo] !== null) return { ok: false, erro: `${argumento} informado mais de uma vez` };
      valores[campo] = valor;
      i += 1;
    } else if (argumento === '--json') {
      if (json) return { ok: false, erro: '--json informado mais de uma vez' };
      json = true;
    } else if (argumento === '--executar') {
      if (executar) return { ok: false, erro: '--executar informado mais de uma vez' };
      executar = true;
    } else {
      return { ok: false, erro: 'argumento desconhecido' };
    }
  }
  if (valores.retencao !== null && !dentroDe(valores.retencao, servico.RETENCAO_MINIMA_MINUTOS, servico.RETENCAO_MAXIMA_MINUTOS)) {
    return { ok: false, erro: `--retencao-minutos deve ser um inteiro de ${servico.RETENCAO_MINIMA_MINUTOS} a ${servico.RETENCAO_MAXIMA_MINUTOS}` };
  }
  if (valores.intervalo !== null && !dentroDe(valores.intervalo, 1, servico.INTERVALO_BACKUP_MAXIMO_MINUTOS)) {
    return { ok: false, erro: `--intervalo-backup-minutos deve ser um inteiro de 1 a ${servico.INTERVALO_BACKUP_MAXIMO_MINUTOS}` };
  }
  if (valores.limite !== null && !dentroDe(valores.limite, 1, servico.LIMITE_MAXIMO)) return { ok: false, erro: `--limite deve ser um inteiro de 1 a ${servico.LIMITE_MAXIMO}` };
  if ((valores.banco === null) !== (valores.oid === null)) return { ok: false, erro: '--banco-autorizado e --banco-oid devem ser informados juntos' };
  if (valores.oid !== null && !OID.test(valores.oid)) return { ok: false, erro: '--banco-oid deve ser numérico' };
  if (valores.banco !== null && (valores.banco.length > 63 || /\p{Cc}/u.test(valores.banco))) return { ok: false, erro: '--banco-autorizado inválido' };
  if (executar && valores.banco === null) return { ok: false, erro: '--executar exige --banco-autorizado e --banco-oid' };
  if (executar && valores.intervalo === null) return { ok: false, erro: '--executar exige --intervalo-backup-minutos' };
  return {
    ok: true,
    json,
    executar,
    retencaoMinutos: valores.retencao === null ? servico.RETENCAO_PADRAO_MINUTOS : Number(valores.retencao),
    intervaloBackupMinutos: valores.intervalo === null ? null : Number(valores.intervalo),
    limite: valores.limite === null ? servico.LIMITE_PADRAO : Number(valores.limite),
    destino: valores.banco === null ? null : { banco: valores.banco, oid: valores.oid },
  };
}

function uso() {
  return [
    'Uso: node --require dotenv/config scripts/imagens-limpar-orfaos.js [--json] [--executar] [--retencao-minutos <n>] [--intervalo-backup-minutos <n>] [--limite <n>] [--banco-autorizado <nome> --banco-oid <oid>]',
    'Limpa os arquivos ÓRFÃOS do diretório de imagens (sem registro no banco). A SIMULAÇÃO é o padrão: só lê e relata, sem apagar nada. Só --executar apaga, e só nas condições abaixo.',
    '  --json                       imprime um único documento JSON (banco conferido e relatório) em vez do texto',
    `  --executar                   apaga os candidatos; exige --banco-autorizado, --banco-oid e --intervalo-backup-minutos, e a variável IMAGENS_JANELA_ESCRITA_ARQUIVO`,
    `  --retencao-minutos           idade mínima do arquivo mais novo de um conjunto para ser removido (${servico.RETENCAO_MINIMA_MINUTOS} a ${servico.RETENCAO_MAXIMA_MINUTOS}; padrão ${servico.RETENCAO_PADRAO_MINUTOS}); precisa superar o intervalo entre backups em pelo menos 60 min`,
    `  --intervalo-backup-minutos   pior caso entre dois backups concluídos (1 a ${servico.INTERVALO_BACKUP_MAXIMO_MINUTOS}); na simulação serve para avaliar a política`,
    `  --limite                     máximo de conjuntos tratados por execução (1 a ${servico.LIMITE_MAXIMO}; padrão ${servico.LIMITE_PADRAO}); o resto fica para a próxima`,
    '  --banco-autorizado, --banco-oid   nome e OID do banco autorizado (sempre juntos, vindos da autorização escrita); conferidos na conexão ANTES de ler qualquer imagem',
    'Ambiente: DB_* (banco), IMAGENS_ARMAZENAMENTO_DIRETORIO (diretório de imagens) e IMAGENS_JANELA_ESCRITA_ARQUIVO (arquivo de trava, caminho absoluto FORA do diretório de imagens, compartilhado com o backup).',
    'Sinais (só na execução): SIGINT e SIGTERM pedem a parada: o conjunto em andamento termina, nenhum outro começa e a trava de janela é solta pelo dono (confirmado pelo token); um segundo sinal não interrompe. SIGKILL deixaria a trava no disco (recuperação controlada).',
    'Saída: 0 concluído, 1 erro, 2 argumentos/destino, 6 janela ocupada, 7 execução recusada, 8 execução com falha ao remover, 130 (SIGINT) ou 143 (SIGTERM) parada por sinal. Não há argumento que pule a janela, a política ou o veredito.',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------------------------------- texto
const abreviar = (hash) => (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? `${hash.slice(0, 12)}…` : nomeSeguro(hash));
const rotulo = (item) => `${item.empresaId === null ? 'padrão' : `empresa ${item.empresaId}`} · pasta ${abreviar(item.hash)} · ${nomeSeguro(item.tipo)}`;
const idade = (minutos) => (minutos >= 1440 ? `${Math.floor(minutos / 1440)} dia(s)` : `${minutos} min`);
const nomes = (arquivos) => arquivos.map((arquivo) => nomeSeguro(typeof arquivo === 'string' ? arquivo : arquivo.nome)).join(', ');

const linhaDoPlano = (item) => `  - ${rotulo(item)} (arquivos=${item.arquivos.length}${item.arquivos.length > 0 ? `: ${nomes(item.arquivos)}` : ''}; ${item.bytes} bytes; idade ${idade(item.idadeMinutos)})`;
const linhaDoRemovido = (item) => {
  const bytes = item.arquivos.reduce((soma, arquivo) => soma + arquivo.bytes, 0);
  return `  - ${rotulo(item)}: ${item.arquivos.length} arquivo(s)${item.arquivos.length > 0 ? ` (${nomes(item.arquivos)})` : ''}, ${bytes} bytes, ${item.pastaRemovida ? 'pasta removida' : 'pasta mantida'}`;
};
const linhaDoIgnorado = (item) => `  - ${rotulo(item)}: ${nomeSeguro(item.motivo)}`;
const linhaDaFalha = (item) => `  - ${rotulo(item)}: ${nomeSeguro(item.codigo)}${item.codigoSistema ? ` (código ${nomeSeguro(item.codigoSistema)})` : ''}`;

function imprimirSecao(saida, titulo, nota, linhas) {
  if (linhas.length === 0) return;
  saida.log('');
  saida.log(`${titulo} (${linhas.length})`);
  if (nota) saida.log(`  ${nota}`);
  for (const linha of linhas.slice(0, MAX_LINHAS_POR_SECAO)) saida.log(linha);
  if (linhas.length > MAX_LINHAS_POR_SECAO) saida.log(`  ... e mais ${linhas.length - MAX_LINHAS_POR_SECAO}`);
}

function descreverJanela(janela) {
  const dono = janela.dono === null ? 'dono desconhecido' : `${nomeSeguro(janela.dono.tipo)}, pid ${nomeSeguro(janela.dono.pid)}, desde ${nomeSeguro(janela.dono.iniciadoEm)}`;
  switch (janela.estado) {
    case 'NAO_CONFIGURADA': return 'não configurada (IMAGENS_JANELA_ESCRITA_ARQUIVO)';
    case 'NAO_AVALIADA': return 'não avaliada (uma recusa anterior impediu a consulta)';
    case 'LIVRE': return 'livre';
    case 'OCUPADA': return `ocupada (${dono})`;
    case 'INVALIDA': return 'inválida (caminho relativo ou dentro do diretório de imagens)';
    case 'LIBERADA': return 'tomada pela limpeza e liberada ao final';
    case 'PERDIDA': return 'PERDIDA: a trava deixou de ser da limpeza durante a execução';
    case 'NAO_LIBERADA': return 'NÃO LIBERADA: a trava pode ter ficado; siga a recuperação controlada da trava antes de nova execução ou backup';
    default: return nomeSeguro(janela.estado);
  }
}

const EXPLICACAO_DA_RECUSA = Object.freeze({
  RETENCAO_ABAIXO_DO_MINIMO: 'a retenção é menor que 24 h',
  RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP: 'a retenção precisa superar o intervalo entre backups em pelo menos 60 min',
  INTERVALO_DE_BACKUP_NAO_INFORMADO: 'informe --intervalo-backup-minutos',
  JANELA_NAO_CONFIGURADA: 'defina IMAGENS_JANELA_ESCRITA_ARQUIVO (a trava de janela compartilhada com o backup)',
  JANELA_INVALIDA: 'o arquivo da janela precisa ser um caminho absoluto, de pasta existente e FORA do diretório de imagens',
  JANELA_OCUPADA: 'um backup ou outra limpeza está em andamento (ou deixou a trava); nunca quebre a trava sem confirmar que nenhum processo a usa',
  ARMAZENAMENTO_NAO_CONFIAVEL: 'o armazenamento tem divergências ou alertas: rode `npm run imagens:verificar` e investigue antes de limpar',
});

function imprimirRecusa(saida, relatorio) {
  const { recusa } = relatorio;
  const codigo = nomeSeguro(recusa.codigo);
  const dono = recusa.dono === undefined ? '' : ` Dono: ${recusa.dono === null ? 'desconhecido' : `${nomeSeguro(recusa.dono.tipo)}, pid ${nomeSeguro(recusa.dono.pid)}, desde ${nomeSeguro(recusa.dono.iniciadoEm)}`}.`;
  const motivo = recusa.motivo === undefined ? '' : ` Motivo: ${nomeSeguro(recusa.motivo)}.`;
  saida.log(`Recusado (${codigo}): ${EXPLICACAO_DA_RECUSA[recusa.codigo] ?? 'a execução não é segura nas condições informadas'}.${dono}${motivo}`);
  const outros = relatorio.impedimentos.filter((impedimento) => impedimento !== recusa.codigo);
  if (outros.length > 0) saida.log(`Outros impedimentos: ${outros.map(nomeSeguro).join(', ')}`);
  saida.log('Nada foi removido.');
}

function imprimirRelatorio(saida, banco, destinoConfere, relatorio, interrompido = false, sinal = null) {
  const execucao = relatorio.modo === 'EXECUCAO';
  const parada = relatorio.paradaSolicitada === true && sinal !== null ? ` PARADA POR SINAL (${nomeSeguro(sinal)})` : '';
  saida.log(`Limpeza de órfãos das imagens — ${execucao ? 'EXECUÇÃO' : 'SIMULAÇÃO'}${interrompido ? ' INTERROMPIDA' : ''}${parada} ${execucao ? '(apaga arquivos órfãos de empresas, nunca a biblioteca padrão)' : '(nada é alterado, apagado nem movido)'}`);
  saida.log(`Banco conferido pela conexão: ${nomeSeguro(banco.nome)} (oid ${nomeSeguro(banco.oid)}); ${destinoConfere ? 'destino autorizado confere' : 'destino NÃO confirmado (informe --banco-autorizado e --banco-oid para conferir o par banco/armazenamento)'}`);
  saida.log(`Política: retenção ${relatorio.retencaoMinutos} min; intervalo entre backups ${relatorio.intervaloBackupMinutos ?? 'não informado'}${relatorio.intervaloBackupMinutos === null ? '' : ' min'}; limite ${relatorio.limite}`);
  saida.log(`Janela de escrita: ${descreverJanela(relatorio.janela)}`);
  if (relatorio.veredito !== null) saida.log(`Veredito do armazenamento: ${nomeSeguro(relatorio.veredito)}${relatorio.alertas.length > 0 ? `; alertas: ${relatorio.alertas.map(nomeSeguro).join(', ')}` : ''}`);

  imprimirSecao(saida, 'CANDIDATOS', execucao ? 'planejados: só conjuntos de empresas, órfãos e mais velhos que a retenção' : 'conjuntos de empresas, órfãos e mais velhos que a retenção', relatorio.candidatos.map(linhaDoPlano));
  imprimirSecao(saida, 'RETIDOS', 'mais novos que a retenção: podem ser um envio em andamento; ficam', relatorio.retidos.map(linhaDoPlano));
  imprimirSecao(saida, 'FORA DO ESCOPO', 'biblioteca padrão: este comando nunca a limpa', relatorio.foraDoEscopo.map(linhaDoPlano));
  imprimirSecao(saida, 'REMOVIDOS', null, relatorio.removidos.map(linhaDoRemovido));
  imprimirSecao(saida, 'IGNORADOS', 'mudaram depois do plano e foram deixados como estavam; a próxima execução replaneja', relatorio.ignorados.map(linhaDoIgnorado));
  imprimirSecao(saida, 'FALHAS', 'o conjunto foi isolado e a execução seguiu; o que sobrou é tratado na próxima execução', relatorio.falhas.map(linhaDaFalha));

  saida.log('');
  if (!execucao) {
    if (!relatorio.executavel) saida.log(`A execução seria RECUSADA: ${relatorio.impedimentos.map(nomeSeguro).join(', ')}`);
    saida.log('Nenhuma alteração foi feita. Esta simulação não apaga, não move e não altera registros.');
  } else if (relatorio.recusa !== null) {
    imprimirRecusa(saida, relatorio);
  } else {
    saida.log(`Resumo: removidos=${relatorio.resumo.removidos} · ignorados=${relatorio.resumo.ignorados} · falhas=${relatorio.resumo.falhas} · bytes liberados=${relatorio.resumo.bytesLiberados} · restantes=${relatorio.resumo.restantes} · limite=${relatorio.limite}`);
    if (relatorio.resumo.removidos === 0 && relatorio.resumo.falhas === 0) saida.log('Nada foi removido.');
    if (sinal !== null) {
      saida.log(relatorio.paradaSolicitada
        ? `Parada pedida por ${nomeSeguro(sinal)}: o conjunto em andamento foi concluído, nenhum outro foi iniciado e a trava de janela foi solta; o restante fica para a próxima execução.`
        : `Sinal ${nomeSeguro(sinal)} recebido depois do último conjunto: nada deixou de ser feito.`);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------------- falhas
/** Só o que é seguro mostrar de uma falha inesperada: o código técnico e, nos erros que o próprio módulo produz (limpeza, janela e configuração de imagens), a mensagem escapada. */
function descreverFalha(erro) {
  const tecnico = [erro?.codigo, erro?.code].find((codigo) => typeof codigo === 'string' && CODIGO_TECNICO.test(codigo));
  const propria = erro instanceof servico.ErroDeLimpeza || erro instanceof janelaDeEscrita.ErroDeJanela || (typeof erro?.codigo === 'string' && erro.codigo.startsWith('IMAGENS_'));
  const mensagem = propria && typeof erro.message === 'string' ? ` — ${nomeSeguro(erro.message)}` : '';
  return `${tecnico ?? 'erro inesperado'}${mensagem}`;
}

const codigoTecnico = (erro) => [erro?.codigo, erro?.code].find((codigo) => typeof codigo === 'string' && CODIGO_TECNICO.test(codigo)) ?? 'erro inesperado';

/** Erro inesperado da execução: SAÍDA 1, só o código técnico, e o que já foi feito (relatório parcial) junto. */
function falhar(saida, json, banco, destinoConfere, erro) {
  const parcial = erro?.relatorioParcial ?? null;
  saida.error(`Falha: ${descreverFalha(erro)}`);
  if (parcial !== null && banco !== undefined) {
    if (json) {
      saida.log(JSON.stringify({ banco, destinoConfere, interrompido: true, erro: codigoTecnico(erro), relatorio: parcial }));
    } else {
      imprimirRelatorio(saida, banco, destinoConfere, parcial, true);
      saida.log('');
      saida.log('A execução foi INTERROMPIDA por um erro: o que já foi feito está listado acima. Entenda a causa (e rode `npm run imagens:verificar`) antes de repetir.');
      if (erro.conjunto !== undefined) {
        const { conjunto } = erro;
        saida.log(`Conjunto em andamento: ${rotulo(conjunto)}; arquivos já removidos dele: ${conjunto.arquivosJaRemovidos.length}${conjunto.arquivosJaRemovidos.length > 0 ? ` (${nomes(conjunto.arquivosJaRemovidos)})` : ''}`);
      }
      if (parcial.janela.estado === 'PERDIDA') saida.log('A trava de janela foi PERDIDA: confira se um backup estava em andamento antes de repetir a execução.');
    }
  }
  return { saida: SAIDAS.ERRO, resultado: parcial };
}

// ------------------------------------------------------------------------------------------------------------------------- execução
function saidaDoRelatorio(relatorio) {
  if (relatorio.modo === 'SIMULACAO') return SAIDAS.OK;
  if (relatorio.recusa !== null) return relatorio.recusa.codigo === 'JANELA_OCUPADA' ? SAIDAS.JANELA_OCUPADA : SAIDAS.RECUSADO;
  return relatorio.falhas.length > 0 ? SAIDAS.PARCIAL : SAIDAS.OK;
}

/**
 * Executa o comando com as dependências já prontas. Devolve o código de saída e o relatório, sem encerrar o pool (de quem chama). O destino (banco e OID) é conferido ANTES de ler
 * qualquer imagem: diferente do informado, ou ausente na execução, a saída é DESTINO_NAO_AUTORIZADO (2). Erro inesperado devolve SAÍDA 1 (ver `falhar`).
 *
 * @param {{json: boolean, executar: boolean, retencaoMinutos: number, intervaloBackupMinutos: number|null, limite: number, destino: {banco: string, oid: string}|null}} opcoes
 * @param {{pool: object, diretorio: string, janelaArquivo?: string, saida?: {log: Function, error: Function}, agora?: Function, fs?: object, ganchos?: object, tempoMaximoDaTravaMs?: number,
 *   parada?: {deveParar: Function, sinal: Function, armar?: Function}}} dependencias `parada` só vale na execução (a simulação a ignora) e, se tiver `armar`, é armada imediatamente
 *   antes do serviço (depois da conferência do destino); ver `criarParadaDoComando`.
 */
async function executarComando({
  json, executar, retencaoMinutos, intervaloBackupMinutos, limite, destino,
}, {
  pool, diretorio, janelaArquivo, saida = console, agora, fs, ganchos, tempoMaximoDaTravaMs, parada,
} = {}) {
  let banco;
  let destinoConfere = false;
  try {
    banco = await verificacao.identificarBanco(pool);
    destinoConfere = destino !== null && destino !== undefined && destino.banco === banco.nome && destino.oid === banco.oid;
    if ((destino && !destinoConfere) || (executar && !destinoConfere)) {
      saida.error('Recusado (DESTINO_NAO_AUTORIZADO): o banco da conexão não é o autorizado (ou não foi informado). Nenhuma imagem foi lida e nada foi removido.');
      saida.error(`  Conectado: banco ${nomeSeguro(banco.nome)} (oid ${nomeSeguro(banco.oid)})`);
      return { saida: SAIDAS.ARGUMENTOS, resultado: null };
    }
    if (executar && parada && typeof parada.armar === 'function') parada.armar();
    const relatorio = await servico.limparOrfaos(pool, {
      diretorio,
      executar,
      retencaoMinutos,
      intervaloBackupMinutos,
      limite,
      ...(janelaArquivo ? { janela: { arquivo: janelaArquivo } } : {}),
      ...(agora === undefined ? {} : { agora }),
      ...(fs === undefined ? {} : { fs }),
      ...(ganchos === undefined ? {} : { ganchos }),
      ...(tempoMaximoDaTravaMs === undefined ? {} : { tempoMaximoDaTravaMs }),
      ...(executar && parada ? { deveParar: parada.deveParar } : {}),
    });
    const sinal = executar && parada ? parada.sinal() : null;
    if (json) saida.log(JSON.stringify({ banco, destinoConfere, relatorio, ...(sinal === null ? {} : { sinal }) }));
    else imprimirRelatorio(saida, banco, destinoConfere, relatorio, false, sinal);
    const codigo = saidaDoRelatorio(relatorio);
    return { saida: codigo === SAIDAS.OK && relatorio.paradaSolicitada === true ? saidaDoSinal(sinal) : codigo, resultado: relatorio };
  } catch (erro) {
    return falhar(saida, json, banco, destinoConfere, erro);
  }
}

/**
 * Pedido de parada por SIGINT e SIGTERM, só na EXECUÇÃO (a simulação não toma trava nem apaga nada: devolve null e o sinal a encerra como sempre). Nasce DESARMADO: `executarComando`
 * o arma (`armar`) imediatamente antes do serviço, quando a trava passa a existir, e `principal` o retira (`encerrar`) só depois de ela ser solta. Antes disso (por exemplo, numa
 * conexão ao banco que não responde) nada a protege e Ctrl-C mata o processo como sempre. Os avisos vão para STDERR, nunca para stdout (o JSON continua um documento só).
 */
function criarParadaDoComando(interpretado, { processo = process, saida = console } = {}) {
  if (!interpretado.executar) return null;
  return criarParadaPorSinal({
    processo,
    armado: false,
    aoReceber: (sinal, ordem) => {
      saida.error(ordem === 1
        ? `Sinal ${sinal} recebido: a limpeza conclui o conjunto em andamento, não inicia outro e solta a trava de janela antes de sair.`
        : `Novo sinal (${sinal}) ignorado: a limpeza já está parando. Só SIGKILL a encerraria agora, e deixaria a trava de janela no disco.`);
    },
  });
}

async function principal() {
  const interpretado = interpretarArgumentos(process.argv.slice(2));
  if (!interpretado.ok) {
    console.error(`Argumentos inválidos: ${interpretado.erro}`);
    console.error(uso());
    return SAIDAS.ARGUMENTOS;
  }
  const { lerConfiguracao, exigirDiretorio } = require('../src/config/imagens');
  const diretorio = exigirDiretorio(lerConfiguracao(process.env));
  const janelaArquivo = janelaDeEscrita.lerArquivoDaJanela(process.env);
  if (interpretado.executar && janelaArquivo === null) {
    console.error('Recusado (JANELA_NAO_CONFIGURADA): defina IMAGENS_JANELA_ESCRITA_ARQUIVO (a trava de janela compartilhada com o backup). Nada foi lido nem removido.');
    return SAIDAS.RECUSADO;
  }
  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído, e uma configuração errada falha antes de qualquer conexão.
  const { pool } = require('../src/config/database');
  const parada = criarParadaDoComando(interpretado);
  try {
    return (await executarComando(interpretado, { pool, diretorio, janelaArquivo, parada })).saida;
  } finally {
    if (parada !== null) parada.encerrar();
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${descreverFalha(erro)}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { interpretarArgumentos, executarComando, criarParadaDoComando, uso, descreverFalha, SAIDAS };
