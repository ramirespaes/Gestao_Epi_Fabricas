'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/pacote-padrao-ficticio');
const { poolProibido, armazenamentoProibido } = require('../helpers/instrumentacao-importacao');
const { ZIP_INTEGRO } = require('../helpers/cenarios-importacao-padrao');

// 31ª imagem padrão: o serviço e a linha de comando aceitam um pacote de 1 imagem quando a quantidade é declarada; o padrão continua 30. Sem banco.

const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');
const DESTINO = Object.freeze({ banco: 'banco_de_teste_ficticio', oid: '4242424' });
const NOME = 'Calça de Segurança Aluminizada';
const novo = h.recomporItem(NOME, { original: h.originalFicticio(NOME), padronizado: h.pngFicticio({ semente: NOME }), miniatura: h.webpFicticio({ semente: NOME }) });
const ZIP_UNICO = h.zipDoPacote(Object.freeze({ itens: Object.freeze([novo]), manifesto: h.manifestoCsv([novo]), leiaMe: 'LEIA-ME (FICTÍCIO)\r\n' }));
const quantidadeDiferente = (esperado, calculado) => [{ campo: 'linhas', motivo: 'QUANTIDADE_DIFERENTE', esperado, calculado }];

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
function caso(zip) {
  const dir = criarRaizTemporaria();
  raizes.push(dir);
  return { dir, zip: h.gravarArquivo(dir, 'Pacote_Ficticio.zip', zip), sha: h.sha256(zip) };
}
const argumentosDe = (c, extra = {}) => ({ pacote: c.zip, pacoteSha256Esperado: c.sha, ...extra });

async function recusa(promessa, codigo) {
  let erro = null;
  try { await promessa; } catch (e) { erro = e; }
  assert.notEqual(erro, null, 'a operação deveria ser recusada');
  assert.equal(erro.codigo, codigo, `${erro.codigo}: ${erro.message}`);
  return erro;
}

function capturar() {
  const linhas = [];
  const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
  return { saida: { log: guardar, error: guardar }, texto: () => linhas.join('\n') };
}

