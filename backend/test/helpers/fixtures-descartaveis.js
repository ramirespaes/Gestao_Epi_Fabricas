'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Gerenciador de fixtures DESCARTÁVEIS dos testes (diretórios temporários), por IDENTIDADE e não por prefixo. O prefixo só dá nome legível ao diretório: nunca prova propriedade.
 *
 * Na criação (ou adoção) de um diretório o gerenciador abre um DESCRITOR (O_RDONLY | O_DIRECTORY | O_NOFOLLOW), confere que ele é o mesmo objeto que o `lstat` do caminho (dev/ino), que é diretório, do usuário do processo e que está
 * DIRETO em tmp, e guarda o descritor. Toda mudança de permissão usa `fchmod` nesse descritor — nunca `chmod` por caminho, que seguiria um link simbólico posto no lugar do diretório. Antes de remover, o gerenciador reconfere
 * (caminho ainda é o mesmo diretório, não é link, mesmo dono, descritor aponta para o mesmo objeto); qualquer divergência FALHA FECHADO: nada é alterado nem removido. Ninguém remove por glob, varredura ou prefixo.
 *
 * LIMITE HONESTO: o Node não tem `unlinkat`/`openat`; entre a última conferência e o `rmSync` há uma janela mínima em que um processo com escrita no tmp do usuário poderia trocar o diretório. Em macOS o tmp é por usuário (0700) e em
 * Linux o /tmp tem sticky bit, que impede trocar entradas alheias; o risco residual é aceito e declarado, e a janela é reduzida a uma reconferência imediatamente antes da remoção.
 */

const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = fs.constants;

function criarGerenciadorDeFixtures({ prefixo }) {
  if (typeof prefixo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,40}$/.test(prefixo)) throw new TypeError('prefixo inválido');
  const tmp = fs.realpathSync(os.tmpdir());
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const entradas = [];

  const identico = (a, b) => a.dev === b.dev && a.ino === b.ino;
  /** null = pode agir; senão o motivo (nada é alterado). */
  function motivoDeRecusa(e) {
    let st;
    try { st = fs.lstatSync(e.caminho); } catch (falha) { return falha && falha.code === 'ENOENT' ? 'AUSENTE' : 'ILEGIVEL'; }
    if (path.dirname(e.caminho) !== tmp) return 'FORA_DA_RAIZ';
    if (st.isSymbolicLink()) return 'LINK_SIMBOLICO';
    if (!st.isDirectory()) return 'NAO_E_DIRETORIO';
    if (!identico(st, e)) return 'IDENTIDADE_DIVERGENTE';
    if (uid !== null && st.uid !== uid) return 'DONO_DIVERGENTE';
    let porDescritor;
    try { porDescritor = fs.fstatSync(e.fd); } catch { return 'DESCRITOR_INVALIDO'; }
    if (!identico(porDescritor, e)) return 'DESCRITOR_DIVERGENTE';
    return null;
  }

  function adotar(caminho) {
    if (typeof caminho !== 'string' || !path.isAbsolute(caminho) || path.normalize(caminho) !== caminho || path.dirname(caminho) !== tmp) throw new Error('fixture fora da raiz permitida');
    const st = fs.lstatSync(caminho);
    if (st.isSymbolicLink() || !st.isDirectory() || (uid !== null && st.uid !== uid)) throw new Error('fixture não é um diretório próprio');
    const fd = fs.openSync(caminho, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const porDescritor = fs.fstatSync(fd);
    if (!identico(porDescritor, st)) { fs.closeSync(fd); throw new Error('identidade da fixture divergente'); }
    entradas.push({ caminho, dev: porDescritor.dev, ino: porDescritor.ino, fd });
    return caminho;
  }
  const localizar = (caminho) => {
    const e = entradas.find((x) => x.caminho === caminho);
    if (e === undefined) throw new Error('caminho não registrado');
    return e;
  };

  return Object.freeze({
    /** Cria um diretório novo (mkdtemp) e o registra por identidade. O modo 0700 é garantido por `fchmod` no descritor. */
    criar() {
      const caminho = fs.realpathSync(fs.mkdtempSync(path.join(tmp, prefixo)));
      adotar(caminho);
      fs.fchmodSync(localizar(caminho).fd, 0o700);
      return caminho;
    },
    adotar,
    /** O diretório registrado foi renomeado pelo próprio teste: confere que o novo caminho é o MESMO objeto e atualiza o registro. */
    renomeado(antigo, novo) {
      const e = localizar(antigo);
      if (path.dirname(novo) !== tmp) throw new Error('novo caminho fora da raiz permitida');
      const st = fs.lstatSync(novo);
      if (st.isSymbolicLink() || !st.isDirectory() || !identico(st, e)) throw new Error('o novo caminho não é o diretório registrado');
      e.caminho = novo;
      return novo;
    },
    /** Muda o modo do diretório REGISTRADO por `fchmod` no descritor guardado (nunca por caminho). Recusa se o caminho deixou de ser o mesmo objeto. */
    chmod(caminho, modo) {
      const e = localizar(caminho);
      const motivo = motivoDeRecusa(e);
      if (motivo !== null) throw new Error(`chmod recusado: ${motivo}`);
      fs.fchmodSync(e.fd, modo);
    },
    /** Remove só o que continua sendo o mesmo diretório. Devolve o que foi removido e o que foi ignorado (com o motivo). */
    remover() {
      const removidas = [];
      const ignoradas = [];
      for (const e of entradas.splice(0)) {
        const motivo = motivoDeRecusa(e);
        if (motivo === 'AUSENTE') { try { fs.closeSync(e.fd); } catch { /* já fechado */ } continue; }
        if (motivo !== null) { ignoradas.push({ caminho: e.caminho, motivo }); try { fs.closeSync(e.fd); } catch { /* já fechado */ } continue; }
        try {
          fs.fchmodSync(e.fd, 0o700); // por descritor: permite remover um diretório que o teste deixou restrito, sem seguir link
          if (motivoDeRecusa(e) !== null) { ignoradas.push({ caminho: e.caminho, motivo: 'MUDOU_ANTES_DE_REMOVER' }); continue; }
          fs.rmSync(e.caminho, { recursive: true, force: true });
          removidas.push(e.caminho);
        } catch {
          ignoradas.push({ caminho: e.caminho, motivo: 'ERRO_AO_REMOVER' });
        } finally {
          try { fs.closeSync(e.fd); } catch { /* já fechado */ }
        }
      }
      return Object.freeze({ removidas, ignoradas });
    },
  });
}

module.exports = { criarGerenciadorDeFixtures };
