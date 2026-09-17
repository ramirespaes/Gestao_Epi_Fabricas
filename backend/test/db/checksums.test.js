'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALGORITMO,
  calcularChecksum,
  listarMigrations,
  lerManifesto,
  compararComManifesto,
  temDivergencia,
  atualizarManifesto,
} = require('../../src/db/checksums');

/**
 * Integridade das migrations históricas.
 *
 * O manifesto migrations/checksums.json guarda o SHA-256 dos bytes de cada
 * arquivo. O verificador precisa distinguir alteração, remoção, renomeação e
 * arquivo novo, e a atualização automática só pode aceitar arquivo novo: nunca
 * regravar o digest de uma migration histórica apenas para o alarme calar.
 */

// Digests públicos e conhecidos do SHA-256, para o teste não repetir a
// implementação que deveria estar verificando.
const SHA256_VAZIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const criarDiretorio = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-checksums-'));
const removerDiretorio = (diretorio) => fs.rmSync(diretorio, { recursive: true, force: true });
const escrever = (diretorio, nome, conteudo) => fs.writeFileSync(path.join(diretorio, nome), conteudo);

const comDiretorio = (executar) => {
  const diretorio = criarDiretorio();
  try {
    return executar(diretorio);
  } finally {
    removerDiretorio(diretorio);
  }
};

const manifestoDe = (migrations) => ({ algoritmo: 'sha256', migrations });

describe('calcularChecksum', () => {
  test('devolve o SHA-256 conhecido de um conteúdo fixo', () => {
    assert.equal(ALGORITMO, 'sha256');
    assert.equal(calcularChecksum(Buffer.from('')), SHA256_VAZIO);
    assert.equal(calcularChecksum(Buffer.from('abc')), SHA256_ABC);
  });

  test('um único byte diferente altera o digest', () => {
    const original = calcularChecksum(Buffer.from('abc'));
    const alterado = calcularChecksum(Buffer.from('abd'));
    assert.notEqual(original, alterado);
    assert.match(original, /^[0-9a-f]{64}$/);
    assert.match(alterado, /^[0-9a-f]{64}$/);
  });
});

describe('listarMigrations', () => {
  test('recusa nome de migration fora do padrão', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'SELECT 1;');
      escrever(diretorio, 'ajuste_manual.sql', 'SELECT 1;');
      assert.throws(() => listarMigrations(diretorio), /ajuste_manual\.sql/);
    });
  });

  test('aceita prefixo com exatamente três dígitos', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '017_nova_migration.sql', 'abc');
      const migrations = listarMigrations(diretorio);
      assert.equal(migrations.length, 1);
      assert.equal(migrations[0].versao, '017');
      assert.equal(migrations[0].checksum, SHA256_ABC);
    });
  });

  test('recusa prefixo com menos de três dígitos', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '17_nova_migration.sql', 'abc');
      assert.throws(() => listarMigrations(diretorio), /17_nova_migration\.sql/);
    });
  });

  test('recusa prefixo com mais de três dígitos', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '0017_nova_migration.sql', 'abc');
      assert.throws(() => listarMigrations(diretorio), /0017_nova_migration\.sql/);
    });
  });

  test('recusa prefixo duplicado', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '001_create_empresas.sql', 'SELECT 1;');
      escrever(diretorio, '001_create_perfis.sql', 'SELECT 2;');
      assert.throws(() => listarMigrations(diretorio), /001/);
    });
  });
});

