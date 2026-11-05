'use strict';

const { ehFonteDeChaves, PROVEDORES_OPERACIONAIS_APROVADOS } = require('./imagem-backup-manifesto-autenticado.service');
const { ehFonteDeCifra, PROVEDORES_DE_CIFRA_APROVADOS } = require('./backup-fontes-cifra-envelope.service');
const { ARMAZENAMENTOS_DURAVEIS_APROVADOS, localizarArmazenamentoDuravel } = require('./imagem-backup-durabilidade.service');
const { DESTINOS_AUTORIZADOS } = require('./imagem-backup-destinos.service');

/**
 * D-ORF-6, P11 (R2 §13.3 RC-1..RC-10; D-F4, D-F5, D-F6): POLÍTICA DE CUSTÓDIA E PRONTIDÃO CRIPTOGRÁFICA — avaliação PURA, declarativa e falha fechada.
 * Nada aqui guarda, copia, recupera ou inventa chaves: o módulo só confere, requisito a requisito, o que o responsável DECLAROU e o que o código PROVA
 * (listas de provedores/destinos aprovadas, separação de fontes), e devolve pendências com códigos fixos. Enquanto houver pendência, `dadosReaisPermitidos`
 * é falso (R2 §13.4). As decisões D-F4/D-F5/D-F6/D-F7 continuam de Ramires; este módulo torna visível o que falta para cada uma.
 *
 * `avaliarProntidaoCriptografica({ cifra: { fonte, chaveId }, mac: { fonte, chaveId }, custodia, retencao, transporte })`:
 *  - RC-4: fontes de famílias distintas, ids distintos (verificado pelo módulo de cifra na operação; aqui só a forma);
 *  - RC-1: `custodia.temporariosProtegidos` ∈ { DISCO_CIFRADO, CIFRADO_EM_USO } declarado pelo responsável (o host não é inspecionado aqui);
 *  - RC-2: só contêineres cifrados vão a destino durável; destino durável aprovado (lista hoje vazia);
 *  - RC-3: `transporte.tlsVerifyFull === true` (D-F7);
 *  - RC-5/RC-6: `custodia.copias` (≥ 2, locais distintos, nenhum no host de backup), `custodia.ultimoEnsaioDeRecuperacaoEm` (data) dentro de `custodia.periodicidadeDias`;
 *  - RC-9/RC-10: `custodia.escopoDaChave` ∈ { GLOBAL, POR_EMPRESA } declarado; `custodia.disponivelEmDesastre === true`;
 *  - D-F6: `retencao.politica` ∈ { ROTATIVA, ELIMINACAO_CRIPTOGRAFICA, REPLAY, BASE_LEGAL } e `retencao.aprovadaPeloDpo === true`.
 * `autorizarEnvioDuravel({ containerCifrado, destinoId, ambiente })`: só contêiner cifrado (ok:true de `cifrarPacote`) e destino na lista aprovada; hoje sempre recusado.
 */

const TEMPORARIOS = Object.freeze(['DISCO_CIFRADO', 'CIFRADO_EM_USO']);
const ESCOPOS = Object.freeze(['GLOBAL', 'POR_EMPRESA']);
const POLITICAS_DE_RETENCAO = Object.freeze(['ROTATIVA', 'ELIMINACAO_CRIPTOGRAFICA', 'REPLAY', 'BASE_LEGAL']);
const REQUISITOS = Object.freeze(['RC-1', 'RC-2', 'RC-3', 'RC-4', 'RC-5', 'RC-6', 'RC-7', 'RC-8', 'RC-9', 'RC-10', 'D-F4', 'D-F5', 'D-F6', 'D-F7']);
const DIA_MS = 24 * 60 * 60 * 1000;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dataValida = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
function entradaInvalida(motivo) { const e = new TypeError('entrada de custódia inválida'); e.code = 'ENTRADA_INVALIDA'; e.motivo = motivo; return e; }

