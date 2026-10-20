'use strict';

// Limites por ambiente, lidos na carga: ANTES de carregar qualquer módulo de src/ (cada arquivo de teste roda em processo próprio). Mínimos que a configuração
// aceita: 2 envios por minuto por usuário e 10 por hora por empresa. Cada teste usa usuário e empresa NOVOS, então nenhum depende dos contadores de outro.
process.env.IMAGENS_ENVIOS_POR_MINUTO_USUARIO = '2';
process.env.IMAGENS_ENVIOS_POR_HORA_EMPRESA = '10';

const http = require('node:http');
const { once } = require('node:events');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarImagemMaterialRoutes } = require('../../src/routes/imagem-material.routes');
const { criarImagemMaterialController } = require('../../src/controllers/imagem-material.controller');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Biblioteca de Imagens, Unidade 5C-1 (RED) — o CONTRATO HTTP do envio de imagem da empresa:
 *
 *   POST /api/imagens-material/empresa?nome=<texto>      corpo BINÁRIO, Content-Type image/png | image/jpeg | image/webp, até 2 MiB, UM arquivo por pedido
 *     -> 201 { status:'ok', imagem:{ origem:'EMPRESA', id, nome, formato, largura, altura, versao, estado }, reaproveitada:false }
 *     -> 200 { …, reaproveitada:true }   (o mesmo conteúdo já existe na empresa)
 *     -> 401 sem sessão · 403 sem `materials.criar` · 400 consulta inválida · 413 PAYLOAD_MUITO_GRANDE · 415 tipo de conteúdo · 429 limite · erros do serviço como estão
 *
 * FORMATO CONFIRMADO nas fontes do projeto (nada aqui é invenção desta etapa): Documento 07 (tabela de rotas e nota do parser: corpo binário bruto, parser próprio de
 * 2 MiB na rota depois de sessão e permissão, isenção por igualdade exata de caminho), Documento 32 H1, Documento 04 (limites e códigos), Documento 56 §3.4 (portão de
 * tipo pela família `image/*`; o formato é decidido pelos bytes) e a especificação executável UPL-01 a UPL-05 de test/integracao/imagem-material-http-upload-entrega.integration.js;
 * a matriz de permissões (rbac/imagem-material-permissoes.js) já diz `importar: materials.criar`; o 413 PAYLOAD_MUITO_GRANDE é a tradução existente do errorHandler.
 *
 * ORDEM da cadeia (a das demais rotas da biblioteca): sessão -> permissão -> limites -> corpo e validação. Quem não tem sessão ou permissão recebe 401 ou 403
 * SEM que o corpo seja lido (provado com um cliente que só envia o começo do corpo) e sem nenhum detalhe de validação.
 * Por que as recusas antecipadas NÃO levam corpo grande: um servidor que responde 401/403 antes de ler o corpo deixa o cliente ainda escrevendo, e com 2 MiB o Node 26
 * derruba a conexão (EPIPE/ECONNRESET em 72% a 100% das 25 tentativas por tamanho, com 2 MiB e com 2 MiB + 1, em duas rodadas do experimento da 5C-1). O corpo grande só aparece onde o servidor LÊ
 * tudo (UPL-R08) e "não lê antes de autenticar" é provado pelo cliente de corpo parcial (UPL-R09a e UPL-R09b). O 413 pelo Content-Length declarado é a DEC-D-C4 (TODO).
 *
 * COSTURAS usadas (previstas, a confirmar no GREEN da 5C-2; os testes fixam só o mínimo):
 *   - `criarImagemMaterialController({ pool, envio })`: `envio` é o serviço de envio, no mesmo molde de `entrega` (opcional, substitui o serviço), com
 *     `enviar(executor, { empresaId, atorId, nome, bytes: Buffer, ip, dispositivo }) -> { imagem, reaproveitada }`; lança HttpError nas recusas.
 *   - A permissão é a REAL (criarExigirPermissaoRecurso + avaliarPermissaoRecurso); só o repositório de permissões é simulado. A sessão é um cabeçalho de teste.
 * Nada aqui acessa o banco. Verde HOJE (proteção de regressão): UPL-R10, UPL-R11b, UPL-R19. Todo o resto é RED por funcionalidade ausente.
 */

