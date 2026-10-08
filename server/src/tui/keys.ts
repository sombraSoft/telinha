// A small key-handler stack. One useKeyboard/usePaste at the root dispatches
// here; the innermost mounted component gets keys first and returning true
// stops the key there. Lets a text field own printable keys while Esc / ←
// fall through to the screen's "back" and Ctrl+C to the root's quit.
import type { KeyEvent } from '@opentui/core';
import { createContext, onCleanup, useContext } from 'solid-js';

export interface KeyHandler {
  key?: (k: KeyEvent) => boolean | undefined;
  paste?: (text: string) => boolean | undefined;
}
export type KeyStack = KeyHandler[];

export const KeysCtx = createContext<KeyStack>([]);

/** Pushes a handler for the lifetime of the calling component. */
export function useKeys(h: KeyHandler): void {
  const stack = useContext(KeysCtx);
  stack.push(h);
  onCleanup(() => {
    const i = stack.indexOf(h);
    if (i >= 0) stack.splice(i, 1);
  });
}

export function dispatchKey(stack: KeyStack, k: KeyEvent): boolean {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.key?.(k)) return true;
  return false;
}

export function dispatchPaste(stack: KeyStack, text: string): boolean {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.paste?.(text)) return true;
  return false;
}

export const isPrintable = (k: KeyEvent): boolean =>
  !k.ctrl &&
  !k.meta &&
  typeof k.sequence === 'string' &&
  k.sequence.length >= 1 &&
  [...k.sequence].every((ch) => ch >= ' ' && ch !== '\x7f');

export const isEnter = (k: KeyEvent): boolean => k.name === 'return' || k.name === 'enter';
export const isSpace = (k: KeyEvent): boolean => k.name === 'space' || k.sequence === ' ';
export const isUp = (k: KeyEvent): boolean => !k.ctrl && (k.name === 'up' || k.name === 'k');
export const isDown = (k: KeyEvent): boolean => !k.ctrl && (k.name === 'down' || k.name === 'j');
export const isCtrlC = (k: KeyEvent): boolean => k.ctrl && k.name === 'c';
