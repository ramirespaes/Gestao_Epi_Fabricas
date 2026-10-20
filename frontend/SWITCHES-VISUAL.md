# Referência visual dos switches — SafeWork

Registrado em 18/10/2026 para manter o mesmo padrão nos próximos ajustes visuais solicitados.

Atualização de 18/10/2026: o verde da página de troca de senha passa a ser
a referência do estado ligado em todos os switches existentes do frontend
compartilhado. A autorização atual amplia o escopo visual anterior.

Fonte da cor: `--switch-on` em `css/main.css`. Os componentes existentes
continuam sendo o botão `.switch` e o checkbox `.gu .switch input + .t`.

## Cores e posições

| Estado | Cor no modo visual padrão | Fallback sem `color-mix` | Posição do indicador |
| --- | --- | --- | --- |
| Ligado (ON), claro | `--switch-on: #1F7563` | Mesma cor | Direita |
| Ligado (ON), escuro | `--switch-on: #26806B` | Mesma cor | Direita |
| Desligado (OFF) | `color-mix(in srgb, var(--error) 80%, black)` | `#CC342E` | Esquerda |
| Indicador | Branco `#FFFFFF` | `#FFFFFF` | Conforme o estado |

O verde vem do `--accent` já existente em `portal/trocar-senha.html`.
No frontend compartilhado, a seleção claro/escuro continua pelo EpiTema,
incluindo tema do sistema; não há outro seletor ou persistência de tema.
`--success` não muda, preservando indicadores e mensagens do restante da UI.

Nos modos assistivos, `--switch-on` continua derivado de `--success`
(`color-mix(in srgb, var(--success) 68%, black)`; sem suporte, `var(--success)`).
As regras específicas já existentes para `.switch.active` e cores forçadas
continuam prevalecendo. O verde de marca não substitui essas paletas.
O vermelho OFF existente permanece; switches de outros formulários que ainda
usam OFF cinza conservam esse estado, pois a mudança atual é somente no ON.

## Acabamento existente

- Trilho de 51 × 31 px; indicador circular de 27 × 27 px; deslocamento horizontal de 20 px.
- Transição de 280 ms. Nas permissões individuais, o efeito elástico discreto ocorre somente após a confirmação do estado efetivo pelo servidor.
- No formulário Novo usuário, o vínculo SST representa a seleção do formulário; sua gravação continua pelo cadastro existente.
- Preservar foco visível, teclado, semântica nativa, disabled, loading e tratamento de falhas. `prefers-reduced-motion` remove as animações e transições.

## Escopo

O verde está centralizado no componente compartilhado e nos switches da
**Gestão de Usuários**, incluindo permissões, grupos e formulários de usuário.
Somente a cor ON foi estendida aos demais checkboxes visuais; o efeito elástico
e a confirmação pelo servidor continuam restritos ao fluxo já implementado.
Novos switches devem reutilizar o token, respeitando suas posições e lógica.
Não há autorização para mudanças em backend, RBAC ou persistência.

Também aplicado localmente aos botões `.switch` de **Configurações**, em `css/configuracoes.css`: `.active` significa ligado à direita; sem a classe, desligado à esquerda. A aparência mantém o fluxo existente de aplicação imediata, salvamento e reversão em caso de falha. Nessa página há deslizamento suave, sem nova lógica de confirmação nem animação elástica adicional.

O protótipo de **Gestão de E-mails** também usa as mesmas cores em `css/integracao-visual.css`, sobre seus botões `.switch` existentes. Continua sem ligação real; a recriação dos templates e o modo de inspeção permanecem como estavam. Este ajuste não implementa persistência nem envio de e-mails.
