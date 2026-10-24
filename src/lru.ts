/**
 * 带容量上限的键值缓存：按「最近写入或读取」淘汰最旧的一项。
 *
 * 附件的原始字节就靠它缓存——长会话里翻过的图片会一直占着内存，不设上限就是慢慢泄漏。
 * 读取也算一次使用，否则反复打开同一张图仍会被后面读进来的新图挤掉。
 */
export function createLruCache(maxEntries: number, maxBytes: number) {
  const entries = new Map<string, string>();
  let bytes = 0;
  const trim = () => {
    // 至少要留住一项：单个视频就可能超过上限，把它自己也淘汰掉等于什么都不显示。
    while (entries.size > maxEntries || (bytes > maxBytes && entries.size > 1)) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= entries.get(oldest)?.length ?? 0;
      entries.delete(oldest);
    }
  };
  return {
    get(key: string) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      // Map 的迭代顺序就是插入顺序，重新插入即为「标记为最近使用」。
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: string) {
      const previous = entries.get(key);
      if (previous !== undefined) { bytes -= previous.length; entries.delete(key); }
      entries.set(key, value);
      bytes += value.length;
      trim();
    },
    clear() { entries.clear(); bytes = 0; },
    get size() { return entries.size; },
    get bytes() { return bytes; }
  };
}
