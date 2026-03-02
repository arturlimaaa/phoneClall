// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

// Telegram's hard limit is 4096 UTF-16 code units; stay safely under it
const TG_LIMIT = 4000

/**
 * Split a (potentially long) text into Telegram-safe chunks.
 * Tries to break at newlines so code blocks and paragraphs stay intact.
 */
export function chunkText(text: string, limit = TG_LIMIT): string[] {
  const cleaned = stripAnsi(text).trim()
  if (!cleaned) return []
  if (cleaned.length <= limit) return [cleaned]

  const chunks: string[] = []
  let rest = cleaned

  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    // Prefer a newline split in the back half of the window so we don't
    // produce tiny trailing chunks
    const newlineAt = rest.lastIndexOf("\n", limit)
    const cut = newlineAt > limit / 2 ? newlineAt + 1 : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }

  return chunks
}
