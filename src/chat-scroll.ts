export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom';
// null follows new conversation output; numeric offsets anchor a visible top row.
export function viewportStart(total: number, height: number, offset: number | null) {
  const maximum = Math.max(0, total - Math.max(1, height));
  return offset === null ? maximum : Math.min(maximum, Math.max(0, offset));
}
export function moveViewport(
  total: number,
  height: number,
  offset: number | null,
  direction: ScrollDirection,
  step = 3,
): number | null {
  const maximum = Math.max(0, total - Math.max(1, height));
  if (direction === 'top') return 0;
  if (direction === 'bottom') return null;
  const next = Math.min(
    maximum,
    Math.max(0, viewportStart(total, height, offset) + (direction === 'up' ? -step : step)),
  );
  return next === maximum ? null : next;
}
// SGR reports are also used for touchpad scrolling by modern terminals.
// A matched non-wheel report returns null so clicks cannot become draft text.
export function mouseScroll(input: string): 'up' | 'down' | null | undefined {
  const event = /^(?:\x1b)?\[<(\d+);\d+;\d+([Mm])$/.exec(input);
  if (!event) return undefined;
  const button = Number(event[1]);
  if (event[2] === 'm' || !(button & 64)) return null;
  const wheel = button & 3;
  return wheel === 0 ? 'up' : wheel === 1 ? 'down' : null;
}
export const terminalInputOn = '\x1b[?2004h\x1b[?1000h\x1b[?1006h';
export const terminalInputOff = '\x1b[?1006l\x1b[?1000l\x1b[?2004l';
