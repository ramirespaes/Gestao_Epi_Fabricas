'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Aviso de senha alterada na troca autenticada (Bloco 11E). É o mesmo aviso
 * da redefinição pelo link, na mesma entrega e com a mesma garantia de
 * melhor esforço depois do COMMIT, mas o texto não pode afirmar que todos os
 * acessos foram encerrados: na troca autenticada o acesso em uso continua. O
 * texto da redefinição fica exatamente como está.
 */

const entrega = () => exigirModulo('src/services/entrega-recuperacao-senha.service');

const EMAIL = 'pessoa.destinataria@example.invalid';
const SUPORTE = 'suporte@safeworkengenharia.com.br';
const FRASE_DA_REDEFINICAO = 'os acessos abertos foram encerrados';

let diretorio;
let saidas;

function espiarConsole(t) {
  saidas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { saidas.push(JSON.stringify(argumentos)); });
  }
}

const arquivos = () => (fs.existsSync(diretorio) ? fs.readdirSync(diretorio) : []);
const emArquivo = () => entrega().criarEntrega({ config: { modo: 'arquivo', arquivo: { diretorio } } });

async function textoDoAviso(dados) {
  const instancia = emArquivo();
  assert.equal(instancia.enfileirarAvisoSenhaAlterada(dados), undefined, 'quem enfileira não recebe promessa para esperar');
  await instancia.aguardarOciosidade();
  const nomes = arquivos();
  assert.equal(nomes.length, 1, 'um arquivo por aviso');
  const texto = fs.readFileSync(path.join(diretorio, nomes[0]), 'utf8');
  fs.rmSync(path.join(diretorio, nomes[0]));
  return texto;
}

beforeEach(() => {
  diretorio = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-aviso-troca-')), 'emails');
});

afterEach(() => {
  fs.rmSync(path.dirname(diretorio), { recursive: true, force: true });
});

describe('aviso de senha alterada — variante da troca autenticada', () => {
  for (const [escopo, nome] of [['PORTAL', 'Portal do Cliente'], ['PLATAFORMA', 'Painel Privado']]) {
    test(`${escopo}: avisa a troca, diz que os demais acessos foram encerrados e não diz que todos foram`, async (t) => {
      espiarConsole(t);
      const texto = await textoDoAviso({ escopo, email: EMAIL, origem: 'TROCA' });

      assert.ok(texto.includes(EMAIL), 'destinatário');
      assert.ok(texto.includes(`Assunto: Sua senha foi alterada — ${nome}`), 'mesmo assunto do aviso existente');
      assert.match(texto, /demais acessos/i);
      assert.equal(texto.toLowerCase().includes(FRASE_DA_REDEFINICAO), false, 'o acesso em uso continua: não são "todos" os acessos');
      assert.ok(texto.includes(SUPORTE), 'contato de suporte');
      for (const proibido of ['#token=', 'redefinir-senha.html', 'token', 'http://', 'https://']) {
        assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, `o aviso não leva ${proibido}`);
      }
      assert.doesNotMatch(texto, /^(De|From|Remetente):/mi, 'o remetente automático continua indefinido');
    });
  }

  test('o texto da redefinição pelo link não muda: sem origem e com origem REDEFINICAO o aviso é idêntico e continua dizendo que os acessos foram encerrados', async (t) => {
    espiarConsole(t);
    for (const escopo of ['PORTAL', 'PLATAFORMA']) {
      const semOrigem = await textoDoAviso({ escopo, email: EMAIL });
      const comOrigem = await textoDoAviso({ escopo, email: EMAIL, origem: 'REDEFINICAO' });
      assert.equal(semOrigem, comOrigem, escopo);
      assert.ok(semOrigem.toLowerCase().includes(FRASE_DA_REDEFINICAO), escopo);
      assert.doesNotMatch(semOrigem, /demais acessos/i, escopo);
    }
  });

  test('as duas variantes são mensagens diferentes', async (t) => {
    espiarConsole(t);
    for (const escopo of ['PORTAL', 'PLATAFORMA']) {
      assert.notEqual(await textoDoAviso({ escopo, email: EMAIL, origem: 'TROCA' }), await textoDoAviso({ escopo, email: EMAIL }), escopo);
    }
  });

  test('origem desconhecida é erro de programação e nada é gravado', async () => {
    const instancia = emArquivo();
    try {
      for (const origem of ['OUTRA', 'troca', '', 42, {}]) {
        assert.throws(() => instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PORTAL', email: EMAIL, origem }), TypeError, JSON.stringify(origem));
      }
    } finally {
      await instancia.aguardarOciosidade();
    }
    assert.deepEqual(arquivos(), []);
  });

  test('modo desativado: a variante da troca é descartada sem arquivo, sem exceção e sem nada no console', async (t) => {
    espiarConsole(t);
    const instancia = entrega().criarEntrega({ config: { modo: 'desativado', arquivo: null } });
    assert.equal(instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PLATAFORMA', email: EMAIL, origem: 'TROCA' }), undefined);
    await instancia.aguardarOciosidade();
    assert.deepEqual(arquivos(), []);
    assert.deepEqual(saidas, []);
  });

  test('falha ao gravar a variante da troca não lança, não deixa promessa solta e o registro técnico só leva o tipo, o escopo e o código', async (t) => {
    espiarConsole(t);
    const rejeicoes = [];
    const ouvinte = (motivo) => { rejeicoes.push(motivo); };
    process.on('unhandledRejection', ouvinte);
    try {
      // O "diretório" é um arquivo comum: a gravação falha de verdade.
      fs.mkdirSync(path.dirname(diretorio), { recursive: true });
      fs.writeFileSync(diretorio, 'não é diretório');
      const instancia = emArquivo();
      assert.doesNotThrow(() => instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PORTAL', email: EMAIL, origem: 'TROCA' }));
      await instancia.aguardarOciosidade();
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });

      assert.deepEqual(rejeicoes, []);
      assert.equal(saidas.length, 1, 'uma linha de registro técnico da falha');
      assert.match(saidas[0], /entrega_falhou/);
      for (const sensivel of [EMAIL, 'pessoa.destinataria', diretorio]) assert.equal(saidas.join('\n').includes(sensivel), false, 'registro técnico com dado sensível');
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
  });
});
