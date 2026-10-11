'use strict';

/**
 * Documento da exportação, independente do formato: transforma o MODELO (dados autorizados, já sem CPF e sem campos
 * excluídos) em cabeçalho e seções de texto. O PDF e o XLSX desenham o MESMO documento, então mostram os mesmos dados.
 * Os rótulos e regras de exibição são os da tela do Histórico de Funcionários (pacotes A–H): datas dd/mm/aaaa, instantes
 * no fuso de São Paulo, "—" para valor ausente, GHE gravado só pelo id marcado como identificação atual.
 */

const FUSO = 'America/Sao_Paulo';
const VAZIO = '—';
const ROTULOS_TIPO = { CADASTRO: 'Cadastro', IMPORTACAO: 'Importação', ALTERACAO: 'Alteração' };
const ROTULOS_SITUACAO = { ATIVO: 'Ativo', AFASTADO: 'Afastado', INATIVO: 'Inativo' };
const ROTULOS_CAMPO = { nome: 'Nome', matricula: 'Matrícula', setor: 'Setor', funcao: 'Cargo / função', dataAdmissao: 'Data de admissão' };
const ROTULOS_ORIGEM = { DIRETA: 'Direta', SOLICITACAO: 'Por solicitação' };
const ROTULOS_MOTIVO = {
  ADMISSAO: 'Admissão', SUBSTITUICAO_PRAZO: 'Substituição por prazo', DESGASTE_DANO: 'Desgaste ou dano', PERDA_EXTRAVIO: 'Perda ou extravio', OUTRO: 'Outro',
};
const OMITIDA = 'Seção omitida: quem exportou não tem permissão para ver a ficha de EPI.';

const texto = (v) => (v === null || v === undefined ? '' : String(v));
const ouVazio = (v) => { const t = texto(v).trim(); return t === '' ? VAZIO : t; };
const rotulo = (tabela, v) => (Object.hasOwn(tabela, v) ? tabela[v] : VAZIO);

