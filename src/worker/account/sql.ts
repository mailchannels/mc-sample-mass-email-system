/** Small SQL interface shared by account handlers. The only implementation lives inside AccountDO. */
export interface Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
  success: true;
}
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<Result<T>>;
  run(): Promise<Result>;
}
export interface AccountStore {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<Result[]>;
}
export class SqlStore implements AccountStore {
  constructor(private storage: DurableObjectStorage) {}
  prepare(query: string): Statement {
    return new SqlStatement(this.storage.sql, query);
  }
  async batch(statements: Statement[]): Promise<Result[]> {
    return this.storage.transactionSync(() =>
      statements.map((statement) => (statement as SqlStatement).execute()),
    );
  }
}
class SqlStatement implements Statement {
  constructor(
    private sql: SqlStorage,
    private query: string,
    private values: unknown[] = [],
  ) {}
  bind(...values: unknown[]): Statement {
    return new SqlStatement(this.sql, this.query, values);
  }
  execute<T = Record<string, unknown>>(): Result<T> {
    // SQLite DO accepts positional parameters; preserve D1's repeated numbered bindings.
    const bindings: SqlStorageValue[] = [];
    const query = this.query.replace(/\?(\d+)/g, (_, index: string) => {
      bindings.push(this.values[Number(index) - 1] as SqlStorageValue);
      return "?";
    });
    const cursor = this.sql.exec(query, ...bindings);
    const results = cursor.toArray() as T[];
    const changes = Number(this.sql.exec("SELECT changes() AS n").one().n);
    return { results, meta: { changes }, success: true };
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0];
    return (row ? (column ? row[column] : row) : null) as T | null;
  }
  async all<T>(): Promise<Result<T>> {
    return this.execute<T>();
  }
  async run(): Promise<Result> {
    return this.execute();
  }
}
