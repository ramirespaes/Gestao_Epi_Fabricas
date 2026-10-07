'use strict';

/**
 * Catálogo binário (ON/OFF) de acessos da Gestão de Usuários: 19 toggles aprovados.
 *
 * Só entra como controle o toggle com enforcement real (rota que o servidor exige). Os demais ficam em
 * `PENDENCIAS` com o motivo: nenhum toggle decorativo. As camadas internas (perfil, grupo, exceção
 * individual) não mudam; o toggle só pede o resultado efetivo e o serviço escolhe a camada.
 *
 * Nada aqui define matriz por perfil.
 */

const GRUPOS = Object.freeze(['GERAL', 'COLABORADORES', 'EPIS', 'ESTOQUE', 'ADMINISTRACAO']);

const recurso = (recursoId, operacoes) => Object.freeze({ tipo: 'RECURSO', recurso: recursoId, operacoes: Object.freeze(operacoes) });
// concessao: o toggle é a concessão individual da ação (que exige vínculo SST para valer), não o efeito final.
// semBloqueio: mostra o efeito real, mas DESLIGAR só remove a concessão individual (nunca cria bloqueio sobre autoridade
// que vem legitimamente de outra camada, como o perfil).
const acao = (codigo, concessao = false, semBloqueio = false) => Object.freeze({
  tipo: 'ACAO', codigo, ...(concessao ? { concessao: true } : {}), ...(semBloqueio ? { semBloqueio: true } : {}),
});

const LEITURA_MATERIAIS = recurso('materials', ['visualizar']);

const TOGGLES = Object.freeze([
  { id: 'dashboard', rotulo: 'Dashboard', grupo: 'GERAL', regra: recurso('dashboard', ['visualizar']) },
  { id: 'historicoFuncionarios', rotulo: 'Histórico de Funcionários', grupo: 'COLABORADORES', regra: recurso('employeeHistory', ['visualizar']) },
  { id: 'fichaEpi', rotulo: 'Ficha de EPI', grupo: 'EPIS', regra: recurso('epiFicha', ['visualizar']) },
  // Ação existente REALIZAR_ENTREGA (abre "Entregas por solicitação" e autoriza a entrega no servidor). Independente do
  // vínculo SST e de Aprovar/Reprovar: ligar um não liga o outro.
  { id: 'entregasSolicitacao', rotulo: 'Entregas por solicitação', grupo: 'EPIS', regra: acao('REALIZAR_ENTREGA', false, true) },
  // Somente consulta: não autoriza criar, alterar nem excluir GHE.
  { id: 'gestaoGhe', rotulo: 'Gestão de GHE', grupo: 'EPIS', regra: recurso('employeeGroups', ['visualizar']) },
  { id: 'analiseEstoque', rotulo: 'Análise de Estoque', grupo: 'ESTOQUE', regra: recurso('availableItems', ['visualizar']) },
  { id: 'operacoesEstoque', rotulo: 'Operações de Estoque', grupo: 'ESTOQUE', regra: recurso('operations', ['visualizar']) },
  // Os três de Gestão de Estoque são independentes. Ligar cada um também garante a leitura do cadastro de materiais
  // (dependência: a página precisa listar materiais e lotes); desligar mexe só na regra própria do toggle.
  { id: 'cadastrarProduto', rotulo: 'Cadastrar Produto', grupo: 'ESTOQUE', regra: recurso('materials', ['criar']), dependencias: [LEITURA_MATERIAIS] },
  { id: 'entradaLote', rotulo: 'Entrada por Lote', grupo: 'ESTOQUE', regra: acao('ENTRADA_ESTOQUE'), dependencias: [LEITURA_MATERIAIS] },
  { id: 'registrarBaixa', rotulo: 'Registrar Baixa / Saída', grupo: 'ESTOQUE', regra: acao('BAIXA_ESTOQUE'), dependencias: [LEITURA_MATERIAIS] },
  // Permissão própria (ação IMPORTAR_FUNCIONARIOS, ALTERNATIVA desde a 078); independente de employeeHistory.criar.
  { id: 'importacaoFuncionarios', rotulo: 'Importação de Funcionários', grupo: 'COLABORADORES', regra: acao('IMPORTAR_FUNCIONARIOS'), dependencias: [] },
  { id: 'gestaoUsuarios', rotulo: 'Gestão de Usuários', grupo: 'ADMINISTRACAO', regra: acao('GERENCIAR_USUARIOS') },
  // A decisão da SST tem DUAS dimensões: o vínculo ("atua na Segurança do Trabalho?", Novo/Alterar usuário) e a permissão
  // ("o que pode fazer?", estes toggles). Ligar aqui é a CONCESSÃO individual da ação; ela não cria o vínculo e o vínculo
  // não a concede. O acesso efetivo exige os dois, e o servidor decide (AUTODECISAO_PROIBIDA continua valendo).
  { id: 'aprovarSolicitacoes', rotulo: 'Aprovar solicitações de EPI', grupo: 'ADMINISTRACAO', regra: acao('APROVAR_SOLICITACAO', true) },
  { id: 'reprovarSolicitacoes', rotulo: 'Reprovar solicitações de EPI', grupo: 'ADMINISTRACAO', regra: acao('REPROVAR_SOLICITACAO', true) },
].map((t) => Object.freeze(t)));

// Sem enforcement real hoje: não viram controle até existir a rota (ou a decisão) que falta.
const PENDENCIAS = Object.freeze([
  { id: 'relatorios', rotulo: 'Relatórios', situacao: 'SEM_ENFORCEMENT', motivo: 'Tela em protótipo, sem rota no servidor.' },
  { id: 'episEntregues', rotulo: 'EPIs Entregues', situacao: 'SEM_ENFORCEMENT', motivo: 'Tela em protótipo, sem rota no servidor.' },
  { id: 'gestaoColaboradores', rotulo: 'Gestão de Colaboradores', situacao: 'SEM_ENFORCEMENT', motivo: 'Página e rotas de gestão ainda não existem (etapa 12K-E).' },
  { id: 'configuracoes', rotulo: 'Configurações', situacao: 'SEM_ENFORCEMENT', motivo: 'A tela é pessoal e abre para qualquer sessão; não há rota restrita por permissão.' },
  { id: 'suporte', rotulo: 'Suporte', situacao: 'SEM_ENFORCEMENT', motivo: 'Tela em protótipo, sem rota no servidor.' },
  { id: 'gestaoEmail', rotulo: 'Gestão de E-mail', situacao: 'SEM_ENFORCEMENT', motivo: 'Tela em protótipo, sem rota no servidor.' },
  { id: 'privacidadeLgpd', rotulo: 'Privacidade / LGPD', situacao: 'SEM_ENFORCEMENT', motivo: 'Tela em protótipo, sem rota no servidor.' },
  { id: 'token', rotulo: 'Token', situacao: 'SEM_ENFORCEMENT', motivo: 'Página administrativa do Token ainda não existe.' },
].map((p) => Object.freeze(p)));

function buscar(id) {
  return TOGGLES.find((t) => t.id === id) ?? null;
}

module.exports = { GRUPOS, TOGGLES, PENDENCIAS, buscar };
