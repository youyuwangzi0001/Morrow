/**
 * 用本机 ComfyUI + Qwen-Image-2.1 Turbo 生成创作台样例画面。
 * 仅开发期使用；不进入应用运行时。
 *
 * 用法：node scripts/gen-studio-demo-qwen.mjs scenes|refs|covers
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = 'http://127.0.0.1:8188'
const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'resources', 'studio-demo')
const sigmas = '1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0.0'

const look = '写实电影摄影，中国都市奇幻短片。二十六岁的中国女性修伞匠林晚：短黑发、清秀克制的面孔、深色旧围裙、米色针织衫、手上有细小劳作痕迹。'
const mood = '低饱和青灰与暖金对比，潮湿反光，浅景深，轻微胶片颗粒，真实皮肤与布料质感，情绪克制。'
const negative = '文字，字幕，水印，logo，低质量，畸形手，多余手指，六根手指，塑料感，过度锐化，夸张 HDR，现代高楼，网红脸，浓妆'

const prompts = {
  'drama-01': `电影剧照。雨夜的老街伞铺门口，暖黄灯从木门里透出，潮湿的青石路反光。${look}她站在门边收起一把黑伞，神情克制，望向雨里。中景，16:9。${mood}`,
  'drama-02': `电影微距特写。${look}她的双手正在工作台上拆修一把黑伞，铁制伞骨锈得像旧伤，一根极细的红线缠在伞骨之间，泛着微弱金光。暖色台灯，窗外雨声，浅景深，16:9。${mood}`,
  'drama-03': `电影剧照。雨夜伞铺木门外，一个二十岁左右的中国少年，黑发湿透，穿着不合季节的薄外套，双手捧着一把黑伞站在雨里。门内暖光勾出他的侧脸和肩线，他抬头看向门里的人。中景，16:9。${mood}`,
  'drama-04': `电影剧照。从修伞女孩肩后拍向工作台，桌上散着拆开的黑伞、铁伞骨、细针与红线。她的双手在灯下动作，窗外雨痕模糊，暖黄灯光只照亮桌面。中景，16:9。${mood}`,
  'drama-05': `电影极端特写。黑伞的深色伞面上有一道极细的红线，像针尖划过的河；一只年轻女性的手拿着针，红线被灯照得微微发亮。背景是深色木桌与虚化的雨夜。微距，浅景深，16:9。${mood}`,
  'drama-06': `电影回忆镜头。雨夜伞铺深处，金色水汽与雨丝里站着一位中国老妇人，银灰发髻、旧开衫、药箱，轮廓柔和模糊；前景是一个年轻女性的背影。暖金与深青对比，柔焦，颗粒感，16:9。${mood}`,
  'drama-07': `电影超现实镜头。雨夜老街，雨丝向上飞，水面浮起金色光点；${look}她仰头看向天空，手里握着一把半开的黑伞，一只纸鹤在雨里飞过。中景，16:9，魔法现实主义。${mood}`,
  'drama-08': `电影双人镜头。旧伞铺柜台两侧，${look}她与湿透的少年相对站着，中间是一把黑伞。暖黄灯与雨窗做背景，两人距离很近却没有触碰，神情克制。侧向中近景，16:9。${mood}`,
  'drama-09': `电影人物特写。${look}她的脸占画面一半，暖光照亮一侧，另一侧沉在雨窗的阴影里；眼睛失焦，像正在忘记一个重要的人。前景有一根模糊的红线。特写，16:9。${mood}`,
  'drama-10': `电影空镜。雨停的一瞬，老街上的雨滴悬在半空，青石路反光；伞铺门口靠着两把伞，一把黑色、一把纸伞。远处旧钟楼的轮廓，深青夜色与金色路灯。全景，16:9，安静到能听见心跳。${mood}`,
  'drama-11': `电影近景。隔着旧木柜台，${look}她把一把修好的黑伞递给一个湿透的年轻少年；两只手在伞柄两端，几乎触碰。门内暖光，门外冷雨，克制的告别。中近景，16:9。${mood}`,
  'drama-12': `电影晨景。雨停后的清晨，老街伞铺的木门打开，天光是淡青灰；门口湿石阶上放着一把黑伞，伞面上停着一只纸鹤。门内一盏暖灯还亮着。全景，16:9，温柔的释然。${mood}`,
  'ref-linwan': `角色设定照。${look}正面三分之四肖像，表情平静克制，深色伞铺背景虚化，暖色轮廓光，真实皮肤质感。竖幅 3:4 肖像，无文字。${mood}`,
  'ref-boy': `角色设定照。二十岁左右的中国少年，黑发被雨打湿，瘦削，薄外套，眼神安静、戒备又脆弱。深青雨夜背景虚化，柔和侧光，真实皮肤质感。竖幅 3:4 肖像，无文字。${mood}`,
  'ref-grandma': `角色设定照。中国老妇人，约七十岁，银灰发髻，旧开衫，温和而疲惫的眼神，像只存在于记忆里。暖金虚化背景，柔焦与胶片颗粒。竖幅 3:4 肖像，无文字。${mood}`,
  'drama-cover': `电影海报主视觉，竖幅。雨夜老街上空悬浮着一把倒着撑开的黑伞，伞下有一根发亮的红线与一只纸鹤；远处伞铺门内透出暖黄灯，一个年轻女性的剪影站在光里。深青与金色，魔法现实主义，无任何文字。${mood}`,
  'novel-cover': `书籍封面插画，竖幅。梅雨季节的旧伞铺，木架上排着纸伞与黑伞，门外是潮湿的老街；一个年轻女性的剪影站在门内，暖灯与青灰雨色交织。文学感，克制，无任何文字。${mood}`,
  'short-cover': `书籍封面插画，竖幅。旧木柜台上放着一封被雨泡皱的信和一把黑伞，窗玻璃上满是雨痕，一只纸鹤停在信上；青灰与暖金，安静，无任何文字。${mood}`
}

const sizes = {
  'ref-linwan': [768, 1024],
  'ref-boy': [768, 1024],
  'ref-grandma': [768, 1024],
  'drama-cover': [768, 1024],
  'novel-cover': [768, 1024],
  'short-cover': [768, 1024]
}

function graph(prompt, width, height, seed) {
  return {
    unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-2.1-turbo-Q6_K.gguf' } },
    cache: { class_type: 'QwenImage21Cache', inputs: { model: ['unet', 0], device: 'auto', dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_bf16.safetensors', type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    text: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['clip', 0], prompt, negative_prompt: negative, resolution: 1024 } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['cache', 0], positive: ['text', 0], negative: ['text', 1], cfg: 1.0 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed, control_after_generate: 'fixed' } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas } },
    sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['latent', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'morrow/demo' } }
  }
}

async function generate(name, prompt, width, height, seed) {
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph(prompt, width, height, seed), client_id: 'morrow-demo' })
  })
  const data = await res.json()
  if (!data.prompt_id) throw new Error(`${name}: ${JSON.stringify(data)}`)
  const id = data.prompt_id
  const started = Date.now()
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1000))
    const history = await (await fetch(`${base}/history/${id}`)).json()
    const item = history[id]
    if (!item) continue
    if (item.status?.status_str === 'error') throw new Error(`${name}: ComfyUI 执行失败`)
    const files = []
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        if (typeof value.filename === 'string') files.push(value)
        Object.values(value).forEach(walk)
      }
    }
    walk(item.outputs ?? {})
    const file = files[0]
    if (!file) throw new Error(`${name}: 没有输出文件`)
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const image = await fetch(`${base}/view?${query}`)
    const buffer = Buffer.from(await image.arrayBuffer())
    const target = join(outDir, `${name}.png`)
    writeFileSync(`${target}.tmp`, buffer)
    renameSync(`${target}.tmp`, target)
    console.log(`done ${name} · ${width}×${height} · ${Math.round((Date.now() - started) / 1000)}s`)
    return
  }
  throw new Error(`${name}: 超时`)
}

const mode = process.argv[2] ?? 'scenes'
const selections =
  mode === 'refs'
    ? ['ref-linwan', 'ref-boy', 'ref-grandma']
    : mode === 'covers'
      ? ['drama-cover', 'novel-cover', 'short-cover']
      : Array.from({ length: 12 }, (_, index) => `drama-${String(index + 1).padStart(2, '0')}`)

if (!existsSync(outDir)) {
  console.error('missing output dir', outDir)
  process.exit(1)
}
for (const [index, name] of selections.entries()) {
  const [width, height] = sizes[name] ?? [1344, 768]
  const seed = 482731 + index * 1171
  // 第一镜沿用已经生成并验收过的画面（同一条提示词）
  if (name === 'drama-01' && existsSync(join(root, 'tmp-demo-test.png'))) {
    console.log('keep tested drama-01')
    continue
  }
  await generate(name, prompts[name], width, height, seed)
}
console.log('batch complete')
