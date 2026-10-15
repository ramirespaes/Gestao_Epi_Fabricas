'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  COOKIE_ATENDIMENTO, BASE, NAO_IDENTIFICADO, ATENDIMENTO_INVALIDO, INATIVIDADE_SEGUNDOS, cabecalhoCookie, cookieDoAtendimentoNaResposta, abrirAmbienteAtendimento,
} = require('./helpers/token-atendimento');
const {
  sha256, varrer, cookieDoTabletNaResposta, ORIGEM, IP_TESTE, COOKIE_TABLET, CAMINHO_TABLET, criarLimitador, modulos,
} = require('./helpers/token-tablet');
const { comMascara } = require('../helpers/cpf-ficticio');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../../src/security/token');
const { normalizarCpf } = require('../../src/utils/normalizacao');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa D (RED): IDENTIFICAÇÃO do funcionário no tablet por CPF ou matrícula. PostgreSQL real, schema temporário.
 * CPF e matrícula são IDENTIFICADORES, não autenticação forte: o risco residual de personificação é aceito e compensado por tablet
 * autorizado, rede corporativa, limite de tentativas, atendimento curto (60 s de inatividade), aprovação da SST e conferência na entrega. Nenhum PIN,
 * senha, data de nascimento, crachá ou segundo fator existe nem pode entrar indiretamente (campo extra = 400).
 *
 * Regra explícita de escolha: o corpo traz `tipo` ('CPF' ou 'MATRICULA'); NUNCA se adivinha pelo formato. Uma matrícula só de números
 * (inclusive com 11 dígitos) é matrícula quando o tipo é MATRICULA, e CPF quando o tipo é CPF; sem fallback entre os dois.
 * Decisões do responsável (11/10/2026): matrícula comparada pelo contrato REAL do banco — igualdade exata, sensível a caixa (a unicidade
 * (empresa, matrícula) permite 'Ab-1' e 'aB-1' na mesma empresa), com os zeros à esquerda e a normalização que o cadastro já aplica
 * (aparar e NFC), nunca convertida em número; CPF só pela estrutura de 11 dígitos (sem exigir dígitos verificadores, para não bloquear
 * cadastros legados); a resposta devolve só o PRIMEIRO NOME; limite de 10 tentativas por minuto POR TABLET, sem cooldown persistente;
 * cookie do atendimento com SameSite=Strict próprio.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];

