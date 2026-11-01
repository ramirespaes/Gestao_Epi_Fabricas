'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { ErroImportacaoPadrao } = require('../../src/utils/pacote-padrao-erros');
const servico = require('../../src/services/imagem-biblioteca-prontidao.service');

/**
 * Prontidão da biblioteca padrão de imagens (portão de publicação), SEM banco: o importador e o verificador existentes entram por injeção e o disco é um
 * diretório temporário exclusivo. As provas com PostgreSQL e armazenamento reais estão em test/integracao/imagens-prontidao.integration.js.
 */

const { ESTADOS } = servico;
const POSIX = process.platform !== 'win32';
const SO_POSIX = { skip: !POSIX && 'depende de permissões POSIX' };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PASTA_PACOTES = '/pacotes/aprovados';
const POOL = Object.freeze({ connect: async () => { throw new Error('o pool não deveria ser usado diretamente'); } });

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
function novaRaiz() {
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  return raiz;
}
function novoDiretorio(modo = 0o700) {
  const dir = path.join(novaRaiz(), 'imagens');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, modo);
  return dir;
}

const PLANO_PADRAO = [
  { arquivo: 'Pacote_A.zip', sha256: HASH_A, quantidade: 30 },
  { arquivo: 'Pacote_B.zip', sha256: HASH_B, quantidade: 1 },
];
function planoDe(pacotes = PLANO_PADRAO) {
  const bytes = Buffer.from(JSON.stringify({ versao: 1, pacotes }), 'utf8');
  return { bytes, sha256Esperado: sha(bytes) };
}

const resumo = (total, { novas = 0, arquivosNovos = 0 } = {}) => ({ total, novas, existentes: total - novas, arquivosNovos, arquivosPresentes: total * 2 - arquivosNovos, sugestoes: 0 });
const relatorioDeImportacao = (total, extra) => ({ modo: 'SIMULACAO', resumo: resumo(total, extra), itens: [] });
const integro = (extra = {}) => ({
  veredito: 'INTEGRO', alertas: [], resumo: { registros: { padrao: 31, empresa: 0 }, arquivos: { esperados: 62, integros: 62, ausentes: 0, divergentes: 0, naoVerificados: 0 } }, ...extra,
});

/** Dependências injetadas, com registro de chamadas. `porPacote[arquivo]` é o relatório a devolver ou uma função que lança. */
function dependencias({
  porPacote = {}, verificacao = integro(), diretoriosDeArmazenamento = [], fs: fsInjetado, banco = { nome: 'banco_falso', oid: '4242' },
} = {}) {
  const chamadas = { importar: [], verificar: [], identificarBanco: 0, armazenamento: [] };
  const armazenamentoReal = { existe: async () => true, abrir: async () => 'fluxo', gravar: async () => { throw new Error('não deveria gravar no armazenamento real'); } };
  return {
    chamadas,
    deps: {
      importar: async (pool, argumentos) => {
        chamadas.importar.push({ pool, argumentos });
        const arquivo = path.basename(argumentos.pacote);
        const resposta = porPacote[arquivo];
        if (typeof resposta === 'function') return resposta();
        return resposta ?? relatorioDeImportacao(argumentos.quantidadeEsperada);
      },
      verificar: async (pool, argumentos) => { chamadas.verificar.push(argumentos); return verificacao; },
      identificarBanco: async () => { chamadas.identificarBanco += 1; return banco; },
      criarArmazenamento: (argumentos) => { chamadas.armazenamento.push(argumentos); diretoriosDeArmazenamento.push(argumentos.diretorio); return armazenamentoReal; },
      ...(fsInjetado ? { fs: fsInjetado } : {}),
    },
  };
}

const DESTINO = Object.freeze({ banco: 'banco_falso', oid: '4242' });
const obrigatoria = (diretorio, extra = {}) => ({
  ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...(diretorio === null ? {} : { IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio }), ...extra },
  pool: POOL,
  plano: planoDe(),
  pastaPacotes: PASTA_PACOTES,
  destino: DESTINO,
});
const codigos = (relatorio) => relatorio.motivos.map((m) => m.codigo);
const rejeitaCom = async (promessa, codigo) => {
  await assert.rejects(promessa, (erro) => { assert.equal(erro.codigo, codigo, `${erro.codigo}: ${erro.message}`); return true; });
};

