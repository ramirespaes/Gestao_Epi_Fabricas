'use strict';

const {
  LIMIAR_OFFLINE_SEGUNDOS, CONFIRMACAO_SEGUNDOS, JANELA_ESCRITA_MINIMA_SEGUNDOS, PRAZO_MAXIMO_SUSPEITA_SEGUNDOS,
} = require('../config/token-monitoramento');
const monitoramentoRepo = require('../repositories/token-monitoramento.repository');
const eventoRepo = require('../repositories/token-dispositivo-evento.repository');

/**
 * Monitoramento de comunicação do tablet do Atendimento Token (Etapa J, J2a). derivarEstado é pura. registrarContato (batida do
 * tablet) e verificarComunicacao (passagem do job externo de execução única, com relógio e sonda injetados) usam o banco e nunca
 * criam temporizador: quem agenda a passagem é o processo externo. Nenhuma das duas foi exercitada em PostgreSQL ainda.
 *
 * Três coisas distintas: o estado efetivo (derivado, só leitura), a transição formal QUEDA (confirmada pelo job: primeira
 * observação elegível e, numa passagem posterior, pelo menos o tempo de confirmação) e o RESTABELECIMENTO (feito pela batida).
 * A suspeita só vale por um prazo máximo (cadência nominal do job de 60 s, D25; 300 s, DEC-D5-02): a expirada, a inválida e
 * a superada por contato mais novo nunca confirmam QUEDA na passagem em que são identificadas; recomeçam, numa instrução atômica
 * do repositório, como nova primeira observação (se o silêncio persiste). A suspeita posterior ao relógio da passagem (outro job
 * com o relógio adiante) é preservada: não confirma nem reinicia, para não deslocar a primeira observação já persistida.
 */

function exigirInstante(valor, nome) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) {
    throw new TypeError(`${nome} deve ser uma data válida`);
  }
  return valor.getTime();
}

/**
 * Estado efetivo do tablet, derivado do último contato. Não é a transição QUEDA (formalizada pelo job).
 * Precedência: REVOGADO, NAO_ATIVADO, SEM_COMUNICACAO, depois ONLINE ou OFFLINE pelo silêncio.
 * Silêncio = max(0, agora - ultimo_contato_em): contato posterior ao relógio da leitura conta como silêncio zero.
 * O limiar é inclusivo: com exatamente LIMIAR_OFFLINE_SEGUNDOS de silêncio o estado já é OFFLINE.
 *
 * @param {{ativado_em: Date|null, revogado_em: Date|null, ultimo_contato_em: Date|null}} linha colunas de token_dispositivos
 * @param {Date} agora instante da leitura
 * @returns {'NAO_ATIVADO'|'SEM_COMUNICACAO'|'ONLINE'|'OFFLINE'|'REVOGADO'}
 */
function derivarEstado(linha, agora) {
  if (linha === null || typeof linha !== 'object') {
    throw new TypeError('linha do dispositivo é obrigatória');
  }
  const instanteAgora = exigirInstante(agora, 'agora');

  if (linha.revogado_em !== null && linha.revogado_em !== undefined) return 'REVOGADO';
  if (linha.ativado_em === null || linha.ativado_em === undefined) return 'NAO_ATIVADO';
  if (linha.ultimo_contato_em === null || linha.ultimo_contato_em === undefined) return 'SEM_COMUNICACAO';

  const silencioMs = Math.max(0, instanteAgora - exigirInstante(linha.ultimo_contato_em, 'ultimo_contato_em'));
  return silencioMs >= LIMIAR_OFFLINE_SEGUNDOS * 1000 ? 'OFFLINE' : 'ONLINE';
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

const CODIGOS_DE_REDE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);

/**
 * Indisponibilidade do banco (conexão, desligamento, limite de conexões): definição ÚNICA, também usada pelo executor do job. Erro
 * com SQLSTATE (cinco caracteres) é decidido só pelo código: falta de privilégio (42501), SQL inválido (42xxx), autenticação (28xxx),
 * banco inexistente (3D000), violação de restrição e erro de aplicação (P0xxx) NUNCA contam como indisponibilidade. Qualquer outro
 * erro é defeito e é propagado.
 */
