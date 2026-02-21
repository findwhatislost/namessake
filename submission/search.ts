/**
 * TODO: implement your name matching logic.
 *
 * Contract:
 *
 * setup(datasetPath):
 * - Called once before any search() calls with the path to the dataset CSV.
 * - Use this to load, parse, and index the dataset.
 * - Time spent here is reported separately and does NOT count toward QPS.
 * - Optional: if not exported, the scorer skips it.
 *
 * search(query):
 * - Input: query name string
 * - Output: list of matching record IDs from the dataset
 *
 * cleanup():
 * - Called once after all search() calls complete.
 * - Use this to tear down resources (DB connections, temp files, etc.).
 * - Optional: if not exported, the scorer skips it.
 */
export async function setup(_datasetPath: string): Promise<void> {
  // TODO: load and preprocess the dataset
}

export async function search(_query: string): Promise<string[]> {
  return [];
}

export async function cleanup(): Promise<void> {
  // TODO: tear down any resources (DB connections, temp files, etc.)
}

export default search;
