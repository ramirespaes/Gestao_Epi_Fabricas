'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/totem-i');

/**
 * Atendimento Token — Ciclo 2, K4 (frontend): o Totem comunica a presença do tablet ao backend por POST
 * /atendimento-token/tablet/heartbeat. Servidor falso do helper (fiel ao contrato da rota: corpo e query vazios, só o cookie do
 * tablet) e relógio virtual; nada de rede real. As batidas ficam no canal `servidor.batidas`, fora de `servidor.chamadas`: não são
 * operação do atendimento. O sorteio do jitter é fixado por teste (`window.__aleatorio`, shim do helper).
 *
 * Parâmetros do contrato do backend (config/token-monitoramento): batida a cada 60 s com jitter de 10 % (54 a 66 s); o tablet é
 * dado como OFFLINE depois de 180 s sem contato.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA] = FUNCIONARIOS;
const HEARTBEAT = `POST ${H.BASE}/heartbeat`;
const ESTADO = `GET ${H.BASE}/estado`;
const ATIVAR = `POST ${H.BASE}/ativar`;
const ATIVIDADE = `POST ${H.BASE}/atendimento/atividade`;
const PEDIDO = `POST ${H.BASE}/atendimento/pedido`;
const RAIZ_TOTEM = path.join(__dirname, '..', 'totem');

/** Abre o Totem com o sorteio do jitter fixado ANTES do primeiro script de negócio (null = sorteio real). */
const abrir = (sorteio, { servidor = H.criarServidor(), hash = '' } = {}) => H.abrirTotem({
  servidor,
  hash,
  transformar: sorteio === null ? null : (relativo, fonte) => (relativo === 'totem/totem.js' ? `window.__aleatorio.valor = ${sorteio};\n${fonte}` : fonte),
});
const instantes = (servidor) => servidor.batidas.map((b) => b.em);
const timersDeBatida = (t) => t.relogio.pendentes().filter((x) => x.ms >= 54000 && x.ms <= 66000 && !x.repetir);
const comCodigo = (tablet = 'nao_autorizado') => {
  const codigo = H.novoToken();
  return { codigo, servidor: H.criarServidor({ tablet, codigos: { [codigo]: 'valido' } }) };
};

describe('[K4-A] início e cadência', () => {
  test('[K4-01] com o tablet autorizado a primeira batida sai logo depois do GET /estado: corpo {}, só os cabeçalhos permitidos, com cookies, sem query, fora das chamadas do atendimento', async () => {
    const servidor = H.criarServidor();
    await abrir(0.5, { servidor });
    assert.equal(servidor.batidas.length, 1);
    const [b] = servidor.batidas;
    assert.deepEqual(H.plano(b.corpo), {});
    assert.equal(b.credentials, 'include');
    assert.deepEqual(Object.keys(b.cabecalhos ?? {}).map((k) => k.toLowerCase()).sort(), ['accept', 'content-type']);
    assert.equal(b.url.includes('?'), false);
    const estado = servidor.chamadas.find((c) => c.chave === ESTADO);
    assert.ok(estado && estado.ordem < b.ordem, 'a batida vem depois de o servidor confirmar o tablet');
    assert.equal(servidor.chamadas.some((c) => c.chave === HEARTBEAT), false, 'a batida não é operação do atendimento');
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[K4-02] a cadência é de 60 s: nenhuma batida antes, uma a cada 60 s depois (sorteio no meio = sem jitter)', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0.5, { servidor });
    await t.passar(59000);
    assert.equal(servidor.batidas.length, 1);
    await t.passar(2000);
    assert.equal(servidor.batidas.length, 2);
    await t.passar(240000);
    assert.equal(servidor.batidas.length, 6);
    assert.deepEqual(instantes(servidor).slice(1).map((x, i) => x - instantes(servidor)[i]), [60000, 60000, 60000, 60000, 60000]);
  });

  test('[K4-03] o jitter fica entre 54 s e 66 s (±10 %): extremos do sorteio dão 54 s e 66 s', async () => {
    for (const [sorteio, esperado] of [[0, 54000], [0.999999, 66000]]) {
      const servidor = H.criarServidor();
      const t = await abrir(sorteio, { servidor });
      await t.passar(70000);
      assert.equal(servidor.batidas.length, 2, `sorteio ${sorteio}`);
      assert.equal(servidor.batidas[1].em - servidor.batidas[0].em, esperado, `sorteio ${sorteio}`);
    }
  });

  test('[K4-04] a próxima batida só é marcada depois de a anterior terminar (resposta ou tempo limite): nunca duas ao mesmo tempo', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(HEARTBEAT, 'pendente', { vezes: 100 });
    const t = await abrir(0, { servidor });
    await t.passar(300000);
    // Cada batida fica 10 s sem resposta (tempo limite do transporte) e só então espera os 54 s mínimos.
    assert.deepEqual(instantes(servidor), [0, 64000, 128000, 192000, 256000]);
  });

  test('[K4-05] reinicializações da página (voltar/recarregar do histórico) não duplicam o agendamento: continua um só ritmo e um só temporizador', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0.5, { servidor });
    for (let i = 0; i < 3; i += 1) { await t.eventoDaJanela('popstate'); await t.passar(1000); }
    assert.equal(servidor.batidas.length, 1, 'reiniciar não dispara batida extra');
    assert.equal(timersDeBatida(t).length, 1);
    await t.passar(300000);
    assert.equal(servidor.batidas.length, 6);
    assert.equal(timersDeBatida(t).length, 1);
  });
});

