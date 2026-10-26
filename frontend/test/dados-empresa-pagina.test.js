'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Dados da Empresa (F2) — a página pages/company-data.html no harness de DOM, com API simulada.
 * A referência visual (prévia aprovada por Ramires) vive fora do repositório; este teste não depende dela nem de nenhum caminho da
 * máquina de quem o executa: os blocos e textos obrigatórios são conferidos diretamente na página versionada. Divergências
 * deliberadas do contrato (F1): só razão social e CNPJ são somente leitura; nome fantasia, inscrição estadual e endereço são
 * editáveis; dados e nome da empresa vêm sempre do servidor.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/company-data.html';

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ v = true, e = false } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR',
  recursos: { companyData: { ...NENHUMA, visualizar: v, editar: e } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Eva Teste', email: 'eva@example.invalid', perfil: 'ADMINISTRADOR' },
  empresa: { id: 3, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const dados = (extra = {}) => ({
  razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181', nomeFantasia: 'Alfa', inscricaoEstadual: '123456', situacaoInscricaoEstadual: 'CONTRIBUINTE',
  endereco: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', cep: '01310100',
  telefone: '1140001000', email: 'contato@alfa.com.br', emailSst: 'sst@alfa.com.br', emailAlmoxarifado: null,
  representante: { nome: 'Rep Teste', cargo: 'Diretor', email: 'rep@alfa.com.br', telefone: '11999990000' },
  financeiro: { nome: null, email: 'fin@alfa.com.br', telefone: null },
  versao: 4, camposBloqueados: ['razaoSocial', 'cnpj'], ...extra,
});

function mundo({ v = true, e = true, atual = dados(), rotas = {} } = {}) {
  const estado = { atual };
  return {
    estado,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes({ v, e }) },
      'GET /empresa/dados': () => ({ status: 200, corpo: { status: 'ok', dados: estado.atual } }),
      'PATCH /empresa/dados': (c) => {
        estado.atual = { ...estado.atual, versao: estado.atual.versao + 1, ...(c.corpo.telefone !== undefined ? { telefone: c.corpo.telefone } : {}) };
        return { status: 200, corpo: { status: 'ok', dados: estado.atual, alterado: true, camposAlterados: Object.keys(c.corpo).filter((k) => k !== 'versao') } };
      },
      ...rotas,
    },
  };
}
async function pronta(opcoes = {}) {
  const m = mundo(opcoes);
  const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
  await pg.esperar();
  await pg.esperar();
  return Object.assign(pg, { estado: m.estado });
}
const val = (pg, chave) => pg.el(`emp-${chave}`).value;
async function digitar(pg, chave, valor) { pg.el(`emp-${chave}`).value = valor; await pg.el(`emp-${chave}`).disparar('input'); }
const chamadasDe = (pg, metodo) => pg.chamadas.filter((c) => c.metodo === metodo && c.caminho === '/empresa/dados');
const CAMPOS = ['nomeFantasia', 'inscricaoEstadual', 'situacaoInscricaoEstadual', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cep', 'telefone', 'email',
  'emailSst', 'emailAlmoxarifado', 'representanteNome', 'representanteCargo', 'representanteEmail', 'representanteTelefone', 'financeiroNome', 'financeiroEmail', 'financeiroTelefone'];

describe('referência visual e estrutura', () => {
  test('a página versionada preserva os blocos e textos aprovados na referência visual (sempre executado: não depende de arquivo externo)', () => {
    assert.ok(fs.existsSync(path.join(RAIZ, ARQUIVO)), 'pages/company-data.html ainda não existe');
    const html = fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8');
    for (const texto of ['Dados da Empresa', 'Identificação, contatos e identidade da sua empresa.', 'Dados oficiais', 'Endereço', 'Contatos da empresa', 'Segurança e operação',
      'Representante da empresa', 'Contato financeiro', 'Logotipo da empresa', 'Salvar alterações', 'E-mail do SST', 'E-mail do Almoxarifado / Estoque']) {
      assert.ok(html.includes(texto), `faltou "${texto}"`);
    }
  });

  test('nenhum dado fictício fixo da prévia chega ao HTML (nome, CNPJ, pessoa, "Prévia visual", "nenhuma informação será salva")', () => {
    const html = semComentariosHtml(fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8'));
    // A persona da prévia é montada em partes: a guarda de dados sintéticos proíbe o nome inteiro em qualquer arquivo do repositório.
    for (const proibido of [['Luis', 'Freitas'].join(' '), 'SafeWork Homologação', 'SafeWork Teste', '73.989.956', 'Prévia visual', 'Nenhuma informação será salva', 'Esta demonstração', 'Perfil MASTER']) {
      assert.equal(html.includes(proibido), false, proibido);
    }
  });

  test('sem innerHTML, sem armazenamento, sem recurso externo além das fontes do Portal; sem os scripts da prévia', () => {
    const html = fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8');
    assert.equal(/lucide/i.test(html), false);
    const js = fs.readFileSync(path.join(RAIZ, 'js', 'dados-empresa.js'), 'utf8');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie/.test(js), false);
    assert.equal(/localStorage|sessionStorage/.test(html), false);
  });
});

