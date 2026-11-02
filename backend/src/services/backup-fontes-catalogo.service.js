'use strict';

const regras = require('./backup-fontes-regras.service');

/**
 * Catálogo oficial de fontes persistentes do backup (D-ORF-6, P1). Lista fechada, em código, selada pelas regras puras.
 * Estados aprovados no P0 (comando de 01/11/2026, decisões DEC-1 a DEC-8 e identificadores P0-CF-1 a P0-CF-3): nenhuma fonte
 * nasce comprovada; registrar não é proteger. Só NOMES de variáveis e de tabelas: nunca valores, caminhos reais ou segredos.
 */

const DOCUMENTO_DO_P0 = 'documentos/D-ORF-6-P0-R2-ADENDO-DECISOES-20261101.md';
const APROVADOR = 'RESPONSAVEL_SAFEWORK';

const ausente = () => ({ estado: 'AUSENTE', modulo: null, teste: null });
const presente = (modulo, teste) => ({ estado: 'PRESENTE', modulo, teste });
const parcial = (modulo, teste) => ({ estado: 'PARCIAL', modulo, teste });
const semComponentes = () => ({ planejador: ausente(), copiador: ausente(), verificador: ausente(), restaurador: ausente() });

const comum = {
  decisaoPendente: null, recomendacao: null, decisaoRef: null, justificativa: null, relevancia: null, persistenciaFisica: null, riscoResidual: null,
  categoriaDeSegredo: null, recuperacao: null, aprovador: APROVADOR, raiz: { variavel: null }, chave: { formatoChaveId: null }, verificadorId: null,
  escopo: { tipo: 'GLOBAL', regraEmpresa: null }, referencias: [], remocao: { fisica: 'NENHUMA', janela: 'NAO_APLICAVEL' },
  componentes: semComponentes(), reconstrucao: null, promocao: null, suspensao: null, versaoContrato: 1,
};

const segredo = (id, categoriaDeSegredo, justificativa) => ({
  ...comum,
  id,
  tipo: 'ARQUIVOS',
  classe: 'EXCLUIDA',
  decisaoRef: 'P0-CF-2',
  justificativa,
  relevancia: 'POLITICA_SEGURANCA',
  persistenciaFisica: 'DEPENDE_DO_AMBIENTE',
  riscoResidual: 'SEGREDO_FORA_DO_PACOTE_REQUER_CUSTODIA',
  categoriaDeSegredo,
  recuperacao: { procedimento: 'INDEPENDENTE', decisao: 'D-F5' },
  responsavel: 'INFRAESTRUTURA_E_SEGURANCA',
  mutabilidade: 'MUTAVEL',
  sensibilidade: 'SEGREDO',
});

