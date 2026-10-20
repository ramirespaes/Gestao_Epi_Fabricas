'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/pacote-padrao-ficticio');
const { poolProibido, armazenamentoProibido } = require('../helpers/instrumentacao-importacao');
const { linhaDoTempo } = require('../helpers/linha-do-tempo-importacao');
const { ZIP_INTEGRO } = require('../helpers/cenarios-importacao-padrao');

/**
 * Importação da biblioteca padrão (Biblioteca de Imagens, Unidade 5A-2): GUARDA OBRIGATÓRIA DO DESTINO, contratos SEM banco real.
 *
 * Contrato novo (os de integridade e idempotência já aprovados não mudam):
 *   - CLI: `--banco-autorizado <nome>` e `--banco-oid <oid>`, obrigatórios com `--executar`, aceitos com `--dry-run` (e então conferidos), nunca com `--verificar`
 *     (que não acessa o PostgreSQL). interpretarArgumentos devolve `destino: { banco, oid }` SÓ quando algum dos dois foi informado (sem eles, o formato do resultado
 *     é o de sempre); um só dos dois vira `destino` com o outro nulo, e quem recusa é o serviço, com DESTINO_NAO_AUTORIZADO.
 *   - Serviço: importarPacotePadrao(pool, { ..., destinoAutorizado: { banco, oid } }). Com `executar: true` o destino é OBRIGATÓRIO (ausente, nulo, malformado ou
 *     com campo faltando = DESTINO_NAO_AUTORIZADO, antes de qualquer leitura de arquivo, conexão ou armazenamento); com `executar: false` é opcional e, se vier, é conferido.
 *     `banco` = 1 a 63 caracteres ASCII visíveis; `oid` = decimal canônico (sem zeros à esquerda) de 1 a 4294967295; só essas duas chaves, próprias do objeto.
 *   - A conferência usa a MESMA conexão que vai escrever, dentro da transação, e é a PRIMEIRA instrução depois do BEGIN: antes do ajuste de espera, da trava consultiva,
 *     da leitura do estado, de qualquer chamada ao armazenamento e de qualquer escrita. Lê current_database() e o OID de pg_database e exige igualdade EXATA de nome e de OID.
 *     Divergência: DESTINO_NAO_AUTORIZADO com detalhes [{ campo: 'banco'|'oid', motivo: 'DIFERENTE_DO_AUTORIZADO', esperado, calculado }], ROLLBACK, nada escrito.
 *     Identidade ilegível (nenhuma linha): [{ campo: 'destino', motivo: 'IDENTIDADE_INDISPONIVEL' }]. A mensagem é fixa e nunca leva nome nem OID.
 *   - Relatório: com destino conferido, `destino: { banco, oid }` (o lido da conexão); sem destino, o relatório é o de sempre. A CLI imprime
 *     "Destino conferido pela conexão: banco <nome> (oid <oid>)".
 *   - DESTINO_NAO_AUTORIZADO sai como ARGUMENTOS (2) e a CLI imprime a dica das duas opções. verificarPacotePadrao NÃO aceita destinoAutorizado.
 *   - Em EXECUTAR o diretório de imagens só é criado na primeira chamada ao armazenamento (scripts/imagens-importar-padrao.js exporta criarArmazenamento(modo, ambiente)):
 *     nenhum efeito no disco antes de o destino ser conferido.
 */

const NOME_ZIP = 'Pacote_Ficticio_30_EPIs.zip';
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'imagens-importar-padrao.js');
const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');
const IDENTIDADE = Object.freeze({ banco: 'banco_de_teste_ficticio', oid: '4242424' });
const AUTORIZADO = Object.freeze({ banco: IDENTIDADE.banco, oid: IDENTIDADE.oid });
const SHA = 'a'.repeat(64);
const INEXISTENTE = '/caminho-que-nao-existe-gepi/pacote-ficticio.zip';

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

function caso(zip = ZIP_INTEGRO) {
  const dir = criarRaizTemporaria();
  raizes.push(dir);
  return { dir, zip: h.gravarArquivo(dir, NOME_ZIP, zip), sha: h.sha256(zip) };
}

