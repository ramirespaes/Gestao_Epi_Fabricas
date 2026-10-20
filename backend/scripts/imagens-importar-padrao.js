'use strict';

const servico = require('../src/services/imagem-padrao-importacao.service');
const { nomeSeguro } = require('../src/utils/pacote-padrao-erros');

/**
 * Script administrativo: importa OFFLINE a biblioteca padrão de imagens (as 30 imagens do pacote aprovado) para o armazenamento e o PostgreSQL.
 * Biblioteca de Imagens, Unidades 5A-2 e 5A-3 (`--quantidade <n>` aceita um pacote menor que 30, como o da 31ª imagem).
 *
 *   node --require dotenv/config scripts/imagens-importar-padrao.js --pacote <zip absoluto> --sha256 <hash aprovado do ZIP> [--quantidade <n>] [--mapeamento <csv absoluto>] [--banco-autorizado <nome> --banco-oid <oid>] [--verificar | --dry-run | --executar]
 *
 * Mesma família de scripts/provisionar-permissoes-master.js: Node autônomo, executado deliberadamente por um operador, credenciais só pelo ambiente.
 *
 * SEGURO POR PADRÃO: sem `--executar` nada é gravado. `--verificar` só confere o pacote e NUNCA conecta ao banco nem toca o armazenamento; `--dry-run`
 * (o padrão) confere o pacote, lê o estado e relata o que seria feito; `--executar` grava. O `--sha256` é o hash aprovado do ZIP, vindo de FORA do
 * pacote, e é obrigatório em todos os modos. Os modos são mutuamente exclusivos; `--mapeamento` não se aplica a `--verificar`.
 *
 * DESTINO: `--executar` exige `--banco-autorizado <nome>` e `--banco-oid <oid>`, vindos da autorização escrita (nunca do ambiente). O serviço confere os dois na própria
 * conexão que vai gravar, antes de qualquer trava, leitura de estado ou arquivo; sem eles, ou se divergirem, a saída é DESTINO_NAO_AUTORIZADO (2) e nada é alterado.
 * No `--dry-run` são opcionais (e, se vierem, conferidos); `--verificar` nunca acessa o PostgreSQL e os recusa. O diretório de imagens só é criado depois da conferência.
 *
 * Códigos de saída: OK=0, ERRO=1, ARGUMENTOS=2 (inclui mapeamento inválido ou ausente), INTEGRIDADE=3 (o pacote não foi comprovado),
 * DIVERGENCIA=4 (o banco ou o armazenamento já têm outra coisa; nada foi alterado). A saída nunca leva caminho, segredo ou caractere de controle do pacote.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  INTEGRIDADE: 3,
  DIVERGENCIA: 4,
});

const SHA256 = /^[0-9a-f]{64}$/;
const QUANTIDADE = /^(?:[1-9]|[12][0-9]|30)$/;
const MODOS = Object.freeze({ '--verificar': 'VERIFICAR', '--dry-run': 'SIMULAR', '--executar': 'EXECUTAR' });
const COM_VALOR = Object.freeze({ '--pacote': 'pacote', '--sha256': 'sha256', '--quantidade': 'quantidade', '--mapeamento': 'mapeamento', '--banco-autorizado': 'banco', '--banco-oid': 'oid' });
const MAX_DETALHES_IMPRESSOS = 40;

function caminhoAbsoluto(valor) {
  return valor.length <= 4096 && !valor.includes('\0') && valor.startsWith('/');
}

/**
 * Interpreta argv (já sem `node` e o caminho do script). Puro, sem I/O; o erro nunca ecoa o valor recebido.
 * @returns {{ok: true, pacote: string, sha256: string, mapeamento: string|null, modo: 'VERIFICAR'|'SIMULAR'|'EXECUTAR', quantidade?: number, destino?: {banco: string|null, oid: string|null}}|{ok: false, erro: string}}
 *   `destino` só existe quando algum dos dois argumentos foi informado; o outro vem nulo e quem recusa é o serviço (DESTINO_NAO_AUTORIZADO).
 *   `quantidade` só existe quando `--quantidade` foi informado (inteiro de 1 a 30); sem ele vale o pacote completo de 30.
 */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  const valores = { pacote: null, sha256: null, quantidade: null, mapeamento: null, banco: null, oid: null };
  const modos = [];
  for (let i = 0; i < argumentos.length; i += 1) {
    const argumento = argumentos[i];
    if (Object.hasOwn(COM_VALOR, argumento)) {
      const campo = COM_VALOR[argumento];
      const valor = argumentos[i + 1];
      if (typeof valor !== 'string' || valor.startsWith('--')) return { ok: false, erro: `${argumento} exige um valor` };
      if (valores[campo] !== null) return { ok: false, erro: `${argumento} informado mais de uma vez` };
      valores[campo] = valor;
      i += 1;
    } else if (Object.hasOwn(MODOS, argumento)) {
      if (modos.includes(MODOS[argumento])) return { ok: false, erro: `${argumento} informado mais de uma vez` };
      modos.push(MODOS[argumento]);
    } else {
      return { ok: false, erro: 'argumento desconhecido' };
    }
  }
  if (valores.pacote === null) return { ok: false, erro: '--pacote <caminho absoluto do ZIP> é obrigatório' };
  if (valores.sha256 === null) return { ok: false, erro: '--sha256 <hash aprovado do ZIP> é obrigatório' };
  if (!caminhoAbsoluto(valores.pacote)) return { ok: false, erro: '--pacote deve ser um caminho absoluto' };
  if (!SHA256.test(valores.sha256)) return { ok: false, erro: '--sha256 deve ter 64 caracteres hexadecimais minúsculos' };
  if (valores.quantidade !== null && !QUANTIDADE.test(valores.quantidade)) return { ok: false, erro: '--quantidade deve ser um inteiro de 1 a 30' };
  if (valores.mapeamento !== null && !caminhoAbsoluto(valores.mapeamento)) return { ok: false, erro: '--mapeamento deve ser um caminho absoluto' };
  if (modos.length > 1) return { ok: false, erro: '--verificar, --dry-run e --executar são mutuamente exclusivos' };
  const modo = modos[0] ?? 'SIMULAR';
  if (modo === 'VERIFICAR' && valores.mapeamento !== null) return { ok: false, erro: '--mapeamento não se aplica a --verificar' };
  const comDestino = valores.banco !== null || valores.oid !== null;
  if (modo === 'VERIFICAR' && comDestino) return { ok: false, erro: '--banco-autorizado e --banco-oid não se aplicam a --verificar' };
  const destino = comDestino ? { destino: { banco: valores.banco, oid: valores.oid } } : {};
  const quantidade = valores.quantidade === null ? {} : { quantidade: Number(valores.quantidade) };
  return { ok: true, pacote: valores.pacote, sha256: valores.sha256, mapeamento: valores.mapeamento, modo, ...quantidade, ...destino };
}

