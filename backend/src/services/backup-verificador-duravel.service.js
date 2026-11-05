'use strict';

const { localizarArmazenamentoDuravel } = require('./imagem-backup-durabilidade.service');
const { identidadeConfere, AMBIENTES, COMPROVACOES_POSTERIORES } = require('./backup-armazenamento-duravel-fichas.service');
const { consolidarRecibos } = require('./backup-recibo-duravel.service');

/**
 * D-ORF-6, R-D45 (D-F4): VERIFICADOR INDEPENDENTE, SOMENTE LEITURA. Compara o que está no bucket com os recibos do conjunto, com a credencial do VERIFICADOR (outra
 * identidade, fora do host de backup). A confirmação do publicador prova só o que ele viu; esta conferência é a prova independente exigida para declarar um backup
 * restaurável. Não grava, não apaga, não lê o conteúdo dos objetos: só lista versões e lê metadados.
 *
 * Porta do VERIFICADOR (somente estas três operações):
 *  - `identidade() -> { contaId, arn }`  (tem de ser a identidade do verificador da ficha; a do publicador ou da restauração NÃO é independente)
 *  - `listarVersoes({ bucket, donoEsperado, prefixo }) -> [{ chave, versaoId, ehAtual, marcadorDeExclusao }]`
 *  - `lerMetadadosDaVersao({ bucket, donoEsperado, chave, versaoId }) -> { bytes, sha256, retencao: { modo, ate } | null }`
 * Por recibo: CONFORME (a versão existe, SHA-256 e bytes iguais, retenção presente, do modo da ficha e não expirada, e ainda é a versão atual), AUSENTE ou DIVERGENTE
 * (com códigos fixos). Além dos recibos: versão EXTRA sob o mesmo nome, objeto SEM recibo e MARCADOR de exclusão reprovam o conjunto. Falha ao consultar nunca vira conformidade.
 */

