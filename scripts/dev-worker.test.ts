import { expect, test } from "bun:test";
import { developmentWorkerScript } from "./dev-worker.ts";

test("selects the existing development launcher for supported hosts", () => {
  expect(developmentWorkerScript("win32", "x64")).toBe("./dev-windows-worker.ts");
  expect(developmentWorkerScript("win32", "arm64")).toBe("./dev-windows-worker.ts");
  expect(developmentWorkerScript("darwin", "arm64")).toBe("./dev-mac-worker.ts");
  expect(developmentWorkerScript("linux", "x64")).toBe("./dev-linux-worker.ts");
  expect(developmentWorkerScript("linux", "arm64")).toBe("./dev-linux-worker.ts");
});

test("rejects hosts without a development launcher", () => {
  expect(() => developmentWorkerScript("linux", "riscv64")).toThrow("unsupported on linux/riscv64");
  expect(() => developmentWorkerScript("darwin", "x64")).toThrow("unsupported on darwin/x64");
});
