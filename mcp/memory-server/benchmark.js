import { KnowledgeGraphManager } from './dist/index.js';
import fs from 'fs/promises';
import path from 'path';

async function runBenchmark() {
    const tmpPath = path.resolve(process.cwd(), 'benchmark-memory.jsonl');

    // Create large mock graph
    const N = 50000; // relations in graph
    const M = 10000; // relations to delete

    console.log(`Setting up benchmark with ${N} relations in graph, deleting ${M} relations...`);
    let content = '';
    for (let i = 0; i < N; i++) {
        content += JSON.stringify({
            type: 'relation',
            from: `nodeA_${i}`,
            to: `nodeB_${i}`,
            relationType: `type_${i % 10}`
        }) + '\n';
    }
    await fs.writeFile(tmpPath, content, 'utf-8');

    const manager = new KnowledgeGraphManager(tmpPath);

    const toDelete = [];
    for (let i = 0; i < M; i++) {
        toDelete.push({
            from: `nodeA_${i * 2}`,
            to: `nodeB_${i * 2}`,
            relationType: `type_${(i * 2) % 10}`
        });
    }

    // Benchmark deleteRelations
    const start = process.hrtime.bigint();
    await manager.deleteRelations(toDelete);
    const end = process.hrtime.bigint();

    console.log(`deleteRelations took ${(Number(end - start) / 1_000_000).toFixed(2)} ms`);

    await fs.unlink(tmpPath);
}

runBenchmark().catch(console.error);
