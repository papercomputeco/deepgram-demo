import express from 'express';
import { createServer } from 'http';
import { createExpressProxy } from '@lukeocodes/composite-voice/proxy';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TAPES_PROXY = process.env.TAPES_PROXY_URL || 'http://localhost:8090';
const TAPES_DECK = process.env.TAPES_DECK_URL || 'http://localhost:8888';
const PORT = process.env.PORT || 3010;
const DB_PATH = join(__dirname, '.tapes/traces.db');
const MEMORY_PATH = join(__dirname, '.tapes/memory.json');
const OBS_PATH = join(__dirname, '.tapes/observations.json');
const USAGE_PATH = join(__dirname, '.tapes/usage.json');

// ── Persistent memory store ──
let memories = [];

function loadMemories() {
  try { memories = JSON.parse(readFileSync(MEMORY_PATH, 'utf-8')); } catch { memories = []; }
}

function saveMemories() {
  mkdirSync(join(__dirname, '.tapes'), { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(memories, null, 2));
}

function addMemory(content) {
  // Deduplicate — skip if we already have a similar memory
  const normalized = content.toLowerCase().trim();
  if (memories.some(m => m.content.toLowerCase().trim() === normalized)) return null;
  // Also skip if a more specific version already exists (e.g. "User's name is Brian" covers "User's name is there")
  if (normalized.length < 10) return null;

  const entry = { content, timestamp: new Date().toISOString() };
  memories.push(entry);
  saveMemories();
  observations.push({ timestamp: entry.timestamp, priority: 'important', content: `Memory stored: ${content}` });
  saveObservations();
  console.log(`  Memory saved: ${content}`);
  return entry;
}

loadMemories();

// Heuristic memory extraction from user speech + LLM response
function extractMemoriesFromText(userText, assistantText) {
  const u = userText.toLowerCase();
  const patterns = [
    // "my name is X" / "I'm X" / "call me X"
    { re: /my name is (\w+)/i, fmt: (m) => `User's name is ${m[1]}` },
    { re: /(?:i'm|i am) (\w+)/i, fmt: (m) => `User's name is ${m[1]}`, guard: (m) => m[1].length > 2 && !['just', 'here', 'fine', 'good', 'okay', 'back', 'done', 'sure', 'not', 'very', 'also', 'really', 'trying', 'going', 'looking', 'wondering', 'thinking', 'using', 'working', 'building', 'testing'].includes(m[1].toLowerCase()) },
    { re: /call me (\w+)/i, fmt: (m) => `User prefers to be called ${m[1]}` },
    // "I work at X" / "I'm a X"
    { re: /i work (?:at|for) (.+?)(?:\.|$)/i, fmt: (m) => `User works at ${m[1].trim()}` },
    { re: /i(?:'m| am) an? ([\w\s]+?)(?:\.|,|$)/i, fmt: (m) => {
      const role = m[1].trim();
      if (role.length > 3 && role.length < 40 && !['bit', 'little', 'lot'].includes(role)) return `User is a ${role}`;
      return null;
    }},
    // "I live in X"
    { re: /i live in (.+?)(?:\.|,|$)/i, fmt: (m) => `User lives in ${m[1].trim()}` },
    // "remember that X" / "remember I X"
    { re: /remember (?:that |)(i .+?)(?:\.|$)/i, fmt: (m) => m[1].trim() },
    { re: /remember (?:that |)my (.+?)(?:\.|$)/i, fmt: (m) => `User's ${m[1].trim()}` },
    // "I like X" / "I prefer X"
    { re: /i (?:like|love|prefer) (.+?)(?:\.|,|$)/i, fmt: (m) => `User likes ${m[1].trim()}` },
  ];

  for (const { re, fmt, guard } of patterns) {
    const match = userText.match(re);
    if (match) {
      if (guard && !guard(match)) continue;
      const content = fmt(match);
      if (!content) continue;
      // Don't duplicate existing memories
      if (memories.some(m => m.content.toLowerCase() === content.toLowerCase())) continue;
      addMemory(content);
    }
  }

  // Also check if the assistant confirmed a name — "Nice to meet you, X"
  const nameConfirm = assistantText.match(/(?:nice to meet you|hi|hello|hey),?\s+(\w+)/i);
  if (nameConfirm && nameConfirm[1].length > 2) {
    const name = nameConfirm[1];
    const content = `User's name is ${name}`;
    if (!memories.some(m => m.content.toLowerCase() === content.toLowerCase())) {
      addMemory(content);
    }
  }
}

// ── Usage stats (per-session + historical) ──
let allUsage = { sessions: [], currentSessionId: null };
try { allUsage = JSON.parse(readFileSync(USAGE_PATH, 'utf-8')); } catch {}

// Start a new session on boot
const currentSession = { id: Date.now().toString(), startedAt: new Date().toISOString(), turns: [] };
allUsage.sessions.push(currentSession);
allUsage.currentSessionId = currentSession.id;

function getCurrentSession() {
  return allUsage.sessions.find(s => s.id === allUsage.currentSessionId) || currentSession;
}

function saveUsage() { writeFileSync(USAGE_PATH, JSON.stringify(allUsage, null, 2)); }

// Compat: compute totals from current session turns
const usage = {
  get turns() { return getCurrentSession().turns; },
  get totals() {
    const turns = getCurrentSession().turns;
    return {
      inputTokens: turns.reduce((s, t) => s + (t.inputTokens || 0), 0),
      outputTokens: turns.reduce((s, t) => s + (t.outputTokens || 0), 0),
      cacheReadTokens: turns.reduce((s, t) => s + (t.cacheReadTokens || 0), 0),
      cacheCreationTokens: turns.reduce((s, t) => s + (t.cacheCreationTokens || 0), 0),
    };
  },
};

// Haiku pricing (per million tokens)
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreation: 1.00 },
  'claude-sonnet-4-6-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
};
const DEFAULT_PRICING = PRICING['claude-haiku-4-5-20251001'];

function computeCost(turn) {
  const p = PRICING[turn.model] || DEFAULT_PRICING;
  return {
    input: (turn.inputTokens / 1_000_000) * p.input,
    output: (turn.outputTokens / 1_000_000) * p.output,
    cacheRead: ((turn.cacheReadTokens || 0) / 1_000_000) * p.cacheRead,
    cacheCreation: ((turn.cacheCreationTokens || 0) / 1_000_000) * p.cacheCreation,
  };
}

const app = express();
const server = createServer(app);

const proxy = createExpressProxy({
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  pathPrefix: '/proxy',
});

// Intercept Anthropic calls, route through Tapes, extract token usage from SSE stream
app.use('/proxy/anthropic', async (req, res) => {
  const apiPath = req.url || '/';
  const targetUrl = `${TAPES_PROXY}${apiPath}`;
  const startTime = Date.now();

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'origin', 'referer'].includes(key.toLowerCase())) continue;
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  headers['anthropic-version'] = '2023-06-01';

  // Parse request body — inject memories into system prompt
  let reqBody;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    reqBody = Buffer.concat(chunks);
  } catch (err) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  let model = 'claude-haiku-4-5-20251001';
  try {
    const parsed = JSON.parse(reqBody.toString());
    model = parsed.model || model;

    // Inject memories into the system prompt
    const memoryBlock = memories.length > 0
      ? `\n\nYou have the following memories about the user:\n${memories.map(m => `- ${m.content}`).join('\n')}\nUse these naturally when relevant. Do not list them unprompted.`
      : '';

    const memoryInstruction = `\n\nIMPORTANT: When the user shares personal info, silently append a [MEMORY: ...] tag at the very end of your response. The tag is stripped before speech — the user will NEVER hear it. Do NOT mention the tag, say "I'll remember that", or acknowledge the memory process. Just respond naturally and append the tag silently. Example response: "Nice to meet you! [MEMORY: User's name is Brian]" — the user only hears "Nice to meet you!"`;

    if (typeof parsed.system === 'string') {
      parsed.system += memoryBlock + memoryInstruction;
    } else if (Array.isArray(parsed.system)) {
      parsed.system.push({ type: 'text', text: memoryBlock + memoryInstruction });
    }

    reqBody = Buffer.from(JSON.stringify(parsed));
    // Update content-length since body changed
    headers['content-length'] = String(reqBody.length);
  } catch {}

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : reqBody,
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (!upstream.body) { res.end(); return; }

    // Stream through to client while extracting usage + memory tags from SSE events
    const turn = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model, timestamp: new Date().toISOString() };
    let sseBuffer = '';
    let responseText = ''; // accumulate full response to scan for [MEMORY: ...]

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Forward raw bytes to client immediately
      res.write(value);

      // Parse SSE events to extract usage
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // message_start has initial usage (input_tokens)
          if (event.type === 'message_start' && event.message?.usage) {
            turn.inputTokens = event.message.usage.input_tokens || 0;
            turn.cacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
            turn.cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0;
          }

          // message_delta has final output usage
          if (event.type === 'message_delta' && event.usage) {
            turn.outputTokens = event.usage.output_tokens || 0;
          }

          // Accumulate text chunks for memory extraction
          if (event.type === 'content_block_delta' && event.delta?.text) {
            responseText += event.delta.text;
          }
        } catch {}
      }
    }

    // Extract [MEMORY: ...] tags from the LLM response (if the model outputs them)
    const memoryPattern = /\[MEMORY:\s*(.+?)\]/gi;
    let match;
    while ((match = memoryPattern.exec(responseText)) !== null) {
      addMemory(match[1].trim());
    }

    // Heuristic memory extraction from the user's message (doesn't rely on LLM tagging)
    try {
      const parsed = JSON.parse(reqBody.toString());
      const userMsgs = (parsed.messages || []).filter(m => m.role === 'user');
      const lastUser = userMsgs.at(-1);
      if (lastUser) {
        const text = typeof lastUser.content === 'string'
          ? lastUser.content
          : (lastUser.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
        extractMemoriesFromText(text, responseText);
      }
    } catch {}

    turn.durationMs = Date.now() - startTime;

    // Record this turn in current session
    getCurrentSession().turns.push(turn);
    saveUsage();

    observe(turn);
    console.log(`  LLM turn: ${turn.inputTokens} in / ${turn.outputTokens} out (${turn.durationMs}ms)`);

    res.end();
  } catch (err) {
    console.error('Tapes proxy error:', err.message);
    res.status(502).json({ error: 'tapes_proxy_error', message: err.message });
  }
});

