import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/profiler.ts"],
  bundle: true,
  outfile: "./compiled/profiler.js",
  format: "esm",
  minify: true,
  sourcemap: false,
  target: "es2022",
});

console.log("✅ Build complete!");