/** Banco FALSO: responde à consulta de identidade com `identidade` (null = nenhuma linha) e aceita o resto como vazio; o INSERT de imagem devolve um id. */
function bancoFalso(identidade) {
  let ids = 0;
  const cliente = {
    async query(entrada) {
      const texto = typeof entrada === 'string' ? entrada : entrada.text;
      if (/current_database\(\)/i.test(texto) && /pg_database/i.test(texto)) return { rows: identidade === null ? [] : [identidade], rowCount: identidade === null ? 0 : 1 };
      if (/^\s*INSERT INTO imagens_padrao\b/i.test(texto)) { ids += 1; return { rows: [{ id: String(ids) }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { async connect() { return cliente; } };
}

/** Armazenamento FALSO vazio: nada existe, tudo se grava. */
function armazenamentoFalso() {
  return Object.freeze({
    existe: async () => false,
    abrir: async () => { throw Object.assign(new Error('ausente'), { codigo: 'ARQUIVO_AUSENTE' }); },
    gravar: async () => ({ reaproveitado: false }),
  });
}

const chamar = (pool, armazenamento, extra = {}, c = null) => SERVICO().importarPacotePadrao(pool, {
  pacote: c ? c.zip : INEXISTENTE, pacoteSha256Esperado: c ? c.sha : SHA, armazenamento, mapeamento: null, executar: true, ...extra,
});

async function recusa(promessa, codigo) {
  let erro = null;
  try { await promessa; } catch (e) { erro = e; }
  assert.notEqual(erro, null, 'a operação deveria ser recusada');
  assert.equal(erro.codigo, codigo, `${erro.codigo}: ${erro.message}`);
  return erro;
}

const nadaTocado = (banco, disco) => assert.deepEqual([banco.registros, disco.registros], [[], []], 'nem o banco nem o armazenamento foram tocados');
/** Forma legível da linha do tempo: a consulta de identidade vira IDENTIDADE e cada instrução leva o número da conexão. */
const forma = (tempo) => tempo.eventos.map((e) => (tempo.ehIdentidade(e) ? `${e.conexao}:IDENTIDADE` : (e.tipo === 'SQL' ? `${e.conexao}:${e.texto}` : `${e.tipo}${e.conexao ? `:${e.conexao}` : ''}`)));

// ------------------------------------------------------------------------------------------------------------------------ DST-CTRL
describe('[DST-CTRL] controles da instrumentação (passam antes da guarda existir)', () => {
  test('DST-CTRL-01 — a linha do tempo registra conexão, SQL de cada conexão, liberação e chamadas ao armazenamento na ordem em que acontecem, e reconhece a consulta de identidade e os efeitos', async () => {
    const tempo = linhaDoTempo();
    const pool = tempo.pool(bancoFalso(IDENTIDADE));
    const armazenamento = tempo.armazenamento(armazenamentoFalso());
    const cliente = await pool.connect();
    await cliente.query('BEGIN');
    await cliente.query('SELECT current_database() AS banco, d.oid::text AS oid FROM pg_database d WHERE d.datname = current_database()');
    await cliente.query("SET LOCAL lock_timeout = '120s'");
    await armazenamento.existe('x');
    await cliente.query({ text: 'ROLLBACK' });
    cliente.release();
    const outro = await pool.connect();
    await outro.query('BEGIN');
    outro.release(true);
    assert.deepEqual(forma(tempo), ['CONNECT:1', '1:BEGIN', '1:IDENTIDADE', "1:SET LOCAL lock_timeout = '120s'", 'ARM', '1:ROLLBACK', 'LIBERA:1', 'CONNECT:2', '2:BEGIN', 'LIBERA:2']);
    assert.equal(tempo.eventos.find((e) => e.tipo === 'LIBERA' && e.conexao === 2).texto, 'true');
    assert.deepEqual(tempo.eventos.filter(tempo.ehEfeito).map((e) => e.texto), ["SET LOCAL lock_timeout = '120s'", 'existe']);
    assert.equal(tempo.eventos.filter(tempo.ehIdentidade).length, 1);
  });

  test('DST-CTRL-02 — a simulação SEM destino continua como antes: relatório de simulação sem a chave destino, nenhuma consulta de identidade, nada escrito', async () => {
    const c = caso();
    const tempo = linhaDoTempo();
    const relatorio = await chamar(tempo.pool(bancoFalso(IDENTIDADE)), tempo.armazenamento(armazenamentoFalso()), { executar: false }, c);
    assert.equal(relatorio.modo, 'SIMULACAO');
    assert.equal(Object.hasOwn(relatorio, 'destino'), false);
    assert.equal(tempo.eventos.filter(tempo.ehIdentidade).length, 0);
    assert.deepEqual(tempo.sql().map((e) => e.texto).filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t)), []);
  });
});

// -------------------------------------------------------------------------------------------------------------------------- DST-ARG
describe('[DST-ARG] argumentos da CLI: --banco-autorizado e --banco-oid', () => {
  const ZIP = '/tmp/gepi-pacote-qualquer.zip';
  const MAPA = '/tmp/gepi-mapeamento-qualquer.csv';
  const base = ['--pacote', ZIP, '--sha256', SHA];
  const destino = ['--banco-autorizado', 'meu_banco_ficticio', '--banco-oid', '16384'];
  const esperado = { banco: 'meu_banco_ficticio', oid: '16384' };

  test('DST-ARG-01 — com os dois argumentos: o resultado leva destino { banco, oid } em EXECUTAR, no --dry-run e no modo padrão, em qualquer ordem; sem eles, o resultado não tem a chave destino', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos([...base, ...destino, '--executar']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'EXECUTAR', destino: esperado });
    assert.deepEqual(interpretarArgumentos([...base, ...destino, '--dry-run']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'SIMULAR', destino: esperado });
    assert.deepEqual(interpretarArgumentos([...base, ...destino]), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'SIMULAR', destino: esperado });
    assert.deepEqual(
      interpretarArgumentos(['--banco-oid', '16384', '--executar', '--mapeamento', MAPA, '--banco-autorizado', 'meu_banco_ficticio', '--sha256', SHA, '--pacote', ZIP]),
      { ok: true, pacote: ZIP, sha256: SHA, mapeamento: MAPA, modo: 'EXECUTAR', destino: esperado },
    );
    for (const modo of ['--executar', '--dry-run', '--verificar']) {
      const r = interpretarArgumentos([...base, modo]);
      assert.equal(r.ok, true);
      assert.equal(Object.hasOwn(r, 'destino'), false, `${modo}: sem os argumentos não há destino`);
    }
  });

  test('DST-ARG-02 — um só dos dois argumentos passa adiante com o outro nulo (quem recusa é o serviço, com DESTINO_NAO_AUTORIZADO); valores malformados também passam adiante', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos([...base, '--executar', '--banco-autorizado', 'meu_banco_ficticio']).destino, { banco: 'meu_banco_ficticio', oid: null });
    assert.deepEqual(interpretarArgumentos([...base, '--executar', '--banco-oid', '16384']).destino, { banco: null, oid: '16384' });
    assert.deepEqual(interpretarArgumentos([...base, '--executar', '--banco-autorizado', 'com espaço', '--banco-oid', '0x10']).destino, { banco: 'com espaço', oid: '0x10' });
  });

  test('DST-ARG-03 — recusados sem ecoar o valor: argumento sem valor, valor que parece opção, repetição, e qualquer um dos dois com --verificar (que nunca acessa o PostgreSQL)', () => {
    const { interpretarArgumentos } = CLI();
    assert.equal(interpretarArgumentos([...base, ...destino, '--executar']).ok, true, 'controle: os mesmos argumentos, em EXECUTAR, são aceitos');
    const invalidos = [
      [...base, '--executar', '--banco-autorizado'], [...base, '--executar', '--banco-oid'], [...base, '--executar', '--banco-autorizado', '--banco-oid', '16384'],
      [...base, '--executar', '--banco-autorizado', 'a_segredo-banco', '--banco-autorizado', 'b_segredo-banco', '--banco-oid', '16384'],
      [...base, '--executar', '--banco-autorizado', 'meu_banco_ficticio', '--banco-oid', '16384', '--banco-oid', '16385'],
      [...base, ...destino, '--verificar'], [...base, '--verificar', '--banco-autorizado', 'segredo-banco-ficticio'], [...base, '--verificar', '--banco-oid', '987654321'],
    ];
    for (const argumentos of invalidos) {
      const r = interpretarArgumentos(argumentos);
      assert.equal(r.ok, false, JSON.stringify(argumentos));
      assert.equal(typeof r.erro, 'string');
      for (const eco of ['segredo-banco', 'meu_banco_ficticio', '16384', '16385', '987654321', SHA, ZIP]) assert.equal(r.erro.includes(eco), false, `${JSON.stringify(argumentos)}: o erro ecoa "${eco}"`);
    }
  });

  test('DST-ARG-04 — o texto de uso cita os dois argumentos e diz que são obrigatórios com --executar, sem induzir a passar segredo', () => {
    const texto = CLI().uso();
    for (const flag of ['--banco-autorizado', '--banco-oid']) assert.ok(texto.includes(flag), flag);
    assert.match(texto, /obrigat[óo]ri/i);
    assert.doesNotMatch(texto, /senha|password|segredo/i);
  });
});

