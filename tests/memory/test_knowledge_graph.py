"""
Tests for write contention, corruption recovery, dedup, atomic writes, and load handling
of the hardened memory server (mcp/memory-server/).

These tests exercise the JSONL file-level behaviour that the TypeScript
KnowledgeGraphManager relies on.  All I/O is routed through the tmp_path
pytest fixture so the real memory/knowledge-graph.jsonl is never touched.

Concurrency is simulated with asyncio.gather() + asyncio.to_thread() so that
two coroutines truly run on separate OS threads while competing for the same
file, mirroring what two agent processes would do.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Helpers — a minimal Python mirror of KnowledgeGraphManager's core logic
# ---------------------------------------------------------------------------

def _make_entity(
    name: str,
    entity_type: str = "agent",
    observations: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "entity",
        "name": name,
        "entityType": entity_type,
        "observations": observations or [],
    }


def load_graph(path: Path) -> dict[str, Any]:
    """Read JSONL with auto-repair: skip corrupt lines, skip schema-invalid
    lines, deduplicate entries (first occurrence wins).

    Returns ``{"entities": [...], "relations": [...]}``.
    """
    entities: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []
    seen: set[str] = set()

    if not path.exists():
        return {"entities": [], "relations": []}

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not isinstance(record, dict):
            continue

        record_type = record.get("type")

        if record_type == "entity":
            name = record.get("name")
            entity_type = record.get("entityType")
            observations = record.get("observations")
            if not isinstance(name, str) or not name:
                continue
            if not isinstance(entity_type, str) or not entity_type:
                continue
            if not isinstance(observations, list):
                continue
            key = f"entity:{name}"
            if key in seen:
                continue
            seen.add(key)
            entities.append(
                {
                    "name": name,
                    "entityType": entity_type,
                    "observations": observations,
                }
            )

        elif record_type == "relation":
            from_ = record.get("from")
            to = record.get("to")
            relation_type = record.get("relationType")
            if (
                not isinstance(from_, str) or not from_ or
                not isinstance(to, str) or not to or
                not isinstance(relation_type, str) or not relation_type
            ):
                continue
            key = f"relation:{from_}:{to}:{relation_type}"
            if key in seen:
                continue
            seen.add(key)
            relations.append({"from": from_, "to": to, "relationType": relation_type})

    return {"entities": entities, "relations": relations}


def _graph_to_jsonl(graph: dict[str, Any]) -> str:
    lines = [
        json.dumps(
            {
                "type": "entity",
                "name": e["name"],
                "entityType": e["entityType"],
                "observations": e["observations"],
            }
        )
        for e in graph["entities"]
    ] + [
        json.dumps(
            {
                "type": "relation",
                "from": r["from"],
                "to": r["to"],
                "relationType": r["relationType"],
            }
        )
        for r in graph["relations"]
    ]
    return "\n".join(lines)


def atomic_write_sync(dest: Path, content: str) -> None:
    """Write *content* to *dest* atomically via a .tmp file + os.replace()."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(f"{dest}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, dest)


def append_entity_sync(path: Path, entity: dict[str, Any], lock: "LockType | None" = None) -> None:
    """Thread-safe read-modify-write that appends *entity* to *path*.

    Uses a threading.Lock (passed in as *lock*) to guard the full
    read→modify→write cycle, matching the async Mutex used by the TypeScript
    server's KnowledgeGraphManager.
    """
    with lock if lock is not None else _noop_context():
        graph = load_graph(path)
        if not any(e["name"] == entity["name"] for e in graph["entities"]):
            graph["entities"].append(
                {
                    "name": entity["name"],
                    "entityType": entity["entityType"],
                    "observations": entity["observations"],
                }
            )
        atomic_write_sync(path, _graph_to_jsonl(graph))


# Type alias used in append_entity_sync signature
LockType = threading.Lock


@contextmanager
def _noop_context():
    """A no-op context manager used when no lock is provided."""
    yield


# ---------------------------------------------------------------------------
# 1. Concurrent write test
#    Two asyncio tasks run in separate OS threads and both append a unique
#    entity.  A shared threading.Lock serialises the read-modify-write cycle
#    (mirroring the async Mutex in the TypeScript server).  Both entities must
#    be present in the final file with no data loss.
# ---------------------------------------------------------------------------

