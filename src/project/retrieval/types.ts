import type { Confidentiality, KnowledgeRecord } from "../runtime.js";

export type EvidenceLocator = {
  start_line?: number; end_line?: number; start_char?: number; end_char?: number;
  section_path?: string[]; page?: number; image_index?: number;
};
export type EvidenceUnit = {
  id: string; record_id: string; artifact_id?: string; project_id: string;
  title: string; record_type: string; status: string; confidentiality: Confidentiality;
  kind: "text" | "image"; text: string; content_hash: string; source_revision: string;
  uri: string; locator: EvidenceLocator; source_refs: string[];
  image_path?: string; image_mime?: string; image_sha256?: string; image_uri?: string;
};
export type CorpusCoverage = {
  total_records: number; total_artifacts: number; text_artifacts: number; image_units: number;
  missing_documents: string[]; unparsed_artifacts: string[]; unavailable_images: string[];
  warnings: string[];
  text_unavailable_artifacts?: string[];
};
export type EvidenceCorpus = {
  revision: string; units: EvidenceUnit[];
  records: Array<{ record: KnowledgeRecord; body: string }>;
  coverage: CorpusCoverage;
};
export type RetrievalProvider = {
  fingerprint: string; textModel: string; imageModel: string; dimension: number;
  embedText(texts: string[], purpose: "query" | "document"): Promise<number[][]>;
  embedImages(images: string[]): Promise<number[][]>;
  embedImageQuery(query: string): Promise<number[]>;
  rerank?(query: string, units: EvidenceUnit[]): Promise<Array<{ index: number; score: number }>>;
};
export type RetrievalRequest = {
  query: string; project_id?: string; top_k?: number; max_per_source?: number;
  mode?: "hybrid" | "lexical" | "semantic"; intent?: "answer" | "collect";
  modality?: "all" | "text" | "image"; include_history?: boolean; include_unverified?: boolean;
  maximum_confidentiality?: Confidentiality; cursor?: string; rerank?: boolean;
  record_types?: string[]; record_ids?: string[]; preferred_record_ids?: string[];
};
export type EvidenceHit = { unit: EvidenceUnit; score: number; channels: string[] };
export type RetrievalResult = {
  results: EvidenceHit[]; revision: string; next_cursor?: string;
  coverage: Record<string, unknown>; warnings: string[]; models: Record<string, unknown>;
};
