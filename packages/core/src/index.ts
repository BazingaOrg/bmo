export { openDb, defaultDbPath, EMBEDDING_DIM, type DB } from "./db/index.js";
export { eat, chunkText, chunkConfig, embed, EMBEDDING_MODEL, type EatInput, type EatResult, type EmbedOptions } from "./ingest/index.js";
export { eatSource, parseToMarkdown, ParseError, isParseError, looksLikeUrl, type ParsedDoc, type ParseSource } from "./parse/index.js";
export { searchConfig, searchKnowledge, type SearchConfig, type SearchHit } from "./search/hybrid.js";
export { runAgent, runAgentStream, type AgentEvents, type ChatMessage } from "./agent/loop.js";
export { createToolRegistry, type WebSource } from "./agent/tools.js";
export { generateWeeklyDigest, knowledgeStats, latestDigest, listDigests, type DigestRow, type DigestStats } from "./digest/index.js";
export { reembedKnowledge, type ReembedOptions, type ReembedProgress } from "./reembed/index.js";
export { readEnvFile, updateEnvFile, writeEnvFile } from "./env-file.js";
