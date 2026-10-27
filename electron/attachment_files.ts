import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * attachments 目录里只放 `<附件 id>.txt`，引用关系全在状态里（消息附件 + 分支草稿附件），
 * 所以「不在这份引用集合里的文件」就是孤儿：上一次运行在写盘途中被强杀、或者旧版本删行时
 * 漏掉的那几个，会一直占着磁盘。保存时已经清过一遍，这里给启动时也补一次——那时还没有
 * 任何窗口在写文件，是唯一安全的全量清理时机。
 *
 * 只删认不出归属的文件没有风险：真正被引用的附件一定在集合里；数据没读出来时调用方不会
 * 走到这儿（store 只在确实读到了存档之后才清理）。
 */
export function sweepAttachmentFiles(directory: string, referencedIds: Iterable<string>) {
  const dir = join(directory, 'attachments');
  if (!existsSync(dir)) return [];
  const keep = new Set<string>();
  for (const id of referencedIds) keep.add(`${id}.txt`);
  const removed: string[] = [];
  for (const file of readdirSync(dir)) {
    if (keep.has(file)) continue;
    try { unlinkSync(join(dir, file)); removed.push(file); } catch { /* 已经被别的路径删掉，忽略 */ }
  }
  return removed;
}
