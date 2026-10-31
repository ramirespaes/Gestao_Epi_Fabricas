'use strict';

const fsp = require('node:fs/promises');
const servico = require('../src/services/imagem-biblioteca-prontidao.service');
const { ErroImportacaoPadrao, nomeSeguro } = require('../src/utils/pacote-padrao-erros');
const { MAX_BYTES: PLANO_MAX_BYTES } = require('../src/utils/plano-pacotes-padrao');

/**
 * Script de publicação: confere se a biblioteca padrão de imagens foi PROVISIONADA no ambiente. SOMENTE LEITURA: não importa, não cria diretório, não grava
 * no banco. Quem importa é scripts/imagens-importar-padrao.js (npm run imagens:importar-padrao), que este comando reaproveita em simulação.
 *
 *   IMAGENS_BIBLIOTECA_PADRAO=obrigatoria|desabilitada node --require dotenv/config scripts/imagens-prontidao.js
 *     --plano <json absoluto> --plano-sha256 <hash aprovado do plano> --pacotes <pasta absoluta dos ZIPs>
 *     --banco-autorizado <nome> --banco-oid <oid> [--idade-minima-minutos <n>] [--json]
 *
 * A política vem do ambiente e é sempre explícita (ausente = recusa, nunca "desabilitada"). Desabilitada: nada é consultado e os demais argumentos são
 * dispensados. Obrigatória: o plano, o hash aprovado dele (de FORA do plano, do registro de aprovação da publicação) e a identidade do banco (nome e OID da
 * autorização escrita, nunca de DB_*) são exigidos; o banco da conexão é conferido contra eles antes de qualquer leitura, para não aprovar outro ambiente.
 *
 * Códigos de saída: 0 = DESABILITADA ou PROVISIONADA_INTEGRA (o estado vai impresso na linha ESTADO=), 1 = falha de execução, 2 = argumentos, política ou destino
 * inválidos, 3 = plano ou pacote sem integridade comprovada, 4 = NAO_PROVISIONADA, 5 = INCONSISTENTE. Qualquer código diferente de 0 deve reprovar a publicação.
 * A saída nunca leva caminho absoluto, segredo, hash de arquivo nem caractere de controle vindo do disco.
 */

const SAIDAS = Object.freeze({ OK: 0, ERRO: 1, ARGUMENTOS: 2, INTEGRIDADE: 3, NAO_PROVISIONADA: 4, INCONSISTENTE: 5 });
const SAIDA_DO_ESTADO = Object.freeze({
  DESABILITADA: SAIDAS.OK,
  PROVISIONADA_INTEGRA: SAIDAS.OK,
  NAO_PROVISIONADA: SAIDAS.NAO_PROVISIONADA,
  INCONSISTENTE: SAIDAS.INCONSISTENTE,
});
const EXPLICACAO = Object.freeze({
  DESABILITADA: 'a biblioteca está desabilitada de propósito neste ambiente; nada foi consultado',
  NAO_PROVISIONADA: 'a biblioteca é obrigatória e ainda não foi provisionada; importe os pacotes aprovados e repita a verificação',
  INCONSISTENTE: 'há divergência ou configuração inadequada; investigar antes de importar ou corrigir qualquer coisa',
  PROVISIONADA_INTEGRA: 'todas as imagens do plano têm registro e arquivos conferidos; armazenamento íntegro',
});
const ERROS_DE_ARGUMENTO = Object.freeze(['PACOTE_ARGUMENTOS_INVALIDOS', 'DESTINO_NAO_AUTORIZADO']);

const COM_VALOR = Object.freeze({
  '--plano': 'plano', '--plano-sha256': 'planoSha256', '--pacotes': 'pacotes', '--idade-minima-minutos': 'idade', '--banco-autorizado': 'banco', '--banco-oid': 'oid',
});
const SHA256 = /^[0-9a-f]{64}$/;
const IDADE = /^(?:0|[1-9][0-9]{0,5})$/;
const OID = /^[1-9][0-9]{0,9}$/;
const MAX_LINHAS = 40;

const caminhoAbsoluto = (valor) => valor.length <= 4096 && !valor.includes('\0') && valor.startsWith('/');

