/**
 * mentionWidget - an `@` mention's line-end affordance (Deep next R11, D1
 * §5.2's inline style): one dim button at the end of the cursor's line,
 * "Ask Hester ⌘⏎", "Hand off to Claude ⌘⏎" or "Reply to <hand-off> ⌘⏎"
 * with the exact text it will send. Nothing is sent as you type; only a
 * click or ⌘⏎ sends.
 */

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface ShownMention {
  /** End of the line (where the button sits). */
  pos: number;
  line: number;
  label: string;
  /** The exact text that will be sent (C3), shown in the button. */
  text: string;
}

export const setMention = StateEffect.define<ShownMention | null>();

class MentionWidget extends WidgetType {
  constructor(
    readonly shown: ShownMention,
    readonly send: () => void,
  ) {
    super();
  }
  eq(other: MentionWidget): boolean {
    return other.shown.label === this.shown.label && other.shown.text === this.shown.text;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'deep-aff deep-mention-aff';
    wrap.setAttribute('contenteditable', 'false');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'deep-aff-btn';
    b.textContent = `${this.shown.label} ⌘⏎`;
    b.title = this.shown.text ? `Sends: ${this.shown.text}` : this.shown.label;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.send();
    });
    wrap.appendChild(b);
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export function mentionField(send: () => void) {
  return StateField.define<{ shown: ShownMention | null; deco: DecorationSet }>({
    create: () => ({ shown: null, deco: Decoration.none }),
    update(value, tr) {
      let shown = value.shown;
      for (const e of tr.effects) if (e.is(setMention)) shown = e.value;
      if (shown && tr.docChanged && !tr.effects.some((e) => e.is(setMention))) {
        shown = { ...shown, pos: tr.changes.mapPos(shown.pos, 1) };
      }
      if (shown === value.shown) return value;
      if (!shown) return { shown: null, deco: Decoration.none };
      const deco = Decoration.set([Decoration.widget({ widget: new MentionWidget(shown, send), side: 1 }).range(shown.pos)]);
      return { shown, deco };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}
