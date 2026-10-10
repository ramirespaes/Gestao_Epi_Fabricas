'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const EpiHttp = require('../js/api-http');
const F = require('../js/funcionarios');
const readXlsxFile = require('../vendor/read-excel-file-9.3.10.min.js');

/**
 * Bloco 9, Etapa C, Parte C4 — Funcionários (importação e histórico).
 * Módulo frontend/js/funcionarios.js, sem navegador. Planilhas .xlsx
 * reais são geradas aqui a partir de XML mínimo (zlib do Node, sem
 * dependência nova) e lidas pela cópia local de read-excel-file 9.3.10.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
let chamadasGhes;
// GHEs ativos que a rota de opções do seletor devolve; null = lista indisponível (403), o que mantém a validação local dos testes antigos.
let ghesDaEmpresa = null;
function servidor(...respostas) {
  chamadas = [];
  chamadasGhes = [];
  let i = 0;
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      if (new URL(url).pathname === '/api/funcionarios/importacao/ghes') {
        chamadasGhes.push({ metodo: opcoes.method });
        return ghesDaEmpresa === null ? resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }) : resposta(200, { status: 'ok', ghes: ghesDaEmpresa });
      }
      chamadas.push({ metodo: opcoes.method, caminho: new URL(url).pathname + new URL(url).search, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const r = typeof respostas[0] === 'function' ? respostas[0](chamadas[chamadas.length - 1]) : respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => { ghesDaEmpresa = null; servidor(resposta(200, { status: 'ok' })); });

/** CPF válido a partir de um número (dígitos verificadores calculados). */
function gerarCpf(n) {
  const base = String(100000000 + n).slice(-9).split('').map(Number);
  const dv = (d) => { const r = (d.reduce((s, x, i) => s + x * (d.length + 1 - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

// ── gerador de .xlsx mínimo (ZIP "deflate" + XML de planilha) ──
function zip(arquivos) {
  const locais = []; const centrais = []; let deslocamento = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const dados = Buffer.from(conteudo, 'utf8');
    const comprimido = zlib.deflateRawSync(dados);
    const crc = zlib.crc32(dados);
    const nomeB = Buffer.from(nome, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(nomeB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comprimido.length, 20); central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeB.length, 28); central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nomeB, comprimido); centrais.push(central, nomeB);
    deslocamento += 30 + nomeB.length + comprimido.length;
  }
  const c = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(centrais.length / 2, 8); fim.writeUInt16LE(centrais.length / 2, 10);
  fim.writeUInt32LE(c.length, 12); fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, c, fim]);
}
const xmlEscapar = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const celula = (ref, v) => (v === null || v === undefined ? ''
  : typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>`
    : v && v.data !== undefined ? `<c r="${ref}" s="1"><v>${v.data}</v></c>`
      // fórmula com resultado em texto: o Excel grava t="str" e o último valor calculado em <v>
      : v && v.formula !== undefined ? `<c r="${ref}" t="str"><f>${xmlEscapar(v.formula)}</f><v>${xmlEscapar(v.valor)}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscapar(v)}</t></is></c>`);
const coluna = (j) => String.fromCharCode(65 + j);
const folha = (linhas) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
  linhas.map((l, i) => `<row r="${i + 1}">${l.map((v, j) => celula(coluna(j) + (i + 1), v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
function xlsx(abas) {
  const nomes = Object.keys(abas);
  const arquivos = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${nomes.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nomes.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
  };
  nomes.forEach((n, i) => { arquivos[`xl/worksheets/sheet${i + 1}.xml`] = folha(abas[n]); });
  return zip(arquivos);
}
// 12G-9: a coluna GHE (nome exato do GHE da empresa) é obrigatória.
const CABECALHO = ['Nome', 'Setor', 'Telefone', 'CPF', 'Matrícula', 'Nascimento', 'Contratação', 'Cargo', 'Situação', 'GHE'];
const CABECALHO_SEM_GHE = CABECALHO.slice(0, 9);
const GHE_PLANILHA = 'GHE Produção';
/** Número serial do Excel para uma data AAAA-MM-DD (época 1900). */
const serial = (iso) => (Date.UTC(...iso.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) / 86400000) + 25569;

async function lerXlsx(abas) {
  const r = await F.arquivo.lerXlsx(new Blob([xlsx(abas)]), readXlsxFile);
  return r;
}

describe('cópia local da biblioteca e declaração', () => {
  test('vendor/read-excel-file-9.3.10.min.js é exatamente o arquivo publicado (SHA-256 registrado); procedência e licença presentes', () => {
    const conteudo = fs.readFileSync(path.join(RAIZ, 'vendor/read-excel-file-9.3.10.min.js'));
    assert.equal(crypto.createHash('sha256').update(conteudo).digest('hex'), 'eb774939e3cabf764483ba7d16515d058186eb0587b67de81d40b9aa442f30fa');
    assert.match(ler('vendor/README.md'), /eb774939e3cabf764483ba7d16515d058186eb0587b67de81d40b9aa442f30fa/);
    assert.match(ler('vendor/LICENSE-read-excel-file.txt'), /MIT License/);
  });

  test('texto da declaração é idêntico ao do servidor (mesma versão, mesmo SHA-256); não é consentimento', () => {
    // eslint-disable-next-line global-require
    const servidorDeclaracao = require('../../backend/src/services/declaracao-lgpd');
    assert.equal(F.DECLARACAO.versao, servidorDeclaracao.VERSAO_ATUAL);
    assert.equal(F.DECLARACAO.texto, servidorDeclaracao.textoDaVersao(F.DECLARACAO.versao));
    assert.doesNotMatch(F.DECLARACAO.texto, /consent/i);
  });
});

describe('arquivo: formato, tamanho e assinatura', () => {
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const texto = new TextEncoder().encode('Nome;CPF\n');
  test('aceita .xlsx com assinatura ZIP e .csv em texto; recusa .xls antigo, extensão desconhecida, vazio, acima de 10 MB e conteúdo que não bate com a extensão', () => {
    assert.deepEqual(F.arquivo.verificar({ nome: 'Funcionários.XLSX', tamanho: 5000, inicio: zipBytes }), { ok: true, formato: 'xlsx' });
    assert.deepEqual(F.arquivo.verificar({ nome: 'a.csv', tamanho: 9, inicio: texto }), { ok: true, formato: 'csv' });
    const codigo = (a) => F.arquivo.verificar(a).codigo;
    assert.equal(codigo({ nome: 'a.xls', tamanho: 10, inicio: zipBytes }), 'FORMATO_XLS');
    assert.equal(codigo({ nome: 'a.pdf', tamanho: 10, inicio: zipBytes }), 'FORMATO_INVALIDO');
    assert.equal(codigo({ nome: 'a.csv', tamanho: 0, inicio: new Uint8Array() }), 'ARQUIVO_VAZIO');
    assert.equal(codigo({ nome: 'a.xlsx', tamanho: 10 * 1024 * 1024 + 1, inicio: zipBytes }), 'ARQUIVO_GRANDE');
    assert.equal(codigo({ nome: 'a.xlsx', tamanho: 9, inicio: texto }), 'CONTEUDO_INCOMPATIVEL', 'xlsx sem assinatura ZIP');
    assert.equal(codigo({ nome: 'a.csv', tamanho: 8, inicio: zipBytes }), 'CONTEUDO_INCOMPATIVEL', 'csv com bytes binários');
    for (const c of ['FORMATO_XLS', 'FORMATO_INVALIDO', 'ARQUIVO_VAZIO', 'ARQUIVO_GRANDE', 'CONTEUDO_INCOMPATIVEL', 'LINHAS_EXCEDIDAS', 'COLUNAS_AUSENTES', 'SEM_DADOS', 'XLSX_ILEGIVEL']) {
      assert.ok(F.mensagens.erroArquivo({ codigo: c, colunas: ['Contratação'], total: 1001 }).length > 10, c);
    }
    assert.match(F.mensagens.erroArquivo({ codigo: 'FORMATO_XLS' }), /salve como \.xlsx/i);
  });
});

describe('CSV: leitura robusta e codificação', () => {
  test('RFC 4180: aspas, aspas escapadas, separador dentro de aspas, CRLF, BOM; separador ; ou , decidido pelo cabeçalho', () => {
    assert.deepEqual(F.arquivo.lerCsv('\uFEFFNome;Setor\r\n"Silva; João";"Produção ""A"""\r\nAna;TI\r\n'), [['Nome', 'Setor'], ['Silva; João', 'Produção "A"'], ['Ana', 'TI']]);
    assert.deepEqual(F.arquivo.lerCsv('Nome,Setor\n"Silva, João",TI\n'), [['Nome', 'Setor'], ['Silva, João', 'TI']]);
    assert.deepEqual(F.arquivo.lerCsv('Nome;Setor\n"linha\nquebrada";TI'), [['Nome', 'Setor'], ['linha\nquebrada', 'TI']]);
  });

  test('UTF-8 estrito; se inválido, Windows-1252 (CSV salvo pelo Excel em português), com a codificação informada', () => {
    const utf8 = F.arquivo.decodificarCsv(new TextEncoder().encode('\uFEFFJoão;Produção'));
    assert.deepEqual(utf8, { texto: 'João;Produção', codificacao: 'utf-8' });
    const w1252 = F.arquivo.decodificarCsv(new Uint8Array([0x4a, 0x6f, 0xe3, 0x6f])); // "João" em Windows-1252
    assert.deepEqual(w1252, { texto: 'João', codificacao: 'windows-1252' });
  });
});

describe('planilha: cabeçalho, conversão e validação por linha (sem inventar dados)', () => {
  const linhaCsv = (extra = {}) => {
    const v = { nome: 'João Pereira', setor: 'Produção', telefone: '(47) 99999-0001', cpf: '529.982.247-25', matricula: 'MAT-000001', nascimento: '15/03/1990', contratacao: '01/06/2020', cargo: 'Operador', situacao: 'Ativo', ghe: GHE_PLANILHA, ...extra };
    return [v.nome, v.setor, v.telefone, v.cpf, v.matricula, v.nascimento, v.contratacao, v.cargo, v.situacao, v.ghe];
  };

  test('cabeçalhos por sinônimos, sem diferença de caixa; colunas desconhecidas ignoradas; chaves perigosas nunca viram propriedade', () => {
    const r = F.planilha.interpretar([['NOME', 'Departamento', 'Celular', 'cpf', 'Registro', 'Data de nascimento', 'Admissão', 'Função', 'Situação', 'Grupo Homogêneo', '__proto__', 'constructor'], linhaCsv().concat(['x', 'y'])]);
    assert.equal(r.ok, true, JSON.stringify(r));
    const l = r.linhas[0];
    assert.deepEqual(l.dados, { nome: 'João Pereira', setor: 'Produção', telefone: '(47) 99999-0001', cpf: '52998224725', matricula: 'MAT-000001', dataNascimento: '1990-03-15', dataAdmissao: '2020-06-01', funcao: 'Operador', ghe: GHE_PLANILHA, situacao: 'ativo' });
    assert.equal(l.exibicao.ghe, GHE_PLANILHA);
    assert.deepEqual([l.linha, l.erros, l.avisos], [2, [], []]);
    assert.equal(Object.getPrototypeOf(l.dados), Object.prototype, 'nenhuma poluição de protótipo');
    assert.equal({}.x, undefined);
    for (const sinonimo of ['GHE', 'ghe', 'Grupo homogeneo', 'Grupo Homogêneo de Exposição', 'G.H.E.']) {
      assert.equal(F.planilha.interpretar([CABECALHO_SEM_GHE.concat([sinonimo]), linhaCsv()]).ok, true, sinonimo);
    }
  });

  test('coluna obrigatória ausente, sem dados ou acima de 1.000 linhas: erro do arquivo', () => {
    assert.deepEqual(F.planilha.interpretar([['Nome', 'Setor', 'CPF', 'Matrícula', 'Cargo'], ['a', 'b', 'c', 'd', 'e']]), { ok: false, codigo: 'COLUNAS_AUSENTES', colunas: ['Dt.Admissão', 'Situação', 'Nome GHE'] });
    // CASO A (12G-9): planilha sem a coluna GHE é erro estrutural — nenhuma linha é interpretada nem enviada.
    assert.deepEqual(F.planilha.interpretar([CABECALHO_SEM_GHE, linhaCsv().slice(0, 9)]), { ok: false, codigo: 'COLUNAS_AUSENTES', colunas: ['Nome GHE'] });
    assert.match(F.mensagens.erroArquivo({ ok: false, codigo: 'COLUNAS_AUSENTES', colunas: ['Nome GHE'] }), /GHE/);
    assert.deepEqual(F.planilha.interpretar([CABECALHO, ['', '', '', '', '', '', '', '', '', '']]), { ok: false, codigo: 'SEM_DADOS' });
    const mil1 = [CABECALHO].concat(Array.from({ length: 1001 }, (_, i) => linhaCsv({ cpf: gerarCpf(i), matricula: `M${i}` })));
    assert.deepEqual(F.planilha.interpretar(mil1), { ok: false, codigo: 'LINHAS_EXCEDIDAS', total: 1001 });
    const mil = [CABECALHO].concat(Array.from({ length: 1000 }, (_, i) => linhaCsv({ cpf: gerarCpf(i), matricula: `M${i}` })));
    assert.equal(F.planilha.interpretar(mil).ok, true);
  });

  test('linha em branco é ignorada, mas a numeração continua a da planilha', () => {
    const r = F.planilha.interpretar([CABECALHO, linhaCsv(), ['', '', '', '', '', '', '', '', '', ''], linhaCsv({ cpf: gerarCpf(9), matricula: 'M9' })]);
    assert.deepEqual(r.linhas.map((l) => l.linha), [2, 4]);
  });

  test('12G-9 GHE por linha: vazio (CASO B), só espaços, acima de 150 caracteres ou com caractere de controle é erro só daquela linha; nunca é completado nem adivinhado', () => {
    const r = F.planilha.interpretar([CABECALHO, linhaCsv(), linhaCsv({ ghe: '', cpf: gerarCpf(2), matricula: 'M2' }), linhaCsv({ ghe: '   ', cpf: gerarCpf(3), matricula: 'M3' }),
      linhaCsv({ ghe: 'G'.repeat(151), cpf: gerarCpf(4), matricula: 'M4' }), linhaCsv({ ghe: 'GHE\u0007', cpf: gerarCpf(5), matricula: 'M5' }), linhaCsv({ ghe: '  GHE Produção ', cpf: gerarCpf(6), matricula: 'M6' })]);
    assert.deepEqual(r.linhas.map((l) => l.erros.map((e) => e.campo)), [[], ['ghe'], ['ghe'], ['ghe'], ['ghe'], []]);
    assert.match(r.linhas[1].erros[0].mensagem, /Nome GHE não informado/);
    assert.deepEqual([r.linhas[1].dados.ghe, r.linhas[5].dados.ghe], ['', 'GHE Produção'], 'aparado nas pontas; vazio continua vazio');
    assert.deepEqual([r.validas, r.comErro], [2, 4]);
    assert.equal(F.LIMITES.ghe, 150);
  });

  test('mesmas regras do servidor: obrigatórios, CPF com DV, limites, datas de calendário, admissão ≥ 1900 e posterior ao nascimento', () => {
    const erros = (extra) => F.planilha.interpretar([CABECALHO, linhaCsv(extra)]).linhas[0].erros.map((e) => e.campo).sort();
    assert.deepEqual(erros({}), []);
    assert.deepEqual(erros({ nome: '' }), ['nome']);
    assert.deepEqual(erros({ setor: '' }), ['setor']);
    assert.deepEqual(erros({ cargo: '' }), ['funcao']);
    assert.deepEqual(erros({ matricula: '' }), [], 'matrícula é opcional');
    assert.deepEqual(erros({ matricula: 'M'.repeat(31) }), ['matricula']);
    assert.deepEqual(erros({ cpf: '529.982.247-26' }), ['cpf']);
    assert.deepEqual(erros({ cpf: '111.111.111-11' }), ['cpf']);
    assert.deepEqual(erros({ cpf: '5299822472' }), ['cpf'], 'texto com 10 dígitos: nunca completado');
    assert.deepEqual(erros({ nome: 'x'.repeat(151) }), ['nome']);
    assert.deepEqual(erros({ telefone: '1'.repeat(21) }), ['telefone']);
    assert.deepEqual(erros({ contratacao: '' }), ['dataAdmissao']);
    assert.deepEqual(erros({ contratacao: '31/02/2020' }), ['dataAdmissao']);
    assert.deepEqual(erros({ contratacao: '01/01/1899' }), ['dataAdmissao']);
    assert.deepEqual(erros({ contratacao: '15/03/1990' }), ['dataAdmissao'], 'mesmo dia do nascimento');
    assert.deepEqual(erros({ nascimento: '30/02/1990' }), ['dataNascimento']);
    assert.deepEqual(erros({ nascimento: '', telefone: '' }), [], 'nascimento e telefone opcionais');
    assert.deepEqual(erros({ contratacao: '2020-06-01' }), [], 'AAAA-MM-DD também aceito');
    assert.deepEqual(erros({ contratacao: '01/06/2099' }), [], 'admissão futura permitida');
  });

  test('duplicados dentro da planilha: a segunda ocorrência de CPF ou matrícula é erro que aponta a linha anterior', () => {
    const r = F.planilha.interpretar([CABECALHO, linhaCsv(), linhaCsv({ matricula: 'OUTRA' }), linhaCsv({ cpf: gerarCpf(5) })]);
    assert.deepEqual(r.linhas.map((l) => l.erros.map((e) => `${e.campo}:${e.mensagem}`)), [
      [], ['cpf:CPF repetido na planilha (linha 2).'], ['matricula:Matrícula repetida na planilha (linha 2).'],
    ]);
    assert.deepEqual([r.validas, r.comErro], [1, 2]);
  });

  test('prévia exibe os valores lidos, escapados, inclusive o GHE; nada do arquivo vira HTML', () => {
    const r = F.planilha.interpretar([CABECALHO, linhaCsv({ nome: '<img src=x onerror=alert(1)>', ghe: '<script>alert(2)</script>' })]);
    const html = F.render.previa(r.linhas);
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script&gt;alert\(2\)/);
    assert.equal((html.match(/<td/g) || []).length, 9, '#, nome, setor, CPF, admissão, cargo, GHE, situação e status');
    assert.match(F.render.previa(F.planilha.interpretar([CABECALHO, linhaCsv()]).linhas), /<td>Operador<\/td><td>GHE Produção<\/td><td>Ativo<\/td><td><span/, 'GHE e situação depois do cargo, antes do status');
  });

  test('prévia mostra o CPF minimizado (***.***.***-XX); o valor enviado ao servidor continua completo', () => {
    const r = F.planilha.interpretar([CABECALHO, linhaCsv(), linhaCsv({ cpf: '123', matricula: 'MAT-000002' })]);
    const html = F.render.previa(r.linhas);
    assert.match(html, /<td>\*\*\*\.\*\*\*\.\*\*\*-25<\/td>/);
    assert.doesNotMatch(html, /529\.?982\.?247/);
    assert.doesNotMatch(html, /<td>123<\/td>/, 'nem o valor inválido aparece');
    assert.equal(r.linhas[0].dados.cpf, '52998224725');
    assert.equal(F.utilitarios.mascararCpf('52998224725'), '***.***.***-25');
    assert.equal(F.utilitarios.mascararCpf(''), '');
  });
});

describe('Excel (.xlsx) real pela cópia local da biblioteca', () => {
  test('lê a primeira aba; datas do Excel em UTC sem deslocamento; fórmula usa o valor salvo; aba extra ignorada', async () => {
    const r = await lerXlsx({
      Funcionarios: [CABECALHO, ['João Pereira', 'Produção', '(47) 99999-0001', '529.982.247-25', 'MAT-1', { data: serial('1990-10-15') }, { data: serial('2026-10-15') }, { formula: 'CONCAT("Oper","ador")', valor: 'Operador' }, 'Ativo', GHE_PLANILHA]],
      Outra: [['qualquer coisa']],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const i = F.planilha.interpretar(r.linhas);
    assert.deepEqual([i.linhas[0].dados.dataNascimento, i.linhas[0].dados.dataAdmissao], ['1990-10-15', '2026-10-15']);
    assert.equal(i.linhas[0].erros.length, 0, JSON.stringify(i.linhas[0].erros));
  });

  test('CPF numérico sem os zeros à esquerda: recomposto só quando o resultado passa no DV, com aviso; senão, erro — nunca inventado', async () => {
    const comZeroInicial = '01234567890'; // CPF válido que começa com zero (DV 9 e 0)
    assert.equal(F.utilitarios.cpfValido(comZeroInicial), true);
    const r = await lerXlsx({ F: [CABECALHO,
      ['A', 'S', null, Number(comZeroInicial), 'M1', null, { data: serial('2020-06-01') }, 'C', 'Ativo', 'G'],
      ['B', 'S', null, 1234567, 'M2', null, { data: serial('2020-06-01') }, 'C', 'Ativo', 'G'],
    ] });
    const linhas = F.planilha.interpretar(r.linhas).linhas;
    assert.equal(linhas[0].dados.cpf, comZeroInicial);
    assert.deepEqual(linhas[0].avisos.map((a) => a.campo), ['cpf'], 'recomposição sempre sinalizada na prévia');
    assert.deepEqual(linhas[0].erros, []);
    assert.deepEqual(linhas[1].erros.map((e) => e.campo), ['cpf'], '7 dígitos: completar daria CPF inválido → erro');
    assert.match(linhas[1].erros[0].mensagem, /texto/i, 'orienta a formatar a coluna como texto');
  });

  test('matrícula e telefone numéricos: lidos como estão, NUNCA completados com zeros; a prévia aponta a ambiguidade', async () => {
    const r = await lerXlsx({ F: [CABECALHO, ['A', 'S', 4799990001, '529.982.247-25', 171, null, { data: serial('2020-06-01') }, 'C', 'Ativo', 'G']] });
    const l = F.planilha.interpretar(r.linhas).linhas[0];
    assert.deepEqual([l.dados.matricula, l.dados.telefone], ['171', '4799990001']);
    assert.deepEqual(l.avisos.map((a) => a.campo).sort(), ['matricula', 'telefone']);
    assert.deepEqual(l.erros, []);
    const decimal = await lerXlsx({ F: [CABECALHO, ['A', 'S', null, '529.982.247-25', 171.5, null, { data: serial('2020-06-01') }, 'C', 'Ativo', 'G']] });
    assert.deepEqual(F.planilha.interpretar(decimal.linhas).linhas[0].erros.map((e) => e.campo), ['matricula']);
  });

  test('data digitada como número comum (sem formato de data): erro, sem adivinhar', async () => {
    const r = await lerXlsx({ F: [CABECALHO, ['A', 'S', null, '529.982.247-25', 'M', null, 44000, 'C', 'Ativo', 'G']] });
    assert.deepEqual(F.planilha.interpretar(r.linhas).linhas[0].erros.map((e) => e.campo), ['dataAdmissao']);
  });

  test('arquivo que não é .xlsx de verdade: XLSX_ILEGIVEL, sem exceção', async () => {
    const r = await F.arquivo.lerXlsx(new Blob([Buffer.from('não é uma planilha')]), readXlsxFile);
    assert.deepEqual(r, { ok: false, codigo: 'XLSX_ILEGIVEL' });
  });
});

describe('lotes: até 100 linhas e dentro do limite real de bytes do corpo', () => {
  const meta = { importacaoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', arquivo: { nome: 'funcionarios.xlsx', formato: 'xlsx', totalLinhas: 0 } };
  const valida = (i, extra = {}) => ({ linha: i + 2, dados: { nome: `F ${i}`, cpf: gerarCpf(i), matricula: `M${i}`, situacao: 'ativo', dataAdmissao: '2020-06-01', dataNascimento: null, setor: 'S', funcao: 'C', telefone: null, ghe: 'G', ...extra }, erros: [], avisos: [] });

  test('250 linhas curtas: 3 lotes (100, 100, 50) numerados; declaração confirmada na versão vigente; só linhas válidas', () => {
    const lotes = F.lotes.montar(Array.from({ length: 250 }, (_, i) => valida(i)), meta);
    assert.deepEqual(lotes.map((l) => [l.lote.numero, l.lote.total, l.linhas.length]), [[1, 3, 100], [2, 3, 100], [3, 3, 50]]);
    assert.deepEqual(lotes[0].declaracaoLgpd, { versao: F.DECLARACAO.versao, confirmada: true });
    assert.deepEqual(Object.keys(lotes[0]).sort(), ['arquivo', 'declaracaoLgpd', 'importacaoId', 'linhas', 'lote']);
    assert.deepEqual(lotes[0].linhas[0], { linha: 2, nome: 'F 0', cpf: gerarCpf(0), matricula: 'M0', situacao: 'ativo', dataAdmissao: '2020-06-01', dataNascimento: null, setor: 'S', funcao: 'C', telefone: null, ghe: 'G' });
    assert.equal(lotes[0].arquivo.totalLinhas, 250);
  });

  test('linhas longas e acentuadas: o lote fecha antes de 100 linhas para o corpo JSON (bytes UTF-8) caber no limite', () => {
    const longa = (i) => valida(i, { nome: 'Ç'.repeat(150), setor: 'Á'.repeat(100), funcao: 'É'.repeat(100), telefone: '9'.repeat(20), ghe: 'Õ'.repeat(150) });
    const lotes = F.lotes.montar(Array.from({ length: 100 }, (_, i) => longa(i)), meta);
    assert.ok(lotes.length > 1, `${lotes.length} lotes`);
    for (const l of lotes) {
      assert.ok(new TextEncoder().encode(JSON.stringify(l)).length <= F.LIMITES.bytesLote, `lote ${l.lote.numero}`);
      assert.ok(l.linhas.length <= 100);
    }
    assert.equal(lotes.reduce((s, l) => s + l.linhas.length, 0), 100, 'nenhuma linha perdida');
    assert.ok(F.LIMITES.bytesLote < 32 * 1024);
  });

  test('nome do arquivo: sem caminho nem caracteres de controle, até 100 caracteres', () => {
    const lotes = F.lotes.montar([valida(0)], { ...meta, arquivo: { nome: `C:\\pasta\\${'a'.repeat(120)}\u0007.xlsx`, formato: 'xlsx', totalLinhas: 1 } });
    assert.equal(lotes[0].arquivo.nome.length, 100);
    assert.doesNotMatch(lotes[0].arquivo.nome, /[\\/\u0000-\u001f]/);
  });
});

describe('fluxo de envio: sequencial, sem reenvio automático, com resultado por linha', () => {
  const corpo = (numero, total, linhas) => ({ importacaoId: 'x', lote: { numero, total }, arquivo: {}, declaracaoLgpd: {}, linhas: linhas.map((l) => ({ linha: l })) });
  const ok = (linhas) => resposta(200, { status: 'ok', linhas: linhas.map((l) => ({ linha: l, situacao: 'CADASTRADO', funcionarioId: l })), resumo: {} });

  test('todos os lotes confirmados: resultado de cada linha, na ordem, com um POST por lote', async () => {
    servidor(ok([2, 3]), ok([4]));
    const r = await F.fluxo.importar([corpo(1, 2, [2, 3]), corpo(2, 2, [4])]);
    assert.deepEqual(r.linhas.map((l) => [l.linha, l.situacao]), [[2, 'CADASTRADO'], [3, 'CADASTRADO'], [4, 'CADASTRADO']]);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [['POST', '/api/funcionarios/importacao'], ['POST', '/api/funcionarios/importacao']]);
    assert.equal(r.interrupcao, null);
  });

  test('falha de rede ou 5xx: linhas do lote NÃO CONFIRMADAS, lotes seguintes NÃO ENVIADOS, nenhuma nova tentativa', async () => {
    for (const falha of [new TypeError('Failed to fetch'), resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' })]) {
      servidor(ok([2]), falha, ok([6]));
      const r = await F.fluxo.importar([corpo(1, 3, [2]), corpo(2, 3, [3, 4]), corpo(3, 3, [6])]);
      assert.deepEqual(r.linhas.map((l) => [l.linha, l.situacao]), [[2, 'CADASTRADO'], [3, 'NAO_CONFIRMADO'], [4, 'NAO_CONFIRMADO'], [6, 'NAO_ENVIADO']]);
      assert.equal(chamadas.length, 2, 'o lote incerto não é reenviado e os seguintes param');
      assert.equal(r.interrupcao.motivo, 'NAO_CONFIRMADO');
    }
  });

  test('recusa do lote (400/403/413/429): linhas do lote RECUSADAS com o motivo, seguintes NÃO ENVIADAS; 401 encerra a sessão', async () => {
    servidor(resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }));
    const r = await F.fluxo.importar([corpo(1, 2, [2]), corpo(2, 2, [3])]);
    assert.deepEqual(r.linhas.map((l) => [l.linha, l.situacao]), [[2, 'RECUSADO'], [3, 'NAO_ENVIADO']]);
    assert.match(r.linhas[0].motivo, /permissão/i);
    servidor(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    const s = await F.fluxo.importar([corpo(1, 1, [2])]);
    assert.deepEqual([s.interrupcao.motivo, s.linhas[0].situacao], ['SESSAO', 'NAO_ENVIADO']);
  });

  test('consolidação: linhas com erro na prévia entram como RECUSADO local; resumo com as situações; relatório sem CPF', () => {
    const interpretadas = [
      { linha: 2, dados: { matricula: 'M2', cpf: '52998224725', nome: 'A' }, exibicao: { matricula: 'M2', nome: 'A' }, erros: [], avisos: [] },
      { linha: 3, dados: { matricula: 'M3', cpf: '1', nome: 'B' }, exibicao: { matricula: 'M3', nome: 'B' }, erros: [{ campo: 'cpf', mensagem: 'CPF inválido.' }], avisos: [] },
    ];
    const enviado = { linhas: [{ linha: 2, situacao: 'DUPLICADO', codigo: 'FUNCIONARIO_MATRICULA_EM_USO', motivo: 'Matrícula já cadastrada nesta empresa.' }], interrupcao: null };
    const c = F.fluxo.consolidar(interpretadas, enviado);
    assert.deepEqual(c.linhas.map((l) => [l.linha, l.situacao, l.matricula, l.nome]), [[2, 'DUPLICADO', 'M2', 'A'], [3, 'RECUSADO', 'M3', 'B']]);
    assert.deepEqual(c.resumo, { total: 2, cadastrados: 0, jaCadastrados: 0, divergentes: 0, duplicados: 1, recusados: 1, erros: 0, naoConfirmados: 0, naoEnviados: 0, naoImportados: 2 });
    assert.deepEqual(c.porMotivo, [['Matrícula já em uso', 1], ['CPF inválido', 1]]);
    const html = F.render.relatorio(c);
    assert.doesNotMatch(html, /52998224725|529\.982/);
    assert.match(html, /Não importado — Matrícula já em uso/);
    assert.match(html, /Não importado — CPF inválido/);
  });

  test('12G-9 consolidação e relatório: importado, já cadastrado sem alteração e com divergências (campo, sistema atual, planilha), não importados por motivo; tudo escapado; sensível só sinalizado', () => {
    const interpretada = (linha, dados, exibicao, erros = []) => ({ linha, dados, exibicao, erros, avisos: [] });
    const base = { nome: 'Ana', setor: 'TI', funcao: 'Analista', dataAdmissao: '2021-06-01', dataNascimento: '1990-03-15', telefone: '47999990000', ghe: 'GHE TI', cpf: '52998224725' };
    const exib = { nome: 'Ana', setor: 'TI', cargo: 'Analista', contratacao: '01/06/2021', nascimento: '15/03/1990', telefone: '47999990000', ghe: 'GHE TI', cpf: '***.***.***-25' };
    const interpretadas = [
      interpretada(2, { ...base, matricula: 'M2' }, { ...exib, matricula: 'M2' }),
      interpretada(3, { ...base, matricula: 'M3' }, { ...exib, matricula: 'M3' }),
      interpretada(4, { ...base, matricula: 'M4', nome: '<b>Ana</b>' }, { ...exib, matricula: 'M4', nome: '<b>Ana</b>' }),
      interpretada(5, { ...base, matricula: 'M5', ghe: 'Inexistente' }, { ...exib, matricula: 'M5', ghe: 'Inexistente' }),
      interpretada(6, { ...base, matricula: 'M6', ghe: '' }, { ...exib, matricula: 'M6', ghe: '' }, [{ campo: 'ghe', mensagem: 'GHE obrigatório.' }]),
      interpretada(7, { ...base, matricula: 'M7', cpf: '' }, { ...exib, matricula: 'M7', cpf: '' }, [{ campo: 'cpf', mensagem: 'CPF obrigatório.' }]),
      interpretada(8, { ...base, matricula: 'M8' }, { ...exib, matricula: 'M8' }),
      interpretada(9, { ...base, matricula: 'M9' }, { ...exib, matricula: 'M9' }),
    ];
    const enviado = {
      linhas: [
        { linha: 2, situacao: 'CADASTRADO', funcionarioId: 10 },
        { linha: 3, situacao: 'JA_CADASTRADO', codigo: 'FUNCIONARIO_JA_CADASTRADO', motivo: 'Já cadastrado — sem alterações.', funcionarioId: 11, ativo: false },
        {
          linha: 4, situacao: 'JA_CADASTRADO', codigo: 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE', motivo: 'Já cadastrado — dados divergentes. Nenhuma alteração realizada.', funcionarioId: 12, ativo: true,
          // telefone chega COM valor de propósito: a tela nunca exibe o atual de campo sensível, venha o que vier do servidor.
          divergencias: [{ campo: 'nome', atual: '<i>Ana Souza</i>' }, { campo: 'dataAdmissao', atual: '2020-01-31' }, { campo: 'telefone', atual: '47900000000' }, { campo: 'dataNascimento' }, { campo: 'ghe', atual: null }],
        },
        { linha: 5, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_INEXISTENTE', motivo: 'GHE inexistente nesta empresa.', campos: ['ghe'] },
        { linha: 8, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_INATIVO', motivo: 'GHE inativo.', campos: ['ghe'] },
        { linha: 9, situacao: 'ERRO', codigo: 'ERRO_INTERNO', motivo: 'Erro ao processar esta linha. Ela não foi gravada.' },
      ],
      interrupcao: null,
    };
    const c = F.fluxo.consolidar(interpretadas, enviado);
    assert.deepEqual(c.linhas.map((l) => [l.linha, l.situacao, l.codigo || null, l.nome]), [
      [2, 'CADASTRADO', null, 'Ana'], [3, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO', 'Ana'], [4, 'JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE', '<b>Ana</b>'],
      [5, 'RECUSADO', 'FUNCIONARIO_GHE_INEXISTENTE', 'Ana'], [6, 'RECUSADO', null, 'Ana'], [7, 'RECUSADO', null, 'Ana'], [8, 'RECUSADO', 'FUNCIONARIO_GHE_INATIVO', 'Ana'], [9, 'ERRO', 'ERRO_INTERNO', 'Ana'],
    ]);
    assert.equal(c.linhas[2].ativo, true);
    assert.equal(c.linhas[1].ativo, false);
    // Divergências: valor atual vindo do servidor e valor da PLANILHA preenchido pela própria tela, com rótulo e exibição (datas DD/MM/AAAA).
    assert.deepEqual(c.linhas[2].divergencias, [
      { campo: 'nome', rotulo: 'Nome', atual: '<i>Ana Souza</i>', planilha: '<b>Ana</b>', oculto: false },
      { campo: 'dataAdmissao', rotulo: 'Admissão', atual: '31/01/2020', planilha: '01/06/2021', oculto: false },
      { campo: 'telefone', rotulo: 'Telefone', atual: null, planilha: '47999990000', oculto: true },
      { campo: 'dataNascimento', rotulo: 'Nascimento', atual: null, planilha: '15/03/1990', oculto: true },
      { campo: 'ghe', rotulo: 'GHE', atual: null, planilha: 'GHE TI', oculto: false },
    ]);
    assert.deepEqual(c.resumo, { total: 8, cadastrados: 1, jaCadastrados: 1, divergentes: 1, duplicados: 0, recusados: 4, erros: 1, naoConfirmados: 0, naoEnviados: 0, naoImportados: 5 });
    assert.deepEqual(c.porMotivo, [['GHE não encontrado', 1], ['GHE não informado', 1], ['CPF ausente', 1], ['GHE inativo', 1], ['Erro de processamento', 1]]);
    assert.deepEqual(F.fluxo.rotulo(c.linhas[0]), 'Importado com sucesso');
    assert.deepEqual(F.fluxo.rotulo(c.linhas[1]), 'Já cadastrado — sem alterações');
    assert.deepEqual(F.fluxo.rotulo(c.linhas[2]), 'Já cadastrado — dados divergentes');
    assert.deepEqual(F.fluxo.rotulo(c.linhas[3]), 'Não importado — GHE não encontrado');
    assert.deepEqual(F.fluxo.rotulo({ situacao: 'NAO_CONFIRMADO' }), 'Não confirmado');
    assert.deepEqual(F.fluxo.rotulo({ situacao: 'RECUSADO', origem: 'previa', motivo: 'Nome obrigatório.' }), 'Não importado — Outro erro de validação');

    const html = F.render.relatorio(c);
    for (const rotulo of ['Total processado', 'Importados com sucesso', 'Já cadastrados sem alteração', 'Já cadastrados com divergência', 'Não importados']) assert.match(html, new RegExp(`<span>${rotulo}</span>`));
    assert.match(html, /Importados com sucesso<\/span><strong>1</);
    assert.match(html, /Não importados<\/span><strong>5</);
    assert.match(html, /GHE não encontrado: 1/);
    assert.match(html, /CPF ausente: 1/);
    assert.match(html, /Importado com sucesso/);
    assert.match(html, /Já cadastrado — sem alterações/);
    assert.match(html, /\(inativo\)/, 'o existente inativo é sinalizado');
    assert.match(html, /Já cadastrado — dados divergentes/);
    assert.match(html, /<th>Campo<\/th><th>Sistema atual<\/th><th>Planilha<\/th>/);
    assert.match(html, /<td>Nome<\/td><td>&lt;i&gt;Ana Souza&lt;\/i&gt;<\/td><td>&lt;b&gt;Ana&lt;\/b&gt;<\/td>/);
    assert.match(html, /<td>Admissão<\/td><td>31\/01\/2020<\/td><td>01\/06\/2021<\/td>/);
    assert.match(html, /<td>Telefone<\/td><td><em>não exibido \(dado sensível\)<\/em><\/td><td>47999990000<\/td>/);
    assert.match(html, /<td>GHE<\/td><td>—<\/td><td>GHE TI<\/td>/);
    assert.match(html, /Nenhuma alteração realizada/);
    assert.doesNotMatch(html, /<b>|<i>|52998224725|\*\*\*\.\*\*\*|47900000000/, 'nada do servidor ou da planilha vira HTML; CPF nunca aparece; telefone atual nunca é exibido');
    assert.match(html, /Não importado — GHE não encontrado/);
    assert.match(html, /Não importado — GHE não informado/);
    assert.match(html, /Não importado — Erro de processamento/);
  });
});

describe('histórico: consulta por nome/matrícula ou CPF completo', () => {
  test('nome ou matrícula viram busca livre; CPF só completo e válido, normalizado; parcial é recusado sem requisição', () => {
    assert.deepEqual(F.historico.consulta('nome', '  Silva '), { ok: true, filtro: { busca: 'Silva' } });
    assert.deepEqual(F.historico.consulta('matricula', 'MAT-1'), { ok: true, filtro: { busca: 'MAT-1' } });
    assert.deepEqual(F.historico.consulta('cpf', '529.982.247-25'), { ok: true, filtro: { cpf: '52998224725' } });
    for (const [tipo, valor] of [['cpf', '529.982'], ['cpf', '529.982.247-26'], ['nome', '   '], ['nome', 'x'.repeat(101)]]) {
      assert.equal(F.historico.consulta(tipo, valor).ok, false, `${tipo} ${valor}`);
    }
    assert.match(F.historico.consulta('cpf', '529.982').mensagem, /completo/i);
  });

  test('acoes.listar: busca livre na query; CPF completo só no corpo de um POST, nunca na URL (SEC-008)', async () => {
    servidor(resposta(200, { status: 'ok', funcionarios: [], total: 0, pagina: 1, limite: 20 }));
    await F.acoes.listar({ cpf: '52998224725' });
    await F.acoes.listar({ busca: 'Silva' });
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [
      ['POST', '/api/funcionarios/consulta-cpf', { cpf: '52998224725' }],
      ['GET', '/api/funcionarios?busca=Silva&pagina=1&limite=20', undefined],
    ]);
    assert.equal(chamadas.some((c) => c.caminho.includes('52998224725')), false);
  });

  test('render: lista de resultados escapada, com situação; sem entregas mostra a ausência de registros', () => {
    const html = F.render.resultados([{ id: 1, nome: '<b>Ana</b>', matricula: 'M1', setor: 'TI', ativo: false }]);
    assert.match(html, /&lt;b&gt;Ana/);
    assert.match(html, /data-id="1"/);
    assert.match(html, /Inativo/);
    assert.match(F.mensagens.SEM_ENTREGAS, /Nenhuma entrega registrada/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Páginas integradas (inspeção estática e DOM simulado)
// ═══════════════════════════════════════════════════════════════════
const vm = require('node:vm');
const P = require('../js/permissoes-efetivas');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };

describe('permissões das páginas (mapa PAGINAS)', () => {
  const perm = (op) => ({ recursos: { employeeHistory: { visualizar: op.includes('v'), criar: op.includes('c'), editar: false, excluir: false } }, acoes: {}, administracao: {} });
  test('histórico abre com employeeHistory.visualizar; importar tem a ação PRÓPRIA IMPORTAR_FUNCIONARIOS, independente de employeeHistory.criar', () => {
    const comAcao = (op, importar) => ({ ...perm(op), acoes: { IMPORTAR_FUNCIONARIOS: importar } });
    assert.equal(P.podeAbrir(perm('v'), 'employeeHistory'), true);
    assert.equal(P.podeAbrir(perm(''), 'employeeHistory'), false);
    assert.equal(P.podeAbrir(perm('vc'), 'importEmployees'), false, 'criar funcionário não é importar');
    assert.equal(P.podeAbrir(comAcao('', true), 'importEmployees'), true, 'importar sem acesso ao histórico');
    assert.equal(P.podeAbrir(comAcao('v', false), 'employeeHistory'), true, 'histórico com importação OFF');
    assert.equal(P.podeAbrir(comAcao('v', false), 'importEmployees'), false);
    assert.deepEqual(P.PAGINAS.importEmployees.abrir, [{ acao: 'IMPORTAR_FUNCIONARIOS' }]);
  });
});

describe('inspeção estática das duas páginas', () => {
  const imp = ler('pages/import-employees.html');
  const hist = ler('pages/employee-history.html');

  test('importação: sem SheetJS 0.18.5, db-api, main.js, login simulado ou quiosque; biblioteca local e módulo carregados; só .xlsx e .csv', () => {
    const codigo = semComentarios(imp);
    for (const proibido of [/xlsx@0\.18\.5/, /cdn\.jsdelivr/, /db-api\.js/, /main\.js/, /loginScreen/, /kiosk/i, /Cobresul/i, /localStorage/, /sessionStorage/, /onclick="import/, /ondrop=/, /showView\(/]) {
      assert.equal(proibido.test(codigo), false, `import-employees.html contém ${proibido}`);
    }
    const scripts = [...imp.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../vendor/read-excel-file-9.3.10.min.js', '../js/funcionarios.js']);
    assert.match(imp, /<input type="file" id="importFileInput" accept="\.xlsx,\.csv"/);
    assert.match(imp, /salve como \.xlsx/i);
    const declaracao = /<span id="textoDeclaracaoLgpd">([^<]*)<\/span>/.exec(imp);
    assert.equal(declaracao[1], F.DECLARACAO.texto, 'a página mostra exatamente o texto registrado (mesma versão e hash)');
    for (const id of ['importDropzone', 'botaoBaixarModelo', 'importPreviewCard', 'lgpdConsentImport', 'importSummary', 'importErrorsBox', 'importPreviewBody', 'importConfirmBtn', 'botaoNovoArquivo', 'importResultCard', 'importResultSummary', 'botaoNovaImportacao', 'telaSessao', 'aviso']) {
      assert.match(imp, new RegExp(`id="${id}"`), `falta #${id}`);
    }
    for (const coluna of ['Nome', 'Setor', 'CPF', 'Admissão', 'Cargo', 'Nome GHE', 'Situação', 'Status']) assert.match(imp, new RegExp(`<th>${coluna}</th>`));
    assert.match(codigo, /pagina: 'importEmployees'/);
    assert.equal(/Administração de Usuários e Histórico/.test(imp), false, 'texto incorreto do protótipo removido');
  });

  test('histórico: sem dados fictícios (colaborador, crachá, matrícula, entregas, indicadores), campos somente leitura, sem db-api/main.js', () => {
    const codigo = semComentarios(hist);
    for (const proibido of [/Tício de Tal/, /CR-001284/, /MAT-000171/, /Botina de segurança/, /12\/04\/2026/, /Luva nitrílica/, />18</, /db-api\.js/, /main\.js/, /xlsx/, /loginScreen/, /kiosk/i, /onclick="openHistoryModal/, /localStorage/]) {
      assert.equal(proibido.test(codigo), false, `employee-history.html contém ${proibido}`);
    }
    for (const id of ['historyEmployeeName', 'historyEmployeeBadge', 'historyEmployeeMatricula', 'historySector']) {
      assert.match(hist, new RegExp(`id="${id}" class="input" type="text" value="" readonly`), id);
    }
    for (const opcao of ['nome', 'matricula', 'cpf']) assert.match(hist, new RegExp(`<option value="${opcao}">`));
    for (const id of ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos']) assert.match(hist, new RegExp(`<strong id="${id}">—</strong>`));
    assert.match(codigo, /pagina: 'employeeHistory'/);
  });

  test('menus e Portal: Histórico e Importar viram links com data-pagina, ocultos até a permissão, nas páginas integradas', () => {
    for (const arquivo of ['pages/materials.html', 'pages/available-items.html', 'pages/import-employees.html', 'pages/employee-history.html']) {
      const html = ler(arquivo);
      assert.match(html, /data-pagina="employeeHistory" style="display:none"><div class="nav-icon blue">history<\/div>Histórico de Funcionários<\/a>/, arquivo);
      assert.match(html, /data-pagina="importEmployees" style="display:none"><div class="nav-icon green">upload_file<\/div>Importar Funcionários<\/a>/, arquivo);
    }
    const portal = ler('portal/inicio.html');
    assert.match(portal, /<a href="\.\.\/pages\/employee-history\.html" data-pagina="employeeHistory" style="display:none">Histórico de funcionários<\/a>/);
    assert.match(portal, /<a href="\.\.\/pages\/import-employees\.html" data-pagina="importEmployees" style="display:none">Importar funcionários<\/a>/);
  });
});

// ── DOM simulado ──
function elementoFalso(id) {
  return {
    id, value: '', checked: false, files: null, innerHTML: '', textContent: '', disabled: false, style: {}, listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click() { this.clicado = (this.clicado || 0) + 1; },
  };
}

function montarPagina(arquivoHtml, { acesso = { permissoes: {}, podeAlterar: true }, leitor = readXlsxFile } = {}) {
  const html = ler(arquivoHtml);
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || elementoFalso(id));
  const downloads = [];
  let uuid = 0;
  const sandbox = {
    document: {
      getElementById: el, querySelectorAll: () => [],
      createElement: () => ({ click() { downloads.push({ nome: this.download, href: this.href }); }, remove() {} }),
      body: { appendChild() {} },
    },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, readXlsxFile: leitor, crypto: { randomUUID: () => `00000000-0000-4000-8000-00000000000${uuid += 1}` } },
    URL: { createObjectURL: (b) => { downloads.push({ blob: b }); return 'blob:x'; }, revokeObjectURL() {} },
    Blob, Uint8Array,
    EpiHttp, EpiFuncionarios: F,
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click', evento) => { for (const fn of (el(id).listeners[ev] || [])) await fn(evento); await esperar(); };
  return { el, sandbox, esperar, disparar, downloads };
}

const arquivoCsv = (texto, nome = 'funcionarios.csv') => Object.assign(new Blob([Buffer.from(texto, 'utf8')]), { name: nome });
const CSV_OK = `Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE\r\nJoão;Produção;;${gerarCpf(1)};M1;15/03/1990;01/06/2020;Operador;Ativo;${GHE_PLANILHA}\r\nAna;TI;;${gerarCpf(2)};M2;;01/06/2021;Analista;Ativo;GHE TI\r\nErro;TI;;529.982.247-26;M3;;01/06/2021;Analista;Ativo;GHE TI\r\n`;

describe('página Importar Funcionários (DOM simulado)', () => {
  const lotesOk = (chamada) => resposta(200, { status: 'ok', linhas: chamada.corpo.linhas.map((l) => ({ linha: l.linha, situacao: 'CADASTRADO', funcionarioId: l.linha })), resumo: {} });

  async function comArquivo(pg, arquivo) {
    pg.el('importFileInput').files = [arquivo];
    await pg.disparar('importFileInput', 'change');
  }

  test('CSV: prévia com as três linhas, o erro apontado, confirmação bloqueada sem a declaração; com ela, só as válidas são enviadas, com a declaração, e o relatório aparece', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    assert.equal(pg.el('importPreviewCard').style.display, 'block');
    assert.equal((pg.el('importPreviewBody').innerHTML.match(/<tr/g) || []).length, 3);
    assert.match(pg.el('importErrorsBox').innerHTML, /Linha 4: CPF inválido/);
    assert.match(pg.el('importPreviewSub').textContent, /1 linha\(s\) com erro não serão importadas/);
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 0, 'sem a declaração marcada, nada é enviado');
    assert.match(pg.el('aviso').innerHTML, /declaração/);
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].caminho, '/api/funcionarios/importacao');
    assert.deepEqual(chamadas[0].corpo.linhas.map((l) => [l.linha, l.ghe]), [[2, GHE_PLANILHA], [3, 'GHE TI']]);
    assert.deepEqual(chamadas[0].corpo.declaracaoLgpd, { versao: F.DECLARACAO.versao, confirmada: true });
    assert.deepEqual(chamadas[0].corpo.arquivo, { nome: 'funcionarios.csv', formato: 'csv', totalLinhas: 3 });
    assert.equal(pg.el('importResultCard').style.display, 'block');
    assert.match(pg.el('importResultSummary').innerHTML, /Importados com sucesso<\/span><strong>2/);
    assert.match(pg.el('importResultSummary').innerHTML, /Não importado — CPF inválido/);
    assert.doesNotMatch(pg.el('importResultSummary').innerHTML, new RegExp(gerarCpf(1)));
    assert.match(pg.el('aviso').innerHTML, /2 importado\(s\) com sucesso/);
  });

  test('12G-9 página: planilha sem a coluna GHE é recusada antes da prévia (CASO A); GHE vazio só invalida a linha (CASO B)', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(`Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação\r\nJoão;Produção;;${gerarCpf(1)};M1;;01/06/2020;Operador;Ativo\r\n`));
    assert.match(pg.el('aviso').innerHTML, /Faltam colunas obrigatórias.*GHE/);
    assert.notEqual(pg.el('importPreviewCard').style.display, 'block');
    assert.equal(chamadas.length, 0);
    await comArquivo(pg, arquivoCsv(`Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE\r\nJoão;Produção;;${gerarCpf(1)};M1;;01/06/2020;Operador;Ativo;\r\nAna;TI;;${gerarCpf(2)};M2;;01/06/2021;Analista;Ativo;GHE TI\r\n`));
    assert.equal(pg.el('importPreviewCard').style.display, 'block');
    assert.match(pg.el('importErrorsBox').innerHTML, /Linha 2: Nome GHE não informado/);
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.deepEqual(chamadas[0].corpo.linhas.map((l) => [l.linha, l.ghe]), [[3, 'GHE TI']]);
    assert.match(pg.el('importResultSummary').innerHTML, /Não importado — GHE não informado/);
  });

  test('12G-9 página: resultado do servidor com já cadastrado (sem alteração e divergente) e GHE inexistente — resumo, divergências com sistema atual e planilha, nada sobrescrito', async () => {
    servidor((c) => resposta(200, {
      status: 'ok',
      linhas: c.corpo.linhas.map((l) => {
        if (l.linha === 2) return { linha: 2, situacao: 'JA_CADASTRADO', codigo: 'FUNCIONARIO_JA_CADASTRADO', motivo: 'Já cadastrado — sem alterações.', funcionarioId: 1, ativo: true };
        return {
          linha: 3, situacao: 'JA_CADASTRADO', codigo: 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE', motivo: 'Já cadastrado — dados divergentes. Nenhuma alteração realizada.', funcionarioId: 2, ativo: true,
          divergencias: [{ campo: 'setor', atual: 'Qualidade' }, { campo: 'ghe', atual: 'GHE Qualidade' }],
        };
      }),
      resumo: {},
    }));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    const html = pg.el('importResultSummary').innerHTML;
    assert.match(html, /Importados com sucesso<\/span><strong>0/);
    assert.match(html, /Já cadastrados sem alteração<\/span><strong>1/);
    assert.match(html, /Já cadastrados com divergência<\/span><strong>1/);
    assert.match(html, /Não importados<\/span><strong>1/);
    assert.match(html, /<td>Setor<\/td><td>Qualidade<\/td><td>TI<\/td>/);
    assert.match(html, /<td>GHE<\/td><td>GHE Qualidade<\/td><td>GHE TI<\/td>/);
    assert.match(html, /Nenhuma alteração realizada/);
    assert.doesNotMatch(html, new RegExp(`${gerarCpf(1)}|${gerarCpf(2)}`));
    assert.match(pg.el('aviso').innerHTML, /0 importado\(s\) com sucesso, 2 já cadastrado\(s\) e 1 não importado\(s\)/);
  });

  test('.xlsx real: lido pela biblioteca local e enviado', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    const planilhaXlsx = Object.assign(new Blob([xlsx({ F: [CABECALHO, ['João', 'Produção', null, gerarCpf(1), 'M1', null, { data: serial('2020-06-01') }, 'Operador', 'Ativo', GHE_PLANILHA]] })]), { name: 'funcionarios.xlsx' });
    await comArquivo(pg, planilhaXlsx);
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.deepEqual(chamadas[0].corpo.linhas.map((l) => [l.linha, l.dataAdmissao, l.cpf, l.ghe]), [[2, '2020-06-01', gerarCpf(1), GHE_PLANILHA]]);
    assert.equal(chamadas[0].corpo.arquivo.formato, 'xlsx');
  });

  test('arquivo .xls, formato estranho ou planilha sem colunas obrigatórias: mensagem clara, nenhuma prévia, nada enviado', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, Object.assign(new Blob([Buffer.from([0xd0, 0xcf, 0x11, 0xe0])]), { name: 'antigo.xls' }));
    assert.match(pg.el('aviso').innerHTML, /salve como \.xlsx/i);
    assert.notEqual(pg.el('importPreviewCard').style.display, 'block');
    await comArquivo(pg, arquivoCsv('Nome;CPF\r\nA;1\r\n'));
    assert.match(pg.el('aviso').innerHTML, /Faltam colunas obrigatórias/);
    assert.equal(chamadas.length, 0);
  });

  test('falha de rede no envio: relatório com "Não confirmado", aviso de atenção, nenhum reenvio', async () => {
    servidor(new TypeError('Failed to fetch'));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 1);
    assert.match(pg.el('importResultSummary').innerHTML, /Não confirmado/);
    assert.match(pg.el('aviso').innerHTML, /C07000/);
    assert.match(pg.el('aviso').innerHTML, /interrompida/);
  });

  test('401 no envio devolve ao Portal', async () => {
    servidor(resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('sem permissão (prepararPagina nega): nenhum arquivo é lido', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html', { acesso: null });
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    assert.notEqual(pg.el('importPreviewCard').style.display, 'block');
  });

  test('sessão encerrada: prévia apagada e nada mais é aplicado', async () => {
    servidor(lotesOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await comArquivo(pg, arquivoCsv(CSV_OK));
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.equal(pg.el('importPreviewBody').innerHTML, '');
    assert.equal(pg.el('importUploadCard').style.display, 'block');
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 0);
  });

  test('modelo para download: só o cabeçalho, sem funcionário fictício', async () => {
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    await pg.disparar('botaoBaixarModelo');
    const blob = pg.downloads.find((d) => d.blob).blob;
    // Bytes, não .text(): o TextDecoder de .text() descarta o BOM, que precisa estar no arquivo para o Excel.
    const bytesModelo = Buffer.from(await blob.arrayBuffer());
    assert.deepEqual([...bytesModelo.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 para o Excel');
    assert.equal(bytesModelo.subarray(3).toString('utf8'), 'Nome;Setor;Cargo;Dt.Admissão;CPF;Matrícula;Situação;Nome GHE\r\n');
    assert.equal(pg.downloads.find((d) => d.nome).nome, 'modelo_funcionarios.csv');
  });

  test('12G-9 página: cabeçalho da prévia tem a coluna GHE entre Cargo e Status; o texto do modelo cita o GHE', () => {
    const imp = ler('pages/import-employees.html');
    assert.match(imp, /<th>Cargo<\/th>\s*<th>Nome GHE<\/th>\s*<th>Situação<\/th>\s*<th>Status<\/th>/);
    assert.match(imp, /GHE/);
  });
});

describe('página Histórico de Funcionários (DOM simulado)', () => {
  const funcionario = (extra = {}) => ({ id: 11, nome: 'Ana Souza', matricula: 'M-11', setor: 'Qualidade', funcao: 'Analista', cracha: 'CR-11', ativo: true, ...extra });
  const lista = (itens, total = itens.length) => resposta(200, { status: 'ok', funcionarios: itens, total, pagina: 1, limite: 20 });

  async function consultar(pg, tipo, valor) {
    pg.el('historyFilterType').value = tipo;
    pg.el('historySearchValue').value = valor;
    await pg.disparar('botaoConsultar');
  }

  test('um resultado: dados reais preenchidos; indicadores "—" e ausência de entregas; nenhuma entrega inventada', async () => {
    servidor(lista([funcionario()]));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'nome', 'Ana');
    assert.equal(chamadas[0].caminho, '/api/funcionarios?busca=Ana&pagina=1&limite=20');
    assert.deepEqual(['historyEmployeeName', 'historyEmployeeBadge', 'historyEmployeeMatricula', 'historySector'].map((id) => pg.el(id).value), ['Ana Souza', 'CR-11', 'M-11', 'Qualidade']);
    assert.deepEqual(['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'].map((id) => pg.el(id).textContent), ['—', '—', '—', '—']);
    assert.match(pg.el('historyTimeline').innerHTML, /Nenhuma entrega registrada/);
  });

  test('vários resultados: lista para seleção; escolher preenche o colaborador sem nova consulta', async () => {
    servidor(lista([funcionario(), funcionario({ id: 12, nome: 'Ana Lima', matricula: 'M-12', ativo: false })], 35));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'nome', 'Ana');
    assert.equal(pg.el('historyResultados').style.display, 'block');
    assert.match(pg.el('historyResultados').innerHTML, /Mostrando 2 de 35/);
    assert.match(pg.el('historyResultados').innerHTML, /Inativo/);
    assert.equal(pg.el('historyEmployeeName').value, '');
    const antes = chamadas.length;
    await pg.disparar('historyResultados', 'click', { target: { closest: () => ({ getAttribute: () => '12' }) } });
    assert.equal(pg.el('historyEmployeeName').value, 'Ana Lima');
    assert.equal(chamadas.length, antes);
  });

  test('CPF: parcial é recusado sem requisição; completo vai como cpf exato (nunca na busca livre)', async () => {
    servidor(lista([funcionario()]));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'cpf', '529.982');
    assert.equal(chamadas.length, 0);
    assert.match(pg.el('aviso').innerHTML, /CPF completo/);
    await consultar(pg, 'cpf', '529.982.247-25');
    assert.deepEqual([chamadas[0].metodo, chamadas[0].caminho, chamadas[0].corpo], ['POST', '/api/funcionarios/consulta-cpf', { cpf: '52998224725' }]);
  });

  test('nenhum resultado e falhas: mensagem clara, colaborador vazio; 401 devolve ao Portal', async () => {
    servidor(lista([]));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'matricula', 'X');
    assert.match(pg.el('aviso').innerHTML, /Nenhum funcionário encontrado/);
    servidor(resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }));
    await consultar(pg, 'nome', 'Ana');
    assert.match(pg.el('aviso').innerHTML, /não pode consultar funcionários/);
    servidor(resposta(401, { status: 'erro' }));
    await consultar(pg, 'nome', 'Ana');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('resposta antiga descartada: a consulta mais recente é a que fica na tela', async () => {
    let liberar;
    const lenta = new Promise((r) => { liberar = r; });
    servidor((c) => (c.caminho.includes('busca=Primeira') ? lenta : lista([funcionario({ nome: 'Segunda' })])));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    pg.el('historyFilterType').value = 'nome';
    pg.el('historySearchValue').value = 'Primeira';
    const primeira = pg.disparar('botaoConsultar');
    await pg.esperar();
    await consultar(pg, 'nome', 'Segunda');
    liberar(lista([funcionario({ nome: 'Primeira' })]));
    await primeira;
    assert.equal(pg.el('historyEmployeeName').value, 'Segunda');
  });

  test('exportar sem entregas: mensagem de ausência de registros e NENHUM arquivo gerado', async () => {
    servidor(lista([funcionario()]));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'nome', 'Ana');
    await pg.disparar('botaoExportarHistorico');
    assert.match(pg.el('aviso').innerHTML, /Não há entregas registradas para este colaborador\. Nenhum arquivo foi gerado\./);
    assert.equal(pg.downloads.length, 0);
  });

  test('sessão encerrada: colaborador, lista e busca apagados; respostas pendentes ignoradas', async () => {
    servidor(lista([funcionario()]));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    await consultar(pg, 'nome', 'Ana');
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.deepEqual([pg.el('historyEmployeeName').value, pg.el('historySearchValue').value], ['', '']);
    await consultar(pg, 'nome', 'Ana');
    assert.equal(pg.el('historyEmployeeName').value, '');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Ajustes de fechamento da C4 (auditoria de 25/09/2026)
// ═══════════════════════════════════════════════════════════════════

describe('ajuste 1 — valores ambíguos exigem conferência expressa, distinta da declaração LGPD', () => {
  const linha = (i, avisos = []) => ({ linha: i + 2, dados: { nome: `F${i}`, cpf: gerarCpf(i), matricula: `M${i}`, dataAdmissao: '2020-06-01', dataNascimento: null, setor: 'S', funcao: 'C', telefone: null }, erros: [], avisos });
  const meta = { importacaoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', arquivo: { nome: 'a.xlsx', formato: 'xlsx', totalLinhas: 2 } };
  const AVISO = [{ campo: 'matricula', mensagem: 'Matrícula lida como número…' }];

  test('verificarConfirmacoes: declaração sempre obrigatória; conferência dos ambíguos obrigatória só se houver linha "Atenção"', () => {
    const comAviso = { linhas: [linha(0), linha(1, AVISO)], comAviso: 1 };
    const semAviso = { linhas: [linha(0)], comAviso: 0 };
    assert.deepEqual(F.fluxo.verificarConfirmacoes(comAviso, { declaracao: false, ambiguos: true }).codigo, 'DECLARACAO_NAO_CONFIRMADA');
    assert.deepEqual(F.fluxo.verificarConfirmacoes(comAviso, { declaracao: true, ambiguos: false }).codigo, 'AMBIGUOS_NAO_CONFERIDOS');
    assert.match(F.fluxo.verificarConfirmacoes(comAviso, { declaracao: true, ambiguos: false }).mensagem, /corrija a planilha/i);
    assert.deepEqual(F.fluxo.verificarConfirmacoes(comAviso, { declaracao: true, ambiguos: true }), { ok: true });
    assert.deepEqual(F.fluxo.verificarConfirmacoes(semAviso, { declaracao: true, ambiguos: false }), { ok: true });
  });

  test('lotes.montar falha fechado: linha "Atenção" sem conferência expressa nunca é enviada; com ela, entra no lote', () => {
    assert.throws(() => F.lotes.montar([linha(0), linha(1, AVISO)], meta), /ambígu/i);
    assert.throws(() => F.lotes.montar([linha(0), linha(1, AVISO)], meta, { ambiguosConferidos: false }), /ambígu/i);
    const lotes = F.lotes.montar([linha(0), linha(1, AVISO)], meta, { ambiguosConferidos: true });
    assert.deepEqual(lotes[0].linhas.map((l) => l.linha), [2, 3]);
    assert.equal(F.lotes.montar([linha(0)], meta).length, 1, 'sem ambíguos, nada muda');
  });

  test('página: controle próprio de conferência (não é a declaração LGPD), visível só com linhas "Atenção"', () => {
    const imp = ler('pages/import-employees.html');
    assert.match(imp, /<input type="checkbox" id="confirmacaoAmbiguos"/);
    assert.match(imp, /<div id="blocoConfirmacaoAmbiguos" style="display:none/);
    const texto = /<span id="textoConfirmacaoAmbiguos">([^<]*)<\/span>/.exec(imp)[1];
    assert.notEqual(texto, F.DECLARACAO.texto);
    assert.match(texto, /Conferi/);
    assert.doesNotMatch(texto, /LGPD|Política de Privacidade/);
  });

  test('página: .xlsx com matrícula numérica — sem a conferência expressa nada é enviado; conferindo, a linha vai; novo arquivo zera a conferência', async () => {
    servidor((c) => resposta(200, { status: 'ok', linhas: c.corpo.linhas.map((l) => ({ linha: l.linha, situacao: 'CADASTRADO', funcionarioId: l.linha })), resumo: {} }));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    const planilhaXlsx = Object.assign(new Blob([xlsx({ F: [CABECALHO, ['João', 'Produção', null, gerarCpf(1), 171, null, { data: serial('2020-06-01') }, 'Operador', 'Ativo', GHE_PLANILHA]] })]), { name: 'funcionarios.xlsx' });
    pg.el('importFileInput').files = [planilhaXlsx];
    await pg.disparar('importFileInput', 'change');
    assert.equal(pg.el('blocoConfirmacaoAmbiguos').style.display, 'block');
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 0, 'declaração LGPD não substitui a conferência dos ambíguos');
    assert.match(pg.el('aviso').innerHTML, /Atenção/);
    pg.el('confirmacaoAmbiguos').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.deepEqual(chamadas[0].corpo.linhas.map((l) => [l.linha, l.matricula]), [[2, '171']]);
    await pg.disparar('botaoNovaImportacao');
    assert.equal(pg.el('confirmacaoAmbiguos').checked, false);
    assert.equal(pg.el('blocoConfirmacaoAmbiguos').style.display, 'none');
  });

  test('página: planilha sem valores ambíguos não mostra a conferência nem a exige', async () => {
    servidor((c) => resposta(200, { status: 'ok', linhas: c.corpo.linhas.map((l) => ({ linha: l.linha, situacao: 'CADASTRADO', funcionarioId: l.linha })), resumo: {} }));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    pg.el('importFileInput').files = [arquivoCsv(CSV_OK)];
    await pg.disparar('importFileInput', 'change');
    assert.equal(pg.el('blocoConfirmacaoAmbiguos').style.display, 'none');
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    assert.equal(chamadas.length, 1);
  });
});

describe('ajuste 2 — CPF na busca: só números ou pontuação usual; letras e símbolos recusados', () => {
  test('aceita 11 dígitos e o formato 000.000.000-00 (com espaços nas pontas); recusa letras, barras e espaços internos, mesmo que removê-los desse um CPF válido', () => {
    for (const valido of ['52998224725', '529.982.247-25', ' 529.982.247-25 ', '529982247-25']) {
      assert.deepEqual(F.historico.consulta('cpf', valido), { ok: true, filtro: { cpf: '52998224725' } }, valido);
    }
    for (const invalido of ['529a982b247c25', 'CPF 529.982.247-25', '529.982.247/25', '529 982 247 25', '529_982_247_25', '529.982.247-25x']) {
      const r = F.historico.consulta('cpf', invalido);
      assert.equal(r.ok, false, invalido);
      assert.match(r.mensagem, /somente números|pontuação/i, invalido);
    }
  });

  test('página: CPF com letras não gera requisição', async () => {
    servidor(resposta(200, { status: 'ok', funcionarios: [], total: 0, pagina: 1, limite: 20 }));
    const pg = montarPagina('pages/employee-history.html');
    await pg.esperar();
    pg.el('historyFilterType').value = 'cpf';
    pg.el('historySearchValue').value = '529a982b247c25';
    await pg.disparar('botaoConsultar');
    assert.equal(chamadas.length, 0);
  });
});

describe('ajuste 3 — logout durante a importação: nenhum lote novo; lote já enviado mantém a classificação', () => {
  const corpo = (numero, total, linhas) => ({ importacaoId: 'x', lote: { numero, total }, arquivo: {}, declaracaoLgpd: {}, linhas: linhas.map((l) => ({ linha: l })) });
  const ok = (linhas) => resposta(200, { status: 'ok', linhas: linhas.map((l) => ({ linha: l, situacao: 'CADASTRADO', funcionarioId: l })), resumo: {} });

  test('fluxo: deveContinuar falso antes de um lote → ele e os seguintes ficam NÃO ENVIADOS, sem requisição', async () => {
    servidor(ok([2]), ok([3]), ok([4]));
    let continuar = true;
    const r = await F.fluxo.importar([corpo(1, 3, [2]), corpo(2, 3, [3]), corpo(3, 3, [4])], {
      deveContinuar: () => continuar,
      aoProgresso: () => { continuar = false; }, // sessão encerrada logo depois do 1º lote
    });
    assert.equal(chamadas.length, 1);
    assert.deepEqual(r.linhas.map((l) => [l.linha, l.situacao]), [[2, 'CADASTRADO'], [3, 'NAO_ENVIADO'], [4, 'NAO_ENVIADO']]);
    assert.equal(r.interrupcao.motivo, 'SESSAO_ENCERRADA');
  });

  test('fluxo: lote já enviado quando a sessão acaba e cuja resposta falha → NÃO CONFIRMADO (não vira "não enviado"); nada é reenviado', async () => {
    let continuar = true;
    servidor(() => { continuar = false; return new TypeError('Failed to fetch'); });
    const r = await F.fluxo.importar([corpo(1, 2, [2, 3]), corpo(2, 2, [4])], { deveContinuar: () => continuar });
    assert.equal(chamadas.length, 1);
    assert.deepEqual(r.linhas.map((l) => [l.linha, l.situacao]), [[2, 'NAO_CONFIRMADO'], [3, 'NAO_CONFIRMADO'], [4, 'NAO_ENVIADO']]);
  });

  test('página: logout com o 1º lote em andamento — nenhum 2º lote é enviado depois', async () => {
    let liberar;
    const pendente = new Promise((r) => { liberar = r; });
    servidor((c) => (c.corpo.lote.numero === 1 ? pendente : ok(c.corpo.linhas.map((l) => l.linha))));
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    const linhasCsv = ['Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE'];
    for (let i = 0; i < 150; i += 1) linhasCsv.push(`F ${i};S;;${gerarCpf(i + 10)};M${i};;01/06/2020;C;Ativo;G`);
    pg.el('importFileInput').files = [arquivoCsv(`${linhasCsv.join('\r\n')}\r\n`)];
    await pg.disparar('importFileInput', 'change');
    pg.el('lgpdConsentImport').checked = true;
    const envio = pg.disparar('importConfirmBtn');
    await pg.esperar();
    assert.equal(chamadas.length, 1, '1º lote em andamento');
    pg.sandbox.opcoesMontar.aoEncerrar(); // Sair confirmado
    liberar(ok(Array.from({ length: 100 }, (_, i) => i + 2)));
    await envio;
    await pg.esperar();
    assert.equal(chamadas.length, 1, 'nenhum lote novo depois do encerramento da sessão');
  });
});

// 12K-E — GHE na prévia: resolução automática, seleção explícita pelo SST e envio por id.
describe('página Importar Funcionários — GHE na prévia (12K-E)', () => {
  // A rota do seletor devolve só os ATIVOS, com id e nome.
  const GHES_EMPRESA = [
    { id: 11, nome: 'LAMINAÇÃO\r\n(SPINNER BLOCK)' },
    { id: 12, nome: 'ALMOXARIFADO - INFLAMAVEL' },
  ];
  const importacaoOk = (c) => resposta(200, { status: 'ok', linhas: c.corpo.linhas.map((l) => ({ linha: l.linha, situacao: 'CADASTRADO', funcionarioId: l.linha })), resumo: {} });
  const CSV = (linhas) => `Nome;Setor;Cargo;Dt.Admissão;CPF;Situação;Nome GHE\r\n${linhas.join('\r\n')}\r\n`;
  const linha = (n, ghe) => `Pessoa ${n};Produção;Operador;01/06/2020;${gerarCpf(n)};Ativo;${ghe}`;
  const selecao = (numeroLinha, valor) => ({ target: { value: String(valor), className: 'import-ghe-select', getAttribute: (nome) => (nome === 'data-linha' ? String(numeroLinha) : null) } });
  const arquivo = (t) => Object.assign(new Blob([Buffer.from(t, 'utf8')]), { name: 'funcionarios.csv' });

  async function previa(linhas) {
    ghesDaEmpresa = GHES_EMPRESA;
    servidor(importacaoOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    pg.el('importFileInput').files = [arquivo(CSV(linhas))];
    await pg.disparar('importFileInput', 'change');
    return pg;
  }
  const contagem = (pg) => ({
    validos: Number(/Válidos<\/span><strong>(\d+)/.exec(pg.el('importSummary').innerHTML)[1]),
    erros: Number(/Com erro<\/span><strong>(\d+)/.exec(pg.el('importSummary').innerHTML)[1]),
  });

  test('a prévia consulta os GHEs da empresa; correspondência única com quebra de linha resolve sozinha, sem erro', async () => {
    const pg = await previa([linha(1, '"LAMINAÇÃO\r\n(SPINNER BLOCK)"'), linha(2, 'ALMOXARIFADO  -   INFLAMAVEL')]);
    assert.equal(chamadasGhes.length, 1, 'consulta a rota de opções da importação (GHEs ativos da empresa atual)');
    assert.deepEqual(contagem(pg), { validos: 2, erros: 0 });
    assert.equal(pg.el('importErrorsBox').style.display, 'none');
    assert.equal((pg.el('importPreviewBody').innerHTML.match(/<select/g) || []).length, 0);
  });

  test('vazio, não encontrado e ambíguo: erro apontado e "Selecionar GHE" na linha, sem nenhum GHE pré-selecionado', async () => {
    const pg = await previa([linha(1, 'ALMOXARIFADO - INFLAMAVEL'), linha(2, ''), linha(3, 'NAO EXISTE')]);
    assert.deepEqual(contagem(pg), { validos: 1, erros: 2 });
    const html = pg.el('importPreviewBody').innerHTML;
    assert.equal((html.match(/<select/g) || []).length, 2);
    assert.match(html, /Selecionar GHE/);
    assert.doesNotMatch(html, /selected/);
    assert.match(pg.el('importErrorsBox').innerHTML, /Linha 3: Nome GHE não informado/);
    assert.match(pg.el('importErrorsBox').innerHTML, /Linha 4: GHE não encontrado/);
    assert.equal((html.match(/<option value="\d+"/g) || []).length, 2 * GHES_EMPRESA.length, 'só os GHEs ativos da lista são opção');
  });

  test('a escolha explícita resolve só o GHE: contadores sobem, o erro some e o envio leva o gheId; sem escolha a pessoa não é importada', async () => {
    const pg = await previa([linha(1, 'ALMOXARIFADO - INFLAMAVEL'), linha(2, ''), linha(3, 'NAO EXISTE')]);
    await pg.disparar('importPreviewBody', 'change', selecao(3, 12));
    assert.deepEqual(contagem(pg), { validos: 2, erros: 1 });
    assert.doesNotMatch(pg.el('importErrorsBox').innerHTML, /Linha 3:/);
    assert.match(pg.el('importErrorsBox').innerHTML, /Linha 4:/);
    pg.el('lgpdConsentImport').checked = true;
    await pg.disparar('importConfirmBtn');
    const enviadas = chamadas.filter((c) => c.metodo === 'POST').flatMap((c) => c.corpo.linhas);
    assert.deepEqual(enviadas.map((l) => [l.linha, l.gheId]), [[2, 12], [3, 12]], 'a linha 4 (sem escolha) não é enviada');
  });

  test('escolha de GHE que não está na lista da empresa é ignorada; escolher "Selecionar GHE" de novo mantém a linha inválida', async () => {
    const pg = await previa([linha(1, 'NAO EXISTE')]);
    await pg.disparar('importPreviewBody', 'change', selecao(2, 999));
    assert.deepEqual(contagem(pg), { validos: 0, erros: 1 });
    await pg.disparar('importPreviewBody', 'change', selecao(2, 11));
    assert.deepEqual(contagem(pg), { validos: 1, erros: 0 });
    await pg.disparar('importPreviewBody', 'change', selecao(2, ''));
    assert.deepEqual(contagem(pg), { validos: 0, erros: 1 });
  });

  test('sem permissão ou falha para listar os GHEs: a validação local continua e a página avisa, sem seletor', async () => {
    ghesDaEmpresa = null;
    servidor(importacaoOk);
    const pg = montarPagina('pages/import-employees.html');
    await pg.esperar();
    pg.el('importFileInput').files = [arquivo(CSV([linha(1, 'QUALQUER'), linha(2, '')]))];
    await pg.disparar('importFileInput', 'change');
    assert.equal((pg.el('importPreviewBody').innerHTML.match(/<select/g) || []).length, 0);
    assert.deepEqual(contagem(pg), { validos: 1, erros: 1 });
    assert.match(pg.el('aviso').innerHTML, /GHE/);
  });
});
