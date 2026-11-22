'use strict';
// Etapa 4C (D-H3): lançador do agente do backend. Obtém credenciais temporárias do IAM Roles Anywhere pelo
// aws_signing_helper (credential-process), confere estrutura e validade e só então inicia o agente, com ambiente
// mínimo: PATH, HOME e as três variáveis AWS_ do contrato do s3.js, só durante a execução. Nada é gravado em disco e só
// o código da recusa é escrito. A identidade (certificado, chave, âncora, perfil, papel) é própria do CD backend, nunca
// a do frontend nem a do D-ORF-6. Falha antes do agente não publica recibo: o agente nem chega a existir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const I = require('../instalador/instalar-release');
const { executarComPrazo } = require('./executor-com-prazo');

const AGENTE = path.join(__dirname, 'agente-backend.js');
const ISOLAMENTO = 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND';
const MINUTO_MS = 60 * 1000;
// A operação do agente cabe em 45 min (instalação, margem e reserva): a credencial precisa durar ao menos 60 min.
const VALIDADE_MINIMA_MS = 60 * MINUTO_MS;
const VALIDADE_MAXIMA_MS = 12 * 60 * MINUTO_MS + 5 * MINUTO_MS;
const PRAZO_DO_HELPER_MS = 30 * 1000;
const AMBIENTE_DO_HELPER = Object.freeze({ PATH: '/usr/bin:/bin' });
const CAMPOS_DA_SECAO = 'ancora,certificado,chave,duracaoSegundos,executavel,papel,perfil';
const CAMPOS_DA_CREDENCIAL = 'AccessKeyId,Expiration,SecretAccessKey,SessionToken,Version';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ARN_DO_ROLES_ANYWHERE = new RegExp(`^arn:aws:rolesanywhere:([a-z]{2}-[a-z]+-[1-9]):(\\d{12}):(trust-anchor|profile)/${UUID}$`);
const ARN_DO_PAPEL = /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
const PAPEL_DO_BACKEND = /cd-backend/;
const OUTRA_IDENTIDADE = /d-?orf|frontend|publicador/i;

const recusa = (codigo) => Object.assign(new Error(codigo), { codigo });
const codigoSeguro = (e) => (e && typeof e.codigo === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.codigo) ? e.codigo : 'ERRO');
const absoluto = (p) => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p;

// Arquivo regular, sem link em nenhum ponto do caminho, com um único link físico, do dono esperado e sem escrita (ou,
// se privado, sem nenhum acesso) por grupo e outros. Conferido no descritor aberto sem seguir link.
function arquivoSeguro(caminho, { dono, privado }) {
  let fd;
  try {
    if (fs.realpathSync(caminho) !== caminho) throw recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO');
    fd = fs.openSync(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== dono || (st.mode & (privado ? 0o077 : 0o022)) !== 0) throw recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO');
  } catch {
    throw recusa('ARQUIVO_DE_IDENTIDADE_INSEGURO');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* o fechamento não muda o resultado */ } }
  }
}

// Seção `credenciais` da configuração oficial. O helper e o certificado têm o dono da configuração (root em produção);
// a chave privada é do usuário do agente e só dele. Âncora, perfil e papel são da conta do bucket, e o papel é o do backend.
function validarSecaoDeCredenciais(cfg, { uidDono }) {
  const c = cfg !== null && typeof cfg === 'object' ? cfg.credenciais : undefined;
  const forma = c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).sort().join(',') === CAMPOS_DA_SECAO
    && absoluto(c.executavel) && absoluto(c.certificado) && absoluto(c.chave)
    && Number.isInteger(c.duracaoSegundos) && c.duracaoSegundos * 1000 >= VALIDADE_MINIMA_MS && c.duracaoSegundos <= 43200;
  if (!forma) throw recusa('CREDENCIAIS_NAO_CONFIGURADAS');
  const ancora = ARN_DO_ROLES_ANYWHERE.exec(c.ancora);
  const perfil = ARN_DO_ROLES_ANYWHERE.exec(c.perfil);
  const papel = ARN_DO_PAPEL.exec(c.papel);
  const conta = cfg.s3 !== null && typeof cfg.s3 === 'object' ? cfg.s3.conta : undefined;
  const coerente = ancora && ancora[3] === 'trust-anchor' && perfil && perfil[3] === 'profile' && papel
    && ancora[1] === perfil[1] && ancora[2] === conta && perfil[2] === conta && papel[1] === conta
    && PAPEL_DO_BACKEND.test(papel[2]) && !OUTRA_IDENTIDADE.test(papel[2]);
  if (!coerente) throw recusa('CREDENCIAIS_NAO_CONFIGURADAS');
  arquivoSeguro(c.executavel, { dono: uidDono, privado: false });
  arquivoSeguro(c.certificado, { dono: uidDono, privado: false });
  arquivoSeguro(c.chave, { dono: process.getuid(), privado: true });
  return Object.freeze({ ...c });
}

