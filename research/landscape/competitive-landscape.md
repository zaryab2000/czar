# Czar competitive landscape and prior art

- Date of scan: 2026-10-18
- Idea checked ("Czar"):
  - An agent that runs as a Chrome extension and/or a plugin for Claude Code, Codex, Cursor and similar tools
  - It watches daily work and proactively recommends:
    - (a) skills, plugins, MCP servers and open-source tools
    - (b) paid x402 services (Circle Agent Marketplace, Coinbase Bazaar)
    - (c) ERC-8183 escrowed jobs with specialist agents
  - Payments in USDC on Arc
  - Thesis: supply exists but demand does not; Czar brings users to merchants
- Grading key:
  - CONFIRMED = primary page fetched this session
  - STRONG SIGNAL = credible press, or several sources
  - WEAK SIGNAL = single blog, forum or listing
  - GAP = not found or not verified
- Method notes:
  - GitHub repo search through `gh` was blocked (session is bound to its repos), and github.com/search is robots-disallowed. The GitHub bucket therefore relies on web search and skill directories.

---

## Headline finding

- **Anthropic already ships proactive, signal-based plugin suggestions inside Claude Code.** This is the closest prior art to Czar layer 2, and it belongs to the platform owner.
  - "Suggest plugins by relevance": marketplace entries declare `relevance` signals (`cwd`, `cli`, `hosts`, `filesRead`, `manifestDeps`). Claude Code then shows "Working with *topic*? Install the *plugin* plugin". — CONFIRMED https://code.claude.com/docs/en/plugin-relevance.md
    - Matching is local: "does not report which signals matched" to Anthropic or the operator
    - Gated: no marketplace's suggestions appear "until an administrator adds it to the allowlist", and that includes the official one
    - Rate-limited: at most "once every three sessions" per plugin
    - Requires Claude Code v2.1.152+
  - "Recommend your plugin from your CLI": a vendor CLI prints `<claude-code-hint />` to stderr and Claude Code shows an install prompt. — CONFIRMED https://code.claude.com/docs/en/plugin-hints.md
    - Only works for plugins in the official Anthropic marketplace. Hints for other marketplaces "are silently dropped"
    - "Anthropic curates that marketplace at its discretion"
    - At most one hint prompt per session, never in subagents or `-p` mode, and off when telemetry is disabled
  - What this means for Czar:
    - Claude Code already covers "observe the session, then suggest a tool" for its own marketplace
    - Anthropic controls the native suggestion surface and limits it to official or admin-allowlisted marketplaces. A third-party Czar plugin cannot use these surfaces for paid placements.
- **Circle has built the agent-side, reactive version of layer 3.**
  - Its `pay-via-agent-wallet` skill makes the marketplace "the agent's first move when it believes it lacks a capability". It tells agents: "Search before declining." — CONFIRMED https://skills.sh/circlefin/skills/pay-via-agent-wallet
  - Circle's Discovery API post invites others to "surface payable services in-context". That leaves the proactive, user-facing layer open for someone to build. — CONFIRMED https://www.circle.com/blog/discover-the-whole-agent-marketplace-in-one-call (Sep 9, 2026)
- **Virtuals Butler already routes user intent to escrowed specialist-agent jobs (ACP).** It does this on request, not from observed work. — STRONG SIGNAL https://www.techflowpost.com/en-US/article/27663 ; https://rockawayx.com/insights/virtuals-agent-commerce-protocol-in-public-beta

---

## Bucket 1 — Screen- and work-observing assistants

### Screenpipe (YC, source-available)
- What it does:
  - Records screen and audio locally and exposes the history through a REST API and an MCP server
  - New "Workflows" app (Beta): finds recurring work across apps and drafts steps and possible automations
  - Product copy: "Patterns emerge across days of work"; flags a "Repeated manual handoff"
- Pipe store:
  - Launched in the v2.06 post (2026-03-18)
  - No paid pipes or revenue share mentioned
  - "Optimize" only suggests improvements to pipes you already have
- Closeness: **HIGH on layer 1** (observe work and suggest automations). LOW on layers 2–5.
- Status: live; Workflows is beta
- Lacks vs Czar: no third-party tool, skill or x402 recommendations; no commerce; no vendor-paid model
- Grade: CONFIRMED https://screenpipe.com/ ; https://screenpipe.com/blog/screenpipe-v2-06-pipe-store-memories-meeting-detection
- See Flags: both pages contain prefilled prompts addressed to AI models

### Limitless / Rewind
- Meta acquired Limitless on 2025-12-05
- Rewind (desktop screen recording) is being wound down
- Limitless "will no longer sell its hardware devices"
- Closeness: MEDIUM on layer 1 (historical)
- Status: **dead** as an independent product
- Lacks vs Czar: never recommended tools; it was recall and search only
- Grade: STRONG SIGNAL https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/ (plus 9to5mac and betanews in results)

### Microsoft Recall / Copilot Vision / Copilot "Highlights"
- Recall:
  - Records screen snapshots
  - On managed devices it is "disabled and removed" by default, and admins "can't enable saving snapshots on behalf of their users" — CONFIRMED https://learn.microsoft.com/windows/client-management/manage-recall
- Copilot Vision:
  - Sees the screen only with permission
  - Its companion "Highlights" "automatically surfaces useful content" from apps and suggests files, reminders and actions with "no prompt" needed (Jun 12, 2025) — STRONG SIGNAL https://www.tomsguide.com/ai/copilot-vision-just-launched-on-windows-heres-what-it-actually-does
- Closeness: MEDIUM on layer 1 (proactive surfacing)
- Status: live
- Lacks vs Czar: suggests the user's own content, not third-party tools or paid services

### Microsoft Power Automate task mining / "personal recommendations"
- Task mining:
  - Captures desktop task steps
  - Its report shows "which activities can be optimized"
  - Its automation recommendations "reveal which connectors to use" — CONFIRMED https://learn.microsoft.com/en-us/power-automate/task-mining-overview
