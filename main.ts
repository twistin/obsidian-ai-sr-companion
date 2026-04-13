import { App, Component, ItemView, MarkdownRenderer, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE = 'sr-review-view';

// ── Utilities ────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function addDaysToToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** djb2-XOR hash → 8-char hex. Used to build stable frontmatter keys per card. */
function cardHash(question: string, answer: string): string {
  let h = 5381;
  const s = `${question.trim()}\x00${answer.trim()}`;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── SM-2 Algorithm ───────────────────────────────────────────────────────────

interface SM2Result {
  interval: number;
  easeFactor: number;
  repetitions: number;
  nextReview: string;
}

function sm2(quality: 0 | 1 | 2, reps: number, interval: number, ef: number): SM2Result {
  const q = quality === 0 ? 0 : quality === 1 ? 3 : 5;
  const newEf = Math.max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));

  let newInterval: number;
  let newReps: number;

  if (q >= 3) {
    newInterval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef);
    newReps = reps + 1;
  } else {
    newInterval = 1;
    newReps = 0;
  }

  return { interval: newInterval, easeFactor: newEf, repetitions: newReps, nextReview: addDaysToToday(newInterval) };
}

// ── Card Model ───────────────────────────────────────────────────────────────

interface SRCard {
  hash: string;          // djb2 hash of question+answer
  question: string;
  answer: string;
  file: TFile;
  interval: number;
  easeFactor: number;
  repetitions: number;
  nextReview: string;    // YYYY-MM-DD
}

// ── Parser ───────────────────────────────────────────────────────────────────

function parseCardsFromFile(content: string, file: TFile, fm: Record<string, unknown>): SRCard[] {
  const cards: SRCard[] = [];
  const lines = content.split('\n');

  // 1. START / Basic / Back: / END blocks
  let inCard = false, q = '', a = '', isBack = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === 'START') {
      inCard = true; q = ''; a = ''; isBack = false;
      if (lines[i + 1]?.trim() === 'Basic') i++;
      continue;
    }
    if (line === 'END' && inCard) {
      if (q.trim() && a.trim()) pushCard(cards, q.trim(), a.trim(), file, fm);
      inCard = false; q = ''; a = ''; isBack = false;
      continue;
    }
    if (inCard) {
      if (line.startsWith('Back:')) { isBack = true; a += line.slice(5).trim() + '\n'; }
      else if (isBack) a += line + '\n';
      else q += line + '\n';
    }
  }

  // 2. Inline :: cards  (Question :: Answer)
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*::\s*(.+)$/);
    if (m) pushCard(cards, m[1].trim(), m[2].trim(), file, fm);
  }

  return cards;
}

function pushCard(cards: SRCard[], question: string, answer: string, file: TFile, fm: Record<string, unknown>) {
  const hash = cardHash(question, answer);
  const key = `sr-${hash}`;
  cards.push({
    hash,
    question,
    answer,
    file,
    interval:    Number(fm[`${key}-interval`] ?? 0),
    easeFactor:  Number(fm[`${key}-ease`]     ?? 2.5),
    repetitions: Number(fm[`${key}-reps`]     ?? 0),
    nextReview:  String(fm[`${key}-due`]       ?? todayStr()),
  });
}

// ── Review View ──────────────────────────────────────────────────────────────

class SRView extends ItemView {
  private cards: SRCard[] = [];
  private idx = 0;
  private flipped = false;
  private stats = { reviewed: 0, correct: 0 };
  private allDone = false;

  constructor(leaf: WorkspaceLeaf, private plugin: SRPlugin) {
    super(leaf);
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Spaced Repetition'; }
  getIcon()        { return 'layers'; }

  async onOpen() {
    // One-time keyboard listener (auto-removed on close via registerDomEvent)
    this.registerDomEvent(window, 'keydown', (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (this.allDone) return;

      if (!this.flipped) {
        if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); this.flip(); }
      } else {
        if (e.key === '1') this.rate(0);
        else if (e.key === '2') this.rate(1);
        else if (e.key === '3') this.rate(2);
      }
    });

