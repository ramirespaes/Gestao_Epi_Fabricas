# Publicação da homologação: componentes locais e desenho do job

**Etapa 52, 07/11/2026:** o job protegido e o agente de entrega foram implementados
localmente, sem ativação. O contrato atual da automação está em
[publicacao-homologacao-automacao.md](publicacao-homologacao-automacao.md) e substitui
o desenho de job futuro e as afirmações de incapacidade de publicação desta baseline.
Os componentes do instalador permanecem inalterados. A-0 a A-11 abaixo são o registro
da preparação anterior; o environment e a homologação AWS informados pelo responsável
nesta etapa não foram inspecionados remotamente.

Preparado em 04/11/2026 para revisão. Complementa [publicacao-homologacao.md](publicacao-homologacao.md).
Na preparação de 04/11/2026, tudo foi desenvolvido e testado em ambiente local isolado.
**Nada foi executado, instalado ou configurado na AWS** por aquela entrega, nenhum
segredo foi incluído, e o workflow então era incapaz de publicar. A implementação
atual tem job protegido e permanece sem ativação. Os caminhos de servidor citados são referência de
planejamento recebida do responsável, não autorização para operar neles.

## Componentes (pasta `deploy/hml/`)

| Peça | Função | Testes |
|---|---|---|
| `empacotar-backend.js`, `allowlist-backend.json` | pacote do backend por allowlist, com proteção contra segredos | `empacotar-backend.test.js` |
| `instalador/instalar-release.js`, `instalador/nucleo.js` | instala, reverte, reconcilia e identifica releases no servidor; o núcleo cuida de configuração, autenticidade, estado, diário e verificações | `instalador.test.js`, `correcoes-instalador.test.js` |
| `instalador/compatibilidade.js` | bloqueia troca ou rollback incompatível com migrations e contratos | `compatibilidade.test.js` |
| `instalador/coordenacao.js` | interface de coordenação com o D-ORF-6 | `compatibilidade.test.js` |
| `verificacao/verificar-publicacao.js` | confere commit, hashes, cabeçalhos, isolamento e saúde | `verificar-publicacao.test.js` |
| `csp/gerar-csp.js` | gera a CSP do pacote por perfil | `gerar-csp.test.js` |
| `nginx/` | modelos de Portal e Painel e renderizador validado | `nginx-modelos.test.js` |

Os testes ficam em `.github/scripts/hml/test/` de propósito: o passo que o `ci.yml` já
executa os roda em pull requests e na `main`, sem alterar o CI. Os arquivos
`correcoes-instalador.test.js` e `correcoes-componentes.test.js` cobrem os cenários
adversariais da auditoria de segurança, cada um escrito antes da correção.

## Pacote do backend

Leva `src/`, `scripts/`, `migrations/` com o `checksums.json`, `package.json` e
`package-lock.json`. Não leva `test/`, `docs/`, `.env*`, `node_modules`, `coverage` nem
`ops/`, os modelos inertes de unidades systemd do D-ORF-6, cuja instalação é procedimento
próprio e autorizado, fora da release: `ops/` é um diretório operacional excluído por
nome, não é lido nem copiado, a allowlist não pode apontar para dentro dele (lida do
arquivo ou injetada, a recusa é `ALLOWLIST_INVALIDA`) e um link ou arquivo com esse nome
na raiz continua recusado.
Recusa, antes de escrever: item desconhecido na raiz, link simbólico, duplicata do
Finder, arquivo de segredo por nome, extensão fora da regra, arquivo grande, segredo no
conteúdo (a mensagem cita arquivo, linha e regra, nunca o valor), `package.json` com hook
de instalação, lockfile que não seja v3 com origem npm e integridade, e migrations
diferentes do `checksums.json`. A única exceção de conteúdo é a chave de teste pública
do Turnstile que o código já usa, comparada por hash exato. A isenção vale por literal,
não por linha: todas as atribuições de uma linha são examinadas, então uma chave pública
ao lado de um segredo real não esconde o segredo. Linhas acima de 10 mil caracteres são
recusadas, porque código minificado em uma linha não é revisável e degradaria a varredura.
O scanner é uma heurística por linha, uma camada entre várias: as barreiras reais são a
allowlist estrita (só entra o que está listado) e a revisão. Nomes de arquivo de segredo
são recusados sem distinção de caixa (`CREDENTIALS.js`, `KEY.PEM`, `.ENV`). Literais
atribuídos a nomes como `senha`, `password`, `token`, `api_key`, `credential`,
`passphrase` ou `pwd` são recusados com 6 ou mais caracteres que tenham dígito ou
símbolo, ou 12 ou mais só de letras; ficam de fora constantes e caminhos de campo de
código (`portal_recuperacao_senha`, `body.senhaProvisoria`, `MFA_TOTP_KEY_V1`) e nomes
curtos de cabeçalho (`x-token`). Medido contra o backend real, as regras não recusam
nada. Continuam sem ser detectados: valores montados em partes, codificados, vindos de
outra variável ou escritos em várias linhas, e textos com espaços (que geram falso
positivo com mensagens de erro), então a ausência de achado nunca prova a ausência de
segredo.

As dependências **não vão no pacote**: o instalador roda `npm ci --omit=dev
--ignore-scripts` no diretório de preparo, a partir do lockfile verificado. Isso deixa
em aberto confirmar no servidor que `argon2` e `sharp` carregam sem seus scripts de
instalação (pendência A-4 abaixo).

## Instalador de releases

Layout por componente, dados `<base>` e `<nome>`:

```text
<base>/<nome>                        link relativo para a release em uso
<base>/.releases/<nome>/<rótulo>/    release imutável, somente leitura
<base>/.releases/<nome>/anterior     link para o rótulo anterior
<base>/.releases/<nome>/meta/        manifesto e metadados de cada release
<base>/.releases/<nome>/versao.json  commit instalado (servido por alias, ver Nginx)
```

Garantias, todas cobertas por teste:

