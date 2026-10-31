# Biblioteca Padrão de Imagens — provisionamento e verificação

Procedimento operacional para ambientes que usam a Biblioteca de Imagens de materiais (homologação e produção). Não vale para ambiente que, de propósito, não usa armazenamento de imagens.

## 1. O que o deploy faz e o que não faz

- As migrations (`090_create_biblioteca_imagens_material.sql`) criam as tabelas **vazias**.
- O deploy do código e das migrations **não** provisiona nem valida a dependência externa da Biblioteca Padrão: o diretório de imagens, os arquivos e os registros de `imagens_padrao` entram por uma **importação offline separada**.
- `/api/health` responde `ok` com a biblioteca vazia. Tabelas existentes e HTTP 200 **não** provam que a biblioteca está provisionada.
- Por isso a publicação tem um portão próprio, `npm run imagens:prontidao`, que reprova um ambiente que exige a biblioteca mas não a recebeu, inclusive quando o banco e o diretório estão ambos vazios.

## 2. Variáveis de ambiente

| Variável | Quem lê | Valor |
|---|---|---|
| `IMAGENS_ARMAZENAMENTO_DIRETORIO` | servidor e comandos de imagens | caminho absoluto e canônico, fora do repositório e de pasta pública. **Obrigatória onde a biblioteca estiver habilitada.** Ausente deixa o recurso indisponível. |
| `IMAGENS_BIBLIOTECA_PADRAO` | `npm run imagens:prontidao` e a guarda de inicialização (`npm start`) | `obrigatoria` ou `desabilitada`. No comando de publicação, sem valor ele **recusa**: a omissão nunca vale como desabilitada. Na guarda de inicialização, sem valor (ou vazio) não há exigência e nada muda; `obrigatoria` faz o backend recusar subir com a biblioteca ausente ou inconsistente (seção 6); outro valor é recusado. O servidor em si não a lê. |

Diretório de imagens: pastas `0700` e arquivos `0600`, de propriedade do usuário que executa a aplicação. A verificação aceita `0700` e `0750` (um grupo de serviço ou de backup só lê), e **recusa** qualquer acesso de "outros" e escrita de grupo. O comando precisa rodar como o usuário da aplicação (ou como root): ele exige leitura, escrita e travessia no diretório, para não aprovar um ambiente que o próprio serviço não consegue usar.

## 3. Estados da verificação

| Estado | Quando | Saída |
|---|---|---|
| `DESABILITADA` | política `desabilitada`. Nada é consultado (nem banco, nem diretório, nem pacotes). | 0 |
| `NAO_PROVISIONADA` | política `obrigatoria` e falta provisionar: `IMAGENS_ARMAZENAMENTO_DIRETORIO` ausente, diretório inexistente, ou imagens do plano sem registro/arquivo (incluindo banco **e** diretório vazios). | 4 |
| `INCONSISTENTE` | localização inválida; diretório que é arquivo, link simbólico, caminho não canônico ou com permissão inadequada; divergência entre banco, pacote e arquivos (arquivo ausente de registro existente, conteúdo diferente, nome em uso por outra imagem); veredito `RECUPERAVEL` ou `INVESTIGAR` do verificador de integridade. | 5 |
| `PROVISIONADA_INTEGRA` | todas as imagens de todos os pacotes do plano têm registro e arquivos conferidos e o armazenamento está íntegro. Sobras sem registro não são dano. | 0 |

Outras saídas: `1` falha de execução; `2` argumentos, política ou destino inválidos; `3` plano ou pacote sem integridade comprovada (hash, manifesto, formato, pacote indisponível). **Qualquer saída diferente de 0 deve reprovar a publicação**; o estado vem impresso na linha `ESTADO=` (ou no campo `estado` com `--json`).

## 4. O pacote aprovado (externo ao Git)

Os binários **não** entram no Git. Cada pacote é um ZIP com `MANIFESTO_SHA256.csv`, os originais (só conferidos por hash), os PNG padronizados 1024×1024 e as miniaturas WebP 320×320. A importação confere o SHA-256 do ZIP e de **todos** os arquivos contra o manifesto antes de gravar qualquer coisa.

### Plano de pacotes aprovados

Um JSON, mantido fora do Git, junto dos pacotes:

