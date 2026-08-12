import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins/operate");
const manifest = JSON.parse(
  readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
);
const artifacts = resolve(root, "artifacts");
const archive = resolve(artifacts, `operate-plugin-${manifest.version}.zip`);
const checksumFile = `${archive}.sha256`;

mkdirSync(artifacts, { recursive: true });
rmSync(archive, { force: true });
rmSync(checksumFile, { force: true });

const zip = spawnSync(
  "zip",
  ["-X", "-q", "-r", archive, ".", "-x", "*.DS_Store"],
  { cwd: pluginRoot, encoding: "utf8" },
);
if (zip.status !== 0) {
  throw new Error(zip.stderr || "zip failed");
}

const checksum = createHash("sha256")
  .update(readFileSync(archive))
  .digest("hex");
writeFileSync(
  checksumFile,
  `${checksum}  ${archive.split("/").at(-1)}\n`,
);
console.log(`${archive}\nsha256 ${checksum}`);
