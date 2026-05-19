import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PluginConfig {
  token: string;
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
}

export const DEFAULT_CONFIG: PluginConfig = { token: "", port: 3901, host: "127.0.0.1" };
const CONFIG_PATH = resolve(__dirname, "config.json");

export function loadConfig(): PluginConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginConfig>;
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (e) {
    console.warn("[dian-dev-sync] failed to load config:", e);
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(cfg: PluginConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
