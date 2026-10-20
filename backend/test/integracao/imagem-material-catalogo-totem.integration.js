'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirAmbienteImagens, descritor, CLASSIFICACAO_OUTROS } = require('./helpers/imagem-material');
const { exigirModulo } = require('../helpers/exigir-modulo');
const catalogoService = require('../../src/services/token-catalogo.service');
const materialService = require('../../src/services/material.service');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — a MESMA imagem do cadastro no CATÁLOGO DO TOTEM. A imagem pertence ao MATERIAL (colunas de `materiais`);
 * o catálogo do tablet lê esse mesmo vínculo e não existe um segundo vínculo exclusivo do Totem. Só o CONTRATO do catálogo (backend) é coberto;
 * rota de arquivo do tablet, processamento e o renderizador do Totem (congelado) ficam fora.
 *
 * Contrato (ajustado pela V7 na Unidade 3: SEM caminho, URL, chave de armazenamento ou diretório; id BIGINT como texto decimal): por material,
 *   imagem: { disponivel: false }                                           — sem imagem válida (fallback do Totem preservado)
 *   imagem: { disponivel: true, origem: 'PADRAO' | 'EMPRESA', id: '<decimal>', versao: <número> }
 * O acesso ao arquivo é decisão de unidade futura; nada de URL é inventado agora. Este arquivo é a especificação da G4 (catálogo congelado da
 * Etapa E): NÃO é executado como GREEN até a exceção da V7; hoje falha, de propósito.
 * "Válida" = a imagem referenciada existe, é da empresa (ou padrão) e está ATIVA. A imagem NUNCA filtra o material nem autoriza nada: o
 * critério de seleção do catálogo (GHE atual, material ativo, classificação de tamanho, grade) é o da Etapa E e não muda.
 *
 * Usa `montarCatalogoDoFuncionario`, a fonte única do catálogo (a mesma da rota do tablet e da prévia administrativa), sobre PostgreSQL real em
 * schema temporário do banco de teste exclusivo. [DECISÃO] marca o que o teste assume e a V7 precisa confirmar.
 */

const CHAVES_DO_MATERIAL = ['categoria', 'exigeTamanho', 'grupoProtecao', 'id', 'imagem', 'nome', 'tamanhos', 'tipo', 'unidade'];
const SEM_IMAGEM = Object.freeze({ disponivel: false });
const CHAVES_IMAGEM_DISPONIVEL = ['disponivel', 'id', 'origem', 'versao'];
const SEM_CAMINHO = /caminho|url|chave|diret[oó]rio|\/api\/|\/tablet\//i;

