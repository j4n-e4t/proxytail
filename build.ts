// Compiles the server and the bundled frontend into one self-contained executable.
// Usage: bun run build.ts [bun-linux-x64 | bun-linux-arm64 | ...]  (defaults to the host platform)
import tailwind from "bun-plugin-tailwind";

const target = process.argv[2] as Bun.Build.CompileTarget | undefined;
const outfile = process.env.OUTFILE ?? "dist/proxytail";

const result = await Bun.build({
  // The access log stats worker is a separate entrypoint, loaded by path at runtime.
  entrypoints: ["./src/main.ts", "./src/accesslog-worker.ts"],
  compile: target ? { target, outfile } : { outfile },
  plugins: [tailwind],
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile} (${target ?? "host platform"})`);
