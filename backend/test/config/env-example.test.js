'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const { carregarConfigEmail } = require('../../src/config/email');
const { carregarConfigHttp } = require('../../src/config/http');

/**
 * .env.example documenta as variáveis do e-mail transacional e das URLs
 * públicas (Bloco 11H), com os padrões aprovados e sem nenhum valor secreto,
 * e continua sendo um ponto de partida que a configuração aceita.
 */

const CAMINHO = path.join(__dirname, '..', '..', '.env.example');
const TEXTO = fs.readFileSync(CAMINHO, 'utf8');
const exemplo = dotenv.parse(TEXTO);

const VARIAVEIS = [
  'EMAIL_MODO', 'EMAIL_ARQUIVO_DIRETORIO', 'EMAIL_REMETENTE_NOME', 'EMAIL_REMETENTE_ENDERECO', 'EMAIL_SUPORTE_ENDERECO',
  'SMTP_HOST', 'SMTP_PORTA', 'SMTP_SEGURANCA', 'SMTP_USUARIO', 'SMTP_SENHA', 'SMTP_TIMEOUT_MS',
  'PORTAL_URL_PUBLICA', 'PAINEL_URL_PUBLICA',
];

describe('.env.example — e-mail e URLs públicas', () => {
  test('documenta todas as variáveis novas', () => {
    for (const nome of VARIAVEIS) {
      assert.ok(Object.hasOwn(exemplo, nome), `${nome} não está no .env.example`);
    }
  });

  test('traz os padrões aprovados: desativado, remetente e suporte distintos, SMTP na 587 com STARTTLS e 10 s', () => {
    assert.equal(exemplo.EMAIL_MODO, 'desativado');
    assert.equal(exemplo.EMAIL_REMETENTE_NOME, 'SafeWork Engenharia');
    assert.equal(exemplo.EMAIL_REMETENTE_ENDERECO, 'no-reply@safeworkengenharia.com.br');
    assert.equal(exemplo.EMAIL_SUPORTE_ENDERECO, 'suporte@safeworkengenharia.com.br');
    assert.notEqual(exemplo.EMAIL_REMETENTE_ENDERECO, exemplo.EMAIL_SUPORTE_ENDERECO);
    assert.equal(exemplo.SMTP_PORTA, '587');
    assert.equal(exemplo.SMTP_SEGURANCA, 'starttls');
    assert.equal(exemplo.SMTP_TIMEOUT_MS, '10000');
  });

  test('nenhum valor secreto: servidor, usuário e senha do SMTP, diretório de arquivo e URLs públicas ficam vazios', () => {
    for (const nome of ['SMTP_HOST', 'SMTP_USUARIO', 'SMTP_SENHA', 'EMAIL_ARQUIVO_DIRETORIO', 'PORTAL_URL_PUBLICA', 'PAINEL_URL_PUBLICA']) {
      assert.equal(exemplo[nome], '', `${nome} deveria estar vazio no exemplo`);
    }
  });

  test('não diz mais que o envio real de e-mail "ainda não foi implementado"', () => {
    assert.equal(/ainda não foi implementado/.test(TEXTO), false);
  });

  test('o exemplo, como está, é aceito pela configuração de e-mail e pela de HTTP fora de production', () => {
    const email = carregarConfigEmail({ ...exemplo, NODE_ENV: 'development' });
    assert.equal(email.modo, 'desativado');
    assert.equal(email.smtp, null);
    assert.deepEqual(email.remetente, { nome: 'SafeWork Engenharia', endereco: 'no-reply@safeworkengenharia.com.br' });
    assert.equal(email.suporte, 'suporte@safeworkengenharia.com.br');

    const http = carregarConfigHttp({ ...exemplo, NODE_ENV: 'development' });
    assert.equal(http.urlsPublicas.portal, 'http://localhost:5500');
    assert.equal(http.urlsPublicas.painel, 'http://localhost:5501');
  });

  test('em production o exemplo sozinho não sobe: exige smtp e as URLs públicas, que ficam por conta de quem implanta', () => {
    assert.throws(() => carregarConfigEmail({ ...exemplo, NODE_ENV: 'production' }), /EMAIL_MODO/);
    assert.throws(() => carregarConfigHttp({ ...exemplo, NODE_ENV: 'production' }), /URL_PUBLICA|CORS_ORIGIN|PLATAFORMA_HOST/);
  });
});

describe('.env.example — imagens de produto (Biblioteca de Imagens, Unidade 1)', () => {
  const AJUSTAVEIS = ['IMAGENS_COTA_IMAGENS', 'IMAGENS_COTA_MIB', 'IMAGENS_ENVIOS_POR_MINUTO_USUARIO', 'IMAGENS_ENVIOS_POR_HORA_EMPRESA', 'IMAGENS_PROCESSAMENTOS_SIMULTANEOS'];

  test('documenta o diretório, vazio (nenhum caminho real), e as cinco variáveis ajustáveis só como exemplo comentado', () => {
    assert.ok(Object.hasOwn(exemplo, 'IMAGENS_ARMAZENAMENTO_DIRETORIO'));
    assert.equal(exemplo.IMAGENS_ARMAZENAMENTO_DIRETORIO, '');
    for (const nome of AJUSTAVEIS) {
      assert.equal(Object.hasOwn(exemplo, nome), false, `${nome} deve ficar comentada`);
      assert.match(TEXTO, new RegExp(`^# ${nome}=[0-9]+$`, 'm'), `${nome} não está documentada como exemplo comentado`);
    }
  });

  test('não documenta como ajustáveis os limites fixos de arquivo, lado, pixels e derivadas', () => {
    assert.doesNotMatch(TEXTO, /IMAGENS_(ARQUIVO|LADO|PIXELS|MINIATURA|EXIBICAO|AMPLIAR)/);
  });

  test('o exemplo, como está, é aceito pela configuração das imagens: recurso indisponível e valores padrão', () => {
    const { lerConfiguracao, exigirDiretorio } = require('../../src/config/imagens');
    const configuracao = lerConfiguracao({ ...exemplo });
    assert.equal(configuracao.diretorio, null);
    assert.throws(() => exigirDiretorio(configuracao), (falha) => falha.codigo === 'IMAGENS_INDISPONIVEL');
    assert.equal(configuracao.cotaImagens, 300);
  });

  test('os exemplos comentados, descomentados, também são aceitos', () => {
    const { lerConfiguracao } = require('../../src/config/imagens');
    const descomentado = dotenv.parse(TEXTO.replace(/^# (IMAGENS_[A-Z_]+=[0-9]+)$/gm, '$1'));
    assert.doesNotThrow(() => lerConfiguracao(descomentado));
  });
});
