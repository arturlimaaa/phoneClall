import fs from "fs"
import path from "path"
import { Bot, InlineKeyboard } from "grammy"
import type { Config } from "../config.js"
import type { SessionManager } from "../session-manager.js"
import { ClaudeCodeAgent } from "../agents/claude-code.js"
import { CodexAgent } from "../agents/codex.js"
import type { Agent, AgentRun } from "../agents/base.js"
import { isTelegramAllowed } from "../utils/auth.js"
import { stripAnsi, chunkText } from "../utils/output-cleaner.js"

// Telegram typing indicators expire after 5 s; refresh slightly before that
const TYPING_REFRESH_MS = 4500
// How often to edit the streaming message (Telegram rate limit is ~1 edit/s per chat)
const STREAM_EDIT_INTERVAL_MS = 1500
// Soft character limit per message (Telegram hard limit is 4096 UTF-16 units)
const MSG_SOFT_LIMIT = 3800

const DEFAULT_HELP_TEXT = `
*phoneClall* — Claude Code via Telegram

Send any message and it gets forwarded to Claude Code in your project folder.

Commands:
/new — start a fresh conversation (clears history)
/project — list or switch projects
/status — show current session info
/ping — check the bot is alive
/help — show this message
`.trim()

const UNAUTHORIZED = "⛔ Unauthorized."

