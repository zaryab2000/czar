# Circle Agent Marketplace: Catalog Snapshot (Discovery API)

- **Snapshot time:** 2026-10-18 05:20:44 UTC (full crawl) and 05:23:01 UTC (filtered queries)
- **Question:** What can a consumer AI agent actually buy today?
- **Method:** a read-only public API. No wallet, no sign-up, no payment.
- **Grades:** CONFIRMED (measured directly in API data) / STRONG SIGNAL / WEAK SIGNAL / GAP

---

## 1. Access: how the data was obtained

### 1.1 Endpoint (CONFIRMED)
- Base URL: `https://api.circle.com`. The endpoint is `GET /v2/x402/discovery/resources`.
- No API key is needed. The response can be gzip-compressed.
- Source: https://developers.circle.com/agent-stack/agent-marketplace/discovery-api.md (listed in https://developers.circle.com/llms.txt)

### 1.2 Routes tried
| Route | Result |
|---|---|
| `curl` from the container shell | **Blocked.** `CONNECT tunnel failed, response 403`. The proxy reported `connect_rejected` for api.circle.com:443. The same denial hit developers.circle.com, agents.circle.com, api-sandbox.circle.com and docs.arc.io. This is a session egress policy, so I did not retry it. |
| Remote device VM (`device_bash`) | Unavailable. No folders are connected. |
| WebFetch on the API URL | Works, but returns summaries, not raw JSON. I used it only for early totals. |
| **Claude in Chrome, `fetch()` inside an api.circle.com tab** | **Worked.** I crawled all 15 pages (`limit=200`, `offset=0…2800`), each HTTP 200, for **2,858 of 2,858 items** (9.14 MB raw). All analysis below ran on that full set. |

### 1.3 Limitation: where the raw data lives (CONFIRMED)
- The raw 9.1 MB JSON lived only in the browser tab. It could not be written to disk, because the container cannot reach Circle and the tool output is capped.
- So I computed the aggregates in the browser and copied them to `research/catalog/aggregates-2026-10-18T0520Z.json`.
- `research/scripts/check_aggregates.py` (run with `python3 -I`) checks them for internal consistency and against server-side filter totals. **All 14 checks pass.**
- To re-run with raw files saved, add api.circle.com to the session's allowed domains, then curl the URLs in §1.5.

### 1.4 Query parameters (from the docs, then tested live)
| Param | Doc says | Live behaviour (CONFIRMED) |
|---|---|---|
| `query` | Fuzzy search over URL, provider, description, tags | Works, but the matching is weak (see §6.3) |
| `type` | `http` \| `mcp` | `http`=2,858, `mcp`=**0** |
| `category` | 6 enums | All 6 work. **`DATA_ENRICHMENT` is rejected with HTTP 400, yet 198 listings carry that category.** |
| `network` | CAIP-2 or legacy name | `eip155:5042`=2,195 and `base`=2,617 (alias works). `arc` and `arc-testnet` return 0, so there is no Arc alias. |
| `asset` | token address | Arc USDC `0x3600…0000` = 2,197 |
| `scheme` | e.g. `exact` | Only `exact` is accepted. **`upto` and `batch-settlement` return 400, yet 25 and 10 accept entries use them.** |
| `payTo` | seller wallet | not tested |
| `maxUsdPrice` | number | Must be >0 (`0` returns 400). See §3.3. |
| `supportsVanillax402` / `supportsCircleGateway` / `siwx` | booleans | All work. Each true+false pair sums to 2,858. |
| `fields` | sparse fieldset | Works (`fields=resource,metadata.provider.name`) |
| `limit` / `offset` | 1–200 / ≥0 | Works. `pagination.total` is exact. |

