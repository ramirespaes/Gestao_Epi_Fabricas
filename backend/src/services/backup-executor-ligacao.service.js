'use strict';

const { criarPortaDoPublicador, criarPortaDoVerificador, criarPortaDaRestauracao, criarPortaKms } = require('./backup-aws-portas.service');
const { PAPEL_DA_PORTA_KMS } = require('./backup-executor-credenciais.service');
const { MODOS, ACOES } = require('./backup-executor-politica.service');

/**
 * D-ORF-6, L1 (Bloco A): LIGAÇÃO LOCAL do executor, em esqueleto. Reúne, por ação, as portas AWS (cada uma com a credencial do SEU papel), a porta KMS e a auditoria, tudo por injeção
 * (SDK, conjunto de credenciais, auditoria). Não lê ambiente, arquivo nem rede, não cria processo e não decide nada: não liga a operação real (a trava continua só na política) e não
 * substitui a supervisão de processos aprovada, que o Bloco B reutiliza (D-LIG-1).
 *
 * `criarLigacaoDoExecutor({ acao, modo, sdk, regiao, credenciais, auditoria })` -> `{ acao, modo, portas, kms, finalizar({ linha }) }`.
 *  - `portas` traz só as chaves permitidas ao papel da ação (BACKUP: publicador, +verificador se o conjunto de credenciais o tiver, só no ENSAIO; RESTAURACAO: restauracao; VERIFICACAO_DESTINO: verificador).
 *  - `kms` usa a credencial do papel da ação (assunção a confirmar em H9-a); a verificação do destino não usa KMS.
 *  - `finalizar` repassa a linha de evidência à auditoria e devolve `{ gravado, ... }` sem nunca lançar.
 */

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalida = () => Object.assign(new TypeError('ligação do executor inválida'), { code: 'LIGACAO_INVALIDA' });

function criarLigacaoDoExecutor(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['acao', 'modo', 'sdk', 'regiao', 'credenciais', 'auditoria'].includes(k))) throw invalida();
  const { acao, modo, sdk, regiao, credenciais, auditoria } = opcoes;
  if (!ACOES.includes(acao) || !MODOS.includes(modo) || !ehObjeto(credenciais) || typeof credenciais.credenciais !== 'function' || !Array.isArray(credenciais.papeis)
    || !ehObjeto(auditoria) || typeof auditoria.registrar !== 'function') throw invalida();

  const porta = (fabrica, papel) => {
    if (!credenciais.papeis.includes(papel)) throw invalida();
    return fabrica({ sdk, regiao, credenciais: credenciais.credenciais(papel) });
  };
  const portas = {};
  let kms = null;
  if (acao === 'BACKUP') {
    portas.publicador = porta(criarPortaDoPublicador, 'PUBLICADOR');
    if (credenciais.papeis.includes('VERIFICADOR')) {
      if (modo !== 'ENSAIO') throw invalida();
      portas.verificador = porta(criarPortaDoVerificador, 'VERIFICADOR');
    }
  } else if (acao === 'RESTAURACAO') {
    portas.restauracao = porta(criarPortaDaRestauracao, 'RESTAURACAO');
  } else {
    portas.verificador = porta(criarPortaDoVerificador, 'VERIFICADOR');
  }
  if (acao !== 'VERIFICACAO_DESTINO') kms = porta(criarPortaKms, PAPEL_DA_PORTA_KMS[acao]);

  async function finalizar(entrada) {
    return auditoria.registrar(entrada);
  }

  return Object.freeze({ acao, modo, portas: Object.freeze(portas), kms, finalizar });
}

module.exports = { criarLigacaoDoExecutor };
