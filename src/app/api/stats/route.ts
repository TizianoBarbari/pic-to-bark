import { NextResponse } from "next/server";
import { getStats, getRecentTranslations, getPunchlineStats, getHourlyTrend } from "@/lib/snowflake";

export async function GET() {
  const [stats, recent, punchlines, hourly] = await Promise.all([
    getStats(),
    getRecentTranslations(),
    getPunchlineStats(),
    getHourlyTrend(),
  ]);
  return NextResponse.json({ stats, recent, punchlines, hourly });
}