const CAMINHO = '/api/imagens-material/empresa';
const MIB = 1024 * 1024;
const IMAGEM_PUBLICA = Object.freeze({
  origem: 'EMPRESA', id: '9007199254740993', nome: 'Luva enviada', formato: 'PNG', largura: 320, altura: 320, versao: 1, estado: 'ATIVA',
});

let sequencia = 5000;
const identidade = (extra = {}) => {
  sequencia += 1;
  return { empresa: sequencia, usuario: sequencia * 10 + 1, perfil: 'ADMINISTRADOR', ...extra };
};
const cabecalhosDe = (quem) => ({ 'x-teste-empresa': String(quem.empresa), 'x-teste-usuario': String(quem.usuario), 'x-teste-perfil': quem.perfil });

// Sessão de teste: a identidade vem de cabeçalhos; sem eles, o mesmo 401 do middleware real. Empresa e usuário só existem para o resto da cadeia depois dela.
const sessaoFalsa = (req, res, next) => {
  const empresa = Number.parseInt(req.headers['x-teste-empresa'] ?? '', 10);
  const usuario = Number.parseInt(req.headers['x-teste-usuario'] ?? '', 10);
  const perfil = req.headers['x-teste-perfil'];
  if (!Number.isInteger(empresa) || !Number.isInteger(usuario) || typeof perfil !== 'string') {
    next(HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada'));
    return;
  }
  req.empresa = { id: empresa };
  req.usuario = { id: usuario, perfil };
  next();
};

function criarEnvioFalso({ resultado = { imagem: IMAGEM_PUBLICA, reaproveitada: false }, falha = null } = {}) {
  const chamadas = [];
  let falhaAtual = falha;
  return {
    chamadas,
    /** Troca a falha das próximas chamadas (null = voltam a dar certo): um teste pode percorrer várias recusas com UM app e UM conjunto de simulações. */
    falharCom(nova) { falhaAtual = nova; },
    async enviar(executor, dados) {
      chamadas.push({ executor, dados });
      if (falhaAtual !== null) throw falhaAtual;
      return resultado;
    },
  };
}

function montar(t, { envio = criarEnvioFalso(), permissoes = { visualizar: true, criar: true, editar: true } } = {}) {
  let atuais = permissoes;
  const recursosConsultados = [];
  t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async (_executor, _empresaId, _perfil, recurso) => {
    recursosConsultados.push(recurso);
    return {
      podeVisualizar: atuais.visualizar === true, podeCriar: atuais.criar === true, podeEditar: atuais.editar === true, podeExcluir: false,
    };
  });
  t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => null);
  t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
  const pool = { marca: 'pool-de-teste' };
  const controller = criarImagemMaterialController({ pool, envio });
  const rotas = criarImagemMaterialRoutes({ controller, exigirSessao: sessaoFalsa, pool });
  const app = criarAppTeste((a) => a.use('/api', rotas));
  return {
    app, envio, pool, recursosConsultados, permitir(novas) { atuais = novas; },
  };
}

function postar(app, {
  quem = identidade(), nome = 'Luva enviada', consulta, tipo = 'image/png', corpo = Buffer.alloc(1024, 3), cabecalhos = {},
} = {}) {
  const textoDaConsulta = consulta !== undefined ? consulta : (nome === null ? '' : `?nome=${encodeURIComponent(nome)}`);
  let r = request(app).post(`${CAMINHO}${textoDaConsulta}`).set('User-Agent', 'Navegador de teste');
  if (quem !== null) for (const [k, v] of Object.entries(cabecalhosDe(quem))) r = r.set(k, v);
  for (const [k, v] of Object.entries(cabecalhos)) r = r.set(k, v);
  if (tipo !== null) r = r.set('Content-Type', tipo);
  return r.send(corpo);
}

