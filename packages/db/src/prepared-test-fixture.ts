import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./drizzle-schema.ts";
import { initializeQueries } from "./prepared.ts";
import type { DatabaseClient } from "./index.ts";

/** Domain-test fixture: compile real builders, supply query outcomes without SQL-text matching. */
export function preparedTestDatabase(
  execute: (name: string, parameters: Record<string, unknown>) => unknown | Promise<unknown>,
): DatabaseClient {
  const orm = drizzle.mock({ schema });
  const proxies = new WeakMap<object, object>();
  function wrap<T extends object>(value: T): T {
    const existing = proxies.get(value);
    if (existing) return existing as T;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const member = Reflect.get(target, key, receiver);
        if (key === "prepare" && typeof member === "function") return (name: string) => {
          const prepared = member.call(target, name);
          prepared.execute = (parameters: Record<string, unknown> = {}) => Promise.resolve(execute(name, parameters));
          return prepared;
        };
        if (typeof member !== "function" || key === "constructor") return member;
        return (...args: unknown[]) => {
          const result = member.apply(target, args);
          return result && typeof result === "object" && !(result instanceof Promise) ? wrap(result) : result;
        };
      },
    });
    proxies.set(value, proxy);
    return proxy;
  }
  const db = wrap(orm) as unknown as DatabaseClient;
  Object.defineProperty(orm, "transaction", { configurable: true, value: async <T>(callback: (tx: DatabaseClient) => Promise<T>) => callback(db) });
  initializeQueries(db as unknown as typeof orm);
  return db;
}
