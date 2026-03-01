/**
 * Type declarations for neo-blessed.
 * neo-blessed is a fork of blessed with similar API.
 */

declare module 'neo-blessed' {
  import { EventEmitter } from 'events';

  // Top-level factory functions
  export function screen(options?: Widgets.ScreenOptions): Widgets.Screen;
  export function box(options?: Widgets.BoxOptions): Widgets.BoxElement;
  export function list(options?: Widgets.ListOptions): Widgets.ListElement;
  export function text(options?: Widgets.TextOptions): Widgets.TextElement;
  export function log(options?: Widgets.LogOptions): Widgets.Log;

  // Widgets namespace (compatibility with @types/blessed)
  export namespace Widgets {
    interface ScreenOptions {
      smartCSR?: boolean;
      title?: string;
      fullUnicode?: boolean;
      warnings?: boolean;
      autoPadding?: boolean;
      cursor?: {
        artificial?: boolean;
        shape?: 'block' | 'underline' | 'line';
        blink?: boolean;
        color?: string;
      };
      log?: string;
      dump?: string;
      debug?: boolean;
    }

    interface BoxOptions {
      parent?: Node;
      top?: number | string;
      left?: number | string;
      right?: number | string;
      bottom?: number | string;
      width?: number | string;
      height?: number | string;
      content?: string;
      tags?: boolean;
      border?: 'line' | 'bg' | { type: 'line' | 'bg'; ch?: string; fg?: string; bg?: string };
      style?: StyleOptions;
      scrollable?: boolean;
      keys?: boolean;
      vi?: boolean;
      alwaysScroll?: boolean;
      scrollbar?: {
        ch?: string;
        track?: { bg?: string };
        style?: { bg?: string; inverse?: boolean };
      };
      mouse?: boolean;
      input?: boolean;
      keyable?: boolean;
      label?: string;
      clickable?: boolean;
      focused?: boolean;
      hidden?: boolean;
      shrink?: boolean;
      padding?: number | { left?: number; right?: number; top?: number; bottom?: number };
      valign?: 'top' | 'middle' | 'bottom';
      align?: 'left' | 'center' | 'right';
      name?: string;
      interactive?: boolean;
    }

    interface ListOptions extends BoxOptions {
      items?: string[];
      selected?: number;
    }

    interface TextOptions extends BoxOptions {
      fill?: boolean;
    }

    interface LogOptions extends BoxOptions {
      bufferLength?: number;
    }

    interface StyleOptions {
      fg?: string;
      bg?: string;
      bold?: boolean;
      underline?: boolean;
      blink?: boolean;
      inverse?: boolean;
      invisible?: boolean;
      border?: { fg?: string; bg?: string };
      focus?: { border?: { fg?: string; bg?: string } };
      scrollbar?: { bg?: string; inverse?: boolean };
      selected?: { bg?: string; fg?: string; bold?: boolean };
      item?: { bg?: string; fg?: string };
    }

    interface IKeyEventArg {
      name: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
      sequence: string;
      full: string;
    }

    interface IMouseEventArg {
      x: number;
      y: number;
      action: string;
      button?: string;
    }

    namespace Events {
      type IKeyEventArg = Widgets.IKeyEventArg;
      type IMouseEventArg = Widgets.IMouseEventArg;
    }

    class Node extends EventEmitter {
      type: string;
      parent?: Node;
      children: Node[];
      screen: Screen;
      width: number | string;
      height: number | string;
      top: number | string;
      left: number | string;
      right: number | string;
      bottom: number | string;
      hidden: boolean;
      position: { top: number; left: number; right: number; bottom: number };

      append(child: Node): void;
      prepend(child: Node): void;
      remove(child: Node): void;
      detach(): void;
      destroy(): void;
      show(): void;
      hide(): void;
      toggle(): void;
      focus(): void;
      setFront(): void;
      setBack(): void;
    }

    class BoxElement extends Node {
      content: string;
      setContent(content: string): void;
      getContent(): string;
      insertLine(i: number, lines: string | string[]): void;
      deleteLine(i: number, n?: number): void;
      getLine(i: number): string;
      getBaseLine(i: number): string;
      setLine(i: number, line: string): void;
      clearLine(i: number): void;
      insertTop(lines: string | string[]): void;
      insertBottom(lines: string | string[]): void;
      deleteTop(n?: number): void;
      deleteBottom(n?: number): void;
      setScrollPerc(perc: number): void;
      getScrollPerc(): number;
      scroll(offset: number): void;
      scrollTo(index: number): void;
      getScrollHeight(): number;
      resetScroll(): void;
      render(): void;
      setLabel(text: string): void;
      removeLabel(): void;
      setHover(text: string): void;
      removeHover(): void;
    }

    class ListElement extends BoxElement {
      items: BoxElement[];
      selected: number;
      value: string;

      add(content: string): void;
      addItem(content: string): void;
      removeItem(index: number): void;
      insertItem(i: number, content: string): void;
      getItem(index: number): BoxElement;
      setItem(index: number, content: string): void;
      clearItems(): void;
      setItems(items: string[]): void;
      select(index: number): void;
      move(offset: number): void;
      up(amount?: number): void;
      down(amount?: number): void;
      pick(callback: (err: Error | null, item: string) => void): void;
    }

    class TextElement extends BoxElement {}

    class Log extends BoxElement {
      log(text: string): void;
      add(text: string): void;
    }

    class Screen extends Node {
      program: any;
      tput: any;
      focused?: BoxElement;
      title: string;

      key(keys: string | string[], callback: (ch: string, key: IKeyEventArg) => void): void;
      onceKey(keys: string | string[], callback: (ch: string, key: IKeyEventArg) => void): void;
      unkey(keys: string | string[], callback?: (ch: string, key: IKeyEventArg) => void): void;

      spawn(file: string, args?: string[], options?: any): any;
      exec(file: string, args?: string[], options?: any, callback?: Function): any;

      readEditor(options: any, callback: Function): void;

      setEffects(el: BoxElement, fel: BoxElement, over: any, out: any, effects?: any, temp?: any): void;

      render(): void;
      realloc(): void;
      draw(start: number, end: number): void;
      clearRegion(xi: number, xl: number, yi: number, yl: number): void;

      destroy(): void;

      log(...args: any[]): void;
      debug(...args: any[]): void;

      enableMouse(el?: BoxElement): void;
      enableKeys(el?: BoxElement): void;
      enableInput(el?: BoxElement): void;

      copyToClipboard(text: string): boolean;
      cursorShape(shape: string, blink?: boolean): boolean;
      cursorColor(color: string): boolean;
      cursorReset(): boolean;

      screenshot(xi?: number, xl?: number, yi?: number, yl?: number): string;

      saveFocus(): BoxElement | undefined;
      restoreFocus(): BoxElement | undefined;
      focusNext(): void;
      focusPrevious(): void;
      focusPush(el: BoxElement): void;
      focusPop(): BoxElement | undefined;
    }
  }
}

declare module 'blessed-contrib' {
  import * as blessed from 'neo-blessed';

  interface GridOptions {
    rows: number;
    cols: number;
    screen: blessed.Widgets.Screen;
  }

  class Grid {
    constructor(options: GridOptions);
    set(row: number, col: number, rowSpan: number, colSpan: number, widget: any, options?: any): any;
  }

  function grid(options: GridOptions): Grid;
}
