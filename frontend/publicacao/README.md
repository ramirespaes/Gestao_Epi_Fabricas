# Publicação do frontend do cliente

O frontend publicado em homologação ou produção é **somente** o pacote gerado por este diretório, nunca a pasta `frontend/` inteira.

```bash
cd frontend
npm run publicacao:empacotar -- --saida <diretório novo ou vazio, fora de frontend/>
```

O comando termina com código 0 quando gera o pacote e com código 1 quando o recusa. Em caso de recusa, nada é escrito.

## Por que existe

As páginas legadas do protótipo continuam no repositório: são 13 em `pages/` desde o fechamento do Bloco 9, mais `js/main.js` e `js/db-api.js`. Elas carregam SheetJS 0.18.5 por CDN, sem SRI e com CVE-2023-30533 e CVE-2024-22363, e simulam login e sessão, inclusive pela URL (`?_s=`).

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
3. uma página publicada carrega script de fora do pacote (CDN ou qualquer URL com esquema). A única exceção é o script oficial do Turnstile, pela URL literal `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, e só em `portal/index.html` (login) e `portal/recuperar-senha.html` (recuperação de senha); qualquer outra página, URL, domínio parecido ou prefixo é recusado;
4. uma página ou folha de estilo publicada carrega recurso local (script, link, imagem ou `url()`) que não está na allowlist;
5. a saída já existe com conteúdo ou fica dentro do código-fonte do frontend.

Depois de copiar, o empacotador confere que o pacote tem exatamente os arquivos da allowlist, nem um a mais, nem um a menos. `test/publicacao.test.js` roda no `npm test` e prova esses comportamentos.

Acrescentar um arquivo à allowlist é uma decisão de segurança e passa por revisão como qualquer alteração de código.

**Limite conhecido.** A inspeção do HTML é por expressões regulares, não um parser completo. Formas anômalas, como `<script/src="https://...">` (barra no lugar do espaço), não são reconhecidas como script externo, e `<base href>` não é inspecionado: um `<base>` externo faria os caminhos relativos da allowlist carregarem de outra origem. Nenhuma página do repositório usa essas formas, e a CSP obrigatória do servidor estático (requisito 2 abaixo: nenhum host de script externo e `base-uri 'none'`) cobre os dois casos. Endurecer o empacotador é hardening futuro de publicação, junto da CSP e da implantação (Bloco 14).

## Pacote do Painel Privado

O Painel Privado tem empacotador e allowlist independentes: `empacotar-painel.js` e `allowlist-painel.json`. O módulo não importa o empacotador do cliente, e uma mudança em um nunca altera o outro.

```bash
cd frontend
npm run publicacao:empacotar-painel -- --saida <diretório novo ou vazio, fora de frontend/>
```

O comando termina com código 0 quando gera o pacote e com código 1 quando o recusa. Em caso de recusa, nada fica escrito. O pacote tem **25 arquivos**, sempre a árvore completa a partir da raiz: `painel-privado/`, `js/`, `vendor/` e `favicon.svg`. Nenhuma página é editada, porque os caminhos relativos (`../js/`, `../vendor/`, `../favicon.svg`) continuam válidos.

| Grupo | Arquivos |
|---|---|
| Próprios (20) | todos os de `painel-privado/`: 8 páginas HTML (`index`, `painel`, `empresas`, `seguranca`, `suporte`, `aceitar-convite`, `recuperar-senha`, `redefinir-senha`), 11 scripts (um por página, mais `config.js`, `mfa.js` e `sair.js`) e `mfa.css` |
| Compartilhados (5) | `js/api-http.js`, `js/senha-ciclo.js`, `vendor/qrcode-generator-2.0.4.js`, `vendor/LICENSE-qrcode-generator.txt`, `favicon.svg` |

Os 5 compartilhados são fixados no código do empacotador (`COMPARTILHADOS_PERMITIDOS`), não só na allowlist. Incluir um sexto arquivo de `js/` ou `vendor/` exige mudança de código revisada.

### Validações, todas antes de escrever qualquer arquivo

1. Entradas canônicas, sem duplicata, arquivo regular dentro de `frontend/`, sem link simbólico.
2. `NUNCA_PUBLICAR`: tudo fora de `painel-privado/` e dos 5 compartilhados é recusado mesmo listado. Isso exclui Portal, Totem, institucional, páginas integradas, protótipos, `test/`, `publicacao/` e `IMAGEN/`.
3. Nenhum script externo, **sem exceção** (o Turnstile aceito no Portal é recusado aqui). Folha, imagem, fonte, `@import` e `url()` externos também. `<base>`, `<iframe>`, `<object>`, `<embed>` e a forma `<script/` são recusados. Nenhuma página do Painel usa essas formas hoje.
4. Todo recurso local carregado por página ou folha, e todo link de navegação para `.html`, está na allowlist.
5. O vendor do QR Code tem o SHA-256 fixado no código, o mesmo de `vendor/README.md`.
6. A saída é nova ou vazia e fica fora do código-fonte.

Depois da cópia, o pacote é conferido contra a allowlist e o manifesto SHA-256. Qualquer divergência apaga só o que o módulo escreveu, preservando um diretório vazio preexistente. A API devolve o manifesto, que nunca é gravado dentro do pacote. As provas estão em `test/publicacao-painel.test.js`, no `npm test`.

**Mesmos limites do pacote do cliente.** A inspeção do HTML é por expressões regulares, e a CSP obrigatória do servidor estático continua sendo a segunda barreira. As páginas do Painel têm `<style>` inline e `index.html` tem um `<script>` inline, que exigem hash ou nonce na CSP do Painel. O Painel depende de a API responder na mesma origem, em `/api/plataforma` (ver `painel-privado/config.js`).

## Release de homologação (preparação)

`.github/workflows/deploy-hml.yml` valida o commit e gera os dois pacotes com manifestos, guardados apenas como artefato da execução. **Nesta etapa ele não publica nada**: sem segredos, sem AWS, sem job de deploy. O procedimento, os releases versionados, o rollback de código e a coordenação com D-ORF-6 estão em `docs/sistema/publicacao-homologacao.md`.

## Fora do pacote do cliente, de propósito

| Item | Motivo |
|---|---|
| 13 páginas legadas, `js/main.js`, `js/db-api.js` | protótipo (ver acima) |
| `js/auth-session.js` | nenhuma página publicada o carrega |
| `index.html` da raiz | redirecionamento do protótipo, usado só em desenvolvimento |
| `painel-privado/` | tem origem própria, com allowlist de CORS disjunta da do cliente; é publicado por alvo separado, com empacotador e allowlist próprios (seção "Pacote do Painel Privado") |
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
5. **Cache explícito.** HTML, JS e CSS saem com `Cache-Control: no-cache` (o navegador guarda, mas pergunta ao servidor antes de reusar). Sem `Cache-Control`, o navegador aplica validade heurística e pode continuar mostrando, por horas, páginas e scripts da versão anterior ao deploy sem consultar o servidor. Isso foi medido no Chrome 154 durante a validação da 12G-2.
