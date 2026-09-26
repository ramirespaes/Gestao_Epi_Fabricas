# Bibliotecas de terceiros incorporadas localmente

Arquivos copiados **sem modificação** da distribuição publicada, para que as páginas não dependam de CDN externo em tempo de uso. Qualquer troca de versão exige um novo registro aqui e a atualização do hash conferido por `frontend/test/funcionarios.test.js`.

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
| Dependências (árvore npm, só leitura) | `fflate` 0.8.3, `saxen` 11.2.0, `worker-f` 0.1.20, `unzipper-esm` 0.13.3 (+ `graceful-fs` 4.2.11, `node-int64` 0.4.0, só no Node); `npm audit` em 25/09/2026: 0 vulnerabilidades |
| Substitui | SheetJS `xlsx` 0.18.5 via CDN (CVE-2023-30533 e CVE-2024-22363), removida da página integrada |

Comportamentos em que a página confia (verificados no código-fonte da versão):
- só `.xlsx` (o `.xls` antigo é recusado pela própria biblioteca);
- fórmulas não são calculadas (usa o valor salvo);
- datas criadas em UTC.
