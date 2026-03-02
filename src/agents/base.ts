export interface AgentRun {
  /** Async iterable of output text as it becomes available */
  output: AsyncIterable<string>
  /** Resolves with Claude Code's internal session ID once the run completes */
  sessionId: Promise<string | undefined>
}

export interface Agent {
  run(prompt: string, sessionId?: string): AgentRun
}
