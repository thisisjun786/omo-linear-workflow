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

interface Functions {
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

const cstring = (value: string) => new TextEncoder().encode(`${value}\0`);

function functions(): Functions {
  try {
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
    return {
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
  } catch (cause) {
    throw new CheckoutPathError("Secure checkout file operations are unavailable", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function fail(operation: string, errno: number): CheckoutPathError {
  return new CheckoutPathError(`Secure local-file ${operation} failed`, { errno });
}

/** Copy bytes using directory-descriptor-relative operations only. */
export async function copyIntoCheckout(
  checkoutPath: string,
  target: string,
  contents: Uint8Array,
): Promise<void> {
  const libc = functions();
  const opened: number[] = [];
  let temporary: string | undefined;
  let destinationFd: number | undefined;
  const closeAll = () => {
    for (const fd of opened.reverse()) libc.close(fd);
  };
  try {
    let parentFd = libc.open(cstring(checkoutPath), O_DIRECTORY | O_NOFOLLOW, 0);
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
    await Bun.write(Bun.file(destinationFd), contents);
    if (libc.close(destinationFd) !== 0) throw fail("temporary close", libc.errno());
    destinationFd = undefined;
    if (libc.renameat(parentFd, cstring(temporary), parentFd, cstring(destination)) !== 0)
      throw fail("publication", libc.errno());
    temporary = undefined;
  } catch (cause) {
    throw cause instanceof CheckoutPathError
      ? cause
      : new CheckoutPathError("Secure local-file copy failed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
  } finally {
    if (destinationFd !== undefined) libc.close(destinationFd);
    if (temporary !== undefined && opened[0] !== undefined)
      libc.unlinkat(opened.at(-1) ?? opened[0], cstring(temporary), 0);
    closeAll();
  }
}
