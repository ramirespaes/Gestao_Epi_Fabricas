# Publicação do frontend do cliente

O frontend publicado em homologação ou produção é **somente** o pacote gerado por este diretório, nunca a pasta `frontend/` inteira.

```bash
cd frontend
npm run publicacao:empacotar -- --saida <diretório novo ou vazio, fora de frontend/>
```

O comando termina com código 0 quando gera o pacote e com código 1 quando o recusa. Em caso de recusa, nada é escrito.

## Por que existe

As páginas legadas do protótipo continuam no repositório: são 17 em `pages/`, mais `js/main.js` e `js/db-api.js`. Elas carregam SheetJS 0.18.5 por CDN, sem SRI e com CVE-2023-30533 e CVE-2024-22363, e simulam login e sessão, inclusive pela URL (`?_s=`).

A origem do frontend está na allowlist de CORS da API com credenciais. Por isso, qualquer script que rode nessa origem age na API com a sessão real de quem estiver logado. Essas páginas não podem ser publicadas.

## Como a allowlist é garantida

`allowlist.json` lista, arquivo por arquivo, tudo o que pode ser publicado:
- o institucional;
- o Portal do Cliente;
- as páginas integradas e seus scripts;
- `css/main.css`;
- a biblioteca local de leitura de planilhas, com a sua licença.

O que não estiver listado fica fora.

O empacotador (`empacotar.js`) recusa o pacote inteiro, **antes de escrever qualquer arquivo**, nestes casos:

1. uma entrada não é um caminho relativo canônico, está duplicada, aponta para fora de `frontend/`, é diretório, é link simbólico ou não existe;
2. uma entrada está em `NUNCA_PUBLICAR` — `js/main.js`, `js/db-api.js` ou o Painel Privado — mesmo que alguém a acrescente à allowlist;
3. uma página publicada carrega script de fora do pacote (CDN ou qualquer URL com esquema);
4. uma página ou folha de estilo publicada carrega recurso local (script, link, imagem ou `url()`) que não está na allowlist;
5. a saída já existe com conteúdo ou fica dentro do código-fonte do frontend.

Depois de copiar, o empacotador confere que o pacote tem exatamente os arquivos da allowlist, nem um a mais, nem um a menos. `test/publicacao.test.js` roda no `npm test` e prova esses comportamentos.

Acrescentar um arquivo à allowlist é uma decisão de segurança e passa por revisão como qualquer alteração de código.

## Fora do pacote do cliente, de propósito

| Item | Motivo |
|---|---|
| 17 páginas legadas, `js/main.js`, `js/db-api.js` | protótipo (ver acima) |
| `js/auth-session.js` | nenhuma página publicada o carrega |
| `index.html` da raiz | redirecionamento do protótipo, usado só em desenvolvimento |
| `painel-privado/` | tem origem própria, com allowlist de CORS disjunta da do cliente; se for publicado, será um alvo separado, com allowlist própria |
| `IMAGEN/`, `test/`, `publicacao/`, `package.json`, `vendor/README.md` | material de desenvolvimento e documentação |

## Requisitos obrigatórios do deploy do frontend

Estes requisitos valem para o servidor estático de homologação e de produção, ainda não configurado. Nenhum deles é atendido pelo código deste repositório.

1. **Publicar só o pacote.** O servidor serve apenas o diretório gerado por `npm run publicacao:empacotar`, a partir do commit que será publicado. O deploy é interrompido se o comando terminar com código diferente de 0.
2. **CSP no servidor estático (segurança S4 da auditoria do Bloco 9).** A `Content-Security-Policy` das páginas é obrigatória e deve ser configurada nessa camada. O Helmet do backend só cobre as respostas da API. A política precisa considerar o que as páginas usam hoje:
   - scripts inline nas páginas integradas: exigem hashes, nonces ou a extração para arquivos, e a decisão é tomada no deploy;
   - estilos e fontes do Google Fonts;
   - chamadas à API na mesma origem, em `/api`.

   No mínimo: nenhum host de script externo, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. Não publicar sem CSP e não usar uma CSP parcial apenas para constar.
3. **Rota `/`.** O `index.html` da raiz não é publicado; o servidor define para onde `/` leva (o Portal, em `/portal/`, ou o institucional).
4. **Painel Privado e links do institucional.** O Painel Privado é publicado em outra origem, com alvo próprio. Os botões do institucional seguem o que está descrito no README da raiz, em "Conexão futura da página institucional".
