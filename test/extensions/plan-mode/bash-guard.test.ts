import { strictEqual } from "node:assert";
import { test } from "node:test";
import { isDestructiveCommand } from "../../../extensions/plan-mode/bash-guard.ts";

// ── Safe commands (should return null) ─────────────────────────

test("ls is safe", () => {
  strictEqual(isDestructiveCommand("ls"), null);
});

test("ls -la is safe", () => {
  strictEqual(isDestructiveCommand("ls -la /tmp"), null);
});

test("cat file is safe", () => {
  strictEqual(isDestructiveCommand("cat file.txt"), null);
});

test("grep is safe", () => {
  strictEqual(isDestructiveCommand("grep foo file.txt"), null);
});

test("find is safe", () => {
  strictEqual(isDestructiveCommand("find . -name '*.ts'"), null);
});

test("echo is safe", () => {
  strictEqual(isDestructiveCommand("echo hello world"), null);
});

test("cd is safe", () => {
  strictEqual(isDestructiveCommand("cd /tmp"), null);
});

test("pwd is safe", () => {
  strictEqual(isDestructiveCommand("pwd"), null);
});

test("wc is safe", () => {
  strictEqual(isDestructiveCommand("wc -l file.txt"), null);
});

test("head is safe", () => {
  strictEqual(isDestructiveCommand("head -n 10 file.txt"), null);
});

test("sort is safe", () => {
  strictEqual(isDestructiveCommand("sort file.txt"), null);
});

test("diff is safe", () => {
  strictEqual(isDestructiveCommand("diff a.txt b.txt"), null);
});

test("compound safe commands", () => {
  strictEqual(isDestructiveCommand("ls && echo hi"), null);
});

test("pipeline safe commands", () => {
  strictEqual(isDestructiveCommand("cat file | grep foo | wc -l"), null);
});

// ── Destructive commands ──────────────────────────────────────

test("rm is blocked", () => {
  const result = isDestructiveCommand("rm file.txt");
  strictEqual(typeof result, "string");
  strictEqual(result!.includes("rm"), true);
});

test("rm -rf is blocked", () => {
  const result = isDestructiveCommand("rm -rf /tmp/test");
  strictEqual(typeof result, "string");
});

test("mv is blocked", () => {
  const result = isDestructiveCommand("mv a b");
  strictEqual(typeof result, "string");
});

test("cp is blocked", () => {
  const result = isDestructiveCommand("cp a b");
  strictEqual(typeof result, "string");
});

test("mkdir is blocked", () => {
  const result = isDestructiveCommand("mkdir newdir");
  strictEqual(typeof result, "string");
});

test("touch is blocked", () => {
  const result = isDestructiveCommand("touch file.txt");
  strictEqual(typeof result, "string");
});

test("chmod is blocked", () => {
  const result = isDestructiveCommand("chmod 755 file");
  strictEqual(typeof result, "string");
});

test("chown is blocked", () => {
  const result = isDestructiveCommand("chown user file");
  strictEqual(typeof result, "string");
});

test("dd is blocked", () => {
  const result = isDestructiveCommand("dd if=/dev/zero of=file bs=1M count=1");
  strictEqual(typeof result, "string");
});

test("npm install is blocked", () => {
  const result = isDestructiveCommand("npm install foo");
  strictEqual(typeof result, "string");
});

test("pip install is blocked", () => {
  const result = isDestructiveCommand("pip install foo");
  strictEqual(typeof result, "string");
});

test("cargo build is blocked", () => {
  const result = isDestructiveCommand("cargo build");
  strictEqual(typeof result, "string");
});

test("make is blocked", () => {
  const result = isDestructiveCommand("make");
  strictEqual(typeof result, "string");
});

test("gcc is blocked", () => {
  const result = isDestructiveCommand("gcc -o prog file.c");
  strictEqual(typeof result, "string");
});

test("tee is blocked", () => {
  const result = isDestructiveCommand("echo hi | tee file.txt");
  strictEqual(typeof result, "string");
});

test("wget is blocked", () => {
  const result = isDestructiveCommand("wget https://example.com");
  strictEqual(typeof result, "string");
});

test("vim is blocked", () => {
  const result = isDestructiveCommand("vim file.txt");
  strictEqual(typeof result, "string");
});

test("docker is blocked", () => {
  const result = isDestructiveCommand("docker ps");
  strictEqual(typeof result, "string");
});

test("terraform is blocked", () => {
  const result = isDestructiveCommand("terraform plan");
  strictEqual(typeof result, "string");
});

test("systemctl is blocked", () => {
  const result = isDestructiveCommand("systemctl status");
  strictEqual(typeof result, "string");
});

