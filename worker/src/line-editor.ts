// 対話コマンド用の複数行エディタ。
//
// Node 標準の readline は「改行 = 送信」なので、複数行の貼り付けが1行ずつ送られてしまう。
// ここでは端末を raw モードにして自前でキーを解釈し、次を区別する:
//   Enter                         送信
//   Shift+Enter / Alt+Enter / Ctrl+J   改行を入れる
//   貼り付け (改行を含んでよい)      そのまま入力欄に入る (送信しない)

export type Key =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'submit' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'clear' }
  | { type: 'interrupt' }
  | { type: 'eof' };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// 端末に送る設定。対応していない端末は無視する。
//   ?2004h     bracketed paste: 貼り付けを PASTE_START/END で囲んで送らせる
//   >4;1m      xterm modifyOtherKeys: Shift+Enter を ESC[27;2;13~ で送らせる
//   >1u        kitty keyboard protocol: Shift+Enter を ESC[13;2u で送らせる
export const TERMINAL_ENABLE = '\x1b[?2004h\x1b[>4;1m\x1b[>1u';
export const TERMINAL_DISABLE = '\x1b[<u\x1b[>4;0m\x1b[?2004l';

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** 貼り付けられた文字列を入力用に整える (末尾の改行は落とす。Enter を押すまで送信しないため) */
function pasted(s: string): Key[] {
  const text = normalizeNewlines(s)
    .replace(/\n+$/, '')
    // 改行とタブ以外の制御文字は入れない
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return text ? [{ type: 'insert', text }] : [];
}

/** 端末から届くバイト列を、キー操作の列に変換する */
export class KeyParser {
  private pasting = false;
  private pasteBuf = '';

  parse(chunk: string): Key[] {
    const keys: Key[] = [];
    let s = chunk;

    if (!this.pasting && !s.includes('\x1b') && s.length > 1 && /[\r\n]/.test(s)) {
      // bracketed paste に対応していない端末での貼り付け。
      // 手で打った Enter は1文字だけで届くので、改行を含む複数文字のかたまりは貼り付けとみなす
      return pasted(s);
    }

    while (s.length > 0) {
      if (this.pasting) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          this.pasteBuf += s;
          return keys;
        }
        keys.push(...pasted(this.pasteBuf + s.slice(0, end)));
        this.pasting = false;
        this.pasteBuf = '';
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        this.pasting = true;
        s = s.slice(PASTE_START.length);
        continue;
      }

      // kitty keyboard protocol: ESC [ <code> ; <modifiers> u
      let m = s.match(/^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u/);
      if (m) {
        s = s.slice(m[0].length);
        const key = csiU(Number(m[1]), Number(m[2] ?? 1) - 1);
        if (key) keys.push(key);
        continue;
      }
      // xterm modifyOtherKeys: ESC [ 27 ; <modifiers> ; <code> ~
      m = s.match(/^\x1b\[27;(\d+);(\d+)~/);
      if (m) {
        s = s.slice(m[0].length);
        const key = csiU(Number(m[2]), Number(m[1]) - 1);
        if (key) keys.push(key);
        continue;
      }
      // Alt+Enter (ESC に続けて Enter)
      if (s.startsWith('\x1b\r') || s.startsWith('\x1b\n')) {
        keys.push({ type: 'newline' });
        s = s.slice(2);
        continue;
      }
      // 矢印などの CSI / SS3 シーケンス
      m = s.match(/^\x1b(?:\[([0-9;?<>=]*)[ -/]*([@-~])|O([A-Z]))/);
      if (m) {
        s = s.slice(m[0].length);
        const final = m[2] ?? m[3];
        if (final === 'D') keys.push({ type: 'left' });
        else if (final === 'C') keys.push({ type: 'right' });
        else if (final === 'H') keys.push({ type: 'home' });
        else if (final === 'F') keys.push({ type: 'end' });
        else if (final === '~' && m[1] === '3') keys.push({ type: 'delete' });
        else if (final === '~' && (m[1] === '1' || m[1] === '7')) keys.push({ type: 'home' });
        else if (final === '~' && (m[1] === '4' || m[1] === '8')) keys.push({ type: 'end' });
        continue;
      }
      if (s[0] === '\x1b') {
        // 単独の ESC や Alt+文字は無視する
        s = s.slice(s.length > 1 ? 2 : 1);
        continue;
      }

      const ch = s[0];
      s = s.slice(1);
      if (ch === '\r') keys.push({ type: 'submit' });
      else if (ch === '\n') keys.push({ type: 'newline' }); // Ctrl+J
      else if (ch === '\x7f' || ch === '\b') keys.push({ type: 'backspace' });
      else if (ch === '\x01') keys.push({ type: 'home' });
      else if (ch === '\x05') keys.push({ type: 'end' });
      else if (ch === '\x15') keys.push({ type: 'clear' });
      else if (ch === '\x03') keys.push({ type: 'interrupt' });
      else if (ch === '\x04') keys.push({ type: 'eof' });
      else if (ch === '\t') keys.push({ type: 'insert', text: '  ' });
      else if (ch >= ' ') {
        // 続く通常の文字はまとめて入れる
        const rest = s.match(/^[^\x00-\x1f\x7f]*/)![0];
        s = s.slice(rest.length);
        keys.push({ type: 'insert', text: ch + rest });
      }
    }
    return keys;
  }
}

