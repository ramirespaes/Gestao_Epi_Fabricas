/*
 * Totem de Autoatendimento — interface operacional (incrementos I-G2 e I-G3: ativação, identificação, sessão de 60 s,
 * consulta das solicitações em aberto e catálogo do funcionário).
 *
 * Fala com o servidor só para: estado do tablet, ativação (Etapa C); identificação, renovação e encerramento do atendimento
 * (Etapa D); catálogo (Etapa E); solicitações em aberto (Etapa G); presença do tablet por batida periódica (Ciclo 2, K4).
 * Carrinho completo, motivos e envio do pedido são do I-G4.
 * Nada é gravado no navegador: o estado vive só na memória da página.
 *
 * Duas credenciais distintas, ambas em cookies do servidor (esta página nunca as lê nem as escreve):
 *  - a do TABLET, persistente, criada pela ativação; esta página só a usa (credentials: 'include') e nunca a remove;
 *  - a do ATENDIMENTO do funcionário, temporária (60 s de inatividade deslizantes, decididos pelo servidor).
 *
 * Isolamento entre funcionários, em duas camadas independentes:
 *  1. ESTADO DA PÁGINA: toda operação de uma sessão carrega a GERAÇÃO em que nasceu. Ao encerrar, expirar, substituir o
 *     funcionário ou perder a autorização, a geração muda e qualquer resposta de geração antiga é descartada antes de tocar na
 *     interface.
 *  2. COOKIE DO ATENDIMENTO (HttpOnly, do servidor): identificação, renovação, consulta, catálogo e encerramento podem
 *     definir, reemitir ou remover esse cookie na resposta. Uma resposta tardia de um atendimento anterior poderia sobrescrever
 *     ou apagar o cookie do seguinte. Por isso toda requisição que mexe com ele entra na BARREIRA: nenhuma identificação nova
 *     começa enquanto houver uma pendente, e a que ficar sem resposta (rede, tempo esgotado) mantém a transição bloqueada.
 *     Requisições NÃO são abortadas na troca de sessão (abortar não cancela o que o servidor já fez nem prova que a resposta não
 *     será processada): elas terminam, e a resposta é descartada. Só o recarregamento da página, sem garantia comprovada,
 *     encerra o bloqueio.
 */
