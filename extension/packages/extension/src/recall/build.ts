// Recall build-time flags, injected by webpack's DefinePlugin (webpack.config.js).
// `typeof` guards keep this module importable in unit tests, where nothing is defined.
declare const __RECALL_DEV__: boolean;
declare const __RECALL_DEV_CA_DER_B64__: string;
declare const __RECALL_ARKIV_KEY__: string;

/** Dev builds (RECALL_DEV_CA_DER_B64 or RECALL_DEV=1 at build time) default to the local devnet. */
export const RECALL_DEV: boolean = typeof __RECALL_DEV__ === 'boolean' ? __RECALL_DEV__ : false;

/**
 * The Arkiv access key baked into a release build (R30): `ARKIV_ACCESS_KEY` in the environment of
 * the build, read by webpack.config.js and written to no file of the repo. Dev builds never have
 * it. The person can override it in the settings; an empty override means "use this one".
 */
export const BUILT_IN_ARKIV_KEY: string =
  typeof __RECALL_ARKIV_KEY__ === 'string' ? __RECALL_ARKIV_KEY__.trim() : '';

/** Decodes a base64 DER certificate into the `root_certs` shape tlsn-wasm expects. */
export function rootCertsFromBase64(b64: string | undefined): number[][] | undefined {
  const clean = (b64 ?? '').replace(/\s+/g, '');
  if (!clean) return undefined;
  const bin = atob(clean);
  return [Array.from(bin, (c) => c.charCodeAt(0))];
}

/**
 * The prover's trust roots. Release builds: undefined, so tlsn-wasm uses the Mozilla roots.
 * Dev builds with RECALL_DEV_CA_DER_B64: ONLY the test CA (it replaces the Mozilla roots),
 * matching a witness started with WITNESS_DEV_CA_DER.
 */
export const DEV_ROOT_CERTS: number[][] | undefined = rootCertsFromBase64(
  typeof __RECALL_DEV_CA_DER_B64__ === 'string' ? __RECALL_DEV_CA_DER_B64__ : undefined,
);
