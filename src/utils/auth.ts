import type { Config } from "../config.js"

export function isTelegramAllowed(
  userId: number,
  username: string | undefined,
  config: Config,
): boolean {
  const allowed = config.channels.telegram?.allowFrom
  if (!allowed || allowed.length === 0) return false

  return allowed.some((entry) => {
    if (typeof entry === "number") return entry === userId
    if (typeof entry === "string") {
      const name = entry.startsWith("@") ? entry.slice(1) : entry
      return username?.toLowerCase() === name.toLowerCase()
    }
    return false
  })
}
