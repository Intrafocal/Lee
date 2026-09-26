"""
Spikes: an Explore node that runs an agent in a git worktree as a timeboxed
``delegate`` task (v3 contracts §4). Deterministic, no model.

Lee launches the task with ``origin: {kind: 'explore', ref: '<exp id>/<node id>'}``
and a ``worktree: {slug, path, branch}``. Whenever such a task is relayed,
launched or changes status (the follower and the task routes call ``sync``),
the spike node follows it:

- task status -> spike status: running/waiting/idle/queued -> running,
  review -> review, done -> done, discarded -> discarded.
- On the first move to review or a closed status, and again on each later
  ``agent.turn_end`` while in review, evidence is captured into the spike's
  (single) evidence node: the agent's summary and lee_status (its claim, so
  ``claim: true``), the task's files, and from the worktree the diffstat, the
  diff against ``git merge-base HEAD <default branch>`` (working tree, so
  committed and uncommitted changes; untracked files listed, not included) and
  up to 20 commits since the merge base. The diff goes to
  ``.hester/explore/evidence/<exp>-<node>.diff`` (0600, capped at 512 KB).
  A missing worktree records evidence without a diff.

``sync`` never raises.
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from ..copilot.digest import _git, default_branch
from .explorations import EXP_ID_RE, NODE_ID_RE, ExplorationStore
from .tasks import MAX_COMMITS, atomic_write, clip, iso_s, utc_now

logger = logging.getLogger("hester.daemon.cockpit.spikes")

STATUS_MAP = {
    "running": "running", "waiting": "running", "idle": "running", "queued": "running",
    "review": "review", "done": "done", "discarded": "discarded",
}
EVIDENCE_STATUSES = ("review", "done", "discarded")
MAX_DIFF_BYTES = 512 * 1024
MAX_EVIDENCE_FILES = 200
MAX_UNTRACKED = 100
MAX_DIFFSTAT_LINES = 40


def parse_ref(ref: Any) -> Tuple[Optional[str], Optional[str]]:
    """``exp-1a2b3c4d/n-5e6f7a8b`` -> (exp id, node id); (None, None) otherwise."""
    if not isinstance(ref, str) or "/" not in ref:
        return None, None
    exp_id, _, node_id = ref.partition("/")
    if not EXP_ID_RE.match(exp_id) or not NODE_ID_RE.match(node_id):
        return None, None
    return exp_id, node_id


def evidence_rel_path(exp_id: str, node_id: str) -> str:
    return f".hester/explore/evidence/{exp_id}-{node_id}.diff"


def _write_diff(workspace: Path, rel: str, text: str) -> None:
    data = text.encode("utf-8", errors="replace")
    if len(data) > MAX_DIFF_BYTES:
        cut = data[:MAX_DIFF_BYTES].decode("utf-8", errors="ignore")
        cut = cut[: cut.rfind("\n") + 1] if "\n" in cut else cut
        text = cut + f"# … truncated: the full diff is {len(data)} bytes, capped at {MAX_DIFF_BYTES}\n"
    path = Path(workspace) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    atomic_write(path, text)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def capture_evidence(workspace: Path, exp_id: str, node_id: str, task: Dict[str, Any], worktree: Optional[Dict[str, Any]],
                     now: Optional[datetime] = None) -> Dict[str, Any]:
    """The evidence record for a spike's task; writes the diff file when the worktree is there."""
    now = now or utc_now()
    lee_status = task.get("lee_status") if isinstance(task.get("lee_status"), dict) else None
    summary = (lee_status or {}).get("summary") or task.get("summary")
    evidence: Dict[str, Any] = {
        "task_id": task.get("id"),
        "summary": clip(summary) if summary else None,
        "lee_status": lee_status,
        "files": [f for f in task.get("files") or [] if isinstance(f, str)][:MAX_EVIDENCE_FILES],
        "diffstat": None,
        "diff_path": None,
        "commits": [],
        "untracked": [],
        "captured_at": iso_s(now),
        "claim": True,
    }
    path = (worktree or {}).get("path")
    wt = Path(path) if isinstance(path, str) and path else None
    if wt is None or not wt.is_dir() or _git(wt, "rev-parse", "--is-inside-work-tree") is None:
        return evidence
    # Resolve the default branch to a commit in the workspace: inside the
    # worktree, "HEAD" (the fallback name) would mean the spike's own tip.
    ws_path = Path(workspace)
    branch = default_branch(ws_path) if _git(ws_path, "rev-parse", "--git-dir") is not None else None
    target = _git(ws_path, "rev-parse", "--verify", "--quiet", f"{branch}^{{commit}}") if branch else None
    target = target.strip() if target else None
    base = _git(wt, "merge-base", "HEAD", target) if target else None
    base = base.strip() if base else None
    if not base:
        return evidence
    stat = _git(wt, "diff", "--no-color", "--no-ext-diff", "--stat", base) or ""
    diff = _git(wt, "diff", "--no-color", "--no-ext-diff", base) or ""
    untracked = [u for u in (_git(wt, "ls-files", "--others", "--exclude-standard") or "").splitlines() if u.strip()]
    log = _git(wt, "log", "--format=%H", f"--max-count={MAX_COMMITS}", f"{base}..HEAD") or ""
    stat_lines = stat.rstrip("\n").splitlines()
    if len(stat_lines) > MAX_DIFFSTAT_LINES:
        stat_lines = [f"… {len(stat_lines) - MAX_DIFFSTAT_LINES} more lines"] + stat_lines[-MAX_DIFFSTAT_LINES:]
    evidence["diffstat"] = "\n".join(stat_lines) or None
    evidence["commits"] = [line.strip()[:7] for line in log.splitlines() if line.strip()]
    evidence["untracked"] = untracked[:MAX_UNTRACKED]
    header = [f"# Spike evidence for {exp_id}/{node_id} (task {task.get('id')}), diff against merge-base {base[:12]}"]
    if untracked:
        header.append("# Untracked files (contents not included): " + ", ".join(untracked[:MAX_UNTRACKED]))
    rel = evidence_rel_path(exp_id, node_id)
    _write_diff(Path(workspace), rel, "\n".join(header) + "\n" + diff)
    evidence["diff_path"] = rel
    return evidence


