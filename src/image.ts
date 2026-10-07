// 图片附件在进入会话前统一处理一次：长边超过上限的缩小，体积够大的压成 WebP。
// 目标服务大多会在推理时自行缩图，但那是服务端的事——请求体和 token 已经在路上付过钱了。

// @aurouscia/image-compress 只发了 module 字段、没有 main，Node 侧解析不了静态导入，
// 单元测试要 import 这个模块，所以库放在动态导入里。渲染进程只会走一次，之后走缓存。

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

export type PreparedImage = { data: string; mime: string; size: number };

/**
 * 把用户给的图片整理成可发送的形式：长边不超过 1280，压成 WebP；小图与动图原样保留。
 * 返回 data URL、mime 与实际字节数——协议层只透传 mime 与 data，所以换格式不用动那些地方。
 */
export async function prepareImage(file: File, mime: string): Promise<PreparedImage> {
  if (!shouldCompressImage(file.size)) return { data: await blobToDataURL(file), mime, size: file.size };
  const buffer = await file.arrayBuffer();
  const blob = new Blob([buffer], { type: mime });
  if (mime === 'image/gif' && isAnimatedGif(buffer)) return { data: await blobToDataURL(blob), mime, size: file.size };
  const { resizeImage } = await import('@aurouscia/image-compress');
  const resized = await resizeImage(blob, { maxWidth: IMAGE_MAX_SIDE, maxHeight: IMAGE_MAX_SIDE, type: IMAGE_OUTPUT_TYPE, quality: IMAGE_QUALITY });
  return { data: await blobToDataURL(resized.blob), mime: IMAGE_OUTPUT_TYPE, size: resized.blob.size };
}
