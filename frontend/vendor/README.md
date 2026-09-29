# Bibliotecas de terceiros incorporadas localmente

Arquivos copiados **sem modificação** da distribuição publicada, para que as páginas não dependam de CDN externo em tempo de uso. Qualquer troca de versão exige um novo registro aqui e a atualização do hash conferido pelo teste indicado em cada biblioteca.

## read-excel-file 9.3.10

| Item | Valor |
|---|---|
| Arquivo | `vendor/read-excel-file-9.3.10.min.js` (47.996 bytes) |
| Uso | leitura de planilhas `.xlsx` na página Importar Funcionários (Bloco 9, Etapa C, Parte C4); expõe o global `readXlsxFile` |
| Origem | pacote npm `read-excel-file@9.3.10`, arquivo `bundle/read-excel-file.min.js`, obtido de `https://cdn.jsdelivr.net/npm/read-excel-file@9.3.10/bundle/read-excel-file.min.js` em 25/09/2026 |
| Publicação no npm | 10/08/2026 |
| Repositório | https://github.com/catamphetamine/read-excel-file |
| Licença | MIT — texto em `vendor/LICENSE-read-excel-file.txt` |
| SHA-256 | `eb774939e3cabf764483ba7d16515d058186eb0587b67de81d40b9aa442f30fa` |
| SRI (sha384) | `sha384-6BSLnvfajxTCuqK/JGcR5U3r380qftQ27m9iNB7y8zk/pHo6+JNtyjsNQ/e0kecB` |
| Hash conferido por | `frontend/test/funcionarios.test.js` |
| Dependências (árvore npm, só leitura) | `fflate` 0.8.3, `saxen` 11.2.0, `worker-f` 0.1.20, `unzipper-esm` 0.13.3 (+ `graceful-fs` 4.2.11, `node-int64` 0.4.0, só no Node); `npm audit` em 25/09/2026: 0 vulnerabilidades |
| Substitui | SheetJS `xlsx` 0.18.5 via CDN (CVE-2023-30533 e CVE-2024-22363), removida da página integrada |

Comportamentos em que a página confia (verificados no código-fonte da versão):
- só `.xlsx` (o `.xls` antigo é recusado pela própria biblioteca);
- fórmulas não são calculadas (usa o valor salvo);
- datas criadas em UTC.

## qrcode-generator 2.0.4

| Item | Valor |
|---|---|
| Arquivo | `vendor/qrcode-generator-2.0.4.js` (56.694 bytes) |
| Uso | QR Code do cadastro do autenticador (TOTP) no Painel Privado, páginas `painel-privado/index.html` e `painel-privado/seguranca.html`; expõe o global `qrcode` |
| Origem | pacote npm `qrcode-generator@2.0.4`, arquivo `dist/qrcode.js`, extraído de `https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz` em 28/09/2026 |
| Integridade do pacote | `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`, igual à publicada no registro npm |
| Publicação no npm | 07/08/2025 |
| Repositório | https://github.com/kazuhikoarase/qrcode-generator |
| Licença | MIT — o pacote não traz arquivo de licença; o texto em `vendor/LICENSE-qrcode-generator.txt` é o `LICENSE` do repositório oficial |
| SHA-256 | `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c` |
| SRI (sha384) | `sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA` |
| Hash conferido por | `frontend/test/painel-privado-mfa.test.js` |
| Dependências | nenhuma |
| Fora do pacote do cliente | o Painel Privado não é publicado com o Portal; este arquivo não entra em `publicacao/allowlist.json` |

Só `dist/qrcode.js` foi incorporado. Ficaram de fora as variantes `SJIS` e `UTF8`, os módulos `.mjs`, os tipos e os testes do pacote.

Comportamentos em que a página confia (verificados no código-fonte da versão):
- só calcula: não acessa rede, DOM nem armazenamento do navegador, e não usa `eval`;
- `qrcode(0, 'M')` escolhe sozinho o menor tamanho que comporta o conteúdo;
- a página usa apenas `addData`, `make`, `getModuleCount` e `isDark`; o SVG é montado pela própria página, sem as funções da biblioteca que devolvem HTML.
