'use strict';

const crypto = require('node:crypto');

/**
 * D-ORF-6, P7 (R2 seção 11): CONSISTÊNCIA CRUZADA banco × arquivos. Funções PURAS: sem disco, rede, banco ou processo.
 *
 * MODELO (11.3): ponto de recuperação ÚNICO = o snapshot do banco em T0; os arquivos exigidos são os referenciados em T0. `pontoDeRecuperacao` prova que todos
 * os planos de uma execução leram o MESMO `snapshotId` e que a identidade do banco é uma só (divergência = `PONTO_DE_RECUPERACAO_DIVERGENTE`).
 *
 * MATRIZ (11.2): `MATRIZ_DE_FALHAS` F1..F13 com efeito e tratamento; `classificarDivergencia(codigo)` liga cada divergência observada à falha da matriz.
 *
 * CONCILIAÇÃO POR FONTE (11.4 passo 4): `conciliarFonte({ referencias, arquivos, regraEmpresa })` confere (a) cada linha tem arquivo com hash e tamanho; (b) cada
 * arquivo tem linha; (c) M-ISO: o prefixo de empresa da chave é a `empresaId` da linha e nenhum arquivo é associado a mais de uma empresa; (d) contagens por
 * empresa. Resultado `INTEGRO` | `INCONSISTENTE` | `INCOMPLETO` (ausências sem outra divergência). Nenhuma divergência é tolerada em silêncio: todas
 * saem em `divergencias` (teto de 200, com `truncadas` quando excede).
 *
 * ORDEM (11.4): `criarOrdemDeRestauracao()` é uma máquina de estados que só aceita os passos na sequência 1→5 (destino novo, verificações 8.7, banco restaurado +
 * esquema, verificador por fonte, resultado) e nunca produz `recuperavelEmProducao`; `avaliarRestauracao` consolida os vereditos por fonte com o esquema (6.4).
 */

const MATRIZ_DE_FALHAS = Object.freeze([
  { id: 'F1', falha: 'Queda entre gravar arquivo e inserir linha', efeito: 'ARQUIVO_ORFAO', tratamento: 'LIMPEZA_DE_ORFAOS_COM_RETENCAO; o backup ignora' },
  { id: 'F2', falha: 'Linha sem arquivo', efeito: 'COPIA_FALHA_AO_LER', tratamento: 'BACKUP_FALHA_FECHADO' },
  { id: 'F3', falha: 'Remoção física concorrente com o backup', efeito: 'ARQUIVO_REFERENCIADO_DESAPARECE', tratamento: 'JANELA_CONS02' },
  { id: 'F4', falha: 'Substituição de conteúdo na mesma chave', efeito: 'CORROMPE_CONSISTENCIA', tratamento: 'RECUSADA_CHAVE_COM_CONTEUDO_DIFERENTE' },
  { id: 'F5', falha: 'Upload durante o backup', efeito: 'ARQUIVO_NOVO_APOS_T0', tratamento: 'EXTRA_SINALIZADO_NAO_COPIADO' },
  { id: 'F6', falha: 'Corrupção em repouso', efeito: 'SHA256_COPIADO_DIVERGE_DO_PLANO', tratamento: 'BACKUP_INVALIDO' },
  { id: 'F7', falha: 'Backup interrompido', efeito: 'PACOTE_PARCIAL', tratamento: 'PARCIAL_PRESERVADO_QUARENTENA' },
  { id: 'F8', falha: 'Publicação incerta', efeito: 'INCERTA', tratamento: 'QUARENTENA_DURAVEL' },
  { id: 'F9', falha: 'Restauração parcial', efeito: 'DESTINO_PARCIAL', tratamento: 'DESTINO_NOVO_NADA_APAGADO' },
  { id: 'F10', falha: 'Banco ok, arquivos divergentes', efeito: 'INCONSISTENCIA_LOGICA', tratamento: 'VERIFICADOR_POR_FONTE_REPROVA; recuperavel permanece falso' },
  { id: 'F11', falha: 'Prefixo de empresa na chave diferente da empresa_id da linha', efeito: 'MISTURA_ENTRE_EMPRESAS', tratamento: 'VERIFICADOR_REPROVA_M_ISO' },
  { id: 'F12', falha: 'Migrations à frente ou atrás do código', efeito: 'RESTAURACAO_INCOMPATIVEL', tratamento: 'IMPRESSAO_DO_ESQUEMA_6_4' },
  { id: 'F13', falha: 'Remoção do ZIP de pacote CONCLUIDO no catch externo', efeito: 'LINHA_CONCLUIDO_SEM_ARQUIVO', tratamento: 'ACH_FISC_01_CORRIGIDO_FONTE_PROTEGIDA' },
].map(Object.freeze));

