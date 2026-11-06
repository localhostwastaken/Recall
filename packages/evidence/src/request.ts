/**
 * The User-Agent every capture sends (ruling R26). Evidence is public and permanent, so it must
 * not carry the capturer's real browser and OS version; one fixed, common desktop string also
 * keeps captures by different people comparable.
 */
export const CAPTURE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * The request headers of every capture besides Host, with their only allowed values (rulings
 * R20, R26). The extension sends exactly these, and check B refuses a request where one is
 * missing, repeated or different: a server can pick another variant of a page by Accept,
 * Accept-Language or User-Agent, and that variant must not pass as a new version of the page.
 * Host is the only header that varies; it must name the signed server.
 */
export const CAPTURE_REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'identity',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': CAPTURE_USER_AGENT,
  Connection: 'close',
} as const;
