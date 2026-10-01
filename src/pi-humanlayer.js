import { createHumanlayerSettings } from "./settings.js";

// packages/session-sdk-auth/src/client.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { join } from "node:path";

// packages/session-sdk-base/src/channels.ts
var ALL_CHANNELS = ["prod", "beta", "dev", "local"];
function isChannel(value) {
  return value !== undefined && ALL_CHANNELS.includes(value);
}
var CHANNEL_DEFAULTS = {
  prod: {
    api: "https://riptide-api.humanlayer.com",
    sync: "https://sync.humanlayer.com",
    app: "https://app.humanlayer.com",
    clientId: "client_01KGBPX6V78MDGNF006SE6NYTG"
  },
  beta: {
    api: "https://riptide-api.codelayer.cloud",
    sync: "https://sync.codelayer.cloud",
    app: "https://app.codelayer.cloud",
    clientId: "client_01K84ASX66BNXTMD842AHWBKNG"
  },
  dev: {
    api: "https://riptide-api.dev.codelayer.gg",
    sync: "https://sync.dev.codelayer.gg",
    app: "https://app.dev.codelayer.gg",
    clientId: "client_01K84ASWYHMC34NMFHN6MBXP8N"
  },
  local: {
    api: "http://localhost:8700",
    sync: "http://localhost:8888",
    app: "http://localhost:3000",
    clientId: "client_01K84ASWYHMC34NMFHN6MBXP8N"
  }
};
var DEFAULT_WORKOS_URL = "https://api.workos.com";
function getChannelConfig(channel, env = process.env) {
  const base = CHANNEL_DEFAULTS[channel];
  return {
    channel,
    api: env.HUMANLAYER_API_URL || base.api,
    sync: env.HUMANLAYER_SYNC_URL || base.sync,
    app: env.HUMANLAYER_APP_URL || base.app,
    workos: env.HUMANLAYER_WORKOS_URL || DEFAULT_WORKOS_URL,
    clientId: base.clientId
  };
}
// packages/session-sdk-base/src/files.ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function sleepUnref(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    if (signal?.aborted)
      done();
    else
      signal?.addEventListener("abort", done, { once: true });
  });
}
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function writeJsonFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 384 });
  await rename(tmp, path);
}
var LOCK_STALE_MS = 30000;
var LOCK_TIMEOUT_MS = 15000;
var LOCK_POLL_MS = 100;
async function withFileLock(lockPath, fn) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 448 });
  const start = Date.now();
  for (;; ) {
    try {
      const handle = await open(lockPath, "wx", 384);
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      const info = await stat(lockPath).catch(() => null);
      const age = Date.now() - (info?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS)
        await unlink(lockPath).catch(() => {});
      else if (Date.now() - start > LOCK_TIMEOUT_MS)
        throw new Error(`HumanLayer: lock timed out: ${lockPath}`);
      else
        await sleepUnref(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
function decodeJwtPayload(jwt) {
  const part = jwt.split(".")[1];
  if (!part)
    throw new Error("Malformed JWT: no payload segment");
  const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Malformed JWT: payload is not an object");
  return parsed;
}
function jwtClaim(jwt, key) {
  try {
    const value = decodeJwtPayload(jwt)[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return;
  }
}
var logChain = Promise.resolve();
function logLine(path, line) {
  logChain = logChain.then(async () => {
    try {
      const info = await stat(path).catch(() => null);
      if (info && info.size > 5 * 1024 * 1024)
        await rename(path, `${path}.1`).catch(() => {});
      await mkdir(dirname(path), { recursive: true, mode: 448 });
      await appendFile(path, line.endsWith(`
`) ? line : `${line}
`, { mode: 384 });
    } catch {}
  });
}
// packages/session-sdk-base/src/rpc.ts
class RpcError extends Error {
  status;
  code;
  data;
  constructor(message, status, code, data) {
    super(message);
    this.name = "RpcError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

class LoginRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginRequiredError";
  }
}
function timeout(ms, signal) {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}
function isErrorBody(json) {
  return typeof json === "object" && json !== null;
}
async function rpcCall(call) {
  const { api, plane, path, body, cred, signal, timeoutMs = 15000, onDone } = call;
  const headers = new Headers({ "content-type": "application/json" });
  if (cred && plane === "api")
    headers.set("authorization", `Bearer ${cred}`);
  if (cred && plane === "daemon")
    headers.set("x-daemon-authorization", cred);
  const data = JSON.stringify(body ?? {});
  const start = Date.now();
  const done = (outcome) => onDone?.(outcome, Date.now() - start, Buffer.byteLength(data));
  const res = await fetch(`${api}/rpc/${plane}/v1/${path}`, {
    method: "POST",
    headers,
    body: data,
    signal: timeout(timeoutMs, signal)
  }).catch((err) => {
    done(err instanceof Error ? err.message : String(err));
    throw err;
  });
  const json = await res.json().catch(() => null);
  done(res.status);
  if (!res.ok) {
    const err = isErrorBody(json) ? json : undefined;
    throw new RpcError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code, err?.data);
  }
  return json;
}
function isTokenRefused(err) {
  return err instanceof RpcError && (err.status === 401 || err.status === 403 && err.code === "UNAUTHORIZED");
}
function classifyRpcError(err, plane) {
  if (err instanceof LoginRequiredError)
    return { kind: "login-required" };
  if (!(err instanceof RpcError))
    return { kind: "retry-forever" };
  const { status } = err;
  if (status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504) {
    return { kind: "retry-forever" };
  }
  if (status === 500)
    return { kind: "retry-limited", maxAttempts: 5 };
  if (plane === "daemon" && isTokenRefused(err))
    return { kind: "login-required" };
  if (status === 402)
    return { kind: "stop-all" };
  if (status === 403 || status === 404)
    return { kind: "stop-binding" };
  return { kind: "skip" };
}
function isRetry(action) {
  return action.kind === "retry-forever" || action.kind === "retry-limited";
}
function isTransient(err) {
  if (err instanceof LoginRequiredError)
    return false;
  if (!(err instanceof RpcError))
    return true;
  return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
}

// packages/session-sdk-base/src/outbox.ts
function backoffMs(b, n) {
  const first = b.initialBackoffMs ?? 500;
  const max = b.maxBackoffMs ?? 30000;
  return Math.min(max, first * 2 ** Math.min(n - 1, 16));
}
var live = new Set;
function resumeAll() {
  for (const member of [...live])
    member.resume();
}

class Outbox {
  queue = [];
  opts;
  byteTotal = 0;
  pauseReason;
  stopped = false;
  running = false;
  lastFailure;
  member = {
    pause: (reason) => this.pause(reason),
    resume: () => this.resume(),
    stop: (reason) => this.halt(reason, this.opts.onStopAll)
  };
  constructor(opts) {
    this.opts = opts;
    live.add(this.member);
  }
  get length() {
    return this.queue.length;
  }
  get items() {
    return this.queue;
  }
  get failure() {
    return this.lastFailure;
  }
  get isPaused() {
    return this.pauseReason !== undefined;
  }
  get isStopped() {
    return this.stopped;
  }
  push(item) {
    if (this.stopped)
      return;
    this.queue.push(item);
    this.byteTotal += item.sizeBytes;
    this.enforceCap();
    this.kick();
  }
  pause(reason) {
    if (this.pauseReason !== undefined)
      return;
    this.pauseReason = reason;
    this.opts.onPause?.(reason);
  }
  resume() {
    if (this.pauseReason === undefined)
      return;
    this.pauseReason = undefined;
    this.opts.onResume?.();
    this.kick();
  }
  async drain(ms) {
    const waitForEmpty = (async () => {
      while (this.queue.length > 0 && !this.stopped && this.pauseReason === undefined) {
        await sleepUnref(50);
      }
    })();
    await Promise.race([waitForEmpty, sleepUnref(ms)]);
  }
  close() {
    this.halt("closed");
  }
  enforceCap() {
    const maxItems = this.opts.maxItems ?? 5000;
    const maxBytes = this.opts.maxBytes ?? 50 * 1024 * 1024;
    let i = 1;
    for (let item = this.queue[i];item && (this.queue.length > maxItems || this.byteTotal > maxBytes); item = this.queue[i]) {
      if (item.keep) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.byteTotal -= item.sizeBytes;
      this.opts.onDrop?.(item);
    }
  }
  kick() {
    if (!this.running)
      this.runLoop().catch(() => {});
  }
  async runLoop() {
    this.running = true;
    try {
      for (let item = this.queue[0];item && !this.stopped && this.pauseReason === undefined; item = this.queue[0]) {
        const done = await this.attempt(item);
        if (done && this.queue[0] === item) {
          this.queue.shift();
          this.byteTotal -= item.sizeBytes;
        }
      }
    } finally {
      this.running = false;
    }
  }
  async attempt(item) {
    for (let attempts = 1;!this.stopped && this.pauseReason === undefined; attempts++) {
      try {
        await this.opts.send(item);
        this.lastFailure = undefined;
        return true;
      } catch (err) {
        const action = (this.opts.classify ?? classifyRpcError)(err, item.plane);
        const reason = errorMessage(err);
        this.lastFailure = reason;
        const note = (what) => this.opts.log?.(`outbox #${item.id} ${what}: ${reason}`);
        if (action.kind === "retry-forever" || action.kind === "retry-limited" && attempts <= action.maxAttempts) {
          const ms = backoffMs(this.opts, attempts);
          note(`retry in ${ms}ms`);
          await sleepUnref(ms);
          continue;
        }
        if (action.kind === "login-required") {
          note("pause all for login");
          for (const member of [...live])
            member.pause("login required");
          return false;
        }
        if (action.kind === "stop-all") {
          note("stop all");
          this.halt(reason, this.opts.onStopAll);
          for (const member of [...live])
            member.stop(reason);
          return false;
        }
        if (action.kind === "stop-binding") {
          note("stop");
          this.halt(reason, this.opts.onStopBinding);
          return false;
        }
        note("skip");
        this.opts.onSkip?.(item, err);
        return true;
      }
    }
    return false;
  }
  halt(reason, notify) {
    if (this.stopped)
      return;
    this.stopped = true;
    live.delete(this.member);
    this.queue.length = 0;
    this.byteTotal = 0;
    notify?.(reason);
  }
}
// packages/session-sdk-base/src/text.ts
import { createHash } from "node:crypto";
function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}
function cutUtf8(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes)
    return s;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 192) === 128)
    end--;
  const removed = buf.byteLength - end;
  return `${buf.subarray(0, end).toString("utf8")}…[truncated ${removed} bytes]`;
}
// packages/session-sdk-auth/src/client.ts
function authPaths(dir) {
  return {
    config: join(dir, "config.json"),
    host: (channel) => join(dir, `host-${channel}.json`),
    session: (channel) => join(dir, `session-${channel}.json`),
    lock: (channel) => join(dir, `session-${channel}.json.lock`)
  };
}
function createSessionClient(opts) {
  const paths = () => authPaths(opts.dir());
  const notSignedIn = `Not signed in to HumanLayer. ${opts.loginHint}`;
  const stashKey = Symbol.for(opts.stashKey);
  function rpc2(channel, plane, path, body, cred, signal) {
    return rpcCall({
      api: getChannelConfig(channel).api,
      plane,
      path,
      body,
      cred,
      signal,
      onDone: (outcome, ms, bytes) => opts.log(`${plane} ${path} ${outcome} ${ms}ms ${bytes}B`)
    });
  }
  async function resolveChannel() {
    const envChannel = process.env.HUMANLAYER_CHANNEL;
    if (isChannel(envChannel))
      return envChannel;
    const saved = await readJsonFile(paths().config);
    if (isChannel(saved?.channel))
      return saved.channel;
    return "prod";
  }
  async function saveChannel(channel) {
    await writeJsonFileAtomic(paths().config, { channel });
  }
  const hostIds = new Map;
  function hostId(channel) {
    const file = paths().host(channel);
    let id = hostIds.get(file);
    if (!id) {
      id = withFileLock(`${file}.lock`, async () => {
        const existing = await readJsonFile(file);
        if (existing && typeof existing.hostId === "string" && existing.hostId.length > 0)
          return existing.hostId;
        const made = randomUUID2();
        await writeJsonFileAtomic(file, { hostId: made });
        return made;
      }).finally(() => hostIds.delete(file));
      hostIds.set(file, id);
    }
    return id;
  }
  function stash() {
    const saved = Reflect.get(globalThis, stashKey);
    if (saved)
      return saved;
    const fresh = {};
    Reflect.set(globalThis, stashKey, fresh);
    return fresh;
  }
  function getPat() {
    const s = stash();
    if (s.pat === undefined) {
      const fromEnv = process.env.HUMANLAYER_PAT;
      if (fromEnv !== undefined) {
        s.pat = fromEnv;
        delete process.env.HUMANLAYER_PAT;
      }
    }
    return s.pat;
  }
  function readCreds(channel) {
    return readJsonFile(paths().session(channel));
  }
  async function identity(channel) {
    if (getPat())
      return { channel, source: "pat" };
    const creds = await readCreds(channel);
    if (!creds)
      return null;
    return {
      channel,
      source: "device",
      email: creds.email,
      orgName: creds.orgName,
      orgId: creds.orgId,
      userId: creds.userId
    };
  }
  function isFresh(creds) {
    const claims = decodeJwtPayload(creds.accessToken);
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    return exp * 1000 - Date.now() > 60000;
  }
  async function refreshAndSave(channel, current) {
    let refreshed;
    try {
      refreshed = await rpc2(channel, "api", "auth/token/refresh", {
        refreshToken: current.refreshToken,
        organizationId: current.workosOrgId
      });
    } catch (err) {
      if (err instanceof RpcError && (err.status === 400 || err.status === 401)) {
        throw new LoginRequiredError(`HumanLayer sign-in expired. ${opts.loginHint}`);
      }
      throw err;
    }
    const updated = { ...current, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
    await writeJsonFileAtomic(paths().session(channel), updated);
    return updated.accessToken;
  }
  async function refreshAccessToken(channel) {
    const first = await readCreds(channel);
    if (!first)
      throw new LoginRequiredError(notSignedIn);
    if (isFresh(first))
      return first.accessToken;
    return withFileLock(paths().lock(channel), async () => {
      const current = await readCreds(channel);
      if (!current)
        throw new LoginRequiredError(notSignedIn);
      if (isFresh(current))
        return current.accessToken;
      return refreshAndSave(channel, current);
    });
  }
  async function refreshAccessTokenFrom(channel, staleToken) {
    return withFileLock(paths().lock(channel), async () => {
      const current = await readCreds(channel);
      if (!current)
        throw new LoginRequiredError(notSignedIn);
      if (current.accessToken !== staleToken)
        return current.accessToken;
      return refreshAndSave(channel, current);
    });
  }
  async function apiRpc(channel, path, body, signal) {
    const pat = getPat();
    const bearer = pat ?? await refreshAccessToken(channel);
    try {
      return await rpc2(channel, "api", path, body, bearer, signal);
    } catch (err) {
      if (pat) {
        if (err instanceof RpcError && err.status === 401) {
          throw new LoginRequiredError("HUMANLAYER_PAT was rejected (401). Set a valid HUMANLAYER_PAT.");
        }
        throw err;
      }
      if (!(err instanceof RpcError) || err.status !== 401)
        throw err;
      const retried = await refreshAccessTokenFrom(channel, bearer);
      return rpc2(channel, "api", path, body, retried, signal);
    }
  }
  async function mintDaemonToken(channel, host, signal) {
    const minted = await apiRpc(channel, "auth/daemon/token/create", { hostId: host }, signal);
    return minted.token;
  }
  async function remintPatDaemonToken(channel, signal) {
    if (!getPat())
      throw new LoginRequiredError("HUMANLAYER_PAT not set");
    const token = await mintDaemonToken(channel, await hostId(channel), signal);
    const s = stash();
    if (!s.patDaemonTokens)
      s.patDaemonTokens = {};
    s.patDaemonTokens[channel] = token;
    return token;
  }
  async function daemonToken(channel, signal) {
    if (getPat())
      return stash().patDaemonTokens?.[channel] ?? remintPatDaemonToken(channel, signal);
    const creds = await readCreds(channel);
    if (!creds)
      throw new LoginRequiredError(notSignedIn);
    return creds.daemonToken;
  }
  async function daemonOrgId(channel, signal) {
    return jwtClaim(await daemonToken(channel, signal), "organizationId");
  }
  async function remintDaemonToken(channel, signal) {
    if (getPat())
      return remintPatDaemonToken(channel, signal);
    const before = await readCreds(channel);
    if (!before)
      throw new LoginRequiredError(notSignedIn);
    const token = await mintDaemonToken(channel, before.daemonHostId, signal);
    return withFileLock(paths().lock(channel), async () => {
      const current = await readCreds(channel);
      if (!current)
        throw new LoginRequiredError(notSignedIn);
      if (current.daemonToken !== before.daemonToken)
        return current.daemonToken;
      await writeJsonFileAtomic(paths().session(channel), { ...current, daemonToken: token });
      return token;
    });
  }
  async function withDaemonToken(channel, signal, request) {
    try {
      return await request(await daemonToken(channel, signal));
    } catch (err) {
      if (!isTokenRefused(err))
        throw err;
      return request(await remintDaemonToken(channel, signal));
    }
  }
  function daemonCall(channel, path, body, signal) {
    return withDaemonToken(channel, signal, (token) => rpc2(channel, "daemon", path, body, token, signal));
  }
  function prepare(channel, body, signal) {
    return apiRpc(channel, "automation/run/prepare", body, signal);
  }
  return {
    paths,
    loginHint: opts.loginHint,
    log: opts.log,
    rpc: rpc2,
    resolveChannel,
    saveChannel,
    hostId,
    getPat,
    readCreds,
    identity,
    apiRpc,
    daemonToken,
    daemonOrgId,
    remintDaemonToken,
    withDaemonToken,
    daemonCall,
    prepare
  };
}
// packages/session-sdk-auth/src/login.ts
import { spawn } from "node:child_process";
import { unlink as unlink2 } from "node:fs/promises";
var CANCEL_MESSAGE = "login cancelled";
var TIMEOUT_MESSAGE = "the code expired";
var SLOW_DOWN_TIMEOUT_MESSAGE = "timed out after one or more slow_down responses. This is often caused by clock drift " + "in WSL or VM environments. Please sync or restart the VM clock and try again.";
var MINIMUM_INTERVAL_MS = 1000;
var DEFAULT_POLL_INTERVAL_SECONDS = 5;
var SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;
function abortableSleep(ms, signal, cancelMessage) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout2);
      reject(new Error(cancelMessage));
    };
    const timeout2 = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout2.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollDeviceCodeFlow(options) {
  const deadline = typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000));
  let slowDownResponses = 0;
  if (options.waitBeforeFirstPoll) {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0)
      await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
  }
  while (Date.now() < deadline) {
    if (options.signal.aborted)
      throw new Error(CANCEL_MESSAGE);
    const result = await options.poll();
    if (result.status === "complete")
      return result.value;
    if (result.status === "failed")
      throw new Error(result.message);
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      intervalMs = typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0 ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000)) : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0)
      break;
    await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
  }
  throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function workosForm(cfg, path, form, signal) {
  return fetch(`${cfg.workos}/user_management/${path}`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ ...form, client_id: cfg.clientId }),
    signal: timeout(15000, signal)
  });
}
async function startDeviceAuthorize(cfg, signal) {
  const res = await workosForm(cfg, "authorize/device", {}, signal);
  if (!res.ok)
    throw new Error(`could not start: HTTP ${res.status}`);
  return await res.json();
}
async function pollWorkosToken(cfg, deviceCode, signal) {
  const res = await workosForm(cfg, "authenticate", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }, signal);
  const json = await res.json().catch(() => null);
  if (res.ok && isRecord(json) && typeof json.access_token === "string" && typeof json.refresh_token === "string" && isRecord(json.user) && typeof json.user.email === "string") {
    return {
      status: "complete",
      value: { accessToken: json.access_token, refreshToken: json.refresh_token, email: json.user.email }
    };
  }
  const error = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
  if (error === "authorization_pending")
    return { status: "pending" };
  if (error === "slow_down")
    return { status: "slow_down" };
  return { status: "failed", message: error ?? `HTTP ${res.status}` };
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!cmd)
    return;
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {});
  } catch {}
}
function createDeviceLogin(client, opts = {}) {
  const logins = new Map;
  function pendingLogin(channel) {
    return logins.get(channel);
  }
  function abortLogin(channel) {
    logins.get(channel)?.controller.abort();
    logins.delete(channel);
  }
  async function startDeviceLogin(channel, ui) {
    abortLogin(channel);
    const login = { controller: new AbortController };
    logins.set(channel, login);
    const signal = login.controller.signal;
    const paths = client.paths();
    try {
      const approved = await approve(channel, login, ui);
      const org = await pickOrg(channel, approved, ui, signal);
      if (!org)
        return;
      const tokens = await scopeTo(channel, approved, org, signal);
      const creds = await credsFor(channel, tokens, org, signal);
      await withFileLock(paths.lock(channel), async () => {
        signal.throwIfAborted();
        await writeJsonFileAtomic(paths.session(channel), creds);
      });
      await client.saveChannel(channel);
      signal.throwIfAborted();
      return creds;
    } catch (err) {
      if (signal.aborted)
        return;
      throw err;
    } finally {
      if (logins.get(channel) === login)
        logins.delete(channel);
    }
  }
  async function approve(channel, login, ui) {
    const cfg = getChannelConfig(channel);
    const signal = login.controller.signal;
    const dc = await startDeviceAuthorize(cfg, signal);
    signal.throwIfAborted();
    login.url = dc.verification_uri_complete;
    login.code = dc.user_code;
    ui.showCode(dc.verification_uri_complete, dc.user_code);
    if (!opts.noBrowser?.())
      openBrowser(dc.verification_uri_complete);
    return pollDeviceCodeFlow({
      intervalSeconds: dc.interval,
      expiresInSeconds: dc.expires_in,
      waitBeforeFirstPoll: true,
      signal,
      poll: () => pollWorkosToken(cfg, dc.device_code, signal)
    });
  }
  async function pickOrg(channel, tokens, ui, signal) {
    const { organizations: orgs } = await client.rpc(channel, "api", "auth/user/organizations/list", {}, tokens.accessToken, signal);
    if (orgs.length === 0)
      throw new Error("you have no organization. Create or join one in the web app.");
    const savedOrgId = (await client.readCreds(channel))?.workosOrgId;
    const byId = (id) => orgs.find((o) => o.organizationId === id);
    const current = byId(savedOrgId) ?? byId(jwtClaim(tokens.accessToken, "org_id"));
    return orgs.length > 1 && ui.hasUI ? ui.pickOrg(orgs, current) : current ?? orgs[0];
  }
  async function scopeTo(channel, tokens, org, signal) {
    if (jwtClaim(tokens.accessToken, "org_id") === org.organizationId)
      return tokens;
    const refreshed = await client.rpc(channel, "api", "auth/token/refresh", { refreshToken: tokens.refreshToken, organizationId: org.organizationId }, undefined, signal);
    return { email: tokens.email, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
  }
  async function credsFor(channel, tokens, org, signal) {
    const claim = (key) => {
      const value = jwtClaim(tokens.accessToken, key);
      if (!value)
        throw new Error(`the token is missing claim "${key}"`);
      return value;
    };
    const userId = claim("sub");
    const orgId = claim("internal_org_id");
    const workosOrgId = claim("org_id");
    const daemonHostId = await client.hostId(channel);
    const daemon = await client.rpc(channel, "api", "auth/daemon/token/create", { hostId: daemonHostId }, tokens.accessToken, signal);
    return {
      version: 1,
      channel,
      email: tokens.email,
      userId,
      orgId,
      workosOrgId,
      orgName: org.organizationName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      daemonToken: daemon.token,
      daemonHostId
    };
  }
  async function logout(channel) {
    abortLogin(channel);
    const paths = client.paths();
    await withFileLock(paths.lock(channel), () => unlink2(paths.session(channel)).catch(() => {}));
  }
  return { pendingLogin, abortLogin, startDeviceLogin, logout };
}
// apps/riptide-pi-extension/src/config.ts
import { homedir } from "node:os";
import { join as join4 } from "node:path";

// packages/session-sdk-artifacts/src/frontmatter.ts
var UNSURE = Symbol("unsure");
var NON_PRINTABLE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u2028\u2029\uFFFE\uFFFF\p{Cs}]/u;
var OTHER_NUMBER = /^(?:[-+]?(?:0b[01_]+|0x[\da-fA-F_]+|0[0-7_]+|(?:0|[1-9][\d_]*)(?::[0-5]?\d)*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.(?:inf|Inf|INF))|\.[\d_]+(?:[eE][-+]?\d+)?|\.(?:nan|NaN|NAN))$/;
var DATE = /^(\d{4})-(\d\d)-(\d\d)$/;
var DATETIME = /^(\d{4})-(\d\d?)-(\d\d?)(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))?(?:[ \t]*(Z|([-+])(\d\d?)(?::(\d\d))?))?$/;
var ESCAPES = new Map([
  ["\\", "\\"],
  ['"', '"'],
  ["/", "/"],
  ["n", `
`],
  ["t", "\t"],
  ["r", "\r"]
]);
function frontmatter(content) {
  const text2 = content.replace(/^\uFEFF/, "");
  const open2 = /^---[ \t]*(?:ya?ml[ \t]*)?\r?\n/i.exec(text2);
  if (!open2)
    return {};
  const rest = text2.slice(open2[0].length);
  const close = rest.startsWith("---") ? 0 : rest.indexOf(`
---`);
  const data = new Map;
  let key;
  let list;
  for (const raw of (close < 0 ? rest : rest.slice(0, close)).split(`
`)) {
    const line = raw.replace(/\r$/, "");
    if (NON_PRINTABLE.test(line))
      return {};
    if (/^[ \t]*(?:#.*)?$/.test(line))
      continue;
    const item = /^( *)-(?:[ \t]+(.*))?$/.exec(line);
    if (item) {
      const indent = item[1]?.length ?? 0;
      const value2 = scalar(item[2] ?? "");
      if (key === undefined || list && list.indent !== indent || value2 === UNSURE || Array.isArray(value2))
        return {};
      if (!list) {
        list = { indent, items: [] };
        data.set(key, list.items);
      }
      list.items.push(value2);
      continue;
    }
    const pair = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/.exec(line);
    const name = pair?.[1];
    if (!pair || !name || data.has(name) || /^(?:true|false|null)$/i.test(name))
      return {};
    const valueText = (pair[2] ?? "").trim();
    const value = scalar(valueText);
    if (value === UNSURE)
      return {};
    data.set(name, value);
    key = valueText === "" || valueText.startsWith("#") ? name : undefined;
    list = undefined;
  }
  return Object.fromEntries(data);
}
function scalar(raw) {
  const s = raw.trim();
  if (s === "" || s.startsWith("#"))
    return null;
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/.exec(s);
    return m ? unescapeDouble(m[1] ?? "") : UNSURE;
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(s);
    return m ? (m[1] ?? "").replaceAll("''", "'") : UNSURE;
  }
  if (s.startsWith("["))
    return flowList(s);
  const plain = s.replace(/[ \t]+#.*$/, "");
  if (/^[-?:](?:[ \t]|$)|^[,\]{}&*!|>%@`]|:(?:[ \t]|$)/.test(plain))
    return UNSURE;
  return plainScalar(plain);
}
function unescapeDouble(body) {
  let sure = true;
  const out = body.replace(/\\(u[\da-fA-F]{4}|.)/g, (_, e) => {
    if (e.length === 5)
      return String.fromCharCode(Number.parseInt(e.slice(1), 16));
    const c = ESCAPES.get(e);
    if (c === undefined)
      sure = false;
    return c ?? "";
  });
  return sure ? out : UNSURE;
}
function flowList(s) {
  const inner = /^\[(.*)\](?:[ \t]+#.*)?$/.exec(s)?.[1];
  if (inner === undefined)
    return UNSURE;
  if (inner.trim() === "")
    return [];
  const items = [];
  const next = /[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,"'[\]{}#]+)[ \t]*(,|$)/y;
  while (next.lastIndex < inner.length) {
    const m = next.exec(inner);
    const value = m ? scalar(m[1] ?? "") : UNSURE;
    if (!m || value === UNSURE || Array.isArray(value))
      return UNSURE;
    if (m[2] === "," && next.lastIndex === inner.length)
      return UNSURE;
    items.push(value);
  }
  return items;
}
function plainScalar(s) {
  if (/^(?:~|null|Null|NULL)$/.test(s))
    return null;
  if (/^(?:true|True|TRUE)$/.test(s))
    return true;
  if (/^(?:false|False|FALSE)$/.test(s))
    return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s))
    return Number(s);
  if (OTHER_NUMBER.test(s))
    return UNSURE;
  return timestamp(s) ?? s;
}
function timestamp(s) {
  const m = DATE.exec(s) ?? DATETIME.exec(s);
  if (!m)
    return;
  const n = (i) => Number(m[i] ?? 0);
  const ms = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"));
  let t = Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6), ms);
  if (m[9])
    t -= (m[9] === "-" ? -1 : 1) * (n(10) * 60 + n(11)) * 60000;
  return new Date(t).toISOString();
}
// packages/session-sdk-artifacts/src/rules.ts
var TEXT_EXTENSIONS = /\.(md|mdx|txt|json|jsonl)$/i;
var MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["pdf", "application/pdf"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["json", "application/json"],
  ["css", "text/css"],
  ["js", "text/javascript"],
  ["mjs", "text/javascript"]
]);
var MAX_ARTIFACT_TEXT_BYTES = 10 * 1024 * 1024;
function isTextFile(fileName) {
  return TEXT_EXTENSIONS.test(fileName);
}
function getMimeType(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES.get(ext) ?? "application/octet-stream";
}
var ARTIFACT_TRASH_DIRECTORY = ".trash";
function isReservedArtifactTrashSubpath(subpath) {
  return subpath.replaceAll("\\", "/").split("/")[0] === ARTIFACT_TRASH_DIRECTORY;
}
function decoded(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
function isRefusedSubpath(name) {
  const risky = (s) => s.includes("\\") || s.includes("..") || s.includes("\x00") || s.startsWith("/") || s.endsWith("/") || s.split("/").some((part) => part === "" || part === ".");
  const d = decoded(name);
  return name.length < 1 || name.length > 1024 || risky(name) || risky(d) || d.split("/").length !== name.split("/").length;
}
function isSyncableSubpath(subpath) {
  return !isReservedArtifactTrashSubpath(subpath) && !isRefusedSubpath(subpath);
}
// packages/session-sdk-artifacts/src/sync.ts
import { createHash as createHash3 } from "node:crypto";
import { appendFile as appendFile3, lstat, mkdir as mkdir3, readdir as readdir2, readFile as readFile3, readlink as readlink2, realpath as realpath2, symlink, unlink as unlink3 } from "node:fs/promises";
import { basename as basename3, dirname as dirname4, isAbsolute, join as join3, relative, resolve, sep } from "node:path";

// packages/session-sdk-sessions/src/claims.ts
var KEEP_MS = 24 * 60 * 60 * 1000;
// packages/session-sdk-sessions/src/commands.ts
function sessionCommand(change) {
  if (change.type === "delete")
    return;
  const { value, previousValue } = change;
  const moved = change.type === "insert" || previousValue?.status !== value.status;
  if (!moved)
    return;
  if (value.status === "resuming") {
    const resume = change.type === "update" && previousValue?.status === "lost" ? "lost-resume" : "ordinary";
    return { kind: "continue", sessionId: value.id, prompt: value.prompt ?? null, resume };
  }
  if (value.status === "interrupt_requested")
    return { kind: "interrupt", sessionId: value.id };
  return;
}
// packages/session-sdk-sessions/src/events.ts
import { createHash as createHash2 } from "node:crypto";
var EVENT_LIMITS = {
  contentBytes: 1024 * 1024,
  hiddenBytes: 256 * 1024,
  idChars: 256
};
function systemFields(payload) {
  return { eventType: "system", role: "system", content: JSON.stringify(payload) };
}
function hiddenFields(payload) {
  return { eventType: "system", role: "system", content: cutUtf8(JSON.stringify(payload), EVENT_LIMITS.hiddenBytes) };
}
function fitEvent(event) {
  const fitted = { ...event };
  fitted.content &&= cutUtf8(fitted.content, EVENT_LIMITS.contentBytes);
  fitted.toolResultContent &&= cutUtf8(fitted.toolResultContent, EVENT_LIMITS.contentBytes);
  fitted.toolCallId &&= fitted.toolCallId.slice(0, EVENT_LIMITS.idChars);
  fitted.toolResultForId &&= fitted.toolResultForId.slice(0, EVENT_LIMITS.idChars);
  if (fitted.toolInputJson !== undefined)
    fitted.toolInputJson = cutStrings(fitted.toolInputJson);
  return fitted;
}
function cutStrings(value) {
  if (typeof value === "string")
    return cutUtf8(value, EVENT_LIMITS.contentBytes);
  if (Array.isArray(value))
    return value.map(cutStrings);
  if (typeof value !== "object" || value === null)
    return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item)]));
}
var NAME_UUID_NAMESPACE = Buffer.from("c7b1b7b063e4de4a9c8a2f6b7a4e9d31", "hex");
function eventUuid(name) {
  const hash = createHash2("sha1").update(Buffer.concat([NAME_UUID_NAMESPACE, Buffer.from(name, "utf8")])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] ?? 0) & 15 | 80;
  bytes[8] = (bytes[8] ?? 0) & 63 | 128;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// packages/session-sdk-sessions/src/shape.ts
class ShapeReader {
  opts;
  handle;
  offset = "-1";
  cursor;
  live = false;
  seeded = false;
  rows = new Map;
  constructor(opts) {
    this.opts = { liveTimeoutMs: 60000, fetchTimeoutMs: 20000, ...opts };
  }
  get isSeeded() {
    return this.seeded;
  }
  get current() {
    return this.rows;
  }
  async poll(headers, signal) {
    const url = new URL(this.opts.url);
    url.searchParams.set("offset", this.offset);
    if (this.handle)
      url.searchParams.set("handle", this.handle);
    if (this.live) {
      url.searchParams.set("live", "true");
      if (this.cursor)
        url.searchParams.set("cursor", this.cursor);
    }
    const res = await fetch(url, {
      headers,
      signal: timeout(this.live ? this.opts.liveTimeoutMs : this.opts.fetchTimeoutMs, signal)
    });
    if (res.status === 409) {
      await res.body?.cancel();
      this.refetch(res.headers.get("electric-handle") ?? undefined);
      return [];
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new RpcError(`shape HTTP ${res.status}`, res.status, undefined);
    }
    this.handle = res.headers.get("electric-handle") ?? this.handle;
    this.offset = res.headers.get("electric-offset") ?? this.offset;
    this.cursor = res.headers.get("electric-cursor") ?? this.cursor;
    const messages = res.status === 204 ? [] : await res.json();
    const changes = [];
    for (const m of messages) {
      const change = this.apply(m);
      if (change)
        changes.push(change);
    }
    return changes;
  }
  refetch(handle) {
    this.handle = handle;
    this.offset = "-1";
    this.cursor = undefined;
    this.live = false;
  }
  apply(m) {
    const { control, operation } = m.headers;
    if (control === "up-to-date") {
      this.live = true;
      this.seeded = true;
      return;
    }
    if (control === "must-refetch") {
      this.refetch(undefined);
      return;
    }
    const key = m.key ?? m.value?.id;
    if (!operation || !key)
      return;
    const previousValue = this.rows.get(key);
    const value = operation === "insert" ? m.value : { ...previousValue, ...m.value };
    if (operation === "delete")
      this.rows.delete(key);
    else
      this.rows.set(key, value);
    const type = operation === "insert" && previousValue ? "update" : operation;
    return { type, key, value, previousValue, initial: !this.seeded };
  }
}

// packages/session-sdk-sessions/src/inbox.ts
var WAITING = new Set(["resuming", "interrupt_requested"]);
// packages/session-sdk-sessions/src/prepare.ts
import { execFile } from "node:child_process";
import { basename, dirname as dirname2 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function git(cwd, ...args) {
  try {
    return (await execFileAsync("git", args, { cwd, timeout: 5000 })).stdout.trim();
  } catch {
    return;
  }
}
async function gitInfo(cwd) {
  const root = await git(cwd, "rev-parse", "--show-toplevel");
  if (!root)
    return;
  const [headSha, branch, remoteUrl] = await Promise.all([
    git(root, "rev-parse", "--verify", "-q", "HEAD"),
    git(root, "symbolic-ref", "--short", "-q", "HEAD"),
    git(root, "remote", "get-url", "origin")
  ]);
  const info = { root, branch: branch ?? "" };
  if (headSha)
    info.headSha = headSha;
  if (remoteUrl)
    info.remoteUrl = stripUserinfo(remoteUrl);
  return info;
}
function stripUserinfo(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password)
      return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
function promptText(text2, imageCount) {
  const parts = [text2, ...Array.from({ length: imageCount }, () => "[image]")].filter((part) => part.trim());
  return cutUtf8(parts.join(`
`), 1024 * 1024) || "(empty prompt)";
}
function prepareBody(f) {
  const session = {
    hostId: f.hostId,
    sessionName: f.title,
    prompt: f.prompt,
    workingDirectory: f.cwd,
    codingAgent: f.codingAgent,
    permissionsMode: "bypass"
  };
  if (f.model) {
    session.provider = f.model.provider;
    session.model = f.model.id;
  }
  if (f.pick.taskMode === "use")
    return { ...session, taskMode: "use", taskIdOrSlug: f.pick.taskIdOrSlug };
  const task = { name: f.title, workflowType: "freeform", worktreeTiming: "never" };
  if (f.git)
    task.workspaceState = workspaceState(f.git);
  return { ...session, taskMode: "ensure", slug: f.pick.slug, task };
}
function workspaceState(git2) {
  const repo = { path: basename(git2.root), sourceRef: "HEAD", branch: git2.branch, primary: true };
  if (git2.headSha)
    repo.sourceCommit = git2.headSha;
  if (git2.remoteUrl)
    repo.remoteUrl = git2.remoteUrl;
  return { workspaceBaseDirectory: dirname2(git2.root), repos: [repo] };
}
function repositoriesReport(git2) {
  const repo = { localPath: git2.root };
  if (git2.remoteUrl)
    repo.remoteUrl = git2.remoteUrl;
  if (git2.branch)
    repo.branch = git2.branch;
  return { repositories: [repo] };
}
// packages/session-sdk-sessions/src/task-pick.ts
import { appendFile as appendFile2, mkdir as mkdir2, readdir, readFile as readFile2, readlink, realpath } from "node:fs/promises";
import { basename as basename2, dirname as dirname3, join as join2 } from "node:path";
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID.test(value);
}
async function pickTask(o) {
  if (o.attach === "new")
    return newTask(o.prefix, o.freshId?.() ?? `${Date.now()}`);
  const chosen = o.attach || o.chosen?.trim();
  if (chosen === "new")
    return newTask(o.prefix, o.sessionId);
  if (chosen)
    return { taskMode: "use", taskIdOrSlug: chosen, taskSlug: isUuid(chosen) ? undefined : chosen };
  const link = await taskLink(o.cwd, o.linksPath);
  if (link)
    return { taskMode: "use", taskIdOrSlug: link.taskId, taskSlug: link.slug, auto: true };
  return newTask(o.prefix, o.sessionId);
}
function newTask(prefix, sessionId) {
  const tail = sessionId.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase();
  return { taskMode: "ensure", slug: `${prefix}-${tail}` };
}
async function taskLink(cwd, linksPath) {
  const dir = await realpath(join2(cwd, ".humanlayer", "tasks")).catch(() => "");
  let links = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const target = await readlink(join2(dir, name)).catch(() => "");
    const taskId = /\/artifacts\/([^/]+)\/?$/.exec(target)?.[1];
    if (taskId && UUID.test(taskId))
      links.push({ taskId, slug: name });
  }
  if (links.length > 0) {
    const own = new Set((await readFile2(linksPath, "utf8").catch(() => "")).split(`
`));
    links = links.filter((link) => !own.has(linkKey(join2(dir, link.slug), link.taskId)));
  }
  return links.length === 1 ? links[0] : undefined;
}
function linkKey(path, taskId) {
  return JSON.stringify([path, taskId]);
}
async function recordLink(linksPath, path, taskId) {
  const key = linkKey(join2(await realpath(dirname3(path)), basename2(path)), taskId);
  await mkdir2(dirname3(linksPath), { recursive: true, mode: 448 });
  await appendFile2(linksPath, `
${key}
`, { mode: 384 });
}
// packages/session-sdk-artifacts/src/sync.ts
function ohash(s) {
  const wrapped = `'${s.replaceAll("\x00", "")}'`;
  return createHash3("sha256").update(wrapped, "utf8").digest("base64url");
}
var HINT_SECTION = "artifacts_directory_information";
var TRIES = 5;
function safeSlug(slug) {
  return slug && /^[a-z0-9][\w.-]*$/i.test(slug) ? slug : undefined;
}
function taskFolder(cwd, slug) {
  return join3(cwd, ".humanlayer", "tasks", slug);
}
function artifactsHint(cwd, taskSlug, sessionUrl) {
  const lines = [];
  const slug = safeSlug(taskSlug);
  if (slug) {
    const folder = taskFolder(cwd, slug);
    lines.push(`Your task artifacts directory is: ${folder}`, "", "Files you write there sync to the user's HumanLayer task, where the user can read them.", "If the user asks you to continue work on a task, design discussion or plan and doesn't mention a file, check here first.", "This directory may be a symlink: list it with `ls -La`, and read and write files through this path, never through the link's target.", "Use the write and edit tools for artifacts.", "", "To show the user an HTML page or an image inline, put its path in a fenced block:", "```task-artifact", `${folder}/page.html`, "```");
  }
  if (sessionUrl) {
    if (lines.length > 0)
      lines.push("");
    lines.push(`The user can follow this session in HumanLayer at ${sessionUrl}`, "If they ask to see or open the session, open that URL (for example with `open` on macOS or `xdg-open` on Linux).");
  }
  return lines.length > 0 ? lines.join(`
`) : undefined;
}
async function openFolder(host, folder) {
  const { store, cwd, log } = host;
  await mkdir3(store, { recursive: true });
  await mkdir3(dirname4(folder), { recursive: true });
  const st = await lstat(folder).catch(() => {
    return;
  });
  if (st?.isSymbolicLink()) {
    if (basename3(await realpath2(folder).catch(() => "")) !== basename3(store)) {
      log(`relinking ${folder} to ${store}`);
      const mine = basename3(await readlink2(folder)) !== basename3(store);
      await unlink3(folder);
      await linkFolder(host, folder, mine);
    }
  } else if (!st) {
    await linkFolder(host, folder, true);
  } else if (!st.isDirectory()) {
    log(`${folder} is not a folder; task files will not sync`);
    return;
  }
  await excludeFromGit(cwd).catch((err) => log(`info/exclude: ${errorMessage(err)}`));
  return realpath2(folder);
}
async function linkFolder(host, folder, mine) {
  if (mine)
    await host.recordLink?.(folder, basename3(host.store));
  try {
    await symlink(host.store, folder, "dir");
  } catch (err) {
    if (err.code !== "EEXIST")
      throw err;
  }
}
async function excludeFromGit(cwd) {
  if (await git(cwd, "check-ignore", "-q", "--no-index", "--", ".humanlayer/tasks") !== undefined)
    return;
  const [prefix, path] = await Promise.all([
    git(cwd, "rev-parse", "--show-prefix"),
    git(cwd, "rev-parse", "--git-path", "info/exclude")
  ]);
  if (prefix === undefined || !path)
    return;
  const file = resolve(cwd, path);
  await mkdir3(dirname4(file), { recursive: true });
  const text2 = await readFile3(file, "utf8").catch(() => "");
  const line = `/${prefix.replace(/[*?[\\]/g, "\\$&")}.humanlayer/tasks/`;
  if (text2.split(/\r?\n/).includes(line))
    return;
  await appendFile3(file, `${text2 && !text2.endsWith(`
`) ? `
` : ""}${line}
`);
}
async function subpathOf(path, roots) {
  const under = (p) => {
    for (const root of roots) {
      const rel = relative(root, p);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel))
        return rel.split(sep).join("/");
    }
    return;
  };
  const real = await realpath2(path).catch(() => {
    return;
  });
  return under(resolve(path)) ?? (real ? under(real) : undefined);
}
async function listFolder(folder) {
  const entries = await readdir2(folder, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(folder, join3(e.parentPath, e.name)).split(sep).join("/")).filter(isSyncableSubpath);
}

class ArtifactSync {
  host;
  folder;
  outbox;
  ready;
  queued = new Set;
  refused = new Map;
  seq = 0;
  closed = false;
  constructor(host, folder) {
    this.host = host;
    const log = host.log;
    this.folder = folder;
    this.outbox = new Outbox({
      send: async (item) => {
        const changed = await this.send(item);
        this.queued.delete(item.name);
        if (changed)
          this.push(item.name);
      },
      classify: (err, plane) => {
        const action = classifyRpcError(err, plane);
        return isRetry(action) ? { kind: "retry-limited", maxAttempts: TRIES - 1 } : action;
      },
      onStopBinding: (reason) => host.warn(`artifacts:${reason}`, `HumanLayer: task files stopped syncing: ${reason}`),
      onSkip: (item, err) => {
        this.queued.delete(item.name);
        if (!isRetry(classifyRpcError(err, "daemon")) && item.read)
          this.refused.set(item.name, item.read);
        log(`task file ${item.name} not synced: ${errorMessage(err)}`);
      },
      onDrop: (item) => this.queued.delete(item.name),
      log,
      ...host.backoff
    });
    this.ready = openFolder(host, folder).then((real) => real ? [folder, real] : undefined, (err) => {
      log(`task folder ${folder}: ${errorMessage(err)}`);
      return;
    });
    this.touched({});
  }
  touched(t) {
    if (this.closed || this.outbox.isStopped)
      return;
    const run = t.path ? this.syncPath(t.path) : this.scan();
    run.catch((err) => this.host.log(`task files: ${errorMessage(err)}`));
  }
  async flush(ms) {
    const end = Date.now() + ms;
    const run = this.scan().then(() => this.outbox.drain(Math.max(0, end - Date.now())));
    await Promise.race([run.catch(() => {
      return;
    }), sleepUnref(ms)]);
  }
  close() {
    this.closed = true;
    this.outbox.close();
  }
  async syncPath(path) {
    const roots = await this.ready;
    const name = roots && await subpathOf(path, roots);
    if (!name)
      return;
    if (isSyncableSubpath(name))
      this.push(name);
    else
      this.host.log(`task file ${name} skipped: .trash, or a name the server refuses`);
  }
  async scan() {
    if (!await this.ready || this.closed)
      return;
    const names = await listFolder(this.folder).catch((err) => {
      this.host.log(`task folder scan: ${errorMessage(err)}`);
      return [];
    });
    const stats = await Promise.all(names.map((name) => lstat(this.pathOf(name)).catch(() => {
      return;
    })));
    const ledger = this.host.ledger();
    names.forEach((name, i) => {
      const st = stats[i];
      const now = st && `${st.mtimeMs}:${st.size}`;
      if (now && ledger[name]?.mtimeSize !== now && this.refused.get(name) !== now)
        this.push(name);
    });
  }
  push(name) {
    if (this.closed || this.queued.has(name))
      return;
    this.queued.add(name);
    this.outbox.push({ id: String(++this.seq), plane: "daemon", sizeBytes: name.length, name });
  }
  pathOf(name) {
    return join3(this.folder, ...name.split("/"));
  }
  async send(item) {
    const path = this.pathOf(item.name);
    const st = await lstat(path).catch(() => {
      return;
    });
    if (!st?.isFile())
      return false;
    const read = `${st.mtimeMs}:${st.size}`;
    item.read = read;
    const bytes = await readFile3(path);
    const text2 = isTextFile(item.name);
    const hash = text2 ? ohash(bytes.toString("utf8")) : sha256Hex(bytes);
    const ledger = this.host.ledger();
    const last = ledger[item.name];
    if (hash !== last?.hash) {
      if (text2 ? bytes.length > MAX_ARTIFACT_TEXT_BYTES : bytes.length === 0) {
        this.refused.set(item.name, read);
        this.host.log(`task file ${item.name} not synced: ${text2 ? "over 10 MiB" : "empty"}`);
        return false;
      }
      if (text2)
        await this.upsert(item.name, path, bytes.toString("utf8"), last ? "Edit" : "Write");
      else
        await this.upload(item.name, bytes, hash);
      this.host.note(item.name);
    }
    ledger[item.name] = { hash, mtimeSize: read };
    this.host.save();
    const after = await lstat(path).catch(() => {
      return;
    });
    return after !== undefined && `${after.mtimeMs}:${after.size}` !== read;
  }
  async upsert(name, path, content, operationType) {
    await this.host.daemonCall(this.host.channel, "artifacts/upsert", {
      taskId: this.host.taskId,
      fileName: name,
      content,
      sessionId: this.host.sessionId,
      operationType,
      operationContents: { path, file_path: path },
      frontmatter: frontmatter(content)
    }, this.host.signal);
  }
  async upload(name, bytes, hash) {
    const contentType = getMimeType(name);
    const { uploadUrl } = await this.host.daemonCall(this.host.channel, "artifacts/createUpload", {
      taskId: this.host.taskId,
      fileName: name,
      contentType,
      contentHash: hash,
      fileSizeBytes: bytes.length
    }, this.host.signal);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: new Headers({ "content-type": contentType }),
      body: bytes,
      signal: timeout(30000 + Math.ceil(bytes.length / 100), this.host.signal)
    });
    await res.arrayBuffer().catch(() => {
      return;
    });
    if (!res.ok)
      throw new Error(`upload of ${name}: HTTP ${res.status}`);
  }
}
// apps/riptide-pi-extension/src/config.ts
function riptideHome() {
  return process.env.HUMANLAYER_RIPTIDE_HOME || join4(homedir(), ".humanlayer", "riptide");
}
function piDir() {
  return join4(riptideHome(), "pi");
}
function configFilePath() {
  return authPaths(piDir()).config;
}
function bindingsDir(channel) {
  return join4(piDir(), "bindings", channel);
}
function artifactsDir(taskId) {
  return join4(riptideHome(), "artifacts", taskId);
}
function logFilePath() {
  return join4(piDir(), "logs", "pi-humanlayer.log");
}
function log(line) {
  logLine(logFilePath(), `${new Date().toISOString()} ${line}`);
}
function guard(name, fn) {
  try {
    return fn();
  } catch (err) {
    log(`${name}: ${errorMessage(err)}`);
    return;
  }
}
async function resolveChannel() {
  const envChannel = process.env.HUMANLAYER_CHANNEL;
  if (isChannel(envChannel))
    return envChannel;
  const saved = await readJsonFile(configFilePath());
  if (isChannel(saved?.channel))
    return saved.channel;
  return "prod";
}
function isDisabled() {
  return process.env.HUMANLAYER_PI_DISABLE === "1";
}
const humanlayerSettings = createHumanlayerSettings({ withFileLock, writeJsonFileAtomic });
function codingAgent() {
  return process.env.HUMANLAYER_PI_CODING_AGENT || "pi";
}
function taskFromEnv() {
  return process.env.HUMANLAYER_TASK?.trim() || undefined;
}
function flushMs() {
  const ms = Number.parseInt(process.env.HUMANLAYER_PI_FLUSH_MS ?? "", 10);
  return ms >= 0 ? ms : 5000;
}
function heartbeatMs() {
  const ms = Number.parseInt(process.env.HUMANLAYER_PI_HEARTBEAT_MS ?? "", 10);
  return ms > 0 ? ms : 15000;
}

// apps/riptide-pi-extension/src/auth.ts
var client2 = createSessionClient({
  dir: piDir,
  log,
  loginHint: "Run /humanlayer login",
  stashKey: "humanlayer.pi.v1"
});
var login2 = createDeviceLogin(client2, { noBrowser: () => process.env.HUMANLAYER_PI_NO_BROWSER === "1" });
var { apiRpc, daemonOrgId, daemonToken, getPat, hostId, identity, remintDaemonToken, withDaemonToken } = client2;

// apps/riptide-pi-extension/src/capture.ts
import { access } from "node:fs/promises";

// apps/riptide-pi-extension/src/rpc.ts
var rpc2 = client2.rpc;

// apps/riptide-pi-extension/src/api.ts
var daemonCall = client2.daemonCall;
function sendSessionCall(channel, call, sessionId, signal) {
  const body = { ...call.body, sessionId };
  return withDaemonToken(channel, signal, (token) => rpc2(channel, "daemon", call.path, body, token, signal));
}
var prepare2 = client2.prepare;

// apps/riptide-pi-extension/src/binding.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { dirname as dirname5, join as join5 } from "node:path";
function pickTask2(piSessionId, cwd, attach, flag) {
  return pickTask({
    prefix: "pi",
    sessionId: piSessionId,
    cwd,
    linksPath: linksPath(),
    attach,
    chosen: flag?.trim() || taskFromEnv(),
    freshId: randomUUID3
  });
}
function newTask2(piSessionId) {
  return newTask("pi", piSessionId);
}
function linksPath() {
  return join5(dirname5(configFilePath()), "task-links.jsonl");
}
function recordLink2(path, taskId) {
  return recordLink(linksPath(), path, taskId);
}
function sessionTitle(sessionName, prompt) {
  const line = prompt.split(`
`).find((l) => l.trim()) ?? "";
  return sessionName?.trim() || Array.from(line.trim()).slice(0, 80).join("").trim() || "pi session";
}
function prepareBody2(f) {
  return prepareBody({ ...f, codingAgent: codingAgent() });
}
function newBinding(o) {
  const b = {
    version: 1,
    channel: o.channel,
    piSessionId: o.piSessionId,
    cwd: o.cwd,
    createdAt: new Date().toISOString(),
    taskMode: o.pick.taskMode,
    hostId: o.hostId,
    cursor: o.cursor
  };
  const slug = o.pick.taskMode === "ensure" ? o.pick.slug : o.pick.taskSlug;
  if (slug)
    b.taskSlug = slug;
  else if (o.pick.taskMode === "use")
    b.taskId = o.pick.taskIdOrSlug;
  if (o.git)
    b.git = o.git;
  return b;
}
function bindingPath(channel, piSessionId) {
  return join5(bindingsDir(channel), `${piSessionId}.json`);
}
async function loadBinding(channel, piSessionId, who) {
  const b = await readJsonFile(bindingPath(channel, piSessionId));
  if (b?.version !== 1 || !b.cloudSessionId || b.channel !== channel || b.hostId !== await hostId(channel))
    return;
  if (who?.source === "device" && (b.userId !== who.userId || b.orgId !== who.orgId))
    return;
  return b;
}
async function saveBinding(b) {
  await writeJsonFileAtomic(bindingPath(b.channel, b.piSessionId), b);
}

// apps/riptide-pi-extension/src/artifacts.ts
function artifactsHint2(cwd, b) {
  return artifactsHint(cwd, b.taskSlug, b.sessionUrl);
}
function artifactLane(host) {
  const slug = safeSlug(host.binding.taskSlug);
  if (!slug)
    return;
  const b = host.binding;
  return new ArtifactSync({
    channel: b.channel,
    taskId: host.taskId,
    sessionId: host.sessionId,
    cwd: host.cwd,
    store: artifactsDir(host.taskId),
    signal: host.signal,
    backoff: host.backoff,
    ledger: () => b.artifactLedger ??= {},
    save: () => host.save(),
    note: (file) => host.note(file),
    warn: (key, message) => host.warn(key, message),
    log,
    daemonCall,
    recordLink: recordLink2
  }, taskFolder(host.cwd, slug));
}

// apps/riptide-pi-extension/src/diffs.ts
import { basename as basename4 } from "node:path";

// packages/session-sdk-diffs/src/git-output.ts
function parseNameStatus(out) {
  const tokens = out.split("\x00");
  const changes = [];
  for (let i = 0;i < tokens.length; ) {
    const status = tokens[i] ?? "";
    const pair = status.startsWith("R") || status.startsWith("C");
    const path = tokens[i + (pair ? 2 : 1)];
    if (!status || !path)
      break;
    const prevPath = tokens[i + 1];
    if (status.startsWith("R") && prevPath)
      changes.push({ changeType: "renamed", path, prevPath });
    else if (status.startsWith("A") || status.startsWith("C"))
      changes.push({ changeType: "added", path });
    else
      changes.push({ changeType: status.startsWith("D") ? "deleted" : "modified", path });
    i += pair ? 3 : 2;
  }
  return changes;
}
function parseNumstat(out) {
  const stats = new Map;
  const tokens = out.split("\x00");
  for (let i = 0;i < tokens.length; i++) {
    const [added, deleted, ...rest] = (tokens[i] ?? "").split("\t");
    if (added === undefined || deleted === undefined || rest.length === 0)
      continue;
    let path = rest.join("\t");
    if (path === "") {
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    const binary = added === "-" || deleted === "-";
    stats.set(path, { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
  }
  return stats;
}
// packages/session-sdk-diffs/src/paths.ts
function isEnvironmentPath(filePath) {
  const segments = filePath.split(/[\\/]/);
  const filename = segments.at(-1);
  return segments.some((segment) => segment.startsWith(".env")) || filename?.endsWith(".env") === true;
}
function isPrivateDiffPath(filePath) {
  return isEnvironmentPath(filePath) || filePath.split(/[\\/]/).slice(0, -1).includes(".humanlayer");
}
// packages/streams/src/config.ts
var MAX_TASK_DIFF_PATCH_BYTES = 8 * 1024 * 1024;

// packages/session-sdk-diffs/src/rows.ts
function diffFileRowId(taskId, repoId, path) {
  return `${taskId}:${repoId}:${path}`;
}
function patchFits(patch, maxBytes = MAX_TASK_DIFF_PATCH_BYTES) {
  return Buffer.byteLength(JSON.stringify(patch)) <= maxBytes;
}
// packages/session-sdk-diffs/src/stream-messages.ts
function diffStreamMessage(type, key, operation, timestamp2, from, value) {
  const message = {
    type,
    key,
    headers: { operation, timestamp: timestamp2, from }
  };
  if (value !== undefined)
    message.value = value;
  return JSON.stringify(message);
}
function messageBatches(messages, maxBytes) {
  const bodies = [];
  let batch = [];
  let bytes = 1;
  for (const msg of messages) {
    const size = Buffer.byteLength(msg) + 1;
    if (batch.length > 0 && bytes + size > maxBytes) {
      bodies.push(`[${batch.join(",")}]`);
      batch = [];
      bytes = 1;
    }
    batch.push(msg);
    bytes += size;
  }
  if (batch.length > 0)
    bodies.push(`[${batch.join(",")}]`);
  return bodies;
}
// packages/session-sdk-diffs/src/sync.ts
import { execFile as execFile2 } from "node:child_process";
import { cp, mkdir as mkdir4, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join as join6, resolve as resolve2 } from "node:path";
class DiffTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiffTargetError";
  }
}

class GitError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "GitError";
    this.code = code ?? undefined;
  }
}
var MAX_POST_BYTES = 1e7;
var LIST_MAX_BUFFER = 256 * 1024 * 1024;
var GIT_TIMEOUT_MS = 120000;
var REQUEST_TIMEOUT_MS = 15000;
var MAX_ATTEMPTS = 4;
var PATCH_CONCURRENCY = 4;
var SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
var ENV_GLOBS = ["**/.env*", "**/.env*/**", "**/*.env"];
var WRITE = ["-c", "core.splitIndex=false"];
var FROM = "pi-humanlayer";
var DIFF = ["diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
function git2(cwd, args, opts = {}) {
  const { env, signal, maxBuffer = LIST_MAX_BUFFER } = opts;
  return new Promise((done, fail) => {
    execFile2("git", args, { cwd, env, signal, maxBuffer, timeout: GIT_TIMEOUT_MS, encoding: "buffer" }, (err, stdout, stderr) => {
      if (!err)
        return done(stdout);
      const name = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c");
      const detail = stderr.toString("utf8").trim().split(`
`).at(-1) || err.message;
      fail(new GitError(`git ${name}: ${detail}`, err.code));
    });
  });
}
async function isCommit(cwd, sha, signal) {
  if (!SHA.test(sha))
    return false;
  try {
    await git2(cwd, ["rev-parse", "--verify", "-q", `${sha}^{commit}`], { signal });
    return true;
  } catch (err) {
    if (signal?.aborted)
      throw err;
    return false;
  }
}
var NO_STATS = { additions: 0, deletions: 0, binary: false };
async function mapLimit(items, limit, fn) {
  const out = [];
  const queue = items.entries();
  const worker = async () => {
    for (const [i, item] of queue)
      out[i] = await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
function compact(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}
async function buildDiff(target, opts = {}) {
  const { gitRoot, baseSha, taskId, repoId, sessionId } = target;
  const { signal, maxPatchBytes = MAX_TASK_DIFF_PATCH_BYTES } = opts;
  if (!repoId || repoId.includes(":"))
    throw new DiffTargetError(`repo id ${JSON.stringify(repoId)} is empty or has a ":"`);
  if (!await isCommit(gitRoot, baseSha, signal)) {
    throw new DiffTargetError(`diff base ${JSON.stringify(baseSha)} is not a commit in ${gitRoot}`);
  }
  const paths = await git2(gitRoot, ["rev-parse", "--git-path", "index", "--git-path", "objects"], { signal });
  const [indexFile = "", objectsDir = ""] = paths.toString("utf8").trim().split(`
`).map((line) => resolve2(gitRoot, line));
  const tmp = await mkdtemp(join6(tmpdir(), "pi-hl-diff-"));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join6(tmp, "index"),
      GIT_OBJECT_DIRECTORY: join6(tmp, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsDir.includes(delimiter) ? JSON.stringify(objectsDir) : objectsDir,
      GIT_TERMINAL_PROMPT: "0"
    };
    await mkdir4(env.GIT_OBJECT_DIRECTORY);
    const run = (args, maxBuffer) => git2(gitRoot, args, { env, signal, maxBuffer });
    const withSparse = (args) => run(args).catch((err) => {
      if (!(err instanceof GitError) || err.code !== 129)
        throw err;
      return run(args.filter((arg) => arg !== "--sparse"));
    });
    const copied = await cp(indexFile, env.GIT_INDEX_FILE, { preserveTimestamps: true }).then(() => true, (err) => {
      if (err.code !== "ENOENT")
        throw err;
      return false;
    });
    if (!copied)
      await run([...WRITE, "read-tree", baseSha]);
    const excludes = [...ENV_GLOBS, "**/.humanlayer/**"].map((glob) => `:(exclude,glob)${glob}`);
    await withSparse([...WRITE, "add", "--all", "--sparse", "--", ".", ...excludes]);
    const envSpecs = ENV_GLOBS.map((glob) => `:(glob)${glob}`);
    await withSparse([
      ...WRITE,
      "rm",
      "-r",
      "-f",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--sparse",
      "--",
      ...envSpecs
    ]);
    const [nameStatus, numstat] = await Promise.all([
      run([...DIFF, "-z", "--name-status", baseSha]),
      run([...DIFF, "-z", "--numstat", baseSha])
    ]);
    const stats = parseNumstat(numstat.toString("utf8"));
    const changes = parseNameStatus(nameStatus.toString("utf8")).filter((c) => !isPrivateDiffPath(c.path) && (c.prevPath === undefined || !isPrivateDiffPath(c.prevPath)));
    const updatedAt = new Date().toISOString();
    const rows = await mapLimit(changes, PATCH_CONCURRENCY, async (change) => {
      const specs = change.prevPath === undefined ? [change.path] : [change.prevPath, change.path];
      const args = [
        "--literal-pathspecs",
        ...DIFF,
        "--binary",
        "--full-index",
        "--src-prefix=a/",
        "--dst-prefix=b/"
      ];
      const patch = await run([...args, baseSha, "--", ...specs], maxPatchBytes).then((out) => out.toString("utf8"), (err) => {
        if (err instanceof GitError && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return;
        throw err;
      });
      const byteLength = patch === undefined ? undefined : Buffer.byteLength(patch);
      let patchRow;
      if (patch !== undefined && patchFits(patch, maxPatchBytes)) {
        const patchHash = sha256Hex(patch);
        patchRow = {
          id: patchHash,
          taskId,
          repoId,
          sessionId,
          patchHash,
          patch,
          byteLength: Buffer.byteLength(patch),
          updatedAt
        };
      }
      const { additions, deletions, binary } = stats.get(change.path) ?? NO_STATS;
      const file = compact({
        id: `${taskId}:${repoId}:${change.path}`,
        taskId,
        repoId,
        repoDisplayName: repoId,
        sessionId,
        path: change.path,
        prevPath: change.prevPath,
        changeType: change.changeType,
        additions,
        deletions,
        binary,
        generated: false,
        patchHash: patchRow?.patchHash,
        patchByteLength: byteLength,
        patchOmittedReason: patchRow ? undefined : "too_large",
        updatedAt
      });
      return { file, patchRow };
    });
    return { files: rows.map((r) => r.file), patches: rows.flatMap((r) => r.patchRow ? [r.patchRow] : []) };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
function errorKind(err) {
  if (err instanceof LoginRequiredError || err instanceof RpcError && err.status === 401)
    return "login-required";
  if (err instanceof DiffTargetError || err instanceof RpcError && !isTransient(err))
    return "stopped";
  return "transient";
}

class DiffSync {
  target;
  opts;
  abort = new AbortController;
  ready = new Set;
  empty = new Set;
  published;
  timer;
  current = Promise.resolve();
  running = false;
  pending = false;
  closed = false;
  stopped = false;
  token;
  reminted = false;
  reported;
  constructor(target, opts) {
    this.target = target;
    this.opts = opts;
    this.published = new Map(Object.entries(target.published));
  }
  touched() {
    if (this.closed || this.stopped || this.timer)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.opts.debounceMs ?? 1500);
    this.timer.unref();
  }
  async flush(ms) {
    this.clearTimer();
    if (this.closed || this.stopped)
      return;
    await Promise.race([this.kick(), sleepUnref(ms)]);
  }
  close() {
    this.closed = true;
    this.clearTimer();
    this.abort.abort();
  }
  clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  kick() {
    this.pending = true;
    if (!this.running)
      this.current = this.loop().catch((err) => this.log(`diffs: ${errorMessage(err)}`));
    return this.current;
  }
  async loop() {
    this.running = true;
    try {
      while (this.pending && !this.closed && !this.stopped) {
        this.pending = false;
        await this.run();
      }
    } finally {
      this.running = false;
    }
  }
  async run() {
    this.token = undefined;
    this.reminted = false;
    try {
      const built = await buildDiff(this.target, {
        maxPatchBytes: this.opts.maxPatchBytes,
        signal: this.abort.signal
      });
      await this.ensure("diff-patches");
      await this.ensure("diff-files");
      const todo = this.plan(built);
      if (todo.patches.length + todo.files.length + todo.deletes.length > 0)
        await this.publish(todo);
      this.reported = undefined;
    } catch (err) {
      if (this.closed)
        return;
      const kind = errorKind(err);
      if (kind === "stopped") {
        this.stopped = true;
        this.clearTimer();
      }
      this.report(kind, errorMessage(err));
    }
  }
  plan(built) {
    const freshPatches = this.empty.has("diff-patches");
    const freshFiles = this.empty.has("diff-files");
    const patchRows = new Map(built.patches.map((row) => [row.patchHash, row]));
    const patches = new Map;
    const files2 = [];
    const next = new Map;
    for (const file of built.files) {
      const before = this.published.get(file.path);
      const rowHash = sha256Hex(JSON.stringify({ ...file, updatedAt: undefined }));
      next.set(file.path, file.patchHash === undefined ? { rowHash } : { patchHash: file.patchHash, rowHash });
      const patch = file.patchHash === undefined ? undefined : patchRows.get(file.patchHash);
      if (patch && (freshPatches || before?.patchHash !== patch.patchHash))
        patches.set(patch.patchHash, patch);
      if (freshFiles || before?.rowHash !== rowHash)
        files2.push(file);
    }
    const deletes = freshFiles ? [] : [...this.published.keys()].filter((path) => !next.has(path));
    return { patches: [...patches.values()], files: files2, deletes, next };
  }
  async ensure(stream) {
    if (this.ready.has(stream))
      return;
    if (await this.send("HEAD", stream) === 404 && await this.send("PUT", stream) === 201)
      this.empty.add(stream);
    this.ready.add(stream);
  }
  async publish(todo) {
    const { taskId, repoId } = this.target;
    const at = new Date().toISOString();
    const max = this.opts.maxPostBytes ?? MAX_POST_BYTES;
    const patches = todo.patches.map((row) => diffStreamMessage("task-diff-patch", row.id, "upsert", at, FROM, row));
    const files2 = [
      ...todo.files.map((row) => diffStreamMessage("task-diff-file", row.id, "upsert", at, FROM, row)),
      ...todo.deletes.map((path) => diffStreamMessage("task-diff-file", diffFileRowId(taskId, repoId, path), "delete", at, FROM))
    ];
    for (const body of messageBatches(patches, max))
      await this.send("POST", "diff-patches", body);
    for (const body of messageBatches(files2, max))
      await this.send("POST", "diff-files", body);
    this.published = todo.next;
    this.empty.clear();
    this.log(`diffs: published ${todo.files.length} files, ${todo.patches.length} patches, ${todo.deletes.length} deletes`);
    try {
      this.opts.onPublished(Object.fromEntries(todo.next));
    } catch (err) {
      this.log(`diffs: onPublished: ${errorMessage(err)}`);
    }
  }
  async send(method, stream, body) {
    let backoffMs2 = this.opts.retryBaseMs ?? 500;
    for (let attempt = 1;; attempt++) {
      try {
        return await this.request(method, stream, body);
      } catch (err) {
        if (this.closed)
          throw err;
        const status = err instanceof RpcError ? err.status : 0;
        if ((status === 401 || status === 403) && !this.reminted) {
          this.reminted = true;
          this.token = await this.opts.remintDaemonToken().catch((e) => {
            throw new LoginRequiredError(`daemon token re-mint failed: ${errorMessage(e)}`);
          });
          continue;
        }
        if (!isTransient(err) || attempt >= MAX_ATTEMPTS)
          throw err;
        this.log(`diffs: ${errorMessage(err)}; retry in ${backoffMs2} ms`);
        await sleepUnref(backoffMs2);
        backoffMs2 *= 2;
      }
    }
  }
  async request(method, stream, body) {
    this.token ??= await this.opts.daemonToken();
    const { syncUrl, orgId, taskId } = this.target;
    const url = `${syncUrl.replace(/\/+$/, "")}/v2/streams/organizations/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(taskId)}/${stream}`;
    const headers = new Headers({ "x-daemon-authorization": this.token });
    if (method !== "HEAD")
      headers.set("content-type", "application/json");
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
    const text2 = await res.text();
    if (res.ok || method === "HEAD" && res.status === 404 || method === "PUT" && res.status === 409)
      return res.status;
    throw new RpcError(`${method} ${stream}: HTTP ${res.status}${text2 ? ` ${text2.slice(0, 200)}` : ""}`, res.status, undefined);
  }
  report(kind, message) {
    this.log(`diffs: ${kind}: ${message}`);
    if (this.reported === kind)
      return;
    this.reported = kind;
    try {
      this.opts.onError?.(kind, message);
    } catch {}
  }
  log(line) {
    try {
      this.opts.log?.(line);
    } catch {}
  }
}
// apps/riptide-pi-extension/src/diffs.ts
function diffLane(host) {
  const b = host.binding;
  if (b.taskMode !== "ensure" || !b.git?.headSha || !b.orgId)
    return;
  const sync3 = new DiffSync({
    syncUrl: getChannelConfig(b.channel).sync,
    orgId: b.orgId,
    taskId: host.taskId,
    sessionId: host.sessionId,
    gitRoot: b.git.root,
    baseSha: b.git.headSha,
    repoId: basename4(b.git.root),
    published: b.diffPublished ?? {}
  }, {
    daemonToken: () => daemonToken(b.channel, host.signal),
    remintDaemonToken: () => remintDaemonToken(b.channel, host.signal),
    onPublished: (published) => {
      b.diffPublished = published;
      host.save();
    },
    onError: (kind, message) => {
      if (kind !== "transient")
        host.warn(`diffs:${kind}`, `HumanLayer: task diff ${kind}: ${message}`);
    },
    log
  });
  sync3.touched();
  return sync3;
}

// apps/riptide-pi-extension/src/heartbeat.ts
import { hostname } from "node:os";

// apps/riptide-pi-extension/src/loop.ts
function loopLane(host, spec) {
  const stop = new AbortController;
  const signal = AbortSignal.any([host.signal, stop.signal]);
  run(spec, signal);
  return { close: () => stop.abort() };
}
async function run(spec, signal) {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await spec.step(signal);
      failures = 0;
    } catch (err) {
      if (signal.aborted)
        return;
      if (spec.stopOn.includes(classifyRpcError(err, "daemon").kind)) {
        log(`${spec.name} stopped: ${errorMessage(err)}`);
        return;
      }
      if (failures === 0)
        log(`${spec.name}: ${errorMessage(err)}`);
      spec.onFailure?.(++failures);
    }
    const ms = spec.pauseMs(failures);
    if (ms > 0)
      await sleepUnref(ms, signal);
  }
}

// apps/riptide-pi-extension/src/heartbeat.ts
var WARN_AFTER = 3;
function heartbeatLane(host) {
  const { channel, hostId: hostId2 } = host.binding;
  const everyMs = heartbeatMs();
  const beat = {
    hostId: hostId2,
    hostName: hostname(),
    capabilities: ["attachedSessionsOnly", "agent:pi"],
    canSelfUpdate: false
  };
  return loopLane(host, {
    name: "heartbeat",
    step: async (signal) => {
      await daemonCall(channel, "hosts/heartbeat", beat, signal);
    },
    pauseMs: () => everyMs,
    stopOn: ["stop-all", "stop-binding"],
    onFailure: (failures) => {
      if (failures === WARN_AFTER)
        host.warn("heartbeat", "HumanLayer: could not reach the cloud, so the web app shows this host as offline");
    }
  });
}

// apps/riptide-pi-extension/src/outbox.ts
class Outbox2 extends Outbox {
  constructor(opts) {
    super({ log, ...opts });
  }
}

// apps/riptide-pi-extension/src/inbox.ts
function inboxLane(host) {
  if (!host.web)
    return;
  reportSkills(host, host.web.skills());
  const inbox2 = new Inbox(host, host.web);
  return loopLane(host, {
    name: "inbox",
    step: (signal) => withDaemonToken(host.binding.channel, signal, (token) => inbox2.poll(token, signal)),
    pauseMs: (failures) => failures === 0 ? 0 : backoffMs(host.backoff, failures),
    stopOn: ["stop-all", "stop-binding", "skip"]
  });
}
async function reportSkills(host, skills) {
  const { channel, hostId: hostId2 } = host.binding;
  const body = { hostId: hostId2, agent: codingAgent(), workspacePath: host.cwd, commands: [], skills: skills.map(agentSkill) };
  try {
    await daemonCall(channel, "agentCommands/report", body, host.signal);
  } catch (err) {
    if (!host.signal.aborted)
      log(`skills report: ${errorMessage(err)}`);
  }
}
function agentSkill(c) {
  const skill = {
    name: c.name,
    scope: c.sourceInfo.scope === "temporary" ? "plugin" : c.sourceInfo.scope
  };
  if (c.description)
    skill.description = c.description;
  return skill;
}

class Inbox {
  host;
  web;
  shape;
  constructor(host, web) {
    this.host = host;
    this.web = web;
    const b = host.binding;
    this.shape = new ShapeReader({ url: `${getChannelConfig(b.channel).sync}/v1/sessions/${b.hostId}` });
  }
  async poll(token, signal) {
    for (const change of await this.shape.poll({ "x-daemon-authorization": token }, signal)) {
      if (change.initial || change.value.id !== this.host.sessionId)
        continue;
      const command = sessionCommand(change);
      if (command?.kind === "continue" && command.prompt)
        this.web.resume(command.prompt);
      else if (command?.kind === "interrupt")
        this.web.interrupt();
    }
  }
}

// apps/riptide-pi-extension/src/lane.ts
class Lanes {
  factories;
  running = [];
  binding;
  constructor(factories) {
    this.factories = factories;
  }
  get for() {
    return this.binding;
  }
  start(host) {
    this.close();
    this.binding = host.binding;
    for (const make of this.factories) {
      const lane = guard("lane", () => make(host));
      if (lane)
        this.running.push(lane);
    }
  }
  touched(t) {
    for (const lane of this.running)
      guard("touched", () => lane.touched?.(t));
  }
  async flush(end) {
    const one = async (lane) => lane.flush?.(Math.max(0, end - Date.now()));
    await Promise.all(this.running.map((lane) => one(lane).catch((err) => log(`flush: ${errorMessage(err)}`))));
  }
  close() {
    for (const lane of this.running)
      guard("close", () => lane.close());
    this.running = [];
    this.binding = undefined;
  }
}

// apps/riptide-pi-extension/src/mapper.ts
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute2, join as join7, resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// packages/session-sdk-tools/src/tools.ts
function formatThread(comment, replies) {
  const lines = [`<comment id="${comment.truncatedId}">`];
  if (comment.previousBlockText || comment.quotedText || comment.nextBlockText) {
    for (const line of comment.previousBlockText?.split(`
`) ?? [])
      lines.push(`  | ${line}`);
    for (const line of comment.quotedText?.split(`
`) ?? [])
      lines.push(`> | ${line}`);
    for (const line of comment.nextBlockText?.split(`
`) ?? [])
      lines.push(`  | ${line}`);
    lines.push("");
  }
  lines.push(`${comment.userName}${comment.isResolved ? " [RESOLVED]" : ""}: ${comment.contentText}`);
  for (const reply of replies.get(comment.id) ?? []) {
    lines.push(`  ${reply.userName}${reply.isResolved ? " [RESOLVED]" : ""}: ${reply.contentText}`);
  }
  lines.push("</comment>");
  return lines.join(`
`);
}
function formatArtifactComments(filename, comments, offset, limit) {
  const page = comments.slice(offset, offset + limit);
  if (page.length === 0)
    return `No comments found on ${filename}`;
  const replies = new Map;
  for (const c of page) {
    if (!c.replyToCommentId)
      continue;
    const list = replies.get(c.replyToCommentId) ?? [];
    list.push(c);
    replies.set(c.replyToCommentId, list);
  }
  const threads = page.filter((c) => !c.replyToCommentId).map((c) => formatThread(c, replies));
  const result = `<comments for="${filename}">
${threads.join(`

`)}
</comments>`;
  const remaining = Math.max(0, comments.length - offset - page.length);
  return remaining > 0 ? `${result}
(${remaining} additional comments not returned)` : result;
}
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function formatDiffEntry(tag, c) {
  const author = c.createdByAgent ? `${c.createdByUserId}'s agent` : c.createdByUserId;
  const text2 = c.isDeleted ? "Comment deleted" : c.contentText;
  return `  <${tag} id="${c.truncatedId}" author="${escapeXml(author)}">${escapeXml(text2)}</${tag}>`;
}
function formatDiffComments(threads, offset, limit) {
  const page = threads.slice(offset, offset + limit);
  if (page.length === 0)
    return "No diff comments found for this task";
  const blocks = page.map((t) => {
    const a = t.anchor;
    return [
      `<diff_comment id="${t.root.truncatedId}" repo="${escapeXml(a.repoId)}" path="${escapeXml(a.path)}" patch_hash="${escapeXml(a.patchHash)}" start_side="${a.start.side}" start_line="${a.start.line}" end_side="${a.end.side}" end_line="${a.end.line}" resolved="${t.isResolved}">`,
      formatDiffEntry("comment", t.root),
      ...t.replies.map((r) => formatDiffEntry("reply", r)),
      "</diff_comment>"
    ].join(`
`);
  });
  const result = `<diff_comments>
${blocks.join(`
`)}
</diff_comments>`;
  const remaining = Math.max(0, threads.length - offset - page.length);
  return remaining > 0 ? `${result}
(${remaining} additional threads not returned)` : result;
}
function formatUpdate(result) {
  const messages = [];
  if (result.updated.length > 0)
    messages.push(`Updated ${result.updated.length} comment(s)`);
  if (result.failed.length > 0) {
    messages.push(`Failed: ${result.failed.map((f) => `${f.truncatedId}: ${f.reason}`).join(", ")}`);
  }
  return messages.join(". ") || "No changes made";
}
function validArtifacts(err) {
  if (!(err instanceof RpcError) || typeof err.data !== "object" || err.data === null)
    return;
  const list = err.data.validArtifacts;
  return Array.isArray(list) ? list.map(String) : undefined;
}
function tool(description, params, run2) {
  return { description, params, run: (p, taskId, call) => run2(p, taskId, call) };
}
var DIFF_SUFFIX = {
  minLength: 8,
  maxLength: 12,
  pattern: "^[0-9a-fA-F]+$",
  description: "Unique 8-12 character right-hand UUID suffix from get_diff_comments"
};
var paging = (what) => ({
  limit: { type: "integer", minimum: 1, optional: true, description: `Max ${what} to return (default: 20)` },
  offset: { type: "integer", minimum: 0, optional: true, description: `Number of ${what} to skip (default: 0)` }
});
function requireChange(p) {
  if (p.resolved === undefined && p.deleted === undefined) {
    throw new Error("At least one of resolved or deleted must be provided");
  }
}
var TOOLS = {
  get_artifact_comments: tool("Get all comments on an artifact (plan.md, research.md, etc). Returns threaded comments in XML format with truncated IDs for referencing in update/reply tools.", {
    artifact_filename: {
      type: "string",
      description: 'Filename of the artifact, e.g. "plan.md", "research.md"'
    },
    include_resolved: {
      type: "boolean",
      optional: true,
      description: "Include resolved comments (default: true)"
    },
    ...paging("comments")
  }, async (p, taskId, call) => {
    const out = await call("comments/get", {
      taskId,
      artifactFilename: p.artifact_filename,
      includeResolved: p.include_resolved ?? true
    });
    return formatArtifactComments(out.artifactFilename, out.comments, p.offset ?? 0, p.limit ?? 20);
  }),
  update_artifact_comments: tool("Update comments on an artifact - mark as resolved or deleted. Use truncated IDs from get_artifact_comments.", {
    artifact_filename: { type: "string", description: 'Filename of the artifact, e.g. "plan.md"' },
    comment_ids: { type: "strings", minItems: 1, description: "Truncated comment IDs (last 12 chars)" },
    resolved: { type: "boolean", optional: true, description: "Set resolved state for all specified comments" },
    deleted: { type: "boolean", optional: true, description: "Set deleted state for all specified comments" }
  }, async (p, taskId, call) => {
    requireChange(p);
    const body = { taskId, artifactFilename: p.artifact_filename, truncatedCommentIds: p.comment_ids };
    return formatUpdate(await call("comments/update", { ...body, resolved: p.resolved, deleted: p.deleted }));
  }),
  reply_to_artifact_comment: tool("Reply to a comment on an artifact. Use truncated ID from get_artifact_comments.", {
    artifact_filename: { type: "string", description: 'Filename of the artifact, e.g. "plan.md"' },
    comment_id: { type: "string", description: "Truncated comment ID to reply to" },
    content: { type: "string", minLength: 1, description: "Reply text content (markdown supported)" }
  }, async (p, taskId, call) => {
    const out = await call("comments/reply", {
      taskId,
      artifactFilename: p.artifact_filename,
      truncatedCommentId: p.comment_id,
      contentText: p.content
    });
    return `Reply added (id: ${out.commentId.slice(-12)})`;
  }),
  get_diff_comments: tool("Get ordered diff comment threads for the current task, including code anchors and exact short IDs for reply and update tools.", {
    include_resolved: {
      type: "boolean",
      optional: true,
      description: "Include resolved threads (default: false)"
    },
    ...paging("threads")
  }, async (p, taskId, call) => {
    const out = await call("diffComments/get", { taskId, includeResolved: p.include_resolved ?? false });
    return formatDiffComments(out.comments, p.offset ?? 0, p.limit ?? 20);
  }),
  reply_to_diff_comment: tool("Reply to a diff comment thread in the current task. The reply is added to the root thread and reopens it.", {
    thread_id: {
      type: "string",
      ...DIFF_SUFFIX,
      description: "Root or reply ID suffix for the thread to reply to"
    },
    content: { type: "string", minLength: 1, description: "Reply text content (Markdown supported)" }
  }, async (p, taskId, call) => {
    const out = await call("diffComments/reply", {
      taskId,
      truncatedCommentId: p.thread_id,
      contentText: p.content.trim()
    });
    return `Reply added (id: ${out.commentId.slice(-12)})`;
  }),
  update_diff_comments: tool("Resolve, reopen, or soft-delete diff comments in the current task. Resolve a thread only when the user asks you to resolve it or feedback delivery used Send & Resolve. Never resolve a thread just because you replied or changed code. Deletion is limited to comments authored by the driving user.", {
    comment_ids: {
      type: "strings",
      minItems: 1,
      items: DIFF_SUFFIX,
      description: "Comment or thread ID suffixes to update"
    },
    resolved: {
      type: "boolean",
      optional: true,
      description: "Resolve (true) or reopen (false) each matched thread"
    },
    deleted: {
      type: "true",
      optional: true,
      description: "Soft-delete matched comments authored by the driving user"
    }
  }, async (p, taskId, call) => {
    requireChange(p);
    const body = { taskId, truncatedCommentIds: p.comment_ids };
    return formatUpdate(await call("diffComments/update", { ...body, resolved: p.resolved, deleted: p.deleted }));
  }),
  library_researcher: tool("Research documentation for a library or package to answer questions about usage, APIs, and best practices. Use this when you need up-to-date information about a library or dependency.", {
    question: {
      type: "string",
      description: "The specific question you want answered about the library. Be detailed and specific. " + "Good: 'How do I configure authentication middleware in Express.js 5?' " + "Bad: 'express auth'"
    },
    package_name: {
      type: "string",
      description: "The exact name of the npm package, PyPI package, or library to research. " + "Use the canonical package name as it appears in the package registry if possible. " + "Examples: 'react', 'express', 'drizzle-orm', '@tanstack/react-query'"
    },
    language: {
      type: "string",
      description: "The programming language(s) in question. E.g. typescript, python, elixir, java, javascript, C, c++, etc"
    }
  }, async (p, _taskId, call) => {
    const out = await call("agents/research", {
      question: p.question,
      packageName: p.package_name,
      language: p.language
    });
    return out.response;
  })
};
var HUMANLAYER_TOOLS = Object.keys(TOOLS);
function toolFailure(name, err) {
  const artifacts = validArtifacts(err);
  if (artifacts)
    return new Error(`Artifact not found. Valid artifacts: ${artifacts.join(", ")}`);
  if (err instanceof RpcError)
    return new Error(`${name} failed: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}
var BIND_WAIT_MS = 15000;
async function settledTarget(target, signal) {
  const deadline = Date.now() + BIND_WAIT_MS;
  let t = target();
  while ("pending" in t && t.pending && Date.now() < deadline && !signal?.aborted) {
    await sleepUnref(100);
    t = target();
  }
  return t;
}
async function runTool(name, params, target, daemonCall2, signal) {
  const t = await settledTarget(target, signal);
  if ("reason" in t)
    throw new Error(t.reason);
  const call = (path, body) => daemonCall2(t.channel, path, body, signal);
  try {
    return await TOOLS[name].run(params, t.taskId, call);
  } catch (err) {
    throw toolFailure(name, err);
  }
}
// apps/riptide-pi-extension/src/mapper.ts
var ABORTED = /^(this operation|the operation|request) was aborted\.?$/i;
function createMapperState(piSessionId, cwd) {
  return {
    piSessionId,
    cwd,
    skipFirstUser: false,
    webPrompts: [],
    createdFiles: new Map,
    toolCalls: new Map,
    compactionTrigger: "auto"
  };
}
function isWebEcho(prompt, content) {
  if (content === prompt)
    return true;
  const skill = /^\/skill:(\S+) *([\s\S]*)$/.exec(prompt);
  if (!skill)
    return false;
  const args = skill[2]?.trim();
  return content.startsWith(`<skill name="${skill[1]}" `) && (!args || content.endsWith(`

${args}`));
}
function mapEntry(entry, state) {
  const out = { events: [] };
  const emit = (fields) => {
    const event = makeEvent(state, `${entry.id}:${out.events.length}`, fields);
    out.events.push(event);
    return event;
  };
  if (entry.type === "compaction") {
    const trigger = state.compactionTrigger;
    const boundary = emit(systemFields({ kind: "context_compaction", trigger, preTokens: entry.tokensBefore }));
    const summary = cutUtf8(entry.summary, EVENT_LIMITS.hiddenBytes);
    emit(systemFields({ kind: "context_compaction_summary", boundaryEventId: boundary.eventId, summary }));
    return out;
  }
  if (entry.type !== "message") {
    emit(hiddenFields({ kind: `pi_${entry.type}`, ...entry }));
    return out;
  }
  const msg = entry.message;
  switch (msg.role) {
    case "user": {
      const content = joinParts(msg.content);
      const web = state.webPrompts.findIndex((prompt) => isWebEcho(prompt, content));
      if (state.skipFirstUser)
        state.skipFirstUser = false;
      else if (web !== -1)
        state.webPrompts.splice(web, 1);
      else
        emit({ eventType: "message", role: "user", content });
      break;
    }
    case "assistant": {
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim())
            emit({ eventType: "message", role: "assistant", content: block.text });
        } else if (block.type === "thinking") {
          if (block.thinking.trim() && !block.redacted) {
            emit({ eventType: "thinking", role: "assistant", content: block.thinking });
          }
        } else if (block.type === "toolCall") {
          state.toolCalls.set(block.id, { name: block.name, args: block.arguments });
          const [toolName, toolInputJson] = shapeToolCall(block.name, block.arguments, state.cwd);
          emit({ eventType: "tool_call", role: "assistant", toolCallId: block.id, toolName, toolInputJson });
        }
      }
      if (msg.stopReason === "error" && msg.errorMessage) {
        out.errorMessage = msg.errorMessage;
        if (!ABORTED.test(msg.errorMessage))
          emit({ eventType: "message", role: "assistant", content: `**Error:** ${msg.errorMessage}` });
      }
      const u = msg.usage;
      const [input, output, cacheRead, cacheWrite] = [
        int(u.input),
        int(u.output),
        int(u.cacheRead),
        int(u.cacheWrite)
      ];
      if (input + output + cacheRead + cacheWrite === 0)
        break;
      const first = out.events[0];
      if (first) {
        first.inputTokens = input + cacheRead + cacheWrite;
        first.outputTokens = output;
      }
      out.usage = {
        usageReportKey: entry.id,
        contextWindowTokens: input + cacheRead + cacheWrite + output,
        totalCostUsd: u.cost.total || 0,
        modelUsage: {
          [msg.model]: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite
          }
        }
      };
      break;
    }
    case "toolResult": {
      const call = state.toolCalls.get(msg.toolCallId);
      state.toolCalls.delete(msg.toolCallId);
      let text2 = joinParts(msg.content);
      if (msg.toolName === "bash") {
        if (msg.isError)
          text2 = `Exit code ${lastExitCode(text2) ?? 1}
${text2}`;
        out.touched = {};
      } else if ((msg.toolName === "write" || msg.toolName === "edit") && !msg.isError) {
        const created = msg.toolName === "write" ? state.createdFiles.get(msg.toolCallId) : undefined;
        if (created)
          text2 = `File created successfully at: ${created}
${text2}`;
        const path = created ?? absolute(call?.args.path, state.cwd);
        out.touched = path ? { path } : {};
      }
      emit({ eventType: "tool_result", role: "user", toolResultForId: msg.toolCallId, toolResultContent: text2 });
      break;
    }
    case "bashExecution": {
      const toolCallId = `pi-bash-${entry.id}`;
      const toolInputJson = { command: msg.command };
      emit({ eventType: "tool_call", role: "assistant", toolCallId, toolName: "bash", toolInputJson });
      const code = msg.cancelled ? 1 : msg.exitCode;
      const toolResultContent = `${code ? `Exit code ${code}
` : ""}${msg.output}`;
      emit({ eventType: "tool_result", role: "user", toolResultForId: toolCallId, toolResultContent });
      out.touched = {};
      break;
    }
    default:
      emit(hiddenFields({ kind: `pi_${msg.role}`, ...entry }));
  }
  return out;
}
function systemEvent(state, idKey, payload) {
  return makeEvent(state, idKey, hiddenFields(payload));
}
function makeEvent(state, key, fields) {
  return fitEvent({
    eventId: eventUuid(`${state.piSessionId}:${key}`),
    codingAgentSessionId: state.piSessionId,
    codingAgentEventId: key,
    ...fields
  });
}
function joinParts(content) {
  if (typeof content === "string")
    return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join(`
`);
}
function lastExitCode(text2) {
  return [...text2.matchAll(/Command exited with code (-?\d+)/g)].at(-1)?.[1];
}
function int(n) {
  return Math.max(0, Math.round(n) || 0);
}
var HUMANLAYER_TOOL_NAMES = new Set(HUMANLAYER_TOOLS);
function shapeToolCall(name, args, cwd) {
  const input = { ...args };
  const { timeout: timeout2, path, edits } = input;
  if (name === "bash" && typeof timeout2 === "number") {
    input.timeout_ms = timeout2 * 1000;
    delete input.timeout;
  }
  if (name === "read" || name === "write" || name === "edit") {
    const filePath = absolute(path, cwd);
    if (filePath)
      input.file_path = filePath;
  }
  if (name === "edit" && Array.isArray(edits) && edits.length >= 2)
    return ["MultiEdit", input];
  if (name === "find")
    return ["Glob", input];
  if (name === "ls" && !path)
    input.path = ".";
  if (HUMANLAYER_TOOL_NAMES.has(name))
    return [`mcp__humanlayer__${name}`, input];
  return [name, input];
}
function absolute(path, cwd) {
  if (typeof path !== "string")
    return;
  try {
    return resolveToCwd(path, cwd);
  } catch {
    return;
  }
}
var UNICODE_SPACES = /[  -   　]/g;
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\"))
    return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  const drive = match?.[1];
  if (!drive)
    return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}
function normalizePath(input, toolPath) {
  let normalized = input;
  if (toolPath) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
    if (normalized.startsWith("@"))
      normalized = normalized.slice(1);
  }
  if (process.platform === "win32")
    normalized = normalizeWindowsShellPath(normalized);
  const home = homedir2();
  if (normalized === "~")
    return home;
  if (normalized.startsWith("~/") || process.platform === "win32" && normalized.startsWith("~\\")) {
    return join7(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized))
    return fileURLToPath(normalized);
  return normalized;
}
function resolveToCwd(filePath, cwd) {
  const normalized = normalizePath(filePath, true);
  return isAbsolute2(normalized) ? resolve3(normalized) : resolve3(normalizePath(cwd, false), normalized);
}

// apps/riptide-pi-extension/src/status.ts
function statusLine(s) {
  if (!s.signedIn)
    return "HumanLayer: /humanlayer login";
  if (s.problem)
    return `HumanLayer: ⚠ ${shorten(s.problem, 40)}`;
  if (s.off)
    return "HumanLayer: off";
  if (!s.task)
    return "HumanLayer: ready";
  const line = s.queued > 0 ? `HumanLayer: ${s.task} ↑${s.queued}` : `HumanLayer: ${s.task}`;
  return s.synced ? `${line} · ${shorten(s.synced, 30)}` : line;
}
function shorten(text2, max) {
  const chars = Array.from(text2.split(`
`)[0] ?? "");
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

class Display {
  ui;
  hasUI;
  seen = new Set;
  shown;
  closed = false;
  constructor(ctx) {
    this.ui = ctx.ui;
    this.hasUI = ctx.hasUI;
  }
  status(facts) {
    const text2 = statusLine(facts);
    if (this.closed || text2 === this.shown)
      return;
    this.shown = text2;
    this.ui.setStatus("humanlayer", text2);
  }
  notify(message, kind = "info") {
    if (this.closed)
      return;
    if (this.hasUI)
      this.ui.notify(message, kind);
    else
      console.error(message);
  }
  toast(message) {
    if (!this.closed && this.hasUI)
      this.ui.notify(message, "info");
  }
  notifyOnce(key, message, kind = "info", seen = this.seen) {
    if (this.closed || seen.has(key))
      return;
    seen.add(key);
    this.notify(message, kind);
  }
  close() {
    this.closed = true;
  }
}

// apps/riptide-pi-extension/src/capture.ts
var KEEPALIVE_MS = 4 * 60000;
var NESTED_TOUCHES = new Set(["write", "edit", "bash"]);
var announced = new Set;
var COMPACT_COMMAND = "/compact";

class Mirror {
  sm;
  display;
  cwd;
  flag;
  opts;
  driver;
  timer;
  dead = new WeakSet;
  channel;
  who = null;
  model;
  outbox;
  binding;
  state;
  pos = { n: 0, lastId: null };
  off = false;
  halted;
  attachTarget;
  active = false;
  outcome = "completed";
  lastStatus;
  runError;
  lastError;
  lastSendAt = Date.now();
  lastLeaf;
  saving = Promise.resolve();
  saveTimer;
  alive = true;
  closing;
  seq = 0;
  abort = new AbortController;
  lanes = new Lanes([artifactLane, diffLane, heartbeatLane, inboxLane]);
  synced;
  constructor(ctx, channel, flag, opts, driver) {
    this.sm = ctx.sessionManager;
    this.display = new Display(ctx);
    this.cwd = ctx.cwd;
    this.model = ctx.model;
    this.channel = channel;
    this.flag = flag;
    this.opts = opts;
    this.driver = driver;
    this.state = createMapperState(this.sm.getSessionId(), this.cwd);
    this.outbox = this.newOutbox();
    this.lastLeaf = this.sm.getLeafId();
    this.timer = setInterval(() => guard("tick", () => this.tick()), 1000);
    this.timer.unref();
  }
  static async start(ctx, flag, opts = {}, driver) {
    const [channel, settings] = await Promise.all([resolveChannel(), humanlayerSettings.load()]);
    const m = new Mirror(ctx, channel, flag, opts, driver);
    m.off = settings.defaultMirroring === "off";
    await m.authChanged().catch((err) => log(`start: ${errorMessage(err)}`));
    return m;
  }
  async authChanged() {
    if (!this.binding)
      this.channel = await resolveChannel();
    this.who = await identity(this.channel);
    if (!this.binding && this.who) {
      const saved = await loadBinding(this.channel, this.sm.getSessionId(), this.who);
      if (saved && !this.binding && this.alive)
        this.resume(saved);
    }
    this.refreshStatus();
  }
  resume(b) {
    this.adopt(b);
    this.off = !!b.off;
    log(`resuming ${b.cloudSessionId} at entry ${b.cursor.n}`);
    this.startLanes();
    this.sweep();
    if (!this.active)
      this.pushStatus("ready_for_input");
    this.announce(b);
  }
  adopt(b) {
    this.binding = b;
    this.pos = { n: b.cursor.n, lastId: b.cursor.lastId };
    this.state = createMapperState(b.piSessionId, this.cwd);
    this.state.skipFirstUser = !!b.cursor.skipFirstUser;
    this.lastStatus = undefined;
  }
  async beforeAgentStart(event, model) {
    this.model = model ?? this.model;
    this.runError = undefined;
    if (!this.binding && !this.off && !this.halted)
      await this.bind(event);
    this.sweep();
    return this.hint(event);
  }
  hint(event) {
    const b = this.binding;
    const text2 = b && !this.off && !this.halted ? artifactsHint2(this.cwd, b) : undefined;
    if (!text2)
      return;
    const options = event.systemPromptOptions;
    options.sections[HINT_SECTION] = text2;
    if (options.forceSystemPrompt === undefined)
      return;
    return { systemPrompt: `${event.systemPrompt}

<${HINT_SECTION}>
${text2}
</${HINT_SECTION}>` };
  }
  async bind(event) {
    this.channel = await resolveChannel();
    this.who = await identity(this.channel);
    if (!this.who)
      return this.refreshStatus();
    const id = this.sm.getSessionId();
    const [pick, git3, host] = await Promise.all([
      pickTask2(id, this.cwd, this.attachTarget, this.flag()),
      gitInfo(this.cwd),
      hostId(this.channel)
    ]);
    if (this.binding || this.off || this.halted || !this.alive)
      return;
    this.attachTarget = undefined;
    const model = this.model && { provider: this.model.provider, id: this.model.id };
    const title = sessionTitle(this.sm.getSessionName(), event.prompt);
    const prompt = promptText(event.prompt, event.images?.length ?? 0);
    const facts = { pick, hostId: host, title, prompt, cwd: this.cwd, model, git: git3 };
    const entries = this.sm.getEntries();
    const cursor = { n: entries.length, lastId: entries.at(-1)?.id ?? null, skipFirstUser: true };
    const b = newBinding({ channel: this.channel, piSessionId: id, cwd: this.cwd, pick, hostId: host, cursor, git: git3 });
    this.adopt(b);
    const fallback = pick.taskMode === "use" && pick.auto ? facts : undefined;
    this.push({ kind: "prepare", binding: b, body: prepareBody2(facts), fallback }, "api", true);
    this.pushStatus("running", { ...this.modelFields(), codingAgentSessionId: id });
    if (git3)
      this.pushCall({ path: "sessions/repositories/report", body: repositoriesReport(git3) });
    const parent = this.sm.getHeader()?.parentSession;
    if (parent) {
      const payload = { kind: "pi_fork", parentSessionFile: parent };
      this.pushEvent(systemEvent(this.state, `pi_fork:${b.createdAt}`, payload));
    }
    this.refreshStatus();
  }
  agentStart() {
    this.outcome = "completed";
    this.active = true;
    if (this.lastStatus !== "running")
      this.pushStatus("running");
    this.sweep();
  }
  messageEnd(event) {
    const msg = event.message;
    if (msg.role === "assistant") {
      this.outcome = msg.stopReason === "aborted" ? "aborted" : msg.stopReason === "error" ? "error" : "completed";
    }
    setImmediate(() => guard("sweep", () => this.sweep()));
  }
  agentEnd(aborted) {
    if (aborted)
      this.outcome = "aborted";
    this.sweep();
  }
  beforeSettle(outcome) {
    if (this.outcome !== "aborted")
      this.outcome = outcome;
  }
  agentSettled() {
    this.sweep();
    if (!this.active)
      return;
    this.active = false;
    this.state.createdFiles.clear();
    this.state.toolCalls.clear();
    if (this.outcome === "aborted")
      this.pushStatus("interrupted");
    else if (this.outcome === "error")
      this.pushStatus("failed", { errorMessage: this.runError });
    else
      this.pushStatus("ready_for_input");
  }
  compacting(on, reason) {
    if (on)
      this.state.compactionTrigger = reason === "manual" ? "manual" : "auto";
    else
      this.sweep();
    this.pushUpdate({ isCompacting: on });
  }
  modelSelect(model) {
    this.model = model;
    this.pushUpdate(this.modelFields());
    this.sweep();
  }
  async toolCall(event) {
    if (event.toolName !== "write" || !this.binding)
      return;
    const path = event.input.path;
    if (typeof path !== "string")
      return;
    const abs = resolveToCwd(path, this.cwd);
    if (!await access(abs).then(() => true, () => false))
      this.state.createdFiles.set(event.toolCallId, abs);
  }
  nestedToolEnd(event) {
    if (event.parentToolCallId && NESTED_TOUCHES.has(event.toolName))
      this.lanes.touched({});
  }
  sweep() {
    const b = this.binding;
    if (!b || this.halted || !this.alive)
      return;
    const entries = this.sm.getEntries();
    let n = this.pos.n;
    if (n > entries.length || n > 0 && entries[n - 1]?.id !== this.pos.lastId) {
      const i = entries.findIndex((e) => e.id === this.pos.lastId);
      n = i >= 0 ? i + 1 : entries.length;
      log(`entries moved: resuming at ${n} of ${entries.length}`);
    }
    if (n === this.pos.n && n === entries.length)
      return;
    if (!this.off && this.who)
      for (const entry of entries.slice(n))
        this.queueEntry(entry);
    this.pos = { n: entries.length, lastId: entries.at(-1)?.id ?? null };
    const cursor = { ...this.pos };
    if (this.state.skipFirstUser)
      cursor.skipFirstUser = true;
    this.push({ kind: "cursor", binding: b, cursor });
  }
  queueEntry(entry) {
    let mapped;
    try {
      mapped = mapEntry(entry, this.state);
    } catch (err) {
      log(`skipped entry ${entry.id}: ${errorMessage(err)}`);
      return;
    }
    for (const event of mapped.events)
      this.pushEvent(event);
    if (mapped.usage)
      this.pushUpdate({ ...mapped.usage, contextWindowLimit: this.contextWindow() }, false);
    if (mapped.errorMessage)
      this.runError = mapped.errorMessage;
    if (mapped.touched)
      this.lanes.touched(mapped.touched);
  }
  modelFields() {
    const id = this.model?.id;
    return { model: id, resolvedModel: id, contextWindowLimit: this.contextWindow() };
  }
  contextWindow() {
    return this.model?.contextWindow || undefined;
  }
  pushCall(call, keep = false) {
    const b = this.binding;
    if (!b || this.off || this.halted || !this.who)
      return false;
    this.push({ kind: "rpc", binding: b, ...call }, "daemon", keep);
    return true;
  }
  pushEvent(event) {
    this.pushCall({ path: "sessions/events/create", body: event });
  }
  pushUpdate(fields, keep = true) {
    return this.pushCall({ path: "sessions/update", body: fields }, keep);
  }
  pushStatus(status, extra = {}) {
    if (this.pushUpdate({ ...extra, status }))
      this.lastStatus = status;
  }
  push(job, plane = "daemon", keep = false) {
    const sizeBytes = "body" in job ? Buffer.byteLength(JSON.stringify(job.body)) : 64;
    this.outbox.push({ ...job, id: String(++this.seq), plane, sizeBytes, keep });
  }
  async send(item) {
    const b = item.binding;
    if (this.dead.has(b))
      return;
    if (item.kind === "prepare")
      return this.sendPrepare(item);
    if (item.kind === "cursor") {
      if (b !== this.binding)
        return;
      b.cursor = item.cursor;
      return this.saveSoon();
    }
    if (!b.cloudSessionId)
      return;
    await sendSessionCall(b.channel, item, b.cloudSessionId, this.abort.signal);
    this.lastSendAt = Date.now();
  }
  async sendPrepare(item) {
    const b = item.binding;
    const org = await daemonOrgId(b.channel, this.abort.signal);
    let out;
    try {
      out = await prepare2(b.channel, item.body, this.abort.signal);
    } catch (err) {
      if (err instanceof RpcError && err.status === 400 && item.body.codingAgent === "pi" && namesCodingAgent(err)) {
        log(`prepare rejected codingAgent pi (${err.message}); retrying as opencode`);
        item.body = { ...item.body, codingAgent: "opencode" };
        return this.sendPrepare(item);
      }
      if (!(err instanceof RpcError) || err.status !== 403 && err.status !== 404)
        throw err;
      if (!item.fallback)
        return this.prepareFailed(b, err);
      log(`task link ${b.taskSlug} failed (${err.status}); creating a task`);
      const pick = newTask2(b.piSessionId);
      item.body = prepareBody2({ ...item.fallback, pick });
      item.fallback = undefined;
      b.taskMode = "ensure";
      b.taskSlug = pick.slug;
      return this.sendPrepare(item);
    }
    if (this.dead.has(b))
      return;
    b.cloudSessionId = out.sessionId;
    b.taskId = out.taskId;
    b.userId = out.userId;
    b.orgId = org ?? this.who?.orgId;
    b.sessionUrl = `${getChannelConfig(b.channel).app}/sessions/${out.sessionId}`;
    this.lastSendAt = Date.now();
    this.saveNow();
    this.startLanes();
    this.announce(b);
    this.refreshStatus();
  }
  announce(b) {
    if (!b.cloudSessionId || this.off || this.halted)
      return;
    this.display.notifyOnce(b.cloudSessionId, `HumanLayer: mirroring to ${b.sessionUrl}`, "info", announced);
  }
  newOutbox() {
    return new Outbox2({
      send: (item) => this.send(item),
      onPause: () => this.refreshStatus(),
      onResume: () => this.refreshStatus(),
      onStopAll: (reason) => this.halt(reason),
      onStopBinding: (reason) => this.halt(reason),
      onSkip: (item, err) => {
        if (item.kind === "prepare")
          return this.prepareFailed(item.binding, err);
        this.lastError = errorMessage(err);
      },
      onDrop: (item) => log(`queue full: dropped ${item.kind === "rpc" ? item.path : item.kind}`),
      initialBackoffMs: this.opts.initialBackoffMs,
      maxBackoffMs: this.opts.maxBackoffMs
    });
  }
  prepareFailed(b, err) {
    this.dead.add(b);
    if (b !== this.binding)
      return;
    this.binding = undefined;
    const status = err instanceof RpcError ? err.status : undefined;
    const task = b.taskSlug ?? b.taskId;
    if (status === 404)
      this.halt(`task ${task} not found. Use /humanlayer attach <task> or /humanlayer attach new.`);
    else if (status === 403)
      this.halt(`no access to task ${task}`);
    else
      this.halt(`could not start the cloud session: ${errorMessage(err)}`);
  }
  halt(reason) {
    this.halted = reason;
    this.lastError = reason;
    log(`stopped: ${reason}`);
    if (this.binding && !this.binding.cloudSessionId) {
      this.dead.add(this.binding);
      this.binding = undefined;
    }
    this.closeLanes();
    this.display.notifyOnce(`halt:${reason}`, `HumanLayer: mirroring stopped: ${reason}`, "error");
    this.refreshStatus();
  }
  revive() {
    this.halted = undefined;
    if (!this.outbox.isStopped)
      return;
    this.outbox = this.newOutbox();
    if (this.binding)
      this.adopt(this.binding);
  }
  attach(target) {
    const b = this.binding;
    if (b?.cloudSessionId) {
      this.sweep();
      this.pushStatus("ready_for_input");
    } else if (b)
      this.dead.add(b);
    this.binding = undefined;
    this.closeLanes();
    this.attachTarget = target;
    this.off = false;
    this.revive();
    this.refreshStatus();
  }
  setOff() {
    if (this.off)
      return;
    const b = this.binding;
    if (b) {
      this.sweep();
      this.pushStatus("ready_for_input");
      b.off = true;
      this.saveNow();
    }
    this.off = true;
    this.closeLanes();
    this.refreshStatus();
  }
  setOn() {
    this.off = false;
    this.revive();
    if (this.binding) {
      delete this.binding.off;
      this.saveNow();
      if (this.active)
        this.pushStatus("running");
      this.startLanes();
    }
    this.refreshStatus();
  }
  startLanes() {
    const b = this.binding;
    if (!b?.cloudSessionId || !b.taskId || this.off || this.halted || !this.alive || this.lanes.for === b)
      return;
    this.synced = undefined;
    const driver = this.driver;
    const host = {
      binding: b,
      taskId: b.taskId,
      sessionId: b.cloudSessionId,
      cwd: this.cwd,
      signal: this.abort.signal,
      backoff: this.opts,
      save: () => {
        if (b === this.binding)
          this.saveSoon();
      },
      note: (file) => {
        if (this.lanes.for !== b)
          return;
        this.synced = file;
        this.refreshStatus();
      },
      warn: (key, message) => this.display.notifyOnce(key, message, "error"),
      web: driver && {
        resume: (prompt) => guard("web resume", () => this.webResume(b, prompt)),
        interrupt: () => guard("web interrupt", () => this.webInterrupt(b)),
        skills: () => driver.skills()
      }
    };
    this.lanes.start(host);
  }
  webResume(b, prompt) {
    const driver = this.driver;
    if (!driver || b !== this.binding || this.off)
      return;
    log(`web message for ${b.cloudSessionId} (${prompt.length} chars)`);
    if (prompt.trim() === COMPACT_COMMAND) {
      this.pushStatus(driver.isIdle() ? "ready_for_input" : "running");
      driver.compact();
      return;
    }
    this.pushStatus("running");
    this.state.webPrompts.push(prompt);
    driver.send(prompt);
    this.display.toast("HumanLayer: message from the web app");
  }
  webInterrupt(b) {
    const driver = this.driver;
    if (!driver || b !== this.binding || this.off)
      return;
    log(`web interrupt for ${b.cloudSessionId}`);
    if (driver.isIdle())
      this.pushStatus("interrupted");
    else
      driver.abort();
  }
  closeLanes() {
    this.lanes.close();
    this.synced = undefined;
  }
  linked() {
    return !!this.binding && !this.off && !this.halted;
  }
  toolTarget() {
    const b = this.binding;
    if (!b || this.off || this.halted) {
      return {
        reason: "This pi session is not linked to a HumanLayer task. Run /humanlayer attach <task> first."
      };
    }
    if (!b.taskId)
      return { reason: "HumanLayer is still linking this session to its task. Try again shortly.", pending: true };
    return { channel: b.channel, taskId: b.taskId };
  }
  info() {
    const b = this.binding;
    const task = b ? b.taskSlug ?? b.taskId : this.attachTarget;
    return {
      state: this.stateText(),
      task,
      url: b?.sessionUrl,
      queue: this.outbox.length,
      lastError: this.lastError
    };
  }
  stateText() {
    if (this.halted)
      return `stopped (${this.halted})`;
    if (!this.who)
      return "signed out";
    if (this.outbox.isPaused)
      return "paused (login required)";
    if (this.off)
      return "off";
    return this.binding ? "on" : "on (binds at the next prompt)";
  }
  tick() {
    const leaf = this.sm.getLeafId();
    if (leaf !== this.lastLeaf) {
      this.lastLeaf = leaf;
      this.sweep();
    }
    if (this.active && this.outbox.length === 0 && Date.now() - this.lastSendAt > KEEPALIVE_MS) {
      this.lastSendAt = Date.now();
      this.pushStatus("running");
    }
    this.refreshStatus();
  }
  refreshStatus() {
    if (!this.alive)
      return;
    const b = this.binding;
    this.display.status({
      signedIn: !!this.who,
      problem: this.halted ?? (this.outbox.isPaused ? "login required" : undefined),
      off: this.off,
      task: b ? b.taskSlug ?? b.taskId?.slice(0, 8) : undefined,
      queued: this.outbox.length,
      synced: this.synced
    });
  }
  saveSoon() {
    if (this.saveTimer)
      return;
    this.saveTimer = setTimeout(() => void this.saveNow(), 2000);
    this.saveTimer.unref();
  }
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const b = this.binding;
    if (b?.cloudSessionId) {
      this.saving = this.saving.then(() => saveBinding(b)).catch((err) => log(`save: ${errorMessage(err)}`));
    }
    return this.saving;
  }
  shutdown(waitForAgent = false) {
    return this.closing ??= this.flushAndClose(waitForAgent);
  }
  async flushAndClose(waitForAgent) {
    const ms = flushMs();
    const deadline = Date.now() + ms;
    const hold = setTimeout(() => {}, ms + 2000);
    try {
      this.sweep();
      const end = Math.min(deadline, Date.now() + 1000);
      while (this.active && (waitForAgent || this.state.toolCalls.size > 0) && Date.now() < end) {
        await sleepUnref(20);
        this.sweep();
      }
      if (this.active) {
        this.active = false;
        this.pushStatus("interrupted");
      }
      clearInterval(this.timer);
      await Promise.all([this.outbox.drain(Math.max(0, deadline - Date.now())), this.flushLanes(deadline)]);
      await this.saveNow();
      this.reportUnsent();
    } finally {
      this.alive = false;
      this.display.close();
      clearInterval(this.timer);
      this.outbox.close();
      this.closeLanes();
      this.abort.abort();
      clearTimeout(hold);
    }
  }
  reportUnsent() {
    const b = this.binding;
    if (!b || this.halted)
      return;
    if (!b.cloudSessionId)
      return this.prepareFailed(b, this.outbox.failure ?? "no answer in time");
    const n = this.outbox.items.filter((item) => item.kind === "rpc" && item.binding === b).length;
    if (n > 0)
      this.display.notifyOnce("unsent", `HumanLayer: ${n} updates not sent; run pi again with -c in this folder to send them.`, "error");
  }
  async flushLanes(end) {
    const pending = () => this.binding && !this.binding.cloudSessionId && !this.halted && !this.outbox.isPaused;
    while (pending() && Date.now() < end)
      await sleepUnref(50);
    await this.lanes.flush(end);
  }
}
function namesCodingAgent(err) {
  return /codingAgent/.test(`${err.message} ${JSON.stringify(err.data ?? null)}`);
}

// apps/riptide-pi-extension/src/login.ts
var { abortLogin, logout, pendingLogin, startDeviceLogin } = login2;

// apps/riptide-pi-extension/src/command.ts
var SUBCOMMANDS = ["login", "logout", "status", "open-session", "attach", "off", "on", "default"];
var LOGIN_WIDGET = "humanlayer-login";
var live2;
var liveUI = () => live2?.alive ? live2.ui : undefined;
function setLive(instance, ctx) {
  instance.ui = ctx.hasUI ? ctx.ui : undefined;
  live2 = instance;
  for (const channel of ALL_CHANNELS) {
    const waiting = pendingLogin(channel);
    if (instance.ui && waiting?.url && waiting.code)
      showLogin(instance.ui, channel, waiting.url, waiting.code);
  }
}
function showLogin(ui, channel, url, code) {
  ui.setWidget(LOGIN_WIDGET, [
    `HumanLayer login (${channel})`,
    `Open: ${url}`,
    `Code: ${code}`,
    "Run /humanlayer logout to cancel"
  ]);
}
function say(message, kind = "info") {
  const ui = liveUI();
  if (ui)
    ui.notify(message, kind);
  else
    console.error(message);
}
function output(ctx, message, kind = "info") {
  if (ctx.hasUI)
    ctx.ui.notify(message, kind);
  else
    console.error(message);
}
function loginUI(channel) {
  return {
    get hasUI() {
      return liveUI() !== undefined;
    },
    showCode(url, code) {
      const ui = liveUI();
      if (ui)
        showLogin(ui, channel, url, code);
      say(ui ? `HumanLayer: open ${url} and enter code ${code}` : `HumanLayer login (${channel}): open ${url} and enter code ${code}`);
    },
    async pickOrg(orgs, current) {
      const labels = orgs.map((o) => {
        const twin = orgs.some((x) => x !== o && x.organizationName === o.organizationName);
        const label = twin ? `${o.organizationName} (${o.organizationId})` : o.organizationName;
        return o === current ? `${label} (current)` : label;
      });
      const picked = await liveUI()?.select("Choose a HumanLayer organization", labels);
      return picked === undefined ? undefined : orgs[labels.indexOf(picked)];
    }
  };
}
async function handleLogin(channelArg, ctx) {
  let channel;
  if (channelArg === undefined) {
    channel = await resolveChannel();
  } else if (isChannel(channelArg)) {
    channel = channelArg;
  } else {
    output(ctx, `HumanLayer: unknown channel "${channelArg}". Use prod, beta, dev or local.`, "error");
    return;
  }
  const waiting = pendingLogin(channel);
  if (waiting) {
    const code = waiting.code ? `: open ${waiting.url} and enter code ${waiting.code}` : "";
    return output(ctx, `HumanLayer: a login to ${channel} is already waiting${code}. Run /humanlayer logout to cancel it.`);
  }
  const run2 = async () => {
    let creds;
    try {
      creds = await startDeviceLogin(channel, loginUI(channel));
    } catch (err) {
      return say(`HumanLayer: login failed: ${errorMessage(err)}`, "error");
    } finally {
      liveUI()?.setWidget(LOGIN_WIDGET, undefined);
    }
    if (!creds)
      return say("HumanLayer: login cancelled");
    resumeAll();
    say(`HumanLayer: signed in to ${channel} as ${creds.email} (${creds.orgName})`);
    await live2?.mirror?.authChanged().catch((err) => log(`login: ${errorMessage(err)}`));
  };
  if (ctx.hasUI)
    run2().catch(() => {});
  else
    await run2();
}
async function handleLogout(instance, ctx) {
  const channel = await resolveChannel();
  await logout(channel);
  await instance.mirror?.authChanged();
  output(ctx, `HumanLayer: signed out of ${channel}`);
}
async function handleStatus(instance, ctx) {
  const channel = await resolveChannel();
  const id = await identity(channel);
  const settings = await humanlayerSettings.load();
  const lines = [`channel: ${channel}`, ...humanlayerSettings.statusLines(settings)];
  if (!id) {
    lines.push("user: not signed in");
    lines.push("auth: none. Run /humanlayer login.");
  } else if (id.source === "pat") {
    lines.push("user: (PAT)");
    lines.push("auth: PAT (HUMANLAYER_PAT)");
  } else {
    lines.push(`user: ${id.email ?? "?"}`);
    lines.push(`org: ${id.orgName ?? "?"}`);
    lines.push("auth: device login");
  }
  const m = instance.mirror?.info();
  if (!m)
    lines.push(`mirroring: ${isDisabled() ? "disabled (HUMANLAYER_PI_DISABLE=1)" : "not running"}`);
  else {
    lines.push(`mirroring: ${m.state}`);
    lines.push(`task: ${m.task ?? "none"}`);
    if (m.url)
      lines.push(`session: ${m.url}`);
    lines.push(`queue: ${m.queue}`);
    lines.push(`last error: ${m.lastError ?? "none"}`);
  }
  output(ctx, `HumanLayer status
${lines.map((line) => `  ${line}`).join(`
`)}`);
}
function withMirror(instance, ctx, act) {
  const m = instance.mirror;
  if (!m) {
    output(ctx, `HumanLayer: mirroring is ${isDisabled() ? "disabled (HUMANLAYER_PI_DISABLE=1)" : "not running"}`, "warning");
    return;
  }
  output(ctx, act(m));
}
function createHumanlayerCommand(instance) {
  return async (args, ctx) => {
    const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
    const [sub, arg] = parts;
    switch (sub) {
      case undefined:
      case "status":
        return handleStatus(instance, ctx);
      case "login":
        return handleLogin(arg, ctx);
      case "logout":
        return handleLogout(instance, ctx);
      case "open-session":
        return withMirror(instance, ctx, (m) => {
          const url = m.info().url;
          if (!url)
            return "HumanLayer: this session is not linked yet. Send a prompt first.";
          if (process.env.HUMANLAYER_PI_NO_BROWSER !== "1")
            openBrowser(url);
          return `HumanLayer: opened ${url}`;
        });
      case "attach":
        if (!arg)
          return output(ctx, "HumanLayer: usage: /humanlayer attach <task id or slug, or new>", "warning");
        return withMirror(instance, ctx, (m) => {
          m.attach(arg);
          return arg === "new" ? "HumanLayer: the next prompt starts a new task" : `HumanLayer: the next prompt attaches to task ${arg}`;
        });
      case "default":
        if (parts.length > 2 || arg !== undefined && arg !== "on" && arg !== "off")
          return output(ctx, "HumanLayer: usage: /humanlayer default [on|off]", "warning");
        if (arg === undefined)
          return output(ctx, `HumanLayer: ${humanlayerSettings.statusLines(await humanlayerSettings.load()).join("; ")}`);
        await humanlayerSettings.save({ defaultMirroring: arg });
        return output(ctx, `HumanLayer: default mirroring set to ${arg} for new sessions; this session is unchanged`);
      case "off":
      case "on":
        if (parts.length > 1)
          return output(ctx, `HumanLayer: usage: /humanlayer ${sub}`, "warning");
        return withMirror(instance, ctx, (m) => {
          if (sub === "off")
            m.setOff();
          else
            m.setOn();
          return `HumanLayer: mirroring ${sub} for this session`;
        });
      default:
        output(ctx, `HumanLayer: unknown subcommand "${sub}". Try login, logout, status, open-session, attach, off, on or default.`, "warning");
    }
  };
}
function complete(choices, typed, before = "") {
  const matches = choices.filter((c) => c.startsWith(typed));
  return matches.length > 0 && !choices.includes(typed) ? matches.map((c) => ({ value: before + c, label: c })) : null;
}
function humanlayerArgumentCompletions(argumentPrefix) {
  const [sub = "", channel, ...more] = argumentPrefix.split(" ");
  if (channel === undefined)
    return complete(SUBCOMMANDS, sub);
  if (more.length > 0)
    return null;
  if (sub === "login")
    return complete(ALL_CHANNELS, channel, "login ");
  return sub === "default" ? complete(["on", "off"], channel, "default ") : null;
}

// apps/riptide-pi-extension/src/skills.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
function bundledSkillPaths() {
  return [fileURLToPath2(new URL("../skills/", import.meta.url))];
}

// apps/riptide-pi-extension/src/tools.ts
import { Type } from "@earendil-works/pi-ai";
function typeBox(p) {
  const { optional: _optional, type, ...rest } = p;
  if (type === "string")
    return Type.String(rest);
  if (type === "boolean")
    return Type.Boolean(rest);
  if (type === "true")
    return Type.Literal(true, rest);
  if (type === "integer")
    return Type.Integer(rest);
  const { items, ...array } = rest;
  return Type.Array(Type.String(items), array);
}
function parameters(params) {
  const shape2 = Object.fromEntries(Object.entries(params).map(([name, p]) => [name, p.optional ? Type.Optional(typeBox(p)) : typeBox(p)]));
  return Type.Object(shape2);
}
function registerHumanlayerTools(pi, target) {
  for (const name of HUMANLAYER_TOOLS) {
    const { description, params } = TOOLS[name];
    pi.registerTool({
      name,
      label: name.replaceAll("_", " "),
      description,
      parameters: parameters(params),
      executionMode: "sequential",
      async execute(_id, input, signal) {
        const text2 = await runTool(name, input, target, daemonCall, signal);
        return { content: [{ type: "text", text: text2 }], details: undefined };
      }
    });
  }
}
function syncTools(pi, on) {
  const active = pi.getActiveTools();
  const ours = new Set(HUMANLAYER_TOOLS);
  const has = active.some((t) => ours.has(t));
  if (on === has)
    return;
  pi.setActiveTools(on ? [...active, ...HUMANLAYER_TOOLS] : active.filter((t) => !ours.has(t)));
}

// apps/riptide-pi-extension/src/index.ts
function createHumanlayer(opts = {}) {
  return (pi) => {
    getPat();
    const instance = { alive: true };
    let interrupt;
    let interrupted = false;
    let interruptExit;
    pi.registerFlag("humanlayer-task", {
      type: "string",
      description: "HumanLayer task id or slug to attach this pi session to"
    });
    pi.registerCommand("humanlayer", {
      description: "HumanLayer cloud mirroring: login, logout, status, attach, off, on, default",
      getArgumentCompletions: humanlayerArgumentCompletions,
      handler: createHumanlayerCommand(instance)
    });
    registerHumanlayerTools(pi, () => instance.mirror?.toolTarget() ?? { reason: "HumanLayer is off for this pi session." });
    const tools2 = () => {
      try {
        syncTools(pi, instance.mirror?.linked() ?? false);
      } catch (err) {
        log(`tools: ${errorMessage(err)}`);
      }
    };
    const flag = () => {
      const value = pi.getFlag("humanlayer-task");
      return typeof value === "string" ? value : undefined;
    };
    const run2 = async (name, act) => {
      const m = instance.mirror;
      if (!m)
        return;
      try {
        return await act(m);
      } catch (err) {
        log(`${name}: ${errorMessage(err)}`);
        return;
      }
    };
    pi.on("session_start", async (_event, ctx) => {
      setLive(instance, ctx);
      if (isDisabled())
        return;
      try {
        const oneShot = ctx.mode === "print" || ctx.mode === "json";
        const driver = oneShot ? undefined : {
          send: (text2) => pi.sendUserMessage(text2, {
            expandPromptTemplates: text2.startsWith("/skill:"),
            deliverAs: ctx.isIdle() ? undefined : "followUp"
          }),
          compact: () => ctx.compact(),
          abort: () => ctx.abort(),
          isIdle: () => ctx.isIdle(),
          skills: () => pi.getCommands().filter((c) => c.source === "skill")
        };
        const m = await Mirror.start(ctx, flag, opts, driver);
        if (instance.alive)
          instance.mirror = m;
        else
          await m.shutdown();
        tools2();
        if (instance.alive && oneShot) {
          interrupt = () => {
            if (interrupted)
              process.exit(130);
            interrupted = true;
            setTimeout(() => process.exit(130), flushMs() + 1000);
            ctx.abort();
            interruptExit = run2("SIGINT", (mirror) => mirror.shutdown(true)).then(() => process.exit(130));
          };
          process.on("SIGINT", interrupt);
        }
      } catch (err) {
        log(`session_start: ${errorMessage(err)}`);
      }
    });
    pi.on("resources_discover", () => {
      try {
        return { skillPaths: bundledSkillPaths() };
      } catch (err) {
        log(`resources_discover: ${errorMessage(err)}`);
        return;
      }
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const result = await run2("before_agent_start", (m) => m.beforeAgentStart(event, ctx.model));
      tools2();
      return result;
    });
    pi.on("agent_start", () => run2("agent_start", (m) => m.agentStart()));
    pi.on("message_end", (event) => run2("message_end", (m) => m.messageEnd(event)));
    pi.on("agent_end", (_event, ctx) => run2("agent_end", (m) => m.agentEnd(ctx.signal?.aborted === true)));
    pi.on("agent_before_settle", (event) => run2("agent_before_settle", (m) => m.beforeSettle(event.outcome)));
    pi.on("agent_settled", async () => {
      await run2("agent_settled", (m) => m.agentSettled());
      await interruptExit;
    });
    pi.on("session_before_compact", (event) => run2("session_before_compact", (m) => m.compacting(true, event.reason)));
    pi.on("session_compact", () => run2("session_compact", (m) => m.compacting(false)));
    pi.on("session_compact_failed", () => run2("session_compact_failed", (m) => m.compacting(false)));
    pi.on("model_select", (event) => run2("model_select", (m) => m.modelSelect(event.model)));
    pi.on("tool_call", (event) => run2("tool_call", (m) => m.toolCall(event)));
    pi.on("tool_execution_end", (event) => run2("tool_execution_end", (m) => m.nestedToolEnd(event)));
    const sweep = () => run2("sweep", (m) => m.sweep());
    pi.on("message_start", sweep);
    pi.on("turn_end", sweep);
    pi.on("input", sweep);
    pi.on("tool_execution_start", sweep);
    pi.on("session_tree", sweep);
    pi.on("thinking_level_select", sweep);
    pi.on("session_info_changed", sweep);
    pi.on("session_shutdown", async () => {
      await run2("session_shutdown", (m) => m.shutdown());
      if (interrupt && !interrupted)
        process.off("SIGINT", interrupt);
      instance.alive = false;
      instance.mirror = undefined;
    });
  };
}
var src_default = createHumanlayer();
export {
  src_default as default
};
