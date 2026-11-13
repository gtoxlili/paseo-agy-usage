import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeProbe, type CommandResult } from "./probe.js";
import { createUsageHandlers } from "./usage.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const BINARY = "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe";
const INPUT = { store: "windows-credential-manager" } as const;
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const PLAN_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const quota = (buckets: unknown[]) => ({ groups: [{ buckets }] });

const QUOTA = quota([
  { bucketId: "3p-weekly", remainingFraction: 0.67, resetTime: "2030-01-08T00:00:00Z" },
  { bucketId: "3p-5h", remainingFraction: 1, resetTime: "2030-01-01T05:00:00Z" },
  { bucketId: "gemini-weekly", remainingFraction: 0.96, resetTime: "2030-01-07T00:00:00Z" },
  { bucketId: "gemini-5h", remainingFraction: 0.88, resetTime: "2030-01-01T04:00:00Z" },
]);

const MODELS = {
  models: {
    "gemini-4-argon-medium": {
      displayName: "Gemini 4 Argon (Medium)",
      apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
    },
    "gemini-4-hydrogen-high": {
      displayName: "Gemini 4 Hydrogen (High)",
      apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
    },
    "gemini-3.8-flash-high": {
      displayName: "Gemini 3.8 Flash (High)",
      apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
    },
    "claude-opus-5-5-high": {
      displayName: "Claude Opus 5.5 (High)",
      apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
    },
    "claude-sonnet-5-5-high": {
      displayName: "Claude Sonnet 5.5 (High)",
      apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
    },
    "gpt-oss-120b-medium": {
      displayName: "GPT-OSS 120B (Medium)",
      apiProvider: "API_PROVIDER_OPENAI_VERTEX",
    },
    "gemini-4-carbon-disabled": {
      displayName: "Gemini 4 Carbon",
      apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
      disabled: true,
      tagTitle: "Unavailable",
      tagDescription: "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
    },
    chat_20706: {
      isInternal: true,
      apiProvider: "API_PROVIDER_INTERNAL",
    },
  },
  agentModelSorts: [
    {
      groups: [
        {
          modelIds: [
            "gemini-4-argon-medium",
            "gemini-4-hydrogen-high",
            "gemini-3.8-flash-high",
            "claude-opus-5-5-high",
            "claude-sonnet-5-5-high",
            "gpt-oss-120b-medium",
            "gemini-4-carbon-disabled",
          ],
        },
      ],
    },
  ],
};

function login(email = "test@example.com", accessToken = "test-access", expiry = NOW + 3_600_000) {
  const claims = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return JSON.stringify({
    token: { access_token: accessToken, expiry },
    id_token: `header.${claims}.signature`,
  });
}

const transport: typeof fetch = async (url, options) => {
  if (new Headers(options?.headers).get("authorization") !== "Bearer test-access") return json({}, 401);
  if (new Headers(options?.headers).get("user-agent") !== "antigravity/cli/1.4.2") return json(quota([]));
  if (String(url) === QUOTA_URL) return json(QUOTA);
  if (String(url) === PLAN_URL) return json({ paidTier: { id: "g1-pro-tier" }, currentTier: { id: "free-tier" } });
  if (String(url) === MODELS_URL) return json(MODELS);
  throw new Error("Unexpected service endpoint");
};

// Keep the product path real; replace only filesystem, OS keyring and HTTP I/O.
function usage(options: {
  cliInstalled?: boolean;
  readStore?: () => CommandResult;
  renewLogin?: () => CommandResult;
  fetchApi?: typeof fetch;
} = {}) {
  return createUsageHandlers({
    probe: createNodeProbe({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      home: "C:\\Users\\test",
      isExecutable: async (path) => options.cliInstalled !== false && path === BINARY,
      run: async (file, args) => file === BINARY
        ? args[0] === "models"
          ? options.renewLogin?.() ?? { stdout: "", exitCode: 0 }
          : { stdout: "1.4.2\n", exitCode: 0 }
        : options.readStore?.() ?? { stdout: login(), exitCode: 0 },
    }),
    fetchApi: options.fetchApi ?? transport,
    now: () => NOW,
  });
}

