'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED): POLÍTICA DE RETENÇÃO COMPATÍVEL COM BACKUPS e contrato geral do serviço.
 *
 * Módulo previsto: src/services/imagem-armazenamento-limpeza.service.js (ferramenta SEPARADA do verificador, que continua somente leitura; decisão de Ramires de 18/10/2026).
 *
 *   limparOrfaos(pool, opcoes) -> Promise<relatorio>
 *     opcoes: { diretorio, executar = false, retencaoMinutos = 1500, intervaloBackupMinutos = null, janela = null, limite = 50, agora = Date.now,
 *               fs = FS_DE_LIMPEZA, tempoMaximoDaTravaMs = 5000, ganchos = {} }
 *       - `executar` falso (padrão) é SIMULAÇÃO: só leitura. `janela` é null ou { arquivo } (a trava de janela de escrita, src/utils/janela-escrita-imagens.js).
 *       - `ganchos` (só para teste): aposPlanejar(relatorio), aposTravar(candidato), antesDeRemover(candidato), aposRemover(candidato); sem eles nada muda.
 *   validarPolitica({ retencaoMinutos = 1500, intervaloBackupMinutos = null, executar = false }) -> string[] de IMPEDIMENTOS (vazio = política aceita), em ordem fixa
 *   RETENCAO_MINIMA_MINUTOS = 1440 (24 h, decisão D-C3), RETENCAO_PADRAO_MINUTOS = 1500 (o padrão do verificador, 1440, é selado e continua diferente), RETENCAO_MAXIMA_MINUTOS = 525600,
 *   MARGEM_SOBRE_O_INTERVALO_MINUTOS = 60, INTERVALO_BACKUP_MAXIMO_MINUTOS = 525540 (= máxima − margem),
 *   LIMITE_PADRAO = 50, LIMITE_MAXIMO = 1000, IMPEDIMENTOS, MOTIVOS, FS_DE_LIMPEZA (fachada padrão: lstat, readdir, realpath, open, unlink, rmdir e constants, nada mais)
 *
 *   relatorio = { versao: 1, geradoEm, modo: 'SIMULACAO' | 'EXECUCAO', retencaoMinutos, intervaloBackupMinutos, limite, veredito (do verificador, ou null se nada foi lido),
 *     alertas: string[] (códigos de alerta do verificador, por exemplo RAIZ_AUSENTE),
 *     impedimentos: string[], executavel: boolean (= sem impedimentos), recusa: null | { codigo, dono?, motivo? } (a operação pedida NÃO foi feita; nada foi lido nem removido),
 *     janela: { configurada, estado: 'NAO_CONFIGURADA' | 'LIVRE' | 'OCUPADA' | 'INVALIDA' | 'LIBERADA', dono: null | { tipo, pid, iniciadoEm } },
 *     candidatos: [{ escopo, empresaId, hash, tipo, arquivos, bytes, idadeMinutos }], retidos: [...], foraDoEscopo: [...],
 *     removidos: [{ empresaId, hash, tipo, arquivos: [{ nome, bytes, sha256 }], pastaRemovida }], ignorados: [{ empresaId, hash, tipo, motivo }],
 *     falhas: [{ empresaId, hash, tipo, codigo: 'FALHA_AO_REMOVER', codigoSistema }], restantes,
 *     resumo: { candidatos, retidos, foraDoEscopo, removidos, ignorados, falhas, restantes, bytesLiberados } }
 *
 * POLÍTICA (Documento 65, seção 7.2; decisão A de 19/10/2026): "a retenção precisa ser maior que o intervalo entre backups", com margem FIXA de 60 minutos: retenção >= intervalo + 60
 * (o intervalo é o pior caso entre duas capturas concluídas; para 1.440 a retenção mínima é 1.500). O impedimento RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP (nome mantido) vale para
 * retenção < intervalo + margem. A idade de um órfão é a do ARQUIVO mais novo do conjunto (o mesmo critério do verificador); com idade >= retenção >= intervalo + margem, todo arquivo
 * removido já existia há mais de um intervalo de backup. A retenção nunca é menor que 24 h. Para EXECUTAR é obrigatório informar o intervalo entre backups (sem ele não se prova a
 * compatibilidade). A recusa por política não lê banco nem disco.
 *
 * PRECISÕES do contrato (apontadas na revisão independente da fase RED; os outros arquivos desta fase as pressupõem):
 *   - `limparOrfaos` é assíncrona; opção inválida é TypeError (rejeição da promessa).
 *   - `impedimentos` do relatório = o que impediria EXECUTAR com estes parâmetros: a política é avaliada como `validarPolitica({ ..., executar: true })` mesmo na simulação (por isso a
 *     simulação sem intervalo lista INTERVALO_DE_BACKUP_NAO_INFORMADO), somada à janela (NAO_CONFIGURADA, INVALIDA ou OCUPADA) e ao armazenamento (NAO_CONFIAVEL), nesta ordem.
 *     `validarPolitica(..., executar: false)` avalia só o que a simulação EXIGE: o piso da retenção e, se o intervalo foi informado, a relação retenção × intervalo.
 *     Na simulação SÓ o piso da retenção RECUSA (nada é lido); os demais impedimentos são informativos (recusa nula).
 *   - "Armazenamento não confiável" = veredito RECUPERAVEL ou INVESTIGAR do verificador, ou qualquer alerta (inclui banco sem registro algum e raiz ausente ou inválida).
 *   - Candidatos, retidos e fora do escopo são listados também quando o armazenamento não é confiável: a simulação só INFORMA.
 *   - A unidade de trabalho é um candidato (um achado do verificador); `limite` conta os candidatos processados (removidos, ignorados ou com falha).
 *   - Dentro de um candidato os arquivos saem em ORDEM ALFABÉTICA do nome e o PRIMEIRO erro de remoção interrompe aquele candidato (falhas); o que já saiu não volta.
 *   - Depois da remoção, a pasta da imagem que ficou VAZIA e SEM registro é removida na hora (rmdir), qualquer que seja a idade da própria pasta; pasta com registro, não vazia ou
 *     da empresa nunca é removida (ENOTEMPTY no rmdir não é falha: pastaRemovida falso).
 *   - A espera pela trava da biblioteca é um `pg_advisory_xact_lock` BLOQUEANTE (a mesma primitiva do envio, para que um serialize o outro), limitado por `tempoMaximoDaTravaMs`
 *     (por exemplo, SET LOCAL lock_timeout); ao estourar (SQLSTATE 55P03) o candidato é ignorado com TRAVA_OCUPADA; qualquer outro erro do banco propaga. A transação de cada
 *     candidato é READ ONLY e READ COMMITTED (REPEATABLE READ não enxergaria o registro confirmado durante a espera).
 *   - A fachada de arquivos entrega arquivos abertos com as operações normais do FileHandle (stat, read, readFile, createReadStream, close).
 *   - O formato do texto do comando está em imagens-limpar-orfaos-cli.test.js.
 */