describe('Catálogo do Totem — a mesma imagem associada ao material, com fallback e troca refletida (PostgreSQL real)', () => {
  let a;
  let A;
  let B;
  let ATOR_A;
  let ATOR_B;
  let seq = 0;

  before(async () => {
    a = await abrirAmbienteImagens();
    ({ empresaA: A, empresaB: B, atorA: ATOR_A, atorB: ATOR_B } = a.d);
  });
  after(async () => { if (a) await a.encerrar(); });

  const biblioteca = () => exigirModulo('src/services/imagem-material.service');
  const imagemDaEmpresa = async (empresaId = A, atorId = ATOR_A) => (await biblioteca().registrarEmpresa(a.pool, { empresaId, atorId, nome: `Imagem CAT ${++seq}`, imagem: descritor() })).imagem;
  /** Material no GHE de um funcionário ativo, com a imagem (ou sem). Devolve ids. */
  async function cenario({ empresaId = A, imagem = undefined, atorId = ATOR_A, nome = 'Material CAT', materialExtra = {} } = {}) {
    seq += 1;
    const material = await materialService.criar(a.pool, {
      empresaId, atorId, nome: `${nome} ${seq}`, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, ...(imagem === undefined ? {} : { imagem }), ...materialExtra,
    });
    const { gheId, funcionarioId } = await a.funcionarioComMaterial(empresaId, [material.id]);
    return { material, gheId, funcionarioId, empresaId };
  }
  async function catalogo({ empresaId, funcionarioId }) {
    const client = await a.pool.connect();
    try {
      await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
      const r = await catalogoService.montarCatalogoDoFuncionario(client, { empresaId, funcionarioId });
      await client.query('COMMIT');
      return r;
    } finally { client.release(); }
  }
  const doMaterial = (cat, materialId) => cat.materiais.find((m) => m.id === materialId);

  describe('[CAT] contrato da imagem no catálogo', () => {
    test('CAT-01: material com imagem da EMPRESA → { disponivel:true, origem, id (texto), versao } com as chaves exatas e SEM caminho; padrão idem com origem PADRAO', async () => {
      const img = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão CAT01' });
      const e = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      const d = await cenario({ imagem: { origem: 'PADRAO', id: p.id } });
      const mE = doMaterial(await catalogo(e), e.material.id);
      const mP = doMaterial(await catalogo(d), d.material.id);
      assert.deepEqual(Object.keys(mE.imagem).sort(), CHAVES_IMAGEM_DISPONIVEL);
      assert.deepEqual(mE.imagem, { disponivel: true, origem: 'EMPRESA', id: img.id, versao: 1 });
      assert.deepEqual(mP.imagem, { disponivel: true, origem: 'PADRAO', id: p.id, versao: 1 });
      assert.equal(typeof mE.imagem.id, 'string');
      assert.equal(SEM_CAMINHO.test(JSON.stringify([mE, mP])), false, 'nenhum caminho, URL, chave ou diretório no catálogo');
    });

    test('CAT-02: é a MESMA imagem do cadastro — origem, id e versão do catálogo coincidem com os de material.buscar; não existe segundo vínculo (nenhuma tabela ou coluna de imagem própria do Totem)', async () => {
      const img = await imagemDaEmpresa();
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      const cadastro = (await materialService.buscar(a.pool, { empresaId: A, materialId: c.material.id })).imagem;
      const totem = doMaterial(await catalogo(c), c.material.id).imagem;
      assert.deepEqual([totem.origem, totem.id, totem.versao], [cadastro.origem, cadastro.id, cadastro.versao]);
      const { rows } = await a.q(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND (table_name LIKE 'token\\_%' OR table_name LIKE 'solicitacoes\\_autoatendimento%')
            AND column_name ILIKE '%imag%'`,
      );
      assert.deepEqual(rows, [], 'as tabelas do Totem não guardam imagem: o vínculo é o do material');
      const tabelasDeImagem = (await a.q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ILIKE '%imag%' ORDER BY 1")).rows.map((r) => r.table_name);
      assert.deepEqual(tabelasDeImagem, ['imagens_empresa', 'imagens_padrao', 'imagens_padrao_tipos'], 'nenhuma biblioteca separada para o Totem');
    });

    test('CAT-03: sem imagem → exatamente { disponivel:false } (fallback do Totem preservado) e as chaves do material continuam as mesmas da Etapa E', async () => {
      const c = await cenario();
      const m = doMaterial(await catalogo(c), c.material.id);
      assert.deepEqual(m.imagem, SEM_IMAGEM);
      assert.deepEqual(Object.keys(m).sort(), CHAVES_DO_MATERIAL);
    });

    test('CAT-04: imagem referenciada que deixou de ser VÁLIDA (inativada por fora do serviço) vira o fallback; o material continua no catálogo (a imagem nunca filtra)', async () => {
      const img = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão CAT04' });
      const e = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      const d = await cenario({ imagem: { origem: 'PADRAO', id: p.id } });
      await a.q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [img.id]);
      await a.q('UPDATE imagens_padrao SET ativo = false WHERE id = $1', [p.id]);
      assert.deepEqual(doMaterial(await catalogo(e), e.material.id).imagem, SEM_IMAGEM);
      assert.deepEqual(doMaterial(await catalogo(d), d.material.id).imagem, SEM_IMAGEM);
    });

    test('CAT-05: troca de imagem refletida na PRÓXIMA consulta (A → B → padrão → nenhuma), sem estado guardado do lado do Totem', async () => {
      const x = await imagemDaEmpresa();
      const y = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão CAT05' });
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: x.id } });
      const ver = async () => doMaterial(await catalogo(c), c.material.id).imagem;
      assert.equal((await ver()).id, x.id);
      await materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: c.material.id, imagem: { origem: 'EMPRESA', id: y.id } });
      assert.deepEqual(await ver(), { disponivel: true, origem: 'EMPRESA', id: y.id, versao: 1 });
      await materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: c.material.id, imagem: { origem: 'PADRAO', id: p.id } });
      assert.equal((await ver()).origem, 'PADRAO');
      await materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: c.material.id, imagem: null });
      assert.deepEqual(await ver(), SEM_IMAGEM);
    });

    test('CAT-06: a versão da imagem acompanha o arquivo — subir a versão aparece na próxima consulta (base do cache por versão), sem nenhum caminho', async () => {
      const img = await imagemDaEmpresa();
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      await a.q('UPDATE imagens_empresa SET versao = 2 WHERE id = $1', [img.id]);
      const m = doMaterial(await catalogo(c), c.material.id);
      assert.deepEqual(m.imagem, { disponivel: true, origem: 'EMPRESA', id: img.id, versao: 2 });
    });

    test('CAT-08: os JOINs da imagem não multiplicam nem somem linhas — N materiais (imagens distintas, uma padrão compartilhada, um sem imagem) = N entradas, ids únicos, total = N, cada um com a SUA imagem', async () => {
      const x = await imagemDaEmpresa();
      const y = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão compartilhada CAT08' });
      const criar = (nome, imagem) => materialService.criar(a.pool, { empresaId: A, atorId: ATOR_A, nome, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, ...(imagem ? { imagem } : {}) });
      const m1 = await criar('CAT08 m1', { origem: 'EMPRESA', id: x.id });
      const m2 = await criar('CAT08 m2', { origem: 'EMPRESA', id: y.id });
      const m3 = await criar('CAT08 m3', { origem: 'PADRAO', id: p.id });
      const m4 = await criar('CAT08 m4', { origem: 'PADRAO', id: p.id });
      const m5 = await criar('CAT08 m5');
      const esperados = [[m1.id, 'EMPRESA', x.id], [m2.id, 'EMPRESA', y.id], [m3.id, 'PADRAO', p.id], [m4.id, 'PADRAO', p.id], [m5.id, null, null]];
      const f = await a.funcionarioComMaterial(A, esperados.map((e) => e[0]));
      const cat = await catalogo({ empresaId: A, funcionarioId: f.funcionarioId });
      assert.equal(cat.total, 5);
      assert.equal(cat.materiais.length, 5);
      assert.equal(new Set(cat.materiais.map((m) => m.id)).size, 5, 'nenhum material repetido');
      assert.deepEqual(
        cat.materiais.map((m) => [m.id, m.imagem.disponivel ? m.imagem.origem : null, m.imagem.disponivel ? m.imagem.id : null]).sort((u, v) => u[0] - v[0]),
        esperados.sort((u, v) => u[0] - v[0]),
      );
      assert.deepEqual(cat.materiais.map((m) => m.nome), [...cat.materiais.map((m) => m.nome)].sort((u, v) => u.toLowerCase().localeCompare(v.toLowerCase())), 'ordem por nome preservada');
    });

    test('CAT-07: cada material mostra a SUA imagem; materiais sem imagem convivem com materiais com imagem no mesmo catálogo', async () => {
      const x = await imagemDaEmpresa();
      const m1 = await materialService.criar(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Com imagem CAT07', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: x.id } });
      const m2 = await materialService.criar(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Sem imagem CAT07', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS });
      const f = await a.funcionarioComMaterial(A, [m1.id, m2.id]);
      const cat = await catalogo({ empresaId: A, funcionarioId: f.funcionarioId });
      assert.deepEqual([doMaterial(cat, m1.id).imagem.id, doMaterial(cat, m2.id).imagem], [x.id, SEM_IMAGEM]);
    });
  });

  describe('[ISO] isolamento entre empresas e preservação das regras do catálogo', () => {
    test('ISO-01: o catálogo de uma empresa nunca traz imagem de outra (nem por id coincidente); a imagem PADRÃO é global e aparece igual nas duas', async () => {
      const deB = await imagemDaEmpresa(B, ATOR_B);
      const deA = await imagemDaEmpresa(A, ATOR_A);
      const p = await a.padrao({ nome: 'Padrão compartilhada CAT-ISO01' });
      const cA = await cenario({ empresaId: A, atorId: ATOR_A, imagem: { origem: 'EMPRESA', id: deA.id } });
      const cB = await cenario({ empresaId: B, atorId: ATOR_B, imagem: { origem: 'EMPRESA', id: deB.id } });
      const pA = await cenario({ empresaId: A, atorId: ATOR_A, imagem: { origem: 'PADRAO', id: p.id } });
      const pB = await cenario({ empresaId: B, atorId: ATOR_B, imagem: { origem: 'PADRAO', id: p.id } });
      const catA = await catalogo(cA);
      const catB = await catalogo(cB);
      assert.equal(doMaterial(catA, cA.material.id).imagem.id, deA.id);
      assert.equal(doMaterial(catB, cB.material.id).imagem.id, deB.id);
      assert.equal(doMaterial(catA, cA.material.id).imagem.id === deB.id, false, 'a imagem da outra empresa não aparece');
      assert.equal(JSON.stringify(catA).includes(`"id":"${deB.id}"`), false);
      assert.deepEqual(doMaterial(await catalogo(pA), pA.material.id).imagem, doMaterial(await catalogo(pB), pB.material.id).imagem);
    });

    test('ISO-02: a imagem não autoriza nem filtra: material com imagem FORA do GHE do funcionário, ou INATIVO, continua fora; material com imagem inativa continua dentro', async () => {
      const img = await imagemDaEmpresa();
      const dentro = await cenario({ imagem: { origem: 'EMPRESA', id: img.id }, nome: 'Dentro ISO02' });
      const fora = await materialService.criar(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Fora do GHE ISO02', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: img.id } });
      const inativo = await materialService.criar(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Inativo ISO02', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'EMPRESA', id: img.id } });
      await a.q('UPDATE materiais SET ativo = false WHERE id = $1', [inativo.id]);
      const f = await a.funcionarioComMaterial(A, [dentro.material.id, inativo.id]);
      const cat = await catalogo({ empresaId: A, funcionarioId: f.funcionarioId });
      assert.equal(doMaterial(cat, fora.id), undefined, 'imagem não concede autorização de GHE');
      assert.equal(doMaterial(cat, inativo.id), undefined, 'material inativo continua fora');
      assert.ok(doMaterial(cat, dentro.material.id));
    });

    test('ISO-03: o catálogo não vaza nada além do contrato: nenhum hash, byte, nome da imagem, chave ou caminho de armazenamento', async () => {
      const img = await biblioteca().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Nome interno ISO03', imagem: descritor() });
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: img.imagem.id } });
      const bruto = JSON.stringify(await catalogo(c));
      for (const proibido of ['sha256', 'Nome interno ISO03', 'bytes', 'chave', 'criadoPor', 'miniatura', 'exibicao', 'mestre']) assert.equal(bruto.includes(proibido), false, `vazou ${proibido}`);
    });

    test('ISO-04: a consulta do catálogo continua PURA — não escreve nada (imagens, materiais, auditoria) e roda em transação só de leitura', async () => {
      const img = await imagemDaEmpresa();
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      const antes = [await a.contagem('logs_auditoria'), await a.contagem('imagens_empresa'), JSON.stringify(await a.linhaDoMaterial(c.material.id))];
      await catalogo(c);
      assert.deepEqual([await a.contagem('logs_auditoria'), await a.contagem('imagens_empresa'), JSON.stringify(await a.linhaDoMaterial(c.material.id))], antes);
    });

    test('ISO-05: as demais regras da Etapa E seguem iguais com imagem: estados SEM_GHE / GHE_INATIVO / SEM_MATERIAIS e total', async () => {
      const img = await imagemDaEmpresa();
      const c = await cenario({ imagem: { origem: 'EMPRESA', id: img.id } });
      const ok = await catalogo(c);
      assert.deepEqual([ok.estado, ok.total, ok.materiais.length], ['OK', 1, 1]);
      await a.q('UPDATE grupos_homogeneos_exposicao SET ativo = false WHERE id = $1', [c.gheId]);
      assert.deepEqual((({ estado, total, materiais }) => ({ estado, total, materiais }))(await catalogo(c)), { estado: 'GHE_INATIVO', total: 0, materiais: [] });
    });
  });
});
