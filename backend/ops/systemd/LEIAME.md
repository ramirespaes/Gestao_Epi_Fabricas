# Modelos de unidades systemd do executor do backup (D-ORF-6)

Estes arquivos são MODELOS INERTES, preparados para a futura integração. O repositório não instala, habilita nem inicia nada. Os marcadores `<...>` (ambiente, id da ficha, frase de confirmação, agenda,
limites, unidade de alerta) fazem a unidade falhar de propósito enquanto não forem preenchidos; os arquivos terminam em `.modelo` para não serem confundidos com unidades reais.

Para usar é preciso, antes e com autorização própria: gates DEP-2 e AWS aprovados, listas reais preenchidas, `OPERACAO_HABILITADA` ligada em mudança revisada, RPO e RTO fixados (definem os limites do
monitoramento), usuários de serviço criados, diretórios e arquivos de ambiente conferidos por `backup-operar --verificar` e o arquivo-chave `/etc/safework/backup-habilitado` criado por quem decide.

- `safework-backup.*`: backup (host do backup; credencial do publicador; evidência no arquivo e no journal).
- `safework-backup-verificador.*`: verificação independente (FORA do host do backup; credencial do verificador, arquivo de ambiente próprio).
- `safework-backup-monitor.*`: leitura do arquivo de evidências (sem rede; código 7 = alerta).

A frase de confirmação e a regra de cada modo estão em `docs/sistema/operacao.md` (seção do executor).
