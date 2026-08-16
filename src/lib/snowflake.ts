import snowflake from "snowflake-sdk";

const TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean(
    process.env.SNOWFLAKE_ACCOUNT &&
      process.env.SNOWFLAKE_USERNAME &&
      process.env.SNOWFLAKE_PASSWORD
  );
}

// a hung connection or query should never be able to stall the actual
// translation the user is waiting on, no matter what's wrong on Snowflake's end
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    ),
  ]);
}

function connect(): Promise<snowflake.Connection> {
  const connection = snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USERNAME!,
    password: process.env.SNOWFLAKE_PASSWORD!,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
  });

  console.log("[snowflake] connecting...");
  return new Promise((resolve, reject) => {
    connection.connect((err, conn) => {
      if (err) return reject(err);
      console.log("[snowflake] connected");
      resolve(conn);
    });
  });
}

function execute(connection: snowflake.Connection, sqlText: string, binds: snowflake.Binds = []) {
  console.log("[snowflake] executing:", sqlText);
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) return reject(err);
        console.log("[snowflake] query done");
        resolve(rows ?? []);
      },
    });
  });
}

// best-effort: a failed (or slow) log shouldn't ever break a translation for the user
export async function logTranslation(
  breed: string,
  caption: string,
  engine: string | null,
  confidence: number | null
) {
  if (!isConfigured()) return;

  try {
    const connection = await withTimeout(connect(), "connect");
    await withTimeout(
      execute(connection, "INSERT INTO translations (breed, caption, engine, confidence) VALUES (?, ?, ?, ?)", [
        breed,
        caption,
        engine,
        confidence,
      ]),
      "insert"
    );
    connection.destroy(() => {});
  } catch (err) {
    console.error("[snowflake] log failed:", err);
  }
}

// how many times this exact breed has been guessed so far, to show next to
// a fresh result ("golden retriever, guessed 4 times so far") instead of
// only as an abstract number in the aggregate stats further down the page
export async function getBreedCount(breed: string): Promise<number | null> {
  if (!isConfigured()) return null;

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(connection, "SELECT COUNT(*) AS count FROM translations WHERE breed = ?", [breed]),
      "breed count query"
    );
    connection.destroy(() => {});
    return rows[0] ? Number(rows[0].COUNT) : null;
  } catch (err) {
    console.error("[snowflake] breed count query failed:", err);
    return null;
  }
}

// where this confidence score falls among every stored confidence score so
// far, rows logged before the confidence column existed are just skipped
export async function getConfidencePercentile(score: number): Promise<number | null> {
  if (!isConfigured()) return null;

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(
        connection,
        `SELECT ROUND(100.0 * COUNT(CASE WHEN confidence <= ? THEN 1 END) / NULLIF(COUNT(confidence), 0)) AS percentile
         FROM translations`,
        [score]
      ),
      "confidence percentile query"
    );
    connection.destroy(() => {});
    const value = rows[0]?.PERCENTILE;
    return value === null || value === undefined ? null : Number(value);
  } catch (err) {
    console.error("[snowflake] confidence percentile query failed:", err);
    return null;
  }
}

export async function getBreedLeaderboard(): Promise<{ breed: string; count: number }[]> {
  if (!isConfigured()) return [];

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(connection, "SELECT breed, COUNT(*) AS count FROM translations GROUP BY breed ORDER BY count DESC LIMIT 5"),
      "leaderboard query"
    );
    connection.destroy(() => {});
    return rows.map((r) => ({ breed: String(r.BREED), count: Number(r.COUNT) }));
  } catch (err) {
    console.error("[snowflake] leaderboard query failed:", err);
    return [];
  }
}

export type Stats = {
  total: number;
  uniqueBreeds: number;
  hfCount: number;
  googleCount: number;
  chaosCount: number;
  uncertainCount: number;
};