- "Process mining M365 personal recommendations":
  - Finds "repetitive manual tasks" from Teams, email and role, then offers flows
  - Public preview Jun 2, 2024; page archived; GA not stated — CONFIRMED https://learn.microsoft.com/en-us/power-platform/release-plan/2024wave1/power-automate/use-process-mining-m365-personal-recommendations
- Closeness: **HIGH on the layer 1→2 pattern** (observe, then recommend a connector or automation) inside one vendor's catalog
- Status: task mining live; personal recommendations stalled in preview
- Lacks vs Czar: enterprise and single-vendor (Microsoft connectors only); no third-party marketplace; no payments

### Celonis Task Mining / Skan.ai
- Celonis (Oct 2019):
  - Records clicks and screens and correlates them with business data
  - Privacy controls hide sensitive data — CONFIRMED https://www.celonis.com/news/press/celonis-expands-intelligent-business-cloud-platform-to-add-task-mining-to-ai-process-mining
- Skan.ai: computer-vision process discovery (search result only) — WEAK SIGNAL https://www.skan.ai/blogs/pros-and-cons-of-task-mining
- Closeness: MEDIUM on layer 1 (enterprise process mining)
- Status: live
- Lacks vs Czar: enterprise analytics for managers, not personal recommendations; no marketplace

### Highlight AI
- Desktop assistant spun out of Medal
- Raised a $40M Series A (Khosla) on 2026-03-24 and named a new CEO
- Building a "unified team memory engine"
- Help centre notes it is "retiring the original Highlight app"
- Closeness: LOW–MEDIUM on layer 1
- Status: live and pivoting
- Lacks vs Czar: no tool recommendations or commerce
- Grade: STRONG SIGNAL https://siliconangle.com/2026/03/24/ai-productivity-startup-highlight-ai-raises-40m-appoints-new-ceo/ ; CONFIRMED (retirement notice) https://help.highlightai.com/

### Pieces for Developers
- On-device "living memory of everything you work on" across apps
- Offers an MCP server for agents
- Closeness: MEDIUM on layer 1 (developer-focused memory)
- Status: live
- Lacks vs Czar: no proactive suggestions and no third-party recommendations on the page
- Grade: CONFIRMED https://pieces.app/about

### Granola
- AI meeting-notes app
- Not fetched. Nothing found suggesting it recommends tools.
- Grade: GAP

### Dia (The Browser Company → Atlassian)
- Atlassian agreed to acquire on 2025-09-04
- Dia is "Optimized for the SaaS apps where you spend your day", with "AI skills" and personal work memory
- Closeness: MEDIUM on layer 1 (browser-level work observation)
- Status: live (Atlassian)
- Lacks vs Czar: no evidence of tool, service or paid recommendations
- Grade: CONFIRMED https://www.atlassian.com/blog/company-news/atlassian-acquires-the-browser-company

### Perplexity Comet
- AI browser, free worldwide since Oct 2025
- "Background assistant" for Max subscribers ($200/mo) runs tasks you assign
- No unprompted recommendations described
- Perplexity said it won't put ads in Comet for now
- Closeness: LOW–MEDIUM
- Status: live
- Grade: STRONG SIGNAL https://www.businesstoday.in/amp/technology/news/story/perplexity-opens-comet-browser-to-all-users-adds-background-assistant-for-max-subscribers-496681-2025-10-03

### OpenAI ChatGPT Atlas browser
- Launched 2025-10-21
- Had browser memories and a new-tab page that could "suggest what to do next"
- OpenAI's page now says Atlas "has since been deprecated" — CONFIRMED https://openai.com/index/introducing-chatgpt-atlas/
- Shutdown announced around 2026-07-11, ending in August
- Users moved to the "ChatGPT desktop application and a new Chrome extension" — STRONG SIGNAL https://arynews.tv/openai-shuts-down-atlas-ai-browser-after-nine-months (plus mactrast and mezha in results)
- Closeness: MEDIUM on layer 1
- Status: **dead**
- Lacks vs Czar: no third-party tool or paid-service recommendations
- Note: OpenAI now ships a ChatGPT **Chrome extension**, the same surface Czar would use

### OpenAI ChatGPT Pulse
- Each night it researches using "memory, chat history, and feedback" and delivers cards the next day
- Preview for Pro users on mobile from 2025-09-25
- No product endorsements and no ads on the launch page
- Closeness: **MEDIUM–HIGH on the proactive-daily-suggestion format**
- Status: live (preview at launch)
- Lacks vs Czar: topical briefings, not tool or merchant recommendations; consumer-focused rather than developer work
- Grade: CONFIRMED https://openai.com/index/introducing-chatgpt-pulse/

### Gemini in Chrome
- Side panel, Auto Browse (AI Pro/Ultra) and connected Google apps (Jan 28, 2026)
- "Personal Intelligence" is planned
- No proactive recommendations described
- Closeness: LOW–MEDIUM
- Status: live in the US
- Grade: STRONG SIGNAL https://www.bgr.com/2087015/gemini-in-chrome-2026-features-auto-browse/

### Rabbit R1 / Humane AI Pin / Friend
- Humane: sold to HP and the AI Pin shut down (Feb 2025) — STRONG SIGNAL https://www.fortune.com/2025/02/19/hp-humane-deal-ai-pin-shutting-down (plus several outlets)
- Rabbit: around 100k preorders, but roughly 5,000 active users by Sep 2024 — STRONG SIGNAL https://www.fastcompany.com/91231902/the-great-ai-gadget-debacle-of-2024
- Friend: always-listening pendant; NYC subway ads vandalized (Oct 2025) — WEAK SIGNAL https://getcoai.com/news/whatcha-gon-do-friend-ai-ceo-embraces-vandalized-subway-ads-as-marketing-strategy
- Closeness: LOW (hardware); relevant mainly as failure evidence (Bucket 5)