describe('[K4-B] falhas: a interface não trava e o ritmo continua', () => {
  test('[K4-06] falha de rede: a tela não muda, não aparece erro e a batida seguinte sai no ritmo normal; a identificação continua funcionando', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(HEARTBEAT, 'rede', { vezes: 2 });
    const t = await abrir(0.5, { servidor });
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(!t.textoVisivel().includes(TEXTOS.comunicacao), 'a falha da batida não vira mensagem para o funcionário');
    await t.passar(130000);
    assert.deepEqual(instantes(servidor), [0, 60000, 120000]);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
  });

  test('[K4-07] erro 5xx não bloqueia nem muda o ritmo; 429 respeita o Retry-After (limitado a 120 s)', async () => {
    const s5 = H.criarServidor();
    s5.falhar(HEARTBEAT, 'status', { status: 503, codigo: 'INDISPONIVEL' });
    const t5 = await abrir(0.5, { servidor: s5 });
    await t5.passar(61000);
    assert.deepEqual(instantes(s5), [0, 60000]);
    assert.deepEqual(t5.telaAtual(), ['telaAcesso']);

    const s429 = H.criarServidor();
    s429.falhar(HEARTBEAT, '429', { retryAfter: 90 });
    const t429 = await abrir(0.5, { servidor: s429 });
    await t429.passar(89000);
    assert.equal(s429.batidas.length, 1, 'antes do prazo informado não sai nova batida');
    await t429.passar(2000);
    assert.deepEqual(instantes(s429), [0, 90000]);

    const sMax = H.criarServidor();
    sMax.falhar(HEARTBEAT, '429', { retryAfter: 600 });
    const tMax = await abrir(0.5, { servidor: sMax });
    await tMax.passar(119000);
    assert.equal(sMax.batidas.length, 1);
    await tMax.passar(2000);
    assert.deepEqual(instantes(sMax), [0, 120000]);
  });

  test('[K4-08] 401 (tablet revogado) mostra a tela de não autorizado e para as batidas; 403 (fora da rede) mostra a tela de rede e para', async () => {
    for (const [estadoDoTablet, tela] of [['nao_autorizado', 'telaNaoAutorizado'], ['rede', 'telaRede']]) {
      const servidor = H.criarServidor();
      const t = await abrir(0.5, { servidor });
      servidor.tablet = estadoDoTablet;
      await t.passar(61000);
      assert.deepEqual(t.telaAtual(), [tela], estadoDoTablet);
      assert.equal(servidor.batidas.length, 2);
      await t.passar(600000, 10000);
      assert.equal(servidor.batidas.length, 2, `${estadoDoTablet}: nenhuma batida depois do bloqueio`);
      assert.equal(timersDeBatida(t).length, 0, `${estadoDoTablet}: nenhum temporizador de batida órfão`);
    }
  });

  test('[K4-09] a perda de autorização no meio de um atendimento limpa tudo do funcionário (mesma semântica das demais operações)', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0, { servidor });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    assert.ok(t.textoVisivel().includes('Ana'));
    servidor.tablet = 'rede';
    await t.passar(54000);
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    assert.ok(!t.textoVisivel().includes('Ana'), 'o nome do funcionário não permanece na tela');
  });

  test('[K4-19] bloqueio causado por OUTRA operação (a identificação recebe 401) também para as batidas: nenhuma depois, nenhum temporizador órfão', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0.5, { servidor });
    servidor.tablet = 'nao_autorizado';
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
    assert.equal(timersDeBatida(t).length, 0, 'o temporizador da próxima batida foi cancelado pelo bloqueio');
    await t.passar(600000, 10000);
    assert.equal(servidor.batidas.length, 1, 'só a batida inicial: nenhuma depois do bloqueio');
  });

  test('[K4-10] depois do bloqueio, o recarregamento pelo mecanismo existente (popstate) com o tablet de novo autorizado retoma as batidas, uma só vez', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0.5, { servidor });
    servidor.tablet = 'rede';
    await t.passar(61000);
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    servidor.tablet = 'ativo';
    await t.eventoDaJanela('popstate');
    await t.passar(1000);
    assert.equal(servidor.batidas.length, 3, 'retomou com uma batida imediata');
    assert.equal(timersDeBatida(t).length, 1);
  });
});

