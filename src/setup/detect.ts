import { execSync } from "child_process"
import type { Platform } from "../utils/platform.js"

export interface DetectionResult {
  platform: Platform
  nodeVersion: string
  claude: string | null
  codex: string | null
}

function which(cmd: string, platform: Platform): string | null {
  try {
    const whichCmd = platform === "windows" ? `where ${cmd}` : `which ${cmd}`
    // On Windows, `where` is a built-in that needs cmd.exe as the shell.
    // On Unix, omit shell entirely so which resolves from the login PATH.
    const opts = platform === "windows"
      ? { stdio: "pipe" as const, shell: "cmd.exe" }
      : { stdio: "pipe" as const }
    const result = execSync(whichCmd, opts).toString().trim()
    return result.split("\n")[0]?.trim() || null
  } catch {
    return null
  }
}

export function detect(platform: Platform): DetectionResult {
  return {
    platform,
    nodeVersion: process.version,
    claude: which("claude", platform),
    codex: which("codex", platform),
  }
}
