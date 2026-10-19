import stringWidth from 'string-width';
import { cleanText } from './util.js';
const segmenter = new Intl.Segmenter();
export function inputPreview(draft: string, columns: number) {
  // Borders/padding take four cells; prompt takes two; reserve a cursor cell.
  const available = Math.max(0, columns - 7);
  const lines = cleanText(draft)
    .replace(/\t/g, '  ')
    .split('\n')
    .slice(-2)
    .map((line) => {
      const graphemes = [...segmenter.segment(line.slice(-4096))].map((part) => part.segment);
      let preview = '',
        cells = 0;
      for (let index = graphemes.length - 1; index >= 0; index--) {
        const size = stringWidth(graphemes[index]!);
        if (cells + size > available) break;
        preview = graphemes[index] + preview;
        cells += size;
      }
      return preview;
    });
  return { lines, cursorColumn: 4 + stringWidth(lines.at(-1) ?? '') };
}