describe('política da biblioteca padrão', () => {
  test('exige valor exato: obrigatoria ou desabilitada', () => {
    assert.equal(servico.lerPolitica({ IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }), 'obrigatoria');
    assert.equal(servico.lerPolitica({ IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' }), 'desabilitada');
  });

  test('ausente, vazia, com outra caixa, com espaço ou qualquer outro valor é recusada: a omissão nunca vale como desabilitada', () => {
    for (const valor of [undefined, null, '', ' ', 'Obrigatoria', 'OBRIGATORIA', 'obrigatória', 'desabilitada ', 'true', 'ativo', '1']) {
      assert.throws(() => servico.lerPolitica({ IMAGENS_BIBLIOTECA_PADRAO: valor }), (erro) => erro.codigo === 'IMAGENS_POLITICA_INVALIDA');
    }
    assert.throws(() => servico.lerPolitica({}), (erro) => erro.codigo === 'IMAGENS_POLITICA_INVALIDA');
    assert.throws(() => servico.lerPolitica(null), (erro) => erro.codigo === 'IMAGENS_POLITICA_INVALIDA');
  });

  test('a mensagem de erro nomeia a variável e nunca leva o valor recebido', () => {
    assert.throws(() => servico.lerPolitica({ IMAGENS_BIBLIOTECA_PADRAO: 'segredo-do-operador' }), (erro) => /IMAGENS_BIBLIOTECA_PADRAO/.test(erro.message) && !/segredo/.test(erro.message));
  });
});

describe('biblioteca DESABILITADA intencionalmente', () => {
  test('é aceita sem consultar nada: nem banco, nem pacote, nem diretório, nem plano', async () => {
    const { deps, chamadas } = dependencias();
    const relatorio = await servico.verificarProntidao({ ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' } }, deps);
    assert.equal(relatorio.estado, ESTADOS.DESABILITADA);
    assert.equal(relatorio.politica, 'desabilitada');
    assert.deepEqual(relatorio.motivos, []);
    assert.deepEqual(relatorio.avisos, []);
    assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
    assert.equal(chamadas.identificarBanco, 0);
  });

  test('não depende de IMAGENS_ARMAZENAMENTO_DIRETORIO, de plano nem de pool; diretório configurado vira só um aviso', async () => {
    const { deps } = dependencias();
    const sem = await servico.verificarProntidao({ ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' }, plano: null, pool: undefined }, deps);
    assert.deepEqual(sem.avisos, []);
    const com = await servico.verificarProntidao({ ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada', IMAGENS_ARMAZENAMENTO_DIRETORIO: '/qualquer/coisa' } }, deps);
    assert.equal(com.estado, ESTADOS.DESABILITADA);
    assert.deepEqual(com.avisos, [{ codigo: 'DIRETORIO_CONFIGURADO_COM_BIBLIOTECA_DESABILITADA' }]);
  });

  test('um ambiente sem política NÃO é tratado como desabilitado', async () => {
    const { deps } = dependencias();
    await rejeitaCom(servico.verificarProntidao({ ambiente: {} }, deps), 'IMAGENS_POLITICA_INVALIDA');
  });
});

describe('biblioteca OBRIGATÓRIA: argumentos e plano', () => {
  test('sem plano, é recusada antes de consultar qualquer coisa', async () => {
    const { deps, chamadas } = dependencias();
    await rejeitaCom(servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), plano: null }, deps), 'PLANO_INVALIDO');
    assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
  });

  test('hash do plano diferente do aprovado: PLANO_SHA256_DIVERGENTE, sem tocar banco nem disco', async () => {
    const { deps, chamadas } = dependencias();
    const plano = { ...planoDe(), sha256Esperado: 'f'.repeat(64) };
    await rejeitaCom(servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), plano }, deps), 'PLANO_SHA256_DIVERGENTE');
    assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
  });

  test('plano adulterado (conteúdo mudou, hash aprovado antigo) é recusado', async () => {
    const original = planoDe();
    const adulterado = planoDe([{ arquivo: 'Pacote_A.zip', sha256: HASH_B, quantidade: 30 }]);
    const { deps } = dependencias();
    await rejeitaCom(servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), plano: { bytes: adulterado.bytes, sha256Esperado: original.sha256Esperado } }, deps), 'PLANO_SHA256_DIVERGENTE');
  });

  test('pasta de pacotes relativa ou ausente e pool inválido são recusados', async () => {
    const { deps } = dependencias();
    const base = obrigatoria(novoDiretorio());
    for (const pastaPacotes of [null, undefined, 'relativa/pasta', '', 42]) await rejeitaCom(servico.verificarProntidao({ ...base, pastaPacotes }, deps), 'PACOTE_ARGUMENTOS_INVALIDOS');
    for (const pool of [null, undefined, {}, 'pool']) await rejeitaCom(servico.verificarProntidao({ ...base, pool }, deps), 'PACOTE_ARGUMENTOS_INVALIDOS');
  });
});

