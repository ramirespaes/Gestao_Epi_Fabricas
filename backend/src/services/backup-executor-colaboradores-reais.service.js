'use strict';

const { criarBackupDeProducao, criarRestauracaoDeProducao } = require('./imagem-backup-composicao-producao.service');
const { criarLeitorDePacote } = require('./backup-executor-leitor-pacote.service');
const { criarProducaoL2 } = require('./backup-executor-producao-l2.service');
const { criarRestauradorL2 } = require('./backup-executor-restaurador-l2.service');
const { criarCoordenacaoDoExecutor } = require('./backup-executor-compositor.service');
const { criarAuditoriaDoExecutor } = require('./backup-executor-auditoria.service');
const { ACOES } = require('./backup-executor-politica.service');

/**
 * D-ORF-6, Rodada B (B3A): MONTADOR DAS PEÇAS REAIS do executor. Compõe, na ordem certa e só por INJEÇÃO, as sete fábricas já aprovadas (produção e restauração de produção, leitor de pacote, adaptadores L2 de produção e de restauração,
 * coordenação por advisory locks e auditoria) e devolve as peças que o compositor espera. Não lê ambiente, arquivo ou rede, não abre conexão, não cria processo, não escreve nada e não decide política: as travas, as listas e o validador de destinos
 * continuam onde estão. Valores e configurações nunca entram em um código de erro.
 *
 * `montarColaboradoresReais({ acao, executorDeCoordenacao, executorDeAuditoria, registrarEventoSistema, relogio, backup?, restauracao?, fabricas? })` -> peças congeladas:
 *  - sempre `coordenacao` (advisory locks no `executorDeCoordenacao`, que tem de ser uma SESSÃO dedicada, distinta do `executorDeAuditoria`) e `auditoria` (um evento por execução em `logs_auditoria_plataforma`);
 *  - BACKUP (exige `backup`, proíbe `restauracao`): `producao`. `backup = { composicao, catalogoAtual?, tamanhoMaximo? }`, onde `composicao` é a configuração de `criarBackupDeProducao`. A raiz de publicados e a fonte de chaves do leitor de pacote são DERIVADAS
 *    dessa configuração (nunca informadas à parte), de modo que o leitor lê exatamente onde a composição publica e autentica com as mesmas chaves;
 *  - RESTAURACAO (exige `restauracao`, proíbe `backup`): `restaurador`. `restauracao = { composicao, raizAutorizada, destino, imagens, maxBytesPorArquivo }`, com `composicao` a configuração de `criarRestauracaoDeProducao`;
 *  - VERIFICACAO_DESTINO (proíbe os dois): só `coordenacao` e `auditoria`.
 * `fabricas` (opcional, para teste) troca qualquer uma das sete fábricas por uma função equivalente. Falha fechada: configuração fora da forma é `COLABORADORES_REAIS_CONFIGURACAO_INVALIDA`; fábrica que recusa ou lança é
 * `COLABORADORES_REAIS_MONTAGEM_FALHOU`, sem repassar mensagem nem causa.
 * LIMITE: a produção real de ponta a ponta usa a composição de produção, que inventaria o esquema `public` do banco; este montador não muda isso (ver o relatório do B3A).
 */

