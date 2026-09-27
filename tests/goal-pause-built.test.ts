import { expect, test } from "bun:test";
import { join } from "node:path";

test.each([
  "resume-during-pause",
  "user-pause-during-release",
  "model-during-pause",
  "shared-lock",
  "transition-shape",
])(
  "built OLW extension shares native goal mutation ownership: %s",
  async (mode) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/goal-pause-race.ts"), mode],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({ mode, passed: true, importer: "native" });
    } finally {
      clearTimeout(timer);
    }
  },
  15000,
);
