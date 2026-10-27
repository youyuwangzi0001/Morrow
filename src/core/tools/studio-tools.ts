// 创作台 Agent 动作：和界面共用同一套作品服务。
import type { ToolContext } from '../types'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

async function callStudio(ctx: ToolContext, input: Record<string, unknown>, action: string): Promise<{ summary: string; data?: unknown }> {
  if (!ctx.studio) {
    throw new Error('创作台服务没有启动；请在 Morrow 主窗口打开创作台后再试。')
  }
  const { action: subAction, ...rest } = input
  return ctx.studio({ ...rest, action, ...(typeof subAction === 'string' ? { subAction } : {}) })
}

export const studioProjectTool: ToolImpl = {
  definition: {
    name: 'studio_project',
    description:
      '读取 Morrow 创作台的作品列表、单个作品摘要、引擎状态或最近任务。只读，不修改作品。写动作前先用它拿到 projectId，并确认当前阶段与缺失项。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'status', 'jobs'], description: '读取类型' },
        projectId: { type: 'string', description: '作品 id；get/jobs 必填' }
      },
      required: ['action']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `查看创作台：${String(input.action ?? '作品列表')}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'project')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先用 studio_project 的 list 找到作品 id。')
    }
  }
}

export const studioCreateTool: ToolImpl = {
  definition: {
    name: 'studio_create',
    description:
      '在 Morrow 创作台新建一个作品（中短篇 short / 长篇 novel / 漫剧 drama）。只创建作品文件与初始状态，不生成正文或画面。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['short', 'novel', 'drama'], description: '作品形态' },
        logline: { type: 'string', description: '一句话故事' },
        title: { type: 'string', description: '标题（可选）' }
      },
      required: ['kind', 'logline']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `新建创作台作品：${oneLineInput(input, 'logline', 40)}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'create')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '检查 kind 是否为 short / novel / drama，并确保一句话不为空。')
    }
  }
}

export const studioBlueprintTool: ToolImpl = {
  definition: {
    name: 'studio_blueprint',
    description:
      '生成或批准创作蓝图，或重建大纲/镜头计划。生成蓝图会先给故事核、人物、结构、风格与费用区间；批准后才建立章纲或镜头。status 返回蓝图的审核状态，不生成任何内容。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        action: { type: 'string', enum: ['generate', 'approve', 'outline', 'status'], description: '动作' },
        useModel: { type: 'boolean', description: '是否调用已配置的文本模型；false 用本地结构稿' }
      },
      required: ['projectId', 'action']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `创作蓝图：${String(input.action ?? 'generate')}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'blueprint')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先用 studio_project get 确认作品存在，再用 generate 生成蓝图。')
    }
  }
}

export const studioWriteTool: ToolImpl = {
  definition: {
    name: 'studio_write',
    description:
      '为某一章生成候选正文。已有手改时只追加候选，绝不覆盖正文；空章可以把候选写成初稿。完成后返回候选与字数。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        chapterId: { type: 'string', description: '章节 id；省略时选第一章空章' },
        instruction: { type: 'string', description: '额外写作要求（可选）' },
        count: { type: 'number', description: '连续写作章数；>1 时只推进空章，默认 1' },
        useModel: { type: 'boolean', description: '是否调用文本模型；false 用本地结构稿' }
      },
      required: ['projectId']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `写一章：${oneLineInput(input, 'instruction', 36) || '按章纲'}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'chapter')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先用 studio_project get 找到章节 id。')
    }
  }
}

export const studioStoryboardTool: ToolImpl = {
  definition: {
    name: 'studio_storyboard',
    description:
      '漫剧分镜动作：按蓝图生成/更新镜头计划、生成单镜或批量画面、自动装配时间线。已有画面不会被覆盖；已有时间线时默认拒绝覆盖，只有用户明确同意后才传 force=true。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        action: { type: 'string', enum: ['generate', 'image', 'batch-images', 'build-timeline'], description: '动作' },
        shotId: { type: 'string', description: '单镜动作的镜头 id' },
        shotIds: { type: 'array', items: { type: 'string' }, description: '批量镜头 id（可选）' },
        force: { type: 'boolean', description: 'build-timeline 时是否确认覆盖已有剪辑' }
      },
      required: ['projectId', 'action']
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `分镜：${String(input.action ?? 'generate')}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'storyboard')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '画面生成需要本机 ComfyUI 就绪；也可以用导入素材代替。')
    }
  }
}

export const studioMediaTool: ToolImpl = {
  definition: {
    name: 'studio_media',
    description:
      '为某一镜生成画面/视频/配音，或为漫剧生成配乐与音效。所有动作都记任务、费用与来源；本机引擎未就绪时明确失败，不伪造结果。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        action: { type: 'string', enum: ['image', 'video', 'voice', 'music', 'sfx'], description: '媒体类型' },
        shotId: { type: 'string', description: '镜头 id（image/video/voice 必填）' },
        kind: { type: 'string', description: 'sfx 类型：rain / umbrella / heartbeat / street' },
        mood: { type: 'string', description: '配乐情绪：rain / wonder / release / warm / tension' },
        seconds: { type: 'number', description: '配乐/音效时长（秒）' }
      },
      required: ['projectId', 'action']
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `创作媒体：${String(input.action ?? '')}${oneLineInput(input, 'shotId', 18) ? ` · ${oneLineInput(input, 'shotId', 18)}` : ''}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'media')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '确认本机媒体引擎与镜头素材；也可以请用户在界面里导入素材。')
    }
  }
}

