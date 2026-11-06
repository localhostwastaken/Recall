import { describe, expect, it } from 'vitest';
import { libraryHash, parseHash, routeId } from '../src/router';

describe('library route', () => {
  it('parses q, type and sort from the query', () => {
    expect(parseHash('#/library?q=gov&type=repo&sort=newest')).toEqual({ name: 'library', q: 'gov', type: 'repo', sort: 'newest' });
  });

  it('falls back to the defaults for missing or unknown values', () => {
    expect(parseHash('#/library')).toEqual({ name: 'library', q: '', type: 'all', sort: 'time' });
    expect(parseHash('#/library?type=bogus&sort=nope')).toEqual({ name: 'library', q: '', type: 'all', sort: 'time' });
    expect(parseHash('#/library/')).toEqual({ name: 'library', q: '', type: 'all', sort: 'time' });
  });

  it('decodes the search text', () => {
    expect(parseHash('#/library?q=terms%20of%20service')).toMatchObject({ q: 'terms of service' });
  });

  it('builds the hash and omits defaults', () => {
    expect(libraryHash({ sort: 'time' })).toBe('#/library');
    expect(libraryHash({})).toBe('#/library');
    expect(libraryHash({ q: 'a b', type: 'page', sort: 'ending' })).toBe('#/library?q=a+b&type=page&sort=ending');
    const round = parseHash(libraryHash({ q: 'x&y=z', type: 'repo' }));
    expect(round).toEqual({ name: 'library', q: 'x&y=z', type: 'repo', sort: 'time' });
  });

  it('gives every library view the same route id (typing a search must not remount the page or move focus)', () => {
    expect(routeId(parseHash('#/library?q=a'))).toBe('library');
    expect(routeId(parseHash('#/library?q=b&type=repo&sort=ending'))).toBe('library');
  });

  it('leaves the other routes alone', () => {
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/storage')).toEqual({ name: 'storage' });
  });
});
