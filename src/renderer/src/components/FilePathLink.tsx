// 对话正文里的文件路径链接：识别相对/绝对路径与行号，提供打开、定位、复制路径。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, FileText, FolderOpen, Link2 } from 'lucide-react'
import { isAbsoluteFilePath, isTextFilePath, parseFilePath, type ParsedFilePath } from '@shared/file-path'
import { useAppStore } from '../store'
import { dispatchOpenFile } from '../features/files/files-client'
import { joinWorkspacePath, normalizeRelativePath, relativeToWorkspace } from '../features/artifacts/editor-api'
import './FilePathLink.css'

interface MenuState {
  x: number
  y: number
}

interface ResolvedPath {
  absolute: string | null
  relative: string | null
  workspace: string | null
}

function resolvePath(parsed: ParsedFilePath): ResolvedPath {
  const state = useAppStore.getState()
  const workspace = state.session?.workspace ?? state.settings.lastWorkspace ?? null
  if (isAbsoluteFilePath(parsed.path)) {
    return {
      absolute: parsed.path,
      relative: workspace ? relativeToWorkspace(workspace, parsed.path) : null,
      workspace
    }
  }
  if (!workspace) return { absolute: null, relative: normalizeRelativePath(parsed.path), workspace: null }
  return {
    absolute: joinWorkspacePath(workspace, parsed.path),
    relative: normalizeRelativePath(parsed.path),
    workspace
  }
}

function errorOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Markdown 中的文件路径：单击在画布/编辑器中打开，右键提供资源管理器、复制内容与路径。
 * 不是工作区内的文件时给出明确提示，避免静默失败。
 */
export function FilePathLink({
  raw,
  label,
  streaming = false,
  allowBare = false
}: {
  raw: string
  label?: string
  streaming?: boolean
  allowBare?: boolean
}) {
  const parsed = parseFilePath(raw, { allowBare })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    // 菜单挂载瞬间可能伴随布局/窗口 resize 与滚动事件；短暂宽限避免刚打开就消失
    const openedAt = Date.now()
    const close = (event: Event): void => {
      if ((event.type === 'scroll' || event.type === 'resize') && Date.now() - openedAt < 350) return
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!parsed || streaming) return <code className="md-inline-code">{raw}</code>

  const notify = (kind: 'success' | 'warning' | 'error', message: string): void => {
    useAppStore.getState().notify(kind, message)
  }

  const openInApp = (): void => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.workspace) {
      notify('warning', '还没有选择工作文件夹，先选择工作文件夹再打开文件。')
      return
    }
    if (!target.absolute || target.relative === null) {
      notify('warning', '这个文件不在当前工作文件夹内，无法在画布中打开。')
      return
    }
    dispatchOpenFile({ path: target.relative, absolutePath: target.absolute })
  }

  const reveal = async (): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.absolute) {
      notify('warning', '还没有选择工作文件夹，无法定位文件。')
      return
    }
    try {
      const result = await window.morrow.artifacts.reveal(target.absolute)
      if (!result.ok) notify('error', result.error.message)
    } catch (err) {
      notify('error', errorOf(err))
    }
  }

  const copyPath = async (absolute: boolean): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    const value = absolute ? target.absolute : target.relative
    if (!value) {
      notify('warning', absolute ? '还没有选择工作文件夹，无法复制绝对路径。' : '这个文件不在当前工作文件夹内。')
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      notify('success', absolute ? '已复制绝对路径' : '已复制相对路径')
    } catch {
      notify('error', '复制失败，请检查剪贴板权限。')
    }
  }

  const copyContent = async (): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.absolute) {
      notify('warning', '还没有选择工作文件夹，无法读取文件内容。')
      return
    }
    if (!isTextFilePath(parsed.path)) {
      notify('warning', '这是二进制文件，无法复制为文本内容。')
      return
    }
    try {
      const result = await window.morrow.artifacts.read(target.absolute)
      if (!result.ok) {
        notify('error', result.error.message)
        return
      }
      await navigator.clipboard.writeText(result.data.content)
      notify(result.data.truncated ? 'warning' : 'success', result.data.truncated ? '文件较大，已复制可读取的部分内容' : '已复制文件内容')
    } catch (err) {
      notify('error', errorOf(err))
    }
  }

  const target = resolvePath(parsed)
  const canCopyContent = Boolean(target.absolute) && isTextFilePath(parsed.path)
  const canCopyRelative = Boolean(target.relative) && target.relative !== target.absolute
  const menuBox = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 260)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - 232))
      }
    : null

  return (
    <>
      <button
        type="button"
        className="md-file-link"
        title={`点击在应用内打开${parsed.line ? `（第 ${parsed.line} 行）` : ''} · 右键更多操作`}
        aria-label={`打开文件 ${parsed.path}${parsed.line ? `，第 ${parsed.line} 行` : ''}`}
        onClick={openInApp}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <FileText size={12} strokeWidth={1.6} aria-hidden />
        <span className="md-file-link-label mono">{label || parsed.display}</span>
      </button>
      {menu && menuBox
        ? createPortal(
            <div
              ref={menuRef}
              className="md-file-menu"
              role="menu"
              aria-label="文件操作"
              style={{ left: menuBox.left, top: menuBox.top }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="md-file-menu-head mono truncate" title={target.absolute ?? parsed.path}>
                {parsed.display}
              </div>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={openInApp}>
                <FileText size={13} strokeWidth={1.6} aria-hidden /> 在应用内打开
              </button>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void reveal()}>
                <FolderOpen size={13} strokeWidth={1.6} aria-hidden /> 在资源管理器中打开
              </button>
              <div className="md-file-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="md-file-menu-item"
                disabled={!canCopyContent}
                title={canCopyContent ? undefined : '二进制文件不支持复制文本内容'}
                onClick={() => void copyContent()}
              >
                <Copy size={13} strokeWidth={1.6} aria-hidden /> 复制内容
              </button>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void copyPath(true)}>
                <Link2 size={13} strokeWidth={1.6} aria-hidden /> 复制路径
              </button>
              {canCopyRelative ? (
                <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void copyPath(false)}>
                  <Copy size={13} strokeWidth={1.6} aria-hidden /> 复制相对路径
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
