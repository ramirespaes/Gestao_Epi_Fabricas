'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { criarOrcamentoDeBytes, ehOrcamentoDeBytes, ehFaltaDeEspaco } = require('../../src/utils/orcamento-de-bytes');
const { criarDiagnosticoDoStderr, CODIGOS_DO_STDERR } = require('../../src/services/imagem-backup-diagnostico-stderr.service');
const { criarCapturaDoDump, MOTIVOS_DA_CAPTURA } = require('../../src/services/imagem-backup-captura-dump.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { criarSelagem, operacoesDoSistema } = require('../../src/services/imagem-backup-selagem.service');
const { construirManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const { criarBackupDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso, linhas, DUMP_BYTES } = require('../helpers/ambiente-backup-operacao');

/**
 * P4 (limite total de bytes, ENOSPC, evidências parciais, trava retida) e P5 (diagnóstico sanitizado do stderr do pg_dump). Fluxos em memória, diretórios descartáveis e spawn/cliente falsos: nenhum processo, nenhum PostgreSQL.
 * Os limites aqui são VALORES DE TESTE; nenhum limite operacional existe nem foi inventado.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-lim-test-' });
after(() => { fix.remover(); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);
const fluxo = (...pedacos) => { const s = new PassThrough(); setImmediate(() => { for (const p of pedacos) s.write(p); s.end(); }); return s; };
const pedaco = (n, v = 7) => Buffer.alloc(n, v);
function arquivoExclusivo() {
  const caminho = path.join(fix.criar(), 'dump.custom');
  const descritor = fs.openSync(caminho, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  return { caminho, descritor, fechar: () => { try { fs.closeSync(descritor); } catch { /* já fechado */ } } };
}
const capturar = async (opcoes, stdout, stderr = new PassThrough()) => {
  const f = arquivoExclusivo();
  const ev = await criarCapturaDoDump({ descritor: f.descritor, ...opcoes }).consumir({ stdout, stderr });
  f.fechar();
  return { ev, f, conteudo: fs.readFileSync(f.caminho) };
};
const erroCom = (code) => Object.assign(new Error('SEGREDO-NUNCA-EXPOR'), { code });

