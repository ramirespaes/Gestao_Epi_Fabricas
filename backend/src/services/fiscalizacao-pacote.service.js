'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const periodoFiscal = require('../utils/periodo-fiscal');
const { escreverZipLimitado, ErroZip } = require('../utils/zip-limitado');
const modulosRepo = require('../repositories/fiscalizacao-modulos.repository');
const pacoteRepo = require('../repositories/fiscalizacao-pacote.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { referenciasAmigaveis } = require('./relatorio-auditoria.service');

/**
 * Relatório — Fiscalização (12K-D6): prévia, geração, histórico, download e recuperação de pacotes imutáveis.
 *
 * - Prévia: só contagens (nada é gravado nem montado). A geração REVALIDA os limites no servidor.
 * - Geração: uma tentativa por (empresa, chave de idempotência); mesma chave e mesmo pedido devolvem a tentativa existente em
 *   qualquer estado, e uma tentativa FALHA nunca é reiniciada (nova tentativa = nova chave). Uma geração GERANDO por empresa.
 *   Os dados são lidos num instantâneo único (REPEATABLE READ somente leitura) e o ZIP vai por streaming, com o limite de
 *   tamanho fiscalizado durante a escrita; o arquivo só é publicado inteiro e o registro só vira CONCLUIDO depois disso.
 * - Download: só CONCLUIDO, na empresa da sessão, com o SHA-256 reconferido antes de servir.
 * - Recuperação: uma rotina global interna reclama as gerações sem heartbeat, limpa os artefatos e só então marca FALHA.
 * A empresa e o ator vêm da sessão; o cliente nunca escolhe caminho, nome de arquivo, status nem hash.
 */

const VERSAO_FORMATO = 1;
const LOTE_LINHAS = 1000;
const BOM = '﻿';
const MIB = 1024 * 1024;

const ROTULOS = Object.freeze({
  FICHAS_ENTREGAS_CONFIRMADAS: 'Fichas/entregas de EPI confirmadas',
  TRILHA_AUDITORIA: 'Trilha de auditoria completa',
  HISTORICO_ESTOQUE_CA: 'Histórico de estoque e CA',
  REGRAS_GHE: 'Regras de GHE e elegibilidade',
});

const DEFINICOES = Object.freeze({
  DESENHO: 'Confirmação de recebimento realizada pela modalidade de desenho.',
  ACEITE_PRESENCIAL: 'Confirmação de recebimento presencial, válida, registrada na presença do responsável pela entrega.',
  hash_conteudo: 'Hash SHA-256 de integridade do conteúdo registrado da entrega: serve para detectar alteração do conteúdo. '
    + 'Não é assinatura digital e não é assinatura criptográfica.',
});

const LIMITACOES = Object.freeze([
  'Posição na data da geração: o saldo e os atributos atuais dos lotes (arquivo posicao-lotes-na-geracao) e o vínculo GHE → material '
    + '(arquivo regras-ghe) refletem o momento da geração; o sistema não guarda versões históricas deles e o pacote não as reconstrói.',
  'Regras de elegibilidade por função ou setor: não existem no sistema e não são inventadas nem inferidas pelo pacote; o GHE é sempre o vinculado explicitamente.',
  'Nos movimentos de estoque, o tamanho, o CA e o nome do material são os atributos atuais do lote e do cadastro, não um retrato histórico.',
  'Os traços da confirmação por desenho não são exportados.',
  'Da trilha de auditoria não são exportados contexto, dados anteriores, dados novos nem descrição.',
  'Horários no fuso America/Sao_Paulo, sem deslocamento no texto.',
]);

const ERRO_PACOTE_GRANDE = 'O pacote excede o tamanho máximo de 100 MiB. Reduza o período ou os módulos selecionados e tente novamente com uma nova chave.';
const erroLimiteLinhas = (modulo, linhas, limite) => new HttpError(
  400, 'LIMITE_LINHAS_EXCEDIDO',
  `O módulo "${ROTULOS[modulo]}" tem ${linhas} linhas e o máximo é ${limite}. Reduza o período para gerar o pacote.`,
  { detalhes: { modulo, linhas, limite } },
);

// ─── Pedido ─────────────────────────────────────────────────────────

function normalizar(entrada) {
  const escopos = modulosRepo.ESCOPOS.filter((e) => Array.isArray(entrada.escopos) && entrada.escopos.includes(e));
  const observacao = typeof entrada.observacao === 'string' && entrada.observacao.trim() !== '' ? entrada.observacao.trim() : null;
  return {
    periodoInicio: entrada.periodoInicio, periodoFim: entrada.periodoFim, finalidade: entrada.finalidade, observacao, escopos,
  };
}

function validarPedido(n) {
  if (!n.escopos.length) throw HttpError.badRequest('ESCOPOS_OBRIGATORIOS', 'Selecione pelo menos um módulo');
  if (n.finalidade === 'OUTRA' && n.observacao === null) throw HttpError.badRequest('OBSERVACAO_OBRIGATORIA', 'Observação obrigatória para a finalidade Outra');
  try {
    return periodoFiscal.validar(n.periodoInicio, n.periodoFim);
  } catch (erro) {
    if (erro.codigo) throw HttpError.badRequest(erro.codigo, erro.message);
    throw erro;
  }
}

const hashDoPedido = (n) => crypto.createHash('sha256').update(JSON.stringify({
  periodoInicio: n.periodoInicio, periodoFim: n.periodoFim, finalidade: n.finalidade, observacao: n.observacao, escopos: n.escopos,
})).digest('hex');

function pacoteDto(linha) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: linha.id,
    status: linha.status,
    periodoInicio: linha.periodo_inicio,
    periodoFim: linha.periodo_fim,
    finalidade: linha.finalidade,
    observacao: linha.observacao,
    escopos: linha.escopos,
    versaoFormato: linha.versao_formato,
    contagens: linha.contagens,
    nomeLogico: linha.nome_logico,
    tamanhoBytes: linha.tamanho_bytes === null ? null : Number(linha.tamanho_bytes),
    sha256: linha.sha256,
    criadoEm: iso(linha.criado_em),
    concluidoEm: iso(linha.concluido_em),
    erroCodigo: linha.erro_codigo,
    geradoPor: { nome: linha.gerado_por_nome ?? null },
  };
}