function uso() {
  return [
    'Uso: node --require dotenv/config scripts/imagens-importar-padrao.js --pacote <zip absoluto> --sha256 <hash aprovado do ZIP> [--quantidade <n>] [--mapeamento <csv absoluto>] [--banco-autorizado <nome> --banco-oid <oid>] [--verificar | --dry-run | --executar]',
    '  --pacote       caminho absoluto do ZIP aprovado das imagens (só lido; nada é extraído)',
    '  --sha256       SHA-256 aprovado do ZIP, vindo de fora do pacote (obrigatório)',
    '  --quantidade   número de imagens do manifesto, de 1 a 30 (padrão 30); a 31ª imagem entra sozinha com --quantidade 1',
    '  --mapeamento   CSV da proposta; só as linhas APROVADAS viram sugestão de tipo, e só para imagens novas (opcional)',
    '  --banco-autorizado, --banco-oid   nome e OID do banco de destino, conferidos na conexão que grava antes de qualquer efeito; obrigatórios com --executar, opcionais no --dry-run',
    '  --verificar    só confere o pacote; nunca conecta ao banco nem toca o armazenamento',
    '  --dry-run      confere, lê o estado e relata o que seria feito, sem gravar; é o padrão',
    '  --executar     grava as imagens e as linhas que faltam; nunca altera o que já existe',
  ].join('\n');
}

function codigoDeSaida(codigo) {
  if (['PACOTE_ARGUMENTOS_INVALIDOS', 'MAPEAMENTO_INVALIDO', 'MAPEAMENTO_INDISPONIVEL', 'DESTINO_NAO_AUTORIZADO'].includes(codigo)) return SAIDAS.ARGUMENTOS;
  if (codigo === 'ESTADO_DIVERGENTE') return SAIDAS.DIVERGENCIA;
  if (codigo.startsWith('PACOTE_') || codigo === 'IMAGEM_PADRAO_INVALIDA') return SAIDAS.INTEGRIDADE;
  return SAIDAS.ERRO;
}

const resumirHash = (texto) => (/^[0-9a-f]{64}$/.test(texto) ? `${texto.slice(0, 12)}…` : texto);

