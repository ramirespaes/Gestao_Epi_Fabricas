'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const h = require('../helpers/pacote-padrao-ficticio');
const { lerConfiguracao } = require('../../src/config/imagens');
const { CATALOGO_BASE } = require('../../src/utils/classificacao-material');
const {
  KIB, MIB, pacote, ADULTERACOES, MANIFESTOS_INVALIDOS, HOSTIS, FORMATOS, MARCA, DECISAO, APROVADAS, MAPEAMENTOS_INVALIDOS,
} = require('../helpers/cenarios-importacao-padrao');

/**
 * CONTROLES das tabelas de cenários da importação da biblioteca padrão (Unidade 5A-2, RED). Passam hoje: provam, com oráculos DAQUI (independentes
 * do importador), que cada cenário dos contratos é REAL, isto é, tem exatamente o defeito que o nome diz e nenhum outro. Sem isso, um contrato
 * poderia "recusar" por defeito de fixture, ou deixar de recusar um cenário que na verdade é íntegro.
 */

const NOME_DO_MANIFESTO = 'MANIFESTO_SHA256.csv';

/** Oráculo: um achado por arquivo divergente do manifesto que está DENTRO do ZIP. O SHA-256 prevalece; TAMANHO só quando o hash confere. */
function conferirPacote(zip) {
  const porNome = new Map(h.lerZip(zip).entradas.map((e) => [e.nome, e.dados]));
  const linhas = porNome.get(NOME_DO_MANIFESTO).toString('utf8').split('\r\n').slice(1).filter(Boolean).map((l) => l.split(','));
  const achados = [];
  for (const [nome, sOriginal, sPadronizado, sMiniatura, bOriginal, bPadronizado, bMiniatura] of linhas) {
    const base = nome.replace(/\.png$/, '');
    const conferencias = [
      [`01_ORIGINAIS_PRESERVADOS/${nome}`, sOriginal, bOriginal], [`02_PNG_PADRONIZADOS/${nome}`, sPadronizado, bPadronizado], [`03_MINIATURAS_WEBP/${base}.webp`, sMiniatura, bMiniatura],
    ];
    for (const [entrada, hash, bytes] of conferencias) {
      const dados = porNome.get(entrada);
      if (dados === undefined) achados.push({ entrada, motivo: 'AUSENTE' });
      else if (h.sha256(dados) !== hash) achados.push({ entrada, motivo: 'SHA256', esperado: hash, calculado: h.sha256(dados) });
      else if (dados.length !== Number(bytes)) achados.push({ entrada, motivo: 'TAMANHO', esperado: Number(bytes), calculado: dados.length });
    }
  }
  return achados;
}

/** Oráculo: categorias de defeito de um texto de manifesto, pelas regras do formato aprovado. */
function problemasDoManifesto(texto) {
  const problemas = new Set();
  const linhas = texto.split('\r\n');
  if (linhas[0] !== h.CABECALHO_MANIFESTO) problemas.add('CABECALHO');
  const dados = linhas.slice(1);
  if (dados.at(-1) === '') dados.pop();
  if (dados.length !== 30) problemas.add('QUANTIDADE');
  const vistos = new Set();
  for (const linha of dados) {
    const [nome, sO, sP, sM, bO, bP, bM] = linha.split(',');
    if (!/^[^/\\]+\.png$/.test(nome ?? '')) problemas.add('NOME');
    if (vistos.has(nome)) problemas.add('NOME_REPETIDO');
    vistos.add(nome);
    if (![sO, sP, sM].every((x) => /^[0-9a-f]{64}$/.test(x ?? ''))) problemas.add('HASH');
    if (![bO, bP, bM].every((x) => /^[1-9][0-9]*$/.test(x ?? ''))) problemas.add('TAMANHO');
  }
  return [...problemas].sort();
}

/** Oráculo: o nome cru de uma entrada de ZIP seria perigoso se alguém o extraísse. */
function ehCaminhoPerigoso(nomeBytes) {
  const texto = nomeBytes.toString('utf8');
  return nomeBytes.includes(0) || /\p{Cc}/u.test(texto) || texto.includes('\\') || texto.startsWith('/') || /^[A-Za-z]:/.test(texto) || texto.split('/').includes('..');
}

