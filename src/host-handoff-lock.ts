import { dlopen, FFIType, read } from "bun:ffi";
import { writeFile } from "node:fs/promises";

const O_RDWR = 2;
const O_CREAT = 64;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;
const HOST_HANDOFF_LOCK_TIMEOUT_MS = 50_000;

export interface HostHandoffLockDependencies {
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly flock: (fd: number, operation: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
  readonly writeOwner: (fd: number) => Promise<void>;
  readonly waitForLock: (fd: number, timeoutMs: number) => Promise<boolean>;
}

export class HostHandoffBusyError extends Error {
  public override readonly name = "HostHandoffBusyError";
  public readonly code = "host_handoff_busy";
  public constructor(public readonly timeoutMs: number) {
    super(`Another OLW entry still owns host handoff after ${timeoutMs}ms`);
  }
}

function lockFunctions(): Omit<HostHandoffLockDependencies, "writeOwner" | "waitForLock"> {
  const libc = dlopen(process.env["OLW_LIBC_PATH"] ?? "libc.so.6", {
    open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  return {
    open: libc.symbols.open,
    flock: libc.symbols.flock,
    close: libc.symbols.close,
    errno: () => {
      const pointer = libc.symbols.__errno_location();
      if (pointer === null) throw new Error("Could not read libc errno");
      return read.i32(pointer, 0);
    },
  };
}

const blockingFlockWorker = `
import { dlopen, FFIType } from "bun:ffi";
self.onmessage = (event) => {
  try {
    const libc = dlopen(event.data.libcPath, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    postMessage({ ok: libc.symbols.flock(event.data.fd, 2) === 0 });
  } catch (cause) {
    postMessage({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
`;

function waitForLock(fd: number, timeoutMs: number): Promise<boolean> {
  const worker = new Worker(URL.createObjectURL(new Blob([blockingFlockWorker])), { smol: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (cause === undefined) resolve(value);
      else reject(cause);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    worker.onmessage = (event: MessageEvent<{ readonly ok: boolean; readonly error?: string }>) => {
      if (event.data.ok) finish(true);
      else finish(false, new Error(event.data.error ?? "Could not acquire host handoff lock"));
    };
    worker.onerror = (event) => finish(false, event.error ?? new Error(event.message));
    worker.postMessage({ fd, libcPath: process.env["OLW_LIBC_PATH"] ?? "libc.so.6" });
  });
}

function defaultDependencies(): HostHandoffLockDependencies {
  return {
    ...lockFunctions(),
    writeOwner: (fd) => writeFile(`/proc/self/fd/${fd}`, `${process.pid}\n`),
    waitForLock,
  };
}

export async function withHostHandoffLock<T>(
  path: string,
  operation: () => Promise<T>,
  dependencies: HostHandoffLockDependencies = defaultDependencies(),
): Promise<T> {
  const fd = dependencies.open(new TextEncoder().encode(`${path}\0`), O_RDWR | O_CREAT, 0o600);
  if (fd < 0) throw new Error(`Could not open host handoff lock (errno ${dependencies.errno()})`);
  let acquired = false;
  const outcome = await (async () => {
    try {
      acquired = dependencies.flock(fd, LOCK_EX | LOCK_NB) === 0;
      if (!acquired) {
        if (dependencies.errno() !== EWOULDBLOCK)
          throw new Error(`Could not lock host handoff lock (errno ${dependencies.errno()})`);
        if (!(await dependencies.waitForLock(fd, HOST_HANDOFF_LOCK_TIMEOUT_MS)))
          throw new HostHandoffBusyError(HOST_HANDOFF_LOCK_TIMEOUT_MS);
        acquired = true;
      }
      await dependencies.writeOwner(fd);
      return { ok: true as const, value: await operation() };
    } catch (cause) {
      return { ok: false as const, cause };
    }
  })();
  const releaseErrors: Error[] = [];
  if (acquired && dependencies.flock(fd, LOCK_UN) !== 0)
    releaseErrors.push(
      new Error(`Could not unlock host handoff lock (errno ${dependencies.errno()})`),
    );
  if (dependencies.close(fd) !== 0)
    releaseErrors.push(
      new Error(`Could not close host handoff lock (errno ${dependencies.errno()})`),
    );
  if (!outcome.ok) {
    if (releaseErrors.length > 0)
      throw new AggregateError(
        [outcome.cause, ...releaseErrors],
        "Host handoff and lock release failed",
      );
    throw outcome.cause;
  }
  if (releaseErrors.length > 0)
    throw new AggregateError(releaseErrors, "Host handoff lock release failed");
  return outcome.value;
}
