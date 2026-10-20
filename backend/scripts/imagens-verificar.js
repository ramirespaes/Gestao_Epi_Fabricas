'use strict';

const servico = require('../src/services/imagem-armazenamento-verificacao.service');
const { nomeSeguro } = require('../src/utils/pacote-padrao-erros');

/**
 * Script administrativo: verifica a INTEGRIDADE das imagens armazenadas (registros no PostgreSQL × arquivos no diretório de imagens). SOMENTE LEITURA.
 * Biblioteca de Imagens, Unidade 5C-5.
 *
 *   node --require dotenv/config scripts/imagens-verificar.js [--json] [--idade-minima-minutos <n>] [--banco-autorizado <nome> --banco-oid <oid>]
 *
 * Mesma família de scripts/imagens-importar-padrao.js: Node autônomo, executado deliberadamente por um operador, credenciais e diretório só pelo ambiente
 * (DB_*, IMAGENS_ARMAZENAMENTO_DIRETORIO). NÃO EXISTE argumento que apague, restaure, mova ou corrija: o comando só relata. A limpeza de órfãos e a restauração de
 * arquivos são decisões separadas, futuras e autorizadas; qualquer argumento desconhecido é recusado (exit 2).
 *
 * BANCO: a saída informa o banco e o OID que o PostgreSQL confirma para a conexão. Com `--banco-autorizado` e `--banco-oid` (sempre juntos, vindos da autorização escrita,
 * nunca do ambiente) os dois são conferidos ANTES de ler qualquer imagem; se divergirem a saída é DESTINO_NAO_AUTORIZADO (2). Sem eles o banco é apenas informado.
 *
 * Códigos de saída (o PIOR veredito): OK=0 (íntegro), ERRO=1 (falha de execução), ARGUMENTOS=2, ORFAOS=3 (só arquivos sem registro), RECUPERAVEL=4 (arquivo ausente de
 * registro íntegro), INVESTIGAR=5 (divergência, estrutura estranha, leitura que falhou, raiz inutilizável ou alerta). A saída nunca leva caminho absoluto, segredo
 * nem caractere de controle vindo do disco.
 */

const SAIDAS = Object.freeze({
  OK: 0,
  ERRO: 1,
  ARGUMENTOS: 2,
  ORFAOS: 3,
  RECUPERAVEL: 4,
  INVESTIGAR: 5,
});
const SAIDA_DO_VEREDITO = Object.freeze({
  INTEGRO: SAIDAS.OK, ORFAO: SAIDAS.ORFAOS, RECUPERAVEL: SAIDAS.RECUPERAVEL, INVESTIGAR: SAIDAS.INVESTIGAR,
});
const EXPLICACAO = Object.freeze({
  INTEGRO: 'registros e arquivos conferem; nenhuma sobra',
  ORFAO: 'nenhum dano; há arquivos sem registro (limpeza só por decisão futura e autorizada)',
  RECUPERAVEL: 'há arquivos ausentes de registros íntegros; restaurar do backup dos arquivos e conferir o SHA-256 do registro',
  INVESTIGAR: 'há divergências, entradas impróprias, leituras que falharam ou alertas; investigar antes de qualquer correção',
});
const EXPLICACAO_DO_ALERTA = Object.freeze({
  RAIZ_AUSENTE: 'o diretório de imagens não existe (volume não montado ou caminho errado?); nada foi verificado',
  RAIZ_INVALIDA: 'o caminho configurado não é um diretório; nada foi verificado',
  RAIZ_ILEGIVEL: 'o diretório de imagens não pôde ser lido',
  NENHUM_ARQUIVO_ESPERADO_PRESENTE: 'nenhum arquivo esperado existe: confira se o diretório corresponde a este banco',
  BANCO_SEM_REGISTROS_COM_ARQUIVOS: 'o banco não tem registros, mas o armazenamento tem imagens: confira se o banco é o certo',
});

const COM_VALOR = Object.freeze({ '--idade-minima-minutos': 'idade', '--banco-autorizado': 'banco', '--banco-oid': 'oid' });
const IDADE = /^(?:0|[1-9][0-9]{0,5})$/;
const OID = /^[1-9][0-9]{0,9}$/;
const MAX_LINHAS_POR_SECAO = 40;

