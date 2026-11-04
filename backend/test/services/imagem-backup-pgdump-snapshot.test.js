'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');
const { SAIDAS } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-PGDUMP-SNAPSHOT-1): vinculação CONFIÁVEL do `pg_dump` ao snapshot PostgreSQL aberto na MESMA
 * operação. Só unitário e em memória: cliente PostgreSQL, trava, lançador de processo, sistema de sinais/grupo, arquivos e relógios são falsos; nenhum
 * PostgreSQL, spawn, pg_dump, pg_restore, sinal ou arquivo reais. Sincronização por promessas controladas; cada teste tem prazo próprio.
 *
 * CONTRATO REAL CONFIRMADO (lido no código, não inventado):
 *   - `abrir()` do snapshot devolve `{ ok: true, contexto }` congelado em profundidade: `{ snapshotId, banco: { nome, oid }, registros, plano }`;
 *     `snapshotId` segue /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/; `banco.nome`/`banco.oid` vêm de `current_database()` e de `pg_database.oid::text`
 *     na MESMA conexão do snapshot (`identificarBanco`), então `oid` existe e é string numérica (/^[1-9][0-9]{0,9}$/).
 *   - o supervisor consome `{ iniciar, grupo: { vivos(pgid) }, sinais: { enviar(pgid, sinal) }, temporizador: { prazo, intervalo }, prazos: { totalMs,
 *     cortesiaMs, intervaloGrupoMs, tentativasGrupo, consultaGrupoMs }, parada?, repassarParada? }`; `iniciar()` devolve `{ pgid, saida, fluxosFechados }`
 *     (promessas); `liberarTravaPermitido` exige término confirmado, fluxos fechados E grupo confirmado vazio; o `exit` isolado não prova nada.
 *   - a entrada operacional atual (`executarBackupOperacional`) NÃO muda: o chamador ainda fornece `processoDoDump(contexto)`.
 *
 * INTERFACE PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado nesta fase):
 *   src/services/imagem-backup-pgdump.service.js exporta:
 *   1. `criarProcessoDoDump({ contexto, dump })` -> descrição para o supervisor `{ iniciar, grupo, sinais, temporizador, prazos }` (e mais nada).
 *      Síncrona e SEM efeito colateral (não cria arquivo nem processo); lança TypeError se o contexto ou o `dump` forem inválidos.
 *   2. `executarBackupPgDump(dependencias)` -> a composição confiável (D0): reutiliza `executarBackupOperacional`, mas o `processoDoDump` é SEMPRE o
 *      construtor acima, alimentado só pelo contexto do snapshot aberto nesta operação. Dependências ESTRITAS:
 *        { janela, conexao, dump, copia, avaliar, parada? }   (nunca `processoDoDump`, `snapshot`, `finalizar`, `supervisionar`, `etapas`, `contexto`)
 *        dump = { alvo, destino, lancador, sistema, arquivos, temporizador, prazos }       (também ESTRITO)
 *          alvo     = { executavel, host, porta, usuario, arquivoDeSenha, bancoEsperado: { nome, oid } }   (nenhuma senha em lugar nenhum)
 *          destino  = { diretorio, nome }                    caminho absoluto sem `..`; nome simples
 *          lancador = { lancar(spec) -> Promise<{ pid, saida, fluxosFechados }> }
 *          sistema  = { grupoVivo(pgid), enviarSinal(pgid, sinal) }
 *          arquivos = { criarExclusivo({ diretorio, nome, modo: 0o600, semSeguirLinks: true }) -> Promise<{ descritor, fechar() }> }
 *        spec do lançador = { executavel, argumentos, ambiente, opcoes: { shell: false, detached: true, stdio: ['ignore', descritor, 'ignore'] } }
 *        (o dump escreve em STDOUT para o arquivo criado de forma EXCLUSIVA; stderr é ignorado: nenhum texto bruto pode vazar).
 *   Decisões aplicadas: D0 composição separada; D1 recusa depois do snapshot aberto RETÉM a trava (conservador); D2 identidade = nome E oid conferidos
 *   com o contexto; D3 PGPASSFILE, ambiente em lista fechada; D4 sem --jobs; D5 saída exclusiva 0600 sem seguir links e sem stderr; D6 prazo de abrir():
 *   só registrado (TODO). DECISÕES NOVAS A CONFIRMAR: D7 executável precisa ser caminho ABSOLUTO terminado em `/pg_dump` (nada de PATH); D8 `lancador`,
 *   `sistema` e `arquivos` estão na superfície APENAS para testar: a ligação operacional real deverá importá-los de um módulo interno e removê-los da
 *   superfície pública (o chamador não pode escolher o que é executado); D9 argumentos fixos: `--format=custom`, `--no-password`, `--snapshot=<id>` e
 *   `--dbname=<nome>`, sem mais nada.
 *
 * REFORÇO RED-PGDUMP-SNAPSHOT-2 (decisões do ChatGPT/Ramires, sem mudar produção):
 *   - `pg_dump --dbname` pode ser interpretado como STRING DE CONEXÃO (URI `postgresql://`/`postgres://` ou pares `chave=valor`), cujos parâmetros podem
 *     substituir outras configurações de conexão. Por isso o nome do banco só vale se casar com /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/ (sem `=`, `/`, `:`,
 *     `@`, `?`, `%`, aspas, barra invertida, controle). O valor NUNCA é "limpo" nem normalizado para virar válido: o que não casa é recusado.
 *   - `Object.freeze` do contexto é proteção auxiliar, não prova de origem. A origem só é garantida pela composição, que não aceita `contexto`,
 *     `snapshotId` nem `processoDoDump` em lugar nenhum; o construtor exportado é interno (TODO PGD-12i).
 *   - D9: `semSeguirLinks: true` vale para TODOS os componentes do caminho (inclusive ancestrais); o módulo não resolve nem corrige caminhos: se o
 *     sistema de arquivos recusar por link, o processo não é lançado e a trava fica retida (D1). D7: o caminho absoluto `/pg_dump` é validação mínima,
 *     não comprova a identidade do binário. `stderr` descartado só nesta fase provisória (TODO PGD-12j).
 * COMO LER ESTES TESTES NESTA FASE: o módulo NÃO existe. As falhas por "módulo ausente" NÃO são provas comportamentais independentes: o valor de cada
 * teste só aparece depois do GREEN (e das mutações). Os CTL-* passam hoje e provam que as fixtures são válidas contra o supervisor e a entrada
 * operacional REAIS. Os TODO registram exigências pré-operacionais fora deste incremento.
 */

const MODULO = 'src/services/imagem-backup-pgdump.service';
const pgdump = () => exigirModulo(MODULO);
const PRAZO_DO_TESTE = 10000;
const PID = 7777;
const DESCRITOR = 77;
const PREFIXO_TEMPORARIO = 'gepi-pgd-test-';
const temporarios = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of temporarios) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO_TEMPORARIO)) fs.rmSync(p, { recursive: true, force: true });
});
const ID_SNAPSHOT = '0000000A-0000002B-7';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const HOST = 'db.interno.exemplo';
const USUARIO = 'usuario_secreto';
const SENHA_ARQUIVO = '/etc/safework/pgpass';
const MARCADORES = [SEGREDO, HOST, USUARIO, 'postgres://', 'password'];
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const AMBIENTE_PERMITIDO = new Set(['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGUSER']);
const ARGUMENTOS_PERMITIDOS = [/^--format=custom$/, /^--no-password$/, /^--snapshot=[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/, /^--dbname=[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/];

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);

function adiado() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((r, j) => { resolver = r; rejeitar = j; });
  return { promessa, resolver, rejeitar };
}

function erroSensivel(codigo = 'EACCES') {
  return Object.assign(new Error(`spawn ${SENHA_ARQUIVO} falhou: password=${SEGREDO} host=${HOST} user=${USUARIO} postgres://u:${SEGREDO}@${HOST}/db`), {
    code: codigo, detail: `detalhe ${SEGREDO}`, path: SENHA_ARQUIVO,
  });
}

function semMarcadores(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : (JSON.stringify(valor) ?? String(valor));
  for (const marcador of MARCADORES) assert.equal(texto.includes(marcador), false, `${rotulo}: não pode conter "${marcador}"`);
}

async function comConsoleEspiado(fn) {
  const util = require('node:util');
  const metodos = ['log', 'error', 'warn', 'info', 'debug', 'trace'];
  const originais = {};
  const chamadas = [];
  for (const nome of metodos) {
    originais[nome] = console[nome];
    console[nome] = (...argumentos) => { chamadas.push(`${nome}: ${argumentos.map((a) => util.inspect(a, { depth: 4 })).join(' ')}`); };
  }
  try {
    return { resultado: await fn(), chamadas };
  } finally {
    for (const nome of metodos) console[nome] = originais[nome];
  }
}

const congelar = (valor) => {
  if (valor !== null && typeof valor === 'object') for (const v of Object.values(valor)) congelar(v);
  return Object.freeze(valor);
};
const contextoValido = (sobrescrever = {}) => congelar({
  snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null, ...sobrescrever,
});

// ------------------------------------------------------------------------------------------------------------------------------- mundo
function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}

