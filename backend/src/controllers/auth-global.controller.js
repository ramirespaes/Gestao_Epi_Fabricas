'use strict';

const loginGlobalService = require('../services/login-global.service');
const contextoEmpresarialService = require('../services/contexto-empresarial.service');
const sessaoRepo = require('../repositories/sessao.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const identidadeRepo = require('../repositories/identidade.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const { HttpError } = require('../errors/HttpError');
const { PADRAO: PREFERENCIAS_PADRAO } = require('../utils/preferencias-aparencia');
const { mascararCpf } = require('../utils/normalizacao');
const autenticacaoMiddleware = require('../middleware/autenticacao');
const autenticacaoGlobalMiddleware = require('../middleware/autenticacao-global');
const {
  serializarCookieSessao,
  serializarRemocaoCookieSessao,
  serializarCookieSessaoGlobal,
  serializarRemocaoCookieSessaoGlobal,
} = require('../security/cookie');
const { pool } = require('../config/database');

/**
 * Controller de autenticação GLOBAL do Portal do Cliente (Autenticação
 * Global — Pacote 4). Mesmas garantias de auth.controller.js: traduz
 * serviço em HTTP sem decidir regra de negócio; sem try/catch (Express 5
 * encaminha ao errorHandler); serviços chamados por namespace; NENHUM
 * token no corpo — só em Set-Cookie HttpOnly.
 *
 * DOIS COOKIES, DUAS DECISÕES: `gepi_sessao_global` (identidade) sai de
 * todo login bem-sucedido; `gepi_sessao` (empresa) só sai quando o serviço
 * de contexto empresarial criou uma sessão empresarial — seleção
 * automática (uma única empresa) ou seleção/troca explícita. Quando não há
 * contexto empresarial, o cookie empresarial recebe REMOÇÃO, para que um
 * cookie antigo de outro login nunca sobreviva a um login novo.
 *
 * O que a requisição JÁ TRAZIA (sessão global e/ou empresarial anteriores)
 * é resolvido aqui com os helpers não estritos dos middlewares — mesma
 * técnica do logout — e entregue ao serviço para revogação. Só o serviço
 * escreve no banco.
 */

const anteriorEmpresarial = (contexto) => (contexto === null ? null : { empresaId: contexto.empresa.id, sessaoId: contexto.sessao.id });
// Na seleção, a anterior leva também o usuário e a identidade dela, lidos do
// servidor: a auditoria só chama de troca o contexto da mesma pessoa.
const anteriorParaSelecao = (contexto) => (contexto === null ? null : {
  empresaId: contexto.empresa.id, sessaoId: contexto.sessao.id, usuarioId: contexto.usuario.id, identidadeId: contexto.usuario.identidadeId ?? null,
});
const anteriorGlobal = (contexto) => (contexto === null ? null : { sessaoId: contexto.sessao.id });
const corpoContexto = (contexto) => (contexto === null ? null : { usuario: contexto.usuario, empresa: contexto.empresa });

function criarAuthGlobalController({ pool: poolInjetado }) {
  return {
    async login(req, res) {
      const { email, senha } = req.validado.body;
      const ip = req.ip;
      const dispositivo = req.headers['user-agent'];

      // (1) Cookies que já vieram na requisição (de um login anterior, desta
      // ou de outra pessoa) são apenas IDENTIFICADOS aqui — somente leitura.
      const [globalAnterior, empresarialAnterior] = await Promise.all([
        autenticacaoGlobalMiddleware.buscarContextoSessaoGlobal(poolInjetado, req),
        autenticacaoMiddleware.buscarContextoSessao(poolInjetado, req),
      ]);

      // (2) Credenciais PRIMEIRO. 401, 429 ou erro inesperado propagam daqui
      // sem tocar em sessão nenhuma: uma tentativa de login nunca derruba,
      // por si só, a sessão válida que o navegador já tinha.
      const autenticado = await loginGlobalService.autenticar(poolInjetado, { email, senha, ip, dispositivo });

      // (3) Autenticado: a sessão global nova já existe no banco, mas o
      // cookie dela ainda não saiu. Seleção automática e substituição das
      // sessões anteriores rodam sob COMPENSAÇÃO — se qualquer uma falhar,
      // a sessão global nova (e o que tiver nascido dela) é revogada antes
      // de o erro seguir ao errorHandler: nunca fica uma sessão válida cujo
      // cookie não foi entregue. As anteriores só são substituídas DEPOIS
      // que o novo contexto está pronto, então uma falha aqui as preserva.
      let empresas;
      let contexto;
      try {
        ({ empresas, contexto } = await contextoEmpresarialService.resolverAposLogin(poolInjetado, {
          identidadeId: autenticado.identidade.id,
          sessaoGlobalId: autenticado.sessao.id,
          ip,
          dispositivo,
        }));
        // Senha certa, nenhuma empresa utilizável e ao menos um vínculo desabilitado: a causa real é dita.
        if (empresas.length === 0 && await usuarioRepo.contarVinculosInativosDaIdentidade(poolInjetado, autenticado.identidade.id) > 0) {
          throw HttpError.unauthorized('USUARIO_DESATIVADO', 'Usuário desativado. Procure o administrador da empresa.');
        }
        await contextoEmpresarialService.encerrarAnteriores(poolInjetado, {
          sessaoGlobalAnterior: anteriorGlobal(globalAnterior),
          sessaoEmpresarialAnterior: anteriorEmpresarial(empresarialAnterior),
        });
      } catch (erro) {
        await contextoEmpresarialService.compensarLoginIncompleto(poolInjetado, { sessaoGlobalId: autenticado.sessao.id });
        throw erro;
      }

      res.append('Set-Cookie', serializarCookieSessaoGlobal(autenticado.token));
      res.append('Set-Cookie', contexto === null ? serializarRemocaoCookieSessao() : serializarCookieSessao(contexto.token));
      res.status(200).json({
        status: 'ok',
        identidade: autenticado.identidade,
        empresas,
        contexto: corpoContexto(contexto),
      });
    },

    /**
     * Identidade autenticada, empresas autorizadas e o contexto empresarial
     * ATUAL (se o cookie empresarial trouxer uma sessão válida DA MESMA
     * identidade — um cookie empresarial de outra identidade é ignorado,
     * nunca apresentado como contexto desta).
     */
    async me(req, res) {
      // Configurações: a identidade sai com telefone, aparência e o último
      // acesso (sessão global anterior) — leitura da própria conta, sem rota nova.
      const [empresas, empresarial, conta, ultimoAcessoEm] = await Promise.all([
        contextoEmpresarialService.listarEmpresas(poolInjetado, { identidadeId: req.identidade.id }),
        autenticacaoMiddleware.buscarContextoSessao(poolInjetado, req),
        identidadeRepo.buscarPorId(poolInjetado, req.identidade.id),
        sessaoGlobalRepo.buscarUltimoAcessoAnterior(poolInjetado, req.identidade.id, req.sessaoGlobal.id),
      ]);
      const contexto = empresarial !== null && empresarial.usuario.identidadeId === req.identidade.id ? empresarial : null;
      const preferencias = conta === null ? { telefone: null, ...PREFERENCIAS_PADRAO } : { telefone: conta.telefone, tema: conta.tema, modoVisual: conta.modoVisual };
      // Minha Conta: situação real do vínculo e o funcionário explicitamente
      // vinculado (073), com o CPF só mascarado — o padrão da aplicação.
      const operacional = contexto === null ? null : await usuarioRepo.buscarContaOperacional(poolInjetado, contexto.empresa.id, contexto.usuario.id);
      const funcionario = operacional === null || operacional.funcionario === null
        ? { vinculado: false, matricula: null, cpfMascarado: null }
        : { vinculado: true, matricula: operacional.funcionario.matricula, cpfMascarado: mascararCpf(operacional.funcionario.cpf) };
      res.status(200).json({
        status: 'ok',
        identidade: {
          id: req.identidade.id,
          email: req.identidade.email,
          ...preferencias,
          ultimoAcessoEm: ultimoAcessoEm === null ? null : ultimoAcessoEm.toISOString(),
          trocaSenhaObrigatoria: conta !== null && conta.senhaProvisoria === true,
        },
        empresas,
        contexto: contexto === null ? null : {
          usuario: { ...contexto.usuario, ativo: operacional === null ? null : operacional.ativo, funcionario },
          empresa: contexto.empresa,
        },
      });
    },

    /** Seleciona ou troca de empresa: a sessão empresarial anterior (se houver no cookie) é revogada na mesma transação. */
    async selecionarEmpresa(req, res) {
      const empresarialAnterior = await autenticacaoMiddleware.buscarContextoSessao(poolInjetado, req);
      const resultado = await contextoEmpresarialService.selecionar(poolInjetado, {
        identidadeId: req.identidade.id,
        sessaoGlobalId: req.sessaoGlobal.id,
        empresaId: req.validado.params.id,
        sessaoEmpresarialAnterior: anteriorParaSelecao(empresarialAnterior),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.append('Set-Cookie', serializarCookieSessao(resultado.token));
      res.status(200).json({ status: 'ok', usuario: resultado.usuario, empresa: resultado.empresa });
    },

    /**
     * "Sair completamente". Idempotente, mesma disciplina de
     * auth.controller.logout: cookies ausentes/inválidos não são erro. Não
     * fica atrás de exigirSessaoGlobal. Remove os DOIS cookies.
     */
    async logout(req, res) {
      const [global, empresarial] = await Promise.all([
        autenticacaoGlobalMiddleware.buscarContextoSessaoGlobal(poolInjetado, req),
        autenticacaoMiddleware.buscarContextoSessao(poolInjetado, req),
      ]);

      if (global !== null) {
        await contextoEmpresarialService.encerrarTudo(poolInjetado, {
          sessaoGlobalId: global.sessao.id,
          sessaoEmpresarialAtual: anteriorEmpresarial(empresarial),
        });
      } else if (empresarial !== null) {
        await sessaoRepo.revogar(poolInjetado, empresarial.empresa.id, empresarial.sessao.id, 'LOGOUT');
      }

      res.append('Set-Cookie', serializarRemocaoCookieSessaoGlobal());
      res.append('Set-Cookie', serializarRemocaoCookieSessao());
      res.status(200).json({ status: 'ok' });
    },
  };
}

const authGlobalController = criarAuthGlobalController({ pool });

module.exports = { criarAuthGlobalController, authGlobalController };