    await this.loadDueCards();
    this.render();
  }

  async loadDueCards() {
    this.cards = [];
    const today = todayStr();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file);
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const parsed = parseCardsFromFile(content, file, fm);
      this.cards.push(...parsed.filter(c => c.nextReview <= today));
    }

    // Shuffle
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }

    this.idx = 0;
    this.flipped = false;
    this.allDone = this.cards.length === 0;
    this.stats = { reviewed: 0, correct: 0 };
  }

  flip() {
    this.flipped = true;
    this.render();
  }

  async rate(quality: 0 | 1 | 2) {
    const card = this.cards[this.idx];
    const result = sm2(quality, card.repetitions, card.interval, card.easeFactor);

    this.stats.reviewed++;
    if (quality > 0) this.stats.correct++;

    // Write SR data back to frontmatter
    await this.app.fileManager.processFrontMatter(card.file, (fm) => {
      const key = `sr-${card.hash}`;
      fm[`${key}-due`]      = result.nextReview;
      fm[`${key}-interval`] = result.interval;
      fm[`${key}-ease`]     = parseFloat(result.easeFactor.toFixed(2));
      fm[`${key}-reps`]     = result.repetitions;
    });

    this.idx++;
    this.flipped = false;
    if (this.idx >= this.cards.length) this.allDone = true;
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sr-view');

    // ── All done / empty ──────────────────────────────────────────
    if (this.allDone) {
      const wrap = contentEl.createDiv({ cls: 'sr-done' });
      wrap.createDiv({ cls: 'sr-done-icon', text: '✓' });
      wrap.createEl('h2', { text: this.stats.reviewed > 0 ? 'Session Complete' : 'All caught up!' });

      if (this.stats.reviewed > 0) {
        const acc = Math.round((this.stats.correct / this.stats.reviewed) * 100);
        const row = wrap.createDiv({ cls: 'sr-done-stats' });
        [
          ['Reviewed', String(this.stats.reviewed)],
          ['Correct', `${this.stats.correct}`],
          ['Accuracy', `${acc}%`],
        ].forEach(([label, val]) => {
          const cell = row.createDiv({ cls: 'sr-done-cell' });
          cell.createEl('span', { cls: 'sr-done-val', text: val });
          cell.createEl('span', { cls: 'sr-done-lbl', text: label });
        });
      } else {
        wrap.createEl('p', { cls: 'sr-muted', text: 'No cards due today. Come back tomorrow!' });
      }

      const btn = wrap.createEl('button', { cls: 'sr-btn-primary', text: '↺  Review again' });
      btn.onclick = async () => { await this.loadDueCards(); this.render(); };
      return;
    }

    const card = this.cards[this.idx];

    // ── Progress ─────────────────────────────────────────────────
    const progWrap = contentEl.createDiv({ cls: 'sr-progress-wrap' });
    const bar = progWrap.createDiv({ cls: 'sr-progress-bar' });
    bar.createDiv({
      cls: 'sr-progress-fill',
      attr: { style: `width:${(this.idx / this.cards.length) * 100}%` },
    });
    progWrap.createEl('span', { cls: 'sr-progress-label', text: `${this.idx + 1} / ${this.cards.length}` });

    // ── Card ─────────────────────────────────────────────────────
    const cardEl = contentEl.createDiv({ cls: `sr-card${this.flipped ? ' flipped' : ''}` });
    cardEl.onclick = () => { if (!this.flipped) this.flip(); };

    // Source badge
    const front = cardEl.createDiv({ cls: 'sr-face sr-front' });
    front.createDiv({ cls: 'sr-source', text: card.file.basename });
    const qEl = front.createDiv({ cls: 'sr-content' });
    MarkdownRenderer.render(this.app, card.question, qEl, card.file.path, this as unknown as Component);
    if (!this.flipped) front.createEl('p', { cls: 'sr-hint', text: '▶  Click or press Space to reveal' });

    const back = cardEl.createDiv({ cls: 'sr-face sr-back' });
    back.createDiv({ cls: 'sr-source', text: 'Answer' });
    const aEl = back.createDiv({ cls: 'sr-content' });
    MarkdownRenderer.render(this.app, card.answer, aEl, card.file.path, this as unknown as Component);

    // ── Controls ─────────────────────────────────────────────────
    const ctrl = contentEl.createDiv({ cls: 'sr-controls' });

    if (this.flipped) {
      const BTNS: [string, string, string, 0 | 1 | 2][] = [
        ['sr-btn again', 'Again', '1', 0],
        ['sr-btn hard',  'Hard',  '2', 1],
        ['sr-btn easy',  'Easy',  '3', 2],
      ];
      for (const [cls, label, kbd, rating] of BTNS) {
        const b = ctrl.createEl('button', { cls });
        b.createEl('span', { cls: 'btn-label', text: label });
        b.createEl('kbd', { cls: 'btn-kbd', text: kbd });
        b.onclick = () => this.rate(rating);
      }
    } else {
      const b = ctrl.createEl('button', { cls: 'sr-btn reveal', text: 'Show Answer' });
      b.onclick = () => this.flip();
    }

    // keyboard hint
    contentEl.createEl('p', {
      cls: 'sr-keyboard-hint',
      text: this.flipped ? '1 · Again  ·  2 · Hard  ·  3 · Easy' : 'Space / Enter to reveal',
    });
  }

  async onClose() { /* registerDomEvent handles cleanup */ }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class SRPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new SRView(leaf, this));

    this.addRibbonIcon('layers', 'Spaced Repetition Review', () => this.openView());

    this.addCommand({
      id: 'open-sr-review',
      name: 'Open Review Session',
      callback: () => this.openView(),
    });

    this.addCommand({
      id: 'sr-review-current-file',
      name: 'Review cards from current file',
      editorCallback: (_editor, ctx) => {
        if (ctx.file) this.openView();
      },
    });

    console.log('Obsidian-SR plugin loaded');
  }

  async openView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}
