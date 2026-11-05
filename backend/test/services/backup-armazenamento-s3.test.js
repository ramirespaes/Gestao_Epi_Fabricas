'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S3 = require('../../src/services/backup-armazenamento-s3.service');
const { criarS3Falso } = require('../helpers/s3-falso');
const { fichaDeTeste, fichaEntreContas, registro, registroDeTeste } = require('../helpers/fichas-duraveis');

/** R-D45 [PRE] e [S3]: pré-voo, enviador S3, confirmação, estados incertos e recibos. Cliente S3 FALSO injetado; arquivos locais SINTÉTICOS; nenhuma rede. */

const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-s3-'));
fs.chmodSync(raiz, 0o700);
after(() => fs.rmSync(raiz, { recursive: true, force: true }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let contador = 0;
function arquivo(conteudo = `conteudo-${contador}`) {
  contador += 1;
  const caminho = path.join(raiz, `arq-${contador}.bin`);
  fs.writeFileSync(caminho, conteudo, { mode: 0o600 });
  return { caminho, sha256: sha(Buffer.from(conteudo)), bytes: Buffer.byteLength(conteudo), conteudo: Buffer.from(conteudo) };
}
const ficha = registro(fichaDeTeste('HOMOLOGACAO'))[0];
const lista = registroDeTeste();
const IDS_PRE_VOO = ['IDENTIDADE_PUBLICADOR', 'AUTORIZACAO_ENTRE_CONTAS', 'DONO_DO_DESTINO', 'REGIAO', 'VERSIONAMENTO', 'OBJECT_LOCK', 'RETENCAO_PADRAO', 'CRIPTOGRAFIA_PADRAO', 'PROPRIEDADE_DO_OBJETO', 'CHAVE_MAC', 'CHAVE_CIFRA'];

function montar({ ficha: f = ficha, registroDeTeste: reg = lista, config, identidades, bloco } = {}) {
  let agora = 1_800_000_000_000;
  const relogio = () => agora;
  const s3 = criarS3Falso({ ficha: f, relogio, config, identidades, bloco });
  const env = (o = {}) => S3.criarEnviadorS3({ destinoId: f.id, ambiente: f.ambiente, cliente: s3.clientes.publicador, relogio, prazoMs: 500, registro: reg, ...o });
  return { s3, env, avancar: (ms) => { agora += ms; }, relogio };
}
const item = (r, id) => r.itens.find((i) => i.id === id);
const preparado = async (m, o) => { const e = m.env(o); const pre = await e.executarPreVoo(); assert.equal(pre.ok, true, JSON.stringify(pre.itens)); return e; };
const chave = 'dados/a.enc';

describe('[PRE] pré-voo: nada é enviado sem comprovar identidade, dono, região, versionamento, lock, retenção, criptografia, propriedade e chaves', () => {
  test('PRE-01 — ambiente conforme: onze itens aprovados, na ordem; mesma conta; só identidade, configuração e descrição das chaves são consultadas', async () => {
    const m = montar();
    const r = await m.env().executarPreVoo();
    assert.equal(r.ok, true);
    assert.deepEqual(r.itens.map((i) => i.id), IDS_PRE_VOO);
    assert.ok(r.itens.every((i) => i.ok === true));
    assert.equal(item(r, 'AUTORIZACAO_ENTRE_CONTAS').codigo, 'MESMA_CONTA');
    assert.deepEqual(m.s3.chamadas.map((c) => c.operacao), ['identidade', 'lerConfiguracaoDoBucket', 'descreverChave', 'descreverChave']);
    assert.equal(r.validoAte, 1_800_000_000_000 + 600000);
  });

  test('PRE-02 — identidade errada (conta, principal, administrador): recusa, os itens seguintes não são executados e NENHUMA chamada ao bucket é feita', async () => {
    const casos = [
      [{ publicador: { contaId: '999999999999', tipo: 'user', nome: 'safework-hml-publicador' } }, 'CONTA_DIVERGENTE'],
      [{ publicador: { contaId: '111111111111', tipo: 'user', nome: 'safework-hml-verificador' } }, 'PRINCIPAL_DIVERGENTE'],
      [{ publicador: { contaId: '111111111111', tipo: 'user', nome: 'administrador' } }, 'PRINCIPAL_DIVERGENTE'],
      [{ publicador: { contaId: '111111111111', tipo: 'role', nome: 'safework-hml-publicador' } }, 'PRINCIPAL_DIVERGENTE'],
    ];
    for (const [identidades, codigo] of casos) {
      const m = montar({ identidades });
      const r = await m.env().executarPreVoo();
      assert.equal(r.ok, false);
      assert.deepEqual({ ...item(r, 'IDENTIDADE_PUBLICADOR') }, { id: 'IDENTIDADE_PUBLICADOR', ok: false, codigo });
      assert.ok(r.itens.filter((i) => !['IDENTIDADE_PUBLICADOR', 'AUTORIZACAO_ENTRE_CONTAS'].includes(i.id)).every((i) => i.ok === false && i.codigo === 'NAO_EXECUTADO'));
      assert.deepEqual(m.s3.chamadas.map((c) => c.operacao), ['identidade']);
    }
  });

  test('PRE-03 — cada desvio de configuração reprova o item certo com código fixo e bloqueia o envio', async () => {
    const casos = [
      [{ donoConfirmado: false }, 'DONO_DO_DESTINO', 'DONO_NAO_CONFIRMADO'],
      [{ regiao: 'sa-east-1' }, 'REGIAO', 'REGIAO_DIVERGENTE'],
      [{ versionamento: 'Suspended' }, 'VERSIONAMENTO', 'VERSIONAMENTO_NAO_HABILITADO'],
      [{ versionamento: null }, 'VERSIONAMENTO', 'VERSIONAMENTO_NAO_HABILITADO'],
      [{ objectLock: { habilitado: false, modo: null, dias: null } }, 'OBJECT_LOCK', 'OBJECT_LOCK_AUSENTE'],
      [{ objectLock: { habilitado: true, modo: null, dias: null } }, 'RETENCAO_PADRAO', 'RETENCAO_AUSENTE'],
      [{ objectLock: { habilitado: true, modo: 'COMPLIANCE', dias: 7 } }, 'RETENCAO_PADRAO', 'MODO_DIVERGENTE'],
      [{ objectLock: { habilitado: true, modo: 'GOVERNANCE', dias: 3 } }, 'RETENCAO_PADRAO', 'DIAS_INSUFICIENTES'],
      [{ criptografiaPadrao: null }, 'CRIPTOGRAFIA_PADRAO', 'CRIPTOGRAFIA_PADRAO_DIVERGENTE'],
      [{ criptografiaPadrao: 'aws:kms' }, 'CRIPTOGRAFIA_PADRAO', 'CRIPTOGRAFIA_PADRAO_DIVERGENTE'],
      [{ propriedade: 'ObjectWriter' }, 'PROPRIEDADE_DO_OBJETO', 'PROPRIEDADE_NAO_ENFORCED'],
    ];
    for (const [config, id, codigo] of casos) {
      const m = montar({ config });
      const e = m.env();
      const r = await e.executarPreVoo();
      assert.equal(r.ok, false, JSON.stringify(config));
      assert.deepEqual({ ...item(r, id) }, { id, ok: false, codigo }, JSON.stringify(config));
      const a = arquivo();
      assert.deepEqual({ ...(await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })) }, { estado: 'RECUSADO', motivo: 'PRE_VOO_AUSENTE_OU_EXPIRADO' });
      assert.equal(m.s3.chamadas.some((c) => c.operacao === 'gravarObjeto'), false);
    }
    const mais = montar({ config: { objectLock: { habilitado: true, modo: 'GOVERNANCE', dias: 30 } } });
    assert.equal((await mais.env().executarPreVoo()).ok, true, 'retenção padrão MAIOR que a da ficha é aceita');
  });

  test('PRE-04 — chaves KMS desabilitadas, em exclusão ou assimétricas reprovam; falha, resposta fora do contrato e prazo viram FALHA_AO_CONSULTAR sem eco', async () => {
    for (const [estado, codigo] of [[{ estado: 'Disabled', especificacao: 'SYMMETRIC_DEFAULT' }, 'CHAVE_KMS_NAO_HABILITADA'], [{ estado: 'PendingDeletion', especificacao: 'SYMMETRIC_DEFAULT' }, 'CHAVE_KMS_NAO_HABILITADA'], [{ estado: 'Enabled', especificacao: 'RSA_2048' }, 'CHAVE_KMS_NAO_SIMETRICA']]) {
      const m = montar();
      m.s3.definirChave(ficha.chaveCifra, estado);
      const r = await m.env().executarPreVoo();
      assert.equal(r.ok, false);
      assert.deepEqual({ ...item(r, 'CHAVE_CIFRA') }, { id: 'CHAVE_CIFRA', ok: false, codigo });
      assert.equal(item(r, 'CHAVE_MAC').ok, true);
    }
    const base = montar().s3.clientes.publicador;
    const defeitos = [
      { ...base, lerConfiguracaoDoBucket: async () => { throw new Error('detalhe-interno-secreto'); } },
      { ...base, lerConfiguracaoDoBucket: async () => null },
      { ...base, lerConfiguracaoDoBucket: async () => ({ regiao: ficha.regiao }) },
      { ...base, lerConfiguracaoDoBucket: async () => new Promise(() => {}) },
    ];
    for (const cliente of defeitos) {
      const m = montar();
      const r = await m.env({ cliente, prazoMs: 40 }).executarPreVoo();
      assert.equal(r.ok, false);
      for (const id of ['DONO_DO_DESTINO', 'REGIAO', 'VERSIONAMENTO', 'OBJECT_LOCK', 'RETENCAO_PADRAO', 'CRIPTOGRAFIA_PADRAO', 'PROPRIEDADE_DO_OBJETO']) assert.deepEqual({ ...item(r, id) }, { id, ok: false, codigo: 'FALHA_AO_CONSULTAR' });
      assert.equal(JSON.stringify(r).includes('secreto'), false);
    }
    const semIdentidade = montar();
    const r = await semIdentidade.env({ cliente: { ...base, identidade: async () => { throw new Error('x'); } } }).executarPreVoo();
    assert.deepEqual({ ...item(r, 'IDENTIDADE_PUBLICADOR') }, { id: 'IDENTIDADE_PUBLICADOR', ok: false, codigo: 'FALHA_AO_CONSULTAR' });
  });

  test('PRE-05 — o pré-voo vale por um tempo; sem ele, ou depois dele, o envio é recusado e nada é chamado; um pré-voo reprovado invalida o anterior', async () => {
    const m = montar();
    const a = arquivo();
    const pedido = { caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes };
    const e = m.env({ ttlPreVooMs: 5000 });
    assert.equal((await e.enviarArquivo(pedido)).motivo, 'PRE_VOO_AUSENTE_OU_EXPIRADO');
    assert.equal((await e.executarPreVoo()).ok, true);
    m.avancar(5001);
    assert.equal((await e.enviarArquivo(pedido)).motivo, 'PRE_VOO_AUSENTE_OU_EXPIRADO');
    assert.equal((await e.executarPreVoo()).ok, true);
    assert.equal((await e.enviarArquivo(pedido)).estado, 'GRAVADO');
    const m2 = montar();
    const e2 = await preparado(m2);
    m2.s3.definirChave(ficha.chaveMac, { estado: 'Disabled', especificacao: 'SYMMETRIC_DEFAULT' });
    assert.equal((await e2.executarPreVoo()).ok, false);
    assert.equal((await e2.enviarArquivo(pedido)).motivo, 'PRE_VOO_AUSENTE_OU_EXPIRADO', 'um pré-voo reprovado apaga a validade do anterior');
  });

  test('PRE-06 — autorização entre contas: o publicador vive em outra conta, o dono esperado continua sendo o da ficha; credencial da conta errada é recusada', async () => {
    const entre = fichaEntreContas();
    const reg = registro(entre, fichaDeTeste('PRODUCAO'));
    const f = reg[0];
    const m = montar({ ficha: f, registroDeTeste: reg });
    const visto = [];
    const cliente = { ...m.s3.clientes.publicador, async gravarObjeto(p) { visto.push({ bucket: p.bucket, donoEsperado: p.donoEsperado, chave: p.chave }); return m.s3.clientes.publicador.gravarObjeto(p); } };
    const e = m.env({ cliente });
    const pre = await e.executarPreVoo();
    assert.equal(pre.ok, true, JSON.stringify(pre.itens));
    assert.equal(item(pre, 'AUTORIZACAO_ENTRE_CONTAS').codigo, 'ENTRE_CONTAS_A_COMPROVAR');
    const a = arquivo();
    assert.equal((await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).estado, 'GRAVADO');
    assert.deepEqual(visto, [{ bucket: 'safework-hml-backup-111111111111', donoEsperado: '111111111111', chave: 'hml/dados/a.enc' }]);
    const dono = montar({ ficha: f, registroDeTeste: reg, identidades: { publicador: { contaId: '111111111111', tipo: 'user', nome: 'administrador-do-bucket' } } });
    assert.equal(item(await dono.env().executarPreVoo(), 'IDENTIDADE_PUBLICADOR').codigo, 'CONTA_DIVERGENTE', 'a credencial do DONO do bucket não é a identidade do publicador');
  });
});

