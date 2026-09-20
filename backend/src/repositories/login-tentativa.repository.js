'use strict';

const { chaveCooldownTemFormatoValido } = require('../security/cooldown');

/**
 * Repositório de tentativas de login e cooldown (migration 015).
 *
 * A chave de correlação é sempre `chave_cooldown`, uma string opaca de 64
 * caracteres hexadecimais já calculada por `src/security/cooldown.js`
 * (HMAC-SHA-256 sobre CNPJ e e-mail normalizados). Este módulo nunca recebe
 * CNPJ, e-mail, senha, hash de senha, token ou cookie — a tabela não possui
 * colunas para nada disso, e a geração da chave não é reproduzida aqui,
 * apenas o formato é conferido com `chaveCooldownTemFormatoValido`.
 *
 * Duas operações de escrita, correspondentes às duas formas de linha que a
 * migration define:
 *   - `registrarTentativa`: uma tentativa de login, com sucesso ou falha.
 *     Nunca grava `cooldown_ate`.
 *   - `registrarAtivacaoCooldown`: a ativação do bloqueio em si — uma linha
 *     à parte, com motivo fixo `COOLDOWN_ATIVADO` e `cooldown_ate` no
 *     futuro. `registrarTentativa` recusa esse motivo de propósito, para
 *     que as duas formas de linha não se confundam na chamada.
 *
 * Duas operações de leitura, as mesmas descritas em CLAUDE.md (seção 20)
 * como parte da sequência transacional do futuro serviço de login:
 *   - `buscarCooldownVigente`: existe bloqueio em vigor agora?
 *   - `contarFalhasRecentes`: quantas falhas reais (não ativação) desde um
 *     instante informado pelo chamador, sempre desprezando o que aconteceu
 *     antes do último sucesso da mesma chave — a mesma regra documentada na
 *     migration, embutida na consulta, não em código que decide depois.
 *
 * ORDENAÇÃO DE `contarFalhasRecentes`: `now()` é fixado uma única vez no
 * início de cada transação PostgreSQL. Duas linhas gravadas na mesma
 * transação (ex.: um sucesso seguido de uma falha) recebem o mesmo
 * `criado_em` — `criado_em` sozinho não define uma ordem total entre
 * tentativas. A fronteira do último sucesso usa por isso `id`
 * (BIGINT GENERATED ALWAYS AS IDENTITY), que cresce estritamente na ordem
 * de inserção mesmo quando os timestamps empatam: contam-se as falhas com
 * `id` maior que o maior `id` de sucesso da mesma chave. `criado_em`
 * continua sendo o filtro da janela de tempo (`criado_em > desde`), papel
 * diferente do de ordenar tentativas entre si.
 *
 * Essa garantia de ordem por `id` depende de que as operações da mesma
 * chave sejam serializadas: é isso que o advisory lock descrito em
 * `src/security/cooldown.js` (derivarAdvisoryLock64) e em CLAUDE.md (seção
 * 20) existe para fazer. Com o lock, a transação que grava uma tentativa
 * para uma chave só começa depois que a transação anterior da MESMA chave
 * já terminou — o que faz o `id` refletir a ordem real dos eventos daquela
 * chave, mesmo que `id` seja uma sequência compartilhada por todas as
 * chaves. Este repositório NÃO adquire esse lock: é responsabilidade do
 * futuro serviço de login, antes de chamar `registrarTentativa`,
 * `registrarAtivacaoCooldown`, `buscarCooldownVigente` e
 * `contarFalhasRecentes` na mesma transação.
 *
 * Limiares (quantas falhas, em qual janela, por quanto tempo bloquear) e a
 * decisão de ativar o cooldown pertencem à camada de serviço. Este
 * repositório apenas persiste e consulta.
 *
 * login_tentativas.id é BIGINT GENERATED ALWAYS AS IDENTITY; o driver `pg`
 * devolve a coluna como string, e o contrato deste módulo é preservar essa
 * representação — nunca converter para Number, o que perderia precisão
 * acima de Number.MAX_SAFE_INTEGER.
 */