/**
 * Interpreta argv (já sem `node` e o caminho do script). Puro, sem I/O; o erro nunca ecoa o valor recebido. A obrigatoriedade de plano e pacotes depende da
 * política e por isso é conferida em `executarComando`.
 */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  const valores = { plano: null, planoSha256: null, pacotes: null, idade: null, banco: null, oid: null };
  let json = false;
  for (let i = 0; i < argumentos.length; i += 1) {
    const argumento = argumentos[i];
    if (Object.hasOwn(COM_VALOR, argumento)) {
      const campo = COM_VALOR[argumento];
      const valor = argumentos[i + 1];
      if (typeof valor !== 'string' || valor.startsWith('--')) return { ok: false, erro: `${argumento} exige um valor` };
      if (valores[campo] !== null) return { ok: false, erro: `${argumento} informado mais de uma vez` };
      valores[campo] = valor;
      i += 1;
    } else if (argumento === '--json') {
      if (json) return { ok: false, erro: '--json informado mais de uma vez' };
      json = true;
    } else {
      return { ok: false, erro: 'argumento desconhecido' };
    }
  }
  if (valores.plano !== null && !caminhoAbsoluto(valores.plano)) return { ok: false, erro: '--plano deve ser um caminho absoluto' };
  if (valores.pacotes !== null && !caminhoAbsoluto(valores.pacotes)) return { ok: false, erro: '--pacotes deve ser um caminho absoluto' };
  if (valores.planoSha256 !== null && !SHA256.test(valores.planoSha256)) return { ok: false, erro: '--plano-sha256 deve ter 64 caracteres hexadecimais minúsculos' };
  if (valores.idade !== null && !IDADE.test(valores.idade)) return { ok: false, erro: '--idade-minima-minutos deve ser um inteiro de 0 a 525600' };
  if ((valores.banco === null) !== (valores.oid === null)) return { ok: false, erro: '--banco-autorizado e --banco-oid devem ser informados juntos' };
  if (valores.oid !== null && !OID.test(valores.oid)) return { ok: false, erro: '--banco-oid deve ser numérico' };
  if (valores.banco !== null && (valores.banco.length > 63 || /\p{Cc}/u.test(valores.banco))) return { ok: false, erro: '--banco-autorizado inválido' };
  return {
    ok: true,
    json,
    plano: valores.plano,
    planoSha256: valores.planoSha256,
    pacotes: valores.pacotes,
    idadeMinimaMinutos: valores.idade === null ? undefined : Number(valores.idade),
    destino: valores.banco === null ? null : { banco: valores.banco, oid: valores.oid },
  };
}

function uso() {
  return [
    'Uso: IMAGENS_BIBLIOTECA_PADRAO=obrigatoria|desabilitada node --require dotenv/config scripts/imagens-prontidao.js --plano <json> --plano-sha256 <hash> --pacotes <pasta> --banco-autorizado <nome> --banco-oid <oid> [opções]',
    'Confere se a biblioteca padrão de imagens foi provisionada. SOMENTE LEITURA: nada é importado, criado, alterado nem apagado.',
    '  --plano             caminho absoluto do JSON do plano de pacotes aprovados (obrigatório com política obrigatoria)',
    '  --plano-sha256      SHA-256 aprovado do plano, vindo de FORA dele (obrigatório com política obrigatoria)',
    '  --pacotes           pasta absoluta onde estão os ZIPs do plano (obrigatório com política obrigatoria)',
    '  --idade-minima-minutos   idade mínima para um arquivo sem registro contar como órfão (padrão 1440)',
    '  --banco-autorizado, --banco-oid   nome e OID do banco do ambiente publicado, da autorização escrita e nunca de DB_* (sempre juntos; obrigatórios com política obrigatoria); conferidos na conexão ANTES de ler qualquer imagem',
    '  --json              imprime um único documento JSON em vez do texto',
    'Ambiente: IMAGENS_BIBLIOTECA_PADRAO (obrigatoria ou desabilitada; sem valor, recusa), IMAGENS_ARMAZENAMENTO_DIRETORIO, DB_*.',
    'Saída: 0 desabilitada ou provisionada e íntegra, 1 erro, 2 argumentos/política/destino, 3 plano ou pacote sem integridade, 4 não provisionada, 5 inconsistente.',
  ].join('\n');
}