const { AGORA, DIA } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

const S = () => exigirModulo('src/services/imagem-armazenamento-limpeza.service');
const mundo = (opcoes) => a.criarMundo(novaRaiz, opcoes);
const rodar = (m, extra = {}) => S().limparOrfaos(m.banco, { diretorio: m.raiz, fs: m.fs, agora: () => AGORA, ...extra });
const comJanela = (m) => ({ janela: { arquivo: m.arquivoDaJanela } });

describe('[POL] vocabulário e constantes (congelados)', () => {
  test('POL-01 — as constantes, os impedimentos, os motivos e a fachada padrão são exatamente os combinados e estão congelados', () => {
    const s = S();
    assert.equal(s.RETENCAO_MINIMA_MINUTOS, 1440);
    assert.equal(s.RETENCAO_PADRAO_MINUTOS, 1500, 'o padrão da limpeza: o piso de 24 h mais a margem de 60 min sobre um backup diário');
    assert.equal(verificador.IDADE_MINIMA_ORFAO_PADRAO_MINUTOS, 1440, 'o padrão do verificador (selado) continua 1.440');
    assert.equal(s.RETENCAO_MAXIMA_MINUTOS, verificador.IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS);
    assert.equal(s.RETENCAO_MAXIMA_MINUTOS, 525600);
    assert.equal(s.MARGEM_SOBRE_O_INTERVALO_MINUTOS, 60);
    assert.equal(s.INTERVALO_BACKUP_MAXIMO_MINUTOS, 525540);
    assert.equal(s.INTERVALO_BACKUP_MAXIMO_MINUTOS, s.RETENCAO_MAXIMA_MINUTOS - s.MARGEM_SOBRE_O_INTERVALO_MINUTOS, 'todo intervalo válido tem uma retenção válida');
    assert.equal(s.LIMITE_PADRAO, 50);
    assert.equal(s.LIMITE_MAXIMO, 1000);
    assert.deepEqual(s.IMPEDIMENTOS, {
      RETENCAO_ABAIXO_DO_MINIMO: 'RETENCAO_ABAIXO_DO_MINIMO',
      RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP: 'RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP',
      INTERVALO_DE_BACKUP_NAO_INFORMADO: 'INTERVALO_DE_BACKUP_NAO_INFORMADO',
      JANELA_NAO_CONFIGURADA: 'JANELA_NAO_CONFIGURADA',
      JANELA_INVALIDA: 'JANELA_INVALIDA',
      JANELA_OCUPADA: 'JANELA_OCUPADA',
      ARMAZENAMENTO_NAO_CONFIAVEL: 'ARMAZENAMENTO_NAO_CONFIAVEL',
    });
    assert.deepEqual(s.MOTIVOS, {
      REGISTRO_APARECEU: 'REGISTRO_APARECEU',
      MAIS_NOVO_QUE_A_RETENCAO: 'MAIS_NOVO_QUE_A_RETENCAO',
      ENTRADA_ESTRANHA: 'ENTRADA_ESTRANHA',
      TRAVA_OCUPADA: 'TRAVA_OCUPADA',
      JA_REMOVIDO: 'JA_REMOVIDO',
    });
    assert.deepEqual(Object.keys(s.FS_DE_LIMPEZA).sort(), ['constants', 'lstat', 'open', 'readdir', 'realpath', 'rmdir', 'unlink']);
    for (const objeto of [s.IMPEDIMENTOS, s.MOTIVOS, s.FS_DE_LIMPEZA]) assert.equal(Object.isFrozen(objeto), true);
    assert.equal(typeof s.limparOrfaos, 'function');
    assert.equal(typeof s.validarPolitica, 'function');
  });
});