function bancoIndisponivel(erro) {
  if (erro === null || typeof erro !== 'object') return false;
  const codigo = typeof erro.code === 'string' ? erro.code : '';
  if (/^(?=.*[0-9])[0-9A-Z]{5}$/.test(codigo)) return codigo.startsWith('08') || codigo.startsWith('57P') || codigo === '53300';
  if (CODIGOS_DE_REDE.has(codigo)) return true;
  return /Connection terminated|timeout exceeded when trying to connect/i.test(String(erro.message));
}

/**
 * Batida do tablet. A empresa e o tablet vêm da autenticação (nunca do cliente). Numa transação: trava a linha do tablet, grava o
 * contato só se a janela de escrita permite e, se o estado registrado era OFFLINE, grava UM RESTABELECIMENTO com a duração do
 * silêncio real (contato anterior até agora, DEC-D5-04). Batida comum não gera evento nem auditoria. A trava serializa batidas
 * simultâneas: só a primeira vê OFFLINE. Devolve { gravou, restabelecido }.
 */
async function registrarContato(pool, { empresaId, dispositivoId }) {
  return emTransacao(pool, async (cliente) => {
    const anterior = await monitoramentoRepo.travarParaContato(cliente, { empresaId, dispositivoId });
    if (anterior === null) return { gravou: false, restabelecido: false };
    const gravou = await monitoramentoRepo.gravarContato(cliente, { empresaId, dispositivoId, janelaSegundos: JANELA_ESCRITA_MINIMA_SEGUNDOS });
    const restabelecido = gravou && anterior.comunicacao_registrada === 'OFFLINE';
    if (restabelecido) {
      await eventoRepo.registrar(cliente, { empresaId, dispositivoId, tipo: 'RESTABELECIMENTO', duracaoSegundos: anterior.silencio_segundos ?? 0 });
    }
    return { gravou, restabelecido };
  });
}

const passagemInterrompida = (motivo, suspeitasInvalidadas = null) => ({ abortada: true, quedas: 0, motivo, suspeitasInvalidadas });

/** Sonda reprovada: aborta, sem tocar contato, estado nem eventos, e invalida as suspeitas (DEC-D5-03); null = não persistido. */
async function interromperPorFalhaDaSonda(pool) {
  try {
    return passagemInterrompida('SONDA_FALHOU', await monitoramentoRepo.descartarTodasAsSuspeitas(pool));
  } catch (erro) {
    if (bancoIndisponivel(erro)) return passagemInterrompida('SONDA_FALHOU');
    throw erro;
  }
}

const SUSPEITA = Object.freeze({
  AUSENTE: 'AUSENTE', EM_CONFIRMACAO: 'EM_CONFIRMACAO', CONFIRMAVEL: 'CONFIRMAVEL', EXPIRADA: 'EXPIRADA', INCONSISTENTE: 'INCONSISTENTE', FUTURA: 'FUTURA', SUPERADA: 'SUPERADA',
});

/**
 * Situação temporal da suspeita de um tablet já OFFLINE efetivo, no relógio `agora`. Inconsistente: não é um instante válido.
 * Futura: posterior a `agora` (por exemplo, criada por outro job com o relógio alguns milissegundos adiante): é preservada, não
 * confirma e não reinicia, porque substituí-la deslocaria a primeira observação já persistida; nenhuma tolerância de relógio é
 * inventada. Superada: o contato é mais novo que a suspeita. Expirada: idade acima do prazo máximo (300 s é válido).
 * Em confirmação: idade abaixo do tempo de confirmação. Confirmável: de 90 s a 300 s, inclusive. Só orienta o serviço; o banco
 * reavalia tudo no momento da escrita.
 */
function classificarSuspeita(tablet, agora) {
  const suspeita = tablet.queda_suspeita_desde;
  if (suspeita === null || suspeita === undefined) return SUSPEITA.AUSENTE;
  if (!(suspeita instanceof Date) || Number.isNaN(suspeita.getTime())) return SUSPEITA.INCONSISTENTE;
  if (suspeita.getTime() > agora.getTime()) return SUSPEITA.FUTURA;
  if (tablet.ultimo_contato_em.getTime() > suspeita.getTime()) return SUSPEITA.SUPERADA;
  const idadeSegundos = (agora.getTime() - suspeita.getTime()) / 1000;
  if (idadeSegundos > PRAZO_MAXIMO_SUSPEITA_SEGUNDOS) return SUSPEITA.EXPIRADA;
  return idadeSegundos < CONFIRMACAO_SEGUNDOS ? SUSPEITA.EM_CONFIRMACAO : SUSPEITA.CONFIRMAVEL;
}

