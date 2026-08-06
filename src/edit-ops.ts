/**
 * File operations for the deepseek_edit tool.
 *
 * Design goals (root-cause fixes, no patch-work — see project conventions):
 *  1. SEARCH must match exactly once in the target file. No match, or more
 *     than one match, fails the whole call with a clear reason — never a
 *     best-effort guess.
 *  2. All edits are computed in memory first; nothing is written to disk
 *     until every block in the batch has resolved cleanly (atomic write).
 *  3. Every path is resolved against editWorkspace and rejected if it
 *     would escape that root.
 *  4. Every write leaves a .bak of the previous content and returns a real
 *     unified diff, so the caller (Opus) can review exactly what changed
 *     before trusting it.
 *  5. Content the model sees/matches against is normalized (no UTF-8 BOM,
 *     LF line endings) so a file saved on Windows (which commonly carries
 *     a BOM and CRLF, e.g. PowerShell's `Out-File`) doesn't silently break
 *     exact-match SEARCH blocks. The original BOM/CRLF-ness is remembered
 *     per file and restored on write, so the file's on-disk format is
 *     unchanged by an edit that didn't touch line endings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

export interface EditBlock {
  file: string;
  search: string;
  replace: string;
}

export interface ApplyResult {
  buffers: Map<string, string>;
  errors: string[];
}

interface FileFormatMeta {
  bom: boolean;
  crlf: boolean;
}

const BLOCK_RE =
  /^<<<<<<< SEARCH (.+?)\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> REPLACE\s*$/gm;

export class WorkspacePathError extends Error {}
export class FileTooLargeError extends Error {}

/** Per-file BOM/CRLF memory, keyed by resolved absolute path. */
const formatCache = new Map<string, FileFormatMeta>();

/** Test-only: clear cached format metadata between isolated test runs. */
export function resetFormatCache(): void {
  formatCache.clear();
}

/** Strip a leading UTF-8 BOM and convert CRLF -> LF, recording both facts. */
function normalizeContent(raw: string): { content: string; meta: FileFormatMeta } {
  let content = raw;
  let bom = false;
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
    bom = true;
  }
  const crlf = content.includes('\r\n');
  if (crlf) {
    content = content.replace(/\r\n/g, '\n');
  }
  return { content, meta: { bom, crlf } };
}

/** Reverse of normalizeContent: restore CRLF/BOM per the remembered format. */
function denormalizeContent(content: string, meta: FileFormatMeta | undefined): string {
  let out = content;
  if (meta?.crlf) {
    out = out.replace(/\n/g, '\r\n');
  }
  if (meta?.bom) {
    out = '\ufeff' + out;
  }
  return out;
}

/** Resolve a path against the configured workspace root; reject escapes. */
export function safeResolve(p: string): string {
  const workspace = path.resolve(getConfig().editWorkspace);
  const abs = path.resolve(workspace, p);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspacePathError(
      `路径越界，拒绝访问 workspace 之外的文件: ${p}`
    );
  }
  return abs;
}

export function readFileSafe(p: string): string | null {
  const abs = safeResolve(p);
  if (!fs.existsSync(abs)) return null;
  const st = fs.statSync(abs);
  const maxBytes = getConfig().editMaxFileBytes;
  if (st.size > maxBytes) {
    throw new FileTooLargeError(
      `文件过大(${st.size}B > ${maxBytes}B)，请先缩小改动范围: ${p}`
    );
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const { content, meta } = normalizeContent(raw);
  formatCache.set(abs, meta);
  return content;
}

export function parseBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    blocks.push({ file: m[1].trim(), search: m[2], replace: m[3] });
  }
  return blocks;
}

/** Apply blocks in memory only. Throws on path escape / oversized file. */
export function applyBlocks(blocks: EditBlock[]): ApplyResult {
  const buffers = new Map<string, string>();
  const errors: string[] = [];

  blocks.forEach((b, i) => {
    let cur: string;
    if (buffers.has(b.file)) {
      cur = buffers.get(b.file)!;
    } else {
      const existing = readFileSafe(b.file);
      if (existing === null) {
        if (b.search.trim() === '') {
          cur = ''; // new file: empty SEARCH
        } else {
          errors.push(`块#${i + 1} 目标文件不存在: ${b.file}`);
          return;
        }
      } else {
        cur = existing;
      }
      buffers.set(b.file, cur);
    }

    if (b.search.trim() === '') {
      buffers.set(b.file, b.replace);
      return;
    }

    const first = cur.indexOf(b.search);
    if (first === -1) {
      errors.push(
        `块#${i + 1} 在 ${b.file} 中找不到完全匹配的 SEARCH 内容（空格/缩进必须逐字一致）`
      );
      return;
    }
    if (cur.indexOf(b.search, first + 1) !== -1) {
      errors.push(
        `块#${i + 1} 的 SEARCH 在 ${b.file} 中出现多次，不唯一，拒绝改动。请扩大上下文使其唯一。`
      );
      return;
    }
    buffers.set(
      b.file,
      cur.slice(0, first) + b.replace + cur.slice(first + b.search.length)
    );
  });

  return { buffers, errors };
}

/** Minimal unified diff (LCS-based), 3 lines of context around each hunk. */
export function unifiedDiff(oldStr: string, newStr: string, file: string): string {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = [' ' | '-' | '+', string, number, number];
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i], i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['-', a[i], i, j]);
      i++;
    } else {
      ops.push(['+', b[j], i, j]);
      j++;
    }
  }
  while (i < n) {
    ops.push(['-', a[i], i, j]);
    i++;
  }
  while (j < m) {
    ops.push(['+', b[j], i, j]);
    j++;
  }

  const keep = new Set<number>();
  ops.forEach((o, idx) => {
    if (o[0] !== ' ') {
      for (let k = Math.max(0, idx - 3); k <= Math.min(ops.length - 1, idx + 3); k++) {
        keep.add(k);
      }
    }
  });
  if (keep.size === 0) return '';

  const out = [`--- a/${file}`, `+++ b/${file}`];
  let prev = -2;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep.has(idx)) continue;
    if (idx !== prev + 1) out.push(`@@ -${ops[idx][2] + 1} +${ops[idx][3] + 1} @@`);
    out.push(ops[idx][0] + ops[idx][1]);
    prev = idx;
  }
  return out.join('\n');
}

/** Write buffers to disk atomically-in-spirit: caller must have zero errors first. */
export function writeBuffers(
  buffers: Map<string, string>,
  originals: Map<string, string>
): string[] {
  const diffs: string[] = [];
  for (const [f, newContent] of buffers) {
    const old = originals.get(f) ?? readFileSafe(f) ?? '';
    if (old === newContent) continue;
    diffs.push(unifiedDiff(old, newContent, f));
  }
  for (const [f, newContent] of buffers) {
    if ((originals.get(f) ?? '') === newContent && originals.has(f)) continue;
    const abs = safeResolve(f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.bak');
    const onDisk = denormalizeContent(newContent, formatCache.get(abs));
    fs.writeFileSync(abs, onDisk, 'utf8');
  }
  return diffs;
}