### Zapier / Lindy / Relay
- Zapier "Zap Guesser" turns a text description into a suggested Zap
- It does not read user context, although developers can feed it prompts built from user activity — CONFIRMED https://docs.zapier.com/powered-by-zapier/ai-workflows/zap-guesser.md
- Lindy and Relay: search results only; no evidence they suggest automations from observed behaviour — GAP
- Closeness: LOW–MEDIUM

---

## Bucket 2 — Built-in "suggest skills / plugins / MCP" features in agent harnesses

### Claude Code plugin relevance suggestions — closest native analog
- Covered in the Headline finding above
- Signals: working directory, CLI commands run, hosts contacted, files read, and manifest dependencies (for example a `package.json` that includes `stripe`)
- Three surfaces: spinner tip, session-start notice, and a pin in the `/plugin` Discover tab
- "Claude Code never installs a plugin automatically"
- Closeness: **HIGH on layers 1–2** within the Claude Code session
- Status: live (v2.1.152+)
- Lacks vs Czar:
  - Signals are only from the current session
  - Only org-allowlisted or official marketplaces
  - No x402 or paid services, no ERC-8183, no vendor-pays model
  - No cross-harness or browser coverage
- Grade: CONFIRMED https://code.claude.com/docs/en/plugin-relevance.md

### Claude Code CLI plugin hints
- Vendors' CLIs can trigger an install prompt, for official-marketplace plugins only
- Closeness: **HIGH on vendor-initiated reach**, but free and curated by Anthropic
- Status: live
- Grade: CONFIRMED https://code.claude.com/docs/en/plugin-hints.md

### Claude Code marketplace system
- Anyone can host a `marketplace.json`, and there is an official directory and a community marketplace
- Grade: CONFIRMED https://code.claude.com/docs/en/plugin-marketplaces

### ChatGPT apps
- "ChatGPT can also suggest apps when they're relevant to the conversation" (example: Zillow when the user talks about buying a home)
- Directory and Agentic Commerce Protocol monetization were announced
- Dates: 2025-10-06; preview for Business/Enterprise/Edu on 2025-11-13
- Closeness: **HIGH on in-conversation proactive tool suggestion**
- Status: live
- Lacks vs Czar: OpenAI's own ecosystem only; no x402; suggestions come from the conversation, not observed work
- Grade: CONFIRMED https://openai.com/index/introducing-apps-in-chatgpt/

### VS Code extension recommendations
- Two kinds: "Recommended by other users of your current workspace" (`.vscode/extensions.json`) and "Recommended based on recently opened files"
- Closeness: MEDIUM; this is the long-standing pattern of recommending based on the workspace
- Status: live
- Grade: CONFIRMED https://code.visualstudio.com/docs/configure/extensions/extension-marketplace

### GitHub Copilot Extensions
- GitHub App-based Extensions were fully sunset on 2025-11-10 and replaced by MCP
- GitHub calls it "a replacement rather than a migration"
- Status: **dead**
- Grade: CONFIRMED https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/

### Cursor Marketplace
- Launched in Cursor 2.5 on 2026-02-17
- Plugins bundle MCP servers, skills, rules, subagents and hooks
- Launch partners include Stripe, Vercel, Figma and Linear
- No project-based recommendations reported
- Closeness: LOW–MEDIUM (catalog only)
- Status: live
- Grade: STRONG SIGNAL https://www.adwaitx.com/cursor-marketplace-plugins/

### MCP registries: Smithery, Glama, official MCP Registry, mcp.so, PulseMCP
- Sizes: Smithery about 7,000 listings; Glama 21,000+ servers
- Discovery is "manual and user-driven"; no project-based recommendations from Codex or any registry
- Closeness: LOW (they are supply directories)
- Grade: WEAK SIGNAL https://codex.danielvaughan.com/2026/05/27/codex-cli-mcp-server-discovery-registries-smithery-glama-official-registry/ (one blog). mcp.so and PulseMCP were not fetched individually — GAP.

### Composio Rube
- `RUBE_SEARCH_TOOLS` returns the "best tools, toolkits and connection status" for a task, on request
- Closeness: MEDIUM (task-to-tool matching), but reactive
- Status: live
- Grade: WEAK SIGNAL https://dev.to/composiodev/how-rube-mcp-solves-context-overload-when-using-hundreds-of-mcp-servers-2l9e

### Community skill recommenders
- **skill-matcher** (Claude Code plugin):
  - "recommends and auto-activates relevant agent skills by analyzing prompts"
  - Skillselion ranks listings "by installs" and its footer has an "Advertise" link
  - Closeness: **HIGH on layer 2** (community-built)
  - Grade: WEAK SIGNAL https://skillselion.com/plugin/alexgrebeshok-coder/skill-matcher
- **Skillsmith** (MCP):
  - `skill_suggest` is described as "Suggest skills from your current project context", plus `skill_recommend`
  - Freemium quota
  - Closeness: **HIGH on layer 2**, but on request
  - Grade: WEAK SIGNAL https://claudemarketplaces.com/mcp/smith-horn/skillsmith
- **SkillsMP**: reportedly indexes 1.6M+ SKILL.md files (search-result title only) — WEAK SIGNAL https://smartscope.blog/en/blog/skillsmp-marketplace-guide/
- claudeskills.info: not fetched — GAP

### Circle `pay-via-agent-wallet` skill
- "the marketplace is the agent's first move when it believes it lacks a capability"
- Examples of refusals it targets: "I can't send an SMS", "I'm rate-limited"
- Rule: "Search before declining." via `circle services search`, then `circle services pay` in USDC
- Closeness: **HIGH on layer 3, agent side** (reacts to a capability gap)
- Status: live
- Lacks vs Czar: does not observe the user's work over time; no human-facing recommendations; Circle catalog only
- Grade: CONFIRMED https://skills.sh/circlefin/skills/pay-via-agent-wallet