/** Divergência observada -> falha da matriz. */
const DIVERGENCIA_PARA_FALHA = Object.freeze({
  ARQUIVO_AUSENTE: 'F2', ARQUIVO_EXTRA: 'F5', SHA256_DIVERGENTE: 'F10', TAMANHO_DIVERGENTE: 'F10', EMPRESA_DIVERGENTE: 'F11', CHAVE_DUPLICADA: 'F4',
  ESQUEMA_A_FRENTE_DO_CODIGO: 'F12', ESQUEMA_DIVERGENTE: 'F12', ARQUIVO_ORFAO: 'F1',
});
const CLASSES = Object.freeze(['INTEGRO', 'INCONSISTENTE', 'INCOMPLETO']);
const REGRAS_DE_EMPRESA = Object.freeze(['SEGMENTO_INICIAL_DA_CHAVE', 'COLUNA_EMPRESA_ID', null]);
const TETO = 200;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/;
const ID_DECIMAL = /^[1-9][0-9]{0,14}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalido(motivo) {
  const e = new TypeError('entrada de consistência inválida');
  e.code = 'ENTRADA_INVALIDA';
  e.motivo = motivo;
  return e;
}
const classificarDivergencia = (codigo) => (Object.hasOwn(DIVERGENCIA_PARA_FALHA, codigo) ? DIVERGENCIA_PARA_FALHA[codigo] : null);

function validarItem(item, comEmpresa) {
  if (!ehObjeto(item) || typeof item.chave !== 'string' || item.chave === '' || item.chave.length > 1024 || !SHA256.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) return false;
  if (comEmpresa && !(item.empresaId === null || (typeof item.empresaId === 'string' && ID_DECIMAL.test(item.empresaId)))) return false;
  return true;
}
const empresaDaChave = (chave) => { const seg = chave.split('/')[0]; return ID_DECIMAL.test(seg) ? seg : null; };

function conciliarFonte(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['referencias', 'arquivos', 'regraEmpresa'].includes(k))) throw invalido('ENTRADA');
  const { referencias, arquivos } = entrada;
  const regraEmpresa = entrada.regraEmpresa === undefined ? null : entrada.regraEmpresa;
  if (!Array.isArray(referencias) || !Array.isArray(arquivos) || !REGRAS_DE_EMPRESA.includes(regraEmpresa)) throw invalido('ENTRADA');
  if (!referencias.every((r) => validarItem(r, true)) || !arquivos.every((a) => validarItem(a, false))) throw invalido('ITEM');

  const divergencias = [];
  let truncadas = 0;
  const anotar = (chave, codigo) => { if (divergencias.length < TETO) divergencias.push(Object.freeze({ chave, codigo, falha: classificarDivergencia(codigo) })); else truncadas += 1; };

  const porChave = new Map();
  const empresasPorChave = new Map();
  for (const r of referencias) {
    if (porChave.has(r.chave)) { anotar(r.chave, 'CHAVE_DUPLICADA'); continue; }
    porChave.set(r.chave, r);
    // M-ISO (c): a empresa do prefixo e a da linha precisam coincidir; nenhum arquivo é de mais de uma empresa.
    if (regraEmpresa === 'SEGMENTO_INICIAL_DA_CHAVE') {
      const prefixo = empresaDaChave(r.chave);
      if (prefixo !== r.empresaId) anotar(r.chave, 'EMPRESA_DIVERGENTE');
    }
    const conjunto = empresasPorChave.get(r.chave) ?? new Set();
    conjunto.add(r.empresaId);
    empresasPorChave.set(r.chave, conjunto);
  }
  const vistos = new Set();
  let ausentes = 0;
  const contagens = {};
  for (const a of arquivos) {
    if (vistos.has(a.chave)) { anotar(a.chave, 'CHAVE_DUPLICADA'); continue; }
    vistos.add(a.chave);
    const r = porChave.get(a.chave);
    if (r === undefined) { anotar(a.chave, 'ARQUIVO_EXTRA'); continue; }
    if (r.sha256 !== a.sha256) anotar(a.chave, 'SHA256_DIVERGENTE');
    else if (r.bytes !== a.bytes) anotar(a.chave, 'TAMANHO_DIVERGENTE');
  }
  for (const r of porChave.values()) {
    const empresa = r.empresaId ?? 'GLOBAL';
    contagens[empresa] = contagens[empresa] ?? { referencias: 0, arquivos: 0 };
    contagens[empresa].referencias += 1;
    if (vistos.has(r.chave)) contagens[empresa].arquivos += 1; else { ausentes += 1; anotar(r.chave, 'ARQUIVO_AUSENTE'); }
  }
  const outras = divergencias.some((d) => d.codigo !== 'ARQUIVO_AUSENTE') || truncadas > 0;
  const classe = divergencias.length === 0 && truncadas === 0 ? 'INTEGRO' : (outras ? 'INCONSISTENTE' : 'INCOMPLETO');
  const contagensOrdenadas = Object.fromEntries(Object.entries(contagens).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Object.freeze(v)]));
  return Object.freeze({
    classe, referencias: porChave.size, arquivos: vistos.size, ausentes, divergencias: Object.freeze(divergencias), truncadas, contagensPorEmpresa: Object.freeze(contagensOrdenadas),
    sha256: crypto.createHash('sha256').update(JSON.stringify([...porChave.values()].map((r) => [r.chave, r.sha256, r.bytes, r.empresaId]))).digest('hex'),
  });
}

