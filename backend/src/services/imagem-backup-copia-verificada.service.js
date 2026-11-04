'use strict';

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-VINCULO-VERIFICACAO-FISICA-COMPOSICAO-1): ETAPA DE CÓPIA FISICAMENTE VERIFICADA. Interna, criada POR OPERAÇÃO e fornecida à composição
 * no lugar de `copiar`. Contrato PROVISÓRIO; não é entrada operacional pública e não prova validade, publicação ou recuperabilidade.
 *
 * `criarEtapaDeCopiaVerificada({ copiar, verificador })` (ESTRITO; TypeError se inválido; `copiar` e `verificador.verificar` capturados UMA vez, `verificar` com o `this` do verificador) ->
 * { copiarVerificado, obterVerificacao }.
 *   - `copiarVerificado(contexto)`: UMA execução efetiva por instância, reservada de forma SÍNCRONA antes do primeiro await (chamada posterior, simultânea ou não, inclusive depois de falha, recebe a falha
 *     genérica COPIA_FALHOU sem executar nada e sem alterar o diagnóstico). Ordem: (1) `copiar(contexto)` uma vez; (2) só com cópia positiva e completa (`ok === true`, `completo === true`, `falha === null`);
 *     (3) `verificador.verificar({ plano: contexto.plano, copia })`; (4) classifica o retorno; (5) SÓ no sucesso devolve à composição o resultado ORIGINAL da cópia, intacto (o construtor do manifesto exige a
 *     forma exata). Em qualquer outro caso devolve uma falha NO FORMATO DA CÓPIA ({ ok:false, completo:false, arquivos:[], copiados:0, falha:{ codigo, chave:null } }) com um código que a composição já aceita:
 *     INTEGRIDADE_DIVERGENTE só para divergência física COMPROVADA; COPIA_FALHOU para verificação inconclusiva, retorno inválido, exceção e rejeição; para falha da própria cópia, o código original se estiver
 *     no conjunto aceito pela composição, senão COPIA_FALHOU. Nenhum código ou estágio novo.
 *   - `obterVerificacao()`: síncrona; não lê arquivo, não chama a cópia nem o verificador e não altera estado. `null` até existir resultado definitivo; depois um objeto congelado e estável, construído
 *     SÓ de valores primitivos validados (nunca referências do chamador ou do verificador): { classe:'INTEGRA'|'DIVERGENCIA_COMPROVADA'|'INCONCLUSIVA', verificacao } | { classe:'RETORNO_INVALIDO' } |
 *     { classe:'NAO_EXECUTADA' }. As classes nunca se confundem.
 *
 * LIMITES: nada garante que `verificador` esteja ligado ao MESMO destino de `copiar` (VF-09): isso é do adaptador confiável que criar a etapa por operação; a verificação representa os arquivos no instante da
 * releitura (sem imutabilidade, sem excluir TOCTOU, sem trava que proteja todos os escritores); operação pendente indefinidamente não tem cancelamento aqui; o canal lateral só é confiável dentro de um
 * adaptador confiável. Não constrói manifesto, não sela, não publica, não limpa, não finaliza snapshot e não libera trava.
 */