- **Autenticidade.** O SHA-256 do `release.json` precisa bater com o hash aprovado por um canal externo à própria release (`--release-sha256`). Sem ele a instalação é recusada. O opt-out `--sem-autenticacao-de-origem` existe, é explícito e fica registrado como `NAO_VERIFICADA`.
- **Identidade imutável.** Um rótulo pertence a um commit, um manifesto e um `release.json`. O mesmo rótulo com outra identidade é recusado, e a instalação repetida informa o commit realmente instalado.
- **Consistência do backend.** As migrations declaradas, o `checksums.json` do pacote e o `engines` do `package.json` precisam bater com o manifesto.
- **Integridade e troca.** SHA-256 antes e depois da cópia; troca atômica por `rename` de link; trava por `mkdir`; downgrade e release retroativa só com opt-in; diretório real no lugar do link é recusado, e a release em uso precisa estar íntegra para ser substituída.
- **Persistência.** Nada é escrito, copiado ou apagado nas raízes persistentes, que entram só como links e sobrevivem à retenção. As gravações usam arquivo temporário exclusivo e nunca seguem um link pré-existente.
- **Árvore operacional ancorada por descritor, sem `chdir` e sem depender de revalidar caminhos.** Em `instalador/ancora.js`, cada operação abre a base uma vez e mantém cada diretório preso por descritor (`O_DIRECTORY` e `O_NOFOLLOW`, dono e permissões conferidos no próprio descritor). Toda chamada usa `/proc/self/fd/<fd>/<nome>`, com um nome simples de um componente, e o `npm ci` recebe `/proc/<pid>/fd/<n>` como diretório de trabalho. Nenhuma operação usa `process.chdir`. Fora do Linux a âncora padrão recusa (`PLATAFORMA_SEM_ANCORA`) e `instalar`, `reverter` e `reconciliar` ficam bloqueados; `identificar` ainda lê, com uma âncora de leitura que recusa qualquer escrita e informa `garantiaContraCorrida: false`. A âncora por caminho e qualquer `fsImpl` injetado (emulação) só existem em testes (`NODE_ENV=test`): a biblioteca recusa uma âncora injetada fora de teste (`ANCORA_DE_TESTE_FORA_DE_TESTE`) e a linha de comando nunca injeta nenhuma. O que cada defesa cobre, e onde ela termina, está na seção "Modelo de ameaça" abaixo.
- **Base e ancestrais atravessados por descritor.** O caminho da base é canonicalizado uma vez e atravessado componente a componente a partir da raiz, cada um aberto sem seguir link a partir do descritor do anterior, e cada ancestral é validado no descritor realmente atravessado: de root ou do usuário de implantação, sem escrita para grupo ou outros (ou com bit sticky e dono root, como `/tmp`). Um ancestral trocado por link depois da canonicalização faz a abertura falhar; um ancestral gravável por terceiros é recusado (`ANCESTRAL_NAO_CONFIAVEL`).
- **Nenhum arquivo com mais de um link é lido, gravado ou alterado.** O mesmo inode pode ser de outro caminho, por exemplo um dado persistente: identidade de inode não é isolamento. Todo arquivo aberto é conferido por `fstat` (regular e `nlink` 1, `ARQUIVO_COMPARTILHADO`); o diário é aberto sem criar, conferido (regular, do usuário de execução, um único link) antes da primeira gravação e só é criado, de forma exclusiva, quando não existe.
- **`node_modules` nunca existe antes do `npm ci` e depois é uma árvore própria.** O `npm ci` apaga o que encontrar nesse nome, inclusive o conteúdo do destino de um link (reproduzido com o npm real em dados sintéticos). Por isso o preparo é criado em 0700, `node_modules` ausente é exigido antes do processo (`NODE_MODULES_PREEXISTENTE`), e depois dele a árvore é inspecionada sem seguir links: precisa ser diretório real e nenhum link pode ser absoluto ou sair da própria árvore (`DEPENDENCIAS_INSEGURAS`). A mesma inspeção vale em `identificar` e na verificação de cada release.
- **Remoção só do que foi conferido.** Cada diretório é aberto sem seguir link e só é esvaziado se o descritor aberto for a entrada esperada (a identidade informada ou, sem ela, a vista imediatamente antes da abertura); o `rmdir` final só remove diretório vazio. Uma entrada trocada na janela entre a conferência e a abertura nunca é esvaziada. A limpeza do preparo e da release publicada é presa à identidade do preparo criado pela operação.
- **A árvore publicada é a árvore verificada.** Os descritores provam o conteúdo dos inodes copiados; antes de publicar, a árvore do preparo é percorrida por nome e cada diretório e arquivo precisa ser o mesmo inode registrado na cópia, sem entradas a mais nem a menos (`INTEGRIDADE_DIVERGENTE`). Depois do `rename`, a release publicada é verificada de novo por nome, com hash, antes de qualquer ponteiro.
- **O destino efetivo do ponteiro é conferido.** O link de release é um nome relativo, resolvido no momento do uso. Depois de apontá-lo, o inode que ele alcança é comparado com o da release aberta pelo descritor de `.releases/<nome>` que se manteve aberto; divergência (por exemplo, `.releases` trocado por outra árvore) desfaz o link e a operação falha (`PONTEIRO_DIVERGENTE`). É uma conferência do resultado, não uma garantia contra troca posterior.
- **Diário ilegível bloqueia.** Só a ausência do diário vale como diário vazio. Qualquer falha de leitura (E/S, link, arquivo compartilhado, tipo errado) é `DIARIO_ILEGIVEL`: `identificar` devolve `integro: false` e `consistente: false` com `diarioLinhasIlegiveis: null`, e `reconciliar`, `instalar` e `reverter` são recusados antes de reiniciar ou remover qualquer coisa. O mesmo vale para metadados (`META_ILEGIVEL`).
- **Links persistentes verificados.** O que cada release instalada tem como link persistente (nome e destino) fica registrado no `meta`. `identificar` e as verificações de instalação e de reversão exigem que cada link continue sendo link, aponte para o mesmo destino e resolva para dentro das raízes persistentes; link removido, trocado por arquivo ou redirecionado reprova a release como íntegra e bloqueia a instalação seguinte (`ATUAL_CORROMPIDA`). Na instalação, o destino que resolve para fora das raízes é recusado.
- **Recuperação entre as trocas.** As duas trocas de link e os registros ficam sob a mesma proteção: qualquer falha depois da primeira troca desfaz o que foi feito, de forma idempotente (só troca o que ainda difere). Se o desfazer também falhar, o diário **não** é fechado (`FALHA_SEM_DESFAZER`) e a próxima operação reconcilia pelo link em uso. Isso vale para `instalar` e `reverter`.
- **Rollback seguro.** O rollback automático aplica as mesmas travas da reversão manual: a release anterior precisa estar íntegra e compatível com as migrations e contratos observados **naquele momento**, e a coordenação precisa permitir (consulta nova). Sem destino comprovadamente seguro, nada é alterado, o `estado.json` recebe `critico` (motivo, release em uso, destino tentado, falha original e bloqueio), o diário fecha como `FALHOU` com `ROLLBACK_BLOQUEADO` e a identificação passa a relatar o estado crítico. Se o rollback ocorre mas a recuperação não é confirmada, o estado crítico também fica registrado.
- **Estado crítico bloqueia novas operações.** Com `critico` registrado, `instalar` (de outra release) e `reverter` são recusados (`ESTADO_CRITICO`). Só duas saídas existem: confirmar a release em uso (instalar a mesma release, com reinício, prova de processo e saúde) ou a exceção explícita `resolverEstadoCritico` (`--resolver-estado-critico`), que passa por todas as verificações e provas e fica registrada. Uma instalação ou confirmação comprovada limpa o estado crítico.
- **Falha depois do reinício nunca restaura uma prova antiga.** Antes de cada reinício o diário grava `REINICIANDO`. Se qualquer erro ocorre depois disso, voltar só os links deixaria o processo numa release e o link em outra; por isso a recuperação volta à release de antes da operação **com reinício e prova** (mesmas travas do rollback), e o estado só é declarado comprovado depois disso. Se a própria recuperação falha de forma encadeada (por exemplo, o estado não pode ser gravado), o diário fica aberto (`CRITICO`), o estado crítico é registrado quando possível e a identidade pública (`versao.json`) é escrita antes do estado, para que, se o estado falhar, ela já coincida com link e processo. A reconciliação de qualquer operação interrompida depois de `REINICIANDO` marca a release em uso como não comprovada **e** crítica, estando o link na release nova ou na antiga.
- **Nada concluído sem prova.** `INSTALADA`, `REVERTIDA` e `JA_INSTALADA` exigem processo (diretório e PID) e saúde comprovados. `reconciliar` não comprova nada: uma instalação interrompida cuja release nova está em uso fica registrada com `comprovada: false` (`NOVA_EM_USO_SEM_CONFIRMACAO`), `identificar` a reporta como não íntegra, e reinstalar a **mesma** release a confirma (resultado `CONFIRMADA`) com reinício, prova e saúde; se não provar, volta para a anterior com as travas do rollback. A idempotência de uma release já comprovada também confere processo e saúde, sem reiniciar; se divergir, cai na confirmação. Em componente estático não há processo: a comprovação é a integridade, e a prova HTTP é da verificação pós-publicação.
- **Coordenação e compatibilidade no instante da operação.** Depois do preparo (que inclui `npm ci` e pode demorar) e imediatamente antes de cada reinício, o instalador consulta de novo a coordenação e reavalia a compatibilidade. Se ficou ocupada, obsoleta ou incompatível, nada é reiniciado e, quando o link já havia sido trocado, ele volta. Na linha de comando, o arquivo de `--coordenacao` é relido (com as mesmas verificações de segurança) a cada consulta.
- **Diário e reconciliação.** Cada operação grava `INICIO`, `PREPARADA`, `TROCADA` e um passo final em `diario.jsonl`. Uma operação interrompida é reconciliada no começo da próxima (ou por `reconciliar`): o link anterior, o `estado.json` e o `versao.json` voltam a bater com o link em uso, inclusive quando o link já tinha voltado para a anterior (`ABORTADA`), e órfãs e preparos antigos são removidos.
- **Diário durável.** Cada passo é uma linha JSON anexada com `O_APPEND`, sem seguir link, modo 0600, com `fsync` do arquivo e, na criação, do diretório. `estado.json`, `versao.json` e metadados são gravados em arquivo temporário exclusivo com `fsync` antes do `rename` e `fsync` do diretório depois; a troca de link também sincroniza o diretório. `INICIO` e os passos intermediários são obrigatórios: se não puderem ser gravados, a operação para antes de seguir (`DIARIO_FALHOU`). Se só o passo final falhar, o aviso `DIARIO_NAO_GRAVADO` aparece no resultado e o diário fica aberto, de modo que a próxima operação reconcilia e exige confirmação. Uma cauda truncada por queda não engole a entrada seguinte, e as linhas ilegíveis são contadas e informadas por `identificar` (`diarioLinhasIlegiveis`), nunca interpretadas.
- **Durabilidade do conteúdo publicado, na ordem das transições.** Cada arquivo copiado e cada diretório do preparo (inclusive `node_modules`) recebe `fsync`; o diretório de preparo é sincronizado de novo depois de tornado somente leitura; só então ocorre o `rename` para a release, seguido do `fsync` da raiz de releases; depois o metadado (arquivo e diretório), depois a troca do link (e `fsync` do diretório da base), depois estado e `versao.json`, e por fim o passo final do diário. O ponteiro nunca é publicado antes do conteúdo estar sincronizado. Falha de `fsync` em qualquer etapa aborta antes de publicar. **Aviso em toda operação:** `instalar`, `reverter` e `reconciliar` fecham o resultado pela mesma função, que acrescenta `DURABILIDADE_NAO_GARANTIDA` sempre que um `fsync` de diretório não foi suportado. **Exigência por operação:** a exigência e a contagem de `fsync` não suportado pertencem à âncora de cada operação, nunca ao módulo, então uma instalação concorrente que tolera o aviso não enfraquece outra que exige durabilidade (teste de concorrência). **Garantia local versus validação real:** `EINVAL` e `ENOTSUP` no `fsync` de diretório (sistema de arquivos sem suporte) não são tratados como sucesso silencioso: são contados e o resultado traz o aviso `DURABILIDADE_NAO_GARANTIDA`, e com `exigirDurabilidade` (`--exigir-durabilidade`) a operação é recusada (`DURABILIDADE_NAO_SUPORTADA`). A ordem e as chamadas de `fsync` são provadas por teste local; que o disco realmente persiste não é provável sem Linux real, no sistema de arquivos do servidor e com corte de energia (A-11), e nenhuma homologação deve afirmar durabilidade enquanto esse aviso aparecer.
- **Prova de versão.** No backend, depois do reinício, o processo precisa estar executando a release nova (diretório de trabalho) e ter PID diferente do anterior; a saúde sozinha não aprova. O health da linha de comando também confere o nome do serviço. Sem `identificarProcesso` o backend não instala, salvo opt-out registrado.
- **Rastreabilidade.** Cada evento de instalação, confirmação, reversão e rollback do histórico registra usuário, a coordenação (situação, origem, consulta), o estado observado (banco, origem, coleta) e a fonte dos arquivos informados (caminho e SHA-256 do conteúdo efetivamente relido na última consulta, com a contagem de leituras, sempre a da consulta que de fato decidiu: a que autorizou a operação ou o reinício final, ou a que bloqueou; a evidência acompanha o objeto devolvido por aquela consulta e nada fica guardado no provedor, então operações concorrentes que o compartilham não trocam evidências); instalação e confirmação registram também autenticidade e hash do `release.json`. Os eventos de recuperação por reconciliação registram só o rótulo, a situação, o horário e se houve reinício.
- **Overrides efetivamente usados.** O evento e o `INICIO` do diário trazem `excecoes` com os overrides que de fato alteraram a decisão, não os que apenas foram permitidos: `permitirAnterior` (com rótulos de origem e destino) só quando houve downgrade, `permitirRetroativo` só para release retroativa, `permitirAtualDivergente` (com a contagem de problemas) só quando a release em uso estava divergente, `semAutenticacao`, `semComprovacaoDeVersao`, `permitirRoot` (só quando o processo realmente roda como root) e `resolverEstadoCritico`. Só nomes, rótulos e contagens: nenhum valor de configuração, caminho do servidor, conteúdo de arquivo ou o hash informado pelo operador é registrado.
- **Execução segura.** A linha de comando recusa rodar como root, recusa configuração que seja link, de outro dono ou gravável por grupo ou outros, exige caminho absoluto para o `npm` e para o reinício, e `identificar` aponta `versao.json` ou `estado.json` divergentes do link.
- **Política de operações por componente, igual em todas as interfaces.** A tabela `POLITICA_DE_COMPONENTES` (congelada, em `nucleo.js`) define o que cada tipo pode fazer. Componente estático (frontend e portal) instala, reverte, identifica e reconcilia, e nunca reinicia, consulta processo ou saúde, nem instala dependências: configuração com `reinicio`, `processo`, `saude`, `dependencias` ou `linksPersistentes` é recusada (`CONFIG_INVALIDA`), e a biblioteca descarta as dependências injetadas desse tipo. O backend, na linha de comando, só `identificar` e `reconciliar`; `instalar` e `reverter` são recusados com `COORDENACAO_NAO_HOMOLOGADA` antes de qualquer leitura. Na biblioteca a mesma recusa vale antes de qualquer leitura, preparo ou reinício, a menos que `deps.consultarCoordenacao` seja um provedor registrado como homologado (registro em `coordenacao.js`, vazio em produção, e que só aceita registros em `NODE_ENV=test`): uma função injetada, um arquivo ou um atestado não excluem um backup concorrente. Mesmo com provedor homologado, a coordenação é revalidada antes da troca e de cada reinício. O backend segue bloqueado para deploy, reinício e rollback enquanto não houver coordenação homologada com o D-ORF-6.

