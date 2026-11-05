'use strict';

const fs = require('node:fs');
const { hostSintaticamenteValido } = require('./imagem-backup-host-postgres');
const { PROVEDORES_OPERACIONAIS_APROVADOS } = require('./imagem-backup-manifesto-autenticado.service');
const { PROVEDORES_DE_CIFRA_APROVADOS } = require('./backup-fontes-cifra-envelope.service');
const { ARMAZENAMENTOS_DURAVEIS_APROVADOS } = require('./imagem-backup-durabilidade.service');
const { DESTINOS_AUTORIZADOS } = require('./imagem-backup-destinos.service');
const { avaliarProntidaoCriptografica } = require('./backup-fontes-custodia-chaves.service');

/**
 * D-ORF-6, G-A: DIAGNÓSTICO do ambiente do backup (modo `verificar`), SOMENTE LEITURA.
 *
 * Responde, item a item, se o ambiente atende o que o backup e a restauração de produção exigem: diretórios, permissões, dispositivo,
 * trava de janela (I5), binários e arquivo de senha do PostgreSQL, limites e espaço. Segue as MESMAS regras de `verificarDependencias`
 * da composição de produção (binários regulares e executáveis sem executá-los; arquivo de senha regular, sem link, 0600 e do usuário do
 * processo; diretórios reais, canônicos e do usuário do processo) e acrescenta as exigências do plano de HML (modo 0700, mesmo dispositivo,
 * separação entre origens, backup e código).
 *
 * Por que não instancia `criarBackupDeProducao`: a composição só se constrói com uma fonte de chaves RECONHECIDA, e a única que existe é a de
 * TESTE_CONTROLADO, que só nasce com NODE_ENV=test; as fontes operacionais estão bloqueadas por desenho. Forçar NODE_ENV para construí-la
 * seria burlar essa proteção. As pendências de chaves, destinos e custódia são portanto REPORTADAS aqui, a partir das mesmas listas e do
 * mesmo avaliador que o código de produção consulta, e nunca simuladas.
 *
 * NADA É CRIADO, GRAVADO, CONECTADO OU EXECUTADO: só `lstat`, `stat`, `access`, `realpath` e `statfs` injetáveis, e funções de leitura da
 * trava recebidas por injeção (o validador da janela fica no script, fora de src/, onde a guarda PRT-07 o permite). Valores de variáveis nunca
 * são devolvidos: só caminhos de diretório, códigos e números. `prontidaoOperacional` é SEMPRE falso neste modo.
 */

const ESTADOS = Object.freeze({ OK: 'OK', PENDENTE: 'PENDENTE', FALHA: 'FALHA' });
const GRUPOS = Object.freeze({ INFRAESTRUTURA: 'INFRAESTRUTURA', JANELA: 'JANELA', POSTGRES: 'POSTGRES', LIMITES: 'LIMITES', OPERACIONAL: 'OPERACIONAL' });
const VARIAVEIS = Object.freeze({
  imagens: 'IMAGENS_ARMAZENAMENTO_DIRETORIO',
  fiscalizacao: 'FISCALIZACAO_ARMAZENAMENTO_DIRETORIO',
  raizBackup: 'BACKUP_RAIZ',
  binariosPg: 'BACKUP_PG_BINARIOS',
  hostPg: 'BACKUP_PG_HOST',
  portaPg: 'BACKUP_PG_PORTA',
  usuarioPg: 'BACKUP_PG_USUARIO',
  bancoPg: 'BACKUP_PG_BANCO',
  senhaPg: 'PGPASSFILE',
  limiteDump: 'BACKUP_LIMITE_DUMP_BYTES',
  limiteTotal: 'BACKUP_LIMITE_TOTAL_BYTES',
  limiteLivre: 'BACKUP_LIMITE_LIVRE_BYTES',
});
const BINARIOS_PADRAO = '/usr/lib/postgresql/16/bin';
const SUBDIRETORIOS = Object.freeze([
  ['PREPARACOES', 'preparacoes'], ['DUMPS', 'dumps'], ['PUBLICADOS', 'publicados'],
  ['CONTROLE', 'controle'], ['CONTROLE_JANELA', 'controle/janela'], ['CONTROLE_DIARIO', 'controle/diario'], ['CONTROLE_REGISTROS', 'controle/registros'],
]);

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const USUARIO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const NOME_DE_BANCO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const INTEIRO = /^[1-9][0-9]{0,15}$/;
const TIPO_DA_JANELA = /^[A-Z_]{1,24}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const caminhoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const dentroDe = (filho, pai) => filho === pai || filho.startsWith(`${pai}/`);
const item = (id, grupo, estado, codigo, detalhe) => Object.freeze({ id, grupo, estado, codigo, ...(detalhe === undefined ? {} : { detalhe: Object.freeze(detalhe) }) });
const octal = (modo) => (modo & 0o777).toString(8).padStart(3, '0');

