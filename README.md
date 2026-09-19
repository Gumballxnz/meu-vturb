# CloudVTurb ⚡

Plataforma SaaS premium de hospedagem e streaming de VSLs de alta conversão, otimizada para servidores dedicados, VPS e integração com Cloudflare R2 (Zero Egress).

---

## 🚀 Funcionalidades

- **Dashboard SaaS Premium (Dark Theme #09090b):**
  - Identidade visual moderna com superfícies elevadas, bordas discretas e destaque em violeta elétrico.
  - Sidebar fixa no desktop e menu responsivo em dispositivos móveis.
  - Visão geral com métricas reais agregadas: visualizações de página, plays únicos, conclusão média, cliques em CTA e monitoramento da cota de 30 GB.
  - Gestão de VSLs com busca instantânea, filtro por origem (Hospedado vs R2/Remoto) e ordenação dinâmica.
  - Editor visual completo dividido em abas (*Player*, *CTA*, *Rastreamento* e *Embed*) com Live Preview responsivo (Desktop / Mobile).
  - Gerador de código embed responsivo para WordPress, Elementor e Webflow com 1 clique.

- **Analytics Real de Retenção:**
  - Tabela SQLite dedicada de eventos analíticos (`analytics_events`) com indexação de alta velocidade.
  - Registro de visualizações, visitantes únicos anônimos (via `localStorage`), plays, pausas, marcos de progresso (10%, 25%, 50%, 75%, 90%, 100%), alcance de pitch e cliques no CTA.
  - Curva de retenção interativa e funil de conversão sem métricas fictícias.
  - Filtro por período (24 horas, 7 dias, 30 dias e todo o histórico).

- **Player Ultra-Rápido & Focado em Conversão:**
  - Carregamento leve sem dependências pesadas.
  - Smart Autoplay com tarja pulsante dinâmica e ativação de áudio.
  - Pitch Delay com botão CTA animado surgindo no segundo exato da oferta.
  - Barra de retenção com aceleração inteligente no início e bloqueio de avanço.
  - Retomada do vídeo de onde o lead parou via `localStorage`.
  - Disparo de eventos analíticos nativos e pixels (Facebook Pixel / PostMessage).
  - Barreira de interface para proteção básica contra cópia direta (bloqueio de atalhos e menu de contexto).

- **Backend & Segurança:**
  - Node.js + Express + SQLite em modo WAL.
  - Autenticação JWT com aprovação prévia de novos cadastros pelo Administrador (Owner).
  - `JWT_SECRET` obrigatório via variável de ambiente em produção.
  - Controle de origens CORS configurável via `ALLOWED_ORIGINS`.
  - Domínios customizáveis (`BASE_DOMAIN`, `PLAYER_DOMAIN`, `DASH_DOMAIN`).
  - Validação estrita de uploads para formatos MP4 e WebM com verificação antecipada de cota de armazenamento.
  - Streaming eficiente com suporte a HTTP Range (206 Partial Content) e FastStart via FFmpeg.

---

## ⚙️ Variáveis de Ambiente

Consulte o arquivo `.env.example` na pasta `server` para configurar seu ambiente:

```env
PORT=4000
NODE_ENV=production
JWT_SECRET=substitua_por_uma_chave_secreta_longa_e_aleatoria
ALLOWED_ORIGINS=https://dash.seudominio.com,https://player.seudominio.com,https://seudominio.com
BASE_DOMAIN=seudominio.com
PLAYER_DOMAIN=player.seudominio.com
DASH_DOMAIN=dash.seudominio.com
APP_NAME=CloudVTurb
DATA_DIR=/app/data
VIDEOS_DIR=/app/videos
PUBLIC_DIR=/app/public
```

---

## 🛠️ Como Rodar com Docker

Para iniciar a aplicação em produção com Docker Compose:

```bash
cd server
docker compose up -d --build
```

Acesse o painel em `http://localhost:4000` (ou no domínio configurado).