O instalador roda **no servidor**, com Node 22 e só o núcleo do Node. A pasta
`instalador/` é copiável sozinha. Ela deve ser instalada por uma etapa de operação
própria, fora do fluxo de release, porque é a âncora de confiança da verificação, e o
arquivo de configuração é uma superfície de execução de comandos: deve pertencer ao
usuário de implantação, com modo 0600 ou 0640.

Limites conhecidos: a autenticidade depende de quem entrega o hash aprovado (pendência
A-3); a prova de versão e as âncoras por descritor usam `/proc` e só valem em Linux, e fora dele o instalador fica bloqueado; uma trava deixada por queda
brusca exige remoção manual, de propósito; o conteúdo de `node_modules` depois
da instalação não é conferido arquivo a arquivo, pois só o lockfile garante essas dependências (a estrutura é: diretório real e links que não saem da árvore).

## Modelo de ameaça do instalador

O escritor considerado é qualquer processo com permissão de escrita nos diretórios operacionais da release, nos ancestrais da base ou nos diretórios persistentes. Os diretórios operacionais e os ancestrais são recusados quando graváveis por grupo ou outros, então esse escritor é o mesmo usuário de implantação ou root. O Node não tem `openat`, `unlinkat` nem `renameat`: nenhuma camada em JavaScript impede esse escritor de trocar o NOME de uma entrada num diretório que ele consegue escrever. O que a arquitetura faz, e o que ela não faz:

