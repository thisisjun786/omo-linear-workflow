import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

// Detached native helpers (notably the LSP daemon) outlive the host's process
// tree. Ownership comes from this world's unique cache/temp environment, never
// a process name or a global kill pattern.
export async function reapQaDaemons(scratch: string) {
  const owned: Array<{ pid: number; command: string; cwd: string; exited: boolean }> = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const environment = (await readFile(`/proc/${name}/environ`, "utf8")).split("\0");
      if (
        !environment.some(
          (item) =>
            item === `TMPDIR=${join(scratch, "tmp")}` ||
            item === `XDG_CACHE_HOME=${join(scratch, "xdg-cache")}`,
        )
      )
        continue;
      const command = (await readFile(`/proc/${name}/cmdline`, "utf8")).replaceAll("\0", " ");
      const cwd = await readlink(`/proc/${name}/cwd`);
      owned.push({ pid: Number(name), command, cwd, exited: false });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH" || error.code === "EACCES")
      )
        continue;
      throw error;
    }
  }
  for (const process of owned) {
    const reaper = Bun.spawn(
      [
        "python3",
        "-c",
        `import os,select,signal,sys\npid=int(sys.argv[1])\ntry: fd=os.pidfd_open(pid)\nexcept ProcessLookupError: sys.exit(0)\nsignal.pidfd_send_signal(fd,signal.SIGKILL)\np=select.poll();p.register(fd,select.POLLIN)\nif not p.poll(10000): raise RuntimeError('owned daemon did not exit')\nos.close(fd)`,
        String(process.pid),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([reaper.exited, new Response(reaper.stderr).text()]);
    if (code !== 0) throw new Error(`QA daemon ${process.pid}: ${stderr}`);
    process.exited = true;
  }
  return owned;
}

export async function qaTempFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await qaTempFiles(child)));
    else files.push(child);
  }
  return files;
}
