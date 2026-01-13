#!/usr/bin/env bun

import { $ } from "bun";
import path from "path";
import fs from "fs";

import pkg from "../package.json";
import { getTargetName, targetpackageName, targets } from "./bunup-builds";
import { buildTargets } from "./build";

const dir = path.resolve(import.meta.dir, "..");
$.cwd(dir);

const args = Bun.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mainOnly = args.includes("--main-only");
const versionArg = args.find((arg) => !arg.startsWith("--"));
// Append a prerelease suffix during dry runs to avoid "already published" errors
const version = dryRun && versionArg ? `${versionArg}-dry-run.${Date.now()}` : versionArg;
let publishDelayMs = 0;

if (!version) {
  console.error("Usage: bun run scripts/publish.ts <version> [--dry-run] [--main-only]");
  process.exit(1);
}

const repoDotenvPath = path.join(dir, ".env");
const repoNpmrcPath = path.join(dir, ".npmrc");

function getFlagValue(flag: string): string | undefined {
  const full = `--${flag}`;
  const eqPrefix = `${full}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === full) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) return next;
      return;
    }
    if (arg.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
  }
  return;
}

function loadDotenvIfPresent(dotenvPath: string) {
  if (!fs.existsSync(dotenvPath)) return;
  try {
    const content = fs.readFileSync(dotenvPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Ignore dotenv read/parse errors
  }
}

loadDotenvIfPresent(repoDotenvPath);
publishDelayMs = Math.max(0, Number(process.env.PUBLISH_DELAY_MS ?? "2000")) || 0;

// Ensure npm commands (publish/view/etc.) use this repo's `.npmrc` (which expects `NPM_TOKEN`)
// even when we `cwd` into `dist/*`. Only do this when `NPM_TOKEN` is available so we don't
// override a user's global npm auth config unnecessarily.
if (
  process.env.NPM_TOKEN &&
  !process.env.NPM_CONFIG_USERCONFIG &&
  fs.existsSync(repoNpmrcPath)
) {
  process.env.NPM_CONFIG_USERCONFIG = repoNpmrcPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(error: unknown): boolean {
  const stderr = (error as any)?.stderr;
  const message = (error as any)?.message;
  const combined = `${stderr ?? ""}\n${message ?? ""}`.toLowerCase();
  return combined.includes("e429") || combined.includes("too many requests") || combined.includes("rate limited");
}

async function publishWithRetry(targetPath: string): Promise<void> {
  const maxRetries = 6;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (dryRun) {
        await $`npm publish --access public --dry-run --tag dry-run`.cwd(targetPath);
      } else {
        await $`npm publish --access public`.cwd(targetPath);
      }
      return;
    } catch (error) {
      if (!isRateLimited(error) || attempt === maxRetries) throw error;

      // Exponential-ish backoff with jitter, capped at 10 minutes.
      const baseMs = 30_000;
      const delayMs = Math.min(10 * 60_000, baseMs * 2 ** attempt);
      const jitterMs = Math.floor(Math.random() * 5_000);
      const waitMs = delayMs + jitterMs;
      console.log(`⏳ npm rate limited; retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }
}

async function hasNpmAuth(): Promise<boolean> {
  if (process.env.NPM_TOKEN) return true;
  try {
    const output = await $`npm whoami`.text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

if (!dryRun && !(await hasNpmAuth())) {
  console.error("Not authenticated with npm.");
  console.error("Either set NPM_TOKEN (env or .env) or run `npm login`, then retry:");
  console.error(`  bun run scripts/publish.ts ${version}`);
  process.exit(1);
}

async function isPublished(name: string, targetVersion: string) {
  try {
    const output = await $`npm view ${name} version`.text();
    return output.trim() === targetVersion;
  } catch {
    return false;
  }
}

console.log(`\n🚀 Publishing ${pkg.name} v${version}${dryRun ? " (DRY RUN)" : ""}\n`);
console.log("─".repeat(50));

if (dryRun) {
  console.log("⚠️  Dry run mode: no packages will be published to npm\n");
}

let binaries: Record<string, string> = {};

if (mainOnly) {
  const binariesVersion =
    getFlagValue("binaries-version") ?? process.env.BINARIES_VERSION ?? version;
  for (const target of targets) {
    const name = getTargetName(target);
    const pkgName = name.replace(targetpackageName, pkg.name);
    binaries[pkgName] = binariesVersion;
  }
  console.log(
    `\n🧩 Main-only mode: using existing platform packages at v${binariesVersion}\n`
  );
} else {
  // Build all platforms
  binaries = await buildTargets(version);
}

if (!mainOnly) {
  // Smoke test on current platform
  const currentPlatform = process.platform === "win32" ? "windows" : process.platform;
  const currentArch = process.arch;
  const currentPackage = `${targetpackageName}-${currentPlatform}-${currentArch}`;
  const binaryExt = process.platform === "win32" ? ".exe" : "";
  const binaryPath = `./dist/${currentPackage}/bin/${targetpackageName}${binaryExt}`;

  if (fs.existsSync(binaryPath)) {
    console.log(`\n🧪 Running smoke test: ${binaryPath} --version`);
    try {
      await $`${binaryPath} --version`;
      console.log("   ✅ Smoke test passed");
    } catch (error) {
      console.error("   ❌ Smoke test failed:", error);
      process.exit(1);
    }
  } else {
    console.log(`\n⚠️  Skipping smoke test (no binary for current platform: ${currentPackage})`);
  }
}

// Prepare main package
console.log("\n📁 Preparing main package...");

await $`rm -rf ./dist/${targetpackageName}`;
await $`mkdir -p ./dist/${targetpackageName}/bin`;
await $`mkdir -p ./dist/${targetpackageName}/assets`;
await $`cp -r ./bin ./dist/${targetpackageName}/`;
await $`cp scripts/postinstall.mjs dist/${targetpackageName}/postinstall.mjs`;
await $`cp README.md dist/${targetpackageName}/README.md`;
await $`cp -r assets/images dist/${targetpackageName}/assets/`;

await Bun.file(`./dist/${targetpackageName}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      version,
      description: pkg.description,
      bin: { [targetpackageName]: `bin/${targetpackageName}.mjs` },
      scripts: { postinstall: "node ./postinstall.mjs" },
      optionalDependencies: binaries,
      repository: pkg.repository,
      homepage: pkg.homepage,
      bugs: pkg.bugs,
      keywords: pkg.keywords,
      author: pkg.author,
      license: pkg.license,
      // engines: pkg.engines,
    },
    null,
    2
  )
);

console.log("✅ Main package prepared");

if (!mainOnly) {
  // Publish platform packages
  console.log("\n📤 Publishing platform packages...");

  for (const [name] of Object.entries(binaries)) {
    const targetPath = path.join(dir, "dist", name.replace(pkg.name, targetpackageName));

    if (process.platform !== "win32") {
      await $`chmod -R 755 .`.cwd(targetPath);
    }

    await $`mkdir -p ${path.join(targetPath, "assets")}`;
    await $`cp -r assets/images ${path.join(targetPath, "assets/")}`;

    if (!dryRun && (await isPublished(name, version))) {
      console.log(`⏭️  Skipping ${name} (already published)`);
    } else {
      await publishWithRetry(targetPath);
      console.log(`${dryRun ? "✅ Would publish" : "✅ Published"} ${name}`);
    }

    if (!dryRun && publishDelayMs > 0) {
      await sleep(publishDelayMs);
    }
  }
}

// Publish main package
console.log("\n📤 Publishing main package...");

const mainPackagePath = path.join(dir, "dist", targetpackageName);
if (!dryRun && (await isPublished(pkg.name, version))) {
  console.log(`⏭️  Skipping ${pkg.name} (already published)`);
} else {
  await publishWithRetry(mainPackagePath);
  console.log(`${dryRun ? "✅ Would publish" : "✅ Published"} ${pkg.name}`);
}

// Summary
console.log(`\n${"─".repeat(50)}`);
console.log(`\n✅ ${dryRun ? "Dry run" : "Publish"} complete!\n`);
console.log(`Version: ${version}`);
console.log(`Packages: ${Object.keys(binaries).length + 1}`);
