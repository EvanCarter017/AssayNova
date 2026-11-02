// Server-only helpers. Source files are read by explicit routes, never by URL paths.
const renderers = ['renderSubmission', 'renderSuccess', 'renderReport', 'renderPortal', 'renderRequestDetail'];

export function tagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return source.length;
}

export function annotateHTML(source, file = 'dist/index.html') {
  let result = '';
  let index = 0;
  let line = 1;
  let raw = '';
  const append = (end, suffix = '') => {
    const part = source.slice(index, end);
    result += part + suffix;
    line += (part.match(/\n/g) || []).length;
    index = end;
  };
  while (index < source.length) {
    if (raw) {
      const closing = new RegExp(`</${raw}(?=[\\s>])`, 'ig');
      closing.lastIndex = index;
      const match = closing.exec(source);
      if (!match) { append(source.length); break; }
      append(match.index);
      raw = '';
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      append(end === -1 ? source.length : end + 3);
      continue;
    }
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      append(next === -1 ? source.length : next);
      continue;
    }
    const match = /^<([a-z][\w:-]*)(?=[\s/>])/i.exec(source.slice(index));
    const end = tagEnd(source, index + 1);
    if (!match) { append(end); continue; }
    const original = source.slice(index, end);
    // Append before the original slash/closing bracket, retaining all original bytes.
    const insertion = original.endsWith('/>') ? end - 2 : end - 1;
    const annotation = ` data-an-dev-file="${file.replace(/[&"<>]/g, '')}" data-an-dev-line="${line}"`;
    append(insertion, annotation);
    append(end);
    if (/^(script|style|textarea|title)$/i.test(match[1]) && !original.endsWith('/>')) raw = match[1];
  }
  return result;
}

// Recognize declarations only in JavaScript code, excluding comments, strings,
// and template text. Template expressions can contain nested templates/braces.
export function rendererDefinitions(source) {
  const found = {};
  const stack = [{ mode: 'code', depth: 0 }];
  let line = 1;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    const state = stack.at(-1);
    if (character === '\n') line++;
    if (state.mode === 'line') { if (character === '\n') stack.pop(); continue; }
    if (state.mode === 'comment') {
      if (character === '*' && next === '/') { stack.pop(); index++; }
      continue;
    }
    if (state.mode === 'regex') {
      if (character === '\\') { index++; continue; }
      if (character === '[') state.characterClass = true;
      else if (character === ']') state.characterClass = false;
      else if (character === '/' && !state.characterClass) stack.pop();
      continue;
    }
    if (state.mode === '"' || state.mode === "'") {
      if (character === '\\') { if (next === '\n') line++; index++; }
      else if (character === state.mode) stack.pop();
      continue;
    }
    if (state.mode === 'template') {
      if (character === '\\') { if (next === '\n') line++; index++; }
      else if (character === '`') stack.pop();
      else if (character === '$' && next === '{') { stack.push({ mode: 'code', depth: 1 }); index++; }
      continue;
    }
    if (character === '/' && next === '/') { stack.push({ mode: 'line' }); index++; continue; }
    if (character === '/' && next === '*') { stack.push({ mode: 'comment' }); index++; continue; }
    if (character === '/') {
      const prefix = source.slice(0, index).trimEnd();
      if (!prefix || /[=(:,\[!&|?{};]$/.test(prefix) || /\b(return|throw|case|yield)\s*$/.test(prefix)) {
        stack.push({ mode: 'regex', characterClass: false });
        continue;
      }
    }
    if (character === '"' || character === "'") { stack.push({ mode: character }); continue; }
    if (character === '`') { stack.push({ mode: 'template' }); continue; }
    if (state.depth && character === '{') state.depth++;
    if (state.depth && character === '}' && --state.depth === 0) { stack.pop(); continue; }
    if (character !== 'f' || /[\w$]/.test(source[index - 1] || '')) continue;
    const match = /^function\s+(render\w+)\s*\([^)]*\)\s*\{/.exec(source.slice(index));
    if (match && renderers.includes(match[1])) {
      found[match[1]] = { file: 'dist/app.js', line, function: match[1], precision: 'function-definition (not the exact child template line)' };
    }
  }
  return found;
}

export function sourceMetadata(projectRoot, source) {
  return { projectRoot, renderers: rendererDefinitions(source), mapping: 'plain HTML annotations and verified named JS renderer definitions; no framework component mapping' };
}
