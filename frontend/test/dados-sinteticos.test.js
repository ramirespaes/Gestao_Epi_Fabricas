'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Dados de demonstração inequivocamente sintéticos (segurança S2 da
 * auditoria do Bloco 9). O repositório é público: pessoas usadas como
 * usuários fictícios, e-mails de domínio real usados como credencial ou
 * exemplo e senhas em texto do protótipo não podem voltar.
 *
 * Referências à Cobresul como contexto do projeto (RFC, razão social de
 * teste, títulos) são legítimas e não são alvo desta guarda.
 */

const RAIZ_REPOSITORIO = path.resolve(__dirname, '..', '..');
const ESTE_ARQUIVO = path.resolve(__filename);
const IGNORADOS = new Set(['node_modules', 'coverage', '.git']);
const BINARIOS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.docx', '.zip', '.dump', '.woff', '.woff2']);

// Em todo o frontend e o backend (código, testes, scripts e documentação).
const PROIBIDOS = [
  { regra: 'e-mail do domínio da Cobresul', padrao: /@cobresul\.com\.br/i },
  { regra: 'senha em texto do protótipo', padrao: /\b(?:Master|Admin|Super|User)@2026\b/ },
  { regra: 'pessoa usada como usuário fictício', padrao: /Luis Freitas|Tainara Alves|F[aá]bio Santos|Marcos Silva/ },
  // Só as formas de e-mail das personas; 'Luis@x.com' genérico (comentário das
  // migrations 005 e 025, imutáveis) e os exemplos de normalização não são persona.
  { regra: 'e-mail pessoal das personas do protótipo', padrao: /\b(?:luis\.freitas|tainara(?:\.alves)?|fabio\.santos|marcos(?:\.silva)?)@/i },
];
// No código do protótipo e das páginas (fora dos testes): exemplos só em domínio reservado.
const PROIBIDOS_NO_FRONTEND = [
  { regra: 'e-mail de exemplo em domínio registrável', padrao: /@empresa\.com\b/i },
];

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (IGNORADOS.has(e.name)) return [];
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return arquivos(abs);
    return e.isFile() && !BINARIOS.has(path.extname(e.name).toLowerCase()) && abs !== ESTE_ARQUIVO ? [abs] : [];
  });
}

function violacoes(raiz, regras) {
  const achados = [];
  for (const arquivo of arquivos(raiz)) {
    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
    linhas.forEach((linha, i) => {
      for (const { regra, padrao } of regras) {
        if (padrao.test(linha)) achados.push(`${path.relative(RAIZ_REPOSITORIO, arquivo)}:${i + 1} — ${regra}`);
      }
    });
  }
  return achados;
}

describe('dados de demonstração inequivocamente sintéticos', () => {
  test('frontend e backend sem personas do protótipo, e-mails da Cobresul ou senhas em texto', () => {
    const achados = [
      ...violacoes(path.join(RAIZ_REPOSITORIO, 'frontend'), PROIBIDOS),
      ...violacoes(path.join(RAIZ_REPOSITORIO, 'backend'), PROIBIDOS),
    ];
    assert.deepEqual(achados, [], `${achados.length} ocorrência(s):\n${achados.slice(0, 40).join('\n')}`);
  });

  test('protótipo e páginas usam somente domínio reservado nos e-mails de exemplo', () => {
    const achados = ['js', 'pages', 'portal', 'painel-privado', 'institucional']
      .flatMap((d) => violacoes(path.join(RAIZ_REPOSITORIO, 'frontend', d), PROIBIDOS_NO_FRONTEND));
    assert.deepEqual(achados, [], `${achados.length} ocorrência(s):\n${achados.slice(0, 40).join('\n')}`);
  });
});
