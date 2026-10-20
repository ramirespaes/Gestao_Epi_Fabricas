'use strict';

const h = require('./pacote-padrao-ficticio');

/**
 * Cenários da importação da biblioteca padrão (Unidade 5A-2, RED), compartilhados entre os contratos (imagens-importar-padrao.test.js e
 * imagens-importar-padrao.integration.js) e os controles que provam que cada cenário é REAL (test/infra/cenarios-importacao-padrao.test.js).
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const pacote = h.montarPacote();
const ZIP_INTEGRO = h.zipDoPacote(pacote);

const item = pacote.itens[9];
const outroPng = h.pngFicticio({ semente: 'troca' });
const outraMiniatura = h.webpFicticio({ semente: 'troca' });

/** Adulterações que o SHA-256 dos BYTES tem de pegar, com o ZIP e o manifesto coerentes entre si em tudo o mais. */
const ADULTERACOES = [
  ['PNG padronizado trocado por outra imagem VÁLIDA (só o hash denuncia)', { substituir: { [item.entradaPadronizado]: outroPng } }, item.entradaPadronizado, 'SHA256', item.sha256Padronizado, h.sha256(outroPng)],
  ['PNG padronizado com um byte invertido', { substituir: { [item.entradaPadronizado]: h.comByteInvertido(item.padronizado) } }, item.entradaPadronizado, 'SHA256', item.sha256Padronizado, h.sha256(h.comByteInvertido(item.padronizado))],
  ['miniatura WebP trocada por outra', { substituir: { [item.entradaMiniatura]: outraMiniatura } }, item.entradaMiniatura, 'SHA256', item.sha256Miniatura, h.sha256(outraMiniatura)],
  ['miniatura WebP com um byte invertido', { substituir: { [item.entradaMiniatura]: h.comByteInvertido(item.miniatura) } }, item.entradaMiniatura, 'SHA256', item.sha256Miniatura, h.sha256(h.comByteInvertido(item.miniatura))],
  ['original com um byte invertido (não é importado, mas é conferido)', { substituir: { [item.entradaOriginal]: h.comByteInvertido(item.original) } }, item.entradaOriginal, 'SHA256', item.sha256Original, h.sha256(h.comByteInvertido(item.original))],
  ['hash do PNG alterado no manifesto, arquivo intacto', { manifesto: h.manifestoComCelula(pacote, 9, 'sha256_png_padronizado', '0'.repeat(64)) }, item.entradaPadronizado, 'SHA256', '0'.repeat(64), item.sha256Padronizado],
  ['hash da miniatura alterado no manifesto, arquivo intacto', { manifesto: h.manifestoComCelula(pacote, 9, 'sha256_miniatura_webp', 'f'.repeat(64)) }, item.entradaMiniatura, 'SHA256', 'f'.repeat(64), item.sha256Miniatura],
  ['hash do original alterado no manifesto, arquivo intacto', { manifesto: h.manifestoComCelula(pacote, 9, 'sha256_original', 'e'.repeat(64)) }, item.entradaOriginal, 'SHA256', 'e'.repeat(64), item.sha256Original],
  ['tamanho da miniatura alterado no manifesto, hash intacto', { manifesto: h.manifestoComCelula(pacote, 9, 'bytes_miniatura', item.miniatura.length + 1) }, item.entradaMiniatura, 'TAMANHO', item.miniatura.length + 1, item.miniatura.length],
  ['última miniatura do pacote adulterada (a última a ser lida)', { substituir: { [pacote.itens[29].entradaMiniatura]: h.comByteInvertido(pacote.itens[29].miniatura) } }, pacote.itens[29].entradaMiniatura, 'SHA256', pacote.itens[29].sha256Miniatura, h.sha256(h.comByteInvertido(pacote.itens[29].miniatura))],
];

