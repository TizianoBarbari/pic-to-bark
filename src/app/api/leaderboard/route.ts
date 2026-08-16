import { NextResponse } from "next/server";
import { getBreedLeaderboard } from "@/lib/snowflake";

export async function GET() {
  const leaderboard = await getBreedLeaderboard();
  return NextResponse.json({ leaderboard });
}
