import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resetConfig } from './config.js';
import {
  parseBlocks,
  applyBlocks,
  unifiedDiff,
  writeBuffers,
  readFileSafe,
  safeResolve,
  resetFormatCache,
  WorkspacePathError,
  FileTooLargeError,
} from './edit-ops.js';

describe('edit-ops', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-edit-test-'));
    resetConfig();
    resetFormatCache();
    process.env.DEEPSEEK_API_KEY = 'sk-test1234567890abcdef';
    process.env.DEEPSEEK_WORKSPACE = ws;
    loadConfig();
  });

  afterEach(() => {
    resetConfig();
    delete process.env.DEEPSEEK_WORKSPACE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('parses one or more SEARCH/REPLACE blocks', () => {
    const raw = [
      '<<<<<<< SEARCH src/a.js',
      'const x = 1;',
      '=======',
      'const x = 2;',
      '>>>>>>> REPLACE',
      '',
      '<<<<<<< SEARCH src/new.js',
      '=======',
      'export const hi = 1;',
      '>>>>>>> REPLACE',
    ].join('\n');
    const blocks = parseBlocks(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].file).toBe('src/a.js');
    expect(blocks[1].search.trim()).toBe('');
  });

  it('applies a unique match and leaves the rest of the file untouched', () => {
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'src/a.js'),
      'const x = 1;\nfunction go(){\n  return x;\n}\nconsole.log(go());\n'
    );
    const blocks = parseBlocks(
      '<<<<<<< SEARCH src/a.js\nfunction go(){\n  return x;\n}\n=======\nfunction go(){\n  return x + 1;\n}\n>>>>>>> REPLACE'
    );
    const { buffers, errors } = applyBlocks(blocks);
    expect(errors).toEqual([]);
    expect(buffers.get('src/a.js')).toContain('return x + 1;');
    expect(buffers.get('src/a.js')).toContain('const x = 1;'); // untouched line preserved
  });

  it('creates a new file when SEARCH is empty', () => {
    const blocks = parseBlocks(
      '<<<<<<< SEARCH src/new.js\n=======\nexport const hi = 1;\n>>>>>>> REPLACE'
    );
    const { buffers, errors } = applyBlocks(blocks);
    expect(errors).toEqual([]);
    expect(buffers.get('src/new.js')).toBe('export const hi = 1;\n');
  });

  it('rejects a SEARCH that matches nothing (no guessing)', () => {
    fs.writeFileSync(path.join(ws, 'a.js'), 'const x = 1;\n');
    const blocks = parseBlocks(
      '<<<<<<< SEARCH a.js\nconst zzz = 9;\n=======\nconst zzz = 8;\n>>>>>>> REPLACE'
    );
    const { buffers, errors } = applyBlocks(blocks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/找不到/);
    // buffer may hold the unchanged original as a read cache, but must not
    // contain the requested (failed) edit — callers gate on errors.length
    // before ever writing, per the atomic-write test below.
    expect(buffers.get('a.js')).toBe('const x = 1;\n');
  });

  it('rejects a SEARCH that matches more than once (ambiguous)', () => {
    fs.writeFileSync(path.join(ws, 'dup.js'), 'let a=1;\nlet a2=1;\nlet a=1;\n');
    const blocks = parseBlocks(
      '<<<<<<< SEARCH dup.js\nlet a=1;\n=======\nlet a=2;\n>>>>>>> REPLACE'
    );
    const { errors } = applyBlocks(blocks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/不唯一/);
  });

  it('does not write anything to disk when any block in the batch fails (atomic)', () => {
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src/a.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(ws, 'src/b.js'), 'const y = 1;\n');
    const blocks = parseBlocks(
      [
        '<<<<<<< SEARCH src/a.js',
        'const x = 1;',
        '=======',
        'const x = 2;',
        '>>>>>>> REPLACE',
        '',
        '<<<<<<< SEARCH src/b.js',
        'const NOPE = 1;',
        '=======',
        'const y = 2;',
        '>>>>>>> REPLACE',
      ].join('\n')
    );
    const { buffers, errors } = applyBlocks(blocks);
    // one block failed -> caller must not proceed to writeBuffers at all
    expect(errors).toHaveLength(1);
    // simulate the tool's behavior: on any error, nothing is written
    if (errors.length === 0) writeBuffers(buffers, new Map());
    expect(fs.readFileSync(path.join(ws, 'src/a.js'), 'utf8')).toBe('const x = 1;\n');
    expect(fs.readFileSync(path.join(ws, 'src/b.js'), 'utf8')).toBe('const y = 1;\n');
  });

  it('writes a .bak of the previous content and returns a real diff', () => {
    fs.writeFileSync(path.join(ws, 'a.js'), 'const x = 1;\n');
    const originals = new Map([['a.js', 'const x = 1;\n']]);
    const buffers = new Map([['a.js', 'const x = 2;\n']]);
    const diffs = writeBuffers(buffers, originals);
    expect(fs.readFileSync(path.join(ws, 'a.js'), 'utf8')).toBe('const x = 2;\n');
    expect(fs.readFileSync(path.join(ws, 'a.js.bak'), 'utf8')).toBe('const x = 1;\n');
    expect(diffs.join('\n')).toContain('-const x = 1;');
    expect(diffs.join('\n')).toContain('+const x = 2;');
  });

  it('rejects paths that escape the workspace root', () => {
    expect(() => safeResolve('../outside.js')).toThrow(WorkspacePathError);
    expect(() => readFileSafe('../../etc/passwd')).toThrow(WorkspacePathError);
  });

  it('rejects files larger than the configured limit', () => {
    process.env.DEEPSEEK_EDIT_MAX_FILE_BYTES = '10';
    resetConfig();
    loadConfig();
    fs.writeFileSync(path.join(ws, 'big.js'), 'x'.repeat(100));
    expect(() => readFileSafe('big.js')).toThrow(FileTooLargeError);
    delete process.env.DEEPSEEK_EDIT_MAX_FILE_BYTES;
  });

  it('unifiedDiff produces a minimal hunk around the change', () => {
    const d = unifiedDiff('l1\nl2\nl3\nl4\nl5\n', 'l1\nl2\nCHANGED\nl4\nl5\n', 'f.js');
    expect(d).toContain('-l3');
    expect(d).toContain('+CHANGED');
    expect(d).toContain('--- a/f.js');
  });

  it('matches SEARCH against a BOM+CRLF file (PowerShell Out-File style)', () => {
    // Reproduces: `"function add(a, b) { return a - b; }" | Out-File -Encoding utf8`
    // on Windows, which writes a UTF-8 BOM and CRLF line endings. Without
    // normalization, a plain-LF SEARCH block sent by the model never matches.
    const withBom =
      '\ufeff' + 'function add(a, b) { return a - b; }\r\n';
    fs.writeFileSync(path.join(ws, 'a.js'), withBom, 'utf8');

    const content = readFileSafe('a.js');
    expect(content).toBe('function add(a, b) { return a - b; }\n'); // BOM gone, LF only

    const blocks = parseBlocks(
      '<<<<<<< SEARCH a.js\nfunction add(a, b) { return a - b; }\n=======\nfunction add(a, b) { return a + b; }\n>>>>>>> REPLACE'
    );
    const { buffers, errors } = applyBlocks(blocks);
    expect(errors).toEqual([]);
    expect(buffers.get('a.js')).toBe('function add(a, b) { return a + b; }\n');
  });

  it('restores the original BOM+CRLF on write so the file format is unchanged', () => {
    const withBom = '\ufeff' + 'const x = 1;\r\nconst y = 2;\r\n';
    fs.writeFileSync(path.join(ws, 'a.js'), withBom, 'utf8');

    const original = readFileSafe('a.js')!; // populates the format cache
    const buffers = new Map([['a.js', original.replace('x = 1', 'x = 2')]]);
    const originals = new Map([['a.js', original]]);
    writeBuffers(buffers, originals);

    const raw = fs.readFileSync(path.join(ws, 'a.js'), 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff); // BOM preserved
    expect(raw).toContain('\r\n'); // CRLF preserved
    expect(raw).toBe('\ufeff' + 'const x = 2;\r\nconst y = 2;\r\n');
  });

  it('writes plain LF/no-BOM for a newly created file (no prior format to preserve)', () => {
    const blocks = parseBlocks(
      '<<<<<<< SEARCH new.js\n=======\nexport const hi = 1;\n>>>>>>> REPLACE'
    );
    const { buffers } = applyBlocks(blocks);
    writeBuffers(buffers, new Map());
    const raw = fs.readFileSync(path.join(ws, 'new.js'), 'utf8');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(raw).not.toContain('\r\n');
  });
});
