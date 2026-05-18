/**
 * 将 dist/ 目录打包为可安装的 ZIP 文件（使用 fflate，纯 JS，跨平台）。
 * 用法：node scripts/pack.mjs
 */
import { zip } from "fflate";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
const pluginName = pkg.name;
const zipFile = `${pluginName}.zip`;

if (existsSync(zipFile)) unlinkSync(zipFile);

/**
 * 递归收集目录下所有文件，返回 { 相对路径: Buffer } 映射。
 * @param {string} dir  扫描目录
 * @param {string} base 相对于 ZIP 根的前缀
 * @returns {Record<string, Buffer>}
 */
function collectFiles(dir, base = "") {
  /** @type {Record<string, Buffer>} */
  const result = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      Object.assign(result, collectFiles(full, rel));
    } else {
      result[rel] = readFileSync(full);
    }
  }
  return result;
}

const files = collectFiles("./dist");

if (Object.keys(files).length === 0) {
  console.error("错误：dist/ 目录为空或不存在，请先执行 npm run build。");
  process.exit(1);
}

// 转换为 fflate 所需格式：{ 路径: [Uint8Array, options] }
/** @type {import("fflate").AsyncZippable} */
const zippable = {};
for (const [name, buf] of Object.entries(files)) {
  zippable[name] = [new Uint8Array(buf), { level: 6 }];
}

zip(zippable, (err, data) => {
  if (err) {
    console.error("打包失败：", err.message);
    process.exit(1);
  }
  writeFileSync(zipFile, data);
  console.log(`\n打包完成：${zipFile}`);
  console.log(`安装方法：`);
  console.log(`  - 推荐：在 Dian Web UI「插件」页点「上传插件」选择 ${zipFile}，框架会自动热加载，无需重启`);
  console.log(`  - 或手动：将 ${zipFile} 解压到 Dian 项目的 plugins/${pluginName}/ 目录，文件监听会自动识别新插件\n`);
});