async function avaliarTablets(pool, agora) {
  const tablets = await monitoramentoRepo.listarParaVerificacao(pool);
  let quedas = 0;
  let suspeitasFuturas = 0;
  for (const tablet of tablets) {
    if (tablet.comunicacao_registrada === 'OFFLINE') continue;
    const ids = { empresaId: tablet.empresa_id, dispositivoId: tablet.id };
    if (derivarEstado(tablet, agora) !== 'OFFLINE') {
      if (tablet.queda_suspeita_desde !== null) await monitoramentoRepo.descartarSuspeita(pool, ids);
      continue;
    }
    const situacao = classificarSuspeita(tablet, agora);
    if (situacao === SUSPEITA.AUSENTE) {
      await monitoramentoRepo.iniciarSuspeita(pool, { ...ids, agora });
    } else if (situacao === SUSPEITA.FUTURA) {
      suspeitasFuturas += 1;
    } else if (situacao === SUSPEITA.EXPIRADA || situacao === SUSPEITA.INCONSISTENTE || situacao === SUSPEITA.SUPERADA) {
      await monitoramentoRepo.reiniciarSuspeitaExpirada(pool, { ...ids, agora, prazoMaximoSegundos: PRAZO_MAXIMO_SUSPEITA_SEGUNDOS });
    } else if (situacao === SUSPEITA.CONFIRMAVEL) {
      const confirmada = await emTransacao(pool, async (cliente) => {
        const confirmou = await monitoramentoRepo.confirmarQueda(cliente, { ...ids, agora, idadeMaximaSegundos: PRAZO_MAXIMO_SUSPEITA_SEGUNDOS });
        if (confirmou) await eventoRepo.registrar(cliente, { ...ids, tipo: 'QUEDA' });
        return confirmou;
      });
      if (confirmada) quedas += 1;
    }
  }
  return { abortada: false, quedas, motivo: null, suspeitasInvalidadas: null, suspeitasFuturas };
}

/**
 * Uma passagem do job externo. Primeiro a sonda: reprovada aborta e invalida suspeitas; inconclusiva (erro ou resposta que não
 * seja booleana) aborta sem escrever nada, porque a falha não está comprovada; banco indisponível aborta sem afirmar o que foi
 * persistido. Saudável: tablets elegíveis (ativado, não revogado, com contato, empresa ativa) que não estão registrados como
 * OFFLINE: silêncio abaixo do limiar descarta a suspeita; silêncio de pelo menos o limiar sem suspeita abre a suspeita (a
 * primeira observação NUNCA confirma, ainda que tardia); suspeita expirada, inválida ou superada por contato mais novo
 * recomeça (nunca confirma nessa passagem); suspeita futura é preservada e contada em suspeitasFuturas; suspeita de 90 s a 300 s
 * de idade confirma UMA QUEDA com um evento, na mesma transação. Devolve { abortada, quedas, motivo, suspeitasInvalidadas }.
 */
async function verificarComunicacao(pool, { relogio, sonda } = {}) {
  if (typeof relogio !== 'function' || typeof sonda !== 'function') throw new TypeError('relógio e sonda são obrigatórios');
  const agora = await relogio();
  exigirInstante(agora, 'agora');

  let saude;
  try {
    saude = await sonda();
  } catch {
    saude = undefined;
  }
  if (saude === false) return interromperPorFalhaDaSonda(pool);
  if (saude !== true) return passagemInterrompida('SONDA_INCONCLUSIVA');

  try {
    return await avaliarTablets(pool, agora);
  } catch (erro) {
    if (bancoIndisponivel(erro)) return passagemInterrompida('BANCO_INDISPONIVEL');
    throw erro;
  }
}

module.exports = { derivarEstado, registrarContato, verificarComunicacao, bancoIndisponivel };