describe('[P4-A] orçamento de bytes: contagem exata, tudo ou nada, sem estouro', () => {
  teste('P4-A01 — configuração estrita; só objetos da fábrica são reconhecidos (literal e clone não)', () => {
    for (const ruim of [undefined, null, {}, { totalBytes: 0 }, { totalBytes: -1 }, { totalBytes: 1.5 }, { totalBytes: '10' }, { totalBytes: Number.MAX_SAFE_INTEGER + 1 }, { totalBytes: 10, extra: 1 }]) assert.throws(() => criarOrcamentoDeBytes(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const o = criarOrcamentoDeBytes({ totalBytes: 100 });
    assert.equal(ehOrcamentoDeBytes(o), true);
    for (const falso of [{ reservar: () => ({ ok: true }), restante: () => 1e9 }, { ...o }, Object.create(o), null, 7]) assert.equal(ehOrcamentoDeBytes(falso), false);
    assert.ok(Object.isFrozen(o));
  });

  teste('P4-A02 — contagem exata e atômica: a soma das reservas aceitas é o `usado`; a reserva que não cabe NÃO consome nada; o saldo fecha em zero', () => {
    const o = criarOrcamentoDeBytes({ totalBytes: 100 });
    assert.deepEqual([o.reservar(40).ok, o.usado(), o.restante()], [true, 40, 60]);
    assert.deepEqual({ ...o.reservar(61) }, { ok: false, motivo: 'LIMITE_TOTAL_EXCEDIDO' });
    assert.deepEqual([o.usado(), o.restante()], [40, 60], 'a recusa não consumiu nada');
    assert.equal(o.reservar(60).ok, true);
    assert.deepEqual([o.usado(), o.restante()], [100, 0]);
    assert.equal(o.reservar(1).ok, false);
    assert.equal(o.reservar(0).ok, true, 'zero bytes cabem sempre');
  });

  teste('P4-A03 — SEM ESTOURO ARITMÉTICO: com total = MAX_SAFE_INTEGER a soma nunca passa de 2^53; quantidades inválidas (NaN, negativa, fracionária, texto, BigInt, > MAX_SAFE) são recusadas sem alterar o saldo', () => {
    const o = criarOrcamentoDeBytes({ totalBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(o.reservar(Number.MAX_SAFE_INTEGER - 1).ok, true);
    assert.equal(o.reservar(2).ok, false);
    assert.equal(o.reservar(1).ok, true);
    assert.equal(o.usado(), Number.MAX_SAFE_INTEGER);
    assert.equal(o.restante(), 0);
    assert.equal(o.reservar(1).ok, false);
    const p = criarOrcamentoDeBytes({ totalBytes: 10 });
    for (const ruim of [NaN, Infinity, -1, 1.5, '1', 1n, Number.MAX_SAFE_INTEGER + 1, undefined, null, {}]) assert.deepEqual({ ...p.reservar(ruim) }, { ok: false, motivo: 'QUANTIDADE_INVALIDA' }, String(ruim));
    assert.equal(p.usado(), 0);
  });

  teste('P4-A04 — falta de espaço: só ENOSPC e EDQUOT', () => {
    assert.deepEqual([ehFaltaDeEspaco(erroCom('ENOSPC')), ehFaltaDeEspaco(erroCom('EDQUOT')), ehFaltaDeEspaco(erroCom('EIO')), ehFaltaDeEspaco(null), ehFaltaDeEspaco('ENOSPC')], [true, true, false, false, false]);
  });
});

describe('[P4-B] captura do dump: limite aplicado DURANTE a produção, ENOSPC e evidência parcial preservada', () => {
  teste('P4-B01 — limite do dump: o pedaço que não cabe NÃO é hasheado, contado nem gravado; o stdout é encerrado; o parcial aceito fica no arquivo; motivo LIMITE_EXCEDIDO', async () => {
    const stdout = fluxo(pedaco(100, 1), pedaco(100, 2), pedaco(100, 3));
    const { ev, conteudo } = await capturar({ limiteDeBytes: 250 }, stdout);
    assert.deepEqual([ev.ok, ev.motivo, ev.bytesRecebidos, ev.bytesGravados], [false, 'LIMITE_EXCEDIDO', 200, 200]);
    assert.equal(ev.sha256FluxoRecebido, undefined);
    assert.deepEqual(conteudo, Buffer.concat([pedaco(100, 1), pedaco(100, 2)]), 'o parcial aceito foi preservado, exatamente');
    assert.equal(stdout.destroyed, true, 'o fluxo foi encerrado (o pg_dump recebe a quebra do pipe)');
  });

  teste('P4-B02 — exatamente no limite é aceito; um byte acima recusa o pedaço inteiro (nada parcial do pedaço); pedaço único maior que o limite => 0 byte aceito', async () => {
    const igual = await capturar({ limiteDeBytes: 300 }, fluxo(pedaco(100), pedaco(100), pedaco(100)));
    assert.deepEqual([igual.ev.ok, igual.ev.bytesRecebidos], [true, 300]);
    const acima = await capturar({ limiteDeBytes: 299 }, fluxo(pedaco(100), pedaco(100), pedaco(100)));
    assert.deepEqual([acima.ev.ok, acima.ev.motivo, acima.ev.bytesRecebidos, acima.conteudo.length], [false, 'LIMITE_EXCEDIDO', 200, 200]);
    const unico = await capturar({ limiteDeBytes: 50 }, fluxo(pedaco(100)));
    assert.deepEqual([unico.ev.motivo, unico.ev.bytesRecebidos, unico.ev.bytesGravados, unico.conteudo.length], ['LIMITE_EXCEDIDO', 0, 0, 0]);
  });

  teste('P4-B02b — DEPOIS de uma recusa nada mais entra: um pedaço pequeno que viria logo após o pedaço recusado NÃO é gravado (o arquivo parcial é sempre um PREFIXO contíguo do fluxo); vale para limite do dump, orçamento e falha de escrita síncrona', async () => {
    const limite = await capturar({ limiteDeBytes: 250 }, fluxo(pedaco(100, 1), pedaco(100, 2), pedaco(200, 3), pedaco(10, 4)));
    assert.deepEqual([limite.ev.motivo, limite.ev.bytesRecebidos], ['LIMITE_EXCEDIDO', 200]);
    assert.deepEqual(limite.conteudo, Buffer.concat([pedaco(100, 1), pedaco(100, 2)]));
    const o = criarOrcamentoDeBytes({ totalBytes: 250 });
    const total = await capturar({ orcamento: o }, fluxo(pedaco(100, 1), pedaco(100, 2), pedaco(200, 3), pedaco(10, 4)));
    assert.deepEqual([total.ev.motivo, total.ev.bytesRecebidos, o.usado(), total.conteudo.length], ['LIMITE_TOTAL_EXCEDIDO', 200, 200, 200]);
    let n = 0;
    const sincrono = (fd, b, off, len, pos, cb) => { n += 1; if (n === 2) { cb(erroCom('ENOSPC')); return; } fs.write(fd, b, off, len, pos, cb); };
    const escrita = await capturar({ sistemaDeArquivos: { escrever: sincrono, sincronizar: fs.fsync } }, fluxo(pedaco(100, 1), pedaco(100, 2), pedaco(10, 3)));
    assert.deepEqual([escrita.ev.motivo, escrita.ev.bytesRecebidos, escrita.ev.bytesGravados, n], ['ESPACO_ESGOTADO', 200, 100, 2]);
    assert.deepEqual(escrita.conteudo, pedaco(100, 1));
  });

  teste('P4-B03 — orçamento TOTAL compartilhado: a captura reserva cada pedaço antes de gravar; excedido => LIMITE_TOTAL_EXCEDIDO, `usado` = exatamente os bytes aceitos; sucesso exato fecha o saldo em zero', async () => {
    const o = criarOrcamentoDeBytes({ totalBytes: 250 });
    const { ev, conteudo } = await capturar({ orcamento: o }, fluxo(pedaco(100), pedaco(100), pedaco(100)));
    assert.deepEqual([ev.ok, ev.motivo, ev.bytesRecebidos, conteudo.length, o.usado()], [false, 'LIMITE_TOTAL_EXCEDIDO', 200, 200, 200]);
    const exato = criarOrcamentoDeBytes({ totalBytes: 300 });
    const ok = await capturar({ orcamento: exato }, fluxo(pedaco(100), pedaco(100), pedaco(100)));
    assert.deepEqual([ok.ev.ok, exato.usado(), exato.restante()], [true, 300, 0]);
  });

  teste('P4-B04 — os dois limites juntos: vale o que for atingido primeiro, e o pedaço recusado NÃO consome o orçamento', async () => {
    const o = criarOrcamentoDeBytes({ totalBytes: 10000 });
    const { ev } = await capturar({ limiteDeBytes: 150, orcamento: o }, fluxo(pedaco(100), pedaco(100)));
    assert.deepEqual([ev.motivo, o.usado()], ['LIMITE_EXCEDIDO', 100]);
  });

  teste('P4-B05 — sem estouro na captura: limite = MAX_SAFE_INTEGER aceita normalmente; orçamento esgotado até o último byte recusa o primeiro pedaço', async () => {
    const livre = await capturar({ limiteDeBytes: Number.MAX_SAFE_INTEGER }, fluxo(pedaco(100)));
    assert.equal(livre.ev.ok, true);
    const o = criarOrcamentoDeBytes({ totalBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(o.reservar(Number.MAX_SAFE_INTEGER).ok, true);
    const { ev } = await capturar({ orcamento: o }, fluxo(pedaco(1)));
    assert.deepEqual([ev.ok, ev.motivo, ev.bytesRecebidos], [false, 'LIMITE_TOTAL_EXCEDIDO', 0]);
  });

  teste('P4-B06 — opções inválidas (limite 0, negativo, fracionário, texto; orçamento literal) e o conjunto de motivos fechado', () => {
    const f = arquivoExclusivo();
    try {
      for (const ruim of [{ limiteDeBytes: 0 }, { limiteDeBytes: -5 }, { limiteDeBytes: 1.5 }, { limiteDeBytes: '10' }, { orcamento: { reservar: () => ({ ok: true }) } }, { orcamento: null }, { extra: 1 }]) assert.throws(() => criarCapturaDoDump({ descritor: f.descritor, ...ruim }), TypeError, JSON.stringify(ruim));
    } finally { f.fechar(); }
    for (const m of ['LIMITE_EXCEDIDO', 'LIMITE_TOTAL_EXCEDIDO', 'ESPACO_ESGOTADO']) assert.ok(MOTIVOS_DA_CAPTURA.includes(m), m);
  });

  teste('P4-B07 — ENOSPC / EDQUOT na ESCRITA: ESPACO_ESGOTADO, bytes já gravados preservados e contados; outro erro de escrita continua ERRO_DE_ESCRITA', async () => {
    for (const code of ['ENOSPC', 'EDQUOT']) {
      let n = 0;
      const escrever = (fd, b, o, l, p, cb) => { n += 1; if (n === 2) { cb(erroCom(code)); return; } fs.write(fd, b, o, l, p, cb); };
      const { ev, conteudo } = await capturar({ sistemaDeArquivos: { escrever, sincronizar: fs.fsync } }, fluxo(pedaco(100, 1), pedaco(100, 2), pedaco(100, 3)));
      assert.deepEqual([ev.ok, ev.motivo, ev.bytesGravados], [false, 'ESPACO_ESGOTADO', 100], code);
      assert.deepEqual(conteudo, pedaco(100, 1), `${code}: parcial preservado`);
    }
    const outro = await capturar({ sistemaDeArquivos: { escrever: (fd, b, o, l, p, cb) => cb(erroCom('EIO')), sincronizar: fs.fsync } }, fluxo(pedaco(100)));
    assert.equal(outro.ev.motivo, 'ERRO_DE_ESCRITA');
  });

  teste('P4-B08 — ENOSPC no FSYNC: ESPACO_ESGOTADO (não FSYNC_FALHOU), com todos os bytes gravados e contados', async () => {
    const { ev, conteudo } = await capturar({ sistemaDeArquivos: { escrever: fs.write, sincronizar: (fd, cb) => cb(erroCom('ENOSPC')) } }, fluxo(pedaco(100)));
    assert.deepEqual([ev.ok, ev.motivo, ev.bytesGravados, conteudo.length], [false, 'ESPACO_ESGOTADO', 100, 100]);
  });
});

describe('[P4-C] cópia das imagens com orçamento: saldo aplicado durante a gravação', () => {
  /** Origem com três imagens fictícias de 40, 50 e 60 bytes (hashes reais). */
  async function cenario() {
    const origem = criarArmazenamentoImagens({ diretorio: fix.criar() });
    const destino = criarArmazenamentoImagens({ diretorio: fix.criar() });
    const conteudos = [pedaco(40, 1), pedaco(50, 2), pedaco(60, 3)];
    const plano = [];
    for (const c of conteudos) {
      const chave = `padrao/${sha(c)}/mestre.png`;
      await origem.gravar(chave, c, { maxBytes: 1000, sha256Esperado: sha(c) });
      plano.push({ chave, sha256: sha(c) });
    }
    const aberturas = [];
    const origemEspia = { abrir: (chave) => { aberturas.push(chave); return origem.abrir(chave); } };
    return { origem: origemEspia, destino, plano, aberturas, conteudos };
  }

  teste('P4-C01 — orçamento suficiente e exato: tudo copiado, `usado` = soma exata dos bytes gravados e saldo zero', async () => {
    const c = await cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 150 });
    const r = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 1000, orcamento: o })({ plano: c.plano });
    assert.deepEqual([r.ok, r.copiados, r.arquivos.map((a) => a.bytes)], [true, 3, [40, 50, 60]]);
    assert.deepEqual([o.usado(), o.restante()], [150, 0]);
  });

  teste('P4-C02 — saldo insuficiente NO MEIO do arquivo: LIMITE_TOTAL_EXCEDIDO (não LIMITE_EXCEDIDO), itens anteriores PRESERVADOS no destino, o parcial do item falho não fica, `usado` = só os itens concluídos', async () => {
    const c = await cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 100 });
    const r = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 1000, orcamento: o })({ plano: c.plano });
    assert.equal(r.ok, false);
    assert.deepEqual([r.falha.codigo, r.falha.chave, r.copiados], ['LIMITE_TOTAL_EXCEDIDO', c.plano[2].chave, 2]);
    assert.equal(o.usado(), 90);
    assert.equal(await c.destino.existe(c.plano[0].chave), true);
    assert.equal(await c.destino.existe(c.plano[1].chave), true);
    assert.equal(await c.destino.existe(c.plano[2].chave), false);
  });

  teste('P4-C03 — saldo ZERO antes do item: a origem do item nem é aberta (nada lido, nada gravado)', async () => {
    const c = await cenario();
    const o = criarOrcamentoDeBytes({ totalBytes: 90 });
    const r = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 1000, orcamento: o })({ plano: c.plano });
    assert.deepEqual([r.falha.codigo, r.copiados, o.usado()], ['LIMITE_TOTAL_EXCEDIDO', 2, 90]);
    assert.equal(c.aberturas.includes(c.plano[2].chave), false, 'o terceiro arquivo não foi aberto');
  });

  teste('P4-C04 — o limite POR ARQUIVO continua distinto: orçamento folgado e arquivo acima de `maxBytesPorArquivo` => LIMITE_EXCEDIDO; sem orçamento nada mudou', async () => {
    const c = await cenario();
    const r = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 45, orcamento: criarOrcamentoDeBytes({ totalBytes: 1000 }) })({ plano: c.plano });
    assert.deepEqual([r.falha.codigo, r.falha.chave], ['LIMITE_EXCEDIDO', c.plano[1].chave]);
    const d = await cenario();
    const livre = await criarCopiaDeImagens({ origem: d.origem, destino: d.destino, maxBytesPorArquivo: 1000 })({ plano: d.plano });
    assert.equal(livre.ok, true);
    assert.throws(() => criarCopiaDeImagens({ origem: d.origem, destino: d.destino, maxBytesPorArquivo: 1000, orcamento: { restante: () => 1e9, reservar: () => ({ ok: true }) } }), TypeError);
  });
});