```json
{
  "versao": 1,
  "pacotes": [
    { "arquivo": "<nome do ZIP>.zip", "sha256": "<SHA-256 do ZIP, 64 hexadecimais minúsculos>", "quantidade": 30 }
  ]
}
```

- `quantidade` é o número de imagens do manifesto daquele ZIP (1 a 30). A biblioteca cresce **acrescentando pacotes ao plano**, não alterando código.
- `arquivo` é só o nome do ZIP (sem caminho); os ZIPs ficam todos na pasta informada em `--pacotes`.
- Chaves exatas, nomes e hashes não podem se repetir.

### Fonte de aprovação confiável

O plano **não se autentica sozinho**. O SHA-256 do próprio arquivo do plano (`--plano-sha256`) tem de vir **de fora** da pasta que contém o plano e os pacotes: do registro de aprovação da publicação (PR/ticket de release), de variável protegida do pipeline ou de quem aprovou. Quem aprova o plano aprova, em cadeia, o hash de cada ZIP nele listado. Calcule o hash com:

```bash
shasum -a 256 plano-pacotes-padrao.json
```

### O que está comprovado sobre os 31 arquivos

- **Ambiente local (cópia de homologação):** a biblioteca de 31 imagens veio de **dois** ZIPs, ambos importados com este mesmo importador:
  - `SafeWork_Biblioteca_30_EPIs_Padronizada_RECONSTRUIDO_20261017.zip` — 30 imagens, SHA-256 `21d80020eee4372e406fc052a6efc2ffff543c9211def70cd1c256c5cfb61407` (reconstruído do conteúdo preservado; o ZIP original desapareceu e tinha SHA-256 `23044e37…5b55`);
  - `SafeWork_Biblioteca_31a_Imagem_Calca_Aluminizada_20261019.zip` — 1 imagem (`--quantidade 1`), SHA-256 `c6bb1c0af3f0b1ed4bdb459af4ecfc2e00dc5200e38e62710816661e0e7d3fce`.
- **Recuperação manual na AWS (HML):** informada a existência de 31 registros importados e 31 conjuntos de arquivos, mas **não há registro, nas evidências disponíveis, de quais ZIPs ou hashes foram usados**. Antes de montar o plano da AWS, confirme com quem executou a recuperação; não presuma que foram exatamente os dois ZIPs acima.

## 5. Instalação única por ambiente

**Pré-condição: pacotes aprovados e hashes.** Nenhuma instalação começa sem os ZIPs aprovados, o plano (seção 4) e o SHA-256 aprovado de cada ZIP e do plano, todos obtidos do registro de aprovação da publicação. Não presuma quais pacotes algum ambiente anterior usou (por exemplo, a recuperação manual feita na AWS HML não deixou registro dos ZIPs ou hashes): sem a lista aprovada, a instalação não é feita.

Executar uma vez, com o usuário da aplicação, **depois** das migrations e **antes** de religar o tráfego:

1. Criar o diretório (fora do repositório) e restringir o acesso:
   ```bash
   install -d -m 700 -o <usuario-da-aplicacao> /caminho/absoluto/imagens-material
   ```
2. Definir no ambiente do serviço (nunca em `.env.example` com valor real): `IMAGENS_ARMAZENAMENTO_DIRETORIO=/caminho/absoluto/imagens-material` e, para a verificação, `IMAGENS_BIBLIOTECA_PADRAO=obrigatoria`.
3. Disponibilizar os ZIPs aprovados e o plano numa pasta de trabalho (fora do repositório e do diretório de imagens) e conferir cada ZIP **sem tocar banco nem disco de imagens**:
   ```bash
   npm run imagens:importar-padrao -- --pacote /pacotes/<zip> --sha256 <SHA-256 deste ZIP, conforme o plano> --quantidade <n> --verificar
   ```
4. Obter nome e OID do banco de destino (a importação os confere na conexão que grava):
   ```sql
   SELECT current_database(), oid FROM pg_database WHERE datname = current_database();
   ```
5. Para **cada** pacote do plano: simular e, só depois, gravar:
   ```bash
   npm run imagens:importar-padrao -- --pacote /pacotes/<zip> --sha256 <hash> --quantidade <n> --banco-autorizado <nome> --banco-oid <oid> --dry-run
   npm run imagens:importar-padrao -- --pacote /pacotes/<zip> --sha256 <hash> --quantidade <n> --banco-autorizado <nome> --banco-oid <oid> --executar
   ```
   Não use `--mapeamento`: a biblioteca padrão entra sem sugestões de tipo nem vínculos automáticos com materiais.
