# Walkthrough: Deepgram Voice Agent + Tapes Telemetry

A step-by-step guide to setting up a voice agent with full observability. By the end you'll have a working voice pipeline (STT + LLM + TTS) where every API call is traced automatically through Tapes — no instrumentation code required.

**Video walkthrough:** [TODO: add link to recorded demo]

## What you're building

A browser-based voice agent that chains three providers per turn:

```
You speak → Deepgram STT → Anthropic LLM → Deepgram TTS → You hear
```

Tapes sits as a reverse proxy in front of the Anthropic API. Every LLM call flows through it and gets recorded to a local SQLite database. The dashboard shows latency per provider, token usage, cost, and anomaly detection — all from data Tapes captures at the network layer.

## Prerequisites

- **Node.js 18+** — `node --version`
- **Tapes CLI** — install from [tapes.dev](https://tapes.dev) or `brew install tapes`
- **Deepgram API key** — free at [console.deepgram.com](https://console.deepgram.com) or use the [Deepgram Playground](https://playground.deepgram.com)
- **Anthropic API key** — from [console.anthropic.com](https://console.anthropic.com)

Verify tapes is installed:

```bash
tapes --help
```

## 1. Clone and install

```bash
git clone <this-repo>
cd deepgram-demo
npm install
```

## 2. Set your API keys

```bash
cp .env.example .env
```

Edit `.env`:

```
DEEPGRAM_API_KEY=your-deepgram-key
ANTHROPIC_API_KEY=your-anthropic-key
```

If your Anthropic key is already in your shell environment (e.g. `.zshrc`), you can leave it out of `.env` — the server picks up both.

## 3. Understand the tapes setup

The project has a local `.tapes/` directory with its own config. This keeps voice agent traces **separate** from your main tapes instance (the one at `~/.tapes/` that traces your coding agents).

```
~/.tapes/              ← global tapes (coding agents, :8080)
./deepgram-demo/.tapes/ ← this project's tapes (voice agent, :8090)
```

The config at `.tapes/config.toml`:

```toml
[storage]
  sqlite_path = ".tapes/traces.db"    # local SQLite, not shared

[proxy]
  provider = "anthropic"               # proxy understands Anthropic's API format
  upstream = "https://api.anthropic.com"
  listen = ":8090"                     # different port from global tapes
```

You don't need to touch this. `tapes init --preset anthropic` created it.

## 4. Start everything

```bash
npm start
```

This runs three processes via `concurrently`:

| Process | Port | What it does |
|---------|------|-------------|
| `tapes serve proxy` | `:8090` | Reverse proxy for Anthropic API calls, records to SQLite |
| `tapes deck --web` | `:8888` | Tapes dashboard API for session history |
| `node server.js` | `:3010` | Express app — voice proxy + frontend |

Open **http://localhost:3010** in Chrome (needs mic access).

## 5. Talk to it

Click the mic button. Speak. The pipeline:

1. Your voice → browser mic → WebSocket → Express proxy → **Deepgram STT** → transcript
2. Transcript → Express proxy → **Tapes proxy (:8090)** → **Anthropic API** → streamed response
3. Response text → Express proxy → **Deepgram TTS** → browser audio output

Every Anthropic call passes through Tapes transparently. The Express server intercepts the `/proxy/anthropic` route and forwards through `localhost:8090` instead of hitting `api.anthropic.com` directly. Deepgram calls go direct (WebSocket STT/TTS).

## 6. What the dashboard shows

The right panel has five tabs:

### Latency
Per-provider latency bars showing where time is spent. The key metric is **Speech → LLM** — the gap between you finishing talking and the LLM starting to respond. This is what the user perceives as "thinking time."

### Cost
Real token counts extracted from Anthropic's streaming response (`message_start` has input tokens, `message_delta` has output tokens). Cost calculated at Haiku rates ($0.80/MTok input, $4.00/MTok output). Per-turn breakdown shows exactly what each exchange cost.

### Memory
The agent stores memories about you (name, preferences) and injects them into the system prompt on every turn. Memories persist to `.tapes/memory.json` and survive restarts. You can:
- Tell the agent facts ("my name is Brian", "I work at home")
- Say "save this to memory" to explicitly store your previous utterance
- Delete individual memories with the × button

### Anomalies
Flags performance issues automatically:
- **Slow pipeline** — full round trip > 2s from end of speech
- **Latency spikes** — individual turns significantly above average
- **Token growth** — input tokens jumping between turns (context explosion)
- **Cross-session regression** — avg latency worse than previous session

### Traces
Raw request log of every API call with provider, latency, status, and timestamps.

## 7. Inspect the tapes data directly

The SQLite database at `.tapes/traces.db` has the raw conversation data:

```bash
# See what's recorded
sqlite3 .tapes/traces.db "SELECT role, model, prompt_tokens, completion_tokens FROM nodes ORDER BY created_at DESC LIMIT 5"

# Check token usage across all sessions
sqlite3 .tapes/traces.db "SELECT model, count(*), sum(prompt_tokens), sum(completion_tokens) FROM nodes GROUP BY model"
```

Use the tapes deck for a richer view:

```bash
# TUI dashboard
tapes deck -s .tapes/traces.db

# Web dashboard
tapes deck --web -s .tapes/traces.db
```

## 8. How the proxy routing works

The key architectural decision: the Express server creates a standard Composite Voice proxy for Deepgram (handles WebSocket auth), but **intercepts Anthropic calls** with custom middleware that routes through Tapes:

```
Browser SDK                    Express Server                Tapes Proxy          Anthropic
    │                              │                            │                    │
    ├─ WS /proxy/deepgram ────────►├─ proxy.middleware ─────────────────────────────►│ Deepgram
    │                              │   (direct, no tapes)                            │
    ├─ POST /proxy/anthropic ─────►├─ custom middleware ───────►├─ records trace ───►│ Anthropic
    │                              │   (injects API key,        │   (SQLite)         │
    │                              │    parses SSE for tokens,  │                    │
    │                              │    extracts memories)      │                    │
```

This means zero changes to the Composite Voice SDK config. The browser just points at `/proxy/anthropic` like normal — the server decides what goes through Tapes.

## 9. Persisted state

Everything important survives restarts:

| File | What's in it |
|------|-------------|
| `.tapes/traces.db` | All Anthropic API calls recorded by Tapes (SQLite) |
| `.tapes/memory.json` | Agent memories about the user |
| `.tapes/observations.json` | Heuristic observations from usage patterns |
| `.tapes/usage.json` | Per-session token counts and costs |

## 10. Separate from your coding tapes

This project uses a local `.tapes/` directory so voice traces don't mix with your main coding agent telemetry. Your global tapes at `~/.tapes/` stays clean.

To verify they're independent:

```bash
# Global tapes (coding agents)
sqlite3 ~/.tapes/tapes.sqlite "SELECT count(*) FROM nodes"

# This project's tapes (voice agent)
sqlite3 .tapes/traces.db "SELECT count(*) FROM nodes"
```

Different databases, different ports, different concerns.

## Troubleshooting

**"Error: Failed to connect to provider: DeepgramSTT"**
- Check your `DEEPGRAM_API_KEY` is set and valid
- Make sure you're using Chrome (needs WebSocket + mic access)
- Don't double-click the mic button — wait for "Listening..."

**All API endpoints return 404**
- The server needs to be restarted after code changes — `npm start` again
- Check the terminal output for startup errors

**No traces appearing**
- Verify tapes proxy is running: `curl http://localhost:8090` should return something
- Check `.tapes/traces.db` exists and has data: `sqlite3 .tapes/traces.db "SELECT count(*) FROM nodes"`

**Memories not saving**
- Check `.tapes/memory.json` exists and is writable
- Try explicit: say "my name is [your name]" — the heuristic catches that pattern

**Cost showing $0.0000**
- Token extraction requires the Anthropic response to stream SSE events (`message_start`, `message_delta`)
- If using a past session from the dropdown, switch back to "Current session" to see live data
