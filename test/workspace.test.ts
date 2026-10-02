import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandError, systemCommandRunner } from "../src/runtime/commands.js";
import { initializeWorkspace, INITIALIZATION_REQUIRED, requireWorkspace } from "../src/runtime/workspace.js";
import { MerroStore } from "../src/store/store.js";

const entrypoint = pathToFileURL(resolve("dist/src/index.js")).href;

test("Pi startup and tools refuse an uninitialized cwd without guessing its initialized parent", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "merro-no-init-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, ".merro"));
  const cwd = join(parent, "child");
  await mkdir(cwd);
  const startup = `import assert from 'node:assert/strict'; import merro from ${JSON.stringify(entrypoint)};
    const commands=new Map(), tools=new Map(), events=new Map();
    await merro({registerCommand(name, command){commands.set(name,command)},registerTool(tool){tools.set(tool.name,tool)},on(name,handler){events.set(name,handler)}});
    await events.get('session_start')();
    await assert.rejects(commands.get('status').handler('',{}), {message:${JSON.stringify(INITIALIZATION_REQUIRED)}});
    await assert.rejects(tools.get('merro_status').execute('status',{}), {message:${JSON.stringify(INITIALIZATION_REQUIRED)}});
    await events.get('session_shutdown')();`;
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", startup], { cwd, env: { MERRO_RUNTIME: "" } });
  await assert.rejects(readFile(join(cwd, ".merro", "config.json")), { code: "ENOENT" });
  await assert.rejects(requireWorkspace(cwd), { message: INITIALIZATION_REQUIRED });
});

for (const gitRepository of [false, true]) {
  test(`/merro init works in a ${gitRepository ? "Git directory without remotes" : "new non-Git directory"} without GitHub access`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-empty-init-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "workspace");
    const bin = join(root, "bin");
    await mkdir(cwd);
    await mkdir(bin);
    if (gitRepository) await systemCommandRunner.run("git", ["init", "--initial-branch=main"], { cwd });
    await writeFile(join(bin, "pi"), "#!/bin/sh\ncase \"$1\" in --version) echo 1.0.0;; --help) echo '--tui-mode regular';; esac\n", { mode: 0o700 });
    await writeFile(join(bin, "tmux"), "#!/bin/sh\n[ \"$1\" != '-V' ] || echo 'tmux 3.6'\nexit 0\n", { mode: 0o700 });
    await writeFile(join(bin, "gh"), `#!/bin/sh\ntouch '${join(root, "gh-called")}'\nexit 1\n`, { mode: 0o700 });
    const startup = `import assert from 'node:assert/strict'; import merro from ${JSON.stringify(entrypoint)};
      const commands=new Map(), tools=new Map(), events=new Map();
      await merro({registerCommand(name, command){commands.set(name,command)},registerTool(tool){tools.set(tool.name,tool)},on(name,handler){events.set(name,handler)}});
      await events.get('session_start')();
      try {
        await commands.get('merro').handler('init',{});
        await commands.get('merro').handler('init',{});
        assert.deepEqual((await tools.get('merro_list_projects').execute('list',{})).details,[]);
        await commands.get('status').handler('',{});
        await commands.get('merro-export').handler('',{});
      } finally { await events.get('session_shutdown')(); }`;
    const result = await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", startup], { cwd, env: { PATH: `${bin}:${process.env.PATH}`, MERRO_RUNTIME: "" } });
    assert.match(result.stdout, /Merro initialized/);
    await requireWorkspace(cwd);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, ".merro", "export.json"), "utf8")).projects, []);
    await assert.rejects(readFile(join(root, "gh-called")), { code: "ENOENT" });
    if (gitRepository) {
      assert.equal((await systemCommandRunner.run("git", ["remote"], { cwd })).stdout, "");
      const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
      for (const pattern of ["/.wt/", "/.merro/"]) assert.equal(exclude.split("\n").filter((line) => line === pattern).length, 1);
    } else {
      await assert.rejects(readFile(join(cwd, ".git", "config")), { code: "ENOENT" });
    }
  });
}