describe('[POL] validarPolitica: retenção × intervalo entre backups', () => {
  test('POL-02 — tabela da política: a retenção tem de ser pelo menos o intervalo + 60 min de margem (1.499 contra 1.440 não basta; 1.500 basta), nunca menor que 24 h, e executar exige o intervalo', () => {
    const { validarPolitica } = S();
    const casos = [
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: null, executar: false }, []],
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: null, executar: true }, ['INTERVALO_DE_BACKUP_NAO_INFORMADO']],
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: 1440, executar: true }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1441, intervaloBackupMinutos: 1440, executar: true }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1499, intervaloBackupMinutos: 1440, executar: true }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1500, intervaloBackupMinutos: 1440, executar: true }, []],
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: 1381, executar: true }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: 1380, executar: true }, []],
      [{ retencaoMinutos: 4320, intervaloBackupMinutos: 1440, executar: true }, []],
      [{ retencaoMinutos: 1440, intervaloBackupMinutos: 2000, executar: false }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1439, intervaloBackupMinutos: 60, executar: true }, ['RETENCAO_ABAIXO_DO_MINIMO']],
      [{ retencaoMinutos: 1439, intervaloBackupMinutos: 60, executar: false }, ['RETENCAO_ABAIXO_DO_MINIMO']],
      [{ retencaoMinutos: 1000, intervaloBackupMinutos: 2000, executar: true }, ['RETENCAO_ABAIXO_DO_MINIMO', 'RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 1439, intervaloBackupMinutos: null, executar: true }, ['RETENCAO_ABAIXO_DO_MINIMO', 'INTERVALO_DE_BACKUP_NAO_INFORMADO']],
      [{ retencaoMinutos: 525600, intervaloBackupMinutos: 525540, executar: true }, []],
      [{ retencaoMinutos: 525599, intervaloBackupMinutos: 525540, executar: true }, ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP']],
      [{ retencaoMinutos: 0, intervaloBackupMinutos: null, executar: false }, ['RETENCAO_ABAIXO_DO_MINIMO']],
    ];
    for (const [entrada, esperado] of casos) assert.deepEqual(validarPolitica(entrada), esperado, JSON.stringify(entrada));
  });

  test('POL-03 — sem argumentos usa os padrões (retenção de 1.500 min, simulação, intervalo não informado) e aceita', () => {
    assert.deepEqual(S().validarPolitica({}), []);
    assert.deepEqual(S().validarPolitica(), []);
  });

  test('POL-04 — valores que não são inteiros nos limites (ou tipos errados) são erro de programação (TypeError), não "impedimento"', () => {
    const { validarPolitica } = S();
    const ruins = [
      { retencaoMinutos: 1440.5 }, { retencaoMinutos: '1440' }, { retencaoMinutos: Number.NaN }, { retencaoMinutos: Infinity }, { retencaoMinutos: -1 }, { retencaoMinutos: 525601 },
      { intervaloBackupMinutos: 0 }, { intervaloBackupMinutos: -5 }, { intervaloBackupMinutos: 1.5 }, { intervaloBackupMinutos: '60' }, { intervaloBackupMinutos: 525541 }, { intervaloBackupMinutos: 525600 },
      { executar: 'sim' }, { executar: 1 }, { executar: null },
    ];
    for (const entrada of ruins) assert.throws(() => validarPolitica(entrada), TypeError, JSON.stringify(entrada));
  });
});