// ── Write redirects ───────────────────────────────────────────

test("write redirect > is blocked", () => {
  const result = isDestructiveCommand("echo hello > file.txt");
  strictEqual(typeof result, "string");
  strictEqual(result!.includes("write redirect"), true);
});

test("append redirect >> is blocked", () => {
  const result = isDestructiveCommand("echo hello >> file.txt");
  strictEqual(typeof result, "string");
});

test("clobber redirect >| is blocked", () => {
  const result = isDestructiveCommand("echo hello >| file.txt");
  strictEqual(typeof result, "string");
});

test("redirect to /dev/null is allowed", () => {
  strictEqual(isDestructiveCommand("echo hello > /dev/null"), null);
});

test("append to /dev/null is allowed", () => {
  strictEqual(isDestructiveCommand("echo hello >> /dev/null"), null);
});

test("stderr to /dev/null is allowed", () => {
  strictEqual(isDestructiveCommand("ls 2> /dev/null"), null);
});

test("all output to /dev/null is allowed", () => {
  strictEqual(isDestructiveCommand("command > /dev/null 2>&1"), null);
});

test("redirect to real path in pipeline is blocked", () => {
  const result = isDestructiveCommand("cat file | grep foo > out.txt");
  strictEqual(typeof result, "string");
});

// ── Compound / nested structures ──────────────────────────────

test("compound: cd && rm is blocked", () => {
  const result = isDestructiveCommand("cd /tmp && rm -rf test");
  strictEqual(typeof result, "string");
});

test("compound: ls && echo is safe", () => {
  strictEqual(isDestructiveCommand("ls -la && echo done"), null);
});

test("semicolon separated: one destructive blocks all", () => {
  const result = isDestructiveCommand("echo hi; rm file");
  strictEqual(typeof result, "string");
});

test("subshell with destructive command is blocked", () => {
  const result = isDestructiveCommand("(rm /tmp/x)");
  strictEqual(typeof result, "string");
});

test("subshell with safe command is allowed", () => {
  strictEqual(isDestructiveCommand("(ls /tmp)"), null);
});

test("for loop with destructive body is blocked", () => {
  const result = isDestructiveCommand("for f in *.txt; do rm $f; done");
  strictEqual(typeof result, "string");
});

test("if with destructive body is blocked", () => {
  const result = isDestructiveCommand("if true; then rm file; fi");
  strictEqual(typeof result, "string");
});

test("function definition with destructive body is blocked", () => {
  const result = isDestructiveCommand("foo() { rm file; }");
  strictEqual(typeof result, "string");
});

// ── git subcommands ───────────────────────────────────────────

test("git status is safe", () => {
  strictEqual(isDestructiveCommand("git status"), null);
});

test("git log is safe", () => {
  strictEqual(isDestructiveCommand("git log --oneline"), null);
});

test("git diff is safe", () => {
  strictEqual(isDestructiveCommand("git diff HEAD~1"), null);
});

test("git show is safe", () => {
  strictEqual(isDestructiveCommand("git show HEAD"), null);
});

test("git branch is safe", () => {
  strictEqual(isDestructiveCommand("git branch -a"), null);
});

test("git tag is safe", () => {
  strictEqual(isDestructiveCommand("git tag -l"), null);
});

test("git remote is safe", () => {
  strictEqual(isDestructiveCommand("git remote -v"), null);
});

test("git grep is safe", () => {
  strictEqual(isDestructiveCommand("git grep foo"), null);
});

test("git blame is safe", () => {
  strictEqual(isDestructiveCommand("git blame file.ts"), null);
});

test("git ls-files is safe", () => {
  strictEqual(isDestructiveCommand("git ls-files"), null);
});

test("git rev-parse is safe", () => {
  strictEqual(isDestructiveCommand("git rev-parse HEAD"), null);
});

test("git config is safe", () => {
  strictEqual(isDestructiveCommand("git config --list"), null);
});

test("git fetch is safe", () => {
  strictEqual(isDestructiveCommand("git fetch origin"), null);
});

test("git stash list is safe", () => {
  strictEqual(isDestructiveCommand("git stash list"), null);
});

test("git stash pop is blocked", () => {
  const result = isDestructiveCommand("git stash pop");
  strictEqual(typeof result, "string");
});

test("git stash without list is blocked", () => {
  const result = isDestructiveCommand("git stash");
  strictEqual(typeof result, "string");
});

test("git push is blocked", () => {
  const result = isDestructiveCommand("git push origin main");
  strictEqual(typeof result, "string");
});

test("git commit is blocked", () => {
  const result = isDestructiveCommand("git commit -m msg");
  strictEqual(typeof result, "string");
});