def sync(ctx, task: Dict[str, Any], turn_end: bool = False, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Bring an ``explore``-origin task's spike node up to date. Returns the spike node or None. Never raises."""
    try:
        origin = task.get("origin") or {}
        if origin.get("kind") != "explore":
            return None
        exp_id, node_id = parse_ref(origin.get("ref"))
        if exp_id is None:
            return None
        store: ExplorationStore = ctx.explorations()
        exp = store.get(exp_id)
        if exp is None:
            return None
        node = next((n for n in exp["nodes"] if n["id"] == node_id), None)
        if node is None or node["kind"] != "spike":
            return None
        spike = node.get("spike") or {}
        if spike.get("task_id") and spike["task_id"] != task.get("id"):
            return None
        patch: Dict[str, Any] = {}
        if not spike.get("task_id"):
            patch["task_id"] = task.get("id")
        if isinstance(task.get("worktree"), dict) and not spike.get("worktree"):
            patch["worktree"] = task["worktree"]
        prev = spike.get("status")
        new = STATUS_MAP.get(task.get("status"))
        if new and new != prev:
            patch["status"] = new
        if patch:
            node = store.update_spike(exp_id, node_id, patch, now)
        has_evidence = any(n["kind"] == "evidence" and n["parent"] == node_id for n in exp["nodes"])
        if new in EVIDENCE_STATUSES and (
            prev not in EVIDENCE_STATUSES or not has_evidence or (new == "review" and turn_end)
        ):
            worktree = (node.get("spike") or {}).get("worktree") or task.get("worktree")
            evidence = capture_evidence(Path(ctx.path), exp_id, node_id, task, worktree, now)
            store.add_evidence(exp_id, node_id, evidence, now)
        return node
    except Exception as e:
        logger.warning(f"Spike sync failed for {task.get('id')}: {e}")
        return None

