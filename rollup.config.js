import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

/**
 * Three entry points, so importing the engine does not drag in things a
 * serverless bundle has no use for.
 *
 *   .           the call itself. Needs no filesystem, no HTTP server, no ws.
 *   ./recorder  writes audio and transcripts, so it needs node:fs.
 *   ./simulator the browser phone, so it needs an HTTP server and ws.
 *
 * Keeping them apart matters where cold start is charged by the millisecond:
 * an agent running in a function should not be paying to parse a dev tool.
 */
const external = ["ws", /^node:/];
const plugins = [typescript({ tsconfig: "./tsconfig.json" }), resolve(), commonjs()];

const entry = (name, input) => [
  {
    input,
    output: { file: `dist/${name}.mjs`, format: "esm", sourcemap: true },
    external,
    plugins,
  },
  {
    input,
    output: { file: `dist/${name}.cjs`, format: "cjs", sourcemap: true },
    external,
    plugins,
  },
];

export default [
  ...entry("index", "src/index.ts"),
  ...entry("recorder", "src/recorder.ts"),
  ...entry("simulator", "src/simulator.ts"),
];
