// Stands in for the Workers-only module in unit tests. Real sockets are exercised on staging.
export function connect(): never {
  throw new Error("cloudflare:sockets is only available in the Worker");
}
