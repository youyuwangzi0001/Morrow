// 参考图归一化（C-02）：MiniMaxH3ReferenceToVideo 用 ref_image_size:'match' 按参考图决定批次尺寸。
// 只要有一张参考图比目标大（例如 1152×2048 混进 768×1344 批次），整批 latent 就按大尺寸算，
// 显存需求暴涨到 OOM。所以视频生成前必须把所有参考图统一到同一目标尺寸。

/** 目标尺寸向下对齐到 32 的倍数；模型侧只接受 32 对齐的 latent。 */
export function snapToMultiple(value: number, multiple = 32): number {
  if (!Number.isFinite(value) || value <= 0) return multiple
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

/** 把宽高各自向下取到 32 的倍数，避免向上取整后超出显存预算。 */
export function normalizeTargetSize(width: number, height: number): { width: number; height: number } {
  const floor = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return 32
    return Math.max(32, Math.floor(value / 32) * 32)
  }
  return { width: floor(width), height: floor(height) }
}

/**
 * 判断一张参考图是否还需要处理。
 * 只有「尺寸完全等于目标」时才算合格：尺寸不同、比例不符、或比目标大都要归一化，
 * 因为模型按参考图尺寸决定 latent，任何偏差都会放大到整批。
 */
export function needsNormalization(
  actual: { width: number; height: number } | null,
  target: { width: number; height: number }
): boolean {
  if (!actual) return true
  if (!Number.isFinite(actual.width) || !Number.isFinite(actual.height)) return true
  if (actual.width <= 0 || actual.height <= 0) return true
  return actual.width !== target.width || actual.height !== target.height
}

/**
 * 由请求尺寸和参考图尺寸算出本批的统一目标尺寸。
 * 参考图比请求大时用请求尺寸（宁可稍微降采样，也不让整批变大）；
 * 请求尺寸本身就是视频输出的目标尺寸，所以永远以它为准，只做 32 对齐。
 */
export function resolveBatchSize(input: {
  requestWidth: number
  requestHeight: number
}): { width: number; height: number } {
  return normalizeTargetSize(input.requestWidth, input.requestHeight)
}

/** ffmpeg 缩放+裁切滤镜：等比放大到铺满目标，再居中裁切，保证不拉伸变形。 */
export function coverFilter(target: { width: number; height: number }): string {
  return (
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${target.width}:${target.height}`
  )
}