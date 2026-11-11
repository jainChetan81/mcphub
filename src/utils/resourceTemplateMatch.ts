// Adapted from samanhappy/mcphub PR #1472, merge commit 8f13817018a196ebc1ce20eaa8b27b99e3249a84 (Apache-2.0).
import { UriTemplate } from '../clients/mcpSdkClient.js';

const MAX_URI_LENGTH = 4096;
const MAX_TEMPLATE_LENGTH = 512;

type Part = string | { operator: string; names: string[]; exploded: boolean };
type CharTest = (char: string) => boolean;
type Element =
  | { kind: 'literal'; char: string }
  | { kind: 'optional'; length: number }
  | { kind: 'star'; test: CharTest }
  | { kind: 'plus'; test: CharTest };

const OPERATORS = ['+', '#', '.', '/', '?', '&'];
// Commas can separate variables or list items. They cannot introduce a new
// path, query or fragment owner; those delimiters require explicit operators.
const segmentChar: CharTest = (char) => !'/?#'.includes(char);
const anyChar: CharTest = (char) => !'\n\r\u2028\u2029'.includes(char);
const queryValueChar: CharTest = (char) => char !== '&';
// Only reserved expansions may carry raw question marks in their values.
const carriesQuestion = (part: Exclude<Part, string>): boolean =>
  part.operator === '+' || part.operator === '#';
const withoutQuestion =
  (test: CharTest): CharTest =>
  (char) =>
    char !== '?' && test(char);

// Same parts as the SDK's UriTemplate parser.
const parseTemplate = (template: string): Part[] => {
  const parts: Part[] = [];
  let literal = '';
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '{') {
      literal += template[i];
      continue;
    }
    if (literal) parts.push(literal);
    literal = '';
    const end = template.indexOf('}', i);
    const expression = template.slice(i + 1, end);
    const operator = OPERATORS.find((op) => expression.startsWith(op)) ?? '';
    const names = expression
      .slice(operator.length)
      .split(',')
      .map((name) => name.replace('*', '').trim())
      .filter((name) => name.length > 0);
    parts.push({ operator, names, exploded: expression.includes('*') });
    i = end;
  }
  if (literal) parts.push(literal);
  return parts;
};

const literalElements = (text: string): Element[] =>
  text.split('').map((char) => ({ kind: 'literal', char }));

const optional = (elements: Element[]): Element[] => [
  { kind: 'optional', length: elements.length },
  ...elements,
];

// Keep matching bounded while allowing omitted variables and requiring operator delimiters.
const toElements = (parts: Part[], encoded = false): Element[] =>
  parts.flatMap((part): Element[] => {
    if (typeof part === 'string') return literalElements(part);
    const raw = !encoded || carriesQuestion(part);
    const segment = raw ? segmentChar : withoutQuestion(segmentChar);
    const queryValue = raw ? queryValueChar : withoutQuestion(queryValueChar);
    switch (part.operator) {
      case '?':
      case '&':
        return part.names.flatMap((name, index) => [
          ...literalElements(`${index === 0 ? part.operator : '&'}${name}=`),
          { kind: 'plus', test: queryValue },
        ]);
      case '+':
        return [{ kind: 'star', test: anyChar }];
      case '#':
        return optional([...literalElements('#'), { kind: 'star', test: anyChar }]);
      case '.':
        return optional([...literalElements('.'), { kind: 'star', test: segment }]);
      case '/':
        // Each scalar variable contributes one path segment. An exploded list
        // can contribute more; missing variables contribute no delimiter.
        if (part.exploded) {
          return optional([
            ...literalElements('/'),
            { kind: 'star', test: (char) => char === '/' || segment(char) },
          ]);
        }
        return optional([
          ...literalElements('/'),
          { kind: 'star', test: segment },
          ...part.names.slice(1).flatMap(() =>
            optional([...literalElements('/'), { kind: 'star', test: segment }]),
          ),
        ]);
      default:
        return [{ kind: 'star', test: segment }];
    }
  });

// Bounded state matching takes O(input length * element count), without regex
// backtracking when expressions share a segment (`{year}-{month}-{day}`).
// States: 2 * element index + 0 (before), 1 (inside).
// Returns, for each prefix length of the input, whether the elements match it.
const matchPrefixes = (elements: Element[], input: string): boolean[] => {
  const accept = 2 * elements.length;
  const close = (states: Set<number>): Set<number> => {
    for (const state of states) {
      const index = Math.floor(state / 2);
      const element = elements[index];
      if (state % 2 === 1 || element?.kind === 'star') states.add(2 * (index + 1));
      if (element?.kind === 'optional') {
        states.add(2 * (index + 1));
        states.add(2 * (index + 1 + element.length));
      }
    }
    return states;
  };
  const matched = new Array<boolean>(input.length + 1).fill(false);
  let states = close(new Set([0]));
  matched[0] = states.has(accept);
  // UTF-16 code units, like the SDK's non-unicode regex.
  const chars = input.split('');
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const next = new Set<number>();
    for (const state of states) {
      if (state === accept) continue;
      const index = Math.floor(state / 2);
      const element = elements[index];
      if (element.kind === 'optional') continue;
      if (element.kind === 'literal') {
        if (char === element.char) next.add(2 * (index + 1));
      } else if (element.test(char)) {
        next.add(2 * index + 1);
      }
    }
    if (next.size === 0) return matched;
    states = close(next);
    matched[i + 1] = states.has(accept);
  }
  return matched;
};

