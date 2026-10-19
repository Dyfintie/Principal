/** Split optional native arguments without invoking a shell or expanding values. */
export function nativeArguments(text: string): string[] {
  const args: string[] = [];
  let word = '',
    quote = '',
    started = false,
    escaped = false;
  for (const char of text) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote || escaped) throw new Error('Close quotes and complete escapes in native options');
  if (started) args.push(word);
  return args;
}