describe('biblioteca OBRIGATÓRIA: configuração e diretório', () => {
  test('variável do diretório ausente ou vazia: NAO_PROVISIONADA, sem consultar o banco', async () => {
    for (const valor of [null, '', '   ']) {
      const { deps, chamadas } = dependencias();
      const relatorio = await servico.verificarProntidao(obrigatoria(valor === null ? null : valor), deps);
      assert.equal(relatorio.estado, ESTADOS.NAO_PROVISIONADA);
      assert.deepEqual(codigos(relatorio), ['DIRETORIO_NAO_CONFIGURADO']);
      assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
    }
  });

  test('localização inválida (relativa, com "..", com "//", raiz, nula): INCONSISTENTE, sem consultar nada', async () => {
    for (const valor of ['relativa/pasta', './imagens', '/var/../etc/imagens', '/var//imagens', '/', 'imagens\0x']) {
      const { deps, chamadas } = dependencias();
      const relatorio = await servico.verificarProntidao(obrigatoria(valor), deps);
      assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE, valor);
      assert.deepEqual(codigos(relatorio), ['LOCALIZACAO_DO_DIRETORIO_INVALIDA']);
      assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
    }
  });

  test('o valor inválido nunca aparece no resultado', async () => {
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria('relativa/segredo-do-caminho'), deps);
    assert.doesNotMatch(JSON.stringify(relatorio), /segredo-do-caminho/);
  });

  test('outra configuração de imagens inválida é INCONSISTENTE com código próprio', async () => {
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio(), { IMAGENS_COTA_IMAGENS: 'abc' }), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio), ['CONFIGURACAO_DE_IMAGENS_INVALIDA']);
  });

  test('diretório inexistente: NAO_PROVISIONADA e a verificação NÃO o cria', async () => {
    const dir = path.join(novaRaiz(), 'nao-existe');
    const { deps, chamadas } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(dir), deps);
    assert.equal(relatorio.estado, ESTADOS.NAO_PROVISIONADA);
    assert.deepEqual(codigos(relatorio), ['DIRETORIO_INEXISTENTE']);
    assert.equal(fs.existsSync(dir), false, 'a verificação criou o diretório');
    assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
  });

  test('o caminho é um arquivo, não um diretório: INCONSISTENTE', async () => {
    const arquivo = path.join(novaRaiz(), 'imagens');
    fs.writeFileSync(arquivo, 'x');
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(arquivo), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio), ['DIRETORIO_NAO_E_DIRETORIO']);
  });

  test('o caminho é um link simbólico: INCONSISTENTE, sem seguir o link', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const real = path.join(raiz, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(raiz, 'link');
    fs.symlinkSync(real, link);
    const { deps, chamadas } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(link), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio), ['DIRETORIO_E_LINK_SIMBOLICO']);
    assert.deepEqual(chamadas.importar, []);
  });

  test('um componente do caminho é link simbólico: o caminho não é canônico', SO_POSIX, async () => {
    const raiz = novaRaiz();
    fs.mkdirSync(path.join(raiz, 'real', 'imagens'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(raiz, 'real'), path.join(raiz, 'atalho'));
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(path.join(raiz, 'atalho', 'imagens')), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.ok(codigos(relatorio).includes('DIRETORIO_NAO_CANONICO'));
  });

  test('permissão: 0700 e 0750 (grupo de serviço ou de backup só lê) são aceitos', SO_POSIX, async () => {
    for (const modo of [0o700, 0o750]) {
      const { deps } = dependencias();
      const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio(modo)), deps);
      assert.equal(relatorio.estado, ESTADOS.PROVISIONADA_INTEGRA, `modo ${modo.toString(8)}: ${JSON.stringify(relatorio.motivos)}`);
    }
  });

  test('permissão: acesso de "outros" (0755, 0705, 0701) e escrita de grupo (0770, 0720) são recusados como INCONSISTENTE', SO_POSIX, async () => {
    const casos = [[0o755, 'PERMISSAO_ACESSO_DE_OUTROS'], [0o705, 'PERMISSAO_ACESSO_DE_OUTROS'], [0o701, 'PERMISSAO_ACESSO_DE_OUTROS'], [0o770, 'PERMISSAO_ESCRITA_DO_GRUPO'], [0o720, 'PERMISSAO_ESCRITA_DO_GRUPO']];
    for (const [modo, esperado] of casos) {
      const dir = novoDiretorio(modo);
      const { deps, chamadas } = dependencias();
      const relatorio = await servico.verificarProntidao(obrigatoria(dir), deps);
      assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE, `modo ${modo.toString(8)}`);
      assert.ok(codigos(relatorio).includes(esperado), `modo ${modo.toString(8)}: ${codigos(relatorio)}`);
      assert.deepEqual(chamadas.importar, [], 'não consulta o banco com o diretório inadequado');
      assert.equal(fs.statSync(dir).mode & 0o777, modo, 'a verificação não pode alterar as permissões');
    }
  });

  test('permissão: 0777 acusa os dois problemas', SO_POSIX, async () => {
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio(0o777)), deps);
    assert.deepEqual(codigos(relatorio).sort(), ['PERMISSAO_ACESSO_DE_OUTROS', 'PERMISSAO_ESCRITA_DO_GRUPO']);
  });

  test('o processo sem leitura, escrita ou travessia no diretório: INCONSISTENTE (acesso legítimo do serviço impedido)', async () => {
    const dir = novoDiretorio(0o700);
    const fsSemAcesso = { lstat: fs.promises.lstat, realpath: fs.promises.realpath, access: async () => { throw Object.assign(new Error('negado'), { code: 'EACCES' }); }, constants: fs.constants };
    const { deps, chamadas } = dependencias({ fs: fsSemAcesso });
    const relatorio = await servico.verificarProntidao(obrigatoria(dir), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio), ['PERMISSAO_INSUFICIENTE_PARA_O_PROCESSO']);
    assert.deepEqual(chamadas.importar, []);
  });

  test('falha ao ler o diretório (que não é ausência): INCONSISTENTE com o código do sistema, sem caminho', async () => {
    const dir = novoDiretorio();
    const fsComFalha = { lstat: async () => { throw Object.assign(new Error(`EACCES: ${dir}`), { code: 'EACCES' }); }, realpath: async () => dir, access: async () => {}, constants: fs.constants };
    const { deps } = dependencias({ fs: fsComFalha });
    const relatorio = await servico.verificarProntidao(obrigatoria(dir), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio), ['DIRETORIO_ILEGIVEL:EACCES']);
    assert.equal(JSON.stringify(relatorio).includes(dir), false, 'o caminho vazou no resultado');
  });
});