### AgentCash (Merit Systems) skill
- Tells agents to use the listed `stable*` origins first; search only "when no origin in the Available Services table matches"
- Merit's router: 44 origins, about $40K revenue over about 765K transactions in 2026 (Jul 15, 2026)
- Closeness: MEDIUM–HIGH on layer 3 (reactive)
- Grade: CONFIRMED https://skillselion.com/skills/merit-systems/agentcash-skills/agentcash ; https://merit.systems/blog/introducing-router

---

## Bucket 3 — Crypto / agentic-commerce demand generation

### Virtuals ACP + Butler
- ACP:
  - Four phases: Request, Negotiation, Transaction, Evaluation
  - Escrow released after an Evaluator approves — CONFIRMED https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp
- Butler:
  - "a personal agent responsible for discovery, negotiation, and coordination"
  - "Butler agent route consumer tasks" to provider agents; the requestor deposits into on-chain escrow
  - Live since 2025-07-03 — STRONG SIGNAL https://www.techflowpost.com/en-US/article/27663 ; https://rockawayx.com/insights/virtuals-agent-commerce-protocol-in-public-beta
  - By late 2025, Butler runs requests "as an x402 transaction through ACP"
  - 2026 goal: Butler as the "default interface for retail and institutional users" — CONFIRMED https://virtuals.substack.com/p/virtuals-monthly-update-september
- Closeness: **HIGH on layer 4** (route user intent to escrowed specialist-agent jobs)
- Status: live (Base / X)
- Lacks vs Czar: reacts to explicit user requests on X or the app; does not observe work; not ERC-8183 or Arc; recommends no dev tools; DeFi and consumer-focused

### Fetch.ai ASI:One + Agentverse
- ASI:One:
  - "lets your personal AI orchestrate multiple verified brand agents"
  - Beta in Nov 2025; broader rollout "planned for early 2026"
  - Payment rails include Visa, with spending limits
  - "Claim Your Agent" programme for brands — CONFIRMED https://www.businesswire.com/news/home/20251119088395/en
- Agentverse:
  - Ranking is shaped by README, keywords and tags; it can "Boost traffic via intelligent search ranking"
  - Owner analytics: impressions and ranking trends
  - Monetization is "Coming soon" — CONFIRMED https://docs.agentverse.ai/docs
- Closeness: **HIGH on layer 4** (agent that finds agents); **MEDIUM on layer 5** (a growth platform for supply)
- Status: beta / live
- Lacks vs Czar: works on request; not developer work; no x402 or Arc; no paid-placement product found

### Olas Mech Marketplace + Pearl
- Mech Marketplace (Feb 27, 2025): agents "hire" other agents when they lack a skill and pay in crypto
- Pearl: agent app store for humans
- Closeness: MEDIUM on layer 4 (agent-to-agent, triggered by a capability gap)
- Status: live
- Grade: STRONG SIGNAL https://siliconangle.com/2025/02/27/olas-launches-decentralized-ai-marketplace-ai-agents-can-hire/

### Coinbase x402 Bazaar
- Launched 2025-09-09
- Search returns up to 20 results, "ranked by a blend of query relevance and quality" (30-day calls, unique payers, metadata completeness)
- Bazaar MCP available
- "No proactive matching" described
- Closeness: MEDIUM (it is the supply index Czar would query)
- Status: live
- Grade: CONFIRMED https://docs.cdp.coinbase.com/x402/bazaar ; https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar

### Circle Agent Marketplace + Discovery API
- "curated, compliance-first catalog"; 600+ live services; 15+ networks
- Health checks and sanctions screening
- Public Discovery API since 2026-09-09: query plus filters, six categories
- No ranking method published; nothing on recommendations or sponsored listings
- Arc not named on the marketplace page
- Closeness: MEDIUM (supply side). Circle explicitly invites wallets to "surface payable services in-context".
- Grade: CONFIRMED https://developers.circle.com/agent-stack/agent-marketplace.md ; https://www.circle.com/blog/discover-the-whole-agent-marketplace-in-one-call

### ERC-8183 (Agentic Commerce)
- Job states: Open → Funded → Submitted → Completed / Rejected / Expired
- A single evaluator per job
- Optional Bidding Hook; ERC-8004 reputation gating
- "doesn't describe a discovery mechanism" — CONFIRMED https://ercs.ethereum.org/ERCS/erc-8183
- Arc's ERC-8183 walkthrough (2026-04-07):
  - The provider address is passed straight into `createJob`
  - "Discovery, pricing, evaluation logic, and reputation systems can all be layered around" the flow
  - No job marketplace or recommendations — CONFIRMED https://www.arc.io/blog/running-an-agentic-economic-flow-on-arc-with-erc-8183
- Implication: **the layer that discovers and recommends providers for ERC-8183 is still open on Arc**

### Browser-extension x402 projects
- **x402 Detector** (Chrome):
  - Badges sites that support x402; "Browse 61+ verified x402 agents from the popup"
  - **7 users**; updated 2026-10-08; publisher a2alist.ai
  - Closeness: MEDIUM (browser plus x402 directory); passive and tiny
  - Grade: CONFIRMED https://chromewebstore.google.com/detail/mjaefmlaacmjgfpigilkmnfpjfcckohc
- **x402 Autopay** (Polygon):
  - Chromium extension that auto-pays 402 responses within per-site spending policies
  - Not on the Chrome Web Store
  - Does not recommend services
  - Closeness: LOW–MEDIUM (payment rail only)
  - Grade: CONFIRMED https://agentic-docs.polygon.technology/general/x402/tools/autopay/

### Nevermined, Skyfire, Payman, MoonPay, Catena
- Only search results (payment rails and agent wallets)
- No evidence any of them does proactive demand generation
- Grade: GAP

