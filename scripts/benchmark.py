import time
import json
import os
from pathlib import Path
from ops.scheduler import _load_metric_entities

def generate_dummy_data(path, num_lines):
    with open(path, 'w', encoding='utf-8') as f:
        for i in range(num_lines):
            record = {
                "type": "entity",
                "name": f"metric:prompt:dummy-{i}:last-run",
                "entityType": "metric",
                "observations": [f"cadence_days: 7", f"last_run: 2026-03-16"]
            }
            f.write(json.dumps(record) + '\n')

def run_benchmark():
    test_path = Path('test_graph.jsonl')
    generate_dummy_data(test_path, 1000000)

    start = time.perf_counter()
    _load_metric_entities(test_path)
    end = time.perf_counter()

    print(f"Time taken: {end - start:.4f} seconds")

    os.remove(test_path)

if __name__ == '__main__':
    run_benchmark()