(function () {
  'use strict';

  // Endereço da API: mesma origem da página em produção (resolvido por portal/config.js).
  var API_BASE = window.SAFEWORK_PORTAL_API_BASE_URL;
  var TABLET = '/atendimento-token/tablet';

  var TEXTOS = {
    ativacaoFalha: 'Código inválido ou expirado. Peça um novo código à administração.',
    ativacaoIncerta: 'Não conseguimos confirmar a ativação deste tablet. Se o problema continuar, procure a administração do sistema e peça um novo código.',
    marcadorCampo: 'Toque nos números abaixo',
    campoVazio: 'Digite seu CPF ou sua matrícula.',
    cpfIncompleto: 'Digite os 11 números do CPF.',
    naoEncontrado: 'Não encontramos esse CPF ou matrícula. Confira os dados ou procure o RH.',
    limite: 'Muitas tentativas. Aguarde alguns segundos e tente de novo.',
    comunicacao: 'Não foi possível se comunicar com o sistema. Tente novamente.',
    expirada: 'Sessão encerrada por inatividade.',
    sessaoTerminou: 'Sua sessão terminou. Identifique-se novamente para ver seus pedidos.',
    nestaRetirada: 'Nesta retirada:',
    solicitado: '✓ Solicitado',
    jaSolicitouNestaRetirada: 'Você já solicitou este item nesta retirada.',
    jaIncluido: 'Item já incluído no pedido.',
    limite20: 'Limite de 20 itens.',
    remover: 'Remover',
    semGhe: 'Seu cadastro ainda não tem materiais liberados. Procure a Segurança do Trabalho.',
    gheInativo: 'Os materiais do seu grupo estão indisponíveis no momento. Procure a Segurança do Trabalho.',
    semMateriais: 'Não há materiais liberados para o seu grupo. Procure a Segurança do Trabalho.',
    duplicado: 'Este item já foi solicitado.',
    naoLiberado: 'Este material não está liberado para você.',
    processando: 'Ainda estamos processando o seu pedido. Toque em Verificar novamente.',
    tecladoNumerico: 'Voltar ao teclado numérico',
    escolhaTamanho: 'Toque em um tamanho para escolher',
    selecionado: 'Selecionado',
    motivos: {
      SUBSTITUICAO_PRAZO: 'Substituição por prazo',
      DESGASTE_DANO: 'Desgaste ou dano',
      PERDA_EXTRAVIO: 'Perda ou extravio',
    },
  };

  var SITUACOES_ABERTAS = {
    DISPONIVEL_PARA_RETIRADA: 'listaDisponiveis',
    AGUARDANDO_ESTOQUE: 'listaAguardandoEstoque',
    AGUARDANDO_APROVACAO: 'listaAguardandoAprovacao',
    INDISPONIVEL: 'listaIndisponivel',
  };
  var SECOES_ABERTAS = {
    DISPONIVEL_PARA_RETIRADA: 'secDisponiveis',
    AGUARDANDO_ESTOQUE: 'secAguardandoEstoque',
    AGUARDANDO_APROVACAO: 'secAguardandoAprovacao',
    INDISPONIVEL: 'secIndisponivel',
  };
  var ESTADOS_VAZIOS = { SEM_GHE: 'semGhe', GHE_INATIVO: 'gheInativo', SEM_MATERIAIS: 'semMateriais' };

  var TELAS = ['telaAtivacao', 'telaNaoAutorizado', 'telaRede', 'telaAcesso', 'telaAviso', 'telaProdutos', 'telaTamanhos', 'telaRevisao', 'telaIncerto', 'telaConfirma'];
  var LIMITE_CPF = 11;
  var LIMITE_MATRICULA = 30;
  var VALIDADE_ATIVACAO_MS = 10 * 60 * 1000; // limite local; o prazo real do código é do servidor
  var TEMPO_LIMITE_MS = 10000; // sem resposta nesse prazo, o resultado é tratado como incerto
  var ABANDONO_MS = 30000; // digitação abandonada na identificação
  var ESPERA_PADRAO_S = 30;
  var ESPERA_MAXIMA_S = 120;
  // Renovação: no máximo uma por vez e uma por segundo. É POLÍTICA INTERNA PROVISÓRIA, não requisito do backend: o backend limita
  // a 120 por minuto, por tablet, as rotas GET /atendimento, POST /atividade e POST /encerrar (uma só cota). Consulta G, catálogo
  // e identificação têm limitadores próprios. Com 1 por segundo a renovação usa no máximo metade da cota (60 por minuto). A
  // renovação seguinte a uma rajada sai até 1 s depois da última ação, então a sessão pode durar até 1 s mais do que os 60 s
  // ociosos.
  var INTERVALO_RENOVACAO_MS = 1000;
  var LIMITE_NOME = 150;
  var LIMITE_MATERIAIS = 500;
  // Pedido (Etapa F). Regras do contrato conferidas no backend: 1 a 20 itens (LIMITE_ITENS do serviço e do esquema; o backend recusa
  // acima disso), material + tamanho sem repetição (400 ITEM_REPETIDO), motivos só estes três (esquema do Totem). A QUANTIDADE 1 por
  // item é regra de negócio do Totem (decisão Q5), não limite do backend: ele aceita qualquer inteiro positivo.
  var LIMITE_ITENS = 20;
  var MOTIVOS = ['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO'];
  var RETORNO_CONFIRMACAO_MS = 20000; // exposição máxima da confirmação neutra
  // Presença do tablet (Ciclo 2, K4). Contrato do backend (config/token-monitoramento): uma batida a cada 60 s, com jitter de 10 %
  // para os tablets não baterem juntos; o servidor dá o tablet como sem comunicação depois de 180 s sem contato.
  var HEARTBEAT_INTERVALO_MS = 60000;
  var HEARTBEAT_JITTER = 0.1;
  // Fotografias dos EPIs. Limites PROVISÓRIOS de carregamento (política do cliente, não requisito do backend): a rota de imagens tem
  // contadores próprios de 240 por minuto por tablet e 600 por minuto por IP; 300 ms entre inícios dá no máximo ~200 por minuto.
  var IMAGENS_SIMULTANEAS = 4;
  var IMAGENS_ESPACAMENTO_MS = 300;
  var IMAGEM_TEMPO_LIMITE_MS = 15000;
  var IMAGEM_TENTATIVAS = 3;
  var IMAGEM_ESPERA_REPETICAO_MS = 2000;
  var IMAGEM_BYTES_MAXIMOS = 4 * 1024 * 1024;
  var ID_IMAGEM_MAXIMO = '9223372036854775807';
  var ORIGENS_IMAGEM = { EMPRESA: 'empresa', PADRAO: 'padrao' };

  var estado = {
    tipo: null,
    tecladoNumerico: true,
    atendimento: null, // { expiraEm } enquanto há atendimento; o nome fica só no DOM
    geracao: 0,
    // Requisições que podem definir, reemitir ou remover o cookie do atendimento: pendentes em voo e, se alguma terminou sem
    // resposta, `incerto` (fica até o recarregamento da página).
    barreira: { pendentes: 0, incerto: false },
    renovacao: novaRenovacao(),
    solicitacoes: [],
    catalogo: [],
    produto: null,
    tamanho: null,
    carrinho: [], // { materialId, nome, tamanho, motivo }: o motivo é do item e some com ele
    // Tentativa lógica de pedido: { chave, conteudo, itens, fase, transmissoes, ate }. A chave vive só aqui, na memória, e só enquanto
    // a tentativa existe; fase: 'enviando' | 'incerto' | 'rejeitado'. Enquanto 'enviando' ou 'incerto' nada altera o conteúdo.
    pedido: null,
    errosItem: {}, // índice do item na revisão -> texto do erro daquele item
    erroEnvio: '',
    retorno: null, // temporizador de retorno da confirmação neutra (só de tela)
    relogio: null,
    abandono: null,
    identificando: false,
    espera: 0, // instante até o qual a identificação fica pausada por um 429
  };

  // Batida de presença do tablet: independente do atendimento do funcionário (não tem geração, não entra na barreira e sobrevive à
  // troca de sessão); só o bloqueio do tablet a para. `vida` muda a cada parada: a resposta de uma batida enviada numa vida anterior é antiga.
  var heartbeat = { ativo: false, emVoo: false, timer: null, vida: 0 };

  // Fotografias da sessão atual (cache, fila e requisições em voo): tudo em memória e descartado com a geração.
  var imagens = novasImagens();

  // Código de ativação: sai do fechamento do boot.js uma única vez e vive só aqui, até ser descartado.
  var ativacao = { codigo: window.TotemAtivacao.tomar(), situacao: window.TotemAtivacao.estado(), enviando: false, prazo: null };

  function novaRenovacao() { return { emVoo: false, ultimoInicio: 0, ate: 0, pendente: false, timer: null }; }
  function $(id) { return document.getElementById(id); }
  function digitos(s) { return String(s || '').replace(/\D/g, ''); }
  function esvaziar(id) { $(id).textContent = ''; }

  function mostrar(id) {
    if (id !== 'telaConfirma') { clearTimeout(estado.retorno); estado.retorno = null; }
    TELAS.forEach(function (t) { $(t).classList.toggle('on', t === id); });
    window.scrollTo(0, 0);
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  /* ═══ Transporte ═══
     Resolve sempre, nunca rejeita: { tipo: 'resposta', status, codigo, corpo, espera } ou { tipo: 'incerto' } quando a
     requisição foi enviada e não houve resposta (rede, conexão interrompida ou tempo esgotado). Não registra nada.
     `cookieDoAtendimento` entra a requisição na BARREIRA: ela conta como pendente até terminar; uma resposta HTTP recebida
     (qualquer status) encerra a janela em que aquela requisição poderia mexer no cookie; sem resposta, a barreira fica
     travada (`incerto`). O tempo limite só converte a espera em "sem resposta": nunca libera a transição. */
  function chamar(metodo, caminho, corpo, cookieDoAtendimento) {
    if (typeof API_BASE !== 'string') return Promise.resolve({ tipo: 'incerto' });
    var controle = new AbortController();
    if (cookieDoAtendimento) estado.barreira.pendentes += 1;
    var limite = setTimeout(function () { controle.abort(); }, TEMPO_LIMITE_MS);
    function terminar(semResposta) {
      clearTimeout(limite);
      if (!cookieDoAtendimento) return;
      estado.barreira.pendentes -= 1;
      if (semResposta) estado.barreira.incerto = true;
    }
    var opcoes = { method: metodo, credentials: 'include', headers: { Accept: 'application/json' }, signal: controle.signal };
    if (corpo !== undefined) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    return fetch(API_BASE + TABLET + caminho, opcoes).then(function (r) {
      var espera = parseInt(r.headers.get('Retry-After'), 10);
      return r.text().then(function (texto) {
        terminar();
        var dados = null;
        try { dados = texto === '' ? null : JSON.parse(texto); } catch (e) { dados = null; }
        return { tipo: 'resposta', status: r.status, codigo: dados && typeof dados.codigo === 'string' ? dados.codigo : null, corpo: dados, espera: isNaN(espera) ? null : espera };
      }, function () {
        terminar();
        return { tipo: 'resposta', status: r.status, codigo: null, corpo: null, espera: isNaN(espera) ? null : espera };
      });
    }, function () {
      terminar(true);
      return { tipo: 'incerto' };
    });
  }

  /* ═══ Geração da sessão e limpeza ═══ */
  function invalidarSessao() {
    // Nada é abortado: as requisições em voo seguem na barreira até terminarem e suas respostas, de geração antiga, são descartadas.
    estado.geracao += 1;
    clearTimeout(estado.renovacao.timer);
    estado.renovacao = novaRenovacao();
    descartarImagens();
  }

  function limparErro() {
    $('doc').classList.remove('invalid');
    $('erro').textContent = '';
    $('tipos').classList.remove('pendente');
  }

  function cancelarAbandono() {
    clearTimeout(estado.abandono);
    estado.abandono = null;
  }

  function limparIdentificacao() {
    cancelarAbandono();
    $('doc').value = '';
    limparErro();
    escolherTipo(null);
  }

  function limparAtendimento() {
    invalidarSessao();
    // Uma identificação ainda em voo deixa de ser "a atual": ela segue na barreira (bloqueando a próxima) mas não prende o botão.
    estado.identificando = false;
    $('btnContinuar').disabled = false;
    clearInterval(estado.relogio);
    estado.relogio = null;
    estado.atendimento = null;
    estado.solicitacoes = [];
    estado.catalogo = [];
    estado.produto = null;
    estado.tamanho = null;
    estado.carrinho = [];
    estado.pedido = null; // a chave e o conteúdo da tentativa somem com a sessão; nunca são guardados para depois
    estado.errosItem = {};
    estado.erroEnvio = '';
    $('sessao').classList.remove('on');
    ['quem', 'tempo', 'ola', 'olaSub', 'olaChips', 'resumo', 'grade', 'estadoCatalogo', 'detImg', 'detNome', 'detTipo', 'tams',
      'itensRevisao', 'erroEnvio', 'msgProcessando', 'toasts', 'listaDisponiveis', 'listaAguardandoEstoque', 'listaAguardandoAprovacao', 'listaIndisponivel'].forEach(esvaziar);
    $('tempo').classList.remove('urgente');
    $('estadoCatalogo').hidden = true;
    $('blocoRevisar').hidden = true;
    $('msgProcessando').hidden = true;
    $('btnReenviar').hidden = true;
    $('btnVerificar').disabled = false;
    $('btnEnviar').disabled = true;
    $('subtituloProdutos').hidden = true;
    ['secDisponiveis', 'secAguardandoEstoque', 'secAguardandoAprovacao', 'secIndisponivel'].forEach(function (id) { $(id).hidden = true; });
    $('acaoTxt').textContent = TEXTOS.escolhaTamanho;
    $('btnSolicitar').disabled = true;
  }

  function descartarCodigo() {
    clearTimeout(ativacao.prazo);
    ativacao.prazo = null;
    ativacao.codigo = null;
    window.TotemAtivacao.descartar();
  }

  function voltarAIdentificacao(mensagem) {
    limparAtendimento();
    limparIdentificacao();
    mostrar('telaAcesso');
    if (mensagem) $('erro').textContent = mensagem;
    $('doc').focus();
  }

  function bloquear(tela) {
    pararHeartbeat();
    limparAtendimento();
    limparIdentificacao();
    descartarCodigo();
    mostrar(tela);
  }

  /* 401 do tablet = não autorizado (nunca ativado ou revogado: o servidor não distingue); 403 = fora da rede. */
  function bloqueioDe(r) {
    if (r.tipo !== 'resposta') return false;
    if (r.status === 403) { bloquear('telaRede'); return true; }
    if (r.status === 401 && r.codigo === 'DISPOSITIVO_NAO_AUTORIZADO') { bloquear('telaNaoAutorizado'); return true; }
    return false;
  }

  /* Resposta de uma operação do atendimento: a perda de autorização encerra tudo na hora. */
  function perdaDeAutorizacao(r) {
    if (r.tipo !== 'resposta') return false;
    if (bloqueioDe(r)) return true;
    if (r.status === 401) { voltarAIdentificacao(TEXTOS.expirada); return true; }
    return false;
  }

  /* ═══ A barreira da próxima identificação ═══
     A resposta de identificação, renovação, consulta, catálogo ou encerramento pode definir, reemitir ou remover o cookie do
     atendimento (os controllers do backend fazem isso em 200 e em 401). Uma resposta tardia de um atendimento anterior
     poderia sobrescrever ou apagar o cookie do seguinte. Por isso nenhuma identificação nova começa enquanto alguma dessas
     requisições estiver pendente e, se alguma terminou sem resposta (resultado desconhecido, inclusive identificação cancelada
     ou com tempo esgotado), a transição fica bloqueada: nem o tempo limite nem o aborto provam que a resposta não será
     processada depois. A resposta recebida, de qualquer status, libera: ela já foi processada e é a única daquela requisição.
     O bloqueio só termina com o recarregamento da página, o que NÃO é solução comprovada (ver o registro do I-G3). */
  function transicaoLiberada() { return estado.barreira.pendentes === 0 && !estado.barreira.incerto; }

  function encerrarNoServidor() {
    return chamar('POST', '/atendimento/encerrar', {}, true).then(function (r) { bloqueioDe(r); });
  }

  /* ═══ Presença do tablet (Ciclo 2, K4) ═══
     O tablet avisa o servidor, por POST /heartbeat, que está de pé. É assunto do TABLET, não do funcionário: usa só o cookie do
     tablet, fica fora da barreira do atendimento (não define nem remove o cookie do atendimento), não renova nem consulta a
     sessão do funcionário e não leva dado nenhum (corpo {}, sem query). A cadência é de um setTimeout por vez, remarcado só quando
     a batida anterior termina (resposta ou tempo limite do transporte): nunca duas em voo e nunca um temporizador por cima do outro.
     Falha de rede ou 5xx não muda a tela nem para a cadência; 429 respeita o Retry-After (como a renovação); 401 e 403 são o
     bloqueio do tablet de sempre e param a presença. O servidor decide o resto (RESTABELECIMENTO, queda, alerta). */
  function atrasoDaBatida() {
    return HEARTBEAT_INTERVALO_MS * (1 + (Math.random() * 2 - 1) * HEARTBEAT_JITTER);
  }

  function pararHeartbeat() {
    heartbeat.ativo = false;
    heartbeat.vida += 1;
    clearTimeout(heartbeat.timer);
    heartbeat.timer = null;
  }

  function agendarHeartbeat(esperaMs) {
    if (!heartbeat.ativo || heartbeat.timer !== null) return;
    heartbeat.timer = setTimeout(function () { heartbeat.timer = null; enviarHeartbeat(); }, Math.max(atrasoDaBatida(), esperaMs));
  }

  function enviarHeartbeat() {
    if (!heartbeat.ativo || heartbeat.emVoo) return;
    heartbeat.emVoo = true;
    var vida = heartbeat.vida;
    chamar('POST', '/heartbeat', {}).then(function (r) {
      heartbeat.emVoo = false;
      if (!heartbeat.ativo) return; // parada durante o voo: o bloqueio já cuidou da tela
      // Parada e retomada durante o voo: a resposta é de antes da liberação e não diz nada sobre o estado atual do tablet (um 401/403
      // antigo bloquearia de novo uma tela já liberada). Descarta e deixa a presença atual seguir no ritmo normal.
      if (vida !== heartbeat.vida) { agendarHeartbeat(0); return; }
      if (bloqueioDe(r)) return;
      var esperaMs = 0;
      if (r.tipo === 'resposta' && r.status === 429) esperaMs = Math.min(Math.max(r.espera === null ? ESPERA_PADRAO_S : r.espera, 1), ESPERA_MAXIMA_S) * 1000;
      agendarHeartbeat(esperaMs);
    });
  }

  /* Idempotente: com a presença já ativa (reinício da página, ativação repetida) não há batida extra nem segundo temporizador. */
  function iniciarHeartbeat() {
    if (heartbeat.ativo) return;
    heartbeat.ativo = true;
    enviarHeartbeat();
  }

  /* ═══ Início: estado do tablet e atendimento deixado aberto ═══ */
  function inicio() {
    chamar('GET', '/estado').then(function (r) {
      if (r.tipo === 'resposta' && r.status === 401) { bloquear('telaNaoAutorizado'); return null; }
      if (bloqueioDe(r)) return null;
      // O tablet não foi recusado (autorizado, ou o servidor não respondeu): a presença passa a ser comunicada, mas só DEPOIS de a tela
      // inicial estar posta, para que um bloqueio vindo da batida (401/403) nunca seja coberto pelo fim desta sequência. Se a
      // credencial na verdade não valer, a primeira batida recebe 401/403 e bloqueia como qualquer outra operação.
      if (r.tipo !== 'resposta' || r.status !== 200) { voltarAIdentificacao(TEXTOS.comunicacao); iniciarHeartbeat(); return null; }
      return chamar('GET', '/atendimento', undefined, true).then(function (a) {
        if (bloqueioDe(a)) return null;
        if (a.tipo === 'resposta' && a.status === 200) return encerrarNoServidor().then(function () { voltarAIdentificacao(null); iniciarHeartbeat(); });
        voltarAIdentificacao(null);
        iniciarHeartbeat();
        return null;
      });
    });
  }

  function reiniciar() {
    heartbeat.vida += 1; // a batida em voo é de antes deste reinício: o /estado de agora é a leitura mais recente do tablet
    descartarCodigo();
    limparAtendimento();
    limparIdentificacao();
    inicio();
  }

  /* ═══ Ativação do tablet ═══ */
  function mostrarFalhaDaAtivacao(texto, orientacao) {
    $('erroAtivacao').textContent = texto;
    $('orientacaoAtivacao').textContent = orientacao || '';
    $('orientacaoAtivacao').hidden = !orientacao;
  }

  function terminarAtivacao() {
    ativacao.enviando = false;
    $('btnAtivar').disabled = false;
  }

  function ativacaoConcluida() {
    descartarCodigo();
    terminarAtivacao();
    mostrarFalhaDaAtivacao('', '');
    voltarAIdentificacao(null);
    iniciarHeartbeat(); // tablet recém-autorizado: a presença começa agora
  }

  /* Sem resposta: o servidor pode ou não ter consumido o código. Nada é presumido e nada é reenviado sozinho; a única
     recuperação é a consulta de estado já prevista na Etapa C (tablet autorizado = segue). */
  function recuperarAtivacao() {
    return chamar('GET', '/estado').then(function (r) {
      // Aqui o 401 é o normal de um tablet ainda não ativado: não é bloqueio, só "não recuperado". Fora da rede (403), sim.
      if (r.tipo === 'resposta' && r.status === 403) { terminarAtivacao(); bloquear('telaRede'); return; }
      if (r.tipo === 'resposta' && r.status === 200) { ativacaoConcluida(); return; }
      terminarAtivacao();
      mostrarFalhaDaAtivacao(TEXTOS.comunicacao, TEXTOS.ativacaoIncerta);
    });
  }

  function ativar() {
    if (ativacao.enviando) return;
    mostrarFalhaDaAtivacao('', '');
    if (ativacao.codigo === null) { mostrarFalhaDaAtivacao(TEXTOS.ativacaoFalha, ''); return; }
    ativacao.enviando = true;
    $('btnAtivar').disabled = true;
    chamar('POST', '/ativar', { codigo: ativacao.codigo }).then(function (r) {
      if (r.tipo === 'incerto' || (r.tipo === 'resposta' && r.status >= 500)) return recuperarAtivacao();
      if (r.status === 200) { ativacaoConcluida(); return null; }
      terminarAtivacao();
      if (r.status === 403) { bloquear('telaRede'); return null; }
      if (r.status === 429) { mostrarFalhaDaAtivacao(TEXTOS.limite, ''); return null; }
      descartarCodigo();
      mostrarFalhaDaAtivacao(TEXTOS.ativacaoFalha, '');
      return null;
    });
  }

  function iniciarAtivacao() {
    mostrar('telaAtivacao');
    if (ativacao.codigo !== null) ativacao.prazo = setTimeout(descartarCodigo, VALIDADE_ATIVACAO_MS);
  }

  /* ═══ Campo de identificação ═══ */
  function maskCpf(d) { return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'); }

  function reiniciarAbandono() {
    cancelarAbandono();
    if ($('doc').value !== '') estado.abandono = setTimeout(function () { limparIdentificacao(); }, ABANDONO_MS);
  }

  function escrever(valor) {
    var el = $('doc');
    if (estado.tipo === 'CPF') {
      var d = digitos(valor).slice(0, LIMITE_CPF);
      el.value = d.length === LIMITE_CPF ? maskCpf(d) : d;
    } else {
      el.value = String(valor).slice(0, LIMITE_MATRICULA);
    }
    reiniciarAbandono();
  }

  function tecla(c) {
    escrever($('doc').value + c);
    limparErro();
  }

  function apagar() {
    var v = $('doc').value;
    escrever(estado.tipo === 'CPF' ? digitos(v).slice(0, -1) : v.slice(0, -1));
    limparErro();
  }

  function limparCampo() {
    $('doc').value = '';
    cancelarAbandono();
    limparErro();
  }

  function definirTeclado(numerico) {
    estado.tecladoNumerico = numerico;
    $('doc').setAttribute('inputmode', numerico ? 'none' : 'text');
    $('teclado').style.display = numerico ? 'grid' : 'none';
    $('btnTeclado').textContent = numerico ? 'Minha matrícula tem letras — usar teclado' : TEXTOS.tecladoNumerico;
  }

  function escolherTipo(tipo) {
    estado.tipo = tipo;
    $('tipoCpf').classList.toggle('sel', tipo === 'CPF');
    $('tipoMatricula').classList.toggle('sel', tipo === 'MATRICULA');
    $('tipoCpf').setAttribute('aria-pressed', String(tipo === 'CPF'));
    $('tipoMatricula').setAttribute('aria-pressed', String(tipo === 'MATRICULA'));
    definirTeclado(true);
    limparCampo();
  }

  /* ═══ Sessão do atendimento: contador e renovação ═══ */
  /* O vencimento local parte do instante em que a requisição foi ENVIADA, nunca do da resposta: o servidor conta a partir da
     chegada dela, então o local nunca passa do dele pela demora da rede. O servidor segue sendo a autoridade. */
  function iniciarRelogio(restanteSegundos, enviadoEm) {
    estado.atendimento = { expiraEm: enviadoEm + restanteSegundos * 1000 };
    clearInterval(estado.relogio);
    function tick() {
      var restante = Math.ceil((estado.atendimento.expiraEm - Date.now()) / 1000);
      // Com um pedido em envio ou sem resultado, a sessão acabar NÃO prova que o pedido não existe: o texto não afirma isso.
      if (restante <= 0) { voltarAIdentificacao(pedidoEmAberto() ? TEXTOS.sessaoTerminou : TEXTOS.expirada); return; }
      $('tempo').textContent = 'Sessão: ' + restante + 's';
      $('tempo').classList.toggle('urgente', restante <= 15);
    }
    estado.relogio = setInterval(tick, 1000);
    tick();
  }

  function restanteValido(r) {
    var a = r.corpo && r.corpo.status === 'ok' ? r.corpo.atendimento : null;
    var s = a ? a.restanteSegundos : null;
    return typeof s === 'number' && s >= 1 && s <= 3600 ? s : null;
  }

  /* Só uma AÇÃO EXPLÍCITA do funcionário chama isto (toque em controle de trabalho). Movimento, rolagem, consulta e o simples
     passar do tempo nunca renovam. Uma renovação por vez; as ações que chegam enquanto ela está em andamento ou antes do
     intervalo viram, no máximo, UMA renovação seguinte, nunca uma rajada. */
  function atividade() {
    // Com pedido em envio ou sem resultado não se renova: o atendimento pode já ter sido encerrado pelo próprio pedido
    // (PEDIDO_ENVIADO) e um 401 de renovação limparia a tentativa e a chave que ainda servem à recuperação.
    if (estado.atendimento !== null && !pedidoEmAberto()) agendarRenovacao();
  }

  function pedidoEmAberto() { return estado.pedido !== null && (estado.pedido.fase === 'enviando' || estado.pedido.fase === 'incerto'); }

  function agendarRenovacao() {
    if (pedidoEmAberto()) return;
    var r = estado.renovacao;
    var agora = Date.now();
    if (agora < r.ate) return;
    if (r.emVoo) { r.pendente = true; return; }
    var espera = r.ultimoInicio + INTERVALO_RENOVACAO_MS - agora;
    if (espera <= 0) { renovar(); return; }
    if (r.timer === null) {
      var g = estado.geracao;
      r.timer = setTimeout(function () { r.timer = null; if (g === estado.geracao) agendarRenovacao(); }, espera);
    }
  }

  function renovar() {
    var r = estado.renovacao;
    var g = estado.geracao;
    var enviadoEm = Date.now();
    r.emVoo = true;
    r.ultimoInicio = enviadoEm;
    chamar('POST', '/atendimento/atividade', {}, true).then(function (res) {
      if (g !== estado.geracao) return; // sessão já invalidada: resposta antiga descartada
      r.emVoo = false;
      if (pedidoEmAberto()) return; // uma renovação em voo quando o pedido saiu: o resultado dela não decide nada
      if (perdaDeAutorizacao(res)) return;
      var restante = res.tipo === 'resposta' && res.status === 200 ? restanteValido(res) : null;
      if (restante !== null) {
        estado.atendimento.expiraEm = enviadoEm + restante * 1000; // o servidor é a autoridade; a contagem local só indica
      } else if (res.tipo === 'resposta' && res.status === 429) {
        // Não é renovação: a sessão segue o horário antigo e nada é tentado até o prazo informado.
        var s = res.espera === null ? ESPERA_PADRAO_S : Math.min(Math.max(res.espera, 1), ESPERA_MAXIMA_S);
        r.ate = Date.now() + s * 1000;
        r.pendente = false;
        return;
      }
      if (r.pendente) { r.pendente = false; agendarRenovacao(); }
    });
  }

  /* ═══ Fotografias dos EPIs ═══
     O catálogo traz `imagem: { disponivel, origem, id, versao }`; só a referência estritamente válida vira requisição (o id BIGINT
     segue como TEXTO). A fotografia é buscada por fetch autenticado (cookies do tablet e do atendimento), vira Blob e URL de objeto
     e ocupa o espaço `.prod-img` / `#detImg`; sem imagem ou com qualquer falha, o placeholder aprovado permanece. As requisições
     NÃO entram na barreira do atendimento (a rota não define nem remove cookie), nunca renovam a sessão e são abortadas, com as
     URLs de objeto revogadas, quando a geração muda (Sair, expiração, bloqueio, novo funcionário). */
  function novasImagens() {
    return { cache: Object.create(null), fila: [], emVoo: 0, ativas: [], inicio: -Infinity, pausaAte: 0, timer: null, repeticoes: [], urls: [], observador: null, visiveis: new Map() };
  }

  function referenciaDaImagem(m) {
    var i = m.imagem;
    if (typeof i !== 'object' || i === null || Array.isArray(i) || i.disponivel !== true) return null;
    if (typeof i.origem !== 'string' || !Object.prototype.hasOwnProperty.call(ORIGENS_IMAGEM, i.origem)) return null;
    if (typeof i.id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(i.id) || (i.id.length === 19 && i.id > ID_IMAGEM_MAXIMO)) return null;
    if (!Number.isInteger(i.versao) || i.versao < 1 || i.versao > 2147483647) return null;
    return { rota: ORIGENS_IMAGEM[i.origem], id: i.id, versao: i.versao };
  }

  function descartarImagens() {
    var im = imagens;
    imagens = novasImagens();
    clearTimeout(im.timer);
    im.repeticoes.forEach(function (t) { clearTimeout(t); });
    if (im.observador !== null) im.observador.disconnect();
    im.ativas.splice(0).forEach(function (c) { c.abort(); });
    im.urls.splice(0).forEach(function (u) { URL.revokeObjectURL(u); });
  }

  /* Pede a fotografia de um material. `aoPronto(url, entrada)` é chamado quando (ou se) ela chegar; `alta` passa à frente da fila.
     Falha definitiva (404, resposta inválida) fica registrada e não é repetida na sessão. */
  function pedirImagem(m, variante, alta, aoPronto) {
    var ref = referenciaDaImagem(m);
    if (ref === null) return;
    var chave = ref.rota + ':' + ref.id + ':' + variante + ':' + ref.versao;
    var e = imagens.cache[chave];
    if (e === undefined) {
      e = imagens.cache[chave] = { chave: chave, ref: ref, variante: variante, situacao: 'fila', tentativas: 0, url: null, ouvintes: [aoPronto], definitivo: false };
      enfileirarImagem(e, alta);
      return;
    }
    if (e.situacao === 'pronta') { aoPronto(e.url, e); return; }
    if (e.situacao === 'falha') {
      if (e.definitivo || !alta) return;
      e.tentativas = 0;
      e.ouvintes = [aoPronto];
      enfileirarImagem(e, true);
      return;
    }
    e.ouvintes.push(aoPronto);
    if (alta && e.situacao === 'fila') enfileirarImagem(e, true);
  }

  function enfileirarImagem(e, alta) {
    var i = imagens.fila.indexOf(e);
    if (i !== -1) imagens.fila.splice(i, 1);
    e.situacao = 'fila';
    if (alta) imagens.fila.unshift(e);
    else imagens.fila.push(e);
    bombearImagens();
  }

  /* Respeita o limite de requisições simultâneas, o espaçamento entre inícios e a pausa imposta por um 429. */
  function bombearImagens() {
    clearTimeout(imagens.timer);
    imagens.timer = null;
    while (imagens.fila.length > 0 && imagens.emVoo < IMAGENS_SIMULTANEAS) {
      var agora = Date.now();
      var espera = Math.max(imagens.pausaAte - agora, imagens.inicio + IMAGENS_ESPACAMENTO_MS - agora);
      if (espera > 0) { imagens.timer = setTimeout(bombearImagens, espera); return; }
      iniciarImagem(imagens.fila.shift());
    }
  }

  function lerRespostaDaImagem(r) {
    if (r.status === 200) {
      if (!/^image\/webp(;|$)/i.test(r.headers.get('Content-Type') || '')) return Promise.resolve({ tipo: 'invalida' });
      return r.blob().then(function (b) {
        return b && b.size > 0 && b.size <= IMAGEM_BYTES_MAXIMOS ? { tipo: 'ok', blob: b } : { tipo: 'invalida' };
      });
    }
    var espera = parseInt(r.headers.get('Retry-After'), 10);
    function erro(codigo) { return { tipo: 'http', status: r.status, codigo: codigo, corpo: null, espera: isNaN(espera) ? null : espera }; }
    return r.text().then(function (texto) {
      var dados = null;
      try { dados = texto === '' ? null : JSON.parse(texto); } catch (x) { dados = null; }
      return erro(dados && typeof dados.codigo === 'string' ? dados.codigo : null);
    }, function () { return erro(null); });
  }

  function iniciarImagem(e) {
    var im = imagens;
    var controle = new AbortController();
    var limite = setTimeout(function () { controle.abort(); }, IMAGEM_TEMPO_LIMITE_MS);
    e.situacao = 'voo';
    e.tentativas += 1;
    im.inicio = Date.now();
    im.emVoo += 1;
    im.ativas.push(controle);
    var url = API_BASE + TABLET + '/atendimento/imagens/' + e.ref.rota + '/' + e.ref.id + '/' + e.variante + '?v=' + e.ref.versao;
    function terminar(res) {
      clearTimeout(limite);
      im.emVoo -= 1;
      var i = im.ativas.indexOf(controle);
      if (i !== -1) im.ativas.splice(i, 1);
      if (im !== imagens) return; // geração encerrada: a resposta é descartada
      aoTerminarImagem(e, res);
      bombearImagens();
    }
    var requisicao = typeof API_BASE === 'string'
      ? fetch(url, { method: 'GET', credentials: 'include', headers: { Accept: 'image/webp' }, signal: controle.signal })
      : Promise.reject(new Error('sem API'));
    requisicao.then(lerRespostaDaImagem).then(terminar, function () { terminar({ tipo: 'falha' }); });
  }

  function aoTerminarImagem(e, res) {
    if (res.tipo === 'ok') {
      var url = null;
      try { url = URL.createObjectURL(res.blob); } catch (x) { url = null; }
      if (url === null) { falharImagem(e, true); return; }
      imagens.urls.push(url);
      e.url = url;
      e.situacao = 'pronta';
      var ouvintes = e.ouvintes;
      e.ouvintes = [];
      ouvintes.forEach(function (fn) { try { fn(url, e); } catch (x) { /* um destino com falha não impede os demais */ } });
      return;
    }
    if (res.tipo === 'http') {
      if (res.status === 401 || res.status === 403) { perdaDeAutorizacao({ tipo: 'resposta', status: res.status, codigo: res.codigo, corpo: null, espera: res.espera }); return; }
      if (res.status === 429) {
        var segundos = Math.min(Math.max(res.espera === null ? ESPERA_PADRAO_S : res.espera, 1), ESPERA_MAXIMA_S);
        imagens.pausaAte = Date.now() + segundos * 1000;
        e.tentativas -= 1; // o limite do servidor não consome as tentativas da imagem
        enfileirarImagem(e, true);
        return;
      }
      if (res.status < 500) { falharImagem(e, true); return; }
    }
    if (res.tipo === 'invalida') { falharImagem(e, true); return; }
    repetirImagem(e);
  }

  function repetirImagem(e) {
    if (e.tentativas >= IMAGEM_TENTATIVAS) { falharImagem(e, false); return; }
    var im = imagens;
    e.situacao = 'espera';
    var t = setTimeout(function () {
      var i = im.repeticoes.indexOf(t);
      if (i !== -1) im.repeticoes.splice(i, 1);
      enfileirarImagem(e, false);
    }, IMAGEM_ESPERA_REPETICAO_MS * e.tentativas);
    im.repeticoes.push(t);
  }

  function falharImagem(e, definitivo) {
    e.situacao = 'falha';
    e.definitivo = definitivo;
    e.ouvintes = [];
  }

  /* Troca o placeholder pela fotografia; se o navegador não conseguir decodificá-la, o placeholder volta e a imagem não é mais usada. */
  function aplicarImagem(destino, url, nome, e) {
    var vazio = destino.querySelector('.vazio');
    if (vazio === null) return;
    var foto = document.createElement('img');
    foto.setAttribute('alt', nome);
    foto.setAttribute('src', url);
    foto.addEventListener('error', function () {
      if (foto.parentNode !== destino) return;
      var novo = document.createElement('div');
      novo.className = 'vazio';
      destino.insertBefore(novo, foto);
      destino.removeChild(foto);
      if (imagens.cache[e.chave] === e && e.situacao === 'pronta') {
        var i = imagens.urls.indexOf(e.url);
        if (i !== -1) { imagens.urls.splice(i, 1); URL.revokeObjectURL(e.url); }
        e.url = null;
        falharImagem(e, true);
      }
    });
    destino.insertBefore(foto, vazio);
    destino.removeChild(vazio);
  }

  /* Miniatura do cartão. Com IntersectionObserver só as visíveis (com folga) entram na fila; sem ele, todas entram na ordem da grade. */
  function carregarMiniatura(destino, m) {
    pedirImagem(m, 'miniatura', false, function (url, e) { aplicarImagem(destino, url, m.nome, e); });
  }

  function observarMiniatura(destino, m) {
    if (referenciaDaImagem(m) === null) return;
    if (typeof IntersectionObserver !== 'function') { carregarMiniatura(destino, m); return; }
    var im = imagens;
    if (im.observador === null) {
      im.observador = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (x) {
          var carregar = im.visiveis.get(x.target);
          if (!x.isIntersecting || carregar === undefined) return;
          im.visiveis.delete(x.target);
          im.observador.unobserve(x.target);
          carregar();
        });
      }, { rootMargin: '200px' });
    }
    im.visiveis.set(destino, function () { carregarMiniatura(destino, m); });
    im.observador.observe(destino);
  }

  /* ═══ Consulta das solicitações (Etapa G) e catálogo (Etapa E) ═══ */
  function itemAberto(x) {
    return x && Number.isInteger(x.materialId) && x.materialId > 0 && typeof x.nome === 'string' && x.nome !== '' && x.nome.length <= LIMITE_NOME
      && (x.tamanho === null || (typeof x.tamanho === 'string' && x.tamanho.length >= 1 && x.tamanho.length <= 20))
      && Object.prototype.hasOwnProperty.call(SITUACOES_ABERTAS, x.situacao);
  }

  function materialValido(m) {
    return m && Number.isInteger(m.id) && m.id > 0 && typeof m.nome === 'string' && m.nome.trim() !== '' && m.nome.length <= LIMITE_NOME
      && typeof m.exigeTamanho === 'boolean' && Array.isArray(m.tamanhos) && m.tamanhos.length <= 100
      && m.tamanhos.every(function (t) { return typeof t === 'string' && t.length >= 1 && t.length <= 20; });
  }

  function tipoDe(m) { return m.tipo && typeof m.tipo.nome === 'string' ? m.tipo.nome.slice(0, LIMITE_NOME) : ''; }

  function emAberto(materialId, tamanho) {
    return estado.solicitacoes.some(function (x) { return x.materialId === materialId && (tamanho === undefined || x.tamanho === tamanho); });
  }

  function renderAviso() {
    Object.keys(SITUACOES_ABERTAS).forEach(function (situacao) {
      var lista = $(SITUACOES_ABERTAS[situacao]);
      var itens = estado.solicitacoes.filter(function (x) { return x.situacao === situacao; });
      lista.textContent = '';
      itens.forEach(function (x) {
        var li = document.createElement('li');
        li.textContent = x.nome + (x.tamanho === null ? '' : ' · ' + (x.tamanho === 'Único' ? 'tamanho único' : 'tamanho ' + x.tamanho));
        lista.appendChild(li);
      });
      $(SECOES_ABERTAS[situacao]).hidden = itens.length === 0;
    });
  }

  function svgIcone(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mi');
    svg.setAttribute('aria-hidden', 'true');
    var uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    uso.setAttribute('href', '#' + id);
    svg.appendChild(uso);
    return svg;
  }

  function textoTamanho(t) { return t === 'Único' ? 'tamanho único' : 'tamanho ' + t; }

  function renderResumo() {
    var raiz = $('resumo');
    raiz.textContent = '';
    $('blocoRevisar').hidden = estado.carrinho.length === 0;
    if (estado.carrinho.length === 0) return;
    var caixa = document.createElement('div');
    caixa.className = 'resumo';
    var ok = svgIcone('i-ok');
    ok.setAttribute('style', 'color:var(--ok)');
    caixa.appendChild(ok);
    var titulo = document.createElement('b');
    titulo.textContent = TEXTOS.nestaRetirada;
    caixa.appendChild(titulo);
    estado.carrinho.forEach(function (x) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = x.nome + (x.tamanho === null ? '' : ' · ' + x.tamanho);
      caixa.appendChild(chip);
    });
    raiz.appendChild(caixa);
  }

  function renderCatalogo() {
    var grade = $('grade');
    grade.textContent = '';
    estado.catalogo.forEach(function (m) {
      var cartao = document.createElement('button');
      cartao.type = 'button';
      cartao.className = 'prod';
      var imagem = document.createElement('span');
      imagem.className = 'prod-img';
      var vazio = document.createElement('div');
      vazio.className = 'vazio';
      imagem.appendChild(vazio);
      if (emAberto(m.id)) {
        var marca = document.createElement('span');
        marca.className = 'marca';
        marca.textContent = TEXTOS.solicitado;
        imagem.appendChild(marca);
      }
      var nome = document.createElement('span');
      nome.className = 'prod-nome';
      nome.textContent = m.nome;
      var tipo = document.createElement('span');
      tipo.className = 'prod-tipo';
      tipo.textContent = tipoDe(m);
      cartao.appendChild(imagem);
      cartao.appendChild(nome);
      cartao.appendChild(tipo);
      cartao.addEventListener('click', function () { atividade(); abrirProduto(m); });
      grade.appendChild(cartao);
      observarMiniatura(imagem, m);
    });
    $('subtituloProdutos').hidden = estado.catalogo.length === 0;
  }

  function mostrarEstadoDoCatalogo(texto) {
    $('estadoCatalogo').textContent = texto;
    $('estadoCatalogo').hidden = texto === '';
  }

  function carregarCatalogo(g) {
    chamar('GET', '/atendimento/catalogo', undefined, true).then(function (r) {
      if (g !== estado.geracao) return;
      if (perdaDeAutorizacao(r)) return;
      var c = r.tipo === 'resposta' && r.status === 200 && r.corpo && r.corpo.status === 'ok' ? r.corpo.catalogo : null;
      if (!c || typeof c.estado !== 'string' || !Array.isArray(c.materiais)) { mostrarEstadoDoCatalogo(TEXTOS.comunicacao); return; }
      if (Object.prototype.hasOwnProperty.call(ESTADOS_VAZIOS, c.estado)) { mostrarEstadoDoCatalogo(TEXTOS[ESTADOS_VAZIOS[c.estado]]); return; }
      if (c.estado !== 'OK') { mostrarEstadoDoCatalogo(TEXTOS.comunicacao); return; }
      estado.catalogo = c.materiais.slice(0, LIMITE_MATERIAIS).filter(materialValido);
      if (estado.catalogo.length === 0) { mostrarEstadoDoCatalogo(TEXTOS.semMateriais); return; }
      mostrarEstadoDoCatalogo('');
      renderCatalogo();
    });
  }

  function carregarSessao(g) {
    chamar('GET', '/atendimento/solicitacoes', undefined, true).then(function (r) {
      if (g !== estado.geracao) return;
      if (perdaDeAutorizacao(r)) return;
      var c = r.tipo === 'resposta' && r.status === 200 && r.corpo && r.corpo.status === 'ok' ? r.corpo : null;
      if (!c || !Array.isArray(c.itens)) { mostrarEstadoDoCatalogo(TEXTOS.comunicacao); return; }
      estado.solicitacoes = c.itens.filter(itemAberto);
      if (estado.solicitacoes.length > 0) {
        renderAviso();
        mostrar('telaAviso');
      }
      carregarCatalogo(g);
    });
  }

  /* ═══ Produto e tamanho (seleção visual; o pedido é do I-G4) ═══ */
  function atualizarAcao() {
    var m = estado.produto;
    var botao = $('btnSolicitar');
    if (m.exigeTamanho && estado.tamanho === null) {
      $('acaoTxt').textContent = TEXTOS.escolhaTamanho;
      botao.disabled = true;
      return;
    }
    $('acaoTxt').textContent = m.nome + (m.exigeTamanho ? ' · ' + textoTamanho(estado.tamanho) : '');
    botao.disabled = false;
  }

  function renderTamanhos() {
    var m = estado.produto;
    var raiz = $('tams');
    raiz.textContent = '';
    (m.exigeTamanho ? m.tamanhos : []).forEach(function (t) {
      var botao = document.createElement('button');
      botao.type = 'button';
      var escolhido = t === estado.tamanho;
      botao.className = 'tam' + (escolhido ? ' sel' : '');
      var rotulo = document.createElement('b');
      rotulo.textContent = t;
      botao.appendChild(rotulo);
      if (escolhido) {
        var marca = document.createElement('span');
        marca.textContent = TEXTOS.selecionado;
        botao.appendChild(marca);
      }
      botao.addEventListener('click', function () { atividade(); escolherTamanho(t); });
      raiz.appendChild(botao);
    });
    atualizarAcao();
  }

  /* Com um pedido em envio ou sem resultado, nada leva a outra tela nem altera o carrinho: a tentativa fica como está. */
  function irAosProdutos() {
    if (pedidoEmAberto()) return;
    atividade();
    mostrar('telaProdutos');
  }

  function escolherTamanho(t) {
    if (pedidoEmAberto() || estado.produto === null || estado.produto.tamanhos.indexOf(t) === -1) return;
    estado.tamanho = t;
    renderTamanhos();
  }

  function abrirProduto(m) {
    if (estado.atendimento === null || pedidoEmAberto()) return;
    estado.produto = m;
    estado.tamanho = null;
    var imagem = $('detImg');
    imagem.textContent = '';
    var vazio = document.createElement('div');
    vazio.className = 'vazio';
    imagem.appendChild(vazio);
    pedirImagem(m, 'exibicao', true, function (url, e) { if (estado.produto === m) aplicarImagem($('detImg'), url, m.nome, e); });
    $('detNome').textContent = m.nome;
    $('detTipo').textContent = tipoDe(m);
    renderTamanhos();
    mostrar('telaTamanhos');
  }

  /* Guarda o item no carrinho (em memória, uma unidade, sem motivo ainda). Nada vai ao servidor até o envio explícito. */
  function adicionar() {
    var m = estado.produto;
    if (estado.atendimento === null || m === null || pedidoEmAberto()) return;
    atividade();
    var tamanho = m.exigeTamanho ? estado.tamanho : null;
    if (m.exigeTamanho && tamanho === null) return;
    if (emAberto(m.id, tamanho)) { toast(TEXTOS.jaSolicitouNestaRetirada); return; }
    if (estado.carrinho.some(function (x) { return x.materialId === m.id && x.tamanho === tamanho; })) { toast(TEXTOS.jaIncluido); return; }
    if (estado.carrinho.length >= LIMITE_ITENS) { toast(TEXTOS.limite20); return; }
    estado.carrinho.push({ materialId: m.id, nome: m.nome, tamanho: tamanho, motivo: null });
    renderResumo();
    mostrar('telaProdutos');
  }

  /* ═══ Revisão e envio do pedido (Etapa F) ═══ */
  function podeEnviar() {
    var n = estado.carrinho.length;
    return estado.atendimento !== null && n >= 1 && n <= LIMITE_ITENS && !pedidoEmAberto()
      && estado.carrinho.every(function (x) { return MOTIVOS.indexOf(x.motivo) !== -1; });
  }

  function renderRevisao() {
    var raiz = $('itensRevisao');
    raiz.textContent = '';
    estado.carrinho.forEach(function (x, i) {
      var linha = document.createElement('div');
      linha.className = 'item-rev';
      linha.setAttribute('data-item', String(i));
      var nome = document.createElement('div');
      nome.className = 'nome';
      nome.textContent = x.nome + (x.tamanho === null ? '' : ' · ' + textoTamanho(x.tamanho)) + ' · 1 unidade';
      linha.appendChild(nome);
      var motivos = document.createElement('div');
      motivos.className = 'motivos';
      MOTIVOS.forEach(function (codigo) {
        var botao = document.createElement('button');
        botao.type = 'button';
        botao.className = 'tam' + (x.motivo === codigo ? ' sel' : '');
        botao.setAttribute('data-motivo', codigo);
        var rotulo = document.createElement('b');
        rotulo.textContent = TEXTOS.motivos[codigo];
        botao.appendChild(rotulo);
        botao.addEventListener('click', function () { escolherMotivo(i, codigo); });
        motivos.appendChild(botao);
      });
      linha.appendChild(motivos);
      var remover = document.createElement('button');
      remover.type = 'button';
      remover.className = 'btn btn-outlined btn-sm';
      remover.textContent = TEXTOS.remover;
      remover.addEventListener('click', function () { removerItem(i); });
      linha.appendChild(remover);
      var erro = document.createElement('div');
      erro.className = 'erro-item';
      erro.textContent = estado.errosItem[i] || '';
      linha.appendChild(erro);
      raiz.appendChild(linha);
    });
    $('erroEnvio').textContent = estado.erroEnvio;
    $('btnEnviar').disabled = !podeEnviar();
  }

  function limparErrosDoPedido() { estado.errosItem = {}; estado.erroEnvio = ''; }

  function escolherMotivo(indice, codigo) {
    var item = estado.carrinho[indice];
    if (item === undefined || MOTIVOS.indexOf(codigo) === -1 || pedidoEmAberto()) return;
    atividade();
    item.motivo = codigo; // o motivo pertence a ESTE item
    limparErrosDoPedido();
    renderRevisao();
  }

  function removerItem(indice) {
    if (estado.carrinho[indice] === undefined || pedidoEmAberto()) return;
    atividade();
    estado.carrinho.splice(indice, 1); // o motivo vai junto
    limparErrosDoPedido();
    renderResumo();
    if (estado.carrinho.length === 0) { mostrar('telaProdutos'); return; }
    renderRevisao();
  }

  function abrirRevisao() {
    if (estado.atendimento === null || estado.carrinho.length === 0 || pedidoEmAberto()) return;
    atividade();
    renderRevisao();
    mostrar('telaRevisao');
  }

  function novaChave() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (!c || typeof c.getRandomValues !== 'function') return null; // sem fonte segura não há chave: nada é enviado
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* Conteúdo lógico do carrinho: uma unidade por item, tamanho só quando há, motivo do próprio item. */
  function conteudoDoCarrinho() {
    var itens = estado.carrinho.map(function (x) {
      var item = { materialId: x.materialId, quantidade: 1, motivo: x.motivo };
      if (x.tamanho !== null) item.tamanho = x.tamanho;
      return item;
    });
    var canonico = itens.map(function (i) { return [i.materialId, i.tamanho === undefined ? '' : i.tamanho, i.quantidade, i.motivo].join('|'); }).sort().join(';');
    return { itens: itens, canonico: canonico };
  }

  /* O número do pedido é o INTEGER do backend (CHECK numero > 0): inteiro de 1 a 2147483647. Texto, zero, negativo, decimal e outros tipos não confirmam. */
  function numeroDePedidoValido(n) {
    return Number.isInteger(n) && n >= 1 && n <= 2147483647;
  }

  /* A confirmação do servidor: 201 (criado) ou 200 repetido, com status ok e um número. Qualquer outra coisa NÃO é sucesso. */
  function pedidoConfirmado(r) {
    var c = r.corpo;
    return (r.status === 201 || r.status === 200) && c && c.status === 'ok' && c.pedido && numeroDePedidoValido(c.pedido.numero)
      && Number.isInteger(c.pedido.quantidadeItens);
  }

  /* Sucesso comprovado: o estado sensível some NA HORA (nome, carrinho, catálogo, motivos, chave) e só fica a confirmação neutra.
     O servidor já encerrou o atendimento e removeu o cookie junto com esta resposta; a página não chama o encerramento. */
  function confirmar() {
    limparAtendimento();
    mostrar('telaConfirma');
    estado.retorno = setTimeout(function () { estado.retorno = null; voltarAIdentificacao(null); }, RETORNO_CONFIRMACAO_MS);
  }

  function mostrarIncerto() {
    $('msgProcessando').hidden = true;
    $('btnReenviar').hidden = true;
    $('btnVerificar').disabled = false;
    mostrar('telaIncerto');
  }

  function rejeitarPedido(textoGeral, indice, textoDoItem) {
    estado.pedido.fase = 'rejeitado';
    estado.erroEnvio = textoGeral || '';
    estado.errosItem = {};
    if (indice !== null && estado.carrinho[indice] !== undefined) estado.errosItem[indice] = textoDoItem;
    renderRevisao();
    mostrar('telaRevisao');
  }

  /* Resultado transacional do pedido (criado ou não) é um problema; a barreira de cookies é outro. A barreira já conta esta
     requisição (chamar(..., true)): resposta recebida libera, sem resposta trava. Aqui só se decide o que se mostra. */
  function aoResponderPedido(p, r, primeira) {
    if (r.tipo === 'incerto') { p.fase = 'incerto'; mostrarIncerto(); return; }
    if (pedidoConfirmado(r)) { confirmar(); return; }
    if (r.status >= 200 && r.status < 300) { p.fase = 'incerto'; mostrarIncerto(); return; } // 2xx fora do contrato: o pedido pode existir
    if (bloqueioDe(r)) return;
    if (r.status === 401) {
      // Sessão inválida na própria resposta do envio: o servidor não aceitou ESTA requisição. Num reenvio depois de um resultado
      // desconhecido isso não diz nada sobre a tentativa anterior.
      voltarAIdentificacao(primeira ? TEXTOS.expirada : TEXTOS.sessaoTerminou);
      return;
    }
    if (r.status === 429) {
      var s = r.espera === null ? ESPERA_PADRAO_S : Math.min(Math.max(r.espera, 1), ESPERA_MAXIMA_S);
      p.ate = Date.now() + s * 1000;
      rejeitarPedido(TEXTOS.limite, null, '');
      return;
    }
    if (r.status === 400) { rejeitarPedido(TEXTOS.comunicacao, null, ''); return; }
    if (r.status === 409 && (r.codigo === 'ITEM_JA_SOLICITADO' || r.codigo === 'ITEM_NAO_AUTORIZADO')) {
      var campo = r.corpo && r.corpo.detalhes && r.corpo.detalhes[0] && r.corpo.detalhes[0].campo;
      var m = /^body\.itens\[(\d+)\]/.exec(typeof campo === 'string' ? campo : '');
      rejeitarPedido('', m ? Number(m[1]) : null, r.codigo === 'ITEM_JA_SOLICITADO' ? TEXTOS.duplicado : TEXTOS.naoLiberado);
      return;
    }
    // 409 de idempotência ou desconhecido, 5xx e o que sobrar: o contrato não permite dizer se o pedido existe.
    p.fase = 'incerto';
    mostrarIncerto();
  }

  function transmitir(p) {
    var g = estado.geracao;
    p.transmissoes += 1;
    var primeira = p.transmissoes === 1;
    p.fase = 'enviando';
    clearTimeout(estado.renovacao.timer); // a renovação que fecharia a rajada de ações do carrinho não sai mais: o envio assumiu a sessão
    estado.renovacao.timer = null;
    estado.renovacao.pendente = false;
    $('btnEnviar').disabled = true;
    chamar('POST', '/atendimento/pedido', { chaveIdempotencia: p.chave, itens: p.itens }, true).then(function (r) {
      if (g !== estado.geracao) return; // sessão de outra geração: a resposta não toca na tela
      aoResponderPedido(p, r, primeira);
    });
  }

  /* Só por toque explícito. A mesma chave acompanha o mesmo conteúdo; conteúdo novo, chave nova (nunca no resultado incerto). */
  function enviar() {
    if (!podeEnviar()) return;
    var p = estado.pedido;
    if (p !== null && p.ate > Date.now()) { estado.erroEnvio = TEXTOS.limite; renderRevisao(); return; }
    var c = conteudoDoCarrinho();
    if (p === null || p.conteudo !== c.canonico) {
      var chave = novaChave();
      if (chave === null) { estado.erroEnvio = TEXTOS.comunicacao; renderRevisao(); return; }
      p = estado.pedido = { chave: chave, conteudo: c.canonico, itens: c.itens, fase: 'enviando', transmissoes: 0, ate: 0 };
    }
    limparErrosDoPedido();
    transmitir(p);
  }

  /* Recuperação prevista no contrato F: GET /atendimento/pedidos/:chave, só do atendimento que enviou o pedido. */
  function verificar() {
    var p = estado.pedido;
    if (p === null || p.fase !== 'incerto' || p.verificando) return;
    p.verificando = true;
    $('btnVerificar').disabled = true;
    var g = estado.geracao;
    chamar('GET', '/atendimento/pedidos/' + encodeURIComponent(p.chave), undefined, true).then(function (r) {
      if (g !== estado.geracao) return;
      p.verificando = false;
      $('btnVerificar').disabled = false;
      var aviso = $('msgProcessando');
      if (r.tipo === 'incerto') { aviso.textContent = TEXTOS.comunicacao; aviso.hidden = false; return; }
      if (bloqueioDe(r)) return;
      // 401: o atendimento acabou ou o cookie foi removido. Sem acesso não se sabe se o pedido existe: nada é afirmado.
      if (r.status === 401) { voltarAIdentificacao(TEXTOS.sessaoTerminou); return; }
      var pedido = r.corpo && r.corpo.status === 'ok' ? r.corpo.pedido : null;
      if (r.status === 200 && pedido && pedido.estado === 'REGISTRADO' && numeroDePedidoValido(pedido.numero)) { confirmar(); return; }
      if (r.status === 202 && pedido && pedido.estado === 'EM_PROCESSAMENTO') { aviso.textContent = TEXTOS.processando; aviso.hidden = false; return; }
      if (r.status === 404 && r.codigo === 'PEDIDO_NAO_ENCONTRADO') { aviso.hidden = true; $('btnReenviar').hidden = false; return; }
      aviso.textContent = TEXTOS.comunicacao;
      aviso.hidden = false;
    });
  }

  /* Repetição idempotente: a MESMA chave e o MESMO conteúdo da tentativa original (cópia guardada), só depois de a consulta
     indicar que o pedido não existe, e só por toque. */
  function reenviar() {
    var p = estado.pedido;
    if (p === null || p.fase !== 'incerto' || p.verificando) return;
    $('btnReenviar').hidden = true;
    $('msgProcessando').hidden = true;
    transmitir(p);
  }

  /* ═══ Identificação e atendimento ═══ */
  function atendimentoValido(r) {
    var c = r.corpo;
    var a = c && c.atendimento;
    var nome = a && a.funcionario && a.funcionario.primeiroNome;
    return c && c.status === 'ok' && typeof nome === 'string' && nome.trim() !== '' && nome.length <= 100
      && typeof a.inatividadeSegundos === 'number' && a.inatividadeSegundos >= 1 && a.inatividadeSegundos <= 3600;
  }

  function iniciarAtendimento(r, enviadoEm) {
    var a = r.corpo.atendimento;
    var nome = a.funcionario.primeiroNome.trim();
    limparIdentificacao();
    invalidarSessao(); // geração nova: nada de uma sessão anterior pode mais agir
    var g = estado.geracao;
    $('quem').textContent = nome;
    $('ola').textContent = 'Olá, ' + nome;
    $('sessao').classList.add('on');
    mostrar('telaProdutos');
    iniciarRelogio(a.inatividadeSegundos, enviadoEm);
    carregarSessao(g);
  }

  function falhaDeIdentificacao(texto) {
    $('doc').classList.add('invalid');
    $('erro').textContent = texto;
    $('doc').focus();
  }

  function aoIdentificar(r, g, enviadoEm) {
    estado.identificando = false;
    $('btnContinuar').disabled = false;
    if (g !== estado.geracao) {
      // A tela já mudou de dono (recarga, retorno, bloqueio): nada desta resposta toca a interface. Se ela abriu um
      // atendimento no servidor, ele é fechado em melhor esforço.
      if (r.tipo === 'incerto' || r.status === 201) encerrarNoServidor();
      return;
    }
    if (r.tipo === 'incerto') {
      // Pode ter sido criado um atendimento sem que a resposta chegasse: fecha-se em melhor esforço, sem presumir nada.
      encerrarNoServidor();
      falhaDeIdentificacao(TEXTOS.comunicacao);
      return;
    }
    if (bloqueioDe(r)) return;
    if (r.status === 201) {
      if (atendimentoValido(r)) { iniciarAtendimento(r, enviadoEm); return; }
      encerrarNoServidor();
      falhaDeIdentificacao(TEXTOS.comunicacao);
      return;
    }
    if (r.status === 400 || r.status === 404) { falhaDeIdentificacao(TEXTOS.naoEncontrado); return; }
    if (r.status === 429) {
      var s = r.espera === null ? ESPERA_PADRAO_S : Math.min(Math.max(r.espera, 1), ESPERA_MAXIMA_S);
      estado.espera = Date.now() + s * 1000;
      falhaDeIdentificacao(TEXTOS.limite);
      return;
    }
    falhaDeIdentificacao(TEXTOS.comunicacao);
  }

  /* O tipo nunca é deduzido do formato; o CPF segue só com os 11 dígitos e a matrícula exatamente como foi digitada. */
  function continuar() {
    var campo = $('doc');
    if (estado.identificando) return;
    limparErro();
    if (estado.tipo === null) {
      $('tipos').classList.add('pendente');
      $('tipoCpf').focus();
      return;
    }
    var vazio = estado.tipo === 'CPF' ? digitos(campo.value) === '' : campo.value.trim() === '';
    if (vazio) { falhaDeIdentificacao(TEXTOS.campoVazio); return; }
    if (estado.tipo === 'CPF' && digitos(campo.value).length !== LIMITE_CPF) { falhaDeIdentificacao(TEXTOS.cpfIncompleto); return; }
    if (Date.now() < estado.espera) { falhaDeIdentificacao(TEXTOS.limite); return; }
    if (!transicaoLiberada()) { falhaDeIdentificacao(TEXTOS.comunicacao); return; }
    estado.identificando = true;
    $('btnContinuar').disabled = true;
    cancelarAbandono();
    var g = estado.geracao;
    var enviadoEm = Date.now();
    chamar('POST', '/atendimento', { tipo: estado.tipo, valor: estado.tipo === 'CPF' ? digitos(campo.value) : campo.value }, true).then(function (r) { aoIdentificar(r, g, enviadoEm); });
  }

  /* Limpa tudo na hora e só depois avisa o servidor; se o aviso falhar, a sessão antiga já não é usada por esta página e
     o servidor a encerra pelos 60 s de inatividade. */
  function sair() {
    var tinhaAtendimento = estado.atendimento !== null;
    voltarAIdentificacao(null);
    if (tinhaAtendimento) encerrarNoServidor();
  }

  /* ═══ Ligações da interface ═══ */
  function ligar() {
    $('doc').setAttribute('placeholder', TEXTOS.marcadorCampo);
    $('doc').addEventListener('input', function () { escrever($('doc').value); limparErro(); });
    $('doc').addEventListener('keydown', function (e) { if (e.key === 'Enter') continuar(); });
    $('teclado').querySelectorAll('[data-tecla]').forEach(function (b) {
      b.addEventListener('click', function () { tecla(b.getAttribute('data-tecla')); });
    });
    $('btnLimpar').addEventListener('click', limparCampo);
    $('btnApagar').addEventListener('click', apagar);
    $('btnContinuar').addEventListener('click', continuar);
    $('tipoCpf').addEventListener('click', function () { escolherTipo('CPF'); });
    $('tipoMatricula').addEventListener('click', function () { escolherTipo('MATRICULA'); });
    $('btnTeclado').addEventListener('click', function () {
      definirTeclado(!estado.tecladoNumerico);
      $('doc').blur();
      $('doc').focus();
    });

    $('btnAtivar').addEventListener('click', ativar);
    $('btnSair').addEventListener('click', sair);
    $('btnConcluir').addEventListener('click', sair);
    $('btnAvisoOk').addEventListener('click', function () { irAosProdutos(); });
    $('btnOutroProduto').addEventListener('click', function () { irAosProdutos(); });
    $('btnVoltarProdutos').addEventListener('click', function () { irAosProdutos(); });
    $('btnVoltarRevisao').addEventListener('click', function () { irAosProdutos(); });
    $('btnSolicitar').addEventListener('click', adicionar);
    $('btnRevisar').addEventListener('click', abrirRevisao);
    $('btnEnviar').addEventListener('click', enviar);
    $('btnVerificar').addEventListener('click', verificar);
    $('btnReenviar').addEventListener('click', reenviar);

    // Página restaurada do cache do navegador ou navegação de retorno: nada do atendimento anterior pode reaparecer.
    window.addEventListener('pageshow', function (e) { if (e.persisted) reiniciar(); });
    window.addEventListener('popstate', reiniciar);
  }

  ligar();
  escolherTipo(null);
  if (ativacao.situacao === 'ausente') inicio();
  else iniciarAtivacao();
})();