/** Tamanho que o diretório central DECLARA para a entrada (não o que ela realmente descomprime). */
function tamanhoDeclarado(zip, nome) {
  let fim = zip.length - 22;
  while (zip.readUInt32LE(fim) !== 0x06054b50) fim -= 1;
  let o = zip.readUInt32LE(fim + 16);
  for (let n = zip.readUInt16LE(fim + 10); n > 0; n -= 1) {
    const tamanhoNome = zip.readUInt16LE(o + 28);
    if (zip.toString('utf8', o + 46, o + 46 + tamanhoNome) === nome) return zip.readUInt32LE(o + 24);
    o += 46 + tamanhoNome + zip.readUInt16LE(o + 30) + zip.readUInt16LE(o + 32);
  }
  return null;
}

const CHAVES_DO_MAPEAMENTO = ['n', 'nome_base', 'arquivo_padronizado', 'tipo_sugerido', 'confianca', 'observacao', 'decisao', 'aprovado_por', 'data_aprovacao'];
const CABECALHO_DO_MAPEAMENTO = h.CABECALHO_MAPEAMENTO.map((coluna) => `"${coluna}"`).join(';');

/** Oráculo: lê o CSV de mapeamento no formato da proposta (BOM, ponto e vírgula, tudo entre aspas, LF), sem nenhuma regra de negócio. */
function lerMapeamento(texto) {
  const linhas = texto.replace(/^\uFEFF/, '').split('\n');
  if (linhas.at(-1) === '') linhas.pop();
  const campos = (linha) => [...linha.matchAll(/"((?:[^"]|"")*)"(?:;|$)/g)].map((m) => m[1].replace(/""/g, '"'));
  return {
    cabecalhoOk: linhas[0] === CABECALHO_DO_MAPEAMENTO,
    linhas: linhas.slice(1).map((linha) => Object.fromEntries(campos(linha).map((valor, k) => [CHAVES_DO_MAPEAMENTO[k], valor]))),
  };
}

