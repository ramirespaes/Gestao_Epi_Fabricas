'use strict';

const { listarPadrao, listarEmpresa } = require('../repositories/imagem-verificacao.repository');
const { planejarArquivos } = require('./imagem-backup-plano.service');
const { criarCopiaDeImagens } = require('./imagem-backup-copia.service');
const { criarArmazenamentoImagens, chaveDe } = require('../storage/armazenamento-imagens');
const { planejarPacotes, lerReferencias } = require('./backup-fontes-fiscalizacao-plano.service');
const { criarCopiaDePacotes, restaurarPacotes } = require('./backup-fontes-fiscalizacao-arquivos.service');
const R = require('./backup-fontes-regras.service');

/**
 * D-ORF-6, P6: ADAPTADORES POR FONTE (conjunto FECHADO, identificado por `fonteId` e `formatoChaveId` do catálogo — R-6.2). Cada adaptador liga o contrato
 * genérico da composição L2 aos componentes JÁ EXISTENTES da fonte; nenhum adaptador faz E/S própria de escrita: a cópia e a restauração passam pelos
 * escritores aprovados na guarda (`armazenamento-imagens.gravar`, `backup-fontes-fiscalizacao-arquivos`).
 *
 * Contrato: `obterAdaptador(fonteId)` -> `{ id, formatoChaveId, planejar(executor, { tamanhoDaPagina }), copiar({ origem, destinoDir, plano, maxBytesPorArquivo }),
 * restaurar({ origemDir, destinoDir, itens, maxBytesPorArquivo }) }`.
 *  - `planejar` lê SÓ no executor recebido (a conexão já dentro do snapshot `REPEATABLE READ READ ONLY`: R2 11.3 — cada planejador lê no mesmo snapshot, nunca
 *    abre conexão própria) e devolve `{ plano, referencias }`: `plano` na forma que o copiador DA FONTE exige (opaco para a composição); `referencias`
 *    normalizadas `{ chave, sha256, bytes, empresaId|null }` para a consistência cruzada (P7).
 *  - `copiar` devolve o resultado da cópia no formato comum `{ ok, completo, arquivos:[{chave,sha256,bytes}], copiados, falha }`.
 *  - `restaurar` grava em destino NOVO por fonte, conferindo SHA-256 e tamanho de cada arquivo; devolve `{ ok, restaurados, falha }`.
 * Fonte sem adaptador ou formato divergente do catálogo => `ADAPTADOR_INDISPONIVEL` (falha fechada). `postgres-aplicacao` não é adaptador de arquivos: o
 * inventário do P4 é lido pela composição diretamente.
 */

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
function indisponivel(motivo) {
  const e = new Error('adaptador de fonte indisponível');
  e.code = 'ADAPTADOR_INDISPONIVEL';
  e.motivo = motivo;
  return e;
}
const exigirExecutor = (executor) => { if (!ehObjeto(executor) || typeof executor.query !== 'function') throw new TypeError('executor inválido'); };

async function paginar(ler, tamanho) {
  const todos = [];
  let depoisDe = '0';
  for (;;) {
    const pagina = await ler(depoisDe);
    if (!Array.isArray(pagina) || pagina.length > tamanho) throw indisponivel('CONSULTA_INVALIDA');
    todos.push(...pagina);
    if (pagina.length < tamanho) return todos;
    const ultimo = pagina[pagina.length - 1].id;
    if (typeof ultimo !== 'string' || BigInt(ultimo) <= BigInt(depoisDe)) throw indisponivel('CONSULTA_INVALIDA');
    depoisDe = ultimo;
  }
}

/** Referências das imagens com bytes e empresa, pela MESMA regra de chaves do plano (`chaveDe`); nulos de exibição = variante não gerada. */
function referenciasDeImagens({ padrao, empresa }) {
  const saida = [];
  for (const l of padrao) {
    const base = { escopo: 'PADRAO', sha256: l.sha256 };
    saida.push({ chave: chaveDe({ ...base, variante: 'mestre', formato: l.formato }), sha256: l.sha256, bytes: l.bytesMestre, empresaId: null });
    if (l.sha256Exibicao !== null && l.sha256Exibicao !== undefined) saida.push({ chave: chaveDe({ ...base, variante: 'exibicao', formato: 'WEBP' }), sha256: l.sha256Exibicao, bytes: l.bytesExibicao, empresaId: null });
    saida.push({ chave: chaveDe({ ...base, variante: 'miniatura', formato: 'WEBP' }), sha256: l.sha256Miniatura, bytes: l.bytesMiniatura, empresaId: null });
  }
  for (const l of empresa) {
    const empresaId = Number(l.empresaId);
    const base = { escopo: 'EMPRESA', empresaId, sha256: l.sha256 };
    saida.push({ chave: chaveDe({ ...base, variante: 'mestre', formato: l.formato }), sha256: l.sha256Mestre, bytes: l.bytesMestre, empresaId: String(empresaId) });
    saida.push({ chave: chaveDe({ ...base, variante: 'exibicao', formato: 'WEBP' }), sha256: l.sha256Exibicao, bytes: l.bytesExibicao, empresaId: String(empresaId) });
    saida.push({ chave: chaveDe({ ...base, variante: 'miniatura', formato: 'WEBP' }), sha256: l.sha256Miniatura, bytes: l.bytesMiniatura, empresaId: String(empresaId) });
  }
  return saida.sort((a, b) => (a.chave < b.chave ? -1 : 1));
}

