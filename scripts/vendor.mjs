#!/usr/bin/env node
/**
 * Vendor the engine source into the daytona-service repo — the copy the
 * sidecar installer writes into every project VM ("the engine lives inside
 * the Daytona sandbox").
 *
 *   node scripts/vendor.mjs [targetDir]
 *
 * Default target: ../Arcforge-backend/daytona-service/app/engine_sidecar
 * (relative to this repo's root — adjust when the repos are laid out
 * differently).
 *
 * What is copied (the exact runtime surface the in-VM engine needs):
 *   src/*.js            — the engine itself
 *   package.json        — deps (express + the prime-agent GitHub tarball;
 *                         the VM's npm resolves them directly — the EU
 *                         egress filter allows registry.npmjs.org and
 *                         github.com release downloads, verified live)
 *   vendor/*.tgz        — the 3 prime-agent component tarballs that only
 *                         exist on Cloudflare R2 (pub-*.r2.dev — BLOCKED
 *                         by the EU egress filter, ECONNRESET verified
 *                         live). package.json "overrides" points
 *                         @earendil-works/{pi-agent-core,pi-ai,pi-tui}
 *                         at these local file: refs so the in-VM npm
 *                         install never dials R2.
 *   .prime-agent/models.json — the provider registry (incl. the vm-tunnel
 *                         provider the in-VM engine uses)
 *   .prime/prompts/*.md — the persona profiles (Vube pillar 4). BUG FIX
 *                         2026-09-04: these were NEVER vendored, so every
 *                         in-VM engine booted with ZERO personas — the
 *                         chief ran without its doctrine and orchestrate
 *                         rejected every persona key. This is why the
 *                         Vube spec appeared "not working" in production
 *                         while the host engine (deployed from this repo
 *                         directly) had all 7 personas.
 *
 * NOT copied: node_modules (installed in-VM per VM), probe/, README,
 * .prime-agent/auth.json (created fresh in the VM), workspace/ leftovers.
 *
 * Sync policy: re-run after every engine change that must reach new VMs,
 * then commit the daytona-service repo. Deploy-atomic, no runtime
 * downloads, no tokens.
 */
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const engineRoot = resolve(new URL("..", import.meta.url).pathname);
const target =
  process.argv[2] ?? resolve(engineRoot, "..", "Arcforge-backend", "daytona-service", "app", "engine_sidecar");

const srcDir = join(engineRoot, "src");
const pkg = join(engineRoot, "package.json");
const models = join(engineRoot, ".prime-agent", "models.json");
const vendorDir = join(engineRoot, "vendor");
const promptsDir = join(engineRoot, ".prime", "prompts");

for (const [label, path] of [["src/", srcDir], ["package.json", pkg], [".prime-agent/models.json", models], ["vendor/", vendorDir], [".prime/prompts/", promptsDir]]) {
  if (!existsSync(path)) {
    console.error(`[vendor] missing ${label} at ${path} — run from the engine repo root`);
    process.exit(1);
  }
}

mkdirSync(target, { recursive: true });
rmSync(join(target, "src"), { recursive: true, force: true });
rmSync(join(target, ".prime-agent"), { recursive: true, force: true });
rmSync(join(target, "vendor"), { recursive: true, force: true });
rmSync(join(target, ".prime"), { recursive: true, force: true });

cpSync(srcDir, join(target, "src"), { recursive: true });
cpSync(pkg, join(target, "package.json"));
mkdirSync(join(target, ".prime-agent"), { recursive: true });
cpSync(models, join(target, ".prime-agent", "models.json"));
cpSync(promptsDir, join(target, ".prime", "prompts"), { recursive: true });
cpSync(vendorDir, join(target, "vendor"), { recursive: true });

const files = [];
const walk = (dir, prefix = "") => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
    else files.push(`${prefix}${name}`);
  }
};
walk(target);
console.log(`[vendor] engine vendored → ${target}`);
for (const f of files) console.log(`  ${f}`);
