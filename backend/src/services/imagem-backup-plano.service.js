'use strict';

const { chaveDe } = require('../storage/armazenamento-imagens');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-PLANO-IMAGENS-1): PLANO DE ARQUIVOS do backup. Função PURA: não acessa banco, disco, rede nem processo, não recalcula
 * hash algum e não mutiliza a entrada (aceita as listas congeladas que o snapshot entrega). Contrato PROVISÓRIO; nada aqui comprova a existência ou a integridade física dos arquivos
 * nem faz o snapshot do PostgreSQL proteger o filesystem: os SHA-256 são DECLARAÇÕES do banco e serão conferidos contra os bytes na cópia verificada (etapa futura).
 *
 * `planejarArquivos({ padrao, empresa })` -> [{ chave, sha256 }], em ordem crescente de `chave` (comparação de texto simples), independente da ordem de entrada, sem nenhum outro campo.
 * Uma linha por imagem física (`imagens_padrao` tem UNIQUE (sha256); `imagens_empresa` tem PK e UNIQUE (empresa_id, sha256); o snapshot lê cada tabela uma vez, sem junção): chave repetida
 * é inconsistência real, nunca reutilização legítima (a reutilização de uma imagem por vários materiais é por chave estrangeira, e não por linhas repetidas).
 *   - PADRÃO: mestre (hash = `sha256`, que também é o diretório; extensão pelo `formato`), exibição `.webp` SOMENTE se hash e bytes vierem juntos (nulos juntos = não gerada) e miniatura
 *     `.webp` obrigatória (hash `sha256Miniatura`);
 *   - EMPRESA: as TRÊS variantes são obrigatórias; o `sha256` só compõe o DIRETÓRIO da chave, e o conteúdo da mestre é `sha256Mestre` (nunca confundir), `sha256Exibicao`, `sha256Miniatura`.
 *   As chaves vêm de `chaveDe` (única fonte do formato). Qualquer registro inconsistente, chave repetida (mesmo com hash idêntico, porque o avaliador recusaria a lista) ou entrada fora do
 *   formato LANÇA Error com `code: 'PLANO_INVALIDO'` e mensagem fixa (sem valores recebidos, sem mensagem de dependência), sem resultado parcial: o snapshot trata isso como PLANO_INVALIDO.
 * Regra de validação espelha a do verificador de armazenamento (`planejarPadrao`/`planejarEmpresa`, internos): OPORTUNIDADE FUTURA de consolidar exportando-os, sem autorização nesta etapa.
 */

const FORMATOS = Object.freeze(['PNG', 'JPEG', 'WEBP']);
const SHA256 = /^[0-9a-f]{64}$/;
const INT_MAXIMO = 2147483647;

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const hexValido = (valor) => typeof valor === 'string' && SHA256.test(valor);
const bytesValidos = (valor) => Number.isInteger(valor) && valor > 0 && valor <= INT_MAXIMO;
const ausente = (valor) => valor === null || valor === undefined;

function invalido() {
  const falha = new Error('plano de backup inválido');
  falha.code = 'PLANO_INVALIDO';
  return falha;
}
const exigir = (condicao) => { if (!condicao) throw invalido(); };

function arquivosDoPadrao(linha) {
  exigir(ehObjeto(linha));
  const { sha256, formato, bytesMestre, sha256Miniatura, bytesMiniatura, sha256Exibicao, bytesExibicao } = linha;
  exigir(hexValido(sha256) && FORMATOS.includes(formato) && bytesValidos(bytesMestre));
  exigir(hexValido(sha256Miniatura) && bytesValidos(bytesMiniatura));
  const temHash = !ausente(sha256Exibicao);
  exigir(temHash === !ausente(bytesExibicao));
  if (temHash) exigir(hexValido(sha256Exibicao) && bytesValidos(bytesExibicao));
  const base = { escopo: 'PADRAO', sha256 };
  const itens = [{ chave: chaveDe({ ...base, variante: 'mestre', formato }), sha256 }];
  if (temHash) itens.push({ chave: chaveDe({ ...base, variante: 'exibicao', formato: 'WEBP' }), sha256: sha256Exibicao });
  itens.push({ chave: chaveDe({ ...base, variante: 'miniatura', formato: 'WEBP' }), sha256: sha256Miniatura });
  return itens;
}

function arquivosDaEmpresa(linha) {
  exigir(ehObjeto(linha));
  const { empresaId, sha256, sha256Mestre, sha256Exibicao, sha256Miniatura, formato, bytesMestre, bytesExibicao, bytesMiniatura } = linha;
  exigir(Number.isInteger(empresaId) && empresaId >= 1 && empresaId <= INT_MAXIMO);
  exigir(hexValido(sha256) && FORMATOS.includes(formato));
  exigir(hexValido(sha256Mestre) && bytesValidos(bytesMestre));
  exigir(hexValido(sha256Exibicao) && bytesValidos(bytesExibicao));
  exigir(hexValido(sha256Miniatura) && bytesValidos(bytesMiniatura));
  // `sha256` compõe só o diretório da chave; o hash do CONTEÚDO de cada variante é o próprio campo da variante.
  const base = { escopo: 'EMPRESA', empresaId, sha256 };
  return [
    { chave: chaveDe({ ...base, variante: 'mestre', formato }), sha256: sha256Mestre },
    { chave: chaveDe({ ...base, variante: 'exibicao', formato: 'WEBP' }), sha256: sha256Exibicao },
    { chave: chaveDe({ ...base, variante: 'miniatura', formato: 'WEBP' }), sha256: sha256Miniatura },
  ];
}

function planejarArquivos(registros) {
  try {
    exigir(ehObjeto(registros));
    const chaves = Reflect.ownKeys(registros);
    exigir(chaves.length === 2 && chaves.every((chave) => chave === 'padrao' || chave === 'empresa'));
    const { padrao, empresa } = registros;
    exigir(Array.isArray(padrao) && Array.isArray(empresa));

    const porChave = new Map();
    const registrar = (itens) => {
      for (const item of itens) {
        exigir(!porChave.has(item.chave)); // chave repetida (mesmo com hash idêntico) é inconsistência real
        porChave.set(item.chave, item.sha256);
      }
    };
    for (const linha of padrao) registrar(arquivosDoPadrao(linha));
    for (const linha of empresa) registrar(arquivosDaEmpresa(linha));

    return [...porChave.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((chave) => ({ chave, sha256: porChave.get(chave) }));
  } catch {
    // Qualquer falha (inclusive de `chaveDe` ou de um getter hostil) vira o mesmo erro fixo: nunca valor, caminho nem mensagem de dependência.
    throw invalido();
  }
}

module.exports = { planejarArquivos };
