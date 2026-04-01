import esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["src/profiler.ts"],
  bundle: true,
  outfile: "./compiled/profiler.js",
  format: "esm",
  sourcemap: true,
  target: "es2022",
});

await ctx.watch();

const { host, port } = await ctx.serve({
  servedir: "compiled",
  port: 3000,
});

console.log(`🎮 Dev server: http://localhost:${port}`);