function csiU(code: number, mods: number): Key | null {
  const shift = (mods & 1) !== 0;
  const alt = (mods & 2) !== 0;
  const ctrl = (mods & 4) !== 0;
  if (code === 13) return shift || alt || ctrl ? { type: 'newline' } : { type: 'submit' };
  if (code === 127 || code === 8) return { type: 'backspace' };
  if (ctrl && !alt) {
    switch (String.fromCodePoint(code).toLowerCase()) {
      case 'c':
        return { type: 'interrupt' };
      case 'd':
        return { type: 'eof' };
      case 'a':
        return { type: 'home' };
      case 'e':
        return { type: 'end' };
      case 'u':
        return { type: 'clear' };
      case 'j':
        return { type: 'newline' };
    }
    return null;
  }
  if (!alt && code >= 32 && code !== 127 && code < 0xe000) {
    return { type: 'insert', text: String.fromCodePoint(code) };
  }
  return null;
}

/** 端末上の表示幅 (全角は 2、結合文字は 0) */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

const PROMPT = 'あなた> ';
const CONTINUE = '      | ';
const PROMPT_WIDTH = 8;

/** 入力欄の先頭から見た、文字列の末尾のカーソル位置 (行と桁) */
export function cursorAt(text: string, cols: number): { row: number; col: number } {
  const lines = text.split('\n');
  let row = 0;
  for (let i = 0; i < lines.length; i++) {
    const w = PROMPT_WIDTH + textWidth(lines[i]);
    if (i < lines.length - 1) {
      row += Math.max(1, Math.ceil(w / cols));
    } else if (w > 0 && w % cols === 0) {
      // ちょうど右端まで埋まった行では、カーソルは折り返さず右端に留まる
      return { row: row + w / cols - 1, col: cols - 1 };
    } else {
      return { row: row + Math.floor(w / cols), col: w % cols };
    }
  }
  return { row, col: PROMPT_WIDTH };
}

export interface EditorOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  onSubmit: (text: string) => void;
  onExit: () => void;
  /** プロンプトの装飾 (太字など) */
  decorate?: (s: string) => string;
}

export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private drawnCursorRow = 0;
  private drawn = false;
  private readonly parser = new KeyParser();
  private readonly onData = (d: string | Buffer) => this.feed(d.toString());

  constructor(private readonly o: EditorOptions) {}

  start(): void {
    this.o.input.setRawMode(true);
    this.o.input.setEncoding('utf8');
    this.o.input.resume();
    this.o.output.write(TERMINAL_ENABLE);
    this.o.input.on('data', this.onData);
    this.o.output.on('resize', () => this.redraw());
    this.redraw();
  }

  stop(): void {
    this.o.input.off('data', this.onData);
    this.erase();
    this.o.output.write(TERMINAL_DISABLE);
    if (this.o.input.isTTY) this.o.input.setRawMode(false);
    this.o.input.pause();
  }

  /** 入力途中の内容を壊さずに、届いたものを入力欄の上に表示する */
  print(text: string): void {
    this.erase();
    this.o.output.write(`${text.replace(/\r?\n/g, '\r\n')}\r\n\r\n`);
    this.redraw();
  }

  private get cols(): number {
    return Math.max(20, this.o.output.columns ?? 80);
  }

  private erase(): void {
    if (!this.drawn) return;
    if (this.drawnCursorRow > 0) this.o.output.write(`\x1b[${this.drawnCursorRow}A`);
    this.o.output.write('\r\x1b[J');
    this.drawn = false;
    this.drawnCursorRow = 0;
  }

  private redraw(): void {
    this.erase();
    const deco = this.o.decorate ?? ((s: string) => s);
    const text = this.chars.join('');
    const body = text
      .split('\n')
      .map((line, i) => (i === 0 ? deco(PROMPT) : CONTINUE) + line)
      .join('\r\n');
    this.o.output.write(body);
    const end = cursorAt(text, this.cols);
    const cur = cursorAt(this.chars.slice(0, this.cursor).join(''), this.cols);
    if (end.row > cur.row) this.o.output.write(`\x1b[${end.row - cur.row}A`);
    this.o.output.write(`\x1b[${cur.col + 1}G`);
    this.drawnCursorRow = cur.row;
    this.drawn = true;
  }

  private feed(chunk: string): void {
    for (const key of this.parser.parse(chunk)) {
      switch (key.type) {
        case 'insert': {
          const add = Array.from(key.text);
          this.chars.splice(this.cursor, 0, ...add);
          this.cursor += add.length;
          break;
        }
        case 'newline':
          this.chars.splice(this.cursor, 0, '\n');
          this.cursor += 1;
          break;
        case 'backspace':
          if (this.cursor > 0) {
            this.chars.splice(this.cursor - 1, 1);
            this.cursor -= 1;
          }
          break;
        case 'delete':
          this.chars.splice(this.cursor, 1);
          break;
        case 'left':
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case 'right':
          this.cursor = Math.min(this.chars.length, this.cursor + 1);
          break;
        case 'home':
          while (this.cursor > 0 && this.chars[this.cursor - 1] !== '\n') this.cursor -= 1;
          break;
        case 'end':
          while (this.cursor < this.chars.length && this.chars[this.cursor] !== '\n') {
            this.cursor += 1;
          }
          break;
        case 'clear':
          this.chars = [];
          this.cursor = 0;
          break;
        case 'interrupt':
          if (this.chars.length === 0) {
            this.o.onExit();
            return;
          }
          this.chars = [];
          this.cursor = 0;
          break;
        case 'eof':
          if (this.chars.length === 0) {
            this.o.onExit();
            return;
          }
          break;
        case 'submit': {
          const text = this.chars.join('');
          if (text.trim() === '') break;
          // 送った内容は画面に残し、その下に新しい入力欄を出す
          this.cursor = this.chars.length;
          this.redraw();
          this.o.output.write('\r\n\r\n');
          this.chars = [];
          this.cursor = 0;
          this.drawn = false;
          this.drawnCursorRow = 0;
          this.o.onSubmit(text);
          break;
        }
      }
    }
    this.redraw();
  }
}