- **Faz:** nunca age sobre uma entrada sem conferir, no descritor aberto, que é a esperada (identidade, tipo e contagem de links); resolve nomes pelo kernel contra o inode já aberto (`/proc/self/fd`); falha fechada quando a conferência não bate; desfaz o ponteiro quando o destino efetivo difere do verificado; não apaga diretório não vazio por `rmdir`; e recusa tudo o que não consegue garantir (fora do Linux, sem coordenação homologada).
- **Não faz:** impedir uma troca de nome feita depois da última conferência e antes do uso seguinte, por um escritor com o mesmo usuário ou root. Os pontos conhecidos são: (1) o ponteiro final, que é um nome relativo e só é conferido depois de gravado; (2) um processo externo (`npm ci`) que resolve `node_modules` por nome dentro do preparo enquanto roda: o preparo é 0700 e o nome precisa estar ausente quando o processo começa, mas um escritor com o mesmo usuário pode plantá-lo durante a execução, e nenhuma camada local fecha essa janela; (3) um ancestral da base trocado por outro diretório REAL do mesmo dono depois da travessia.
- **Mitigação operacional exigida (A-3):** o usuário de implantação não deve ter permissão de escrita nas raízes persistentes além do estritamente necessário, e nenhum outro processo do mesmo usuário deve escrever na árvore de releases durante uma operação. Sem isso, os pontos acima ficam abertos. O backend, único componente que roda `npm ci`, segue bloqueado na linha de comando e na biblioteca enquanto não houver coordenação homologada com o D-ORF-6.

