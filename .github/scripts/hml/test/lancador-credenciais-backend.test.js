'use strict';
// Etapa 4C (D-H3): lançador do agente do backend com credenciais temporárias do IAM Roles Anywhere
// (aws_signing_helper credential-process). O s3.js não muda: as credenciais chegam ao processo do agente pelo ambiente,
// só durante a execução, e a nenhum outro lugar. Nada aqui toca a AWS: o helper e o aws são simulados.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../../..');
const LANCADOR = path.join(RAIZ, 'deploy/hml/cd/lancador-credenciais-backend.js');
const L = require(LANCADOR);
const CD = (rel) => path.join(RAIZ, 'deploy/hml/cd', rel);

const CONTA = '111111111111';
const REGIAO = 'us-east-1';
const ANCORA = `arn:aws:rolesanywhere:${REGIAO}:${CONTA}:trust-anchor/0f0f0f0f-1111-2222-3333-444444444444`;
const PERFIL = `arn:aws:rolesanywhere:${REGIAO}:${CONTA}:profile/0e0e0e0e-1111-2222-3333-444444444444`;
const PAPEL = `arn:aws:iam::${CONTA}:role/safework-hml-cd-backend-agente`;
const SEGREDO = 'Sx'.repeat(20);
const TOKEN = `Tk${'Q'.repeat(300)}`;
const MINUTO = 60 * 1000;
const credencial = (extra = {}, agora = Date.now()) => ({ Version: 1, AccessKeyId: 'ASIAQWERTYUIOPASDFGH', SecretAccessKey: SEGREDO, SessionToken: TOKEN, Expiration: new Date(agora + 2 * 60 * MINUTO).toISOString(), ...extra });

