'use strict';

const { HttpError } = require('../errors/HttpError');
const imagemEmpresaRepo = require('../repositories/imagem-empresa.repository');
const imagemPadraoRepo = require('../repositories/imagem-padrao.repository');
const materialImagemRepo = require('../repositories/material-imagem.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { lerConfiguracao } = require('../config/imagens');
const { exigirIdGrande } = require('../utils/identificador-grande');

/**
 * Biblioteca de imagens de produto (Biblioteca de Imagens, Unidade 3): consulta da biblioteca padrão (global) e da biblioteca privada da empresa,
 * registro de imagem JÁ processada com deduplicação por SHA-256 e cota, renomear, inativar e reativar.
 *
 * AUTORIZAÇÃO NÃO MORA AQUI (mesma decisão de material.service.js): quem pode listar, importar ou gerenciar é o middleware do recurso `materials`
 * (matriz em rbac/imagem-material-permissoes.js). O serviço garante ISOLAMENTO (empresa e ator sempre do contexto, nunca do corpo), INTEGRIDADE
 * (validação de domínio, transação, trava) e AUDITORIA (só ids, formato e bytes: nunca nome, hash, caminho ou conteúdo).
 *
 * A biblioteca padrão é só leitura: este módulo não tem nenhuma operação de escrita sobre ela. O processamento da imagem (decodificação,
 * saneamento, derivadas) e a gravação dos arquivos são de outra unidade: aqui entra o DESCRITOR do que já foi processado.
 *
 * Ids de imagem (BIGINT) são strings decimais em todos os contratos. Travas: a biblioteca da empresa (advisory) ANTES da busca por SHA-256 e da
 * cota; a imagem com FOR UPDATE para mudar de estado (depois, a contagem de uso); a associação ao material trava a imagem com FOR SHARE (ordem
 * material → imagem), então inativação e associação se serializam sem ciclo.
 */

const ACAO = Object.freeze({
  IMPORTADA: 'IMAGEM_MATERIAL_IMPORTADA', RENOMEADA: 'IMAGEM_MATERIAL_RENOMEADA', INATIVADA: 'IMAGEM_MATERIAL_INATIVADA', REATIVADA: 'IMAGEM_MATERIAL_REATIVADA',
  EXCLUIDA: 'IMAGEM_MATERIAL_EXCLUIDA',
});
const ORIGENS = Object.freeze(['TODAS', 'PADRAO', 'EMPRESA']);
const ESTADOS_DA_LISTAGEM = Object.freeze(['ATIVA', 'INATIVA', 'TODAS']);
const MSG = Object.freeze({
  NAO_ENCONTRADA: 'Imagem não encontrada',
  EM_USO: 'A imagem está em uso por um ou mais materiais',
  COTA: 'A cota de imagens da empresa foi atingida',
  NOME: 'Nome da imagem inválido (1 a 100 caracteres, sem caracteres de controle)',
  IMAGEM: 'Dados da imagem inválidos',
  CONFIRMACAO: 'A exclusão da imagem exige confirmação explícita',
});
const CARACTERE_CONTROLE = /\p{Cc}/u;
const HEX64 = /^[0-9a-f]{64}$/;
const INT_MAXIMO = 2147483647;
const CAMPOS_DO_DESCRITOR = Object.freeze([
  'sha256', 'sha256Mestre', 'sha256Exibicao', 'sha256Miniatura', 'formato', 'largura', 'altura', 'bytesMestre', 'bytesExibicao', 'bytesMiniatura',
]);

const recusar = (campo, codigo, mensagem) => HttpError.validacao([{ campo, codigo, mensagem }]);
const naoEncontrada = () => HttpError.notFound('IMAGEM_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function normalizarNome(nome) {
  if (typeof nome !== 'string') throw recusar('body.nome', 'NOME_INVALIDO', MSG.NOME);
  const n = nome.normalize('NFC').trim();
  if (n.length === 0 || Array.from(n).length > 100 || CARACTERE_CONTROLE.test(n)) throw recusar('body.nome', 'NOME_INVALIDO', MSG.NOME);
  return n;
}

/** O descritor é ESTRITO: exatamente as chaves previstas (nada de empresa, criador, estado, versão, caminho ou chave vindos de fora). */
function validarDescritor(imagem, config) {
  const invalido = (campo) => recusar(`body.imagem.${campo}`, 'IMAGEM_DADOS_INVALIDOS', MSG.IMAGEM);
  if (imagem === null || typeof imagem !== 'object' || Array.isArray(imagem)) throw recusar('body.imagem', 'IMAGEM_DADOS_INVALIDOS', MSG.IMAGEM);
  for (const chave of Object.keys(imagem)) if (!CAMPOS_DO_DESCRITOR.includes(chave)) throw invalido(chave);
  for (const campo of ['sha256', 'sha256Mestre', 'sha256Exibicao', 'sha256Miniatura']) if (typeof imagem[campo] !== 'string' || !HEX64.test(imagem[campo])) throw invalido(campo);
  if (!config.formatosAceitos.includes(imagem.formato)) throw invalido('formato');
  for (const campo of ['largura', 'altura']) {
    const v = imagem[campo];
    if (!Number.isInteger(v) || v < config.ladoMin || v > config.ladoMax) throw invalido(campo);
  }
  if (imagem.largura * imagem.altura > config.pixelsMax) throw invalido('largura');
  for (const campo of ['bytesMestre', 'bytesExibicao', 'bytesMiniatura']) {
    const v = imagem[campo];
    if (!Number.isInteger(v) || v <= 0 || v > INT_MAXIMO) throw invalido(campo);
  }
  return imagem;
}

function validarLimites(limites, config) {
  const cotaImagens = limites?.cotaImagens ?? config.cotaImagens;
  const cotaBytes = limites?.cotaBytes ?? config.cotaBytes;
  for (const v of [cotaImagens, cotaBytes]) if (!Number.isInteger(v) || v <= 0) throw new TypeError('limites de cota inválidos');
  return { cotaImagens, cotaBytes };
}

async function emTransacao(pool, operacao, { somenteLeitura = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(somenteLeitura ? 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

/** O que sai da biblioteca da empresa: nenhum hash, byte, criador, empresa, chave ou caminho. */
const publica = (i) => ({
  origem: 'EMPRESA', id: i.id, nome: i.nome, formato: i.formato, largura: i.largura, altura: i.altura, versao: i.versao, estado: i.estado,
});

function validarListagem({ empresaId, origem, busca, tipoNome, estado, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  if (!ORIGENS.includes(origem)) throw recusar('query.origem', 'ORIGEM_INVALIDA', 'Origem de imagem inválida');
  if (!ESTADOS_DA_LISTAGEM.includes(estado)) throw recusar('query.estado', 'ESTADO_INVALIDO', 'Estado de imagem inválido');
  for (const [v, campo] of [[busca, 'busca'], [tipoNome, 'tipoNome']]) {
    if (v !== null && (typeof v !== 'string' || v.length === 0 || v.length > 100)) throw recusar(`query.${campo}`, 'FILTRO_INVALIDO', 'Filtro inválido');
  }
  if (!Number.isInteger(pagina) || pagina < 1) throw recusar('query.pagina', 'PAGINA_INVALIDA', 'Página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > imagemEmpresaRepo.LIMITE_MAXIMO) throw recusar('query.limite', 'LIMITE_INVALIDO', 'Limite inválido');
}

/**
 * Biblioteca para o pop-up: padrão primeiro, depois a da empresa, cada uma por nome e id, paginadas em conjunto. `sugerida` só DESTACA a imagem
 * padrão (por nome de tipo); nada vem selecionado. `emUso` conta só os materiais da PRÓPRIA empresa. Leitura em instantâneo único.
 */
async function listar(pool, {
  empresaId, origem = 'TODAS', busca = null, tipoNome = null, estado = 'ATIVA', pagina = 1, limite = 20,
}) {
  validarListagem({ empresaId, origem, busca, tipoNome, estado, pagina, limite });
  const comPadrao = origem !== 'EMPRESA';
  const comEmpresa = origem !== 'PADRAO';
  const filtroEmpresa = { busca, estado: estado === 'TODAS' ? null : estado };
  const deslocamento = (pagina - 1) * limite;

  return emTransacao(pool, async (client) => {
    const totalPadrao = comPadrao ? await imagemPadraoRepo.contar(client, { busca }) : 0;
    const totalEmpresa = comEmpresa ? await imagemEmpresaRepo.contar(client, empresaId, filtroEmpresa) : 0;
    const doPadrao = comPadrao && deslocamento < totalPadrao
      ? await imagemPadraoRepo.listar(client, { busca, tipoNome, limite: Math.min(limite, totalPadrao - deslocamento), deslocamento }) : [];
    const faltam = limite - doPadrao.length;
    const deslocamentoEmpresa = Math.max(0, deslocamento - totalPadrao);
    const daEmpresa = comEmpresa && faltam > 0 && deslocamentoEmpresa < totalEmpresa
      ? await imagemEmpresaRepo.listar(client, empresaId, { ...filtroEmpresa, limite: faltam, deslocamento: deslocamentoEmpresa }) : [];
    const usos = await materialImagemRepo.contarUsos(client, empresaId, { padraoIds: doPadrao.map((i) => i.id), empresaIds: daEmpresa.map((i) => i.id) });
    const imagens = [
      ...doPadrao.map((i) => ({
        origem: 'PADRAO', id: i.id, nome: i.nome, largura: i.largura, altura: i.altura, versao: i.versao, ilustrativa: i.ilustrativa,
        sugerida: i.sugerida, emUso: usos.padrao.get(i.id) ?? 0,
      })),
      ...daEmpresa.map((i) => ({ ...publica(i), sugerida: null, emUso: usos.empresa.get(i.id) ?? 0 })),
    ];
    return { imagens, total: totalPadrao + totalEmpresa, pagina, limite };
  }, { somenteLeitura: true });
}

/**
 * Registra, na biblioteca da empresa, uma imagem JÁ processada. Mesma transação: trava da biblioteca, busca por (empresa, SHA-256), cota,
 * INSERT e auditoria. Conteúdo já existente na empresa (inclusive INATIVO) devolve a imagem existente, sem reativá-la, sem consumir cota e
 * sem auditar. A cota conta imagens ativas e inativas (até a remoção controlada) e os bytes dos MESTRES (contrato dos docs. 04 e 13).
 *
 * `antesDeInserir` (opcional, Unidade 5C-2): função assíncrona chamada DENTRO da transação, sob a trava da biblioteca que já foi tomada aqui, depois da
 * deduplicação e da cota e antes do INSERT (só no caso de uma imagem nova). É por onde o envio grava os arquivos da imagem sem tomar trava própria
 * (uma segunda aquisição, vinda de outra conexão, seria deadlock). Se ela lançar, a transação é desfeita: nenhuma linha e nenhuma auditoria. Sem ela,
 * nada muda.
 *
 * @returns {Promise<{ imagem: object, reaproveitada: boolean }>}
 */
async function registrarEmpresa(pool, {
  empresaId, atorId, nome, imagem, limites = null, ip = null, dispositivo = null, antesDeInserir = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (antesDeInserir !== null && typeof antesDeInserir !== 'function') throw new TypeError('gancho antesDeInserir inválido');
  const config = lerConfiguracao();
  const nomeNormalizado = normalizarNome(nome);
  const d = validarDescritor(imagem, config);
  const { cotaImagens, cotaBytes } = validarLimites(limites, config);

  return emTransacao(pool, async (client) => {
    await imagemEmpresaRepo.travarBiblioteca(client, empresaId);
    const existente = await imagemEmpresaRepo.buscarPorSha256(client, empresaId, d.sha256);
    if (existente !== null) return { imagem: publica(existente), reaproveitada: true };

    const consumo = await imagemEmpresaRepo.somarConsumo(client, empresaId);
    if (consumo.imagens + 1 > cotaImagens || consumo.bytes + d.bytesMestre > cotaBytes) throw HttpError.conflict('IMAGEM_COTA_EXCEDIDA', MSG.COTA);

    if (antesDeInserir !== null) await antesDeInserir();
    const criada = await imagemEmpresaRepo.inserir(client, { empresaId, nome: nomeNormalizado, ...d, criadoPor: atorId });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO.IMPORTADA, referencia: criada.id, ip, dispositivo,
      contexto: { imagemId: criada.id, formato: criada.formato, bytes: d.bytesMestre + d.bytesExibicao + d.bytesMiniatura },
    });
    return { imagem: publica(criada), reaproveitada: false };
  });
}

/** Lê a imagem da empresa com FOR UPDATE (404 uniforme para inexistente e de outra empresa). */
async function travarParaAtualizacao(client, empresaId, imagemId) {
  const atual = await imagemEmpresaRepo.buscarPorIdParaAtualizacao(client, empresaId, imagemId);
  if (atual === null) throw naoEncontrada();
  return atual;
}

async function renomear(pool, { empresaId, atorId, imagemId, nome, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const id = exigirIdGrande(imagemId, 'identificador de imagem');
  const nomeNormalizado = normalizarNome(nome);
  return emTransacao(pool, async (client) => {
    const atual = await travarParaAtualizacao(client, empresaId, id);
    if (atual.nome === nomeNormalizado) return { imagem: publica(atual), alterado: false };
    const atualizada = await imagemEmpresaRepo.atualizarNome(client, empresaId, id, nomeNormalizado);
    await auditoriaRepo.registrar(client, { empresaId, usuarioId: atorId, acao: ACAO.RENOMEADA, referencia: id, ip, dispositivo, contexto: { imagemId: id } });
    return { imagem: publica(atualizada), alterado: true };
  });
}

/** Inativar: imagem em uso por algum material é 409 IMAGEM_EM_USO e nada muda. Idempotente. */
async function inativar(pool, { empresaId, atorId, imagemId, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const id = exigirIdGrande(imagemId, 'identificador de imagem');
  return emTransacao(pool, async (client) => {
    const atual = await travarParaAtualizacao(client, empresaId, id);
    if (atual.estado === 'INATIVA') return { imagem: publica(atual), alterado: false };
    if (await imagemEmpresaRepo.contarUso(client, empresaId, id) > 0) throw HttpError.conflict('IMAGEM_EM_USO', MSG.EM_USO);
    const atualizada = await imagemEmpresaRepo.atualizarEstado(client, empresaId, id, 'INATIVA');
    await auditoriaRepo.registrar(client, { empresaId, usuarioId: atorId, acao: ACAO.INATIVADA, referencia: id, ip, dispositivo, contexto: { imagemId: id } });
    return { imagem: publica(atualizada), alterado: true };
  });
}

/** Reativar nunca é bloqueado. Idempotente. */
async function reativar(pool, { empresaId, atorId, imagemId, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const id = exigirIdGrande(imagemId, 'identificador de imagem');
  return emTransacao(pool, async (client) => {
    const atual = await travarParaAtualizacao(client, empresaId, id);
    if (atual.estado === 'ATIVA') return { imagem: publica(atual), alterado: false };
    const atualizada = await imagemEmpresaRepo.atualizarEstado(client, empresaId, id, 'ATIVA');
    await auditoriaRepo.registrar(client, { empresaId, usuarioId: atorId, acao: ACAO.REATIVADA, referencia: id, ip, dispositivo, contexto: { imagemId: id } });
    return { imagem: publica(atualizada), alterado: true };
  });
}

/**
 * Exclui da biblioteca da empresa uma imagem SEM vínculo com material (distinto de inativar, que mantém a linha e a cota, e de soltar a
 * imagem do material, que é do serviço de materiais). Exige `confirmacao === true` (a interface futura pede confirmação explícita). Na mesma
 * transação: FOR UPDATE da imagem (serializa com a associação, que toma FOR SHARE), contagem de uso (409 IMAGEM_EM_USO), remoção da linha
 * pelo repositório e auditoria só com id, formato e bytes. Inexistente ou de outra empresa é o mesmo 404; a biblioteca padrão nunca é alcançada. A linha some e a
 * cota é liberada; os arquivos físicos NÃO são tocados (limpeza controlada é rotina futura).
 *
 * @returns {Promise<{ excluida: true, imagemId: string }>}
 */
async function excluir(pool, { empresaId, atorId, imagemId, confirmacao, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const id = exigirIdGrande(imagemId, 'identificador de imagem');
  if (confirmacao !== true) throw recusar('body.confirmacao', 'CONFIRMACAO_OBRIGATORIA', MSG.CONFIRMACAO);
  return emTransacao(pool, async (client) => {
    const atual = await travarParaAtualizacao(client, empresaId, id);
    if (await imagemEmpresaRepo.contarUso(client, empresaId, id) > 0) throw HttpError.conflict('IMAGEM_EM_USO', MSG.EM_USO);
    const apagada = await imagemEmpresaRepo.excluir(client, empresaId, id);
    if (apagada === null) throw naoEncontrada();
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO.EXCLUIDA, referencia: id, ip, dispositivo,
      contexto: { imagemId: id, formato: atual.formato, bytes: atual.bytesMestre + atual.bytesExibicao + atual.bytesMiniatura },
    });
    return { excluida: true, imagemId: id };
  });
}

module.exports = { ACAO, listar, registrarEmpresa, renomear, inativar, reativar, excluir };
