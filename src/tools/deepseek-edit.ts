/**
 * Tool: deepseek_edit / deepseek_review
 *
 * deepseek_edit lets the calling agent (Opus) hand off an already-decided
 * change to DeepSeek for mechanical execution: DeepSeek reads the named
 * files, emits SEARCH/REPLACE blocks, and this tool applies them under
 * strict guarantees (unique match required, atomic write, sandboxed to
 * editWorkspace, unified diff always returned). It does not design fixes —
 * the caller must already know which files and what change; if that isn't
 * true yet, use deepseek_review or plain deepseek_chat first.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeepSeekClient } from '../deepseek-client.js';
import { getErrorMessage } from '../types.js';
import {
  readFileSafe,
  parseBlocks,
  applyBlocks,
  writeBuffers,
  unifiedDiff,
  WorkspacePathError,
  FileTooLargeError,
} from '../edit-ops.js';

const EDIT_SYSTEM = `你是代码执行器。上游架构师已经给出方案，你的唯一任务是把方案落成精确的代码改动。

硬性规则：
1. 只输出 SEARCH/REPLACE 块，块之外不要有任何解释文字、不要 markdown 代码围栏。
2. 格式严格如下（SEARCH 内容必须与原文件逐字一致，包括缩进和空行）：

<<<<<<< SEARCH path/to/file.ext
原文件中的确切片段
=======
替换后的新内容
>>>>>>> REPLACE

3. SEARCH 片段必须在该文件中唯一。若可能重复，多带几行上下文让它唯一。
4. 新建文件时 SEARCH 留空（即 <<<<<<< SEARCH 后直接跟 =======），REPLACE 为整个文件内容。
5. 严禁超出方案范围的重构、改名、格式化、删注释。方案没说的，一律不动。
6. 不要为了让代码"看起来能跑"而绕过问题（吞异常、加 try/catch 掩盖、写死返回值）。做不到就在最后一行输出 BLOCKED: 原因，不要输出任何 SEARCH/REPLACE 块。`;

function buildFileContext(files: string[]): { ctx: string; originals: Map<string, string> } {
  const originals = new Map<string, string>();
  const ctx = files
    .map((f) => {
      const c = readFileSafe(f);
      originals.set(f, c ?? '');
      return c === null
        ? `### ${f}\n(文件尚不存在，如需创建请用空 SEARCH)`
        : `### ${f}\n\`\`\`\n${c}\n\`\`\``;
    })
    .join('\n\n');
  return { ctx, originals };
}

export function registerEditTools(server: McpServer, client: DeepSeekClient): void {
  server.registerTool(
    'deepseek_review',
    {
      title: 'DeepSeek Read-Only Review',
      description:
        '只读。让 DeepSeek 阅读指定文件并回答问题（定位 bug、梳理调用链、评估某处改动的副作用）。' +
        '不修改任何文件，用于 Opus 出方案前的调查阶段。',
      inputSchema: {
        files: z.array(z.string()).min(1).describe('要阅读的文件，相对 editWorkspace 的路径'),
        question: z.string().min(1).describe('要 DeepSeek 回答的具体问题'),
      },
    },
    async ({ files, question }) => {
      try {
        const { ctx } = buildFileContext(files);
        const response = await client.createChatCompletion({
          model: 'deepseek-v4-flash',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                '你是资深工程师，只做分析，不输出改动。回答要具体到行为和调用链，不要泛泛而谈。',
            },
            { role: 'user', content: `${ctx}\n\n问题：${question}` },
          ],
        });
        return { content: [{ type: 'text' as const, text: response.content }] };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text' as const, text: `错误: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'deepseek_edit',
    {
      title: 'DeepSeek Scoped Code Edit',
      description:
        '把已经确定的改动方案交给 DeepSeek 落地执行：读取指定文件、生成精确 SEARCH/REPLACE 改动、' +
        '写盘（原文件备份为 .bak）并返回真实 unified diff 供复核。调用前调用方必须已经明确改哪些文件、' +
        '改成什么样——本工具不做方案设计，只做机械执行。SEARCH 必须在目标文件中唯一匹配，匹配失败或不唯一时' +
        '整体不写盘并返回具体原因。文件的 UTF-8 BOM 和换行风格（CRLF/LF）会被自动识别并在写盘时还原，' +
        '不会因为改动而悄悄改变文件原有的编码/换行格式。',
      inputSchema: {
        files: z
          .array(z.string())
          .min(1)
          .describe(
            '相对 editWorkspace 的文件路径。要改的文件 + 理解改动所必需的参考文件都要列出。'
          ),
        instruction: z
          .string()
          .min(1)
          .describe(
            '给 DeepSeek 的执行指令。要具体到函数名/行为，说明改什么、改成什么、为什么。越明确失败率越低。'
          ),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe('true 时只返回 diff 不写盘，用于先复核再落地。'),
        model: z
          .enum(['deepseek-v4-flash', 'deepseek-v4-pro'])
          .optional()
          .default('deepseek-v4-flash')
          .describe('执行改动用的模型，默认用 v4-flash（0731正式版性能已超越v4-pro）。'),
      },
    },
    async ({ files, instruction, dry_run, model }) => {
      try {
        const { ctx, originals } = buildFileContext(files);

        const response = await client.createChatCompletion({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: EDIT_SYSTEM },
            { role: 'user', content: `${ctx}\n\n执行指令：\n${instruction}` },
          ],
        });
        const raw = response.content;

        if (/^\s*BLOCKED:/m.test(raw)) {
          return {
            content: [{ type: 'text' as const, text: `DeepSeek 拒绝执行：\n${raw.trim()}` }],
            isError: true,
          };
        }

        const blocks = parseBlocks(raw);
        if (blocks.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `未解析到任何 SEARCH/REPLACE 块。DeepSeek 原始输出：\n\n${raw.slice(0, 3000)}`,
              },
            ],
            isError: true,
          };
        }

        const { buffers, errors } = applyBlocks(blocks);
        if (errors.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `改动未应用（原子性：有错则全部回退）。错误：\n- ${errors.join('\n- ')}\n\n` +
                  `建议：把 instruction 写得更具体，或在 files 里补上缺失的文件。`,
              },
            ],
            isError: true,
          };
        }

        if (dry_run) {
          const diffs: string[] = [];
          for (const [f, newContent] of buffers) {
            const old = originals.get(f) ?? '';
            if (old === newContent) continue;
            diffs.push(unifiedDiff(old, newContent, f));
          }
          if (diffs.length === 0) {
            return { content: [{ type: 'text' as const, text: '内容无变化。' }] };
          }
          return {
            content: [{ type: 'text' as const, text: `[DRY RUN 未写盘]\n\n${diffs.join('\n\n')}` }],
          };
        }

        const diffs = writeBuffers(buffers, originals);
        if (diffs.length === 0) {
          return { content: [{ type: 'text' as const, text: '内容无变化，未写盘。' }] };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `已写入 ${buffers.size} 个文件（原文件备份为 *.bak）。请复核以下 diff：\n\n` +
                diffs.join('\n\n'),
            },
          ],
        };
      } catch (error: unknown) {
        if (error instanceof WorkspacePathError || error instanceof FileTooLargeError) {
          return { content: [{ type: 'text' as const, text: error.message }], isError: true };
        }
        console.error('[DeepSeek MCP] deepseek_edit error:', error);
        return {
          content: [{ type: 'text' as const, text: `错误: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