describe('[S3] envio, confirmação e recibos', () => {
  test('S3-01 — envio conforme: pedido ao cliente com bucket, dono, chave com prefixo, bytes, SHA-256 e condição de objeto novo; recibo completo; confirmação do contrato existente (de TESTE, nunca operacional)', async () => {
    const m = montar();
    const visto = [];
    const cliente = { ...m.s3.clientes.publicador, async gravarObjeto(p) { visto.push({ ...p, abrirFluxo: typeof p.abrirFluxo }); return m.s3.clientes.publicador.gravarObjeto(p); } };
    const e = await preparado(m, { cliente });
    const a = arquivo('conteudo cifrado sintético');
    const r = await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes });
    assert.equal(r.estado, 'GRAVADO');
    assert.deepEqual(visto, [{ bucket: ficha.bucket, donoEsperado: ficha.contaId, chave: `hml/${chave}`, bytes: a.bytes, sha256: a.sha256, abrirFluxo: 'function', naoSobrescrever: true }]);
    const versaoId = m.s3.versoes(`hml/${chave}`)[0].versaoId;
    assert.deepEqual({ ...r.recibo }, { versao: 1, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', bucket: ficha.bucket, chave: `hml/${chave}`, versaoId, sha256: a.sha256, bytes: a.bytes, gravadoEm: new Date(1_800_000_000_000).toISOString() });
    assert.ok(m.s3.conteudo(`hml/${chave}`, versaoId).equals(a.conteudo));
    assert.deepEqual(e.recibos().map((x) => x.chave), [`hml/${chave}`]);
    const confirmacao = await e.criarDestino({ prazoMs: 200 }).confirmarGravacao({ chave: `hml/${chave}`, sha256: a.sha256, bytes: a.bytes });
    assert.deepEqual([confirmacao.confirmado, confirmacao.operacional, confirmacao.origem], [true, false, 'TESTE_CONTROLADO']);
    assert.equal((await e.criarDestino({ prazoMs: 200 }).confirmarGravacao({ chave: `hml/${chave}`, sha256: 'c'.repeat(64), bytes: a.bytes })).confirmado, false, 'hash diferente do recibo não confirma');
  });

  test('S3-02 — privilégio mínimo: o cliente do publicador só tem quatro operações e o enviador nunca chama apagar, retenção, política, ciclo de vida, leitura de objeto ou listagem', async () => {
    const m = montar();
    const e = await preparado(m);
    const a = arquivo();
    await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes });
    assert.deepEqual(Object.keys(m.s3.clientes.publicador).sort(), ['descreverChave', 'gravarObjeto', 'identidade', 'lerConfiguracaoDoBucket']);
    assert.deepEqual([...new Set(m.s3.chamadas.map((c) => c.operacao))].sort(), ['descreverChave', 'gravarObjeto', 'identidade', 'lerConfiguracaoDoBucket']);
    assert.ok(m.s3.chamadas.every((c) => c.papel === 'publicador'));
  });

  test('S3-03 — objeto já existente: recusado, sem repetir e sem sobrescrever; a versão original permanece única', async () => {
    const m = montar();
    const a = arquivo('original');
    const e1 = await preparado(m);
    assert.equal((await e1.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).estado, 'GRAVADO');
    const e2 = await preparado(m);
    const novo = arquivo('outro conteudo');
    assert.deepEqual({ ...(await e2.enviarArquivo({ caminho: novo.caminho, chave, sha256: novo.sha256, bytes: novo.bytes })) }, { estado: 'RECUSADO', motivo: 'OBJETO_JA_EXISTE' });
    assert.equal(m.s3.versoes(`hml/${chave}`).length, 1);
    assert.equal(m.s3.versoes(`hml/${chave}`)[0].sha256, a.sha256);
    assert.equal(m.s3.chamadas.filter((c) => c.operacao === 'gravarObjeto').length, 2, 'uma chamada por tentativa, sem retentativa');
    assert.deepEqual(e2.recibos(), []);
  });

  test('S3-04 — a mesma chave duas vezes na mesma execução: a segunda é recusada sem chamar o cliente', async () => {
    const m = montar();
    const e = await preparado(m);
    const a = arquivo();
    assert.equal((await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).estado, 'GRAVADO');
    assert.deepEqual({ ...(await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })) }, { estado: 'RECUSADO', motivo: 'CHAVE_JA_USADA_NESTA_EXECUCAO' });
    assert.equal(m.s3.chamadas.filter((c) => c.operacao === 'gravarObjeto').length, 1);
  });

  test('S3-05 — resposta perdida, queda, atraso e reenvio interno do cliente são INCERTOS (nunca duráveis, sem recibo, sem confirmação); a chave fica bloqueada nesta execução', async () => {
    const casos = [['PERDER_RESPOSTA', 'RESPOSTA_PERDIDA_OU_ERRO', true], ['CAIR_ANTES', 'RESPOSTA_PERDIDA_OU_ERRO', false], ['LENTO', 'RESPOSTA_PERDIDA_OU_ERRO', false], ['REENVIO', 'EXISTENTE_APOS_TENTATIVA_AMBIGUA', true]];
    for (const [modo, motivo, gravou] of casos) {
      const m = montar();
      const e = await preparado(m, { prazoMs: 60 });
      const a = arquivo();
      m.s3.programarGravacao(modo);
      assert.deepEqual({ ...(await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })) }, { estado: 'INCERTO', motivo }, modo);
      assert.equal(m.s3.existe(`hml/${chave}`), gravou, modo);
      assert.deepEqual(e.recibos(), []);
      assert.equal((await e.criarDestino({ prazoMs: 200 }).confirmarGravacao({ chave: `hml/${chave}`, sha256: a.sha256, bytes: a.bytes })).confirmado, false);
      assert.equal((await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).motivo, 'CHAVE_JA_USADA_NESTA_EXECUCAO');
    }
  });

  test('S3-06 — falha DEFINITIVA (negado, dono divergente, checksum rejeitado) é FALHOU e permite nova tentativa; erro desconhecido é INCERTO; nenhum texto de erro é repassado', async () => {
    const base = montar().s3.clientes.publicador;
    const defeituoso = (code) => ({ ...base, gravarObjeto: async () => { throw Object.assign(new Error('detalhe-interno-secreto'), { code }); } });
    for (const [code, estado] of [['NEGADO', 'FALHOU'], ['DONO_DIVERGENTE', 'FALHOU'], ['CHECKSUM_REJEITADO', 'FALHOU'], ['ECONNRESET', 'INCERTO'], ['QUALQUER', 'INCERTO']]) {
      const m = montar();
      const e = await preparado(m, { cliente: { ...m.s3.clientes.publicador, gravarObjeto: defeituoso(code).gravarObjeto } });
      const a = arquivo();
      const r = await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes });
      assert.equal(r.estado, estado, code);
      assert.equal(JSON.stringify(r).includes('secreto'), false);
      if (estado === 'FALHOU') assert.equal(r.motivo, code);
    }
    const m = montar();
    const e = await preparado(m);
    const a = arquivo();
    m.s3.programarGravacao('NEGAR');
    assert.deepEqual({ ...(await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })) }, { estado: 'FALHOU', motivo: 'NEGADO' });
    assert.equal((await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).estado, 'GRAVADO', 'depois de uma falha definitiva a mesma chave pode ser tentada de novo');
  });

  test('S3-07 — resposta fora do contrato (hash, bytes, versão nula, campo extra, campo ausente) é INCERTA: sem recibo e sem confirmação', async () => {
    for (const modo of ['SHA_ERRADO', 'BYTES_ERRADOS', 'VERSAO_NULA', 'COM_EXTRA', 'INCOMPLETA']) {
      const m = montar();
      const e = await preparado(m);
      const a = arquivo();
      m.s3.programarGravacao(modo);
      assert.deepEqual({ ...(await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })) }, { estado: 'INCERTO', motivo: 'RESPOSTA_FORA_DO_CONTRATO' }, modo);
      assert.deepEqual(e.recibos(), []);
      assert.equal((await e.criarDestino({ prazoMs: 200 }).confirmarGravacao({ chave: `hml/${chave}`, sha256: a.sha256, bytes: a.bytes })).confirmado, false);
    }
  });

  test('S3-08 — arquivo local: link simbólico, diretório, ausente, tamanho e hash divergentes são recusados ANTES de qualquer chamada de envio', async () => {
    const m = montar();
    const e = await preparado(m);
    const a = arquivo();
    const elo = path.join(raiz, 'elo.bin');
    fs.symlinkSync(a.caminho, elo);
    const casos = [
      [{ caminho: elo, sha256: a.sha256, bytes: a.bytes }, 'ARQUIVO_LOCAL_INVALIDO'],
      [{ caminho: raiz, sha256: a.sha256, bytes: a.bytes }, 'ARQUIVO_LOCAL_INVALIDO'],
      [{ caminho: path.join(raiz, 'nao-existe.bin'), sha256: a.sha256, bytes: a.bytes }, 'ARQUIVO_LOCAL_INVALIDO'],
      [{ caminho: a.caminho, sha256: a.sha256, bytes: a.bytes + 1 }, 'ARQUIVO_LOCAL_INVALIDO'],
      [{ caminho: a.caminho, sha256: 'd'.repeat(64), bytes: a.bytes }, 'ARQUIVO_LOCAL_DIVERGENTE'],
    ];
    for (const [pedido, motivo] of casos) assert.deepEqual({ ...(await e.enviarArquivo({ chave, ...pedido })) }, { estado: 'FALHOU', motivo }, motivo);
    assert.equal(m.s3.chamadas.some((c) => c.operacao === 'gravarObjeto'), false);
  });

  test('S3-09 — entradas inválidas e arquivo acima do limite de uma gravação (5 GiB) são RECUSADOS; arquivo vazio é aceito', async () => {
    const m = montar();
    const e = await preparado(m);
    const a = arquivo();
    const ok = { caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes };
    const ruins = [{ caminho: 'relativo.bin' }, { caminho: '/tmp/../etc/x' }, { caminho: `${a.caminho}\0` }, { chave: '/abs' }, { chave: '../x' }, { chave: 'a//b' }, { chave: '' }, { sha256: 'A'.repeat(64) }, { sha256: 'abc' }, { bytes: -1 }, { bytes: 1.5 }, { extra: 1 }];
    for (const r of ruins) assert.deepEqual({ ...(await e.enviarArquivo({ ...ok, ...r })) }, { estado: 'RECUSADO', motivo: 'ENTRADA_INVALIDA' }, JSON.stringify(r));
    assert.deepEqual({ ...(await e.enviarArquivo({ ...ok, bytes: 5 * 1024 ** 3 + 1 })) }, { estado: 'RECUSADO', motivo: 'ARQUIVO_ACIMA_DO_LIMITE' });
    assert.equal(await e.enviarArquivo(null).then((r) => r.motivo), 'ENTRADA_INVALIDA');
    const vazio = arquivo('');
    assert.equal((await e.enviarArquivo({ caminho: vazio.caminho, chave: 'dados/vazio.enc', sha256: vazio.sha256, bytes: 0 })).estado, 'GRAVADO');
    assert.equal(m.s3.chamadas.filter((c) => c.operacao === 'gravarObjeto').length, 1, 'só o arquivo vazio chegou ao cliente');
  });

  test('S3-10 — o fluxo entregue ao cliente pode ser aberto mais de uma vez (reenvio interno) e sempre traz exatamente o conteúdo do arquivo, também com vários blocos', async () => {
    const m = montar();
    const conteudo = crypto.randomBytes(300 * 1024);
    const a = arquivo(conteudo);
    const lidos = [];
    const base = m.s3.clientes.publicador;
    const cliente = { ...base, async gravarObjeto(p) {
      for (let i = 0; i < 2; i += 1) { const partes = []; for await (const b of p.abrirFluxo()) partes.push(Buffer.from(b)); lidos.push(Buffer.concat(partes)); }
      return base.gravarObjeto(p);
    } };
    const e = await preparado(m, { cliente });
    assert.equal((await e.enviarArquivo({ caminho: a.caminho, chave, sha256: a.sha256, bytes: a.bytes })).estado, 'GRAVADO');
    assert.equal(lidos.length, 2);
    assert.ok(lidos.every((b) => b.equals(conteudo)));
  });
});

