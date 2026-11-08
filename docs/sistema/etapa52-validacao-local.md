# Etapa 52 — entrega local para revisão

Atualização da Etapa 53A, 07/11/2026: a aplicação controlada da Etapa 52 foi
concluída com o aplicador V2, com 22/22 hashes conferidos e estado `APLICADO`.
Oito backups e oito imagens de restauração foram preservados; não houve staging,
commit, push, merge ou operação remota. Os 59 testes da implementação e os 21
testes do aplicador são provas distintas; os últimos não integram o CI JavaScript.
As correções posteriores de F1/F2/F3 têm validação própria e não modificam essa
evidência histórica. A automação não foi ativada.

## Registro histórico da preparação anterior à aplicação

O texto abaixo preserva a fotografia anterior, inclusive a recusa inicial da
escrita. As afirmações de aplicação pendente não descrevem o estado atual.

**Aplicação pendente:** os arquivos estão preparados e testados em cópia isolada.
A solicitação de escrita no worktree de CD, situado fora das raízes graváveis da
sessão, foi recusada. Nenhum arquivo desse worktree foi alterado. O patch da entrega
permite revisar as mudanças antes de autorizar sua aplicação; o escopo não está
concluído no worktree de destino.

Data: 07/11/2026. Repositório `ramirespaes/Gestao_Epi_Fabricas`, worktree de CD
informado pelo responsável, branch `feature/cd-componentes-publicacao-20261107`,
HEAD `1b95752bdcd681199e84d05d95b2e044358fce9f`. Árvore inicialmente limpa.
Não houve staging, commit, push, merge, deploy, alteração de configuração remota,
acesso AWS, alteração de banco, serviço ou porta. A automação permanece desativada.

## Arquivos da entrega

| Grupo | Arquivos |
|---|---|
| Workflow | `.github/workflows/deploy-hml.yml` |
| Protocolo, entrega e execução local no servidor | `deploy/hml/cd/protocolo.js`, `publicar.js`, `s3.js`, `agente.js` |
| Modelos inertes | `deploy/hml/cd/agente.config.exemplo.json`, `iam-confianca.modelo.json`, `iam-publicador.modelo.json`, `iam-agente.modelo.json`, `s3-politica.modelo.json` |
| Testes novos | `.github/scripts/hml/test/publicacao-aprovada.test.js`, `s3-isolado.test.js`, `workflow-publicar.test.js` |
| Testes atualizados | `.github/scripts/hml/test/workflow-deploy-hml.test.js`, `documentacao-cd.test.js` |
| Contratos e índice | `docs/README.md`, `docs/sistema/publicacao-homologacao.md`, `publicacao-homologacao-componentes.md`, `publicacao-homologacao-automacao.md` |
| Orientação das pastas | `deploy/hml/LEIA-ME.md`, `frontend/publicacao/README.md` |
| Evidência consolidada | este arquivo |

Total: 22 arquivos preparados para adição ou modificação. Empacotadores, allowlists, verificador
de commit, gerador de release, instalador Linux e `ci.yml` foram preservados byte a
byte. Não foram alterados frontend funcional, Nginx, backend, migrations ou D-ORF-6.

## Validação executada

Ambiente: macOS, Node **v26.10.0**, diretórios sintéticos exclusivos em temporário;
sem instalação de ferramenta, conexão AWS/GitHub autenticada, servidor HTTP ou banco.
O workflow continua pedindo Node 22. A compatibilidade exata em Node 22/Linux não
foi comprovada nesta sessão e é condição para ativação, junto com CI verde.

| Prova | Resultado |
|---|---|
| Teste positivo inicial do protocolo antes da implementação | RED: módulo ausente; não se atribui RED às demais negativas dessa rodada |
| Regressão de `validar-commit.test.js` | 8 PASS, incluindo CI errado, SHA inválido, branch/ancestralidade e rollback sem opt-in |
| Regressão de `gerar-release.test.js` | 9 PASS, incluindo integridade, isolamento, falha de empacotador e reprodutibilidade |
| Rodada final dos cinco arquivos abaixo | **42 PASS, 0 FAIL, 0 SKIP** |
| YAML pelo parser Ruby/Psych disponível | sintaxe, gatilho manual, três jobs e environment conferidos; não é actionlint nem execução GitHub |
| Preservação dos componentes existentes | comparação SHA-256 contra os originais do worktree antes da aplicação |

