'use strict';

/**
 * D-ORF-6, R-D45 (D-F4): FICHA DE DESTINO DURÁVEL — o formato ÚNICO de cada entrada de `ARMAZENAMENTOS_DURAVEIS_APROVADOS` e a função pura que a localiza.
 * Este módulo não conhece a lista real (ela está em `imagem-backup-durabilidade.service`, hoje VAZIA): valida e consulta qualquer registro que receba.
 *
 * Uma ficha é LITERAL e congelada no código: `{ id, ambiente, tipo:'S3', regiao, contaId, bucket, prefixo, chaveMac, chaveCifra, retencao, identidades }`.
 * Nada vem de variável de ambiente, argumento ou arquivo de configuração: o executor recebe só o `id` e o ambiente e descobre o resto aqui.
 *  - `contaId` é a conta PROPRIETÁRIA do bucket (enviada como dono esperado em todo pedido). As `identidades` são os principais IAM que operam (publicador,
 *    verificador, restauração) e PODEM viver em outra conta (autorização entre contas): dono do bucket e identidade que opera são coisas distintas.
 *  - O nome do bucket é `safework-<hml|prod>-backup-<conta>` (marcador do ambiente e conta do proprietário) e o prefixo é `<hml|prod>/`.
 *  - As duas chaves KMS (MAC e KEK) são ARN completo de chave (nunca alias, que pode ser reapontado), distintas, na região da ficha.
 *  - Retenção do Object Lock: GOVERNANCE ou COMPLIANCE, de 1 a 3650 dias; PRODUÇÃO exige COMPLIANCE.
 * Entre fichas: ids, buckets, ARNs de chave e principais nunca se repetem, e HOMOLOGAÇÃO e PRODUÇÃO não compartilham conta.
 * Falha fechada: qualquer desvio lança `REGISTRO_DURAVEL_INVALIDO` com um `motivo` fixo (nunca o valor recebido).
 */

const AMBIENTES = Object.freeze(['HOMOLOGACAO', 'PRODUCAO']);
const MARCADOR = Object.freeze({ HOMOLOGACAO: 'hml', PRODUCAO: 'prod' });
const PAPEIS = Object.freeze(['publicador', 'verificador', 'restauracao']);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTA = /^\d{12}$/;
const REGIAO = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const BUCKET = /^safework-(hml|prod)-backup-(\d{12})$/;
const ARN_CHAVE = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOME_IAM = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const SESSAO = /^[A-Za-z0-9+=,.@_-]{2,64}$/;
const CHAVES_DA_FICHA = Object.freeze(['id', 'ambiente', 'tipo', 'regiao', 'contaId', 'bucket', 'prefixo', 'chaveMac', 'chaveCifra', 'retencao', 'identidades']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const invalido = (motivo) => Object.assign(new TypeError('registro de destinos duráveis inválido'), { code: 'REGISTRO_DURAVEL_INVALIDO', motivo });
const profundamenteCongelado = (v) => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(profundamenteCongelado));
const chaveDoPrincipal = (p) => `${p.contaId}|${p.tipo}|${p.nome}`;

function validarFicha(f) {
  if (!ehObjeto(f) || !chavesExatas(f, CHAVES_DA_FICHA) || !ehObjeto(f.retencao) || !chavesExatas(f.retencao, ['modo', 'dias']) || !ehObjeto(f.identidades) || !chavesExatas(f.identidades, PAPEIS)) throw invalido('FICHA_FORMATO');
  if (typeof f.id !== 'string' || !ID.test(f.id)) throw invalido('ID_INVALIDO');
  if (!AMBIENTES.includes(f.ambiente)) throw invalido('AMBIENTE_INVALIDO');
  if (f.tipo !== 'S3') throw invalido('TIPO_INVALIDO');
  if (typeof f.regiao !== 'string' || !REGIAO.test(f.regiao)) throw invalido('REGIAO_INVALIDA');
  if (typeof f.contaId !== 'string' || !CONTA.test(f.contaId)) throw invalido('CONTA_INVALIDA');
  const marcador = MARCADOR[f.ambiente];
  const bucket = typeof f.bucket === 'string' ? BUCKET.exec(f.bucket) : null;
  if (bucket === null || bucket[1] !== marcador || bucket[2] !== f.contaId) throw invalido('BUCKET_FORA_DO_PADRAO');
  if (f.prefixo !== `${marcador}/`) throw invalido('PREFIXO_FORA_DO_PADRAO');
  const arns = [f.chaveMac, f.chaveCifra].map((a) => (typeof a === 'string' ? ARN_CHAVE.exec(a) : null));
  if (arns.some((m) => m === null)) throw invalido('CHAVE_KMS_INVALIDA');
  if (arns.some((m) => m[1] !== f.regiao)) throw invalido('CHAVE_KMS_REGIAO_DIVERGENTE');
  if (f.chaveMac === f.chaveCifra) throw invalido('CHAVES_KMS_NAO_SEPARADAS');
  if (!['GOVERNANCE', 'COMPLIANCE'].includes(f.retencao.modo) || !Number.isInteger(f.retencao.dias) || f.retencao.dias < 1 || f.retencao.dias > 3650 || (f.ambiente === 'PRODUCAO' && f.retencao.modo !== 'COMPLIANCE')) throw invalido('RETENCAO_INVALIDA');
  const principais = PAPEIS.map((papel) => f.identidades[papel]);
  for (const p of principais) {
    if (!ehObjeto(p) || !chavesExatas(p, ['contaId', 'tipo', 'nome']) || typeof p.contaId !== 'string' || !CONTA.test(p.contaId) || !['user', 'role'].includes(p.tipo) || typeof p.nome !== 'string' || !NOME_IAM.test(p.nome)) throw invalido('IDENTIDADE_INVALIDA');
  }
  if (new Set(principais.map(chaveDoPrincipal)).size !== PAPEIS.length) throw invalido('IDENTIDADES_NAO_SEPARADAS');
}