const resumo = (r) => `${r.status} ${JSON.stringify(r.body)}`;

/** Enquanto o envio não existir, o pedido de imagem cai no 415 da política de conteúdo ou no 404 da rota ausente: o teste diz isso, em vez de falhar adiante. */
const exigirEnvioImplementado = (r, tipo = 'image/png') => {
  const imagem = typeof tipo === 'string' && tipo.startsWith('image/');
  if (r.status === 404 || (imagem && r.status === 415 && r.body?.codigo === 'TIPO_CONTEUDO_NAO_SUPORTADO')) {
    assert.fail(`contrato futuro: o envio binário (POST ${CAMINHO}) ainda não existe — respondeu ${r.status} ${r.body?.codigo}`);
  }
  return r;
};

/**
 * Cliente que anuncia `comprimento` bytes de corpo mas envia só o começo: devolve a resposta que chegar ANTES de o corpo terminar. Se o servidor lesse o corpo
 * antes de autenticar, autorizar ou conferir o tamanho, nada chegaria e o teste falharia por tempo (2,5 s).
 */
async function responderSemOCorpoCompleto(app, { cabecalhos = {}, comprimento, enviado = 1024 }) {
  const servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const { port } = servidor.address();
  try {
    return await new Promise((resolve, reject) => {
      let concluido = false;
      let limite = null;
      const terminar = (acao, valor) => {
        if (concluido) return;
        concluido = true;
        clearTimeout(limite);
        acao(valor);
      };
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `${CAMINHO}?nome=Luva`, headers: { ...cabecalhos, 'Content-Type': 'image/png', 'Content-Length': String(comprimento) },
      });
      limite = setTimeout(() => {
        req.destroy();
        terminar(reject, new Error('sem resposta antes do fim do corpo: o corpo foi lido antes de autenticar, autorizar ou conferir o tamanho?'));
      }, 2500);
      req.on('error', (falha) => terminar(reject, falha));
      req.on('response', (res) => {
        const partes = [];
        res.on('data', (p) => partes.push(p));
        res.on('end', () => {
          let corpo = null;
          try { corpo = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch { corpo = null; }
          req.destroy();
          terminar(resolve, { status: res.statusCode, body: corpo });
        });
      });
      req.write(Buffer.alloc(enviado, 1));
    });
  } finally {
    servidor.closeAllConnections();
    await new Promise((resolve) => { servidor.close(resolve); });
  }
}

