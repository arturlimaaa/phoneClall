import fs from "fs"
import path from "path"
import { configDir } from "./utils/platform.js"

export interface Config {
  defaultAgent: "claude" | "codex"
  defaultWorkDir: string
  maxConcurrentJobs: number
  timeoutSeconds?: number    // how long before killing a Claude run (default: 300)
  channels: {
    telegram?: {
      botToken: string
      allowFrom: (string | number)[]
      startMessage?: string   // custom text shown on /start and /help
    }
    whatsapp?: {
      allowFrom: string[]
    }
  }
  projects?: Record<string, string>
}

export function configPath(): string {
  return path.join(configDir(), "config.json")
}

export function configExists(): boolean {
  return fs.existsSync(configPath())
}

export function loadConfig(): Config {
  const raw = fs.readFileSync(configPath(), "utf8")
  return JSON.parse(raw) as Config
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8")
}