/** Lê o arquivo do plano com teto de tamanho; qualquer falha é PLANO_INDISPONIVEL, sem caminho na mensagem. */
async function lerArquivoDoPlano(caminho) {
  let arquivo;
  try {
    arquivo = await fsp.open(caminho, 'r');
  } catch {
    throw new ErroImportacaoPadrao('PLANO_INDISPONIVEL');
  }
  try {
    const informacao = await arquivo.stat();
    if (!informacao.isFile() || informacao.size > PLANO_MAX_BYTES) throw new ErroImportacaoPadrao('PLANO_INDISPONIVEL');
    return await arquivo.readFile();
  } catch (erro) {
    if (erro instanceof ErroImportacaoPadrao) throw erro;
    throw new ErroImportacaoPadrao('PLANO_INDISPONIVEL');
  } finally {
    await arquivo.close();
  }
}

// ------------------------------------------------------------------------------------------------------------------------- texto
function linhaDoMotivo(motivo) {
  const partes = [motivo.codigo];
  for (const campo of ['arquivo', 'variavel', 'faltandoRegistro', 'faltandoArquivo', 'divergencias']) {
    if (motivo[campo] !== undefined) partes.push(`${campo}=${typeof motivo[campo] === 'string' ? nomeSeguro(motivo[campo]) : motivo[campo]}`);
  }
  return `  - [${motivo.classe}] ${partes.join(' ')}`;
}

function linhaDoPacote(pacote) {
  if (pacote.situacao === 'DIVERGENTE') return `  - ${nomeSeguro(pacote.arquivo)}: DIVERGENTE (${pacote.divergenciasTotal} divergência(s))`;
  return `  - ${nomeSeguro(pacote.arquivo)}: ${pacote.situacao} (imagens=${pacote.imagens} registradas=${pacote.registradas} sem registro=${pacote.faltandoRegistro} arquivos faltando=${pacote.faltandoArquivo})`;
}

function imprimirRelatorio(saida, relatorio) {
  saida.log('Prontidão da biblioteca padrão de imagens — SOMENTE LEITURA (nada é importado, criado, alterado nem apagado)');
  saida.log(`Política (${servico.POLITICA_VARIAVEL}): ${relatorio.politica}`);
  saida.log(`ESTADO=${relatorio.estado}`);
  saida.log(`Resultado: ${EXPLICACAO[relatorio.estado]}`);
  if (relatorio.plano) saida.log(`Plano aprovado: ${relatorio.plano.pacotes} pacote(s)`);
  if (relatorio.banco) saida.log(`Banco conferido pela conexão: ${nomeSeguro(relatorio.banco.nome)} (oid ${nomeSeguro(relatorio.banco.oid)})`);
  for (const aviso of relatorio.avisos) saida.log(`Aviso: ${aviso.codigo}`);
  if (relatorio.motivos.length > 0) {
    saida.log('Motivos:');
    for (const motivo of relatorio.motivos.slice(0, MAX_LINHAS)) saida.log(linhaDoMotivo(motivo));
    if (relatorio.motivos.length > MAX_LINHAS) saida.log(`  ... e mais ${relatorio.motivos.length - MAX_LINHAS}`);
  }
  if (relatorio.pacotes?.length > 0) {
    saida.log('Pacotes:');
    for (const pacote of relatorio.pacotes.slice(0, MAX_LINHAS)) saida.log(linhaDoPacote(pacote));
    for (const pacote of relatorio.pacotes.filter((p) => p.situacao === 'DIVERGENTE')) {
      for (const d of pacote.divergencias) {
        saida.log(`      · ${['nome', 'alvo', 'campo', 'motivo'].filter((c) => d[c] !== undefined).map((c) => `${c}=${d[c]}`).join(' ')}`);
      }
    }
  }
  if (relatorio.armazenamento) {
    const r = relatorio.armazenamento.resumo;
    saida.log(`Armazenamento: veredito=${relatorio.armazenamento.veredito} registros padrão=${r.registros.padrao} empresa=${r.registros.empresa} arquivos íntegros=${r.arquivos.integros}/${r.arquivos.esperados}`);
  }
  saida.log('');
  saida.log('Nenhuma alteração foi feita.');
}

function imprimirRecusa(saida, erro) {
  saida.error(`Recusado (${erro.codigo}): ${erro.message}`);
  for (const detalhe of erro.detalhes.slice(0, MAX_LINHAS)) {
    const partes = [];
    for (const campo of ['entrada', 'nome', 'linha', 'campo', 'motivo', 'alvo']) if (detalhe[campo] !== undefined) partes.push(`${campo}=${typeof detalhe[campo] === 'string' ? nomeSeguro(detalhe[campo]) : detalhe[campo]}`);
    saida.error(`  - ${partes.join(' ')}`);
  }
}

