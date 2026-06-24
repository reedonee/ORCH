FROM python:3.11-slim AS base
WORKDIR /app

# ── Layer 1: System dependencies ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Node.js 20 LTS (for Claude Code, Codex, OpenCode) ─
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# ── Layer 3: Python dependencies (FastAPI, agent-core) ────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Layer 4: Pre-installed agent CLIs ─────────────────────────
# These are baked into the image so tmux sessions start instantly.

# Claude Code — Anthropic's coding agent (npm global)
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || \
    echo "[warn] claude-code npm install skipped"

# Codex CLI — OpenAI's coding agent (npm global)
RUN npm install -g @openai/codex 2>/dev/null || \
    npm install -g codex-cli 2>/dev/null || \
    echo "[warn] codex-cli npm install skipped"

# Hermes Agent — Nous Research CLI (pip)
RUN pip install --no-cache-dir hermes-agent 2>/dev/null || \
    echo "[warn] hermes-agent pip install skipped"

# OpenCode — AI coding agent (npm global)
RUN npm install -g opencode-ai 2>/dev/null || \
    echo "[warn] opencode-ai npm install skipped"

# Cursor CLI — AI coding agent (curl install)
RUN curl -fsSL https://cursor.com/install | bash -s -- 2>/dev/null && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent || \
    echo "[warn] cursor CLI install skipped"

# Verify installed tools
RUN echo "=== Pre-installed tools ===" \
    && ( command -v claude && echo "  claude: $(claude --version 2>/dev/null)" || echo "  claude: not found" ) \
    && ( command -v codex && echo "  codex: $(codex --version 2>/dev/null)" || echo "  codex: not found" ) \
    && ( command -v hermes && echo "  hermes: $(hermes --version 2>/dev/null)" || echo "  hermes: not found" ) \
    && ( command -v opencode && echo "  opencode: installed" || echo "  opencode: not found" ) \
    && ( command -v agent && echo "  cursor-agent: $(agent --version 2>/dev/null || true)" || echo "  cursor-agent: not found" )

# ── Layer 5: Pre-download TTS model ───────────────────────────
COPY download_tts_model.py .
RUN python3 download_tts_model.py && rm download_tts_model.py

# ── Layer 6: Application code ─────────────────────────────────
COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
