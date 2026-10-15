'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Atendimento Token — Etapa J, J2a (RED, estático): leitura de arquivos, sem banco, sem rede, sem executar código de produção
 * (exceto a carga do módulo no teste S05). Protege o que o J2a NÃO pode mudar (autenticação e rotação da Etapa C, migrations) e
 * o que o J2a deve respeitar (heartbeat independente do atendimento, sem dado pessoal, job externo sem timer na API).
 *
 * Razões contratuais válidas de falha: "arquivo ainda não implementado: ..." e "módulo ainda não implementado: ...".
 * Os controles K passam já no RED e devem continuar passando no GREEN.
 */

const RAIZ = path.join(__dirname, '..', '..');
const caminho = (relativo) => path.join(RAIZ, relativo);
const existe = (relativo) => fs.existsSync(caminho(relativo));
function ler(relativo) {
  assert.ok(existe(relativo), `arquivo ainda não implementado: ${relativo}`);
  return fs.readFileSync(caminho(relativo), 'utf8');
}
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ARQUIVOS_DO_HEARTBEAT = [
  'src/routes/token-heartbeat.routes.js',
  'src/controllers/token-heartbeat.controller.js',
  'src/services/token-monitoramento.service.js',
];
const TOKENS_PROIBIDOS_NO_HEARTBEAT = [
  'gepi_atendimento', 'token_atendimentos', 'token-atendimento', 'funcionarios', 'solicitacoes_epi', 'estoque_', 'entregas_epi', 'sessoes', 'cpf', 'matricula',
];

describe('J2a — estático: o que não muda e o que o heartbeat deve respeitar', () => {
  describe('controles (devem passar já no RED)', () => {
    test('K1 — autenticar (Etapa C) mantém rotação condicional, carência, REUSO_CREDENCIAL e a rede decidida ANTES da rotação', () => {
      const codigo = semComentarios(ler('src/services/token-tablet.service.js'));
      const inicio = codigo.indexOf('async function autenticar');
      assert.ok(inicio >= 0, 'autenticar não encontrada');
      const autenticar = codigo.slice(inicio);
      for (const trecho of ['credencialRepo.rotacionar', "'CREDENCIAL_RENOVADA'", "'REUSO_CREDENCIAL'", 'carenciaSegundos', 'rotacao_devida', 'credencialAtualHash']) {
        assert.ok(autenticar.includes(trecho), `falta ${trecho} em autenticar`);
      }
      assert.ok(autenticar.indexOf('ipFixoAutorizado') < autenticar.indexOf('credencialRepo.rotacionar'), 'a rede deve ser decidida antes da rotação');
    });

    test('K2 — exigirDispositivo (Etapa C) só emite Set-Cookie quando a requisição rotacionou e só lê o cookie do tablet', () => {
      const codigo = semComentarios(ler('src/middleware/autenticacao-dispositivo.js'));
      assert.ok(/if \(novaCredencial !== null\) res\.append\('Set-Cookie'/.test(codigo));
      assert.ok(codigo.includes('authConfig.dispositivo.cookieNome'));
      assert.equal(/Authorization|req\.query|req\.body/.test(codigo), false);
    });

    test('K3 — a migration 088 permanece suspensa: não existe arquivo 088_* nem entrada 088 no manifesto', () => {
      const arquivos = fs.readdirSync(caminho('migrations')).filter((nome) => nome.startsWith('088_'));
      assert.deepEqual(arquivos, []);
      const manifesto = fs.readFileSync(caminho('migrations/checksums.json'), 'utf8');
      assert.equal(/"088[_"]/.test(manifesto), false);
    });

    test('K4 — as rotas do tablet da Etapa C mantêm ativar e estado, e o estado valida a query antes de autenticar', () => {
      const codigo = semComentarios(ler('src/routes/token-tablet.routes.js'));
      assert.ok(codigo.includes('`${RAIZ}/ativar`') && codigo.includes('`${RAIZ}/estado`'));
      assert.ok(codigo.indexOf('validar({ query: schemas.estado.query })') < codigo.indexOf('exigirDispositivo, porDispositivo'));
    });

    test('K5 — nenhum módulo existente do tablet usa temporizador: a API não mantém timer nenhum para o tablet', () => {
      for (const relativo of ['src/routes/token-tablet.routes.js', 'src/controllers/token-tablet.controller.js', 'src/services/token-tablet.service.js', 'src/middleware/autenticacao-dispositivo.js']) {
        assert.equal(/setInterval|setTimeout/.test(semComentarios(ler(relativo))), false, relativo);
      }
    });
  });

  describe('contrato do J2a', () => {
    test('S01 — a rota do heartbeat é POST /heartbeat sob o exigirDispositivo EXISTENTE (sem reimplementar a autenticação)', () => {
      const codigo = semComentarios(ler('src/routes/token-heartbeat.routes.js'));
      assert.ok(/router\.post\(/.test(codigo) && /heartbeat/.test(codigo));
      assert.ok(codigo.includes('criarExigirDispositivo'), 'deve usar criarExigirDispositivo');
      assert.equal(/router\.(get|put|patch|delete)\(/.test(codigo), false, 'só POST');
      assert.equal(/credencialRepo|hashTokenSessao|gerarTokenSessao|rotacionar/.test(codigo), false, 'não reimplementa credencial nem rotação');
    });

    test('S02 — heartbeat e job não tocam atendimento, funcionário, pedido, estoque nem sessão, e não carregam dado pessoal', () => {
      for (const relativo of ARQUIVOS_DO_HEARTBEAT) {
        const codigo = semComentarios(ler(relativo)).toLowerCase();
        for (const proibido of TOKENS_PROIBIDOS_NO_HEARTBEAT) {
          assert.equal(codigo.includes(proibido), false, `${relativo} referencia "${proibido}"`);
        }
      }
    });

    test('S03 — sem temporizador na API nem no serviço: a verificação é de um job externo; app.js e server.js não carregam o job', () => {
      for (const relativo of ARQUIVOS_DO_HEARTBEAT) {
        assert.equal(/setInterval|setTimeout|node-cron|\bcron\b/i.test(semComentarios(ler(relativo))), false, relativo);
      }
      for (const relativo of ['src/app.js', 'src/server.js']) {
        const codigo = semComentarios(ler(relativo));
        assert.equal(/token-monitoramento|verificar-comunicacao-token|verificarComunicacao/.test(codigo), false, `${relativo} não deve carregar o job`);
      }
    });

    test('S04 — o job é um script externo de execução única, exposto por npm run token:verificar-comunicacao', () => {
      const script = semComentarios(ler('scripts/verificar-comunicacao-token.js'));
      assert.ok(script.includes('verificarComunicacao'));
      assert.equal(/\.listen\(|require\('express'\)|setInterval/.test(script), false, 'o script não abre porta nem repete sozinho');
      const pacote = JSON.parse(ler('package.json'));
      assert.match(pacote.scripts?.['token:verificar-comunicacao'] ?? '', /scripts\/verificar-comunicacao-token\.js/);
    });

    test('S05 — o serviço de monitoramento expõe derivarEstado e verificarComunicacao e não importa o serviço de atendimento', () => {
      const servico = exigirModulo('src/services/token-monitoramento.service');
      assert.equal(typeof servico.derivarEstado, 'function');
      assert.equal(typeof servico.verificarComunicacao, 'function');
      assert.equal(/token-atendimento|solicitacao-epi/.test(ler('src/services/token-monitoramento.service.js')), false);
    });
  });
});
