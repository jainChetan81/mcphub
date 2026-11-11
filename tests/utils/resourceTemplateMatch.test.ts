import { uriMatchesResourceTemplate } from '../../src/utils/resourceTemplateMatch.js';
import { UriTemplate } from '../../src/clients/mcpSdkClient.js';

describe('uriMatchesResourceTemplate', () => {
  it.each([
    ['x://item/{id}', 'x://item/', true],
    ['x://item/{id}/detail', 'x://item//detail', true],
    ['x://item{#frag}', 'x://item', true],
    ['x://item{#frag}', 'x://item#', true],
    ['x://item{#frag}', 'x://item#foo', true],
    ['x://item{#frag}', 'x://itemfoo', false],
    ['x://item/{id}', 'x://item/foo#bar', false],
    ['x://item/{id}', 'x://item/foo?bar', false],
    ['x://item{/id}', 'x://item', true],
    ['x://item{/id}', 'x://item/', true],
  ])('matches %s against %s as %s', (template, uri, expected) => {
    expect(uriMatchesResourceTemplate(template, uri)).toBe(expected);
  });

  it('accepts omitted and reordered optional query variables', () => {
    expect(uriMatchesResourceTemplate('x://search{?q}', 'x://search')).toBe(true);
    expect(uriMatchesResourceTemplate('x://search{?q,limit}', 'x://search?limit=5')).toBe(true);
    expect(uriMatchesResourceTemplate('x://search{?q,limit}', 'x://search?limit=5&q=docs')).toBe(
      true,
    );
    expect(uriMatchesResourceTemplate('x://search{?q,limit}', 'x://search?unknown=5')).toBe(false);
  });

  it.each([
    ['x://items{/category,id}', 'x://items/books/42', true],
    ['x://items/{category,id}', 'x://items/books,42', true],
    ['x://items{/category,id}', 'x://items/42', true],
    ['x://items{/category,id}', 'x://items/books/42/extra', false],
    ['x://items{/category,id}', 'x://itemsbooks,42', false],
    ['x://items{.category,id}', 'x://items.books.42', true],
    ['x://items{.category,id}', 'x://itemsbooks,42', false],
    ['x://items{#category,id}', 'x://itemsbooks,42', false],
    ['x://items/{category,id}', 'x://items/books/42', false],
    ['x://items/{category,id}', 'x://items/books,42?admin=1', false],
    ['x://items/{category,id}', 'x://items/books,42#admin', false],
    ['x://items{/category,id}', 'x://items/books/42?admin=1', false],
    ['x://items{/category,id}', 'x://items/books/42#admin', false],
    ['x://items{/ids*}', 'x://items/books/42/extra', true],
    ['x://items/{ids}', 'x://items/books,42', true],
  ])('respects multi-variable delimiters: %s -> %s (%s)', (template, uri, expected) => {
    expect(uriMatchesResourceTemplate(template, uri)).toBe(expected);
  });

  const operators = ['', '+', '#', '.', '/', '?', '&'];
  const values = ['books', '', 'two words', 'a/b', 'a,b', 'a?b', 'a#b', 'a&b=c', 'a%20b'];
  it.each(operators)('accepts SDK scalar expansions for operator "%s" and 1-3 variables', (op) => {
    for (let count = 1; count <= 3; count++) {
      const names = ['a', 'b', 'c'].slice(0, count);
      const template = `x://items{${op}${names.join(',')}}`;
      for (const value of values) {
        for (let mask = 0; mask < 1 << count; mask++) {
          const defined = names.filter((_, index) => mask & (1 << index));
          const variables = Object.fromEntries(defined.map((name) => [name, value]));
          // SDK 2.1 drops operators and encoding for multi-variable non-query
          // expansions. Compose its single-variable expansions in those cases;
          // never use its vulnerable matcher or accept missing URI delimiters.
          let uri: string;
          if (count === 1 || op === '?' || op === '&') {
            uri = new UriTemplate(template).expand(variables);
          } else {
            const valueOp = op === '#' ? '+' : op;
            const expanded = defined.map((name) =>
              new UriTemplate(`{${valueOp}${name}}`).expand(variables),
            );
            const separator = op === '/' || op === '.' ? '' : ',';
            const prefix = op === '#' && defined.length > 0 ? '#' : '';
            uri = `x://items${prefix}${expanded.join(separator)}`;
          }
          expect({ template, uri, matches: uriMatchesResourceTemplate(template, uri) }).toEqual({
            template,
            uri,
            matches: true,
          });
        }
      }
    }
  });

  it.each(['', '+', '?', '&'])('accepts direct SDK multi-variable output for "%s"', (op) => {
    for (const variables of [{ a: 'books', b: '42' }, { b: '42' }, { a: '', b: '' }, {}]) {
      const template = `x://items{${op}a,b}`;
      expect(uriMatchesResourceTemplate(template, new UriTemplate(template).expand(variables))).toBe(
        true,
      );
    }
  });

  it.each(operators)('accepts SDK list expansions for "%s"', (op) => {
    const template = `x://items{${op}ids*}`;
    for (const ids of [[], [''], ['books', '42'], ['', '42', ''], ['a/b', 'a,b', 'a?b', 'a#b']]) {
      expect(uriMatchesResourceTemplate(template, new UriTemplate(template).expand({ ids }))).toBe(
        true,
      );
    }
  });

  it('bounds matching work for adversarial repeated delimiters', () => {
    const uri = `x://${'_'.repeat(1000)}`;
    // CPU time excludes time spent waiting for this shared host's scheduler.
    const startedAt = process.cpuUsage();
    expect(uriMatchesResourceTemplate('x://{a}_{b}_{c}_{d}', uri)).toBe(true);
    expect(uriMatchesResourceTemplate('x://{a}_{b}_{c}_{d}/end', uri)).toBe(false);
    const elapsed = process.cpuUsage(startedAt);
    expect((elapsed.user + elapsed.system) / 1000).toBeLessThan(500);
  });

  it('rejects oversized templates and URIs', () => {
    expect(uriMatchesResourceTemplate(`x://${'{id}'.repeat(200)}`, 'x://value')).toBe(false);
    expect(uriMatchesResourceTemplate('x://{id}', `x://${'a'.repeat(5000)}`)).toBe(false);
  });
});
