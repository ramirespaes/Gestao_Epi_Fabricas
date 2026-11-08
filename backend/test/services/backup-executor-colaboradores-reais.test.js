'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { montarColaboradoresReais } = require('../../src/services/backup-executor-colaboradores-reais.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const { prepararAmbiente } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');

/** D-ORF-6, Rodada B (B3A) [MR]: montador das peças reais do executor. Fábricas falsas provam a fiação e as derivações; as fábricas reais de coordenação, auditoria, leitor e produção L2 provam que aceitam o que o montador entrega. Nada abre conexão. */

after(limparRaizes);
const RAIZ = path.join(__dirname, '..', '..');
const FONTE = Object.freeze({ id: 'fonte-de-chaves-falsa' });
const relogio = () => 1_800_000_000_000;
const registrarEventoSistema = async () => ({ id: '1' });
const sessao = (nome) => ({ nome, query: async () => ({ rows: [] }) });
const composicaoDeBackup = (publicados = '/srv/safework/backup/publicados') => ({ armazenamento: { imagens: '/srv/i', preparacoes: '/srv/p', dumps: '/srv/d', publicados }, chaves: { fonteDeChaves: FONTE, chaveId: 'mac-1' }, marcador: 'cfg-backup' });
const composicaoDeRestauracao = () => ({ marcador: 'cfg-restauracao' });
const restauracao = (extra = {}) => ({ composicao: composicaoDeRestauracao(), raizAutorizada: '/srv/safework/backup/publicados', destino: { banco: 'gepi_rest_x' }, imagens: { raiz: '/srv/safework/restauracoes', nome: 'imagens-x' }, maxBytesPorArquivo: 1048576, ...extra });