export function createTelegramBot(config: Config, sessions: SessionManager): Bot {
  const token = config.channels.telegram?.botToken
  if (!token) throw new Error("No Telegram bot token in config")

  const bot = new Bot(token)
  const timeoutMs = (config.timeoutSeconds ?? 300) * 1000
  const helpText = config.channels.telegram?.startMessage?.trim() ?? DEFAULT_HELP_TEXT

  // Tracks which chat IDs are currently running an agent — prevents concurrent runs
  const busy = new Set<number>()

  // ── Agent factory ────────────────────────────────────────────────────────────

  function makeAgent(type: "claude" | "codex", workDir: string): Agent {
    return type === "codex"
      ? new CodexAgent(workDir, timeoutMs)
      : new ClaudeCodeAgent(workDir, timeoutMs)
  }

  const AGENT_KEYBOARD = new InlineKeyboard()
    .text("🤖 Claude Code", "agent:claude")
    .text("⚡ Codex", "agent:codex")

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function isAllowed(userId: number | undefined, username: string | undefined): boolean {
    return isTelegramAllowed(userId ?? 0, username, config)
  }

  /** Sends a typing indicator and keeps renewing it. Returns a stop function. */
  function startTyping(chatId: number): () => void {
    let active = true
    const tick = (): void => {
      if (!active) return
      void bot.api.sendChatAction(chatId, "typing").catch(() => {})
      setTimeout(tick, TYPING_REFRESH_MS)
    }
    tick()
    return () => { active = false }
  }

  /**
   * Stream Claude's output live into a Telegram message.
   *
   * - If seedMsgId is given, edits that message as content arrives (immediate ack UX)
   * - Otherwise sends the first message on first chunk (stops typing indicator)
   * - Edits that message every STREAM_EDIT_INTERVAL_MS as more text comes in
   * - When a message reaches MSG_SOFT_LIMIT, finalises it and opens a new one
   * - Does a final edit on completion to ensure the last chunk is displayed
   */
  async function streamToChat(
    chatId: number,
    run: AgentRun,
    stopTyping: () => void,
    seedMsgId?: number,
  ): Promise<void> {
    let buffer = ""
    let currentMsgId: number | undefined = seedMsgId
    let editPending = false
    let editInterval: ReturnType<typeof setInterval> | undefined
    let typingStopped = false

    const ensureTypingStopped = (): void => {
      if (!typingStopped) { typingStopped = true; stopTyping() }
    }

    const doEdit = async (): Promise<void> => {
      if (!currentMsgId || !editPending || !buffer) return
      editPending = false
      try {
        await bot.api.editMessageText(chatId, currentMsgId, buffer)
      } catch {
        // Ignore: text unchanged, bad Markdown, network hiccup, etc.
      }
    }

    // If we already have a message to edit, stop typing and arm the edit timer now
    if (seedMsgId) {
      ensureTypingStopped()
      editInterval = setInterval(() => void doEdit(), STREAM_EDIT_INTERVAL_MS)
    }

    for await (const raw of run.output) {
      const chunk = stripAnsi(raw)
      if (!chunk) continue

      // If adding this chunk would overflow the current message, finalise it first
      if (currentMsgId && buffer.length + chunk.length > MSG_SOFT_LIMIT) {
        clearInterval(editInterval)
        editInterval = undefined
        editPending = true
        await doEdit()
        buffer = ""
        currentMsgId = undefined
      }

      buffer += chunk

      if (!currentMsgId) {
        // No existing message yet — send one and start the edit timer
        ensureTypingStopped()
        const sent = await bot.api.sendMessage(chatId, buffer)
        currentMsgId = sent.message_id
        editInterval = setInterval(() => void doEdit(), STREAM_EDIT_INTERVAL_MS)
      } else {
        editPending = true
      }
    }

    // Final flush
    clearInterval(editInterval)
    ensureTypingStopped()

    if (buffer && currentMsgId) {
      editPending = true
      await doEdit()
    } else if (!buffer) {
      // No output — update or send a fallback message
      const noOutput = "_(no output)_"
      if (currentMsgId) {
        try { await bot.api.editMessageText(chatId, currentMsgId, noOutput) } catch { /* unchanged */ }
      } else {
        await bot.api.sendMessage(chatId, noOutput, { parse_mode: "Markdown" })
      }
    }
  }

  // ── Commands ─────────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }
    await ctx.reply(
      "*phoneClall* — Choose your AI agent:",
      { parse_mode: "Markdown", reply_markup: AGENT_KEYBOARD },
    )
  })

  bot.command("help", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }
    await ctx.reply(helpText, { parse_mode: "Markdown" })
  })

  // Inline-keyboard callback: agent selection
  bot.callbackQuery(/^agent:(claude|codex)$/, async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) {
      await ctx.answerCallbackQuery("⛔ Unauthorized")
      return
    }
    const choice = ctx.match[1] as "claude" | "codex"
    const chatId = ctx.chat?.id
    if (!chatId) return

    if (busy.has(chatId)) {
      await ctx.answerCallbackQuery("⏳ Can't switch agents while a request is running")
      return
    }

    sessions.getOrCreate("telegram", chatId, {
      agentType: choice,
      workDir: config.defaultWorkDir,
    })
    sessions.update("telegram", chatId, { agentType: choice })

    const label = choice === "claude" ? "Claude Code 🤖" : "Codex ⚡"
    await ctx.answerCallbackQuery(`Switched to ${label}`)
    await ctx.editMessageText(
      `*phoneClall* — using *${label}*\n\nSend me a prompt and I'll forward it to ${label} in your project folder.\nUse /help to see all commands.`,
      { parse_mode: "Markdown" },
    )
  })

  bot.command("ping", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }
    await ctx.reply("Pong! 🏓 Bot is alive.")
  })

  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }
    const session = sessions.get("telegram", ctx.chat.id)
    if (!session) {
      await ctx.reply("No active session. Send a prompt to start one.")
      return
    }
    const idLine = session.claudeSessionId
      ? `\nSession ID: \`${session.claudeSessionId.slice(0, 8)}…\``
      : ""
    const busyLine = busy.has(ctx.chat.id) ? "\nStatus: ⏳ working" : "\nStatus: idle"
    await ctx.reply(
      `*Status*\nAgent: ${session.agentType}\nProject: \`${session.workDir}\`\nLast active: ${session.lastActive}${idLine}${busyLine}`,
      { parse_mode: "Markdown" },
    )
  })

  bot.command("new", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }
    if (busy.has(ctx.chat.id)) {
      await ctx.reply("⏳ Still working on a request. Wait for it to finish before resetting.")
      return
    }
    sessions.reset("telegram", ctx.chat.id)
    await ctx.reply("Fresh conversation started. Claude has no memory of previous messages.")
  })

  bot.command("project", async (ctx) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) { await ctx.reply(UNAUTHORIZED); return }

    const arg = (ctx.message?.text ?? "").split(" ").slice(1).join(" ").trim()
    const projects = config.projects ?? {}
    const session = sessions.get("telegram", ctx.chat.id)
    const currentDir = session?.workDir ?? config.defaultWorkDir

    if (!arg) {
      // List available projects
      const lines = Object.entries(projects).map(
        ([name, dir]) => `  ${name === currentDir || dir === currentDir ? "▶" : " "} \`${name}\` → ${dir}`
      )
      const body = lines.length
        ? `Available projects:\n${lines.join("\n")}\n\nCurrent: \`${currentDir}\``
        : `No named projects configured.\nCurrent: \`${currentDir}\`\n\nAdd projects to config:\n\`npx phoneclall setup\``
      await ctx.reply(body, { parse_mode: "Markdown" })
      return
    }

    if (busy.has(ctx.chat.id)) {
      await ctx.reply("⏳ Can't switch projects while a request is running.")
      return
    }

    // Resolve: named project first, then treat arg as a direct path.
    // path.resolve() normalises relative segments (e.g. "../../etc" → "/etc")
    // so the stored workDir is always an unambiguous absolute path.
    const directPath = path.resolve(arg)
    const resolved = projects[arg] ?? (fs.existsSync(directPath) ? directPath : null)
    if (!resolved) {
      const available = Object.keys(projects).join(", ") || "none"
      await ctx.reply(
        `Project not found: \`${arg}\`\nAvailable: ${available}`,
        { parse_mode: "Markdown" },
      )
      return
    }

    // Ensure-create session before updating it
    sessions.getOrCreate("telegram", ctx.chat.id, {
      agentType: config.defaultAgent,
      workDir: resolved,
    })
    sessions.update("telegram", ctx.chat.id, { workDir: resolved })
    sessions.reset("telegram", ctx.chat.id) // clear Claude session — new project context
    await ctx.reply(`Switched to \`${resolved}\`\nConversation reset.`, { parse_mode: "Markdown" })
  })

  // ── Main message handler ──────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const { id: userId, username } = ctx.from ?? {}
    if (!isAllowed(userId, username)) { await ctx.reply(UNAUTHORIZED); return }

    const text = ctx.message.text
    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Send /help for the list.")
      return
    }

    // Guard against concurrent runs for the same chat
    if (busy.has(ctx.chat.id)) {
      await ctx.reply("⏳ Still working on your previous message. Please wait.")
      return
    }

    const session = sessions.getOrCreate("telegram", ctx.chat.id, {
      agentType: config.defaultAgent,
      workDir: config.defaultWorkDir,
    })

    busy.add(ctx.chat.id)

    // Immediate acknowledgement — the user sees this right away on mobile
    // while Claude Code spins up (which can take a few seconds)
    let ackMsgId: number | undefined
    try {
      const ack = await bot.api.sendMessage(ctx.chat.id, "⏳ Working…")
      ackMsgId = ack.message_id
    } catch { /* non-fatal — we'll still stream output */ }

    const stopTyping = startTyping(ctx.chat.id)

    try {
      const agent = makeAgent(session.agentType, session.workDir)
      const run = agent.run(text, session.claudeSessionId)

      // Persist session ID as soon as it's known (stream-json provides it early,
      // from the system.init event, before the run even finishes)
      void run.sessionId.then((sid) => {
        if (sid) sessions.update("telegram", ctx.chat.id, { claudeSessionId: sid })
      }).catch((err: unknown) => {
        console.error("[phoneclall] session update failed:", err)
      })

      await streamToChat(ctx.chat.id, run, stopTyping, ackMsgId)
    } catch (err) {
      stopTyping()
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`⚠️ Error: ${msg}`)
    } finally {
      busy.delete(ctx.chat.id)
    }
  })

  bot.catch((err) => {
    console.error("[telegram] unhandled error:", err.message)
  })

  return bot
}
