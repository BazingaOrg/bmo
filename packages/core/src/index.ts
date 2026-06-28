export { openDb, defaultDbPath, EMBEDDING_DIM, type DB } from "./db/index.js";
export { eat, chunkText, chunkConfig, embed, EMBEDDING_MODEL, type EatInput, type EatResult } from "./ingest/index.js";
export { eatSource, parseToMarkdown, ParseError, isParseError, looksLikeUrl, type ParsedDoc, type ParseSource } from "./parse/index.js";
export { searchConfig, searchKnowledge, type SearchConfig, type SearchHit } from "./search/hybrid.js";
export { runAgent, runAgentStream, type AgentEvents, type ChatMessage } from "./agent/loop.js";
