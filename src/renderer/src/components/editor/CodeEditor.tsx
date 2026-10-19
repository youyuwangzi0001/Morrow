import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef
} from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  loadLanguageExtension,
  morrowSyntaxHighlighting,
  type EditorLanguage
} from './languages'
import './CodeEditor.css'

export interface CodeEditorHandle {
  focus: () => void
  openSearch: () => void
  getValue: () => string
  setValue: (value: string) => void
}

export interface CodeEditorProps {
  value: string
  language: EditorLanguage
  readOnly?: boolean
  theme: 'dark' | 'light'
  lineWrapping?: boolean
  ariaLabel?: string
  autoFocus?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onCursor?: (line: number, column: number) => void
}

/* ── 主题 ─────────────────────────────────────────────────────── */

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12.5px',
    color: 'var(--text)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
    overflow: 'auto'
  },
  '.cm-content': {
    caretColor: 'var(--gold)',
    padding: '8px 0 24px'
  },
  '.cm-line': {
    padding: '0 12px'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--gold)',
    borderLeftWidth: '1.5px'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--gold-dim) !important'
  },
  '.cm-gutters': {
    border: 'none',
    paddingLeft: '4px'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-2)'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 6px 0 8px',
    minWidth: '28px'
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    color: 'var(--text-3)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    color: 'var(--text-3)',
    borderRadius: '4px',
    padding: '0 4px'
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--gold-dim)',
    color: 'var(--gold-bright) !important',
    outline: '1px solid var(--line-gold)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--text)',
    borderRadius: 'var(--r-xs)',
    boxShadow: 'var(--shadow-soft)'
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--text)',
    borderTop: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-search': {
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    padding: '6px 8px',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    alignItems: 'center'
  },
  '.cm-search label': { color: 'var(--text-2)', fontSize: '11.5px' },
  '.cm-search .cm-textfield': {
    backgroundColor: 'var(--surface-inset)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--text)',
    padding: '3px 7px',
    fontSize: '12px',
    outline: 'none'
  },
  '.cm-search .cm-textfield:focus': { borderColor: 'var(--line-gold)' },
  '.cm-search .cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--text-2)',
    fontSize: '11.5px',
    padding: '3px 9px'
  },
  '.cm-search .cm-button:hover': { backgroundColor: 'var(--surface-hover)', color: 'var(--text)' },
  '.cm-search button[name="close"]': { color: 'var(--text-3)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--gold-dim)',
    outline: '1px solid var(--line-gold)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--gold) 30%, transparent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--patina) 16%, transparent)' },
  '.cm-placeholder': { color: 'var(--text-3)' }
})

const darkEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--code-bg)' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface) 42%, transparent)' }
  },
  { dark: true }
)

const lightEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--code-bg)' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, #000 4%, transparent)' }
  },
  { dark: false }
)

/**
 * CodeMirror 6 编辑器封装：行号、折叠、括号匹配、查找替换、撤销重做、自动缩进、
 * Ctrl+S 保存、主题与语言热切换；语言包按需动态加载。
 */
export const CodeEditor = forwardRef(function CodeEditor(
  {
    value,
    language,
    readOnly = false,
    theme,
    lineWrapping = true,
    ariaLabel,
    autoFocus = false,
    onChange,
    onSave,
    onCursor
  }: CodeEditorProps,
  ref: ForwardedRef<CodeEditorHandle>
): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onCursorRef = useRef(onCursor)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onCursorRef.current = onCursor

  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())
  const loadToken = useRef(0)

  /* 创建编辑器（只一次） */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      search({ top: true }),
      morrowSyntaxHighlighting(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.()
            return true
          }
        }
      ]),
      baseTheme,
      readOnlyCompartment.current.of([]),
      themeCompartment.current.of(theme === 'dark' ? darkEditorTheme : lightEditorTheme),
      wrapCompartment.current.of(lineWrapping ? EditorView.lineWrapping : []),
      languageCompartment.current.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          const line = update.state.doc.lineAt(head)
          onCursorRef.current?.(line.number, head - line.from + 1)
        }
      }),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? '代码编辑器', spellcheck: 'false' })
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 初始化只跑一次；后续通过 compartments 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 外部 value 同步（历史恢复 / 预览切换 / 重新加载） */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    const selection = view.state.selection.main
    const head = Math.min(selection.head, value.length)
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: head }
    })
  }, [value])

  /* 只读 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
      )
    })
  }, [readOnly])

  /* 主题 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? darkEditorTheme : lightEditorTheme)
    })
  }, [theme])

  /* 换行 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(lineWrapping ? EditorView.lineWrapping : [])
    })
  }, [lineWrapping])

  /* 语言（按需异步加载） */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const token = ++loadToken.current
    void loadLanguageExtension(language).then((support) => {
      const currentView = viewRef.current
      if (!currentView || token !== loadToken.current) return
      currentView.dispatch({
        effects: languageCompartment.current.reconfigure(support ?? [])
      })
    })
  }, [language])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      openSearch: () => {
        const view = viewRef.current
        if (view) openSearchPanel(view)
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      setValue: (next: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
      }
    }),
    []
  )

  return <div className="code-editor-host" ref={hostRef} data-language={language} />
})

export default CodeEditor
