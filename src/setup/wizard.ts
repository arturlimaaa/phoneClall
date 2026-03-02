import * as p from "@clack/prompts"
import fs from "fs"
import { detect } from "./detect.js"
import { saveConfig, configPath } from "../config.js"
import { detectPlatform, preventSleep } from "../utils/platform.js"
import { installAutostart } from "./autostart.js"
import type { Config } from "../config.js"

export async function runWizard(): Promise<Config> {
  const platform = detectPlatform()
  const found = detect(platform)

  console.log() // top spacer

  p.intro("phoneClall  —  your phone as a terminal agent remote")

  // ── System check ──────────────────────────────────────────────────────────
  const checks = [
    `Platform : ${platform}`,
    `Node     : ${found.nodeVersion}`,
    found.claude
      ? `claude   : ✓ ${found.claude}`
      : `claude   : ✗ not found — install from https://claude.ai/code`,
    found.codex
      ? `codex    : ✓ ${found.codex}`
      : `codex    :   not found (optional)`,
  ]
  p.note(checks.join("\n"), "System check")

  if (!found.claude && !found.codex) {
    p.cancel(
      "Neither claude nor codex was found in PATH.\n" +
      "Install Claude Code first: https://claude.ai/code",
    )
    process.exit(1)
  }

  // ── Messaging channel ──────────────────────────────────────────────────────
  const channel = await p.select({
    message: "Which messaging app do you want to connect?",
    options: [
      {
        value: "telegram",
        label: "Telegram",
        hint: "recommended — official Bot API, zero risk of account ban",
      },
      {
        value: "whatsapp",
        label: "WhatsApp",
        hint: "unofficial API — use a dedicated number, not your personal one",
      },
    ],
  })
  if (p.isCancel(channel)) { p.cancel("Setup cancelled."); process.exit(0) }

  let telegramConfig: Config["channels"]["telegram"] | undefined
  let whatsappConfig: Config["channels"]["whatsapp"] | undefined

  if (channel === "telegram") {
    // ── Telegram ──────────────────────────────────────────────────────────
    const botToken = await p.text({
      message: "Telegram bot token  (Telegram → @BotFather → /newbot)",
      placeholder: "123456:ABCDEF...",
      validate: (v) =>
        !v.trim().includes(":")
          ? "Paste the full token from BotFather (it contains a colon)"
          : undefined,
    })
    if (p.isCancel(botToken)) { p.cancel("Setup cancelled."); process.exit(0) }

    const userId = await p.text({
      message: "Your Telegram user ID  (message @userinfobot to find yours)",
      placeholder: "123456789",
      validate: (v) =>
        !/^\d+$/.test(v.trim()) ? "Must be a numeric ID (not a username)" : undefined,
    })
    if (p.isCancel(userId)) { p.cancel("Setup cancelled."); process.exit(0) }

    telegramConfig = {
      botToken: (botToken as string).trim(),
      allowFrom: [Number((userId as string).trim())],
    }
  } else {
    // ── WhatsApp ───────────────────────────────────────────────────────────
    const phone = await p.text({
      message: "Your WhatsApp number (with country code)",
      placeholder: "+1234567890",
      validate: (v) =>
        !v.trim().startsWith("+")
          ? "Include country code, e.g. +1234567890"
          : undefined,
    })
    if (p.isCancel(phone)) { p.cancel("Setup cancelled."); process.exit(0) }

    whatsappConfig = { allowFrom: [(phone as string).trim()] }

    p.note(
      "When the bot starts, a QR code will appear here.\n" +
      "Open WhatsApp → Settings → Linked Devices → Link a Device, then scan it.\n" +
      "Credentials are saved so you only need to scan once.",
      "WhatsApp pairing (next step)",
    )
  }

  // ── Default working directory ─────────────────────────────────────────────
  const workDir = await p.text({
    message: "Default project folder for Claude to work in",
    placeholder: process.cwd(),
    initialValue: process.cwd(),
    validate: (v) =>
      !fs.existsSync(v.trim()) ? "Folder does not exist" : undefined,
  })
  if (p.isCancel(workDir)) { p.cancel("Setup cancelled."); process.exit(0) }

  // ── Sleep prevention ──────────────────────────────────────────────────────
  const keepAwake = await p.confirm({
    message: "Keep machine awake while bot is running?",
    initialValue: true,
  })
  if (p.isCancel(keepAwake)) { p.cancel("Setup cancelled."); process.exit(0) }

  // ── Autostart ─────────────────────────────────────────────────────────────
  const autostart = await p.confirm({
    message: "Start phoneClall automatically at login?",
    initialValue: true,
  })
  if (p.isCancel(autostart)) { p.cancel("Setup cancelled."); process.exit(0) }

  // ── Build and save config ─────────────────────────────────────────────────
  const config: Config = {
    defaultAgent: found.claude ? "claude" : "codex",
    defaultWorkDir: (workDir as string).trim(),
    maxConcurrentJobs: 1,
    channels: {
      ...(telegramConfig ? { telegram: telegramConfig } : {}),
      ...(whatsappConfig ? { whatsapp: whatsappConfig } : {}),
    },
  }

  const s = p.spinner()

  s.start("Saving config…")
  saveConfig(config)
  s.stop(`Config saved  →  ${configPath()}`)

  if (keepAwake) {
    s.start("Enabling sleep prevention…")
    await preventSleep(platform)
    s.stop("Sleep prevention enabled")
  }

  if (autostart) {
    s.start("Installing autostart…")
    try {
      await installAutostart(platform)
      s.stop("Autostart installed — bot will start on login")
    } catch (e) {
      s.stop(
        `Autostart skipped: ${e instanceof Error ? e.message : String(e)}\n` +
        "  (you can set this up manually later)",
      )
    }
  }

  p.outro("All set! Starting phoneClall…")

  return config
}
