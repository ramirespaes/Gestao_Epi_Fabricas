'use strict';

/**
 * Compatibilidade entre uma release do backend e o estado persistente observado.
 * Espelha a guarda de inicialização do backend (que recusa subir com migration
 * pendente ou com banco à frente do código) e acrescenta contratos de dados
 * versionados. Função pura: não lê banco, não escreve nada.
 *
 * Estado observado (produzido por uma sonda de leitura, fora deste módulo):
 *   { banco, origem, coletadoEm (ISO), migrations: [nome], contratos: { nome: versão } }
 */

const ACOES = new Set(['instalar', 'reverter']);
const IDADE_PADRAO_MS = 15 * 60 * 1000;
const TOLERANCIA_FUTURO_MS = 60 * 1000;
const NOME_DE_CONTRATO = /^[a-z][a-z0-9-]*$/;

class ErroCompatibilidade extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroCompatibilidade';
    this.codigo = codigo;
  }
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const semSql = (nome) => nome.replace(/\.sql$/, '');
// Texto sem conteúdo visível (inclui espaços Unicode e caracteres de largura zero).
const emBranco = (s) => typeof s !== 'string' || /^[\s­​-‍⁠﻿]*$/.test(s);

function listaCurta(nomes, maximo = 5) {
  const mostrados = nomes.slice(0, maximo).join(', ');
  return nomes.length > maximo ? `${mostrados} (+${nomes.length - maximo})` : mostrados;
}

function contratosValidos(contratos) {
  return ehObjeto(contratos) && Object.entries(contratos).every(([n, v]) => NOME_DE_CONTRATO.test(n) && Number.isInteger(v) && v >= 1);
}

function validarRelease(release) {
  const problemas = [];
  if (!ehObjeto(release) || !Array.isArray(release.migrations) || release.migrations.length === 0
    || !release.migrations.every((m) => ehObjeto(m) && typeof m.nome === 'string' && m.nome !== '')) {
    problemas.push({ codigo: 'RELEASE_INVALIDA', mensagem: 'a release não declara a lista de migrations' });
  } else if (!contratosValidos(release.contratos)) {
    problemas.push({ codigo: 'RELEASE_INVALIDA', mensagem: 'a release precisa declarar contratos (objeto, vazio se não houver)' });
  }
  return problemas;
}

function validarObservado(observado, agora, idadeMaximaMs) {
  if (!ehObjeto(observado)) return [{ codigo: 'OBSERVADO_AUSENTE', mensagem: 'estado persistente observado ausente: sem ele a compatibilidade não pode ser provada' }];
  const invalido = (motivo) => [{ codigo: 'OBSERVADO_INVALIDO', mensagem: `estado observado inválido: ${motivo}` }];
  if (emBranco(observado.banco)) return invalido('banco');
  if (emBranco(observado.origem)) return invalido('origem');
  if (!Array.isArray(observado.migrations) || !observado.migrations.every((n) => typeof n === 'string' && n !== '')
    || new Set(observado.migrations.map(semSql)).size !== observado.migrations.length) return invalido('migrations');
  if (!contratosValidos(observado.contratos)) return invalido('contratos (obrigatório, objeto vazio se não houver)');
  const coletado = typeof observado.coletadoEm === 'string' ? Date.parse(observado.coletadoEm) : NaN;
  if (Number.isNaN(coletado)) return invalido('coletadoEm');
  if (coletado > agora + TOLERANCIA_FUTURO_MS) return invalido('coletadoEm no futuro');
  if (agora - coletado > idadeMaximaMs) return [{ codigo: 'OBSERVADO_ANTIGO', mensagem: `estado observado coletado há mais de ${Math.round(idadeMaximaMs / 60000)} minutos` }];
  return [];
}

function avaliarCompatibilidade({ acao, release, observado, agora = Date.now(), idadeMaximaMs = IDADE_PADRAO_MS } = {}) {
  if (!ACOES.has(acao)) throw new ErroCompatibilidade('ACAO_INVALIDA', `ação desconhecida: ${acao}`);
  const estruturais = [...validarRelease(release), ...validarObservado(observado, agora, idadeMaximaMs)];
  if (estruturais.length > 0) return { ok: false, bloqueios: estruturais, avisos: [] };

  const bloqueios = [];
  const avisos = [];
  const doCodigo = new Set(release.migrations.map((m) => semSql(m.nome)));
  const doBanco = new Set(observado.migrations.map(semSql));
  const aFrente = [...doBanco].filter((n) => !doCodigo.has(n)).sort();
  const pendentes = [...doCodigo].filter((n) => !doBanco.has(n)).sort();
  if (aFrente.length > 0) {
    bloqueios.push({ codigo: 'BANCO_A_FRENTE_DO_CODIGO', mensagem: `o banco tem migration(s) que esta release não possui: ${listaCurta(aFrente)}; voltar o código sem restaurar o banco é bloqueado` });
  }
  if (pendentes.length > 0) {
    bloqueios.push({ codigo: 'MIGRATIONS_PENDENTES', mensagem: `migration(s) pendente(s) no banco: ${listaCurta(pendentes)}; aplicar migrations é um gate separado e anterior à troca do backend` });
  }

  const doRelease = release.contratos;
  const dosDados = observado.contratos;
  for (const [nome, versaoDados] of Object.entries(dosDados)) {
    if (!Object.hasOwn(doRelease, nome)) {
      bloqueios.push({ codigo: 'CONTRATO_DESCONHECIDO', mensagem: `os dados usam o contrato "${nome}" (versão ${versaoDados}) que esta release não declara` });
    } else if (doRelease[nome] < versaoDados) {
      bloqueios.push({ codigo: 'CONTRATO_A_FRENTE', mensagem: `os dados estão no contrato "${nome}" versão ${versaoDados}, acima da versão ${doRelease[nome]} desta release` });
    } else if (doRelease[nome] > versaoDados) {
      avisos.push({ codigo: 'CONTRATO_EVOLUI', mensagem: `a release usa o contrato "${nome}" versão ${doRelease[nome]}; os dados estão na ${versaoDados}` });
    }
  }
  for (const [nome, versao] of Object.entries(doRelease)) {
    if (!Object.hasOwn(dosDados, nome)) avisos.push({ codigo: 'CONTRATO_NOVO', mensagem: `a release declara o contrato "${nome}" versão ${versao}, ainda sem dados` });
  }
  return { ok: bloqueios.length === 0, bloqueios, avisos };
}

module.exports = { avaliarCompatibilidade, ErroCompatibilidade, IDADE_PADRAO_MS };