test("a signed-in Pro account shows 5h and weekly windows per model family without redundant breakdown clutter", async () => {
  const withArgon = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.96, resetTime: "2030-01-07T00:00:00Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.88, resetTime: "2030-01-01T04:00:00Z" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.67, resetTime: "2030-01-08T00:00:00Z" },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2030-01-01T05:00:00Z" },
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [
          { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.15, resetTime: "2030-01-07T12:00:00Z" },
        ],
      },
    ],
  };

  const api = usage({
    fetchApi: async (url, options) => String(url) === QUOTA_URL ? json(withArgon) : transport(url, options),
  });
  const [account] = await api.discover({ kind: "global" });
  assert.ok(account);
  assert.equal(account.label, "test@example.com");
  assert.deepEqual(account.input, INPUT);

  const report = await api.fetch(account.input);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, "Google AI Pro");
  assert.deepEqual(report.windows.map(({ id, label, shortLabel, remainingPct, resetsAt }) => ({
    id,
    label,
    shortLabel,
    remainingPct,
    resetsAt,
  })), [
    {
      id: "gemini-5h",
      label: "Hydrogen · 5h",
      shortLabel: "Hydrogen 5h",
      remainingPct: 88,
      resetsAt: "2030-01-01T04:00:00.000Z",
    },
    {
      id: "gemini-weekly",
      label: "Hydrogen · Weekly",
      shortLabel: "Hydrogen wk",
      remainingPct: 96,
      resetsAt: "2030-01-07T00:00:00.000Z",
    },
    {
      id: "3p-5h",
      label: "Claude/GPT · 5h",
      shortLabel: "Claude/GPT 5h",
      remainingPct: 100,
      resetsAt: "2030-01-01T05:00:00.000Z",
    },
    {
      id: "3p-weekly",
      label: "Claude/GPT · Weekly",
      shortLabel: "Claude/GPT wk",
      remainingPct: 67,
      resetsAt: "2030-01-08T00:00:00.000Z",
    },
    {
      id: "gemini-argon-wtu-weekly",
      label: "Argon · Weekly",
      shortLabel: "Argon wk",
      remainingPct: 15,
      resetsAt: "2030-01-07T12:00:00.000Z",
    },
  ]);
  assert.deepEqual(report.details, []);
});

test("when Argon has no separate pool (e.g. Ultra) it merges into the Gemini label and an active Carbon pool is shown", async () => {
  const ultraQuota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2030-01-08T00:00:00Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9, resetTime: "2030-01-01T05:00:00Z" },
        ],
      },
      {
        displayName: "Gemini 4 Carbon",
        buckets: [
          { bucketId: "gemini-carbon-wtu-weekly", window: "weekly", remainingFraction: 0.75, resetTime: "2030-01-08T06:00:00Z" },
        ],
      },
    ],
  };
  const ultraModels = {
    ...MODELS,
    models: {
      ...MODELS.models,
      "gemini-4-carbon-disabled": undefined,
      "gemini-4-carbon-high": {
        displayName: "Gemini 4 Carbon (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
      },
    },
    agentModelSorts: [
      {
        groups: [
          { modelIds: ["gemini-4-hydrogen-high", "gemini-4-argon-medium", "gemini-4-carbon-high"] },
        ],
      },
    ],
  };

  const report = await usage({
    fetchApi: async (url) => {
      if (String(url) === PLAN_URL) return json({ paidTier: { id: "g1-ultra-tier" } });
      if (String(url) === MODELS_URL) return json(ultraModels);
      return json(ultraQuota);
    },
  }).fetch(INPUT);

  assert.ok(report.status === "available");
  assert.equal(report.planLabel, "Google AI Ultra");
  assert.deepEqual(report.windows.map(({ id, label, shortLabel, remainingPct }) => ({ id, label, shortLabel, remainingPct })), [
    { id: "gemini-5h", label: "Hydrogen · Argon · 5h", shortLabel: "Gemini 5h", remainingPct: 90 },
    { id: "gemini-weekly", label: "Hydrogen · Argon · Weekly", shortLabel: "Gemini wk", remainingPct: 90 },
    { id: "gemini-carbon-wtu-weekly", label: "Carbon · Weekly", shortLabel: "Carbon wk", remainingPct: 75 },
  ]);
});

