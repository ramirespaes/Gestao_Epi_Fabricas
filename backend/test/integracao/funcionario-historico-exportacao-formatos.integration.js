'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { unzipSync, strFromU8 } = require('fflate');

const { montar: montarAmbiente } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, criarGhe, registrarEntrega,
} = require('./helpers/entrega-epi');
const { criarEntregaEpiController } = require('../../src/controllers/entrega-epi.controller');
const { criarEntregaEpiRoutes } = require('../../src/routes/entrega-epi.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');

/**
 * Pacote I (GREEN, complemento): os ARQUIVOS reais. O PDF é lido de volta (fluxos descompactados, texto WinAnsi das
 * instruções TJ) e o XLSX é aberto como o pacote OOXML que é (fflate): seções, acentos, omissão das entregas sem
 * epiFicha.visualizar, nenhum CPF, nenhuma fórmula nem macro. Também os limites: 5.000 registros por seção (recusa
 * inteira, nada auditado) e 10 exportações por minuto por usuário, inclusive com pedidos simultâneos.
 */

const AUDITORIA = 'FUNCIONARIO_HISTORICO_EXPORTADO';
const instante = (dia, hora = '12:00:00') => `${dia}T${hora}-03:00`;
const cp1252 = new TextDecoder('windows-1252');

/** Texto de um PDF do pdfkit: cada TJ vira uma linha com os trechos hexadecimais decodificados em WinAnsi. */
function textoDoPdf(pdf) {
  const bruto = pdf.toString('latin1');
  const linhas = [];
  for (const m of bruto.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let conteudo;
    try { conteudo = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const tj of conteudo.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ/g)) {
      linhas.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => cp1252.decode(Buffer.from(h[1], 'hex'))).join(''));
    }
  }
  return linhas.join('\n');
}
const paginasDoPdf = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