describe('biblioteca OBRIGATÓRIA: banco, pacotes e arquivos', () => {
  test('banco e diretório AMBOS vazios é falha operacional (NAO_PROVISIONADA), mesmo com o verificador dizendo INTEGRO', async () => {
    const { deps } = dependencias({
      porPacote: {
        'Pacote_A.zip': relatorioDeImportacao(30, { novas: 30, arquivosNovos: 60 }),
        'Pacote_B.zip': relatorioDeImportacao(1, { novas: 1, arquivosNovos: 2 }),
      },
      verificacao: integro({ resumo: { registros: { padrao: 0, empresa: 0 }, arquivos: { esperados: 0, integros: 0, ausentes: 0, divergentes: 0, naoVerificados: 0 } } }),
    });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.armazenamento.veredito, 'INTEGRO', 'o controle: o verificador sozinho aprovaria');
    assert.equal(relatorio.estado, ESTADOS.NAO_PROVISIONADA);
    assert.deepEqual(codigos(relatorio), ['PACOTE_NAO_PROVISIONADO', 'PACOTE_NAO_PROVISIONADO']);
    assert.deepEqual(relatorio.motivos.map((m) => [m.arquivo, m.faltandoRegistro, m.faltandoArquivo]), [['Pacote_A.zip', 30, 60], ['Pacote_B.zip', 1, 2]]);
  });

  test('provisionamento parcial (um pacote completo, outro não): NAO_PROVISIONADA só pelo que falta', async () => {
    const { deps } = dependencias({ porPacote: { 'Pacote_B.zip': relatorioDeImportacao(1, { novas: 1, arquivosNovos: 2 }) } });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.NAO_PROVISIONADA);
    assert.deepEqual(relatorio.motivos.map((m) => m.arquivo), ['Pacote_B.zip']);
    assert.deepEqual(relatorio.pacotes.map((p) => [p.arquivo, p.situacao]), [['Pacote_A.zip', 'PROVISIONADO'], ['Pacote_B.zip', 'INCOMPLETO']]);
  });

  test('registro presente sem arquivo guardado chega do importador como divergência: INCONSISTENTE (o arquivo precisa ser restaurado, não reimportado às cegas)', async () => {
    const divergencia = () => { throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', [{ nome: 'Luva', alvo: 'ARQUIVO', motivo: 'AUSENTE' }]); };
    const { deps } = dependencias({ porPacote: { 'Pacote_A.zip': divergencia } });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(relatorio.pacotes[0].divergencias, [{ nome: 'Luva', alvo: 'ARQUIVO', motivo: 'AUSENTE' }]);
    assert.equal(relatorio.pacotes[0].situacao, 'DIVERGENTE');
  });

  test('divergência de conteúdo (arquivo corrompido, registro de outro pacote, nome em uso): INCONSISTENTE, e os demais pacotes continuam sendo avaliados', async () => {
    const divergencia = () => { throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', [{ nome: 'Luva', alvo: 'ARQUIVO', motivo: 'CONTEUDO_DIVERGENTE' }, { nome: 'Bota', alvo: 'REGISTRO', campo: 'sha256_miniatura', campos: ['sha256_miniatura'] }]); };
    const { deps, chamadas } = dependencias({ porPacote: { 'Pacote_A.zip': divergencia } });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.equal(chamadas.importar.length, 2, 'o segundo pacote também foi avaliado');
    assert.equal(relatorio.pacotes[0].divergenciasTotal, 2);
    assert.deepEqual(relatorio.motivos.map((m) => [m.codigo, m.arquivo, m.divergencias]), [['PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS', 'Pacote_A.zip', 2]]);
  });

  test('o nome vindo da divergência é escapado e as divergências do relatório são limitadas', async () => {
    const muitas = Array.from({ length: 60 }, (_, k) => ({ nome: k === 0 ? 'Luva‮evil\n' : `Item ${k}`, alvo: 'REGISTRO', campo: 'nome' }));
    const { deps } = dependencias({ porPacote: { 'Pacote_A.zip': () => { throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', muitas); } } });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.doesNotMatch(JSON.stringify(relatorio.pacotes[0]), /[‮\n]/);
    assert.equal(relatorio.pacotes[0].divergencias.length, 40);
    assert.equal(relatorio.pacotes[0].divergenciasTotal, 60);
  });

  test('INCONSISTENTE prevalece sobre NAO_PROVISIONADA quando os dois ocorrem', async () => {
    const divergencia = () => { throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', [{ nome: 'Luva', alvo: 'ARQUIVO', motivo: 'CONTEUDO_DIVERGENTE' }]); };
    const { deps } = dependencias({ porPacote: { 'Pacote_A.zip': divergencia, 'Pacote_B.zip': relatorioDeImportacao(1, { novas: 1, arquivosNovos: 2 }) } });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
    assert.deepEqual(codigos(relatorio).sort(), ['PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS', 'PACOTE_NAO_PROVISIONADO']);
  });

  test('biblioteca íntegra: todos os pacotes provisionados e armazenamento íntegro', async () => {
    const { deps, chamadas } = dependencias();
    const dir = novoDiretorio();
    const relatorio = await servico.verificarProntidao(obrigatoria(dir), deps);
    assert.equal(relatorio.estado, ESTADOS.PROVISIONADA_INTEGRA);
    assert.deepEqual(relatorio.motivos, []);
    assert.deepEqual(relatorio.pacotes.map((p) => [p.arquivo, p.imagens, p.situacao]), [['Pacote_A.zip', 30, 'PROVISIONADO'], ['Pacote_B.zip', 1, 'PROVISIONADO']]);
    assert.deepEqual(relatorio.banco, { nome: 'banco_falso', oid: '4242' });
    assert.equal(relatorio.plano.pacotes, 2);
    assert.equal(chamadas.verificar.length, 1);
    assert.equal(chamadas.verificar[0].diretorio, dir);
  });

  test('sobras sem registro (ORFAO) não são dano: continua íntegra', async () => {
    const { deps } = dependencias({ verificacao: integro({ veredito: 'ORFAO' }) });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.PROVISIONADA_INTEGRA);
  });

  test('arquivo ausente de registro íntegro (RECUPERAVEL) ou investigação (INVESTIGAR) do verificador: INCONSISTENTE', async () => {
    for (const veredito of ['RECUPERAVEL', 'INVESTIGAR']) {
      const { deps } = dependencias({ verificacao: integro({ veredito, alertas: [{ codigo: 'RAIZ_ILEGIVEL' }] }) });
      const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
      assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE, veredito);
      assert.deepEqual(codigos(relatorio), [`ARMAZENAMENTO_${veredito}`]);
      assert.deepEqual(relatorio.armazenamento.alertas, ['RAIZ_ILEGIVEL']);
    }
  });

  test('banco vazio com imagens no diretório (verificador INVESTIGAR) é INCONSISTENTE, além de não provisionado', async () => {
    const { deps } = dependencias({
      porPacote: { 'Pacote_A.zip': relatorioDeImportacao(30, { novas: 30, arquivosNovos: 0 }) },
      verificacao: integro({ veredito: 'INVESTIGAR', alertas: [{ codigo: 'BANCO_SEM_REGISTROS_COM_ARQUIVOS' }] }),
    });
    const relatorio = await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(relatorio.estado, ESTADOS.INCONSISTENTE);
  });

  test('o veredito do verificador vale mesmo com todos os pacotes provisionados', async () => {
    const { deps } = dependencias({ verificacao: integro({ veredito: 'INVESTIGAR' }) });
    assert.equal((await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps)).estado, ESTADOS.INCONSISTENTE);
  });
});

describe('biblioteca OBRIGATÓRIA: reaproveitamento do importador', () => {
  test('cada pacote é conferido pela importação em SIMULAÇÃO, com hash e quantidade do plano, nunca com o hash lido do próprio pacote', async () => {
    const { deps, chamadas } = dependencias();
    await servico.verificarProntidao(obrigatoria(novoDiretorio()), deps);
    assert.equal(chamadas.importar.length, 2);
    for (const { pool, argumentos } of chamadas.importar) {
      assert.equal(pool, POOL);
      assert.equal(argumentos.executar, false, 'a prontidão nunca grava');
      assert.deepEqual(argumentos.destinoAutorizado, DESTINO, 'o importador confere o banco na conexão');
      assert.equal(Object.hasOwn(argumentos, 'mapeamento'), false, 'nenhuma sugestão de tipo');
    }
    assert.deepEqual(chamadas.importar.map(({ argumentos: a }) => [a.pacote, a.pacoteSha256Esperado, a.quantidadeEsperada]), [
      [path.join(PASTA_PACOTES, 'Pacote_A.zip'), HASH_A, 30],
      [path.join(PASTA_PACOTES, 'Pacote_B.zip'), HASH_B, 1],
    ]);
  });

  test('a quantidade não é fixa: vem de cada pacote do plano', async () => {
    const { deps, chamadas } = dependencias();
    const pacotes = [{ arquivo: 'P1.zip', sha256: HASH_A, quantidade: 30 }, { arquivo: 'P2.zip', sha256: HASH_B, quantidade: 7 }, { arquivo: 'P3.zip', sha256: 'c'.repeat(64), quantidade: 1 }];
    const relatorio = await servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), plano: planoDe(pacotes) }, deps);
    assert.deepEqual(chamadas.importar.map(({ argumentos }) => argumentos.quantidadeEsperada), [30, 7, 1]);
    assert.equal(relatorio.estado, ESTADOS.PROVISIONADA_INTEGRA);
  });

  test('o destino autorizado segue ao importador, que o confere na conexão antes de qualquer leitura', async () => {
    const { deps, chamadas } = dependencias({ banco: { nome: 'gestao_epi_hml', oid: '16401' } });
    const destino = { banco: 'gestao_epi_hml', oid: '16401' };
    await servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), destino }, deps);
    for (const { argumentos } of chamadas.importar) assert.deepEqual(argumentos.destinoAutorizado, destino);
  });

  test('o armazenamento entregue à importação não consegue gravar, mas lê normalmente', async () => {
    const { deps, chamadas } = dependencias();
    let recebido = null;
    deps.importar = async (pool, argumentos) => { recebido = argumentos.armazenamento; return relatorioDeImportacao(argumentos.quantidadeEsperada); };
    const dir = novoDiretorio();
    await servico.verificarProntidao(obrigatoria(dir), deps);
    assert.deepEqual(chamadas.armazenamento, [{ diretorio: dir }]);
    assert.equal(await recebido.existe('x'), true);
    assert.equal(await recebido.abrir('x'), 'fluxo');
    await assert.rejects(recebido.gravar('x', Buffer.alloc(1), {}), /somente leitura/);
    assert.equal(Object.isFrozen(recebido), true);
  });

  test('as recusas do importador NÃO viram estado: pacote fora do plano, hash divergente, destino não autorizado e falha propagam', async () => {
    for (const codigo of ['PACOTE_INDISPONIVEL', 'PACOTE_SHA256_DIVERGENTE', 'PACOTE_HASH_DIVERGENTE', 'PACOTE_MANIFESTO_INVALIDO', 'DESTINO_NAO_AUTORIZADO', 'IMPORTACAO_FALHOU']) {
      const { deps } = dependencias({ porPacote: { 'Pacote_A.zip': () => { throw new ErroImportacaoPadrao(codigo); } } });
      await rejeitaCom(servico.verificarProntidao(obrigatoria(novoDiretorio()), deps), codigo);
    }
    const { deps } = dependencias({ porPacote: { 'Pacote_A.zip': () => { throw new TypeError('inesperado'); } } });
    await assert.rejects(servico.verificarProntidao(obrigatoria(novoDiretorio()), deps), TypeError);
  });

  test('uma falha do verificador propaga (nunca vira "íntegra")', async () => {
    const { deps } = dependencias();
    deps.verificar = async () => { throw new Error('falha do banco'); };
    await assert.rejects(servico.verificarProntidao(obrigatoria(novoDiretorio()), deps), /falha do banco/);
  });
});

