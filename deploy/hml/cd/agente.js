'use strict';
const fs = require('node:fs');
const path = require('node:path');
const N = require('../instalador/nucleo');
const I = require('../instalador/instalar-release');
const { criarAncora } = require('../instalador/ancora');
const { verificarPublicacao } = require('../verificacao/verificar-publicacao');
const { criarS3 } = require('./s3');
const P = require('./protocolo');
const igual = (a, b) => a.rotulo === b.rotulo && a.commit === b.commit;
function saudavel(s) {
  P.exigir(s && s.instalado === true && s.integro === true && s.consistente === true && s.garantiaContraCorrida === true && N.SHA_COMPLETO.test(s.commit) && N.ROTULO.test(s.rotulo), 'BASELINE_NAO_COMPROVADA');
  return s;
}
// A API é uma só e não é alterada pelo agente: conferida uma vez por fase, na origem configurada (Portal ou apiSaude),
// nunca na origem do Painel, cujo modelo Nginx devolve 404 em /api/ fora de /api/plataforma/.
async function aplicar({ pedido, releaseDir, deps, agora = Date.now }) {
  P.exigir(deps && typeof deps.verificarApi === 'function', 'DEPENDENCIAS_INCOMPLETAS');
  P.validarPedido(pedido, agora());
  const rel = P.conferirRelease({ dir: releaseDir, ...pedido });
  const antes = {};
  for (const c of P.COMPONENTES) {
    antes[c] = saudavel(await deps.identificar(c));
    P.exigir(await deps.verificar(c, antes[c]), 'PRE_DEPLOY_HTTP');
  }
  P.exigir(await deps.verificarApi(), 'PRE_DEPLOY_HTTP');
  P.validarPedido(pedido, agora());
  await deps.registrar({ fase: 'PREPARADO', antes });
  try {
    for (const c of P.COMPONENTES) {
      P.validarPedido(pedido, agora());
      P.exigir(igual(saudavel(await deps.identificar(c)), antes[c]), 'BASELINE_MUDOU');
      await deps.instalar(c, { releaseSha256Esperado: pedido.releaseSha256, exigirDurabilidade: true, permitirAnterior: pedido.permitirAnterior, permitirRetroativo: pedido.permitirAnterior });
      const atual = saudavel(await deps.identificar(c));
      P.exigir(igual(atual, rel.release) && await deps.verificar(c, atual) && await deps.verificarApi(), 'POS_DEPLOY_HTTP');
      await deps.registrar({ fase: 'COMPONENTE_VERIFICADO', componente: c, antes });
    }
    for (const c of P.COMPONENTES) {
      const atual = saudavel(await deps.identificar(c));
      P.exigir(igual(atual, rel.release) && await deps.verificar(c, atual), 'POS_DEPLOY_FINAL');
    }
    P.exigir(await deps.verificarApi(), 'POS_DEPLOY_FINAL');
    return { estado: 'SUCESSO', verificado: true };
  } catch {
    let recuperado = true;
    for (const c of [...P.COMPONENTES].reverse()) {
      try {
        const atual = saudavel(await deps.identificar(c));
        if (!igual(atual, antes[c])) {
          P.exigir(igual(atual, rel.release) && atual.anterior === antes[c].rotulo, 'ROLLBACK_ALVO_DIVERGENTE');
          await deps.reverter(c);
        }
        const voltou = saudavel(await deps.identificar(c));
        P.exigir(igual(voltou, antes[c]) && await deps.verificar(c, voltou), 'ROLLBACK_NAO_COMPROVADO');
      } catch { recuperado = false; }
    }
    return { estado: recuperado ? 'FALHOU' : 'CRITICO', verificado: false, recuperacaoComprovada: recuperado };
  }
}
function validarConfiguracao(cfg) {
  P.exigir(cfg && cfg.habilitado === true && cfg.isolamentoRevisado === 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_SEM_INSTITUCIONAL', 'AGENTE_DESABILITADO');
  const instalador = N.validarConfig(cfg.instalador);
  P.exigir(Object.keys(instalador.componentes).sort().join(',') === 'painel,portal' && P.COMPONENTES.every(c => instalador.componentes[c].tipo === 'estatico'), 'ESCOPO_INVALIDO');
  P.exigir(Array.isArray(cfg.raizesProtegidas) && cfg.raizesProtegidas.length > 0 && cfg.raizesProtegidas.every(p => path.isAbsolute(p)), 'RAIZES_PROTEGIDAS_OBRIGATORIAS');
  const protegidas = cfg.raizesProtegidas.map(p => fs.realpathSync(p));
  const estado = fs.realpathSync(cfg.estadoDir);
  const bases = P.COMPONENTES.map(c => fs.realpathSync(instalador.componentes[c].base));
  for (const base of bases) P.exigir(!protegidas.some(p => N.sobrepoe(p, base)) && !N.sobrepoe(estado, base), 'RAIZ_PROTEGIDA');
  P.exigir(!N.sobrepoe(bases[0], bases[1]) && !protegidas.some(p => N.sobrepoe(p, estado)), 'RAIZ_PROTEGIDA');
  P.exigir(cfg.urls && new Set(Object.values(cfg.urls)).size === 2, 'ORIGENS_INVALIDAS');
  for (const c of P.COMPONENTES) {
    const u = new URL(cfg.urls[c]);
    P.exigir(u.protocol === 'https:' && u.origin === cfg.urls[c] && !u.username && !u.password, 'ORIGENS_INVALIDAS');
  }
  if (cfg.apiSaude !== undefined) {
    P.exigir(typeof cfg.apiSaude === 'string', 'API_SAUDE_INVALIDA');
    let u;
    try { u = new URL(cfg.apiSaude); } catch { P.exigir(false, 'API_SAUDE_INVALIDA'); }
    const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    P.exigir(u.origin === cfg.apiSaude && !u.username && !u.password && (u.protocol === 'https:' || local), 'API_SAUDE_INVALIDA');
  }
  return cfg;
}
const origemDaApi = cfg => cfg.apiSaude || cfg.urls.portal;
function dependencias(cfg, releaseDir, registrar) {
  const config = cfg.instalador;
  async function verificar(c, s) {
    const A = criarAncora();
    let meta;
    try {
      const ctx = N.abrirContexto(A, N.validarConfig(config).componentes[c]);
      meta = N.lerMeta(ctx, s.rotulo);
    } finally { A.fecharTudo(); }
    P.exigir(meta && igual(meta, s), 'META_DIVERGENTE');
    const outro = c === 'portal' ? 'painel' : 'portal';
    const outraIdentidade = saudavel(await I.identificar({ config, componente: outro }));
    const B = criarAncora();
    let outraMeta;
    try { outraMeta = N.lerMeta(N.abrirContexto(B, N.validarConfig(config).componentes[outro]), outraIdentidade.rotulo); }
    finally { B.fecharTudo(); }
    const ausentes = Object.keys(outraMeta.manifesto).filter(p => !Object.hasOwn(meta.manifesto, p));
    const estatico = await verificarPublicacao({ baseUrl: cfg.urls[c], tipo: 'estatico', versaoEsperada: { componente: c, commit: meta.commit, rotulo: meta.rotulo, manifestoSha256: meta.manifestoSha256 }, manifesto: meta.manifesto, ausentes });
    return estatico.ok;
  }
  const verificarApi = async () => (await verificarPublicacao({ baseUrl: origemDaApi(cfg), tipo: 'api' })).ok;
  return {
    identificar: c => I.identificar({ config, componente: c }),
    instalar: (c, opcoes) => I.instalar({ config, componente: c, release: releaseDir, opcoes }),
    reverter: c => I.reverter({ config, componente: c, opcoes: { exigirDurabilidade: true } }),
    verificar, verificarApi, registrar,
  };
}
async function processar({ cfg, id, s3 }) {
  P.exigir(P.ID.test(id), 'ID_INVALIDO');
  const A = criarAncora({ exigirDurabilidade: true });
  let base, trava, liberar = false;
  const seguro = r => r && ((r.estado === 'RECUSADO' && r.mutacao === 'NENHUMA') || (r.estado === 'SUCESSO' && r.verificado === true) || (r.estado === 'FALHOU' && r.recuperacaoComprovada === true));
  try {
    base = A.abrirBase(cfg.estadoDir);
    trava = A.criarExclusivo(base, '.trava-cd');
    const anterior = A.lerTexto(base, `${id}.json`);
    let pedido = null, mutacaoIniciada = false, origemIncerta = false, resultado, rastro = {};
    const registrar = async detalhe => {
      const proximo = { ...rastro, ...detalhe, versao: 2, id, pedido };
      A.escreverAtomico(base, `${id}.json`, JSON.stringify(proximo));
      rastro = proximo;
    };
    const publicarRecibo = async recibo => {
      if (!recibo) return { reciboPendente: true };
      let existente;
      try { existente = await s3.get(`hml/recibos/${id}.json`); }
      catch { return { reciboPendente: true }; }
      if (existente !== null) {
        if (existente.toString() !== JSON.stringify(recibo)) {
          liberar = false;
          await registrar({ fase: 'TERMINAL', resultado: { estado: 'CRITICO', verificado: false, motivo: 'RECIBO_DIVERGENTE' } });
          P.exigir(false, 'RECIBO_DIVERGENTE');
        }
      } else {
        try { await s3.put(`hml/recibos/${id}.json`, Buffer.from(JSON.stringify(recibo))); }
        catch { return { reciboPendente: true }; }
      }
      return {};
    };
    if (anterior !== null) {
      const registro = JSON.parse(anterior);
      P.exigir(registro.versao === 2 && registro.id === id && registro.fase === 'TERMINAL' && seguro(registro.resultado), 'OPERACAO_PENDENTE_OU_CRITICA');
      pedido = registro.pedido; rastro = registro;
      liberar = true;
      return { id, ...registro.resultado, ...await publicarRecibo(registro.recibo) };
    }
    await registrar({ fase: 'INICIO', mutacao: 'NENHUMA' });
    try {
      const b = await s3.get(`hml/pedidos/${id}.json`);
      P.exigir(b !== null, 'PEDIDO_AUSENTE');
      const candidato = P.validarEstruturaPedido(P.json(b));
      P.exigir(candidato.id === id, 'ID_DIVERGENTE');
      pedido = candidato;
      P.validarPedido(pedido);
      const blob = await s3.get(`hml/blobs/${id}.json`);
      P.exigir(blob !== null && N.sha256(blob) === pedido.blobSha256, 'BLOB_DIVERGENTE');
      const dir = path.join(cfg.estadoDir, `entrada-${id}`);
      try { origemIncerta = Boolean(fs.lstatSync(dir)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      P.exigir(!origemIncerta, 'ENTRADA_PREEXISTENTE');
      P.extrair(blob, dir);
      P.conferirRelease({ dir, ...pedido });
      const deps = dependencias(cfg, dir, registrar);
      const instalar = deps.instalar;
      deps.instalar = async (c, opcoes) => {
        await registrar({ fase: 'INSTALACAO_INICIADA', componente: c });
        mutacaoIniciada = true;
        return instalar(c, opcoes);
      };
      resultado = await aplicar({ pedido, releaseDir: dir, deps });
      if (!seguro(resultado) && resultado.estado !== 'CRITICO') resultado = { estado: 'CRITICO', verificado: false, motivo: 'RESULTADO_SEM_COMPROVACAO' };
    } catch (e) {
      const codigos = new Set(['PEDIDO_EXPIRADO', 'PEDIDO_INVALIDO', 'PEDIDO_AUSENTE', 'ID_DIVERGENTE', 'BLOB_DIVERGENTE', 'S3_OPERACAO_FALHOU', 'PRE_DEPLOY_HTTP', 'BASELINE_NAO_COMPROVADA']);
      resultado = mutacaoIniciada || origemIncerta ? { estado: 'CRITICO', verificado: false, motivo: 'RESULTADO_INCERTO' } : { estado: 'RECUSADO', verificado: false, mutacao: 'NENHUMA', motivo: codigos.has(e.codigo) ? e.codigo : 'RECUSA_ANTES_DA_INSTALACAO' };
    }
    const recibo = pedido ? { id, commit: pedido.commit, releaseSha256: pedido.releaseSha256, ...resultado } : null;
    await registrar({ fase: 'TERMINAL', resultado, recibo });
    liberar = seguro(resultado);
    return { id, ...resultado, ...await publicarRecibo(recibo) };
  } finally {
    try { if (trava && liberar) { const identidade = A.identidade(trava); A.fechar(trava); A.removerArvore(base, '.trava-cd', { identidade }); } }
    finally { A.fecharTudo(); }
  }
}
async function processarFila({ cfg, ids, s3 }) {
  let ok = true;
  for (const id of ids) {
    P.exigir(P.ID.test(id), 'ID_INVALIDO');
    const existente = await s3.get(`hml/recibos/${id}.json`);
    if (existente !== null) {
      const r = P.json(existente);
      P.exigir(r.id === id && ['SUCESSO', 'RECUSADO', 'FALHOU'].includes(r.estado), 'RECIBO_INVALIDO_OU_CRITICO');
      continue;
    }
    const r = await processar({ cfg, id, s3 });
    P.exigir(r.estado !== 'CRITICO', 'OPERACAO_CRITICA');
    if (r.estado !== 'SUCESSO' || r.reciboPendente) ok = false;
    if (r.reciboPendente && r.estado !== 'RECUSADO') break;
  }
  return { ok };
}
async function principal(argv) {
  P.exigir(argv[0] === '--config' && ((argv.length === 4 && argv[2] === '--pedido') || (argv.length === 3 && argv[2] === '--pendentes')), 'USO');
  N.verificarContextoDeExecucao();
  P.exigir(process.platform === 'linux', 'LINUX_OBRIGATORIO');
  const cfg = validarConfiguracao(N.lerConfigSegura(argv[1]));
  const s3 = criarS3(cfg.s3);
  if (argv[2] === '--pendentes') P.exigir((await processarFila({ cfg, ids: await s3.listarPedidos(), s3 })).ok, 'FILA_COM_FALHAS');
  else {
    const r = await processar({ cfg, id: argv[3], s3 });
    P.exigir(r.estado === 'SUCESSO' && !r.reciboPendente, 'PUBLICACAO_FALHOU');
  }
}
if (require.main === module) principal(process.argv.slice(2)).catch(e => { console.error(`Agente recusou: ${e.codigo || 'ERRO'}`); process.exitCode = 1; });
module.exports = { aplicar, validarConfiguracao, origemDaApi, processar, processarFila };
