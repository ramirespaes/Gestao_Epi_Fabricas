const express = require('express');

const { httpConfig } = require('./config/http');
const healthRoutes = require('./routes/health.routes');
const { authRoutes } = require('./routes/auth.routes');
const { authGlobalRoutes } = require('./routes/auth-global.routes');
const { authPlataformaRoutes } = require('./routes/auth-plataforma.routes');
const { painelPlataformaRoutes } = require('./routes/painel-plataforma.routes');
const { empresaCadastroRoutes } = require('./routes/empresa-cadastro.routes');
const { conviteMasterRoutes } = require('./routes/convite-master.routes');
const { grupoAcessoRoutes } = require('./routes/grupo-acesso.routes');
const { grupoPermissaoRoutes } = require('./routes/grupo-permissao.routes');
const { grupoUsuarioRoutes } = require('./routes/grupo-usuario.routes');
const { autorizacaoIndividualRoutes } = require('./routes/autorizacao-individual.routes');
const { catalogoRoutes } = require('./routes/catalogo.routes');
const { usuarioConsultaRoutes } = require('./routes/usuario-consulta.routes');
const { autorizacaoConsultaRoutes } = require('./routes/autorizacao-consulta.routes');
const { delegacaoDestinatariosRoutes } = require('./routes/delegacao-destinatarios.routes');
const { materialRoutes } = require('./routes/material.routes');
const { estoqueRoutes } = require('./routes/estoque.routes');
const { grupoHomogeneoExposicaoRoutes } = require('./routes/grupo-homogeneo-exposicao.routes');
const { funcionarioRoutes } = require('./routes/funcionario.routes');
const { cabecalhosSeguranca, semCache } = require('./middleware/cabecalhos');
const { corsApi, corsPlataforma } = require('./middleware/cors');
const { exigirJson, parserJson } = require('./middleware/conteudo');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { verificarOrigem, verificarOrigemPlataforma } = require('./middleware/origem');
const { verificarHostPlataforma } = require('./middleware/host-plataforma');
const { limitadorGeral, limitadorPlataformaGeral } = require('./middleware/rate-limit');

const app = express();

// 0 = nenhum proxy confiável: X-Forwarded-For enviado pelo cliente é
// ignorado e req.ip é o endereço do socket. Um valor numérico só é seguro
// quando a topologia de proxy é conhecida e fixa: maior que a realidade
// permite forjar o IP (e a chave do rate limit); menor agrupa todos os
// clientes no IP do proxy. A configuração de produção será validada quando a
// infraestrutura real for definida.
app.set('trust proxy', httpConfig.proxy.hops === 0 ? false : httpConfig.proxy.hops);

// Nunca anunciar a tecnologia do servidor.
app.disable('x-powered-by');

// Cabeçalhos de segurança em toda resposta, inclusive erros e 404.
app.use(cabecalhosSeguranca);

// Namespace /api/plataforma (Autenticação Global — Pacote 2): cadeia
// COMPLETAMENTE separada da cadeia /api abaixo — CORS, verificação de
// origem, validação de Host e rate limit próprios, com allowlists
// exclusivas do Painel Privado (httpConfig.plataforma.*), nunca
// compartilhadas com o cliente. Precisa ser montada ANTES de app.use('/api',
// ...): /api/plataforma é um sub-caminho de /api, então se a cadeia geral
// viesse primeiro, uma requisição para /api/plataforma/auth/login passaria
// pelo CORS/Origin do CLIENTE antes de qualquer coisa (e seria rejeitada,
// porque a origem do Painel Privado não está na allowlist do cliente).
// Termina com seu PRÓPRIO notFoundHandler: um caminho não encontrado sob
// /api/plataforma nunca cai para a cadeia /api geral (ver
// src/middleware/autenticacao-plataforma.js e host-plataforma.js).
//
// verificarHostPlataforma é defesa em profundidade, no-op enquanto
// PLATAFORMA_HOST não estiver definido (sem subdomínio real ainda) — a
// defesa real, quando os dois portais forem subdomínios do mesmo domínio
// registrável (SameSite não os distingue), é a allowlist de CORS/Origin
// específica desta cadeia, mais o nome de cookie diferente do cliente
// (ver adendo v2.1, seção 3).
app.use(
  '/api/plataforma',
  corsPlataforma,
  semCache,
  verificarOrigemPlataforma,
  verificarHostPlataforma,
  limitadorPlataformaGeral,
  exigirJson,
  parserJson,
  authPlataformaRoutes,
  painelPlataformaRoutes,
  // Pacote 3: cadastro de empresas e convite do MASTER — mesma cadeia,
  // mesmas allowlists. As rotas administrativas exigem sessão do Painel
  // Privado dentro das próprias fábricas; as duas rotas públicas de aceite
  // de convite (posse do token como autoridade) não exigem sessão alguma.
  empresaCadastroRoutes,
  conviteMasterRoutes,
  notFoundHandler,
);

