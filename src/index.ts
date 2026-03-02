import fs from "fs"
import path from "path"
import { configExists, loadConfig } from "./config.js"
import { SessionManager } from "./session-manager.js"
import { runWizard } from "./setup/wizard.js"
import { createTelegramBot } from "./adapters/telegram.js"
import { configDir } from "./utils/platform.js"
import type { Config } from "./config.js"

const [, , subcommand] = process.argv

function pidPath(): string {
  return path.join(configDir(), "phoneclall.pid")
}

async function main(): Promise<void> {
  // ── Subcommands ──────────────────────────────────────────────────────────────
  if (subcommand === "setup") {
    await runWizard()
    process.exit(0)
  }

  if (subcommand === "stop") {
    const p = pidPath()
    if (!fs.existsSync(p)) {
      console.log("phoneClall doesn't appear to be running (no PID file found).")
      process.exit(0)
    }
    const pid = parseInt(fs.readFileSync(p, "utf8").trim(), 10)
    try {
      process.kill(pid, "SIGTERM")
      fs.unlinkSync(p)
      console.log(`Stopped phoneClall (PID ${pid}).`)
    } catch {
      console.log(`Could not stop PID ${pid} — it may have already exited.`)
      fs.unlinkSync(p)
    }
    process.exit(0)
  }

  if (subcommand === "status") {
    if (!configExists()) {
      console.log("phoneClall is not set up. Run:\n  npx phoneclall setup")
    } else {
      const cfg = loadConfig()
      const running = fs.existsSync(pidPath())
        ? `running (PID ${fs.readFileSync(pidPath(), "utf8").trim()})`
        : "not running"
      console.log(`phoneClall — ${running}`)
      console.log(`  Agent    : ${cfg.defaultAgent}`)
      console.log(`  Work dir : ${cfg.defaultWorkDir}`)
      console.log(`  Timeout  : ${cfg.timeoutSeconds ?? 300}s`)
      console.log(`  Telegram : ${cfg.channels.telegram ? "enabled" : "disabled"}`)
      console.log(`  WhatsApp : ${cfg.channels.whatsapp ? "enabled" : "disabled"}`)
    }
    process.exit(0)
  }

  // ── First-run: no config → wizard ────────────────────────────────────────────
  let config: Config
  if (!configExists()) {
    config = await runWizard()
  } else {
    config = loadConfig()
  }

  await startBot(config)
}

async function startBot(config: Config): Promise<void> {
  // Write PID file so `phoneclall stop` can find us
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(pidPath(), String(process.pid), "utf8")
  const removePid = (): void => { try { fs.unlinkSync(pidPath()) } catch { /* already gone */ } }

  const sessions = new SessionManager()
  const starts: Promise<void>[] = []

  if (config.channels.telegram) {
    const bot = createTelegramBot(config, sessions)
    console.log("[phoneclall] Telegram bot starting…")
    starts.push(
      bot.start({
        onStart: (info) =>
          console.log(`[phoneclall] Ready — @${info.username} is listening for messages`),
      }),
    )
  }

  if (config.channels.whatsapp) {
    console.log("[phoneclall] WhatsApp support coming soon (Phase 3)")
  }

  if (starts.length === 0) {
    console.error("[phoneclall] No channels configured. Run: npx phoneclall setup")
    removePid()
    process.exit(1)
  }

  const shutdown = (): void => { removePid(); process.exit(0) }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  await Promise.all(starts)
}

process.on("unhandledRejection", (reason) => {
  console.error("[phoneclall] Unhandled rejection:", reason)
})

process.on("uncaughtException", (err) => {
  console.error("[phoneclall] Uncaught exception:", err.message)
})

main().catch((err: unknown) => {
  console.error("[phoneclall] Fatal:", err instanceof Error ? err.message : err)
  process.exit(1)
})
