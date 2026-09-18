export function formatMinutes(minutes: number): string {
  return `${minutes.toLocaleString("en-US")} min`;
}

export function formatUsdMicros(micros: number): string {
  if (micros === 0) return "$0.00";
  const dollars = micros / 1_000_000;
  if (dollars < 0.01) return "<$0.01";
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function displayCell(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
