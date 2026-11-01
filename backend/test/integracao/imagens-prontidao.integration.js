'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { importarPacotePadrao } = require('../../src/services/imagem-padrao-importacao.service');
const prontidao = require('../../src/services/imagem-biblioteca-prontidao.service');
const { chaveDe } = require('../../src/storage/armazenamento-imagens');
const { criarEntregaDeImagens } = require('../../src/services/imagem-material-entrega.service');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const h = require('../helpers/pacote-padrao-ficticio');
const { espiarPool, instantaneoDoArmazenamento, instantaneoDoBanco } = require('../helpers/instrumentacao-importacao');

/**
 * Prontidão da biblioteca padrão com PostgreSQL REAL (schema temporário exclusivo de gestao_epi_teste_local, com todas as migrations) e ARMAZENAMENTO REAL
 * (diretório temporário exclusivo por teste), usando o importador e o verificador de verdade. Nenhuma das 31 imagens reais: pacotes fictícios de test/helpers.
 * O plano tem dois pacotes, de 30 e de 1 imagem, como a biblioteca que cresce por pacotes adicionais.
 */

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const NOME_A = 'Pacote_Ficticio_30.zip';
const NOME_B = 'Pacote_Ficticio_Adicional_1.zip';
const pacoteA = h.montarPacote();
const itemB = h.recomporItem('Item Adicional Ficticio', {
  original: h.originalFicticio('adicional'), padronizado: h.pngFicticio({ semente: 'adicional' }), miniatura: h.webpFicticio({ semente: 'adicional' }),
});
const pacoteB = Object.freeze({ ...pacoteA, itens: Object.freeze([itemB]), manifesto: h.manifestoCsv([itemB]) });
const ZIP_A = h.zipDoPacote(pacoteA);
const ZIP_B = h.zipDoPacote(pacoteB);

