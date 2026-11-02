import { useMemo, useRef, useState } from 'react'
import {
  Clock,
  Copy,
  Eye,
  FileWarning,
  Pencil,
  RefreshCw,
  Save,
  SaveAll,
  TriangleAlert,
  X
} from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { isTableFileName } from '@shared/file-types'
import { withMorrowScrollbar } from '@shared/scrollbar'
import { TablePreview } from './OfficePreviews'
import { CodeEditor, type CodeEditorHandle } from '../../components/CodeEditor'
import { languageLabel } from '../../components/languages'
import { IconButton } from '../../ui'
import type { EditorDocument } from './useEditorDocs'
import './editor.css'

export interface EditorPaneProps {
  doc: EditorDocument
  theme: 'dark' | 'light'
  /** 当前会话/全局处于只读模式（动态变化，不写进 doc.readOnly） */
  readOnlyMode: boolean
  onContentChange: (value: string) => void
  onSave: () => void
  onForceSave: () => void
  onReload: () => void
  onTogglePreview: () => void
  onShowHistory: () => void
  onRequestSaveAs: () => void
  onRequestClose: () => void
  onCopyPath: () => void
}

/**
 * 单个可编辑文档：CodeMirror 编辑器 + 工具栏 + Markdown/HTML 预览 + 冲突提示。
 * 编辑器本体在 components/editor；这里只做文档级 UI 与状态呈现。
 */
