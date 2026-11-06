'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cli = require('../../scripts/backup-operar');
const Pol = require('../../src/services/backup-executor-politica.service');

/**
 * D-ORF-6, integração futura com systemd [SYS]: os MODELOS (`backend/ops/systemd/*.modelo`) são inertes e endurecidos. Este teste só LÊ os arquivos: confere que continuam inertes
 * (marcadores `<...>`, condição de arquivo-chave, sem [Install] nos serviços), que o endurecimento mínimo está presente, que os papéis não se misturam (host do backup x verificador x
 * monitor) e que cada ExecStart, com os marcadores preenchidos, é aceito pela gramática REAL do CLI.
 */

const DIR = path.join(__dirname, '..', '..', 'ops', 'systemd');
const NOMES = ['safework-backup', 'safework-backup-verificador', 'safework-backup-monitor'];
const ler = (nome) => fs.readFileSync(path.join(DIR, nome), 'utf8');
const semComentarios = (texto) => texto.split('\n').filter((l) => !l.startsWith('#') && l.trim() !== '');
function secoes(texto) {
  const saida = {};
  let atual = null;
  for (const l of semComentarios(texto)) {
    const m = /^\[([A-Za-z]+)\]$/.exec(l);
    if (m !== null) { atual = m[1]; saida[atual] = []; } else saida[atual].push(l);
  }
  return saida;
}
const valores = (secao, chave) => secao.filter((l) => l.startsWith(`${chave}=`)).map((l) => l.slice(chave.length + 1));
const unico = (secao, chave) => { const v = valores(secao, chave); assert.equal(v.length, 1, `${chave}: ${v.length} ocorrências`); return v[0]; };