// ─── CSV e JSON (streaming) ─────────────────────────────────────────

const CELULA_PERIGOSA = /^[=+\-@\t\r]/;
function celulaCsv(valor) {
  if (valor === null || valor === undefined) return '""';
  let texto = typeof valor === 'string' ? valor : String(valor);
  if (typeof valor === 'string' && CELULA_PERIGOSA.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}
const linhaCsv = (colunas, linha) => `${colunas.map((c) => celulaCsv(linha[c])).join(';')}\r\n`;

function colunasDe(escopo, saida) {
  if (escopo !== 'TRILHA_AUDITORIA') return saida.colunas;
  const colunas = [...saida.colunas];
  colunas.splice(colunas.indexOf('referencia') + 1, 0, 'referencia_amigavel');
  return Object.freeze(colunas);
}

async function* lotesDe(executor, ator, escopo, saida, contexto, contador) {
  let cursor = null;
  do {
    const { linhas, cursor: proximo } = await modulosRepo.lerLote(executor, escopo, saida.id, contexto, cursor, LOTE_LINHAS);
    if (escopo === 'TRILHA_AUDITORIA') {
      const amigaveis = await referenciasAmigaveis(executor, ator.empresaId, linhas);
      linhas.forEach((l, i) => { l.referencia_amigavel = amigaveis[i]; });
    }
    contador.linhas += linhas.length;
    yield linhas;
    cursor = proximo;
  } while (cursor);
}

async function* csvDe(executor, ator, escopo, saida, contexto, contador) {
  const colunas = colunasDe(escopo, saida);
  yield Buffer.from(BOM + linhaCsv(colunas, Object.fromEntries(colunas.map((c) => [c, c]))));
  for await (const linhas of lotesDe(executor, ator, escopo, saida, contexto, contador)) {
    if (linhas.length) yield Buffer.from(linhas.map((l) => linhaCsv(colunas, l)).join(''));
  }
}

async function* jsonDe(executor, ator, escopo, saida, contexto, contador) {
  const colunas = colunasDe(escopo, saida);
  let primeiro = true;
  for await (const linhas of lotesDe(executor, ator, escopo, saida, contexto, contador)) {
    if (!linhas.length) continue;
    const corpo = linhas.map((l) => `  ${JSON.stringify(Object.fromEntries(colunas.map((c) => [c, l[c] ?? null])))}`).join(',\n');
    yield Buffer.from(`${primeiro ? '[\n' : ',\n'}${corpo}`);
    primeiro = false;
  }
  yield Buffer.from(primeiro ? '[]\n' : '\n]\n');
}

async function* medir(registro, nome, contador, origem) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const bloco of origem) {
    hash.update(bloco);
    bytes += bloco.length;
    yield bloco;
  }
  registro.set(nome, { sha256: hash.digest('hex'), bytes, linhas: contador.linhas });
}

