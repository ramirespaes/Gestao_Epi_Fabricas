'use strict';
// Agente do escopo backend (Etapa 2B): módulo separado do agente do frontend, inerte e sem ativação.
// Lê pedidos só do prefixo hml-backend/ e entrega o pedido ao instalador, que recusa o backend enquanto não houver
// coordenação homologada com o D-ORF-6. Este módulo não oferece contorno: não consulta nem declara coordenação, não
// pula a prova de versão e não executa processos, banco, migrations, backup nem recuperação. Qualquer falha depois de
// iniciada a instalação vira estado CRITICO com a trava preservada, para diagnóstico humano.
const fs = require('node:fs');
const path = require('node:path');
const N = require('../instalador/nucleo');
const I = require('../instalador/instalar-release');
const { criarAncora } = require('../instalador/ancora');
const { criarS3 } = require('./s3');
const P = require('./protocolo');

const ESCOPO = 'backend';
const PREFIXO = 'hml-backend';
const ISOLAMENTO = 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND';
const TRAVA = '.trava-cd-backend';
const chave = (tipo, id) => `${PREFIXO}/${tipo}/${id}.json`;
const igual = (a, b) => a.rotulo === b.rotulo && a.commit === b.commit;

// Recusas do instalador comprovadamente anteriores a qualquer mudança no servidor: cada código tem um único ponto de
// lançamento, nas guardas iniciais de instalar(), antes de abrir contexto, trava ou diário. OPERACAO_EM_CURSO e
// COORDENACAO_NAO_CONFIRMADA ficam de fora de propósito: o instalador também as lança depois de preparar a release e
// depois de trocar o link, então elas não provam ausência de mutação.
const RECUSAS_SEM_MUTACAO = new Set(['COORDENACAO_NAO_HOMOLOGADA', 'SAUDE_NAO_CONFIGURADA', 'REINICIO_NAO_CONFIGURADO', 'VERSAO_NAO_COMPROVAVEL']);
const MOTIVOS_DE_RECUSA = new Set([...RECUSAS_SEM_MUTACAO, 'PEDIDO_EXPIRADO', 'PEDIDO_INVALIDO', 'PEDIDO_AUSENTE', 'ID_DIVERGENTE', 'BLOB_DIVERGENTE', 'ESCOPO_DIVERGENTE', 'RETROATIVO_BLOQUEADO', 'S3_OPERACAO_FALHOU', 'BASELINE_NAO_COMPROVADA', 'BASELINE_MUDOU']);
// Falhas que o próprio instalador declara críticas depois de alterar a release.
const CODIGOS_CRITICOS = new Set(['FALHA_POS_TROCA', 'FALHA_POS_REINICIO', 'ESTADO_CRITICO']);
// Resultados do instalador que contam como instalação concluída, e avisos que tiram a afirmação de sucesso.
const RESULTADOS_ACEITOS = new Set(['INSTALADA', 'JA_INSTALADA', 'CONFIRMADA']);
const AVISOS_QUE_IMPEDEM_SUCESSO = new Set(['ESTADO_NAO_ATUALIZADO', 'DURABILIDADE_NAO_GARANTIDA']);
const codigoSeguro = (e) => (e && typeof e.codigo === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.codigo) ? e.codigo : 'ERRO');
// Depois de iniciada a instalação nada é "recusa": ou o estado é incerto, ou o instalador declarou falha crítica.
function motivoCritico(e) {
  const codigo = codigoSeguro(e);
  if (codigo === 'RESULTADO_NAO_RECONHECIDO' || codigo === 'SUCESSO_SEM_REGISTRO_DURAVEL') return codigo;
  const critico = e.detalhes !== null && typeof e.detalhes === 'object' && e.detalhes.critico === true;
  return CODIGOS_CRITICOS.has(codigo) || critico ? 'FALHA_CRITICA_APOS_ALTERACAO' : 'RESULTADO_INCERTO';
}

function saudavel(s) {
  P.exigir(s && s.instalado === true && s.integro === true && s.consistente === true && s.garantiaContraCorrida === true && N.SHA_COMPLETO.test(s.commit) && N.ROTULO.test(s.rotulo), 'BASELINE_NAO_COMPROVADA');
  return s;
}