function avaliarProntidaoCriptografica(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['cifra', 'mac', 'custodia', 'retencao', 'transporte', 'agora'].includes(k))) throw entradaInvalida('ENTRADA');
  const { cifra, mac, custodia, retencao, transporte } = entrada;
  const agora = entrada.agora === undefined ? new Date() : entrada.agora;
  if (!(agora instanceof Date) || Number.isNaN(agora.getTime())) throw entradaInvalida('AGORA');
  const pendencias = [];
  const falta = (req, codigo) => pendencias.push(Object.freeze({ requisito: req, codigo }));

  // RC-4 / D-F5: fontes e ids
  const cifraOk = ehObjeto(cifra) && ehFonteDeCifra(cifra.fonte) && typeof cifra.chaveId === 'string';
  const macOk = ehObjeto(mac) && ehFonteDeChaves(mac.fonte) && typeof mac.chaveId === 'string';
  if (!cifraOk) falta('RC-4', 'FONTE_DE_CIFRA_AUSENTE');
  if (!macOk) falta('RC-4', 'FONTE_DE_MAC_AUSENTE');
  if (cifraOk && macOk && (cifra.fonte === mac.fonte || cifra.chaveId === mac.chaveId)) falta('RC-4', 'CHAVES_NAO_SEPARADAS');
  if (cifraOk && cifra.fonte.origem !== 'OPERACIONAL') falta('D-F5', 'FONTE_DE_CIFRA_NAO_OPERACIONAL');
  if (macOk && mac.fonte.origem !== 'OPERACIONAL') falta('D-F5', 'FONTE_DE_MAC_NAO_OPERACIONAL');
  if (PROVEDORES_OPERACIONAIS_APROVADOS.length === 0) falta('D-F5', 'PROVEDOR_DE_MAC_NAO_APROVADO');
  if (PROVEDORES_DE_CIFRA_APROVADOS.length === 0) falta('D-F5', 'PROVEDOR_DE_CIFRA_NAO_APROVADO');
  // RC-1, RC-5, RC-6, RC-9, RC-10: custódia declarada
  const c = ehObjeto(custodia) ? custodia : {};
  if (!TEMPORARIOS.includes(c.temporariosProtegidos)) falta('RC-1', 'TEMPORARIOS_NAO_PROTEGIDOS');
  const copias = Array.isArray(c.copias) ? c.copias : [];
  const locais = new Set(copias.filter((x) => ehObjeto(x) && typeof x.local === 'string' && x.local !== '').map((x) => x.local));
  if (locais.size < 2) falta('RC-6', 'COPIAS_INSUFICIENTES');
  if (copias.some((x) => ehObjeto(x) && x.noHostDeBackup === true)) falta('RC-6', 'COPIA_NO_HOST_DE_BACKUP');
  if (!Number.isSafeInteger(c.periodicidadeDias) || c.periodicidadeDias <= 0) falta('RC-5', 'PERIODICIDADE_NAO_DEFINIDA');
  else if (!dataValida(c.ultimoEnsaioDeRecuperacaoEm)) falta('RC-6', 'ENSAIO_DE_RECUPERACAO_AUSENTE');
  else if (agora.getTime() - Date.parse(c.ultimoEnsaioDeRecuperacaoEm) > c.periodicidadeDias * DIA_MS) falta('RC-6', 'ENSAIO_DE_RECUPERACAO_VENCIDO');
  if (!ESCOPOS.includes(c.escopoDaChave)) falta('RC-9', 'ESCOPO_DA_CHAVE_NAO_DEFINIDO');
  if (c.disponivelEmDesastre !== true) falta('RC-10', 'CUSTODIA_INDISPONIVEL_EM_DESASTRE');
  if (c.rotacaoEnsaiada !== true) falta('RC-5', 'ROTACAO_NAO_ENSAIADA');
  // RC-2 / D-F4: destino durável e cifra do pacote
  if (ARMAZENAMENTOS_DURAVEIS_APROVADOS.length === 0) falta('RC-2', 'DESTINO_DURAVEL_NAO_APROVADO');
  if (DESTINOS_AUTORIZADOS.HOMOLOGACAO.length === 0 && DESTINOS_AUTORIZADOS.PRODUCAO.length === 0) falta('RC-2', 'DESTINO_LOCAL_NAO_AUTORIZADO');
  if (c.cifraNoPacote !== true) falta('D-F4', 'CIFRA_NO_PACOTE_NAO_ADOTADA');
  // RC-3 / D-F7
  if (!ehObjeto(transporte) || transporte.tlsVerifyFull !== true) falta('RC-3', 'TRANSPORTE_SEM_TLS_VERIFY_FULL');
  // RC-7, RC-8: propriedades do módulo de cifra (encrypt-then-MAC; caminhos visíveis = decisão)
  if (c.metadadosVisiveisAceitos !== true) falta('RC-8', 'METADADOS_VISIVEIS_NAO_DECIDIDOS');
  // D-F6
  const r = ehObjeto(retencao) ? retencao : {};
  if (!POLITICAS_DE_RETENCAO.includes(r.politica)) falta('D-F6', 'POLITICA_DE_RETENCAO_NAO_DEFINIDA');
  if (r.aprovadaPeloDpo !== true) falta('D-F6', 'RETENCAO_SEM_DPO');

  const porRequisito = Object.fromEntries(REQUISITOS.map((q) => [q, pendencias.filter((p) => p.requisito === q).map((p) => p.codigo)]));
  return Object.freeze({ dadosReaisPermitidos: pendencias.length === 0, pendencias: Object.freeze(pendencias), porRequisito: Object.freeze(porRequisito), atendidos: Object.freeze(REQUISITOS.filter((q) => porRequisito[q].length === 0)) });
}

function autorizarEnvioDuravel(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['containerCifrado', 'destinoId', 'ambiente', 'registro'].includes(k))) throw entradaInvalida('ENTRADA');
  const { containerCifrado, destinoId, ambiente, registro } = entrada;
  if (!ehObjeto(containerCifrado) || containerCifrado.ok !== true || typeof containerCifrado.sha256Envelope !== 'string') return Object.freeze({ autorizado: false, motivo: 'CONTAINER_NAO_CIFRADO' });
  if (ambiente !== 'HOMOLOGACAO' && ambiente !== 'PRODUCAO') return Object.freeze({ autorizado: false, motivo: 'AMBIENTE_INVALIDO' });
  const achado = localizarArmazenamentoDuravel(destinoId, ambiente, registro);
  if (!achado.encontrada) return Object.freeze({ autorizado: false, motivo: achado.motivo });
  return Object.freeze({ autorizado: true, destinoId, ambiente, origem: achado.origem });
}

module.exports = { avaliarProntidaoCriptografica, autorizarEnvioDuravel, REQUISITOS, TEMPORARIOS, ESCOPOS, POLITICAS_DE_RETENCAO };