describe('[SYS] inventário e inércia', () => {
  test('SYS-01 — a pasta tem exatamente os seis modelos (serviço e timer de cada papel) e o LEIAME; nenhum arquivo é uma unidade real (.service/.timer)', () => {
    const esperado = [...NOMES.flatMap((n) => [`${n}.service.modelo`, `${n}.timer.modelo`]), 'LEIAME.md'].sort();
    assert.deepEqual(fs.readdirSync(DIR).sort(), esperado);
    for (const f of fs.readdirSync(DIR)) assert.equal(/\.(service|timer)$/.test(f), false, f);
    assert.match(ler('LEIAME.md'), /MODELOS INERTES/);
  });

  test('SYS-02 — inertes: cabeçalho de modelo, marcadores <...> em todo ExecStart e em todo OnCalendar, condição de arquivo-chave no backup e na verificação, e nenhum [Install] nos serviços', () => {
    for (const n of NOMES) {
      const servico = ler(`${n}.service.modelo`);
      const timer = ler(`${n}.timer.modelo`);
      assert.match(servico, /^# MODELO INERTE/);
      assert.match(timer, /^# MODELO INERTE/);
      const s = secoes(servico);
      assert.equal('Install' in s, false, `${n}: serviço sem [Install]`);
      assert.match(unico(s.Service, 'ExecStart'), /<[A-Z_]+>/, `${n}: ExecStart com marcador`);
      assert.match(unico(secoes(timer).Timer, 'OnCalendar'), /^<[A-Z_]+>$/, `${n}: OnCalendar com marcador`);
    }
    for (const n of ['safework-backup', 'safework-backup-verificador']) assert.match(unico(secoes(ler(`${n}.service.modelo`)).Unit, 'ConditionPathExists'), /^\/etc\/safework\/backup-[a-z-]*habilitado$/);
  });
});

describe('[SYS] endurecimento e papéis', () => {
  test('SYS-03 — cada serviço: execução única sem reinício, usuário próprio e comum, umask 077, sem novos privilégios, sistema de arquivos somente leitura exceto caminhos de /var/lib/safework, sem capacidades e sem segredos na unidade', () => {
    for (const n of NOMES) {
      const s = secoes(ler(`${n}.service.modelo`)).Service;
      assert.equal(unico(s, 'Type'), 'oneshot', n);
      assert.equal(unico(s, 'Restart'), 'no', n);
      assert.match(unico(s, 'User'), /^safework-[a-z]+$/, n);
      assert.notEqual(unico(s, 'User'), 'root');
      assert.equal(unico(s, 'UMask'), '0077', n);
      for (const [chave, valor] of [['NoNewPrivileges', 'yes'], ['PrivateTmp', 'yes'], ['PrivateDevices', 'yes'], ['ProtectSystem', 'strict'], ['ProtectHome', 'yes'], ['ProtectKernelTunables', 'yes'], ['ProtectKernelModules', 'yes'],
        ['ProtectControlGroups', 'yes'], ['RestrictSUIDSGID', 'yes'], ['RestrictNamespaces', 'yes'], ['LockPersonality', 'yes'], ['CapabilityBoundingSet', ''], ['SystemCallFilter', '@system-service'], ['SystemCallArchitectures', 'native']]) {
        assert.equal(unico(s, chave), valor, `${n}: ${chave}`);
      }
      assert.match(unico(s, 'MemoryMax'), /^\d+[MG]$/);
      assert.match(unico(s, 'TimeoutStartSec'), /^\d+(min|h)$/);
      for (const caminho of s.filter((l) => l.startsWith('ReadWritePaths=')).flatMap((l) => l.slice(15).split(' '))) assert.match(caminho, /^\/var\/lib\/safework\/[a-z/]+$/, `${n}: ${caminho}`);
      assert.deepEqual(valores(s, 'Environment'), [], `${n}: sem Environment= na unidade`);
      assert.doesNotMatch(ler(`${n}.service.modelo`), /(PASSWORD|SECRET|TOKEN|ACCESS_KEY|CREDENTIAL)/i, n);
      assert.match(unico(s, 'ExecStart'), /^\/usr\/bin\/node \/opt\/safework\/backend\/scripts\/backup-operar\.js --[a-z]+ /);
    }
  });

  test('SYS-04 — papéis separados: o verificador tem usuário, arquivo de ambiente e pasta de evidências próprios (fora do host do backup); o monitor não tem rede nem escrita e só lê as evidências do backup', () => {
    const b = secoes(ler('safework-backup.service.modelo')).Service;
    const v = secoes(ler('safework-backup-verificador.service.modelo')).Service;
    const m = secoes(ler('safework-backup-monitor.service.modelo')).Service;
    assert.equal(new Set([unico(b, 'User'), unico(v, 'User'), unico(m, 'User')]).size, 3);
    assert.notEqual(unico(b, 'EnvironmentFile'), unico(v, 'EnvironmentFile'));
    assert.match(unico(v, 'EnvironmentFile'), /^\/etc\/safework\/backup-verificador\.env$/);
    assert.equal(valores(m, 'EnvironmentFile').length, 0);
    assert.notEqual(unico(b, 'StandardOutput'), unico(v, 'StandardOutput'));
    assert.equal(unico(m, 'PrivateNetwork'), 'yes');
    assert.equal(unico(m, 'RestrictAddressFamilies'), 'AF_UNIX');
    assert.equal(valores(m, 'ReadWritePaths').length, 0);
    const evidencias = unico(b, 'StandardOutput').replace('append:', '');
    assert.equal(unico(m, 'ExecStart').includes(`--evidencias=${evidencias}`), true, 'o monitor lê o arquivo para onde o backup escreve');
    assert.ok(valores(m, 'ReadOnlyPaths').includes(path.dirname(evidencias)));
    assert.match(unico(secoes(ler('safework-backup-monitor.service.modelo')).Unit, 'OnFailure'), /^<UNIDADE_DE_ALERTA>$/);
    assert.equal(valores(b, 'ExecStart')[0].includes('--acao=verificacao-destino'), false);
    assert.equal(valores(v, 'ExecStart')[0].includes('--acao=backup'), false);
  });

  test('SYS-05 — timers: sem recuperação de disparos perdidos, com atraso aleatório e precisão, apontando para o serviço do mesmo nome e habilitáveis só por timers.target', () => {
    for (const n of NOMES) {
      const t = secoes(ler(`${n}.timer.modelo`));
      assert.equal(unico(t.Timer, 'Persistent'), 'false', n);
      assert.match(unico(t.Timer, 'RandomizedDelaySec'), /^\d+min$/);
      assert.match(unico(t.Timer, 'AccuracySec'), /^\d+min$/);
      assert.equal(unico(t.Timer, 'Unit'), `${n}.service`);
      assert.deepEqual(valores(t.Install, 'WantedBy'), ['timers.target']);
    }
  });
});

describe('[SYS] coerência com o CLI', () => {
  test('SYS-06 — cada ExecStart, com os marcadores preenchidos, é aceito pela gramática do CLI (modo, ação e frase corretos); com a frase de OUTRA ação o portão da política bloqueia', () => {
    const preencher = (texto, frase) => texto.replace('<AMBIENTE>', 'HOMOLOGACAO').replace('<ID_DA_FICHA>', 'hml-s3-principal').replace('<FRASE_DE_CONFIRMACAO>', frase).replace('<LIMITE_BACKUP_HORAS>', '26').replace('<LIMITE_VERIFICACAO_HORAS>', '4');
    const argumentos = (nome, frase) => preencher(unico(secoes(ler(`${nome}.service.modelo`)).Service, 'ExecStart'), frase).split(' ').slice(2);
    const backup = cli.interpretarArgumentos(argumentos('safework-backup', Pol.FRASES.OPERACAO.BACKUP));
    assert.deepEqual({ ok: backup.ok, modo: backup.modo, acao: backup.acao, confirmo: backup.confirmo }, { ok: true, modo: 'OPERACAO', acao: 'BACKUP', confirmo: Pol.FRASES.OPERACAO.BACKUP });
    const verificador = cli.interpretarArgumentos(argumentos('safework-backup-verificador', Pol.FRASES.OPERACAO.VERIFICACAO_DESTINO));
    assert.deepEqual({ ok: verificador.ok, modo: verificador.modo, acao: verificador.acao }, { ok: true, modo: 'OPERACAO', acao: 'VERIFICACAO_DESTINO' });
    const monitor = cli.interpretarArgumentos(argumentos('safework-backup-monitor', ''));
    assert.deepEqual({ ok: monitor.ok, modo: monitor.modo, ambiente: monitor.ambiente, backup: monitor.limiteBackupHoras, verificacao: monitor.limiteVerificacaoHoras }, { ok: true, modo: 'MONITORAR', ambiente: 'HOMOLOGACAO', backup: 26, verificacao: 4 });
    const trocada = cli.interpretarArgumentos(argumentos('safework-backup', Pol.FRASES.OPERACAO.VERIFICACAO_DESTINO));
    assert.equal(Pol.avaliarPortoes({ modo: trocada.modo, acao: trocada.acao, ambiente: trocada.ambiente, destinoId: trocada.destino, confirmacao: trocada.confirmo, fatos: { sdk: 'APROVADO', chavesOrigem: 'OPERACIONAL', destinoLocal: 'AUTORIZADO', uid: 501, umask: 0o077 } }).bloqueios.includes('CONFIRMACAO_AUSENTE_OU_INVALIDA'), true);
    assert.equal(Pol.avaliarPortoes({ modo: backup.modo, acao: backup.acao, ambiente: backup.ambiente, destinoId: backup.destino, confirmacao: backup.confirmo, fatos: { sdk: 'APROVADO', chavesOrigem: 'OPERACIONAL', destinoLocal: 'AUTORIZADO', uid: 501, umask: 0o077 } }).bloqueios.includes('OPERACAO_NAO_HABILITADA'), true, 'mesmo preenchido, a operação real continua bloqueada pela constante');
  });
});
