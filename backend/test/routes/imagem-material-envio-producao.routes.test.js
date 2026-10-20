'use strict';

// O ambiente do teste nunca aponta para um diretório real de imagens: o caminho "do ambiente" tem de resolver para indisponível. Antes de carregar qualquer módulo de src/.
delete process.env.IMAGENS_ARMAZENAMENTO_DIRETORIO;

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarImagemMaterialRoutes } = require('../../src/routes/imagem-material.routes');
const { criarImagemMaterialController } = require('../../src/controllers/imagem-material.controller');
const { criarUploadDoAmbiente } = require('../../src/services/imagem-material-upload.service');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { criarProcessadorFalso } = require('../helpers/processador-imagem-falso');
const { png } = require('../helpers/imagens-validas');
const { criarArmazenamentoMemoriaFalso } = require('../storage/helpers/armazenamento-memoria-falso');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');

/**
 * Biblioteca de Imagens, Unidade 5C-2 — a FIAÇÃO DE PRODUÇÃO do envio: enquanto não existir o processador definitivo, o backend em execução real não pode
 * aceitar upload. Quem monta o controller sem processador (como faz o app.js: `criarImagemMaterialController({ pool })`), ou sem armazenamento, recebe 503
 * IMAGENS_INDISPONIVEL de uma requisição AUTORIZADA e válida, sem ler o banco, sem decodificar e sem gravar nenhum arquivo. O processador falso dos testes
 * nunca é importado por src/ (varredura estática no fim). Nada aqui acessa o banco.
 */

const CAMINHO = '/api/imagens-material/empresa';
let sequencia = 9000;
const identidade = () => { sequencia += 1; return { empresa: sequencia, usuario: sequencia * 10 + 1 }; };

const sessaoFalsa = (req, res, next) => {
  const empresa = Number.parseInt(req.headers['x-teste-empresa'] ?? '', 10);
  const usuario = Number.parseInt(req.headers['x-teste-usuario'] ?? '', 10);
  if (!Number.isInteger(empresa) || !Number.isInteger(usuario)) { next(HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada')); return; }
  req.empresa = { id: empresa };
  req.usuario = { id: usuario, perfil: 'ADMINISTRADOR' };
  next();
};

// O banco nunca pode ser tocado: qualquer uso vira um erro que derrubaria a resposta para 500 (e o teste).
const poolProibido = () => ({ connect: async () => { throw new Error('o banco não deve ser tocado'); }, query: async () => { throw new Error('o banco não deve ser tocado'); } });

function montar(t, dependencias) {
  t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => ({ podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: false }));
  t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => null);
  t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
  const pool = poolProibido();
  const controller = criarImagemMaterialController({ pool, ...dependencias });
  return criarAppTeste((a) => a.use('/api', criarImagemMaterialRoutes({ controller, exigirSessao: sessaoFalsa, pool })));
}

const enviarImagem = (app, quem = identidade()) => {
  return request(app).post(`${CAMINHO}?nome=Luva`).set('x-teste-empresa', String(quem.empresa)).set('x-teste-usuario', String(quem.usuario))
    .set('Content-Type', 'image/png').send(png(320, 320));
};
const resumo = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const indisponivel = (r) => assert.deepEqual([r.status, r.body.codigo], [503, 'IMAGENS_INDISPONIVEL'], resumo(r));

const raizes = [];
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