describe('[POL] a recusa por política não lê banco nem disco e não toca em nada', () => {
  test('POL-05 — retenção abaixo de 24 h é recusada NOS DOIS MODOS: relatório com o impedimento, nada lido, nada criado (nem a trava da janela)', async () => {
    for (const executar of [false, true]) {
      const m = mundo({ orfaos: [{ semente: 'p5', idadeMin: 3 * DIA }] });
      const antes = m.retrato();
      const r = await rodar(m, { executar, retencaoMinutos: 1439, intervaloBackupMinutos: 60, ...comJanela(m) });
      assert.equal(r.modo, executar ? 'EXECUCAO' : 'SIMULACAO');
      assert.deepEqual(r.impedimentos, ['RETENCAO_ABAIXO_DO_MINIMO']);
      assert.equal(r.executavel, false);
      assert.equal(r.recusa?.codigo, 'RETENCAO_ABAIXO_DO_MINIMO');
      assert.deepEqual([r.candidatos, r.retidos, r.removidos, r.ignorados, r.falhas], [[], [], [], [], []]);
      assert.equal(r.veredito, null, 'nada foi lido, então não há veredito');
      assert.equal(m.banco.contadores.conexoes, 0, 'nenhuma conexão com o banco');
      assert.deepEqual(m.chamadas, [], 'nenhuma leitura do disco');
      assert.deepEqual(m.retrato(), antes);
      assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    }
  });

  test('POL-06 — EXECUTAR com retenção que não supera o intervalo (igual ou menor) é recusado: nada lido, órfão intacto, nenhuma trava criada', async () => {
    for (const [retencaoMinutos, intervaloBackupMinutos] of [[1440, 1440], [2000, 3000], [1441, 1441]]) {
      const m = mundo({ orfaos: [{ semente: `p6-${retencaoMinutos}-${intervaloBackupMinutos}`, idadeMin: 30 * DIA }] });
      const antes = m.retrato();
      const r = await rodar(m, { executar: true, retencaoMinutos, intervaloBackupMinutos, ...comJanela(m) });
      assert.equal(r.recusa?.codigo, 'RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP', `${retencaoMinutos} × ${intervaloBackupMinutos}`);
      assert.equal(r.executavel, false);
      assert.equal(r.removidos.length, 0);
      assert.equal(m.banco.contadores.conexoes, 0);
      assert.deepEqual(m.chamadas, []);
      assert.deepEqual(m.retrato(), antes);
      assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    }
  });

  test('POL-07 — EXECUTAR sem informar o intervalo entre backups é recusado (não se prova a compatibilidade): INTERVALO_DE_BACKUP_NAO_INFORMADO, nada lido', async () => {
    const m = mundo({ orfaos: [{ semente: 'p7', idadeMin: 30 * DIA }] });
    const antes = m.retrato();
    const r = await rodar(m, { executar: true, ...comJanela(m) });
    assert.equal(r.recusa?.codigo, 'INTERVALO_DE_BACKUP_NAO_INFORMADO');
    assert.equal(r.intervaloBackupMinutos, null);
    assert.equal(m.banco.contadores.conexoes, 0);
    assert.deepEqual(m.chamadas, []);
    assert.deepEqual(m.retrato(), antes);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
  });
});

