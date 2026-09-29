import { emptyResonanceState, parseResonanceState, type ResonanceState } from '../../../shared/resonance';
import type { DatabaseManager } from '../DatabaseManager';

export class ResonanceRepository {
  public constructor(private readonly database: DatabaseManager) {}

  public read(): ResonanceState | null {
    const row = this.database.db.prepare('SELECT document FROM resonance_state WHERE id = 1').get() as { document: string } | undefined;
    return row ? parseResonanceState(JSON.parse(row.document)) : null;
  }

  // One atomic snapshot retains ordering, the temporary scene, and the selection together.
  public save(value: unknown): ResonanceState {
    const state = parseResonanceState(value);
    this.database.db.prepare(`INSERT INTO resonance_state (id, document, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`)
      .run(JSON.stringify(state), new Date().toISOString());
    return state;
  }

  public initialize(legacy: unknown): ResonanceState {
    return this.database.transaction(() => this.read() ?? this.save(legacy ?? emptyResonanceState()));
  }
}