### 1.5 Query URLs used (all HTTP 200 unless noted, 2026-10-18 ~05:20–05:25 UTC)
- Full crawl: `https://api.circle.com/v2/x402/discovery/resources?limit=200&offset={0,200,…,2800}`
- Filters: `…/resources?limit=200&` + one of
  - `category=` each of SOCIAL_INTELLIGENCE, FINANCIAL_ANALYSIS, WEB_SEARCH_RESEARCH, PREDICTION_MARKETS, CREATIVE, INFRASTRUCTURE, plus DATA_ENRICHMENT (400) and FOO (400)
  - `network=` eip155:5042, eip155:5042002, arc, arc-testnet, eip155:8453, base, solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, eip155:137, eip155:84532
  - `supportsCircleGateway=true|false`, `supportsVanillax402=true|false`, `siwx=true|false`, `type=http|mcp`
  - `scheme=exact|upto(400)|batch-settlement(400)`, `asset=0x3600000000000000000000000000000000000000`
  - `maxUsdPrice=` 0 (400), 0.0001, 0.001, 0.01, 0.05, 0.1, 1
  - `network=eip155:5042&supportsCircleGateway=true`, `…&maxUsdPrice=0.01`, `supportsCircleGateway=true&siwx=false`
  - `query=` travel, shopping, price, weather, news, translate, image, food, flight, recipe, health, jobs, India, summarize, restaurant, hotel, booking, amazon, music, video, email, phone, sms, gift, maps, movie, sports, stock, crypto, tts, speech, pdf, calendar, book, event, ticket, uber, grocery, pharmacy, insurance, real estate, car, doctor, legal, tax, currency, exchange rate, search

---

## 2. Catalog size and concentration

### 2.1 Headline counts (CONFIRMED)
- **2,858 listings.** Each listing is one endpoint (URL plus method), not one service. There are no duplicate resource+method pairs.
- **43 providers**, **125 origins (hosts)** and **141 distinct payTo wallets**.
- All 2,858 are `type: http`. **There are no MCP listings.**
- `lastUpdated` runs from 2026-08-11 to 2026-10-12, with a median of 2026-09-28. Only 11 listings were updated in October.

### 2.2 Size claims disagree (STRONG SIGNAL)
- The marketplace doc says "600+ live services". The Discovery API doc's example response shows `total: 636`.
- The live API returns 2,858.
- The likely cause is that "services" once meant endpoints and the catalog has since grown, or the doc counts something else. Either way, Circle's published number is about 4.5x below the live count.

### 2.3 Concentration: three providers make up 70% (CONFIRMED)
| Provider | Listings | Share | What it is |
|---|---|---|---|
| AIsa API (`api.aisa.one`) | 1,581 | 55.3% | A reseller that wraps TikHub (954, mostly Chinese social platforms: Douyin 298, TikTok 150, Bilibili 83…), DataForSEO (443), Apollo (54), AgentMail (51), CoinGecko (20), Open-Meteo (12). **Every listing is a flat $0.10.** |
| Orthogonal (`np.orthogonal.com`) | 294 | 10.3% | A nanopayment proxy for about 45 APIs (Serper, Tavily, Precip, Coresignal, Apollo…). **All 294 share one generic description:** "\<x\> endpoint via Orthogonal nanopayment proxy". |
| BlockRun.AI | 138 | 4.8% | LLM, image, video and audio gateway plus market data. Two hosts: `arc.blockrun.ai` (Arc-only, vanilla) and `nano.blockrun.ai` (Gateway). |
| Quicknode | 132 | 4.6% | JSON-RPC nodes, $0.0001 per call |
| The other 39 providers | 713 | 25% | — |

- 390 listings repeat another listing's description, so their descriptions cannot tell them apart.

---

## 3. Categories and pricing

