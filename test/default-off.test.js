import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as util from "node:util";
import { after, before, beforeEach, test } from "node:test";
import { SourceTextModule, SyntheticModule } from "node:vm";

const builtins = new Map([
  ["node:child_process", childProcess], ["node:crypto", crypto],
  ["node:fs/promises", fs], ["node:os", os], ["node:path", path],
  ["node:url", url], ["node:util", util]
]);
const extensionUrl = new URL("../src/pi-humanlayer.js", import.meta.url);
let Mirror;
let createHumanlayerCommand;
let humanlayerArgumentCompletions;
let client;
let settingsStore;
let home;
let settingsPath;
const savedEnv = { ...process.env };

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-humanlayer-test-"));
  process.env.HUMANLAYER_RIPTIDE_HOME = home;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  await fs.mkdir(process.env.PI_CODING_AGENT_DIR);
  process.env.HUMANLAYER_CHANNEL = "local";
  process.env.HUMANLAYER_PI_FLUSH_MS = "0";
  delete process.env.HUMANLAYER_PAT;
  delete process.env.HUMANLAYER_TASK;
  delete process.env.HUMANLAYER_PI_DISABLE;
  await fs.mkdir(path.join(home, "pi"));
  // Local identity only: these tests must never contact a real cloud or login.
  await fs.writeFile(path.join(home, "pi", "session-local.json"), JSON.stringify({
    userId: "test-user", orgId: "test-org", email: "test@example.com"
  }));
  const code = await fs.readFile(extensionUrl, "utf8");
  // Expose the bundled class only inside this test module, without changing its public API.
  const module = new SourceTextModule(`${code}\nexport { Mirror, createHumanlayerCommand, humanlayerArgumentCompletions, client2, humanlayerSettings };`, {
    identifier: extensionUrl.href,
    initializeImportMeta(meta) { meta.url = extensionUrl.href; }
  });
  const settingsUrl = new URL("../src/settings.js", import.meta.url);
  const settingsModule = new SourceTextModule(await fs.readFile(settingsUrl, "utf8"), {
    identifier: settingsUrl.href,
    initializeImportMeta(meta) { meta.url = settingsUrl.href; }
  });
  await module.link((specifier) => {
    if (specifier === "./settings.js")
      return settingsModule;
    // TypeBox is unused by Mirror; only tool registration needs the host package.
    const hostPackages = {
      "@earendil-works/pi-ai": { Type: {} },
      "@earendil-works/pi-coding-agent": { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
    };
    const namespace = hostPackages[specifier] ?? builtins.get(specifier);
    assert.ok(namespace, `Unexpected dependency: ${specifier}`);
    const names = Object.keys(namespace);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, namespace[name]);
    });
  });
  await module.evaluate();
  Mirror = module.namespace.Mirror;
  createHumanlayerCommand = module.namespace.createHumanlayerCommand;
  humanlayerArgumentCompletions = module.namespace.humanlayerArgumentCompletions;
  client = module.namespace.client2;
  settingsStore = module.namespace.humanlayerSettings;
});

beforeEach(async () => {
  await fs.writeFile(settingsPath, JSON.stringify({ humanlayer: { defaultMirroring: "off" } }));
});

after(async () => {
  for (const name of Object.keys(process.env)) {
    if (!(name in savedEnv)) delete process.env[name];
  }
  Object.assign(process.env, savedEnv);
  await fs.rm(home, { recursive: true, force: true });
});

async function session(t, flag) {
  const entries = [];
  const id = crypto.randomUUID();
  const notifications = [];
  const ctx = {
    cwd: home,
    hasUI: true,
    ui: { setStatus() {}, notify(message) { notifications.push(message); } },
    sessionManager: {
      getSessionId: () => id,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionName: () => undefined,
      getHeader: () => ({})
    }
  };
  const mirror = await Mirror.start(ctx, () => flag);
  const jobs = [];
  // Capture the real mapper/bind output at its transport boundary. No RPC or lanes.
  mirror.push = (job) => jobs.push(job);
  mirror.startLanes = () => {};
  t.after(() => mirror.shutdown());
  return { mirror, entries, jobs, id, ctx, notifications };
}

const prompt = (text) => ({ prompt: text, systemPromptOptions: { sections: {} } });
const entry = (text) => ({
  id: crypto.randomUUID(), type: "message", timestamp: new Date().toISOString(),
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
});

