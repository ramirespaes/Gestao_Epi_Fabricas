'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPagina } = require('./helpers/dom-painel');

/**
 * Sair do Painel Privado. O cookie de sessão é HttpOnly: só o servidor o
 * revoga e remove. A página só vai ao login depois de o servidor confirmar;
 * sem confirmação ela fica onde está, avisa e deixa tentar de novo. O mesmo
 * vale para Voltar e Entrar novamente na tela de login, que encerram o
 * desafio aberto.
 */

const EMAIL = 'admin@safework.test';
const SENHA = 'frase-longa-de-teste-42';
const SEGREDO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CHAVE = 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP';
const URI = `otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=${SEGREDO}&algorithm=SHA1&digits=6&period=30`;
const CODIGOS = ['0A1B-2C3D-4E5F-6G7H', '1B2C-3D4E-5F6G-7H8J', '2C3D-4E5F-6G7H-8J9K', '3D4E-5F6G-7H8J-9KAM', '4E5F-6G7H-8J9K-AMBN',
  '5F6G-7H8J-9KAM-BNCP', '6G7H-8J9K-AMBN-CPDQ', '7H8J-9KAM-BNCP-DQER', '8J9K-AMBN-CPDQ-ERFS', '9KAM-BNCP-DQER-FSGT'];
const LIBERACAO = 'ZZ9Y-8X7W-6V5T-4S3R';
const RECUPERACAO = 'HH7G-6F5E-4D3C-2B1A';
const TOTP = '012345';
const EXPIRA = '2026-09-29T12:15:00.000Z';
const LOGOUT = 'POST /auth/logout';

const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const ADMINISTRADOR = ok({ administrador: { id: 1, email: EMAIL } });
const EMPRESAS = ok({ empresas: [{ id: 1, razaoSocial: 'Empresa Demonstração SafeWork', nomeFantasia: null, cnpj: '11222333000181', ativo: true }], total: 1 });
const SEM_DESAFIO = erro(401, 'DESAFIO_INVALIDO', 'Etapa de verificação inválida ou expirada');

