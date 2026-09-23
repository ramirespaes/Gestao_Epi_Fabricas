const express = require('express');

const { httpConfig } = require('./config/http');
const healthRoutes = require('./routes/health.routes');
const { authRoutes } = require('./routes/auth.routes');
const { grupoAcessoRoutes } = require('./routes/grupo-acesso.routes');
const { grupoPermissaoRoutes } = require('./routes/grupo-permissao.routes');
const { grupoUsuarioRoutes } = require('./routes/grupo-usuario.routes');
const { autorizacaoIndividualRoutes } = require('./routes/autorizacao-individual.routes');
const { catalogoRoutes } = require('./routes/catalogo.routes');
const { usuarioConsultaRoutes } = require('./routes/usuario-consulta.routes');
const { autorizacaoConsultaRoutes } = require('./routes/autorizacao-consulta.routes');
const { delegacaoDestinatariosRoutes } = require('./routes/delegacao-destinatarios.routes');
const { cabecalhosSeguranca, semCache } = require('./middleware/cabecalhos');
const { corsApi } = require('./middleware/cors');
const { exigirJson, parserJson } = require('./middleware/conteudo');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { verificarOrigem } = require('./middleware/origem');
const { limitadorGeral } = require('./middleware/rate-limit');

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
app.use('/api', corsApi, semCache, verificarOrigem, limitadorGeral, exigirJson, parserJson, healthRoutes, authRoutes, grupoAcessoRoutes, grupoPermissaoRoutes, grupoUsuarioRoutes, autorizacaoIndividualRoutes, catalogoRoutes, usuarioConsultaRoutes, autorizacaoConsultaRoutes, delegacaoDestinatariosRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
