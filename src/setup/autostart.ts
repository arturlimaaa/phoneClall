import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"
import path from "path"
import os from "os"
import { configDir, logsDir } from "../utils/platform.js"
import type { Platform } from "../utils/platform.js"

const execAsync = promisify(exec)

export async function installAutostart(platform: Platform): Promise<void> {
  const nodeExec = process.execPath
  const script = process.argv[1] ?? ""

  fs.mkdirSync(logsDir(), { recursive: true })

  switch (platform) {
    case "macos":
      await installLaunchd(nodeExec, script)
      break
    case "windows":
      await installTaskScheduler(nodeExec, script)
      break
    case "wsl2":
      await installWsl2(nodeExec, script)
      break
    case "linux":
      await installSystemd(nodeExec, script)
      break
  }
}

async function installLaunchd(nodeExec: string, script: string): Promise<void> {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents")
  const plistPath = path.join(plistDir, "com.phoneclall.plist")
  const logs = logsDir()

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.phoneclall</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logs}/out.log</string>
  <key>StandardErrorPath</key>
  <string>${logs}/err.log</string>
</dict>
</plist>`

  fs.mkdirSync(plistDir, { recursive: true })
  fs.writeFileSync(plistPath, plist, "utf8")

  // Unload silently if already loaded, then (re)load
  await execAsync(`launchctl unload -w "${plistPath}" 2>/dev/null; launchctl load -w "${plistPath}"`)
}

async function installTaskScheduler(nodeExec: string, script: string): Promise<void> {
  const taskName = "phoneClall"
  // /f overwrites an existing task with the same name
  const cmd = `schtasks /create /f /tn "${taskName}" /tr "${nodeExec} ${script}" /sc onlogon /rl limited`
  await execAsync(cmd)
}

async function installWsl2(nodeExec: string, script: string): Promise<void> {
  // Use PM2 inside WSL2 to keep the process alive across sessions.
  // The user needs to separately configure WSL2 to start on Windows boot
  // (e.g. via Task Scheduler calling: wsl -e pm2 resurrect)
  try {
    await execAsync("pm2 --version")
  } catch {
    await execAsync("npm install -g pm2")
  }
  await execAsync("pm2 delete phoneclall 2>/dev/null; true")
  await execAsync(`pm2 start "${script}" --name phoneclall --interpreter "${nodeExec}"`)
  await execAsync("pm2 save")
}

async function installSystemd(nodeExec: string, script: string): Promise<void> {
  const serviceDir = path.join(os.homedir(), ".config", "systemd", "user")
  const servicePath = path.join(serviceDir, "phoneclall.service")
  const logs = logsDir()

  const unit = `[Unit]
Description=phoneClall — phone to terminal agent bridge
After=network.target

[Service]
ExecStart=${nodeExec} ${script}
Restart=always
RestartSec=5
StandardOutput=append:${logs}/out.log
StandardError=append:${logs}/err.log

[Install]
WantedBy=default.target`

  fs.mkdirSync(serviceDir, { recursive: true })
  fs.writeFileSync(servicePath, unit, "utf8")
  await execAsync("systemctl --user daemon-reload")
  await execAsync("systemctl --user enable --now phoneclall")
}
