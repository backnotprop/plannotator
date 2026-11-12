import type { NormalizedSignup } from "./validation";

export interface SignupRow extends NormalizedSignup {
  id: number;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  referer: string | null;
  created_at: string;
}

export interface SignupContext {
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  referer: string | null;
}

export interface WaitlistStore {
  insert(signup: NormalizedSignup, ctx: SignupContext): Promise<boolean>;

  bumpRateLimit(ip: string, day: string): Promise<number>;

  list(limit: number): Promise<SignupRow[]>;
  count(): Promise<number>;
}
