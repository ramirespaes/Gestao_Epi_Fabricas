'use strict';

const { LIMIAR_OFFLINE_SEGUNDOS, CONFIRMACAO_SEGUNDOS } = require('../config/token-monitoramento');

/**
 * Persistência do monitoramento de comunicação do tablet (Etapa J, J2a): token_dispositivos.queda_suspeita_desde guarda a
 * primeira observação do silêncio entre as passagens do job. iniciarSuspeita e descartarSuspeita não gravam contato, estado
 * registrado nem eventos; confirmarQueda e registrarContato são as duas únicas transições de estado e a transação (com o
 * evento) é de quem chama: o executor recebido deve ser um cliente dentro de BEGIN. Nenhuma destas funções foi exercitada em
 * PostgreSQL ainda (a coluna só existe depois da migration 089).
 *
 * AUTORIDADE: ter um executor não autoriza ninguém. listarParaVerificacao e descartarTodasAsSuspeitas atravessam empresas por
 * necessidade do job interno e não podem ser usadas por rota nem por usuário; a autoridade do job será validada na integração,
 * antes do uso operacional. As demais exigem empresa e dispositivo no mesmo predicado.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function exigirInstante(valor, nome) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) throw new TypeError(`${nome} inválido`);
}

/** Tablets que o job pode avaliar: empresa ativa, ativado, não revogado e com contato registrado. Só leitura. */
async function listarParaVerificacao(executor) {
  const { rows } = await executor.query(
    `SELECT d.id, d.empresa_id, d.ativado_em, d.revogado_em, d.ultimo_contato_em, d.comunicacao_registrada, d.queda_suspeita_desde
       FROM token_dispositivos d
       JOIN empresas e ON e.id = d.empresa_id
      WHERE e.ativo = true
        AND d.ativado_em IS NOT NULL
        AND d.revogado_em IS NULL
        AND d.ultimo_contato_em IS NOT NULL
      ORDER BY d.empresa_id, d.id`,
  );
  return rows;
}

/**
 * Abre a suspeita em `agora` se o tablet é elegível, não há suspeita aberta e o silêncio já é de pelo menos o limiar OFFLINE
 * (contato posterior a `agora` conta como silêncio zero). Instrução única: condição e escrita são atômicas. Preserva a
 * suspeita existente. Devolve true só quando esta chamada a abriu.
 */
async function iniciarSuspeita(executor, { empresaId, dispositivoId, agora }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirInstante(agora, 'instante');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos d
        SET queda_suspeita_desde = $3
      WHERE d.empresa_id = $1
        AND d.id = $2
        AND d.queda_suspeita_desde IS NULL
        AND d.ativado_em IS NOT NULL
        AND d.revogado_em IS NULL
        AND d.ultimo_contato_em IS NOT NULL
        AND EXISTS (SELECT 1 FROM empresas e WHERE e.id = d.empresa_id AND e.ativo = true)
        AND GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - d.ultimo_contato_em))) >= $4
      RETURNING d.id`,
    [empresaId, dispositivoId, agora, LIMIAR_OFFLINE_SEGUNDOS],
  );
  return rows.length === 1;
}

/** Limpa só a suspeita do tablet da empresa. Idempotente; não é RESTABELECIMENTO. Devolve true só quando havia suspeita. */
async function descartarSuspeita(executor, { empresaId, dispositivoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos
        SET queda_suspeita_desde = NULL
      WHERE empresa_id = $1 AND id = $2 AND queda_suspeita_desde IS NOT NULL
      RETURNING id`,
    [empresaId, dispositivoId],
  );
  return rows.length === 1;
}

