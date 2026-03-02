# phoneClall — Plan

**Goal:** Use WhatsApp or Telegram to send prompts to terminal agents (Claude Code, Codex) as if you were typing in your terminal. Your phone becomes a remote control for agentic CLI tools running on your machine.

**Design principle:** Setup must be so easy it feels like cheating. No config files to hand-edit, no daemon flags to memorize, no platform-specific instructions to follow. One command, a few questions, done.

---

## The Core Idea

```
[Your phone] ──WhatsApp/Telegram──► [Bot process on your Mac/server]
                                            │
                                   Session Manager
                                            │
                              ┌─────────────┴─────────────┐
                              │                           │
                         claude CLI                  codex CLI
                       (Claude Code)              (OpenAI Codex)
                              │                           │
                         your filesystem ◄──────────────┘
                              │
                   [Response chunks back to phone]
```

You send a message like `"add a dark mode toggle to the settings page"` → Claude Code receives it in the context of a chosen project directory → does the work → streams back its response to your phone.

---

## Setup Experience

### The entire setup, from zero to running

```bash
npx phoneclall
```

That's the only command the user needs to know. On first run, an interactive wizard handles everything else.

### First-run wizard flow

```
◆  phoneClall
│  Your phone → your terminal agents
│
◇  Detected: macOS — Apple Silicon
│  ✓ claude found at /usr/local/bin/claude
│  ✓ Node 22.3.0
│
◆  Which messaging app do you want to use?
│  ● Telegram  (recommended — easier, no ban risk)
│  ○ WhatsApp
│
◇  Paste your Telegram bot token
│  (Open Telegram → message @BotFather → /newbot)
│  ▸ 123456:ABCDEF
│
◇  Your Telegram user ID
│  (Message @userinfobot on Telegram to find yours)
│  ▸ 987654321
│
◇  Default project folder for Claude to work in
│  ▸ /Users/artur/projects/myapp  [enter = current dir]
│
◇  Keep machine awake while bot is running?
│  ● Yes  (recommended)
│  ○ No
│
◇  Start phoneClall automatically on login?
│  ● Yes  (recommended)
│  ○ No
│
◆  All set! Starting phoneClall...
│  ✓ Config saved to ~/.phoneClall/config.json
│  ✓ Sleep prevention enabled
│  ✓ Autostart installed
│
└  Send any message to your Telegram bot to begin!
```

**Total time: under 2 minutes.** The wizard auto-detects the platform and handles sleep prevention and autostart silently — no platform-specific instructions for the user to follow.

### What the wizard does automatically (user never sees this)

- Detects OS (macOS / Windows / WSL2 / Linux)
- Checks if `claude` or `codex` is in PATH; tells user if not found and points to install docs
- Enables sleep prevention using the right mechanism for the platform
- Installs autostart using the right mechanism for the platform:
  - macOS → writes and loads a `launchd` plist
  - Windows → registers a Task Scheduler entry via `schtasks`
  - WSL2 → sets up PM2 + a Task Scheduler entry that runs `wsl -e pm2 resurrect`
  - Linux → writes a `systemd` user unit file
- Writes `~/.phoneClall/config.json` from wizard answers
- Starts the bot immediately without requiring a restart

### WhatsApp path (same simplicity)

If the user picks WhatsApp, the wizard prints a QR code directly in the terminal:

```
◆  Scan this QR code with WhatsApp on your phone
│  (WhatsApp → Settings → Linked Devices → Link a Device)
│
│  █▀▀▀▀▀█ ▄▀▄▀ █▀▀▀▀▀█
│  █ ███ █ ▀▄█▀ █ ███ █
│  ...
│
◇  Waiting for scan...
│  ✓ Linked! Credentials saved.
│
◇  Your WhatsApp number (with country code, e.g. +1234567890)
│  ▸ +1234567890
```

One scan, done. Credentials are saved so it never asks again.

### Re-running after setup

```bash
npx phoneclall          # starts normally, wizard skipped (config exists)
npx phoneclall setup    # re-run wizard to change settings
npx phoneclall stop     # stop the background process
npx phoneclall status   # show running status and current config
```

---

## Why Not Just Fork OpenClaw?

OpenClaw's Pi agent is a **custom AI runtime** that talks to model APIs directly. We want to reuse **existing terminal agents** (`claude`, `codex`) because:

- They already have file reading, editing, bash execution tools built in
- They maintain their own conversation history and session state
- They understand the codebase context (CLAUDE.md, project conventions)
- We don't want to rebuild what they already do well

So: we borrow OpenClaw's **messaging layer approach** (Baileys for WA, grammY for TG), but swap the "Pi agent" for a subprocess spawner that drives CLI tools.