export const studioTimelineTool: ToolImpl = {
  definition: {
    name: 'studio_timeline',
    description: '读取时间线摘要，或把已有镜头/配音/配乐按顺序自动装配成时间线。已有片段时默认拒绝覆盖；只有用户明确同意后才传 force=true。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        action: { type: 'string', enum: ['get', 'build'], description: '动作' },
        force: { type: 'boolean', description: '已有片段时是否确认重建；会覆盖手动裁剪、音量与转场' }
      },
      required: ['projectId', 'action']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `时间线：${String(input.action ?? 'get')}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'timeline')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先确认镜头已有画面；已有剪辑时先征得用户同意再传 force=true。')
    }
  }
}

export const studioEditTool: ToolImpl = {
  definition: {
    name: 'studio_edit',
    description:
      '把用户的大白话修改要求翻译成创作台修改计划（不立即执行）。返回 planId、影响范围与费用；用户确认后再调用 apply-plan 应用。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        instruction: { type: 'string', description: '用户原话，例如“镜 03 慢 20%，雨声压低一点，不要改脸”' },
        selectionKind: { type: 'string', enum: ['chapter', 'shot', 'clip'], description: '当前选中的对象类型' },
        selectionId: { type: 'string', description: '当前选中的对象 id' },
        action: { type: 'string', enum: ['plan', 'apply-plan'], description: 'plan=出计划；apply-plan=应用已有计划' },
        planId: { type: 'string', description: 'apply-plan 时需要' }
      },
      required: ['projectId']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `创作修改计划：${oneLineInput(input, 'instruction', 40) || oneLineInput(input, 'planId', 20)}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'edit')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先读取作品并明确要修改的镜号或章节。')
    }
  }
}

export const studioReviewTool: ToolImpl = {
  definition: {
    name: 'studio_review',
    description: '检查作品连续性、缺失画面/配音、字幕、时间线引用与预算，返回可定位的问题列表。只读作品，不自动修改。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' }
      },
      required: ['projectId']
    },
    category: 'read',
    risk: 'low',
    titleFor: () => '检查创作台作品'
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'review')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '确认作品 id。')
    }
  }
}

export const studioRenderTool: ToolImpl = {
  definition: {
    name: 'studio_render',
    description: '把时间线与素材交给本机 FFmpeg 合成草稿或成片；长任务会排队并记录任务与结果，不伪造完成。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        quality: { type: 'string', enum: ['draft', 'final'], description: '草稿 540p 或成片 1080p/4K' },
        format: { type: 'string', enum: ['mp4', 'mov', 'mkv', 'webm'], description: '成片容器格式' },
        resolution: { type: 'string', enum: ['1080p', '2160p'], description: '成片清晰度' },
        subtitleMode: { type: 'string', enum: ['burn', 'soft'], description: '字幕烧录或软轨' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: '画幅' }
      },
      required: ['projectId', 'quality']
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => `${input.quality === 'final' ? '合成成片' : '合成草稿'}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'render')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '先检查画面、时间线和 FFmpeg。')
    }
  }
}

export const studioExportTool: ToolImpl = {
  definition: {
    name: 'studio_export',
    description: '把作品导出为成书、字幕、工程包或发布套组。文件落在作品 exports/ 并记录 SHA-256；不读取或转换旧应用项目。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '作品 id' },
        format: { type: 'string', enum: ['txt', 'md', 'epub', 'pdf', 'docx', 'srt', 'ass', 'package', 'cover', 'folder'], description: '导出格式' }
      },
      required: ['projectId', 'format']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `导出：${String(input.format ?? '')}`
  },
  async execute(input, ctx) {
    try {
      const result = await callStudio(ctx, input, 'export')
      return okResult(result.summary, result.data ? { studio: result.data } : undefined)
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err), '检查格式与作品内容；PDF/EPUB 需要作品里有章节。')
    }
  }
}

export const studioTools: ToolImpl[] = [
  studioProjectTool,
  studioCreateTool,
  studioBlueprintTool,
  studioWriteTool,
  studioStoryboardTool,
  studioMediaTool,
  studioTimelineTool,
  studioEditTool,
  studioReviewTool,
  studioRenderTool,
  studioExportTool
]
