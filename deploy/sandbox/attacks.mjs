// Hostile runs against the sandbox: reading secrets, reaching the network, escaping, and exhausting it.
// Run on the sandbox machine. Every case prints what actually happened.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const token = readFileSync(new URL("./token", import.meta.url), "utf8").trim();
async function run(body) {
  const response = await fetch("http://127.0.0.1:4191/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, ...(await response.json()) };
}
const py = (code, extra = {}) =>
  run({
    language: "python",
    files: { "main.py": code },
    command: "python3 main.py",
    ...extra,
  });

const results = [];
function report(name, passed, detail) {
  results.push(passed);
  console.log(
    `${passed ? "PASS" : "FAIL"}  ${name}: ${String(detail).replace(/\s+/g, " ").slice(0, 150)}`,
  );
}
const tryRead = (path) => `
try:
    print("READ:", open(${JSON.stringify(path)}, "rb").read()[:200])
except Exception as e:
    print("DENIED", type(e).__name__)
`;

// ---- A control, so that a broken sandbox cannot pass everything by failing everything.
let r = await py('print("hello", 2+2)');
report(
  "control: ordinary code runs",
  r.output.includes("hello 4") && r.exit_code === 0,
  r.output,
);
r = await run({
  language: "node",
  files: { "a.js": "console.log(process.version)" },
  command: "node a.js",
});
report("control: node runs", r.output.startsWith("v22"), r.output);

// ---- Secrets
for (const path of [
  "/home/boxd/sandbox/token",
  "/home/boxd/sandbox/server.mjs",
  "/run/boxd/agent-login",
  "/etc/shadow",
  "/var/run/docker.sock",
  "/proc/1/environ",
]) {
  r = await py(tryRead(path));
  const leaked =
    r.output.includes("READ:") &&
    (path.includes("token") ||
      path.includes("shadow") ||
      path.includes("server"));
  report(`secret: ${path}`, !leaked && !r.output.includes(token), r.output);
}
r = await py("import os\nprint(sorted(os.environ.keys()))");
// Exactly what the images set, plus our command. GPG_KEY is the public id of Python's release signer.
const expectedEnv = [
  "GPG_KEY",
  "HOME",
  "HOSTNAME",
  "LANG",
  "OLDPWD",
  "PATH",
  "PROVEN_COMMAND",
  "PWD",
  "PYTHON_SHA256",
  "PYTHON_VERSION",
  "SHLVL",
];
report(
  "secret: environment holds only what the image sets",
  r.output.trim() ===
    JSON.stringify(expectedEnv).replace(/"/g, "'").replace(/,/g, ", "),
  r.output,
);
r = await py(
  'import os\nprint(os.listdir("/"), os.path.exists("/input"), os.getuid())',
);
report(
  "runs as nobody, with no host folders",
  r.output.includes("65534") && r.output.includes("False"),
  r.output,
);

// ---- Network
const connect = (host, port) => `
import socket
s = socket.socket(); s.settimeout(4)
try:
    s.connect((${JSON.stringify(host)}, ${port})); print("CONNECTED")
except Exception as e:
    print("BLOCKED", type(e).__name__)
`;
for (const [host, port] of [
  ["1.1.1.1", 53],
  ["169.254.169.254", 80],
  ["10.39.0.1", 22],
  ["172.17.0.1", 4191],
  ["127.0.0.1", 4191],
  ["8.8.8.8", 443],
]) {
  r = await py(connect(host, port));
  report(`network: ${host}:${port}`, !r.output.includes("CONNECTED"), r.output);
}
r = await py(`
import socket
try:
    print("RESOLVED", socket.gethostbyname("github.com"))
except Exception as e:
    print("NO DNS", type(e).__name__)
`);
report("network: DNS", !r.output.includes("RESOLVED"), r.output);
r = await py(
  'import os\nprint(os.popen("cat /proc/net/route; ip addr 2>&1").read())',
);
report("network: no route out", !/eth0/.test(r.output), r.output);

// ---- Escape
r = await py(
  'import os\nprint(os.popen("dmesg 2>&1 | head -3; cat /proc/version").read())',
);
report(
  "runs under gVisor, not the host kernel",
  /gVisor|Linux version 4\.4\.0/.test(r.output),
  r.output,
);
r = await py(
  'import os\nprint(os.popen("ps ax 2>&1 | wc -l; ls /proc | grep -c ^[0-9]").read())',
);
report(
  "cannot see host processes",
  (() => {
    const n = parseInt(
      r.output.split("\n").pop() || r.output.trim().split(/\s+/).pop(),
      10,
    );
    return !(n > 20);
  })(),
  r.output,
);
r = await py(`
import os
for action, code in [("mount", "mount -t proc proc /tmp 2>&1"), ("chroot", "chroot / id 2>&1"), ("root write", "echo x > /etc/passwd 2>&1"), ("sysrq", "echo b > /proc/sysrq-trigger 2>&1"), ("su", "su root -c id 2>&1")]:
    print(action, os.popen(code).read().strip()[:60], "|")
print("caps", open("/proc/self/status").read().split("CapEff:")[1].split()[0])
`);
report(
  "no root powers",
  /caps 0+\b/.test(r.output) && !/uid=0/.test(r.output),
  r.output,
);
r = await run({
  language: "python",
  files: { "../../etc/evil": "x", "/etc/evil2": "x", "ok.txt": "fine" },
  command: "ls /etc/evil /etc/evil2 2>&1; cat ok.txt",
});
report(
  "file names cannot leave the working folder",
  /No such file/.test(r.output) && r.output.includes("fine"),
  r.output,
);
await py(
  'open("/work/left-behind","w").write("x")\nopen("/tmp/left-behind","w").write("x")',
);
r = await py(
  'import os\nprint(os.path.exists("/work/left-behind"), os.path.exists("/tmp/left-behind"))',
);
report(
  "nothing survives between runs",
  r.output.includes("False False"),
  r.output,
);

// ---- Exhaustion
const hostBefore = Number(execSync("ps ax | wc -l").toString());
r = await py(`
import os, time
n = 0
try:
    while n < 5000:
        if os.fork() == 0:
            time.sleep(20); os._exit(0)
        n += 1
except Exception as e:
    print("STOPPED AT", n, type(e).__name__, flush=True)
print("FORKED", n, flush=True)
os._exit(0)
`);
{
  // Past the limit gVisor's runtime ends the whole container, rather than the program seeing a clean
  // stop. What must hold is that it ends fast, leaves nothing running, and the host never feels it.
  const after = Number(execSync("ps ax | wc -l").toString());
  const left = Number(execSync("docker ps -q | wc -l").toString());
  report(
    "fork bomb ends the run fast and the host is untouched",
    !r.output.includes("FORKED 5000") &&
      r.ms < 10_000 &&
      left === 0 &&
      after < hostBefore + 15,
    `exit ${r.exit_code}, ${r.ms} ms, ${left} containers left, host processes ${hostBefore} to ${after}`,
  );
}
r = await py('x = []\nwhile True:\n    x.append(b"a" * 10_000_000)\n');
report(
  "memory bomb is killed",
  r.exit_code !== 0 && r.ms < 35000,
  `exit ${r.exit_code}, ${r.ms} ms`,
);
r = await py(`
try:
    f = open("/work/big", "wb")
    for i in range(400):
        f.write(b"a" * 1_000_000); f.flush()
    print("WROTE ALL")
except Exception as e:
    print("STOPPED", type(e).__name__)
`);
report(
  "disk stops at the limit",
  !r.output.includes("WROTE ALL"),
  `exit ${r.exit_code} ${r.output}`,
);
r = await py("while True: pass\n");
report(
  "endless loop is killed in time",
  r.ms < 35000 && r.exit_code !== 0,
  `exit ${r.exit_code}, ${r.ms} ms, timed_out ${r.timed_out}`,
);
r = await py('import sys\nwhile True: sys.stdout.write("x" * 100000)\n');
report(
  "output flood is cut off",
  r.output.length <= 32 * 1024 && r.truncated === true,
  `${r.output.length} bytes kept, exit ${r.exit_code}`,
);
r = await py('print("still working")');
report(
  "the machine still works after all of that",
  r.output.includes("still working"),
  r.output,
);

// ---- The door itself
const unauth = await fetch("http://127.0.0.1:4191/run", {
  method: "POST",
  body: "{}",
});
report("no token, no run", unauth.status === 401, unauth.status);
r = await run({ language: "ruby", files: {}, command: "x" });
report("only the two images", r.status === 400, r.error);
r = await run({
  language: "python",
  command: "ls",
  repo: { owner: "../..", name: "x", commit: "a".repeat(40) },
});
report("repository names are checked", r.status === 400, r.error);

// ---- Reading a public repository at a pinned commit, with no network in the container.
r = await run({
  language: "python",
  files: {},
  command:
    "ls | head -5; test -f README.md && echo HAS_README; python3 -c 'import socket;socket.create_connection((\"1.1.1.1\",53),3)' 2>&1 | tail -1 | cut -c1-40",
  repo: {
    owner: "octocat",
    name: "Hello-World",
    commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  },
});
report(
  "a pinned public repository reads in, still with no network",
  r.exit_code === 0 &&
    r.repo_bytes > 0 &&
    /(Network|unreachable|Errno)/i.test(r.output),
  `${r.repo_bytes} bytes; ${r.output}`,
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed.`);
process.exit(failed ? 1 : 0);
