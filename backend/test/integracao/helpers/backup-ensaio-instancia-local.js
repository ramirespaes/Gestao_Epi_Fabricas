'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { criarProdutorDeRelatorio } = require('../../../src/services/imagem-backup-publicacao.service');
const { criarJanelaDeBackup } = require('../../../src/services/imagem-backup.service');

/**
 * Helper da C-1 (B-1 → pacote L2 → cifra P11 → recuperação P12): guarda de ambiente da instância efêmera local, nomes de banco controlados, comandos do modelo SQL do papel mínimo e
 * configurações da composição de produção. Só funções puras: NÃO lê o ambiente global (recebe `env`), NÃO abre conexão, NÃO cria processo, NÃO escreve em disco e NÃO conhece fonte de chaves
 * de produção (as fontes chegam prontas, por parâmetro). Cada suíte continua dona do seu cleanup, dos seus testes negativos e do seu opt-in `SWB_*`.
 */

const PAPEL_B1 = 'safework_backup_executor';
const BANCO_DE_TESTE = 'gestao_epi_teste_local';
const PORTAS_PROTEGIDAS = Object.freeze([5432, 55460]);
const PADRAO_PGDATA = /^\/private\/tmp\/swb-[0-9]{14}-[0-9]{1,5}\/pgdata$/;
const BANCOS_BASE = Object.freeze([BANCO_DE_TESTE, 'postgres', 'template0', 'template1']);
const PROTEGIDOS = Object.freeze([...BANCOS_BASE, 'gestao_epi', 'homolog_local']);
const PREFIXOS = Object.freeze({ origem: 'gepi_c1_origem_', restaurado: 'gepi_c1_rest_' });
const NOME_CONTROLADO = /^gepi_c1_(?:origem|rest)_[0-9a-f]{12}$/;
const VARIAVEIS_DO_CLIENTE_PG = Object.freeze(['PGHOST', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGSSLMODE']);
const PRAZOS = Object.freeze({ totalMs: 180000, cortesiaMs: 5000, intervaloGrupoMs: 250, tentativasGrupo: 40, consultaGrupoMs: 2000 });
const MIB = 1024 * 1024;
const MARCADOR_DO_BANCO = 'DATABASE A_PREENCHER';
const GRANTS_B1 = Object.freeze([
  `GRANT USAGE ON SCHEMA public TO ${PAPEL_B1}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL_B1}`,
  `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PAPEL_B1}`,
]);
const VERIFICACAO_B1 = `SELECT c.relname, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm', 'S') AND NOT has_table_privilege('${PAPEL_B1}', c.oid, 'SELECT') ORDER BY c.relname`;

/** Primeiro motivo pelo qual o ambiente NÃO é a instância efêmera exclusiva autorizada para a C-1; `null` se tudo confere. */
function motivoDeRecusaDoAmbiente(env) {
  const pgdata = typeof env.SWB_PGDATA === 'string' ? env.SWB_PGDATA : '';
  const porta = Number(env.SWB_PORT);
  const regras = [
    [env.SWB_C1 !== '1', 'SWB_C1 diferente de 1'],
    [!PADRAO_PGDATA.test(pgdata), 'SWB_PGDATA fora do padrão /private/tmp/swb-<AAAAMMDDHHMMSS>-<n>/pgdata'],
    [!/^[0-9]{4,5}$/.test(String(env.SWB_PORT)), 'SWB_PORT ausente ou inválida'],
    [porta < 1024 || porta > 65535 || PORTAS_PROTEGIDAS.includes(porta), 'porta protegida ou fora da faixa'],
    [env.DB_PORT !== env.SWB_PORT, 'DB_PORT difere de SWB_PORT'],
    [env.DB_HOST !== `${path.dirname(pgdata)}/sock`, 'DB_HOST não é o socket da instância'],
    [env.DB_USER !== 'swb_teste', 'DB_USER diferente de swb_teste'],
    [env.DB_NAME !== BANCO_DE_TESTE, 'DB_NAME diferente do banco de teste'],
    [env.NODE_ENV !== 'test', 'NODE_ENV diferente de test'],
    ...VARIAVEIS_DO_CLIENTE_PG.map((v) => [env[v] !== undefined, `${v} definida`]),
  ];
  const violada = regras.find(([desvio]) => desvio);
  return violada === undefined ? null : violada[1];
}

const nomeDeBancoValido = (nome) => typeof nome === 'string' && NOME_CONTROLADO.test(nome) && !PROTEGIDOS.includes(nome);

function novoNomeDeBanco(tipo) {
  if (typeof tipo !== 'string' || !Object.hasOwn(PREFIXOS, tipo)) throw new TypeError('tipo de banco desconhecido');
  return `${PREFIXOS[tipo]}${crypto.randomBytes(6).toString('hex')}`;
}

/** Comandos do modelo SQL do papel (um por posição, sem comentários nem `;`), com o marcador trocado pelo banco de origem controlado. O modelo em si nunca é alterado. */
function comandosDoModelo(texto, banco) {
  if (!nomeDeBancoValido(banco)) throw new TypeError('nome de banco fora do padrão controlado');
  if (typeof texto !== 'string' || !texto.includes(MARCADOR_DO_BANCO)) throw new TypeError('marcador do banco ausente no modelo');
  return texto.split('\n').filter((linha) => !/^\s*--/.test(linha)).join('\n').split(';')
    .map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '')
    .map((c) => c.replace(MARCADOR_DO_BANCO, `DATABASE ${banco}`));
}

/** Configuração de `criarBackupDeProducao`: pg_dump e conexão pelo PAPEL B-1, layout 2, só a fonte `imagens`, chaves e relatório de TESTE_CONTROLADO. */
function montarConfigDoBackup(c) {
  const postgres = { pgDump: c.binarios.dump, pgRestore: c.binarios.restore, host: c.host, porta: c.porta, usuario: PAPEL_B1, arquivoDeSenha: c.arquivoDeSenha, banco: { nome: c.nomeOrigem, oid: c.oidOrigem } };
  const { imagens, preparacoes, dumps, publicados } = c.dirs;
  const relatorio = { produtor: criarProdutorDeRelatorio({ origem: 'TESTE_CONTROLADO', decidir: () => ({ ok: true }) }), origensAceitas: ['TESTE_CONTROLADO'] };
  return {
    postgres,
    conexao: { criarConexao: c.criarConexao, finalizacaoMs: 30000 },
    armazenamento: { imagens, preparacoes, dumps, publicados },
    chaves: { fonteDeChaves: c.fonteDeChaves, chaveId: c.chaveId },
    relatorio,
    prazos: { ...PRAZOS },
    maxBytesPorArquivo: MIB,
    janela: criarJanelaDeBackup({ arquivo: path.join(c.area, 'janela-c1.lock'), raizArmazenamento: imagens }),
    limites: { totalBytes: 512 * MIB, maxBytesDoDump: 256 * MIB, bytesLivresMinimos: 1024 * MIB },
    layoutDoManifesto: 2,
    fontes: ['imagens'],
  };
}

/** Configuração de `criarRestauracaoDeProducao`: destino só com o prefixo da C-1, no host do socket da instância, bancos protegidos recusados. */
function montarConfigDaRestauracao(c) {
  return {
    postgres: { pgRestore: c.binarios.restore },
    politicaDeDestino: { prefixoDoBanco: PREFIXOS.restaurado, hostsAutorizados: [c.host], bancosProtegidos: [...PROTEGIDOS] },
    fonteDeChaves: c.fonteDeChaves,
    criarConexaoDoBanco: c.criarConexaoDoBanco,
    prazos: { ...PRAZOS },
  };
}

/** Pedido de `restaurar`: o pacote é `<raizDecifrada>/<nomeDoPacote>` (a saída da decifra), o banco é o NOVO e as imagens vão para um diretório novo. */
function pedidoDeRestauracao(c, nomeDasImagens) {
  const { host, porta, usuario, arquivoDeSenha } = c;
  return {
    raizAutorizada: c.raizDecifrada, nome: c.nomeDoPacote, imagens: { raiz: c.dirs.restauradoImagens, nome: nomeDasImagens },
    destino: { banco: c.nomeRestaurado, host, porta, usuario, arquivoDeSenha }, layoutMinimo: 2, maxBytesPorArquivo: MIB,
  };
}

module.exports = {
  PAPEL_B1, BANCOS_BASE, PROTEGIDOS, PORTAS_PROTEGIDAS, GRANTS_B1, VERIFICACAO_B1, MIB, PRAZOS,
  motivoDeRecusaDoAmbiente, nomeDeBancoValido, novoNomeDeBanco, comandosDoModelo, montarConfigDoBackup, montarConfigDaRestauracao, pedidoDeRestauracao,
};