function data(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto(iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : VAZIO;
}

function instante(valor) {
  const d = valor instanceof Date ? valor : new Date(texto(valor));
  if (texto(valor) === '' || Number.isNaN(d.getTime())) return { data: VAZIO, hora: VAZIO };
  const p = {};
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { data: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour}:${p.minute}` };
}

function ghe(g) {
  if (!g) return VAZIO;
  const codigo = texto(g.codigo).trim();
  const descricao = texto(g.descricao).trim();
  if (codigo && descricao) return `${codigo} — ${descricao}`;
  return codigo || descricao || VAZIO;
}

function gheEvento(g) {
  if (g === null || g === undefined) return 'Sem GHE';
  const historico = ghe({ codigo: g.codigo, descricao: g.descricao });
  if (historico !== VAZIO) return historico;
  const atual = g.atual ? ghe(g.atual) : VAZIO;
  return atual !== VAZIO ? `${atual} (identificação atual)` : 'GHE histórico sem identificação disponível';
}

const valorCadastral = (campo, v) => (campo === 'dataAdmissao' ? data(v) : ouVazio(v));
const responsavel = (r) => ouVazio(r && r.nome);
const quando = (e) => instante(e.ocorridoEm);

function periodoTexto(periodo) {
  return periodo ? `${data(periodo.de)} a ${data(periodo.ate)}` : 'Todo o histórico';
}

function tabela(id, titulo, colunas, linhas, { omitida = false, periodo } = {}) {
  return {
    id, titulo, tipo: 'tabela', colunas, linhas, omitida, mensagem: omitida ? OMITIDA : (linhas.length === 0 ? (periodo ? 'Nenhum registro no período.' : 'Nenhum registro.') : null),
  };
}

/** @returns {{ titulo, cabecalho: [string, string][], secoes: object[] }} */
function estruturar(modelo) {
  const f = modelo.funcionario;
  const emissao = instante(modelo.emitidoEm);
  const cabecalho = [
    ['Empresa', ouVazio(modelo.empresa && modelo.empresa.nome)],
    ['Emitido em', `${emissao.data} ${emissao.hora}`],
    ['Período', periodoTexto(modelo.periodo)],
  ];
  const secoes = [];
  secoes.push({
    id: 'identificacao',
    titulo: 'Identificação',
    tipo: 'pares',
    linhas: [
      ['Nome', ouVazio(f.nome)], ['Matrícula', ouVazio(f.matricula)], ['Setor', ouVazio(f.setor)], ['Cargo / função', ouVazio(f.funcao)],
      ['GHE atual', ghe(f.ghe)], ['Situação atual', rotulo(ROTULOS_SITUACAO, f.situacao)],
    ],
  });
  const ind = modelo.indicadores;
  secoes.push({
    id: 'indicadores',
    titulo: 'Indicadores (histórico completo)',
    tipo: 'pares',
    omitida: ind === null,
    mensagem: ind === null ? OMITIDA : null,
    linhas: ind === null ? [] : [
      ['Retiradas realizadas', String(ind.totalEntregas)],
      ['EPIs distintos retirados', String(ind.episDistintos)],
      ['Última retirada', ind.ultimaEntregaEm ? instante(ind.ultimaEntregaEm).data : VAZIO],
      ['EPIs dentro do prazo de uso', String(ind.episDentroPrazoUso)],
    ],
  });
  const opc = { periodo: modelo.periodo };
  const entregas = modelo.entregas === null ? [] : modelo.entregas.flatMap((e) => {
    const q = instante(e.entregueEm);
    return e.itens.map((i) => [
      data(e.dataOperacional), q.hora, rotulo(ROTULOS_ORIGEM, e.origem), ouVazio(i.material && i.material.nome), ouVazio(i.material && i.material.tipo),
      ouVazio(i.tamanho), i.quantidade, ouVazio(i.caNumero), data(i.caValidade), Number.isInteger(i.prazoUsoDias) ? i.prazoUsoDias : VAZIO,
      rotulo(ROTULOS_MOTIVO, i.motivo), responsavel(e.responsavel), ouVazio(e.ghe && e.ghe.nome),
    ]);
  });
  secoes.push(tabela('entregas', 'Histórico de entregas de EPIs', [
    'Data', 'Hora', 'Origem', 'EPI', 'Tipo', 'Tamanho', 'Qtd.', 'CA', 'Validade do CA', 'Prazo de uso (dias)', 'Motivo', 'Responsável', 'GHE na entrega',
  ], entregas, { omitida: modelo.entregas === null, ...opc }));
  secoes.push(tabela('ghe', 'Histórico de GHE', ['Data', 'Hora', 'Tipo', 'GHE anterior', 'GHE novo', 'Responsável'], modelo.ghe.map((e) => {
    const inicial = e.tipo !== 'ALTERACAO';
    return [quando(e).data, quando(e).hora, rotulo(ROTULOS_TIPO, e.tipo), inicial ? VAZIO : gheEvento(e.anterior), gheEvento(e.novo), responsavel(e.responsavel)];
  }), opc));
  secoes.push(tabela('situacao', 'Histórico de Situação', ['Data', 'Hora', 'Tipo', 'Situação anterior', 'Situação nova', 'Responsável'], modelo.situacao.map((e) => {
    const inicial = e.tipo !== 'ALTERACAO';
    return [quando(e).data, quando(e).hora, rotulo(ROTULOS_TIPO, e.tipo), inicial ? VAZIO : rotulo(ROTULOS_SITUACAO, e.anterior), rotulo(ROTULOS_SITUACAO, e.novo), responsavel(e.responsavel)];
  }), opc));
  secoes.push(tabela('cadastral', 'Histórico de Alterações Cadastrais', ['Data', 'Hora', 'Tipo', 'Campo', 'Valor anterior', 'Valor novo', 'Responsável'], modelo.cadastral.flatMap((e) => {
    const inicial = e.tipo !== 'ALTERACAO';
    return (Array.isArray(e.alteracoes) ? e.alteracoes : []).filter((a) => a && Object.hasOwn(ROTULOS_CAMPO, a.campo)).map((a) => [
      quando(e).data, quando(e).hora, rotulo(ROTULOS_TIPO, e.tipo), ROTULOS_CAMPO[a.campo], inicial ? VAZIO : valorCadastral(a.campo, a.anterior),
      valorCadastral(a.campo, a.novo), responsavel(e.responsavel),
    ]);
  }), opc));
  return { titulo: 'Histórico de Funcionários', subtitulo: ouVazio(f.nome), cabecalho, secoes };
}

module.exports = { estruturar, OMITIDA, VAZIO };
