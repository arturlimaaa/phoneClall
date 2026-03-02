import fs from "fs"
import path from "path"
import { configDir } from "./utils/platform.js"

export interface Session {
  chatId: number
  agentType: "claude" | "codex"
  workDir: string
  claudeSessionId?: string // Claude Code --resume ID for conversation continuity
  lastActive: string       // ISO timestamp
}

type Platform = "telegram" | "whatsapp"
type Store = Record<string, Session>

function storePath(): string {
  return path.join(configDir(), "sessions.json")
}

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8")) as Store
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8")
}

export class SessionManager {
  private store: Store

  constructor() {
    this.store = readStore()
  }

  private key(platform: Platform, chatId: number): string {
    return `${platform}:${chatId}`
  }

  get(platform: Platform, chatId: number): Session | undefined {
    return this.store[this.key(platform, chatId)]
  }

  getOrCreate(
    platform: Platform,
    chatId: number,
    defaults: Pick<Session, "agentType" | "workDir">,
  ): Session {
    const k = this.key(platform, chatId)
    if (!this.store[k]) {
      this.store[k] = {
        chatId,
        agentType: defaults.agentType,
        workDir: defaults.workDir,
        lastActive: new Date().toISOString(),
      }
      writeStore(this.store)
    }
    return this.store[k]!
  }

  update(platform: Platform, chatId: number, patch: Partial<Session>): void {
    const k = this.key(platform, chatId)
    if (this.store[k]) {
      this.store[k] = { ...this.store[k]!, ...patch, lastActive: new Date().toISOString() }
      writeStore(this.store)
    }
  }

  /** Clear the Claude session ID so the next message starts a fresh conversation */
  reset(platform: Platform, chatId: number): void {
    const k = this.key(platform, chatId)
    if (this.store[k]) {
      const { claudeSessionId: _dropped, ...rest } = this.store[k]!
      this.store[k] = { ...rest, lastActive: new Date().toISOString() }
      writeStore(this.store)
    }
  }
}
