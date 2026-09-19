# CloudVTurb ⚡

Sistema completo de Player de VSL proprietário ("Clone do VTurb"), otimizado nativamente para **Cloudflare R2 (Zero Egress)** e servidores dedicados/VPS com streaming de alta performance (**HTTP 206 Partial Content**).

---

## 🚀 Funcionalidades

- **Dashboard Estilo VTurb (`index.html`):**
  - Gestão de VSLs com métricas de plays, retenção e conversão.
  - Editor visual retrátil com cores customizáveis, formato 16:9 ou 9:16 (Stories/Reels).
  - Smart Autoplay com overlay pulsante dinâmico ("Toque para ativar o som").
  - Pitch Delay com botão CTA animado surgindo no segundo programado.
  - Barra de retenção inteligente (aceleração no início e bloqueio de avanço).
  - Retomada de onde o lead parou via `localStorage`.
  - Disparo de pixels por percentual assistido (25%, 50%, 75%, 90% e Pitch).
  - Gerador de embed responsivo com 1 clique para WordPress, Elementor e Webflow.

- **Player Ultra-Rápido (`player.html`):**
  - Carregamento em menos de 100ms sem dependências pesadas.
  - Proteção anti-cópia (bloqueio de clique direito, atalhos de salvar e devtools).
  - Suporte nativo a `.mp4` e streaming `.m3u8` (HLS sob demanda).

- **Backend & Armazenamento Local (Node.js + SQLite WAL):**
  - Consumo mínimo de memória (< 15MB RAM).
  - Suporte a upload local com cota de armazenamento e streaming instantâneo.
  - Sistema de moderação com aprovação manual de novos usuários pelo Owner.

---

## 🛠️ Como Rodar com Docker

```bash
cd server
docker compose up -d --build
```
Acesse em `http://localhost:4000`.