describe('POST /api/imagens-material/empresa — resposta e o que chega ao serviço', () => {
  test('UPL-R01 — 201: empresa, ator, nome e os bytes exatos chegam ao serviço; a resposta é { status, imagem, reaproveitada } sem nenhum campo interno', async (t) => {
    const { app, envio, pool } = montar(t);
    const quem = identidade();
    const corpo = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 31) & 255));
    const r = exigirEnvioImplementado(await postar(app, { quem, nome: 'Luva nitrílica', corpo }));
    assert.equal(r.status, 201, resumo(r));
    assert.deepEqual(r.body, { status: 'ok', imagem: IMAGEM_PUBLICA, reaproveitada: false });
    for (const proibido of ['sha256', 'bytes', 'chave', 'caminho', 'criadoPor', 'empresaId']) assert.equal(JSON.stringify(r.body).includes(proibido), false, `a resposta vazou ${proibido}`);
    assert.equal(envio.chamadas.length, 1);
    const { executor, dados } = envio.chamadas[0];
    assert.equal(executor, pool, 'o serviço recebe o executor do controller');
    assert.equal(dados.empresaId, quem.empresa);
    assert.equal(dados.atorId, quem.usuario);
    assert.equal(dados.nome, 'Luva nitrílica');
    assert.equal(Buffer.isBuffer(dados.bytes), true, 'os bytes chegam como Buffer');
    assert.equal(Buffer.compare(dados.bytes, corpo), 0, 'os bytes chegam idênticos, sem decodificar nem alterar');
    assert.match(String(dados.ip), /127\.0\.0\.1/);
    assert.equal(dados.dispositivo, 'Navegador de teste');
  });

  test('UPL-R02 — o mesmo conteúdo já existente na empresa é 200 com reaproveitada=true (nunca 201)', async (t) => {
    const envio = criarEnvioFalso({ resultado: { imagem: IMAGEM_PUBLICA, reaproveitada: true } });
    const { app } = montar(t, { envio });
    const r = exigirEnvioImplementado(await postar(app));
    assert.equal(r.status, 200, resumo(r));
    assert.deepEqual(r.body, { status: 'ok', imagem: IMAGEM_PUBLICA, reaproveitada: true });
  });

  test('UPL-R03 — PNG, JPEG e WebP seguem o mesmo caminho: o serviço sempre recebe um Buffer idêntico ao corpo (quem reconhece o formato é o conteúdo, não o cabeçalho)', async (t) => {
    const { app, envio } = montar(t);
    for (const tipo of ['image/png', 'image/jpeg', 'image/webp']) {
      const corpo = Buffer.from(`conteúdo ${tipo}`.repeat(50));
      const r = exigirEnvioImplementado(await postar(app, { tipo, corpo }), tipo); // um usuário novo por pedido: os limites de taxa não entram aqui
      assert.equal(r.status, 201, `${tipo}: ${resumo(r)}`);
      const chamada = envio.chamadas.at(-1);
      assert.equal(Buffer.isBuffer(chamada.dados.bytes) && Buffer.compare(chamada.dados.bytes, corpo) === 0, true, `${tipo}: bytes idênticos`);
    }
  });

  test('UPL-R03b — o portão de tipo é a família image/*: gif, bmp, svg+xml, tiff e avif chegam ao serviço como Buffer idêntico (o cabeçalho nunca decide); quem os recusa é a assinatura dos bytes, com 415 IMAGEM_FORMATO_NAO_SUPORTADO', async (t) => {
    const { app, envio } = montar(t);
    envio.falharCom(new HttpError(415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 'Mensagem pública'));
    for (const tipo of ['image/gif', 'image/bmp', 'image/svg+xml', 'image/tiff', 'image/avif']) {
      const corpo = Buffer.from(`conteúdo ${tipo}`.repeat(40));
      const r = exigirEnvioImplementado(await postar(app, { tipo, corpo }), tipo);
      assert.deepEqual([r.status, r.body.codigo], [415, 'IMAGEM_FORMATO_NAO_SUPORTADO'], `${tipo}: ${resumo(r)}`);
      const chamada = envio.chamadas.at(-1);
      assert.equal(Buffer.isBuffer(chamada?.dados.bytes) && Buffer.compare(chamada.dados.bytes, corpo) === 0, true, `${tipo}: o serviço recebeu os bytes idênticos`);
    }
  });

  test('UPL-R04 — o nome é só o texto da consulta (UTF-8 e espaços internos preservados); a resposta traz o nome da imagem que o serviço devolveu', async (t) => {
    const { app, envio } = montar(t);
    const r = exigirEnvioImplementado(await postar(app, { nome: 'Luva de raspa — tamanho único (G)' }));
    assert.equal(r.status, 201, resumo(r));
    assert.equal(envio.chamadas[0].dados.nome, 'Luva de raspa — tamanho único (G)');
  });
});