describe('[PRONTIDAO-DB] prontidão da biblioteca padrão com PostgreSQL e armazenamento reais', () => {
  let amb = null;
  let identidade = null;
  let raizes = [];
  const limparRaizes = () => { for (const raiz of raizes) removerTemporarioSeguro(raiz); raizes = []; };
  before(async () => {
    amb = await abrirAmbienteImagens();
    identidade = (await amb.q('SELECT current_database() AS banco, d.oid::text AS oid FROM pg_database d WHERE d.datname = current_database()')).rows[0];
  });
  after(async () => { limparRaizes(); if (amb) await amb.encerrar(); });

  /** Biblioteca VAZIA no banco e no diretório (0700), ZIPs e plano numa pasta própria. */
  async function cenario({ pacotes = [{ nome: NOME_A, zip: ZIP_A, quantidade: 30 }, { nome: NOME_B, zip: ZIP_B, quantidade: 1 }] } = {}) {
    limparRaizes();
    await amb.q('DELETE FROM imagens_padrao');
    const base = criarRaizTemporaria();
    raizes.push(base);
    const dirPacotes = path.join(base, 'pacotes');
    const dirImagens = path.join(base, 'imagens');
    fs.mkdirSync(dirPacotes);
    fs.mkdirSync(dirImagens);
    fs.chmodSync(dirImagens, 0o700);
    for (const p of pacotes) h.gravarArquivo(dirPacotes, p.nome, p.zip);
    const planoBytes = Buffer.from(JSON.stringify({ versao: 1, pacotes: pacotes.map((p) => ({ arquivo: p.nome, sha256: sha(p.zip), quantidade: p.quantidade })) }));
    return {
      base, dirPacotes, dirImagens, pacotes, plano: { bytes: planoBytes, sha256Esperado: sha(planoBytes) },
      ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria', IMAGENS_ARMAZENAMENTO_DIRETORIO: dirImagens },
    };
  }

  const importar = (c, pacote, opcoes = {}) => importarPacotePadrao(amb.pool, {
    pacote: path.join(c.dirPacotes, pacote.nome),
    pacoteSha256Esperado: sha(pacote.zip),
    quantidadeEsperada: pacote.quantidade,
    armazenamento: criarArmazenamentoImagens({ diretorio: c.dirImagens }),
    mapeamento: null,
    executar: true,
    destinoAutorizado: identidade,
    ...opcoes,
  });
  const importarTodos = async (c) => { for (const p of c.pacotes) await importar(c, p); };
  const verificar = (c, { pool = amb.pool, ambiente = c.ambiente, plano = c.plano, ...extra } = {}) => prontidao.verificarProntidao({
    ambiente, pool, plano, pastaPacotes: c.dirPacotes, destino: identidade, ...extra,
  });
  const estado = async (c) => ({ banco: await instantaneoDoBanco(amb.q), disco: instantaneoDoArmazenamento(c.dirImagens) });
  const codigos = (relatorio) => relatorio.motivos.map((m) => m.codigo);
  const conteudoDe = (c, item, variante) => path.join(c.dirImagens, ...chaveDe({
    escopo: 'PADRAO', sha256: item.sha256Padronizado, variante, formato: variante === 'mestre' ? 'PNG' : 'WEBP',
  }).split('/'));

  test('biblioteca obrigatória com banco e diretório AMBOS vazios: NAO_PROVISIONADA, ainda que o verificador sozinho diga INTEGRO', async () => {
    const c = await cenario();
    const antes = await estado(c);
    const relatorio = await verificar(c);
    assert.equal(relatorio.armazenamento.veredito, 'INTEGRO', 'o controle: banco e diretório vazios são íntegros para o verificador');
    assert.equal(relatorio.estado, 'NAO_PROVISIONADA');
    assert.deepEqual(codigos(relatorio), ['PACOTE_NAO_PROVISIONADO', 'PACOTE_NAO_PROVISIONADO']);
    assert.deepEqual(relatorio.motivos.map((m) => [m.faltandoRegistro, m.faltandoArquivo]), [[30, 60], [1, 2]]);
    assert.deepEqual(await estado(c), antes, 'a prontidão não pode alterar banco nem disco');
  });

  test('depois da importação oficial dos dois pacotes: PROVISIONADA_INTEGRA, sem escrever nada ao verificar', async () => {
    const c = await cenario();
    await importarTodos(c);
    assert.equal(arquivosSob(c.dirImagens).length, 62);
    const antes = await estado(c);
    const espiado = espiarPool(amb.pool);
    const relatorio = await verificar(c, { pool: espiado.espiao });
    assert.equal(relatorio.estado, 'PROVISIONADA_INTEGRA', JSON.stringify(relatorio.motivos));
    assert.deepEqual(relatorio.pacotes.map((p) => [p.arquivo, p.imagens, p.situacao]), [[NOME_A, 30, 'PROVISIONADO'], [NOME_B, 1, 'PROVISIONADO']]);
    assert.equal(relatorio.armazenamento.veredito, 'INTEGRO');
    assert.equal(relatorio.banco.nome, identidade.banco);
    assert.deepEqual(espiado.escritas(), [], 'nenhuma instrução de escrita');
    assert.deepEqual(await estado(c), antes);
  });

  test('instalação limpa: 2 arquivos por imagem (62 para 31), sem exibição; íntegra; a entrega serve a miniatura e responde 404 para a exibição', async () => {
    const c = await cenario();
    await importarTodos(c);
    const nomes = arquivosSob(c.dirImagens).map((relativo) => path.basename(relativo));
    const contar = (nome) => nomes.filter((n) => n === nome).length;
    assert.deepEqual([nomes.length, contar('mestre.png'), contar('miniatura.webp'), contar('exibicao.webp')], [62, 31, 31, 0]);
    const linhas = (await amb.q('SELECT id::text AS id, sha256_exibicao, bytes_exibicao FROM imagens_padrao ORDER BY id')).rows;
    assert.equal(linhas.length, 31);
    assert.ok(linhas.every((l) => l.sha256_exibicao === null && l.bytes_exibicao === null), 'a exibição não é registrada pela importação');
    assert.equal((await verificar(c)).estado, 'PROVISIONADA_INTEGRA', 'a ausência da exibição não torna a biblioteca inconsistente');

    const entrega = criarEntregaDeImagens({ armazenamento: criarArmazenamentoImagens({ diretorio: c.dirImagens }), registro: () => {} });
    const base = { empresaId: amb.d.empresaA, origem: 'padrao', id: linhas[0].id };
    const miniatura = await entrega.obter(amb.pool, { ...base, variante: 'miniatura' });
    assert.equal(miniatura.tipo, 'image/webp');
    assert.ok(miniatura.corpo.length > 0);
    await assert.rejects(entrega.obter(amb.pool, { ...base, variante: 'exibicao' }), (erro) => erro.status === 404 && erro.codigo === 'IMAGEM_NAO_ENCONTRADA');
  });

  test('reexecutar a importação é idempotente e a prontidão continua íntegra', async () => {
    const c = await cenario();
    await importarTodos(c);
    const antes = await estado(c);
    for (const p of c.pacotes) {
      const relatorio = await importar(c, p);
      assert.equal(relatorio.resumo.novas, 0);
      assert.equal(relatorio.resumo.arquivosNovos, 0);
    }
    assert.deepEqual(await estado(c), antes, 'a segunda importação não reescreve banco nem arquivos');
    assert.equal((await verificar(c)).estado, 'PROVISIONADA_INTEGRA');
  });

  test('só o primeiro pacote importado: NAO_PROVISIONADA pelo que falta; importar o resto fecha o ciclo', async () => {
    const c = await cenario();
    await importar(c, c.pacotes[0]);
    const parcial = await verificar(c);
    assert.equal(parcial.estado, 'NAO_PROVISIONADA');
    assert.deepEqual(parcial.motivos.map((m) => [m.arquivo, m.faltandoRegistro, m.faltandoArquivo]), [[NOME_B, 1, 2]]);
    await importar(c, c.pacotes[1]);
    assert.equal((await verificar(c)).estado, 'PROVISIONADA_INTEGRA');
  });

  test('um acréscimo ao plano não exige mudança de código: a quantidade vem de cada pacote', async () => {
    const c = await cenario({ pacotes: [{ nome: NOME_B, zip: ZIP_B, quantidade: 1 }] });
    assert.equal((await verificar(c)).estado, 'NAO_PROVISIONADA');
    await importar(c, c.pacotes[0]);
    const relatorio = await verificar(c);
    assert.equal(relatorio.estado, 'PROVISIONADA_INTEGRA');
    assert.equal(relatorio.pacotes[0].imagens, 1);
  });

  test('arquivo corrompido no armazenamento (um byte): INCONSISTENTE, nada é reescrito', async () => {
    const c = await cenario();
    await importarTodos(c);
    const alvo = conteudoDe(c, pacoteA.itens[3], 'mestre');
    const original = fs.readFileSync(alvo);
    fs.writeFileSync(alvo, h.comByteInvertido(original));
    const antes = await estado(c);
    const relatorio = await verificar(c);
    assert.equal(relatorio.estado, 'INCONSISTENTE');
    assert.ok(codigos(relatorio).includes('PACOTE_DIVERGE_DO_BANCO_OU_DOS_ARQUIVOS'));
    assert.ok(codigos(relatorio).includes('ARMAZENAMENTO_INVESTIGAR'));
    assert.deepEqual(relatorio.pacotes[0].divergencias, [{ nome: pacoteA.itens[3].nome, alvo: 'ARQUIVO', motivo: 'CONTEUDO_DIVERGENTE' }]);
    assert.deepEqual(await estado(c), antes);
  });

  test('arquivo ausente de registro existente: INCONSISTENTE (recuperável); restaurar o arquivo devolve PROVISIONADA_INTEGRA', async () => {
    const c = await cenario();
    await importarTodos(c);
    const alvo = conteudoDe(c, pacoteA.itens[7], 'miniatura');
    const bytes = fs.readFileSync(alvo);
    fs.unlinkSync(alvo);
    const relatorio = await verificar(c);
    assert.equal(relatorio.estado, 'INCONSISTENTE');
    assert.ok(codigos(relatorio).includes('ARMAZENAMENTO_RECUPERAVEL'));
    assert.deepEqual(relatorio.pacotes[0].divergencias, [{ nome: pacoteA.itens[7].nome, alvo: 'ARQUIVO', motivo: 'AUSENTE' }]);
    fs.writeFileSync(alvo, bytes, { mode: 0o600 });
    assert.equal((await verificar(c)).estado, 'PROVISIONADA_INTEGRA');
  });

  test('registro com campo de conteúdo diferente do pacote, ou nome em uso por OUTRA imagem: INCONSISTENTE, sem alterar o banco', async () => {
    const c = await cenario();
    await importarTodos(c);
    await amb.q('UPDATE imagens_padrao SET bytes_mestre = bytes_mestre + 1 WHERE sha256 = $1', [pacoteA.itens[0].sha256Padronizado]);
    const antes = await estado(c);
    const relatorio = await verificar(c);
    assert.equal(relatorio.estado, 'INCONSISTENTE');
    assert.ok(relatorio.pacotes[0].divergencias.some((d) => d.alvo === 'REGISTRO' && d.campo === 'bytes_mestre'));
    assert.deepEqual(await estado(c), antes);

    const c2 = await cenario();
    await amb.q(
      'INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ($1, $2, $3, $4, $5, 1024, 1024, 10, 10)',
      [pacoteB.itens[0].nome, 'outra.png', sha('outra imagem'), sha('outra miniatura'), 'PNG'],
    );
    const nomeEmUso = await verificar(c2);
    assert.equal(nomeEmUso.estado, 'INCONSISTENTE');
    assert.ok(nomeEmUso.pacotes[1].divergencias.some((d) => d.alvo === 'REGISTRO' && d.campo === 'nome'));
  });

  test('sobras sem registro (órfãos antigos) não são dano: continua PROVISIONADA_INTEGRA', async () => {
    const c = await cenario();
    await importarTodos(c);
    const orfa = path.join(c.dirImagens, 'padrao', 'e'.repeat(64));
    fs.mkdirSync(orfa, { mode: 0o700 });
    fs.writeFileSync(path.join(orfa, 'mestre.png'), 'sobra', { mode: 0o600 });
    const antigo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(orfa, 'mestre.png'), antigo, antigo);
    fs.utimesSync(orfa, antigo, antigo);
    const relatorio = await verificar(c);
    assert.equal(relatorio.armazenamento.veredito, 'ORFAO');
    assert.equal(relatorio.estado, 'PROVISIONADA_INTEGRA');
  });

  test('banco sem registros e arquivos do pacote recém-gravados: NAO_PROVISIONADA só pelos registros; se os arquivos são antigos (banco errado?), INCONSISTENTE', async () => {
    const c = await cenario();
    await importarTodos(c);
    await amb.q('DELETE FROM imagens_padrao');
    const recentes = await verificar(c);
    assert.equal(recentes.estado, 'NAO_PROVISIONADA');
    assert.deepEqual(recentes.motivos.map((m) => [m.faltandoRegistro, m.faltandoArquivo]), [[30, 0], [1, 0]]);
    const antigo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const envelhecer = (dir) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) envelhecer(completo);
        fs.utimesSync(completo, antigo, antigo);
      }
    };
    envelhecer(c.dirImagens);
    const antigos = await verificar(c);
    assert.equal(antigos.estado, 'INCONSISTENTE');
    assert.ok(antigos.armazenamento.alertas.includes('BANCO_SEM_REGISTROS_COM_ARQUIVOS'), JSON.stringify(antigos.armazenamento));
  });

  test('pacote adulterado ou ausente na pasta: a verificação é RECUSADA (não vira estado) e nada é alterado', async () => {
    const c = await cenario();
    await importarTodos(c);
    const antes = await estado(c);
    const zipB = path.join(c.dirPacotes, NOME_B);
    fs.chmodSync(zipB, 0o600);
    fs.writeFileSync(zipB, h.comByteInvertido(ZIP_B));
    await assert.rejects(verificar(c), (erro) => erro.codigo === 'PACOTE_SHA256_DIVERGENTE');
    fs.unlinkSync(zipB);
    await assert.rejects(verificar(c), (erro) => erro.codigo === 'PACOTE_INDISPONIVEL');
    assert.deepEqual(await estado(c), antes);
  });

  test('plano com hash divergente do aprovado, ou destino de banco diferente do autorizado: recusado antes de qualquer leitura', async () => {
    const c = await cenario();
    await importarTodos(c);
    const espiado = espiarPool(amb.pool);
    await assert.rejects(verificar(c, { pool: espiado.espiao, plano: { ...c.plano, sha256Esperado: 'f'.repeat(64) } }), (erro) => erro.codigo === 'PLANO_SHA256_DIVERGENTE');
    assert.deepEqual(espiado.escritas(), []);
    await assert.rejects(verificar(c, { destino: { banco: 'outro_banco', oid: '1' } }), (erro) => erro.codigo === 'DESTINO_NAO_AUTORIZADO');
    await assert.rejects(verificar(c, { destino: { banco: identidade.banco, oid: '1' } }), (erro) => erro.codigo === 'DESTINO_NAO_AUTORIZADO');
  });

  test('sem o destino autorizado a verificação é recusada, mesmo com a biblioteca íntegra: nenhum banco é aprovado só por DB_*', async () => {
    const c = await cenario();
    await importarTodos(c);
    assert.equal((await verificar(c)).estado, 'PROVISIONADA_INTEGRA', 'o controle: com o destino correto a biblioteca é íntegra');
    const espiado = espiarPool(amb.pool);
    await assert.rejects(verificar(c, { pool: espiado.espiao, destino: null }), (erro) => erro.codigo === 'DESTINO_NAO_AUTORIZADO');
    assert.equal(espiado.registros.length, 0, 'o banco nem foi consultado');
  });

  test('diretório inexistente ou com permissão inadequada, com o serviço real: NAO_PROVISIONADA / INCONSISTENTE, sem tocar o banco', async () => {
    const c = await cenario();
    const ausente = path.join(c.base, 'nao-existe');
    const espiado = espiarPool(amb.pool);
    const semDiretorio = await verificar(c, { pool: espiado.espiao, ambiente: { ...c.ambiente, IMAGENS_ARMAZENAMENTO_DIRETORIO: ausente } });
    assert.equal(semDiretorio.estado, 'NAO_PROVISIONADA');
    assert.equal(fs.existsSync(ausente), false);
    fs.chmodSync(c.dirImagens, 0o755);
    const permissao = await verificar(c, { pool: espiado.espiao });
    assert.equal(permissao.estado, 'INCONSISTENTE');
    assert.deepEqual(codigos(permissao), ['PERMISSAO_ACESSO_DE_OUTROS']);
    assert.equal(fs.statSync(c.dirImagens).mode & 0o777, 0o755, 'a verificação não corrige permissões');
    assert.equal(espiado.registros.length, 0, 'o banco não foi consultado');
  });

  test('biblioteca desabilitada de propósito: DESABILITADA sem nenhuma consulta ao banco, mesmo com a biblioteca vazia', async () => {
    const c = await cenario();
    const espiado = espiarPool(amb.pool);
    const relatorio = await verificar(c, { pool: espiado.espiao, ambiente: { IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' }, plano: null });
    assert.equal(relatorio.estado, 'DESABILITADA');
    assert.equal(espiado.registros.length, 0);
  });

  describe('verificação na inicialização (guarda npm start) com o verificador real', () => {
    const guarda = require('../../src/db/guarda-inicializacao');
    const observadoBom = () => ({
      banco: identidade.banco,
      papel: 'teste',
      dono: 'teste',
      porta: 1,
      migrations: { controleExiste: true, aplicadas: ['000_a'], pendentes: [], semArquivo: [], ordemConfere: true, ultima: '000_a' },
      integridade: { integro: true, relatorio: { alteradas: [], renomeadas: [], ausentes: [], novas: [] } },
      sentinelasAusentes: [],
    });

    /** Cliente pg do schema temporário, emprestado à guarda; o end() dela não encerra a conexão do teste. */
    async function comCliente(trabalho) {
      const cliente = await amb.pool.connect();
      try { return await trabalho(cliente); } finally { cliente.release(); }
    }
    const iniciar = (c, cliente, ambiente = c.ambiente) => prontidao.verificarParaInicializacao({ ambiente, cliente });
    const rodarGuarda = async (c, cliente, politica) => {
      const linhas = [];
      const saida = { log: (...a) => linhas.push(a.join(' ')), error: (...a) => linhas.push(a.join(' ')) };
      const env = {
        GUARDA_BANCOS_PERMITIDOS: identidade.banco, IMAGENS_ARMAZENAMENTO_DIRETORIO: c.dirImagens, ...(politica === undefined ? {} : { IMAGENS_BIBLIOTECA_PADRAO: politica }),
      };
      const codigo = await guarda.executar({
        env, saida, coletar: async () => observadoBom(), criarCliente: () => ({ connect: async () => {}, query: (...a) => cliente.query(...a), end: async () => {} }),
      });
      return { codigo, texto: linhas.join('\n') };
    };

    test('banco e diretório vazios com biblioteca obrigatória: AUSENTE; depois da importação oficial: sem problemas', async () => {
      const c = await cenario();
      await comCliente(async (cliente) => {
        const vazia = await iniciar(c, cliente);
        assert.deepEqual(vazia.problemas.map((p) => p.codigo), ['BIBLIOTECA_IMAGENS_AUSENTE']);
        await importarTodos(c);
        const instalada = await iniciar(c, cliente);
        assert.deepEqual(instalada.problemas, []);
        assert.deepEqual(instalada.resumo, { registrosPadrao: 31, veredito: 'INTEGRO' });
      });
    });

    test('arquivo da biblioteca padrão corrompido ou ausente: INCONSISTENTE; restaurado, volta a ficar sem problemas; nada é alterado', async () => {
      const c = await cenario();
      await importarTodos(c);
      const alvo = conteudoDe(c, pacoteA.itens[2], 'mestre');
      const original = fs.readFileSync(alvo);
      await comCliente(async (cliente) => {
        fs.writeFileSync(alvo, h.comByteInvertido(original));
        const antes = await estado(c);
        const corrompido = await iniciar(c, cliente);
        assert.deepEqual(corrompido.problemas.map((p) => p.codigo), ['BIBLIOTECA_IMAGENS_INCONSISTENTE']);
        assert.deepEqual(await estado(c), antes, 'a verificação de inicialização não altera banco nem disco');
        fs.unlinkSync(alvo);
        assert.deepEqual((await iniciar(c, cliente)).problemas.map((p) => p.codigo), ['BIBLIOTECA_IMAGENS_INCONSISTENTE']);
        fs.writeFileSync(alvo, original, { mode: 0o600 });
        assert.deepEqual((await iniciar(c, cliente)).problemas, []);
      });
    });

    test('LIMITE documentado: biblioteca parcial e íntegra passa na inicialização (não há plano), mas o portão da publicação a reprova', async () => {
      const c = await cenario();
      await importar(c, c.pacotes[1]);
      await comCliente(async (cliente) => {
        assert.deepEqual((await iniciar(c, cliente)).problemas, []);
        assert.equal((await verificar(c)).estado, 'NAO_PROVISIONADA');
      });
    });

    test('uma imagem de EMPRESA sem arquivo (dano só do tenant) não impede a subida; a da biblioteca padrão impediria', async () => {
      const c = await cenario();
      await importarTodos(c);
      await amb.daEmpresa(amb.d.empresaA, amb.d.atorA);
      await comCliente(async (cliente) => {
        const completo = await verificar(c);
        assert.equal(completo.armazenamento.veredito, 'RECUPERAVEL', 'o controle: o verificador completo enxerga o dano da empresa');
        assert.deepEqual((await iniciar(c, cliente)).problemas, []);
      });
    });

    test('pela guarda de ponta a ponta: obrigatoria vazia reprova (3), íntegra aprova (0); sem a variável e desabilitada aprovam com a biblioteca vazia', async () => {
      const c = await cenario();
      await comCliente(async (cliente) => {
        const vazia = await rodarGuarda(c, cliente, 'obrigatoria');
        assert.equal(vazia.codigo, guarda.SAIDAS.REPROVADA);
        assert.match(vazia.texto, /BIBLIOTECA_IMAGENS_AUSENTE/);
        assert.match(vazia.texto, /NÃO foi iniciado/);
        for (const politica of [undefined, '', 'desabilitada']) {
          const compativel = await rodarGuarda(c, cliente, politica);
          assert.equal(compativel.codigo, guarda.SAIDAS.OK, JSON.stringify(politica));
          assert.match(compativel.texto, /GUARDA APROVADA/);
        }
        await importarTodos(c);
        const integra = await rodarGuarda(c, cliente, 'obrigatoria');
        assert.equal(integra.codigo, guarda.SAIDAS.OK, integra.texto);
        assert.match(integra.texto, /biblioteca de imagens padrão: 31 registro\(s\), armazenamento INTEGRO/);
        const alvo = conteudoDe(c, pacoteA.itens[5], 'miniatura');
        fs.writeFileSync(alvo, h.comByteInvertido(fs.readFileSync(alvo)));
        const inconsistente = await rodarGuarda(c, cliente, 'obrigatoria');
        assert.equal(inconsistente.codigo, guarda.SAIDAS.REPROVADA);
        assert.match(inconsistente.texto, /BIBLIOTECA_IMAGENS_INCONSISTENTE/);
      });
    });
  });
});