describe('[CTRL-CEN] tabelas de cenários dos contratos da importação padrão', () => {
  test('CTRL-CEN-01 — ADULTERACOES: o oráculo acha EXATAMENTE a entrada adulterada, com o motivo e os valores esperado e calculado que o contrato espera', () => {
    assert.deepEqual(conferirPacote(h.zipDoPacote(pacote)), [], 'o pacote íntegro não tem divergência');
    assert.equal(ADULTERACOES.length, 10);
    for (const [descricao, ajuste, entrada, motivo, esperado, calculado] of ADULTERACOES) {
      assert.deepEqual(conferirPacote(h.zipDoPacote(pacote, ajuste)), [{ entrada, motivo, esperado, calculado }], descricao);
    }
    assert.deepEqual([...new Set(ADULTERACOES.map((a) => a[3]))].sort(), ['SHA256', 'TAMANHO']);
    const papeis = new Set(ADULTERACOES.map((a) => a[2].split('/')[0]));
    assert.deepEqual([...papeis].sort(), ['01_ORIGINAIS_PRESERVADOS', '02_PNG_PADRONIZADOS', '03_MINIATURAS_WEBP'], 'os três papéis de arquivo são adulterados em algum cenário');
  });

  test('CTRL-CEN-02 — MANIFESTOS_INVALIDOS: cada manifesto tem a categoria de defeito pretendida pelo oráculo; o manifesto legítimo não tem nenhuma', () => {
    assert.deepEqual(problemasDoManifesto(pacote.manifesto), []);
    const esperado = [
      ['CABECALHO'], ['QUANTIDADE'], ['QUANTIDADE'], ['NOME_REPETIDO'], ['HASH'], ['HASH'], ['TAMANHO'], ['TAMANHO'], ['NOME'], ['NOME'], ['CABECALHO', 'QUANTIDADE'],
    ];
    assert.equal(MANIFESTOS_INVALIDOS.length, esperado.length);
    MANIFESTOS_INVALIDOS.forEach(([descricao, manifesto], k) => {
      assert.deepEqual(problemasDoManifesto(manifesto), esperado[k], descricao);
      assert.notEqual(manifesto, pacote.manifesto, descricao);
    });
  });

  test('CTRL-CEN-03 — HOSTIS: cada ZIP tem a propriedade estrutural que o motivo afirma (e o caminho perigoso só existe na entrada marcada)', () => {
    const configuracao = lerConfiguracao({});
    const previstos = new Set(h.entradasDoPacote(pacote).map((e) => e.nome));
    for (const cenario of HOSTIS) {
      const zip = cenario.construir();
      const descricao = cenario.descricao;
      switch (cenario.motivo) {
        case 'CAMINHO_PERIGOSO': {
          const marcadas = h.lerZip(zip).entradas.filter((e) => e.nomeBytes.includes(Buffer.from(MARCA)));
          assert.equal(marcadas.length, 1, descricao);
          assert.equal(ehCaminhoPerigoso(marcadas[0].nomeBytes), true, descricao);
          break;
        }
        case 'LINK_SIMBOLICO':
          assert.equal(h.lerZip(zip).entradas.filter((e) => (e.modoUnix & 0o170000) === 0o120000).length, 1, descricao);
          break;
        case 'NOME_DUPLICADO': {
          const nomes = h.lerZip(zip).entradas.map((e) => e.nome);
          assert.equal(nomes.length - new Set(nomes).size, 1, descricao);
          break;
        }
        case 'ENTRADA_NAO_PREVISTA': {
          const extras = h.lerZip(zip).entradas.filter((e) => !previstos.has(e.nome));
          assert.equal(extras.length, 1, descricao);
          assert.equal(ehCaminhoPerigoso(extras[0].nomeBytes), false, `${descricao}: a entrada é só imprevista, não perigosa`);
          break;
        }
        case 'ENTRADAS_DEMAIS':
          assert.ok(h.lerZip(zip).entradas.length > cenario.limites.maxEntradas, descricao);
          break;
        case 'ZIP_CORROMPIDO':
          assert.throws(() => h.lerZip(zip), descricao);
          break;
        case 'TAMANHO_EXCEDIDO':
        case null: {
          const entradas = h.lerZip(zip).entradas;
          const limiteArquivo = cenario.limites?.maxBytesPorArquivo ?? configuracao.arquivoPadraoMaxBytes;
          const grandes = entradas.filter((e) => e.dados.length > limiteArquivo);
          if (cenario.limites?.maxBytesTotal !== undefined) {
            assert.ok(entradas.reduce((soma, e) => soma + e.dados.length, 0) > cenario.limites.maxBytesTotal, descricao);
            assert.equal(grandes.length, 0, `${descricao}: nenhum arquivo isolado passa do limite por arquivo`);
          } else if (descricao.startsWith('limite por arquivo reduzido')) {
            assert.ok(grandes.length > 1, `${descricao}: várias entradas legítimas passam do limite reduzido`);
          } else {
            assert.equal(grandes.length, 1, `${descricao}: exatamente UMA entrada passa do limite por arquivo`);
          }
          break;
        }
        default:
          assert.fail(`motivo sem verificação no controle: ${cenario.motivo}`);
      }
    }
    for (const cenario of HOSTIS.filter((x) => x.motivo === 'CAMINHO_PERIGOSO')) {
      const semMarca = h.lerZip(cenario.construir()).entradas.filter((e) => !e.nomeBytes.includes(Buffer.from(MARCA)));
      assert.ok(semMarca.every((e) => !ehCaminhoPerigoso(e.nomeBytes)), `${cenario.descricao}: as 92 entradas legítimas não são perigosas`);
    }
  });

  test('CTRL-CEN-04 — HOSTIS (limites): a bomba cabe em poucos KiB comprimida e passa de 1 MiB expandida; o tamanho declarado que mente diz 10 e entrega 2 MiB; o pacote legítimo cabe nos limites padrão', () => {
    const bomba = HOSTIS.find((x) => x.descricao.startsWith('bomba'));
    assert.ok(zlib.deflateRawSync(Buffer.alloc(3 * MIB), { level: 6 }).length < 8 * KIB);
    const dentro = h.lerZip(bomba.construir()).entradas.find((e) => e.nome.endsWith('/bomba.png'));
    assert.equal(dentro.dados.length, 3 * MIB);
    assert.ok(dentro.dados.length > bomba.limites.maxBytesPorArquivo);

    const mente = HOSTIS.find((x) => x.descricao.startsWith('tamanho declarado'));
    const zip = mente.construir();
    assert.equal(tamanhoDeclarado(zip, '02_PNG_PADRONIZADOS/mente.png'), 10);
    assert.equal(h.lerZip(zip).entradas.find((e) => e.nome.endsWith('/mente.png')).dados.length, 2 * MIB);
    assert.ok(2 * MIB > mente.limites.maxBytesPorArquivo && 10 < mente.limites.maxBytesPorArquivo, 'só a medição do que é descomprimido pega este caso');

    const { arquivoPadraoMaxBytes } = lerConfiguracao({});
    const legitimas = h.lerZip(h.zipDoPacote(pacote)).entradas;
    assert.ok(legitimas.every((e) => e.dados.length <= arquivoPadraoMaxBytes), 'o pacote legítimo não passa do limite por arquivo');
    assert.ok(legitimas.every((e) => e.dados.length <= 1 * MIB), 'e nenhuma entrada legítima passa de 1 MiB (a bomba é a única, no cenário dela)');
  });

  test('CTRL-CEN-05 — FORMATOS: o hash do arquivo trocado é COERENTE com o manifesto e o arquivo tem exatamente o defeito do motivo, nenhum outro; o legítimo não tem defeito algum', () => {
    const PROIBIDOS_WEBP = ['EXIF', 'XMP ', 'ICCP'];
    const defeitosDePng = (bytes) => {
      const a = h.analisarPng(bytes);
      if (!a.assinaturaOk) return ['ASSINATURA'];
      const defeitos = [];
      if (a.blocos.some((t) => !['IHDR', 'IDAT', 'IEND'].includes(t))) defeitos.push('METADADOS');
      if (!(a.largura === 1024 && a.altura === 1024)) defeitos.push('DIMENSOES');
      if (a.bytesAposFim > 0 || a.blocos.at(-1) !== 'IEND') defeitos.push('ESTRUTURA');
      return defeitos;
    };
    const defeitosDeWebp = (bytes) => {
      const a = h.analisarWebp(bytes);
      if (a.riff !== 'RIFF' || a.formato !== 'WEBP') return ['ASSINATURA'];
      const defeitos = [];
      if (a.blocos.some((t) => PROIBIDOS_WEBP.includes(t))) defeitos.push('METADADOS');
      if (a.blocos.includes('ANIM')) defeitos.push('ANIMADA');
      if (!(a.vp8x.largura === 320 && a.vp8x.altura === 320 && a.vp8.largura === 320 && a.vp8.altura === 320)) defeitos.push('DIMENSOES');
      if (!a.tamanhoRiffConfere) defeitos.push('ESTRUTURA');
      return defeitos;
    };
    const item = pacote.itens[9];
    assert.deepEqual(defeitosDePng(item.padronizado), []);
    assert.deepEqual(defeitosDeWebp(item.miniatura), []);
    assert.equal(FORMATOS.length, 17);
    for (const [descricao, substitutos, entrada, motivo] of FORMATOS) {
      const zip = h.zipDoPacote(h.pacoteComItem(pacote, 9, substitutos));
      assert.deepEqual(conferirPacote(zip), [], `${descricao}: o hash e o tamanho conferem com o manifesto regerado`);
      const papel = entrada.startsWith('02_') ? 'PNG' : 'WEBP';
      const bytes = papel === 'PNG' ? substitutos.padronizado : substitutos.miniatura;
      assert.ok(bytes !== undefined, descricao);
      assert.deepEqual(papel === 'PNG' ? defeitosDePng(bytes) : defeitosDeWebp(bytes), [motivo], descricao);
      assert.deepEqual(Object.keys(substitutos).length, 1, `${descricao}: só um arquivo é trocado`);
    }
  });

  test('CTRL-CEN-06 — cobertura: as tabelas exercitam todos os códigos e motivos que o contrato nomeia, e os nomes dos cenários são únicos', () => {
    const motivosHostis = new Set(HOSTIS.map((x) => x.motivo));
    for (const motivo of ['CAMINHO_PERIGOSO', 'LINK_SIMBOLICO', 'TAMANHO_EXCEDIDO', 'ENTRADAS_DEMAIS', 'NOME_DUPLICADO', 'ENTRADA_NAO_PREVISTA', 'ZIP_CORROMPIDO']) assert.ok(motivosHostis.has(motivo), motivo);
    const motivosFormato = new Set(FORMATOS.map((x) => x[3]));
    for (const motivo of ['ASSINATURA', 'ESTRUTURA', 'DIMENSOES', 'METADADOS', 'ANIMADA']) assert.ok(motivosFormato.has(motivo), motivo);
    for (const [nome, lista] of [['ADULTERACOES', ADULTERACOES.map((x) => x[0])], ['MANIFESTOS_INVALIDOS', MANIFESTOS_INVALIDOS.map((x) => x[0])], ['HOSTIS', HOSTIS.map((x) => x.descricao)], ['FORMATOS', FORMATOS.map((x) => x[0])]]) {
      assert.equal(new Set(lista).size, lista.length, `${nome}: descrições repetidas`);
    }
  });

  test('CTRL-CEN-07 — MAPEAMENTOS_INVALIDOS: o oráculo lê o CSV e vê o defeito prometido em cada cenário (a proposta pura não o tem, e no máximo duas linhas diferem dela)', () => {
    const base = lerMapeamento(h.mapeamentoCsv(h.linhasDeMapeamento(pacote)));
    assert.equal(base.cabecalhoOk, true);
    assert.equal(base.linhas.length, 30);
    const contexto = (lido) => ({ nomes: new Set(pacote.itens.map((i) => i.nome)), tiposBase: new Set(CATALOGO_BASE.map((t) => t.nome)), cabecalhoOk: lido.cabecalhoOk });
    assert.equal(MAPEAMENTOS_INVALIDOS.length, 14);
    for (const [descricao, alterar, , verificar] of MAPEAMENTOS_INVALIDOS) {
      assert.equal(verificar(base.linhas, contexto(base)), false, `${descricao}: a proposta pura não tem o defeito`);
      const resultado = alterar(h.linhasDeMapeamento(pacote));
      const lido = lerMapeamento(typeof resultado === 'string' ? resultado : h.mapeamentoCsv(resultado));
      assert.equal(lido.linhas.length, 30, descricao);
      assert.equal(verificar(lido.linhas, contexto(lido)), true, `${descricao}: o defeito prometido existe no arquivo`);
      const diferentes = lido.linhas.filter((linha, k) => JSON.stringify(linha) !== JSON.stringify(base.linhas[k])).length;
      assert.ok(diferentes <= 2, `${descricao}: no máximo duas linhas diferem da proposta (${diferentes})`);
    }
  });

  test('CTRL-CEN-08 — a proposta do fixture tem as propriedades que PAD-04 usa: 26 ALTA, 3 MÉDIA e 1 SEM, todo tipo sugerido (menos o SEM) do catálogo BASE, as aprovações legítimas dos testes bem formadas e a data de aprovação real', () => {
    const base = lerMapeamento(h.mapeamentoCsv(h.linhasDeMapeamento(pacote)));
    const porConfianca = {};
    for (const linha of base.linhas) porConfianca[linha.confianca] = (porConfianca[linha.confianca] ?? 0) + 1;
    assert.deepEqual(porConfianca, { ALTA: 26, 'MÉDIA': 3, SEM: 1 });
    const tiposBase = new Set(CATALOGO_BASE.map((t) => t.nome));
    for (const linha of base.linhas.filter((x) => x.confianca !== 'SEM')) assert.ok(tiposBase.has(linha.tipo_sugerido), linha.nome_base);
    assert.equal(base.linhas.find((linha) => linha.confianca === 'SEM').nome_base, 'Camiseta Azul');
    assert.deepEqual(base.linhas.filter((linha) => linha.confianca === 'MÉDIA').map((linha) => linha.nome_base).sort(), ['Botina de Segurança - Couro', 'Calça de Segurança - Eletricista', 'Vestimenta para Proteção do Tronco - Camisa de Eletricista']);
    assert.ok(base.linhas.every((linha) => linha.decisao === '' && linha.aprovado_por === '' && linha.data_aprovacao === ''), 'a proposta pura não tem nenhuma decisão');
    const aprovadas = lerMapeamento(h.mapeamentoCsv(h.linhasDeMapeamento(pacote, APROVADAS))).linhas.filter((linha) => linha.decisao === 'APROVAR');
    assert.deepEqual(aprovadas.map((l) => [l.nome_base, l.tipo_sugerido, l.confianca, l.aprovado_por, l.data_aprovacao]).sort(), [
      ['Botina de Segurança - Couro', 'Sapato de Segurança', 'MÉDIA', 'Ramires', '2026-10-17'], ['Luva de Segurança', 'Luva de Segurança', 'ALTA', 'Ramires', '2026-10-17'],
    ].sort());
    const [ano, mes, dia] = DECISAO.data.split('-').map(Number);
    assert.equal(new Date(Date.UTC(ano, mes - 1, dia)).getUTCMonth(), mes - 1, 'a data de aprovação dos testes é uma data real');
  });
});
