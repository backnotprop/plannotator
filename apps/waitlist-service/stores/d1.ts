import type {
  SignupContext,
  SignupRow,
  WaitlistStore,
} from "../core/storage";
import type { NormalizedSignup } from "../core/validation";

interface WaitlistRow {
  id: number;
  email: string;
  company: string | null;
  company_inferred: number;
  team_size: string | null;
  note: string | null;
  is_contributor: number | null;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  referer: string | null;
  created_at: string;
}

function rowToSignup(row: WaitlistRow): SignupRow {
  return {
    id: row.id,
    email: row.email,
    company: row.company ?? "",
    company_inferred: row.company_inferred === 1,
    team_size: row.team_size ?? "",
    note: row.note,
    is_contributor: row.is_contributor === 1,
    ip: row.ip,
    country: row.country,
    user_agent: row.user_agent,
    referer: row.referer,
    created_at: row.created_at,
  };
}

export class D1WaitlistStore implements WaitlistStore {
  constructor(private db: D1Database) {}

  async insert(signup: NormalizedSignup, ctx: SignupContext): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO waitlist
          (email, name, company, company_inferred, team_size, note,
           is_contributor, ip, country, user_agent, referer)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO NOTHING`
      )
      .bind(
        signup.email,
        signup.company,
        signup.company_inferred ? 1 : 0,
        signup.team_size,
        signup.note,
        signup.is_contributor ? 1 : 0,
        ctx.ip,
        ctx.country,
        ctx.user_agent,
        ctx.referer
      )
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async bumpRateLimit(ip: string, day: string): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limit (ip, day, hits) VALUES (?, ?, 1)
         ON CONFLICT(ip, day) DO UPDATE SET hits = hits + 1
         RETURNING hits`
      )
      .bind(ip, day)
      .first<{ hits: number }>();
    return row?.hits ?? 0;
  }

  async list(limit: number): Promise<SignupRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM waitlist ORDER BY created_at DESC LIMIT ?`
      )
      .bind(limit)
      .all<WaitlistRow>();
    return (results ?? []).map(rowToSignup);
  }

  async count(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as n FROM waitlist`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