### 3.1 Counts per category (CONFIRMED)
| Category | Listings | Main providers |
|---|---|---|
| SOCIAL_INTELLIGENCE | 1,074 | AIsa 982 (TikHub), Orthogonal 27, StableEmail 23, twit.sh 22 |
| WEB_SEARCH_RESEARCH | 623 | AIsa 511 (DataForSEO, Open-Meteo, Apollo), Orthogonal 73, StableEnrich 11, StableTravel 11 |
| FINANCIAL_ANALYSIS | 470 | LoneStarOracle 71, EMC2 AI 71, Arkham 67, Birdeye 46, Vybe 43 |
| INFRASTRUCTURE | 327 | Quicknode 132, AIsa 51, AgentMail 42, Orthogonal 24, Agentic Reservations 19 |
| DATA_ENRICHMENT *(not in the docs and not filterable)* | 198 | Orthogonal 168, Sponge 13, Syntalic 13, Vangrid 4 |
| PREDICTION_MARKETS | 84 | BlockRun 62, Arkham 22 |
| CREATIVE | 82 | Venice.ai 40, BlockRun 20, Sponge 14, Solana Foundation 8 |

- Category labels are assigned per provider, not per endpoint. The fit is loose: AIsa's Exa and OpenAI web search sit under FINANCIAL_ANALYSIS, Open-Meteo weather sits under WEB_SEARCH_RESEARCH, and the StableTravel flight endpoints come up for "sports".

### 3.2 Price distribution: cheapest accepted option per listing, USD (CONFIRMED)
| Category | n priced | min | p25 | median | p90 | max | ≤$0.01 | >$1 |
|---|---|---|---|---|---|---|---|---|
| SOCIAL_INTELLIGENCE | 1,058 | 0.001 | 0.10 | 0.10 | 0.10 | 8 | 30 | 3 |
| WEB_SEARCH_RESEARCH | 621 | 0.001 | 0.10 | 0.10 | 0.10 | 1 | 41 | 0 |
| FINANCIAL_ANALYSIS | 452 | 0.001 | 0.008 | 0.05 | 0.50 | 200 | 134 | 23 |
| INFRASTRUCTURE | 316 | 0 | 0.0001 | 0.0001 | 0.10 | 10 | 223 | 14 |
| DATA_ENRICHMENT | 195 | 0 | 0.01 | 0.021 | 0.40 | 50 | 83 | 7 |
| PREDICTION_MARKETS | 84 | 0.001 | 0.0085 | 0.0085 | 0.60 | 2 | 62 | 2 |
| CREATIVE | 69 | 0.00003 | 0.04 | 0.40 | 10 | 10 | 10 | 34 |
| **ALL** | **2,795** | **0** | **0.03** | **0.10** | **0.20** | **200** | **583** | **83** |

- **63 listings have an empty `accepts` array.** These are free or helper routes such as health checks, model lists and catalogs. 48 more are priced at $0.
- The most expensive listing is Arkham `address-enriched-batch-all` at $200. Next are Arkham batch endpoints at $50–$100 and the Vangrid capture bounty at $50 (up to $5,000 per the description).
- The Venice.ai price of "$10" looks like an x402 price ceiling, not a real per-call cost (WEAK SIGNAL).
- The median of $0.10 is set by AIsa's flat price. It is not a market-clearing price.

### 3.3 Price thresholds, from server-side `maxUsdPrice` (CONFIRMED)
| ≤ | 0.0001 | 0.001 | 0.01 | 0.05 | 0.10 | 1 |
|---|---|---|---|---|---|---|
| listings | 181 | 235 | 583 | 839 | 2,483 | 2,712 |

---

## 4. Payment rails: networks, assets, schemes

### 4.1 Listings per network, counting a network once per listing (CONFIRMED)
| Network | CAIP-2 | Listings |
|---|---|---|
| Base | eip155:8453 | 2,617 |
| **Arc mainnet** | **eip155:5042** | **2,195** |
| Polygon PoS | eip155:137 | 1,822 |
| Avalanche | eip155:43114 | 1,675 |
| Arbitrum | eip155:42161 | 1,636 |
| Ethereum / OP / Unichain | eip155:1 / 10 / 130 | 1,633 each |
| Solana mainnet | solana:5eykt… | 717 |
| Sonic / World Chain / Sei / HyperEVM | 146 / 480 / 1329 / 999 | 179 each |
| **Arc testnet** | **eip155:5042002** | **134** |
| Base Sepolia / Polygon Amoy / Solana devnet | 84532 / 80002 / solana:EtWT… | 132 each |
| X Layer | eip155:196 | 31 |

