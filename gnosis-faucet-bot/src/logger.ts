export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  (level === "error" ? console.error : console.log)(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
}
export function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s"']+/g, "[redacted URL]"); }
