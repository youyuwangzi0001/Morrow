/**
 * 画布编辑器控制器：多标签文档、文件读写、脏标记、外部修改冲突、保存/另存、版本历史入口。
 *
 * 与 Canvas 的分工：Canvas 负责渲染（tabs/header/body/dialog/history drawer），
 * 这里负责状态机与主进程调用，便于单元测试和后续复用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { previewKindForFileName, type FilePreviewKind } from '@shared/file-types'
import type { Artifact } from '@shared/types'
import { useAppStore } from '../../store'
import { languageForPath, type EditorLanguage } from '../../components/languages'
import { dispatchFilesChanged, filesApi } from '../files/files-client'
import {
  archiveList,
  createFile,
  diffHistory,
  documentPreview,
  docxHtml,
  fileNameOf,
  isConflictError,
  isReadOnlyMode,
  joinWorkspacePath,
  listHistory,
  normalizeRelativePath,
  pptxPreview,
  previewFile,
  readFile,
  recordHistory,
  relativeToWorkspace,
  restoreHistory,
  statFile,
  writeFile,
  xlsxPreview,
  type HistorySource,
  type HistoryVersion
} from './editor-api'
import { errorText } from '../../lib'

export interface EditorDocument {
  id: string
  /** 磁盘上的绝对路径（只读产物可能带 artifact:// 前缀） */
  absPath: string
  /** 工作区相对路径（posix）；只读产物为空 */
  relPath: string
  workspace: string | null
  title: string
  language: EditorLanguage
  content: string
  /** 最近一次保存/加载的内容，用于脏标记与 diff */
  baseline: string
  mtimeMs: number | null
  size: number | null
  dirty: boolean
  readOnly: boolean
  loading: boolean
  error: string | null
  binary: boolean
  truncated: boolean
  /** 文档预览类型；text 走编辑器，其余走只读预览 */
  previewKind: 'text' | FilePreviewKind
  /** 图片/PDF/音视频的受控本地地址 */
  previewUrl: string | null
  mime: string | null
  /** 预览降级/截断等说明 */
  previewNote: string | null
  /** 外部修改冲突提示（保存前被外部修改 / 读取时发现） */
  conflict: string | null
  /** Markdown/HTML 预览态 */
  preview: boolean
  /** 历史基线是否已记录（内部用，避免重复调用） */
  baselineRecorded?: boolean
}

export type EditorDialog =
  | { kind: 'close-doc'; docId: string }
  | { kind: 'close-canvas' }
  | { kind: 'save-as'; docId: string }

export interface EditorHistorySelection {
  version: HistoryVersion
  patch: string
  added: number
  removed: number
  targetLabel: string
}

const CONFLICT_PREFIX = '文件在编辑器打开后被外部修改了'

function docIdFor(absPath: string): string {
  return `doc:${absPath.replace(/\\/g, '/').toLowerCase()}`
}



