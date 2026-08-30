import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const staging = resolve(root, "artifacts", "connector-package");
const archive = resolve(root, "artifacts", "yurupager-connector.tgz");

await rm(staging, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(resolve(staging, "dist"), { recursive: true });
await mkdir(resolve(staging, "dist", "src"), { recursive: true });
await mkdir(resolve(staging, "vendor", "shared"), { recursive: true });
for (const directory of ["codex", "connector", "preview", "reliability", "transport"]) {
  await cp(
    resolve(root, "dist", "src", directory),
    resolve(staging, "dist", "src", directory),
    { recursive: true },
  );
}
await cp(
  resolve(root, "packages", "shared", "dist"),
  resolve(staging, "vendor", "shared", "dist"),
  { recursive: true },
);
await writeFile(resolve(staging, "vendor", "shared", "package.json"), `${JSON.stringify({
  name: "@yurupager/shared",
  version: "0.1.0",
  private: true,
  type: "module",
  exports: "./dist/index.js",
  types: "./dist/index.d.ts",
}, null, 2)}\n`);
await writeFile(resolve(staging, "package.json"), `${JSON.stringify({
  name: "@yurupager/connector",
  version: "0.2.0-alpha",
  private: true,
  type: "module",
  bin: { yurupager: "dist/src/connector/main.js" },
  engines: { node: ">=22" },
  dependencies: { "@yurupager/shared": "file:vendor/shared", ws: "^8.18.3" },
}, null, 2)}\n`);
await run("tar", ["-czf", archive, "-C", staging, "."]);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}
