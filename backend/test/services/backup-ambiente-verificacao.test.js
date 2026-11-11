'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { montarAmbiente, instantaneo, SEGREDO_NO_ARQUIVO } = require('../helpers/ambiente-verificacao-backup');
const { verificarAmbiente, ESTADOS, GRUPOS } = require('../../src/services/backup-ambiente-verificacao.service');
const J = require('../../src/utils/janela-escrita-imagens');

/**
 * G-A (D-ORF-6): diagnóstico do ambiente do backup, SOMENTE LEITURA. Ambiente fictício em diretório temporário exclusivo; a trava de janela é a
 * REAL (src/utils), só lida; as portas de leitura são injetáveis para simular dono e dispositivo diferentes sem privilégios.
 */

const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); });
function novo() { const m = montarAmbiente(); raizes.push(m.raiz); return m; }
const janelaReal = { lerArquivo: J.lerArquivoDaJanela, validar: J.validarArquivoDaJanela, ler: J.lerJanela };
const rodar = (m, extras = {}) => verificarAmbiente({ ambiente: extras.ambiente ?? m.ambiente, raizDoCodigo: m.caminhos.codigo, janela: janelaReal, ...extras.resto });
const achar = (relatorio, id) => relatorio.itens.find((i) => i.id === id);
const codigos = (relatorio) => Object.fromEntries(relatorio.itens.map((i) => [i.id, `${i.estado}:${i.codigo}`]));
const MEDICOES_DO_SISTEMA = Object.freeze(['livreBytes', 'dispositivo']);
/** Relatório em texto sem os dois números MEDIDOS pelo sistema (espaço livre e dispositivo), que nunca vêm de variável de ambiente; todo o restante continua sob busca textual. */
const semMedicoes = (relatorio) => JSON.stringify(relatorio, (chave, valor) => (MEDICOES_DO_SISTEMA.includes(chave) ? undefined : valor));
const PORTA_COLIDENTE = '70000';
/** Porta inválida cujos dígitos coincidem com uma medição injetada: a MESMA constante é a entrada e a agulha da busca textual, para uma não divergir da outra. */
async function rodarComPortaColidente(portas) {
  const m = novo();
  const r = await rodar(m, { ambiente: { ...m.ambiente, BACKUP_PG_PORTA: PORTA_COLIDENTE }, resto: { portas } });
  assert.equal(achar(r, 'PG_CONEXAO').codigo, 'VALOR_INVALIDO');
  assert.equal(semMedicoes(r).includes(PORTA_COLIDENTE), false, `eco de ${PORTA_COLIDENTE}`);
  return r;
}