// O que o servidor pode devolver sem ter encerrado nada. 403 e 429 saem antes do controller do logout.
const SEM_CONFIRMACAO = [
  ['falha de rede', () => new Error('falha de rede'), /não foi possível encerrar/i],
  ['HTTP 500', () => erro(500, 'ERRO_INTERNO', 'Erro interno'), /não foi possível encerrar/i],
  ['HTTP 403 da verificação de origem', () => erro(403, 'ORIGEM_NAO_PERMITIDA', 'Origem da requisição não permitida'), /não foi possível encerrar/i],
  ['HTTP 429 do limite de requisições', () => erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'), /aguarde/i],
  ['resposta 200 que não é JSON', () => ({ status: 200, texto: '<html>proxy</html>' }), /não foi possível encerrar/i],
];

// intacto: o que cada página mostrava antes de Sair continua lá.
const PAGINAS = [
  {
    nome: 'painel.html',
    html: 'painel-privado/painel.html',
    rotas: { 'GET /painel': ADMINISTRADOR },
    aviso: 'erro',
    intacto: (pg) => assert.equal(pg.el('email-administrador').textContent, EMAIL),
  },
  {
    nome: 'empresas.html',
    html: 'painel-privado/empresas.html',
    rotas: { 'GET /auth/me': ADMINISTRADOR, 'GET /empresas': EMPRESAS },
    aviso: 'erro',
    intacto: (pg) => {
      const lista = pg.documento.usosDeInnerHTML.filter((uso) => uso.id === 'lista');
      assert.match(lista[lista.length - 1].valor, /Empresa Demonstração SafeWork/, 'a lista não foi apagada');
    },
  },
  {
    nome: 'seguranca.html',
    html: 'painel-privado/seguranca.html',
    rotas: { 'GET /auth/me': ADMINISTRADOR },
    aviso: 'mensagem',
    intacto: (pg) => assert.deepEqual(pg.etapasVisiveis(), ['MENU']),
  },
];

const pedidos = (pg, chave = LOGOUT) => pg.chamadas.filter((c) => c.chave === chave).length;

/** Respostas do logout em sequência; a última vale para os pedidos seguintes. */
function emSequencia(...respostas) {
  let i = 0;
  return () => {
    const r = respostas[Math.min(i, respostas.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : r;
  };
}

async function abrir(pagina, logout) {
  const pg = abrirPagina(pagina.html, { rotas: { ...pagina.rotas, [LOGOUT]: logout } });
  await pg.esperar();
  return pg;
}

/** Aciona sem esperar o manipulador terminar: o pedido pode estar pendente. */
async function acionar(pg, id) {
  let falha = null;
  pg.el(id).disparar('click').catch((erro) => { falha = erro; });
  await pg.esperar();
  if (falha) throw falha;
}

function conteudoOculto(pg) {
  const conteudo = pg.el('conteudo');
  return conteudo.hidden || conteudo.style.display === 'none';
}

for (const pagina of PAGINAS) {
  describe(`Sair em ${pagina.nome}`, () => {
    test('logout confirmado: um pedido, botão bloqueado enquanto espera; o conteúdo só some, e o login só vem, depois da resposta', async () => {
      let liberar;
      const pg = await abrir(pagina, () => new Promise((resolver) => { liberar = () => resolver(ok()); }));
      assert.equal(conteudoOculto(pg), false, 'a página abriu com a sessão confirmada');

      await acionar(pg, 'sair');
      assert.deepEqual([pedidos(pg), pg.el('sair').disabled, pg.navegacoes], [1, true, []]);
      assert.equal(conteudoOculto(pg), false, 'sem confirmação o conteúdo continua na tela');
      pagina.intacto(pg);

      liberar();
      await pg.esperar();
      assert.deepEqual([pedidos(pg), pg.navegacoes], [1, ['index.html']]);
      assert.equal(conteudoOculto(pg), true, 'confirmado: a cópia que o navegador guardar não tem o que mostrar');
    });

    for (const [caso, resposta, mensagem] of SEM_CONFIRMACAO) {
      test(`${caso}: não vai ao login, avisa que a sessão continua ativa, mantém o conteúdo e libera nova tentativa`, async () => {
        const pg = await abrir(pagina, resposta);
        await pg.clicar('sair');

        assert.deepEqual(pg.navegacoes, [], 'o logout não foi confirmado');
        assert.equal(pedidos(pg), 1);
        assert.equal(conteudoOculto(pg), false, 'a página continua utilizável, sem recarregar');
        pagina.intacto(pg);
        assert.match(pg.el(pagina.aviso).textContent, mensagem);
        assert.match(pg.el(pagina.aviso).textContent, /continua ativa/i);
        assert.equal(pg.el('sair').disabled, false);
        if (pg.existe('carregando')) assert.equal(pg.el('carregando').style.display, 'none', 'nada fica carregando');
      });
    }

    test('camada HTTP que rejeita em vez de responder: tratado como falha, não como logout', async () => {
      const pg = await abrir(pagina, ok());
      pg.janela.EpiHttp.requisitar = () => Promise.reject(new Error('falha antes do envio'));
      await pg.clicar('sair');

      assert.deepEqual([pg.navegacoes, pedidos(pg), conteudoOculto(pg)], [[], 0, false]);
      assert.match(pg.el(pagina.aviso).textContent, /continua ativa/i);
      assert.equal(pg.el('sair').disabled, false);
    });

    test('depois da falha, a nova tentativa envia outro pedido; confirmada, vai ao login e o aviso some', async () => {
      const pg = await abrir(pagina, emSequencia(() => new Error('falha de rede'), ok()));
      await pg.clicar('sair');
      assert.deepEqual([pedidos(pg), pg.navegacoes], [1, []]);

      await pg.clicar('sair');
      assert.deepEqual([pedidos(pg), pg.navegacoes], [2, ['index.html']]);
      assert.equal(pg.el(pagina.aviso).textContent, '');
    });

    test('segundo acionamento com o pedido pendente: um pedido só', async () => {
      let liberar;
      const pg = await abrir(pagina, () => new Promise((resolver) => { liberar = () => resolver(ok()); }));
      await acionar(pg, 'sair');
      await acionar(pg, 'sair');
      assert.equal(pedidos(pg), 1);

      liberar();
      await pg.esperar();
      assert.deepEqual([pedidos(pg), pg.navegacoes], [1, ['index.html']]);
    });

    test('o aviso fica fora do conteúdo protegido e é anunciado a leitores de tela', async () => {
      const pg = await abrir(pagina, ok());
      assert.ok(pg.existe(pagina.aviso), `${pagina.nome} tem onde mostrar o aviso`);
      assert.ok(pg.html.indexOf(`id="${pagina.aviso}"`) < pg.html.indexOf('id="conteudo"'), 'antes do conteúdo, que fica oculto');
      const aviso = pg.el(pagina.aviso);
      assert.ok(aviso.getAttribute('role') === 'alert' || aviso.hasAttribute('aria-live'));
    });
  });
}

describe('Sair com os códigos de recuperação na tela (seguranca.html)', () => {
  const pagina = PAGINAS[2];
  const rotas = { ...pagina.rotas, 'POST /auth/mfa/recuperacao/regenerar': ok({ codigosRecuperacao: CODIGOS }) };
  const naTela = (pg) => pg.el('lista-codigos').children.map((item) => item.textContent);

  async function comCodigos(logout = ok()) {
    const pg = abrirPagina(pagina.html, { rotas: { ...rotas, [LOGOUT]: logout } });
    await pg.esperar();
    await pg.clicar('botao-gerar-codigos');
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', TOTP);
    await pg.enviar('etapa-reautenticacao');
    assert.deepEqual([pg.etapasVisiveis(), naTela(pg)], [['CODIGOS'], CODIGOS]);
    return pg;
  }

  test('sem confirmar que guardou: Sair não apaga os códigos, não pede logout e não navega; o aviso do navegador continua', async () => {
    const pg = await comCodigos();
    await pg.clicar('sair');

    assert.deepEqual(naTela(pg), CODIGOS, 'os códigos só existem nesta tela');
    assert.deepEqual([pg.etapasVisiveis(), pedidos(pg), pg.navegacoes], [['CODIGOS'], 0, []]);
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 1);
    assert.match(pg.el('mensagem').textContent, /guarde os códigos/i);
    assert.equal(pg.el('sair').disabled, false);
  });

  test('confirmou que guardou, mas o logout falhou: os códigos continuam na tela, com o aviso do navegador', async () => {
    const pg = await comCodigos(() => new Error('falha de rede'));
    await pg.marcar('confirmo-codigos');
    await pg.clicar('sair');

    assert.deepEqual([naTela(pg), pg.etapasVisiveis(), pg.navegacoes], [CODIGOS, ['CODIGOS'], []]);
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 1);
    assert.match(pg.el('mensagem').textContent, /continua ativa/i);
  });

  test('troca do autenticador em andamento e logout que falha: QR, chave e etapa continuam como estavam', async () => {
    const pg = abrirPagina(pagina.html, {
      rotas: {
        ...pagina.rotas,
        'POST /auth/mfa/substituicao/iniciar': ok({ etapa: 'SUBSTITUICAO', expiraEm: EXPIRA, cadastro: { uri: URI, chaveManual: CHAVE } }),
        [LOGOUT]: () => new Error('falha de rede'),
      },
    });
    await pg.esperar();
    await pg.clicar('botao-trocar-autenticador');
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', TOTP);
    await pg.enviar('etapa-reautenticacao');
    await pg.clicar('sair');

    assert.deepEqual([pg.etapasVisiveis(), pg.el('cadastro-chave').textContent, pg.el('cadastro-qr').children.length], [['CADASTRO'], CHAVE, 1]);
    assert.deepEqual([conteudoOculto(pg), pg.navegacoes], [false, []]);
  });

  test('depois de confirmar que guardou: Sair limpa os códigos, pede o logout e vai ao login', async () => {
    const pg = await comCodigos();
    await pg.marcar('confirmo-codigos');
    await pg.clicar('sair');

    assert.deepEqual([naTela(pg), pedidos(pg), pg.navegacoes], [[], 1, ['index.html']]);
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 0);
  });
});