const FONTES = [
  {
    ...comum,
    id: 'imagens',
    tipo: 'ARQUIVOS',
    classe: 'PROTEGIDA',
    responsavel: 'BIBLIOTECA_DE_IMAGENS',
    raiz: { variavel: 'IMAGENS_ARMAZENAMENTO_DIRETORIO' },
    chave: { formatoChaveId: 'imagem-v1' },
    verificadorId: 'imagens-consistencia-v1',
    escopo: { tipo: 'MISTO', regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' },
    referencias: [
      { tabela: 'imagens_padrao', colunas: ['sha256', 'sha256_miniatura', 'sha256_exibicao', 'bytes_mestre', 'bytes_miniatura', 'bytes_exibicao'] },
      { tabela: 'imagens_empresa', colunas: ['empresa_id', 'sha256', 'sha256_mestre', 'sha256_exibicao', 'sha256_miniatura', 'bytes_mestre', 'bytes_exibicao', 'bytes_miniatura', 'estado'] },
    ],
    mutabilidade: 'IMUTAVEL_POR_CONTEUDO',
    sensibilidade: 'INTERNO',
    remocao: { fisica: 'JANELA_LIMPEZA', janela: 'UNICA' },
    // Existência dos módulos, não aprovação: a E4 foi fictícia e com ressalvas (P0-CF-3), por isso promocao fica nula.
    componentes: {
      planejador: presente('src/services/imagem-backup-plano.service.js', 'test/services/imagem-backup-plano.test.js'),
      copiador: presente('src/services/imagem-backup-copia.service.js', 'test/services/imagem-backup-copia.test.js'),
      verificador: presente('src/services/imagem-backup-consistencia-banco.service.js', 'test/services/imagem-backup-sondas-e-quarentena.test.js'),
      restaurador: presente('src/services/imagem-backup-restauracao.service.js', 'test/services/imagem-backup-restauracao-operacoes.test.js'),
    },
  },
  {
    ...comum,
    id: 'postgres-aplicacao',
    tipo: 'POSTGRES',
    classe: 'PROTEGIDA',
    responsavel: 'BANCO_DA_APLICACAO',
    verificadorId: 'postgres-estrutura-v1',
    escopo: { tipo: 'MISTO', regraEmpresa: 'COLUNA_EMPRESA_ID' },
    mutabilidade: 'VERSIONADA',
    sensibilidade: 'PESSOAL',
    // O verificador atual só confere formato e contagem de entradas do sumário (M3 é o P4): PARCIAL por desenho.
    componentes: {
      planejador: presente('src/services/imagem-backup-snapshot.service.js', 'test/services/imagem-backup-snapshot.test.js'),
      copiador: presente('src/services/imagem-backup-pgdump-lancador.service.js', 'test/services/imagem-backup-pgdump-lancador.test.js'),
      verificador: parcial('src/services/imagem-backup-estrutura-lancador.service.js', 'test/services/imagem-backup-estrutura-lancador.test.js'),
      restaurador: presente('src/services/imagem-backup-restauracao-lancador.service.js', 'test/services/imagem-backup-manifesto-v2-integracao.test.js'),
    },
  },
  {
    ...comum,
    id: 'fiscalizacao-pacotes',
    tipo: 'ARQUIVOS',
    classe: null,
    decisaoPendente: 'D-F1',
    recomendacao: 'PROTEGIDA',
    relevancia: 'PERSISTENTE_RELEVANTE',
    persistenciaFisica: 'SIM',
    riscoResidual: 'DADO_PESSOAL',
    responsavel: 'RELATORIO_DE_FISCALIZACAO',
    raiz: { variavel: 'FISCALIZACAO_ARMAZENAMENTO_DIRETORIO' },
    escopo: { tipo: 'EMPRESA', regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' },
    referencias: [{ tabela: 'fiscalizacao_pacotes', colunas: ['empresa_id', 'status', 'sha256', 'tamanho_bytes', 'chave_armazenamento'] }],
    mutabilidade: 'IMUTAVEL_POR_CONTEUDO',
    sensibilidade: 'PESSOAL',
    remocao: { fisica: 'SOMENTE_NAO_REFERENCIADOS', janela: 'NAO_APLICAVEL' },
  },
  {
    ...comum,
    id: 'email-arquivo',
    tipo: 'ARQUIVOS',
    classe: null,
    decisaoPendente: 'D-F2',
    recomendacao: 'EFEMERA',
    relevancia: 'PERSISTENTE_DE_BAIXO_VALOR',
    persistenciaFisica: 'SIM',
    riscoResidual: 'DADO_PESSOAL_E_TOKENS',
    responsavel: 'EMAIL_TRANSACIONAL',
    raiz: { variavel: 'EMAIL_ARQUIVO_DIRETORIO' },
    mutabilidade: 'MUTAVEL',
    sensibilidade: 'PESSOAL',
  },
  {
    // Id técnico `janela-escrita` (o adendo a chama "janela de escrita"/CF-1): o nome do módulo da trava não entra aqui porque a
    // proteção PRT-07 do CONS-02 fecha, em src/, a lista de quem pode citá-lo; o catálogo só a descreve como dado.
    ...comum,
    id: 'janela-escrita',
    tipo: 'ARQUIVOS',
    classe: 'EFEMERA',
    decisaoRef: 'P0-CF-1',
    justificativa: 'Arquivo de trava da exclusão mútua backup × limpeza (CONS-02): mecanismo de coordenação, não dado de negócio. Nunca copiado nem restaurado como dado da aplicação; uma trava restaurada de outro hospedeiro bloquearia operações. A trava nunca é removida de dono morto, por desenho.',
    relevancia: 'NAO_PERSISTENTE',
    persistenciaFisica: 'SIM',
    riscoResidual: 'TRAVA_OBSOLETA_BLOQUEIA_OPERACAO',
    responsavel: 'COORDENACAO_DE_ESCRITA_IMAGENS',
    raiz: { variavel: 'IMAGENS_JANELA_ESCRITA_ARQUIVO' },
    mutabilidade: 'MUTAVEL',
    sensibilidade: 'INTERNO',
  },
  segredo('segredos-credenciais', 'CREDENCIAL', 'Senhas e credenciais operacionais (banco, SMTP, serviços): nunca no pacote de dados da aplicação; recuperação por custódia própria.'),
  segredo('segredos-chaves-privadas', 'CHAVE_PRIVADA', 'Chaves privadas (TLS, acesso remoto, autenticação do manifesto): nunca no pacote; a parte pública de material de infraestrutura segue procedimento próprio.'),
  segredo('segredos-aplicacao', 'SEGREDO_DE_APLICACAO', 'Segredos de aplicação (HMAC do cooldown, chaves TOTP/MFA, chaves de serviços externos): nunca no pacote; rotação e custódia próprias.'),
  segredo('segredos-arquivo-ambiente', 'ARQUIVO_DE_AMBIENTE', 'Arquivos de ambiente e de senha do cliente do banco: nunca no pacote nem lidos pelo backup; recuperação por procedimento independente.'),
].sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * Nomes que o padrão léxico de raízes casa em .env.example/src/config mas que NÃO são raízes de armazenamento: exceção por
 * arquivo e nome, com a quantidade esperada de ocorrências (um uso novo, mesmo no mesmo arquivo, reabre a revisão).
 */
const NOMES_QUE_NAO_SAO_RAIZ = Object.freeze([
  Object.freeze({ nome: 'VARIAVEL_DIRETORIO', arquivo: 'src/config/imagens.js', ocorrencias: 4 }),
]);

const DECISOES_DO_P0 = Object.freeze({
  'P0-CF-1': Object.freeze({ fonteId: 'janela-escrita', classe: 'EFEMERA', documento: DOCUMENTO_DO_P0, secao: '10' }),
  'P0-CF-2': Object.freeze({ fonteIds: Object.freeze(FONTES.filter((f) => f.decisaoRef === 'P0-CF-2').map((f) => f.id).sort()), classe: 'EXCLUIDA', documento: DOCUMENTO_DO_P0, secao: '7 e 10' }),
  'P0-CF-3': Object.freeze({ fonteId: 'imagens', estadoInicial: 'IMPLEMENTADA_NAO_COMPROVADA', documento: DOCUMENTO_DO_P0, secao: '10' }),
});

/** ACH-FISC-01 (adendo, seção 11): hipótese estática NÃO resolvida; registrada aqui só para rastreabilidade, sem efeito no catálogo. */
const ACHADOS_ABERTOS = Object.freeze([Object.freeze({ id: 'ACH-FISC-01', fonteId: 'fiscalizacao-pacotes', situacao: 'HIPOTESE_NAO_TESTADA', documento: DOCUMENTO_DO_P0 })]);

let selado = null;
function obterCatalogo() {
  if (selado === null) selado = regras.selarCatalogo({ versao: 1, fontes: FONTES });
  return selado;
}
const hashDoCatalogoInicial = () => regras.hashCatalogo(obterCatalogo());

module.exports = { obterCatalogo, hashDoCatalogoInicial, DECISOES_DO_P0, ACHADOS_ABERTOS, NOMES_QUE_NAO_SAO_RAIZ };