describe('[SV] ambiente completo', () => {
  test('SV-01 — ambiente fictício completo: infraestrutura OK, operacional bloqueado, prontidão falsa, nada criado nem alterado em disco', async () => {
    const m = novo();
    const antes = instantaneo(m.raiz);
    const r = await rodar(m);
    assert.equal(instantaneo(m.raiz), antes, 'o diagnóstico não pode criar nem alterar nada');
    assert.equal(fs.existsSync(m.caminhos.arquivoDaJanela), false, 'a trava de janela não pode ser criada');
    const infra = r.itens.filter((i) => i.grupo !== GRUPOS.OPERACIONAL);
    assert.deepEqual(infra.filter((i) => i.estado !== ESTADOS.OK).map((i) => `${i.id}:${i.estado}:${i.codigo}`), []);
    assert.equal(r.veredito, 'INFRA_OK_OPERACIONAL_BLOQUEADO');
    assert.equal(r.prontidaoOperacional, false);
    assert.deepEqual(r.efeitos, { escritas: 0, conexoes: 0, processos: 0, janelasCriadas: 0 });
    assert.deepEqual(r.infraestrutura, { ok: infra.length, pendente: 0, falha: 0 });
    assert.equal(r.operacional.pendente, 7);
    assert.equal(achar(r, 'I5_ESTADO').codigo, 'JANELA_LIVRE');
    assert.equal(achar(r, 'MESMO_DISPOSITIVO').estado, ESTADOS.OK);
    assert.equal(achar(r, 'PG_DUMP').detalhe.versao, 'NAO_VERIFICADA');
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.itens));
  });

  test('SV-02 — ambiente vazio: tudo que depende de configuração fica PENDENTE (nada é presumido) e a prontidão continua falsa', async () => {
    const m = novo();
    const r = await verificarAmbiente({ ambiente: { BACKUP_PG_BINARIOS: m.caminhos.binarios }, raizDoCodigo: m.caminhos.codigo, janela: janelaReal });
    const c = codigos(r);
    for (const id of ['DIRETORIO_IMAGENS', 'DIRETORIO_FISCALIZACAO', 'BACKUP_RAIZ']) assert.equal(c[id], 'PENDENTE:VARIAVEL_AUSENTE', id);
    for (const id of ['PREPARACOES', 'DUMPS', 'PUBLICADOS', 'CONTROLE', 'CONTROLE_JANELA', 'CONTROLE_DIARIO', 'CONTROLE_REGISTROS']) assert.equal(c[id], 'PENDENTE:BACKUP_RAIZ_NAO_AVALIADA', id);
    assert.equal(c.I5_VARIAVEL, 'PENDENTE:I5_AUSENTE');
    assert.equal(c.PG_CONEXAO, 'PENDENTE:NAO_CONFIGURADA');
    assert.equal(c.ARQUIVO_DE_SENHA, 'PENDENTE:PGPASSFILE_AUSENTE');
    assert.equal(c.LIMITES, 'PENDENTE:NAO_CONFIGURADOS');
    assert.equal(c.PG_DUMP, 'OK:OK');
    assert.equal(r.veredito, 'INFRA_PENDENTE');
    assert.equal(r.prontidaoOperacional, false);
  });

  test('SV-03 — diretórios: modo permissivo, link simbólico, inexistente, dono e dispositivo divergentes e sobreposições são recusados com código específico', async () => {
    const m = novo();
    fs.chmodSync(m.caminhos.subdiretorios.dumps, 0o755);
    fs.rmSync(m.caminhos.subdiretorios.publicados, { recursive: true });
    fs.symlinkSync(m.caminhos.subdiretorios.preparacoes, m.caminhos.subdiretorios.publicados);
    fs.rmSync(m.caminhos.subdiretorios['controle/diario'], { recursive: true });
    const r = await rodar(m);
    const c = codigos(r);
    assert.equal(c.DUMPS, 'FALHA:MODO_PERMISSIVO');
    assert.equal(c.PUBLICADOS, 'FALHA:LINK_SIMBOLICO');
    assert.equal(c.CONTROLE_DIARIO, 'PENDENTE:INEXISTENTE');
    assert.equal(c.MESMO_DISPOSITIVO, 'PENDENTE:NAO_AVALIADO');
    assert.equal(r.veredito, 'FALHA');
    assert.equal(r.prontidaoOperacional, false);

    const outro = novo();
    const dono = await verificarAmbiente({ ambiente: outro.ambiente, raizDoCodigo: outro.caminhos.codigo, janela: janelaReal, portas: { getuid: () => process.getuid() + 1 } });
    assert.equal(achar(dono, 'DIRETORIO_IMAGENS').codigo, 'DONO_DIVERGENTE');
    assert.equal(achar(dono, 'BACKUP_RAIZ').codigo, 'DONO_DIVERGENTE');
    assert.equal(achar(dono, 'ARQUIVO_DE_SENHA').codigo, 'DONO_DIVERGENTE');

    const real = fs.lstatSync;
    const comOutroDispositivo = (e) => ({ isSymbolicLink: () => e.isSymbolicLink(), isDirectory: () => e.isDirectory(), isFile: () => e.isFile(), mode: e.mode, uid: e.uid, dev: e.dev + 1 });
    const dispositivos = await verificarAmbiente({
      ambiente: outro.ambiente, raizDoCodigo: outro.caminhos.codigo, janela: janelaReal,
      portas: { lstat: (p) => (p.endsWith('/dumps') ? comOutroDispositivo(real(p)) : real(p)) },
    });
    assert.equal(achar(dispositivos, 'MESMO_DISPOSITIVO').codigo, 'DISPOSITIVOS_DIFERENTES');
  });

  test('SV-04 — separação: o backup não pode ficar dentro das imagens, da fiscalização ou do código, nem conter essas árvores', async () => {
    const m = novo();
    const dentroDasImagens = await verificarAmbiente({ ambiente: { ...m.ambiente, BACKUP_RAIZ: m.caminhos.imagens }, raizDoCodigo: m.caminhos.codigo, janela: janelaReal });
    assert.equal(achar(dentroDasImagens, 'BACKUP_FORA_DAS_IMAGENS').codigo, 'BACKUP_SOBREPOSTO_A_IMAGENS');
    const contemOCodigo = await verificarAmbiente({ ambiente: m.ambiente, raizDoCodigo: m.caminhos.backup, janela: janelaReal });
    assert.equal(achar(contemOCodigo, 'BACKUP_FORA_DO_CODIGO').codigo, 'BACKUP_SOBREPOSTO_A_CODIGO');
    const contemAsOrigens = await verificarAmbiente({ ambiente: { ...m.ambiente, BACKUP_RAIZ: m.caminhos.dados }, raizDoCodigo: m.caminhos.codigo, janela: janelaReal });
    assert.equal(achar(contemAsOrigens, 'BACKUP_FORA_DAS_IMAGENS').codigo, 'BACKUP_SOBREPOSTO_A_IMAGENS');
  });
});