describe('[POL] na simulação os impedimentos são informativos: o plano é feito e o relatório diz o que impediria a execução', () => {
  test('POL-08 — simulação sem intervalo e sem janela: lista os candidatos, NÃO recusa, e aponta os dois impedimentos (política e janela) em ordem fixa', async () => {
    const m = mundo({ orfaos: [{ semente: 'p8', idadeMin: 3 * DIA }] });
    const r = await rodar(m, { executar: false });
    assert.equal(r.modo, 'SIMULACAO');
    assert.equal(r.recusa, null);
    assert.deepEqual(r.impedimentos, ['INTERVALO_DE_BACKUP_NAO_INFORMADO', 'JANELA_NAO_CONFIGURADA']);
    assert.equal(r.executavel, false);
    assert.equal(r.candidatos.length, 1);
    assert.equal(r.intervaloBackupMinutos, null);
    assert.deepEqual(r.janela, { configurada: false, estado: 'NAO_CONFIGURADA', dono: null });
  });

  test('POL-09 — simulação com tudo certo (intervalo informado, janela livre, armazenamento sem pendência grave): executavel verdadeiro, sem impedimentos e sem criar a trava', async () => {
    const m = mundo({ orfaos: [{ semente: 'p9', idadeMin: 3 * DIA }] });
    const r = await rodar(m, { executar: false, intervaloBackupMinutos: 60, ...comJanela(m) });
    assert.deepEqual(r.impedimentos, []);
    assert.equal(r.executavel, true);
    assert.equal(r.recusa, null);
    assert.deepEqual(r.janela, { configurada: true, estado: 'LIVRE', dono: null });
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'simular nunca cria a trava');
  });

  test('POL-10 — o relatório registra a política usada, o modo, a versão e o instante (rastreabilidade)', async () => {
    const m = mundo({ orfaos: [{ semente: 'p10', idadeMin: 10 * DIA }] });
    const r = await rodar(m, { retencaoMinutos: 4320, intervaloBackupMinutos: 1440, limite: 7, ...comJanela(m) });
    assert.equal(r.versao, 1);
    assert.equal(r.geradoEm, new Date(AGORA).toISOString());
    assert.equal(r.modo, 'SIMULACAO');
    assert.deepEqual([r.retencaoMinutos, r.intervaloBackupMinutos, r.limite], [4320, 1440, 7]);
    const padrao = await rodar(mundo({ orfaos: [] }));
    assert.deepEqual([padrao.retencaoMinutos, padrao.limite], [1500, 50]);
  });

  test('POL-16 — na simulação, os impedimentos de POLÍTICA do relatório são exatamente os de `validarPolitica` avaliada para EXECUTAR com os mesmos parâmetros (o relatório responde "o que impediria executar?")', async () => {
    const { validarPolitica } = S();
    for (const [retencaoMinutos, intervaloBackupMinutos] of [[1440, null], [1440, 1440], [1441, 1440], [4320, 5000], [2000, 60]]) {
      const m = mundo({ orfaos: [{ semente: `p16-${retencaoMinutos}-${intervaloBackupMinutos}`, idadeMin: 30 * DIA }] });
      const r = await rodar(m, { retencaoMinutos, intervaloBackupMinutos, ...comJanela(m) });
      const esperados = validarPolitica({ retencaoMinutos, intervaloBackupMinutos, executar: true });
      assert.deepEqual(r.impedimentos, esperados, `${retencaoMinutos} × ${intervaloBackupMinutos}`);
      assert.equal(r.executavel, esperados.length === 0);
      assert.equal(r.recusa, null, 'simular não é recusado por impedimentos de política (só pelo piso da retenção)');
    }
  });
});