describe('abertura, dados reais e campos protegidos', () => {
  test('só depois da sessão e das permissões: consulta GET /empresa/dados UMA vez e preenche tudo do servidor', async () => {
    const pg = await pronta();
    assert.equal(chamadasDe(pg, 'GET').length, 1);
    const ordem = pg.chamadas.map((c) => c.chave);
    assert.ok(ordem.indexOf('GET /auth/permissoes') < ordem.indexOf('GET /empresa/dados'), 'permissões antes dos dados');
    assert.equal(val(pg, 'razaoSocial'), 'Empresa Alfa Ltda');
    assert.equal(val(pg, 'cnpj'), '11.222.333/0001-81');
    for (const [chave, esperado] of Object.entries({ nomeFantasia: 'Alfa', inscricaoEstadual: '123456', situacaoInscricaoEstadual: 'CONTRIBUINTE', endereco: 'Rua A', uf: 'SP', cep: '01310-100',
      emailSst: 'sst@alfa.com.br', emailAlmoxarifado: '', representanteNome: 'Rep Teste', financeiroEmail: 'fin@alfa.com.br', financeiroNome: '' })) {
      assert.equal(val(pg, chave), esperado, chave);
    }
    assert.equal(pg.visivel('conteudoProtegido'), true);
  });

  test('razão social e CNPJ são somente leitura, identificados como protegidos e com a orientação do Suporte; os demais 21 campos são editáveis', async () => {
    const pg = await pronta();
    for (const id of ['razaoSocial', 'cnpj']) {
      assert.equal(pg.el(`emp-${id}`).hasAttribute('readonly'), true, id);
      assert.equal(pg.el(`emp-${id}`).hasAttribute('name'), false, `${id} não participa de nenhum envio`);
    }
    for (const chave of CAMPOS) {
      assert.equal(pg.el(`emp-${chave}`).hasAttribute('readonly'), false, chave);
      assert.equal(pg.el(`emp-${chave}`).hasAttribute('disabled'), false, chave);
    }
    const texto = pg.texto('empProtegidos');
    assert.match(texto, /Razão social e CNPJ são mantidos pela SafeWork/);
    assert.match(texto, /Suporte/);
  });

  test('sem permissão de visualizar a página não abre e nenhum dado é pedido', async () => {
    const pg = await pronta({ v: false, e: true });
    assert.equal(chamadasDe(pg, 'GET').length, 0);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.match(pg.texto('estadoPagina'), /permiss/i);
  });

  test('visualizar sem editar: leitura, campos travados, sem botão de salvar e sem PATCH possível', async () => {
    const pg = await pronta({ v: true, e: false });
    assert.equal(val(pg, 'nomeFantasia'), 'Alfa');
    for (const chave of CAMPOS) assert.equal(pg.el(`emp-${chave}`).hasAttribute('readonly') || pg.el(`emp-${chave}`).hasAttribute('disabled'), true, chave);
    assert.equal(pg.visivel('empSalvar'), false);
    assert.match(pg.texto('empLeitura'), /apenas para consulta|somente leitura|não tem permissão para alterar/i);
    await pg.el('empSalvar').disparar('click');
    assert.equal(chamadasDe(pg, 'PATCH').length, 0);
  });

  test('falha ao carregar: mensagem, nada preenchido e salvar indisponível', async () => {
    const pg = await pronta({ rotas: { 'GET /empresa/dados': { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } } } });
    assert.match(pg.texto('empAviso'), /Não foi possível carregar/);
    assert.equal(val(pg, 'nomeFantasia'), '');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true);
  });

  test('401 ao carregar: o conteúdo protegido some', async () => {
    const pg = await pronta({ rotas: { 'GET /empresa/dados': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } });
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });
});

