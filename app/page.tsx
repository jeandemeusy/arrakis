import Dashboard, { type DashboardData } from "./dashboard";

const BLOKLI_QUERY = `
  query InvestorDashboard {
    chainInfo { __typename ... on ChainInfo { blockNumber chainId network expectedBlockTime finality } }
    accounts: accountCount { __typename ... on Count { count } }
    channels: channelStats(status: OPEN) { __typename ... on ChannelStats { count balance } }
    safes: safesBalance { __typename ... on SafesBalance { count balance } }
    exits: serviceCount(serviceType: "gvpn:exit") { __typename ... on Count { count } }
    exitServices: services(serviceType: "gvpn:exit", first: 200) {
      __typename
      ... on ServicesList { services { node registeredAt updatedAt } watermark }
    }
  }
`;

type BlokliResponse = {
  data?: {
    chainInfo?: {
      __typename: string;
      blockNumber?: number;
      chainId?: number;
      network?: string;
      expectedBlockTime?: number;
      finality?: number;
    };
    accounts?: { __typename: string; count?: number };
    channels?: { __typename: string; count?: number; balance?: string };
    safes?: { __typename: string; count?: number; balance?: string };
    exits?: { __typename: string; count?: number };
    exitServices?: {
      __typename: string;
      watermark?: number;
      services?: Array<{
        node: string;
        registeredAt: number;
        updatedAt: number;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
};

function monthKey(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

async function loadDashboard(): Promise<DashboardData> {
  const endpoint =
    process.env.BLOKLI_GRAPHQL_URL ??
    "https://blokli-jura.dev.hoprnet.link/graphql";
  const observedAt = new Date().toISOString();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-blokli-schema-version": "1",
      },
      body: JSON.stringify({ query: BLOKLI_QUERY }),
      next: { revalidate: 300 },
    });
    if (!response.ok) throw new Error(`Blokli returned ${response.status}`);
    const payload = (await response.json()) as BlokliResponse;
    if (!payload.data || payload.errors?.length)
      throw new Error(payload.errors?.[0]?.message ?? "Missing Blokli data");

    const { chainInfo, accounts, channels, safes, exits, exitServices } =
      payload.data;
    const monthly = new Map<
      string,
      { month: string; registrations: number; updates: number; order: number }
    >();
    for (const service of exitServices?.services ?? []) {
      const date = new Date(service.registeredAt * 1000);
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const item = monthly.get(key) ?? {
        month: monthKey(service.registeredAt),
        registrations: 0,
        updates: 0,
        order: date.getTime(),
      };
      item.registrations += 1;
      if (service.updatedAt > service.registeredAt) item.updates += 1;
      monthly.set(key, item);
    }

    return {
      source: "live",
      endpoint,
      observedAt,
      network: chainInfo?.network ?? "HOPR on Gnosis",
      blockNumber: chainInfo?.blockNumber ?? 0,
      finality: chainInfo?.finality ?? 0,
      accounts: accounts?.count ?? 0,
      openChannels: channels?.count ?? 0,
      channelBalance: channels?.balance ?? "0 wxHOPR",
      safes: safes?.count ?? 0,
      safeBalance: safes?.balance ?? "0 wxHOPR",
      exits: exits?.count ?? 0,
      exitActivity: [...monthly.values()]
        .sort((a, b) => a.order - b.order)
        .slice(-8),
    };
  } catch {
    return {
      source: "reference",
      endpoint,
      observedAt,
      network: "jura-prod",
      blockNumber: 0,
      finality: 0,
      accounts: null,
      openChannels: null,
      channelBalance: null,
      safes: null,
      safeBalance: null,
      exits: null,
      exitActivity: [],
    };
  }
}

export default async function Home() {
  return <Dashboard data={await loadDashboard()} />;
}
