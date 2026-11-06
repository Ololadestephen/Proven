const NEAR = 10n ** 24n;
/** Parse decimal NEAR exactly, without rounding the amount a buyer approved. */
export function parseNearAmount(value: string): bigint {
  if (!/^\d+(?:\.\d{1,24})?$/.test(value))
    throw new Error("Enter a NEAR amount with at most 24 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * NEAR + BigInt(fraction.padEnd(24, "0"));
  if (amount <= 0n || amount > NEAR / 10n)
    throw new Error("The payment must be above 0 and at most 0.1 NEAR.");
  return amount;
}
