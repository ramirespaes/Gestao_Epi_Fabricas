'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Writable, pipeline } = require('node:stream');
const { ehOrcamentoDeBytes, ehFaltaDeEspaco } = require('../utils/orcamento-de-bytes');
const { criarDiagnosticoDoStderr } = require('./imagem-backup-diagnostico-stderr.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): CAPTURA ÍNTEGRA DO DUMP DURANTE A ESCRITA. O `pg_dump` (formato custom) emite os bytes pelo STDOUT; este módulo os recebe como fluxo BINÁRIO, calcula o SHA-256 INCREMENTAL sobre exatamente os bytes
 * recebidos e os grava, sem perder nenhum, num descritor de arquivo exclusivo já aberto pelo chamador. Não abre arquivo, não lança processo e não lê ambiente.
 *
 * `criarCapturaDoDump({ descritor, sistemaDeArquivos? })` -> `{ consumir({ stdout, stderr }) }` (ESTRITO; TypeError genérico). `consumir` devolve UMA promessa que NUNCA rejeita e resolve com a evidência CONGELADA:
 *   - sucesso: `{ ok:true, origem:'STDOUT_DO_PG_DUMP', fimDoFluxo:'STDOUT_ENCERRADO_NORMALMENTE', bytesRecebidos, bytesGravados, sha256FluxoRecebido, fsyncConcluido:true, stderrBytes, atestaConteudoLogico:false }`;
 *   - falha: `{ ok:false, motivo, bytesRecebidos, bytesGravados, stderrBytes }` com motivo de um conjunto fechado: FLUXO_AUSENTE, FLUXO_NAO_BINARIO, FECHAMENTO_PREMATURO (fluxo encerrado antes do fim), ERRO_NO_FLUXO (erro do stdout), ERRO_DE_ESCRITA, ESCRITA_INCOMPLETA
 *     (retorno de escrita inválido ou zero), FSYNC_FALHOU, DUMP_VAZIO e DIVERGENCIA_DE_BYTES (recebidos != gravados).
 * ESCRITA: posicional (a partir de 0), com laço para escritas PARCIAIS (só avança o que o sistema confirmou); a próxima parte só é pedida quando a anterior foi gravada (BACKPRESSURE do `Writable`: o `stdout` é pausado enquanto o destino não drena). Nenhum byte é descartado: o
 * hash e a contagem usam o mesmo pedaço que é gravado. O `fsync` do descritor roda no fim do fluxo, antes de a promessa resolver. O stderr é só CONSUMIDO (para não bloquear o processo) e contado: nenhum conteúdo é retido nem exportado.
 *
 * LIMITES DE TAMANHO (P4, opcionais; sem eles o comportamento é o anterior): `limiteDeBytes` (teto deste dump) e `orcamento` (orçamento de bytes da execução, compartilhado com a cópia das imagens). A verificação é feita ANTES de hashear e gravar cada pedaço, com
 * aritmética sem estouro (`pedaco.length > limite - recebidos`); um pedaço que não cabe NÃO é hasheado, contado nem gravado, o fluxo é encerrado (o `pg_dump` recebe a quebra do pipe) e a evidência é `{ ok:false, motivo:'LIMITE_EXCEDIDO' | 'LIMITE_TOTAL_EXCEDIDO' }`
 * com os bytes já aceitos; o arquivo parcial é PRESERVADO (nada é apagado aqui). `ENOSPC`/`EDQUOT` em escrita ou `fsync` viram `ESPACO_ESGOTADO` (também com o parcial preservado). Toda evidência traz `diagnosticoDoStderr` (P5): só códigos fechados e contadores
 * limitados, nunca texto; é INFORMATIVO e não participa de nenhuma decisão do supervisor.
 *
 * LIMITES: o SHA-256 do fluxo e o SHA-256 do arquivo persistido (releitura posterior) provam que o arquivo corresponde ao que o `pg_dump` EMITIU; NÃO são duas fontes independentes do conteúdo lógico do banco e NÃO atestam a correção interna do `pg_dump`.
 */

const MOTIVOS = Object.freeze(['FLUXO_AUSENTE', 'FLUXO_NAO_BINARIO', 'FECHAMENTO_PREMATURO', 'ERRO_NO_FLUXO', 'ERRO_DE_ESCRITA', 'ESCRITA_INCOMPLETA', 'FSYNC_FALHOU', 'DUMP_VAZIO', 'DIVERGENCIA_DE_BYTES', 'LIMITE_EXCEDIDO', 'LIMITE_TOTAL_EXCEDIDO', 'ESPACO_ESGOTADO']);
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const ehLegivel = (v) => ehObjeto(v) && ehFuncao(v.on) && ehFuncao(v.pipe);

class FalhaDeCaptura extends Error {
  constructor(motivo) { super('falha na captura do dump'); this.motivoDaCaptura = motivo; }
}

function criarCapturaDoDump(opcoes) {
  let descritor;
  let escrever;
  let sincronizar;
  let limiteDeBytes = null;
  let orcamento = null;
  try {
    if (!ehObjeto(opcoes)) throw new TypeError('x');
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && ['descritor', 'sistemaDeArquivos', 'limiteDeBytes', 'orcamento'].includes(k)) || !proprias.includes('descritor')) throw new TypeError('x');
    descritor = opcoes.descritor;
    if (!Number.isSafeInteger(descritor) || descritor < 3) throw new TypeError('x');
    if (proprias.includes('limiteDeBytes')) {
      if (!Number.isSafeInteger(opcoes.limiteDeBytes) || opcoes.limiteDeBytes <= 0) throw new TypeError('x');
      limiteDeBytes = opcoes.limiteDeBytes;
    }
    if (proprias.includes('orcamento')) {
      if (!ehOrcamentoDeBytes(opcoes.orcamento)) throw new TypeError('x');
      orcamento = opcoes.orcamento;
    }
    const sa = opcoes.sistemaDeArquivos;
    if (sa !== undefined && !(ehObjeto(sa) && ehFuncao(sa.escrever) && ehFuncao(sa.sincronizar))) throw new TypeError('x');
    escrever = sa === undefined ? fs.write : sa.escrever;
    sincronizar = sa === undefined ? fs.fsync : sa.sincronizar;
  } catch {
    throw new TypeError('opções da captura inválidas');
  }
  let usada = false;

  function consumir(entrada) {
    if (usada) throw new TypeError('captura já utilizada');
    usada = true;
    return new Promise((resolver) => {
      const estado = { recebidos: 0, gravados: 0, stderrBytes: 0, posicao: 0, destinoFalhou: false, fsync: false, motivoDaFalha: null };
      // Primeira falha vence e é PERMANENTE: depois dela nenhum pedaço é hasheado, contado ou gravado (o `Writable` só marca o erro no tick seguinte quando o callback falha de forma síncrona; sem esta trava um pedaço pequeno furaria a fila e o arquivo deixaria de ser um PREFIXO contíguo do fluxo)
      const registrarFalha = (motivo) => { estado.destinoFalhou = true; if (estado.motivoDaFalha === null) estado.motivoDaFalha = motivo; return new FalhaDeCaptura(estado.motivoDaFalha); };
      const hash = crypto.createHash('sha256');
      const diagnostico = criarDiagnosticoDoStderr();
      const concluir = (resultado) => resolver(Object.freeze({ ...resultado, bytesRecebidos: estado.recebidos, bytesGravados: estado.gravados, stderrBytes: estado.stderrBytes, diagnosticoDoStderr: diagnostico.resultado() }));
      const falhar = (motivo) => concluir({ ok: false, motivo });

      let stdout;
      let stderr;
      try {
        stdout = ehObjeto(entrada) ? entrada.stdout : undefined;
        stderr = ehObjeto(entrada) ? entrada.stderr : undefined;
      } catch {
        falhar('FLUXO_AUSENTE');
        return;
      }
      if (!ehLegivel(stdout)) { falhar('FLUXO_AUSENTE'); return; }
      // o stdout é BINÁRIO: com codificação definida os pedaços viriam como texto
      if (stdout.readableEncoding !== undefined && stdout.readableEncoding !== null) { falhar('FLUXO_NAO_BINARIO'); return; }
      if (ehObjeto(stderr) && ehFuncao(stderr.on)) {
        stderr.on('data', (bloco) => { estado.stderrBytes += Buffer.isBuffer(bloco) ? bloco.length : 0; diagnostico.consumir(bloco); });
        stderr.on('error', () => {});
      }

      const destino = new Writable({
        decodeStrings: false,
        write(pedaco, _codificacao, proximo) {
          if (estado.motivoDaFalha !== null) { proximo(new FalhaDeCaptura(estado.motivoDaFalha)); return; }
          if (!Buffer.isBuffer(pedaco)) { proximo(registrarFalha('FLUXO_NAO_BINARIO')); return; }
          // P4: o limite é conferido ANTES de hashear e gravar (sem estouro: compara com o saldo, nunca soma); o pedaço recusado não é contado
          if (limiteDeBytes !== null && pedaco.length > limiteDeBytes - estado.recebidos) { proximo(registrarFalha('LIMITE_EXCEDIDO')); return; }
          if (orcamento !== null && orcamento.reservar(pedaco.length).ok !== true) { proximo(registrarFalha('LIMITE_TOTAL_EXCEDIDO')); return; }
          hash.update(pedaco);
          estado.recebidos += pedaco.length;
          let deslocamento = 0;
          const passo = () => {
            if (deslocamento >= pedaco.length) { proximo(); return; }
            let chamado = false;
            const aoEscrever = (falha, n) => {
              if (chamado) return;
              chamado = true;
              if (falha) { proximo(registrarFalha(ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ERRO_DE_ESCRITA')); return; }
              if (!Number.isSafeInteger(n) || n <= 0 || n > pedaco.length - deslocamento) { proximo(registrarFalha('ESCRITA_INCOMPLETA')); return; }
              deslocamento += n;
              estado.posicao += n;
              estado.gravados += n;
              passo();
            };
            try {
              escrever(descritor, pedaco, deslocamento, pedaco.length - deslocamento, estado.posicao, aoEscrever);
            } catch {
              aoEscrever(new Error('x'));
            }
          };
          passo();
        },
        final(proximo) {
          let chamado = false;
          const aoSincronizar = (falha) => {
            if (chamado) return;
            chamado = true;
            if (falha) { proximo(registrarFalha(ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'FSYNC_FALHOU')); return; }
            estado.fsync = true;
            proximo();
          };
          try { sincronizar(descritor, aoSincronizar); } catch { aoSincronizar(new Error('x')); }
        },
      });

      pipeline(stdout, destino, (falha) => {
        if (falha) {
          if (falha instanceof FalhaDeCaptura) falhar(falha.motivoDaCaptura);
          else if (estado.destinoFalhou) falhar('ERRO_DE_ESCRITA');
          else if (falha.code === 'ERR_STREAM_PREMATURE_CLOSE') falhar('FECHAMENTO_PREMATURO');
          else falhar('ERRO_NO_FLUXO');
          return;
        }
        if (estado.recebidos === 0) { falhar('DUMP_VAZIO'); return; }
        if (estado.recebidos !== estado.gravados) { falhar('DIVERGENCIA_DE_BYTES'); return; }
        if (!estado.fsync) { falhar('FSYNC_FALHOU'); return; }
        concluir({
          ok: true,
          origem: 'STDOUT_DO_PG_DUMP',
          fimDoFluxo: 'STDOUT_ENCERRADO_NORMALMENTE',
          sha256FluxoRecebido: hash.digest('hex'),
          fsyncConcluido: true,
          atestaConteudoLogico: false,
        });
      });
    });
  }

  return Object.freeze({ consumir });
}

module.exports = { criarCapturaDoDump, MOTIVOS_DA_CAPTURA: MOTIVOS };