let tmp;
let nodeEnvAntes;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hml-lanc-')));
  nodeEnvAntes = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  if (nodeEnvAntes === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnvAntes;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Ambiente do teste: helper simulado (responde o que estiver em resposta.json), certificado, chave 0400 e a
// configuração oficial de teste (mesmas conferências do leitor C1, dono = usuário do teste).
function ambiente({ resposta = credencial(), secao = {}, cfgExtra = {} } = {}) {
  const dir = path.join(tmp, 'amb');
  fs.mkdirSync(dir, { mode: 0o755 });
  const respostaArq = path.join(dir, 'resposta.json');
  fs.writeFileSync(respostaArq, typeof resposta === 'string' ? resposta : JSON.stringify(resposta));
  const chamadasArq = path.join(dir, 'chamadas.ndjson');
  const helper = path.join(dir, 'aws_signing_helper');
  fs.writeFileSync(helper, [
    `#!${process.execPath}`,
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(chamadasArq)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');`,
    `process.stdout.write(fs.readFileSync(${JSON.stringify(respostaArq)}, 'utf8'));`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.chmodSync(helper, 0o755);
  const certificado = path.join(dir, 'agente-backend.crt');
  fs.writeFileSync(certificado, 'CERTIFICADO-SIMULADO\n', { mode: 0o644 });
  fs.chmodSync(certificado, 0o644);
  const chave = path.join(dir, 'agente-backend.chave');
  fs.writeFileSync(chave, 'CHAVE-SIMULADA\n', { mode: 0o400 });
  fs.chmodSync(chave, 0o400);
  const credenciais = { executavel: helper, certificado, chave, ancora: ANCORA, perfil: PERFIL, papel: PAPEL, duracaoSegundos: 7200, ...secao };
  const cfg = { habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND', s3: { bucket: 'hml-exemplo-teste', conta: CONTA, regiao: REGIAO, executavel: '/usr/local/bin/aws', prefixo: 'hml-backend' }, credenciais, ...cfgExtra };
  const oficialDir = path.join(tmp, 'oficial');
  fs.mkdirSync(oficialDir, { mode: 0o755 });
  const caminho = path.join(oficialDir, 'agente-backend.json');
  fs.writeFileSync(caminho, JSON.stringify(cfg), { mode: 0o640 });
  fs.chmodSync(caminho, 0o640);
  const chamadas = () => (fs.existsSync(chamadasArq) ? fs.readFileSync(chamadasArq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, helper, certificado, chave, credenciais, cfg, caminho, chamadas, respostaArq };
}
const recusa = (codigo) => (e) => e.codigo === codigo;

describe('4C (D-H3): validação das credenciais temporárias', () => {
  const agora = Date.parse('2026-11-22T12:00:00.000Z');
  test('aceita credencial temporária válida, com folga suficiente', () => {
    const c = credencial({}, agora);
    assert.deepEqual(L.validarCredenciais(JSON.stringify(c), agora), { AccessKeyId: c.AccessKeyId, SecretAccessKey: SEGREDO, SessionToken: TOKEN, Expiration: c.Expiration });
  });
  test('recusa expirada, com validade insuficiente para a operação e com expiração fora da faixa', () => {
    assert.throws(() => L.validarCredenciais(JSON.stringify(credencial({ Expiration: new Date(agora - 1000).toISOString() }, agora)), agora), recusa('CREDENCIAL_EXPIRADA'));
    assert.throws(() => L.validarCredenciais(JSON.stringify(credencial({ Expiration: new Date(agora).toISOString() }, agora)), agora), recusa('CREDENCIAL_EXPIRADA'));
    assert.throws(() => L.validarCredenciais(JSON.stringify(credencial({ Expiration: new Date(agora + 59 * MINUTO).toISOString() }, agora)), agora), recusa('VALIDADE_INSUFICIENTE'));
    assert.doesNotThrow(() => L.validarCredenciais(JSON.stringify(credencial({ Expiration: new Date(agora + 60 * MINUTO).toISOString() }, agora)), agora));
    assert.throws(() => L.validarCredenciais(JSON.stringify(credencial({ Expiration: new Date(agora + 13 * 60 * MINUTO).toISOString() }, agora)), agora), recusa('EXPIRACAO_FORA_DA_FAIXA'));
  });
  test('recusa credencial permanente (AKIA) e credencial incompleta ou fora do formato', () => {
    assert.throws(() => L.validarCredenciais(JSON.stringify(credencial({ AccessKeyId: 'AKIAQWERTYUIOPASDFGH' }, agora)), agora), recusa('CREDENCIAL_PERMANENTE'));
    const invalidas = [
      '', 'não é json', 'null', '[]', '1',
      JSON.stringify((({ SessionToken, ...r }) => r)(credencial({}, agora))),
      JSON.stringify((({ SecretAccessKey, ...r }) => r)(credencial({}, agora))),
      JSON.stringify((({ Expiration, ...r }) => r)(credencial({}, agora))),
      JSON.stringify(credencial({ SessionToken: '' }, agora)),
      JSON.stringify(credencial({ Version: 2 }, agora)),
      JSON.stringify(credencial({ AccessKeyId: 'ASIA123' }, agora)),
      JSON.stringify(credencial({ SecretAccessKey: 'curto' }, agora)),
      JSON.stringify(credencial({ Expiration: 'amanhã' }, agora)),
      JSON.stringify(credencial({ Extra: 'x' }, agora)),
    ];
    for (const texto of invalidas) assert.throws(() => L.validarCredenciais(texto, agora), recusa('CREDENCIAL_INVALIDA'), texto.slice(0, 60));
  });
});

describe('4C (D-H3): seção credenciais da configuração oficial', () => {
  test('aceita a seção própria do CD backend', () => {
    const amb = ambiente();
    assert.doesNotThrow(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }));
  });
  test('recusa seção ausente, caminhos relativos, ARNs inválidos, conta ou região divergentes, papel que não é o do backend e duração fora da faixa', () => {
    const amb = ambiente();
    const variacoes = [
      undefined, null, {},
      { executavel: 'aws_signing_helper' }, { certificado: 'x.crt' }, { chave: 'x.key' },
      { ancora: 'arn:aws:rolesanywhere:us-east-1:111111111111:profile/0f0f0f0f-1111-2222-3333-444444444444' },
      { perfil: ANCORA }, { papel: 'arn:aws:iam::111111111111:user/alguem' },
      { ancora: ANCORA.replace(CONTA, '222222222222') }, { perfil: PERFIL.replace(CONTA, '222222222222') }, { papel: PAPEL.replace(CONTA, '222222222222') },
      { perfil: PERFIL.replace(REGIAO, 'sa-east-1') },
      { papel: `arn:aws:iam::${CONTA}:role/safework-hml-agente` }, { papel: `arn:aws:iam::${CONTA}:role/safework-hml-cd-backend-dorf6` },
      { papel: `arn:aws:iam::${CONTA}:role/safework-hml-cd-backend-frontend` },
      { duracaoSegundos: 3599 }, { duracaoSegundos: 43201 }, { duracaoSegundos: '7200' }, { extra: true },
    ];
    for (const v of variacoes) {
      const secao = v === undefined || v === null || Object.keys(v).length === 0 ? v : { ...amb.credenciais, ...v };
      assert.throws(() => L.validarSecaoDeCredenciais({ ...amb.cfg, credenciais: secao }, { uidDono: process.getuid() }), recusa('CREDENCIAIS_NAO_CONFIGURADAS'), JSON.stringify(v));
    }
  });
  test('recusa chave legível por grupo ou outros, chave por link simbólico, chave com dois links físicos e helper ou certificado graváveis por outros', () => {
    for (const modo of [0o440, 0o404, 0o600 | 0o040]) {
      const amb = ambiente();
      fs.chmodSync(amb.chave, modo);
      assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), modo.toString(8));
      fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    }
    let amb = ambiente();
    const real = `${amb.chave}.real`;
    fs.renameSync(amb.chave, real);
    fs.symlinkSync(real, amb.chave);
    assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), 'link simbólico');
    fs.rmSync(amb.chave);
    fs.linkSync(real, amb.chave);
    assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), 'dois links físicos');
    fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    amb = ambiente();
    fs.chmodSync(amb.helper, 0o757);
    assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), 'helper gravável');
    fs.chmodSync(amb.helper, 0o755);
    fs.chmodSync(amb.certificado, 0o666);
    assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), 'certificado gravável');
    fs.chmodSync(amb.certificado, 0o644);
    assert.throws(() => L.validarSecaoDeCredenciais(amb.cfg, { uidDono: process.getuid() + 1 }), recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO'), 'helper de outro dono');
  });
});