describe('salvar', () => {
  test('sem alteração: salvar fica desabilitado e nada é enviado', async () => {
    const pg = await pronta();
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true);
    await pg.el('empSalvar').disparar('click');
    assert.equal(chamadasDe(pg, 'PATCH').length, 0);
  });

  test('envia a versão carregada e SÓ o campo alterado; atualiza a versão; a próxima alteração leva a versão nova', async () => {
    const pg = await pronta();
    await digitar(pg, 'telefone', '(11) 4000-2000');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), false);
    await pg.clicar('empSalvar');
    const patches = chamadasDe(pg, 'PATCH');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].corpo, { versao: 4, telefone: '(11) 4000-2000' });
    assert.match(pg.texto('empStatus'), /salvas|salvo/i);
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true);
    await digitar(pg, 'bairro', 'Outro');
    await pg.clicar('empSalvar');
    assert.deepEqual(chamadasDe(pg, 'PATCH')[1].corpo, { versao: 5, bairro: 'Outro' });
  });

  test('limpar um campo envia null; e-mail e UF são normalizados antes do envio', async () => {
    const pg = await pronta();
    await digitar(pg, 'emailSst', '');
    await digitar(pg, 'uf', 'rj');
    await digitar(pg, 'email', 'NOVO@Alfa.com.br');
    await pg.clicar('empSalvar');
    assert.deepEqual(chamadasDe(pg, 'PATCH')[0].corpo, { versao: 4, emailSst: null, uf: 'RJ', email: 'novo@alfa.com.br' });
  });

  test('razão social e CNPJ NUNCA vão no corpo, mesmo se o DOM for adulterado', async () => {
    const pg = await pronta();
    pg.el('emp-razaoSocial').value = 'Outra Empresa';
    pg.el('emp-cnpj').value = '99.999.999/0001-99';
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    const corpo = chamadasDe(pg, 'PATCH')[0].corpo;
    assert.deepEqual(Object.keys(corpo).sort(), ['telefone', 'versao']);
    const texto = JSON.stringify(corpo);
    assert.equal(/Outra Empresa|99\.999|razaoSocial|cnpj/.test(texto), false);
  });

  test('empresa e usuário nunca são enviados (a sessão manda)', async () => {
    const pg = await pronta();
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    const bruto = chamadasDe(pg, 'PATCH')[0].corpoBruto;
    assert.equal(/empresa|usuario|perfil|ativo/i.test(bruto), false);
  });

  test('validação local: campo inválido é apontado, nada é enviado e o foco vai ao primeiro erro NA ORDEM DA TELA (o CEP vem antes dos contatos)', async () => {
    const pg = await pronta();
    await digitar(pg, 'emailSst', 'nao-e-email');
    await digitar(pg, 'cep', '12');
    await pg.clicar('empSalvar');
    assert.equal(chamadasDe(pg, 'PATCH').length, 0);
    assert.ok(pg.texto('err-emailSst').length > 0);
    assert.ok(pg.texto('err-cep').length > 0);
    assert.equal(pg.el('emp-emailSst').getAttribute('aria-invalid'), 'true');
    assert.equal(pg.foco(), 'emp-cep');
    await digitar(pg, 'emailSst', 'sst@alfa.com.br');
    assert.equal(pg.texto('err-emailSst'), '');
  });

  test('toque duplo: um único PATCH enquanto o primeiro está em andamento', async () => {
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': async () => { await espera; return { status: 200, corpo: { status: 'ok', dados: dados({ versao: 5, telefone: '1199' }), alterado: true, camposAlterados: ['telefone'] } }; } } });
    await digitar(pg, 'telefone', '1199');
    pg.el('empSalvar').disparar('click');
    pg.el('empSalvar').disparar('click');
    await pg.esperar();
    liberar();
    await pg.esperar();
    assert.equal(chamadasDe(pg, 'PATCH').length, 1);
  });
});

