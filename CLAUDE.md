# SafeWork — entrada de Claude Code

Ramires decide; o ChatGPT orienta. Ramires define escopo e autorizações. Uma etapa aprovada abrange as leituras,
edições e testes necessários ao escopo, sem nova aprovação por comando já incluído.

Antes de agir, leia [a governança comum](docs/governanca/agentes.md) e consulte
[o índice por assunto](docs/README.md). Leia os contratos relacionados à tarefa;
amplie a leitura por dependência ou segurança. Não carregue históricos completos
por rotina. Identifique o repositório, worktree, branch e commit pertinentes.

## Salvaguardas universais

- Git de leitura permitido. Git de alteração somente com autorização específica.
  Ramires decide; o ChatGPT orienta. Staging, commit e push
  exigem seus gates; uma etapa não autoriza automaticamente a seguinte.
- Preserve alterações locais, trabalho paralelo, duplicados, memórias, evidências
  e arquivos congelados. Não sobrescreva o CLAUDE local do Totem, sua seção
  operacional ou complemento externo sem autorização específica.
- Preserve RBAC no servidor, isolamento multiempresa, criptografia, auditoria,
  integridade e privacidade. Não exponha credenciais, tokens, cookies ou segredos.
- Migrations históricas são imutáveis. Criar não autoriza aplicar. Testes de
  migrations usam PostgreSQL real, ambiente autorizado e schema temporário
  exclusivo, search_path restrito e cleanup; nunca aplicam no public.
- Serviços e dados persistentes, backups reais, restauração, AWS e produção
  mantêm autorizações próprias. Prefira serviços/portas existentes; não altere runtime por conveniência. Reinício de serviço local existente
  pode integrar a etapa quando expressamente previsto e seguro.
- Não amplie permissões, instale ferramentas ou contorne bloqueios para cumprir
  esta governança. Mudanças permanentes exigem aprovação expressa.
- Valide proporcionalmente ao risco, mantendo testes obrigatórios. Atualize o
  contrato técnico afetado junto do desenvolvimento autorizado. Reutilize
  evidências válidas com identificação e limites; não declare testes não feitos.
- Histórico não é autorização. Pare ao concluir o escopo ou quando uma decisão
  indispensável, risco ou operação protegida não abrangida impedir o avanço.

A memória persistente pode conter decisões antigas. Reconcilie conflitos com
a decisão atual e a base aprovada; não edite a memória por iniciativa própria.
Nenhum import extenso é exigido por esta entrada.