test("git merge is blocked", () => {
  const result = isDestructiveCommand("git merge feature");
  strictEqual(typeof result, "string");
});

test("git rebase is blocked", () => {
  const result = isDestructiveCommand("git rebase main");
  strictEqual(typeof result, "string");
});

test("git clean is blocked", () => {
  const result = isDestructiveCommand("git clean -fd");
  strictEqual(typeof result, "string");
});

test("git reset is blocked", () => {
  const result = isDestructiveCommand("git reset --hard HEAD");
  strictEqual(typeof result, "string");
});

test("git cherry-pick is blocked", () => {
  const result = isDestructiveCommand("git cherry-pick abc123");
  strictEqual(typeof result, "string");
});

// ── nix subcommands ───────────────────────────────────────────

test("nix flake show is safe", () => {
  strictEqual(isDestructiveCommand("nix flake show"), null);
});

test("nix flake metadata is safe", () => {
  strictEqual(isDestructiveCommand("nix flake metadata"), null);
});

test("nix flake check is safe", () => {
  strictEqual(isDestructiveCommand("nix flake check"), null);
});

test("nix flake update is blocked", () => {
  const result = isDestructiveCommand("nix flake update");
  strictEqual(typeof result, "string");
});

test("nix flake lock is blocked", () => {
  const result = isDestructiveCommand("nix flake lock");
  strictEqual(typeof result, "string");
});

test("nix build is blocked", () => {
  const result = isDestructiveCommand("nix build");
  strictEqual(typeof result, "string");
});

test("nix develop is blocked", () => {
  const result = isDestructiveCommand("nix develop");
  strictEqual(typeof result, "string");
});

test("nix run is blocked", () => {
  const result = isDestructiveCommand("nix run .#app");
  strictEqual(typeof result, "string");
});

test("nix eval is safe", () => {
  strictEqual(isDestructiveCommand("nix eval .#foo"), null);
});

test("nix store cat is safe", () => {
  strictEqual(isDestructiveCommand("nix store cat /nix/store/hash-foo"), null);
});

test("nix store delete is blocked", () => {
  const result = isDestructiveCommand("nix store delete /nix/store/hash");
  strictEqual(typeof result, "string");
});

test("nix derivation show is safe", () => {
  strictEqual(isDestructiveCommand("nix derivation show .#foo"), null);
});

test("nix show-config is safe", () => {
  strictEqual(isDestructiveCommand("nix show-config"), null);
});

test("nix search is safe", () => {
  strictEqual(isDestructiveCommand("nix search nixpkgs foo"), null);
});

// ── curl ──────────────────────────────────────────────────────

test("curl is safe without output flag", () => {
  strictEqual(isDestructiveCommand("curl https://example.com"), null);
});

test("curl -o is blocked", () => {
  const result = isDestructiveCommand("curl -o output.txt https://example.com");
  strictEqual(typeof result, "string");
});

test("curl -O is blocked", () => {
  const result = isDestructiveCommand("curl -O https://example.com/file");
  strictEqual(typeof result, "string");
});

test("curl --output is blocked", () => {
  const result = isDestructiveCommand("curl --output file.txt https://example.com");
  strictEqual(typeof result, "string");
});

// ── Parse failures ────────────────────────────────────────────

test("garbage input is blocked", () => {
  // Unclosed quote causes bash-parser to throw
  const result = isDestructiveCommand("'");
  strictEqual(typeof result, "string");
  strictEqual(result!.includes("parse"), true);
});

// ── Edge cases ────────────────────────────────────────────────

test("empty command is blocked (parse failure)", () => {
  const result = isDestructiveCommand("");
  strictEqual(typeof result, "string");
});

test("whitespace-only command is blocked (parse failure)", () => {
  const result = isDestructiveCommand("   ");
  strictEqual(typeof result, "string");
});

test("assignment-only command is not destructive itself", () => {
  // VAR=val cmd -- but if cmd is destructive it gets caught
  strictEqual(isDestructiveCommand("FOO=bar ls"), null);
});

test("assignment with destructive command is blocked", () => {
  const result = isDestructiveCommand("FOO=bar rm file");
  strictEqual(typeof result, "string");
});

test("sed without -i is safe (stream processor)", () => {
  strictEqual(isDestructiveCommand("sed 's/foo/bar/g' file.txt"), null);
});

test("awk without redirect is safe", () => {
  strictEqual(isDestructiveCommand("awk '{print $1}' file.txt"), null);
});

test("python is not unconditionally blocked", () => {
  strictEqual(isDestructiveCommand("python -c 'print(1+1)'"), null);
});

test("node is not unconditionally blocked", () => {
  strictEqual(isDestructiveCommand("node -e 'console.log(1)'"), null);
});
