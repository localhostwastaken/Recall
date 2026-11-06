import { DatabaseSync } from "node:sqlite";
export class History {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS claims (hash TEXT PRIMARY KEY COLLATE NOCASE, wallet TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  add(hash: string, wallet: string) {
    const now = new Date().toISOString();
    return this.db.prepare("INSERT OR IGNORE INTO claims VALUES (?, ?, ?, ?, 'pending', 'User supplied hash; receipt not checked yet.')").run(hash, wallet, now, now).changes === 1;
  }
  pending(wallet: string): { hash: string }[] { return this.db.prepare("SELECT hash FROM claims WHERE status = 'pending' AND lower(wallet) = lower(?)").all(wallet) as { hash: string }[]; }
  update(hash: string, status: string, detail: string) { this.db.prepare("UPDATE claims SET status = ?, detail = ?, updated_at = ? WHERE hash = ?").run(status, detail, new Date().toISOString(), hash); }
  all(wallet: string) { return this.db.prepare("SELECT * FROM claims WHERE lower(wallet) = lower(?) ORDER BY created_at DESC").all(wallet); }
  close() { this.db.close(); }
}
