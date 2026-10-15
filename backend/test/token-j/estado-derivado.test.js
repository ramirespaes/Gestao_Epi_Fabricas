'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa J, J2a (RED, unidade): estado efetivo do tablet derivado do último contato.
 * Sem banco, sem rede. O estado efetivo é uma LEITURA derivada; não é a transição QUEDA (essa é do job, nos testes de integração).
 *
 * Premissas (a confirmar no GREEN):
 *   - src/config/token-monitoramento.js exporta LIMIAR_OFFLINE_SEGUNDOS (180) e CONFIRMACAO_SEGUNDOS (90).
 *   - src/services/token-monitoramento.service.js exporta derivarEstado(linha, agora) -> 'NAO_ATIVADO' | 'SEM_COMUNICACAO' | 'ONLINE' |
 *     'OFFLINE' | 'REVOGADO', com linha nas colunas de token_dispositivos (ativado_em, revogado_em, ultimo_contato_em, comunicacao_registrada).
 *
 * Razões contratuais válidas de falha: "módulo ainda não implementado: ..." e "função ainda não implementada: ...".
 * Dependentes de decisão (TODO JUSTIFICADO, nunca PASS nem RED): DEC-D5-01 (limite exato de 180 s) e DEC-J2A-02 (carimbo futuro).
 * Regra contratual que sustenta os testes: o estado efetivo é DERIVADO do último contato (D3); a QUEDA é outra coisa (transição
 * confirmada pelo job, nos testes de integração) e não é decidida por esta função.
 */

const AGORA = new Date('2026-10-13T12:00:00.000Z');
const antes = (segundos) => new Date(AGORA.getTime() - segundos * 1000);
const linha = (extra = {}) => ({ ativado_em: antes(86400), revogado_em: null, ultimo_contato_em: antes(10), comunicacao_registrada: 'ONLINE', ...extra });

function estadoDe(entrada, agora = AGORA) {
  const servico = exigirModulo('src/services/token-monitoramento.service');
  assert.equal(typeof servico.derivarEstado, 'function', 'função ainda não implementada: derivarEstado');
  return servico.derivarEstado(entrada, agora);
}

