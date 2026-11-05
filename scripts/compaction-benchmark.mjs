#!/usr/bin/env node
/**
 * 真实任务压缩基准（人工运行，不进入 CI）。
 *
 * 用法：
 *   npm run build:bench-lib        # 或手动 npx esbuild ...
 *   DEEPSEEK_KEY_FILE=C:/path/to/key.txt node scripts/compaction-benchmark.mjs
 *
 * 它用两类真实任务（工程/理科、长篇叙事/文科）比较不同压缩策略：
 * - truncate：只保留首条用户消息和最近消息（CliffCompaction 式纯截断基线）
 * - baseline：Morrow 旧版九段摘要 + 首/尾用户消息
 * - codex：Codex 的四点 handoff prompt + 最近用户消息
 * - v2：新的六段交接 prompt + 最近用户消息 + 确定性关键信息账本
 *
 * 指标：压缩率、关键事实保留率（KIR）、探针回答准确率、注意力偏移率（1 - 准确率）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const libPath = join(root, 'tmp', 'compaction-bench-lib.cjs')
if (!existsSync(libPath)) {
  execFileSync('cmd.exe', ['/d', '/s', '/c', `npx esbuild scripts/compaction-bench-entry.ts --bundle --platform=node --format=cjs --target=node22 --outfile=${libPath}`], {
    cwd: root,
    stdio: 'ignore'
  })
}
const { extractCompactionLedger, composeCompactionSummary, estimateMessagesTokens, planCompaction, applyCompaction, messagesToPreserve, aggressiveTrim } = require(libPath)

const keyFile = process.env.DEEPSEEK_KEY_FILE
const key = (readFileSync(keyFile, 'utf8').split(/\r?\n/).find((line) => /^sk-[A-Za-z0-9_-]{10,}$/.test(line.trim())) || '').trim()
if (!keyFile || !key) throw new Error('没有找到 DeepSeek Key；请设置 DEEPSEEK_KEY_FILE。')
const model = process.env.COMPACTION_BENCH_MODEL || 'deepseek-flash'

function message(role, text, id) {
  return { id, role, content: [{ type: 'text', text }], createdAt: Date.now() }
}
function textOf(messages) {
  return messages
    .map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    .join('\n')
}
function capSummaryText(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head - 24)
  return `${text.slice(0, head)}…（摘要中段省略）…${text.slice(-tail)}`
}
function textOfMessage(item) {
  return item.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}
function countTokens(messages) {
  return estimateMessagesTokens(messages, '')
}
function retention(text, facts) {
  const normalized = text.toLowerCase()
  const found = facts.filter((fact) => fact.aliases.some((alias) => normalized.includes(alias.toLowerCase())))
  return { found: found.length, total: facts.length, rate: found.length / facts.length }
}

const engineering = {
  name: '工程/理科：认证轮换修复',
  messages: [
    message('user', '修复 Node 22 的 token 轮换缺陷。硬约束：/api/v1/login 的响应结构不能变，旧客户端依赖 expires_in；不要修改 src/auth/session.ts 的公开导出；不新增 npm 依赖；SQLite 使用 WAL；本地验收端口 4317；截止 2026-11-05。测试命令是 npm test -- auth，覆盖率门槛 85%。', 'e1'),
    message('assistant', '先读 src/auth/session.ts、src/auth/rotate.ts、test/auth.test.ts。观察到 rotateToken 在并发请求下抛 SQLITE_BUSY: database is locked；现有实现没有显式事务。', 'e2'),
    message('user', '补充：移动端 refresh token 不要轮换，只有桌面端轮换；v1 客户端的 expires_in 必须继续返回。不要用“猜”的方式改并发。', 'e3'),
    message('assistant', '根因是读改写竞争，不是 token 算法。决定：SQLite 用 BEGIN IMMEDIATE 包住轮换，失败重试一次；拒绝引入 Redis，因为会新增依赖和部署面。', 'e4'),
    message('user', '审计日志表 audit_rotation 每发生一次成功轮换必须恰好一行；绝对不能记录 token 原文，只记录哈希和客户端类型。', 'e5'),
    message('assistant', '【工具结果】npm test -- auth：14 passed，2 failed。失败在 test/auth.test.ts 的并发轮换与移动端不轮换用例；报错 SQLITE_BUSY。', 'e6'),
    message('assistant', '实现文件：src/auth/rotate.ts 增加事务；migrations/0042_audit.sql 新建 audit_rotation；test/auth.test.ts 补桌面/移动端分支。不改 session.ts 的公开导出。', 'e7'),
    message('user', '验收时请给出：/api/v1/login 响应字段清单、移动端不轮换证据、audit 每轮换一行证据、npm test -- auth 结果和覆盖率。', 'e8'),
    message('assistant', '【工具结果】npm test -- auth：16 passed，0 failed；coverage 86.4%。audit 用例通过；移动端 refresh token 在 3 次请求中保持同一值。', 'e9'),
    message('assistant', '【工具结果】git diff --stat：src/auth/rotate.ts +42/-11，migrations/0042_audit.sql +18，test/auth.test.ts +57/-4。没新增 package.json 依赖。', 'e10'),
    message('user', '记住截止日期 2026-11-05 和端口 4317；不要把“覆盖率 86.4%”改成估算值。', 'e11'),
    message('assistant', '剩余风险：旧客户端若依赖 expires_in 的秒级类型，迁移时保持 number；回滚方案是撤销 rotate.ts 事务并保留 migration。下一步做一次真实 API 冒烟。', 'e12'),
    message('assistant', '【API 契约】POST /api/v1/login 仍返回 access_token、refresh_token、expires_in；expires_in=3600 秒，保持 number。错误码 401/403 的 JSON 形状不变，不新增字段。', 'e13'),
    message('user', '不要改错误码和错误 JSON；不要删除旧的 refresh_token 字段；最终交付要包含 API diff、测试日志和 rollback 步骤。', 'e14'),
    message('assistant', 'rotate.ts 方案：BEGIN IMMEDIATE 后读取 refresh 记录，按 client_type 判断；桌面端写新 token 和 audit，移动端只更新 last_seen。冲突时回滚并重试一次。', 'e15'),
    message('assistant', 'audit_rotation 列：id、token_hash(SHA-256)、client_type、created_at；没有 token 原文字段。迁移 0042 可独立回滚。', 'e16'),
    message('assistant', '【工具结果】API smoke：login 返回 expires_in 3600；desktop 轮换后旧 refresh 失效；mobile 连续 3 次 refresh 值不变。', 'e17'),
    message('user', '验收证据必须包含以上三条；不要把 mobile 不轮换写成 desktop 也不轮换。', 'e18'),
    message('assistant', '代码审查结论：session.ts 公开导出未改；package.json 无新增依赖；test/auth.test.ts 覆盖并发、移动端、错误码；剩余仅真实环境部署验证。', 'e19'),
    message('assistant', '【性能】并发轮换 p95 从 42ms 降到 38ms；SQLite WAL 下 50 并发桌面轮换全部成功，0 次 SQLITE_BUSY；移动端请求不写 audit。', 'e20'),
    message('user', '旧桌面客户端还要支持 90 天；保留 X-Client-Version 兼容；速率限制不能低于 5 次/分钟；日志里不能出现任何 token 或用户邮箱。', 'e21'),
    message('assistant', '安全复核：速率限制保持 5/min；日志只写 token_hash 前缀和 client_type；错误响应不包含 SQL 或堆栈；migration 0042 可单独回滚。', 'e22'),
    message('user', '再跑一次 50 并发的真实测试，确认没有 SQLITE_BUSY，并且 audit_rotation 行数等于成功轮换数。', 'e23'),
    message('assistant', '【工具结果】50 并发测试：50 passed，0 SQLITE_BUSY；audit_rotation 新增 50 行，与成功轮换数一致；p95 38ms。', 'e24'),
    message('user', '最终验收：/api/v1/login 字段不变、mobile 不轮换、audit 一行一轮换、50 并发通过、无新依赖；把证据写进交付说明。', 'e25'),
    message('assistant', '最终状态：验收项全部通过；未执行生产部署，只做了本地端口 4317 的真实 API 冒烟。剩余动作是让运维选择生产服务器。', 'e26'),
    message('assistant', '【并发日志】50 个桌面客户端同时轮换：request-01..50 全部成功，SQLITE_BUSY 计数 0；p95 38ms，峰值内存 82MB；移动端请求只更新 last_seen。', 'e27'),
    message('user', '再跑 typecheck 和 lint；不要改 tsconfig 的 target；Node 版本必须是 22；最终测试数要写真实结果，不要写 16。', 'e28'),
    message('assistant', '【工具结果】node --version：v22.14.0；npm run typecheck：0 errors；npm run lint：0 errors；npm test -- auth：18 passed，0 failed。', 'e29'),
    message('assistant', 'API diff 详情：expires_in 仍是 number=3600；refresh_token 仍是 string；未新增字段；401/403 错误 JSON 形状不变。旧桌面客户端不带 X-Client-Version 时按 desktop v1 处理并轮换。', 'e30'),
    message('user', '旧桌面客户端如果不带 X-Client-Version，也必须正常轮换；移动端无论版本都不能轮换。把这两个分支都写进最终验收。', 'e31'),
    message('assistant', '已补 fallback：缺少 X-Client-Version 视为 desktop v1；UA 为移动端则不轮换。新增 2 个测试后共 18 passed；coverage 87.1%。', 'e32'),
    message('assistant', '【工具结果】最终验收：18 passed，coverage 87.1%，audit_rotation 50 行，安全日志无 token 原文；migration 0042 可独立回滚。', 'e33'),
    message('user', '最终事实以 18 passed 和 87.1% 为准；不要保留旧的 16 passed/86.4% 作为结论。', 'e34'),
    message('assistant', '最终交付状态：18 passed、coverage 87.1%、50 并发通过、mobile 不轮换、desktop 旧版兼容、audit 50 行；生产部署仍待运维确认。', 'e35')
  ],
  facts: [
    { label: 'expires_in', aliases: ['expires_in'] },
    { label: '不改 session.ts 公开导出', aliases: ['src/auth/session.ts', '公开导出'] },
    { label: '不新增依赖/拒绝 Redis', aliases: ['不新增 npm 依赖', 'Redis', '新增依赖'] },
    { label: 'SQLite WAL / BEGIN IMMEDIATE', aliases: ['sqlite', 'begin immediate', 'wal'] },
    { label: '端口 4317', aliases: ['4317'] },
    { label: '截止 2026-11-05', aliases: ['2026-11-05'] },
    { label: '移动端不轮换', aliases: ['移动端', '桌面端'] },
    { label: 'audit 每轮换一行且不记录 token', aliases: ['audit_rotation', '一行', 'token'] },
    { label: '18 passed', aliases: ['18 passed', '18 个通过'] },
    { label: '覆盖率 87.1%', aliases: ['87.1'] },
    { label: 'SQLITE_BUSY', aliases: ['sqlite_busy'] },
    { label: '测试命令 npm test -- auth', aliases: ['npm test -- auth'] },
    { label: 'migration 0042', aliases: ['0042'] },
    { label: '50 并发通过', aliases: ['50 并发', '50 个并发', '50 passed', '50 行'] },
    { label: 'audit 一行一轮换', aliases: ['audit_rotation', '一行'] }
  ],
  probes: [
    { question: '必须继续返回的旧字段是什么？', expected: [['expires_in']], forbidden: [] },
    { question: '移动端 refresh token 的约束是什么？', expected: [['不轮换'], ['移动端']], forbidden: ['移动端轮换', '移动端需要轮换'] },
    { question: '最终测试通过数和覆盖率分别是多少？', expected: [['18'], ['87.1']], forbidden: [] },
    { question: '审计日志一次成功轮换写几行，能否记录 token 原文？', expected: [['一行', '1 行'], ['不记录', '不能记录', '不会记录', '只记录哈希']], forbidden: ['记录 token 原文', '记录原文'] },
    { question: '回滚方案涉及哪一个 migration？', expected: [['0042']], forbidden: [] },
    { question: '部署到哪台生产服务器？', expected: [['不知道', '未提供', '没有提供', '上下文没有']], forbidden: ['已部署', '生产服务器是'] }
  ]
}

const literature = {
  name: '长篇叙事/文科：钟楼来信',
  messages: [
    message('user', '写一部民国悬疑长篇：第一人称，叙述者是林晚；不要重生、不要系统、不要穿越；共 8 章，每章约 3000 字；克制、慢热，不用狗血误会；暴力只写后果。关键人物：林晚（报社校对）、沈砚（钟表匠）、周鹤（巡捕）。', 'l1'),
    message('assistant', '第 1 章《雪落钟楼》：林晚在报社校样上发现一行不属于任何人的蓝铅笔字——“七天后，钟楼会停”。她回到租界边的钟表铺，沈砚正在修一只停在四点十七分的怀表。', 'l2'),
    message('user', '补充设定：沈砚有个失踪的哥哥沈川，暂不告诉读者他在哪；林晚不能会武功；信件的红蜡封上有一个“鹤”字。时间线是 1937 年冬，撤离前的最后七天。', 'l3'),
    message('assistant', '第 2 章《蜡封》：林晚在钟楼夹层找到一封带鹤字蜡封的信，信纸上是沈砚的字，却写着“不要相信周鹤”。她把信藏进校样夹，决定先不告诉沈砚。', 'l4'),
    message('assistant', '第 3 章《四点十七分》：周鹤来钟表铺调查失踪案，问起沈川。沈砚说哥哥三年前去了香港，但林晚发现他说谎时会摸左腕的旧表带。', 'l5'),
    message('user', '第 6 章必须让林晚发现信纸有夹层，夹层里是一张钟楼地下室的平面图；但不要提前揭示沈川的结局。结尾章才揭示沈川一直被困在钟楼地下。', 'l6'),
    message('assistant', '第 4 章《鹤字》：林晚查报社旧档，发现周鹤三年前经手过一宗钟楼失火案；沈川的名字出现在失踪者名单最后一页，但被蓝铅笔划掉。', 'l7'),
    message('assistant', '第 5 章《停摆》：钟楼连续两晚在四点十七分停摆；沈砚修好后又故意让齿轮卡住。林晚开始怀疑他在拖住某个人，而不是修钟。', 'l8'),
    message('user', '风格验收：保持第一人称有限视角；林晚不知道的事情不能写进她的叙述；不要用“命运的齿轮”这类陈词；每章结尾留一个小钩子，但不要故弄玄虚。', 'l9'),
    message('assistant', '【编辑检查】第 1–5 章共 15,260 字，第一人称一致；无重生/系统元素；红蜡封“鹤”字段落 2 处；夹层尚未揭示。连续性检查：林晚的校样夹在第 2 章后一直带在身边。', 'l10'),
    message('assistant', '第 6 章《夹层》：林晚在校样夹里发现信纸受潮起层，揭开后得到钟楼地下平面图；她意识到沈砚一直在等一个能读懂图纸的人，而不是等周鹤。', 'l11'),
    message('assistant', '第 7 章《地下》：林晚按平面图进入钟楼地下，听见齿轮后面有人敲击；周鹤同时封锁钟楼。她没有武功，只能用报社通行证支开守门人。', 'l12'),
    message('user', '最后提醒：结局必须让沈川活着出现，但不要写他如何获救；林晚和沈砚不一定要在一起；最后一句保留钟声。', 'l13'),
    message('assistant', '第 8 章《钟声》：沈川被从地下带出，沈砚承认三年前为保护弟弟伪造了香港来信；周鹤的旧案被重新调查。结尾林晚在钟声里烧掉校样，但没有回答她是否原谅沈砚。', 'l14'),
    message('assistant', '第 2 章补写：林晚把信藏进校样夹时，指尖沾到红蜡；她想起周鹤三年前在钟楼火灾现场也有一枚同样的蜡封，但没有直接证据。', 'l15'),
    message('user', '周鹤不能写成纯反派；他也在找沈川，只是方法更冷。林晚不知道他的真实立场，保持有限视角。', 'l16'),
    message('assistant', '第 3–4 章细节：钟表铺在霞飞路尽头；沈砚修表时左手小指会轻敲桌面；蓝铅笔字只在紫外灯下显形；旧档室在报社三楼，窗户漏风。', 'l17'),
    message('assistant', '第 5 章《停摆》：钟楼连续两晚停在四点十七分；沈砚说是发条老化，但林晚发现齿轮被人为垫了薄铜片。她没有拆穿，只把铜片收进口袋。', 'l18'),
    message('user', '第 7 章让林晚用报社通行证支开守门人，不要让她会武功；周鹤封锁钟楼时不要开枪。', 'l19'),
    message('assistant', '第 7 章细纲：林晚用“报社夜间校样”通行证进入钟楼；守门人认识她，放行但要求天亮前出来。周鹤带人封锁正门，林晚从地下通风口进入。', 'l20'),
    message('user', '最后一句保留钟声，但不要点明林晚和沈砚是否在一起；沈川活着出现，不写获救过程。', 'l21'),
    message('assistant', '第 2 章未采用的开头：林晚在校样边角画了一只停摆的钟，后来被主编用红笔圈掉；这个细节保留到第 7 章才再次出现。', 'l22'),
    message('assistant', '第 4 章旧档细节：钟楼失火案卷宗编号 1937-04；周鹤的签名在最后一页；沈川的失踪记录被蓝铅笔划掉，旁边写着“已迁”。', 'l23'),
    message('user', '周鹤不是纯反派，他也在找沈川；但林晚不能知道他的真实立场，保持第一人称有限视角。', 'l24'),
    message('assistant', '第 6 章夹层细节：信纸受潮后分层，夹层是一张钟楼地下平面图；图纸背面有沈川的缩写“S.C.”，林晚没有告诉沈砚。', 'l25'),
    message('assistant', '第 7 章地下：林晚用报社通行证进入钟楼，守门人认识她；周鹤封锁正门但没开枪；她听到齿轮后有敲击声。', 'l26'),
    message('user', '第 8 章结局：沈川活着出现，但不写具体获救过程；不要写林晚和沈砚确定关系；最后一句保留钟声。', 'l27'),
    message('assistant', '第 8 章：沈川被从地下带出，沈砚承认伪造香港来信是为了保护弟弟；周鹤的旧案重新调查；林晚烧掉校样，没有回答是否原谅沈砚。最后一句是钟声。', 'l28'),
    message('assistant', '【连续性检查】8 章、第一人称、无重生/系统；红蜡封鹤字、四点十七分、校样夹、平面图、沈川缩写 S.C. 均已回收；林晚不会武功。', 'l29')
  ],
  facts: [
    { label: '第一人称林晚', aliases: ['第一人称', '林晚'] },
    { label: '不要重生/系统/穿越', aliases: ['不要重生', '不要系统', '不要穿越'] },
    { label: '8 章约 3000 字', aliases: ['8 章', '8章', '3000'] },
    { label: '沈砚是钟表匠', aliases: ['沈砚', '钟表匠'] },
    { label: '周鹤是巡捕', aliases: ['周鹤', '巡捕'] },
    { label: '沈川是沈砚哥哥', aliases: ['沈川', '哥哥'] },
    { label: '红蜡封鹤字', aliases: ['红蜡封', '鹤字'] },
    { label: '1937 年冬/撤离前七天', aliases: ['1937', '七天'] },
    { label: '第 6 章发现夹层平面图', aliases: ['夹层', '平面图'] },
    { label: '钟楼四点十七分停摆', aliases: ['四点十七分'] },
    { label: '林晚校样夹', aliases: ['校样夹'] },
    { label: '结局沈川活着出现', aliases: ['沈川', '活着'] },
    { label: '最后一句保留钟声', aliases: ['钟声', '最后一句'] },
    { label: '周鹤与钟楼失火旧案', aliases: ['失火'] },
    { label: '沈砚伪造香港来信保护弟弟', aliases: ['香港来信'] }
  ],
  probes: [
    { question: '叙述者是谁，使用什么人称？', expected: [['林晚'], ['第一人称']], forbidden: [] },
    { question: '信纸夹层里是什么，出现在第几章？', expected: [['平面图'], ['第 6 章', '第6章', '6 章']], forbidden: [] },
    { question: '结局对沈川和钟声有什么要求？', expected: [['沈川'], ['活着'], ['钟声']], forbidden: ['沈川死亡', '沈川死了'] },
    { question: '林晚是否会武功？她如何支开守门人？', expected: [['不会'], ['通行证']], forbidden: ['会武功', '用武功'] },
    { question: '周鹤与三年前的什么案件有关？', expected: [['失火', '钟楼'], ['旧案', '案件']], forbidden: [] },
    { question: '沈砚为什么伪造香港来信？', expected: [['保护'], ['弟弟', '沈川']], forbidden: ['抛弃弟弟'] },
    { question: '林晚的母亲叫什么？', expected: [['不知道', '未提供', '没有提供', '上下文没有']], forbidden: ['母亲叫'] }
  ]
}

const oldPrompt = [
  '你是对话压缩器，也是长任务交接摘要器。把历史对话压缩成一份让另一个同款代理不看原文也能继续工作的结构化交接摘要。',
  '严格按以下标题输出；没有内容写“无”：',
  '## 目标与用户意图',
  '## 硬约束与偏好（逐字保留用户明确要求与禁止项）',
  '## 已完成与关键决策',
  '## 文件与改动（路径、用途、关键改动结论）',
  '## 命令、测试与真实结果',
  '## 错误与修复',
  '## 当前状态（进行到哪一步，哪些动作已经执行）',
  '## 未完成与下一步',
  '## 必须保留的数据（数字、ID、URL、引用）',
  '规则：路径、命令、数字、错误信息原文照抄；不编造；不调用工具；不向用户提问；只输出摘要正文。'
].join('\n')

const codexPrompt = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.'
].join('\n')

const v2Prompt = [
  '你是上下文检查点压缩器（CONTEXT CHECKPOINT COMPACTION）。为另一个将接续任务的同款 Agent 写交接摘要。',
  '只总结【新增历史】；【已有摘要】仅用于理解，不要改写、复述或合并它。',
  '严格按以下标题输出；没有内容写“无”：',
  '## 目标与验收',
  '## 硬约束与用户偏好（逐字保留要求、禁止项、数字与版本）',
  '## 已完成与关键决策',
  '## 文件、命令与测试证据（路径、命令、真实结果）',
  '## 错误、风险与回滚',
  '## 未完成与下一步',
  '## 故事/研究事实与关键数据（人物、设定、时间线、伏笔；非叙事任务写“无”）',
  '规则：路径、命令、数字、错误信息原文照抄；不编造；不调用工具；不向用户提问；只输出摘要正文。',
  '优先写“下一位 Agent 必须知道什么”，不要按时间流水账复述。'
].join('\n')

async function chat(messages, maxTokens = 900, temperature = 0) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(120_000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`)
  const data = JSON.parse(text)
  return String(data.choices?.[0]?.message?.content ?? '').trim()
}

async function runFixture(fixture) {
  const beforeTokens = countTokens(fixture.messages)
  const beforeText = textOf(fixture.messages)
  // 人为收紧窗口，强制触发真实 planCompaction；这样比较的是压缩后的真实消息数组，
  // 而不是把完整历史与摘要简单拼接。
  const contextLimit = Math.max(2_400, Math.ceil(beforeTokens / 0.85))
  const summaryBudgetChars = Math.max(700, Math.floor(contextLimit * 0.08))
  const ledgerBudgetChars = Math.max(400, Math.floor(contextLimit * 0.08))
  const plan = planCompaction(fixture.messages, '', contextLimit, { keepRecent: 3, targetRatio: 0.45 })
  const cut = plan.shouldCompact ? plan.cutIndex : Math.max(1, fixture.messages.length - 4)
  const older = fixture.messages.slice(0, cut)
  const preserveBudget = plan.preserveUserTokens ?? 0
  const preserved = messagesToPreserve(fixture.messages, cut, preserveBudget)
  const ledgerSource = older.filter((item) => !preserved.includes(item))
  const serialized = older.map((item) => `【${item.role === 'user' ? '用户' : '助手'}】${textOfMessage(item)}`).join(String.fromCharCode(10))
  const rows = []
  const strategies = ['truncate', 'baseline', 'codex', 'v2']
  for (const strategy of strategies) {
    let summary = ''
    let ledger = ''
    if (strategy !== 'truncate') {
      const prompt = strategy === 'baseline' ? oldPrompt : strategy === 'codex' ? codexPrompt : v2Prompt
      summary = await chat([
        { role: 'system', content: prompt },
        { role: 'user', content: serialized }
      ], 3000)
      if (summary.trim().length < 40) {
        summary = await chat([
          { role: 'system', content: prompt },
          { role: 'user', content: `请输出中文交接摘要，不要只写“无”。必须覆盖约束、已完成、文件/命令、下一步。
${serialized}` }
        ], 3000)
      }
      summary = capSummaryText(summary, summaryBudgetChars)
      if (strategy === 'v2') {
        const rawLedger = extractCompactionLedger(ledgerSource, ledgerBudgetChars)
        const storyLedger = rawLedger.includes('### 故事/研究事实')
        const v2SummaryBudget = storyLedger
          ? Math.max(500, Math.floor(summaryBudgetChars * 0.75))
          : Math.max(420, Math.floor(summaryBudgetChars * 0.55))
        const v2LedgerBudget = storyLedger ? ledgerBudgetChars : Math.min(ledgerBudgetChars, 250)
        summary = capSummaryText(summary, v2SummaryBudget)
        ledger = extractCompactionLedger(ledgerSource, v2LedgerBudget)
      }
    }
    let compactedMessages
    if (strategy === 'truncate') {
      compactedMessages = [fixture.messages[0], ...fixture.messages.slice(-4)].filter(Boolean)
    } else {
      const text = strategy === 'v2'
        ? composeCompactionSummary('', summary, ledger, summaryBudgetChars + ledgerBudgetChars)
        : summary
      compactedMessages = applyCompaction(fixture.messages, cut, text, strategy === 'baseline' ? 0 : preserveBudget)
      if (countTokens(compactedMessages) > beforeTokens * 0.6) {
        compactedMessages = aggressiveTrim(compactedMessages, '', contextLimit, 3)
      }
    }
    const compacted = textOf(compactedMessages)
    const compactedTokens = countTokens(compactedMessages)
    const kir = retention(compacted, fixture.facts)
    let probeHits = 0
    let contradictions = 0
    const probeDetails = []
    for (const probe of fixture.probes) {
      const answer = await chat([
        { role: 'system', content: '你只能依据给出的交接上下文回答；不知道就明确说不知道。请用简短中文回答。' },
        { role: 'user', content: `【交接上下文】
${compacted}

【问题】${probe.question}` }
      ], 500)
      const hit = probe.expected.every((group) => group.some((keyword) => answer.includes(keyword)))
      const contradicted = (probe.forbidden ?? []).some((keyword) => {
        const index = answer.indexOf(keyword)
        if (index < 0) return false
        const prefix = answer.slice(Math.max(0, index - 8), index)
        return !/(不|不能|不会|不要|禁止|绝不|未|没)/.test(prefix)
      })
      if (hit) probeHits += 1
      if (contradicted) contradictions += 1
      probeDetails.push({ question: probe.question, answer: answer.slice(0, 240), hit, contradicted })
    }
    rows.push({
      strategy,
      cutIndex: cut,
      beforeTokens,
      afterTokens: compactedTokens,
      compression: Number((compactedTokens / beforeTokens).toFixed(3)),
      kir: kir.rate,
      kirFound: `${kir.found}/${kir.total}`,
      probeAccuracy: Number((probeHits / fixture.probes.length).toFixed(2)),
      contradictionRate: Number((contradictions / fixture.probes.length).toFixed(2)),
      probeDetails,
      summaryChars: summary.length,
      ledgerChars: ledger.length,
      beforeFacts: retention(beforeText, fixture.facts).rate
    })
  }
  return { name: fixture.name, beforeTokens, rows }
}

const results = []
for (const fixture of [engineering, literature]) {
  console.log(`[benchmark] ${fixture.name}`)
  const result = await runFixture(fixture)
  results.push(result)
  for (const row of result.rows) {
    console.log(`  ${row.strategy.padEnd(8)} tokens ${row.beforeTokens}->${row.afterTokens} (${Math.round(row.compression * 100)}%) KIR ${row.kirFound} probe ${row.probeAccuracy}`)
  }
}

const reportDir = join(root, 'tmp', 'verification', 'benchmarks')
mkdirSync(reportDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
const md = [
  '# 上下文压缩真实任务基准',
  '',
  `运行日期：${stamp} · 模型：${model} · 样本：工程/理科 + 长篇叙事/文科`,
  '',
  '指标：KIR = 关键事实在压缩后上下文中的保留率；探针准确率 = 用压缩后上下文回答事实问题的正确率；注意力偏移率 = 1 - 探针准确率；压缩率 = 压缩后 tokens / 压缩前 tokens。',
  '',
  ...results.flatMap((result) => [
    `## ${result.name}`,
    '',
    `压缩前约 ${result.beforeTokens} tokens。`,
    '',
    '| 策略 | tokens 后 | 压缩率 | KIR | 探针准确率 | 偏移率 | 矛盾率 | 摘要字符 | 账本字符 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...result.rows.map((row) => `| ${row.strategy} | ${row.afterTokens} | ${Math.round(row.compression * 100)}% | ${row.kirFound} (${Math.round(row.kir * 100)}%) | ${Math.round(row.probeAccuracy * 100)}% | ${Math.round((1 - row.probeAccuracy) * 100)}% | ${Math.round(row.contradictionRate * 100)}% | ${row.summaryChars} | ${row.ledgerChars} |`),
    ''
  ]),
  '## 说明',
  '',
  '- `truncate` 是纯截断基线，对应 CliffCompaction 一类“不做摘要改写”的策略；',
  '- `baseline` 是 Morrow 旧版九段摘要；`codex` 使用 Codex 公开的四点 handoff prompt；',
  '- `v2` 使用新的六段交接 prompt + 最近用户消息预算 + 确定性关键信息账本；',
  '- 探针由同一模型回答，存在模型自身波动；结论应结合 KIR 与真实任务回归一起看。'
].join('\n')
writeFileSync(join(reportDir, `compaction-benchmark-${stamp}.md`), `${md}\n`, 'utf8')
writeFileSync(join(reportDir, `compaction-benchmark-${stamp}.json`), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
console.log(`[benchmark] wrote ${join(reportDir, `compaction-benchmark-${stamp}.md`)}`)
