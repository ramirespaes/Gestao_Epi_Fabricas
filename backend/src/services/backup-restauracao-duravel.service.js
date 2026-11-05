'use strict';

const { decifrarContainer } = require('./backup-fontes-cifra-envelope.service');
const { criarContencaoDeDestino } = require('./backup-contencao-destino.service');

/**
 * D-ORF-6, R-D45 (D-F4/D-F5): ORQUESTRADOR DA RESTAURAÇÃO A PARTIR DO DESTINO DURÁVEL. Sem escrita própria: encadeia (1) o baixador por versão explícita (integridade de cada
 * objeto contra o recibo, em diretório local NOVO dentro de uma raiz AUTORIZADA, com espaço e limites conferidos antes de gravar, reservando a segunda cópia da decifra),
 * (2) a autorização do SEGUNDO destino novo, irmão do primeiro, no mesmo registro oficial de destinos, e (3) `decifrarContainer`, que confere o MAC do envelope em tempo
 * constante ANTES de confiar em qualquer campo ou de decifrar qualquer arquivo, e só então desenvolve a chave de dados e decifra para o destino NOVO. Os dois destinos são
 * filhos diretos da raiz autorizada (`destinoLocalId` e `raiz` do registro; `nomeContainer` e `nomeDecifrado` distintos): este módulo não recebe caminho livre.
 * As chaves chegam como `{ cifra: { fonte, chaveId }, mac: { fonte, chaveId } }` de qualquer origem que respeite o contrato (KMS pré-resolvido, recuperação off-line).
 * A verificação do pacote reconstruído (`verificarPacoteL2` com o leitor L2, que possui a fonte do manifesto) continua sendo do chamador. Um destino parcial NÃO é apagado aqui.
 * A escrita da decifra é a do módulo de cifra em envelope (entrada 47 da guarda P2); ela recebe uma GUARDA DE CONTENÇÃO (`backup-contencao-destino`, construída aqui com o mesmo validador
 * oficial de destinos que autoriza a raiz) que revalida a raiz autorizada e a identidade de cada pasta criada antes de criar, abrir um temporário ou ligar um arquivo: troca concorrente
 * de componente do caminho ou da própria raiz para a decifra com DESTINO_ALTERADO. Resta só a janela mínima entre a conferência e a chamada de sistema (sem operações relativas a descritor no Node).
 * Falhas: `{ ok: false, falha: { passo, codigo } }`, com o passo e o código do componente que falhou.
 */

const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHAVES = Object.freeze(['baixador', 'validadorDeDestinos', 'consolidado', 'destinoLocalId', 'raiz', 'nomeContainer', 'nomeDecifrado', 'cifra', 'mac']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const falha = (passo, codigo) => Object.freeze({ ok: false, falha: Object.freeze({ passo, codigo }) });
const deComponente = (r, padrao) => Object.freeze({ ok: false, falha: ehObjeto(r) && ehObjeto(r.falha) ? r.falha : padrao });

async function restaurarContainerDoDestinoDuravel(entrada) {
  if (!ehObjeto(entrada) || !chavesExatas(entrada, CHAVES) || !ehObjeto(entrada.baixador) || typeof entrada.baixador.baixar !== 'function' || typeof entrada.baixador.autorizarNovoDestino !== 'function') return falha('ENTRADA', 'ENTRADA_INVALIDA');
  const { baixador, validadorDeDestinos, consolidado, destinoLocalId, raiz, nomeContainer, nomeDecifrado, cifra, mac } = entrada;
  if (typeof destinoLocalId !== 'string' || typeof raiz !== 'string' || typeof nomeContainer !== 'string' || typeof nomeDecifrado !== 'string' || !NOME.test(nomeContainer) || !NOME.test(nomeDecifrado) || nomeContainer === nomeDecifrado) return falha('ENTRADA', 'ENTRADA_INVALIDA');
  if (!ehObjeto(validadorDeDestinos) || typeof validadorDeDestinos.validar !== 'function') return falha('ENTRADA', 'ENTRADA_INVALIDA');
  try {
    const baixado = await baixador.baixar({ consolidado, destinoLocalId, raiz, nome: nomeContainer, reservarDecifra: true });
    if (!ehObjeto(baixado) || baixado.ok !== true) return deComponente(baixado, Object.freeze({ passo: 'BAIXAR', codigo: 'LEITURA_FALHOU' }));
    const alvo = await baixador.autorizarNovoDestino({ destinoLocalId, raiz, nome: nomeDecifrado });
    if (!ehObjeto(alvo) || alvo.ok !== true) return deComponente(alvo, Object.freeze({ passo: 'DESTINO', codigo: 'DESTINO_NAO_AUTORIZADO' }));
    let contencao;
    try { contencao = criarContencaoDeDestino({ validadorDeDestinos, destinoLocalId, raiz, destino: alvo.caminho }); } catch { return falha('ENTRADA', 'ENTRADA_INVALIDA'); }
    const decifrado = await decifrarContainer({ container: baixado.destino, destino: alvo.caminho, cifra, mac, contencao });
    if (!ehObjeto(decifrado) || decifrado.ok !== true) return deComponente(decifrado, Object.freeze({ passo: 'DECIFRA', codigo: 'ARQUIVO_ADULTERADO' }));
    return Object.freeze({ ok: true, baixados: Object.freeze({ arquivos: baixado.arquivos, bytes: baixado.bytes }), decifrado });
  } catch { return falha('INTERNO', 'FALHA_INESPERADA'); }
}

module.exports = { restaurarContainerDoDestinoDuravel };
