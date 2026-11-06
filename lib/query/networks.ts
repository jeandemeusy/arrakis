import 'server-only';

import { HttpError, notFound } from '../api/errors';
import { resolveNetworks, type NetworkConfig } from '../networks';

/** The configured networks, or a 503 that says why there are none. */
export function networks(): NetworkConfig[] {
  try {
    return resolveNetworks();
  } catch (error) {
    throw new HttpError(
      503,
      `Data sources are misconfigured: ${(error as Error).message}`,
    );
  }
}

export function network(id: string): NetworkConfig {
  const found = networks().find((entry) => entry.id === id);
  if (!found) throw notFound(`Unknown data source: ${id}`);
  return found;
}

/** `all` means every network; anything else names one. */
export function targetNetworks(id: string | null | undefined): NetworkConfig[] {
  if (!id || id === 'all') return networks();
  return [network(id)];
}