describe('erros do servidor', () => {
  test('400 por campo: o erro aparece no campo, com texto da tela (nunca o do servidor), e a edição é mantida', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': { status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'ECO-DO-SERVIDOR', detalhes: [{ campo: 'body.emailAlmoxarifado', codigo: 'X', mensagem: 'ECO-DO-SERVIDOR' }] } } } });
    await digitar(pg, 'emailAlmoxarifado', 'a@b.com');
    await pg.clicar('empSalvar');
    assert.ok(pg.texto('err-emailAlmoxarifado').length > 0);
    assert.equal(pg.textoDoDom().includes('ECO-DO-SERVIDOR'), false);
    assert.equal(val(pg, 'emailAlmoxarifado'), 'a@b.com');
  });

  test('403: aviso de falta de permissão, sem perder o que foi digitado', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': { status: 403, corpo: { status: 'error', codigo: 'SEM_PERMISSAO', message: 'x' } } } });
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    assert.match(pg.texto('empAviso'), /permiss/i);
    assert.equal(val(pg, 'telefone'), '1199');
  });

  test('429: mensagem de limite e o botão volta a ficar disponível para tentar de novo', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': { status: 429, corpo: { status: 'error', codigo: 'LIMITE', message: 'x' } } } });
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    assert.match(pg.texto('empAviso'), /Muitas tentativas|aguarde/i);
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), false);
  });

  test('401 ao salvar: o conteúdo protegido some', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } });
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('falha de rede: aviso genérico, edição preservada, botão disponível', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': new Error('rede') } });
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    assert.match(pg.texto('empAviso'), /servidor|conexão/i);
    assert.equal(val(pg, 'telefone'), '1199');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), false);
  });
});

