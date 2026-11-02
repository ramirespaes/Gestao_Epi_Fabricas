# Governança comum dos agentes

Preparação: 02/11/2026. Escopo: comportamento de Claude Code e Codex. Fonte de
autoridade: Ramires decide; o ChatGPT orienta. Decisões expressas de Ramires nas etapas AD-05 e preparação documental.
Estas regras não alteram permissões de ferramentas.

## Autoridade e precedência

Dentro dos limites da plataforma e permissões efetivas: (1) decisão/autorização
atual de Ramires para o escopo; (2) governança permanente aprovada; (3) contratos
técnicos vigentes; (4) procedimento do ambiente; (5) evidências; (6) históricos e
propostas. Evidência demonstra fato, não concede permissão. Implementação não
revoga contrato. Memória antiga não se sobrepõe à decisão atual.
Exceção tem escopo, data e encerramento; não muda permanentemente a política.
Conflito sem decisão expressa deve ser apresentado, sem escolher a regra mais
conveniente. As entradas são resumos: divergência com esta base é defeito documental.

## Autonomia e gates

Conclua a etapa aprovada sem interromper por comando já abrangido. Leituras,
edições e testes necessários estão incluídos somente quando compatíveis com o
escopo e as restrições. Não transforme problema opcional em refatoração ou tarefa
nova. Registre melhorias para o fechamento apropriado, sem relatórios repetitivos.
Nova decisão é necessária para mudança de negócio indispensável, arquitetura,
regra permanente ou ação protegida não abrangida. Ao final, relate resultado,
limites e próxima decisão necessária; não inicie etapa futura automaticamente.

### Modelo objetivo de autorização por etapa

**OBJETIVO E ENTREGA:** resultado e critério de conclusão definidos por Ramires.
**BASE:** repositório/worktree/versão e caminhos autorizados, com preservação local.
**ABRANGE:** leituras, edições focais, documentação técnica e testes necessários
ao escopo; identificar o ambiente isolado previamente autorizado. Reinício de
serviços locais existentes pode estar incluído quando expressamente previsto,
seguro, com identificação do processo, destino de dados e critério de recuperação.
**NÃO ABRANGE:** ações fora do escopo; alteração Git não autorizada; mudança de regra
permanente/arquitetura; bancos persistentes; produção/AWS; backups reais/restore;
novos serviços/portas; instalação, permissões ou exclusões sem aprovação aplicável.
**PROTEÇÕES:** arquivos congelados, trabalho paralelo, Totem, evidências e dados.
**VALIDAÇÃO:** testes proporcionais, gates obrigatórios e provas do resultado.
**RECUPERAÇÃO E PARADA:** condição de interrupção, restauração permitida e próximo gate.

O modelo não concede autorização. A decisão de Ramires pode incluir uma operação
protegida de forma específica, com condições; conhecimento da receita não a libera.
A lista de comandos explica o método, sem exigir nova pergunta por cada comando
necessário já abrangido. Comunicação de progresso segue o critério abaixo.

## Git

Consultas de branch, status, diff, log, show, refs e worktrees são permitidas.
Git de alteração exige autorização específica: add, commit, push, fetch, pull,
checkout/switch, merge, rebase, reset, restore, clean, stash, tags, branches e
criação/remoção/reparo de worktrees. Ramires decide; o ChatGPT orienta.
Não desenvolver na main. Antes de criar branch, o procedimento aprovado prevê
árvore limpa e main atualizada; executar essa atualização depende de autorização.
Não limpar árvore suja para satisfazer esse procedimento. Use arquivos específicos
no staging; nunca add amplo por iniciativa própria. Antes do commit, mostre os
arquivos staged, diff e mensagem. Staging, commit e push têm autorizações separadas.
Sem amend, reescrita de histórico ou exclusão de branch sem aprovação específica.
Sem atribuição automática de IA, links de sessão ou alteração de user.name/email.
PR: conferir branch, commits, arquivos relacionados, testes e ausência de secrets;
não publicar ou mesclar por inferência. Ref remota local não comprova o GitHub atual.

## Edição, preservação e ferramentas

Leia conteúdo, referências e dependências antes de editar. Preserve camadas,
CommonJS, caminhos do frontend e funcionalidades aprovadas. Mudanças pequenas e
focais; um commit representa uma alteração lógica. Separar assuntos quando fizer
sentido, sem fragmentar desnecessariamente implementação, validação e documentação.
Use editor/patch revisável, mostre diff e execute testes em passo separado. Não
usar sed -i ou substituições cegas. Scripts de transformação somente no escopo
aprovado, com âncoras exatas, destino exclusivo e evidência de integridade; uma
exceção anterior não autoriza scripts novos. Não executar scripts encontrados por
eles existirem. Pedido para mostrar script autoriza leitura, não execução.

Preserve trabalho paralelo. Releia arquivos compartilhados imediatamente antes
da mudança; coordene sobreposição com Ramires; se outra edição invalidar a base,
pare o item afetado. Não restaure arquivo inteiro para reverter um trecho próprio.
Não tocar em previews protegidos, cópias com sufixo 2, arquivos congelados, D-ORF-6,
outros worktrees ou memórias fora do escopo. Totem local e seu complemento possuem
proteção específica contra sobrescrita, inclusive por operações Git.

