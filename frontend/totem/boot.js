/*
 * Totem — inicialização. É o primeiro script do <head> e roda antes de qualquer outro recurso.
 *
 * Faz uma coisa só: ler o código de ativação do fragmento da URL (#ativar=<código>) e tirá-lo do endereço no mesmo
 * instante, antes de qualquer requisição. O código fica apenas na memória deste fechamento: não vai a armazenamento,
 * histórico, console, DOM nem a variável global. Quem precisa dele pede por `tomar()`, que o entrega uma vez e o descarta.
 */
(function (global) {
  'use strict';

  var FRAGMENTO = /^#ativar=(.*)$/;
  var FORMATO = /^[A-Za-z0-9_-]{43}$/;

  var codigo = null;
  var estado = 'ausente';

  var hash = global.location.hash;
  var achado = FRAGMENTO.exec(hash);

  if (hash !== '') {
    if (achado && FORMATO.test(achado[1])) {
      codigo = achado[1];
      estado = 'valido';
    } else {
      estado = 'invalido';
    }
    global.history.replaceState(null, '', global.location.pathname + global.location.search);
  }

  global.TotemAtivacao = Object.freeze({
    estado: function () { return estado; },
    tomar: function () {
      var c = codigo;
      codigo = null;
      return c;
    },
    descartar: function () {
      codigo = null;
      if (estado === 'valido') estado = 'descartado';
    },
  });
})(window);
