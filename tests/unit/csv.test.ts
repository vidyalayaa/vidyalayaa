import { it, expect } from 'vitest';
import { parseCsv } from '../../apps/web/src/lib/csv.js';
it('parses quoted CSV, commas, CRLF and escaped quotes', () => {
  expect(parseCsv('a,b\r\n"x,y","quote ""inside"""')).toEqual([
    ['a', 'b'],
    ['x,y', 'quote "inside"'],
  ]);
});
