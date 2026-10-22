'use strict';

const { z } = require('zod');

/**
 * Schema da rota do dashboard (Bloco 9, Etapa C, Parte C6): consulta sem
 * parâmetros — empresa e usuário vêm só da sessão; qualquer parâmetro de
 * consulta é recusado (strictObject).
 */

const indicadores = { query: z.strictObject({}) };

// 12I — gráficos: só o período (MES | SEIS_MESES | ANO, padrão MES); datas, empresa ou qualquer outro parâmetro são recusados.
const { PERIODOS } = require('../services/dashboard-graficos.service');
const graficos = { query: z.strictObject({ periodo: z.enum(PERIODOS).default('MES') }) };

module.exports = { indicadores, graficos };