6. Reiniciar o serviço para que ele carregue a variável do diretório, se ainda não a tinha.
7. Rodar a verificação da seção 6 e exigir `ESTADO=PROVISIONADA_INTEGRA`.

## 6. Verificação em cada publicação

Depois das migrations e antes de liberar a versão (somente leitura; não importa, não cria diretório, não grava no banco):

```bash
IMAGENS_BIBLIOTECA_PADRAO=obrigatoria npm run imagens:prontidao -- \
  --plano /pacotes/plano-pacotes-padrao.json \
  --plano-sha256 <hash aprovado do plano, vindo de fora da pasta> \
  --pacotes /pacotes \
  --banco-autorizado <nome> --banco-oid <oid>
```

- **Identidade do banco obrigatória.** Com `obrigatoria`, `--banco-autorizado` e `--banco-oid` são exigidos (sem eles: saída 2, nada é lido). O comando confere o nome e o OID do banco da **conexão** (`current_database()` e `pg_database.oid`) contra esses valores, antes de ler qualquer imagem: um `DB_*` que aponte para outro ambiente (por exemplo, uma cópia que tem a biblioteca) nunca produz `PROVISIONADA_INTEGRA`. Esses dois valores vêm da **autorização escrita da publicação**, nunca de `DB_NAME` nem do `.env` do próprio ambiente; obtenha-os com a consulta da seção 5 feita por quem autoriza.
- Ambiente que não usa imagens: `IMAGENS_BIBLIOTECA_PADRAO=desabilitada npm run imagens:prontidao` (devolve `ESTADO=DESABILITADA`, saída 0, sem consultar nada e sem exigir plano nem identidade). A política é sempre explícita no pipeline: sem a variável o comando recusa (saída 2).
- Saída diferente de 0: **não liberar**. `ESTADO=NAO_PROVISIONADA` → executar a seção 5 (ou repetir a importação, que é idempotente). `ESTADO=INCONSISTENTE` → investigar antes de qualquer correção (seção 8).
- `--json` imprime um único documento para o pipeline. A saída nunca leva caminho absoluto, segredo, hash de arquivo nem caractere de controle vindo do disco.
- Como a verificação reaproveita a importação em simulação e o verificador de integridade (`npm run imagens:verificar`), ela confere SHA-256 e tamanho do pacote e de cada arquivo, o registro de cada imagem, os arquivos guardados (tipo, tamanho, SHA-256, assinatura do formato) e as sobras.

### Integração com a publicação (HML)

**Como o HML é publicado.** O repositório não contém o mecanismo de publicação: o único workflow (`.github/workflows/ci.yml`) roda testes e não implanta, e não há script de deploy, unidade de serviço, proxy nem infraestrutura como código versionados. O HML é uma instância operada fora do repositório. Dentro do repositório, o único ponto executado em toda inicialização é `npm start` (`scripts/guarda-inicializacao.js` e depois o servidor), e ele confere o banco e as migrations e, **só quando o ambiente declara `IMAGENS_BIBLIOTECA_PADRAO=obrigatoria`**, também a biblioteca de imagens (rede de segurança abaixo, mais fraca que o portão). Por isso a garantia completa depende de a publicação **executar** o comando.

**Ordem mínima de uma publicação** (cada passo só começa se o anterior terminou com sucesso):

1. obter o código aprovado e instalar as dependências (`npm ci`);
2. aplicar as migrations autorizadas para aquele banco (`npm run db:migrate`, com backup e `DB_NAME` explícito);
3. **instalação única**, só em ambiente novo ou com a biblioteca vazia: importar os pacotes do plano (seção 5);
4. **portão de publicação**: `npm run imagens:prontidao` com os argumentos da seção 6, no ambiente de destino e com a política declarada (`obrigatoria` ou `desabilitada`);
5. só então iniciar ou reiniciar o serviço e liberar o tráfego;
6. conferir `/api/health` (que **não** prova a biblioteca).

**Regra do portão.** A publicação **não pode ser declarada concluída** se o passo 4 terminar com qualquer saída diferente de 0, o que inclui `NAO_PROVISIONADA`, `INCONSISTENTE`, política ausente (saída 2), plano ou pacote sem integridade (saída 3) e identidade do banco ausente ou divergente (saída 2). Registre na ata da publicação o código de saída, a linha `ESTADO=` e o hash do plano aprovado.

