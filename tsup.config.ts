import { defineConfig } from "tsup";

/**
 * ─── 关于 @dian/plugin-runtime 是否打包进 bundle ─────────────────────────────
 *
 * 默认配置把 @dian/plugin-runtime **打包进** dist/index.js（noExternal），
 * 让插件成为单文件可移植产物，方便 ZIP 分发到任何 Dian 实例。
 *
 * 这对绝大多数用户插件都是正确选择，因为：
 *   - 装饰器（@Plugin / @Handler / @Interceptor）只往插件类上写元数据，
 *     元数据 key 用 Symbol.for("dian:plugin") 跨 bundle 共享，所以即使
 *     每个插件 bundle 里都内联了一份 decorators 实现，也不影响宿主读取。
 *   - 类型 / 接口（EventContext、PluginSetupContext 等）只参与编译期检查，
 *     运行时被擦除，无副作用。
 *
 * ⚠️ **特殊情况：当你的插件需要访问 runtime 单例**（例如 `pluginManager`），
 * 必须把 @dian/plugin-runtime **改为 external**：
 *
 *     // ❌ 错误：会让插件拿到自己 bundle 里的另一份空单例
 *     noExternal: ["@dian/plugin-runtime"]
 *
 *     // ✅ 正确：让 Node 在运行时解析到宿主进程使用的那份 runtime
 *     external:   ["@dian/plugin-runtime"]
 *
 * 哪些 API 受此影响（必须 external）：
 *   - `pluginManager.listPluginsMeta()`  列出所有已注册插件
 *   - `pluginManager.plugins`            读取已加载插件实例
 *   - `pluginManager.dispatch(...)`      手动派发事件
 *   - 任何**直接对 pluginManager 单例进行读 / 写**的调用
 *
 * 换言之：只用装饰器和 onSetup ctx 的插件保留默认 noExternal 即可；一旦你 import
 * 了 `pluginManager`，就把它从 noExternal 移到 external，否则会出现"看似正常运行
 * 但读不到任何状态"的隐蔽 bug（参考 Dian-plugin-help 的修复历史）。
 *
 * reflect-metadata 是幂等的全局 polyfill（写入 globalThis.Reflect），
 * 重复加载无副作用，保留 noExternal 让插件单文件可分发。
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,

  // 默认：把 runtime 打进 bundle，单文件可移植。
  // 若插件用到 pluginManager 单例，请改为下方注释里的 external 配置。
  noExternal: ["@dian/plugin-runtime", "reflect-metadata"],
  // external: ["@dian/plugin-runtime"],
  // noExternal: ["reflect-metadata"],

  // UI 由 Vite 单独构建到 dist/public/，此处无需 cpSync
});