function validarConfiguracao(cfg) {
  P.exigir(cfg && cfg.habilitado === true && cfg.isolamentoRevisado === ISOLAMENTO, 'AGENTE_DESABILITADO');
  const instalador = N.validarConfig(cfg.instalador);
  const comp = instalador.componentes[ESCOPO];
  P.exigir(Object.keys(instalador.componentes).join(',') === ESCOPO && comp.tipo === 'backend', 'ESCOPO_INVALIDO');
  P.exigir(comp.saude && comp.reinicio && comp.processo, 'VERSAO_NAO_COMPROVAVEL');
  P.exigir(cfg.s3 && cfg.s3.prefixo === PREFIXO, 'S3_PREFIXO_INVALIDO');
  P.exigir(Array.isArray(cfg.raizesProtegidas) && cfg.raizesProtegidas.length > 0 && cfg.raizesProtegidas.every((p) => path.isAbsolute(p)), 'RAIZES_PROTEGIDAS_OBRIGATORIAS');
  const protegidas = cfg.raizesProtegidas.map((p) => fs.realpathSync(p));
  const estado = fs.realpathSync(cfg.estadoDir);
  const base = fs.realpathSync(comp.base);
  P.exigir(!protegidas.some((p) => N.sobrepoe(p, base)) && !N.sobrepoe(estado, base) && !protegidas.some((p) => N.sobrepoe(p, estado)), 'RAIZ_PROTEGIDA');
  return cfg;
}

// Só devolve SUCESSO quando o instalador concluiu e a identidade instalada é a da release aprovada. Qualquer outra coisa lança.
async function aplicar({ pedido, releaseDir, deps, agora = Date.now }) {
  P.exigir(deps && typeof deps.identificar === 'function' && typeof deps.instalar === 'function' && typeof deps.registrar === 'function', 'DEPENDENCIAS_INCOMPLETAS');
  P.validarPedido(pedido, agora(), { escopo: ESCOPO });
  const conferir = deps.conferirRelease || P.conferirRelease;
  const rel = conferir({ dir: releaseDir, commit: pedido.commit, rotulo: pedido.rotulo, releaseSha256: pedido.releaseSha256, escopo: ESCOPO });
  const antes = saudavel(await deps.identificar());
  await deps.registrar({ fase: 'PREPARADO', antes });
  P.validarPedido(pedido, agora(), { escopo: ESCOPO });
  P.exigir(igual(saudavel(await deps.identificar()), antes), 'BASELINE_MUDOU');
  const retorno = await deps.instalar({ releaseSha256Esperado: pedido.releaseSha256, exigirDurabilidade: true, permitirAnterior: false, permitirRetroativo: false }, releaseDir);
  P.exigir(retorno !== null && typeof retorno === 'object' && RESULTADOS_ACEITOS.has(retorno.resultado), 'RESULTADO_NAO_RECONHECIDO');
  const avisos = Array.isArray(retorno.avisos) ? retorno.avisos : [];
  P.exigir(!avisos.some((a) => a !== null && typeof a === 'object' && AVISOS_QUE_IMPEDEM_SUCESSO.has(a.codigo)), 'SUCESSO_SEM_REGISTRO_DURAVEL');
  P.exigir(igual(saudavel(await deps.identificar()), rel.release), 'POS_DEPLOY_VERSAO');
  return { estado: 'SUCESSO', verificado: true };
}

function dependenciasPadrao(cfg) {
  const config = cfg.instalador;
  return {
    criarAncora: () => criarAncora({ exigirDurabilidade: true }),
    identificar: () => I.identificar({ config, componente: ESCOPO }),
    instalar: (opcoes, release) => I.instalar({ config, componente: ESCOPO, release, opcoes }),
  };
}

