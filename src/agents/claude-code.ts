import { spawn } from "child_process"
import { createInterface } from "readline"
import { detectPlatform, useShell } from "../utils/platform.js"
import type { Agent, AgentRun } from "./base.js"

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export class ClaudeCodeAgent implements Agent {
  constructor(
    private workDir: string,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  run(prompt: string, sessionId?: string): AgentRun {
    const platform = detectPlatform()

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",               // required by Claude Code when using stream-json
      "--include-partial-messages",
      // Bypass confirmation prompts — safe because only allowlisted users can trigger runs
      "--permission-mode", "bypassPermissions",
    ]
    if (sessionId) args.push("--resume", sessionId)

    const proc = spawn("claude", args, {
      cwd: this.workDir,
      shell: useShell(platform),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Kill the subprocess if it runs longer than the configured timeout
    const timer = setTimeout(() => proc.kill("SIGTERM"), this.timeoutMs)
    proc.once("close", () => clearTimeout(timer))

    let resolveId!: (v: string | undefined) => void
    const sessionIdPromise = new Promise<string | undefined>((r) => { resolveId = r })

    const output = streamOutput(proc, resolveId, this.timeoutMs)

    return { output, sessionId: sessionIdPromise }
  }
}

function formatToolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const fp = String(i.file_path ?? i.path ?? i.notebook_path ?? "")
  const file = fp ? ` \`${fp.split("/").pop() ?? fp}\`` : ""
  switch (name) {
    case "Read":      return `📖 Reading${file}`
    case "Write":     return `✏️ Writing${file}`
    case "Edit":      return `✏️ Editing${file}`
    case "Bash":      return `⚡ \`${String(i.command ?? "").trim().slice(0, 50)}\``
    case "Glob":      return `🔍 Scanning files`
    case "Grep":      return `🔍 Searching`
    case "WebFetch":  return `🌐 Fetching URL`
    case "WebSearch": return `🌐 Searching web`
    case "Task":      return `🤖 Spawning agent`
    default:          return `🔧 ${name}`
  }
}

async function* streamOutput(
  proc: ReturnType<typeof spawn>,
  resolveId: (v: string | undefined) => void,
  timeoutMs: number,
): AsyncGenerator<string> {
  // Register BEFORE reading anything — EventEmitter won't replay a past event,
  // so if we registered after the loop we'd hang forever on fast-exiting processes.
  const closePromise = new Promise<void>((r) => proc.once("close", r))

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
  let idResolved = false

  const resolveOnce = (id: string | undefined): void => {
    if (!idResolved) {
      idResolved = true
      resolveId(id)
    }
  }

  // Track tool invocations we've already surfaced — Claude emits partial events,
  // so the same tool_use id can appear multiple times as input streams in.
  const seenToolIds = new Set<string>()

  // Drain stderr in the background so it never blocks the subprocess
  const stderrChunks: Buffer[] = []
  proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c))

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        // Non-JSON line — surface it as-is (shouldn't happen with stream-json)
        if (line.trim()) yield line
        continue
      }

      // system.init → captures session ID early so the caller can persist it
      // before the run even finishes
      if (event.type === "system" && typeof event.session_id === "string") {
        resolveOnce(event.session_id)
        continue
      }

      // assistant → text content and tool-use status lines, yielded as they stream
      if (event.type === "assistant") {
        const content = (event.message as { content?: unknown[] } | undefined)?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
            if (b.type === "text" && b.text) yield b.text
            if (b.type === "tool_use" && b.name && b.id && !seenToolIds.has(b.id)) {
              seenToolIds.add(b.id)
              yield `\n_${formatToolLabel(b.name, b.input)}_`
            }
          }
        }
        continue
      }

      // result → end of run; session_id is here too as a fallback
      if (event.type === "result") {
        if (typeof event.session_id === "string") resolveOnce(event.session_id)
        break
      }
    }
  } finally {
    resolveOnce(undefined)
    rl.close()
    // Resume stdout so any buffered data is drained and the process can exit
    proc.stdout!.resume()
  }

  await closePromise

  // Surface errors after the stream ends
  if (proc.exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
    if (proc.killed) {
      yield `\n\n⚠️ Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`
    } else if (stderr) {
      yield `\n\n⚠️ ${stderr}`
    }
  }
}