describe('Voltar e Entrar novamente no login (index.html)', () => {
  const PAGINA = 'painel-privado/index.html';
  const cadastro = { uri: URI, chaveManual: CHAVE };

  async function naEtapa(etapa, logout) {
    const rotas = {
      'GET /auth/mfa/estado': SEM_DESAFIO,
      'POST /auth/login': ok({ etapa: etapa === 'CADASTRO' ? 'LIBERACAO' : 'VERIFICACAO', expiraEm: EXPIRA }),
      'POST /auth/mfa/liberacao': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro }),
      'POST /auth/mfa/verificar': SEM_DESAFIO,
      [LOGOUT]: logout,
    };
    if (etapa === 'LIBERACAO') rotas['POST /auth/login'] = ok({ etapa: 'LIBERACAO', expiraEm: EXPIRA });
    const pg = abrirPagina(PAGINA, { rotas });
    await pg.esperar();
    await pg.digitar('email', EMAIL);
    await pg.digitar('senha', SENHA);
    await pg.enviar('form-login');
    if (etapa === 'CADASTRO') {
      await pg.digitar('codigo-liberacao', LIBERACAO);
      await pg.enviar('etapa-liberacao');
    }
    if (etapa === 'ENCERRADA') {
      await pg.digitar('codigo-verificacao', TOTP);
      await pg.enviar('etapa-verificacao');
    }
    assert.deepEqual(pg.etapasVisiveis(), [etapa]);
    return pg;
  }

  const ACOES = [
    ['VERIFICACAO', 'botao-voltar-verificacao'],
    ['LIBERACAO', 'botao-voltar-liberacao'],
    ['CADASTRO', 'botao-voltar-cadastro'],
    ['ENCERRADA', 'botao-entrar-novamente'],
  ];

  test('as quatro ações pedem o encerramento ao servidor, nunca navegam, e confirmadas mostram o login', async () => {
    for (const [etapa, botao] of ACOES) {
      const pg = await naEtapa(etapa, ok());
      await pg.clicar(botao);
      assert.deepEqual([pedidos(pg), pg.etapasVisiveis(), pg.navegacoes], [1, ['LOGIN'], []], etapa);
    }
  });

  for (const [caso, resposta, mensagem] of SEM_CONFIRMACAO) {
    test(`${caso}: a etapa continua na tela, com aviso; o login não aparece como se o desafio tivesse acabado`, async () => {
      for (const [etapa, botao] of ACOES) {
        const pg = await naEtapa(etapa, resposta);
        await pg.clicar(botao);

        assert.deepEqual(pg.etapasVisiveis(), [etapa], `${etapa}: o desafio pode continuar aberto no servidor`);
        assert.match(pg.el('mensagem').textContent, mensagem, etapa);
        assert.deepEqual([pedidos(pg), pg.el(botao).disabled, pg.navegacoes], [1, false, []], etapa);
      }
    });
  }

  test('no cadastro, a falha não apaga o QR nem a chave: a etapa continua utilizável', async () => {
    const pg = await naEtapa('CADASTRO', () => new Error('falha de rede'));
    await pg.clicar('botao-voltar-cadastro');

    assert.deepEqual([pg.etapasVisiveis(), pg.el('cadastro-chave').textContent, pg.el('cadastro-qr').children.length], [['CADASTRO'], CHAVE, 1]);
  });

  test('depois da falha, a nova tentativa confirmada mostra o login, sem QR, chave nem campos', async () => {
    const pg = await naEtapa('CADASTRO', emSequencia(() => new Error('falha de rede'), ok()));
    await pg.clicar('botao-voltar-cadastro');
    assert.deepEqual([pedidos(pg), pg.etapasVisiveis()], [1, ['CADASTRO']]);

    await pg.clicar('botao-voltar-cadastro');
    assert.deepEqual([pedidos(pg), pg.etapasVisiveis()], [2, ['LOGIN']]);
    assert.deepEqual([pg.el('cadastro-chave').textContent, pg.el('cadastro-qr').children.length, pg.el('mensagem').textContent], ['', 0, '']);
  });
});