/** Uma linha por detalhe, só com campos conhecidos e já imprimíveis; hash vira prefixo; nada de caractere de controle. */
function formatarDetalhe(detalhe) {
  const partes = [];
  for (const campo of ['entrada', 'nome', 'papel', 'alvo', 'linha', 'campo', 'motivo', 'detalhe', 'esperado', 'calculado']) {
    const valor = detalhe[campo];
    if (valor === undefined) continue;
    partes.push(`${campo}=${typeof valor === 'string' ? resumirHash(nomeSeguro(valor)) : String(valor)}`);
  }
  return partes.join(' ');
}

function imprimirRecusa(saida, erro) {
  saida.error(`Recusado (${erro.codigo}): ${erro.message}`);
  for (const detalhe of erro.detalhes.slice(0, MAX_DETALHES_IMPRESSOS)) saida.error(`  - ${formatarDetalhe(detalhe)}`);
  if (erro.detalhes.length > MAX_DETALHES_IMPRESSOS) saida.error(`  ... e mais ${erro.detalhes.length - MAX_DETALHES_IMPRESSOS} detalhes`);
  if (erro.codigo === 'DESTINO_NAO_AUTORIZADO') saida.error('  Informe o destino com --banco-autorizado <nome> e --banco-oid <oid>; os dois são conferidos na conexão que grava.');
}

function imprimirVerificacao(saida, resultado) {
  saida.log(`Pacote: ${nomeSeguro(resultado.pacote.nome)} (${resultado.pacote.bytes} bytes)`);
  saida.log('Modo: VERIFICAÇÃO (nada é lido do banco nem gravado)');
  saida.log('SHA-256 do pacote: confere com o hash aprovado');
  saida.log(`Arquivos conferidos: ${resultado.verificados} (SHA-256 e tamanho de cada um contra o manifesto)`);
  saida.log(`Imagens no pacote: ${resultado.manifesto.linhas}`);
}

function imprimirImportacao(saida, relatorio) {
  const { resumo } = relatorio;
  saida.log(`Pacote: ${nomeSeguro(relatorio.pacote.nome)} (${relatorio.pacote.bytes} bytes)`);
  saida.log(relatorio.modo === 'EXECUCAO' ? 'Modo: EXECUÇÃO (as imagens e as linhas que faltavam foram gravadas)' : 'Modo: SIMULAÇÃO (nada foi gravado)');
  if (relatorio.destino) saida.log(`Destino conferido pela conexão: banco ${nomeSeguro(relatorio.destino.banco)} (oid ${relatorio.destino.oid})`);
  saida.log(`Arquivos conferidos: ${relatorio.verificados}`);
  saida.log(`Imagens: total=${resumo.total} novas=${resumo.novas} existentes=${resumo.existentes}`);
  saida.log(`Arquivos de imagem: novos=${resumo.arquivosNovos} presentes=${resumo.arquivosPresentes}`);
  saida.log(`Sugestões de tipo novas: ${resumo.sugestoes}`);
  if (relatorio.modo === 'SIMULACAO') saida.log('Para gravar o que falta, repita com --executar.');
}

/**
 * Executa o comando com as dependências já prontas. Devolve o código de saída e o resultado, sem encerrar o pool (de quem chama). Em VERIFICAR,
 * `pool` e `armazenamento` não são usados. Erros que não são do serviço propagam.
 *
 * @param {{pacote: string, sha256: string, mapeamento: string|null, modo: 'VERIFICAR'|'SIMULAR'|'EXECUTAR', destino?: {banco: string|null, oid: string|null}, quantidade?: number}} opcoes
 *   `destino` segue para o serviço, que o exige para gravar; em VERIFICAR é ignorado (o parser o recusa). `quantidade` só segue quando informada.
 * @param {{pool?: import('pg').Pool, armazenamento?: object, saida?: {log: Function, error: Function}}} dependencias
 */
async function executarComando({ pacote, sha256, mapeamento, modo, destino, quantidade }, { pool, armazenamento, saida = console } = {}) {
  if (!['VERIFICAR', 'SIMULAR', 'EXECUTAR'].includes(modo)) throw new TypeError('modo inválido');
  const comQuantidade = quantidade === undefined ? {} : { quantidadeEsperada: quantidade };
  try {
    if (modo === 'VERIFICAR') {
      const resultado = await servico.verificarPacotePadrao({ pacote, pacoteSha256Esperado: sha256, ...comQuantidade });
      imprimirVerificacao(saida, resultado);
      return { saida: SAIDAS.OK, resultado };
    }
    const relatorio = await servico.importarPacotePadrao(pool, { pacote, pacoteSha256Esperado: sha256, armazenamento, mapeamento, executar: modo === 'EXECUTAR', destinoAutorizado: destino, ...comQuantidade });
    imprimirImportacao(saida, relatorio);
    return { saida: SAIDAS.OK, resultado: relatorio };
  } catch (erro) {
    if (erro instanceof servico.ErroImportacaoPadrao) {
      imprimirRecusa(saida, erro);
      return { saida: codigoDeSaida(erro.codigo), resultado: null };
    }
    throw erro;
  }
}

