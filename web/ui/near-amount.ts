const NEAR = 10n ** 24n;
/** Parse decimal NEAR exactly, without rounding the amount a buyer approved. */
export function parseNearAmount(value: string, max: bigint | null): bigint {
  if (!/^\d+(?:\.\d{1,24})?$/.test(value))
    throw new Error("Enter a NEAR amount with at most 24 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * NEAR + BigInt(fraction.padEnd(24, "0"));
  if (amount <= 0n) throw new Error("The payment must be above 0.");
  if (max !== null && amount > max)
    throw new Error(
      `The payment can be at most ${Number(max / 10n ** 18n) / 1e6} NEAR.`,
    );
  return amount;
}
