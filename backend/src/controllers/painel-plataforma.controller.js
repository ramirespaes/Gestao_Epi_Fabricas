'use strict';

/**
 * Área administrativa protegida do Painel Privado — versão inicial
 * (Autenticação Global — Pacote 2, item 4: "acessar uma área
 * administrativa protegida"). Deliberadamente mínima: só confirma que a
 * sessão de plataforma chegou até aqui (atrás de exigirSessaoPlataforma) e
 * devolve o administrador identificado. Nenhuma listagem de empresas,
 * convite de MASTER ou cadastro — fora de escopo deste pacote.
 */
function criarPainelPlataformaController() {
  return {
    async resumo(req, res) {
      res.status(200).json({
        status: 'ok',
        administrador: req.administradorPlataforma,
      });
    },
  };
}

const painelPlataformaController = criarPainelPlataformaController();

module.exports = { criarPainelPlataformaController, painelPlataformaController };
