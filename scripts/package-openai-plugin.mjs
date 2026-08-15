import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins/operate");
const manifest = JSON.parse(
  readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
);
const artifacts = resolve(root, "artifacts");
const archiveName = `operate-plugin-${manifest.version}.zip`;
const archive = resolve(artifacts, archiveName);
const checksumFile = `${archive}.sha256`;
const stagingParent = mkdtempSync(join(tmpdir(), "operate-plugin-"));
const stagingRoot = join(stagingParent, "package");
const fixedTime = new Date("1980-01-01T00:00:00.000Z");

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(absolute));
    else if (entry.isFile()) files.push(relative(stagingRoot, absolute));
  }
  return files.sort();
}

function fixTimes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) fixTimes(absolute);
    utimesSync(absolute, fixedTime, fixedTime);
  }
  utimesSync(directory, fixedTime, fixedTime);
}

mkdirSync(artifacts, { recursive: true });
rmSync(archive, { force: true });
rmSync(checksumFile, { force: true });

try {
  cpSync(pluginRoot, stagingRoot, { recursive: true });
  fixTimes(stagingRoot);
  const files = filesUnder(stagingRoot);
  const zip = spawnSync("zip", ["-X", "-q", archive, ...files], {
    cwd: stagingRoot,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });
  if (zip.status !== 0) throw new Error(zip.stderr || "zip failed");

  const checksum = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync(checksumFile, `${checksum}  ${archiveName}\n`);

  const size = statSync(archive).size;
  console.log(`${archive}\nsha256 ${checksum}\nbytes ${size}\nfiles ${files.length}`);
} finally {
  rmSync(stagingParent, { recursive: true, force: true });
}