describe('biblioteca OBRIGATÓRIA: identidade do banco', () => {
  test('sem o destino autorizado (nome e OID) a verificação é recusada antes de ler o plano, o disco ou o banco', async () => {
    for (const destino of [undefined, null, 'banco', 42]) {
      const { deps, chamadas } = dependencias();
      const plano = { ...planoDe(), sha256Esperado: 'f'.repeat(64) };
      await rejeitaCom(servico.verificarProntidao({ ...obrigatoria(novoDiretorio()), plano, destino }, deps), 'DESTINO_NAO_AUTORIZADO');
      assert.deepEqual([chamadas.importar, chamadas.verificar, chamadas.armazenamento], [[], [], []]);
      assert.equal(chamadas.identificarBanco, 0);
    }
  });

  test('a exigência vale também quando nada seria consultado (variável do diretório ausente): não há aprovação nem resultado sem a identidade', async () => {
    const { deps } = dependencias();
    await rejeitaCom(servico.verificarProntidao({ ...obrigatoria(null), destino: null }, deps), 'DESTINO_NAO_AUTORIZADO');
  });

  test('banco da conexão com outro nome ou outro OID: recusado, nunca PROVISIONADA_INTEGRA', async () => {
    for (const banco of [{ nome: 'outro_banco', oid: '4242' }, { nome: 'banco_falso', oid: '9999' }, { nome: 'outro_banco', oid: '9999' }]) {
      const { deps } = dependencias({ banco });
      await rejeitaCom(servico.verificarProntidao(obrigatoria(novoDiretorio()), deps), 'DESTINO_NAO_AUTORIZADO');
    }
  });

  test('a recusa por destino diferente também vale quando o importador não confere (defesa em profundidade) e não vaza o nome nem o OID do banco', async () => {
    const { deps } = dependencias({ banco: { nome: 'banco_secreto_do_outro_ambiente', oid: '777777' } });
    await assert.rejects(servico.verificarProntidao(obrigatoria(novoDiretorio()), deps), (erro) => {
      assert.equal(erro.codigo, 'DESTINO_NAO_AUTORIZADO');
      assert.doesNotMatch(JSON.stringify([erro.message, erro.detalhes]), /secreto|777777/);
      return true;
    });
  });

  test('biblioteca desabilitada não exige destino', async () => {
    const { deps } = dependencias();
    const relatorio = await servico.verificarProntidao({ ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' }, destino: null }, deps);
    assert.equal(relatorio.estado, ESTADOS.DESABILITADA);
  });
});

describe('verificação na INICIALIZAÇÃO (guarda npm start, política obrigatoria)', () => {
  const relatorioDe = ({ padrao = 31, empresa = 0, imagens = [], armazenamento = [], alertas = [] } = {}) => ({
    veredito: 'INTEGRO', resumo: { registros: { padrao, empresa } }, imagens, armazenamento, alertas,
  });
  const comVerificador = (relatorio) => {
    const chamadas = [];
    return { chamadas, verificar: async (pool, opcoes) => { chamadas.push({ pool, opcoes }); return relatorio; } };
  };
  const clienteDe = () => { const consultas = []; return { consultas, query: async (...a) => { consultas.push(a); return { rows: [] }; }, end() { throw new Error('a verificação não pode encerrar a conexão da guarda'); } }; };
  const iniciar = (diretorio, relatorio, extra = {}) => {
    const espiao = comVerificador(relatorio);
    const cliente = clienteDe();
    const resposta = servico.verificarParaInicializacao(
      { ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', ...(diretorio === null ? {} : { IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio }) }, cliente, ...extra },
      { verificar: espiao.verificar },
    );
    return { resposta, espiao, cliente };
  };
  const cod = (resultado) => resultado.problemas.map((p) => p.codigo);

  test('biblioteca íntegra (com registros e armazenamento íntegro): nenhum problema e resumo do que foi visto', async () => {
    const dir = novoDiretorio();
    const { resposta, espiao } = iniciar(dir, relatorioDe());
    const r = await resposta;
    assert.deepEqual(r.problemas, []);
    assert.deepEqual(r.resumo, { registrosPadrao: 31, veredito: 'INTEGRO' });
    assert.equal(espiao.chamadas.length, 1);
    assert.equal(espiao.chamadas[0].opcoes.diretorio, dir);
  });

  test('biblioteca AUSENTE: nenhuma imagem padrão registrada (banco e diretório vazios) é problema, mesmo com o verificador dizendo INTEGRO', async () => {
    const { resposta } = iniciar(novoDiretorio(), relatorioDe({ padrao: 0 }));
    const r = await resposta;
    assert.deepEqual(cod(r), ['BIBLIOTECA_IMAGENS_AUSENTE']);
    assert.match(r.problemas[0].mensagem, /imagens:importar-padrao/);
    assert.match(r.problemas[0].mensagem, /imagens:prontidao/);
  });

  test('biblioteca INCONSISTENTE: imagem padrão ou sobra do escopo padrão/raiz com INVESTIGAR ou RECUPERAVEL é problema', async () => {
    for (const [classe, escopo] of [['INVESTIGAR', 'PADRAO'], ['RECUPERAVEL', 'PADRAO']]) {
      const { resposta } = iniciar(novoDiretorio(), relatorioDe({ imagens: [{ escopo, imagemId: '1', classe, achados: [] }] }));
      const r = await resposta;
      assert.deepEqual(cod(r), ['BIBLIOTECA_IMAGENS_INCONSISTENTE'], classe);
      assert.match(r.problemas[0].mensagem, new RegExp(`veredito ${classe}`));
    }
    const sobra = await iniciar(novoDiretorio(), relatorioDe({ armazenamento: [{ escopo: 'PADRAO', classe: 'INVESTIGAR', recente: false, tipo: 'ENTRADA_INESPERADA' }] })).resposta;
    assert.deepEqual(cod(sobra), ['BIBLIOTECA_IMAGENS_INCONSISTENTE']);
    const raiz = await iniciar(novoDiretorio(), relatorioDe({ armazenamento: [{ escopo: 'RAIZ', classe: 'INVESTIGAR', recente: false, tipo: 'ENTRADA_INESPERADA' }] })).resposta;
    assert.deepEqual(cod(raiz), ['BIBLIOTECA_IMAGENS_INCONSISTENTE']);
    const alerta = await iniciar(novoDiretorio(), relatorioDe({ alertas: [{ codigo: 'NENHUM_ARQUIVO_ESPERADO_PRESENTE', classe: 'INVESTIGAR' }] })).resposta;
    assert.deepEqual(cod(alerta), ['BIBLIOTECA_IMAGENS_INCONSISTENTE']);
  });

  test('o pior vence: INVESTIGAR com RECUPERAVEL junto é INVESTIGAR', async () => {
    const r = await iniciar(novoDiretorio(), relatorioDe({ imagens: [{ escopo: 'PADRAO', classe: 'RECUPERAVEL' }, { escopo: 'PADRAO', classe: 'INVESTIGAR' }] })).resposta;
    assert.equal(r.resumo.veredito, 'INVESTIGAR');
  });

  test('ausente e inconsistente ao mesmo tempo (banco vazio com arquivos no diretório): os dois problemas', async () => {
    const r = await iniciar(novoDiretorio(), relatorioDe({ padrao: 0, alertas: [{ codigo: 'BANCO_SEM_REGISTROS_COM_ARQUIVOS', classe: 'INVESTIGAR' }] })).resposta;
    assert.deepEqual(cod(r), ['BIBLIOTECA_IMAGENS_AUSENTE', 'BIBLIOTECA_IMAGENS_INCONSISTENTE']);
  });

  test('NÃO impedem a subida: sobras sem registro, itens recentes e divergência só de imagem de EMPRESA', async () => {
    const r = await iniciar(novoDiretorio(), relatorioDe({
      empresa: 5,
      imagens: [{ escopo: 'EMPRESA', empresaId: 7, imagemId: '9', classe: 'INVESTIGAR' }, { escopo: 'EMPRESA', empresaId: 7, imagemId: '10', classe: 'RECUPERAVEL' }],
      armazenamento: [
        { escopo: 'PADRAO', classe: 'ORFAO', recente: false, tipo: 'ORFAO_CONJUNTO' },
        { escopo: 'PADRAO', classe: 'INVESTIGAR', recente: true, tipo: 'ENTRADA_INESPERADA' },
        { escopo: 'EMPRESA', classe: 'INVESTIGAR', recente: false, tipo: 'ENTRADA_INESPERADA' },
      ],
    })).resposta;
    assert.deepEqual(r.problemas, []);
    assert.equal(r.resumo.veredito, 'INTEGRO');
  });

  test('configuração: diretório não configurado, localização inválida e outra configuração inválida são problemas, sem consultar o banco', async () => {
    const casos = [[null, 'BIBLIOTECA_IMAGENS_DIRETORIO_NAO_CONFIGURADO'], ['relativo/pasta', 'BIBLIOTECA_IMAGENS_LOCALIZACAO_INVALIDA'], ['/', 'BIBLIOTECA_IMAGENS_LOCALIZACAO_INVALIDA']];
    for (const [diretorio, esperado] of casos) {
      const { resposta, espiao } = iniciar(diretorio, relatorioDe());
      assert.deepEqual(cod(await resposta), [esperado], String(diretorio));
      assert.deepEqual(espiao.chamadas, []);
    }
    const invalida = await servico.verificarParaInicializacao(
      { ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', IMAGENS_ARMAZENAMENTO_DIRETORIO: novoDiretorio(), IMAGENS_COTA_IMAGENS: 'abc' }, cliente: clienteDe() },
      { verificar: async () => assert.fail('não deveria verificar') },
    );
    assert.deepEqual(cod(invalida), ['BIBLIOTECA_IMAGENS_CONFIGURACAO_INVALIDA']);
  });

  test('diretório inexistente e diretório inadequado: problemas, sem criar nem alterar o diretório e sem consultar o banco', SO_POSIX, async () => {
    const ausente = path.join(novaRaiz(), 'nao-existe');
    const semDir = iniciar(ausente, relatorioDe());
    assert.deepEqual(cod(await semDir.resposta), ['BIBLIOTECA_IMAGENS_DIRETORIO_INEXISTENTE']);
    assert.equal(fs.existsSync(ausente), false);
    const aberto = novoDiretorio(0o755);
    const inadequado = iniciar(aberto, relatorioDe());
    const r = await inadequado.resposta;
    assert.deepEqual(cod(r), ['BIBLIOTECA_IMAGENS_DIRETORIO_INADEQUADO']);
    assert.match(r.problemas[0].mensagem, /PERMISSAO_ACESSO_DE_OUTROS/);
    assert.equal(fs.statSync(aberto).mode & 0o777, 0o755);
    assert.deepEqual([semDir.espiao.chamadas, inadequado.espiao.chamadas], [[], []]);
  });

  test('as mensagens nunca levam caminho absoluto nem valor de variável', async () => {
    const dir = novoDiretorio(0o755);
    const textos = [
      (await iniciar(dir, relatorioDe()).resposta).problemas,
      (await iniciar(path.join(novaRaiz(), 'inexistente-secreto'), relatorioDe()).resposta).problemas,
      (await iniciar('relativo/segredo', relatorioDe()).resposta).problemas,
    ];
    const tudo = JSON.stringify(textos);
    assert.equal(tudo.includes(dir), false);
    assert.doesNotMatch(tudo, /secreto|segredo|\/private\/|\/tmp\/|\/var\//);
  });

  test('a verificação usa a conexão da guarda por um adaptador, sem abrir transação própria nem encerrá-la', async () => {
    const dir = novoDiretorio();
    const { resposta, espiao, cliente } = iniciar(dir, relatorioDe());
    await resposta;
    const { pool } = espiao.chamadas[0];
    assert.equal(typeof pool.connect, 'function');
    const emprestado = await pool.connect();
    await emprestado.query('SELECT 1', []);
    emprestado.release();
    assert.deepEqual(cliente.consultas, [['SELECT 1', []]]);
  });

  test('cliente inválido é erro de programação, e falha do verificador propaga (falha fechada)', async () => {
    for (const cliente of [undefined, null, {}, 'x']) {
      await assert.rejects(servico.verificarParaInicializacao({ ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }, cliente }), TypeError);
    }
    const dir = novoDiretorio();
    await assert.rejects(
      servico.verificarParaInicializacao({ ambiente: { IMAGENS_ARMAZENAMENTO_DIRETORIO: dir }, cliente: clienteDe() }, { verificar: async () => { throw new Error('falha do banco'); } }),
      /falha do banco/,
    );
  });

  test('sem ZIP, plano nem importador: a verificação de inicialização não os recebe nem os usa', async () => {
    const { resposta, espiao } = iniciar(novoDiretorio(), relatorioDe());
    await resposta;
    assert.deepEqual(Object.keys(espiao.chamadas[0].opcoes).sort(), ['diretorio', 'idadeMinimaOrfaoMinutos']);
  });
});

describe('a prontidão é somente leitura', () => {
  test('o conteúdo do diretório e suas permissões são idênticos antes e depois, em todos os estados', SO_POSIX, async () => {
    const dir = novoDiretorio(0o700);
    fs.mkdirSync(path.join(dir, 'padrao', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'padrao', 'abc', 'mestre.png'), 'x');
    const antes = JSON.stringify([arquivosSob(dir), fs.statSync(dir).mode, fs.statSync(dir).mtimeMs]);
    for (const extra of [{}, { porPacote: { 'Pacote_A.zip': relatorioDeImportacao(30, { novas: 30, arquivosNovos: 60 }) } }, { verificacao: integro({ veredito: 'INVESTIGAR' }) }]) {
      const { deps } = dependencias(extra);
      await servico.verificarProntidao(obrigatoria(dir), deps);
    }
    assert.equal(JSON.stringify([arquivosSob(dir), fs.statSync(dir).mode, fs.statSync(dir).mtimeMs]), antes);
  });
});

describe('.env.example documenta a dependência e a política', () => {
  const dotenv = require('dotenv');
  const TEXTO = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');

  test('a política fica comentada e sem valor, e a dependência obrigatória aponta para o procedimento', () => {
    assert.equal(Object.hasOwn(dotenv.parse(TEXTO), 'IMAGENS_BIBLIOTECA_PADRAO'), false);
    assert.match(TEXTO, /^# IMAGENS_BIBLIOTECA_PADRAO=$/m);
    assert.match(TEXTO, /obrigatoria/);
    assert.match(TEXTO, /desabilitada/);
    assert.match(TEXTO, /OBRIGATÓRIA onde a Biblioteca de Imagens estiver habilitada/);
    assert.match(TEXTO, /backend\/docs\/biblioteca-padrao-imagens-provisionamento\.md/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'docs', 'biblioteca-padrao-imagens-provisionamento.md')), 'o documento apontado precisa existir');
  });
});
