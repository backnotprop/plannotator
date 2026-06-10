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
  /**
   * Insert a signup. Returns true if a new row was inserted, false if the
   * email was already on the list (we treat duplicates as success on the
   * client side so attackers can't enumerate the list).
   */
  insert(signup: NormalizedSignup, ctx: SignupContext): Promise<boolean>;

  /**
   * Returns the number of signups already recorded for the given IP on the
   * given UTC date and increments the counter. Used for rate limiting.
   */
  bumpRateLimit(ip: string, day: string): Promise<number>;

  list(limit: number): Promise<SignupRow[]>;
  count(): Promise<number>;
}
