# Manutenção documental e evidências

## Atualização junto do desenvolvimento

Antes da alteração autorizada, identifique o contrato afetado pelo índice.
Atualize código e contrato na mesma entrega lógica; não é necessário relatório
separado de rotina. Registre comportamento, configuração, dependências, limites,
validações e risco residual que realmente mudaram. Se não há impacto documental,
declare brevemente o motivo. Alteração de governança permanente exige aprovação.
README descreve o estado atual e aponta contratos; não acumula logs ou contagens
de testes. RFC histórico não é reescrito por estética.

## Fontes e validade

Todo contrato informa assunto, fonte/versão, dependências e pendências conhecidas.
Versões e inventários são derivados de package, workflow e manifesto da referência
correta, sem confundir versionamento com aplicação em banco. Evidência registra
data, origem, versão/hash, comando, resultado, ambiente não sensível e limites.
Uma nova edição que altere o comportamento exercitado invalida a reutilização
daquela prova no escopo afetado. Não repetir suítes sem relação com a mudança.

## Registro mínimo de etapa

Informe objetivo/autorização, versão de referência, arquivos afetados, resultado,
validações executadas ou não, limitações, pendências e próximo gate. Hash e
manifesto são exigidos quando sustentam preservação, integridade, baseline ou
pacote auditável; não em toda resposta. Use um registro consolidado por entrega.
Melhorias opcionais não interrompem a etapa e são apresentadas no fechamento
apropriado; não há seção obrigatória de backlog em cada resposta.

## Preservação e publicação segura

Evidência original é imutável: não apagar, renomear, sobrescrever nem corrigir
silenciosamente. Gere versão nova, com referência ao erro e à anterior. Sanitize
somente cópias, declare alterações e use hash da cópia. Nunca copiar memória
privada integral, transcript, logs, dumps, .env ou chaves para Git público.
Mantenha entregáveis em local acessível aprovado fora de scratchpad volátil;
referencie a localização privada sem publicar dados de infraestrutura sensíveis.
Um caminho no Mac não é link público de download.

## Scripts e manifestos

Não misturar edição e execução. Scripts aprovados de preservação usam destinos
exclusivos, recusam sobrescrita, validam expectativas, propagam erro real e têm
recuperação proporcional ao risco. Cópia sintética e simulação não autorizam
aplicação real. Quando houver execução única autorizada, não repetir para buscar
um resultado verde. Hash só após fechamento; modificação posterior gera nova
versão e novo manifesto. Manifesto usa caminhos relativos ao seu próprio diretório
e não inclui a si mesmo. Falha, ausência ou ilegibilidade deve aparecer no resultado.
Não capturar valores de secrets para “provar” sanitização.

## Reconciliação e aprovação

Na [rastreabilidade](../../historico/governanca/rastreabilidade.md), cada origem
recebe destino, classe, decisão e risco. Antiguidade não revoga regra. Estado
histórico não é autoridade atual. Conflito não decidido fica explícito, com
proteção mantida; não é removido para encurtar texto. A redação de memória pode
ser incorporada de modo sanitizado, mas sua edição é autorização separada.

## Verificação de carregamento antes da adoção

Em sessão nova de cada ferramenta, na raiz e em diretório representativo, verificar
as fontes efetivamente carregadas, possíveis overrides e limite de tamanho.
Pedir plano observacional para tarefa de segurança, frontend e migration; conferir
consulta à base comum e aos contratos pertinentes. Autorrelato isolado não prova
carregamento: usar evidência disponível da sessão/consultas sem expor conteúdo
privado. Não aumentar permissões ou limite para forçar aprovação. Não usar imports
extensos. Falha de leitura de documento obrigatório bloqueia somente o trabalho
que dele depende, enquanto outras atividades seguras podem continuar.

## Recuperação da reorganização

Antes de substituir entradas no repositório, preservar seus bytes, hashes e
condição de rastreamento, inclusive AGENTS não rastreado. Implantar em destino
isolado autorizado; não sobrescrever Totem ou trabalho paralelo. Se a validação
falhar, interromper adoção e restaurar apenas arquivos documentais abrangidos por
autorização própria, usando cópias verificadas. Nunca reset/clean genérico. Esta
pasta de preparação não autoriza adoção, staging, commit ou push.

## Sanitização técnica — correção V3-01

Maiúscula seguida de barra não identifica caminho privado. Classificar cada
ocorrência por contexto e fonte: combinações de métodos HTTP e rotas, identificadores
IANA, código, testes e .github/workflows/ci.yml são elementos técnicos públicos e
devem ser preservados quando comprovados. Caminho de evidência local sem necessidade
pública permanece sanitizado. Caso não classificado exige revisão, não remoção
automática. Registrar fonte/linha, motivo e comparação; não publicar o valor privado
para justificar sua ocultação. Conferir tokens técnicos e prazos após transformação.
Datas operacionais não são metadados descartáveis; reparo editorial usa âncora
pontual e não altera código, rotas, identificadores, durações ou limites.