describe('[QTD-SVC] serviço: quantidadeEsperada', () => {
  test('QTD-SVC-01 — verificarPacotePadrao com quantidadeEsperada 1 confere o pacote de uma imagem (3 arquivos) e não toca o ZIP', async () => {
    const c = caso(ZIP_UNICO);
    const antes = fs.statSync(c.zip);
    const r = await SERVICO().verificarPacotePadrao(argumentosDe(c, { quantidadeEsperada: 1 }));
    assert.equal(r.ok, true);
    assert.equal(r.manifesto.linhas, 1);
    assert.equal(r.verificados, 3);
    assert.deepEqual(r.arquivos.map((a) => [a.papel, a.confere]), [['ORIGINAL', true], ['PADRONIZADO', true], ['MINIATURA', true]]);
    const depois = fs.statSync(c.zip);
    assert.deepEqual([depois.size, depois.mtimeMs, depois.ino], [antes.size, antes.mtimeMs, antes.ino]);
  });

  test('QTD-SVC-02 — sem o parâmetro o pacote de uma imagem continua recusado (padrão 30); com a quantidade errada, nos dois sentidos, também', async () => {
    const c = caso(ZIP_UNICO);
    assert.deepEqual((await recusa(SERVICO().verificarPacotePadrao(argumentosDe(c)), 'PACOTE_MANIFESTO_INVALIDO')).detalhes, quantidadeDiferente(30, 1));
    assert.deepEqual((await recusa(SERVICO().verificarPacotePadrao(argumentosDe(c, { quantidadeEsperada: 2 })), 'PACOTE_MANIFESTO_INVALIDO')).detalhes, quantidadeDiferente(2, 1));
    const trinta = caso(ZIP_INTEGRO);
    assert.deepEqual((await recusa(SERVICO().verificarPacotePadrao(argumentosDe(trinta, { quantidadeEsperada: 1 })), 'PACOTE_MANIFESTO_INVALIDO')).detalhes, quantidadeDiferente(1, 30));
  });

  test('QTD-SVC-03 — o pacote das 30 continua passando, sem o parâmetro e com 30 explícito', async () => {
    const c = caso(ZIP_INTEGRO);
    for (const extra of [{}, { quantidadeEsperada: 30 }]) {
      const r = await SERVICO().verificarPacotePadrao(argumentosDe(c, extra));
      assert.equal(r.verificados, 90);
      assert.equal(r.manifesto.linhas, 30);
    }
  });

  test('QTD-SVC-04 — quantidadeEsperada inválida e chave com outro nome são PACOTE_ARGUMENTOS_INVALIDOS, na verificação e na importação, antes de tocar banco ou armazenamento', async () => {
    const c = caso(ZIP_UNICO);
    for (const valor of [0, 31, -1, 1.5, '1', null, Number.NaN, true]) {
      await recusa(SERVICO().verificarPacotePadrao(argumentosDe(c, { quantidadeEsperada: valor })), 'PACOTE_ARGUMENTOS_INVALIDOS');
      const banco = poolProibido();
      const disco = armazenamentoProibido();
      await recusa(SERVICO().importarPacotePadrao(banco.pool, { ...argumentosDe(c, { quantidadeEsperada: valor }), armazenamento: disco.armazenamento, mapeamento: null, executar: false }), 'PACOTE_ARGUMENTOS_INVALIDOS');
      assert.deepEqual([banco.registros, disco.registros], [[], []]);
    }
    await recusa(SERVICO().verificarPacotePadrao(argumentosDe(c, { quantidade: 1 })), 'PACOTE_ARGUMENTOS_INVALIDOS');
  });

  test('QTD-SVC-05 — importarPacotePadrao repassa a quantidade: com ela o pacote de uma imagem chega a abrir a conexão; sem ela é recusado antes de qualquer acesso', async () => {
    const c = caso(ZIP_UNICO);
    const sem = { banco: poolProibido(), disco: armazenamentoProibido() };
    const recusado = await recusa(SERVICO().importarPacotePadrao(sem.banco.pool, { ...argumentosDe(c), armazenamento: sem.disco.armazenamento, mapeamento: null, executar: true, destinoAutorizado: DESTINO }), 'PACOTE_MANIFESTO_INVALIDO');
    assert.deepEqual(recusado.detalhes, quantidadeDiferente(30, 1));
    assert.deepEqual([sem.banco.registros, sem.disco.registros], [[], []]);

    const com = { banco: poolProibido(), disco: armazenamentoProibido() };
    await recusa(SERVICO().importarPacotePadrao(com.banco.pool, { ...argumentosDe(c, { quantidadeEsperada: 1 }), armazenamento: com.disco.armazenamento, mapeamento: null, executar: false }), 'IMPORTACAO_FALHOU');
    assert.deepEqual(com.banco.registros.map((r) => r.metodo), ['connect'], 'o pacote passou e o serviço tentou abrir a conexão');
    assert.deepEqual(com.disco.registros, []);
  });
});

