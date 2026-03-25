# Self-Aware Voice Agent Demo (2 min)

> A voice agent that remembers you, knows its own code, and learns from conversation.

## Setup

```bash
npm start
```

Open `http://localhost:3000` and click the mic button.

---

## Act 1: Memory (30s)

**Say:** "Hey, my name is [your name] and I work at [company]."

- Agent responds naturally, using your name
- Click the **Memory** tab on the right panel -- you'll see extracted memories like `User's name is Brian` with timestamps
- Memories persist to `.tapes/memory.json` and survive restarts

**Say:** "What do you remember about me?"

- Agent recalls your name and company from injected memory context

---

## Act 2: Traces & Cost (20s)

While the Memory tab is still fresh, switch to the **Cost** and **Traces** tabs:

- **Cost tab**: Show total cost (fractions of a cent), input/output token breakdown, per-turn costs
- **Traces tab**: Show the live request log -- each Deepgram STT, Anthropic LLM, and Deepgram TTS call with latency and status codes
- **Latency tab**: Show the bar chart with STT/LLM/TTS averages and which provider is the bottleneck

> Talking point: "Every voice turn hits three providers. We trace each one so you can see exactly where time and money go."

---

## Act 3: Self-Awareness (40s)

**Say:** "What files are in your project?"

- Agent calls `list_project_files` behind the scenes and describes its own structure

**Say:** "Read your server.js and tell me how your memory system works."

- Agent calls `read_source_code`, reads its own source, and explains the `[MEMORY:]` tag extraction

**Say:** "Add a test file called test.js that verifies the memory extraction regex works."

- Agent calls `modify_code`, which spawns a Claude Agent SDK session
- The SDK agent creates `test.js` on disk with a real test
- Agent confirms the file was created (verify with `ls test.js` after demo)

> Talking point: "The agent just wrote and saved a file to its own repo. It used Claude Agent SDK under the hood -- the same tools Claude Code uses."

---

## Act 4: Conversational Context (30s)

**Say:** "I'm building a demo for a conference talk about AI agents."

**Then say:** "Given what you know about me and what I'm working on, what feature should I add to you next?"

- Agent combines your stored memories (name, company) with the current conversation context (conference talk, AI agents) to give a personalized suggestion
- This shows 6-turn conversation history + persistent memory working together

> Talking point: "It's not just transcription. The agent builds a picture of who you are across the conversation and across sessions."

---

## If Something Goes Wrong

- **Mic not working**: Check browser permissions, refresh the page
- **Agent not using tools**: Rephrase with "look at your code" or "check your files"
- **modify_code slow**: The SDK agent can take 10-15s -- fill time by narrating what's happening
- **Changes not visible**: Remind audience changes take effect after `npm start` restart
