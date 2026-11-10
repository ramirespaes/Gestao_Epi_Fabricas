'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { localizarArmazenamentoDuravel, ambienteDeTeste } = require('./imagem-backup-durabilidade.service');
const { criarEnviadorS3, METODOS_DA_PORTA: PORTA_DO_PUBLICADOR } = require('./backup-armazenamento-s3.service');
const { criarVerificadorIndependente, METODOS_DA_PORTA: PORTA_DO_VERIFICADOR } = require('./backup-verificador-duravel.service');
const { criarBaixadorDuravel, METODOS_DA_PORTA: PORTA_DA_RESTAURACAO } = require('./backup-baixador-duravel.service');
const { ehDestinoValidado } = require('./imagem-backup-destinos.service');
const { bytesCanonicos } = require('./backup-recibo-duravel.service');
const Pol = require('./backup-executor-politica.service');
const Ev = require('./backup-executor-evidencia.service');
const { publicarPacoteDuravel } = require('./backup-executor-publicacao.service');
const { restaurarDoDestinoDuravel } = require('./backup-executor-recuperacao.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: COMPOSITOR. Três ações, sempre com a mesma sequência: (1) portões da política (modo, ação, ambiente, confirmação, processo, SDK, chaves, destino local DEDICADO,
 * áreas protegidas e papéis das portas); (2) coordenação exclusiva (BACKUP e RESTAURACAO; a verificação do destino não usa recurso local); (3) estágio da ação, com os módulos reais;
 * (4) liberação garantida; (5) EVIDÊNCIA registrada sempre, inclusive nos bloqueios. Falha fechada: o que não puder ser provado vira BLOQUEADO, RECUSADO, FALHOU ou INCERTO, nunca sucesso.
 *
 * Papéis (privilégio mínimo; qualquer porta fora do papel bloqueia): BACKUP = produção do pacote + publicador + chaves de operação (+ verificador só no ensaio); RESTAURACAO = restauração +
 * restaurador das fontes + chaves; VERIFICACAO_DESTINO = só o verificador (roda fora do host do backup). B1: a restauração usa só o orquestrador existente. B3: áreas protegidas (cinco, distintas),
 * teto de bytes e destino local dedicado (`containers...` para o contêiner cifrado, `restauracao...` para restaurar) são obrigatórios. A operação real continua bloqueada pela constante da política.
 * Este módulo não escreve em disco, não lê ambiente e não contata rede: tudo chega por portas injetadas (produção do pacote, coordenação, sumidouros de evidência e de recibos).
 */