- 18 networks in total. The Arc chain IDs come from https://docs.arc.io/arc/references/connect-to-arc.md (testnet 5042002, mainnet 5042).

### 4.2 Arc (CONFIRMED)
- **2,195 listings (76.8%) settle on Arc mainnet.** 2,056 of those settle through Gateway (`GatewayWalletBatched`, Arc USDC `0x3600…0000`).
- **Only 8 providers are on Arc:** AIsa 1,581, Orthogonal 289, Quicknode 132, BlockRun 114, LoneStarOracle 63, Goldsky 11, Vangrid 3, Exa 2.
- So Arc's large share comes almost entirely from AIsa plus Orthogonal (1,870 of 2,195, or 85%).
- **Listings that pay only on Arc:** 73, all BlockRun (`arc.blockrun.ai`).
- **Arc testnet:** 134 listings. Quicknode accounts for 132, so testnet buyers have almost no non-RPC endpoints.
- **None of the consumer-ish vanilla sellers accept Arc:** StableTravel, Syntalic, Agentic Reservations, BRIJ, StableEnrich and StablePhone are all Base and/or Solana only.

### 4.3 Payment rail flags (CONFIRMED)
- `supportsCircleGateway=true`: **2,082 (72.8%)**. It is concentrated in AIsa 1,581, Orthogonal 289 and Quicknode 132, with smaller counts from BlockRun 41, Arrays 15, Goldsky 11, Alchemy 9, Exa 2 and BotPay 2.
- `supportsVanillax402=true`: 873. Both flags: 160. Neither: 63 (the empty-accepts helper routes).
- `siwx=true`: 209. Mostly these are Venice.ai and Agentic Reservations account routes. They need browser sign-in, so a headless agent cannot use them.
- **Only 9 providers support Gateway at all.** The other 34 providers are vanilla-only.

### 4.4 Assets and schemes (CONFIRMED)
- Every accept entry is USDC on its chain. Gateway entries carry `extra.name = "GatewayWalletBatched"` (version 1). Vanilla EVM entries carry `"USD Coin"` (version 2).
- Schemes: `exact` 18,210 entries, `upto` 25 (Solana Foundation Google/Alibaba proxies), `batch-settlement` 10 (vaults.fyi on Base).
- The `scheme` filter accepts only `exact`.
- 36 accept entries have `maxTimeoutSeconds` near 1,792,296,063. Read as a timestamp, that is about 2026-10-18 04:01 UTC, so it looks like a Unix time put in a seconds-duration field. This is a data-quality bug.

---

## 5. Ranking, reputation and quality data

### 5.1 No such signals exist (CONFIRMED)
- I inventoried every key path in all 2,858 items, 3 levels deep, plus every `accepts[]` key.
- The full field set: `resource, type, x402Version, lastUpdated, accepts[scheme, network, asset, payTo, amount, maxTimeoutSeconds, extra], metadata.provider{name, website, docsUrl, openApiUrl, description, category, tags}, metadata{path, method, description, mimeType, input, output, siwx, supportsVanillax402, supportsCircleGateway, requiredHeaders}`.
- A regex search for `rank|reput|rating|score|uptime|usage|popular|quality|review|trust|verified|health|latency|calls|volume|star` over key names found **zero matches**.
- **No field carries ranking, reputation, quality, uptime, usage, ratings or sales volume.** `lastUpdated` is the only time-varying signal.
- The marketplace doc says unreachable endpoints are "auto-excluded" and payout wallets are sanctions-checked. These are binary gates and are not exposed as fields.
- Results come back in alphabetical order by resource URL. The first item is `2captcha…`, then `aero.lonestaroracle…`, then `africa…`. There is no relevance or quality ordering.
- Only 31% of listings have an input schema and 31.5% have an output schema. For the other ~69%, an agent cannot see how to call the endpoint from discovery alone.

