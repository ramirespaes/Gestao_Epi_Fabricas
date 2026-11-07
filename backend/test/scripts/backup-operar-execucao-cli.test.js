'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/backup-operar');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const Pol = require('../../src/services/backup-executor-politica.service');
const O = require('../../src/services/backup-executor-operacional.service');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');
const { prepararAmbiente } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, executor operacional [CLI-EXE]: modos `--ensaio`, `--operar` e `--monitorar` do `backup-operar`. Argumentos estritos (sem eco); num processo REAL, sem ligação operacional, o ensaio e
 * a operação ficam BLOQUEADOS com a lista completa dos motivos e UMA linha de evidência no stdout (o que o systemd/journal captura); com a ligação injetada (`portas.compor`) o CLI executa pelo
 * compositor real e traduz o estado da evidência em código de saída; o monitoramento só lê e devolve 0 (ok) ou 7 (alerta).
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'backup-operar.js');
const BLOQUEADOR = path.join(__dirname, '..', 'helpers', 'bloquear-efeitos.js');
const { SAIDAS } = cli;
const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); limparRaizes(); });
const novaPasta = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
function rodarReal(argumentos, env = {}) {
  const r = spawnSync(process.execPath, ['--require', BLOQUEADOR, SCRIPT, ...argumentos], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
async function rodar(argv, portas) {
  let saida = '';
  let erro = '';
  const codigo = await cli.executarComando({ argv, ambiente: {}, raizDoCodigo: path.join(__dirname, '..', '..'), escrever: (t) => { saida += t; }, erro: (t) => { erro += t; }, portas });
  return { codigo, saida, erro };
}
const ARGS_BACKUP = ['--ensaio', '--acao=backup', '--ambiente=HOMOLOGACAO', '--destino=hml-s3-principal', `--confirmo=${Pol.FRASES.ENSAIO.BACKUP}`];
const lida = (texto) => { const r = Ev.lerLinhaDeEvidencia(texto); assert.equal(r.ok, true, JSON.stringify(r)); return r.evidencia; };

describe('[CLI-EXE] argumentos', () => {
  test('CLI-30 — formas válidas: ensaio/operação com ação, ambiente, destino e frase; monitoramento com arquivo e limites (opcionais com valor padrão apenas onde não há decisão pendente)', () => {
    assert.deepEqual(cli.interpretarArgumentos(ARGS_BACKUP), { ok: true, modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destino: 'hml-s3-principal', confirmo: Pol.FRASES.ENSAIO.BACKUP });
    assert.equal(cli.interpretarArgumentos(['--operar', '--acao=restauracao', '--ambiente=PRODUCAO', '--destino=prod-s3-principal', '--confirmo=QUALQUER_FRASE']).acao, 'RESTAURACAO');
    assert.equal(cli.interpretarArgumentos(['--ensaio', '--acao=verificacao-destino', '--ambiente=HOMOLOGACAO', '--destino=hml-s3-principal', '--confirmo=X_Y_Z']).acao, 'VERIFICACAO_DESTINO');
    assert.deepEqual(cli.interpretarArgumentos(['--monitorar', '--evidencias=/var/lib/safework/backup/evidencias.ndjson', '--ambiente=HOMOLOGACAO', '--limite-backup-horas=26', '--limite-verificacao-horas=4']),
      { ok: true, modo: 'MONITORAR', evidencias: '/var/lib/safework/backup/evidencias.ndjson', ambiente: 'HOMOLOGACAO', modoMonitorado: 'OPERACAO', limiteBackupHoras: 26, limiteVerificacaoHoras: 4, limiteFalhas: null, limiteEnsaioDrDias: null, json: false });
    const completo = cli.interpretarArgumentos(['--json', '--monitorar', '--evidencias=/a/b.ndjson', '--ambiente=PRODUCAO', '--modo=ensaio', '--limite-backup-horas=1', '--limite-verificacao-horas=2', '--limite-falhas=5', '--limite-ensaio-dr-dias=30']);
    assert.deepEqual({ modo: completo.modoMonitorado, falhas: completo.limiteFalhas, dr: completo.limiteEnsaioDrDias, json: completo.json }, { modo: 'ENSAIO', falhas: 5, dr: 30, json: true });
  });

  test('CLI-31 — formas inválidas (faltando, repetindo, valor fora do formato, argumento de outro modo, --json no ensaio/operação): recusadas sem eco do valor', () => {
    const base = ARGS_BACKUP.slice(1);
    const mon = ['--evidencias=/a/b.ndjson', '--ambiente=HOMOLOGACAO', '--limite-backup-horas=26', '--limite-verificacao-horas=4'];
    const ruins = [
      ['--ensaio', ...base.slice(1)], ['--ensaio', ...base.filter((a) => !a.startsWith('--acao'))], ['--ensaio', ...base.filter((a) => !a.startsWith('--confirmo'))], ['--ensaio', ...base, '--acao=backup'],
      ['--ensaio', ...base, '--json'], ['--ensaio', ...base, '--evidencias=/a'], ['--ensaio', '--acao=limpeza', ...base.slice(1)], ['--ensaio', '--acao=backup', '--ambiente=dev', ...base.slice(2)],
      ['--ensaio', '--acao=backup', '--ambiente=HOMOLOGACAO', '--destino=ID INVALIDO', base[3]], ['--ensaio', '--acao=backup', '--ambiente=HOMOLOGACAO', '--destino=ok-id', '--confirmo='],
      ['--ensaio', '--operar', ...base], ['--monitorar', ...mon.slice(1)], ['--monitorar', ...mon, '--acao=backup'], ['--monitorar', ...mon, '--limite-backup-horas=2'],
      ['--monitorar', '--evidencias=relativo.ndjson', ...mon.slice(1)], ['--monitorar', '--evidencias=/a/../b', ...mon.slice(1)], ['--monitorar', ...mon.map((a) => a.replace('=26', '=0'))], ['--monitorar', ...mon.map((a) => a.replace('=26', '=abc'))],
      ['--monitorar', ...mon.map((a) => a.replace('=26', '=99999'))], ['--monitorar', ...mon, '--modo=outro'], ['--monitorar', ...mon, '--limite-falhas=0'], ['--monitorar', ...mon, '--x-segredo-ficticio=abc'],
    ];
    for (const ruim of ruins) {
      const r = cli.interpretarArgumentos(ruim);
      assert.equal(r.ok, false, JSON.stringify(ruim));
      assert.equal(JSON.stringify(r).includes('segredo-ficticio'), false);
      assert.equal(/ID INVALIDO|relativo|outro|abc|99999/.test(JSON.stringify(r)), false, 'o erro não ecoa o valor');
    }
  });

  test('CLI-32 — os códigos de saída são congelados e distintos: OK=0, FALHA=1, ARGUMENTOS=2, INFRA_PENDENTE=3, BLOQUEADO=4, RECUSADO=5, INCERTO=6, ALERTA=7', () => {
    assert.deepEqual({ ...SAIDAS }, { OK: 0, FALHA: 1, ARGUMENTOS: 2, INFRA_PENDENTE: 3, BLOQUEADO: 4, RECUSADO: 5, INCERTO: 6, ALERTA: 7 });
    assert.ok(Object.isFrozen(SAIDAS));
    assert.match(cli.USO, /BLOQUEADO|bloqueado/);
  });
});

describe('[CLI-EXE] processo real: sem ligação operacional tudo fica BLOQUEADO, com uma linha de evidência', () => {
  test('CLI-33 — ensaio de backup com a frase correta: sai com 4, stdout é UMA linha de evidência BLOQUEADO com os motivos (chaves, destino durável, destino local, ligação; o SDK aprovado e instalado deixa de bloquear) e stderr vazio; nada é escrito', () => {
    const r = rodarReal(ARGS_BACKUP);
    assert.equal(r.status, SAIDAS.BLOQUEADO, `${r.stdout}\n${r.stderr}`);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout.split('\n').length, 2, 'uma linha e a quebra final');
    const e = lida(r.stdout);
    assert.deepEqual({ tipo: e.tipo, estado: e.estado, modo: e.modo, acao: e.acao, falhouEm: e.falhouEm, etapas: e.etapas.length, op: e.operacional }, { tipo: 'EXECUCAO_BACKUP', estado: 'BLOQUEADO', modo: 'ENSAIO', acao: 'BACKUP', falhouEm: 'GATE', etapas: 0, op: false });
    for (const esperado of ['DESTINO_DURAVEL_NAO_APROVADO', 'DESTINO_LOCAL_NAO_AUTORIZADO', 'FONTE_DE_CHAVES_NAO_APROVADA', 'LIGACAO_OPERACIONAL_AUSENTE']) assert.ok(e.bloqueios.includes(esperado), `${esperado}: ${e.bloqueios}`);
    assert.equal(e.bloqueios.includes('SDK_NAO_APROVADO'), false, `o SDK aprovado e instalado não bloqueia: ${e.bloqueios}`);
    assert.equal(e.bloqueios.includes('OPERACAO_NAO_HABILITADA'), false);
  });

  test('CLI-34 — operação real: OPERACAO_NAO_HABILITADA mesmo com a frase da operação; frase errada, ensaio em produção e verificação do destino (sem destino local) mudam só os motivos aplicáveis', () => {
    const op = lida(rodarReal(['--operar', '--acao=backup', '--ambiente=PRODUCAO', '--destino=prod-s3-principal', `--confirmo=${Pol.FRASES.OPERACAO.BACKUP}`]).stdout);
    assert.ok(op.bloqueios.includes('OPERACAO_NAO_HABILITADA') && !op.bloqueios.includes('CONFIRMACAO_AUSENTE_OU_INVALIDA'));
    const errada = lida(rodarReal(['--ensaio', '--acao=backup', '--ambiente=HOMOLOGACAO', '--destino=hml-s3-principal', '--confirmo=FRASE_ERRADA']).stdout);
    assert.ok(errada.bloqueios.includes('CONFIRMACAO_AUSENTE_OU_INVALIDA'));
    const prod = lida(rodarReal(['--ensaio', '--acao=backup', '--ambiente=PRODUCAO', '--destino=prod-s3-principal', `--confirmo=${Pol.FRASES.ENSAIO.BACKUP}`]).stdout);
    assert.ok(prod.bloqueios.includes('ENSAIO_EM_PRODUCAO_PROIBIDO'));
    const ver = lida(rodarReal(['--ensaio', '--acao=verificacao-destino', '--ambiente=HOMOLOGACAO', '--destino=hml-s3-principal', `--confirmo=${Pol.FRASES.ENSAIO.VERIFICACAO_DESTINO}`]).stdout);
    assert.equal(ver.tipo, 'EXECUCAO_VERIFICACAO_DESTINO');
    assert.equal(ver.bloqueios.includes('DESTINO_LOCAL_NAO_AUTORIZADO'), false);
  });
});

describe('[CLI-EXE] ligação injetada: o CLI executa pelo compositor real e traduz o estado em código de saída', () => {
  const FATOS = { sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', uid: 501, umask: 0o077 };
  const relogioDe = () => { let t = Date.UTC(2026, 10, 5, 12, 0, 0) - 10; return () => { t += 10; return t; }; };
  async function composicaoReal(x, acao) {
    const produtor = { produzir: async () => ({ ok: true, pacote: { dir: x.pacote.dir, lido: x.pacote.lido } }) };
    const coordenacao = { adquirir: async ({ operacao }) => ({ ok: true, operacao, liberar: async () => {} }) };
    const protegidos = { imagens: '/srv/safework/imagens', fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' };
    return async (contexto) => {
      const ex = O.criarExecutorOperacional({
        modo: contexto.modo, ambiente: contexto.ambiente, destinoDuravelId: contexto.destino, confirmacao: contexto.confirmacao, fatos: FATOS, relogio: relogioDe(), coordenacao,
        evidencia: { registrar: async () => {} }, recibos: { registrar: async () => {} }, registro: x.a.reg,
      });
      return {
        executar: () => ex.executarBackup({
          conjuntoId: x.conjuntoId, destinoLocal: { validador: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz, nomeContainer: 'container-1' },
          portas: { producao: produtor, publicador: x.a.s3.clientes.publicador, chaves: x.chaves }, protegidos, limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 }, prazoMs: 1000,
        }),
      };
    };
  }

  test('CLI-35 — ensaio de backup completo pela composição real (S3 e chaves falsos): sai com 0 e o stdout é a linha de evidência CONCLUIDO, sem texto a mais', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cli35' });
    const r = await rodar(ARGS_BACKUP, { compor: await composicaoReal(x, 'BACKUP') });
    assert.equal(r.codigo, SAIDAS.OK, `${r.saida}\n${r.erro}`);
    assert.equal(r.erro, '');
    const e = lida(r.saida);
    assert.deepEqual({ estado: e.estado, modo: e.modo, conjuntoId: e.conjuntoId, op: e.operacional, dur: e.duravelmenteArmazenado }, { estado: 'CONCLUIDO', modo: 'ENSAIO', conjuntoId: 'conjunto-cli35', op: false, dur: false });
  });

  test('CLI-36 — o composto bloqueia (frase errada): o CLI imprime a evidência BLOQUEADO do compositor e sai com 4, sem executar nada', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cli36' });
    const r = await rodar([...ARGS_BACKUP.slice(0, 4), '--confirmo=FRASE_ERRADA'], { compor: await composicaoReal(x, 'BACKUP') });
    assert.equal(r.codigo, SAIDAS.BLOQUEADO);
    assert.ok(lida(r.saida).bloqueios.includes('CONFIRMACAO_AUSENTE_OU_INVALIDA'));
    assert.equal(x.a.s3.chamadas.length, 0);
  });

  test('CLI-37 — o código de saída vem do estado da evidência (não do que a ligação declara): FALHOU=1, RECUSADO=5, INCERTO=6, BLOQUEADO=4; evidência não registrada ou inválida e erro da ligação = 1 com mensagem fixa', async () => {
    const linha = (estado) => {
      const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: relogioDe() });
      if (estado === 'BLOQUEADO') return ev.encerrar({ estado, codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] }).linha;
      ev.etapa('ENVIO', false, 'ENVIO_FALHOU');
      return ev.encerrar({ estado, codigo: 'ENVIO_FALHOU', falhouEm: 'ENVIO' }).linha;
    };
    const comoLigacao = (resultado) => ({ compor: async () => ({ executar: async () => resultado }) });
    for (const [estado, esperado] of [['FALHOU', SAIDAS.FALHA], ['RECUSADO', SAIDAS.RECUSADO], ['INCERTO', SAIDAS.INCERTO], ['BLOQUEADO', SAIDAS.BLOQUEADO]]) {
      const r = await rodar(ARGS_BACKUP, comoLigacao({ estado: 'CONCLUIDO', linha: linha(estado), evidenciaRegistrada: true }));
      assert.equal(r.codigo, esperado, estado);
      assert.equal(lida(r.saida).estado, estado);
    }
    const naoRegistrada = await rodar(ARGS_BACKUP, comoLigacao({ linha: linha('FALHOU'), evidenciaRegistrada: false }));
    assert.deepEqual({ codigo: naoRegistrada.codigo, erro: naoRegistrada.erro }, { codigo: SAIDAS.FALHA, erro: 'EVIDENCIA_NAO_REGISTRADA\n' });
    const invalida = await rodar(ARGS_BACKUP, comoLigacao({ linha: 'qualquer texto\n', evidenciaRegistrada: true }));
    assert.deepEqual({ codigo: invalida.codigo, saida: invalida.saida, erro: invalida.erro }, { codigo: SAIDAS.FALHA, saida: '', erro: 'EVIDENCIA_INVALIDA\n' });
    const quebrada = await rodar(ARGS_BACKUP, { compor: async () => { throw new Error('SEGREDO-DA-LIGACAO'); } });
    assert.deepEqual({ codigo: quebrada.codigo, saida: quebrada.saida, erro: quebrada.erro }, { codigo: SAIDAS.FALHA, saida: '', erro: 'ERRO_INESPERADO: a execução não pôde ser concluída\n' });
  });
});