describe('lerManifesto', () => {
  test('manifesto válido é lido e devolvido com cópia das migrations', () => {
    comDiretorio((diretorio) => {
      const caminho = path.join(diretorio, 'checksums.json');
      const original = { algoritmo: 'sha256', migrations: { '000_create_empresas.sql': SHA256_ABC } };
      fs.writeFileSync(caminho, JSON.stringify(original));

      const lido = lerManifesto(caminho);

      assert.deepEqual(lido, original);
      lido.migrations['000_create_empresas.sql'] = SHA256_VAZIO;
      assert.deepEqual(lerManifesto(caminho), original, 'a leitura deve devolver cópia, não referência ao arquivo');
    });
  });

  test('recusa manifesto com nome de migration fora do padrão', () => {
    comDiretorio((diretorio) => {
      const caminho = path.join(diretorio, 'checksums.json');
      fs.writeFileSync(caminho, JSON.stringify({
        algoritmo: 'sha256',
        migrations: { 'ajuste_manual.sql': SHA256_ABC },
      }));
      assert.throws(() => lerManifesto(caminho), /ajuste_manual\.sql/);
    });
  });

  test('recusa manifesto com prefixo duplicado', () => {
    comDiretorio((diretorio) => {
      const caminho = path.join(diretorio, 'checksums.json');
      fs.writeFileSync(caminho, JSON.stringify({
        algoritmo: 'sha256',
        migrations: {
          '001_create_empresas.sql': SHA256_ABC,
          '001_create_perfis.sql': SHA256_VAZIO,
        },
      }));
      assert.throws(() => lerManifesto(caminho), /001/);
    });
  });

  test('manifesto ausente falha de forma explícita', () => {
    comDiretorio((diretorio) => {
      const caminho = path.join(diretorio, 'checksums.json');
      assert.throws(() => lerManifesto(caminho), /checksums\.json/);
    });
  });

  test('manifesto malformado falha de forma explícita', () => {
    comDiretorio((diretorio) => {
      const caminho = path.join(diretorio, 'checksums.json');
      fs.writeFileSync(caminho, '{ isso não é json');
      assert.throws(() => lerManifesto(caminho));

      fs.writeFileSync(caminho, JSON.stringify({ migrations: {} }));
      assert.throws(() => lerManifesto(caminho), /algoritmo/);

      fs.writeFileSync(caminho, JSON.stringify({ algoritmo: 'md5', migrations: {} }));
      assert.throws(() => lerManifesto(caminho), /algoritmo/);

      fs.writeFileSync(caminho, JSON.stringify([]));
      assert.throws(() => lerManifesto(caminho), /objeto/);

      fs.writeFileSync(caminho, JSON.stringify({ algoritmo: 'sha256', migrations: [] }));
      assert.throws(() => lerManifesto(caminho), /migrations/);

      fs.writeFileSync(caminho, JSON.stringify({ algoritmo: 'sha256', migrations: { 'a.sql': 'xyz' } }));
      assert.throws(() => lerManifesto(caminho), /checksum/);
    });
  });
});