test("a signed-in new session stays local on its first prompt", async (t) => {
  const { mirror, entries, jobs } = await session(t);
  entries.push(entry("private prompt"));
  await mirror.beforeAgentStart(prompt("private prompt"));
  mirror.agentStart();
  mirror.sweep();
  mirror.agentSettled();
  assert.equal(mirror.info().state, "off");
  assert.equal(mirror.binding, undefined);
  assert.equal(mirror.linked(), false);
  assert.equal(jobs.length, 0);
});

test("on binds the next prompt without uploading earlier private history", async (t) => {
  const { mirror, entries, jobs } = await session(t);
  entries.push(entry("private prompt"));
  await mirror.beforeAgentStart(prompt("private prompt"));
  mirror.setOn();
  entries.push(entry("public prompt"));
  await mirror.beforeAgentStart(prompt("public prompt"));
  const prepare = jobs.find((job) => job.kind === "prepare");
  assert.ok(prepare);
  assert.equal(prepare.binding.cursor.n, entries.length);
  assert.equal(prepare.binding.cursor.skipFirstUser, true);
  assert.ok(JSON.stringify(prepare.body).includes("public prompt"));
  assert.ok(!JSON.stringify(jobs).includes("private prompt"));
  assert.equal(mirror.linked(), true);
});

test("attach explicitly opts in and selects the requested task", async (t) => {
  const { mirror, jobs } = await session(t);
  mirror.attach("chosen-task");
  await mirror.beforeAgentStart(prompt("public prompt"));
  const prepare = jobs.find((job) => job.kind === "prepare");
  assert.ok(prepare);
  assert.equal(prepare.binding.taskMode, "use");
  assert.equal(prepare.binding.taskSlug, "chosen-task");
});

test("a task flag or environment selection does not opt in", async (t) => {
  process.env.HUMANLAYER_TASK = "environment-task";
  t.after(() => { delete process.env.HUMANLAYER_TASK; });
  const { mirror, jobs } = await session(t, "flag-task");
  await mirror.beforeAgentStart(prompt("private prompt"));
  assert.equal(mirror.off, true);
  assert.equal(jobs.length, 0);
});

test("another session starts off even after the previous one opts in", async (t) => {
  const first = await session(t);
  first.mirror.setOn();
  const next = await session(t);
  assert.equal(next.mirror.off, true);
});

test("reloading an unbound opt-in returns to the off default", async (t) => {
  const first = await session(t);
  first.mirror.setOn();
  await first.mirror.shutdown();
  // Reuse the exact context so this is a reload, not a new session.
  const reloaded = await Mirror.start(first.ctx, () => undefined);
  t.after(() => reloaded.shutdown());
  assert.equal(reloaded.off, true);
});

for (const off of [false, true]) {
  test(`resuming a bound session restores saved ${off ? "off" : "on"} state`, async (t) => {
    await fs.writeFile(settingsPath, JSON.stringify({ humanlayer: { defaultMirroring: off ? "on" : "off" } }));
    const { mirror, id } = await session(t);
    assert.equal(mirror.off, !off);
    const binding = {
      version: 1, channel: "local", piSessionId: id, cwd: home,
      cloudSessionId: "test-cloud", hostId: "test-host",
      cursor: { n: 0, lastId: null }, ...(off ? { off: true } : {})
    };
    mirror.resume(binding);
    assert.equal(mirror.off, off);
    assert.equal(mirror.linked(), !off);
    await mirror.shutdown();
    const saved = JSON.parse(await fs.readFile(path.join(home, "pi", "bindings", "local", `${id}.json`), "utf8"));
    assert.equal(!!saved.off, off);
  });
}

test("without a preference, new sessions retain upstream default-on", async (t) => {
  await fs.unlink(settingsPath);
  const { mirror, jobs } = await session(t);
  assert.equal(mirror.off, false);
  await mirror.beforeAgentStart(prompt("public prompt"));
  assert.ok(jobs.some((job) => job.kind === "prepare"));
});