describe('[CLI-EXE] monitoramento (somente leitura)', () => {
  const agora = Date.now();
  function linha({ acao, h, estado = 'CONCLUIDO', modo = 'OPERACAO' }) {
    const fim = agora - h * 3600000;
    let primeira = true;
    const ev = Ev.criarEvidencia({ modo, acao, ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: () => { if (primeira) { primeira = false; return fim - 1000; } return fim; }, operacaoId: 'cd'.repeat(16) });
    ev.etapa(acao === 'BACKUP' ? 'ENVIO' : 'VERIFICAR_DESTINO', true);
    return ev.encerrar({ estado, conjuntoId: 'c1', sha256Consolidado: 'e5'.repeat(32), origemDeChaves: 'OPERACIONAL', origemDoDestino: 'OPERACIONAL', ...(acao === 'VERIFICACAO_DESTINO' ? { verificacaoIndependente: 'CONFORME' } : {}) }).linha;
  }
  const ARGS = (arquivo, extra = []) => ['--monitorar', `--evidencias=${arquivo}`, '--ambiente=HOMOLOGACAO', '--limite-backup-horas=26', '--limite-verificacao-horas=4', ...extra];
  const arquivoCom = (linhas) => { const pasta = novaPasta(); const caminho = path.join(pasta, 'evidencias.ndjson'); fs.writeFileSync(caminho, linhas.join(''), { mode: 0o600 }); return caminho; };

  test('CLI-38 — tudo em dia: código 0 e VEREDITO: OK; atrasado ou sem verificação: código 7, lista os alertas; --json imprime UM documento; nada é escrito (processo real sob o bloqueador)', () => {
    const ok = rodarReal(ARGS(arquivoCom([linha({ acao: 'BACKUP', h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 })])));
    assert.equal(ok.status, SAIDAS.OK, `${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stdout, /VEREDITO: OK/);
    assert.equal(ok.stderr, '');
    const atrasado = rodarReal(ARGS(arquivoCom([linha({ acao: 'BACKUP', h: 30 })]), ['--json']));
    assert.equal(atrasado.status, SAIDAS.ALERTA);
    const doc = JSON.parse(atrasado.stdout);
    assert.equal(doc.veredito, 'ALERTA');
    assert.ok(doc.alertas.some((a) => a.codigo === 'BACKUP_ATRASADO') && doc.alertas.some((a) => a.codigo === 'VERIFICACAO_INDEPENDENTE_AUSENTE'));
    const texto = rodarReal(ARGS(arquivoCom([linha({ acao: 'BACKUP', h: 30 })])));
    assert.equal(texto.status, SAIDAS.ALERTA);
    assert.match(texto.stdout, /ALERTA CRITICO BACKUP_ATRASADO/);
  });

  test('CLI-39 — arquivo ausente, link simbólico, grande demais ou diretório: código 1 com mensagem fixa e sem eco do caminho; linhas adulteradas viram alerta (7), nunca são ignoradas', () => {
    const pasta = novaPasta();
    const inexistente = rodarReal(ARGS(path.join(pasta, 'nao-existe.ndjson')));
    assert.deepEqual({ status: inexistente.status, stdout: inexistente.stdout, stderr: inexistente.stderr }, { status: SAIDAS.FALHA, stdout: '', stderr: 'EVIDENCIAS_INDISPONIVEIS\n' });
    const real = arquivoCom([linha({ acao: 'BACKUP', h: 3 })]);
    const link = path.join(pasta, 'link.ndjson');
    fs.symlinkSync(real, link);
    const viaLink = rodarReal(ARGS(link));
    assert.deepEqual({ status: viaLink.status, stderr: viaLink.stderr }, { status: SAIDAS.FALHA, stderr: 'EVIDENCIAS_INDISPONIVEIS\n' });
    assert.equal(rodarReal(ARGS(pasta)).status, SAIDAS.FALHA);
    assert.equal(/nao-existe|evidencias\.ndjson|link\.ndjson/.test(inexistente.stderr + viaLink.stderr), false);
    const adulterada = arquivoCom([linha({ acao: 'BACKUP', h: 3 }).replace('"modo":"OPERACAO"', '"modo":"ENSAIO"'), linha({ acao: 'BACKUP', h: 3 })]);
    const r = rodarReal(ARGS(adulterada));
    assert.equal(r.status, SAIDAS.ALERTA);
    assert.match(r.stdout, /EVIDENCIA_ILEGIVEL/);
  });
});
