export function toggleFullscreen(el: Element | null | undefined): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void el?.requestFullscreen?.().catch(() => {});
}

export function tileElement(identity: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="tile"][data-identity="${CSS.escape(identity)}"]`);
}