const PRAZO_PADRAO_MS = 60000;
const PRAZO_MAXIMO_MS = 600000;
const LIMITE_VERSOES = 1000000;
const SHA256 = /^[0-9a-f]{64}$/;
const METODOS_DA_PORTA = Object.freeze(['identidade', 'listarVersoes', 'lerMetadadosDaVersao']);
const OPCOES = Object.freeze(['destinoId', 'ambiente', 'cliente', 'relogio', 'prazoMs', 'registro']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do verificador inválida'), { code: 'CONFIGURACAO_INVALIDA' });

function criarVerificadorIndependente(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !['destinoId', 'ambiente', 'cliente'].every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida();
  const { destinoId, ambiente, cliente, registro } = opcoes;
  const relogio = opcoes.relogio === undefined ? () => Date.now() : opcoes.relogio;
  const prazoMs = opcoes.prazoMs === undefined ? PRAZO_PADRAO_MS : opcoes.prazoMs;
  if (typeof destinoId !== 'string' || !AMBIENTES.includes(ambiente) || typeof relogio !== 'function') throw configuracaoInvalida();
  if (!ehObjeto(cliente) || !METODOS_DA_PORTA.every((m) => typeof cliente[m] === 'function')) throw configuracaoInvalida();
  if (!Number.isSafeInteger(prazoMs) || prazoMs < 1 || prazoMs > PRAZO_MAXIMO_MS) throw configuracaoInvalida();
  const achado = localizarArmazenamentoDuravel(destinoId, ambiente, registro);
  if (!achado.encontrada) throw Object.assign(new Error('destino durável não autorizado'), { code: 'DESTINO_DURAVEL_NAO_AUTORIZADO', motivo: achado.motivo });
  const { ficha, origem } = achado;
  const { verificador, publicador, restauracao } = ficha.identidades;

  const comPrazo = (executar) => new Promise((resolver, rejeitar) => {
    const timer = setTimeout(() => rejeitar(Object.assign(new Error('prazo'), { code: 'PRAZO' })), prazoMs);
    Promise.resolve().then(executar).then((v) => { clearTimeout(timer); resolver(v); }, (e) => { clearTimeout(timer); rejeitar(e); });
  });
  const consultar = async (executar) => { try { return { ok: true, valor: await comPrazo(executar) }; } catch { return { ok: false, valor: null }; } };
  const recusa = (motivo) => Object.freeze({ conforme: false, motivo, itens: Object.freeze([]), extras: Object.freeze([]), resumo: Object.freeze({ conformes: 0, ausentes: 0, divergentes: 0, extras: 0 }), comprovacoesPendentes: COMPROVACOES_POSTERIORES });
  const entradaDaListagem = (e) => ehObjeto(e) && chavesExatas(e, ['chave', 'versaoId', 'ehAtual', 'marcadorDeExclusao']) && typeof e.chave === 'string' && typeof e.versaoId === 'string' && typeof e.ehAtual === 'boolean' && typeof e.marcadorDeExclusao === 'boolean';
  const metadadosValidos = (m) => ehObjeto(m) && chavesExatas(m, ['bytes', 'sha256', 'retencao']) && Number.isSafeInteger(m.bytes) && typeof m.sha256 === 'string' && SHA256.test(m.sha256)
    && (m.retencao === null || (ehObjeto(m.retencao) && chavesExatas(m.retencao, ['modo', 'ate']) && typeof m.retencao.modo === 'string' && typeof m.retencao.ate === 'string'));

  function codigosDeRetencao(retencao) {
    if (retencao === null) return ['RETENCAO_AUSENTE'];
    const ate = Date.parse(retencao.ate);
    if (Number.isNaN(ate)) return ['RETENCAO_AUSENTE'];
    const codigos = [];
    if (retencao.modo !== ficha.retencao.modo) codigos.push('RETENCAO_MODO_DIVERGENTE');
    if (ate <= relogio()) codigos.push('RETENCAO_EXPIRADA');
    return codigos;
  }

  async function verificar(consolidado) {
    if (!ehObjeto(consolidado)) return recusa('CONSOLIDADO_INVALIDO');
    const lido = consolidarRecibos({ destinoId: consolidado.destinoId, ambiente: consolidado.ambiente, conjuntoId: consolidado.conjuntoId, recibos: Array.isArray(consolidado.recibos) ? [...consolidado.recibos] : consolidado.recibos });
    if (!lido.ok) return recusa('CONSOLIDADO_INVALIDO');
    const { conjuntoId, recibos } = lido.consolidado;
    if (lido.consolidado.destinoId !== ficha.id || lido.consolidado.ambiente !== ficha.ambiente || recibos.some((r) => r.bucket !== ficha.bucket)) return recusa('DESTINO_DIVERGENTE');

    const identidade = await consultar(() => cliente.identidade());
    if (!identidade.ok || !ehObjeto(identidade.valor)) return recusa('FALHA_AO_CONSULTAR');
    if (!identidadeConfere(verificador, identidade.valor)) return recusa(identidadeConfere(publicador, identidade.valor) || identidadeConfere(restauracao, identidade.valor) ? 'IDENTIDADE_NAO_INDEPENDENTE' : 'IDENTIDADE_DIVERGENTE');

    const listagem = await consultar(() => cliente.listarVersoes({ bucket: ficha.bucket, donoEsperado: ficha.contaId, prefixo: `${ficha.prefixo}${conjuntoId}/` }));
    if (!listagem.ok || !Array.isArray(listagem.valor) || listagem.valor.length > LIMITE_VERSOES || !listagem.valor.every(entradaDaListagem)) return recusa('FALHA_AO_CONSULTAR');
    const versoes = listagem.valor;
    const reciboDaChave = new Map(recibos.map((r) => [r.chave, r]));

    const itens = [];
    for (const r of recibos) {
      const propria = versoes.find((e) => e.chave === r.chave && e.versaoId === r.versaoId && !e.marcadorDeExclusao);
      if (propria === undefined) { itens.push(Object.freeze({ chave: r.chave, versaoId: r.versaoId, estado: 'AUSENTE', codigos: Object.freeze(['VERSAO_AUSENTE']) })); continue; }
      const codigos = [];
      const md = await consultar(() => cliente.lerMetadadosDaVersao({ bucket: ficha.bucket, donoEsperado: ficha.contaId, chave: r.chave, versaoId: r.versaoId }));
      if (!md.ok || !metadadosValidos(md.valor)) codigos.push('FALHA_AO_CONSULTAR');
      else {
        if (md.valor.sha256 !== r.sha256) codigos.push('SHA256_DIVERGENTE');
        if (md.valor.bytes !== r.bytes) codigos.push('BYTES_DIVERGENTES');
        codigos.push(...codigosDeRetencao(md.valor.retencao));
      }
      if (!propria.ehAtual) codigos.push('VERSAO_DO_RECIBO_NAO_E_A_ATUAL');
      itens.push(Object.freeze({ chave: r.chave, versaoId: r.versaoId, estado: codigos.length === 0 ? 'CONFORME' : 'DIVERGENTE', codigos: Object.freeze(codigos) }));
    }

    const extras = [];
    for (const e of versoes) {
      const r = reciboDaChave.get(e.chave);
      if (e.marcadorDeExclusao) extras.push(Object.freeze({ chave: e.chave, versaoId: e.versaoId, codigo: 'MARCADOR_DE_EXCLUSAO' }));
      else if (r === undefined) extras.push(Object.freeze({ chave: e.chave, versaoId: e.versaoId, codigo: 'OBJETO_SEM_RECIBO' }));
      else if (r.versaoId !== e.versaoId) extras.push(Object.freeze({ chave: e.chave, versaoId: e.versaoId, codigo: 'VERSAO_EXTRA' }));
    }
    const resumo = Object.freeze({
      conformes: itens.filter((i) => i.estado === 'CONFORME').length,
      ausentes: itens.filter((i) => i.estado === 'AUSENTE').length,
      divergentes: itens.filter((i) => i.estado === 'DIVERGENTE').length,
      extras: extras.length,
    });
    return Object.freeze({ conforme: resumo.conformes === itens.length && extras.length === 0, motivo: null, itens: Object.freeze(itens), extras: Object.freeze(extras), resumo, comprovacoesPendentes: COMPROVACOES_POSTERIORES });
  }

  return Object.freeze({ destino: Object.freeze({ id: ficha.id, ambiente: ficha.ambiente, bucket: ficha.bucket, regiao: ficha.regiao, origem }), verificar });
}

module.exports = { criarVerificadorIndependente, METODOS_DA_PORTA };