describe('compararComManifesto', () => {
  test('manifesto íntegro não produz divergência', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      const arquivos = listarMigrations(diretorio);
      const relatorio = compararComManifesto(arquivos, manifestoDe({ '000_create_empresas.sql': SHA256_ABC }));

      assert.deepEqual(relatorio.alteradas, []);
      assert.deepEqual(relatorio.ausentes, []);
      assert.deepEqual(relatorio.novas, []);
      assert.deepEqual(relatorio.renomeadas, []);
      assert.deepEqual(relatorio.ok, ['000_create_empresas.sql']);
      assert.equal(temDivergencia(relatorio), false);
    });
  });

  test('migration histórica alterada é detectada', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      const arquivos = listarMigrations(diretorio);
      const relatorio = compararComManifesto(arquivos, manifestoDe({ '000_create_empresas.sql': SHA256_VAZIO }));

      assert.equal(relatorio.alteradas.length, 1);
      assert.equal(relatorio.alteradas[0].nome, '000_create_empresas.sql');
      assert.equal(relatorio.alteradas[0].checksumRegistrado, SHA256_VAZIO);
      assert.equal(relatorio.alteradas[0].checksumAtual, SHA256_ABC);
      assert.equal(temDivergencia(relatorio), true);
    });
  });

  test('migration histórica ausente é detectada', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      const arquivos = listarMigrations(diretorio);
      const relatorio = compararComManifesto(arquivos, manifestoDe({
        '000_create_empresas.sql': SHA256_ABC,
        '001_create_perfis.sql': SHA256_VAZIO,
      }));

      assert.equal(relatorio.ausentes.length, 1);
      assert.equal(relatorio.ausentes[0].nome, '001_create_perfis.sql');
      assert.deepEqual(relatorio.novas, []);
      assert.equal(temDivergencia(relatorio), true);
    });
  });

  test('migration nova ainda não registrada é detectada', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      escrever(diretorio, '001_create_perfis.sql', 'nova');
      const arquivos = listarMigrations(diretorio);
      const relatorio = compararComManifesto(arquivos, manifestoDe({ '000_create_empresas.sql': SHA256_ABC }));

      assert.equal(relatorio.novas.length, 1);
      assert.equal(relatorio.novas[0].nome, '001_create_perfis.sql');
      assert.deepEqual(relatorio.ausentes, []);
      assert.deepEqual(relatorio.renomeadas, []);
      assert.equal(temDivergencia(relatorio), true);
    });
  });

  test('renomeação é detectada quando o digest é o mesmo, e não vira duas divergências', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '001_create_perfis_renomeada.sql', 'abc');
      const arquivos = listarMigrations(diretorio);
      const relatorio = compararComManifesto(arquivos, manifestoDe({ '001_create_perfis.sql': SHA256_ABC }));

      assert.equal(relatorio.renomeadas.length, 1);
      assert.deepEqual(relatorio.renomeadas[0], {
        de: '001_create_perfis.sql',
        para: '001_create_perfis_renomeada.sql',
        checksum: SHA256_ABC,
      });
      assert.deepEqual(relatorio.ausentes, []);
      assert.deepEqual(relatorio.novas, []);
      assert.equal(temDivergencia(relatorio), true);
    });
  });
});

describe('atualizarManifesto', () => {
  test('aceita somente migration nova', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      escrever(diretorio, '001_create_perfis.sql', '');
      const arquivos = listarMigrations(diretorio);
      const manifesto = manifestoDe({ '000_create_empresas.sql': SHA256_ABC });
      const relatorio = compararComManifesto(arquivos, manifesto);

      const atualizado = atualizarManifesto(manifesto, relatorio);

      assert.equal(atualizado.algoritmo, 'sha256');
      assert.deepEqual(atualizado.migrations, {
        '000_create_empresas.sql': SHA256_ABC,
        '001_create_perfis.sql': SHA256_VAZIO,
      });
      assert.notEqual(atualizado, manifesto, 'não deve mutar o manifesto recebido');
      assert.deepEqual(manifesto.migrations, { '000_create_empresas.sql': SHA256_ABC });
    });
  });

  test('recusa migration histórica alterada ou removida', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '000_create_empresas.sql', 'abc');
      const arquivos = listarMigrations(diretorio);

      const manifestoComAlterada = manifestoDe({ '000_create_empresas.sql': SHA256_VAZIO });
      const comAlterada = compararComManifesto(arquivos, manifestoComAlterada);
      assert.throws(() => atualizarManifesto(manifestoComAlterada, comAlterada), /alterada/i);

      const manifestoComRemovida = manifestoDe({
        '000_create_empresas.sql': SHA256_ABC,
        '001_create_perfis.sql': SHA256_VAZIO,
      });
      const comRemovida = compararComManifesto(arquivos, manifestoComRemovida);
      assert.throws(() => atualizarManifesto(manifestoComRemovida, comRemovida), /ausente|removida/i);
    });
  });

  test('recusa renomeação de migration histórica', () => {
    comDiretorio((diretorio) => {
      escrever(diretorio, '001_create_perfis_renomeada.sql', 'abc');
      const arquivos = listarMigrations(diretorio);
      const manifesto = manifestoDe({ '001_create_perfis.sql': SHA256_ABC });
      const relatorio = compararComManifesto(arquivos, manifesto);

      assert.throws(() => atualizarManifesto(manifesto, relatorio), /renomead/i);
    });
  });
});