---

## Bucket 4 — "Vendor pays for reach" precedents, trust and regulation

### Directories and ad-funded discovery
- **There's An AI For That**:
  - Sells a newsletter primary sponsorship and a "TAAFT Web Sponsor" placement ("Contact for pricing")
  - Audience: 2.6M+ newsletter subscribers, 4M+ monthly web visitors
  - CONFIRMED https://www.buysellads.com/discover/theres-an-ai-for-that
- **Future Tools**:
  - "Featured Listing" at the top of the directory for one week, two slots a week
  - Placements are "clearly labeled"
  - CONFIRMED https://futuretools.io/advertise
- **Skillselion**: skill directory "ranked by installs" with an "Advertise" link — WEAK SIGNAL (link above)
- Product Hunt, G2, AlternativeTo, Stack Overflow ads, Vercel/Netlify marketplaces: not fetched — GAP (well-known models, not verified this session)

### AI assistants that sell placement
- **ChatGPT ads** (2026-01-16):
  - "Ads do not influence the answers ChatGPT gives you"
  - Ads labeled as sponsored and kept separate from answers
  - No ads near health or politics; none for users under 18
  - Free and Go tiers only
  - CONFIRMED https://openai.com/index/our-approach-to-advertising-and-expanding-access/
- **Perplexity**:
  - Stopped taking new advertisers around Oct 2025; "didn't want to overwhelm users"
  - Ads were about $20k of $34M revenue
  - STRONG SIGNAL https://www.tipranks.com/news/why-perplexity-has-stopped-accepting-new-advertisers
- **Agentverse**: paid access or monetization "Coming soon"; ranking is boosted by metadata, not payment — CONFIRMED (link above)
- **Anthropic** keeps Claude Code's hint and suggestion surfaces free, curated and admin-gated (above)

### User trust evidence
- Quad / Harris Poll (n=2,180 US adults, Feb 5–7, 2026):
  - 75% would trust AI shopping recommendations less if sponsored
  - 75% would trust brands less if they paid to influence AI agents
  - STRONG SIGNAL (commercial survey) https://letsdatascience.com/news/survey-finds-sponsored-ai-shopping-reduces-consumer-trust-dce6ecee
- Ipsos (n=1,085 US adults, Feb 2026):
  - 63% say ads in AI search would make them trust results less
  - STRONG SIGNAL https://searchenginejournal.com/trust-in-ai-search-could-drop-with-ads-survey-shows/571240/

### Regulation
- **FTC Endorsement Guides (2023 update)**:
  - Endorser covers anyone that "could be or appear to be" a person or entity, which includes virtual influencers
  - Disclosures must be "difficult to miss"; built-in platform tools "may not always be sufficient"
  - Intermediaries can be liable
  - STRONG SIGNAL https://perkinscoie.com/en/news-insights/ftc-finalizes-updated-guidance-for-influencer-and-consumer-review-programs.html
- **FTC Operation AI Comply** (2024-09-25):
  - "no AI exemption from the laws on the books"
  - Rytr was sued over AI-generated fake reviews
  - STRONG SIGNAL https://www.orrick.com/fr-FR/Insights/2024/10/FTC-Targets-Unfair-or-Deceptive-AI-Practices-With-Five-New-Enforcement-Actions
- **EU DSA Article 27** (online platforms other than micro and small enterprises):
  - Must disclose recommender "main parameters" "in plain and intelligible language"
  - Must offer a non-profiling option
  - WEAK SIGNAL (secondary summary) https://presencis.com/regulations/dsa/article-27/
  - Article 26 ad labeling and the AI Act transparency duties: not verified this session — GAP
- **India — ASCI draft AI guidelines** (May 2026; feedback closed Jun 13, 2026):
  - Labelling is mandatory where AI "materially influences consumer decision-making"
  - That explicitly covers "sponsored AI-driven product recommendations"
  - Fabricated endorsements are prohibited
  - STRONG SIGNAL https://www.medianews4u.com/asci-releases-draft-guidelines-for-responsible-labelling-of-ai-generated-advertising-content/
- What this means for Czar: any paid placement must be labelled at the point of recommendation, in the US, EU and India. If ranking is affected by payment, the ranking parameters must be disclosed.

---

## Bucket 5 — How proactive assistants fail

### Clippy
- Sinofsky: the first mistake was triggering on the most basic Word action ("Looks like you're trying to write a letter")
- Deciding when to show up was the hardest problem
- Warning signs came from technical users, the gatekeepers
- CONFIRMED https://hardcoresoftware.learningbyshipping.com/042-clippy-the-fcking-clown

### Google Now (2012 → 2016)
- Proactive cards drawn from Gmail, location and search history
- Branding retired by Oct 2016; folded into Feed / Discover and Assistant
- CONFIRMED https://en.wikipedia.org/wiki/Google_Now

### Microsoft Recall
- Introduced May 2024
- Signal (May 2025), then Brave and AdGuard (Jul 2025), block it by default — STRONG SIGNAL https://engadget.com/ai/brave-and-adguard-now-block-microsoft-recall-by-default-152601475.html
- Enterprise default: "disabled and removed on managed devices" — CONFIRMED (link above)
- Lesson: anything that records screens is blocked by default in enterprise settings

### Humane, Rabbit, Friend
- Hardware failures: low relevance, slow, expensive
- Friend was vandalized over always-listening surveillance concerns (links above)

### ChatGPT Atlas
- Shut down after about nine months even with OpenAI's distribution behind it (links above)

### Notification fatigue
- Braze: 60% of iOS and 40% of Android users opt out of push
- Main opt-out reason: messages "not personalized or relevant" (30%)
- WEAK SIGNAL (2016; n=14 staff survey) https://www.braze.com/resources/articles/opt-out-of-push-notifications-why-users-do-it
- Claude Code's own design limits suggestion frequency (once per three sessions; one hint per session). That suggests Anthropic treats suggestion fatigue as a real risk.

