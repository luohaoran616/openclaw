import { spawnSync } from "node:child_process";

const result = spawnSync("tsc", ["-p", "tsconfig.plugin-sdk.dts.json"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

if (typeof result.status === "number" && result.status !== 0) {
  console.warn(
    "[build-plugin-sdk-dts] Type declaration generation reported errors; continuing for runtime builds.",
  );
}