const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONJUNTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DESTINO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const AREAS = Object.freeze(['imagens', 'fiscalizacao', 'preparacoes', 'dumps', 'publicados']);
const DEDICADO = Object.freeze({ BACKUP: /^containers?(?:-[a-z0-9-]+)?$/, RESTAURACAO: /^restauracao(?:-[a-z0-9-]+)?$/ });
const PAPEIS = Object.freeze({
  BACKUP: Object.freeze({ obrigatorias: ['producao', 'publicador', 'chaves'], opcionaisNoEnsaio: ['verificador'] }),
  RESTAURACAO: Object.freeze({ obrigatorias: ['restauracao', 'restaurador', 'chaves'], opcionaisNoEnsaio: [] }),
  VERIFICACAO_DESTINO: Object.freeze({ obrigatorias: ['verificador'], opcionaisNoEnsaio: [] }),
});
const OPCOES = Object.freeze(['modo', 'ambiente', 'destinoDuravelId', 'confirmacao', 'fatos', 'relogio', 'coordenacao', 'evidencia', 'recibos', 'registro', 'gerarId']);
const FATOS = Object.freeze(['sdk', 'chavesOrigem', 'uid', 'umask']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do executor inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const entradaInvalida = () => Object.assign(new TypeError('pedido do executor inválido'), { code: 'ENTRADA_INVALIDA' });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const comFuncoes = (o, nomes) => ehObjeto(o) && nomes.every((n) => typeof o[n] === 'function');
const mesmasChaves = (o, esperadas) => { const p = Reflect.ownKeys(o); return p.length === esperadas.length && esperadas.every((k) => p.includes(k)); };
const sobrepoe = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const hexOuNulo = (v) => (typeof v === 'string' && SHA256.test(v) ? v : null);

function validarDestinoLocal(dl, nomes) {
  if (!ehObjeto(dl) || !mesmasChaves(dl, ['validador', 'destinoLocalId', 'raiz', ...nomes]) || !comFuncoes(dl.validador, ['validar']) || typeof dl.destinoLocalId !== 'string' || !caminhoCanonico(dl.raiz)) throw entradaInvalida();
  for (const n of nomes) if (typeof dl[n] !== 'string' || !NOME.test(dl[n])) throw entradaInvalida();
  if (nomes.length === 2 && dl[nomes[0]] === dl[nomes[1]]) throw entradaInvalida();
}
function validarProtegidos(p) {
  if (!ehObjeto(p) || !mesmasChaves(p, AREAS) || !AREAS.every((a) => caminhoCanonico(p[a])) || new Set(AREAS.map((a) => p[a])).size !== AREAS.length) throw entradaInvalida();
}
function validarLimites(l, backup) {
  const ok = ehObjeto(l) && Number.isSafeInteger(l.totalBytesMaximo) && l.totalBytesMaximo >= 1 && Reflect.ownKeys(l).every((k) => k === 'totalBytesMaximo' || k === 'arquivosMaximo')
    && (backup ? Number.isSafeInteger(l.arquivosMaximo) : l.arquivosMaximo === undefined || Number.isSafeInteger(l.arquivosMaximo)) && (l.arquivosMaximo === undefined || (l.arquivosMaximo >= 1 && l.arquivosMaximo <= 400000));
  if (!ok) throw entradaInvalida();
}
function validarConsolidado(c) {
  if (!ehObjeto(c) || typeof c.conjuntoId !== 'string' || !CONJUNTO.test(c.conjuntoId) || !Array.isArray(c.recibos)) throw entradaInvalida();
}
function validarPortas(portas, acao) {
  if (!ehObjeto(portas)) throw entradaInvalida();
  const { obrigatorias } = PAPEIS[acao];
  if (!obrigatorias.every((k) => Object.hasOwn(portas, k))) throw entradaInvalida();
  if (acao === 'BACKUP') {
    if (!comFuncoes(portas.producao, ['produzir']) || !comFuncoes(portas.publicador, PORTA_DO_PUBLICADOR) || !ehObjeto(portas.chaves) || !ehObjeto(portas.chaves.cifra) || !ehObjeto(portas.chaves.mac)) throw entradaInvalida();
    if (portas.verificador !== undefined && !comFuncoes(portas.verificador, PORTA_DO_VERIFICADOR)) throw entradaInvalida();
  } else if (acao === 'RESTAURACAO') {
    if (!comFuncoes(portas.restauracao, PORTA_DA_RESTAURACAO) || !comFuncoes(portas.restaurador, ['restaurar']) || !ehObjeto(portas.chaves) || !ehObjeto(portas.chaves.cifra) || !ehObjeto(portas.chaves.mac)) throw entradaInvalida();
  } else if (!comFuncoes(portas.verificador, PORTA_DO_VERIFICADOR)) throw entradaInvalida();
}
function validarPedido(acao, pedido) {
  if (!ehObjeto(pedido)) throw entradaInvalida();
  if (acao === 'VERIFICACAO_DESTINO') {
    if (!mesmasChaves(pedido, ['consolidado', 'portas'])) throw entradaInvalida();
    validarConsolidado(pedido.consolidado);
    validarPortas(pedido.portas, acao);
    return;
  }
  const base = acao === 'BACKUP' ? ['conjuntoId', 'destinoLocal', 'portas', 'protegidos', 'limites', 'prazoMs'] : ['consolidado', 'destinoLocal', 'portas', 'protegidos', 'limites', 'prazoMs'];
  const proprias = Reflect.ownKeys(pedido);
  const extras = acao === 'RESTAURACAO' ? ['alvos', 'ultimoBackupEm'] : [];
  if (!base.every((k) => proprias.includes(k)) || !proprias.every((k) => base.includes(k) || extras.includes(k))) throw entradaInvalida();
  if (acao === 'BACKUP' && (typeof pedido.conjuntoId !== 'string' || !CONJUNTO.test(pedido.conjuntoId))) throw entradaInvalida();
  if (acao === 'RESTAURACAO') validarConsolidado(pedido.consolidado);
  validarDestinoLocal(pedido.destinoLocal, acao === 'BACKUP' ? ['nomeContainer'] : ['nomeContainer', 'nomeDecifrado']);
  validarPortas(pedido.portas, acao);
  validarProtegidos(pedido.protegidos);
  validarLimites(pedido.limites, acao === 'BACKUP');
  if (!Number.isSafeInteger(pedido.prazoMs) || pedido.prazoMs < 1 || pedido.prazoMs > 600000) throw entradaInvalida();
}

function criarExecutorOperacional(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !OPCOES.slice(0, 9).every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida();
  const { modo, ambiente, destinoDuravelId, confirmacao, fatos, relogio, coordenacao, evidencia, recibos, registro, gerarId } = opcoes;
  if (!Pol.MODOS.includes(modo) || !Pol.AMBIENTES.includes(ambiente) || typeof destinoDuravelId !== 'string' || !DESTINO.test(destinoDuravelId) || (confirmacao !== null && typeof confirmacao !== 'string')) throw configuracaoInvalida();
  if (typeof relogio !== 'function' || !comFuncoes(coordenacao, ['adquirir']) || !comFuncoes(evidencia, ['registrar']) || !comFuncoes(recibos, ['registrar']) || (gerarId !== undefined && typeof gerarId !== 'function')) throw configuracaoInvalida();
  if (!ehObjeto(fatos) || !mesmasChaves(fatos, FATOS)) throw configuracaoInvalida();
  if (registro !== undefined && !ambienteDeTeste()) throw configuracaoInvalida();
  try {
    Pol.avaliarPortoes({ modo, acao: 'VERIFICACAO_DESTINO', ambiente, destinoId: destinoDuravelId, confirmacao: null, fatos: { ...fatos, destinoLocal: 'NAO_APLICA' }, ...(registro === undefined ? {} : { registro }) });
  } catch { throw configuracaoInvalida(); }
  const comRegistro = registro === undefined ? {} : { registro };

  async function executar(acao, pedido, trabalho) {
    validarPedido(acao, pedido);
    const operacaoId = gerarId === undefined ? crypto.randomBytes(16).toString('hex') : gerarId();
    const ev = Ev.criarEvidencia({ modo, acao, ambiente, destinoId: destinoDuravelId, relogio, operacaoId });
    const sequencia = Ev.ETAPAS[acao];
    let ultima = null;
    let ultimaOk = true;
    const marcar = (id, ok, codigo = null) => { ev.etapa(id, ok, codigo); ultima = id; ultimaOk = ok; };
    const falharAdiante = (estado, codigo, extras = {}) => {
      if (ultimaOk) marcar(sequencia[ultima === null ? 0 : sequencia.indexOf(ultima) + 1], false, codigo);
      return ev.encerrar({ estado, codigo, falhouEm: ultima, ...extras });
    };
    const origemDeChaves = fatos.chavesOrigem === 'AUSENTE' ? null : fatos.chavesOrigem;
    let corpo = { saida: null, consolidado: null, dr: null, diagnostico: null };
    let encerrada;

    // portões
    const dl = pedido.destinoLocal;
    const portasPermitidas = [...PAPEIS[acao].obrigatorias, ...(modo === 'ENSAIO' ? PAPEIS[acao].opcionaisNoEnsaio : [])];
    const bloqueios = new Set();
    if (!Reflect.ownKeys(pedido.portas).every((k) => portasPermitidas.includes(k))) bloqueios.add('PORTAS_FORA_DO_PAPEL');
    let fatoLocal = 'NAO_APLICA';
    if (acao !== 'VERIFICACAO_DESTINO') {
      let autorizado = false;
      try { const v = dl.validador.validar({ destinoId: dl.destinoLocalId, raiz: dl.raiz }); autorizado = ehDestinoValidado(v) && v.autorizado === true && dl.validador.ambiente === ambiente; } catch { autorizado = false; }
      fatoLocal = autorizado && DEDICADO[acao].test(dl.destinoLocalId) ? 'AUTORIZADO' : 'NAO_AUTORIZADO';
      if (AREAS.some((a) => sobrepoe(dl.raiz, pedido.protegidos[a]))) bloqueios.add('DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA');
    }
    const politica = Pol.avaliarPortoes({ modo, acao, ambiente, destinoId: destinoDuravelId, confirmacao, fatos: { ...fatos, destinoLocal: fatoLocal }, ...comRegistro });
    for (const b of politica.bloqueios) bloqueios.add(b);
    if (bloqueios.size > 0) {
      const lista = [...bloqueios].sort();
      encerrada = ev.encerrar({ estado: 'BLOQUEADO', codigo: lista[0], falhouEm: 'GATE', bloqueios: lista, origemDeChaves });
    } else {
      let trava = null;
      let travaRecusada = null;
      if (acao !== 'VERIFICACAO_DESTINO') {
        try {
          const t = await coordenacao.adquirir({ operacao: acao });
          if (ehObjeto(t) && t.ok === true && typeof t.liberar === 'function') trava = t;
          else travaRecusada = ehObjeto(t) && t.motivo === 'EM_USO' ? ['RECUSADO', 'COORDENACAO_EM_USO'] : ehObjeto(t) && t.motivo === 'MIGRACAO_EM_CURSO' ? ['RECUSADO', 'MIGRACAO_EM_CURSO'] : ehObjeto(t) && t.motivo === 'PRIVILEGIOS_B1_PENDENTES' ? ['RECUSADO', 'PRIVILEGIOS_B1_PENDENTES'] : ehObjeto(t) && t.motivo === 'PRIVILEGIOS_B1_NAO_VERIFICADOS' ? ['FALHOU', 'PRIVILEGIOS_B1_NAO_VERIFICADOS'] : ['FALHOU', 'COORDENACAO_INDISPONIVEL'];
        } catch { travaRecusada = ['FALHOU', 'COORDENACAO_INDISPONIVEL']; }
      }
      if (travaRecusada !== null) {
        encerrada = falharAdiante(travaRecusada[0], travaRecusada[1], { origemDeChaves });
      } else {
        try {
          if (acao !== 'VERIFICACAO_DESTINO') marcar('COORDENACAO', true);
          corpo = await trabalho({ pedido, ev, marcar, operacaoId, origemDeChaves });
          encerrada = corpo.encerrada;
        } catch {
          encerrada = falharAdiante('FALHOU', 'ERRO_INESPERADO', { origemDeChaves });
        } finally {
          if (trava !== null) { try { await trava.liberar(); } catch { /* o cadeado de sessão é liberado ao fim da sessão */ } }
        }
      }
    }
    let evidenciaRegistrada = false;
    try { await evidencia.registrar(encerrada.linha); evidenciaRegistrada = true; } catch { evidenciaRegistrada = false; }
    return Object.freeze({ ok: encerrada.evidencia.estado === 'CONCLUIDO', estado: encerrada.evidencia.estado, evidencia: encerrada.evidencia, linha: encerrada.linha, evidenciaRegistrada, consolidado: corpo.consolidado, dr: corpo.dr, diagnostico: corpo.diagnostico });
  }

  async function executarBackup(pedido) {
    return executar('BACKUP', pedido, async ({ ev, marcar, operacaoId, origemDeChaves }) => {
      const { conjuntoId, destinoLocal, portas, limites, prazoMs } = pedido;
      const enviador = criarEnviadorS3({ destinoId: destinoDuravelId, ambiente, cliente: portas.publicador, relogio, prazoMs, ...comRegistro });
      const verificador = portas.verificador === undefined ? undefined : criarVerificadorIndependente({ destinoId: destinoDuravelId, ambiente, cliente: portas.verificador, relogio, prazoMs, ...comRegistro });
      const sequencia = Ev.ETAPAS.BACKUP;
      const producao = await portas.producao.produzir({ operacaoId, conjuntoId });
      if (!ehObjeto(producao) || producao.ok !== true || !ehObjeto(producao.pacote)) {
        marcar('PRODUCAO', false, 'PRODUCAO_FALHOU');
        return { encerrada: ev.encerrar({ estado: 'FALHOU', codigo: 'PRODUCAO_FALHOU', falhouEm: 'PRODUCAO', conjuntoId, origemDeChaves }), consolidado: null, dr: null, diagnostico: Object.freeze({ etapa: 'PRODUCAO', codigo: 'PRODUCAO_FALHOU' }) };
      }
      marcar('PRODUCAO', true);
      const sha256Manifesto = hexOuNulo(producao.pacote.lido?.identidade?.sha256Manifesto);
      const r = await publicarPacoteDuravel({
        pacote: { dir: producao.pacote.dir, lido: producao.pacote.lido }, conjuntoId, validadorDeDestinos: destinoLocal.validador, destinoLocalId: destinoLocal.destinoLocalId, raiz: destinoLocal.raiz,
        nomeContainer: destinoLocal.nomeContainer, cifra: portas.chaves.cifra, mac: portas.chaves.mac, enviador, ...(verificador === undefined ? {} : { verificador }), limites, prazoMs, marcar,
      });
      const comum = { conjuntoId, sha256Manifesto, sha256Consolidado: r.sha256Consolidado, arquivos: r.container === null ? null : r.container.arquivos, bytes: r.container === null ? null : r.container.bytes, origemDeChaves, origemDoDestino: r.origemDoDestino };
      let registrado = false;
      if (r.consolidado !== null) {
        try { await recibos.registrar({ conjuntoId, sha256: r.sha256Consolidado, bytes: bytesCanonicos(r.consolidado) }); registrado = true; } catch { registrado = false; }
      }
      if (!r.ok) {
        const verificacao = r.verificacao === 'DIVERGENTE' ? 'DIVERGENTE' : 'NAO_APLICA';
        return { encerrada: ev.encerrar({ estado: r.estado, codigo: r.falha.codigo, falhouEm: r.falha.etapa, verificacaoIndependente: verificacao, ...comum }), consolidado: r.consolidado, dr: null, diagnostico: Object.freeze({ ...r.falha, recibosRegistrados: registrado }) };
      }
      if (!registrado) {
        marcar(sequencia.at(-1), false, 'RECIBOS_NAO_REGISTRADOS');
        return { encerrada: ev.encerrar({ estado: 'FALHOU', codigo: 'RECIBOS_NAO_REGISTRADOS', falhouEm: sequencia.at(-1), verificacaoIndependente: r.verificacao, ...comum }), consolidado: r.consolidado, dr: null, diagnostico: Object.freeze({ etapa: sequencia.at(-1), codigo: 'RECIBOS_NAO_REGISTRADOS' }) };
      }
      marcar(sequencia.at(-1), true);
      return { encerrada: ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: r.verificacao, ...comum }), consolidado: r.consolidado, dr: null, diagnostico: null };
    });
  }

  async function executarRestauracao(pedido) {
    return executar('RESTAURACAO', pedido, async ({ ev, marcar, origemDeChaves }) => {
      const { consolidado, destinoLocal, portas, protegidos, limites, prazoMs } = pedido;
      const baixador = criarBaixadorDuravel({
        destinoId: destinoDuravelId, ambiente, cliente: portas.restauracao, validadorDeDestinos: destinoLocal.validador, limites: { ...limites }, protegidos: AREAS.map((a) => protegidos[a]), prazoMs, ...comRegistro,
      });
      const origemDoDestino = localizarArmazenamentoDuravel(destinoDuravelId, ambiente, ...(registro === undefined ? [] : [registro])).origem === 'OPERACIONAL' ? 'OPERACIONAL' : 'TESTE_CONTROLADO';
      const r = await restaurarDoDestinoDuravel({
        baixador, validadorDeDestinos: destinoLocal.validador, consolidado, destinoLocalId: destinoLocal.destinoLocalId, raiz: destinoLocal.raiz, nomeContainer: destinoLocal.nomeContainer,
        nomeDecifrado: destinoLocal.nomeDecifrado, cifra: portas.chaves.cifra, mac: portas.chaves.mac, restaurador: portas.restaurador, relogio, marcar,
        ...(pedido.alvos === undefined ? {} : { alvos: pedido.alvos, ultimoBackupEm: pedido.ultimoBackupEm }),
      });
      const sha256Consolidado = crypto.createHash('sha256').update(bytesCanonicos(consolidado)).digest('hex');
      const comum = {
        conjuntoId: consolidado.conjuntoId, sha256Consolidado, arquivos: r.restauracao === null ? null : r.restauracao.arquivosDecifrados, bytes: r.restauracao === null ? null : r.restauracao.bytesEmClaro,
        origemDeChaves, origemDoDestino, comprovacoesPendentes: [...r.comprovacoesPendentes],
      };
      if (!r.ok) return { encerrada: ev.encerrar({ estado: r.estado, codigo: r.falha.codigo, falhouEm: r.falha.etapa, ...comum }), consolidado: null, dr: r.dr, diagnostico: r.falha };
      return { encerrada: ev.encerrar({ estado: 'CONCLUIDO', ...comum }), consolidado: null, dr: r.dr, diagnostico: null };
    });
  }

  async function verificarDestino(pedido) {
    return executar('VERIFICACAO_DESTINO', pedido, async ({ ev, marcar, origemDeChaves }) => {
      const { consolidado, portas } = pedido;
      const verificador = criarVerificadorIndependente({ destinoId: destinoDuravelId, ambiente, cliente: portas.verificador, relogio, ...comRegistro });
      const origemDoDestino = localizarArmazenamentoDuravel(destinoDuravelId, ambiente, ...(registro === undefined ? [] : [registro])).origem === 'OPERACIONAL' ? 'OPERACIONAL' : 'TESTE_CONTROLADO';
      const v = await verificador.verificar(consolidado);
      const conforme = ehObjeto(v) && v.conforme === true;
      const comum = {
        conjuntoId: consolidado.conjuntoId, sha256Consolidado: crypto.createHash('sha256').update(bytesCanonicos(consolidado)).digest('hex'), arquivos: consolidado.recibos.length,
        bytes: consolidado.recibos.reduce((s, rb) => s + (Number.isSafeInteger(rb?.bytes) ? rb.bytes : 0), 0), origemDeChaves, origemDoDestino,
      };
      if (!conforme) {
        marcar('VERIFICAR_DESTINO', false, 'VERIFICACAO_DIVERGENTE');
        return { encerrada: ev.encerrar({ estado: 'FALHOU', codigo: 'VERIFICACAO_DIVERGENTE', falhouEm: 'VERIFICAR_DESTINO', verificacaoIndependente: 'DIVERGENTE', ...comum }), consolidado: null, dr: null, diagnostico: Object.freeze({ etapa: 'VERIFICAR_DESTINO', codigo: 'VERIFICACAO_DIVERGENTE' }) };
      }
      marcar('VERIFICAR_DESTINO', true);
      return { encerrada: ev.encerrar({ estado: 'CONCLUIDO', verificacaoIndependente: 'CONFORME', ...comum }), consolidado: null, dr: null, diagnostico: null };
    });
  }

  return Object.freeze({ executarBackup, executarRestauracao, verificarDestino });
}

module.exports = { criarExecutorOperacional, AREAS, DEDICADO };
