import { Neovim } from '@chemzqm/neovim'
import { Disposable } from 'vscode-languageserver-protocol'
import events from '../events'
import Document from '../model/document'
import sources from '../sources'
import { CompleteConfig, CompleteOption, RecentScore, VimCompleteItem } from '../types'
import { disposeAll, wait } from '../util'
import { byteSlice, isWord } from '../util/string'
import workspace from '../workspace'
import Complete from './complete'
const logger = require('../util/logger')('completion')

export interface LastInsert {
  character: string
  timestamp: number
}

export class Completion implements Disposable {
  public completeItems: VimCompleteItem[] = []
  public config: CompleteConfig
  private document: Document
  // current input string
  private activted = false
  private input: string
  private lastInsert?: LastInsert
  private nvim: Neovim
  private disposables: Disposable[] = []
  private complete: Complete | null = null
  private recentScores: RecentScore = {}
  private triggerCharacters: Set<string> = new Set()
  private changedTick = 0
  private currIndex = 0
  private insertCharTs = 0
  private insertLeaveTs = 0
  private complteChangeTs = 0
  private resolveId: number
  // only used when hasChangedEvent is false
  private isResolving = false
  private resolveTimer: NodeJS.Timer

  public init(nvim: Neovim): void {
    this.nvim = nvim
    this.config = this.getCompleteConfig()
    events.on('InsertCharPre', this.onInsertCharPre, this, this.disposables)
    events.on('InsertLeave', this.onInsertLeave, this, this.disposables)
    events.on('InsertEnter', this.onInsertEnter, this, this.disposables)
    events.on('TextChangedP', this.onTextChangedP, this, this.disposables)
    events.on('TextChangedI', this.onTextChangedI, this, this.disposables)
    events.on('CompleteDone', this.onCompleteDone, this, this.disposables)
    events.on('CompleteChanged', this.onCompleteChanged, this, this.disposables)
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('coc.preferences')) {
        Object.assign(this.config, this.getCompleteConfig())
      }
    }, null, this.disposables)
  }

  public get option(): CompleteOption {
    if (!this.complete) return null
    return this.complete.option
  }

  // vim's logic for filter items
  public filterItemsVim(input: string): VimCompleteItem[] {
    return this.completeItems.filter(item => {
      return item.word.startsWith(input)
    })
  }

  public get index(): number {
    return this.currIndex
  }

  private addRecent(word: string, bufnr: number): void {
    if (!word) return
    this.recentScores[`${bufnr}|${word}`] = Date.now()
  }

  private get hasChangedEvent(): boolean {
    return this.complteChangeTs != 0
  }

  private async getPreviousCharacter(document: Document): Promise<string> {
    let [, lnum, col] = await this.nvim.call('getcurpos')
    let line = document.getline(lnum - 1)
    return col == 1 ? '' : byteSlice(line, col - 2, col - 1)
  }

  public async getResumeInput(): Promise<string> {
    let { option, document, activted } = this
    if (!activted) return null
    let [, lnum, col] = await this.nvim.call('getcurpos')
    if (lnum != option.linenr || col < option.col + 1) {
      return null
    }
    let line = document.getline(lnum - 1)
    return byteSlice(line, option.col, col - 1)
  }

  private get bufnr(): number {
    let { option } = this
    return option ? option.bufnr : null
  }

  public get isActivted(): boolean {
    return this.activted
  }

  private getCompleteConfig(): CompleteConfig {
    let config = workspace.getConfiguration('coc.preferences')
    let keepCompleteopt = config.get<boolean>('keepCompleteopt', false)
    let autoTrigger = config.get<string>('autoTrigger', 'always')

    if (keepCompleteopt && !workspace.completeOpt.includes('noinsert')) {
      autoTrigger = 'none'
    }

    return {
      autoTrigger,
      triggerAfterInsertEnter: config.get<boolean>('triggerAfterInsertEnter', false),
      noselect: config.get<boolean>('noselect', true),
      keepCompleteopt,
      numberSelect: config.get<boolean>('numberSelect', false),
      acceptSuggestionOnCommitCharacter: config.get<boolean>('acceptSuggestionOnCommitCharacter', false),
      maxItemCount: config.get<number>('maxCompleteItemCount', 50),
      timeout: config.get<number>('timeout', 500),
      minTriggerInputLength: config.get<number>('minTriggerInputLength', 1),
      snippetIndicator: config.get<string>('snippetIndicator', '~'),
      fixInsertedWord: config.get<boolean>('fixInsertedWord', true),
      localityBonus: config.get<boolean>('localityBonus', true),
    }
  }

  public async startCompletion(option: CompleteOption): Promise<void> {
    workspace.bufnr = option.bufnr
    let document = workspace.getDocument(option.bufnr)
    if (!document) return
    // use fixed filetype
    option.filetype = document.filetype
    this.document = document
    try {
      await this._doComplete(option)
    } catch (e) {
      this.stop()
      workspace.showMessage(`Error happens on complete: ${e.message}`, 'error')
      logger.error(e.stack)
    }
  }

  private async resumeCompletion(search: string | null, _isChangedP = false): Promise<void> {
    let { document, complete, activted } = this
    if (!activted || !complete.results || search == this.input) return
    let completeInput = complete.input
    if (search == null ||
      search.endsWith(' ') ||
      search.length < completeInput.length) {
      this.stop()
      return
    }
    let { changedtick } = document
    this.input = search
    let items: VimCompleteItem[]
    if (complete.isIncomplete) {
      await document.patchChange()
      document.forceSync()
      await wait(30)
      if (document.changedtick != changedtick) return
      items = await complete.completeInComplete(search)
      if (document.changedtick != changedtick) return
    } else {
      items = complete.filterResults(search)
    }
    if (!this.isActivted) return
    if (!items || items.length === 0) {
      this.stop()
      return
    }
    await this.showCompletion(this.option.col, items)
  }

  private appendNumber(items: VimCompleteItem[]): void {
    if (!this.config.numberSelect) return
    for (let i = 1; i <= 10; i++) {
      let item = items[i - 1]
      if (!item) break
      let idx = i == 10 ? 0 : i
      item.abbr = item.abbr ? `${idx} ${item.abbr}` : `${idx} ${item.word}`
    }
  }

  public hasSelected(): boolean {
    if (this.hasChangedEvent) return this.currIndex !== 0
    if (this.config.noselect === false) return true
    return this.isResolving
  }

  private async showCompletion(col: number, items: VimCompleteItem[]): Promise<void> {
    let { nvim, document } = this
    this.appendNumber(items)
    this.changedTick = document.changedtick
    if (this.config.numberSelect) {
      nvim.call('coc#_map', [], true)
    }
    nvim.call('coc#_do_complete', [col, items], true)
    this.completeItems = items
  }

  private async _doComplete(option: CompleteOption): Promise<void> {
    let { linenr, line } = option
    let { nvim, config } = this
    // current input
    this.input = option.input
    this.triggerCharacters = sources.getTriggerCharacters(option.filetype)
    let isTriggered = this.triggerCharacters.has(option.triggerCharacter)
    let arr = sources.getCompleteSources(option, isTriggered)
    if (!arr.length) return
    let complete = new Complete(option, this.document, this.recentScores, config, nvim)
    this.start(complete)
    let items = await this.complete.doComplete(arr)
    if (complete.isCanceled || !this.isActivted) return
    if (items.length == 0) {
      this.stop()
      return
    }
    let search = await this.getResumeInput()
    if (complete.isCanceled) return
    if (search == option.input) {
      await this.showCompletion(option.col, items)
      return
    }
    await this.resumeCompletion(search)
  }

  private async onTextChangedP(): Promise<void> {
    let { option, document } = this
    if (!document || !option) return
    await document.patchChange()
    // avoid trigger filter on pumvisible
    if (document.changedtick == this.changedTick) return
    if (!this.latestInsert) {
      // this could be wrong, but can't avoid.
      this.isResolving = true
      return
    }
    this.lastInsert = null
    let col = await this.nvim.call('col', '.')
    let line = document.getline(option.linenr - 1)
    let ind = option.line.match(/^\s*/)[0]
    let curr = line.match(/^\s*/)[0]
    if (ind.length != curr.length) {
      let newCol = option.col + curr.length - ind.length
      if (newCol > col - 1) return
      let newLine = curr + option.line.slice(ind.length)
      let colnr = option.colnr + curr.length - ind.length
      Object.assign(option, { col: newCol, line: newLine, colnr })
    }
    let search = byteSlice(line, option.col, col - 1)
    await this.resumeCompletion(search, true)
  }

  private async onTextChangedI(bufnr: number): Promise<void> {
    let { nvim, latestInsertChar } = this
    let document = workspace.getDocument(workspace.bufnr)
    if (!document) return
    this.lastInsert = null
    if (latestInsertChar && document) await document.patchChange()
    if (this.isActivted) {
      if (bufnr !== this.bufnr) return
      // check commit character
      if (this.config.acceptSuggestionOnCommitCharacter
        && this.completeItems.length
        && latestInsertChar
        && !isWord(latestInsertChar)
        && this.hasChangedEvent) {
        let item = this.currIndex ? this.completeItems[this.currIndex - 1] : this.completeItems[0]
        if (sources.shouldCommit(item, latestInsertChar)) {
          let { linenr, col, line, colnr } = this.option
          this.stop()
          let { word } = item
          let newLine = `${line.slice(0, col)}${word}${latestInsertChar}${line.slice(colnr - 1)}`
          await nvim.call('coc#util#setline', [linenr, newLine])
          let curcol = col + word.length + 2
          await nvim.call('cursor', [linenr, curcol])
          return
        }
      }
      let search = await this.getResumeInput()
      if (!this.isActivted) return
      let character = search ? search[search.length - 1] : ''
      // check trigger character.
      if (character && this.triggerCharacters.has(character)) {
        let option: CompleteOption = await this.nvim.call('coc#util#get_complete_option')
        option.triggerCharacter = character
        logger.debug('trigger completion with', option)
        await this.startCompletion(option)
        return
      }
      // could be search not change or filtered by _doComplete
      return await this.resumeCompletion(search)
    }
    let character = await this.getPreviousCharacter(document)
    if (!character) return
    if (latestInsertChar) await this.triggerCompletion(document, character)
  }

  private async triggerCompletion(document: Document, character: string): Promise<void> {
    // check trigger
    let shouldTrigger = await this.shouldTrigger(document, character)
    if (!shouldTrigger) return
    let option: CompleteOption = await this.nvim.call('coc#util#get_complete_option')
    option.triggerCharacter = character
    logger.debug('trigger completion with', option)
    await this.startCompletion(option)
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    let { document, nvim } = this
    if (this.resolveTimer) clearTimeout(this.resolveTimer)
    if (!this.isActivted || !document || !item.word) return
    let opt = Object.assign({}, this.option)
    item = this.completeItems.find(o => o.word == item.word && o.user_data == item.user_data)
    this.stop()
    if (!item) return
    let timestamp = this.insertCharTs
    let insertLeaveTs = this.insertLeaveTs
    await document.patchChangedTick()
    let { changedtick } = document
    try {
      await sources.doCompleteResolve(item)
      this.addRecent(item.word, document.bufnr)
      await wait(50)
      let mode = await nvim.call('mode')
      if (mode != 'i' || this.insertCharTs != timestamp || this.insertLeaveTs != insertLeaveTs) return
      await document.patchChange()
      if (changedtick != document.changedtick) return
      await sources.doCompleteDone(item, opt)
      document.forceSync()
    } catch (e) {
      // tslint:disable-next-line:no-console
      console.error(e.stack)
      logger.error(`error on complete done`, e.stack)
    }
  }

  private async onInsertLeave(bufnr: number): Promise<void> {
    this.insertLeaveTs = Date.now()
    let doc = workspace.getDocument(bufnr)
    if (doc) doc.forceSync(true)
    this.stop()
  }

  private async onInsertEnter(): Promise<void> {
    if (!this.config.triggerAfterInsertEnter) return
    let option = await this.nvim.call('coc#util#get_complete_option')
    if (option.input.length >= this.config.minTriggerInputLength) {
      await this.startCompletion(option)
    }
  }

  private async onInsertCharPre(character: string): Promise<void> {
    // hack to make neovim not flicking
    if (this.isActivted &&
      workspace.isNvim &&
      this.completeItems.length &&
      !global.hasOwnProperty('__TEST__') &&
      !this.triggerCharacters.has(character) &&
      isWord(character)) {
      this.nvim.call('coc#_reload', [], true)
    }
    this.lastInsert = {
      character,
      timestamp: Date.now(),
    }
    this.insertCharTs = this.lastInsert.timestamp
  }

  private get latestInsert(): LastInsert | null {
    let { lastInsert } = this
    if (!lastInsert || Date.now() - lastInsert.timestamp > 100) {
      return null
    }
    return lastInsert
  }

  private get latestInsertChar(): string {
    let { latestInsert } = this
    if (!latestInsert) return ''
    return latestInsert.character
  }

  public async shouldTrigger(document: Document, character: string): Promise<boolean> {
    if (!character || character == ' ') return false
    let autoTrigger = this.config.autoTrigger
    if (autoTrigger == 'none') return false
    if (sources.shouldTrigger(character, document.filetype)) return true
    if (autoTrigger !== 'always') return false
    if (document.isWord(character)) {
      let minLength = this.config.minTriggerInputLength
      if (minLength == 1) return true
      let input = await this.nvim.call('coc#util#get_input') as string
      return input.length >= minLength
    }
    return false
  }

  public async onCompleteChanged(item: VimCompleteItem): Promise<void> {
    this.complteChangeTs = Date.now()
    let resolveId = this.resolveId = Date.now()
    if (this.resolveTimer) clearTimeout(this.resolveTimer)
    if (Object.keys(item).length == 0) {
      this.currIndex = 0
    } else {
      let idx = this.completeItems.findIndex(o => o.word == item.word && o.user_data == item.user_data)
      if (idx == -1) {
        this.currIndex = 0
        return
      }
      this.currIndex = idx + 1
      item = this.completeItems[idx]
      this.resolveTimer = setTimeout(async () => {
        await sources.doCompleteResolve(item)
        if (this.resolveId == resolveId && this.isActivted) {
          await this.showDocumentation(item.info)
        }
      }, 50)
    }
  }

  public start(complete: Complete): void {
    let { activted } = this
    this.activted = true
    this.isResolving = false
    if (activted) {
      this.complete.cancel()
    }
    this.complete = complete
    this.completeItems = []
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${this.completeOpt}`, true)
    }
    this.document.forceSync(true)
    this.document.paused = true
  }

  public stop(): void {
    let { nvim } = this
    if (!this.activted) return
    this.activted = false
    this.document.paused = false
    this.document.fireContentChanges()
    this.completeItems = []
    if (this.complete) {
      this.complete.cancel()
      this.complete = null
    }
    if (this.config.numberSelect) {
      nvim.call('coc#_unmap', [], true)
    }
    nvim.call('coc#_hide', [], true)
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${workspace.completeOpt}`, true)
    }
  }

  private get completeOpt(): string {
    let { noselect } = this.config
    let preview = workspace.completeOpt.indexOf('preview') !== -1
    return `${noselect ? 'noselect,' : ''}noinsert,menuone${preview ? ',preview' : ''}`
  }

  private async showDocumentation(content: string): Promise<void> {
    // TODO use previewwindow
    let { nvim } = this
    if (!content) {
      await nvim.command('echo ""')
    } else {
      let cmdHeight = await nvim.getOption('cmdheight') as number
      let columns = await nvim.getOption('columns') as number
      let max = cmdHeight * columns - 16
      let line = content.split('\n')[0]
      if (content.length > max) line = line.slice(0, max) + '...'
      nvim.command(`echohl MoreMsg | echom '${line.replace(/'/g, "''")}' | echohl None`, true)
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export default new Completion()
