import { resizeImage } from '@aurouscia/image-compress';
import { blobToDataURL, IMAGE_MAX_SIDE, IMAGE_OUTPUT_TYPE, IMAGE_QUALITY, isAnimatedGif, shouldCompressImage } from './image';

// 缩放与编码放在单独一个模块里：@aurouscia/image-compress 只发了 module 字段、没有 main，
// Node 侧解析不了静态导入，单元测试要 import 这一层的纯逻辑，所以库不能和它同处一个文件。
// 这里是静态引入：动态 import 会在 file:// 下切成独立块，偶发加载失败，附件就加不进去。

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
  const resized = await resizeImage(blob, { maxWidth: IMAGE_MAX_SIDE, maxHeight: IMAGE_MAX_SIDE, type: IMAGE_OUTPUT_TYPE, quality: IMAGE_QUALITY });
  return { data: await blobToDataURL(resized.blob), mime: IMAGE_OUTPUT_TYPE, size: resized.blob.size };
}
