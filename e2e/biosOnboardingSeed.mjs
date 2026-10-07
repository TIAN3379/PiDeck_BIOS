/** Empty synthetic knowledge store, deliberately without registered projects/permissions. */
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
const root = process.argv[2];
if (!root) throw new Error("knowledge root required");
await initializeKnowledgeStore({ root });
