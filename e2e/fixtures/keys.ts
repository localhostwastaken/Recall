// Prefunded account of the local arkiv-reth-dev node (chain 1337). It is the
// well-known first "test test ... junk" dev account, public and worthless.
// Never use it anywhere but the local devnet.
export const DEV_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const DEV_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

// Public dev faucet of the bee-compose local Gnosis fork (keccak256("bee-compose dev faucet")).
// Devnet-only, never funded on mainnet; do not use anywhere else.
export const BEE_COMPOSE_FAUCET_KEY =
  '0xc50a4bc364bb2f90007c01e3dc68c5bbc5451d4f7465510e8cffde8c137e6cf9' as const;

// Witness key of the devnet `witness` service (devnet/docker-compose.yml): Hardhat
// account #2 of the public "test test ... junk" mnemonic. Public and test-only;
// pin DEVNET_WITNESS_ADDRESS in local tests. The real witness key lives in .env.local.
export const DEVNET_WITNESS_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
export const DEVNET_WITNESS_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

// Wallets of the keep-alive specs (Task 19): Hardhat accounts #7 and #8 of the public
// "test test ... junk" mnemonic. Public and devnet-only; both are prefunded on the local Arkiv
// chain and the Gnosis fork, and get xBZZ from the faucet in test setup. They exist so these
// specs never send from DEV_PRIVATE_KEY or the faucet key, which other specs use at the same
// time (a shared key means nonce races). Never use them anywhere but the local devnet.
export const KEEPALIVE_WALLET_KEY =
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' as const; // account #7
export const KEEPALIVE_WALLET_ADDRESS = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955' as const;
export const OTHER_WALLET_KEY =
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97' as const; // account #8
export const OTHER_WALLET_ADDRESS = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f' as const;

// Wallets of the @recall/net unit tests that use the devnet (postage and Arkiv extensions):
// Hardhat accounts #10 and #11 of the public "test test ... junk" mnemonic. Public and
// devnet-only. They are not prefunded; the tests fund them in setup (fixtures/fund.ts). They are
// separate from #7 and #8 (the keep-alive e2e spec), so unit and e2e runs never share a nonce.
export const NET_TEST_KEY_A =
  '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897' as const; // account #10
export const NET_TEST_ADDRESS_A = '0xBcd4042DE499D14e55001CcbB24a551F3b954096' as const;
export const NET_TEST_KEY_B =
  '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82' as const; // account #11
export const NET_TEST_ADDRESS_B = '0x71bE63f3384f5fb98995898A86B02Fb2426c5788' as const;