describe('[SV-I5] trava de janela (leitura apenas)', () => {
  test('SV-10 — valor relativo, dentro das imagens ou fora da pasta de controle: FALHA com código específico', async () => {
    const m = novo();
    const c1 = codigos(await rodar(m, { ambiente: { ...m.ambiente, IMAGENS_JANELA_ESCRITA_ARQUIVO: 'imagens.lock' } }));
    assert.equal(c1.I5_VARIAVEL, 'FALHA:I5_VALOR_INVALIDO');
    assert.equal(c1.I5_ARQUIVO, 'PENDENTE:NAO_AVALIADO');
    const c2 = codigos(await rodar(m, { ambiente: { ...m.ambiente, IMAGENS_JANELA_ESCRITA_ARQUIVO: path.join(m.caminhos.imagens, 'imagens.lock') } }));
    assert.equal(c2.I5_ARQUIVO, 'FALHA:I5_DENTRO_DAS_IMAGENS');
    const c3 = codigos(await rodar(m, { ambiente: { ...m.ambiente, IMAGENS_JANELA_ESCRITA_ARQUIVO: path.join(m.caminhos.dados, 'imagens.lock') } }));
    assert.equal(c3.I5_ARQUIVO, 'OK:OK', 'a pasta pai das imagens não está DENTRO delas: o código a aceita');
    assert.equal(c3.I5_PASTA_PADRAO, 'FALHA:I5_FORA_DA_PASTA_DE_CONTROLE', 'mas a política do plano exige a pasta de controle do backup');
  });

  test('SV-11 — pasta existente fora das imagens mas diferente da pasta de controle: OK para o código, FALHA para a política do plano', async () => {
    const m = novo();
    const outra = path.join(m.raiz, 'outra');
    fs.mkdirSync(outra, { mode: 0o700 });
    const r = await rodar(m, { ambiente: { ...m.ambiente, IMAGENS_JANELA_ESCRITA_ARQUIVO: path.join(outra, 'imagens.lock') } });
    assert.equal(achar(r, 'I5_ARQUIVO').estado, ESTADOS.OK);
    assert.equal(achar(r, 'I5_PASTA_PADRAO').codigo, 'I5_FORA_DA_PASTA_DE_CONTROLE');
  });

  test('SV-12 — trava existente: ocupada é PENDENTE (só o tipo aparece, nunca o token), ilegível é FALHA; o arquivo da trava não é tocado', async () => {
    const m = novo();
    const posse = await J.adquirirJanela({ arquivo: m.caminhos.arquivoDaJanela, tipo: J.TIPOS.LIMPEZA, raizArmazenamento: m.caminhos.imagens });
    try {
      const antes = crypto.createHash('sha256').update(fs.readFileSync(m.caminhos.arquivoDaJanela)).digest('hex');
      const snapshotAntes = instantaneo(m.raiz);
      const r = await rodar(m);
      assert.equal(instantaneo(m.raiz), snapshotAntes);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(m.caminhos.arquivoDaJanela)).digest('hex'), antes);
      assert.equal(achar(r, 'I5_ESTADO').codigo, 'JANELA_OCUPADA');
      assert.equal(achar(r, 'I5_ESTADO').estado, ESTADOS.PENDENTE);
      const documento = JSON.parse(fs.readFileSync(m.caminhos.arquivoDaJanela, 'utf8'));
      assert.match(documento.token, /^[0-9a-f]{32}$/);
      const texto = JSON.stringify(r);
      assert.equal(texto.includes(documento.token), false, 'o token da trava nunca sai pela leitura');
      assert.equal(texto.includes(String(documento.hospedeiro)), false, 'nome do hospedeiro não é devolvido');
      assert.equal(achar(r, 'I5_ESTADO').detalhe.tipo, 'LIMPEZA');
    } finally { await posse.liberar(); }
    fs.writeFileSync(m.caminhos.arquivoDaJanela, 'isto não é um documento de janela', { mode: 0o600 });
    const invalida = await rodar(m);
    assert.equal(achar(invalida, 'I5_ESTADO').codigo, 'JANELA_DOCUMENTO_INVALIDO');
    assert.equal(achar(invalida, 'I5_ESTADO').estado, ESTADOS.FALHA);
  });

  test('SV-13 — sem validador injetado, I5 fica PENDENTE; validador que falha de forma inesperada vira código genérico, sem eco', async () => {
    const m = novo();
    const sem = await verificarAmbiente({ ambiente: m.ambiente, raizDoCodigo: m.caminhos.codigo });
    assert.equal(achar(sem, 'I5').codigo, 'VALIDADOR_NAO_INJETADO');
    const falho = await verificarAmbiente({
      ambiente: m.ambiente, raizDoCodigo: m.caminhos.codigo,
      janela: { lerArquivo: janelaReal.lerArquivo, validar: async () => { throw new Error('caminho secreto /x'); }, ler: janelaReal.ler },
    });
    assert.equal(achar(falho, 'I5_ARQUIVO').codigo, 'I5_NAO_VALIDADA');
    assert.equal(JSON.stringify(falho).includes('secreto'), false);
  });
});

