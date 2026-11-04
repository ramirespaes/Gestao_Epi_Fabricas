'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): ESCRITORES EXTERNOS ao backup. Só LEITURA (lstat/readdir), sem criar, alterar ou remover nada, e sem nunca devolver caminho: só códigos e contagens.
 *
 * O QUE EXISTE (inspeção do código): (1) as remoções físicas do armazenamento de imagens (`remover`/`removerVariantes`) só agem com a posse CONFIRMADA da janela de LIMPEZA, mutuamente exclusiva com a de BACKUP (PRT-07); (2) `gravar` é ADITIVA (arquivo endereçado pelo conteúdo, criado com ligação exclusiva) e NÃO usa a janela:
 * durante um backup podem aparecer arquivos novos (inofensivos para a cópia do plano, mas detectáveis); (3) a janela é um arquivo LOCAL: não vale entre hospedeiros nem protege contra processo que não a respeite (outra aplicação, outra instância sem o protocolo, ferramenta administrativa, `rm`, o próprio usuário).
 * Uma trava em Node NÃO protege de quem não a respeita. A garantia contra escritores externos exige controle do sistema operacional / política do armazenamento (propriedade exclusiva do usuário do serviço, nenhum outro principal com escrita, ou armazenamento imutável durante a janela) e, na AWS, política do próprio serviço:
 * essa garantia NÃO é comprovável por código, então `GARANTIA_CONTRA_ESCRITORES_EXTERNOS` é sempre 'NAO_COMPROVADA' aqui, e `CONTROLES_EXTERNOS_APROVADOS` (declarações reconhecidas de controle externo) é uma lista fechada e VAZIA.
 *
 * O QUE ESTE MÓDULO FAZ: (a) `inspecionarArmazenamento`: confere propriedade (uids autorizados), ausência de escrita para grupo/outros, ausência de links simbólicos e de tipos especiais, com limite de entradas (acima dele o resultado é INCONCLUSIVO); (b) `fotografar`/`avaliarConsistencia`: impressão digital da árvore
 * (tamanho, inode, mtime) antes e depois do backup — remoção ou modificação concorrente invalida o backup; adição é permitida e sinalizada; fotografia incompleta é inconclusiva e também invalida. Detectar não é impedir: uma alteração que se desfaça entre as duas fotografias não é vista.
 */

const GARANTIA_CONTRA_ESCRITORES_EXTERNOS = 'NAO_COMPROVADA';
const CONTROLES_EXTERNOS_APROVADOS = Object.freeze([]);
const REQUISITOS_EXTERNOS = Object.freeze(['PROPRIEDADE_EXCLUSIVA_DO_USUARIO_DO_SERVICO', 'NENHUM_OUTRO_PRINCIPAL_COM_ESCRITA', 'ARMAZENAMENTO_IMUTAVEL_OU_BLOQUEADO_NA_JANELA', 'COORDENACAO_ENTRE_HOSPEDEIROS']);
const ESCRITORES_CONHECIDOS = Object.freeze({
  REMOCAO_DO_ARMAZENAMENTO: 'SOB_JANELA_DE_LIMPEZA',
  GRAVACAO_DO_ARMAZENAMENTO: 'ADITIVA_SEM_JANELA',
  PROCESSO_EXTERNO_OU_ADMINISTRADOR: 'NAO_CONTROLADO',
  OUTRA_INSTANCIA_OU_HOSPEDEIRO: 'JANELA_LOCAL_NAO_VALE_ENTRE_HOSPEDEIROS',
});
const LIMITE_PADRAO = 200000;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('configuração de escritores inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const raizValida = (p) => typeof p === 'string' && p.length > 1 && path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/') && !/\0/.test(p);

function percorrer(raiz, limite, visitar) {
  let entradas = 0;
  let completo = true;
  const pilha = [raiz];
  while (pilha.length > 0) {
    const dir = pilha.pop();
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch { visitar(dir, null, 'ILEGIVEL'); continue; }
    for (const nome of nomes) {
      if (entradas >= limite) { completo = false; return { entradas, completo }; }
      entradas += 1;
      const p = path.join(dir, nome);
      let st;
      try { st = fs.lstatSync(p); } catch { visitar(p, null, 'ILEGIVEL'); continue; }
      visitar(p, st, null);
      if (st.isDirectory()) pilha.push(p);
    }
  }
  return { entradas, completo };
}

