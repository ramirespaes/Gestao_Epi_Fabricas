# Modelos Nginx de homologação

Estes arquivos são **modelos**. Eles não são aplicados em nenhum servidor por este
repositório, e o caminho `/var/www/safework/hml/...` citado na documentação é só
referência de planejamento. Renderizar e instalar exige autorização específica para
alterar a infraestrutura.

| Modelo | Papel |
|---|---|
| `portal.conf.modelo` | origem do Portal do Cliente; `/api/` vai ao backend, `/api/plataforma/` responde 404 |
| `painel.conf.modelo` | origem do Painel Privado; só `/api/plataforma/` vai ao backend, o resto de `/api/` responde 404 |
| `seguranca-portal.conf.modelo`, `seguranca-painel.conf.modelo` | cabeçalhos de segurança, incluídos no servidor e em todo `location` que define `add_header` |

`renderizar-modelo.js` troca cada `{{NOME}}` por um valor validado e recusa o que
puder injetar diretiva (`;`, `{`, `}`, `"`, `\`, `$`, quebra de linha), caminho
relativo, domínio curinga ou CSP fraca. A CSP vem de `deploy/hml/csp/gerar-csp.js`,
calculada sobre o pacote que será publicado.

## O que a operação ainda precisa fazer (nada disso está feito)

1. Validar a configuração renderizada no servidor com `nginx -t` antes de recarregar.
2. Definir **TLS**: certificados, renovação e o valor real de HSTS (os modelos usam o
   que for informado; comece com um `max-age` curto).
3. Ajustar `TRUST_PROXY_HOPS` do backend para a topologia real: com este proxy local
   o valor esperado é 1, e sem ele o limite por IP e o IP gravado na auditoria ficam
   errados.
4. Definir `PLATAFORMA_HOST` no backend com o domínio do Painel, e `CORS_ORIGIN` e
   `PLATAFORMA_CORS_ORIGIN` com as origens `https://` reais e disjuntas.
5. Decidir o destino de `/` de cada origem e o limite do corpo de requisição.
5a. Definir `RAIZ_ACME`: a porta 80 atende só o desafio ACME HTTP-01 nesse diretório e redireciona o resto para o domínio fixo. A regra de dotfiles da porta 443 bloqueia `/.well-known/`, o que é intencional.
5b. Definir `REDE_VERIFICACAO`: `versao.json` (commit instalado) só responde a `127.0.0.1`, `::1` e a essa rede, com 403 para o resto. Use um IP único ou uma rede estreita (IPv4 a partir de /24, IPv6 a partir de /64); faixas amplas, `0.0.0.0` e `::` são recusados. `HSTS_MAX_AGE` fica entre 300 e 63072000 segundos (nunca 0). O Portal nega `/api/plataforma` em qualquer caixa e com ou sem barra final; prove isso em Nginx real (`nginx -t` e requisições de cada variante), porque o modelo só foi verificado de forma estática. Com proxy ou CDN na frente do Nginx, `$remote_addr` seria o do proxy e a regra precisa ser revista.
5c. Os modelos não usam `http2`: a diretiva `http2 on` exige nginx 1.25.1 ou superior. Habilite HTTP/2 só depois de conhecer a versão instalada.
6. Rodar `verificar-publicacao.js` depois de cada publicação: ele confere o commit
   exposto em `/versao.json`, o hash de cada arquivo, os cabeçalhos e o isolamento.

## Armadilha conhecida

Em Nginx, um `add_header` dentro de `location` descarta os cabeçalhos do servidor.
Por isso todo `location` que define `add_header` repete o `include` do arquivo de
segurança, e um teste automatizado falha se alguém esquecer.
