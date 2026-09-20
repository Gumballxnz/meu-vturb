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

---

## Otimizacao para Alta Escala e Maxima Performance (Custo R$ 0,00)

Para rodar dezenas de ofertas em escala com centenas ou milhares de pessoas assistindo simultaneamente sem gastar nada com CDNs pagas e sem sobrecarregar a largura de banda da VPS, siga estas recomendacoes essenciais:

### 1. DNS e Proxy no Cloudflare (Gratuito)

1. Aponte seus dominios para o IP da sua VPS:
   - `@` ou `meudominio.com` (Tipo `A` -> IP da VPS, Nuvem Laranja **Ativada**)
   - `player.meudominio.com` (Tipo `CNAME` ou `A` -> IP da VPS, Nuvem Laranja **Ativada**)
   - `dash.meudominio.com` (Tipo `CNAME` ou `A` -> IP da VPS, Nuvem Laranja **Ativada**)
2. O **Proxy Laranja (Proxied)** oculta o IP real do seu servidor, oferece protecao anti-DDoS e permite que a rede global da Cloudflare sirva seus arquivos diretamente dos servidores de borda (Edge) em Sao Paulo, Rio de Janeiro e outras capitais.

---

### 2. Regra de Cache para Seguranca e Escala de Videos HLS (Obrigatorio para Trafego Pesado)

Por padrao, o plano gratuito da Cloudflare nao armazena em cache arquivos de video fragmentado (`.ts`). Para habilitar o cache dos segmentos de streaming e economizar mais de 95% do consumo de banda do seu servidor:

1. No painel da **Cloudflare**, selecione seu dominio.
2. No menu lateral, acesse **Caching** ➡️ **Cache Rules** (Regras de Cache).
3. Clique em **Criar regra** (Create rule) e selecione **Cache Rules**.
4. Configure os campos exatamente assim:
   - **Nome da regra**: `Cache HLS Videos`
   - **Se as solicitacoes recebidas coincidirem**: `Personalizar expressao do filtro`
   - **Campo**: `Caminho do URI` (ou `URI Path`)
   - **Operador**: `comeca com` (ou `starts with`)
   - **Valor**: `/videos/`
   *(Ou no editor de expressao: `starts_with(http.request.uri.path, "/videos/")`)*
   - **Elegibilidade de cache**: `Qualificado para cache` (Eligible for cache)
   - **TTL da borda**: Clique em `+ Adicionar configuracao` e selecione `Use o cabecalho de controle de cache, se presente, e ignore o cache, caso contrario` (ou *Respect origin*)
5. Clique em **Implantar** (Deploy).

**Resultado**: O primeiro visitante que solicita um trecho de video faz o download da sua VPS uma unica vez. Todos os proximos milhares de visitantes baixam os pedacos diretamente do cache da Cloudflare em milissegundos, com consumo zero de banda do seu servidor.

---

### 3. Ajustes de Rede e Velocidade no Painel Cloudflare

Acesse o menu **Speed** (Velocidade) e **Network** (Rede) no Cloudflare e garanta que as seguintes opcoes gratuitas estejam ativadas:
- **HTTP/2** e **HTTP/3 (com QUIC)**: Entrega paralela de pacotes de dados, essencial para o buffer instantaneo do player.
- **Brotli**: Compressao superior para scripts HTML/JS/CSS.
- **0-RTT Connection Resumption**: Acelera o handshake TLS em conexoes recorrentes de visitantes mobile.
- **Early Hints**: Antecipa o carregamento de scripts criticos do player.

---

### 4. Ajustes do Servidor Linux/VPS (Para Milhares de Conexoes Concorrentes)

Se estiver rodando em Linux direto ou Docker, certifique-se de que o limite de descritores de arquivos abertos suporta conexoes concorrentes macicas:

```bash
# Verificar limite atual
ulimit -n

# Aumentar temporariamente para a sessao atual
ulimit -n 65535
```

Para tornar permanente, adicione ao final de `/etc/security/limits.conf`:
```ini
* soft nofile 65535
* hard nofile 65535
```

Se utilizar **Nginx** como Proxy Reverso na frente do Node.js:
```nginx
# Permitir uploads grandes de video
client_max_body_size 2048M;

# Manter timeouts adequados para processamento de video
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;

# Desativar bufferizacao de proxy para streaming continuo
location /videos/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```
