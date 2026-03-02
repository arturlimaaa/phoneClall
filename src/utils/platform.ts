import fs from "fs"
import os from "os"
import path from "path"
import { spawn, exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

export type Platform = "macos" | "windows" | "wsl2" | "linux"

export function detectPlatform(): Platform {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  if (process.platform === "linux") {
    try {
      const version = fs.readFileSync("/proc/version", "utf8").toLowerCase()
      if (version.includes("microsoft") || version.includes("wsl")) return "wsl2"
    } catch {
      // /proc/version not readable — plain Linux
    }
    return "linux"
  }
  return "linux"
}

export function configDir(): string {
  return path.join(os.homedir(), ".phoneClall")
}

export function credentialsDir(): string {
  return path.join(configDir(), "credentials")
}

export function logsDir(): string {
  return path.join(configDir(), "logs")
}

/** Whether to pass shell:true when spawning child processes */
export function useShell(platform: Platform): boolean {
  // Windows npm-installed CLIs are .cmd shims and need shell resolution
  return platform === "windows"
}

export async function preventSleep(platform: Platform): Promise<void> {
  switch (platform) {
    case "macos":
      // caffeinate keeps the system awake as long as the child lives;
      // we detach it so it outlives this process and is managed separately.
      spawn("caffeinate", ["-i"], { detached: true, stdio: "ignore" }).unref()
      break
    case "windows":
      await execAsync("powercfg -change -standby-timeout-ac 0").catch(() => {})
      break
    case "wsl2":
      // powercfg must be called through the Windows PowerShell from inside WSL
      await execAsync(
        'powershell.exe -Command "powercfg -change -standby-timeout-ac 0"',
      ).catch(() => {})
      break
    case "linux":
      // No-op: handled by the process manager (systemd, etc.)
      break
  }
}