const CODIGOS_DA_COPIA_ACEITOS = new Set(['PLANO_INVALIDO', 'ORIGEM_AUSENTE', 'ORIGEM_INVALIDA', 'DESTINO_INVALIDO', 'DESTINO_EXISTENTE', 'INTEGRIDADE_DIVERGENTE', 'LIMITE_EXCEDIDO', 'LIMITE_TOTAL_EXCEDIDO', 'CANCELADO', 'COPIA_FALHOU']);
const CODIGOS_DE_DIVERGENCIA = new Set(['ARQUIVO_AUSENTE', 'ARQUIVO_INVALIDO', 'TAMANHO_DIVERGENTE', 'SHA256_DIVERGENTE']);
const MOTIVOS_INCONCLUSIVOS = new Set(['ENTRADA_INVALIDA', 'LEITURA_FALHOU', 'CANCELADO']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const inteiroNaoNegativo = (v) => Number.isSafeInteger(v) && v >= 0;

const falhaDeCopia = (codigo) => Object.freeze({ ok: false, completo: false, arquivos: Object.freeze([]), copiados: 0, falha: Object.freeze({ codigo, chave: null }) });
const GENERICA = 'COPIA_FALHOU';

/** Classifica o retorno do verificador SEM confiar em objeto "truthy". Devolve a classe e um diagnóstico novo, congelado, feito só de primitivos validados. */
function classificar(r, chavesDoPlano, tamanhoDoPlano) {
  try {
    if (!ehObjeto(r)) return { classe: 'RETORNO_INVALIDO' };
    if (chavesExatas(r, ['bytes', 'concluida', 'examinados', 'ok'])) {
      const { bytes, concluida, examinados, ok } = r;
      if (concluida === true && ok === true && inteiroNaoNegativo(bytes) && examinados === tamanhoDoPlano) {
        return { classe: 'INTEGRA', verificacao: Object.freeze({ concluida: true, ok: true, examinados, bytes }) };
      }
      return { classe: 'RETORNO_INVALIDO' };
    }
    if (chavesExatas(r, ['concluida', 'divergencias', 'examinados', 'ok'])) {
      const { concluida, divergencias, examinados, ok } = r;
      if (concluida !== true || ok !== false || !inteiroNaoNegativo(examinados) || examinados > tamanhoDoPlano || !Array.isArray(divergencias) || divergencias.length === 0 || divergencias.length > tamanhoDoPlano) {
        return { classe: 'RETORNO_INVALIDO' };
      }
      const vistas = new Set();
      const copia = [];
      for (let i = 0; i < divergencias.length; i += 1) {
        const item = divergencias[i];
        if (!ehObjeto(item) || !chavesExatas(item, ['chave', 'codigo'])) return { classe: 'RETORNO_INVALIDO' };
        const { chave, codigo } = item;
        if (typeof chave !== 'string' || !chavesDoPlano.has(chave) || vistas.has(chave) || typeof codigo !== 'string' || !CODIGOS_DE_DIVERGENCIA.has(codigo)) return { classe: 'RETORNO_INVALIDO' };
        vistas.add(chave);
        copia.push(Object.freeze({ chave, codigo }));
      }
      return { classe: 'DIVERGENCIA_COMPROVADA', verificacao: Object.freeze({ concluida: true, ok: false, examinados, divergencias: Object.freeze(copia) }) };
    }
    if (chavesExatas(r, ['concluida', 'motivo', 'ok'])) {
      const { concluida, motivo, ok } = r;
      if (concluida === false && ok === false && typeof motivo === 'string' && MOTIVOS_INCONCLUSIVOS.has(motivo)) {
        return { classe: 'INCONCLUSIVA', verificacao: Object.freeze({ concluida: false, ok: false, motivo }) };
      }
      return { classe: 'RETORNO_INVALIDO' };
    }
    return { classe: 'RETORNO_INVALIDO' };
  } catch {
    return { classe: 'RETORNO_INVALIDO' }; // leitura que lança (getter ou Proxy hostil): nunca vira sucesso
  }
}

function criarEtapaDeCopiaVerificada(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['copiar', 'verificador'])) throw new TypeError('opções da etapa inválidas');
  let copiar;
  let verificador;
  let verificar;
  try {
    copiar = opcoes.copiar;
    verificador = opcoes.verificador;
    if (!ehObjeto(verificador)) throw new TypeError('verificador inválido');
    verificar = verificador.verificar;
  } catch {
    throw new TypeError('opções da etapa inválidas');
  }
  if (!ehFuncao(copiar) || !ehFuncao(verificar)) throw new TypeError('dependências da etapa inválidas');

  let reservada = false;
  let definitivo = null;

  const concluir = (diagnostico) => { definitivo = Object.freeze(diagnostico); };

  async function copiarVerificado(contexto, execucao) {
    if (reservada) return falhaDeCopia(GENERICA); // reserva síncrona: nada executa de novo
    reservada = true;
    // P3 (opcional): o sinal de cancelamento cooperativo da operação segue à cópia e à verificação; sem ele o comportamento é o histórico
    const sinal = execucao !== null && typeof execucao === 'object' && execucao.sinal !== undefined ? execucao.sinal : undefined;

    // (1) cópia, uma única vez
    let copia;
    try {
      copia = await (sinal === undefined ? copiar(contexto) : copiar(contexto, { sinal }));
    } catch {
      concluir({ classe: 'NAO_EXECUTADA' });
      return falhaDeCopia(GENERICA);
    }

    // (2) só uma cópia positiva e completa chega à verificação física
    let positiva = false;
    let codigoDaCopia = GENERICA;
    try {
      positiva = ehObjeto(copia) && copia.ok === true && copia.completo === true && copia.falha === null;
      if (!positiva && ehObjeto(copia) && copia.ok === false) {
        const falha = copia.falha;
        const codigo = ehObjeto(falha) ? falha.codigo : null;
        if (typeof codigo === 'string' && CODIGOS_DA_COPIA_ACEITOS.has(codigo)) codigoDaCopia = codigo;
      }
    } catch {
      positiva = false;
      codigoDaCopia = GENERICA;
    }
    if (!positiva) {
      concluir({ classe: 'NAO_EXECUTADA' });
      return falhaDeCopia(codigoDaCopia);
    }

    // (3) plano do contexto, lido uma vez
    let plano;
    let chavesDoPlano;
    try {
      plano = contexto.plano;
      if (!Array.isArray(plano)) throw new TypeError('plano inválido');
      chavesDoPlano = new Set();
      for (let i = 0; i < plano.length; i += 1) chavesDoPlano.add(plano[i].chave);
    } catch {
      concluir({ classe: 'INCONCLUSIVA', verificacao: null });
      return falhaDeCopia(GENERICA);
    }

    // (3) verificação física existente
    let retorno;
    try {
      retorno = await verificar.call(verificador, sinal === undefined ? { plano, copia } : { plano, copia, sinal });
    } catch {
      concluir({ classe: 'INCONCLUSIVA', verificacao: null });
      return falhaDeCopia(GENERICA);
    }

    // (4) e (5) classificação e devolução
    const { classe, verificacao } = classificar(retorno, chavesDoPlano, plano.length);
    if (classe === 'INTEGRA') {
      concluir({ classe, verificacao });
      return copia; // o resultado ORIGINAL da cópia, intacto
    }
    if (classe === 'DIVERGENCIA_COMPROVADA') {
      concluir({ classe, verificacao });
      return falhaDeCopia('INTEGRIDADE_DIVERGENTE');
    }
    concluir(classe === 'INCONCLUSIVA' ? { classe, verificacao } : { classe });
    // verificação interrompida por pedido de cancelamento: o código distingue a causa; segue INCONCLUSIVA (nunca integridade comprovada)
    return falhaDeCopia(classe === 'INCONCLUSIVA' && verificacao.motivo === 'CANCELADO' ? 'CANCELADO' : GENERICA);
  }

  function obterVerificacao() {
    return definitivo;
  }

  return Object.freeze({ copiarVerificado, obterVerificacao });
}

module.exports = { criarEtapaDeCopiaVerificada };
