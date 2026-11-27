'use strict';
// Executor das ações do agente do backend com prazo efetivo (3B-2B-3A): dependências, reinício e identificação do
// processo. O agente não executa processos por conta própria; usa só este módulo.
//
// Cada comando roda sem shell, num grupo de processos próprio (o filho é líder do grupo). Vencido o prazo, o GRUPO é
// encerrado: SIGTERM, espera, SIGKILL, espera. O envio de um sinal não prova nada: o fim é conferido perguntando ao
// sistema se o grupo ainda existe (sinal 0). Só o grupo do próprio filho é sinalizado, e nunca um identificador menor
// ou igual a 1. Enquanto o grupo existir, o identificador dele não pode ser reutilizado; depois de visto vazio, ele não
// é mais sinalizado.
//
// Resultados: a saída padrão (sucesso) ou um erro com código:
//   PRAZO_INVALIDO               nada foi iniciado;
//   ACAO_NAO_INICIOU             o comando não chegou a existir;
//   ACAO_FALHOU                  terminou com erro, sem descendentes;
//   ACAO_DEIXOU_DESCENDENTES     terminou deixando processos no grupo, que foram encerrados: a ação não vale;
//   PRAZO_DA_ACAO_EXCEDIDO       o prazo venceu e o grupo inteiro foi encerrado, com o fim conferido;
//   SAIDA_EXCEDIDA               saída grande demais; o grupo foi encerrado;
//   ENCERRAMENTO_DA_ACAO_INCERTO o fim do grupo (ou dos canais de saída) não pôde ser conferido: há risco de processo vivo.
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIMITE_DE_SAIDA = 16 * 1024 * 1024;
const GRACA_MS = 2000;
const INTERVALO_DE_CONFERENCIA_MS = 25;

const falha = (codigo, mensagem) => Object.assign(new Error(mensagem || codigo), { codigo });
const agoraMs = () => Number(process.hrtime.bigint() / 1000000n);

function executarComPrazo(comando, args, { cwd, prazoMs, gracaMs = GRACA_MS, env = process.env, sinalizar = process.kill } = {}) {
  return new Promise((resolver, rejeitar) => {
    if (!Number.isInteger(prazoMs) || prazoMs < 1 || !Number.isInteger(gracaMs) || gracaMs < 1) { rejeitar(falha('PRAZO_INVALIDO')); return; }
    let filho;
    try {
      filho = spawn(comando, args, { cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      rejeitar(falha('ACAO_NAO_INICIOU', `${path.basename(String(comando))} não iniciou: ${e.code || e.message}`));
      return;
    }
    const grupo = Number.isInteger(filho.pid) && filho.pid > 1 ? filho.pid : null;
    let grupoVazio = false;
    // Existe enquanto houver qualquer membro. EPERM também conta como existente: não se afirma o fim sem certeza.
    const grupoExiste = () => {
      if (grupo === null || grupoVazio) return false;
      try { sinalizar(-grupo, 0); return true; } catch (e) { if (e.code === 'ESRCH') { grupoVazio = true; return false; } return true; }
    };
    const sinalizarGrupo = (sinal) => { if (grupoExiste()) { try { sinalizar(-grupo, sinal); } catch { /* conferido abaixo */ } } };
    const esperarGrupoVazio = (ms) => new Promise((pronto) => {
      const limite = agoraMs() + ms;
      const conferir = () => {
        if (!grupoExiste()) { pronto(true); return; }
        if (agoraMs() >= limite) { pronto(false); return; }
        setTimeout(conferir, INTERVALO_DE_CONFERENCIA_MS);
      };
      conferir();
    });
    let encerramento = null;
    const encerrarGrupo = () => {
      if (!encerramento) {
        encerramento = (async () => {
          if (!grupoExiste()) return true;
          sinalizarGrupo('SIGTERM');
          if (await esperarGrupoVazio(gracaMs)) return true;
          sinalizarGrupo('SIGKILL');
          return esperarGrupoVazio(gracaMs);
        })();
      }
      return encerramento;
    };

    const saida = [];
    let tamanho = 0;
    let erroTexto = '';
    let interrupcao = null; // 'PRAZO' | 'SAIDA'
    let fechado = false;
    let concluido = false;
    const aoFechar = [];
    const concluir = (erro, valor) => {
      if (concluido) return;
      concluido = true;
      clearTimeout(relogio);
      if (erro) rejeitar(erro); else resolver(valor);
    };
    const interromper = (motivo) => {
      if (interrupcao) return;
      interrupcao = motivo;
      encerrarGrupo().then((conferido) => { if (!conferido) concluir(falha('ENCERRAMENTO_DA_ACAO_INCERTO', `o grupo de ${path.basename(comando)} não pôde ser dado como encerrado`)); });
    };
    const relogio = setTimeout(() => interromper('PRAZO'), prazoMs);
    const esperarFechamento = (ms) => new Promise((pronto) => {
      if (fechado) { pronto(true); return; }
      const t = setTimeout(() => pronto(false), ms);
      aoFechar.push(() => { clearTimeout(t); pronto(true); });
    });

    filho.stdout.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > LIMITE_DE_SAIDA) interromper('SAIDA'); else saida.push(parte);
    });
    filho.stderr.on('data', (parte) => { erroTexto = (erroTexto + parte.toString()).slice(-2000); });
    filho.on('close', () => { fechado = true; for (const cb of aoFechar.splice(0)) cb(); });
    filho.on('error', (e) => {
      if (filho.pid === undefined) concluir(falha('ACAO_NAO_INICIOU', `${path.basename(String(comando))} não iniciou: ${e.code || e.message}`));
    });
    filho.once('exit', async (codigo) => {
      clearTimeout(relogio);
      const restavam = grupoExiste();
      const conferido = await encerrarGrupo();
      // Um descendente que saiu do grupo pode segurar os canais: sem fechamento no prazo, o fim não é afirmado.
      const canaisFechados = await esperarFechamento(gracaMs);
      if (!canaisFechados) { filho.stdout.destroy(); filho.stderr.destroy(); }
      if (!conferido || !canaisFechados) { concluir(falha('ENCERRAMENTO_DA_ACAO_INCERTO', `o fim de ${path.basename(comando)} não pôde ser conferido`)); return; }
      if (interrupcao === 'PRAZO') { concluir(falha('PRAZO_DA_ACAO_EXCEDIDO', `${path.basename(comando)} excedeu ${prazoMs} ms e foi encerrado`)); return; }
      if (interrupcao === 'SAIDA') { concluir(falha('SAIDA_EXCEDIDA', `${path.basename(comando)} produziu saída demais e foi encerrado`)); return; }
      if (restavam) { concluir(falha('ACAO_DEIXOU_DESCENDENTES', `${path.basename(comando)} terminou deixando processos, que foram encerrados`)); return; }
      if (codigo !== 0) { concluir(falha('ACAO_FALHOU', `${path.basename(comando)} saiu com erro: ${erroTexto.slice(0, 300)}`)); return; }
      concluir(null, Buffer.concat(saida).toString());
    });
  });
}

module.exports = { executarComPrazo, LIMITE_DE_SAIDA, GRACA_MS };