/**
 * Substitui, numa instrução só, uma suspeita temporalmente inválida pela nova primeira observação em `agora`. Inválida é a que
 * está expirada (idade maior que o prazo máximo), infinita (instante inválido) ou superada por contato mais novo
 * (ultimo_contato_em > suspeita). Suspeita POSTERIOR a `agora` NÃO reinicia: pode ser só o relógio de outro job alguns
 * milissegundos adiante, e substituí-la deslocaria a primeira observação já persistida; ela é preservada e não confirma (a idade
 * negativa conta zero). Só reinicia se o tablet segue elegível, ainda não está registrado como
 * OFFLINE e o silêncio em `agora` é de pelo menos o limiar; nunca confirma QUEDA, nunca grava evento e só troca a coluna da
 * suspeita (contato e estado ficam como estão; o gatilho de atualizado_em age). O predicado é reavaliado no banco, sob a trava
 * de linha do UPDATE: um heartbeat que já cancelou a suspeita ou um job que já a renovou deixa zero linhas, então o segundo
 * job não desloca a nova primeira observação. Devolve true só quando ESTA chamada reiniciou. Instrução única, sem limpar e
 * depois abrir (nenhum estado intermediário é confirmado).
 */
async function reiniciarSuspeitaExpirada(executor, { empresaId, dispositivoId, agora, prazoMaximoSegundos }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirInstante(agora, 'instante');
  if (!(Number.isFinite(prazoMaximoSegundos) && prazoMaximoSegundos > 0)) throw new TypeError('prazo máximo inválido');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos d
        SET queda_suspeita_desde = $3
      WHERE d.empresa_id = $1
        AND d.id = $2
        AND d.ativado_em IS NOT NULL
        AND d.revogado_em IS NULL
        AND d.ultimo_contato_em IS NOT NULL
        AND EXISTS (SELECT 1 FROM empresas e WHERE e.id = d.empresa_id AND e.ativo = true)
        AND d.comunicacao_registrada IS DISTINCT FROM 'OFFLINE'
        AND d.queda_suspeita_desde IS NOT NULL
        AND GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - d.ultimo_contato_em))) >= $4
        AND CASE WHEN NOT isfinite(d.queda_suspeita_desde) THEN true
                 ELSE (d.ultimo_contato_em > d.queda_suspeita_desde
                       OR EXTRACT(EPOCH FROM ($3::timestamptz - d.queda_suspeita_desde)) > $5::numeric) END
      RETURNING d.id`,
    [empresaId, dispositivoId, agora, LIMIAR_OFFLINE_SEGUNDOS, prazoMaximoSegundos],
  );
  return rows.length === 1;
}

/**
 * Limpa a suspeita de TODOS os tablets (invalidação diante de falha comprovada da sonda). Uso exclusivo do job interno; não toca
 * contato, estado registrado nem eventos. Devolve quantas suspeitas existiam. (O gatilho de atualizado_em também age.)
 */
async function descartarTodasAsSuspeitas(executor) {
  const { rows } = await executor.query(
    `UPDATE token_dispositivos SET queda_suspeita_desde = NULL WHERE queda_suspeita_desde IS NOT NULL RETURNING id`,
  );
  return rows.length;
}

/**
 * Transição formal OFFLINE (QUEDA), numa instrução só: tablet elegível, ainda não registrado como OFFLINE, suspeita aberta que o
 * contato não superou (ultimo_contato_em <= suspeita), silêncio de pelo menos o limiar em `agora`, suspeita com pelo menos o
 * tempo de confirmação de idade e, se informada, no máximo `idadeMaximaSegundos` (null = sem prazo máximo). Idade e silêncio
 * negativos contam como zero. A suspeita é limpa na mesma instrução. A trava de linha do UPDATE serializa jobs concorrentes:
 * o segundo reavalia o predicado e não encontra linha. Devolve true só quando ESTA chamada confirmou; o evento é de quem chama,
 * na mesma transação, e só quando devolve true.
 */
async function confirmarQueda(executor, { empresaId, dispositivoId, agora, idadeMaximaSegundos = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirInstante(agora, 'instante');
  if (idadeMaximaSegundos !== null && !(Number.isFinite(idadeMaximaSegundos) && idadeMaximaSegundos > 0)) throw new TypeError('prazo máximo inválido');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos d
        SET comunicacao_registrada = 'OFFLINE', queda_suspeita_desde = NULL
      WHERE d.empresa_id = $1
        AND d.id = $2
        AND d.ativado_em IS NOT NULL
        AND d.revogado_em IS NULL
        AND d.ultimo_contato_em IS NOT NULL
        AND EXISTS (SELECT 1 FROM empresas e WHERE e.id = d.empresa_id AND e.ativo = true)
        AND d.comunicacao_registrada IS DISTINCT FROM 'OFFLINE'
        AND d.queda_suspeita_desde IS NOT NULL
        AND d.ultimo_contato_em <= d.queda_suspeita_desde
        AND GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - d.ultimo_contato_em))) >= $4
        AND GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - d.queda_suspeita_desde))) >= $5
        AND ($6::numeric IS NULL OR GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - d.queda_suspeita_desde))) <= $6::numeric)
      RETURNING d.id`,
    [empresaId, dispositivoId, agora, LIMIAR_OFFLINE_SEGUNDOS, CONFIRMACAO_SEGUNDOS, idadeMaximaSegundos],
  );
  return rows.length === 1;
}