**Rede de segurança na inicialização (opt-in).** Com `IMAGENS_BIBLIOTECA_PADRAO=obrigatoria` no ambiente do serviço, a guarda de inicialização que o `npm start` e o `npm run dev` já executam antes do servidor também **recusa subir** (código 3, "o backend NÃO foi iniciado") se a biblioteca padrão estiver ausente ou inconsistente. Ela é somente leitura e reaproveita `inspecionarDiretorio` e o verificador de integridade:
- reprova diretório de imagens não configurado, com localização inválida, inexistente ou com permissão inadequada (mesmas regras da seção 2);
- reprova **biblioteca vazia**: nenhuma imagem padrão registrada no banco (`BIBLIOTECA_IMAGENS_AUSENTE`), mesmo com o diretório existente;
- reprova divergência da **biblioteca padrão** entre banco e arquivos (`BIBLIOTECA_IMAGENS_INCONSISTENTE`: arquivo ausente de registro íntegro, conteúdo diferente, entrada imprópria na raiz ou no escopo padrão);
- **não** reprova divergência só de imagem de uma empresa, sobras sem registro nem itens recentes: um dano em arquivo de um cliente não pode derrubar o sistema; ele segue visível em `npm run imagens:verificar`.

Sem a variável (ausente, vazia ou só espaços) ou com `desabilitada`, **nada muda**: a guarda não consulta a biblioteca nem carrega módulo algum dela, e um ambiente com a biblioteca vazia continua subindo como antes. Qualquer outro valor (por exemplo `Obrigatoria` ou `true`) reprova a inicialização, para um erro de digitação não desligar a exigência em silêncio. Se o banco ou as migrations já forem reprovados pela guarda, a biblioteca nem é consultada e o motivo real é mostrado.

Esta verificação **não substitui o portão da publicação**: ela não lê o plano nem os ZIPs, então não sabe **quantas** imagens eram esperadas nem se os hashes são os aprovados (uma biblioteca com 5 de 31 imagens passa). Custo: a cada inicialização o verificador lê e confere o SHA-256 dos arquivos armazenados, proporcional ao volume de imagens do ambiente.

**Limite da garantia.** O repositório fornece o portão, a guarda e seus contratos testados; ele **não** consegue obrigar o mecanismo externo a executar o portão (passo 4). A guarda só atua se o serviço for iniciado por `npm start`/`npm run dev` e se o ambiente declarar `obrigatoria`; um serviço iniciado diretamente com `node src/server.js` a ignora. Nada na CI nem em `/api/health` reprova uma biblioteca vazia. Se a publicação passar a ser automatizada (script, pipeline ou unidade de serviço), o passo 4 deve ser um estágio bloqueante dela e o serviço deve ser iniciado pelo `npm start`.

## 7. Reexecução e idempotência

- A chave de idempotência é o SHA-256 do PNG padronizado. Reexecutar `--executar` com o mesmo pacote **não grava nada** quando tudo já está provisionado (zero escritas, zero reescrita de arquivos).
- Imagem já registrada nunca é reescrita: nome, situação, versão e proveniência não são tocados.
- Importação **incompatível** (hash igual com campos de conteúdo diferentes, arquivo guardado com outros bytes, registro sem arquivo, nome já usado por outra imagem) é recusada com `ESTADO_DIVERGENTE` e **nada é alterado**. Não existe reparo automático.
- Acrescentar uma imagem à biblioteca é publicar um novo pacote e uma nova linha no plano; as já importadas permanecem intactas.

## 8. Recuperação de falha parcial

A importação grava primeiro os arquivos e depois as linhas, estas numa transação única. Uma interrupção deixa, no pior caso, arquivos sem registro (sobras inofensivas), nunca registros sem arquivo.