// Usage stats API — frontend polls this
app.get('/api/usage', (req, res) => {
  const turns = usage.turns.map(t => ({
    ...t,
    cost: computeCost(t),
  }));

  const totalCost = turns.reduce((sum, t) => {
    const c = t.cost;
    return sum + c.input + c.output + c.cacheRead + c.cacheCreation;
  }, 0);

  res.json({
    turns,
    totals: {
      ...usage.totals,
      totalTokens: usage.totals.inputTokens + usage.totals.outputTokens,
      totalCost,
      turnCount: usage.turns.length,
    },
  });
});

// ── Observational Memory (heuristic pattern extraction from usage data) ──
let observations = [];
try { observations = JSON.parse(readFileSync(OBS_PATH, 'utf-8')); } catch {}
function saveObservations() { writeFileSync(OBS_PATH, JSON.stringify(observations, null, 2)); }

function observe(turn) {
  const now = new Date().toISOString();

  // 1. Session goal context
  if (usage.turns.length === 1) {
    observations.push({ timestamp: now, priority: 'informational', content: 'Voice session started — first LLM turn recorded.' });
  }

  // 2. High token usage
  if (turn.inputTokens > 2000) {
    observations.push({ timestamp: now, priority: 'important', content: `High input token count: ${turn.inputTokens} tokens. Conversation context may be growing large.` });
  }

  // 3. Cache utilization
  if (turn.cacheReadTokens > 0) {
    const cacheRatio = turn.cacheReadTokens / (turn.inputTokens || 1);
    observations.push({ timestamp: now, priority: 'informational', content: `Cache read: ${turn.cacheReadTokens} tokens (${(cacheRatio * 100).toFixed(0)}% of input). Prompt caching is active.` });
  }

  // 4. Slow LLM response
  if (turn.durationMs > 3000) {
    observations.push({ timestamp: now, priority: 'important', content: `Slow LLM response: ${turn.durationMs}ms. User-perceived latency is high.` });
  }

  // 5. Token growth trend (after 3+ turns)
  if (usage.turns.length >= 3) {
    const recent = usage.turns.slice(-3);
    const inputGrowth = recent[2].inputTokens - recent[0].inputTokens;
    if (inputGrowth > 500) {
      observations.push({ timestamp: now, priority: 'possible', content: `Input tokens growing: +${inputGrowth} over last 3 turns. Conversation history is accumulating.` });
    }
  }

  // 6. Cost milestone
  const totalCost = usage.turns.reduce((sum, t) => {
    const c = computeCost(t);
    return sum + c.input + c.output + c.cacheRead + c.cacheCreation;
  }, 0);
  if (totalCost > 0.01 && usage.turns.length === usage.turns.findIndex(t => {
    // find the turn that crossed $0.01
    let running = 0;
    for (const prev of usage.turns) {
      const pc = computeCost(prev);
      running += pc.input + pc.output + pc.cacheRead + pc.cacheCreation;
      if (running > 0.01) return prev === t;
    }
    return false;
  }) + 1) {
    observations.push({ timestamp: now, priority: 'informational', content: `Cost milestone: session has exceeded $0.01 (now $${totalCost.toFixed(4)}).` });
  }
  saveObservations();
}

