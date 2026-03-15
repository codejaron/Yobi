import { rm } from "node:fs/promises";

const targets = [
  "out/src/main",
  "out/tsconfig.node.tsbuildinfo"
];

await Promise.all(
  targets.map((target) =>
    rm(target, {
      recursive: true,
      force: true
    })
  )
);