export function useEditorDocs(): {
  docs: EditorDocument[]
  activeDoc: EditorDocument | null
  activeDocId: string | null
  workspace: string | null
  readOnlyMode: boolean
  theme: 'dark' | 'light'
  selectDoc: (id: string | null) => void
  openPath: (relativePath: string, absolutePath?: string) => Promise<void>
  openArtifact: (artifact: Artifact, content: string) => void
  updateContent: (id: string, content: string) => void
  togglePreview: (id: string) => void
  saveDoc: (id: string) => Promise<boolean>
  saveAll: () => Promise<boolean>
  forceSave: (id: string) => Promise<boolean>
  reloadDoc: (id: string) => Promise<void>
  requestCloseDoc: (id: string) => void
  requestCloseCanvas: () => void
  dialog: EditorDialog | null
  dialogBusy: boolean
  closeDialog: () => void
  dialogSaveAndContinue: () => Promise<void>
  dialogDiscardAndContinue: () => void
  requestSaveAs: (id: string) => void
  saveAsDraft: string
  setSaveAsDraft: (value: string) => void
  submitSaveAs: () => Promise<void>
  historyDoc: EditorDocument | null
  openHistory: (id: string) => void
  closeHistory: () => void
  loadHistoryVersions: (doc: EditorDocument) => Promise<HistoryVersion[]>
  loadHistoryDiff: (doc: EditorDocument, versionId: string) => Promise<EditorHistorySelection>
  restoreVersion: (doc: EditorDocument, versionId: string) => Promise<boolean>
} {
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)
  const permissionMode = useAppStore((s) => s.session?.permissionMode ?? s.settings.permissionMode)
  const theme = useAppStore((s) => s.theme)
  const notify = useAppStore((s) => s.notify)
  const sessionId = useAppStore((s) => s.session?.id ?? null)

  const readOnlyMode = isReadOnlyMode(permissionMode)

  const [docs, setDocs] = useState<EditorDocument[]>([])
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<EditorDialog | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [saveAsDraft, setSaveAsDraft] = useState('')
  const [historyDocId, setHistoryDocId] = useState<string | null>(null)

  const docsRef = useRef<EditorDocument[]>(docs)
  docsRef.current = docs
  const generationRef = useRef(0)

  const replaceDoc = useCallback((next: EditorDocument) => {
    setDocs((prev) => {
      const index = prev.findIndex((doc) => doc.id === next.id)
      if (index < 0) return [...prev, next]
      const copy = prev.slice()
      copy[index] = next
      return copy
    })
  }, [])

  const patchDoc = useCallback((id: string, patch: Partial<EditorDocument>) => {
    setDocs((prev) => prev.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)))
  }, [])

  const dropDoc = useCallback((id: string) => {
    setDocs((prev) => prev.filter((doc) => doc.id !== id))
    setActiveDocId((current) => (current === id ? null : current))
    setHistoryDocId((current) => (current === id ? null : current))
  }, [])

  /** 打开文件后若历史为空，记录一份基线版本（可以恢复到最初内容）。 */
  const ensureBaseline = useCallback(async (doc: EditorDocument) => {
    if (doc.previewKind !== 'text' || doc.baselineRecorded || doc.binary || doc.truncated || doc.readOnly || doc.error) return
    try {
      const existing = await listHistory(doc.absPath)
      if (existing.versions.length === 0) {
        await recordHistory({
          path: doc.absPath,
          content: doc.baseline,
          source: 'baseline',
          mtimeMs: doc.mtimeMs ?? undefined
        })
      }
      patchDoc(doc.id, { baselineRecorded: true })
    } catch {
      // 历史服务不可用不应影响编辑
      patchDoc(doc.id, { baselineRecorded: true })
    }
  }, [patchDoc])

  /** 文本走编辑器；图片/PDF/DOCX/音视频走只读预览。 */
  const loadDoc = useCallback(async (placeholder: EditorDocument): Promise<EditorDocument> => {
    if (!placeholder.workspace || !placeholder.relPath) throw new Error('文件不在工作区内，无法预览。')
    if (placeholder.previewKind === 'text') {
      try {
        const result = await readFile(placeholder.workspace, placeholder.relPath)
        return {
          ...placeholder,
          loading: false,
          content: result.content,
          baseline: result.content,
          mtimeMs: result.mtimeMs,
          size: result.size,
          binary: result.binary,
          truncated: result.truncated,
          readOnly: placeholder.readOnly || result.binary || result.truncated,
          error: null,
          previewKind: result.binary ? 'unsupported' : 'text',
          previewUrl: null,
          mime: null,
          previewNote: result.binary
            ? '这个文件看起来是二进制内容，无法在文本编辑器中打开；可以用系统应用打开。'
            : null
        }
      } catch (error) {
        if (/二进制/.test(errorText(error))) {
          return {
            ...placeholder,
            loading: false,
            content: '',
            baseline: '',
            binary: true,
            truncated: false,
            readOnly: true,
            error: null,
            previewKind: 'unsupported',
            previewUrl: null,
            mime: null,
            previewNote: '这个文件看起来是二进制内容，无法在文本编辑器中打开；可以用系统应用打开。'
          }
        }
        throw error
      }
    }

    const meta = await previewFile(placeholder.workspace, placeholder.relPath)
    if (meta.kind === 'docx' && !meta.note) {
      const converted = await docxHtml(placeholder.workspace, placeholder.relPath)
      return {
        ...placeholder,
        loading: false,
        content: converted.html,
        baseline: converted.html,
        mtimeMs: meta.mtimeMs || converted.mtimeMs,
        size: meta.size,
        binary: true,
        truncated: false,
        readOnly: true,
        error: null,
        previewKind: 'docx',
        previewUrl: null,
        mime: meta.mime,
        previewNote: converted.warnings.length > 0 ? '部分 Word 样式未能完全识别，已尽量还原内容。' : null
      }
    }
    if (meta.kind === 'xlsx' && !meta.note) {
      const converted = await xlsxPreview(placeholder.workspace, placeholder.relPath)
      return {
        ...placeholder,
        loading: false,
        content: JSON.stringify(converted),
        baseline: '',
        mtimeMs: meta.mtimeMs || converted.mtimeMs,
        size: meta.size,
        binary: true,
        truncated: false,
        readOnly: true,
        error: null,
        previewKind: 'xlsx',
        previewUrl: null,
        mime: meta.mime,
        previewNote:
          converted.warnings.length > 0
            ? `${converted.warnings.join(' ')} 仅显示前 ${converted.sheets[0]?.rows.length ?? 0} 行 / 30 列。`
            : null
      }
    }
    if (meta.kind === 'pptx' && !meta.note) {
      const converted = await pptxPreview(placeholder.workspace, placeholder.relPath)
      return {
        ...placeholder,
        loading: false,
        content: JSON.stringify(converted),
        baseline: '',
        mtimeMs: meta.mtimeMs || converted.mtimeMs,
        size: meta.size,
        binary: true,
        truncated: false,
        readOnly: true,
        error: null,
        previewKind: 'pptx',
        previewUrl: null,
        mime: meta.mime,
        previewNote: converted.warnings.length > 0 ? converted.warnings.join(' ') : null
      }
    }
    if (meta.kind === 'document' && !meta.note) {
      const converted = await documentPreview(placeholder.workspace, placeholder.relPath)
      return {
        ...placeholder,
        loading: false,
        content: converted.html,
        baseline: converted.html,
        mtimeMs: meta.mtimeMs || converted.mtimeMs,
        size: meta.size,
        binary: true,
        truncated: false,
        readOnly: true,
        error: null,
        previewKind: 'document',
        previewUrl: null,
        mime: meta.mime,
        previewNote: converted.warnings.length > 0 ? converted.warnings.join(' ') : null
      }
    }
    if (meta.kind === 'archive' && !meta.note) {
      const converted = await archiveList(placeholder.workspace, placeholder.relPath)
      return {
        ...placeholder,
        loading: false,
        content: JSON.stringify(converted),
        baseline: '',
        mtimeMs: meta.mtimeMs || converted.mtimeMs,
        size: meta.size,
        binary: true,
        truncated: false,
        readOnly: true,
        error: null,
        previewKind: 'archive',
        previewUrl: null,
        mime: meta.mime,
        previewNote: converted.truncated ? `压缩包共 ${converted.total} 项，仅列出前 2000 项。` : null
      }
    }

    return {
      ...placeholder,
      loading: false,
      content: '',
      baseline: '',
      mtimeMs: meta.mtimeMs,
      size: meta.size,
      binary: true,
      truncated: false,
      readOnly: true,
      error: null,
      previewKind: meta.kind,
      previewUrl: meta.url ?? null,
      mime: meta.mime,
      previewNote: meta.note ?? null
    }
  }, [])

  /** 通过文件树事件/编辑器入口打开工作区内的文件 */
  const openPath = useCallback(
    async (relativePath: string, absolutePath?: string) => {
      if (!workspace) {
        notify('warning', '还没有选择工作文件夹，先选一个文件夹再打开文件。')
        return
      }
      const rel = normalizeRelativePath(relativePath)
      const abs = absolutePath ?? joinWorkspacePath(workspace, rel)
      const id = docIdFor(abs)
      const generation = generationRef.current
      if (!useAppStore.getState().canvas.open) useAppStore.getState().openCanvas()
      setActiveDocId(id)
      const existing = docsRef.current.find((doc) => doc.id === id)
      if (existing && !existing.loading && !existing.error) {
        if (existing.previewKind !== 'text') {
          // 只读预览（图片/PDF/Office/音视频）重新打开时刷新，避免产物被覆盖后仍显示旧内容
          void loadDoc(existing)
            .then((doc) => {
              if (generationRef.current === generation) replaceDoc(doc)
            })
            .catch((error: unknown) => {
              if (generationRef.current === generation) replaceDoc({ ...existing, error: errorText(error) })
            })
          return
        }
        void ensureBaseline(existing)
        return
      }
      const previewKind = previewKindForFileName(rel)
      const placeholder: EditorDocument = {
        id,
        absPath: abs,
        relPath: rel,
        workspace,
        title: fileNameOf(rel),
        language: languageForPath(rel),
        content: '',
        baseline: '',
        mtimeMs: null,
        size: null,
        dirty: false,
        readOnly: previewKind !== 'text',
        loading: true,
        error: null,
        binary: previewKind !== 'text',
        truncated: false,
        previewKind,
        previewUrl: null,
        mime: null,
        previewNote: null,
        conflict: null,
        preview: false
      }
      replaceDoc(placeholder)
      try {
        const doc = await loadDoc(placeholder)
        // 转换期间切换会话会清空 docs；迟到的结果不能把旧会话文件写回来
        if (generationRef.current !== generation) return
        replaceDoc(doc)
        void ensureBaseline(doc)
      } catch (error) {
        if (generationRef.current !== generation) return
        replaceDoc({ ...placeholder, loading: false, error: errorText(error) })
      }
    },
    [ensureBaseline, loadDoc, notify, replaceDoc, workspace]
  )

  /** 从 Canvas 产物「编辑」按钮打开：工作区外的文件以只读方式查看 */
  const openArtifact = useCallback(
    (artifact: Artifact, content: string) => {
      const abs = artifact.path ?? null
      const rel = abs ? relativeToWorkspace(workspace, abs) : null
      if (abs && rel !== null && workspace) {
        void openPath(rel, abs)
        return
      }
      const id = docIdFor(abs ?? `artifact://${artifact.id}`)
      setActiveDocId(id)
      const doc: EditorDocument = {
        id,
        absPath: abs ?? `artifact://${artifact.id}`,
        relPath: abs ?? artifact.title,
        workspace: null,
        title: artifact.title,
        language: languageForPath(abs ?? artifact.title),
        content: content,
        baseline: content,
        mtimeMs: null,
        size: content.length,
        dirty: false,
        readOnly: true,
        loading: false,
        error: null,
        binary: false,
        truncated: false,
        previewKind: 'text',
        previewUrl: null,
        mime: null,
        previewNote: abs ? '这个文件在工作区外，只能只读查看；可以用「另存为」保存到当前工作区。' : null,
        conflict: null,
        preview: false
      }
      replaceDoc(doc)
    },
    [openPath, replaceDoc, workspace]
  )

  const updateContent = useCallback((id: string, content: string) => {
    setDocs((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, content, dirty: content !== doc.baseline } : doc))
    )
  }, [])

  const togglePreview = useCallback((id: string) => {
    setDocs((prev) => prev.map((doc) => (doc.id === id ? { ...doc, preview: !doc.preview } : doc)))
  }, [])

  /** 保存单个文档：写盘 + 记录版本；冲突时保留未保存内容并提示。 */
  const saveDoc = useCallback(
    async (id: string): Promise<boolean> => {
      const doc = docsRef.current.find((item) => item.id === id)
      if (!doc || doc.loading || doc.previewKind !== 'text' || doc.binary) return false
      if (readOnlyMode) {
        notify('warning', '当前是只读模式，不能保存修改。')
        return false
      }
      if (doc.truncated) {
        notify('warning', '文件较大，只展示了开头部分，不能在这里保存。')
        return false
      }
      if (doc.readOnly) {
        notify('warning', '当前是只读模式，不能保存修改。')
        return false
      }
      if (!doc.workspace || !doc.relPath) {
        notify('warning', '这个文件不在工作区内，只能用「另存为」保存到工作区。')
        return false
      }
      if (!doc.dirty) return true
      const savedContent = doc.content
      try {
        const written = await writeFile(doc.workspace, doc.relPath, savedContent, doc.mtimeMs)
        const latest = docsRef.current.find((item) => item.id === id)
        const stillCurrent = !latest || latest.content === savedContent
        if (latest) {
          replaceDoc({
            ...latest,
            baseline: savedContent,
            mtimeMs: written.mtimeMs,
            size: written.size,
            dirty: latest.content !== savedContent,
            conflict: null,
            error: null
          })
        }
        notify(
          stillCurrent ? 'success' : 'info',
          stillCurrent ? '已保存' : '已保存，但保存期间的新修改还没有写入'
        )
        dispatchFilesChanged()
        try {
          await recordHistory({
            path: doc.absPath,
            content: savedContent,
            source: 'user',
            mtimeMs: written.mtimeMs
          })
        } catch {
          // 历史服务异常不影响保存
        }
        return stillCurrent
      } catch (error) {
        const message = errorText(error)
        if (isConflictError(error) || message.includes(CONFLICT_PREFIX)) {
          patchDoc(id, { conflict: message })
          notify('warning', '文件已被外部修改，未保存。请重新加载或覆盖保存。')
        } else {
          notify('error', message)
        }
        return false
      }
    },
    [notify, patchDoc, readOnlyMode, replaceDoc]
  )

  /** 覆盖保存（外部修改冲突时用户确认用当前内容覆盖） */
  const forceSave = useCallback(
    async (id: string): Promise<boolean> => {
      const doc = docsRef.current.find((item) => item.id === id)
      if (!doc || doc.loading || doc.previewKind !== 'text' || !doc.workspace || !doc.relPath) return false
      if (readOnlyMode || doc.readOnly) {
        notify('warning', '当前是只读模式，不能覆盖保存。')
        return false
      }
      if (doc.binary || doc.truncated) {
        notify('warning', '这个文件只能只读预览，不能覆盖保存。')
        return false
      }
      const savedContent = doc.content
      try {
        const written = await writeFile(doc.workspace, doc.relPath, savedContent)
        const latest = docsRef.current.find((item) => item.id === id)
        const stillCurrent = !latest || latest.content === savedContent
        if (latest) {
          replaceDoc({
            ...latest,
            baseline: savedContent,
            mtimeMs: written.mtimeMs,
            size: written.size,
            dirty: latest.content !== savedContent,
            conflict: null
          })
        }
        notify(
          stillCurrent ? 'success' : 'info',
          stillCurrent ? '已覆盖保存' : '已覆盖保存，但保存期间的新修改还没有写入'
        )
        dispatchFilesChanged()
        try {
          await recordHistory({ path: doc.absPath, content: savedContent, source: 'user', mtimeMs: written.mtimeMs })
        } catch {
          // ignore
        }
        return stillCurrent
      } catch (error) {
        patchDoc(id, { conflict: errorText(error) })
        notify('error', errorText(error))
        return false
      }
    },
    [notify, patchDoc, readOnlyMode, replaceDoc]
  )

  const saveAll = useCallback(async (): Promise<boolean> => {
    if (readOnlyMode) {
      if (docsRef.current.some((doc) => doc.dirty)) {
        notify('warning', '当前是只读模式，未保存的修改无法写入。可以切回「询问」或「完全访问」后再保存。')
        return false
      }
      return true
    }
    let ok = true
    for (const doc of docsRef.current) {
      if (!doc.dirty || doc.readOnly) continue
      const saved = await saveDoc(doc.id)
      if (!saved) ok = false
    }
    return ok
  }, [notify, readOnlyMode, saveDoc])

  /** 重新从磁盘加载（外部修改/恢复历史/预览令牌刷新） */
  const reloadDoc = useCallback(
    async (id: string) => {
      const doc = docsRef.current.find((item) => item.id === id)
      if (!doc || !doc.workspace || !doc.relPath) return
      patchDoc(id, { loading: true, error: null, conflict: null })
      try {
        const next = await loadDoc({ ...doc, loading: true, error: null, conflict: null })
        replaceDoc(next)
        void ensureBaseline(next)
      } catch (error) {
        patchDoc(id, { loading: false, error: errorText(error) })
      }
    },
    [ensureBaseline, loadDoc, patchDoc, replaceDoc]
  )

  /* 外部修改检测：窗口重新获得焦点 / 切回文档时对比 mtime */
  useEffect(() => {
    const check = async (): Promise<void> => {
      const id = activeDocId
      if (!id) return
      const doc = docsRef.current.find((item) => item.id === id)
      if (
        !doc ||
        doc.loading ||
        doc.previewKind !== 'text' ||
        doc.binary ||
        doc.truncated ||
        !doc.workspace ||
        !doc.relPath ||
        doc.mtimeMs === null
      ) {
        return
      }
      try {
        const stat = await statFile(doc.workspace, doc.relPath)
        if (Math.abs(stat.mtimeMs - doc.mtimeMs) <= 1) return
        const latest = docsRef.current.find((item) => item.id === id)
        if (!latest || latest.mtimeMs !== doc.mtimeMs) return
        if (doc.dirty) {
          patchDoc(id, {
            conflict: '文件在编辑器打开后被外部修改了。你可以重新加载，或用当前内容覆盖保存。'
          })
          return
        }
        const result = await readFile(doc.workspace, doc.relPath)
        if (result.mtimeMs === doc.mtimeMs) return
        // 外部（Agent/其它程序）写入：把修改前内容与修改后内容都记入历史
        try {
          await recordHistory({
            path: doc.absPath,
            content: doc.baseline,
            source: 'agent',
            mtimeMs: doc.mtimeMs ?? undefined,
            label: '外部修改前'
          })
          await recordHistory({
            path: doc.absPath,
            content: result.content,
            source: 'agent',
            mtimeMs: result.mtimeMs,
            label: '外部写入'
          })
        } catch {
          // ignore
        }
        replaceDoc({
          ...doc,
          content: result.content,
          baseline: result.content,
          mtimeMs: result.mtimeMs,
          size: result.size,
          dirty: false,
          conflict: null,
          truncated: result.truncated,
          readOnly: doc.readOnly || result.truncated
        })
        notify('info', '文件被外部修改，已重新加载。')
      } catch {
        // 文件被删除等场景：保留当前内容，等保存时统一报错
      }
    }
    const onFocus = (): void => {
      void check()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    void check()
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [activeDocId, notify, patchDoc, replaceDoc])

  /* 监听文件树打开事件 */
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ path?: string; absolutePath?: string }>).detail
      if (!detail || typeof detail.path !== 'string') return
      void openPath(detail.path, detail.absolutePath)
    }
    window.addEventListener('morrow:open-file', handler)
    return () => window.removeEventListener('morrow:open-file', handler)
  }, [openPath])

  /* 文件树重命名/删除后同步已打开标签，避免继续读写旧路径 */
  useEffect(() => {
    const onRenamed = (event: Event): void => {
      const detail = (event as CustomEvent<{ from?: string; to?: string; isDir?: boolean }>).detail
      if (!detail?.from || !detail.to) return
      let from: string
      let to: string
      try {
        from = normalizeRelativePath(detail.from)
        to = normalizeRelativePath(detail.to)
      } catch {
        return
      }
      const isDir = detail.isDir === true
      const idMap = new Map<string, string>()
      const next = docsRef.current.map((doc) => {
        if (!doc.workspace || !doc.relPath) return doc
        if (doc.relPath !== from && !(isDir && doc.relPath.startsWith(`${from}/`))) return doc
        const relPath = isDir ? `${to}${doc.relPath.slice(from.length)}` : to
        const absPath = joinWorkspacePath(doc.workspace, relPath)
        const id = docIdFor(absPath)
        idMap.set(doc.id, id)
        return {
          ...doc,
          id,
          absPath,
          relPath,
          title: fileNameOf(relPath),
          language: languageForPath(relPath),
          // 新路径需要重新建立历史基线
          baselineRecorded: false
        }
      })
      if (idMap.size === 0) return
      setDocs(next)
      setActiveDocId((current) => (current && idMap.get(current) ? idMap.get(current)! : current))
      setHistoryDocId((current) => (current && idMap.get(current) ? idMap.get(current)! : current))
      notify('info', '文件已重命名，编辑器标签已同步。')
    }

    const onDeleted = (event: Event): void => {
      const detail = (event as CustomEvent<{ path?: string; isDir?: boolean }>).detail
      if (!detail?.path) return
      let deletedPath: string
      try {
        deletedPath = normalizeRelativePath(detail.path)
      } catch {
        return
      }
      const isDir = detail.isDir === true
      const affected = docsRef.current.filter(
        (doc) =>
          Boolean(doc.relPath) &&
          (doc.relPath === deletedPath || (isDir && doc.relPath.startsWith(`${deletedPath}/`)))
      )
      if (affected.length === 0) return
      const closeIds = new Set(affected.filter((doc) => !doc.dirty).map((doc) => doc.id))
      const dirtyIds = new Set(affected.filter((doc) => doc.dirty).map((doc) => doc.id))
      setDocs((previous) =>
        previous.flatMap((doc) => {
          if (closeIds.has(doc.id)) return []
          if (!dirtyIds.has(doc.id)) return [doc]
          return [{ ...doc, conflict: '文件已被删除；请另存为保留当前内容，或关闭标签。', mtimeMs: null }]
        })
      )
      setActiveDocId((current) => (current && closeIds.has(current) ? null : current))
      setHistoryDocId((current) => (current && closeIds.has(current) ? null : current))
      notify('info', dirtyIds.size > 0 ? '文件已删除；未保存的标签已保留，请另存为。' : '文件已删除，对应标签已关闭。')
    }

    window.addEventListener('morrow:file-renamed', onRenamed as EventListener)
    window.addEventListener('morrow:file-deleted', onDeleted as EventListener)
    return () => {
      window.removeEventListener('morrow:file-renamed', onRenamed as EventListener)
      window.removeEventListener('morrow:file-deleted', onDeleted as EventListener)
    }
  }, [notify])

  /* 会话切换时清空编辑器状态，避免跨会话残留 */
  useEffect(() => {
    generationRef.current += 1
    setDocs([])
    setActiveDocId(null)
    setHistoryDocId(null)
    setDialog(null)
  }, [sessionId])

  const selectDoc = useCallback((id: string | null) => {
    setActiveDocId(id)
    if (id) setHistoryDocId((current) => (current && current !== id ? null : current))
  }, [])

  const requestCloseDoc = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id)
    if (!doc) return
    if (doc.dirty) setDialog({ kind: 'close-doc', docId: id })
    else dropDoc(id)
  }, [dropDoc])

  const requestCloseCanvas = useCallback(() => {
    if (docsRef.current.some((doc) => doc.dirty)) setDialog({ kind: 'close-canvas' })
    else useAppStore.getState().closeCanvas()
  }, [])

  const closeDialog = useCallback(() => {
    if (dialogBusy) return
    setDialog(null)
  }, [dialogBusy])

  const dialogSaveAndContinue = useCallback(async () => {
    if (!dialog) return
    setDialogBusy(true)
    try {
      if (dialog.kind === 'save-as') return
      if (dialog.kind === 'close-doc') {
        const ok = await saveDoc(dialog.docId)
        if (ok) {
          dropDoc(dialog.docId)
          setDialog(null)
        }
        return
      }
      const ok = await saveAll()
      if (ok) {
        setDialog(null)
        useAppStore.getState().closeCanvas()
      }
    } finally {
      setDialogBusy(false)
    }
  }, [dialog, dropDoc, saveAll, saveDoc])

  const dialogDiscardAndContinue = useCallback(() => {
    if (!dialog) return
    if (dialog.kind === 'close-doc') {
      dropDoc(dialog.docId)
    } else if (dialog.kind === 'close-canvas') {
      setDocs([])
      setActiveDocId(null)
      useAppStore.getState().closeCanvas()
    }
    setDialog(null)
  }, [dialog, dropDoc])

  const requestSaveAs = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id)
    if (!doc) return
    setSaveAsDraft(`${doc.relPath || doc.title}`)
    setDialog({ kind: 'save-as', docId: id })
  }, [])

  const submitSaveAs = useCallback(async () => {
    if (!dialog || dialog.kind !== 'save-as') return
    const doc = docsRef.current.find((item) => item.id === dialog.docId)
    if (!doc) return
    if (readOnlyMode) {
      notify('warning', '当前是只读模式，不能另存文件。')
      return
    }
    if (!workspace) {
      notify('warning', '还没有选择工作文件夹，无法另存。')
      return
    }
    const relative = normalizeRelativePath(saveAsDraft.trim())
    if (!relative) {
      notify('warning', '请输入要保存的文件名。')
      return
    }
    setDialogBusy(true)
    try {
      await createFile(workspace, relative, 'file')
      let written
      try {
        written = await writeFile(workspace, relative, doc.content)
      } catch (err) {
        // 写入失败时清掉刚创建的空文件，避免留下半成品
        await filesApi.remove(relative, { workspace }).catch(() => undefined)
        throw err
      }
      dispatchFilesChanged()
      setDialog(null)
      notify('success', `已另存为 ${relative}`)
      const absolute = joinWorkspacePath(workspace, relative)
      setActiveDocId(docIdFor(absolute))
      const id = docIdFor(absolute)
      const next: EditorDocument = {
        ...doc,
        id,
        absPath: absolute,
        relPath: relative,
        workspace,
        title: fileNameOf(relative),
        language: languageForPath(relative),
        baseline: doc.content,
        mtimeMs: written.mtimeMs,
        size: written.size,
        dirty: false,
        readOnly: false,
        binary: false,
        truncated: false,
        previewKind: 'text',
        previewUrl: null,
        mime: null,
        previewNote: null,
        preview: false,
        conflict: null,
        error: null,
        loading: false,
        // 新路径需要自己的历史基线；不能继承原文档的「已记录」标记
        baselineRecorded: false
      }
      setDocs((prev) => [...prev.filter((item) => item.id !== id), next])
      void ensureBaseline(next)
    } catch (error) {
      notify('error', errorText(error))
    } finally {
      setDialogBusy(false)
    }
  }, [dialog, ensureBaseline, notify, readOnlyMode, saveAsDraft, workspace])

  const openHistory = useCallback((id: string) => {
    setHistoryDocId(id)
  }, [])
  const closeHistory = useCallback(() => setHistoryDocId(null), [])

  const loadHistoryVersions = useCallback(async (doc: EditorDocument): Promise<HistoryVersion[]> => {
    const result = await listHistory(doc.absPath)
    return result.versions
  }, [])

  const loadHistoryDiff = useCallback(async (doc: EditorDocument, versionId: string): Promise<EditorHistorySelection> => {
    const result = await diffHistory(doc.absPath, versionId, doc.dirty ? doc.content : undefined)
    return {
      version: result.version,
      patch: result.patch,
      added: result.added,
      removed: result.removed,
      targetLabel: result.targetLabel
    }
  }, [])

  const restoreVersion = useCallback(
    async (doc: EditorDocument, versionId: string): Promise<boolean> => {
      if (readOnlyMode || doc.readOnly) {
        notify('warning', '当前是只读模式，不能恢复版本。')
        return false
      }
      try {
        await restoreHistory(doc.absPath, versionId, doc.mtimeMs)
        await reloadDoc(doc.id)
        try {
          await recordHistory({
            path: doc.absPath,
            content: docsRef.current.find((item) => item.id === doc.id)?.content ?? doc.content,
            source: 'restore',
            label: `恢复 ${versionId}`
          })
        } catch {
          // ignore
        }
        notify('success', '已恢复到这个版本。')
        return true
      } catch (error) {
        notify('error', errorText(error))
        if (isConflictError(error)) {
          patchDoc(doc.id, { conflict: errorText(error) })
        }
        return false
      }
    },
    [notify, patchDoc, readOnlyMode, reloadDoc]
  )

  const activeDoc = useMemo(
    () => docs.find((doc) => doc.id === activeDocId) ?? null,
    [docs, activeDocId]
  )
  const historyDoc = useMemo(
    () => docs.find((doc) => doc.id === historyDocId) ?? null,
    [docs, historyDocId]
  )

  return {
    docs,
    activeDoc,
    activeDocId,
    workspace,
    readOnlyMode,
    theme,
    selectDoc,
    openPath,
    openArtifact,
    updateContent,
    togglePreview,
    saveDoc,
    saveAll,
    forceSave,
    reloadDoc,
    requestCloseDoc,
    requestCloseCanvas,
    dialog,
    dialogBusy,
    closeDialog,
    dialogSaveAndContinue,
    dialogDiscardAndContinue,
    requestSaveAs,
    saveAsDraft,
    setSaveAsDraft,
    submitSaveAs,
    historyDoc,
    openHistory,
    closeHistory,
    loadHistoryVersions,
    loadHistoryDiff,
    restoreVersion
  }
}

export type EditorController = ReturnType<typeof useEditorDocs>