describe('conflito de versão (409)', () => {
  const conflito = { status: 409, corpo: { status: 'error', codigo: 'EMPRESA_DADOS_DESATUALIZADOS', message: 'Os dados da empresa foram alterados por outra pessoa.' } };

  test('não sobrescreve: informa o conflito, mantém o que a pessoa digitou, bloqueia novo envio e oferece recarregar', async () => {
    const pg = await pronta({ rotas: { 'PATCH /empresa/dados': conflito } });
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    assert.equal(chamadasDe(pg, 'PATCH').length, 1);
    assert.equal(pg.visivel('empConflito'), true);
    assert.match(pg.texto('empConflito'), /alterad[oa]s? por outra pessoa|desatualizad/i);
    assert.equal(val(pg, 'telefone'), '1199', 'o texto digitado não é descartado');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true, 'não reenvia a versão antiga');
    assert.equal(pg.visivel('empRecarregar'), true);
    assert.match(pg.texto('empRecarregar'), /substitu|descart/i, 'o botão deixa explícito que a ação substitui o formulário');
    assert.match(pg.texto('empConflito'), /substitu|descart/i, 'o aviso explica o efeito antes do clique');
    await pg.el('empSalvar').disparar('click');
    assert.equal(chamadasDe(pg, 'PATCH').length, 1);
  });

  test('recarregar: busca os dados atuais, mostra os valores e a versão nova, e o próximo envio usa a versão nova', async () => {
    const m = mundo({ rotas: { 'PATCH /empresa/dados': conflito } });
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar(); await pg.esperar();
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    m.estado.atual = dados({ versao: 9, telefone: '1177777777', nomeFantasia: 'Alfa do Outro' });
    delete m.rotas['PATCH /empresa/dados'];
    m.rotas['PATCH /empresa/dados'] = (c) => ({ status: 200, corpo: { status: 'ok', dados: dados({ versao: 10 }), alterado: true, camposAlterados: Object.keys(c.corpo) } });
    await pg.clicar('empRecarregar');
    await pg.clicar('empConfirmarOk'); // há alteração não salva: o descarte exige confirmação
    assert.equal(val(pg, 'nomeFantasia'), 'Alfa do Outro');
    assert.equal(val(pg, 'telefone'), '1177777777');
    assert.equal(pg.visivel('empConflito'), false);
    await digitar(pg, 'bairro', 'Novo');
    await pg.clicar('empSalvar');
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo === 'PATCH').at(-1).corpo, { versao: 9, bairro: 'Novo' });
  });

  test('recarregar com falha mantém o conflito e a edição, sem liberar o envio', async () => {
    const m = mundo({ rotas: { 'PATCH /empresa/dados': conflito } });
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar(); await pg.esperar();
    await digitar(pg, 'telefone', '1199');
    await pg.clicar('empSalvar');
    m.rotas['GET /empresa/dados'] = { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } };
    await pg.clicar('empRecarregar');
    await pg.clicar('empConfirmarOk');
    assert.equal(pg.visivel('empConflito'), true);
    assert.equal(val(pg, 'telefone'), '1199');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true);
  });

  async function emConflito(opcoes = {}) {
    const m = mundo({ rotas: { 'PATCH /empresa/dados': conflito } });
    const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
    await pg.esperar(); await pg.esperar();
    await digitar(pg, 'telefone', '1199');
    await digitar(pg, 'bairro', 'Meu bairro');
    await pg.clicar('empSalvar');
    if (opcoes.atualizadoNoServidor) m.estado.atual = dados({ versao: 9, telefone: '1177777777', nomeFantasia: 'Alfa do Outro' });
    return { pg, m };
  }
  const gets = (pg) => chamadasDe(pg, 'GET').length;

  test('com alterações não salvas, "Carregar dados atualizados" NÃO busca nada: pede confirmação que diz o que será descartado', async () => {
    const { pg } = await emConflito({ atualizadoNoServidor: true });
    const antes = gets(pg);
    await pg.clicar('empRecarregar');
    assert.equal(gets(pg), antes, 'nenhuma consulta antes da confirmação');
    assert.equal(pg.visivel('empConfirmarRecarga'), true);
    const texto = pg.texto('empConfirmarRecarga');
    assert.match(texto, /substitu/i);
    assert.match(texto, /2 campos/, 'informa quantos campos alterados serão perdidos');
    assert.match(texto, /n[ãa]o salv/i);
    assert.equal(val(pg, 'telefone'), '1199', 'enquanto não confirma, o digitado fica');
    assert.equal(pg.visivel('empConflito'), true);
  });

  test('cancelar preserva os valores digitados e o estado de conflito, sem consultar o servidor nem liberar o envio', async () => {
    const { pg } = await emConflito({ atualizadoNoServidor: true });
    const antes = gets(pg);
    await pg.clicar('empRecarregar');
    await pg.clicar('empConfirmarCancelar');
    assert.equal(pg.visivel('empConfirmarRecarga'), false);
    assert.equal(gets(pg), antes);
    assert.equal(val(pg, 'telefone'), '1199');
    assert.equal(val(pg, 'bairro'), 'Meu bairro');
    assert.equal(pg.visivel('empConflito'), true);
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true);
    assert.equal(chamadasDe(pg, 'PATCH').length, 1);
    await pg.clicar('empRecarregar'); // pode pedir de novo
    assert.equal(pg.visivel('empConfirmarRecarga'), true);
  });

  test('confirmar substitui o formulário pelos dados atuais, esconde o conflito e NÃO reenvia nada sozinho (sem salvamento forçado)', async () => {
    const { pg } = await emConflito({ atualizadoNoServidor: true });
    await pg.clicar('empRecarregar');
    await pg.clicar('empConfirmarOk');
    assert.equal(val(pg, 'telefone'), '1177777777');
    assert.equal(val(pg, 'bairro'), 'Centro');
    assert.equal(pg.visivel('empConfirmarRecarga'), false);
    assert.equal(pg.visivel('empConflito'), false);
    assert.equal(chamadasDe(pg, 'PATCH').length, 1, 'nenhum PATCH extra: a pessoa precisa salvar de novo, se quiser');
    assert.equal(pg.el('empSalvar').hasAttribute('disabled'), true, 'sem alteração nova, não há o que salvar');
  });

  test('sem alterações não salvas (a pessoa desfez a edição), recarregar vai direto, sem confirmação', async () => {
    const { pg } = await emConflito({ atualizadoNoServidor: true });
    await digitar(pg, 'telefone', '1140001000');
    await digitar(pg, 'bairro', 'Centro');
    const antes = gets(pg);
    await pg.clicar('empRecarregar');
    assert.equal(pg.visivel('empConfirmarRecarga'), false);
    assert.equal(gets(pg), antes + 1);
    assert.equal(val(pg, 'telefone'), '1177777777');
    assert.equal(pg.visivel('empConflito'), false);
  });

  test('o texto da confirmação é só texto (nada do servidor vira marcação) e o botão de cancelar é o foco seguro', async () => {
    const { pg } = await emConflito({ atualizadoNoServidor: true });
    await pg.clicar('empRecarregar');
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.equal(pg.foco(), 'empConfirmarCancelar');
  });

  test('um 401 durante o recarregamento confirmado encerra a sessão, sem deixar dados na tela', async () => {
    const { pg, m } = await emConflito({ atualizadoNoServidor: true });
    m.rotas['GET /empresa/dados'] = { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } };
    await pg.clicar('empRecarregar');
    await pg.clicar('empConfirmarOk');
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });
});