describe('[S3] destino autorizado e invariantes do módulo', () => {
  test('S3-11 — destino só pela ficha: lista real vazia recusa; id inexistente, ambiente divergente, opções inválidas e cliente incompleto são recusados', () => {
    const m = montar();
    const base = { destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', cliente: m.s3.clientes.publicador };
    assert.throws(() => S3.criarEnviadorS3(base), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO' && e.motivo === 'DESTINO_DURAVEL_NAO_APROVADO');
    assert.throws(() => S3.criarEnviadorS3({ ...base, ambiente: 'PRODUCAO', registro: lista }), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO' && e.motivo === 'DESTINO_DURAVEL_AMBIENTE_DIVERGENTE');
    assert.throws(() => S3.criarEnviadorS3({ ...base, destinoId: 'nao-existe', registro: lista }), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    for (const ruim of [null, {}, { ...base, extra: 1, registro: lista }, { ...base, cliente: {}, registro: lista }, { ...base, cliente: null, registro: lista }, { ...base, prazoMs: 0, registro: lista }, { ...base, prazoMs: 600001, registro: lista }, { ...base, ttlPreVooMs: 999, registro: lista }, { ...base, relogio: 5, registro: lista }]) {
      assert.throws(() => S3.criarEnviadorS3(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA' || e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    }
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => S3.criarEnviadorS3({ ...base, registro: lista }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
    const e = S3.criarEnviadorS3({ ...base, registro: lista });
    assert.deepEqual({ ...e.destino }, { id: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', bucket: 'safework-hml-backup-111111111111', regiao: 'us-east-1', origem: 'TESTE_CONTROLADO' });
  });

  test('S3-12 — o módulo não chama nem cita operações destrutivas, não usa ambiente, SDK, escrita ou remoção de arquivos, e não define nomes de raiz da guarda G1', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-armazenamento-s3.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.equal(/DeleteObject|DeleteBucket|PutObjectRetention|BypassGovernance|PutBucketPolicy|PutLifecycle|PutBucketVersioning|ScheduleKeyDeletion|DisableKey|apagar|\.delete\(/.test(fonte), false);
    assert.equal(/process\.env|@aws-sdk|require\(['"]node:(?:net|http|https|child_process|dns|tls)/.test(fonte), false);
    assert.equal(/\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/.test(fonte), false);
    assert.equal(/\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/.test(fonte), false);
  });

  test('S3-13 — pré-voo aprovado NÃO prova escrita condicional, política do bucket, Object Lock por versão, permissões nem restauração: a lista de comprovações posteriores acompanha sempre o resultado', async () => {
    const m = montar();
    const aprovado = await m.env().executarPreVoo();
    assert.equal(aprovado.ok, true);
    const reprovado = await montar({ config: { versionamento: null } }).env().executarPreVoo();
    assert.equal(reprovado.ok, false);
    for (const r of [aprovado, reprovado]) {
      assert.deepEqual([...r.comprovacoesPendentes], [
        'ESCRITA_CONDICIONAL_NO_S3_A_COMPROVAR_EM_T2', 'POLITICA_DO_BUCKET_QUE_EXIGE_A_CONDICAO_A_COMPROVAR_EM_T2', 'OBJECT_LOCK_EM_CADA_VERSAO_A_COMPROVAR_EM_T2',
        'PERMISSOES_MINIMAS_E_NEGACOES_A_COMPROVAR_EM_T2', 'RESTAURACAO_COMPLETA_A_COMPROVAR_EM_T3',
      ]);
      assert.equal(Object.isFrozen(r.comprovacoesPendentes), true);
    }
  });
});