describe('4C (D-H3): principal do lançador', () => {
  const ESPERADO_HELPER = (amb) => ['credential-process', '--certificate', amb.certificado, '--private-key', amb.chave, '--trust-anchor-arn', ANCORA, '--profile-arn', PERFIL, '--role-arn', PAPEL, '--session-duration', '7200'];
  function agenteFalso(codigo = 0) {
    const chamadas = [];
    return { chamadas, iniciarAgente: async (argv, env) => { chamadas.push({ argv, env }); return codigo; } };
  }

  test('sucesso: chama o helper com os argumentos da seção e ambiente mínimo, e inicia o agente só com PATH, HOME e as três variáveis AWS', async () => {
    const amb = ambiente();
    const ag = agenteFalso(0);
    assert.equal(await L.principal(['--config', amb.caminho, '--pendentes'], { iniciarAgente: ag.iniciarAgente }), 0);
    const [h] = amb.chamadas();
    assert.deepEqual(h.argv, ESPERADO_HELPER(amb));
    assert.deepEqual(Object.keys(h.env).filter((k) => !/^(__CF_USER_TEXT_ENCODING|LC_CTYPE)$/.test(k)).sort(), ['PATH'], 'o helper não recebe outra variável');
    assert.equal(ag.chamadas.length, 1);
    assert.deepEqual(ag.chamadas[0].argv, ['--config', amb.caminho, '--pendentes']);
    assert.deepEqual(Object.keys(ag.chamadas[0].env).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'HOME', 'NODE_ENV', 'PATH']);
    assert.equal(ag.chamadas[0].env.NODE_ENV, 'test', 'só no modo de teste o NODE_ENV acompanha');
    assert.equal(ag.chamadas[0].env.AWS_SECRET_ACCESS_KEY, SEGREDO);
    assert.equal(await L.principal(['--config', amb.caminho, '--pedido', '12-1'], { iniciarAgente: ag.iniciarAgente }), 0);
    assert.deepEqual(ag.chamadas[1].argv, ['--config', amb.caminho, '--pedido', '12-1']);
  });

  // Correção B (B2): o encerramento auditável de um CRITICO precisa das mesmas credenciais temporárias do agente; o
  // lançador aceita `--resolver-critico <id>` e o repassa sem alteração, com o mesmo helper e o mesmo ambiente mínimo.
  test('--resolver-critico <id>: chama o helper uma vez e inicia o agente com os argumentos idênticos e o ambiente mínimo', async () => {
    const amb = ambiente();
    const ag = agenteFalso(1);
    const argv = ['--config', amb.caminho, '--resolver-critico', '45240585273-1'];
    assert.equal(await L.principal(argv, { iniciarAgente: ag.iniciarAgente }), 1, 'o código do agente (TRAVA_LEGADA_PRESERVADA sai com 1) chega ao lançador');
    assert.equal(amb.chamadas().length, 1);
    assert.deepEqual(amb.chamadas()[0].argv, ESPERADO_HELPER(amb));
    assert.equal(ag.chamadas.length, 1);
    assert.deepEqual(ag.chamadas[0].argv, argv);
    assert.deepEqual(Object.keys(ag.chamadas[0].env).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'HOME', 'NODE_ENV', 'PATH']);
    const { env } = ag.chamadas[0];
    assert.deepEqual([env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN], ['ASIAQWERTYUIOPASDFGH', SEGREDO, TOKEN], 'os valores efetivos são os da credencial do helper');
  });

  test('--resolver-critico fora da forma exata é USO, sem chamar o helper nem iniciar o agente', async () => {
    const ID = '45240585273-1';
    for (const montar of [
      (c) => ['--config', c, '--resolver-critico'],
      (c) => ['--config', c, '--resolver-critico', ID, 'extra'],
      (c) => ['--config', c, '--resolver-critico', ID, '--pendentes'],
      (c) => ['--config', c, '--resolver-critico', ID, '--pedido', ID],
      (c) => ['--config', c, '--pendentes', '--resolver-critico', ID],
      (c) => ['--resolver-critico', ID, '--config', c],
      (c) => ['--config', c, '--resolver', ID],
      (c) => ['--config', c, '--resolver-critico=' + ID],
      (c) => ['--config', c, '--resolver-critico', 45240585273],
      (c) => ['--config', c, '--RESOLVER-CRITICO', ID],
      (c) => ['--config', c, '--resolver-critico ', ID],
      (c) => ['--config', c, ' --resolver-critico', ID],
      (c) => ['--config', c, '--pendentes', 'extra'],
      (c) => ['--config', c, '--pendentes', ID, 'extra'],
      (c) => ['--x', c, '--resolver-critico', ID],
      (c) => ['--x', c, '--pendentes'],
      (c) => [c, '--config', '--resolver-critico', ID],
      (c) => ['--config', Buffer.from(c), '--resolver-critico', ID],
      (c) => ['--config', { toString: () => c }, '--pendentes'],
      (c) => ({ 0: '--config', 1: c, 2: '--resolver-critico', 3: ID, length: 4 }),
      (c) => ({ 0: '--config', 1: c, 2: '--pendentes', length: 3 }),
      (c) => `--config ${c} --resolver-critico ${ID}`,
    ]) {
      const amb = ambiente();
      const ag = agenteFalso(0);
      const argv = montar(amb.caminho);
      await assert.rejects(L.principal(argv, { iniciarAgente: ag.iniciarAgente }), recusa('USO'), JSON.stringify(argv));
      assert.equal(amb.chamadas().length, 0, `${JSON.stringify(argv)}: o helper não foi chamado`);
      assert.equal(ag.chamadas.length, 0, `${JSON.stringify(argv)}: o agente não foi iniciado`);
      fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    }
  });

  test('o código de saída do agente é o do lançador', async () => {
    const amb = ambiente();
    assert.equal(await L.principal(['--config', amb.caminho, '--pendentes'], { iniciarAgente: agenteFalso(3).iniciarAgente }), 3);
  });

  test('falhas antes do agente: nada é iniciado e nenhum recibo pode ser publicado', async () => {
    const agora = Date.now();
    const casos = [
      ['USO', () => ambiente(), ['--pendentes']],
      ['USO', () => ambiente(), ['--config']],
      ['USO', () => ambiente(), ['--config', 'x', '--pedido']],
      ['AGENTE_DESABILITADO', () => ambiente({ cfgExtra: { habilitado: false } }), null],
      ['AGENTE_DESABILITADO', () => ambiente({ cfgExtra: { isolamentoRevisado: 'PENDENTE' } }), null],
      ['CREDENCIAIS_NAO_CONFIGURADAS', () => ambiente({ cfgExtra: { credenciais: undefined } }), null],
      ['VALIDADE_INSUFICIENTE', () => ambiente({ resposta: credencial({ Expiration: new Date(agora + 30 * MINUTO).toISOString() }) }), null],
      ['CREDENCIAL_EXPIRADA', () => ambiente({ resposta: credencial({ Expiration: new Date(agora - MINUTO).toISOString() }) }), null],
      ['CREDENCIAL_PERMANENTE', () => ambiente({ resposta: credencial({ AccessKeyId: 'AKIAQWERTYUIOPASDFGH' }) }), null],
      ['CREDENCIAL_INVALIDA', () => ambiente({ resposta: 'sem json' }), null],
    ];
    for (const [codigo, montar, argv] of casos) {
      const amb = montar();
      const ag = agenteFalso(0);
      await assert.rejects(L.principal(argv || ['--config', amb.caminho, '--pendentes'], { iniciarAgente: ag.iniciarAgente }), recusa(codigo), codigo);
      assert.equal(ag.chamadas.length, 0, `${codigo}: o agente não foi iniciado`);
      fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    }
  });

  test('helper indisponível, com falha ou que não termina no prazo: HELPER_INDISPONIVEL sem iniciar o agente', async () => {
    for (const preparar of [
      (amb) => fs.rmSync(amb.helper),
      (amb) => fs.writeFileSync(amb.helper, `#!${process.execPath}\nprocess.exit(3);\n`),
      (amb) => fs.writeFileSync(amb.helper, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`),
    ]) {
      const amb = ambiente();
      preparar(amb);
      const ag = agenteFalso(0);
      await assert.rejects(L.principal(['--config', amb.caminho, '--pendentes'], { iniciarAgente: ag.iniciarAgente, prazoDoHelperMs: 1500 }), (e) => e.codigo === 'HELPER_INDISPONIVEL' || e.codigo === 'ARQUIVO_DE_IDENTIDADE_INSEGURO');
      assert.equal(ag.chamadas.length, 0);
      fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    }
  });

  test('recusa iniciar com qualquer variável AWS_ no próprio ambiente: nenhuma credencial vem de fora do helper', async () => {
    const amb = ambiente();
    const ag = agenteFalso(0);
    process.env.AWS_ACCESS_KEY_ID = 'AKIAQWERTYUIOPASDFGH';
    try {
      await assert.rejects(L.principal(['--config', amb.caminho, '--pendentes'], { iniciarAgente: ag.iniciarAgente }), recusa('AMBIENTE_COM_CREDENCIAL'));
    } finally { delete process.env.AWS_ACCESS_KEY_ID; }
    assert.equal(amb.chamadas().length, 0, 'o helper nem foi chamado');
    assert.equal(ag.chamadas.length, 0);
  });

  test('fora do modo de teste, só a configuração oficial é aceita', async () => {
    delete process.env.NODE_ENV;
    await assert.rejects(L.principal(['--config', path.join(tmp, 'qualquer.json'), '--pendentes'], { iniciarAgente: agenteFalso(0).iniciarAgente }), recusa('CONFIG_NAO_OFICIAL'));
  });
});

describe('4C (D-H3): linha de comando sem vazamento', () => {
  // O lançador real em processo filho. No Linux o agente real é iniciado diante de um aws simulado sem pedidos (fila
  // vazia, saída 0) e o aws registra o ambiente recebido; fora do Linux o agente recusa com LINUX_OBRIGATORIO.
  function rodar(amb, argv = ['--config', amb.caminho, '--pendentes']) {
    const r = spawnSync(process.execPath, [LANCADOR, ...argv], { env: { PATH: process.env.PATH, HOME: os.homedir(), NODE_ENV: 'test' }, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, saida: `${r.stdout}\n${r.stderr}` };
  }
  test('recusas e sucesso nunca imprimem chave, segredo, token, certificado ou chave privada', () => {
    const agora = Date.now();
    for (const resposta of [credencial({ Expiration: new Date(agora + 10 * MINUTO).toISOString() }), credencial({ AccessKeyId: 'AKIAQWERTYUIOPASDFGH' }), credencial({ Extra: SEGREDO })]) {
      const amb = ambiente({ resposta });
      const r = rodar(amb);
      assert.equal(r.status, 1);
      assert.match(r.saida, /Lançador do backend recusou: [A-Z_]+/);
      for (const proibido of [SEGREDO, TOKEN.slice(0, 40), 'AKIAQWERTYUIOPASDFGH', 'ASIAQWERTYUIOPASDFGH', 'CHAVE-SIMULADA', 'CERTIFICADO-SIMULADO']) assert.ok(!r.saida.includes(proibido), `não imprime ${proibido.slice(0, 8)}…`);
      fs.rmSync(path.join(tmp, 'amb'), { recursive: true, force: true }); fs.rmSync(path.join(tmp, 'oficial'), { recursive: true, force: true });
    }
    const amb = ambiente({ cfgExtra: {} });
    const r = rodar(amb);
    for (const proibido of [SEGREDO, TOKEN.slice(0, 40), 'ASIAQWERTYUIOPASDFGH', 'CHAVE-SIMULADA']) assert.ok(!r.saida.includes(proibido));
    // A configuração mínima deste teste não habilita o agente real: ele recusa por conta própria, depois do lançador.
    assert.equal(r.status, 1);
    assert.match(r.saida, process.platform === 'linux' ? /Agente do backend recusou: [A-Z_]+/ : /Agente do backend recusou: LINUX_OBRIGATORIO/);
    assert.doesNotMatch(r.saida, /Lançador do backend recusou/);
  });
  test('o lançador não grava arquivos: o diretório da configuração e o da identidade continuam iguais', () => {
    const amb = ambiente();
    const antes = [fs.readdirSync(amb.dir).sort(), fs.readdirSync(path.dirname(amb.caminho)).sort()];
    rodar(amb);
    const depois = [fs.readdirSync(amb.dir).filter((n) => n !== 'chamadas.ndjson').sort(), fs.readdirSync(path.dirname(amb.caminho)).sort()];
    assert.deepEqual(depois, [antes[0].filter((n) => n !== 'chamadas.ndjson'), antes[1]]);
  });
});

describe('4C (D-H3): invariantes do lançador', () => {
  const fonte = () => fs.readFileSync(LANCADOR, 'utf8');
  test('usa credential-process (não o serve), sem shell, sem gravar arquivos e sem carregar o agente, o s3.js ou o provedor', () => {
    const f = fonte();
    assert.match(f, /'credential-process'/);
    assert.doesNotMatch(f, /'serve'|shell:\s*true|execSync|writeFile|appendFile|createWriteStream|console\.log/);
    assert.doesNotMatch(f, /require\(['"]\.\/(agente-backend|s3|coordenacao-por-guardiao|protocolo)['"]\)/);
    assert.match(f, /require\('\.\/executor-com-prazo'\)/);
  });
  test('o único texto escrito é o código da recusa', () => {
    const f = fonte();
    const escritas = f.split('\n').filter((l) => /console\.|process\.(stdout|stderr)\.write/.test(l)).map((l) => l.trim());
    assert.deepEqual(escritas, ['console.error(`Lançador do backend recusou: ${codigoSeguro(e)}`);']);
  });
});

describe('4C (D-H3): modelos inertes da unidade, do timer e do Roles Anywhere', () => {
  test('unidade do agente: usuário próprio, endurecida, sem credencial no ambiente e sem esconder /proc', () => {
    const u = fs.readFileSync(CD('safework-cd-backend.service.modelo'), 'utf8');
    assert.match(u, /INERTE/);
    assert.match(u, /^User=USUARIO_DO_AGENTE_BACKEND$/m);
    assert.match(u, /^Type=oneshot$/m);
    assert.match(u, /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/safework-cd\/cd\/lancador-credenciais-backend\.js --config \/etc\/safework\/cd\/agente-backend\.json --pendentes$/m);
    for (const diretiva of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'UMask=0077']) assert.match(u, new RegExp(`^${diretiva}$`, 'm'), diretiva);
    assert.match(u, /^ReadWritePaths=BASE_DO_CD_BACKEND ESTADO_DO_AGENTE_BACKEND$/m);
    assert.doesNotMatch(u, /^(Environment|EnvironmentFile|PassEnvironment|LoadCredential|SetCredential)=/m);
    assert.doesNotMatch(u, /ProtectProc=invisible|AmbientCapabilities|CapabilityBoundingSet=.*SYS_PTRACE|AWS_/);
  });
  // Fase 1 (cache do npm): o npm ci do instalador grava cache e logs em $HOME/.npm. Com ProtectSystem=strict e
  // ProtectHome=yes, o único lugar gravável a mais é o CacheDirectory dedicado, que é o home do usuário do agente.
  test('cache do npm: diretório de cache dedicado (0700) e nada mais gravável; ProtectSystem e ProtectHome mantidos', () => {
    const u = fs.readFileSync(CD('safework-cd-backend.service.modelo'), 'utf8');
    assert.match(u, /^CacheDirectory=safework-cd-backend$/m);
    assert.match(u, /^CacheDirectoryMode=0700$/m);
    assert.equal((u.match(/^ReadWritePaths=/gm) || []).length, 1, 'uma única linha de escrita explícita');
    assert.match(u, /^ReadWritePaths=BASE_DO_CD_BACKEND ESTADO_DO_AGENTE_BACKEND$/m, 'o cache não entra nos caminhos graváveis explícitos');
    assert.doesNotMatch(u, /^(StateDirectory|LogsDirectory|RuntimeDirectory|ConfigurationDirectory)=/m, 'nenhum outro diretório gerenciado');
    assert.doesNotMatch(u, /^ProtectHome=(no|read-only|tmpfs)$/m);
    assert.match(u, /home do usuário do agente é \/var\/cache\/safework-cd-backend/, 'o modelo documenta o home dedicado');
  });
  test('timer do agente: só dispara a unidade do backend', () => {
    const t = fs.readFileSync(CD('safework-cd-backend.timer.modelo'), 'utf8');
    assert.match(t, /INERTE/);
    assert.match(t, /^Unit=safework-cd-backend\.service$/m);
    assert.match(t, /^OnUnitInactiveSec=/m);
  });
  test('confiança do papel: só o Roles Anywhere, só a âncora do backend e o CN do certificado do backend', () => {
    const c = JSON.parse(fs.readFileSync(CD('iam-confianca-rolesanywhere-backend.modelo.json'), 'utf8'));
    assert.equal(c.Statement.length, 1);
    const s = c.Statement[0];
    assert.deepEqual(s.Principal, { Service: 'rolesanywhere.amazonaws.com' });
    assert.deepEqual([...s.Action].sort(), ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession']);
    assert.equal(s.Condition.ArnEquals['aws:SourceArn'], 'arn:aws:rolesanywhere:REGIAO:CONTA:trust-anchor/ANCORA_DO_CD_BACKEND');
    assert.equal(s.Condition.StringEquals['aws:PrincipalTag/x509Subject/CN'], 'safework-hml-cd-backend-agente');
  });
  test('perfil: só o papel do backend e duração de 2 horas', () => {
    const p = JSON.parse(fs.readFileSync(CD('rolesanywhere-perfil-backend.modelo.json'), 'utf8'));
    assert.deepEqual(p.roleArns, ['arn:aws:iam::CONTA:role/safework-hml-cd-backend-agente']);
    assert.equal(p.durationSeconds, 7200);
    assert.equal(p.requireInstanceProperties, false);
    assert.doesNotMatch(JSON.stringify(p), /d-?orf|frontend|publicador|hml\//i);
  });
});