/** { ausente: true } | { invalida: true } | { valor }. Nunca devolve o valor de uma variável inválida. */
function variavel(ambiente, nome) {
  const bruto = ambiente[nome];
  if (bruto === undefined || bruto === null || bruto === '') return { ausente: true };
  if (typeof bruto !== 'string' || bruto.includes('\0')) return { invalida: true };
  return { valor: bruto };
}

/** `estadoSeInexistente`: PENDENTE para o que ainda será criado (árvore do backup); FALHA para o que já deveria existir (origens). */
function examinarDiretorio(portas, caminho, uid, estadoSeInexistente) {
  if (!caminhoCanonico(caminho)) return { estado: ESTADOS.FALHA, codigo: 'CAMINHO_NAO_CANONICO' };
  let e;
  try { e = portas.lstat(caminho); } catch (erro) {
    return erro && erro.code === 'ENOENT' ? { estado: estadoSeInexistente, codigo: 'INEXISTENTE' } : { estado: ESTADOS.FALHA, codigo: 'INACESSIVEL' };
  }
  if (e.isSymbolicLink()) return { estado: ESTADOS.FALHA, codigo: 'LINK_SIMBOLICO' };
  if (!e.isDirectory()) return { estado: ESTADOS.FALHA, codigo: 'NAO_E_DIRETORIO' };
  let real;
  try { real = portas.realpath(caminho); } catch { return { estado: ESTADOS.FALHA, codigo: 'INACESSIVEL' }; }
  if (real !== caminho) return { estado: ESTADOS.FALHA, codigo: 'CAMINHO_NAO_CANONICO' };
  if (uid !== null && e.uid !== uid) return { estado: ESTADOS.FALHA, codigo: 'DONO_DIVERGENTE' };
  if ((e.mode & 0o077) !== 0) return { estado: ESTADOS.FALHA, codigo: 'MODO_PERMISSIVO', detalhe: { modo: octal(e.mode) } };
  return { estado: ESTADOS.OK, codigo: 'OK', detalhe: { modo: octal(e.mode), dispositivo: Number(e.dev) }, dev: e.dev };
}

/** O caminho só é devolvido quando é canônico: o valor de uma variável malformada nunca é ecoado. */
function itemDeDiretorio(id, grupo, resultado, caminho) {
  return item(id, grupo, resultado.estado, resultado.codigo, { ...(caminhoCanonico(caminho) ? { caminho } : {}), ...(resultado.detalhe ?? {}) });
}