// "uncertain" captions are the ones dogLine.ts writes when the model wasn't
// confident, they always contain "not sure" or "might be", the confident
// phrasing never does, so this can be read straight off the caption text,
// no extra column needed
export async function getStats(): Promise<Stats | null> {
  if (!isConfigured()) return null;

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(
        connection,
        `SELECT
           COUNT(*) AS total,
           COUNT(DISTINCT breed) AS unique_breeds,
           SUM(CASE WHEN engine = 'hf' THEN 1 ELSE 0 END) AS hf_count,
           SUM(CASE WHEN engine = 'google' THEN 1 ELSE 0 END) AS google_count,
           SUM(CASE WHEN engine = 'chaos' THEN 1 ELSE 0 END) AS chaos_count,
           SUM(CASE WHEN caption ILIKE '%not sure%' OR caption ILIKE '%might be%' THEN 1 ELSE 0 END) AS uncertain_count
         FROM translations`
      ),
      "stats query"
    );
    connection.destroy(() => {});
    const r = rows[0];
    if (!r) return null;
    return {
      total: Number(r.TOTAL),
      uniqueBreeds: Number(r.UNIQUE_BREEDS),
      hfCount: Number(r.HF_COUNT),
      googleCount: Number(r.GOOGLE_COUNT),
      chaosCount: Number(r.CHAOS_COUNT),
      uncertainCount: Number(r.UNCERTAIN_COUNT),
    };
  } catch (err) {
    console.error("[snowflake] stats query failed:", err);
    return null;
  }
}

export type PunchlineCount = { punchline: string; count: number };

// checks which of the fixed punchlines from dogLine.ts shows up in each
// caption, a cheap way to see whether the random picker is actually uniform
export async function getPunchlineStats(): Promise<PunchlineCount[]> {
  if (!isConfigured()) return [];

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(
        connection,
        `SELECT
           CASE
             WHEN caption ILIKE '%snacks%' THEN 'snacks'
             WHEN caption ILIKE '%treat immediately%' THEN 'treat immediately'
             WHEN caption ILIKE '%judging you%' THEN 'judging you'
             WHEN caption ILIKE '%squirrels%' THEN 'squirrels'
             WHEN caption ILIKE '%regret%' THEN 'regret'
             WHEN caption ILIKE '%very good boy%' THEN 'very good boy'
             ELSE 'other'
           END AS punchline,
           COUNT(*) AS count
         FROM translations
         GROUP BY punchline
         ORDER BY count DESC`
      ),
      "punchline stats query"
    );
    connection.destroy(() => {});
    return rows.map((r) => ({ punchline: String(r.PUNCHLINE), count: Number(r.COUNT) }));
  } catch (err) {
    console.error("[snowflake] punchline stats query failed:", err);
    return [];
  }
}

export type HourlyCount = { hour: string; count: number };

export async function getHourlyTrend(): Promise<HourlyCount[]> {
  if (!isConfigured()) return [];

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(
        connection,
        `SELECT hour, count FROM (
           SELECT TO_VARCHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD HH24:MI') AS hour, COUNT(*) AS count
           FROM translations
           GROUP BY hour
           ORDER BY hour DESC
           LIMIT 24
         )
         ORDER BY hour ASC`
      ),
      "hourly trend query"
    );
    connection.destroy(() => {});
    return rows.map((r) => ({ hour: String(r.HOUR), count: Number(r.COUNT) }));
  } catch (err) {
    console.error("[snowflake] hourly trend query failed:", err);
    return [];
  }
}

export type RecentTranslation = { breed: string; caption: string };

export async function getRecentTranslations(): Promise<RecentTranslation[]> {
  if (!isConfigured()) return [];

  try {
    const connection = await withTimeout(connect(), "connect");
    const rows = await withTimeout(
      execute(connection, "SELECT breed, caption FROM translations ORDER BY created_at DESC LIMIT 10"),
      "recent query"
    );
    connection.destroy(() => {});
    return rows.map((r) => ({ breed: String(r.BREED), caption: String(r.CAPTION) }));
  } catch (err) {
    console.error("[snowflake] recent query failed:", err);
    return [];
  }
}

// best-effort, same as logTranslation: a failed save shouldn't break anything for the user
export async function logSuggestion(text: string) {
  if (!isConfigured()) return;

  try {
    const connection = await withTimeout(connect(), "connect");
    await withTimeout(execute(connection, "INSERT INTO suggestions (text) VALUES (?)", [text]), "insert suggestion");
    connection.destroy(() => {});
  } catch (err) {
    console.error("[snowflake] suggestion log failed:", err);
  }
}
