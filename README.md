# CloudVTurb

Plataforma SaaS de hospedagem e streaming de VSLs (Video Sales Letters) de alta conversao, otimizada para servidores dedicados, VPS e auto-hospedagem (self-hosting).

---

## Recursos Principais

- Dashboard SaaS Completo:
  - Visao geral com metricas agregadas: visualizacoes de pagina, reproducoes unicas, retencao media, cliques em CTA e monitoramento de cota de disco.
  - Gestao de pastas e videos com busca instantanea e ordenacao dinamica.
  - Editor visual completo de VSL com Live Preview (Desktop e Mobile).
  - Gerador de codigo embed responsivo para WordPress, Elementor, Webflow e HTML estatico.
  - Gestao de equipe (membros convidados) e controle de usuarios para o Administrador.
  - Sistema de Webhooks compativel com assinaturas HMAC SHA-256.
  - Documentacao interativa da API do Analytics.

- Player Ultra-Rapido e Otimizado para Conversao:
  - Smart Autoplay com barra animada e ativacao de audio inteligente.
  - Pitch Delay com surgimento programado de CTA e elementos de checkout.
  - Barra de progresso com aceleracao visual e bloqueio de avanco.
  - Retomada automatica da reproducao via armazenamento local.
  - Protecao contra clique com botao direito e atalhos de inspecao.

- Arquitetura Leve e Segura:
  - Node.js + Express + SQLite em modo WAL de alta performance.
  - Autenticacao JWT com criptografia bcrypt para senhas.
  - Primeiro cadastro na instancia assume automaticamente o papel de Administrador (Owner).
  - Isolamento de banco de dados por instancia: o arquivo SQLite e criado do zero automaticamente.
  - Zero dependencias externas de banco (nao necessita PostgreSQL ou MySQL externos).
  - Zero credenciais hardcodadas no repositorio: configuracao estrita via `.env`.

---

## Como Rodar em Qualquer VPS

### Metodo 1: Com Docker Compose (Recomendado)

1. Clone o repositorio no servidor:
```bash
git clone https://github.com/Gumballxnz/meu-vturb.git
cd meu-vturb
```

2. Crie o arquivo de configuracao:
```bash
cp .env.example .env
```

3. Ajuste o segredo JWT no `.env`:
```bash
nano .env
# Defina um valor longo e aleatorio para JWT_SECRET
```

4. Suba o container:
```bash
docker compose up -d --build
```

O servico estara ativo em `http://IP_DO_SERVIDOR:4000`.

---

### Metodo 2: Direto com Node.js

Requisitos: Node.js 20+ e FFmpeg instalado no sistema.

1. Clone e entre na pasta:
```bash
git clone https://github.com/Gumballxnz/meu-vturb.git
cd meu-vturb/server
```

2. Instale as dependencias:
```bash
npm install --production
```

3. Configure as variaveis de ambiente:
```bash
cp ../.env.example .env
```

4. Inicie o servidor:
```bash
npm start
```

---

## Primeiro Acesso e Configuracao Inicial

1. Ao abrir o painel pela primeira vez, nenhuma conta existira no banco.
2. Clique em **Cadastre-se** e preencha seu nome, e-mail e senha.
3. Insira o codigo de confirmacao de 8 digitos:
   - Se `RESEND_API_KEY` estiver preenchida no `.env`, o codigo chegara no seu e-mail.
   - Se `RESEND_API_KEY` estiver vazia, o codigo sera exibido diretamente nos logs do terminal (`docker compose logs -f` ou console do Node).
4. Como esta e a primeira conta criada, ela recebera automaticamente o papel de **Owner (Administrador Geral)**, com acesso total a criacao de pastas, upload de videos, configuracoes de cota e aprovacao de novos membros.

---

## Variaveis de Ambiente (.env)

| Variavel | Descricao | Padrao |
|---|---|---|
| `PORT` | Porta de execucao do servidor | `4000` |
| `NODE_ENV` | Modo de execucao (`production` ou `development`) | `production` |
| `JWT_SECRET` | Chave secreta longa para assinatura de tokens JWT | *Obrigatorio em producao* |
| `BASE_DOMAIN` | Dominio base para links e embeds | *Vazio (usa hostname)* |
| `DASH_DOMAIN` | Dominio exclusivo do painel (opcional) | *Vazio* |
| `PLAYER_DOMAIN` | Dominio exclusivo do player de video (opcional) | *Vazio* |
| `RESEND_API_KEY` | Chave de API do Resend para envio de e-mails | *Opcional* |
| `RESEND_FROM_EMAIL` | Remetente autenticado do Resend | `CloudVTurb <onboarding@resend.dev>` |
| `DATA_DIR` | Diretorio do banco de dados SQLite e avatares | `/app/data` ou `./server/data` |
| `VIDEOS_DIR` | Diretorio de armazenamento de videos | `/app/videos` ou `./server/videos` |
