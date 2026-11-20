'use strict';
// Etapa 2B: segregação IAM/S3. Os modelos do backend só alcançam hml-backend/ e os do frontend só alcançam hml/.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CD = path.resolve(__dirname, '../../../../deploy/hml/cd');
const ler = (nome) => JSON.parse(fs.readFileSync(path.join(CD, nome), 'utf8'));
const bruto = (nome) => fs.readFileSync(path.join(CD, nome), 'utf8');
const lista = (v) => (Array.isArray(v) ? v : [v]);

const M = {
  confiancaBack: 'iam-confianca-backend.modelo.json',
  publicadorBack: 'iam-publicador-backend.modelo.json',
  agenteBack: 'iam-agente-backend.modelo.json',
  s3Back: 's3-politica-backend.modelo.json',
  publicadorFront: 'iam-publicador.modelo.json',
  agenteFront: 'iam-agente.modelo.json',
};

// Avaliador mínimo: Allow explícito, sem curingas no nome da ação, curinga final nos recursos e condição de prefixo na listagem.
function permite(politica, acao, chave, prefixo) {
  const alvoObjeto = `arn:aws:s3:::BUCKET/${chave}`;
  return politica.Statement.some((s) => {
    if (s.Effect !== 'Allow' || !lista(s.Action).includes(acao)) return false;
    if (acao === 's3:ListBucket') {
      const c = s.Condition || {};
      const igual = c.StringEquals && c.StringEquals['s3:prefix'];
      const como = c.StringLike && c.StringLike['s3:prefix'];
      if (igual !== undefined) return prefixo === igual;
      if (como !== undefined) return lista(como).some((p) => (p.endsWith('*') ? prefixo.startsWith(p.slice(0, -1)) : prefixo === p));
      return false;
    }
    return lista(s.Resource).some((r) => (r.endsWith('*') ? alvoObjeto.startsWith(r.slice(0, -1)) : alvoObjeto === r));
  });
}

