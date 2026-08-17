/**
 * Assemble the bundled dsh runtime under src-tauri/.
 *
 *   binaries/dsh-node-<target-triple>   the Node binary the app spawns (Tauri sidecar)
 *   runtime/dsh/node_modules/…          a real node_modules tree, not a single-file exe:
 *                                       `dsh plugin add` shells out to pnpm and installs
 *                                       into the profile, which needs real packages on disk
 *   runtime/pnpm/…                      that pnpm, so the app never needs one on PATH
 *   resources/dsh-version.txt           idempotency marker + what the About box reports
 *
 * Re-running is cheap: everything is skipped when the marker already matches.
 * Set DSH_RUNTIME_FORCE=1 to rebuild anyway.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const DSH_VERSION = process.env.DSH_VERSION ?? "0.1.0-rc.6";
const NODE_VERSION = process.env.DSH_NODE_VERSION ?? "24.19.0";
const PNPM_VERSION = process.env.DSH_PNPM_VERSION ?? "11.22.0";

/* 只接 DeepSeek provider，但删掉别家 SDK 前得先确认 dsh 的 llm 插件不是静态 import
   （Stage 1 用 module load list 实测）。在那之前默认保留，宁可多 23M 也不要开不了机。 */
const PRUNE_PROVIDERS = process.env.DSH_PRUNE_PROVIDERS === "1";

const root = resolve(import.meta.dirname, "..");
const binariesDir = join(root, "src-tauri", "binaries");
const runtimeDir = join(root, "src-tauri", "runtime");
const dshDir = join(runtimeDir, "dsh");
const pnpmDir = join(runtimeDir, "pnpm");
const markerFile = join(root, "src-tauri", "resources", "dsh-version.txt");

const NODE_PLATFORMS = {
  "darwin-arm64": ["darwin-arm64", "tar.gz", "aarch64-apple-darwin"],
  "darwin-x64": ["darwin-x64", "tar.gz", "x86_64-apple-darwin"],
  "linux-arm64": ["linux-arm64", "tar.gz", "aarch64-unknown-linux-gnu"],
  "linux-x64": ["linux-x64", "tar.gz", "x86_64-unknown-linux-gnu"],
  "win32-arm64": ["win-arm64", "zip", "aarch64-pc-windows-msvc"],
  "win32-x64": ["win-x64", "zip", "x86_64-pc-windows-msvc"],
};

const spec = NODE_PLATFORMS[`${process.platform}-${process.arch}`];
if (!spec) throw new Error(`Unsupported build platform: ${process.platform}-${process.arch}`);
const [nodePlatform, nodeArchiveExtension, target] = spec;
const isWindows = process.platform === "win32";
const nodeBinary = join(binariesDir, `dsh-node-${target}${isWindows ? ".exe" : ""}`);
const marker = `dsh ${DSH_VERSION}\nnode ${NODE_VERSION}\npnpm ${PNPM_VERSION}\n`;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function upToDate() {
  if (process.env.DSH_RUNTIME_FORCE === "1") return false;
  const recorded = await readFile(markerFile, "utf8").catch(() => null);
  if (recorded !== marker) return false;
  return (
    (await exists(nodeBinary)) &&
    (await exists(join(dshDir, "node_modules", "@deepseek-ai", "dsh", "package.json"))) &&
    (await exists(join(pnpmDir, "node_modules", "pnpm", "bin", "pnpm.cjs")))
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function downloadNode(work) {
  const directory = `node-v${NODE_VERSION}-${nodePlatform}`;
  const asset = `${directory}.${nodeArchiveExtension}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  process.stdout.write(`Downloading ${asset}…\n`);
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetch(`${base}/${asset}`),
    fetch(`${base}/SHASUMS256.txt`),
  ]);
  if (!archiveResponse.ok) throw new Error(`Download failed: ${archiveResponse.status} ${asset}`);
  if (!checksumResponse.ok) throw new Error(`Checksum download failed: ${checksumResponse.status}`);

  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const expected = (await checksumResponse.text())
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${asset}`))
    ?.trim()
    .split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum published for ${asset}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}`);

  const archivePath = join(work, asset);
  await writeFile(archivePath, archive);
  if (nodeArchiveExtension === "zip") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      "Expand-Archive",
      "-LiteralPath",
      archivePath,
      "-DestinationPath",
      work,
    ]);
  } else {
    run("tar", ["-xzf", archivePath, "-C", work]);
  }

  const source = isWindows
    ? join(work, directory, "node.exe")
    : join(work, directory, "bin", "node");
  await mkdir(binariesDir, { recursive: true });
  await rm(nodeBinary, { force: true });
  await cp(source, nodeBinary);
  if (!isWindows) {
    await chmod(nodeBinary, 0o755);
    /* 官方二进制带着完整符号表，strip 掉省 ~20M；失败不致命（Linux strip 参数不同） */
    spawnSync("strip", ["-S", "-x", nodeBinary], { stdio: "ignore" });
    /* strip 会作废 Mach-O 的代码签名，Apple Silicon 上未签名二进制直接被 SIGKILL。
       补一个 ad-hoc 签名让开发期能跑；发版签名/公证在打包阶段统一做。 */
    if (process.platform === "darwin") {
      run("codesign", ["--force", "--sign", "-", nodeBinary], { stdio: "ignore" });
    }
  }

  const check = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  if (check.status !== 0 || check.stdout.trim() !== `v${NODE_VERSION}`) {
    throw new Error(`Bundled Node failed verification: ${check.stderr || check.stdout}`);
  }
  process.stdout.write(`Node ${NODE_VERSION} installed at ${nodeBinary}\n`);
}

/** 装成独立的 node_modules 树；--ignore-scripts 因为构建机没有 CMake，
    而 dsh 的原生依赖（koffi / node-pty）都带 prebuilt，不需要现场编译。 */
async function installPackage(directory, packageSpec) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: `dsh-gui-${basename(directory)}-bundle`, private: true, version: "0.0.0" }, null, 2)}\n`
  );
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", packageSpec], {
    cwd: directory,
  });
}