class TestConcurrentWrites:
    async def test_two_simultaneous_writes_both_succeed(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        lock = threading.Lock()

        entity_a = _make_entity("AgentA", observations=["wrote-first"])
        entity_b = _make_entity("AgentB", observations=["wrote-second"])

        await asyncio.gather(
            asyncio.to_thread(append_entity_sync, graph_file, entity_a, lock),
            asyncio.to_thread(append_entity_sync, graph_file, entity_b, lock),
        )

        graph = load_graph(graph_file)
        names = {e["name"] for e in graph["entities"]}
        assert "AgentA" in names, "AgentA write was lost"
        assert "AgentB" in names, "AgentB write was lost"
        assert len(graph["entities"]) == 2

    async def test_two_simultaneous_writes_preserve_existing_data(
        self, tmp_path: Path
    ) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        lock = threading.Lock()

        # Seed an entity before the concurrent operations begin
        seed = _make_entity("Seed", observations=["pre-existing"])
        atomic_write_sync(graph_file, _graph_to_jsonl({"entities": [seed], "relations": []}))

        await asyncio.gather(
            asyncio.to_thread(append_entity_sync, graph_file, _make_entity("AgentC"), lock),
            asyncio.to_thread(append_entity_sync, graph_file, _make_entity("AgentD"), lock),
        )

        graph = load_graph(graph_file)
        names = {e["name"] for e in graph["entities"]}
        assert names == {"Seed", "AgentC", "AgentD"}, f"Unexpected entities: {names}"


# ---------------------------------------------------------------------------
# 2. Corruption recovery test
#    Manually inject bad JSONL lines into the file, then verify that
#    load_graph() skips them cleanly and returns only the valid entries.
# ---------------------------------------------------------------------------

class TestCorruptionRecovery:
    def test_corrupt_json_lines_are_skipped(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    '{"type":"entity","name":"GoodA","entityType":"test","observations":[]}',
                    "THIS IS NOT JSON }{",
                    "",
                    '{"type":"entity","name":"GoodB","entityType":"test","observations":[]}',
                    '{"broken":',
                    '{"type":"entity","name":"GoodC","entityType":"test","observations":[]}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["entities"]) == 3
        names = {e["name"] for e in graph["entities"]}
        assert names == {"GoodA", "GoodB", "GoodC"}

    def test_all_corrupt_lines_yields_empty_graph(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text("garbage\n{incomplete\n!!!!\n", encoding="utf-8")

        graph = load_graph(graph_file)

        assert graph == {"entities": [], "relations": []}

    def test_schema_invalid_entity_is_skipped(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    # observations is null → schema-invalid
                    '{"type":"entity","name":"Bad","entityType":"test","observations":null}',
                    # missing name
                    '{"type":"entity","entityType":"test","observations":[]}',
                    # valid
                    '{"type":"entity","name":"Valid","entityType":"test","observations":[]}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["entities"]) == 1
        assert graph["entities"][0]["name"] == "Valid"

    def test_schema_invalid_relation_is_skipped(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    # missing 'from'
                    '{"type":"relation","to":"Bob","relationType":"knows"}',
                    # valid
                    '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["relations"]) == 1
        assert graph["relations"][0]["from"] == "Alice"

    def test_empty_file_yields_empty_graph(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text("", encoding="utf-8")

        assert load_graph(graph_file) == {"entities": [], "relations": []}

    def test_nonexistent_file_yields_empty_graph(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "does-not-exist.jsonl"

        assert load_graph(graph_file) == {"entities": [], "relations": []}


# ---------------------------------------------------------------------------
# 3. Dedup test
#    Write the same entity (or relation) twice; verify only one copy appears
#    in the loaded graph and that the first occurrence is kept.
# ---------------------------------------------------------------------------

class TestDedup:
    def test_duplicate_entity_lines_collapsed(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    '{"type":"entity","name":"Alice","entityType":"person","observations":["first"]}',
                    '{"type":"entity","name":"Alice","entityType":"person","observations":["duplicate"]}',
                    '{"type":"entity","name":"Bob","entityType":"person","observations":[]}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["entities"]) == 2
        alice = next(e for e in graph["entities"] if e["name"] == "Alice")
        # First occurrence wins
        assert alice["observations"] == ["first"]

    def test_duplicate_relation_lines_collapsed(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
                    '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["relations"]) == 1

    def test_write_same_entity_twice_via_append(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        lock = threading.Lock()

        entity = _make_entity("Solo", observations=["only-me"])

        # Sequential writes of the same entity should be idempotent
        append_entity_sync(graph_file, entity, lock)
        append_entity_sync(graph_file, entity, lock)

        graph = load_graph(graph_file)
        assert len(graph["entities"]) == 1
        assert graph["entities"][0]["name"] == "Solo"

    def test_corrupt_mixed_with_duplicates(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        graph_file.write_text(
            "\n".join(
                [
                    '{"type":"entity","name":"Alice","entityType":"person","observations":[]}',
                    "NOT JSON",
                    '{"type":"entity","name":"Alice","entityType":"person","observations":["dup"]}',
                    '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
                    '{"type":"relation","from":"Alice","to":"Bob","relationType":"knows"}',
                ]
            ),
            encoding="utf-8",
        )

        graph = load_graph(graph_file)

        assert len(graph["entities"]) == 1
        assert len(graph["relations"]) == 1


# ---------------------------------------------------------------------------
# 4. Atomic write / crash recovery test
#    Verify that atomic_write_sync uses a .tmp staging file and that the
#    final destination file is always valid JSONL after a successful write.
#    A stale .tmp file (simulating a crash mid-write) must not block the
#    next successful write.
# ---------------------------------------------------------------------------

class TestAtomicWrite:
    def test_no_stale_tmp_file_after_successful_write(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"

        atomic_write_sync(
            graph_file,
            _graph_to_jsonl(
                {
                    "entities": [_make_entity("Alpha")],
                    "relations": [],
                }
            ),
        )

        assert not Path(f"{graph_file}.tmp").exists(), ".tmp must be removed after rename"

    def test_destination_file_is_valid_jsonl_after_write(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"

        entity = _make_entity("Beta", observations=["note1"])
        atomic_write_sync(
            graph_file,
            _graph_to_jsonl({"entities": [entity], "relations": []}),
        )

        lines = [
            l for l in graph_file.read_text(encoding="utf-8").splitlines() if l.strip()
        ]
        assert len(lines) > 0

        for line in lines:
            json.loads(line)  # must not raise

    def test_stale_tmp_file_is_overwritten_on_next_write(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        tmp_file = Path(f"{graph_file}.tmp")

        # Simulate a crashed mid-write by leaving a stale .tmp
        tmp_file.write_text("STALE CONTENT", encoding="utf-8")
        assert tmp_file.exists()

        # The next write should overwrite the stale .tmp and complete atomically
        atomic_write_sync(
            graph_file,
            _graph_to_jsonl(
                {
                    "entities": [_make_entity("Gamma", observations=["fresh"])],
                    "relations": [],
                }
            ),
        )

        assert not tmp_file.exists(), ".tmp must be gone after successful write"
        graph = load_graph(graph_file)
        assert len(graph["entities"]) == 1
        assert graph["entities"][0]["name"] == "Gamma"

    def test_atomic_write_creates_parent_directories(self, tmp_path: Path) -> None:
        nested = tmp_path / "deep" / "nested" / "knowledge-graph.jsonl"

        atomic_write_sync(
            nested,
            _graph_to_jsonl({"entities": [_make_entity("Deep")], "relations": []}),
        )

        assert nested.exists()
        graph = load_graph(nested)
        assert graph["entities"][0]["name"] == "Deep"


# ---------------------------------------------------------------------------
# 5. Load test
#    Ten rapid sequential writes all complete correctly; every entity can be
#    read back from the final file.
# ---------------------------------------------------------------------------

class TestLoad:
    async def test_ten_rapid_sequential_writes_all_succeed(
        self, tmp_path: Path
    ) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        lock = threading.Lock()

        entities = [_make_entity(f"LoadEntity{i}", observations=[f"obs-{i}"]) for i in range(10)]

        for entity in entities:
            await asyncio.to_thread(append_entity_sync, graph_file, entity, lock)

        graph = load_graph(graph_file)
        assert len(graph["entities"]) == 10

        names = {e["name"] for e in graph["entities"]}
        for i in range(10):
            assert f"LoadEntity{i}" in names, f"LoadEntity{i} is missing from the graph"

    async def test_ten_concurrent_writes_all_succeed(self, tmp_path: Path) -> None:
        graph_file = tmp_path / "knowledge-graph.jsonl"
        lock = threading.Lock()

        entities = [
            _make_entity(f"ConcurrentEntity{i}", observations=[f"obs-{i}"])
            for i in range(10)
        ]

        await asyncio.gather(
            *(asyncio.to_thread(append_entity_sync, graph_file, e, lock) for e in entities)
        )

        graph = load_graph(graph_file)
        assert len(graph["entities"]) == 10

        names = {e["name"] for e in graph["entities"]}
        for i in range(10):
            assert f"ConcurrentEntity{i}" in names, f"ConcurrentEntity{i} is missing"
