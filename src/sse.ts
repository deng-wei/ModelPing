// 共享 SSE 分帧逻辑。后端 runner.ts 与前端 web/lib/api.ts 各自维护一个增量缓冲，
// 都要把流式字节按「空行分隔的事件块」切分，并保留未完成的尾部跨 chunk 续接。
// 这里抽出纯函数实现（无 DOM / Node 依赖），两端复用，避免分帧逻辑漂移。

// SSE 事件块以空行（\n\n 或 \r\n\r\n）分隔。
const BLOCK_SEP = /\r?\n\r?\n/;

// 从增量缓冲中切出所有「完整」事件块，返回这些块与剩余未完成的尾部。
// 尾部应继续累加后续 chunk，下次再调用本函数。
export function drainSseBlocks(buf: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buf;
  let idx: number;
  while ((idx = rest.search(BLOCK_SEP)) !== -1) {
    blocks.push(rest.slice(0, idx));
    // 分隔符可能是 \n\n(2) 或 \r\n\r\n(4)，按首字符判定步进长度。
    rest = rest.slice(idx + (rest[idx] === "\r" ? 4 : 2));
  }
  return { blocks, rest };
}

// 从单个事件块提取 data: 负载。SSE 允许一个事件含多行 data:，按规范以 \n 连接。
// 无 data: 行返回 null（注释/保活/event-only 块）。
export function extractSseData(block: string): string | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  return dataLines.length ? dataLines.join("\n") : null;
}
