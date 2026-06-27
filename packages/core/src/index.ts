export { openDb, defaultDbPath, EMBEDDING_DIM, type DB } from "./db/index.js";
export { eat, chunkText, embed, EMBEDDING_MODEL, type EatInput, type EatResult } from "./ingest/index.js";
export { searchKnowledge, type SearchHit } from "./search/hybrid.js";
export { runAgent, runAgentStream, type AgentEvents, type ChatMessage } from "./agent/loop.js";