/** Armazenamento de MESMA interface que só lê: na simulação, uma pasta de imagens que ainda não existe não é criada só para olhar. */
function armazenamentoSemPasta() {
  const ausente = () => Object.assign(new Error('arquivo indisponível'), { codigo: 'ARQUIVO_AUSENTE' });
  return Object.freeze({
    existe: async () => false,
    abrir: async () => { throw ausente(); },
    gravar: async () => { throw new Error('armazenamento somente leitura'); },
  });
}

/** Armazenamento que só abre (e cria) o diretório na primeira chamada, que vem depois da conferência do destino: nenhum efeito no disco antes dela. */
function armazenamentoSobDemanda(abrir) {
  let real = null;
  const doDisco = () => { real ??= abrir(); return real; };
  return Object.freeze({
    existe: async (...argumentos) => doDisco().existe(...argumentos),
    abrir: async (...argumentos) => doDisco().abrir(...argumentos),
    gravar: async (...argumentos) => doDisco().gravar(...argumentos),
  });
}

function criarArmazenamento(modo, ambiente = process.env) {
  const fs = require('node:fs');
  const { lerConfiguracao, exigirDiretorio } = require('../src/config/imagens');
  const { criarArmazenamentoImagens } = require('../src/storage/armazenamento-imagens');
  const diretorio = exigirDiretorio(lerConfiguracao(ambiente));
  if (modo === 'SIMULAR') return fs.existsSync(diretorio) ? criarArmazenamentoImagens({ diretorio }) : armazenamentoSemPasta();
  return armazenamentoSobDemanda(() => criarArmazenamentoImagens({ diretorio }));
}

/** Só o que é seguro mostrar de uma falha inesperada: o código técnico e, nos erros do próprio módulo de imagens, a mensagem (sem valores). */
function descreverFalha(erro) {
  const tecnico = [erro?.codigo, erro?.code].find((codigo) => typeof codigo === 'string' && /^[A-Za-z0-9_.]{1,40}$/.test(codigo));
  const mensagem = typeof erro?.codigo === 'string' && erro.codigo.startsWith('IMAGENS_') ? ` — ${erro.message}` : '';
  return `${tecnico ?? 'erro inesperado'}${mensagem}`;
}

async function principal() {
  const interpretado = interpretarArgumentos(process.argv.slice(2));
  if (!interpretado.ok) {
    console.error(`Argumentos inválidos: ${interpretado.erro}`);
    console.error(uso());
    return SAIDAS.ARGUMENTOS;
  }
  if (interpretado.modo === 'VERIFICAR') return (await executarComando(interpretado)).saida;

  // O ambiente (DB_*) não comprova o destino: quem decide é a conferência na conexão que grava, contra o que o operador autorizou.
  const ambiente = [process.env.DB_NAME, process.env.DB_HOST, process.env.DB_PORT ?? '5432'].map((valor) => nomeSeguro(valor ?? '(não definido)'));
  console.log(`Ambiente (DB_*): banco ${ambiente[0]} em ${ambiente[1]}:${ambiente[2]}; modo ${interpretado.modo === 'EXECUTAR' ? 'EXECUTAR (grava)' : 'SIMULAR (não grava)'}`);
  const autorizado = interpretado.destino;
  console.log(autorizado ? `Destino autorizado: banco ${nomeSeguro(autorizado.banco ?? '(ausente)')} (oid ${nomeSeguro(autorizado.oid ?? '(ausente)')}); conferido na conexão antes de qualquer escrita` : 'Destino autorizado: não informado');
  const armazenamento = criarArmazenamento(interpretado.modo);
  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído, e --verificar nunca chega a este ponto.
  const { pool } = require('../src/config/database');
  try {
    return (await executarComando(interpretado, { pool, armazenamento })).saida;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  principal()
    .then((saida) => { process.exitCode = saida; })
    .catch((erro) => {
      console.error(`Falha: ${descreverFalha(erro)}`);
      process.exitCode = SAIDAS.ERRO;
    });
}

module.exports = { interpretarArgumentos, executarComando, criarArmazenamento, formatarDetalhe, uso, SAIDAS };