describe('Atendimento Token — D: identificação do funcionário (PostgreSQL real)', () => {
  let a;
  let app;

  before(async () => {
    a = await abrirAmbienteAtendimento();
    app = a.criarApp({ hops: 0 });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const tabletNovo = (empresaId = a.d.empresaA, horas = 0) => a.ativado(empresaId, { horasDesdeEmissao: horas });
  const ident = (tablet, corpo, cab, aplicacao = app) => a.identificar(aplicacao, tablet?.credencial ?? null, corpo, cab);

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED) ─────────────
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — fixtures: tablet autenticado pela credencial da Etapa C; funcionários de situações diferentes; atendimento direto com token canônico', async () => {
      const t = await tabletNovo();
      const r = await a.comoTablet(a.criarApp(), t.credencial).get(`${CAMINHO_TABLET}/estado`);
      assert.equal(r.status, 200, aviso(r));
      const ativo = await a.funcionario(a.d.empresaA);
      const afastado = await a.funcionario(a.d.empresaA, { situacao: 'AFASTADO' });
      const inativo = await a.funcionario(a.d.empresaA, { situacao: 'INATIVO' });
      assert.deepEqual([ativo.situacao, afastado.situacao, inativo.situacao, ativo.ativo, afastado.ativo], ['ATIVO', 'AFASTADO', 'INATIVO', true, false]);
      const { id, token } = await a.atendimentoDireto(t, ativo.id);
      assert.equal(tokenSessaoTemFormatoValido(token), true);
      assert.equal((await a.atendimento(id)).token_hash, hashTokenSessao(token));
      assert.equal((await a.abertosDe(t.id)).length, 1);
    });

    test('K2 — normalização de CPF já existente: com ou sem pontuação vira os mesmos 11 dígitos; qualquer outro caractere não é CPF', () => {
      assert.equal(normalizarCpf('123.456.789-09'), '12345678909');
      assert.equal(normalizarCpf('12345678909'), '12345678909');
      for (const ruim of ['1234567890', '123456789012', '123 456 789 09', 'abc.def.ghi-jk', '', null, 12345678909]) assert.equal(normalizarCpf(ruim), null, String(ruim));
    });

    test('K3 — o cadastro permite o MESMO CPF e a MESMA matrícula em empresas diferentes e uma matrícula igual a um CPF na mesma empresa (por isso o tipo tem de ser explícito e a empresa vir do tablet)', async () => {
      const cpf = (await a.funcionario(a.d.empresaA)).cpf;
      const naB = await a.funcionario(a.d.empresaB, { cpf, matricula: 'COMUM-1' });
      const naA = await a.funcionario(a.d.empresaA, { matricula: 'COMUM-1' });
      assert.equal(naB.cpf, cpf);
      assert.equal(naA.matricula, naB.matricula);
      const onzeDigitos = '98765432100';
      const comoMatricula = await a.funcionario(a.d.empresaA, { matricula: onzeDigitos });
      assert.equal(comoMatricula.matricula, onzeDigitos);
    });
  });

  // ───────────────────────── identificação: sucesso, formato e privacidade ─────────────────────────
  describe('identificação válida', () => {
    test('I1 — CPF cadastrado, com ou sem pontuação: 201 com SÓ o primeiro nome; cookie do atendimento (HttpOnly, Path próprio, curto); banco com empresa e tablet do SERVIDOR e só o hash do token; prazo de 60 s', async () => {
      const f = await a.funcionario(a.d.empresaA, { nome: 'Maria Aparecida da Silva' });
      for (const [i, valor] of [f.cpf, comMascara(f.cpf)].entries()) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'CPF', valor });
        assert.equal(r.status, 201, `${i}: ${aviso(r)}`);
        assert.deepEqual(Object.keys(r.body).sort(), ['atendimento', 'status']);
        assert.deepEqual(Object.keys(r.body.atendimento).sort(), ['expiraEm', 'funcionario', 'inatividadeSegundos']);
        assert.deepEqual(r.body.atendimento.funcionario, { primeiroNome: 'Maria' });
        assert.equal(r.body.atendimento.inatividadeSegundos, INATIVIDADE_SEGUNDOS);
        const restante = (new Date(r.body.atendimento.expiraEm).getTime() - Date.now()) / 1000;
        assert.ok(restante > 50 && restante <= 61, `prazo de 60 s, veio ${restante}s`);
        const cookie = cookieDoAtendimentoNaResposta(r);
        assert.ok(cookie, 'cookie do atendimento ausente');
        assert.equal(tokenSessaoTemFormatoValido(cookie.valor), true, 'token de 256 bits em formato canônico');
        assert.equal(cookie.atributos.httponly, true);
        assert.equal(cookie.atributos.path, BASE);
        assert.equal(cookie.atributos.domain, undefined);
        assert.equal(String(cookie.atributos.samesite).toLowerCase(), 'strict', 'D-D9: SameSite=Strict próprio do cookie do atendimento');
        assert.equal(cookie.atributos.secure === true, authConfig.sessao.cookieSecure);
        assert.ok(Number(cookie.atributos['max-age']) > 0 && Number(cookie.atributos['max-age']) <= 1800, 'cookie curto (no máximo 30 min); o servidor decide os 60 s');
        const abertos = await a.abertosDe(t.id);
        assert.equal(abertos.length, 1);
        assert.deepEqual([abertos[0].empresa_id, abertos[0].dispositivo_id, abertos[0].funcionario_id, abertos[0].token_hash], [a.d.empresaA, t.id, f.id, hashTokenSessao(cookie.valor)]);
        assert.deepEqual(varrer(abertos, [cookie.valor], { hex64: false }), [], 'o token em claro não existe no banco');
        // O token em claro só pode existir no Set-Cookie (HttpOnly): corpo e demais cabeçalhos não o trazem.
        const { 'set-cookie': _cookies, ...cabecalhosSemCookie } = r.headers;
        const texto = JSON.stringify(r.body) + JSON.stringify(cabecalhosSemCookie);
        for (const proibido of [f.cpf, comMascara(f.cpf), f.matricula, 'Aparecida', 'Silva', cookie.valor]) assert.equal(texto.includes(proibido), false, `vazou: ${proibido === cookie.valor ? '<token>' : proibido}`);
      }
    });

    test('I2 — matrícula alfanumérica cadastrada (com hífen e maiúsculas/minúsculas misturadas) identifica; a comparação é EXATA, então outra caixa não identifica (decisão proposta, como o cadastro e a unicidade do banco)', async () => {
      const f = await a.funcionario(a.d.empresaA, { matricula: 'Ab12-Cd3' });
      const t = await tabletNovo();
      const ok = await ident(t, { tipo: 'MATRICULA', valor: 'Ab12-Cd3' });
      assert.equal(ok.status, 201, aviso(ok));
      assert.equal((await a.abertosDe(t.id))[0].funcionario_id, f.id);
      const t2 = await tabletNovo();
      const outraCaixa = await ident(t2, { tipo: 'MATRICULA', valor: 'ab12-cd3' });
      assert.deepEqual([outraCaixa.status, outraCaixa.body.codigo], NAO_IDENTIFICADO, aviso(outraCaixa));
      assert.equal((await a.abertosDe(t2.id)).length, 0);
    });

    test('I3 — identificador AMBÍGUO: o mesmo número de 11 dígitos é o CPF de uma pessoa e a matrícula de outra; o TIPO escolhido decide, sem heurística de tamanho e sem PIN', async () => {
      const donoDoCpf = await a.funcionario(a.d.empresaA, { nome: 'Carlos Dono Cpf', matricula: 'CARLOS-1' });
      const donoDaMatricula = await a.funcionario(a.d.empresaA, { nome: 'Beatriz Dona Matricula', matricula: donoDoCpf.cpf });
      const t1 = await tabletNovo();
      const porCpf = await ident(t1, { tipo: 'CPF', valor: donoDoCpf.cpf });
      assert.equal(porCpf.status, 201, aviso(porCpf));
      assert.equal((await a.abertosDe(t1.id))[0].funcionario_id, donoDoCpf.id);
      assert.deepEqual(porCpf.body.atendimento.funcionario, { primeiroNome: 'Carlos' });
      const t2 = await tabletNovo();
      const porMatricula = await ident(t2, { tipo: 'MATRICULA', valor: donoDoCpf.cpf });
      assert.equal(porMatricula.status, 201, aviso(porMatricula));
      assert.equal((await a.abertosDe(t2.id))[0].funcionario_id, donoDaMatricula.id);
      assert.deepEqual(porMatricula.body.atendimento.funcionario, { primeiroNome: 'Beatriz' });
    });

    test('I4 — matrícula só de números (curta ou de 11 dígitos) é matrícula; e SEM fallback entre os tipos: o valor que só existe como o outro tipo é "não identificado"', async () => {
      const curta = await a.funcionario(a.d.empresaA, { matricula: '12345' });
      const longa = await a.funcionario(a.d.empresaA, { matricula: '55544433322' });
      const soCpf = await a.funcionario(a.d.empresaA);
      const t1 = await tabletNovo();
      assert.equal((await ident(t1, { tipo: 'MATRICULA', valor: '12345' })).status, 201);
      assert.equal((await a.abertosDe(t1.id))[0].funcionario_id, curta.id);
      const t2 = await tabletNovo();
      assert.equal((await ident(t2, { tipo: 'MATRICULA', valor: '55544433322' })).status, 201);
      assert.equal((await a.abertosDe(t2.id))[0].funcionario_id, longa.id);
      const t3 = await tabletNovo();
      const cpfComoMatricula = await ident(t3, { tipo: 'MATRICULA', valor: soCpf.cpf });
      assert.deepEqual([cpfComoMatricula.status, cpfComoMatricula.body.codigo], NAO_IDENTIFICADO, 'o CPF só vale como CPF');
      const matriculaComoCpf = await ident(t3, { tipo: 'CPF', valor: '55544433322' });
      assert.deepEqual([matriculaComoCpf.status, matriculaComoCpf.body.codigo], NAO_IDENTIFICADO, 'a matrícula de 11 dígitos só vale como matrícula');
      assert.equal((await a.abertosDe(t3.id)).length, 0);
      const curtaComoCpf = await ident(t3, { tipo: 'CPF', valor: '12345' });
      assert.deepEqual([curtaComoCpf.status, curtaComoCpf.body.codigo], [400, 'VALIDACAO'], 'CPF precisa de exatamente 11 algarismos');
    });
  });

  // ───────────────────────── matrícula e CPF conforme o contrato REAL do cadastro (decisões D-D2 e D-D8) ─────────────────────────
  describe('matrícula e CPF conforme o cadastro real', () => {
    test('M1 — zeros à esquerda e texto são preservados: a matrícula "000123" identifica quem a tem e "123" NÃO (nunca convertida em número); a numérica de 11 dígitos com zeros à esquerda também é matrícula', async () => {
      const comZeros = await a.funcionario(a.d.empresaA, { matricula: '000123', nome: 'Zeros Esquerda' });
      const semZeros = await a.funcionario(a.d.empresaA, { matricula: '123', nome: 'Sem Zeros' });
      const onzeComZeros = await a.funcionario(a.d.empresaA, { matricula: '00123456789', nome: 'Onze Digitos' });
      const casos = [['000123', comZeros, 'Zeros'], ['123', semZeros, 'Sem'], ['00123456789', onzeComZeros, 'Onze']];
      for (const [valor, esperado, primeiro] of casos) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'MATRICULA', valor });
        assert.equal(r.status, 201, `${valor}: ${aviso(r)}`);
        assert.equal((await a.abertosDe(t.id))[0].funcionario_id, esperado.id, `${valor} identifica a pessoa certa`);
        assert.deepEqual(r.body.atendimento.funcionario, { primeiroNome: primeiro });
      }
      const t = await tabletNovo();
      for (const inexistente of ['0123', '0000123', '123.0', '1.23e2', '00123456788']) {
        const r = await ident(t, { tipo: 'MATRICULA', valor: inexistente });
        assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, `${inexistente} não é conversão numérica de nenhuma matrícula: ${aviso(r)}`);
      }
    });

    test('M2 — caixa verificada NO BANCO: a unicidade (empresa, matrícula) permite "Ab-1" e "aB-1" na mesma empresa, então a comparação é exata e cada uma identifica a sua pessoa, sem equivalência entre maiúsculas e minúsculas', async () => {
      const { rows } = await a.q("SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.conname = 'uq_funcionarios_empresa_matricula' AND c.contype = 'u' AND n.nspname = current_schema()");
      assert.equal(rows.length, 1, 'premissa: unicidade comum (sensível a caixa), não por lower()');
      const um = await a.funcionario(a.d.empresaA, { matricula: 'Ab-1', nome: 'Primeira Pessoa' });
      const dois = await a.funcionario(a.d.empresaA, { matricula: 'aB-1', nome: 'Segunda Pessoa' });
      for (const [valor, esperado, primeiro] of [['Ab-1', um, 'Primeira'], ['aB-1', dois, 'Segunda']]) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'MATRICULA', valor });
        assert.equal(r.status, 201, `${valor}: ${aviso(r)}`);
        assert.equal((await a.abertosDe(t.id))[0].funcionario_id, esperado.id);
        assert.deepEqual(r.body.atendimento.funcionario, { primeiroNome: primeiro });
      }
      const t = await tabletNovo();
      const outraCaixa = await ident(t, { tipo: 'MATRICULA', valor: 'AB-1' });
      assert.deepEqual([outraCaixa.status, outraCaixa.body.codigo], NAO_IDENTIFICADO, 'nenhuma terceira variação de caixa identifica ninguém');
    });

    test('M3 — a normalização é a do CADASTRO, nem mais nem menos: espaços nas pontas e forma Unicode (NFD) do que foi digitado equivalem ao armazenado (NFC); letras acentuadas são preservadas, e nada é removido do meio (hífen, ponto, espaço interno)', async () => {
      const acentuada = await a.funcionario(a.d.empresaA, { matricula: 'JOSÉ-9' });
      const comPonto = await a.funcionario(a.d.empresaA, { matricula: 'AB.12-X' });
      for (const [valor, esperado] of [['JOSÉ-9', acentuada], [' JOSÉ-9 ', acentuada], ['JOSÉ-9', acentuada], ['AB.12-X', comPonto]]) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'MATRICULA', valor });
        assert.equal(r.status, 201, `${JSON.stringify(valor)}: ${aviso(r)}`);
        assert.equal((await a.abertosDe(t.id))[0].funcionario_id, esperado.id);
      }
      const t = await tabletNovo();
      for (const alterado of ['JOSE-9', 'AB12X', 'AB 12-X', 'AB.12X']) {
        const r = await ident(t, { tipo: 'MATRICULA', valor: alterado });
        assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, `${alterado} não é "normalizado" para a matrícula cadastrada: ${aviso(r)}`);
      }
    });

    test('M4 — CPF só pela ESTRUTURA (11 dígitos): um CPF legado com dígitos verificadores inválidos que está cadastrado identifica normalmente, e a pontuação continua opcional', async () => {
      const legado = await a.funcionario(a.d.empresaA, { cpf: '11111111112', nome: 'Legado Sem Dv' });
      for (const valor of ['11111111112', '111.111.111-12']) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'CPF', valor });
        assert.equal(r.status, 201, `${valor}: ${aviso(r)}`);
        assert.equal((await a.abertosDe(t.id))[0].funcionario_id, legado.id);
      }
    });

    test('M5 — identificação que FALHA não derruba o atendimento em curso: com um atendimento aberto no tablet, uma tentativa não identificada, malformada ou barrada por limite deixa o atendimento atual aberto, utilizável e com o prazo intacto (só uma identificação VÁLIDA o substitui)', async () => {
      const atual = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const aberto = await ident(t, { tipo: 'CPF', valor: atual.cpf });
      assert.equal(aberto.status, 201, aviso(aberto));
      const token = cookieDoAtendimentoNaResposta(aberto).valor;
      const [linha] = await a.abertosDe(t.id);
      const antes = JSON.stringify(linha);
      for (const corpo of [{ tipo: 'CPF', valor: '11122233396' }, { tipo: 'MATRICULA', valor: 'NAO-EXISTE' }, { tipo: 'CPF', valor: '123' }, { tipo: 'PIN', valor: '1' }]) {
        const falha = await ident(t, corpo);
        assert.ok([400, 404].includes(falha.status) && falha.body.codigo !== 'ROTA_NAO_ENCONTRADA', `${JSON.stringify(corpo)} → ${aviso(falha)}`);
        assert.equal(JSON.stringify((await a.abertosDe(t.id))[0]), antes, 'o atendimento em curso não mudou');
      }
      assert.equal((await a.abertosDe(t.id)).length, 1);
      assert.equal((await a.consultar(app, t, token)).status, 200, 'o atendimento em curso segue utilizável');
    });
  });

  // ───────────────────────── quem NÃO é identificado, sem enumeração ─────────────────────────
  describe('funcionário não identificado: uma só resposta', () => {
    test('E1 — só funcionário ATIVO da empresa do tablet: afastado e inativo (inclusive "desligado") recebem a mesma recusa, sem atendimento criado', async () => {
      const afastado = await a.funcionario(a.d.empresaA, { situacao: 'AFASTADO' });
      const inativo = await a.funcionario(a.d.empresaA, { situacao: 'INATIVO' });
      for (const [rotulo, f] of [['afastado', afastado], ['inativo', inativo]]) {
        for (const corpo of [{ tipo: 'CPF', valor: f.cpf }, { tipo: 'MATRICULA', valor: f.matricula }]) {
          const t = await tabletNovo();
          const r = await ident(t, corpo);
          assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, `${rotulo} ${corpo.tipo}: ${aviso(r)}`);
          assert.equal((await a.atendimentosDe(t.id)).length, 0);
          assert.equal(cookieDoAtendimentoNaResposta(r), null);
        }
      }
    });

    test('E2 — funcionário de OUTRA empresa e CPF que existe nas duas: a empresa vem do tablet; o de outra empresa é "não identificado" e o CPF comum identifica SEMPRE o da empresa do tablet', async () => {
      const soNaB = await a.funcionario(a.d.empresaB, { matricula: 'SO-NA-B' });
      const t = await tabletNovo();
      for (const corpo of [{ tipo: 'CPF', valor: soNaB.cpf }, { tipo: 'MATRICULA', valor: 'SO-NA-B' }]) {
        const r = await ident(t, corpo);
        assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, aviso(r));
      }
      const naA = await a.funcionario(a.d.empresaA);
      const naBMesmoCpf = await a.funcionario(a.d.empresaB, { cpf: naA.cpf, nome: 'Zeca Da Empresa B' });
      const ok = await ident(t, { tipo: 'CPF', valor: naA.cpf });
      assert.equal(ok.status, 201, aviso(ok));
      assert.equal((await a.abertosDe(t.id))[0].funcionario_id, naA.id);
      assert.notEqual((await a.abertosDe(t.id))[0].funcionario_id, naBMesmoCpf.id);
      assert.notEqual(ok.body.atendimento.funcionario.primeiroNome, 'Zeca');
    });

    test('E3 — resposta GENÉRICA: inexistente (CPF e matrícula), afastado, inativo, de outra empresa e identificador de outro tipo têm status, código e corpo IDÊNTICOS (sem enumeração de funcionários)', async () => {
      const afastado = await a.funcionario(a.d.empresaA, { situacao: 'AFASTADO' });
      const inativo = await a.funcionario(a.d.empresaA, { situacao: 'INATIVO' });
      const outraEmpresa = await a.funcionario(a.d.empresaB);
      const ativo = await a.funcionario(a.d.empresaA);
      const casos = [
        { tipo: 'CPF', valor: '52998224725' }, { tipo: 'MATRICULA', valor: 'NAO-EXISTE-999' },
        { tipo: 'CPF', valor: afastado.cpf }, { tipo: 'MATRICULA', valor: inativo.matricula },
        { tipo: 'CPF', valor: outraEmpresa.cpf }, { tipo: 'MATRICULA', valor: ativo.cpf },
      ];
      const respostas = [];
      for (const corpo of casos) { const t = await tabletNovo(); respostas.push(await ident(t, corpo)); }
      respostas.forEach((r, i) => assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, `${JSON.stringify(casos[i].tipo)} #${i}: ${aviso(r)}`));
      assert.equal(new Set(respostas.map((r) => JSON.stringify(r.body))).size, 1, 'corpos idênticos');
      assert.equal(new Set(respostas.map((r) => JSON.stringify(Object.keys(r.headers).filter((h) => /^(set-cookie|x-)/i.test(h)).sort()))).size, 1, 'cabeçalhos relevantes idênticos');
      const corpo = JSON.stringify(respostas[0].body);
      for (const proibido of [afastado.cpf, inativo.matricula, outraEmpresa.cpf, afastado.nome]) assert.equal(corpo.includes(proibido), false);
    });
  });

  // ───────────────────────── formato do pedido ─────────────────────────
  describe('pedido malformado e campos proibidos', () => {
    test('F1 — identificadores malformados são 400 VALIDACAO (sem atendimento, sem cookie e sem repetir o valor recebido)', async () => {
      const longo = 'x'.repeat(5000);
      const invalidos = [
        {}, { tipo: 'CPF' }, { valor: '52998224725' }, { tipo: 'cpf', valor: '52998224725' }, { tipo: 'PIN', valor: '1234' }, { tipo: 'CRACHA', valor: '1' }, { tipo: null, valor: 'x' },
        { tipo: 'CPF', valor: 52998224725 }, { tipo: 'CPF', valor: null }, { tipo: 'CPF', valor: ['52998224725'] }, { tipo: 'CPF', valor: { cpf: '52998224725' } }, { tipo: 'CPF', valor: '' }, { tipo: 'CPF', valor: '   ' },
        { tipo: 'CPF', valor: '5299822472' }, { tipo: 'CPF', valor: '529982247255' }, { tipo: 'CPF', valor: '529 982 247 25' }, { tipo: 'CPF', valor: 'abc.def.ghi-jk' }, { tipo: 'CPF', valor: '529982247-2a' },
        { tipo: 'MATRICULA', valor: '' }, { tipo: 'MATRICULA', valor: ' ' }, { tipo: 'MATRICULA', valor: 'A'.repeat(31) }, { tipo: 'MATRICULA', valor: 'A\u0000B' }, { tipo: 'MATRICULA', valor: 'A\nB' }, { tipo: 'MATRICULA', valor: longo }, { tipo: 'CPF', valor: longo },
      ];
      for (const corpo of invalidos) {
        const t = await tabletNovo();
        const r = await ident(t, corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${JSON.stringify(corpo).slice(0, 70)} → ${aviso(r)}`);
        assert.equal(cookieDoAtendimentoNaResposta(r), null);
        assert.equal((await a.atendimentosDe(t.id)).length, 0);
        if (typeof corpo.valor === 'string' && corpo.valor.trim().length > 3 && corpo.valor.length < 100) assert.equal(JSON.stringify(r.body).includes(corpo.valor), false, 'a validação não devolve o valor recebido');
      }
      const naoObjeto = await request(app).post(BASE).set('Origin', ORIGEM).set('Content-Type', 'application/json').send('"52998224725"');
      assert.equal(naoObjeto.status, 400, aviso(naoObjeto));
    });

    test('F2 — NENHUM campo extra: empresa, tablet, funcionário, atendimento, PIN, senha, data de nascimento, crachá, segundo fator, código ou token (nada de autenticação indireta nem de escolha do navegador) é 400 e nada é criado', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const extras = [
        { empresaId: a.d.empresaB }, { dispositivoId: 1 }, { funcionarioId: f.id }, { atendimentoId: 1 }, { empresa_id: a.d.empresaB }, { usuarioId: a.d.master },
        { pin: '1234' }, { senha: 'x' }, { password: 'x' }, { dataNascimento: '1990-01-01' }, { data_nascimento: '1990-01-01' }, { cracha: '123' }, { segundoFator: '123456' }, { otp: '123456' }, { codigo: 'x' }, { token: 'x' }, { nome: 'Maria' },
      ];
      for (const extra of extras) {
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'CPF', valor: f.cpf, ...extra });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${Object.keys(extra)[0]} → ${aviso(r)}`);
        assert.equal((await a.atendimentosDe(t.id)).length, 0, Object.keys(extra)[0]);
      }
    });

    test('F3 — parâmetros arbitrários do navegador são ignorados ou recusados: query de empresa/tablet é 400, e cabeçalhos x-empresa-id/x-dispositivo-id/x-funcionario-id não mudam quem é identificado', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const daB = await a.funcionario(a.d.empresaB);
      const t = await tabletNovo();
      const q = await request(app).post(`${BASE}?empresaId=${a.d.empresaB}&dispositivoId=1`).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(t.credencial, null)).send({ tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([q.status, q.body.codigo], [400, 'VALIDACAO'], aviso(q));
      const r = await ident(t, { tipo: 'CPF', valor: f.cpf }, { 'x-empresa-id': String(a.d.empresaB), 'x-dispositivo-id': '999999', 'x-funcionario-id': String(daB.id) });
      assert.equal(r.status, 201, aviso(r));
      const [aberto] = await a.abertosDe(t.id);
      assert.deepEqual([aberto.empresa_id, aberto.dispositivo_id, aberto.funcionario_id], [a.d.empresaA, t.id, f.id]);
    });
  });

  // ───────────────────────── auditoria e privacidade ─────────────────────────
  describe('auditoria e dados pessoais', () => {
    test('P1 — o atendimento iniciado é auditado só com ids e o TIPO do identificador; nem CPF, nem matrícula, nem nome, nem token, nem hash em auditoria, eventos ou chaves sensíveis', async () => {
      const f = await a.funcionario(a.d.empresaA, { nome: 'Joana Pereira Lima' });
      const t = await tabletNovo();
      const antes = (await a.auditorias('TOKEN_ATENDIMENTO_INICIADO')).length;
      const r = await ident(t, { tipo: 'MATRICULA', valor: f.matricula });
      assert.equal(r.status, 201, aviso(r));
      const token = cookieDoAtendimentoNaResposta(r).valor;
      const registros = (await a.auditorias('TOKEN_ATENDIMENTO_INICIADO')).slice(antes);
      assert.equal(registros.length, 1);
      const aberto = (await a.abertosDe(t.id))[0];
      assert.deepEqual([registros[0].usuario_id, registros[0].empresa_id, registros[0].referencia], [null, a.d.empresaA, String(aberto.id)]);
      assert.deepEqual(registros[0].contexto, { tipoIdentificador: 'MATRICULA', dispositivoId: t.id, funcionarioId: f.id });
      const segredos = [f.cpf, f.matricula, 'Joana', 'Pereira', 'Lima', token, sha256(token), hashTokenSessao(token), comMascara(f.cpf)];
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), segredos), [], 'dado pessoal ou segredo em logs_auditoria');
      assert.deepEqual(varrer(await a.todosEventos(a.d.empresaA), segredos), [], 'dado pessoal ou segredo nos eventos');
    });

    test('P2 — a tentativa NÃO identificada não grava nada que identifique quem foi digitado: sem auditoria por tentativa e sem o valor em nenhuma tabela do Token', async () => {
      const t = await tabletNovo();
      const inventado = '11122233396';
      const antes = (await a.todaAuditoria(a.d.empresaA)).length;
      const r = await ident(t, { tipo: 'CPF', valor: inventado });
      assert.deepEqual([r.status, r.body.codigo], NAO_IDENTIFICADO, aviso(r));
      assert.equal((await a.todaAuditoria(a.d.empresaA)).length, antes, 'sem auditoria por tentativa falha (volume controlável pelo atacante)');
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos', 'token_atendimentos']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, [inventado], { hex64: false }), [], tabela);
      }
    });
  });

  // ───────────────────────── segurança do tablet e da rede ─────────────────────────
  describe('tablet autenticado, rede corporativa e origem', () => {
    test('S1 — sem a credencial do tablet: 401 DISPOSITIVO_NAO_AUTORIZADO, mesmo com um cookie de atendimento válido ou com CPF correto; nada é criado', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const direto = await a.atendimentoDireto(t, f.id);
      const semCookie = await a.identificar(app, null, { tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([semCookie.status, semCookie.body.codigo], NAO_AUTORIZADO, aviso(semCookie));
      const soAtendimento = await request(app).post(BASE).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(null, direto.token)).send({ tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], NAO_AUTORIZADO, aviso(soAtendimento));
      assert.equal((await a.atendimentosDe(t.id)).length, 1, 'só o atendimento direto do fixture');
    });

    test('S2 — tablet REVOGADO ou empresa INATIVA: 401 DISPOSITIVO_NAO_AUTORIZADO e nenhum atendimento', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const revogado = await tabletNovo();
      const gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
      assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${revogado.id}/revogar`)).status, 200);
      const r1 = await ident(revogado, { tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([r1.status, r1.body.codigo], NAO_AUTORIZADO, aviso(r1));
      assert.equal((await a.atendimentosDe(revogado.id)).length, 0);
      const fB = await a.funcionario(a.d.empresaB);
      const daB = await tabletNovo(a.d.empresaB);
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      await a.q('UPDATE empresas SET ativo = false WHERE id = $1', [a.d.empresaB]);
      try {
        const r2 = await ident(daB, { tipo: 'CPF', valor: fB.cpf });
        assert.deepEqual([r2.status, r2.body.codigo], NAO_AUTORIZADO, aviso(r2));
        assert.equal((await a.atendimentosDe(daB.id)).length, 0);
      } finally { await a.q('UPDATE empresas SET ativo = true WHERE id = $1', [a.d.empresaB]); }
    });

    test('S3 — rede NÃO autorizada: 403 REDE_NAO_AUTORIZADA (empresa sem rede, rede de outra empresa, TUNEL sem atestação, cabeçalhos de proxy forjados, IP_FIXO como faixa) e NENHUM atendimento nem cookie', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const cenarios = [
        ['sem rede', { A: [], B: [] }, 0, {}],
        ['rede só da outra empresa', { A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] }, 0, {}],
        ['TUNEL com X-Forwarded-For do túnel', { A: [{ tipo: 'TUNEL', rede: '10.8.0.0/24' }], B: [] }, 1, { 'X-Forwarded-For': '10.8.0.5' }],
        ['X-Forwarded-For forjado sem proxy confiável', { A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] }, 0, { 'X-Forwarded-For': '203.0.113.9' }],
        ['IP_FIXO cadastrado como faixa', { A: [{ tipo: 'IP_FIXO', rede: '127.0.0.0/8' }], B: [] }, 0, {}],
      ];
      for (const [rotulo, redes, hops, cab] of cenarios) {
        await a.redes(redes);
        const t = await tabletNovo();
        const r = await ident(t, { tipo: 'CPF', valor: f.cpf }, cab, a.criarApp({ hops }));
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `${rotulo}: ${aviso(r)}`);
        assert.equal(cookieDoAtendimentoNaResposta(r), null, rotulo);
        assert.equal((await a.atendimentosDe(t.id)).length, 0, rotulo);
      }
    });

    test('S4 — origem do pedido: sem Origin/Referer é 403 ORIGEM_AUSENTE, origem de fora é 403 ORIGEM_NAO_PERMITIDA e text/plain é 415, tudo ANTES de consultar funcionário', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const semOrigem = await request(app).post(BASE).set('Cookie', cabecalhoCookie(t.credencial, null)).send({ tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE'], aviso(semOrigem));
      const fora = await request(app).post(BASE).set('Origin', 'https://atacante.example').set('Cookie', cabecalhoCookie(t.credencial, null)).send({ tipo: 'CPF', valor: f.cpf });
      assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], aviso(fora));
      const texto = await request(app).post(BASE).set('Origin', ORIGEM).set('Content-Type', 'text/plain').set('Cookie', cabecalhoCookie(t.credencial, null)).send(`{"tipo":"CPF","valor":"${f.cpf}"}`);
      assert.equal(texto.status, 415, aviso(texto));
      assert.equal((await a.atendimentosDe(t.id)).length, 0);
      const ok = await ident(t, { tipo: 'CPF', valor: f.cpf });
      assert.equal(ok.status, 201, 'controle: com a origem permitida o mesmo pedido identifica');
    });

    test('S5 — a rotação da credencial do tablet continua funcionando na identificação: com a credencial vencida (25 h) o pedido é 201 e traz os DOIS cookies (o novo do tablet e o do atendimento)', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo(a.d.empresaA, 25);
      const r = await ident(t, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const novoTablet = cookieDoTabletNaResposta(r);
      assert.ok(novoTablet && novoTablet.valor !== t.credencial, 'a rotação da Etapa C acontece');
      assert.ok(cookieDoAtendimentoNaResposta(r));
      assert.equal((await a.comoTablet(app, novoTablet.valor).get(`${CAMINHO_TABLET}/estado`)).status, 200);
    });
  });

  // ───────────────────────── tentativas excessivas ─────────────────────────
  describe('limite de tentativas', () => {
    test('L1 — limite POR TABLET na identificação: depois de 3 tentativas (falhas contam) a 4ª é 429 mesmo com o CPF certo, e NENHUM atendimento é criado; outro tablet do MESMO IP não é afetado', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t1 = await tabletNovo(); const t2 = await tabletNovo();
      const chave = modulos().tabletRotas.chavePorDispositivo;
      const limitado = a.criarApp({ hops: 0, limitadorIdentificacao: criarLimitador({ limite: 3, janelaSegundos: 60, chave }) });
      for (let i = 0; i < 3; i += 1) assert.deepEqual([(await ident(t1, { tipo: 'CPF', valor: '11122233396' }, {}, limitado)).status], [404], `falha ${i + 1}`);
      const barrada = await ident(t1, { tipo: 'CPF', valor: f.cpf }, {}, limitado);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
      assert.equal((await a.atendimentosDe(t1.id)).length, 0);
      const outro = await ident(t2, { tipo: 'CPF', valor: f.cpf }, {}, limitado);
      assert.equal(outro.status, 201, `o NAT não bloqueia o outro tablet: ${aviso(outro)}`);
    });

    test('L3 — o limite por IP (contenção de inundação) vale na identificação: com o limitador por IP injetado em 2, a 3ª tentativa é 429 antes de qualquer consulta e nenhum atendimento é criado', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const porIp = a.criarApp({ hops: 0, limitador: criarLimitador({ limite: 2, janelaSegundos: 60 }) });
      for (let i = 0; i < 2; i += 1) assert.equal((await ident(t, { tipo: 'CPF', valor: '11122233396' }, {}, porIp)).status, 404);
      const barrada = await ident(t, { tipo: 'CPF', valor: f.cpf }, {}, porIp);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
      assert.equal((await a.atendimentosDe(t.id)).length, 0);
    });

    test('L2 — com os limitadores PADRÃO (proposta: 10 por minuto por tablet) uma rajada de tentativas falhas é cortada em 429 e o outro tablet continua identificando', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t1 = await tabletNovo(); const t2 = await tabletNovo();
      const padrao = a.criarApp({ hops: 0, limitador: null });
      const status = [];
      for (let i = 0; i < 14; i += 1) status.push((await ident(t1, { tipo: 'CPF', valor: `1112223339${i % 10}` }, {}, padrao)).status);
      assert.ok(status.includes(429), `nenhum 429 em 14 tentativas: ${status.join(',')}`);
      assert.ok(status.indexOf(429) <= 10, `o corte deveria vir até a 11ª tentativa: ${status.join(',')}`);
      assert.ok(status.slice(0, status.indexOf(429)).every((s) => s === 404), 'antes do corte, só "não identificado"');
      assert.equal((await ident(t2, { tipo: 'CPF', valor: f.cpf }, {}, padrao)).status, 201);
    });
  });

  // ───────────────────────── separação entre o atendimento e a autenticação do tablet ─────────────────────────
  describe('separação entre atendimento do funcionário e credencial do tablet', () => {
    test('X1 — a identificação NÃO emite nenhum cookie de sessão administrativa e o cookie do atendimento tem nome e Path próprios, distintos dos cookies de sessão e do tablet', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const r = await ident(t, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const nomes = base_lerNomes(r);
      for (const proibido of [authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNomeGlobal, authConfig.desafioMfa.cookieNome]) assert.equal(nomes.includes(proibido), false, proibido);
      assert.ok(nomes.includes(COOKIE_ATENDIMENTO));
      assert.notEqual(COOKIE_ATENDIMENTO, COOKIE_TABLET);
      assert.notEqual(cookieDoAtendimentoNaResposta(r).atributos.path, CAMINHO_TABLET, 'o Path do atendimento é mais restrito que o do tablet');
    });

    test('X2 — o token do atendimento NÃO autentica o tablet e a credencial do tablet NÃO é um atendimento: cada cookie vale só na sua função', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const r = await ident(t, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const token = cookieDoAtendimentoNaResposta(r).valor;
      const tokenComoCredencial = await a.comoTablet(app, token).get(`${CAMINHO_TABLET}/estado`);
      assert.deepEqual([tokenComoCredencial.status, tokenComoCredencial.body.codigo], NAO_AUTORIZADO, aviso(tokenComoCredencial));
      const credencialComoToken = await a.consultar(app, t, t.credencial);
      assert.deepEqual([credencialComoToken.status, credencialComoToken.body.codigo], ATENDIMENTO_INVALIDO, aviso(credencialComoToken));
      const semAtendimento = await a.consultar(app, t, null);
      assert.deepEqual([semAtendimento.status, semAtendimento.body.codigo], ATENDIMENTO_INVALIDO, 'o tablet autenticado, sozinho, não tem atendimento');
      const soAtendimento = await a.consultar(app, null, token);
      assert.deepEqual([soAtendimento.status, soAtendimento.body.codigo], NAO_AUTORIZADO, 'o atendimento, sozinho, não autentica nada');
    });

    test('X3 — o atendimento é do TABLET que o abriu: o token de um tablet com a credencial de OUTRO tablet (mesma ou outra empresa) é 401, e o atendimento original continua intacto', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t1 = await tabletNovo(); const t2 = await tabletNovo();
      const r = await ident(t1, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const token = cookieDoAtendimentoNaResposta(r).valor;
      const cruzado = await a.consultar(app, t2, token);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], ATENDIMENTO_INVALIDO, aviso(cruzado));
      assert.equal((await a.abertosDe(t2.id)).length, 0);
      assert.equal((await a.consultar(app, t1, token)).status, 200, 'o original segue válido');
      // atendimento da empresa B plantado direto no banco, usado com um tablet da empresa A
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      const fB = await a.funcionario(a.d.empresaB); const tB = await tabletNovo(a.d.empresaB);
      const daB = await a.atendimentoDireto(tB, fB.id);
      const entreEmpresas = await a.consultar(app, t1, daB.token);
      assert.deepEqual([entreEmpresas.status, entreEmpresas.body.codigo], ATENDIMENTO_INVALIDO, aviso(entreEmpresas));
    });

    test('X4 — CPF ou matrícula NÃO bastam para nada administrativo: o cookie do atendimento é recusado nas rotas administrativas (sessão REAL exigida) e a identificação não concede sessão', async () => {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const r = await ident(t, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const token = cookieDoAtendimentoNaResposta(r).valor;
      const real = a.criarApp({ admin: 'cookie' });
      const lista = await request(real).get('/api/atendimento-token/dispositivos').set('Cookie', cabecalhoCookie(t.credencial, token));
      assert.deepEqual([lista.status, lista.body.codigo], [401, 'SESSAO_INVALIDA'], aviso(lista));
      const gerar = await request(real).post(`/api/atendimento-token/dispositivos/${t.id}/ativacao`).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(t.credencial, token)).send({});
      assert.deepEqual([gerar.status, gerar.body.codigo], [401, 'SESSAO_INVALIDA'], aviso(gerar));
    });
  });
});

function base_lerNomes(resposta) {
  return (resposta.headers['set-cookie'] ?? []).map((c) => c.split('=')[0].trim());
}
