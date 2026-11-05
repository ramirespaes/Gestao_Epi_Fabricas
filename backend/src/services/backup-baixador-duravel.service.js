'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { localizarArmazenamentoDuravel, ambienteDeTeste } = require('./imagem-backup-durabilidade.service');
const { identidadeConfere, AMBIENTES } = require('./backup-armazenamento-duravel-fichas.service');
const { consolidarRecibos } = require('./backup-recibo-duravel.service');
const { ehDestinoValidado, verificarNomeLivre, contem } = require('./imagem-backup-destinos.service');

/**
 * D-ORF-6, R-D45 (D-F4): BAIXADOR DE RESTAURAÇÃO POR VERSÃO EXPLÍCITA, VINCULADO ao registro oficial de destinos locais (`DESTINOS_AUTORIZADOS`, via o validador existente
 * `criarValidadorDeDestinos`). Baixa os objetos de UM conjunto lendo sempre a versão registrada no recibo (nunca "a versão atual" de um nome) e conferindo, objeto a objeto,
 * bytes e SHA-256 contra o recibo ANTES de publicar o arquivo. A decifragem (MAC do envelope antes de qualquer confiança) é do orquestrador, depois deste passo.
 *
 * DESTINO (seguro por construção): não existe caminho livre. O pedido informa `destinoLocalId`, `raiz` e `nome`; o validador oficial confere que a raiz é EXATAMENTE a
 * autorizada para o ambiente (caminho canônico, sem link em nenhum componente, diretório, mesma identidade dev/ino, dono = usuário do processo, sem acesso de grupo e outros,
 * leitura/escrita/travessia) e este módulo só cria `raiz/nome`: um filho NOVO e direto (nome livre por lstat, sem seguir link). A lista real está vazia: sem registro de teste
 * (NODE_ENV=test) nada é autorizado. Áreas protegidas informadas (`protegidos`) não podem coincidir, conter nem estar dentro da raiz. O validador é consultado de novo (físico, sem
 * cache) antes de criar o destino, de cada subpasta, de abrir cada temporário e de publicar cada arquivo; as pastas criadas aqui têm a identidade (dev/ino) registrada e conferida
 * (diretório real, sem link, do usuário do processo, caminho real igual ao caminho) a cada uso. Depois do `link`, o arquivo publicado tem de ser o mesmo i-node do temporário.
 * Limite honesto: Node não oferece operações relativas a descritor de diretório; entre a conferência e o uso resta uma janela mínima que só quem já escreve na raiz 0700 do mesmo
 * usuário (ou o administrador do sistema) consegue explorar. Um destino parcial, ou um temporário deixado numa pasta trocada, permanece para análise: a decisão de descartá-lo é humana.
 *
 * ESPAÇO E LIMITES, antes de qualquer criação: soma dos bytes dos recibos <= `limites.totalBytesMaximo` (obrigatório), número de arquivos <= `limites.arquivosMaximo` (padrão 400000)
 * e, no sistema de arquivos da raiz, espaço livre >= necessário + margem (o maior entre 10% do necessário e 64 MiB) e inodes livres >= (2 x arquivos + 1024). `reservarDecifra`
 * dobra a necessidade (a decifra grava uma segunda cópia). Falha ao medir é recusa. ENOSPC durante a gravação vira ESPACO_INSUFICIENTE.
 *
 * Porta da RESTAURAÇÃO (somente estas duas operações): `identidade() -> { contaId, arn }` (tem de ser a de restauração da ficha) e
 * `lerVersao({ bucket, donoEsperado, chave, versaoId }) -> { bytes, fluxo }` (`fluxo` é um iterável assíncrono de blocos; erro `code: 'NAO_ENCONTRADO'` = objeto ausente).
 *
 * ESCRITA LOCAL (única deste módulo; entrada própria na guarda P2): `mkdir` não recursivo 0700 do destino e das subpastas, cada arquivo em temporário exclusivo 0600 (O_EXCL, sem
 * seguir link) -> fsync -> conferência -> `link` ao nome final (nunca sobrescreve) -> remoção SÓ do próprio temporário (também em falha). Nada além disso é removido.
 * Códigos de falha: ENTRADA_INVALIDA, CONSOLIDADO_INVALIDO, DESTINO_DIVERGENTE, LIMITE_TOTAL_EXCEDIDO, LIMITE_DE_ARQUIVOS_EXCEDIDO, DESTINO_NAO_AUTORIZADO (e os motivos fixos do
 * validador), DESTINO_PROTEGIDO, DESTINO_EXISTENTE, DESTINO_INVALIDO, DESTINO_ALTERADO, ESPACO_INSUFICIENTE, INODES_INSUFICIENTES, ESPACO_INDETERMINADO, IDENTIDADE_DIVERGENTE,
 * FALHA_AO_CONSULTAR, OBJETO_AUSENTE, LEITURA_FALHOU, INTEGRIDADE_DIVERGENTE, NOME_FINAL_EXISTENTE, ESCRITA_FALHOU. Nunca ecoa texto de erro do cliente.
 */

