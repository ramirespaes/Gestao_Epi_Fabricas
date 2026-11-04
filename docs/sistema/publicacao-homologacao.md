# Publicação da homologação (preparação do CD)

Preparado em 03/11/2026 para revisão. Não comprova GitHub remoto, workflow já
executado, servidor ou ambiente de homologação ativo. Não autoriza AWS, deploy,
DNS, certificados nem reinício de serviço: cada um mantém autorização própria
([Operação](operacao.md)). Produção está fora deste documento.

## O que existe nesta etapa

| Peça | Função |
|---|---|
| `frontend/publicacao/empacotar.js`, `allowlist.json` | pacote do Portal do Cliente, Totem e institucional (inalterados) |
| `frontend/publicacao/empacotar-painel.js`, `allowlist-painel.json` | pacote independente do Painel Privado, 25 arquivos |
| `.github/scripts/hml/validar-commit.js` | decide se o commit escolhido pode virar release |
| `.github/scripts/hml/gerar-release.js` | gera os dois pacotes, os manifestos SHA-256 e `release.json` |
| `.github/workflows/deploy-hml.yml` | disparo manual que encadeia as duas peças e guarda a release como artefato |

O workflow **só valida e empacota**. Tem dois jobs, `validar` e `empacotar`, sem
segredos, sem `environment`, sem permissão de escrita e sem nenhum comando de
transmissão. Isso é provado por `.github/scripts/hml/test/workflow-deploy-hml.test.js`,
que falha se alguém acrescentar SSH, AWS, segredo, gatilho automático ou ação de terceiros.

## Regras do disparo manual

Gatilho único `workflow_dispatch`, com `commit` (SHA completo), `confirmacao`
(literal `HOMOLOGACAO`) e `permitir_commit_anterior` (padrão falso). O job
`validar` recusa, nesta ordem:

0. disparo a partir de qualquer ref que não seja `refs/heads/main`: a validação vive no YAML, então só o da `main` vale;
1. confirmação ou SHA em formato inválido;
2. commit fora da história da `main` (`git merge-base --is-ancestor`);
3. ausência de execução do `ci.yml` **concluída com sucesso, no push da `main`, para o mesmo SHA**. A conclusão do workflow só é sucesso quando todos os jobs passaram, o que cobre o CI completo. Execução de pull request ou de outra branch não vale;
4. commit que não é a cabeça atual da `main`, salvo `permitir_commit_anterior`.

Commit anterior aceito produz release rotulada `...-retroativo` e `atual=false`,
exibida com aviso no resumo da execução. Assim um commit desatualizado nunca é
tratado como a versão atual da homologação. A cabeça da `main` é lida no momento
da execução, não no momento do disparo.

## Releases versionados

Rótulo: `hml-AAAAMMDDTHHMMSS-<7 primeiros do SHA>[-retroativo]`, ordenável por
data. Cada release contém:

```text
portal/                  pacote do cliente
painel/                  pacote do Painel Privado
manifesto-portal.sha256  formato de sha256sum -c, caminhos relativos a portal/
manifesto-painel.sha256  idem, relativos a painel/
release.json             commit, rotulo, atual, geradoEm, contagens, hash de cada manifesto
```

O manifesto fica fora dos pacotes, para que cada pacote continue sendo
exatamente a sua allowlist. A release é reprodutível: mesmo commit e mesmo
instante geram manifestos idênticos. O artefato do GitHub tem retenção de 14
dias; um repositório definitivo de releases é decisão da etapa de publicação real.

## Commit usado em cada etapa

| Etapa | Código executado | Dados empacotados |
|---|---|---|
| `validar`: autoteste e decisão | scripts da cabeça atual da `main` | fatos coletados no momento da execução |
| `empacotar`: checkout | o commit validado, conferido por `git rev-parse HEAD` e árvore limpa | o commit validado |
| `empacotar`: provas e `gerar-release.js` | os do commit validado | o commit validado |

Para um commit anterior, a release é gerada pelo código daquele commit, não pelo
da `main` atual. O `release.json` registra o commit usado.

## Rollback somente de código (desenho futuro)

Previsto para a etapa de publicação real, não implementado aqui. Com o layout
`releases/<rotulo>/` por origem e um ponteiro `current`, voltar é reapontar para
a release anterior e conferir o manifesto, sem copiar nada de novo.

- Vale **só para o frontend**. Migrations não são revertidas, e o backend não faz parte deste CD.
- O alvo precisa conter os dois empacotadores. A release é gerada pelo código do próprio commit; um commit anterior à existência de `empacotar-painel.js` e dos scripts de homologação não pode ser empacotado. Para esses casos, o rollback é reapontar para uma release já gerada.
- Uma release antiga pode esperar contratos de API que o backend atual já alterou. Antes de reapontar, conferir compatibilidade com o backend em execução.

## Backend e banco: fora deste CD

Este CD publica **somente o frontend**. O backend, o PostgreSQL e as migrations
não são empacotados, publicados, reiniciados nem migrados por nenhuma peça acima.
Para a homologação funcionar de ponta a ponta, falta, com autorização própria
de cada item:

