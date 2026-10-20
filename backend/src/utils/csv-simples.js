'use strict';

/**
 * Leitor de CSV de arquivos pequenos e conhecidos (manifesto e mapeamento da biblioteca padrão): separador informado, campos opcionalmente entre aspas
 * (aspas duplicadas dentro do campo), quebra de linha LF ou CRLF. Devolve a lista de linhas, cada uma uma lista de textos. Estrutura malformada
 * (aspas abertas, texto depois das aspas, aspas no meio de um campo sem aspas) lança SyntaxError sem ecoar o conteúdo.
 */
function analisarCsv(texto, separador) {
  if (typeof texto !== 'string' || typeof separador !== 'string' || separador.length !== 1) throw new TypeError('argumentos inválidos');
  const linhas = [];
  let linha = [];
  let campo = '';
  let emAspas = false;
  let campoComAspas = false;

  const fecharCampo = () => { linha.push(campo); campo = ''; campoComAspas = false; };
  const fecharLinha = () => { fecharCampo(); linhas.push(linha); linha = []; };

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (emAspas) {
      if (c !== '"') campo += c;
      else if (texto[i + 1] === '"') { campo += '"'; i += 1; } else emAspas = false;
    } else if (c === '"') {
      if (campo !== '' || campoComAspas) throw new SyntaxError('CSV malformado');
      emAspas = true;
      campoComAspas = true;
    } else if (c === separador) {
      fecharCampo();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      fecharLinha();
    } else {
      if (campoComAspas) throw new SyntaxError('CSV malformado');
      campo += c;
    }
  }
  if (emAspas) throw new SyntaxError('CSV malformado');
  if (campo !== '' || linha.length > 0 || campoComAspas) fecharLinha();
  return linhas;
}

module.exports = { analisarCsv };