describe('[POL] a retenção decide o que é candidato (idade do arquivo mais novo do conjunto)', () => {
  test('POL-11 — com a retenção PADRÃO (1.500 min): o conjunto com 1499 min fica retido, o de 1500 min é candidato (a igualdade já vale)', async () => {
    const m = mundo({ orfaos: [{ semente: 'p11-novo', idadeMin: 1499 }, { semente: 'p11-limite', idadeMin: 1500 }] });
    const r = await rodar(m);
    assert.equal(r.retencaoMinutos, 1500);
    assert.deepEqual(r.candidatos.map((c) => c.hash), [m.orfaos[1].hash]);
    assert.deepEqual(r.retidos.map((c) => c.hash), [m.orfaos[0].hash]);
    assert.equal(r.retidos[0].idadeMinutos, 1499);
    assert.equal(r.candidatos[0].idadeMinutos, 1500);
  });

  test('POL-12 — com retenção maior (3 dias): 2 dias e 4319 min ficam retidos; 4320 min e 5 dias são candidatos — e o relatório separa candidatos de retidos', async () => {
    const m = mundo({ orfaos: [
      { semente: 'p12-a', idadeMin: 2 * DIA }, { semente: 'p12-b', idadeMin: 4319 }, { semente: 'p12-c', idadeMin: 4320 }, { semente: 'p12-d', idadeMin: 5 * DIA },
    ] });
    const r = await rodar(m, { retencaoMinutos: 4320, intervaloBackupMinutos: 1440 });
    assert.deepEqual(r.candidatos.map((c) => c.hash).sort(), [m.orfaos[2].hash, m.orfaos[3].hash].sort());
    assert.deepEqual(r.retidos.map((c) => c.hash).sort(), [m.orfaos[0].hash, m.orfaos[1].hash].sort());
    assert.deepEqual([r.resumo.candidatos, r.resumo.retidos], [2, 2]);
  });

  test('POL-13 — a execução respeita a retenção: o retido NÃO é removido mesmo sendo mais velho que 24 h', async () => {
    const m = mundo({ orfaos: [{ semente: 'p13-retido', idadeMin: 2 * DIA }, { semente: 'p13-velho', idadeMin: 5 * DIA }] });
    const r = await rodar(m, { executar: true, retencaoMinutos: 4320, intervaloBackupMinutos: 1440, ...comJanela(m) });
    assert.deepEqual(r.removidos.map((x) => x.hash), [m.orfaos[1].hash]);
    assert.equal(m.orfaos[0].existe(), true, 'dois dias de idade com retenção de três: fica');
    assert.equal(m.orfaos[1].existe(), false);
  });
});

