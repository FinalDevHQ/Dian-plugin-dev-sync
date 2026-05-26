/**
 * 生成插件索引条目
 *
 * 用法：
 *   node scripts/index-entry.mjs                    # 输出 JSON 到终端
 *   node scripts/index-entry.mjs --changelog "xxx"  # 带 changelog notes
 *   node scripts/index-entry.mjs --update <path>    # 直接更新索引库的 index.json
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const changelogIdx = args.indexOf("--changelog");
const changelogNotes = changelogIdx >= 0 ? args[changelogIdx + 1] : "";
const updateIdx = args.indexOf("--update");
const updatePath = updateIdx >= 0 ? args[updateIdx + 1] : null;

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

const name = pkg.name;
const version = pkg.version;
const description = pkg.description || "";
const author = pkg.author || "unknown";
const icon = pkg.icon || "🔌";
const hasUI = existsSync(resolve(process.cwd(), "public"));
const runtimeVersion = pkg.dependencies?.["@myfinal/plugin-runtime"]?.replace(/[\^~>=<]/g, "") || "0.2.7";

// 从 git remote 推断 homepage
let homepage = "";
try {
  const { execSync } = await import("node:child_process");
  const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (match) homepage = `https://github.com/${match[1]}`;
} catch { /* ignore */ }

const downloadUrl = homepage ? `${homepage}/releases/download/v${version}/${name}.zip` : "";
const today = new Date().toISOString().split("T")[0];

const entry = {
  name,
  displayName: name,
  description,
  version,
  author,
  icon,
  tags: [],
  hasUI,
  minRuntimeVersion: runtimeVersion,
  homepage,
  downloadUrl,
  changelog: [
    {
      version,
      date: today,
      notes: changelogNotes || "初始版本",
    },
  ],
};

if (updatePath) {
  const indexPath = resolve(updatePath);
  if (!existsSync(indexPath)) {
    console.error(`索引文件不存在: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const existing = index.plugins.findIndex((p) => p.name === name);
  if (existing >= 0) {
    index.plugins[existing] = { ...index.plugins[existing], ...entry };
  } else {
    index.plugins.push(entry);
  }
  index.updatedAt = today;
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`已更新 ${indexPath} 中的 ${name} v${version}`);
} else {
  console.log("\n将以下内容添加到 Dian-plugins/index.json 的 plugins 数组中:\n");
  console.log(JSON.stringify(entry, null, 2));
}