### 5.2 agents.circle.com (CONFIRMED that it is no different)
- WebFetch of https://agents.circle.com/services returned an empty table rendered on the client, with no count.
- Its filter tabs are only "All", "1P" (direct from provider) and "3P" (third-party). Column sorting covers "#", "Service" and "Endpoints".
- There are no popularity, rating or uptime columns.
- There is a seller-side "Check your score" option for API domains. It is not shown to buyers.
- Chrome was denied permission to read agents.circle.com, so I could not get the rendered count. **GAP:** I could not confirm whether the website shows the same 2,858 figure.

---

## 6. What a consumer agent can buy today

### 6.1 Consumer-usable listings: 24 picks (CONFIRMED from listing data; not call-tested)
| # | Listing | Origin / path | What it does | Price (USD) | Networks | Gateway |
|---|---|---|---|---|---|---|
| 1 | Syntalic best price | api.syntalic.com `/v1/shopper/best-price` | Lowest price for a product across Amazon, Walmart, Costco… | 0.01 | Base, Sol | No |
| 2 | Syntalic price history / drop alert | `/v1/shopper/price-history`, `/price-drop-alert` | Price over time; recent drops | 0.01 | Base, Sol | No |
| 3 | Syntalic deal finder | `/v1/shopper/deal-finder` | Discounted products in a category | 0.01 | Base, Sol | No |
| 4 | Serper Shopping (via Orthogonal) | np.orthogonal.com `/serper/shopping` | Google Shopping results | 0.004 | Base, **Arc** | **Yes** |
| 5 | Serper Places / Maps / Reviews | `/serper/places`, `/maps`, `/reviews` | Local business search and reviews | 0.002–0.006 | Base, **Arc** | **Yes** |
| 6 | StableEnrich Google Maps | stableenrich.dev `/api/google-maps/text-search/partial` | Places text search and details | 0.02–0.08 | Base, Sol | No |
| 7 | TripAdvisor (via Sponge) | tripadvisor.x402.paysponge.com `/api/v1/location/{id}/details` | Attraction, hotel and restaurant details | 0.01 | Base, Sol | No |
| 8 | Agentic Reservations: discover | agentres.dev `/api/discover/restaurants` (+ `/specials`, `/wait-times`) | Restaurant discovery (Blackbird), live specials, wait times | 0.01 | Base, Sol | No |
| 9 | Agentic Reservations: book | agentres.dev `/api/book`; `/reservation-jobs/create` | **Real Resy booking.** Needs a SIWX account plus a linked Resy account (email OTP). | 0.01; job 3.00 | Base, Sol | No |
| 10 | BRIJ flight search | travel.brij.fi `/air/search` | Live flight offers | 0.10 | Sol | No |
| 11 | BRIJ booking intent | travel.brij.fi `/air/intents` | **Escrow-backed flight booking intent.** This is the only purchase-of-travel endpoint. | 0.10 (+ fare) | Sol | No |
| 12 | StableTravel flight status | stabletravel.dev `/api/flightaware/flights/id` | FlightAware flight tracking | 0.01 | Base, Sol | No |
| 13 | StableTravel airport delays | `/api/flightaware/airports/id/delays` | Airport delays and departures | 0.01–0.02 | Base, Sol | No |
| 14 | Open-Meteo forecast (via AIsa) | api.aisa.one `/apis/v2/openmeteo/forecast` (+ air-quality, marine) | Weather forecast | 0.10 | 8 EVM incl. **Arc** | **Yes** |
| 15 | Precip hourly weather (via Orthogonal) | np.orthogonal.com `/precip/api/v1/hourly` | Hourly temperature, rain and wind | 0.01 | Base, **Arc** | **Yes** |
| 16 | Exa search | api.exa.ai `/search`, `/contents` | AI web search plus page contents | 0.007 / 0.001 | Base, Sol, **Arc** | **Yes** |
| 17 | Tavily search (via Orthogonal) | `/tavily/search`; `/tavily/research` | Web search; deep research | 0.01; 0.50 | Base, **Arc** | **Yes** |
| 18 | Serper News | `/serper/news` | Google News | 0.002 | Base, **Arc** | **Yes** |
| 19 | Qwen-MT translation (Solana Foundation proxy) | translate.alibaba.gateway-402.com `/compatible-mode/v1/chat/completions` | Translation | 0.10 | Sol | No |
| 20 | Google Text-to-Speech (proxy) | texttospeech.google.gateway-402.com `/v1/text:synthesize` | Speech audio from text | 0.00003 (`upto`) | Sol | No |
| 21 | BlockRun image generation | arc.blockrun.ai `/api/v1/images/generations`; nano `/images/image2image` | GPT-Image, Nano Banana, Grok Imagine | 0.022 | **Arc** (arc host); 7 EVM incl. Arc (nano) | No / **Yes** (nano) |
| 22 | BlockRun ElevenLabs speech / music | arc.blockrun.ai `/api/v1/audio/speech`, `/audio/generations` | TTS; music tracks | 0.002 / 0.16 | **Arc** | No (nano music: Yes) |
| 23 | StablePhone AI call | stablephone.dev `/api/call` | AI phone call to a number with a task (for example, calling a shop) | 0.54 | Base, Sol | No |
| 24 | AgentPhone SMS (via Orthogonal) | `/agentphone/v1/messages` | Send SMS | 0.03 | Base, **Arc** | **Yes** |