describe('[P4-D] composição de produção: limites, espaço indicativo, ENOSPC nos demais escritores e trava retida', () => {
  const somaDasImagens = () => {
    const l = linhas();
    return [...l.padrao, ...l.empresa].reduce((acc, r) => acc + [r.bytes_mestre, r.bytes_exibicao, r.bytes_miniatura].filter((n) => Number.isSafeInteger(n)).reduce((x, y) => x + y, 0), 0);
  };
  const executar = (a, nome = 'prep-1') => criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: nome, conjuntoId: 'conjunto-p4-0001' });
  const comLimites = (limites, extras = {}) => ambiente({ ...extras, alterarConfig: (c) => { c.limites = limites; return c; } });

  teste('P4-D01 — configuração: `limites` estrito (chaves conhecidas, inteiros seguros positivos, teto do dump <= total, pelo menos uma chave); sem `limites` nada muda', async () => {
    for (const ruim of [{}, { totalBytes: 0 }, { totalBytes: 1.5 }, { totalBytes: '9' }, { maxBytesDoDump: 10, totalBytes: 5 }, { extra: 1 }, null, 'x', []]) {
      const a = await comLimites(ruim);
      assert.throws(() => criarBackupDeProducao(a.config), (e) => e.code === 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim));
    }
    const a = await ambiente();
    const composto = await executar(a);
    assert.equal(composto.proveniencia.limites.configurados, false);
    assert.equal(composto.proveniencia.limites.usadoDoOrcamento, null);
  });

  teste('P4-D02 — LIMITE DO DUMP atingido no meio do fluxo: o dump parcial (só os pedaços aceitos) fica preservado, nada é publicado e a TRAVA FICA RETIDA (saída 11, RETIDA, trava no disco)', async () => {
    const falso = spawnFalso({ pedacos: 4 });
    const a = await comLimites({ maxBytesDoDump: 1000 }, { portasExtras: { spawn: falso.spawn } });
    const composto = await executar(a);
    assert.deepEqual([composto.proveniencia.captura.ok, composto.proveniencia.captura.motivo], [false, 'LIMITE_EXCEDIDO']);
    assert.equal(composto.proveniencia.captura.bytesRecebidos, 900);
    const arquivos = fs.readdirSync(a.dirs.dumps);
    assert.equal(arquivos.length, 1);
    assert.equal(fs.statSync(path.join(a.dirs.dumps, arquivos[0])).size, 900, 'o parcial aceito foi preservado');
    assert.deepEqual([composto.resultado.coordenador.saida, composto.resultado.coordenador.janela, composto.resultado.coordenador.valido], [11, 'RETIDA', false]);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a trava segue retida (estado inconclusivo)');
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.equal(composto.resultado.publicacao === null || composto.resultado.publicacao.publicada !== true, true);
  });

  teste('P4-D03 — ORÇAMENTO TOTAL da execução (dump + imagens): se o dump consome o orçamento e a cópia estoura, a falha é da COPIA (LIMITE_TOTAL_EXCEDIDO), as imagens já copiadas são preservadas, nada é publicado e, com o dump concluído e confirmado, a trava é liberada normalmente', async () => {
    const falso = spawnFalso();
    const a = await comLimites({ totalBytes: DUMP_BYTES.length + somaDasImagens() - 1 }, { portasExtras: { spawn: falso.spawn } });
    const composto = await executar(a);
    assert.equal(composto.proveniencia.captura.ok, true);
    assert.equal(composto.proveniencia.limites.totalBytes, DUMP_BYTES.length + somaDasImagens() - 1);
    assert.equal(composto.resultado.composicao.ok, false);
    assert.equal(composto.resultado.composicao.falha.codigo, 'LIMITE_TOTAL_EXCEDIDO');
    assert.equal(composto.proveniencia.limites.usadoDoOrcamento > DUMP_BYTES.length, true, 'ao menos uma imagem foi copiada e contada');
    assert.equal(composto.proveniencia.limites.usadoDoOrcamento <= composto.proveniencia.limites.totalBytes, true);
    const copiadas = fs.readdirSync(path.join(a.dirs.preparacoes, 'prep-1', 'imagens'));
    assert.ok(copiadas.length >= 1, 'as imagens já copiadas foram preservadas');
    assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false, 'dump concluído e confirmado: a trava é liberada pelo fluxo normal');
  });

  teste('P4-D04 — orçamento EXATO (dump + imagens): conclui, `usado` = total e saldo zero', async () => {
    const total = DUMP_BYTES.length + somaDasImagens();
    const a = await comLimites({ totalBytes: total });
    const composto = await executar(a);
    assert.equal(composto.proveniencia.captura.ok, true);
    assert.equal(composto.resultado.composicao.ok, true);
    assert.deepEqual([composto.proveniencia.limites.usadoDoOrcamento, composto.proveniencia.limites.totalBytes], [total, total]);
  });

  teste('P4-D05 — verificação de espaço INDICATIVA: abaixo do mínimo recusa ANTES de qualquer efeito (zero spawn, zero arquivo novo); suficiente passa (sem garantia); statfs indisponível não bloqueia e consta como INDISPONIVEL; o produto bavail*bsize usa BigInt', async () => {
    const livre = (bavail, bsize = 4096) => () => ({ bavail, bsize });
    const falso = spawnFalso();
    const a = await comLimites({ bytesLivresMinimos: 10_000_000 }, { portasExtras: { spawn: falso.spawn, statfs: livre(100) } });
    const antes = [fs.readdirSync(a.dirs.dumps).length, fs.readdirSync(a.dirs.preparacoes).length, fs.readdirSync(a.dirs.publicados).length];
    await assert.rejects(() => executar(a), (e) => e.code === 'ESPACO_INSUFICIENTE' && ['DUMPS', 'PREPARACOES', 'PUBLICADOS'].includes(e.item));
    assert.equal(falso.chamadas.length, 0);
    assert.deepEqual([fs.readdirSync(a.dirs.dumps).length, fs.readdirSync(a.dirs.preparacoes).length, fs.readdirSync(a.dirs.publicados).length], antes);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false);

    const b = await comLimites({ bytesLivresMinimos: 10_000_000 }, { portasExtras: { statfs: livre(Number.MAX_SAFE_INTEGER, 4096) } });
    const ok = await executar(b);
    assert.deepEqual({ ...ok.proveniencia.limites.espacoIndicativo }, { verificado: true, motivo: null, indicativo: true });

    const c = await comLimites({ bytesLivresMinimos: 10_000_000 }, { portasExtras: { statfs: () => { throw new Error('sem statfs'); } } });
    const semStatfs = await executar(c);
    assert.deepEqual({ ...semStatfs.proveniencia.limites.espacoIndicativo }, { verificado: false, motivo: 'INDISPONIVEL' });
    const d = await comLimites({ totalBytes: 10_000_000 });
    assert.equal((await executar(d)).proveniencia.limites.espacoIndicativo.motivo, 'NAO_CONFIGURADO');
  });

  teste('P4-D06 — ENOSPC na SELAGEM: ESPACO_ESGOTADO (distinto de ESCRITA_FALHOU), o que a operação criou é limpo pela regra de sempre e nada preexistente é tocado', async () => {
    const area = fix.criar();
    fs.writeFileSync(path.join(area, 'preexistente.txt'), 'x');
    const PLANO = [{ chave: `7/${H('d')}/mestre.png`, sha256: H('e') }, { chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }];
    const manifesto = construirManifesto({
      contexto: { snapshotId: '0-0-0', banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: PLANO.map((p) => ({ ...p })) },
      copia: { ok: true, completo: true, copiados: 2, falha: null, arquivos: PLANO.map((p, i) => ({ ...p, bytes: 3 + i })) },
      dump: { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') },
      conjuntoId: 'conjunto-p4-sel',
    });
    const ops = { ...operacoesDoSistema(), ligar: async () => { throw erroCom('ENOSPC'); } };
    const r = await criarSelagem({ operacoes: ops }).selar({ area, resultado: manifesto });
    assert.deepEqual([r.ok, r.falha.codigo], [false, 'ESPACO_ESGOTADO']);
    assert.deepEqual(fs.readdirSync(area), ['preexistente.txt']);
    const outro = await criarSelagem({ operacoes: { ...operacoesDoSistema(), ligar: async () => { throw erroCom('EIO'); } } }).selar({ area, resultado: manifesto });
    assert.equal(outro.falha.codigo, 'ESCRITA_FALHOU');
  });
});