test("/merro init excludes local state and preserves explicitly registered Projects across init and startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const bin = join(root, "bin");
  await mkdir(cwd);
  await mkdir(bin);
  const git = async (...args: string[]) => (await systemCommandRunner.run("git", args, { cwd })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await git("commit", "--allow-empty", "-m", "base");
  await git("remote", "add", "origin", "https://github.com/example/kinetix.git");
  await writeFile(join(bin, "pi"), "#!/bin/sh\ncase \"$1\" in --version) echo 1.0.0;; --help) echo '--tui-mode regular';; esac\n", { mode: 0o700 });
  await writeFile(join(bin, "tmux"), "#!/bin/sh\n[ \"$1\" != '-V' ] || echo 'tmux 3.6'\nexit 0\n", { mode: 0o700 });
  const repository = { nameWithOwner: "example/kinetix", url: "https://github.com/example/kinetix", sshUrl: "git@github.com:example/kinetix.git", defaultBranchRef: { name: "main" } };
  await writeFile(join(bin, "gh"), `#!/bin/sh\nif [ "$1" = auth ]; then exit 0; fi\nprintf '%s\\n' '${JSON.stringify(repository)}'\n`, { mode: 0o700 });
  const env = { PATH: `${bin}:${process.env.PATH}`, MERRO_RUNTIME: "" };
  const init = `import {registerCommands} from ${JSON.stringify(pathToFileURL(resolve("dist/src/tools/commands.js")).href)};
    const commands=new Map(); registerCommands({registerCommand(name,command){commands.set(name,command)}});
    await commands.get('merro').handler('init',{});`;
  const first = await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", init], { cwd, env });
  assert.match(first.stdout, /Merro initialized/);
  await requireWorkspace(cwd);
  const registration = `import merro from ${JSON.stringify(entrypoint)};
    const tools=new Map(); await merro({registerCommand(){},registerTool(tool){tools.set(tool.name,tool)},on(){}});
    await tools.get('merro_add_project').execute('register',{path:process.cwd(),slug:'kinetix'});`;
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", registration], { cwd, env });
  const config = join(cwd, ".merro", "config.json");
  const customConfig = '{"max_concurrent_tasks":2,"max_review_rounds":3}\n';
  await writeFile(config, customConfig);
  await writeFile(join(cwd, ".merro", "runtime", "sentinel"), "preserved");
  const state = join(cwd, ".merro", "state.db");
  const store = new MerroStore(state);
  assert.equal(store.getProject("kinetix")?.baseRemote, "https://github.com/example/kinetix.git");
  store.createObjective({ id: "private-goal", goal: "Keep existing state", projectSlugs: ["kinetix"], priority: "normal", state: "Stopped", issueScopes: [{ projectSlug: "kinetix", numbers: [96] }] });
  store.close();
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", init], { cwd, env });
  const restart = `import merro from ${JSON.stringify(entrypoint)};
    const events=new Map(); await merro({registerCommand(){},registerTool(){},on(name,handler){events.set(name,handler)}});
    await events.get('session_start')(); await events.get('session_shutdown')();`;
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", restart], { cwd, env });
  assert.equal(await readFile(config, "utf8"), customConfig);
  assert.equal(await readFile(join(cwd, ".merro", "runtime", "sentinel"), "utf8"), "preserved");
  const reopened = new MerroStore(state);
  assert.equal(reopened.getObjective("private-goal")?.goal, "Keep existing state");
  reopened.close();
  const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
  for (const pattern of ["/.wt/", "/.merro/"]) assert.equal(exclude.split("\n").filter((line) => line === pattern).length, 1);
  await writeFile(join(cwd, ".wt", "sentinel"), "ignored");
  assert.equal(await git("status", "--short"), "");
});

test("initialization works without Git installed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-no-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await initializeWorkspace(cwd, { async run(file, args) {
    if (file === "pi") return { stdout: args[0] === "--version" ? "1.0.0" : "--tui-mode", stderr: "" };
    if (file === "tmux") return { stdout: "tmux 3.6", stderr: "" };
    if (file === "git") throw new CommandError(file, args, Object.assign(new Error("Git missing"), { code: "ENOENT" }), "");
    throw new Error(`Unexpected dependency: ${file}`);
  } });
  await requireWorkspace(cwd);
  const store = new MerroStore(join(cwd, ".merro", "state.db"));
  try { assert.deepEqual(store.listProjects(), []); } finally { store.close(); }
});

test("initialization does not hide unexpected Git failures", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-git-fail-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(initializeWorkspace(cwd, { async run(file, args) {
    if (file === "pi") return { stdout: args[0] === "--version" ? "1.0.0" : "--tui-mode", stderr: "" };
    if (file === "tmux") return { stdout: "tmux 3.6", stderr: "" };
    if (file === "git") throw new CommandError(file, args, Object.assign(new Error("Git failed"), { code: 128 }), "fatal: detected dubious ownership");
    throw new Error(`Unexpected dependency: ${file}`);
  } }), /dubious ownership/);
  await assert.rejects(readFile(join(cwd, ".merro", "config.json")), { code: "ENOENT" });
});

test("initialization validates dependencies before creating workspace state", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-init-fail-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(initializeWorkspace(cwd, { async run(file, args) {
    if (file === "pi") return { stdout: args[0] === "--version" ? "1.0.0" : "--tui-mode", stderr: "" };
    if (file === "tmux") throw new Error("tmux is missing. Install tmux.");
    throw new Error(`Unexpected dependency: ${file}`);
  } }), /Install tmux/);
  await assert.rejects(readFile(join(cwd, ".merro", "config.json")), { code: "ENOENT" });
});
