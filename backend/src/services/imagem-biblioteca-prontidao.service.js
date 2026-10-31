'use strict';

const fsNode = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { lerConfiguracao } = require('../config/imagens');
const { criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { ErroImportacaoPadrao, nomeSeguro } = require('../utils/pacote-padrao-erros');
const { lerPlanoAprovado } = require('../utils/plano-pacotes-padrao');
const importacao = require('./imagem-padrao-importacao.service');
const verificacao = require('./imagem-armazenamento-verificacao.service');

/**
 * Prontidão da biblioteca padrão de imagens: portão de PUBLICAÇÃO, somente leitura. Responde se o ambiente que EXIGE a biblioteca foi provisionado, o que
 * `/api/health` e a existência das tabelas não provam (a migration 090 cria a estrutura vazia; as imagens entram por importação separada).
 *
 * Não repete lógica: confere cada pacote do plano aprovado com a importação em SIMULAÇÃO (SHA-256 do pacote e dos arquivos, registro e arquivo de cada imagem,
 * divergências) e o armazenamento inteiro com o verificador de integridade. Nada é gravado, apagado nem criado.
 *
 * A política vem do ambiente (IMAGENS_BIBLIOTECA_PADRAO) e é sempre explícita, para a omissão nunca valer como "desabilitada":
 *   desabilitada                 — ambiente que intencionalmente não usa armazenamento de imagens; nada é consultado.
 *   obrigatoria, e o resultado é um destes:
 *   NAO_PROVISIONADA             — falta provisionar: variável do diretório ausente, diretório inexistente ou imagens do plano sem registro/arquivo
 *                                  (inclusive banco e diretório AMBOS vazios). Reexecutar a importação resolve.
 *   INCONSISTENTE                — há o que investigar: diretório com localização, tipo ou permissão inadequados, divergência entre banco, pacote e
 *                                  arquivos, ou veredito RECUPERAVEL/INVESTIGAR do verificador.
 *   PROVISIONADA_INTEGRA         — todas as imagens do plano têm registro e arquivos conferidos e o armazenamento está íntegro (sobras sem registro não são dano).
 */

const POLITICA_VARIAVEL = 'IMAGENS_BIBLIOTECA_PADRAO';
const POLITICAS = Object.freeze({ OBRIGATORIA: 'obrigatoria', DESABILITADA: 'desabilitada' });
const ESTADOS = Object.freeze({
  DESABILITADA: 'DESABILITADA',
  NAO_PROVISIONADA: 'NAO_PROVISIONADA',
  INCONSISTENTE: 'INCONSISTENTE',
  PROVISIONADA_INTEGRA: 'PROVISIONADA_INTEGRA',
});
const IDADE_MINIMA_ORFAO_PADRAO_MINUTOS = verificacao.IDADE_MINIMA_ORFAO_PADRAO_MINUTOS;
const CODIGO_DO_SISTEMA = /^[A-Z0-9_]{1,30}$/;
const MAX_DIVERGENCIAS = 40;
const FALHAS_DE_CONFIGURACAO = Object.freeze(['IMAGENS_CONFIGURACAO_INVALIDA', 'IMAGENS_DIRETORIO_INVALIDO']);

const FS_PADRAO = Object.freeze({ lstat: fsp.lstat, realpath: fsp.realpath, access: fsp.access, constants: fsNode.constants });

function politicaInvalida() {
  return Object.assign(new Error(`${POLITICA_VARIAVEL}: deve ser obrigatoria ou desabilitada`), { codigo: 'IMAGENS_POLITICA_INVALIDA' });
}

/** A política exige valor EXATO; ausente, vazia ou qualquer outro texto é recusada, nunca assumida. */
function lerPolitica(ambiente = process.env) {
  const bruto = ambiente?.[POLITICA_VARIAVEL];
  if (bruto === POLITICAS.OBRIGATORIA || bruto === POLITICAS.DESABILITADA) return bruto;
  throw politicaInvalida();
}

const codigoDoSistema = (falha) => (typeof falha?.code === 'string' && CODIGO_DO_SISTEMA.test(falha.code) ? falha.code : 'DESCONHECIDO');

/**
 * Só LEITURA do diretório: nunca cria nem altera permissão. Rejeita acesso de "outros" e escrita de grupo (a aplicação cria pastas 0700 e arquivos 0600), mas
 * aceita leitura de grupo, para o grupo de serviço ou de backup; e exige que o processo que roda a verificação leia, grave e atravesse o diretório.
 * @returns {Promise<{ ausente: boolean, problemas: string[] }>}
 */
async function inspecionarDiretorio(fs, diretorio) {
  let estado;
  try {
    estado = await fs.lstat(diretorio);
  } catch (falha) {
    if (falha?.code === 'ENOENT' || falha?.code === 'ENOTDIR') return { ausente: true, problemas: [] };
    return { ausente: false, problemas: [`DIRETORIO_ILEGIVEL:${codigoDoSistema(falha)}`] };
  }
  if (estado.isSymbolicLink()) return { ausente: false, problemas: ['DIRETORIO_E_LINK_SIMBOLICO'] };
  if (!estado.isDirectory()) return { ausente: false, problemas: ['DIRETORIO_NAO_E_DIRETORIO'] };

  const problemas = [];
  try {
    if ((await fs.realpath(diretorio)) !== diretorio) problemas.push('DIRETORIO_NAO_CANONICO');
  } catch (falha) {
    problemas.push(`DIRETORIO_ILEGIVEL:${codigoDoSistema(falha)}`);
  }
  if ((estado.mode & 0o007) !== 0) problemas.push('PERMISSAO_ACESSO_DE_OUTROS');
  if ((estado.mode & 0o020) !== 0) problemas.push('PERMISSAO_ESCRITA_DO_GRUPO');
  try {
    await fs.access(diretorio, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    problemas.push('PERMISSAO_INSUFICIENTE_PARA_O_PROCESSO');
  }
  return { ausente: false, problemas };
}

/** Mesma interface do armazenamento, mas a gravação é impossível: a prontidão nunca escreve, mesmo que a importação em simulação tentasse. */
function somenteLeitura(armazenamento) {
  return Object.freeze({
    existe: (...argumentos) => armazenamento.existe(...argumentos),
    abrir: (...argumentos) => armazenamento.abrir(...argumentos),
    gravar: async () => { throw new Error('armazenamento somente leitura'); },
  });
}

const resumoDaDivergencia = (detalhe) => {
  const partes = {};
  for (const campo of ['alvo', 'campo', 'motivo']) if (typeof detalhe[campo] === 'string') partes[campo] = detalhe[campo];
  if (typeof detalhe.nome === 'string') partes.nome = nomeSeguro(detalhe.nome);
  return partes;
};

/**
 * @param {{
 *   ambiente?: object, pool?: object, plano?: { bytes: Buffer, sha256Esperado: string }|null, pastaPacotes?: string|null,
 *   idadeMinimaOrfaoMinutos?: number, destino?: { banco: string, oid: string }|null,
 * }} opcoes  `destino` (nome e OID do banco autorizado) é OBRIGATÓRIO com política obrigatoria: o importador o confere na conexão antes de qualquer leitura e
 *   o resultado nunca é PROVISIONADA_INTEGRA sem essa conferência.
 * @param {{ importar?: Function, verificar?: Function, identificarBanco?: Function, criarArmazenamento?: Function, fs?: object }} [dependencias]
 * @returns {Promise<object>} `estado` (ESTADOS), `politica`, `motivos`, `avisos` e, quando consultados, `plano`, `pacotes`, `armazenamento` e `banco`.
 *   Recusas (política inválida, plano ou pacote sem integridade comprovada, destino não autorizado, falha de execução) são ERROS, nunca um estado.
 */
async function verificarProntidao(opcoes, dependencias = {}) {
  const { ambiente = process.env, pool, plano = null, pastaPacotes = null, idadeMinimaOrfaoMinutos = IDADE_MINIMA_ORFAO_PADRAO_MINUTOS, destino = null } = opcoes ?? {};
  const {
    importar = importacao.importarPacotePadrao,
    verificar = verificacao.verificarArmazenamento,
    identificarBanco = verificacao.identificarBanco,
    criarArmazenamento = (argumentos) => criarArmazenamentoImagens(argumentos),
    fs = FS_PADRAO,
  } = dependencias;

  const politica = lerPolitica(ambiente);
  const diretorioConfigurado = typeof ambiente.IMAGENS_ARMAZENAMENTO_DIRETORIO === 'string' && ambiente.IMAGENS_ARMAZENAMENTO_DIRETORIO.trim() !== '';
  if (politica === POLITICAS.DESABILITADA) {
    const avisos = diretorioConfigurado ? [{ codigo: 'DIRETORIO_CONFIGURADO_COM_BIBLIOTECA_DESABILITADA' }] : [];
    return { estado: ESTADOS.DESABILITADA, politica, motivos: [], avisos };
  }

  if (plano === null || typeof plano !== 'object') throw new ErroImportacaoPadrao('PLANO_INVALIDO', [{ campo: 'plano', motivo: 'AUSENTE' }]);
  if (typeof pastaPacotes !== 'string' || !path.isAbsolute(pastaPacotes) || pastaPacotes.includes('\0')) throw new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') throw new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
  // O banco consultado vem de DB_*, que pode apontar para outro ambiente: sem a identidade autorizada (nome e OID, da autorização escrita) não há aprovação possível.
  if (destino === null || typeof destino !== 'object') throw new ErroImportacaoPadrao('DESTINO_NAO_AUTORIZADO', [{ campo: 'destino', motivo: 'AUSENTE' }]);
  const aprovado = lerPlanoAprovado(plano.bytes, plano.sha256Esperado);

  const motivos = [];
  const naoProvisionada = (codigo, extra = {}) => motivos.push({ classe: ESTADOS.NAO_PROVISIONADA, codigo, ...extra });
  const inconsistente = (codigo, extra = {}) => motivos.push({ classe: ESTADOS.INCONSISTENTE, codigo, ...extra });
  const resultado = (extra = {}) => {
    const estado = motivos.some((m) => m.classe === ESTADOS.INCONSISTENTE) ? ESTADOS.INCONSISTENTE
      : motivos.length > 0 ? ESTADOS.NAO_PROVISIONADA : ESTADOS.PROVISIONADA_INTEGRA;
    return { estado, politica, motivos, avisos: [], plano: { sha256: aprovado.sha256, pacotes: aprovado.pacotes.length }, ...extra };
  };

  let diretorio = null;
  try {
    diretorio = lerConfiguracao(ambiente).diretorio;
  } catch (falha) {
    if (!FALHAS_DE_CONFIGURACAO.includes(falha?.codigo)) throw falha;
    if (falha.codigo === 'IMAGENS_DIRETORIO_INVALIDO') inconsistente('LOCALIZACAO_DO_DIRETORIO_INVALIDA', { variavel: 'IMAGENS_ARMAZENAMENTO_DIRETORIO' });
    else inconsistente('CONFIGURACAO_DE_IMAGENS_INVALIDA');
    return resultado();
  }
  if (diretorio === null) {
    naoProvisionada('DIRETORIO_NAO_CONFIGURADO', { variavel: 'IMAGENS_ARMAZENAMENTO_DIRETORIO' });
    return resultado();
  }
  const diretorioLido = await inspecionarDiretorio(fs, diretorio);
  if (diretorioLido.ausente) {
    naoProvisionada('DIRETORIO_INEXISTENTE');
    return resultado();
  }
  if (diretorioLido.problemas.length > 0) {
    for (const problema of diretorioLido.problemas) inconsistente(problema);
    return resultado();
  }

  const armazenamento = somenteLeitura(criarArmazenamento({ diretorio }));
  const pacotes = [];
  for (const previsto of aprovado.pacotes) {
    let relatorio;
    try {
      relatorio = await importar(pool, {
        pacote: path.join(pastaPacotes, previsto.arquivo),
        pacoteSha256Esperado: previsto.sha256,
        quantidadeEsperada: previsto.quantidade,
        armazenamento,
        executar: false,
        destinoAutorizado: destino,
      });
    } catch (falha) {
      if (!(falha instanceof ErroImportacaoPadrao) || falha.codigo !== 'ESTADO_DIVERGENTE') throw falha;
      const divergencias = falha.detalhes.slice(0, MAX_DIVERGENCIAS).map(resumoDaDivergencia);
      pacotes.push({ arquivo: previsto.arquivo, imagens: previsto.quantidade, situacao: 'DIVERGENTE', divergencias, divergenciasTotal: falha.detalhes.length });
      inconsistente('PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS', { arquivo: previsto.arquivo, divergencias: falha.detalhes.length });
      continue;
    }
    const { total, novas, existentes, arquivosNovos } = relatorio.resumo;
    pacotes.push({ arquivo: previsto.arquivo, imagens: total, situacao: novas === 0 && arquivosNovos === 0 ? 'PROVISIONADO' : 'INCOMPLETO', registradas: existentes, faltandoRegistro: novas, faltandoArquivo: arquivosNovos });
    if (novas > 0 || arquivosNovos > 0) naoProvisionada('PACOTE_NAO_PROVISIONADO', { arquivo: previsto.arquivo, faltandoRegistro: novas, faltandoArquivo: arquivosNovos });
  }

  const banco = await identificarBanco(pool);
  if (banco.nome !== destino.banco || banco.oid !== destino.oid) {
    throw new ErroImportacaoPadrao('DESTINO_NAO_AUTORIZADO', [{ campo: 'destino', motivo: 'DIFERENTE_DO_AUTORIZADO' }]);
  }
  const integridade = await verificar(pool, { diretorio, idadeMinimaOrfaoMinutos });
  if (integridade.veredito === 'RECUPERAVEL' || integridade.veredito === 'INVESTIGAR') inconsistente(`ARMAZENAMENTO_${integridade.veredito}`);

  return resultado({
    pacotes,
    armazenamento: { veredito: integridade.veredito, alertas: integridade.alertas.map((alerta) => alerta.codigo), resumo: integridade.resumo },
    banco,
  });
}

/** Pior classe que importa à biblioteca padrão: imagens e sobras do escopo PADRAO ou da RAIZ e os alertas. Divergência só de imagem de empresa não entra. */
function situacaoDaBibliotecaPadrao(relatorio) {
  const classes = [
    ...relatorio.imagens.filter((imagem) => imagem.escopo !== 'EMPRESA').map((imagem) => imagem.classe),
    ...relatorio.armazenamento.filter((item) => item.escopo !== 'EMPRESA' && !item.recente).map((item) => item.classe),
    ...relatorio.alertas.map((alerta) => alerta.classe),
  ];
  if (classes.includes('INVESTIGAR')) return 'INVESTIGAR';
  return classes.includes('RECUPERAVEL') ? 'RECUPERAVEL' : 'INTEGRO';
}

/**
 * Verificação da biblioteca padrão na INICIALIZAÇÃO (guarda `npm start`), só com a política `obrigatoria`. Somente leitura e sem o plano nem os ZIPs: não sabe QUANTAS
 * imagens são esperadas, então detecta o que o portão de publicação não pode deixar passar na subida: configuração ou diretório inválidos, biblioteca VAZIA (nenhuma imagem
 * padrão registrada) e divergência entre banco e arquivos. A conferência contra o plano aprovado continua sendo do portão (`imagens:prontidao`).
 * Reaproveita `inspecionarDiretorio` e o verificador de integridade. Uma divergência só de imagem de empresa não impede a subida; ela segue visível em `imagens:verificar`.
 * `cliente` é um cliente pg já conectado, sem transação aberta.
 * @returns {Promise<{ problemas: Array<{ codigo: string, mensagem: string }>, resumo?: { registrosPadrao: number, veredito: string } }>} mensagens sem caminho nem valor.
 */
async function verificarParaInicializacao({ ambiente = process.env, cliente, idadeMinimaOrfaoMinutos = IDADE_MINIMA_ORFAO_PADRAO_MINUTOS } = {}, dependencias = {}) {
  if (cliente === null || typeof cliente !== 'object' || typeof cliente.query !== 'function') throw new TypeError('cliente inválido');
  const { verificar = verificacao.verificarArmazenamento, fs = FS_PADRAO } = dependencias;
  const problemas = [];
  const problema = (codigo, mensagem) => problemas.push({ codigo: `BIBLIOTECA_IMAGENS_${codigo}`, mensagem });

  let diretorio;
  try {
    diretorio = lerConfiguracao(ambiente).diretorio;
  } catch (falha) {
    if (!FALHAS_DE_CONFIGURACAO.includes(falha?.codigo)) throw falha;
    problema(falha.codigo === 'IMAGENS_DIRETORIO_INVALIDO' ? 'LOCALIZACAO_INVALIDA' : 'CONFIGURACAO_INVALIDA', falha.message);
    return { problemas };
  }
  if (diretorio === null) {
    problema('DIRETORIO_NAO_CONFIGURADO', `${POLITICA_VARIAVEL}=obrigatoria, mas IMAGENS_ARMAZENAMENTO_DIRETORIO não está configurada`);
    return { problemas };
  }
  const lido = await inspecionarDiretorio(fs, diretorio);
  if (lido.ausente) {
    problema('DIRETORIO_INEXISTENTE', 'o diretório de imagens (IMAGENS_ARMAZENAMENTO_DIRETORIO) não existe; monte o volume ou provisione a biblioteca padrão');
    return { problemas };
  }
  if (lido.problemas.length > 0) {
    problema('DIRETORIO_INADEQUADO', `o diretório de imagens está inadequado (${lido.problemas.join(', ')}); corrija o proprietário e o modo, sem mexer no conteúdo`);
    return { problemas };
  }

  const pool = { connect: async () => ({ query: (...argumentos) => cliente.query(...argumentos), release() {} }) };
  const relatorio = await verificar(pool, { diretorio, idadeMinimaOrfaoMinutos });
  const resumo = { registrosPadrao: relatorio.resumo.registros.padrao, veredito: situacaoDaBibliotecaPadrao(relatorio) };
  if (resumo.registrosPadrao === 0) {
    problema('AUSENTE', 'nenhuma imagem padrão registrada no banco; instale a biblioteca padrão (npm run imagens:importar-padrao) e confirme com npm run imagens:prontidao');
  }
  if (resumo.veredito !== 'INTEGRO') {
    problema('INCONSISTENTE', `a biblioteca padrão não está íntegra (veredito ${resumo.veredito}); rode npm run imagens:verificar e investigue antes de iniciar`);
  }
  return { problemas, resumo };
}

module.exports = { POLITICA_VARIAVEL, POLITICAS, ESTADOS, lerPolitica, inspecionarDiretorio, verificarProntidao, verificarParaInicializacao };