const desescapar = (xml) => xml.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function abrirXlsx(buffer) {
  const arquivos = unzipSync(new Uint8Array(buffer));
  const texto = (nome) => (arquivos[nome] ? strFromU8(arquivos[nome]) : null);
  const textos = [...(texto('xl/sharedStrings.xml') ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1]));
  const abas = [...(texto('xl/workbook.xml') ?? '').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => desescapar(m[1]));
  // Valores por aba, na ordem das células (só strings compartilhadas e números).
  const celulas = (n) => {
    const xml = texto(`xl/worksheets/sheet${n}.xml`) ?? '';
    return [...xml.matchAll(/<c ([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g)].map((m) => {
      if (m[2] === undefined) return '';
      return /\bt="s"/.test(m[1]) ? textos[Number(m[2])] : m[2];
    });
  };
  return { arquivos, nomes: Object.keys(arquivos), texto, textos, abas, celulas };
}

describe('I (complemento) — PDF e XLSX reais, limites e concorrência (PostgreSQL real)', () => {
  let g;
  let master;
  const f = {};

  before(async () => {
    g = await montarAmbiente({ extras: ({ pool, exigirEmpresarial }) => [
      criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    await provisionamento.provisionar(g.pool, { empresaId: A, dryRun: false });
    master = await g.contaDaEmpresa(A);
    const gheId = await criarGhe(g.pool, A, 'Caldeiraria Pesada');
    f.principal = await criarFuncionario(g.pool, A, { matricula: 'XP-1', cpf: g.cpfFicticio(9700), gheId, setor: 'Manutenção Elétrica', funcao: 'Técnico de Segurança' });
    f.formula = await criarFuncionario(g.pool, A, { matricula: 'XP-2', cpf: g.cpfFicticio(9701), setor: '=HYPERLINK("http://exemplo.invalid","x")', funcao: '+cmd|calc' });
    f.grande = await criarFuncionario(g.pool, A, { matricula: 'XP-3', cpf: g.cpfFicticio(9702) });
    f.leve = await criarFuncionario(g.pool, A, { matricula: 'XP-4', cpf: g.cpfFicticio(9703) });

    const ficha = await criarFicha(g.pool, A, f.principal);
    const materialId = await criarMaterial(g.pool, A, 'Luva Nitrílica Ação', { prazo: 90 });
    const loteId = await criarLote(g.pool, { empresaId: A, materialId, quantidade: 1000, tamanho: 'G' });
    for (const dia of ['2026-01-05', '2026-01-20', '2025-12-10']) {
      await registrarEntrega(g.pool, {
        usuarioId: master.usuarioId,
        entrega: { empresa_id: A, ficha_id: ficha.id, responsavel_id: master.usuarioId, data_operacional: dia, entregue_em: instante(dia) },
        itens: [{ material_id: materialId, lote_id: loteId, material_nome: 'Luva Nitrílica Ação', material_prazo_uso_dias: 90, quantidade: 2 }],
      });
    }
    // 120 alterações cadastrais: o PDF do histórico completo precisa de mais de uma página.
    await g.pool.query(
      `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em)
       SELECT $1, $2, 'FUNCIONARIO_ALTERADO', $3, jsonb_build_object('setor', 'Setor ' || n), jsonb_build_object('setor', 'Setor ' || (n + 1)),
              timestamptz '2025-11-01T12:00:00Z' + make_interval(hours => n)
         FROM generate_series(1, 120) AS n`,
      [A, master.usuarioId, String(f.principal)],
    );
    // 5.001 eventos cadastrais num funcionário: acima do limite por seção; 5.000 deles fora de janeiro de 2026.
    await g.pool.query(
      `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em)
       SELECT $1, $2, 'FUNCIONARIO_ALTERADO', $3, jsonb_build_object('nome', 'N' || n), jsonb_build_object('nome', 'N' || (n + 1)),
              CASE WHEN n = 1 THEN timestamptz '2026-01-15T12:00:00Z' ELSE timestamptz '2024-01-01T00:00:00Z' + make_interval(mins => n) END
         FROM generate_series(1, 5001) AS n`,
      [A, master.usuarioId, String(f.grande)],
    );
  });
  after(async () => { if (g) await g.encerrar(); });

  const exportar = (c, id, corpo) => g.request(g.app).post(`/api/funcionarios/${id}/historico/exportacao`).set('Cookie', g.cookie(c))
    .buffer(true).parse((res, cb) => { const partes = []; res.on('data', (p) => partes.push(p)); res.on('end', () => cb(null, Buffer.concat(partes))); })
    .send(corpo);
  const ligar = async (c, id) => {
    const r = await g.request(g.app).put(`/api/administracao/usuarios/${c.usuarioId}/acessos/${id}`).set('Cookie', g.cookie(master)).send({ ligado: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const conta = async (acessos) => {
    const c = await g.contaDaEmpresa(g.empresas.A, 'USUARIO');
    for (const id of acessos) await ligar(c, id);
    return c;
  };
  const auditorias = (usuarioId) => g.todos('SELECT referencia, dados_novos FROM logs_auditoria WHERE acao = $1 AND usuario_id = $2 ORDER BY id', [AUDITORIA, usuarioId]);
  const jsonDe = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };

  describe('F1 — PDF', () => {
    test('F1.1 PDF válido (cabeçalho, xref, %%EOF), com título, empresa, emissão, período, seções e acentos preservados', async () => {
      const r = await exportar(master, f.principal, { formato: 'pdf', de: '2026-01-01', ate: '2026-01-31' });
      assert.equal(r.status, 200, r.body.toString('utf8').slice(0, 200));
      const pdf = r.body;
      assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(pdf.subarray(-32).toString('latin1'), /%%EOF\s*$/);
      assert.match(pdf.toString('latin1'), /\bxref\b[\s\S]*\btrailer\b/);
      const t = textoDoPdf(pdf);
      for (const esperado of ['Histórico de Funcionários', 'Trabalhador XP-1', 'Empresa', 'Empresa Alfa', 'Emitido em', 'Período', '01/01/2026 a 31/01/2026',
        'Identificação', 'Manutenção Elétrica', 'Técnico de Segurança', 'Indicadores (histórico completo)', 'Retiradas realizadas',
        'Histórico de entregas de EPIs', 'Luva Nitrílica Ação', 'Histórico de GHE', 'Histórico de Situação', 'Histórico de Alterações Cadastrais', 'Página 1 de']) {
        assert.ok(t.includes(esperado), `PDF sem "${esperado}"`);
      }
      assert.equal(t.includes('10/12/2025'), false, 'entrega fora do período não aparece');
      assert.equal(t.includes(g.cpfFicticio(9700)), false);
    });

    test('F1.2 histórico completo longo: várias páginas, todas numeradas "Página i de N", sem truncar', async () => {
      const r = await exportar(master, f.principal, { formato: 'pdf' });
      assert.equal(r.status, 200);
      const n = paginasDoPdf(r.body);
      assert.ok(n >= 2, `páginas: ${n}`);
      const t = textoDoPdf(r.body);
      for (let i = 1; i <= n; i += 1) assert.ok(t.includes(`Página ${i} de ${n}`), `sem "Página ${i} de ${n}"`);
      assert.ok(t.includes('Setor 121'), 'a última alteração cadastral (página final) está lá');
      assert.ok(t.includes('Todo o histórico'));
    });
  });

  describe('F2 — XLSX', () => {
    test('F2.1 pacote OOXML válido, uma aba por seção, cabeçalhos legíveis, sem fórmula, sem macro e sem CPF', async () => {
      const r = await exportar(master, f.principal, { formato: 'xlsx' });
      assert.equal(r.status, 200);
      const x = abrirXlsx(r.body);
      for (const parte of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) assert.ok(x.nomes.includes(parte), parte);
      assert.deepEqual(x.abas, ['Identificação', 'Indicadores', 'Entregas de EPIs', 'Histórico de GHE', 'Histórico de Situação', 'Histórico Cadastral']);
      assert.equal(x.nomes.some((n) => /vbaProject|macro/i.test(n)), false, 'sem macro');
      for (const n of x.nomes.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) assert.equal(/<f[ >]/.test(x.texto(n)), false, `${n} com fórmula`);
      const todo = x.nomes.map((n) => x.texto(n)).join('\n');
      assert.equal(todo.includes(g.cpfFicticio(9700)), false);
      const id = x.celulas(1);
      for (const esperado of ['Nome', 'Trabalhador XP-1', 'Setor', 'Manutenção Elétrica', 'Cargo / função', 'Técnico de Segurança', 'Período', 'Todo o histórico']) assert.ok(id.includes(esperado), `Identificação sem "${esperado}"`);
      const entregas = x.celulas(3);
      for (const esperado of ['Data', 'EPI', 'Qtd.', 'Luva Nitrílica Ação', 'G', '2']) assert.ok(entregas.includes(esperado), `Entregas sem "${esperado}"`);
      assert.ok(x.celulas(6).includes('Setor 121'));
    });

    test('F2.2 texto que começa como fórmula vira texto com apóstrofo (nunca fórmula executável)', async () => {
      const r = await exportar(master, f.formula, { formato: 'xlsx' });
      assert.equal(r.status, 200);
      const x = abrirXlsx(r.body);
      const id = x.celulas(1);
      assert.ok(id.includes(`'=HYPERLINK("http://exemplo.invalid","x")`), JSON.stringify(id));
      assert.ok(id.includes("'+cmd|calc"));
      assert.equal(id.some((v) => typeof v === 'string' && /^[=+\-@]/.test(v)), false);
      for (const n of x.nomes.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) assert.equal(/<f[ >]/.test(x.texto(n)), false);
    });
  });

  describe('F3 — sem permissão de EPI', () => {
    test('F3.1 PDF e XLSX dizem que entregas e indicadores foram omitidos; nenhum dado de EPI no arquivo', async () => {
      const c = await conta(['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
      const pdf = await exportar(c, f.principal, { formato: 'pdf' });
      assert.equal(pdf.status, 200);
      const t = textoDoPdf(pdf.body);
      assert.ok(t.includes('Seção omitida'), t.slice(0, 400));
      assert.equal(t.includes('Luva Nitrílica Ação'), false);
      assert.equal(t.includes('Retiradas realizadas'), false);
      const xlsx = abrirXlsx((await exportar(c, f.principal, { formato: 'xlsx' })).body);
      assert.ok(xlsx.celulas(3).some((v) => typeof v === 'string' && v.startsWith('Seção omitida')));
      assert.ok(xlsx.celulas(2).some((v) => typeof v === 'string' && v.startsWith('Seção omitida')));
      assert.equal(xlsx.textos.includes('Luva Nitrílica Ação'), false);
      const [a1, a2] = await auditorias(c.usuarioId);
      for (const a of [a1, a2]) {
        assert.deepEqual(a.dados_novos.secoes, ['identificacao', 'ghe', 'situacao', 'cadastral']);
        assert.equal(a.dados_novos.contagens.entregas, null, 'omitida não é zero');
      }
    });
  });

  describe('F4 — limites', () => {
    test('F4.1 seção acima de 5.000 registros: 422 EXPORTACAO_GRANDE_DEMAIS, nenhum arquivo, nada auditado; com período menor, gera', async () => {
      const antes = (await auditorias(master.usuarioId)).length;
      const r = await exportar(master, f.grande, { formato: 'xlsx' });
      assert.equal(r.status, 422);
      assert.equal(jsonDe(r)?.codigo, 'EXPORTACAO_GRANDE_DEMAIS');
      assert.match(jsonDe(r)?.message ?? '', /período/i);
      assert.equal(r.headers['content-disposition'], undefined);
      assert.equal((await auditorias(master.usuarioId)).length, antes);
      const menor = await exportar(master, f.grande, { formato: 'xlsx', de: '2026-01-01', ate: '2026-01-31' });
      assert.equal(menor.status, 200);
    });

    test('F4.2 10 exportações por minuto por usuário: a 11ª é 429 EXPORTACAO_LIMITE_EXCEDIDO e não é auditada', async () => {
      const c = await conta(['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
      for (let i = 1; i <= 10; i += 1) assert.equal((await exportar(c, f.leve, { formato: i % 2 ? 'pdf' : 'xlsx' })).status, 200, `exportação ${i}`);
      const r = await exportar(c, f.leve, { formato: 'pdf' });
      assert.deepEqual([r.status, jsonDe(r)?.codigo], [429, 'EXPORTACAO_LIMITE_EXCEDIDO']);
      assert.equal((await auditorias(c.usuarioId)).length, 10);
      const outro = await conta(['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
      assert.equal((await exportar(outro, f.leve, { formato: 'pdf' })).status, 200, 'o limite é por usuário');
    });

    test('F4.3 pedidos simultâneos do mesmo usuário: exatamente 10 geram (e são auditados); os demais recebem 429', async () => {
      const c = await conta(['historicoFuncionarios', 'exportarHistoricoFuncionarios']);
      const respostas = await Promise.all(Array.from({ length: 13 }, (_, i) => exportar(c, f.leve, { formato: i % 2 ? 'pdf' : 'xlsx' })));
      const status = respostas.map((r) => r.status).sort();
      assert.deepEqual(status, [...Array(10).fill(200), ...Array(3).fill(429)]);
      assert.equal((await auditorias(c.usuarioId)).length, 10);
    });
  });
});