// -------------------------------------------------------------------------------------------------------------------------- DST-SRV
describe('[DST-SRV] serviço: destino obrigatório para gravar, conferido na conexão que grava e antes de qualquer efeito', () => {
  test('DST-SRV-01 — gravar (executar:true) sem destino — ausente, undefined ou null — é DESTINO_NAO_AUTORIZADO antes de ler o ZIP, de abrir conexão ou de tocar o armazenamento', async () => {
    const semDestino = [['ausente', {}], ['undefined', { destinoAutorizado: undefined }], ['null', { destinoAutorizado: null }]];
    for (const [descricao, extra] of semDestino) {
      const banco = poolProibido();
      const disco = armazenamentoProibido();
      const erro = await recusa(chamar(banco.pool, disco.armazenamento, extra), 'DESTINO_NAO_AUTORIZADO');
      nadaTocado(banco, disco);
      assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.motivo]), [['destino', 'AUSENTE']], descricao);
    }
    const controle = await recusa(chamar(poolProibido().pool, armazenamentoProibido().armazenamento, { destinoAutorizado: AUTORIZADO }), 'PACOTE_INDISPONIVEL');
    assert.equal(controle.codigo, 'PACOTE_INDISPONIVEL', 'controle: com destino válido o fluxo segue para a leitura do ZIP (que aqui não existe)');
  });

  const MALFORMADOS = [
    ['texto em vez de objeto', 'banco:4242424'], ['número', 42], ['lista', ['banco', '4242424']], ['objeto vazio', {}],
    ['só o banco', { banco: IDENTIDADE.banco }], ['só o OID', { oid: IDENTIDADE.oid }], ['banco nulo', { banco: null, oid: IDENTIDADE.oid }], ['OID nulo', { banco: IDENTIDADE.banco, oid: null }],
    ['chave a mais', { ...AUTORIZADO, extra: 1 }], ['banco que não é texto', { banco: 5, oid: IDENTIDADE.oid }],
    ['OID numérico (só texto canônico)', { banco: IDENTIDADE.banco, oid: 4242424 }], ['OID bigint', { banco: IDENTIDADE.banco, oid: 4242424n }],
    ['banco vazio', { banco: '', oid: IDENTIDADE.oid }], ['banco com espaço', { banco: 'banco segredo-x', oid: IDENTIDADE.oid }], ['banco com quebra de linha', { banco: 'banco\nsegredo-x', oid: IDENTIDADE.oid }],
    ['banco com byte nulo', { banco: 'banco\0segredo-x', oid: IDENTIDADE.oid }], ['banco com 64 caracteres', { banco: 'b'.repeat(64), oid: IDENTIDADE.oid }], ['banco fora do ASCII', { banco: 'bancoç', oid: IDENTIDADE.oid }],
    ['OID vazio', { banco: IDENTIDADE.banco, oid: '' }], ['OID zero', { banco: IDENTIDADE.banco, oid: '0' }], ['OID com zero à esquerda', { banco: IDENTIDADE.banco, oid: '04242424' }],
    ['OID negativo', { banco: IDENTIDADE.banco, oid: '-4242424' }], ['OID decimal', { banco: IDENTIDADE.banco, oid: '42.5' }], ['OID em notação científica', { banco: IDENTIDADE.banco, oid: '4e6' }],
    ['OID hexadecimal', { banco: IDENTIDADE.banco, oid: '0x10' }], ['OID com espaço', { banco: IDENTIDADE.banco, oid: ' 4242424' }], ['OID acima de 4294967295', { banco: IDENTIDADE.banco, oid: '4294967296' }],
    ['OID com 11 dígitos', { banco: IDENTIDADE.banco, oid: '12345678901' }], ['propriedades herdadas, não próprias', Object.create({ ...AUTORIZADO })],
  ];

  test('DST-SRV-02 — destino malformado, em gravar e em simular, é DESTINO_NAO_AUTORIZADO sem tocar nada e sem ecoar o valor; o limite superior do OID e o nome de 63 caracteres são aceitos', async () => {
    for (const [descricao, destinoAutorizado] of MALFORMADOS) {
      for (const executar of [true, false]) {
        const banco = poolProibido();
        const disco = armazenamentoProibido();
        const erro = await recusa(chamar(banco.pool, disco.armazenamento, { executar, destinoAutorizado }), 'DESTINO_NAO_AUTORIZADO');
        nadaTocado(banco, disco);
        assert.ok(erro.detalhes.length > 0, `${descricao}: a recusa traz detalhe`);
        assert.equal(/segredo-x|4242424|banco_de_teste/.test(erro.message), false, `${descricao}: a mensagem ecoa o valor`);
      }
    }
    for (const valido of [{ banco: 'b'.repeat(63), oid: '4294967295' }, { banco: 'a', oid: '1' }, { banco: '_x$y-z.1', oid: '16384' }]) {
      const erro = await recusa(chamar(poolProibido().pool, armazenamentoProibido().armazenamento, { destinoAutorizado: valido }), 'PACOTE_INDISPONIVEL');
      assert.equal(erro.codigo, 'PACOTE_INDISPONIVEL', `controle: ${JSON.stringify(valido)} passa da validação do destino`);
    }
  });

  test('DST-SRV-03 — controle: a verificação não conhece destino (nunca acessa o PostgreSQL): verificarPacotePadrao recusa destinoAutorizado como argumento desconhecido', async () => {
    const erro = await recusa(SERVICO().verificarPacotePadrao({ pacote: INEXISTENTE, pacoteSha256Esperado: SHA, destinoAutorizado: AUTORIZADO }), 'PACOTE_ARGUMENTOS_INVALIDOS');
    assert.equal(erro.message.includes(IDENTIDADE.banco), false);
    await recusa(SERVICO().verificarPacotePadrao({ pacote: INEXISTENTE, pacoteSha256Esperado: SHA }), 'PACOTE_INDISPONIVEL');
  });

  const DIVERGENCIAS = [
    ['banco diferente', { banco: 'outro_banco_ficticio', oid: IDENTIDADE.oid }, ['banco']],
    ['OID diferente', { banco: IDENTIDADE.banco, oid: '4242425' }, ['oid']],
    ['banco e OID diferentes', { banco: 'outro_banco_ficticio', oid: '1' }, ['banco', 'oid']],
    ['mesmo nome com letras maiúsculas (a comparação é exata)', { banco: IDENTIDADE.banco.toUpperCase(), oid: IDENTIDADE.oid }, ['banco']],
    ['OID com um dígito a menos', { banco: IDENTIDADE.banco, oid: '424242' }, ['oid']],
  ];

  for (const executar of [true, false]) {
    test(`DST-SRV-04.${executar ? 'executar' : 'simular'} — destino divergente com ${executar ? 'gravação' : 'simulação'}: DESTINO_NAO_AUTORIZADO, e a única coisa que acontece é abrir a transação, conferir a identidade e desfazer; nenhum armazenamento, trava, leitura de estado ou escrita`, async () => {
      const c = caso();
      for (const [descricao, destinoAutorizado, campos] of DIVERGENCIAS) {
        const tempo = linhaDoTempo();
        const disco = armazenamentoProibido();
        const erro = await recusa(chamar(tempo.pool(bancoFalso(IDENTIDADE)), disco.armazenamento, { executar, destinoAutorizado }, c), 'DESTINO_NAO_AUTORIZADO');
        assert.deepEqual(forma(tempo), ['CONNECT:1', `1:${executar ? 'BEGIN' : 'BEGIN READ ONLY'}`, '1:IDENTIDADE', '1:ROLLBACK', 'LIBERA:1'], descricao);
        assert.equal(tempo.eventos.find((e) => e.tipo === 'LIBERA').texto, 'false', `${descricao}: a conexão volta ao pool íntegra`);
        assert.deepEqual(disco.registros, [], `${descricao}: o armazenamento não foi tocado`);
        assert.deepEqual(erro.detalhes.map((d) => d.campo), campos, descricao);
        for (const d of erro.detalhes) {
          assert.equal(d.motivo, 'DIFERENTE_DO_AUTORIZADO');
          assert.equal(d.esperado, destinoAutorizado[d.campo]);
          assert.equal(d.calculado, IDENTIDADE[d.campo]);
        }
        assert.equal(erro.message.includes(IDENTIDADE.banco) || erro.message.includes('outro_banco_ficticio'), false, `${descricao}: a mensagem fixa não leva nome`);
      }
      const ok = await chamar(linhaDoTempo().pool(bancoFalso(IDENTIDADE)), armazenamentoFalso(), { executar, destinoAutorizado: AUTORIZADO }, c);
      assert.equal(ok.modo, executar ? 'EXECUCAO' : 'SIMULACAO', 'controle: o destino igual ao da conexão é aceito');
    });
  }

  test('DST-SRV-05 — identidade ilegível (a consulta não devolve linha): DESTINO_NAO_AUTORIZADO, também sem efeito algum', async () => {
    const c = caso();
    const tempo = linhaDoTempo();
    const disco = armazenamentoProibido();
    const erro = await recusa(chamar(tempo.pool(bancoFalso(null)), disco.armazenamento, { destinoAutorizado: AUTORIZADO }, c), 'DESTINO_NAO_AUTORIZADO');
    assert.deepEqual(forma(tempo), ['CONNECT:1', '1:BEGIN', '1:IDENTIDADE', '1:ROLLBACK', 'LIBERA:1']);
    assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.motivo]), [['destino', 'IDENTIDADE_INDISPONIVEL']]);
    assert.deepEqual(disco.registros, []);
  });

  test('DST-SRV-06 — destino válido: a identidade é a PRIMEIRA instrução depois do BEGIN, na mesma conexão de toda a transação, e vem antes do ajuste de espera, da trava, da leitura do estado, de qualquer chamada ao armazenamento e de qualquer escrita; o relatório devolve o destino lido', async () => {
    const c = caso();
    const tempo = linhaDoTempo();
    const relatorio = await chamar(tempo.pool(bancoFalso(IDENTIDADE)), tempo.armazenamento(armazenamentoFalso()), { destinoAutorizado: AUTORIZADO }, c);
    assert.equal(relatorio.modo, 'EXECUCAO');
    assert.deepEqual(relatorio.destino, IDENTIDADE);
    assert.deepEqual(relatorio.resumo, { total: 30, novas: 30, existentes: 0, arquivosNovos: 60, arquivosPresentes: 0, sugestoes: 0 });

    const e = tempo.eventos;
    assert.deepEqual([e[0].tipo, e[1].texto], ['CONNECT', 'BEGIN']);
    assert.equal(tempo.ehIdentidade(e[2]), true, 'a identidade é a primeira instrução depois do BEGIN');
    assert.equal(e.filter(tempo.ehIdentidade).length, 1);
    const depois = e.slice(3);
    assert.ok(depois.some(tempo.ehEfeito), 'controle: depois da identidade a instrumentação enxerga efeitos');
    const indice = (teste) => e.findIndex(teste);
    for (const [rotulo, teste] of [
      ['ajuste de espera', (x) => /lock_timeout/i.test(x.texto)], ['trava consultiva', (x) => /pg_advisory_xact_lock/i.test(x.texto)], ['leitura do estado', (x) => /FROM imagens_padrao\b/i.test(x.texto)],
      ['armazenamento', (x) => x.tipo === 'ARM'], ['escrita', (x) => /^INSERT\b/i.test(x.texto)],
    ]) {
      const i = indice(teste);
      assert.ok(i > 2, `${rotulo} aparece depois da identidade (posição ${i})`);
    }
    assert.deepEqual([...new Set(e.filter((x) => x.tipo === 'SQL').map((x) => x.conexao))], [1], 'toda a transação, identidade inclusive, usa a mesma conexão');
  });

  test('DST-SRV-07 — simulação com destino válido: a identidade é lida dentro de BEGIN READ ONLY (antes de ler o estado), nada é escrito, e o relatório leva o destino', async () => {
    const c = caso();
    const tempo = linhaDoTempo();
    const relatorio = await chamar(tempo.pool(bancoFalso(IDENTIDADE)), tempo.armazenamento(armazenamentoFalso()), { executar: false, destinoAutorizado: AUTORIZADO }, c);
    assert.equal(relatorio.modo, 'SIMULACAO');
    assert.deepEqual(relatorio.destino, IDENTIDADE);
    assert.equal(tempo.eventos[1].texto, 'BEGIN READ ONLY');
    assert.equal(tempo.ehIdentidade(tempo.eventos[2]), true);
    assert.deepEqual(tempo.sql().map((x) => x.texto).filter((t) => /^(INSERT|UPDATE|DELETE|SET LOCAL)|advisory/i.test(t)), []);
    assert.equal(tempo.eventos.filter((x) => x.tipo === 'ARM' && x.texto === 'gravar').length, 0);
  });
});