describe('[QTD-CLI] linha de comando: --quantidade', () => {
  const SHA = 'a'.repeat(64);
  const ZIP = '/tmp/gepi-pacote-qualquer.zip';
  const base = ['--pacote', ZIP, '--sha256', SHA];
  const esperado = (extra) => ({ ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'SIMULAR', ...extra });

  test('QTD-CLI-01 — --quantidade entra no resultado em qualquer modo e posição; sem ele não existe a chave quantidade', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos([...base, '--quantidade', '1']), esperado({ quantidade: 1 }));
    assert.deepEqual(interpretarArgumentos(['--quantidade', '30', ...base]), esperado({ quantidade: 30 }));
    assert.deepEqual(interpretarArgumentos([...base, '--quantidade', '7', '--verificar']), esperado({ quantidade: 7, modo: 'VERIFICAR' }));
    assert.deepEqual(
      interpretarArgumentos([...base, '--quantidade', '1', '--executar', '--banco-autorizado', 'banco', '--banco-oid', '1']),
      esperado({ quantidade: 1, modo: 'EXECUTAR', destino: { banco: 'banco', oid: '1' } }),
    );
    assert.deepEqual(interpretarArgumentos(base), esperado({}));
    assert.equal(Object.hasOwn(interpretarArgumentos(base), 'quantidade'), false);
  });

  test('QTD-CLI-02 — --quantidade inválido é recusado sem ecoar o valor: fora de 1 a 30, não inteiro, zero à esquerda, sinal, espaço, vazio, repetido ou sem valor', () => {
    const { interpretarArgumentos } = CLI();
    for (const valor of ['0', '31', '100', '-1', '+1', '01', '1.5', '1e1', '0x1', ' 1', '1 ', 'abc', '']) {
      const r = interpretarArgumentos([...base, '--quantidade', valor]);
      assert.equal(r.ok, false, JSON.stringify(valor));
      for (const eco of ['abc', '1e1', '0x1', '1.5', '100', '31']) assert.equal(r.erro.includes(eco), false, `o erro ecoa "${eco}"`);
    }
    for (const argumentos of [[...base, '--quantidade'], [...base, '--quantidade', '--executar'], [...base, '--quantidade', '1', '--quantidade', '1']]) {
      assert.equal(interpretarArgumentos(argumentos).ok, false, JSON.stringify(argumentos));
    }
  });

  test('QTD-CLI-03 — o texto de uso cita --quantidade e o padrão 30', () => {
    const texto = CLI().uso();
    assert.ok(texto.includes('--quantidade'));
    assert.match(texto, /--quantidade[^\n]*30/);
  });

  test('QTD-CLI-04 — --verificar com quantidade 1 confere o pacote de uma imagem (saída 0); sem ela, INTEGRIDADE (3) com QUANTIDADE_DIFERENTE', async () => {
    const c = caso(ZIP_UNICO);
    const aprovada = capturar();
    const ok = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo: 'VERIFICAR', quantidade: 1 }, { saida: aprovada.saida });
    assert.equal(ok.saida, 0);
    assert.match(aprovada.texto(), /Arquivos conferidos: 3/);
    assert.match(aprovada.texto(), /Imagens no pacote: 1/);

    const recusada = capturar();
    const r = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo: 'VERIFICAR' }, { saida: recusada.saida });
    assert.equal(r.saida, 3);
    assert.match(recusada.texto(), /campo=linhas motivo=QUANTIDADE_DIFERENTE esperado=30 calculado=1/);
  });

  test('QTD-CLI-05 — nos modos que usam o banco a quantidade segue para o serviço: com ela o pacote chega a abrir a conexão; sem ela é recusado antes', async () => {
    const c = caso(ZIP_UNICO);
    for (const modo of ['SIMULAR', 'EXECUTAR']) {
      const sem = { banco: poolProibido(), disco: armazenamentoProibido(), cap: capturar() };
      const recusado = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo, destino: DESTINO }, { pool: sem.banco.pool, armazenamento: sem.disco.armazenamento, saida: sem.cap.saida });
      assert.equal(recusado.saida, 3, modo);
      assert.deepEqual([sem.banco.registros, sem.disco.registros], [[], []], modo);

      const com = { banco: poolProibido(), disco: armazenamentoProibido(), cap: capturar() };
      const chegou = await CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo, destino: DESTINO, quantidade: 1 }, { pool: com.banco.pool, armazenamento: com.disco.armazenamento, saida: com.cap.saida });
      assert.equal(chegou.saida, 1, modo);
      assert.deepEqual(com.banco.registros.map((r) => r.metodo), ['connect'], modo);
      assert.deepEqual(com.disco.registros, [], modo);
    }
  });
});