/** Conformidade local do armazenamento protegido. `conforme` exige árvore completa e sem violações; mesmo `conforme` NÃO comprova exclusão contra escritores externos. */
function inspecionarArmazenamento(pedido) {
  if (!ehObjeto(pedido) || !Reflect.ownKeys(pedido).every((k) => ['raiz', 'uidsAutorizados', 'limite'].includes(k)) || !raizValida(pedido.raiz)) throw configuracaoInvalida();
  const { raiz, uidsAutorizados } = pedido;
  const limite = pedido.limite === undefined ? LIMITE_PADRAO : pedido.limite;
  if (!Array.isArray(uidsAutorizados) || uidsAutorizados.length === 0 || !uidsAutorizados.every((u) => Number.isSafeInteger(u) && u >= 0) || !Number.isSafeInteger(limite) || limite < 1) throw configuracaoInvalida();
  const violacoes = {};
  const marcar = (codigo) => { violacoes[codigo] = (violacoes[codigo] ?? 0) + 1; };
  let st;
  try { st = fs.lstatSync(raiz); } catch { return Object.freeze({ conforme: false, inconclusivo: true, violacoes: Object.freeze({ RAIZ_INACESSIVEL: 1 }), entradas: 0, garantiaContraEscritoresExternos: GARANTIA_CONTRA_ESCRITORES_EXTERNOS, requisitosExternos: REQUISITOS_EXTERNOS }); }
  if (st.isSymbolicLink()) marcar('LINK_SIMBOLICO');
  else if (!st.isDirectory()) marcar('RAIZ_NAO_E_DIRETORIO');
  const avaliar = (s) => {
    if (!uidsAutorizados.includes(s.uid)) marcar('DONO_NAO_AUTORIZADO');
    if ((s.mode & 0o022) !== 0) marcar('ESCRITA_PARA_GRUPO_OU_OUTROS');
  };
  avaliar(st);
  let resumo = { entradas: 0, completo: true };
  if (st.isDirectory()) {
    resumo = percorrer(raiz, limite, (p, s, falha) => {
      if (falha) { marcar('ENTRADA_ILEGIVEL'); return; }
      if (s.isSymbolicLink()) { marcar('LINK_SIMBOLICO'); return; }
      if (!s.isDirectory() && !s.isFile()) marcar('TIPO_ESPECIAL');
      avaliar(s);
    });
  }
  const inconclusivo = resumo.completo === false;
  const conforme = !inconclusivo && Object.keys(violacoes).length === 0;
  return Object.freeze({ conforme, inconclusivo, violacoes: Object.freeze({ ...violacoes }), entradas: resumo.entradas, garantiaContraEscritoresExternos: GARANTIA_CONTRA_ESCRITORES_EXTERNOS, requisitosExternos: REQUISITOS_EXTERNOS });
}

/** Impressão digital da árvore: caminho relativo -> { tamanho, inode, mtime }. Acima do limite a fotografia é marcada INCOMPLETA. */
function fotografar(pedido) {
  if (!ehObjeto(pedido) || !Reflect.ownKeys(pedido).every((k) => ['raiz', 'limite'].includes(k)) || !raizValida(pedido.raiz)) throw configuracaoInvalida();
  const limite = pedido.limite === undefined ? LIMITE_PADRAO : pedido.limite;
  if (!Number.isSafeInteger(limite) || limite < 1) throw configuracaoInvalida();
  const itens = new Map();
  let ilegiveis = 0;
  const resumo = percorrer(pedido.raiz, limite, (p, s, falha) => {
    if (falha || s === null) { ilegiveis += 1; return; }
    itens.set(path.relative(pedido.raiz, p), s.isDirectory() ? { d: true } : { tamanho: s.size, inode: s.ino, mtime: s.mtimeMs });
  });
  return Object.freeze({ itens, completa: resumo.completo && ilegiveis === 0, entradas: resumo.entradas });
}

function avaliarConsistencia(antes, depois) {
  const valida = (f) => ehObjeto(f) && f.itens instanceof Map && typeof f.completa === 'boolean';
  if (!valida(antes) || !valida(depois)) return Object.freeze({ consistente: false, motivo: 'FOTOGRAFIA_INVALIDA', adicionados: 0, removidos: 0, modificados: 0 });
  if (!antes.completa || !depois.completa) return Object.freeze({ consistente: false, motivo: 'FOTOGRAFIA_INCOMPLETA', adicionados: 0, removidos: 0, modificados: 0 });
  let adicionados = 0;
  let removidos = 0;
  let modificados = 0;
  for (const [k, v] of antes.itens) {
    const d = depois.itens.get(k);
    if (d === undefined) removidos += 1;
    else if (!v.d && (d.d || d.tamanho !== v.tamanho || d.inode !== v.inode || d.mtime !== v.mtime)) modificados += 1;
  }
  for (const k of depois.itens.keys()) if (!antes.itens.has(k)) adicionados += 1;
  const consistente = removidos === 0 && modificados === 0;
  return Object.freeze({ consistente, motivo: consistente ? (adicionados > 0 ? 'SOMENTE_ADICOES' : null) : 'ALTERACAO_CONCORRENTE', adicionados, removidos, modificados });
}

module.exports = { inspecionarArmazenamento, fotografar, avaliarConsistencia, GARANTIA_CONTRA_ESCRITORES_EXTERNOS, CONTROLES_EXTERNOS_APROVADOS, REQUISITOS_EXTERNOS, ESCRITORES_CONHECIDOS };
