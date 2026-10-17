/**
 * What the computer tools use of where they run: a filesystem and a shell.
 * A sandbox's is built by `./sandbox.ts`; the tools are written against this,
 * so no RPC type reaches them.
 */

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  context?: { line: number; text: string; isMatch: boolean }[];
}

export interface GrepOptions {
  ignoreCase?: boolean;
  regex?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
  include?: string;
  exclude?: string[];
}

export interface FoundEntry {
  path: string;
  type: "file" | "dir";
}

export interface StatResult {
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface DirEntry {
  name: string;
  size?: number;
  mtime?: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ComputerFs {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<StatResult>;
  readdir(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<DirEntry[]>;
  find(
    directory: string,
    pattern?: string,
    options?: { limit?: number; offset?: number; exclude?: string[] }
  ): Promise<FoundEntry[]>;
  grep(
    pattern: string,
    path: string,
    options?: GrepOptions
  ): Promise<GrepMatch[]>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Anything but `completed` is said on the verdict line — see `./render.ts`. */
  status?: "completed" | "failed" | "cancelled";
}

export interface CommandHandle extends Disposable {
  result(): Promise<CommandResult>;
  kill(signal?: "SIGTERM"): Promise<void>;
}

export interface ComputerRuntime {
  exec(
    command: string,
    options: {
      cwd: string;
      encoding: "utf8";
      timeoutMs: number;
      env?: Record<string, string>;
    }
  ): Promise<CommandHandle>;
}

export interface ComputerClient extends Disposable {
  readonly fs: ComputerFs;
  readonly runtime: ComputerRuntime;
}