1. publicar e supervisionar o processo do backend (Node 22 ou superior), com a API sob `/api` e `/api/plataforma` na mesma origem de cada frontend;
2. `.env` de homologação sem segredos no Git: origens `CORS_ORIGIN` e `PLATAFORMA_CORS_ORIGIN` disjuntas e com `https://`, `PLATAFORMA_HOST`, `PORTAL_URL_PUBLICA`, `PAINEL_URL_PUBLICA`, `TRUST_PROXY_HOPS` conforme a topologia, chaves do Turnstile e do MFA, SMTP real (sem ele o backend não inicia em `production`);
3. banco de homologação e aplicação autorizada das migrations, verificadas contra os checksums;
4. agendamento externo do processador de alertas de estoque, limpeza de sessões e tentativas de login, e demais itens da lista de homologação em [Operação](operacao.md);
5. cookies `Secure`, HTTPS e proxy confiável validados na implantação.

**Ordem e compatibilidade.** Frontend e backend evoluem juntos. A ordem de uma
publicação real (migrations, backend, frontend) e a compatibilidade entre
versões são decisão da etapa de publicação, não deste CD.

## Coordenação futura com D-ORF-6

D-ORF-6 (backup e restauração) é frente protegida e fica fora deste CD. Antes
de qualquer publicação real:

- O CD não toca backend, PostgreSQL, migrations, dados persistentes, imagens, backups, wrappers, travas nem evidências de D-ORF-6.
- Se a mesma máquina da homologação hospedar backup ou restauração, a publicação não pode reiniciar serviço nem mover diretório que o D-ORF-6 use. Reinício de serviço exige previsão expressa.
- Backup e restore reais, janelas sem escrita e a errata E-65-01 seguem o contrato de Operação. Um deploy não pode cair numa janela de backup nem de restore; a ordem entre eles é decisão de Ramires.
- **Dois "manifestos" distintos.** O manifesto SHA-256 desta release lista arquivos de frontend e não tem relação com o manifesto evolutivo de backup do D-ORF-6 (versão 2, layout 2, em validação). Nenhuma peça deste CD lê, grava ou interpreta o manifesto de backup, e o inverso também vale.
- **Rollback e layout 2.** O rollback de código aqui descrito é só do frontend e não afeta backups. Um rollback futuro do **backend** para uma versão anterior ao leitor de layout 2 pode impedir a leitura ou a restauração de backups gravados em layout 2, que o contrato de Operação exige restaurar apenas em banco e diretório novos. Esse rollback exige verificar a versão do leitor de backup antes de reapontar o backend.
- **Migrations e dados.** Voltar o frontend não reverte migration nem dado persistente. Voltar o backend sem reverter o banco só é seguro se a versão anterior for compatível com o esquema já migrado, o que precisa de verificação caso a caso.
- A integração de D-ORF-6 à `main` é independente. O CD deve ser reavaliado depois dela, porque a `main` e o conteúdo de `frontend/` mudam.

## Riscos e limites conhecidos

- O workflow só pode ser disparado depois de existir na branch padrão. Até o merge, nada executa no GitHub, e o autoteste local é a única prova.
- Um commit só passa se o CI rodou no push da `main`. Merge sem CI concluído é recusado, por desenho.
- A verificação de CI é uma consulta à API do GitHub. Falha ou resposta vazia da API recusa, nunca aprova.
- Os empacotadores inspecionam HTML por expressões regulares. A CSP do servidor estático continua obrigatória e ainda não existe; o `<script>` inline de `painel-privado/index.html` exige hash ou nonce.
- Os testes do workflow são lidos como texto. Eles garantem a ausência de capacidade de publicar, mas não substituem a revisão de qualquer mudança futura no YAML.
- **Cobertura no CI.** O job sem banco do `ci.yml` executa, em pull requests e em pushes da `main`, os testes de `.github/scripts/hml` num passo próprio, depois dos testes do frontend. Uma alteração que quebre o workflow ou os scripts é detectada antes do merge. Os testes dos dois empacotadores (`frontend/test/publicacao*.test.js`) rodam no `npm test` do mesmo job. Os mesmos testes rodam de novo no job `validar` do disparo manual.
- **Ações fixadas por versão maior** (`@v4`), como no `ci.yml`. Antes de existir job de publicação, fixar por SHA de commit.
- **Formato da API.** O campo `path` das execuções do GitHub é tratado com e sem sufixo `@ref`. O comportamento real só é comprovado no primeiro disparo; na dúvida a validação recusa.
- O `node --test` com diretório como argumento falha no Node 22; os workflows usam glob entre aspas.

## Pendências para a publicação manual controlada

1. Revisão e merge desta preparação na `main`, com gates Git separados.
2. Decisão sobre topologia do servidor estático: raízes e origens separadas para cliente e Painel, `/` de cada origem, proxy de `/api` e `/api/plataforma`, CSP e `Cache-Control`.
3. Job de publicação separado, em `environment` protegido com revisor obrigatório, credenciais de menor privilégio (preferir OIDC) e troca atômica do ponteiro `current`.
4. Definição de onde as releases ficam guardadas e por quanto tempo.
5. Variáveis de homologação do backend: `PLATAFORMA_CORS_ORIGIN`, `PLATAFORMA_HOST`, `PAINEL_URL_PUBLICA`, disjuntas das do cliente.
6. Coordenação com a frente AWS e com D-ORF-6, nos termos acima.
7. Smoke test pós-publicação e critério de rollback automático ou manual.
