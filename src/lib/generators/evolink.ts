import { createScopedLogger } from '@/lib/logging/core'
import {
  BaseImageGenerator,
  BaseVideoGenerator,
  type ImageGenerateParams,
  type VideoGenerateParams,
  type GenerateResult,
} from './base'
import { getProviderConfig } from '@/lib/api-config'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'

const EVOLINK_API_BASE = 'https://api.evolink.ai/v1'

const EVOLINK_IMAGE_ALLOWED_OPTIONS = new Set([
  'provider',
  'modelId',
  'modelKey',
  'aspectRatio',
  'resolution',
])

export class EvolinkImageGenerator extends BaseImageGenerator {
  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params

    const { apiKey } = await getProviderConfig(userId, 'evolink')
    if (!apiKey) {
      throw new Error('请配置 EvoLink API Key')
    }

    const {
      aspectRatio,
      resolution,
      modelId: optModelId = 'z-image-turbo',
    } = options as {
      aspectRatio?: string
      resolution?: string
      modelId?: string
      provider?: string
      modelKey?: string
    }

    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue
      if (!EVOLINK_IMAGE_ALLOWED_OPTIONS.has(key)) {
        throw new Error(`EVOLINK_IMAGE_OPTION_UNSUPPORTED: ${key}`)
      }
    }

    const logger = createScopedLogger({
      module: 'worker.evolink-image',
      action: 'evolink_image_generate',
    })

    const body: Record<string, unknown> = {
      model: optModelId,
      prompt,
    }
    if (aspectRatio) {
      body.size = aspectRatio
    }
    if (resolution) {
      body.quality = resolution
    }

    // NanoBanana 2 支持参考图（最多 14 张）
    if (referenceImages.length > 0) {
      const dataUrls = await Promise.all(
        referenceImages.map(async (url) => {
          if (url.startsWith('data:')) return url
          return await normalizeToBase64ForGeneration(url)
        }),
      )
      body.image_urls = dataUrls
    }

    logger.info({
      message: 'EvoLink image generation request',
      details: {
        modelId: optModelId,
        aspectRatio: aspectRatio ?? null,
        resolution: resolution ?? null,
        referenceImagesCount: referenceImages.length,
        promptLength: prompt.length,
      },
    })

    const response = await fetch(`${EVOLINK_API_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`EvoLink 提交失败 (${response.status}): ${errorText}`)
    }

    const data = await response.json() as { id?: string }
    const taskId = data.id

    if (!taskId) {
      throw new Error('EvoLink 未返回任务 ID')
    }

    logger.info({
      message: 'EvoLink image task submitted',
      details: { taskId },
    })

    return {
      success: true,
      async: true,
      requestId: taskId,
      externalId: `EVOLINK:IMAGE:${taskId}`,
    }
  }
}

// ============================================================
// EvoLink 视频生成器（图生视频）
// ============================================================

const EVOLINK_VIDEO_ALLOWED_OPTIONS = new Set([
  'provider',
  'modelId',
  'modelKey',
  'duration',
  'aspectRatio',
  'resolution',
  'generateAudio',
  'generationMode',
  'lastFrameImageUrl',
])

export class EvolinkVideoGenerator extends BaseVideoGenerator {
  protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params

    const { apiKey } = await getProviderConfig(userId, 'evolink')
    if (!apiKey) {
      throw new Error('请配置 EvoLink API Key')
    }

    const {
      duration,
      aspectRatio,
      resolution,
      generateAudio,
      lastFrameImageUrl,
      modelId: optModelId = 'kling-o3-image-to-video',
    } = options as {
      duration?: number
      aspectRatio?: string
      resolution?: string
      generateAudio?: boolean
      lastFrameImageUrl?: string
      modelId?: string
      provider?: string
      modelKey?: string
      generationMode?: string
    }

    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue
      if (!EVOLINK_VIDEO_ALLOWED_OPTIONS.has(key)) {
        throw new Error(`EVOLINK_VIDEO_OPTION_UNSUPPORTED: ${key}`)
      }
    }

    const logger = createScopedLogger({
      module: 'worker.evolink-video',
      action: 'evolink_video_generate',
    })

    // 按模型系列路由参数格式
    const isKling = optModelId.startsWith('kling-')
    const isWan = optModelId.startsWith('wan')
    const isSeedance = optModelId.startsWith('seedance-')

    const body: Record<string, unknown> = {
      model: optModelId,
      prompt,
    }

    // 图片参数：Kling 用 image_start/image_end，其他用 image_urls 数组
    if (isKling) {
      if (imageUrl) {
        body.image_start = imageUrl
      }
      if (lastFrameImageUrl) {
        body.image_end = lastFrameImageUrl
      }
    } else {
      // Wan 2.6 / Seedance 1.5：image_urls 数组
      const imageUrls: string[] = []
      if (imageUrl) imageUrls.push(imageUrl)
      if (isSeedance && lastFrameImageUrl) imageUrls.push(lastFrameImageUrl)
      if (imageUrls.length > 0) {
        body.image_urls = imageUrls
      }
    }

    if (typeof duration === 'number') {
      body.duration = duration
    }
    // Wan 2.6 不支持 aspect_ratio
    if (aspectRatio && !isWan) {
      body.aspect_ratio = aspectRatio
    }
    if (resolution) {
      body.quality = resolution
    }

    // 音频参数：Kling 用 sound(on/off)，Seedance/Wan Flash 用 generate_audio(bool)
    if (typeof generateAudio === 'boolean') {
      if (isKling) {
        body.sound = generateAudio ? 'on' : 'off'
      } else if (isSeedance || optModelId === 'wan2.6-image-to-video-flash') {
        body.generate_audio = generateAudio
      }
    }

    logger.info({
      message: 'EvoLink video generation request',
      details: {
        modelId: optModelId,
        aspectRatio: aspectRatio ?? null,
        duration: duration ?? null,
        hasStartImage: !!imageUrl,
        hasEndImage: !!lastFrameImageUrl,
        promptLength: prompt.length,
      },
    })

    const response = await fetch(`${EVOLINK_API_BASE}/videos/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`EvoLink 视频提交失败 (${response.status}): ${errorText}`)
    }

    const data = await response.json() as { id?: string }
    const taskId = data.id

    if (!taskId) {
      throw new Error('EvoLink 未返回任务 ID')
    }

    logger.info({
      message: 'EvoLink video task submitted',
      details: { taskId },
    })

    return {
      success: true,
      async: true,
      requestId: taskId,
      externalId: `EVOLINK:VIDEO:${taskId}`,
    }
  }
}