Rodada final:

```text
node --test .github/scripts/hml/test/publicacao-aprovada.test.js .github/scripts/hml/test/s3-isolado.test.js .github/scripts/hml/test/workflow-publicar.test.js .github/scripts/hml/test/workflow-deploy-hml.test.js .github/scripts/hml/test/documentacao-cd.test.js
```

São **59 testes distintos aprovados** considerando a rodada final e as duas suítes
de regressão anteriores, sem somar repetições intermediárias. Destes, 21 são novos.
Os testes antigos do instalador não foram repetidos: seu código não mudou e a
homologação histórica tem escopo próprio. A suíte completa de backend/PostgreSQL
não foi executada por estar fora da mudança e do ambiente autorizado.

O adaptador usa um executável AWS falso e temporário: testa argumentos reais da
invocação, credencial temporária obrigatória, conta divergente, erro sanitizado,
remoção de endpoints/profiles, criação condicional e listagem restrita. O agente é
exercitado com dependências sintéticas: baseline inválida, mudança concorrente,
expiração entre componentes, falha do segundo componente, falha HTTP e rollback
bloqueado. O transporte também percorre os pacotes reais dos empacotadores existentes.
Essas provas não equivalem a um ensaio do agente completo no Linux com S3 real.

SHA-256 do log final local (fora do Git):
`9c483ad4286f025872dc62430352043af8124e1ca9b79a8869038ec8a6df7754`.
O log está na área temporária privada da preparação, `validacao-final.log`.

Referências preservadas:

| Arquivo | SHA-256 |
|---|---|
| `.github/scripts/hml/validar-commit.js` | `ea6363c59d25ca509779b9501dd3219bffbe4608c06fd118c5f8aefef50d436f` |
| `.github/scripts/hml/gerar-release.js` | `8d98bf3f8aa1a79ba3a07ae731c4bb06b5688a36eb7c2b1db3920086da46f05e` |
| `deploy/hml/instalador/instalar-release.js` | `62600085145c9f02983004533ced9337edc56862e281a8f05117bd234bb35db1` |
| `.github/workflows/ci.yml` | `288070284ebeffbf59f4826c18e0bafefdd65438adb67a2129adfdcc63d5302e` |

## Riscos, dependências e próximo gate

A implementação está preparada para revisão local. A ativação continua bloqueada por:

1. Revisão desta entrega e gates Git separados; CI no SHA efetivo da main.
2. Revisão remota autorizada de environment, OIDC, políticas, bucket e variáveis.
3. Confirmação física de raízes exclusivas da homologação, sem aliases/escrita no
   institucional. A declaração na configuração não substitui essa inspeção.
4. Baseline de Portal/Painel adotada e comprovada pelo instalador; não se presume
   que o layout AWS existente corresponda ao layout preparado neste repositório.
5. Broker de credenciais temporárias e scheduler homologados; não presumir IAM
   instance profile em Lightsail nem instalar chaves permanentes como atalho.
6. Ensaio completo do agente em Linux real com Node 22 e, depois, integração remota
   expressamente autorizada. Persistência, recuperação após queda e políticas IAM
   não são comprovadas pelos mocks locais.

Há uma janela de versões mistas entre os componentes. O rollback não reverte dados
ou migrations, exige baseline íntegra e HTTP aprovado e bloqueia em caso crítico.
Timeout/cancelamento do Actions deixa o resultado remoto indeterminado até conferir
estado e recibo. A fila/estado não têm limpeza automática; após 1.000 pedidos é
necessário arquivamento autorizado. O novo agente não contorna os limites A-11 do
instalador, o bloqueio operacional do backend nem a coordenação protegida D-ORF-6.

O procedimento completo de ativação e recuperação está em
[publicacao-homologacao-automacao.md](publicacao-homologacao-automacao.md).
Nenhuma operação remota fica autorizada por esta entrega.