// Saída do credential-process: exatamente os cinco campos, Version 1, chave temporária (ASIA) com segredo e token, e
// validade que cubra a operação inteira. Credencial permanente (AKIA) é recusada à parte.
function validarCredenciais(texto, agoraMs) {
  let d;
  try { d = JSON.parse(texto); } catch { throw recusa('CREDENCIAL_INVALIDA'); }
  if (d === null || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).sort().join(',') !== CAMPOS_DA_CREDENCIAL || d.Version !== 1) throw recusa('CREDENCIAL_INVALIDA');
  if (typeof d.AccessKeyId === 'string' && d.AccessKeyId.startsWith('AKIA')) throw recusa('CREDENCIAL_PERMANENTE');
  const forma = typeof d.AccessKeyId === 'string' && /^ASIA[A-Z0-9]{16}$/.test(d.AccessKeyId)
    && typeof d.SecretAccessKey === 'string' && /^[A-Za-z0-9/+=]{40}$/.test(d.SecretAccessKey)
    && typeof d.SessionToken === 'string' && /^[A-Za-z0-9/+=]{16,8192}$/.test(d.SessionToken)
    && typeof d.Expiration === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(d.Expiration);
  const expira = forma ? Date.parse(d.Expiration) : NaN;
  if (!Number.isFinite(expira)) throw recusa('CREDENCIAL_INVALIDA');
  if (expira <= agoraMs) throw recusa('CREDENCIAL_EXPIRADA');
  if (expira - agoraMs < VALIDADE_MINIMA_MS) throw recusa('VALIDADE_INSUFICIENTE');
  if (expira - agoraMs > VALIDADE_MAXIMA_MS) throw recusa('EXPIRACAO_FORA_DA_FAIXA');
  return { AccessKeyId: d.AccessKeyId, SecretAccessKey: d.SecretAccessKey, SessionToken: d.SessionToken, Expiration: d.Expiration };
}

// Ambiente do agente montado do zero: nada é herdado do lançador. NODE_ENV só acompanha no modo de teste.
function ambienteDoAgente(cred) {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), AWS_ACCESS_KEY_ID: cred.AccessKeyId, AWS_SECRET_ACCESS_KEY: cred.SecretAccessKey, AWS_SESSION_TOKEN: cred.SessionToken };
  if (process.env.NODE_ENV === 'test') env.NODE_ENV = 'test';
  return env;
}

function iniciarAgentePadrao(argv, env) {
  return new Promise((concluir) => {
    const filho = spawn(process.execPath, [AGENTE, ...argv], { env, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    filho.on('error', () => concluir(1));
    filho.on('exit', (codigo, sinal) => concluir(sinal || codigo === null ? 1 : codigo));
  });
}

const usoValido = (argv) => Array.isArray(argv) && argv[0] === '--config' && typeof argv[1] === 'string'
  && ((argv.length === 3 && argv[2] === '--pendentes') || (argv.length === 4 && argv[2] === '--pedido' && typeof argv[3] === 'string'));

async function principal(argv, { iniciarAgente = iniciarAgentePadrao, agora = Date.now, prazoDoHelperMs = PRAZO_DO_HELPER_MS } = {}) {
  if (!usoValido(argv)) throw recusa('USO');
  // Nenhuma credencial vem de fora do helper: uma variável AWS_ herdada (por exemplo, chave permanente) recusa tudo.
  if (Object.keys(process.env).some((k) => /^AWS_/i.test(k))) throw recusa('AMBIENTE_COM_CREDENCIAL');
  const origem = I.origemDaConfiguracaoOficial(argv[1]);
  const cfg = I.lerConfiguracaoOficial(origem);
  if (!(cfg !== null && typeof cfg === 'object' && cfg.habilitado === true && cfg.isolamentoRevisado === ISOLAMENTO)) throw recusa('AGENTE_DESABILITADO');
  const c = validarSecaoDeCredenciais(cfg, { uidDono: origem.uidDono });
  const args = ['credential-process', '--certificate', c.certificado, '--private-key', c.chave, '--trust-anchor-arn', c.ancora,
    '--profile-arn', c.perfil, '--role-arn', c.papel, '--session-duration', String(c.duracaoSegundos)];
  let saida;
  try {
    saida = await executarComPrazo(c.executavel, args, { prazoMs: prazoDoHelperMs, env: { ...AMBIENTE_DO_HELPER } });
  } catch {
    throw recusa('HELPER_INDISPONIVEL');
  }
  const credencial = validarCredenciais(String(saida), agora());
  return iniciarAgente(argv.slice(), ambienteDoAgente(credencial));
}

if (require.main === module) {
  principal(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }, (e) => {
    console.error(`Lançador do backend recusou: ${codigoSeguro(e)}`);
    process.exitCode = 1;
  });
}

module.exports = { principal, validarSecaoDeCredenciais, validarCredenciais, VALIDADE_MINIMA_MS };
