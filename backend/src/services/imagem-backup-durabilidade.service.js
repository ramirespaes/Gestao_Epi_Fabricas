'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): DURABILIDADE — separa o que foi GRAVADO, SINCRONIZADO LOCALMENTE, PUBLICADO, DURAVELMENTE ARMAZENADO e RESTAURÁVEL COMPROVADO, e fixa o contrato de um DESTINO EXTERNO DURÁVEL.
 *
 * Revisão do que já existe (nenhuma correção de comportamento foi necessária): a captura grava tudo (laço de escrita parcial) e faz fsync do arquivo antes de resolver; a selagem escreve em temporário exclusivo (O_EXCL|O_NOFOLLOW, 0600), sincroniza o arquivo e liga sem sobrescrever;
 * a publicação sincroniza todos os arquivos e diretórios do pacote, reverifica o que foi persistido contra o selo, reserva o nome final, faz rename atômico e sincroniza o diretório de destino; falha do fsync final tenta reverter o rename (REVERTIDA) e, sem reversão comprovada, o estado é INCERTA.
 * fsync LOCAL não é durabilidade em mídia remota: ele só diz que o sistema operacional local recebeu os bytes. Por isso `duravelmenteArmazenado` só é verdadeiro com uma CONFIRMAÇÃO reconhecida de um destino durável de origem OPERACIONAL — e nenhum destino durável está aprovado (lista vazia).
 *
 * CONTRATO DO DESTINO DURÁVEL (`criarDestinoDuravel`): um adaptador injetado expõe `confirmar({ chave, sha256, bytes })` e responde exatamente `{ confirmado: true, chave, sha256, bytes }` (o que o armazenamento externo afirma ter gravado). Qualquer outra coisa — exceção, atraso além do prazo, campos divergentes, confirmação
 * parcial — é INCONCLUSIVO e nunca durável. Não existe confirmação inventada: sem adaptador aprovado só há confirmações de TESTE_CONTROLADO (NODE_ENV=test), que nunca são operacionais.
 */

const ARMAZENAMENTOS_DURAVEIS_APROVADOS = Object.freeze([]);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHAVE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const confirmacoesProduzidas = new WeakSet();

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração de durabilidade inválida'), { code: 'CONFIGURACAO_INVALIDA' });

/**
 * Cinco dimensões independentes, derivadas só de evidências dos componentes (captura e publicação) e de uma confirmação RECONHECIDA. `restauravelComprovado` é fornecido pela entrada operacional (prova ligada ao pacote); aqui só é repassado como booleano estrito.
 */
function classificarDurabilidade({ captura = null, publicacao = null, confirmacao = null, restauravelComprovado = false } = {}) {
  const gravado = ehObjeto(captura) && captura.ok === true && Number.isSafeInteger(captura.bytesGravados) && captura.bytesGravados === captura.bytesRecebidos;
  const publicado = ehObjeto(publicacao) && publicacao.publicada === true && publicacao.estado === 'PUBLICADA';
  const incerto = ehObjeto(publicacao) && publicacao.estado === 'INCERTA';
  const sincronizadoLocalmente = gravado && captura.fsyncConcluido === true && publicado;
  const confirmado = ehObjeto(confirmacao) && confirmacoesProduzidas.has(confirmacao) && confirmacao.confirmado === true && confirmacao.operacional === true;
  return Object.freeze({
    arquivoGravado: gravado,
    sincronizadoLocalmente,
    pacotePublicado: publicado,
    estadoIncerto: incerto,
    duravelmenteArmazenado: publicado && confirmado,
    restauravelComprovado: restauravelComprovado === true && publicado && confirmado,
    observacao: 'FSYNC_LOCAL_NAO_E_DURABILIDADE_REMOTA',
  });
}

/** `criarDestinoDuravel({ id, adaptador, prazoMs })`: aprovado só se `id` estiver em ARMAZENAMENTOS_DURAVEIS_APROVADOS (vazia); em NODE_ENV=test a origem é TESTE_CONTROLADO. */
function criarDestinoDuravel(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['id', 'adaptador', 'prazoMs']) || typeof opcoes.id !== 'string' || !ID.test(opcoes.id) || !ehObjeto(opcoes.adaptador) || typeof opcoes.adaptador.confirmar !== 'function') throw configuracaoInvalida();
  if (!Number.isSafeInteger(opcoes.prazoMs) || opcoes.prazoMs < 1 || opcoes.prazoMs > 600000) throw configuracaoInvalida();
  const aprovado = ARMAZENAMENTOS_DURAVEIS_APROVADOS.includes(opcoes.id);
  if (!aprovado && process.env.NODE_ENV !== 'test') throw Object.assign(new Error('armazenamento durável não aprovado'), { code: 'ARMAZENAMENTO_DURAVEL_NAO_APROVADO' });
  const origem = aprovado ? 'OPERACIONAL' : 'TESTE_CONTROLADO';
  const { id, adaptador, prazoMs } = opcoes;

  async function confirmarGravacao(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['chave', 'sha256', 'bytes']) || typeof pedido.chave !== 'string' || !CHAVE.test(pedido.chave) || !SHA256.test(pedido.sha256) || !Number.isSafeInteger(pedido.bytes) || pedido.bytes < 0) throw configuracaoInvalida();
    let timer;
    const prazo = new Promise((resolver) => { timer = setTimeout(() => resolver('PRAZO'), prazoMs); });
    let resposta;
    try {
      resposta = await Promise.race([Promise.resolve().then(() => adaptador.confirmar({ chave: pedido.chave, sha256: pedido.sha256, bytes: pedido.bytes })), prazo]);
    } catch {
      resposta = null;
    } finally {
      clearTimeout(timer);
    }
    const ok = ehObjeto(resposta) && chavesExatas(resposta, ['confirmado', 'chave', 'sha256', 'bytes']) && resposta.confirmado === true && resposta.chave === pedido.chave && resposta.sha256 === pedido.sha256 && resposta.bytes === pedido.bytes;
    const confirmacao = Object.freeze({ confirmado: ok, destino: id, origem, operacional: ok && origem === 'OPERACIONAL', motivo: ok ? null : 'CONFIRMACAO_INCONCLUSIVA_OU_DIVERGENTE' });
    confirmacoesProduzidas.add(confirmacao);
    return confirmacao;
  }

  return Object.freeze({ id, origem, confirmarGravacao });
}

module.exports = { classificarDurabilidade, criarDestinoDuravel, ARMAZENAMENTOS_DURAVEIS_APROVADOS };