const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
const MOTIVO_COOLDOWN_ATIVADO = 'COOLDOWN_ATIVADO';

function exigirChaveCooldown(chaveCooldown) {
  if (!chaveCooldownTemFormatoValido(chaveCooldown)) {
    throw new TypeError('chave de cooldown com formato inválido');
  }
}

/** empresa_id e usuario_id são opcionais (tentativa sem identificação). */
function normalizarIdentificadorOpcional(valor, nomeCampo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nomeCampo} inválido`);
  }
  return valor;
}

/**
 * Espelha chk_login_tentativas_usuario_exige_empresa: usuário sem empresa
 * deixaria a FK composta sem verificação (MATCH SIMPLE ignora NULL).
 */
function exigirVinculoValido(empresaId, usuarioId) {
  if (usuarioId !== null && empresaId === null) {
    throw new TypeError('usuário identificado exige empresa identificada');
  }
}

function exigirMotivo(motivo) {
  if (typeof motivo !== 'string' || !FORMATO_MOTIVO.test(motivo)) {
    throw new TypeError('motivo inválido');
  }
}

function exigirData(valor, nomeCampo) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) {
    throw new TypeError(`${nomeCampo} deve ser uma data válida`);
  }
}

/**
 * Registra uma tentativa de login, bem-sucedida ou não. Nunca grava
 * cooldown_ate — a ativação do bloqueio é responsabilidade exclusiva de
 * `registrarAtivacaoCooldown`.
 *
 * As combinações de identificação espelham as constraints da migration:
 *   sucesso = true  -> exige empresaId e usuarioId, motivo deve ser nulo.
 *   sucesso = false -> exige motivo; usuarioId só é aceito com empresaId.
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, empresaId?: number|null, usuarioId?: number|null,
 *          sucesso: boolean, motivo?: string|null, ip?: string|null,
 *          dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da tentativa, string decimal canônica
 */
async function registrarTentativa(executor, {
  chaveCooldown, empresaId = null, usuarioId = null, sucesso, motivo = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const empresaIdNormalizado = normalizarIdentificadorOpcional(empresaId, 'empresa');
  const usuarioIdNormalizado = normalizarIdentificadorOpcional(usuarioId, 'usuário');
  exigirVinculoValido(empresaIdNormalizado, usuarioIdNormalizado);

  if (typeof sucesso !== 'boolean') {
    throw new TypeError('sucesso deve ser booleano');
  }

  let motivoFinal;
  if (sucesso) {
    if (motivo !== null && motivo !== undefined) {
      throw new TypeError('tentativa bem-sucedida não pode ter motivo');
    }
    if (empresaIdNormalizado === null || usuarioIdNormalizado === null) {
      throw new TypeError('tentativa bem-sucedida exige empresa e usuário identificados');
    }
    motivoFinal = null;
  } else {
    exigirMotivo(motivo);
    if (motivo === MOTIVO_COOLDOWN_ATIVADO) {
      throw new TypeError('use registrarAtivacaoCooldown para o motivo COOLDOWN_ATIVADO');
    }
    motivoFinal = motivo;
  }

  const { rows } = await executor.query(
    `INSERT INTO login_tentativas (chave_cooldown, empresa_id, usuario_id, sucesso, motivo, ip, dispositivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [chaveCooldown, empresaIdNormalizado, usuarioIdNormalizado, sucesso, motivoFinal, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Registra a ativação do cooldown como linha própria: sucesso e motivo são
 * fixos (false / COOLDOWN_ATIVADO) e não podem ser sobrescritos pelo
 * chamador — só chaveCooldown, cooldownAte, o vínculo opcional e os dados
 * de contexto variam.
 *
 * @param {{query: Function}} executor
 * @param {{chaveCooldown: string, cooldownAte: Date, empresaId?: number|null,
 *          usuarioId?: number|null, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<string>} identificador da ativação, string decimal canônica
 */
async function registrarAtivacaoCooldown(executor, {
  chaveCooldown, cooldownAte, empresaId = null, usuarioId = null, ip = null, dispositivo = null,
}) {
  exigirChaveCooldown(chaveCooldown);
  const empresaIdNormalizado = normalizarIdentificadorOpcional(empresaId, 'empresa');
  const usuarioIdNormalizado = normalizarIdentificadorOpcional(usuarioId, 'usuário');
  exigirVinculoValido(empresaIdNormalizado, usuarioIdNormalizado);
  exigirData(cooldownAte, 'cooldownAte');

  const { rows } = await executor.query(
    `INSERT INTO login_tentativas (chave_cooldown, empresa_id, usuario_id, sucesso, motivo, cooldown_ate, ip, dispositivo)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7)
     RETURNING id`,
    [chaveCooldown, empresaIdNormalizado, usuarioIdNormalizado, MOTIVO_COOLDOWN_ATIVADO, cooldownAte, ip, dispositivo],
  );

  return rows[0].id;
}

/**
 * Existe cooldown em vigor agora para esta chave? A condição `cooldown_ate
 * > now()` está na consulta, não em código que decide depois — uma
 * ativação já vencida simplesmente não é encontrada.
 *
 * @param {{query: Function}} executor
 * @param {string} chaveCooldown
 * @returns {Promise<{ativoAte: Date}|null>}
 */
async function buscarCooldownVigente(executor, chaveCooldown) {
  exigirChaveCooldown(chaveCooldown);

  const { rows } = await executor.query(
    `SELECT cooldown_ate
       FROM login_tentativas
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NOT NULL
        AND cooldown_ate > now()
      ORDER BY cooldown_ate DESC
      LIMIT 1`,
    [chaveCooldown],
  );

  const linha = rows[0];
  return linha === undefined ? null : { ativoAte: linha.cooldown_ate };
}

/**
 * Conta falhas reais (exclui linhas de ativação de cooldown) desde
 * `desde`, sempre desprezando o que aconteceu antes ou junto do último
 * sucesso da mesma chave — a mesma regra da migration ("contam apenas
 * falhas posteriores ao último sucesso"), embutida na consulta.
 *
 * A fronteira do último sucesso é aplicada por `id`, não por `criado_em`:
 * ver a nota de ordenação no topo do arquivo. `criado_em > desde` continua
 * sendo exclusivamente o filtro da janela de tempo, que o chamador escolhe
 * (ex.: agora menos 15 minutos) — a definição da janela e do limiar de
 * bloqueio é decisão do serviço, não deste repositório. Quando não existe
 * sucesso anterior, a subconsulta `max(id)` devolve NULL, o `COALESCE`
 * cai para -1 e todas as falhas dentro da janela são contadas normalmente.
 *
 * @param {{query: Function}} executor
 * @param {string} chaveCooldown
 * @param {Date} desde
 * @returns {Promise<number>}
 */
async function contarFalhasRecentes(executor, chaveCooldown, desde) {
  exigirChaveCooldown(chaveCooldown);
  exigirData(desde, 'desde');

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM login_tentativas
      WHERE chave_cooldown = $1
        AND cooldown_ate IS NULL
        AND NOT sucesso
        AND criado_em > $2::timestamptz
        AND id > COALESCE(
              (SELECT max(id) FROM login_tentativas WHERE chave_cooldown = $1 AND sucesso),
              -1
            )`,
    [chaveCooldown, desde],
  );

  return rows[0].total;
}

module.exports = {
  MOTIVO_COOLDOWN_ATIVADO,
  registrarTentativa,
  registrarAtivacaoCooldown,
  buscarCooldownVigente,
  contarFalhasRecentes,
};
