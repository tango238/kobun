// 対話コマンドの入力欄: キーの解釈と、カーソル位置の計算
import { describe, expect, it } from 'vitest';
import { KeyParser, cursorAt, textWidth } from '../src/line-editor';

const parse = (...chunks: string[]) => {
  const p = new KeyParser();
  return chunks.flatMap((c) => p.parse(c));
};

describe('キーの解釈', () => {
  it('Enter は送信', () => {
    expect(parse('\r')).toEqual([{ type: 'submit' }]);
  });

  it('Shift+Enter は改行 (kitty / xterm modifyOtherKeys のどちらの形式でも)', () => {
    expect(parse('\x1b[13;2u')).toEqual([{ type: 'newline' }]);
    expect(parse('\x1b[27;2;13~')).toEqual([{ type: 'newline' }]);
  });

  it('Alt+Enter と Ctrl+J も改行 (Shift+Enter を区別できない端末向け)', () => {
    expect(parse('\x1b\r')).toEqual([{ type: 'newline' }]);
    expect(parse('\n')).toEqual([{ type: 'newline' }]);
  });

  it('貼り付けは改行を含んでも送信されず、1つの入力になる', () => {
    expect(parse('\x1b[200~1行目\r\n2行目\r3行目\n\x1b[201~')).toEqual([
      { type: 'insert', text: '1行目\n2行目\n3行目' },
    ]);
  });

  it('貼り付けが複数のかたまりに分かれて届いても1つにまとめる', () => {
    expect(parse('\x1b[200~前半\r', '後半\x1b[201~', '\r')).toEqual([
      { type: 'insert', text: '前半\n後半' },
      { type: 'submit' },
    ]);
  });

  it('貼り付けを囲む合図を送らない端末でも、改行を含むかたまりは貼り付けとして扱う', () => {
    expect(parse('1行目\r2行目\r')).toEqual([{ type: 'insert', text: '1行目\n2行目' }]);
  });

  it('日本語の入力はそのまま入る', () => {
    expect(parse('請求書を自動化したい')).toEqual([
      { type: 'insert', text: '請求書を自動化したい' },
    ]);
  });

  it('kitty 形式で届く Ctrl+C と通常の Enter', () => {
    expect(parse('\x1b[99;5u')).toEqual([{ type: 'interrupt' }]);
    expect(parse('\x1b[13u')).toEqual([{ type: 'submit' }]);
  });

  it('矢印・Backspace・Delete', () => {
    expect(parse('\x1b[D\x1b[C\x7f\x1b[3~')).toEqual([
      { type: 'left' },
      { type: 'right' },
      { type: 'backspace' },
      { type: 'delete' },
    ]);
  });
});

describe('カーソル位置', () => {
  it('全角は2桁として数える', () => {
    expect(textWidth('abc')).toBe(3);
    expect(textWidth('請求書')).toBe(6);
  });

  it('プロンプト (8桁) の後ろから始まる', () => {
    expect(cursorAt('', 80)).toEqual({ row: 0, col: 8 });
    expect(cursorAt('abc', 80)).toEqual({ row: 0, col: 11 });
  });

  it('改行と、端末幅での折り返しを行数に数える', () => {
    expect(cursorAt('a\nb', 80)).toEqual({ row: 1, col: 9 });
    expect(cursorAt('x'.repeat(20), 20)).toEqual({ row: 1, col: 8 });
    expect(cursorAt(`${'x'.repeat(20)}\ny`, 20)).toEqual({ row: 2, col: 9 });
  });
});