// -------------------------------------------------------------------------------------------------------------------------- DST-CLI
describe('[DST-CLI] executarComando: a recusa de destino sai como ARGUMENTOS (2), diz o que fazer e não toca em nada', () => {
  function capturar() {
    const linhas = [];
    const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
    return { saida: { log: guardar, error: guardar }, texto: () => linhas.join('\n') };
  }
  const comando = (c, modo, extra, pool, armazenamento) => {
    const capturada = capturar();
    const chamada = CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo, ...extra }, { pool, armazenamento, saida: capturada.saida });
    return { chamada, capturada };
  };

  test('DST-CLI-01 — gravar sem destino: saída 2, DESTINO_NAO_AUTORIZADO e a dica das duas opções na saída, ZIP nem lido (o caminho nem existe), banco e armazenamento intocados', async () => {
    const banco = poolProibido();
    const disco = armazenamentoProibido();
    const t = comando({ zip: INEXISTENTE, sha: SHA }, 'EXECUTAR', {}, banco.pool, disco.armazenamento);
    const r = await t.chamada;
    assert.equal(r.saida, 2);
    nadaTocado(banco, disco);
    const texto = t.capturada.texto();
    assert.ok(texto.includes('DESTINO_NAO_AUTORIZADO'), texto);
    assert.ok(texto.includes('--banco-autorizado') && texto.includes('--banco-oid'), 'a saída diz como informar o destino');
    assert.ok(!texto.includes('PACOTE_INDISPONIVEL'), 'o ZIP nem foi lido');
  });

  test('DST-CLI-02 — destino divergente em EXECUTAR e em SIMULAR: saída 2, a saída mostra campo, esperado e calculado, só a transação de conferência foi aberta e desfeita', async () => {
    const c = caso();
    for (const modo of ['EXECUTAR', 'SIMULAR']) {
      const tempo = linhaDoTempo();
      const disco = armazenamentoProibido();
      const t = comando(c, modo, { destino: { banco: IDENTIDADE.banco, oid: '4242425' } }, tempo.pool(bancoFalso(IDENTIDADE)), disco.armazenamento);
      const r = await t.chamada;
      assert.equal(r.saida, 2, modo);
      assert.deepEqual(forma(tempo), ['CONNECT:1', `1:${modo === 'EXECUTAR' ? 'BEGIN' : 'BEGIN READ ONLY'}`, '1:IDENTIDADE', '1:ROLLBACK', 'LIBERA:1'], modo);
      assert.deepEqual(disco.registros, []);
      const texto = t.capturada.texto();
      assert.ok(texto.includes('DESTINO_NAO_AUTORIZADO'), texto);
      assert.match(texto, /campo=oid motivo=DIFERENTE_DO_AUTORIZADO esperado=4242425 calculado=4242424/);
    }
  });

  test('DST-CLI-03 — destino válido: saída 0 e a linha "Destino conferido pela conexão" com o banco e o OID lidos; um só dos dois argumentos (OID nulo) é recusado com saída 2', async () => {
    const c = caso();
    const t = comando(c, 'EXECUTAR', { destino: AUTORIZADO }, bancoFalso(IDENTIDADE), armazenamentoFalso());
    const r = await t.chamada;
    assert.equal(r.saida, 0, t.capturada.texto());
    assert.match(t.capturada.texto(), /Destino conferido pela conexão: banco banco_de_teste_ficticio \(oid 4242424\)/);
    const metade = comando(c, 'EXECUTAR', { destino: { banco: IDENTIDADE.banco, oid: null } }, poolProibido().pool, armazenamentoProibido().armazenamento);
    assert.equal((await metade.chamada).saida, 2);
    assert.match(metade.capturada.texto(), /campo=oid motivo=AUSENTE/);
  });

  test('DST-CLI-04 — controle: os códigos de saída seguem congelados (DESTINO_NAO_AUTORIZADO reaproveita ARGUMENTOS) e o modo --verificar continua sem tocar em nada', async () => {
    assert.deepEqual(CLI().SAIDAS, { OK: 0, ERRO: 1, ARGUMENTOS: 2, INTEGRIDADE: 3, DIVERGENCIA: 4 });
    const c = caso();
    const banco = poolProibido();
    const disco = armazenamentoProibido();
    const t = comando(c, 'VERIFICAR', {}, banco.pool, disco.armazenamento);
    assert.equal((await t.chamada).saida, 0);
    nadaTocado(banco, disco);
  });
});

