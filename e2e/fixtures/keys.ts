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