describe('[SV-PG] PostgreSQL, limites e espaço', () => {
  test('SV-20 — arquivo de senha: ausente, modo permissivo, link e inexistente são distintos; o conteúdo nunca é lido nem devolvido', async () => {
    const m = novo();
    const sem = codigos(await rodar(m, { ambiente: { ...m.ambiente, PGPASSFILE: undefined } }));
    assert.equal(sem.ARQUIVO_DE_SENHA, 'PENDENTE:PGPASSFILE_AUSENTE');
    fs.chmodSync(m.caminhos.senha, 0o644);
    assert.equal(codigos(await rodar(m)).ARQUIVO_DE_SENHA, 'FALHA:MODO_PERMISSIVO');
    fs.chmodSync(m.caminhos.senha, 0o600);
    const alvo = path.join(m.caminhos.segredos, 'alvo');
    fs.writeFileSync(alvo, 'x', { mode: 0o600 });
    const ligacao = path.join(m.caminhos.segredos, 'ligacao');
    fs.symlinkSync(alvo, ligacao);
    assert.equal(codigos(await rodar(m, { ambiente: { ...m.ambiente, PGPASSFILE: ligacao } })).ARQUIVO_DE_SENHA, 'FALHA:LINK_SIMBOLICO');
    assert.equal(codigos(await rodar(m, { ambiente: { ...m.ambiente, PGPASSFILE: path.join(m.caminhos.segredos, 'nao-existe') } })).ARQUIVO_DE_SENHA, 'PENDENTE:ARQUIVO_INEXISTENTE');
    assert.equal(codigos(await rodar(m)).ARQUIVO_DE_SENHA, 'OK:OK');
  });

  test('SV-21 — conexão: completa e válida é OK; incompleta é PENDENTE; valor malformado é FALHA; nenhum valor é devolvido', async () => {
    const m = novo();
    const ok = await rodar(m);
    assert.equal(achar(ok, 'PG_CONEXAO').estado, ESTADOS.OK);
    assert.deepEqual(achar(ok, 'PG_CONEXAO').detalhe, { porta: 5432, hostTipo: 'NOME' });
    const incompleta = await rodar(m, { ambiente: { ...m.ambiente, BACKUP_PG_BANCO: undefined } });
    assert.equal(achar(incompleta, 'PG_CONEXAO').codigo, 'CONFIGURACAO_INCOMPLETA');
    for (const ruim of [{ BACKUP_PG_PORTA: '0' }, { BACKUP_PG_PORTA: '70000' }, { BACKUP_PG_PORTA: '5432x' }, { BACKUP_PG_HOST: 'host com espaço' }, { BACKUP_PG_USUARIO: "x'; drop" }, { BACKUP_PG_BANCO: '-x' }]) {
      const r = await rodar(m, { ambiente: { ...m.ambiente, ...ruim } });
      assert.equal(achar(r, 'PG_CONEXAO').codigo, 'VALOR_INVALIDO', JSON.stringify(ruim));
      for (const valor of Object.values(ruim).filter((v) => v.length >= 5)) assert.equal(semMedicoes(r).includes(valor), false, `eco de ${valor}`);
    }
    const texto = JSON.stringify(ok);
    for (const valor of ['usuario_ficticio', 'banco_ficticio', SEGREDO_NO_ARQUIVO, 'SENHA-QUE-NAO-PODE-VAZAR']) assert.equal(texto.includes(valor), false, `vazou ${valor}`);
  });

  test('SV-21b — medição injetada: espaço livre medido com os dígitos 70000 não pode contar como eco da porta inválida 70000', async () => {
    const r = await rodarComPortaColidente({ statfs: () => ({ bavail: 1, bsize: 70000 }) });
    assert.equal(achar(r, 'ESPACO_LIVRE').detalhe.livreBytes, PORTA_COLIDENTE);
  });

  test('SV-21c — medição injetada: identificador de dispositivo 70000 não pode contar como eco da porta inválida 70000', async () => {
    const lstat = (caminho) => Object.create(fs.lstatSync(caminho), { dev: { value: 70000 } });
    const r = await rodarComPortaColidente({ lstat });
    assert.equal(achar(r, 'MESMO_DISPOSITIVO').detalhe.dispositivo, 70000);
  });

  test('SV-21d — controle: com medições que não contêm 70000 a verificação original passa (a falha vem só da coincidência)', async () => {
    const r = await rodarComPortaColidente({ statfs: () => ({ bavail: 1000, bsize: 4096 }) });
    assert.equal(achar(r, 'ESPACO_LIVRE').detalhe.livreBytes, '4096000');
    assert.equal(JSON.stringify(r).includes(PORTA_COLIDENTE), false, `eco de ${PORTA_COLIDENTE} (busca sobre o relatório inteiro, sem exclusões)`);
  });

  test('SV-21e — contraprova: eco indevido em detalhe, caminho ou código continua detectado; só as chaves livreBytes e dispositivo são ignoradas', async () => {
    const m = novo();
    const base = await rodar(m, { ambiente: { ...m.ambiente, BACKUP_PG_PORTA: '70000' } });
    assert.equal(semMedicoes(base).includes('70000'), false);
    const detectado = (alterar) => { const copia = structuredClone(base); alterar(copia); return semMedicoes(copia).includes('70000'); };
    const comCaminho = (copia) => copia.itens.find((i) => i.detalhe?.caminho !== undefined);
    assert.equal(detectado((c) => { achar(c, 'PG_CONEXAO').detalhe = { porta: 70000 }; }), true, 'porta ecoada em detalhe');
    assert.equal(detectado((c) => { comCaminho(c).detalhe.caminho = '/x/70000'; }), true, 'valor ecoado em caminho');
    assert.equal(detectado((c) => { achar(c, 'PG_CONEXAO').codigo = 'ECO_70000'; }), true, 'valor ecoado em código');
    assert.equal(detectado((c) => { c.itens[0].detalhe = { outroCampo: '70000' }; }), true, 'valor ecoado em outro campo de detalhe');
    assert.equal(detectado((c) => { achar(c, 'PG_CONEXAO').detalhe = { livre: '70000' }; }), true, 'nome de chave parecido não é ignorado');
    assert.equal(detectado((c) => { achar(c, 'ESPACO_LIVRE').detalhe = { livreBytes: '70000' }; }), false, 'livreBytes é medição do sistema');
    assert.equal(detectado((c) => { achar(c, 'MESMO_DISPOSITIVO').detalhe = { dispositivo: 70000 }; }), false, 'dispositivo é medição do sistema');
  });

  test('SV-22 — binários: ausentes ou não executáveis são FALHA; nunca são executados; variáveis PG* globais são FALHA e só os nomes aparecem', async () => {
    const m = novo();
    fs.chmodSync(path.join(m.caminhos.binarios, 'pg_restore'), 0o644);
    const r = await rodar(m);
    assert.equal(achar(r, 'PG_DUMP').estado, ESTADOS.OK);
    assert.equal(achar(r, 'PG_RESTORE').codigo, 'EXECUTAVEL_INDISPONIVEL');
    const marca = path.join(m.raiz, 'executou');
    fs.writeFileSync(path.join(m.caminhos.binarios, 'pg_dump'), `#!/bin/sh\ntouch ${marca}\n`);
    await rodar(m);
    assert.equal(fs.existsSync(marca), false, 'o binário não pode ser executado');
    const globais = await rodar(m, { ambiente: { ...m.ambiente, PGHOST: 'x', PGPASSWORD: 'segredo-global', PGSSLMODE: 'require' } });
    assert.equal(achar(globais, 'PG_VARIAVEIS_CONFLITANTES').codigo, 'VARIAVEL_PG_PRESENTE');
    assert.deepEqual(achar(globais, 'PG_VARIAVEIS_CONFLITANTES').detalhe.nomes, ['PGHOST', 'PGPASSWORD', 'PGSSLMODE']);
    assert.equal(JSON.stringify(globais).includes('segredo-global'), false);
  });

  test('SV-23 — limites: ausentes PENDENTE; coerentes OK; dump maior que o total ou valor inválido FALHA; espaço abaixo do mínimo FALHA', async () => {
    const m = novo();
    const semLimites = { ...m.ambiente }; delete semLimites.BACKUP_LIMITE_DUMP_BYTES; delete semLimites.BACKUP_LIMITE_TOTAL_BYTES; delete semLimites.BACKUP_LIMITE_LIVRE_BYTES;
    assert.equal(achar(await rodar(m, { ambiente: semLimites }), 'LIMITES').codigo, 'NAO_CONFIGURADOS');
    assert.equal(achar(await rodar(m), 'LIMITES').estado, ESTADOS.OK);
    assert.equal(achar(await rodar(m, { ambiente: { ...m.ambiente, BACKUP_LIMITE_DUMP_BYTES: '600000000' } }), 'LIMITES').codigo, 'DUMP_MAIOR_QUE_TOTAL');
    for (const ruim of ['0', '-1', '1.5', 'abc', '99999999999999999999']) assert.equal(achar(await rodar(m, { ambiente: { ...m.ambiente, BACKUP_LIMITE_TOTAL_BYTES: ruim } }), 'LIMITES').codigo, 'VALOR_INVALIDO', ruim);
    const pouco = await rodar(m, { resto: { portas: { statfs: () => ({ bavail: 10, bsize: 1 }) } } });
    assert.equal(achar(pouco, 'ESPACO_LIVRE').codigo, 'ESPACO_INSUFICIENTE');
    assert.equal(achar(pouco, 'ESPACO_LIVRE').detalhe.livreBytes, '10');
    const indisponivel = await rodar(m, { resto: { portas: { statfs: () => { throw new Error('x'); } } } });
    assert.equal(achar(indisponivel, 'ESPACO_LIVRE').codigo, 'INDISPONIVEL');
    assert.equal(achar(await rodar(m, { ambiente: semLimites }), 'ESPACO_LIVRE').codigo, 'MEDIDO_SEM_MINIMO');
  });
});

