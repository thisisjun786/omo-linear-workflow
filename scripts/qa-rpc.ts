import { z } from "zod";

const frameSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    success: z.boolean().optional(),
    error: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export class QaError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "QaError";
  }
}

export function startQaRpc(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const process = Bun.spawn([...argv], {
    cwd,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<(event: unknown) => void>();
  const stderr = new Response(process.stderr).text();
  let sequence = 0;
  let failure: Error | undefined;
  const stream = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const raw: unknown = JSON.parse(line);
        const frame = frameSchema.parse(raw);
        if (frame.type !== "response" || !frame.id) {
          for (const listener of listeners) listener(raw);
          continue;
        }
        const request = pending.get(frame.id);
        if (!request) continue;
        pending.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.success === false) request.reject(new QaError(frame.error ?? line));
        else request.resolve(frame.data);
      }
    }
  })().catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });

  return {
    request(command: Readonly<Record<string, unknown>>, timeoutMs = 30000): Promise<unknown> {
      if (failure) return Promise.reject(failure);
      const id = `qa-${++sequence}`;
      const result = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        result.reject(new QaError(`RPC request timed out: ${String(command["type"])}`));
      }, timeoutMs);
      pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
      process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      process.stdin.flush();
      return result.promise;
    },
    onEvent(listener: (event: unknown) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close(): Promise<string> {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new QaError("QA RPC closed"));
      }
      pending.clear();
      process.kill("SIGTERM");
      await process.exited;
      await stream;
      const diagnostics = await stderr;
      console.log(`CLEANUP: QA RPC process ${process.pid} exited`);
      return diagnostics;
    },
  };
}