app.get('/api/observations', (req, res) => {
  res.json(observations);
});

// ── Memory API ──
app.get('/api/memories', (req, res) => {
  res.json(memories);
});

app.post('/api/memories', express.json(), (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const entry = addMemory(content);
  res.json(entry);
});

app.delete('/api/memories/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (idx >= 0 && idx < memories.length) {
    const removed = memories.splice(idx, 1);
    saveMemories();
    res.json({ removed: removed[0] });
  } else {
    res.status(404).json({ error: 'not found' });
  }
});

// ── Session management ──
app.post('/api/session/clear', express.json(), (req, res) => {
  // Start a fresh session — old session stays in history
  const newSession = { id: Date.now().toString(), startedAt: new Date().toISOString(), turns: [] };
  allUsage.sessions.push(newSession);
  allUsage.currentSessionId = newSession.id;
  observations.length = 0;
  saveUsage();
  saveObservations();
  console.log('  New session started');
  res.json({ ok: true, sessionId: newSession.id });
});

// List all local usage sessions
app.get('/api/sessions', (req, res) => {
  const sessions = allUsage.sessions.map(s => {
    const totals = s.turns.reduce((acc, t) => {
      acc.inputTokens += t.inputTokens || 0;
      acc.outputTokens += t.outputTokens || 0;
      return acc;
    }, { inputTokens: 0, outputTokens: 0 });
    const totalCost = s.turns.reduce((sum, t) => {
      const c = computeCost(t);
      return sum + c.input + c.output + c.cacheRead + c.cacheCreation;
    }, 0);
    return {
      id: s.id,
      startedAt: s.startedAt,
      turnCount: s.turns.length,
      totalTokens: totals.inputTokens + totals.outputTokens,
      totalCost,
      current: s.id === allUsage.currentSessionId,
    };
  }).reverse();
  res.json(sessions);
});