describe('[SV-OP] pendências operacionais nunca são simuladas', () => {
  test('SV-30 — listas de provedores, armazenamentos e destinos vazias e prontidão criptográfica não atendida: PENDENTE em qualquer ambiente, inclusive o completo', async () => {
    const m = novo();
    const r = await rodar(m);
    for (const id of ['PROVEDORES_DE_MAC', 'PROVEDORES_DE_CIFRA', 'ARMAZENAMENTOS_DURAVEIS', 'DESTINOS_HOMOLOGACAO', 'DESTINOS_PRODUCAO']) assert.equal(codigos(r)[id], 'PENDENTE:LISTA_VAZIA', id);
    const cripto = achar(r, 'PRONTIDAO_CRIPTOGRAFICA');
    assert.equal(cripto.estado, ESTADOS.PENDENTE);
    for (const esperado of ['RC-4:FONTE_DE_CIFRA_AUSENTE', 'RC-4:FONTE_DE_MAC_AUSENTE', 'D-F5:PROVEDOR_DE_MAC_NAO_APROVADO', 'D-F5:PROVEDOR_DE_CIFRA_NAO_APROVADO', 'RC-2:DESTINO_DURAVEL_NAO_APROVADO', 'D-F6:RETENCAO_SEM_DPO', 'RC-3:TRANSPORTE_SEM_TLS_VERIFY_FULL']) {
      assert.ok(cripto.detalhe.pendencias.includes(esperado), esperado);
    }
    assert.equal(codigos(r).COMPOSICAO_DE_PRODUCAO, 'PENDENTE:FONTE_DE_CHAVES_RECONHECIDA_INDISPONIVEL');
    assert.equal(r.prontidaoOperacional, false);
  });
});

