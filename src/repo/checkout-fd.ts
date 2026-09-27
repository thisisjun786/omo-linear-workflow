import { dlopen, FFIType, read } from "bun:ffi";
import { basename } from "node:path";

const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_DIRECTORY = 0o200000;
const O_NOFOLLOW = 0o400000;
const EEXIST = 17;
const ENOENT = 2;

export class CheckoutPathError extends Error {
  readonly code = "local_file_target_unsafe";
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CheckoutPathError";
  }
}

export interface CheckoutFileOperations {
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly openat: (fd: number, path: Uint8Array, flags: number, mode: number) => number;
  readonly mkdirat: (fd: number, path: Uint8Array, mode: number) => number;
  readonly renameat: (
    oldFd: number,
    oldPath: Uint8Array,
    newFd: number,
    newPath: Uint8Array,
  ) => number;
  readonly unlinkat: (fd: number, path: Uint8Array, flags: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
}

export interface CheckoutCopyOptions {
  readonly operations?: CheckoutFileOperations;
  readonly write?: (fd: number, contents: Uint8Array) => Promise<number>;
}

/** C0, DEL and C1 control characters (U+0000-U+001F, U+007F-U+009F). */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function cstring(value: string): Uint8Array {
  if (hasControlCharacter(value))
    throw new CheckoutPathError("Local file path contains a control character");
  return new TextEncoder().encode(`${value}\0`);
}

let processOperations: CheckoutFileOperations | undefined;
function functions(): CheckoutFileOperations {
  if (processOperations !== undefined) return processOperations;
  try {
    // Deliberately retained for the process lifetime: unloading would invalidate these cached symbols.
    const libc = dlopen(process.env["OLW_LIBC_PATH"] ?? "libc.so.6", {
      open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      renameat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
        returns: FFIType.i32,
      },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    processOperations = {
      open: libc.symbols.open,
      openat: libc.symbols.openat,
      mkdirat: libc.symbols.mkdirat,
      renameat: libc.symbols.renameat,
      unlinkat: libc.symbols.unlinkat,
      close: libc.symbols.close,
      errno: () => {
        const pointer = libc.symbols.__errno_location();
        if (pointer === null) throw new CheckoutPathError("Could not read libc errno");
        return read.i32(pointer, 0);
      },
    };
    return processOperations;
  } catch (cause) {
    throw new CheckoutPathError("Secure checkout file operations are unavailable", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function fail(operation: string, errno: number): CheckoutPathError {
  return new CheckoutPathError(`Secure local-file ${operation} failed`, { errno });
}
function typed(cause: unknown): CheckoutPathError {
  return cause instanceof CheckoutPathError
    ? cause
    : new CheckoutPathError("Secure local-file copy failed", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
}

/** Copy bytes using directory-descriptor-relative operations only. */
export async function copyIntoCheckout(
  checkoutPath: string,
  target: string,
  contents: Uint8Array,
  options: CheckoutCopyOptions = {},
): Promise<void> {
  const libc = options.operations ?? functions();
  const write = options.write ?? ((fd, bytes) => Bun.write(Bun.file(fd), bytes));
  const opened: number[] = [];
  const cleanup: Array<{ operation: string; errno: number }> = [];
  let temporary: string | undefined;
  let destinationFd: number | undefined;
  let parentFd: number | undefined;
  let primary: CheckoutPathError | undefined;
  try {
    parentFd = libc.open(cstring(checkoutPath), O_DIRECTORY | O_NOFOLLOW, 0);
    if (parentFd < 0) throw fail("root open", libc.errno());
    opened.push(parentFd);
    const parts = target.split("/");
    const destination = parts.pop();
    if (destination === undefined) throw new CheckoutPathError("Local file target is empty");
    for (const part of parts) {
      let next = libc.openat(parentFd, cstring(part), O_DIRECTORY | O_NOFOLLOW, 0);
      if (next < 0 && libc.errno() === ENOENT) {
        if (libc.mkdirat(parentFd, cstring(part), 0o700) !== 0 && libc.errno() !== EEXIST)
          throw fail("directory creation", libc.errno());
        next = libc.openat(parentFd, cstring(part), O_DIRECTORY | O_NOFOLLOW, 0);
      }
      if (next < 0) throw fail("directory traversal", libc.errno());
      opened.push(next);
      parentFd = next;
    }
    temporary = `.${basename(destination)}.olw-${crypto.randomUUID()}`;
    destinationFd = libc.openat(
      parentFd,
      cstring(temporary),
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      0o600,
    );
    if (destinationFd < 0) throw fail("temporary creation", libc.errno());
    await write(destinationFd, contents);
    const closing = destinationFd;
    destinationFd = undefined;
    if (libc.close(closing) !== 0) throw fail("temporary close", libc.errno());
    if (libc.renameat(parentFd, cstring(temporary), parentFd, cstring(destination)) !== 0)
      throw fail("publication", libc.errno());
    temporary = undefined;
  } catch (cause) {
    primary = typed(cause);
  } finally {
    if (destinationFd !== undefined) {
      const closing = destinationFd;
      destinationFd = undefined;
      if (libc.close(closing) !== 0)
        cleanup.push({ operation: "temporary close", errno: libc.errno() });
    }
    if (
      temporary !== undefined &&
      parentFd !== undefined &&
      libc.unlinkat(parentFd, cstring(temporary), 0) !== 0
    )
      cleanup.push({ operation: "temporary unlink", errno: libc.errno() });
    while (opened.length > 0) {
      const closing = opened.pop();
      if (closing !== undefined && libc.close(closing) !== 0)
        cleanup.push({ operation: "directory close", errno: libc.errno() });
    }
  }
  if (primary !== undefined || cleanup.length > 0)
    throw new CheckoutPathError(primary?.message ?? "Secure local-file cleanup failed", {
      ...(primary?.details === undefined ? {} : { primary: primary.details }),
      ...(cleanup.length === 0 ? {} : { cleanup }),
    });
}