### Chrome extension security incidents
- **Cyberhaven** (Dec 24–26, 2024):
  - Employee credentials phished; malicious update auto-installed
  - Campaign hit 30+ extensions and 2.6M+ users; stole session cookies and tokens
  - STRONG SIGNAL https://darktrace.com/blog/cyberhaven-supply-chain-attack-exploiting-browser-extensions
- **Urban VPN Proxy** (+7 sibling extensions; reported 2025-12-18):
  - 8M+ users; harvested prompts and responses from 8 AI platforms, including Claude and ChatGPT
  - Silent auto-update; carried a "Featured" badge; data sent to broker BiScience
  - STRONG SIGNAL https://www.malwarebytes.com/blog/news/2025/12/chrome-extension-slurps-up-ai-chats
- What this means for Czar: a Chrome extension that reads AI chats and work activity looks exactly like these incidents. Enterprise security teams will treat it as high-risk by default.

---

## Summary table

| Item | Bucket | Closeness | Status | Gap vs Czar | Grade + URL |
|---|---|---|---|---|---|
| Claude Code plugin relevance suggestions | 2 | HIGH (L1–2) | Live | Session-only; allowlisted or official marketplaces only; no x402, ERC-8183 or paid reach | CONFIRMED https://code.claude.com/docs/en/plugin-relevance.md |
| Claude Code CLI plugin hints | 2 / 4 | HIGH (vendor-initiated reach) | Live | Official marketplace only; free; 1 per session | CONFIRMED https://code.claude.com/docs/en/plugin-hints.md |
| ChatGPT apps in-conversation suggestions | 2 | HIGH (L2) | Live | OpenAI ecosystem only; triggered by the conversation | CONFIRMED https://openai.com/index/introducing-apps-in-chatgpt/ |
| Circle pay-via-agent-wallet skill | 2 / 3 | HIGH (L3 agent side) | Live | Reactive; does not observe the user; Circle catalog only | CONFIRMED https://skills.sh/circlefin/skills/pay-via-agent-wallet |
| AgentCash skill / router | 2 / 3 | MED–HIGH (L3) | Live | Reactive; its own origins first | CONFIRMED https://skillselion.com/skills/merit-systems/agentcash-skills/agentcash |
| Virtuals Butler (ACP) | 3 | HIGH (L4) | Live | On request; not ERC-8183 or Arc; no dev tools | STRONG https://www.techflowpost.com/en-US/article/27663 |
| ASI:One + Agentverse | 3 | HIGH (L4), MED (L5) | Beta / live | On request; consumer; no x402 or Arc | CONFIRMED https://www.businesswire.com/news/home/20251119088395/en |
| Olas Mech Marketplace | 3 | MED (L4) | Live | Agent-to-agent; no user observation | STRONG https://siliconangle.com/2025/02/27/olas-launches-decentralized-ai-marketplace-ai-agents-can-hire/ |
| Screenpipe Workflows | 1 | HIGH (L1) | Live, beta | No third-party or paid recommendations | CONFIRMED https://screenpipe.com/ |
| Power Automate task mining / personal recs | 1 | HIGH (L1→2 pattern) | Live / preview stalled | Enterprise; Microsoft connectors only | CONFIRMED https://learn.microsoft.com/en-us/power-automate/task-mining-overview |
| skill-matcher plugin | 2 | HIGH (L2) | Live (community) | Prompt-based; no paid layer | WEAK https://skillselion.com/plugin/alexgrebeshok-coder/skill-matcher |
| Skillsmith `skill_suggest` | 2 | HIGH (L2) | Live (freemium) | On request | WEAK https://claudemarketplaces.com/mcp/smith-horn/skillsmith |
| ChatGPT Pulse | 1 | MED–HIGH (format) | Live | Briefings, not merchant recommendations | CONFIRMED https://openai.com/index/introducing-chatgpt-pulse/ |
| Copilot Vision / Highlights | 1 | MED (L1) | Live | Surfaces only the user's own content | STRONG https://www.tomsguide.com/ai/copilot-vision-just-launched-on-windows-heres-what-it-actually-does |
| VS Code workspace recommendations | 2 | MED (L2) | Live | Static, file-based; extensions only | CONFIRMED https://code.visualstudio.com/docs/configure/extensions/extension-marketplace |
| Composio Rube | 2 | MED (L2) | Live | Reactive | WEAK https://dev.to/composiodev/how-rube-mcp-solves-context-overload-when-using-hundreds-of-mcp-servers-2l9e |
| x402 Bazaar | 3 | MED (supply index) | Live | Query-only | CONFIRMED https://docs.cdp.coinbase.com/x402/bazaar |
| Circle Agent Marketplace / Discovery API | 3 | MED (supply index) | Live | Query-only; ranking not published | CONFIRMED https://developers.circle.com/agent-stack/agent-marketplace.md |
| x402 Detector extension | 3 | MED | Live (7 users) | Passive detection; no recommendations | CONFIRMED https://chromewebstore.google.com/detail/mjaefmlaacmjgfpigilkmnfpjfcckohc |
| x402 Autopay extension | 3 | LOW–MED | Unlisted | Payment only | CONFIRMED https://agentic-docs.polygon.technology/general/x402/tools/autopay/ |
| ERC-8183 / Arc 8183 flow | 3 | — (rail Czar would use) | Draft / testnet | No discovery layer | CONFIRMED https://www.arc.io/blog/running-an-agentic-economic-flow-on-arc-with-erc-8183 |
| ChatGPT Atlas | 1 | MED (L1) | Dead (Aug 2026) | — | CONFIRMED https://openai.com/index/introducing-chatgpt-atlas/ |
| Limitless / Rewind | 1 | MED (L1) | Dead (Meta) | — | STRONG https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/ |
| Dia (Atlassian) | 1 | MED (L1) | Live | No recommendations | CONFIRMED https://www.atlassian.com/blog/company-news/atlassian-acquires-the-browser-company |
| Pieces | 1 | MED (L1) | Live | No recommendations | CONFIRMED https://pieces.app/about |
| Highlight AI | 1 | LOW–MED | Pivoting | No recommendations | STRONG https://siliconangle.com/2026/03/24/ai-productivity-startup-highlight-ai-raises-40m-appoints-new-ceo/ |
| Celonis Task Mining | 1 | MED (L1) | Live | Enterprise analytics | CONFIRMED https://www.celonis.com/news/press/celonis-expands-intelligent-business-cloud-platform-to-add-task-mining-to-ai-process-mining |
| Perplexity Comet | 1 | LOW–MED | Live | Assigned tasks only | STRONG https://www.businesstoday.in/amp/technology/news/story/perplexity-opens-comet-browser-to-all-users-adds-background-assistant-for-max-subscribers-496681-2025-10-03 |
| Gemini in Chrome | 1 | LOW–MED | Live (US) | No proactive recommendations | STRONG https://www.bgr.com/2087015/gemini-in-chrome-2026-features-auto-browse/ |
| Cursor Marketplace | 2 | LOW–MED | Live | Catalog only | STRONG https://www.adwaitx.com/cursor-marketplace-plugins/ |
| GitHub Copilot Extensions | 2 | LOW | Dead (Nov 2025) | Replaced by MCP | CONFIRMED https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/ |
| Smithery / Glama / MCP Registry | 2 | LOW | Live | Directories | WEAK https://codex.danielvaughan.com/2026/05/27/codex-cli-mcp-server-discovery-registries-smithery-glama-official-registry/ |
| TAAFT / Future Tools sponsorships | 4 | MED (L5 model) | Live | Human directories, not agents | CONFIRMED https://www.buysellads.com/discover/theres-an-ai-for-that |
| ChatGPT ads | 4 | MED (L5 model) | Live (test) | Ads kept apart from answers | CONFIRMED https://openai.com/index/our-approach-to-advertising-and-expanding-access/ |
| Perplexity ads paused | 4 | — (warning) | Paused | — | STRONG https://www.tipranks.com/news/why-perplexity-has-stopped-accepting-new-advertisers |
| Harris (75%) / Ipsos (63%) trust surveys | 4 | — (risk) | — | — | STRONG (links above) |
| FTC Guides / AI Comply / DSA Art. 27 / ASCI draft | 4 | — (constraint) | In force / draft | — | STRONG / WEAK (links above) |
| Clippy, Google Now, Recall, Humane/Rabbit/Friend | 5 | — (failure modes) | — | — | CONFIRMED / STRONG (links above) |
| Cyberhaven, Urban VPN extension incidents | 5 | — (risk) | — | — | STRONG (links above) |
| Granola, Lindy, Relay, Rabbit (details), Nevermined, Skyfire, Payman, MoonPay, Catena | 1 / 3 | — | — | Not verified | GAP |