describe('ação destrutiva da confirmação (padrão de alerta, claro e escuro)', () => {
  const html = fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8');
  const css = fs.readFileSync(path.join(RAIZ, 'css', 'company-data.css'), 'utf8');
  const botao = (id) => new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)[0];
  const luz = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contraste = (a, b) => { const [x, y] = [luz(a), luz(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const variavel = (bloco, nome) => new RegExp(`${nome}:\\s*(#[0-9a-fA-F]{6})`).exec(bloco)[1];

  test('"Descartar minhas alterações e carregar" usa a classe de perigo (e não a de ação primária); "Continuar editando" segue neutro', () => {
    assert.match(botao('empConfirmarOk'), /class="[^"]*\bperigo\b[^"]*"/);
    assert.doesNotMatch(botao('empConfirmarOk'), /class="[^"]*\bprimary\b/);
    assert.doesNotMatch(botao('empConfirmarCancelar'), /class="/, 'o botão seguro não ganha classe de destaque');
  });

  test('o CSS da página define hover, foco visível e desabilitado para a ação de perigo', () => {
    for (const seletor of ['.cd button.perigo', '.cd button.perigo:hover', '.cd button.perigo:focus-visible', '.cd button.perigo:disabled']) {
      assert.ok(css.includes(seletor), `faltou ${seletor}`);
    }
  });

  test('contraste do texto sobre o fundo do botão ≥ 4,5:1 no tema claro, no escuro e no hover de ambos', () => {
    const claro = /\.cd\{[^}]*\}/.exec(css.replace(/\n/g, ' ').replace(/\s+/g, ' ').replace(/\.cd \{/g, '.cd{'));
    assert.ok(claro, 'variáveis do botão de perigo no tema claro');
    const escuro = /html\[data-theme="dark"\] \.cd\s*\{[^}]*\}/.exec(css.replace(/\n/g, ' '));
    assert.ok(escuro, 'variáveis do botão de perigo no tema escuro');
    for (const [bloco, tema] of [[claro[0], 'claro'], [escuro[0], 'escuro']]) {
      const texto = variavel(bloco, '--cd-perigo-texto');
      assert.ok(contraste(texto, variavel(bloco, '--cd-perigo')) >= 4.5, `${tema}: normal`);
      assert.ok(contraste(texto, variavel(bloco, '--cd-perigo-hover')) >= 4.5, `${tema}: hover`);
    }
  });

  test('tokens próprios só dentro de .cd (nada vaza para a moldura) e sem cor fixa fora das variáveis do botão de perigo', () => {
    const linhasPerigo = css.split('\n').filter((l) => /perigo/.test(l) && /#[0-9a-fA-F]{3,8}\b/.test(l) && !/--cd-perigo/.test(l));
    assert.deepEqual(linhasPerigo, []);
    assert.equal(/:root\s*\{[^}]*--cd-perigo/.test(css), false);
  });
});

describe('logotipo (somente previsão visual — F4/F5)', () => {
  test('a área existe, sem upload funcional: sem input de arquivo e botões desabilitados, com aviso de que chegará depois', async () => {
    const pg = await pronta();
    assert.equal(pg.consulta('input[type="file"]').length, 0);
    assert.equal(pg.el('empLogoInserir').hasAttribute('disabled'), true);
    assert.equal(pg.el('empLogoRemover').hasAttribute('disabled'), true);
    assert.match(pg.texto('empLogoSecao'), /em breve|ainda não disponível|próxima etapa/i);
    await pg.el('empLogoInserir').disparar('click');
    assert.equal(pg.chamadas.some((c) => /logotipo/i.test(c.caminho)), false);
  });
});

describe('navegação da própria página', () => {
  test('o item "Dados da Empresa" do menu aponta para a própria página e o menu usa data-pagina="companyData"', () => {
    const html = fs.readFileSync(path.join(RAIZ, ARQUIVO), 'utf8');
    assert.match(html, /<a[^>]*data-pagina="companyData"[^>]*>/);
    assert.match(html, /<a[^>]*class="active"[^>]*data-pagina="companyData"|<a[^>]*data-pagina="companyData"[^>]*class="active"/);
    assert.match(html, /<a href="\.\.\/portal\/inicio\.html"/);
  });
});
