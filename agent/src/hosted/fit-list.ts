// Skill answers go back to the model, so each is kept under a fixed size. A list that does not fit is
// shortened, and the answer says how much of it is shown.

export const MAX_SKILL_RESULT = 4 * 1024;

/** The answer with as many entries as fit, and `shown` and `total` when some were left out. */
export function fitList<T>(
  entries: T[],
  wrap: (shown: T[]) => Record<string, unknown>,
): string {
  let shown = entries.length;
  for (;;) {
    const text = JSON.stringify({
      ...wrap(entries.slice(0, shown)),
      ...(shown < entries.length ? { shown, total: entries.length } : {}),
    });
    if (text.length <= MAX_SKILL_RESULT || shown === 0)
      return text.slice(0, MAX_SKILL_RESULT);
    shown = Math.floor(shown / 2);
  }
}