describe('POST /api/imagens-material/empresa — ordem: sessão, permissão, limites, corpo e validação', () => {
  test('UPL-R05 — sem sessão: 401 SESSAO_INVALIDA antes de tudo (mesmo com consulta inválida ou chave estranha; o corpo grande é o UPL-R09a); o serviço nunca é chamado', async (t) => {
    const { app, envio } = montar(t);
    const casos = [
      ['pedido válido', {}],
      ['consulta inválida (sem nome)', { nome: null }],
      ['chave estranha na consulta', { consulta: '?nome=x&empresaId=9' }],
    ];
    for (const [rotulo, opcoes] of casos) {
      const r = exigirEnvioImplementado(await postar(app, { quem: null, ...opcoes }));
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${rotulo}: ${resumo(r)}`);
    }
    assert.equal(envio.chamadas.length, 0);
  });

  test('UPL-R06 — sem `materials.criar` (só visualizar; visualizar e editar; só editar): 403 PERMISSAO_NEGADA antes da validação (o corpo grande é o UPL-R09b); o recurso consultado é `materials`', async (t) => {
    const { app, envio, permitir, recursosConsultados } = montar(t);
    const matriz = [{ visualizar: true, criar: false, editar: false }, { visualizar: true, criar: false, editar: true }, { visualizar: false, criar: false, editar: true }];
    for (const permissoes of matriz) {
      permitir(permissoes);
      for (const [rotulo, opcoes] of [['pedido válido', {}], ['consulta inválida', { nome: null }]]) {
        const r = exigirEnvioImplementado(await postar(app, opcoes));
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `${JSON.stringify(permissoes)} ${rotulo}: ${resumo(r)}`);
      }
    }
    assert.equal(envio.chamadas.length, 0);
    assert.deepEqual([...new Set(recursosConsultados)], ['materials']);
  });

  test('UPL-R07 — `materials.criar` basta para enviar (a matriz diz importar = criar): 201 mesmo sem visualizar nem editar', async (t) => {
    const { app } = montar(t, { permissoes: { visualizar: false, criar: true, editar: false } });
    const r = exigirEnvioImplementado(await postar(app));
    assert.equal(r.status, 201, resumo(r));
  });
});

describe('POST /api/imagens-material/empresa — limite de 2 MiB (413 PAYLOAD_MUITO_GRANDE)', () => {
  test('UPL-R08 — exatamente 2 MiB é aceito; 2 MiB + 1 é 413 PAYLOAD_MUITO_GRANDE, sem eco do corpo, e o serviço não é chamado', async (t) => {
    const { app, envio } = montar(t);
    // Sonda pequena: enquanto o envio não existir, o 415 antecipado da política de conteúdo derrubaria a escrita dos 2 MiB (EPIPE) e o RED sairia como ruído de transporte.
    exigirEnvioImplementado(await postar(app, { quem: identidade() }));
    envio.chamadas.length = 0;
    const quem = identidade();
    const exato = exigirEnvioImplementado(await postar(app, { quem, corpo: Buffer.alloc(2 * MIB, 5) }));
    assert.equal(exato.status, 201, resumo(exato));
    assert.equal(envio.chamadas[0].dados.bytes.length, 2 * MIB);
    const antes = envio.chamadas.length;
    const grande = exigirEnvioImplementado(await postar(app, { quem: identidade(), corpo: Buffer.alloc(2 * MIB + 1, 5) }));
    assert.deepEqual([grande.status, grande.body.codigo], [413, 'PAYLOAD_MUITO_GRANDE'], resumo(grande));
    assert.deepEqual(Object.keys(grande.body).sort(), ['codigo', 'message', 'status']);
    assert.equal(envio.chamadas.length, antes, 'o serviço não é chamado para um corpo acima do limite');
  });

  test('UPL-R09a — resposta ANTECIPADA sem sessão: o 401 chega sem o corpo terminar (o corpo não é lido antes de autenticar)', async (t) => {
    const { app } = montar(t);
    const r = exigirEnvioImplementado(await responderSemOCorpoCompleto(app, { comprimento: 2 * MIB }));
    assert.deepEqual([r.status, r.body?.codigo], [401, 'SESSAO_INVALIDA'], resumo(r));
  });

  test('UPL-R09b — resposta ANTECIPADA sem permissão: o 403 chega sem o corpo terminar (o corpo não é lido antes de autorizar)', async (t) => {
    const { app } = montar(t, { permissoes: { visualizar: true, criar: false, editar: true } });
    const r = exigirEnvioImplementado(await responderSemOCorpoCompleto(app, { cabecalhos: cabecalhosDe(identidade()), comprimento: 2 * MIB }));
    assert.deepEqual([r.status, r.body?.codigo], [403, 'PERMISSAO_NEGADA'], resumo(r));
  });

  test('DEC-D-C4 — limite de 2 MiB pelo Content-Length DECLARADO: 413 imediato, sem ler o corpo, ou só depois de lê-lo?', {
    todo: 'o body-parser lê e descarta o corpo inteiro antes de responder 413 (conferido em node_modules/body-parser/lib/read.js e por experimento); recusar antes exige uma checagem do cabeçalho. Decisão da 5C-2: o limite de 2 MiB e o 413 PAYLOAD_MUITO_GRANDE valem de qualquer forma (UPL-R08).',
  }, () => {});

  test('UPL-R10 (verde hoje; controle da técnica) — um parser binário de 2 MiB com a tradução existente do errorHandler aceita exatamente 2 MiB e responde 413 PAYLOAD_MUITO_GRANDE acima disso', async () => {
    const app = express();
    app.post('/binario', express.raw({ type: 'image/*', limit: 2 * MIB, inflate: false }), (req, res) => res.json({ bytes: req.body.length }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    const ok = await request(app).post('/binario').set('Content-Type', 'image/png').send(Buffer.alloc(2 * MIB, 7));
    assert.deepEqual([ok.status, ok.body.bytes], [200, 2 * MIB], resumo(ok));
    const grande = await request(app).post('/binario').set('Content-Type', 'image/png').send(Buffer.alloc(2 * MIB + 1, 7));
    assert.deepEqual([grande.status, grande.body.codigo], [413, 'PAYLOAD_MUITO_GRANDE'], resumo(grande));
  });
});

describe('POST /api/imagens-material/empresa — tipo de conteúdo', () => {
  test('UPL-R11a — JSON no caminho do envio é 415 TIPO_CONTEUDO_NAO_SUPORTADO (nunca 201, nunca 404), mesmo com sessão e permissão; o serviço não é chamado', async (t) => {
    const { app, envio } = montar(t);
    const r = await postar(app, { tipo: 'application/json', corpo: '{"a":1}' });
    if (r.status === 404) assert.fail(`contrato futuro: o envio binário (POST ${CAMINHO}) ainda não existe — o JSON caiu em ${r.status} ${r.body?.codigo}`);
    assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO'], resumo(r));
    assert.equal(envio.chamadas.length, 0);
  });

  test('UPL-R11b (verde hoje; proteção de regressão) — texto, octet-stream, multipart e formulário no caminho do envio são 415 TIPO_CONTEUDO_NAO_SUPORTADO; o serviço não é chamado', async (t) => {
    const { app, envio } = montar(t);
    for (const tipo of ['text/plain', 'application/octet-stream', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
      const r = await postar(app, { tipo, corpo: Buffer.from('conteudo') });
      assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO'], `${tipo}: ${resumo(r)}`);
    }
    assert.equal(envio.chamadas.length, 0);
  });

  test('UPL-R12 — o serviço só é chamado com Buffer: um corpo vazio com image/png é recusado antes ou chega como Buffer de tamanho zero (nunca undefined nem objeto)', async (t) => {
    const { app, envio } = montar(t);
    const r = exigirEnvioImplementado(await postar(app, { corpo: Buffer.alloc(0) }));
    if (envio.chamadas.length === 0) {
      assert.ok(r.status >= 400 && r.status < 500, `sem chamada ao serviço, o corpo vazio deve ser recusado como erro do cliente: ${resumo(r)}`);
    } else {
      assert.equal(Buffer.isBuffer(envio.chamadas[0].dados.bytes) && envio.chamadas[0].dados.bytes.length === 0, true);
    }
  });
});

describe('POST /api/imagens-material/empresa — consulta (nome) e campos de autoridade', () => {
  test('UPL-R13 — nome ausente, vazio, só espaços, com 101 caracteres, com caractere de controle ou repetido: 400 VALIDACAO no campo query.nome, sem eco do valor; o serviço não é chamado', async (t) => {
    const { app, envio } = montar(t);
    const casos = [
      ['ausente', { nome: null }],
      ['vazio', { consulta: '?nome=' }],
      ['só espaços', { consulta: '?nome=%20%20%20' }],
      ['101 caracteres', { nome: 'ISCA'.padEnd(101, 'x') }],
      ['caractere de controle', { consulta: '?nome=a%00b' }],
      ['quebra de linha', { consulta: '?nome=a%0Ab' }],
      ['repetido', { consulta: '?nome=a&nome=b' }],
    ];
    for (const [rotulo, opcoes] of casos) {
      const r = exigirEnvioImplementado(await postar(app, opcoes)); // um usuário novo por pedido: nenhum limite de taxa interfere
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${rotulo}: ${resumo(r)}`);
      assert.equal((r.body.detalhes ?? []).some((d) => d.campo === 'query.nome'), true, `${rotulo}: detalhe em query.nome — ${resumo(r)}`);
      assert.equal(JSON.stringify(r.body).includes('ISCA'), false, `${rotulo}: o valor recebido não volta na resposta`);
    }
    assert.equal(envio.chamadas.length, 0);
  });

  test('UPL-R14 — chave desconhecida na consulta (empresaId, criadoPor, chave, caminho, estado, versao, sha256, formato) é 400 VALIDACAO sem eco do valor; empresa e ator são só da sessão', async (t) => {
    const { app, envio } = montar(t);
    for (const chave of ['empresaId', 'criadoPor', 'chave', 'caminho', 'estado', 'versao', 'sha256', 'formato']) {
      const r = exigirEnvioImplementado(await postar(app, { consulta: `?nome=Luva&${chave}=VALOR-HOSTIL-123` }));
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${chave}: ${resumo(r)}`);
      assert.equal(JSON.stringify(r.body).includes('VALOR-HOSTIL-123'), false, `${chave}: o valor recebido não volta na resposta`);
    }
    assert.equal(envio.chamadas.length, 0);
  });

  test('UPL-R15 — isolamento: cabeçalhos hostis (empresa, usuário, criador) não mudam quem envia; duas empresas enviando os mesmos bytes chegam ao serviço como duas chamadas com as empresas das respectivas sessões', async (t) => {
    const { app, envio } = montar(t);
    const a = identidade();
    const b = identidade();
    const hostis = { 'x-empresa-id': '999999', 'x-usuario-id': '777777', 'x-criado-por': '777777', 'x-forwarded-for': '203.0.113.9' };
    const corpo = Buffer.from('mesmos bytes nas duas empresas'.repeat(20));
    exigirEnvioImplementado(await postar(app, { quem: a, corpo, cabecalhos: hostis }));
    exigirEnvioImplementado(await postar(app, { quem: b, corpo, cabecalhos: hostis }));
    assert.deepEqual(envio.chamadas.map((c) => [c.dados.empresaId, c.dados.atorId]), [[a.empresa, a.usuario], [b.empresa, b.usuario]]);
    assert.notEqual(envio.chamadas[0].dados.empresaId, envio.chamadas[1].dados.empresaId);
  });
});

describe('POST /api/imagens-material/empresa — limites de requisição (usuário e empresa)', () => {
  test('UPL-R16 — por usuário (2 por minuto neste ambiente): o 3º envio é 429 LIMITE_REQUISICOES_EXCEDIDO sem chamar o serviço; outro usuário da mesma empresa segue; quem não tem permissão recebe sempre 403, nunca 429', async (t) => {
    const { app, envio, permitir } = montar(t);
    const u = identidade();
    const empresa = u.empresa;
    for (let i = 1; i <= 2; i += 1) {
      const r = exigirEnvioImplementado(await postar(app, { quem: u }));
      assert.equal(r.status, 201, `envio ${i} de 2: ${resumo(r)}`);
    }
    const chamadasAntes = envio.chamadas.length;
    const excedido = exigirEnvioImplementado(await postar(app, { quem: u }));
    assert.deepEqual([excedido.status, excedido.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], resumo(excedido));
    assert.equal(envio.chamadas.length, chamadasAntes, 'o 429 não chega ao serviço');
    const outro = exigirEnvioImplementado(await postar(app, { quem: { ...identidade(), empresa } }));
    assert.equal(outro.status, 201, `outro usuário da mesma empresa: ${resumo(outro)}`);

    permitir({ visualizar: true, criar: false, editar: true });
    const semPermissao = identidade();
    for (let i = 1; i <= 4; i += 1) {
      const r = exigirEnvioImplementado(await postar(app, { quem: semPermissao }));
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `tentativa ${i} sem permissão: ${resumo(r)}`);
    }
  });

  test('UPL-R17 — por empresa (10 por hora neste ambiente): dez usuários da mesma empresa enviam; o 11º é 429 LIMITE_REQUISICOES_EXCEDIDO; outra empresa não é afetada', async (t) => {
    const { app, envio } = montar(t);
    const empresa = identidade().empresa;
    for (let i = 1; i <= 10; i += 1) {
      const r = exigirEnvioImplementado(await postar(app, { quem: { ...identidade(), empresa } }));
      assert.equal(r.status, 201, `envio ${i} de 10 da empresa: ${resumo(r)}`);
    }
    const chamadasAntes = envio.chamadas.length;
    const excedido = exigirEnvioImplementado(await postar(app, { quem: { ...identidade(), empresa } }));
    assert.deepEqual([excedido.status, excedido.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], resumo(excedido));
    assert.equal(envio.chamadas.length, chamadasAntes);
    const outraEmpresa = exigirEnvioImplementado(await postar(app, { quem: identidade() }));
    assert.equal(outraEmpresa.status, 201, `outra empresa: ${resumo(outraEmpresa)}`);
  });
});

describe('POST /api/imagens-material/empresa — erros do serviço e rota única', () => {
  test('UPL-R18 — as recusas do serviço (cota, formato, animada, inválida, dimensões, indisponível) saem com o mesmo status e código; um erro inesperado vira 500 genérico sem vazar a mensagem', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { app, envio } = montar(t);
    const recusas = [
      [409, 'IMAGEM_COTA_EXCEDIDA'], [415, 'IMAGEM_FORMATO_NAO_SUPORTADO'], [415, 'IMAGEM_ANIMADA_NAO_SUPORTADA'], [400, 'IMAGEM_INVALIDA'], [400, 'IMAGEM_DIMENSOES_INVALIDAS'],
      [503, 'IMAGENS_INDISPONIVEL'],
    ];
    for (const [status, codigo] of recusas) {
      envio.falharCom(new HttpError(status, codigo, 'Mensagem pública'));
      const r = exigirEnvioImplementado(await postar(app));
      assert.deepEqual([r.status, r.body.codigo], [status, codigo], `${codigo}: ${resumo(r)}`);
    }
    envio.falharCom(new Error('SEGREDO interno /tmp/imagens/1/abc/mestre.png'));
    const inesperado = exigirEnvioImplementado(await postar(app));
    assert.deepEqual([inesperado.status, inesperado.body.codigo], [500, 'ERRO_INTERNO'], resumo(inesperado));
    assert.equal(JSON.stringify(inesperado.body).includes('SEGREDO'), false);
  });

  test('UPL-R19 (verde hoje; proteção de regressão) — o caminho do envio só tem POST: GET, PUT, PATCH e DELETE respondem 404 ROTA_NAO_ENCONTRADA', async (t) => {
    const { app } = montar(t);
    const quem = identidade();
    for (const metodo of ['get', 'put', 'patch', 'delete']) {
      let r = request(app)[metodo](CAMINHO);
      for (const [k, v] of Object.entries(cabecalhosDe(quem))) r = r.set(k, v);
      if (metodo !== 'get') r = r.send({});
      const resposta = await r;
      assert.deepEqual([resposta.status, resposta.body.codigo], [404, 'ROTA_NAO_ENCONTRADA'], `${metodo.toUpperCase()}: ${resumo(resposta)}`);
    }
  });
});
