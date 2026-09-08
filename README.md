> ⚠️ **Este é apenas o núcleo (Parte 1) do projeto.**
> As 22 páginas (`pages/*.html`) vêm na **Parte 2**, separada para facilitar
> os commits no Git. Depois de commitar esta Parte 1, adicione os arquivos
> da Parte 2 dentro da pasta `pages/` (que aqui está vazia, só com `.gitkeep`).

---

# Gestão de EPIs — Sistema Completo (Cobresul)

Pacote completo: login + recuperação de senha + biometria + autoatendimento
(totem) + modo quiosque + 21 telas do sistema, todas interligadas pelo
mesmo banco de dados simulado (request/response real).

## Estrutura

```
epi_final/
├── index.html               ← redireciona para pages/dashboard.html
│
├── js/
│   ├── db-api.js            ← "Banco de dados" (localStorage) + API simulada
│   └── main.js               ← Toda a lógica das telas, login, quiosque etc.
│
├── css/
│   └── main.css               ← Estilos do sistema
│
└── pages/                    ← 22 páginas HTML (uma por tela)
    ├── self-service.html     ← Totem: identificação por CPF + nascimento
    ├── dashboard.html
    ├── materials.html
    ├── purchases.html
    ├── epi-ficha.html
    ├── employee-history.html
    ├── reports.html
    ├── config.html            ← Modo Quiosque fica aqui
    └── ... (22 no total)
```

## Como rodar

1. Abra a pasta `epi_final` no VS Code
2. Instale a extensão **Live Server**
3. Clique direito em `index.html` → **Open with Live Server**

> Login biométrico (WebAuthn) só funciona em `https://` ou `localhost` —
> com Live Server local funciona normalmente.

## 1. Tela de Login

Toda página abre primeiro na tela de login (cobre o sistema até autenticar).

| Perfil | E-mail | Senha |
|---|---|---|
| Master | luis.freitas@cobresul.com.br | Master@2026 |
| Admin | tainara.alves@cobresul.com.br | Admin@2026 |
| Supervisor | fabio.santos@cobresul.com.br | Super@2026 |
| Usuário | marcos.silva@cobresul.com.br | User@2026 |

**Recuperação de senha:** clique em "Esqueci minha senha" → e-mail → o código
de 6 dígitos aparece no **Console do navegador (F12)** (simulando envio por
e-mail) → digite o código + nova senha.

**Login biométrico:** clique em "Configurar biometria" → e-mail + senha →
o navegador pede Touch ID / Face ID / Windows Hello nativamente. Da próxima
vez, o botão "Entrar com biometria" aparece na tela de login.

## 2. Autoatendimento (Totem)

Tela `self-service.html` — funcionário identifica-se com **CPF + data de
nascimento** (sem senha de sistema), e é levado à tela de Pedido de EPI com
os dados já preenchidos.

**CPFs de teste:**

| Funcionário | CPF | Nascimento |
|---|---|---|
| Marcos Silva | 123.456.789-45 | 15/03/1990 |
| João Pereira | 234.567.890-56 | 22/07/1988 |
| Ana Souza | 345.678.901-67 | 30/11/1995 |

A sessão tem **timeout de 60 segundos de inatividade** (sai automaticamente)
e botão **"Concluir e Sair"** para encerrar manualmente.

## 3. Modo Quiosque

Em `config.html`, card "Modo Quiosque": ative com uma senha de administrador.
Isso bloqueia toda a navegação do dispositivo — só "Autoatendimento" e
"Pedido de EPI" continuam acessíveis. Útil para deixar o computador/totem
disponível no chão de fábrica sem risco de acesso indevido a outras telas.
O bloqueio persiste mesmo recarregando a página; só sai com a senha definida.

## Como tudo fica interligado

Todas as 22 páginas carregam o mesmo `js/db-api.js`, que usa `localStorage`
como "banco de dados" — compartilhado entre todas as páginas da mesma pasta.
Qualquer ação em uma tela (aprovar pedido, registrar compra, assinar ficha)
reflete instantaneamente nas outras.

Abra o **Console (F12)** em qualquer página para ver os logs de cada
"requisição" sendo feita, como em uma API real:

```js
const res = await EpiAPI.request('POST', '/solicitacoes/3/aprovar', { aprovado_por: 1 });
console.log(res);
// { status: 200, ok: true, data: {...}, message: 'Solicitação aprovada' }
```

Ver o banco inteiro: `EpiAPI._db()` no console.
Resetar para os dados de exemplo: `EpiAPI._reset()`.
