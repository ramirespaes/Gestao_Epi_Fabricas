'use strict';

/**
 * Interface de coordenação com operações do D-ORF-6 (backup e restauração).
 *
 * IMPORTANTE: nenhuma trava do D-ORF-6 foi homologada. Este módulo define só o
 * contrato que um futuro provedor deverá cumprir e a política do instalador
 * enquanto ele não existe: sem confirmação, o backend fica bloqueado, e um
 * atestado humano NÃO o libera (não impede um backup concorrente). Frontend
 * estático não depende de coordenação.
 *
 * Estado informado por um provedor:
 *   { situacao: 'LIVRE' | 'OCUPADO' | 'DESCONHECIDO', origem, consultadoEm (ISO), detalhe? }
 * LIVRE só vale com origem declarada e consulta recente; qualquer outra forma
 * vale como DESCONHECIDO.
 */

const SITUACOES = new Set(['LIVRE', 'OCUPADO', 'DESCONHECIDO']);
const IDADE_PADRAO_MS = 5 * 60 * 1000;
const TOLERANCIA_FUTURO_MS = 60 * 1000;

async function consultaPadrao() {
  return { situacao: 'DESCONHECIDO', origem: 'nenhuma trava do D-ORF-6 homologada', consultadoEm: new Date().toISOString() };
}

// Texto sem conteúdo visível (inclui espaços Unicode e caracteres de largura zero).
const emBranco = (s) => typeof s !== 'string' || /^[\s­​-‍⁠﻿]*$/.test(s);
const MENCAO_A_OCUPACAO = /ocupad/i;

const PROFUNDIDADE_MAXIMA = 8;
const textoMencionaOcupacao = (s) => MENCAO_A_OCUPACAO.test(s.normalize('NFKC').replace(/[\s­​-‍⁠﻿]/g, ''));

// Qualquer conteúdo de um valor (texto, itens, campos e chaves) que mencione ocupação.
function contemOcupacao(valor, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAXIMA) return true; // estrutura profunda demais não é confiável: trata como ocupado
  if (typeof valor === 'string') return textoMencionaOcupacao(valor);
  if (Array.isArray(valor)) return valor.some((v) => contemOcupacao(v, profundidade + 1));
  if (valor !== null && typeof valor === 'object') return Object.entries(valor).some(([k, v]) => textoMencionaOcupacao(k) || contemOcupacao(v, profundidade + 1));
  return false;
}
// Onde um provedor pode declarar ocupação: texto ou lista soltos, e o campo "situacao" em qualquer profundidade,
// seja qual for seu tipo. Texto de outros campos (origem, detalhe) não conta, para não bloquear um LIVRE legítimo.
function declaraOcupado(estado, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAXIMA) return true;
  if (typeof estado === 'string') return textoMencionaOcupacao(estado);
  if (Array.isArray(estado)) return estado.some((v) => declaraOcupado(v, profundidade + 1));
  if (estado !== null && typeof estado === 'object') {
    return Object.entries(estado).some(([chave, v]) => (chave.trim().toLowerCase() === 'situacao' ? contemOcupacao(v, profundidade + 1) : (v !== null && typeof v === 'object' && declaraOcupado(v, profundidade + 1))));
  }
  return false;
}

function normalizar(estado, agora, idadeMaximaMs) {
  const desconhecido = (origem) => ({ situacao: 'DESCONHECIDO', origem });
  // OCUPADO nunca é rebaixado por forma inválida: qualquer estado que declare ocupação bloqueia.
  if (declaraOcupado(estado)) {
    const origem = estado !== null && typeof estado === 'object' && !emBranco(estado.origem) ? estado.origem : 'origem não informada';
    return { situacao: 'OCUPADO', origem, detalhe: estado !== null && typeof estado === 'object' && typeof estado.detalhe === 'string' ? estado.detalhe : undefined };
  }
  if (estado === null || typeof estado !== 'object' || Array.isArray(estado)) return desconhecido('estado de coordenação ausente ou malformado');
  if (!SITUACOES.has(estado.situacao) || emBranco(estado.origem)) return desconhecido('estado de coordenação malformado');
  if (estado.situacao === 'LIVRE') {
    const consultado = typeof estado.consultadoEm === 'string' ? Date.parse(estado.consultadoEm) : NaN;
    if (Number.isNaN(consultado) || consultado > agora + TOLERANCIA_FUTURO_MS || agora - consultado > idadeMaximaMs) {
      return desconhecido(`${estado.origem}: consulta sem horário válido ou antiga`);
    }
  }
  return { situacao: estado.situacao, origem: estado.origem, detalhe: estado.detalhe };
}