const IMAGENS = Object.freeze({
  id: 'imagens',
  formatoChaveId: 'imagem-v1',
  destinoPrecisaExistir: true,
  async planejar(executor, { tamanhoDaPagina = 500 } = {}) {
    exigirExecutor(executor);
    if (!inteiroPositivo(tamanhoDaPagina) || tamanhoDaPagina > 1000) throw new TypeError('tamanho de página inválido');
    const padrao = await paginar((depoisDe) => listarPadrao(executor, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina);
    const empresa = await paginar((depoisDe) => listarEmpresa(executor, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina);
    const plano = planejarArquivos({ padrao, empresa });
    const referencias = referenciasDeImagens({ padrao, empresa });
    if (referencias.length !== plano.length || referencias.some((r, i) => r.chave !== plano[i].chave || r.sha256 !== plano[i].sha256)) throw indisponivel('PLANO_INCOERENTE');
    return Object.freeze({ plano: Object.freeze(plano.map((p) => Object.freeze({ chave: p.chave, sha256: p.sha256 }))), referencias: Object.freeze(referencias.map(Object.freeze)) });
  },
  async copiar({ origem, destinoDir, plano, maxBytesPorArquivo }) {
    const destino = criarArmazenamentoImagens({ diretorio: destinoDir });
    return criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo })({ plano });
  },
  async restaurar({ origemDir, destinoDir, itens, maxBytesPorArquivo }) {
    const origem = criarArmazenamentoImagens({ diretorio: origemDir });
    const destino = criarArmazenamentoImagens({ diretorio: destinoDir });
    let restaurados = 0;
    for (const item of itens) {
      let gravado;
      try {
        const fluxo = await origem.abrir(item.chave);
        gravado = await destino.gravar(item.chave, fluxo, { maxBytes: maxBytesPorArquivo, sha256Esperado: item.sha256 });
      } catch (falha) {
        return Object.freeze({ ok: false, restaurados, falha: Object.freeze({ codigo: falha?.codigo === 'ARQUIVO_AUSENTE' ? 'ARQUIVO_AUSENTE' : 'RESTAURACAO_FALHOU', chave: item.chave }) });
      }
      if (gravado.reaproveitado !== false || gravado.sha256 !== item.sha256 || gravado.bytes !== item.bytes) return Object.freeze({ ok: false, restaurados, falha: Object.freeze({ codigo: 'ARQUIVO_DIVERGENTE', chave: item.chave }) });
      restaurados += 1;
    }
    return Object.freeze({ ok: true, restaurados, falha: null });
  },
});

const FISCALIZACAO = Object.freeze({
  id: 'fiscalizacao-pacotes',
  formatoChaveId: 'fiscalizacao-v1',
  destinoPrecisaExistir: false,
  async planejar(executor, { tamanhoDaPagina = 500 } = {}) {
    exigirExecutor(executor);
    const pacotes = await lerReferencias(executor, { tamanhoDaPagina });
    const plano = planejarPacotes({ pacotes });
    return Object.freeze({
      plano: Object.freeze(plano.map((p) => Object.freeze({ chave: p.chave, sha256: p.sha256, bytes: p.bytes }))),
      referencias: Object.freeze(plano.map((p) => Object.freeze({ chave: p.chave, sha256: p.sha256, bytes: p.bytes, empresaId: p.empresaId }))),
    });
  },
  async copiar({ origem, destinoDir, plano, maxBytesPorArquivo }) {
    return criarCopiaDePacotes({ origem, destino: destinoDir, maxBytesPorArquivo }).copia({ plano });
  },
  async restaurar({ origemDir, destinoDir, itens }) {
    return restaurarPacotes({ origem: origemDir, itens: itens.map((i) => ({ chave: i.chave, sha256: i.sha256, bytes: i.bytes })), destino: destinoDir });
  },
});

const ADAPTADORES = Object.freeze({ [IMAGENS.id]: IMAGENS, [FISCALIZACAO.id]: FISCALIZACAO });
const IDS = Object.freeze(Object.keys(ADAPTADORES).sort());

/** O adaptador só é entregue se o catálogo registrar a fonte como ARQUIVOS PROTEGIDA com o MESMO formato de chave (comportamento identificado, R-6.2/R-6.3). */
function obterAdaptador(fonteId, catalogo) {
  if (typeof fonteId !== 'string' || !Object.hasOwn(ADAPTADORES, fonteId)) throw indisponivel('FONTE_SEM_ADAPTADOR');
  const adaptador = ADAPTADORES[fonteId];
  if (catalogo !== undefined) {
    if (!R.validarCatalogo(catalogo).valido) throw indisponivel('CATALOGO_INVALIDO');
    const fonte = catalogo.fontes.find((f) => f.id === fonteId);
    if (fonte === undefined || fonte.tipo !== 'ARQUIVOS' || fonte.classe !== 'PROTEGIDA' || fonte.chave.formatoChaveId !== adaptador.formatoChaveId) throw indisponivel('FONTE_DIVERGE_DO_CATALOGO');
  }
  return adaptador;
}

module.exports = { obterAdaptador, referenciasDeImagens, IDS_COM_ADAPTADOR: IDS };