test("g1-ultra-lite-tier maps to Google AI Ultra, unknown paidTier falls back to server name, and shared Hydrogen/Argon/Carbon pool renders 4 windows (5h + Weekly)", async () => {
  // repro: live loadCodeAssist on Google AI Ultra (5x) returns paidTier.id = "g1-ultra-lite-tier"
  // and retrieveUserQuotaSummary puts Hydrogen, Argon, and Carbon in one shared Gemini Models pool.
  const sharedQuota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.98, resetTime: "2030-01-08T00:00:00Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.96, resetTime: "2030-01-01T05:00:00Z" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2030-01-08T00:00:00Z" },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2030-01-01T05:00:00Z" },
        ],
      },
    ],
  };
  const sharedModels = {
    models: {
      "gemini-4-carbon-high": {
        displayName: "Gemini 4 Carbon (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.96, resetTime: "2030-01-01T05:00:00Z" },
      },
      "gemini-4-argon-high": {
        displayName: "Gemini 4 Argon (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.96, resetTime: "2030-01-01T05:00:00Z" },
      },
      "gemini-4-hydrogen-high": {
        displayName: "Gemini 4 Hydrogen (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.96, resetTime: "2030-01-01T05:00:00Z" },
      },
      "gemini-3.8-flash-high": {
        displayName: "Gemini 3.8 Flash (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.96, resetTime: "2030-01-01T05:00:00Z" },
      },
    },
    agentModelSorts: [
      {
        groups: [
          { modelIds: ["gemini-4-carbon-high", "gemini-4-argon-high", "gemini-4-hydrogen-high", "gemini-3.8-flash-high"] },
        ],
      },
    ],
  };

  const ultraReport = await usage({
    fetchApi: async (url) => {
      if (String(url) === PLAN_URL) {
        return json({
          currentTier: { id: "free-tier", name: "Antigravity" },
          paidTier: { id: "g1-ultra-lite-tier", name: "Google AI Ultra" },
        });
      }
      if (String(url) === MODELS_URL) return json(sharedModels);
      return json(sharedQuota);
    },
  }).fetch(INPUT);

  assert.ok(ultraReport.status === "available");
  assert.equal(ultraReport.planLabel, "Google AI Ultra");
  assert.deepEqual(ultraReport.windows.map(({ id, label, shortLabel, remainingPct }) => ({ id, label, shortLabel, remainingPct })), [
    { id: "gemini-5h", label: "Hydrogen · Argon · Carbon · 5h", shortLabel: "Gemini 5h", remainingPct: 96 },
    { id: "gemini-weekly", label: "Hydrogen · Argon · Carbon · Weekly", shortLabel: "Gemini wk", remainingPct: 98 },
    { id: "3p-5h", label: "Claude/GPT · 5h", shortLabel: "Claude/GPT 5h", remainingPct: 100 },
    { id: "3p-weekly", label: "Claude/GPT · Weekly", shortLabel: "Claude/GPT wk", remainingPct: 100 },
  ]);

  const futureTierReport = await usage({
    fetchApi: async (url) => {
      if (String(url) === PLAN_URL) {
        return json({
          currentTier: { id: "free-tier", name: "Antigravity" },
          paidTier: { id: "g1-plus-tier", name: "Google AI Plus" },
        });
      }
      if (String(url) === MODELS_URL) return json(sharedModels);
      return json(sharedQuota);
    },
  }).fetch(INPUT);
  assert.ok(futureTierReport.status === "available");
  assert.equal(futureTierReport.planLabel, "Google AI Plus");
});

test("Argon and Carbon are not merged into the Gemini pool label when fetchAvailableModels reports divergent quotaInfo", async () => {
  const divergentModels = {
    models: {
      "gemini-4-hydrogen-high": {
        displayName: "Gemini 4 Hydrogen (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.9, resetTime: "2030-01-01T05:00:00Z" },
      },
      "gemini-4-argon-high": {
        displayName: "Gemini 4 Argon (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.2, resetTime: "2030-01-07T12:00:00Z" },
      },
      "gemini-4-carbon-high": {
        displayName: "Gemini 4 Carbon (High)",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-06T00:00:00Z" },
      },
    },
    agentModelSorts: [
      { groups: [{ modelIds: ["gemini-4-hydrogen-high", "gemini-4-argon-high", "gemini-4-carbon-high"] }] },
    ],
  };

  const report = await usage({
    fetchApi: async (url, options) => String(url) === MODELS_URL ? json(divergentModels) : transport(url, options),
  }).fetch(INPUT);

  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ id, label, shortLabel }) => ({ id, label, shortLabel })), [
    { id: "gemini-5h", label: "Hydrogen · 5h", shortLabel: "Hydrogen 5h" },
    { id: "gemini-weekly", label: "Hydrogen · Weekly", shortLabel: "Hydrogen wk" },
    { id: "3p-5h", label: "Claude/GPT · 5h", shortLabel: "Claude/GPT 5h" },
    { id: "3p-weekly", label: "Claude/GPT · Weekly", shortLabel: "Claude/GPT wk" },
  ]);
});

