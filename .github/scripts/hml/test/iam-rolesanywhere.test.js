'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.resolve(__dirname, '../../../..');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(raiz, rel), 'utf8'));

test('trust Roles Anywhere limita a identidade X.509 e o Trust Anchor, sem aws:SourceIp', () => {
  const policy = json('deploy/hml/cd/iam-rolesanywhere-agente.modelo.json');
  assert.equal(policy.Version, '2012-10-17');
  assert.equal(policy.Statement.length, 1);
  const s = policy.Statement[0];
  assert.equal(s.Effect, 'Allow');
  assert.deepEqual(s.Principal, { Service: 'rolesanywhere.amazonaws.com' });
  assert.deepEqual(new Set(s.Action), new Set([
    'sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity',
  ]));
  assert.deepEqual(s.Condition.StringEquals, {
    'aws:PrincipalTag/x509Subject/CN': 'safework-hml-cd-agente',
  });
  assert.deepEqual(s.Condition.ArnEquals, { 'aws:SourceArn': 'TRUST_ANCHOR_ARN' });
  assert.equal(Object.hasOwn(s.Condition, 'IpAddress'), false);
  assert.equal(JSON.stringify(s.Condition).includes('aws:SourceIp'), false);
});

test('bucket policy restringe o papel do agente ao IPv4 público sem afetar outros principais', () => {
  const policy = json('deploy/hml/cd/s3-politica.modelo.json');
  const s = policy.Statement.find((item) => item.Sid === 'NegarAgenteForaDoIPv4');
  assert.ok(s, 'Deny de perímetro do agente ausente');
  assert.equal(s.Effect, 'Deny');
  assert.equal(s.Principal, '*');
  assert.equal(s.Action, 's3:*');
  assert.deepEqual(s.Resource, [
    'arn:aws:s3:::BUCKET',
    'arn:aws:s3:::BUCKET/*',
  ]);
  assert.deepEqual(s.Condition.ArnEquals, {
    'aws:PrincipalArn': 'arn:aws:iam::CONTA:role/safework-hml-cd-agente',
  });
  assert.deepEqual(s.Condition.NotIpAddress, {
    'aws:SourceIp': 'IPV4_PUBLICO_AGENTE/32',
  });
  assert.deepEqual(s.Condition.Bool, { 'aws:ViaAWSService': 'false' });
  assert.equal(policy.Statement.findIndex((item) => item.Sid === 'NegarAgenteForaDoIPv4'), policy.Statement.length - 1);
});
