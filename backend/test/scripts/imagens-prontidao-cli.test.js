'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { ErroImportacaoPadrao } = require('../../src/utils/pacote-padrao-erros');
const { MAX_BYTES } = require('../../src/utils/plano-pacotes-padrao');
const cli = require('../../scripts/imagens-prontidao');

/**
 * CLI de prontidão da biblioteca padrão (scripts/imagens-prontidao.js): argumentos, mapeamento de estado e erro para o código de saída, saída sem vazamento e,
 * em processo real, as falhas que acontecem antes de qualquer conexão. O serviço é injetado; ele tem a suíte própria em test/services.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'imagens-prontidao.js');
const { SAIDAS } = cli;
const HASH = 'c'.repeat(64);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
function novaRaiz() {
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  return raiz;
}

const saidaFalsa = () => {
  const linhas = [];
  const erros = [];
  return { log: (t) => linhas.push(String(t)), error: (t) => erros.push(String(t)), linhas, erros, texto: () => linhas.join('\n'), textoErros: () => erros.join('\n') };
};
const argsValidos = (extra = {}) => ({
  json: false, plano: '/pacotes/plano.json', planoSha256: HASH, pacotes: '/pacotes', idadeMinimaMinutos: undefined, destino: { banco: 'gestao_epi_hml', oid: '16401' }, ...extra,
});
const relatorioDe = (estado, extra = {}) => ({ estado, politica: estado === 'DESABILITADA' ? 'desabilitada' : 'obrigatoria', motivos: [], avisos: [], ...extra });

describe('argumentos', () => {
  test('aceita só o plano, o hash e a pasta, e todos os opcionais', () => {
    const minimo = cli.interpretarArgumentos(['--plano', '/p/plano.json', '--plano-sha256', HASH, '--pacotes', '/p']);
    assert.deepEqual(minimo, { ok: true, json: false, plano: '/p/plano.json', planoSha256: HASH, pacotes: '/p', idadeMinimaMinutos: undefined, destino: null });
    const completo = cli.interpretarArgumentos(['--json', '--plano', '/p/plano.json', '--plano-sha256', HASH, '--pacotes', '/p', '--idade-minima-minutos', '0', '--banco-autorizado', 'gestao_epi', '--banco-oid', '16401']);
    assert.equal(completo.json, true);
    assert.equal(completo.idadeMinimaMinutos, 0);
    assert.deepEqual(completo.destino, { banco: 'gestao_epi', oid: '16401' });
  });

  test('sem argumentos é válido para o parser (a obrigatoriedade depende da política)', () => {
    assert.deepEqual(cli.interpretarArgumentos([]), { ok: true, json: false, plano: null, planoSha256: null, pacotes: null, idadeMinimaMinutos: undefined, destino: null });
  });

  test('não existe argumento que importe, grave, apague ou corrija', () => {
    for (const argumento of ['--executar', '--dry-run', '--verificar', '--importar', '--remover', '--restaurar', '--mapeamento', '--pacote', '--sha256', '--quantidade', '--forcar', '--qualquer-coisa']) {
      assert.deepEqual(cli.interpretarArgumentos([argumento, 'x']), { ok: false, erro: 'argumento desconhecido' }, argumento);
    }
  });

  test('valor ausente, repetido, relativo ou malformado é recusado sem ecoar o valor', () => {
    const casos = [
      [['--plano'], /--plano exige um valor/],
      [['--plano', '--json'], /--plano exige um valor/],
      [['--plano', '/a', '--plano', '/b'], /--plano informado mais de uma vez/],
      [['--json', '--json'], /--json informado mais de uma vez/],
      [['--plano', 'relativo/plano.json'], /--plano deve ser um caminho absoluto/],
      [['--pacotes', 'relativa'], /--pacotes deve ser um caminho absoluto/],
      [['--plano-sha256', 'ABC'], /--plano-sha256 deve ter 64/],
      [['--plano-sha256', HASH.toUpperCase()], /--plano-sha256 deve ter 64/],
      [['--idade-minima-minutos', '-1'], /--idade-minima-minutos deve ser/],
      [['--idade-minima-minutos', '1.5'], /--idade-minima-minutos deve ser/],
      [['--banco-autorizado', 'b'], /devem ser informados juntos/],
      [['--banco-oid', '1'], /devem ser informados juntos/],
      [['--banco-autorizado', 'b', '--banco-oid', 'abc'], /--banco-oid deve ser numérico/],
      [['--banco-autorizado', 'x\u0007y', '--banco-oid', '1'], /--banco-autorizado inválido/],
    ];
    for (const [argumentos, esperado] of casos) {
      const r = cli.interpretarArgumentos(argumentos);
      assert.equal(r.ok, false, argumentos.join(' '));
      assert.match(r.erro, esperado);
    }
    assert.doesNotMatch(cli.interpretarArgumentos(['--plano', 'relativo-secreto']).erro, /secreto/);
  });

  test('recusa argumentos que não são lista', () => {
    assert.throws(() => cli.interpretarArgumentos('x'), TypeError);
  });
});

describe('política e argumentos exigidos', () => {
  test('política ausente ou inválida: saída 2, nada é lido nem consultado', async () => {
    for (const ambiente of [{}, { IMAGENS_BIBLIOTECA_PADRAO: '' }, { IMAGENS_BIBLIOTECA_PADRAO: 'talvez' }]) {
      const saida = saidaFalsa();
      let chamado = false;
      const { saida: codigo } = await cli.executarComando(argsValidos(), {
        ambiente, saida, lerArquivo: async () => { chamado = true; }, verificarProntidao: async () => { chamado = true; },
      });
      assert.equal(codigo, SAIDAS.ARGUMENTOS);
      assert.match(saida.textoErros(), /IMAGENS_POLITICA_INVALIDA/);
      assert.equal(chamado, false);
    }
  });

  test('obrigatoria sem plano, hash ou pasta: saída 2 dizendo o que falta', async () => {
    const saida = saidaFalsa();
    const { saida: codigo } = await cli.executarComando(argsValidos({ plano: null, pacotes: null }), {
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }, saida, lerArquivo: async () => assert.fail('não deveria ler'), verificarProntidao: async () => assert.fail('não deveria verificar'),
    });
    assert.equal(codigo, SAIDAS.ARGUMENTOS);
    assert.match(saida.textoErros(), /--plano; --pacotes são obrigatórios/);
  });

  test('obrigatoria sem a identidade do banco (--banco-autorizado e --banco-oid): saída 2, e nada é lido nem consultado', async () => {
    const saida = saidaFalsa();
    const { saida: codigo } = await cli.executarComando(argsValidos({ destino: null }), {
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }, saida, lerArquivo: async () => assert.fail('não deveria ler'), verificarProntidao: async () => assert.fail('não deveria verificar'),
    });
    assert.equal(codigo, SAIDAS.ARGUMENTOS);
    assert.match(saida.textoErros(), /--banco-autorizado e --banco-oid é obrigatório/);
  });

  test('desabilitada dispensa plano e pacotes: não lê arquivo, devolve DESABILITADA e saída 0', async () => {
    const saida = saidaFalsa();
    let recebido = null;
    const { saida: codigo, resultado } = await cli.executarComando(argsValidos({ plano: null, planoSha256: null, pacotes: null }), {
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' },
      saida,
      lerArquivo: async () => assert.fail('não deveria ler o plano'),
      verificarProntidao: async (opcoes) => { recebido = opcoes; return relatorioDe('DESABILITADA'); },
    });
    assert.equal(codigo, SAIDAS.OK);
    assert.equal(resultado.estado, 'DESABILITADA');
    assert.equal(recebido.plano, null);
    assert.match(saida.texto(), /^ESTADO=DESABILITADA$/m);
  });
});

describe('estado → código de saída', () => {
  const rodar = async (estado, extra = {}, opcoes = {}) => {
    const saida = saidaFalsa();
    let recebido = null;
    const bytes = Buffer.from('{"plano":true}');
    const resposta = await cli.executarComando(argsValidos(opcoes), {
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' },
      pool: { connect() {} },
      saida,
      lerArquivo: async (caminho) => { assert.equal(caminho, '/pacotes/plano.json'); return bytes; },
      verificarProntidao: async (o) => { recebido = o; return relatorioDe(estado, extra); },
    });
    return { ...resposta, saida: resposta.saida, texto: saida, recebido, bytes };
  };

  test('PROVISIONADA_INTEGRA = 0, NAO_PROVISIONADA = 4, INCONSISTENTE = 5; o estado vai na linha ESTADO=', async () => {
    for (const [estado, esperado] of [['PROVISIONADA_INTEGRA', 0], ['NAO_PROVISIONADA', 4], ['INCONSISTENTE', 5]]) {
      const r = await rodar(estado);
      assert.equal(r.saida, esperado, estado);
      assert.match(r.texto.texto(), new RegExp(`^ESTADO=${estado}$`, 'm'));
      assert.match(r.texto.texto(), /Nenhuma alteração foi feita\./);
    }
  });

  test('repassa ao serviço os bytes do plano, o hash aprovado, a pasta, o destino e a idade, e o pool', async () => {
    const r = await rodar('PROVISIONADA_INTEGRA', {}, { destino: { banco: 'b', oid: '7' }, idadeMinimaMinutos: 30 });
    assert.equal(r.recebido.plano.bytes, r.bytes);
    assert.equal(r.recebido.plano.sha256Esperado, HASH);
    assert.equal(r.recebido.pastaPacotes, '/pacotes');
    assert.deepEqual(r.recebido.destino, { banco: 'b', oid: '7' });
    assert.equal(r.recebido.idadeMinimaOrfaoMinutos, 30);
  });

  test('sem --idade-minima-minutos o padrão do serviço vale (a chave nem é enviada)', async () => {
    const r = await rodar('PROVISIONADA_INTEGRA');
    assert.equal(Object.hasOwn(r.recebido, 'idadeMinimaOrfaoMinutos'), false);
  });

  test('o texto lista motivos e pacotes sem hash de arquivo nem caractere de controle', async () => {
    const r = await rodar('INCONSISTENTE', {
      motivos: [{ classe: 'INCONSISTENTE', codigo: 'PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS', arquivo: 'Pacote‮A.zip', divergencias: 2 }],
      pacotes: [{ arquivo: 'Pacote‮A.zip', imagens: 30, situacao: 'DIVERGENTE', divergencias: [{ nome: 'Luva', alvo: 'ARQUIVO', motivo: 'AUSENTE' }], divergenciasTotal: 2 }],
      plano: { sha256: HASH, pacotes: 1 },
      banco: { nome: 'gestao_epi_hml', oid: '16401' },
    });
    const texto = r.texto.texto();
    assert.match(texto, /PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS/);
    assert.match(texto, /nome=Luva alvo=ARQUIVO motivo=AUSENTE/);
    assert.match(texto, /gestao_epi_hml \(oid 16401\)/);
    assert.doesNotMatch(texto, /[0-9a-f]{64}/);
    assert.doesNotMatch(texto, /[‮]/);
  });

  test('--json imprime um único documento com o estado', async () => {
    const r = await rodar('NAO_PROVISIONADA', {}, { json: true });
    assert.equal(r.texto.linhas.length, 1);
    assert.equal(JSON.parse(r.texto.linhas[0]).estado, 'NAO_PROVISIONADA');
    assert.equal(r.saida, 4);
  });
});

describe('erros → código de saída', () => {
  const comErro = async (erro) => {
    const saida = saidaFalsa();
    const resposta = await cli.executarComando(argsValidos(), {
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }, saida, lerArquivo: async () => Buffer.alloc(1), verificarProntidao: async () => { throw erro; },
    });
    return { ...resposta, erros: saida.textoErros() };
  };

  test('plano ou pacote sem integridade comprovada = 3', async () => {
    for (const codigo of ['PLANO_INDISPONIVEL', 'PLANO_SHA256_DIVERGENTE', 'PLANO_INVALIDO', 'PACOTE_INDISPONIVEL', 'PACOTE_SHA256_DIVERGENTE', 'PACOTE_MANIFESTO_INVALIDO', 'PACOTE_HASH_DIVERGENTE', 'PACOTE_INVALIDO', 'IMAGEM_PADRAO_INVALIDA']) {
      const r = await comErro(new ErroImportacaoPadrao(codigo, [{ entrada: 'x', motivo: 'SHA256' }]));
      assert.equal(r.saida, SAIDAS.INTEGRIDADE, codigo);
      assert.match(r.erros, new RegExp(`Recusado \\(${codigo}\\)`));
    }
  });

  test('argumentos e destino inválidos = 2; falha da importação = 1', async () => {
    assert.equal((await comErro(new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS'))).saida, SAIDAS.ARGUMENTOS);
    assert.equal((await comErro(new ErroImportacaoPadrao('DESTINO_NAO_AUTORIZADO', [{ campo: 'banco', motivo: 'DIFERENTE_DO_AUTORIZADO', esperado: 'a', calculado: 'b' }]))).saida, SAIDAS.ARGUMENTOS);
    assert.equal((await comErro(new ErroImportacaoPadrao('IMPORTACAO_FALHOU'))).saida, SAIDAS.ERRO);
    assert.equal((await comErro(new ErroImportacaoPadrao('IMPORTACAO_EM_ANDAMENTO'))).saida, SAIDAS.ERRO);
  });

  test('política inválida vinda do serviço = 2', async () => {
    const r = await comErro(Object.assign(new Error('IMAGENS_BIBLIOTECA_PADRAO: inválida'), { codigo: 'IMAGENS_POLITICA_INVALIDA' }));
    assert.equal(r.saida, SAIDAS.ARGUMENTOS);
  });

  test('erro desconhecido propaga (o processo termina com 1 e a descrição segura)', async () => {
    await assert.rejects(comErro(new TypeError('inesperado')), TypeError);
  });

  test('a recusa não imprime o hash do pacote ou do plano, só prefixo ou nada', async () => {
    const r = await comErro(new ErroImportacaoPadrao('PLANO_SHA256_DIVERGENTE', [{ motivo: 'SHA256', esperado: HASH, calculado: 'd'.repeat(64) }]));
    assert.doesNotMatch(r.erros, /[0-9a-f]{64}/);
  });
});

describe('leitura do arquivo do plano', () => {
  test('lê o arquivo; ausente, diretório e acima do teto viram PLANO_INDISPONIVEL sem o caminho na mensagem', async () => {
    const raiz = novaRaiz();
    const arquivo = path.join(raiz, 'plano.json');
    fs.writeFileSync(arquivo, '{"a":1}');
    assert.equal((await cli.lerArquivoDoPlano(arquivo)).toString(), '{"a":1}');
    const grande = path.join(raiz, 'grande.json');
    fs.writeFileSync(grande, Buffer.alloc(MAX_BYTES + 1, 0x20));
    for (const alvo of [path.join(raiz, 'nao-existe.json'), raiz, grande]) {
      await assert.rejects(cli.lerArquivoDoPlano(alvo), (erro) => erro.codigo === 'PLANO_INDISPONIVEL' && !erro.message.includes(raiz));
    }
  });
});

describe('processo real: falhas ANTES de qualquer conexão com o banco', () => {
  const base = { PATH: process.env.PATH, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}) };
  const rodar = (argumentos, ambiente = {}) => spawnSync(process.execPath, [SCRIPT, ...argumentos], { encoding: 'utf8', env: { ...base, ...ambiente }, timeout: 20000 });
  const SEM_BANCO = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'inexistente', DB_USER: 'inexistente', DB_PASSWORD: 'x' };
  const IDENTIDADE = ['--banco-autorizado', 'gestao_epi_hml', '--banco-oid', '16401'];

  function planoEmDisco() {
    const raiz = novaRaiz();
    const bytes = Buffer.from(JSON.stringify({ versao: 1, pacotes: [{ arquivo: 'Pacote.zip', sha256: 'a'.repeat(64), quantidade: 3 }] }));
    const caminho = path.join(raiz, 'plano.json');
    fs.writeFileSync(caminho, bytes);
    return { raiz, caminho, sha: sha(bytes) };
  }

  test('argumento desconhecido (inclusive os de escrita): saída 2, uso no stderr, nada no stdout', () => {
    for (const argumento of ['--executar', '--importar', '--qualquer-coisa']) {
      const r = rodar([argumento]);
      assert.equal(r.status, 2, `${argumento}: ${r.stderr}`);
      assert.match(r.stderr, /Argumentos inválidos: argumento desconhecido/);
      assert.equal(r.stdout, '');
    }
  });

  test('sem IMAGENS_BIBLIOTECA_PADRAO: saída 2; a omissão nunca vale como desabilitada', () => {
    const r = rodar([]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /IMAGENS_POLITICA_INVALIDA/);
    assert.doesNotMatch(r.stdout, /ESTADO=DESABILITADA/);
  });

  test('desabilitada: ESTADO=DESABILITADA e saída 0 sem plano, sem diretório e sem variáveis de banco', () => {
    const r = rodar([], { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ESTADO=DESABILITADA$/m);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED/);
  });

  test('obrigatoria sem plano, hash e pasta: saída 2', () => {
    const r = rodar([], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--plano; --plano-sha256; --pacotes; --banco-autorizado e --banco-oid são obrigatórios/);
  });

  test('obrigatoria com plano, hash e pasta, mas SEM a identidade do banco: saída 2 e nada é lido', () => {
    const { raiz, caminho, sha: hash } = planoEmDisco();
    const r = rodar(['--plano', caminho, '--plano-sha256', hash, '--pacotes', raiz], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...SEM_BANCO });
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /--banco-autorizado e --banco-oid é obrigatório/);
    assert.equal(r.stdout, '');
  });

  test('obrigatoria com hash de plano divergente: saída 3, sem tentar o banco', () => {
    const { raiz, caminho } = planoEmDisco();
    const r = rodar(['--plano', caminho, '--plano-sha256', 'f'.repeat(64), '--pacotes', raiz, ...IDENTIDADE], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...SEM_BANCO });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /PLANO_SHA256_DIVERGENTE/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED/);
  });

  test('obrigatoria com plano ausente: saída 3 (PLANO_INDISPONIVEL)', () => {
    const { raiz, sha: hash } = planoEmDisco();
    const r = rodar(['--plano', path.join(raiz, 'nao-existe.json'), '--plano-sha256', hash, '--pacotes', raiz, ...IDENTIDADE], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...SEM_BANCO });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /PLANO_INDISPONIVEL/);
  });

  test('obrigatoria sem IMAGENS_ARMAZENAMENTO_DIRETORIO: NAO_PROVISIONADA, saída 4, sem tentar o banco (que está inalcançável de propósito)', () => {
    const { raiz, caminho, sha: hash } = planoEmDisco();
    const r = rodar(['--plano', caminho, '--plano-sha256', hash, '--pacotes', raiz, ...IDENTIDADE], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...SEM_BANCO });
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^ESTADO=NAO_PROVISIONADA$/m);
    assert.match(r.stdout, /DIRETORIO_NAO_CONFIGURADO/);
    assert.doesNotMatch(r.stdout + r.stderr, /ECONNREFUSED|password|senha/i);
  });

  test('obrigatoria com diretório inexistente: NAO_PROVISIONADA, saída 4, e o diretório continua inexistente', () => {
    const { raiz, caminho, sha: hash } = planoEmDisco();
    const dir = path.join(raiz, 'imagens-que-nao-existem');
    const r = rodar(['--plano', caminho, '--plano-sha256', hash, '--pacotes', raiz, ...IDENTIDADE], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', IMAGENS_ARMAZENAMENTO_DIRETORIO: dir, ...SEM_BANCO });
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /DIRETORIO_INEXISTENTE/);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(r.stdout.includes(dir), false, 'a saída leva o caminho absoluto');
  });

  test('obrigatoria com diretório de permissão inadequada: INCONSISTENTE, saída 5', { skip: process.platform === 'win32' }, () => {
    const { raiz, caminho, sha: hash } = planoEmDisco();
    const dir = path.join(raiz, 'imagens');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    const r = rodar(['--plano', caminho, '--plano-sha256', hash, '--pacotes', raiz, ...IDENTIDADE], { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', IMAGENS_ARMAZENAMENTO_DIRETORIO: dir, ...SEM_BANCO });
    assert.equal(r.status, 5, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^ESTADO=INCONSISTENTE$/m);
    assert.match(r.stdout, /PERMISSAO_ACESSO_DE_OUTROS/);
  });
});