test("when both 5h and weekly windows are exhausted, both windows are reported with 5h first and distinct reset times", async () => {
  const exhausted = quota([
    { bucketId: "3p-weekly", remainingFraction: 0, resetTime: "2030-01-08T00:00:00Z" },
    { bucketId: "3p-5h", remainingFraction: 0, resetTime: "2030-01-01T05:00:00Z" },
  ]);
  const report = await usage({
    fetchApi: async (url, options) => String(url) === QUOTA_URL ? json(exhausted) : transport(url, options),
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ id, remainingPct, resetsAt }) => ({ id, remainingPct, resetsAt })), [
    { id: "3p-5h", remainingPct: 0, resetsAt: "2030-01-01T05:00:00.000Z" },
    { id: "3p-weekly", remainingPct: 0, resetsAt: "2030-01-08T00:00:00.000Z" },
  ]);
});

test("unknown future quota groups and disabled buckets are handled gracefully without dropping", async () => {
  const customQuota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.8 }],
      },
      {
        displayName: "Experimental Model",
        buckets: [{ bucketId: "exp-weekly", remainingFraction: 0.4, resetTime: "2030-01-05T00:00:00Z" }],
      },
      {
        displayName: "Paused Pool",
        buckets: [{ bucketId: "paused-weekly", disabled: true }],
      },
    ],
  };
  const report = await usage({
    fetchApi: async (url, options) => String(url) === QUOTA_URL ? json(customQuota) : transport(url, options),
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ id, label, remainingPct }) => ({ id, label, remainingPct })), [
    { id: "gemini-weekly", label: "Hydrogen · Argon · Weekly", remainingPct: 80 },
    { id: "exp-weekly", label: "Experimental Model · Weekly", remainingPct: 40 },
  ]);
  assert.ok(report.details?.some((d) => d.label === "Paused Pool" && d.value === "Disabled"));
});

test("Windows 在没有 pwsh 和 PowerShell PATH 时仍能读取登录并获取额度", async () => {
  const executables: Record<string, string> = {
    [BINARY]: "1.4.2\n",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": login(),
  };
  const api = createUsageHandlers({
    probe: createNodeProbe({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", PATH: "" },
      home: "C:\\Users\\test",
      isExecutable: async (path) => path === BINARY,
      run: async (file) => {
        const stdout = executables[file];
        if (stdout === undefined) throw new Error("Command not found");
        return { stdout, exitCode: 0 };
      },
    }),
    fetchApi: transport,
    now: () => NOW,
  });
  const [account] = await api.discover({ kind: "global" });
  assert.equal(account?.label, "test@example.com");
  const report = await api.fetch(account!.input);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 88);
});

