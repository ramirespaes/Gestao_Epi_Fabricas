# Reconciliações públicas de governança e contratos

Decisões aprovadas para interpretar a base documental; registros completos e
evidências ficam sob custódia privada. Ramires decide; o ChatGPT orienta.
Não são autorizações de execução. Consulte a [governança](../../docs/governanca/agentes.md).

## R01 — Git

Leitura permitida; alteração somente com autorização específica. A antiga
proibição de leitura foi substituída expressamente. Memórias/fontes antigas
permanecem preservadas, sem serem editadas por esta adoção.

## R02 — Autonomia por etapa

Atividades necessárias já abrangidas não exigem nova pergunta por comando.
Operações protegidas fora do escopo continuam sujeitas aos gates aprovados.

## R03 — Entregas Git

A entrega única do Bloco 12 é registro histórico superado, não regra geral atual.
Mantêm-se commits lógicos pequenos e autorizações separadas de staging/commit/push.

## R04 — Node

Node >=22 é o requisito técnico do backend na referência. >=20 era proposta.
Não confundir orientação anterior de configuração com requisito vigente.

## R05 — Inventários e migrations

Contagens antigas são fotografias, não inventário atual. A referência de
estado-atual.md tem 96 SQL até 096, sem 088; a suspensão de 088 permanece.
Versionada não significa aplicada; consultar a versão pertinente sem inventar
o estado dos bancos. Tabelas de toggles/resultados antigos exigem essa distinção.

## R06 — Heartbeat

A descrição antiga de rota não montada e a pendência P-06 foram superadas no
Ciclo 2 documentado. Não reimplementar pela lista antiga. Isso não comprova runtime
ativo, aplicação da 089 ou homologação; a pré-condição técnica permanece.

## R07 — Integração J2a

A guarda local dedicada permanece fora da CI. A prova alternativa de PostgreSQL
efêmero vale somente na CI nas condições versionadas, não em qualquer banco.

## R08 — Leitura seletiva

Entradas curtas orientam consulta obrigatória por assunto. Não importar histórias
extensas automaticamente nem exigir sua leitura integral em toda tarefa.

## R09 — Backup de banco e imagens

Preservar a errata E-65-01: banco primeiro sozinho é insuficiente. Janela sem
escrita efetivamente garantida e prova de consistência são necessárias, ou
alternativa consistente previamente aceita. Backup real/restore têm gates próprios.

## R10 — MASTER e solicitações

MASTER nunca aprova, reprova ou encerra solicitações. A proteção e a revalidação
de autoridade são do serviço, não apenas ausência de concessão no provisionamento.

## R11 — Classificação de material

A V2 de classificação substitui listas anteriores para novos cadastros conforme
decisão expressa, preservando compatibilidade legada e sem conversão automática.

## R12 — Documentação e melhorias

Não interromper cada resposta com melhorias opcionais/relatórios. Documentação
técnica acompanha a mudança autorizada; backlog aparece no fechamento apropriado.

## R13 — Versão correta

Referência Git local não comprova GitHub atual. Implementação divergente não
revoga contrato nem autorização; resolver conflito por decisão/evidência pertinente.

## R14 — Banco de teste

Receita histórica que usa public não substitui o contrato de schema temporário
isolado, search_path restrito e cleanup. Documentação estática não autoriza conexão.

## R15 — Autoridade e adoção

Ramires decide; o ChatGPT orienta. Aprovação documental não autoriza publicação,
staging, commit, push ou alteração de arquivos fora do escopo.

## R16 — Gates e reinício local

Reinício de serviço existente pode integrar a etapa quando expresso e seguro.
Não há autorização implícita de todo reinício nem pergunta repetida pelo já incluído.

## R17 — Regras complementares

Preservar progresso fundamentado, proteção de materials.html e coordenação visual,
executor injetado sem pool global e comentários mínimos. Lightsail é decisão
histórica; não substitui a frente AWS nem comprova preço/configuração atual.

## R18 — Contratos e história

Narrativa datada foi separada de contratos; requisitos, congelamentos e exceções
permanecem. Datas/resultados históricos não são validações atuais. As fontes
integrais e o comparativo são preservados em custódia privada.

## R19 — Fontes especializadas

Documentos existentes permanecem fontes únicas nos caminhos registrados em
fontes-especializadas.md, associados à versão do repositório. Não criar cópias paralelas.

## R20 — Totem

CLAUDE local, seção operacional e complemento externo são protegidos contra
sobrescrita. Ícones prontos de 12L são requisito contextual, não veto global.

## R21 — Sanitização técnica

Não confundir maiúscula/barra com caminho privado. Rotas HTTP, fuso IANA, testes
e workflow público são preservados; caminhos/dados privados ficam sob custódia.
Reparo editorial não altera código, constantes, prazos ou regras.

## Limites

As reconciliações não encerram homologação, vulnerabilidade, produção ou
congelamento sem evidência própria. Não acessar fontes privadas ou infraestrutura
para satisfazer este índice sem autorização correspondente.
