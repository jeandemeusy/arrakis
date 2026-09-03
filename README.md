# Gnosis VPN Network Intelligence

Public investor dashboard backed by Blokli's GraphQL API.

The app reads its endpoint from `BLOKLI_GRAPHQL_URL` and refreshes the server-rendered snapshot every five minutes. It deliberately
distinguishes live indexed metrics from externally reported program KPIs. The current Blokli API supports network, account, Safe, channel,
balance, and service-registry panels. Exact historical rolling MAU will require a dedicated aggregation resolver over ticket-redemption
history.

Run it from the repository's Nix shell:

```bash
cd dashboard
npm run dev
```