describe('[K4-F] ordem do início e janelas raras', () => {
  test('[K4-20] bloqueio por OUTRA operação com a batida ainda em voo, reautorização e reinício: sem ciclo morto, um só temporizador e nenhum bloqueio indevido', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(HEARTBEAT, 'segurar'); // a batida inicial fica em voo
    const t = await abrir(0.5, { servidor });
    servidor.tablet = 'nao_autorizado';
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
    servidor.tablet = 'ativo';
    await t.eventoDaJanela('popstate');
    await t.passar(1000);
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a resposta antiga não bloqueia de novo uma tela já liberada');
    assert.equal(timersDeBatida(t).length, 1);
    await t.passar(61000);
    assert.equal(servidor.batidas.length, 2, 'o ciclo seguiu depois da batida em voo');
  });

  test('[K4-21] um 403 só da batida (rejeição própria do POST, como a de Origin) não é coberto pelo fim da sequência de início: a tela de rede permanece e a batida para', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(HEARTBEAT, 'status', { status: 403, codigo: 'ORIGEM_NAO_PERMITIDA' });
    const t = await abrir(0.5, { servidor });
    await t.passar(1000);
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    await t.passar(600000, 10000);
    assert.equal(servidor.batidas.length, 1);
    assert.equal(timersDeBatida(t).length, 0);
  });
});

/**
 * Corrida das respostas antigas da batida. A resposta é DECIDIDA pelo servidor na chegada da requisição (o status fixado na falha) e só
 * a ENTREGA espera `liberarSegurados`: é o que acontece quando o tablet era recusado no momento da batida e a resposta demora a voltar.
 */
const RECUSAS = [
  { nome: '401 (não autorizado)', status: 401, codigo: 'DISPOSITIVO_NAO_AUTORIZADO', estado: 'nao_autorizado', tela: 'telaNaoAutorizado' },
  { nome: '403 (fora da rede)', status: 403, codigo: 'REDE_NAO_AUTORIZADA', estado: 'rede', tela: 'telaRede' },
];