Honourable mentions:
- Fantastic-Jobs job listings (`/fantastic-jobs/v1/active-jb`, $0.40, Arc and Gateway)
- DripStack paid Substack posts ($0.05–$1)
- StableDomains availability check ($0.01)
- Wolfram Alpha via Sponge (3 listings)
- RentCast real-estate data via Sponge (10 listings)
- Sponge/fal FLUX image generation ($0.01–$0.06)

### 6.2 What a consumer agent can and cannot do (CONFIRMED and STRONG SIGNAL)
- **It can (CONFIRMED):** look things up and create content. That covers prices and deals, weather, flight status, places, news, web search, translation, TTS, images and video.
- **It can transact in only three real-world cases (CONFIRMED):**
  - Resy restaurant bookings via agentres.dev
  - Flight booking intents via BRIJ (escrow, Solana)
  - AI phone calls and SMS
- **The x402 payment buys the API call, not the goods (STRONG SIGNAL).**
  - Example: the BRIJ fare and the Resy booking itself sit outside the $0.10 or $0.01 call fee.
  - CryptoRefills (gift cards, top-ups, eSIM) lists only a free `/v1/brands` route. **No paid purchase endpoint is in the catalog.**
- **A Gateway-on-Arc consumer set is thin (CONFIRMED):** Orthogonal-proxied Serper, Tavily, Precip and AgentPhone; AIsa Open-Meteo and Reddit; Exa; BlockRun nano.
  - Every listing that books or shops is vanilla-only on Base or Solana.
  - `network=eip155:5042&supportsCircleGateway=true&maxUsdPrice=0.01` returns **277** listings, but these are mostly Orthogonal B2B enrichment and Quicknode RPC.