/**
 * Interpreta argv (já sem `node` e o caminho do script). Puro, sem I/O; o erro nunca ecoa o valor recebido.
 * @returns {{ok: true, json: boolean, idadeMinimaMinutos: number, destino: {banco: string, oid: string}|null}|{ok: false, erro: string}}
 */
function interpretarArgumentos(argumentos) {
  if (!Array.isArray(argumentos)) throw new TypeError('argumentos deve ser uma lista');
  const valores = { idade: null, banco: null, oid: null };
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
  if (valores.idade !== null && (!IDADE.test(valores.idade) || Number(valores.idade) > servico.IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS)) {
    return { ok: false, erro: `--idade-minima-minutos deve ser um inteiro de 0 a ${servico.IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS}` };
  }
  if ((valores.banco === null) !== (valores.oid === null)) return { ok: false, erro: '--banco-autorizado e --banco-oid devem ser informados juntos' };
  if (valores.oid !== null && !OID.test(valores.oid)) return { ok: false, erro: '--banco-oid deve ser numérico' };
  if (valores.banco !== null && (valores.banco.length > 63 || /\p{Cc}/u.test(valores.banco))) return { ok: false, erro: '--banco-autorizado inválido' };
  return {
    ok: true,
    json,
    idadeMinimaMinutos: valores.idade === null ? servico.IDADE_MINIMA_ORFAO_PADRAO_MINUTOS : Number(valores.idade),
    destino: valores.banco === null ? null : { banco: valores.banco, oid: valores.oid },
  };
}