## O que se prova localmente e o que exige Linux real

| Garantia | Prova local (macOS ou CI) | Exige Linux real |
|---|---|---|
| Nenhuma operação usa `process.chdir` | varredura do código e espião em tempo de execução | |
| Toda mutação usa `/proc/self/fd/<fd>/...`, nunca caminho remontado | modelo do `/proc` executa a lógica inteira e confere cada caminho | |
| Hardlink: diário, leitura e `chmod` por nome com mais de um link são recusados | testes com hardlink pré-existente e criado antes da finalização | |
| `node_modules` ausente antes do processo e árvore própria depois | testes com link pré-existente, link criado pelo processo e links que saem da árvore; sem npm real | comportamento do `npm ci` em Linux (`LINUX_NÃO_COMPROVADO`; só em ambiente isolado e sintético) |
| Remoção não esvazia diretório substituído | troca na janela entre conferência e abertura, em duas âncoras | |
| Ancestrais da base atravessados e validados por descritor | troca por link e ancestral gravável, em duas âncoras | resolução real pelo kernel (`LINUX_NÃO_COMPROVADO`) |
| Árvore publicada igual à verificada; verificação final por nome | troca de subdiretório, de arquivo, arquivo extra e alteração depois do `rename` | |
| Destino efetivo do ponteiro | `.releases` trocado depois da abertura das âncoras (modelo) | resolução do kernel (`LINUX_NÃO_COMPROVADO`) |
| Diário ilegível bloqueia integridade, reconciliação, instalação e reversão | `EIO`, link e falha encadeada | |
| Aviso de durabilidade em `instalar`, `reverter` e `reconciliar`; exigência por operação | `EINVAL` simulado em cada operação | `fsync` realmente persistir (A-11) |
| Evidência de coordenação isolada por operação | duas instalações concorrentes com o mesmo provedor | |
| Backend bloqueado na biblioteca e na linha de comando; âncoras de teste só em `NODE_ENV=test` | recusas antes de qualquer reinício | |
| Troca real de ancestral, de `.releases` e de subdiretório durante o processo externo | | testes pulados fora do Linux e executados no CI (`LINUX_NÃO_COMPROVADO` até a primeira execução) |
| Fora do Linux a instalação é bloqueada | `PLATAFORMA_SEM_ANCORA` na âncora padrão e na linha de comando | |

O modelo do `/proc` prova a lógica e o formato dos caminhos, não a resolução do kernel: nenhuma homologação pode
tratar a prova local como prova de isolamento contra substituição concorrente.

### Homologação em Linux real (sessão 7, 06/11/2026)

Executada no Mac, em VM Lima `hml-val` sintética (vz, aarch64, Ubuntu 24.04, 2 CPUs, 4 GiB, disco de 20 GiB, sem
montagens, SSH só em `127.0.0.1:60022`), isolada por nftables com cobertura COMPLETA e sem rota padrão IPv4 e IPv6
antes de qualquer execução. A entrega v3 (22 arquivos, SELO `b1d9fe41bab1efb989b4e7f6d2dd8134043109829329b694d1be479bc0767375`)
leva 12 arquivos deste repositório, os 3 testes só Linux (`correcoes-ancora`, `correcoes-bloqueantes` e `correcoes-codex2`)
e 9 componentes de `deploy/hml/`, fixados em `MANIFESTO-ARQUIVOS.sha256`
(`f6f1ba905023dd2ac121a2e195e8a150895790f4551c9abdf96819bb071b8b87`). Dez deles continuam idênticos, byte a byte, aos desta
versão. Depois da homologação, a correção do CI da PR #92 alterou dois: `deploy/hml/empacotar-backend.js` (exclusão explícita
de `ops/`, que a `main` passou a ter com o D-ORF-6) e `correcoes-codex2.test.js` (precondição determinística do teste de troca
de inode, que o ext4 invalidava ao reaproveitar o número do inode). Nenhum dos 11 testes só Linux mudou, e a validação de
identidade do instalador não foi tocada.

Comprovado: cadeia F0b a F9b com `SESSAO7_COMPLETA_OK`; L1 com os 11 testes só Linux aprovados em disco (ext4) e em
tmpfs, 66 eventos sem skip, umask 0022 (o ponto que reprovou a sessão 6); L2 com a reverificação dos 11 e as
propriedades do kernel (`/proc/<pid>/cwd`) nas duas áreas; L3 com `fsync` de arquivo e de diretório `ok` nas duas áreas
(registro, não prova de persistência); fechamento com as entradas intactas e quatro verificações de isolamento;
verificador independente só no Mac; encerramento gracioso da VM, sessões 1 a 6 intactas (manifesto
`d0255b042b671151a2ba90b8b46797acaa2d6de81ffbabda5289890931b45d96`). Da tabela acima, isso cobre a resolução real
pelo kernel das âncoras e dos ancestrais e as trocas reais de ancestral, `.releases` e subdiretório; da pendência A-11,
cobre o `fsync` em ext4 e tmpfs, a travessia por descritor e a resolução por `/proc/self/fd`.

