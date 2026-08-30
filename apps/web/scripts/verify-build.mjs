import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const configuredBase = process.env.YURUPAGER_WEB_BASE ?? "./";
const expectedAssetPrefix = configuredBase === "./" || configuredBase === ""
  ? "./assets/"
  : `${configuredBase.replace(/\/+$/, "")}/assets/`;
const assetPaths = [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((match) => match[1]);

if (assetPaths.length < 2 || assetPaths.some((path) => !path.startsWith(expectedAssetPrefix))) {
  throw new Error(
    `Web build asset paths do not match deployment base ${JSON.stringify(configuredBase)}: ${assetPaths.join(", ")}`,
  );
}