describe('confiança OIDC do backend', () => {
  test('aceita só o environment homologacao-backend, com audiência STS e sem outros principais', () => {
    const p = ler(M.confiancaBack);
    assert.equal(p.Statement.length, 1);
    const s = p.Statement[0];
    assert.equal(s.Effect, 'Allow');
    assert.equal(s.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual(Object.keys(s.Principal), ['Federated']);
    assert.match(s.Principal.Federated, /^arn:aws:iam::CONTA:oidc-provider\/token\.actions\.githubusercontent\.com$/);
    assert.deepEqual(Object.keys(s.Condition), ['StringEquals']);
    assert.equal(s.Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
    assert.equal(s.Condition.StringEquals['token.actions.githubusercontent.com:sub'], 'repo:ramirespaes/Gestao_Epi_Fabricas:environment:homologacao-backend');
  });

  test('a confiança do backend difere da do frontend e nenhuma aceita a do outro', () => {
    const front = ler('iam-confianca.modelo.json').Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'];
    const back = ler(M.confiancaBack).Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'];
    assert.notEqual(front, back);
    assert.match(front, /environment:homologacao$/);
    assert.doesNotMatch(bruto(M.confiancaBack), /environment:homologacao"/);
  });
});

describe('segregação por prefixo', () => {
  const pubB = () => ler(M.publicadorBack);
  const agB = () => ler(M.agenteBack);
  const pubF = () => ler(M.publicadorFront);
  const agF = () => ler(M.agenteFront);

  test('o publicador do backend escreve só blobs e pedidos de hml-backend/ e lê só os recibos', () => {
    assert.equal(permite(pubB(), 's3:PutObject', 'hml-backend/blobs/1-1.json'), true);
    assert.equal(permite(pubB(), 's3:PutObject', 'hml-backend/pedidos/1-1.json'), true);
    assert.equal(permite(pubB(), 's3:PutObject', 'hml-backend/recibos/1-1.json'), false);
    assert.equal(permite(pubB(), 's3:GetObject', 'hml-backend/recibos/1-1.json'), true);
    assert.equal(permite(pubB(), 's3:GetObject', 'hml-backend/pedidos/1-1.json'), false);
    assert.equal(permite(pubB(), 's3:ListBucket', null, 'hml-backend/recibos/1-1.json'), true);
    assert.equal(permite(pubB(), 's3:ListBucket', null, 'hml-backend/pedidos/'), false);
  });

  test('o agente do backend lê pedidos e blobs, escreve só recibos e lista só a própria fila e os próprios recibos', () => {
    assert.equal(permite(agB(), 's3:GetObject', 'hml-backend/pedidos/1-1.json'), true);
    assert.equal(permite(agB(), 's3:GetObject', 'hml-backend/blobs/1-1.json'), true);
    assert.equal(permite(agB(), 's3:PutObject', 'hml-backend/recibos/1-1.json'), true);
    assert.equal(permite(agB(), 's3:PutObject', 'hml-backend/pedidos/1-1.json'), false);
    assert.equal(permite(agB(), 's3:PutObject', 'hml-backend/blobs/1-1.json'), false);
    assert.equal(permite(agB(), 's3:ListBucket', null, 'hml-backend/pedidos/'), true);
    assert.equal(permite(agB(), 's3:ListBucket', null, 'hml-backend/recibos/1-1.json'), true);
    assert.equal(permite(agB(), 's3:ListBucket', null, 'hml/pedidos/'), false);
  });

  test('os modelos do backend nunca alcançam hml/ e os do frontend nunca alcançam hml-backend/', () => {
    for (const chave of ['hml/blobs/1-1.json', 'hml/pedidos/1-1.json', 'hml/recibos/1-1.json']) {
      for (const acao of ['s3:PutObject', 's3:GetObject']) {
        assert.equal(permite(pubB(), acao, chave), false, `publicador backend ${acao} ${chave}`);
        assert.equal(permite(agB(), acao, chave), false, `agente backend ${acao} ${chave}`);
      }
    }
    for (const chave of ['hml-backend/blobs/1-1.json', 'hml-backend/pedidos/1-1.json', 'hml-backend/recibos/1-1.json']) {
      for (const acao of ['s3:PutObject', 's3:GetObject']) {
        assert.equal(permite(pubF(), acao, chave), false, `publicador frontend ${acao} ${chave}`);
        assert.equal(permite(agF(), acao, chave), false, `agente frontend ${acao} ${chave}`);
      }
    }
    for (const nome of [M.publicadorBack, M.agenteBack]) assert.doesNotMatch(bruto(nome), /BUCKET\/hml\/|"hml\//, nome);
  });

  test('só as ações mínimas, sem curinga, sem remoção, sem Principal e sem recurso fora do bucket do modelo', () => {
    for (const nome of [M.publicadorBack, M.agenteBack]) {
      const p = ler(nome);
      for (const s of p.Statement) {
        assert.equal(s.Effect, 'Allow');
        assert.equal(s.Principal, undefined);
        for (const a of lista(s.Action)) assert.ok(['s3:ListBucket', 's3:PutObject', 's3:GetObject'].includes(a), `${nome}: ${a}`);
        for (const r of lista(s.Resource)) assert.match(r, /^arn:aws:s3:::BUCKET(\/hml-backend\/(blobs|pedidos|recibos)\/\*)?$/, `${nome}: ${r}`);
        if (lista(s.Action).includes('s3:ListBucket')) assert.ok(s.Condition, `${nome}: listagem sem condição de prefixo`);
      }
      assert.doesNotMatch(bruto(nome), /Delete|NotAction|NotResource|"\*"/);
    }
  });
});

describe('política do bucket para hml-backend/', () => {
  test('exige TLS, criação condicional e AES256 em hml-backend/* sem conceder acesso', () => {
    const p = ler(M.s3Back);
    assert.ok(p.Statement.every((s) => s.Effect === 'Deny'));
    const porSid = Object.fromEntries(p.Statement.map((s) => [s.Sid, s]));
    assert.deepEqual(porSid.ExigirTLS.Resource, ['arn:aws:s3:::BUCKET', 'arn:aws:s3:::BUCKET/*']);
    assert.equal(porSid.ExigirTLS.Condition.Bool['aws:SecureTransport'], 'false');
    assert.equal(porSid.ExigirCriacaoCondicionalBackend.Resource, 'arn:aws:s3:::BUCKET/hml-backend/*');
    assert.equal(porSid.ExigirCriacaoCondicionalBackend.Condition.Null['s3:if-none-match'], 'true');
    assert.equal(porSid.ExigirAES256Backend.Resource, 'arn:aws:s3:::BUCKET/hml-backend/*');
    assert.deepEqual(porSid.ExigirAES256Backend.Condition.StringNotEquals, { 's3:x-amz-server-side-encryption': 'AES256' });
  });
});

describe('modelos inertes', () => {
  test('só marcadores: nenhuma conta, chave, ARN real ou segredo', () => {
    for (const nome of Object.values(M).filter((n) => n.includes('backend'))) {
      const t = bruto(nome);
      assert.doesNotMatch(t, /\b[0-9]{12}\b|AKIA[0-9A-Z]{16}|aws_secret|PRIVATE KEY/i, nome);
      JSON.parse(t);
    }
  });
});