const PRUNE_FILE = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i;
// 按目录名删是陷阱：yaml/dist/doc 和 @modelcontextprotocol/sdk 的 dist/esm/examples
// 都是运行时代码。只有 .github 能凭名字确定是死的，其余靠扩展名判断。
const PRUNE_DIR = new Set([".github"]);
const PRUNE_PACKAGE = ["@mistralai", "@google/genai", "openai"];

/** 删掉运行时用不到的东西。只碰可证明是死重量的：sourcemap、类型声明、
    文档文件、别的平台的 prebuild。 */
async function prune(directory) {
  let removed = 0;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIR.has(entry.name.toLowerCase())) {
          removed += await sizeOf(path);
          await rm(path, { recursive: true, force: true });
          continue;
        }
        /* node-pty 的 prebuilds/ 每个平台一份，Windows 两份就占 58M */
        if (entry.name === "prebuilds") {
          for (const platform of await readdir(path, { withFileTypes: true }).catch(() => [])) {
            if (platform.name === `${process.platform}-${process.arch}`) continue;
            const stale = join(path, platform.name);
            removed += await sizeOf(stale);
            await rm(stale, { recursive: true, force: true });
          }
          continue;
        }
        await walk(path);
      } else if (PRUNE_FILE.test(entry.name)) {
        removed += await sizeOf(path);
        await rm(path, { force: true });
      }
    }
  }
  await walk(directory);

  if (PRUNE_PROVIDERS) {
    for (const name of PRUNE_PACKAGE) {
      const path = join(directory, "node_modules", ...name.split("/"));
      if (!(await exists(path))) continue;
      removed += await sizeOf(path);
      await rm(path, { recursive: true, force: true });
    }
  }
  return removed;
}

async function sizeOf(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    total += entry.isDirectory() || entry.isFile() ? await sizeOf(join(path, entry.name)) : 0;
  }
  return total;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

if (await upToDate()) {
  process.stdout.write(`dsh runtime ${DSH_VERSION} already installed\n`);
  process.exit(0);
}

await rm(markerFile, { force: true });
const work = await mkdtemp(join(tmpdir(), "dsh-gui-runtime-"));
try {
  if (!(await exists(nodeBinary))) await downloadNode(work);

  process.stdout.write(`Installing @deepseek-ai/dsh@${DSH_VERSION}…\n`);
  await installPackage(dshDir, `@deepseek-ai/dsh@${DSH_VERSION}`);

  process.stdout.write(`Installing pnpm@${PNPM_VERSION} (for \`dsh plugin add\`)…\n`);
  await installPackage(pnpmDir, `pnpm@${PNPM_VERSION}`);

  const freed = (await prune(dshDir)) + (await prune(pnpmDir));
  process.stdout.write(`Pruned ${megabytes(freed)} of sourcemaps, type declarations, docs and foreign prebuilds\n`);

  await mkdir(join(root, "src-tauri", "resources"), { recursive: true });
  await writeFile(markerFile, marker);
  process.stdout.write(
    `Runtime ready: ${megabytes(await sizeOf(dshDir))} dsh + ${megabytes(await sizeOf(pnpmDir))} pnpm + ${megabytes(await sizeOf(nodeBinary))} node\n`
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
