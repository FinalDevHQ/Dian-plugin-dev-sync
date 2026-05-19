import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
  PKG_VERSION = pkg.version ?? "0.0.0";
} catch {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
    PKG_VERSION = pkg.version ?? "0.0.0";
  } catch { /* 使用默认 */ }
}

export { PKG_VERSION };