test("discovery shows no account without a CLI/login and never assigns the global login to a session", async () => {
  assert.deepEqual(await usage({ cliInstalled: false }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage({ readStore: () => ({ stdout: "", exitCode: 0 }) }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage().discover({ kind: "session", provider: "antigravity", env: {} }), []);
});

test("free-tier cards explain the plan while omitted quotas remain unknown", async () => {
  const report = await usage({
    fetchApi: async (url) => {
      if (String(url) === PLAN_URL) return json({ currentTier: { id: "free-tier" } });
      if (String(url) === MODELS_URL) return json({}, 403);
      return json(quota([{ bucketId: "gemini-weekly", remainingFraction: 0.5 }]));
    },
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, "Free tier");
  assert.deepEqual(report.windows.map(({ id, label, remainingPct }) => ({ id, label, remainingPct })), [
    { id: "gemini-weekly", label: "Gemini · Weekly", remainingPct: 50 },
  ]);
  assert.ok(report.details?.some(({ value }) => value.includes("weekly value")));
});

test("expired, rejected and quota-less logins produce native unavailable diagnostics", async () => {
  const cases = [
    { stored: login("test@example.com", "test-access", NOW - 1), body: QUOTA, status: 200,
      problem: { kind: "expired", expiresAt: new Date(NOW - 1).toISOString(), refreshedBy: "agy" } },
    ...[401, 403].map((status) => ({ stored: login(), body: {}, status,
      problem: { kind: "rejected", status, refreshedBy: "agy" } })),
    { stored: login(), body: quota([]), status: 200, problem: { kind: "no_quota" } },
  ];
  for (const scenario of cases) {
    const report = await usage({
      readStore: () => ({ stdout: scenario.stored, exitCode: 0 }),
      fetchApi: async () => json(scenario.body, scenario.status),
    }).fetch(INPUT);
    assert.ok(report.status === "unavailable");
    assert.equal(report.problem.kind, scenario.problem.kind);
    if (scenario.problem.kind !== "no_quota") assert.deepEqual(report.problem, scenario.problem);
  }
});

test("expired logins are renewed by agy and quota uses the newly stored token", async () => {
  let stored = login("test@example.com", "expired-access", NOW - 1);
  const report = await usage({
    readStore: () => ({ stdout: stored, exitCode: 0 }),
    renewLogin: () => {
      stored = login();
      return { stdout: "", exitCode: 0 };
    },
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 88);
});

test("quota authentication rejection renews the login before retrying with its new token", async () => {
  for (const status of [401, 403]) {
    let stored = login("test@example.com", "rejected-access");
    const report = await usage({
      readStore: () => ({ stdout: stored, exitCode: 0 }),
      renewLogin: () => {
        stored = login();
        return { stdout: "", exitCode: 0 };
      },
      fetchApi: async (url, options) =>
        new Headers(options?.headers).get("authorization") === "Bearer rejected-access"
          ? json({}, status) : transport(url, options),
    }).fetch(INPUT);
    assert.ok(report.status === "available");
    assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 88);
  }
});

test("failed CLI renewal reports an error without leaking command output", async () => {
  const report = await usage({
    readStore: () => ({ stdout: login("test@example.com", "expired-access", NOW - 1), exitCode: 0 }),
    renewLogin: () => ({ stdout: "private-payload", exitCode: 1 }),
  }).fetch(INPUT);
  assert.ok(report.status === "error");
  assert.ok(!report.error.includes("private-payload"));
});

test("unavailable plan and models lookups do not hide valid quota", async () => {
  const report = await usage({
    fetchApi: async (url) => {
      if (String(url) === PLAN_URL || String(url) === MODELS_URL) return json({}, 403);
      return json(QUOTA);
    },
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, undefined);
  assert.deepEqual(report.windows.map(({ id, label, remainingPct }) => ({ id, label, remainingPct })), [
    { id: "gemini-5h", label: "Gemini · 5h", remainingPct: 88 },
    { id: "gemini-weekly", label: "Gemini · Weekly", remainingPct: 96 },
    { id: "3p-5h", label: "Claude/GPT · 5h", remainingPct: 100 },
    { id: "3p-weekly", label: "Claude/GPT · Weekly", remainingPct: 67 },
  ]);
});

test("keyring and upstream failures show errors without exposing private payloads", async () => {
  const cases = [
    usage({ readStore: () => ({ stdout: "private-payload", exitCode: 1 }) }),
    usage({ fetchApi: async () => { throw new Error("private-payload"); } }),
    usage({ fetchApi: async () => new Response("private-payload") }),
    usage({ fetchApi: async () => json({ error: "private-payload" }, 503) }),
  ];
  for (const api of cases) {
    const report = await api.fetch(INPUT);
    assert.ok(report.status === "error");
    assert.ok(!report.error.includes("private-payload"));
  }
});

test("switching the CLI login updates both the discovered account and fetched quota", async () => {
  let stored = login();
  const api = usage({
    readStore: () => ({ stdout: stored, exitCode: 0 }),
    fetchApi: async (url, options) => {
      const nextLogin = new Headers(options?.headers).get("authorization") === "Bearer next-access";
      return nextLogin && String(url) === QUOTA_URL
        ? json(quota([{ bucketId: "gemini-weekly", remainingFraction: 0.8 }])) : transport(url, options);
    },
  });
  const [original] = await api.discover({ kind: "global" });
  assert.ok(original);
  const before = await api.fetch(original.input);
  assert.ok(before.status === "available");
  assert.equal(before.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 88);
  stored = login("next@example.com", "next-access");
  const [current] = await api.discover({ kind: "global" });
  assert.equal(current?.label, "next@example.com");
  const report = await api.fetch(original.input);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 80);
});
