'use strict';
// Etapa 4C (D-H1): linha de comando exclusiva da adoção da primeira release do backend. Não instala sobre nada, não
// reinicia, não reverte e não aceita opções: só a configuração oficial do agente (C1), a release e o hash aprovado do
// release.json. A linha de comando do instalador continua recusando instalar e reverter o backend.
// `confirmar` (opção 1 da 4C) comprova a release adotada pelo processo em execução (MainPID e identidade do serviço) e
// pela saúde, sem reinício, e só então a registra como comprovada.
// Uso: node adotar-backend.js --config /etc/safework/cd/agente-backend.json --release <dir> --release-sha256 <hash>
//      node adotar-backend.js confirmar --config /etc/safework/cd/agente-backend.json
const I = require('./instalar-release');
const { erro } = require('./nucleo');

const NOMES = Object.freeze({ '--config': 'config', '--release': 'release', '--release-sha256': 'releaseSha256' });
const uso = () => erro('USO', 'uso: adotar-backend.js --config <configuração oficial> --release <dir> --release-sha256 <hash aprovado> | adotar-backend.js confirmar --config <configuração oficial>');

function lerArgumentos(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw uso();
  const valores = {};
  for (let i = 0; i < argv.length; i += 2) {
    const nome = NOMES[argv[i]];
    const valor = argv[i + 1];
    if (!nome || Object.hasOwn(valores, nome) || typeof valor !== 'string' || valor === '' || valor.startsWith('--')) throw uso();
    valores[nome] = valor;
  }
  return valores;
}

// A identidade do serviço é obrigatória: sem ela não há como ligar o processo em execução à release adotada sem ler o
// /proc/<pid>/cwd de outro usuário.
async function confirmar(argv) {
  if (argv.length !== 3 || argv[1] !== '--config' || typeof argv[2] !== 'string' || argv[2] === '' || argv[2].startsWith('--')) throw uso();
  I.verificarContextoDeExecucao();
  const oficial = I.lerConfiguracaoOficial(I.origemDaConfiguracaoOficial(argv[2]));
  const identidade = oficial !== null && typeof oficial === 'object' ? oficial.identidadeDoServico : undefined;
  if (identidade === undefined || !I.identidadeDoServicoValida(identidade)) throw erro('CONFIRMACAO_RECUSADA', 'a confirmação exige a identidade do serviço configurada (identidadeDoServico)');
  const comp = I.validarConfig(oficial.instalador).componentes.backend;
  if (!comp || !comp.processo || !comp.saude) throw erro('CONFIRMACAO_RECUSADA', 'a confirmação exige o processo e a saúde do backend configurados');
  const deps = { identificarProcesso: I.identificacaoPorIdentidade(comp, identidade), verificarSaude: I.depsDoConfig(comp).verificarSaude };
  return I.confirmarBaselineAdotada({ config: oficial.instalador, componente: 'backend', deps });
}

async function principal(argv) {
  if (Array.isArray(argv) && argv[0] === 'confirmar') return confirmar(argv);
  const v = lerArgumentos(argv);
  I.verificarContextoDeExecucao();
  const oficial = I.lerConfiguracaoOficial(I.origemDaConfiguracaoOficial(v.config));
  const instalador = oficial !== null && typeof oficial === 'object' ? oficial.instalador : undefined;
  return I.adotarBaselineDoBackend({ config: instalador, componente: 'backend', release: v.release, opcoes: { releaseSha256Esperado: v.releaseSha256 } });
}

if (require.main === module) {
  principal(process.argv.slice(2)).then((resultado) => {
    process.stdout.write(`${JSON.stringify(resultado)}\n`);
  }, (falha) => {
    console.error(`Adoção recusada (${falha && falha.codigo ? falha.codigo : 'ERRO'}): ${falha && falha.message ? falha.message : ''}`);
    process.exitCode = 1;
  });
}

module.exports = { principal };
