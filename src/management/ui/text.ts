import stringWidth from 'string-width';
import { cleanText } from '../../util.js';
export function fit(text: string, width: number) {
  const safe = cleanText(text).replace(/[\r\n\t]/g, ' ');
  if (stringWidth(safe) <= width) return safe;
  let result = '';
  for (const char of safe) {
    if (stringWidth(result + char) > Math.max(0, width - 1)) break;
    result += char;
  }
  return result + '…';
}
