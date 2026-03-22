import { KnowledgeGraphManager } from './index.js';
import fs from 'fs';
import path from 'path';

async function runBenchmark() {
    const memoryFilePath = path.join(process.cwd(), 'test-benchmark-memory.json');
    if (fs.existsSync(memoryFilePath)) {
        fs.unlinkSync(memoryFilePath);
    }

    // Seed the graph with 10,000 relations
    const manager = new KnowledgeGraphManager(memoryFilePath);
    const initialRelations = [];
    for (let i = 0; i < 10000; i++) {
        initialRelations.push({
            from: `entity${i}`,
            to: `entity${i+1}`,
            relationType: 'connects_to'
        });
    }

    console.log("Seeding initial 10k relations...");
    await manager.createRelations(initialRelations);

    // Now benchmark adding 1,000 relations (500 new, 500 existing)
    const newRelations = [];
    for (let i = 9500; i < 10500; i++) {
        newRelations.push({
            from: `entity${i}`,
            to: `entity${i+1}`,
            relationType: 'connects_to'
        });
    }

    console.log("Running benchmark...");
    const start = performance.now();
    await manager.createRelations(newRelations);
    const end = performance.now();

    console.log(`Time taken: ${(end - start).toFixed(2)} ms`);

    if (fs.existsSync(memoryFilePath)) {
        fs.unlinkSync(memoryFilePath);
    }
}

runBenchmark().catch(console.error);
