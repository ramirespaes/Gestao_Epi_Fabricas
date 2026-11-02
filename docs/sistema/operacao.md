# Operação, serviços, backups e implantação

Preparado em 02/11/2026 para revisão. Base técnica local: `efea5bad7fd433f699b78831a01c69866438f2ab`.
Não comprova GitHub remoto, banco aplicado ou runtime ativo.

Prefira serviços e portas já existentes, com confirmação do worktree servido,
versão e banco autorizado. Não iniciar, reiniciar, redirecionar, parar ou enviar
sinais sem autorização aplicável. Identifique processo por PID/início/comando/cwd
e dependências; nunca sinalização ampla. PIDs/portas de relatos são fotografias.
Não usar launcher antigo preso a migrations 090 em ambiente que evoluiu até 096.
Não alterar .env, permissões, links históricos ou dados para satisfazer uma guarda.
HML e produção são independentes; CI verde não autoriza deploy. DNS, HTTPS, CORS,
cookies, proxy confiável, SMTP e storage devem ser validados na implantação.

### Backup e restauração

Backup real e restore exigem autorização própria, identidade do alvo e plano de
recuperação. Dumps e imagens potencialmente pessoais ficam fora de área sincronizada
e do Git público; não publicar dumps nas evidências. Validar origem, integridade,
consistência, catálogo e restauração isolada; hash sozinho não prova restaurabilidade.
DB+imagens: garantir efetivamente janela sem escrita sobre arquivos/linhas relevantes
(upload, exclusão, limpeza, purga, reprocessamento e alterações manuais), provar
estado antes/depois, verificar origem ANTES de copiar, capturar banco antes dos
arquivos e manifesto da cópia. Fingerprint prova, mas não bloqueia escrita.
Alternativa consistente depende de aceitação escrita anterior e ensaio apropriado.
Diferença gera captura não consistente, preservada, nunca remendada. Errata E-65-01
prevalece sobre receitas históricas “arquivos primeiro”. Restore só em banco E
diretório novos autorizados. Backup e limpeza devem se excluir mutuamente; retenção
da limpeza maior que o intervalo entre backups. Não executar limpeza real de órfãos.
D-ORF-6 é frente própria protegida: não mover, apagar, executar wrappers, reutilizar
autorização ou declarar GREEN por teste histórico. Travas/wrappers de uso único,
inclusive g3 NAO-EXECUTAR, permanecem protegidos. Finder recusou? Pare, sem contorno.

### Documentos especializados existentes — fonte única

Consultar [os caminhos das fontes únicas](fontes-especializadas.md), sem cópias paralelas. A
publicação utiliza somente pacote aprovado/allowlist, com CSP do servidor estático,
origens separadas, cache e requisitos da versão. A Biblioteca Padrão de Imagens
tem procedimento próprio de provisionamento, verificação e recuperação. Não
substituir esses procedimentos por resumo. Fontes originais permanecem no projeto.

## Contratos gerais preservados

### Origem CLAUDE §57 — linha 1193

> Texto registrado preservado. Versões, contagens, aplicação em banco e aprovações são fotografias;
> alterações expressas são reconciliadas na rastreabilidade. As garantias técnicas não são revogadas por idade.

# 57. Banco de produção

Nunca presumir que existe autorização para executar alteração no banco de produção.

Criar migration e executar migration são autorizações diferentes.

Testar SQL localmente não autoriza aplicação em produção.

---


## S63-086 — origem CLAUDE.md:1614–1620

**Classificação:** contrato técnico; inclui contexto histórico, gates e pendências datadas.

Texto completo da unidade preservado abaixo. Requisitos internos não resumidos; nenhum número de resultado histórico é uma validação nova. Consulte as reconciliações antes de aplicar decisão temporal.

