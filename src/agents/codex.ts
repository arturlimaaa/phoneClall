import { spawn } from "child_process"
import { createInterface } from "readline"
import { detectPlatform, useShell } from "../utils/platform.js"
import type { Agent, AgentRun } from "./base.js"

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export class CodexAgent implements Agent {
  constructor(
    private workDir: string,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  run(prompt: string, _sessionId?: string): AgentRun {
    const platform = detectPlatform()

    // exec                                   → non-interactive subcommand
    // --dangerously-bypass-approvals-and-sandbox → skip all confirmations (safe: only allowlisted users)
    // --color never                          → no ANSI codes in output
    // --skip-git-repo-check                  → work outside git repos too
    const proc = spawn("codex", [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color", "never",
      "--skip-git-repo-check",
      prompt,
    ], {
      cwd: this.workDir,
      shell: useShell(platform),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const timer = setTimeout(() => proc.kill("SIGTERM"), this.timeoutMs)
    proc.once("close", () => clearTimeout(timer))

    return {
      output: streamPlainOutput(proc, this.timeoutMs),
      // Codex CLI has no session-resume equivalent — each run is independent
      sessionId: Promise.resolve(undefined),
    }
  }
}

async function* streamPlainOutput(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): AsyncGenerator<string> {
  const closePromise = new Promise<void>((r) => proc.once("close", r))

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
  const stderrChunks: Buffer[] = []
  proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c))

  try {
    for await (const line of rl) {
      yield line + "\n"
    }
  } finally {
    rl.close()
    proc.stdout!.resume()
  }

  await closePromise

  if (proc.exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
    if (proc.killed) {
      yield `\n\n⚠️ Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`
    } else if (stderr) {
      yield `\n\n⚠️ ${stderr}`
    }
  }
}