async function processar({ cfg, id, s3, deps: injetadas = {} }) {
  P.exigir(P.ID.test(id), 'ID_INVALIDO');
  const base0 = { ...dependenciasPadrao(cfg), ...injetadas };
  const A = base0.criarAncora();
  let base, trava, liberar = false;
  const seguro = (r) => r && ((r.estado === 'RECUSADO' && r.mutacao === 'NENHUMA') || (r.estado === 'SUCESSO' && r.verificado === true));
  try {
    base = A.abrirBase(cfg.estadoDir);
    trava = A.criarExclusivo(base, TRAVA);
    const anterior = A.lerTexto(base, `${id}.json`);
    let pedido = null, mutacaoIniciada = false, origemIncerta = false, resultado, rastro = {};
    const registrar = async (detalhe) => {
      const proximo = { ...rastro, ...detalhe, versao: 2, id, escopo: ESCOPO, pedido };
      A.escreverAtomico(base, `${id}.json`, JSON.stringify(proximo));
      rastro = proximo;
    };
    const publicarRecibo = async (recibo) => {
      if (!recibo) return { reciboPendente: true };
      let existente;
      try { existente = await s3.get(chave('recibos', id)); } catch { return { reciboPendente: true }; }
      if (existente !== null) {
        if (existente.toString() !== JSON.stringify(recibo)) {
          liberar = false;
          await registrar({ fase: 'TERMINAL', resultado: { estado: 'CRITICO', verificado: false, motivo: 'RECIBO_DIVERGENTE' } });
          P.exigir(false, 'RECIBO_DIVERGENTE');
        }
      } else {
        try { await s3.put(chave('recibos', id), Buffer.from(JSON.stringify(recibo))); } catch { return { reciboPendente: true }; }
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
      const b = await s3.get(chave('pedidos', id));
      P.exigir(b !== null, 'PEDIDO_AUSENTE');
      const candidato = P.validarEstruturaPedido(P.json(b));
      P.exigir(candidato.id === id, 'ID_DIVERGENTE');
      pedido = candidato;
      P.validarPedido(pedido, Date.now(), { escopo: ESCOPO });
      const blob = await s3.get(chave('blobs', id));
      P.exigir(blob !== null && N.sha256(blob) === pedido.blobSha256, 'BLOB_DIVERGENTE');
      const dir = path.join(cfg.estadoDir, `entrada-${id}`);
      try { origemIncerta = Boolean(fs.lstatSync(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      P.exigir(!origemIncerta, 'ENTRADA_PREEXISTENTE');
      P.extrair(blob, dir);
      const deps = { ...base0, registrar };
      const instalar = base0.instalar;
      deps.instalar = async (opcoes, release) => {
        await registrar({ fase: 'INSTALACAO_INICIADA', componente: ESCOPO });
        mutacaoIniciada = true;
        try { return await instalar(opcoes, release); } catch (falha) {
          if (RECUSAS_SEM_MUTACAO.has(falha.codigo)) mutacaoIniciada = false;
          throw falha;
        }
      };
      resultado = await aplicar({ pedido, releaseDir: dir, deps });
    } catch (e) {
      resultado = mutacaoIniciada || origemIncerta
        ? { estado: 'CRITICO', verificado: false, motivo: motivoCritico(e), diagnostico: codigoSeguro(e) }
        : { estado: 'RECUSADO', verificado: false, mutacao: 'NENHUMA', motivo: MOTIVOS_DE_RECUSA.has(e.codigo) ? e.codigo : 'RECUSA_ANTES_DA_INSTALACAO' };
    }
    const recibo = pedido ? { id, commit: pedido.commit, releaseSha256: pedido.releaseSha256, escopo: ESCOPO, ...resultado } : null;
    await registrar({ fase: 'TERMINAL', resultado, recibo });
    liberar = Boolean(seguro(resultado));
    return { id, ...resultado, ...await publicarRecibo(recibo) };
  } finally {
    try { if (trava && liberar) { const identidade = A.identidade(trava); A.fechar(trava); A.removerArvore(base, TRAVA, { identidade }); } } finally { A.fecharTudo(); }
  }
}

async function processarFila({ cfg, ids, s3, deps }) {
  let ok = true;
  for (const id of ids) {
    P.exigir(P.ID.test(id), 'ID_INVALIDO');
    const existente = await s3.get(chave('recibos', id));
    if (existente !== null) {
      const r = P.json(existente);
      P.exigir(r.id === id && r.escopo === ESCOPO && ['SUCESSO', 'RECUSADO'].includes(r.estado), 'RECIBO_INVALIDO_OU_CRITICO');
      continue;
    }
    const r = await processar({ cfg, id, s3, deps });
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

if (require.main === module) principal(process.argv.slice(2)).catch((e) => { console.error(`Agente do backend recusou: ${e.codigo || 'ERRO'}`); process.exitCode = 1; });
module.exports = { aplicar, validarConfiguracao, processar, processarFila, principal };