// -------------------------------------------------------------------------------------------------------------------------- DST-ARM
describe('[DST-ARM] o diretório de imagens só nasce depois da conferência do destino', () => {
  const chave = `padrao/${'b'.repeat(64)}/mestre.png`;
  const ambiente = (diretorio) => ({ IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio });

  test('DST-ARM-01 — em EXECUTAR o armazenamento é criado sob demanda: nenhum diretório existe até a primeira chamada, e então nasce com modo 0700', async () => {
    const base = criarRaizTemporaria();
    raizes.push(base);
    const diretorio = path.join(base, 'ainda-nao-existe', 'imagens');
    const armazenamento = CLI().criarArmazenamento('EXECUTAR', ambiente(diretorio));
    for (const metodo of ['gravar', 'abrir', 'existe']) assert.equal(typeof armazenamento[metodo], 'function', metodo);
    assert.deepEqual(fs.readdirSync(base), [], 'nada foi criado no disco ao montar o armazenamento');
    assert.equal(await armazenamento.existe(chave), false);
    assert.equal(fs.statSync(diretorio).mode & 0o777, 0o700);
  });

  test('DST-ARM-02 — controle: a simulação com diretório inexistente continua sem criar nada (armazenamento só de leitura, que recusa gravar)', async () => {
    const base = criarRaizTemporaria();
    raizes.push(base);
    const diretorio = path.join(base, 'ainda-nao-existe');
    const armazenamento = CLI().criarArmazenamento('SIMULAR', ambiente(diretorio));
    assert.equal(await armazenamento.existe(chave), false);
    await assert.rejects(() => armazenamento.gravar(chave, Buffer.from('x'), { maxBytes: 10 }), /somente leitura/);
    assert.deepEqual(fs.readdirSync(base), []);
  });

  test('DST-ARM-03 — sem IMAGENS_ARMAZENAMENTO_DIRETORIO a montagem falha logo (IMAGENS_INDISPONIVEL), antes de qualquer conexão', () => {
    assert.throws(() => CLI().criarArmazenamento('EXECUTAR', {}), (erro) => erro.codigo === 'IMAGENS_INDISPONIVEL');
    assert.throws(() => CLI().criarArmazenamento('SIMULAR', {}), (erro) => erro.codigo === 'IMAGENS_INDISPONIVEL');
  });
});