/** Manifestos que não são o manifesto: todos recusados antes de qualquer conferência de arquivo. */
const linhasDoManifesto = pacote.manifesto.split('\r\n');
const MANIFESTOS_INVALIDOS = [
  ['cabeçalho diferente', ['nome,sha256', ...linhasDoManifesto.slice(1)].join('\r\n')],
  ['29 linhas de dados', [...linhasDoManifesto.slice(0, 30), ''].join('\r\n')],
  ['31 linhas de dados (item a mais)', [...linhasDoManifesto.slice(0, 31), linhasDoManifesto[1].replace('Avental de Segurança', 'Item Extra'), ''].join('\r\n')],
  ['nome repetido em duas linhas', [...linhasDoManifesto.slice(0, 30), linhasDoManifesto[1], ''].join('\r\n')],
  ['hash em maiúsculas', h.manifestoComCelula(pacote, 0, 'sha256_png_padronizado', item.sha256Padronizado.toUpperCase())],
  ['hash curto', h.manifestoComCelula(pacote, 0, 'sha256_png_padronizado', 'abc123')],
  ['tamanho não numérico', h.manifestoComCelula(pacote, 0, 'bytes_padronizado', 'muitos')],
  ['tamanho zero', h.manifestoComCelula(pacote, 0, 'bytes_padronizado', 0)],
  ['nome com barra', linhasDoManifesto.map((l, k) => (k === 1 ? l.replace('Avental de Segurança.png', 'pasta/Avental.png') : l)).join('\r\n')],
  ['nome sem extensão .png', linhasDoManifesto.map((l, k) => (k === 1 ? l.replace('Avental de Segurança.png', 'Avental de Segurança') : l)).join('\r\n')],
  ['manifesto vazio', ''],
];

const MARCA = `gepi-hostil-${process.pid}`;
const bomba = Buffer.alloc(3 * MIB);
/** ZIPs que o importador nunca pode abrir além da estrutura (PAD-06). `construir` devolve o ZIP; `limites` vai na chamada; `motivo` é o esperado em `detalhes`. */
const HOSTIS = [
  ...h.entradasHostis(MARCA).map(({ id, alvo, entrada, motivo }) => ({ descricao: id, alvo, construir: () => h.zipDoPacote(pacote, { adicionar: [entrada] }), motivo })),
  {
    descricao: 'arquivo previsto substituído por link simbólico',
    construir: () => h.zipDoPacote(pacote, { remover: [pacote.itens[3].entradaPadronizado], adicionar: [{ nome: pacote.itens[3].entradaPadronizado, dados: Buffer.from('/etc/passwd'), modoUnix: 0o120777 }] }),
    motivo: 'LINK_SIMBOLICO',
  },
  { descricao: 'nome de entrada duplicado', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: pacote.itens[0].entradaPadronizado, dados: pacote.itens[0].padronizado }] }), motivo: 'NOME_DUPLICADO' },
  { descricao: 'entrada fora do manifesto na pasta dos PNG', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '02_PNG_PADRONIZADOS/extra.png', dados: outroPng }] }), motivo: 'ENTRADA_NAO_PREVISTA' },
  { descricao: 'miniatura fora do manifesto', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '03_MINIATURAS_WEBP/extra.webp', dados: outraMiniatura }] }), motivo: 'ENTRADA_NAO_PREVISTA' },
  { descricao: 'pasta desconhecida', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '04_OUTROS/x.png', dados: outroPng }] }), motivo: 'ENTRADA_NAO_PREVISTA' },
  { descricao: 'arquivo executável na raiz', construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: 'executar.sh', dados: Buffer.from('#!/bin/sh\n') }] }), motivo: 'ENTRADA_NAO_PREVISTA' },
  { descricao: 'limite por arquivo reduzido (1 KiB) com o pacote legítimo', construir: () => ZIP_INTEGRO, limites: { maxBytesPorArquivo: KIB }, motivo: 'TAMANHO_EXCEDIDO' },
  { descricao: 'limite total reduzido (100 KiB) com o pacote legítimo', construir: () => ZIP_INTEGRO, limites: { maxBytesTotal: 100 * KIB }, motivo: 'TAMANHO_EXCEDIDO' },
  { descricao: 'limite de entradas reduzido (10) com o pacote legítimo', construir: () => ZIP_INTEGRO, limites: { maxEntradas: 10 }, motivo: 'ENTRADAS_DEMAIS' },
  {
    descricao: 'bomba de descompressão: 3 MiB de zeros em poucos KiB, com limite por arquivo de 1 MiB',
    construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '02_PNG_PADRONIZADOS/bomba.png', dados: bomba }] }),
    limites: { maxBytesPorArquivo: MIB },
    motivo: 'TAMANHO_EXCEDIDO',
  },
  {
    descricao: 'tamanho declarado que mente (diz 10 bytes, entrega 2 MiB)',
    construir: () => h.zipDoPacote(pacote, { adicionar: [{ nome: '02_PNG_PADRONIZADOS/mente.png', dados: Buffer.alloc(2 * MIB), tamanhoDeclarado: 10 }] }),
    limites: { maxBytesPorArquivo: MIB },
    motivo: null,
  },
  {
    descricao: 'entrada de 5 MiB + 1 byte com os limites PADRÃO (manifesto coerente: só o tamanho é o problema)',
    construir: () => h.zipDoPacote(h.pacoteComItem(pacote, 3, { padronizado: Buffer.alloc(5 * MIB + 1) })),
    motivo: 'TAMANHO_EXCEDIDO',
  },
  { descricao: 'byte invertido dentro do ZIP (corrupção de transporte)', construir: () => h.zipComDadosCorrompidos(ZIP_INTEGRO, pacote.itens[5].entradaMiniatura), motivo: 'ZIP_CORROMPIDO' },
  { descricao: 'ZIP truncado (sem o registro de fim)', construir: () => ZIP_INTEGRO.subarray(0, ZIP_INTEGRO.length - 30), motivo: 'ZIP_CORROMPIDO' },
  {
    descricao: 'CRC declarado errado numa entrada',
    construir: () => h.zipDoPacote(pacote, { remover: [pacote.itens[7].entradaMiniatura], adicionar: [{ nome: pacote.itens[7].entradaMiniatura, dados: pacote.itens[7].miniatura, compressao: 'stored', crc: 1 }] }),
    motivo: 'ZIP_CORROMPIDO',
  },
  { descricao: 'arquivo que não é um ZIP', construir: () => Buffer.from('isto não é um zip'), motivo: 'ZIP_CORROMPIDO' },
  { descricao: 'arquivo vazio', construir: () => Buffer.alloc(0), motivo: 'ZIP_CORROMPIDO' },
];