export function EditorPane({
  doc,
  theme,
  readOnlyMode,
  onContentChange,
  onSave,
  onForceSave,
  onReload,
  onTogglePreview,
  onShowHistory,
  onRequestSaveAs,
  onRequestClose,
  onCopyPath
}: EditorPaneProps): React.JSX.Element {
  const editorRef = useRef<CodeEditorHandle>(null)
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 })
  const tablePreview = isTableFileName(doc.relPath || doc.title)
  const svgPreview = /\.svg$/i.test(doc.relPath || doc.title)
  const previewAvailable = doc.language === 'markdown' || doc.language === 'html' || tablePreview || svgPreview
  const showPreview = doc.preview && previewAvailable
  const previewLabel = tablePreview ? '预览表格' : svgPreview ? '预览图形' : doc.language === 'markdown' ? '预览 Markdown' : '预览网页'
  const readOnly = readOnlyMode || doc.readOnly || doc.binary || doc.truncated

  const status = useMemo(() => {
    if (doc.loading) return { tone: 'muted', label: '读取中' }
    if (doc.error) return { tone: 'danger', label: '读取失败' }
    if (doc.binary) return { tone: 'muted', label: '二进制文件' }
    if (doc.truncated) return { tone: 'warning', label: '仅预览开头' }
    if (readOnlyMode) return { tone: 'muted', label: '只读模式' }
    if (doc.readOnly) return { tone: 'muted', label: '只读' }
    if (doc.dirty) return { tone: 'warning', label: '未保存' }
    return { tone: 'success', label: '已保存' }
  }, [doc.binary, doc.dirty, doc.error, doc.loading, doc.readOnly, doc.truncated, readOnlyMode])

  const saveLabel = doc.conflict ? '覆盖保存 (Ctrl+S)' : '保存 (Ctrl+S)'

  return (
    <div className="editor-pane" data-language={doc.language}>
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          <span className="editor-path mono" title={doc.relPath || doc.absPath}>
            {doc.relPath || doc.title}
          </span>
          <span className="editor-toolbar-sep" aria-hidden />
          <span className="editor-lang mono">{languageLabel(doc.language)}</span>
          <span className={`editor-status mono is-${status.tone}`}>{status.label}</span>
        </div>
        <div className="editor-toolbar-right">
          {showPreview ? null : (
            <span className="editor-cursor mono" aria-label={`光标位置：第 ${cursor.line} 行，第 ${cursor.column} 列`}>
              行 {cursor.line} · 列 {cursor.column}
            </span>
          )}
          {doc.conflict ? (
            <button
              type="button"
              className="editor-text-btn is-danger"
              onClick={onForceSave}
              disabled={readOnly}
              title={readOnly ? '当前是只读模式，不能覆盖保存' : '用编辑器里的内容覆盖磁盘文件'}
            >
              <TriangleAlert size={12} strokeWidth={1.7} aria-hidden />
              覆盖保存
            </button>
          ) : (
            <button
              type="button"
              className={['editor-text-btn', doc.dirty ? 'is-primary' : ''].filter(Boolean).join(' ')}
              onClick={onSave}
              disabled={!doc.dirty || readOnly}
              title={saveLabel}
            >
              <Save size={12} strokeWidth={1.7} aria-hidden />
              保存
            </button>
          )}
          {doc.workspace ? (
            <button type="button" className="editor-text-btn" onClick={onShowHistory} title="查看这个文件的版本历史">
              <Clock size={12} strokeWidth={1.7} aria-hidden />
              历史
            </button>
          ) : null}
          {previewAvailable ? (
            <button
              type="button"
              className={['editor-text-btn', showPreview ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={onTogglePreview}
              aria-pressed={showPreview}
              title={showPreview ? '回到编辑' : previewLabel}
            >
              {showPreview ? <Pencil size={12} strokeWidth={1.7} aria-hidden /> : <Eye size={12} strokeWidth={1.7} aria-hidden />}
              {showPreview ? '编辑' : '预览'}
            </button>
          ) : null}
          <button
            type="button"
            className="editor-text-btn"
            onClick={onRequestSaveAs}
            disabled={readOnlyMode}
            title={readOnlyMode ? '当前是只读模式，不能另存文件' : '另存为文件夹内的新文件'}
          >
            <SaveAll size={12} strokeWidth={1.7} aria-hidden />
            另存为
          </button>
          {doc.conflict || doc.error ? (
            <button type="button" className="editor-text-btn" onClick={onReload} title="从磁盘重新加载，放弃未保存修改">
              <RefreshCw size={12} strokeWidth={1.7} aria-hidden />
              重新加载
            </button>
          ) : null}
          <span className="editor-toolbar-sep" aria-hidden />
          <IconButton label="复制相对路径" size={24} onClick={onCopyPath}>
            <Copy size={12} strokeWidth={1.6} />
          </IconButton>
          <IconButton label="关闭这个文件" size={24} onClick={onRequestClose}>
            <X size={13} strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>

      {doc.conflict ? (
        <div className="editor-banner is-warning" role="alert">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden />
          <span>{doc.conflict}</span>
          <div className="editor-banner-actions">
            <button type="button" onClick={onReload}>
              重新加载
            </button>
            <button type="button" onClick={onForceSave} disabled={readOnly}>
              覆盖保存
            </button>
          </div>
        </div>
      ) : null}

      {doc.previewNote && !doc.binary && !doc.truncated && !doc.error ? (
        <div className="editor-banner is-info" role="status">
          <FileWarning size={13} strokeWidth={1.7} aria-hidden />
          <span>{doc.previewNote}</span>
        </div>
      ) : null}

      {doc.truncated ? (
        <div className="editor-banner is-danger" role="alert">
          <FileWarning size={13} strokeWidth={1.7} aria-hidden />
          <span>文件较大，只显示了前一部分内容。为避免损坏原文件，这里只读；需要完整编辑请用其它工具打开。</span>
        </div>
      ) : null}

      {doc.error && !doc.content ? (
        <div className="editor-error">
          <FileWarning size={20} strokeWidth={1.4} aria-hidden />
          <p className="editor-error-title">这个文件打不开</p>
          <p className="editor-error-detail">{doc.error}</p>
          <button type="button" className="editor-text-btn is-primary" onClick={onReload}>
            重试
          </button>
        </div>
      ) : showPreview ? (
        <div className="editor-preview">
          {doc.language === 'markdown' ? (
            <div className="editor-preview-paper selectable">
              <Markdown text={doc.content} />
            </div>
          ) : tablePreview ? (
            <TablePreview content={doc.content} relPath={doc.relPath} />
          ) : svgPreview ? (
            <div className="editor-preview-svg">
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc.content)}`} alt={doc.title} />
            </div>
          ) : (
            <iframe
              className="editor-preview-frame"
              title={`${doc.title} 预览`}
              // 本地 HTML 预览不需要脚本/表单；可交互 HTML 走画布成品的独立沙箱
              sandbox=""
              srcDoc={withMorrowScrollbar(doc.content)}
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      ) : (
        <div className="editor-canvas">
          <CodeEditor
            ref={editorRef}
            value={doc.content}
            documentKey={doc.relPath || doc.title}
            language={doc.language}
            readOnly={readOnly}
            theme={theme}
            ariaLabel={`${doc.title} 编辑器`}
            onChange={onContentChange}
            onSave={onSave}
            onCursor={(line, column) => setCursor({ line, column })}
          />
        </div>
      )}
    </div>
  )
}
