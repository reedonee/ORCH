# ORCH VPS Server — Hybrid Edge-Cloud Backend

Deploys the ORCH cloud engine on an Ubuntu VPS (Oracle free tier Ampere A1).

## Stack

| Service | Role |
|---------|------|
| **Caddy** | Auto SSL reverse proxy (Let's Encrypt) |
| **agent-core** | FastAPI: STT (Whisper), TTS (Kokoro), LLM (Ollama), vector memory (Qdrant) |
| **Qdrant** | Vector database for persistent memory / RAG |
| **Ollama** | Local LLM server (qwen2.5-coder:7b) |

## Quick Start

```bash
# 1. SCP the server/ directory to your VPS
scp -r server/* user@your-vps:~/orch-server/

# 2. SSH in and run
ssh user@your-vps
cd ~/orch-server
chmod +x deploy.sh
./deploy.sh

# 3. Edit config
nano .env           # set your domain
nano Caddyfile      # set your domain

# 4. Restart Caddy with your domain
docker compose restart caddy
```

## Oracle Cloud — Extra Firewall Step

In your Oracle Cloud Console → Networking → Virtual Cloud Network → Security List, add two Ingress rules:

- **Port 80** — Source: 0.0.0.0/0, Protocol: TCP
- **Port 443** — Source: 0.0.0.0/0, Protocol: TCP

## Files

```
server/
├── docker-compose.yml      # Full stack definition
├── Caddyfile               # Reverse proxy with auto SSL
├── deploy.sh               # One-command bootstrap
├── .env                    # Your config (domain, model, etc.)
└── agent-core/
    ├── Dockerfile
    ├── requirements.txt
    ├── main.py             # FastAPI server entry point
    ├── voice.py            # STT (Whisper) + TTS (Kokoro)
    ├── llm.py              # Ollama LLM client
    └── memory.py           # Qdrant vector memory
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| POST | `/api/chat` | LLM chat completion |
| POST | `/api/tts` | Text-to-speech (returns PCM) |
| POST | `/api/memory` | Store a memory |
| GET | `/api/memory?q=...` | Search memories |
| WS | `/ws/voice` | Bi-directional voice streaming |

## Client Env Files

In the Electron project root:

- `.env.development` — localhost, no VPS needed
- `.env.production` — points to your VPS domain