Não comprovado, e por isso as linhas `LINUX_NÃO_COMPROVADO` e o A-11 permanecem: o `npm ci` com `node_modules` que seja
link (nenhum dos 11 testes executa npm), a queda abrupta entre as trocas e o corte de energia, a trava compartilhada do
D-ORF-6 e o sistema de arquivos do servidor real, já que a VM é sintética.

Evidências fora do Git: pacote da sessão em `03-evidencias/CD-Homologacao-Linux-20261103/sessao-7` (`HASHES-SESSAO7.txt`
`5f06e6dd2d9b22ae9ae5f4df21df5360a99c988d85ec522989a5901913b5154b`, `PINS-SESSAO7.txt`
`05a1bed0f12c5fb8dc87cabe3cfb768115238b1f15a36070b6945d9fa308a323`, `registros/SHA256-REGISTROS.txt`
`527d9c2ca3084c9498536166f62918af1fb15e3060aff562082efe6f13997749`) e evidência em
`~/SafeWorkValidacaoLinux/evidencia/sessao-7` (220 arquivos, árvore
`70fa82266037c41dc0a6506093f2188b1aea9a0b3cb8830ee6c02f965cb7e308`; log da sessão
`ca642f0ed8f7b30c2c14aab12ddeec5374b04b7f26f974765ce0188ea6ebc956`). Imagem Ubuntu, VM, tarballs do Node e
evidências binárias não entram no repositório.

Ressalva registrada: na validação do gêmeo do gerador (rodada 2), os testes `teste-s7-f3`, `teste-s7-f0` e
`teste-s7-completa` apagaram e recriaram com `rm -rf` três sandboxes históricas de medição de nome fixo, e a autolimpeza
removeu as recriadas; nenhuma evidência real foi perdida e as saídas das medições ficaram preservadas. Registro em
`~/SafeWorkValidacaoLinux/s7-rodada2-ressalva-sandboxes-20261106.txt`
(`acb7eb78874191f45066e20a2671d50dd0ed629e01b4002bde8a0c9ef0adf748`); a decisão de ajustar esses testes é pendência.

## Rollback e compatibilidade

| Situação | Resultado |
|---|---|
| Banco com migration que a release não tem | bloqueado (`BANCO_A_FRENTE_DO_CODIGO`) |
| Release com migration que o banco não tem | bloqueado (`MIGRATIONS_PENDENTES`); aplicar migrations é gate separado e anterior |
| Contrato de dados em versão maior que a da release, ou desconhecido por ela | bloqueado |
| Estado persistente observado ausente, malformado, sem o campo `contratos` ou com mais de 15 minutos | bloqueado |
| Release que não declara `contratos`, ou cujas migrations declaradas diferem do pacote | bloqueada |
| Mesmo conjunto de migrations e contratos compatíveis | liberado |

Isso espelha a guarda de inicialização do backend, que já recusa subir nos dois
primeiros casos. O **estado observado** (`banco`, `origem`, `coletadoEm`, `migrations`,
`contratos`) precisa vir de uma sonda de leitura que ainda não existe e exige acesso ao
banco de homologação (pendência A-5). Contratos de dados persistentes são declarados em
`deploy/hml/contratos-persistentes.json`, hoje vazio, porque nenhum foi homologado.

## Verificação pós-publicação

`verificar-publicacao.js` só faz GET. No frontend confere `/versao.json` (commit, rótulo
e hash do manifesto), o SHA-256 de cada arquivo servido, CSP mínima, `no-cache` em
html/js/css, `nosniff` e que arquivos de outro componente, dotfiles e `.releases` não
são servidos. Na API confere `/api/health`. Esse endpoint só prova que o processo está
vivo: não verifica banco nem identifica a versão do backend. Um endpoint de prontidão
exigiria alterar o backend e fica como decisão (D-3 no relatório da rodada). Enquanto
isso, a versão em execução é provada pelo instalador (diretório de trabalho e PID do
processo), e o health da linha de comando exige o nome do serviço.

A identificação e o manifesto são conferidos de forma estrita. `versao.json` precisa ser
um objeto com exatamente `commit`, `componente`, `manifestoSha256` e `rotulo`, todos
texto e iguais aos esperados; `null`, lista, texto solto, campos faltando ou a mais
reprovam a identificação. A identificação esperada precisa ser completa e bem formada
(commit com 40 e hash com 64 hexadecimais minúsculos, rótulo e componente válidos), senão
a verificação é recusada (`VERIFICACAO_ENTRADA_INVALIDA`): campo ausente nunca "bate" com
campo ausente. Pela linha de comando, o manifesto do componente só é aceito
(`MANIFESTO_INVALIDO` caso contrário) se o SHA-256 do arquivo for o declarado no
`release.json`, o número de linhas for o de `arquivos`, cada linha for
`<sha256 minúsculo>␣␣<caminho>`, sem caminho absoluto, com traversal, barra invertida,
segmento vazio ou `.`, e sem caminho repetido; o `release.json` precisa trazer commit,
rótulo e seção do componente válidos. Os manifestos dados em `--isolamento-de` passam
pelo mesmo formato. Manifesto vazio não é verificado.

O avaliador de CSP é restritivo: nas diretivas de recurso só aceita `'self'`, `'none'`,
hash, nonce e host `https://` explícito, sem curinga nem caminho; recusa esquemas soltos
como `https:` e `ws:` e `data:` fora de `img-src`; exige `form-action`; recusa
`'unsafe-inline'` fora de `style-src-attr`, `'unsafe-hashes'` fora dos atributos e
`'unsafe-eval'` em qualquer lugar. O renderizador Nginx herda esse rigor.

## CSP e Nginx

`gerar-csp.js` calcula os hashes dos scripts e estilos inline. Resultado medido sobre os
pacotes atuais:

