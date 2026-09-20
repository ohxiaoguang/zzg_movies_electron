export const sourceTransferJournalMigration = {
  version: 16,
  sql: `CREATE TABLE source_transfer_journal (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  );`,
};