### 6.3 Search quality on consumer terms (CONFIRMED)
Hits are shown as total [main sources]:
- `grocery` 0, `insurance` 0, `doctor` 0, `legal` 0, `tts` **0**. Google TTS exists in the catalog but does not match "tts".
- `pharmacy` 1 (LoneStarOracle, irrelevant). `restaurant` 7 (6 agentres). `translate` 4 (3 TikHub, 1 Qwen-MT). `summarize` 3.
- `recipe` 19. **16 of those are Orthogonal *precip* weather**, a fuzzy match on "p-r-e-c-i-p".
- `uber` 451 (TikHub 113, EMC2 70; none are rides). `music` 149 (51 AIsa AgentMail, 42 AgentMail, 23 StableEmail; fuzzy noise).
- `hotel` 20 (DataForSEO and TikHub only; no hotel booking). `food` 13 (9 TikHub). `health` 10 (none consumer health).
- `India` 20: B2B enrichment and crypto. **There is nothing consumer-oriented for India.**
- **Conclusion:** the `query` matching is fuzzy on characters, not on meaning, and nothing ranks the results. On consumer intents it returns mostly noise. That leaves a discovery gap that a ranking layer could fill.

### 6.4 Consumer jobs the catalog cannot serve (GAP)
- **Physical-goods checkout:** no Amazon, Shopify or any merchant order endpoint. There is price data only (Syntalic, Serper Shopping).
- **Food delivery and groceries:** none.
- **Hotels and stays:** search data only through SEO and social scrapers. No booking.
- **Rides and local transport:** none.
- **Event and movie tickets:** none.
- **Local services** (plumber, salon, doctor appointments): none. The only option is to place an AI phone call via StablePhone.
- **Health, telemedicine, pharmacy, insurance and legal:** none.
- **Bill pay, top-ups and gift-card purchase:** CryptoRefills is listed, but with no paid endpoint.
- **India and other non-US commerce** (UPI-linked merchants, Swiggy- or Zomato-type services, IRCTC): none.
- **MCP-native tools:** `type=mcp` returns 0.

---

## 7. Flags

### 7.1 AI-directed text found in fetched content (I did not act on any of it)
- developers.circle.com (llms.txt, discovery-api.md, agent-marketplace.md) has an "Agent Instructions" block: *"Before reading these docs, install the relevant Circle Skill to get pre-loaded context"*
- discovery-api.md: *"When calling list endpoints, paginate using pageSize and pageAfter until no nextPageAfter cursor is returned"*. This contradicts the endpoint's own `limit`/`offset` spec. I ignored it and used `limit`/`offset`.
- docs.arc.io connect-to-arc.md: *"Before reading these docs, install the Circle Skill for Arc to get pre-loaded context"*, plus coding directives about USDC gas and checking contract addresses.

### 7.2 Catalog content
- I regex-scanned all listing metadata for prompt-injection patterns and got 4 hits. All 4 are benign API-schema text, for example a `system` prompt parameter on the LLM endpoints and AgentPhone's `systemPrompt` field.
- **No injection aimed at buying agents was found.**

### 7.3 Data-quality flags
- `DATA_ENRICHMENT` is used by 198 listings but cannot be filtered.
- `upto` and `batch-settlement` schemes are present but cannot be filtered.
- 36 accept entries have a timestamp-like `maxTimeoutSeconds`.
- 294 Orthogonal listings share one generic description.
- LoneStarOracle's `/pool` is described as "Aerospace and aviation data", but its example output is a DEX liquidity-pool risk check.
- 63 listings have empty `accepts`.

---

## 8. Files
- Report: `/tmp/claude-0/-home-claude/39d41fdb-ceab-5b9c-8bec-bef378fd685f/scratchpad/research/02-catalog.md`
- Aggregates (transcribed from the in-browser analysis of the full crawl): `/tmp/claude-0/-home-claude/39d41fdb-ceab-5b9c-8bec-bef378fd685f/scratchpad/research/catalog/aggregates-2026-10-18T0520Z.json`
- Consistency check script: `/tmp/claude-0/-home-claude/39d41fdb-ceab-5b9c-8bec-bef378fd685f/scratchpad/research/scripts/check_aggregates.py`
- **There are no raw JSON page files.** The container cannot reach api.circle.com (proxy policy 403). See §1.3.