/** Imagens com hash COERENTE com o manifesto mas formato recusável: só a validação do formato pode pegar. */
const png = (extra) => h.pngFicticio({ semente: item.nome, ...extra });
const webp = (extra) => h.webpFicticio({ semente: item.nome, ...extra });
const riffIncoerente = webp();
riffIncoerente.writeUInt32LE(riffIncoerente.readUInt32LE(4) + 10, 4);
const FORMATOS = [
  ['PNG padronizado com bloco caBX (C2PA)', { padronizado: png({ extras: [{ tipo: 'caBX', dados: Buffer.from('c2pa-ficticio') }] }) }, item.entradaPadronizado, 'METADADOS'],
  ['PNG padronizado com bloco eXIf', { padronizado: png({ extras: [{ tipo: 'eXIf', dados: Buffer.from('Exif\0\0II*\0') }] }) }, item.entradaPadronizado, 'METADADOS'],
  ['PNG padronizado com bloco tEXt', { padronizado: png({ extras: [{ tipo: 'tEXt', dados: Buffer.from('Comment\0nota') }] }) }, item.entradaPadronizado, 'METADADOS'],
  ['PNG padronizado 512x512', { padronizado: png({ largura: 512, altura: 512 }) }, item.entradaPadronizado, 'DIMENSOES'],
  ['PNG padronizado 1254x1254 (o tamanho dos originais)', { padronizado: png({ largura: 1254, altura: 1254 }) }, item.entradaPadronizado, 'DIMENSOES'],
  ['PNG padronizado 1024x1000 (não quadrado)', { padronizado: png({ altura: 1000 }) }, item.entradaPadronizado, 'DIMENSOES'],
  ['PNG padronizado com bytes depois do IEND (polyglot)', { padronizado: png({ aposFim: Buffer.from('PK\x03\x04polyglot') }) }, item.entradaPadronizado, 'ESTRUTURA'],
  ['PNG padronizado truncado (sem IEND)', { padronizado: png().subarray(0, png().length - 12) }, item.entradaPadronizado, 'ESTRUTURA'],
  ['"PNG" que não tem assinatura de PNG', { padronizado: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]) }, item.entradaPadronizado, 'ASSINATURA'],
  ['miniatura 256x256', { miniatura: webp({ largura: 256, altura: 256 }) }, item.entradaMiniatura, 'DIMENSOES'],
  ['miniatura 320x256 (não quadrada)', { miniatura: webp({ altura: 256 }) }, item.entradaMiniatura, 'DIMENSOES'],
  ['miniatura com bloco EXIF', { miniatura: webp({ extras: [{ tipo: 'EXIF', dados: Buffer.from('Exif\0\0') }] }) }, item.entradaMiniatura, 'METADADOS'],
  ['miniatura com bloco XMP', { miniatura: webp({ extras: [{ tipo: 'XMP ', dados: Buffer.from('<x:xmpmeta/>') }] }) }, item.entradaMiniatura, 'METADADOS'],
  ['miniatura com perfil ICCP', { miniatura: webp({ extras: [{ tipo: 'ICCP', dados: Buffer.alloc(16, 7) }] }) }, item.entradaMiniatura, 'METADADOS'],
  ['miniatura animada (ANIM)', { miniatura: webp({ extras: [{ tipo: 'ANIM', dados: Buffer.alloc(6) }] }) }, item.entradaMiniatura, 'ANIMADA'],
  ['"miniatura" que não é RIFF/WEBP', { miniatura: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 2)]) }, item.entradaMiniatura, 'ASSINATURA'],
  ['miniatura com tamanho RIFF incoerente', { miniatura: riffIncoerente }, item.entradaMiniatura, 'ESTRUTURA'],
];

