'use strict';

/**
 * Stub de `FileReader` (e de `Blob.prototype.slice`) para o harness de páginas do Totem, que não tem esses recursos. O Totem passou a converter o Blob da
 * fotografia em `data:image/webp;base64,` (a CSP do Portal na HML admite só 'self' e data: em img-src; blob: é bloqueado). O stub é um script de página:
 * deve ser injetado DEPOIS do stub de Blob da suíte.
 *
 * Observável na página:
 *   window.__leituras         [{ tamanho, tipo, tag, abortada, concluida }]  uma entrada por readAsDataURL
 *   window.__dadosDe(src)     { tamanho, tag } de um data URL produzido pelo stub (null se não for um)
 *   window.__leitorFalha      se true, a próxima leitura dispara 'error' em vez de 'load'
 *   window.__leitorAdiado     se true, as leituras ficam PENDENTES até window.__liberarLeituras()
 *   window.__leitorResultado  se definido, é o `result` entregue no 'load' (para provar a recusa de formatos inesperados)
 * O resultado codifica `tamanho` e `tag` do "blob" em base64 (ASCII), para os testes ligarem cada <img> ao Blob de origem.
 */
const STUB_LEITOR = String.raw`(function (g) {
  'use strict';
  var ALF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64(s) {
    var o = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN, c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      o += ALF[a >> 2] + ALF[((a & 3) << 4) | ((b || 0) >> 4)] + (isNaN(b) ? '=' : ALF[((b & 15) << 2) | ((c || 0) >> 6)]) + (isNaN(c) ? '=' : ALF[c & 63]);
    }
    return o;
  }
  function desb64(t) {
    var o = '';
    t = t.replace(/=+$/, '');
    for (var i = 0; i < t.length; i += 4) {
      var q = [0, 1, 2, 3].map(function (k) { return i + k < t.length ? ALF.indexOf(t[i + k]) : -1; });
      o += String.fromCharCode((q[0] << 2) | (q[1] >> 4));
      if (q[2] >= 0) o += String.fromCharCode(((q[1] & 15) << 4) | (q[2] >> 2));
      if (q[3] >= 0) o += String.fromCharCode(((q[2] & 3) << 6) | q[3]);
    }
    return o;
  }
  if (g.Blob && !g.Blob.prototype.slice) {
    g.Blob.prototype.slice = function (ini, fim, tipo) {
      var c = Object.create(g.Blob.prototype);
      for (var k in this) if (Object.prototype.hasOwnProperty.call(this, k)) c[k] = this[k];
      c.type = tipo === undefined ? this.type : tipo;
      return c;
    };
  }
  g.__leituras = [];
  var pendentes = [];
  g.__liberarLeituras = function () { pendentes.splice(0).forEach(function (f) { f(); }); };
  function Leitor() { this.ouvintes = {}; this.result = null; this.estado = 'novo'; }
  Leitor.prototype.addEventListener = function (t, fn) { (this.ouvintes[t] = this.ouvintes[t] || []).push(fn); };
  Leitor.prototype.emitir = function (t) { var self = this; (this.ouvintes[t] || []).forEach(function (fn) { fn.call(self, { type: t }); }); };
  Leitor.prototype.readAsDataURL = function (b) {
    var self = this;
    var reg = { tamanho: b && typeof b.size === 'number' ? b.size : null, tipo: b ? b.type : null, tag: b && b.tag !== undefined && b.tag !== null ? String(b.tag) : '', abortada: false, concluida: false };
    g.__leituras.push(reg); this.reg = reg; this.estado = 'lendo';
    var falha = g.__leitorFalha === true; if (falha) g.__leitorFalha = false;
    function terminar() {
      if (reg.abortada) return;
      if (falha) { self.estado = 'erro'; self.emitir('error'); return; }
      reg.concluida = true; self.estado = 'pronto';
      self.result = g.__leitorResultado !== undefined ? g.__leitorResultado : 'data:image/webp;base64,' + b64('tamanho=' + reg.tamanho + ';tag=' + reg.tag);
      self.emitir('load');
    }
    if (g.__leitorAdiado === true) pendentes.push(terminar); else Promise.resolve().then(terminar);
  };
  Leitor.prototype.abort = function () { if (this.estado !== 'lendo') return; this.reg.abortada = true; this.estado = 'abortado'; this.emitir('abort'); };
  g.FileReader = Leitor;
  g.__dadosDe = function (src) {
    var m = /^data:image\/webp;base64,([A-Za-z0-9+\/]+=*)$/.exec(String(src));
    if (!m) return null;
    var d = /^tamanho=(\d+|null);tag=(.*)$/.exec(desb64(m[1]));
    return d ? { tamanho: d[1] === 'null' ? null : Number(d[1]), tag: d[2] } : null;
  };
})(globalThis);`;

module.exports = { STUB_LEITOR };
