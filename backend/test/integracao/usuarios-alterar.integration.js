'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');

/** ETAPA C — Alterar usuário (PostgreSQL real): PATCH estendido + detalhe de edição com CPF completo só para quem administra. */
const BASE = '/api/administracao/usuarios';

describe('Gestão de Usuários — Alterar usuário (PostgreSQL real)', () => {
  let g;
  let master;
  let grupoA;
  let grupoInativo;
  let grupoB;
  before(async () => {
    g = await montar();
    master = await g.contaDaEmpresa(g.empresas.A);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    const novo = async (empresaId, nome, ativo, c) => (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, $2, $3, $4) RETURNING id', [empresaId, nome, ativo, c.usuarioId])).id;
    grupoA = await novo(g.empresas.A, 'RH', true, master);
    grupoInativo = await novo(g.empresas.A, 'Antigo', false, master);
    grupoB = await novo(g.empresas.B, 'RH B', true, masterB);
  });
  after(async () => { if (g) await g.encerrar(); });

  const patch = (c, id, corpo) => g.request(g.app).patch(`${BASE}/${id}`).set('Cookie', g.cookie(c)).send(corpo);
  const edicao = (c, id) => g.request(g.app).get(`${BASE}/${id}/edicao`).set('Cookie', g.cookie(c));
  const linha = (id) => g.um(`SELECT u.nome, u.perfil, u.matricula, u.setor, u.horario_trabalho_inicio::text AS ini, u.horario_trabalho_fim::text AS fim, u.grupo_acesso_id, i.cpf, i.email, i.senha_hash
    FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.id = $1`, [id]);
  const ips = async (id) => (await g.todos('SELECT host(ip) AS ip FROM usuario_ips_permitidos WHERE usuario_id = $1 ORDER BY ip', [id])).map((l) => l.ip);

  test('detalhe de edição: CPF completo, dados e IPs só para quem administra; sem autoridade 403; outra empresa 404; a listagem segue mascarada; consulta auditada sem o CPF', async () => {
    const u = await g.usuarioPronto(master, { horarioTrabalho: { inicio: '08:00', fim: '17:00' }, ipsPermitidos: ['203.0.113.10'], grupoAcessoId: grupoA });
    const r = await edicao(master, u.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.usuario, {
      id: u.id, nome: u.corpo.nome, email: u.email, perfil: 'USUARIO', ativo: true, cpf: u.corpo.cpf, matricula: u.corpo.matricula, setor: 'Administrativo',
      horarioTrabalho: { inicio: '08:00', fim: '17:00' }, ipsPermitidos: ['203.0.113.10'], grupoAcessoId: grupoA,
    });
    const lista = await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', g.cookie(master));
    assert.equal(JSON.stringify(lista.body).includes(u.corpo.cpf), false);
    assert.equal((await edicao(await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR'), u.id)).status, 403);
    assert.equal((await edicao(await g.contaDaEmpresa(g.empresas.B), u.id)).status, 404);
    const aud = await g.todos("SELECT dados_novos, contexto FROM logs_auditoria WHERE acao = 'USUARIO_DADOS_CONSULTADOS' AND referencia = $1", [String(u.id)]);
    assert.equal(aud.length, 1);
    assert.equal(JSON.stringify(aud).includes(u.corpo.cpf), false);
  });

  test('altera nome, matrícula, setor, horário (e limpa), IPs (valem na hora) e grupo (e limpa); cpf nunca; CPF e senha intactos; matrícula duplicada 409; listagem atualizada', async () => {
    const u = await g.usuarioPronto(master, { ipsPermitidos: ['203.0.113.10'] });
    const outro = await g.usuarioPronto(master);
    const antes = await linha(u.id);
    const r = await patch(master, u.id, { nome: 'Nome Novo', matricula: 'NOVA-1', setor: 'Compras', horarioTrabalho: { inicio: '09:00', fim: '18:00' }, ipsPermitidos: ['198.51.100.7', '2001:0DB8::1'], grupoAcessoId: grupoA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const depois = await linha(u.id);
    assert.deepEqual([depois.nome, depois.matricula, depois.setor, depois.ini, depois.fim, depois.grupo_acesso_id], ['Nome Novo', 'NOVA-1', 'Compras', '09:00:00', '18:00:00', grupoA]);
    assert.deepEqual([depois.cpf, depois.senha_hash, depois.email], [antes.cpf, antes.senha_hash, antes.email]);
    assert.deepEqual(await ips(u.id), ['198.51.100.7', '2001:db8::1'].sort(), 'IPs substituídos, canônicos');
    const lista = await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', g.cookie(master));
    const item = lista.body.usuarios.find((x) => x.id === u.id);
    assert.deepEqual([item.nome, item.setor, item.horarioTrabalho, item.acessoQualquerIp, item.grupo.nome], ['Nome Novo', 'Compras', { inicio: '09:00', fim: '18:00' }, false, 'RH']);
    // IP novo vale imediatamente: o antigo foi retirado
    const entrada = await g.login(u.email, g.SENHA_PROVISORIA).set('X-Forwarded-For', '198.51.100.7');
    assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', g.deCookies(g.cookiesDe(entrada))).set('X-Forwarded-For', '203.0.113.10')).status, 403);

    const limpo = await patch(master, u.id, { horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null });
    assert.equal(limpo.status, 200);
    const l = await linha(u.id);
    assert.deepEqual([l.ini, l.fim, l.grupo_acesso_id, (await ips(u.id)).length], [null, null, null, 0]);
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', g.deCookies(g.cookiesDe(entrada))).set('X-Forwarded-For', '203.0.113.10')).status, 200, 'sem IPs: qualquer endereço');

    const dup = await patch(master, u.id, { matricula: outro.corpo.matricula });
    assert.deepEqual([dup.status, dup.body.codigo], [409, 'USUARIO_MATRICULA_JA_EXISTENTE']);
    assert.equal((await patch(master, u.id, { cpf: g.cpfFicticio(1) })).status, 400, 'CPF não é alterável');
    assert.equal((await linha(u.id)).cpf, antes.cpf);
    assert.equal((await patch(master, u.id, { grupoAcessoId: grupoInativo })).body.codigo, 'GRUPO_INATIVO');
    const deB = await patch(master, u.id, { grupoAcessoId: grupoB });
    assert.deepEqual([deB.status, deB.body.codigo], [404, 'GRUPO_NAO_ENCONTRADO']);
    assert.equal((await patch(master, u.id, { setor: '  ' })).status, 400);
    assert.equal((await patch(master, u.id, { ipsPermitidos: ['10.0.0.0/8'] })).status, 400);
  });

  test('perfil: ninguém é promovido a MASTER (nem com grupo) e o MASTER não é rebaixado por esta tela; entre os perfis comuns a troca vale e o grupo acompanha; ADMINISTRADOR não promove a MASTER', async () => {
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupoA });
    for (const corpo of [{ tipoConta: 'MASTER' }, { tipoConta: 'MASTER', grupoAcessoId: grupoA }]) {
      const r = await patch(master, u.id, corpo);
      assert.deepEqual([r.status, r.body.codigo], [409, 'MASTER_SOMENTE_PELO_PAINEL_PRIVADO'], JSON.stringify(corpo));
    }
    assert.deepEqual([(await linha(u.id)).perfil, (await linha(u.id)).grupo_acesso_id], ['USUARIO', grupoA], 'nada mudou');
    const comum = await patch(master, u.id, { tipoConta: 'SUPERVISOR' });
    assert.equal(comum.status, 200, JSON.stringify(comum.body));
    assert.equal((await linha(u.id)).grupo_acesso_id, grupoA);

    const masterB = await g.contaDaEmpresa(g.empresas.B);
    const rebaixo = await patch(masterB, masterB.usuarioId, { tipoConta: 'USUARIO' });
    assert.deepEqual([rebaixo.status, rebaixo.body.codigo], [409, 'USUARIO_MASTER_PERFIL_FIXO']);
    assert.equal((await patch(masterB, masterB.usuarioId, { nome: 'Master B', tipoConta: 'MASTER' })).status, 200, 'MASTER → MASTER é no-op permitido');
    assert.equal((await linha(masterB.usuarioId)).perfil, 'MASTER');
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const alvo = await g.usuarioPronto(master);
    assert.equal((await patch(adm, alvo.id, { tipoConta: 'MASTER' })).status, 403);
  });

  test('e-mail: troca na identidade única, preserva a senha, revoga as sessões do afetado, cancela redefinições; em uso 409; identidade compartilhada com outra empresa 409; auditoria sem o e-mail', async () => {
    const u = await g.usuarioPronto(master);
    const entrada = await g.login(u.email, g.SENHA_PROVISORIA);
    const jar = g.deCookies(g.cookiesDe(entrada));
    const hash = (await linha(u.id)).senha_hash;
    const novoEmail = `NOVO.${u.email}`;
    const r = await patch(master, u.id, { email: novoEmail });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([(await linha(u.id)).email, (await linha(u.id)).senha_hash], [novoEmail.toLowerCase(), hash]);
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', jar)).status, 401, 'sessão do afetado revogada');
    assert.equal((await g.login(novoEmail, g.SENHA_PROVISORIA)).status, 200, 'senha preservada, novo login');
    assert.equal((await g.login(u.email, g.SENHA_PROVISORIA)).status, 401);

    const outro = await g.usuarioPronto(master);
    const dup = await patch(master, u.id, { email: outro.email });
    assert.deepEqual([dup.status, dup.body.codigo], [409, 'IDENTIDADE_EMAIL_JA_EXISTENTE']);
    const dois = await g.usuarioPronto(master);
    await g.pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Em B', NULL, NULL, 'USUARIO', $2)", [g.empresas.B, dois.identidadeId]);
    const comp = await patch(master, dois.id, { email: `outro.${dois.email}` });
    assert.deepEqual([comp.status, comp.body.codigo], [409, 'EMAIL_IDENTIDADE_COMPARTILHADA']);
    const aud = await g.todos("SELECT acao, dados_novos, dados_anteriores FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'USUARIO_%'", [String(u.id)]);
    assert.ok(aud.some((a) => a.acao === 'USUARIO_EMAIL_ALTERADO'));
    assert.equal(JSON.stringify(aud).toLowerCase().includes('pessoa.gu'), false, 'o e-mail não vai à auditoria');
  });

  test('proteções do próprio ator: não se tranca fora com a lista de IPs; sem autoridade 403; outra empresa 404; auditoria dos dados administrativos', async () => {
    const trancar = await patch(master, master.usuarioId, { ipsPermitidos: ['203.0.113.99'] }).set('X-Forwarded-For', '198.51.100.1');
    assert.deepEqual([trancar.status, trancar.body.codigo], [409, 'IP_TRANCARIA_O_PROPRIO_ATOR']);
    assert.equal((await ips(master.usuarioId)).length, 0);
    const alvo = await g.usuarioPronto(master);
    assert.equal((await patch(await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR'), alvo.id, { setor: 'X' })).status, 403);
    assert.equal((await patch(await g.contaDaEmpresa(g.empresas.B), alvo.id, { setor: 'X' })).status, 404);
    await patch(master, alvo.id, { setor: 'Logística', ipsPermitidos: ['203.0.113.5'], horarioTrabalho: { inicio: '06:00', fim: '14:00' } });
    const aud = await g.um("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_DADOS_ALTERADOS' AND referencia = $1", [String(alvo.id)]);
    assert.deepEqual([aud.dados_anteriores.setor, aud.dados_novos.setor, aud.dados_novos.ipsPermitidos, aud.dados_novos.horarioTrabalho], ['Administrativo', 'Logística', 1, true]);
    assert.equal(/203\.0\.113|cpf/i.test(JSON.stringify(aud)), false);
  });
});