---

## Architecture

### Components

```
src/
  index.ts              # Entry point — run wizard if no config, else start bot
  setup/
    wizard.ts           # Interactive first-run wizard (@clack/prompts)
    autostart.ts        # Install autostart for current platform
    detect.ts           # Check for claude/codex in PATH, Node version, etc.
  config.ts             # Load/save ~/.phoneClall/config.json
  session-manager.ts    # Map (chatId → AgentSession)
  adapters/
    whatsapp.ts         # Baileys-based WA listener
    telegram.ts         # grammY-based TG listener
  agents/
    claude-code.ts      # Spawn + drive `claude` CLI
    codex.ts            # Spawn + drive `codex` CLI
    base.ts             # Shared interface
  utils/
    output-cleaner.ts   # Strip ANSI codes, chunk long messages
    auth.ts             # Allowlist checking
    platform.ts         # Platform detection + OS-specific adapters
```

### Data flow

1. User sends message on phone
2. Platform adapter (WA/TG) receives it, extracts text + sender
3. Auth check: is sender on the allowlist?
4. Session manager looks up or creates a session for this chat ID
5. Session routes message to the active agent (Claude Code or Codex)
6. Agent subprocess receives the prompt, processes it
7. Output is cleaned (strip ANSI escape codes) and chunked
8. Response chunks are sent back via the same platform adapter

---

## Session Model

Each chat (DM or group) maps to one **AgentSession**:

```typescript
interface AgentSession {
  chatId: string
  agentType: "claude" | "codex"
  workDir: string          // which project dir this session operates on
  process: ChildProcess    // the running CLI subprocess (or null if stateless)
  history: Message[]       // for stateless mode: kept in memory
  lastActive: Date
}
```

### Two modes for driving CLI agents

**Mode A: Stateless (simpler, recommended to start)**
- Each message invokes `claude --print "message"` with full conversation history passed via `--context` or by writing a temp file
- No persistent process needed
- Simpler, more reliable, easier to restart

**Mode B: Persistent PTY session (advanced)**
- Keep a `node-pty` pseudo-terminal running `claude` interactively
- Feed messages to stdin, read stdout until a "done" heuristic
- More complex but enables true interactive sessions (can ask Claude Code to "continue", etc.)

**Recommendation:** Start with Mode A (stateless), ship Mode B as an enhancement.

---

## Claude Code CLI Integration

Claude Code (`claude`) supports non-interactive use:

```bash
# Single prompt, print response and exit
claude --print "add a dark mode toggle"

# Continue the last session
claude --continue --print "now also add it to mobile"

# Specify a working directory
claude --print "review the auth module" --cwd /path/to/project

# Use --output-format for structured output
claude --print "message" --output-format stream-json
```

**Session continuity:** Claude Code stores session history in `~/.claude/projects/...`. The `--continue` flag resumes the last session. We can also use `--resume <session-id>` to resume a specific one.

**Key insight:** Each WhatsApp/Telegram chat maps to one `--resume <id>`, so conversations stay coherent per-chat.

---

## Codex CLI Integration

OpenAI Codex CLI (`codex`) similarly supports:

```bash
codex "your prompt here"
codex --model o3 "your prompt"
```

We'd run it as a subprocess similarly to Claude Code.

---

## WhatsApp Setup (via Baileys)

```bash
npm install @whiskeysockets/baileys
```

- Scan QR code once → credentials saved to `~/.phoneClall/credentials/whatsapp/`
- No Meta developer account needed (uses WhatsApp Web protocol)
- Allowlist by phone number in config

**Risk:** Unofficial API — WhatsApp can ban accounts. Use a dedicated WA number for this, not your personal one. (OpenClaw documents this risk too.)

---

## Telegram Setup (via grammY)

```bash
npm install grammy
```

- Create a bot via @BotFather → get `BOT_TOKEN`
- More stable than WhatsApp (official Bot API)
- Allowlist by Telegram username or user ID in config

**Recommendation:** Start with Telegram for development (official API, no ban risk), add WhatsApp once stable.

---

## Config File (~/.phoneClall/config.json)

The wizard generates this — users rarely touch it directly. But it's plain readable JSON if they want to edit it manually.

**Minimum viable config (what the wizard produces for Telegram):**
```json
{
  "defaultAgent": "claude",
  "defaultWorkDir": "/Users/artur/my-project",
  "channels": {
    "telegram": {
      "botToken": "123456:ABCDEF",
      "allowFrom": [987654321]
    }
  }
}
```

