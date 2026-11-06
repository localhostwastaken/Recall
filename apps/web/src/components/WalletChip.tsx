import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { MonoValue } from '../ui/MonoValue';
import { StatusBadge } from '../ui/StatusBadge';
import { CHAIN_NAMES, connectWallet, useWallet, type ChainId } from '../wallet';

/**
 * Header chip: Not connected / Connected 0xab…12 · <network> / Wrong network. Connecting
 * only ever happens on a click; the chip itself never prompts.
 */
export function WalletChip() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);

  if (!wallet.address) {
    return (
      <span className="wallet-chip">
        <StatusBadge status="unavailable" label="Not connected" />
        {wallet.hasProvider ? (
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={async () => {
              setBusy(true);
              try {
                await connectWallet();
              } catch {
                /* rejected or no account: the chip stays "Not connected" */
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        ) : (
          <span className="muted wallet-note">MetaMask not found</span>
        )}
      </span>
    );
  }

  const network = wallet.chainId === null ? undefined : CHAIN_NAMES[wallet.chainId as ChainId];
  return (
    <span className="wallet-chip" role="status">
      <Wallet size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>Connected</span>
      <MonoValue value={wallet.address} copy={false} />
      {network ? <span>· {network}</span> : <StatusBadge status="warn" label="Wrong network" />}
    </span>
  );
}