// Namespace /api: CORS com allowlist (preflight permitido termina aqui, com
// Max-Age e sem no-store), sem cache, verificação de origem em métodos que
// alteram estado (origem inválida é rejeitada antes de consumir cota),
// limite por IP, política de conteúdo (exige application/json quando há corpo
// em POST/PUT/PATCH e interpreta JSON com o limite do projeto) e rotas. Fora
// de /api nada disso se aplica.
//
// authRoutes soma, só na própria rota de login, o limitadorAutenticacao
// (mais estrito que limitadorGeral) e a validação Zod do corpo — ver
// src/routes/auth.routes.js. Nenhuma configuração de CORS, CSRF, rate limit
// geral, cookie ou PostgreSQL muda aqui: authRoutes só se soma à mesma
// cadeia já existente, no mesmo prefixo /api.
//
// grupoAcessoRoutes (Subetapa 3M), grupoPermissaoRoutes (Subetapa 3N),
// grupoUsuarioRoutes (Subetapa 3O) e autorizacaoIndividualRoutes
// (Subetapa 3P) entram na MESMA cadeia, pelo mesmo prefixo, sem
// reconfigurar nada: todas as suas rotas exigem sessão (exigirSessao) e
// a autorização de cada operação continua sendo decidida no serviço
// correspondente, que relê o perfil do banco a cada chamada. Nenhuma
// segunda aplicação Express, nenhum servidor paralelo.
//
// materialRoutes e estoqueRoutes (Bloco 9, Etapa A) entram na MESMA
// cadeia, pela mesma razão — mas, diferente das rotas acima, sua
// autorização é decidida ANTES do controller, pelo middleware de permissão
// por recurso/ação já existente desde o Bloco 8
// (criarExigirPermissaoRecurso/criarExigirPermissaoAcao,
// src/middleware/autorizacao.js), montado dentro das próprias fábricas de
// rota. Nenhuma configuração nova aqui.
//
// grupoHomogeneoExposicaoRoutes e funcionarioRoutes (Bloco 9, Etapa B):
// mesmo mecanismo da Etapa A, recursos 'employeeGroups' e 'employeeHistory'.
//
// authGlobalRoutes (Autenticação Global — Pacote 4): login global por
// e-mail+senha, seleção/troca de empresa e "sair completamente" do Portal
// do Cliente — MESMA cadeia, mesmas allowlists do cliente (nunca as da
// plataforma). Emite o cookie global (nome próprio) e, ao selecionar
// empresa, o MESMO cookie empresarial que exigirSessao já lê: nenhuma
// rota de negócio muda.
app.use('/api', corsApi, semCache, verificarOrigem, limitadorGeral, exigirJson, parserJson, healthRoutes, authRoutes, authGlobalRoutes, grupoAcessoRoutes, grupoPermissaoRoutes, grupoUsuarioRoutes, autorizacaoIndividualRoutes, catalogoRoutes, usuarioConsultaRoutes, autorizacaoConsultaRoutes, delegacaoDestinatariosRoutes, materialRoutes, estoqueRoutes, grupoHomogeneoExposicaoRoutes, funcionarioRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