// ----------------------------------------------------------------------------------------------------------------------------- mapeamento
const DECISAO = Object.freeze({ decisao: 'APROVAR', por: 'Ramires', data: '2026-10-17' });
const APROVADAS = Object.freeze({ 'Luva de Segurança': DECISAO, 'Botina de Segurança - Couro': DECISAO });
const aprovar = (linhas, k, extra = {}) => { linhas[k] = { ...linhas[k], decisao: 'APROVAR', por: 'Ramires', data: '2026-10-17', ...extra }; return linhas; };

/**
 * Mapeamentos que o importador tem de recusar (MAPEAMENTO_INVALIDO). Cada linha: [descrição, alterar(linhas da proposta) -> linhas | texto do CSV, valor que a mensagem de
 * erro NÃO pode ecoar (ou null), verificar(linhasLidas, { nomes, tiposBase, cabecalhoOk }) -> o defeito prometido está mesmo no arquivo]. O quarto item é o oráculo dos
 * controles (test/infra/cenarios-importacao-padrao.test.js); o importador não o conhece.
 */
const MAPEAMENTOS_INVALIDOS = [
  ['APROVAR sem aprovado_por', (l) => aprovar(l, 0, { por: '' }), null, (r) => r[0].decisao === 'APROVAR' && r[0].aprovado_por === ''],
  ['APROVAR sem data_aprovacao', (l) => aprovar(l, 0, { data: '' }), null, (r) => r[0].decisao === 'APROVAR' && r[0].data_aprovacao === ''],
  ['aprovado_por só com espaços', (l) => aprovar(l, 0, { por: '   ' }), null, (r) => r[0].decisao === 'APROVAR' && r[0].aprovado_por === '   '],
  ['aprovado_por com 101 caracteres', (l) => aprovar(l, 0, { por: 'x'.repeat(101) }), 'xxxxxxxxxx', (r) => r[0].decisao === 'APROVAR' && r[0].aprovado_por.length === 101],
  ['data impossível (2026-02-30)', (l) => aprovar(l, 0, { data: '2026-02-30' }), '2026-02-30', (r) => {
    const [a, m, d] = r[0].data_aprovacao.split('-').map(Number);
    return r[0].decisao === 'APROVAR' && /^\d{4}-\d{2}-\d{2}$/.test(r[0].data_aprovacao) && new Date(Date.UTC(a, m - 1, d)).getUTCMonth() !== m - 1;
  }],
  ['data em outro formato (17/10/2026)', (l) => aprovar(l, 0, { data: '17/10/2026' }), '17/10/2026', (r) => r[0].decisao === 'APROVAR' && !/^\d{4}-\d{2}-\d{2}$/.test(r[0].data_aprovacao)],
  ['decisão desconhecida (TALVEZ)', (l) => aprovar(l, 0, { decisao: 'TALVEZ' }), 'TALVEZ', (r) => !['', 'APROVAR', 'AJUSTAR', 'REJEITAR'].includes(r[0].decisao)],
  ['nome_base que não está no pacote', (l) => aprovar(l, 0, { nome_base: 'Imagem Que Não Existe' }), 'Imagem Que Não Existe', (r, c) => !c.nomes.has(r[0].nome_base)],
  ['tipo aprovado fora do catálogo BASE', (l) => aprovar(l, 0, { tipo_sugerido: 'Tipo Inventado' }), 'Tipo Inventado', (r, c) => r[0].decisao === 'APROVAR' && !c.tiposBase.has(r[0].tipo_sugerido)],
  ['APROVAR na linha sem correspondência (Camiseta Azul)', (l) => aprovar(l, l.findIndex((x) => x.nome_base === 'Camiseta Azul')), null, (r) => {
    const linha = r.find((x) => x.nome_base === 'Camiseta Azul');
    return linha.decisao === 'APROVAR' && linha.confianca === 'SEM';
  }],
  ['confiança desconhecida em linha aprovada (BAIXA)', (l) => aprovar(l, 0, { confianca: 'BAIXA' }), 'BAIXA', (r) => r[0].decisao === 'APROVAR' && !['ALTA', 'MÉDIA'].includes(r[0].confianca)],
  ['nome_base repetido em duas linhas', (l) => { l[1] = { ...l[1], nome_base: l[0].nome_base }; return l; }, null, (r) => r[1].nome_base === r[0].nome_base],
  ['arquivo_padronizado inconsistente com o nome_base', (l) => { l[0] = { ...l[0], arquivo_padronizado: '02_PNG_PADRONIZADOS/Outro.png' }; return l; }, 'Outro.png', (r) => r[0].arquivo_padronizado !== `02_PNG_PADRONIZADOS/${r[0].nome_base}.png`],
  ['cabeçalho diferente', (l) => h.mapeamentoCsv(l).replace('"nome_base"', '"nome"'), null, (r, c) => c.cabecalhoOk === false],
];

