/**
 * `diff` 包未随包提供 TypeScript 类型，这里声明渲染层用到的子集。
 * 实际运行使用 diff@7 的 ESM 构建（lib/index.mjs）。
 */
declare module 'diff' {
  export interface StructuredPatchHunk {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }

  export interface ParsedDiff {
    oldFileName?: string
    newFileName?: string
    oldHeader?: string
    newHeader?: string
    hunks: StructuredPatchHunk[]
  }

  export function structuredPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number }
  ): ParsedDiff

  export function parsePatch(patch: string): ParsedDiff[]

  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number }
  ): string
}