---

## Flags (AI-directed instructions found on pages)

- **Screenpipe** (https://screenpipe.com/ and its v2.06 blog post):
  - "Ask AI about this page" links carry prefilled prompts for ChatGPT, Claude and Perplexity
  - The prompts ask for a "rigorous, non-technical evaluation" and to "Not assume Screenpipe is the best choice"
  - Ignored; did not affect grading
- **Circle `pay-via-agent-wallet` skill**:
  - Tells agents "Search before declining." and to pay per call in USDC
  - This is the skill's stated purpose, not hidden. It is still worth noting that it steers agents past their own refusals and toward spending.
- **AgentCash skill**:
  - Imperative instructions to agents to check balance, make paid calls, deposit USDC and redeem invite codes
  - No spending limits or origin checks when it falls back to search
  - Also the skill's stated purpose
- No other page contained instructions aimed at an AI.

---

## Search log (exact searches run)

- Web searches:
  - "Screenpipe pipe store 2026"
  - "Limitless acquired Meta Rewind pendant"
  - "ChatGPT Pulse proactive daily updates"
  - "Virtuals Protocol Butler agent ACP hires agents for users"
  - "ASI:One Fetch.ai agent discovers agents Agentverse"
  - "Claude Code plugin recommendation suggest plugins based on project official marketplace"
  - "ERC-8183 agentic commerce escrow jobs"
  - "Circle "pay-via-agent-wallet" skill "circle services search""
  - "Circle Agent Marketplace agents.circle.com x402 services launch"
  - "Coinbase x402 Bazaar discovery layer agents find services"
  - "Highlight AI desktop assistant screen context 2026"
  - "Pieces for Developers long-term memory LTM-2 workstream"
  - "Atlassian acquires The Browser Company Dia"
  - "ChatGPT Atlas browser memories proactive suggestions launch"
  - "Gemini in Chrome proactive suggestions agentic browsing 2026"
  - "Microsoft Power Automate task mining recommendations automation opportunities"
  - "ChatGPT Atlas deprecated OpenAI browser shut down"
  - "Microsoft Recall privacy backlash delayed 2024 Signal Brave block Recall"
  - "Humane AI pin shut down HP acquisition devices bricked"
  - "Perplexity Comet browser proactive assistant free launch"
  - "Zapier suggested automations Copilot recommends zaps based on apps"
  - "Cyberhaven Chrome extension compromised December 2024 supply chain attack extensions"
  - "AgentCash Merit Systems x402 agents discover pay any API"
  - "Olas Pearl agent app store Mech marketplace agents hire agents"
  - "Virtuals "Butler" agent ACP users request routed to provider agents app.virtuals.io"
  - "Smithery MCP registry toolbox auto-discover MCP servers agent recommend"
  - "Composio Rube MCP automatically finds the right tool agents 500 apps"
  - "OpenAI ads in ChatGPT launch principles answer independence 2026"
  - "Perplexity sponsored follow-up questions ads paused 2025"
  - "FTC endorsement guides 2023 update 16 CFR 255 material connection disclosure clear and conspicuous"
  - "EU Digital Services Act Article 27 recommender system transparency Article 26 advertising disclosure"
  - "There's An AI For That featured listing price sponsored placement advertise"
  - "FTC Operation AI Comply 2024 deceptive AI claims enforcement"
  - "survey consumers trust AI chatbot sponsored recommendations ads disclosure study 2025 2026"
  - "ASCI guidelines AI disclosure advertising India 2025 virtual influencer"
  - "browser extensions harvesting AI chatbot conversations millions users Urban VPN 2025"
  - "Microsoft Recall disabled by default managed commercial devices IT admin policy enterprise"
  - "Clippy why it failed proactive interruption research Horvitz Lumiere"
  - "notification fatigue study percentage users disable push notifications app uninstall"
  - "Rabbit R1 reviews failure sales return rate 2024 2025"
  - "Google Now cards discontinued replaced Google Feed Discover why"
  - "Friend AI pendant subway ads vandalized backlash 2025 reviews"
  - "Celonis task mining desktop automation opportunities Skan.ai computer vision process discovery"
  - "Screenpipe pipes marketplace monetize pipes developers earn"
  - "Lindy AI proactive agent suggests automations; Relay.app AI workflow suggestions"
  - "Pieces "proactive" suggestions developer workflow context Pieces OS 2026"
  - "Copilot Vision Windows sees screen proactively suggests; Microsoft 365 Copilot proactive"
  - "Claude Code plugin that recommends skills MCP servers based on your project "recommend" skills finder"
  - "Highlight AI retiring original app new product 2026"
  - "skillsmp.com agent skills marketplace number of skills search"
  - "Nevermined AI agent payments discovery; Skyfire KYAPay; Payman AI; Catena Labs agent bank 2026"
  - "GitHub Copilot Extensions deprecated sunset November 2025 MCP"
  - "Cursor MCP directory one-click install marketplace plugins Cursor 2026"
  - "whitepaper.virtuals.io Butler agent"
  - "x402scan composer agents discover x402 resources Merit"
- Site fetches:
- Blocked:
  - `gh search repos` for "x402 recommendation", "x402 browser extension", "x402 chrome extension", "agent marketplace recommender", "x402 recommend", "proactive x402" (HTTP 403, session-scoped)
  - github.com/search (robots-disallowed)

---

## Is Czar novel? Verdict per layer

### (1) Observe work — **TAKEN**
- Closest prior art:
  - Screenpipe Workflows: finds recurring work across days (CONFIRMED)
  - Microsoft task mining and personal recommendations (CONFIRMED)
  - Claude Code's own session signals: cwd, cli, hosts, files read, manifest dependencies (CONFIRMED)
  - Copilot Highlights, ChatGPT Pulse, Dia, Pieces
- Remaining room: cross-tool observation (browser plus several coding harnesses) focused on where the user gets stuck. That is a feature, not a moat.
- Main risk: Recall and Chrome-extension history mean screen or chat capture is blocked by default in enterprise settings

### (2) Recommend tools / skills / plugins / MCP — **TAKEN** (natively by platform owners)
- Closest prior art:
  - Claude Code plugin relevance suggestions and CLI hints (CONFIRMED)
  - ChatGPT app suggestions (CONFIRMED)
  - VS Code workspace recommendations
  - Community skill-matcher and Skillsmith `skill_suggest`
- Remaining room: a neutral recommender that covers several harnesses and marketplaces
  - Anthropic limits native suggestions to official or admin-allowlisted marketplaces
  - Anthropic drops hints for other marketplaces

### (3) Recommend paid x402 services — **ATTEMPTED** (agent-side and reactive only; the proactive, user-facing version is OPEN)
- Closest prior art:
  - Circle `pay-via-agent-wallet` ("Search before declining.", CONFIRMED)
  - AgentCash skill
  - Bazaar ranking by relevance and quality (CONFIRMED)
  - x402 Detector extension (7 users)
- Circle publicly invites builders to "surface payable services in-context", which describes the Czar slot
- No product found that does this from observed user work

### (4) Commission ERC-8183 jobs — **ATTEMPTED** (intent → escrowed agent job is TAKEN by Butler and ASI:One; proactive, ERC-8183-on-Arc is OPEN)
- Closest prior art:
  - Virtuals Butler routing to ACP providers with escrow (STRONG)
  - ASI:One orchestrating brand agents (CONFIRMED)
  - Olas Mech
- ERC-8183 and Arc's walkthrough both leave "Discovery, pricing, evaluation logic, and reputation" to builders (CONFIRMED)

### (5) Vendor pays for reach — **ATTEMPTED** (common in human directories and AI ads; not found inside x402 or agent marketplaces)
- Closest prior art:
  - TAAFT and Future Tools featured placements (CONFIRMED)
  - ChatGPT ads with "answer independence" (CONFIRMED)
  - Agentverse growth and ranking tools, with monetization "Coming soon" (CONFIRMED)
- Headwinds:
  - Perplexity paused ads
  - 75% (Harris) and 63% (Ipsos) say sponsored AI results lower their trust
  - FTC, DSA and ASCI rules require clear labelling of sponsored AI recommendations
  - Anthropic keeps its own suggestion surfaces free and curated

### Net
- Czar's individual layers mostly exist already
- No product found combines all five: observe work → recommend skills, x402 services and ERC-8183 jobs → paid by vendors
- The defensible open wedge is narrow: proactive, user-facing demand generation for x402 and ERC-8183 supply on Arc
- That wedge is exposed to two risks:
  - Platform owners (Anthropic, OpenAI with its new Chrome extension, Circle) can add it themselves
  - The vendor-pays model runs straight into the trust and disclosure problems above