- **Código (J2a):** `config/token-monitoramento.js` (heartbeat 60 s ±10 %; OFFLINE a partir de 180 s de silêncio, limiar inclusivo; confirmação 90 s; janela mínima de escrita 45 s; prazo máximo da suspeita 300 s), `services/token-monitoramento.service.js` (`derivarEstado` pura: `REVOGADO | NAO_ATIVADO | SEM_COMUNICACAO | ONLINE | OFFLINE`; `registrarContato` pela batida; `verificarComunicacao` = passagem única do job, com relógio e sonda injetados), `repositories/token-monitoramento.repository.js` e `token-dispositivo-evento.repository.js`, `routes/token-heartbeat.routes.js` + controller + schema (`POST /api/atendimento-token/tablet/heartbeat`, cookie do tablet, corpo e query vazios; **[SUPERADO — R06] Registro anterior: montagem superada pelo Ciclo 2 (S63-092); situação do runtime atual não verificada. NÃO montada em `app.js`** — montagem é etapa própria, X2/P-01), `security/autoridade-job-interno.js`, `utils/sonda-publica.js`, `scripts/verificar-comunicacao-token.js` (`npm run token:verificar-comunicacao`; saídas 0 passagem concluída, 1 configuração/autoridade inválida ou falha, 2 sonda reprovada ou inconclusiva, 3 banco indisponível; `TOKEN_JOB_DB_SCHEMA` opcional, padrão `public`, [SUPERADO — R06: P-06 resolvido no Ciclo 2] ainda ausente do `.env.example`, P-06). A QUEDA é confirmada só pelo job, numa passagem posterior à primeira observação (`queda_suspeita_desde`, `089`); o RESTABELECIMENTO é feito pela batida; nunca timer na API.
- **Autoridade mínima do job:** o job atravessa empresas, então o limite real é a CREDENCIAL DO BANCO: credencial própria (`TOKEN_JOB_DB_USER`/`TOKEN_JOB_DB_PASSWORD`, nunca a da API), lida só pelo script; só opera depois de o próprio banco confirmar quem está conectado e os privilégios EFETIVOS contra a lista positiva por coluna `OBJETOS_PERMITIDOS` (`empresas(id, ativo)` leitura; `token_dispositivos` leitura de 7 colunas e UPDATE só de `comunicacao_registrada` e `queda_suspeita_desde`; `token_dispositivo_eventos` INSERT de 5 colunas e SELECT de `id`), recusando papel privilegiado, pertencimento a outros papéis, CREATE no banco ou em schema do caminho de busca, objeto fora do schema, privilégio faltando ou sobrando, relação temporária na sessão ou objeto resolvido para tabela temporária (`SQL_CAMINHO` corrigido na Fase B para excluir `pg_my_temp_schema()`; teste `token-j/job-monitoramento-sql-caminho.test.js`); mensagens só com nomes, nunca valores. `TOKEN_SONDA_URL_PUBLICA` sem valor (P-03).
- **Infraestrutura de teste:** cluster PostgreSQL DEDICADO criado pelo responsável (`[FONTE_PRIVADA]`, `[ENDERECO_LOCAL_DOCUMENTADO]`, papel `[IDENTIDADE_LOCAL_PRIVADA]`; não é serviço, morre no reinício do Mac); guarda D1 (`test/integracao/helpers/guarda-instancia-dedicada.js`, `test/integracao/exigir-instancia-dedicada.js`, `test/token-j/guarda-d1.test.js`: as suítes J2a só rodam contra a instância dedicada); Marcos 1, 2 (Camada B), 3A e 3B ("RED INTEGRADO VÁLIDO", documento 19); 16 testes de contagem ajustados 88→89 (`J-REGISTRO-TESTES-CONGELADOS.md`, R3-001); suíte `test/token-j` com 132 testes (130 PASS, 2 TODO: DEP-U01 e DEP-U02).
- **Homologação real da role mínima (Fase 4B):** rodada `a741c814064460f9` REPROVADA (D1: 42P08 em `INSERT … CASE WHEN $6 THEN $3 END` sem tipo; D2: `$2` indefinido sob `set -u` no `rodada.sh`) e recuperação R3; D1 provada em PostgreSQL 16 temporário; aplicação D1/D2 (G1 ensaio em réplica, G2 real); guarda do wrapper (trava `mkdir` atômica de execução única); rodada `957fad794d3a5b36` REPROVADA só em "testar sombreamento" (a autoridade devolvia `SCHEMA_COM_CREATE` em vez de `OBJETO_TEMPORARIO`), contraprova C1–C4 e Fase B (autoridade `afff8311…` → `184c8bcb…`, backup `[FONTE_PRIVADA]`, wrapper g3 com 8 pinos); **rodada `697af3a405965adc` (wrapper g3, 14/10/2026) APROVADA: 38 PASS, 0 FAIL, 0 SKIP, 2 INFORMATIVOS** (não contados como PASS: `faltando-usage-schema` e `sequencia-evento-usage-select` — a autoridade tolera `USAGE`/`SELECT` na sequência do evento; decisão pendente do responsável), limpeza com código 0 (role e schema ausentes, fotografia antes = depois `fc7c0c3a…`), instância compartilhada intacta, trava g3 criada (nova rodada exige novo wrapper e decisão). Dos 38 PASS, 13 são portões de restauração; 25 são verificações substantivas.
- **Auditoria independente:** workflow `wf_b2bfa75a-117` (14/10/2026, 22:29–22:56, só leitura, cinco agentes, sem conexão ao PostgreSQL): **CONCLUÍDA, APROVADA com observações**, sem divergência bloqueante; resultado incorporado ao termo (§9), ao manifesto (I-01/I-02) e ao checkpoint (§8). O manifesto lista as evidências com SHA-256 (classe P, persistentes, e classe C, cópias preservadas em `evidencias-preservadas/01…08`), reverificável por `verificar-manifesto-bloco-i.sh` (só leitura).
- **Status documental em 15/10/2026:** resultado técnico **GREEN J2a (Fase 4B) APROVADO**; auditoria concluída; encerramento documental **PREPARADO e reconciliado**, aguardando (a) a revisão da V7 e (b) a decisão do responsável nas caixas do termo §10 (aceite; desvios procedurais dos auditores; tolerância `USAGE`/`SELECT`; ajustes). **A aprovação é restrita ao ambiente dedicado e NÃO é liberação para produção.** Não fazem parte do encerramento: Git, congelamento de baseline, Etapa I, Etapa J inteira e Etapa K. Divergência registrada: o manifesto (gerado em 14/10 às 22:48) pina `helpers/token-j.js` em `2131e49f…` (D-21), mas a correção da CI `18e7296` (15/10) alterou esse arquivo (`cbea6c81…`); os demais pinos conferidos (autoridade `184c8bcb…`, guarda D1, `exigir-instancia-dedicada.js`, teste novo `49d350b4…`) estão íntegros — regenerar o manifesto só com autorização. O termo registra um `git status --short` de leitura executado por engano em 14/10 às 21:40, já comunicado.
- **PR #57 e CI (15/10/2026):** a integração à `main` e a correção `18e7296` estão na nota de 15/10/2026 em "Entrega Git do Bloco 12": três suítes J2a exigiam o sentinela da guarda D1; a prova alternativa de instância efêmera do GitHub Actions (marcador por execução + nonce no comentário do banco, variáveis `PG*`/`DATABASE_URL`/`NODE_OPTIONS` proibidas, só runner `github-hosted`) vale só na CI; fora dela a guarda D1 continua obrigatória. **Testes aprovados ≠ implantação em produção:** o job não tem role real, agendador, valor de sonda nem rota montada (P-01 a P-04).


