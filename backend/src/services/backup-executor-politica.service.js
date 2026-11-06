'use strict';

const { localizarArmazenamentoDuravel, ambienteDeTeste } = require('./imagem-backup-durabilidade.service');
const { PROVEDORES_OPERACIONAIS_APROVADOS } = require('./imagem-backup-manifesto-autenticado.service');
const { PROVEDORES_DE_CIFRA_APROVADOS } = require('./backup-fontes-cifra-envelope.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: PORTÕES (função pura, sem I/O). Dado o pedido (modo, ação, ambiente, destino durável, frase de confirmação) e os FATOS que o chamador observou
 * (SDK, origem das chaves, destino local, usuário e umask do processo), devolve TODOS os bloqueios de uma vez, em ordem estável, só com códigos fixos. Sem bloqueio, ainda assim
 * nada acontece aqui: o portão apenas autoriza o executor a seguir. `OPERACAO_HABILITADA` é constante do código (nunca de ambiente ou argumento): ligar a operação real é alterar
 * esta linha em mudança revisada, depois dos gates DEP-2, AWS, listas reais e cerimônia de custódia. O ensaio só existe em HOMOLOGACAO. Valores de teste (ficha, chaves e SDK
 * simulados) só valem em NODE_ENV=test e nunca em OPERACAO.
 */

const OPERACAO_HABILITADA = false;
const MODOS = Object.freeze(['ENSAIO', 'OPERACAO']);
const ACOES = Object.freeze(['BACKUP', 'RESTAURACAO', 'VERIFICACAO_DESTINO']);
const AMBIENTES = Object.freeze(['HOMOLOGACAO', 'PRODUCAO']);
const FRASES = Object.freeze({
  ENSAIO: Object.freeze({ BACKUP: 'EXECUTAR_ENSAIO_DE_BACKUP', RESTAURACAO: 'EXECUTAR_ENSAIO_DE_RESTAURACAO', VERIFICACAO_DESTINO: 'EXECUTAR_ENSAIO_DE_VERIFICACAO_DO_DESTINO' }),
  OPERACAO: Object.freeze({ BACKUP: 'EXECUTAR_BACKUP_OPERACIONAL', RESTAURACAO: 'EXECUTAR_RESTAURACAO_OPERACIONAL', VERIFICACAO_DESTINO: 'EXECUTAR_VERIFICACAO_OPERACIONAL_DO_DESTINO' }),
});
const BLOQUEIOS = Object.freeze([
  'ACAO_INVALIDA', 'AMBIENTE_INVALIDO', 'CONFIRMACAO_AUSENTE_OU_INVALIDA', 'DESTINO_DURAVEL_NAO_APROVADO', 'DESTINO_LOCAL_NAO_AUTORIZADO', 'DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA', 'ENSAIO_EM_PRODUCAO_PROIBIDO',
  'FONTE_DE_CHAVES_NAO_APROVADA', 'LIGACAO_OPERACIONAL_AUSENTE', 'MODO_INVALIDO', 'OPERACAO_NAO_HABILITADA', 'PORTAS_FORA_DO_PAPEL', 'PORTAS_SIMULADAS_FORA_DE_TESTE', 'SDK_NAO_APROVADO', 'UMASK_PERMISSIVA', 'USUARIO_NAO_IDENTIFICADO', 'USUARIO_ROOT',
]);
const SDKS = Object.freeze(['APROVADO', 'NAO_APROVADO', 'SIMULADO']);
const ORIGENS_DE_CHAVES = Object.freeze(['OPERACIONAL', 'TESTE_CONTROLADO', 'AUSENTE']);
const DESTINOS_LOCAIS = Object.freeze(['AUTORIZADO', 'NAO_AUTORIZADO', 'NAO_APLICA']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('entrada do portão do executor inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const chavesDe = (o) => Reflect.ownKeys(o);

function validarEntrada(e) {
  if (!ehObjeto(e)) throw configuracaoInvalida();
  const obrigatorias = ['modo', 'acao', 'ambiente', 'destinoId', 'confirmacao', 'fatos'];
  const proprias = chavesDe(e);
  if (!proprias.every((k) => obrigatorias.includes(k) || k === 'registro') || !obrigatorias.every((k) => proprias.includes(k))) throw configuracaoInvalida();
  if (typeof e.modo !== 'string' || typeof e.acao !== 'string' || typeof e.ambiente !== 'string' || typeof e.destinoId !== 'string' || (e.confirmacao !== null && typeof e.confirmacao !== 'string')) throw configuracaoInvalida();
  const f = e.fatos;
  if (!ehObjeto(f)) throw configuracaoInvalida();
  const fatos = ['sdk', 'chavesOrigem', 'destinoLocal', 'uid', 'umask'];
  if (chavesDe(f).length !== fatos.length || !fatos.every((k) => chavesDe(f).includes(k))) throw configuracaoInvalida();
  if (!SDKS.includes(f.sdk) || !ORIGENS_DE_CHAVES.includes(f.chavesOrigem) || !DESTINOS_LOCAIS.includes(f.destinoLocal)) throw configuracaoInvalida();
  if (f.uid !== null && !(Number.isInteger(f.uid) && f.uid >= 0)) throw configuracaoInvalida();
  if (f.umask !== null && !(Number.isInteger(f.umask) && f.umask >= 0 && f.umask <= 0o777)) throw configuracaoInvalida();
}

function avaliarPortoes(entrada) {
  validarEntrada(entrada);
  const { modo, acao, ambiente, destinoId, confirmacao, fatos } = entrada;
  const bloqueios = new Set();
  const modoOk = MODOS.includes(modo);
  const acaoOk = ACOES.includes(acao);
  if (!modoOk) bloqueios.add('MODO_INVALIDO');
  if (!acaoOk) bloqueios.add('ACAO_INVALIDA');
  if (!AMBIENTES.includes(ambiente)) bloqueios.add('AMBIENTE_INVALIDO');
  if (modoOk && acaoOk && confirmacao !== FRASES[modo][acao]) bloqueios.add('CONFIRMACAO_AUSENTE_OU_INVALIDA');
  if (modo === 'OPERACAO' && !OPERACAO_HABILITADA) bloqueios.add('OPERACAO_NAO_HABILITADA');
  if (modo === 'ENSAIO' && ambiente === 'PRODUCAO') bloqueios.add('ENSAIO_EM_PRODUCAO_PROIBIDO');
  if (fatos.uid === 0) bloqueios.add('USUARIO_ROOT');
  else if (fatos.uid === null) bloqueios.add('USUARIO_NAO_IDENTIFICADO');
  if (fatos.umask === null || (fatos.umask & 0o077) !== 0o077) bloqueios.add('UMASK_PERMISSIVA');

  const teste = ambienteDeTeste();
  const achado = Object.hasOwn(entrada, 'registro') ? localizarArmazenamentoDuravel(destinoId, ambiente, entrada.registro) : localizarArmazenamentoDuravel(destinoId, ambiente);
  if (!achado.encontrada || (modo === 'OPERACAO' && achado.origem !== 'OPERACIONAL')) bloqueios.add('DESTINO_DURAVEL_NAO_APROVADO');

  const provedoresOperacionais = PROVEDORES_OPERACIONAIS_APROVADOS.length > 0 && PROVEDORES_DE_CIFRA_APROVADOS.length > 0;
  if (fatos.chavesOrigem === 'AUSENTE') bloqueios.add('FONTE_DE_CHAVES_NAO_APROVADA');
  else if (fatos.chavesOrigem === 'OPERACIONAL' && !provedoresOperacionais) bloqueios.add('FONTE_DE_CHAVES_NAO_APROVADA');
  else if (fatos.chavesOrigem === 'TESTE_CONTROLADO' && (!teste || modo === 'OPERACAO')) bloqueios.add('FONTE_DE_CHAVES_NAO_APROVADA');

  if (fatos.sdk === 'NAO_APROVADO') bloqueios.add('SDK_NAO_APROVADO');
  if (fatos.sdk === 'SIMULADO' && (!teste || modo === 'OPERACAO')) bloqueios.add('PORTAS_SIMULADAS_FORA_DE_TESTE');

  if ((acao === 'BACKUP' || acao === 'RESTAURACAO') && fatos.destinoLocal !== 'AUTORIZADO') bloqueios.add('DESTINO_LOCAL_NAO_AUTORIZADO');

  return Object.freeze({ permitido: bloqueios.size === 0, bloqueios: Object.freeze([...bloqueios].sort()) });
}

module.exports = { avaliarPortoes, OPERACAO_HABILITADA, MODOS, ACOES, AMBIENTES, FRASES, BLOQUEIOS };