/** Fábricas falsas que registram cada chamada e devolvem objetos reconhecíveis. */
function fabricasFalsas() {
  const chamadas = [];
  const reg = (nome, retorno) => (arg) => { chamadas.push([nome, arg]); return retorno(arg); };
  return {
    chamadas,
    fabricas: {
      criarBackupDeProducao: reg('criarBackupDeProducao', () => ({ tipo: 'composicao-backup', executar: async () => {} })),
      criarRestauracaoDeProducao: reg('criarRestauracaoDeProducao', () => ({ tipo: 'composicao-restauracao', restaurar: async () => {} })),
      criarLeitorDePacote: reg('criarLeitorDePacote', () => ({ tipo: 'leitor', lerPacote: async () => {} })),
      criarProducaoL2: reg('criarProducaoL2', () => ({ tipo: 'producao', produzir: async () => {} })),
      criarRestauradorL2: reg('criarRestauradorL2', () => ({ tipo: 'restaurador', restaurar: async () => {} })),
      criarCoordenacaoDoExecutor: reg('criarCoordenacaoDoExecutor', () => ({ tipo: 'coordenacao', adquirir: async () => {} })),
      criarAuditoriaDoExecutor: reg('criarAuditoriaDoExecutor', () => ({ tipo: 'auditoria', registrar: async () => {} })),
    },
  };
}
const base = (extra = {}) => ({ acao: 'VERIFICACAO_DESTINO', executorDeCoordenacao: sessao('coord'), executorDeAuditoria: sessao('audit'), registrarEventoSistema, relogio, ...extra });
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('[MR] montador das peças reais do executor', () => {
  test('MR-01 — BACKUP: compõe coordenação, auditoria e produção; raiz de publicados e fonte de chaves do leitor são DERIVADAS da configuração da composição', () => {
    const { fabricas, chamadas } = fabricasFalsas();
    const executorDeCoordenacao = sessao('coord');
    const executorDeAuditoria = sessao('audit');
    const composicao = composicaoDeBackup('/srv/x/publicados');
    const pecas = montarColaboradoresReais(base({ acao: 'BACKUP', executorDeCoordenacao, executorDeAuditoria, backup: { composicao, tamanhoMaximo: 4096 }, fabricas }));
    assert.deepEqual(Object.keys(pecas).sort(), ['auditoria', 'coordenacao', 'producao']);
    assert.ok(Object.isFrozen(pecas));
    const chamada = (nome) => chamadas.find(([n]) => n === nome)?.[1];
    assert.equal(chamada('criarCoordenacaoDoExecutor').executorDeBanco, executorDeCoordenacao);
    assert.equal(chamada('criarAuditoriaDoExecutor').executorDeBanco, executorDeAuditoria);
    assert.equal(chamada('criarAuditoriaDoExecutor').registrarEventoSistema, registrarEventoSistema);
    assert.equal(chamada('criarBackupDeProducao'), composicao);
    assert.deepEqual({ ...chamada('criarLeitorDePacote') }, { fonteDeChaves: FONTE, raizPublicados: '/srv/x/publicados', tamanhoMaximo: 4096 });
    assert.equal(chamada('criarLeitorDePacote').fonteDeChaves, FONTE);
    const entrada = chamada('criarProducaoL2');
    assert.equal(entrada.composicao.tipo, 'composicao-backup');
    assert.equal(entrada.raizPublicados, '/srv/x/publicados');
    assert.equal(typeof entrada.lerPacote, 'function');
    assert.ok(!chamadas.some(([n]) => n === 'criarRestauracaoDeProducao' || n === 'criarRestauradorL2'));
  });

  test('MR-02 — RESTAURACAO: compõe coordenação, auditoria e restaurador, com os parâmetros recebidos e o relógio injetado', () => {
    const { fabricas, chamadas } = fabricasFalsas();
    const dados = restauracao();
    const pecas = montarColaboradoresReais(base({ acao: 'RESTAURACAO', restauracao: dados, fabricas }));
    assert.deepEqual(Object.keys(pecas).sort(), ['auditoria', 'coordenacao', 'restaurador']);
    assert.equal(chamadas.find(([n]) => n === 'criarRestauracaoDeProducao')[1], dados.composicao);
    const entrada = chamadas.find(([n]) => n === 'criarRestauradorL2')[1];
    assert.equal(entrada.restauracao.tipo, 'composicao-restauracao');
    assert.deepEqual({ raizAutorizada: entrada.raizAutorizada, destino: entrada.destino, imagens: entrada.imagens, maxBytesPorArquivo: entrada.maxBytesPorArquivo }, { raizAutorizada: dados.raizAutorizada, destino: dados.destino, imagens: dados.imagens, maxBytesPorArquivo: dados.maxBytesPorArquivo });
    assert.equal(entrada.relogio, relogio);
    assert.ok(!chamadas.some(([n]) => ['criarBackupDeProducao', 'criarLeitorDePacote', 'criarProducaoL2'].includes(n)));
  });

  test('MR-03 — VERIFICACAO_DESTINO: só coordenação e auditoria; nenhuma composição de produção ou restauração é criada', () => {
    const { fabricas, chamadas } = fabricasFalsas();
    const pecas = montarColaboradoresReais(base({ fabricas }));
    assert.deepEqual(Object.keys(pecas).sort(), ['auditoria', 'coordenacao']);
    assert.deepEqual(chamadas.map(([n]) => n).sort(), ['criarAuditoriaDoExecutor', 'criarCoordenacaoDoExecutor']);
  });

  test('MR-04 — configuração fora da forma é COLABORADORES_REAIS_CONFIGURACAO_INVALIDA, antes de qualquer fábrica', () => {
    const { fabricas, chamadas } = fabricasFalsas();
    const b = (extra) => base({ fabricas, ...extra });
    const mesma = sessao('unica');
    const ruins = [
      undefined, null, [], 'x', b({ extra: 1 }), b({ acao: 'FORMATAR' }), b({ acao: 7 }),
      b({ acao: 'BACKUP' }), b({ acao: 'BACKUP', backup: { composicao: composicaoDeBackup() }, restauracao: restauracao() }), b({ acao: 'RESTAURACAO' }), b({ acao: 'RESTAURACAO', restauracao: restauracao(), backup: { composicao: composicaoDeBackup() } }),
      b({ backup: { composicao: composicaoDeBackup() } }), b({ restauracao: restauracao() }),
      b({ executorDeCoordenacao: {} }), b({ executorDeAuditoria: null }), b({ executorDeCoordenacao: mesma, executorDeAuditoria: mesma }),
      b({ registrarEventoSistema: 'x' }), b({ relogio: 'x' }),
      b({ fabricas: { criarDesconhecida: () => {} } }), b({ fabricas: { criarLeitorDePacote: 'x' } }), b({ fabricas: [] }),
      b({ acao: 'BACKUP', backup: { composicao: composicaoDeBackup(), extra: 1 } }), b({ acao: 'BACKUP', backup: {} }), b({ acao: 'BACKUP', backup: { composicao: [] } }),
      b({ acao: 'BACKUP', backup: { composicao: { armazenamento: {}, chaves: { fonteDeChaves: FONTE } } } }),
      b({ acao: 'BACKUP', backup: { composicao: { armazenamento: { publicados: '/srv/p' }, chaves: {} } } }),
      b({ acao: 'RESTAURACAO', restauracao: (({ destino, ...resto }) => resto)(restauracao()) }), b({ acao: 'RESTAURACAO', restauracao: restauracao({ extra: 1 }) }), b({ acao: 'RESTAURACAO', restauracao: restauracao({ composicao: [] }) }),
    ];
    for (const ruim of ruins) assert.equal(codigo(() => montarColaboradoresReais(ruim)), 'COLABORADORES_REAIS_CONFIGURACAO_INVALIDA', JSON.stringify(ruim, (k, v) => (typeof v === 'function' ? '[fn]' : v)));
    assert.deepEqual(chamadas, []);
  });

  test('MR-05 — fábrica que lança vira COLABORADORES_REAIS_MONTAGEM_FALHOU, sem repassar mensagem nem causa', () => {
    const casos = [
      ['criarCoordenacaoDoExecutor', base()], ['criarAuditoriaDoExecutor', base()],
      ['criarBackupDeProducao', base({ acao: 'BACKUP', backup: { composicao: composicaoDeBackup() } })], ['criarLeitorDePacote', base({ acao: 'BACKUP', backup: { composicao: composicaoDeBackup() } })], ['criarProducaoL2', base({ acao: 'BACKUP', backup: { composicao: composicaoDeBackup() } })],
      ['criarRestauracaoDeProducao', base({ acao: 'RESTAURACAO', restauracao: restauracao() })], ['criarRestauradorL2', base({ acao: 'RESTAURACAO', restauracao: restauracao() })],
    ];
    for (const [nome, opcoes] of casos) {
      const { fabricas } = fabricasFalsas();
      fabricas[nome] = () => { throw new Error('SEGREDO-NA-FABRICA'); };
      let erro;
      try { montarColaboradoresReais({ ...opcoes, fabricas }); } catch (e) { erro = e; }
      assert.ok(erro, nome);
      assert.equal(erro.code, 'COLABORADORES_REAIS_MONTAGEM_FALHOU', nome);
      assert.ok(!`${erro.message} ${JSON.stringify(erro)}`.includes('SEGREDO'), nome);
    }
  });

  test('MR-06 — as fábricas reais de coordenação e auditoria aceitam o que o montador entrega; evidência inválida é recusada com código fixo, válida é gravada', async () => {
    const eventos = [];
    const pecas = montarColaboradoresReais(base({ registrarEventoSistema: async (executor, evento) => { eventos.push([executor.nome, evento]); return { id: '9' }; } }));
    assert.equal(typeof pecas.coordenacao.adquirir, 'function');
    assert.deepEqual({ ...await pecas.auditoria.registrar({ linha: 'qualquer texto\n' }) }, { gravado: false, codigo: 'AUDITORIA_EVIDENCIA_INVALIDA' });
    const ev = Ev.criarEvidencia({ modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio, operacaoId: 'a'.repeat(32) });
    const linha = ev.encerrar({ estado: 'BLOQUEADO', codigo: 'OPERACAO_NAO_HABILITADA', falhouEm: 'GATE', bloqueios: ['OPERACAO_NAO_HABILITADA'] }).linha;
    assert.deepEqual({ ...await pecas.auditoria.registrar({ linha }) }, { gravado: true, id: '9' });
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0][0], 'audit', 'a auditoria usa a sessão de auditoria, nunca a da coordenação');
  });

  test('MR-07 — as fábricas reais de leitor e de produção L2 aceitam a raiz e as chaves derivadas (composição falsa, sem conexão)', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-mr07' });
    const composicao = { armazenamento: { imagens: '/srv/i', preparacoes: '/srv/p', dumps: '/srv/d', publicados: x.raiz }, chaves: { fonteDeChaves: x.fonteMac, chaveId: 'mac-hml-v1' } };
    const pecas = montarColaboradoresReais(base({
      acao: 'BACKUP', backup: { composicao },
      fabricas: { criarBackupDeProducao: () => ({ executar: async () => { throw new Error('não deve executar'); } }) },
    }));
    assert.equal(typeof pecas.producao.produzir, 'function');
    const recusa = await pecas.producao.produzir({ operacaoId: 'nao-e-um-id', conjuntoId: 'c' });
    assert.deepEqual({ ...recusa }, { ok: false, codigo: 'PRODUCAO_PEDIDO_INVALIDO' });
  });

  test('MR-08 — não altera o que recebe e devolve peças congeladas', () => {
    const { fabricas } = fabricasFalsas();
    const backup = { composicao: composicaoDeBackup() };
    const antes = JSON.stringify(backup);
    const pecas = montarColaboradoresReais(base({ acao: 'BACKUP', backup, fabricas }));
    assert.equal(JSON.stringify(backup), antes);
    assert.ok(Object.isFrozen(pecas));
  });

  test('MR-09 — invariantes estáticos: nenhum efeito de escrita, remoção, processo, rede ou ambiente, e nenhum código de src ou scripts o importa (só testes)', () => {
    const fonte = fs.readFileSync(path.join(RAIZ, 'src/services/backup-executor-colaboradores-reais.service.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    for (const proibido of [/\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync)\s*\(/,
      /\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/, /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/, /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
      /process\.env/, /node:(?:fs|child_process|net|http|https|dns|tls)/, /\bfetch\(/, /@aws-sdk/, /OPERACAO_HABILITADA\s*=/]) assert.ok(!proibido.test(fonte), String(proibido));
    const arvore = (dir) => fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arvore(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const importadores = arvore('src').concat(arvore('scripts')).filter((a) => a.endsWith('.js') && /backup-executor-colaboradores-reais/.test(fs.readFileSync(path.join(RAIZ, a), 'utf8')));
    assert.deepEqual(importadores, []);
    assert.deepEqual(Object.keys(require('../../src/services/backup-executor-colaboradores-reais.service')), ['montarColaboradoresReais']);
  });
});
