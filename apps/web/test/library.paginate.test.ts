import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, pageList, pageOf, paginate } from '../src/library/paginate';

const n = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe('paginate', () => {
  it('shows nine cards a page', () => {
    expect(PAGE_SIZE).toBe(9);
    const s = paginate(n(20), 1);
    expect(s.items).toEqual(n(9));
    expect(s).toMatchObject({ page: 1, pages: 3, first: 1, last: 9 });
  });

  it('the last page holds what is left', () => {
    expect(paginate(n(20), 3)).toMatchObject({ items: [19, 20], page: 3, pages: 3, first: 19, last: 20 });
  });

  it('a page past the end shows the last page; below 1 or not a number shows the first', () => {
    expect(paginate(n(20), 9).page).toBe(3);
    expect(paginate(n(20), 0).page).toBe(1);
    expect(paginate(n(20), -4).page).toBe(1);
    expect(paginate(n(20), Number.NaN).page).toBe(1);
  });

  it('nothing to show is one empty page', () => {
    expect(paginate([], 2)).toEqual({ items: [], page: 1, pages: 1, first: 0, last: 0 });
  });

  it('exactly nine is one page', () => {
    expect(paginate(n(9), 2)).toMatchObject({ page: 1, pages: 1 });
  });

  it('knows the page of an item', () => {
    expect(pageOf(0)).toBe(1);
    expect(pageOf(8)).toBe(1);
    expect(pageOf(9)).toBe(2);
    expect(pageOf(26)).toBe(3);
  });
});

describe('pageList', () => {
  it('lists every page up to seven', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps seven slots with gaps for more', () => {
    expect(pageList(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageList(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageList(5, 20)).toEqual([1, 'gap', 4, 5, 6, 'gap', 20]);
    expect(pageList(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
    expect(pageList(20, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });
});