describe('envio de imagem — sem processador definitivo o backend responde 503 e não grava nada', () => {
  test('PROD-01 — com armazenamento e SEM processador (o caso real de hoje): 503 IMAGENS_INDISPONIVEL, nenhum arquivo gravado, banco intocado', async (t) => {
    const armazenamento = criarArmazenamentoMemoriaFalso();
    const app = montar(t, { armazenamento });
    const quem = identidade();
    const r = await enviarImagem(app, quem);
    indisponivel(r);
    assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'message', 'status']);
    assert.deepEqual(await armazenamento.listar(String(quem.empresa)), []);
  });

  test('PROD-02 — com processador e SEM armazenamento (null): 503, e o processador nem é chamado', async (t) => {
    const processador = criarProcessadorFalso();
    const app = montar(t, { armazenamento: null, processador });
    indisponivel(await enviarImagem(app));
    assert.equal(processador.chamadas.length, 0);
  });

  test('PROD-03 — só o pool (como o app.js monta o controller; ambiente sem diretório de imagens): 503', async (t) => {
    const app = montar(t, {});
    indisponivel(await enviarImagem(app));
  });

  test('PROD-04 — serviço de envio explicitamente indisponível (envio: null): 503', async (t) => {
    const app = montar(t, { envio: null });
    indisponivel(await enviarImagem(app));
  });

  test('PROD-05 — a fábrica recusa dependências malformadas na montagem (TypeError), não na primeira requisição', () => {
    const pool = poolProibido();
    assert.throws(() => criarImagemMaterialController({ pool, armazenamento: {}, processador: criarProcessadorFalso() }), TypeError);
    assert.throws(() => criarImagemMaterialController({ pool, armazenamento: criarArmazenamentoMemoriaFalso(), processador: {} }), TypeError);
  });
});

describe('criarUploadDoAmbiente — o armazenamento vem do ambiente; o processador é sempre explícito', () => {
  test('PROD-06 — sem diretório configurado (ausente ou em branco): 503 antes de qualquer coisa', async () => {
    for (const origem of [{}, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '' }, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '   ' }]) {
      const envio = criarUploadDoAmbiente({ processador: criarProcessadorFalso(), origem });
      await assert.rejects(envio.enviar(poolProibido(), { empresaId: 3, atorId: 9, nome: 'Luva', bytes: png(320, 320) }), (falha) => falha.status === 503 && falha.codigo === 'IMAGENS_INDISPONIVEL');
    }
  });

  test('PROD-07 — com diretório válido e SEM processador: 503 e o diretório continua sem arquivo de imagem', async () => {
    const diretorio = path.join(novaRaiz(), 'imagens');
    const envio = criarUploadDoAmbiente({ origem: { IMAGENS_ARMAZENAMENTO_DIRETORIO: diretorio } });
    await assert.rejects(envio.enviar(poolProibido(), { empresaId: 3, atorId: 9, nome: 'Luva', bytes: png(320, 320) }), (falha) => falha.status === 503 && falha.codigo === 'IMAGENS_INDISPONIVEL');
    assert.deepEqual(fs.readdirSync(diretorio), []);
  });

  test('PROD-08 — diretório inválido (relativo) falha cedo com IMAGENS_DIRETORIO_INVALIDO, sem ecoar o valor', () => {
    assert.throws(
      () => criarUploadDoAmbiente({ origem: { IMAGENS_ARMAZENAMENTO_DIRETORIO: 'relativo/ao/projeto' } }),
      (falha) => falha.codigo === 'IMAGENS_DIRETORIO_INVALIDO' && !String(falha.message).includes('relativo/ao/projeto'),
    );
  });
});

describe('envio de imagem — nada de teste vaza para produção', () => {
  test('PROD-09 — nenhum arquivo de src/ importa o processador falso, os geradores de imagem de teste ou qualquer coisa de test/', () => {
    const raiz = path.join(__dirname, '..', '..', 'src');
    const arquivos = [];
    const andar = (dir) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) andar(completo);
        else if (entrada.name.endsWith('.js') && !/ 2\.js$/.test(entrada.name)) arquivos.push(completo);
      }
    };
    andar(raiz);
    assert.ok(arquivos.length > 100, 'a varredura precisa enxergar o código de src/');
    const proibido = /processador-imagem-falso|imagens-validas|armazenamento-memoria-falso|require\(\s*['"](?:\.\.?\/)+test\//;
    const achados = arquivos.filter((arquivo) => proibido.test(fs.readFileSync(arquivo, 'utf8'))).map((arquivo) => path.relative(raiz, arquivo));
    assert.deepEqual(achados, []);
  });
});