/** Todos os planos/leituras da execução vêm do mesmo snapshot e do mesmo banco; senão o ponto de recuperação não é único. */
function pontoDeRecuperacao(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => k === 'snapshotId' || k === 'banco' || k === 'leituras')) throw invalido('ENTRADA');
  const { snapshotId, banco, leituras } = entrada;
  if (typeof snapshotId !== 'string' || !SNAPSHOT.test(snapshotId) || !ehObjeto(banco) || typeof banco.nome !== 'string' || typeof banco.oid !== 'string') throw invalido('ENTRADA');
  if (!Array.isArray(leituras) || leituras.length === 0) throw invalido('ENTRADA');
  const divergentes = [];
  for (const l of leituras) {
    if (!ehObjeto(l) || typeof l.fonteId !== 'string') throw invalido('LEITURA');
    if (l.snapshotId !== snapshotId || !ehObjeto(l.banco) || l.banco.nome !== banco.nome || l.banco.oid !== banco.oid) divergentes.push(l.fonteId);
  }
  return Object.freeze({ unico: divergentes.length === 0, snapshotId, fontes: Object.freeze(leituras.map((l) => l.fonteId).sort()), divergentes: Object.freeze(divergentes.sort()), motivo: divergentes.length === 0 ? null : 'PONTO_DE_RECUPERACAO_DIVERGENTE' });
}

const PASSOS = Object.freeze(['DESTINO_NOVO', 'VERIFICACOES_8_7', 'BANCO_E_ESQUEMA', 'VERIFICADOR_POR_FONTE', 'RESULTADO']);

/** Máquina de estados da ordem obrigatória (11.4). Passo fora de ordem, repetido ou depois de falha é recusado; nunca promove `recuperavelEmProducao`. */
function criarOrdemDeRestauracao() {
  const concluidos = [];
  let falhou = null;
  function registrar(passo, resultado) {
    if (!PASSOS.includes(passo)) throw invalido('PASSO');
    if (falhou !== null) return Object.freeze({ aceito: false, motivo: 'RESTAURACAO_JA_FALHOU', passo });
    const esperado = PASSOS[concluidos.length];
    if (passo !== esperado) return Object.freeze({ aceito: false, motivo: 'PASSO_FORA_DE_ORDEM', passo, esperado });
    if (!ehObjeto(resultado) || typeof resultado.ok !== 'boolean') throw invalido('RESULTADO');
    if (!resultado.ok) { falhou = passo; return Object.freeze({ aceito: true, motivo: 'PASSO_FALHOU', passo }); }
    concluidos.push(passo);
    return Object.freeze({ aceito: true, motivo: null, passo });
  }
  const situacao = () => Object.freeze({ concluidos: Object.freeze([...concluidos]), proximo: falhou !== null ? null : (PASSOS[concluidos.length] ?? null), falhou, completa: falhou === null && concluidos.length === PASSOS.length, recuperavelEmProducao: false });
  return Object.freeze({ registrar, situacao, PASSOS });
}

/** Consolida vereditos por fonte com o esquema: INTEGRO só se tudo íntegro e esquema IGUAL; qualquer INCONSISTENTE domina; nunca recuperável. */
function avaliarRestauracao(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => k === 'fontes' || k === 'esquema' || k === 'ordem')) throw invalido('ENTRADA');
  const { fontes, esquema, ordem } = entrada;
  if (!ehObjeto(fontes) || !ehObjeto(esquema) || typeof esquema.relacao !== 'string' || !ehObjeto(ordem) || typeof ordem.completa !== 'boolean') throw invalido('ENTRADA');
  const motivos = [];
  let classe = 'INTEGRO';
  for (const [id, r] of Object.entries(fontes).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!ehObjeto(r) || !CLASSES.includes(r.classe)) throw invalido('FONTE');
    if (r.classe === 'INCONSISTENTE') { classe = 'INCONSISTENTE'; motivos.push(`FONTE_INCONSISTENTE:${id}`); } else if (r.classe === 'INCOMPLETO') { if (classe !== 'INCONSISTENTE') classe = 'INCOMPLETO'; motivos.push(`FONTE_INCOMPLETA:${id}`); }
  }
  if (esquema.relacao !== 'IGUAL') { classe = 'INCONSISTENTE'; motivos.push(`ESQUEMA_${esquema.relacao}`); }
  if (!ordem.completa) { if (classe === 'INTEGRO') classe = 'INCOMPLETO'; motivos.push('ORDEM_NAO_CONCLUIDA'); }
  return Object.freeze({ classe, motivos: Object.freeze(motivos.sort()), recuperavelEmProducao: false, restauracaoReal: false });
}

module.exports = { MATRIZ_DE_FALHAS, DIVERGENCIA_PARA_FALHA, CLASSES, PASSOS, classificarDivergencia, conciliarFonte, pontoDeRecuperacao, criarOrdemDeRestauracao, avaliarRestauracao };