// ---------------------------------------------------------------------------------------------------------------------------- estado do banco
/** Campos que DEFINEM o conteúdo da imagem: linha existente com um deles diferente do pacote é ESTADO_DIVERGENTE. [campo, atribuição do UPDATE que o altera]. */
const DIVERGENCIAS_DE_REGISTRO = [
  ['sha256_miniatura', "sha256_miniatura = repeat('0', 64)"],
  ['bytes_mestre', 'bytes_mestre = bytes_mestre + 1'],
  ['bytes_miniatura', 'bytes_miniatura = bytes_miniatura + 1'],
  ['largura', 'largura = 2048'],
  ['formato', "formato = 'WEBP'"],
];

/** Campos ADMINISTRATIVOS ou de proveniência: podem mudar depois da importação e a repetição nunca os reescreve nem os acusa. [descrição, itens -> [SQL, parâmetros]]. */
const ALTERACOES_ADMINISTRATIVAS = [
  ['renomear', (i) => ["UPDATE imagens_padrao SET nome = 'Nome Administrativo' WHERE sha256 = $1", [i[0].sha256Padronizado]]],
  ['inativar', (i) => ['UPDATE imagens_padrao SET ativo = false WHERE sha256 = $1', [i[1].sha256Padronizado]]],
  ['marcar como não ilustrativa', (i) => ['UPDATE imagens_padrao SET ilustrativa = false WHERE sha256 = $1', [i[2].sha256Padronizado]]],
  ['outra proveniência do pacote', (i) => ["UPDATE imagens_padrao SET pacote_origem = 'Outro.zip', pacote_sha256 = $2 WHERE sha256 = $1", [i[3].sha256Padronizado, h.sha256('outro pacote')]]],
  ['derivada de exibição já gravada', (i) => ['UPDATE imagens_padrao SET sha256_exibicao = $2, bytes_exibicao = 4000 WHERE sha256 = $1', [i[4].sha256Padronizado, h.sha256('exibicao futura')]]],
  ['outra versão', (i) => ['UPDATE imagens_padrao SET versao = 2 WHERE sha256 = $1', [i[5].sha256Padronizado]]],
  ['outra referência de original', (i) => ['UPDATE imagens_padrao SET sha256_original_ref = $2 WHERE sha256 = $1', [i[6].sha256Padronizado, h.sha256('outro original')]]],
];

module.exports = {
  KIB, MIB, pacote, ZIP_INTEGRO, item, outroPng, outraMiniatura, ADULTERACOES, MANIFESTOS_INVALIDOS, HOSTIS, FORMATOS, MARCA,
  DECISAO, APROVADAS, aprovar, MAPEAMENTOS_INVALIDOS, DIVERGENCIAS_DE_REGISTRO, ALTERACOES_ADMINISTRATIVAS,
};