/** `registro` deve ser um array congelado (profundamente) de fichas válidas e coerentes entre si. */
function validarRegistroDuravel(registro) {
  if (!Array.isArray(registro)) throw invalido('REGISTRO_FORMATO');
  if (!profundamenteCongelado(registro)) throw invalido('REGISTRO_NAO_CONGELADO');
  const ids = new Set();
  const buckets = new Set();
  const arns = new Set();
  const principais = new Set();
  const contas = { HOMOLOGACAO: new Set(), PRODUCAO: new Set() };
  for (const f of registro) {
    validarFicha(f);
    if (ids.has(f.id)) throw invalido('ID_DUPLICADO');
    if (buckets.has(f.bucket)) throw invalido('BUCKET_DUPLICADO');
    if (arns.has(f.chaveMac) || arns.has(f.chaveCifra)) throw invalido('CHAVE_KMS_COMPARTILHADA');
    const meus = PAPEIS.map((papel) => chaveDoPrincipal(f.identidades[papel]));
    if (meus.some((p) => principais.has(p))) throw invalido('IDENTIDADE_COMPARTILHADA');
    ids.add(f.id);
    buckets.add(f.bucket);
    arns.add(f.chaveMac);
    arns.add(f.chaveCifra);
    for (const p of meus) principais.add(p);
    contas[f.ambiente].add(f.contaId);
  }
  for (const c of contas.HOMOLOGACAO) if (contas.PRODUCAO.has(c)) throw invalido('CONTA_COMPARTILHADA_ENTRE_AMBIENTES');
}

/** Localiza uma ficha por id (e, se informado, ambiente). Só devolve motivos fixos; não valida o registro (quem o recebe já o validou). */
function localizarFicha(registro, id, ambiente) {
  if (ambiente !== undefined && !AMBIENTES.includes(ambiente)) return Object.freeze({ encontrada: false, motivo: 'AMBIENTE_INVALIDO' });
  const ficha = typeof id === 'string' && ID.test(id) ? registro.find((f) => f.id === id) : undefined;
  if (ficha === undefined) return Object.freeze({ encontrada: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
  if (ambiente !== undefined && ficha.ambiente !== ambiente) return Object.freeze({ encontrada: false, motivo: 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE' });
  return Object.freeze({ encontrada: true, ficha });
}

/**
 * A identidade que a AWS diz estar operando (`{ contaId, arn }`, da consulta de identidade) é a esperada pela ficha? Usuário: ARN exato. Papel: o ARN de sessão
 * `arn:aws:sts::<conta>:assumed-role/<papel>/<sessão>` (a sessão é qualquer nome válido). A conta do ARN tem de ser a conta declarada.
 */
function identidadeConfere(esperada, chamador) {
  if (!ehObjeto(esperada) || !ehObjeto(chamador) || typeof chamador.contaId !== 'string' || typeof chamador.arn !== 'string' || chamador.contaId !== esperada.contaId) return false;
  if (esperada.tipo === 'user') return chamador.arn === `arn:aws:iam::${esperada.contaId}:user/${esperada.nome}`;
  if (esperada.tipo === 'role') {
    const prefixo = `arn:aws:sts::${esperada.contaId}:assumed-role/${esperada.nome}/`;
    return chamador.arn.startsWith(prefixo) && SESSAO.test(chamador.arn.slice(prefixo.length));
  }
  return false;
}

/**
 * Controles que NENHUM teste local comprova e que continuam OBRIGATÓRIOS depois da implementação: o pré-voo e a conferência independente os listam sempre. A seleção
 * por versão do recibo reduz o risco de uma versão forjada, mas NÃO substitui nenhum deles. Cada item só sai desta lista com evidência real (T2 na AWS isolada, T3 na recuperação).
 */
const COMPROVACOES_POSTERIORES = Object.freeze([
  'ESCRITA_CONDICIONAL_NO_S3_A_COMPROVAR_EM_T2',
  'POLITICA_DO_BUCKET_QUE_EXIGE_A_CONDICAO_A_COMPROVAR_EM_T2',
  'OBJECT_LOCK_EM_CADA_VERSAO_A_COMPROVAR_EM_T2',
  'PERMISSOES_MINIMAS_E_NEGACOES_A_COMPROVAR_EM_T2',
  'RESTAURACAO_COMPLETA_A_COMPROVAR_EM_T3',
]);

module.exports = { validarRegistroDuravel, validarFicha, localizarFicha, identidadeConfere, AMBIENTES, MARCADOR, PAPEIS, COMPROVACOES_POSTERIORES };