| Situação | Como identificar | O que fazer |
|---|---|---|
| Importação interrompida | `NAO_PROVISIONADA`, `PACOTE_NAO_PROVISIONADO` | repetir a importação do pacote (a trava consultiva impede importações simultâneas; `IMPORTACAO_EM_ANDAMENTO` pede para aguardar). |
| Banco e diretório vazios | `NAO_PROVISIONADA` em todos os pacotes | executar a seção 5. |
| Registro sem arquivo | `INCONSISTENTE`, divergência `ARQUIVO`/`AUSENTE` | restaurar o arquivo do backup do diretório e conferir o SHA-256 do registro. **Não** reimportar às cegas. |
| Arquivo com conteúdo diferente | `INCONSISTENTE`, `CONTEUDO_DIVERGENTE` | investigar a causa (disco, restauração errada); nada é sobrescrito. |
| Diretório com permissão inadequada | `INCONSISTENTE`, `PERMISSAO_*` | corrigir o proprietário e o modo (`chmod 700`), sem mexer no conteúdo. |
| Volume não montado / caminho errado | `NAO_PROVISIONADA` (`DIRETORIO_INEXISTENTE`) ou alerta `RAIZ_AUSENTE`/`NENHUM_ARQUIVO_ESPERADO_PRESENTE` | montar o volume ou corrigir `IMAGENS_ARMAZENAMENTO_DIRETORIO`; não importar sobre um diretório novo se o banco já tem registros. |

Antes de qualquer correção em ambiente com dados, faça backup do banco e do diretório de imagens: primeiro o banco, com o serviço sem escrever imagens durante a cópia, e confira os SHA-256 das cópias. Restaure somente em banco e diretório novos.

## 9. Segurança e compatibilidade

- Os comandos de verificação são somente leitura: o armazenamento entregue à importação em simulação não consegue gravar, e o diretório nunca é criado nem tem permissão alterada por eles.
- O destino (banco e OID) é conferido na própria conexão antes de qualquer leitura ou escrita; a escrita exige a autorização explícita.
- O servidor, as rotas e a configuração de runtime **não mudam**. A única mudança de inicialização é opt-in (seção 6): ambientes sem `IMAGENS_BIBLIOTECA_PADRAO=obrigatoria` sobem exatamente como antes, sem consultar a biblioteca nem carregar módulo dela.
- Nenhum binário, dado pessoal ou segredo faz parte do Git; os hashes do plano são públicos por natureza.

## 10. A variante de exibição (`exibicao.webp`)

**O que a importação grava.** Por imagem, o importador grava **dois** arquivos: o PNG padronizado (`mestre.png`) e a miniatura (`miniatura.webp`). Ele **não** grava `exibicao.webp` e deixa `sha256_exibicao` e `bytes_exibicao` nulos, por desenho: o cabeçalho do serviço de importação diz que nunca gera a derivada de 640 px, e o pacote aprovado não a contém. Uma biblioteca de 31 imagens recém-instalada tem, portanto, **62 arquivos**, não 93.

**Comprovado no código:**
- É **opcional** para o armazenamento e para o verificador: o par `sha256_exibicao`/`bytes_exibicao` pode ser nulo e o verificador só espera o arquivo quando o registro o declara. Por isso uma instalação limpa é `PROVISIONADA_INTEGRA` com 62 arquivos.
- É **gerada depois**, imagem por imagem, por `scripts/imagens-completar-exibicao.js`, que reaproveita o processador (precisa do `sharp`) e, com `--executar`, exige backup, inventário e prova de restauração prévios. O ambiente funcional com 31 `exibicao.webp` é resultado dessa etapa, não da importação.
- **Não é necessária** para a Biblioteca Padrão na tela de Materiais: ela usa só a miniatura (`js/imagens-material.js`).
- **É necessária** apenas para a foto ampliada do produto no Totem (tela de tamanhos), inclusive na prévia do Totem exibida na Central, que reutiliza a mesma tela: a entrega responde `404 IMAGEM_NAO_ENCONTRADA` para a variante `exibicao` quando o registro não a tem, e o Totem trata o 404 como falha definitiva dessa imagem e mantém o espaço reservado no lugar da foto, sem mensagem de erro nem perda de função. A miniatura, usada nos cartões, funciona normalmente.

**Comportamento esperado numa instalação limpa:** biblioteca íntegra, Materiais com todas as miniaturas, Totem com miniaturas nos cartões e **sem** foto ampliada até a exibição ser completada. A verificação de prontidão **não** reprova essa ausência e não a lista; se a foto ampliada for requisito de uma publicação, complete as exibições com o procedimento do próprio script (uma imagem por vez, com os artefatos exigidos por ele) e confira no Totem. Tornar a exibição parte da importação ou do plano seria mudança do importador e do pacote, que não foi feita por não haver necessidade comprovada para a biblioteca; é uma decisão de produto.
