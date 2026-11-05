'use strict';

const crypto = require('node:crypto');

/**
 * R-D45: S3 FALSO em memória (sem rede, sem AWS): bucket com versionamento e Object Lock, escrita condicional (objeto novo) e TRÊS clientes de papéis diferentes, cada um
 * com SÓ os métodos do seu papel (publicador: identidade, configuração, chave, gravar; verificador: identidade, listar, metadados; restauração: identidade, ler versão).
 * `chamadas` registra `{ papel, operacao }`. As operações de administrador (injetar versão, corromper, marcador) existem só aqui, para provocar adulteração nos testes.
 */

const arnDe = (p) => (p.tipo === 'user' ? `arn:aws:iam::${p.contaId}:user/${p.nome}` : `arn:aws:sts::${p.contaId}:assumed-role/${p.nome}/sessao-teste`);
const erro = (code) => Object.assign(new Error(`falha-${code}`), { code });
const lerTudo = async (fluxo) => { const h = crypto.createHash('sha256'); const partes = []; for await (const b of fluxo) { h.update(b); partes.push(Buffer.from(b)); } return { sha256: h.digest('hex'), conteudo: Buffer.concat(partes) }; };

function criarS3Falso({ ficha, relogio = () => Date.now(), config = {}, identidades = {}, bloco = 1024 }) {
  const itens = new Map();
  const chamadas = [];
  const fila = [];
  const chaves = new Map();
  let seq = 0;
  const cfg = { regiao: ficha.regiao, versionamento: 'Enabled', objectLock: { habilitado: true, modo: ficha.retencao.modo, dias: ficha.retencao.dias }, criptografiaPadrao: 'AES256', propriedade: 'BucketOwnerEnforced', ...config };
  const registrar = (papel, operacao) => chamadas.push({ papel, operacao });
  const identidadeDe = (papel) => { const p = identidades[papel] ?? ficha.identidades[papel]; return { contaId: p.contaId, arn: arnDe(p) }; };
  const exigir = (p) => { if (p.bucket !== ficha.bucket) throw erro('NEGADO'); if (p.donoEsperado !== ficha.contaId) throw erro('DONO_DIVERGENTE'); };

  function acrescentar(chave, conteudo, sha256) {
    seq += 1;
    const lista = itens.get(chave) ?? [];
    const retencao = cfg.objectLock.habilitado ? { modo: cfg.objectLock.modo, ate: new Date(relogio() + (cfg.objectLock.dias ?? 0) * 86400000).toISOString() } : null;
    const versao = { versaoId: `v${seq}.${crypto.randomBytes(4).toString('hex')}`, conteudo: Buffer.from(conteudo), sha256, bytes: conteudo.length, retencao, marcador: false };
    lista.push(versao);
    itens.set(chave, lista);
    return versao;
  }

  const publicador = Object.freeze({
    async identidade() { registrar('publicador', 'identidade'); return identidadeDe('publicador'); },
    async lerConfiguracaoDoBucket(p) {
      registrar('publicador', 'lerConfiguracaoDoBucket');
      return { ...cfg, donoConfirmado: config.donoConfirmado ?? (p.bucket === ficha.bucket && p.donoEsperado === ficha.contaId) };
    },
    async descreverChave({ chaveArn }) { registrar('publicador', 'descreverChave'); return chaves.get(chaveArn) ?? { estado: 'Enabled', especificacao: 'SYMMETRIC_DEFAULT' }; },
    async gravarObjeto(p) {
      registrar('publicador', 'gravarObjeto');
      exigir(p);
      const modo = fila.shift();
      if (modo === 'NEGAR') throw erro('NEGADO');
      if (modo === 'CAIR_ANTES') throw erro('RESET');
      if (modo === 'LENTO') await new Promise(() => {});
      if (modo === 'CHECKSUM_REJEITADO') throw erro('CHECKSUM_REJEITADO');
      const { sha256, conteudo } = await lerTudo(p.abrirFluxo());
      if (sha256 !== p.sha256 || conteudo.length !== p.bytes) throw erro('CHECKSUM_REJEITADO');
      if (itens.has(p.chave) && p.naoSobrescrever) return { resultado: 'JA_EXISTE', tentativas: 1 };
      const versao = acrescentar(p.chave, conteudo, sha256);
      if (modo === 'PERDER_RESPOSTA') throw erro('RESET');
      if (modo === 'REENVIO') return { resultado: 'JA_EXISTE', tentativas: 2 };
      const ok = { resultado: 'GRAVADO', versaoId: versao.versaoId, sha256, bytes: conteudo.length, tentativas: 1 };
      if (modo === 'SHA_ERRADO') return { ...ok, sha256: 'b'.repeat(64) };
      if (modo === 'BYTES_ERRADOS') return { ...ok, bytes: ok.bytes + 1 };
      if (modo === 'VERSAO_NULA') return { ...ok, versaoId: 'null' };
      if (modo === 'COM_EXTRA') return { ...ok, extra: 1 };
      if (modo === 'INCOMPLETA') { const { sha256: _omitido, ...resto } = ok; return resto; }
      return ok;
    },
  });

  const listarVersoes = (p) => {
    exigir(p);
    const saida = [];
    for (const [chave, lista] of itens) {
      if (!chave.startsWith(p.prefixo)) continue;
      lista.forEach((v, i) => saida.push({ chave, versaoId: v.versaoId, ehAtual: i === lista.length - 1, marcadorDeExclusao: v.marcador }));
    }
    return saida;
  };
  const achar = (p) => { exigir(p); const v = (itens.get(p.chave) ?? []).find((x) => x.versaoId === p.versaoId); if (v === undefined) throw erro('NAO_ENCONTRADO'); return v; };

  const verificador = Object.freeze({
    async identidade() { registrar('verificador', 'identidade'); return identidadeDe('verificador'); },
    async listarVersoes(p) { registrar('verificador', 'listarVersoes'); return listarVersoes(p); },
    async lerMetadadosDaVersao(p) { registrar('verificador', 'lerMetadadosDaVersao'); const v = achar(p); return { bytes: v.bytes, sha256: v.sha256, retencao: v.retencao }; },
  });

  const restauracao = Object.freeze({
    async identidade() { registrar('restauracao', 'identidade'); return identidadeDe('restauracao'); },
    async lerVersao(p) {
      registrar('restauracao', 'lerVersao');
      const v = achar(p);
      return { bytes: v.conteudo.length, fluxo: (async function* fluxo() { for (let i = 0; i < v.conteudo.length; i += bloco) yield Buffer.from(v.conteudo.subarray(i, i + bloco)); })() };
    },
  });

  return {
    clientes: { publicador, verificador, restauracao },
    chamadas,
    programarGravacao: (...modos) => fila.push(...modos),
    definirChave: (arn, estado) => chaves.set(arn, estado),
    existe: (chave) => itens.has(chave),
    versoes: (chave) => (itens.get(chave) ?? []).map((v) => ({ versaoId: v.versaoId, sha256: v.sha256, bytes: v.bytes, retencao: v.retencao })),
    conteudo: (chave, versaoId) => Buffer.from(itens.get(chave).find((v) => v.versaoId === versaoId).conteudo),
    injetarVersaoExtra: (chave, conteudo) => acrescentar(chave, Buffer.from(conteudo), crypto.createHash('sha256').update(conteudo).digest('hex')).versaoId,
    corromper: (chave, versaoId, conteudo) => { const v = itens.get(chave).find((x) => x.versaoId === versaoId); v.conteudo = Buffer.from(conteudo); v.bytes = v.conteudo.length; v.sha256 = crypto.createHash('sha256').update(conteudo).digest('hex'); },
    adicionarMarcadorDeExclusao: (chave) => { const lista = itens.get(chave); lista.push({ versaoId: `m${(seq += 1)}`, conteudo: Buffer.alloc(0), sha256: '', bytes: 0, retencao: null, marcador: true }); },
    semRetencao: (chave, versaoId) => { itens.get(chave).find((v) => v.versaoId === versaoId).retencao = null; },
  };
}

module.exports = { criarS3Falso, arnDe };
