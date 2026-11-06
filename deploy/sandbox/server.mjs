// Runs untrusted code for hosted agents: one disposable gVisor container per request, with no network,
// no secrets, and hard limits on CPU, memory, processes, disk, time and output. This machine is isolated
// from the relay and holds no keys. The only secret here is this server's own token, which containers
// never see. A repository is fetched here at a pinned commit and handed in as a file, because the
// container has no network, and it unpacks inside the container, so a hostile archive only reaches itself.
import { execFile, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = readFileSync(new URL("./token", import.meta.url), "utf8").trim();
const LISTEN = process.env.SANDBOX_LISTEN ?? "127.0.0.1";
const PORT = 4191;
const IMAGES = { python: "python:3.12-alpine", node: "node:22-alpine" };
const MAX_BODY = 512 * 1024;
const MAX_OUTPUT = 32 * 1024;
const MAX_REPO = 20 * 1024 * 1024;
const TIME_LIMIT_MS = 30_000;

function kill(name) {
  execFile("docker", ["rm", "-f", name], () => undefined);
}

async function fetchRepo(repo, dir) {
  const { owner, name, commit } = repo;
  if (
    !/^[A-Za-z0-9_.-]{1,64}$/.test(owner ?? "") ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name ?? "") ||
    !/^[a-f0-9]{40}$/.test(commit ?? "")
  )
    throw new Error(
      "A repository needs an owner, a name and a full commit hash.",
    );
  const response = await fetch(
    `https://codeload.github.com/${owner}/${name}/tar.gz/${commit}`,
    {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `The repository could not be read: HTTP ${response.status}.`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_REPO) throw new Error("That repository is too large.");
  writeFileSync(join(dir, "repo.tar.gz"), bytes, { mode: 0o444 });
  return bytes.length;
}

function run({ image, files, command, repoFile, dir }) {
  const name = `sandbox-${randomUUID()}`;
  // The files arrive on stdin as one JSON document, and the entry script writes them. Names are checked
  // again inside, against the working directory.
  const entry = [
    "cd /work",
    repoFile
      ? "tar xzf /input/repo.tar.gz --strip-components=1 --no-same-owner 2>/dev/null; true"
      : "true",
    'exec timeout -s KILL 25 sh -c "$PROVEN_COMMAND"',
  ].join(" && ");
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "-i",
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/work:rw,size=64m,mode=1777,exec",
    "--tmpfs",
    "/tmp:rw,size=16m,mode=1777",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=0.5",
    "--pids-limit=64",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--ulimit",
    "fsize=33554432",
    "--ulimit",
    "nofile=128",
    "--env",
    `PROVEN_COMMAND=${command}`,
    ...(repoFile ? ["-v", `${dir}:/input:ro`] : []),
    image,
    "sh",
    "-c",
    `cat > /work/.files.json && ${files.writer} && rm -f /work/.files.json && ${entry}`,
  ];
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    const take = (chunk) => {
      if (output.length < MAX_OUTPUT)
        output += String(chunk).slice(0, MAX_OUTPUT - output.length);
      else truncated = true;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(name);
      child.kill("SIGKILL");
    }, TIME_LIMIT_MS);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(files.content));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        timed_out: timedOut,
        truncated,
        ms: Date.now() - started,
        output,
      });
    });
  });
}

/** Writes the files inside the container with whatever that image has, refusing names outside /work. */
const WRITERS = {
  python: `python3 -c "import json,os;d=json.load(open('/work/.files.json'));[(lambda p,c:(os.makedirs(os.path.dirname(p) or '.',exist_ok=True),open(p,'w').write(c)))(os.path.realpath(os.path.join('/work',n)),c) for n,c in d.items() if os.path.realpath(os.path.join('/work',n)).startswith('/work/')]"`,
  node: `node -e "const f=require('fs'),p=require('path'),d=JSON.parse(f.readFileSync('/work/.files.json'));for(const[n,c]of Object.entries(d)){const t=p.resolve('/work',n);if(t.startsWith('/work/')){f.mkdirSync(p.dirname(t),{recursive:true});f.writeFileSync(t,c)}}"`,
};

// One run at a time on this small machine, shared fairly. Each agent can have one run going and one
// waiting, and turns go round the agents that are waiting, so nobody can keep others out by asking more
// often. A run takes at most 30 seconds, so a place in the queue is refused if it could not start soon.
const MAX_RUNS_PER_HOUR = 20;
const MAX_WAIT_MS = 60_000;
const waiting = new Map();
const lastRuns = new Map();
let current = null;

function allowedThisHour(agent, now = Date.now()) {
  const recent = (lastRuns.get(agent) ?? []).filter(
    (at) => now - at < 3_600_000,
  );
  lastRuns.set(agent, recent);
  if (lastRuns.size > 10_000) lastRuns.delete(lastRuns.keys().next().value);
  return recent.length < MAX_RUNS_PER_HOUR;
}
function next() {
  if (current !== null || waiting.size === 0) return;
  // A Map keeps its order, and a served agent goes to the back when it asks again.
  const [agent, start] = waiting.entries().next().value;
  waiting.delete(agent);
  current = agent;
  start();
}
function takeTurn(agent) {
  if (waiting.has(agent)) return Promise.resolve(false);
  if (!allowedThisHour(agent)) return Promise.resolve(false);
  // Every agent ahead could use a whole run.
  if (
    (waiting.size + (current === null ? 0 : 1)) * TIME_LIMIT_MS >
    MAX_WAIT_MS * 2
  )
    return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(agent);
      resolve(false);
    }, MAX_WAIT_MS);
    waiting.set(agent, () => {
      clearTimeout(timer);
      lastRuns.get(agent).push(Date.now());
      resolve(true);
    });
    next();
  });
}
function endTurn() {
  current = null;
  next();
}

createServer(async (req, res) => {
  const reply = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const given = Buffer.from(req.headers.authorization ?? "");
  const wanted = Buffer.from(`Bearer ${TOKEN}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    return reply(401, { error: "Not allowed." });
  if (req.method !== "POST" || req.url !== "/run")
    return reply(404, { error: "Not found." });
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > MAX_BODY) return reply(413, { error: "Too large." });
  }
  const agent = String(req.headers["x-agent"] ?? "");
  if (!/^[a-z0-9:._-]{2,80}$/.test(agent))
    return reply(400, { error: "Say which agent this is for." });
  if (!(await takeTurn(agent)))
    return reply(429, {
      error: "The sandbox is busy, or this agent has used its runs for now.",
    });
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  try {
    const body = JSON.parse(text);
    const image = IMAGES[body.language];
    if (!image) return reply(400, { error: "Use python or node." });
    const command = String(body.command ?? "");
    if (!command || command.length > 2_000 || /\0/.test(command))
      return reply(400, {
        error: "Give one command of at most 2000 characters.",
      });
    const content = body.files ?? {};
    if (typeof content !== "object" || Object.keys(content).length > 200)
      return reply(400, { error: "Too many files." });
    const repoBytes = body.repo ? await fetchRepo(body.repo, dir) : 0;
    const result = await run({
      image,
      files: { content, writer: WRITERS[body.language] },
      command,
      repoFile: Boolean(body.repo),
      dir,
    });
    reply(200, { ...result, repo_bytes: repoBytes });
  } catch (error) {
    reply(400, { error: String(error?.message ?? "Refused.").slice(0, 200) });
  } finally {
    endTurn();
    rmSync(dir, { recursive: true, force: true });
  }
}).listen(PORT, LISTEN, () => console.log(`Sandbox on ${LISTEN}:${PORT}.`));