**Full config with all options:**
```json
{
  "defaultAgent": "claude",
  "defaultWorkDir": "/Users/artur/my-project",
  "maxConcurrentJobs": 1,
  "channels": {
    "telegram": {
      "botToken": "123456:ABCDEF",
      "allowFrom": [987654321, "@artur"]
    },
    "whatsapp": {
      "allowFrom": ["+1234567890"]
    }
  },
  "projects": {
    "myapp": "/Users/artur/my-project",
    "api": "/Users/artur/api-server"
  }
}
```

The wizard only asks for what's truly required. Everything else defaults sensibly.

---

## Chat Commands

In addition to free-form prompts, support slash commands in chat:

| Command | Action |
|---------|--------|
| `/new` | Start a fresh session (new conversation) |
| `/project myapp` | Switch working directory to a named project |
| `/agent codex` | Switch to Codex for this session |
| `/status` | Show current session info (project, agent, last active) |
| `/cancel` | Kill the current running subprocess |
| `/ping` | Check if the bot is alive and responding |

---

## Output Handling

Claude Code and Codex output ANSI escape codes, progress bars, and can produce very long responses. We need to:

1. **Strip ANSI codes** — use `strip-ansi` npm package
2. **Chunk long messages** — Telegram max is 4096 chars, WhatsApp ~65,535
3. **Stream vs. batch** — Option to send partial updates as Claude streams, or wait for completion
4. **Code blocks** — Preserve markdown fences, they render nicely in Telegram

---

## Security Considerations

- **Allowlist only** — unknown senders get no response (or a rejection message)
- **Per-project sandboxing** — each session tied to one workDir
- **No sensitive files in responses** — consider denylist of paths (`.env`, `~/.ssh`, etc.)
- **Rate limiting** — max N messages per minute per sender
- **Timeout** — kill subprocess after N seconds if no response

---

## Cross-Platform: Windows & macOS

The bot is designed to run on both. Most of the code is identical — Node.js, TypeScript, grammY, and Baileys are all cross-platform. The differences are narrow and isolated to `src/utils/platform.ts`.

### `platform.ts` — the detection module

Detects the environment at startup and exports platform-specific implementations:

```typescript
export type Platform = "macos" | "windows" | "wsl2" | "linux"

export function detectPlatform(): Platform {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  // WSL2 reports as Linux but has Microsoft in /proc/version
  if (process.platform === "linux") {
    const version = fs.readFileSync("/proc/version", "utf8").toLowerCase()
    if (version.includes("microsoft") || version.includes("wsl")) return "wsl2"
    return "linux"
  }
  return "linux"
}
```

This value drives every platform-specific decision at runtime.

---

### What changes per platform

#### 1. Sleep prevention

Called once at startup to stop the OS from sleeping and killing the process.

| Platform | Mechanism |
|----------|-----------|
| macOS | Spawn `caffeinate -i` as a background child process |
| Windows | Run `powercfg -change -standby-timeout-ac 0` via `exec` |
| WSL2 | Run the Windows `powercfg` via `powershell.exe -Command "..."` from inside WSL |
| Linux | No-op (or `systemd-inhibit` if available) |

```typescript
export async function preventSleep(platform: Platform): Promise<void> {
  switch (platform) {
    case "macos":
      spawn("caffeinate", ["-i"], { detached: true, stdio: "ignore" }).unref()
      break
    case "windows":
      await exec("powercfg -change -standby-timeout-ac 0")
      break
    case "wsl2":
      await exec('powershell.exe -Command "powercfg -change -standby-timeout-ac 0"')
      break
  }
}
```

#### 2. Subprocess shell invocation

On Windows, npm-installed CLIs are `.cmd` files and won't be found without `shell: true`.

```typescript
export function spawnOptions(platform: Platform): SpawnOptions {
  return {
    shell: platform === "windows",  // cmd.exe resolves .cmd shims
    env: process.env,
  }
}
```

On macOS/WSL2/Linux, `shell: false` is fine and slightly more efficient.

#### 3. Config directory

```typescript
export function configDir(): string {
  // os.homedir() returns the right home on all platforms
  return path.join(os.homedir(), ".phoneClall")
}
```

This works unchanged on all platforms. On Windows it resolves to `C:\Users\<name>\.phoneClall`.

#### 4. Process persistence (setup instructions, not runtime code)

| Platform | Recommended approach |
|----------|---------------------|
| macOS | `launchd` plist in `~/Library/LaunchAgents/` |
| Windows (native) | NSSM wrapping `node dist/index.js` as a Windows Service |
| WSL2 | PM2 inside WSL2 + Task Scheduler to run `wsl -e pm2 resurrect` at login |
| Linux | `systemd` user service |

PM2 (`pm2 start dist/index.js --name phoneclall && pm2 save`) works everywhere as a simpler dev-time option.

