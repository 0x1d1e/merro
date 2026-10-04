import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { systemCommandRunner, type CommandRunner } from "../src/runtime/commands.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";
import { GitClient } from "../src/vcs/git.js";

for (const sandbox of ["docker", "none"] as const) {
  test(`copied installed Merro is inert in a ${sandbox} worker and its result remains valid`, async (t) => {
    const initialRuntime = process.env.MERRO_RUNTIME;
    const root = await mkdtemp(join(tmpdir(), "merro-isolation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clone = join(root, "clone");
    const config = join(root, "host-config");
    const installed = join(config, "git", "Merro");
    await mkdir(clone);
    await mkdir(installed, { recursive: true });
    await cp(resolve("dist/src"), join(installed, "src"), { recursive: true });
    await cp(resolve("node_modules/typebox"), join(installed, "node_modules/typebox"), { recursive: true });
    await writeFile(join(installed, "package.json"), '{"type":"module","pi":{"extensions":["src/index.js"]}}');
    const settings = '{"packages":["./git/Merro"],"theme":"dark","defaultProvider":"custom","defaultModel":"model"}';
    await writeFile(join(config, "settings.json"), settings);
    await writeFile(join(config, "auth.json"), '{"test":"private"}');
    await writeFile(join(config, "models.json"), '{"providers":{}}');
    await mkdir(join(config, "extensions"));
    await writeFile(join(config, "extensions", "unrelated.js"), "export default function(pi) { pi.registerCommand('unrelated', { handler() {} }); }");
    const git = async (...args: string[]) => (await systemCommandRunner.run("git", args, { cwd: clone })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await git("commit", "--allow-empty", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    const runtimePath = join(root, "main", ".merro", "runtime");
    let workerEnvironment: Record<string, string> = {};
    const commands: CommandRunner = { async run(file, args) {
      if (file === "pi") return { stdout: "0.99.2", stderr: "" };
      if (file === "ps") return { stdout: "Thu Jan 1 00:00:00 2026", stderr: "" };
      if (file === "docker") {
        if (args[0] === "image") return { stdout: "[]", stderr: "" };
        if (args[0] === "inspect") return { stdout: JSON.stringify([{ Id: "a".repeat(64), State: { Running: true, StartedAt: "2026-01-01T00:00:00Z" } }]), stderr: "" };
      }
      if (file === "tmux") {
        if (args[0] === "has-session") throw new Error("no such session");
        if (args[0] === "display-message") return { stdout: args.at(-1) === "#{window_id}" ? "@1" : "123", stderr: "" };
        if (args[0] === "new-session") {
          const command = args[args.indexOf("-c") + 2]!;
          if (sandbox === "docker") {
            const output = await systemCommandRunner.run("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`]);
            const tokens = output.stdout.trim().split("\n");
            const env = await readFile(tokens[tokens.indexOf("--env-file") + 1]!, "utf8");
            workerEnvironment = Object.fromEntries(env.trim().split("\n").map((line) => line.split("=")));
            await writeFile(tokens[tokens.indexOf("--cidfile") + 1]!, "a".repeat(64));
            assert.ok(!tokens.some((value) => value.includes("state.db")));
          } else {
            const script = await readFile(command.slice(6, -1), "utf8");
            workerEnvironment = Object.fromEntries([...script.matchAll(/^export (\w+)='([^']*)'$/gm)].map((match) => [match[1]!, match[2]!]));
          }
          assert.equal(workerEnvironment.MERRO_RUNTIME, "worker");
          return { stdout: "%1", stderr: "" };
        }
      }
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    } };
    const runtime = new WorkerRuntime({ workspacePath: runtimePath, config: { ...DEFAULT_CONFIG, sandbox, worker_github: "off" }, piConfigPath: config, commands });
    const record = await runtime.launch({ taskId: "task", changeSetId: "p:issue-1:g1", changeSlug: "implement", taskName: "implement-change", role: "implement", project: { slug: "p", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" }, clonePath: clone, taskFile: "Implement", expectedCommit: base, projectSettings: null });
    const scratch = dirname(record.resultPath);
    const copied = sandbox === "docker" ? join(scratch, "pi-config") : config;
    assert.equal(await readFile(join(copied, "settings.json"), "utf8"), settings);
    assert.equal(await readFile(join(copied, "models.json"), "utf8"), '{"providers":{}}');
    assert.equal(await readFile(join(copied, "auth.json"), "utf8"), '{"test":"private"}');
    assert.match(await readFile(join(scratch, "merro-runtime", "protocol", "submit-result.js"), "utf8"), /merro_submit_result/);
    // Model installed-package discovery from the copied config with the worker checkout as cwd.
    const startup = `import merro from ${JSON.stringify(pathToFileURL(join(copied, "git/Merro/src/index.js")).href)};
      await merro({ registerCommand(){throw Error('Main command')}, registerTool(){throw Error('Main tool')}, on(){throw Error('Main loop')} });`;
    await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", startup], { cwd: clone, env: { MERRO_RUNTIME: workerEnvironment.MERRO_RUNTIME! } });
    await assert.rejects(readFile(join(clone, ".merro", "config.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(clone, ".merro")), { code: "ENOENT" });
    await writeFile(join(clone, "implementation.txt"), "implementation\n");
    await git("add", "implementation.txt");
    await git("commit", "-m", "implementation");
    const head = await git("rev-parse", "HEAD");
    const submit = `import merroWorker from ${JSON.stringify(pathToFileURL(resolve("dist/src/tools/worker-result.js")).href)};
      let tool; merroWorker({registerTool(value){tool=value}});
      const result = await tool.execute('submit', {task_id:'task',status:'success',summary:'done',commit:${JSON.stringify(head)},verification:[]});
      if(!result.terminate) throw Error('not finalized');`;
    await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", submit], { cwd: clone, env: { MERRO_RUNTIME: "worker", MERRO_TASK_ROLE: "implement", MERRO_TASK_ID: "task", MERRO_RESULT_PATH: record.resultPath, MERRO_TASK_SCRATCH: scratch, PI_CODING_AGENT_DIR: copied } });
    assert.equal(await git("status", "--short"), "");
    const result = JSON.parse(await readFile(record.resultPath, "utf8"));
    assert.equal(await new GitClient().validateTaskCommit(clone, base, result.commit), head);
    assert.equal(await git("rev-list", "--count", `${base}..HEAD`), "1");
    await assert.rejects(new GitClient().validateTaskCommit(clone, base, "f".repeat(40)));
    await assert.rejects(new GitClient().validateTaskCommit(clone, base, base), /does not match clone HEAD/);
    await writeFile(join(clone, "unknown.txt"), "strict cleanliness");
    await assert.rejects(new GitClient().validateTaskCommit(clone, base, head), /uncommitted or untracked/);
    await rm(join(clone, "unknown.txt"));
    assert.equal(await readFile(join(config, "settings.json"), "utf8"), settings);
    assert.equal(process.env.MERRO_RUNTIME, initialRuntime);
  });
}

test("Main entrypoint registers orchestration normally without the worker marker", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-main-entry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const startup = `import merro from ${JSON.stringify(pathToFileURL(resolve("dist/src/index.js")).href)};
    const commands=[], tools=[], events=[];
    await merro({registerCommand(name){commands.push(name)},registerTool(tool){tools.push(tool.name)},on(event){events.push(event)}});
    if(commands.length !== 1 || commands[0] !== 'merro' || !tools.includes('merro_start_objective') || !events.includes('session_start')) throw Error('Main not initialized');`;
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", startup], { cwd, env: { MERRO_RUNTIME: "" } });
  await assert.rejects(readFile(join(cwd, ".merro", "config.json")), { code: "ENOENT" });
});
