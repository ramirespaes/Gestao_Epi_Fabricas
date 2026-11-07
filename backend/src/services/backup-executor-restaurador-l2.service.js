'use strict';

const path = require('node:path');

/**
 * D-ORF-6, L1 (Bloco B): ADAPTADOR `restaurador` (layout 2) do executor operacional. Liga a porta `restaurador.restaurar({ pacote, lido })` à composição de restauração JÁ APROVADA (`criarRestauracaoDeProducao`), que contém a supervisão D-LIG-1
 * (controle de processo próprio da restauração, política de destino imposta pelo lançador, destino novo). Este módulo NÃO cria processo, NÃO escreve nem remove arquivo e NÃO lê ambiente: tudo chega por injeção.
 *
 * `criarRestauradorL2({ restauracao, raizAutorizada, destino, imagens, maxBytesPorArquivo, relogio })` -> `{ restaurar({ pacote, lido }) }`.
 *  - `pacote` precisa estar DIRETAMENTE em `raizAutorizada` (mesma raiz da publicação); `destino` é o destino NOVO do banco e `imagens` { raiz, nome } o destino NOVO das imagens, ambos definidos pelo chamador, nunca pelo pacote;
 *  - sucesso só com resultado do layout 2 com banco restaurado, esquema IGUAL e veredito INTEGRO; devolve `{ ok: true, passos, restauracao }` no formato que a recuperação do executor consome (os cinco passos finais do DR);
 *  - qualquer outra coisa ou erro vira `{ ok: false, codigo }` com código fixo; nunca lança nem repassa mensagem, caminho ou causa.
 * LIMITE: a composição devolve um resultado único; os cinco passos são derivados dele com os instantes de início e fim da chamada (BANCO ocupa o intervalo medido, os demais têm duração zero). Não há tempo por subpasso medido aqui.
 * Nunca afirma `restauracaoReal` nem `recuperavelEmProducao`.
 */

const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('adaptador de restauração inválido'), { code: 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA' });
const recusa = (codigo) => Object.freeze({ ok: false, codigo });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.endsWith('/') && !c.includes('\0');
const iso = (ms) => new Date(ms).toISOString();

function criarRestauradorL2(opcoes) {
  const chaves = ['restauracao', 'raizAutorizada', 'destino', 'imagens', 'maxBytesPorArquivo', 'relogio'];
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => chaves.includes(k)) || !chaves.every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida();
  const { restauracao, raizAutorizada, destino, imagens, maxBytesPorArquivo, relogio } = opcoes;
  if (!ehObjeto(restauracao) || typeof restauracao.restaurar !== 'function' || !caminhoCanonico(raizAutorizada) || !ehObjeto(destino) || typeof relogio !== 'function') throw configuracaoInvalida();
  if (!ehObjeto(imagens) || !caminhoCanonico(imagens.raiz) || typeof imagens.nome !== 'string' || !NOME.test(imagens.nome) || !Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo < 1) throw configuracaoInvalida();
  const alvoImagens = Object.freeze({ raiz: imagens.raiz, nome: imagens.nome });

  async function restaurar(pedido) {
    if (!ehObjeto(pedido) || !Reflect.ownKeys(pedido).every((k) => k === 'pacote' || k === 'lido') || !caminhoCanonico(pedido.pacote)) return recusa('RESTAURADOR_PEDIDO_INVALIDO');
    if (path.dirname(pedido.pacote) !== raizAutorizada) return recusa('RESTAURADOR_PACOTE_FORA_DA_RAIZ');
    const nome = path.basename(pedido.pacote);
    if (!NOME.test(nome)) return recusa('RESTAURADOR_PEDIDO_INVALIDO');
    let inicio;
    try { inicio = relogio(); if (!Number.isSafeInteger(inicio)) throw new Error(); } catch { return recusa('RESTAURADOR_RELOGIO_INVALIDO'); }
    let composto;
    try {
      composto = await restauracao.restaurar({ raizAutorizada, nome, imagens: alvoImagens, destino, layoutMinimo: 2, maxBytesPorArquivo });
    } catch { return recusa('RESTAURADOR_COMPOSICAO_FALHOU'); }
    let fim;
    try { fim = relogio(); if (!Number.isSafeInteger(fim) || fim < inicio) throw new Error(); } catch { return recusa('RESTAURADOR_RELOGIO_INVALIDO'); }
    const r = ehObjeto(composto) ? composto.restauracao : undefined;
    if (!ehObjeto(r) || r.layout !== 2) return recusa('RESTAURADOR_RESULTADO_INVALIDO');
    if (r.ok !== true) return recusa('RESTAURADOR_RESTAURACAO_FALHOU');
    if (!ehObjeto(r.banco) || r.banco.ok !== true) return recusa('RESTAURADOR_BANCO_NAO_RESTAURADO');
    if (!ehObjeto(r.esquema) || r.esquema.relacao !== 'IGUAL') return recusa('RESTAURADOR_ESQUEMA_DIVERGENTE');
    if (!ehObjeto(r.veredito) || r.veredito.classe !== 'INTEGRO' || r.veredito.recuperavelEmProducao === true) return recusa('RESTAURADOR_VEREDITO_NAO_INTEGRO');
    const a = iso(inicio);
    const b = iso(fim);
    const passos = ['BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO'].map((id, i) => Object.freeze({ id, ok: true, inicioEm: i === 0 ? a : b, fimEm: b }));
    return Object.freeze({ ok: true, passos: Object.freeze(passos), restauracao: r });
  }

  return Object.freeze({ restaurar });
}

module.exports = { criarRestauradorL2 };