describe('[P5] diagnóstico sanitizado do stderr do pg_dump', () => {
  const diag = (...textos) => { const d = criarDiagnosticoDoStderr(); for (const t of textos) d.consumir(Buffer.isBuffer(t) ? t : Buffer.from(t, 'utf8')); return d.resultado(); };
  const SEGREDOS = ['SenhaSuperSecreta!42', '10.20.30.40', 'usuario_admin', '/Users/privado/pgpass', 'postgresql://', 'SELECT * FROM tabela_secreta'];

  teste('P5-01 — cada padrão da tabela fechada mapeia o código esperado e NENHUM texto sai: só código, ocorrências, contadores e `truncado`', () => {
    const amostras = {
      ESPACO_ESGOTADO: 'pg_dump: error: could not write to file: No space left on device',
      AUTENTICACAO_FALHOU: 'FATAL:  password authentication failed for user "x"',
      PERMISSAO_NEGADA: 'pg_dump: error: query failed: ERROR:  permission denied for table t',
      VERSAO_INCOMPATIVEL: 'pg_dump: error: aborting because of server version mismatch',
      SNAPSHOT_INVALIDO: 'pg_dump: error: could not import the requested snapshot',
      BANCO_INEXISTENTE: 'FATAL:  database "zzz" does not exist',
      CONEXAO_RECUSADA: 'pg_dump: error: connection to server at "h", port 5432 failed: Connection refused',
      INTERROMPIDO: 'pg_dump: error: server closed the connection unexpectedly',
      ERRO_GENERICO: 'pg_dump: error: algo qualquer inesperado',
    };
    for (const [codigo, linha] of Object.entries(amostras)) {
      const r = diag(`${linha}\n`);
      assert.deepEqual(r.codigos.map((c) => c.codigo), [codigo], codigo);
      assert.deepEqual([r.linhas, r.naoClassificadas, r.truncado], [1, 0, false], codigo);
      assert.equal(JSON.stringify(r).includes(linha.slice(10)), false, 'nenhum trecho do texto');
    }
    assert.deepEqual([...CODIGOS_DO_STDERR].sort(), Object.keys(amostras).sort(), 'o enum é exatamente a tabela');
    assert.ok(Object.isFrozen(diag('x\n')));
  });

  teste('P5-02 — SEGREDOS no stderr (senha, host, usuário, caminho, URI, SQL) nunca aparecem em nenhum campo do diagnóstico nem do resultado da captura', async () => {
    const ruido = [
      'pg_dump: error: connection to server at "10.20.30.40", port 5432 failed: FATAL:  password authentication failed for user "usuario_admin"',
      'password=SenhaSuperSecreta!42 passfile=/Users/privado/pgpass postgresql://usuario_admin:SenhaSuperSecreta!42@10.20.30.40/db',
      'pg_dump: error: query was: SELECT * FROM tabela_secreta',
      '',
    ].join('\n');
    const r = diag(ruido);
    for (const s of SEGREDOS) assert.equal(JSON.stringify(r).includes(s), false, s);
    assert.equal(r.codigos.some((c) => c.codigo === 'AUTENTICACAO_FALHOU'), true);
    const { ev } = await capturar({}, fluxo(pedaco(100)), (() => { const e = new PassThrough(); setImmediate(() => { e.write(Buffer.from(ruido)); e.end(); }); return e; })());
    for (const s of SEGREDOS) assert.equal(JSON.stringify(ev).includes(s), false, `captura: ${s}`);
    assert.equal(ev.ok, true);
  });

  teste('P5-03 — limites: linha longa só classifica os 512 primeiros bytes e marca truncado; mais de 64 KiB só são contados; no máximo 8 códigos distintos; contadores saturam; binário/UTF-8 inválido e não-Buffer não lançam', () => {
    const longa = diag(`${'a'.repeat(600)} password authentication failed\n`);
    assert.deepEqual([longa.truncado, longa.codigos.length, longa.naoClassificadas], [true, 0, 1], 'o padrão além do byte 512 não é visto');
    const curta = diag('password authentication failed\n');
    assert.equal(curta.codigos[0].codigo, 'AUTENTICACAO_FALHOU');

    const grande = diag(Buffer.alloc(100 * 1024, 0x61));
    assert.deepEqual([grande.bytes, grande.truncado], [100 * 1024, true]);
    const muitos = diag(Object.values({ a: 'No space left on device', b: 'password authentication failed', c: 'permission denied', d: 'server version mismatch', e: 'invalid snapshot', f: 'database "x" does not exist', g: 'connection refused', h: 'terminating connection', i: 'pg_dump: error: x' }).map((t) => `${t}\n`).join(''));
    assert.deepEqual([muitos.codigos.length, muitos.truncado], [8, true], 'o 9º código distinto é descartado e marca truncado');
    const saturado = diag('permission denied\n'.repeat(1500));
    assert.deepEqual([saturado.codigos[0].ocorrencias, saturado.linhas], [999, 1500]);
    assert.doesNotThrow(() => { const d = criarDiagnosticoDoStderr(); d.consumir(Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0xc3, 0x28])); d.consumir('texto'); d.consumir(null); d.consumir(undefined); d.consumir({}); d.resultado(); });
  });

  teste('P5-04 — a linha final SEM quebra conta; o resultado é repetível e linhas sem padrão contam como não classificadas', () => {
    const d = criarDiagnosticoDoStderr();
    d.consumir(Buffer.from('permission denied for rel'));
    d.consumir(Buffer.from('ation x'));
    const a = d.resultado();
    const b = d.resultado();
    assert.deepEqual(a, b);
    assert.deepEqual([a.linhas, a.codigos.map((c) => c.codigo)], [1, ['PERMISSAO_NEGADA']]);
    assert.deepEqual([diag('nada conhecido\n').naoClassificadas, diag('nada conhecido\n').codigos.length], [1, 0]);
  });

  teste('P5-05 — o diagnóstico NÃO altera decisões: a mesma captura com stderr barulhento ou silencioso devolve o mesmo veredito, os mesmos bytes e o mesmo hash; falha do dump também não muda por causa do stderr', async () => {
    const silencioso = await capturar({}, fluxo(pedaco(100), pedaco(100)));
    const ruido = new PassThrough();
    setImmediate(() => { ruido.write(Buffer.from('FATAL: password authentication failed\nno space left on device\n')); ruido.end(); });
    const barulhento = await capturar({}, fluxo(pedaco(100), pedaco(100)), ruido);
    const nucleo = (e) => ({ ok: e.ok, bytesRecebidos: e.bytesRecebidos, bytesGravados: e.bytesGravados, sha256FluxoRecebido: e.sha256FluxoRecebido, fsyncConcluido: e.fsyncConcluido });
    assert.deepEqual(nucleo(barulhento.ev), nucleo(silencioso.ev));
    assert.notDeepEqual(barulhento.ev.diagnosticoDoStderr, silencioso.ev.diagnosticoDoStderr);
    const comErro = new PassThrough();
    setImmediate(() => { comErro.write(pedaco(10)); comErro.destroy(new Error('quebrou')); });
    const ruido2 = new PassThrough();
    setImmediate(() => { ruido2.write(Buffer.from('tudo certo, ok\n')); ruido2.end(); });
    const falha = await capturar({}, comErro, ruido2);
    assert.deepEqual([falha.ev.ok, falha.ev.motivo], [false, 'ERRO_NO_FLUXO']);
  });

  teste('P5-06 — pela COMPOSIÇÃO: o stderr barulhento do pg_dump (falso) não muda o veredito do coordenador, a trava, a publicação nem o hash; o diagnóstico consta só como códigos e contadores', async () => {
    const base = await ambiente();
    const referencia = await criarBackupDeProducao(base.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-p5-0001' });
    const texto = `pg_dump: error: connection to server at "10.20.30.40" failed: password authentication failed for user "usuario_admin"\nSenhaSuperSecreta!42 /Users/privado/pgpass\n`;
    const a = await ambiente({ portasExtras: { spawn: spawnFalso({ stderrTexto: texto }).spawn } });
    const composto = await criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-p5-0001' });
    const veredito = (c) => [c.resultado.coordenador.saida, c.resultado.coordenador.valido, c.resultado.coordenador.janela, c.proveniencia.captura.ok, c.proveniencia.captura.sha256FluxoRecebido, c.resultado.publicacao && c.resultado.publicacao.publicada];
    assert.deepEqual(veredito(composto), veredito(referencia));
    const d = composto.proveniencia.captura.diagnosticoDoStderr;
    assert.equal(d.codigos.some((c) => c.codigo === 'AUTENTICACAO_FALHOU'), true);
    for (const s of SEGREDOS) assert.equal(JSON.stringify(composto.proveniencia).includes(s), false, s);
  });
});