/**
 * Trava a linha do tablet elegível (ativado, não revogado) e devolve o que o heartbeat precisa saber ANTES de gravar: o estado
 * registrado e o último contato anteriores e o silêncio real até agora (now() da transação). Serializa batidas simultâneas do
 * mesmo tablet; a ordem de trava é a das demais etapas (a linha do tablet). null se não há tablet elegível.
 */
async function travarParaContato(executor, { empresaId, dispositivoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `SELECT d.id, d.comunicacao_registrada, d.ultimo_contato_em,
            CASE WHEN d.ultimo_contato_em IS NULL THEN NULL
                 ELSE floor(GREATEST(0, EXTRACT(EPOCH FROM (now() - d.ultimo_contato_em))))::int END AS silencio_segundos
       FROM token_dispositivos d
      WHERE d.empresa_id = $1 AND d.id = $2 AND d.ativado_em IS NOT NULL AND d.revogado_em IS NULL
        FOR UPDATE OF d`,
    [empresaId, dispositivoId],
  );
  return rows[0] ?? null;
}

/**
 * Registra a batida numa instrução só. O contato (now() do banco) é gravado e o estado registrado passa a ONLINE somente se o
 * último contato é nulo, tem pelo menos a janela de idade (a partir de janelaSegundos, inclusive) ou o estado registrado é
 * OFFLINE (a batida que restabelece vale imediatamente). Estado nulo ou ONLINE com contato dentro da janela NÃO regrava o
 * contato. A suspeita pendente é sempre cancelada, sem alterar o contato quando ele não precisa ser regravado; a linha só é
 * escrita se há contato a gravar ou suspeita a cancelar. Chamar depois de travarParaContato, na mesma transação. Devolve true
 * quando a linha foi escrita (contato e/ou cancelamento da suspeita).
 */
async function gravarContato(executor, { empresaId, dispositivoId, janelaSegundos }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  if (!(Number.isFinite(janelaSegundos) && janelaSegundos >= 0)) throw new TypeError('janela inválida');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos
        SET ultimo_contato_em = CASE WHEN ultimo_contato_em IS NULL
                                       OR ultimo_contato_em <= now() - make_interval(secs => $3::double precision)
                                       OR comunicacao_registrada = 'OFFLINE'
                                     THEN now() ELSE ultimo_contato_em END,
            comunicacao_registrada = CASE WHEN ultimo_contato_em IS NULL
                                            OR ultimo_contato_em <= now() - make_interval(secs => $3::double precision)
                                            OR comunicacao_registrada = 'OFFLINE'
                                          THEN 'ONLINE' ELSE comunicacao_registrada END,
            queda_suspeita_desde = NULL
      WHERE empresa_id = $1 AND id = $2 AND ativado_em IS NOT NULL AND revogado_em IS NULL
        AND (ultimo_contato_em IS NULL
             OR ultimo_contato_em <= now() - make_interval(secs => $3::double precision)
             OR comunicacao_registrada = 'OFFLINE'
             OR queda_suspeita_desde IS NOT NULL)
      RETURNING id`,
    [empresaId, dispositivoId, janelaSegundos],
  );
  return rows.length === 1;
}

module.exports = {
  listarParaVerificacao, iniciarSuspeita, descartarSuspeita, reiniciarSuspeitaExpirada, descartarTodasAsSuspeitas, confirmarQueda,
  travarParaContato, gravarContato,
};
