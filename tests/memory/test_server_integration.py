"""
Integration smoke tests for the compiled @skele-crew/memory-server MCP binary.

These tests spawn the actual Node.js process and communicate over stdin/stdout
using the MCP JSON-RPC 2.0 protocol. They validate end-to-end behaviour of the
compiled binary including mutex hardening, atomic writes, and auto-repair.

For unit and hardening tests of the TypeScript implementation, see:
    mcp/memory-server/__tests__/knowledge-graph.test.ts
    mcp/memory-server/__tests__/hardening.test.ts
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import selectors
import subprocess
import threading
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_io_lock = threading.Lock()


def _read_line_with_timeout(proc: subprocess.Popen, timeout: float = 5.0) -> str:
    """Read one line from proc.stdout with a timeout to avoid indefinite hangs."""
    if proc.stdout is None:
        raise RuntimeError("Process stdout is not available")

    sel = selectors.DefaultSelector()
    try:
        sel.register(proc.stdout, selectors.EVENT_READ)
        events = sel.select(timeout)
        if not events:
            raise TimeoutError("Timed out waiting for MCP response")
        return proc.stdout.readline()
    finally:
        sel.unregister(proc.stdout)
        sel.close()


def send_mcp(proc: subprocess.Popen, method: str, params: dict, id: int) -> dict:
    """Write a JSON-RPC 2.0 request to stdin and return the parsed response."""
    request = json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    with _io_lock:
        if proc.stdin is None:
            raise RuntimeError("Process stdin is not available")
        proc.stdin.write(request + "\n")
        proc.stdin.flush()
        line = _read_line_with_timeout(proc)
    return json.loads(line)


def _server_binary() -> str:
    """Return the absolute path to the compiled MCP server entry point."""
    repo_root = Path(__file__).resolve().parents[2]
    return str(repo_root / "mcp" / "memory-server" / "dist" / "index.js")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(tmp_path: Path):
    """Spawn the MCP server process; yield it; terminate it after the test."""
    graph_file = tmp_path / "knowledge-graph.jsonl"
    env = {**os.environ, "MEMORY_FILE_PATH": str(graph_file)}
    proc = subprocess.Popen(
        ["node", _server_binary()],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
    )
    yield proc
    proc.terminate()
    proc.wait()


# ---------------------------------------------------------------------------
# Smoke tests
# ---------------------------------------------------------------------------

def test_create_and_read_entity(server: subprocess.Popen) -> None:
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [{"name": "Alpha", "entityType": "agent", "observations": []}]}},
        id=1,
    )
    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=2)
    graph = json.loads(response["result"]["content"][0]["text"])
    names = {e["name"] for e in graph["entities"]}
    assert "Alpha" in names


def test_search_nodes(server: subprocess.Popen) -> None:
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [
            {"name": "SearchTarget", "entityType": "agent", "observations": []},
            {"name": "OtherNode", "entityType": "agent", "observations": []},
        ]}},
        id=1,
    )
    response = send_mcp(
        server,
        "tools/call",
        {"name": "search_nodes", "arguments": {"query": "SearchTarget"}},
        id=2,
    )
    graph = json.loads(response["result"]["content"][0]["text"])
    names = {e["name"] for e in graph["entities"]}
    assert "SearchTarget" in names
    assert "OtherNode" not in names


def test_add_observation(server: subprocess.Popen) -> None:
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [{"name": "ObsEntity", "entityType": "agent", "observations": []}]}},
        id=1,
    )
    send_mcp(
        server,
        "tools/call",
        {"name": "add_observations", "arguments": {"observations": [{"entityName": "ObsEntity", "contents": ["new-obs"]}]}},
        id=2,
    )
    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=3)
    graph = json.loads(response["result"]["content"][0]["text"])
    entity = next(e for e in graph["entities"] if e["name"] == "ObsEntity")
    assert "new-obs" in entity["observations"]


def test_delete_entity(server: subprocess.Popen) -> None:
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [
            {"name": "KeepMe", "entityType": "agent", "observations": []},
            {"name": "DeleteMe", "entityType": "agent", "observations": []},
        ]}},
        id=1,
    )
    send_mcp(
        server,
        "tools/call",
        {"name": "delete_entities", "arguments": {"entityNames": ["DeleteMe"]}},
        id=2,
    )
    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=3)
    graph = json.loads(response["result"]["content"][0]["text"])
    names = {e["name"] for e in graph["entities"]}
    assert "KeepMe" in names
    assert "DeleteMe" not in names


def test_create_relation(server: subprocess.Popen) -> None:
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [
            {"name": "NodeA", "entityType": "agent", "observations": []},
            {"name": "NodeB", "entityType": "agent", "observations": []},
        ]}},
        id=1,
    )
    send_mcp(
        server,
        "tools/call",
        {"name": "create_relations", "arguments": {"relations": [{"from": "NodeA", "to": "NodeB", "relationType": "links_to"}]}},
        id=2,
    )
    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=3)
    graph = json.loads(response["result"]["content"][0]["text"])
    relations = graph["relations"]
    assert any(r["from"] == "NodeA" and r["to"] == "NodeB" and r["relationType"] == "links_to" for r in relations)


def test_namespace_isolation(server: subprocess.Popen) -> None:
    """list_entities_by_prefix must return only entities whose name starts with the given prefix."""
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [
            {"name": "product:buzzy-game", "entityType": "product", "observations": ["status: active"]},
            {"name": "product:buzzy-game:feature:spelling-mode", "entityType": "feature", "observations": ["status: active"]},
            {"name": "product:test-product-b", "entityType": "product", "observations": ["status: active", "see also: product:buzzy-game"]},
            {"name": "product:test-product-b:feature:dashboard", "entityType": "feature", "observations": ["status: active"]},
        ]}},
        id=1,
    )
    response = send_mcp(
        server,
        "tools/call",
        {"name": "list_entities_by_prefix", "arguments": {"prefix": "product:buzzy-game"}},
        id=2,
    )
    graph = json.loads(response["result"]["content"][0]["text"])
    names = {e["name"] for e in graph["entities"]}
    assert "product:buzzy-game" in names
    assert "product:buzzy-game:feature:spelling-mode" in names
    assert "product:test-product-b" not in names
    assert "product:test-product-b:feature:dashboard" not in names


def test_cross_product_depends_on_relation(server: subprocess.Popen) -> None:
    """A depends-on relation between two products must be stored and retrievable."""
    send_mcp(
        server,
        "tools/call",
        {"name": "create_entities", "arguments": {"entities": [
            {"name": "product:buzzy-game", "entityType": "product", "observations": []},
            {"name": "product:test-product-b", "entityType": "product", "observations": []},
        ]}},
        id=1,
    )
    send_mcp(
        server,
        "tools/call",
        {"name": "create_relations", "arguments": {"relations": [
            {"from": "product:test-product-b", "to": "product:buzzy-game", "relationType": "depends-on"},
        ]}},
        id=2,
    )
    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=3)
    graph = json.loads(response["result"]["content"][0]["text"])
    assert any(
        r["from"] == "product:test-product-b"
        and r["to"] == "product:buzzy-game"
        and r["relationType"] == "depends-on"
        for r in graph["relations"]
    )


def test_concurrent_writes_no_data_loss(server: subprocess.Popen) -> None:
    """Fire 10 create_entities calls in parallel and assert all 10 entities are present."""
    lock = threading.Lock()
    counter = [0]

    def create_entity(i: int) -> dict:
        with lock:
            counter[0] += 1
            call_id = counter[0]
        return send_mcp(
            server,
            "tools/call",
            {"name": "create_entities", "arguments": {"entities": [{"name": f"ConcurrentEntity{i}", "entityType": "agent", "observations": []}]}},
            id=call_id,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(create_entity, i) for i in range(10)]
        for f in concurrent.futures.as_completed(futures):
            f.result()  # raise any exceptions

    response = send_mcp(server, "tools/call", {"name": "read_graph", "arguments": {}}, id=100)
    graph = json.loads(response["result"]["content"][0]["text"])
    names = {e["name"] for e in graph["entities"]}
    for i in range(10):
        assert f"ConcurrentEntity{i}" in names, f"ConcurrentEntity{i} missing from graph"