function uso() {
  return [
    'Uso: node --require dotenv/config scripts/imagens-verificar.js [--json] [--idade-minima-minutos <n>] [--banco-autorizado <nome> --banco-oid <oid>]',
    'Verifica a integridade das imagens armazenadas: registros no banco × arquivos no diretório de imagens. SOMENTE LEITURA: nada é alterado, apagado, restaurado nem corrigido.',
    '  --json                    imprime um único documento JSON (banco conferido e relatório) em vez do texto',
    '  --idade-minima-minutos    idade mínima para um arquivo sem registro contar como órfão (0 a 525600; padrão 1440 = 24 horas); mais novo que isso é listado como "recente"',
    '  --banco-autorizado, --banco-oid   nome e OID do banco autorizado (sempre juntos); conferidos na conexão ANTES de ler qualquer imagem',
    'Ambiente: DB_* (banco) e IMAGENS_ARMAZENAMENTO_DIRETORIO (diretório de imagens).',
    'Saída: 0 íntegro, 1 erro, 2 argumentos/destino, 3 só arquivos sem registro, 4 recuperável (arquivo ausente), 5 investigar.',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------------------------------- texto
const abreviar = (hash) => (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? `${hash.slice(0, 12)}…` : hash);
const rotuloDaImagem = (imagem) => (imagem.escopo === 'PADRAO' ? `padrão · imagem ${imagem.imagemId}` : `empresa ${imagem.empresaId} · imagem ${imagem.imagemId}`);
const rotuloDaPasta = (item) => {
  if (item.escopo === 'RAIZ') return 'raiz do armazenamento';
  const dono = item.escopo === 'PADRAO' ? 'padrão' : `empresa ${item.empresaId}`;
  return item.hash === null ? dono : `${dono} · pasta ${abreviar(item.hash)}`;
};

function detalheDoAchado(achado) {
  switch (achado.tipo) {
    case 'TAMANHO_DIVERGENTE': return ` (esperado=${achado.esperado} encontrado=${achado.encontrado})`;
    case 'SHA256_DIVERGENTE': return ` (esperado=${abreviar(achado.esperado)} encontrado=${abreviar(achado.encontrado)})`;
    case 'ASSINATURA_DIVERGENTE': return ` (formato registrado=${achado.formatoRegistrado})`;
    case 'FORMATO_DIVERGENTE': return ` (encontrado=${nomeSeguro(achado.encontrado)})`;
    case 'ENTRADA_INVALIDA': return ` (${achado.componente}: ${achado.encontrado})`;
    case 'LEITURA_FALHOU': return ` (código ${achado.codigoSistema}; NÃO verificado)`;
    case 'REGISTRO_INVALIDO': return ` (campo=${achado.campo})`;
    default: return '';
  }
}

function linhasDaImagem(imagem) {
  const uso = imagem.materiaisEmUso > 0 ? ` · em uso por ${imagem.materiaisEmUso} material(is)` : '';
  return imagem.achados.map((achado) => {
    const onde = achado.variante === null ? rotuloDaImagem(imagem) : `${rotuloDaImagem(imagem)} · ${achado.variante}`;
    const chave = achado.chave === undefined ? '' : ` chave=${achado.chave}`;
    return `  - ${onde}: ${achado.tipo}${detalheDoAchado(achado)}${chave}${uso}`;
  });
}

function linhaDoArmazenamento(item) {
  const onde = item.tipo === 'ENTRADA_INESPERADA' || item.tipo === 'LEITURA_FALHOU' ? `${rotuloDaPasta(item)} · em ${item.onde}` : rotuloDaPasta(item);
  switch (item.tipo) {
    case 'ENTRADA_INESPERADA': return `  - ${onde}: ${item.tipo} ${item.encontrado} "${nomeSeguro(item.nome)}"`;
    case 'LEITURA_FALHOU': return `  - ${onde}: ${item.tipo} (código ${item.codigoSistema}; NÃO verificado)`;
    default: {
      const idade = item.idadeMinutos >= 1440 ? `${Math.floor(item.idadeMinutos / 1440)} dia(s)` : `${item.idadeMinutos} min`;
      return `  - ${onde}: ${item.tipo} (arquivos=${item.arquivos.length}${item.arquivos.length > 0 ? `: ${item.arquivos.map(nomeSeguro).join(', ')}` : ''}; ${item.bytes} bytes; idade ${idade})`;
    }
  }
}

function imprimirSecao(saida, titulo, nota, linhas, quantidade) {
  if (quantidade === 0) return;
  saida.log('');
  saida.log(`${titulo} (${quantidade})`);
  if (nota) saida.log(`  ${nota}`);
  for (const linha of linhas.slice(0, MAX_LINHAS_POR_SECAO)) saida.log(linha);
  if (linhas.length > MAX_LINHAS_POR_SECAO) saida.log(`  ... e mais ${linhas.length - MAX_LINHAS_POR_SECAO}`);
}

function imprimirRelatorio(saida, banco, destinoConfere, relatorio) {
  const { resumo } = relatorio;
  saida.log('Verificação de integridade das imagens — SOMENTE LEITURA (nada é alterado, apagado, restaurado nem corrigido)');
  saida.log(`Banco conferido pela conexão: ${nomeSeguro(banco.nome)} (oid ${nomeSeguro(banco.oid)}); ${destinoConfere ? 'destino autorizado confere' : 'destino NÃO confirmado (informe --banco-autorizado e --banco-oid para conferir o par banco/armazenamento)'}`);
  saida.log(`Registros: padrão=${resumo.registros.padrao} empresa=${resumo.registros.empresa}`);
  const a = resumo.arquivos;
  saida.log(`Arquivos esperados=${a.esperados} íntegros=${a.integros} ausentes=${a.ausentes} divergentes=${a.divergentes} não verificados=${a.naoVerificados}`);
  saida.log(`Imagens: íntegras=${resumo.imagens.INTEGRO} recuperáveis=${resumo.imagens.RECUPERAVEL} a investigar=${resumo.imagens.INVESTIGAR}`);
  saida.log(`Idade mínima para tratar arquivo sem registro como órfão: ${relatorio.idadeMinimaOrfaoMinutos} min`);
  saida.log(`Veredito: ${relatorio.veredito} — ${EXPLICACAO[relatorio.veredito]}`);

  imprimirSecao(saida, 'ALERTAS', null, relatorio.alertas.map((alerta) => `  - ${alerta.codigo}${alerta.codigoSistema ? ` (código ${alerta.codigoSistema})` : ''}: ${EXPLICACAO_DO_ALERTA[alerta.codigo] ?? ''}`), relatorio.alertas.length);

  const imagensInvestigar = relatorio.imagens.filter((i) => i.classe === 'INVESTIGAR');
  const sobrasInvestigar = relatorio.armazenamento.filter((s) => !s.recente && s.classe === 'INVESTIGAR');
  const linhasInvestigar = [...imagensInvestigar.flatMap(linhasDaImagem), ...sobrasInvestigar.map(linhaDoArmazenamento)];
  imprimirSecao(saida, 'EXIGE INVESTIGAÇÃO', 'divergência de conteúdo, entrada imprópria, registro inconsistente ou leitura que falhou: não corrigir antes de entender a causa', linhasInvestigar, imagensInvestigar.length + sobrasInvestigar.length);

  const recuperaveis = relatorio.imagens.filter((i) => i.classe === 'RECUPERAVEL');
  imprimirSecao(saida, 'PODE SER RECUPERADO', 'o registro está íntegro e o arquivo não existe: restaure do backup dos arquivos e confira o SHA-256 do registro', recuperaveis.flatMap(linhasDaImagem), recuperaveis.length);

  const sobras = relatorio.armazenamento.filter((s) => !s.recente && s.classe === 'ORFAO');
  imprimirSecao(saida, 'SOBRAS SEM REGISTRO', 'sem dano; limpeza só por decisão futura e autorizada (esta verificação não apaga nada)', sobras.map(linhaDoArmazenamento), sobras.length);

  const recentes = relatorio.armazenamento.filter((s) => s.recente);
  imprimirSecao(saida, 'RECENTES', 'mais novos que a idade mínima: podem ser um envio em andamento; não entram no veredito', recentes.map(linhaDoArmazenamento), recentes.length);

  saida.log('');
  saida.log('Nenhuma alteração foi feita. Esta verificação não apaga órfãos, não restaura arquivos e não altera registros.');
}

// ------------------------------------------------------------------------------------------------------------------------- execução
/**
 * Executa o comando com as dependências já prontas. Devolve o código de saída e o relatório, sem encerrar o pool (de quem chama). Erros que não são
 * de destino propagam.
 *
 * @param {{json: boolean, idadeMinimaMinutos: number, destino: {banco: string, oid: string}|null}} opcoes
 * @param {{pool: object, diretorio: string, saida?: {log: Function, error: Function}, agora?: Function, fs?: object, tamanhoDaPagina?: number}} dependencias
 */
async function executarComando({ json, idadeMinimaMinutos, destino }, {
  pool, diretorio, saida = console, agora, fs, tamanhoDaPagina,
} = {}) {
  const banco = await servico.identificarBanco(pool);
  const destinoConfere = destino !== null && destino !== undefined && destino.banco === banco.nome && destino.oid === banco.oid;
  if (destino && !destinoConfere) {
    saida.error('Recusado (DESTINO_NAO_AUTORIZADO): o banco da conexão não é o autorizado. Nenhuma imagem foi lida.');
    saida.error(`  Conectado: banco ${nomeSeguro(banco.nome)} (oid ${nomeSeguro(banco.oid)})`);
    return { saida: SAIDAS.ARGUMENTOS, resultado: null };
  }
  const relatorio = await servico.verificarArmazenamento(pool, {
    diretorio,
    idadeMinimaOrfaoMinutos: idadeMinimaMinutos,
    ...(agora === undefined ? {} : { agora }),
    ...(fs === undefined ? {} : { fs }),
    ...(tamanhoDaPagina === undefined ? {} : { tamanhoDaPagina }),
  });
  if (json) saida.log(JSON.stringify({ banco, destinoConfere, relatorio }));
  else imprimirRelatorio(saida, banco, destinoConfere, relatorio);
  return { saida: SAIDA_DO_VEREDITO[relatorio.veredito], resultado: relatorio };
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
  const { lerConfiguracao, exigirDiretorio } = require('../src/config/imagens');
  const diretorio = exigirDiretorio(lerConfiguracao(process.env));
  // Carregado só aqui: o pool lê DB_* do ambiente ao ser construído, e uma configuração errada falha antes de qualquer conexão.
  const { pool } = require('../src/config/database');
  try {
    return (await executarComando(interpretado, { pool, diretorio })).saida;
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

module.exports = { interpretarArgumentos, executarComando, uso, SAIDAS };
