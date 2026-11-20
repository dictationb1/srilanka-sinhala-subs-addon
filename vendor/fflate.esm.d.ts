/**
 * Minimal type surface for the vendored fflate ESM build (vendor/fflate.esm.js,
 * v0.8.x, MIT — Arjun Barrett). Only the synchronous functions the addon uses
 * are declared; the implementation is untouched.
 */
export interface UnzipFile {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

export type UnzipFileFilter = (file: UnzipFile) => boolean;

export interface UnzipOptions {
  filter?: UnzipFileFilter;
}

export interface GunzipOptions {
  out?: Uint8Array;
}

export declare function unzipSync(data: Uint8Array, opts?: UnzipOptions): Record<string, Uint8Array>;
export declare function gunzipSync(data: Uint8Array, opts?: GunzipOptions): Uint8Array;
export declare function zipSync(data: Record<string, Uint8Array>): Uint8Array;
export declare function gzipSync(data: Uint8Array): Uint8Array;