function textoLeiame({ id, periodo, finalidade, escopos }) {
  return [
    'PACOTE DE DOCUMENTAÇÃO PARA FISCALIZAÇÃO E AUDITORIA',
    '',
    `Pacote ${id} · período ${periodo.inicio} a ${periodo.fim} · finalidade ${finalidade}.`,
    'Documentação digital preparada a partir dos registros do sistema, em CSV (para planilhas) e JSON (para sistemas).',
    '',
    'Módulos incluídos:',
    ...escopos.map((e) => `- ${ROTULOS[e]}`),
    '',
    'Definições:',
    `- DESENHO: ${DEFINICOES.DESENHO}`,
    `- ACEITE_PRESENCIAL: ${DEFINICOES.ACEITE_PRESENCIAL}`,
    `- hash_conteudo: ${DEFINICOES.hash_conteudo}`,
    '',
    'Limitações:',
    ...LIMITACOES.map((l) => `- ${l}`),
    '',
    'O arquivo manifesto.json traz os metadados do pacote e o SHA-256 de cada arquivo interno.',
    '',
  ].join('\r\n');
}

// ─── Serviço ────────────────────────────────────────────────────────

function criarFiscalizacaoPacoteService({ pool, armazenamento, config }) {
  const contexto = (ator, n) => ({ empresaId: ator.empresaId, inicio: n.periodoInicio, fim: n.periodoFim });

  async function contarModulos(executor, ctx, escopos) {
    const resultado = [];
    for (const escopo of escopos) resultado.push({ escopo, ...(await modulosRepo.contarEscopo(executor, escopo, ctx)) });
    return resultado;
  }

  function exigirDentroDoLimite(contagens) {
    const limite = config.limiteLinhasPorModulo;
    const excedido = contagens.find((c) => c.total > limite);
    if (excedido) throw erroLimiteLinhas(excedido.escopo, excedido.total, limite);
  }

  async function previa(ator, entrada) {
    const n = normalizar(entrada);
    const { dias } = validarPedido(n);
    const contagens = await contarModulos(pool, contexto(ator, n), n.escopos);
    const limite = config.limiteLinhasPorModulo;
    const escopos = contagens.map((c) => ({
      escopo: c.escopo, rotulo: ROTULOS[c.escopo], linhas: c.total, vazio: c.total === 0, excedeLimite: c.total > limite,
    }));
    const podeGerar = escopos.every((e) => !e.excedeLimite);
    return {
      periodo: { inicio: n.periodoInicio, fim: n.periodoFim, dias },
      limiteLinhasPorModulo: limite,
      podeGerar,
      ...(podeGerar ? {} : { orientacao: 'Reduza o período para que cada módulo fique dentro do limite de linhas.' }),
      escopos,
    };
  }

  function reutilizar(linha, hash) {
    if (linha.requisicao_hash !== hash) {
      throw new HttpError(409, 'IDEMPOTENCIA_CONFLITO', 'Esta chave de idempotência já foi usada para um pedido diferente. Use uma nova chave.');
    }
    return { pacote: pacoteDto(linha), criado: false };
  }

  async function reservar(ator, n, chave, hash) {
    const client = await pool.connect();
    let resultado;
    try {
      await client.query('BEGIN');
      await pacoteRepo.travarEmpresa(client, ator.empresaId);
      const existente = await pacoteRepo.buscarPorChave(client, ator.empresaId, chave);
      if (existente) {
        resultado = { existente };
      } else if (await pacoteRepo.existeGerando(client, ator.empresaId)) {
        resultado = { emAndamento: true };
      } else {
        resultado = {
          novo: await pacoteRepo.inserirGerando(client, {
            empresaId: ator.empresaId, usuarioId: ator.usuarioId, perfil: ator.perfil, periodoInicio: n.periodoInicio, periodoFim: n.periodoFim,
            finalidade: n.finalidade, observacao: n.observacao, escopos: n.escopos, versaoFormato: VERSAO_FORMATO, chaveIdempotencia: chave, requisicaoHash: hash,
          }),
        };
      }
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      if (erro.code === '23505') resultado = { emAndamento: true };
      else throw erro;
    } finally {
      client.release();
    }
    return resultado;
  }

  const emAndamento = () => new HttpError(409, 'GERACAO_EM_ANDAMENTO', 'Já existe uma geração em andamento para esta empresa. Aguarde a conclusão.');

  async function gerar(ator, entrada) {
    const n = normalizar(entrada);
    const chave = entrada.chaveIdempotencia;
    const hash = hashDoPedido(n);

    // 1) a mesma chave devolve a tentativa existente (ou 409 se o pedido mudou), antes de qualquer validação de dados.
    const anterior = await pacoteRepo.buscarPorChave(pool, ator.empresaId, chave);
    if (anterior) return reutilizar(anterior, hash);

    // 2) validação do período e dos limites, repetida aqui porque os dados podem ter mudado desde a prévia. Nada é gravado se falhar.
    validarPedido(n);
    exigirDentroDoLimite(await contarModulos(pool, contexto(ator, n), n.escopos));

    // 3) reserva da tentativa: serializada por empresa; uma geração por vez.
    const reserva = await reservar(ator, n, chave, hash);
    if (reserva.existente) return reutilizar(reserva.existente, hash);
    if (reserva.emAndamento) throw emAndamento();
    return { pacote: await executarGeracao(ator, n, reserva.novo), criado: true };
  }

  async function registrarFalha(ator, id, codigo) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const marcou = await pacoteRepo.falhar(client, ator.empresaId, id, codigo);
      if (marcou) {
        await auditoriaRepo.registrar(client, {
          empresaId: ator.empresaId, usuarioId: ator.usuarioId, acao: 'FISCALIZACAO_PACOTE_FALHOU', referencia: String(id),
          ip: ator.ip ?? null, dispositivo: ator.dispositivo ?? null, contexto: { pacoteId: id, erro: codigo },
        });
      }
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      client.release();
    }
  }

  async function executarGeracao(ator, n, novo) {
    const id = novo.id;
    const { empresaId } = ator;
    const ctx = contexto(ator, n);
    let perdido = false;
    let gravador = null;
    // Laço de heartbeat DESTA geração (nunca um timer de manutenção da API): cada batida só é agendada depois da anterior terminar,
    // então não há sobreposição, e ele para quando a geração termina.
    let batimento = null;
    let encerrada = false;
    const agendar = () => {
      if (encerrada) return;
      batimento = setTimeout(async () => {
        try {
          const ok = await pacoteRepo.renovarHeartbeat(pool, empresaId, id);
          if (!ok && !perdido) {
            perdido = true;
            if (gravador) gravador.abortar().catch(() => {});
          }
        } catch { /* a próxima batida tenta de novo; o abandono só ocorre depois do prazo */ }
        agendar();
      }, config.heartbeatMs);
      batimento.unref();
    };
    agendar();

    const instantaneo = await pool.connect();
    try {
      await instantaneo.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const empresa = await pacoteRepo.buscarEmpresa(instantaneo, empresaId);
      const contagens = await contarModulos(instantaneo, ctx, n.escopos);
      exigirDentroDoLimite(contagens);

      gravador = await armazenamento.iniciar({ empresaId, pacoteId: id });
      const registro = new Map();
      const totais = new Map();
      const periodo = { inicio: n.periodoInicio, fim: n.periodoFim };
      const arquivos = [{ nome: 'LEIAME.txt', conteudo: (async function* () { yield Buffer.from(textoLeiame({ id, periodo, finalidade: n.finalidade, escopos: n.escopos })); }()) }];
      const ordem = [];
      for (const escopo of n.escopos) {
        for (const saida of modulosRepo.saidasDe(escopo)) {
          for (const [extensao, gerador] of [['csv', csvDe], ['json', jsonDe]]) {
            const nome = `${saida.arquivo}.${extensao}`;
            const contador = { linhas: 0 };
            ordem.push({ nome, escopo, extensao, contador });
            arquivos.push({ nome, conteudo: medir(registro, nome, contador, gerador(instantaneo, ator, escopo, saida, ctx, contador)) });
          }
        }
      }
      arquivos.push({
        nome: 'manifesto.json',
        conteudo: (async function* () {
          const porEscopo = {};
          for (const e of n.escopos) {
            const csv = ordem.filter((o) => o.escopo === e && o.extensao === 'csv');
            porEscopo[e] = csv.reduce((soma, o) => soma + registro.get(o.nome).linhas, 0);
          }
          totais.set('contagens', porEscopo);
          yield Buffer.from(`${JSON.stringify({
            versaoFormato: VERSAO_FORMATO,
            geradoEm: new Date().toISOString(),
            pacote: { id },
            empresa: { nome: empresa?.nome ?? null, cnpj: empresa?.cnpj ?? null },
            periodo,
            finalidade: n.finalidade,
            observacao: n.observacao,
            geradoPor: { nome: novo.gerado_por_nome ?? null, perfil: novo.perfil_ator },
            escopos: n.escopos,
            modulos: n.escopos.map((e) => ({ escopo: e, rotulo: ROTULOS[e], arquivos: ordem.filter((o) => o.escopo === e).map((o) => o.nome) })),
            contagens: porEscopo,
            arquivos: ordem.map((o) => ({ nome: o.nome, ...registro.get(o.nome) })),
            definicoes: DEFINICOES,
            limitacoes: LIMITACOES,
          }, null, 2)}\n`);
        }()),
      });

      await escreverZipLimitado(arquivos, gravador.escrita, { limiteBytes: config.limiteBytesZip });
      await instantaneo.query('COMMIT');
      const publicado = await gravador.publicar();

      const nomeLogico = `fiscalizacao-${String(id).padStart(6, '0')}-${n.periodoInicio}-${n.periodoFim}.zip`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const concluido = await pacoteRepo.concluir(client, empresaId, id, {
          contagens: totais.get('contagens'), nomeLogico, tamanhoBytes: publicado.tamanhoBytes, sha256: publicado.sha256, chaveArmazenamento: publicado.chave,
        });
        if (!concluido) throw new HttpError(409, 'GERACAO_ABANDONADA', 'A geração foi encerrada antes de concluir.');
        await auditoriaRepo.registrar(client, {
          empresaId, usuarioId: ator.usuarioId, acao: 'FISCALIZACAO_PACOTE_GERADO', referencia: String(id), ip: ator.ip ?? null, dispositivo: ator.dispositivo ?? null,
          contexto: {
            pacoteId: id, escopos: n.escopos, contagens: totais.get('contagens'), sha256: publicado.sha256, tamanhoBytes: publicado.tamanhoBytes,
            periodoInicio: n.periodoInicio, periodoFim: n.periodoFim, finalidade: n.finalidade, comObservacao: n.observacao !== null,
          },
        });
        await client.query('COMMIT');
      } catch (erro) {
        await client.query('ROLLBACK').catch(() => {});
        throw erro;
      } finally {
        client.release();
      }
      return pacoteDto(await pacoteRepo.buscarPorId(pool, empresaId, id));
    } catch (erro) {
      await instantaneo.query('ROLLBACK').catch(() => {});
      if (gravador) await gravador.abortar().catch(() => {});
      await armazenamento.removerResiduos({ empresaId, pacoteId: id }).catch(() => {});
      if (perdido) throw new HttpError(409, 'GERACAO_ABANDONADA', 'A geração foi encerrada antes de concluir. Inicie uma nova geração com uma nova chave.');
      if (erro instanceof ErroZip && erro.codigo === 'ZIP_EXCEDE_LIMITE') {
        await registrarFalha(ator, id, 'ZIP_EXCEDE_LIMITE');
        throw new HttpError(400, 'PACOTE_EXCEDE_TAMANHO', ERRO_PACOTE_GRANDE);
      }
      if (HttpError.ehHttpError(erro) && erro.codigo === 'LIMITE_LINHAS_EXCEDIDO') {
        await registrarFalha(ator, id, 'LIMITE_LINHAS_EXCEDIDO');
        throw erro;
      }
      await registrarFalha(ator, id, 'ERRO_GERACAO').catch(() => {});
      throw erro;
    } finally {
      encerrada = true;
      clearTimeout(batimento);
      instantaneo.release();
    }
  }

  async function listar(ator, { pagina, limite }) {
    const [linhas, total] = await Promise.all([pacoteRepo.listar(pool, ator.empresaId, { pagina, limite }), pacoteRepo.contar(pool, ator.empresaId)]);
    return { itens: linhas.map(pacoteDto), total, pagina, limite };
  }

  const naoEncontrado = () => new HttpError(404, 'PACOTE_NAO_ENCONTRADO', 'Pacote não encontrado');

  async function obter(ator, id) {
    const linha = await pacoteRepo.buscarPorId(pool, ator.empresaId, id);
    if (!linha) throw naoEncontrado();
    return pacoteDto(linha);
  }

  async function sha256Do(fluxo) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const bloco of fluxo) {
      hash.update(bloco);
      bytes += bloco.length;
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  /** Reconfere o SHA-256 e o tamanho antes de servir; arquivo adulterado ou ausente falha sem entregar nenhum byte. */
  async function abrirDownload(ator, id) {
    const linha = await pacoteRepo.buscarPorId(pool, ator.empresaId, id);
    if (!linha) throw naoEncontrado();
    if (linha.status !== 'CONCLUIDO') throw new HttpError(409, 'PACOTE_NAO_CONCLUIDO', 'O pacote ainda não está concluído ou a geração falhou.');
    let conferido;
    try {
      conferido = await sha256Do(await armazenamento.abrir(linha.chave_armazenamento));
    } catch (erro) {
      throw new HttpError(500, 'PACOTE_ARQUIVO_INDISPONIVEL', 'Arquivo do pacote indisponível.', { causa: erro });
    }
    if (conferido.sha256 !== linha.sha256 || conferido.bytes !== Number(linha.tamanho_bytes)) {
      throw new HttpError(500, 'PACOTE_INTEGRIDADE', 'A verificação de integridade do pacote falhou.');
    }
    await auditoriaRepo.registrar(pool, {
      empresaId: ator.empresaId, usuarioId: ator.usuarioId, acao: 'FISCALIZACAO_PACOTE_BAIXADO', referencia: String(id), ip: ator.ip ?? null,
      dispositivo: ator.dispositivo ?? null, contexto: { pacoteId: id },
    });
    return { fluxo: await armazenamento.abrir(linha.chave_armazenamento), nomeArquivo: linha.nome_logico, tamanhoBytes: Number(linha.tamanho_bytes) };
  }

  /**
   * Rotina GLOBAL INTERNA (cron): reclama as gerações sem heartbeat, remove os artefatos (temporário e ZIP final órfãos, localizados por
   * empresa e id) e SÓ DEPOIS marca FALHA (GERACAO_ABANDONADA). Nunca promove a CONCLUIDO. Se a limpeza falhar, a transação desfaz tudo
   * e a tentativa continua GERANDO para a próxima rodada.
   */
  async function recuperarAbandonados() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reclamadas = await pacoteRepo.reivindicarAbandonados(client, config.abandonoMs);
      for (const r of reclamadas) {
        await armazenamento.removerResiduos({ empresaId: r.empresa_id, pacoteId: r.id });
        await pacoteRepo.falhar(client, r.empresa_id, r.id, 'GERACAO_ABANDONADA');
        await auditoriaRepo.registrar(client, {
          empresaId: r.empresa_id, usuarioId: null, acao: 'FISCALIZACAO_PACOTE_ABANDONADO', referencia: String(r.id), contexto: { pacoteId: r.id },
        });
      }
      await client.query('COMMIT');
      return { recuperados: reclamadas.length };
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      client.release();
    }
  }

  return { previa, gerar, listar, obter, abrirDownload, recuperarAbandonados };
}

module.exports = { criarFiscalizacaoPacoteService, ROTULOS, DEFINICOES, LIMITACOES, VERSAO_FORMATO, MIB };