const PRAZO_PADRAO_MS = 60000;
const PRAZO_MAXIMO_MS = 600000;
const LIMITE_ARQUIVOS = 400000;
const MARGEM_FRACAO = 0.1;
const MARGEM_MINIMA_BYTES = 64 * 1024 * 1024;
const FOLGA_DE_INODES = 1024;
const SEGMENTO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MOTIVO_FIXO = /^[A-Z][A-Z_]{2,39}$/;
const METODOS_DA_PORTA = Object.freeze(['identidade', 'lerVersao']);
const OPCOES = Object.freeze(['destinoId', 'ambiente', 'cliente', 'validadorDeDestinos', 'limites', 'protegidos', 'prazoMs', 'registro', 'portas']);
const PEDIDO_OBRIGATORIO = Object.freeze(['consolidado', 'destinoLocalId', 'raiz', 'nome']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do baixador inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const falha = (passo, codigo) => Object.freeze({ ok: false, falha: Object.freeze({ passo, codigo }) });
const sobrepoe = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

async function existe(caminho) {
  try { await fsp.lstat(caminho); return true; } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}
/** Cria `pai/nome` (novo, 0700, não recursivo) e devolve a identidade (dev/ino) do diretório criado, ou `null` se existia, foi trocado ou não é um diretório real. */
async function criarDiretorioNovo(pai, nome) {
  if (!SEGMENTO.test(nome)) return null;
  const alvo = path.join(pai, nome);
  try { await fsp.mkdir(alvo, { recursive: false, mode: 0o700 }); } catch { return null; }
  try {
    const st = await fsp.lstat(alvo);
    if (!st.isDirectory() || st.isSymbolicLink() || (await fsp.realpath(alvo)) !== alvo) return null;
    return { dev: st.dev, ino: st.ino };
  } catch { return null; }
}
async function removerTemporario(caminho) {
  try { await fsp.rm(caminho, { force: true }); } catch { /* o temporário próprio some quando possível */ }
}

function criarBaixadorDuravel(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !['destinoId', 'ambiente', 'cliente', 'validadorDeDestinos', 'limites'].every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida();
  const { destinoId, ambiente, cliente, validadorDeDestinos: validador, limites, registro } = opcoes;
  const prazoMs = opcoes.prazoMs === undefined ? PRAZO_PADRAO_MS : opcoes.prazoMs;
  const protegidos = opcoes.protegidos === undefined ? [] : opcoes.protegidos;
  if (typeof destinoId !== 'string' || !AMBIENTES.includes(ambiente)) throw configuracaoInvalida();
  if (!ehObjeto(cliente) || !METODOS_DA_PORTA.every((m) => typeof cliente[m] === 'function')) throw configuracaoInvalida();
  if (!ehObjeto(validador) || typeof validador.validar !== 'function' || validador.ambiente !== ambiente) throw configuracaoInvalida();
  if (!Number.isSafeInteger(prazoMs) || prazoMs < 1 || prazoMs > PRAZO_MAXIMO_MS) throw configuracaoInvalida();
  if (!ehObjeto(limites) || !Reflect.ownKeys(limites).every((k) => ['totalBytesMaximo', 'arquivosMaximo'].includes(k)) || !Number.isSafeInteger(limites.totalBytesMaximo) || limites.totalBytesMaximo < 1) throw configuracaoInvalida();
  if (limites.arquivosMaximo !== undefined && (!Number.isSafeInteger(limites.arquivosMaximo) || limites.arquivosMaximo < 1 || limites.arquivosMaximo > LIMITE_ARQUIVOS)) throw configuracaoInvalida();
  if (!Array.isArray(protegidos) || protegidos.length > 64 || !protegidos.every(caminhoCanonico)) throw configuracaoInvalida();
  const porta = opcoes.portas;
  if (porta !== undefined && (!ambienteDeTeste() || !ehObjeto(porta) || !chavesExatas(porta, ['statfs']) || typeof porta.statfs !== 'function')) throw configuracaoInvalida();
  const statfs = porta === undefined ? (c) => fsp.statfs(c) : porta.statfs;
  const arquivosMaximo = limites.arquivosMaximo === undefined ? LIMITE_ARQUIVOS : limites.arquivosMaximo;
  const totalMaximo = limites.totalBytesMaximo;
  const achado = localizarArmazenamentoDuravel(destinoId, ambiente, registro);
  if (!achado.encontrada) throw Object.assign(new Error('destino durável não autorizado'), { code: 'DESTINO_DURAVEL_NAO_AUTORIZADO', motivo: achado.motivo });
  const { ficha, origem } = achado;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  const comPrazo = (executar) => new Promise((resolver, rejeitar) => {
    const timer = setTimeout(() => rejeitar(Object.assign(new Error('prazo'), { code: 'PRAZO' })), prazoMs);
    Promise.resolve().then(executar).then((v) => { clearTimeout(timer); resolver(v); }, (e) => { clearTimeout(timer); rejeitar(e); });
  });

  /** Valida o destino local no registro OFICIAL (físico, sem cache). Devolve `{ validacao }` ou `{ erro }`; nunca repassa texto livre. */
  function validarRaiz(destinoLocalId, raiz) {
    let v;
    try { v = validador.validar({ destinoId: destinoLocalId, raiz }); } catch { return { erro: falha('DESTINO', 'DESTINO_NAO_AUTORIZADO') }; }
    if (!ehObjeto(v)) return { erro: falha('DESTINO', 'DESTINO_NAO_AUTORIZADO') };
    if (v.autorizado !== true) return { erro: falha('DESTINO', typeof v.motivo === 'string' && MOTIVO_FIXO.test(v.motivo) ? v.motivo : 'DESTINO_NAO_AUTORIZADO') };
    if (!ehDestinoValidado(v) || v.ambiente !== ficha.ambiente || v.raiz !== raiz) return { erro: falha('DESTINO', 'DESTINO_NAO_AUTORIZADO') };
    return { validacao: v };
  }

  async function raizProtegida(raiz) {
    for (const p of protegidos) {
      const candidatos = [p];
      try { candidatos.push(await fsp.realpath(p)); } catch { /* inexistente: vale o caminho informado */ }
      if (candidatos.some((c) => sobrepoe(raiz, c))) return true;
    }
    return false;
  }

  /** Autoriza `raiz/nome` como destino NOVO (filho direto de uma raiz autorizada, nome livre, fora das áreas protegidas). Não cria nada. */
  async function resolverDestino(destinoLocalId, raiz, nome) {
    const r = validarRaiz(destinoLocalId, raiz);
    if (r.erro !== undefined) return r;
    if (await raizProtegida(raiz)) return { erro: falha('DESTINO', 'DESTINO_PROTEGIDO') };
    const livre = verificarNomeLivre(r.validacao, nome);
    if (!livre.livre) return { erro: livre.motivo === 'NOME_EM_USO' ? falha('DESTINO', 'DESTINO_EXISTENTE') : livre.motivo === 'NOME_INVALIDO' ? falha('ENTRADA', 'ENTRADA_INVALIDA') : falha('DESTINO', 'DESTINO_INVALIDO') };
    const caminho = path.join(raiz, nome);
    if (!contem(r.validacao, caminho)) return { erro: falha('DESTINO', 'DESTINO_NAO_AUTORIZADO') };
    return { validacao: r.validacao, caminho };
  }

  /** Contenção durante a operação: raiz ainda autorizada (identidade, dono, modo, sem link) e cada pasta criada aqui, de `dir` até o destino, ainda é o mesmo diretório real. */
  async function manterContencao(ctx, dir) {
    const r = validarRaiz(ctx.destinoLocalId, ctx.raiz);
    if (r.erro !== undefined) return false;
    if (dir === null) return true;
    if (!contem(r.validacao, dir)) return false;
    try {
      for (let atual = dir; ; atual = path.dirname(atual)) {
        const esperado = ctx.identidades.get(atual);
        if (esperado === undefined) return false;
        const st = await fsp.lstat(atual);
        if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== esperado.dev || st.ino !== esperado.ino || (uid !== null && st.uid !== uid)) return false;
        if ((await fsp.realpath(atual)) !== atual) return false;
        if (atual === ctx.destino) return true;
      }
    } catch { return false; }
  }

  async function publicadoNoLugar(final, temporario) {
    try {
      const st = await fsp.lstat(final);
      return st.isFile() && !st.isSymbolicLink() && st.dev === temporario.dev && st.ino === temporario.ino && (await fsp.realpath(final)) === final;
    } catch { return false; }
  }

  async function conferirEspaco(raiz, arquivos, total, reservarDecifra) {
    const copias = reservarDecifra ? 2 : 1;
    const necessario = total * copias;
    const margem = Math.max(Math.ceil(necessario * MARGEM_FRACAO), MARGEM_MINIMA_BYTES);
    let st;
    try { st = await statfs(raiz); } catch { return 'ESPACO_INDETERMINADO'; }
    if (!ehObjeto(st)) return 'ESPACO_INDETERMINADO';
    const livre = Number(st.bavail) * Number(st.bsize);
    if (!Number.isSafeInteger(livre) || livre < 0) return 'ESPACO_INDETERMINADO';
    if (livre < necessario + margem) return 'ESPACO_INSUFICIENTE';
    const arquivosDoSistema = Number(st.files);
    const livres = Number(st.ffree);
    if (Number.isFinite(arquivosDoSistema) && arquivosDoSistema > 0 && Number.isFinite(livres) && livres < (arquivos * 2 + FOLGA_DE_INODES) * copias) return 'INODES_INSUFICIENTES';
    return null;
  }

  /** Baixa UM objeto por versão para `dir/arquivo`. Devolve `null` se publicado, ou o código da falha. */
  async function baixarUm(ctx, recibo, dir, arquivo) {
    const final = path.join(dir, arquivo);
    let leitura;
    try {
      leitura = await comPrazo(() => cliente.lerVersao({ bucket: ficha.bucket, donoEsperado: ficha.contaId, chave: recibo.chave, versaoId: recibo.versaoId }));
    } catch (e) { return e !== null && typeof e === 'object' && e.code === 'NAO_ENCONTRADO' ? 'OBJETO_AUSENTE' : 'LEITURA_FALHOU'; }
    if (!ehObjeto(leitura) || !Number.isSafeInteger(leitura.bytes) || leitura.fluxo === null || typeof leitura.fluxo !== 'object' || typeof leitura.fluxo[Symbol.asyncIterator] !== 'function') return 'LEITURA_FALHOU';
    if (leitura.bytes !== recibo.bytes) return 'INTEGRIDADE_DIVERGENTE';
    if (!(await manterContencao(ctx, dir))) return 'DESTINO_ALTERADO';
    try { if (await existe(final)) return 'NOME_FINAL_EXISTENTE'; } catch { return 'DESTINO_ALTERADO'; }
    const temporario = `${final}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const iterador = leitura.fluxo[Symbol.asyncIterator]();
    let fh = null;
    let criado = false;
    let fase = 'ESCRITA';
    try {
      fh = await fsp.open(temporario, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      criado = true;
      const aberto = await fh.stat();
      const hash = crypto.createHash('sha256');
      let total = 0;
      for (;;) {
        fase = 'LEITURA';
        const passo = await comPrazo(() => iterador.next());
        fase = 'ESCRITA';
        if (passo.done) break;
        const bloco = Buffer.from(passo.value);
        total += bloco.length;
        if (total > recibo.bytes) return 'INTEGRIDADE_DIVERGENTE';
        hash.update(bloco);
        let gravado = 0;
        while (gravado < bloco.length) gravado += (await fh.write(bloco, gravado, bloco.length - gravado)).bytesWritten;
      }
      if (total !== recibo.bytes || hash.digest('hex') !== recibo.sha256) return 'INTEGRIDADE_DIVERGENTE';
      await fh.sync();
      await fh.close();
      fh = null;
      if (!(await manterContencao(ctx, dir))) return 'DESTINO_ALTERADO';
      fase = 'PUBLICACAO';
      await fsp.link(temporario, final);
      return (await publicadoNoLugar(final, aberto)) ? null : 'DESTINO_ALTERADO';
    } catch (e) {
      const codigo = e !== null && typeof e === 'object' ? e.code : undefined;
      if (fase === 'LEITURA') return 'LEITURA_FALHOU';
      if (fase === 'PUBLICACAO' && codigo === 'EEXIST') return 'NOME_FINAL_EXISTENTE';
      return codigo === 'ENOSPC' ? 'ESPACO_INSUFICIENTE' : 'ESCRITA_FALHOU';
    } finally {
      if (fh !== null) await fh.close().catch(() => {});
      Promise.resolve(typeof iterador.return === 'function' ? iterador.return() : undefined).catch(() => {});
      if (criado) await removerTemporario(temporario);
    }
  }

  async function baixar(entrada) {
    if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => [...PEDIDO_OBRIGATORIO, 'reservarDecifra'].includes(k)) || !PEDIDO_OBRIGATORIO.every((k) => Reflect.ownKeys(entrada).includes(k))) return falha('ENTRADA', 'ENTRADA_INVALIDA');
    const { consolidado, destinoLocalId, raiz, nome, reservarDecifra } = entrada;
    if (!ehObjeto(consolidado) || typeof destinoLocalId !== 'string' || !caminhoCanonico(raiz) || typeof nome !== 'string' || !NOME.test(nome) || (reservarDecifra !== undefined && typeof reservarDecifra !== 'boolean')) return falha('ENTRADA', 'ENTRADA_INVALIDA');
    const lido = consolidarRecibos({ destinoId: consolidado.destinoId, ambiente: consolidado.ambiente, conjuntoId: consolidado.conjuntoId, recibos: Array.isArray(consolidado.recibos) ? [...consolidado.recibos] : consolidado.recibos });
    if (!lido.ok) return falha('ENTRADA', 'CONSOLIDADO_INVALIDO');
    const { conjuntoId, recibos } = lido.consolidado;
    if (lido.consolidado.destinoId !== ficha.id || lido.consolidado.ambiente !== ficha.ambiente || recibos.some((r) => r.bucket !== ficha.bucket)) return falha('ENTRADA', 'DESTINO_DIVERGENTE');
    const total = recibos.reduce((soma, r) => soma + r.bytes, 0);
    if (!Number.isSafeInteger(total) || total > totalMaximo) return falha('LIMITE', 'LIMITE_TOTAL_EXCEDIDO');
    if (recibos.length > arquivosMaximo) return falha('LIMITE', 'LIMITE_DE_ARQUIVOS_EXCEDIDO');

    const alvo = await resolverDestino(destinoLocalId, raiz, nome);
    if (alvo.erro !== undefined) return alvo.erro;
    const espaco = await conferirEspaco(raiz, recibos.length, total, reservarDecifra === true);
    if (espaco !== null) return falha('ESPACO', espaco);

    let identidade;
    try { identidade = await comPrazo(() => cliente.identidade()); } catch { return falha('IDENTIDADE', 'FALHA_AO_CONSULTAR'); }
    if (!ehObjeto(identidade)) return falha('IDENTIDADE', 'FALHA_AO_CONSULTAR');
    if (!identidadeConfere(ficha.identidades.restauracao, identidade)) return falha('IDENTIDADE', 'IDENTIDADE_DIVERGENTE');

    const ctx = { destinoLocalId, raiz, destino: alvo.caminho, identidades: new Map() };
    if (!(await manterContencao(ctx, null))) return falha('DESTINO', 'DESTINO_ALTERADO');
    const criado = await criarDiretorioNovo(raiz, nome);
    if (criado === null) return falha('DESTINO', 'DESTINO_EXISTENTE');
    ctx.identidades.set(alvo.caminho, criado);

    const prefixoDoConjunto = `${ficha.prefixo}${conjuntoId}/`;
    for (const r of recibos) {
      const segmentos = r.chave.slice(prefixoDoConjunto.length).split('/');
      let atual = alvo.caminho;
      for (const s of segmentos.slice(0, -1)) {
        const proximo = path.join(atual, s);
        if (!ctx.identidades.has(proximo)) {
          if (!(await manterContencao(ctx, atual))) return falha('DESTINO', 'DESTINO_ALTERADO');
          const identidadeDaPasta = await criarDiretorioNovo(atual, s);
          if (identidadeDaPasta === null) return falha('DESTINO', 'DESTINO_ALTERADO');
          ctx.identidades.set(proximo, identidadeDaPasta);
        }
        atual = proximo;
      }
      const codigo = await baixarUm(ctx, r, atual, segmentos[segmentos.length - 1]);
      if (codigo !== null) return falha('BAIXAR', codigo);
    }
    return Object.freeze({ ok: true, destino: alvo.caminho, arquivos: recibos.length, bytes: total, origemDoDestino: alvo.validacao.origem });
  }

  /** Autoriza (sem criar) um SEGUNDO destino novo, irmão do primeiro, para a decifra: mesmas regras de raiz autorizada, nome livre e área protegida. */
  async function autorizarNovoDestino(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['destinoLocalId', 'raiz', 'nome']) || typeof entrada.destinoLocalId !== 'string' || !caminhoCanonico(entrada.raiz) || typeof entrada.nome !== 'string' || !NOME.test(entrada.nome)) return falha('ENTRADA', 'ENTRADA_INVALIDA');
    const alvo = await resolverDestino(entrada.destinoLocalId, entrada.raiz, entrada.nome);
    if (alvo.erro !== undefined) return alvo.erro;
    return Object.freeze({ ok: true, caminho: alvo.caminho, origemDoDestino: alvo.validacao.origem });
  }

  return Object.freeze({ destino: Object.freeze({ id: ficha.id, ambiente: ficha.ambiente, bucket: ficha.bucket, regiao: ficha.regiao, origem }), baixar, autorizarNovoDestino });
}

module.exports = { criarBaixadorDuravel, METODOS_DA_PORTA };
