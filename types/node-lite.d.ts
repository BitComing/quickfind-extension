/**
 * 最小 Node 类型声明。
 *
 * 项目只在构建配置（wxt.config.ts）与构建脚本（build.mjs）中使用少量 Node API，
 * 而当前环境无法通过 npm 安装 @types/node，因此在此声明所需的最小集合。
 *
 * 若日后可安装 @types/node：删除本文件，并在 tsconfig.json 的
 * compilerOptions.types 中加入 "node"。
 */

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  chdir(dir: string): void;
  exit(code?: number): never;
  platform: string;
  version: string;
};

declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Buffer;
  static alloc(size: number, fill?: unknown): Buffer;
  static isBuffer(obj: unknown): obj is Buffer;
  toString(encoding?: string, start?: number, end?: number): string;
  readonly length: number;
  readonly byteLength: number;
}

declare module 'node:fs' {
  export interface Stats {
    size: number;
    mtime: Date;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export interface ReaddirOptions {
    withFileTypes?: boolean;
    recursive?: boolean;
  }
  export function readFileSync(path: string, options?: unknown): any;
  export function writeFileSync(path: string, data: unknown, options?: unknown): void;
  export function appendFileSync(path: string, data: unknown): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function unlinkSync(path: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function copyFileSync(src: string, dest: string): void;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function readdirSync(path: string, options?: ReaddirOptions): string[];
  export const promises: Record<string, (...args: any[]) => Promise<any>>;

  const fs: {
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    appendFileSync: typeof appendFileSync;
    existsSync: typeof existsSync;
    statSync: typeof statSync;
    mkdirSync: typeof mkdirSync;
    rmSync: typeof rmSync;
    unlinkSync: typeof unlinkSync;
    renameSync: typeof renameSync;
    copyFileSync: typeof copyFileSync;
    readdirSync: typeof readdirSync;
    promises: typeof promises;
  };
  export default fs;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;

  const path: {
    join: typeof join;
    resolve: typeof resolve;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    relative: typeof relative;
    sep: typeof sep;
  };
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