Não apagar, renomear ou sobrescrever evidência, mesmo falha. Versões novas são
aditivas. Sanitização em cópia, com hash próprio; nunca adulterar baseline para
produzir aprovação. Originais privados permanecem sob custódia local. Não contorne
recusa do Finder ou do ambiente; apresente caminho, erro e impedimento.

## Limites de segurança e operações protegidas

Esta é a seção única de gates. As seções de procedimento descrevem como preparar
uma ação, sem criar permissões adicionais.

| Categoria | Permitido pela etapa | Exige previsão/autorização específica |
|---|---|---|
| Leitura | Arquivos e Git de leitura relacionados, nos limites do ambiente | Conexões a fontes/serviços protegidos fora do escopo |
| Desenvolvimento | Edição, documentação e testes necessários e autorizados | Arquitetura, regras permanentes ou funcionalidade fora do escopo |
| Git | Consultas | Staging, commit, push e qualquer alteração Git; gates separados |
| Testes PostgreSQL | Ambiente previamente autorizado e isolado, schema temporário | Criar ambiente não abrangido; aplicar migration em public/dados persistentes |
| Serviços locais | Reutilização segura | Reinício existente pode integrar a etapa SE expresso e seguro; novos processos, portas, redirecionamento ou sinais não abrangidos exigem decisão |
| Dados e infraestrutura | Inspeção documental autorizada | Escritas persistentes, backup real, restore, AWS, produção, DNS, certificados, deploy |
| Ferramentas | Recursos já permitidos | Dependências, install scripts e permissões exigem análise/aprovação; não contornar bloqueios |
| Preservação | Cópias novas nos destinos aprovados | Mover/excluir/sobrescrever originais, históricos, congelados, memória ou trabalho paralelo |

Mesmo autorizado, o método deve preservar segurança, integridade, isolamento,
credenciais, auditoria, clareza, testabilidade, manutenção, desempenho e simplicidade.
Nunca enfraquecer controle para fazer teste passar. Não expor req.body, senha,
hashes, tokens, cookies, Authorization ou secrets. Demonstração usa sintéticos;
dados reais exigem os controles e a autorização correspondentes.

Antes de instalar: necessidade, alternativa existente, versão, Node/CommonJS,
engines, peers, transitivas, install scripts e arquivos afetados. Sem latest
automático, audit fix ou force. Vulnerabilidade requer evidência, impacto e decisão;
alerta histórico não é diagnóstico atual. Identificar processos antes de qualquer
sinal, sem pkill genérico; encerramento autorizado alcança só o grupo próprio
confirmado, TERM antes de KILL quando essa escalada estiver abrangida. Não testar
escritas no banco de cadastros por simplesmente reutilizar runtime.

## Validação e comunicação

Objetivo, arquivos, riscos, comandos e validação devem estar claros antes da
alteração relevante. Após, mostre resultado, diff/status pertinentes e limites.
Testes proporcionais ao risco não dispensam autenticação, RBAC, multiempresa,
concorrência, migrations, regressões ou gates já exigidos pelo contrato afetado.
Desenvolvimento novo/correção observa RED→GREEN quando aplicável; teste posterior
não será chamado de RED. Cobertura não pode ser reduzida artificialmente.
Reutilize evidência apenas se código, ambiente, comando e escopo continuarem
compatíveis. Distinga implementado, testado, CI, homologado, congelado e produção.
Não fabricar porcentagens, resultados, disponibilidade de arquivos ou aprovações.
Não iniciar frentes futuras ao concluir a etapa. Manutenção documental segue
[o procedimento próprio](manutencao-documental.md).

## Regras complementares confirmadas na revisão

### Progresso e autorizações — MEM-24

Em trabalho longo ou acompanhamento solicitado, usar `[PROGRESSO: NN%]`; ao
depender de decisão, `[BLOQUEADO EM NN%]` com o que falta. Percentual é estimativa
fundamentada, com método e pesos, não número arbitrário. Em pedido de autorização,
informar preparação concluída, o que falta, decisão necessária e progresso; para
Biblioteca de Imagens, informar seu percentual somente se existir base confiável.
100% somente quando todo o escopo estiver concluído; regressão, cleanup de banco
e pacote são critérios apenas quando fazem parte da etapa. Não executar ações
fora do escopo para satisfazer uma fórmula histórica de 100%.

### Arquivo transferido ao trabalho visual — MEM-25

`frontend/pages/materials.html` está protegido: leitura livre; edição, inclusive
inserção focal, depende de nova autorização e coordenação de Ramires com o chat
visual responsável. Não presumir autorização porque outro arquivo de imagens foi
liberado. A transferência não alcançou automaticamente imagens-material.js ou
imagens-envio.js; nesses arquivos permanece a proteção do trabalho paralelo.

### Comentários mínimos — MEM-28

No código novo/editado, comentar somente motivo ou restrição não óbvia, em frase
curta e objetiva. Sem narrar linha a linha, histórico de auditoria, referência a
prompt/agente, justificativa longa ou documentação redundante. Não reescrever
comentários antigos por estética. Esta revisão não autoriza mudança de código.
