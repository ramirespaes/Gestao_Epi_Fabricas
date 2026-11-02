'use strict';

const path = require('node:path');
const { construirManifesto } = require('./imagem-backup-manifesto.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-COMPOSICAO-CONJUNTO-1): COMPOSIÇÃO LÓGICA INTERNA do conjunto (cópia verificada -> manifesto -> selagem -> releitura). Contrato PROVISÓRIO.
 * Não é entrada operacional pública: a `area` é fixada por quem compõe (composição confiável), nunca por chamada. Não executa pg_dump, não publica nada e o resultado positivo confirma só a
 * integridade LÓGICA do manifesto selado e relido: não é backup publicado, não prova a integridade física do dump (a evidência vem do chamador) e não é recuperável (isso só uma restauração
 * independente pode comprovar).
 *
 * `criarComposicaoDoConjunto({ copiar, selagem, area, conjuntoId })` (ESTRITO; TypeError se inválido, sem tocar o disco) -> { compor({ contexto, dump }) }. Cada dependência é capturada UMA vez;
 * `selagem.selar` e `selagem.verificar` são chamados com o receiver original. `compor` é ESTRITO (só `contexto` e `dump`, nenhuma outra chave, símbolos inclusive) e valida ANTES de qualquer efeito.
 * Ordem: (1) `copiar(contexto)`; (2) `construirManifesto` (todas as regras de plano, cópia, dump, banco e identidade são DELE); (3) `selagem.selar`; (4) `selagem.verificar` com a identidade
 * construída como `esperado`; (5) conferência final de conjuntoId e SHA-256 verificados contra os esperados. Qualquer falha, exceção, rejeição ou retorno malformado interrompe o avanço.
 * Resultado: sucesso { ok, selado, arquivos, identidade, manifesto } ou falha { ok:false, selado:false, falha:{ estagio, codigo } } (estágios ENTRADA | COPIA | MANIFESTO | SELAGEM | VERIFICACAO);
 * código externo desconhecido vira o genérico do estágio; nenhuma mensagem de dependência, caminho ou valor recebido sai daqui. A composição NÃO remove nada: a limpeza é de quem comprovadamente
 * criou o artefato (a selagem), e o destino de uma cópia parcial não é apagado.
 */

const ESTAGIOS = Object.freeze({ ENTRADA: 'ENTRADA', COPIA: 'COPIA', MANIFESTO: 'MANIFESTO', SELAGEM: 'SELAGEM', VERIFICACAO: 'VERIFICACAO' });
const CODIGOS_DA_COPIA = new Set(['PLANO_INVALIDO', 'ORIGEM_AUSENTE', 'ORIGEM_INVALIDA', 'DESTINO_INVALIDO', 'DESTINO_EXISTENTE', 'INTEGRIDADE_DIVERGENTE', 'LIMITE_EXCEDIDO', 'LIMITE_TOTAL_EXCEDIDO', 'CANCELADO', 'COPIA_FALHOU']);
const CODIGOS_DA_SELAGEM = new Set(['DESTINO_EXISTENTE', 'ESCRITA_FALHOU', 'ESPACO_ESGOTADO', 'AREA_INVALIDA', 'ENTRADA_INVALIDA', 'CANCELADO']);
const CODIGOS_DA_VERIFICACAO = new Set(['MANIFESTO_AUSENTE', 'HASH_AUSENTE', 'HASH_INVALIDO', 'MANIFESTO_INVALIDO', 'ARQUIVO_INVALIDO', 'IDENTIDADE_DIVERGENTE', 'AREA_INVALIDA', 'ENTRADA_INVALIDA', 'LEITURA_FALHOU', 'CANCELADO']);
const CHAVES_DA_CRIACAO = ['copiar', 'selagem', 'area', 'conjuntoId'];
const CHAVES_DO_COMPOR = ['contexto', 'dump'];

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const falha = (estagio, codigo) => Object.freeze({ ok: false, selado: false, falha: Object.freeze({ estagio, codigo }) });

/** Código de falha de um resultado de dependência: só se estiver no conjunto controlado; lido sob proteção. */
function codigoControlado(resultado, permitidos, generico) {
  try {
    const f = ehObjeto(resultado) ? resultado.falha : null;
    const codigo = ehObjeto(f) ? f.codigo : null;
    return typeof codigo === 'string' && permitidos.has(codigo) ? codigo : generico;
  } catch {
    return generico;
  }
}

function criarComposicaoDoConjunto(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, CHAVES_DA_CRIACAO)) throw new TypeError('opções da composição inválidas');
  let copiar;
  let selagem;
  let selar;
  let verificar;
  let autenticar;
  let area;
  let conjuntoId;
  try {
    copiar = opcoes.copiar;
    selagem = opcoes.selagem;
    area = opcoes.area;
    conjuntoId = opcoes.conjuntoId;
    if (!ehObjeto(selagem)) throw new TypeError('selagem inválida');
    selar = selagem.selar;
    verificar = selagem.verificar;
    autenticar = selagem.autenticar === undefined ? null : selagem.autenticar;
    if (autenticar !== null && !ehFuncao(autenticar)) throw new TypeError('autenticador inválido');
  } catch {
    throw new TypeError('opções da composição inválidas');
  }
  if (!ehFuncao(copiar) || !ehFuncao(selar) || !ehFuncao(verificar)) throw new TypeError('dependências da composição inválidas');
  if (typeof conjuntoId !== 'string') throw new TypeError('identificador do conjunto inválido');
  // A área é fixada aqui, por composição confiável. Só a forma é conferida (o resto é da selagem), sem tocar o disco.
  if (typeof area !== 'string' || area === '' || area.includes('\0') || !path.isAbsolute(area) || area.split(/[\\/]/).includes('..')) throw new TypeError('área de preparação inválida');

  async function compor(entrada) {
    let contexto;
    let dump;
    // P3 (opcional): `sinal` = pedido de cancelamento COOPERATIVO. Pontos seguros: entre as fases (depois da cópia, antes da selagem, antes da releitura) e dentro da cópia, da verificação e da selagem. Cancelar não apaga nada: o que já foi copiado ou selado fica como está e NADA é publicado aqui.
    let sinal = null;
    try {
      if (ehObjeto(entrada) && Object.hasOwn(entrada, 'sinal')) {
        if (!chavesExatas(entrada, [...CHAVES_DO_COMPOR, 'sinal']) || !ehObjeto(entrada.sinal) || typeof entrada.sinal.aborted !== 'boolean') return falha(ESTAGIOS.ENTRADA, 'ENTRADA_INVALIDA');
        sinal = entrada.sinal;
      } else if (!ehObjeto(entrada) || !chavesExatas(entrada, CHAVES_DO_COMPOR)) {
        return falha(ESTAGIOS.ENTRADA, 'ENTRADA_INVALIDA');
      }
      contexto = entrada.contexto;
      dump = entrada.dump;
    } catch {
      return falha(ESTAGIOS.ENTRADA, 'ENTRADA_INVALIDA');
    }
    const cancelado = () => sinal !== null && sinal.aborted === true;
    if (cancelado()) return falha(ESTAGIOS.COPIA, 'CANCELADO');

    // 1 — cópia verificada
    let copia;
    try {
      copia = await (sinal === null ? copiar(contexto) : copiar(contexto, { sinal }));
    } catch {
      return falha(ESTAGIOS.COPIA, 'COPIA_FALHOU');
    }
    try {
      if (!ehObjeto(copia)) return falha(ESTAGIOS.COPIA, 'COPIA_FALHOU');
      if (copia.ok !== true) return falha(ESTAGIOS.COPIA, codigoControlado(copia, CODIGOS_DA_COPIA, 'COPIA_FALHOU'));
    } catch {
      return falha(ESTAGIOS.COPIA, 'COPIA_FALHOU');
    }

    // 2 — manifesto (todas as regras de validação são do módulo do manifesto)
    let construido;
    try {
      construido = construirManifesto({ contexto, copia, dump, conjuntoId });
      // Opcional (V2): a selagem pode carregar um autenticador que promove o manifesto V1 já validado ao V2 autenticado (a chave nunca passa por este módulo).
      if (autenticar !== null) construido = autenticar.call(selagem, construido);
    } catch {
      return falha(ESTAGIOS.MANIFESTO, 'MANIFESTO_INVALIDO');
    }
    const esperado = { conjuntoId: construido.identidade.conjuntoId, sha256Manifesto: construido.identidade.sha256Manifesto };

    // 3 — selagem
    if (cancelado()) return falha(ESTAGIOS.SELAGEM, 'CANCELADO');
    try {
      const selado = await selar.call(selagem, sinal === null ? { area, resultado: construido } : { area, resultado: construido, sinal });
      if (!ehObjeto(selado) || selado.ok !== true || selado.selado !== true) return falha(ESTAGIOS.SELAGEM, codigoControlado(selado, CODIGOS_DA_SELAGEM, 'ESCRITA_FALHOU'));
    } catch {
      return falha(ESTAGIOS.SELAGEM, 'ESCRITA_FALHOU');
    }

    // 4 e 5 — releitura e conferência final da identidade e do SHA-256 efetivamente verificados
    if (cancelado()) return falha(ESTAGIOS.VERIFICACAO, 'CANCELADO');
    try {
      const lido = await verificar.call(selagem, { area, esperado: { ...esperado } });
      if (!ehObjeto(lido)) return falha(ESTAGIOS.VERIFICACAO, 'LEITURA_FALHOU');
      if (lido.ok !== true || lido.verificado !== true) return falha(ESTAGIOS.VERIFICACAO, codigoControlado(lido, CODIGOS_DA_VERIFICACAO, 'LEITURA_FALHOU'));
      const identidade = lido.identidade;
      const sha256 = lido.sha256;
      if (!ehObjeto(identidade) || identidade.conjuntoId !== esperado.conjuntoId || identidade.sha256Manifesto !== esperado.sha256Manifesto || sha256 !== esperado.sha256Manifesto) {
        return falha(ESTAGIOS.VERIFICACAO, 'IDENTIDADE_DIVERGENTE');
      }
    } catch {
      return falha(ESTAGIOS.VERIFICACAO, 'LEITURA_FALHOU');
    }

    return Object.freeze({ ok: true, selado: true, arquivos: construido.manifesto.arquivos.length, identidade: construido.identidade, manifesto: construido.manifesto });
  }

  return Object.freeze({ compor });
}

module.exports = { criarComposicaoDoConjunto };