const FABRICAS_REAIS = Object.freeze({
  criarBackupDeProducao, criarRestauracaoDeProducao, criarLeitorDePacote, criarProducaoL2, criarRestauradorL2, criarCoordenacaoDoExecutor, criarAuditoriaDoExecutor,
});
const NOMES_DAS_FABRICAS = Object.freeze(Object.keys(FABRICAS_REAIS));
const OPCOES = Object.freeze(['acao', 'executorDeCoordenacao', 'executorDeAuditoria', 'registrarEventoSistema', 'relogio', 'backup', 'restauracao', 'fabricas']);
const MENSAGENS = Object.freeze({
  COLABORADORES_REAIS_CONFIGURACAO_INVALIDA: 'configuração do montador das peças reais inválida',
  COLABORADORES_REAIS_MONTAGEM_FALHOU: 'montagem das peças reais falhou',
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const erro = (code) => Object.assign(new TypeError(MENSAGENS[code]), { code });
const invalida = () => erro('COLABORADORES_REAIS_CONFIGURACAO_INVALIDA');
const soChaves = (o, permitidas, obrigatorias = permitidas) => ehObjeto(o) && Reflect.ownKeys(o).every((k) => permitidas.includes(k)) && obrigatorias.every((k) => Reflect.ownKeys(o).includes(k));
const comQuery = (o) => ehObjeto(o) && typeof o.query === 'function';

function montarColaboradoresReais(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k))) throw invalida();
  const { acao, executorDeCoordenacao, executorDeAuditoria, registrarEventoSistema, relogio, backup, restauracao } = opcoes;
  if (typeof acao !== 'string' || !ACOES.includes(acao) || !comQuery(executorDeCoordenacao) || !comQuery(executorDeAuditoria) || executorDeCoordenacao === executorDeAuditoria
    || typeof registrarEventoSistema !== 'function' || typeof relogio !== 'function') throw invalida();
  if (opcoes.fabricas !== undefined && !(soChaves(opcoes.fabricas, NOMES_DAS_FABRICAS, []) && Reflect.ownKeys(opcoes.fabricas).every((k) => typeof opcoes.fabricas[k] === 'function'))) throw invalida();
  const f = { ...FABRICAS_REAIS, ...(opcoes.fabricas ?? {}) };

  if ((acao === 'BACKUP') !== (backup !== undefined) || (acao === 'RESTAURACAO') !== (restauracao !== undefined)) throw invalida();
  if (acao === 'BACKUP') {
    if (!soChaves(backup, ['composicao', 'catalogoAtual', 'tamanhoMaximo'], ['composicao']) || !ehObjeto(backup.composicao)) throw invalida();
    const { armazenamento, chaves } = backup.composicao;
    if (!ehObjeto(armazenamento) || typeof armazenamento.publicados !== 'string' || !ehObjeto(chaves) || !('fonteDeChaves' in chaves)) throw invalida();
  }
  if (acao === 'RESTAURACAO') {
    if (!soChaves(restauracao, ['composicao', 'raizAutorizada', 'destino', 'imagens', 'maxBytesPorArquivo']) || !ehObjeto(restauracao.composicao)) throw invalida();
  }

  try {
    const pecas = {
      coordenacao: f.criarCoordenacaoDoExecutor({ executorDeBanco: executorDeCoordenacao }),
      auditoria: f.criarAuditoriaDoExecutor({ executorDeBanco: executorDeAuditoria, registrarEventoSistema }),
    };
    if (acao === 'BACKUP') {
      const raizPublicados = backup.composicao.armazenamento.publicados;
      const composicao = f.criarBackupDeProducao(backup.composicao);
      const leitor = f.criarLeitorDePacote({
        fonteDeChaves: backup.composicao.chaves.fonteDeChaves,
        raizPublicados,
        ...(backup.catalogoAtual === undefined ? {} : { catalogoAtual: backup.catalogoAtual }),
        ...(backup.tamanhoMaximo === undefined ? {} : { tamanhoMaximo: backup.tamanhoMaximo }),
      });
      pecas.producao = f.criarProducaoL2({ composicao, raizPublicados, lerPacote: leitor.lerPacote });
    } else if (acao === 'RESTAURACAO') {
      const { raizAutorizada, destino, imagens, maxBytesPorArquivo } = restauracao;
      pecas.restaurador = f.criarRestauradorL2({ restauracao: f.criarRestauracaoDeProducao(restauracao.composicao), raizAutorizada, destino, imagens, maxBytesPorArquivo, relogio });
    }
    return Object.freeze(pecas);
  } catch {
    throw erro('COLABORADORES_REAIS_MONTAGEM_FALHOU');
  }
}

module.exports = { montarColaboradoresReais };
