import { build } from "esbuild";

/**
 * Bundles a TypeScript entry point and imports it as an ES module.
 *
 * The existing integrity tests transpile a single file, which works only while
 * cross-module imports are type-only. The audra modules import each other at
 * runtime, so they need a real bundle step.
 */
export async function loadTsBundle(entryPath, platform = "neutral") {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform,
    external: platform === "node" ? ["node:zlib"] : [],
    target: "es2022",
    write: false,
    logLevel: "silent"
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