describe('J2a — estado efetivo derivado (unidade)', () => {
  describe('controles (devem passar já no RED)', () => {
    test('K1 — a carência da credencial anterior existe na configuração da Etapa C, dentro dos limites que ela impõe', () => {
      const carencia = authConfig.dispositivo.carenciaSegundos;
      assert.ok(Number.isInteger(carencia) && carencia >= 5 && carencia <= 600, `carência fora dos limites da Etapa C: ${carencia}`);
    });

    test('K2 — invariante do D17: carência >= 1,8 x intervalo máximo do heartbeat (60 s + 10% de jitter = 66 s)', () => {
      assert.ok(authConfig.dispositivo.carenciaSegundos >= 1.8 * 66, `carência ${authConfig.dispositivo.carenciaSegundos} s não cobre uma batida perdida`);
    });
  });

  describe('parâmetros aprovados', () => {
    test('U01 — os limiares aprovados (180 s de ausência; 90 s adicionais de confirmação) vêm de um único módulo de configuração', () => {
      const configuracao = exigirModulo('src/config/token-monitoramento');
      assert.equal(configuracao.LIMIAR_OFFLINE_SEGUNDOS, 180);
      assert.equal(configuracao.CONFIRMACAO_SEGUNDOS, 90);
    });
  });

  describe('estado efetivo', () => {
    test('U02 — tablet não ativado é NAO_ATIVADO', () => {
      assert.equal(estadoDe(linha({ ativado_em: null, ultimo_contato_em: null, comunicacao_registrada: null })), 'NAO_ATIVADO');
    });

    test('U03 — ativado que nunca comunicou é SEM_COMUNICACAO, por mais tempo que se passe desde a ativação (não é queda)', () => {
      const ativadoHaUmAno = antes(365 * 86400);
      assert.equal(estadoDe(linha({ ativado_em: ativadoHaUmAno, ultimo_contato_em: null, comunicacao_registrada: null })), 'SEM_COMUNICACAO');
    });

    test('U04 — até 179 s sem comunicação o estado efetivo é ONLINE', () => {
      for (const segundos of [0, 1, 60, 120, 179]) {
        assert.equal(estadoDe(linha({ ultimo_contato_em: antes(segundos) })), 'ONLINE', `${segundos} s`);
      }
    });

    test('U05 — a partir de 181 s sem comunicação o estado efetivo é OFFLINE', () => {
      for (const segundos of [181, 270, 3600, 86400]) {
        assert.equal(estadoDe(linha({ ultimo_contato_em: antes(segundos) })), 'OFFLINE', `${segundos} s`);
      }
    });

    test('U06 — OFFLINE efetivo aparece aos 180 s e NÃO depende da confirmação de 90 s: com 181 s o estado visual já é OFFLINE mesmo com a transição ainda não registrada', () => {
      assert.equal(estadoDe(linha({ ultimo_contato_em: antes(181), comunicacao_registrada: 'ONLINE' })), 'OFFLINE');
    });

    test('U07 — o estado é derivado do último contato, não do valor registrado: OFFLINE registrado com contato recente é ONLINE', () => {
      assert.equal(estadoDe(linha({ ultimo_contato_em: antes(5), comunicacao_registrada: 'OFFLINE' })), 'ONLINE');
    });

    test('U08 — tablet revogado é REVOGADO, com contato recente ou sem contato nenhum', () => {
      const revogado = antes(30);
      assert.equal(estadoDe(linha({ revogado_em: revogado, ultimo_contato_em: antes(5) })), 'REVOGADO');
      assert.equal(estadoDe(linha({ revogado_em: revogado, ultimo_contato_em: null, comunicacao_registrada: null })), 'REVOGADO');
    });

    test('U10 — a derivação é pura: não altera a linha recebida e é repetível', () => {
      const entrada = Object.freeze(linha({ ultimo_contato_em: antes(200) }));
      const primeiro = estadoDe(entrada);
      assert.equal(estadoDe(entrada), primeiro);
      assert.equal(primeiro, 'OFFLINE');
      assert.deepEqual(entrada, linha({ ultimo_contato_em: antes(200) }));
    });

    test('U11 — só existem os cinco estados do contrato, nenhum deles afirma a causa da ausência', () => {
      const vistos = new Set([
        estadoDe(linha({ ativado_em: null, ultimo_contato_em: null })),
        estadoDe(linha({ ultimo_contato_em: null })),
        estadoDe(linha()),
        estadoDe(linha({ ultimo_contato_em: antes(1000) })),
        estadoDe(linha({ revogado_em: antes(1) })),
      ]);
      assert.deepEqual([...vistos].sort(), ['NAO_ATIVADO', 'OFFLINE', 'ONLINE', 'REVOGADO', 'SEM_COMUNICACAO']);
    });
  });

  describe('TODO JUSTIFICADO — dependentes de decisão contratual pendente (nunca contam como PASS nem como RED)', () => {
    test('DEP-U01 — limite exato de 180 s', {
      todo: 'DECISÃO PENDENTE DEC-D5-01 (limite exato): o contrato aprovado diz "após 180 segundos" e a formalização inclusivo/exclusivo não foi fechada. EXPECTATIVA A DEFINIR: 180,000 s é ONLINE (exclusivo) ou OFFLINE (inclusivo). O RED só fixa 179 s ONLINE e 181 s OFFLINE.',
    }, () => {
      assert.equal(estadoDe(linha({ ultimo_contato_em: antes(180) })), 'OFFLINE');
    });

    test('DEP-U02 — último contato posterior ao "agora" informado (carimbo futuro)', {
      todo: 'DECISÃO PENDENTE DEC-J2A-02 (carimbo futuro): nenhum contrato aprovado trata contato com instante posterior ao relógio da leitura. EXPECTATIVA A DEFINIR: tratar como ONLINE (hipótese deste teste) ou como dado inválido.',
    }, () => {
      assert.equal(estadoDe(linha({ ultimo_contato_em: new Date(AGORA.getTime() + 5000) })), 'ONLINE');
    });
  });
});
