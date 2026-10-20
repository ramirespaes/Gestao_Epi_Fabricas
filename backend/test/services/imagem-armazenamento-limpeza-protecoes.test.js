'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED): PROTEÇÕES ARQUITETURAIS que já valem HOJE e têm de continuar valendo depois da implementação. Estes
 * testes nascem VERDES (não dependem do módulo novo) e quebram se alguém desfizer uma decisão aprovada em 18/10/2026:
 *   - o `imagens:verificar` continua SOMENTE LEITURA e recusa qualquer argumento da limpeza (a limpeza é ferramenta separada);
 *   - a exclusão pela API continua removendo só o registro; nenhum código de produção remove arquivo de imagem além da própria limpeza;
 *   - a limpeza não vira rota HTTP, não é montada em app.js/server.js e não ganha temporizador no processo da API (execução por cron externo, nunca por timer na API);
 *   - a interface do armazenamento de imagens (selada) não muda para acomodar a limpeza.
 * Leitura estática do código-fonte: sem comentários, para a documentação não contar como chamada.
 */

const SRC = path.join(__dirname, '..', '..', 'src');
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

function arquivosJs(diretorio) {
  const achados = [];
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const completo = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) achados.push(...arquivosJs(completo));
    else if (entrada.name.endsWith('.js') && !/ 2\.js$/.test(entrada.name)) achados.push(completo);
  }
  return achados.sort();
}

/** Remove comentários de bloco e de linha (sem tentar entender strings): serve para provar a AUSÊNCIA de chamadas, nunca a presença. */
const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const lerCodigo = (arquivo) => semComentarios(fs.readFileSync(arquivo, 'utf8'));
const relativo = (arquivo) => path.relative(path.join(__dirname, '..', '..'), arquivo);

