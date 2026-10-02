'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPagina, RAIZ } = require('./helpers/dom-painel');

/**
 * Contrato entre as telas de MFA e o backend: as rotas que as páginas
 * chamam e os corpos que enviam são comparados com as rotas e os schemas do
 * código do backend, lidos como texto. O frontend não inventa rota, campo
 * nem código de erro.
 */

const BACKEND = path.join(RAIZ, '..', 'backend', 'src');
const ler = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

const EXPIRA = '2026-09-28T12:15:00.000Z';
const SENHA = 'frase-longa-de-teste-42';
const CADASTRO = { uri: 'otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30', chaveManual: 'JBSW Y3DP EHPK 3PXP' };
const CODIGOS = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DDD${i}`);
const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });

function rotasDoBackend() {
  const fonte = ler('routes/auth-plataforma.routes.js');
  const rotas = new Map();
  for (const m of fonte.matchAll(/router\.(get|post)\(\s*'([^']+)',([\s\S]*?)\);/g)) {
    rotas.set(`${m[1].toUpperCase()} ${m[2]}`, m[3].match(/authPlataformaSchemas\.(\w+)\.body/)?.[1] ?? null);
  }
  return rotas;
}

function camposDosSchemas() {
  const fonte = ler('schemas/auth-plataforma.schema.js');
  const campos = new Map();
  for (const m of fonte.matchAll(/const (\w+) = \{\s*body: z\.strictObject\(\{([\s\S]*?)\}\),\s*\};/g)) {
    let interno = m[2];
    while (/\([^()]*\)/.test(interno)) interno = interno.replace(/\([^()]*\)/g, '');
    campos.set(m[1], interno.split(',').map((p) => p.split(':')[0].trim()).filter(Boolean).sort());
  }
  return campos;
}

async function chamadasDoLogin() {
  const chamadas = [];
  const rotas = (etapa) => ({
    'GET /auth/mfa/estado': { status: 401, corpo: { status: 'error', codigo: 'DESAFIO_INVALIDO' } },
    'POST /auth/login': ok({ etapa, expiraEm: EXPIRA }),
    'POST /auth/logout': ok(),
    'POST /auth/mfa/verificar': ok(),
    'POST /auth/mfa/liberacao': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: CADASTRO }),
    'POST /auth/mfa/recuperacao': ok({ etapa: 'RECUPERACAO', expiraEm: EXPIRA, cadastro: CADASTRO }),
    'POST /auth/mfa/cadastro/reiniciar': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: CADASTRO }),
    'POST /auth/mfa/cadastro/confirmar': ok({ codigosRecuperacao: CODIGOS }),
  });
  const entrar = async (etapa) => {
    const pg = abrirPagina('painel-privado/index.html', { rotas: rotas(etapa) });
    await pg.esperar();
    await pg.digitar('email', 'admin@safework.test');
    await pg.digitar('senha', SENHA);
    await pg.enviar('form-login');
    return pg;
  };

  let pg = await entrar('VERIFICACAO');
  await pg.digitar('codigo-verificacao', '012345');
  await pg.enviar('etapa-verificacao');
  chamadas.push(...pg.chamadas);

  pg = await entrar('VERIFICACAO');
  await pg.clicar('botao-usar-recuperacao');
  await pg.digitar('codigo-recuperacao', 'HH7G-6F5E-4D3C-2B1A');
  await pg.enviar('etapa-recuperacao');
  await pg.clicar('botao-novo-qr');
  await pg.digitar('codigo-cadastro', '012345');
  await pg.enviar('etapa-cadastro');
  chamadas.push(...pg.chamadas);

  pg = await entrar('LIBERACAO');
  await pg.digitar('codigo-liberacao', 'ZZ9Y-8X7W-6V5T-4S3R');
  await pg.enviar('etapa-liberacao');
  await pg.clicar('botao-voltar-cadastro');
  chamadas.push(...pg.chamadas);
  return chamadas;
}

async function chamadasDaSeguranca() {
  const chamadas = [];
  const rotas = {
    'GET /auth/me': ok({ administrador: { id: 1, email: 'admin@safework.test' } }),
    'POST /auth/logout': ok(),
    'POST /auth/mfa/substituicao/iniciar': ok({ etapa: 'SUBSTITUICAO', expiraEm: EXPIRA, cadastro: CADASTRO }),
    'POST /auth/mfa/substituicao/confirmar': ok({ codigosRecuperacao: CODIGOS }),
    'POST /auth/mfa/recuperacao/regenerar': ok({ codigosRecuperacao: CODIGOS }),
  };
  const reautenticar = async (botao) => {
    const pg = abrirPagina('painel-privado/seguranca.html', { rotas });
    await pg.esperar();
    await pg.clicar(botao);
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', '004711');
    await pg.enviar('etapa-reautenticacao');
    return pg;
  };

  let pg = await reautenticar('botao-trocar-autenticador');
  await pg.digitar('codigo-cadastro', '090807');
  await pg.enviar('etapa-cadastro');
  chamadas.push(...pg.chamadas);

  pg = await reautenticar('botao-gerar-codigos');
  chamadas.push(...pg.chamadas);

  pg = abrirPagina('painel-privado/seguranca.html', { rotas });
  await pg.esperar();
  await pg.clicar('sair');
  chamadas.push(...pg.chamadas);
  return chamadas;
}

describe('contrato das telas de MFA com o backend', () => {
  test('leitura do backend: as 12 rotas de autenticação da plataforma e os 8 schemas', () => {
    assert.equal(rotasDoBackend().size, 12);
    assert.deepEqual(Object.fromEntries(camposDosSchemas()), {
      login: ['email', 'senha'],
      mfaLiberacao: ['codigoLiberacao'],
      mfaCadastroReiniciar: [],
      mfaCadastroConfirmar: ['codigo'],
      mfaVerificar: ['codigo'],
      mfaRecuperacao: ['codigoRecuperacao'],
      mfaReautenticacao: ['codigo', 'senha'],
      mfaSubstituicaoConfirmar: ['codigo'],
    });
  });

  test('toda chamada das duas páginas é uma rota do backend, com exatamente os campos do schema', async () => {
    const rotas = rotasDoBackend();
    const campos = camposDosSchemas();
    const chamadas = [...await chamadasDoLogin(), ...await chamadasDaSeguranca()];
    const usadas = new Set();

    for (const c of chamadas) {
      assert.ok(rotas.has(c.chave), `${c.chave} não existe no backend`);
      usadas.add(c.chave);
      const schema = rotas.get(c.chave);
      if (schema === null) assert.equal(c.corpo, null, `${c.chave} não aceita corpo`);
      else assert.deepEqual(Object.keys(c.corpo).sort(), campos.get(schema), `${c.chave}: campos do corpo`);
    }
    assert.deepEqual([...rotas.keys()].filter((r) => !usadas.has(r)), [], 'todas as rotas de autenticação da plataforma têm tela');
  });

  test('os campos que as telas leem das respostas são os que o controller e o serviço devolvem', () => {
    const controller = ler('controllers/auth-plataforma.controller.js');
    for (const trecho of ['etapa: resultado.desafio.etapa', 'expiraEm: resultado.desafio.expiraEm', 'cadastro: resultado.cadastro', 'codigosRecuperacao: resultado.codigosRecuperacao', 'etapa: req.desafioMfaPlataforma.tipo']) {
      assert.ok(controller.includes(trecho), trecho);
    }
    assert.match(ler('services/etapa-mfa-plataforma.js'), /return \{ uri: .*, chaveManual: /);
    assert.match(ler('services/desafio-mfa-plataforma.service.js'), /'LIBERACAO' : 'VERIFICACAO'/);
  });

  test('os códigos de erro que as telas tratam existem no backend', () => {
    const mfa = fs.readFileSync(path.join(RAIZ, 'painel-privado/mfa.js'), 'utf8');
    const tratados = [...mfa.match(/var POR_CODIGO = \{([\s\S]*?)\};/)[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(tratados.sort(), ['DESAFIO_INVALIDO', 'MFA_CADASTRO_EXPIRADO', 'MFA_CADASTRO_REINICIOS_ESGOTADOS', 'MFA_CODIGO_INVALIDO', 'MFA_INDISPONIVEL', 'MFA_JA_ATIVO', 'REAUTENTICACAO_INVALIDA', 'RESPOSTA_INVALIDA']);

    const fontes = ['services/etapa-mfa-plataforma.js', 'services/mfa-cadastro-plataforma.service.js', 'services/substituicao-mfa-plataforma.service.js', 'services/reautenticacao-plataforma.js', 'middleware/desafio-mfa-plataforma.js'].map(ler).join('\n');
    // RESPOSTA_INVALIDA nasce no cliente HTTP do navegador, não no servidor.
    for (const codigo of tratados.filter((c) => c !== 'RESPOSTA_INVALIDA')) assert.ok(fontes.includes(`'${codigo}'`), codigo);
    assert.ok(fs.readFileSync(path.join(RAIZ, 'js/api-http.js'), 'utf8').includes("'RESPOSTA_INVALIDA'"));
    for (const codigo of ['MFA_EM_COOLDOWN', 'SESSAO_INVALIDA']) assert.ok(fontes.includes(`'${codigo}'`), `${codigo} (tratado pelo status)`);
  });
});