function executavel(portas, caminho) {
  try {
    const e = portas.stat(caminho);
    if (!e.isFile()) return false;
    portas.access(caminho, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function verificarPortas(portas) {
  const base = {
    lstat: fs.lstatSync, stat: fs.statSync, access: fs.accessSync, realpath: fs.realpathSync, statfs: fs.statfsSync,
    getuid: typeof process.getuid === 'function' ? () => process.getuid() : () => null,
  };
  if (portas === undefined) return Object.freeze(base);
  if (!ehObjeto(portas) || !Reflect.ownKeys(portas).every((k) => Object.hasOwn(base, k) && typeof portas[k] === 'function')) throw new TypeError('portas inválidas');
  return Object.freeze({ ...base, ...portas });
}

async function verificarAmbiente(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['ambiente', 'raizDoCodigo', 'portas', 'janela', 'agora'].includes(k))) throw new TypeError('entrada inválida');
  const { ambiente, raizDoCodigo, janela } = entrada;
  if (!ehObjeto(ambiente) || typeof raizDoCodigo !== 'string' || raizDoCodigo[0] !== '/' || raizDoCodigo.includes('\0')) throw new TypeError('entrada inválida');
  if (janela !== undefined && !(ehObjeto(janela) && ['lerArquivo', 'validar', 'ler'].every((k) => typeof janela[k] === 'function'))) throw new TypeError('janela inválida');
  const portas = verificarPortas(entrada.portas);
  const uid = portas.getuid();
  const itens = [];

  // --- origens: imagens e fiscalização
  const origens = {};
  for (const [id, chave, rotulo] of [['IMAGENS', 'imagens', 'DIRETORIO_IMAGENS'], ['FISCALIZACAO', 'fiscalizacao', 'DIRETORIO_FISCALIZACAO']]) {
    const v = variavel(ambiente, VARIAVEIS[chave]);
    if (v.ausente) { itens.push(item(rotulo, GRUPOS.INFRAESTRUTURA, ESTADOS.PENDENTE, 'VARIAVEL_AUSENTE', { variavel: VARIAVEIS[chave] })); continue; }
    if (v.invalida) { itens.push(item(rotulo, GRUPOS.INFRAESTRUTURA, ESTADOS.FALHA, 'VARIAVEL_INVALIDA', { variavel: VARIAVEIS[chave] })); continue; }
    const r = examinarDiretorio(portas, v.valor, uid, ESTADOS.FALHA);
    itens.push(itemDeDiretorio(rotulo, GRUPOS.INFRAESTRUTURA, r, v.valor));
    if (r.estado === ESTADOS.OK) origens[id] = v.valor;
  }

  // --- árvore do backup
  const raiz = variavel(ambiente, VARIAVEIS.raizBackup);
  const diretorios = {};
  if (raiz.ausente || raiz.invalida) {
    const codigo = raiz.ausente ? 'VARIAVEL_AUSENTE' : 'VARIAVEL_INVALIDA';
    const estado = raiz.ausente ? ESTADOS.PENDENTE : ESTADOS.FALHA;
    itens.push(item('BACKUP_RAIZ', GRUPOS.INFRAESTRUTURA, estado, codigo, { variavel: VARIAVEIS.raizBackup }));
    for (const [id] of SUBDIRETORIOS) itens.push(item(id, GRUPOS.INFRAESTRUTURA, ESTADOS.PENDENTE, 'BACKUP_RAIZ_NAO_AVALIADA'));
  } else {
    const r = examinarDiretorio(portas, raiz.valor, uid, ESTADOS.PENDENTE);
    itens.push(itemDeDiretorio('BACKUP_RAIZ', GRUPOS.INFRAESTRUTURA, r, raiz.valor));
    diretorios.BACKUP_RAIZ = r.estado === ESTADOS.OK ? { caminho: raiz.valor, dev: r.dev } : null;
    for (const [id, sub] of SUBDIRETORIOS) {
      const caminho = `${raiz.valor}/${sub}`;
      const rs = examinarDiretorio(portas, caminho, uid, ESTADOS.PENDENTE);
      itens.push(itemDeDiretorio(id, GRUPOS.INFRAESTRUTURA, rs, caminho));
      diretorios[id] = rs.estado === ESTADOS.OK ? { caminho, dev: rs.dev } : null;
    }
  }

  // --- relações entre diretórios
  const fora = (id, ref, rotulo) => {
    const alvo = diretorios.BACKUP_RAIZ;
    if (!alvo || ref === undefined) return item(id, GRUPOS.INFRAESTRUTURA, ESTADOS.PENDENTE, 'NAO_AVALIADO');
    const dentro = dentroDe(alvo.caminho, ref) || dentroDe(ref, alvo.caminho);
    return dentro ? item(id, GRUPOS.INFRAESTRUTURA, ESTADOS.FALHA, `BACKUP_SOBREPOSTO_A_${rotulo}`) : item(id, GRUPOS.INFRAESTRUTURA, ESTADOS.OK, 'OK');
  };
  itens.push(fora('BACKUP_FORA_DAS_IMAGENS', origens.IMAGENS, 'IMAGENS'));
  itens.push(fora('BACKUP_FORA_DA_FISCALIZACAO', origens.FISCALIZACAO, 'FISCALIZACAO'));
  itens.push(fora('BACKUP_FORA_DO_CODIGO', raizDoCodigo, 'CODIGO'));
  {
    const tres = ['PREPARACOES', 'DUMPS', 'PUBLICADOS'].map((k) => diretorios[k]);
    if (tres.some((d) => !d)) itens.push(item('MESMO_DISPOSITIVO', GRUPOS.INFRAESTRUTURA, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
    else if (new Set(tres.map((d) => String(d.dev))).size !== 1) itens.push(item('MESMO_DISPOSITIVO', GRUPOS.INFRAESTRUTURA, ESTADOS.FALHA, 'DISPOSITIVOS_DIFERENTES'));
    else itens.push(item('MESMO_DISPOSITIVO', GRUPOS.INFRAESTRUTURA, ESTADOS.OK, 'OK', { dispositivo: Number(tres[0].dev) }));
  }

  // --- limites e espaço
  const limites = {};
  let limitesInvalidos = false;
  let configurados = 0;
  for (const [chave, nome] of [['dump', VARIAVEIS.limiteDump], ['total', VARIAVEIS.limiteTotal], ['livre', VARIAVEIS.limiteLivre]]) {
    const v = variavel(ambiente, nome);
    if (v.ausente) continue;
    configurados += 1;
    if (v.invalida || !INTEIRO.test(v.valor) || !Number.isSafeInteger(Number(v.valor))) { limitesInvalidos = true; continue; }
    limites[chave] = Number(v.valor);
  }
  if (configurados === 0) itens.push(item('LIMITES', GRUPOS.LIMITES, ESTADOS.PENDENTE, 'NAO_CONFIGURADOS'));
  else if (limitesInvalidos) itens.push(item('LIMITES', GRUPOS.LIMITES, ESTADOS.FALHA, 'VALOR_INVALIDO'));
  else if (limites.dump !== undefined && limites.total !== undefined && limites.dump > limites.total) itens.push(item('LIMITES', GRUPOS.LIMITES, ESTADOS.FALHA, 'DUMP_MAIOR_QUE_TOTAL'));
  else itens.push(item('LIMITES', GRUPOS.LIMITES, ESTADOS.OK, 'OK', { dump: limites.dump ?? null, total: limites.total ?? null, livre: limites.livre ?? null }));
  if (!diretorios.BACKUP_RAIZ) itens.push(item('ESPACO_LIVRE', GRUPOS.LIMITES, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
  else {
    let livre = null;
    try { const st = portas.statfs(diretorios.BACKUP_RAIZ.caminho); livre = BigInt(st.bavail) * BigInt(st.bsize); } catch { livre = null; }
    if (livre === null || livre < 0n) itens.push(item('ESPACO_LIVRE', GRUPOS.LIMITES, ESTADOS.PENDENTE, 'INDISPONIVEL'));
    else if (limites.livre !== undefined && livre < BigInt(limites.livre)) itens.push(item('ESPACO_LIVRE', GRUPOS.LIMITES, ESTADOS.FALHA, 'ESPACO_INSUFICIENTE', { livreBytes: String(livre) }));
    else itens.push(item('ESPACO_LIVRE', GRUPOS.LIMITES, ESTADOS.OK, limites.livre === undefined ? 'MEDIDO_SEM_MINIMO' : 'OK', { livreBytes: String(livre) }));
  }

  // --- janela de escrita (I5): validação e leitura da trava injetadas; nada é criado
  if (janela === undefined) {
    itens.push(item('I5', GRUPOS.JANELA, ESTADOS.PENDENTE, 'VALIDADOR_NAO_INJETADO'));
  } else {
    let arquivo = null;
    let invalido = false;
    try { arquivo = janela.lerArquivo(ambiente); } catch { invalido = true; }
    if (invalido) itens.push(item('I5_VARIAVEL', GRUPOS.JANELA, ESTADOS.FALHA, 'I5_VALOR_INVALIDO'));
    else if (arquivo === null || arquivo === undefined) itens.push(item('I5_VARIAVEL', GRUPOS.JANELA, ESTADOS.PENDENTE, 'I5_AUSENTE'));
    else itens.push(item('I5_VARIAVEL', GRUPOS.JANELA, ESTADOS.OK, 'OK', { arquivo }));
    if (typeof arquivo !== 'string') {
      for (const id of ['I5_ARQUIVO', 'I5_PASTA_PADRAO', 'I5_ESTADO']) itens.push(item(id, GRUPOS.JANELA, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
    } else if (origens.IMAGENS === undefined) {
      itens.push(item('I5_ARQUIVO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'DEPENDE_DAS_IMAGENS'));
      itens.push(item('I5_PASTA_PADRAO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
      itens.push(item('I5_ESTADO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'DEPENDE_DAS_IMAGENS'));
    } else {
      let validado = true;
      try { await janela.validar({ arquivo, raizArmazenamento: origens.IMAGENS }); } catch (erro) {
        validado = false;
        const codigo = erro && erro.codigo === 'JANELA_DENTRO_DO_ARMAZENAMENTO' ? 'I5_DENTRO_DAS_IMAGENS' : erro && erro.codigo === 'JANELA_ARQUIVO_INVALIDO' ? 'I5_ARQUIVO_INVALIDO' : 'I5_NAO_VALIDADA';
        itens.push(item('I5_ARQUIVO', GRUPOS.JANELA, ESTADOS.FALHA, codigo));
      }
      if (validado) itens.push(item('I5_ARQUIVO', GRUPOS.JANELA, ESTADOS.OK, 'OK'));
      const padrao = diretorios.CONTROLE_JANELA?.caminho;
      if (!padrao) itens.push(item('I5_PASTA_PADRAO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
      else itens.push(arquivo.slice(0, arquivo.lastIndexOf('/')) === padrao ? item('I5_PASTA_PADRAO', GRUPOS.JANELA, ESTADOS.OK, 'OK') : item('I5_PASTA_PADRAO', GRUPOS.JANELA, ESTADOS.FALHA, 'I5_FORA_DA_PASTA_DE_CONTROLE'));
      if (!validado) itens.push(item('I5_ESTADO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'NAO_AVALIADO'));
      else {
        try {
          const dono = await janela.ler({ arquivo });
          if (dono === null || dono === undefined) itens.push(item('I5_ESTADO', GRUPOS.JANELA, ESTADOS.OK, 'JANELA_LIVRE'));
          else itens.push(item('I5_ESTADO', GRUPOS.JANELA, ESTADOS.PENDENTE, 'JANELA_OCUPADA', { tipo: typeof dono.tipo === 'string' && TIPO_DA_JANELA.test(dono.tipo) ? dono.tipo : 'DESCONHECIDO' }));
        } catch (erro) {
          itens.push(item('I5_ESTADO', GRUPOS.JANELA, ESTADOS.FALHA, erro && erro.codigo === 'JANELA_DOCUMENTO_INVALIDO' ? 'JANELA_DOCUMENTO_INVALIDO' : 'JANELA_ILEGIVEL'));
        }
      }
    }
  }

  // --- PostgreSQL: binários (sem executar), conexão (só sintaxe), arquivo de senha (só metadados) e variáveis conflitantes
  const bin = variavel(ambiente, VARIAVEIS.binariosPg);
  if (bin.invalida || (bin.valor !== undefined && !caminhoCanonico(bin.valor))) {
    for (const id of ['PG_DUMP', 'PG_RESTORE']) itens.push(item(id, GRUPOS.POSTGRES, ESTADOS.FALHA, 'VARIAVEL_INVALIDA', { variavel: VARIAVEIS.binariosPg }));
  } else {
    const dir = bin.valor ?? BINARIOS_PADRAO;
    const origem = bin.valor === undefined ? 'PADRAO' : 'AMBIENTE';
    for (const [id, nome] of [['PG_DUMP', 'pg_dump'], ['PG_RESTORE', 'pg_restore']]) {
      const caminho = `${dir}/${nome}`;
      itens.push(executavel(portas, caminho)
        ? item(id, GRUPOS.POSTGRES, ESTADOS.OK, 'OK', { caminho, origem, versao: 'NAO_VERIFICADA' })
        : item(id, GRUPOS.POSTGRES, ESTADOS.FALHA, 'EXECUTAVEL_INDISPONIVEL', { caminho, origem }));
    }
  }
  {
    const host = variavel(ambiente, VARIAVEIS.hostPg);
    const porta = variavel(ambiente, VARIAVEIS.portaPg);
    const usuario = variavel(ambiente, VARIAVEIS.usuarioPg);
    const banco = variavel(ambiente, VARIAVEIS.bancoPg);
    const todas = [host, porta, usuario, banco];
    if (todas.every((v) => v.ausente)) itens.push(item('PG_CONEXAO', GRUPOS.POSTGRES, ESTADOS.PENDENTE, 'NAO_CONFIGURADA'));
    else if (todas.some((v) => v.ausente)) itens.push(item('PG_CONEXAO', GRUPOS.POSTGRES, ESTADOS.PENDENTE, 'CONFIGURACAO_INCOMPLETA'));
    else {
      const numero = porta.valor !== undefined && /^[1-9][0-9]{0,4}$/.test(porta.valor) ? Number(porta.valor) : null;
      const valida = !todas.some((v) => v.invalida) && numero !== null && numero <= 65535
        && hostSintaticamenteValido(host.valor, numero) !== null && USUARIO.test(usuario.valor) && NOME_DE_BANCO.test(banco.valor);
      itens.push(valida ? item('PG_CONEXAO', GRUPOS.POSTGRES, ESTADOS.OK, 'OK', { porta: numero, hostTipo: hostSintaticamenteValido(host.valor, numero).tipo }) : item('PG_CONEXAO', GRUPOS.POSTGRES, ESTADOS.FALHA, 'VALOR_INVALIDO'));
    }
  }
  {
    const senha = variavel(ambiente, VARIAVEIS.senhaPg);
    if (senha.ausente) itens.push(item('ARQUIVO_DE_SENHA', GRUPOS.POSTGRES, ESTADOS.PENDENTE, 'PGPASSFILE_AUSENTE'));
    else if (senha.invalida || !caminhoCanonico(senha.valor)) itens.push(item('ARQUIVO_DE_SENHA', GRUPOS.POSTGRES, ESTADOS.FALHA, 'VARIAVEL_INVALIDA'));
    else {
      let e = null;
      let codigo = 'OK';
      let estado = ESTADOS.OK;
      try { e = portas.lstat(senha.valor); } catch (erro) { estado = erro && erro.code === 'ENOENT' ? ESTADOS.PENDENTE : ESTADOS.FALHA; codigo = erro && erro.code === 'ENOENT' ? 'ARQUIVO_INEXISTENTE' : 'INACESSIVEL'; }
      if (e !== null) {
        if (e.isSymbolicLink()) { estado = ESTADOS.FALHA; codigo = 'LINK_SIMBOLICO'; }
        else if (!e.isFile()) { estado = ESTADOS.FALHA; codigo = 'NAO_E_ARQUIVO_REGULAR'; }
        else if ((e.mode & 0o077) !== 0) { estado = ESTADOS.FALHA; codigo = 'MODO_PERMISSIVO'; }
        else if (uid !== null && e.uid !== uid) { estado = ESTADOS.FALHA; codigo = 'DONO_DIVERGENTE'; }
      }
      itens.push(item('ARQUIVO_DE_SENHA', GRUPOS.POSTGRES, estado, codigo, e !== null && !e.isSymbolicLink() ? { modo: octal(e.mode) } : undefined));
    }
    const conflitantes = Object.keys(ambiente).filter((nome) => /^PG[A-Z0-9_]*$/.test(nome) && nome !== VARIAVEIS.senhaPg).sort();
    itens.push(conflitantes.length === 0
      ? item('PG_VARIAVEIS_CONFLITANTES', GRUPOS.POSTGRES, ESTADOS.OK, 'NENHUMA')
      : item('PG_VARIAVEIS_CONFLITANTES', GRUPOS.POSTGRES, ESTADOS.FALHA, 'VARIAVEL_PG_PRESENTE', { nomes: conflitantes }));
  }

  // --- pendências OPERACIONAIS: chaves, destinos, custódia e composição (reportadas a partir das fontes de verdade do código)
  for (const [id, lista] of [
    ['PROVEDORES_DE_MAC', PROVEDORES_OPERACIONAIS_APROVADOS], ['PROVEDORES_DE_CIFRA', PROVEDORES_DE_CIFRA_APROVADOS],
    ['ARMAZENAMENTOS_DURAVEIS', ARMAZENAMENTOS_DURAVEIS_APROVADOS], ['DESTINOS_HOMOLOGACAO', DESTINOS_AUTORIZADOS.HOMOLOGACAO], ['DESTINOS_PRODUCAO', DESTINOS_AUTORIZADOS.PRODUCAO],
  ]) {
    itens.push(lista.length === 0 ? item(id, GRUPOS.OPERACIONAL, ESTADOS.PENDENTE, 'LISTA_VAZIA') : item(id, GRUPOS.OPERACIONAL, ESTADOS.PENDENTE, 'LISTA_COM_ENTRADAS_SEM_PRONTIDAO_COMPROVADA', { entradas: lista.length }));
  }
  const prontidao = avaliarProntidaoCriptografica({ cifra: null, mac: null, custodia: null, retencao: null, transporte: null, ...(entrada.agora === undefined ? {} : { agora: entrada.agora }) });
  itens.push(item('PRONTIDAO_CRIPTOGRAFICA', GRUPOS.OPERACIONAL, ESTADOS.PENDENTE, 'REQUISITOS_NAO_ATENDIDOS', { pendencias: prontidao.pendencias.map((p) => `${p.requisito}:${p.codigo}`) }));
  itens.push(item('COMPOSICAO_DE_PRODUCAO', GRUPOS.OPERACIONAL, ESTADOS.PENDENTE, 'FONTE_DE_CHAVES_RECONHECIDA_INDISPONIVEL'));

  const contar = (lista, estado) => lista.filter((i) => i.estado === estado).length;
  const infra = itens.filter((i) => i.grupo !== GRUPOS.OPERACIONAL);
  const infraestrutura = { ok: contar(infra, ESTADOS.OK), pendente: contar(infra, ESTADOS.PENDENTE), falha: contar(infra, ESTADOS.FALHA) };
  const veredito = infraestrutura.falha > 0 ? 'FALHA' : infraestrutura.pendente > 0 ? 'INFRA_PENDENTE' : 'INFRA_OK_OPERACIONAL_BLOQUEADO';
  return Object.freeze({
    versao: 1,
    modo: 'verificar',
    veredito,
    prontidaoOperacional: false,
    infraestrutura: Object.freeze(infraestrutura),
    operacional: Object.freeze({ pendente: contar(itens.filter((i) => i.grupo === GRUPOS.OPERACIONAL), ESTADOS.PENDENTE) }),
    itens: Object.freeze(itens),
    observacoes: Object.freeze([
      'Os binarios do PostgreSQL nao sao executados: as versoes nao sao verificadas por este modo.',
      'Este modo nao cria janela, arquivo, conexao nem processo; so le metadados.',
      'Um veredito sem falhas nao e prontidao operacional: chaves, destinos duraveis, custodia e retencao seguem pendentes.',
    ]),
    efeitos: Object.freeze({ escritas: 0, conexoes: 0, processos: 0, janelasCriadas: 0 }),
  });
}

module.exports = { verificarAmbiente, ESTADOS, GRUPOS, VARIAVEIS, BINARIOS_PADRAO, SUBDIRETORIOS };
