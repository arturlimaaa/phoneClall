# phoneClall

Prompt Claude Code or Codex from your phone. Send a message on Telegram, get the agent's response back — live, as it streams.

## How it works

You run phoneClall on your development machine. It starts a Telegram bot that listens for your messages, forwards them to Claude Code or Codex as prompts, and streams the output back to you in real time. The agent runs in whichever project folder you configure, with full access to your filesystem and tools.

## Prerequisites

- Node.js 22+
- [Claude Code](https://claude.ai/code) (`claude` in PATH) and/or [Codex CLI](https://github.com/openai/codex) (`codex` in PATH)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID (message [@userinfobot](https://t.me/userinfobot) to find it)

## Setup

```bash
npx phoneclall setup
```

The wizard will ask for your bot token, your Telegram user ID, and a default project folder. It also optionally sets up autostart on login and sleep prevention so the machine stays awake.

Config is saved to `~/.phoneClall/config.json`.

## Running

```bash
npx phoneclall
```

Or if you cloned the repo:

```bash
npm run build
node dist/index.js
```

To stop:

```bash
npx phoneclall stop
```

To check if it's running:

```bash
npx phoneclall status
```

## Bot commands

| Command | What it does |
|---|---|
| `/start` | Choose between Claude Code and Codex |
| `/new` | Clear conversation history, start fresh |
| `/project` | List configured projects |
| `/project <name>` | Switch to a different project folder |
| `/status` | Show current agent, project, and session info |
| `/ping` | Check the bot is alive |
| `/help` | Show command list |

## Configuration

`~/.phoneClall/config.json` is plain JSON and can be edited directly:

```json
{
  "defaultAgent": "claude",
  "defaultWorkDir": "/path/to/your/project",
  "maxConcurrentJobs": 1,
  "timeoutSeconds": 300,
  "channels": {
    "telegram": {
      "botToken": "123456:ABC...",
      "allowFrom": [123456789],
      "startMessage": "Optional custom text shown on /start and /help"
    }
  },
  "projects": {
    "api": "/path/to/api",
    "frontend": "/path/to/frontend"
  }
}
```

**`allowFrom`** accepts numeric user IDs and/or `@usernames`. Only listed users can interact with the bot.

**`projects`** is an optional map of short names to folder paths, used with `/project <name>`.

## Platforms

Works on macOS, Windows, WSL2, and Linux. The setup wizard detects your platform and configures autostart and sleep prevention accordingly.

## Security

- Only users listed in `allowFrom` can send prompts
- The bot token and user config live in `~/.phoneClall/` — never in the repo
- Agents run with bypass-permissions mode (safe because access is restricted to allowlisted users)