describe('[K4-G] respostas antigas da batida (corrida entre o bloqueio, a liberação e a resposta que volta)', () => {
  for (const r of RECUSAS) {
    test(`[K4-22] uma resposta ANTIGA ${r.nome} da batida, entregue depois de o tablet ser liberado e a página reiniciada, não bloqueia de novo a tela liberada; o ciclo continua`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(HEARTBEAT, 'status', { status: r.status, codigo: r.codigo, segurar: true });
      const t = await abrir(0.5, { servidor });
      assert.equal(servidor.batidas.length, 1, 'a batida inicial está em voo');
      servidor.tablet = r.estado;
      await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
      assert.deepEqual(t.telaAtual(), [r.tela], 'outra operação bloqueou o tablet');
      servidor.tablet = 'ativo';
      await t.eventoDaJanela('popstate');
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'tablet liberado e página reiniciada');
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a resposta antiga não bloqueia de novo uma tela liberada');
      assert.equal(timersDeBatida(t).length, 1, 'o ciclo continua com um só temporizador');
      await t.passar(61000);
      assert.equal(servidor.batidas.length, 2, 'e a batida seguinte sai no ritmo normal');
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.ok(servidor.maxEmVoo[HEARTBEAT] <= 1, 'nunca duas batidas em voo');
    });

    test(`[K4-23] controle: o ${r.nome} da batida da presença ATUAL, mesmo entregue tarde, continua bloqueando e parando as batidas`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(HEARTBEAT, 'status', { status: r.status, codigo: r.codigo, segurar: true });
      const t = await abrir(0.5, { servidor });
      await t.passar(5000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'antes da resposta a tela é a de sempre');
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), [r.tela]);
      assert.equal(timersDeBatida(t).length, 0);
      await t.passar(600000, 10000);
      assert.equal(servidor.batidas.length, 1);
    });

    test(`[K4-24] controle: a resposta antiga ${r.nome} entregue enquanto a tela segue bloqueada não muda nada (sem nova tela, sem temporizador, sem batida)`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(HEARTBEAT, 'status', { status: r.status, codigo: r.codigo, segurar: true });
      const t = await abrir(0.5, { servidor });
      servidor.tablet = r.estado;
      await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
      assert.deepEqual(t.telaAtual(), [r.tela]);
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), [r.tela]);
      assert.equal(timersDeBatida(t).length, 0);
      await t.passar(600000, 10000);
      assert.equal(servidor.batidas.length, 1);
    });

    // Limite (b): sem bloqueio anterior. A batida de antes do reinício recebe a recusa decidida na chegada; a página reinicia (popstate)
    // e o /estado confirma o tablet; a resposta antiga chega depois e não pode bloquear a tela.
    test(`[K4-25] uma resposta ANTIGA ${r.nome} da batida, entregue depois de um reinício da página (popstate) com /estado 200 e SEM bloqueio anterior, não bloqueia a tela; o ciclo continua`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(HEARTBEAT, 'status', { status: r.status, codigo: r.codigo, segurar: true });
      const t = await abrir(0.5, { servidor });
      assert.equal(servidor.batidas.length, 1, 'a batida inicial está em voo');
      await t.eventoDaJanela('popstate');
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'o /estado do reinício confirmou o tablet');
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a resposta antiga não bloqueia a tela');
      assert.equal(timersDeBatida(t).length, 1, 'um só temporizador');
      await t.passar(61000);
      assert.equal(servidor.batidas.length, 2, 'a batida seguinte sai no ritmo normal');
      assert.deepEqual(t.telaAtual(), ['telaAcesso']);
      assert.ok(servidor.maxEmVoo[HEARTBEAT] <= 1, 'nunca duas batidas em voo');
      assert.equal(servidor.atividades, 0, 'a sessão do funcionário não foi tocada');
    });

    test(`[K4-26] controle: se o /estado do reinício também recusa (${r.nome}), a tela bloqueia pelo /estado e a resposta antiga entregue depois não muda nada`, async () => {
      const servidor = H.criarServidor();
      servidor.falhar(HEARTBEAT, 'status', { status: r.status, codigo: r.codigo, segurar: true });
      const t = await abrir(0.5, { servidor });
      servidor.tablet = r.estado;
      await t.eventoDaJanela('popstate');
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), [r.tela]);
      servidor.liberarSegurados();
      await t.passar(1000);
      assert.deepEqual(t.telaAtual(), [r.tela]);
      assert.equal(timersDeBatida(t).length, 0);
      await t.passar(600000, 10000);
      assert.equal(servidor.batidas.length, 1);
    });
  }
});

describe('[K4-C] quando a batida começa', () => {
  test('[K4-11] sem tablet autorizado não há batida: tablet não ativado (401) e fora da rede (403) no início', async () => {
    for (const tablet of ['nao_autorizado', 'rede']) {
      const servidor = H.criarServidor({ tablet });
      const t = await abrir(0.5, { servidor });
      await t.passar(180000, 10000);
      assert.equal(servidor.batidas.length, 0, tablet);
      assert.equal(timersDeBatida(t).length, 0, tablet);
    }
  });

  test('[K4-12] na tela de ativação não há batida; a ativação bem-sucedida inicia exatamente uma batida imediata e o ritmo normal', async () => {
    const { codigo, servidor } = comCodigo();
    const t = await abrir(0.5, { servidor, hash: `#ativar=${codigo}` });
    await t.passar(120000, 10000);
    assert.equal(servidor.batidas.length, 0, 'antes de ativar não há credencial: nenhuma batida');
    await t.clicarEl(t.botao(TEXTOS.ativacaoBotao));
    await t.passar(1000);
    assert.equal(servidor.batidas.length, 1);
    const ativar = servidor.chamadas.find((c) => c.chave === ATIVAR);
    assert.ok(ativar.ordem < servidor.batidas[0].ordem);
    await t.passar(61000);
    assert.equal(servidor.batidas.length, 2);
  });

  test('[K4-13] ativação sem resposta confirmada e recuperada pelo estado também inicia uma única sequência de batidas', async () => {
    const { codigo, servidor } = comCodigo();
    servidor.falhar(ATIVAR, 'perdida');
    const t = await abrir(0.5, { servidor, hash: `#ativar=${codigo}` });
    await t.clicarEl(t.botao(TEXTOS.ativacaoBotao));
    await t.passar(2000);
    assert.equal(servidor.batidas.length, 1);
    assert.equal(timersDeBatida(t).length, 1);
    await t.passar(61000);
    assert.equal(servidor.batidas.length, 2);
  });
});

