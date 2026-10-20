# Padrão geral dos pop-ups — SafeWork

Decisão de 18/10/2026: o vidro fosco do Guia rápido deve ser a regra geral
das janelas do frontend, incluindo **Novo usuário**. A superfície deixa
perceber as cores ao fundo, com leitura confortável em claro e escuro.

## Implementação compartilhada

A regra está em `css/main.css`, sobre os componentes existentes:

- `.modal-overlay > .modal-card`: modais comuns, formulários, assinaturas,
  QR codes, seletor de imagens e modais dos protótipos.
- `.gu .overlay > .modal`: todos os modais de Gestão de Usuários, incluindo
  Guia rápido, Novo/Alterar/Duplicar usuário, grupos, permissões e confirmações.
- `.fn .overlay > .modal`: cadastro, edição e confirmação de situação dos colaboradores.
- `.modal-ca > .modal-ca-caixa`: janela informativa de CA em Relatórios.

As regras locais de superfície que duplicavam esse efeito em
`css/gestao-usuarios.css` e `css/integracao-visual.css` foram retiradas.
As folhas locais mantêm os layouts, raios, espaçamentos e controles.

## Acabamento

- `--popup-blur`: 26 px; `--popup-saturation`: 160%.
- `--popup-glass`: superfície com 68% de `--surface-container` no claro e
  76% no escuro, antes do leve realce de `--primary` e do reflexo.
- `--popup-border` e `--popup-shadow`: bordas, reflexos e sombras que
  acompanham `data-theme`, sem criar outro sistema de tema.
- Textos, campos e botões mantêm sua opacidade e semântica. O Guia rápido
  conserva a entrelinha local de 1,75; formulários mantêm sua tipografia.
- A camada externa escurece o fundo com 28% no claro e 52% no escuro.

As propriedades de superfície usam prioridade explícita para o padrão
prevalecer sobre os antigos fundos locais. Essa prioridade não alcança
tamanho, posição, visibilidade, z-index, foco, rolagem ou conteúdo.

## Preservação e uso futuro

### Campos de preenchimento

Os campos compartilhados também recebem vidro fosco em `css/main.css`,
dentro e fora dos pop-ups: inputs e textareas `.input`/`.in`, selects
`.input`/`.select`/`.in` e selects existentes de `.fn`. Isso inclui Nome,
Fabricante e Local no formulário Novo dispositivo do Atendimento Token.

- `--field-glass`: no claro, 76% de `--surface-container-highest`; no
  escuro, 76% de `--surface-container-high`, com realce de `--primary` de
  3% e um reflexo discreto. O fundo deixa perceber a superfície externa
  sem manter o branco chapado. Textos não recebem transparência.
- Sem suporte a `color-mix`, o fundo é sólido `--surface-container-high`.
  Modos assistivos e contraste elevado do sistema conservam os estilos
  anteriores; impressão também não recebe essa camada.
- A prioridade alcança somente `background`. Bordas de erro, anéis de
  foco, tamanhos, raios, validações e comportamento permanecem existentes.
  Campos disabled (inclusive por fieldset), readonly, aria-disabled e
  aria-busy são excluídos. Interruptores, arquivos e outros controles
  não textuais não recebem o acabamento.
- Menus nativos dos selects usam fundo sólido para leitura. O navegador
  ainda pode aplicar sua própria aparência ao preenchimento automático.
- Não acrescentar desfoque por campo nem animações: a janela ou o painel
  externo já fornece o vidro, preservando desempenho e movimento reduzido.

### Contrato dos componentes

1. Reutilizar esses componentes ao criar novas janelas; não montar um
   segundo sistema de pop-ups, tema ou acessibilidade.
2. Os modos assistivos existentes continuam com superfícies sólidas.
   Sem suporte ao efeito, mantém-se o fallback sólido de cada componente.
   Contraste elevado do sistema e cores forçadas também recebem fundo sólido.
3. O acabamento é exclusivo de tela: não altera os estilos de impressão.
   QR codes, imagens e áreas de assinatura conservam seus próprios fundos,
   dimensões e comportamento.
4. Preservar proporção entre raios e recuos, área útil, foco visível,
   teclado, leitor de tela, fechamento, estados de erro, loading, disabled
   e movimento reduzido. O padrão não acrescenta animações.
5. Não alterar confirmação, persistência, permissões, autenticação,
   chamadas de API ou regras de negócio para obter o efeito.
6. Alertas e confirmações nativos do navegador não são modais HTML e não
   são substituídos por essa regra. O Totem externo e o Painel Privado
   mantêm suas folhas próprias.

Esta decisão autoriza o acabamento compartilhado; a avaliação visual das
janelas continua necessária, inclusive em larguras menores e modos assistivos.