// ── Anomaly Detection (analyzes ALL sessions, not just current) ──
function detectAnomalies() {
  const anomalies = [];

  // Gather all turns across all sessions
  const allTurns = allUsage.sessions.flatMap(s =>
    s.turns.map(t => ({ ...t, sessionId: s.id, sessionStart: s.startedAt }))
  );
  const currentTurns = getCurrentSession().turns;

  // --- Cross-session: compare session averages ---
  const sessionStats = allUsage.sessions.filter(s => s.turns.length > 0).map(s => {
    const durations = s.turns.map(t => t.durationMs).filter(d => d > 0);
    const avgLatency = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const totalTokens = s.turns.reduce((sum, t) => (t.inputTokens || 0) + (t.outputTokens || 0) + sum, 0);
    const totalCost = s.turns.reduce((sum, t) => {
      const c = computeCost(t);
      return sum + c.input + c.output + c.cacheRead + c.cacheCreation;
    }, 0);
    return { id: s.id, startedAt: s.startedAt, avgLatency, totalTokens, totalCost, turnCount: s.turns.length };
  });

  // Cross-session latency regression
  if (sessionStats.length >= 2) {
    const prev = sessionStats[sessionStats.length - 2];
    const curr = sessionStats[sessionStats.length - 1];
    if (curr.avgLatency > 0 && prev.avgLatency > 0 && curr.avgLatency > prev.avgLatency * 1.5) {
      anomalies.push({
        type: 'session_latency_regression',
        severity: 'warning',
        timestamp: curr.startedAt,
        message: `Avg latency increased ${Math.round(prev.avgLatency)}ms -> ${Math.round(curr.avgLatency)}ms between sessions (${((curr.avgLatency / prev.avgLatency - 1) * 100).toFixed(0)}% slower)`,
      });
    }

    // Cross-session cost spike
    if (curr.totalCost > 0 && prev.totalCost > 0 && curr.totalCost > prev.totalCost * 2) {
      anomalies.push({
        type: 'session_cost_spike',
        severity: 'warning',
        timestamp: curr.startedAt,
        message: `Session cost jumped $${prev.totalCost.toFixed(4)} -> $${curr.totalCost.toFixed(4)} (${((curr.totalCost / prev.totalCost - 1) * 100).toFixed(0)}% increase)`,
      });
    }
  }

  // --- Within current session ---
  if (currentTurns.length >= 2) {
    const durations = currentTurns.map(t => t.durationMs).filter(d => d > 0);

    // Latency spikes (lower threshold: mean + 1.5 stddev, min 500ms)
    if (durations.length >= 2) {
      const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
      const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
      const stddev = Math.sqrt(variance);
      const threshold = mean + 1.5 * stddev;

      currentTurns.forEach((t, i) => {
        if (t.durationMs > threshold && t.durationMs > 500) {
          anomalies.push({
            type: 'latency_spike',
            severity: t.durationMs > mean + 2.5 * stddev ? 'critical' : 'warning',
            turn: i + 1,
            timestamp: t.timestamp,
            message: `Turn ${i + 1}: ${t.durationMs}ms (avg ${Math.round(mean)}ms, threshold ${Math.round(threshold)}ms)`,
          });
        }
      });
    }

    // Token growth (context accumulation)
    for (let i = 1; i < currentTurns.length; i++) {
      const prev = currentTurns[i - 1].inputTokens;
      const curr = currentTurns[i].inputTokens;
      if (prev > 0 && curr > prev * 1.5 && curr > 300) {
        anomalies.push({
          type: 'token_growth',
          severity: curr > prev * 2.5 ? 'critical' : 'warning',
          turn: i + 1,
          timestamp: currentTurns[i].timestamp,
          message: `Turn ${i + 1}: input tokens ${prev} -> ${curr} (+${((curr / prev - 1) * 100).toFixed(0)}%). Context window growing.`,
        });
      }
    }

    // Latency trend: 2+ consecutive increases
    if (durations.length >= 3) {
      let streak = 0;
      for (let i = 1; i < durations.length; i++) {
        streak = durations[i] > durations[i - 1] ? streak + 1 : 0;
        if (streak >= 2) {
          anomalies.push({
            type: 'latency_trend',
            severity: 'warning',
            turn: i + 1,
            timestamp: currentTurns[i].timestamp,
            message: `Latency rising for ${streak + 1} turns: ${durations.slice(i - streak, i + 1).map(d => d + 'ms').join(' -> ')}`,
          });
          break;
        }
      }
    }
  }

  // --- Absolute thresholds on server-side LLM duration ---
  for (const t of currentTurns) {
    if (t.durationMs > 3000) {
      anomalies.push({
        type: 'slow_llm',
        severity: t.durationMs > 5000 ? 'critical' : 'warning',
        timestamp: t.timestamp,
        message: `LLM HTTP call took ${t.durationMs}ms — user-noticeable delay.`,
      });
    }
  }

  // --- Client-reported full pipeline latency (speech-end → done) ---
  for (const cl of clientLatencies) {
    if (cl.totalMs > 2000) {
      anomalies.push({
        type: 'slow_pipeline',
        severity: cl.totalMs > 4000 ? 'critical' : 'warning',
        timestamp: cl.timestamp,
        message: `Full pipeline: ${cl.totalMs}ms from end of speech (STT ${cl.sttMs || '?'}ms + LLM ${cl.llmMs || '?'}ms + TTS ${cl.ttsMs || '?'}ms)`,
      });
    }
  }

  return anomalies;
}