describe('falha de rede nas etapas que entregam segredo: nada é dado como concluído', () => {
  const REDE = () => new Error('falha de rede');

  test('login: recovery code, confirmação do cadastro e novo QR ficam na mesma etapa, com aviso e botão liberado', async () => {
    const casos = [
      ['VERIFICACAO', 'POST /auth/mfa/recuperacao', async (pg) => {
        await pg.clicar('botao-usar-recuperacao');
        await pg.digitar('codigo-recuperacao', RECUPERACAO);
        await pg.enviar('etapa-recuperacao');
      }, 'RECUPERACAO', 'botao-recuperar'],
      ['LIBERACAO', 'POST /auth/mfa/cadastro/confirmar', async (pg) => {
        await pg.digitar('codigo-liberacao', LIBERACAO);
        await pg.enviar('etapa-liberacao');
        await pg.digitar('codigo-cadastro', TOTP);
        await pg.enviar('etapa-cadastro');
      }, 'CADASTRO', 'botao-confirmar-cadastro'],
      ['LIBERACAO', 'POST /auth/mfa/cadastro/reiniciar', async (pg) => {
        await pg.digitar('codigo-liberacao', LIBERACAO);
        await pg.enviar('etapa-liberacao');
        await pg.clicar('botao-novo-qr');
      }, 'CADASTRO', 'botao-novo-qr'],
    ];
    for (const [etapaInicial, rota, percorrer, etapaFinal, botao] of casos) {
      const pg = abrirPagina('painel-privado/index.html', {
        rotas: {
          'GET /auth/mfa/estado': SEM_DESAFIO,
          'POST /auth/login': ok({ etapa: etapaInicial, expiraEm: EXPIRA }),
          'POST /auth/mfa/liberacao': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: { uri: URI, chaveManual: CHAVE } }),
          [rota]: REDE,
        },
      });
      await pg.esperar();
      await pg.digitar('email', EMAIL);
      await pg.digitar('senha', SENHA);
      await pg.enviar('form-login');
      await percorrer(pg);

      assert.deepEqual([pg.etapasVisiveis(), pg.navegacoes, pg.el(botao).disabled], [[etapaFinal], [], false], rota);
      assert.match(pg.el('mensagem').textContent, /conexão/i, rota);
      assert.equal(pg.el('lista-codigos').children.length, 0, rota);
    }
  });

  test('segurança: confirmação da troca e regeneração ficam na mesma etapa, sem códigos na tela e sem ir ao login', async () => {
    const rotas = {
      'GET /auth/me': ADMINISTRADOR,
      'POST /auth/mfa/substituicao/iniciar': ok({ etapa: 'SUBSTITUICAO', expiraEm: EXPIRA, cadastro: { uri: URI, chaveManual: CHAVE } }),
      'POST /auth/mfa/substituicao/confirmar': REDE,
      'POST /auth/mfa/recuperacao/regenerar': REDE,
    };
    const reautenticar = async (pg, botao) => {
      await pg.clicar(botao);
      await pg.digitar('senha-atual', SENHA);
      await pg.digitar('codigo-atual', TOTP);
      await pg.enviar('etapa-reautenticacao');
    };

    const troca = abrirPagina('painel-privado/seguranca.html', { rotas });
    await troca.esperar();
    await reautenticar(troca, 'botao-trocar-autenticador');
    await troca.digitar('codigo-cadastro', TOTP);
    await troca.enviar('etapa-cadastro');
    assert.deepEqual([troca.etapasVisiveis(), troca.navegacoes, troca.el('botao-confirmar-cadastro').disabled], [['CADASTRO'], [], false]);
    assert.match(troca.el('mensagem').textContent, /conexão/i);

    const regeneracao = abrirPagina('painel-privado/seguranca.html', { rotas });
    await regeneracao.esperar();
    await reautenticar(regeneracao, 'botao-gerar-codigos');
    assert.deepEqual([regeneracao.etapasVisiveis(), regeneracao.navegacoes, regeneracao.el('lista-codigos').children.length], [['REAUTENTICACAO'], [], 0]);
    assert.match(regeneracao.el('mensagem').textContent, /conexão/i);
  });
});