test("default off persists across reloads, new sessions and channels without changing this session", async (t) => {
  await fs.unlink(settingsPath);
  const first = await session(t);
  const command = createHumanlayerCommand({ mirror: first.mirror });
  await command("default off", first.ctx);
  assert.equal(first.mirror.off, false);
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).humanlayer.defaultMirroring, "off");
  // Session-only opt-in does not change the saved preference.
  await command("on", first.ctx);
  assert.equal(first.mirror.off, false);
  await first.mirror.shutdown();
  const reloaded = await Mirror.start(first.ctx, () => undefined);
  t.after(() => reloaded.shutdown());
  assert.equal(reloaded.off, true);
  assert.equal((await session(t)).mirror.off, true);
  process.env.HUMANLAYER_CHANNEL = "beta";
  t.after(() => { process.env.HUMANLAYER_CHANNEL = "local"; });
  assert.equal((await session(t)).mirror.off, true);
});

test("default on restores default-on; plain off remains session-only", async (t) => {
  const first = await session(t);
  const command = createHumanlayerCommand({ mirror: first.mirror });
  await command("default on", first.ctx);
  assert.equal(first.mirror.off, true);
  assert.equal((await session(t)).mirror.off, false);
  await command("off", first.ctx);
  assert.equal(first.mirror.off, true);
  assert.equal((await session(t)).mirror.off, false);
});

test("invalid on/off arguments do not change this session or the preference", async (t) => {
  const first = await session(t);
  const command = createHumanlayerCommand({ mirror: first.mirror });
  for (const args of ["on --set-default", "off unexpected", "default invalid", "default on extra"]) {
    await command(args, first.ctx);
    assert.match(first.notifications.at(-1), /usage:/);
  }
  assert.equal(first.mirror.off, true);
  assert.equal((await session(t)).mirror.off, true);
});

test("saving the channel does not overwrite the mirroring preference", async (t) => {
  const first = await session(t);
  await createHumanlayerCommand({ mirror: first.mirror })("default on", first.ctx);
  await client.saveChannel("beta");
  assert.equal((await session(t)).mirror.off, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "pi", "config.json"), "utf8")).channel, "beta");
});

test("status shows the saved default separately from the session state", async (t) => {
  const first = await session(t);
  first.mirror.setOn();
  await createHumanlayerCommand({ mirror: first.mirror })("status", first.ctx);
  assert.match(first.notifications.at(-1), /default mirroring: off/);
  assert.match(first.notifications.at(-1), /mirroring: on \(binds at the next prompt\)/);
});

test("default argument completion offers on and off", () => {
  const completions = humanlayerArgumentCompletions("default o");
  assert.equal(completions[0].value, "default on");
  assert.equal(completions[1].value, "default off");
  assert.equal(humanlayerArgumentCompletions("on --set"), null);
});

test("default without an argument queries settings, even with no mirror", async (t) => {
  const first = await session(t);
  await createHumanlayerCommand({})("default", first.ctx);
  assert.match(first.notifications.at(-1), /default mirroring: off/);
  await createHumanlayerCommand({})("default on", first.ctx);
  assert.equal((await session(t)).mirror.off, false);
  assert.equal(first.mirror.off, true);
});

test("settings save preserves unrelated Pi and HumanLayer settings", async () => {
  const original = { theme: "dark", packages: ["example"], humanlayer: { defaultMirroring: "off", other: 42 } };
  await fs.writeFile(settingsPath, JSON.stringify(original));
  await settingsStore.save({ defaultMirroring: "on" });
  const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(saved, { ...original, humanlayer: { ...original.humanlayer, defaultMirroring: "on" } });
});

test("an absent HumanLayer section or preference defaults to on", async () => {
  for (const document of [{ theme: "dark" }, { humanlayer: {} }]) {
    await fs.writeFile(settingsPath, JSON.stringify(document));
    assert.equal((await settingsStore.load()).defaultMirroring, "on");
  }
});

test("malformed settings fail explicitly and are never overwritten", async () => {
  for (const text of ["{", "[]", '{"humanlayer":null}', '{"humanlayer":{"defaultMirroring":"invalid"}}']) {
    await fs.writeFile(settingsPath, text);
    await assert.rejects(() => settingsStore.load());
    await assert.rejects(() => settingsStore.save({ defaultMirroring: "on" }));
    assert.equal(await fs.readFile(settingsPath, "utf8"), text);
  }
});

test("settings save uses the current agent directory", async () => {
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "other-agent");
  try {
    await settingsStore.save({ defaultMirroring: "on" });
    const saved = JSON.parse(await fs.readFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
    assert.equal(saved.humanlayer.defaultMirroring, "on");
  } finally {
    process.env.PI_CODING_AGENT_DIR = original;
  }
  assert.equal((await settingsStore.load()).defaultMirroring, "off");
});