| Pacote | Páginas | Resultado |
|---|---|---|
| Painel Privado | 8 | **viável**: 1 hash de script, 8 de estilo, 13 atributos `style` cobertos só em `style-src-attr`, nenhum host externo, nenhum manipulador inline |
| Portal | 37 | **viável** desde a P-HML-02 (07/11/2026): 24 hashes de script, 26 de estilo, 2 manipuladores inline cobertos por hash em `script-src-attr 'unsafe-hashes'`, 1.267 atributos `style` cobertos só em `style-src-attr`, hosts externos `challenges.cloudflare.com` (script, frame, connect), `fonts.googleapis.com` (style) e `fonts.gstatic.com` (font); 0 problemas |

Histórico: até a P-HML-02 o Portal estava **bloqueado**, porque em 21 páginas o item de menu da
própria página era `<a class="active" href="javascript:void(0)" …>`, que a CSP bloquearia. A
correção trocou esse `href` por `role="link" tabindex="0" aria-current="page"` (item sem ação,
focável, anunciado como página atual), sem alterar classes, `data-pagina`, conteúdo ou
comportamento, com uma edição focal autorizada em `pages/materials.html`. O gerador ainda emite
o aviso `MANIPULADOR_EM_JS` para `js/pagina-base.js`: é falso positivo, disparado por um
comentário que contém o texto `onclick="..."`; os manipuladores reais do menu (`toggleSidebar()`,
`closeMobileMenu()`) entram por hash. Os modelos Nginx estão prontos e validados, mas **não são
aplicados**. Os pontos que a operação ainda precisa cumprir estão em `deploy/hml/nginx/LEIA-ME.md`.

Decisões dos modelos depois da auditoria: sem `http2` (a diretiva `http2 on` exige nginx
1.25.1 ou superior e a versão da homologação é desconhecida); a porta 80 atende o desafio
ACME num caminho fixo (`RAIZ_ACME`) e redireciona o resto para o domínio fixo, nunca por
`$host`; e `versao.json` só responde a `127.0.0.1`, `::1` e à rede de verificação
declarada (`REDE_VERIFICACAO`: IP único ou rede estreita, IPv4 a partir de /24 e IPv6 a
partir de /64, com os endereços validados de verdade; `0.0.0.0`, `::` e faixas largas são
recusados), com 403 para os demais. `HSTS_MAX_AGE` vai de 300 a 63072000 segundos e nunca
desliga o HSTS. No Portal, o namespace `/api/plataforma` é negado (404) em qualquer caixa,
com ou sem barra final, sobre a URI normalizada (`$uri`), porque o prefixo `^~` do Nginx é
sensível à caixa e exige a barra; o Painel só encaminha o prefixo exato e responde 404 a
qualquer outra variante de `/api/`. Tudo isso é verificação estática do modelo: o
comportamento real do Nginx não foi provado. Isso reduz a exposição pública do commit instalado, que facilita
identificar versões. Com um proxy ou CDN na frente do Nginx, `$remote_addr` seria o do
proxy e essa restrição precisaria ser revista.

## Interface de coordenação com o D-ORF-6

O D-ORF-6 é frente protegida e **nenhuma trava de operação foi homologada**. O que existe
aqui é só o contrato que um provedor futuro deverá cumprir e a política do instalador
enquanto ele não existir.

Estado que o provedor informa:

```json
{ "situacao": "LIVRE | OCUPADO | DESCONHECIDO", "origem": "texto", "consultadoEm": "ISO-8601", "detalhe": "opcional" }
```

| Estado informado | Troca ou reversão do backend |
|---|---|
| `LIVRE`, com origem e consulta de até 5 minutos | liberada |
| `OCUPADO` | bloqueada; atestado manual **não** substitui |
| `DESCONHECIDO`, ausente, malformado ou `LIVRE` sem horário válido | bloqueada; atestado manual **também não** libera (ele não impede um backup concorrente) |

Qualquer estado que declare `OCUPADO`, em qualquer caixa e com ou sem espaços, bloqueia,
mesmo com origem ausente, vazia ou inválida: nunca é rebaixado a `DESCONHECIDO`. O
histórico registra a situação, a origem e a fonte do estado de coordenação usado em cada
operação. O atestado humano foi removido como liberação: o parâmetro `atestado` é aceito
só para compatibilidade de chamada e nunca libera, e a flag
`--atesto-sem-operacao-de-backup` é rejeitada na linha de comando
(`ATESTADO_NAO_LIBERA_BACKEND`).

Origem e banco em branco (vazios, só espaços, espaços Unicode ou caracteres de largura
zero) valem como ausentes: um `LIVRE` sem origem real vira `DESCONHECIDO`, e um estado
observado sem banco ou origem reais é inválido. Qualquer menção a ocupação no campo
`situacao`, em qualquer forma ou profundidade (texto, lista, objeto aninhado, plural ou
com caracteres de controle), também bloqueia.

**Bloqueio operacional enquanto não houver coordenação homologada.** Uma consulta isolada
não é garantia de exclusão: entre a consulta e a ação um backup pode começar. Por isso o
instalador a repete imediatamente antes da troca (depois do preparo) e antes de cada
reinício, inclusive o do rollback, e a ação é recusada se o resultado deixou de permitir.
Ainda assim sobra uma janela entre a última consulta e o reinício, que só uma trava
compartilhada, atômica e homologada com o D-ORF-6 elimina, e que precisaria valer durante
**toda** a operação, inclusive a recuperação. Enquanto ela não existir, **o backend fica
operacionalmente bloqueado para deploy, reinício e rollback**: o provedor padrão devolve
`DESCONHECIDO`, o atestado não libera, e a linha de comando (único ponto de entrada
operacional) recusa `instalar` e `reverter` do backend com `COORDENACAO_NAO_HOMOLOGADA`,
mesmo com `--coordenacao` apontando um arquivo `LIVRE`, porque um arquivo estático não
exclui nada. Só `reconciliar` e `identificar`, que não reiniciam nada, seguem permitidos
para o backend. A biblioteca aceita provedores injetados por código (é por onde um
provedor homologado entrará) e aplica a mesma revalidação antes de cada reinício. O estado
`LIVRE` vale por 5 minutos; uma operação que passe disso (por exemplo, por um `npm ci`
longo) é recusada na revalidação. O estado observado do banco também é um instantâneo (até
15 minutos): reavaliá-lo não prova o banco atual, e essa sonda de leitura ainda não existe
(A-5).

