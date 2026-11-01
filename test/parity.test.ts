/**
 * The bundled Gnosis VPN dashboard against the snapshot it replaces, on two
 * generated networks: every figure the old page showed must come out the
 * same from the saved queries and charts. Skipped without
 * TEST_ADMIN_DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { adminUrl, createDemoDatabases } from './support';

describe(
  'parity with the snapshot dashboard',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let lib: {
      parity: typeof import('../lib/parity');
      networks: typeof import('../lib/networks');
      clock: typeof import('../lib/query/clock');
    };

    before(async () => {
      const databases = await createDemoDatabases('arrakis_p', [
        { id: 'dufour', seed: 'dufour', clients: 80, head: 46_000_000 },
        { id: 'jura', seed: 'jura', clients: 40, head: 39_000_000 },
      ]);
      process.env.APP_DATABASE_URL = databases.appUrl;
      process.env.NETWORKS = JSON.stringify(
        databases.networks.map((network) => ({
          id: network.id,
          label: network.id,
          databaseUrl: network.url,
        })),
      );
      process.env.ARRAKIS_SCHEDULER = '0';
      const install = await import('../lib/seed/install');
      const exits = await import('../lib/query/exits');
      const results = await import('../lib/query/results');
      const store = await import('../lib/query/store');
      lib = {
        parity: await import('../lib/parity'),
        networks: await import('../lib/networks'),
        clock: await import('../lib/query/clock'),
      };
      lib.clock.holdClocks();

      const principal = await install.installerPrincipal();
      const report = await install.installSeed('gnosis-vpn', principal);
      assert.equal(report.updated.length, 0);
      const again = await install.installSeed('gnosis-vpn', principal);
      assert.equal(again.created.length, 0, 'a second install creates nothing');

      for (const network of lib.networks.resolveNetworks()) {
        const listed = databases.networks.find(
          (entry) => entry.id === network.id,
        );
        for (const address of listed?.exits ?? []) {
          await exits.addExit(network, { address, label: 'exit' }, principal);
        }
        for (const definition of install.seedOf('gnosis-vpn').queries) {
          if (definition.kind !== 'query') continue;
          const query = await store.getQuery(definition.slug);
          assert.ok(query, definition.slug);
          await results.materialize({
            query,
            network,
            supplied: {},
            trigger: 'editor',
          });
        }
      }
    });

    after(async () => {
      await (await import('../lib/analytics')).closeIndexPools();
      await (await import('../lib/db/app')).closeAppDb();
      await (await import('../lib/query/runner')).closeQueryPools();
    });

    const check = async (ids: string[]) => {
      const targets = lib.networks
        .resolveNetworks()
        .filter((network) => ids.includes(network.id));
      const lines = await lib.parity.checkParity(targets, { clients: 2 });
      const differing = lines.filter((line) => line.status === 'differs');
      assert.deepEqual(
        differing.map(
          (line) =>
            `${line.area} · ${line.metric}: ${line.old} vs ${line.new} ${line.note ?? ''}`,
        ),
        [],
      );
      // Enough was compared to mean something.
      assert.ok(lines.filter((line) => line.status === 'match').length > 50);
      return lines;
    };

    it('matches on one network', async () => {
      const lines = await check(['dufour']);
      const mau = lines.find((line) => line.metric === 'Monthly active users');
      assert.ok(Number(mau?.new) > 0, 'the network has active users');
    });

    it('matches on the other network', async () => {
      await check(['jura']);
    });

    it('matches across both networks combined', async () => {
      await check(['dufour', 'jura']);
    });
  },
);