// ------------------------------------------------------------------------------------------------------------------------- DST-PROC
describe('[DST-PROC] processo real (node scripts/imagens-importar-padrao.js): nenhum efeito antes da conferência do destino', () => {
  const SEGREDO = 'SEGREDO-DO-AMBIENTE-DO-TESTE-DST-5521';

  /** Processo de verdade, ambiente mínimo e banco INALCANÇÁVEL (porta 1): qualquer tentativa de conexão falha com saída 1. O diretório de imagens é um caminho que NÃO existe. */
  function rodar(argumentos) {
    const c = caso();
    const cwd = fs.mkdtempSync(path.join(c.dir, 'cwd-'));
    const diretorio = path.join(c.dir, 'imagens-que-nao-existem');
    const r = spawnSync(process.execPath, [SCRIPT, '--pacote', c.zip, '--sha256', c.sha, ...argumentos], {
      cwd,
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'banco_inexistente', DB_USER: 'usuario_inexistente', DB_PASSWORD: SEGREDO, IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio,
      },
      encoding: 'utf8',
      timeout: 120000,
    });
    return { status: r.status, saida: `${r.stdout}\n${r.stderr}`, cwd, diretorio, c };
  }
  const intacto = (r) => {
    assert.equal(fs.existsSync(r.diretorio), false, 'o diretório de imagens não foi criado');
    assert.deepEqual(fs.readdirSync(r.cwd), [], 'nada foi criado na pasta de execução');
    assert.equal(r.saida.includes(SEGREDO), false, 'a saída vaza um segredo do ambiente');
    assert.equal(r.saida.includes(r.c.dir), false, 'a saída vaza o caminho do pacote');
  };

  test('DST-PROC-01 — --executar sem o destino: saída 2, DESTINO_NAO_AUTORIZADO e a dica das duas opções, sem tentar o banco e sem criar o diretório de imagens', () => {
    const r = rodar(['--executar']);
    assert.equal(r.status, 2, r.saida);
    assert.ok(r.saida.includes('DESTINO_NAO_AUTORIZADO'), r.saida);
    assert.ok(r.saida.includes('--banco-autorizado') && r.saida.includes('--banco-oid'), r.saida);
    assert.match(r.saida, /Destino autorizado: não informado/);
    intacto(r);
  });

  test('DST-PROC-02 — --executar com o destino informado mas o banco inalcançável: a conexão falha (saída 1) e o diretório de imagens continua sem existir; a linha de destino diz o autorizado e nunca "conferido"', () => {
    const r = rodar(['--executar', '--banco-autorizado', 'meu_banco_ficticio', '--banco-oid', '16384']);
    assert.equal(r.status, 1, r.saida);
    assert.match(r.saida, /Destino autorizado: banco meu_banco_ficticio \(oid 16384\)/);
    assert.doesNotMatch(r.saida, /Destino conferido/);
    assert.doesNotMatch(r.saida, /sucesso|conclu[ií]d/i);
    intacto(r);
  });

  test('DST-PROC-03 — --dry-run com o destino e o banco inalcançável: saída 1, sem criar o diretório; --verificar com o destino: saída 2 (não se aplica), sem eco dos valores', () => {
    const simulacao = rodar(['--dry-run', '--banco-autorizado', 'meu_banco_ficticio', '--banco-oid', '16384']);
    assert.equal(simulacao.status, 1, simulacao.saida);
    intacto(simulacao);
    const verificacao = rodar(['--verificar', '--banco-autorizado', 'meu_banco_ficticio', '--banco-oid', '16384']);
    assert.equal(verificacao.status, 2, verificacao.saida);
    assert.equal(verificacao.saida.includes('meu_banco_ficticio') || verificacao.saida.includes('16384'), false, 'o erro de argumento ecoa o valor');
    intacto(verificacao);
  });
});
