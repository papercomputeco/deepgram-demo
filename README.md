# Composite Voice + Tapes

> **See everything your voice agent does. Change zero lines of code.**

A voice agent with full observability. [Composite Voice](https://github.com/lukeocodes/composite-voice) handles the STT/LLM/TTS pipeline, [Tapes](https://tapes.dev) captures every API call at the network layer. No SDK instrumentation, no code changes to the voice pipeline — just a reverse proxy that records everything.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Composite Voice SDK                                          │  │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────┐              │  │
│  │  │DeepgramSTT│   │ AnthropicLLM │   │DeepgramTTS│              │  │
│  │  │ (Nova-3)  │   │  (Haiku 4.5) │   │ (Aura-2)  │              │  │
│  │  └─────┬─────┘   └──────┬───────┘   └─────┬─────┘              │  │
│  │        │                │                  │                    │  │
│  │        │  proxyUrl:     │  proxyUrl:       │  proxyUrl:         │  │
│  │        │  /proxy/       │  /proxy/         │  /proxy/           │  │
│  │        │  deepgram      │  anthropic       │  deepgram          │  │
│  └────────┼────────────────┼──────────────────┼────────────────────┘  │
└───────────┼────────────────┼──────────────────┼──────────────────────┘
            │                │                  │
            ▼                ▼                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Express Server (:3010)                                               │
│                                                                       │
│  ┌─────────────────────┐  ┌──────────────────────────────────────┐   │
│  │ Composite Voice      │  │ Custom Anthropic middleware          │   │
│  │ proxy.middleware      │  │ • Injects memories into system      │   │
│  │ (Deepgram routes)    │  │   prompt                            │   │
│  │                      │  │ • Extracts tokens from SSE stream   │   │
│  │                      │  │ • Parses [MEMORY:] tags             │   │
│  │                      │  │ • Reports latency for anomalies     │   │
│  └──────────┬───────────┘  └──────────────────┬──────────────────┘   │
│             │                                  │                      │
│             │ direct                           │ via Tapes            │
└─────────────┼──────────────────────────────────┼──────────────────────┘
              │                                  │
              ▼                                  ▼
   ┌─────────────────┐              ┌────────────────────┐
   │  Deepgram API    │              │  Tapes Proxy       │
   │  • STT (WS)      │              │  (:8090)           │
   │  • TTS (WS)      │              │                    │
   └─────────────────┘              │  Records to SQLite  │
                                     │  .tapes/traces.db   │
                                     └─────────┬──────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │  Anthropic API   │
                                    │  (Claude Haiku)  │
                                    └─────────────────┘
```

### Data flow per voice turn

```
 You speak    STT         LLM              TTS        You hear
    │          │            │                │            │
    │  audio   │ transcript │   response     │   audio    │
    ├─────────►├───────────►├───────────────►├───────────►│
    │          │            │                │            │
    │  Deepgram│  Anthropic │   Deepgram     │  Browser   │
    │  Nova-3  │  Haiku 4.5 │   Aura-2       │  AudioCtx  │
    │          │            │                │            │
    │    WS    │ HTTP (SSE) │      WS        │            │
    │  direct  │ via Tapes  │   direct       │            │
              │            │
              │  ┌─────────┤
              │  │ Tapes    │
              │  │ records: │
              │  │ • tokens │
              │  │ • latency│
              │  │ • req/res│
              │  └──────────┘
```

### Telemetry isolation

```
~/.tapes/                         ./deepgram-demo/.tapes/
├── config.toml                   ├── config.toml
├── tapes.sqlite                  ├── traces.db
│                                 ├── memory.json
│   Global instance               ├── observations.json
│   • Coding agents               └── usage.json
│   • Claude Code sessions
│   • Port :8080                      Project instance
│                                     • Voice agent only
│                                     • Port :8090
│   They don't share data.           • Separate SQLite DB
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get API keys

| Provider | Where | What you need |
|----------|-------|--------------|
| Deepgram | [console.deepgram.com](https://console.deepgram.com) | API key for STT (Nova-3) and TTS (Aura-2) |
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | API key for Claude Haiku 4.5 |

No account on Deepgram yet? Try the [Deepgram Playground](https://playground.deepgram.com) first.

### 3. Configure environment

```bash
cp .env.example .env
```

Add your keys to `.env`:

```
DEEPGRAM_API_KEY=your-deepgram-key
ANTHROPIC_API_KEY=your-anthropic-key
```

If your Anthropic key is already exported in your shell (`~/.zshrc`), you can skip it in `.env`.

### 4. Start

```bash
npm start
```

Three processes start:

| Process | Port | Role |
|---------|------|------|
| Tapes proxy | `:8090` | Reverse proxy — records Anthropic calls to SQLite |
| Tapes deck | `:8888` | Dashboard API for session history |
| Express app | `:3010` | Voice proxy + frontend |

Open **http://localhost:3010** in Chrome and click the mic.

## Dashboard

The right panel has five tabs:

### Latency

Per-provider breakdown of where time goes. The critical metric is **Speech → LLM** — the silence between you finishing talking and the agent starting to respond.

```
 ┌─────────────────────────────────────────┐
 │ STT processing  ████████  120ms         │
 │ LLM generation  ██████████████  480ms   │
 │ TTS synthesis   ██████  95ms            │
 └─────────────────────────────────────────┘
```

### Cost

Real token counts parsed from the Anthropic SSE stream. Shows input/output split and per-turn cost at Haiku pricing ($0.80/MTok input, $4.00/MTok output). Cost is per-session — clearing the session resets it.

### Memory

Persistent memory the agent builds about you. Extracted two ways:
- **Heuristic** — server scans for patterns like "my name is X", "I work at Y"
- **LLM-tagged** — model outputs `[MEMORY: ...]` tags (stripped before speech)

Memories inject into the system prompt on every turn. Persist to `.tapes/memory.json`.

### Anomalies

Automatic detection from pipeline data:
- **Slow pipeline** — full round trip > 2s
- **Latency spikes** — turns above mean + 1.5 stddev
- **Token growth** — context window expanding between turns
- **Cross-session regression** — avg latency worse than last session

### Traces

Raw request log of every API call.

## Persisted state

| File | Contents |
|------|----------|
| `.tapes/traces.db` | Anthropic API calls recorded by Tapes (SQLite) |
| `.tapes/memory.json` | Agent memories about the user |
| `.tapes/observations.json` | Heuristic observations from usage patterns |
| `.tapes/usage.json` | Per-session token counts, costs, and timing |
| `.tapes/config.toml` | Tapes proxy configuration |

## Querying traces directly

```bash
# Count recorded calls
sqlite3 .tapes/traces.db "SELECT count(*) FROM nodes"

# Token usage by model
sqlite3 .tapes/traces.db \
  "SELECT model, count(*), sum(prompt_tokens), sum(completion_tokens)
   FROM nodes GROUP BY model"

# Tapes TUI dashboard
tapes deck -s .tapes/traces.db

# Tapes web dashboard
tapes deck --web -s .tapes/traces.db
```

## Stack

| Component | Role |
|-----------|------|
| [Composite Voice SDK](https://github.com/lukeocodes/composite-voice) | Voice pipeline — `DeepgramSTT` + `AnthropicLLM` + `DeepgramTTS` |
| [Tapes](https://tapes.dev) | Reverse proxy telemetry — records API calls to SQLite |
| Express | Server-side proxy adapter with memory injection |
| Vanilla HTML/JS | No build step frontend |

## How tapes integration works

Zero changes to the Composite Voice SDK. The browser SDK points at the Express proxy (`/proxy/anthropic`). The Express server has middleware that forwards those requests through the Tapes proxy instead of directly to Anthropic:

```js
// Browser — standard Composite Voice config
new AnthropicLLM({ proxyUrl: '/proxy/anthropic' })

// Server — intercepts and routes through Tapes
app.use('/proxy/anthropic', async (req, res) => {
  const targetUrl = `http://localhost:8090${req.url}`;  // Tapes proxy
  // ... forward request, extract tokens from SSE stream
});
```

The Tapes proxy transparently forwards to `api.anthropic.com` and records the request/response pair. The voice pipeline has no idea Tapes exists.

## See also

- [WALKTHROUGH.md](./WALKTHROUGH.md) — detailed step-by-step guide with troubleshooting
