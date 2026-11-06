import { redactKey } from '@recall/net';
import { BUILT_IN_ARKIV_KEY } from './defaults';
import { getNetConfig } from './net';

/**
 * The text of an error, safe to show and to log: the Arkiv access key (the person's own and the
 * built-in one) is removed. viem puts the request URL in an HTTP error's message, and on the
 * Rabdi host the key is part of that URL. The Arkiv reads already scrub their own errors; this is
 * the second line for anything shown in the page.
 */
export function errorText(e: unknown): string {
  let raw: string;
  try {
    raw = e instanceof Error ? e.message : String(e);
  } catch {
    raw = 'unknown error';
  }
  return redactKey(raw, getNetConfig().arkiv.accessKey, BUILT_IN_ARKIV_KEY);
}

/** `errorText`, but the short message viem gives for its own errors when there is one (first line). */
export function shortErrorText(e: unknown): string {
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  return redactKey(typeof short === 'string' ? short : errorText(e), getNetConfig().arkiv.accessKey, BUILT_IN_ARKIV_KEY);
}