// Client reports full pipeline latency (speech-end → response-complete)
const clientLatencies = [];

app.post('/api/latency', express.json(), (req, res) => {
  const { sttMs, llmMs, ttsMs, totalMs, timestamp } = req.body;
  clientLatencies.push({ sttMs, llmMs, ttsMs, totalMs, timestamp: timestamp || new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/api/anomalies', (req, res) => {
  res.json(detectAnomalies());
});

// Deepgram STT/TTS go through Composite Voice proxy directly
app.use(proxy.middleware);
proxy.attachWebSocket(server);

// Passthrough to the Tapes deck web API
app.get('/api/tapes/overview', async (req, res) => {
  try {
    const url = new URL('/api/overview', TAPES_DECK);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
    res.json(await (await fetch(url.toString())).json());
  } catch (err) {
    res.status(502).json({ error: 'tapes_deck_error', message: err.message });
  }
});

app.get('/api/tapes/session/:id', async (req, res) => {
  try {
    const url = `${TAPES_DECK}/api/session/${encodeURIComponent(req.params.id)}`;
    res.json(await (await fetch(url)).json());
  } catch (err) {
    res.status(502).json({ error: 'tapes_deck_error', message: err.message });
  }
});

// Serve the SDK browser bundle
app.use('/sdk', express.static(
  join(__dirname, 'node_modules/@lukeocodes/composite-voice/dist'),
  { setHeaders: (res) => res.setHeader('Content-Type', 'application/javascript') }
));

app.use(express.static(join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`\n  Composite Voice + Tapes Demo`);
  console.log(`  ───────────────────────────`);
  console.log(`  App:         http://localhost:${PORT}`);
  console.log(`  Tapes Proxy: ${TAPES_PROXY} (Anthropic LLM calls)`);
  console.log(`  Tapes Deck:  ${TAPES_DECK} (trace dashboard)`);
  console.log(`  SQLite:      ${DB_PATH}`);
  console.log(`  Usage API:   http://localhost:${PORT}/api/usage`);
  console.log(`\n  "See everything your voice agent does. Change zero lines of code."\n`);
});