Frontend estático não depende da coordenação. O provedor padrão devolve `DESCONHECIDO`
com a origem "nenhuma trava do D-ORF-6 homologada". Decisões que cabem ao D-ORF-6, não a
este CD: onde fica a trava, quem a escreve, como expira e como é provada a ausência de
escrita durante backup. Esta interface não implementa, presume nem substitui nada disso,
e o backup consistente continua regido por [Operação](operacao.md).

## Histórico do desenho do job `publicar` — superado pela Etapa 52

Na preparação anterior, o trecho abaixo era uma proposta e não existia no workflow.
Ele é preservado como registro histórico, não como procedimento atual. O job real
está em `.github/workflows/deploy-hml.yml`; o contrato vigente, inclusive a correção
53A da fila e o caráter operacional de `--pedido`, está em
`publicacao-homologacao-automacao.md`. As pendências A-0 a A-11 abaixo também são
fotografias daquela preparação; o environment foi informado como configurado por
Ramires, sem nova inspeção remota nesta entrega.

```yaml
publicar:
  needs: [validar, empacotar]
  if: ${{ inputs.publicar == true && vars.HML_PUBLICACAO_HABILITADA == 'true' }}
  runs-on: ubuntu-latest
  environment: homologacao        # revisor obrigatório e só a branch main
  permissions:
    contents: read
    id-token: write               # somente neste job, para OIDC
  concurrency: { group: publicar-hml, cancel-in-progress: false }
  steps:
    - baixar o artefato da release e conferir os manifestos com sha256sum -c
    - assumir a role AWS por OIDC (ação fixada por SHA, role de menor privilégio)
    - enviar a release para o armazenamento versionado, prefixo da própria release
    - gravar o ponteiro da release aprovada (rótulo, commit, hash do release.json, autor, run)
    - aguardar o instalador do servidor aplicar e chamar verificar-publicacao.js
    - falhar a execução se a verificação reprovar
```

Controles do desenho:

- **Interruptor duplo.** O job só executa com a entrada `publicar=true` **e** a variável de repositório `HML_PUBLICACAO_HABILITADA=true`. Sem a variável, que não existe hoje, nada roda mesmo depois do merge.
- **Aprovação humana.** O environment `homologacao` exige revisor e restringe a branch `main`. Como o repositório tem um único titular, "impedir autoaprovação" não é aplicável; o controle compensatório é o interruptor de variável, que só quem administra o repositório altera.
- **Menor privilégio.** `id-token: write` só nesse job. A role confia apenas em `repo:ramirespaes/Gestao_Epi_Fabricas:environment:homologacao` e pode escrever apenas no prefixo de releases. Nenhuma chave de longa duração.
- **Repositório público.** Logs e artefatos são públicos: nada de segredo em saída, nomes de recurso mínimos, e a release só contém arquivos já públicos por natureza.
- **Modelo de puxar.** O workflow não abre acesso de entrada ao servidor. Quem aplica a release é o instalador, acionado no servidor por um agente a ser definido (pendência A-3).
- **Ordem.** Migrations, depois backend, depois frontend, cada etapa com seu gate. O job do frontend não depende do backend; o do backend depende de migrations aplicadas e do estado observado.

## Pendências que dependem de autorização para AWS ou para o GitHub

| Código | Pendência |
|---|---|
| A-0 | inspeção somente leitura da homologação atual (sistema, Node, processos, servidor web, banco, DNS) |
| A-1 | criar o environment `homologacao` com revisor e restrição à `main`; criar a variável do interruptor |
| A-2 | IAM: provedor OIDC, role restrita ao environment e à `main`, e o armazenamento de releases |
| A-3 | usuário de implantação, diretórios, instalação do instalador, agente que busca a release, serviço e servidor web; o agente precisa entregar ao instalador o hash aprovado do `release.json` por um canal separado da release |
| A-4 | validar no servidor `npm ci --omit=dev --ignore-scripts` e o carregamento de `argon2` e `sharp` |
| A-5 | sonda de leitura do estado persistente observado e migrations de homologação em gate manual, com backup antes |
| A-6 | `.env` de homologação com `GUARDA_BANCOS_PERMITIDOS`, `PLATAFORMA_HOST`, origens de CORS, `TRUST_PROXY_HOPS` e demais variáveis, com segredos fora do Git |
| A-7 | adotar o diretório real atual como primeira release (passo manual, o instalador o recusa de propósito) |
| A-8 | TLS, DNS e aplicação dos modelos Nginx depois de `nginx -t` |
| A-9 | primeira publicação real, só do frontend; depois o backend |
| A-10 | configurar `processo.pidComando` do backend, validar a prova de versão em Linux real e definir `REDE_VERIFICACAO` e `RAIZ_ACME` nos modelos |
| A-11 | validar em Linux real, no sistema de arquivos do servidor, o `fsync` de arquivo e diretório (e que nenhum aviso `DURABILIDADE_NAO_GARANTIDA` apareça), o `O_NOFOLLOW`, a travessia da base por descritor e a resolução por `/proc/self/fd` das âncoras, o comportamento do `npm ci` com um `node_modules` que seja link (em diretório sintético isolado, nunca em dados reais), inclusive o diretório de trabalho do `npm ci` por `/proc/<pid>/fd/<n>`, com o usuário e as permissões de implantação (os testes que só o Linux executa rodam no CI), a queda abrupta entre as trocas de link e depois do reinício (reconciliação pelo diário), e o corte de energia; homologar com o D-ORF-6 a trava compartilhada que libera o backend, sem atestado humano |

Decisão sobre o Portal (resolvida em 07/11/2026, P-HML-02): os 21 `javascript:void` do item ativo
do menu foram removidos e o gerador aceita a CSP do Portal com 0 problemas; o aviso sobre
`js/pagina-base.js` é falso positivo em comentário. A aplicação da CSP no servidor continua
dependendo da publicação pelos modelos Nginx (A-8), ainda não executada.