function criarMundo({
  idSnapshot = ID_SNAPSHOT, banco = { nome: 'gestao_epi', oid: '16384' }, vivos = false, pid = PID, lancarFalha = null, arquivoExiste = false,
  criarArquivoFalha = null, imediatos = [], matarComSigkill = false, grupoFalha = null, sinalFalha = null, rollbackFalha = null, observavel = false,
} = {}) {
  // `observavel`: o arquivo do dump é REAL (diretório temporário fictício, descritor real, bytes fictícios), porque `executarBackupPgDump` agora obtém a observação física T1 do artefato (E3') e falha fechada sem ela.
  let diretorioReal = null;
  let descritorReal = null;
  if (observavel) {
    diretorioReal = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO_TEMPORARIO)));
    temporarios.push(diretorioReal);
  }
  const linha = [];
  const estado = { documento: null, liberacoes: 0, aquisicoes: 0 };
  const saida = adiado();
  const fluxos = adiado();
  const lancado = adiado();
  const contagem = { criarConexao: 0, copia: 0, avaliar: 0, lancar: 0, criarArquivo: 0, fechar: 0, enviarSinal: 0, grupoVivo: 0 };
  const chamadas = { lancar: [], criarArquivo: [], sinais: [], grupo: [] };
  const clientes = [];
  const ouvintes = [];
  const recebidosCopia = [];
  let proximo = 0;

  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push('adquirir');
      if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      proximo += 1;
      const token = `token-${proximo}`;
      estado.documento = { tipo: argumentos.tipo, token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { linha.push('confirmarPosse'); return { confirmada: estado.documento !== null && estado.documento.token === token }; },
        async liberar() {
          estado.liberacoes += 1;
          linha.push('liberar');
          if (estado.documento === null || estado.documento.token !== token) return { liberada: false };
          estado.documento = null;
          return { liberada: true };
        },
      });
    },
  };

  function criarCliente() {
    const c = {
      log: [],
      ouvintes: { error: [], end: [] },
      async connect() { c.log.push('connect'); linha.push('sql:connect'); },
      async query(sql, parametros) {
        const tipo = tipoDe(sql);
        c.log.push(tipo);
        linha.push(`sql:${tipo}`);
        switch (tipo) {
          case 'EXPORTAR': return { rows: [{ snapshot_id: idSnapshot }] };
          case 'IDENTIDADE': return { rows: [banco] };
          case 'PADRAO': return { rows: [] };
          case 'EMPRESA': return { rows: [] };
          case 'ROLLBACK': if (rollbackFalha) throw rollbackFalha; return { rows: [] };
          default: return { rows: [] };
        }
      },
      async end() { c.log.push('end'); linha.push('sql:end'); for (const f of c.ouvintes.end) f(); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    clientes.push(c);
    return c;
  }

  const temporizadorDoSnapshot = {
    prazos: [],
    prazo(ms) {
      const d = adiado();
      const registro = { ms, cancelado: false, vencer: () => d.resolver() };
      temporizadorDoSnapshot.prazos.push(registro);
      return { promessa: d.promessa, cancelar: () => { registro.cancelado = true; } };
    },
  };

  const temporizadorDoDump = {
    prazo(ms) {
      linha.push(`dump:prazo:${ms}`);
      const d = adiado();
      if (imediatos.includes(ms)) d.resolver();
      return { promessa: d.promessa, cancelar() {} };
    },
    intervalo: () => Promise.resolve(),
  };

  const lancador = {
    async lancar(spec) {
      contagem.lancar += 1;
      chamadas.lancar.push(spec);
      linha.push('lancar');
      lancado.resolver();
      if (lancarFalha) throw lancarFalha;
      return { pid, saida: saida.promessa, fluxosFechados: fluxos.promessa };
    },
  };

  const sistema = {
    async grupoVivo(pgid) {
      contagem.grupoVivo += 1;
      chamadas.grupo.push(pgid);
      linha.push('grupo:vivos');
      if (grupoFalha) throw grupoFalha;
      return vivos;
    },
    async enviarSinal(pgid, sinal) {
      contagem.enviarSinal += 1;
      chamadas.sinais.push([pgid, sinal]);
      linha.push(`sinal:${sinal}`);
      if (sinalFalha) throw sinalFalha;
      if (sinal === 'SIGKILL' && matarComSigkill) { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); }
      return true;
    },
  };

  const arquivos = {
    async criarExclusivo(spec) {
      contagem.criarArquivo += 1;
      chamadas.criarArquivo.push(spec);
      linha.push('arquivo:criar');
      if (criarArquivoFalha) throw criarArquivoFalha;
      if (arquivoExiste) throw Object.assign(new Error(`EEXIST ${SENHA_ARQUIVO}`), { code: 'EEXIST' });
      if (observavel) {
        descritorReal = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeSync(descritorReal, Buffer.from('dump-ficticio-pgdump-snapshot-'.repeat(20)));
        const real = descritorReal;
        return { descritor: real, fechar() { contagem.fechar += 1; linha.push('arquivo:fechar'); try { fs.closeSync(real); } catch { /* já fechado */ } } };
      }
      return { descritor: DESCRITOR, fechar() { contagem.fechar += 1; linha.push('arquivo:fechar'); } };
    },
  };

  const parada = { aoPedir(f) { ouvintes.push(f); } };
  const pedirParada = (sinal) => { for (const f of ouvintes) f(sinal); };

  const dump = {
    alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: USUARIO, arquivoDeSenha: SENHA_ARQUIVO, bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    destino: { diretorio: observavel ? diretorioReal : '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
    lancador,
    sistema,
    arquivos,
    temporizador: temporizadorDoDump,
    prazos: { ...PRAZOS },
  };

  const dependencias = {
    janela,
    conexao: { criarConexao: () => { contagem.criarConexao += 1; linha.push('criarConexao'); return criarCliente(); }, temporizador: temporizadorDoSnapshot, prazos: { finalizacaoMs: 5000 } },
    dump,
    async copia(contexto) { contagem.copia += 1; recebidosCopia.push(contexto); linha.push('copia'); return { ok: true }; },
    avaliar() { contagem.avaliar += 1; linha.push('avaliar'); return { valido: true, motivos: [] }; },
  };

  return {
    linha, estado, contagem, chamadas, clientes, dump, dependencias, lancador, sistema, arquivos, parada, pedirParada, ouvintes, recebidosCopia, lancado, descritorReal: () => descritorReal,
    sair: (t) => { linha.push('dump:saida'); saida.resolver(t); },
    fecharFluxos: () => { linha.push('dump:fluxos'); fluxos.resolver(); },
    encerrar(t = { codigo: 0, sinal: null }) { linha.push('dump:saida'); saida.resolver(t); linha.push('dump:fluxos'); fluxos.resolver(); },
    rejeitarSaida: (erro) => saida.rejeitar(erro),
  };
}

const indice = (linha, evento) => linha.indexOf(evento);
const antes = (linha, a, b) => indice(linha, a) !== -1 && indice(linha, b) !== -1 && indice(linha, a) < indice(linha, b);
const contar = (lista, item) => lista.filter((x) => x === item).length;
const rodar = (m) => pgdump().executarBackupPgDump(m.dependencias);

async function ate(evento, pendente, rotulo) {
  const quem = await Promise.race([evento.then(() => 'evento'), pendente.then(() => 'terminou', () => 'terminou')]);
  assert.equal(quem, 'evento', `a execução terminou antes de: ${rotulo}`);
}
const cederUmTurno = () => new Promise((resolver) => setImmediate(resolver));

function verificarSpecSegura(spec, { snapshotId = ID_SNAPSHOT, dump, descritor = DESCRITOR }) {
  assert.equal(spec.executavel, dump.alvo.executavel);
  assert.ok(Array.isArray(spec.argumentos));
  for (const argumento of spec.argumentos) assert.ok(ARGUMENTOS_PERMITIDOS.some((padrao) => padrao.test(argumento)), `argumento fora da lista fechada: ${argumento}`);
  assert.equal(spec.argumentos.filter((a) => a.startsWith('--snapshot=')).length, 1);
  assert.ok(spec.argumentos.includes(`--snapshot=${snapshotId}`));
  assert.ok(spec.argumentos.includes(`--dbname=${dump.alvo.bancoEsperado.nome}`));
  assert.equal(spec.argumentos.some((a) => /--jobs|-j\b|--file|-f\b|--host|--username|--password/.test(a)), false);
  for (const marcador of [SEGREDO, HOST, USUARIO, SENHA_ARQUIVO]) assert.equal(spec.argumentos.join(' ').includes(marcador), false, `argumentos sem "${marcador}"`);
  for (const chave of Object.keys(spec.ambiente)) assert.ok(AMBIENTE_PERMITIDO.has(chave), `variável de ambiente fora da lista fechada: ${chave}`);
  assert.equal(spec.ambiente.PGPASSFILE, dump.alvo.arquivoDeSenha);
  assert.equal(Object.hasOwn(spec.ambiente, 'PGPASSWORD'), false);
  assert.deepEqual(Object.keys(spec.opcoes).sort(), ['detached', 'shell', 'stdio']);
  assert.equal(spec.opcoes.shell, false);
  assert.equal(spec.opcoes.detached, true);
  assert.deepEqual(spec.opcoes.stdio, ['ignore', descritor, 'ignore']);
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: fixtures válidas contra o supervisor e a entrada operacional REAIS', () => {
  teste('CTL-01 — uma descrição com a forma esperada (iniciar/grupo/sinais/temporizador/prazos) é aceita pelo supervisor real e conclui com saída 0', async () => {
    const { supervisionar } = exigirModulo('src/services/imagem-backup-supervisor.service');
    const m = criarMundo();
    const descricao = {
      async iniciar() { const p = await m.lancador.lancar({}); return { pgid: p.pid, saida: p.saida, fluxosFechados: p.fluxosFechados }; },
      grupo: { vivos: (pgid) => m.sistema.grupoVivo(pgid) },
      sinais: { enviar: (pgid, sinal) => m.sistema.enviarSinal(pgid, sinal) },
      temporizador: m.dump.temporizador,
      prazos: { ...PRAZOS },
    };
    const pendente = supervisionar(descricao);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.encerrar();
    const r = await pendente;
    assert.equal(r.saida, 0);
    assert.equal(r.liberarTravaPermitido, true);
    assert.deepEqual(m.chamadas.grupo, [PID]);
  });

  teste('CTL-02 — a entrada operacional REAL com um `processoDoDump` manual sobre os mesmos doubles: o snapshot fica aberto até o processo terminar e é finalizado antes de liberar', async () => {
    const { executarBackupOperacional } = exigirModulo('src/services/imagem-backup-operacional.service');
    const m = criarMundo();
    const dependencias = {
      janela: m.dependencias.janela,
      conexao: m.dependencias.conexao,
      copia: m.dependencias.copia,
      avaliar: m.dependencias.avaliar,
      processoDoDump: () => ({
        async iniciar() { const p = await m.lancador.lancar({}); return { pgid: p.pid, saida: p.saida, fluxosFechados: p.fluxosFechados }; },
        grupo: { vivos: (pgid) => m.sistema.grupoVivo(pgid) },
        sinais: { enviar: (pgid, sinal) => m.sistema.enviarSinal(pgid, sinal) },
        temporizador: m.dump.temporizador,
        prazos: { ...PRAZOS },
      }),
    };
    const pendente = executarBackupOperacional(dependencias);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    assert.equal(m.linha.includes('sql:ROLLBACK'), false, 'processo vivo: a transação segue aberta');
    m.encerrar();
    const r = await pendente;
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.ok(antes(m.linha, 'dump:fluxos', 'sql:ROLLBACK'));
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-01 / 02 / 03: construtor
describe('[PGD-01/02/03] construtor `criarProcessoDoDump`: identidade, banco, argumentos', () => {
  teste('PGD-03 — a descrição tem EXATAMENTE a forma do supervisor, é síncrona e sem efeito: nenhum arquivo, nenhum processo, nenhum sinal', () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    assert.deepEqual(Object.keys(descricao).sort(), ['grupo', 'iniciar', 'prazos', 'sinais', 'temporizador']);
    assert.equal(typeof descricao.iniciar, 'function');
    assert.equal(typeof descricao.grupo.vivos, 'function');
    assert.equal(typeof descricao.sinais.enviar, 'function');
    assert.deepEqual({ ...descricao.prazos }, PRAZOS);
    assert.equal(m.contagem.criarArquivo + m.contagem.lancar + m.contagem.enviarSinal + m.contagem.grupoVivo, 0);
  });

  teste('PGD-03b — `iniciar()` cria o arquivo EXCLUSIVO (0600, sem seguir links) ANTES de lançar; o lançamento é sem shell, em grupo próprio, com a lista fechada de argumentos e ambiente; o `--snapshot` é o do contexto; devolve `{ pgid, saida, fluxosFechados }`', async () => {
    const m = criarMundo();
    const contexto = contextoValido({ snapshotId: '000000FF-00000001-1' });
    const descricao = pgdump().criarProcessoDoDump({ contexto, dump: m.dump });
    const processo = await descricao.iniciar();
    assert.deepEqual(m.chamadas.criarArquivo, [{ diretorio: m.dump.destino.diretorio, nome: m.dump.destino.nome, modo: 0o600, semSeguirLinks: true }]);
    assert.ok(antes(m.linha, 'arquivo:criar', 'lancar'));
    verificarSpecSegura(m.chamadas.lancar[0], { snapshotId: '000000FF-00000001-1', dump: m.dump });
    assert.equal(processo.pgid, PID);
    assert.equal(typeof processo.saida.then, 'function');
    assert.equal(typeof processo.fluxosFechados.then, 'function');
  });

  const contextosAdulterados = [
    ['snapshotId em minúsculas', () => contextoValido({ snapshotId: '0000000a-0000002b-7' })],
    ['snapshotId com opção injetada', () => contextoValido({ snapshotId: `${ID_SNAPSHOT} --file=/etc/passwd` })],
    ['snapshotId com ponto e vírgula', () => contextoValido({ snapshotId: `${ID_SNAPSHOT};rm` })],
    ['snapshotId vazio', () => contextoValido({ snapshotId: '' })],
    ['snapshotId número', () => contextoValido({ snapshotId: 123 })],
    ['snapshotId ausente', () => { const { snapshotId, ...resto } = contextoValido(); return Object.freeze(resto); }],
    ['banco ausente', () => { const { banco, ...resto } = contextoValido(); return Object.freeze(resto); }],
    ['nome do banco começando com hífen', () => contextoValido({ banco: Object.freeze({ nome: '-oProxyCommand=x', oid: '16384' }) })],
    ['nome do banco com espaço', () => contextoValido({ banco: Object.freeze({ nome: 'gestao epi', oid: '16384' }) })],
    ['nome do banco vazio', () => contextoValido({ banco: Object.freeze({ nome: '', oid: '16384' }) })],
    ['oid ausente', () => contextoValido({ banco: Object.freeze({ nome: 'gestao_epi' }) })],
    ['oid não numérico', () => contextoValido({ banco: Object.freeze({ nome: 'gestao_epi', oid: '16x84' }) })],
    ['contexto NÃO congelado (não veio de abrir())', () => ({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: null })],
    ['contexto nulo', () => null],
    ['contexto lista', () => []],
  ];
  for (const [rotulo, gerar] of contextosAdulterados) {
    teste(`PGD-01 (${rotulo}) — recusado na construção (TypeError); nenhum arquivo, nenhum processo`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: gerar(), dump: m.dump }), TypeError);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }

  for (const [rotulo, bancoEsperado] of [
    ['nome diferente', { nome: 'outro_banco', oid: '16384' }],
    ['oid diferente (mesmo nome: nome sozinho NÃO prova identidade)', { nome: 'gestao_epi', oid: '99999' }],
  ]) {
    teste(`PGD-02 (${rotulo}) — banco esperado diverge do banco do snapshot: recusado na construção; nenhum arquivo, nenhum processo`, () => {
      const m = criarMundo();
      const dump = { ...m.dump, alvo: { ...m.dump.alvo, bancoEsperado } };
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump }), TypeError);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }

  teste('PGD-02b — a configuração capturada na construção é estável: mudar `alvo`/`destino`/`prazos` depois não altera o que `iniciar()` usa', async () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    m.dump.alvo.arquivoDeSenha = '/tmp/outro-pgpass';
    m.dump.alvo.executavel = '/bin/sh';
    m.dump.destino.nome = 'outro.pgdump';
    m.dump.prazos.totalMs = 1;
    await descricao.iniciar();
    assert.equal(m.chamadas.lancar[0].executavel, '/usr/lib/postgresql/16/bin/pg_dump');
    assert.equal(m.chamadas.lancar[0].ambiente.PGPASSFILE, SENHA_ARQUIVO);
    assert.equal(m.chamadas.criarArquivo[0].nome, 'dump-20261023.pgdump');
    assert.equal(descricao.prazos.totalMs, PRAZOS.totalMs);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-04: credenciais
describe('[PGD-04] credenciais: nada em argumentos, ambiente em lista fechada', () => {
  teste('PGD-04 — o ambiente do filho NÃO herda o ambiente do processo pai: uma senha e uma variável qualquer do pai nunca chegam ao spec', async () => {
    const antesDoTeste = { pw: process.env.PGPASSWORD, outro: process.env.SEGREDO_NO_AMBIENTE_PAI };
    process.env.PGPASSWORD = SEGREDO;
    process.env.SEGREDO_NO_AMBIENTE_PAI = SEGREDO;
    try {
      const m = criarMundo();
      const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
      await descricao.iniciar();
      const spec = m.chamadas.lancar[0];
      assert.equal(JSON.stringify(spec).includes(SEGREDO), false);
      assert.deepEqual(Object.keys(spec.ambiente).sort(), ['PGHOST', 'PGPASSFILE', 'PGPORT', 'PGUSER']);
      assert.equal(spec.ambiente.PGHOST, HOST);
      assert.equal(spec.ambiente.PGPORT, '5432');
      assert.equal(spec.ambiente.PGUSER, USUARIO);
    } finally {
      if (antesDoTeste.pw === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = antesDoTeste.pw;
      if (antesDoTeste.outro === undefined) delete process.env.SEGREDO_NO_AMBIENTE_PAI; else process.env.SEGREDO_NO_AMBIENTE_PAI = antesDoTeste.outro;
    }
  });

  for (const chave of ['senha', 'password', 'PGPASSWORD', 'argumentosExtras', 'ambienteExtra', 'conexaoString', 'shell']) {
    teste(`PGD-04b (alvo com a chave "${chave}") — chave desconhecida ou de credencial é recusada na construção: o alvo não aceita senha nem opções extras`, () => {
      const m = criarMundo();
      const dump = { ...m.dump, alvo: { ...m.dump.alvo, [chave]: SEGREDO } };
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump }), TypeError);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-09: arquivo de destino
describe('[PGD-09] arquivo de destino: caminho controlado, criação exclusiva, sem vazar', () => {
  const diretoriosInseguros = [['relativo', 'backups'], ['vazio', ''], ['raiz', '/'], ['com ..', '/var/backups/../etc'], ['com controle', '/var/back\nups'], ['com NUL', '/var/back\0ups'], ['não é texto', 42]];
  const nomesInseguros = [['vazio', ''], ['com barra', 'a/b'], ['com ..', '../x'], ['oculto', '.dump'], ['com espaço', 'a b'], ['com quebra de linha', 'x\n'], ['com NUL', 'x\0'], ['grande demais (101)', 'a'.repeat(101)], ['não é texto', 7]];
  for (const [rotulo, diretorio] of diretoriosInseguros) {
    teste(`PGD-09 (diretório ${rotulo}) — recusado na construção, nenhum arquivo criado`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, destino: { ...m.dump.destino, diretorio } } }), TypeError);
      assert.equal(m.contagem.criarArquivo, 0);
    });
  }
  for (const [rotulo, nome] of nomesInseguros) {
    teste(`PGD-09 (nome ${rotulo}) — recusado na construção, nenhum arquivo criado`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, destino: { ...m.dump.destino, nome } } }), TypeError);
      assert.equal(m.contagem.criarArquivo, 0);
    });
  }

  teste('PGD-09b — o arquivo já existe (criação exclusiva falha): `iniciar()` rejeita, o processo NUNCA é lançado, nada é sobrescrito, o erro bruto não vaza', async () => {
    const m = criarMundo({ arquivoExiste: true });
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    await assert.rejects(() => descricao.iniciar(), (erro) => { semMarcadores(`${erro.message} ${JSON.stringify(erro)}`, 'erro público de iniciar'); return true; });
    assert.equal(m.contagem.lancar, 0);
    assert.equal(m.contagem.fechar, 0, 'nada foi criado: nada a fechar');
  });

  teste('PGD-09c — o lançamento falha DEPOIS de o arquivo ser criado: o descritor é fechado exatamente uma vez e `iniciar()` rejeita sem vazar', async () => {
    const m = criarMundo({ lancarFalha: erroSensivel('ENOENT') });
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    await assert.rejects(() => descricao.iniciar(), (erro) => { semMarcadores(`${erro.message} ${JSON.stringify(erro)}`, 'erro público de iniciar'); return true; });
    assert.equal(m.contagem.fechar, 1);
  });

  teste('PGD-09d — o descritor só é fechado DEPOIS de os fluxos do processo fecharem, e uma vez só', async () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    const processo = await descricao.iniciar();
    m.sair({ codigo: 0, sinal: null });
    await cederUmTurno();
    assert.equal(m.contagem.fechar, 0, 'o processo saiu, mas os fluxos ainda não fecharam');
    m.fecharFluxos();
    await processo.fluxosFechados;
    assert.equal(m.contagem.fechar, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- sinais e grupo no construtor
describe('[PGD-08] sinais e consulta de grupo só valem para o processo lançado', () => {
  for (const pidInvalido of [0, 1, -5, 1.5, '7777', null, Number.MAX_SAFE_INTEGER + 2]) {
    teste(`PGD-08 (pid ${String(pidInvalido)}) — pid inválido devolvido pelo lançador: \`iniciar()\` rejeita, nunca se sinaliza nem se consulta nada, o descritor é fechado`, async () => {
      const m = criarMundo({ pid: pidInvalido });
      const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
      await assert.rejects(() => descricao.iniciar());
      assert.equal(m.contagem.enviarSinal + m.contagem.grupoVivo, 0);
      assert.equal(m.contagem.fechar, 1);
    });
  }

  teste('PGD-08b — só SIGINT, SIGTERM e SIGKILL, e só para o pgid lançado: qualquer outro sinal ou pgid NÃO chega ao sistema', async () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    await descricao.iniciar();
    for (const [pgid, sinal] of [[PID, 'SIGSTOP'], [PID, 'SIGUSR1'], [PID, '0'], [PID, ''], [PID, 9], [1, 'SIGKILL'], [0, 'SIGTERM'], [-PID, 'SIGKILL'], [PID + 1, 'SIGTERM']]) {
      const aceito = await descricao.sinais.enviar(pgid, sinal).then((v) => v, () => false);
      assert.notEqual(aceito, true, `${String(pgid)}/${String(sinal)} não pode ser aceito`);
    }
    assert.equal(m.contagem.enviarSinal, 0);
    for (const sinal of ['SIGINT', 'SIGTERM', 'SIGKILL']) assert.equal(await descricao.sinais.enviar(PID, sinal), true);
    assert.deepEqual(m.chamadas.sinais, [[PID, 'SIGINT'], [PID, 'SIGTERM'], [PID, 'SIGKILL']]);
  });

  teste('PGD-08c — antes de `iniciar()` não existe pgid: nenhum sinal e nenhuma consulta de grupo chegam ao sistema', async () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    const aceito = await descricao.sinais.enviar(PID, 'SIGTERM').then((v) => v, () => false);
    assert.notEqual(aceito, true);
    await assert.rejects(() => descricao.grupo.vivos(PID));
    assert.equal(m.contagem.enviarSinal + m.contagem.grupoVivo, 0);
  });

  teste('PGD-08d — `grupo.vivos` só responde true/false do sistema; resposta de outro tipo, exceção ou pgid alheio nunca viram "vazio" (rejeitam)', async () => {
    // Cada resposta é exercitada por uma instância INDEPENDENTE, configurada ANTES da validação (nada é trocado depois da captura).
    const comGrupo = async (responder) => {
      const m = criarMundo();
      const consultas = [];
      const sistema = { async grupoVivo(pgid) { consultas.push(pgid); return responder(); }, enviarSinal: m.sistema.enviarSinal };
      const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, sistema } });
      await descricao.iniciar();
      return { descricao, consultas };
    };
    for (const [rotulo, responder] of [
      ['undefined', async () => undefined], ['texto "false"', async () => 'false'], ['null', async () => null], ['número 0', async () => 0],
      ['exceção sensível', async () => { throw erroSensivel('EPERM'); }],
    ]) {
      const { descricao, consultas } = await comGrupo(responder);
      await assert.rejects(() => descricao.grupo.vivos(PID), (erro) => { semMarcadores(`${erro.message} ${JSON.stringify(erro)}`, `erro público de grupo (${rotulo})`); return true; }, rotulo);
      assert.deepEqual(consultas, [PID], rotulo);
    }
    for (const valor of [true, false]) {
      const { descricao } = await comGrupo(async () => valor);
      assert.equal(await descricao.grupo.vivos(PID), valor);
    }
    const { descricao, consultas } = await comGrupo(async () => false);
    await assert.rejects(() => descricao.grupo.vivos(PID + 1));
    assert.deepEqual(consultas, [], 'pgid alheio nem chega ao sistema');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-05: composição
describe('[PGD-05] composição `executarBackupPgDump`: o chamador não substitui o construtor nem o ciclo de vida', () => {
  const extras = [
    ['processoDoDump', { processoDoDump: () => ({}) }],
    ['snapshot', { snapshot: async () => ({ ok: true }) }],
    ['finalizar', { finalizar: async () => ({ concluida: true }) }],
    ['supervisionar', { supervisionar: async () => ({ concluido: true }) }],
    ['etapas', { etapas: [] }],
    ['contexto', { contexto: contextoValido({ snapshotId: '000000FF-00000001-1' }) }],
    ['snapshotId', { snapshotId: '000000FF-00000001-1' }],
    ['argumentos', { argumentos: ['--jobs=8'] }],
    ['comando', { comando: 'sh -c "id"' }],
  ];
  for (const [rotulo, extra] of extras) {
    teste(`PGD-05 (${rotulo} no topo) — saída 2 antes da trava: nada adquirido, nenhuma conexão, nenhum arquivo, nenhum processo`, async () => {
      const m = criarMundo();
      const r = await pgdump().executarBackupPgDump({ ...m.dependencias, ...extra });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  teste('PGD-05b — sem `dump`: saída 2 antes da trava', async () => {
    const m = criarMundo();
    const { dump, ...semDump } = m.dependencias;
    const r = await pgdump().executarBackupPgDump(semDump);
    assert.equal(r.saida, SAIDAS.ARGUMENTOS);
    assert.equal(m.linha.length, 0);
  });

  const configuracaoInvalida = [
    ['alvo ausente', (d) => { delete d.alvo; }],
    ['alvo lista', (d) => { d.alvo = []; }],
    ['executável relativo (PATH)', (d) => { d.alvo = { ...d.alvo, executavel: 'pg_dump' }; }],
    ['executável é um shell', (d) => { d.alvo = { ...d.alvo, executavel: '/bin/sh' }; }],
    ['executável com comando encadeado', (d) => { d.alvo = { ...d.alvo, executavel: '/usr/bin/pg_dump; rm -rf /' }; }],
    ['executável com ..', (d) => { d.alvo = { ...d.alvo, executavel: '/usr/bin/../bin/sh' }; }],
    ['executável com quebra de linha', (d) => { d.alvo = { ...d.alvo, executavel: '/usr/bin/pg_dump\n' }; }],
    ['host vazio', (d) => { d.alvo = { ...d.alvo, host: '' }; }],
    ['host com hífen inicial', (d) => { d.alvo = { ...d.alvo, host: '-oProxyCommand=x' }; }],
    ['porta zero', (d) => { d.alvo = { ...d.alvo, porta: 0 }; }],
    ['porta acima de 65535', (d) => { d.alvo = { ...d.alvo, porta: 70000 }; }],
    ['porta texto', (d) => { d.alvo = { ...d.alvo, porta: '5432' }; }],
    ['arquivo de senha relativo', (d) => { d.alvo = { ...d.alvo, arquivoDeSenha: 'pgpass' }; }],
    ['arquivo de senha com ..', (d) => { d.alvo = { ...d.alvo, arquivoDeSenha: '/etc/../tmp/pgpass' }; }],
    ['banco esperado ausente', (d) => { d.alvo = { ...d.alvo, bancoEsperado: undefined }; }],
    ['oid esperado com zero à esquerda', (d) => { d.alvo = { ...d.alvo, bancoEsperado: { nome: 'gestao_epi', oid: '0123' } }; }],
    ['destino ausente', (d) => { delete d.destino; }],
    ['destino com diretório relativo', (d) => { d.destino = { ...d.destino, diretorio: 'backups' }; }],
    ['destino com nome inseguro', (d) => { d.destino = { ...d.destino, nome: '../x' }; }],
    ['lançador sem lancar', (d) => { d.lancador = {}; }],
    ['sistema sem grupoVivo', (d) => { d.sistema = { enviarSinal: async () => true }; }],
    ['sistema sem enviarSinal', (d) => { d.sistema = { grupoVivo: async () => false }; }],
    ['arquivos sem criarExclusivo', (d) => { d.arquivos = {}; }],
    ['temporizador sem intervalo', (d) => { d.temporizador = { prazo: () => ({}) }; }],
    ['prazos sem cortesia', (d) => { d.prazos = { ...d.prazos, cortesiaMs: 0 }; }],
    ['prazos totalMs fracionário', (d) => { d.prazos = { ...d.prazos, totalMs: 1.5 }; }],
    ['chave desconhecida em dump (jobs)', (d) => { d.jobs = 4; }],
    ['chave desconhecida em dump (shell)', (d) => { d.shell = true; }],
  ];
  for (const [rotulo, ajustar] of configuracaoInvalida) {
    teste(`PGD-05c (${rotulo}) — configuração inválida do dump: saída 2 ANTES da trava; nada adquirido, nenhuma conexão, nenhum arquivo, nenhum processo`, async () => {
      const m = criarMundo();
      const dump = { ...m.dump, alvo: { ...m.dump.alvo }, destino: { ...m.dump.destino }, prazos: { ...m.dump.prazos } };
      ajustar(dump);
      const r = await pgdump().executarBackupPgDump({ ...m.dependencias, dump });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.criarConexao, 0);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  teste('PGD-05d — TOCTOU: o `dump` capturado na chamada vale; trocar `alvo`, `destino` e `lancador` durante a aquisição da trava não muda o que roda', async () => {
    const m = criarMundo({ observavel: true });
    const diretorioCapturado = m.dump.destino.diretorio;
    const original = m.dependencias.janela;
    const evil = { n: 0 };
    m.dependencias.janela = {
      async adquirir(a) {
        m.dependencias.dump.alvo = { ...m.dump.alvo, executavel: '/bin/sh' };
        m.dependencias.dump.destino = { diretorio: '/tmp', nome: 'evil' };
        m.dependencias.dump.lancador = { async lancar() { evil.n += 1; return { pid: 9, saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() }; } };
        return original.adquirir(a);
      },
    };
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.encerrar();
    const r = await pendente;
    assert.equal(evil.n, 0);
    assert.equal(m.chamadas.lancar[0].executavel, '/usr/lib/postgresql/16/bin/pg_dump');
    assert.equal(m.chamadas.criarArquivo[0].diretorio, diretorioCapturado);
    assert.equal(r.saida, SAIDAS.VALIDO);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-01/02/06/07: ciclo de vida
describe('[PGD-06/07] ciclo de vida: o `--snapshot` é o da transação aberta; a transação só fecha com o encerramento COMPROVADO', () => {
  teste('PGD-06 — cadeia de custódia: o id exportado pela conexão desta operação é o `--snapshot` do dump; ordem BEGIN → exportação → arquivo → lançamento → fim do processo → grupo → cópia → avaliação → ROLLBACK → end → liberar; saída 0; recuperavel false', async () => {
    const m = criarMundo({ idSnapshot: '000000A1-0000FF02-3', observavel: true });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    verificarSpecSegura(m.chamadas.lancar[0], { snapshotId: '000000A1-0000FF02-3', dump: m.dump, descritor: m.descritorReal() });
    m.encerrar();
    const r = await pendente;
    for (const [a, b] of [['sql:BEGIN', 'sql:EXPORTAR'], ['sql:EXPORTAR', 'arquivo:criar'], ['arquivo:criar', 'lancar'], ['lancar', 'dump:saida'], ['dump:fluxos', 'grupo:vivos'],
      ['grupo:vivos', 'copia'], ['copia', 'avaliar'], ['avaliar', 'sql:ROLLBACK'], ['sql:ROLLBACK', 'sql:end'], ['sql:end', 'liberar']]) {
      assert.ok(antes(m.linha, a, b), `${a} antes de ${b}`);
    }
    assert.ok(antes(m.linha, 'dump:fluxos', 'arquivo:fechar'));
    assert.ok(antes(m.linha, 'arquivo:fechar', 'liberar'));
    assert.equal(m.contagem.fechar, 1);
    assert.equal(m.clientes.length, 1);
    assert.equal(m.recebidosCopia[0].snapshotId, '000000A1-0000FF02-3');
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.equal(r.recuperavel, false);
  });

  teste('PGD-06b — duas operações usam snapshots, arquivos e processos distintos; nada é reaproveitado', async () => {
    const m = criarMundo({ observavel: true });
    const a = rodar(m);
    await ate(m.lancado.promessa, a, 'o primeiro lançamento');
    m.encerrar();
    assert.equal((await a).saida, SAIDAS.VALIDO);
    assert.equal(m.clientes.length, 1);
    assert.equal(m.chamadas.criarArquivo.length, 1);
  });

  teste('PGD-06c — com o processo VIVO a transação não é encerrada: nenhum ROLLBACK, nenhum end, nenhuma liberação, nenhum fechamento do arquivo', async () => {
    const m = criarMundo();
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    await cederUmTurno();
    assert.equal(m.linha.some((e) => e === 'sql:ROLLBACK' || e === 'sql:end' || e === 'liberar' || e === 'arquivo:fechar'), false);
    m.encerrar();
    await pendente;
  });

  teste('PGD-07 — o `exit` ISOLADO não basta: com o processo já fora e os fluxos ainda abertos, a transação segue aberta; só depois dos fluxos e do grupo vazio ela é encerrada', async () => {
    const m = criarMundo({ observavel: true });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.sair({ codigo: 0, sinal: null });
    await cederUmTurno();
    assert.equal(m.linha.some((e) => e === 'sql:ROLLBACK' || e === 'sql:end' || e === 'liberar'), false, 'só o exit: ainda nada pode ser encerrado');
    m.fecharFluxos();
    const r = await pendente;
    assert.ok(antes(m.linha, 'dump:saida', 'dump:fluxos'));
    assert.ok(antes(m.linha, 'dump:fluxos', 'grupo:vivos'));
    assert.ok(antes(m.linha, 'grupo:vivos', 'sql:ROLLBACK'));
    assert.equal(r.saida, SAIDAS.VALIDO);
  });

  teste('PGD-07b — exit com código 0, fluxos NUNCA fecham e o prazo total vence: nenhum sinal, transação NÃO encerrada, trava RETIDA (11), finalização ADIADA', async () => {
    const m = criarMundo({ imediatos: [PRAZOS.totalMs] });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.sair({ codigo: 0, sinal: null });
    const r = await pendente;
    assert.equal(m.contagem.enviarSinal, 0);
    assert.equal(m.clientes[0].log.includes('ROLLBACK') || m.clientes[0].log.includes('end'), false);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
  });

  teste('PGD-07c — processo fora e fluxos fechados, mas o GRUPO ainda tem processo: retenção; a transação NÃO é encerrada e nenhum descendente é sinalizado', async () => {
    const m = criarMundo({ vivos: true });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.encerrar();
    const r = await pendente;
    assert.equal(m.contagem.enviarSinal, 0);
    assert.equal(m.clientes[0].log.includes('ROLLBACK') || m.clientes[0].log.includes('end'), false);
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.copia, 0);
  });

  teste('PGD-07d — a consulta do grupo falha (EPERM sensível): o grupo não é confirmado; retenção; a transação NÃO é encerrada', async () => {
    const m = criarMundo({ grupoFalha: erroSensivel('EPERM') });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.encerrar();
    const r = await pendente;
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.clientes[0].log.includes('ROLLBACK'), false);
    assert.equal(m.estado.liberacoes, 0);
    semMarcadores(r, 'resultado');
  });

  for (const [rotulo, ajustar] of [
    ['nome do banco diferente', (m) => { m.dependencias.dump.alvo = { ...m.dump.alvo, bancoEsperado: { nome: 'outro_banco', oid: '16384' } }; }],
    ['oid diferente com o MESMO nome', (m) => { m.dependencias.dump.alvo = { ...m.dump.alvo, bancoEsperado: { nome: 'gestao_epi', oid: '99999' } }; }],
  ]) {
    teste(`PGD-02c (${rotulo}) — o banco do snapshot ABERTO diverge do esperado: nada é lançado nem criado; por D1 a trava fica RETIDA e a transação aberta (recusa conservadora)`, async () => {
      const m = criarMundo();
      ajustar(m);
      const r = await rodar(m);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
      assert.equal(m.contagem.copia + m.contagem.avaliar, 0);
      assert.equal(m.clientes[0].log.includes('ROLLBACK') || m.clientes[0].log.includes('end'), false);
      assert.equal(r.finalizacao, 'ADIADA');
      assert.equal(r.janela, 'RETIDA');
      assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
    });
  }

  teste('PGD-01c — o snapshot não abre (exportação inválida): nenhum arquivo, nenhum processo; a abertura falha de forma segura e a transação é finalizada', async () => {
    const m = criarMundo({ idSnapshot: 'invalido' });
    const r = await rodar(m);
    assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    assert.equal(r.valido, false);
    assert.equal(m.clientes[0].log.filter((x) => x === 'ROLLBACK').length, 1);
    assert.equal(m.clientes[0].log.filter((x) => x === 'end').length, 1);
    assert.equal(r.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-08: falhas, sinais, timeouts
describe('[PGD-08] falhas, sinais e prazos', () => {
  teste('PGD-08e — código de saída 1 com fluxos fechados e grupo vazio: falha COMPROVADA; a cópia não roda, a transação é finalizada antes de liberar; nunca sucesso', async () => {
    const m = criarMundo();
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.encerrar({ codigo: 1, sinal: null });
    const r = await pendente;
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.avaliar, 0);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.saida, SAIDAS.INVALIDO);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(m.contagem.fechar, 1);
  });

  teste('PGD-08f — prazo total esgotado com o processo VIVO: SIGTERM e depois SIGKILL só ao pgid lançado, nessa ordem; processo morto, fluxos fechados e grupo vazio permitem finalizar; resultado inválido (9)', async () => {
    const m = criarMundo({ imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], matarComSigkill: true });
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    const r = await pendente;
    assert.deepEqual(m.chamadas.sinais, [[PID, 'SIGTERM'], [PID, 'SIGKILL']]);
    assert.ok(antes(m.linha, 'sinal:SIGTERM', 'sinal:SIGKILL'));
    assert.ok(antes(m.linha, 'sinal:SIGKILL', 'sql:ROLLBACK'));
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.saida, SAIDAS.INVALIDO);
    assert.equal(r.valido, false);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.recuperavel, false);
  });

  teste('PGD-08g — prazo esgotado, sinais aceitos, mas o processo NÃO termina e o grupo segue vivo: retenção; transação NÃO encerrada; o envio do sinal não provou nada', async () => {
    const m = criarMundo({ imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], vivos: true });
    const r = await rodar(m);
    assert.deepEqual(m.chamadas.sinais.map(([, s]) => s), ['SIGTERM', 'SIGKILL']);
    assert.equal(m.clientes[0].log.includes('ROLLBACK') || m.clientes[0].log.includes('end'), false);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('PGD-08h — o lançamento falha (sensível): sem sinal, sem consulta de grupo, trava RETIDA, transação NÃO encerrada, descritor fechado uma vez, nada vaza', async () => {
    const m = criarMundo({ lancarFalha: erroSensivel('ENOENT') });
    const { resultado: r, chamadas } = await comConsoleEspiado(() => rodar(m));
    assert.equal(m.contagem.enviarSinal + m.contagem.grupoVivo, 0);
    assert.equal(m.clientes[0].log.includes('ROLLBACK') || m.clientes[0].log.includes('end'), false);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.contagem.fechar, 1);
    semMarcadores(r, 'resultado');
    semMarcadores(chamadas.join('\n'), 'console');
  });

  teste('PGD-08i — a criação exclusiva do arquivo falha (EEXIST): o processo nunca é lançado, trava RETIDA (D1), transação aberta, nada vaza', async () => {
    const m = criarMundo({ arquivoExiste: true });
    const { resultado: r, chamadas } = await comConsoleEspiado(() => rodar(m));
    assert.equal(m.contagem.lancar, 0);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(m.clientes[0].log.includes('ROLLBACK'), false);
    semMarcadores(r, 'resultado');
    semMarcadores(chamadas.join('\n'), 'console');
  });

  teste('PGD-08j — a promessa de término do processo é REJEITADA: término não confirmado, retenção, transação aberta', async () => {
    const m = criarMundo();
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.rejeitarSaida(erroSensivel('ECHILD'));
    m.fecharFluxos();
    const r = await pendente;
    assert.equal(r.janela, 'RETIDA');
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(m.clientes[0].log.includes('ROLLBACK'), false);
    assert.equal(m.estado.liberacoes, 0);
    semMarcadores(r, 'resultado');
  });

  teste('PGD-08k — SIGINT durante o dump com o grupo VIVO: o supervisor recebe a parada, a cópia não roda, retenção, transação aberta', async () => {
    const m = criarMundo({ vivos: true });
    m.dependencias.parada = m.parada;
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    assert.ok(m.ouvintes.length >= 2, 'coordenador e supervisor registraram a parada');
    m.pedirParada('SIGINT');
    m.encerrar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(r.sinal, 'SIGINT');
    assert.equal(r.supervisao.parada, 'SIGINT');
    assert.equal(m.contagem.copia, 0);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.clientes[0].log.includes('ROLLBACK'), false);
    assert.equal(m.estado.liberacoes, 0);
  });

  teste('PGD-08l — SIGINT durante o dump com o grupo comprovadamente ENCERRADO: a cópia não roda, a transação é finalizada antes de liberar, nunca válido', async () => {
    const m = criarMundo({ vivos: false });
    m.dependencias.parada = m.parada;
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    m.pedirParada('SIGINT');
    m.encerrar({ codigo: null, sinal: 'SIGINT' });
    const r = await pendente;
    assert.equal(m.contagem.copia, 0);
    assert.ok(antes(m.linha, 'sql:end', 'liberar'));
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(r.sinal, 'SIGINT');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-10: sigilo
describe('[PGD-10] sigilo: nada de mensagem, host, usuário, caminho ou segredo no resultado nem nos logs', () => {
  const cenarios = [
    ['o lançador lança', { lancarFalha: () => erroSensivel('ENOENT') }],
    ['a criação do arquivo lança', { criarArquivoFalha: () => erroSensivel('EACCES') }],
    ['o envio de sinal lança', { imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], sinalFalha: () => erroSensivel('EPERM') }],
    ['a consulta do grupo lança', { grupoFalha: () => erroSensivel('EPERM') }],
    ['o término do processo é rejeitado', { rejeitarSaida: true }],
    ['ROLLBACK do snapshot falha', { rollbackFalha: () => erroSensivel('08006') }],
  ];
  for (const [rotulo, opcoes] of cenarios) {
    teste(`PGD-10 (${rotulo}) — resultado serializado, motivos e console sem marcadores; motivos são códigos fixos; recuperavel false; nunca válido`, async () => {
      const { rejeitarSaida, ...resto } = opcoes;
      const montado = Object.fromEntries(Object.entries(resto).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
      const m = criarMundo(montado);
      const { resultado: r, chamadas } = await comConsoleEspiado(async () => {
        const pendente = rodar(m);
        if (m.contagem.lancar === 0) await Promise.race([m.lancado.promessa, pendente.then(() => undefined, () => undefined)]);
        if (rejeitarSaida) { m.rejeitarSaida(erroSensivel('ECHILD')); m.fecharFluxos(); } else if (!montado.lancarFalha && !montado.criarArquivoFalha && !(montado.imediatos ?? []).length) m.encerrar();
        return pendente;
      });
      semMarcadores(r, 'resultado serializado');
      for (const motivo of r.motivos) assert.match(motivo, /^[A-Z][A-Z_]*$/);
      semMarcadores(chamadas.join('\n'), 'logs do módulo (console)');
      assert.equal(r.recuperavel, false);
      assert.equal(r.valido, false);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-11
describe('[PGD-11] recuperabilidade', () => {
  teste('PGD-11 — `recuperavel` é false em sucesso, falha, retenção e recusa, mesmo quando a avaliação alega `recuperavel: true`', async () => {
    for (const [rotulo, preparar] of [
      ['sucesso', async (m, p) => { await ate(m.lancado.promessa, p, 'lançar'); m.encerrar(); }],
      ['falha do dump', async (m, p) => { await ate(m.lancado.promessa, p, 'lançar'); m.encerrar({ codigo: 1, sinal: null }); }],
    ]) {
      const m = criarMundo();
      m.dependencias.avaliar = () => { m.contagem.avaliar += 1; return { valido: true, recuperavel: true, motivos: [] }; };
      const pendente = rodar(m);
      await preparar(m, pendente);
      const r = await pendente;
      assert.equal(r.recuperavel, false, rotulo);
    }
    const retida = criarMundo({ vivos: true });
    const pendente = rodar(retida);
    await ate(retida.lancado.promessa, pendente, 'lançar');
    retida.encerrar();
    assert.equal((await pendente).recuperavel, false, 'retenção');
    assert.equal((await pgdump().executarBackupPgDump({})).recuperavel, false, 'recusa');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-12: pré-operacionais
describe('[PGD-12] exigências PRÉ-OPERACIONAIS registradas (fora deste incremento; não executam)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('PGD-12a — exceção inesperada na entrada operacional: a trava e a conexão do snapshot precisam ter encerramento COMPROVADO ou retenção explícita; o rótulo `janela` do resultado não pode afirmar um estado que não ocorreu (hoje `falhaInesperada` é genérico e não finaliza a instância)', 'requer mudança em imagem-backup-operacional.service.js');
  todo('PGD-12b — `abrir()` do snapshot sem prazo seguro (D6): um prazo vencido NÃO comprova o encerramento da conexão nem autoriza liberar a trava; definir cancelamento, espera da operação pendente e retenção', 'requer mudança em imagem-backup-snapshot.service.js e decisão de contrato');
  todo('PGD-12c — isolamento de `this`: as funções capturadas são chamadas com `apply(objetoDoChamador)`; um objeto mutável pode alterar o comportamento por estado interno; avaliar encapsulamento por cópia ou ligação imutável', 'requer decisão e mudança em imagem-backup-operacional.service.js');
  todo('PGD-12d — proteção contra reutilização do PGID e identidade do grupo (sinais e consulta só valem para o grupo comprovado)', 'depende de processos reais');
  todo('PGD-12e — compatibilidade de versão entre o cliente pg_dump e o servidor, e prova de que o `--snapshot` pertence ao MESMO servidor (identidade de cluster)', 'depende de PostgreSQL e pg_dump reais');
  todo('PGD-12f — remover `lancador`, `sistema` e `arquivos` da superfície pública (D8): a ligação operacional importa as implementações reais de um módulo interno', 'decisão arquitetural D8');
  todo('PGD-12g — permissões reais do PGPASSFILE (0600, dono correto) e do arquivo de saída; criação exclusiva sem seguir links no sistema de arquivos real', 'depende de sistema de arquivos real');
  todo('PGD-12h — hash, tamanho e manifesto do arquivo gerado, `pg_restore --list` e restauração independente: `recuperavel` só pode mudar com essa prova', 'incrementos posteriores');
});

// =============================================================================================================================== RED-2
// [nome, valor, vemDeConexaoComControle] — valores FICTÍCIOS. O terceiro campo marca os que o próprio snapshot já recusa (controle/separadores).
const NOMES_DE_BANCO_HOSTIS = [
  ['URI postgresql://', 'postgresql://u:p@h/db', false],
  ['URI postgres://', 'postgres://h/db', false],
  ['URI sem host', 'postgresql:///gestao_epi', false],
  ['string de conexão host=... dbname=...', 'host=h dbname=d', false],
  ['dbname= sozinho', 'dbname=gestao_epi', false],
  ['com sinal de igual', 'gestao_epi=1', false],
  ['chave=valor', 'a=b', false],
  ['com aspas simples', "gestao'epi", false],
  ['com aspas duplas', 'gestao"epi', false],
  ['com barra invertida', 'gestao\\epi', false],
  ['com porcentagem', 'gestao%20epi', false],
  ['com arroba', 'u@h', false],
  ['com dois-pontos', 'h:5432', false],
  ['com barra', 'a/b', false],
  ['com interrogação (parâmetros de URI)', 'gestao?sslmode=disable', false],
  ['com NUL', 'gestao_epi\0', true],
  ['com BEL', 'gestao_epi\u0007', true],
  ['com quebra de linha', 'gestao_epi\n', true],
  ['com separador de linha U+2028', 'gestao_epi ', true],
];

// ------------------------------------------------------------------------------------------------------------------------------- PGD-13: --dbname
describe('[PGD-13] `--dbname` nunca é interpretado como string de conexão', () => {
  for (const [rotulo, nome] of NOMES_DE_BANCO_HOSTIS) {
    teste(`PGD-13 (contexto e esperado IGUAIS, ${rotulo}) — a igualdade não valida: recusado na construção por TypeError; nenhum arquivo, nenhum processo`, () => {
      const m = criarMundo();
      const dump = { ...m.dump, alvo: { ...m.dump.alvo, bancoEsperado: { nome, oid: '16384' } } };
      const contexto = contextoValido({ banco: Object.freeze({ nome, oid: '16384' }) });
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto, dump }), TypeError);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });

    teste(`PGD-13b (banco esperado na configuração, ${rotulo}) — saída 2 ANTES da trava: nada adquirido, nenhuma conexão, nenhum arquivo, nenhum processo`, async () => {
      const m = criarMundo();
      const dump = { ...m.dump, alvo: { ...m.dump.alvo, bancoEsperado: { nome, oid: '16384' } } };
      const r = await pgdump().executarBackupPgDump({ ...m.dependencias, dump });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(r.recuperavel, false);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.criarConexao, 0);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
      assert.equal(m.linha.length, 0);
    });

    if (nome.length > 0) {
      teste(`PGD-13c (a conexão do snapshot REPORTA o nome, ${rotulo}) — nunca chega ao pg_dump (com controle o snapshot nem abre; sem controle há retenção conservadora, D1); em ambos, nenhum arquivo e nenhum processo`, async () => {
        const m = criarMundo({ banco: { nome, oid: '16384' } });
        const r = await rodar(m);
        assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
        assert.equal(m.contagem.copia + m.contagem.avaliar, 0);
        assert.equal(r.valido, false);
        assert.equal(r.recuperavel, false);
        const log = m.clientes[0].log;
        if (NOMES_DE_BANCO_HOSTIS.find(([, v]) => v === nome)[2]) {
          // O snapshot recusa a identidade: a abertura falha, a transação é finalizada e a trava é liberada de forma segura.
          assert.equal(contar(log, 'ROLLBACK'), 1);
          assert.equal(contar(log, 'end'), 1);
          assert.equal(r.saida, SAIDAS.INVALIDO);
        } else {
          // O snapshot abre, mas o construtor recusa o banco divergente: nada foi iniciado, ainda assim a trava fica retida (D1).
          assert.equal(contar(log, 'ROLLBACK') + contar(log, 'end'), 0);
          assert.equal(r.finalizacao, 'ADIADA');
          assert.equal(r.janela, 'RETIDA');
          assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
          assert.equal(m.estado.liberacoes, 0);
        }
      });
    }
  }

  teste('PGD-13d — o valor hostil nunca é "limpo" para virar válido: o `--dbname` do spec, quando há spec, é SEMPRE exatamente o nome do contexto e o nome hostil nunca é reduzido ao trecho final', async () => {
    const m = criarMundo({ banco: { nome: 'postgresql://h/gestao_epi', oid: '16384' } });
    const r = await rodar(m);
    assert.equal(m.contagem.lancar, 0, 'nada de --dbname=gestao_epi extraído da URI');
    assert.equal(m.chamadas.lancar.length, 0);
    assert.equal(r.valido, false);
  });

  for (const [rotulo, valor] of [['espaço inicial', ` ${ID_SNAPSHOT}`], ['quebra de linha final', `${ID_SNAPSHOT}\n`], ['NUL final', `${ID_SNAPSHOT}\0`]]) {
    teste(`PGD-13e (snapshotId com ${rotulo}) — recusado, nunca normalizado ("aparado"): o construtor lança TypeError e o spec nunca contém o id limpo`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido({ snapshotId: valor }), dump: m.dump }), TypeError);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }

  for (const [rotulo, valor] of [['espaço inicial', ` ${ID_SNAPSHOT}`], ['quebra de linha final', `${ID_SNAPSHOT}\n`]]) {
    teste(`PGD-13f (a conexão exporta um id com ${rotulo}) — a abertura falha e nada é lançado nem criado; o id não é aparado`, async () => {
      const m = criarMundo({ idSnapshot: valor });
      const r = await rodar(m);
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
      assert.equal(r.valido, false);
      assert.equal(m.chamadas.lancar.length, 0);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-14: autenticidade da composição
describe('[PGD-14] a origem do contexto só pode ser o snapshot aberto: nenhuma porta para injetar contexto, id ou descrição', () => {
  for (const chave of ['contexto', 'snapshotId', 'processoDoDump', 'descricao', 'iniciar', 'grupo', 'sinais', 'argumentos', 'comando']) {
    teste(`PGD-14 (chave "${chave}" dentro de dump) — saída 2 antes da trava, sem efeito`, async () => {
      const m = criarMundo();
      const valor = chave === 'contexto' ? contextoValido() : (chave === 'snapshotId' ? ID_SNAPSHOT : () => ({}));
      const r = await pgdump().executarBackupPgDump({ ...m.dependencias, dump: { ...m.dump, [chave]: valor } });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  for (const chave of ['snapshotId', 'contexto', 'dbname', 'urlDoBanco', 'stringDeConexao']) {
    teste(`PGD-14b (chave "${chave}" dentro de alvo) — saída 2 antes da trava, sem efeito`, async () => {
      const m = criarMundo();
      const r = await pgdump().executarBackupPgDump({ ...m.dependencias, dump: { ...m.dump, alvo: { ...m.dump.alvo, [chave]: 'postgresql://h/db' } } });
      assert.equal(r.saida, SAIDAS.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.linha.length, 0);
    });
  }

  teste('PGD-14c — um contexto "plausível" (congelado, com o formato certo) entregue por QUALQUER chave nunca é usado: o `--snapshot` do spec é sempre o exportado pela conexão desta operação', async () => {
    const m = criarMundo({ idSnapshot: '000000B2-000000C3-9' });
    const r = pgdump().executarBackupPgDump({ ...m.dependencias, contexto: contextoValido({ snapshotId: '000000FF-00000001-1' }) });
    assert.equal((await r).saida, SAIDAS.ARGUMENTOS, 'recusado antes de tudo');
    const m2 = criarMundo({ idSnapshot: '000000B2-000000C3-9' });
    const pendente = rodar(m2);
    await ate(m2.lancado.promessa, pendente, 'o processo ser lançado');
    assert.ok(m2.chamadas.lancar[0].argumentos.includes('--snapshot=000000B2-000000C3-9'));
    assert.equal(m2.chamadas.lancar[0].argumentos.some((a) => a.includes('000000FF-00000001-1')), false);
    m2.encerrar();
    await pendente;
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-15: caminho e links (D9)
describe('[PGD-15] arquivo de destino: caminho canônico e recusa por link em qualquer componente', () => {
  for (const [rotulo, diretorio] of [['barra dupla', '/var/backups//safework'], ['componente "."', '/var/backups/./safework'], ['barra final', '/var/backups/safework/'], ['esquema file://', 'file:///var/backups']]) {
    teste(`PGD-15 (diretório com ${rotulo}) — não canônico: recusado na construção, nenhum arquivo criado`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, destino: { ...m.dump.destino, diretorio } } }), TypeError);
      assert.equal(m.contagem.criarArquivo, 0);
    });
  }
  for (const [rotulo, nome] of [['"."', '.'], ['".."', '..']]) {
    teste(`PGD-15b (nome ${rotulo}) — recusado na construção, nenhum arquivo criado`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, destino: { ...m.dump.destino, nome } } }), TypeError);
      assert.equal(m.contagem.criarArquivo, 0);
    });
  }

  for (const codigo of ['ELOOP', 'ENOTDIR', 'EEXIST']) {
    teste(`PGD-15c (o sistema recusa por ${codigo}: link em componente do caminho ou arquivo já existente) — uma única tentativa, nenhum caminho alternativo, o processo NUNCA é lançado, trava RETIDA (D1), transação aberta, nada vaza`, async () => {
      const m = criarMundo({ criarArquivoFalha: Object.assign(new Error(`${codigo} ${SENHA_ARQUIVO} password=${SEGREDO}`), { code: codigo }) });
      const { resultado: r, chamadas } = await comConsoleEspiado(() => rodar(m));
      assert.equal(m.contagem.criarArquivo, 1, 'o módulo não tenta de novo nem em outro caminho');
      assert.equal(m.contagem.lancar, 0);
      assert.equal(m.contagem.fechar, 0);
      assert.equal(r.finalizacao, 'ADIADA');
      assert.equal(r.janela, 'RETIDA');
      assert.equal(m.estado.liberacoes, 0);
      assert.equal(m.clientes[0].log.includes('ROLLBACK'), false);
      semMarcadores(r, 'resultado');
      semMarcadores(chamadas.join('\n'), 'console');
    });
  }

  teste('PGD-15d — o pedido ao sistema de arquivos é EXATAMENTE o validado (nenhuma normalização, resolução ou troca do caminho pelo módulo), com modo 0600 e sem seguir links', async () => {
    const m = criarMundo();
    const pendente = rodar(m);
    await ate(m.lancado.promessa, pendente, 'o processo ser lançado');
    assert.deepEqual(m.chamadas.criarArquivo, [{ diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump', modo: 0o600, semSeguirLinks: true }]);
    m.encerrar();
    await pendente;
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-12 (complemento)
describe('[PGD-12 complemento] exigências PRÉ-OPERACIONAIS adicionais (não executam)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('PGD-12i — `criarProcessoDoDump` é exportado só para teste: o contexto congelado NÃO prova a origem; a aplicação real não pode expor o construtor a chamadores não confiáveis (ex.: marca interna, fechamento privado ou módulo não exportado)', 'decisão arquitetural no GREEN');
  todo('PGD-12j — o `stderr` do pg_dump é descartado nesta fase provisória; antes da operação real é preciso um diagnóstico seguro e limitado (códigos e contagens, nunca texto bruto)', 'requer decisão e implementação');
  todo('PGD-12k — o caminho absoluto terminado em /pg_dump não comprova a identidade do binário: a seleção do executável confiável deve vir de configuração operacional protegida (dono, permissões, versão)', 'configuração operacional');
  todo('PGD-12l — links simbólicos em componentes ANCESTRAIS do destino e do PGPASSFILE só se verificam no sistema de arquivos real (abertura sem seguir links, `openat`/O_NOFOLLOW por componente)', 'depende de sistema de arquivos real');
  todo('PGD-12m — LANÇADOR que devolve pid inválido DEPOIS de possivelmente iniciar o processo: bloqueio de alta severidade. A supervisão não assume o controle, o módulo não distingue falha comprovada de lançamento inconclusivo, e nada pode ser sinalizado por presunção. O lançador real precisa de contrato próprio (resolver só depois do evento `spawn`, rejeitar só se nada iniciou, devolver sempre pid/grupo válidos ou conter o filho)', 'contrato do lançador real');
});

// =============================================================================================================================== CORREÇÃO FOCAL
const erroHostil = () => new TypeError(`${SEGREDO} ${HOST} inválido`);
const comGetter = (objeto, chave, get) => Object.defineProperty(objeto, chave, { enumerable: true, configurable: true, get });
const publico = (erro) => `${erro.message} ${String(erro)} ${JSON.stringify(erro)} ${String(erro.code)}`;
const zeros = Object.freeze({ lancar: 0, grupoVivo: 0, enviarSinal: 0, criarExclusivo: 0 });

// ------------------------------------------------------------------------------------------------------------------------------- PGD-16: métodos capturados
describe('[PGD-16] os MÉTODOS validados são capturados: trocá-los depois não tem efeito (isolamento parcial de `this` registrado)', () => {
  teste('PGD-16 — depois da construção, `lancar`, `grupoVivo`, `enviarSinal` e `criarExclusivo` são substituídos por funções hostis: só as capturadas rodam', async () => {
    const m = criarMundo();
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: m.dump });
    const hostil = { ...zeros };
    m.lancador.lancar = async () => { hostil.lancar += 1; throw new Error('hostil'); };
    m.sistema.grupoVivo = async () => { hostil.grupoVivo += 1; return true; };
    m.sistema.enviarSinal = async () => { hostil.enviarSinal += 1; return false; };
    m.arquivos.criarExclusivo = async () => { hostil.criarExclusivo += 1; throw new Error('hostil'); };
    const processo = await descricao.iniciar();
    assert.equal(await descricao.grupo.vivos(processo.pgid), false);
    assert.equal(await descricao.sinais.enviar(processo.pgid, 'SIGTERM'), true);
    assert.deepEqual(hostil, zeros);
    assert.deepEqual([m.contagem.lancar, m.contagem.criarArquivo, m.contagem.grupoVivo, m.contagem.enviarSinal], [1, 1, 1, 1]);
    m.encerrar();
    await processo.fluxosFechados;
  });

  teste('PGD-16b — CONTROLE: os métodos capturados continuam sendo chamados com o `this` do objeto de origem (sem reler a propriedade)', async () => {
    const m = criarMundo();
    const vistos = [];
    const lancador = { id: 'L', async lancar(spec) { vistos.push(this === lancador); return m.lancador.lancar(spec); } };
    const sistema = {
      id: 'S',
      async grupoVivo(pgid) { vistos.push(this === sistema); return m.sistema.grupoVivo(pgid); },
      async enviarSinal(pgid, sinal) { vistos.push(this === sistema); return m.sistema.enviarSinal(pgid, sinal); },
    };
    const arquivos = { id: 'A', async criarExclusivo(spec) { vistos.push(this === arquivos); return m.arquivos.criarExclusivo(spec); } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: { ...m.dump, lancador, sistema, arquivos } });
    const processo = await descricao.iniciar();
    await descricao.grupo.vivos(processo.pgid);
    await descricao.sinais.enviar(processo.pgid, 'SIGINT');
    assert.deepEqual(vistos, [true, true, true, true]);
    m.encerrar();
    await processo.fluxosFechados;
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-17: leitura única dos retornos
describe('[PGD-17] o que o lançador e o sistema de arquivos DEVOLVEM é lido uma única vez', () => {
  teste('PGD-17 — `pid`, `saida` e `fluxosFechados` do processo: cada propriedade é lida UMA vez; a segunda leitura (hostil) nunca é usada', async () => {
    const m = criarMundo();
    const saida = adiado();
    const fluxos = adiado();
    const lidos = { pid: 0, saida: 0, fluxosFechados: 0 };
    const processo = {};
    comGetter(processo, 'pid', () => { lidos.pid += 1; return lidos.pid === 1 ? PID : 1; });
    comGetter(processo, 'saida', () => { lidos.saida += 1; return lidos.saida === 1 ? saida.promessa : 'invalido'; });
    comGetter(processo, 'fluxosFechados', () => { lidos.fluxosFechados += 1; return lidos.fluxosFechados === 1 ? fluxos.promessa : 'invalido'; });
    const dump = { ...m.dump, lancador: { async lancar() { return processo; } } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump });
    const devolvido = await descricao.iniciar();
    assert.deepEqual(lidos, { pid: 1, saida: 1, fluxosFechados: 1 });
    assert.equal(devolvido.pgid, PID);
    assert.equal(devolvido.saida, saida.promessa);
    assert.equal(m.contagem.fechar, 0);
    fluxos.resolver();
    await devolvido.fluxosFechados;
    assert.equal(m.contagem.fechar, 1);
  });

  teste('PGD-17b — `descritor` e `fechar` do arquivo criado: lidos UMA vez; o `stdio` usa o descritor da primeira leitura e o fechamento usa a função da primeira leitura', async () => {
    const m = criarMundo();
    const lidos = { descritor: 0, fechar: 0 };
    let fechou = 0;
    const criado = {};
    comGetter(criado, 'descritor', () => { lidos.descritor += 1; return lidos.descritor === 1 ? DESCRITOR : -1; });
    comGetter(criado, 'fechar', () => { lidos.fechar += 1; return lidos.fechar === 1 ? function fechar() { fechou += 1; } : 'nao-e-funcao'; });
    const dump = { ...m.dump, arquivos: { async criarExclusivo() { return criado; } } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump });
    const devolvido = await descricao.iniciar();
    assert.deepEqual(m.chamadas.lancar[0].opcoes.stdio, ['ignore', DESCRITOR, 'ignore']);
    m.encerrar();
    await devolvido.fluxosFechados;
    assert.deepEqual(lidos, { descritor: 1, fechar: 1 });
    assert.equal(fechou, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PGD-18: getters hostis e códigos de erro
describe('[PGD-18] getters hostis nunca vazam mensagem: construtor público, contexto e códigos de erro', () => {
  const capturas = [
    ['alvo (getter no dump)', (m) => ({ ...m.dump, get alvo() { throw erroHostil(); } })],
    ['host', (m) => ({ ...m.dump, alvo: comGetter({ ...m.dump.alvo }, 'host', () => { throw erroHostil(); }) })],
    ['diretório', (m) => ({ ...m.dump, destino: comGetter({ ...m.dump.destino }, 'diretorio', () => { throw erroHostil(); }) })],
    ['prazo total', (m) => ({ ...m.dump, prazos: comGetter({ ...m.dump.prazos }, 'totalMs', () => { throw erroHostil(); }) })],
    ['prazo do temporizador', (m) => ({ ...m.dump, temporizador: comGetter({ intervalo: m.dump.temporizador.intervalo }, 'prazo', () => { throw erroHostil(); }) })],
    ['método do lançador', (m) => ({ ...m.dump, lancador: comGetter({}, 'lancar', () => { throw erroHostil(); }) })],
  ];
  for (const [rotulo, montar] of capturas) {
    teste(`PGD-18 (getter hostil em ${rotulo}) — TypeError PÚBLICO sem a mensagem do getter (mesmo terminando em "inválido"); nada é criado nem lançado`, () => {
      const m = criarMundo();
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump: montar(m) }), (erro) => {
        assert.ok(erro instanceof TypeError);
        semMarcadores(publico(erro), 'erro público do construtor');
        return true;
      });
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }

  teste('PGD-18b — getter hostil nos argumentos do construtor: TypeError público sem a mensagem do getter', () => {
    const m = criarMundo();
    const argumentos = { dump: m.dump };
    comGetter(argumentos, 'contexto', () => { throw erroHostil(); });
    assert.throws(() => pgdump().criarProcessoDoDump(argumentos), (erro) => { assert.ok(erro instanceof TypeError); semMarcadores(publico(erro), 'erro público'); return true; });
  });

  for (const [rotulo, montar] of [
    ['snapshotId', () => comGetter({ banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros: {}, plano: null }, 'snapshotId', () => { throw erroHostil(); })],
    ['banco.nome', () => ({ snapshotId: ID_SNAPSHOT, banco: Object.freeze(comGetter({ oid: '16384' }, 'nome', () => { throw erroHostil(); })), registros: {}, plano: null })],
  ]) {
    teste(`PGD-18c (getter hostil em contexto.${rotulo}) — TypeError público sem a mensagem do getter, nada criado`, () => {
      const m = criarMundo();
      const contexto = Object.freeze(montar());
      assert.throws(() => pgdump().criarProcessoDoDump({ contexto, dump: m.dump }), (erro) => { assert.ok(erro instanceof TypeError); semMarcadores(publico(erro), 'erro público'); return true; });
      assert.equal(m.contagem.criarArquivo + m.contagem.lancar, 0);
    });
  }

  teste('PGD-18d — CONTROLE na composição: getter hostil na configuração do dump é recusado com saída 2 antes da trava, sem a mensagem no resultado', async () => {
    const m = criarMundo();
    const dump = { ...m.dump, alvo: comGetter({ ...m.dump.alvo }, 'host', () => { throw erroHostil(); }) };
    const r = await pgdump().executarBackupPgDump({ ...m.dependencias, dump });
    assert.equal(r.saida, SAIDAS.ARGUMENTOS);
    semMarcadores(r, 'resultado');
    assert.equal(m.estado.aquisicoes, 0);
    assert.equal(m.linha.length, 0);
  });

  teste('PGD-18e — `code` do erro lido UMA vez: um getter que devolve um código válido nas primeiras leituras e um valor sensível depois NÃO vaza na rejeição de `iniciar()`', async () => {
    const m = criarMundo();
    let leituras = 0;
    const falha = new Error('x');
    Object.defineProperty(falha, 'code', { get() { leituras += 1; return leituras <= 2 ? 'EACCES' : SEGREDO; } });
    const dump = { ...m.dump, lancador: { async lancar() { throw falha; } } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump });
    await assert.rejects(() => descricao.iniciar(), (erro) => {
      semMarcadores(publico(erro), 'rejeição de iniciar');
      assert.ok(erro.code === undefined || erro.code === 'EACCES');
      return true;
    });
    assert.equal(leituras, 1, 'uma única leitura de `code`');
    assert.equal(m.contagem.fechar, 1);
  });

  teste('PGD-18f — `code` do erro cujo getter LANÇA: a rejeição de `iniciar()` continua segura (nada da exceção do getter), e o descritor é fechado', async () => {
    const m = criarMundo();
    const falha = new Error('x');
    Object.defineProperty(falha, 'code', { get() { throw new Error(`${SEGREDO} ${HOST}`); } });
    const dump = { ...m.dump, lancador: { async lancar() { throw falha; } } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump });
    await assert.rejects(() => descricao.iniciar(), (erro) => { semMarcadores(publico(erro), 'rejeição de iniciar'); return true; });
    assert.equal(m.contagem.fechar, 1);
  });

  teste('PGD-18g — `code` com getter hostil também em `criarExclusivo`: a rejeição continua segura e o processo nunca é lançado', async () => {
    const m = criarMundo();
    const falha = new Error('x');
    Object.defineProperty(falha, 'code', { get() { throw new Error(`${SEGREDO} ${HOST}`); } });
    const dump = { ...m.dump, arquivos: { async criarExclusivo() { throw falha; } } };
    const descricao = pgdump().criarProcessoDoDump({ contexto: contextoValido(), dump });
    await assert.rejects(() => descricao.iniciar(), (erro) => { semMarcadores(publico(erro), 'rejeição de iniciar'); return true; });
    assert.equal(m.contagem.lancar, 0);
  });
});
