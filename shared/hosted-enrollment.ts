export interface HostedEnrollment {
  prompt: string;
  knowledge: string;
  skills: readonly string[];
  keep_bps: number;
  min_buyer_paid_share: number | null;
}

/** The owner signs every enrollment setting. JSON keeps embedded delimiters unambiguous. */
export function enrollmentText(input: HostedEnrollment): string {
  return JSON.stringify({
    version: 2,
    prompt: input.prompt,
    knowledge: input.knowledge,
    skills: [...new Set(input.skills)].sort(),
    keep_bps: input.keep_bps,
    min_buyer_paid_share: input.min_buyer_paid_share,
  });
}
