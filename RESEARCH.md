# OpenClaw Research Notes

Source: https://github.com/openclaw/openclaw
Fetched: 2026-02-25

## What OpenClaw Is

A **local-first personal AI assistant** that routes messages from 13+ platforms (WhatsApp, Telegram, Slack, Discord, iMessage, Signal, etc.) to an AI agent ("Pi agent") running on your own machine.

**Core concept:** WebSocket Gateway at `ws://127.0.0.1:18789` acts as the central hub. All messaging platforms connect in, all AI tools connect out.

## Architecture

```
Messaging Platforms (WhatsApp/Telegram/Slack/etc.)
                    ↓
        ┌─────────────────────────────┐
        │   Gateway (WS local server) │
        │   ws://127.0.0.1:18789      │
        └──────────────┬──────────────┘
                       ├─ Pi agent (their custom AI runtime, RPC)
                       ├─ CLI tools
                       ├─ WebChat UI
                       └─ Device nodes (macOS app, iOS, Android)
```

## Key Libraries Used by OpenClaw

| Platform   | Library        |
|------------|----------------|
| WhatsApp   | Baileys         |
| Telegram   | grammY          |
| Slack      | Bolt            |
| Discord    | discord.js      |
| Signal     | signal-cli      |
| iMessage   | BlueBubbles API |
| Matrix     | matrix-js-sdk   |

## How Their CLI Agent Works

```bash
# Single invocation
openclaw agent --message "Ship checklist" --thinking high

# Auth
openclaw channels login   # QR code for WhatsApp, token for Telegram
```

## What Their Pi Agent Does (vs. What We Need)

OpenClaw's Pi agent is their **own AI runtime** — it connects to Claude/OpenAI APIs directly and has its own tool system.

**We want something different:** We want to use **Claude Code CLI** (`claude`) or **OpenAI Codex CLI** (`codex`) as the agent — these are full agentic CLI tools that operate on a codebase, run terminal commands, write files, etc.

## OpenClaw Config Example

```json5
{
  agent: { model: "anthropic/claude-opus-4-6" },
  channels: {
    whatsapp: { allowFrom: ["+1234567890"] },
    telegram: { botToken: "123456:ABCDEF" }
  }
}
```

## What We Can Borrow

1. **Baileys** for WhatsApp (already used by OpenClaw, battle-tested)
2. **grammY** for Telegram (lightweight, well-maintained)
3. **Session model** — mapping chat IDs to active agent sessions
4. **Security model** — allowlist by phone number / username
5. **Pairing code pattern** — unknown senders get rejected by default

## What We Don't Need

- WebSocket Gateway (overkill for our use case — we're a single process)
- Canvas, voice, macOS app, browser control
- Pi agent runtime (we use Claude Code / Codex CLI directly)
- Multi-device orchestration

## Key Insight

OpenClaw routes messages → custom AI runtime.
We want to route messages → existing terminal CLI tools.

The routing layer is roughly the same. The "agent" is completely different.
