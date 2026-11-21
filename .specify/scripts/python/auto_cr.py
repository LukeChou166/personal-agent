#!/usr/bin/env python3
"""Spec Kit auto-CR hook.

Commits the staged feature changes, pushes a feature branch, and returns a
review/diff link:

- With GITHUB_TOKEN / GH_TOKEN: opens a pull request via the GitHub API.
- Without a token: returns the GitHub compare URL (diff + "create PR" page).
- If push fails, the local commit is kept and the error is reported; no link
  is fabricated.

Safety: never force-pushes, never touches unrelated paths, never rewrites
history, and never runs `git commit` when nothing is staged.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

GITHUB_REMOTE_RE = re.compile(
    r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/.]+?)(?:\.git)?$"
)


class AutoCrError(RuntimeError):
    pass


def run(cmd: list[str], *, direct: bool = False, check: bool = True) -> str:
    git_cmd = ["git", "-c", "http.proxy="] + cmd[1:] if direct and cmd[0] == "git" else cmd
    proc = subprocess.run(
        git_cmd,
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if check and proc.returncode != 0:
        raise AutoCrError(
            f"command failed: {' '.join(git_cmd)}\n{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout.strip()


def git(*args: str, direct: bool = False, check: bool = True) -> str:
    return run(["git", *args], direct=direct, check=check)


def repo_root() -> Path:
    return Path(git("rev-parse", "--show-toplevel"))


def feature_name(root: Path) -> str:
    feature_json = root / ".specify" / "feature.json"
    if feature_json.exists():
        data = json.loads(feature_json.read_text(encoding="utf-8"))
        return Path(data.get("feature_directory", "feature")).name
    return "feature"


def default_base(current: str) -> str:
    candidates = ["main", "master"]
    branches = git("branch", "-a", "--format=%(refname:short)").splitlines()
    for candidate in candidates:
        if candidate in branches or f"origin/{candidate}" in branches:
            if candidate != current:
                return candidate
    return "main"


def ensure_branch(base: str, branch: str) -> str:
    current = git("rev-parse", "--abbrev-ref", "HEAD")
    if current == base:
        git("switch", "-c", branch)
        return branch
    if current != branch:
        # Never switch away from a user's working branch silently.
        raise AutoCrError(
            f"current branch is '{current}', expected base '{base}' or feature branch '{branch}'"
        )
    return current


def filter_ignored(paths: list[str]) -> list[str]:
    """Drop paths ignored by git so `git add` does not abort the whole batch."""
    if not paths:
        return []
    proc = subprocess.run(
        ["git", "check-ignore", "--stdin"],
        input="\n".join(paths),
        capture_output=True,
        text=True,
    )
    ignored = {line for line in proc.stdout.splitlines() if line.strip()}
    return [path for path in paths if path not in ignored]


def staged_paths(paths: list[str]) -> list[str]:
    if not paths:
        return [
            line
            for line in git("diff", "--cached", "--name-only").splitlines()
            if line.strip()
        ]
    for path in filter_ignored(paths):
        git("add", "--", path)
    return [
        line
        for line in git("diff", "--cached", "--name-only", "--", *paths).splitlines()
        if line.strip()
    ]


def preview_paths(paths: list[str]) -> list[str]:
    """Dry-run helper: list candidate files without touching the index."""
    paths = filter_ignored(paths)
    if not paths:
        return []
    tracked = git("diff", "--name-only", "--", *paths).splitlines()
    untracked = git(
        "ls-files", "--others", "--exclude-standard", "--", *paths
    ).splitlines()
    seen: list[str] = []
    for path in [*tracked, *untracked]:
        if path.strip() and path not in seen:
            seen.append(path)
    return seen


def parse_remote(url: str) -> tuple[str, str] | None:
    match = GITHUB_REMOTE_RE.search(url.strip())
    if not match:
        return None
    return match.group("owner"), match.group("repo")


def git_credential_token() -> str | None:
    """Read a GitHub token from the configured git credential helper."""
    try:
        proc = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in proc.stdout.splitlines():
        if line.startswith("password="):
            value = line[len("password=") :].strip()
            return value or None
    return None


def create_pull_request(
    owner: str, repo: str, head: str, base: str, title: str, token: str
) -> dict[str, str]:
    payload = json.dumps({"title": title, "head": head, "base": base}).encode()
    request = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}/pulls",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "spec-kit-auto-cr",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode())
            return {
                "pr_url": body.get("html_url", ""),
                "diff_url": body.get("diff_url", ""),
            }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        if exc.code == 422 and "already exists" in detail:
            query = urllib.request.Request(
                f"https://api.github.com/repos/{owner}/{repo}/pulls?state=open&head={owner}:{head}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "spec-kit-auto-cr",
                },
            )
            with urllib.request.urlopen(query, timeout=20) as response:
                items = json.loads(response.read().decode())
                if items:
                    return {
                        "pr_url": items[0].get("html_url", ""),
                        "diff_url": items[0].get("diff_url", ""),
                    }
        raise AutoCrError(f"GitHub API {exc.code}: {detail[:300]}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Commit, push and open a CR")
    parser.add_argument("--paths", nargs="*", default=[], help="paths to stage (default: already staged)")
    parser.add_argument("--from-hook", action="store_true", help="hook mode: use staged changes only")
    parser.add_argument("--feature-dir", default=None, help="specs/<feature> to include")
    parser.add_argument("--base", default=None)
    parser.add_argument("--branch", default=None)
    parser.add_argument("--message", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--no-proxy", action="store_true", help="disable git http.proxy for this run")
    parser.add_argument(
        "--pr-only",
        action="store_true",
        help="branch already has commits: push and open the CR without a new commit",
    )
    parser.add_argument(
        "--use-git-credential",
        action="store_true",
        help="when no env token is set, read the token from `git credential fill`",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    os.chdir(root)

    feature = feature_name(root)
    current = git("rev-parse", "--abbrev-ref", "HEAD")
    base = args.base or default_base(current)
    branch = args.branch or f"spec/{feature}"

    paths = list(args.paths)
    if args.feature_dir:
        paths.append(args.feature_dir)
    if args.from_hook and not paths:
        # The implement step can declare the batch's files instead of staging.
        paths = os.environ.get("SPECIFY_CR_PATHS", "").split()

    result: dict[str, object] = {
        "feature": feature,
        "base": base,
        "branch": branch,
        "dry_run": args.dry_run,
    }

    try:
        if args.dry_run:
            planned = preview_paths(paths)
            result.update({"status": "dry_run", "would_commit": planned})
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        changed = staged_paths(paths)
        if not changed:
            if not args.pr_only:
                result.update({"status": "no_changes"})
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
            current = git("rev-parse", "--abbrev-ref", "HEAD")
            if current == base:
                raise AutoCrError(
                    f"no commits ahead of '{base}'; commit before opening a CR"
                )
            branch = current
            result.update(
                {
                    "branch": branch,
                    "commit": git("rev-parse", "--short", "HEAD"),
                    "files": 0,
                }
            )
        else:
            ensure_branch(base, branch)
            message = args.message or f"feat: {feature} (auto CR)"
            # Pathspec-limited commit: previously staged unrelated files stay
            # staged and out of this commit.
            if paths:
                git("commit", "-m", message, "--", *filter_ignored(paths))
            else:
                git("commit", "-m", message)
            result.update(
                {
                    "commit": git("rev-parse", "--short", "HEAD"),
                    "files": len(changed),
                }
            )

        try:
            git("push", "-u", "origin", branch, direct=args.no_proxy)
        except AutoCrError as exc:
            if args.no_proxy:
                result.update({"status": "push_failed", "error": str(exc)[:500]})
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 1
            # A stale http.proxy is a common local failure; retry once direct.
            try:
                git("push", "-u", "origin", branch, direct=True)
            except AutoCrError as retry_exc:
                result.update(
                    {"status": "push_failed", "error": str(retry_exc)[:500]}
                )
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 1

        remote = parse_remote(git("remote", "get-url", "origin"))
        if not remote:
            result.update({"status": "pushed", "note": "remote is not GitHub; no CR link"})
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        owner, repo = remote
        title = args.title or message
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if not token and args.use_git_credential:
            token = git_credential_token()
        if token:
            links = create_pull_request(owner, repo, branch, base, title, token)
            result.update({"status": "pr_created", **links})
        else:
            result.update(
                {
                    "status": "pushed_no_token",
                    "pr_url": "",
                    "diff_url": f"https://github.com/{owner}/{repo}/compare/{base}...{branch}?expand=1",
                }
            )

        (root / ".specify" / "cr-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except AutoCrError as exc:
        result.update({"status": "error", "error": str(exc)[:800]})
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
