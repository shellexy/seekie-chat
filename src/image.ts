// 图片附件的纯逻辑：判定与体积门槛。这一层不依赖任何浏览器 API，也不引入第三方库，
// 所以单元测试可以直接在 Node 里跑。
// 真正做缩放与编码的部分在 imageEncode.ts——那里的库在渲染进程里静态引入。

/** 长边的上限。超过它的图按比例缩小，不放大小图。 */
export const IMAGE_MAX_SIDE = 1280;
/** 小于这个体积的图片原样保留：重编码只会掉画质，还未必变小。 */
export const IMAGE_COMPRESS_MIN_BYTES = 50 * 1024;
/** 输出格式。新的支持视觉的模型都收 WebP，请求体比 PNG 小一个量级。 */
export const IMAGE_OUTPUT_TYPE = 'image/webp';
/** WebP 有损质量。 */
export const IMAGE_QUALITY = 0.8;

/**
 * 判断 GIF 是否是动图：数一下画面块（Image Descriptor）的个数，两个以上就是动的。
 * 动图要原样保留——DeepSeek、Qwen3+ 只读第一帧，转成静态图等于白转；而支持动图的
 * 模型（GPT-5.6、GPT-6、Gemini 3）要拿到原始动图才动得了。
 */
export function isAnimatedGif(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data);
  if (bytes.length < 13) return false;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return false;
  const packed = bytes[10];
  let offset = 13 + ((packed & 0x80) ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x3b) break;                                    // 文件结束
    if (block === 0x21) {                                          // 扩展块
      offset += 2;
      while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
      offset++;
      continue;
    }
    if (block === 0x2c) {                                          // 画面块
      if (++frames > 1) return true;
      const local = bytes[offset + 9];
      offset += 10 + ((local & 0x80) ? 3 * 2 ** ((local & 0x07) + 1) : 0);
      offset++;                                                     // LZW 最小码长
      while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
      offset++;
      continue;
    }
    return false;                                                  // 未知块，放弃判断
  }
  return false;
}

/** 体积够大才值得重编码。小图原样保留，避免白白掉画质。 */
export function shouldCompressImage(size: number): boolean { return size >= IMAGE_COMPRESS_MIN_BYTES; }

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'));
    reader.onerror = () => reject(reader.error || new Error('无法读取图片'));
    reader.readAsDataURL(blob);
  });
}