---

### WSL2 note

If running inside WSL2, the platform is detected as `"wsl2"` (not `"windows"`). This matters for sleep prevention (needs to call out to the Windows `powershell.exe`). Everything else — paths, shell, Node.js — behaves like Linux inside WSL2.

---

### `node-pty` caveat (Phase 4 only)

Persistent PTY sessions (Mode B) require `node-pty`, which needs native build tools:
- **macOS:** Xcode Command Line Tools (`xcode-select --install`) — usually already present
- **Windows native:** Visual Studio C++ Build Tools — heavier install
- **WSL2/Linux:** standard `build-essential` package

Phase 1–3 use `child_process.spawn` only, so no native deps are needed to get started.

---

### Network (same on all platforms)

Both Telegram (long-polling) and Baileys (outbound WebSocket) require no inbound ports — works behind any home router on any OS. Reconnection logic handles WiFi drops and sleep/wake on all platforms.

### Resource contention (same on all platforms)

Claude Code subprocesses are CPU/memory heavy. `maxConcurrentJobs: 1` in config queues prompts rather than stacking agents.

---

## Tech Stack

| Thing | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (Node.js) | Cross-platform, same as OpenClaw |
| Setup wizard | `@clack/prompts` | Beautiful, minimal interactive prompts — used by Vite, Astro |
| WhatsApp | `@whiskeysockets/baileys` | Best unofficial WA lib |
| Telegram | `grammy` | Official API, great TS support |
| Terminal | `child_process` (mode A) / `node-pty` (mode B, later) | Simple exec first, PTY as enhancement |
| Logging | `pino` | Fast, structured |
| Build | `tsup` | Bundles to single JS file, makes `npx` fast |

---

## Implementation Phases

### Phase 0 — Setup wizard (build this first)
- [ ] `platform.ts`: detect OS + WSL2
- [ ] `detect.ts`: check for `claude`/`codex` in PATH, Node version
- [ ] `wizard.ts`: interactive first-run wizard with `@clack/prompts`
- [ ] `autostart.ts`: install autostart per platform (launchd / schtasks / systemd / PM2)
- [ ] Sleep prevention triggered by wizard
- [ ] Config written from wizard answers
- [ ] `npx phoneclall setup` re-runs wizard; `npx phoneclall` skips it if config exists

### Phase 1 — Telegram + Claude Code (core loop)
- [ ] Telegram bot listener (grammY)
- [ ] Auth check (allowlist from config)
- [ ] Claude Code subprocess adapter (stateless `--print` mode)
- [ ] Output cleaner: strip ANSI, chunk to 4096 chars
- [ ] Session manager: one Claude session ID per chat ID
- [ ] `/new`, `/status`, `/ping` commands
- [ ] End-to-end test: message → Claude Code → response back

### Phase 2 — Polish + project switching
- [ ] `/project myapp` command to switch workDirs
- [ ] Named projects in config
- [ ] Error handling (subprocess crash, timeout, no `claude` found)
- [ ] `npx phoneclall stop` / `npx phoneclall status` CLI subcommands
- [ ] Streaming output: send partial updates as Claude responds

### Phase 3 — WhatsApp support
- [ ] Baileys adapter
- [ ] QR code displayed in terminal during wizard
- [ ] Credentials persisted so QR only needed once
- [ ] Test with dedicated WA number

### Phase 4 — Codex + persistent sessions
- [ ] Codex CLI adapter
- [ ] `/agent codex` switching command
- [ ] Persistent PTY mode (Mode B) as opt-in config flag

---

## Open Questions

1. **Claude Code `--print` mode:** Need to verify exact flags for non-interactive invocation and session resumption. (`claude --help` will confirm.)
2. **Conversation continuity:** Can we reliably map a WhatsApp/Telegram chat ID to a Claude Code session ID? Or do we need to track this ourselves in `~/.phoneClall/sessions.json`?
3. **Output streaming:** Does `claude --print --output-format stream-json` work well enough for chunked telegram messages?
4. **Codex API:** OpenAI Codex CLI may require API key + specific flags — need to verify current state of the tool.
5. **WhatsApp number:** User needs a dedicated phone number for the WhatsApp bot to avoid getting personal number banned.

---

## What to Build First

**Phase 0 wizard first, then the core loop.**

The wizard is the front door — it's the first thing a new user sees, so it should work perfectly before anything else. It also generates the config that everything else reads, so building it first means Phase 1 can immediately read real config rather than hardcoded values.

Once the wizard runs cleanly and produces a valid `config.json`, Phase 1 is ~100 lines: listen for Telegram messages, pipe to `claude --print`, send back stdout.