describe('[K4-D] a presença do tablet é independente do atendimento do funcionário', () => {
  test('[K4-14] a batida NÃO renova a sessão do funcionário: sem ação dele a sessão acaba em 60 s, nenhuma atividade é enviada e o contador não muda por causa dela', async () => {
    const servidor = H.criarServidor();
    // Sorteio 0: a segunda batida sai aos 54 s, DENTRO da sessão (que acaba aos 60 s); se renovasse, a sessão passaria dos 60 s.
    const t = await abrir(0, { servidor });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    await t.passar(61000);
    assert.deepEqual(instantes(servidor), [0, 54000], 'houve batida no meio do atendimento');
    assert.equal(servidor.atividades, 0);
    assert.equal(servidor.contar(ATIVIDADE), 0);
    assert.deepEqual(t.telaAtual(), ['telaAcesso'], 'a sessão do funcionário terminou no prazo');
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
  });

  test('[K4-15] uma batida em andamento não segura a identificação (não entra na barreira do atendimento) e leva só {}', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(HEARTBEAT, 'segurar');
    const t = await abrir(0.5, { servidor });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    assert.deepEqual(t.telaAtual(), ['telaProdutos']);
    servidor.liberarSegurados();
    await t.passar(1000);
    for (const b of servidor.batidas) assert.deepEqual(H.plano(b.corpo), {});
  });

  test('[K4-16] fluxo completo do pedido com uma batida NO MEIO dele: o pedido sai uma vez, sem violação de contrato, e as batidas nunca levam dado do funcionário nem do pedido', async () => {
    const servidor = H.criarServidor();
    const t = await abrir(0, { servidor }); // 2ª batida aos 54 s
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    await t.irAoCatalogo();
    await t.passar(20000);
    await t.irARevisao(); // ações do funcionário: renovam a sessão dele
    await t.passar(20000);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.passar(15000); // 55 s: a 2ª batida saiu com o pedido montado e ainda não enviado
    assert.deepEqual(instantes(servidor), [0, 54000]);
    await t.enviar();
    assert.equal(servidor.contar(PEDIDO), 1);
    assert.deepEqual(t.telaAtual(), ['telaConfirma']);
    await t.passar(25000);
    assert.equal(servidor.contar(PEDIDO), 1);
    for (const b of servidor.batidas) {
      assert.deepEqual(H.plano(b.corpo), {});
      assert.equal(b.url.includes('?'), false);
    }
    assert.deepEqual(servidor.violacoes, []);
  });
});

describe('[K4-E] regras de implementação e HTML aprovado intacto', () => {
  const limpo = () => H.corpus().js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('[K4-17] o código usa o transporte existente sem a barreira do atendimento, agenda por setTimeout (setInterval é só do relógio da sessão) e não usa armazenamento nem console', () => {
    const codigo = limpo();
    assert.ok(/chamar\('POST', '\/heartbeat', \{\}\)/.test(codigo), "a batida deve ser chamar('POST', '/heartbeat', {}) — sem o 4º argumento do atendimento");
    assert.equal((codigo.match(/setInterval\(/g) ?? []).length, 1, 'só o relógio da sessão usa setInterval');
    assert.ok(!/localStorage|sessionStorage|indexedDB|console\./.test(codigo));
  });

  test('[K4-18] o HTML aprovado, o CSS e o boot do Totem não foram alterados pelo K4 (SHA-256 anteriores ao K4)', () => {
    const sha = (nome) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ_TOTEM, nome))).digest('hex');
    assert.equal(sha('index.html'), '517e08e4d9ba17a31a2773b632bdc21b89d54f8bd8e06b9bc5bed3ad4d62b70c');
    assert.equal(sha('totem.css'), '9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac');
    assert.equal(sha('boot.js'), '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899');
  });
});