/** Chamada de método que destrói, move ou escreve em disco. */
const OPERACAO_DE_ESCRITA = /\.(?:unlink|unlinkSync|rmdir|rmdirSync|rm|rmSync|rename|renameSync|writeFile|writeFileSync|appendFile|appendFileSync|truncate|mkdir|mkdirSync|copyFile|symlink|link|chmod|utimes)\s*\(/;
const CHAMADA_DE_REMOCAO_DE_IMAGEM = /\.(?:remover|removerVariantes)\s*\(/;
const SERVICO_DA_LIMPEZA = path.join(SRC, 'services', 'imagem-armazenamento-limpeza.service.js');
const ARMAZENAMENTO = path.join(SRC, 'storage', 'armazenamento-imagens.js');

describe('[PRT] o verificador continua SOMENTE LEITURA e a limpeza é outra ferramenta', () => {
  test('PRT-01 — o serviço, o repositório e o comando do verificador não contêm nenhuma chamada que escreva, mova ou apague em disco', () => {
    const arquivos = [
      path.join(SRC, 'services', 'imagem-armazenamento-verificacao.service.js'),
      path.join(SRC, 'repositories', 'imagem-verificacao.repository.js'),
      path.join(SCRIPTS, 'imagens-verificar.js'),
    ];
    for (const arquivo of arquivos) assert.doesNotMatch(lerCodigo(arquivo), OPERACAO_DE_ESCRITA, relativo(arquivo));
    for (const arquivo of arquivos.slice(0, 2)) assert.doesNotMatch(lerCodigo(arquivo), /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/, `${relativo(arquivo)} não escreve no banco`);
  });

  test('PRT-02 — `imagens:verificar` recusa como "argumento desconhecido" tudo o que é da limpeza: executar, limpar, retenção, intervalo de backup, limite e os atalhos', () => {
    const { interpretarArgumentos } = require('../../scripts/imagens-verificar');
    for (const argumento of ['--executar', '--limpar-orfaos', '--remover-orfaos', '--retencao-minutos', '--intervalo-backup-minutos', '--limite', '--forcar', '--purgar']) {
      assert.deepEqual(interpretarArgumentos([argumento]), { ok: false, erro: 'argumento desconhecido' }, argumento);
    }
    assert.equal(interpretarArgumentos(['--idade-minima-minutos', '1440']).ok, true, 'o argumento próprio do verificador continua valendo');
  });

  test('PRT-03 — nenhum script npm que comece por "imagens:" embute `--executar` (a execução é sempre uma decisão do operador, na hora)', () => {
    const pacote = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const scripts = Object.entries(pacote.scripts).filter(([nome]) => nome.startsWith('imagens:'));
    assert.ok(scripts.length >= 1, 'há ao menos o verificador (imagens:verificar)');
    for (const [nome, comando] of scripts) assert.doesNotMatch(comando, /--executar/, nome);
  });
});

describe('[PRT] ninguém, além da limpeza, remove arquivo de imagem', () => {
  test('PRT-04 — a exclusão e o registro de imagem (serviço, repositório e envio) não removem arquivo: nem chamam remover/removerVariantes nem apagam em disco', () => {
    const arquivos = [
      path.join(SRC, 'services', 'imagem-material.service.js'),
      path.join(SRC, 'services', 'imagem-material-upload.service.js'),
      path.join(SRC, 'repositories', 'imagem-empresa.repository.js'),
      path.join(SRC, 'repositories', 'imagem-padrao.repository.js'),
    ];
    for (const arquivo of arquivos) {
      const codigo = lerCodigo(arquivo);
      assert.doesNotMatch(codigo, CHAMADA_DE_REMOCAO_DE_IMAGEM, relativo(arquivo));
      assert.doesNotMatch(codigo, OPERACAO_DE_ESCRITA, relativo(arquivo));
    }
  });

  test('PRT-05 — todo arquivo de produção que usa o armazenamento de imagens (menos o próprio armazenamento, o serviço da limpeza e a trava de janela, que apaga só o próprio arquivo de trava) NÃO chama remover/removerVariantes nem apaga em disco', () => {
    const excecoes = [ARMAZENAMENTO, SERVICO_DA_LIMPEZA, path.join(SRC, 'utils', 'janela-escrita-imagens.js')];
    // O arquivo é escolhido pelo CÓDIGO (sem comentários): citar o armazenamento num comentário não faz de um arquivo "usuário" dele.
    const quemUsa = arquivosJs(SRC).filter((arquivo) => !excecoes.includes(arquivo) && /armazenamento-imagens/.test(lerCodigo(arquivo)));
    assert.ok(quemUsa.length >= 4, `esperava ao menos 4 usuários do armazenamento, achei ${quemUsa.length}`);
    for (const arquivo of quemUsa) {
      const codigo = lerCodigo(arquivo);
      assert.doesNotMatch(codigo, CHAMADA_DE_REMOCAO_DE_IMAGEM, relativo(arquivo));
      assert.doesNotMatch(codigo, /\.(?:unlink|unlinkSync|rmdir|rmdirSync|rm|rmSync)\s*\(/, relativo(arquivo));
    }
  });

  test('PRT-06 — a interface do armazenamento de imagens (selada) continua a mesma: a limpeza usa a sua própria fachada de arquivos e não exige método novo ali', () => {
    const raiz = criarRaizTemporaria();
    raizes.push(raiz);
    const armazenamento = criarArmazenamentoImagens({ diretorio: raiz });
    assert.deepEqual(Object.keys(armazenamento).sort(), ['abrir', 'chaveDe', 'existe', 'gravar', 'listar', 'remover', 'removerVariantes']);
  });
});

describe('[PRT] a limpeza não vira rota nem temporizador do processo da API', () => {
  const ASSINATURAS = /imagem-armazenamento-limpeza|janela-escrita-imagens|limparOrfaos|imagens-limpar-orfaos|limpar-orfaos/;

  test('PRT-07 — app.js, server.js, rotas, controladores, middlewares e configuração não importam nem citam a limpeza ou a trava de janela; só o serviço da limpeza e a própria trava a conhecem em src/', () => {
    const permitidos = new Set([SERVICO_DA_LIMPEZA, path.join(SRC, 'utils', 'janela-escrita-imagens.js')]);
    const citam = arquivosJs(SRC).filter((arquivo) => ASSINATURAS.test(lerCodigo(arquivo)) && !permitidos.has(arquivo));
    assert.deepEqual(citam.map(relativo), [], 'nenhum outro arquivo de produção deve conhecer a limpeza');
    for (const nome of ['app.js', 'server.js']) assert.doesNotMatch(lerCodigo(path.join(SRC, nome)), ASSINATURAS, nome);
  });

  test('PRT-08 — não existe rota HTTP nem agendador dentro da API para a limpeza: nenhuma rota cita "orfao" e app.js/server.js não ganharam temporizador de imagens', () => {
    for (const arquivo of arquivosJs(path.join(SRC, 'routes'))) assert.doesNotMatch(lerCodigo(arquivo), /orf[aã]o|orfaos|limpeza/i, relativo(arquivo));
    for (const nome of ['app.js', 'server.js']) {
      const codigo = lerCodigo(path.join(SRC, nome));
      for (const temporizador of codigo.match(/set(?:Interval|Timeout)\s*\([^;]*$/gm) ?? []) assert.doesNotMatch(temporizador, /imagem|orf|limpeza/i, `${nome}: ${temporizador}`);
    }
  });
});

describe('[PEND] decisões de desenho ainda abertas (registradas para a revisão da V8; sem teste até haver decisão)', () => {
  test.todo('IDADE PELA EXCLUSÃO DO REGISTRO — hoje a idade do órfão é a do ARQUIVO mais novo (como no verificador); a auditoria da exclusão não guarda o hash, então não há como saber há quanto tempo a linha sumiu (Documento 65, seção 7.2, mecanismo (B) fala em "linha sumiu há mais que a retenção"). Decidir se vale um tombstone.');
  test.todo('MARCADOR DE ÚLTIMO BACKUP CONCLUÍDO — hoje a compatibilidade com os backups é DECLARADA pelo operador (--intervalo-backup-minutos). Um marcador escrito pelo procedimento de backup tornaria a regra verificável (remover só arquivo mais velho que o último backup concluído).');
  test.todo('AUDITORIA DA EXECUÇÃO NO BANCO — hoje a limpeza não escreve no banco e o relatório (JSON) é o registro. Decidir se cada execução também grava um evento em logs_auditoria.');
  test.todo('BIBLIOTECA PADRÃO — hoje fora do escopo da limpeza (só relatada em foraDoEscopo). Decidir se algum dia uma ferramenta própria trata o órfão da biblioteca padrão.');
  test.todo('PURGA DE IMAGENS INATIVAS — decisão à parte, fora desta ferramenta (imagem inativa tem registro e arquivos e nunca é órfã).');
  test.todo('PROCEDIMENTO DE BACKUP — o procedimento operacional (operar-5c9) passa a criar e soltar a trava de janela pelo protocolo da trava (arquivo exclusivo, JSON, token); alteração operacional futura, fora do código da API.');
});