describe('[POL] opções inválidas são erro de programação (TypeError) e nada é lido', () => {
  test('POL-14 — pool, diretório, modo, retenção, intervalo, limite, janela, fachada, tempo e ganchos inválidos: TypeError, sem tocar no banco nem no disco', async () => {
    const { limparOrfaos } = S();
    const m = mundo({ orfaos: [{ semente: 'p14', idadeMin: 3 * DIA }] });
    const base = { diretorio: m.raiz, fs: m.fs, agora: () => AGORA };
    const ruins = [
      ['diretório relativo', m.banco, { ...base, diretorio: 'relativo/imagens' }],
      ['diretório vazio', m.banco, { ...base, diretorio: '' }],
      ['diretório com NUL', m.banco, { ...base, diretorio: `${m.raiz}\0x` }],
      ['pool sem connect', {}, base],
      ['pool nulo', null, base],
      ['opções nulas', m.banco, null],
      ['executar não booleano', m.banco, { ...base, executar: 'sim' }],
      ['retenção em texto', m.banco, { ...base, retencaoMinutos: '1440' }],
      ['retenção acima do máximo', m.banco, { ...base, retencaoMinutos: 525601 }],
      ['intervalo zero', m.banco, { ...base, intervaloBackupMinutos: 0 }],
      ['intervalo em texto', m.banco, { ...base, intervaloBackupMinutos: '60' }],
      ['limite zero', m.banco, { ...base, limite: 0 }],
      ['limite acima do máximo', m.banco, { ...base, limite: 1001 }],
      ['limite fracionário', m.banco, { ...base, limite: 2.5 }],
      ['janela em texto', m.banco, { ...base, janela: '/tmp/x.lock' }],
      ['janela sem arquivo em texto', m.banco, { ...base, janela: { arquivo: 5 } }],
      ['relógio inválido', m.banco, { ...base, agora: 'agora' }],
      ['tempo da trava zero', m.banco, { ...base, tempoMaximoDaTravaMs: 0 }],
      ['tempo da trava acima de 60 s', m.banco, { ...base, tempoMaximoDaTravaMs: 60001 }],
      ['ganchos não objeto', m.banco, { ...base, ganchos: () => {} }],
      ['gancho que não é função', m.banco, { ...base, ganchos: { antesDeRemover: 'sim' } }],
    ];
    for (const [rotulo, pool, opcoes] of ruins) await assert.rejects(async () => limparOrfaos(pool, opcoes), TypeError, rotulo);
    assert.equal(m.banco.contadores.conexoes, 0);
    assert.deepEqual(m.chamadas, []);
  });

  test('POL-15 — a fachada de arquivos precisa ter unlink e rmdir só para EXECUTAR; para simular basta a de leitura do verificador', async () => {
    const { limparOrfaos } = S();
    const m = mundo({ orfaos: [{ semente: 'p15', idadeMin: 3 * DIA }] });
    const soLeitura = a.h.fachadaDeLeitura(m.raiz).fs;
    const simulacao = await limparOrfaos(m.banco, { diretorio: m.raiz, fs: soLeitura, agora: () => AGORA });
    assert.equal(simulacao.candidatos.length, 1);
    await assert.rejects(async () => limparOrfaos(m.banco, {
      diretorio: m.raiz, fs: soLeitura, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m),
    }), TypeError);
    assert.equal(m.orfaos[0].existe(), true);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a recusa por fachada inválida vem antes de qualquer trava');
  });
});