## Aplicação e dependências

Consulte [o índice](../README.md), [a governança](../governanca/agentes.md) e
[as reconciliações](../../historico/governanca/reconciliacoes.md).
Não executar procedimentos por constarem nesta proposta.

## MEM-26 — decisão histórica de hospedagem Lightsail

Registro de decisão de hospedagem: AWS, com Amazon Lightsail como opção inicial;
outros provedores haviam sido descartados. API prevista em /api na origem da
aplicação. Orçamento histórico desejado de US$30/mês, margem avaliável até US$40;
exceder limite depende de decisão. Não reduzir segurança/backup para economizar;
avaliar custo recorrente após créditos e criptografia antes de contratação.
Preços, regras promocionais, plano de banco, prazo de deploy e topologia são
informações históricas não revalidadas, não estados atuais. Domínio real e custódia
local não são publicados. Decisão não autoriza DNS, contratar, migrar, reiniciar
ou implantar; frente/equipe AWS mantém responsabilidade e autorização próprias.
Mudança de provedor ou arquitetura não ocorre por iniciativa do agente documental.

## Referência operacional atual

R06 comprova documentalmente a montagem do heartbeat no Ciclo 2 e resolução de
P-06 na referência histórica correspondente. Não prova serviço hoje ativo nem
homologação. A coluna de 089 é pré-condição do contato; aplicação em banco requer
autorização própria. Não executar receita J2a só porque está descrita.