function saidaDoErro(erro) {
  if (erro instanceof ErroImportacaoPadrao) {
    if (ERROS_DE_ARGUMENTO.includes(erro.codigo)) return SAIDAS.ARGUMENTOS;
    if (erro.codigo.startsWith('PACOTE_') || erro.codigo.startsWith('PLANO_') || erro.codigo === 'IMAGEM_PADRAO_INVALIDA') return SAIDAS.INTEGRIDADE;
    return SAIDAS.ERRO;
  }
  return erro?.codigo === 'IMAGENS_POLITICA_INVALIDA' ? SAIDAS.ARGUMENTOS : null;
}

// ------------------------------------------------------------------------------------------------------------------------- execução
/**
 * Executa o comando com as dependências já prontas. Devolve o código de saída e o relatório, sem encerrar o pool (de quem chama). Erros que não são do
 * serviço de prontidão propagam.
 *
 * @param {{ json: boolean, plano: string|null, planoSha256: string|null, pacotes: string|null, idadeMinimaMinutos?: number, destino: {banco: string, oid: string}|null }} opcoes
 * @param {{ ambiente?: object, pool?: object, saida?: {log: Function, error: Function}, lerArquivo?: Function, verificarProntidao?: Function }} dependencias
 */
async function executarComando(opcoes, {
  ambiente = process.env, pool, saida = console, lerArquivo = lerArquivoDoPlano, verificarProntidao = servico.verificarProntidao,
} = {}) {
  let politica;
  try {
    politica = servico.lerPolitica(ambiente);
  } catch (erro) {
    saida.error(`Política inválida (${erro.codigo}): ${erro.message}`);
    return { saida: SAIDAS.ARGUMENTOS, resultado: null };
  }
  const exigidos = {
    '--plano': opcoes.plano, '--plano-sha256': opcoes.planoSha256, '--pacotes': opcoes.pacotes, '--banco-autorizado e --banco-oid': opcoes.destino,
  };
  const faltando = Object.entries(exigidos).filter(([, valor]) => valor === null).map(([nome]) => nome);
  if (politica === servico.POLITICAS.OBRIGATORIA && faltando.length > 0) {
    saida.error(`Argumentos inválidos: com política obrigatoria, ${faltando.join('; ')} ${faltando.length > 1 ? 'são obrigatórios' : 'é obrigatório'}`);
    return { saida: SAIDAS.ARGUMENTOS, resultado: null };
  }
  try {
    const plano = politica === servico.POLITICAS.OBRIGATORIA ? { bytes: await lerArquivo(opcoes.plano), sha256Esperado: opcoes.planoSha256 } : null;
    const relatorio = await verificarProntidao({
      ambiente,
      pool,
      plano,
      pastaPacotes: opcoes.pacotes,
      destino: opcoes.destino,
      ...(opcoes.idadeMinimaMinutos === undefined ? {} : { idadeMinimaOrfaoMinutos: opcoes.idadeMinimaMinutos }),
    });
    if (opcoes.json) saida.log(JSON.stringify(relatorio));
    else imprimirRelatorio(saida, relatorio);
    return { saida: SAIDA_DO_ESTADO[relatorio.estado], resultado: relatorio };
  } catch (erro) {
    const codigo = saidaDoErro(erro);
    if (codigo === null) throw erro;
    if (erro instanceof ErroImportacaoPadrao) imprimirRecusa(saida, erro);
    else saida.error(`Política inválida (${erro.codigo}): ${erro.message}`);
    return { saida: codigo, resultado: null };
  }
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
  let politica = null;
  try {
    politica = servico.lerPolitica(process.env);
  } catch {
    // a recusa e a mensagem são de executarComando; sem política válida o banco nunca é carregado
  }
  if (politica !== servico.POLITICAS.OBRIGATORIA) return (await executarComando(interpretado)).saida;
  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído, e política desabilitada ou inválida nunca chega a este ponto.
  const { pool } = require('../src/config/database');
  try {
    return (await executarComando(interpretado, { pool })).saida;
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

module.exports = { interpretarArgumentos, executarComando, lerArquivoDoPlano, uso, SAIDAS };