type CompiledTemplate = {
  elements: Element[];
  // The template before its trailing `{?...}`/`{&...}` expansions, and what those declare.
  base?: { elements: Element[]; hasQuery: boolean; names: Set<string>; exploded: boolean };
};

const compiledTemplates = new Map<string, CompiledTemplate | null>();
const MAX_COMPILED_TEMPLATES = 1000;

const compileTemplate = (template: string): CompiledTemplate | null => {
  if (compiledTemplates.has(template)) {
    return compiledTemplates.get(template)!;
  }
  let compiled: CompiledTemplate | null;
  try {
    // The SDK still validates the template (syntax and size limits).
    new UriTemplate(template);
    const parts = parseTemplate(template);
    compiled = { elements: toElements(parts) };
    let start = parts.length;
    while (start > 0) {
      const part = parts[start - 1];
      if (typeof part === 'string' || (part.operator !== '?' && part.operator !== '&')) break;
      start--;
    }
    if (start < parts.length) {
      const baseParts = parts.slice(0, start);
      const queryParts = parts.slice(start) as Exclude<Part, string>[];
      compiled.base = {
        // Only literals, `{?..}` and expressions whose values keep `?` can put one
        // into the base.
        elements: toElements(baseParts, true),
        hasQuery: baseParts.some((part) =>
          typeof part === 'string'
            ? part.includes('?')
            : part.operator === '?' || carriesQuestion(part),
        ),
        // The SDK expands `{?a:3}` as `a:3=...`, so accept both spellings.
        names: new Set(
          queryParts.flatMap((part) =>
            part.names.flatMap((name) => [name, name.replace(/:\d+$/, '')]),
          ),
        ),
        exploded: queryParts.some((part) => part.exploded),
      };
    }
  } catch {
    compiled = null;
  }
  if (compiledTemplates.size >= MAX_COMPILED_TEMPLATES) {
    compiledTemplates.clear();
  }
  compiledTemplates.set(template, compiled);
  return compiled;
};

// Keys are decoded the way URLSearchParams decodes them (`+`, `%XX`).
const queryKeyAllowed = (key: string, base: NonNullable<CompiledTemplate['base']>): boolean =>
  key !== '' &&
  (base.exploded || base.names.has(new URLSearchParams(`${key}=`).keys().next().value ?? ''));

// The SDK matcher requires every query variable, in order, so `x{?a}` would not
// match `x`. Match the part before trailing query expansions separately.
export const uriMatchesResourceTemplate = (uriTemplate: string, uri: string): boolean => {
  if (
    typeof uriTemplate !== 'string' ||
    typeof uri !== 'string' ||
    uriTemplate.length > MAX_TEMPLATE_LENGTH ||
    uri.length > MAX_URI_LENGTH
  ) {
    return false;
  }
  const compiled = compileTemplate(uriTemplate);
  if (!compiled) {
    return false;
  }
  if (matchPrefixes(compiled.elements, uri)[uri.length]) {
    return true;
  }
  const base = compiled.base;
  if (!base) {
    return false;
  }

  // Without its own query, the base ends at the URI's first `?`. With one
  // (`x?fixed=1{&limit}`), the omitted pairs leave it ending at the URI's end or
  // before a later `&` or `?`. Pairs after that end must use declared names.
  const queryStart = uri.indexOf('?');
  const splitAtQuery = !base.hasQuery && queryStart !== -1;
  const prefixes = matchPrefixes(base.elements, splitAtQuery ? uri.slice(0, queryStart) : uri);
  if (!splitAtQuery && prefixes[uri.length]) {
    return true;
  }
  // Right to left over `&`-separated pairs. A `?` can end the base (`x?a=1{?b}`
  // expands to `x?a=1?b=1`) but does not split pairs, and keys never contain one.
  let end = uri.length;
  let equals = -1;
  let question = -1;
  for (let i = uri.length - 1; i >= 0; i--) {
    const char = uri[i];
    if (char === '=') {
      equals = i;
      continue;
    }
    if (char !== '&' && char !== '?') continue;
    const keyEnd = equals === -1 ? end : equals;
    const baseMayEnd = !splitAtQuery || i === queryStart;
    // Expansions never produce empty pairs; an empty query (`x?`) is fine.
    const pairAllowed =
      i + 1 < end
        ? (question === -1 || question > keyEnd) && queryKeyAllowed(uri.slice(i + 1, keyEnd), base)
        : i === queryStart && end === uri.length;
    if (baseMayEnd) {
      if (pairAllowed && prefixes[i]) {
        return true;
      }
      if (splitAtQuery) {
        return false;
      }
    }
    if (char === '?') {
      question = i;
      continue;
    }
    if (!pairAllowed) {
      return false;
    }
    end = i;
    equals = -1;
    question = -1;
  }
  return false;
};