function avaliarCoordenacao({ tipo, estado, atestado, agora = Date.now(), idadeMaximaMs = IDADE_PADRAO_MS } = {}) {
  if (tipo !== 'backend') return { ok: true, situacao: 'NAO_APLICAVEL', atestadoManual: false };
  const e = normalizar(estado, agora, idadeMaximaMs);
  if (e.situacao === 'LIVRE') return { ok: true, situacao: 'LIVRE', origem: e.origem, atestadoManual: false };
  if (e.situacao === 'OCUPADO') {
    return {
      ok: false, situacao: 'OCUPADO', origem: e.origem, atestadoManual: false,
      bloqueio: { codigo: 'OPERACAO_EM_CURSO', mensagem: `operação em curso (${e.origem})${e.detalhe ? `: ${e.detalhe}` : ''}; o atestado manual não substitui essa trava` },
    };
  }
  // Um atestado humano não é exclusão: não impede que um backup comece durante a operação. O parâmetro é aceito só
  // para compatibilidade de chamada e nunca libera o backend; só uma coordenação confirmada (LIVRE, recente, de
  // provedor real) libera, e nenhuma trava do D-ORF-6 foi homologada.
  void atestado;
  return {
    ok: false, situacao: 'DESCONHECIDO', origem: e.origem, atestadoManual: false,
    bloqueio: { codigo: 'COORDENACAO_NAO_CONFIRMADA', mensagem: `não há confirmação de que backup ou restauração estão parados (${e.origem}); o atestado manual não substitui uma coordenação homologada com o D-ORF-6` },
  };
}

// Evidência da leitura que produziu um estado: acompanha o próprio objeto devolvido por aquela consulta, numa
// propriedade não enumerável cuja chave é um Symbol deste módulo. Nada é guardado no provedor, então duas operações que
// compartilham o mesmo provedor nunca trocam evidências entre si.
const EVIDENCIA_DA_CONSULTA = Symbol('evidenciaDaConsulta');
function anexarEvidencia(estado, evidencia) {
  if (estado !== null && typeof estado === 'object') Object.defineProperty(estado, EVIDENCIA_DA_CONSULTA, { value: Object.freeze({ ...evidencia }), enumerable: false });
  return estado;
}
const evidenciaDe = (estado) => (estado !== null && typeof estado === 'object' ? estado[EVIDENCIA_DA_CONSULTA] : undefined);

// Provedores aceitos como trava HOMOLOGADA com o D-ORF-6. Em produção esta lista é vazia e não há como acrescentar:
// nenhuma trava foi homologada, então o backend não é trocado, reiniciado nem revertido por nenhuma interface.
// Um arquivo de coordenação, um atestado ou uma função injetada não são exclusão contra um backup concorrente.
// Só testes (NODE_ENV=test) registram um provedor, para exercitar o caminho do backend com estados sintéticos.
const PROVEDORES_HOMOLOGADOS = new WeakSet();
const provedorHomologado = (consultar) => typeof consultar === 'function' && PROVEDORES_HOMOLOGADOS.has(consultar);
function homologarProvedorParaTeste(consultar) {
  if (process.env.NODE_ENV !== 'test') throw new Error('homologarProvedorParaTeste só existe em testes (NODE_ENV=test): nenhuma trava do D-ORF-6 foi homologada');
  PROVEDORES_HOMOLOGADOS.add(consultar);
  return consultar;
}

module.exports = { avaliarCoordenacao, consultaPadrao, SITUACOES, anexarEvidencia, evidenciaDe, provedorHomologado, homologarProvedorParaTeste };