describe('[SV-ENT] contrato da entrada', () => {
  test('SV-40 — entrada, portas e janela inválidas são erro de programação (TypeError), sem efeito', async () => {
    const m = novo();
    await assert.rejects(() => verificarAmbiente(null), TypeError);
    await assert.rejects(() => verificarAmbiente({ ambiente: {}, raizDoCodigo: 'relativo' }), TypeError);
    await assert.rejects(() => verificarAmbiente({ ambiente: {}, raizDoCodigo: m.caminhos.codigo, extra: 1 }), TypeError);
    await assert.rejects(() => verificarAmbiente({ ambiente: {}, raizDoCodigo: m.caminhos.codigo, portas: { escrever: () => {} } }), TypeError);
    await assert.rejects(() => verificarAmbiente({ ambiente: {}, raizDoCodigo: m.caminhos.codigo, janela: { lerArquivo: () => null } }), TypeError);
  });
});

describe('[SV-EST] prova estática: sem APIs de escrita, processo, conexão ou dotenv', () => {
  const SEM_COMENTARIOS = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const PROIBIDOS = [
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|createWriteStream|truncate|symlink|chmod|chown|utimes)\b/,
    /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/, /child_process/, /require\(['"]pg['"]\)/, /\bnet\.(connect|createConnection)\b/, /\.listen\(/,
    /O_WRONLY|O_CREAT|O_RDWR|O_APPEND|O_TRUNC/, /dotenv/, /process\.env\.[A-Z]/,
  ];
  for (const [rotulo, relativo] of [['serviço', '../../src/services/backup-ambiente-verificacao.service.js'], ['script', '../../scripts/backup-operar.js']]) {
    test(`SV-50 — ${rotulo}: nenhuma API proibida no código (sem comentários)`, () => {
      const codigo = SEM_COMENTARIOS(fs.readFileSync(path.join(__dirname, relativo), 'utf8'));
      for (const regra of PROIBIDOS) {
        const achado = codigo.match(regra);
        assert.equal(achado, null, `${rotulo}: ${achado && achado[0]}`);
      }
    });
  }
});
